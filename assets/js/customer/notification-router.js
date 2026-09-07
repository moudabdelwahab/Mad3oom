/**
 * notification-router.js — يحوّل الإشعار من "نص" إلى "إجراء".
 *
 * الخلفية: إشعارات العميل في قاعدة البيانات بتحمل رابطًا منظّمًا فعلاً
 * (مثال: customer-dashboard.html?ticket=<uuid>) لكن اللوحة كانت بتتجاهله
 * تمامًا — الضغط على "رد جديد على تذكرتك" كان بيودّي للوحة بدون فتح التذكرة.
 *
 * الوحدة دي مسؤولة عن حاجتين بس:
 *   1) وصف التصنيف (أيقونة/اسم/لون) اعتمادًا على notifications.category
 *      اللي بيملاه trigger في قاعدة البيانات (migrations/011).
 *   2) اشتقاق "الوجهة" من الرابط: تذكرة بعينها، أو قسم داخل اللوحة،
 *      أو رابط خارجي، أو لا شيء.
 *
 * مفيش هنا أي استعلام ولا رسم — عشان نفس المنطق يُستخدم في صفحة الإشعارات
 * وفي أي مكان تاني (شارة، تنبيه) من غير تكرار.
 */

/** وصف كل تصنيف كما يظهر للعميل. المفاتيح = قيم notifications.category. */
export const NOTIFICATION_CATEGORIES = Object.freeze({
    tickets: {
        label: 'التذاكر',
        tone: 'accent',
        icon: '<path d="M4 4h16c1.1 0 2 .9 2 2v3a2 2 0 0 0 0 4v3c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2v-3a2 2 0 0 0 0-4V6c0-1.1.9-2 2-2z"/>'
    },
    subscription: {
        label: 'الاشتراكات',
        tone: 'purple',
        icon: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>'
    },
    billing: {
        label: 'الرصيد والفوترة',
        tone: 'warning',
        icon: '<path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4"/><path d="M4 6v12c0 1.1.9 2 2 2h14v-4"/><path d="M18 12a2 2 0 0 0-2 2c0 1.1.9 2 2 2h4v-4h-4z"/>'
    },
    whatsapp: {
        label: 'واتساب',
        tone: 'whatsapp',
        icon: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 1 1-7.6-14.7 8.38 8.38 0 0 1 3.8.9L21 2z"/>'
    },
    sie: {
        label: 'المحرك الذكي',
        tone: 'accent',
        icon: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>'
    },
    security: {
        label: 'الأمان',
        tone: 'danger',
        icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'
    },
    account: {
        label: 'الحساب',
        tone: 'neutral',
        icon: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'
    },
    rewards: {
        label: 'المكافآت',
        tone: 'warning',
        icon: '<circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>'
    },
    chat: {
        label: 'المحادثة',
        tone: 'accent',
        icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'
    },
    system: {
        label: 'النظام',
        tone: 'neutral',
        icon: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'
    }
});

const FALLBACK_CATEGORY = 'system';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** أقسام اللوحة التي يجوز لإشعار أن يوجّه إليها. */
const IN_APP_SECTIONS = new Set([
    'overview', 'support', 'tickets', 'notifications',
    'usage', 'activity', 'security', 'profile', 'rewards', 'badges'
]);

/**
 * يفكّ رابط الإشعار إلى وجهة قابلة للتنفيذ.
 *
 * الروابط في قاعدة البيانات نصوص حرة كتبتها خدمات مختلفة، فبنتعامل معاها
 * كمدخل غير موثوق: بنقبل المسارات الداخلية فقط، وبنرفض أي مخطط غريب
 * (javascript: مثلاً) أو أي دومين خارجي غير معروف.
 *
 * @returns {{kind:'ticket',ticketId:string}
 *          |{kind:'section',section:string}
 *          |{kind:'url',href:string}
 *          |{kind:'none'}}
 */
export function resolveDestination(link) {
    if (!link || typeof link !== 'string') return { kind: 'none' };

    const raw = link.trim();
    if (!raw) return { kind: 'none' };

    // نرفض أي شيء ليس مسارًا داخليًا (لا javascript:, لا data:, لا دومين خارجي)
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:/i.test(raw)) return { kind: 'none' };

    let url;
    try {
        url = new URL(raw, window.location.origin);
    } catch {
        return { kind: 'none' };
    }
    if (url.origin !== window.location.origin) return { kind: 'none' };

    // 1) تذكرة بعينها — أهم حالة، وهي اللي كانت مهدرة تمامًا
    const ticketId = url.searchParams.get('ticket');
    if (ticketId && UUID_RE.test(ticketId)) {
        return { kind: 'ticket', ticketId };
    }

    const page = url.pathname.replace(/^\/+/, '').toLowerCase();

    // 2) قسم داخل اللوحة (من الـhash أو من طبيعة الصفحة)
    if (page === 'customer-dashboard.html' || page === '') {
        const hash = url.hash.replace(/^#/, '');
        if (IN_APP_SECTIONS.has(hash)) return { kind: 'section', section: hash };
        return { kind: 'section', section: 'overview' };
    }

    // 3) صفحة عميل أخرى داخل المنصة
    return { kind: 'url', href: url.pathname + url.search + url.hash };
}

/**
 * الوجهة من أعمدة الإشعار نفسه (action / action_target).
 *
 * ده المصدر الأساسي بعد migrations/015: الإجراء بقى بيانات على الصف، مش
 * استنتاجًا من نص الرابط في كل شاشة. الرابط بيفضل موجودًا وبيشتغل — هو
 * البنية اللي بتخدم الروابط الخارجية والبريد — لكنه بقى **احتياطيًا** هنا.
 */
function destinationFromColumns(notification) {
    const action = notification?.action;
    const target = notification?.action_target;
    if (!action || action === 'none') return null;

    if (action === 'open_ticket') {
        const id = target || notification?.reference_id;
        return id && UUID_RE.test(String(id)) ? { kind: 'ticket', ticketId: String(id) } : null;
    }

    if (action === 'open_section') {
        return IN_APP_SECTIONS.has(target) ? { kind: 'section', section: target } : null;
    }

    return null;
}

/**
 * يجمّع الإشعار في الشكل الذي تعرضه الواجهة.
 * category و action بييجوا من قاعدة البيانات؛ لو صف قديم لسه فاضي بنرجع
 * لاشتقاق الرابط بدل ما نكسر العرض.
 */
export function resolveNotification(notification) {
    const category = NOTIFICATION_CATEGORIES[notification?.category]
        ? notification.category
        : FALLBACK_CATEGORY;

    const destination = destinationFromColumns(notification)
        || resolveDestination(notification?.link);

    return {
        category,
        meta: NOTIFICATION_CATEGORIES[category],
        destination
    };
}

/** نص الإجراء لكل قسم — أوضح من "فتح القسم" المجرّدة. */
const SECTION_ACTION_LABELS = Object.freeze({
    tickets: 'عرض التذاكر',
    usage: 'عرض الاشتراك والاستهلاك',
    security: 'الانتقال إلى الأمان',
    profile: 'فتح الملف الشخصي',
    rewards: 'عرض المكافآت',
    support: 'عرض حالة النظام',
    badges: 'عرض الشارات',
    activity: 'عرض النشاط',
    overview: 'فتح النظرة العامة',
    notifications: 'عرض الإشعارات'
});

/** نص الزر داخل نافذة التفاصيل. الأدمن يقدر يخصّصه عبر action_label. */
export function actionLabelFor(notification, destination) {
    const custom = notification?.action_label;
    if (typeof custom === 'string' && custom.trim()) return custom.trim();

    if (destination?.kind === 'ticket') return 'فتح التذكرة';
    if (destination?.kind === 'section') {
        return SECTION_ACTION_LABELS[destination.section] || 'فتح القسم';
    }
    if (destination?.kind === 'url') return 'فتح الصفحة';
    return '';
}

/** نص قصير يوضّح للعميل ماذا سيحدث عند الضغط. */
export function destinationLabel(destination) {
    switch (destination?.kind) {
        case 'ticket':  return 'فتح التذكرة';
        case 'section': return SECTION_ACTION_LABELS[destination.section] || 'فتح القسم';
        case 'url':     return 'فتح الصفحة';
        default:        return '';
    }
}

/** قائمة التصنيفات المتاحة للتصفية، مبنية مما وصل فعلاً من إشعارات. */
export function categoriesPresentIn(notifications) {
    const seen = new Set();
    for (const n of notifications || []) {
        seen.add(NOTIFICATION_CATEGORIES[n?.category] ? n.category : FALLBACK_CATEGORY);
    }
    return Object.keys(NOTIFICATION_CATEGORIES).filter(key => seen.has(key));
}
