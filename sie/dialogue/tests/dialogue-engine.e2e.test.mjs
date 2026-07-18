import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../../decision/decision-engine.js';
import { ACTIONS, createEmptyDecisionState } from '../../decision/decision-types.js';
import { renderDecision } from '../dialogue-renderer.js';
import { runPipelineTurn } from './helpers/node-providers.js';

const fixedClock = () => '2026-01-01T00:00:00.000Z';

test('full pipeline: "Token expired, Error 401" produces a rendered Arabic ANSWER referencing the resolution', async () => {
    const turn1 = await runPipelineTurn('Token expired, Error 401', 1);
    const { decision } = decide({
        ranking: turn1.rankingResult,
        turn: 1,
        previousDecisionState: createEmptyDecisionState(),
        newEvidenceAddedThisTurn: turn1.newEvidenceAddedThisTurn,
        clock: fixedClock
    });
    assert.equal(decision.action, ACTIONS.ANSWER);

    const rendered = renderDecision(decision, turn1.responseLanguage);
    assert.equal(turn1.responseLanguage, 'ar'); // mixed message with Arabic-default policy, no genuine English prose
    assert.ok(rendered.text.includes(decision.resolution.text.ar));
    assert.equal(rendered.options.length, 2);
});

test('full pipeline: a fully English message renders the English template set', async () => {
    const turn1 = await runPipelineTurn('I cannot log into my account, it keeps failing', 1);
    const { decision } = decide({
        ranking: turn1.rankingResult,
        turn: 1,
        previousDecisionState: createEmptyDecisionState(),
        newEvidenceAddedThisTurn: turn1.newEvidenceAddedThisTurn,
        clock: fixedClock
    });
    assert.equal(turn1.responseLanguage, 'en');

    const rendered = renderDecision(decision, turn1.responseLanguage);
    // Whatever action was decided, the rendered text must be the English
    // template, not Arabic — spot-checked via script direction is hard to
    // assert generically, so instead confirm it does NOT equal the Arabic
    // rendering of the same decision (they should differ for any action
    // with real content).
    const arRendered = renderDecision(decision, 'ar');
    assert.notEqual(rendered.text, arRendered.text);
});

test('full pipeline: ambiguous subscription scenario renders the targeted discriminating question with mapped options', async () => {
    const turn1 = await runPipelineTurn('عندي مشكلة اشتراك', 1);
    const { decision } = decide({
        ranking: turn1.rankingResult,
        turn: 1,
        previousDecisionState: createEmptyDecisionState(),
        newEvidenceAddedThisTurn: turn1.newEvidenceAddedThisTurn,
        clock: fixedClock
    });
    assert.equal(decision.action, ACTIONS.ASK_CLARIFYING_QUESTION);
    assert.ok(decision.targetQuestion);

    const rendered = renderDecision(decision, turn1.responseLanguage);
    assert.equal(rendered.text, decision.targetQuestion.prompt.ar);
    assert.equal(rendered.options.length, decision.targetQuestion.options.length);
    assert.ok(rendered.options.every((o) => typeof o.label === 'string' && typeof o.value === 'string'));
});

test('full pipeline: confident technical diagnosis renders the ASK_FOR_LOGS template with attach/skip options', async () => {
    const turn1 = await runPipelineTurn('الـ API مش شغال', 1);
    const { decision } = decide({
        ranking: turn1.rankingResult,
        turn: 1,
        previousDecisionState: createEmptyDecisionState(),
        newEvidenceAddedThisTurn: turn1.newEvidenceAddedThisTurn,
        clock: fixedClock
    });
    assert.equal(decision.action, ACTIONS.ASK_FOR_LOGS);

    const rendered = renderDecision(decision, turn1.responseLanguage);
    assert.ok(rendered.text.length > 0);
    assert.equal(rendered.options.length, 2);
    assert.ok(rendered.options.some((o) => o.value === '__attach_image__'));
});

test('full pipeline: every rendered turn produces a JSON-safe, chat-logic.js-compatible { text, options } shape', async () => {
    const turn1 = await runPipelineTurn('الموقع بيرجع 500 Internal Server Error', 1);
    const { decision } = decide({
        ranking: turn1.rankingResult,
        turn: 1,
        previousDecisionState: createEmptyDecisionState(),
        newEvidenceAddedThisTurn: turn1.newEvidenceAddedThisTurn,
        clock: fixedClock
    });
    const rendered = renderDecision(decision, turn1.responseLanguage);
    assert.deepEqual(JSON.parse(JSON.stringify(rendered)), rendered);
    assert.equal(typeof rendered.text, 'string');
    assert.ok(Array.isArray(rendered.options));
    for (const opt of rendered.options) {
        assert.equal(typeof opt.label, 'string');
        assert.equal(typeof opt.value, 'string');
    }
});
