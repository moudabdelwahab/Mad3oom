/**
 * store-model.js — منطق العرض الخالص لصفحات المتجر في لوحة الشركة (بلا DOM ولا شبكة).
 *
 * القاعدة كما في integrations-model.js: الواجهة ترسم ما رجّعته القاعدة (store_* و ihub_*)
 * وما رجّعته ihub-api من Shopify، ولا تقرر صلاحية. كل فحص هنا تسهيل؛ الخادم يعيده.
 *
 * تنبيه مقصود في كل نص: طلب الاسترداد أو الإلغاء أو الإرجاع المسجَّل هنا **سجل متابعة في مدعوم**،
 * لا عملية في Shopify. لا نص في هذه الوحدة يصف طلبًا مسجَّلًا بأنه «تم الاسترداد».
 *
 * migrations/118_ecommerce_store_accounts.sql · migrations/119_shopify_store_integration.sql
 */

export const STORE_PAGES = Object.freeze(['storeOverview', 'shopify', 'storeOrders', 'storeRequests', 'storeReports']);

export const REQUIRED_SCOPES = Object.freeze(['read_customers', 'read_orders', 'read_products']);

export const SCOPE_LABELS = Object.freeze({
    read_orders: 'قراءة الطلبات (آخر 60 يومًا)',
    read_customers: 'قراءة العملاء',
    read_products: 'قراءة المنتجات'
});

export const REQUEST_KINDS = Object.freeze({
    return: 'طلب إرجاع',
    exchange: 'طلب استبدال',
    cancellation: 'طلب إلغاء',
    refund_inquiry: 'استفسار عن الاسترداد',
    shipping_issue: 'مشكلة شحن',
    other: 'طلب آخر'
});

/** «resolved» = أُغلق الطلب في مدعوم. لا تعني أن Shopify نفّذ شيئًا. */
export const REQUEST_STATUSES = Object.freeze({
    recorded: { label: 'مسجَّل', pill: 'status-neutral' },
    in_review: { label: 'قيد المراجعة', pill: 'status-tone-accent' },
    awaiting_customer: { label: 'بانتظار العميل', pill: 'status-tone-warning' },
    escalated: { label: 'مُصعَّد', pill: 'status-tone-warning' },
    resolved: { label: 'أُغلق في مدعوم', pill: 'status-tone-success' },
    declined: { label: 'مرفوض', pill: 'status-tone-danger' }
});

export const NOT_EXECUTED_NOTE = 'تسجيل الطلب هنا للمتابعة فقط: لا يُلغى طلب ولا يُسترد مبلغ ولا يُستبدل منتج في Shopify من مدعوم. نفّذ العملية من لوحة Shopify، ثم حدّث حالة الطلب هنا.';

const TERMINAL = new Set(['resolved', 'declined']);

/** الانتقالات المتاحة في القائمة. المحسوم لا يتغير إلا بإعادة فتح من المدير (القاعدة تفرضها). */
export function allowedStatuses(current, viewerRole) {
    if (TERMINAL.has(current)) return viewerRole === 'admin' ? [current, 'in_review'] : [current];
    return Object.keys(REQUEST_STATUSES);
}

/** المفاتيح بأسماء Shopify كما في GraphQL (IN_PROGRESS…)، والبحث بالصيغة الصغيرة التي يرجعها الخادم (shopify.js ENUM). */
const fromShopifyEnums = (labels) => Object.freeze(Object.fromEntries(Object.entries(labels).map(([k, v]) => [k.toLowerCase(), v])));

export const FINANCIAL_STATUS = fromShopifyEnums({
    PENDING: 'بانتظار الدفع', AUTHORIZED: 'مفوَّض', PARTIALLY_PAID: 'مدفوع جزئيًا', PAID: 'مدفوع',
    PARTIALLY_REFUNDED: 'مسترد جزئيًا', REFUNDED: 'مسترد', VOIDED: 'ملغى الدفع', EXPIRED: 'منتهي'
});

export const FULFILLMENT_STATUS = fromShopifyEnums({
    UNFULFILLED: 'لم يُشحن', PARTIALLY_FULFILLED: 'شُحن جزئيًا', FULFILLED: 'شُحن', IN_PROGRESS: 'قيد التجهيز',
    ON_HOLD: 'معلّق', SCHEDULED: 'مجدول', RESTOCKED: 'أعيد للمخزون', PENDING_FULFILLMENT: 'بانتظار التجهيز',
    OPEN: 'مفتوح', REQUEST_DECLINED: 'رُفض الطلب',
    IN_TRANSIT: 'في الطريق', OUT_FOR_DELIVERY: 'خرج للتسليم', DELIVERED: 'تم التسليم', ATTEMPTED_DELIVERY: 'محاولة تسليم',
    FAILURE: 'تعذّر التسليم', LABEL_PRINTED: 'طُبعت البوليصة', LABEL_PURCHASED: 'اشتُريت البوليصة', CONFIRMED: 'مؤكد',
    READY_FOR_PICKUP: 'جاهز للاستلام', PICKED_UP: 'تم الاستلام', SUCCESS: 'تم', CANCELED: 'ملغى', CANCELLED: 'ملغى'
});

export const RETURN_STATUS = fromShopifyEnums({
    NO_RETURN: null, RETURN_REQUESTED: 'طُلب إرجاع', IN_PROGRESS: 'إرجاع قيد التنفيذ', RETURNED: 'تم الإرجاع',
    INSPECTION_COMPLETE: 'اكتمل الفحص', RETURN_FAILED: 'تعذّر الإرجاع'
});

export const PRODUCT_STATUS = fromShopifyEnums({ ACTIVE: 'نشط', DRAFT: 'مسودة', ARCHIVED: 'مؤرشف', UNLISTED: 'غير مدرج' });

export const statusLabel = (map, v) => (v === undefined || v === null ? null : (Object.prototype.hasOwnProperty.call(map, v) ? map[v] : String(v)));

/** «my-store» أو «my-store.myshopify.com» — نفس قاعدة الخادم (shopify.js normalizeShopDomain). */
export function normalizeShop(input) {
    let s = String(input ?? '').trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/+$/, '');
    if (s && !s.includes('.')) s = `${s}.myshopify.com`;
    return /^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$/.test(s) ? s : null;
}

export function missingScopes(granted) {
    const set = new Set(Array.isArray(granted) ? granted : []);
    return REQUIRED_SCOPES.filter((s) => !set.has(s) && !set.has(s.replace(/^read_/, 'write_')));
}

const SYNC_STATUS = Object.freeze({
    queued: 'في الطابور', running: 'جارية', succeeded: 'ناجحة', failed: 'فشلت (ستُعاد تلقائيًا)', dead: 'توقفت بعد المحاولات',
    cancelled: 'أُلغيت'
});
export const syncStatusLabel = (s) => SYNC_STATUS[s] || 'لم تبدأ بعد';

/**
 * صحة ربط Shopify كما تُعرض: الحالة + سبب واحد واضح + الإجراء المقترح. لا رموز خام للمستخدم.
 * connection من _ihub_connection_json (119).
 */
export function connectionHealth(connection, { nowMs = Date.now() } = {}) {
    if (!connection) return { tone: 'neutral', label: 'غير مربوط', action: 'connect' };
    if (connection.status === 'pending') return { tone: 'neutral', label: 'بانتظار التفويض من Shopify', action: 'connect' };
    if (connection.status === 'reauth_required') return { tone: 'danger', label: 'يحتاج إعادة تفويض', action: 'reconnect' };
    const missing = missingScopes(connection.granted_scopes);
    if (missing.length) return { tone: 'danger', label: 'صلاحيات ناقصة في Shopify', action: 'reconnect', missing };
    if (connection.status === 'error') return { tone: 'warning', label: 'خطأ في الاتصال', action: 'test' };
    if (connection.last_sync_status === 'failed') return { tone: 'warning', label: 'آخر مزامنة فشلت', action: 'sync' };
    const last = Date.parse(connection.last_sync_at || '');
    if (!Number.isFinite(last)) return { tone: 'info', label: 'متصل — المزامنة الأولى لم تكتمل بعد', action: null };
    if (nowMs - last > 12 * 3600 * 1000) return { tone: 'warning', label: 'آخر مزامنة ناجحة منذ أكثر من 12 ساعة', action: 'sync' };
    return { tone: 'success', label: 'متصل ويعمل', action: null };
}

/** بيانات مخزّنة قديمة؟ (للتنبيه بجانب ما يُعرض من النسخة المخزّنة لا من Shopify مباشرة) */
export function isStale(fetchedAt, { nowMs = Date.now(), hours = 24 } = {}) {
    const t = Date.parse(fetchedAt || '');
    return !Number.isFinite(t) || nowMs - t > hours * 3600 * 1000;
}

/** بطاقات النظرة العامة من store_overview() — أرقام القاعدة كما هي، و«—» حين لا تُحسب. */
export function overviewKpis(o) {
    if (!o) return [];
    const n = (v) => (v === null || v === undefined ? '—' : String(v));
    const h = connectionHealth(o.connection);
    return [
        { key: 'connection', label: 'ربط Shopify', value: h.label, tone: h.tone },
        { key: 'open_tickets', label: 'تذاكر مفتوحة', value: n(o.open_tickets), tab: 'customerTickets' },
        { key: 'active_conversations', label: 'محادثات نشطة', value: n(o.active_conversations), tab: 'inbox' },
        { key: 'order_linked_open_tickets', label: 'تذاكر مفتوحة مرتبطة بطلبات', value: n(o.order_linked_open_tickets), tab: 'customerTickets' },
        { key: 'unresolved_requests', label: 'طلبات متابعة مفتوحة', value: n(o.unresolved_requests), tab: 'storeRequests' },
        { key: 'overdue_requests', label: 'طلبات متأخرة', value: n(o.overdue_requests), tab: 'storeRequests',
          tone: Number(o.overdue_requests) > 0 ? 'warning' : '' }
    ];
}

const fmtMoney = (amount, currency) => (amount === undefined || amount === null ? null : `${amount}${currency ? ` ${currency}` : ''}`);
const day = (v) => (v ? String(v).slice(0, 10) : null);

/** صفوف ملخص طلب Shopify (قائمة سماح). */
export function orderRows(s = {}) {
    const rows = [
        ['financial_status', 'الدفع', statusLabel(FINANCIAL_STATUS, s.financial_status)],
        ['fulfillment_status', 'التنفيذ', statusLabel(FULFILLMENT_STATUS, s.fulfillment_status)],
        ['return_status', 'الإرجاع', statusLabel(RETURN_STATUS, s.return_status)],
        ['total', 'الإجمالي', fmtMoney(s.total, s.currency)],
        ['current_total', 'الإجمالي بعد التعديل', fmtMoney(s.current_total, s.currency)],
        ['refunded_total', 'المسترد في Shopify', fmtMoney(s.refunded_total, s.currency)],
        ['created_at', 'تاريخ الطلب', day(s.created_at)],
        ['cancelled_at', 'أُلغي في', day(s.cancelled_at)],
        ['customer_name', 'العميل', s.customer_name],
        ['customer_email_masked', 'البريد', s.customer_email_masked],
        ['shipping', 'الشحن إلى', [s.shipping_city, s.shipping_country].filter(Boolean).join('، ') || null],
        ['item_count', 'عدد القطع', s.item_count]
    ];
    return rows.filter(([, , v]) => v !== null && v !== undefined && v !== '').map(([key, label, value]) => ({ key, label, value: String(value) }));
}

export function trackingList(s = {}) {
    return (Array.isArray(s.fulfillments) ? s.fulfillments : []).flatMap((f) => (Array.isArray(f.tracking) ? f.tracking : []).map((t) => ({
        status: statusLabel(FULFILLMENT_STATUS, f.status),
        company: t.company || null,
        number: t.number || null,
        url: typeof t.url === 'string' && /^https:\/\//.test(t.url) ? t.url : null,
        eta: day(f.estimated_delivery_at),
        delivered: day(f.delivered_at)
    })));
}

export function lineItems(s = {}) {
    return (Array.isArray(s.items) ? s.items : []).map((i) => ({
        title: i.title || i.name || '—',
        variant: i.variant || null,
        sku: i.sku || null,
        quantity: Number.isInteger(i.quantity) ? i.quantity : null,
        price: fmtMoney(i.unit_price, s.currency)
    }));
}

export function customerRows(s = {}) {
    return [
        ['name', 'الاسم', s.name],
        ['email_masked', 'البريد', s.email_masked],
        ['orders_count', 'عدد الطلبات', s.orders_count],
        ['amount_spent', 'إجمالي المشتريات', fmtMoney(s.amount_spent, s.currency)],
        ['created_at', 'عميل منذ', day(s.created_at)]
    ].filter(([, , v]) => v !== null && v !== undefined && v !== '').map(([key, label, value]) => ({ key, label, value: String(value) }));
}

export function productRows(s = {}) {
    return [
        ['status', 'الحالة', statusLabel(PRODUCT_STATUS, s.status)],
        ['total_inventory', 'إجمالي المخزون', s.total_inventory],
        ['handle', 'المعرّف', s.handle]
    ].filter(([, , v]) => v !== null && v !== undefined && v !== '').map(([key, label, value]) => ({ key, label, value: String(value) }));
}

/** صف نتيجة بحث للعرض في القائمة. */
export function searchItem(kind, r) {
    const s = r?.summary || {};
    if (kind === 'order') {
        return { id: r.external_id, title: r.display_ref || `#${r.external_id}`,
                 meta: [statusLabel(FINANCIAL_STATUS, s.financial_status), statusLabel(FULFILLMENT_STATUS, s.fulfillment_status),
                        fmtMoney(s.total, s.currency), day(s.created_at)].filter(Boolean).join(' · ') };
    }
    if (kind === 'customer') {
        return { id: r.external_id, title: s.name || r.display_ref || `#${r.external_id}`,
                 meta: [s.email_masked, s.orders_count !== undefined ? `${s.orders_count} طلب` : null].filter(Boolean).join(' · ') };
    }
    return { id: r.external_id, title: s.title || r.display_ref, meta: [statusLabel(PRODUCT_STATUS, s.status),
             s.total_inventory !== undefined ? `المخزون ${s.total_inventory}` : null].filter(Boolean).join(' · ') };
}

/** فحص نص البحث قبل الإرسال (نفس قيود الخادم shopify.js searchQuery). */
export function validSearchText(text) {
    const t = String(text ?? '').trim();
    return t.length >= 1 && t.length <= 80 && /^[\p{L}\p{N} #@._+'-]+$/u.test(t);
}

export const STORE_ERROR_MESSAGES = Object.freeze({
    not_a_store: 'هذه الصفحة لحسابات المتاجر الإلكترونية.',
    not_entitled: 'اشتراك متجرك لا يشمل هذه الأداة. راجع صفحة الاشتراكات.',
    forbidden: 'لا تملك صلاحية هذه البيانات. اطلبها من مدير المتجر (الأدوار والصلاحيات).',
    preview_read_only: 'بيانات Shopify الحية لا تُعرض داخل المعاينة.',
    rate_limited: 'طلبات كثيرة خلال دقيقة. انتظر قليلًا ثم أعد المحاولة.',
    invalid_shop: 'اكتب نطاق متجرك في Shopify مثل my-store.myshopify.com.',
    shop_mismatch: 'إعادة الربط للمتجر نفسه فقط. لربط متجر آخر افصل الربط الحالي أولًا.',
    reauth_required: 'الربط يحتاج إعادة تفويض أولًا.',
    request_closed: 'الطلب محسوم. إعادة فتحه لمدير المتجر.',
    limit_reached: 'وصلت للحد الأقصى من التصنيفات.',
    validation_failed: 'بعض الحقول غير صالحة.',
    not_found: 'غير موجود، أو لا تملك الوصول إليه.'
});

export function storeErrorMessage(code, fallback) {
    return STORE_ERROR_MESSAGES[code] || fallback || STORE_ERROR_MESSAGES.validation_failed;
}

/** صفوف التقرير من store_report() — كل رقم مع تعريفه كما أرسلته القاعدة. */
export function reportCards(r) {
    if (!r) return [];
    const v = (x, suffix = '') => (x === null || x === undefined ? '—' : `${x}${suffix}`);
    return [
        { key: 'ticket_volume', label: 'التذاكر الجديدة', value: v(r.ticket_volume), hint: r.definitions?.ticket_volume },
        { key: 'first_response', label: 'وسيط أول رد', value: v(r.first_response_minutes_median, ' دقيقة'),
          hint: `${r.definitions?.first_response_minutes_median || ''} (${v(r.tickets_with_response)} تذكرة)` },
        { key: 'resolution', label: 'وسيط زمن الحل', value: v(r.resolution_hours_median, ' ساعة'),
          hint: `${r.definitions?.resolution_hours_median || ''} (${v(r.tickets_resolved)} تذكرة)` },
        { key: 'unresolved', label: 'تذاكر غير محلولة الآن', value: v(r.unresolved_tickets) },
        { key: 'order_related', label: 'تذاكر مرتبطة بطلبات', value: v(r.order_related_tickets), hint: r.definitions?.order_related_tickets }
    ];
}

/** توزيع (مفتاح ← عدد) إلى صفوف بأسماء عربية، الأكبر أولًا. */
export function distributionRows(obj, labels = {}) {
    return Object.entries(obj || {}).map(([k, n]) => ({ key: k, label: labels[k] || (k === 'uncategorized' ? 'بلا تصنيف' : k), count: Number(n) || 0 }))
        .sort((a, b) => b.count - a.count);
}
