import test from 'node:test';
import assert from 'node:assert/strict';
import {
    computeScenarioConfidence,
    updateHypotheses,
    ACTIVATION_THRESHOLD,
    REJECTION_THRESHOLD
} from '../hypothesis-tracker.js';

function scenario(id, evidenceSignature) {
    return {
        id,
        label: { ar: id, en: id },
        category: 'other',
        evidenceSignature,
        discriminatingQuestions: [],
        resolution: { hasAutoResolution: false },
        requiresTicketIfUnresolved: true
    };
}

test('computeScenarioConfidence: no evidence present at all yields confidence 0', () => {
    const s = scenario('s1', [{ token: 'x', weight: 1 }]);
    const { confidence, supportingEvidenceTokens, missingEvidenceTokens } = computeScenarioConfidence(
        s,
        new Map()
    );
    assert.equal(confidence, 0);
    assert.deepEqual(supportingEvidenceTokens, []);
    assert.deepEqual(missingEvidenceTokens, ['x']);
});

test('computeScenarioConfidence: full presence on the only evidence token yields confidence 1', () => {
    const s = scenario('s1', [{ token: 'x', weight: 1 }]);
    const { confidence } = computeScenarioConfidence(s, new Map([['x', 1]]));
    assert.equal(confidence, 1);
});

test('computeScenarioConfidence: is a weighted average across multiple evidence tokens', () => {
    const s = scenario('s1', [
        { token: 'a', weight: 3 },
        { token: 'b', weight: 1 }
    ]);
    // a fully present (weight 3), b absent (weight 1) -> (1*3 + 0*1) / 4 = 0.75
    const { confidence } = computeScenarioConfidence(s, new Map([['a', 1]]));
    assert.ok(Math.abs(confidence - 0.75) < 1e-9);
});

test('computeScenarioConfidence: correctly separates supporting vs missing tokens', () => {
    const s = scenario('s1', [
        { token: 'present', weight: 1 },
        { token: 'absent', weight: 1 }
    ]);
    const { supportingEvidenceTokens, missingEvidenceTokens } = computeScenarioConfidence(
        s,
        new Map([['present', 0.5]])
    );
    assert.deepEqual(supportingEvidenceTokens, ['present']);
    assert.deepEqual(missingEvidenceTokens, ['absent']);
});

test('updateHypotheses: creates one hypothesis per scenario, even with zero evidence', () => {
    const scenarios = [scenario('s1', [{ token: 'x', weight: 1 }]), scenario('s2', [{ token: 'y', weight: 1 }])];
    const hypotheses = updateHypotheses(scenarios, new Map(), [], 1);
    assert.equal(hypotheses.length, 2);
    assert.ok(hypotheses.every((h) => h.status === 'unconsidered'));
});

test('updateHypotheses: a scenario crossing the activation threshold becomes "active"', () => {
    const s = scenario('s1', [{ token: 'x', weight: 1 }]);
    const hypotheses = updateHypotheses([s], new Map([['x', ACTIVATION_THRESHOLD]]), [], 1);
    assert.equal(hypotheses[0].status, 'active');
});

test('updateHypotheses: a scenario below the activation threshold stays "unconsidered"', () => {
    const s = scenario('s1', [{ token: 'x', weight: 1 }]);
    const hypotheses = updateHypotheses([s], new Map([['x', ACTIVATION_THRESHOLD - 0.01]]), [], 1);
    assert.equal(hypotheses[0].status, 'unconsidered');
});

test('updateHypotheses: an active hypothesis whose confidence drops below the rejection threshold becomes "rejected"', () => {
    const s = scenario('s1', [{ token: 'x', weight: 1 }]);
    let hypotheses = updateHypotheses([s], new Map([['x', 0.9]]), [], 1);
    assert.equal(hypotheses[0].status, 'active');

    hypotheses = updateHypotheses([s], new Map([['x', REJECTION_THRESHOLD - 0.01]]), hypotheses, 2);
    assert.equal(hypotheses[0].status, 'rejected');
});

test('updateHypotheses: a rejected hypothesis record is preserved, not removed, in the array', () => {
    const s = scenario('s1', [{ token: 'x', weight: 1 }]);
    let hypotheses = updateHypotheses([s], new Map([['x', 0.9]]), [], 1);
    hypotheses = updateHypotheses([s], new Map([['x', 0]]), hypotheses, 2);
    assert.equal(hypotheses.length, 1);
    assert.equal(hypotheses[0].scenarioId, 's1');
    assert.equal(hypotheses[0].status, 'rejected');
});

test('updateHypotheses: a rejected hypothesis can reactivate if evidence later justifies it', () => {
    const s = scenario('s1', [{ token: 'x', weight: 1 }]);
    let hypotheses = updateHypotheses([s], new Map([['x', 0.9]]), [], 1); // active
    hypotheses = updateHypotheses([s], new Map([['x', 0]]), hypotheses, 2); // rejected
    assert.equal(hypotheses[0].status, 'rejected');
    hypotheses = updateHypotheses([s], new Map([['x', 0.9]]), hypotheses, 3); // reactivated
    assert.equal(hypotheses[0].status, 'active');
});

test('updateHypotheses: hysteresis band keeps a previously-active hypothesis "active" between the two thresholds', () => {
    const s = scenario('s1', [{ token: 'x', weight: 1 }]);
    let hypotheses = updateHypotheses([s], new Map([['x', 0.9]]), [], 1); // active
    // Confidence drops but stays between REJECTION_THRESHOLD and ACTIVATION_THRESHOLD
    const midBand = (ACTIVATION_THRESHOLD + REJECTION_THRESHOLD) / 2;
    hypotheses = updateHypotheses([s], new Map([['x', midBand]]), hypotheses, 2);
    assert.equal(hypotheses[0].status, 'active');
});

test('updateHypotheses: history records every status/confidence change, not every turn', () => {
    const s = scenario('s1', [{ token: 'x', weight: 1 }]);
    let hypotheses = updateHypotheses([s], new Map([['x', 0.9]]), [], 1);
    // same confidence again on turn 2 -> no new history entry expected
    hypotheses = updateHypotheses([s], new Map([['x', 0.9]]), hypotheses, 2);
    assert.equal(hypotheses[0].history.length, 1);

    // confidence changes on turn 3 -> new history entry
    hypotheses = updateHypotheses([s], new Map([['x', 0.5]]), hypotheses, 3);
    assert.equal(hypotheses[0].history.length, 2);
});

test('updateHypotheses: firstSeenTurn is preserved across updates, lastUpdatedTurn always reflects the latest call', () => {
    const s = scenario('s1', [{ token: 'x', weight: 1 }]);
    let hypotheses = updateHypotheses([s], new Map([['x', 0.9]]), [], 1);
    assert.equal(hypotheses[0].firstSeenTurn, 1);
    hypotheses = updateHypotheses([s], new Map([['x', 0.9]]), hypotheses, 5);
    assert.equal(hypotheses[0].firstSeenTurn, 1);
    assert.equal(hypotheses[0].lastUpdatedTurn, 5);
});

test('updateHypotheses: adding a new scenario to the catalog mid-session creates a fresh hypothesis without disturbing existing ones', () => {
    const s1 = scenario('s1', [{ token: 'x', weight: 1 }]);
    const s2 = scenario('s2', [{ token: 'y', weight: 1 }]);
    let hypotheses = updateHypotheses([s1], new Map([['x', 0.9]]), [], 1);
    hypotheses = updateHypotheses([s1, s2], new Map([['x', 0.9]]), hypotheses, 2);
    assert.equal(hypotheses.length, 2);
    const s2Hypothesis = hypotheses.find((h) => h.scenarioId === 's2');
    assert.equal(s2Hypothesis.status, 'unconsidered');
    assert.equal(s2Hypothesis.firstSeenTurn, 2);
});
