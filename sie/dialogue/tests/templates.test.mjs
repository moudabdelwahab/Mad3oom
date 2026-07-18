import test from 'node:test';
import assert from 'node:assert/strict';
import { ar } from '../templates/ar.js';
import { en } from '../templates/en.js';
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

test('every ACTION has a corresponding template function in both languages', () => {
    for (const action of Object.values(ACTIONS)) {
        assert.equal(typeof ar[action], 'function', `ar template missing for ${action}`);
        assert.equal(typeof en[action], 'function', `en template missing for ${action}`);
    }
});

test('every template in both languages returns { text, options } for a minimal decision, where applicable', () => {
    const needsResolution = new Set([ACTIONS.ANSWER]);
    for (const action of Object.values(ACTIONS)) {
        if (needsResolution.has(action)) continue; // covered by dedicated ANSWER tests below
        const decision = baseDecision(action);
        for (const templates of [ar, en]) {
            const rendered = templates[action](decision);
            assert.equal(typeof rendered.text, 'string');
            assert.ok(rendered.text.length > 0);
            assert.ok(Array.isArray(rendered.options));
        }
    }
});

test('ANSWER: renders the resolution text for the given language', () => {
    const decision = baseDecision(ACTIONS.ANSWER, {
        resolution: { hasAutoResolution: true, text: { ar: 'نص الحل بالعربي', en: 'resolution text in english' } }
    });
    assert.ok(ar.ANSWER(decision).text.includes('نص الحل بالعربي'));
    assert.ok(en.ANSWER(decision).text.includes('resolution text in english'));
});

test('ASK_CLARIFYING_QUESTION: renders the targeted question prompt and maps its options when a targetQuestion is present', () => {
    const decision = baseDecision(ACTIONS.ASK_CLARIFYING_QUESTION, {
        targetQuestion: {
            id: 'q1',
            prompt: { ar: 'سؤال بالعربي؟', en: 'Question in English?' },
            resolvesEvidence: ['x'],
            options: [{ label: { ar: 'اختيار أ', en: 'Option A' }, value: 'a' }]
        }
    });
    const renderedAr = ar.ASK_CLARIFYING_QUESTION(decision);
    assert.equal(renderedAr.text, 'سؤال بالعربي؟');
    assert.deepEqual(renderedAr.options, [{ label: 'اختيار أ', value: 'a' }]);

    const renderedEn = en.ASK_CLARIFYING_QUESTION(decision);
    assert.equal(renderedEn.text, 'Question in English?');
    assert.deepEqual(renderedEn.options, [{ label: 'Option A', value: 'a' }]);
});

test('ASK_CLARIFYING_QUESTION: falls back to a generic prompt with no options when targetQuestion is null', () => {
    const decision = baseDecision(ACTIONS.ASK_CLARIFYING_QUESTION, { targetQuestion: null });
    assert.deepEqual(ar.ASK_CLARIFYING_QUESTION(decision).options, []);
    assert.deepEqual(en.ASK_CLARIFYING_QUESTION(decision).options, []);
});

test('VERIFY_INFORMATION: references the scenarioLabel when present', () => {
    const decision = baseDecision(ACTIONS.VERIFY_INFORMATION, {
        scenarioLabel: { ar: 'مشكلة تسجيل الدخول', en: 'Login issue' }
    });
    assert.ok(ar.VERIFY_INFORMATION(decision).text.includes('مشكلة تسجيل الدخول'));
    assert.ok(en.VERIFY_INFORMATION(decision).text.includes('Login issue'));
});

test('VERIFY_INFORMATION: degrades to a generic reference when scenarioLabel is null', () => {
    const decision = baseDecision(ACTIONS.VERIFY_INFORMATION, { scenarioLabel: null });
    assert.doesNotThrow(() => ar.VERIFY_INFORMATION(decision));
    assert.doesNotThrow(() => en.VERIFY_INFORMATION(decision));
});

test('ASK_FOR_SCREENSHOT / ASK_FOR_ATTACHMENT / ASK_FOR_LOGS produce distinct text (not the same template reused)', () => {
    const texts = [ACTIONS.ASK_FOR_SCREENSHOT, ACTIONS.ASK_FOR_ATTACHMENT, ACTIONS.ASK_FOR_LOGS].map(
        (action) => ar[action](baseDecision(action)).text
    );
    assert.equal(new Set(texts).size, 3);
});

test('all option values across every template are non-empty strings (valid chat-logic.js option shape)', () => {
    for (const templates of [ar, en]) {
        for (const action of Object.values(ACTIONS)) {
            const decision = baseDecision(action, {
                resolution: { hasAutoResolution: true, text: { ar: 'x', en: 'x' } },
                targetQuestion: {
                    id: 'q1',
                    prompt: { ar: 'x', en: 'x' },
                    resolvesEvidence: [],
                    options: [{ label: { ar: 'x', en: 'x' }, value: 'v' }]
                }
            });
            const rendered = templates[action](decision);
            for (const opt of rendered.options) {
                assert.equal(typeof opt.label, 'string');
                assert.ok(opt.label.length > 0);
                assert.equal(typeof opt.value, 'string');
                assert.ok(opt.value.length > 0);
            }
        }
    }
});
