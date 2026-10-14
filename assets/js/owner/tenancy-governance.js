/**
 * tenancy-governance.js — «حوكمة تعدد الشركات» في لوحة المالك (096–099).
 *
 * لا قرار هنا: كل زر نداء RPC يرفضه الخادم لغير مالك المنصة في سياقه وبعد التحقق بخطوتين
 * (owner_critical_ok). تعطيل الأزرار قبل التحقق مجاملة؛ الرفض الحقيقي في القاعدة، ومُختبَر في
 * tests/sql/{company-memberships,ticket-isolation,company-permissions-ledger,admin-hierarchy}.test.sql.
 *
 * الأقسام: مفاتيح التفعيل، طلبات الوصول، مراجعة الإداريين، الهيكل الإداري، مطابقة الاستهلاك،
 * ومستندات الشركات (طابور المراجعة والتجربة الجافة للاحتفاظ)، والنقل والاطلاع التاريخي (101).
 * كل قسم يعرض «غير مطبّق بعد» إن لم يُطبَّق ترحيله، فالصفحة تعمل بأي ترتيب نشر.
 */
import { applyCriticalState } from '/assets/js/owner/authority-center.js';

const MISSING = new Set(['PGRST202', '42883', 'PGRST404']);

/** مفاتيح تفتح وصولًا أو عزلًا: تفعيلها يحتاج موافقة صريحة منفصلة (السؤال 17) — تأكيد إضافي. */
export const GUARDED_SWITCHES = Object.freeze(['company_isolation_enforced', 'data_access_grants_enabled', 'historical_access_enabled']);

export const REVIEW_DECISIONS = Object.freeze([
    { value: 'keep', label: 'إبقاء كما هو' },
    { value: 'revoke_authority', label: 'سحب السلطة المرتفعة' },
    { value: 'convert_support', label: 'تحويل إلى فريق الدعم' },
    { value: 'convert_user', label: 'تحويل إلى حساب عادي' }
]);

export const CAPABILITY_LABELS = Object.freeze({
    'companies.view_registry': 'سجل الشركات',
    'companies.suspend': 'إيقاف الشركات',
    'units.manage_members': 'أعضاء الوحدات',
    'documents.review': 'مراجعة المستندات'
});

/** سبب العملية: 10 أحرف على الأقل (القاعدة تتحقق مرة أخرى). خالصة. */
export function reasonError(value) {
    const v = String(value || '').trim();
    return v.length >= 10 ? null : 'اكتب سببًا من 10 أحرف على الأقل — يُسجَّل مع العملية.';
}

/** ترتيب الوحدات شجرةً مع العمق، للعرض والقوائم. خالصة. */
export function flattenUnits(units) {
    const list = Array.isArray(units) ? units : [];
    const byParent = new Map();
    for (const u of list) {
        const key = u.parent_id || '';
        if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key).push(u);
    }
    const ids = new Set(list.map(u => u.id));
    const out = [];
    const walk = (parent, depth) => {
        for (const u of byParent.get(parent) || []) {
            out.push({ ...u, depth });
            if (depth < 10) walk(u.id, depth + 1);
        }
    };
    walk('', 0);
    // وحدة أمّها مؤرشفة أو غير ظاهرة: جذر
    for (const u of list) if (u.parent_id && !ids.has(u.parent_id) && !out.some(o => o.id === u.id)) {
        out.push({ ...u, depth: 0 });
    }
    return out;
}

/** ساعات الوصول التاريخي: 1–168 (القاعدة تقصّ مرة أخرى). خالصة. */
export function historicalHours(value) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.min(Math.max(n, 1), 168) : 24;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** نموذج النقل الاستثنائي: معرّفان صالحان وسبب ≥ 20 حرفًا (القاعدة تتحقق مرة أخرى). خالصة. */
export function exceptionalTransferError({ customer, company, reason }) {
    if (!UUID_RE.test(String(customer || '').trim())) return 'معرّف العميل غير صالح';
    if (!UUID_RE.test(String(company || '').trim())) return 'معرّف الشركة غير صالح';
    if (String(reason || '').trim().length < 20) return 'النقل الاستثنائي يحتاج سببًا من 20 حرفًا على الأقل في خانة السبب';
    return null;
}

/**
 * حالة مراجعة إداري للعرض: العمل المفتوح، جاهزية التحقق بخطوتين، وهل يُطبَّق القرار. خالصة.
 * 103: open_assigned_tickets = تذاكر مدعوم وحدها (ما يمنع التحويل وتنقله دالة التسليم)؛ تذاكر الشركات للعلم.
 * القرار المطبَّق نهائي: لا تغيير له من هنا.
 */
export function reviewRow(r) {
    const now = r?.now || {};
    const supportTickets = Number(now.open_assigned_tickets || 0);
    const openWork = supportTickets + Number(now.open_continuity_owned || 0) + Number(now.active_delegations || 0);
    return {
        id: r?.user_id,
        name: r?.name || r?.email || '—',
        role: now.role || r?.snapshot?.role || '—',
        authority: now.authority || null,
        mfaReady: r?.mfa_ready === true,
        openWork,
        supportTickets,
        companyTickets: Number(now.open_company_tickets || 0),
        decision: r?.decision || 'pending',
        applied: !!r?.applied_at,
        canApply: r?.ready_to_apply === true
    };
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const DELEGATION_DEFAULT_DAYS = 7;
export const DELEGATION_MAX_DAYS = 90;

/** تاريخ انتهاء التفويض الافتراضي بصيغة YYYY-MM-DD (اليوم + 7). خالصة. */
export function defaultDelegationExpiry(now = new Date()) {
    return new Date(now.getTime() + DELEGATION_DEFAULT_DAYS * DAY_MS).toISOString().slice(0, 10);
}

/** تاريخ انتهاء التفويض: مطلوب، بعد الآن وخلال 90 يومًا (القاعدة تتحقق مرة أخرى، 103 L3). ⇒ { iso } أو { error }. خالصة. */
export function delegationExpiry(value, now = new Date()) {
    const v = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return { error: 'حدد تاريخ انتهاء التفويض.' };
    const end = new Date(`${v}T23:59:59.000Z`);
    if (Number.isNaN(end.getTime()) || end.getTime() <= now.getTime()) return { error: 'تاريخ انتهاء التفويض يجب أن يكون بعد اليوم.' };
    if (end.getTime() > now.getTime() + DELEGATION_MAX_DAYS * DAY_MS) return { error: 'أقصى مدة للتفويض 90 يومًا.' };
    return { iso: end.toISOString() };
}

export function initTenancyGovernance(ctx) {
    const { supabase, $, esc, when, table, td, staff = [] } = ctx;

    const rpc = async (name, args) => {
        const { data, error } = await supabase.rpc(name, args);
        if (error && (MISSING.has(error.code) || error.status === 404)) return { missing: true };
        if (error) return { error: error.message || 'تعذّر التنفيذ' };
        return { data };
    };
    const notApplied = (what) => `<div class="state-block state-block--compact"><p class="state-text">${esc(what)} — الترحيل غير مطبّق بعد.</p></div>`;
    const failed = (msg) => `<div class="state-block state-block--compact state-block--error"><p class="state-text">${esc(msg)}</p></div>`;
    const status = (text, tone = 'info') => {
        const el = $('govStatus');
        el.textContent = text;
        el.dataset.tone = tone;
        el.hidden = !text;
    };
    const reason = () => $('govReason').value.trim();
    const needReason = () => {
        const err = reasonError(reason());
        if (err) { status(err, 'error'); $('govReason').focus(); }
        return !err;
    };
    async function act(name, args, done) {
        const res = await rpc(name, args);
        if (res.missing) { status('الترحيل غير مطبّق بعد.', 'error'); return null; }
        if (res.error) { status(res.error, 'error'); return null; }
        status(done, 'success');
        await renderAll();
        return res.data;
    }

    /* ── مفاتيح التفعيل ─────────────────────────────────────────────────── */
    async function renderSwitches() {
        const box = $('govSwitches');
        const res = await rpc('owner_feature_switches');
        if (res.missing) { box.innerHTML = notApplied('مفاتيح التفعيل'); return; }
        if (res.error) { box.innerHTML = failed(res.error); return; }
        box.innerHTML = table(['المفتاح', 'الوصف', 'الحالة', ''], res.data || [], s => `<tr>
            ${td(`<code dir="ltr">${esc(s.key)}</code>`)}
            ${td(esc(s.description))}
            ${td(`<span class="pill ${s.enabled ? 'status-resolved' : 'status-neutral'}">${s.enabled ? 'مفعّل' : 'مطفأ'}</span>`)}
            ${td(`<button type="button" class="btn btn-sm ${s.enabled ? 'btn-secondary' : 'btn-primary'}" data-critical
                    data-switch="${esc(s.key)}" data-on="${s.enabled ? 'false' : 'true'}">${s.enabled ? 'إطفاء' : 'تفعيل'}</button>`)}
        </tr>`);
        box.querySelectorAll('[data-switch]').forEach(btn => btn.addEventListener('click', async () => {
            const key = btn.dataset.switch;
            const on = btn.dataset.on === 'true';
            if (!needReason()) return;
            if (on && GUARDED_SWITCHES.includes(key)
                && !window.confirm(`«${key}» يغيّر من يرى بيانات الشركات. تفعيله على الإنتاج يحتاج موافقة صريحة منفصلة. متابعة؟`)) return;
            await act('owner_set_feature_switch', { p_key: key, p_enabled: on, p_reason: reason() },
                      on ? 'تم التفعيل وسُجّل' : 'تم الإطفاء وسُجّل');
        }));
    }

    /* ── طلبات الوصول (097) ──────────────────────────────────────────────── */
    async function renderAccess() {
        const box = $('govAccess');
        const res = await rpc('owner_access_requests');
        if (res.missing) { box.innerHTML = notApplied('طلبات الوصول'); return; }
        if (res.error) { box.innerHTML = failed(res.error); return; }
        const requests = res.data?.requests || [];
        const grants = res.data?.active_grants || [];
        box.innerHTML = `
            <h4 class="owner-subsection-title">الطلبات</h4>
            ${table(['الطالب', 'الشركة', 'النطاق', 'السبب', 'المدة', 'الحالة', ''], requests, r => `<tr>
                ${td(`${esc(r.requester_name)}<br><small>${esc(r.requester_kind)}</small>`)}
                ${td(esc(r.company_name))}
                ${td(r.ticket_id ? 'تذكرة واحدة' : 'كل تذاكر الشركة')}
                ${td(esc(r.reason))}
                ${td(`${esc(r.requested_hours)} ساعة`)}
                ${td(`<span class="pill status-neutral">${esc(r.status)}</span>`)}
                ${td(r.status === 'pending' ? `
                    <button type="button" class="btn btn-sm btn-primary" data-critical data-access="${esc(r.id)}" data-approve="true">موافقة</button>
                    <button type="button" class="btn btn-sm btn-secondary" data-critical data-access="${esc(r.id)}" data-approve="false">رفض</button>` : '')}
            </tr>`)}
            <h4 class="owner-subsection-title">المنح السارية</h4>
            ${table(['المستفيد', 'الشركة', 'تنتهي', 'قراءات', ''], grants, g => `<tr>
                ${td(esc(g.grantee_name))}${td(esc(g.company_name))}${td(esc(when(g.expires_at)))}${td(esc(g.reads))}
                ${td(`<button type="button" class="btn btn-sm btn-secondary" data-critical data-revoke-grant="${esc(g.id)}">سحب</button>`)}
            </tr>`)}`;
        box.querySelectorAll('[data-access]').forEach(btn => btn.addEventListener('click', async () => {
            const approve = btn.dataset.approve === 'true';
            await act('owner_decide_access_request',
                      { p_request: btn.dataset.access, p_approve: approve, p_note: reason() || null, p_hours: null },
                      approve ? 'تمت الموافقة: وصول مؤقت ومسجَّل' : 'تم الرفض');
        }));
        box.querySelectorAll('[data-revoke-grant]').forEach(btn => btn.addEventListener('click', async () => {
            await act('revoke_data_access_grant', { p_grant: btn.dataset.revokeGrant, p_reason: reason() || null }, 'سُحبت المنحة فورًا');
        }));
    }

    /* ── مراجعة الإداريين (099) ──────────────────────────────────────────── */
    async function renderReviews() {
        const box = $('govReviews');
        const res = await rpc('owner_admin_reviews');
        if (res.missing) { box.innerHTML = notApplied('مراجعة الإداريين'); return; }
        if (res.error) { box.innerHTML = failed(res.error); return; }
        const rows = (res.data || []).map(reviewRow);
        const decisionLabel = (v) => REVIEW_DECISIONS.find(d => d.value === v)?.label || v;
        box.innerHTML = table(['الحساب', 'الرتبة', 'تحقق بخطوتين', 'عمل مفتوح', 'القرار', ''], rows, r => `<tr data-review-row="${esc(r.id)}">
            ${td(esc(r.name))}
            ${td(`${esc(r.role)}${r.authority ? `<br><small>${esc(r.authority)}</small>` : ''}`)}
            ${td(`<span class="pill ${r.mfaReady ? 'status-resolved' : 'status-rejected'}">${r.mfaReady ? 'مفعّل' : 'غير مفعّل'}</span>`)}
            ${td(`${r.openWork ? `<span class="pill status-open">${esc(r.openWork)}</span>` : '0'}
                  ${r.companyTickets ? `<br><small>تذاكر شركات مسندة (للعلم): ${esc(r.companyTickets)}</small>` : ''}
                  ${r.supportTickets && !r.applied ? `<br><select class="form-control" data-handover-to="${esc(r.id)}" aria-label="مستلم التذاكر">
                        <option value="">— يستلم تذاكر مدعوم —</option>
                        ${staff.filter(p => p.id !== r.id).map(p => `<option value="${esc(p.id)}">${esc(p.full_name || p.email)}</option>`).join('')}
                     </select>
                     <button type="button" class="btn btn-sm btn-secondary" data-critical data-handover="${esc(r.id)}">تسليم ${esc(r.supportTickets)} تذكرة</button>` : ''}`)}
            ${td(r.applied
                ? `<span class="pill status-resolved">${esc(decisionLabel(r.decision))}</span><br><small>طُبِّق — القرار نهائي</small>`
                : `<select class="form-control" data-review-decision="${esc(r.id)}" aria-label="قرار المراجعة">
                    <option value="">${r.decision === 'pending' ? '— بانتظار القرار —' : 'تغيير القرار'}</option>
                    ${REVIEW_DECISIONS.map(d => `<option value="${esc(d.value)}"${d.value === r.decision ? ' selected' : ''}>${esc(d.label)}</option>`).join('')}
                 </select>`)}
            ${td(r.applied ? '' : `<button type="button" class="btn btn-sm btn-secondary" data-critical data-review-save="${esc(r.id)}">حفظ القرار</button>
                  ${r.canApply ? `<button type="button" class="btn btn-sm btn-primary" data-critical data-review-apply="${esc(r.id)}">تطبيق</button>` : ''}`)}
        </tr>`);
        box.querySelectorAll('[data-review-save]').forEach(btn => btn.addEventListener('click', async () => {
            const id = btn.dataset.reviewSave;
            const decision = box.querySelector(`[data-review-decision="${CSS.escape(id)}"]`)?.value;
            if (!decision) { status('اختر قرارًا أولًا.', 'error'); return; }
            if (!needReason()) return;
            await act('owner_decide_admin_review', { p_user: id, p_decision: decision, p_note: reason() }, 'سُجّل القرار');
        }));
        // تسليم تذاكر مدعوم المفتوحة قبل التحويل (owner_reassign_admin_tickets)
        box.querySelectorAll('[data-handover]').forEach(btn => btn.addEventListener('click', async () => {
            const from = btn.dataset.handover;
            const to = box.querySelector(`[data-handover-to="${CSS.escape(from)}"]`)?.value;
            if (!to) { status('اختر من يستلم التذاكر.', 'error'); return; }
            if (!needReason()) return;
            await act('owner_reassign_admin_tickets', { p_from: from, p_to: to, p_reason: reason() }, 'سُلِّمت تذاكر مدعوم المفتوحة');
        }));
        box.querySelectorAll('[data-review-apply]').forEach(btn => btn.addEventListener('click', async () => {
            if (!window.confirm('تطبيق القرار يغيّر رتبة الحساب أو سلطته. متابعة؟')) return;
            await act('owner_apply_admin_review', { p_user: btn.dataset.reviewApply }, 'طُبِّق القرار');
        }));
    }

    /* ── الهيكل الإداري (099) ────────────────────────────────────────────── */
    async function renderHierarchy() {
        const box = $('govHierarchy');
        const res = await rpc('owner_hierarchy');
        if (res.missing) { box.innerHTML = notApplied('الهيكل الإداري'); return; }
        if (res.error) { box.innerHTML = failed(res.error); return; }
        const units = flattenUnits(res.data?.units);
        const caps = res.data?.capabilities || [];
        const unitOptions = units.map(u => `<option value="${esc(u.id)}">${'— '.repeat(u.depth)}${esc(u.name)}</option>`).join('');
        const staffOptions = staff.map(p => `<option value="${esc(p.id)}">${esc(p.full_name || p.email)}</option>`).join('');
        // الشركات من رد القاعدة نفسه (المالك لا يقرأ جدول الشركات مباشرة)
        const allCompanies = [...(res.data?.unassigned_companies || []),
                              ...units.flatMap(u => (u.companies || []).map(c => ({ ...c, unit: u.name })))];
        const companyOptions = allCompanies.map(c => `<option value="${esc(c.company_id)}">${esc(c.name)}${c.unit ? ` (${esc(c.unit)})` : ''}</option>`).join('');
        box.innerHTML = `
            ${units.length ? `<ul class="owner-tree">${units.map(u => `
                <li class="owner-tree-node" style="--depth:${u.depth}" data-unit="${esc(u.id)}">
                    <strong>${esc(u.name)}</strong>
                    <small>${esc((u.members || []).length)} عضو · ${esc((u.companies || []).length)} شركة</small>
                    ${(u.delegations || []).map(d => `
                        <span class="pill status-open">${esc(d.name)}: ${esc((d.capabilities || []).map(c => CAPABILITY_LABELS[c] || c).join('، '))}
                            <button type="button" class="panel-link is-danger" data-critical data-revoke-delegation="${esc(d.id)}">سحب</button></span>`).join('')}
                </li>`).join('')}</ul>`
            : '<div class="state-block state-block--compact"><p class="state-text">لا وحدات بعد.</p></div>'}
            <form class="owner-gov-form" id="govUnitForm" novalidate>
                <input class="form-control" id="govUnitName" maxlength="120" placeholder="اسم وحدة جديدة" aria-label="اسم الوحدة">
                <select class="form-control" id="govUnitParent" aria-label="الوحدة الأم"><option value="">(جذر)</option>${unitOptions}</select>
                <button type="submit" class="btn btn-sm btn-primary" data-critical>إنشاء وحدة</button>
            </form>
            <form class="owner-gov-form" id="govAssignForm" novalidate>
                <select class="form-control" id="govAssignCompany" aria-label="الشركة">${companyOptions}</select>
                <select class="form-control" id="govAssignUnit" aria-label="الوحدة">${unitOptions}</select>
                <button type="submit" class="btn btn-sm btn-primary" data-critical>إسناد الشركة</button>
            </form>
            <form class="owner-gov-form" id="govDelegateForm" novalidate>
                <select class="form-control" id="govDelegateUser" aria-label="المفوَّض">${staffOptions}</select>
                <select class="form-control" id="govDelegateUnit" aria-label="نطاق التفويض">${unitOptions}</select>
                <span class="owner-gov-caps">${caps.map(c => `
                    <label><input type="checkbox" value="${esc(c.key)}" data-cap> ${esc(c.label)}</label>`).join('')}</span>
                <label>ينتهي في <input type="date" class="form-control" id="govDelegateExpiry" required
                    value="${esc(defaultDelegationExpiry())}" min="${esc(defaultDelegationExpiry(new Date(Date.now() - 6 * DAY_MS)))}"
                    max="${esc(new Date(Date.now() + (DELEGATION_MAX_DAYS - 1) * DAY_MS).toISOString().slice(0, 10))}" aria-label="تاريخ انتهاء التفويض"></label>
                <button type="submit" class="btn btn-sm btn-primary" data-critical>منح التفويض</button>
            </form>`;
        $('govUnitForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = $('govUnitName').value.trim();
            if (name.length < 2) { status('اسم الوحدة مطلوب.', 'error'); return; }
            await act('owner_unit_create', { p_name: name, p_parent: $('govUnitParent').value || null, p_description: null }, 'أُنشئت الوحدة');
        });
        $('govAssignForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!needReason()) return;
            await act('owner_assign_company_unit', { p_company: $('govAssignCompany').value, p_unit: $('govAssignUnit').value || null,
                                                    p_reason: reason() }, 'أُسندت الشركة (والتاريخ محفوظ)');
        });
        $('govDelegateForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const capsChosen = [...box.querySelectorAll('[data-cap]:checked')].map(c => c.value);
            if (!capsChosen.length) { status('اختر قدرة واحدة على الأقل.', 'error'); return; }
            const expiry = delegationExpiry($('govDelegateExpiry').value);
            if (expiry.error) { status(expiry.error, 'error'); $('govDelegateExpiry').focus(); return; }
            if (!needReason()) return;
            await act('owner_grant_delegation', { p_delegate: $('govDelegateUser').value, p_unit: $('govDelegateUnit').value,
                                                 p_capabilities: capsChosen, p_reason: reason(), p_expires_at: expiry.iso }, 'مُنح التفويض وسُجّل');
        });
        box.querySelectorAll('[data-revoke-delegation]').forEach(btn => btn.addEventListener('click', async () => {
            if (!needReason()) return;
            await act('owner_revoke_delegation', { p_delegation: btn.dataset.revokeDelegation, p_reason: reason() }, 'سُحب التفويض فورًا');
        }));
    }

    /* ── مطابقة الاستهلاك (098) ──────────────────────────────────────────── */
    async function renderUsage() {
        const box = $('govUsage');
        const res = await rpc('usage_reconciliation');
        if (res.missing) { box.innerHTML = notApplied('سجل الاستهلاك'); return; }
        if (res.error) { box.innerHTML = failed(res.error); return; }
        const r = res.data || {};
        const mismatches = r.mismatches || [];
        box.innerHTML = `
            <p class="panel-subtitle">سجل الظل للشهر ${esc(r.period)}: ${esc(r.matching)} من ${esc(r.accounts)} حسابًا مطابق للعدّ الحي.
                الفرض ما زال بالعدّ الحي — هذا للمراجعة فقط.</p>
            ${mismatches.length ? table(['الحساب', 'السجل', 'العدّ الحي', 'السبب'], mismatches, m => `<tr>
                ${td(`<code dir="ltr">${esc(String(m.account_id).slice(0, 8))}</code>`)}
                ${td(`${esc(m.ledger_used)} / ${esc(m.ledger_billing)}`)}
                ${td(`${esc(m.live_used)} / ${esc(m.live_billing)}`)}
                ${td(m.reason === 'membership_changed' ? 'انتقال عملاء بين الشركات (متوقَّع)' : '<strong>غير مفسَّر — يحتاج مراجعة</strong>')}
            </tr>`) : ''}`;
    }

    /* ── مستندات الشركات (100) ────────────────────────────────────────── */
    async function renderDocuments() {
        const box = $('govDocuments');
        if (!box) return;
        const res = await rpc('owner_documents_queue');
        if (res.missing) { box.innerHTML = notApplied('مستندات الشركات'); return; }
        if (res.error) { box.innerHTML = failed(res.error); return; }
        const docs = res.data || [];
        box.innerHTML = `
            ${table(['الشركة', 'المستند', 'الحالة', 'الإصدار الحالي', ''], docs, d => {
                const cur = (d.versions || []).find(v => v.is_current) || {};
                const reviewable = d.status === 'pending_review' && cur.status === 'clean' && cur.review_status === 'pending';
                return `<tr>
                    ${td(esc(d.company_name))}${td(esc(d.label))}
                    ${td(`<span class="pill status-neutral">${esc(d.status)}</span>`)}
                    ${td(`v${esc(cur.version_no)} · ${esc(cur.status)}${cur.sha256 ? `<br><small dir="ltr">${esc(String(cur.sha256).slice(0, 12))}…</small>` : ''}`)}
                    ${td(reviewable ? `
                        <input type="date" class="form-control" data-doc-expiry="${esc(cur.id)}" aria-label="تاريخ الانتهاء">
                        <button type="button" class="btn btn-sm btn-primary" data-critical data-doc-review="${esc(cur.id)}" data-approve="true">اعتماد</button>
                        <button type="button" class="btn btn-sm btn-secondary" data-critical data-doc-review="${esc(cur.id)}" data-approve="false">رفض</button>`
                        : cur.status === 'pending_scan' ? '<small>معزول حتى الفحص</small>' : '')}
                </tr>`;
            })}
            <div class="owner-gov-form">
                <button type="button" class="btn btn-sm btn-secondary" id="govRetentionDryRun">تجربة جافة للاحتفاظ</button>
                <span id="govRetentionResult" class="panel-subtitle"></span>
            </div>`;
        box.querySelectorAll('[data-doc-review]').forEach(btn => btn.addEventListener('click', async () => {
            const approve = btn.dataset.approve === 'true';
            if (!approve && !needReason()) return;
            const expiry = box.querySelector(`[data-doc-expiry="${CSS.escape(btn.dataset.docReview)}"]`)?.value || null;
            await act('document_review', { p_version: btn.dataset.docReview, p_approve: approve,
                                           p_note: approve ? null : reason(), p_expires_on: expiry },
                      approve ? 'اعتُمد المستند' : 'رُفض المستند وأُبلغت الشركة');
        }));
        $('govRetentionDryRun').addEventListener('click', async () => {
            const r = await rpc('owner_retention_dry_run');
            $('govRetentionResult').textContent = r.data
                ? `كان سيُحذف ${r.data.would_delete.length} إصدارًا (محجوز قانونيًا: ${r.data.held}). لا حذف — المدد غير معتمدة قانونيًا.`
                : (r.error || 'غير مطبّق بعد');
        });
    }

    /* ── النقل والاطلاع التاريخي (101) ─────────────────────────────────── */
    let transferKey = null;
    async function renderMoves() {
        const box = $('govMoves');
        if (!box) return;
        const res = await rpc('owner_historical_requests');
        if (res.missing) { box.innerHTML = notApplied('النقل والاطلاع التاريخي'); return; }
        if (res.error) { box.innerHTML = failed(res.error); return; }
        const rows = res.data || [];
        box.innerHTML = `
            <h4 class="owner-subsection-title">طلبات الاطلاع التاريخي</h4>
            <p class="panel-subtitle">لا قرار قبل موافقة العميل واختياره التذاكر. القراءة لرسائل العميل وحدها ومسجَّلة.</p>
            ${table(['الشركة الطالبة', 'الغرض', 'التذاكر', 'الحالة', ''], rows, r => `<tr>
                ${td(esc(r.company_name))}${td(esc(r.purpose))}${td(esc(r.tickets))}
                ${td(`<span class="pill status-neutral">${esc(r.status)}</span>${r.expires_at ? `<br><small>حتى ${esc(when(r.expires_at))}</small>` : ''}`)}
                ${td(r.status === 'awaiting_owner' ? `
                    <input type="number" class="form-control" min="1" max="168" value="24" data-hist-hours="${esc(r.id)}" aria-label="المدة بالساعات">
                    <button type="button" class="btn btn-sm btn-primary" data-critical data-hist="${esc(r.id)}" data-approve="true">موافقة</button>
                    <button type="button" class="btn btn-sm btn-secondary" data-critical data-hist="${esc(r.id)}" data-approve="false">رفض</button>` : '')}
            </tr>`)}
            <h4 class="owner-subsection-title">نقل استثنائي لعميل</h4>
            <p class="panel-subtitle">بلا موافقات الشركتين: لتصحيح ربط خاطئ فقط. يُسجَّل بالسبب المكتوب أعلاه، ويُنفَّذ مرة واحدة.</p>
            <div class="owner-gov-form">
                <input class="form-control" id="govXferCustomer" dir="ltr" placeholder="معرّف العميل" autocomplete="off">
                <input class="form-control" id="govXferCompany" dir="ltr" placeholder="معرّف الشركة الجديدة" autocomplete="off">
                <label><input type="checkbox" id="govXferKeep"> إبقاء الشركة السابقة إضافية</label>
                <button type="button" class="btn btn-sm btn-primary" data-critical id="govXferSubmit">نقل</button>
            </div>`;
        box.querySelectorAll('[data-hist]').forEach(btn => btn.addEventListener('click', async () => {
            const approve = btn.dataset.approve === 'true';
            const hours = historicalHours(box.querySelector(`[data-hist-hours="${CSS.escape(btn.dataset.hist)}"]`)?.value);
            await act('owner_decide_historical_access', { p_request: btn.dataset.hist, p_approve: approve, p_hours: hours },
                      approve ? `تمت الموافقة لمدة ${hours} ساعة` : 'تم الرفض');
        }));
        $('govXferSubmit').addEventListener('click', async () => {
            const form = { customer: $('govXferCustomer').value.trim(), company: $('govXferCompany').value.trim(), reason: reason() };
            const err = exceptionalTransferError(form);
            if (err) { status(err, 'error'); return; }
            if (!window.confirm('نقل استثنائي بلا موافقة الشركتين. يُسجَّل باسمك وسببك. متابعة؟')) return;
            transferKey = transferKey || crypto.randomUUID();
            const done = await act('owner_transfer_exceptional', { p_customer: form.customer, p_to_company: form.company,
                p_reason: form.reason, p_keep_source_secondary: $('govXferKeep')?.checked === true, p_idempotency_key: transferKey },
                'اكتمل النقل الاستثنائي وسُجّل');
            if (done) transferKey = null;
        });
    }

    async function renderAll() {
        await Promise.all([renderSwitches(), renderAccess(), renderReviews(), renderHierarchy(), renderUsage(), renderDocuments(),
                           renderMoves()]);
        applyCriticalState();
    }

    return { render: renderAll };
}
