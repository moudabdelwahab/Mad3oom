/**
 * chatbot-engine.js (v6)
 * ------------------------------------------------------------
 * محرك رد آلي محلي 100% (من غير أي اتصال بموديل ذكاء اصطناعي خارجي).
 *
 * الجديد في النسخة دي (v6):
 * - إصلاح: التحية (زي "مرحبا"، "ازيك"، "ايه الأخبار"...) كانت بترد مرة واحدة
 *   بس طول عمر الجلسة (بسبب flag اسمه greeted بيتحفظ من أول رسالة ترحيب
 *   تلقائية). دلوقتي البوت بيرد على أي تحية في أي وقت خلال المحادثة، وبيفرق
 *   بس بين أول مرة (رسالة ترحيب كاملة من الإعدادات) والمرات اللي بعد كده
 *   (رد أخف وأسرع) من غير ما يوقع في fallback "مش متأكد إني فهمتك صح".
 *
 * النسخة اللي فاتت (v5) كانت مضيفة:
 * 1) فهم أوسع للكلام: تسامح مع الأخطاء الإملائية البسيطة (Levenshtein على
 *    مستوى الكلمة) + مرادفات ولهجات أكتر (مصري/خليجي/شامي) + تجاهل ترتيب
 *    الكلمات في العبارات القصيرة، عشان البوت "يفهم" صياغات أكتر من غير ما
 *    يحتاج نفس الكلمة بالظبط.
 * 2) أيقونات SVG بدل الإيموجي التقليدي: النصوص هنا بتستخدم رموز زي
 *    [[icon:ticket]] بدل 🎫، وده بيتحول لأيقونة SVG حقيقية في واجهة الشات.
 *
 * باقي المنطق (القائمة، فتح تذكرة مشكلة بخطواتها، فتح تذكرة استفسار،
 * الأمان، الاستعلامات) زي ما هو من النسخة اللي فاتت.
 * ------------------------------------------------------------
 */

// ===================== أدوات المطابقة (تطبيع + فهم تقريبي) =====================
function collapseRepeatedChars(text) {
    return text.replace(/(.)\1{2,}/g, '$1');
}

function normalizeArabic(text) {
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

/** مسافة ليفنشتاين بسيطة لمقارنة كلمتين (لتحمّل الأخطاء الإملائية الصغيرة) */
function levenshtein(a, b) {
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

function fuzzyWordMatch(word, target) {
    if (word === target) return true;
    if (Math.abs(word.length - target.length) > 2) return false;
    const threshold = target.length >= 7 ? 2 : 1;
    return levenshtein(word, target) <= threshold;
}

/**
 * بيتحقق لو نمط (كلمة أو عبارة قصيرة) موجود في النص، سواء بالتطابق
 * الحرفي (الأسرع والأدق)، أو بتطابق تقريبي على مستوى الكلمة الواحدة، أو
 * بوجود كل كلمات العبارة (تقريبيًا) في أي ترتيب للعبارات من كلمتين/تلاتة.
 */
function matchesPattern(normalizedText, rawPattern) {
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

function matchAny(normalizedText, patterns) {
    return patterns.some(p => matchesPattern(normalizedText, p));
}

// ===================== قائمة الاختيارات الرئيسية =====================
export const MAIN_MENU_OPTIONS = [
    { label: '[[icon:inquiry]] عندي استفسار', value: 'عندي استفسار' },
    { label: '[[icon:problem]] عندي مشكلة', value: 'عندي مشكلة' }
];

export const CANCEL_OPTIONS = [
    { label: '[[icon:cancel]] إلغاء والرجوع للقائمة', value: 'الغاء' }
];

export const PROBLEM_CATEGORY_OPTIONS = [
    { label: '[[icon:whatsapp]] واتساب', value: 'واتساب' },
    { label: '[[icon:ticket]] التذاكر', value: 'التذاكر' },
    { label: '[[icon:subscription]] الاشتراك', value: 'الاشتراك' },
    { label: '[[icon:login]] تسجيل الدخول', value: 'تسجيل الدخول' },
    { label: '[[icon:other]] حاجة تانية', value: 'حاجة تانية' }
];

export const IMAGE_STEP_OPTIONS = [
    { label: '[[icon:attach]] إرفاق صورة', value: '__attach_image__' },
    { label: '[[icon:skip]] تخطي وإنشاء التذكرة', value: 'تخطي' }
];

export function getOptionsForFlow(flow) {
    if (flow === 'awaiting_problem_category') return PROBLEM_CATEGORY_OPTIONS;
    if (flow === 'awaiting_problem_image') return IMAGE_STEP_OPTIONS;
    if (flow === 'awaiting_inquiry_text' || flow === 'awaiting_contact_info' || flow === 'awaiting_problem_desc') {
        return CANCEL_OPTIONS;
    }
    return MAIN_MENU_OPTIONS;
}

const CATEGORY_MAP = [
    { slug: 'whatsapp', label: 'واتساب', patterns: ['واتساب', 'whatsapp', 'وتساب', 'واتس', 'الواتس', 'رقم الواتساب'] },
    { slug: 'tickets', label: 'التذاكر', patterns: ['التذاكر', 'تذكره', 'تذاكر', 'ticket', 'تيكت', 'البلاغات', 'بلاغ'] },
    { slug: 'subscription', label: 'الاشتراك', patterns: ['الاشتراك', 'اشتراك', 'باقه', 'subscription', 'فاتوره', 'الدفع', 'الفلوس اتخصمت'] },
    { slug: 'login', label: 'تسجيل الدخول', patterns: ['تسجيل الدخول', 'دخول', 'لوجين', 'login', 'باسورد', 'كلمه السر', 'الحساب مقفول', 'نسيت الباسورد'] },
    { slug: 'other', label: 'حاجة تانية', patterns: ['حاجه تانيه', 'اخرى', 'غير ذلك', 'other'] }
];

function detectCategory(raw) {
    const normalized = normalizeArabic(raw);
    for (const c of CATEGORY_MAP) {
        if (matchAny(normalized, c.patterns)) return { slug: c.slug, label: c.label };
    }
    const fallbackLabel = raw.trim().slice(0, 30) || 'حاجة تانية';
    return { slug: 'other', label: fallbackLabel };
}

// ===================== الكلمات المفتاحية (موسّعة) =====================
const DEFAULT_GREETING_PATTERNS = [
    'مرحبا', 'اهلا', 'هاي', 'هلا', 'السلام عليكم', 'صباح الخير', 'مساء الخير',
    'ezayak', 'ezayek', 'hi', 'hello', 'هاى', 'ايه الاخبار', 'ازيك', 'عامل ايه',
    'كيفك', 'شلونك', 'ايش اخبارك', 'هلابيك', 'يعطيك العافيه صباحا', 'صباح النور',
    'مساء النور', 'اخبارك ايه', 'ايه الاخبار يا معلم', 'تمام يا باشا'
];

const THANKS_PATTERNS = [
    'شكرا', 'تسلم', 'مشكور', 'ربنا يخليك', 'thanks', 'thank you', 'يعطيك العافيه',
    'متشكر', 'الله يعافيك', 'يسلمو', 'مرسي', 'تسلم ايدك', 'الله يكرمك', 'ثانكس'
];

const CANCEL_PATTERNS = [
    'الغاء', 'كانسل', 'cancel', 'سيب', 'بطل', 'مش عايز', 'رجعني', 'رجوع',
    'القائمه', 'الرئيسيه', 'رجعني للقائمه', 'back', 'menu', 'رجع تاني',
    'وقف كده', 'خلاص بطل', 'مش محتاج كده'
];

const MENU_INQUIRY_PATTERNS = [
    'عندي استفسار', 'استفسار', 'سؤال', 'عايز اسال', 'حابب اسال', 'question', '1',
    'عندي سؤال', 'محتاج اسال', 'ممكن اسال', 'عايز افهم', 'حاب اعرف'
];

const MENU_PROBLEM_PATTERNS = [
    'عندي مشكله', 'مشكله', 'عطل', 'مش شغال', 'بلاغ', 'شكوي', 'معطل', 'واقف',
    'مش عامل', 'مش بيشتغل', 'فيه خطا', 'في خطأ', 'error', 'bug', 'problem',
    'issue', 'مش راضي يفتح', 'علق', 'هانج', 'بطئ', 'بطيء', 'مش بيرد', '2',
    'حصلت مشكله', 'في عطل', 'واجهتني مشكله', 'عندي عطل', 'الموقع فاصل',
    'مش قادر ادخل', 'مش عارف اعمل كذا', 'حصل ايه', 'خربان', 'مش شغاله'
];

const TICKET_STATUS_PATTERNS = [
    'حاله تذكرتي', 'حالة تذكرتي', 'تذكرتي وصلت لفين', 'تذكرتي ايه', 'وصلت لفين',
    'اخر حاله', 'رقم تذكرتي', 'تذاكري', 'متابعه تذكره', 'تذكرتي اتحلت',
    'ticket status', 'my ticket', 'تذكرتي فين', 'وصل البلاغ فين', 'تابعت البلاغ',
    'فين تذكرتي', 'ايه اخبار تذكرتي', 'البلاغ بتاعي عامل ايه', 'اتحل البلاغ',
    'حالة البلاغ'
];

const SUBSCRIPTION_STATUS_PATTERNS = [
    'اشتراكي', 'باقتي', 'خطتي ايه', 'اشتراكي هيخلص', 'امتي هيخلص', 'امتي ينتهي',
    'تاريخ الانتهاء', 'اشتراكي شغال', 'subscription status', 'متي ينتهي اشتراكي',
    'باقتي هتخلص', 'خطتي هتخلص', 'فاضلي كام يوم', 'باقتي لسه شغاله',
    'اشتراكي فعال', 'خطتي دلوقتي ايه'
];

const PLATFORM_INFO_PATTERNS = [
    'مدعوم ايه', 'ايه هي مدعوم', 'المنصه دي ايه', 'بتقدموا ايه', 'الخدمات بتاعتكم',
    'what is mad3oom', 'about platform', 'انتوا بتعملوا ايه', 'الموقع ده بيعمل ايه',
    'احكيلي عن المنصه', 'عايز اعرف عن الموقع', 'ايه هو مدعوم بالظبط'
];

const PRICING_GENERAL_PATTERNS = [
    'اسعار', 'الاسعار', 'سعر', 'الخطط', 'الباقات', 'اشتراك', 'اشتراكات',
    'فلوس', 'تكلفه', 'price', 'pricing', 'plan', 'plans', 'كام', 'بكام',
    'عايز اشترك', 'عايز اعرف الاسعار', 'التسعيره', 'اسعاركم كام', 'بتتكلفوا كام'
];

const PLAN_FREE_PATTERNS = ['مجاني', 'مجانا', 'فري', 'free', 'بدون مقابل', 'من غير فلوس'];
const PLAN_SUPPORT_PATTERNS = ['دعم فني', 'خطه الدعم', 'تذاكر فقط', 'support plan', 'تيكتس', 'خطه التذاكر'];
const PLAN_WHATSAPP_PATTERNS = ['واتساب', 'whatsapp', 'وتساب', 'واتس', 'خطه الواتساب'];
const PLAN_BUNDLE_PATTERNS = ['باقه', 'الباقه الشامله', 'bundle', 'الاتنين', 'دعم وواتساب', 'كومبو', 'الشامله', 'الباقه الكبيره'];
const DISCOUNT_PATTERNS = ['خصم', 'عرض', 'تخفيض', 'offer', 'discount', 'عروض', 'فيه تخفيضات', 'عروض الاطلاق'];
const ENTERPRISE_PATTERNS = ['شركات', 'شركه', 'enterprise', 'مؤسسه', 'بيزنس', 'عندي شركه'];
const COMPARE_PATTERNS = ['فرق', 'مقارنه', 'ايه الفرق', 'بين الخطط', 'compare', 'ايه احسن خطه'];

// ===================== ردود الاشتراكات =====================
const PLAN_TEXT = {
    free: `الخطة المجانية [[icon:gift]] من غير ما تدفع ولا جنيه:
• نظام تذاكر أساسي
• محادثة مع الدعم في ساعات العمل
• تقدر تبلغ عن أي مشكلة
• بتجمع نقاط على كل بلاغ
متاحة دايمًا من غير ما تنتهي.`,

    support: `خطة "الدعم الفني" [[icon:ticket]] بـ 15$/شهر بدل 25$ (خصم 40%)، أو 150$/سنة بدل 180$ (خصم 17%):
• تذاكر دعم غير محدودة يوميًا
• نطاق فرعي مجاني زي company.mad3oom.online
• مدير واحد + لغاية 25 عضو
• إحصائيات متقدمة وسجل نشاط للفريق`,

    whatsapp: `خطة "واتساب" [[icon:whatsapp]] بـ 20$/شهر بدل 30$ (خصم 33%)، أو 200$/سنة بدل 240$ (خصم 17%):
• تربط رقم الواتساب بتاعك بالمنصة
• تستقبل وترد على رسائل العملاء من لوحة التحكم
• إشعارات فورية بأي رسالة جديدة
• تقدر تضيف خدمة الرد الآلي بعدين
ولو اشتركت بالرد الآلي مع الخطة الشهرية بتاخد 14 يوم إضافي مجانًا، أو 3 شهور زيادة لو سنوي [[icon:gift]]`,

    bundle: `الباقة الشاملة "دعم فني + واتساب" [[icon:growth]] وهي الأكتر توفيرًا، بـ 30$/شهر بدل 55$ (خصم 45%)، أو 330$/سنة بدل 660$ (خصم 50%):
• كل مميزات الدعم الفني + الواتساب مع بعض
• دعم أولوية 24/7
• نقاط مكافآت مضاعفة
• شارة خاصة على بروفايلك`,

    enterprise: `بالنسبة للشركات [[icon:briefcase]] عندنا خطط مخصصة (مستخدمين مش محدودين، دعم مخصص 24/7، API وتكامل مع أنظمتك، SLA). التفاصيل والأسعار هيتم الإعلان عنها قريبًا، تحب أفتحلك تذكرة عشان فريق المبيعات يتواصل معاك؟`,

    compare: `هاديلك خلاصة سريعة:
[[icon:gift]] مجاني: تذاكر أساسية بس + دعم في ساعات العمل
[[icon:ticket]] دعم فني (15$/شهر): تذاكر غير محدودة + نطاق فرعي + فريق لغاية 25 عضو
[[icon:whatsapp]] واتساب (20$/شهر): ربط رقم واتساب بالمنصة بس من غير نظام تذاكر
[[icon:growth]] الباقة الشاملة (30$/شهر): كل حاجة مع بعض + أولوية 24/7 + شارة خاصة وأفضل توفير`,

    general: `عندنا 4 خطط:
[[icon:gift]] مجاني — 0$
[[icon:ticket]] الدعم الفني — 15$/شهر (بدل 25$)
[[icon:whatsapp]] واتساب — 20$/شهر (بدل 30$)
[[icon:growth]] دعم فني + واتساب (الأشمل) — 30$/شهر (بدل 55$، أكبر خصم وأوفر باقة)
كله متاح شهري أو سنوي بخصم إضافي.`
};

const PLATFORM_INFO_TEXT = `منصة مدعوم [[icon:star]] هي منصة لإدارة الدعم الفني وواتساب بزنس في مكان واحد:
• نظام تذاكر لمتابعة مشاكل عملائك
• ربط رقم واتساب وإدارة الرسائل من لوحة تحكم واحدة
• رد آلي ذكي على رسائل واتساب
• محادثة مباشرة (لايف شات) مع العملاء
• نظام نقاط ومكافآت
• قاعدة معرفة لمقالات المساعدة`;

const TICKET_STATUS_LABELS = {
    open: 'مفتوحة [[icon:dot-yellow]]',
    in_progress: 'قيد التنفيذ [[icon:dot-blue]]',
    resolved: 'تم الحل [[icon:dot-green]]',
    confirmed: 'مؤكدة [[icon:dot-green]]',
    rejected: 'مرفوضة [[icon:dot-red]]'
};

const SUB_PLAN_LABELS = { support: 'الدعم الفني', whatsapp: 'واتساب', bundle: 'الباقة الشاملة (دعم + واتساب)' };
const SUB_STATUS_LABELS = {
    active: 'فعّال [[icon:dot-green]]',
    expired: 'منتهي [[icon:dot-red]]',
    pending: 'قيد المراجعة [[icon:dot-yellow]]',
    rejected: 'مرفوض [[icon:dot-red]]'
};

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
        return 'حصل خطأ بسيط وإحنا بنجيب تذاكرك، جرب تاني كمان شوية [[icon:note]]';
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
        return 'حصل خطأ بسيط وإحنا بنجيب بيانات اشتراكك، جرب تاني كمان شوية [[icon:note]]';
    }
    if (!data || data.length === 0) {
        return 'مش لاقي عندك اشتراك مدفوع حاليًا، يبدو إنك على الخطة المجانية [[icon:gift]].';
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
        return `عروض الإطلاق الحالية [[icon:percent]] (سارية 6 شهور أو لحد ما نوصل لعدد العملاء المستهدف):
• الدعم الفني: خصم 40% شهري / 17% سنوي
• واتساب: خصم 33% شهري / 17% سنوي
• الباقة الشاملة: خصم 45% شهري / 50% سنوي (أكبر خصم!)`;
    }
    if (matchAny(normalizedText, PRICING_GENERAL_PATTERNS)) return PLAN_TEXT.general;
    return null;
}

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

    return null;
}

// ===================== إنشاء التذاكر =====================
async function createTicket({ supabase, userId, title, description, ticketType, contactInfo, category, imageUrl }) {
    const payload = {
        user_id: userId,
        title: (title || 'طلب من الشات').slice(0, 200),
        description: description || title || '',
        status: 'open',
        priority: ticketType === 'problem' ? 'medium' : 'low',
        ticket_type: ticketType
    };
    if (contactInfo) payload.contact_info = contactInfo;
    if (category) payload.category = category;
    if (imageUrl) payload.image_url = imageUrl;

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
const MENU_PROMPT = 'اختار من الاختيارات دي أو اكتبلي طلبك بحريتك:';
const INQUIRY_ASK = 'تمام، اكتبلي استفسارك وهحاول أجاوبك فورًا [[icon:inquiry]]';
const PROBLEM_CATEGORY_ASK = 'إيه نوع المشكلة؟';
const PROBLEM_ASK = 'تمام، اشرحلي المشكلة بالتفصيل عشان أفتحلك تذكرة وفريق الدعم يتابعها [[icon:search]]';
const PROBLEM_IMAGE_ASK = 'حابب ترفق صورة توضح المشكلة؟ (اختياري) [[icon:attach]]';
const CONTACT_ASK = 'الاستفسار ده محتاج متابعة من فريق الدعم بنفسه [[icon:note]] ابعتلي رقم موبايلك أو بريدك الإلكتروني عشان نتواصل معاك بخصوصه.';
const CANCELLED_MSG = 'تمام، رجعناك للقائمة الرئيسية [[icon:smile]]';
const IMAGE_UPLOAD_FAILED_MSG = 'حصل خطأ في رفع الصورة [[icon:note]] التذكرة هتتفتح من غيرها، تقدر تبعتها بعدين لفريق الدعم مباشرة.';

const SKIP_PATTERNS = ['تخطي', 'لا شكرا', 'لا مفيش', 'مفيش', 'بدون صوره', 'skip', 'no thanks', 'لأ', 'لا'];

function buildTicketConfirmation(botSettings, ticketType, ticketNumber) {
    const baseMsg = ticketType === 'inquiry'
        ? (botSettings?.ticket_confirmation_message || 'تم تسجيل استفسارك وفريق الدعم هيتواصل معاك في أقرب وقت.')
        : (botSettings?.ticket_message || 'تم فتح تذكرة دعم فني وسيقوم فريقنا بالرد عليك في أقرب وقت.');
    return ticketNumber
        ? `${baseMsg} رقم التذكرة بتاعتك هو #${ticketNumber} [[icon:check]]`
        : `${baseMsg} [[icon:check]]`;
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
 * @param {string} [params.imageUrl] - رابط صورة اترفعت (في خطوة صورة المشكلة)
 * @returns {Promise<{reply: string, options?: Array, ticketCreated?: boolean, ticketNumber?: number, ticketType?: string}>}
 */
export async function getBotReply({ text, supabase, sessionId, userId, botState, botSettings, imageUrl }) {
    const raw = (text || '').trim();
    const normalized = normalizeArabic(raw);
    const state = botState && typeof botState === 'object' ? { ...botState } : {};
    const flow = state.flow || 'idle';

    // ---------- إلغاء / رجوع للقائمة (متاح في أي وقت) ----------
    if (!imageUrl && matchAny(normalized, CANCEL_PATTERNS)) {
        state.flow = 'main_menu';
        state.ticket_draft = {};
        await saveBotState(supabase, sessionId, state);
        return { reply: `${CANCELLED_MSG}\n${MENU_PROMPT}`, options: MAIN_MENU_OPTIONS };
    }

    // ---------- تحويلات سريعة متاحة برة فلوهات جمع البيانات ----------
    const canSwitchMenu = flow === 'idle' || flow === 'main_menu' || flow === 'awaiting_inquiry_text';
    if (canSwitchMenu && matchAny(normalized, MENU_PROBLEM_PATTERNS)) {
        state.flow = 'awaiting_problem_category';
        state.ticket_draft = {};
        await saveBotState(supabase, sessionId, state);
        return { reply: PROBLEM_CATEGORY_ASK, options: PROBLEM_CATEGORY_OPTIONS };
    }
    if (canSwitchMenu && matchAny(normalized, MENU_INQUIRY_PATTERNS)) {
        state.flow = 'awaiting_inquiry_text';
        state.ticket_draft = {};
        await saveBotState(supabase, sessionId, state);
        return { reply: INQUIRY_ASK, options: CANCEL_OPTIONS };
    }

    // ---------- فلو: انتظار اختيار نوع المشكلة (خطوة 1) ----------
    if (flow === 'awaiting_problem_category') {
        const category = detectCategory(raw);
        state.flow = 'awaiting_problem_desc';
        state.ticket_draft = { category };
        await saveBotState(supabase, sessionId, state);
        return { reply: PROBLEM_ASK, options: CANCEL_OPTIONS };
    }

    // ---------- فلو: انتظار وصف المشكلة (خطوة 2) ----------
    if (flow === 'awaiting_problem_desc') {
        state.flow = 'awaiting_problem_image';
        state.ticket_draft = { ...state.ticket_draft, description: raw };
        await saveBotState(supabase, sessionId, state);
        return { reply: PROBLEM_IMAGE_ASK, options: IMAGE_STEP_OPTIONS };
    }

    // ---------- فلو: انتظار صورة اختيارية ثم إنشاء التذكرة (خطوة 3+4) ----------
    if (flow === 'awaiting_problem_image') {
        const category = state.ticket_draft?.category || { slug: 'other', label: 'حاجة تانية' };
        const description = state.ticket_draft?.description || 'مشكلة من الشات';
        const title = `${category.label} - ${description.slice(0, 50)}`;
        const fullDescription = `نوع المشكلة: ${category.label}\n\n${description}`;

        const result = await createTicket({
            supabase, userId,
            title,
            description: fullDescription,
            ticketType: 'problem',
            category: category.slug,
            imageUrl: imageUrl || undefined
        });

        state.flow = 'main_menu';
        state.ticket_draft = {};
        await saveBotState(supabase, sessionId, state);

        if (!result.ok) {
            return { reply: 'حصل خطأ بسيط وإحنا بنفتح التذكرة، حاول تاني كمان شوية [[icon:note]]', options: MAIN_MENU_OPTIONS };
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
            state.flow = 'main_menu';
            state.ticket_draft = {};
            await saveBotState(supabase, sessionId, state);
            return { reply: `${knownReply}\n\n${MENU_PROMPT}`, options: MAIN_MENU_OPTIONS };
        }

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
            return { reply: 'حصل خطأ بسيط وإحنا بنسجل استفسارك، حاول تاني كمان شوية [[icon:note]]', options: MAIN_MENU_OPTIONS };
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

    const directKnownReply = await detectKnownTopic(normalized, { supabase, userId });
    if (directKnownReply) {
        state.flow = 'main_menu';
        await saveBotState(supabase, sessionId, state);
        return { reply: `${directKnownReply}\n\n${MENU_PROMPT}`, options: MAIN_MENU_OPTIONS };
    }

    if (matchAny(normalized, THANKS_PATTERNS)) {
        return { reply: 'العفو يا فندم، إحنا موجودين لو احتجت أي حاجة تانية [[icon:star]]', options: MAIN_MENU_OPTIONS };
    }

    // ---------- التحية: بترد في أي وقت، مش مرة واحدة بس طول الجلسة ----------
    // ملحوظة: قبل كده كان فيه شرط "&& !state.greeted" بيمنع الرد على أي تحية
    // تانية بعد أول ترحيب تلقائي للجلسة، فكان أي "مرحبا" أو "ازيك" لاحقة بتقع
    // في الرد الافتراضي "مش متأكد إني فهمتك صح" بالغلط. دلوقتي بنرد دايمًا،
    // وبنفرق بس بين أول مرة (رسالة الترحيب من الإعدادات) والمرات اللي بعدها
    // (رد أقصر وأخف) من غير ما نعيد المنطق كله.
    if (matchAny(normalized, DEFAULT_GREETING_PATTERNS)) {
        const isFirstGreeting = !state.greeted;
        state.greeted = true;
        state.flow = 'main_menu';
        await saveBotState(supabase, sessionId, state);

        const welcome = isFirstGreeting
            ? (botSettings?.welcome_message || 'أهلاً بيك في منصة مدعوم! [[icon:smile]]')
            : 'أهلاً بيك تاني [[icon:smile]]';

        return { reply: `${welcome}\n${MENU_PROMPT}`, options: MAIN_MENU_OPTIONS };
    }

    // ---------- MODEL_HOOK (اختياري) ----------
    // if (botSettings?.ai_enabled) {
    //     const aiReply = await callExternalModel(raw, { sessionId, userId });
    //     if (aiReply) return { reply: aiReply, options: MAIN_MENU_OPTIONS };
    // }

    if (!state.greeted) state.greeted = true;
    state.flow = 'main_menu';
    await saveBotState(supabase, sessionId, state);
    return {
        reply: `مش متأكد إني فهمتك صح [[icon:note]] اختار من الاختيارات دي وهساعدك:`,
        options: MAIN_MENU_OPTIONS
    };
}
