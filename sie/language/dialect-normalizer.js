/**
 * dialect-normalizer.js
 * ------------------------------------------------------------
 * Egyptian dialect + spelling-variant + diacritics normalization for
 * Arabic-script tokens.
 *
 * This is a direct reuse of the normalization logic already proven in
 * the current chatbot-engine.js (collapseRepeatedChars / normalizeArabic),
 * per the instruction to reuse existing logic wherever possible. Nothing
 * about the transformation rules has changed — only its role has: here
 * it operates on a single Arabic-script token (as decided by the
 * tokenizer), rather than on a whole raw message, since technical-glossary
 * matching now happens as an earlier, separate pass.
 */

/**
 * Collapses runs of 3+ repeated characters down to 1
 * (e.g. "مشكلططططة" typing noise, "nooooo" -> "no").
 * Identical to the existing implementation in chatbot-engine.js.
 * @param {string} text
 * @returns {string}
 */
export function collapseRepeatedChars(text) {
    return text.replace(/(.)\1{2,}/g, '$1');
}

/**
 * Normalizes a single Arabic-script string: strips diacritics/tatweel,
 * unifies alef/ya/taa-marbuta/hamza variants, collapses repeated chars,
 * and trims whitespace/punctuation noise.
 *
 * Identical rule set to the existing normalizeArabic() in
 * chatbot-engine.js. Kept generic over strings (not just single tokens)
 * so existing pattern-matching logic that operates on whole phrases can
 * reuse it unchanged later.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeArabicText(text) {
    if (!text) return '';
    let t = String(text).toLowerCase();
    t = collapseRepeatedChars(t);
    t = t
        .replace(/[\u064B-\u065F\u0670]/g, '')   // remove diacritics (تشكيل)
        .replace(/\u0640/g, '')                   // remove tatweel (ـــ)
        .replace(/[إأآا]/g, 'ا')
        .replace(/ى/g, 'ي')
        .replace(/ة/g, 'ه')
        .replace(/ؤ/g, 'و')
        .replace(/ئ/g, 'ي')
        .replace(/[؟،؛٪]/g, ' ')
        .replace(/[^\u0600-\u06FFa-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return t;
}

/**
 * Normalizes a single Arabic-script token (as produced by the tokenizer)
 * to its canonical form. Thin convenience wrapper around
 * normalizeArabicText for the single-token case used by the main
 * normalization pipeline.
 *
 * @param {string} token
 * @returns {string}
 */
export function normalizeArabicToken(token) {
    return normalizeArabicText(token);
}
