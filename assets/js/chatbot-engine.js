/**
 * chatbot-engine.js (v3)
 * ------------------------------------------------------------
 * محرك رد آلي محلي 100% (من غير أي اتصال بموديل ذكاء اصطناعي خارجي).
 *
 * التحديثات في النسخة دي:
 * 1) قائمة اختيارات رئيسية (📝 استفسار / 🛠️ مشكلة) بتتعرض كأزرار تحت رسالة
 *    البوت، وبرضه العميل يقدر يكتبها بإيده في أي وقت.
 * 2) فلو "استفسار": العميل يكتب سؤاله بحرية، والبوت يحاول يتعرف عليه من
 *    مواضيع معروفة عنده (اشتراكات/أسعار/حالة تذكرة/حالة اشتراك/معلومات عن
 *    المنصة...). لو الموضوع معروف بيرد على طول. لو مش عارف الموضوع خالص،
 *    بيطلب بيانات تواصل ويفتح "تذكرة استفسار" (ticket_type = inquiry).
 * 3) فلو "مشكلة": خطوة واحدة بس (وصف المشكلة) وبعدها بيفتح "تذكرة مشكلة"
 *    (ticket_type = problem).
 * 4) فهم أوسع للعامية: تطبيع أشمل + تجميع الحروف المكررة + مرادفات لهجات
 *    مختلفة (مصري/خليجي/شامي) + مصطلحات إنجليزي مختلطة.
 *
 * ⚠️ ملحوظة مهمة عن "نسبة التأكد":
 * البوت ده rule-based (كلمات مفتاحية) مش موديل ذكاء اصطناعي حقيقي، فمفيش
 * نسبة ثقة حسابية زي الموديلات. اللي بيحصل عمليًا: لو الرسالة اتطابقت مع
 * أي موضوع من المواضيع المعروفة عند البوت (detectKnownTopic) بيُعتبر
 * "متأكد" ويرد على طول. لو مفيش تطابق مع أي موضوع معروف خالص، بيُعتبر "مش
 * متأكد" ويحوّل العميل لفلو جمع بيانات التواصل وفتح تذكرة استفسار.
 *
 * أمان البيانات:
 * - كل استعلام بيتفلتر صراحةً بـ user_id بتاع صاحب الجلسة (دفاع إضافي فوق
 *   الـ RLS في قاعدة البيانات اللي أصلاً بيمنع أي عميل يشوف بيانات غيره).
 * - الوصول الكامل والتعديل محصور فعليًا على support@mad3oom.online و
 *   info@mad3oom.online على مستوى قاعدة البيانات نفسها (is_main_admin()).
 *
 * إزاي تضيف موديل لاحقًا (اختياري):
 *   فعّل bot_settings.ai_enabled، وفي مكان "MODEL_HOOK" تحت نادي الـ
 *   Edge Function بتاعتك وارجع ردها بدل رسالة الـ fallback المحلية.
 * ------------------------------------------------------------
 */

// ===================== تطبيع النص العربي (للمطابقة فقط) =====================
function collapseRepeatedChars(text) {
    // "تمااااام" -> "تمام" / "ايوهههه" -> "ايوه" .. بيسهّل مطابقة الكلمات
    // اللي العميل بيكتبها بمط في الحروف من غير ما يأثر على الكلام العادي.
    return text.replace(/(.)\1{2,}/g, '$1');
}

function normalizeArabic(text) {
    if (!text) return '';
    let t = String(text).toLowerCase();
    t = collapseRepeatedChars(t);
    t = t
        .replace(/[\u064B-\u065F\u0670]/g, '')   // إزالة التشكيل
        .replace(/[إأآا]/g, 'ا')
        .replace(/ى/g, 'ي')
        .replace(/ة/g, 'ه')
        .replace(/ؤ/g, 'و')
        .replace(/ئ/g, 'ي')
        .replace(/[^\u0600-\u06FFa-z0-9\s]/g, ' ') // شيل علامات الترقيم
        .replace(/\s+/g, ' ')
        .trim();
    return t;
}

function matchAny(normalizedText, patterns) {
    return patterns.some(p => normalizedText.includes(normalizeArabic(p)));
}

// ===================== قائمة الاختيارات الرئيسية =====================
export const MAIN_MENU_OPTIONS = [
    { label: '📝 عندي استفسار', value: 'عندي استفسار' },
    { label: '🛠️ عندي مشكلة', value: 'عندي مشكلة' }
];

export const CANCEL_OPTIONS = [
    { label: '❌ إلغاء والرجوع للقائمة', value: 'الغاء' }
];

/**
 * بيرجع الأزرار المناسبة لعرضها حسب حالة الفلو الحالية (للاستخدام في الواجهة
 * لو حابب تعرض الأزرار بعد إعادة تحميل الصفحة من غير ما تبعت رسالة جديدة).
 */
export function getOptionsForFlow(flow) {
    if (flow === 'awaiting_inquiry_text' || flow === 'awaiting_contact_info' || flow === 'awaiting_problem_desc') {
        return CANCEL_OPTIONS;
    }
    return MAIN_MENU_OPTIONS;
}

// ===================== الكلمات المفتاحية =====================
const DEFAULT_GREETING_PATTERNS = [
    'مرحبا', 'اهلا', 'هاي', 'هلا', 'السلام عليكم', 'صباح الخير', 'مساء الخير',
    'ezayak', 'ezayek', 'hi', 'hello', 'هاى', 'ايه الاخبار', 'ازيك', 'عامل ايه',
    'كيفك', 'شلونك', 'ايش اخبارك'
];

const THANKS_PATTERNS = [
    'شكرا', 'تسلم', 'مشكور', 'ربنا يخليك', 'thanks', 'thank you', 'يعطيك العافيه',
    'متشكر', 'الله يعافيك', 'يسلمو', 'مرسي'
];

const CANCEL_PATTERNS = [
    'الغاء', 'كانسل', 'cancel', 'سيب', 'بطل', 'مش عايز', 'رجعني', 'رجوع',
    'القائمه', 'الرئيسيه', 'رجعني للقائمه', 'back', 'menu'
];

const MENU_INQUIRY_PATTERNS = [
    'عندي استفسار', 'استفسار', 'سؤال', 'عايز اسال', 'حابب اسال', 'question', '1'
];

const MENU_PROBLEM_PATTERNS = [
    'عندي مشكله', 'مشكله', 'عطل', 'مش شغال', 'بلاغ', 'شكوي', 'معطل', 'واقف',
    'مش عامل', 'مش بيشتغل', 'فيه خطا', 'في خطأ', 'error', 'bug', 'problem',
    'issue', 'مش راضي يفتح', 'علق', 'هانج', 'بطئ', 'بطيء', 'مش بيرد', '2'
];

// نية الاستفسار عن تذكرة قائمة
const TICKET_STATUS_PATTERNS = [
    'حاله تذكرتي', 'حالة تذكرتي', 'تذكرتي وصلت لفين', 'تذكرتي ايه', 'وصلت لفين',
    'اخر حاله', 'رقم تذكرتي', 'تذاكري', 'متابعه تذكره', 'تذكرتي اتحلت',
    'ticket status', 'my ticket', 'تذكرتي فين', 'وصل البلاغ فين', 'تابعت البلاغ'
];

// نية الاستفسار عن الاشتراك
const SUBSCRIPTION_STATUS_PATTERNS = [
    'اشتراكي', 'باقتي', 'خطتي ايه', 'اشتراكي هيخلص', 'امتي هيخلص', 'امتي ينتهي',
    'تاريخ الانتهاء', 'اشتراكي شغال', 'subscription status', 'متي ينتهي اشتراكي',
    'باقتي هتخلص', 'خطتي هتخلص'
];

const PLATFORM_INFO_PATTERNS = [
    'مدعوم ايه', 'ايه هي مدعوم', 'المنصه دي ايه', 'بتقدموا ايه', 'الخدمات بتاعتكم',
    'what is mad3oom', 'about platform', 'انتوا بتعملوا ايه', 'الموقع ده بيعمل ايه'
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

// ===================== ردود الاشتراكات =====================
const PLAN_TEXT = {
    free: `الخطة المجانية 🆓 من غير ما تدفع ولا جنيه:
• نظام تذاكر أساسي
• محادثة مع الدعم في ساعات العمل
• تقدر تبلغ عن أي مشكلة
• بتجمع نقاط على كل بلاغ
متاحة دايمًا من غير ما تنتهي.`,

    support: `خطة "الدعم الفني" 🛠️ بـ 15$/شهر بدل 25$ (خصم 40%)، أو 150$/سنة بدل 180$ (خصم 17%):
• تذاكر دعم غير محدودة يوميًا
• نطاق فرعي مجاني زي company.mad3oom.online
• مدير واحد + لغاية 25 عضو
• إحصائيات متقدمة وسجل نشاط للفريق`,

    whatsapp: `خطة "واتساب" 💬 بـ 20$/شهر بدل 30$ (خصم 33%)، أو 200$/سنة بدل 240$ (خصم 17%):
• تربط رقم الواتساب بتاعك بالمنصة
• تستقبل وترد على رسائل العملاء من لوحة التحكم
• إشعارات فورية بأي رسالة جديدة
• تقدر تضيف خدمة الرد الآلي بعدين
ولو اشتركت بالرد الآلي مع الخطة الشهرية بتاخد 14 يوم إضافي مجانًا، أو 3 شهور زيادة لو سنوي 🎁`,

    bundle: `الباقة الشاملة "دعم فني + واتساب" 🚀 وهي الأكتر توفيرًا، بـ 30$/شهر بدل 55$ (خصم 45%)، أو 330$/سنة بدل 660$ (خصم 50%):
• كل مميزات الدعم الفني + الواتساب مع بعض
• دعم أولوية 24/7
• نقاط مكافآت مضاعفة
• شارة خاصة على بروفايلك`,

    enterprise: `بالنسبة للشركات 🏢 عندنا خطط مخصصة (مستخدمين مش محدودين، دعم مخصص 24/7، API وتكامل مع أنظمتك، SLA). التفاصيل والأسعار هيتم الإعلان عنها قريبًا، تحب أفتحلك تذكرة عشان فريق المبيعات يتواصل معاك؟`,

    compare: `هاديلك خلاصة سريعة:
🆓 مجاني: تذاكر أساسية بس + دعم في ساعات العمل
🛠️ دعم فني (15$/شهر): تذاكر غير محدودة + نطاق فرعي + فريق لغاية 25 عضو
💬 واتساب (20$/شهر): ربط رقم واتساب بالمنصة بس من غير نظام تذاكر
🚀 الباقة الشاملة (30$/شهر): كل حاجة مع بعض + أولوية 24/7 + شارة خاصة وأفضل توفير`,

    general: `عندنا 4 خطط 👇
🆓 مجاني — 0$
🛠️ الدعم الفني — 15$/شهر (بدل 25$)
💬 واتساب — 20$/شهر (بدل 30$)
🚀 دعم فني + واتساب (الأشمل) — 30$/شهر (بدل 55$، أكبر خصم وأوفر باقة)
كله متاح شهري أو سنوي بخصم إضافي.`
};

const PLATFORM_INFO_TEXT = `منصة مدعوم 🌟 هي منصة لإدارة الدعم الفني وواتساب بزنس في مكان واحد:
• نظام تذاكر لمتابعة مشاكل عملائك
• ربط رقم واتساب وإدارة الرسائل من لوحة تحكم واحدة
• رد آلي ذكي على رسائل واتساب
• محادثة مباشرة (لايف شات) مع العملاء
• نظام نقاط ومكافآت
• قاعدة معرفة لمقالات المساعدة`;

const TICKET_STATUS_LABELS = {
    open: 'مفتوحة 🟡',
    in_progress: 'قيد التنفيذ 🔵',
    resolved: 'تم الحل ✅',
    confirmed: 'مؤكدة ✅',
    rejected: 'مرفوضة ❌'
};

const SUB_PLAN_LABELS = { support: 'الدعم الفني', whatsapp: 'واتساب', bundle: 'الباقة الشاملة (دعم + واتساب)' };
const SUB_STATUS_LABELS = { active: 'فعّال ✅', expired: 'منتهي ⛔', pending: 'قيد المراجعة 🕓', rejected: 'مرفوض ❌' };

// ===================== استعلامات بيانات العميل (مفلترة بـ user_id دايمًا) =====================
async function getMyTicketsReply(supabase, userId) {
    const { data, error } = await supabase
        .from('tickets')
        .select('ticket_number, title, status, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(5);

    if (error) {
        console.error('خطأ في جلب تذاكر العميل:', error);
        return 'حصل خطأ بسيط وإحنا بنجيب تذاكرك، جرب تاني كمان شوية 🙏';
    }
    if (!data || data.length === 0) {
        return 'مفيش عندك أي تذاكر مفتوحة دلوقتي.';
    }

    const lines = data.map(t => {
        const label = TICKET_STATUS_LABELS[t.status] || t.status;
        const date = new Date(t.created_at).toLocaleDateString('ar-EG');
        return `• تذكرة #${t.ticket_number} — ${t.title} — الحالة: ${label} (${date})`;
    });

    return `دي آخر تذاكرك:\n${lines.join('\n')}`;
}

async function getMySubscriptionReply(supabase, userId) {
    const { data, error } = await supabase
        .from('whatsapp_subscriptions')
        .select('plan, status, billing_cycle, end_date')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(3);

    if (error) {
        console.error('خطأ في جلب اشتراك العميل:', error);
        return 'حصل خطأ بسيط وإحنا بنجيب بيانات اشتراكك، جرب تاني كمان شوية 🙏';
    }
    if (!data || data.length === 0) {
        return 'مش لاقي عندك اشتراك مدفوع حاليًا، يبدو إنك على الخطة المجانية 🆓.';
    }

    const lines = data.map(s => {
        const plan = SUB_PLAN_LABELS[s.plan] || s.plan;
        const status = SUB_STATUS_LABELS[s.status] || s.status;
        const cycle = s.billing_cycle === 'yearly' ? 'سنوي' : 'شهري';
        let dateInfo = '';
        if (s.end_date) {
            const end = new Date(s.end_date);
            const daysLeft = Math.ceil((end - new Date()) / (1000 * 60 * 60 * 24));
            const dateStr = end.toLocaleDateString('ar-EG');
            dateInfo = daysLeft > 0
                ? ` — هينتهي يوم ${dateStr} (باقي ${daysLeft} يوم)`
                : ` — انتهى يوم ${dateStr}`;
        }
        return `• ${plan} (${cycle}) — الحالة: ${status}${dateInfo}`;
    });

    return `دي بيانات اشتراكك:\n${lines.join('\n')}`;
}

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
• الباقة الشاملة: خصم 45% شهري / 50% سنوي (أكبر خصم!)`;
    }
    if (matchAny(normalizedText, PRICING_GENERAL_PATTERNS)) return PLAN_TEXT.general;
    return null;
}

/**
 * بيحاول يتعرف على "موضوع معروف" في رسالة العميل، ولو لقى تطابق بيرجع الرد
 * جاهز. المواضيع دي هي كل حاجة البوت "متأكد" منها. أي حاجة برة المواضيع
 * دي بتترجم لعدم تأكد (return null) وبالتالي بتودي لفلو تذكرة الاستفسار.
 */
async function detectKnownTopic(normalized, { supabase, userId }) {
    if (matchAny(normalized, TICKET_STATUS_PATTERNS)) {
        return await getMyTicketsReply(supabase, userId);
    }
    if (matchAny(normalized, SUBSCRIPTION_STATUS_PATTERNS)) {
        return await getMySubscriptionReply(supabase, userId);
    }
    if (matchAny(normalized, PLATFORM_INFO_PATTERNS)) {
        return PLATFORM_INFO_TEXT;
    }
    const pricingReply = getPricingReply(normalized);
    if (pricingReply) return pricingReply;

    return null; // مفيش موضوع معروف اتطابق -> "مش متأكد"
}

// ===================== إنشاء التذاكر =====================
async function createTicket({ supabase, userId, title, description, ticketType, contactInfo }) {
    const payload = {
        user_id: userId,
        title: (title || 'طلب من الشات').slice(0, 200),
        description: description || title || '',
        status: 'open',
        priority: ticketType === 'problem' ? 'medium' : 'low',
        ticket_type: ticketType
    };
    if (contactInfo) payload.contact_info = contactInfo;

    const { data, error } = await supabase
        .from('tickets')
        .insert(payload)
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

// ===================== رسائل ثابتة =====================
const MENU_PROMPT = 'اختار من الاختيارات دي 👇 أو اكتبلي طلبك بحريتك:';
const INQUIRY_ASK = 'تمام، اكتبلي استفسارك وهحاول أجاوبك فورًا 📝';
const PROBLEM_ASK = 'تمام، احكيلي مشكلتك بالتفصيل عشان أفتحلك تذكرة وفريق الدعم يتابعها 🔍';
const CONTACT_ASK = 'الاستفسار ده محتاج متابعة من فريق الدعم بنفسه 🙏 ابعتلي رقم موبايلك أو بريدك الإلكتروني عشان نتواصل معاك بخصوصه.';
const CANCELLED_MSG = 'تمام، رجعناك للقائمة الرئيسية 🙂';

function buildTicketConfirmation(botSettings, ticketType, ticketNumber) {
    const baseMsg = ticketType === 'inquiry'
        ? (botSettings?.ticket_confirmation_message || 'تم تسجيل استفسارك وفريق الدعم هيتواصل معاك في أقرب وقت.')
        : (botSettings?.ticket_message || 'تم فتح تذكرة دعم فني وسيقوم فريقنا بالرد عليك في أقرب وقت.');
    return ticketNumber ? `${baseMsg} رقم التذكرة بتاعتك هو #${ticketNumber} ✅` : `${baseMsg} ✅`;
}

// ===================== نقطة الدخول الرئيسية =====================
/**
 * @param {Object} params
 * @param {string} params.text - رسالة العميل
 * @param {Object} params.supabase - supabase client (شغال بصلاحية العميل، الـ RLS بيمنعه من شوفان بيانات غيره)
 * @param {string} params.sessionId - معرف جلسة الشات
 * @param {string} params.userId - معرف العميل (نفس صاحب الجلسة دايمًا)
 * @param {Object} params.botState - bot_state الحالي من chat_sessions
 * @param {Object} params.botSettings - صف bot_settings (ممكن يكون null)
 * @returns {Promise<{reply: string, options?: Array, ticketCreated?: boolean, ticketNumber?: number, ticketType?: string}>}
 */
export async function getBotReply({ text, supabase, sessionId, userId, botState, botSettings }) {
    const raw = (text || '').trim();
    const normalized = normalizeArabic(raw);
    const state = botState && typeof botState === 'object' ? { ...botState } : {};
    const flow = state.flow || 'idle';

    // ---------- إلغاء / رجوع للقائمة (متاح في أي وقت) ----------
    if (matchAny(normalized, CANCEL_PATTERNS)) {
        state.flow = 'main_menu';
        state.ticket_draft = {};
        await saveBotState(supabase, sessionId, state);
        return { reply: `${CANCELLED_MSG}\n${MENU_PROMPT}`, options: MAIN_MENU_OPTIONS };
    }

    // ---------- تحويلات سريعة متاحة برة فلوهات جمع البيانات ----------
    const canSwitchMenu = flow === 'idle' || flow === 'main_menu' || flow === 'awaiting_inquiry_text';
    if (canSwitchMenu && matchAny(normalized, MENU_PROBLEM_PATTERNS)) {
        state.flow = 'awaiting_problem_desc';
        state.ticket_draft = {};
        await saveBotState(supabase, sessionId, state);
        return { reply: PROBLEM_ASK, options: CANCEL_OPTIONS };
    }
    if (canSwitchMenu && matchAny(normalized, MENU_INQUIRY_PATTERNS)) {
        state.flow = 'awaiting_inquiry_text';
        state.ticket_draft = {};
        await saveBotState(supabase, sessionId, state);
        return { reply: INQUIRY_ASK, options: CANCEL_OPTIONS };
    }

    // ---------- فلو: انتظار وصف المشكلة ----------
    if (flow === 'awaiting_problem_desc') {
        const result = await createTicket({
            supabase, userId,
            title: raw.slice(0, 60),
            description: raw,
            ticketType: 'problem'
        });
        state.flow = 'main_menu';
        state.ticket_draft = {};
        await saveBotState(supabase, sessionId, state);

        if (!result.ok) {
            return { reply: 'حصل خطأ بسيط وإحنا بنفتح التذكرة، حاول تاني كمان شوية 🙏', options: MAIN_MENU_OPTIONS };
        }
        const confirmation = buildTicketConfirmation(botSettings, 'problem', result.ticketNumber);
        return {
            reply: `${confirmation}\n\n${MENU_PROMPT}`,
            options: MAIN_MENU_OPTIONS,
            ticketCreated: true,
            ticketNumber: result.ticketNumber,
            ticketType: 'problem'
        };
    }

    // ---------- فلو: انتظار نص الاستفسار ----------
    if (flow === 'awaiting_inquiry_text') {
        const knownReply = await detectKnownTopic(normalized, { supabase, userId });

        if (knownReply) {
            // البوت "متأكد" لأنه لقى موضوع معروف عنده
            state.flow = 'main_menu';
            state.ticket_draft = {};
            await saveBotState(supabase, sessionId, state);
            return { reply: `${knownReply}\n\n${MENU_PROMPT}`, options: MAIN_MENU_OPTIONS };
        }

        // "مش متأكد" -> نجمع بيانات تواصل ونفتح تذكرة استفسار
        state.flow = 'awaiting_contact_info';
        state.ticket_draft = { inquiry_text: raw };
        await saveBotState(supabase, sessionId, state);
        return { reply: CONTACT_ASK, options: CANCEL_OPTIONS };
    }

    // ---------- فلو: انتظار بيانات التواصل (بعد استفسار مش معروف) ----------
    if (flow === 'awaiting_contact_info') {
        const inquiryText = state.ticket_draft?.inquiry_text || 'استفسار من الشات';
        const result = await createTicket({
            supabase, userId,
            title: inquiryText.slice(0, 60),
            description: inquiryText,
            ticketType: 'inquiry',
            contactInfo: raw
        });
        state.flow = 'main_menu';
        state.ticket_draft = {};
        await saveBotState(supabase, sessionId, state);

        if (!result.ok) {
            return { reply: 'حصل خطأ بسيط وإحنا بنسجل استفسارك، حاول تاني كمان شوية 🙏', options: MAIN_MENU_OPTIONS };
        }
        const confirmation = buildTicketConfirmation(botSettings, 'inquiry', result.ticketNumber);
        return {
            reply: `${confirmation}\n\n${MENU_PROMPT}`,
            options: MAIN_MENU_OPTIONS,
            ticketCreated: true,
            ticketNumber: result.ticketNumber,
            ticketType: 'inquiry'
        };
    }

    // ---------- من هنا وتحت: flow === 'idle' أو 'main_menu' ----------

    // سؤال مباشر عن موضوع معروف حتى لو العميل مفتحش القائمة أصلاً
    const directKnownReply = await detectKnownTopic(normalized, { supabase, userId });
    if (directKnownReply) {
        state.flow = 'main_menu';
        await saveBotState(supabase, sessionId, state);
        return { reply: `${directKnownReply}\n\n${MENU_PROMPT}`, options: MAIN_MENU_OPTIONS };
    }

    // شكر
    if (matchAny(normalized, THANKS_PATTERNS)) {
        return { reply: 'العفو يا فندم، إحنا موجودين لو احتجت أي حاجة تانية 🌟', options: MAIN_MENU_OPTIONS };
    }

    // ترحيب (أول مرة بس بيقول أهلاً، بعد كده بيعرض القائمة على طول)
    if (matchAny(normalized, DEFAULT_GREETING_PATTERNS) && !state.greeted) {
        state.greeted = true;
        state.flow = 'main_menu';
        await saveBotState(supabase, sessionId, state);
        const welcome = botSettings?.welcome_message || 'أهلاً بيك في منصة مدعوم! 👋';
        return { reply: `${welcome}\n${MENU_PROMPT}`, options: MAIN_MENU_OPTIONS };
    }

    // ---------- MODEL_HOOK (اختياري) ----------
    // لو حبيت تضيف موديل لاحقًا، فعّل الشرط ده وحط نداء الـ Edge Function هنا
    // بدل رسالة الـ fallback تحت.
    // if (botSettings?.ai_enabled) {
    //     const aiReply = await callExternalModel(raw, { sessionId, userId });
    //     if (aiReply) return { reply: aiReply, options: MAIN_MENU_OPTIONS };
    // }

    // ---------- رد افتراضي: يوجّه للقائمة ----------
    if (!state.greeted) state.greeted = true;
    state.flow = 'main_menu';
    await saveBotState(supabase, sessionId, state);
    return {
        reply: `مش متأكد إني فهمتك صح 🙏 اختار من الاختيارات دي وهساعدك:`,
        options: MAIN_MENU_OPTIONS
    };
}
