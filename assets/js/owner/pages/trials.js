/**
 * owner/trials.html — طلبات التجربة المجانية 3 أيام (الترحيل 137).
 *
 *   • owner_list_saas_trial_requests: قراءة المالك — المعلّقة أولًا.
 *   • owner_decide_saas_trial: قرار المالك بتحقق حديث (owner_critical_ok
 *     في القاعدة) — موافقة تبدأ الـ 3 أيام فورًا باشتراك تجربة على الحساب
 *     الحي نفسه (بلا دفع وبلا تجديد تلقائي وبلا بيئة تجريبية)، أو رفض
 *     بسبب مسجَّل ≥10 أحرف. القرار يُفحص هنا أولًا عبر trialDecisionArgs.
 *   • بلا موافقة مالك لا تبدأ أي تجربة: الطلبات تبقى معلّقة حتى القرار.
 *   • لا window.prompt في هذه الصفحة إطلاقًا — القرار من نافذة بسبب.
 */
import {
    supabase, bootOwnerPage, announce, esc, when, num, table, kpis, errorBlock, loadingBlock, openModal,
    friendlyError
} from '/assets/js/owner/owner-page.js';
import {
    TRIAL_PLAN_LABELS, trialDecisionArgs, trialRequestView
} from '/assets/js/saas-trial-model.js';

const $ = (id) => document.getElementById(id);
const say = (text, tone = 'info') => announce($('pageStatus'), text, tone);

let session = null;
let requests = [];

async function rpc(name, args) {
    // النداء نفسه قد يرمي (انقطاع شبكة) لا أن يعود بـ error: بلا التقاط كانت
    // القائمة تبقى هيكلًا عظميًا بلا تفسير.
    try {
        const { data, error } = await supabase.rpc(name, args);
        return { data, error };
    } catch (err) {
        return { data: null, error: err };
    }
}

function filteredRequests() {
    const status = $('trialStatus').value || '';
    const plan = $('trialPlan').value || '';
    return requests.filter((r) => (status === '' || r.status === status) && (plan === '' || r.plan_key === plan));
}

function renderKpis() {
    const pending = requests.filter((r) => r.status === 'pending').length;
    const active = requests.filter((r) => r.status === 'approved'
        && r.trial_ends_at && new Date(r.trial_ends_at).getTime() > Date.now()).length;
    const expired = requests.filter((r) => r.status === 'expired').length;
    const rejected = requests.filter((r) => r.status === 'rejected').length;
    $('trialKpis').innerHTML = kpis([
        ['طلبات معلّقة', num(pending), pending ? 'kpi--info' : ''],
        ['تجارب جارية', num(active), active ? 'kpi--success' : ''],
        ['تجارب منتهية', num(expired), ''],
        ['طلبات مرفوضة', num(rejected), '']
    ]);
}

async function loadRequests() {
    $('trialRequests').innerHTML = loadingBlock();
    const { data, error } = await rpc('owner_list_saas_trial_requests', { p_status: null });
    if (error) { $('trialRequests').innerHTML = errorBlock(friendlyError(error)); return; }
    requests = Array.isArray(data) ? data : [];
    renderRequests();
    renderKpis();
}

function renderRequests() {
    const rows = filteredRequests();
    $('trialRequests').innerHTML = table(
        ['الشركة', 'الباقة', 'الطالب', 'الحالة', 'طُلب في', 'التجربة', 'إجراء'],
        rows,
        (r) => {
            const view = trialRequestView(r);
            return `<tr>
        <td><div class="owner-account"><span class="owner-account-name">${esc(r.company_name || '—')}</span>
            <span class="owner-account-email">${esc(r.account_kind === 'ecommerce_store' ? 'متجر إلكتروني' : 'شركة')}</span></div></td>
        <td>${esc(TRIAL_PLAN_LABELS[r.plan_key] || r.plan_name_ar || r.plan_key)}</td>
        <td><span class="owner-account-email owner-mono" dir="ltr">${esc(r.requested_by_email || '')}</span></td>
        <td><span class="pill ${view.isPending ? 'status-tone-warning' : view.isActive ? 'status-tone-success' : 'status-neutral'}">${esc(view.statusLabel)}</span>
            ${r.status === 'rejected' && r.decision_reason ? `<br><span class="owner-account-email">${esc(r.decision_reason)}</span>` : ''}</td>
        <td>${esc(when(r.requested_at))}</td>
        <td>${r.trial_starts_at ? `${esc(when(r.trial_starts_at))} ← ${esc(when(r.trial_ends_at))}<br><span class="owner-account-email">${view.isActive ? `متبقٍ ${num(view.daysRemaining)} ${view.daysRemaining === 1 ? 'يوم' : 'أيام'}` : 'انتهت'}</span>` : '—'}</td>
        <td>${view.canDecide ? `
            <button type="button" class="btn btn-primary btn-sm" data-decide="approved" data-request="${esc(r.id)}" data-plan="${esc(TRIAL_PLAN_LABELS[r.plan_key] || r.plan_key)}" data-company="${esc(r.company_name || '')}">موافقة — تبدأ 3 أيام</button>
            <button type="button" class="btn btn-outline btn-sm" data-decide="rejected" data-request="${esc(r.id)}" data-plan="${esc(TRIAL_PLAN_LABELS[r.plan_key] || r.plan_key)}" data-company="${esc(r.company_name || '')}">رفض</button>` : '—'}</td></tr>`;
        },
        { empty: 'لا طلبات تجربة مطابقة.' });
    $('trialRequests').querySelectorAll('[data-decide]').forEach((b) => b.addEventListener('click', () =>
        openDecideModal(b.getAttribute('data-request'), b.getAttribute('data-decide'),
            b.getAttribute('data-plan'), b.getAttribute('data-company'))));
}

function openDecideModal(requestId, decision, planLabel, companyName) {
    const approve = decision === 'approved';
    const modal = openModal({
        title: approve ? `الموافقة على تجربة ${planLabel}` : `رفض تجربة ${planLabel}`,
        html: `<form class="owner-action-form" id="trialDecideForm" novalidate>
            <p class="panel-subtitle">${approve
                ? `سيبدأ اشتراك تجربة مجانية لـ «${esc(companyName || '')}» فورًا: 3 أيام بالضبط على الحساب الحي نفسه، بلا بطاقة وبلا دفع، وتنتهي تلقائيًا بلا تجديد وبلا خصم ولا تتحول لاشتراك مدفوع.`
                : `سيُرفض طلب تجربة «${esc(companyName || '')}» ويُسجَّل السبب — ولا يبدأ أي اشتراك.`}</p>
            <div class="form-field">
                <label for="trialDecideReason">${approve ? 'السبب (اختياري، يُسجَّل مع القرار)' : 'السبب (10 أحرف على الأقل، يُسجَّل مع القرار)'}</label>
                <input type="text" class="form-control" id="trialDecideReason" maxlength="300" autocomplete="off"
                    ${approve ? '' : 'required'} value="${approve ? 'موافقة على تجربة مجانية 3 أيام' : ''}">
            </div>
            <div class="form-actions">
                <button type="submit" class="btn ${approve ? 'btn-primary' : 'btn-danger'} btn-sm" data-critical>${approve ? 'موافقة — تبدأ التجربة 3 أيام' : 'رفض الطلب'}</button>
            </div>
            <p class="owner-sie-status" id="trialDecideStatus" role="status" aria-live="polite" hidden></p>
        </form>`
    });
    const form = modal.body.querySelector('#trialDecideForm');
    const status = (t, tone) => announce(form.querySelector('#trialDecideStatus'), t, tone);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const check = trialDecisionArgs({
            decision: approve ? 'approved' : 'rejected',
            reason: form.querySelector('#trialDecideReason').value
        });
        if (check.error) { status(check.error, 'error'); return; }
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        const { error } = await rpc('owner_decide_saas_trial',
            { p_request: requestId, p_decision: check.args.p_decision, p_reason: check.args.p_reason ?? null });
        if (error) { status(friendlyError(error), 'error'); btn.disabled = false; return; }
        modal.close();
        say(approve
            ? 'وُوفق على التجربة — بدأت الـ 3 أيام الآن على الحساب الحي.'
            : 'رُفض طلب التجربة وسُجّل السبب.', 'success');
        loadRequests();
    });
}

function refresh() {
    loadRequests();
}

(async function init() {
    const booted = await bootOwnerPage();
    if (!booted) return;
    session = booted.session;
    $('trialFilters').addEventListener('submit', (e) => { e.preventDefault(); renderRequests(); });
    $('trialStatus').addEventListener('change', renderRequests);
    $('trialPlan').addEventListener('change', renderRequests);
    $('trialRefresh').addEventListener('click', refresh);
    refresh();
})();
