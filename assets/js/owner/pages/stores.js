/**
 * owner/stores.html — حسابات المتاجر وربط Shopify تحت إشراف المالك (118/119).
 *
 *   • owner_accounts_overview / owner_store_integrations / owner_store_events / owner_entitlement_diagnostics:
 *     owner_capability('owner_only') في القاعدة — بيانات وصفية فقط (حالات، رموز أخطاء، أوقات، عدّادات).
 *   • ihub-api shopify_config: هل قيم إعداد التطبيق موجودة على الخادم؟ (منطقي فقط، لا قيمة)
 *   • owner_set_company_account_kind / owner_store_test_entitlements: owner_critical_ok() — سياق المالك + تحقق
 *     حديث، ومدقّقة في privileged_audit. تعملان على شركة المالك نفسه فقط (متجر الاختبار).
 *   • المعاينة: سياقات المالك القائمة (040/041) — «مدير شركتي» للتشغيل، و«معاينة عضو» للقراءة فقط.
 *     لا انتحال لتاجر ولا تجاوز للعزل.
 */
import {
    supabase, bootOwnerPage, announce, esc, when, num, table, kpis, errorBlock, loadingBlock, stateBlock, openModal,
    friendlyError, renderPager
} from '/assets/js/owner/owner-page.js';
import { searchTerm } from '/assets/js/owner/owner-labels.js';

const $ = (id) => document.getElementById(id);
const say = (text, tone = 'info') => announce($('pageStatus'), text, tone);
const PAGE_SIZE = 25;
const TYPE_LABELS = { individual: 'فرد', company: 'شركة', ecommerce_store: 'متجر إلكتروني' };
const CONN_LABELS = { pending: 'بانتظار التفويض', active: 'متصل', error: 'خطأ', reauth_required: 'يحتاج إعادة تفويض' };
const SUB_LABELS = { active: 'فعّال', pending: 'قيد المراجعة', expired: 'منتهٍ', rejected: 'مرفوض', superseded: 'مستبدل' };

let session = null;
let accounts = { page: 0, total: 0, items: [], counts: {} };
let integrations = null;
let diagnostics = null;

async function rpc(name, args) {
    const { data, error } = await supabase.rpc(name, args);
    return { data, error };
}

async function loadAccounts(page = 0) {
    $('accountsTable').innerHTML = loadingBlock();
    const { data, error } = await rpc('owner_accounts_overview', {
        p_type: $('accountsType').value || null, p_search: searchTerm($('accountsSearch').value) || null,
        p_limit: PAGE_SIZE, p_offset: page * PAGE_SIZE
    });
    if (error) { $('accountsTable').innerHTML = errorBlock(friendlyError(error)); return; }
    accounts = { page, total: data?.total || 0, items: data?.items || [], counts: data?.counts || {} };
    $('accountsTable').innerHTML = table(['الحساب', 'النوع', 'الاشتراك', 'Shopify', 'أُنشئ'], accounts.items, (a) => `<tr>
        <td><div class="owner-account"><span class="owner-account-name">${esc(a.company_name || a.name || '—')}</span>
            <span class="owner-account-email">${esc(a.company_name ? a.name : a.email || '')}</span></div></td>
        <td><span class="pill ${a.account_type === 'ecommerce_store' ? 'status-tone-accent' : 'status-neutral'}">${esc(TYPE_LABELS[a.account_type] || a.account_type)}</span>
            ${a.company_status === 'suspended' ? '<span class="pill status-rejected">موقوفة</span>' : ''}</td>
        <td>${a.subscription ? `${esc(a.subscription.plan_name || a.subscription.plan)} — ${esc(SUB_LABELS[a.subscription.status] || a.subscription.status)}
            ${a.subscription.effective ? '' : '<br><span class="owner-account-email">غير سارٍ الآن</span>'}` : '—'}</td>
        <td>${a.shopify ? `${esc(CONN_LABELS[a.shopify.status] || a.shopify.status)}<br><span class="owner-account-email owner-mono" dir="ltr">${esc(a.shopify.shop || '')}</span>
            ${a.shopify.last_error_code ? `<br><span class="owner-account-email">${esc(a.shopify.last_error_code)}</span>` : ''}` : '—'}</td>
        <td>${esc(when(a.created_at))}</td></tr>`, { empty: 'لا حسابات مطابقة.' });
    renderPager($('accountsPager'), { page, size: PAGE_SIZE, total: accounts.total, onPage: loadAccounts,
        text: `${num(accounts.total)} حساب` });
    renderKpis();
}

async function loadIntegrations() {
    $('storeIntegrations').innerHTML = loadingBlock();
    const { data, error } = await rpc('owner_store_integrations');
    if (error) { $('storeIntegrations').innerHTML = errorBlock(friendlyError(error)); integrations = null; renderKpis(); return; }
    integrations = data;
    const rows = data?.connections || [];
    const provider = data?.provider || {};
    $('storeIntegrations').innerHTML = `
        <p class="panel-subtitle">مزوّد Shopify على المنصة: <strong>${provider.enabled ? 'مفعّل' : 'مقفل'}</strong> (${esc(provider.release_stage || 'beta')}) ·
            الصلاحيات المطلوبة: <span dir="ltr">${esc((data?.required_scopes || []).join(', '))}</span>
            ${data?.compliance_unmatched_30d ? ` · طلبات خصوصية لمتاجر غير مربوطة (30 يومًا): ${esc(num(data.compliance_unmatched_30d))}` : ''}</p>
        ${table(['المتجر', 'الحالة', 'الصلاحيات', 'المزامنة', 'الأحداث (7 أيام)', 'الامتياز', ''], rows, (c) => `<tr>
            <td><div class="owner-account"><span class="owner-account-name">${esc(c.company_name)}</span>
                <span class="owner-account-email owner-mono" dir="ltr">${esc(c.shop || '—')}</span></div></td>
            <td>${esc(CONN_LABELS[c.status] || c.status)}${c.last_error_code ? `<br><span class="owner-account-email">${esc(c.last_error_code)} · ${esc(when(c.last_error_at))}</span>` : ''}
                ${c.has_credentials ? '' : '<br><span class="owner-account-email">لا رموز مخزّنة</span>'}</td>
            <td>${(c.missing_scopes || []).length ? `<span class="pill status-rejected">ناقصة: ${esc(c.missing_scopes.join(', '))}</span>` : '<span class="pill status-resolved">كاملة</span>'}</td>
            <td>${esc(c.last_sync_status || '—')}<br><span class="owner-account-email">${esc(when(c.last_sync_at))}</span>
                ${c.sync_failures_7d ? `<br><span class="owner-account-email">فشل: ${esc(num(c.sync_failures_7d))}</span>` : ''}</td>
            <td>${Object.entries(c.events_7d || {}).map(([k, n]) => `${esc(k)}: ${esc(num(n))}`).join('<br>') || '—'}
                ${c.compliance_pending ? `<br><span class="pill status-neutral">خصوصية معلّقة: ${esc(num(c.compliance_pending))}</span>` : ''}</td>
            <td>${c.entitled ? '<span class="pill status-resolved">مستحق</span>' : '<span class="pill status-rejected">بلا امتياز</span>'}</td>
            <td><button type="button" class="btn btn-outline btn-sm" data-events="${esc(c.connection_id)}">السجل</button></td></tr>`,
            { empty: 'لا متاجر مربوطة بـ Shopify بعد.' })}`;
    $('storeIntegrations').querySelectorAll('[data-events]').forEach((b) => b.addEventListener('click', () => openEvents(b.getAttribute('data-events'))));
    renderKpis();
}

async function openEvents(connectionId) {
    const { data, error } = await rpc('owner_store_events', { p_connection: connectionId, p_limit: 30 });
    if (error) { say(friendlyError(error), 'error'); return; }
    openModal({
        title: 'سجل ربط المتجر', wide: true,
        html: `<h3 class="panel-title">مهام المزامنة</h3>${table(['النوع', 'الحالة', 'صفحات', 'طلبات', 'محاولات', 'الخطأ', 'البداية', 'النهاية'], data.jobs || [], (j) => `<tr>
                <td>${esc(j.kind)}</td><td>${esc(j.status)}</td><td>${esc(num(j.pages))}</td><td>${esc(num(j.records))}</td><td>${esc(num(j.attempts))}</td>
                <td>${esc(j.last_error_code || '—')}</td><td>${esc(when(j.created_at))}</td><td>${esc(when(j.finished_at))}</td></tr>`, { empty: 'لا مهام.' })}
            <h3 class="panel-title">أحداث فاشلة أو معلّقة</h3>${table(['الموضوع', 'الحالة', 'محاولات', 'الخطأ', 'وصل'], data.events || [], (e) => `<tr>
                <td dir="ltr">${esc(e.topic)}</td><td>${esc(e.status)}</td><td>${esc(num(e.attempts))}</td><td>${esc(e.last_error_code || '—')}</td>
                <td>${esc(when(e.received_at))}</td></tr>`, { empty: 'لا أحداث فاشلة.' })}
            <h3 class="panel-title">التدقيق</h3>${table(['العملية', 'الفاعل', 'الوقت'], data.audit || [], (a) => `<tr><td dir="ltr">${esc(a.action)}</td>
                <td>${esc(a.actor_kind)}</td><td>${esc(when(a.created_at))}</td></tr>`, { empty: 'لا شيء.' })}`
    });
}

async function loadDiagnostics() {
    $('storeDiagnostics').innerHTML = loadingBlock();
    const [{ data, error }, cfg] = await Promise.all([
        rpc('owner_entitlement_diagnostics'),
        supabase.functions.invoke('ihub-api', { body: { action: 'shopify_config' } }).catch((e) => ({ error: e }))
    ]);
    if (error) { $('storeDiagnostics').innerHTML = errorBlock(friendlyError(error)); diagnostics = null; renderKpis(); return; }
    diagnostics = data;
    const plan = data?.store_plan;
    const conf = cfg?.data;
    const mismatch = data?.live_connection_without_entitlement || [];
    $('storeDiagnostics').innerHTML = `
        <h3 class="panel-title">إعداد تطبيق Shopify على الخادم</h3>
        ${conf ? `${table(['القيمة', 'موجودة'], Object.entries(conf.configured || {}), ([k, v]) => `<tr><td dir="ltr">${esc(k)}</td>
            <td>${v ? '<span class="pill status-resolved">نعم</span>' : '<span class="pill status-rejected">لا</span>'}</td></tr>`)}
            <p class="panel-subtitle">إصدار API: <span dir="ltr">${esc(conf.api_version)}</span> ·
                رابط الرجوع يطابق المتوقع: ${conf.redirect_matches_callback ? 'نعم' : '<strong>لا — صحّح SHOPIFY_REDIRECT_URI</strong>'}</p>
            ${conf.urls ? `<p class="panel-subtitle owner-mono" dir="ltr">${esc(conf.urls.callback)}<br>${esc(conf.urls.webhooks)}</p>` : ''}`
            : stateBlock({ title: 'تعذّر فحص إعداد الخادم', text: 'الدالة الطرفية ihub-api غير منشورة بهذا الإصدار بعد، أو رفضت الطلب.' })}
        <h3 class="panel-title">باقة المتاجر</h3>
        ${plan ? `<p class="panel-subtitle">${plan.is_active ? 'مفعّلة' : 'غير مفعّلة'} · السعر الشهري: ${esc(plan.price_monthly ?? 'لم يُحدد')} ·
            السنوي: ${esc(plan.price_yearly ?? 'لم يُحدد')} ${esc(plan.currency || '')} · حد التذاكر: ${plan.ticket_quota_defined ? 'محدد' : 'غير محدد'}<br>
            المزايا: <span dir="ltr">${esc((plan.features || []).join(', '))}</span></p>
            <p class="field-hint">السعر والمزايا قرار المالك. القاعدة ترفض تفعيل الباقة بلا سعرين موجبين (subscription_plans_store_priced).</p>`
            : stateBlock({ text: 'الباقة غير موجودة (118 غير مطبّق).' })}
        <h3 class="panel-title">تعارضات الامتياز</h3>
        <ul class="company-list">
            <li>متاجر لها ربط حي بلا امتياز Shopify: <strong>${esc(num(mismatch.length))}</strong>${mismatch.length ? ` — ${mismatch.map((m) => esc(m.company_name)).join('، ')}` : ''}</li>
            <li>متاجر بلا اشتراك فعّال: <strong>${esc(num(data?.stores_without_subscription))}</strong></li>
            <li>اشتراكات باقة المتاجر على حساب ليس متجرًا: <strong>${esc(num(data?.store_plan_on_non_store))}</strong></li>
            <li>طلبات حسابات متاجر قيد المراجعة: <strong>${esc(num(data?.pending_store_requests))}</strong> — <a href="/admin/company-requests.html">المراجعة في لوحة الإدارة</a></li>
        </ul>`;
    renderKpis();
}

async function loadTestStore() {
    const box = $('testStore');
    box.innerHTML = loadingBlock();
    const [{ data: sec }, { data: mine }] = await Promise.all([
        rpc('owner_security_status'),
        rpc('owner_accounts_overview', { p_type: null, p_search: session?.user?.email || null, p_limit: 5, p_offset: 0 })
    ]);
    const own = (mine?.items || []).find((a) => a.user_id === session?.user?.id && a.company_id);
    const fresh = sec?.step_up_fresh === true;
    box.innerHTML = `
        ${own ? `<p class="panel-subtitle">شركتك: <strong>${esc(own.company_name)}</strong> — نوعها الآن <strong>${esc(TYPE_LABELS[own.account_type])}</strong></p>`
              : stateBlock({ text: 'لا شركة باسم حسابك. متجر الاختبار يُبنى على شركة المالك نفسه.' })}
        ${fresh ? '' : `<form class="toolbar owner-filters" id="storeStepUp" novalidate>
            <label for="storeStepUpCode">رمز التحقق بخطوتين (للعمليات أدناه)</label>
            <input id="storeStepUpCode" class="form-control" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" dir="ltr" placeholder="000000">
            <button type="submit" class="btn btn-primary btn-sm">تحقق</button></form>`}
        ${own ? `<div class="toolbar">
            ${own.account_type !== 'ecommerce_store'
                ? '<button type="button" class="btn btn-outline btn-sm" data-kind="ecommerce_store" data-critical>تحويل شركتي إلى متجر اختبار</button>'
                : '<button type="button" class="btn btn-outline btn-sm" data-kind="company" data-critical>إرجاع شركتي إلى شركة</button>'}
            ${own.account_type === 'ecommerce_store' ? `
                <label for="testDays" class="visually-hidden">المدة</label>
                <select id="testDays" class="form-control owner-filter-select"><option value="1">يوم</option><option value="7" selected>7 أيام</option><option value="30">30 يومًا</option></select>
                <button type="button" class="btn btn-primary btn-sm" id="testGrant" data-critical>منح امتيازات المتجر لشركتي للاختبار</button>
                <button type="button" class="btn btn-outline btn-sm" id="testRevoke" data-critical>سحبها</button>` : ''}
        </div>` : ''}
        <h3 class="panel-title">معاينة لوحة المتجر</h3>
        <ul class="company-list">
            <li><strong>تشغيل:</strong> بدّل واجهتك من شريط السياق إلى «مدير شركتي»، ثم افتح <a href="/company-dashboard/#storeOverview">لوحة المتجر</a> — ترى متجر اختبارك أنت كما يراه مديره.</li>
            <li><strong>قراءة فقط:</strong> واجهة «معاينة عضو» تعرض اللوحة كعضو؛ الكتابة وبيانات Shopify الحية مرفوضة في القاعدة أثناء المعاينة.</li>
            <li>لا توجد معاينة لمتجر تاجر آخر: العزل بين الشركات مفروض في القاعدة، ولوحة المالك ترى بياناته الوصفية فقط (أعلاه).</li>
        </ul>`;
    box.querySelectorAll('[data-critical]').forEach((b) => { b.disabled = !fresh; if (!fresh) b.title = 'يتطلب تحققًا حديثًا'; });
    $('storeStepUp')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const code = $('storeStepUpCode').value.replace(/\s/g, '');
        if (!/^\d{6}$/.test(code)) { say('الرمز ستة أرقام.', 'error'); return; }
        const { data, error } = await rpc('owner_step_up', { p_code: code });
        if (error || !data?.verified) { say(error?.message || 'تعذّر التحقق.', 'error'); return; }
        loadTestStore();
    });
    box.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', async () => {
        const reason = window.prompt('سبب التغيير (10 أحرف على الأقل، يُسجَّل في تدقيق المالك):', 'اختبار تجربة المتجر على شركة المالك');
        if (!reason) return;
        b.disabled = true;
        const { error } = await rpc('owner_set_company_account_kind', { p_company: own.company_id, p_kind: b.getAttribute('data-kind'), p_reason: reason });
        say(error ? friendlyError(error) : 'تم تغيير نوع شركتك.', error ? 'error' : 'success');
        refresh();
    }));
    $('testGrant')?.addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        const { data, error } = await rpc('owner_store_test_entitlements', { p_enable: true, p_days: Number($('testDays').value),
                                                                           p_reason: 'اختبار امتيازات المتجر على شركة المالك' });
        say(error ? friendlyError(error) : `مُنحت حتى ${when(data?.expires_at)}.`, error ? 'error' : 'success');
        loadTestStore();
    });
    $('testRevoke')?.addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        const { error } = await rpc('owner_store_test_entitlements', { p_enable: false, p_days: 1, p_reason: null });
        say(error ? friendlyError(error) : 'سُحبت امتيازات الاختبار.', error ? 'error' : 'success');
        loadTestStore();
    });
}

function renderKpis() {
    const c = accounts.counts || {};
    const conns = integrations?.connections || [];
    const problems = conns.filter((x) => x.status !== 'active' || (x.missing_scopes || []).length || x.last_sync_status === 'failed' || !x.entitled).length;
    $('storesKpis').innerHTML = kpis([
        ['حسابات فردية', num(c.individual || 0), ''],
        ['شركات', num(c.company || 0), ''],
        ['متاجر إلكترونية', num(c.ecommerce_store || 0), 'kpi--accent'],
        ['متاجر مربوطة بـ Shopify', num(conns.filter((x) => x.status === 'active').length), 'kpi--success'],
        ['روابط تحتاج انتباهًا', num(problems), problems ? 'kpi--warning' : ''],
        ['طلبات متاجر قيد المراجعة', num(diagnostics?.pending_store_requests ?? 0), diagnostics?.pending_store_requests ? 'kpi--info' : '']
    ]);
}

function refresh() {
    loadAccounts(0);
    loadIntegrations();
    loadDiagnostics();
    loadTestStore();
}

(async function init() {
    const booted = await bootOwnerPage();
    if (!booted) return;
    session = booted.session;
    $('accountsFilters').addEventListener('submit', (e) => { e.preventDefault(); loadAccounts(0); });
    $('accountsType').addEventListener('change', () => loadAccounts(0));
    let t = null;
    $('accountsSearch').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => loadAccounts(0), 300); });
    $('storesRefresh').addEventListener('click', refresh);
    refresh();
})();
