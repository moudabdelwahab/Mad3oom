/**
 * supabase-port.js
 * ------------------------------------------------------------
 * The narrow, application-specific port the Action Layer depends on —
 * NOT the raw chainable Supabase client (hard to mock faithfully and
 * far wider than this layer needs). Every method maps to exactly one
 * atomic Postgres RPC call (see migrations/ and
 * observability/migrations/), using the exact existing table/column
 * names already in use elsewhere, so wiring this up is backward-
 * compatible with zero schema changes beyond the RPC functions
 * themselves.
 *
 * Grew from 2 to 10 methods during Module 9 (Observability / Review
 * Center / Validation Lab): trace logging, conversation review,
 * Scenario/Knowledge draft editing, and gated publishing all need
 * writes, and Action Layer remains the sole writer — so those 8 new
 * write paths were added here rather than inside observability/ itself.
 * Modules 1-7 remain just as unaware of this file as before; only
 * observability/*.js now also depends on it, the same way action-
 * layer.js already did.
 *
 * This file is the CONTRACT only. Two implementations exist:
 *   - supabase-port.supabase.js — real, thin, calls .rpc(...); never
 *     invoked by any test, same "real implementation, mock is what's
 *     actually exercised" posture as Module 3's live-evidence provider
 *     and Module 7's live-knowledge provider.
 *   - tests/helpers/mock-supabase-port.js — an in-memory fake; the only
 *     implementation any test in this module actually calls.
 *
 * createSupabasePort() is a thin runtime contract check (every required
 * method must be present as a function) shared by both implementations,
 * so a typo/missing method fails loudly and immediately at wiring time
 * rather than as a confusing error deep inside action-layer.js.
 */

export const PORT_METHODS = Object.freeze([
    'persistBotTurn',
    'createTicketWithMessageAndSessionUpdate',
    // Added during Module 9 (Observability / Review Center / Validation
    // Lab): Action Layer remains the sole writer, so these eight new
    // write paths live here rather than inside observability/ itself.
    'insertTraceEvent',
    'createConversationReview',
    'updateConversationReview',
    'createScenarioDraft',
    'createKnowledgeDraft',
    'insertValidationRun',
    'publishScenario',
    'publishKnowledge'
]);

/**
 * @typedef {Object} PersistBotTurnParams
 * @property {string} sessionId
 * @property {number} turn
 * @property {string} messageText - the bot's rendered reply to persist into chat_messages
 * @property {*} botState - the JSON blob to persist into chat_sessions.bot_state
 *
 * @typedef {Object} CreateTicketParams
 * @property {string} sessionId
 * @property {number} turn
 * @property {string} messageText
 * @property {*} botState
 * @property {{scenarioId: string|null, category: string|null, description: string}} ticket
 *
 * @typedef {Object} TraceEventParams - see observability/trace-types.js for the full TraceEvent shape
 * @property {string} sessionId
 * @property {number} turn
 * @property {import('../observability/trace-types.js').TraceEvent} traceEvent
 *
 * @typedef {Object} CreateConversationReviewParams
 * @property {string} sessionId
 * @property {number} triggeredByTurn
 * @property {string} reason - why the Learning Queue flagged this conversation (e.g. "low_confidence", "fallback", "escalated_unknown")
 *
 * @typedef {Object} UpdateConversationReviewParams
 * @property {string} reviewId
 * @property {'open'|'in_review'|'resolved'|'dismissed'} status
 * @property {string|null} [correction] - a staff member's free-text correction/note
 *
 * @typedef {Object} CreateDraftParams
 * @property {string} key - scenarioKey or knowledgeKey
 * @property {*} definition - the full proposed Scenario or StaticKnowledgeEntry object
 * @property {string|null} [authorNote]
 *
 * @typedef {Object} InsertValidationRunParams
 * @property {'simulation'|'shadow_run'} kind
 * @property {'scenario'|'knowledge'} targetType
 * @property {string} targetKey
 * @property {number} targetVersion
 * @property {import('../observability/validation-policy.js').ValidationVerdict} verdict
 * @property {*} details - the full ComparisonResult / ShadowRunResult, stored for later inspection
 *
 * @typedef {Object} PublishParams
 * @property {string} key - scenarioKey or knowledgeKey
 * @property {number} version - the draft version being published
 * @property {string|null} [overrideReason] - required when publishing despite a failed regression
 *   verdict (see observability/publish-gate.js); logged to chat_engine_publish_overrides
 *
 * @typedef {Object} PortCallResult
 * @property {boolean} success
 * @property {string|null} error
 * @property {(number|string|null)} [ticketNumber]
 * @property {(string|null)} [reviewId]
 * @property {(number|null)} [draftVersion]
 * @property {(string|null)} [runId]
 *
 * @typedef {Object} SupabasePort
 * @property {(params: PersistBotTurnParams) => Promise<PortCallResult>} persistBotTurn -
 *   calls the persist_bot_turn RPC: inserts one row into chat_messages and updates
 *   chat_sessions.bot_state, atomically, in a single Postgres transaction
 * @property {(params: CreateTicketParams) => Promise<PortCallResult>} createTicketWithMessageAndSessionUpdate -
 *   calls the create_ticket_with_message_and_session_update RPC: inserts a ticket, inserts the
 *   bot's message, and updates chat_sessions.bot_state, atomically, in a single Postgres
 *   transaction. Returns the generated ticketNumber on success.
 * @property {(params: TraceEventParams) => Promise<PortCallResult>} insertTraceEvent -
 *   inserts one row into chat_engine_trace_events (Module 9's Reasoning Trace Log)
 * @property {(params: CreateConversationReviewParams) => Promise<PortCallResult>} createConversationReview -
 *   inserts one row into chat_engine_conversation_reviews (the Learning Queue is a VIEW over this
 *   table plus chat_engine_trace_events, not separate storage)
 * @property {(params: UpdateConversationReviewParams) => Promise<PortCallResult>} updateConversationReview -
 *   updates a review's status/correction as staff work through the Learning Queue
 * @property {(params: CreateDraftParams) => Promise<PortCallResult>} createScenarioDraft -
 *   inserts a new draft-status row into chat_engine_scenarios
 * @property {(params: CreateDraftParams) => Promise<PortCallResult>} createKnowledgeDraft -
 *   inserts a new draft-status row into chat_engine_knowledge_entries
 * @property {(params: InsertValidationRunParams) => Promise<PortCallResult>} insertValidationRun -
 *   inserts one row into chat_engine_validation_runs (a Simulation or Shadow Run result)
 * @property {(params: PublishParams) => Promise<PortCallResult>} publishScenario -
 *   calls the publish_chat_engine_scenario RPC: flips a draft scenario row to published (and the
 *   previously-published version, if any, to archived), atomically
 * @property {(params: PublishParams) => Promise<PortCallResult>} publishKnowledge -
 *   calls the publish_chat_engine_knowledge RPC: the same publish transition for knowledge entries
 */

/**
 * Validates that a given implementation exposes every required method
 * as a function, and returns it unchanged. Throws immediately (at
 * wiring time, not at call time) if anything is missing — this is
 * infrastructure wiring, not customer-facing data, so failing loudly
 * here is correct (unlike e.g. live-knowledge-provider.js, which
 * degrades gracefully because it sits directly in the customer path).
 *
 * @param {Object} implementation
 * @returns {SupabasePort}
 */
export function createSupabasePort(implementation) {
    const missing = PORT_METHODS.filter((name) => typeof implementation?.[name] !== 'function');
    if (missing.length > 0) {
        throw new Error(`createSupabasePort: implementation is missing required method(s): ${missing.join(', ')}`);
    }
    return implementation;
}
