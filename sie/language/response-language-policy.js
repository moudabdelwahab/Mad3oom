/**
 * response-language-policy.js
 * ------------------------------------------------------------
 * Decides which language the engine should reply in for a given turn.
 *
 * Rules (per approved architecture):
 * - Arabic is the default. A brand-new session starts in Arabic.
 * - Switch to English only when the message is genuinely English prose —
 *   i.e. contains Latin-script words that are NOT technical-glossary
 *   terms and NOT resolvable as Arabizi (Franco-Arabic). Technical terms
 *   (API, DNS, 401, SSL...) and Arabizi words (msh, 3ayez...) do not
 *   count as "the user is writing in English", since the former is
 *   vocabulary and the latter is Arabic typed phonetically.
 * - Switch back to Arabic immediately as soon as any genuine Arabic-script
 *   token reappears — Arabic wins back without needing a streak, since
 *   it's the default.
 * - A message with only glossary/Arabizi/numeric content (no genuine
 *   prose either way) keeps the session's current language (sticky).
 *
 * This module only ever looks at classified tokens — it never inspects
 * raw text itself, keeping it decoupled from tokenization/normalization
 * details.
 */

/**
 * @typedef {Object} ClassifiedToken
 * @property {string} raw
 * @property {'arabic'|'latin'|'digit'|'mixed'|'other'} script
 * @property {boolean} isGlossaryMatch - true if this token was consumed by a technical-glossary match
 * @property {boolean} isArabiziResolved - true if this Latin/mixed token resolved to Arabic via Arabizi
 */

/**
 * @param {Object} params
 * @param {'ar'|'en'} [params.previousLanguage='ar']
 * @param {ClassifiedToken[]} params.tokens
 * @returns {'ar'|'en'}
 */
export function decideResponseLanguage({ previousLanguage = 'ar', tokens = [] }) {
    const hasGenuineArabic = tokens.some(
        (t) => t.script === 'arabic' || (t.isArabiziResolved && true)
    );
    // Arabic (including Arabizi-resolved Arabic) always wins back immediately.
    if (hasGenuineArabic) return 'ar';

    const hasGenuineEnglishProse = tokens.some(
        (t) =>
            (t.script === 'latin' || t.script === 'mixed') &&
            !t.isGlossaryMatch &&
            !t.isArabiziResolved
    );
    if (hasGenuineEnglishProse) return 'en';

    // No genuine language signal either way (e.g. only numbers, only
    // technical terms) — stay on whatever the session was already using.
    return previousLanguage;
}
