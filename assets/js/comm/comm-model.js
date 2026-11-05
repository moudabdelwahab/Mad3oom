/**
 * comm-model.js — نموذج محرّك التواصل الموحّد (دوال خالصة، مُختبَرة في node).
 *
 * المحرّك واحد في القاعدة (migrations/123_communication_engine.sql) بثلاثة نطاقات مستقلة:
 *   customer_company  عميل الشركة ↔ فريق شركته     (فوق جداول 102 كما هي)
 *   company_platform  الشركة ↔ إدارة مدعوم
 *   admin_owner       طاقم المنصة ↔ مالك المنصة (داخلي)
 *
 * هذه الوحدة لا تقرّر صلاحية: «الجانب» (requester/responder) يحسبه الخادم في comm_overview()
 * وفي كل نداء. هنا فقط: أي النطاقات تُعرض في أي لوحة، وأسماؤها بالعربية والإنجليزية، والتحقق
 * من المدخلات قبل الإرسال، وتنسيق العرض.
 *
 * مسارات نسبية عمدًا حتى تُستورد في node مباشرةً.
 */

export const SCOPES = Object.freeze(['customer_company', 'company_platform', 'admin_owner']);

/**
 * أي النطاقات تظهر في أي لوحة. الخادم قد يعطي المنادي جانبًا في نطاق آخر (مثلًا مالك المنصة
 * في سياق owner يجيب في company_platform)، لكن الودجت يعرض في كل لوحة ما يخصها وحده — فلا
 * تظهر محادثات الشركة مع عملائها داخل لوحة الإدارة مثلًا، حتى لو تغيّر الخادم يومًا.
 */
export const SURFACE_SCOPES = Object.freeze({
    portal:  ['customer_company'],
    company: ['company_platform', 'customer_company'],
    admin:   ['company_platform', 'admin_owner'],
    owner:   ['admin_owner', 'company_platform']
});

export const CATEGORIES = Object.freeze({
    company_platform: ['technical', 'bug', 'billing', 'subscription', 'account', 'other'],
    admin_owner: ['operational', 'report', 'approval', 'decision', 'incident', 'other'],
    customer_company: []
});

export const PRIORITIES = Object.freeze(['normal', 'high', 'urgent']);

export const LIMITS = Object.freeze({
    subjectMin: 3, subjectMax: 200, bodyMax: 5000,
    fileMaxBytes: 10 * 1024 * 1024, filesPerMessage: 5
});

export const ALLOWED_MIME = Object.freeze([
    'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/zip', 'audio/webm', 'audio/mpeg', 'audio/ogg'
]);

const STRINGS = {
    ar: {
        launcher: 'المراسلات',
        close: 'إغلاق',
        back: 'رجوع',
        newThread: 'محادثة جديدة',
        search: 'بحث في المحادثات',
        empty: 'لا توجد محادثات بعد.',
        emptyFiltered: 'لا نتائج مطابقة.',
        loading: 'جارٍ التحميل…',
        loadError: 'تعذّر تحميل المحادثات.',
        retry: 'إعادة المحاولة',
        subject: 'الموضوع',
        category: 'التصنيف',
        priority: 'الأولوية',
        message: 'الرسالة',
        send: 'إرسال',
        start: 'بدء المحادثة',
        cancel: 'إلغاء',
        attach: 'إرفاق ملف',
        internal: 'ملاحظة داخلية',
        internalBadge: 'داخلية',
        closeThread: 'إغلاق المحادثة',
        reopenThread: 'إعادة الفتح',
        toTicket: 'تحويل إلى تذكرة',
        ticketLinked: 'محوّلة إلى تذكرة',
        assign: 'الإسناد',
        unassigned: 'غير مُسندة',
        statusOpen: 'مفتوحة',
        statusClosed: 'مغلقة',
        readOnly: 'هذه المحادثة للقراءة فقط.',
        closedHint: 'المحادثة مغلقة — أعد فتحها للرد.',
        you: 'أنت',
        sent: 'تم الإرسال',
        started: 'بدأت المحادثة',
        ticketCreated: 'تم إنشاء التذكرة وربطها بالمحادثة',
        uploadFailed: 'تعذّر رفع الملف',
        filters: { open: 'المفتوحة', mine: 'المسندة إليّ', unassigned: 'غير المسندة', closed: 'المغلقة', all: 'الكل' },
        unreadLabel: (n) => `${n} غير مقروءة`,
        errors: {
            subject: 'العنوان من 3 إلى 200 حرف.',
            body: 'اكتب رسالة (حتى 5000 حرف) أو أرفق ملفًا.',
            category: 'اختر تصنيفًا.',
            fileType: 'نوع الملف غير مسموح.',
            fileSize: 'الحد الأقصى للملف 10 ميجابايت.',
            fileCount: 'خمسة مرفقات على الأكثر في الرسالة.',
            disabled: 'هذه الميزة غير مفعّلة بعد.',
            notFound: 'المحادثة غير موجودة أو لم تعد متاحة لك.',
            forbidden: 'لا صلاحية لك لهذا الإجراء.',
            rateLimit: 'طلبات كثيرة خلال وقت قصير — انتظر قليلًا.',
            closed: 'المحادثة مغلقة — أعد فتحها أولًا.',
            generic: 'تعذّر تنفيذ الطلب. حاول مرة أخرى.'
        },
        scopes: {
            customer_company: { requester: { title: 'راسل الشركة', subtitle: 'تواصل مع فريق الدعم في شركتك', counterpart: 'فريق الشركة' },
                                responder: { title: 'رسائل العملاء', subtitle: 'محادثات عملاء الشركة', counterpart: 'العميل' } },
            company_platform: { requester: { title: 'دعم مدعوم', subtitle: 'تواصل مع إدارة منصة مدعوم', counterpart: 'إدارة مدعوم' },
                                responder: { title: 'مراسلات الشركات', subtitle: 'طلبات الشركات لإدارة المنصة', counterpart: 'الشركة' } },
            admin_owner: { requester: { title: 'راسل المالك', subtitle: 'تقارير وطلبات موافقة وقرارات', counterpart: 'مالك المنصة' },
                           responder: { title: 'مراسلات الفريق', subtitle: 'ما يرفعه فريق المنصة إليك', counterpart: 'فريق المنصة' } }
        },
        categories: {
            technical: 'دعم فني', bug: 'مشكلة تقنية', billing: 'فواتير ومدفوعات', subscription: 'الاشتراك والخدمات',
            account: 'الحساب', operational: 'مشكلة تشغيلية', report: 'تقرير داخلي', approval: 'طلب موافقة',
            decision: 'طلب قرار إداري', incident: 'حادثة أو خطر', other: 'أخرى'
        },
        priorities: { normal: 'عادية', high: 'مرتفعة', urgent: 'عاجلة' }
    },
    en: {
        launcher: 'Messages',
        close: 'Close',
        back: 'Back',
        newThread: 'New conversation',
        search: 'Search conversations',
        empty: 'No conversations yet.',
        emptyFiltered: 'No matching conversations.',
        loading: 'Loading…',
        loadError: 'Could not load conversations.',
        retry: 'Retry',
        subject: 'Subject',
        category: 'Category',
        priority: 'Priority',
        message: 'Message',
        send: 'Send',
        start: 'Start conversation',
        cancel: 'Cancel',
        attach: 'Attach file',
        internal: 'Internal note',
        internalBadge: 'Internal',
        closeThread: 'Close conversation',
        reopenThread: 'Reopen',
        toTicket: 'Convert to ticket',
        ticketLinked: 'Converted to ticket',
        assign: 'Assignee',
        unassigned: 'Unassigned',
        statusOpen: 'Open',
        statusClosed: 'Closed',
        readOnly: 'This conversation is read-only.',
        closedHint: 'This conversation is closed — reopen it to reply.',
        you: 'You',
        sent: 'Sent',
        started: 'Conversation started',
        ticketCreated: 'Ticket created and linked to this conversation',
        uploadFailed: 'Upload failed',
        filters: { open: 'Open', mine: 'Assigned to me', unassigned: 'Unassigned', closed: 'Closed', all: 'All' },
        unreadLabel: (n) => `${n} unread`,
        errors: {
            subject: 'Subject must be 3–200 characters.',
            body: 'Write a message (up to 5000 characters) or attach a file.',
            category: 'Choose a category.',
            fileType: 'This file type is not allowed.',
            fileSize: 'Files are limited to 10 MB.',
            fileCount: 'At most five attachments per message.',
            disabled: 'This feature is not enabled yet.',
            notFound: 'This conversation does not exist or is no longer available to you.',
            forbidden: 'You are not allowed to do this.',
            rateLimit: 'Too many requests — please wait a moment.',
            closed: 'This conversation is closed — reopen it first.',
            generic: 'Something went wrong. Please try again.'
        },
        scopes: {
            customer_company: { requester: { title: 'Message the company', subtitle: 'Talk to your company’s support team', counterpart: 'Company team' },
                                responder: { title: 'Customer messages', subtitle: 'Conversations with your customers', counterpart: 'Customer' } },
            company_platform: { requester: { title: 'Mad3oom support', subtitle: 'Talk to the Mad3oom platform team', counterpart: 'Mad3oom team' },
                                responder: { title: 'Company requests', subtitle: 'Companies contacting the platform', counterpart: 'Company' } },
            admin_owner: { requester: { title: 'Message the owner', subtitle: 'Reports, approvals and decisions', counterpart: 'Platform owner' },
                           responder: { title: 'Team escalations', subtitle: 'What the platform team raises to you', counterpart: 'Platform team' } }
        },
        categories: {
            technical: 'Technical support', bug: 'Technical issue', billing: 'Billing & payments', subscription: 'Subscription & services',
            account: 'Account', operational: 'Operational issue', report: 'Internal report', approval: 'Approval request',
            decision: 'Decision request', incident: 'Incident or risk', other: 'Other'
        },
        priorities: { normal: 'Normal', high: 'High', urgent: 'Urgent' }
    }
};

/** نصوص اللغة الحالية ('ar' افتراضيًا). */
export function strings(lang = 'ar') {
    return STRINGS[lang === 'en' ? 'en' : 'ar'];
}

/**
 * النطاقات المعروضة في لوحة: تقاطع ما يعطيه الخادم مع ما يخص اللوحة، بترتيب اللوحة.
 * @param {{scopes?: object}|null} overview ناتج comm_overview()
 * @param {string} surface portal | company | admin | owner
 * @returns {Array<{scope, side, canStart, open, unread}>}
 */
export function scopesForSurface(overview, surface) {
    const allowed = SURFACE_SCOPES[surface] || [];
    const scopes = overview?.scopes || {};
    return allowed
        .filter(s => scopes[s] && (scopes[s].side === 'requester' || scopes[s].side === 'responder'))
        .map(s => ({
            scope: s,
            side: scopes[s].side,
            canStart: scopes[s].can_start === true,
            open: Number(scopes[s].open) || 0,
            unread: Number(scopes[s].unread) || 0
        }));
}

export function totalUnread(entries) {
    return (entries || []).reduce((n, e) => n + (Number(e.unread) || 0), 0);
}

/** فلاتر القائمة المتاحة لجانب ونطاق. */
export function filtersFor(scope, side) {
    if (side === 'responder' && scope !== 'admin_owner') return ['open', 'mine', 'unassigned', 'closed', 'all'];
    return ['open', 'closed', 'all'];
}

/** عنوان النطاق وطرفه الآخر حسب جانب المنادي. */
export function scopeLabel(scope, side, lang = 'ar') {
    const s = strings(lang).scopes[scope];
    return (s && (s[side] || s.requester)) || { title: scope, subtitle: '', counterpart: '' };
}

export function categoryLabel(category, lang = 'ar') {
    return category ? (strings(lang).categories[category] || category) : '';
}

/**
 * التحقق من نموذج محادثة جديدة قبل الإرسال. الخادم يعيد التحقق نفسه.
 * @returns {{ok: boolean, errors: object, values: object}}
 */
export function validateStart({ scope, subject, body, category, priority } = {}, lang = 'ar') {
    const t = strings(lang).errors;
    const values = {
        subject: String(subject ?? '').trim(),
        body: String(body ?? '').trim(),
        category: category || null,
        priority: PRIORITIES.includes(priority) ? priority : 'normal'
    };
    const errors = {};
    if (values.subject.length < LIMITS.subjectMin || values.subject.length > LIMITS.subjectMax) errors.subject = t.subject;
    if (values.body.length < 1 || values.body.length > LIMITS.bodyMax) errors.body = t.body;
    const cats = CATEGORIES[scope] || [];
    if (cats.length && !cats.includes(values.category)) errors.category = t.category;
    if (!cats.length) values.category = null;
    return { ok: Object.keys(errors).length === 0, errors, values };
}

/** رسالة رد: نص أو مرفقات. */
export function validateReply({ body, files = [] } = {}, lang = 'ar') {
    const t = strings(lang).errors;
    const text = String(body ?? '').trim();
    if (files.length > LIMITS.filesPerMessage) return { ok: false, error: t.fileCount };
    if (!text && files.length === 0) return { ok: false, error: t.body };
    if (text.length > LIMITS.bodyMax) return { ok: false, error: t.body };
    return { ok: true, body: text };
}

/** هل الملف مقبول؟ (نوع وحجم) — الخادم والمستودع يعيدان الفحص. */
export function checkFile(file, lang = 'ar') {
    const t = strings(lang).errors;
    const mime = String(file?.type || '').toLowerCase().split(';')[0].trim();
    if (!ALLOWED_MIME.includes(mime)) return { ok: false, error: t.fileType };
    if (!(file?.size > 0) || file.size > LIMITS.fileMaxBytes) return { ok: false, error: t.fileSize };
    return { ok: true, mime };
}

export function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * رسالة خطأ الخادم للمستخدم بحسب رمزها (لا نص SQL خام إلا رسالة raise المكتوبة للمستخدم).
 */
export function errorMessage(error, lang = 'ar') {
    const t = strings(lang).errors;
    switch (error?.code) {
        case '0A000': return t.disabled;
        case 'P0002': return t.notFound;
        case '42501': return error?.message && /[؀-ۿ]/.test(error.message) && lang === 'ar' ? error.message : t.forbidden;
        case '54000': return t.rateLimit;
        case '55000': return t.closed;
        case '22023':
        case '23505':
            return lang === 'ar' && error?.message ? error.message : t.generic;
        default: return t.generic;
    }
}

/** نص وصف التذكرة عند تحويل المحادثة: آخر رسائل غير داخلية بترتيبها، مختصرة. */
export function ticketDescription(thread, lang = 'ar') {
    const t = strings(lang);
    const lines = (thread?.messages || [])
        .filter(m => !m.is_internal)
        .slice(-10)
        .map(m => `${m.mine ? t.you : (m.side === 'requester' ? (thread.counterpart_name || '—') : scopeLabel(thread.scope, 'requester', lang).counterpart)}: ${String(m.body || '').trim()}`);
    const head = lang === 'en' ? `Converted from conversation: ${thread?.subject || ''}` : `محوّلة من محادثة: ${thread?.subject || ''}`;
    return [head, '', ...lines].join('\n').slice(0, 4900);
}

/** فئة التذكرة المقابلة لتصنيف المحادثة (tickets-service.TICKET_CATEGORIES). */
export function ticketCategoryFor(category) {
    switch (category) {
        case 'billing':
        case 'subscription': return 'subscription';
        case 'account': return 'login';
        default: return 'other';
    }
}

/** معامل ?comm=<scope> في الرابط (روابط الإشعارات) إن كان نطاقًا معروفًا. */
export function scopeFromUrl(search) {
    try {
        const v = new URLSearchParams(search || '').get('comm');
        return SCOPES.includes(v) ? v : null;
    } catch {
        return null;
    }
}

/** وقت نسبي مختصر. */
export function timeLabel(iso, lang = 'ar', now = Date.now()) {
    const ts = Date.parse(iso || '');
    if (!Number.isFinite(ts)) return '';
    const sec = Math.max(0, Math.round((now - ts) / 1000));
    const ar = lang !== 'en';
    if (sec < 60) return ar ? 'الآن' : 'now';
    const min = Math.round(sec / 60);
    if (min < 60) return ar ? `منذ ${min} د` : `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return ar ? `منذ ${hr} س` : `${hr}h ago`;
    const day = Math.round(hr / 24);
    if (day < 7) return ar ? `منذ ${day} ي` : `${day}d ago`;
    return new Date(ts).toLocaleDateString(ar ? 'ar-EG' : 'en-GB', { day: 'numeric', month: 'short' });
}
