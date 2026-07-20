/**
 * action-layer.js
 * ------------------------------------------------------------
 * The sole writer. This is the only file in the whole engine that
 * calls a database port — every other module (1-7) remains exactly as
 * storage-agnostic as it already was; none of them import or reference
 * this module. A future orchestrator wires Decision -> Dialogue ->
 * Action itself; this module never reaches back into any of them.
 *
 * executeDecision() maps a Decision (Module 5) + its rendered reply
 * (Module 6) to exactly one port call -> one Postgres RPC -> one
 * transaction, and always returns a structured ActionResult (Module 8's
 * own action-types.js) — success is true only if that one step
 * succeeded. The Decision Engine never assumes success: it has zero
 * knowledge this module exists (it doesn't call it, import it, or
 * reference ActionResult), so this is satisfied structurally, not by
 * adding checks inside Module 5. Whatever future orchestrator wires
 * Decision -> Action must inspect ActionResult.success itself.
 */
import { ACTIONS } from '../decision/decision-types.js';
import { buildActionResult, formatTicketDescription } from './action-types.js';

const TICKET_ACTIONS = new Set([ACTIONS.CREATE_TICKET, ACTIONS.ESCALATE_TO_HUMAN]);

/**
 * Invokes one port method, catching anything it throws (network
 * failures, etc.) rather than letting it propagate — the whole point
 * of ActionResult is to report failure as data, not via exceptions.
 * @param {string} name
 * @param {() => Promise<import('./supabase-port.js').PortCallResult>} callFn
 * @returns {Promise<import('./action-types.js').ActionStep>}
 */
async function callStep(name, callFn) {
    try {
        const result = await callFn();
        if (!result || typeof result.success !== 'boolean') {
            return { name, success: false, error: 'port returned a malformed result' };
        }
        const { success, error, ...extra } = result;
        return { name, success, error: error ?? null, ...extra };
    } catch (err) {
        return { name, success: false, error: err?.message ?? String(err) };
    }
}

/**
 * @param {Object} params
 * @param {import('../decision/decision-types.js').Decision} params.decision
 * @param {{text: string, options: Array<{label: string, value: string}>}} params.rendered - Module 6's output
 * @param {string} params.sessionId
 * @param {*} params.nextBotState - the JSON blob to persist into chat_sessions.bot_state. Action
 *   Layer is agnostic about its internal shape — it persists whatever the caller supplies, the
 *   same way it doesn't interpret Decision/DiagnosticState internals either.
 * @param {import('./supabase-port.js').SupabasePort} params.port
 * @returns {Promise<import('./action-types.js').ActionResult>}
 */
export async function executeDecision({ decision, rendered, sessionId, nextBotState, port }) {
    if (!decision || !rendered || typeof sessionId !== 'string' || !port) {
        return buildActionResult({
            action: decision?.action ?? null,
            steps: [{ name: 'validate_input', success: false, error: 'missing decision, rendered, sessionId, or port' }]
        });
    }

    // ticketDraft is only null here when the Decision Engine deliberately
    // suppressed it (this session already has a ticket/escalation on file —
    // see decision-engine.js's ticketAlreadyCreated handling); in that case
    // just persist the reminder message like any other reply, instead of
    // opening a second duplicate ticket for the same conversation.
    if (TICKET_ACTIONS.has(decision.action) && decision.ticketDraft) {
        const step = await callStep('createTicketWithMessageAndSessionUpdate', () =>
            port.createTicketWithMessageAndSessionUpdate({
                sessionId,
                turn: decision.turn,
                messageText: rendered.text,
                botState: nextBotState,
                ticket: {
                    scenarioId: decision.ticketDraft?.scenarioId ?? null,
                    category: decision.ticketDraft?.category ?? null,
                    description: formatTicketDescription(decision)
                }
            })
        );
        return buildActionResult({ action: decision.action, steps: [step], ticketNumber: step.ticketNumber ?? null });
    }

    const step = await callStep('persistBotTurn', () =>
        port.persistBotTurn({
            sessionId,
            turn: decision.turn,
            messageText: rendered.text,
            botState: nextBotState
        })
    );
    return buildActionResult({ action: decision.action, steps: [step] });
}

// ------------------------------------------------------------------
// Added during Module 9 (Observability / Review Center / Validation
// Lab). Same posture as executeDecision() above: each function maps to
// exactly one port call -> one RPC/table write -> one ActionResult.
// observability/*.js never touches Supabase directly — it calls these
// functions, keeping Action Layer the sole writer end to end.
// ------------------------------------------------------------------

/**
 * Logs one turn's reasoning trace (Module 9a). Called once per turn by
 * whatever future orchestrator drives the pipeline, immediately after
 * a Decision is reached — independent of whether that decision's
 * action-layer write (executeDecision, above) succeeds or fails, so a
 * trace is available for debugging even a failed turn.
 * @param {Object} params
 * @param {string} params.sessionId
 * @param {number} params.turn
 * @param {import('../observability/trace-types.js').TraceEvent} params.traceEvent
 * @param {import('./supabase-port.js').SupabasePort} params.port
 * @param {string} [params.responseLanguage] - Module 1's detected response language for this turn
 * @param {number} [params.processingTimeMs] - wall-clock time the pipeline took this turn, for perf visibility in Review Center
 * @param {Object} [params.actionResult] - the ActionResult executeDecision() produced this turn (or null if it wasn't reached yet)
 * @param {Array} [params.renderedOptions] - Module 6's rendered quick-reply options, alongside traceEvent.responseText
 * @returns {Promise<import('./action-types.js').ActionResult>}
 */
export async function logTraceEvent({ sessionId, turn, traceEvent, port, responseLanguage = null, processingTimeMs = null, actionResult = null, renderedOptions = null }) {
    if (typeof sessionId !== 'string' || !traceEvent || !port) {
        return buildActionResult({ action: 'LOG_TRACE_EVENT', steps: [{ name: 'validate_input', success: false, error: 'missing sessionId, traceEvent, or port' }] });
    }
    const step = await callStep('insertTraceEvent', () => port.insertTraceEvent({ sessionId, turn, traceEvent, responseLanguage, processingTimeMs, actionResult, renderedOptions }));
    return buildActionResult({ action: 'LOG_TRACE_EVENT', steps: [step] });
}

/**
 * Flags a conversation for staff review (Module 9b, the Learning
 * Queue's write side — the queue itself is a read-side filter/view,
 * see observability/trace-logger.js).
 * @param {Object} params
 * @param {string} params.sessionId
 * @param {number} params.triggeredByTurn
 * @param {string} params.reason
 * @param {import('./supabase-port.js').SupabasePort} params.port
 * @returns {Promise<import('./action-types.js').ActionResult>}
 */
export async function flagConversationForReview({ sessionId, triggeredByTurn, reason, port }) {
    if (typeof sessionId !== 'string' || typeof reason !== 'string' || !port) {
        return buildActionResult({ action: 'FLAG_CONVERSATION_FOR_REVIEW', steps: [{ name: 'validate_input', success: false, error: 'missing sessionId, reason, or port' }] });
    }
    const step = await callStep('createConversationReview', () => port.createConversationReview({ sessionId, triggeredByTurn, reason }));
    return buildActionResult({ action: 'FLAG_CONVERSATION_FOR_REVIEW', steps: [step], reviewId: step.reviewId ?? null });
}

/**
 * Updates a review's status/correction as staff work through the
 * Learning Queue in the Review Center.
 * @param {Object} params
 * @param {string} params.reviewId
 * @param {'open'|'in_review'|'resolved'|'dismissed'} params.status
 * @param {string|null} [params.correction]
 * @param {import('./supabase-port.js').SupabasePort} params.port
 * @returns {Promise<import('./action-types.js').ActionResult>}
 */
export async function updateConversationReviewStatus({ reviewId, status, correction = null, port }) {
    if (typeof reviewId !== 'string' || typeof status !== 'string' || !port) {
        return buildActionResult({ action: 'UPDATE_CONVERSATION_REVIEW', steps: [{ name: 'validate_input', success: false, error: 'missing reviewId, status, or port' }] });
    }
    const step = await callStep('updateConversationReview', () => port.updateConversationReview({ reviewId, status, correction }));
    return buildActionResult({ action: 'UPDATE_CONVERSATION_REVIEW', steps: [step] });
}

/**
 * Saves a staff member's proposed Scenario edit as a new draft version
 * (Module 9c, Review Center editing). Never touches the published
 * catalog — see publishScenarioVersion() below for the gated publish
 * step.
 * @param {Object} params
 * @param {string} params.key - the scenarioKey
 * @param {*} params.definition - the full proposed Scenario object
 * @param {string|null} [params.authorNote]
 * @param {import('./supabase-port.js').SupabasePort} params.port
 * @returns {Promise<import('./action-types.js').ActionResult>}
 */
export async function saveScenarioDraft({ key, definition, authorNote = null, port }) {
    if (typeof key !== 'string' || !definition || !port) {
        return buildActionResult({ action: 'SAVE_SCENARIO_DRAFT', steps: [{ name: 'validate_input', success: false, error: 'missing key, definition, or port' }] });
    }
    const step = await callStep('createScenarioDraft', () => port.createScenarioDraft({ key, definition, authorNote }));
    return buildActionResult({ action: 'SAVE_SCENARIO_DRAFT', steps: [step], draftVersion: step.draftVersion ?? null });
}

/**
 * Saves a staff member's proposed Knowledge edit as a new draft
 * version. Mirrors saveScenarioDraft() exactly, for
 * chat_engine_knowledge_entries instead of chat_engine_scenarios.
 * @param {Object} params
 * @param {string} params.key - the knowledgeKey
 * @param {*} params.definition - the full proposed StaticKnowledgeEntry object
 * @param {string|null} [params.authorNote]
 * @param {import('./supabase-port.js').SupabasePort} params.port
 * @returns {Promise<import('./action-types.js').ActionResult>}
 */
export async function saveKnowledgeDraft({ key, definition, authorNote = null, port }) {
    if (typeof key !== 'string' || !definition || !port) {
        return buildActionResult({ action: 'SAVE_KNOWLEDGE_DRAFT', steps: [{ name: 'validate_input', success: false, error: 'missing key, definition, or port' }] });
    }
    const step = await callStep('createKnowledgeDraft', () => port.createKnowledgeDraft({ key, definition, authorNote }));
    return buildActionResult({ action: 'SAVE_KNOWLEDGE_DRAFT', steps: [step], draftVersion: step.draftVersion ?? null });
}

/**
 * Records a Simulation (single conversation) or Shadow Run (batch)
 * result from the Validation Lab (Module 9c), for later inspection and
 * as the evidence a Publish Gate decision (observability/publish-
 * gate.js) can point back to.
 * @param {Object} params
 * @param {'simulation'|'shadow_run'} params.kind
 * @param {'scenario'|'knowledge'} params.targetType
 * @param {string} params.targetKey
 * @param {number} params.targetVersion
 * @param {import('../observability/validation-policy.js').ValidationVerdict} params.verdict
 * @param {*} params.details
 * @param {import('./supabase-port.js').SupabasePort} params.port
 * @returns {Promise<import('./action-types.js').ActionResult>}
 */
export async function recordValidationRun({ kind, targetType, targetKey, targetVersion, verdict, details, port }) {
    if (typeof targetKey !== 'string' || !verdict || !port) {
        return buildActionResult({ action: 'RECORD_VALIDATION_RUN', steps: [{ name: 'validate_input', success: false, error: 'missing targetKey, verdict, or port' }] });
    }
    const step = await callStep('insertValidationRun', () => port.insertValidationRun({ kind, targetType, targetKey, targetVersion, verdict, details }));
    return buildActionResult({ action: 'RECORD_VALIDATION_RUN', steps: [step], runId: step.runId ?? null });
}

/**
 * Publishes a draft Scenario version — the write side of the Publish
 * Gate (observability/publish-gate.js decides WHETHER this call should
 * happen; this function is what actually performs it once allowed).
 * `overrideReason` is required by the RPC whenever publishing despite a
 * failed regression verdict, and gets logged to
 * chat_engine_publish_overrides for audit.
 * @param {Object} params
 * @param {string} params.key
 * @param {number} params.version
 * @param {string|null} [params.overrideReason]
 * @param {import('./supabase-port.js').SupabasePort} params.port
 * @returns {Promise<import('./action-types.js').ActionResult>}
 */
export async function publishScenarioVersion({ key, version, overrideReason = null, port }) {
    if (typeof key !== 'string' || typeof version !== 'number' || !port) {
        return buildActionResult({ action: 'PUBLISH_SCENARIO', steps: [{ name: 'validate_input', success: false, error: 'missing key, version, or port' }] });
    }
    const step = await callStep('publishScenario', () => port.publishScenario({ key, version, overrideReason }));
    return buildActionResult({ action: 'PUBLISH_SCENARIO', steps: [step] });
}

/**
 * Publishes a draft Knowledge version. Mirrors publishScenarioVersion()
 * exactly, for chat_engine_knowledge_entries instead of
 * chat_engine_scenarios.
 * @param {Object} params
 * @param {string} params.key
 * @param {number} params.version
 * @param {string|null} [params.overrideReason]
 * @param {import('./supabase-port.js').SupabasePort} params.port
 * @returns {Promise<import('./action-types.js').ActionResult>}
 */
export async function publishKnowledgeVersion({ key, version, overrideReason = null, port }) {
    if (typeof key !== 'string' || typeof version !== 'number' || !port) {
        return buildActionResult({ action: 'PUBLISH_KNOWLEDGE', steps: [{ name: 'validate_input', success: false, error: 'missing key, version, or port' }] });
    }
    const step = await callStep('publishKnowledge', () => port.publishKnowledge({ key, version, overrideReason }));
    return buildActionResult({ action: 'PUBLISH_KNOWLEDGE', steps: [step] });
}
