/**
 * company-inbox.js — صندوق رسائل الشركة (migrations/102_company_conversations.sql).
 *
 * القرار في القاعدة: company_inbox_summary()/company_inbox_list() ترد null حين لا وصول (المفتاح مطفأ، ليس من
 * الفريق، أو بلا صلاحية عرض في 098)، والقائمة لا تحمل إلا ما يحق للناظر (كل المحادثات أو المسندة إليه).
 * الملاحظات الداخلية لا تصل العميل أبدًا، وهذا الملف لا يقرر شيئًا من ذلك: يرسم ما ترجعه القاعدة.
 */
import { supabase } from '/api-config.js';
import { escapeHtml, formatDate, renderState } from '/assets/js/customer/portal-ui.js';
import { ui } from '/ui-service.js';

const MISSING = new Set(['PGRST202', '42883', 'PGRST404']);

export const INBOX_FILTERS = Object.freeze([
    { value: 'open', label: 'المفتوحة' },
    { value: 'unassigned', label: 'غير المسندة' },
    { value: 'mine', label: 'المسندة إليّ' },
    { value: 'closed', label: 'المغلقة' },
    { value: 'all', label: 'الكل' }
]);

/** شارة القائمة الجانبية: عدد غير المقروء، أو لا شيء. خالصة. */
export function inboxBadge(summary) {
    const n = Number(summary?.unread);
    return Number.isFinite(n) && n > 0 ? (n > 99 ? '99+' : String(n)) : '';
}

/** وصف صف في القائمة. خالصة. */
export function inboxRowView(row) {
    return {
        id: String(row?.id || ''),
        subject: String(row?.subject || '—'),
        customer: String(row?.customer_name || '—'),
        assignee: row?.assignee_name ? String(row.assignee_name) : 'غير مسندة',
        status: row?.status === 'closed' ? 'مغلقة' : 'مفتوحة',
        waiting: row?.status !== 'closed' && row?.last_sender_kind === 'customer',
        unread: row?.unread === true
    };
}

async function rpc(name, args, fallback) {
    try {
        const { data, error } = await supabase.rpc(name, args);
        if (error) {
            if (MISSING.has(error.code) || error.status === 404) return { ok: true, data: null };
            return { ok: false, error: error.code === '0A000' ? 'صندوق الرسائل غير مفعّل بعد.' : (error.message || fallback) };
        }
        return { ok: true, data };
    } catch (err) {
        console.error(`[CompanyInbox] ${name}:`, err?.message || err);
        return { ok: false, error: fallback };
    }
}

/** null = لا صندوق لهذا الحساب (لا رابط في القائمة). */
export async function fetchInboxSummary() {
    const r = await rpc('company_inbox_summary', undefined, '');
    return r.ok ? r.data : null;
}

export function applyInboxBadge(summary) {
    const link = document.querySelector('.sidebar-item[data-tab="inbox"]');
    if (!link) return;
    let badge = link.querySelector('.sidebar-badge');
    const text = inboxBadge(summary);
    if (!text) { badge?.remove(); return; }
    if (!badge) {
        badge = document.createElement('span');
        badge.className = 'sidebar-badge';
        link.appendChild(badge);
    }
    badge.textContent = text;
}

let filter = 'open';
let openId = null;
let listData = null;
let wired = false;

export async function loadCompanyInbox() {
    if (!wired) { wire(); wired = true; }
    await renderList();
}

function wire() {
    const select = document.getElementById('companyInboxFilter');
    select.innerHTML = INBOX_FILTERS.map(f => `<option value="${f.value}">${escapeHtml(f.label)}</option>`).join('');
    select.addEventListener('change', async () => { filter = select.value; await renderList(); });
    document.getElementById('companyInboxRefresh').addEventListener('click', () => renderList());
    document.getElementById('companyInboxReply').addEventListener('submit', async (event) => {
        event.preventDefault();
        const input = document.getElementById('companyInboxReplyBody');
        const internal = document.getElementById('companyInboxInternal').checked;
        const body = input.value.trim();
        const errorBox = document.getElementById('companyInboxReplyError');
        if (!body || !openId) return;
        const send = document.getElementById('companyInboxReplySubmit');
        send.disabled = true;
        const r = await rpc('company_conversation_post', { p_conversation: openId, p_body: body, p_internal: internal }, 'تعذّر الإرسال.');
        send.disabled = false;
        if (!r.ok) { errorBox.textContent = r.error; errorBox.hidden = false; return; }
        errorBox.hidden = true;
        input.value = '';
        await openThread(openId);
        await renderList();
    });
}

async function renderList() {
    const box = document.getElementById('companyInboxList');
    const r = await rpc('company_inbox_list', { p_filter: filter }, 'تعذّر تحميل الرسائل.');
    if (!r.ok) { renderState(box, { variant: 'error', title: 'تعذّر تحميل الرسائل', text: r.error }); return; }
    if (r.data === null) {
        document.getElementById('companyInboxThread').hidden = true;
        renderState(box, { variant: 'empty', title: 'صندوق الرسائل غير متاح',
                           text: 'الميزة غير مفعّلة، أو لا صلاحية لك لعرض محادثات الشركة.' });
        return;
    }
    listData = r.data;
    const rows = (r.data.conversations || []).map(inboxRowView);
    if (!rows.length) {
        renderState(box, { variant: 'empty', title: 'لا محادثات هنا', text: 'تظهر هنا رسائل عملاء الشركة من بوابتهم.' });
        return;
    }
    box.innerHTML = `<ul class="company-sub-list">${rows.map(c => `
        <li class="company-sub company-inbox-row${c.unread ? ' is-unread' : ''}${c.id === openId ? ' is-open' : ''}">
            <button type="button" class="company-inbox-open" data-inbox="${escapeHtml(c.id)}">
                <span class="company-sub-plan">${escapeHtml(c.subject)}</span>
                <span class="company-sub-dates">${escapeHtml(c.customer)} · ${escapeHtml(c.assignee)} · ${escapeHtml(c.status)}
                    ${c.waiting ? '<span class="pill">بانتظار الرد</span>' : ''}</span>
            </button>
        </li>`).join('')}</ul>`;
    box.querySelectorAll('[data-inbox]').forEach(btn => btn.addEventListener('click', () => openThread(btn.getAttribute('data-inbox'))));
}

async function openThread(id) {
    const r = await rpc('company_conversation_thread', { p_conversation: id }, 'تعذّر فتح المحادثة.');
    if (!r.ok) { ui?.showToast?.(r.error, 'error'); return; }
    openId = id;
    const t = r.data || {};
    const pane = document.getElementById('companyInboxThread');
    pane.hidden = false;
    document.getElementById('companyInboxSubject').textContent = t.subject || '';
    document.getElementById('companyInboxMeta').textContent =
        `${t.customer_name || '—'} · ${t.status === 'closed' ? 'مغلقة' : 'مفتوحة'}`;
    document.getElementById('companyInboxMessages').innerHTML = (t.messages || []).map(m => `
        <li class="company-inbox-msg ${m.sender_kind === 'customer' ? 'is-customer' : 'is-team'}${m.is_internal ? ' is-internal' : ''}">
            <span class="company-inbox-who">${m.sender_kind === 'customer' ? escapeHtml(t.customer_name || 'العميل')
                : escapeHtml(m.sender_name || 'الفريق')}${m.is_internal ? ' · ملاحظة داخلية لا يراها العميل' : ''}</span>
            <p class="company-inbox-body">${escapeHtml(m.body)}</p>
            <small>${escapeHtml(formatDate(m.created_at))}</small>
        </li>`).join('');

    // الأدوات بحسب ما رجّعته القاعدة لهذه المحادثة
    // المغلقة تقبل الملاحظات الداخلية وحدها (القاعدة ترفض الرد العلني عليها)
    const closed = t.status === 'closed';
    const canPublic = t.can_reply === true && !closed;
    const canNote = t.can_internal === true;
    document.getElementById('companyInboxReply').hidden = !(canPublic || canNote);
    document.getElementById('companyInboxInternalWrap').hidden = !canNote;
    const internal = document.getElementById('companyInboxInternal');
    internal.checked = !canPublic;
    internal.disabled = !canPublic || !canNote;
    document.getElementById('companyInboxReplySubmit').textContent = canPublic ? 'إرسال' : 'إضافة ملاحظة';

    const tools = document.getElementById('companyInboxTools');
    const assignees = Array.isArray(listData?.assignees) ? listData.assignees : [];
    tools.innerHTML = `
        ${t.can_assign ? `<label class="company-inbox-assign">إسناد إلى
            <select class="form-control" id="companyInboxAssign">
                <option value="">غير مسندة</option>
                ${assignees.map(a => `<option value="${escapeHtml(a.id)}"${a.id === t.assigned_to ? ' selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}
            </select></label>` : ''}
        ${t.can_close ? `<button type="button" class="btn btn-secondary" id="companyInboxStatus" data-status="${closed ? 'open' : 'closed'}">
            ${closed ? 'إعادة فتح' : 'إغلاق المحادثة'}</button>` : ''}`;
    document.getElementById('companyInboxAssign')?.addEventListener('change', async (e) => {
        const res = await rpc('company_conversation_assign', { p_conversation: id, p_assignee: e.target.value || null }, 'تعذّر الإسناد.');
        if (!res.ok) { ui?.showToast?.(res.error, 'error'); return; }
        ui?.showToast?.('تم الإسناد', 'success');
        await renderList();
        await openThread(id);
    });
    document.getElementById('companyInboxStatus')?.addEventListener('click', async (e) => {
        const res = await rpc('company_conversation_set_status', { p_conversation: id, p_status: e.currentTarget.dataset.status },
                              'تعذّر تغيير الحالة.');
        if (!res.ok) { ui?.showToast?.(res.error, 'error'); return; }
        await renderList();
        await openThread(id);
    });
}
