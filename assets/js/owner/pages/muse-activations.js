/**
 * owner/muse-activations.html — صفحة تفعيل الوكيل لحسابات تانية.
 *
 * القراءة: profiles (الحسابات) + muse_account_activations (سجل التفعيل).
 * غياب سجل التفعيل لحساب = غير مفعّل؛ لا افتراض تفعيل أبدًا، ولا حساب
 * يُفعَّل إلا بمبدّل هذه الصفحة الصريح. المبدّل هو آلية التفعيل الوحيدة.
 *
 * التفعيل (تشغيل): upsert في muse_account_activations على owner_id،
 * active=true مع activated_at وactivated_by (المالك الحالي).
 * الإيقاف: تحديث السجل الموجود active=false وactivated_at=null — لا حذف
 * للسجل أبدًا، فيبقى أثر الإيقاف. فشل الكتابة (ومنها رفض RLS الذي يعود
 * بصفر صفوف بلا خطأ) يعيد المبدّل إلى حالته السابقة ولا يقول «تم».
 * كل تغيير ناجح يُسجَّل best-effort في agent_activity_log بفعل
 * muse_activation_changed — فشل التسجيل لا يلغي التفعيل نفسه.
 *
 * التجربة على حساب mahmoud@mad3oom.com وحده حتى الآن؛ باقي الحسابات
 * غير مفعّلة افتراضيًا، وتفعيل أيٍّ منها قرار صريح للمالك هنا.
 */
import {
    supabase, bootOwnerPage, announce, esc, when, table, errorBlock, loadingBlock,
    friendlyError, renderPager, writeResult
} from '/assets/js/owner/owner-page.js';
import { searchTerm, pageRange, pagerText } from '/assets/js/owner/owner-labels.js';
import {
    ACTIVATION_COLUMNS, ACCOUNTS_PAGE_SIZE, buildActivationMap, isAccountActive,
    activationSummary, activationUpsertPayload, activationDeactivatePayload, logRowForToggle
} from '/assets/js/owner/muse-agent-activity-state.js';

const $ = (id) => document.getElementById(id);
let page = 0;
let ownerId = null;
const people = new Map();

const say = (text, tone = 'info') => announce($('pageStatus'), text, tone);

async function loadActivations() {
    const { data, error } = await supabase.from('muse_account_activations').select(ACTIVATION_COLUMNS);
    if (error) throw error;
    return buildActivationMap(data || []);
}

async function loadActivators(ids) {
    const missing = [...new Set(ids.filter(id => id && !people.has(id)))];
    if (!missing.length) return;
    // فشل القراءة لا يوقف الجدول: المفعِّل يُعرض بمعرّفه المختصر كما في الصف.
    try {
        const { data } = await supabase.from('profiles').select('id, full_name, email').in('id', missing);
        (data || []).forEach(p => people.set(p.id, p));
    } catch (err) {
        console.error('[MuseActivations] loadActivators:', err?.message || err);
    }
}

async function load() {
    const box = $('museAccountsTable');
    box.innerHTML = loadingBlock();
    let activations;
    try {
        activations = await loadActivations();
    } catch (err) {
        box.innerHTML = errorBlock(friendlyError(err));
        $('museAccountsPager').hidden = true;
        return;
    }
    let q = supabase.from('profiles').select('id, email, full_name, role, created_at', { count: 'exact' })
        .order('created_at', { ascending: false });
    const term = searchTerm($('museAccountsSearch').value);
    if (term) q = q.or(`email.ilike.*${term}*,full_name.ilike.*${term}*`);
    if ($('museAccountsRole').value) q = q.eq('role', $('museAccountsRole').value);

    const [from, to] = pageRange(page, ACCOUNTS_PAGE_SIZE);
    // الاستعلام الرئيسي يرمي عند انقطاع الشبكة (التفعيلات وحدها كانت ملتقطة):
    // بلا التقاط يبقى الهيكل العظمي بلا تفسير.
    let data, error, count;
    try {
        ({ data, error, count } = await q.range(from, to));
    } catch (err) {
        box.innerHTML = errorBlock(friendlyError(err));
        $('museAccountsPager').hidden = true;
        return;
    }
    if (error) { box.innerHTML = errorBlock(friendlyError(error)); $('museAccountsPager').hidden = true; return; }
    const rows = data || [];
    await loadActivators([...activations.values()].map(r => r.activated_by));

    const summary = activationSummary(rows, activations);
    $('museAccountsKpis').innerHTML = `
        <div class="kpi"><p class="kpi-label">الحسابات</p><p class="kpi-value">${esc(String(summary.total))}</p></div>
        <div class="kpi"><p class="kpi-label">مفعّلة</p><p class="kpi-value">${esc(String(summary.active))}</p></div>
        <div class="kpi"><p class="kpi-label">غير مفعّلة</p><p class="kpi-value">${esc(String(summary.inactive))}</p></div>`;

    box.innerHTML = table(['الحساب', 'الرتبة', 'حالة التفعيل', 'مفعَّل منذ', 'مفعَّل بواسطة', 'التفعيل'], rows, r => {
        const rec = activations.get(r.id);
        const active = isAccountActive(activations, r.id);
        const by = rec?.activated_by ? people.get(rec.activated_by) : null;
        return `<tr>
            <td><div class="owner-account">
                <span class="owner-account-name">${esc(r.full_name || r.email || '—')}</span>
                <span class="owner-account-email">${esc(r.email || '')}</span>
            </div></td>
            <td>${esc(r.role || '—')}</td>
            <td><span class="pill ${active ? 'pill--active' : 'pill--inactive'}">${active ? 'مفعّل' : 'غير مفعّل'}</span></td>
            <td>${active ? esc(when(rec?.activated_at)) : '<span class="owner-cell-muted">—</span>'}</td>
            <td>${active ? esc(by?.full_name || by?.email || '—') : '<span class="owner-cell-muted">—</span>'}</td>
            <td>
                <label class="muse-toggle">
                    <input type="checkbox" data-owner-id="${esc(r.id)}" data-owner-email="${esc(r.email || '')}"
                        ${active ? 'checked' : ''} aria-label="تفعيل Muse لحساب ${esc(r.email || r.full_name || '')}">
                    <span class="muse-toggle-track" aria-hidden="true"></span>
                    <span class="muse-toggle-thumb" aria-hidden="true"></span>
                    <span class="muse-toggle-label">${active ? 'مفعّل' : 'غير مفعّل'}</span>
                </label>
            </td>
        </tr>`;
    }, { empty: 'لا حسابات مطابقة للتصفية.' });

    box.querySelectorAll('input[data-owner-id]').forEach(input => {
        input.addEventListener('change', () => toggleActivation(input));
    });

    renderPager($('museAccountsPager'), {
        page, size: ACCOUNTS_PAGE_SIZE, total: count || 0,
        text: pagerText(page, ACCOUNTS_PAGE_SIZE, count || 0),
        onPage: (p) => { page = p; load(); }
    });
}

async function toggleActivation(input) {
    const owner = { id: input.dataset.ownerId, email: input.dataset.ownerEmail };
    const turningOn = input.checked;
    const wasActive = !turningOn;
    input.disabled = true;
    const label = input.closest('.muse-toggle')?.querySelector('.muse-toggle-label');
    if (label) label.textContent = 'جارٍ الحفظ…';

    let result;
    // انقطاع الشبكة يرمي: بلا التقاط يبقى المبدّل معطّلًا على «جارٍ الحفظ…» إلى الأبد.
    try {
        if (turningOn) {
            result = await supabase.from('muse_account_activations')
                .upsert(activationUpsertPayload({ owner, byUserId: ownerId }), { onConflict: 'owner_id' })
                .select('id');
        } else {
            result = await supabase.from('muse_account_activations')
                .update(activationDeactivatePayload({ byUserId: ownerId }))
                .eq('owner_id', owner.id).select('id');
        }
    } catch (err) {
        result = { data: null, error: err };
    }
    const checked = writeResult(result, { denied: 'لم يُحفظ التغيير — القاعدة لم تسمح بالتعديل.' });
    if (!checked.ok) {
        input.checked = wasActive;
        if (label) label.textContent = wasActive ? 'مفعّل' : 'غير مفعّل';
        input.disabled = false;
        say(checked.message, 'error');
        return;
    }

    /* تسجيل الفعل في سجل نشاط الوكيل — best-effort، لا يلغي التفعيل. */
    try {
        await supabase.from('agent_activity_log')
            .insert(logRowForToggle({ owner, active: turningOn, byUserId: ownerId }));
    } catch (err) {
        console.error('[MuseActivations] log insert:', err?.message || err);
    }

    input.disabled = false;
    if (label) label.textContent = turningOn ? 'مفعّل' : 'غير مفعّل';
    const row = input.closest('tr');
    const badge = row?.querySelector('.pill');
    if (badge) {
        badge.className = `pill ${turningOn ? 'pill--active' : 'pill--inactive'}`;
        badge.textContent = turningOn ? 'مفعّل' : 'غير مفعّل';
    }
    say(turningOn ? `تم تفعيل Muse لحساب ${owner.email}.` : `تم إيقاف Muse لحساب ${owner.email}.`);
    // إعادة الرسم تستبدل المبدّل؛ يعود التركيز إليه بدل أن يسقط إلى أول الصفحة.
    await load();
    document.querySelector(`input[data-owner-id="${CSS.escape(owner.id)}"]`)?.focus({ preventScroll: true });
}

(async function init() {
    const booted = await bootOwnerPage();
    if (!booted) return;
    ownerId = booted.session.user.id;
    $('museAccountsFilters').addEventListener('submit', (e) => { e.preventDefault(); page = 0; load(); });
    ['museAccountsSearch', 'museAccountsRole']
        .forEach(id => $(id).addEventListener('change', () => { page = 0; load(); }));
    $('museAccountsRefresh').addEventListener('click', () => { load(); say('تم التحديث.'); });
    load();
})();
