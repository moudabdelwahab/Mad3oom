import test from 'node:test';
import assert from 'node:assert/strict';
import { processTurn, getActiveHypotheses, getRejectedHypotheses } from '../diagnostic-engine.js';
import { extractDiscriminatingAnswerEvidence } from '../evidence-extractor.js';
import { createEmptyDiagnosticState } from '../evidence-types.js';
import { createScenarioCatalogProvider } from '../../scenarios/scenario-catalog.provider.js';
import { createLiveEvidenceProvider } from '../live-evidence-provider.js';
import { normalizeReal, createRealScenarioCatalogProvider } from './helpers/node-providers.js';

function fakeScenario(id, evidenceSignature) {
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

function fakeScenarioProvider(scenarios) {
    return createScenarioCatalogProvider(async () => scenarios);
}

test('processTurn: starting fresh (no previousState), extracts text evidence and produces hypotheses for every scenario', async () => {
    const scenarioProvider = fakeScenarioProvider([fakeScenario('s1', [{ token: 'entity_api', weight: 1 }])]);

    const state = await processTurn({
        normalizedTokens: [{ canonical: 'entity_api', source: 'glossary', raw: 'API' }],
        turn: 1,
        scenarioProvider
    });

    assert.equal(state.hypotheses.length, 1);
    assert.equal(state.hypotheses[0].scenarioId, 's1');
    assert.equal(state.hypotheses[0].status, 'active');
    assert.equal(state.accumulator.entries.length, 1);
});

test('processTurn: with no liveEvidenceContext, live evidence is not fetched at all', async () => {
    let fetchCalled = false;
    const liveEvidenceProvider = createLiveEvidenceProvider(async () => {
        fetchCalled = true;
        return [];
    });
    const scenarioProvider = fakeScenarioProvider([fakeScenario('s1', [{ token: 'x', weight: 1 }])]);

    await processTurn({ normalizedTokens: [], turn: 1, scenarioProvider, liveEvidenceProvider });
    assert.equal(fetchCalled, false);
});

test('processTurn: with a liveEvidenceContext, live evidence is fetched and merged', async () => {
    const scenarioProvider = fakeScenarioProvider([fakeScenario('s1', [{ token: 'account_recently_locked', weight: 1 }])]);
    const liveEvidenceProvider = createLiveEvidenceProvider(async () => [
        { token: 'account_recently_locked', source: 'live', polarity: 'supports', weight: 1, turn: 1 }
    ]);

    const state = await processTurn({
        normalizedTokens: [],
        turn: 1,
        scenarioProvider,
        liveEvidenceProvider,
        liveEvidenceContext: { userId: 'user-123' }
    });

    assert.equal(state.hypotheses[0].status, 'active');
    assert.equal(state.accumulator.entries[0].source, 'live');
});

test('processTurn: a failing live evidence provider degrades gracefully (text evidence still processed)', async () => {
    const scenarioProvider = fakeScenarioProvider([fakeScenario('s1', [{ token: 'entity_api', weight: 1 }])]);
    const liveEvidenceProvider = createLiveEvidenceProvider(async () => {
        throw new Error('supabase is down');
    });

    const state = await processTurn({
        normalizedTokens: [{ canonical: 'entity_api', source: 'glossary', raw: 'API' }],
        turn: 1,
        scenarioProvider,
        liveEvidenceProvider,
        liveEvidenceContext: { userId: 'user-123' }
    });

    assert.equal(state.hypotheses[0].status, 'active'); // text evidence alone was enough
});

test('processTurn: additionalEvidence (e.g. from a discriminating-question answer) is merged in', async () => {
    const scenarioProvider = fakeScenarioProvider([fakeScenario('s1', [{ token: 'مقفول', weight: 1 }])]);
    const additionalEvidence = extractDiscriminatingAnswerEvidence({ impliedTokens: ['مقفول'], turn: 1, weight: 1 });

    const state = await processTurn({ normalizedTokens: [], turn: 1, scenarioProvider, additionalEvidence });
    assert.equal(state.hypotheses[0].status, 'active');
});

test('processTurn: state carries forward correctly across multiple turns', async () => {
    const scenarioProvider = fakeScenarioProvider([
        fakeScenario('s1', [
            { token: 'a', weight: 1 },
            { token: 'b', weight: 1 }
        ])
    ]);

    let state = await processTurn({
        normalizedTokens: [{ canonical: 'a', source: 'arabic', raw: 'a' }],
        turn: 1,
        scenarioProvider
    });
    const confidenceAfterTurn1 = state.hypotheses[0].confidence;
    assert.ok(confidenceAfterTurn1 < 1); // only half the signature present

    state = await processTurn({
        normalizedTokens: [{ canonical: 'b', source: 'arabic', raw: 'b' }],
        turn: 2,
        previousState: state,
        scenarioProvider
    });
    assert.equal(state.accumulator.entries.length, 2); // both turns' evidence retained
    assert.ok(state.hypotheses[0].confidence > confidenceAfterTurn1); // now both tokens present
});

test('processTurn: defaults to an empty DiagnosticState when previousState is omitted', async () => {
    const scenarioProvider = fakeScenarioProvider([fakeScenario('s1', [{ token: 'x', weight: 1 }])]);
    const state = await processTurn({ normalizedTokens: [], turn: 1, scenarioProvider });
    assert.deepEqual(state.accumulator.entries, []);
});

test('getActiveHypotheses / getRejectedHypotheses: filter correctly and independently', () => {
    const state = {
        hypotheses: [
            { scenarioId: 'a', status: 'active' },
            { scenarioId: 'b', status: 'rejected' },
            { scenarioId: 'c', status: 'unconsidered' }
        ]
    };
    assert.deepEqual(getActiveHypotheses(state).map((h) => h.scenarioId), ['a']);
    assert.deepEqual(getRejectedHypotheses(state).map((h) => h.scenarioId), ['b']);
});

test('getActiveHypotheses / getRejectedHypotheses: handle an empty/undefined state without throwing', () => {
    assert.deepEqual(getActiveHypotheses(undefined), []);
    assert.deepEqual(getRejectedHypotheses(createEmptyDiagnosticState()), []);
});

// ------------------------------------------------------------------
// End-to-end integration: real Module 1 normalization + real Module 2
// scenario catalog, exercised together exactly as they'll eventually be
// wired (minus live chat integration, which stays out of scope here).
// ------------------------------------------------------------------

test('end-to-end: "الـ Token انتهت صلاحيته" drives login_token_expired to active with real modules', async () => {
    const normalized = await normalizeReal('الـ Token انتهت صلاحيته');
    const state = await processTurn({
        normalizedTokens: normalized.normalizedTokens,
        turn: 1,
        scenarioProvider: createRealScenarioCatalogProvider()
    });

    const hypothesis = state.hypotheses.find((h) => h.scenarioId === 'login_token_expired');
    assert.ok(hypothesis, 'login_token_expired hypothesis must exist');
    assert.equal(hypothesis.status, 'active');

    // Unrelated scenarios should not have been dragged along
    const unrelated = state.hypotheses.find((h) => h.scenarioId === 'ssl_certificate_issue');
    assert.equal(unrelated.status, 'unconsidered');
});

test('end-to-end: a vague message ("عندي مشكلة") does not activate any specific scenario', async () => {
    const normalized = await normalizeReal('عندي مشكلة');
    const state = await processTurn({
        normalizedTokens: normalized.normalizedTokens,
        turn: 1,
        scenarioProvider: createRealScenarioCatalogProvider()
    });

    const activeSpecificScenarios = state.hypotheses.filter(
        (h) => h.status === 'active' && h.scenarioId !== 'unknown'
    );
    assert.deepEqual(activeSpecificScenarios, []);
});

test('end-to-end: evidence accumulates across turns to raise confidence in the right scenario', async () => {
    // NOTE: phrasing here deliberately avoids nouns with an attached
    // Arabic definite article ("ال") directly fused to the word (e.g.
    // "الباسورد", "الدخول"). The current tokenizer/dialect-normalizer
    // does not strip that prefix, so "الباسورد" tokenizes as one token
    // distinct from the catalog's bare evidence token "باسورد" and would
    // never match. This is a known, documented limitation (see
    // tests/README.md) rather than something this test should paper
    // over — so these examples use phrasing that produces the bare
    // word, which is also natural, common colloquial Egyptian Arabic.
    const scenarioProvider = createRealScenarioCatalogProvider();

    const turn1 = await normalizeReal('عندي مشكلة تسجيل دخول');
    let state = await processTurn({ normalizedTokens: turn1.normalizedTokens, turn: 1, scenarioProvider });
    const confidenceAfterTurn1 =
        state.hypotheses.find((h) => h.scenarioId === 'login_credentials_forgotten')?.confidence || 0;

    const turn2 = await normalizeReal('باسورد غلط كده', 'ar');
    state = await processTurn({
        normalizedTokens: turn2.normalizedTokens,
        turn: 2,
        previousState: state,
        scenarioProvider
    });
    const confidenceAfterTurn2 = state.hypotheses.find((h) => h.scenarioId === 'login_credentials_forgotten').confidence;

    assert.ok(
        confidenceAfterTurn2 > confidenceAfterTurn1,
        `expected confidence to increase (turn1=${confidenceAfterTurn1}, turn2=${confidenceAfterTurn2})`
    );
});

test('KNOWN LIMITATION: a word with an attached Arabic definite article ("ال") does not match its bare evidence token', async () => {
    // Documents a real, currently-unaddressed gap rather than hiding it:
    // "الباسورد" (the-password, article fused with no space, which is
    // standard Arabic orthography) tokenizes as a single distinct token
    // and does NOT match the catalog's bare evidence token "باسورد".
    // This is a property of Module 1's tokenizer/dialect-normalizer (no
    // morphological article-stripping), not of the Diagnostic Engine's
    // matching logic, which correctly does exact-token comparison
    // against whatever Module 1 produces. Locked in here as an explicit
    // regression test: if this starts failing (i.e. confidence is no
    // longer 0), it means article-stripping was added upstream, and this
    // test plus the note in tests/README.md should be revisited.
    const scenarioProvider = createRealScenarioCatalogProvider();
    const normalized = await normalizeReal('نسيت الباسورد بتاعي');
    const state = await processTurn({ normalizedTokens: normalized.normalizedTokens, turn: 1, scenarioProvider });
    const hypothesis = state.hypotheses.find((h) => h.scenarioId === 'login_credentials_forgotten');
    assert.equal(hypothesis.confidence, 0, 'documents that "الباسورد" currently does not match evidence token "باسورد"');
});

test('end-to-end: DiagnosticState round-trips through JSON (safe for chat_sessions.bot_state storage later)', async () => {
    const normalized = await normalizeReal('عندي Error 401');
    const state = await processTurn({
        normalizedTokens: normalized.normalizedTokens,
        turn: 1,
        scenarioProvider: createRealScenarioCatalogProvider()
    });

    const roundTripped = JSON.parse(JSON.stringify(state));
    assert.deepEqual(roundTripped, state);
});
