/**
 * owner/users.html — حسابات المنصة كما يملكها مالكها.
 *
 * ما يتيحه وما يحرسه في القاعدة (لا قرار هنا):
 *   • القراءة: profiles_select_policy ← has_elevated_authority() (المالك في سياقه)
 *   • الحظر وفكّه وفكّ القفل: profiles_update_policy ← has_elevated_authority()، ثم حارسان:
 *       guard_profile_protected_columns ← is_admin()  (أعمدة الحظر لا يكتبها غير الإدارة)
 *       guard_privileged_accounts       ← حساب المالك محمي، وفريق المنصة يتطلب owner_critical_ok()
 *   • ما لا يُتاح هنا (نقاط/محافظ، الدخول كعضو، الحذف، منح الرتب) موضَّح في الصفحة وسببه.
 *
 * الأعمدة المقروءة مسمّاة: لا select('*') على profiles — فيها أعمدة أسرار التحقق.
 */
import {
    supabase, bootOwnerPage, announce, esc, when, day, num, table, kpis, errorBlock, stateBlock, loadingBlock,
    openModal, writeResult, friendlyError, renderPager
} from '/assets/js/owner/owner-page.js';
import {
    ROLE_LABELS, STAFF_ROLES, RESTRICTED_BAN_STATUSES, label, banPatch, UNBAN_PATCH, UNLOCK_PATCH,
    accountActions, searchTerm, pageRange, pagerText, SUB_STATUS_LABELS, SUB_STATUS_TONES,
    TICKET_STATUS_LABELS, TICKET_STATUS_TONES
} from '/assets/js/owner/owner-labels.js';
import { isAccountRestricted, accountRestrictionLabel } from '/assets/js/account-status.js';

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 25;
const COLUMNS = 'id, email, full_name, phone, role, ban_status, ban_until, ban_reason, is_locked, two_factor_enabled, created_at, super_user_id';

let me = null;
let page = 0;
let rows = [];

const say = (text, tone = 'info') => announce($('pageStatus'), text, tone);

function filters() {
    return { term: searchTerm($('usersSearch').value), role: $('usersRole').value, status: $('usersStatus').value };
}

function query({ term, role, status }) {
    let q = supabase.from('profiles').select(COLUMNS, { count: 'exact' })
        .order('created_at', { ascending: false });
    if (role) q = q.eq('role', role);
    if (status === 'restricted') {
        q = q.in('ban_status', RESTRICTED_BAN_STATUSES).or(`ban_until.is.null,ban_until.gt.${new Date().toISOString()}`);
    } else if (status === 'locked') {
        q = q.eq('is_locked', true);
    }
    if (term) q = q.or(`full_name.ilike.*${term}*,email.ilike.*${term}*,phone.ilike.*${term}*`);
    return q.range(...pageRange(page, PAGE_SIZE));
}

async function loadKpis() {
    const head = () => supabase.from('profiles').select('id', { count: 'exact', head: true });
    const [total, staff, restricted, locked] = await Promise.all([
        head(),
        head().in('role', STAFF_ROLES),
        head().in('ban_status', RESTRICTED_BAN_STATUSES).or(`ban_until.is.null,ban_until.gt.${new Date().toISOString()}`),
        head().eq('is_locked', true)
    ]);
    $('usersKpis').innerHTML = kpis([
        ['كل الحسابات', total.error ? '—' : num(total.count), ''],
        ['فريق المنصة', staff.error ? '—' : num(staff.count), 'kpi--info'],
        ['عليها قيد حظر', restricted.error ? '—' : num(restricted.count), restricted.count ? 'kpi--warning' : ''],
        ['مقفولة', locked.error ? '—' : num(locked.count), locked.count ? 'kpi--danger' : '']
    ]);
}

function stateCell(u) {
    const restriction = accountRestrictionLabel(u);
    if (restriction) return `<span class="pill status-rejected">${esc(restriction)}</span>`;
    if (u.is_locked) return '<span class="pill status-pending">مقفول</span>';
    return '<span class="pill status-resolved">سليم</span>';
}

async function loadUsers() {
    const box = $('usersTable');
    box.innerHTML = loadingBlock();
    const { data, error, count } = await query(filters());
    if (error) { box.innerHTML = errorBlock(friendlyError(error)); $('usersPager').hidden = true; return; }
    rows = data || [];
    box.innerHTML = table(['الحساب', 'الرتبة', 'الهاتف', 'الحالة', 'التحقق بخطوتين', 'الانضمام', ''], rows, u => `<tr>
        <td><div class="owner-account">
            <span class="owner-account-name">${esc(u.full_name || u.email || u.id)}</span>
            ${u.email ? `<span class="owner-account-email" dir="ltr">${esc(u.email)}</span>` : ''}
        </div></td>
        <td>${esc(label(ROLE_LABELS, u.role))}</td>
        <td dir="ltr">${esc(u.phone || '—')}</td>
        <td>${stateCell(u)}</td>
        <td>${u.two_factor_enabled ? 'مفعّل' : '<span class="owner-cell-muted">غير مفعّل</span>'}</td>
        <td>${esc(day(u.created_at))}</td>
        <td><button type="button" class="btn btn-outline btn-sm" data-user="${esc(u.id)}">التفاصيل</button></td>
    </tr>`, { empty: 'لا حسابات مطابقة للتصفية.' });
    box.querySelectorAll('[data-user]').forEach(b => b.addEventListener('click', () => openAccount(b.dataset.user)));
    renderPager($('usersPager'), {
        page, size: PAGE_SIZE, total: count || 0, text: pagerText(page, PAGE_SIZE, count || 0),
        onPage: (p) => { page = p; loadUsers(); }
    });
}

/* ───────────────────────── تفاصيل الحساب ───────────────────────── */

async function openAccount(id) {
    const account = rows.find(r => r.id === id);
    if (!account) return;
    const modal = openModal({ title: account.full_name || account.email || 'حساب', wide: true, html: loadingBlock() });

    const [subs, tickets, ticketCount, activity, company, security] = await Promise.all([
        supabase.from('whatsapp_subscriptions').select('id, plan, status, billing_cycle, start_date, end_date')
            .eq('user_id', id).order('created_at', { ascending: false }).limit(10),
        supabase.from('tickets').select('id, ticket_number, title, status, created_at')
            .eq('user_id', id).order('created_at', { ascending: false }).limit(5),
        supabase.from('tickets').select('id', { count: 'exact', head: true }).eq('user_id', id),
        supabase.from('activity_logs').select('action, created_at, device_info')
            .eq('user_id', id).order('created_at', { ascending: false }).limit(8),
        account.super_user_id
            ? supabase.from('profiles').select('full_name, email').eq('id', account.super_user_id).maybeSingle()
            : Promise.resolve({ data: null }),
        supabase.rpc('owner_security_status')
    ]);

    const actions = accountActions(account, { selfId: me });
    const stepUpOpen = security.data?.step_up_fresh === true;
    const restricted = isAccountRestricted(account);

    modal.body.innerHTML = `
        <dl class="owner-detail-grid">
            <div><dt>البريد</dt><dd dir="ltr">${esc(account.email || '—')}</dd></div>
            <div><dt>الهاتف</dt><dd dir="ltr">${esc(account.phone || '—')}</dd></div>
            <div><dt>الرتبة</dt><dd>${esc(label(ROLE_LABELS, account.role))}</dd></div>
            <div><dt>الحالة</dt><dd>${stateCell(account)}</dd></div>
            <div><dt>التحقق بخطوتين</dt><dd>${account.two_factor_enabled ? 'مفعّل' : 'غير مفعّل'}</dd></div>
            <div><dt>الانضمام</dt><dd>${esc(when(account.created_at))}</dd></div>
            ${account.super_user_id ? `<div><dt>تابع لمالك شركة</dt><dd>${esc(company.data?.full_name || company.data?.email || account.super_user_id)}</dd></div>` : ''}
            ${restricted ? `<div><dt>سبب القيد</dt><dd>${esc(account.ban_reason || '—')}${account.ban_until ? ` — حتى ${esc(when(account.ban_until))}` : ''}</dd></div>` : ''}
            <div><dt>عدد التذاكر</dt><dd>${ticketCount.error ? '—' : esc(num(ticketCount.count))}</dd></div>
        </dl>

        <section class="owner-detail-section">
            <h3>الإجراءات</h3>
            <div id="accountActions"></div>
        </section>

        <section class="owner-detail-section">
            <h3>الاشتراكات</h3>
            ${subs.error ? errorBlock(friendlyError(subs.error)) : table(['الباقة', 'الحالة', 'الدورة', 'ينتهي'], subs.data || [], s => `<tr>
                <td>${esc(s.plan)}</td>
                <td><span class="pill ${SUB_STATUS_TONES[s.status] || 'status-neutral'}">${esc(label(SUB_STATUS_LABELS, s.status))}</span></td>
                <td>${s.billing_cycle === 'yearly' ? 'سنوي' : 'شهري'}</td>
                <td>${esc(day(s.end_date))}</td></tr>`, { empty: 'لا اشتراكات.' })}
        </section>

        <section class="owner-detail-section">
            <h3>آخر التذاكر</h3>
            ${tickets.error ? errorBlock(friendlyError(tickets.error)) : table(['#', 'العنوان', 'الحالة', 'التاريخ'], tickets.data || [], t => `<tr>
                <td><a href="/owner/tickets.html?ticket=${esc(t.id)}">${esc(t.ticket_number ?? '—')}</a></td>
                <td>${esc(t.title)}</td>
                <td><span class="pill ${TICKET_STATUS_TONES[t.status] || 'status-neutral'}">${esc(label(TICKET_STATUS_LABELS, t.status))}</span></td>
                <td>${esc(day(t.created_at))}</td></tr>`, { empty: 'لا تذاكر.' })}
        </section>

        <section class="owner-detail-section">
            <h3>آخر النشاط</h3>
            ${activity.error ? errorBlock(friendlyError(activity.error)) : table(['الحدث', 'الجهاز', 'الوقت'], activity.data || [], a => `<tr>
                <td><span class="owner-mono">${esc(a.action)}</span></td>
                <td>${esc(a.device_info || '—')}</td>
                <td>${esc(when(a.created_at))}</td></tr>`, { empty: 'لا نشاط مسجَّل.' })}
            <p class="panel-subtitle owner-status-line"><a href="/owner/activity.html?user=${encodeURIComponent(account.email || '')}">كل نشاط هذا الحساب</a></p>
        </section>`;

    renderActions(modal, account, actions, { stepUpOpen, restricted });
}

function renderActions(modal, account, actions, { stepUpOpen, restricted }) {
    const box = modal.body.querySelector('#accountActions');
    const staffNote = STAFF_ROLES.includes(account.role)
        ? `<p class="panel-subtitle">رتبة هذا الحساب تُدار من <a href="/owner-dashboard.html#authority">السلطة والمنح ← فريق المنصة</a>.</p>` : '';

    if (!actions.canRestrict) {
        box.innerHTML = stateBlock({ text: actions.reason }) + staffNote;
        return;
    }
    const locked = actions.needsStepUp && !stepUpOpen;
    const lockNote = locked
        ? `<p class="owner-limits">حساب من فريق المنصة: الحظر وفكّ القفل يتطلبان تحققًا بخطوتين ساريًا.
             <a href="/owner-dashboard.html#authority">التحقق من السلطة والمنح</a></p>` : '';
    const dis = locked ? 'disabled' : '';

    box.innerHTML = `${lockNote}
        ${restricted
            ? `<div class="owner-action-row"><button type="button" class="btn btn-primary btn-sm" data-act="unban" ${dis}>رفع الحظر</button></div>`
            : `<form class="owner-action-form" id="banForm" novalidate>
                <div class="form-grid">
                    <div class="form-field">
                        <label for="banKind">نوع الحظر</label>
                        <select class="form-control" id="banKind" ${dis}>
                            <option value="temporary">مؤقت حتى تاريخ</option>
                            <option value="permanent">دائم</option>
                        </select>
                    </div>
                    <div class="form-field" id="banUntilField">
                        <label for="banUntil">حتى</label>
                        <input type="datetime-local" class="form-control" id="banUntil" ${dis}>
                    </div>
                </div>
                <div class="form-field">
                    <label for="banReason">السبب (يُسجَّل)</label>
                    <input type="text" class="form-control" id="banReason" maxlength="300" autocomplete="off" ${dis}>
                </div>
                <div class="form-actions"><button type="submit" class="btn btn-danger btn-sm" ${dis}>حظر الحساب</button></div>
            </form>`}
        ${account.is_locked ? `<div class="owner-action-row owner-status-line"><button type="button" class="btn btn-outline btn-sm" data-act="unlock" ${dis}>فكّ القفل وتصفير المحاولات</button></div>` : ''}
        ${staffNote}
        <p class="owner-sie-status" id="accountStatus" role="status" aria-live="polite" hidden></p>`;

    const status = (t, tone) => announce(box.querySelector('#accountStatus'), t, tone);
    const apply = async (patch, action, success) => {
        status('جارٍ الحفظ…');
        box.querySelectorAll('button').forEach(b => { b.disabled = true; });
        const result = writeResult(await supabase.from('profiles').update(patch).eq('id', account.id).select('id'));
        if (!result.ok) {
            status(result.message, 'error');
            box.querySelectorAll('button').forEach(b => { b.disabled = false; });
            return;
        }
        await logOwnerAction(action, account, patch.ban_reason);
        modal.close();
        say(success, 'success');
        loadKpis();
        loadUsers();
    };

    const form = box.querySelector('#banForm');
    if (form) {
        const kind = form.querySelector('#banKind');
        kind.addEventListener('change', () => { form.querySelector('#banUntilField').hidden = kind.value !== 'temporary'; });
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const decision = banPatch({ kind: kind.value, until: form.querySelector('#banUntil').value, reason: form.querySelector('#banReason').value });
            if (decision.error) { status(decision.error, 'error'); return; }
            if (!window.confirm(`حظر ${account.full_name || account.email}؟ سيفقد الوصول إلى المنصة فورًا.`)) return;
            apply(decision.patch, 'ban_user', 'تم حظر الحساب.');
        });
    }
    box.querySelector('[data-act="unban"]')?.addEventListener('click', () => {
        if (!window.confirm(`رفع الحظر عن ${account.full_name || account.email}؟`)) return;
        apply({ ...UNBAN_PATCH }, 'unban_user', 'تم رفع الحظر.');
    });
    box.querySelector('[data-act="unlock"]')?.addEventListener('click', () => apply({ ...UNLOCK_PATCH }, 'unlock_user', 'تم فكّ القفل.'));
}

/** أثر في سجل النشاط باسم المالك (activity_logs تقبل صف الفاعل نفسه وحده). الفشل لا يُلغي العملية المنفّذة. */
async function logOwnerAction(action, account, reason) {
    const { error } = await supabase.from('activity_logs').insert({
        user_id: me, user_role: 'platform_owner', action,
        details: { target_user_id: account.id, target_email: account.email, reason: reason || null, source: 'owner_dashboard' },
        user_agent: navigator.userAgent
    });
    if (error) console.warn('[OwnerUsers] activity log:', error.message);
}

(async function init() {
    const ctx = await bootOwnerPage();
    if (!ctx) return;
    me = ctx.session.user.id;

    const params = new URLSearchParams(location.search);
    if (params.get('q')) $('usersSearch').value = params.get('q');

    $('usersFilters').addEventListener('submit', (e) => { e.preventDefault(); page = 0; loadUsers(); });
    ['usersRole', 'usersStatus'].forEach(id => $(id).addEventListener('change', () => { page = 0; loadUsers(); }));
    $('usersRefresh').addEventListener('click', () => { loadKpis(); loadUsers(); });

    loadKpis();
    loadUsers();
})();
