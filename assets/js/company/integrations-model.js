/**
 * integrations-model.js — منطق العرض الخالص لمركز التكاملات (بلا DOM ولا شبكة).
 *
 * القاعدة: الواجهة ترسم ما رجّعته القاعدة (ihub_overview / ihub_ticket_context)
 * ولا تقرر صلاحية. ما لا يدعمه المزوّد يظهر «غير متاح» صراحةً، ولا يظهر له زر.
 * الفحوص هنا تسهيل للمستخدم فقط؛ الخادم يعيدها كلها.
 *
 * migrations/088_integrations_hub.sql · supabase/functions/_shared/integrations/*
 */

import { statusLabel, FINANCIAL_STATUS, FULFILLMENT_STATUS, RETURN_STATUS, PRODUCT_STATUS, trackingList } from './store-model.js';

export const PROVIDER_ORDER = Object.freeze(['wordpress', 'woocommerce', 'salla', 'daftra']);

export const PROVIDER_INFO = Object.freeze({
    wordpress: { name: 'ووردبريس', hint: 'إضافة «مدعوم» لموقعك: نموذج دعم يصل لطلبات الدعم هنا.' },
    woocommerce: { name: 'ووكومرس', hint: 'عرض حالة طلبات متجرك داخل تذاكر عملائك.' },
    salla: { name: 'سلة', hint: 'عرض حالة طلبات متجرك على سلة داخل تذاكر عملائك.' },
    daftra: { name: 'دفترة', hint: 'عرض فواتير وعملاء دفترة داخل تذاكر عملائك (قراءة فقط).' },
    // 119: يُدار من صفحة «Shopify» لحسابات المتاجر (ليس في PROVIDER_ORDER: لا بطاقة عامة)
    shopify: { name: 'Shopify', hint: 'طلبات متجرك وعملاؤه ومنتجاته داخل الدعم (قراءة فقط).' }
});

/** قدرات الكتالوج كما تُعرض للمدير. المفاتيح = ihub_providers.capabilities. */
export const CAPABILITY_LABELS = Object.freeze({
    fetch_order: 'قراءة الطلبات',
    fetch_invoice: 'قراءة الفواتير',
    fetch_customer: 'قراءة بيانات العميل',
    link_ticket: 'ربط السجل بتذكرة',
    webhooks: 'تحديث تلقائي بالأحداث',
    create_ticket: 'طلبات دعم من الموقع',
    refresh_credentials: 'تجديد الصلاحية تلقائيًا',
    incremental_sync: 'مزامنة دورية',
    write_operations: 'تعديل السجلات الخارجية'
});

const AVAILABLE = new Set(['implemented_verified', 'implemented_unverified', 'partial']);

export function capabilityState(value) {
    if (value === 'partial') return { available: true, label: 'جزئي' };
    if (AVAILABLE.has(value)) return { available: true, label: 'متاح' };
    if (value === 'not_applicable') return null; // لا معنى لها لهذا المزوّد: لا تُعرض
    return { available: false, label: 'غير متاح' };
}

export function capabilityList(capabilities = {}) {
    const out = [];
    for (const [key, label] of Object.entries(CAPABILITY_LABELS)) {
        const state = capabilityState(capabilities?.[key]);
        if (state) out.push({ key, name: label, available: state.available, state: state.label });
    }
    return out;
}

export const STATUS_INFO = Object.freeze({
    pending: { label: 'بانتظار الإكمال', pill: 'status-neutral' },
    active: { label: 'متصل', pill: 'status-tone-success' },
    error: { label: 'خطأ في الاتصال', pill: 'status-tone-warning' },
    reauth_required: { label: 'يحتاج إعادة ربط', pill: 'status-tone-danger' },
    none: { label: 'غير مربوط', pill: 'status-neutral' }
});

export function statusInfo(status) {
    return STATUS_INFO[status] || STATUS_INFO.none;
}

/** رسائل ثابتة لرموز الأخطاء (لا نص من المزوّد يصل هنا أبدًا). */
export const ERROR_MESSAGES = Object.freeze({
    auth_failed: 'رفض المزوّد بيانات الاعتماد. تأكد من المفاتيح أو أعد الربط.',
    token_expired: 'انتهت صلاحية التفويض. أعد الربط.',
    app_uninstalled: 'أُزيل التطبيق من المتجر. أعد الربط لاستئناف العرض.',
    forbidden_scope: 'المفتاح لا يملك صلاحية القراءة المطلوبة.',
    api_not_found: 'لم نجد واجهة المزوّد على هذا الرابط. تأكد من الرابط وتفعيل REST API.',
    rate_limited: 'المزوّد يحدّ عدد الطلبات حاليًا. حاول بعد قليل.',
    provider_unavailable: 'خدمة المزوّد غير متاحة حاليًا.',
    timeout: 'لم يردّ المزوّد في الوقت المحدد.',
    redirect_refused: 'الرابط يحوّل إلى عنوان آخر. أدخل العنوان النهائي للمتجر.',
    response_too_large: 'ردّ المزوّد أكبر من المسموح.',
    invalid_response: 'ردّ المزوّد بشكل غير متوقع.',
    invalid_url: 'الرابط غير صالح. استخدم https:// واسم نطاق عامًا.',
    invalid_input: 'بعض الحقول غير صالحة.',
    not_found: 'السجل غير موجود لدى المزوّد، أو لا تملك الوصول إليه.',
    not_configured: 'هذا التكامل غير مهيّأ على المنصة بعد.',
    account_in_use: 'هذا الحساب مربوط بشركة أخرى في مدعوم.',
    already_connected: 'يوجد ربط قائم لهذا المزوّد. افصله أولًا.',
    already_linked: 'هذا الربط موجود بالفعل.',
    site_mismatch: 'الإضافة مثبتة على موقع عنوانه لا يطابق الرابط المسجَّل. افصل الربط وأنشئه بعنوان الموقع الصحيح.',
    provider_disabled: 'هذا التكامل غير متاح حاليًا على المنصة.',
    not_entitled: 'اشتراك شركتك لا يشمل مركز التكاملات.',
    unsupported: 'هذه العملية غير مدعومة لهذا المزوّد.',
    forbidden: 'ليست لديك صلاحية لهذا الإجراء.',
    denied: 'أُلغي التفويض من صفحة المزوّد.',
    state_invalid: 'انتهت صلاحية طلب الربط أو استُعمل من قبل. ابدأ من جديد.',
    unknown_error: 'حدث خطأ غير متوقع.'
});

export function errorMessage(code) {
    return ERROR_MESSAGES[code] || ERROR_MESSAGES.unknown_error;
}

/**
 * بطاقات المزوّدين من حمولة ihub_overview(). null (ليس مديرًا أو قبل 088)
 * يرجع null — والقسم يعرض حالة «للمدير فقط».
 */
export function buildProviderCards(overview) {
    if (!overview || !Array.isArray(overview.providers)) return null;
    const canManage = overview.can_manage === true;
    const byProvider = new Map((overview.connections || []).map((c) => [c.provider, c]));
    return PROVIDER_ORDER
        .map((key) => overview.providers.find((p) => p.key === key))
        .filter(Boolean)
        .map((p) => {
            const c = byProvider.get(p.key) || null;
            const live = c && c.status !== 'pending';
            const enabled = p.enabled === true;
            return {
                key: p.key,
                name: PROVIDER_INFO[p.key]?.name || p.name_ar || p.key,
                hint: PROVIDER_INFO[p.key]?.hint || '',
                enabled,
                beta: p.release_stage !== 'ga',
                authKind: p.auth_kind,
                connection: c,
                status: statusInfo(c ? c.status : 'none'),
                accountLabel: c?.account_label || null,
                lastSuccessAt: c?.last_success_at || null,
                lastError: c?.last_error_code ? errorMessage(c.last_error_code) : null,
                capabilities: capabilityList(p.capabilities),
                actions: {
                    connect: canManage && enabled && (!c || c.status === 'pending'),
                    reconnect: canManage && enabled && !!c && c.status === 'reauth_required' && p.key === 'salla',
                    test: canManage && !!live && p.key !== 'wordpress',
                    rotate: canManage && !!live && (p.key === 'woocommerce' || p.key === 'wordpress'),
                    disconnect: canManage && !!c,
                    viewRole: canManage && !!live && p.key !== 'wordpress'
                }
            };
        });
}

const CK_RE = /^ck_[a-f0-9]{32,64}$/i;
const CS_RE = /^cs_[a-f0-9]{32,64}$/i;

function httpsUrl(v) {
    try {
        const u = new URL(String(v || '').trim());
        return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && u.hostname.includes('.');
    } catch {
        return false;
    }
}

/** فحص مبكر لحقول الربط (الخادم يعيده). يرجع { ok, errors, payload }. */
export function validateConnectForm(provider, values = {}) {
    const errors = {};
    const payload = {};
    if (provider === 'woocommerce') {
        if (!httpsUrl(values.store_url)) errors.store_url = 'رابط المتجر يبدأ بـ https://';
        if (!CK_RE.test(String(values.consumer_key || '').trim())) errors.consumer_key = 'المفتاح يبدأ بـ ck_';
        if (!CS_RE.test(String(values.consumer_secret || '').trim())) errors.consumer_secret = 'السر يبدأ بـ cs_';
        Object.assign(payload, { store_url: String(values.store_url || '').trim(), consumer_key: String(values.consumer_key || '').trim(),
                                 consumer_secret: String(values.consumer_secret || '').trim() });
    } else if (provider === 'daftra') {
        const sub = String(values.subdomain || '').trim().toLowerCase().replace(/^https:\/\//, '').replace(/\.daftra\.com\/?$/, '');
        if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(sub)) errors.subdomain = 'اكتب اسم حسابك فقط، مثل acme من acme.daftra.com';
        if (!/^[A-Za-z0-9._-]{16,256}$/.test(String(values.api_key || '').trim())) errors.api_key = 'مفتاح API غير صالح';
        Object.assign(payload, { subdomain: sub, api_key: String(values.api_key || '').trim() });
    } else if (provider === 'wordpress') {
        if (!httpsUrl(values.site_url)) errors.site_url = 'رابط الموقع يبدأ بـ https://';
        payload.site_url = String(values.site_url || '').trim();
    } else {
        errors._ = 'unsupported';
    }
    if (values.label) payload.label = String(values.label).trim().slice(0, 120);
    return { ok: Object.keys(errors).length === 0, errors, payload };
}

/** رابط تفويض سلة: نقبله فقط إن كان على نطاق سلة الرسمي. */
export function isSallaAuthorizeUrl(url) {
    try {
        const u = new URL(url);
        return u.protocol === 'https:' && u.hostname === 'accounts.salla.sa' && u.pathname === '/oauth2/auth';
    } catch {
        return false;
    }
}

export const RECORD_TYPE_LABELS = Object.freeze({ order: 'طلب', invoice: 'فاتورة', customer: 'عميل', product: 'منتج' });

const SUMMARY_FIELDS = [
    ['status', 'الحالة'], ['total', 'الإجمالي'], ['paid', 'المدفوع'], ['unpaid', 'المتبقي'],
    ['date', 'التاريخ'], ['created_at', 'تاريخ الطلب'], ['created_local', 'تاريخ الطلب'], ['paid_at', 'تاريخ الدفع'],
    ['completed_at', 'تاريخ الإكمال'], ['payment_method_title', 'طريقة الدفع'], ['customer_name', 'العميل'],
    ['client_name', 'العميل'], ['business_name', 'الاسم التجاري'], ['customer_email_masked', 'البريد'],
    ['item_count', 'عدد القطع'], ['payment_status_code', 'رمز حالة الدفع'],
    // 119: Shopify (القيم قائمة سماح من الموصل؛ الحالات مترجمة)
    ['financial_status', 'الدفع'], ['fulfillment_status', 'التنفيذ'], ['return_status', 'الإرجاع'],
    ['refunded_total', 'المسترد في Shopify'], ['cancelled_at', 'أُلغي في'], ['shipping_city', 'مدينة الشحن'],
    ['title', 'المنتج'], ['total_inventory', 'المخزون'], ['name', 'الاسم'], ['email_masked', 'البريد'], ['orders_count', 'عدد الطلبات']
];

const VALUE_LABELS = { financial_status: FINANCIAL_STATUS, fulfillment_status: FULFILLMENT_STATUS, return_status: RETURN_STATUS };

/** صفوف العرض لملخص سجل (قائمة سماح — حقل خارج القائمة لا يُعرض). */
export function summaryRows(summary = {}) {
    const rows = [];
    for (const [key, label] of SUMMARY_FIELDS) {
        let v = summary?.[key];
        if (v === undefined || v === null || v === '') continue;
        if ((key === 'total' || key === 'paid' || key === 'unpaid' || key === 'refunded_total') && summary.currency) v = `${v} ${summary.currency}`;
        if (key === 'created_at' || key === 'paid_at' || key === 'completed_at' || key === 'cancelled_at') v = String(v).slice(0, 10);
        if (VALUE_LABELS[key]) v = statusLabel(VALUE_LABELS[key], v);
        if (key === 'status' && summary.source === 'shopify') v = statusLabel(PRODUCT_STATUS, v);
        if (v === null) continue;
        rows.push({ key, label, value: String(v) });
    }
    if (summary?.guest === true) rows.push({ key: 'guest', label: 'نوع العميل', value: 'زائر (بلا حساب في المتجر)' });
    if (summary?.refunded === true) rows.push({ key: 'refunded', label: 'استرجاع', value: 'يوجد استرجاع على الطلب' });
    return rows;
}

export function itemsLine(summary = {}) {
    const items = Array.isArray(summary?.items) ? summary.items : [];
    return items.slice(0, 10).filter((i) => i && (i.name || i.title))
        .map((i) => (i.quantity ? `${i.name || i.title} × ${i.quantity}` : (i.name || i.title))).join('، ');
}

/** حالة سياق التذكرة كما تُرسم. null = لا لوحة إطلاقًا (غير مخوّل أو قبل 088). */
export function ticketContextView(ctx) {
    if (!ctx || typeof ctx !== 'object') return null;
    const connections = Array.isArray(ctx.connections) ? ctx.connections : [];
    const links = Array.isArray(ctx.links) ? ctx.links : [];
    if (!connections.length && !links.length) return null;
    return {
        links: links.map((l) => ({
            id: l.link_id,
            provider: l.provider,
            providerName: PROVIDER_INFO[l.provider]?.name || l.provider,
            typeLabel: RECORD_TYPE_LABELS[l.record_type] || l.record_type,
            recordType: l.record_type,
            ref: l.display_ref || l.external_id,
            reference: l.external_id,
            connectionId: connections.find((c) => c.provider === l.provider)?.id || null,
            rows: summaryRows(l.summary),
            items: itemsLine(l.summary),
            unverifiedMapping: l.summary?.field_mapping === 'unverified',
            url: typeof l.external_url === 'string' && /^https:\/\//.test(l.external_url) ? l.external_url : null,
            fetchedAt: l.fetched_at,
            stale: l.connection_status && l.connection_status !== 'active',
            tracking: trackingList(l.summary),
            deletedInProvider: l.summary?.deleted_in_provider === true,
            restricted: l.summary?.protected_fields_restricted === true
        })),
        linkOptions: connections.flatMap((c) => (Array.isArray(c.link_types) ? c.link_types : []).map((t) => ({
            value: `${c.id}|${t}`, connectionId: c.id, recordType: t,
            label: `${PROVIDER_INFO[c.provider]?.name || c.provider} — ${RECORD_TYPE_LABELS[t] || t}`
        }))),
        customerRefs: Array.isArray(ctx.customer_refs) ? ctx.customer_refs : []
    };
}

/**
 * قراءة نتيجة الرجوع من سلة (?ihub_result=...). «confirm» تعني أن سلة أعادت
 * التفويض والخادم حجزه، والإكمال يحتاج نفس التبويب الذي بدأ (oauthBindingKey).
 */
export function oauthResultFrom(search) {
    const p = new URLSearchParams(search || '');
    const result = p.get('ihub_result');
    const connectionId = p.get('ihub_connection');
    const completion = p.get('ihub_completion');
    if (result === 'confirm' && /^[0-9a-f-]{36}$/i.test(connectionId || '') && /^[A-Za-z0-9_-]{20,128}$/.test(completion || '')) {
        return { confirm: true, connectionId, completion, provider: p.get('ihub_provider') };
    }
    if (result === 'confirm') return { ok: false, message: errorMessage('state_invalid') };
    if (result === 'connected') return { ok: true, message: `تم ربط ${PROVIDER_INFO[p.get('ihub_provider')]?.name || 'الحساب'} بنجاح.` };
    if (result === 'error') return { ok: false, message: errorMessage(p.get('ihub_code') || 'unknown_error') };
    return null;
}

/** مفتاح بصمة تدفق OAuth في sessionStorage (لهذا التبويب وحده؛ ليست بيانات اعتماد). */
export function oauthBindingKey(connectionId) {
    return `ihub_oauth_binding:${connectionId}`;
}

export const VIEW_ROLE_OPTIONS = Object.freeze([
    { value: 'admin', label: 'مدير الشركة فقط' },
    { value: 'supervisor', label: 'المشرفون والمدير' },
    { value: 'agent', label: 'كل فريق الدعم' }
]);
