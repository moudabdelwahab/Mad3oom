/**
 * panel-registry.js — أنواع لوحات مساحة العمل وربطها بالصفحات القائمة (خالص)
 * ---------------------------------------------------------------------------
 * مساحة العمل لا تعيد بناء أي شاشة: كل لوحة هي صفحة موجودة (الصندوق، التذاكر،
 * سجل العميل) تعمل داخل إطار في «وضع التضمين». هذا الملف هو المكان الوحيد
 * الذي يعرف أي صفحة تخدم أي نوع، وبأي معامل.
 *
 * قاعدة الأمان هنا: الرابط يُبنى من قالب ثابت ومن معامل اجتاز التحقق فقط.
 * الترتيب المستعاد والرسائل الواردة من الإطارات مُدخلات غير موثوقة؛ لو مرّرنا
 * منها أي معامل استعلام كما هو لأمكن مثلًا تمرير ?impersonate= الذي يقرؤه
 * resolveAccess(). لذلك لا يمرّ شيء إلا معرّف UUID في خانة معروفة.
 *
 * الصلاحيات هنا للعرض فقط (إخفاء ما لا يخصّ الدور). الفرض الحقيقي في RLS،
 * وفي حارس كل صفحة الذي يعمل داخل الإطار كما يعمل خارجه.
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** طاقم المنصة — نفس جمهور رابط الصندوق في الشريط الجانبي (sidebar.js). */
const STAFF = Object.freeze(['admin', 'support', 'platform_owner']);

const TYPES = Object.freeze({
    inbox: {
        path: '/admin/inbox.html', singleton: true, entity: null, icon: 'inbox', roles: STAFF,
        label: { ar: 'صندوق الرسائل', en: 'Inbox' }
    },
    tickets: {
        path: '/admin/tickets.html', singleton: true, entity: null, icon: 'tickets', roles: STAFF,
        label: { ar: 'التذاكر', en: 'Tickets' }
    },
    customers: {
        path: '/customer-history.html', singleton: true, entity: null, icon: 'customers', roles: STAFF,
        label: { ar: 'سجل العملاء', en: 'Customers' }
    },
    conversation: {
        path: '/admin/inbox.html', view: 'thread', param: 'sessionId', query: 'session', aliases: ['session', 'session_id'],
        entity: 'conversation', icon: 'conversation', roles: STAFF,
        label: { ar: 'محادثة', en: 'Conversation' }
    },
    ticket: {
        path: '/admin/tickets.html', view: 'ticket', param: 'ticketId', query: 'ticket_id', aliases: ['ticket_id'],
        entity: 'ticket', icon: 'ticket', roles: STAFF,
        label: { ar: 'تذكرة', en: 'Ticket' }
    },
    customer: {
        path: '/customer-history.html', view: 'customer', param: 'customerId', query: 'customer_id', aliases: ['customer_id', 'user_id'],
        entity: 'customer', icon: 'customer', roles: STAFF,
        label: { ar: 'عميل', en: 'Customer' }
    }
});

export function panelType(type) {
    return Object.prototype.hasOwnProperty.call(TYPES, type) ? TYPES[type] : null;
}

export function panelTypes() {
    return Object.keys(TYPES);
}

export function panelLabel(type, lang = 'ar') {
    const def = panelType(type);
    return def ? (def.label[lang] || def.label.ar) : '';
}

/** هل يظهر هذا النوع لصاحب الدور؟ (عرض فقط — انظر رأس الملف) */
export function isPanelAllowed(type, role) {
    const def = panelType(type);
    return !!def && def.roles.includes(role);
}

/**
 * يتحقق من نوع ومعاملات لوحة ويرجع نسخة نظيفة ومفتاح منع التكرار.
 * أي حقل غير متوقع يُتجاهل. المعرّف يُخزَّن بحروف صغيرة حتى لا يصير نفس
 * السجل تبويبين لاختلاف حالة الأحرف.
 *
 * @returns {{params: object, key: string}|null}
 */
export function validatePanel(type, params = {}) {
    const def = panelType(type);
    if (!def) return null;
    if (def.singleton) return { params: {}, key: type };
    const id = params?.[def.param];
    if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
    const clean = id.toLowerCase();
    return { params: { [def.param]: clean }, key: `${type}:${clean}` };
}

export function recordId(panel) {
    const def = panelType(panel?.type);
    return def?.param ? panel.params?.[def.param] ?? null : null;
}

export function panelEntity(type) {
    return panelType(type)?.entity ?? null;
}

/** الرابط الذي يحمّله إطار اللوحة. null لو اللوحة لم تجتز التحقق. */
export function panelUrl(panel) {
    const valid = validatePanel(panel?.type, panel?.params);
    if (!valid) return null;
    const def = panelType(panel.type);
    const query = new URLSearchParams({ embed: '1' });
    if (def.view) query.set('view', def.view);
    if (def.param) query.set(def.query, valid.params[def.param]);
    return `${def.path}?${query.toString()}`;
}

/**
 * يحوّل رابطًا داخل صفحة مضمّنة إلى لوحة لو كان يشير لسجل تعرفه مساحة العمل
 * (رابط «سجل العميل» داخل المحادثة مثلًا). روابط النطاقات الأخرى أو المسارات
 * غير المعروفة ⇒ null فتعمل كرابط عادي.
 */
export function panelFromUrl(href, origin) {
    let url;
    try { url = new URL(href, origin); } catch { return null; }
    if (url.origin !== origin) return null;
    const path = url.pathname.replace(/\/+$/, '');

    for (const [type, def] of Object.entries(TYPES)) {
        if (def.singleton || def.path !== path) continue;
        for (const name of def.aliases) {
            const value = url.searchParams.get(name);
            if (value && UUID_RE.test(value)) return { type, params: { [def.param]: value.toLowerCase() } };
        }
    }
    const singleton = Object.entries(TYPES).find(([, def]) => def.singleton && def.path === path);
    return singleton ? { type: singleton[0], params: {} } : null;
}
