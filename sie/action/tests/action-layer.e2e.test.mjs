import test from 'node:test';
import assert from 'node:assert/strict';
import { executeDecision } from '../action-layer.js';
import { ACTIONS } from '../../decision/decision-types.js';
import { runPipelineTurn } from './helpers/node-providers.js';
import { createMockSupabasePort } from './helpers/mock-supabase-port.js';

const fixedClock = () => '2026-01-01T00:00:00.000Z';

// Same two-turn journey as Journey C in Module 5's decision-engine.e2e.test.mjs
// ("الـ API مش شغال" -> ASK_FOR_LOGS -> silence -> CREATE_TICKET), carried one
// step further here into the Action Layer, to prove persistence is a genuinely
// separate concern from diagnosis/decision.

test('e2e: an ANSWER decision from the real pipeline is persisted via persistBotTurn', async () => {
    const turn1 = await runPipelineTurn('Token expired, Error 401', 1, { clock: fixedClock });
    assert.equal(turn1.decision.action, ACTIONS.ANSWER);

    const { port, calls } = createMockSupabasePort();
    const result = await executeDecision({
        decision: turn1.decision,
        rendered: turn1.rendered,
        sessionId: 'session-abc',
        nextBotState: { diagnosticState: turn1.diagnosticState, decisionState: turn1.decisionState },
        port
    });

    assert.equal(result.success, true);
    assert.equal(calls[0].method, 'persistBotTurn');
    assert.equal(calls[0].params.messageText, turn1.rendered.text);
});

test('e2e: a full CREATE_TICKET journey persists a ticket whose description carries the real diagnostic trail', async () => {
    const turn1 = await runPipelineTurn('الـ API مش شغال', 1, { clock: fixedClock });
    assert.equal(turn1.decision.action, ACTIONS.ASK_FOR_LOGS);

    const turn2 = await runPipelineTurn('', 2, {
        previousState: turn1.diagnosticState,
        previousDecisionState: turn1.decisionState,
        clock: fixedClock
    });
    assert.equal(turn2.decision.action, ACTIONS.CREATE_TICKET);
    assert.equal(turn2.decision.ticketDraft.scenarioId, 'api_integration_issue');

    const { port, calls, state } = createMockSupabasePort();
    const result = await executeDecision({
        decision: turn2.decision,
        rendered: turn2.rendered,
        sessionId: 'session-xyz',
        nextBotState: { diagnosticState: turn2.diagnosticState, decisionState: turn2.decisionState },
        port
    });

    assert.equal(result.success, true);
    assert.equal(calls[0].method, 'createTicketWithMessageAndSessionUpdate');
    assert.ok(typeof result.ticketNumber === 'number');
    assert.equal(state.tickets[0].scenarioId, 'api_integration_issue');
    assert.ok(state.tickets[0].description.includes('api_integration_issue'));
});

test('e2e: the Decision Engine\'s decision is completely unaffected by a downstream write failure — it never assumes success', async () => {
    const turn1 = await runPipelineTurn('Token expired, Error 401', 1, { clock: fixedClock });
    assert.equal(turn1.decision.action, ACTIONS.ANSWER);
    const decisionSnapshotBefore = JSON.stringify(turn1.decision);

    const { port } = createMockSupabasePort({ failMethod: 'persistBotTurn', failError: 'simulated outage' });
    const result = await executeDecision({
        decision: turn1.decision,
        rendered: turn1.rendered,
        sessionId: 'session-abc',
        nextBotState: {},
        port
    });

    // The write failed...
    assert.equal(result.success, false);
    assert.equal(result.steps[0].error, 'simulated outage');
    // ...but Module 5's decision object itself was never touched or
    // invalidated — it has zero knowledge this module exists.
    assert.equal(JSON.stringify(turn1.decision), decisionSnapshotBefore);
    assert.equal(turn1.decision.action, ACTIONS.ANSWER);
});

test('e2e: the full decision -> render -> action chain is JSON-safe end to end', async () => {
    const turn1 = await runPipelineTurn('Token expired, Error 401', 1, { clock: fixedClock });
    const { port } = createMockSupabasePort();
    const result = await executeDecision({
        decision: turn1.decision,
        rendered: turn1.rendered,
        sessionId: 'session-abc',
        nextBotState: { diagnosticState: turn1.diagnosticState },
        port
    });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});
