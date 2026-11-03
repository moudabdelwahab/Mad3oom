/**
 * owner/security.html — مركز الأمان (121).
 *
 * كل رقم وسطر من دوال owner_* في القاعدة (owner_capability('owner_only'))؛ لا بيانات ثابتة ولا حساب هنا.
 * الكتابة (السياسة، إلغاء جلسة، خروج عام، تراجع) تعود بـ step_up_required بلا جلسة تحرير، فتفتح نافذة
 * التحقق تلقائيًا (step-up-fetch في api-config.js) ثم يكمل الإجراء نفسه. لا قرار أمان في هذه الصفحة.
 */
import { supabase, bootOwnerPage, esc, when, num, table, kpis, errorBlock, loadingBlock, stateBlock, friendlyError, renderPager }
    from '/assets/js/owner/owner-page.js';
import { createWorkspaceTabs, announce } from '/assets/js/owner/owner-workspace.js';
import { describeUserAgent } from '/assets/js/security/user-agent.js';
import { STEP_UP_EVENT } from '/assets/js/security/step-up-modal.js';
import { EVENT_LABELS, SEVERITY, eventLabel, eventSummary, policyPayload, rpcOutcome, CHANGE_TABLE_LABELS } from '/assets/js/owner/security-model.js';

const $ = (id) => document.getElementById(id);
const toast = (text, tone = 'success') => announce($('pageToast'), text, tone);
const PAGE = 25;
let ctx = null;
let logPage = 0;
let changesPage = 0;
const loaded = new Set();

const sevPill = (s) => `<span class="pill ${SEVERITY[s]?.pill || 'status-neutral'}">${esc(SEVERITY[s]?.label || s)}</span>`;
const place = (r) => [r.city, r.country].filter(Boolean).join('، ');
const device = (ua) => {
    const d = describeUserAgent(ua);
    return `<span title="${esc(ua || '')}">${esc(d.label)}</span> <span class="owner-cell-muted">${esc(d.device)}</span>`;
};

/** نداء كتابة: نتيجة موحّدة من خطأ PostgREST أو { ok:false, error } */
async function write(fn, args, success) {
    const res = await supabase.rpc(fn, args);
    const out = rpcOutcome(res);
    toast(out.ok ? success : out.message, out.ok ? 'success' : 'error');
    return out;
}

/* ── نظرة عامة ─────────────────────────────────────────────────────────── */
async function overview() {
    $('secKpis').innerHTML = loadingBlock();
    const [{ data, error }, changes] = await Promise.all([
        supabase.rpc('owner_security_overview', { p_days: 7 }),
        supabase.rpc('owner_account_change_list', { p_limit: 10 })
    ]);
    if (error) { $('secKpis').innerHTML = errorBlock(friendlyError(error)); return; }
    $('secKpis').innerHTML = kpis([
        ['تسجيلات دخول (7 أيام)', num(data.logins)],
        ['محاولات فاشلة', num(data.failed_logins), data.failed_logins > 0 ? 'kpi--warning' : ''],
        ['عناوين IP مختلفة', num(data.unique_ips)],
        ['عناوين مشتركة', num(data.shared_ips), data.shared_ips > 0 ? 'kpi--info' : '', 'بين أكثر من حساب'],
        ['محاولات وصول مرفوضة', num(data.denied), data.denied > 0 ? 'kpi--warning' : ''],
        ['تحذيرات وأحداث حرجة', num(data.warnings), data.warnings > 0 ? 'kpi--warning' : 'kpi--success'],
        ['جلسات نشطة في المنصة', num(data.active_sessions)],
        ['جلسات حسابك', num(data.owner_sessions)]
    ]);
    tabs.setBadge('overview', data.warnings ? num(data.warnings) : null, data.warnings ? 'attention' : '');
    const alerts = data.recent_alerts || [];
    $('secAlerts').innerHTML = alerts.length
        ? `<ul class="owner-sec-alerts">${alerts.map(a => `<li class="owner-sec-alert" data-severity="${esc(a.severity)}">
               ${sevPill(a.severity)}<span class="owner-sec-alert-title">${esc(eventLabel(a.event_type))}</span>
               <span class="owner-cell-muted owner-sec-alert-detail">${esc([a.target_email, a.ip, eventSummary(a)].filter(Boolean).join(' · '))}</span>
               <time class="owner-cell-muted">${esc(when(a.at))}</time></li>`).join('')}</ul>`
        : stateBlock({ text: 'لا تحذيرات في آخر 7 أيام.' });

    if (changes.error) { $('secAccountChanges').innerHTML = errorBlock(friendlyError(changes.error)); return; }
    const reqs = changes.data || [];
    const STATUS = { pending: ['بانتظار قرارك', 'status-pending'], approved: ['وافقت عليه', 'status-resolved'],
                     rejected: ['رُفض', 'status-rejected'], expired: ['انتهت مهلته', 'status-neutral'], superseded: ['استُبدل بأحدث', 'status-neutral'] };
    $('secAccountChanges').innerHTML = table(['المحاولة', 'الوقت', 'IP (آخر جلسة)', 'الجهاز', 'الحالة'], reqs, r => `<tr>
        <td>${r.kind === 'email' ? `تغيير البريد${r.requested_email ? ` إلى <span dir="ltr">${esc(r.requested_email)}</span>` : ''}` : 'تغيير كلمة المرور'}</td>
        <td>${esc(when(r.requested_at))}</td><td dir="ltr">${esc(r.ip || '—')}</td><td>${device(r.user_agent)}</td>
        <td><span class="pill ${STATUS[r.status]?.[1] || 'status-neutral'}">${esc(STATUS[r.status]?.[0] || r.status)}</span>
            ${r.status === 'pending' ? `<span class="owner-cell-muted">${r.alert_sent ? 'أُرسل الرابط لبريدك' : 'جارٍ إرسال التنبيه'}</span>` : ''}</td></tr>`,
        { empty: 'لا محاولات. تغيير كلمة مرور حسابك أو بريده محجوز حتى توافق.' });
}

/* ── سجل الدخول ───────────────────────────────────────────────────────── */
function fillFilters() {
    $('secType').innerHTML = '<option value="">كل الأنواع</option>' + Object.entries(EVENT_LABELS)
        .map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('')
        + '<option value="auth">كل أحداث الدخول</option><option value="owner">كل أحداث حساب المالك</option>';
    $('secSeverity').innerHTML = '<option value="">كل الدرجات</option>' + Object.entries(SEVERITY)
        .map(([k, v]) => `<option value="${esc(k)}">${esc(v.label)}</option>`).join('');
    $('secChangesTable').innerHTML = '<option value="">كل الجداول</option>' + Object.entries(CHANGE_TABLE_LABELS)
        .map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
}

async function activity() {
    const box = $('secLog');
    box.innerHTML = loadingBlock();
    const day = (v, end) => (v ? new Date(`${v}T${end ? '23:59:59' : '00:00:00'}`).toISOString() : null);
    const { data, error } = await supabase.rpc('owner_security_log', {
        p_email: $('secEmail').value.trim() || null, p_ip: $('secIp').value.trim() || null,
        p_type: $('secType').value || null, p_from: day($('secFrom').value), p_to: day($('secTo').value, true),
        p_severity: $('secSeverity').value || null, p_limit: PAGE, p_offset: logPage * PAGE
    });
    if (error) { box.innerHTML = errorBlock(friendlyError(error)); return; }
    if (data?.error === 'invalid_ip') { box.innerHTML = errorBlock('عنوان IP غير صالح.'); return; }
    box.innerHTML = table(['الوقت', 'الحدث', 'الحساب', 'IP', 'الموقع التقريبي', 'الجهاز', 'المصدر'], data.items || [], r => `<tr>
        <td>${esc(when(r.at))}</td>
        <td>${sevPill(r.severity)} ${esc(eventLabel(r.event_type))}<div class="owner-cell-muted">${esc(eventSummary(r))}</div></td>
        <td dir="ltr">${esc(r.target_email || r.actor_email || '—')}</td>
        <td dir="ltr">${r.ip ? `<button type="button" class="panel-link" data-filter-ip="${esc(r.ip)}">${esc(r.ip)}</button>` : '—'}</td>
        <td>${esc(place(r) || '—')}</td><td>${r.user_agent ? device(r.user_agent) : '—'}</td>
        <td><span class="owner-cell-muted">${esc({ db: 'القاعدة', edge: 'الخادم', client_report: 'أبلغ عنه المتصفح' }[r.source] || r.source)}</span></td></tr>`,
        { empty: 'لا أحداث مطابقة.' });
    box.querySelectorAll('[data-filter-ip]').forEach(b => b.addEventListener('click', () => {
        $('secIp').value = b.dataset.filterIp; logPage = 0; activity();
    }));
    renderPager($('secLogPager'), { page: logPage, size: PAGE, total: data.total, onPage: (p) => { logPage = p; activity(); },
        text: `${num(Math.min(data.total, logPage * PAGE + 1))}–${num(Math.min(data.total, (logPage + 1) * PAGE))} من ${num(data.total)}` });
}

/* ── IP المشتركة ──────────────────────────────────────────────────────── */
async function shared() {
    const box = $('secShared');
    box.innerHTML = loadingBlock();
    const { data, error } = await supabase.rpc('owner_ip_correlation', { p_days: Number($('secSharedDays').value), p_min_accounts: 2, p_limit: 50 });
    if (error) { box.innerHTML = errorBlock(friendlyError(error)); return; }
    const items = data.items || [];
    tabs.setBadge('shared', items.length ? num(items.length) : null, items.length ? 'attention' : '');
    box.innerHTML = items.length ? items.map(r => `
        <article class="owner-sec-ip">
            <header class="owner-sec-ip-head">
                <button type="button" class="panel-link owner-mono" data-filter-ip="${esc(r.ip)}" dir="ltr">${esc(r.ip)}</button>
                <span class="pill status-pending">${esc(num(r.accounts))} حسابات</span>
                <span class="owner-cell-muted">${esc(num(r.logins))} دخول · ${esc([r.city, r.country, r.org].filter(Boolean).join('، ') || 'موقع غير متاح')}</span>
                <span class="owner-cell-muted">من ${esc(when(r.first_seen))} إلى ${esc(when(r.last_seen))}</span>
            </header>
            <p class="owner-sec-accounts">${(r.account_list || []).map(a => `<span class="pill status-neutral" dir="ltr">${esc(a.email || a.user_id)}</span>`).join(' ')}</p>
            <details><summary>توقيتات الدخول (آخر 20)</summary>
                ${table(['الوقت', 'الحساب', 'الجهاز'], r.timeline || [], t => `<tr><td>${esc(when(t.at))}</td><td dir="ltr">${esc(t.email || '—')}</td><td>${device(t.user_agent)}</td></tr>`)}
            </details>
        </article>`).join('')
        : stateBlock({ text: 'لا عنوان IP استُخدم لأكثر من حساب في هذه الفترة.' });
    box.querySelectorAll('[data-filter-ip]').forEach(b => b.addEventListener('click', () => {
        $('secIp').value = b.dataset.filterIp; logPage = 0; tabs.select('activity'); activity();
    }));
}

/* ── الجلسات والأجهزة ─────────────────────────────────────────────────── */
function sessionsTable(items, { mine }) {
    return table(['الجهاز', 'IP', 'الموقع', 'بدأت', 'آخر نشاط', ''], items, s => `<tr>
        <td>${device(s.user_agent)}${s.current ? ' <span class="pill status-resolved">هذه الجلسة</span>' : ''}</td>
        <td dir="ltr">${esc(s.ip || '—')}</td><td>${esc(place(s) || '—')}</td>
        <td>${esc(when(s.created_at))}</td><td>${esc(when(s.refreshed_at || s.created_at))}</td>
        <td>${s.current ? '' : `<button type="button" class="btn btn-outline btn-sm" data-critical data-revoke="${esc(s.id)}">إلغاء الجلسة</button>`}</td></tr>`,
        { empty: mine ? 'لا جلسات أخرى.' : 'لا جلسات نشطة لهذا الحساب.' });
}

async function sessions() {
    const [mine, staff] = await Promise.all([
        supabase.rpc('owner_list_sessions', { p_user: null }),
        supabase.from('profiles').select('id, email, full_name, role').in('role', ['admin', 'support']).order('email')
    ]);
    $('secMySessions').innerHTML = mine.error ? errorBlock(friendlyError(mine.error)) : sessionsTable(mine.data?.items || [], { mine: true });
    tabs.setBadge('sessions', mine.data?.items?.length ? num(mine.data.items.length) : null);
    const sel = $('secStaffSelect');
    const keep = sel.value;
    sel.innerHTML = '<option value="">اختر حسابًا</option>' + (staff.data || [])
        .map(p => `<option value="${esc(p.id)}">${esc(p.full_name || p.email)} — ${esc(p.role === 'admin' ? 'أدمن' : 'دعم')}</option>`).join('');
    sel.value = keep;
    if (keep) staffSessions();
}

async function staffSessions() {
    const id = $('secStaffSelect').value;
    const box = $('secStaffSessions');
    if (!id) { box.innerHTML = '<p class="panel-subtitle">اختر حسابًا لعرض جلساته.</p>'; return; }
    box.innerHTML = loadingBlock();
    const { data, error } = await supabase.rpc('owner_list_sessions', { p_user: id });
    if (error) { box.innerHTML = errorBlock(friendlyError(error)); return; }
    box.innerHTML = data?.ok === false ? errorBlock('ليس حساب فريق منصة.')
        : sessionsTable(data.items || [], { mine: false })
          + `<p class="owner-sec-actions"><button type="button" class="btn btn-outline btn-sm is-danger" data-critical data-global="${esc(id)}">إخراج هذا الحساب من كل الأجهزة</button></p>`;
}

/* ── جلسات التحرير ────────────────────────────────────────────────────── */
async function editing() {
    const [status, hist] = await Promise.all([supabase.rpc('owner_security_status'), supabase.rpc('owner_step_up_history', { p_limit: 30 })]);
    const s = status.data;
    $('secEditingNow').innerHTML = s?.step_up_fresh
        ? `<div class="owner-stepup-state owner-stepup-state--ok"><p class="owner-stepup-title">جلسة التحرير مفتوحة</p>
             <p class="owner-stepup-text">حتى ${esc(when(s.step_up_expires_at))} · بـ${s.step_up_method === 'recovery_code' ? 'رمز استرداد' : 'تطبيق المصادقة'} · المدة ${esc(num(s.step_up_minutes))} دقيقة</p>
             <button type="button" class="btn btn-outline btn-sm" id="secEndStepUp">إنهاء الجلسة الآن</button></div>`
        : `<div class="owner-stepup-state"><p class="owner-stepup-title">جلسة التحرير مقفلة</p>
             <p class="owner-stepup-text">تُفتح تلقائيًا بطلب رمز Google Authenticator عند أول إجراء محمي، لمدة ${esc(num(s?.step_up_minutes))} دقيقة.
             رموز الاسترداد المتبقية: ${esc(num(s?.recovery_codes_left))}.</p></div>`;
    $('secEndStepUp')?.addEventListener('click', async () => {
        await write('owner_end_step_up', {}, 'أُنهيت جلسة التحرير.');
        document.dispatchEvent(new CustomEvent(STEP_UP_EVENT));
    });
    if (hist.error) { $('secEditing').innerHTML = errorBlock(friendlyError(hist.error)); return; }
    const END = { manual: 'أُنهيت يدويًا', replaced: 'استُبدلت بجلسة أحدث', expired: 'انتهت مدتها', policy_changed: 'قصّرتها السياسة' };
    $('secEditing').innerHTML = table(['بدأت', 'الطريقة', 'المدة/النهاية', 'IP والجهاز', 'العمليات خلالها'], hist.data || [], r => {
        const ops = [...(r.audit_actions || []), ...(r.security_actions || [])];
        return `<tr>
            <td>${esc(when(r.started_at))}${r.active ? ' <span class="pill status-resolved">سارية</span>' : ''}</td>
            <td>${r.method === 'recovery_code' ? '<span class="pill status-pending">رمز استرداد</span>' : 'تطبيق المصادقة'}</td>
            <td>${esc(when(r.ended_at || r.expires_at))}<div class="owner-cell-muted">${esc(r.active ? 'تنتهي' : END[r.end_reason] || '')}</div></td>
            <td dir="ltr">${esc(r.ip || '—')}<div>${r.user_agent ? device(r.user_agent) : ''}</div></td>
            <td>${ops.length ? `<details><summary>${esc(num(ops.length))} عملية</summary><ul class="owner-sec-ops">${ops
                .map(o => `<li><time class="owner-cell-muted">${esc(when(o.at))}</time> ${esc(eventLabel(o.action))}</li>`).join('')}</ul></details>` : '<span class="owner-cell-muted">لا عمليات</span>'}</td></tr>`;
    }, { empty: 'لا جلسات تحرير بعد.' });
}

/* ── سجل التغييرات ────────────────────────────────────────────────────── */
const diffText = (oldRow, newRow) => {
    const keys = new Set([...Object.keys(oldRow || {}), ...Object.keys(newRow || {})]);
    const out = [];
    for (const k of keys) {
        if (['id', 'updated_at', 'updated_by', 'created_at'].includes(k)) continue;
        const a = JSON.stringify(oldRow?.[k]); const b = JSON.stringify(newRow?.[k]);
        if (a !== b) out.push(`<li><span class="owner-mono">${esc(k)}</span>: <del>${esc(a ?? '—')}</del> ← <ins>${esc(b ?? '—')}</ins></li>`);
    }
    return out.length ? `<ul class="owner-sec-diff">${out.join('')}</ul>` : '<span class="owner-cell-muted">—</span>';
};

async function changes() {
    const box = $('secChanges');
    box.innerHTML = loadingBlock();
    const { data, error } = await supabase.rpc('owner_change_history', { p_table: $('secChangesTable').value || null, p_limit: PAGE, p_offset: changesPage * PAGE });
    if (error) { box.innerHTML = errorBlock(friendlyError(error)); return; }
    const OP = { INSERT: 'إضافة', UPDATE: 'تعديل', DELETE: 'حذف' };
    box.innerHTML = table(['الوقت', 'الجدول', 'العملية', 'التغيير', 'الفاعل', ''], data.items || [], r => `<tr>
        <td>${esc(when(r.at))}</td><td>${esc(CHANGE_TABLE_LABELS[r.table_name] || r.table_name)}<div class="owner-cell-muted owner-mono">${esc(r.row_key || '')}</div></td>
        <td>${esc(OP[r.op] || r.op)}${r.rollback_of ? ' <span class="pill status-neutral">تراجع</span>' : ''}</td>
        <td>${diffText(r.old_row, r.new_row)}</td>
        <td dir="ltr">${esc(r.actor_email || 'النظام')}</td>
        <td>${r.rolled_back_at ? `<span class="owner-cell-muted">تراجعت عنه ${esc(when(r.rolled_back_at))}</span>`
              : r.reversible ? `<button type="button" class="btn btn-outline btn-sm" data-critical data-rollback="${esc(r.id)}">تراجع</button>` : ''}</td></tr>`,
        { empty: 'لا تغييرات مسجّلة.' });
    renderPager($('secChangesPager'), { page: changesPage, size: PAGE, total: data.total, onPage: (p) => { changesPage = p; changes(); },
        text: `${num(Math.min(data.total, changesPage * PAGE + 1))}–${num(Math.min(data.total, (changesPage + 1) * PAGE))} من ${num(data.total)}` });
}

/* ── السياسة ──────────────────────────────────────────────────────────── */
async function policy() {
    const { data, error } = await supabase.rpc('owner_security_status');
    if (error) { $('secPolicyError').textContent = friendlyError(error); $('secPolicyError').hidden = false; return; }
    const p = data.policy || {};
    const preset = ['5', '15', '30', '60'].includes(String(p.step_up_minutes)) ? String(p.step_up_minutes) : 'custom';
    document.querySelectorAll('input[name="minutes"]').forEach(r => { r.checked = r.value === preset; });
    $('secCustomWrap').hidden = preset !== 'custom';
    $('secCustomMinutes').value = p.step_up_minutes ?? '';
    $('secPwLock').checked = !!p.password_change_locked;
    $('secEmailLock').checked = !!p.email_change_locked;
    $('secLoginAlerts').checked = !!p.login_alerts;
    $('secSharedWindow').value = p.shared_ip_window_days ?? '';
    $('secFailThreshold').value = p.failed_login_threshold ?? '';
    $('secPolicyMeta').textContent = p.updated_at ? `آخر تحديث ${when(p.updated_at)}` : '';
}

function bindPolicy() {
    document.querySelectorAll('input[name="minutes"]').forEach(r => r.addEventListener('change', () => {
        $('secCustomWrap').hidden = r.value !== 'custom' || !r.checked;
    }));
    $('secPolicyForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = $('secPolicyError');
        const choice = document.querySelector('input[name="minutes"]:checked')?.value;
        const built = policyPayload({
            minutes: choice === 'custom' ? $('secCustomMinutes').value : choice,
            passwordLocked: $('secPwLock').checked, emailLocked: $('secEmailLock').checked, loginAlerts: $('secLoginAlerts').checked,
            sharedWindow: $('secSharedWindow').value, failThreshold: $('secFailThreshold').value
        });
        if (!built.ok) { err.textContent = built.message; err.hidden = false; return; }
        if (!built.payload.password_change_locked || !built.payload.email_change_locked) {
            if (!window.confirm('إلغاء قفل كلمة المرور أو البريد يسمح بتغييرهما دون موافقتك من البريد. متابعة؟')) return;
        }
        err.hidden = true;
        const btn = $('secPolicySave');
        btn.disabled = true;
        const out = await write('owner_set_security_policy', { p_policy: built.payload }, 'حُفظت سياسة الأمان.');
        btn.disabled = false;
        if (!out.ok) { err.textContent = out.message; err.hidden = false; return; }
        document.dispatchEvent(new CustomEvent(STEP_UP_EVENT));
        policy();
    });
}

/* ── الأحداث العامة ───────────────────────────────────────────────────── */
function bindActions() {
    document.addEventListener('click', async (e) => {
        const revoke = e.target.closest('[data-revoke]');
        const global = e.target.closest('[data-global]');
        const rollback = e.target.closest('[data-rollback]');
        if (revoke) {
            if (!window.confirm('إلغاء هذه الجلسة؟')) return;
            const out = await write('owner_revoke_session', { p_session: revoke.dataset.revoke }, 'أُلغيت الجلسة.');
            if (out.ok) { sessions(); }
        } else if (global) {
            if (!window.confirm('إخراج هذا الحساب من كل أجهزته؟')) return;
            const out = await write('owner_global_logout', { p_user: global.dataset.global }, 'خرج الحساب من كل الأجهزة.');
            if (out.ok) staffSessions();
        } else if (rollback) {
            if (!window.confirm('التراجع عن هذا التغيير وإعادة القيمة القديمة؟')) return;
            const out = await write('owner_rollback_change', { p_change: Number(rollback.dataset.rollback) }, 'تم التراجع.');
            if (out.ok) changes();
        }
    });
    $('secLogoutOthers').addEventListener('click', async () => {
        if (!window.confirm('إخراج كل أجهزتك الأخرى؟ تبقى هذه الجلسة.')) return;
        const out = await write('owner_global_logout', { p_user: ctx.session.user.id }, 'خرجت أجهزتك الأخرى.');
        if (out.ok) sessions();
    });
    $('secGlobalForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = $('secGlobalEmail').value.trim().toLowerCase();
        const { data } = await supabase.from('profiles').select('id, email').ilike('email', email).limit(1);
        if (!data?.length) { toast('لا حساب بهذا البريد.', 'error'); return; }
        if (!window.confirm(`إخراج ${data[0].email} من كل الأجهزة؟`)) return;
        const out = await write('owner_global_logout', { p_user: data[0].id }, 'خرج الحساب من كل الأجهزة.');
        if (out.ok) $('secGlobalEmail').value = '';
    });
    $('secFilters').addEventListener('submit', (e) => { e.preventDefault(); logPage = 0; activity(); });
    $('secFilters').addEventListener('reset', () => setTimeout(() => { logPage = 0; activity(); }));
    $('secSharedDays').addEventListener('change', shared);
    $('secStaffSelect').addEventListener('change', staffSessions);
    $('secChangesTable').addEventListener('change', () => { changesPage = 0; changes(); });
    $('secVerify').addEventListener('click', async () => {
        $('secIntegrity').innerHTML = loadingBlock();
        const { data, error } = await supabase.rpc('owner_verify_security_log');
        $('secIntegrity').innerHTML = error ? errorBlock(friendlyError(error))
            : data.ok ? `<p><span class="pill status-resolved">سليمة</span> ${esc(num(data.checked))} سطرًا، آخر بصمة <span class="owner-mono" dir="ltr">${esc(String(data.head || '').slice(0, 16))}…</span></p>`
            : `<p><span class="pill status-rejected">مكسورة</span> عند السطر ${esc(num(data.broken_at))} — عُدِّل السجل خارج القاعدة. صدّر السجل وراجع صلاحيات قاعدة البيانات.</p>`;
    });
    $('secGeo').addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        const { data, error } = await supabase.functions.invoke('security-event', { body: { action: 'enrich_geo' } });
        e.currentTarget.disabled = false;
        if (error || !data?.ok) { toast('تعذّر تحديث المواقع (المزوّد غير مضبوط أو غير متاح).', 'error'); return; }
        toast(data.resolved ? `حُدِّث موقع ${num(data.resolved)} عنوانًا.` : 'لا عناوين جديدة أو مزوّد المواقع غير مضبوط (IP_GEO_URL).', data.resolved ? 'success' : 'info');
        activity();
    });
    $('secRefresh').addEventListener('click', () => { loaded.clear(); load(tabs.current); overview(); });
}

const LOADERS = { overview, activity, shared, sessions, editing, changes, policy };
function load(name) {
    if (loaded.has(name)) return;
    loaded.add(name);
    LOADERS[name]?.();
}

let tabs;
(async function init() {
    ctx = await bootOwnerPage();
    if (!ctx) return;
    fillFilters();
    tabs = createWorkspaceTabs({ root: $('secWorkspace'), id: 'security', fallback: 'overview' });
    const fromHash = location.hash.slice(1);
    if (LOADERS[fromHash]) tabs.select(fromHash);
    $('secWorkspace').addEventListener('workspace:tab', (e) => load(e.detail.name));
    bindActions();
    bindPolicy();
    overview();
    loaded.add('overview');
    load(tabs.current);
    document.addEventListener(STEP_UP_EVENT, () => { if (loaded.has('editing')) editing(); });
})();
