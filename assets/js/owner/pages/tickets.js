/**
 * owner/tickets.html — إشراف المالك على التذاكر.
 *
 * القراءة: tickets_select_policy ← is_admin() · ticket_replies_select_policy ← is_platform_staff() — وكلاهما
 *   يمرّ للمالك في سياقه. ومع عزل الشركات (097) تبقى tenant_isolation: _ticket_row_visible() تعطي فريق
 *   المنصة نطاق mad3oom_support وحده، فتذاكر الشركات تختفي عن المالك هنا كما تختفي عن أي إداري.
 * الكتابة: «Admin can update tickets» ← is_admin()، وحارسا التذكرة يسمحان للإدارة بكل عمود. الصفحة ترسل
 *   الحالة والأولوية والمسؤول وحدها، ومعها last_updated_by — فيسجّلها log_ticket_changes في ticket_activity.
 * الرد (121): نفس addTicketReply في tickets-service.js الذي تستعمله مساحة عمل الدعم — لا مسار رد موازٍ.
 *   القاعدة تقبله للمالك في سياقه (has_elevated_authority في "Users can add replies to their tickets")،
 *   ومصفوفة الصلاحيات (tickets.reply) تقرر إن كان يتطلب جلسة تحرير. البريد للعميل من محفّز on_ticket_reply_created.
 * الوسوم والمرفقات والردود الجاهزة هنا أيضًا من tickets-service.js نفسه (انظر wireTicketExtras).
 * الحذف خارج هذه الصفحة عمدًا (انظر ملاحظة القيود في الصفحة).
 */
import {
    supabase, bootOwnerPage, announce, esc, when, num, table, kpis, errorBlock, loadingBlock,
    openModal, writeResult, friendlyError, renderPager
} from '/assets/js/owner/owner-page.js';
import { initEmpActivity } from '/assets/js/emp-activity.js';
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
    // فشل القراءة لا يوقف الجدول: الاسم يبقى معرّفًا مختصرًا كما في person().
    try {
        const { data } = await supabase.from('profiles').select('id, full_name, email, role').in('id', missing);
        (data || []).forEach(p => people.set(p.id, p));
    } catch (err) {
        console.error('[OwnerTickets] loadPeople:', err?.message || err);
    }
}

async function loadStaff() {
    let data, error = null;
    try {
        ({ data, error } = await supabase.from('profiles').select('id, full_name, email, role')
            .in('role', STAFF_ROLES).order('full_name', { ascending: true }));
    } catch (err) {
        error = err;
    }
    staff = error ? [] : (data || []);
    staff.forEach(p => people.set(p.id, p));
    const sel = $('ticketsAssignee');
    sel.insertAdjacentHTML('beforeend', staff.map(s =>
        `<option value="${esc(s.id)}">${esc(s.full_name || s.email)}</option>`).join(''));
}

/** أسماء الشركات من دليل العملاء — companies نفسها لا تقرؤها سياسة المالك كاملة. */
async function loadCompanies() {
    try {
        const { data } = await supabase.rpc('admin_customer_filter_options');
        (data?.companies || []).forEach(c => companies.set(c.id, c.name));
    } catch (err) {
        console.error('[OwnerTickets] loadCompanies:', err?.message || err);
    }
}

async function loadKpis() {
    const head = () => supabase.from('tickets').select('id', { count: 'exact', head: true });
    // انقطاع الشبكة يرمي: بلا التقاط تبقى المؤشرات هيكلًا عظميًا — تُعرض «—» بدل الصفر.
    let counts = null;
    try {
        counts = await Promise.all([
            head().eq('status', 'open'),
            head().eq('status', 'in-progress'),
            head().in('status', LIVE).is('assigned_to', null),
            head().in('status', LIVE).eq('priority', 'high'),
            head().in('status', LIVE).lt('sla_resolution_due_at', new Date().toISOString())
        ]);
    } catch (err) {
        counts = null;
    }
    const [open, progress, unassigned, high, overdue] = counts || [{}, {}, {}, {}, {}];
    const v = (r) => r.error ? '—' : num(r.count);
    $('ticketsKpis').innerHTML = kpis([
        ['مفتوحة', v(open), 'kpi--info'],
        ['قيد المعالجة', v(progress), ''],
        ['غير مسندة', v(unassigned), unassigned.count ? 'kpi--warning' : ''],
        ['أولوية عالية', v(high), high.count ? 'kpi--warning' : ''],
        ['متأخرة عن موعد الحل', v(overdue), overdue.count ? 'kpi--danger' : '']
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

/** شريحة حالة الفاتورة من ticket_invoice_status() — تظهر فقط حين ترد الدالة بحالة.
 *  الفشل (ومنها 42501) صامت عمدًا: التذكرة تُعرض بلا شريحة بدل أن تُحجب بخطأ. */
const invoiceChip = (inv) => {
    if (!inv || inv.state === 'none') return '<span class="owner-cell-muted">بلا فاتورة</span>';
    const number = inv.invoice_number ? ` ${esc(inv.invoice_number)}` : '';
    const total = inv.total != null ? ` · ${esc(num(inv.total))} ${esc(inv.currency || '')}` : '';
    if (inv.state === 'attached') return `<span class="pill status-resolved">فاتورة مرفقة${number}${total}</span>`;
    if (inv.state === 'ready') return `<span class="pill status-pending">فاتورة جاهزة للإرفاق${number}${total}</span>`;
    return `<span class="owner-cell-muted">${esc(inv.state)}</span>`;
};
const scopeText = (t) => t.scope === 'company'
    ? `شركة: ${esc(companies.get(t.company_id) || '—')}` : esc(label(SCOPE_LABELS, t.scope));
const overdue = (t) => LIVE.includes(t.status) && t.sla_resolution_due_at && new Date(t.sla_resolution_due_at) < new Date();

async function loadTickets() {
    const box = $('ticketsTable');
    box.innerHTML = loadingBlock();
    // انقطاع الشبكة يرمي: بلا التقاط يبقى الهيكل العظمي بلا تفسير.
    let data, error, count;
    try {
        ({ data, error, count } = await query());
    } catch (err) {
        error = err;
    }
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

/* ───────────────────────── إضافات التذكرة: وسوم ومرفقات وردود جاهزة ─────────────────────────
 * كلها من tickets-service.js نفسه الذي تستعمله مساحة عمل الدعم — لا منطق موازٍ.
 * الأساس في القاعدة (117/025/028/030/038/040): المالك في سياقه يمرّ من is_platform_staff()
 * (owner_capability('staff')) ومن is_admin()، فسياسات القراءة is_platform_staff() والكتابة
 * is_admin() تسمح له هنا بلا توسيع: canned_responses وticket_tags (قراءة طاقم + إدارة is_admin)،
 * ticket_tag_links (طاقم قراءةً وكتابةً)، ticket_attachments (طاقم)، ومستودع tickets رفعًا وقراءةً
 * (طاقم أو مسار العميل أو can_access_ticket). لا حذف للمرفقات: الخدمة لا تصدّر حذف مرفق أصلًا.
 * خارج النطاق عمدًا: التغيير الجماعي والحذف الجماعي وعدّادات SLA والفلاتر المحفوظة. */

async function wireTicketTags(box, ticketId, svc) {
    const status = (text, tone = 'info') => {
        const el = box.querySelector('#tagStatus');
        if (el) announce(el, text, tone);
    };
    const render = async () => {
        let all, linked;
        try {
            [all, linked] = await Promise.all([svc.fetchTags(), svc.fetchTicketTags(ticketId)]);
        } catch (err) {
            box.innerHTML = errorBlock(friendlyError(err));
            return;
        }
        const linkedIds = new Set((linked || []).map(x => x.id));
        const unlinked = (all || []).filter(x => !linkedIds.has(x.id));
        box.innerHTML = `
            <div class="owner-tags-current">
                ${(linked || []).length ? linked.map(x => `
                    <span class="pill" style="--tag-color:${esc(x.color || '#4DA3FF')}">
                        ${esc(x.name)}
                        <button type="button" class="owner-tag-remove" data-remove-tag="${esc(x.id)}" aria-label="إزالة الوسم ${esc(x.name)}">×</button>
                    </span>`).join('') : '<span class="panel-subtitle">لا وسوم على هذه التذكرة بعد.</span>'}
            </div>
            <form class="owner-action-form" id="tagAddForm" novalidate>
                <div class="form-field">
                    <label for="tagPick">إضافة وسوم (اختر واحدًا أو أكثر)</label>
                    <select class="form-control" id="tagPick" multiple size="4">
                        ${unlinked.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}
                    </select>
                </div>
                <div class="form-actions">
                    <button type="submit" class="btn btn-outline btn-sm" ${unlinked.length ? '' : 'disabled'}>إضافة المحدد</button>
                </div>
            </form>
            <form class="owner-action-form" id="tagNewForm" novalidate>
                <div class="form-grid">
                    <div class="form-field">
                        <label for="tagNewName">وسم جديد</label>
                        <input class="form-control" id="tagNewName" maxlength="60" placeholder="اسم الوسم…" required>
                    </div>
                    <div class="form-field">
                        <label for="tagNewColor">اللون</label>
                        <input class="form-control" id="tagNewColor" type="color" value="#4DA3FF">
                    </div>
                </div>
                <div class="form-actions">
                    <button type="submit" class="btn btn-outline btn-sm">إنشاء وسم وإضافته للتذكرة</button>
                </div>
            </form>
            <form class="owner-action-form" id="tagDeleteForm" novalidate>
                <div class="form-field">
                    <label for="tagDeletePick">حذف وسم نهائيًا (يُزال من كل التذاكر التي تحمله)</label>
                    <select class="form-control" id="tagDeletePick">
                        ${(all || []).map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}
                    </select>
                </div>
                <div class="form-actions">
                    <button type="submit" class="btn btn-outline btn-sm" ${(all || []).length ? '' : 'disabled'}>حذف الوسم</button>
                </div>
            </form>
            <p class="owner-sie-status" id="tagStatus" role="status" aria-live="polite" hidden></p>`;
        box.querySelectorAll('[data-remove-tag]').forEach(btn => btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                await svc.removeTagFromTicket(ticketId, btn.dataset.removeTag);
                // render() يعيد بناء الصندوق (ومنها سطر الحالة) — فالرسالة بعده لا قبله.
                await render();
                status('أُزيل الوسم.', 'success');
            } catch (err) { status(friendlyError(err), 'error'); btn.disabled = false; }
        }));
        box.querySelector('#tagAddForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const ids = [...box.querySelector('#tagPick').selectedOptions].map(o => o.value);
            if (!ids.length) { status('اختر وسمًا واحدًا على الأقل.', 'error'); return; }
            const btn = box.querySelector('#tagAddForm button[type="submit"]');
            btn.disabled = true;
            status('جارٍ الإضافة…');
            try {
                // إضافة جماعية: نداء واحد لكل وسم؛ فشل أحدها لا يلغي ما نجح — يُبلَّغ عنه.
                const results = await Promise.allSettled(ids.map(id => svc.addTagToTicket(ticketId, id)));
                const failed = results.filter(r => r.status === 'rejected').length;
                await render();
                status(failed ? `أُضيف ${ids.length - failed} من ${ids.length} — تعذّرت إضافة ${failed}.` : `أُضيفت ${ids.length} وسوم.`, failed ? 'error' : 'success');
            } catch (err) { status(friendlyError(err), 'error'); btn.disabled = false; }
        });
        box.querySelector('#tagNewForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = box.querySelector('#tagNewName').value.trim();
            if (name.length < 2) { status('اكتب اسم الوسم (حرفان على الأقل).', 'error'); return; }
            const btn = box.querySelector('#tagNewForm button[type="submit"]');
            btn.disabled = true;
            status('جارٍ الإنشاء…');
            try {
                const tag = await svc.createTag(name, box.querySelector('#tagNewColor').value);
                await svc.addTagToTicket(ticketId, tag.id);
                await render();
                status(`أُنشئ الوسم «${name}» وأُضيف للتذكرة.`, 'success');
            } catch (err) { status(friendlyError(err), 'error'); btn.disabled = false; }
        });
        box.querySelector('#tagDeleteForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const select = box.querySelector('#tagDeletePick');
            const id = select.value;
            const name = select.selectedOptions[0]?.textContent || '';
            if (!id) { status('لا وسوم لحذفها.', 'error'); return; }
            if (!window.confirm(`حذف الوسم «${name}» نهائيًا؟ يُزال من كل التذاكر التي تحمله.`)) return;
            const btn = box.querySelector('#tagDeleteForm button[type="submit"]');
            btn.disabled = true;
            status('جارٍ الحذف…');
            try {
                await svc.deleteTag(id);
                await render();
                status(`حُذف الوسم «${name}».`, 'success');
            } catch (err) { status(friendlyError(err), 'error'); btn.disabled = false; }
        });
    };
    await render();
}

async function wireTicketAttachments(box, ticketId, svc) {
    const status = (text, tone = 'info') => {
        const el = box.querySelector('#attStatus');
        if (el) announce(el, text, tone);
    };
    const render = async () => {
        let rows;
        try {
            rows = await svc.fetchTicketAttachments(ticketId);
        } catch (err) {
            box.innerHTML = errorBlock(friendlyError(err));
            return;
        }
        box.innerHTML = `
            ${rows.length ? `<ul class="owner-attachments">${rows.map(a => `
                <li>
                    <a href="${esc(a.file_url)}" target="_blank" rel="noopener">${esc(a.file_name || 'ملف')}</a>
                    <span class="panel-subtitle">${a.file_size ? `${esc(String(Math.round(a.file_size / 1024)))} كيلوبايت` : ''} · ${esc(when(a.created_at))}</span>
                </li>`).join('')}</ul>`
                : '<p class="panel-subtitle">لا مرفقات على هذه التذكرة بعد.</p>'}
            <form class="owner-action-form" id="attForm" novalidate>
                <div class="form-field">
                    <label for="attFiles">رفع مرفقات (يُسمح بملفات متعددة)</label>
                    <input class="form-control" id="attFiles" type="file" multiple required>
                </div>
                <div class="form-actions">
                    <button type="submit" class="btn btn-outline btn-sm">رفع المحدد</button>
                    <span class="panel-subtitle">تُحفظ في مستودع التذاكر وتظهر للعميل ولفريق الدعم.</span>
                </div>
            </form>
            <p class="owner-sie-status" id="attStatus" role="status" aria-live="polite" hidden></p>`;
        box.querySelector('#attForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const files = [...box.querySelector('#attFiles').files];
            if (!files.length) { status('اختر ملفًا واحدًا على الأقل.', 'error'); return; }
            const btn = box.querySelector('#attForm button[type="submit"]');
            btn.disabled = true;
            status(`جارٍ رفع ${files.length} ملف…`);
            try {
                const results = await Promise.allSettled(files.map(f => svc.uploadTicketAttachment(ticketId, f)));
                const failed = results.filter(r => r.status === 'rejected').length;
                await render();
                status(failed ? `رُفع ${files.length - failed} من ${files.length} — تعذّر رفع ${failed}.` : `رُفع ${files.length} ملف.`, failed ? 'error' : 'success');
            } catch (err) { status(friendlyError(err), 'error'); btn.disabled = false; }
        });
    };
    await render();
}

/** شرائح الردود الجاهزة فوق مربع الرد — النقر يُلحق المحتوى كما في مساحة عمل الدعم. */
async function wireCannedChips(row, textarea, manageBtn, svc, onChanged) {
    let list;
    try {
        list = await svc.fetchCannedResponses();
    } catch (err) {
        row.innerHTML = errorBlock(friendlyError(err));
        return;
    }
    if (!list.length) {
        row.innerHTML = '<p class="panel-subtitle">لا ردود جاهزة بعد — أنشئ أول رد من «إدارة الردود الجاهزة».</p>';
    } else {
        row.innerHTML = list.map(c => `<button type="button" class="btn btn-outline btn-sm owner-canned-chip" data-canned-id="${esc(c.id)}">${esc(c.title)}</button>`).join('');
        row.querySelectorAll('.owner-canned-chip').forEach(chip => chip.addEventListener('click', () => {
            const canned = list.find(c => String(c.id) === chip.dataset.cannedId);
            if (!canned || !textarea) return;
            textarea.value = textarea.value ? `${textarea.value}\n${canned.content}` : canned.content;
            textarea.focus();
        }));
    }
    // onclick لا addEventListener: wireCannedChips تُعاد عند كل حفظ في نافذة الإدارة،
    // فإضافة مستمع كل مرة كانت ستفتح النافذة بعدد مرات إعادة التحميل.
    manageBtn.onclick = () => openCannedManager(svc, onChanged);
}

/** نافذة إدارة الردود الجاهزة (إنشاء/تعديل/حذف) — فوق نافذة التذكرة. */
function openCannedManager(svc, onChanged) {
    const modal = openModal({ title: 'الردود الجاهزة', wide: true, html: loadingBlock() });
    const render = async () => {
        let list;
        try {
            list = await svc.fetchCannedResponses();
        } catch (err) {
            modal.body.innerHTML = errorBlock(friendlyError(err));
            return;
        }
        modal.body.innerHTML = `
            ${list.length ? table(['العنوان', 'التصنيف', 'الاختصار', ''], list, c => `<tr>
                <td>${esc(c.title)}</td>
                <td>${esc(c.category || '—')}</td>
                <td>${esc(c.shortcut || '—')}</td>
                <td>
                    <button type="button" class="btn btn-outline btn-sm" data-edit-canned="${esc(c.id)}">تعديل</button>
                    <button type="button" class="btn btn-outline btn-sm" data-delete-canned="${esc(c.id)}">حذف</button>
                </td>
            </tr>`, { empty: 'لا ردود جاهزة بعد.' }) : '<p class="panel-subtitle">لا ردود جاهزة بعد.</p>'}
            <form class="owner-action-form" id="cannedForm" novalidate>
                <input type="hidden" id="cannedId" value="">
                <div class="form-grid">
                    <div class="form-field">
                        <label for="cannedTitle">العنوان</label>
                        <input class="form-control" id="cannedTitle" maxlength="120" required placeholder="مثال: ترحيب بالعميل">
                    </div>
                    <div class="form-field">
                        <label for="cannedCategory">التصنيف</label>
                        <input class="form-control" id="cannedCategory" maxlength="60" placeholder="اختياري">
                    </div>
                    <div class="form-field">
                        <label for="cannedShortcut">الاختصار</label>
                        <input class="form-control" id="cannedShortcut" maxlength="40" placeholder="اختياري">
                    </div>
                </div>
                <div class="form-field">
                    <label for="cannedContent">المحتوى</label>
                    <textarea class="form-control" id="cannedContent" rows="4" maxlength="5000" required placeholder="نص الرد الجاهز…"></textarea>
                </div>
                <div class="form-actions">
                    <button type="submit" class="btn btn-primary btn-sm">حفظ الرد الجاهز</button>
                    <button type="button" class="btn btn-outline btn-sm" id="cannedResetBtn">نموذج جديد</button>
                </div>
                <p class="owner-sie-status" id="cannedStatus" role="status" aria-live="polite" hidden></p>
            </form>`;
        const say = (text, tone = 'info') => announce(modal.body.querySelector('#cannedStatus'), text, tone);
        modal.body.querySelectorAll('[data-edit-canned]').forEach(btn => btn.addEventListener('click', () => {
            const c = list.find(x => String(x.id) === btn.dataset.editCanned);
            if (!c) return;
            modal.body.querySelector('#cannedId').value = c.id;
            modal.body.querySelector('#cannedTitle').value = c.title || '';
            modal.body.querySelector('#cannedCategory').value = c.category || '';
            modal.body.querySelector('#cannedShortcut').value = c.shortcut || '';
            modal.body.querySelector('#cannedContent').value = c.content || '';
            modal.body.querySelector('#cannedTitle').focus();
        }));
        modal.body.querySelectorAll('[data-delete-canned]').forEach(btn => btn.addEventListener('click', async () => {
            if (!window.confirm('هل أنت متأكد من حذف هذا الرد الجاهز؟')) return;
            btn.disabled = true;
            try {
                await svc.deleteCannedResponse(btn.dataset.deleteCanned);
                // render() يعيد بناء النافذة فيمحو سطر حالتها — الرسالة على سطر الصفحة.
                announce($('pageStatus'), 'حُذف الرد الجاهز.', 'success');
                onChanged?.();
                render();
            } catch (err) { say(friendlyError(err), 'error'); btn.disabled = false; }
        }));
        modal.body.querySelector('#cannedResetBtn').addEventListener('click', () => {
            modal.body.querySelector('#cannedForm').reset();
            modal.body.querySelector('#cannedId').value = '';
        });
        modal.body.querySelector('#cannedForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const id = modal.body.querySelector('#cannedId').value;
            const payload = {
                title: modal.body.querySelector('#cannedTitle').value.trim(),
                content: modal.body.querySelector('#cannedContent').value.trim(),
                category: modal.body.querySelector('#cannedCategory').value.trim() || null,
                shortcut: modal.body.querySelector('#cannedShortcut').value.trim() || null
            };
            if (payload.title.length < 2 || payload.content.length < 2) { say('اكتب العنوان والمحتوى.', 'error'); return; }
            const btn = modal.body.querySelector('#cannedForm button[type="submit"]');
            btn.disabled = true;
            say('جارٍ الحفظ…');
            try {
                if (id) await svc.updateCannedResponse(id, payload);
                else await svc.createCannedResponse(payload);
                onChanged?.();
                await render();
                say('حُفظ الرد الجاهز.', 'success');
            } catch (err) { say(friendlyError(err), 'error'); btn.disabled = false; }
        });
    };
    render();
}

async function wireTicketExtras(modal, t) {
    let svc;
    try {
        svc = await import('/tickets-service.js');
    } catch (err) {
        const box = modal.body.querySelector('#ticketTagsBox');
        if (box) box.innerHTML = errorBlock(friendlyError(err));
        const att = modal.body.querySelector('#ticketAttachmentsBox');
        if (att) att.innerHTML = errorBlock(friendlyError(err));
        return;
    }
    const chipsRow = modal.body.querySelector('#cannedChips');
    const textarea = modal.body.querySelector('#replyText');
    const manageBtn = modal.body.querySelector('#cannedManageBtn');
    const reloadChips = () => wireCannedChips(chipsRow, textarea, manageBtn, svc, reloadChips);
    await Promise.allSettled([
        wireTicketTags(modal.body.querySelector('#ticketTagsBox'), t.id, svc),
        wireTicketAttachments(modal.body.querySelector('#ticketAttachmentsBox'), t.id, svc),
        reloadChips()
    ]);
}

async function openTicket(id) {
    const modal = openModal({ title: 'تذكرة', wide: true, html: loadingBlock() });
    // انقطاع الشبكة يرمي: بلا التقاط تبقى النافذة على التحميل إلى الأبد.
    let ticket, replies, invoice = null;
    try {
        [ticket, replies] = await Promise.all([
            supabase.from('tickets').select(`${COLUMNS}, description, contact_info, ticket_type, first_response_at, resolved_at, reopen_count`)
                .eq('id', id).maybeSingle(),
            supabase.from('ticket_replies').select('id, user_id, message, created_at, is_internal')
                .eq('ticket_id', id).order('created_at', { ascending: true })
        ]);
        // حالة الفاتورة (051/072، is_platform_staff — يمرّ المالك): فشلها لا يحجب التذكرة.
        try {
            const inv = await supabase.rpc('ticket_invoice_status', { p_ticket_id: id });
            if (!inv.error && inv.data) invoice = inv.data;
        } catch { /* بلا شريحة فاتورة */ }
    } catch (err) {
        modal.body.innerHTML = errorBlock(friendlyError(err));
        return;
    }
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
            <div><dt>الفاتورة</dt><dd>${invoiceChip(invoice)}</dd></div>
            <div><dt>التصنيف</dt><dd>${esc(t.category || '—')}</dd></div>
            <div><dt>أُنشئت</dt><dd>${esc(when(t.created_at))}</dd></div>
            <div><dt>أول رد</dt><dd>${esc(when(t.first_response_at))}</dd></div>
            <div><dt>موعد الحل المتفق عليه</dt><dd>${esc(when(t.sla_resolution_due_at))}${overdue(t) ? ' <span class="pill status-rejected">متأخرة</span>' : ''}</dd></div>
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
                </div>
                <p class="owner-sie-status" id="ticketStatus" role="status" aria-live="polite" hidden></p>
            </form>
        </section>

        <section class="owner-detail-section">
            <h3>الوسوم</h3>
            <div id="ticketTagsBox">${loadingBlock()}</div>
        </section>

        <section class="owner-detail-section">
            <h3>المرفقات</h3>
            <div id="ticketAttachmentsBox">${loadingBlock()}</div>
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
        </section>

        <section class="owner-detail-section">
            <h3>الرد</h3>
            <div class="owner-canned-row" id="cannedChips"><p class="panel-subtitle">جارٍ تحميل الردود الجاهزة…</p></div>
            <form class="owner-action-form owner-reply-form" id="replyForm" novalidate>
                <div class="form-field">
                    <label for="replyText">نص الرد</label>
                    <textarea class="form-control" id="replyText" rows="4" maxlength="5000" required
                              placeholder="اكتب ردك للعميل…"></textarea>
                </div>
                <div class="owner-reply-kind" role="radiogroup" aria-label="نوع الرد">
                    <label><input type="radio" name="replyKind" value="public" checked> رد للعميل (يصله بالبريد)</label>
                    <label><input type="radio" name="replyKind" value="internal"> ملاحظة داخلية (لفريق المنصة وحده)</label>
                </div>
                <div class="form-actions">
                    <button type="submit" class="btn btn-primary btn-sm">إرسال الرد</button>
                    <button type="button" class="btn btn-outline btn-sm" id="cannedManageBtn">إدارة الردود الجاهزة</button>
                    <span class="panel-subtitle">يُرسَل باسمك ويظهر في سجل التذكرة.</span>
                </div>
                <p class="owner-sie-status" id="replyStatus" role="status" aria-live="polite" hidden></p>
            </form>
        </section>`;

    const replyForm = modal.body.querySelector('#replyForm');
    replyForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = replyForm.querySelector('#replyText').value.trim();
        const replyStatus = (msg, tone) => announce(replyForm.querySelector('#replyStatus'), msg, tone);
        if (text.length < 2) { replyStatus('اكتب نص الرد.', 'error'); replyForm.querySelector('#replyText').focus(); return; }
        const internal = replyForm.querySelector('input[name="replyKind"]:checked')?.value === 'internal';
        const submit = replyForm.querySelector('button[type="submit"]');
        submit.disabled = true;
        replyStatus('جارٍ الإرسال…');
        try {
            const { addTicketReply } = await import('/tickets-service.js');
            await addTicketReply(t.id, text, internal);
        } catch (err) {
            submit.disabled = false;
            replyStatus(friendlyError(err), 'error');
            return;
        }
        say(internal ? 'أُضيفت الملاحظة الداخلية.' : `أُرسل الرد على التذكرة #${t.ticket_number ?? ''}.`, 'success');
        openTicket(t.id);
        loadTickets();
    });

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
        let result;
        try {
            result = writeResult(await supabase.from('tickets').update(patch).eq('id', t.id).select('id'));
        } catch (err) {
            result = { ok: false, message: friendlyError(err) };
        } finally {
            submit.disabled = false;
        }
        if (!result.ok) { status(result.message, 'error'); return; }
        modal.close();
        say(`تم تحديث التذكرة #${t.ticket_number ?? ''}.`, 'success');
        loadKpis();
        loadTickets();
    });

    // الوسوم والمرفقات والردود الجاهزة — من tickets-service.js نفسه؛ فشلها لا يوقف التذكرة.
    wireTicketExtras(modal, t);
}

(async function init() {
    const ctx = await bootOwnerPage();
    if (!ctx) return;
    me = ctx.session.user.id;
    // تتبّع نشاط موظفي مدعوم (emp_ops) — best-effort؛ أي فشل فيه لا يوقف الصفحة.
    initEmpActivity({ supabase, expectEmployee: true });

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
