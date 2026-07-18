/**
 * typo-tolerance.js
 * ------------------------------------------------------------
 * Levenshtein-based fuzzy token matching, tolerating small typing
 * mistakes. This is a direct reuse of the levenshtein/fuzzyWordMatch
 * logic already proven in chatbot-engine.js — the algorithm is
 * unchanged, only its position in the pipeline has moved: it now runs
 * on already-normalized tokens (post dialect/Arabizi normalization),
 * rather than on raw text, so it's comparing cleaner input than before.
 *
 * This module is a general-purpose utility. The main normalization
 * pipeline (normalizer.js) does not force fuzzy-correction on every
 * token by itself — that would risk silently "correcting" a token into
 * the wrong word with no reference vocabulary to check against yet.
 * Instead, findBestFuzzyMatch() is exposed for the Diagnostic Engine's
 * evidence-extractor (a later module) to use once it has a concrete
 * vocabulary (scenario evidence signatures) to match tokens against.
 */

/**
 * Simple Levenshtein (edit) distance between two strings.
 * Identical implementation to chatbot-engine.js.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = a[i - 1] === b[j - 1]
                ? prev[j - 1]
                : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
        }
        prev = cur;
    }
    return prev[b.length];
}

/**
 * Whether `word` fuzzily matches `target`, tolerating small typos.
 * Identical thresholds/logic to chatbot-engine.js's fuzzyWordMatch.
 * @param {string} word
 * @param {string} target
 * @returns {boolean}
 */
export function fuzzyWordMatch(word, target) {
    if (word === target) return true;
    if (Math.abs(word.length - target.length) > 2) return false;
    const threshold = target.length >= 7 ? 2 : 1;
    return levenshtein(word, target) <= threshold;
}

/**
 * Finds the best fuzzy match for `word` among a list of candidate
 * canonical strings, returning the closest match if within tolerance,
 * or null if nothing is close enough.
 *
 * New helper (not present verbatim in chatbot-engine.js, but built from
 * the same primitives) — intended for later consumption by the
 * Diagnostic Engine's evidence-extractor once a concrete evidence
 * vocabulary exists to match against.
 *
 * @param {string} word
 * @param {string[]} candidates
 * @returns {string|null}
 */
export function findBestFuzzyMatch(word, candidates) {
    let best = null;
    let bestDistance = Infinity;
    for (const candidate of candidates) {
        if (!fuzzyWordMatch(word, candidate)) continue;
        const distance = levenshtein(word, candidate);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = candidate;
        }
    }
    return best;
}
