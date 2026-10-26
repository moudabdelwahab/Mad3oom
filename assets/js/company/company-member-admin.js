/**
 * company-member-admin.js — إدارة عضو الشركة من لوحة الشركة (113): نافذة التفاصيل (ملف الشركة، بيانات
 * الدخول، رابط إعادة كلمة المرور، الإيقاف وإعادة التفعيل، طلب النقل، التذاكر، السجل) وقائمتا الموقوفين
 * وطلبات النقل في قسم «المستخدمون».
 *
 * كل قرار في القاعدة: الأزرار تظهر بما تعيده company_member_details، وأي فعل يعاد فحصه هناك. فإخفاء زر
 * تنظيم للعرض لا حماية. النصوص القادمة من الخادم تُهرَّب دائمًا.
 */
import { escapeHtml, formatDate, renderState, renderSkeletonLines } from '/assets/js/customer/portal-ui.js';
import { ui } from '/ui-service.js';
import {
    fetchMemberDetails, saveMemberProfile, updateMemberAccount, sendMemberPasswordReset, suspendMember,
    reactivateMember, fetchSuspendedMembers, requestMemberTransfer, cancelMemberTransfer, fetchMemberTransferRequests
} from '/assets/js/company/company-data.js';
import {
    JOINED_VIA_LABELS, TICKET_STATUS_LABELS, historyLabel, accountEditView, transferView, memberActionsView,
    validateProfileForm, validateAccountForm, validateReason, validateTransferForm, transferStatusInfo
} from '/assets/js/company/member-admin-model.js';

let notifyChanged = async () => {};
let openUserId = null;
let transferKey = null;
let lastFocus = null;

const $ = (id) => document.getElementById(id);
const toast = (msg, tone) => ui?.showToast?.(msg, tone);

export function initMemberAdmin({ onChanged } = {}) {
    if (typeof onChanged === 'function') notifyChanged = onChanged;
    const modal = $('memberDetailsModal');
    if (!modal || modal.dataset.wired) return;
    modal.dataset.wired = '1';
    $('memberDetailsClose')?.addEventListener('click', closeMemberDetails);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeMemberDetails(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal.classList.contains('active')) closeMemberDetails(); });
}

export function closeMemberDetails() {
    $('memberDetailsModal')?.classList.remove('active');
    openUserId = null;
    transferKey = null;
    lastFocus?.focus?.();
}

/** يفتح النافذة ويرسمها من القاعدة. */
export async function openMemberDetails(userId) {
    const modal = $('memberDetailsModal');
    if (!modal || !userId) return;
    if (openUserId !== userId) transferKey = null;
    openUserId = userId;
    lastFocus = document.activeElement;
    modal.classList.add('active');
    const body = $('memberDetailsBody');
    renderSkeletonLines(body, 6);
    const res = await fetchMemberDetails(userId);
    if (openUserId !== userId) return;
    if (!res.ok || !res.data) {
        $('memberDetailsTitle').textContent = 'تفاصيل العضو';
        renderState(body, {
            variant: res.ok ? 'empty' : 'error',
            title: res.ok ? 'إدارة الأعضاء غير متاحة بعد' : 'تعذّر تحميل تفاصيل العضو',
            text: res.ok ? 'يتطلب هذا تحديث المنصة (113).' : (res.error || 'حاول مرة أخرى.')
        });
        return;
    }
    renderDetails(res.data);
    $('memberDetailsClose')?.focus();
}

async function refreshAfter(message, tone = 'success') {
    if (message) toast(message, tone);
    await notifyChanged();
    if (openUserId) await openMemberDetails(openUserId);
}

const fieldError = (name) => `<p class="field-error" data-md-error-for="${name}" hidden></p>`;
function showErrors(form, errors) {
    form.querySelectorAll('[data-md-error-for]').forEach(el => { el.hidden = true; el.textContent = ''; });
    for (const [k, msg] of Object.entries(errors || {})) {
        const el = form.querySelector(`[data-md-error-for="${k}"]`);
        if (el) { el.textContent = msg; el.hidden = false; }
    }
}
function formError(form, message) {
    const box = form.querySelector('[data-md-form-error]');
    if (!box) return;
    box.textContent = message || '';
    box.hidden = !message;
}

function renderDetails(d) {
    const a = d.account || {};
    const cp = d.company_profile || {};
    const acc = accountEditView(d);
    const xfer = transferView(d);
    const act = memberActionsView(d);
    const name = cp.display_name || a.name || a.email || '—';
    $('memberDetailsTitle').textContent = name;
    const t = d.tickets || {};
    const body = $('memberDetailsBody');

    body.innerHTML = `
        <div class="md-head" data-md-state="${escapeHtml(d.state)}">
            <p class="company-sub-dates">${escapeHtml(a.email || '')}${a.phone ? ` · <span dir="ltr">${escapeHtml(a.phone)}</span>` : ''}</p>
            <p class="md-pills">
                <span class="pill ${d.state === 'suspended' ? 'status-tone-warning' : 'status-tone-success'}">${d.state === 'suspended' ? 'موقوف مؤقتًا' : 'نشط'}</span>
                ${d.staff_role ? `<span class="pill status-tone-accent">${d.staff_role === 'supervisor' ? 'مشرف' : 'موظف دعم'}</span>` : '<span class="pill status-neutral">عميل</span>'}
                ${d.membership ? `<span class="company-sub-days">انضم ${escapeHtml(formatDate(d.membership.joined_at))} · ${escapeHtml(JOINED_VIA_LABELS[d.membership.joined_via] || '')}</span>` : ''}
            </p>
            ${d.suspension ? `<p class="company-staff-note" data-md-suspension>أُوقف في ${escapeHtml(formatDate(d.suspension.suspended_at))}: ${escapeHtml(d.suspension.reason)}</p>` : ''}
        </div>

        <section class="md-section" aria-labelledby="mdProfileH">
            <h3 class="md-title" id="mdProfileH">ملف العضو لدى الشركة</h3>
            <p class="panel-subtitle">بيانات تخص شركتك وحدها؛ لا تغيّر حساب العضو ولا يراها غيركم.</p>
            <form class="company-form" id="mdProfileForm" novalidate>
                <div class="form-grid">
                    <div class="form-field"><label for="mdDisplayName">اسم العرض</label>
                        <input class="form-control" id="mdDisplayName" maxlength="120" value="${escapeHtml(cp.display_name || '')}">${fieldError('displayName')}</div>
                    <div class="form-field"><label for="mdProfilePhone">جوال التواصل</label>
                        <input class="form-control" id="mdProfilePhone" dir="ltr" inputmode="tel" value="${escapeHtml(cp.phone || '')}">${fieldError('phone')}</div>
                    <div class="form-field is-full"><label for="mdJobTitle">المسمى أو الصفة</label>
                        <input class="form-control" id="mdJobTitle" maxlength="80" value="${escapeHtml(cp.job_title || '')}">${fieldError('jobTitle')}</div>
                    <div class="form-field is-full"><label for="mdNotes">ملاحظات داخلية</label>
                        <textarea class="form-control" id="mdNotes" rows="3" maxlength="2000">${escapeHtml(cp.notes || '')}</textarea>${fieldError('notes')}</div>
                </div>
                <p class="field-error" data-md-form-error role="alert" hidden></p>
                <div class="company-form-actions"><button type="submit" class="btn btn-primary btn-sm" id="mdProfileSave">حفظ الملف</button></div>
            </form>
        </section>

        <section class="md-section" aria-labelledby="mdAccountH" data-md-account="${acc.editable ? 'editable' : 'readonly'}">
            <h3 class="md-title" id="mdAccountH">بيانات الدخول</h3>
            <p class="panel-subtitle">${escapeHtml(acc.note)}</p>
            ${acc.editable ? `
            <form class="company-form" id="mdAccountForm" novalidate>
                <div class="form-grid">
                    <div class="form-field is-full"><label for="mdFullName">الاسم</label>
                        <input class="form-control" id="mdFullName" maxlength="120" value="${escapeHtml(a.full_name || '')}" autocomplete="off">${fieldError('fullName')}</div>
                    <div class="form-field"><label for="mdAccountPhone">رقم الجوال</label>
                        <input class="form-control" id="mdAccountPhone" dir="ltr" inputmode="tel" value="${escapeHtml(a.phone || '')}" autocomplete="off">${fieldError('phone')}</div>
                    <div class="form-field"><label for="mdAccountEmail">البريد الإلكتروني (للدخول)</label>
                        <input class="form-control" id="mdAccountEmail" dir="ltr" type="email" value="${escapeHtml(a.email || '')}" autocomplete="off">${fieldError('email')}</div>
                </div>
                <p class="field-error" data-md-form-error role="alert" hidden></p>
                <div class="company-form-actions"><button type="submit" class="btn btn-primary btn-sm" id="mdAccountSave">حفظ بيانات الدخول</button></div>
            </form>` : ''}
        </section>

        <section class="md-section" aria-labelledby="mdActionsH">
            <h3 class="md-title" id="mdActionsH">الإجراءات</h3>
            <div class="md-actions">
                ${act.canResetPassword ? `
                <div class="md-action">
                    <p class="panel-subtitle">يصل العضوَ على بريده رابطٌ يعيّن به كلمة مرور جديدة. لا ترى الشركة الرابط ولا كلمة المرور.</p>
                    <button type="button" class="btn btn-secondary btn-sm" id="mdResetBtn">إرسال رابط إعادة كلمة المرور</button>
                </div>` : ''}
                ${act.canSuspend ? `
                <form class="md-action" id="mdSuspendForm" novalidate>
                    <p class="panel-subtitle">الإيقاف يوقف وصوله لشركتك وصلاحياته فورًا${d.staff_role ? ' ويُسقط دوره في الفريق مؤقتًا' : ''}. تبقى بياناته وتذاكره، وتعيده متى شئت.</p>
                    <div class="form-field"><label for="mdSuspendReason">سبب الإيقاف</label>
                        <input class="form-control" id="mdSuspendReason" maxlength="500" placeholder="مثال: إجازة حتى نهاية الشهر">
                        ${fieldError('reason')}</div>
                    <button type="submit" class="btn btn-danger btn-sm" id="mdSuspendBtn">إيقاف مؤقت</button>
                </form>` : ''}
                ${act.canReactivate ? `
                <div class="md-action">
                    <p class="panel-subtitle">تعود عضويته${d.suspension?.was_staff ? ' ودوره في الفريق' : ''} كما كانت إن بقي حسابه مؤهلًا.</p>
                    <button type="button" class="btn btn-primary btn-sm" id="mdReactivateBtn">إعادة التفعيل</button>
                </div>` : ''}
            </div>
        </section>

        <section class="md-section" aria-labelledby="mdTransferH" data-md-transfer="${xfer.canRequest ? 'open' : xfer.pending ? 'pending' : 'blocked'}">
            <h3 class="md-title" id="mdTransferH">نقل لشركة أخرى</h3>
            ${xfer.pending ? `
                <p class="panel-subtitle">طلبت نقله إلى «${escapeHtml(xfer.pending.dest_ref)}» في ${escapeHtml(formatDate(xfer.pending.created_at))}. القرار لإدارة المنصة.</p>
                <button type="button" class="panel-link is-danger" id="mdTransferCancel" data-request="${escapeHtml(xfer.pending.id)}">إلغاء الطلب</button>`
            : xfer.canRequest ? `
            <p class="panel-subtitle">يُرسل الطلب لإدارة المنصة للمراجعة. بعد الموافقة ينتقل العضو وتصبح الشركة الجديدة شركته الأساسية؛ تذاكره السابقة تبقى عندك.</p>
            <form class="company-form" id="mdTransferForm" novalidate>
                <div class="form-grid">
                    <div class="form-field is-full"><label for="mdDestRef">الشركة الوجهة (رقم السجل التجاري أو بريد الشركة)</label>
                        <input class="form-control" id="mdDestRef" dir="ltr" maxlength="320" autocomplete="off">${fieldError('destRef')}</div>
                    <div class="form-field is-full"><label for="mdTransferReason">سبب النقل</label>
                        <input class="form-control" id="mdTransferReason" maxlength="500">${fieldError('reason')}</div>
                </div>
                <p class="field-error" data-md-form-error role="alert" hidden></p>
                <div class="company-form-actions"><button type="submit" class="btn btn-secondary btn-sm" id="mdTransferSubmit">إرسال طلب النقل</button></div>
            </form>` : `<p class="panel-subtitle">${escapeHtml(xfer.note)}</p>`}
        </section>

        <section class="md-section" aria-labelledby="mdTicketsH">
            <h3 class="md-title" id="mdTicketsH">تذاكره مع شركتك</h3>
            <p class="company-sub-dates" data-md-tickets>${Number(t.total || 0)} تذكرة · ${Number(t.open || 0)} مفتوحة${t.assigned_open != null ? ` · ${Number(t.assigned_open)} مسندة إليه مفتوحة` : ''}${t.last_activity_at ? ` · آخر نشاط ${escapeHtml(formatDate(t.last_activity_at))}` : ''}</p>
            ${(t.recent || []).length ? `<ul class="company-sub-list">${t.recent.map(r => `
                <li class="company-sub"><div class="company-sub-main">
                    <p class="company-sub-plan">#${escapeHtml(r.ticket_number ?? '')} ${escapeHtml(r.title || '')}</p>
                    <p class="company-sub-dates">${escapeHtml(TICKET_STATUS_LABELS[r.status] || r.status || '')} · ${escapeHtml(formatDate(r.created_at))}</p>
                </div></li>`).join('')}</ul>` : ''}
        </section>

        <section class="md-section" aria-labelledby="mdHistoryH">
            <h3 class="md-title" id="mdHistoryH">السجل في شركتك</h3>
            ${(d.history || []).length ? `<ul class="md-history">${d.history.map(h => `
                <li><span>${escapeHtml(historyLabel(h))}</span> <small>${escapeHtml(formatDate(h.at))}</small></li>`).join('')}</ul>`
            : '<p class="panel-subtitle">لا أحداث مسجَّلة بعد.</p>'}
        </section>`;

    wireDetails(d);
}

function busy(btn, on) { if (btn) btn.disabled = on; }

function wireDetails(d) {
    const userId = d.user_id;
    const profileForm = $('mdProfileForm');
    profileForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const v = { displayName: $('mdDisplayName').value, phone: $('mdProfilePhone').value, jobTitle: $('mdJobTitle').value, notes: $('mdNotes').value };
        const check = validateProfileForm(v);
        showErrors(profileForm, check.errors);
        formError(profileForm, null);
        if (!check.ok) return;
        busy($('mdProfileSave'), true);
        const r = await saveMemberProfile(userId, v);
        busy($('mdProfileSave'), false);
        if (!r.ok) { formError(profileForm, r.error || 'تعذّر الحفظ'); return; }
        await refreshAfter(r.data?.changed === false ? 'لا تغيير' : 'حُفظ ملف العضو');
    });

    const accountForm = $('mdAccountForm');
    accountForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const v = { fullName: $('mdFullName').value, phone: $('mdAccountPhone').value, email: $('mdAccountEmail').value };
        const check = validateAccountForm(v, { hadPhone: !!d.account?.phone });
        showErrors(accountForm, check.errors);
        formError(accountForm, null);
        if (!check.ok) return;
        const emailChanged = v.email.trim().toLowerCase() !== String(d.account?.email || '').toLowerCase();
        if (emailChanged) {
            const ok = await ui.showConfirm('تغيير بريد الدخول؟',
                'سيدخل العضو من الآن بالبريد الجديد، ويصله إشعار أمني على البريدين. كلمة المرور لا تتغير.',
                { confirmLabel: 'تغيير البريد', cancelLabel: 'تراجع' });
            if (!ok) return;
        }
        busy($('mdAccountSave'), true);
        const r = await updateMemberAccount(userId, v);
        busy($('mdAccountSave'), false);
        if (!r.ok) { formError(accountForm, r.error); return; }
        await refreshAfter(r.message || 'حُفظت بيانات الحساب');
    });

    $('mdResetBtn')?.addEventListener('click', async () => {
        const btn = $('mdResetBtn');
        busy(btn, true);
        const r = await sendMemberPasswordReset(userId);
        busy(btn, false);
        toast(r.ok ? (r.message || 'أُرسل الرابط') : r.error, r.ok ? 'success' : 'error');
        if (r.ok) await refreshAfter(null);
    });

    const suspendForm = $('mdSuspendForm');
    suspendForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const reason = $('mdSuspendReason').value;
        const err = validateReason(reason);
        showErrors(suspendForm, err ? { reason: err } : {});
        if (err) return;
        const ok = await ui.showConfirm('إيقاف العضو مؤقتًا؟',
            'يفقد وصوله لشركتك فورًا حتى تعيد تفعيله. لا يُحذف حسابه ولا تذاكره.',
            { confirmLabel: 'إيقاف', cancelLabel: 'تراجع', danger: true });
        if (!ok) return;
        busy($('mdSuspendBtn'), true);
        const r = await suspendMember(userId, reason.trim());
        busy($('mdSuspendBtn'), false);
        if (!r.ok) { toast(r.error || 'تعذّر الإيقاف', 'error'); return; }
        await refreshAfter('أُوقف العضو مؤقتًا');
    });

    $('mdReactivateBtn')?.addEventListener('click', async () => {
        busy($('mdReactivateBtn'), true);
        const r = await reactivateMember(userId);
        busy($('mdReactivateBtn'), false);
        if (!r.ok) { toast(r.error || 'تعذّرت إعادة التفعيل', 'error'); return; }
        await refreshAfter(r.data?.reactivated === false ? 'العضو عاد للشركة بدعوة؛ أُغلق الإيقاف' : 'أُعيد تفعيل العضو');
    });

    const transferForm = $('mdTransferForm');
    transferForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const v = { destRef: $('mdDestRef').value, reason: $('mdTransferReason').value };
        const check = validateTransferForm(v);
        showErrors(transferForm, check.errors);
        formError(transferForm, null);
        if (!check.ok) return;
        transferKey = transferKey || crypto.randomUUID();
        busy($('mdTransferSubmit'), true);
        const r = await requestMemberTransfer(userId, v.destRef.trim(), v.reason.trim(), transferKey);
        busy($('mdTransferSubmit'), false);
        if (!r.ok) { formError(transferForm, r.error || 'تعذّر إرسال الطلب'); return; }
        transferKey = null;
        await refreshAfter('أُرسل طلب النقل لإدارة المنصة');
    });

    $('mdTransferCancel')?.addEventListener('click', async () => {
        const r = await cancelMemberTransfer($('mdTransferCancel').dataset.request);
        if (!r.ok) { toast(r.error || 'تعذّر الإلغاء', 'error'); return; }
        await refreshAfter('أُلغي طلب النقل');
    });
}

/** قائمتا الموقوفين وطلبات النقل تحت قائمة المستخدمين — للمدير وحده وبعد 113. */
export async function renderMemberAdminLists() {
    const suspendedBox = $('companySuspendedMembers');
    const transfersBox = $('companyMemberTransfers');
    if (!suspendedBox || !transfersBox) return;
    const [s, x] = await Promise.all([fetchSuspendedMembers(), fetchMemberTransferRequests()]);
    const suspended = s.ok && Array.isArray(s.data) ? s.data : [];
    const transfers = x.ok && Array.isArray(x.data) ? x.data : [];

    suspendedBox.hidden = !suspended.length;
    suspendedBox.innerHTML = suspended.length ? `
        <h3 class="md-title">موقوفون مؤقتًا</h3>
        <ul class="company-sub-list">${suspended.map(m => `
            <li class="company-sub" data-suspended="${escapeHtml(m.user_id)}">
                <div class="company-sub-main">
                    <p class="company-sub-plan">${escapeHtml(m.name || m.email || '—')}</p>
                    <p class="company-sub-dates">منذ ${escapeHtml(formatDate(m.suspended_at))} · ${escapeHtml(m.reason || '')}</p>
                </div>
                <div class="company-sub-side">
                    <button type="button" class="panel-link" data-member-details="${escapeHtml(m.user_id)}">التفاصيل</button>
                    <button type="button" class="panel-link" data-reactivate="${escapeHtml(m.user_id)}">إعادة التفعيل</button>
                </div>
            </li>`).join('')}</ul>` : '';

    transfersBox.hidden = !transfers.length;
    transfersBox.innerHTML = transfers.length ? `
        <h3 class="md-title">طلبات نقل الأعضاء</h3>
        <ul class="company-sub-list">${transfers.map(r => {
            const info = transferStatusInfo(r.status);
            return `
            <li class="company-sub" data-transfer-row="${escapeHtml(r.id)}">
                <div class="company-sub-main">
                    <p class="company-sub-plan">${escapeHtml(r.name || '—')} ← ${escapeHtml(r.dest_ref || '')}</p>
                    <p class="company-sub-dates">${escapeHtml(formatDate(r.created_at))} · ${escapeHtml(r.reason || '')}</p>
                    ${r.status === 'rejected' && r.decision_reason ? `<p class="company-sub-dates is-muted">سبب الرفض: ${escapeHtml(r.decision_reason)}</p>` : ''}
                </div>
                <div class="company-sub-side">
                    <span class="pill ${escapeHtml(info.pill)}">${escapeHtml(info.label)}</span>
                    ${r.status === 'pending' ? `<button type="button" class="panel-link is-danger" data-cancel-transfer="${escapeHtml(r.id)}">إلغاء</button>` : ''}
                </div>
            </li>`;
        }).join('')}</ul>` : '';

    suspendedBox.querySelectorAll('[data-member-details]').forEach(b => b.addEventListener('click', () => openMemberDetails(b.dataset.memberDetails)));
    suspendedBox.querySelectorAll('[data-reactivate]').forEach(b => b.addEventListener('click', async () => {
        b.disabled = true;
        const r = await reactivateMember(b.dataset.reactivate);
        toast(r.ok ? 'أُعيد تفعيل العضو' : (r.error || 'تعذّرت إعادة التفعيل'), r.ok ? 'success' : 'error');
        await notifyChanged();
    }));
    transfersBox.querySelectorAll('[data-cancel-transfer]').forEach(b => b.addEventListener('click', async () => {
        b.disabled = true;
        const r = await cancelMemberTransfer(b.dataset.cancelTransfer);
        toast(r.ok ? 'أُلغي طلب النقل' : (r.error || 'تعذّر الإلغاء'), r.ok ? 'success' : 'error');
        await notifyChanged();
    }));
}
