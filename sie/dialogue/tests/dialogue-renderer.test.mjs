import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDecision } from '../dialogue-renderer.js';
import { ACTIONS } from '../../decision/decision-types.js';

function baseDecision(action, overrides = {}) {
    return {
        action,
        scenarioId: null,
        scenarioLabel: null,
        confidence: null,
        explanation: 'x',
        evaluatedRules: [{ rule: 'R0', matched: true, detail: 'x' }],
        timestamp: 't',
        targetQuestion: null,
        resolution: null,
        ticketDraft: null,
        turn: 1,
        ...overrides
    };
}

test('renderDecision: dispatches to the correct action template', () => {
    const decision = baseDecision(ACTIONS.WAIT_FOR_USER);
    const rendered = renderDecision(decision, 'ar');
    assert.ok(rendered.text.length > 0);
    assert.deepEqual(rendered.options, []);
});

test('renderDecision: defaults to Arabic when no language is given', () => {
    const decision = baseDecision(ACTIONS.FALLBACK);
    const withDefault = renderDecision(decision);
    const withArExplicit = renderDecision(decision, 'ar');
    assert.equal(withDefault.text, withArExplicit.text);
});

test('renderDecision: falls back to Arabic for an unrecognized language value', () => {
    const decision = baseDecision(ACTIONS.FALLBACK);
    const rendered = renderDecision(decision, 'fr');
    const arRendered = renderDecision(decision, 'ar');
    assert.equal(rendered.text, arRendered.text);
});

test('renderDecision: renders in English when language is "en"', () => {
    const decision = baseDecision(ACTIONS.FALLBACK);
    const rendered = renderDecision(decision, 'en');
    const arRendered = renderDecision(decision, 'ar');
    assert.notEqual(rendered.text, arRendered.text);
});

test('renderDecision: degrades to a safe fallback for a null decision rather than throwing', () => {
    assert.doesNotThrow(() => renderDecision(null, 'ar'));
    const rendered = renderDecision(null, 'ar');
    assert.ok(rendered.text.length > 0);
    assert.deepEqual(rendered.options, []);
});

test('renderDecision: degrades to a safe fallback for an unrecognized action rather than throwing', () => {
    const decision = baseDecision('NOT_A_REAL_ACTION');
    assert.doesNotThrow(() => renderDecision(decision, 'ar'));
});

test('renderDecision: degrades gracefully if a template throws due to a malformed decision (e.g. ANSWER with no resolution)', () => {
    const decision = baseDecision(ACTIONS.ANSWER, { resolution: null });
    assert.doesNotThrow(() => renderDecision(decision, 'ar'));
    const rendered = renderDecision(decision, 'ar');
    assert.ok(rendered.text.length > 0);
});

test('renderDecision: every action renders without throwing in both languages, given a well-formed decision', () => {
    for (const action of Object.values(ACTIONS)) {
        const decision = baseDecision(action, {
            resolution: { hasAutoResolution: true, text: { ar: 'x', en: 'x' } },
            scenarioLabel: { ar: 'مشكلة', en: 'issue' },
            targetQuestion: {
                id: 'q1',
                prompt: { ar: 'x', en: 'x' },
                resolvesEvidence: [],
                options: [{ label: { ar: 'x', en: 'x' }, value: 'v' }]
            }
        });
        assert.doesNotThrow(() => renderDecision(decision, 'ar'));
        assert.doesNotThrow(() => renderDecision(decision, 'en'));
    }
});
