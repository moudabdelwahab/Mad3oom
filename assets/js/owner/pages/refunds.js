/**
 * owner/refunds.html — طلبات تعويض إلغاء الاشتراكات المدفوعة (الترحيل 142).
 *
 *   • owner_list_refund_requests: قراءة المالك — المعلّقة أولًا.
 *   • owner_decide_refund: قرار المالك بتحقق حديث
 *     (owner_critical_ok في القاعدة) — موافقة تفتح باب التذكرة وبيانات
 *     التحويل (بلا دفع)، أو رفض بسبب مسجَّل ≥10 أحرف يرفض التعويض وحده
 *     ويبقي الإلغاء في نهاية مدته كما طلبه العميل.
 *   • owner_open_refund_ticket: بعد الموافقة، تذكرة تعويض من
 *     حساب العميل (فئة subscription، نطاق mad3oom_support) تطلب بيانات
 *     التحويل — بلا موافقة لا تُفتح تذكرة.
 *   • owner_mark_refund_paid: بعد وصول بيانات التحويل، تسجيل
 *     فقط لتحويل تمّ خارج النظام، بملاحظة مسجَّلة ≥10 أحرف ورسوم تحويل
 *     فعلية اختيارية تُخصم من الإجمالي — لا صرف مال هنا إطلاقًا.
 *   • لا window.prompt في هذه الصفحة إطلاقًا — القرارات من نوافذ بسبب.
 */
import {
    supabase, bootOwnerPage, announce, esc, when, num, table, kpis, errorBlock, loadingBlock, openModal,
    friendlyError
} from '/assets/js/owner/owner-page.js';
import {
    REFUND_RULES_TEXT, REFUND_TRANSFER_METHOD_LABELS,
    refundDecisionArgs, refundPaidArgs, refundRequestView, formatEgp
} from '/assets/js/cancel-refund-model.js';

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
    const status = $('refundStatus').value || '';
    return requests.filter((r) => status === '' || r.status === status);
}

function renderKpis() {
    const pending = requests.filter((r) => r.status === 'pending').length;
    const approved = requests.filter((r) => r.status === 'approved').length;
    const paid = requests.filter((r) => r.status === 'paid').length;
    const rejected = requests.filter((r) => r.status === 'rejected').length;
    const closed = requests.filter((r) => r.status === 'closed').length;
    const pendingTotal = requests
        .filter((r) => r.status === 'pending')
        .reduce((sum, r) => sum + (Number(r.refund_amount) || 0), 0);
    $('refundKpis').innerHTML = kpis([
        ['طلبات معلّقة', num(pending), pending ? 'kpi--info' : '', pending ? `بإجمالي ${formatEgp(pendingTotal)}` : ''],
        ['موافَق عليها', num(approved), approved ? 'kpi--success' : ''],
        ['مدفوعة', num(paid), ''],
        ['طلبات مرفوضة', num(rejected), ''],
        ['مغلقة بتراجع العميل', num(closed), '']
    ]);
}

async function loadRequests() {
    $('refundRequests').innerHTML = loadingBlock();
    const { data, error } = await rpc('owner_list_refund_requests', { p_status: null });
    if (error) { $('refundRequests').innerHTML = errorBlock(friendlyError(error)); return; }
    requests = Array.isArray(data) ? data : [];
    renderRequests();
    renderKpis();
}

function renderRequests() {
    const rows = filteredRequests();
    $('refundRequests').innerHTML = table(
        ['الشركة', 'المبلغ والأيام', 'السبب', 'الحالة', 'التذكرة والتحويل', 'إجراء'],
        rows,
        (r) => {
            const view = refundRequestView(r);
            const transfer = r.transfer_details_submitted_at
                ? `${esc(REFUND_TRANSFER_METHOD_LABELS[r.transfer_method] || r.transfer_method || '')} · ${esc(r.transfer_account || '')}<br><span class="owner-account-email">أُرسلت في ${esc(when(r.transfer_details_submitted_at))}</span>`
                : '—';
            const ticket = r.ticket_id
                ? `تذكرة #${esc(String(r.ticket_number ?? ''))}<br><span class="owner-account-email">${r.transfer_details_submitted_at ? 'بيانات التحويل وصلت' : 'بانتظار بيانات التحويل من العميل'}</span>`
                : '—';
            return `<tr>
        <td><div class="owner-account"><span class="owner-account-name">${esc(r.company_name || '—')}</span>
            <span class="owner-account-email owner-mono" dir="ltr">${esc(r.customer_email || '')}</span></div>
            <span class="owner-account-email">طُلب في ${esc(when(r.requested_at))}</span>
            ${r.status === 'pending' && r.reply_due_at ? `<br><span class="owner-account-email">مهلة الرد حتى ${esc(when(r.reply_due_at))}</span>` : ''}
            ${r.status === 'approved' && r.payment_due_at ? `<br><span class="owner-account-email">مهلة التحويل حتى ${esc(when(r.payment_due_at))}</span>` : ''}</td>
        <td><strong>${esc(formatEgp(r.refund_amount))}</strong> <span class="owner-account-email">${esc(view.refundKindLabel || '')} · ${esc(r.plan_name_ar || r.plan || '')}</span><br>
            <span class="owner-account-email">${esc(String(r.remaining_days))} ${r.remaining_days === 1 ? 'يوم' : 'أيام'} متبقية من ${esc(String(r.cycle_days))} يومًا · المدفوع ${esc(formatEgp(r.amount_paid))}${Number(r.transfer_fee) > 0 ? ` · رسوم ${esc(formatEgp(r.transfer_fee))} · الصافي ${esc(formatEgp(r.refund_net))}` : ''}</span></td>
        <td>${esc(r.cancel_reason || '—')}</td>
        <td><span class="pill ${view.isPending ? 'status-tone-warning' : view.isApproved ? 'status-tone-accent' : view.isPaid ? 'status-tone-success' : 'status-neutral'}">${esc(view.statusLabel)}</span>
            ${r.status === 'rejected' && r.decision_reason ? `<br><span class="owner-account-email">${esc(r.decision_reason)}</span>` : ''}
            ${r.status === 'closed' && r.close_reason ? `<br><span class="owner-account-email">${esc(r.close_reason)}</span>` : ''}
            ${r.status === 'paid' && r.paid_note ? `<br><span class="owner-account-email">${esc(r.paid_note)}</span>` : ''}</td>
        <td>${ticket}<br>${transfer}</td>
        <td>${view.canDecide ? `
            <button type="button" class="btn btn-primary btn-sm" data-decide="approved" data-request="${esc(r.id)}" data-company="${esc(r.company_name || '')}" data-amount="${esc(formatEgp(r.refund_amount))}">موافقة</button>
            <button type="button" class="btn btn-outline btn-sm" data-decide="rejected" data-request="${esc(r.id)}" data-company="${esc(r.company_name || '')}" data-amount="${esc(formatEgp(r.refund_amount))}">رفض</button>` : ''}
            ${view.canOpenTicket ? `
            <button type="button" class="btn btn-primary btn-sm" data-open-ticket="${esc(r.id)}" data-company="${esc(r.company_name || '')}">فتح تذكرة تعويض</button>` : ''}
            ${view.canMarkPaid ? `
            <button type="button" class="btn btn-primary btn-sm" data-mark-paid="${esc(r.id)}" data-company="${esc(r.company_name || '')}" data-amount="${esc(formatEgp(r.refund_amount))}">تسجيل الدفع</button>` : ''}
            ${!view.canDecide && !view.canOpenTicket && !view.canMarkPaid ? '—' : ''}</td></tr>`;
        },
        { empty: 'لا طلبات تعويض مطابقة.' });
    $('refundRequests').querySelectorAll('[data-decide]').forEach((b) => b.addEventListener('click', () =>
        openDecideModal(b.getAttribute('data-request'), b.getAttribute('data-decide'),
            b.getAttribute('data-company'), b.getAttribute('data-amount'))));
    $('refundRequests').querySelectorAll('[data-open-ticket]').forEach((b) => b.addEventListener('click', () =>
        openTicketModal(b.getAttribute('data-open-ticket'), b.getAttribute('data-company'))));
    $('refundRequests').querySelectorAll('[data-mark-paid]').forEach((b) => b.addEventListener('click', () =>
        openPaidModal(b.getAttribute('data-mark-paid'), b.getAttribute('data-company'), b.getAttribute('data-amount'))));
}

function openDecideModal(requestId, decision, companyName, amount) {
    const approve = decision === 'approved';
    const modal = openModal({
        title: approve ? 'الموافقة على طلب التعويض' : 'رفض طلب التعويض',
        html: `<form class="owner-action-form" id="refundDecideForm" novalidate>
            <p class="panel-subtitle">${approve
                ? `سيوافَق على تعويض «${esc(companyName || '')}» بمبلغ ${esc(amount || '')}. الموافقة لا تدفع شيئًا ولا تلغي فورًا — الاشتراك يبقى فعّالًا حتى نهاية مدته، وتفتح بعدها تذكرة تعويض تطلب بيانات التحويل من العميل.`
                : `سيُرفض تعويض «${esc(companyName || '')}» بمبلغ ${esc(amount || '')} ويُسجَّل السبب. الرفض يرفض التعويض وحده — الإلغاء في نهاية المدة يبقى كما طلبه العميل، ويمكنه التراجع عنه من لوحة الشركة قبل انتهائها.`}</p>
            <p class="panel-subtitle">${esc(REFUND_RULES_TEXT)}</p>
            <div class="form-field">
                <label for="refundDecideReason">${approve ? 'السبب (اختياري، يُسجَّل مع القرار)' : 'السبب (10 أحرف على الأقل، يُسجَّل مع القرار ويظهر للعميل)'}</label>
                <input type="text" class="form-control" id="refundDecideReason" maxlength="300" autocomplete="off"
                    ${approve ? '' : 'required'} value="${approve ? 'موافقة على طلب تعويض الإلغاء' : ''}">
            </div>
            <div class="form-actions">
                <button type="submit" class="btn ${approve ? 'btn-primary' : 'btn-danger'} btn-sm" data-critical>${approve ? 'موافقة — بلا دفع' : 'رفض الطلب'}</button>
            </div>
            <p class="owner-sie-status" id="refundDecideStatus" role="status" aria-live="polite" hidden></p>
        </form>`
    });
    const form = modal.body.querySelector('#refundDecideForm');
    const status = (t, tone) => announce(form.querySelector('#refundDecideStatus'), t, tone);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const check = refundDecisionArgs({
            decision: approve ? 'approved' : 'rejected',
            reason: form.querySelector('#refundDecideReason').value
        });
        if (check.error) { status(check.error, 'error'); return; }
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        const { error } = await rpc('owner_decide_refund',
            { p_request: requestId, p_decision: check.args.p_decision, p_reason: check.args.p_reason ?? null });
        if (error) { status(friendlyError(error), 'error'); btn.disabled = false; return; }
        modal.close();
        say(approve
            ? 'وُوفق على التعويض — افتح تذكرة التعويض لطلب بيانات التحويل من العميل.'
            : 'رُفض طلب التعويض وسُجّل السبب.', 'success');
        loadRequests();
    });
}

function openTicketModal(requestId, companyName) {
    const modal = openModal({
        title: 'فتح تذكرة تعويض',
        html: `<form class="owner-action-form" id="refundTicketForm" novalidate>
            <p class="panel-subtitle">ستُفتح تذكرة تعويض من حساب «${esc(companyName || '')}» (فئة اشتراك، نطاق فريق مدعوم، معفاة من رصيد تذاكر العميل عند الإنشاء) تطلب منه بيانات التحويل: وسيلة التحويل + رقم/حساب التحويل، من قسم «طلبات التعويض» في لوحة الشركة. البيانات تُحفظ على طلب التعويض وحده — لا في التذكرة.</p>
            <div class="form-actions">
                <button type="submit" class="btn btn-primary btn-sm" data-critical>فتح تذكرة التعويض</button>
            </div>
            <p class="owner-sie-status" id="refundTicketStatus" role="status" aria-live="polite" hidden></p>
        </form>`
    });
    const form = modal.body.querySelector('#refundTicketForm');
    const status = (t, tone) => announce(form.querySelector('#refundTicketStatus'), t, tone);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        const { error } = await rpc('owner_open_refund_ticket', { p_request: requestId });
        if (error) { status(friendlyError(error), 'error'); btn.disabled = false; return; }
        modal.close();
        say('فُتحت تذكرة التعويض — بانتظار بيانات التحويل من العميل.', 'success');
        loadRequests();
    });
}

function openPaidModal(requestId, companyName, amount) {
    const modal = openModal({
        title: 'تسجيل دفع التعويض',
        html: `<form class="owner-action-form" id="refundPaidForm" novalidate>
            <p class="panel-subtitle">تسجيل فقط: التحويل بمبلغ ${esc(amount || '')} إلى «${esc(companyName || '')}» تمّ خارج النظام فعلًا. هذا الزر لا يحوّل مالًا ولا يخصم من أي حساب — يسجّل أنك حوّلت، ويُشعر العميل ليتأكد من الوصول. رسوم التحويل الفعلية وحدها تُخصم من المبلغ (الصافي = الإجمالي − الرسوم).</p>
            <div class="form-field">
                <label for="refundPaidNote">ملاحظة الدفع (10 أحرف على الأقل: ما الذي حُوّل وأين ومتى)</label>
                <input type="text" class="form-control" id="refundPaidNote" maxlength="300" autocomplete="off" required>
            </div>
            <div class="form-field">
                <label for="refundPaidFee">رسوم التحويل الفعلية بالجنيه (اختياري، 0 إن لم توجد)</label>
                <input type="number" class="form-control" id="refundPaidFee" min="0" step="0.01" value="0" autocomplete="off" dir="ltr">
            </div>
            <div class="form-actions">
                <button type="submit" class="btn btn-primary btn-sm" data-critical>تسجيل الدفع</button>
            </div>
            <p class="owner-sie-status" id="refundPaidStatus" role="status" aria-live="polite" hidden></p>
        </form>`
    });
    const form = modal.body.querySelector('#refundPaidForm');
    const status = (t, tone) => announce(form.querySelector('#refundPaidStatus'), t, tone);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const check = refundPaidArgs({
            note: form.querySelector('#refundPaidNote').value,
            fee: form.querySelector('#refundPaidFee').value
        });
        if (check.error) { status(check.error, 'error'); return; }
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        const { error } = await rpc('owner_mark_refund_paid',
            { p_request: requestId, p_note: check.args.p_note, p_transfer_fee: check.args.p_transfer_fee });
        if (error) { status(friendlyError(error), 'error'); btn.disabled = false; return; }
        modal.close();
        say('سُجّل دفع التعويض — تحقق العميل من وصول المبلغ.', 'success');
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
    $('refundFilters').addEventListener('submit', (e) => { e.preventDefault(); renderRequests(); });
    $('refundStatus').addEventListener('change', renderRequests);
    $('refundRefresh').addEventListener('click', refresh);
    refresh();
})();
