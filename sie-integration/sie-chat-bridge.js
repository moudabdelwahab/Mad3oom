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
import { ACTIONS } from '/sie/decision/decision-types.js';
import { composeAnswerDecision } from '/sie/knowledge/answer-composer.js';
import { renderDecision } from '/sie/dialogue/dialogue-renderer.js';
import { executeDecision, logTraceEvent } from '/sie/action/action-layer.js';
import { createRealSupabasePort } from '/sie/action/supabase-port.supabase.js';
import { buildTraceEvent } from '/sie/observability/trace-logger.js';
import { tryConsumeSieMessage } from './sie-entitlement.js';

/**
 * قرار CREATE_TICKET كان بينفّذ فورًا جوه محرك القرار من غير ما يسأل
 * العميل. دلوقتي أي مرة الـ Decision Engine يوصل لـ CREATE_TICKET، بدل ما
 * نفتح التذكرة على طول، بنوقف ونسأل العميل الأول ("تحب أفتحلك تذكرة؟")
 * ولحد ما يوافق صراحة، التذكرة متتفتحش. الحالة المؤقتة دي (اللي بتفضل
 * لحد رد العميل) بتتخزن جوه botState.sie.pendingTicketConfirmation.
 *
 * بنعيد استخدام executeDecision() الموجود بدل ما نضيف مسار كتابة جديد:
 * أي Decision بـ action مش من TICKET_ACTIONS بيمر على persistBotTurn
 * العادي، فبنبعتله WAIT_FOR_USER (موجود أصلاً في ACTIONS) مع رسالة
 * السؤال، وده بيخزن الرسالة وحالة الجلسة بنفس الطريقة العادية من غير ما
 * يفتح تذكرة فعليًا.
 */
const TICKET_CONFIRM_TEXT = {
    ar: 'تحب أفتحلك تذكرة دعم عشان فريقنا يتابع معاك؟ [[icon:ticket]]',
    en: 'Would you like me to open a support ticket so our team can follow up with you? [[icon:ticket]]'
};

const TICKET_CONFIRM_OPTIONS = {
    ar: [
        { label: '[[icon:check]] أيوه، افتحلي تذكرة', value: 'أيوه افتحلي تذكرة' },
        { label: '[[icon:cancel]] لأ، مش دلوقتي', value: 'لأ مش دلوقتي' }
    ],
    en: [
        { label: '[[icon:check]] Yes, open a ticket', value: 'yes open a ticket' },
        { label: '[[icon:cancel]] No, not now', value: 'no not now' }
    ]
};

const TICKET_DECLINE_TEXT = {
    ar: 'تمام، معلش، مش هفتحلك تذكرة دلوقتي. لو احتجت أي حاجة تانية قولي [[icon:smile]]',
    en: "No problem, I won't open a ticket right now. Let me know if you need anything else [[icon:smile]]"
};

const NEGATIVE_REPLY_PATTERNS = [/مش/, /^لا\b/, /لأ/, /رفض/, /الغاء/, /إلغاء/, /كنسل/, /\bno\b/i, /^n$/i, /cancel/i];
const AFFIRMATIVE_REPLY_PATTERNS = [/أيوه/, /ايوه/, /أيوة/, /ايوة/, /نعم/, /تمام/, /^اه\b/, /آه/, /موافق/, /أوك/, /اوك/, /okay/i, /^ok$/i, /^y$/i, /\byes\b/i, /صح/];

/**
 * تصنيف بسيط (نعم/لا/مش واضح) لرد العميل على سؤال تأكيد فتح التذكرة.
 * بنتأكد من "لأ" الأول عشان عبارات زي "مش عايز تذكرة" ماتتحسبش بالغلط
 * "أيوه" لمجرد ما فيها كلمة تانية قريبة، ثم لو ولا حاجة اتطابقت نرجّع
 * "unclear" ونعيد نفس السؤال بدل ما نفترض حاجة غلط.
 */
function classifyTicketConfirmationReply(text) {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) return 'unclear';
    if (NEGATIVE_REPLY_PATTERNS.some((p) => p.test(normalized))) return 'no';
    if (AFFIRMATIVE_REPLY_PATTERNS.some((p) => p.test(normalized))) return 'yes';
    return 'unclear';
}

/**
 * أول مرة القرار يوصل CREATE_TICKET: بنخزن الـ Decision + الرسالة الأصلية
 * بتاعة التذكرة جوه botState.sie.pendingTicketConfirmation، ونعرض سؤال
 * التأكيد للعميل بدل ما نفتح التذكرة على طول.
 */
async function beginTicketConfirmation({ decisionWithKnowledge, rendered, sessionId, nextBotState, port, responseLanguage }) {
    const lang = responseLanguage === 'en' ? 'en' : 'ar';
    const confirmRendered = { text: TICKET_CONFIRM_TEXT[lang], options: TICKET_CONFIRM_OPTIONS[lang] };

    const stateWithPending = {
        ...nextBotState,
        sie: {
            ...nextBotState.sie,
            pendingTicketConfirmation: {
                decision: decisionWithKnowledge,
                rendered,
                language: lang
            }
        }
    };

    const actionResult = await executeDecision({
        decision: { action: ACTIONS.WAIT_FOR_USER, turn: decisionWithKnowledge.turn },
        rendered: confirmRendered,
        sessionId,
        nextBotState: stateWithPending,
        port
    });

    if (!actionResult?.success) {
        console.error('SIE action-layer write failed (ticket confirmation prompt):', actionResult);
        return null;
    }

    return { actionResult, reply: confirmRendered.text, options: confirmRendered.options };
}

/**
 * التعامل مع رد العميل لما يكون فيه سؤال تأكيد فتح تذكرة معلّق من دور
 * سابق. الرد ده بيجاوب على "تحب أفتحلك تذكرة؟" — مش دليل تشخيصي جديد —
 * فبنقصّر الطريق ومنعديش على باقي البايبلاين (Language/Diagnostics/
 * Ranking/Decision/Knowledge/Dialogue) خالص في الدور ده.
 */
async function resolvePendingTicketConfirmation({ text, sessionId, botState, prevSie, port }) {
    const pending = prevSie.pendingTicketConfirmation;
    const lang = pending.language === 'en' ? 'en' : 'ar';
    const intent = classifyTicketConfirmationReply(text);

    if (intent === 'unclear') {
        // نعيد نفس سؤال التأكيد من غير ما نغيّر أي حالة - لسه مستنيين رد واضح.
        const rendered = { text: TICKET_CONFIRM_TEXT[lang], options: TICKET_CONFIRM_OPTIONS[lang] };
        const nextBotState = { ...botState, sie: { ...prevSie } };
        const actionResult = await executeDecision({
            decision: { action: ACTIONS.WAIT_FOR_USER, turn: pending.decision.turn },
            rendered,
            sessionId,
            nextBotState,
            port
        });
        if (!actionResult?.success) {
            console.error('SIE action-layer write failed (ticket confirmation re-ask):', actionResult);
            return null;
        }
        return { reply: rendered.text, options: rendered.options, alreadyPersisted: true, ticketNumber: null };
    }

    const clearedSie = { ...prevSie };
    delete clearedSie.pendingTicketConfirmation;

    if (intent === 'no') {
        const rendered = { text: TICKET_DECLINE_TEXT[lang], options: [] };
        const nextBotState = { ...botState, sie: clearedSie };
        const actionResult = await executeDecision({
            decision: { action: ACTIONS.WAIT_FOR_USER, turn: pending.decision.turn },
            rendered,
            sessionId,
            nextBotState,
            port
        });
        if (!actionResult?.success) {
            console.error('SIE action-layer write failed (ticket confirmation decline):', actionResult);
            return null;
        }
        return { reply: rendered.text, options: rendered.options, alreadyPersisted: true, ticketNumber: null };
    }

    // intent === 'yes' -> ننفذ القرار الأصلي اللي كان معلّق (بتاع فتح التذكرة فعليًا).
    const nextBotState = { ...botState, sie: clearedSie };
    const actionResult = await executeDecision({
        decision: pending.decision,
        rendered: pending.rendered,
        sessionId,
        nextBotState,
        port
    });
    if (!actionResult?.success) {
        console.error('SIE action-layer write failed (ticket confirmation accept):', actionResult);
        return null;
    }
    return {
        reply: pending.rendered.text,
        options: pending.rendered.options || [],
        alreadyPersisted: true,
        ticketNumber: actionResult.ticketNumber ?? null
    };
}

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

    const port = createRealSupabasePort(supabase);
    const turnStartedAt = Date.now();

    try {
        const prevSie = botState?.sie || null;

        // 0. رد على سؤال تأكيد فتح تذكرة معلّق من دور سابق؟ ده مش دليل تشخيصي
        // جديد، فبنتعامل معاه لوحده من غير ما نعدّي على باقي البايبلاين.
        if (prevSie?.pendingTicketConfirmation) {
            return await resolvePendingTicketConfirmation({ text, sessionId, botState, prevSie, port });
        }

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

        // CREATE_TICKET يتوقف هنا وينتظر تأكيد صريح من العميل بدل ما يفتح
        // التذكرة على طول - شايف beginTicketConfirmation() فوق.
        let actionResult;
        let replyText = rendered.text;
        let replyOptions = rendered.options || [];
        if (decisionWithKnowledge.action === ACTIONS.CREATE_TICKET) {
            const confirmOutcome = await beginTicketConfirmation({
                decisionWithKnowledge,
                rendered,
                sessionId,
                nextBotState,
                port,
                responseLanguage
            });
            if (!confirmOutcome) return null; // caller falls back to the traditional engine
            actionResult = confirmOutcome.actionResult;
            replyText = confirmOutcome.reply;
            replyOptions = confirmOutcome.options;
        } else {
            actionResult = await executeDecision({
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
        }

        // 9. Observability (Module 9a) — best-effort, never blocks the reply.
        // بتسجّل القرار الحقيقي اللي اتاخد (حتى لو CREATE_TICKET لسه مستني
        // تأكيد العميل)، عشان الـ trace يفضل يعكس تشخيص المحرك الفعلي.
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
            await logTraceEvent({
                sessionId, turn, traceEvent, port,
                responseLanguage,
                processingTimeMs: Date.now() - turnStartedAt,
                actionResult,
                renderedOptions: replyOptions
            });
        } catch (traceErr) {
            console.warn('SIE trace logging failed (non-fatal):', traceErr?.message || traceErr);
        }

        return {
            reply: replyText,
            options: replyOptions,
            alreadyPersisted: true,
            ticketNumber: actionResult.ticketNumber ?? null
        };
    } catch (err) {
        console.error('SIE pipeline error:', err?.message || err);
        return null; // caller falls back to the traditional engine
    }
}
