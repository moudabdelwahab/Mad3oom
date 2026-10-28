/**
 * company-store.js — صفحات المتجر في لوحة الشركة (حسابات ecommerce_store وحدها).
 *
 *   storeOverview  نظرة المتجر: حالة Shopify وأرقام الدعم الفعلية (store_overview)
 *   shopify        إدارة الربط: الربط/إعادة التفويض/الاختبار/المزامنة/الأحداث/الامتثال/الفصل (للمدير)
 *   storeOrders    البحث الحي في الطلبات والعملاء والمنتجات + سياق مدعوم لكل سجل
 *   storeRequests  طلبات المتابعة (إرجاع، استبدال، إلغاء، استفسار استرداد) والتصنيفات
 *   storeReports   تقارير المتجر بتعريف معلن لكل رقم (store_report)
 *
 * لا قرار صلاحية هنا: الرابط يظهر حسب الدور (company-routes.js)، والقاعدة تقرر كل قراءة وكتابة.
 * بيانات Shopify الحية لا تُخزَّن في الصفحة بعد مغادرتها، والرموز لا تصل المتصفح أبدًا.
 */

import {
    fetchStoreOverview, fetchStoreReport, fetchSyncStatus, requestSync, retryFailedEvents, fetchComplianceList, exportCompliance,
    fetchRecordContext, fetchCategories, saveCategory, fetchRequests, createRequest, updateRequest, fetchStaff,
    prepareConnection, disconnectConnection, setConnectionViewRole, startShopify, testConnection, searchShopify, getShopify
} from '/assets/js/company/store-data.js';
import {
    connectionHealth, overviewKpis, missingScopes, SCOPE_LABELS, REQUIRED_SCOPES, syncStatusLabel, normalizeShop,
    orderRows, trackingList, lineItems, customerRows, productRows, searchItem, validSearchText, storeErrorMessage,
    REQUEST_KINDS, REQUEST_STATUSES, NOT_EXECUTED_NOTE, allowedStatuses, reportCards, distributionRows, isStale
} from '/assets/js/company/store-model.js';
import { errorMessage, oauthBindingKey, VIEW_ROLE_OPTIONS } from '/assets/js/company/integrations-model.js';
import { escapeHtml as esc, formatDateTime, renderState, renderSkeletonLines } from '/assets/js/customer/portal-ui.js';
import { ui } from '/ui-service.js';

const $ = (id) => document.getElementById(id);
const msg = (code, fallback) => storeErrorMessage(code, errorMessage(code) || fallback);
const toast = (text, tone = 'info') => ui?.showToast?.(text, tone);

let viewerRole = () => 'admin';
let awaitCompletion = () => Promise.resolve();
let overview = null;
let staff = null;
let categories = null;

export function initCompanyStore({ getViewerRole, oauthCompletion } = {}) {
    if (typeof getViewerRole === 'function') viewerRole = getViewerRole;
    if (typeof oauthCompletion === 'function') awaitCompletion = oauthCompletion;
}

async function ensureOverview(force = false) {
    if (!overview || force) {
        const r = await fetchStoreOverview();
        overview = r.ok ? r.data : null;
        if (!r.ok) return r;
    }
    return { ok: true, data: overview };
}

function kpiHtml(items) {
    return `<div class="kpi-grid">${items.map((k) => `
        <div class="kpi ${k.tone ? `kpi--${esc(k.tone)}` : ''} ${k.tab ? 'is-clickable' : ''}" ${k.tab ? `data-tab="${esc(k.tab)}" role="link" tabindex="0"` : ''}>
            <p class="kpi-label">${esc(k.label)}</p>
            <p class="kpi-value">${esc(k.value)}</p>
            ${k.hint ? `<p class="kpi-hint">${esc(k.hint)}</p>` : ''}
        </div>`).join('')}</div>`;
}

const facts = (rows) => `<dl class="ihub-facts">${rows.map((r) => `<div><dt>${esc(r.label)}</dt><dd>${esc(r.value)}</dd></div>`).join('')}</dl>`;
const pill = (tone, text) => `<span class="pill status-tone-${esc(tone === 'neutral' ? 'accent' : tone)}">${esc(text)}</span>`;

function entitlementNotice(o) {
    if (!o) return '';
    const e = o.entitlements || {};
    if (e.store_support && e.shopify_integration) return '';
    return `<div class="state-block state-block--compact" role="note">
        <p class="state-title">بعض أدوات المتجر غير مشمولة في اشتراكك الحالي</p>
        <p class="state-text">${e.shopify_integration ? '' : 'تكامل Shopify غير مشمول. '}${e.store_support ? '' : 'أدوات دعم المتجر (الطلبات والتصنيفات والتقارير) غير مشمولة. '}
        اشترك في باقة المتاجر من صفحة الاشتراكات — يفعّلها فريق مدعوم بعد مراجعة الدفع.</p>
        <p><a class="btn btn-secondary btn-sm" href="#subscriptions" data-tab="subscriptions">الاشتراكات</a></p></div>`;
}

/* ══ نظرة المتجر ══════════════════════════════════════════════════════════ */

export async function loadStoreOverview() {
    const c = $('storeOverviewBody');
    if (!c) return;
    renderSkeletonLines(c, 4);
    const r = await ensureOverview(true);
    if (!r.ok) {
        renderState(c, { variant: 'error', title: 'تعذّر تحميل نظرة المتجر', text: msg(r.code, r.error) });
        return;
    }
    const o = r.data;
    const health = connectionHealth(o.connection);
    const activity = Array.isArray(o.recent_activity) ? o.recent_activity : [];
    c.innerHTML = `
        ${entitlementNotice(o)}
        ${kpiHtml(overviewKpis(o))}
        <div class="company-overview-grid">
            <section class="panel" aria-labelledby="storeHealthHeading">
                <div class="panel-header"><div>
                    <h2 class="panel-title" id="storeHealthHeading">صحة التكامل</h2>
                    <p class="panel-subtitle">${o.shopify_enabled ? 'حالة ربط متجرك في Shopify' : 'تكامل Shopify غير مفعّل على المنصة بعد'}</p>
                </div></div>
                ${o.connection ? facts([
                    { label: 'المتجر', value: o.connection.account_label || o.connection.base_url || '—' },
                    { label: 'الحالة', value: health.label },
                    { label: 'آخر مزامنة ناجحة', value: o.connection.last_sync_at ? formatDateTime(o.connection.last_sync_at) : 'لم تكتمل بعد' },
                    { label: 'آخر خطأ', value: o.connection.last_error_code ? msg(o.connection.last_error_code) : 'لا يوجد' }
                ]) : '<p class="panel-subtitle">لم يُربط متجر Shopify بعد.</p>'}
                ${o.my_role === 'admin' ? '<p><a class="btn btn-secondary btn-sm" href="#shopify" data-tab="shopify">إدارة ربط Shopify</a></p>' : ''}
            </section>
            <section class="panel" aria-labelledby="storeActivityHeading">
                <div class="panel-header"><div>
                    <h2 class="panel-title" id="storeActivityHeading">آخر نشاط الدعم</h2>
                    <p class="panel-subtitle">آخر التغييرات على طلبات المتابعة</p>
                </div></div>
                ${activity.length ? `<ul class="company-list">${activity.map((a) => `
                    <li><strong>${esc(REQUEST_KINDS[a.kind] || a.kind)}</strong> ${a.order_ref ? esc(a.order_ref) : ''}
                        — ${esc(REQUEST_STATUSES[a.to_status]?.label || a.to_status || '')}
                        <span class="field-hint">${esc(formatDateTime(a.created_at))}</span></li>`).join('')}</ul>`
                    : '<p class="panel-subtitle">لا نشاط مسجَّل بعد.</p>'}
            </section>
        </div>`;
}

/* ══ Shopify ══════════════════════════════════════════════════════════════ */

function installShopFromUrl() {
    const p = new URLSearchParams(window.location.search);
    if (p.get('ihub_result') !== 'install' || p.get('ihub_provider') !== 'shopify') return null;
    const shop = normalizeShop(p.get('ihub_shop'));
    const clean = new URL(window.location.href);
    ['ihub_result', 'ihub_provider', 'ihub_shop'].forEach((k) => clean.searchParams.delete(k));
    history.replaceState(null, '', clean.pathname + clean.search + clean.hash);
    return shop;
}

async function beginConnect(shop, connection, button) {
    const domain = normalizeShop(shop);
    if (!domain) { toast(msg('invalid_shop'), 'error'); return; }
    if (button) button.disabled = true;
    try {
        let id = connection?.id;
        if (!id) {
            const p = await prepareConnection('shopify', null);
            if (!p.ok) { toast(msg(p.code, p.error), 'error'); return; }
            id = p.data.id;
        }
        const r = await startShopify(id, domain);
        if (!r.ok) { toast(msg(r.code), 'error'); return; }
        let url = null;
        try { url = new URL(r.data?.authorize_url); } catch { /* يُرفض أدناه */ }
        // لا تحويل إلا إلى المتجر نفسه عبر https
        if (!url || url.protocol !== 'https:' || url.host !== domain) { toast(msg('invalid_shop'), 'error'); return; }
        try { window.sessionStorage.setItem(oauthBindingKey(id), r.data.binding); } catch {
            toast('المتصفح يمنع التخزين المؤقت لهذا التبويب، فلا يمكن إكمال الربط بأمان.', 'error');
            return;
        }
        window.location.assign(url.toString());
    } finally {
        if (button) button.disabled = false;
    }
}

function connectForm(connection, prefill) {
    const reconnect = connection && connection.status !== 'pending';
    const shop = prefill || (connection?.base_url ? connection.base_url.replace(/^https:\/\//, '') : '');
    return `<form class="company-form" id="shopifyConnectForm" novalidate>
        <div class="form-grid"><div class="form-field">
            <label for="shopifyShopInput">نطاق متجرك في Shopify</label>
            <input id="shopifyShopInput" class="form-control" name="shop" dir="ltr" autocomplete="off" required
                   placeholder="my-store.myshopify.com" value="${esc(shop)}" ${reconnect ? 'readonly' : ''} aria-describedby="shopifyShopHint">
            <p class="field-hint" id="shopifyShopHint">ستنتقل إلى Shopify لتوافق على صلاحيات القراءة فقط:
                ${REQUIRED_SCOPES.map((s) => esc(SCOPE_LABELS[s])).join('، ')}. لا يطلب مدعوم أي صلاحية كتابة.</p>
        </div></div>
        <p class="field-error" id="shopifyConnectError" role="alert" hidden></p>
        <div class="company-form-actions">
            <button type="submit" class="btn btn-primary">${reconnect ? 'إعادة التفويض في Shopify' : 'ربط متجر Shopify'}</button>
        </div></form>`;
}

export async function loadShopifyPage() {
    const c = $('storeShopifyBody');
    if (!c) return;
    renderSkeletonLines(c, 5);
    await awaitCompletion();
    const prefill = installShopFromUrl();
    const r = await ensureOverview(true);
    if (!r.ok) { renderState(c, { variant: 'error', title: 'تعذّر تحميل ربط Shopify', text: msg(r.code, r.error) }); return; }
    const o = r.data;
    if (o.my_role !== 'admin') { renderState(c, { variant: 'empty', title: 'إدارة الربط لمدير المتجر', text: '' }); return; }
    if (!o.shopify_enabled) {
        renderState(c, { variant: 'empty', title: 'تكامل Shopify غير مفعّل على المنصة بعد',
                         text: 'يفعّله فريق مدعوم بعد التحقق على متجر تطوير. لا يمكن الربط قبل ذلك.' });
        return;
    }
    const conn = o.connection;
    if (!o.entitlements?.shopify_integration) { c.innerHTML = entitlementNotice(o); return; }
    if (!conn || conn.status === 'pending') {
        c.innerHTML = `<section class="panel ihub-card"><div class="panel-header"><div>
                <h2 class="panel-title">ربط متجر Shopify</h2>
                <p class="panel-subtitle">بعد الموافقة في Shopify تعود إلى هذه الصفحة في التبويب نفسه ويكتمل الربط.</p>
            </div></div>${prefill ? '<p class="panel-subtitle">وصلت من Shopify — أكمل الربط بالضغط على الزر.</p>' : ''}
            ${connectForm(conn, prefill)}</section>`;
        wireConnect(c, conn);
        return;
    }
    const s = await fetchSyncStatus(conn.id);
    const status = s.ok ? s.data : null;
    const health = connectionHealth(status?.connection || conn);
    const missing = missingScopes((status?.connection || conn).granted_scopes);
    const jobs = status?.jobs || [];
    const ev = status?.events || {};
    const failures = ev.recent_failures || [];
    const comp = await fetchComplianceList();
    const compliance = comp.ok && Array.isArray(comp.data) ? comp.data : [];
    c.innerHTML = `
    <section class="panel ihub-card" aria-labelledby="shopifyConnHeading">
        <div class="panel-header"><div>
            <h2 class="panel-title" id="shopifyConnHeading">${esc(conn.account_label || 'متجر Shopify')}</h2>
            <p class="panel-subtitle" dir="ltr">${esc((conn.base_url || '').replace(/^https:\/\//, ''))}</p>
        </div>${pill(health.tone, health.label)}</div>
        ${facts([
            { label: 'الحالة', value: health.label },
            { label: 'آخر اتصال ناجح', value: conn.last_success_at ? formatDateTime(conn.last_success_at) : '—' },
            { label: 'آخر مزامنة ناجحة', value: conn.last_sync_at ? formatDateTime(conn.last_sync_at) : 'لم تكتمل بعد' },
            { label: 'حالة المزامنة', value: syncStatusLabel(conn.last_sync_status) },
            { label: 'آخر خطأ', value: conn.last_error_code ? `${msg(conn.last_error_code)} (${formatDateTime(conn.last_error_at)})` : 'لا يوجد' },
            { label: 'آخر حدث وصل', value: ev.last_received_at ? formatDateTime(ev.last_received_at) : 'لا أحداث بعد' }
        ])}
        <h3 class="panel-title">الصلاحيات الممنوحة</h3>
        <ul class="company-list">${REQUIRED_SCOPES.map((sc) => `<li>${missing.includes(sc) ? '✗' : '✓'} ${esc(SCOPE_LABELS[sc])}
            ${missing.includes(sc) ? '<span class="pill status-tone-danger">ناقصة — أعد التفويض</span>' : ''}</li>`).join('')}</ul>
        <div class="form-field">
            <label for="shopifyViewRole">من يرى بيانات المتجر داخل التذاكر والبحث</label>
            <select id="shopifyViewRole" class="form-control">${VIEW_ROLE_OPTIONS.map((x) =>
                `<option value="${esc(x.value)}" ${x.value === conn.min_view_role ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>
            <p class="field-hint">ومع ذلك يلزم كل موظف صلاحية «بيانات المتجر في Shopify» من صفحة الأدوار والصلاحيات.</p>
        </div>
        <div class="company-form-actions">
            ${health.action === 'reconnect' ? '' : '<button type="button" class="btn btn-secondary btn-sm" id="shopifyTest">اختبار الاتصال</button>'}
            ${['active', 'error'].includes(conn.status) ? '<button type="button" class="btn btn-secondary btn-sm" id="shopifySync">مزامنة الآن</button>' : ''}
            ${failures.some((f) => f.status === 'dead') ? '<button type="button" class="btn btn-secondary btn-sm" id="shopifyRetry">إعادة الأحداث الفاشلة</button>' : ''}
            <button type="button" class="btn btn-ghost btn-sm" id="shopifyDisconnect">فصل المتجر</button>
        </div>
        ${health.action === 'reconnect' ? `<div class="state-block state-block--compact" role="alert">
            <p class="state-title">${esc(health.label)}</p>
            <p class="state-text">${conn.last_error_code === 'app_uninstalled' ? 'أُزيل تطبيق مدعوم من متجرك في Shopify.' : 'أعد التفويض لاستئناف المزامنة والبحث.'}</p>
            ${connectForm(conn)}</div>` : ''}
    </section>
    <section class="panel" aria-labelledby="shopifyJobsHeading">
        <div class="panel-header"><div><h2 class="panel-title" id="shopifyJobsHeading">المزامنة</h2>
            <p class="panel-subtitle">طلبات آخر 30 يومًا تُزامَن في الخلفية ثم تتحدث بالأحداث، مع مطابقة كل 6 ساعات.</p></div></div>
        ${jobs.length ? `<div class="table-container"><table class="admin-table"><thead><tr>
            <th scope="col">النوع</th><th scope="col">الحالة</th><th scope="col">الطلبات</th><th scope="col">المحاولات</th><th scope="col">البداية</th><th scope="col">النهاية</th></tr></thead>
            <tbody>${jobs.map((j) => `<tr><td>${esc({ initial: 'أولى', incremental: 'تزايدية', manual: 'يدوية' }[j.kind] || j.kind)}</td>
                <td>${esc(syncStatusLabel(j.status))}${j.last_error_code ? `<br><span class="field-hint">${esc(msg(j.last_error_code))}</span>` : ''}</td>
                <td>${esc(j.records)}</td><td>${esc(j.attempts)}</td><td>${esc(formatDateTime(j.started_at || j.created_at))}</td>
                <td>${esc(j.finished_at ? formatDateTime(j.finished_at) : '—')}</td></tr>`).join('')}</tbody></table></div>`
            : '<p class="panel-subtitle">لا مهام مزامنة بعد.</p>'}
        <h3 class="panel-title">أحداث Shopify (آخر 7 أيام)</h3>
        ${facts(Object.entries(ev.last_7_days || {}).map(([k, n]) => ({ label: { processed: 'عولجت', ignored: 'تُجوهلت', queued: 'في الطابور',
            failed: 'فشلت وستُعاد', dead: 'توقفت', received: 'وصلت' }[k] || k, value: String(n) })))}
        ${failures.length ? `<ul class="company-list">${failures.map((f) => `<li>${esc(f.topic)} — ${esc(f.status === 'dead' ? 'توقفت' : 'ستُعاد')}
            (${esc(msg(f.last_error_code))}) <span class="field-hint">${esc(formatDateTime(f.received_at))}</span></li>`).join('')}</ul>` : ''}
    </section>
    <section class="panel" aria-labelledby="shopifyComplianceHeading">
        <div class="panel-header"><div><h2 class="panel-title" id="shopifyComplianceHeading">طلبات الخصوصية من Shopify</h2>
            <p class="panel-subtitle">حذف بيانات العميل يُنفَّذ تلقائيًا فور وصوله. طلبات «بيانات العميل» تُصدَّر من هنا خلال 30 يومًا.</p></div></div>
        ${compliance.length ? `<ul class="company-list">${compliance.map((q) => `<li>${esc({ 'customers/data_request': 'طلب بيانات عميل',
            'customers/redact': 'حذف بيانات عميل', 'shop/redact': 'حذف بيانات المتجر' }[q.topic] || q.topic)}
            — ${esc(q.status === 'completed' ? 'مكتمل' : 'بانتظار التصدير')} <span class="field-hint">${esc(formatDateTime(q.received_at))}</span>
            ${q.topic === 'customers/data_request' && q.status === 'received'
                ? `<button type="button" class="btn btn-secondary btn-sm" data-export="${esc(q.id)}">تصدير</button>` : ''}</li>`).join('')}</ul>`
            : '<p class="panel-subtitle">لا طلبات.</p>'}
    </section>`;
    wireConnect(c, conn);
    $('shopifyTest')?.addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        const t = await testConnection(conn.id);
        toast(t.ok && t.data?.ok ? 'الاتصال يعمل.' : msg(t.data?.error || t.code), t.ok && t.data?.ok ? 'success' : 'error');
        loadShopifyPage();
    });
    $('shopifySync')?.addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        const t = await requestSync(conn.id);
        toast(t.ok ? 'أُضيفت مزامنة للطابور — تبدأ خلال دقائق.' : msg(t.code, t.error), t.ok ? 'success' : 'error');
        loadShopifyPage();
    });
    $('shopifyRetry')?.addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        const t = await retryFailedEvents(conn.id);
        toast(t.ok ? `أُعيد ${t.data?.requeued ?? 0} حدثًا للطابور.` : msg(t.code, t.error), t.ok ? 'success' : 'error');
        loadShopifyPage();
    });
    $('shopifyViewRole')?.addEventListener('change', async (e) => {
        const t = await setConnectionViewRole(conn.id, e.currentTarget.value);
        toast(t.ok ? 'تم الحفظ.' : msg(t.code, t.error), t.ok ? 'success' : 'error');
    });
    $('shopifyDisconnect')?.addEventListener('click', async (e) => {
        const okToGo = await ui.showConfirm('فصل متجر Shopify',
            'تُحذف الرموز والنسخ المخزّنة من مدعوم فورًا، وتبقى التذاكر وطلبات المتابعة. لإيقاف وصول التطبيق نهائيًا أزله أيضًا من لوحة Shopify (الإعدادات ← التطبيقات).',
            { confirmLabel: 'فصل المتجر', cancelLabel: 'تراجع' });
        if (!okToGo) return;
        e.currentTarget.disabled = true;
        const t = await disconnectConnection(conn.id);
        toast(t.ok ? 'فُصل المتجر.' : msg(t.code, t.error), t.ok ? 'success' : 'error');
        loadShopifyPage();
    });
    c.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', async () => {
        b.disabled = true;
        const t = await exportCompliance(b.getAttribute('data-export'));
        if (!t.ok) { toast(msg(t.code, t.error), 'error'); b.disabled = false; return; }
        const blob = new Blob([JSON.stringify(t.data, null, 2)], { type: 'application/json' });
        const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `shopify-data-request-${b.getAttribute('data-export')}.json` });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        loadShopifyPage();
    }));
}

function wireConnect(root, conn) {
    root.querySelectorAll('#shopifyConnectForm').forEach((form) => form.addEventListener('submit', (e) => {
        e.preventDefault();
        const err = form.querySelector('#shopifyConnectError');
        const shop = normalizeShop(form.shop.value);
        if (!shop) { err.textContent = msg('invalid_shop'); err.hidden = false; form.shop.setAttribute('aria-invalid', 'true'); return; }
        err.hidden = true;
        beginConnect(shop, conn, form.querySelector('button[type="submit"]'));
    }));
}

/* ══ العملاء والطلبات ══════════════════════════════════════════════════════ */

const KIND_LABELS = { order: 'الطلبات', customer: 'العملاء', product: 'المنتجات' };
let lastSearch = { kind: 'order', query: '', page: null };

export async function loadStoreOrders() {
    const c = $('storeOrdersBody');
    if (!c) return;
    renderSkeletonLines(c, 3);
    const r = await ensureOverview();
    if (!r.ok) { renderState(c, { variant: 'error', title: 'تعذّر التحميل', text: msg(r.code, r.error) }); return; }
    const conn = r.data.connection;
    if (!conn || !['active', 'error'].includes(conn.status)) {
        renderState(c, { variant: 'empty', title: 'لا متجر Shopify متصل', text: 'يربط مدير المتجر Shopify من صفحة «Shopify» أولًا.' });
        return;
    }
    c.innerHTML = `
        <form class="toolbar owner-filters" id="storeSearchForm" role="search" novalidate>
            <label class="visually-hidden" for="storeSearchKind">ابحث في</label>
            <select id="storeSearchKind" class="form-control">${Object.entries(KIND_LABELS).map(([k, l]) =>
                `<option value="${k}" ${k === lastSearch.kind ? 'selected' : ''}>${l}</option>`).join('')}</select>
            <label class="visually-hidden" for="storeSearchText">نص البحث</label>
            <input type="search" id="storeSearchText" class="form-control" maxlength="80" autocomplete="off"
                   placeholder="رقم الطلب، البريد، الاسم أو اسم المنتج" value="${esc(lastSearch.query)}">
            <button type="submit" class="btn btn-primary btn-sm">بحث</button>
        </form>
        <p class="field-hint">بحث حي في Shopify — كل عرض يُسجَّل في سجل الوصول. البيانات المحمية التي لم يعتمدها Shopify لتطبيق مدعوم تظهر غائبة.</p>
        <div id="storeSearchResults" aria-live="polite"></div>
        <div id="storeRecordDetail" aria-live="polite"></div>`;
    $('storeSearchForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const kind = $('storeSearchKind').value;
        const query = $('storeSearchText').value.trim();
        if (!validSearchText(query)) { toast('اكتب نصًا قصيرًا بلا رموز خاصة.', 'error'); return; }
        lastSearch = { kind, query, page: null };
        runSearch(conn.id);
    });
    if (lastSearch.query) runSearch(conn.id);
}

async function runSearch(connectionId, after = null) {
    const box = $('storeSearchResults');
    renderSkeletonLines(box, 3);
    const r = await searchShopify(connectionId, lastSearch.kind, lastSearch.query, after);
    if (!r.ok) { renderState(box, { variant: 'error', title: 'تعذّر البحث', text: msg(r.code) }); return; }
    const items = r.data.items || [];
    box.innerHTML = items.length ? `<ul class="company-list">${items.map((x) => {
        const v = searchItem(lastSearch.kind, x);
        return `<li><button type="button" class="btn btn-ghost btn-sm" data-open="${esc(v.id)}">${esc(v.title)}</button>
            <span class="field-hint">${esc(v.meta)}</span></li>`;
    }).join('')}</ul>${r.data.page?.has_next ? '<button type="button" class="btn btn-secondary btn-sm" id="storeSearchMore">المزيد</button>' : ''}
        ${r.data.restricted ? '<p class="field-hint">بعض الحقول محجوبة: Shopify لم يعتمد بعد وصول التطبيق لبيانات العملاء المحمية.</p>' : ''}`
        : '<p class="panel-subtitle">لا نتائج.</p>';
    box.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openRecord(connectionId, lastSearch.kind, b.getAttribute('data-open'))));
    $('storeSearchMore')?.addEventListener('click', () => runSearch(connectionId, r.data.page.cursor));
}

async function openRecord(connectionId, kind, id) {
    const box = $('storeRecordDetail');
    renderSkeletonLines(box, 4);
    const [live, ctx] = await Promise.all([getShopify(connectionId, kind, id), fetchRecordContext(connectionId, kind, id)]);
    if (!live.ok) { renderState(box, { variant: 'error', title: 'تعذّر عرض السجل', text: msg(live.code) }); return; }
    const rec = live.data.record;
    const s = rec.summary || {};
    const mctx = ctx.ok ? ctx.data : null;
    const rows = kind === 'order' ? orderRows(s) : kind === 'customer' ? customerRows(s) : productRows(s);
    const tracking = kind === 'order' ? trackingList(s) : [];
    const items = kind === 'order' ? lineItems(s) : [];
    const contact = live.data.contact || null;
    box.innerHTML = `<section class="panel ihub-record" aria-labelledby="storeRecHeading">
        <div class="panel-header"><div>
            <h2 class="panel-title" id="storeRecHeading">${esc(rec.display_ref || id)}</h2>
            <p class="panel-subtitle">بيانات حية من Shopify الآن${s.deleted_in_provider ? ' · حُذف في Shopify' : ''}</p>
        </div>${rec.external_url ? `<a class="btn btn-secondary btn-sm" href="${esc(rec.external_url)}" target="_blank" rel="noopener noreferrer">فتح في Shopify</a>` : ''}</div>
        ${facts(rows)}
        ${contact && (contact.email || contact.phone) ? facts([contact.email ? { label: 'البريد', value: contact.email } : null,
            contact.phone ? { label: 'الهاتف', value: contact.phone } : null].filter(Boolean)) : ''}
        ${items.length ? `<div class="table-container"><table class="admin-table"><thead><tr><th scope="col">المنتج</th><th scope="col">SKU</th>
            <th scope="col">الكمية</th><th scope="col">السعر</th></tr></thead><tbody>${items.map((i) => `<tr><td>${esc(i.title)}${i.variant ? ` — ${esc(i.variant)}` : ''}</td>
            <td dir="ltr">${esc(i.sku || '—')}</td><td>${esc(i.quantity ?? '—')}</td><td>${esc(i.price || '—')}</td></tr>`).join('')}</tbody></table></div>` : ''}
        ${tracking.length ? `<h3 class="panel-title">الشحن والتتبّع</h3><ul class="company-list">${tracking.map((t) => `<li>${esc(t.status || '')}
            ${t.company ? esc(t.company) : ''} ${t.number ? `<span dir="ltr">${esc(t.number)}</span>` : ''}
            ${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">تتبّع</a>` : ''}
            ${t.eta ? `<span class="field-hint">الوصول المتوقع ${esc(t.eta)}</span>` : ''}</li>`).join('')}</ul>` : ''}
        ${kind === 'customer' && (live.data.orders || []).length ? `<h3 class="panel-title">آخر الطلبات</h3><ul class="company-list">${live.data.orders.map((o) => {
            const v = searchItem('order', o);
            return `<li><button type="button" class="btn btn-ghost btn-sm" data-open-order="${esc(v.id)}">${esc(v.title)}</button> <span class="field-hint">${esc(v.meta)}</span></li>`;
        }).join('')}</ul>` : ''}
        ${mctx ? mad3oomContext(kind, mctx) : ''}
        ${kind === 'order' && mctx?.record_id ? `<div class="company-form-actions">
            <button type="button" class="btn btn-primary btn-sm" id="storeNewRequest">تسجيل طلب متابعة لهذا الطلب</button></div>
            <p class="field-hint">${esc(NOT_EXECUTED_NOTE)}</p>` : ''}
    </section>`;
    box.querySelectorAll('[data-open-order]').forEach((b) => b.addEventListener('click', () => openRecord(connectionId, 'order', b.getAttribute('data-open-order'))));
    $('storeNewRequest')?.addEventListener('click', () => openRequestDialog({ recordId: mctx.record_id, orderRef: rec.display_ref }));
}

function mad3oomContext(kind, ctx) {
    const tickets = ctx.tickets || [];
    const requests = ctx.requests || [];
    const convs = ctx.conversations || [];
    return `<h3 class="panel-title">في مدعوم</h3>
        ${kind === 'customer' ? `<p class="panel-subtitle">${ctx.linked_customer ? `مربوط بعميل مدعوم: ${esc(ctx.linked_customer.name)}`
            : 'غير مربوط بعميل في مدعوم. الربط يدوي من مدير المتجر — لا دمج تلقائي بالبريد أو الاسم.'}</p>` : ''}
        ${tickets.length ? `<ul class="company-list">${tickets.map((t) => `<li><a href="#customerTickets" data-tab="customerTickets">#${esc(t.ticket_number)}</a>
            ${esc(t.title)} <span class="field-hint">${esc(t.status)}</span></li>`).join('')}</ul>` : '<p class="panel-subtitle">لا تذاكر مرتبطة.</p>'}
        ${requests.length ? `<ul class="company-list">${requests.map((q) => `<li>${esc(REQUEST_KINDS[q.kind] || q.kind)} —
            ${pill(REQUEST_STATUSES[q.status]?.pill?.replace('status-tone-', '') || 'neutral', REQUEST_STATUSES[q.status]?.label || q.status)}</li>`).join('')}</ul>` : ''}
        ${convs.length ? `<p class="panel-subtitle">${convs.length} محادثة مع العميل في صندوق الرسائل.</p>` : ''}
        ${ctx.cached === false && kind === 'order' ? '<p class="field-hint">هذا الطلب خارج نافذة المزامنة (30 يومًا) — اربطه بتذكرة لتسجيل طلب متابعة.</p>' : ''}`;
}

/* ══ طلبات المتابعة ═══════════════════════════════════════════════════════ */

async function ensureStaff() {
    if (!staff) {
        const r = await fetchStaff();
        staff = r.ok && Array.isArray(r.data) ? r.data : [];
    }
    return staff;
}

function staffOptions(selected) {
    return `<option value="">بلا إسناد</option>${(staff || []).map((m) => `<option value="${esc(m.user_id)}" ${m.user_id === selected ? 'selected' : ''}>
        ${esc(m.name)}</option>`).join('')}`;
}

async function openRequestDialog({ recordId = null, ticketId = null, orderRef = null }) {
    await ensureStaff();
    const opener = document.activeElement;
    const wrap = document.createElement('div');
    wrap.className = 'modal active';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', 'storeReqDlgTitle');
    wrap.innerHTML = `<div class="modal-content modal-sm">
        <div class="modal-head"><div>
            <h2 id="storeReqDlgTitle">طلب متابعة ${orderRef ? esc(orderRef) : ''}</h2>
            <p class="panel-subtitle">${esc(NOT_EXECUTED_NOTE)}</p></div>
            <button type="button" class="modal-close" data-close aria-label="إغلاق">&times;</button></div>
        <form class="company-form" novalidate>
        <div class="form-grid">
            <div class="form-field"><label for="storeReqKind">النوع</label><select id="storeReqKind" class="form-control" name="kind">
                ${Object.entries(REQUEST_KINDS).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></div>
            <div class="form-field"><label for="storeReqAssignee">مسند إلى</label><select id="storeReqAssignee" class="form-control" name="assignee">${staffOptions(null)}</select></div>
            <div class="form-field"><label for="storeReqDue">موعد المتابعة</label><input id="storeReqDue" type="datetime-local" class="form-control" name="due"></div>
            <div class="form-field is-full"><label for="storeReqNote">ملاحظة داخلية</label><textarea id="storeReqNote" class="form-control" name="note" maxlength="1000" rows="3"></textarea></div>
        </div>
        <p class="field-error" role="alert" hidden></p>
        <div class="company-form-actions"><button type="submit" class="btn btn-primary">تسجيل الطلب</button>
            <button type="button" class="btn btn-ghost" data-close>إلغاء</button></div></form></div>`;
    document.body.appendChild(wrap);
    const form = wrap.querySelector('form');
    const close = () => { wrap.remove(); opener?.focus?.(); };
    wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    form.kind.focus();
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        const due = form.due.value ? new Date(form.due.value).toISOString() : null;
        const r = await createRequest({ kind: form.kind.value, ticketId, recordId, note: form.note.value.trim() || null,
                                        assignedTo: form.assignee.value || null, dueAt: due });
        button.disabled = false;
        if (!r.ok) { const err = form.querySelector('.field-error'); err.textContent = msg(r.code, r.error); err.hidden = false; return; }
        close();
        toast('سُجّل طلب المتابعة. نفّذ أي إلغاء أو استرداد من لوحة Shopify.', 'success');
        if ($('storeRequestsBody')?.closest('.tab-content')?.classList.contains('active')) loadStoreRequests();
        document.dispatchEvent(new CustomEvent('store:request-created', { detail: { ticketId } }));
    });
}

export { openRequestDialog };

let requestFilter = { status: 'open', kind: '' };

export async function loadStoreRequests() {
    const c = $('storeRequestsBody');
    if (!c) return;
    renderSkeletonLines(c, 4);
    const [r] = await Promise.all([fetchRequests({ status: requestFilter.status || null, kind: requestFilter.kind || null }), ensureStaff()]);
    if (!r.ok) { renderState(c, { variant: 'error', title: 'تعذّر تحميل طلبات المتابعة', text: msg(r.code, r.error) }); return; }
    const role = viewerRole();
    const items = r.data?.items || [];
    c.innerHTML = `
        <p class="state-text" role="note">${esc(NOT_EXECUTED_NOTE)}</p>
        <form class="toolbar owner-filters" id="storeReqFilters" novalidate>
            <label class="visually-hidden" for="storeReqStatus">الحالة</label>
            <select id="storeReqStatus" class="form-control"><option value="open">المفتوحة</option><option value="">الكل</option>
                ${Object.entries(REQUEST_STATUSES).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select>
            <label class="visually-hidden" for="storeReqKindF">النوع</label>
            <select id="storeReqKindF" class="form-control"><option value="">كل الأنواع</option>
                ${Object.entries(REQUEST_KINDS).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>
        </form>
        <p class="field-hint">${esc(r.data?.total ?? 0)} طلب</p>
        ${items.length ? `<div class="table-container"><table class="admin-table"><thead><tr><th scope="col">الطلب</th><th scope="col">النوع</th>
            <th scope="col">الحالة</th><th scope="col">مسند إلى</th><th scope="col">موعد المتابعة</th><th scope="col"></th></tr></thead><tbody>
            ${items.map((q) => `<tr data-req="${esc(q.id)}"><td>${esc(q.order_ref || (q.ticket_number ? `تذكرة #${q.ticket_number}` : '—'))}</td>
                <td>${esc(REQUEST_KINDS[q.kind] || q.kind)}</td>
                <td><select class="form-control" data-status aria-label="حالة الطلب">${allowedStatuses(q.status, role).map((st) =>
                    `<option value="${st}" ${st === q.status ? 'selected' : ''}>${esc(REQUEST_STATUSES[st].label)}</option>`).join('')}</select></td>
                <td><select class="form-control" data-assignee aria-label="مسند إلى">${staffOptions(q.assigned_to)}</select></td>
                <td>${q.due_at ? `${esc(formatDateTime(q.due_at))}${q.overdue ? ' <span class="pill status-tone-warning">متأخر</span>' : ''}` : '—'}</td>
                <td><button type="button" class="btn btn-secondary btn-sm" data-save>حفظ</button></td></tr>`).join('')}
            </tbody></table></div>` : '<p class="panel-subtitle">لا طلبات مطابقة.</p>'}
        ${role === 'admin' ? '<section class="panel" id="storeCategoriesPanel" aria-labelledby="storeCatHeading"></section>' : ''}`;
    $('storeReqStatus').value = requestFilter.status;
    $('storeReqKindF').value = requestFilter.kind;
    ['storeReqStatus', 'storeReqKindF'].forEach((id) => $(id).addEventListener('change', () => {
        requestFilter = { status: $('storeReqStatus').value, kind: $('storeReqKindF').value };
        loadStoreRequests();
    }));
    c.querySelectorAll('tr[data-req]').forEach((tr) => tr.querySelector('[data-save]').addEventListener('click', async (e) => {
        const id = tr.getAttribute('data-req');
        const q = items.find((x) => x.id === id);
        const status = tr.querySelector('[data-status]').value;
        const assignee = tr.querySelector('[data-assignee]').value;
        let resolutionNote = null;
        if (status === 'resolved' && q.status !== 'resolved') {
            const ok = await ui.showConfirm('إغلاق الطلب في مدعوم', 'الإغلاق هنا لا ينفّذ أي استرداد أو إلغاء في Shopify. تأكد أن الإجراء نُفّذ في Shopify أولًا إن لزم.',
                                           { confirmLabel: 'إغلاق الطلب', cancelLabel: 'تراجع' });
            if (!ok) return;
            resolutionNote = 'أُغلق من لوحة المتجر';
        }
        e.currentTarget.disabled = true;
        const res = await updateRequest(id, {
            status: status !== q.status ? status : null, resolutionNote,
            assignedTo: assignee && assignee !== q.assigned_to ? assignee : null, unassign: !assignee && !!q.assigned_to
        });
        toast(res.ok ? 'تم الحفظ.' : msg(res.code, res.error), res.ok ? 'success' : 'error');
        loadStoreRequests();
    }));
    if (role === 'admin') renderCategories();
}

async function renderCategories() {
    const panel = $('storeCategoriesPanel');
    if (!panel) return;
    const r = await fetchCategories();
    categories = r.ok && Array.isArray(r.data) ? r.data : [];
    panel.innerHTML = `<div class="panel-header"><div><h2 class="panel-title" id="storeCatHeading">تصنيفات دعم المتجر</h2>
        <p class="panel-subtitle">تظهر عند تصنيف تذاكر عملاء المتجر. الإيقاف يخفي التصنيف من الاختيار ولا يمس التذاكر المصنّفة.</p></div></div>
        <ul class="company-list">${categories.map((cat) => `<li><label><input type="checkbox" data-cat="${esc(cat.key)}" ${cat.is_active ? 'checked' : ''}>
            ${esc(cat.label_ar)}</label> ${cat.is_default ? '' : '<span class="field-hint">مخصّص</span>'}</li>`).join('')}</ul>
        <form class="company-form" id="storeCatForm" novalidate><div class="form-grid">
            <div class="form-field"><label for="storeCatKey">المفتاح (إنجليزي)</label><input id="storeCatKey" name="key" class="form-control" dir="ltr" pattern="[a-z][a-z0-9_]{1,39}" required></div>
            <div class="form-field"><label for="storeCatLabel">الاسم</label><input id="storeCatLabel" name="label" class="form-control" maxlength="60" required></div>
            <div class="form-field"><label for="storeCatLabelEn">الاسم بالإنجليزية</label><input id="storeCatLabelEn" name="labelEn" class="form-control" dir="ltr" maxlength="60"></div>
        </div><div class="company-form-actions"><button type="submit" class="btn btn-secondary btn-sm">إضافة تصنيف</button></div></form>`;
    panel.querySelectorAll('[data-cat]').forEach((cb) => cb.addEventListener('change', async () => {
        const cat = categories.find((x) => x.key === cb.getAttribute('data-cat'));
        const res = await saveCategory({ key: cat.key, labelAr: cat.label_ar, labelEn: cat.label_en, active: cb.checked });
        if (!res.ok) { toast(msg(res.code, res.error), 'error'); cb.checked = !cb.checked; }
    }));
    $('storeCatForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.currentTarget;
        if (!/^[a-z][a-z0-9_]{1,39}$/.test(f.key.value) || f.label.value.trim().length < 2) { toast(msg('validation_failed'), 'error'); return; }
        const res = await saveCategory({ key: f.key.value, labelAr: f.label.value.trim(), labelEn: f.labelEn.value.trim() });
        toast(res.ok ? 'أُضيف التصنيف.' : msg(res.code, res.error), res.ok ? 'success' : 'error');
        if (res.ok) renderCategories();
    });
}

/* ══ التقارير ═════════════════════════════════════════════════════════════ */

let reportDays = 30;

export async function loadStoreReports() {
    const c = $('storeReportsBody');
    if (!c) return;
    renderSkeletonLines(c, 4);
    const r = await fetchStoreReport(reportDays);
    if (!r.ok) { renderState(c, { variant: 'error', title: 'تعذّر بناء تقرير المتجر', text: msg(r.code, r.error) }); return; }
    const d = r.data;
    const catLabels = Object.fromEntries((categories || []).map((x) => [x.key, x.label_ar]));
    const dist = (title, rows) => `<section class="panel"><h3 class="panel-title">${esc(title)}</h3>${rows.length
        ? `<ul class="company-list">${rows.map((x) => `<li>${esc(x.label)} <strong>${esc(x.count)}</strong></li>`).join('')}</ul>`
        : '<p class="panel-subtitle">لا بيانات في هذه الفترة.</p>'}</section>`;
    c.innerHTML = `
        <form class="toolbar owner-filters" novalidate><label for="storeReportDays">الفترة</label>
            <select id="storeReportDays" class="form-control">${[7, 30, 90].map((n) => `<option value="${n}" ${n === reportDays ? 'selected' : ''}>آخر ${n} يومًا</option>`).join('')}</select></form>
        ${kpiHtml(reportCards(d))}
        <div class="company-overview-grid">
            ${dist('أكثر تصنيفات الشكاوى', distributionRows(d.categories, catLabels))}
            ${dist('طلبات المتابعة حسب النوع', distributionRows(d.requests_by_kind, REQUEST_KINDS))}
            ${dist('طلبات المتابعة حسب الحالة', distributionRows(d.requests_by_status, Object.fromEntries(Object.entries(REQUEST_STATUSES).map(([k, v]) => [k, v.label]))))}
            ${dist('أحداث Shopify', distributionRows(d.integration?.webhook_events))}
        </div>
        <p class="field-hint">الأرقام محسوبة في القاعدة من تذاكر الشركة التي تملك رؤيتها، من ${esc(formatDateTime(d.from))} إلى ${esc(formatDateTime(d.to))}.</p>`;
    $('storeReportDays').addEventListener('change', (e) => { reportDays = Number(e.currentTarget.value); loadStoreReports(); });
}

/** لاختبارات العرض والاستعمال من صفحات أخرى. */
export const _internal = { isStale };
