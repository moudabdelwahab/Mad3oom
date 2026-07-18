/**
 * normalizer.js
 * ------------------------------------------------------------
 * Orchestrates the full Language & Normalization pipeline for one
 * customer message. This is the single entry point the rest of the
 * engine (starting with the Diagnostic Engine, in a later module) calls
 * — nothing downstream needs to know about tokenization, glossary
 * matching, dialect folding, or Arabizi resolution individually.
 *
 * Pipeline order (per approved architecture):
 *   1. Tokenize (script-aware, tracks character offsets)
 *   2. Technical-glossary matching FIRST, on the raw text, before any
 *      dialect/Arabizi transformation touches Latin tokens
 *   3. Arabic-script normalization (dialect-normalizer) on tokens NOT
 *      consumed by the glossary
 *   4. Arabizi normalization on Latin/mixed tokens NOT consumed by the
 *      glossary (so "DNS" is never mistaken for Arabizi digits+letters)
 *   5. Response-language policy, evaluated from the classified tokens
 *
 * Providers (technical glossary, Arabizi map) are accepted as
 * dependencies with local-JSON-backed defaults, so this file never knows
 * or cares whether the data behind them is a JSON file today or a
 * Supabase table later.
 */
import { tokenize } from './tokenizer.js';
import { normalizeArabicToken } from './dialect-normalizer.js';
import { decideResponseLanguage } from './response-language-policy.js';
import { technicalGlossaryProvider } from './technical-glossary.local.js';
import { arabiziMapProvider } from './arabizi-map.local.js';

function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a flat, priority-ordered list of (pattern -> canonical) rules
 * from the glossary entries, longest pattern first, so multi-word
 * phrases like "internal server error" are preferred over shorter
 * overlapping single-word patterns like "error".
 */
function buildGlossaryRules(entries) {
    const rules = [];
    for (const entry of entries) {
        for (const pattern of entry.patterns) {
            rules.push({ pattern, canonical: entry.canonical, labels: entry.labels });
        }
    }
    rules.sort((a, b) => {
        const wordCountDiff = b.pattern.split(/\s+/).length - a.pattern.split(/\s+/).length;
        if (wordCountDiff !== 0) return wordCountDiff;
        return b.pattern.length - a.pattern.length;
    });
    return rules;
}

/**
 * Scans raw text for non-overlapping glossary matches, longest/most
 * specific pattern wins when patterns overlap.
 * @returns {Array<{start: number, end: number, canonical: string, labels: Object}>}
 */
function matchGlossary(text, rules) {
    const matches = [];
    const consumed = []; // list of [start, end) already claimed

    const overlaps = (start, end) =>
        consumed.some(([cStart, cEnd]) => start < cEnd && end > cStart);

    for (const rule of rules) {
        const escaped = escapeRegExp(rule.pattern).replace(/\s+/g, '\\s+');
        const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
        let match;
        while ((match = regex.exec(text)) !== null) {
            const start = match.index;
            const end = start + match[0].length;
            if (!overlaps(start, end)) {
                matches.push({ start, end, canonical: rule.canonical, labels: rule.labels });
                consumed.push([start, end]);
            }
        }
    }

    matches.sort((a, b) => a.start - b.start);
    return matches;
}

function isTokenInsideAnyMatch(token, glossaryMatches) {
    return glossaryMatches.some((m) => token.start >= m.start && token.end <= m.end);
}

/**
 * Attempts to resolve a Latin/mixed-script token as Arabizi (Franco-Arabic).
 * Dictionary lookup first (whole-word, most reliable); falls back to
 * digit-letter substitution as a best-effort signal when the word isn't
 * in the dictionary but clearly uses Arabizi digit conventions.
 */
function resolveArabizi(tokenLower, arabiziMap) {
    const { wordMap, digitLetterMap } = arabiziMap;

    if (Object.prototype.hasOwnProperty.call(wordMap, tokenLower)) {
        return { resolved: true, canonical: normalizeArabicToken(wordMap[tokenLower]) };
    }

    let substituted = '';
    let substitutedAnyDigit = false;
    for (const ch of tokenLower) {
        if (Object.prototype.hasOwnProperty.call(digitLetterMap, ch)) {
            substituted += digitLetterMap[ch];
            substitutedAnyDigit = true;
        } else {
            substituted += ch;
        }
    }

    if (substitutedAnyDigit) {
        // Best-effort partial transliteration — a real digit-letter
        // convention was detected, so this is Arabizi usage even though
        // the remaining Latin letters weren't fully converted. Still
        // useful as a language-policy signal ("this is Arabic, not
        // English") and a rough evidence token.
        return { resolved: true, canonical: substituted };
    }

    return { resolved: false, canonical: null };
}

/**
 * Normalizes one customer message end-to-end.
 *
 * @param {string} text - raw customer message
 * @param {Object} [options]
 * @param {'ar'|'en'} [options.previousLanguage='ar'] - session's current response language
 * @param {{getEntries: Function}} [options.glossaryProvider] - defaults to local-JSON provider
 * @param {{getMap: Function}} [options.arabiziProvider] - defaults to local-JSON provider
 * @returns {Promise<{
 *   rawText: string,
 *   normalizedTokens: Array<{canonical: string, source: string, raw: string}>,
 *   responseLanguage: 'ar'|'en'
 * }>}
 */
export async function normalize(text, options = {}) {
    const {
        previousLanguage = 'ar',
        glossaryProvider = technicalGlossaryProvider,
        arabiziProvider = arabiziMapProvider
    } = options;

    const rawText = text || '';
    const tokens = tokenize(rawText);

    const [glossaryEntries, arabiziMap] = await Promise.all([
        glossaryProvider.getEntries(),
        arabiziProvider.getMap()
    ]);
    const glossaryRules = buildGlossaryRules(glossaryEntries);
    const glossaryMatches = matchGlossary(rawText, glossaryRules);

    const normalizedTokens = [];
    const languagePolicyTokens = [];
    let lastEmittedMatchEnd = -1;

    for (const token of tokens) {
        const insideGlossary = isTokenInsideAnyMatch(token, glossaryMatches);

        if (insideGlossary) {
            // Emit the glossary canonical once per match span, not once
            // per token inside it (a match can span multiple tokens).
            const containingMatch = glossaryMatches.find(
                (m) => token.start >= m.start && token.end <= m.end
            );
            if (containingMatch && containingMatch.end !== lastEmittedMatchEnd) {
                normalizedTokens.push({
                    canonical: containingMatch.canonical,
                    source: 'glossary',
                    raw: rawText.slice(containingMatch.start, containingMatch.end)
                });
                lastEmittedMatchEnd = containingMatch.end;
            }
            languagePolicyTokens.push({
                raw: token.raw,
                script: token.script,
                isGlossaryMatch: true,
                isArabiziResolved: false
            });
            continue;
        }

        if (token.script === 'arabic') {
            const canonical = normalizeArabicToken(token.raw);
            if (canonical) {
                normalizedTokens.push({ canonical, source: 'arabic', raw: token.raw });
            }
            languagePolicyTokens.push({
                raw: token.raw,
                script: token.script,
                isGlossaryMatch: false,
                isArabiziResolved: false
            });
            continue;
        }

        if (token.script === 'latin' || token.script === 'mixed') {
            const { resolved, canonical } = resolveArabizi(token.lower, arabiziMap);
            if (resolved) {
                normalizedTokens.push({ canonical, source: 'arabizi', raw: token.raw });
            } else {
                normalizedTokens.push({ canonical: token.lower, source: 'unrecognized-latin', raw: token.raw });
            }
            languagePolicyTokens.push({
                raw: token.raw,
                script: token.script,
                isGlossaryMatch: false,
                isArabiziResolved: resolved
            });
            continue;
        }

        // digit-only or other: keep as-is, no language-policy weight
        normalizedTokens.push({ canonical: token.lower, source: token.script, raw: token.raw });
        languagePolicyTokens.push({
            raw: token.raw,
            script: token.script,
            isGlossaryMatch: false,
            isArabiziResolved: false
        });
    }

    const responseLanguage = decideResponseLanguage({
        previousLanguage,
        tokens: languagePolicyTokens
    });

    return { rawText, normalizedTokens, responseLanguage };
}
