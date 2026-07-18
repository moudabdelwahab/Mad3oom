/**
 * tokenizer.js
 * ------------------------------------------------------------
 * Script-aware tokenization for the Language & Normalization Layer.
 *
 * Splits raw customer text into word-level tokens and classifies each
 * token by script (arabic / latin / digit / mixed), while also recording
 * the character offsets of each token in the original text. The offsets
 * are what let the technical-glossary matcher (which works on the raw
 * text, since glossary phrases can span multiple tokens, e.g.
 * "Internal Server Error") later mark which tokens were "consumed" by a
 * glossary match.
 *
 * This module does not normalize or interpret anything — it only
 * segments and classifies. Normalization (dialect, Arabizi, glossary)
 * happens in the modules that consume its output.
 */

const ARABIC_CHAR = /[\u0600-\u06FF]/;
const LATIN_CHAR = /[A-Za-z]/;
const DIGIT_CHAR = /[0-9]/;

/**
 * Classifies a single token string by which script(s) it contains.
 * @param {string} raw
 * @returns {'arabic'|'latin'|'digit'|'mixed'}
 */
function classifyToken(raw) {
    const hasArabic = ARABIC_CHAR.test(raw);
    const hasLatin = LATIN_CHAR.test(raw);
    const hasDigit = DIGIT_CHAR.test(raw);

    const scriptCount = [hasArabic, hasLatin, hasDigit].filter(Boolean).length;

    if (scriptCount > 1) return 'mixed';
    if (hasArabic) return 'arabic';
    if (hasLatin) return 'latin';
    if (hasDigit) return 'digit';
    return 'other';
}

/**
 * Splits raw text into word tokens, discarding whitespace and most
 * punctuation as separators, but keeping track of each token's position
 * in the original string.
 *
 * @param {string} text
 * @returns {Array<{ raw: string, script: string, start: number, end: number }>}
 */
export function tokenize(text) {
    if (!text) return [];

    const tokens = [];
    // A "word" is a run of Arabic letters, Latin letters, and/or digits.
    // Punctuation, symbols, and whitespace act as separators.
    const wordPattern = /[\u0600-\u06FFA-Za-z0-9]+/g;
    let match;

    while ((match = wordPattern.exec(text)) !== null) {
        const raw = match[0];
        tokens.push({
            raw,
            lower: raw.toLowerCase(),
            script: classifyToken(raw),
            start: match.index,
            end: match.index + raw.length
        });
    }

    return tokens;
}
