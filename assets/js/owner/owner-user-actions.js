/**
 * owner-user-actions.js — إجراءات المالك الأصلية على مستخدم بعينه.
 *
 * لوحة بحث (بريد أو معرّف) + نافذة إجراءات: تغيير الرتبة (مستخدم ↔ مدير)،
 * الحظر/إلغاء الحظر بسبب، تعديل النقاط (قيمة مطلقة)، تجميد/إلغاء تجميد
 * الرصيد. الكتابة عبر دوال الترحيل 147 (owner_set_user_role /
 * owner_ban_user / owner_set_user_points) والتجميد عبر manage_user_points
 * كما هي (134)؛ كل كتابة تسبقها جلسة تحرير (تحقق بخطوتين) كما في
 * owner/accounts.js، والرفض الحقيقي في القاعدة.
 *
 * بلا تقمّص/عرض-كالمستخدم: إداري السياق وحده (auth-client.js) ولا يُبنى
 * للمالك. بلا تعديل باقة: مكانه تفاصيل الاشتراك (مجموعة F2).
 */
import {
    supabase, esc, when, num, openModal, friendlyError
} from '/assets/js/owner/owner-page.js';
import { ensureStepUp } from '/assets/js/security/step-up-modal.js';
import {
    isBanned, OWNER_USER_ROLES, validateBanReason, validatePointsInput,
    banPayload, unbanPayload, rolePayload, pointsPayload, freezePayload, rpcJsonResult
} from '/assets/js/owner/owner-user-actions-model.js';

const USER_COLUMNS = 'id, full_name, email, phone, role, points, ban_status, ban_until, ban_reason, created_at';

/**
 * يجيب مستخدمًا ببريده (أو جزء منه) أو معرّفه، مع حالة تجميد محفظته.
 * يعيد { user, frozen } أو { error }.
 */
export async function lookupOwnerUser(client, term) {
    const q = String(term || '').trim();
    if (!q) return { error: 'اكتب بريدًا أو معرّفًا للبحث.' };
    const db = client || supabase;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q);
    let query = db.from('profiles').select(USER_COLUMNS).limit(1);
    if (isUuid) query = query.eq('id', q);
    else if (q.includes('@')) query = query.ilike('email', q);
    else query = query.ilike('email', `%${q}%`);
    let data, error = null;
    try {
        ({ data, error } = await query.maybeSingle());
    } catch (err) {
        error = err;
    }
    if (error) return { error: friendlyError(error) };
    if (!data) return { error: 'لا مستخدم بهذا البريد أو المعرّف.' };
    let frozen = false;
    try {
        const { data: wallet } = await db.from('user_wallets')
            .select('is_frozen').eq('user_id', data.id).maybeSingle();
        frozen = wallet?.is_frozen === true;
    } catch { /* بلا محفظة = غير مجمّد */ }
    return { user: data, frozen };
}

function roleLabel(role) {
    return OWNER_USER_ROLES.find(r => r.value === role)?.label || role || '—';
}

function userSummary(user, frozen) {
    return `<dl class="owner-detail-grid">
        <div><dt>الاسم</dt><dd>${esc(user.full_name || 'بدون اسم')}</dd></div>
        <div><dt>البريد</dt><dd><span dir="ltr">${esc(user.email || '—')}</span></dd></div>
        <div><dt>الرتبة</dt><dd>${esc(roleLabel(user.role))}</dd></div>
        <div><dt>الحالة</dt><dd>${isBanned(user)
            ? `محظور${user.ban_until ? ` حتى ${esc(when(user.ban_until))}` : ' (دائم)'}${user.ban_reason ? ` — ${esc(user.ban_reason)}` : ''}`
            : 'نشط'}</dd></div>
        <div><dt>النقاط</dt><dd>${esc(num(user.points))}</dd></div>
        <div><dt>الرصيد</dt><dd>${frozen ? 'مجمّد' : 'غير مجمّد'}</dd></div>
    </dl>`;
}

/**
 * نافذة إجراءات المالك على مستخدم. onDone تُنادى بعد كل كتابة ناجحة
 * (لإعادة تحميل السطح الذي فُتحت منه).
 */
export async function openOwnerUserActions({ client, user, frozen = false, onDone } = {}) {
    const db = client || supabase;
    let meId = null;
    let canFreeze = false;
    try {
        const session = await db.auth.getUser();
        meId = session?.data?.user?.id || null;
    } catch { /* بلا جلسة: الأزرار تُرفض في القاعدة */ }
    try {
        ({ data: canFreeze } = await db.rpc('can_manage_central_wallet'));
        canFreeze = canFreeze === true;
    } catch { canFreeze = false; }

    const isSelf = !!meId && meId === user.id;
    const banned = isBanned(user);
    const { body, close } = openModal({ title: `إجراءات على «${user.full_name || user.email || 'مستخدم'}»`, wide: true });
    body.innerHTML = `
        ${userSummary(user, frozen)}
        ${isSelf ? '<p class="panel-subtitle">هذا حسابك أنت: لا تغيّر رتبتك ولا تحظر حسابك من هنا.</p>' : ''}
        <section class="owner-detail-section"><h3>تغيير الرتبة</h3>
            ${isSelf ? '<p class="panel-subtitle">غير متاح لحسابك.</p>' : `
            <label for="ouaRole">الرتبة الجديدة</label>
            <select class="form-control" id="ouaRole">
                ${OWNER_USER_ROLES.map(r => `<option value="${esc(r.value)}" ${r.value === (user.role || 'user') ? 'selected' : ''}>${esc(r.label)}${r.value === (user.role || 'user') ? ' (الحالية)' : ''}</option>`).join('')}
            </select>
            <div class="owner-row-actions"><button type="button" class="btn btn-primary btn-sm" id="ouaRoleSave">حفظ الرتبة</button></div>`}
        </section>
        <section class="owner-detail-section"><h3>${banned ? 'إلغاء الحظر' : 'حظر المستخدم'}</h3>
            ${isSelf ? '<p class="panel-subtitle">غير متاح لحسابك.</p>' : banned ? `
            <p class="state-text">محظور${user.ban_reason ? ` — السبب: ${esc(user.ban_reason)}` : ''}${user.ban_until ? ` — حتى ${esc(when(user.ban_until))}` : ' (دائم)'}.</p>
            <div class="owner-row-actions"><button type="button" class="btn btn-primary btn-sm" id="ouaUnban">إلغاء الحظر</button></div>` : `
            <label for="ouaBanReason">سبب الحظر (إجباري، 5 أحرف على الأقل — يُسجَّل ويظهر للحساب)</label>
            <textarea class="form-control" id="ouaBanReason" rows="2" maxlength="500"></textarea>
            <label for="ouaBanUntil">حتى (اتركه فارغًا لحظر دائم)</label>
            <input class="form-control" id="ouaBanUntil" type="datetime-local">
            <div class="owner-row-actions"><button type="button" class="btn btn-primary btn-sm" id="ouaBan">حظر المستخدم</button></div>`}
        </section>
        <section class="owner-detail-section"><h3>تعديل النقاط</h3>
            <label for="ouaPoints">النقاط الجديدة (قيمة مطلقة، الحالية ${esc(num(user.points))})</label>
            <input class="form-control" id="ouaPoints" type="number" min="0" step="1" value="${esc(Number(user.points) || 0)}">
            <div class="owner-row-actions"><button type="button" class="btn btn-primary btn-sm" id="ouaPointsSave">حفظ النقاط</button></div>
        </section>
        <section class="owner-detail-section"><h3>تجميد الرصيد</h3>
            ${canFreeze
                ? `<p class="state-text">الرصيد حاليًا: ${frozen ? 'مجمّد' : 'غير مجمّد'}.</p>
                   <div class="owner-row-actions"><button type="button" class="btn btn-outline btn-sm" id="ouaFreeze">${frozen ? 'إلغاء تجميد الرصيد' : 'تجميد الرصيد'}</button></div>`
                : '<p class="panel-subtitle">تجميد الرصيد لحامل المحفظة المركزية وحده — تحقق can_manage_central_wallet() لم يسمح بهذا السياق.</p>'}
        </section>
        <p class="state-text" id="ouaError" role="alert" style="color: var(--color-danger, #c0392b)" hidden></p>
        <p class="state-text" id="ouaDone" role="status" hidden></p>`;

    const errorEl = body.querySelector('#ouaError');
    const doneEl = body.querySelector('#ouaDone');
    const showError = (msg) => { errorEl.textContent = msg; errorEl.hidden = false; doneEl.hidden = true; };
    const showDone = (msg) => { doneEl.textContent = msg; doneEl.hidden = false; errorEl.hidden = true; };
    const runWrite = async (btn, label, fn) => {
        btn.disabled = true;
        errorEl.hidden = true;
        try {
            const ok = await ensureStepUp({ reason: `${label} — عملية حرجة تتطلب تحققًا بخطوتين.` });
            if (!ok) { showError('أُلغي التحقق بخطوتين — لم يُنفَّذ الإجراء.'); return; }
            const result = await fn();
            if (!result.ok) { showError(result.message); return; }
            showDone('تم التنفيذ وسُجِّل في التدقيق.');
            onDone?.();
        } catch (err) {
            showError(friendlyError(err));
        } finally {
            btn.disabled = false;
        }
    };

    body.querySelector('#ouaRoleSave')?.addEventListener('click', async (e) => {
        const role = body.querySelector('#ouaRole').value;
        if (role === (user.role || 'user')) { showError('الرتبة المطلوبة هي الحالية — لا تغيير للحفظ.'); return; }
        if (!window.confirm(`تغيير رتبة «${user.full_name || user.email}» إلى «${roleLabel(role)}»؟`)) return;
        await runWrite(e.currentTarget, 'تغيير الرتبة', async () => {
            const { data, error } = await db.rpc('owner_set_user_role', rolePayload(user.id, role));
            return rpcJsonResult(data, error);
        });
    });

    body.querySelector('#ouaBan')?.addEventListener('click', async (e) => {
        const check = validateBanReason(body.querySelector('#ouaBanReason').value);
        if (!check.ok) { showError(check.error); return; }
        const until = body.querySelector('#ouaBanUntil').value || null;
        if (!window.confirm(`حظر «${user.full_name || user.email}»${until ? ` حتى ${new Date(until).toLocaleString('ar-EG')}` : ' (دائم)'}؟`)) return;
        await runWrite(e.currentTarget, 'حظر مستخدم', async () => {
            const { data, error } = await db.rpc('owner_ban_user', banPayload(user.id, check.reason, until));
            return rpcJsonResult(data, error);
        });
    });

    body.querySelector('#ouaUnban')?.addEventListener('click', async (e) => {
        if (!window.confirm(`إلغاء حظر «${user.full_name || user.email}»؟`)) return;
        await runWrite(e.currentTarget, 'إلغاء الحظر', async () => {
            const { data, error } = await db.rpc('owner_ban_user', unbanPayload(user.id));
            return rpcJsonResult(data, error);
        });
    });

    body.querySelector('#ouaPointsSave')?.addEventListener('click', async (e) => {
        const check = validatePointsInput(body.querySelector('#ouaPoints').value);
        if (!check.ok) { showError(check.error); return; }
        if (check.points === (Number(user.points) || 0)) { showError('النقاط المطلوبة هي الحالية — لا تغيير للحفظ.'); return; }
        await runWrite(e.currentTarget, 'تعديل النقاط', async () => {
            const { data, error } = await db.rpc('owner_set_user_points', pointsPayload(user.id, check.points));
            return rpcJsonResult(data, error);
        });
    });

    body.querySelector('#ouaFreeze')?.addEventListener('click', async (e) => {
        const label = frozen ? 'إلغاء تجميد الرصيد' : 'تجميد الرصيد';
        if (!window.confirm(`${label} لـ«${user.full_name || user.email}»؟`)) return;
        await runWrite(e.currentTarget, label, async () => {
            const { data, error } = await db.rpc('manage_user_points', freezePayload(user.email, frozen));
            return rpcJsonResult(data, error);
        });
    });
}

/**
 * لوحة «إجراءات على مستخدم» في قسم المستخدمين بلوحة المالك: بحث ثم بطاقة
 * المستخدم وزر فتح نافذة الإجراءات. تُركَّب مرة واحدة.
 */
export function mountOwnerUserActionsPanel(host) {
    if (!host || host.dataset.mounted) return;
    host.dataset.mounted = '1';
    host.innerHTML = `
        <div class="panel-header"><div>
            <h3 class="panel-title">إجراءات على مستخدم</h3>
            <p class="panel-subtitle">ابحث ببريد المستخدم أو معرّفه، ثم غيّر رتبته أو احظره أو عدّل نقاطه أو جمّد رصيده — كلها عبر دوال المالك، وتُسجَّل في التدقيق.</p>
        </div></div>
        <form class="toolbar owner-filters" id="ouaSearchForm" role="search" novalidate>
            <label class="visually-hidden" for="ouaSearch">ابحث ببريد المستخدم أو معرّفه</label>
            <input type="search" class="form-control owner-filter-search" id="ouaSearch" placeholder="بريد المستخدم أو معرّفه…" autocomplete="off" maxlength="120">
            <button type="submit" class="btn btn-primary btn-sm">بحث</button>
        </form>
        <div id="ouaResult" aria-live="polite"></div>
        <p class="state-text" id="ouaStatus" role="status" hidden></p>`;

    const form = host.querySelector('#ouaSearchForm');
    const input = host.querySelector('#ouaSearch');
    const result = host.querySelector('#ouaResult');
    const status = host.querySelector('#ouaStatus');
    const say = (text, tone = 'info') => {
        status.textContent = text;
        status.hidden = false;
        status.style.color = tone === 'error' ? 'var(--color-danger, #c0392b)' : '';
    };

    const renderFound = (found) => {
        result.innerHTML = `
            ${userSummary(found.user, found.frozen)}
            <div class="owner-row-actions">
                <button type="button" class="btn btn-primary btn-sm" id="ouaOpen">إجراءات الحساب</button>
            </div>`;
        result.querySelector('#ouaOpen').addEventListener('click', () => openOwnerUserActions({
            user: found.user, frozen: found.frozen,
            onDone: () => form.requestSubmit()
        }));
    };

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        status.hidden = true;
        result.innerHTML = '<div class="skeleton skeleton-card" aria-hidden="true"></div>';
        const found = await lookupOwnerUser(supabase, input.value);
        if (found.error) {
            result.innerHTML = '';
            say(found.error, 'error');
            return;
        }
        say('تم العثور على المستخدم.');
        renderFound(found);
    });
}
