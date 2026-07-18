/**
 * evidence-extractor.js
 * ------------------------------------------------------------
 * Turns the Language & Normalization Layer's output (normalizedTokens
 * from normalize() in Module 1) into structured, weighted Evidence
 * entries the accumulator/hypothesis-tracker can use.
 *
 * Only tokens that carry actual diagnostic meaning become evidence.
 * "unrecognized-latin" tokens (genuine English/unknown words with no
 * mapping) and bare "digit"/"other" tokens with no glossary match carry
 * no signal on their own — including them as zero-weight evidence would
 * just add noise, so they're intentionally excluded here (the token
 * stream itself is still available upstream for language-policy /
 * observability purposes, unaffected by this filtering).
 *
 * Base confidence weights per source reflect how much a single
 * observation should be trusted:
 *  - glossary match: 1.0  (explicit technical vocabulary, very reliable)
 *  - arabic (dialect-normalized): 0.8  (a real recognized word, but
 *    Arabic words can be polysemous, so slightly less than glossary)
 *  - arabizi (transliteration-resolved): 0.75  (adds a small amount of
 *    uncertainty from the transliteration step itself)
 */

const BASE_WEIGHT_BY_SOURCE = {
    glossary: 1.0,
    arabic: 0.8,
    arabizi: 0.75
};

const EVIDENCE_BEARING_SOURCES = new Set(Object.keys(BASE_WEIGHT_BY_SOURCE));

/**
 * @param {Array<{canonical: string, source: string, raw: string}>} normalizedTokens
 *   Output of Module 1's normalize().normalizedTokens
 * @param {number} turn - current turn number
 * @returns {import('./evidence-types.js').Evidence[]}
 */
export function extractTextEvidence(normalizedTokens, turn) {
    if (!Array.isArray(normalizedTokens)) return [];

    const evidence = [];
    for (const token of normalizedTokens) {
        if (!EVIDENCE_BEARING_SOURCES.has(token.source)) continue;
        if (!token.canonical) continue;

        evidence.push({
            token: token.canonical,
            source: 'text',
            polarity: 'supports',
            weight: BASE_WEIGHT_BY_SOURCE[token.source],
            turn,
            raw: token.raw
        });
    }
    return evidence;
}

/**
 * Builds an Evidence entry from a discriminating-question answer (see
 * Module 2's Scenario.discriminatingQuestions[].options[].impliesEvidence).
 * Not wired to any live UI yet (the Decision/Dialogue Engines that will
 * actually ask these questions don't exist yet) — exposed now so this
 * capability can be exercised and tested ahead of that wiring, per the
 * approved architecture's intent for discriminating-question answers to
 * feed evidence back into the Diagnostic Engine.
 *
 * @param {Object} params
 * @param {string[]} params.impliedTokens - tokens implied by the chosen option
 * @param {'supports'|'contradicts'} [params.polarity='supports']
 * @param {number} params.turn
 * @param {number} [params.weight=0.9] - answers to direct questions are
 *   fairly reliable, but not maximal (customers can still misinterpret
 *   the question)
 * @returns {import('./evidence-types.js').Evidence[]}
 */
export function extractDiscriminatingAnswerEvidence({ impliedTokens, polarity = 'supports', turn, weight = 0.9 }) {
    if (!Array.isArray(impliedTokens)) return [];
    return impliedTokens
        .filter((token) => typeof token === 'string' && token.trim() !== '')
        .map((token) => ({ token, source: 'text', polarity, weight, turn }));
}
