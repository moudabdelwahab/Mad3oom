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
 * MAX_CLARIFYING_QUESTIONS turns before escalating.
 *
 * Arabic-only by deliberate choice (MSA + Egyptian + Gulf/Khaleeji +
 * Levantine phrasing) — no English or Arabizi/Latin-script entries
 * here. sie/language/arabizi-map.local.js already owns Arabizi
 * transliteration as a normalization concern; duplicating that here
 * would just be a second, less-maintained copy of the same mapping.
 *
 * Covered categories, in priority/check order (first match wins):
 *  - human_request : an explicit ask to speak to a human agent.
 *  - frustration    : the customer is clearly frustrated with the bot
 *    itself (not describing a technical problem). Both of these route
 *    to a REAL escalation in sie-chat-bridge.js (an actual ticket/
 *    handoff gets created) rather than a plain canned reply — there is
 *    nothing left to "clarify" once someone says this.
 *  - identity       : "انت مين؟"
 *  - platform_info  : "مدعوم ايه؟" — general questions about the
 *    product itself, not an account-specific issue.
 *  - greeting       : "مرحبا"
 *  - farewell       : "شكرا" / "مع السلامة"
 *  - apology        : "معلش" / "اسف"
 *  - wellbeing      : "ازيك"
 *  - compliment     : "تمام كده حلو"
 *
 * Deliberately excluded on purpose: bare acknowledgments like "تمام" /
 * "أيوه" / "لأ" on their own are NOT covered here, even though they're
 * extremely common — the Decision Engine's own targetQuestion flow
 * relies on exactly these words as real evidence answers when it asks
 * the customer a yes/no discriminating question mid-diagnosis. Treating
 * them as small talk would silently swallow genuine diagnostic answers.
 *
 * Deliberately conservative, per category:
 *  - Each category has its OWN word-count cap (maxWords): a short
 *    message is very unlikely to also carry real diagnostic content,
 *    so short categories (greeting, farewell, wellbeing) stay tight,
 *    while human_request/platform_info allow a little more room since
 *    those phrasings tend to run a few words longer. A message over
 *    its category's cap is left completely untouched for the normal
 *    pipeline — this module never discards real diagnostic evidence.
 *  - Matching is plain substring inclusion (not regex): every entry is
 *    literal Arabic text, so this stays trivial to keep extending with
 *    more real phrases without needing to know regex syntax. Elongated
 *    spellings ("مرحبااا") still match their base phrase ("مرحبا")
 *    since it's a prefix of the elongated form.
 *  - Never inspects normalizedTokens or evidence — this runs before
 *    any of that, purely on the customer's raw text.
 */

const CATEGORIES = [
    {
        type: 'human_request',
        maxWords: 8,
        phrases: [
            'عايز اتكلم مع حد', 'عايزة اتكلم مع حد', 'عايزين نتكلم مع حد',
            'عايز اتكلم مع موظف', 'عايزة اتكلم مع موظف', 'عايز اتكلم مع شخص',
            'عايز اتكلم مع مسؤول', 'عايز اتكلم مع مدير', 'عايز حد يرد عليا',
            'عايزة حد يرد عليا', 'عايز حد يكلمني', 'عايز حد يساعدني بنفسه',
            'عايز موظف', 'عايزة موظف', 'عايز مسؤول', 'عايز مدير',
            'كلمني حد', 'كلموني حد', 'كلمني موظف', 'وصلني بموظف', 'وصلني بحد',
            'وصلني بمسؤول', 'حولني لموظف', 'حولني لحد', 'حولوني لموظف',
            'عايز دعم بشري', 'عايز فريق الدعم', 'عايز اكلم فريق الدعم',
            'فريق الدعم البشري', 'دعم بشري لو سمحت', 'مش عايز اكلم بوت',
            'مش عايزة اكلم بوت', 'مش عايز روبوت', 'بس انسان يرد',
            'حد حقيقي يرد', 'عايز اتكلم مع انسان', 'عايز اكلم واحد حقيقي',
            'ينفع اتكلم مع حد', 'ممكن اتكلم مع حد', 'ممكن اتكلم مع موظف',
            'حد يقدر يساعدني بنفسه', 'عايز خدمة عملاء', 'خدمة العملاء فين',
            'وينكم يا خدمة عملاء'
        ]
    },
    {
        type: 'frustration',
        maxWords: 6,
        phrases: [
            'انت غبي', 'غبي انت', 'انتي غبية', 'انت هبل', 'انتي هبلة',
            'انت مش فاهم', 'انتي مش فاهمة', 'مش فاهم حاجة', 'بتضيع وقتي',
            'ضيعت وقتي', 'زهقت منك', 'زهقت خالص', 'تعبت منك', 'تعبت معاك',
            'مفيش فايدة منك', 'ملكش لازمة', 'انت بايظ', 'انت مش بتفهم',
            'مش قادر تفهم', 'بلا فايدة', 'انت فاشل', 'خدمة زبالة',
            'بوت غبي', 'بوت فاشل', 'بلاش البوت ده'
        ]
    },
    {
        type: 'identity',
        maxWords: 6,
        phrases: [
            'انت مين', 'إنت مين', 'انتي مين', 'انتوا مين', 'مين انت', 'مين إنت',
            'من انت', 'من حضرتك', 'مين حضرتك', 'انت مين اصلا', 'انت مين بالظبط',
            'انت ايه', 'انت شنو', 'مين اللي بيرد', 'مين اللي بيكلمني',
            'مين اللي بكلمه', 'بكلم مين', 'بتكلم مين', 'مين اللي معايا',
            'مين معايا دلوقتي', 'انت بوت', 'انتي بوت', 'انتوا بوت', 'انت روبوت',
            'انتي روبوت', 'انت انسان', 'انتي انسانة', 'انت حقيقي', 'انتي حقيقية',
            'انت شخص حقيقي', 'هل انت بوت', 'هل انتي بوت', 'هل انت انسان',
            'هل انت حقيقي', 'بشتغل مع مين', 'بحكي مع مين', 'مين انت اصلا',
            'انت مساعد ولا مين', 'ده بوت ولا موظف'
        ]
    },
    {
        type: 'platform_info',
        maxWords: 8,
        phrases: [
            'مدعوم ايه', 'مدعوم ده ايه', 'مدعوم دي ايه', 'ايه هي مدعوم',
            'ايه هو مدعوم', 'ايه هو مدعوم بالظبط',
            'انتوا بتعملوا ايه', 'انتوا بتقدموا ايه', 'انتوا شركة ايه',
            'الخدمة دي بتعمل ايه', 'المنصة دي بتعمل ايه', 'الموقع ده بيعمل ايه',
            'بتشتغلوا ازاي', 'بتقدموا ايه بالظبط', 'تقدر تساعدني في ايه',
            'ممكن تساعدني في ايه', 'انت بتساعد في ايه', 'الشركة دي شغالة في ايه',
            'ايه هي الخدمة', 'عندكم ايه', 'بتوفروا ايه', 'ايه اللي بتقدموه',
            'ايه هي خدماتكم', 'ايه هي مميزات مدعوم', 'مدعوم بتساعد في ايه',
            'ليه استخدم مدعوم', 'ايه فايدة مدعوم', 'ازاي مدعوم بيشتغل',
            'احكيلي عن مدعوم', 'عرفني على مدعوم', 'وضحلي مدعوم ايه',
            'ايه هي خطط الاشتراك', 'عندكم باقات ايه'
        ]
    },
    {
        type: 'greeting',
        maxWords: 4,
        phrases: [
            'مرحبا', 'مرحبتين', 'مرحبا بيك', 'مرحبا بك', 'أهلا', 'اهلا',
            'أهلين', 'اهلين', 'أهلا وسهلا', 'اهلا وسهلا', 'هلا', 'هلا بيك',
            'هلا فيك', 'هلا والله', 'حياك', 'حياك الله', 'حياكم', 'حياكم الله',
            'يا هلا', 'يا هلا وغلا', 'يا مرحبا', 'يا اهلا', 'السلام عليكم',
            'السلام عليكم ورحمة الله', 'وعليكم السلام',
            'صباح الخير', 'صباح النور', 'صباحو', 'صباح الفل',
            'صباح الورد', 'صباح الخيرات', 'مساء الخير', 'مساء النور',
            'مسا الخير', 'مسا النور', 'مساء الفل', 'تصبح على خير',
            'تصبحوا على خير', 'هاي', 'هلو', 'هالو', 'يا هلا فيك',
            'يا مرحبا بيك', 'صباح جميل', 'يوم سعيد', 'صباح النشاط',
            'كيفكم اليوم', 'نورت', 'نورتونا', 'تشرفنا', 'مرحبا اخي',
            'مرحبا اختي', 'حياك ياغالي', 'هلا بالغالي', 'يا مرحبتين',
            'يا هلا ومية هلا'
        ]
    },
    {
        type: 'farewell',
        maxWords: 4,
        phrases: [
            'شكرا', 'شكراً', 'شكرا جزيلا', 'شكرا كتير', 'شكرا ليك',
            'شكرا لحضرتك', 'الف شكر', 'الف شكر ليك', 'متشكر', 'متشكرة',
            'متشكرين', 'تسلم', 'تسلم ايدك', 'تسلم ايديك', 'يسلمو',
            'يسلمو ايدك', 'يعطيك العافية', 'الله يعطيك العافية', 'الله يخليك',
            'ربنا يخليك', 'الله يعافيك', 'يعطيك الصحة', 'مشكور', 'مشكورة',
            'مشكورين', 'مأجور', 'جزاك الله خير', 'جزاكم الله خير',
            'بارك الله فيك', 'بارك الله فيكم', 'تمام كده شكرا', 'ماشي شكرا',
            'اوكي شكرا', 'حلو شكرا', 'تسلم يا غالي', 'تسلملي', 'ربنا يكرمك',
            'الله يكرمك', 'كتر خيرك', 'كثر خيرك', 'من عيوني', 'تحت امرك',
            'لا شكر على واجب', 'العفو', 'مع السلامة', 'مع السلامه',
            'في امان الله', 'بأمان الله', 'الله معاك', 'الله معاكم',
            'باي', 'باي باي', 'وداعا', 'الى اللقاء', 'نتقابل بعدين',
            'اشوفك بعدين', 'نراكم قريبا', 'دمتم بخير', 'يعافيك ربي',
            'تسلم يمينك', 'ماشالله عليك', 'ربنا يوفقك', 'بالتوفيق',
            'تحياتي', 'مع تحياتي'
        ]
    },
    {
        type: 'apology',
        maxWords: 4,
        phrases: [
            'اسف', 'آسف', 'اسفة', 'آسفة', 'اسفين', 'معلش', 'معلش يعني',
            'معذرة', 'عذرا', 'عذراً', 'سامحني', 'سامحيني', 'سامحونا',
            'اعتذر', 'بعتذر', 'بنعتذر', 'معليش', 'ماشي معلش', 'حصل خير',
            'لا مؤاخذة'
        ]
    },
    {
        type: 'wellbeing',
        maxWords: 4,
        phrases: [
            'ازيك', 'ازيك انت', 'ازيكم', 'ازيك عامل ايه', 'عامل ايه',
            'عاملة ايه', 'عاملين ايه', 'اخبارك ايه', 'اخبارك', 'شو اخبارك',
            'شو الاخبار', 'ايه الاخبار', 'كيفك', 'كيفك انت', 'كيفكم',
            'كيف حالك', 'كيف حالكم', 'كيف الحال', 'شلونك', 'شلونك انت',
            'شلونكم', 'شخبارك', 'شخبارك انت', 'وينك', 'وين انت', 'وينكم',
            'انت طيب', 'انتي طيبة', 'صحتك ايه', 'احوالك ايه', 'ايه احوالك',
            'حالك ايه', 'امورك ماشية'
        ]
    },
    {
        type: 'compliment',
        maxWords: 4,
        phrases: [
            'جامد', 'برافو', 'تمام كده حلو', 'شغلك حلو', 'حلو اوي',
            'ممتاز', 'رائع', 'تمام قوي', 'حلو كده', 'شاطر', 'ما شاء الله عليك',
            'احسنت', 'عاش', 'فنان'
        ]
    }
];

/**
 * @param {string} rawText - the customer's raw message, before normalization
 * @returns {{ type: 'human_request'|'frustration'|'identity'|'platform_info'|'greeting'|'farewell'|'apology'|'wellbeing'|'compliment' } | null}
 */
export function detectSmallTalk(rawText) {
    const text = String(rawText || '').trim();
    if (!text) return null;

    const wordCount = text.split(/\s+/).filter(Boolean).length;

    for (const category of CATEGORIES) {
        if (wordCount > category.maxWords) continue;
        if (category.phrases.some((phrase) => text.includes(phrase))) return { type: category.type };
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
 * human_request and frustration have no entries here: sie-chat-bridge.js
 * routes both into a real ESCALATE_TO_HUMAN Decision (not a plain
 * WAIT_FOR_USER reply), with their own text kept next to that flow in
 * sie-chat-bridge.js instead of duplicated here.
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
    apology: {
        ar: 'معلش، مفيش داعي تعتذر! أنا هنا عشان أساعدك — كمل معايا [[icon:smile]]',
        en: "No worries at all, no need to apologize! I'm here to help — go ahead [[icon:smile]]"
    },
    wellbeing: {
        ar: 'تمام الحمد لله، شكرًا لسؤالك! تحب أساعدك في مشكلة معينة؟ [[icon:smile]]',
        en: "I'm doing well, thanks for asking! Is there something I can help you with? [[icon:smile]]"
    },
    compliment: {
        ar: 'شكرًا ليك! سعيد إني قدرت أساعدك. محتاج حاجة تانية؟ [[icon:smile]]',
        en: "Thank you! Glad I could help. Anything else you need? [[icon:smile]]"
    }
};
