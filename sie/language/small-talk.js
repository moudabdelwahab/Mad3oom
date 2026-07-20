/**
 * small-talk.js
 * ------------------------------------------------------------
 * Recognizes short, self-contained conversational moves that carry no
 * diagnostic content of their own, so sie-chat-bridge.js can answer
 * them directly instead of routing them through the full Language ->
 * Diagnostics -> Ranking -> Decision pipeline.
 *
 * Why this exists: none of these words appear in the technical
 * glossary or any scenario's evidence signature, so they never produce
 * a confident hypothesis. Before this module existed, every one of
 * them fell through to the Decision Engine's generic
 * ASK_CLARIFYING_QUESTION — the exact same static text every time,
 * completely ignoring what the customer actually said, for up to
 * MAX_CLARIFYING_QUESTIONS turns before escalating. This started with
 * just greetings and "who are you", and is deliberately kept broad and
 * growing: every basic, everyday exchange that has nothing to do with
 * a real technical problem belongs here, not in the diagnostic budget.
 *
 * Covered categories, in priority/check order (first match wins):
 *  - human_request : an explicit ask to speak to a human agent. This
 *    one is NOT a simple canned reply — sie-chat-bridge.js routes it
 *    into a REAL escalation (an actual ticket/handoff gets created),
 *    since the customer already told us what they want; there is
 *    nothing to "clarify" first.
 *  - identity       : "انت مين؟" / "are you a bot?"
 *  - platform_info  : "مدعوم ايه؟" / "what do you do?" — general
 *    questions about the product itself, not an account-specific issue.
 *  - greeting       : "مرحبا" / "hi"
 *  - farewell       : "شكرا" / "thanks" / "bye"
 *  - wellbeing      : "ازيك" / "how are you"
 *
 * Deliberately conservative, per category:
 *  - Each category has its OWN word-count cap (maxWords): a short
 *    message is very unlikely to also carry real diagnostic content,
 *    so short categories (greeting, farewell, wellbeing) stay tight,
 *    while human_request/platform_info allow a little more room since
 *    those phrasings tend to run a few words longer. A message over
 *    its category's cap is left completely untouched for the normal
 *    pipeline — this module never discards real diagnostic evidence.
 *  - Patterns test for the phrase appearing in the message, not an
 *    exact full-string match, so natural variations ("انا بسالك انت
 *    مين") are still caught within the word-count guard.
 *  - Never inspects normalizedTokens or evidence — this runs before
 *    any of that, purely on the customer's raw text.
 */

const CATEGORIES = [
    {
        type: 'human_request',
        maxWords: 8,
        patterns: [
            /عايز(ة)?\s*(اتكلم|أتكلم)\s*مع\s*(حد|موظف|إنسان|انسان|شخص)/,
            /عايز(ة)?\s*(موظف|مسؤول|حد يرد)/,
            /(كلمني|حولني|وصلني)\s*(حد|بموظف|بشخص)/,
            /دعم\s*بشري/, /فريق\s*الدعم\s*البشري/,
            /\btalk\s*to\s*a?\s*(human|agent|person|representative)\b/i,
            /\bhuman\s*support\b/i, /\breal\s*person\b/i, /\bspeak\s*to\s*(a\s*)?(human|agent)\b/i
        ]
    },
    {
        type: 'identity',
        maxWords: 6,
        patterns: [
            /(انت|إنت|انتي)\s*مين/, /(مين|من)\s*(انت|حضرتك)/, /انت\s*(بوت|روبوت|إنسان)/,
            /who\s*are\s*you/i, /are\s*you\s*a?\s*bot/i
        ]
    },
    {
        type: 'platform_info',
        maxWords: 8,
        patterns: [
            /مدعوم\s*(ده|دي)?\s*(ايه|إيه|عامل ايه)/, /ايه\s*(هي|هو)\s*مدعوم/,
            /انتوا\s*(بتعملوا|بتقدموا)\s*ايه/, /(الخدمة|المنصة)\s*دي\s*بتعمل\s*ايه/,
            /بتشتغلوا\s*ازاي/, /تقدر\s*تساعدني\s*في\s*ايه/,
            /\bwhat\s*is\s*mad3oom\b/i, /\bwhat\s*do\s*you\s*do\b/i, /\bwhat\s*can\s*you\s*help\b/i
        ]
    },
    {
        type: 'greeting',
        maxWords: 4,
        patterns: [
            /مرحبا+/, /اهلا+/, /أهلا+/, /هلا+/, /السلام عليكم/, /صباح الخير/, /مساء الخير/,
            /\bhi\b/i, /\bhello\b/i, /\bhey\b/i, /good morning/i, /good evening/i
        ]
    },
    {
        type: 'farewell',
        maxWords: 4,
        patterns: [
            /شكرا+/, /متشكر/, /تسلم/, /الله يخليك/, /يعطيك العافية/,
            /مع السلامة/, /باي\b/,
            /\bthanks?\b/i, /\bthank\s*you\b/i, /\bthx\b/i, /\bbye\b/i, /\bgoodbye\b/i
        ]
    },
    {
        type: 'wellbeing',
        maxWords: 4,
        patterns: [
            /از[يى]ك/, /عامل(ة)?\s*ايه/, /اخبارك\s*ايه/, /كيفك/,
            /\bhow\s*are\s*you\b/i
        ]
    }
];

/**
 * @param {string} rawText - the customer's raw message, before normalization
 * @returns {{ type: 'human_request'|'identity'|'platform_info'|'greeting'|'farewell'|'wellbeing' } | null}
 */
export function detectSmallTalk(rawText) {
    const text = String(rawText || '').trim();
    if (!text) return null;

    const wordCount = text.split(/\s+/).filter(Boolean).length;

    for (const category of CATEGORIES) {
        if (wordCount > category.maxWords) continue;
        if (category.patterns.some((p) => p.test(text))) return { type: category.type };
    }
    return null;
}

/**
 * Bilingual canned replies for each detected small-talk type. Kept here
 * (not in sie/dialogue/templates/) since these never go through
 * renderDecision()/a Decision object at all — sie-chat-bridge.js uses
 * them directly in its short-circuit, the same way it already does for
 * TICKET_CONFIRM_TEXT/TICKET_DECLINE_TEXT.
 *
 * human_request has no entry here: sie-chat-bridge.js's escalation
 * short-circuit uses its own message (it's a real ESCALATE_TO_HUMAN
 * Decision, not a plain WAIT_FOR_USER reply), kept next to the rest of
 * that flow in sie-chat-bridge.js instead of duplicated here.
 */
export const SMALL_TALK_REPLIES = {
    identity: {
        ar: 'أنا المساعد الآلي بتاع مدعوم، وهساعدك تحل أي مشكلة تقنية أو استفسار عن حسابك. وضّحلي المشكلة اللي حضرتك واجهتها ونكمل [[icon:smile]]',
        en: "I'm Mad3oom's automated support assistant, and I can help with technical issues or questions about your account. What's going on? [[icon:smile]]"
    },
    platform_info: {
        ar: 'مدعوم منصة بتساعد الشركات تدير خدمة العملاء والواتساب بتاعها في مكان واحد، وأنا المساعد الآلي بتاعها بجاوب على استفساراتك التقنية. عندك مشكلة معينة تحب أساعدك فيها؟ [[icon:smile]]',
        en: "Mad3oom is a platform that helps businesses manage their customer support and WhatsApp in one place, and I'm its automated assistant for technical questions. Is there a specific issue I can help you with? [[icon:smile]]"
    },
    greeting: {
        ar: 'أهلاً بيك! أنا هنا عشان أساعدك في أي مشكلة تقنية أو استفسار عن مدعوم — قولّي التفاصيل وهساعدك [[icon:smile]]',
        en: "Hi there! I'm here to help with any technical issue or question about Mad3oom — tell me what's going on and I'll help [[icon:smile]]"
    },
    farewell: {
        ar: 'العفو! لو احتجت أي حاجة تانية أنا موجود في أي وقت [[icon:smile]]',
        en: "You're welcome! I'm here anytime you need anything else [[icon:smile]]"
    },
    wellbeing: {
        ar: 'تمام الحمد لله، شكرًا لسؤالك! تحب أساعدك في مشكلة معينة؟ [[icon:smile]]',
        en: "I'm doing well, thanks for asking! Is there something I can help you with? [[icon:smile]]"
    }
};
