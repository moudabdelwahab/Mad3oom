import test from 'node:test';
import assert from 'node:assert/strict';
import { executeDecision } from '../action-layer.js';
import { ACTIONS } from '../../decision/decision-types.js';
import { createMockSupabasePort, createThrowingSupabasePort } from './helpers/mock-supabase-port.js';

function fakeDecision(overrides = {}) {
    return {
        action: ACTIONS.ANSWER,
        scenarioId: 's1',
        scenarioLabel: { ar: 'x', en: 'x' },
        confidence: 0.9,
        explanation: 'test',
        evaluatedRules: [{ rule: 'R7', matched: true, detail: 'x' }],
        timestamp: '2026-01-01T00:00:00.000Z',
        targetQuestion: null,
        resolution: { hasAutoResolution: true, text: { ar: 'نص', en: 'text' } },
        ticketDraft: null,
        turn: 3,
        ...overrides
    };
}

function fakeRendered(overrides = {}) {
    return { text: 'رد تجريبي', options: [], ...overrides };
}

// ------------------------------------------------------------------
// Message-only actions -> persistBotTurn
// ------------------------------------------------------------------

test('executeDecision: an ANSWER routes to persistBotTurn exactly once', async () => {
    const { port, calls } = createMockSupabasePort();
    const result = await executeDecision({ decision: fakeDecision(), rendered: fakeRendered(), sessionId: 'sess-1', nextBotState: { x: 1 }, port });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'persistBotTurn');
    assert.equal(result.success, true);
    assert.equal(result.action, ACTIONS.ANSWER);
    assert.equal(result.atomicityGuaranteed, true);
    assert.equal(result.requiresFuturePostgresRPC, false);
    assert.equal(result.ticketNumber, null);
});

test('executeDecision: WAIT_FOR_USER and COMPLETE also route to persistBotTurn, not ticket creation', async () => {
    for (const action of [ACTIONS.WAIT_FOR_USER, ACTIONS.COMPLETE, ACTIONS.FALLBACK, ACTIONS.ASK_CLARIFYING_QUESTION]) {
        const { port, calls } = createMockSupabasePort();
        await executeDecision({ decision: fakeDecision({ action }), rendered: fakeRendered(), sessionId: 'sess-1', nextBotState: {}, port });
        assert.equal(calls[0].method, 'persistBotTurn', `expected ${action} to route to persistBotTurn`);
    }
});

test('executeDecision: persistBotTurn is called with the rendered text, turn, and supplied botState', async () => {
    const { port, calls } = createMockSupabasePort();
    await executeDecision({
        decision: fakeDecision({ turn: 7 }),
        rendered: fakeRendered({ text: 'النص النهائي' }),
        sessionId: 'sess-42',
        nextBotState: { some: 'state' },
        port
    });
    const { params } = calls[0];
    assert.equal(params.sessionId, 'sess-42');
    assert.equal(params.turn, 7);
    assert.equal(params.messageText, 'النص النهائي');
    assert.deepEqual(params.botState, { some: 'state' });
});

// ------------------------------------------------------------------
// Ticket actions -> createTicketWithMessageAndSessionUpdate
// ------------------------------------------------------------------

test('executeDecision: CREATE_TICKET routes to createTicketWithMessageAndSessionUpdate and returns the ticketNumber', async () => {
    const { port, calls } = createMockSupabasePort();
    const decision = fakeDecision({
        action: ACTIONS.CREATE_TICKET,
        resolution: null,
        ticketDraft: { scenarioId: 'api_integration_issue', category: 'api', diagnosticTrail: [{ scenarioId: 'api_integration_issue', confidence: 0.7, status: 'active' }] }
    });
    const result = await executeDecision({ decision, rendered: fakeRendered(), sessionId: 'sess-1', nextBotState: {}, port });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'createTicketWithMessageAndSessionUpdate');
    assert.equal(result.success, true);
    assert.ok(typeof result.ticketNumber === 'number');
});

test('executeDecision: ESCALATE_TO_HUMAN also routes to ticket creation', async () => {
    const { port, calls } = createMockSupabasePort();
    const decision = fakeDecision({ action: ACTIONS.ESCALATE_TO_HUMAN, resolution: null, ticketDraft: { scenarioId: 's1', category: 'c1', diagnosticTrail: [] } });
    await executeDecision({ decision, rendered: fakeRendered(), sessionId: 'sess-1', nextBotState: {}, port });
    assert.equal(calls[0].method, 'createTicketWithMessageAndSessionUpdate');
});

test('executeDecision: the ticket description passed to the port includes the formatted diagnostic trail', async () => {
    const { port, calls } = createMockSupabasePort();
    const decision = fakeDecision({
        action: ACTIONS.CREATE_TICKET,
        resolution: null,
        ticketDraft: { scenarioId: 'login_token_expired', category: 'login', diagnosticTrail: [{ scenarioId: 'login_token_expired', confidence: 0.65, status: 'active' }] }
    });
    await executeDecision({ decision, rendered: fakeRendered(), sessionId: 'sess-1', nextBotState: {}, port });
    assert.ok(calls[0].params.ticket.description.includes('login_token_expired'));
    assert.ok(calls[0].params.ticket.description.includes('confidence=0.65'));
});

// ------------------------------------------------------------------
// Failure paths — the Decision Engine never assumes success
// ------------------------------------------------------------------

test('executeDecision: a structured write failure ({success:false}) is reported, not thrown', async () => {
    const { port } = createMockSupabasePort({ failMethod: 'persistBotTurn', failError: 'db unavailable' });
    const result = await executeDecision({ decision: fakeDecision(), rendered: fakeRendered(), sessionId: 'sess-1', nextBotState: {}, port });
    assert.equal(result.success, false);
    assert.equal(result.steps[0].error, 'db unavailable');
});

test('executeDecision: a thrown exception (e.g. network error) is caught and reported as data, never propagates', async () => {
    const port = createThrowingSupabasePort('connection reset');
    const result = await executeDecision({ decision: fakeDecision(), rendered: fakeRendered(), sessionId: 'sess-1', nextBotState: {}, port });
    assert.equal(result.success, false);
    assert.equal(result.steps[0].error, 'connection reset');
});

test('executeDecision: a ticket-creation failure reports ticketNumber as null, not a partial/guessed number', async () => {
    const { port } = createMockSupabasePort({ failMethod: 'createTicketWithMessageAndSessionUpdate' });
    const decision = fakeDecision({ action: ACTIONS.CREATE_TICKET, resolution: null, ticketDraft: { scenarioId: 's1', category: 'c1', diagnosticTrail: [] } });
    const result = await executeDecision({ decision, rendered: fakeRendered(), sessionId: 'sess-1', nextBotState: {}, port });
    assert.equal(result.success, false);
    assert.equal(result.ticketNumber, null);
});

// ------------------------------------------------------------------
// Input validation
// ------------------------------------------------------------------

test('executeDecision: missing decision/rendered/sessionId/port is reported as a failed ActionResult, not thrown', async () => {
    const { port } = createMockSupabasePort();
    const result = await executeDecision({ decision: null, rendered: fakeRendered(), sessionId: 'sess-1', nextBotState: {}, port });
    assert.equal(result.success, false);
    assert.equal(result.steps[0].name, 'validate_input');
});

test('executeDecision: a missing port does not throw', async () => {
    const result = await executeDecision({ decision: fakeDecision(), rendered: fakeRendered(), sessionId: 'sess-1', nextBotState: {}, port: null });
    assert.equal(result.success, false);
});

// ------------------------------------------------------------------
// JSON safety
// ------------------------------------------------------------------

test('executeDecision: the returned ActionResult round-trips through JSON', async () => {
    const { port } = createMockSupabasePort();
    const result = await executeDecision({ decision: fakeDecision(), rendered: fakeRendered(), sessionId: 'sess-1', nextBotState: {}, port });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});
