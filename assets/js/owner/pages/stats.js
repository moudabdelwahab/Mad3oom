/**
 * owner/stats.html — مؤشرات المنصة لمالكها. قراءة فقط.
 *
 * كل رقم عدّ (head + count) على جدول تحرسه RLS، أو دالة تشترط is_admin() — وكلاهما يمرّ للمالك في
 * سياقه عبر owner_capability(). لا جدول هنا تشترط سياسته الرتبة الحرفية 'admin' (user_wallets،
 * chat_messages)، فلا رقم يُعرض صفرًا كاذبًا لأن القاعدة حجبته.
 */
import { supabase, bootOwnerPage, esc, num, kpis, bars, errorBlock, when } from '/assets/js/owner/owner-page.js';
import { ROLE_LABELS, TICKET_STATUS_LABELS, SUB_STATUS_LABELS, RESTRICTED_BAN_STATUSES } from '/assets/js/owner/owner-labels.js';

const $ = (id) => document.getElementById(id);

const head = (table) => supabase.from(table).select('id', { count: 'exact', head: true });
const countOf = async (query) => {
    const { count, error } = await query;
    if (error) throw error;
    return count ?? 0;
};

async function accounts() {
    const roles = Object.keys(ROLE_LABELS);
    const nowIso = new Date().toISOString();
    const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString();
    const [total, restricted, fresh, ...byRole] = await Promise.all([
        countOf(head('profiles')),
        countOf(head('profiles').in('ban_status', RESTRICTED_BAN_STATUSES)
            .or(`ban_until.is.null,ban_until.gt.${nowIso}`)),
        countOf(head('profiles').gte('created_at', monthAgo)),
        ...roles.map(r => countOf(head('profiles').eq('role', r)))
    ]);
    return { total, restricted, fresh, byRole: roles.map((r, i) => ({ label: ROLE_LABELS[r], value: byRole[i] })) };
}

async function tickets() {
    const statuses = Object.keys(TICKET_STATUS_LABELS);
    const live = ['open', 'in-progress'];
    const [byStatus, unassigned, overdue, high] = await Promise.all([
        Promise.all(statuses.map(s => countOf(head('tickets').eq('status', s)))),
        countOf(head('tickets').in('status', live).is('assigned_to', null)),
        countOf(head('tickets').in('status', live).lt('sla_resolution_due_at', new Date().toISOString())),
        countOf(head('tickets').in('status', live).eq('priority', 'high'))
    ]);
    const counts = Object.fromEntries(statuses.map((s, i) => [s, byStatus[i]]));
    return {
        open: counts.open + counts['in-progress'], unassigned, overdue, high,
        byStatus: statuses.map((s, i) => ({ label: TICKET_STATUS_LABELS[s], value: byStatus[i] }))
    };
}

async function subscriptions() {
    const { data, error } = await supabase.rpc('admin_list_subscriptions');
    if (error) throw error;
    const rows = Array.isArray(data) ? data : [];
    const byStatus = {};
    const byPlan = {};
    let expiring = 0;
    for (const s of rows) {
        byStatus[s.status] = (byStatus[s.status] || 0) + 1;
        if (s.is_active) {
            const plan = s.plan_name_ar || s.plan || '—';
            byPlan[plan] = (byPlan[plan] || 0) + 1;
            if ((s.days_remaining ?? 99) <= 7) expiring += 1;
        }
    }
    return {
        active: rows.filter(s => s.is_active).length, expiring,
        byStatus: Object.keys(SUB_STATUS_LABELS).map(k => ({ label: SUB_STATUS_LABELS[k], value: byStatus[k] || 0 })),
        byPlan: Object.entries(byPlan).map(([label, value]) => ({ label, value, tone: '' }))
    };
}

async function activity() {
    const days = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 13; i >= 0; i -= 1) {
        const from = new Date(today.getTime() - i * 864e5);
        days.push({ from, to: new Date(from.getTime() + 864e5) });
    }
    const counts = await Promise.all(days.map(d => countOf(head('activity_logs')
        .gte('created_at', d.from.toISOString()).lt('created_at', d.to.toISOString()))));
    return days.map((d, i) => ({
        label: d.from.toLocaleDateString('ar-EG', { weekday: 'short', day: 'numeric', month: 'numeric' }),
        value: counts[i]
    }));
}

/** عدد الشركات: جدول companies لا تقرؤه سياسة المالك كاملًا (صاحب الشركة وأعضاؤها فقط)، فالمصدر دليل العملاء. */
async function companies() {
    const { data, error } = await supabase.rpc('admin_customer_filter_options');
    if (error) throw error;
    return Array.isArray(data?.companies) ? data.companies.length : null;
}

const settle = (p) => p.then(value => ({ value }), error => ({ error: error?.message || String(error) }));

async function render() {
    $('statsRefresh').disabled = true;
    const [acc, tix, subs, act, comp] = await Promise.all(
        [accounts(), tickets(), subscriptions(), activity(), companies()].map(settle));

    $('statsKpis').innerHTML = kpis([
        ['الحسابات', acc.value ? num(acc.value.total) : '—', ''],
        ['حسابات جديدة (30 يومًا)', acc.value ? num(acc.value.fresh) : '—', 'kpi--info'],
        ['عليها قيد حظر', acc.value ? num(acc.value.restricted) : '—', acc.value?.restricted ? 'kpi--warning' : ''],
        ['الشركات', comp.value === null || comp.value === undefined ? '—' : num(comp.value), ''],
        ['تذاكر مفتوحة', tix.value ? num(tix.value.open) : '—', 'kpi--info'],
        ['متأخرة عن SLA', tix.value ? num(tix.value.overdue) : '—', tix.value?.overdue ? 'kpi--danger' : ''],
        ['اشتراكات فعّالة', subs.value ? num(subs.value.active) : '—', 'kpi--success'],
        ['تنتهي خلال 7 أيام', subs.value ? num(subs.value.expiring) : '—', subs.value?.expiring ? 'kpi--warning' : '']
    ]);

    $('statsRoles').innerHTML = acc.error ? errorBlock(acc.error) : bars(acc.value.byRole);
    $('statsTickets').innerHTML = tix.error ? errorBlock(tix.error) : `${bars(tix.value.byStatus)}
        <p class="panel-subtitle owner-status-line">غير مسندة: ${esc(num(tix.value.unassigned))} · أولوية عالية مفتوحة: ${esc(num(tix.value.high))}
        · <a href="/owner/tickets.html">فتح التذاكر</a></p>`;
    $('statsSubs').innerHTML = subs.error ? errorBlock(subs.error) : `${bars(subs.value.byStatus)}
        ${subs.value.byPlan.length ? `<h3 class="owner-subsection-label">الفعّالة حسب الباقة</h3>${bars(subs.value.byPlan)}` : ''}`;
    $('statsActivity').innerHTML = act.error ? errorBlock(act.error) : bars(act.value);
    $('statsUpdated').textContent = `آخر تحديث: ${when(new Date())}`;
    $('statsRefresh').disabled = false;
}

(async function init() {
    if (!await bootOwnerPage()) return;
    $('statsRefresh').addEventListener('click', render);
    render();
})();
