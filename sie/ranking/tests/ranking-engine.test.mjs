import test from 'node:test';
import assert from 'node:assert/strict';
import { rankHypotheses, AMBIGUITY_MARGIN, MAX_CANDIDATE_QUESTIONS_SCENARIOS } from '../ranking-engine.js';

function hypothesis(scenarioId, confidence, overrides = {}) {
    return {
        scenarioId,
        status: confidence >= 0.15 ? 'active' : 'unconsidered',
        confidence,
        supportingEvidenceTokens: [],
        missingEvidenceTokens: [],
        hasEverBeenActive: confidence >= 0.15,
        firstSeenTurn: 1,
        lastUpdatedTurn: 1,
        history: [],
        ...overrides
    };
}

function scenario(id, discriminatingQuestions = []) {
    return {
        id,
        label: { ar: id, en: id },
        category: 'other',
        evidenceSignature: [{ token: 'x', weight: 1 }],
        discriminatingQuestions,
        resolution: { hasAutoResolution: false },
        requiresTicketIfUnresolved: true
    };
}

function question(id, resolvesEvidence) {
    return { id, prompt: { ar: id, en: id }, resolvesEvidence, options: [] };
}

test('rankHypotheses: empty input returns an empty, non-ambiguous result', () => {
    const result = rankHypotheses([], []);
    assert.deepEqual(result.ranked, []);
    assert.equal(result.topHypothesis, null);
    assert.equal(result.runnerUp, null);
    assert.equal(result.confidenceGap, null);
    assert.equal(result.isAmbiguous, false);
    assert.deepEqual(result.candidateDiscriminatingQuestions, []);
});

test('rankHypotheses: handles null/undefined input gracefully rather than throwing', () => {
    const result = rankHypotheses(null, null);
    assert.deepEqual(result.ranked, []);
});

test('rankHypotheses: a single hypothesis has no runner-up and no confidence gap', () => {
    const result = rankHypotheses([hypothesis('s1', 0.5)], [scenario('s1')]);
    assert.equal(result.ranked.length, 1);
    assert.equal(result.topHypothesis.hypothesis.scenarioId, 's1');
    assert.equal(result.runnerUp, null);
    assert.equal(result.confidenceGap, null);
    assert.equal(result.isAmbiguous, false);
});

test('rankHypotheses: sorts strictly by descending confidence', () => {
    const result = rankHypotheses(
        [hypothesis('low', 0.1), hypothesis('high', 0.9), hypothesis('mid', 0.5)],
        [scenario('low'), scenario('high'), scenario('mid')]
    );
    assert.deepEqual(
        result.ranked.map((r) => r.hypothesis.scenarioId),
        ['high', 'mid', 'low']
    );
});

test('rankHypotheses: ties are broken deterministically by scenarioId', () => {
    const result = rankHypotheses(
        [hypothesis('zebra', 0.5), hypothesis('alpha', 0.5)],
        [scenario('zebra'), scenario('alpha')]
    );
    assert.deepEqual(
        result.ranked.map((r) => r.hypothesis.scenarioId),
        ['alpha', 'zebra']
    );
});

test('rankHypotheses: assigns sequential 1-based ranks', () => {
    const result = rankHypotheses(
        [hypothesis('a', 0.9), hypothesis('b', 0.5), hypothesis('c', 0.1)],
        [scenario('a'), scenario('b'), scenario('c')]
    );
    assert.deepEqual(result.ranked.map((r) => r.rank), [1, 2, 3]);
});

test('rankHypotheses: attaches the matching scenario object to each entry', () => {
    const s = scenario('s1');
    const result = rankHypotheses([hypothesis('s1', 0.5)], [s]);
    assert.equal(result.ranked[0].scenario, s);
});

test('rankHypotheses: scenario is null when the catalog is missing that scenario id (defensive, does not throw)', () => {
    const result = rankHypotheses([hypothesis('orphan', 0.5)], []);
    assert.equal(result.ranked[0].scenario, null);
});

test('rankHypotheses: confidenceGap is null when fewer than two hypotheses clear the activation threshold', () => {
    // Both below threshold — numerically "close" but not meaningfully comparable
    const result = rankHypotheses(
        [hypothesis('a', 0.05), hypothesis('b', 0.03)],
        [scenario('a'), scenario('b')]
    );
    assert.equal(result.confidenceGap, null);
    assert.equal(result.isAmbiguous, false);
});

test('rankHypotheses: isAmbiguous is true when top two candidates are within AMBIGUITY_MARGIN', () => {
    const result = rankHypotheses(
        [hypothesis('a', 0.5), hypothesis('b', 0.5 - AMBIGUITY_MARGIN + 0.01)],
        [scenario('a'), scenario('b')]
    );
    assert.equal(result.isAmbiguous, true);
});

test('rankHypotheses: isAmbiguous is false when top two candidates are farther apart than AMBIGUITY_MARGIN', () => {
    const result = rankHypotheses(
        [hypothesis('a', 0.9), hypothesis('b', 0.9 - AMBIGUITY_MARGIN - 0.01)],
        [scenario('a'), scenario('b')]
    );
    assert.equal(result.isAmbiguous, false);
});

test('rankHypotheses: candidateDiscriminatingQuestions only includes questions resolving currently-missing evidence', () => {
    const s1 = scenario('s1', [question('q1', ['missing_token']), question('q2', ['present_token'])]);
    const result = rankHypotheses(
        [hypothesis('s1', 0.5, { missingEvidenceTokens: ['missing_token'] })],
        [s1]
    );
    assert.equal(result.candidateDiscriminatingQuestions.length, 1);
    assert.equal(result.candidateDiscriminatingQuestions[0].question.id, 'q1');
});

test('rankHypotheses: candidateDiscriminatingQuestions is empty when a candidate has no discriminating questions', () => {
    const result = rankHypotheses([hypothesis('s1', 0.5, { missingEvidenceTokens: ['x'] })], [scenario('s1', [])]);
    assert.deepEqual(result.candidateDiscriminatingQuestions, []);
});

test('rankHypotheses: candidateDiscriminatingQuestions skips entries with no matching scenario (null scenario)', () => {
    const result = rankHypotheses([hypothesis('orphan', 0.5, { missingEvidenceTokens: ['x'] })], []);
    assert.deepEqual(result.candidateDiscriminatingQuestions, []);
});

test(`rankHypotheses: candidateDiscriminatingQuestions only considers the top ${MAX_CANDIDATE_QUESTIONS_SCENARIOS} candidates`, () => {
    const hyps = [];
    const scenarios = [];
    // 4 candidates all above the activation threshold, each with one
    // discriminating question resolving their own missing evidence.
    for (const [id, confidence] of [
        ['s1', 0.9],
        ['s2', 0.8],
        ['s3', 0.7],
        ['s4', 0.6]
    ]) {
        hyps.push(hypothesis(id, confidence, { missingEvidenceTokens: ['m'] }));
        scenarios.push(scenario(id, [question(`${id}_q`, ['m'])]));
    }
    const result = rankHypotheses(hyps, scenarios);
    assert.equal(result.candidateDiscriminatingQuestions.length, MAX_CANDIDATE_QUESTIONS_SCENARIOS);
    assert.ok(!result.candidateDiscriminatingQuestions.some((q) => q.scenarioId === 's4'));
});

test('rankHypotheses: unconsidered (zero-confidence) hypotheses are still ranked, just at the bottom', () => {
    const result = rankHypotheses(
        [hypothesis('active_one', 0.5), hypothesis('never_evidenced', 0)],
        [scenario('active_one'), scenario('never_evidenced')]
    );
    assert.equal(result.ranked[result.ranked.length - 1].hypothesis.scenarioId, 'never_evidenced');
});
