/**
 * owner/tickets.html — إشراف المالك على التذاكر.
 *
 * القراءة: tickets_select_policy ← is_admin() · ticket_replies_select_policy ← is_platform_staff() — وكلاهما
 *   يمرّ للمالك في سياقه. ومع عزل الشركات (097) تبقى tenant_isolation: _ticket_row_visible() تعطي فريق
 *   المنصة نطاق mad3oom_support وحده، فتذاكر الشركات تختفي عن المالك هنا كما تختفي عن أي إداري.
 * الكتابة: «Admin can update tickets» ← is_admin()، وحارسا التذكرة يسمحان للإدارة بكل عمود. الصفحة ترسل
 *   الحالة والأولوية والمسؤول وحدها، ومعها last_updated_by — فيسجّلها log_ticket_changes في ticket_activity.
 * الرد على العميل والحذف خارج هذه الصفحة عمدًا (انظر ملاحظة القيود في الصفحة).
 */
import {
    supabase, bootOwnerPage, announce, esc, when, num, table, kpis, errorBlock, loadingBlock,
    openModal, writeResult, friendlyError, renderPager
} from '/assets/js/owner/owner-page.js';
import {
    TICKET_STATUS_LABELS, TICKET_STATUS_TONES, PRIORITY_LABELS, SCOPE_LABELS, STAFF_ROLES, label,
    searchTerm, pageRange, pagerText
} from '/assets/js/owner/owner-labels.js';

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 25;
const LIVE = ['open', 'in-progress'];
const COLUMNS = 'id, ticket_number, title, status, priority, scope, company_id, user_id, assigned_to, category, created_at, last_updated_at, sla_resolution_due_at';

let me = null;
let page = 0;
let rows = [];
let staff = [];
const people = new Map();
const companies = new Map();

const say = (text, tone = 'info') => announce($('pageStatus'), text, tone);
const person = (id) => {
    if (!id) return '—';
    const p = people.get(id);
    return p ? (p.full_name || p.email) : id.slice(0, 8);
};

async function loadPeople(ids) {
    const missing = [...new Set(ids.filter(id => id && !people.has(id)))];
    if (!missing.length) return;
    const { data } = await supabase.from('profiles').select('id, full_name, email, role').in('id', missing);
    (data || []).forEach(p => people.set(p.id, p));
}

async function loadStaff() {
    const { data, error } = await supabase.from('profiles').select('id, full_name, email, role')
        .in('role', STAFF_ROLES).order('full_name', { ascending: true });
    staff = error ? [] : (data || []);
    staff.forEach(p => people.set(p.id, p));
    const sel = $('ticketsAssignee');
    sel.insertAdjacentHTML('beforeend', staff.map(s =>
        `<option value="${esc(s.id)}">${esc(s.full_name || s.email)}</option>`).join(''));
}

/** أسماء الشركات من دليل العملاء — companies نفسها لا تقرؤها سياسة المالك كاملة. */
async function loadCompanies() {
    const { data } = await supabase.rpc('admin_customer_filter_options');
    (data?.companies || []).forEach(c => companies.set(c.id, c.name));
}

async function loadKpis() {
    const head = () => supabase.from('tickets').select('id', { count: 'exact', head: true });
    const [open, progress, unassigned, high, overdue] = await Promise.all([
        head().eq('status', 'open'),
        head().eq('status', 'in-progress'),
        head().in('status', LIVE).is('assigned_to', null),
        head().in('status', LIVE).eq('priority', 'high'),
        head().in('status', LIVE).lt('sla_resolution_due_at', new Date().toISOString())
    ]);
    const v = (r) => r.error ? '—' : num(r.count);
    $('ticketsKpis').innerHTML = kpis([
        ['مفتوحة', v(open), 'kpi--info'],
        ['قيد المعالجة', v(progress), ''],
        ['غير مسندة', v(unassigned), unassigned.count ? 'kpi--warning' : ''],
        ['أولوية عالية', v(high), high.count ? 'kpi--warning' : ''],
        ['متأخرة عن SLA', v(overdue), overdue.count ? 'kpi--danger' : '']
    ]);
}

function query() {
    let q = supabase.from('tickets').select(COLUMNS, { count: 'exact' }).order('created_at', { ascending: false });
    const status = $('ticketsStatus').value;
    const priority = $('ticketsPriority').value;
    const scope = $('ticketsScope').value;
    const assignee = $('ticketsAssignee').value;
    const term = searchTerm($('ticketsSearch').value);
    if (status) q = q.eq('status', status);
    if (priority) q = q.eq('priority', priority);
    if (scope) q = q.eq('scope', scope);
    if (assignee === 'none') q = q.is('assigned_to', null);
    else if (assignee) q = q.eq('assigned_to', assignee);
    if (term) q = /^\d+$/.test(term) ? q.eq('ticket_number', Number(term)) : q.ilike('title', `%${term}%`);
    return q.range(...pageRange(page, PAGE_SIZE));
}

const statusPill = (s) => `<span class="pill ${TICKET_STATUS_TONES[s] || 'status-neutral'}">${esc(label(TICKET_STATUS_LABELS, s))}</span>`;
const scopeText = (t) => t.scope === 'company'
    ? `شركة: ${esc(companies.get(t.company_id) || '—')}` : esc(label(SCOPE_LABELS, t.scope));
const overdue = (t) => LIVE.includes(t.status) && t.sla_resolution_due_at && new Date(t.sla_resolution_due_at) < new Date();

async function loadTickets() {
    const box = $('ticketsTable');
    box.innerHTML = loadingBlock();
    const { data, error, count } = await query();
    if (error) { box.innerHTML = errorBlock(friendlyError(error)); $('ticketsPager').hidden = true; return; }
    rows = data || [];
    await loadPeople(rows.flatMap(t => [t.user_id, t.assigned_to]));
    box.innerHTML = table(['#', 'العنوان', 'العميل', 'النطاق', 'الحالة', 'الأولوية', 'المسؤول', 'أُنشئت'], rows, t => `<tr>
        <td><button type="button" class="panel-link" data-ticket="${esc(t.id)}">${esc(t.ticket_number ?? '—')}</button></td>
        <td>${esc(t.title)}${overdue(t) ? ' <span class="pill status-rejected">متأخرة</span>' : ''}</td>
        <td>${esc(person(t.user_id))}</td>
        <td>${scopeText(t)}</td>
        <td>${statusPill(t.status)}</td>
        <td><span class="priority-${esc(t.priority)}">${esc(label(PRIORITY_LABELS, t.priority))}</span></td>
        <td>${t.assigned_to ? esc(person(t.assigned_to)) : '<span class="owner-cell-muted">غير مسندة</span>'}</td>
        <td>${esc(when(t.created_at))}</td>
    </tr>`, { empty: 'لا تذاكر مطابقة للتصفية.' });
    box.querySelectorAll('[data-ticket]').forEach(b => b.addEventListener('click', () => openTicket(b.dataset.ticket)));
    renderPager($('ticketsPager'), {
        page, size: PAGE_SIZE, total: count || 0, text: pagerText(page, PAGE_SIZE, count || 0),
        onPage: (p) => { page = p; loadTickets(); }
    });
}

/* ───────────────────────── تفاصيل التذكرة ───────────────────────── */

async function openTicket(id) {
    const modal = openModal({ title: 'تذكرة', wide: true, html: loadingBlock() });
    const [ticket, replies] = await Promise.all([
        supabase.from('tickets').select(`${COLUMNS}, description, contact_info, ticket_type, first_response_at, resolved_at, reopen_count`)
            .eq('id', id).maybeSingle(),
        supabase.from('ticket_replies').select('id, user_id, message, created_at, is_internal')
            .eq('ticket_id', id).order('created_at', { ascending: true })
    ]);
    if (ticket.error || !ticket.data) {
        modal.body.innerHTML = errorBlock(ticket.error ? friendlyError(ticket.error) : 'التذكرة غير موجودة أو خارج نطاق رؤيتك.');
        return;
    }
    const t = ticket.data;
    await loadPeople([t.user_id, t.assigned_to, ...(replies.data || []).map(r => r.user_id)]);
    modal.root.querySelector('#ownerModalTitle').textContent = `#${t.ticket_number ?? ''} — ${t.title || ''}`;

    const options = (map, current) => Object.entries(map)
        .map(([k, v]) => `<option value="${esc(k)}" ${k === current ? 'selected' : ''}>${esc(v)}</option>`).join('');
    const assigneeKnown = !t.assigned_to || staff.some(s => s.id === t.assigned_to);

    modal.body.innerHTML = `
        <dl class="owner-detail-grid">
            <div><dt>العميل</dt><dd>${esc(person(t.user_id))}</dd></div>
            <div><dt>النطاق</dt><dd>${scopeText(t)}</dd></div>
            <div><dt>الحالة</dt><dd>${statusPill(t.status)}</dd></div>
            <div><dt>التصنيف</dt><dd>${esc(t.category || '—')}</dd></div>
            <div><dt>أُنشئت</dt><dd>${esc(when(t.created_at))}</dd></div>
            <div><dt>أول رد</dt><dd>${esc(when(t.first_response_at))}</dd></div>
            <div><dt>موعد الحل (SLA)</dt><dd>${esc(when(t.sla_resolution_due_at))}${overdue(t) ? ' <span class="pill status-rejected">متأخرة</span>' : ''}</dd></div>
            <div><dt>مرات إعادة الفتح</dt><dd>${esc(num(t.reopen_count || 0))}</dd></div>
        </dl>

        <section class="owner-detail-section">
            <h3>إجراءات المالك</h3>
            <form class="owner-action-form" id="ticketForm" novalidate>
                <div class="form-grid">
                    <div class="form-field">
                        <label for="tStatus">الحالة</label>
                        <select class="form-control" id="tStatus">${options(TICKET_STATUS_LABELS, t.status)}</select>
                    </div>
                    <div class="form-field">
                        <label for="tPriority">الأولوية</label>
                        <select class="form-control" id="tPriority">${options(PRIORITY_LABELS, t.priority)}</select>
                    </div>
                    <div class="form-field">
                        <label for="tAssignee">المسؤول</label>
                        <select class="form-control" id="tAssignee">
                            <option value="">غير مسندة</option>
                            ${assigneeKnown ? '' : `<option value="${esc(t.assigned_to)}" selected>${esc(person(t.assigned_to))}</option>`}
                            ${staff.map(s => `<option value="${esc(s.id)}" ${s.id === t.assigned_to ? 'selected' : ''}>${esc(s.full_name || s.email)}</option>`).join('')}
                        </select>
                    </div>
                </div>
                <div class="form-actions">
                    <button type="submit" class="btn btn-primary btn-sm">حفظ التغييرات</button>
                    <a class="btn btn-outline btn-sm" href="/admin/tickets.html?ticket_id=${esc(t.id)}">الرد من مساحة عمل الدعم</a>
                </div>
                <p class="owner-sie-status" id="ticketStatus" role="status" aria-live="polite" hidden></p>
            </form>
        </section>

        <section class="owner-detail-section">
            <h3>الوصف</h3>
            <p class="owner-text-block">${esc(t.description || '—')}</p>
        </section>

        <section class="owner-detail-section">
            <h3>المحادثة (${esc(num((replies.data || []).length))})</h3>
            ${replies.error ? errorBlock(friendlyError(replies.error)) : (replies.data || []).length
                ? `<ol class="owner-thread">${replies.data.map(r => `
                    <li class="${r.is_internal ? 'is-internal' : ''}">
                        <div class="owner-thread-head">
                            <span>${esc(person(r.user_id))}${r.is_internal ? ' · ملاحظة داخلية' : ''}</span>
                            <span>${esc(when(r.created_at))}</span>
                        </div>
                        <p class="owner-text-block">${esc(r.message)}</p>
                    </li>`).join('')}</ol>`
                : '<p class="panel-subtitle">لا ردود بعد.</p>'}
        </section>`;

    const form = modal.body.querySelector('#ticketForm');
    const status = (text, tone) => announce(form.querySelector('#ticketStatus'), text, tone);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const patch = {};
        const next = { status: form.querySelector('#tStatus').value, priority: form.querySelector('#tPriority').value,
                       assigned_to: form.querySelector('#tAssignee').value || null };
        for (const [k, v] of Object.entries(next)) if ((t[k] ?? null) !== v) patch[k] = v;
        if (!Object.keys(patch).length) { status('لا تغيير لحفظه.', 'info'); return; }
        patch.last_updated_by = me;
        patch.last_updated_at = new Date().toISOString();
        const submit = form.querySelector('button[type="submit"]');
        submit.disabled = true;
        status('جارٍ الحفظ…');
        const result = writeResult(await supabase.from('tickets').update(patch).eq('id', t.id).select('id'));
        submit.disabled = false;
        if (!result.ok) { status(result.message, 'error'); return; }
        modal.close();
        say(`تم تحديث التذكرة #${t.ticket_number ?? ''}.`, 'success');
        loadKpis();
        loadTickets();
    });
}

(async function init() {
    const ctx = await bootOwnerPage();
    if (!ctx) return;
    me = ctx.session.user.id;

    await Promise.all([loadStaff(), loadCompanies()]);
    $('ticketsFilters').addEventListener('submit', (e) => { e.preventDefault(); page = 0; loadTickets(); });
    ['ticketsStatus', 'ticketsPriority', 'ticketsScope', 'ticketsAssignee']
        .forEach(id => $(id).addEventListener('change', () => { page = 0; loadTickets(); }));
    $('ticketsRefresh').addEventListener('click', () => { loadKpis(); loadTickets(); });

    loadKpis();
    await loadTickets();
    const deepLink = new URLSearchParams(location.search).get('ticket');
    if (deepLink) openTicket(deepLink);
})();
