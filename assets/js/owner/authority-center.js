/**
 * authority-center.js — «مركز سلطة المنصة» في لوحة المالك.
 *
 * لا قرار تفويض واحد هنا. كل زر نداء RPC ترفضه القاعدة لغير المالك
 * (migrations/053): owner_step_up · owner_set_staff_role ·
 * owner_set_platform_admin · owner_set_capability. تعطيل الأزرار قبل التحقق
 * بخطوتين مجاملة للمستخدم؛ الرفض الحقيقي في owner_critical_ok().
 */

const TIER_LABEL = {
    owner: 'مالك المنصة',
    platform_admin: 'مدير منصة',
    admin: 'إداري',
    support: 'فريق الدعم',
    customer: 'عميل',
    system: 'النظام',
    unknown: '—'
};

const TIER_PILL = {
    owner: 'status-resolved',
    platform_admin: 'status-open',
    admin: 'status-in-progress',
    support: 'status-neutral'
};

const CAPABILITY_LABEL = { 'staff.support': 'إدارة فريق الدعم' };

const ACTION_LABEL = {
    'role.change': 'تغيير رتبة',
    'account.restriction': 'حظر / قفل حساب',
    'profile.delete': 'حذف حساب',
    'platform_authority.insert': 'منح سلطة منصة',
    'platform_authority.update': 'تعديل سلطة منصة',
    'platform_authority.delete': 'سحب سلطة منصة',
    'platform_capability_grants.insert': 'منح تفويض',
    'platform_capability_grants.update': 'تحديث تفويض',
    'platform_capability_grants.delete': 'سحب تفويض',
    'sie_admin_grants.insert': 'منح إدارة SIE',
    'sie_admin_grants.update': 'تحديث إدارة SIE',
    'sie_admin_grants.delete': 'سحب إدارة SIE',
    'sie.setting.insert': 'إعداد SIE جديد',
    'sie.setting.update': 'تغيير إعداد SIE',
    'sie.setting.delete': 'حذف إعداد SIE',
    'step_up.verified': 'تحقق بخطوتين',
    'step_up.failed': 'محاولة تحقق فاشلة'
};

const STEP_UP_ERRORS = {
    invalid_code: 'الرمز غير صحيح أو مستعمل من قبل. أدخل الرمز الحالي من تطبيق المصادقة.',
    mfa_not_enrolled: 'التحقق بخطوتين غير مفعّل على حسابك بعد.',
    too_many_attempts: 'محاولات كثيرة متتالية. انتظر قليلًا ثم حاول مجددًا.'
};

let stepUpFresh = false;

/** يطبّق حالة التحقق على كل زر عملية حرجة في الصفحة (data-critical). */
export function applyCriticalState(root = document) {
    root.querySelectorAll('[data-critical]').forEach(el => {
        el.disabled = !stepUpFresh;
        if (stepUpFresh) el.removeAttribute('title');
        else el.title = 'يتطلب التحقق بخطوتين أولًا';
    });
}

export function initAuthorityCenter(ctx) {
    const { supabase, $, esc, when, table, td, byId, rows, accountCell, errorBlock } = ctx;
    let expiryTimer = null;

    const say = (el, text, tone = 'info') => {
        el.textContent = text;
        el.dataset.tone = tone;
        el.hidden = !text;
    };

    /* ── A. الملكية والتحقق بخطوتين ─────────────────────────────────────── */
    async function renderStepUp() {
        const box = $('stepUpBox');
        const { data, error } = await supabase.rpc('owner_security_status');
        if (error) { box.innerHTML = errorBlock(error.message); return; }

        stepUpFresh = !!data?.step_up_fresh;
        clearTimeout(expiryTimer);

        if (!data?.mfa_enrolled) {
            box.innerHTML = `
                <div class="owner-stepup-state owner-stepup-state--warn">
                    <p class="owner-stepup-title">التحقق بخطوتين غير مفعّل</p>
                    <p class="owner-stepup-text">العمليات الحرجة — إدارة الإداريين، التفويض، مديرو SIE — ترفضها القاعدة
                        لحسابك حتى تفعّله. هذا مقصود: حساب المالك أعلى حدود الثقة في المنصة.</p>
                    <a class="btn btn-primary btn-sm" href="/admin-security-settings.html">تفعيل التحقق بخطوتين</a>
                </div>`;
        } else if (stepUpFresh) {
            const until = new Date(data.step_up_expires_at);
            box.innerHTML = `
                <div class="owner-stepup-state owner-stepup-state--ok">
                    <p class="owner-stepup-title">وضع العمليات الحساسة مفعّل</p>
                    <p class="owner-stepup-text">حتى ${esc(until.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }))}
                        في هذه الجلسة فقط. بعدها يلزم رمز جديد.</p>
                </div>`;
            expiryTimer = setTimeout(renderStepUp, Math.max(1000, until - Date.now() + 500));
        } else {
            box.innerHTML = `
                <form class="owner-stepup-state" id="stepUpForm" novalidate>
                    <p class="owner-stepup-title">تحقق بخطوتين للعمليات الحساسة</p>
                    <p class="owner-stepup-text">أدخل الرمز الحالي من تطبيق المصادقة. يفتح نافذة 10 دقائق لهذه الجلسة وحدها.</p>
                    <div class="owner-stepup-row">
                        <input class="form-control owner-stepup-code" id="stepUpCode" inputmode="numeric"
                               autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" dir="ltr"
                               aria-label="رمز التحقق" placeholder="000000" required>
                        <button type="submit" class="btn btn-primary">تحقق</button>
                    </div>
                    <p class="owner-stepup-error" id="stepUpError" role="alert" hidden></p>
                </form>`;
            $('stepUpForm').addEventListener('submit', async (e) => {
                e.preventDefault();
                const code = $('stepUpCode').value.replace(/\s/g, '');
                const errEl = $('stepUpError');
                if (!/^\d{6}$/.test(code)) {
                    errEl.textContent = 'الرمز ستة أرقام.';
                    errEl.hidden = false;
                    return;
                }
                const btn = e.submitter || e.currentTarget.querySelector('button');
                btn.disabled = true;
                const { data: res, error: rpcErr } = await supabase.rpc('owner_step_up', { p_code: code });
                btn.disabled = false;
                if (rpcErr || !res?.verified) {
                    errEl.textContent = rpcErr?.message || STEP_UP_ERRORS[res?.error] || 'تعذّر التحقق.';
                    errEl.hidden = false;
                    $('stepUpCode').select();
                    return;
                }
                renderStepUp();
                renderAudit();
            });
        }
        applyCriticalState();
    }

    /* ── B. فريق المنصة والتفويض ───────────────────────────────────────── */
    async function renderStaff() {
        const staffIds = rows.filter(p => ['platform_owner', 'admin', 'support'].includes(p.role)).map(p => p.id);
        const [authority, grants, mfa] = await Promise.all([
            supabase.from('platform_authority').select('user_id, level, granted_at'),
            supabase.from('platform_capability_grants').select('user_id, capability, granted_at'),
            staffIds.length
                ? supabase.from('profiles').select('id, two_factor_enabled').in('id', staffIds)
                : Promise.resolve({ data: [] })
        ]);
        const body = $('staffBody');
        if (authority.error) { body.innerHTML = errorBlock(authority.error.message); return; }

        const levelOf = new Map((authority.data || []).map(a => [a.user_id, a.level]));
        const capsOf = new Map();
        (grants.data || []).forEach(g => capsOf.set(g.user_id, [...(capsOf.get(g.user_id) || []), g.capability]));
        const mfaOf = new Map((mfa.data || []).map(p => [p.id, p.two_factor_enabled]));

        const tierOf = (p) => levelOf.get(p.id) === 'owner' ? 'owner'
            : levelOf.get(p.id) === 'elevated_admin' ? 'platform_admin'
            : p.role === 'admin' ? 'admin' : p.role === 'support' ? 'support' : 'customer';
        const order = { owner: 0, platform_admin: 1, admin: 2, support: 3 };
        const staff = rows.filter(p => staffIds.includes(p.id))
            .map(p => ({ ...p, tier: tierOf(p) }))
            .sort((a, b) => order[a.tier] - order[b.tier]);

        body.innerHTML = table(['الحساب', 'الطبقة', '2FA', 'التفويض', ''], staff, p => {
            const caps = capsOf.get(p.id) || [];
            let actions = '';
            if (p.tier === 'owner') {
                actions = '<span class="owner-cell-muted">محمي — لا يُدار من أي جلسة</span>';
            } else {
                const btn = (act, label, extra = '') =>
                    `<button type="button" class="btn btn-outline btn-sm" data-critical data-act="${act}" data-id="${esc(p.id)}" ${extra}>${label}</button>`;
                const parts = [];
                if (p.tier === 'admin') parts.push(btn('elevate', 'ترقية لمدير منصة'));
                if (p.tier === 'platform_admin') parts.push(btn('unelevate', 'سحب إدارة المنصة'));
                if (p.tier === 'admin' || p.tier === 'platform_admin') {
                    parts.push(caps.includes('staff.support')
                        ? btn('cap-off', 'سحب تفويض الدعم')
                        : btn('cap-on', 'تفويض إدارة الدعم'));
                    parts.push(btn('to-support', 'تحويل لفريق الدعم'));
                }
                if (p.tier === 'support') parts.push(btn('to-admin', 'ترقية لإداري'));
                parts.push(btn('remove', 'إزالة من الفريق', 'data-danger'));
                actions = `<div class="owner-actions">${parts.join('')}</div>`;
            }
            return `<tr>
                ${td(accountCell(p.id))}
                ${td(`<span class="pill ${TIER_PILL[p.tier] || 'status-neutral'}">${TIER_LABEL[p.tier]}</span>`)}
                ${td(mfaOf.get(p.id)
                    ? '<span class="pill status-resolved">مفعّل</span>'
                    : '<span class="pill status-rejected">غير مفعّل</span>')}
                ${td(caps.length ? caps.map(c => esc(CAPABILITY_LABEL[c] || c)).join('، ') : '<span class="owner-cell-muted">—</span>')}
                ${td(actions)}
            </tr>`;
        });

        body.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => onStaffAction(b)));

        // الإضافة: من حسابات العملاء وحدها (أدوار الشركة تُشتق من العلاقة ولا تُمنح)
        const candidates = rows.filter(p => p.role === 'user');
        const select = $('staffAddUser');
        select.innerHTML = `<option value="">اختر حسابًا…</option>` + candidates
            .map(p => `<option value="${esc(p.id)}">${esc(p.full_name ? `${p.full_name} — ${p.email}` : p.email)}</option>`).join('');
        $('staffAddForm').hidden = false;
        applyCriticalState();
    }

    const CONFIRM = {
        elevate: 'ترقية هذا الحساب إلى مدير منصة؟ يشغّل المنصة ولا يدير الإداريين.',
        unelevate: 'سحب سلطة مدير المنصة من هذا الحساب؟',
        'cap-on': 'تفويض هذا الإداري بإدارة فريق الدعم (رتبة support وحدها)؟',
        'cap-off': 'سحب تفويض إدارة فريق الدعم؟',
        'to-support': 'تحويل هذا الحساب إلى فريق الدعم؟ تسقط معه أي سلطة أو تفويض.',
        'to-admin': 'ترقية هذا الحساب إلى إداري؟',
        remove: 'إزالة هذا الحساب من فريق المنصة؟ يعود حساب عميل وتسقط كل سلطته.'
    };

    async function onStaffAction(btn) {
        const id = btn.dataset.id;
        const act = btn.dataset.act;
        const who = byId.get(id);
        if (!window.confirm(`${CONFIRM[act]}\n\n${who?.full_name || who?.email || id}`)) return;
        btn.disabled = true;
        const calls = {
            elevate: () => supabase.rpc('owner_set_platform_admin', { p_user_id: id, p_enabled: true, p_note: null }),
            unelevate: () => supabase.rpc('owner_set_platform_admin', { p_user_id: id, p_enabled: false, p_note: null }),
            'cap-on': () => supabase.rpc('owner_set_capability', { p_user_id: id, p_capability: 'staff.support', p_enabled: true, p_note: null }),
            'cap-off': () => supabase.rpc('owner_set_capability', { p_user_id: id, p_capability: 'staff.support', p_enabled: false, p_note: null }),
            'to-support': () => supabase.rpc('owner_set_staff_role', { p_user_id: id, p_role: 'support' }),
            'to-admin': () => supabase.rpc('owner_set_staff_role', { p_user_id: id, p_role: 'admin' }),
            remove: () => supabase.rpc('owner_set_staff_role', { p_user_id: id, p_role: 'user' })
        };
        const { error } = await calls[act]();
        say($('staffStatus'), error ? error.message : 'تم.', error ? 'error' : 'success');
        if (!error && ['to-support', 'to-admin', 'remove'].includes(act)) {
            const p = rows.find(r => r.id === id);
            if (p) p.role = act === 'to-admin' ? 'admin' : act === 'to-support' ? 'support' : 'user';
        }
        await Promise.all([renderStaff(), renderAudit(), renderStepUp()]);
    }

    $('staffAddForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = $('staffAddUser').value;
        const role = $('staffAddRole').value;
        if (!id) { say($('staffStatus'), 'اختر حسابًا أولًا.', 'error'); return; }
        const { error } = await supabase.rpc('owner_set_staff_role', { p_user_id: id, p_role: role });
        say($('staffStatus'), error ? error.message : 'تمت الإضافة إلى الفريق.', error ? 'error' : 'success');
        if (!error) {
            const p = rows.find(r => r.id === id);
            if (p) p.role = role;
        }
        await Promise.all([renderStaff(), renderAudit(), renderStepUp()]);
    });

    /* ── D. سجل الامتيازات ─────────────────────────────────────────────── */
    async function renderAudit() {
        const { data, error } = await supabase.from('privileged_audit')
            .select('at, actor_id, actor_tier, action, target_user_id, old_value, new_value, context, step_up, source')
            .order('at', { ascending: false }).limit(50);
        const body = $('privAuditBody');
        if (error) { body.innerHTML = errorBlock(error.message); return; }

        const name = (id) => {
            const p = id && byId.get(id);
            return p ? (p.full_name || p.email) : (id ? id.slice(0, 8) : '—');
        };
        const diff = (o, n) => {
            const fmt = (v) => v == null ? '—' : Object.entries(v).map(([k, x]) => `${k}: ${typeof x === 'object' ? JSON.stringify(x) : x}`).join('، ');
            return `<span class="owner-cell-muted" dir="auto">${esc(fmt(o))} ← ${esc(fmt(n))}</span>`;
        };
        body.innerHTML = table(['الوقت', 'الفاعل', 'الإجراء', 'الحساب', 'التغيير', ''], data || [], r => `<tr>
            ${td(when(r.at))}
            ${td(r.source === 'system'
                ? '<span class="owner-cell-muted">النظام / ترحيل</span>'
                : `${esc(name(r.actor_id))} <span class="owner-cell-muted">· ${esc(TIER_LABEL[r.actor_tier] || r.actor_tier)}</span>`)}
            ${td(`<span class="pill ${r.action === 'step_up.failed' ? 'status-rejected' : 'status-neutral'}">${esc(ACTION_LABEL[r.action] || r.action)}</span>`)}
            ${td(esc(r.target_user_id ? name(r.target_user_id) : '—'))}
            ${td(diff(r.old_value, r.new_value))}
            ${td(r.step_up ? '<span class="pill status-resolved" title="بعد تحقق بخطوتين">2FA</span>' : '')}
        </tr>`);
    }

    renderStepUp();
    renderStaff();
    renderAudit();

    return { refreshAudit: renderAudit, refreshStepUp: renderStepUp };
}
