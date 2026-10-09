/**
 * Relay — صفحة السجلات (admin/relay.html، المرحلة C).
 *
 * القائمة (relay_list: بلا مقتطفات) وتفاصيل سجل (relay_get: المقتطف يظهر فقط لو
 * الخادم قرر في القراءة دي إن عندك وصول حالي للمحادثة — C3). التعديل والإسناد
 * والانتقالات والحجب كلها عبر الـRPC، والأدوات المعروضة تعكس relay_my_access
 * وقواعد 074/076 للعرض فقط: الخادم هو اللي يرفض.
 *
 * 076: «إزالة» رسالة من سجل تنقلها للمحذوفات (ترجع بـ«استرجاع»). المسح النهائي
 * وتفريغ المحذوفات وصلاحية الإسناد لحساب مالك المنصة بس (access.owner).
 */
import { initSidebar } from '/assets/js/admin/sidebar.js';
import { checkAdminAuth, updateAdminUI } from '/assets/js/admin/auth.js';
import { describeSource, retentionDeadline, LIMITS } from './relay-contract.js';
import { relayConfirm, relayPrompt } from './relay-dialog.js';
import {
    CATEGORY_META, KIND_META, PRIORITY_LABELS, STATUS_LABELS, EVENT_LABELS, RECORD_CATEGORIES,
    allowedTransitions, assignmentOptions, toZonedInput,
} from './relay-model.js';
import {
    loadRelayAccess, listRecords, getRecord, updateRecord, assignRecord, transitionRecord, loadEvents,
    removeSource, restoreSource, listRemoved, purgeSource, purgeRemoved,
    listAssigners, grantAssigner, revokeAssigner, loadAgents, loadTeams,
} from './relay-data.js';
import { RELAY_ICONS } from './relay-icons.js';

const $ = (id) => document.getElementById(id);
const TIMEZONES = ['Africa/Cairo', 'Asia/Riyadh', 'Asia/Dubai', 'Europe/London', 'UTC'];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DT = new Intl.DateTimeFormat('ar-EG-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' });
const fmt = (iso, tz) => {
    if (!iso) return '';
    try { return tz ? new Intl.DateTimeFormat('ar-EG-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(new Date(iso)) : DT.format(new Date(iso)); } catch { return ''; }
};

const state = {
    me: null, access: null, agents: [], teams: [], records: [], current: null, events: [], assigners: null, trash: [],
    filters: { status: 'active', owner: '', category: '' }, busy: false,
};
const agentName = (id) => {
    if (!id) return 'بدون مالك';
    if (id === state.me?.id) return 'أنت';
    const a = state.agents.find((x) => x.id === id);
    return a?.full_name || a?.email || 'موظف';
};
const teamName = (id) => state.teams.find((t) => t.id === id)?.name || '';

function toast(message, kind = 'ok') {
    const el = $('toast');
    el.textContent = message;
    el.className = kind === 'err' ? 'toast toast--err' : 'toast';
    el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.hidden = true; }, 3600);
}

// ═════════════════════════════════════════════════════════════
// القائمة
// ═════════════════════════════════════════════════════════════
function filtersToRpc() {
    const f = { limit: 100 };
    if (state.filters.status === 'active') f.status = ['open', 'scheduled', 'in_progress', 'waiting'];
    else if (state.filters.status === 'closed') f.status = ['resolved', 'cancelled'];
    if (state.filters.owner) f.owner = state.filters.owner;
    if (state.filters.category) f.category = state.filters.category;
    return f;
}

async function reloadList() {
    $('rlList').innerHTML = '<li class="rl-empty">بيحمّل…</li>';
    try {
        state.records = await listRecords(filtersToRpc()) || [];
    } catch (err) {
        state.records = [];
        $('rlList').innerHTML = `<li class="rl-empty">${esc(err.message)}</li>`;
        return;
    }
    renderList();
}

function renderList() {
    if (!state.records.length) {
        $('rlList').innerHTML = '<li class="rl-empty" id="rlListEmpty">مفيش سجلات بالفلاتر دي. السجلات بتتعمل من صندوق الرسائل: افتح محادثة واضغط «سجل استمرارية».</li>';
        return;
    }
    $('rlList').innerHTML = state.records.map((r) => `<li><button type="button" class="rl-item ${state.current?.record?.id === r.id ? 'is-on' : ''}" data-open="${esc(r.id)}">
        <span class="rl-item-title">${esc(r.title)}</span>
        <span class="rl-item-meta">
          <span class="rl-pill">${esc(STATUS_LABELS[r.status] || r.status)}</span>
          ${r.category ? `<span class="rl-pill rl-pill--accent">${esc(CATEGORY_META[r.category]?.label || r.category)}</span>` : ''}
          ${r.overdue ? '<span class="rl-pill rl-pill--danger">متأخر</span>' : ''}
          <span>${esc(agentName(r.owner_id))}</span>
          ${r.due_at ? `<span>${esc(fmt(r.due_at, r.due_tz))}</span>` : ''}
          <span>${r.source_count} مصدر</span>
        </span></button></li>`).join('');
}

// ═════════════════════════════════════════════════════════════
// السجل
// ═════════════════════════════════════════════════════════════
async function openRecord(id, { push = true } = {}) {
    if (!id) return;
    $('rlDetail').innerHTML = '<p class="rl-empty">بيحمّل…</p>';
    $('rlPage').classList.add('has-record');
    try {
        const [full, events] = await Promise.all([getRecord(id), loadEvents(id).catch(() => [])]);
        state.current = full;
        state.events = events || [];
    } catch (err) {
        state.current = null;
        $('rlDetail').innerHTML = `<p class="rl-empty" id="rlNotFound">${esc(err.code === 'not_found' ? 'السجل غير موجود أو مش مسموح لك تشوفه.' : err.message)}</p>`;
        return;
    }
    if (push) {
        const url = new URL(location.href);
        url.searchParams.set('record', id);
        history.replaceState(null, '', url);
    }
    renderRecord();
    renderList();
}

const isClosed = (status) => status === 'resolved' || status === 'cancelled';

/** mode: 'main' (مصادر السجل) أو 'removed' (المحذوفات). closed = السجل مقفول. */
function sourceHtml(s, { mode = 'main', closed = false, version = null, recordId = null } = {}) {
    const d = describeSource(s);
    const data = `data-source="${esc(s.id)}"${version != null ? ` data-version="${esc(version)}"` : ''}${recordId ? ` data-record="${esc(recordId)}"` : ''}`;
    let actions = '';
    if (mode === 'main' && !state.access.trash) {
        // قبل 076: الحجب النهائي كما في 074 (المالك أو المنشئ أو المشرف).
        if (d.state === 'visible' && canRedactLegacy()) actions = `<button type="button" class="btn btn-secondary rl-btn-sm" data-redact="${esc(s.id)}">حذف المحتوى</button>`;
    } else if (mode === 'main' && !closed) {
        actions = `<button type="button" class="btn btn-secondary rl-btn-sm" data-remove ${data}>إزالة</button>`;
    } else if (mode === 'removed') {
        actions = `${closed ? '' : `<button type="button" class="btn btn-secondary rl-btn-sm" data-restore ${data}>استرجاع</button>`}
            ${state.access.owner ? `<button type="button" class="btn btn-danger rl-btn-sm" data-purge ${data}>مسح نهائي</button>` : ''}`;
    }
    const head = `<div class="rl-source-head"><span>#${s.position}</span>
        ${d.state === 'visible' && d.senderLabel ? `<b>${esc(d.senderLabel)}</b>` : ''}
        ${d.state === 'visible' && s.original_created_at ? `<span>${esc(fmt(s.original_created_at))}</span>` : ''}
        ${d.deletedAtSource ? '<span class="rl-pill">اتحذفت من المحادثة</span>' : ''}
        ${d.editedAfterCapture ? '<span class="rl-pill">اتعدّلت بعد الإرفاق</span>' : ''}
        <span class="rl-spacer"></span>
        ${d.state === 'visible' && s.chat_session_id ? `<a href="/admin/inbox.html?session=${encodeURIComponent(s.chat_session_id)}">فتح المحادثة</a>` : ''}
      </div>`;
    const foot = `${mode === 'removed' && s.removed_at
        ? `<small class="rl-removed-by">شالها ${esc(agentName(s.removed_by))} · ${esc(fmt(s.removed_at))}</small>` : ''}
        ${actions ? `<div class="rl-source-actions">${actions}</div>` : ''}`;
    if (d.state === 'visible') return `<li class="rl-source" ${data}>${head}<p>${esc(d.excerpt)}</p>${foot}</li>`;
    return `<li class="rl-source is-hidden" ${data} data-state="${d.state}">${head}<p>${RELAY_ICONS.lock}${esc(d.label)}</p>${foot}</li>`;
}

const canRedactLegacy = () => {
    const r = state.current?.record;
    return Boolean(r && (state.access.supervisor || r.owner_id === state.me?.id || r.created_by === state.me?.id));
};

const eventLabel = (e) => EVENT_LABELS[e.kind === 'source_redacted' && e.payload?.purged ? 'source_purged' : e.kind] || e.kind;

/** أزرار المصدر نفسها في تفاصيل السجل وفي لوحة المحذوفات. */
async function sourceAction(el) {
    const id = el.dataset.source;
    const version = Number(el.dataset.version);
    if (!id) return undefined;
    if ('remove' in el.dataset) {
        return act(() => removeSource(id, version), 'اتنقلت للمحذوفات. تقدر ترجّعها من «المحذوفات».');
    }
    if ('restore' in el.dataset) {
        return act(() => restoreSource(id, version), 'رجعت للسجل');
    }
    if ('purge' in el.dataset) {
        if (!await relayConfirm({ title: 'مسح الرسالة نهائيًا', danger: true, confirmText: 'مسح نهائي',
            message: 'المحتوى هيتمسح ومش هيرجع، ومش هتقدر ترفق نفس الرسالة للسجل ده تاني.' })) return undefined;
        return act(() => purgeSource(id), 'اتمسحت نهائيًا');
    }
    return undefined;
}

function renderRecord() {
    const r = state.current?.record;
    if (!r) return;
    const closed = isClosed(r.status);
    const removed = state.current.removed || [];
    const deadline = retentionDeadline(r.closed_at);
    const transitions = allowedTransitions(r, { meId: state.me?.id, supervisor: state.access.supervisor });
    const assign = assignmentOptions(r, { agents: state.agents, meId: state.me?.id, canAssign: state.access.can_assign });
    const problemField = r.kind === 'issue' ? 'problem' : 'summary';

    $('rlDetail').innerHTML = `
      <div class="rl-inline"><button type="button" class="btn btn-secondary" id="rlBackToList">رجوع للقائمة</button></div>
      <div>
        <div class="rl-item-meta">
          <span class="rl-pill">${esc(KIND_META[r.kind]?.label || r.kind)}</span>
          <span class="rl-pill">${esc(STATUS_LABELS[r.status] || r.status)}</span>
          ${r.category ? `<span class="rl-pill rl-pill--accent">${esc(CATEGORY_META[r.category]?.label)}</span>` : ''}
          ${r.overdue ? '<span class="rl-pill rl-pill--danger">متأخر</span>' : ''}
        </div>
        <h2 id="rlRecordTitle">${esc(r.title)}</h2>
        ${deadline ? `<p class="rl-muted">محتوى المصادر بيتحذف تلقائيًا ${esc(fmt(deadline.toISOString()))} (365 يوم من الإغلاق).</p>` : ''}
      </div>

      <form id="rlEdit" class="rl-detail-grid" ${closed ? 'inert' : ''}>
        <label class="rl-field" style="grid-column:1/-1"><span>العنوان</span>
          <input type="text" name="title" maxlength="${LIMITS.title}" value="${esc(r.title)}" required></label>
        <label class="rl-field" style="grid-column:1/-1"><span>${r.kind === 'issue' ? 'وصف المشكلة' : 'الملخص'}</span>
          <textarea name="${problemField}" maxlength="${LIMITS.summary}">${esc(r[problemField] || '')}</textarea></label>
        <label class="rl-field" style="grid-column:1/-1"><span>الخطوة التالية</span>
          <input type="text" name="next_action" maxlength="${LIMITS.nextAction}" value="${esc(r.next_action || '')}"></label>
        <label class="rl-field"><span>الموعد</span>
          <input type="datetime-local" name="due_at" value="${esc(toZonedInput(r.due_at, r.due_tz))}"></label>
        <label class="rl-field"><span>المنطقة الزمنية</span>
          <select name="due_tz" dir="ltr">${[...new Set([r.due_tz || 'Africa/Cairo', ...TIMEZONES])].map((z) =>
              `<option value="${esc(z)}" ${z === (r.due_tz || 'Africa/Cairo') ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select></label>
        <label class="rl-field"><span>الأولوية</span>
          <select name="priority">${Object.entries(PRIORITY_LABELS).map(([k, v]) => `<option value="${k}" ${Number(k) === r.priority ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
        <label class="rl-field"><span>النوع</span>
          <select name="category"><option value="">بدون</option>${RECORD_CATEGORIES.map((c) => `<option value="${c}" ${c === r.category ? 'selected' : ''}>${esc(CATEGORY_META[c].label)}</option>`).join('')}</select></label>
        <div class="rl-inline" style="grid-column:1/-1">
          ${closed ? '<span class="rl-muted">السجل مقفول. أعد فتحه للتعديل.</span>' : '<button type="submit" class="btn btn-primary" id="rlSave">حفظ التعديلات</button>'}
          <span class="rl-error" id="rlEditError"></span>
        </div>
      </form>

      <section aria-labelledby="rlOwnerH">
        <h3 id="rlOwnerH">المالك</h3>
        <p>${esc(agentName(r.owner_id))}${r.team_id ? ` · فريق ${esc(teamName(r.team_id))}` : ''}</p>
        ${assign.editable ? `<div class="rl-inline" id="rlAssign">
            <label class="rl-field"><span>المالك الجديد</span><select id="rlAssignOwner">${assign.owners.map((o) =>
                `<option value="${esc(o.value)}" ${o.value === (r.owner_id || '') ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>
            ${assign.teamEditable ? `<label class="rl-field"><span>الفريق</span><select id="rlAssignTeam"><option value="">بدون فريق</option>${state.teams.map((t) =>
                `<option value="${esc(t.id)}" ${t.id === r.team_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>` : ''}
            <button type="button" class="btn btn-secondary" id="rlAssignBtn">تغيير المالك</button></div>
            ${state.access.can_assign ? '' : '<p class="rl-muted">تقدر تاخد السجل لنفسك أو تسيبه من غير مالك. النقل لموظف تاني للمشرفين ومن عنده صلاحية إسناد.</p>'}` : ''}
      </section>

      ${transitions.length ? `<section aria-labelledby="rlStatusH"><h3 id="rlStatusH">الحالة</h3>
        <div class="rl-inline">${transitions.map((t) => `<button type="button" class="btn btn-secondary" data-to="${t.to}">${esc(t.label)}</button>`).join('')}</div></section>` : ''}

      <section aria-labelledby="rlSourcesH">
        <h3 id="rlSourcesH">المصادر (${state.current.sources.length})</h3>
        ${state.current.sources.length ? `<ul class="rl-sources">${state.current.sources.map((s) => sourceHtml(s, { closed, version: r.version })).join('')}</ul>`
            : '<p class="rl-muted">مفيش رسائل مرفقة. أرفق رسائل من صندوق الرسائل: «سجل استمرارية» ← «إرفاق بسجل موجود».</p>'}
        ${state.access.trash && !closed && state.current.sources.length ? '<p class="rl-muted">«إزالة» بتنقل الرسالة للمحذوفات وتقدر ترجّعها.</p>' : ''}
      </section>

      ${removed.length ? `<section aria-labelledby="rlRemovedH" class="rl-removed" id="rlRemoved">
        <div class="rl-section-head"><h3 id="rlRemovedH">المحذوفات (${removed.length})</h3>
          ${state.access.owner ? '<button type="button" class="btn btn-danger rl-btn-sm" id="rlPurgeRecord">تفريغ المحذوفات</button>' : ''}</div>
        <ul class="rl-sources">${removed.map((s) => sourceHtml(s, { mode: 'removed', closed, version: r.version })).join('')}</ul>
        ${closed ? '<p class="rl-muted">السجل مقفول. أعد فتحه عشان تسترجع رسالة.</p>' : ''}
      </section>` : ''}

      <section aria-labelledby="rlEventsH">
        <h3 id="rlEventsH">السجل</h3>
        <ul class="rl-events">${state.events.map((e) => `<li>${esc(fmt(e.created_at))} · ${esc(agentName(e.actor_id))} ${esc(eventLabel(e))}</li>`).join('')}</ul>
      </section>`;
}

function patchFromForm(form, record) {
    const fd = new FormData(form);
    const patch = {};
    for (const k of ['title', 'summary', 'problem', 'next_action']) {
        if (!fd.has(k)) continue;
        const v = String(fd.get(k));
        if (v !== (record[k] || '')) patch[k] = v;
    }
    const pr = Number(fd.get('priority'));
    if (pr !== record.priority) patch.priority = pr;
    const cat = String(fd.get('category') || '') || null;
    if (cat !== (record.category || null)) patch.category = cat;
    const at = String(fd.get('due_at') || '');
    const tz = String(fd.get('due_tz') || '').trim();
    if (at !== toZonedInput(record.due_at, record.due_tz) || (at && tz !== record.due_tz)) {
        patch.due = at ? { at: at.length === 16 ? `${at}:00` : at, tz } : null;
    }
    return patch;
}

// رسائل أوضح لرفض الخادم المتوقع؛ الخادم هو اللي بيقرر، ده عرض بس.
const INACTIVE_STAFF = 'حسابه مش نشط (مش مكمّل التحقق من الحساب أو محظور)';
function friendlyError(err) {
    if (err?.code === 'validation_failed' && err.reason === 'not_eligible') {
        if (err.field === 'user_id') return `الموظف ده ${INACTIVE_STAFF}، فمينفعش ياخد صلاحية الإسناد. فعّل حسابه الأول.`;
        if (err.field === 'owner_id') return `الموظف ده ${INACTIVE_STAFF}، فمينفعش يبقى مالك للسجل.`;
    }
    if (err?.code === 'forbidden' && err.field === 'owner') {
        return 'المسح النهائي وصلاحية الإسناد لحساب مالك المنصة بس.';
    }
    if (err?.code === 'forbidden' && (err.field === 'owner_id' || err.field === 'team_id')) {
        return 'مش مسموح لك تنقل السجل لموظف تاني أو لفريق. تقدر تاخده لنفسك أو تسيبه من غير مالك.';
    }
    return err?.message || 'حصل خطأ';
}

async function act(fn, okText) {
    if (state.busy) return;
    state.busy = true;
    try {
        const result = await fn();
        toast(okText);
        if (result?.access === 'lost') {
            state.current = null;
            $('rlDetail').innerHTML = '<p class="rl-empty">السجل اتنقل ومبقاش ظاهر ليك.</p>';
        } else if (result?.record?.id) {
            await openRecord(result.record.id, { push: false });
        }
        await reloadList();
        renderTrash();
    } catch (err) {
        toast(friendlyError(err), 'err');
        if (err.code === 'version_conflict' && state.current?.record?.id) await openRecord(state.current.record.id, { push: false });
    } finally {
        state.busy = false;
    }
}

// ═════════════════════════════════════════════════════════════
// المحذوفات (كل السجلات اللي تشوفها)
// ═════════════════════════════════════════════════════════════
async function renderTrash() {
    const box = $('rlTrash');
    if (!state.access.trash) { box.hidden = true; return; }
    try {
        state.trash = await listRemoved() || [];
    } catch (err) {
        box.hidden = false;
        $('rlTrashBody').innerHTML = `<p class="rl-error">${esc(friendlyError(err))}</p>`;
        return;
    }
    box.hidden = !state.trash.length;
    $('rlTrashCount').textContent = state.trash.length ? `(${state.trash.length})` : '';
    $('rlPurgeAll').hidden = !state.access.owner || !state.trash.length;
    $('rlTrashBody').innerHTML = `<ul class="rl-sources">${state.trash.map((x) => `<li class="rl-trash-item">
        <button type="button" class="rl-trash-record" data-open-record="${esc(x.record.id)}">${esc(x.record.title)}
          ${isClosed(x.record.status) ? `<span class="rl-pill">${esc(STATUS_LABELS[x.record.status])}</span>` : ''}</button>
        <ul class="rl-sources">${sourceHtml(x.source, { mode: 'removed', closed: isClosed(x.record.status), version: x.record.version, recordId: x.record.id })}</ul>
      </li>`).join('')}</ul>`;
}

// ═════════════════════════════════════════════════════════════
// صلاحية الإسناد (لمالك المنصة، 076)
// ═════════════════════════════════════════════════════════════
async function renderAssigners() {
    const box = $('rlAssigners');
    // 076: المنح والسحب للمالك. قبل 076 كانوا للمشرف (074).
    if (!(state.access.trash ? state.access.owner : state.access.supervisor)) { box.hidden = true; return; }
    box.hidden = false;
    try {
        state.assigners = await listAssigners();
    } catch (err) {
        $('rlAssignersBody').innerHTML = `<p class="rl-error">${esc(err.message)}</p>`;
        return;
    }
    const granted = new Set(state.assigners.map((a) => a.user_id));
    const candidates = state.agents.filter((a) => !granted.has(a.id) && !a.is_elevated);
    $('rlAssignersBody').innerHTML = `
      ${state.assigners.length ? `<ul class="rl-assigners">${state.assigners.map((a) => `<li>
          <span>${esc(a.full_name || a.email || 'موظف')}${a.eligible ? '' : ' <small class="rl-pill rl-pill--danger">غير نشط</small>'}</span>
          <button type="button" class="btn btn-secondary" data-revoke="${esc(a.user_id)}">سحب الصلاحية</button></li>`).join('')}</ul>`
        : '<p class="rl-muted">مفيش حد عنده صلاحية إسناد غير المشرفين.</p>'}
      ${candidates.length ? `<div class="rl-inline"><label class="rl-field"><span>منح صلاحية الإسناد لـ</span>
          <select id="rlGrantUser">${candidates.map((a) => `<option value="${esc(a.id)}">${esc(a.full_name || a.email)}</option>`).join('')}</select></label>
          <button type="button" class="btn btn-primary" id="rlGrantBtn">منح</button></div>` : ''}`;
}

// ═════════════════════════════════════════════════════════════
// الربط
// ═════════════════════════════════════════════════════════════
function wire() {
    for (const [id, key] of [['rlFilterStatus', 'status'], ['rlFilterOwner', 'owner'], ['rlFilterCategory', 'category']]) {
        $(id).addEventListener('change', (e) => { state.filters[key] = e.target.value; reloadList(); });
    }
    $('rlList').addEventListener('click', (e) => {
        const b = e.target.closest('[data-open]');
        if (b) openRecord(b.dataset.open);
    });
    $('rlDetail').addEventListener('submit', (e) => {
        if (e.target.id !== 'rlEdit') return;
        e.preventDefault();
        const r = state.current.record;
        const patch = patchFromForm(e.target, r);
        if (!Object.keys(patch).length) { toast('مفيش تغيير'); return; }
        act(() => updateRecord(r.id, patch, r.version), 'اتحفظ');
    });
    $('rlDetail').addEventListener('click', async (e) => {
        const r = state.current?.record;
        const el = e.target.closest('button');
        if (el?.id === 'rlBackToList') return closeRecord();
        if (!el || !r) return undefined;
        if (el.id === 'rlAssignBtn') {
            const owner = $('rlAssignOwner').value || null;
            const team = $('rlAssignTeam') ? ($('rlAssignTeam').value || null) : r.team_id;
            const ok = await relayConfirm(owner && owner !== state.me?.id
                ? { title: 'نقل السجل', message: `السجل هيتنقل لـ ${agentName(owner)}، وهيظهر عنده في سجلاته.`, confirmText: 'نقل السجل' }
                : { title: 'تغيير المالك', message: owner ? 'السجل هيبقى باسمك.' : 'السجل هيفضل من غير مالك لحد ما حد ياخده.', confirmText: 'تأكيد' });
            if (!ok) return undefined;
            return act(() => assignRecord(r.id, owner, team, r.version), 'اتغيّر المالك');
        }
        if (el.dataset.to) {
            const t = allowedTransitions(r, { meId: state.me?.id, supervisor: state.access.supervisor }).find((x) => x.to === el.dataset.to);
            let details = {};
            if (!t) return undefined;
            if (t.needs) {
                const text = await relayPrompt({
                    title: t.label, label: t.prompt, confirmText: t.label, danger: t.to === 'cancelled',
                    message: t.to === 'cancelled' ? 'السجل هيتقفل ومش هيتعدّل تاني إلا لو اتفتح من جديد.' : '',
                });
                if (!text) return undefined;
                details = { [t.needs]: text };
            }
            return act(() => transitionRecord(r.id, t.to, details, r.version), 'اتغيّرت الحالة');
        }
        if (el.id === 'rlPurgeRecord') {
            const n = (state.current.removed || []).length;
            if (!await relayConfirm({ title: 'تفريغ المحذوفات', danger: true, confirmText: 'مسح نهائي',
                message: `${n} رسالة هتتمسح من السجل ده نهائيًا. مفيش رجوع، ومش هتقدر ترفقها تاني.` })) return undefined;
            return act(async () => { await purgeRemoved(r.id); return getRecord(r.id); }, 'اتمسحت المحذوفات');
        }
        if (el.dataset.redact) {
            const ok = await relayConfirm({
                title: 'حذف محتوى المصدر نهائيًا', danger: true, confirmText: 'حذف نهائي',
                message: 'مفيش رجوع: المحتوى مش هيرجع حتى لو أرفقت نفس الرسالة تاني.',
            });
            if (!ok) return undefined;
            return act(() => purgeSource(el.dataset.redact), 'اتحذف المحتوى');
        }
        return sourceAction(el);
    });
    $('rlTrash').addEventListener('click', async (e) => {
        const el = e.target.closest('button');
        if (!el) return undefined;
        if (el.dataset.openRecord) return openRecord(el.dataset.openRecord);
        if (el.id === 'rlPurgeAll') {
            if (!await relayConfirm({ title: 'تفريغ كل المحذوفات', danger: true, confirmText: 'مسح الكل نهائيًا',
                message: `${state.trash.length} رسالة في المحذوفات هتتمسح من كل السجلات نهائيًا. مفيش رجوع.` })) return undefined;
            return act(async () => {
                await purgeRemoved(null);
                return state.current?.record?.id ? getRecord(state.current.record.id) : null;
            }, 'اتفرّغت المحذوفات');
        }
        return sourceAction(el);
    });
    $('rlAssigners').addEventListener('click', async (e) => {
        const el = e.target.closest('button');
        if (!el) return;
        try {
            if (el.id === 'rlGrantBtn') {
                const id = $('rlGrantUser').value;
                if (!await relayConfirm({ title: 'منح صلاحية الإسناد', confirmText: 'منح الصلاحية',
                    message: `${agentName(id)} هيقدر يسند السجلات لأي موظف أو فريق.` })) return;
                await grantAssigner(id);
                toast('اتمنحت الصلاحية');
            } else if (el.dataset.revoke) {
                if (!await relayConfirm({ title: 'سحب صلاحية الإسناد', danger: true, confirmText: 'سحب الصلاحية',
                    message: 'السجلات اللي أسندها قبل كده هتفضل زي ما هي.' })) return;
                await revokeAssigner(el.dataset.revoke);
                toast('اتسحبت الصلاحية');
            } else return;
        } catch (err) {
            toast(friendlyError(err), 'err');
        }
        renderAssigners();
    });
}

function closeRecord() {
    state.current = null;
    $('rlPage').classList.remove('has-record');
    $('rlDetail').innerHTML = '<p class="rl-empty">اختار سجل من القائمة.</p>';
    const url = new URL(location.href);
    url.searchParams.delete('record');
    history.replaceState(null, '', url);
    renderList();
}

async function boot() {
    initSidebar();
    const user = await checkAdminAuth();
    if (!user) return;
    updateAdminUI(user);
    state.me = user;
    state.access = await loadRelayAccess();
    if (!state.access.member || !state.access.enabled) {
        $('rlBanner').hidden = false;
        $('rlBanner').textContent = !state.access.member
            ? 'Relay لفريق الدعم. حسابك دلوقتي مش في سياق إداري نشط — بدّل للإدارة من مبدّل الواجهة وحدّث الصفحة.'
            : 'Relay مش مفعّل حاليًا.';
        $('rlPage').hidden = true;
        return;
    }
    $('rlFilterCategory').innerHTML = '<option value="">كل الأنواع</option>'
        + RECORD_CATEGORIES.map((c) => `<option value="${c}">${esc(CATEGORY_META[c].label)}</option>`).join('');
    [state.agents, state.teams] = await Promise.all([loadAgents(), loadTeams()]);
    wire();
    await reloadList();
    const deep = new URLSearchParams(location.search).get('record');
    if (deep) await openRecord(deep, { push: false });
    renderTrash();
    renderAssigners();
}

boot();
