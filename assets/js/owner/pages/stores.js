/**
 * owner/stores.html — حسابات المتاجر وربط شوبيفاي تحت إشراف المالك (118/119/133).
 *
 *   • owner_accounts_overview / owner_store_integrations / owner_store_events / owner_entitlement_diagnostics:
 *     owner_capability('owner_only') في القاعدة — بيانات وصفية فقط (حالات، رموز أخطاء، أوقات، عدّادات).
 *   • ihub-api shopify_config: هل قيم إعداد التطبيق موجودة على الخادم؟ (منطقي فقط، لا قيمة)
 *   • owner_set_company_account_kind / owner_store_test_entitlements: owner_critical_ok() — سياق المالك + تحقق
 *     حديث، ومدقّقة في privileged_audit. تعملان على شركة المالك نفسه فقط (متجر الاختبار).
 *   • owner_set_store_plan_price (133): سعر باقة 'store' فقط، بتحقق حديث؛ التفعيل مع السعرين فقط.
 *   • owner_ihub_sync_request / owner_ihub_events_retry (133): إجراءان تشغيليان للمالك على روابط
 *     Shopify — بلا سياق مدير المتجر، ومدقَّقان في _ihub_audit. إعادة التفويض للمدير وحده:
 *     الربط reauth_required بلا زر مزامنة.
 *   • owner_store_test_status (133، و151 يضم shopify_management): حالة امتياز متجر الاختبار من شركة المالك مباشرة — بلا بحث نصي.
 *   • owner_store_test_management (120، زرها هنا منذ 151): منح/سحب امتياز إدارة المتجر لمتجر الاختبار وحده
 *     (≤ 30 يومًا، سبب ≥ 10 أحرف، owner_critical_ok) — بلا الزر كانت الدالة بلا واجهة، فكانت الإدارة غير قابلة للتفعيل من اللوحة.
 *   • owner_store_grant_exception / owner_store_subscription / owner_store_set_end_date / owner_store_pause /
 *     owner_store_resume / owner_store_change_cycle (133): إدارة اشتراك متجر كاستثناء من المالك — owner_critical_ok()
 *     وسبب ≥10 أحرف ومدقَّقة في privileged_audit و subscription_audit_log؛ المتوقف لا يُعامل فعّالًا، والاستئناف
 *     يمدّد الانتهاء بمدة التوقف، وتحويل الدورة أثناء الإيقاف يبدأ دورة كاملة عند الاستئناف.
 *   • owner_store_alerts / owner_store_requests / owner_store_request_decide / owner_store_plan_config /
 *     owner_set_store_plan_quota_features / owner_store_operations_log / owner_set_shopify_provider_enabled (133):
 *     تنبيهات داخل الصفحة فقط (بلا قناة إشعار — لا آلية مالك عامة موجودة)، وقرارات طلبات المتاجر، وحد التذاكر
 *     والمزايا، وسجل عمليات واحد، ومبدّل مزوّد شوبيفاي. تنبيه: إيقاف المزوّد يمنع مزامنة وربطًا جديدًا ولا يفصل القائم.
 *   • owner_accounts_overview (133): فلاتر حالة الاشتراك/شوبيفاي/الإيقاف + بحث بدومين المتجر؛ النداء القديم يعمل كما هو.
 *   • (135) إلغاء تفعيل الباقة: owner_set_store_plan_price بتوقيع جديد (p_deactivate + p_reason) — زر مستقل
 *     بتأكيد وسبب؛ إلغاء تحديد التفعيل في نموذج السعر ما زال يحفظ السعر فقط. بلا تفعيل حي هنا.
 *   • (135) تعديل الانتهاء أثناء الإيقاف تاريخ نهائي: الاستئناف لا يمدّده بمدة التوقف (علامة
 *     end_date_set_while_paused)؛ ونص الاستئناف يتبع أساس الحساب (storeResumeBasis). الأيام المتبقية
 *     للمتوقف تُقرأ من days_remaining في القاعدة (مجمّدة عند الإيقاف) لا من تاريخ الانتهاء وحده.
 *   • (135) نموذج الحصة: تعطيل shopify_integration أو إلغاء كل المزايا يفتح تأكيدًا صريحًا قبل الحفظ.
 *   • (135) التشخيص: نموذج السعر يبني بياناته من owner_store_plan_config لا من owner_entitlement_diagnostics،
 *     وكل قسم في التشخيص يُرسم بنتيجته وخطئه مستقلًا — فشل التشخيص لا يُسقط النموذجين.
 *   • (135) المزامنة: المهمة القائمة (queued/running/failed) تُعاد كما هي بلا مكرر — في owner_ihub_sync_request
 *     و ihub_sync_request المناظرة؛ وحد الدقيقتين على المهمة المنتهية وحدها.
 *   • المعاينة: سياقات المالك القائمة (040/041) — «مدير شركتي» للتشغيل، و«معاينة عضو» للقراءة فقط.
 *     لا انتحال لتاجر ولا تجاوز للعزل. لا window.prompt في هذه الصفحة إطلاقًا.
 */
import {
    supabase, bootOwnerPage, announce, esc, when, num, table, kpis, errorBlock, loadingBlock, stateBlock, openModal,
    friendlyError, renderPager, writeResult
} from '/assets/js/owner/owner-page.js';
import { searchTerm, storeReasonError, testDaysRemaining, STORE_FEATURE_LABELS,
    BILLING_CYCLE_LABELS, storeEndDateError, toCsv, storePlanPriceArgs, storePlanFromConfig,
    storeQuotaDisableWarning, storeResumeBasis } from '/assets/js/owner/owner-labels.js';
import { APPLICANT_TYPE_LABELS, formatProofSize } from '/assets/js/company/company-request-model.js';
import { fetchStandaloneProofUrl } from '/assets/js/company/company-data.js';
import {
    isNonStoreCompanyRequest, companyRequestPlanLabel, companyRequestReviewError,
    COMPANY_REQUEST_STATUS_LABELS, COMPANY_REQUEST_STATUS_TONES
} from '/assets/js/owner/company-requests-model.js';

const $ = (id) => document.getElementById(id);
const say = (text, tone = 'info') => announce($('pageStatus'), text, tone);
const PAGE_SIZE = 25;
const TYPE_LABELS = { individual: 'فرد', company: 'شركة', ecommerce_store: 'متجر إلكتروني' };
const CONN_LABELS = { pending: 'بانتظار التفويض', active: 'متصل', error: 'خطأ', reauth_required: 'يحتاج إعادة تفويض' };
const SUB_LABELS = { active: 'فعّال', pending: 'قيد المراجعة', expired: 'منتهٍ', rejected: 'مرفوض', superseded: 'مستبدل', paused: 'متوقف مؤقتًا' };
const ALERT_LABELS = {
    connection_error: 'ربط بخطأ', sync_failed: 'مزامنة أخيرة فاشلة', dead_events: 'أحداث ميتة',
    compliance_pending: 'طلبات خصوصية معلّقة', pending_requests: 'طلبات متاجر معلّقة', no_entitlement: 'ربط حي بلا امتياز'
};

let session = null;
let accounts = { page: 0, total: 0, items: [], counts: {} };
let integrations = null;
let diagnostics = null;
let companyRequests = [];

async function rpc(name, args) {
    // النداء نفسه قد يرمي (انقطاع شبكة) لا أن يعود بـ error: بلا التقاط كانت
    // كل أقسام المتاجر تبقى هياكل عظمية بلا تفسير.
    try {
        const { data, error } = await supabase.rpc(name, args);
        return { data, error };
    } catch (err) {
        return { data: null, error: err };
    }
}

async function loadAccounts(page = 0) {
    $('accountsTable').innerHTML = loadingBlock();
    const suspended = $('accountsSuspended').value;
    const { data, error } = await rpc('owner_accounts_overview', {
        p_type: $('accountsType').value || null, p_search: searchTerm($('accountsSearch').value) || null,
        p_limit: PAGE_SIZE, p_offset: page * PAGE_SIZE,
        p_sub_status: $('accountsSubStatus').value || null,
        p_shopify_status: $('accountsShopify').value || null,
        p_suspended: suspended === '' ? null : suspended === 'true'
    });
    if (error) { $('accountsTable').innerHTML = errorBlock(friendlyError(error)); return; }
    accounts = { page, total: data?.total || 0, items: data?.items || [], counts: data?.counts || {} };
    $('accountsTable').innerHTML = table(['الحساب', 'النوع', 'الاشتراك', 'شوبيفاي', 'أُنشئ', 'إدارة'], accounts.items, (a) => `<tr>
        <td><div class="owner-account"><span class="owner-account-name"><a href="/owner/accounts.html?id=${esc(a.company_id || a.user_id)}">${esc(a.company_name || a.name || '—')}</a></span>
            <span class="owner-account-email">${esc(a.company_name ? a.name : a.email || '')}</span></div></td>
        <td><span class="pill ${a.account_type === 'ecommerce_store' ? 'status-tone-accent' : 'status-neutral'}">${esc(TYPE_LABELS[a.account_type] || a.account_type)}</span>
            ${a.company_status === 'suspended' ? '<span class="pill status-rejected">موقوفة</span>' : ''}</td>
        <td>${a.subscription ? `${esc(a.subscription.plan_name || a.subscription.plan)} — ${esc(SUB_LABELS[a.subscription.status] || a.subscription.status)}
            ${a.subscription.effective ? '' : '<br><span class="owner-account-email">غير سارٍ الآن</span>'}` : '—'}</td>
        <td>${a.shopify ? `${esc(CONN_LABELS[a.shopify.status] || a.shopify.status)}<br><span class="owner-account-email owner-mono" dir="ltr">${esc(a.shopify.shop || '')}</span>
            ${a.shopify.last_error_code ? `<br><span class="owner-account-email">${esc(a.shopify.last_error_code)}</span>` : ''}` : '—'}</td>
        <td>${esc(when(a.created_at))}</td>
        <td>${a.company_id ? `<button type="button" class="btn btn-outline btn-sm" data-preview-store="${esc(a.company_id)}" data-preview-name="${esc(a.company_name || a.name || '')}">معاينة المتجر</button>` : '—'}
            ${a.account_type === 'ecommerce_store' && a.company_id
            ? `<button type="button" class="btn btn-outline btn-sm" data-manage-sub="${esc(a.company_id)}" data-manage-name="${esc(a.company_name || a.name || '')}">إدارة الاشتراك</button>` : ''}</td></tr>`, { empty: 'لا حسابات مطابقة.' });
    $('accountsTable').querySelectorAll('[data-manage-sub]').forEach((b) => b.addEventListener('click', () =>
        openManageSub(b.getAttribute('data-manage-sub'), b.getAttribute('data-manage-name'))));
    $('accountsTable').querySelectorAll('[data-preview-store]').forEach((b) => b.addEventListener('click', () =>
        previewStore(b.getAttribute('data-preview-store'), b.getAttribute('data-preview-name'))));
    renderPager($('accountsPager'), { page, size: PAGE_SIZE, total: accounts.total, onPage: loadAccounts,
        text: `${num(accounts.total)} حساب` });
    renderKpis();
}

function exportAccountsCsv() {
    if (!accounts.items.length) { say('لا صفوف معروضة لتصديرها.', 'error'); return; }
    const csv = '\ufeff' + toCsv(['الحساب', 'النوع', 'الاشتراك', 'شوبيفاي', 'أُنشئ'], accounts.items.map((a) => [
        a.company_name || a.name || '',
        TYPE_LABELS[a.account_type] || a.account_type || '',
        a.subscription ? `${a.subscription.plan_name || a.subscription.plan} — ${SUB_LABELS[a.subscription.status] || a.subscription.status}` : '',
        a.shopify ? `${CONN_LABELS[a.shopify.status] || a.shopify.status} ${a.shopify.shop || ''}` : '',
        when(a.created_at)
    ]));
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'mad3oom-accounts.csv';
    link.click();
    URL.revokeObjectURL(url);
    say(`صُدّر ${num(accounts.items.length)} صفًا معروضًا إلى CSV.`, 'success');
}

async function loadAlerts() {
    $('storeAlerts').innerHTML = loadingBlock();
    const { data, error } = await rpc('owner_store_alerts');
    if (error) { $('storeAlerts').innerHTML = errorBlock(friendlyError(error)); return; }
    const alerts = data?.alerts || [];
    if (!alerts.length) {
        $('storeAlerts').innerHTML = stateBlock({ text: 'لا تنبيهات — كل روابط المتاجر سليمة، ولا طلبات خصوصية معلّقة.' });
        return;
    }
    $('storeAlerts').innerHTML = `<p class="panel-subtitle">${esc(num(data?.critical || 0))} حرجة من ${esc(num(data?.count || alerts.length))} — التنبيهات داخل هذه الصفحة فقط، بلا إشعارات دفع؛ ويقرؤها التقرير الصباحي أيضًا.</p>` +
        table(['الخطورة', 'التنبيه', 'التفاصيل', ''], alerts, (a) => `<tr>
            <td><span class="pill ${a.severity === 'critical' ? 'status-rejected' : 'status-pending'}">${esc(a.severity === 'critical' ? 'حرج' : 'تحذير')}</span></td>
            <td>${esc(ALERT_LABELS[a.kind] || a.kind)}</td>
            <td>${esc(a.message || '')}${a.count > 1 ? ` (${esc(num(a.count))})` : ''}</td>
            <td>${a.target ? `<a href="${esc(a.target)}">عرض</a>` : '—'}</td></tr>`, { empty: '' });
}

async function loadRequests() {
    $('storeRequests').innerHTML = loadingBlock();
    const { data, error } = await rpc('owner_store_requests');
    if (error) { $('storeRequests').innerHTML = errorBlock(friendlyError(error)); return; }
    const rows = data || [];
    $('storeRequests').innerHTML = table(['صاحب الطلب', 'الشركة', 'الباقة', 'التاريخ', ''], rows, (r) => `<tr>
        <td><div class="owner-account"><span class="owner-account-name">${esc(r.customer_name || '—')}</span>
            <span class="owner-account-email">${esc(r.customer_email || '')}</span></div></td>
        <td>${esc(r.company_name || '—')}</td>
        <td>${esc(r.requested_plan || 'store')} — ${esc(BILLING_CYCLE_LABELS[r.requested_billing_cycle] || r.requested_billing_cycle || '')}</td>
        <td>${esc(when(r.created_at))}</td>
        <td><button type="button" class="btn btn-primary btn-sm" data-decide="approve" data-request="${esc(r.id)}">اعتماد</button>
            <button type="button" class="btn btn-danger btn-sm" data-decide="reject" data-request="${esc(r.id)}">رفض</button></td></tr>`,
        { empty: 'لا طلبات متاجر معلّقة.' });
    $('storeRequests').querySelectorAll('[data-decide]').forEach((b) => b.addEventListener('click', () =>
        openRequestDecideModal(b.getAttribute('data-request'), b.getAttribute('data-decide'))));
}

function openRequestDecideModal(requestId, decision) {
    const approve = decision === 'approve';
    const modal = openModal({
        title: approve ? 'اعتماد طلب المتجر' : 'رفض طلب المتجر',
        html: `<form class="owner-action-form" id="requestDecideForm" novalidate>
            <p class="panel-subtitle">${approve
                ? 'سيُنشأ حساب الشركة كنوع متجر إلكتروني، ويُخطر صاحب الطلب بالموافقة.'
                : 'سيُرفض الطلب ويُخطر صاحب الطلب بالسبب — يمكنه تعديل البيانات وإرسال طلب جديد.'}</p>
            <div class="form-field">
                <label for="requestDecideReason">السبب (10 أحرف على الأقل، يُسجَّل في تدقيق المالك)</label>
                <input type="text" class="form-control" id="requestDecideReason" maxlength="300" autocomplete="off" required
                    value="${approve ? 'اعتماد طلب المتجر بعد مراجعة البيانات' : 'رفض طلب المتجر بعد مراجعة البيانات'}">
            </div>
            <div class="form-actions">
                <button type="submit" class="btn ${approve ? 'btn-primary' : 'btn-danger'} btn-sm" data-critical>${approve ? 'اعتماد الطلب' : 'رفض الطلب'}</button>
            </div>
            <p class="owner-sie-status" id="requestDecideStatus" role="status" aria-live="polite" hidden></p>
        </form>`
    });
    const form = modal.body.querySelector('#requestDecideForm');
    const status = (t, tone) => announce(form.querySelector('#requestDecideStatus'), t, tone);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const reason = form.querySelector('#requestDecideReason').value;
        const err = storeReasonError(reason);
        if (err) { status(err, 'error'); return; }
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        const { error } = await rpc('owner_store_request_decide', { p_request: requestId, p_decision: decision, p_reason: reason });
        if (error) { status(friendlyError(error), 'error'); btn.disabled = false; return; }
        modal.close();
        say(approve ? 'اعتُمد طلب المتجر وأُنشئت الشركة.' : 'رُفض طلب المتجر وأُخطر صاحبه.', 'success');
        loadRequests();
        loadAccounts(0);
        loadDiagnostics();
    });
}

/* ── طلبات حسابات الشركات (غير المتاجر) ───────────────────────────────────
 * admin_list_company_account_requests (138) تعيد كل الطلبات؛ هذا القسم يعرض
 * غير-المتاجر فقط — المتجر الإلكتروني له قسمه وقراره أعلاه
 * (owner_store_requests / owner_store_request_decide)، فلا طلب يُراجَع مرتين.
 * القرار admin_review_company_account_request (068): الموافقة تُنشئ الشركة
 * والاشتراك وتُخطر العميل، والرفض يتطلب سببًا يظهر للعميل. النجاح يُثبت من
 * صف العودة (writeResult) — لا «تم» على رفض صامت بلا صفوف.
 * مستند الإثبات برابط موقَّع 60 ثانية عبر company-document-download — يُفتح في
 * تبويب جديد، لا يُحفظ ولا يُعرض مساره في الصفحة. */
async function loadCompanyRequests() {
    $('companyRequests').innerHTML = loadingBlock();
    const { data, error } = await rpc('admin_list_company_account_requests');
    if (error) { $('companyRequests').innerHTML = errorBlock(friendlyError(error)); return; }
    companyRequests = (Array.isArray(data) ? data : []).filter(isNonStoreCompanyRequest);
    renderCompanyRequests();
    renderKpis();
}

function renderCompanyRequests() {
    const search = $('companyReqSearch').value.trim().toLowerCase();
    const statusFilter = $('companyReqStatus').value;
    const rows = companyRequests.filter((req) => {
        if (statusFilter && req.status !== statusFilter) return false;
        if (!search) return true;
        return [req.company_name, req.customer_name, req.customer_email, req.commercial_registration_number,
                req.website_url, APPLICANT_TYPE_LABELS[req.applicant_type]]
            .some(v => String(v || '').toLowerCase().includes(search));
    });
    $('companyRequests').innerHTML = table(
        ['الشركة', 'العميل', 'نوع المتقدم', 'الباقة', 'الحالة', 'طُلب في', ''],
        rows,
        (req) => `<tr>
            <td>${esc(req.company_name || '—')}${req.request_source === 'standalone' ? ' <span class="pill status-pending">مستقل</span>' : ''}
                <div class="owner-account-email">سجل ${esc(req.commercial_registration_number || '—')}</div></td>
            <td><div class="owner-account"><span class="owner-account-name">${esc(req.customer_name || '—')}</span>
                <span class="owner-account-email" dir="ltr">${esc(req.customer_email || '')}</span></div></td>
            <td>${esc(APPLICANT_TYPE_LABELS[req.applicant_type] || 'شركة')}
                ${req.proof_document_name ? `<div class="owner-account-email">مستند: ${esc(req.proof_document_name)} (${esc(formatProofSize(req.proof_document_size))})</div>`
                    : req.website_url ? `<div class="owner-account-email" dir="ltr">${esc(req.website_url)}</div>` : ''}</td>
            <td>${esc(companyRequestPlanLabel(req))}</td>
            <td><span class="pill ${COMPANY_REQUEST_STATUS_TONES[req.status] || 'status-pending'}">${esc(COMPANY_REQUEST_STATUS_LABELS[req.status] || req.status)}</span></td>
            <td>${esc(when(req.created_at))}</td>
            <td><button type="button" class="btn btn-secondary btn-sm" data-company-request="${esc(req.id)}">${req.status === 'pending' ? 'مراجعة' : 'عرض'}</button></td></tr>`,
        { empty: statusFilter === 'pending' && !search ? 'لا توجد طلبات شركات قيد المراجعة.' : 'لا توجد طلبات مطابقة.' });
    $('companyRequests').querySelectorAll('[data-company-request]').forEach((b) => b.addEventListener('click', () =>
        openCompanyRequestModal(b.getAttribute('data-company-request'))));
}

function openCompanyRequestModal(requestId) {
    const req = companyRequests.find((r) => r.id === requestId);
    if (!req) return;
    const isPending = req.status === 'pending';
    const expired = req.commercial_registration_expiry && new Date(req.commercial_registration_expiry) < new Date(new Date().toDateString());
    const modal = openModal({
        title: isPending ? `مراجعة طلب «${req.company_name || ''}»` : `طلب «${req.company_name || ''}»`,
        wide: true,
        html: `
        <p class="panel-subtitle">${isPending
            ? 'تحقّق من البيانات القانونية. الموافقة تُنشئ الشركة باسم العميل ويتحوّل حسابه إلى حساب شركة فورًا، وتُنشئ اشتراكه وتُخطره.'
            : `هذا الطلب ${COMPANY_REQUEST_STATUS_LABELS[req.status] || req.status}.`}</p>
        <dl class="owner-detail-grid">
            <div><dt>نوع المتقدم</dt><dd>${esc(APPLICANT_TYPE_LABELS[req.applicant_type] || 'شركة')}</dd></div>
            <div><dt>مصدر الطلب</dt><dd>${esc(req.request_source === 'standalone' ? 'مستقل — خارج مسار الشراء' : 'مسار الشراء')}</dd></div>
            <div><dt>الشركة</dt><dd>${esc(req.company_name || '—')}</dd></div>
            <div><dt>رقم السجل التجاري</dt><dd>${esc(req.commercial_registration_number || '—')}</dd></div>
            <div><dt>انتهاء السجل</dt><dd>${esc(day(req.commercial_registration_expiry))}${expired ? ' — منتهٍ' : ''}</dd></div>
            <div><dt>بريد الشركة</dt><dd><span dir="ltr">${esc(req.company_email || '—')}</span></dd></div>
            <div><dt>جوال الشركة</dt><dd><span dir="ltr">${esc(req.company_phone || '—')}</span></dd></div>
            <div><dt>العميل</dt><dd>${esc(req.customer_name || '—')} — <span dir="ltr">${esc(req.customer_email || '')}</span>${req.customer_phone ? ` — <span dir="ltr">${esc(req.customer_phone)}</span>` : ''}</dd></div>
            <div><dt>الباقة المطلوبة</dt><dd>${esc(companyRequestPlanLabel(req))}</dd></div>
            ${req.website_url ? `<div><dt>رابط الموقع</dt><dd><a href="${esc(req.website_url)}" target="_blank" rel="noopener" dir="ltr">${esc(req.website_url)}</a></dd></div>` : ''}
            ${req.store_domain_hint ? `<div><dt>دومين المتجر المقترح</dt><dd dir="ltr">${esc(req.store_domain_hint)}</dd></div>` : ''}
            ${req.proof_document_name ? `<div><dt>مستند الإثبات</dt><dd>${esc(req.proof_document_name)} (${esc(formatProofSize(req.proof_document_size))})<br>
                <button type="button" class="btn btn-outline btn-sm" id="companyReqProof">تنزيل المستند</button></dd></div>` : ''}
            ${!isPending ? `<div><dt>الحالة</dt><dd>${esc(COMPANY_REQUEST_STATUS_LABELS[req.status] || req.status)}</dd></div>
            <div><dt>راجعه</dt><dd>${esc(req.reviewer_name || '—')}</dd></div>
            <div><dt>تاريخ المراجعة</dt><dd>${esc(when(req.reviewed_at))}</dd></div>
            <div><dt>ملاحظة المراجعة</dt><dd>${esc(req.review_note || '—')}</dd></div>` : ''}
        </dl>
        ${isPending ? `<form class="owner-action-form" id="companyReqDecideForm" novalidate>
            <div class="form-field">
                <label for="companyReqNote">ملاحظة القرار (إلزامية للرفض — تظهر للعميل في الإشعار)</label>
                <input type="text" class="form-control" id="companyReqNote" maxlength="300" autocomplete="off">
            </div>
            <div class="form-actions">
                <button type="button" class="btn btn-primary btn-sm" data-company-decide="approve" data-critical>موافقة — إنشاء الشركة</button>
                <button type="button" class="btn btn-danger btn-sm" data-company-decide="reject" data-critical>رفض</button>
            </div>
            <p class="owner-sie-status" id="companyReqDecideStatus" role="status" aria-live="polite" hidden></p>
        </form>` : ''}`
    });
    modal.body.querySelector('#companyReqProof')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        const original = btn.textContent;
        btn.textContent = 'جارٍ التجهيز...';
        try {
            const result = await fetchStandaloneProofUrl(requestId);
            if (!result.ok) {
                say(result.error || 'تعذّر تجهيز رابط التنزيل. حاول مرة أخرى.', 'error');
                return;
            }
            window.open(result.url, '_blank', 'noopener');
        } finally {
            btn.disabled = false;
            btn.textContent = original;
        }
    });
    modal.body.querySelectorAll('[data-company-decide]').forEach((b) => b.addEventListener('click', () =>
        reviewCompanyRequest(modal, requestId, b.getAttribute('data-company-decide'))));
}

async function reviewCompanyRequest(modal, requestId, decision) {
    const note = modal.body.querySelector('#companyReqNote').value.trim();
    const status = (t, tone) => announce(modal.body.querySelector('#companyReqDecideStatus'), t, tone);
    const err = companyRequestReviewError({ decision, note });
    if (err) { status(err, 'error'); return; }
    const approve = decision === 'approve';
    const btn = modal.body.querySelector(`[data-company-decide="${decision}"]`);
    btn.disabled = true;
    const checked = writeResult(await rpc('admin_review_company_account_request', {
        p_request_id: requestId, p_decision: decision, p_note: note || null
    }));
    btn.disabled = false;
    if (!checked.ok) { status(checked.message, 'error'); return; }
    modal.close();
    say(approve ? 'تمت الموافقة — أُنشئت الشركة وأُخطر العميل.' : 'تم رفض الطلب وإخطار العميل بالسبب.', 'success');
    loadCompanyRequests();
    loadAccounts(0);
    loadDiagnostics();
}

/** نافذة سبب عامة لإجراءات الاشتراك (إيقاف/استئناف/تحويل دورة) — بلا window.prompt. */
function openSubReasonModal({ title, text, confirmLabel, confirmTone = 'btn-primary', onConfirm }) {
    const modal = openModal({
        title,
        html: `<form class="owner-action-form" id="subReasonForm" novalidate>
            <p class="panel-subtitle">${esc(text)}</p>
            <div class="form-field">
                <label for="subReason">السبب (10 أحرف على الأقل، يُسجَّل في تدقيق المالك)</label>
                <input type="text" class="form-control" id="subReason" maxlength="300" autocomplete="off" required>
            </div>
            <div class="form-actions">
                <button type="submit" class="btn ${esc(confirmTone)} btn-sm" data-critical>${esc(confirmLabel)}</button>
            </div>
            <p class="owner-sie-status" id="subReasonStatus" role="status" aria-live="polite" hidden></p>
        </form>`
    });
    const form = modal.body.querySelector('#subReasonForm');
    const status = (t, tone) => announce(form.querySelector('#subReasonStatus'), t, tone);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const reason = form.querySelector('#subReason').value;
        const err = storeReasonError(reason);
        if (err) { status(err, 'error'); return; }
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        const { error } = await onConfirm(reason);
        if (error) { status(friendlyError(error), 'error'); btn.disabled = false; return; }
        modal.close();
    });
}

async function openManageSub(companyId, companyName) {
    const modal = openModal({
        title: `إدارة اشتراك المتجر — ${companyName || 'متجر'}`,
        wide: true,
        html: `<div id="manageSubBody">${loadingBlock()}</div>`
    });
    const body = modal.body.querySelector('#manageSubBody');
    const reload = async () => {
        body.innerHTML = loadingBlock();
        const { data: sub, error } = await rpc('owner_store_subscription', { p_company: companyId });
        if (error) { body.innerHTML = errorBlock(friendlyError(error)); return; }
        const effective = sub?.effective === true;
        // 135: المتوقف أيامه المتبقية مجمّدة عند الإيقاف — تُقرأ من القاعدة لا من الآن.
        const days = sub?.days_remaining ?? (sub?.end_date ? testDaysRemaining(sub.end_date) : null);
        const resumeBasis = storeResumeBasis(sub);
        body.innerHTML = `
            ${sub ? `<h3 class="panel-title">الاشتراك الحالي</h3>
                <ul class="company-list">
                    <li>الدورة: <strong>${esc(BILLING_CYCLE_LABELS[sub.billing_cycle] || sub.billing_cycle)}</strong></li>
                    <li>الحالة: <strong>${esc(SUB_LABELS[sub.status] || sub.status)}</strong>${effective ? '' : ' (غير سارٍ الآن)'}</li>
                    <li>البداية: ${esc(when(sub.start_date))} · الانتهاء: ${esc(when(sub.end_date))}${days == null ? '' : ` · باقٍ ${esc(num(days))} يوم`}</li>
                    <li>طريقة الدفع: ${esc(sub.payment_method || '—')}</li>
                </ul>` : '<p class="panel-subtitle">لا اشتراك متجر لهذا المتجر.</p>'}
            ${!effective ? `<h3 class="panel-title">منح باقة المتاجر كاستثناء</h3>
                <form class="owner-action-form" id="subGrantForm" novalidate>
                    <div class="form-field">
                        <label for="subGrantCycle">الدورة</label>
                        <select id="subGrantCycle" class="form-control owner-filter-select">
                            <option value="monthly">شهري — 500 جنيه</option>
                            <option value="yearly">سنوي — 5000 جنيه</option>
                        </select>
                    </div>
                    <div class="form-field">
                        <label for="subGrantEnd">تاريخ الانتهاء (خلال سنة كحد أقصى)</label>
                        <input type="datetime-local" class="form-control" id="subGrantEnd" required>
                    </div>
                    <div class="form-field">
                        <label for="subGrantReason">السبب (10 أحرف على الأقل، يُسجَّل في تدقيق المالك)</label>
                        <input type="text" class="form-control" id="subGrantReason" maxlength="300" autocomplete="off" required>
                    </div>
                    <div class="form-actions">
                        <button type="submit" class="btn btn-primary btn-sm" data-critical>منح كاستثناء (مبلغ 0)</button>
                    </div>
                    <p class="owner-sie-status" id="subGrantStatus" role="status" aria-live="polite" hidden></p>
                </form>
                <p class="field-hint">المنح استثناء بلا شراء: المبلغ 0، وسعر الخطة من باقة المتاجر (500/5000). لا تمنح لتاجر حقيقي إلا بقرار صريح — جرّب أولًا على متجر الاختبار.</p>` : ''}
            ${sub ? `<h3 class="panel-title">تعديل تاريخ الانتهاء</h3>
                <form class="owner-action-form" id="subEndForm" novalidate>
                    <div class="form-field">
                        <label for="subEndDate">تاريخ الانتهاء الجديد</label>
                        <input type="datetime-local" class="form-control" id="subEndDate" required>
                    </div>
                    <div class="form-field">
                        <label for="subEndReason">السبب (10 أحرف على الأقل)</label>
                        <input type="text" class="form-control" id="subEndReason" maxlength="300" autocomplete="off" required>
                    </div>
                    <div class="form-actions">
                        <button type="submit" class="btn btn-primary btn-sm" data-critical>حفظ تاريخ الانتهاء</button>
                    </div>
                    <p class="owner-sie-status" id="subEndStatus" role="status" aria-live="polite" hidden></p>
                </form>
                ${sub.status === 'paused' ? '<p class="field-hint">الاشتراك متوقف الآن: التاريخ الجديد هو تاريخ الانتهاء النهائي بعد الاستئناف — لن يُمدَّد بمدة التوقف.</p>' : ''}
                <div class="toolbar">
                    ${sub.status === 'active' ? '<button type="button" class="btn btn-outline btn-sm" id="subPause" data-critical>إيقاف مؤقتًا</button>' : ''}
                    ${sub.status === 'paused' ? '<button type="button" class="btn btn-primary btn-sm" id="subResume" data-critical>استئناف</button>' : ''}
                    <button type="button" class="btn btn-outline btn-sm" id="subCycle" data-critical>تحويل الدورة إلى ${esc(sub.billing_cycle === 'monthly' ? 'سنوي' : 'شهري')}</button>
                </div>
                <p class="field-hint">الإيقاف يجمّد الاشتراك ولا يخصم أيام التوقف من العميل: الاستئناف يمدّد الانتهاء بمدة التوقف.
                    تحويل الدورة من اليوم: ${esc(sub.billing_cycle === 'monthly' ? 'سنوي = الانتهاء بعد 365 يومًا' : 'شهري = الانتهاء بعد 30 يومًا')}؛
                    وإن كان متوقفًا يبدأ الانتهاء الجديد من لحظة الاستئناف.</p>` : ''}`;
        const afterOp = (msg) => { say(msg, 'success'); reload(); loadAccounts(accounts.page); loadDiagnostics(); };
        body.querySelector('#subGrantForm')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const status = (t, tone) => announce(form.querySelector('#subGrantStatus'), t, tone);
            const reason = form.querySelector('#subGrantReason').value;
            const end = form.querySelector('#subGrantEnd').value;
            const err = storeEndDateError(end, { maxDays: 365 }) || storeReasonError(reason);
            if (err) { status(err, 'error'); return; }
            const btn = form.querySelector('button[type=submit]');
            btn.disabled = true;
            const { error: grantError } = await rpc('owner_store_grant_exception', {
                p_company: companyId, p_billing_cycle: form.querySelector('#subGrantCycle').value,
                p_end_date: new Date(end).toISOString(), p_reason: reason
            });
            btn.disabled = false;
            if (grantError) { status(friendlyError(grantError), 'error'); return; }
            afterOp('مُنحت باقة المتاجر كاستثناء.');
        });
        body.querySelector('#subEndForm')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const status = (t, tone) => announce(form.querySelector('#subEndStatus'), t, tone);
            const reason = form.querySelector('#subEndReason').value;
            const end = form.querySelector('#subEndDate').value;
            const err = storeEndDateError(end, { maxDays: 365, startDate: sub.start_date }) || storeReasonError(reason);
            if (err) { status(err, 'error'); return; }
            const btn = form.querySelector('button[type=submit]');
            btn.disabled = true;
            const { error: setError } = await rpc('owner_store_set_end_date', {
                p_subscription: sub.id, p_end_date: new Date(end).toISOString(), p_reason: reason
            });
            btn.disabled = false;
            if (setError) { status(friendlyError(setError), 'error'); return; }
            afterOp('حُفظ تاريخ الانتهاء الجديد.');
        });
        body.querySelector('#subPause')?.addEventListener('click', () => openSubReasonModal({
            title: 'إيقاف الاشتراك مؤقتًا', text: 'سيتوقف الاشتراك فورًا ولا يُعامل فعّالًا أثناء الإيقاف. الاستئناف يمدّد الانتهاء بمدة التوقف.',
            confirmLabel: 'إيقاف الاشتراك', confirmTone: 'btn-danger',
            onConfirm: async (reason) => {
                const { error } = await rpc('owner_store_pause', { p_subscription: sub.id, p_reason: reason });
                if (!error) afterOp('أُوقف الاشتراك مؤقتًا.');
                return { error };
            }
        }));
        body.querySelector('#subResume')?.addEventListener('click', () => openSubReasonModal({
            title: 'استئناف الاشتراك',
            text: resumeBasis === 'manual'
                ? 'سيعود الاشتراك فعّالًا بتاريخ الانتهاء المحدد يدويًا أثناء الإيقاف، دون تمديد إضافي بمدة التوقف.'
                : resumeBasis === 'cycle'
                    ? 'سيعود الاشتراك فعّالًا، وتبدأ الدورة الجديدة كاملة من لحظة الاستئناف.'
                    : 'سيعود الاشتراك فعّالًا، ويمتدّ تاريخ الانتهاء بمدة التوقف — الأيام المتوقفة لا تُخصم من العميل.',
            confirmLabel: 'استئناف الاشتراك', confirmTone: 'btn-primary',
            onConfirm: async (reason) => {
                const { error } = await rpc('owner_store_resume', { p_subscription: sub.id, p_reason: reason });
                if (!error) afterOp('استُؤنف الاشتراك ومُدّد انتهاؤه.');
                return { error };
            }
        }));
        body.querySelector('#subCycle')?.addEventListener('click', () => {
            const toCycle = sub.billing_cycle === 'monthly' ? 'yearly' : 'monthly';
            openSubReasonModal({
                title: `تحويل الدورة إلى ${BILLING_CYCLE_LABELS[toCycle]}`,
                text: sub.status === 'paused'
                    ? 'الاشتراك متوقف: تُحفظ الدورة الجديدة فقط، ويبدأ الانتهاء الجديد (30 أو 365 يومًا) من لحظة الاستئناف.'
                    : `تحويل من اليوم: الانتهاء الجديد بعد ${toCycle === 'yearly' ? '365' : '30'} يومًا، وسعر الخطة ${toCycle === 'yearly' ? '5000' : '500'} جنيه.`,
                confirmLabel: `تحويل إلى ${BILLING_CYCLE_LABELS[toCycle]}`, confirmTone: 'btn-primary',
                onConfirm: async (reason) => {
                    const { error } = await rpc('owner_store_change_cycle', { p_subscription: sub.id, p_billing_cycle: toCycle, p_reason: reason });
                    if (!error) afterOp(`حُوّلت الدورة إلى ${BILLING_CYCLE_LABELS[toCycle]}.`);
                    return { error };
                }
            });
        });
    };
    await reload();
}

async function loadOpsLog() {
    $('storeOpsLog').innerHTML = loadingBlock();
    const { data, error } = await rpc('owner_store_operations_log', { p_limit: 30 });
    if (error) { $('storeOpsLog').innerHTML = errorBlock(friendlyError(error)); return; }
    const rows = data || [];
    $('storeOpsLog').innerHTML = table(['الوقت', 'العملية', 'الفاعل', 'الملخص'], rows, (o) => `<tr>
        <td>${esc(when(o.created_at))}</td>
        <td dir="ltr">${esc(o.action || '')}</td>
        <td>${esc(o.actor_email || '—')}</td>
        <td>${esc(o.summary || '')}</td></tr>`, { empty: 'لا عمليات متاجر مسجّلة بعد.' });
}

async function loadIntegrations() {
    $('storeIntegrations').innerHTML = loadingBlock();
    const { data, error } = await rpc('owner_store_integrations');
    if (error) { $('storeIntegrations').innerHTML = errorBlock(friendlyError(error)); integrations = null; renderKpis(); return; }
    integrations = data;
    const rows = data?.connections || [];
    const provider = data?.provider || {};
    $('storeIntegrations').innerHTML = `
        <p class="panel-subtitle">مزوّد شوبيفاي على المنصة: <strong>${provider.enabled ? 'مفعّل' : 'مقفل'}</strong> (${esc({ beta: 'تجريبي', alpha: 'أولي', stable: 'مستقر' }[provider.release_stage] || provider.release_stage || 'تجريبي')}) ·
            الصلاحيات المطلوبة: <span dir="ltr">${esc((data?.required_scopes || []).join(', '))}</span>
            ${data?.compliance_unmatched_30d ? ` · طلبات خصوصية لمتاجر غير مربوطة (30 يومًا): ${esc(num(data.compliance_unmatched_30d))}` : ''}
            <button type="button" class="btn btn-outline btn-sm" id="providerToggle" data-critical>${provider.enabled ? 'إيقاف مزوّد Shopify' : 'تشغيل مزوّد Shopify'}</button></p>
        ${table(['المتجر', 'الحالة', 'الصلاحيات', 'المزامنة', 'الأحداث (7 أيام)', 'الامتياز', ''], rows, (c) => `<tr id="conn-${esc(c.connection_id)}">
            <td><div class="owner-account"><span class="owner-account-name">${esc(c.company_name)}</span>
                <span class="owner-account-email owner-mono" dir="ltr">${esc(c.shop || '—')}</span></div></td>
            <td>${esc(CONN_LABELS[c.status] || c.status)}${c.last_error_code ? `<br><span class="owner-account-email">${esc(c.last_error_code)} · ${esc(when(c.last_error_at))}</span>` : ''}
                ${c.has_credentials ? '' : '<br><span class="owner-account-email">لا رموز مخزّنة</span>'}
                ${c.status === 'reauth_required' ? '<br><span class="owner-account-email">يحتاج إعادة تفويض من مدير المتجر — لا يمكن للمالك التفويض نيابة عنه.</span>' : ''}</td>
            <td>${(c.missing_scopes || []).length ? `<span class="pill status-rejected">ناقصة: ${esc(c.missing_scopes.join(', '))}</span>` : '<span class="pill status-resolved">كاملة</span>'}</td>
            <td>${esc(c.last_sync_status || '—')}<br><span class="owner-account-email">${esc(when(c.last_sync_at))}</span>
                ${c.sync_failures_7d ? `<br><span class="owner-account-email">فشل: ${esc(num(c.sync_failures_7d))}</span>` : ''}</td>
            <td>${Object.entries(c.events_7d || {}).map(([k, n]) => `${esc(k)}: ${esc(num(n))}`).join('<br>') || '—'}
                ${c.compliance_pending ? `<br><span class="pill status-neutral">خصوصية معلّقة: ${esc(num(c.compliance_pending))}</span>` : ''}</td>
            <td>${c.entitled ? '<span class="pill status-resolved">مستحق</span>' : '<span class="pill status-rejected">بلا امتياز</span>'}</td>
            <td><button type="button" class="btn btn-outline btn-sm" data-events="${esc(c.connection_id)}">السجل</button>
                ${(c.status === 'active' || c.status === 'error') ? `<br><button type="button" class="btn btn-outline btn-sm" data-sync="${esc(c.connection_id)}">مزامنة</button>` : ''}
                ${((c.events_7d || {}).dead || 0) > 0 ? `<br><button type="button" class="btn btn-outline btn-sm" data-retry="${esc(c.connection_id)}">إعادة محاولة الأحداث</button>` : ''}</td></tr>`,
            { empty: 'لا متاجر مربوطة بشوبيفاي بعد.' })}`;
    $('storeIntegrations').querySelectorAll('[data-events]').forEach((b) => b.addEventListener('click', () => openEvents(b.getAttribute('data-events'))));
    $('storeIntegrations').querySelectorAll('[data-sync]').forEach((b) => b.addEventListener('click', () => syncConnection(b)));
    $('storeIntegrations').querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', () => retryConnectionEvents(b)));
    $('providerToggle')?.addEventListener('click', () => openSubReasonModal({
        title: provider.enabled ? 'إيقاف مزوّد Shopify' : 'تشغيل مزوّد Shopify',
        text: provider.enabled
            ? 'الإيقاف يمنع مزامنة جديدة وربطًا جديدًا فورًا، ولا يفصل الربوط القائمة ولا يحذف بياناتها.'
            : 'التشغيل يعيد المزامنة والربط الجديد لمزود شوبيفاي.',
        confirmLabel: provider.enabled ? 'إيقاف المزوّد' : 'تشغيل المزوّد',
        confirmTone: provider.enabled ? 'btn-danger' : 'btn-primary',
        onConfirm: async (reason) => {
            const { error } = await rpc('owner_set_shopify_provider_enabled', { p_enabled: !provider.enabled, p_reason: reason });
            if (!error) { say(provider.enabled ? 'أُوقف مزوّد Shopify.' : 'شُغّل مزوّد Shopify.', 'success'); loadIntegrations(); loadDiagnostics(); }
            return { error };
        }
    }));
    renderKpis();
}

async function syncConnection(button) {
    const connectionId = button.getAttribute('data-sync');
    button.disabled = true;
    const { data, error } = await rpc('owner_ihub_sync_request', { p_connection: connectionId });
    if (error) { say(friendlyError(error), 'error'); button.disabled = false; return; }
    say(data?.existing ? `مهمة مزامنة قائمة بالفعل (#${num(data?.job_id)}).` : `أُدرجت مهمة المزامنة #${num(data?.job_id)}.`, 'success');
    loadIntegrations();
}

async function retryConnectionEvents(button) {
    const connectionId = button.getAttribute('data-retry');
    button.disabled = true;
    const { data, error } = await rpc('owner_ihub_events_retry', { p_connection: connectionId });
    if (error) { say(friendlyError(error), 'error'); button.disabled = false; return; }
    say(`أُعيد ${num(data?.requeued ?? 0)} حدثًا ميتًا إلى الطابور.`, 'success');
    loadIntegrations();
}

async function openEvents(connectionId) {
    const { data, error } = await rpc('owner_store_events', { p_connection: connectionId, p_limit: 30 });
    if (error) { say(friendlyError(error), 'error'); return; }
    const deadCount = (data.events || []).filter((e) => e.status === 'dead').length;
    const modal = openModal({
        title: 'سجل ربط المتجر', wide: true,
        html: `<h3 class="panel-title">مهام المزامنة</h3>${table(['النوع', 'الحالة', 'صفحات', 'طلبات', 'محاولات', 'الخطأ', 'البداية', 'النهاية'], data.jobs || [], (j) => `<tr>
                <td>${esc(j.kind)}</td><td>${esc(j.status)}</td><td>${esc(num(j.pages))}</td><td>${esc(num(j.records))}</td><td>${esc(num(j.attempts))}</td>
                <td>${esc(j.last_error_code || '—')}</td><td>${esc(when(j.created_at))}</td><td>${esc(when(j.finished_at))}</td></tr>`, { empty: 'لا مهام.' })}
            <h3 class="panel-title">أحداث فاشلة أو معلّقة</h3>${table(['الموضوع', 'الحالة', 'محاولات', 'الخطأ', 'وصل'], data.events || [], (e) => `<tr>
                <td dir="ltr">${esc(e.topic)}</td><td>${esc(e.status)}</td><td>${esc(num(e.attempts))}</td><td>${esc(e.last_error_code || '—')}</td>
                <td>${esc(when(e.received_at))}</td></tr>`, { empty: 'لا أحداث فاشلة.' })}
            ${deadCount ? `<p><button type="button" class="btn btn-outline btn-sm" id="eventsRetry">إعادة محاولة الأحداث الميتة (${esc(num(deadCount))})</button></p>` : ''}
            <h3 class="panel-title">التدقيق</h3>${table(['العملية', 'الفاعل', 'الوقت'], data.audit || [], (a) => `<tr><td dir="ltr">${esc(a.action)}</td>
                <td>${esc(a.actor_kind)}</td><td>${esc(when(a.created_at))}</td></tr>`, { empty: 'لا شيء.' })}`
    });
    modal.body.querySelector('#eventsRetry')?.addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        const { data: retried, error: retryError } = await rpc('owner_ihub_events_retry', { p_connection: connectionId });
        if (retryError) { say(friendlyError(retryError), 'error'); e.currentTarget.disabled = false; return; }
        say(`أُعيد ${num(retried?.requeued ?? 0)} حدثًا ميتًا إلى الطابور.`, 'success');
        modal.close();
        loadIntegrations();
        openEvents(connectionId);
    });
}

async function loadDiagnostics() {
    $('storeDiagnostics').innerHTML = loadingBlock();
    const [diagRes, cfgRes, planRes] = await Promise.all([
        rpc('owner_entitlement_diagnostics'),
        supabase.functions.invoke('ihub-api', { body: { action: 'shopify_config' } }).catch((e) => ({ error: e })),
        rpc('owner_store_plan_config')
    ]);
    // 135: كل قسم بنتيجته وخطئه مستقلًا — فشل التشخيص لا يُسقط نموذجي السعر
    // والحصة، وفشل إعداد الخادم أو إعداد الباقة لا يُسقط ما عداه. نموذج السعر
    // يبني بياناته من owner_store_plan_config (135) لا من التشخيص.
    diagnostics = diagRes.error ? null : diagRes.data;
    const data = diagnostics;
    const conf = cfgRes?.error ? null : cfgRes?.data;
    const planCfg = planRes.error ? null : planRes.data;
    const plan = storePlanFromConfig(planCfg);
    const mismatch = data?.live_connection_without_entitlement || [];
    $('storeDiagnostics').innerHTML = `
        <h3 class="panel-title">إعداد تطبيق شوبيفاي على الخادم</h3>
        ${conf ? `${table(['القيمة', 'موجودة'], Object.entries(conf.configured || {}), ([k, v]) => `<tr><td dir="ltr">${esc(k)}</td>
            <td>${v ? '<span class="pill status-resolved">نعم</span>' : '<span class="pill status-rejected">لا</span>'}</td></tr>`)}
            <p class="panel-subtitle">إصدار الواجهة البرمجية: <span dir="ltr">${esc(conf.api_version)}</span> ·
                رابط الرجوع يطابق المتوقع: ${conf.redirect_matches_callback ? 'نعم' : '<strong>لا — صحّح SHOPIFY_REDIRECT_URI</strong>'}</p>
            <p class="panel-subtitle">لإصلاح SHOPIFY_REDIRECT_URI: القيمة سرّ على الخادم — لوحة Supabase ← Edge Functions ← ihub-api ← Secrets، وليست في هذه الصفحة.</p>
            ${conf.urls ? `<p class="panel-subtitle owner-mono" dir="ltr">${esc(conf.urls.callback)}<br>${esc(conf.urls.webhooks)}</p>` : ''}`
            : (cfgRes?.error ? errorBlock(friendlyError(cfgRes.error))
                : stateBlock({ title: 'تعذّر فحص إعداد الخادم', text: 'الدالة الطرفية ihub-api غير منشورة بهذا الإصدار بعد، أو رفضت الطلب.' }))}
        <h3 class="panel-title">باقة المتاجر</h3>
        ${plan ? `<p class="panel-subtitle">${plan.is_active ? 'مفعّلة' : 'غير مفعّلة'} · السعر الشهري: ${esc(plan.price_monthly ?? 'لم يُحدد')} ·
            السنوي: ${esc(plan.price_yearly ?? 'لم يُحدد')} ${esc(plan.currency || '')} · حد التذاكر: ${plan.ticket_quota_defined ? 'محدد' : 'غير محدد'}<br>
            المزايا: <span dir="ltr">${esc((plan.features || []).join(', '))}</span></p>
            <form class="owner-action-form" id="storePriceForm" novalidate>
                <div class="form-field">
                    <label for="planMonthly">السعر الشهري (جنيه)</label>
                    <input type="number" class="form-control" id="planMonthly" min="1" step="any" inputmode="decimal" required
                        value="${esc(plan.price_monthly ?? 500)}">
                </div>
                <div class="form-field">
                    <label for="planYearly">السعر السنوي (جنيه)</label>
                    <input type="number" class="form-control" id="planYearly" min="1" step="any" inputmode="decimal" required
                        value="${esc(plan.price_yearly ?? 5000)}">
                </div>
                <div class="form-field">
                    <label><input type="checkbox" id="planActivate" ${plan.is_active ? 'checked' : ''}> تفعيل باقة المتاجر مع هذا السعر</label>
                </div>
                <div class="form-actions">
                    <button type="submit" class="btn btn-primary btn-sm" data-critical>حفظ سعر الباقة</button>
                    ${plan.is_active ? '<button type="button" class="btn btn-danger btn-sm" id="planDeactivate" data-critical>إلغاء تفعيل باقة المتاجر</button>' : ''}
                </div>
                <p class="owner-sie-status" id="planPriceStatus" role="status" aria-live="polite" hidden></p>
            </form>
            <p class="field-hint">السعر والمزايا قرار المالك. القاعدة ترفض تفعيل الباقة بلا سعرين موجبين (subscription_plans_store_priced).
                الحقلان معبّآن بالسعر المعتمد (500 شهري / 5000 سنوي) — عدّلهما قبل الحفظ إن لزم.
                إلغاء تحديد التفعيل يحفظ السعر فقط ولا يوقف باقة مفعّلة؛ أوقفها بزر «إلغاء تفعيل باقة المتاجر» بتأكيد وسبب.</p>`
            : (planRes?.error ? errorBlock(friendlyError(planRes.error))
                : stateBlock({ text: 'الباقة غير موجودة (118 غير مطبّق).' }))}
        <h3 class="panel-title">حد التذاكر ومزايا باقة المتاجر</h3>
        ${planCfg ? `<form class="owner-action-form" id="storeQuotaForm" novalidate>
                <div class="form-field">
                    <label for="planQuota">حد التذاكر الشهري (فارغ = بلا حد)</label>
                    <input type="number" class="form-control" id="planQuota" min="1" step="1" inputmode="numeric"
                        value="${esc(planCfg.ticket_quota ?? '')}">
                </div>
                <div class="form-field">
                    <span>المزايا المفعّلة</span>
                    ${(planCfg.features || []).map((f) => `<label><input type="checkbox" class="planFeature" value="${esc(f.feature_key)}" ${f.enabled ? 'checked' : ''}> ${esc(STORE_FEATURE_LABELS[f.feature_key] || f.feature_key)}</label>`).join('')}
                </div>
                <div class="form-field">
                    <label for="planQuotaReason">السبب (10 أحرف على الأقل، يُسجَّل في تدقيق المالك)</label>
                    <input type="text" class="form-control" id="planQuotaReason" maxlength="300" autocomplete="off" required>
                </div>
                <div class="form-actions">
                    <button type="submit" class="btn btn-primary btn-sm" data-critical>حفظ حد التذاكر والمزايا</button>
                </div>
                <p class="owner-sie-status" id="planQuotaStatus" role="status" aria-live="polite" hidden></p>
            </form>
            <p class="field-hint">الحقل فارغ يعني بلا حد للتذاكر — لا حد افتراضي؛ أدخل الرقم بنفسك. الحد الحالي: ${planCfg.ticket_quota == null ? 'بلا حد' : esc(num(planCfg.ticket_quota))}.</p>`
            : (planRes?.error ? errorBlock(friendlyError(planRes.error))
                : stateBlock({ text: 'تعذّر تحميل إعداد باقة المتاجر.' }))}
        <h3 class="panel-title">تعارضات الامتياز</h3>
        ${data ? `<ul class="company-list">
            <li>متاجر لها ربط حي بلا امتياز شوبيفاي: <strong>${esc(num(mismatch.length))}</strong>${mismatch.length ? ` — ${mismatch.map((m) => esc(m.company_name)).join('، ')}` : ''}</li>
            <li>متاجر بلا اشتراك فعّال: <strong>${esc(num(data?.stores_without_subscription))}</strong></li>
            <li>اشتراكات باقة المتاجر على حساب ليس متجرًا: <strong>${esc(num(data?.store_plan_on_non_store))}</strong></li>
            <li>طلبات حسابات متاجر قيد المراجعة: <strong>${esc(num(data?.pending_store_requests))}</strong> — <a href="#storeRequests">المراجعة في هذه الصفحة</a> · وطلبات الشركات (غير المتاجر) في قسم «طلبات حسابات الشركات» أدناه</li>
        </ul>`
            : errorBlock(friendlyError(diagRes.error))}`;
    $('storePriceForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const status = (t, tone) => announce(form.querySelector('#planPriceStatus'), t, tone);
        const { args, error: argError } = storePlanPriceArgs({
            monthly: form.querySelector('#planMonthly').value,
            yearly: form.querySelector('#planYearly').value,
            activate: form.querySelector('#planActivate').checked
        });
        if (argError) { status(argError, 'error'); return; }
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        const { data: saved, error: saveError } = await rpc('owner_set_store_plan_price', args);
        btn.disabled = false;
        if (saveError) { status(friendlyError(saveError), 'error'); return; }
        say(saved?.is_active ? 'حُفظ سعر باقة المتاجر وفُعّلت.' : 'حُفظ سعر باقة المتاجر.', 'success');
        loadDiagnostics();
    });
    $('planDeactivate')?.addEventListener('click', () => openSubReasonModal({
        title: 'إلغاء تفعيل باقة المتاجر',
        text: 'سيتوقف بيع باقة المتاجر لمتاجر جديدة فورًا (الشراء والترقية يتحققان من تفعيل الباقة)، وتبقى اشتراكات المتاجر القائمة سارية حتى انتهائها. الأسعار المحفوظة تبقى كما هي، ويمكن إعادة التفعيل بها لاحقًا من النموذج نفسه.',
        confirmLabel: 'إلغاء تفعيل الباقة', confirmTone: 'btn-danger',
        onConfirm: async (reason) => {
            // الأسعار المحفوظة لا المدخلات: إلغاء التفعيل وحده لا يغيّر السعرين.
            const { args, error: argError } = storePlanPriceArgs({
                monthly: plan.price_monthly, yearly: plan.price_yearly, deactivate: true, reason
            });
            if (argError) return { error: { message: argError } };
            const { error } = await rpc('owner_set_store_plan_price', args);
            if (!error) { say('أُلغي تفعيل باقة المتاجر — الأسعار المحفوظة باقية.', 'success'); loadDiagnostics(); }
            return { error };
        }
    }));
    $('storeQuotaForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const status = (t, tone) => announce(form.querySelector('#planQuotaStatus'), t, tone);
        const rawQuota = form.querySelector('#planQuota').value.trim();
        const quota = rawQuota === '' ? null : Number(rawQuota);
        if (quota !== null && (!Number.isFinite(quota) || quota <= 0 || !Number.isInteger(quota))) {
            status('حد التذاكر رقم صحيح موجب، أو اتركه فارغًا بلا حد.', 'error');
            return;
        }
        const features = [...form.querySelectorAll('.planFeature:checked')].map((c) => c.value);
        const reason = form.querySelector('#planQuotaReason').value;
        const err = storeReasonError(reason);
        if (err) { status(err, 'error'); return; }
        const doSave = async () => {
            const btn = form.querySelector('button[type=submit]');
            btn.disabled = true;
            const { error: quotaError } = await rpc('owner_set_store_plan_quota_features', {
                p_monthly_quota: quota, p_features: features, p_reason: reason
            });
            btn.disabled = false;
            if (quotaError) { status(friendlyError(quotaError), 'error'); return; }
            say('حُفظ حد التذاكر ومزايا باقة المتاجر.', 'success');
            loadDiagnostics();
        };
        // 135: تعطيل shopify_integration أو إلغاء كل المزايا لا يمر بصمت.
        const warning = storeQuotaDisableWarning({
            currentFeatures: (planCfg?.features || []).filter((f) => f.enabled).map((f) => f.feature_key),
            selectedFeatures: features
        });
        if (warning) { openQuotaDisableConfirm({ warning, onConfirm: doSave }); return; }
        await doSave();
    });
    renderKpis();
}

/** تأكيد صريح قبل حفظ حصة تعطل shopify_integration أو تلغي كل المزايا (135). */
function openQuotaDisableConfirm({ warning, onConfirm }) {
    const names = warning.disabling.map((f) => STORE_FEATURE_LABELS[f] || f).join('، ');
    const modal = openModal({
        title: 'تأكيد تعطيل مزايا باقة المتاجر',
        html: `<p class="panel-subtitle">${warning.disablesAll
            ? 'أنت على وشك إلغاء كل مزايا باقة المتاجر.'
            : 'أنت على وشك تعطيل مزايا من باقة المتاجر.'}</p>
            <p class="panel-subtitle">المزايا التي ستُعطَّل: <strong>${esc(names)}</strong></p>
            ${warning.disablesShopify ? '<p class="panel-subtitle"><strong>تنبيه:</strong> تعطيل «تكامل Shopify» يوقف امتياز شوبيفاي للمتاجر على هذه الباقة — وستظهر روابطها بلا امتياز في تنبيهات هذه الصفحة.</p>' : ''}
            <p class="panel-subtitle">هذا الإجراء يُسجَّل في تدقيق المالك مع السبب الذي كتبته، ويمكن التراجع عنه من النموذج نفسه بإعادة تحديد المزايا.</p>
            <div class="form-actions">
                <button type="button" class="btn btn-danger btn-sm" id="quotaDisableConfirm">تأكيد الحفظ وتعطيل المزايا</button>
                <button type="button" class="btn btn-outline btn-sm" id="quotaDisableCancel">إلغاء</button>
            </div>`
    });
    modal.body.querySelector('#quotaDisableConfirm').addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        modal.close();
        await onConfirm();
    });
    modal.body.querySelector('#quotaDisableCancel').addEventListener('click', () => modal.close());
}

function entitlementLine(e) {
    const label = STORE_FEATURE_LABELS[e.feature_key] || e.feature_key;
    if (!e.granted) return `<li>${esc(label)}: غير ممنوح</li>`;
    if (!e.active) return `<li>${esc(label)}: منتهٍ${e.expires_at ? ` — انتهى ${esc(when(e.expires_at))}` : ''}</li>`;
    const days = e.days_remaining ?? testDaysRemaining(e.expires_at);
    return `<li>${esc(label)}: نشط حتى ${esc(when(e.expires_at))}${days == null ? '' : ` — باقٍ ${esc(num(days))} يوم`}</li>`;
}

function openKindModal(own) {
    const toStore = own.account_kind !== 'ecommerce_store';
    const toKind = toStore ? 'ecommerce_store' : 'company';
    const modal = openModal({
        title: toStore ? 'تحويل شركتي إلى متجر اختبار' : 'إرجاع شركتي إلى شركة',
        html: `<form class="owner-action-form" id="kindForm" novalidate>
            <p class="panel-subtitle">${toStore
                ? `سيتحول «${esc(own.company_name)}» من شركة إلى متجر إلكتروني تجريبي — على شركتك أنت فقط.`
                : `سيعود «${esc(own.company_name)}» من متجر إلكتروني إلى شركة. إن كان له ربط Shopify حي غير مفصول فالقاعدة ترفض التحويل — افصل الربط أولًا.`}</p>
            <div class="form-field">
                <label for="kindReason">السبب (10 أحرف على الأقل، يُسجَّل في تدقيق المالك)</label>
                <input type="text" class="form-control" id="kindReason" maxlength="300" autocomplete="off" required
                    value="اختبار تجربة المتجر على شركة المالك">
            </div>
            <div class="form-actions">
                <button type="submit" class="btn btn-primary btn-sm" data-critical>${toStore ? 'تحويل إلى متجر اختبار' : 'إرجاع إلى شركة'}</button>
            </div>
            <p class="owner-sie-status" id="kindStatus" role="status" aria-live="polite" hidden></p>
        </form>`
    });
    const form = modal.body.querySelector('#kindForm');
    const status = (t, tone) => announce(form.querySelector('#kindStatus'), t, tone);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const reason = form.querySelector('#kindReason').value;
        const err = storeReasonError(reason);
        if (err) { status(err, 'error'); return; }
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        const { error } = await rpc('owner_set_company_account_kind', { p_company: own.company_id, p_kind: toKind, p_reason: reason });
        if (error) { status(friendlyError(error), 'error'); btn.disabled = false; return; }
        modal.close();
        say('تم تغيير نوع شركتك.', 'success');
        refresh();
    });
}

function openRevokeModal() {
    const modal = openModal({
        title: 'سحب امتيازات الاختبار',
        html: `<p class="panel-subtitle">ستُسحب امتيازات المتجر التجريبية الثلاث عن شركتك فورًا. يمكن منحها من جديد بعد ذلك.</p>
            <div class="form-actions">
                <button type="button" class="btn btn-danger btn-sm" id="confirmRevoke">سحب الامتيازات</button>
            </div>
            <p class="owner-sie-status" id="revokeStatus" role="status" aria-live="polite" hidden></p>`
    });
    modal.body.querySelector('#confirmRevoke').addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        const { error } = await rpc('owner_store_test_entitlements', { p_enable: false, p_days: 1, p_reason: null });
        if (error) { announce(modal.body.querySelector('#revokeStatus'), friendlyError(error), 'error'); e.currentTarget.disabled = false; return; }
        modal.close();
        say('سُحبت امتيازات الاختبار.', 'success');
        loadTestStore();
        loadDiagnostics();
    });
}

function openMgmtRevokeModal() {
    const modal = openModal({
        title: 'سحب إدارة المتجر للاختبار',
        html: `<p class="panel-subtitle">ستُسحب إدارة المتجر عن متجر الاختبار فورًا، وتعود عمليات الكتابة في شوبيفاي مرفوضة. يمكن منحها من جديد بعد ذلك.</p>
            <div class="form-actions">
                <button type="button" class="btn btn-danger btn-sm" id="confirmMgmtRevoke">سحب إدارة المتجر</button>
            </div>
            <p class="owner-sie-status" id="mgmtRevokeStatus" role="status" aria-live="polite" hidden></p>`
    });
    modal.body.querySelector('#confirmMgmtRevoke').addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        const { error } = await rpc('owner_store_test_management', { p_enable: false, p_days: 1, p_reason: null });
        if (error) { announce(modal.body.querySelector('#mgmtRevokeStatus'), friendlyError(error), 'error'); e.currentTarget.disabled = false; return; }
        modal.close();
        say('سُحبت إدارة المتجر.', 'success');
        loadTestStore();
        loadDiagnostics();
    });
}

async function loadTestStore() {
    const box = $('testStore');
    box.innerHTML = loadingBlock();
    const [{ data: sec }, { data: status, error: statusError }] = await Promise.all([
        rpc('owner_security_status'),
        rpc('owner_store_test_status')
    ]);
    if (statusError) { box.innerHTML = errorBlock(friendlyError(statusError)); return; }
    const fresh = sec?.step_up_fresh === true;
    const own = status?.has_company ? status : null;
    const isStore = status?.is_test_store === true;
    const entitlements = status?.entitlements || [];
    const anyActive = entitlements.some((e) => e.active);
    box.innerHTML = `
        ${own ? `<p class="panel-subtitle">شركتك: <strong>${esc(own.company_name)}</strong> — نوعها الآن <strong>${esc(TYPE_LABELS[own.account_kind])}</strong></p>`
              : stateBlock({ text: 'لا شركة باسم حسابك. متجر الاختبار يُبنى على شركة المالك نفسه.' })}
        ${fresh ? '' : '<p class="panel-subtitle">العمليات أدناه محمية: يُطلب رمز التحقق بخطوتين لحظة تنفيذها.</p>'}
        ${own ? `<h3 class="panel-title">امتيازات الاختبار الحالية</h3>
            ${anyActive ? `<ul class="company-list">${entitlements.map(entitlementLine).join('')}</ul>`
                        : '<p class="panel-subtitle">لا امتيازات تجريبية.</p>'}
            <div class="toolbar">
                <button type="button" class="btn btn-outline btn-sm" data-kind="${isStore ? 'company' : 'ecommerce_store'}" data-critical>${isStore ? 'إرجاع شركتي إلى شركة' : 'تحويل شركتي إلى متجر اختبار'}</button>
            </div>
            ${isStore ? `<form class="owner-action-form" id="testGrantForm" novalidate>
                <div class="form-field">
                    <label for="testDays">المدة</label>
                    <select id="testDays" class="form-control owner-filter-select"><option value="1">يوم</option><option value="7" selected>7 أيام</option><option value="30">30 يومًا</option></select>
                </div>
                <div class="form-field">
                    <label for="testGrantReason">السبب (يُسجَّل في تدقيق المالك)</label>
                    <input type="text" class="form-control" id="testGrantReason" maxlength="300" autocomplete="off" required
                        value="اختبار امتيازات المتجر على شركة المالك">
                </div>
                <div class="form-actions">
                    <button type="submit" class="btn btn-primary btn-sm" data-critical>منح امتيازات المتجر لشركتي للاختبار</button>
                    <button type="button" class="btn btn-outline btn-sm" id="testRevoke" data-critical>سحبها</button>
                </div>
                <p class="owner-sie-status" id="testGrantStatus" role="status" aria-live="polite" hidden></p>
            </form>
            <form class="owner-action-form" id="testMgmtForm" novalidate>
                <div class="form-field">
                    <label for="testMgmtDays">مدة إدارة المتجر</label>
                    <select id="testMgmtDays" class="form-control owner-filter-select"><option value="1">يوم</option><option value="7" selected>7 أيام</option><option value="30">30 يومًا</option></select>
                </div>
                <div class="form-field">
                    <label for="testMgmtReason">السبب (يُسجَّل في تدقيق المالك)</label>
                    <input type="text" class="form-control" id="testMgmtReason" maxlength="300" autocomplete="off" required
                        value="اختبار إدارة المتجر على شركة المالك">
                </div>
                <p class="panel-subtitle">تفعيل «إدارة المتجر» وحده لا يكفي: بعد المنح أعد تفويض Shopify من صفحة المتجر في لوحة الشركة لمنح التطبيق نطاقات الكتابة (إدارة المتجر تتطلب النطاقات التسعة عشر).</p>
                <div class="form-actions">
                    <button type="submit" class="btn btn-primary btn-sm" data-critical>منح إدارة المتجر للاختبار</button>
                    <button type="button" class="btn btn-outline btn-sm" id="testMgmtRevoke" data-critical>سحب إدارة المتجر</button>
                </div>
                <p class="owner-sie-status" id="testMgmtStatus" role="status" aria-live="polite" hidden></p>
            </form>` : ''}` : ''}
        <h3 class="panel-title">معاينة لوحة المتجر</h3>
        <p class="panel-subtitle">معاينة متجر أي شركة من قسم «معاينة متجر شركة» أدناه — قراءة فقط، بلا تبديل سياق. واجهة «معاينة عضو» تعرض اللوحة كعضو؛ الكتابة وبيانات شوبيفاي الحية مرفوضة في القاعدة أثناء المعاينة.</p>`;
    // بلا جلسة تحرير: النقرة تفتح نافذة التحقق ثم تُكمل الإجراء (installCriticalGuard — 121)
    box.querySelectorAll('[data-critical]').forEach((b) => { if (!fresh) b.title = 'عملية محمية: يُطلب رمز التحقق عند التنفيذ'; });
    box.querySelector('[data-kind]')?.addEventListener('click', () => openKindModal(own));
    $('testGrantForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const status = (t, tone) => announce(form.querySelector('#testGrantStatus'), t, tone);
        const reason = form.querySelector('#testGrantReason').value;
        const err = storeReasonError(reason);
        if (err) { status(err, 'error'); return; }
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        const { data, error } = await rpc('owner_store_test_entitlements', { p_enable: true, p_days: Number(form.querySelector('#testDays').value), p_reason: reason });
        btn.disabled = false;
        if (error) { status(friendlyError(error), 'error'); return; }
        say(`مُنحت حتى ${when(data?.expires_at)}.`, 'success');
        loadTestStore();
        loadDiagnostics();
    });
    $('testRevoke')?.addEventListener('click', openRevokeModal);
    $('testMgmtForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const status = (t, tone) => announce(form.querySelector('#testMgmtStatus'), t, tone);
        const reason = form.querySelector('#testMgmtReason').value;
        const err = storeReasonError(reason);
        if (err) { status(err, 'error'); return; }
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        const { data, error } = await rpc('owner_store_test_management', { p_enable: true, p_days: Number(form.querySelector('#testMgmtDays').value), p_reason: reason });
        btn.disabled = false;
        if (error) { status(friendlyError(error), 'error'); return; }
        say(`مُنحت إدارة المتجر حتى ${when(data?.expires_at)}.`, 'success');
        loadTestStore();
        loadDiagnostics();
    });
    $('testMgmtRevoke')?.addEventListener('click', openMgmtRevokeModal);
}

function renderKpis() {
    const c = accounts.counts || {};
    const conns = integrations?.connections || [];
    const problems = conns.filter((x) => x.status !== 'active' || (x.missing_scopes || []).length || x.last_sync_status === 'failed' || !x.entitled).length;
    $('storesKpis').innerHTML = kpis([
        ['حسابات فردية', num(c.individual || 0), ''],
        ['شركات', num(c.company || 0), ''],
        ['متاجر إلكترونية', num(c.ecommerce_store || 0), 'kpi--accent'],
        ['متاجر مربوطة بشوبيفاي', num(conns.filter((x) => x.status === 'active').length), 'kpi--success'],
        ['روابط تحتاج انتباهًا', num(problems), problems ? 'kpi--warning' : ''],
        ['طلبات متاجر قيد المراجعة', num(diagnostics?.pending_store_requests ?? 0), diagnostics?.pending_store_requests ? 'kpi--info' : ''],
        ['طلبات شركات قيد المراجعة', num(companyRequests.filter((r) => r.status === 'pending').length), companyRequests.some((r) => r.status === 'pending') ? 'kpi--info' : '']
    ]);
}

/* ───────────────────────── معاينة متجر شركة (قراءة فقط) ─────────────────────────
   owner_company_store_overview(p_company) — نفس جسم store_overview() في الشركة (119)
   مع v_company := p_company (الترحيل 147). لا تبديل سياق: الشركة تُختار هنا
   من القائمة أو من جدول الحسابات. قبل 147 تظهر حالة «غير متاح بعد» لا تفريغ خطأ. */
const STORE_PREVIEW_ENTITLEMENTS = {
    store_support: 'دعم المتاجر', shopify_integration: 'تكامل شوبيفاي', integrations_hub: 'مركز التكاملات'
};

function storePreviewMissing(error) {
    if (!error) return false;
    if (error.code === 'PGRST202' || error.code === '42883') return true;
    return /does not exist|not found|PGRST202|42883/i.test(error.message || '');
}

async function loadStorePreview() {
    const sel = $('storePreviewCompany');
    const current = sel.value;
    const { data, error } = await rpc('owner_accounts_overview', {
        p_type: null, p_search: null, p_limit: 200, p_offset: 0,
        p_sub_status: null, p_shopify_status: null, p_suspended: null
    });
    if (error) {
        $('storePreview').innerHTML = errorBlock(friendlyError(error));
        return;
    }
    const companies = (data?.items || []).filter(a => a.company_id);
    sel.innerHTML = '<option value="">اختر شركة أو متجرًا…</option>' + companies.map(a =>
        `<option value="${esc(a.company_id)}">${esc(a.company_name || a.name || '—')}</option>`).join('');
    if (current && companies.some(a => String(a.company_id) === String(current))) {
        sel.value = current;
        loadStorePreviewData(current, sel.options[sel.selectedIndex]?.textContent || '');
    } else if (!current) {
        $('storePreview').innerHTML = stateBlock({ text: 'اختر شركة أو متجرًا من القائمة، أو اضغط «معاينة المتجر» بجانب أي حساب في جدول الحسابات.' });
    }
}

async function loadStorePreviewData(companyId, companyName) {
    const box = $('storePreview');
    box.innerHTML = loadingBlock();
    const { data, error } = await rpc('owner_company_store_overview', { p_company: companyId });
    if (error) {
        box.innerHTML = storePreviewMissing(error)
            ? stateBlock({ title: 'معاينة المتجر غير متاحة بعد',
                           text: 'دالة المالك owner_company_store_overview() لم تُنشر على الخادم بعد (الترحيل 147). تُفعَّل المعاينة فور تطبيقه.' })
            : errorBlock(friendlyError(error));
        return;
    }
    const d = data || {};
    const ent = d.entitlements || {};
    const conn = d.connection || null;
    const activity = Array.isArray(d.recent_activity) ? d.recent_activity : [];
    box.innerHTML = `
        <p class="panel-subtitle">معاينة قراءة فقط لمتجر <strong>${esc(companyName)}</strong> — كما يراها مديره. لا كتابة من هنا، ولا بيانات عملاء أو طلبات.</p>
        <div class="kpi-grid">${kpis([
            ['تذاكر مفتوحة', num(d.open_tickets ?? 0), (d.open_tickets ?? 0) ? 'kpi--warning' : ''],
            ['طلبات متجر غير محسومة', d.unresolved_requests == null ? '—' : num(d.unresolved_requests), (d.unresolved_requests ?? 0) ? 'kpi--warning' : ''],
            ['طلبات متأخرة', d.overdue_requests == null ? '—' : num(d.overdue_requests), (d.overdue_requests ?? 0) ? 'kpi--danger' : ''],
            ['محادثات شركة مفتوحة', d.active_conversations == null ? '—' : num(d.active_conversations), ''],
            ['تذاكر مفتوحة مرتبطة بطلب', num(d.order_linked_open_tickets ?? 0), '']
        ])}</div>
        <dl class="owner-detail-grid">
            <div><dt>الامتيازات</dt><dd>${Object.entries(STORE_PREVIEW_ENTITLEMENTS).map(([k, label]) =>
                `<span class="pill ${ent[k] ? 'status-resolved' : 'status-neutral'}">${esc(label)}</span>`).join(' ')}</dd></div>
            <div><dt>شوبيفاي مفعّل على المنصة</dt><dd>${d.shopify_enabled ? 'نعم' : 'لا'}</dd></div>
            <div><dt>ربط شوبيفاي</dt><dd>${conn
                ? `${esc(CONN_LABELS[conn.status] || conn.status)}${conn.account_label ? ` — ${esc(conn.account_label)}` : ''}${conn.base_url ? ` <span class="owner-cell-muted" dir="ltr">${esc(conn.base_url)}</span>` : ''}${conn.last_error_code ? ` <span class="owner-cell-muted">${esc(conn.last_error_code)}</span>` : ''}`
                : 'بلا ربط'}</dd></div>
        </dl>
        <h3 class="panel-title">النشاط الأخير</h3>
        ${table(['الطلب', 'النوع', 'الإجراء', 'الحالة الجديدة', 'الوقت'], activity, (e) => `<tr>
            <td dir="ltr">${esc(e.order_ref || e.request_id || '—')}</td>
            <td>${esc(e.kind || '—')}</td>
            <td>${esc(e.action || '—')}</td>
            <td>${esc(e.to_status || '—')}</td>
            <td>${esc(when(e.created_at))}</td>
        </tr>`, { empty: 'لا نشاط مسجّل بعد.' })}`;
}

function previewStore(companyId, companyName) {
    const sel = $('storePreviewCompany');
    if (![...sel.options].some(o => o.value === companyId)) {
        const opt = document.createElement('option');
        opt.value = companyId;
        opt.textContent = companyName || companyId;
        sel.appendChild(opt);
    }
    sel.value = companyId;
    loadStorePreviewData(companyId, companyName);
    document.getElementById('storePreviewHeading')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function refresh() {
    loadAlerts();
    loadAccounts(0);
    loadRequests();
    loadCompanyRequests();
    loadIntegrations();
    loadDiagnostics();
    loadOpsLog();
    loadTestStore();
    loadStorePreview();
}

(async function init() {
    const booted = await bootOwnerPage();
    if (!booted) return;
    session = booted.session;
    $('accountsFilters').addEventListener('submit', (e) => { e.preventDefault(); loadAccounts(0); });
    $('accountsType').addEventListener('change', () => loadAccounts(0));
    ['accountsSubStatus', 'accountsShopify', 'accountsSuspended'].forEach((id) => $(id).addEventListener('change', () => loadAccounts(0)));
    $('accountsExport').addEventListener('click', exportAccountsCsv);
    let t = null;
    $('accountsSearch').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => loadAccounts(0), 300); });
    $('companyReqStatus').addEventListener('change', renderCompanyRequests);
    let ct = null;
    $('companyReqSearch').addEventListener('input', () => { clearTimeout(ct); ct = setTimeout(renderCompanyRequests, 250); });
    $('companyReqFilters').addEventListener('submit', (e) => { e.preventDefault(); renderCompanyRequests(); });
    $('storesRefresh').addEventListener('click', refresh);
    $('storePreviewForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const sel = $('storePreviewCompany');
        if (!sel.value) return;
        loadStorePreviewData(sel.value, sel.options[sel.selectedIndex]?.textContent || '');
    });
    $('storePreviewCompany').addEventListener('change', (e) => {
        if (!e.target.value) return;
        loadStorePreviewData(e.target.value, e.target.options[e.target.selectedIndex]?.textContent || '');
    });
    refresh();
})();
