/**
 * sie-chat-bridge.js
 * ------------------------------------------------------------
 * The "future orchestrator" that action-layer.js's own comments say
 * doesn't exist yet: wires Language -> Diagnostics -> Ranking -> Decision
 * -> Knowledge -> Dialogue -> Action, in the exact order and with the
 * exact call contracts documented in each /sie module's README. Nothing
 * in /sie is imported for its internals — only its public exports.
 *
 * Exposes getSieReply(), deliberately shaped like chatbot-engine.js's
 * getBotReply({ text, supabase, sessionId, userId, botState, botSettings,
 * imageUrl }) => { reply, options }, so chat-logic.js needs only one
 * small branch (see sie-integration/README.md) instead of a rewrite.
 *
 * SIE's own turn-by-turn memory is namespaced under botState.sie so it
 * never collides with chatbot-engine.js's own use of the same
 * chat_sessions.bot_state column when a customer's traffic moves between
 * engines (e.g. SIE access expires mid-conversation).
 *
 * Any failure anywhere in this pipeline returns null rather than
 * throwing, so the caller's existing fallback to the traditional engine
 * (and its own error handling) is exactly what applies. This module
 * itself never writes an error message to chat_messages.
 */
import { normalize } from '/sie/language/normalizer.js';
import { processTurn } from '/sie/diagnostics/diagnostic-engine.js';
import { rankDiagnosticState } from '/sie/ranking/ranking-engine.js';
import { decide } from '/sie/decision/decision-engine.js';
import { composeAnswerDecision } from '/sie/knowledge/answer-composer.js';
import { renderDecision } from '/sie/dialogue/dialogue-renderer.js';
import { executeDecision, logTraceEvent } from '/sie/action/action-layer.js';
import { createRealSupabasePort } from '/sie/action/supabase-port.supabase.js';
import { buildTraceEvent } from '/sie/observability/trace-logger.js';
import { tryConsumeSieMessage } from './sie-entitlement.js';

/**
 * @param {Object} params
 * @param {string} params.text
 * @param {import('@supabase/supabase-js').SupabaseClient} params.supabase
 * @param {string} params.sessionId
 * @param {string} params.userId
 * @param {Object} params.botState - the session's full bot_state blob (may contain
 *   the traditional engine's own keys too — this function only reads/writes botState.sie)
 * @returns {Promise<{reply: string, options: Array, alreadyPersisted: true, ticketNumber: string|null} | null>}
 *   null means "not handled by SIE" — caller should fall back to getBotReply().
 */
export async function getSieReply({ text, supabase, sessionId, userId, botState }) {
    if (!text || !supabase || !sessionId || !userId) return null;

    // 1. Entitlement gate — the one place a SIE turn is authorized and metered.
    const entitlement = await tryConsumeSieMessage(supabase, userId);
    if (!entitlement.allowed) {
        console.info('SIE turn skipped:', entitlement.reason);
        return null;
    }

    try {
        const prevSie = botState?.sie || null;
        const turn = (prevSie?.turnCount || 0) + 1;

        // 2. Language (Module 1)
        const { normalizedTokens, responseLanguage } = await normalize(text, {
            previousLanguage: prevSie?.language || 'ar'
        });

        // 3. Diagnostics (Module 3)
        const diagnosticState = await processTurn({
            normalizedTokens,
            turn,
            previousState: prevSie?.diagnosticState,
            liveEvidenceContext: { userId }
        });

        // How much genuinely new evidence landed this turn, derived from the
        // accumulator's own append-only log rather than re-deriving extraction.
        const newEvidenceAddedThisTurn = (diagnosticState.accumulator?.entries || [])
            .filter((e) => e.turn === turn).length;

        // 4. Ranking (Module 4)
        const ranking = await rankDiagnosticState(diagnosticState);

        // 5. Decision (Module 5)
        const { decision, decisionState } = decide({
            ranking,
            turn,
            previousDecisionState: prevSie?.decisionState,
            newEvidenceAddedThisTurn
        });

        // 6. Knowledge (Module 7) — additive, passes through unchanged unless
        //    the decision is an ANSWER with a knowledgeSource.
        const decisionWithKnowledge = await composeAnswerDecision({
            decision,
            liveKnowledgeContext: { userId },
            turn
        });

        // 7. Dialogue (Module 6)
        const rendered = renderDecision(decisionWithKnowledge, responseLanguage);

        // 8. Action (Module 8) — the sole writer. Persists the bot's message +
        //    session state (+ ticket, if this turn created one) in one transaction.
        const nextBotState = {
            ...(botState || {}),
            sie: {
                diagnosticState,
                decisionState,
                language: responseLanguage,
                turnCount: turn
            }
        };
        const port = createRealSupabasePort(supabase);
        const actionResult = await executeDecision({
            decision: decisionWithKnowledge,
            rendered,
            sessionId,
            nextBotState,
            port
        });

        if (!actionResult?.success) {
            console.error('SIE action-layer write failed:', actionResult);
            return null; // caller falls back to the traditional engine
        }

        // 9. Observability (Module 9a) — best-effort, never blocks the reply.
        try {
            const traceEvent = buildTraceEvent({
                sessionId,
                turn,
                rawText: text,
                normalizedTokens,
                diagnosticState,
                ranking,
                decision: decisionWithKnowledge,
                responseText: rendered.text,
                timestamp: decisionWithKnowledge.timestamp
            });
            await logTraceEvent({ sessionId, turn, traceEvent, port });
        } catch (traceErr) {
            console.warn('SIE trace logging failed (non-fatal):', traceErr?.message || traceErr);
        }

        return {
            reply: rendered.text,
            options: rendered.options || [],
            alreadyPersisted: true,
            ticketNumber: actionResult.ticketNumber ?? null
        };
    } catch (err) {
        console.error('SIE pipeline error:', err?.message || err);
        return null; // caller falls back to the traditional engine
    }
}
