import test from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, decidePublishability, DRAFT_STATES } from '../publish-gate.js';

// ------------------------------------------------------------------
// canTransition — the state machine
// ------------------------------------------------------------------

test('DRAFT_STATES: the four states are exactly draft, validated, published, rejected', () => {
    assert.deepEqual([...DRAFT_STATES], ['draft', 'validated', 'published', 'rejected']);
});

test('canTransition: draft -> validated is allowed', () => {
    assert.equal(canTransition('draft', 'validated'), true);
});

test('canTransition: validated -> published is allowed', () => {
    assert.equal(canTransition('validated', 'published'), true);
});

test('canTransition: draft -> published is NOT allowed (must pass through validated)', () => {
    assert.equal(canTransition('draft', 'published'), false);
});

test('canTransition: published is terminal — no transitions out', () => {
    assert.equal(canTransition('published', 'draft'), false);
    assert.equal(canTransition('published', 'validated'), false);
    assert.equal(canTransition('published', 'rejected'), false);
});

test('canTransition: rejected -> draft is allowed (revise and resubmit)', () => {
    assert.equal(canTransition('rejected', 'draft'), true);
});

test('canTransition: an unknown state never allows any transition', () => {
    assert.equal(canTransition('not_a_real_state', 'draft'), false);
});

// ------------------------------------------------------------------
// decidePublishability — the actual gate
// ------------------------------------------------------------------

test('decidePublishability: allowed, no override needed, when the verdict passed', () => {
    const result = decidePublishability({ verdict: { passed: true, reasons: [] } });
    assert.equal(result.allowed, true);
    assert.equal(result.requiresOverride, false);
});

test('decidePublishability: blocked when the verdict failed and no override reason is given', () => {
    const result = decidePublishability({ verdict: { passed: false, reasons: ['turn 2: confidence regressed from 0.800 to 0.500'] } });
    assert.equal(result.allowed, false);
    assert.equal(result.requiresOverride, true);
    assert.ok(result.reason.includes('confidence regressed'));
});

test('decidePublishability: allowed with requiresOverride=true when the verdict failed but a non-empty override reason is given', () => {
    const result = decidePublishability({ verdict: { passed: false, reasons: ['x'] }, overrideReason: 'known false positive, approved by lead' });
    assert.equal(result.allowed, true);
    assert.equal(result.requiresOverride, true);
    assert.ok(result.reason.includes('known false positive, approved by lead'));
});

test('decidePublishability: a whitespace-only override reason does NOT count as a real override', () => {
    const result = decidePublishability({ verdict: { passed: false, reasons: ['x'] }, overrideReason: '   ' });
    assert.equal(result.allowed, false);
});

test('decidePublishability: blocked when no validation run has been recorded at all (verdict is null)', () => {
    const result = decidePublishability({ verdict: null });
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes('no validation run'));
});

test('decidePublishability: a null verdict still requires an override reason, matching a failed verdict\'s posture', () => {
    const blocked = decidePublishability({ verdict: null, overrideReason: null });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.requiresOverride, true);
});
