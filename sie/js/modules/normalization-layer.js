/**
 * normalization-layer.js
 * ------------------------------------------------------------
 * Module 1 — Normalization Layer
 * Support Intelligence Engine (SIE) — منصة مدعوم
 * Implements §8.1 of "Website Chat Engine → Support Intelligence Engine —
 * Diagnostic-Centered Architecture" (v1.1, APPROVED & FROZEN).
 *
 * CONTRACT (§8.1, verbatim from spec):
 *   Responsibilities: Convert raw user input (text, and metadata like
 *     attached image presence) into a normalized, structured token/intent
 *     representation. Detect low-level intents (greeting, thanks, cancel)
 *     that are not diagnosis-relevant.
 *   Inputs: Raw chat_messages row (text, image_url/audio_url presence),
 *     prior normalized_tokens if relevant for context (e.g. repeated
 *     corrections).
 *   Outputs: normalized_tokens object — cleaned text, detected low-level
 *     intent, detected entities/keywords. Written verbatim into
 *     chat_engine_trace_events.normalized_tokens.
 *   Dependencies: None on other SIE modules. May depend on a
 *     language/NLP utility library.
 *   Must never: Decide a scenario, a hypothesis, or an action. Must never
 *     write to chat_sessions, tickets, or any table other than the trace
 *     event it emits into.
 *
 * MODULE FORMAT:
 *   ES modules (export function / export const), matching the existing
 *   production chatbot-engine.js exactly — no bundler, no framework, no
 *   module-system change, per the "no framework migration" constraint
 *   and backward-compatibility requirement.
 *
 * PROVENANCE / PARITY NOTE:
 *   collapseRepeatedChars, normalizeArabic, levenshtein, fuzzyWordMatch,
 *   matchesPattern, and matchAny below are extracted VERBATIM (unchanged
 *   logic, unchanged behavior) from the production chatbot-engine.js (v6)
 *   "أدوات المطابقة" section, per architectural decision: reuse existing
 *   implementation, preserve exact behavior, no redesign.
 *
 *   chatbot-engine.js itself is NOT modified by this module (explicit
 *   instruction: option (b) — standalone extraction now; integration
 *   happens during §6 Phase 1 Shadow Mode later, only after this module
 *   is validated). The two implementations currently coexist in the
 *   codebase; parity between them is enforced by tests/parity.test.js,
 *   which runs shared fixtures through both and asserts identical output.
 *
 * ARCHITECTURAL NOTE — detectCategory / CATEGORY_MAP intentionally excluded:
 *   chatbot-engine.js also contains detectCategory()/CATEGORY_MAP. That
 *   logic decides *which problem domain* a message belongs to, which is
 *   diagnosis-relevant and conceptually belongs to the Scenario Engine
 *   (§8.2), not the Normalization Layer (§8.1's low-level intents are
 *   explicitly limited to greeting/thanks/cancel — never diagnosis-
 *   relevant categorization). Confirmed as an explicit architectural
 *   decision; deliberately left out of this module and out of
 *   chatbot-engine.js's untouched production code alike.
 *
 * STORAGE-AGNOSTIC (§7 Principle 3, §7 Principle 4):
 *   This module performs no I/O, reads no table, and writes nothing.
 *   It is a pure function of its inputs. Persistence into
 *   chat_engine_trace_events.normalized_tokens is the responsibility of
 *   the Pipeline Orchestrator, not this module.
 * ------------------------------------------------------------
 */

// ============================================================
// Section A — Text normalization & fuzzy matching primitives
// (verbatim parity extraction from chatbot-engine.js v6)
// ============================================================

/**
 * Collapses 3+ repeated identical characters down to 1
 * (e.g. "طيوووول" -> "طيول") to absorb typing/emphasis noise
 * before normalization.
 * @param {string} text
 * @returns {string}
 */
export function collapseRepeatedChars(text) {
    return text.replace(/(.)\1{2,}/g, '$1');
}

/**
 * Normalizes Arabic (and mixed Arabic/Latin) text for matching:
 * lowercases, collapses repeated chars, strips tashkeel/tatweel,
 * unifies alef/ya/ta-marbuta/hamza variants, strips punctuation,
 * strips anything outside Arabic/Latin/digits/whitespace, collapses
 * whitespace.
 * @param {string} text
 * @returns {string} normalized text, or '' if input is falsy
 */
export function normalizeArabic(text) {
    if (!text) return '';
    let t = String(text).toLowerCase();
    t = collapseRepeatedChars(t);
    t = t
        .replace(/[\u064B-\u065F\u0670]/g, '')   // إزالة التشكيل
        .replace(/\u0640/g, '')                   // إزالة التطويل (ـــ)
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
 * Levenshtein edit distance between two strings.
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
 * Fuzzy word-level match tolerant of small typos.
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
 * Checks whether a (word or short phrase) pattern is present in an
 * already-normalized text, via exact substring match, single-word fuzzy
 * match, or order-independent fuzzy match of a 2-3 word phrase.
 * @param {string} normalizedText - text already run through normalizeArabic
 * @param {string} rawPattern - pattern; will be normalized internally
 * @returns {boolean}
 */
export function matchesPattern(normalizedText, rawPattern) {
    const pattern = normalizeArabic(rawPattern);
    if (!pattern) return false;
    if (normalizedText.includes(pattern)) return true;

    const patternWords = pattern.split(' ').filter(Boolean);
    const textWords = normalizedText.split(' ').filter(Boolean);

    if (patternWords.length === 1 && patternWords[0].length >= 4) {
        return textWords.some(w => fuzzyWordMatch(w, patternWords[0]));
    }
    if (patternWords.length >= 2 && patternWords.length <= 3) {
        return patternWords.every(pw =>
            textWords.some(tw => tw === pw || tw.includes(pw) || pw.includes(tw) || fuzzyWordMatch(tw, pw))
        );
    }
    return false;
}

/**
 * True if normalizedText matches any of the given raw patterns.
 * @param {string} normalizedText
 * @param {string[]} patterns
 * @returns {boolean}
 */
export function matchAny(normalizedText, patterns) {
    return patterns.some(p => matchesPattern(normalizedText, p));
}

// ============================================================
// Section B — Low-level intent pattern lists
// (verbatim parity extraction from chatbot-engine.js v6)
//
// Only the three low-level, non-diagnosis-relevant intents named
// explicitly in §8.1 are included: greeting, thanks, cancel.
// MENU_INQUIRY_PATTERNS / MENU_PROBLEM_PATTERNS and all topic-detection
// pattern lists (ticket status, subscription status, pricing, etc.) are
// diagnosis-relevant / domain content and are deliberately NOT part of
// this module — see file header note on detectCategory exclusion, same
// reasoning applies.
// ============================================================

export const DEFAULT_GREETING_PATTERNS = [
    'مرحبا', 'اهلا', 'هاي', 'هلا', 'السلام عليكم', 'صباح الخير', 'مساء الخير',
    'ezayak', 'ezayek', 'hi', 'hello', 'هاى', 'ايه الاخبار', 'ازيك', 'عامل ايه',
    'كيفك', 'شلونك', 'ايش اخبارك', 'هلابيك', 'يعطيك العافيه صباحا', 'صباح النور',
    'مساء النور', 'اخبارك ايه', 'ايه الاخبار يا معلم', 'تمام يا باشا'
];

export const THANKS_PATTERNS = [
    'شكرا', 'تسلم', 'مشكور', 'ربنا يخليك', 'thanks', 'thank you', 'يعطيك العافيه',
    'متشكر', 'الله يعافيك', 'يسلمو', 'مرسي', 'تسلم ايدك', 'الله يكرمك', 'ثانكس'
];

export const CANCEL_PATTERNS = [
    'الغاء', 'كانسل', 'cancel', 'سيب', 'بطل', 'مش عايز', 'رجعني', 'رجوع',
    'القائمه', 'الرئيسيه', 'رجعني للقائمه', 'back', 'menu', 'رجع تاني',
    'وقف كده', 'خلاص بطل', 'مش محتاج كده'
];

/**
 * @typedef {'greeting'|'thanks'|'cancel'|null} LowLevelIntent
 */

/**
 * Detects a low-level, non-diagnosis-relevant intent from already-
 * normalized text. Returns the FIRST matching intent in priority order
 * (cancel > thanks > greeting), or null if none match.
 *
 * Priority rationale: mirrors chatbot-engine.js's own check ordering,
 * where cancel is checked first/independently (available at any point
 * in the flow), before thanks/greeting are considered later in the
 * fallthrough. This module does not decide what happens as a result of
 * the intent — only reports it.
 *
 * @param {string} normalizedText
 * @returns {LowLevelIntent}
 */
export function detectLowLevelIntent(normalizedText) {
    if (!normalizedText) return null;
    if (matchAny(normalizedText, CANCEL_PATTERNS)) return 'cancel';
    if (matchAny(normalizedText, THANKS_PATTERNS)) return 'thanks';
    if (matchAny(normalizedText, DEFAULT_GREETING_PATTERNS)) return 'greeting';
    return null;
}

// ============================================================
// Section C — Module 1 public contract: normalize()
// ============================================================

/**
 * @typedef {Object} RawChatMessage
 * @property {string} text - Raw user message text.
 * @property {string} [imageUrl] - Presence indicates an attached image (chat_messages.image_url).
 * @property {string} [audioUrl] - Presence indicates an attached audio clip (chat_messages.audio_url).
 */

/**
 * @typedef {Object} NormalizedTokens
 * @property {string} raw_text - Original, unmodified (trimmed) input text ('' if none given).
 * @property {string} normalized_text - Cleaned/normalized text per normalizeArabic().
 * @property {string[]} tokens - normalized_text split into non-empty whitespace-delimited tokens.
 * @property {LowLevelIntent} low_level_intent - 'greeting' | 'thanks' | 'cancel' | null.
 * @property {{has_image: boolean, has_audio: boolean}} attachments - Attachment presence flags, not content.
 * @property {Object|null} prior_context - The priorNormalizedTokens argument, passed through unmodified
 *   for downstream modules that may want turn-over-turn context (e.g. repeated corrections). This module
 *   does not interpret it.
 */

/**
 * Module 1 entry point — the ONLY function that constitutes the
 * Normalization Layer's contract per §8.1.
 *
 * Pure function: no I/O, no side effects, no persistence. Given the same
 * inputs, always returns the same output (§7 Principle 2 — deterministic).
 *
 * @param {RawChatMessage} rawMessage
 * @param {NormalizedTokens|null} [priorNormalizedTokens] - Prior turn's
 *   normalized_tokens, if the orchestrator has one and it's relevant for
 *   context. Optional per §8.1 ("if relevant for context").
 * @returns {NormalizedTokens}
 */
export function normalize(rawMessage, priorNormalizedTokens = null) {
    const rawText = (rawMessage && typeof rawMessage.text === 'string') ? rawMessage.text.trim() : '';
    const normalizedText = normalizeArabic(rawText);
    const tokens = normalizedText ? normalizedText.split(' ').filter(Boolean) : [];
    const lowLevelIntent = detectLowLevelIntent(normalizedText);

    return {
        raw_text: rawText,
        normalized_text: normalizedText,
        tokens,
        low_level_intent: lowLevelIntent,
        attachments: {
            has_image: Boolean(rawMessage && rawMessage.imageUrl),
            has_audio: Boolean(rawMessage && rawMessage.audioUrl)
        },
        prior_context: priorNormalizedTokens || null
    };
}
