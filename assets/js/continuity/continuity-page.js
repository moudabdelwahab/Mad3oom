/**
 * Continuity — صفحة السجلات (admin/continuity.html، المرحلة C).
 *
 * القائمة (continuity_list: بلا مقتطفات) وتفاصيل سجل (continuity_get: المقتطف يظهر فقط لو
 * الخادم قرر في القراءة دي إن عندك وصول حالي للمحادثة — C3). التعديل والإسناد
 * والانتقالات والحجب كلها عبر الـRPC، والأدوات المعروضة تعكس continuity_my_access
 * وقواعد 074/076 للعرض فقط: الخادم هو اللي يرفض.
 *
 * 076: «إزالة» رسالة من سجل تنقلها للمحذوفات (ترجع بـ«استرجاع»). المسح النهائي
 * وتفريغ المحذوفات وصلاحية الإسناد لحساب مالك المنصة بس (access.owner).
 *
 * 079: «تاريخ الإغلاق» يعرض كل إغلاق وإعادة فتح كما أرسلها الخادم (closures). إعادة
 * الفتح بسبب إلزامي، وموعد جديد إلزامي لمتابعة موعدها فات (reopenRequirements). لو
 * الخادم أقدم من 079 (لا closures) القسم يختفي ويفضل كل شيء يعمل.
 *
 * نافذة مستقلة (admin/continuity-record.html?id=<uuid>، body[data-ct-mode=standalone]):
 * نفس الكود ونفس الـRPC ونفس الصلاحيات، لسجل واحد بلا قائمة ولا لوحات جانبية. الرابط
 * لا يمنح أي وصول: الخادم يقرر في continuity_get كالعادة، والرابط غير الصالح لا ينادي شيئًا.
 */
import { initSidebar } from '/assets/js/admin/sidebar.js';
import { checkAdminAuth, updateAdminUI } from '/assets/js/admin/auth.js';
import { describeSource, retentionDeadline, LIMITS, validatePolicyPatch } from './continuity-contract.js';
import { continuityConfirm, continuityPrompt, continuityReopen, continuityHandover, continuityNewRecord, continuityShare } from './continuity-dialog.js';
import {
    CATEGORY_META, KIND_META, PRIORITY_LABELS, STATUS_LABELS, EVENT_LABELS, RECORD_CATEGORIES,
    allowedTransitions, assignmentOptions, toZonedInput, describePolicy, reopenRequirements, closureHistory,
    standaloneRecordUrl, isRecordId,
    prepareAttachment, attachmentErrorText, attachmentView, ATTACHMENT_ACCEPT, ATTACHMENT_LIMITS_TEXT,
    HANDOVER_STATE_LABELS, HANDOVER_CANCEL_LABELS, handoverActions, handoverTargets, handoverErrorText,
    recordPermissions, editNotice, editRefusalText, ISSUE_FIELDS, describeEvent, buildManualRequest, manualMissing, ownerOptions,
    CAPABILITY_LABELS, POLICY_NUMBER_FIELDS, POLICY_BOOL_FIELDS, policyPatchFromForm,
    isScopedHandover, grantRemainingText, shareExpiryText, grantStatusText, canManageGrant, buildShareScope, changedSinceReviewText,
    COLLAB_FIELDS, PROPOSAL_STATE_LABELS, grantAbilities, grantActionsText, collabPatchFromForm, proposalSummary,
    REMINDER_KIND_LABELS, reminderRowText,
} from './continuity-model.js';
import {
    loadContinuityAccess, listRecords, getRecord, createRecord, updateRecord, assignRecord, transitionRecord, loadEvents, setPolicies,
    removeSource, restoreSource, listRemoved, purgeSource, purgeRemoved,
    listAssigners, grantAssigner, revokeAssigner, loadAgents, loadTeams, getPolicies,
    removeAttachment, restoreAttachment, purgeAttachment, signAttachment,
    requestHandover, decideHandover, cancelHandover, myHandovers, handoversForRecord,
    requestShare, reviewHandover, decideReviewed, revokeShare, amendShare, respondShare, sharedRecord, shareScope, previewRecipient,
    sharedWithMe, signSharedAttachment,
    addNote, notesFor, proposeShared, proposalsFor, decideProposal, withdrawProposal, updateShared, delegationSettings,
    remindersFor,
} from './continuity-data.js';
import { uploadAttachment } from './continuity-upload.js';
import { VoiceRecorder, isVoiceRecordingSupported } from '/assets/js/voice-recorder.js';
import { ATTACHMENT_KINDS, formatBytes } from './continuity-media.js';
import { CONTINUITY_ICONS } from './continuity-icons.js';

const $ = (id) => document.getElementById(id);
const STANDALONE = document.body?.dataset.ctMode === 'standalone';
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
    // رفع جارٍ أو فاشل: { recordId, file, kind, mime, key, progress, error, controller }
    upload: null,
    // تسجيل صوتي: { recordId, phase: requesting|recording|review|error, elapsed, bytes, blob, mime, url, message }
    rec: null,
    // التسليم (081): تاريخ السجل المفتوح، والطلبات الواردة لي
    handovers: [], incoming: [],
    // المشاركة المحدودة (091): installed = القاعدة فيها 091؛ active/proposals = المشاركات معي
    shared: { installed: false, active: [], proposals: [] },
    // 093: إعدادات المشاركة (التعاون مسموح؟)، والعرض المشترك المفتوح، وملاحظات واقتراحات السجل المفتوح
    delegation: null, sharedView: null, notes: null, proposals: null,
    // 094: تذكيرات السجل المفتوح (null قبل 094)
    reminders: null,
    // السجل (الأحداث): هل فيه أقدم من المعروض
    eventsMore: false,
};
const EVENTS_PAGE = 50;
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
    if (STANDALONE) return;
    $('ctList').innerHTML = '<li class="ct-empty">بيحمّل…</li>';
    try {
        state.records = await listRecords(filtersToRpc()) || [];
    } catch (err) {
        state.records = [];
        $('ctList').innerHTML = `<li class="ct-empty">${esc(err.message)}</li>`;
        return;
    }
    renderList();
}

function renderList() {
    if (STANDALONE) return;
    if (!state.records.length) {
        $('ctList').innerHTML = '<li class="ct-empty" id="ctListEmpty">مفيش سجلات بالفلاتر دي. السجلات بتتعمل من صندوق الرسائل: افتح محادثة واضغط «سجل استمرارية».</li>';
        return;
    }
    $('ctList').innerHTML = state.records.map((r) => `<li><button type="button" class="ct-item ${state.current?.record?.id === r.id ? 'is-on' : ''}" data-open="${esc(r.id)}">
        <span class="ct-item-title">${esc(r.title)}</span>
        <span class="ct-item-meta">
          <span class="ct-pill">${esc(STATUS_LABELS[r.status] || r.status)}</span>
          ${r.category ? `<span class="ct-pill ct-pill--accent">${esc(CATEGORY_META[r.category]?.label || r.category)}</span>` : ''}
          ${r.overdue ? '<span class="ct-pill ct-pill--danger">متأخر</span>' : ''}
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
    if (state.rec && state.rec.recordId !== id) resetRecorder();
    $('ctDetail').innerHTML = '<p class="ct-empty">بيحمّل…</p>';
    $('ctPage').classList.add('has-record');
    try {
        const collabReady = Boolean(state.delegation);
        const [full, events, handovers, notes, proposals, reminders] = await Promise.all([getRecord(id), loadEvents(id).catch(() => []),
            handoversOn() ? handoversForRecord(id).catch(() => []) : Promise.resolve([]),
            collabReady ? notesFor(id).catch(() => null) : Promise.resolve(null),
            collabReady ? proposalsFor(id).catch(() => null) : Promise.resolve(null),
            remindersFor(id).catch(() => null)]);
        state.reminders = reminders;
        state.sharedView = null;
        state.notes = Array.isArray(notes) ? notes : null;
        state.proposals = Array.isArray(proposals) ? proposals : null;
        state.current = full;
        state.events = events || [];
        state.eventsMore = state.events.length >= EVENTS_PAGE;
        state.handovers = Array.isArray(handovers) ? handovers : [];
    } catch (err) {
        state.current = null;
        const notFound = err.code === 'not_found';
        $('ctDetail').innerHTML = `<p class="ct-empty" id="${notFound ? 'ctNotFound' : 'ctLoadError'}">${esc(notFound ? 'السجل غير موجود أو مش مسموح لك تشوفه.' : friendlyError(err))}</p>
          ${STANDALONE ? `<div class="ct-inline">${notFound ? '' : `<button type="button" class="btn btn-primary" id="ctRetry" data-id="${esc(id)}">حاول تاني</button>`}
            <a class="btn btn-secondary" href="/admin/continuity.html">صفحة الاستمرارية</a></div>` : ''}`;
        return;
    }
    if (push && !STANDALONE) {
        const url = new URL(location.href);
        url.searchParams.set('record', id);
        history.replaceState(null, '', url);
    }
    renderRecord();
    renderList();
}

const isClosed = (status) => status === 'resolved' || status === 'cancelled';
/** 087: ما يقدر المنادي يعمله كما قرره الخادم في هذه القراءة (قبل 087: من يرى يعدّل). */
const perms = () => recordPermissions(state.current, { attachmentsOn: attachmentsOn() });

/** mode: 'main' (مصادر السجل) أو 'removed' (المحذوفات). closed = السجل مقفول. */
function sourceHtml(s, { mode = 'main', closed = false, version = null, recordId = null, canManageSources = true } = {}) {
    const d = describeSource(s);
    const data = `data-source="${esc(s.id)}"${version != null ? ` data-version="${esc(version)}"` : ''}${recordId ? ` data-record="${esc(recordId)}"` : ''}`;
    let actions = '';
    if (mode === 'main' && !state.access.trash) {
        // قبل 076: الحجب النهائي كما في 074 (المالك أو المنشئ أو المشرف).
        if (d.state === 'visible' && canRedactLegacy()) actions = `<button type="button" class="btn btn-secondary ct-btn-sm" data-redact="${esc(s.id)}">حذف المحتوى</button>`;
    } else if (mode === 'main' && !closed && canManageSources) {
        actions = `<button type="button" class="btn btn-secondary ct-btn-sm" data-remove ${data}>إزالة</button>`;
    } else if (mode === 'removed') {
        actions = `${closed || !canManageSources ? '' : `<button type="button" class="btn btn-secondary ct-btn-sm" data-restore ${data}>استرجاع</button>`}
            ${state.access.owner ? `<button type="button" class="btn btn-danger ct-btn-sm" data-purge ${data}>مسح نهائي</button>` : ''}`;
    }
    const head = `<div class="ct-source-head"><span>#${s.position}</span>
        ${d.state === 'visible' && d.senderLabel ? `<b>${esc(d.senderLabel)}</b>` : ''}
        ${d.state === 'visible' && s.original_created_at ? `<span>${esc(fmt(s.original_created_at))}</span>` : ''}
        ${d.deletedAtSource ? '<span class="ct-pill">اتحذفت من المحادثة</span>' : ''}
        ${d.editedAfterCapture ? '<span class="ct-pill">اتعدّلت بعد الإرفاق</span>' : ''}
        <span class="ct-spacer"></span>
        ${d.state === 'visible' && s.chat_session_id ? `<a href="/admin/inbox.html?session=${encodeURIComponent(s.chat_session_id)}">فتح المحادثة</a>` : ''}
      </div>`;
    const foot = `${mode === 'removed' && s.removed_at
        ? `<small class="ct-removed-by">شالها ${esc(agentName(s.removed_by))} · ${esc(fmt(s.removed_at))}</small>` : ''}
        ${actions ? `<div class="ct-source-actions">${actions}</div>` : ''}`;
    if (d.state === 'visible') return `<li class="ct-source" ${data}>${head}<p>${esc(d.excerpt)}</p>${foot}</li>`;
    return `<li class="ct-source is-hidden" ${data} data-state="${d.state}">${head}<p>${CONTINUITY_ICONS.lock}${esc(d.label)}</p>${foot}</li>`;
}

const canRedactLegacy = () => {
    const r = state.current?.record;
    return Boolean(r && (state.access.supervisor || r.owner_id === state.me?.id || r.created_by === state.me?.id));
};

const eventLabel = (e) => EVENT_LABELS[e.kind === 'source_redacted' && e.payload?.purged ? 'source_purged' : e.kind] || e.kind;
function eventHtml(e) {
    const detail = describeEvent(e, { name: agentName });
    return `<li data-event="${esc(e.id)}">${esc(fmt(e.created_at))} · ${esc(e.actor_id ? agentName(e.actor_id) : 'النظام')} ${esc(eventLabel(e))}${
        detail ? ` <span class="ct-muted">(${esc(detail)})</span>` : ''}</li>`;
}

async function loadOlderEvents(r) {
    const last = state.events[state.events.length - 1];
    if (!last) return;
    try {
        const older = await loadEvents(r.id, last.id) || [];
        state.events = [...state.events, ...older];
        state.eventsMore = older.length >= EVENTS_PAGE;
    } catch (err) {
        toast(friendlyError(err), 'err');
        return;
    }
    const list = $('ctEvents');
    if (!list) return;
    list.innerHTML = state.events.map(eventHtml).join('');
    if (!state.eventsMore) $('ctEventsMore')?.remove();
}

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
        if (!await continuityConfirm({ title: 'مسح الرسالة نهائيًا', danger: true, confirmText: 'مسح نهائي',
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
    const p = perms();
    const notice = editNotice(p, agentName(r.owner_id));
    const readOnly = !p.edit;

    $('ctDetail').innerHTML = `
      <div class="ct-inline">${STANDALONE
          ? `<a class="btn btn-secondary" id="ctOpenInPage" href="/admin/continuity.html?record=${encodeURIComponent(r.id)}">فتح في صفحة الاستمرارية</a>`
          : `<button type="button" class="btn btn-secondary" id="ctBackToList">رجوع للقائمة</button>
             ${isRecordId(r.id) ? `<a class="btn btn-secondary" id="ctOpenStandalone" href="${esc(standaloneRecordUrl(r.id))}" target="_blank" rel="noopener noreferrer">فتح السجل في نافذة مستقلة</a>` : ''}`}</div>
      <div>
        <div class="ct-item-meta">
          <span class="ct-pill">${esc(KIND_META[r.kind]?.label || r.kind)}</span>
          <span class="ct-pill">${esc(STATUS_LABELS[r.status] || r.status)}</span>
          ${r.category ? `<span class="ct-pill ct-pill--accent">${esc(CATEGORY_META[r.category]?.label)}</span>` : ''}
          ${r.overdue ? '<span class="ct-pill ct-pill--danger">متأخر</span>' : ''}
        </div>
        <h2 id="ctRecordTitle">${esc(r.title)}</h2>
        ${deadline ? `<p class="ct-muted">محتوى المصادر بيتحذف تلقائيًا ${esc(fmt(deadline.toISOString()))} (365 يوم من الإغلاق).</p>` : ''}
      </div>

      ${notice && !closed ? `<div class="ct-banner ct-readonly" id="ctReadOnly" role="status"><span>${esc(notice)}</span>
          ${p.claim ? '<button type="button" class="btn btn-primary ct-btn-sm" id="ctClaim">خد السجل لنفسك</button>' : ''}</div>` : ''}
      <form id="ctEdit" class="ct-detail-grid" ${readOnly ? 'inert aria-disabled="true"' : ''}>
        <label class="ct-field" style="grid-column:1/-1"><span>العنوان</span>
          <input type="text" name="title" maxlength="${LIMITS.title}" value="${esc(r.title)}" required></label>
        ${r.kind === 'issue' ? ISSUE_FIELDS.map((f) => `<label class="ct-field" style="grid-column:1/-1"><span>${esc(f.label)}</span>
          <textarea name="${f.key}" maxlength="${LIMITS.summary}" ${f.required ? 'required' : ''}>${esc(r[f.key] || '')}</textarea></label>`).join('')
          : `<label class="ct-field" style="grid-column:1/-1"><span>الملخص</span>
          <textarea name="summary" maxlength="${LIMITS.summary}">${esc(r.summary || '')}</textarea></label>`}
        <label class="ct-field" style="grid-column:1/-1"><span>الخطوة التالية</span>
          <input type="text" name="next_action" maxlength="${LIMITS.nextAction}" value="${esc(r.next_action || '')}"></label>
        <label class="ct-field"><span>الموعد</span>
          <input type="datetime-local" name="due_at" value="${esc(toZonedInput(r.due_at, r.due_tz))}"></label>
        <label class="ct-field"><span>المنطقة الزمنية</span>
          <select name="due_tz" dir="ltr">${[...new Set([r.due_tz || 'Africa/Cairo', ...TIMEZONES])].map((z) =>
              `<option value="${esc(z)}" ${z === (r.due_tz || 'Africa/Cairo') ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select></label>
        <label class="ct-field"><span>الأولوية</span>
          <select name="priority">${Object.entries(PRIORITY_LABELS).map(([k, v]) => `<option value="${k}" ${Number(k) === r.priority ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
        <label class="ct-field"><span>النوع</span>
          <select name="category"><option value="">بدون</option>${RECORD_CATEGORIES.map((c) => `<option value="${c}" ${c === r.category ? 'selected' : ''}>${esc(CATEGORY_META[c].label)}</option>`).join('')}</select></label>
        <div class="ct-inline" style="grid-column:1/-1">
          ${closed ? '<span class="ct-muted">السجل مقفول. أعد فتحه للتعديل.</span>' : readOnly ? '' : '<button type="submit" class="btn btn-primary" id="ctSave">حفظ التعديلات</button>'}
          <span class="ct-error" id="ctEditError"></span>
        </div>
      </form>

      <section aria-labelledby="ctOwnerH">
        <h3 id="ctOwnerH">المالك</h3>
        <p>${esc(agentName(r.owner_id))}${r.team_id ? ` · فريق ${esc(teamName(r.team_id))}` : ''}</p>
        ${assign.editable ? `<div class="ct-inline" id="ctAssign">
            <label class="ct-field"><span>المالك الجديد</span><select id="ctAssignOwner">${assign.owners.map((o) =>
                `<option value="${esc(o.value)}" ${o.value === (r.owner_id || '') ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>
            ${assign.teamEditable ? `<label class="ct-field"><span>الفريق</span><select id="ctAssignTeam"><option value="">بدون فريق</option>${state.teams.map((t) =>
                `<option value="${esc(t.id)}" ${t.id === r.team_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>` : ''}
            <button type="button" class="btn btn-secondary" id="ctAssignBtn">تغيير المالك</button></div>
            ${state.access.can_assign ? '' : '<p class="ct-muted">تقدر تاخد السجل لنفسك أو تسيبه من غير مالك. النقل لموظف تاني للمشرفين ومن عنده صلاحية إسناد.</p>'}` : ''}
        ${handoverHtml(r)}
        ${collabRecordHtml(r)}
        ${remindersHtml(r)}
      </section>

      ${transitions.length ? `<section aria-labelledby="ctStatusH"><h3 id="ctStatusH">الحالة</h3>
        <div class="ct-inline">${transitions.map((t) => `<button type="button" class="btn btn-secondary" data-to="${t.to}">${esc(t.label)}</button>`).join('')}</div></section>` : ''}

      <section aria-labelledby="ctSourcesH">
        <h3 id="ctSourcesH">المصادر (${state.current.sources.length})</h3>
        ${state.current.sources.length ? `<ul class="ct-sources">${state.current.sources.map((s) => sourceHtml(s, { closed, version: r.version, canManageSources: p.sources })).join('')}</ul>`
            : '<p class="ct-muted">مفيش رسائل مرفقة. أرفق رسائل من صندوق الرسائل: «سجل استمرارية» ← «إرفاق بسجل موجود».</p>'}
        ${state.access.trash && !closed && p.sources && state.current.sources.length ? '<p class="ct-muted">«إزالة» بتنقل الرسالة للمحذوفات وتقدر ترجّعها.</p>' : ''}
      </section>

      ${removed.length ? `<section aria-labelledby="ctRemovedH" class="ct-removed" id="ctRemoved">
        <div class="ct-section-head"><h3 id="ctRemovedH">المحذوفات (${removed.length})</h3>
          ${state.access.owner ? '<button type="button" class="btn btn-danger ct-btn-sm" id="ctPurgeRecord">تفريغ المحذوفات</button>' : ''}</div>
        <ul class="ct-sources">${removed.map((s) => sourceHtml(s, { mode: 'removed', closed, version: r.version, canManageSources: p.sources })).join('')}</ul>
        ${closed ? '<p class="ct-muted">السجل مقفول. أعد فتحه عشان تسترجع رسالة.</p>' : ''}
      </section>` : ''}

      ${attachmentsHtml(r, closed)}

      ${closureHtml(state.current.closures)}

      <section aria-labelledby="ctEventsH">
        <h3 id="ctEventsH">السجل</h3>
        <ul class="ct-events" id="ctEvents">${state.events.map(eventHtml).join('')}</ul>
        ${state.eventsMore ? '<button type="button" class="btn btn-secondary ct-btn-sm" id="ctEventsMore">عرض الأقدم</button>' : ''}
      </section>`;
    hydrateAttachments();
}

// ═════════════════════════════════════════════════════════════
// التسليم (081): الملكية تتغير فقط بقبول المستلم؛ الطلب المعلّق لا يمنحه وصولًا
// ═════════════════════════════════════════════════════════════
const handoversOn = () => Boolean(state.access?.capabilities?.handovers);
const pendingHandover = () => (state.handovers || []).find((h) => h.state === 'pending') || null;

function handoverHtml(r) {
    if (!handoversOn()) return '';
    const pending = pendingHandover();
    const acts = handoverActions(r, { meId: state.me?.id, canAssign: state.access.can_assign, enabled: true, pending });
    const grants = (state.handovers || []).filter((h) => isScopedHandover(h) && h.state === 'accepted');
    const past = (state.handovers || []).filter((h) => h.state !== 'pending' && !(isScopedHandover(h) && h.state === 'accepted')).slice(0, 8);
    const scoped = pending && isScopedHandover(pending);
    const who = { meId: state.me?.id, canAssign: state.access.can_assign };
    return `<div class="ct-handover" id="ctHandover">
        ${pending ? `<div class="ct-banner ct-handover-pending" id="ctHandoverPending" role="status">
            <strong>${scoped ? 'طلب مراجعة' : 'طلب تسليم'} لـ ${esc(agentName(pending.to_owner))}</strong> · ${esc(HANDOVER_STATE_LABELS.pending)}
            <p><span class="ct-muted">السبب:</span> <span dir="auto">${esc(pending.reason)}</span></p>
            <p class="ct-muted">${scoped ? 'عرض فقط للي اخترته، والملكية ما بتتغيرش.'
                : `${esc(agentName(r.owner_id))} لسه مسؤول عن السجل لحد ما الطلب يتقبل.`}</p>
            ${acts.canCancel ? `<button type="button" class="btn btn-secondary ct-btn-sm" id="ctHandoverCancel" data-handover="${esc(pending.id)}">إلغاء الطلب</button>` : ''}
          </div>` : ''}
        ${acts.canRequest ? `<div class="ct-inline"><button type="button" class="btn btn-secondary" id="ctHandoverRequest">تسليم السجل لموظف</button>
            ${state.shared.installed ? '<button type="button" class="btn btn-secondary" id="ctShareRequest">مشاركة للمراجعة (عرض فقط)</button>' : ''}</div>` : ''}
        ${grants.length ? `<div id="ctGrants"><h4>مشاركات قائمة (${grants.length})</h4><ul class="ct-sources">${grants.map((h) => `<li class="ct-grant" data-grant="${esc(h.id)}">
            <div class="ct-item-meta"><b>${esc(agentName(h.to_owner))}</b> <span class="ct-pill">${h.mode === 'collab' ? 'تعاون' : 'مراجعة · عرض فقط'}</span>
              <span>${esc(grantRemainingText(h.expires_at))}</span>${h.session_bound ? '<span class="ct-pill">جلسة واحدة</span>' : ''}</div>
            <p><span class="ct-muted">السبب:</span> <span dir="auto">${esc(h.reason)}</span></p>
            ${canManageGrant(h, r, who) ? `<div class="ct-inline">
              <button type="button" class="btn btn-secondary ct-btn-sm" data-grant-amend="${esc(h.id)}">تعديل المشاركة</button>
              <button type="button" class="btn btn-danger ct-btn-sm" data-grant-revoke="${esc(h.id)}">سحب المشاركة</button></div>` : ''}
          </li>`).join('')}</ul></div>` : ''}
        ${past.length ? `<details class="ct-handover-history"><summary>تاريخ التسليم والمشاركة (${past.length})</summary><ul class="ct-events">${past.map((h) =>
            `<li>${esc(fmt(h.revoked_at || h.decided_at || h.created_at))} · ${isScopedHandover(h)
                ? `مراجعة لـ ${esc(agentName(h.to_owner))}: ${esc(grantStatusText(h))}`
                : `${esc(agentName(h.from_owner))} ← ${esc(agentName(h.to_owner))}: ${esc(HANDOVER_STATE_LABELS[h.state] || h.state)}${
                h.cancel_cause ? ` (${esc(HANDOVER_CANCEL_LABELS[h.cancel_cause] || h.cancel_cause)})` : ''}`}</li>`).join('')}</ul></details>` : ''}
      </div>`;
}

/** عناصر السجل المتاحة للاختيار في المشاركة: رسائل نشطة ومرفقات نشطة (أسماء للعرض فقط). */
function shareChoices() {
    const sources = (state.current?.sources || []).map((x) => {
        const d = describeSource(x);
        const text = d.state === 'visible' ? `${d.senderLabel ? `${d.senderLabel}: ` : ''}${String(d.excerpt || '').slice(0, 70)}` : d.label;
        return { id: x.id, label: `#${x.position} ${text}` };
    });
    const attachments = attachmentsOn() ? (state.current?.attachments || []).map((a) => ({ id: a.id, label: attachmentView(a).name })) : [];
    return { sources, attachments };
}

async function shareAction(el, r) {
    if (el.id === 'ctShareRequest') {
        let attempt = null;
        const done = await continuityShare({
            targets: handoverTargets(state.agents, r).filter((t) => t.value !== state.me?.id),
            ...shareChoices(), timezones: TIMEZONES, collab: Boolean(state.delegation?.collab),
            preview: async (to, ids) => {
                const rows = await previewRecipient(r.id, to, ids);
                return Array.isArray(rows) ? rows.filter((x) => !x.visible).length : null;
            },
            submit: async (d) => {
                const scope = buildShareScope(d);
                const sig = JSON.stringify([d.to, d.reason, d.mode, scope]);
                if (!attempt || attempt.sig !== sig) attempt = { sig, key: crypto.randomUUID() };
                try {
                    await requestShare({ recordId: r.id, toOwner: d.to, reason: d.reason.trim(), note: null, version: r.version,
                        idempotencyKey: attempt.key, mode: d.mode === 'collab' ? 'collab' : 'review', scope });
                    return null;
                } catch (err) {
                    return handoverErrorText(err);
                }
            },
        });
        if (done) toast('اتبعت طلب المشاركة. المستلم لازم يراجع ويقبل.');
        await openRecord(r.id, { push: false });
        return true;
    }
    if (el.dataset.grantRevoke) {
        if (!await continuityConfirm({ title: 'سحب المشاركة', danger: true, confirmText: 'سحب',
            message: 'المستلم هيفقد العرض فورًا. التاريخ بيفضل في السجل.' })) return true;
        try {
            await revokeShare(el.dataset.grantRevoke);
            toast('اتسحبت المشاركة');
        } catch (err) {
            toast(handoverErrorText(err), 'err');
        }
        await openRecord(r.id, { push: false });
        return true;
    }
    if (el.dataset.grantAmend) {
        const id = el.dataset.grantAmend;
        let current = null;
        try {
            current = ((await shareScope(id))?.scopes || []).find((x) => x.status === 'approved') || null;
        } catch (err) {
            toast(handoverErrorText(err), 'err');
            return true;
        }
        let result = null;
        const grant = (state.handovers || []).find((x) => x.id === id);
        const done = await continuityShare({
            title: 'تعديل المشاركة', confirmText: 'حفظ', ...shareChoices(), timezones: TIMEZONES,
            mode: grant?.mode === 'collab' ? 'collab' : 'review', collab: Boolean(state.delegation?.collab),
            message: 'التضييق يسري فورًا. أي توسيع (رسائل أو مرفقات أو مدة أكتر) بيتبعت للمستلم يوافق عليه، ولحد ما يوافق يفضل القديم.',
            initial: current && { sources: current.source_ids, attachments: current.attachment_ids,
                actions: (current.actions || []).filter((a) => a !== 'view'), fields: current.editable_fields || [],
                expiryKind: current.expiry?.kind === 'until' ? 'duration' : current.expiry?.kind, minutes: current.expiry?.minutes },
            submit: async (d) => {
                try {
                    result = await amendShare(id, buildShareScope(d));
                    return null;
                } catch (err) {
                    return handoverErrorText(err);
                }
            },
        });
        if (done) toast(result?.scope_change === 'narrowed' ? 'اتضيّقت المشاركة فورًا' : 'اتبعت التوسيع للمستلم يوافق عليه');
        await openRecord(r.id, { push: false });
        return true;
    }
    return false;
}

async function handoverAction(el, r) {
    if (el.id === 'ctHandoverRequest') {
        const got = await continuityHandover({ targets: handoverTargets(state.agents, r),
            message: 'المستلم لازم يقبل. لحد ما يقبل، السجل يفضل مع مالكه الحالي، والمستلم مش هيشوف الرسائل.' });
        if (!got) return true;
        try {
            await requestHandover({ recordId: r.id, toOwner: got.to, reason: got.reason, note: got.note, version: r.version,
                idempotencyKey: crypto.randomUUID() });
            toast('اتبعت طلب التسليم');
        } catch (err) {
            toast(handoverErrorText(err), 'err');
        }
        await openRecord(r.id, { push: false });
        return true;
    }
    if (el.id === 'ctHandoverCancel') {
        if (!await continuityConfirm({ title: 'إلغاء طلب التسليم', confirmText: 'إلغاء الطلب', cancelText: 'رجوع',
            message: 'السجل هيفضل مع مالكه الحالي.' })) return true;
        try {
            await cancelHandover(el.dataset.handover);
            toast('اتلغى طلب التسليم');
        } catch (err) {
            toast(handoverErrorText(err), 'err');
        }
        await openRecord(r.id, { push: false });
        return true;
    }
    return false;
}

/** الطلبات الواردة لي (الصفحة الرئيسية فقط): حزمة للقراءة بلا رسائل، وقبول أو رفض. */
async function renderIncoming() {
    const box = $('ctHandovers');
    if (STANDALONE || !box) return;
    if (!handoversOn()) { box.hidden = true; return; }
    try {
        state.incoming = (await myHandovers())?.incoming || [];
    } catch {
        state.incoming = [];
    }
    box.hidden = !state.incoming.length;
    $('ctHandoversCount').textContent = state.incoming.length ? `(${state.incoming.length})` : '';
    $('ctHandoversBody').innerHTML = `<ul class="ct-sources">${state.incoming.map((h) => {
        const p = h.package || {};
        if (isScopedHandover(h)) return incomingScopedHtml(h, p);
        return `<li class="ct-incoming" data-incoming="${esc(h.id)}">
          <div class="ct-item-meta"><span class="ct-pill">${esc(KIND_META[p.kind]?.label || p.kind || '')}</span>
            <span class="ct-pill">${esc(PRIORITY_LABELS[p.priority] || '')}</span>
            ${p.overdue ? '<span class="ct-pill ct-pill--danger">متأخر</span>' : ''}</div>
          <h4 dir="auto">${esc(p.title)}</h4>
          ${p.next_action ? `<p><span class="ct-muted">الخطوة التالية:</span> <span dir="auto">${esc(p.next_action)}</span></p>` : ''}
          ${p.due_at ? `<p class="ct-muted">الموعد: ${esc(fmt(p.due_at, p.due_tz))}</p>` : ''}
          <p><span class="ct-muted">من ${esc(agentName(h.created_by))} — السبب:</span> <span dir="auto">${esc(h.reason)}</span></p>
          ${h.context_note ? `<p><span class="ct-muted">سياق:</span> <span dir="auto">${esc(h.context_note)}</span></p>` : ''}
          <p class="ct-muted">${esc(p.source_count ?? 0)} رسالة مرفقة · ${esc(p.attachment_count ?? 0)} مرفق — تظهر بعد القبول لو عندك وصول للمحادثة.</p>
          <div class="ct-inline">
            <button type="button" class="btn btn-primary ct-btn-sm" data-accept="${esc(h.id)}" data-version="${esc(p.version)}">قبول</button>
            <button type="button" class="btn btn-secondary ct-btn-sm" data-decline="${esc(h.id)}" data-version="${esc(p.version)}">رفض</button>
          </div></li>`;
    }).join('')}</ul>`;
}

async function incomingAction(el) {
    if (el.dataset.review || el.dataset.declineReview) return incomingReviewAction(el);
    const id = el.dataset.accept || el.dataset.decline;
    if (!id) return;
    const version = Number(el.dataset.version);
    const h = state.incoming.find((x) => x.id === id);
    try {
        if (el.dataset.accept) {
            const res = await decideHandover(id, 'accept', null, version);
            if (res?.accepted) {
                toast('اتقبل التسليم — السجل بقى عندك');
                await reloadList();
                if (h?.record_id) await openRecord(h.record_id);
            } else {
                toast(HANDOVER_CANCEL_LABELS[res?.handover?.cancel_cause] || 'الطلب ده مبقاش متاح', 'err');
            }
        } else {
            const note = await continuityPrompt({ title: 'رفض التسليم', label: 'سبب الرفض', confirmText: 'رفض',
                message: 'السجل هيفضل مع مالكه الحالي.' });
            if (!note) return;
            await decideHandover(id, 'decline', note, version);
            toast('اترفض الطلب');
        }
    } catch (err) {
        toast(handoverErrorText(err), 'err');
    }
    await renderIncoming();
}

/** طلب مراجعة (091): وصف السجل + أعداد ونوع النطاق فقط؛ المحتوى يظهر بعد القبول وفي حدوده. */
function incomingScopedHtml(h, p) {
    const sc = p.scope || {};
    const c = sc.counts || {};
    return `<li class="ct-incoming ct-incoming--review" data-incoming="${esc(h.id)}">
      <div class="ct-item-meta"><span class="ct-pill">${h.mode === 'collab' ? `طلب تعاون · ${esc(grantActionsText(sc.actions || []))}` : 'طلب مراجعة · عرض فقط'}</span>
        <span class="ct-pill">${esc(KIND_META[p.kind]?.label || p.kind || '')}</span>
        ${p.overdue ? '<span class="ct-pill ct-pill--danger">متأخر</span>' : ''}</div>
      <h4 dir="auto">${esc(p.title)}</h4>
      <p><span class="ct-muted">من ${esc(agentName(h.created_by))} — السبب:</span> <span dir="auto">${esc(h.reason)}</span></p>
      <p class="ct-muted">${esc(c.sources ?? 0)} رسالة · ${esc(c.attachments ?? 0)} مرفق · ${esc(shareExpiryText(sc.expiry))}${sc.range ? ' · فترة زمنية محددة' : ''}</p>
      ${c.not_readable ? `<p class="ct-muted">${esc(c.not_readable)} رسالة مش هتشوف نصها لأنك مش مسموح لك تفتح المحادثة.</p>` : ''}
      <p class="ct-muted">السجل يفضل مع مالكه. المشاركة في حدود اللي اتختار بس، وبتتسحب في أي وقت.</p>
      <div class="ct-inline">
        <button type="button" class="btn btn-primary ct-btn-sm" data-review="${esc(h.id)}">مراجعة وقبول</button>
        <button type="button" class="btn btn-secondary ct-btn-sm" data-decline-review="${esc(h.id)}">رفض</button>
      </div></li>`;
}

async function incomingReviewAction(el) {
    const id = el.dataset.review || el.dataset.declineReview;
    try {
        if (el.dataset.declineReview) {
            const note = await continuityPrompt({ title: 'رفض المراجعة', label: 'سبب الرفض', confirmText: 'رفض' });
            if (!note) return;
            await decideReviewed(id, 'decline', note, null);
            toast('اترفض الطلب');
        } else {
            const rv = await reviewHandover(id);
            const sc = rv?.package?.scope || {};
            const c = sc.counts || {};
            if (!await continuityConfirm({ title: 'قبول المراجعة', confirmText: 'قبول',
                message: `هتقدر تشوف ${c.sources ?? 0} رسالة و${c.attachments ?? 0} مرفق من «${rv?.package?.title || ''}»، ${shareExpiryText(sc.expiry)}. المسموح: ${grantActionsText(sc.actions || [])}. الملكية ما بتتغيرش.` })) {
                return;
            }
            const res = await decideReviewed(id, 'accept', null, rv.digest);
            if (res?.accepted) {
                const since = changedSinceReviewText(res.changed_since_review);
                toast(since ? `اتقبلت المراجعة. ${since}` : 'اتقبلت المراجعة');
                await renderShared();
                if (res?.handover?.record_id) await openShared(res.handover.record_id);
            } else {
                toast(HANDOVER_CANCEL_LABELS[res?.handover?.cancel_cause] || 'الطلب ده مبقاش متاح', 'err');
            }
        }
    } catch (err) {
        toast(handoverErrorText(err), 'err');
    }
    await renderIncoming();
}

// ═════════════════════════════════════════════════════════════
// المشاركات معي (091): عرض فقط في حدود النطاق المعتمد؛ الخادم يعيد البوابة في كل قراءة
// ═════════════════════════════════════════════════════════════
async function renderShared() {
    state.shared = handoversOn() ? await sharedWithMe() : { installed: false, active: [], proposals: [] };
    const box = $('ctShared');
    if (STANDALONE || !box) return;
    const { active, proposals } = state.shared;
    box.hidden = !state.shared.installed || (!active.length && !proposals.length);
    if (box.hidden) return;
    $('ctSharedCount').textContent = `(${active.length})`;
    $('ctSharedBody').innerHTML = `${proposals.map((x) => `<div class="ct-banner" data-proposal="${esc(x.handover_id)}" role="status">
          <strong dir="auto">طلب توسيع مشاركة «${esc(x.title)}»</strong>
          <p class="ct-muted">الحالي: ${esc(x.current?.counts?.sources ?? 0)} رسالة · ${esc(x.current?.counts?.attachments ?? 0)} مرفق —
            المقترح: ${esc(x.proposed?.counts?.sources ?? 0)} رسالة · ${esc(x.proposed?.counts?.attachments ?? 0)} مرفق · ${esc(shareExpiryText(x.proposed?.expiry))}</p>
          <div class="ct-inline">
            <button type="button" class="btn btn-primary ct-btn-sm" data-proposal-accept="${esc(x.handover_id)}" data-version="${esc(x.proposed?.version)}">موافقة</button>
            <button type="button" class="btn btn-secondary ct-btn-sm" data-proposal-reject="${esc(x.handover_id)}" data-version="${esc(x.proposed?.version)}">رفض</button>
          </div></div>`).join('')}
      ${active.length ? `<ul class="ct-sources">${active.map((x) => `<li class="ct-incoming" data-shared="${esc(x.record_id)}">
          <div class="ct-item-meta"><span class="ct-pill">${esc(x.mode === 'collab' ? `تعاون · ${grantActionsText(x.actions || [])}` : 'مراجعة · عرض فقط')}</span><span>${esc(grantRemainingText(x.expires_at))}</span>
            ${x.session_bound ? '<span class="ct-pill">الجلسة دي بس</span>' : ''}</div>
          <h4 dir="auto">${esc(x.title)}</h4>
          <p><span class="ct-muted">من ${esc(agentName(x.granted_by))} — السبب:</span> <span dir="auto">${esc(x.reason)}</span></p>
          <button type="button" class="btn btn-secondary ct-btn-sm" data-shared-open="${esc(x.record_id)}">فتح</button></li>`).join('')}</ul>`
        : '<p class="ct-muted">مفيش مشاركات قائمة.</p>'}`;
}

async function sharedPanelAction(el) {
    if (el.dataset.sharedOpen) return openShared(el.dataset.sharedOpen);
    const id = el.dataset.proposalAccept || el.dataset.proposalReject;
    if (!id) return undefined;
    try {
        await respondShare(id, Number(el.dataset.version), Boolean(el.dataset.proposalAccept));
        toast(el.dataset.proposalAccept ? 'اتوسعت المشاركة' : 'اترفض التوسيع، والمشاركة زي ما هي');
    } catch (err) {
        toast(handoverErrorText(err), 'err');
    }
    return renderShared();
}

/** عرض سجل مشترك: حقول للقراءة، والرسائل والمرفقات المعتمدة فقط بترقيمها الجديد. لا تعديل. */
async function openShared(recordId) {
    state.current = null;
    $('ctPage').classList.add('has-record');
    $('ctDetail').innerHTML = '<p class="ct-empty">بيحمّل…</p>';
    let v;
    try {
        v = await sharedRecord(recordId);
    } catch (err) {
        $('ctDetail').innerHTML = `<p class="ct-empty" id="ctSharedGone">${esc(err.code === 'not_found'
            ? 'المشاركة دي انتهت أو اتسحبت، أو مش متاحة في الجلسة دي.' : friendlyError(err))}</p>
          <div class="ct-inline"><button type="button" class="btn btn-secondary" id="ctBackToList">رجوع للقائمة</button></div>`;
        renderShared();
        return;
    }
    const r = v.record || {};
    const g = v.grant || {};
    state.sharedView = { recordId, v };
    $('ctDetail').innerHTML = `
      <div class="ct-inline"><button type="button" class="btn btn-secondary" id="ctBackToList">رجوع للقائمة</button></div>
      <div class="ct-banner ct-readonly" id="ctSharedBanner" role="status">
        <span>عرض فقط — شاركه معك ${esc(agentName(g.granted_by))} · ${esc(grantRemainingText(g.expires_at))}${g.session_bound ? ' · الجلسة دي بس' : ''}</span>
        <span class="ct-muted">السبب: <span dir="auto">${esc(g.reason)}</span></span></div>
      <div>
        <div class="ct-item-meta">
          <span class="ct-pill">${esc(KIND_META[r.kind]?.label || r.kind)}</span>
          <span class="ct-pill">${esc(STATUS_LABELS[r.status] || r.status)}</span>
          ${r.category ? `<span class="ct-pill ct-pill--accent">${esc(CATEGORY_META[r.category]?.label)}</span>` : ''}
          ${r.overdue ? '<span class="ct-pill ct-pill--danger">متأخر</span>' : ''}
        </div>
        <h2 id="ctRecordTitle" dir="auto">${esc(r.title)}</h2>
        ${r.summary ? `<p dir="auto">${esc(r.summary)}</p>` : ''}
        ${r.problem ? `<p><span class="ct-muted">المشكلة:</span> <span dir="auto">${esc(r.problem)}</span></p>` : ''}
        ${r.next_action ? `<p><span class="ct-muted">الخطوة التالية:</span> <span dir="auto">${esc(r.next_action)}</span></p>` : ''}
        ${r.due_at ? `<p class="ct-muted">الموعد: ${esc(fmt(r.due_at, r.due_tz))}</p>` : ''}
        ${g.range ? `<p class="ct-muted">الرسائل من ${esc(fmt(g.range.from, g.range.tz))} لحد ${esc(fmt(g.range.to, g.range.tz))}</p>` : ''}
      </div>
      <section aria-labelledby="ctSharedSourcesH">
        <h3 id="ctSharedSourcesH">الرسائل (${(v.sources || []).length})</h3>
        ${(v.sources || []).length ? `<ul class="ct-sources" id="ctSharedSources">${v.sources.map((s) => sourceHtml(s, { mode: 'shared' })).join('')}</ul>`
            : '<p class="ct-muted">مفيش رسائل في المشاركة دي.</p>'}
      </section>
      ${(v.attachments || []).length ? `<section aria-labelledby="ctSharedAttH" id="ctSharedAtts">
        <h3 id="ctSharedAttH">المرفقات (${v.attachments.length})</h3>
        <p class="ct-muted">الرابط بيتعمل لما تفتح المرفق وصالح دقيقة واحدة بحد أقصى.</p>
        <ul class="ct-atts">${v.attachments.map((a) => {
            const av = attachmentView(a);
            return `<li class="ct-att" data-att="${esc(a.id)}"><div class="ct-att-head"><b dir="auto">${esc(av.name)}</b> <span class="ct-muted">${esc(av.size)}</span></div>
              <button type="button" class="btn btn-secondary ct-btn-sm" data-shared-att="${esc(a.id)}" data-kind="${esc(av.kind || '')}">عرض</button></li>`;
        }).join('')}</ul></section>` : ''}
      ${sharedCollabHtml(v)}`;
}

// ═════════════════════════════════════════════════════════════
// التعاون (093): في العرض المشترك (المستلم) وفي السجل (المالك/المشرف). الخادم يقرر في كل نداء.
// ═════════════════════════════════════════════════════════════
function noteItemHtml(n, { withThread = false } = {}) {
    const h = withThread && n.handover_id ? (state.handovers || []).find((x) => x.id === n.handover_id) : null;
    return `<li class="ct-note" data-note="${esc(n.id)}"><div class="ct-item-meta"><b>${esc(agentName(n.author_id))}</b>
        <span>${esc(fmt(n.created_at))}</span>${h ? `<span class="ct-pill">مشاركة مع ${esc(agentName(h.to_owner))}</span>` : ''}</div>
      <p dir="auto">${esc(n.body)}</p></li>`;
}

function proposalItemHtml(p, { decide = false, withdraw = false } = {}) {
    return `<li class="ct-proposal" data-proposal-id="${esc(p.id)}"><div class="ct-item-meta"><b>${esc(agentName(p.proposed_by))}</b>
        <span>${esc(fmt(p.created_at))}</span><span class="ct-pill">${esc(PROPOSAL_STATE_LABELS[p.state] || p.state)}</span></div>
      <ul class="ct-proposal-fields">${proposalSummary(p.patch).map((t) => `<li dir="auto">${esc(t)}</li>`).join('')}</ul>
      ${p.note ? `<p class="ct-muted" dir="auto">${esc(p.note)}</p>` : ''}
      ${p.decision_note ? `<p class="ct-muted">رد: <span dir="auto">${esc(p.decision_note)}</span></p>` : ''}
      ${p.state === 'pending' && decide ? `<div class="ct-inline">
          <button type="button" class="btn btn-primary ct-btn-sm" data-proposal-apply="${esc(p.id)}">تطبيق</button>
          <button type="button" class="btn btn-secondary ct-btn-sm" data-proposal-reject="${esc(p.id)}">رفض</button></div>` : ''}
      ${p.state === 'pending' && withdraw ? `<button type="button" class="btn btn-secondary ct-btn-sm" data-proposal-withdraw="${esc(p.id)}">سحب الاقتراح</button>` : ''}
    </li>`;
}

function collabFieldsHtml(r, fields) {
    const has = (k) => fields.includes(k);
    return `${has('next_action') ? `<label class="ct-field" style="grid-column:1/-1"><span>الخطوة التالية</span>
        <input type="text" name="next_action" maxlength="${LIMITS.nextAction}" value="${esc(r.next_action || '')}"></label>` : ''}
      ${has('summary') ? `<label class="ct-field" style="grid-column:1/-1"><span>الملخص</span>
        <textarea name="summary" maxlength="${LIMITS.summary}">${esc(r.summary || '')}</textarea></label>` : ''}
      ${has('due') ? `<label class="ct-field"><span>الموعد (فاضي = بدون تغيير)</span><input type="datetime-local" name="due_at"></label>
        <label class="ct-field"><span>المنطقة الزمنية</span><select name="due_tz" dir="ltr">${[...new Set([r.due_tz || 'Africa/Cairo', ...TIMEZONES])].map((z) =>
            `<option value="${esc(z)}">${esc(z)}</option>`).join('')}</select></label>` : ''}
      ${has('priority') ? `<label class="ct-field"><span>الأولوية</span><select name="priority">${Object.entries(PRIORITY_LABELS).map(([k, v]) =>
            `<option value="${k}" ${Number(k) === r.priority ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>` : ''}`;
}

function sharedCollabHtml(v) {
    const can = grantAbilities(v.grant, v.collab);
    const r = v.record || {};
    const notes = v.notes || [];
    const proposals = v.proposals || [];
    if (!can.note && !can.propose && !can.edit && !can.addSource && !notes.length && !proposals.length) return '';
    const fieldsForm = (can.edit || can.propose) && can.fields.length;
    return `<section aria-labelledby="ctCollabH" id="ctCollab">
        <h3 id="ctCollabH">التعاون</h3>
        ${v.collab && !v.collab.enabled ? '<p class="ct-muted" id="ctCollabOff">إجراءات التعاون متوقفة حاليًا من الإعدادات. العرض بس.</p>' : ''}
        ${fieldsForm ? `<form id="ctSharedEdit" class="ct-detail-grid">
            ${collabFieldsHtml(r, can.fields)}
            ${can.propose ? `<label class="ct-field" style="grid-column:1/-1"><span>ملاحظة مع الاقتراح (اختياري)</span>
              <input type="text" name="proposal_note" maxlength="1000"></label>` : ''}
            <div class="ct-inline" style="grid-column:1/-1">
              ${can.edit ? '<button type="submit" class="btn btn-primary" id="ctSharedSave" data-collab-submit="edit">حفظ التعديل</button>' : ''}
              ${can.propose ? `<button type="submit" class="btn ${can.edit ? 'btn-secondary' : 'btn-primary'}" id="ctSharedPropose" data-collab-submit="propose">إرسال كاقتراح للمالك</button>` : ''}
              <span class="ct-error" id="ctSharedEditError" role="alert"></span>
            </div></form>` : ''}
        ${proposals.length ? `<h4>اقتراحاتك</h4><ul class="ct-sources" id="ctSharedProposals">${proposals.map((p) => proposalItemHtml(p, { withdraw: true })).join('')}</ul>` : ''}
        ${can.addSource ? `<div class="ct-inline" id="ctSharedAdd">
            ${attachmentsOn() ? `<button type="button" class="btn btn-secondary ct-btn-sm" id="ctSharedAttachPick">إرفاق ملف</button>
              <input type="file" id="ctSharedAttachInput" accept="${esc(ATTACHMENT_ACCEPT)}" hidden>` : ''}
            <span class="ct-muted">لإضافة رسائل: افتح المحادثة في صندوق الرسائل ← «سجل استمرارية» ← «إرفاق بسجل موجود». اللي تضيفه يظهر لك أنت بس في المشاركة دي.</span>
            <span class="ct-muted" id="ctSharedUpload" aria-live="polite"></span></div>` : ''}
        <h4>الملاحظات (${notes.length})</h4>
        ${notes.length ? `<ul class="ct-sources" id="ctSharedNotes">${notes.map((n) => noteItemHtml(n)).join('')}</ul>` : '<p class="ct-muted">مفيش ملاحظات لسه.</p>'}
        ${can.note ? `<div class="ct-inline" id="ctSharedNoteForm"><label class="ct-field" style="flex:1"><span class="ct-sr">ملاحظة</span>
            <textarea id="ctSharedNoteBody" maxlength="2000" rows="2" placeholder="اكتب ملاحظة لصاحب السجل"></textarea></label>
            <button type="button" class="btn btn-primary ct-btn-sm" id="ctSharedNoteAdd">إضافة</button></div>` : ''}
      </section>`;
}

/** 094: التذكيرات القادمة وما حصل لها — أنواع وأوقات فقط. */
function remindersHtml(r) {
    const x = state.reminders;
    if (!x || isClosed(r.status) && !(x.recent || []).length) return '';
    const on = x.reminders || x.escalation;
    const upcoming = (x.upcoming || []).filter((j) => (j.kind.startsWith('escalation') ? x.escalation : x.reminders));
    return `<section aria-labelledby="ctRemindersH" id="ctReminders">
        <h3 id="ctRemindersH">التذكيرات</h3>
        ${!on ? '<p class="ct-muted" id="ctRemindersOff">التذكيرات والتصعيد مطفأين حاليًا من الإعدادات.</p>' : ''}
        ${on && !x.reminders ? '<p class="ct-muted">تذكيرات المالك مطفأة؛ التصعيد للمشرفين بس.</p>' : ''}
        ${on && !x.escalation ? '<p class="ct-muted">التصعيد للمشرفين مطفأ؛ تذكيرات المالك بس.</p>' : ''}
        ${upcoming.length ? `<ul class="ct-events" id="ctRemindersUpcoming">${upcoming.map((j) =>
            `<li>${esc(REMINDER_KIND_LABELS[j.kind] || j.kind)} · ${esc(fmt(j.run_at, r.due_tz))}</li>`).join('')}</ul>`
            : on ? '<p class="ct-muted">مفيش تذكيرات قادمة.</p>' : ''}
        ${(x.recent || []).length ? `<details><summary>اللي حصل (${x.recent.length})</summary><ul class="ct-events">${x.recent.map((j) =>
            `<li>${esc(fmt(j.at))} · ${esc(reminderRowText(j))}</li>`).join('')}</ul></details>` : ''}
        <p class="ct-muted">الإشعار فيه نوع السجل والموعد والأولوية بس، من غير عنوان أو محتوى.</p>
      </section>`;
}

function collabRecordHtml(r) {
    if (!state.notes && !state.proposals) return '';
    const p = perms();
    const notes = state.notes || [];
    const pending = (state.proposals || []).filter((x) => x.state === 'pending');
    const past = (state.proposals || []).filter((x) => x.state !== 'pending');
    const grants = (state.handovers || []).filter((h) => isScopedHandover(h) && h.state === 'accepted');
    return `<section aria-labelledby="ctNotesH" id="ctRecordCollab">
        ${pending.length || past.length ? `<h3 id="ctProposalsH">اقتراحات التعديل ${pending.length ? `(${pending.length} بانتظارك)` : ''}</h3>
          ${pending.length ? `<ul class="ct-sources" id="ctProposals">${pending.map((x) => proposalItemHtml(x, { decide: p.edit && !isClosed(r.status) })).join('')}</ul>` : ''}
          ${past.length ? `<details><summary>اقتراحات سابقة (${past.length})</summary><ul class="ct-sources">${past.map((x) => proposalItemHtml(x)).join('')}</ul></details>` : ''}` : ''}
        <h3 id="ctNotesH">الملاحظات (${notes.length})</h3>
        ${notes.length ? `<ul class="ct-sources" id="ctNotes">${notes.map((n) => noteItemHtml(n, { withThread: true })).join('')}</ul>` : '<p class="ct-muted">مفيش ملاحظات.</p>'}
        ${p.edit ? `<div class="ct-detail-grid" id="ctNoteForm">
            <label class="ct-field" style="grid-column:1/-1"><span>ملاحظة جديدة</span><textarea id="ctNoteBody" maxlength="2000" rows="2"></textarea></label>
            ${grants.length ? `<label class="ct-field"><span>لمين</span><select id="ctNoteThread"><option value="">ملاحظة على السجل (لمن يرى السجل)</option>
              ${grants.map((h) => `<option value="${esc(h.id)}">رد في مشاركة ${esc(agentName(h.to_owner))}</option>`).join('')}</select></label>` : ''}
            <div class="ct-inline"><button type="button" class="btn btn-secondary ct-btn-sm" id="ctNoteAdd">إضافة ملاحظة</button></div></div>` : ''}
      </section>`;
}

/** أزرار العرض المشترك (المستلم). */
async function sharedViewAction(el) {
    const sv = state.sharedView;
    if (!sv) return false;
    const rid = sv.recordId;
    try {
        if (el.id === 'ctSharedNoteAdd') {
            const body = $('ctSharedNoteBody')?.value.trim();
            if (!body) return true;
            el.disabled = true;
            await addNote(rid, body, sv.v.grant?.handover_id);
            toast('اتضافت الملاحظة');
        } else if (el.dataset.proposalWithdraw) {
            await withdrawProposal(el.dataset.proposalWithdraw);
            toast('اتسحب الاقتراح');
        } else if (el.id === 'ctSharedAttachPick') {
            $('ctSharedAttachInput')?.click();
            return true;
        } else return false;
    } catch (err) {
        el.disabled = false;
        toast(collabErrorText(err), 'err');
        return true;
    }
    await openShared(rid);
    return true;
}

async function submitSharedEdit(form, which) {
    const sv = state.sharedView;
    if (!sv) return;
    const r = sv.v.record || {};
    const can = grantAbilities(sv.v.grant, sv.v.collab);
    const values = Object.fromEntries([...new FormData(form).entries()].map(([k, v]) => [k, String(v)]));
    const patch = collabPatchFromForm(values, r, can.fields);
    const errEl = $('ctSharedEditError');
    if (!Object.keys(patch).length) { errEl.textContent = 'مفيش تغيير.'; return; }
    form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
        if (which === 'edit') await updateShared(sv.recordId, patch, r.version);
        else await proposeShared(sv.recordId, patch, values.proposal_note || null);
        toast(which === 'edit' ? 'اتحفظ التعديل' : 'اتبعت الاقتراح للمالك');
    } catch (err) {
        form.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        errEl.textContent = collabErrorText(err);
        return;
    }
    await openShared(sv.recordId);
}

async function pickSharedAttachment(file) {
    const sv = state.sharedView;
    if (!file || !sv) return;
    const note = $('ctSharedUpload');
    let head = null;
    try { head = new Uint8Array(await file.slice(0, 64).arrayBuffer()); } catch { head = null; }
    const prep = prepareAttachment(file, head);
    if (prep.error) { if (note) note.textContent = prep.error; return; }
    try {
        await uploadAttachment({ recordId: sv.recordId, file, kind: prep.kind, mime: prep.mime, idempotencyKey: crypto.randomUUID(), shared: true,
            onProgress: (x) => { if (note) note.textContent = `بيترفع… ${Math.round(x * 100)}%`; } });
        toast('اترفع الملف');
    } catch (err) {
        if (note) note.textContent = err.code === 'not_found' ? 'المشاركة انتهت أو اتغيرت.' : attachmentErrorText(err);
        return;
    }
    await openShared(sv.recordId);
}

/** أزرار التعاون في السجل (المالك/المشرف). */
async function recordCollabAction(el, r) {
    try {
        if (el.id === 'ctNoteAdd') {
            const body = $('ctNoteBody')?.value.trim();
            if (!body) return true;
            el.disabled = true;
            await addNote(r.id, body, $('ctNoteThread')?.value || null);
            toast('اتضافت الملاحظة');
        } else if (el.dataset.proposalApply) {
            const x = (state.proposals || []).find((p) => p.id === el.dataset.proposalApply);
            if (!await continuityConfirm({ title: 'تطبيق الاقتراح', confirmText: 'تطبيق',
                message: `هيتعدّل السجل: ${proposalSummary(x?.patch).join(' · ')}` })) return true;
            await decideProposal(el.dataset.proposalApply, 'apply', null, r.version);
            toast('اتطبّق الاقتراح');
        } else if (el.dataset.proposalReject) {
            const note = await continuityPrompt({ title: 'رفض الاقتراح', label: 'سبب الرفض (يظهر للمستلم)', confirmText: 'رفض' });
            if (!note) return true;
            await decideProposal(el.dataset.proposalReject, 'reject', note, r.version);
            toast('اترفض الاقتراح');
        } else return false;
    } catch (err) {
        el.disabled = false;
        toast(collabErrorText(err), 'err');
        return true;
    }
    await openRecord(r.id, { push: false });
    return true;
}

function collabErrorText(err) {
    if (err?.code === 'feature_not_enabled' && err.field === 'collab') return 'إجراءات التعاون متوقفة حاليًا من الإعدادات.';
    if (err?.code === 'forbidden' && err.reason === 'not_in_scope') return 'الحقل ده مش ضمن المسموح لك في المشاركة.';
    if (err?.code === 'not_found') return 'المشاركة انتهت أو اتسحبت، أو الإجراء مش ضمن المسموح.';
    if (err?.code === 'version_conflict') return 'السجل اتعدّل بعد ما فتحته. حدّث وجرّب تاني.';
    if (err?.reason === 'proposal_applied' || err?.reason === 'proposal_rejected' || err?.reason === 'proposal_withdrawn') return 'الاقتراح ده اتحسم بالفعل.';
    if (err?.reason === 'too_many_pending') return 'عندك اقتراحات كتير معلّقة. استنى رد المالك.';
    if (err?.reason === 'next_action_and_due_required') return 'المتابعة لازم يبقى لها خطوة تالية وموعد.';
    if (err?.code === 'validation_failed' && err.field === 'body') return 'الملاحظة لازم تكون بين حرف و2000 حرف.';
    return editRefusalText(err) || friendlyError(err);
}

async function openSharedAttachment(el) {
    el.disabled = true;
    const got = await signSharedAttachment(el.dataset.sharedAtt);
    if (!el.isConnected) return;
    if (!got) {
        el.disabled = false;
        toast('المرفق مش متاح دلوقتي (المشاركة انتهت أو اتغيرت).', 'err');
        return;
    }
    const kind = el.dataset.kind;
    const media = document.createElement(kind === 'image' ? 'img' : kind === 'video' ? 'video' : 'audio');
    media.className = 'ct-att-media';
    if (kind !== 'image') media.controls = true;
    else media.alt = '';
    media.src = got.url;
    el.replaceWith(media);
}

// ═════════════════════════════════════════════════════════════
// المرفقات (080): تظهر فقط والقدرة مفعّلة (continuity_my_access.capabilities.attachments)
// ═════════════════════════════════════════════════════════════
const attachmentsOn = () => Boolean(state.access?.capabilities?.attachments);

function attachmentItemHtml(a, { mode, closed, manage = true }) {
    const v = attachmentView(a);
    const media = mode === 'removed' ? ''
        : v.kind === 'image' ? `<img class="ct-att-media" data-sign="${esc(v.path)}" alt="${esc(v.name)}" loading="lazy" decoding="async">`
        : v.kind === 'video' ? `<video class="ct-att-media" data-sign="${esc(v.path)}" controls preload="metadata" playsinline aria-label="${esc(v.name)}"></video>`
        : v.kind === 'audio' ? `<audio class="ct-att-media" data-sign="${esc(v.path)}" controls preload="none" aria-label="${esc(v.name)}"></audio>` : '';
    const actions = [];
    if (!closed && manage && mode === 'main') actions.push(`<button type="button" class="btn btn-secondary ct-btn-sm" data-att-remove="${esc(v.id)}">إزالة</button>`);
    if (!closed && manage && mode === 'removed') actions.push(`<button type="button" class="btn btn-secondary ct-btn-sm" data-att-restore="${esc(v.id)}">استرجاع</button>`);
    if (state.access.owner) actions.push(`<button type="button" class="btn btn-danger ct-btn-sm" data-att-purge="${esc(v.id)}">مسح نهائي</button>`);
    return `<li class="ct-att" data-attachment="${esc(v.id)}" data-kind="${esc(v.kind || '')}">
        ${media}
        <div class="ct-att-meta"><span class="ct-pill">${esc(v.label)}</span> <span class="ct-att-name" dir="auto">${esc(v.name)}</span>
          <span class="ct-muted">${esc(v.size)} · ${esc(agentName(v.createdBy))} · ${esc(fmt(v.createdAt))}</span></div>
        ${actions.length ? `<div class="ct-inline">${actions.join('')}</div>` : ''}
      </li>`;
}

function uploadStatusHtml(u) {
    if (!u) return '';
    if (u.error) {
        return `<div class="ct-att-upload" id="ctAttachStatus"><p class="ct-error" role="alert" id="ctAttachError">${esc(u.error)}</p>
          ${u.file ? `<div class="ct-inline"><button type="button" class="btn btn-primary ct-btn-sm" id="ctAttachRetry">إعادة المحاولة</button>
            <button type="button" class="btn btn-secondary ct-btn-sm" id="ctAttachDismiss">إلغاء</button></div>` : ''}</div>`;
    }
    const pct = Math.round((u.progress || 0) * 100);
    return `<div class="ct-att-upload" id="ctAttachStatus" aria-live="polite">
        <span dir="auto">${esc(u.file?.name || '')}</span>
        <progress id="ctAttachProgress" max="100" value="${pct}" aria-label="تقدّم الرفع">${pct}%</progress>
        <button type="button" class="btn btn-secondary ct-btn-sm" id="ctAttachCancel">إلغاء الرفع</button></div>`;
}

function attachmentsHtml(r, closed) {
    if (!attachmentsOn()) return '';
    const list = state.current.attachments || [];
    const removed = state.current.removed_attachments || [];
    const u = state.upload && state.upload.recordId === r.id ? state.upload : null;
    const manage = Boolean(perms().attachments);
    return `<section aria-labelledby="ctAttH" id="ctAttachments">
        <div class="ct-section-head"><h3 id="ctAttH">المرفقات (${list.length})</h3>
          ${closed || !manage ? '' : `<div class="ct-inline"><button type="button" class="btn btn-secondary ct-btn-sm" id="ctAttachPick" ${u && !u.error ? 'disabled' : ''}>إرفاق ملف</button>
          <button type="button" class="btn btn-secondary ct-btn-sm" id="ctRecStart" ${(u && !u.error) || state.rec ? 'disabled' : ''}>تسجيل صوتي</button></div>
          <input type="file" id="ctAttachInput" accept="${esc(ATTACHMENT_ACCEPT)}" hidden>`}</div>
        ${closed ? '<p class="ct-muted">السجل مقفول. أعد فتحه عشان ترفع أو تشيل مرفقات.</p>'
            : manage ? `<p class="ct-muted">${esc(ATTACHMENT_LIMITS_TEXT)}.</p>` : '<p class="ct-muted">رفع المرفقات وإزالتها لمالك السجل أو للمشرف.</p>'}
        ${closed || !manage ? '' : recPanelHtml()}
        ${uploadStatusHtml(u)}
        ${list.length ? `<ul class="ct-atts">${list.map((a) => attachmentItemHtml(a, { mode: 'main', closed, manage })).join('')}</ul>` : '<p class="ct-muted" id="ctAttEmpty">مفيش مرفقات.</p>'}
        ${removed.length ? `<h4>مرفقات محذوفة (${removed.length})</h4>
          <ul class="ct-atts ct-atts--removed">${removed.map((a) => attachmentItemHtml(a, { mode: 'removed', closed, manage })).join('')}</ul>` : ''}
      </section>`;
}

/** روابط موقّعة (5 دقائق) لكل وسيط؛ رفض الخادم ⇒ نص بدل الوسيط. لا شيء من المرفق يدخل HTML. */
let hydrateToken = 0;
async function hydrateAttachments() {
    const token = ++hydrateToken;
    const els = [...document.querySelectorAll('#ctAttachments [data-sign]')];
    await Promise.all(els.map(async (el) => {
        const url = await signAttachment(el.dataset.sign);
        if (token !== hydrateToken || !el.isConnected) return;
        if (url) {
            el.src = url;
        } else {
            const note = document.createElement('p');
            note.className = 'ct-muted';
            note.textContent = 'المرفق مش متاح دلوقتي.';
            el.replaceWith(note);
        }
    }));
}

async function startUpload() {
    const u = state.upload;
    const r = state.current?.record;
    if (!u || !r || u.recordId !== r.id) return;
    u.error = null;
    u.progress = 0;
    u.controller = new AbortController();
    renderRecord();
    try {
        const full = await uploadAttachment({
            recordId: u.recordId, file: u.file, kind: u.kind, mime: u.mime, idempotencyKey: u.key, signal: u.controller.signal,
            onProgress: (p) => {
                u.progress = p;
                const bar = $('ctAttachProgress');
                if (bar) { bar.value = Math.round(p * 100); bar.textContent = `${Math.round(p * 100)}%`; }
            },
        });
        state.upload = null;
        toast('اترفع المرفق');
        state.current = full;
        await openRecord(u.recordId, { push: false });
    } catch (err) {
        if (err?.code === 'aborted') {
            state.upload = null;
        } else {
            u.error = attachmentErrorText(err);
            u.controller = null;
        }
        if (state.current?.record?.id === u.recordId) renderRecord();
    }
}

async function pickAttachment(file) {
    const r = state.current?.record;
    if (!file || !r) return;
    let head = null;
    try { head = new Uint8Array(await file.slice(0, 64).arrayBuffer()); } catch { head = null; }
    const prep = prepareAttachment(file, head);
    if (prep.error) {
        state.upload = { recordId: r.id, file: null, error: prep.error };
        renderRecord();
        return;
    }
    // مفتاح واحد لهذا الملف: إعادة المحاولة لا تنشئ مرفقًا ثانيًا.
    state.upload = { recordId: r.id, file, kind: prep.kind, mime: prep.mime, key: crypto.randomUUID(), progress: 0, error: null };
    await startUpload();
}

// ─────────────────────────────────────────────────────────────
// تسجيل صوتي (§15.4): الميكروفون يُطلب عند الضغط فقط، ويُطفأ عند الإيقاف أو الإلغاء أو
// الخطأ أو مغادرة الصفحة أو فتح سجل آخر. حد 8 ميجا: يتوقف ويُرفض كله، لا قص.
// ─────────────────────────────────────────────────────────────
const REC_MAX_MS = 10 * 60 * 1000;
const REC_TOO_LARGE = `التسجيل وصل لحد ${formatBytes(ATTACHMENT_KINDS.audio.max)} فاتلغى كله (مش هيتقص). سجّل أقصر، أو ارفع ملف صوتي مضغوط.`;
let recorder = null;
const mmss = (ms) => { const t = Math.floor((ms || 0) / 1000); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };

function recPanelHtml() {
    const x = state.rec;
    if (!x || x.recordId !== state.current?.record?.id) return '';
    if (x.phase === 'requesting') {
        return '<div class="ct-rec" id="ctRecPanel" aria-live="polite"><span>بيطلب إذن الميكروفون…</span><button type="button" class="btn btn-secondary ct-btn-sm" id="ctRecCancel">إلغاء</button></div>';
    }
    if (x.phase === 'recording') {
        return `<div class="ct-rec is-recording" id="ctRecPanel" aria-live="polite"><span class="ct-rec-dot" aria-hidden="true"></span>
          <span>بيسجّل <time id="ctRecTime">${mmss(x.elapsed)}</time></span>
          <span class="ct-muted" id="ctRecSize">${esc(formatBytes(x.bytes || 0))} من ${esc(formatBytes(ATTACHMENT_KINDS.audio.max))}</span>
          <button type="button" class="btn btn-primary ct-btn-sm" id="ctRecStop">إيقاف</button>
          <button type="button" class="btn btn-secondary ct-btn-sm" id="ctRecCancel">إلغاء</button></div>`;
    }
    if (x.phase === 'review') {
        return `<div class="ct-rec" id="ctRecPanel"><audio id="ctRecPreview" controls preload="metadata" src="${esc(x.url)}" aria-label="معاينة التسجيل"></audio>
          <span class="ct-muted">${esc(mmss(x.elapsed))} · ${esc(formatBytes(x.blob?.size || 0))}</span>
          <button type="button" class="btn btn-primary ct-btn-sm" id="ctRecUpload">رفع التسجيل</button>
          <button type="button" class="btn btn-secondary ct-btn-sm" id="ctRecAgain">إعادة التسجيل</button>
          <button type="button" class="btn btn-secondary ct-btn-sm" id="ctRecDiscard">حذف</button></div>`;
    }
    return `<div class="ct-rec" id="ctRecPanel"><p class="ct-error" role="alert" id="ctRecError">${esc(x.message)}</p>
      <button type="button" class="btn btn-secondary ct-btn-sm" id="ctRecFallback">رفع ملف صوتي بدل كده</button>
      <button type="button" class="btn btn-secondary ct-btn-sm" id="ctRecClose">إغلاق</button></div>`;
}

function renderRecPanel() {
    const panel = $('ctRecPanel');
    const html = recPanelHtml();
    if (panel) panel.outerHTML = html || '';
    else if (html) renderRecord();
    const start = $('ctRecStart');
    if (start) start.disabled = Boolean(state.rec) || Boolean(state.upload && !state.upload.error);
}

function clearRec() {
    if (state.rec?.url) URL.revokeObjectURL(state.rec.url);
    state.rec = null;
}

/** يطفئ أي تسجيل جارٍ ويحذفه (فتح سجل آخر، مغادرة الصفحة). */
function resetRecorder() {
    if (recorder && (recorder.state === 'recording' || recorder.state === 'requesting')) recorder.cancel();
    recorder = null;
    clearRec();
}

async function startRecording() {
    const r = state.current?.record;
    if (!r) return;
    resetRecorder();
    if (!isVoiceRecordingSupported()) {
        state.rec = { recordId: r.id, phase: 'error', message: 'المتصفح ده مش بيدعم تسجيل الصوت. تقدر ترفع ملف صوتي بدل كده.' };
        renderRecPanel();
        return;
    }
    const recordId = r.id;
    state.rec = { recordId, phase: 'requesting', elapsed: 0, bytes: 0 };
    renderRecPanel();
    const rec = new VoiceRecorder({
        maxMs: REC_MAX_MS, maxBytes: ATTACHMENT_KINDS.audio.max, tooLargeMessage: REC_TOO_LARGE,
        onTick: (ms) => {
            if (state.rec?.phase !== 'recording') return;
            state.rec.elapsed = ms;
            const t = $('ctRecTime');
            if (t) t.textContent = mmss(ms);
        },
        onSize: (bytes) => {
            if (!state.rec) return;
            state.rec.bytes = bytes;
            const z = $('ctRecSize');
            if (z) z.textContent = `${formatBytes(bytes)} من ${formatBytes(ATTACHMENT_KINDS.audio.max)}`;
        },
        onState: (phase, detail) => {
            if (recorder !== rec || !state.rec || state.rec.recordId !== recordId) return;
            if (phase === 'recording') state.rec.phase = 'recording';
            else if (phase === 'stopped') {
                state.rec = { recordId, phase: 'review', elapsed: detail.durationMs, blob: detail.blob, mime: detail.mime,
                    url: URL.createObjectURL(detail.blob) };
            } else if (phase === 'error') state.rec = { recordId, phase: 'error', message: detail?.message || 'تعذّر التسجيل.' };
            else if (phase === 'idle') state.rec = null;
            else return;
            renderRecPanel();
        },
    });
    recorder = rec;
    await rec.start();
}

function uploadRecording() {
    const x = state.rec;
    if (!x?.blob) return;
    const mime = String(x.mime || 'audio/webm').split(';')[0].trim().toLowerCase();
    const ext = mime === 'audio/ogg' ? 'ogg' : mime === 'audio/mp4' ? 'm4a' : 'webm';
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
    const file = new File([x.blob], `تسجيل صوتي ${stamp}.${ext}`, { type: mime });
    recorder = null;
    clearRec();
    renderRecPanel();
    return pickAttachment(file);
}

async function recAction(el) {
    switch (el.id) {
        case 'ctRecStart': await startRecording(); return true;
        case 'ctRecStop': await recorder?.stop(); return true;
        case 'ctRecCancel': resetRecorder(); renderRecPanel(); return true;
        case 'ctRecDiscard': case 'ctRecClose': resetRecorder(); renderRecPanel(); return true;
        case 'ctRecAgain': await startRecording(); return true;
        case 'ctRecUpload': await uploadRecording(); return true;
        case 'ctRecFallback': resetRecorder(); renderRecPanel(); $('ctAttachInput')?.click(); return true;
        default: return false;
    }
}

async function attachmentAction(el, r) {
    if (await recAction(el)) return true;
    if (el.id === 'ctAttachPick') { $('ctAttachInput')?.click(); return true; }
    if (el.id === 'ctAttachRetry') { await startUpload(); return true; }
    if (el.id === 'ctAttachDismiss') { state.upload = null; renderRecord(); return true; }
    if (el.id === 'ctAttachCancel') { state.upload?.controller?.abort(); return true; }
    const wrap = (fn, ok) => act(async () => {
        try { return await fn(); } catch (err) { throw Object.assign(err, { message: attachmentErrorText(err) }); }
    }, ok);
    if (el.dataset.attRemove) {
        await wrap(() => removeAttachment(el.dataset.attRemove, r.version), 'اتنقل للمرفقات المحذوفة');
        return true;
    }
    if (el.dataset.attRestore) {
        await wrap(() => restoreAttachment(el.dataset.attRestore, r.version), 'رجع المرفق');
        return true;
    }
    if (el.dataset.attPurge) {
        if (!await continuityConfirm({ title: 'مسح المرفق نهائيًا', danger: true, confirmText: 'مسح نهائي',
            message: 'الملف هيتمسح ومش هيرجع.' })) return true;
        await wrap(() => purgeAttachment(el.dataset.attPurge, r.version), 'اتمسح المرفق');
        return true;
    }
    return false;
}

const actorName = (id) => (id ? agentName(id) : 'النظام');

/** تاريخ الإغلاق (079). كل نص عبر esc؛ القسم غائب لو الخادم لم يرسل closures. */
function closureHtml(closures) {
    if (!Array.isArray(closures) || !closures.length) return '';
    const rows = closureHistory(closures);
    return `<section aria-labelledby="ctClosuresH" id="ctClosures">
        <h3 id="ctClosuresH">تاريخ الإغلاق (${rows.length})</h3>
        <ol class="ct-closures">${rows.map((c) => `<li class="ct-closure" data-seq="${esc(c.seq)}">
          <div class="ct-item-meta"><span class="ct-pill">${esc(c.statusLabel)}</span>
            <span class="ct-muted">${esc(fmt(c.closedAt))} · ${esc(actorName(c.closedBy))}</span></div>
          ${c.note ? `<p><strong>${esc(c.noteLabel)}:</strong> <span class="ct-closure-note">${esc(c.note)}</span></p>`
              : c.noteMissing ? `<p class="ct-muted">${esc(c.noteLabel)} مش محفوظ (الإغلاق ده قبل تفعيل التاريخ).</p>` : ''}
          ${c.reopened ? `<p class="ct-closure-reopen"><span class="ct-muted">اتفتح تاني ${esc(fmt(c.reopenedAt))} · ${esc(actorName(c.reopenedBy))}</span>
              ${c.reopenReason ? `<br><strong>السبب:</strong> <span class="ct-closure-reason">${esc(c.reopenReason)}</span>`
                  : c.reopenReasonMissing ? '<br><span class="ct-muted">السبب مش محفوظ (قبل تفعيل التاريخ).</span>' : ''}</p>` : ''}
        </li>`).join('')}</ol>
      </section>`;
}

function patchFromForm(form, record) {
    const fd = new FormData(form);
    const patch = {};
    for (const k of ['title', 'summary', 'problem', 'known_facts', 'unknowns', 'resolution_criteria', 'next_action']) {
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
    const refused = editRefusalText(err);
    if (refused) return refused;
    if (err?.code === 'validation_failed' && err.reason === 'next_action_and_due_required') {
        return 'المتابعة لازم يكون ليها خطوة تالية وموعد.';
    }
    if (err?.code === 'validation_failed' && err.field === 'issue.problem') return 'اكتب وصف المشكلة.';
    if (err?.code === 'validation_failed' && err.reason === 'not_eligible') {
        if (err.field === 'user_id') return `الموظف ده ${INACTIVE_STAFF}، فمينفعش ياخد صلاحية الإسناد. فعّل حسابه الأول.`;
        if (err.field === 'owner_id') return `الموظف ده ${INACTIVE_STAFF}، فمينفعش يبقى مالك للسجل.`;
    }
    if (err?.code === 'forbidden' && err.field === 'owner') {
        return 'المسح النهائي وصلاحية الإسناد لحساب مالك المنصة بس.';
    }
    if (err?.code === 'validation_failed' && err.reason === 'due_required_on_reopen') {
        return 'موعد المتابعة عدّى أو قرّب جدًا. حدد موعد جديد عشان تعيد فتحها.';
    }
    if (err?.code === 'validation_failed' && err.reason === 'in_past' && String(err.field || '').startsWith('details.due')) {
        return 'الموعد الجديد لازم يكون بعد دلوقتي.';
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
            $('ctDetail').innerHTML = '<p class="ct-empty">السجل اتنقل ومبقاش ظاهر ليك.</p>';
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
    if (STANDALONE) return;
    const box = $('ctTrash');
    if (!state.access.trash) { box.hidden = true; return; }
    try {
        state.trash = await listRemoved() || [];
    } catch (err) {
        box.hidden = false;
        $('ctTrashBody').innerHTML = `<p class="ct-error">${esc(friendlyError(err))}</p>`;
        return;
    }
    box.hidden = !state.trash.length;
    $('ctTrashCount').textContent = state.trash.length ? `(${state.trash.length})` : '';
    $('ctPurgeAll').hidden = !state.access.owner || !state.trash.length;
    $('ctTrashBody').innerHTML = `<ul class="ct-sources">${state.trash.map((x) => `<li class="ct-trash-item">
        <button type="button" class="ct-trash-record" data-open-record="${esc(x.record.id)}">${esc(x.record.title)}
          ${isClosed(x.record.status) ? `<span class="ct-pill">${esc(STATUS_LABELS[x.record.status])}</span>` : ''}</button>
        <ul class="ct-sources">${sourceHtml(x.source, { mode: 'removed', closed: isClosed(x.record.status), version: x.record.version, recordId: x.record.id })}</ul>
      </li>`).join('')}</ul>`;
}

// ═════════════════════════════════════════════════════════════
// صلاحية الإسناد (لمالك المنصة، 076)
// ═════════════════════════════════════════════════════════════
// 078: إعدادات الاستمرارية — لمالك المنصة: قراءة وتعديل (continuity_set_policies بالنسخة).
// قبل 078 (لا capabilities) مخفية. القدرة غير المثبتة لا تُفعَّل (الخادم يرفض، والمربع معطّل بسببه).
async function renderPolicies() {
    if (STANDALONE) return;
    const box = $('ctPolicies');
    if (!(state.access.owner && state.access.policies)) { box.hidden = true; return; }
    box.hidden = false;
    const body = $('ctPoliciesBody');
    body.textContent = 'جاري التحميل…';
    try {
        state.policy = await getPolicies();
    } catch (err) {
        body.innerHTML = `<p class="ct-error">${esc(friendlyError(err))}</p>`;
        return;
    }
    const p = state.policy?.policy || {};
    const installed = state.policy?.capabilities_installed || {};
    const d = describePolicy(state.policy);
    const caps = Object.keys(CAPABILITY_LABELS).map((c, i) => `<li><label class="ct-check-row">
        <input type="checkbox" name="${c}_enabled" ${p[`${c}_enabled`] ? 'checked' : ''} ${installed[c] ? '' : 'disabled'}>
        <span>${esc(CAPABILITY_LABELS[c])}</span></label>
        <span class="${d.capabilities[i].off ? 'ct-policy-off' : ''}">${esc(installed[c] ? d.capabilities[i].value : 'غير مثبتة بعد — تتفعّل بعد تثبيت كودها')}</span></li>`).join('');
    const nums = POLICY_NUMBER_FIELDS.filter((f) => !f.optional || f.key in p).map((f) => `<label class="ct-field"><span>${esc(f.label)}</span>
        <input type="text" inputmode="numeric" name="${f.key}" value="${esc(p[f.key] ?? '')}" dir="ltr"></label>`).join('');
    const bools = POLICY_BOOL_FIELDS.filter((f) => !f.optional || f.key in p).map((f) => `<label class="ct-check-row"><input type="checkbox" name="${f.key}" ${p[f.key] ? 'checked' : ''}>
        <span>${esc(f.label)}</span></label>`).join('');
    body.innerHTML = `<form id="ctPolicyForm">
        <h4>القدرات</h4><ul class="ct-policy-list" id="ctPolicyCaps">${caps}</ul>
        <h4>المواعيد والتصعيد</h4>
        <div class="ct-detail-grid" id="ctPolicyTimings">
          <label class="ct-field" style="grid-column:1/-1"><span>تذكير قبل الموعد (دقائق، حتى 5 قيم مفصولة بفاصلة)</span>
            <input type="text" name="reminder_offsets_minutes" value="${esc((p.reminder_offsets_minutes || []).join(', '))}" dir="ltr"></label>
          ${nums}
          <label class="ct-field"><span>التصعيد إلى</span><select name="escalation_recipients">
            <option value="supervisors" ${p.escalation_recipients === 'supervisors' ? 'selected' : ''}>المشرفين</option>
            <option value="team_then_supervisors" ${p.escalation_recipients === 'team_then_supervisors' ? 'selected' : ''}>الفريق ثم المشرفين</option></select></label>
          <div class="ct-inline" style="grid-column:1/-1">${bools}</div>
        </div>
        <p class="ct-muted">المواعيد تتطبق لما التذكيرات والتصعيد يتثبتوا ويتفعّلوا. كل تغيير بيتسجّل في تاريخ الإعدادات.</p>
        <div class="ct-inline"><button type="submit" class="btn btn-primary" id="ctPolicySave">حفظ الإعدادات</button>
          <span class="ct-error" id="ctPolicyError" role="alert"></span></div>
      </form>`;
}

async function savePolicies(form) {
    const values = {};
    for (const el of form.elements) {
        if (!el.name || el.disabled) continue;
        values[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    }
    const { patch, errors } = policyPatchFromForm(values, state.policy?.policy);
    const errEl = $('ctPolicyError');
    errEl.textContent = '';
    if (errors.length) { errEl.textContent = 'في قيمة مش رقم صحيح أو ناقصة. راجع الحقول.'; return; }
    const invalid = validatePolicyPatch(patch);
    if (Object.keys(patch).length && invalid.length) { errEl.textContent = 'في قيمة خارج الحدود المسموحة.'; return; }
    if (!Object.keys(patch).length) { toast('مفيش تغيير'); return; }
    const turnedOn = Object.keys(CAPABILITY_LABELS).filter((c) => patch[`${c}_enabled`] === true);
    if (turnedOn.length && !await continuityConfirm({ title: 'تفعيل قدرات', confirmText: 'تفعيل',
        message: `هتتفعّل لكل فريق الاستمرارية فورًا: ${turnedOn.map((c) => CAPABILITY_LABELS[c]).join('، ')}. تقدر تطفيها في أي وقت من هنا.` })) return;
    try {
        state.policy = await setPolicies(patch, state.policy.version);
        toast('اتحفظت الإعدادات');
    } catch (err) {
        if (err.code === 'version_conflict') {
            await renderPolicies();
            $('ctPolicyError').textContent = 'حد غيّر الإعدادات قبلك. اتحمّلت النسخة الحالية، راجعها وجرّب تاني.';
            return;
        }
        errEl.textContent = err.code === 'feature_not_enabled' ? 'القدرة دي مش مثبتة لسه، فمينفعش تتفعّل.'
            : err.code === 'forbidden' ? 'تعديل الإعدادات لحساب مالك المنصة بس.'
                : err.code === 'validation_failed' ? 'في قيمة خارج الحدود المسموحة.' : friendlyError(err);
        return;
    }
    state.access = await loadContinuityAccess();
    await renderPolicies();
    if (state.current?.record?.id) await openRecord(state.current.record.id, { push: false });
    renderIncoming();
}

async function renderAssigners() {
    if (STANDALONE) return;
    const box = $('ctAssigners');
    // 076: المنح والسحب للمالك. قبل 076 كانوا للمشرف (074).
    if (!(state.access.trash ? state.access.owner : state.access.supervisor)) { box.hidden = true; return; }
    box.hidden = false;
    try {
        state.assigners = await listAssigners();
    } catch (err) {
        $('ctAssignersBody').innerHTML = `<p class="ct-error">${esc(err.message)}</p>`;
        return;
    }
    const granted = new Set(state.assigners.map((a) => a.user_id));
    const candidates = state.agents.filter((a) => !granted.has(a.id) && !a.is_elevated);
    $('ctAssignersBody').innerHTML = `
      ${state.assigners.length ? `<ul class="ct-assigners">${state.assigners.map((a) => `<li>
          <span>${esc(a.full_name || a.email || 'موظف')}${a.eligible ? '' : ' <small class="ct-pill ct-pill--danger">غير نشط</small>'}</span>
          <button type="button" class="btn btn-secondary" data-revoke="${esc(a.user_id)}">سحب الصلاحية</button></li>`).join('')}</ul>`
        : '<p class="ct-muted">مفيش حد عنده صلاحية إسناد غير المشرفين.</p>'}
      ${candidates.length ? `<div class="ct-inline"><label class="ct-field"><span>منح صلاحية الإسناد لـ</span>
          <select id="ctGrantUser">${candidates.map((a) => `<option value="${esc(a.id)}">${esc(a.full_name || a.email)}</option>`).join('')}</select></label>
          <button type="button" class="btn btn-primary" id="ctGrantBtn">منح</button></div>` : ''}`;
}

// ═════════════════════════════════════════════════════════════
// الربط
// ═════════════════════════════════════════════════════════════
function wire() {
    if (!STANDALONE) wireListAndPanels();
    $('ctDetail').addEventListener('change', (e) => {
        if (e.target.id === 'ctSharedAttachInput') {
            const f = e.target.files?.[0];
            e.target.value = '';
            pickSharedAttachment(f);
            return;
        }
        if (e.target.id !== 'ctAttachInput') return;
        const file = e.target.files?.[0];
        e.target.value = '';
        pickAttachment(file);
    });
    $('ctDetail').addEventListener('submit', (e) => {
        if (e.target.id === 'ctSharedEdit') {
            e.preventDefault();
            submitSharedEdit(e.target, e.submitter?.dataset.collabSubmit || 'propose');
            return;
        }
        if (e.target.id !== 'ctEdit') return;
        e.preventDefault();
        const r = state.current.record;
        const patch = patchFromForm(e.target, r);
        if (!Object.keys(patch).length) { toast('مفيش تغيير'); return; }
        act(() => updateRecord(r.id, patch, r.version), 'اتحفظ');
    });
    $('ctDetail').addEventListener('click', async (e) => {
        const r = state.current?.record;
        const el = e.target.closest('button');
        if (el?.id === 'ctBackToList') return closeRecord();
        if (el?.id === 'ctRetry') return openRecord(el.dataset.id, { push: false });
        if (el?.dataset.sharedAtt) return openSharedAttachment(el);
        if (el && !r && await sharedViewAction(el)) return undefined;
        if (!el || !r) return undefined;
        if (el.id === 'ctEventsMore') return loadOlderEvents(r);
        if (el.id === 'ctClaim') {
            return act(() => assignRecord(r.id, state.me?.id, r.team_id, r.version), 'السجل بقى باسمك');
        }
        if (await attachmentAction(el, r)) return undefined;
        if (await handoverAction(el, r)) return undefined;
        if (await shareAction(el, r)) return undefined;
        if (await recordCollabAction(el, r)) return undefined;
        if (el.id === 'ctAssignBtn') {
            const owner = $('ctAssignOwner').value || null;
            const team = $('ctAssignTeam') ? ($('ctAssignTeam').value || null) : r.team_id;
            const ok = await continuityConfirm(owner && owner !== state.me?.id
                ? { title: 'نقل السجل', message: `السجل هيتنقل لـ ${agentName(owner)}، وهيظهر عنده في سجلاته.`, confirmText: 'نقل السجل' }
                : { title: 'تغيير المالك', message: owner ? 'السجل هيبقى باسمك.' : 'السجل هيفضل من غير مالك لحد ما حد ياخده.', confirmText: 'تأكيد' });
            if (!ok) return undefined;
            return act(() => assignRecord(r.id, owner, team, r.version), 'اتغيّر المالك');
        }
        if (el.dataset.to) {
            const t = allowedTransitions(r, { meId: state.me?.id, supervisor: state.access.supervisor }).find((x) => x.to === el.dataset.to);
            let details = {};
            if (!t) return undefined;
            if (t.to === 'open') {
                const req = reopenRequirements(r);
                const got = await continuityReopen({
                    needsDue: Boolean(req?.needsDue), tz: req?.tz, timezones: TIMEZONES,
                    message: 'السجل هيرجع «مفتوح». تاريخ الإغلاق بيفضل محفوظ.',
                    dueNote: req?.needsDue
                        ? (req.expiredDue ? `الموعد السابق (${fmt(r.due_at, r.due_tz)}) عدّى، فلازم موعد جديد.` : 'المتابعة محتاجة موعد.')
                        : req?.keepsDue ? `لو سبته فاضي، الموعد الحالي يفضل: ${fmt(r.due_at, r.due_tz)}.`
                            : req?.expiredDue ? `الموعد السابق (${fmt(r.due_at, r.due_tz)}) عدّى؛ تقدر تحدد جديد.` : '',
                });
                if (!got) return undefined;
                details = got.due ? { reason: got.reason, due: got.due } : { reason: got.reason };
                return act(() => transitionRecord(r.id, 'open', details, r.version), 'اتفتح السجل تاني');
            }
            if (t.needs) {
                const text = await continuityPrompt({
                    title: t.label, label: t.prompt, confirmText: t.label, danger: t.to === 'cancelled',
                    message: t.to === 'cancelled' ? 'السجل هيتقفل ومش هيتعدّل تاني إلا لو اتفتح من جديد.' : '',
                });
                if (!text) return undefined;
                details = { [t.needs]: text };
            }
            return act(() => transitionRecord(r.id, t.to, details, r.version), 'اتغيّرت الحالة');
        }
        if (el.id === 'ctPurgeRecord') {
            const n = (state.current.removed || []).length;
            if (!await continuityConfirm({ title: 'تفريغ المحذوفات', danger: true, confirmText: 'مسح نهائي',
                message: `${n} رسالة هتتمسح من السجل ده نهائيًا. مفيش رجوع، ومش هتقدر ترفقها تاني.` })) return undefined;
            return act(async () => { await purgeRemoved(r.id); return getRecord(r.id); }, 'اتمسحت المحذوفات');
        }
        if (el.dataset.redact) {
            const ok = await continuityConfirm({
                title: 'حذف محتوى المصدر نهائيًا', danger: true, confirmText: 'حذف نهائي',
                message: 'مفيش رجوع: المحتوى مش هيرجع حتى لو أرفقت نفس الرسالة تاني.',
            });
            if (!ok) return undefined;
            return act(() => purgeSource(el.dataset.redact), 'اتحذف المحتوى');
        }
        return sourceAction(el);
    });
}

/** القائمة والفلاتر ولوحات المحذوفات والإسناد: الصفحة الرئيسية فقط. */
function wireListAndPanels() {
    $('ctNewRecord')?.addEventListener('click', newRecord);
    $('ctPolicies').addEventListener('submit', (e) => {
        if (e.target.id !== 'ctPolicyForm') return;
        e.preventDefault();
        savePolicies(e.target);
    });
    $('ctHandovers')?.addEventListener('click', (e) => {
        const el = e.target.closest('button');
        if (el) incomingAction(el);
    });
    $('ctShared')?.addEventListener('click', (e) => {
        const el = e.target.closest('button');
        if (el) sharedPanelAction(el);
    });
    for (const [id, key] of [['ctFilterStatus', 'status'], ['ctFilterOwner', 'owner'], ['ctFilterCategory', 'category']]) {
        $(id).addEventListener('change', (e) => { state.filters[key] = e.target.value; reloadList(); });
    }
    $('ctList').addEventListener('click', (e) => {
        const b = e.target.closest('[data-open]');
        if (b) openRecord(b.dataset.open);
    });
    $('ctTrash').addEventListener('click', async (e) => {
        const el = e.target.closest('button');
        if (!el) return undefined;
        if (el.dataset.openRecord) return openRecord(el.dataset.openRecord);
        if (el.id === 'ctPurgeAll') {
            if (!await continuityConfirm({ title: 'تفريغ كل المحذوفات', danger: true, confirmText: 'مسح الكل نهائيًا',
                message: `${state.trash.length} رسالة في المحذوفات هتتمسح من كل السجلات نهائيًا. مفيش رجوع.` })) return undefined;
            return act(async () => {
                await purgeRemoved(null);
                return state.current?.record?.id ? getRecord(state.current.record.id) : null;
            }, 'اتفرّغت المحذوفات');
        }
        return sourceAction(el);
    });
    $('ctAssigners').addEventListener('click', async (e) => {
        const el = e.target.closest('button');
        if (!el) return;
        try {
            if (el.id === 'ctGrantBtn') {
                const id = $('ctGrantUser').value;
                if (!await continuityConfirm({ title: 'منح صلاحية الإسناد', confirmText: 'منح الصلاحية',
                    message: `${agentName(id)} هيقدر يسند السجلات لأي موظف أو فريق.` })) return;
                await grantAssigner(id);
                toast('اتمنحت الصلاحية');
            } else if (el.dataset.revoke) {
                if (!await continuityConfirm({ title: 'سحب صلاحية الإسناد', danger: true, confirmText: 'سحب الصلاحية',
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

/** سجل جديد من الصفحة (بلا رسائل). المفتاح ثابت لنفس المسودة: إعادة المحاولة لا تنشئ سجلين. */
async function newRecord() {
    let attempt = null;
    const created = await continuityNewRecord({
        owners: ownerOptions({ agents: state.agents, meId: state.me?.id, canAssign: state.access.can_assign }),
        teams: state.teams, canAssign: state.access.can_assign, timezones: TIMEZONES, priorities: PRIORITY_LABELS,
        categories: RECORD_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_META[c].label })),
        missing: manualMissing,
        submit: async (draft) => {
            const sig = JSON.stringify(draft);
            if (!attempt || attempt.sig !== sig) attempt = { sig, key: crypto.randomUUID() };
            try {
                const res = await createRecord(buildManualRequest(draft, { idempotencyKey: attempt.key }));
                attempt.recordId = res?.record?.id || null;
                return null;
            } catch (err) {
                return friendlyError(err);
            }
        },
    });
    if (!created || !attempt?.recordId) return;
    toast('اتعمل السجل');
    await reloadList();
    await openRecord(attempt.recordId);
}

function closeRecord() {
    state.current = null;
    $('ctPage').classList.remove('has-record');
    $('ctDetail').innerHTML = '<p class="ct-empty">اختار سجل من القائمة.</p>';
    const url = new URL(location.href);
    url.searchParams.delete('record');
    history.replaceState(null, '', url);
    renderList();
}

async function boot() {
    if (!STANDALONE) initSidebar();
    const user = await checkAdminAuth();
    if (!user) return;
    updateAdminUI(user);
    state.me = user;
    const standaloneId = STANDALONE ? new URLSearchParams(location.search).get('id') : null;
    if (STANDALONE && !isRecordId(standaloneId)) {
        $('ctDetail').innerHTML = `<p class="ct-empty" id="ctInvalidLink">رابط السجل غير صالح.</p>
          <div class="ct-inline"><a class="btn btn-secondary" href="/admin/continuity.html">صفحة الاستمرارية</a></div>`;
        return;
    }
    state.access = await loadContinuityAccess();
    if (!state.access.member || !state.access.enabled) {
        $('ctBanner').hidden = false;
        $('ctBanner').textContent = !state.access.member
            ? 'الاستمرارية لفريق الدعم. حسابك دلوقتي مش في سياق إداري نشط — بدّل للإدارة من مبدّل الواجهة وحدّث الصفحة.'
            : 'الاستمرارية مش مفعّلة حاليًا.';
        $('ctPage').hidden = true;
        return;
    }
    [state.agents, state.teams] = await Promise.all([loadAgents(), loadTeams()]);
    wire();
    await renderShared();
    state.delegation = state.shared.installed ? await delegationSettings() : null;
    if (STANDALONE) {
        await openRecord(standaloneId, { push: false });
        return;
    }
    $('ctFilterCategory').innerHTML = '<option value="">كل الأنواع</option>'
        + RECORD_CATEGORIES.map((c) => `<option value="${c}">${esc(CATEGORY_META[c].label)}</option>`).join('');
    await reloadList();
    const deep = new URLSearchParams(location.search).get('record');
    const sharedDeep = new URLSearchParams(location.search).get('shared');
    if (deep) await openRecord(deep, { push: false });
    else if (sharedDeep && isRecordId(sharedDeep) && state.shared.installed) await openShared(sharedDeep);
    renderTrash();
    renderAssigners();
    renderPolicies();
    renderIncoming();
}

// مغادرة الصفحة: لا ميكروفون يظل مفتوحًا في الخلفية.
window.addEventListener('pagehide', () => resetRecorder());

boot();
