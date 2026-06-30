/**
 * chatbot-engine.js
 * ------------------------------------------------------------
 * محرك رد آلي محلي 100% (مفيش أي اتصال بموديل ذكاء اصطناعي خارجي).
 * بيتعرف على نية العميل (ترحيب / سؤال عن الاشتراكات / مشكلة) من خلال
 * مطابقة كلمات مفتاحية بالعامية المصرية والفصحى، وبيدير "فلو" بسيط
 * (state machine) لجمع بيانات المشكلة وفتح تذكرة في جدول tickets.
 *
 * مصمم عشان يتركب بسهولة جوه chat-logic.js مكان نداء huggingface-chatbot.
 *
 * إزاي تضيف موديل لاحقًا (اختياري):
 *   - فعّل bot_settings.ai_enabled = true
 *   - في الفانكشن getBotReply تحت، لو محصلش تطابق محلي (fallback) وكان
 *     ai_enabled = true، نادي الـ Edge Function بتاعتك (huggingface-chatbot
 *     أو أي حاجة تانية) وارجع ردها بدل رسالة الـ fallback المحلية.
 *     مكان الإضافة متعلّم بكومنت "MODEL_HOOK" تحت.
 * ------------------------------------------------------------
 */

// ===================== تطبيع النص العربي (للمطابقة فقط) =====================
function normalizeArabic(text) {
    if (!text) return '';
    return String(text)
        .toLowerCase()
        .replace(/[\u064B-\u065F\u0670]/g, '')   // إزالة التشكيل
        .replace(/[إأآا]/g, 'ا')
        .replace(/ى/g, 'ي')
        .replace(/ة/g, 'ه')
        .replace(/ؤ/g, 'و')
        .replace(/ئ/g, 'ي')
        .replace(/[^\u0600-\u06FFa-z0-9\s]/g, ' ') // شيل علامات الترقيم
        .replace(/\s+/g, ' ')
        .trim();
}

function matchAny(normalizedText, patterns) {
    return patterns.some(p => normalizedText.includes(normalizeArabic(p)));
}

// ===================== الكلمات المفتاحية الافتراضية =====================
const DEFAULT_GREETING_PATTERNS = [
    'مرحبا', 'اهلا', 'هاي', 'هلا', 'السلام عليكم', 'صباح الخير', 'مساء الخير',
    'ezayak', 'ezayek', 'hi', 'hello', 'هاى', 'هاي فيه', 'تمام', 'ايه الاخبار'
];

const THANKS_PATTERNS = [
    'شكرا', 'تسلم', 'مشكور', 'ربنا يخليك', 'thanks', 'thank you', 'يعطيك العافيه', 'متشكر'
];

const CANCEL_PATTERNS = ['الغاء', 'كانسل', 'cancel', 'سيب', 'بطل', 'مش عايز', 'رجعني'];

const DEFAULT_PROBLEM_PATTERNS = [
    'مشكله', 'عطل', 'مش شغال', 'بلاغ', 'شكوي', 'معطل', 'واقف', 'مش عامل',
    'مش بيشتغل', 'فيه خطا', 'في خطأ', 'error', 'bug', 'problem', 'issue',
    'مش راضي يفتح', 'علق', 'هانج', 'بطئ', 'بطيء', 'مش بيرد'
];

const PRICING_GENERAL_PATTERNS = [
    'اسعار', 'الاسعار', 'سعر', 'الخطط', 'الباقات', 'اشتراك', 'اشتراكات',
    'فلوس', 'تكلفه', 'price', 'pricing', 'plan', 'plans', 'كام', 'بكام'
];

const PLAN_FREE_PATTERNS = ['مجاني', 'مجانا', 'فري', 'free', 'بدون مقابل'];
const PLAN_SUPPORT_PATTERNS = ['دعم فني', 'خطه الدعم', 'تذاكر فقط', 'support plan', 'تيكتس'];
const PLAN_WHATSAPP_PATTERNS = ['واتساب', 'whatsapp', 'وتساب', 'واتس'];
const PLAN_BUNDLE_PATTERNS = ['باقه', 'الباقه الشامله', 'bundle', 'الاتنين', 'دعم وواتساب', 'كومبو', 'الشامله'];
const DISCOUNT_PATTERNS = ['خصم', 'عرض', 'تخفيض', 'offer', 'discount', 'عروض'];
const ENTERPRISE_PATTERNS = ['شركات', 'شركه', 'enterprise', 'مؤسسه', 'بيزنس'];
const COMPARE_PATTERNS = ['فرق', 'مقارنه', 'ايه الفرق', 'بين الخطط', 'compare'];

// ===================== ردود الاشتراكات (من صفحة subscriptions.html) =====================
const PLAN_TEXT = {
    free: `الخطة المجانية 🆓 من غير ما تدفع ولا جنيه:
• نظام تذاكر أساسي
• محادثة مع الدعم في ساعات العمل
• تقدر تبلغ عن أي مشكلة
• بتجمع نقاط على كل بلاغ
متاحة دايمًا من غير ما تنتهي. تحب تبدأ بيها؟`,

    support: `خطة "الدعم الفني" 🛠️ بـ 15$/شهر بدل 25$ (خصم 40%)، أو 150$/سنة بدل 180$ (خصم 17%):
• تذاكر دعم غير محدودة يوميًا
• نطاق فرعي مجاني زي company.mad3oom.online
• مدير واحد + لغاية 25 عضو
• إحصائيات متقدمة وسجل نشاط للفريق
عرض الإطلاق ده لفترة محدودة 😉`,

    whatsapp: `خطة "واتساب" 💬 بـ 20$/شهر بدل 30$ (خصم 33%)، أو 200$/سنة بدل 240$ (خصم 17%):
• تربط رقم الواتساب بتاعك بالمنصة
• تستقبل وترد على رسائل العملاء من لوحة التحكم
• إشعارات فورية بأي رسالة جديدة
• تقدر تضيف خدمة الرد الآلي بعدين
وكمان لو اشتركت بالرد الآلي مع الخطة الشهرية بتاخد 14 يوم إضافي مجانًا، أو 3 شهور زيادة لو سنوي 🎁`,

    bundle: `الباقة الشاملة "دعم فني + واتساب" 🚀 وهي الأكتر توفيرًا، بـ 30$/شهر بدل 55$ (خصم 45%)، أو 330$/سنة بدل 660$ (خصم 50%):
• كل مميزات الدعم الفني + الواتساب مع بعض
• دعم أولوية 24/7
• نقاط مكافآت مضاعفة
• شارة خاصة على بروفايلك
دي أفضل قيمة لو محتاج الخدمتين سوا.`,

    enterprise: `بالنسبة للشركات 🏢 عندنا خطط مخصصة (مستخدمين مش محدودين، دعم مخصص 24/7، API وتكامل مع أنظمتك، SLA لضمان وقت التشغيل). التفاصيل والأسعار هيتم الإعلان عنها قريبًا، تحب أفتحلك تذكرة عشان فريق المبيعات يتواصل معاك؟`,

    compare: `هاديلك خلاصة سريعة:
🆓 مجاني: تذاكر أساسية بس + دعم في ساعات العمل
🛠️ دعم فني (15$/شهر): تذاكر غير محدودة + نطاق فرعي + فريق لغاية 25 عضو
💬 واتساب (20$/شهر): ربط رقم واتساب بالمنصة بس من غير نظام تذاكر
🚀 الباقة الشاملة (30$/شهر): كل حاجة مع بعض + أولوية 24/7 + شارة خاصة وأفضل توفير
تحب أديك تفاصيل خطة معينة؟`,

    general: `عندنا 4 خطط 👇
🆓 مجاني — 0$
🛠️ الدعم الفني — 15$/شهر (بدل 25$)
💬 واتساب — 20$/شهر (بدل 30$)
🚀 دعم فني + واتساب (الأشمل) — 30$/شهر (بدل 55$، أكبر خصم وأوفر باقة)
كله متاح شهري أو سنوي بخصم إضافي. تحب أفصّلك خطة معينة؟`
};

// ===================== التعامل مع نية الاشتراكات =====================
function getPricingReply(normalizedText) {
    if (matchAny(normalizedText, ENTERPRISE_PATTERNS)) return PLAN_TEXT.enterprise;
    if (matchAny(normalizedText, COMPARE_PATTERNS)) return PLAN_TEXT.compare;
    if (matchAny(normalizedText, PLAN_BUNDLE_PATTERNS)) return PLAN_TEXT.bundle;
    if (matchAny(normalizedText, PLAN_WHATSAPP_PATTERNS)) return PLAN_TEXT.whatsapp;
    if (matchAny(normalizedText, PLAN_SUPPORT_PATTERNS)) return PLAN_TEXT.support;
    if (matchAny(normalizedText, PLAN_FREE_PATTERNS)) return PLAN_TEXT.free;
    if (matchAny(normalizedText, DISCOUNT_PATTERNS)) {
        return `عروض الإطلاق الحالية 🔥 (سارية 6 شهور أو لحد ما نوصل لعدد العملاء المستهدف):
• الدعم الفني: خصم 40% شهري / 17% سنوي
• واتساب: خصم 33% شهري / 17% سنوي
• الباقة الشاملة: خصم 45% شهري / 50% سنوي (أكبر خصم!)
تحب أديك تفاصيل خطة معينة؟`;
    }
    if (matchAny(normalizedText, PRICING_GENERAL_PATTERNS)) return PLAN_TEXT.general;
    return null;
}

// ===================== الفلو الخاص بفتح تذكرة =====================
const TICKET_TITLE_PROMPT = 'تمام، اديني عنوان مختصر للمشكلة في كلمة أو اتنين 📝';
const TICKET_DESC_PROMPT = 'تمام كده، دلوقتي اشرحلي المشكلة بالتفصيل عشان فريق الدعم يقدر يساعدك بسرعة 🔍';
const TICKET_CANCELLED_MSG = 'تمام، إلغينا فتح التذكرة. لو احتجت تفتح بلاغ تاني قولي "عندي مشكلة" في أي وقت 🙂';

async function createTicket({ supabase, userId, title, description }) {
    const { data, error } = await supabase
        .from('tickets')
        .insert({
            user_id: userId,
            title: title?.slice(0, 200) || 'مشكلة من الشات',
            description: description || title || '',
            status: 'open',
            priority: 'medium'
        })
        .select('ticket_number')
        .single();

    if (error) {
        console.error('خطأ في إنشاء التذكرة من البوت:', error);
        return { ok: false };
    }
    return { ok: true, ticketNumber: data?.ticket_number };
}

async function saveBotState(supabase, sessionId, newState) {
    await supabase.from('chat_sessions').update({ bot_state: newState }).eq('id', sessionId);
}

// ===================== نقطة الدخول الرئيسية =====================
/**
 * @param {Object} params
 * @param {string} params.text - رسالة العميل
 * @param {Object} params.supabase - supabase client
 * @param {string} params.sessionId - معرف جلسة الشات
 * @param {string} params.userId - معرف العميل
 * @param {Object} params.botState - bot_state الحالي من chat_sessions (كائن JSON)
 * @param {Object} params.botSettings - صف bot_settings (ممكن يكون null)
 * @returns {Promise<{reply: string, ticketCreated?: boolean, ticketNumber?: number}>}
 */
export async function getBotReply({ text, supabase, sessionId, userId, botState, botSettings }) {
    const raw = (text || '').trim();
    const normalized = normalizeArabic(raw);
    const state = botState && typeof botState === 'object' ? { ...botState } : {};
    const problemPatterns = (botSettings?.trigger_keywords?.length ? botSettings.trigger_keywords : DEFAULT_PROBLEM_PATTERNS);
    const greetingPatterns = DEFAULT_GREETING_PATTERNS;

    // ---------- 1) لو العميل جوه فلو فتح تذكرة ----------
    if (state.flow === 'awaiting_ticket_title' || state.flow === 'awaiting_ticket_desc') {
        if (matchAny(normalized, CANCEL_PATTERNS)) {
            state.flow = 'idle';
            state.ticket_draft = {};
            await saveBotState(supabase, sessionId, state);
            return { reply: TICKET_CANCELLED_MSG };
        }

        if (state.flow === 'awaiting_ticket_title') {
            state.ticket_draft = { title: raw };
            state.flow = 'awaiting_ticket_desc';
            await saveBotState(supabase, sessionId, state);
            return { reply: TICKET_DESC_PROMPT };
        }

        if (state.flow === 'awaiting_ticket_desc') {
            const title = state.ticket_draft?.title || raw.slice(0, 60);
            const result = await createTicket({ supabase, userId, title, description: raw });
            state.flow = 'idle';
            state.ticket_draft = {};
            await saveBotState(supabase, sessionId, state);

            if (!result.ok) {
                return { reply: 'حصل خطأ بسيط وإحنا بنفتح التذكرة، حاول تاني كمان شوية أو تواصل معانا مباشرة 🙏' };
            }
            const baseMsg = botSettings?.ticket_message || 'تم فتح تذكرة دعم فني وسيقوم فريقنا بالرد عليك في أقرب وقت.';
            const reply = result.ticketNumber
                ? `${baseMsg} رقم التذكرة بتاعتك هو #${result.ticketNumber} ✅`
                : `${baseMsg} ✅`;
            return { reply, ticketCreated: true, ticketNumber: result.ticketNumber };
        }
    }

    // ---------- 2) لو العميل بيبلغ عن مشكلة (بداية الفلو) ----------
    if (matchAny(normalized, problemPatterns)) {
        state.flow = 'awaiting_ticket_title';
        state.ticket_draft = {};
        await saveBotState(supabase, sessionId, state);
        return { reply: TICKET_TITLE_PROMPT };
    }

    // ---------- 3) سؤال عن الاشتراكات / الأسعار ----------
    const pricingReply = getPricingReply(normalized);
    if (pricingReply) {
        return { reply: pricingReply };
    }

    // ---------- 4) شكر ----------
    if (matchAny(normalized, THANKS_PATTERNS)) {
        return { reply: 'العفو يا فندم، إحنا موجودين لو احتجت أي حاجة تانية 🌟' };
    }

    // ---------- 5) ترحيب (مرة واحدة بس لكل جلسة) ----------
    if (matchAny(normalized, greetingPatterns) && !state.greeted) {
        state.greeted = true;
        await saveBotState(supabase, sessionId, state);
        const welcome = botSettings?.welcome_message || 'أهلاً بيك في منصة مدعوم! 👋';
        return { reply: `${welcome} تحب أساعدك إزاي؟ تقدر تسألني عن الاشتراكات والأسعار 💳، أو لو عندك مشكلة تقنية قولّي وهافتحلك تذكرة فورًا 🛠️` };
    }
    if (matchAny(normalized, greetingPatterns) && state.greeted) {
        return { reply: 'أهلاً بيك تاني 👋 تحب تسأل عن الاشتراكات ولا عندك مشكلة تقنية؟' };
    }

    // ---------- 6) MODEL_HOOK (اختياري) ----------
    // لو حبيت تضيف موديل لاحقًا، فعّل الشرط ده وحط نداء الـ Edge Function هنا
    // بدل رسالة الـ fallback تحت.
    // if (botSettings?.ai_enabled) {
    //     const aiReply = await callExternalModel(raw, { sessionId, userId });
    //     if (aiReply) return { reply: aiReply };
    // }

    // ---------- 7) رد افتراضي ----------
    if (!state.greeted) {
        state.greeted = true;
        await saveBotState(supabase, sessionId, state);
    }
    return {
        reply: 'مش متأكد إني فهمتك صح 🙏 تقدر تسألني عن الاشتراكات والأسعار، أو تكتب "عندي مشكلة" وهافتحلك تذكرة فورًا مع فريق الدعم.'
    };
}
