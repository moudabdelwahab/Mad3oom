/**
 * mock-supabase-port.js — test-only helper.
 * ------------------------------------------------------------
 * In-memory fake implementing the exact SupabasePort contract
 * (../../supabase-port.js). This is the ONLY port implementation any
 * test in this project actually calls — supabase-port.supabase.js
 * (real) is never exercised, per the explicit "no live database writes
 * in any test" instruction.
 *
 * Records every call it received (for assertions on what would have
 * been written) and supports injecting a failure for a specific method,
 * so tests can prove the Decision Engine / any future orchestrator
 * never assumes success (see action-layer.test.mjs's simulated-write-
 * failure test).
 *
 * Extended during Module 9 with the 8 Observability write methods
 * (trace events, conversation reviews, Scenario/Knowledge drafts,
 * validation runs, publishing) — same in-memory-fake, failure-injection
 * posture as the original two.
 */
import { createSupabasePort } from '../../supabase-port.js';

let nextTicketNumber = 1000;
let nextReviewId = 1;
let nextDraftVersion = {}; // key -> next version number, per key
let nextRunId = 1;

/**
 * @param {Object} [options]
 * @param {string} [options.failMethod] - if set, that method always returns { success: false }
 * @param {string} [options.failError] - the error message to report when failing
 * @returns {{ port: import('../../supabase-port.js').SupabasePort, calls: Array<{method: string, params: *}>, state: * }}
 */
export function createMockSupabasePort({ failMethod = null, failError = 'simulated write failure' } = {}) {
    const calls = [];
    const state = {
        chatMessages: [],
        chatSessions: {},
        tickets: [],
        traceEvents: [],
        conversationReviews: {},
        scenarioDrafts: {},
        knowledgeDrafts: {},
        validationRuns: [],
        published: {} // `${type}:${key}` -> version
    };

    function fails(method) {
        return failMethod === method;
    }

    async function persistBotTurn(params) {
        calls.push({ method: 'persistBotTurn', params });
        if (fails('persistBotTurn')) return { success: false, error: failError };

        state.chatMessages.push({ sessionId: params.sessionId, turn: params.turn, text: params.messageText, sender: 'bot' });
        state.chatSessions[params.sessionId] = { botState: params.botState };
        return { success: true, error: null };
    }

    async function createTicketWithMessageAndSessionUpdate(params) {
        calls.push({ method: 'createTicketWithMessageAndSessionUpdate', params });
        if (fails('createTicketWithMessageAndSessionUpdate')) return { success: false, error: failError };

        const ticketNumber = nextTicketNumber++;
        state.tickets.push({ ticketNumber, sessionId: params.sessionId, ...params.ticket });
        state.chatMessages.push({ sessionId: params.sessionId, turn: params.turn, text: params.messageText, sender: 'bot' });
        state.chatSessions[params.sessionId] = { botState: params.botState };
        return { success: true, error: null, ticketNumber };
    }

    async function insertTraceEvent(params) {
        calls.push({ method: 'insertTraceEvent', params });
        if (fails('insertTraceEvent')) return { success: false, error: failError };
        state.traceEvents.push(params);
        return { success: true, error: null };
    }

    async function createConversationReview(params) {
        calls.push({ method: 'createConversationReview', params });
        if (fails('createConversationReview')) return { success: false, error: failError };
        const reviewId = String(nextReviewId++);
        state.conversationReviews[reviewId] = { id: reviewId, status: 'open', correction: null, ...params };
        return { success: true, error: null, reviewId };
    }

    async function updateConversationReview(params) {
        calls.push({ method: 'updateConversationReview', params });
        if (fails('updateConversationReview')) return { success: false, error: failError };
        const existing = state.conversationReviews[params.reviewId];
        if (!existing) return { success: false, error: `no such review: ${params.reviewId}` };
        state.conversationReviews[params.reviewId] = { ...existing, status: params.status, correction: params.correction ?? existing.correction };
        return { success: true, error: null };
    }

    async function createScenarioDraft(params) {
        calls.push({ method: 'createScenarioDraft', params });
        if (fails('createScenarioDraft')) return { success: false, error: failError };
        const version = (nextDraftVersion[`scenario:${params.key}`] || 0) + 1;
        nextDraftVersion[`scenario:${params.key}`] = version;
        state.scenarioDrafts[`${params.key}:${version}`] = { ...params, version, status: 'draft' };
        return { success: true, error: null, draftVersion: version };
    }

    async function createKnowledgeDraft(params) {
        calls.push({ method: 'createKnowledgeDraft', params });
        if (fails('createKnowledgeDraft')) return { success: false, error: failError };
        const version = (nextDraftVersion[`knowledge:${params.key}`] || 0) + 1;
        nextDraftVersion[`knowledge:${params.key}`] = version;
        state.knowledgeDrafts[`${params.key}:${version}`] = { ...params, version, status: 'draft' };
        return { success: true, error: null, draftVersion: version };
    }

    async function insertValidationRun(params) {
        calls.push({ method: 'insertValidationRun', params });
        if (fails('insertValidationRun')) return { success: false, error: failError };
        const runId = String(nextRunId++);
        state.validationRuns.push({ id: runId, ...params });
        return { success: true, error: null, runId };
    }

    async function publishScenario(params) {
        calls.push({ method: 'publishScenario', params });
        if (fails('publishScenario')) return { success: false, error: failError };
        const draft = state.scenarioDrafts[`${params.key}:${params.version}`];
        if (draft) draft.status = 'published';
        state.published[`scenario:${params.key}`] = params.version;
        return { success: true, error: null };
    }

    async function publishKnowledge(params) {
        calls.push({ method: 'publishKnowledge', params });
        if (fails('publishKnowledge')) return { success: false, error: failError };
        const draft = state.knowledgeDrafts[`${params.key}:${params.version}`];
        if (draft) draft.status = 'published';
        state.published[`knowledge:${params.key}`] = params.version;
        return { success: true, error: null };
    }

    const port = createSupabasePort({
        persistBotTurn,
        createTicketWithMessageAndSessionUpdate,
        insertTraceEvent,
        createConversationReview,
        updateConversationReview,
        createScenarioDraft,
        createKnowledgeDraft,
        insertValidationRun,
        publishScenario,
        publishKnowledge
    });
    return { port, calls, state };
}

/**
 * A port whose every method throws, for testing action-layer.js's
 * catch-and-report-as-data resilience path (a raw network exception,
 * not a structured {success:false} response).
 * @returns {import('../../supabase-port.js').SupabasePort}
 */
export function createThrowingSupabasePort(message = 'network error') {
    const throwingFn = async () => {
        throw new Error(message);
    };
    return createSupabasePort({
        persistBotTurn: throwingFn,
        createTicketWithMessageAndSessionUpdate: throwingFn,
        insertTraceEvent: throwingFn,
        createConversationReview: throwingFn,
        updateConversationReview: throwingFn,
        createScenarioDraft: throwingFn,
        createKnowledgeDraft: throwingFn,
        insertValidationRun: throwingFn,
        publishScenario: throwingFn,
        publishKnowledge: throwingFn
    });
}
