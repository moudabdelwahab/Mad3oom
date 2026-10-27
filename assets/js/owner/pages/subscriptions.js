/**
 * owner/subscriptions.html — اشتراكات المنصة لمالكها.
 *
 * المصدر الوحيد admin_list_subscriptions() (تشترط is_admin()، وتمرّ للمالك في سياقه) — نفس مصدر صفحة
 * الإدارة، لا قراءة موازية لـ whatsapp_subscriptions. التغيير عبر admin_set_subscription_status() وحدها:
 * الدالة تفرض الانتقالات المسموحة، وتعيد حساب الوصول (recompute_user_access)، وتكتب subscription_audit_log
 * بالسبب. SUBSCRIPTION_TRANSITIONS في owner-labels.js نسخة عرض من شرطها، لا بديل عنه.
 */
import {
    supabase, bootOwnerPage, announce, esc, when, day, num, table, kpis, errorBlock, loadingBlock,
    openModal, friendlyError
} from '/assets/js/owner/owner-page.js';
import {
    SUB_STATUS_LABELS, SUB_STATUS_TONES, label, subscriptionActions, subscriptionChangeError, searchTerm
} from '/assets/js/owner/owner-labels.js';

const $ = (id) => document.getElementById(id);
let all = [];

const say = (text, tone = 'info') => announce($('pageStatus'), text, tone);
const pill = (s) => `<span class="pill ${SUB_STATUS_TONES[s] || 'status-neutral'}">${esc(label(SUB_STATUS_LABELS, s))}</span>`;

async function load() {
    $('subsTable').innerHTML = loadingBlock();
    const { data, error } = await supabase.rpc('admin_list_subscriptions');
    if (error) {
        $('subsTable').innerHTML = errorBlock(friendlyError(error));
        $('subsKpis').innerHTML = '';
        return;
    }
    all = Array.isArray(data) ? data : [];
    renderKpis();
    renderPlans();
    render();
}

function renderKpis() {
    const active = all.filter(s => s.is_active);
    const count = (st) => all.filter(s => s.status === st).length;
    const expiring = active.filter(s => (s.days_remaining ?? 99) <= 7).length;
    // تناقض بين الحالة والتاريخ: 'active' وتاريخه مضى — admin_list_subscriptions تحسب is_active من الاثنين
    const stale = all.filter(s => s.status === 'active' && !s.is_active).length;
    $('subsKpis').innerHTML = kpis([
        ['فعّالة', num(active.length), 'kpi--success'],
        ['بانتظار المراجعة', num(count('pending')), count('pending') ? 'kpi--warning' : ''],
        ['تنتهي خلال 7 أيام', num(expiring), expiring ? 'kpi--warning' : ''],
        ['منتهية', num(count('expired')), ''],
        ['حالة لا تطابق التاريخ', num(stale), stale ? 'kpi--danger' : '', stale ? 'حالتها «فعّال» وتاريخها انتهى' : '']
    ]);
}

function renderPlans() {
    const sel = $('subsPlan');
    const current = sel.value;
    const plans = [...new Map(all.map(s => [s.plan, s.plan_name_ar || s.plan])).entries()];
    sel.innerHTML = '<option value="">كل الباقات</option>' + plans
        .map(([k, v]) => `<option value="${esc(k)}" ${k === current ? 'selected' : ''}>${esc(v)}</option>`).join('');
}

function filtered() {
    const term = searchTerm($('subsSearch').value).toLowerCase();
    const status = $('subsStatus').value;
    const plan = $('subsPlan').value;
    return all.filter(s => {
        if (plan && s.plan !== plan) return false;
        if (status === 'expiring') { if (!(s.is_active && (s.days_remaining ?? 99) <= 7)) return false; }
        else if (status && s.status !== status) return false;
        if (!term) return true;
        return [s.customer_name, s.customer_email, s.customer_phone, s.company_name]
            .some(v => String(v || '').toLowerCase().includes(term));
    });
}

function render() {
    const rows = filtered();
    const box = $('subsTable');
    box.innerHTML = table(['العميل', 'الشركة', 'الباقة', 'الحالة', 'ينتهي', 'المتبقي', 'الإجراءات'], rows, s => {
        const actions = subscriptionActions(s.status);
        return `<tr>
            <td><div class="owner-account">
                <span class="owner-account-name">${esc(s.customer_name)}</span>
                ${s.customer_email ? `<span class="owner-account-email" dir="ltr">${esc(s.customer_email)}</span>` : ''}
            </div></td>
            <td>${esc(s.company_name || '—')}</td>
            <td>${esc(s.plan_name_ar || s.plan)} <span class="owner-cell-muted">· ${s.billing_cycle === 'yearly' ? 'سنوي' : 'شهري'}</span></td>
            <td>${pill(s.status)}${s.status === 'active' && !s.is_active ? ' <span class="pill status-rejected">التاريخ انتهى</span>' : ''}</td>
            <td>${esc(day(s.end_date))}</td>
            <td>${s.is_active ? `${esc(num(s.days_remaining))} يوم` : '—'}</td>
            <td><div class="owner-row-actions">
                ${actions.map(a => `<button type="button" class="btn btn-sm ${a.tone === 'btn-danger' ? 'btn-outline' : 'btn-primary'}" data-sub="${esc(s.id)}" data-to="${esc(a.to)}">${esc(a.label)}</button>`).join('')}
                <button type="button" class="btn btn-outline btn-sm" data-audit="${esc(s.id)}">السجل</button>
            </div></td>
        </tr>`;
    }, { empty: all.length ? 'لا اشتراكات مطابقة للتصفية.' : 'لا اشتراكات بعد.' });

    box.querySelectorAll('[data-sub]').forEach(b => b.addEventListener('click', () =>
        openChange(all.find(s => s.id === b.dataset.sub), b.dataset.to)));
    box.querySelectorAll('[data-audit]').forEach(b => b.addEventListener('click', () =>
        openAudit(all.find(s => s.id === b.dataset.audit))));
}

function openChange(sub, to) {
    if (!sub) return;
    const action = subscriptionActions(sub.status).find(a => a.to === to);
    if (!action) return;
    const defaultEnd = (() => {
        const base = sub.end_date && new Date(sub.end_date) > new Date() ? new Date(sub.end_date) : new Date();
        base.setDate(base.getDate() + (sub.billing_cycle === 'yearly' ? 365 : 30));
        return base.toISOString().slice(0, 10);
    })();
    const modal = openModal({
        title: `${action.label} — ${sub.customer_name}`,
        html: `
        <form class="owner-action-form" id="subForm" novalidate>
            <p class="panel-subtitle">من ${pill(sub.status)} إلى ${pill(to)} · الباقة ${esc(sub.plan_name_ar || sub.plan)} · ينتهي حاليًا ${esc(day(sub.end_date))}</p>
            ${action.needsEndDate ? `
            <div class="form-field">
                <label for="subEnd">تاريخ الانتهاء الجديد</label>
                <input type="date" class="form-control" id="subEnd" value="${esc(defaultEnd)}" required>
            </div>` : ''}
            <div class="form-field">
                <label for="subReason">السبب (يُكتب في سجل الاشتراك)</label>
                <input type="text" class="form-control" id="subReason" maxlength="300" autocomplete="off" required>
            </div>
            <div class="form-actions">
                <button type="submit" class="btn ${action.tone} btn-sm">${esc(action.label)}</button>
            </div>
            <p class="owner-sie-status" id="subStatus" role="status" aria-live="polite" hidden></p>
        </form>`
    });
    const form = modal.body.querySelector('#subForm');
    const status = (t, tone) => announce(form.querySelector('#subStatus'), t, tone);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const endValue = form.querySelector('#subEnd')?.value || '';
        const endDate = endValue ? new Date(`${endValue}T23:59:59`).toISOString() : null;
        const reason = form.querySelector('#subReason').value.trim();
        const problem = subscriptionChangeError({ to, reason, endDate, currentEnd: sub.end_date });
        if (problem) { status(problem, 'error'); return; }
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        status('جارٍ التنفيذ…');
        const { error } = await supabase.rpc('admin_set_subscription_status', {
            p_subscription_id: sub.id, p_status: to, p_reason: reason, p_end_date: endDate
        });
        btn.disabled = false;
        if (error) { status(friendlyError(error), 'error'); return; }
        modal.close();
        say(`تم: ${action.label} — ${sub.customer_name}.`, 'success');
        load();
    });
}

const AUDIT_ACTIONS = { deactivate: 'تعطيل', reactivate: 'إعادة تفعيل', reject: 'رفض', update: 'تعديل', create: 'إنشاء', upgrade: 'ترقية' };

async function openAudit(sub) {
    if (!sub) return;
    const modal = openModal({ title: `سجل الاشتراك — ${sub.customer_name}`, wide: true, html: loadingBlock() });
    const { data, error } = await supabase.rpc('admin_subscription_audit', { p_subscription_id: sub.id });
    if (error) { modal.body.innerHTML = errorBlock(friendlyError(error)); return; }
    const change = (o, n) => Object.keys({ ...(o || {}), ...(n || {}) })
        .filter(k => JSON.stringify(o?.[k]) !== JSON.stringify(n?.[k]))
        .map(k => `${esc(k)}: ${esc(o?.[k] ?? '—')} ← ${esc(n?.[k] ?? '—')}`).join('<br>');
    modal.body.innerHTML = table(['الإجراء', 'الفاعل', 'التغيير', 'السبب', 'الوقت'], Array.isArray(data) ? data : [], a => `<tr>
        <td>${esc(AUDIT_ACTIONS[a.action] || a.action)}</td>
        <td dir="ltr">${esc(a.actor_email || '—')}</td>
        <td><span class="owner-cell-muted">${change(a.old_values, a.new_values) || '—'}</span></td>
        <td>${esc(a.reason || '—')}</td>
        <td>${esc(when(a.created_at))}</td>
    </tr>`, { empty: 'لا تغييرات مسجّلة على هذا الاشتراك.' })
        + `<p class="panel-subtitle owner-status-line"><a href="/admin/subscription-details.html?id=${esc(sub.id)}">تفاصيل الاشتراك في مساحة الإدارة</a></p>`;
}

(async function init() {
    if (!await bootOwnerPage()) return;
    $('subsFilters').addEventListener('submit', (e) => { e.preventDefault(); render(); });
    $('subsSearch').addEventListener('input', render);
    ['subsStatus', 'subsPlan'].forEach(id => $(id).addEventListener('change', render));
    $('subsRefresh').addEventListener('click', load);
    load();
})();
