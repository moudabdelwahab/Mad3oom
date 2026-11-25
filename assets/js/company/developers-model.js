/**
 * developers-model.js — وثائق API والحدود وWebhooks كدوال خالصة.
 *
 * بلا DOM وبلا شبكة، فيُختبر بمعزل (tests/saas-developers-pricing.test.mjs).
 *
 * كل قيمة هنا منقولة من مصدر موجود، لا مخترَعة:
 *   • نقاط النهاية وأدوات MCP الـ18 بصلاحياتها: api-docs.html
 *     (جدول «العناوين الأساسية» وجدول «مرجع الأدوات»).
 *   • حدّ المعدّل 60 نداءً/دقيقة لكل مفتاح:
 *     supabase/functions/mcp/_shared/api-auth.ts
 *     و supabase/functions/send-whatsapp/_shared/api-auth.ts
 *     (RATE_LIMIT_MAX_PER_MINUTE — التجاوز يردّ 429).
 *   • أحداث Webhooks الستة: القيد نفسه في الترحيل 141
 *     (company_webhooks.events) — أي اختلاف بين القائمتين خطأ.
 *   • ihub-api ليست نقطة نهاية بمفتاح API: تُنادى من اللوحة بجلسة JWT
 *     (verify_jwt) عبر handleApi، فلا تظهر في جدول المفاتيح.
 */

/** حدّ المعدّل لكل مفتاح — 60 نداءً في الدقيقة، والتجاوز 429. */
export const RATE_LIMIT_PER_MINUTE = 60;
export const RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * نقاط النهاية التي يقبل فيها مفتاح API فعلًا.
 * OAuth نقاط عامة لتدفق التفويض نفسه، لا تُستدعى بمفتاح.
 */
export const API_ENDPOINTS = Object.freeze([
    {
        key: 'mcp',
        method: 'POST',
        url: 'https://mad3oom.com/mcp',
        auth: 'مفتاح API',
        label: 'خادم MCP — كل الأدوات',
        hint: 'نقطة واحدة JSON-RPC 2.0 لكل أدوات المنصة الـ18 أدناه.'
    },
    {
        key: 'oauth-metadata',
        method: 'GET',
        url: 'https://mad3oom.com/.well-known/oauth-authorization-server',
        auth: 'عامة',
        label: 'OAuth — بيانات خادم التفويض',
        hint: 'بيانات الاكتشاف لعملاء OAuth.'
    },
    {
        key: 'oauth-resource',
        method: 'GET',
        url: 'https://mad3oom.com/.well-known/oauth-protected-resource',
        auth: 'عامة',
        label: 'OAuth — بيانات المورد المحمي',
        hint: 'بيانات الاكتشاف للمورد المحمي.'
    },
    {
        key: 'oauth-register',
        method: 'POST',
        url: 'https://mad3oom.com/oauth/register',
        auth: 'عامة',
        label: 'OAuth — تسجيل عميل ديناميكي',
        hint: 'تسجيل عميل OAuth جديد.'
    },
    {
        key: 'oauth-authorize',
        method: 'GET',
        url: 'https://mad3oom.com/oauth/authorize',
        auth: 'جلسة المستخدم',
        label: 'OAuth — بدء التفويض',
        hint: 'صفحة موافقة المستخدم على الصلاحيات.'
    },
    {
        key: 'oauth-token',
        method: 'POST',
        url: 'https://mad3oom.com/oauth/token',
        auth: 'عميل OAuth',
        label: 'OAuth — إصدار/تجديد التوكن',
        hint: 'تبديل رمز التفويض بتوكن وصول.'
    }
]);

/** أدوات MCP الـ18 كما في api-docs.html — الاسم والصلاحية والوصف. */
export const MCP_TOOLS = Object.freeze([
    { key: 'list_tickets', scope: 'tickets:read', label: 'عرض التذاكر المرئية لصاحب المفتاح، مرتّبة من الأحدث.' },
    { key: 'get_ticket', scope: 'tickets:read', label: 'جلب تفاصيل تذكرة واحدة بمعرّفها.' },
    { key: 'create_ticket', scope: 'tickets:write', label: 'إنشاء تذكرة دعم جديدة نيابةً عن صاحب المفتاح.' },
    { key: 'update_ticket', scope: 'tickets:write', label: 'تعديل تذكرة موجودة.' },
    { key: 'close_ticket', scope: 'tickets:write', label: 'إغلاق تذكرة.' },
    { key: 'get_dashboard_stats', scope: 'tickets:read', label: 'إحصائيات سريعة عن التذاكر المرئية لصاحب المفتاح، مجمّعة حسب الحالة.' },
    { key: 'list_customers', scope: 'tickets:read', label: 'عرض العملاء المرئيين لصاحب مفتاح الـ API.' },
    { key: 'get_customer', scope: 'tickets:read', label: 'جلب بيانات عميل واحد بمعرّفه، ضمن نطاق العملاء المرئيين.' },
    { key: 'send_whatsapp', scope: 'whatsapp:send', label: 'إرسال رسالة واتساب (نصية أو قالب) من رقم مربوط بحسابك.' },
    { key: 'list_subscriptions', scope: 'subscriptions:read', label: 'عرض اشتراكات صاحب المفتاح مع فلترة اختيارية بالحالة والخطة.' },
    { key: 'get_subscription', scope: 'subscriptions:read', label: 'جلب تفاصيل اشتراك واحد.' },
    { key: 'list_subscription_plans', scope: 'subscriptions:plans', label: 'عرض خطط الاشتراك المفعّلة حاليًا مع مزاياها.' },
    { key: 'create_subscription', scope: 'subscriptions:write', label: 'إنشاء طلب اشتراك جديد. التفعيل الفعلي يتم لاحقًا من فريق الدعم بعد مراجعة الدفع.' },
    { key: 'renew_subscription', scope: 'subscriptions:renew', label: 'طلب تجديد اشتراك حالي.' },
    { key: 'cancel_subscription', scope: 'subscriptions:cancel', label: 'إلغاء طلب اشتراك قيد المراجعة.' },
    { key: 'list_notifications', scope: 'notifications:read', label: 'عرض إشعارات صاحب مفتاح الـ API نفسه.' },
    { key: 'send_notification', scope: 'notifications:send', label: 'إرسال إشعار لمستخدم.' },
    { key: 'manage_notification', scope: 'notifications:manage', label: 'تحديد إشعار كمقروء أو غير مقروء، أو حذفه.' }
]);

/**
 * أحداث Webhooks المتاحة — مطابقة حرفيًا لقيد الترحيل 141.
 * أي حدث خارج هذه القائمة يرفضه الخادم، فالتحقق هنا راحة للمستخدم فقط.
 */
export const WEBHOOK_EVENTS = Object.freeze([
    { key: 'ticket.created', label: 'تذكرة جديدة', hint: 'عند فتح تذكرة تخص الشركة.' },
    { key: 'ticket.replied', label: 'رد جديد على تذكرة', hint: 'عند وصول رد على تذكرة تخص الشركة.' },
    { key: 'ticket.closed', label: 'إغلاق تذكرة', hint: 'عند إغلاق تذكرة تخص الشركة.' },
    { key: 'customer.created', label: 'عميل جديد', hint: 'عند إضافة عميل جديد إلى الشركة.' },
    { key: 'subscription.renewed', label: 'تجديد اشتراك', hint: 'عند تجديد اشتراك تابع للشركة.' },
    { key: 'subscription.upgraded', label: 'ترقية اشتراك', hint: 'عند ترقية اشتراك تابع للشركة.' }
]);

export const WEBHOOK_EVENT_KEYS = Object.freeze(WEBHOOK_EVENTS.map(e => e.key));

export function describeWebhookEvent(key) {
    return WEBHOOK_EVENTS.find(e => e.key === key)
        || { key, label: key, hint: '' };
}

/** تحقّق من نموذج Webhook — نفس قواعد الترحيل 141 حرفيًا. */
export function validateWebhookForm(values) {
    const errors = {};
    const name = String(values?.name || '').trim();
    const url = String(values?.url || '').trim();
    const events = Array.isArray(values?.events) ? values.events : [];

    if (!name) errors.name = 'الاسم مطلوب';
    else if (name.length > 80) errors.name = 'الاسم طويل جدًا (الحد الأقصى 80 حرفًا)';

    if (!url) errors.url = 'الرابط مطلوب';
    else if (!url.startsWith('https://')) errors.url = 'رابط الـWebhook يجب أن يبدأ بـ https://';
    else if (url.length > 2048) errors.url = 'الرابط طويل جدًا';

    if (!events.length) errors.events = 'اختر حدثًا واحدًا على الأقل';
    else if (events.some(e => !WEBHOOK_EVENT_KEYS.includes(e))) errors.events = 'حدث غير معروف';

    return { isValid: Object.keys(errors).length === 0, errors };
}

/** الحمولة كما تُرسَل لدالة الإنشاء — لا سرّ فيها، السرّ يولّده الخادم. */
export function toWebhookCreatePayload(values) {
    return {
        name: String(values?.name || '').trim(),
        url: String(values?.url || '').trim(),
        events: Array.isArray(values?.events) ? values.events.slice() : []
    };
}

/** هل الخطأ «الدالة غير موجودة» — أي الترحيل 141 لم يُطبَّق بعد؟ */
export function isFunctionMissingError(error) {
    if (!error) return false;
    return error.code === 'PGRST202'
        || /could not find the function/i.test(String(error.message || ''));
}

/** حالة محاولة تسليم كما تُقرأ من الصف — لا اجتهاد في الواجهة. */
export function deliveryStatus(delivery) {
    if (delivery?.status === 'sent') return { key: 'sent', label: 'تم التسليم', tone: 'success' };
    if (delivery?.status === 'failed') return { key: 'failed', label: 'فشل', tone: 'danger' };
    return { key: 'pending', label: 'معلّق', tone: 'neutral' };
}

/** حالة Webhook الإجمالية من آخر تسليم وعدد الفشل — للعرض فقط. */
export function webhookHealth(webhook) {
    if (!webhook) return { key: 'unknown', label: '—', tone: 'neutral' };
    if (webhook.is_active === false) return { key: 'disabled', label: 'موقوف', tone: 'neutral' };
    if (!webhook.deliveries_count) return { key: 'idle', label: 'بلا تسليم بعد', tone: 'neutral' };
    if (webhook.last_delivery_status === 'failed') return { key: 'failing', label: 'آخر تسليم فشل', tone: 'danger' };
    if (webhook.last_delivery_status === 'sent') return { key: 'ok', label: 'يُسلَّم', tone: 'success' };
    return { key: 'pending', label: 'تسليم معلّق', tone: 'warning' };
}

/**
 * نداءات مفتاح ما في آخر 60 ثانية، من صفوف api_token_usage_logs.
 * الصفوف بلا created_at صالح لا تُحسب — لا تخمين.
 */
export function minuteUsage(rows, tokenId, now = Date.now()) {
    if (!Array.isArray(rows) || !tokenId) return 0;
    const floor = now - RATE_LIMIT_WINDOW_SECONDS * 1000;
    return rows.filter(r => r?.token_id === tokenId
        && Number.isFinite(new Date(r.created_at).getTime())
        && new Date(r.created_at).getTime() >= floor).length;
}

/** المتبقي من الحدّ في الدقيقة الحالية — لا يقل عن صفر. */
export function remainingQuota(used) {
    return Math.max(0, RATE_LIMIT_PER_MINUTE - (Number(used) || 0));
}
