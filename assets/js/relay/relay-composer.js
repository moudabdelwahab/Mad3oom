/**
 * Relay — نافذة إنشاء سجل استمرارية من محادثة في الصندوق (المرحلة C).
 *
 * ثلاث خطوات في نافذة واحدة:
 *   1) اختيار الرسائل   (شاشة المرجع الأولى: بحث وفلاتر وتحديد وشريط المختار)
 *   2) معاينة النوع     (شاشة المرجع الثانية: الرسائل المختارة، النوع المقترح،
 *                        باقي الأنواع، ملاحظات اختيارية)
 *   3) التفاصيل         (نوع السجل، العنوان، الخطوة التالية، الموعد، المالك)
 *                        أو إرفاق الرسائل بسجل موجود تراه.
 *
 * الصلاحيات هنا للعرض فقط: قائمة المالكين المقيدة وإخفاء الفريق يعكسان
 * relay_my_access، والخادم (074) هو اللي يرفض. لا شيء يُخزَّن في المتصفح، ونص
 * الرسائل يُستخدم للاقتراح محليًا فقط (الخادم يلتقط المقتطف بنفسه من معرّف الرسالة).
 */
import { LIMITS, sensitiveKinds } from './relay-contract.js';
import {
    CATEGORY_META, KIND_META, PRIORITY_LABELS, SENDER_LABEL, TIME_FILTERS, PARTICIPANT_FILTERS, TYPE_FILTERS,
    RECORD_CATEGORIES, filterMessages, toggleSelection, orderedSelection, selectability, messageSender,
    suggestCategory, suggestKind, detectDueCandidates, missingFields, ownerOptions, buildRequestFromDraft,
    titlePlaceholder,
} from './relay-model.js';
import { createRecord, listRecords, attachSources } from './relay-data.js';
import { RELAY_ICONS, SENDER_ICON } from './relay-icons.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TIME_FMT = new Intl.DateTimeFormat('ar-EG-u-nu-latn', { hour: 'numeric', minute: '2-digit' });
const shortTime = (iso) => { try { return TIME_FMT.format(new Date(iso)); } catch { return ''; } };
const shortDate = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
};
function ageLabel(iso, now = new Date()) {
    const days = Math.floor((now - new Date(iso)) / 86400000);
    if (!Number.isFinite(days)) return '';
    if (days <= 0) return 'النهارده';
    if (days === 1) return 'منذ يوم';
    if (days === 2) return 'منذ يومين';
    if (days <= 10) return `منذ ${days} أيام`;
    return `منذ ${days} يوم`;
}
const countLabel = (n) => (n === 1 ? 'رسالة واحدة' : n === 2 ? 'رسالتين' : n <= 10 ? `${n} رسائل` : `${n} رسالة`);
const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Cairo'; } catch { return 'Africa/Cairo'; } };
const TIMEZONES = ['Africa/Cairo', 'Asia/Riyadh', 'Asia/Dubai', 'Europe/London', 'UTC'];
const newKey = () => (crypto.randomUUID ? crypto.randomUUID()
    : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));

let dialog = null;
let st = null;

function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.className = 'rl-dialog';
    dialog.id = 'relayComposer';
    dialog.setAttribute('dir', 'rtl');
    dialog.setAttribute('aria-labelledby', 'rlTitle');
    document.body.appendChild(dialog);
    dialog.addEventListener('click', onClick);
    dialog.addEventListener('input', onInput);
    dialog.addEventListener('change', onInput);
    dialog.addEventListener('close', () => { st = null; dialog.innerHTML = ''; });
    return dialog;
}

/**
 * يفتح النافذة على محادثة. messages = رسائل المحادثة كما يعرضها الصندوق.
 * access = relay_my_access؛ agents/teams من الصندوق؛ onDone(result) بعد النجاح.
 */
export function openRelayComposer({ session, messages, customerName, customerContact, agents = [], teams = [], me, access, onDone }) {
    ensureDialog();
    const ordered = [...(messages || [])].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    st = {
        step: 'select', session, messages: ordered, customerName, customerContact,
        agents, teams, me, access: access || {}, onDone,
        filters: { query: '', time: 'all', participant: 'all', type: 'all' },
        selected: [], note: '', limitHit: false,
        suggestion: null, category: null, detailsOpen: false,
        mode: 'new',
        draft: { kind: null, title: '', summary: '', nextAction: '', dueAt: '', dueTz: browserTz(), ownerId: me?.id || '', teamId: '', priority: 3, sensitiveAck: false },
        dueCandidates: [], sensitive: [],
        existing: null, existingId: null, busy: false, error: '', attempt: null,
    };
    render();
    dialog.showModal();
    dialog.querySelector('#rlSearch')?.focus();
}

export function closeRelayComposer() { if (dialog?.open) dialog.close(); }

// ═════════════════════════════════════════════════════════════
// الرسم
// ═════════════════════════════════════════════════════════════
let rendering = false;
function render() {
    if (!st || rendering) return;
    const body = st.step === 'select' ? renderSelect() : st.step === 'type' ? renderType() : renderDetails();
    // إزالة الحقل المركّز تطلق blur/change أثناء الاستبدال؛ القيم اتسجلت بالفعل من input،
    // فنتجاهل الأحداث دي بدل رسم متداخل يكسر الاستبدال.
    rendering = true;
    try { dialog.innerHTML = `<div class="rl-sheet" data-step="${st.step}">${body}</div>`; } finally { rendering = false; }
}

function header(title, sub) {
    return `<header class="rl-head">
        <div class="rl-head-text"><h2 id="rlTitle">${esc(title)}</h2><p>${esc(sub)}</p></div>
        <button type="button" class="rl-icon-btn" data-act="close" aria-label="إغلاق">${RELAY_ICONS.close}</button>
    </header>`;
}

function select(id, options, value, label) {
    return `<label class="rl-select"><span class="rl-sr">${esc(label)}</span>
        <select id="${id}" aria-label="${esc(label)}">${Object.entries(options).map(([k, v]) =>
            `<option value="${esc(k)}" ${k === value ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>`;
}

function renderSelect() {
    const visible = filterMessages(st.messages, st.filters);
    const chosen = orderedSelection(st.messages, st.selected);
    const first = st.messages[0]?.created_at;
    const rows = visible.map((m) => {
        const kind = messageSender(m);
        const on = st.selected.includes(m.id);
        const { selectable, reason } = selectability(m);
        const text = String(m.message_text || '').trim() || reason;
        return `<li><label class="rl-msg ${on ? 'is-on' : ''} ${selectable ? '' : 'is-off'}" data-msg="${esc(m.id)}">
            <span class="rl-msg-icon rl-msg-icon--${kind}">${SENDER_ICON[kind]}</span>
            <span class="rl-msg-text">${esc(text)}</span>
            <span class="rl-badge rl-badge--${kind}">${esc(SENDER_LABEL[kind])}</span>
            <span class="rl-msg-time"><b>${esc(shortTime(m.created_at))}</b><small>${esc(shortDate(m.created_at))}</small></span>
            <input type="checkbox" class="rl-check" data-pick="${esc(m.id)}" ${on ? 'checked' : ''} ${selectable ? '' : 'disabled'}
                   aria-label="${esc(`${SENDER_LABEL[kind]} ${shortTime(m.created_at)}: ${text.slice(0, 80)}`)}">
        </label></li>`;
    }).join('');
    const chips = chosen.map((m) => {
        const kind = messageSender(m);
        return `<li class="rl-chip">
            <span class="rl-chip-icon">${SENDER_ICON[kind]}</span>
            <span class="rl-chip-text"><span>${esc(String(m.message_text || '').slice(0, 60))}</span><small>${esc(shortTime(m.created_at))}</small></span>
            <button type="button" class="rl-chip-x" data-unpick="${esc(m.id)}" aria-label="إزالة الرسالة من الاختيار">${RELAY_ICONS.close}</button>
        </li>`;
    }).join('');
    return `${header('اختيار الرسائل', 'اختر الرسائل التي تريد إرفاقها بسجل Relay')}
    <div class="rl-body">
      <div class="rl-filters">
        <label class="rl-search">${RELAY_ICONS.search}<span class="rl-sr">بحث في الرسائل</span>
            <input type="search" id="rlSearch" placeholder="البحث في الرسائل..." value="${esc(st.filters.query)}" autocomplete="off"></label>
        ${select('rlTime', TIME_FILTERS, st.filters.time, 'الوقت')}
        ${select('rlParticipant', PARTICIPANT_FILTERS, st.filters.participant, 'المشاركون')}
        ${select('rlType', TYPE_FILTERS, st.filters.type, 'نوع الرسالة')}
      </div>
      <section class="rl-conv" aria-label="المحادثة">
        <div class="rl-conv-head">
          <span class="rl-avatar">${RELAY_ICONS.chat}</span>
          <div class="rl-conv-who"><b>${esc(st.customerName || 'عميل')}</b>${st.customerContact ? `<small dir="ltr">${esc(st.customerContact)}</small>` : ''}</div>
          <div class="rl-conv-meta"><span>${esc(countLabel(st.messages.length))}</span>${first ? `<span>${RELAY_ICONS.clock}${esc(ageLabel(first))}</span>` : ''}</div>
        </div>
        ${visible.length ? `<ul class="rl-msgs" id="rlMessages">${rows}</ul>`
            : `<p class="rl-empty" id="rlNoMatch">مفيش رسائل مطابقة للبحث أو الفلاتر.</p>`}
      </section>
      <section class="rl-tray" aria-live="polite">
        <h3 id="rlCount" tabindex="-1">${st.selected.length ? `تم اختيار <b>${st.selected.length}</b> ${st.selected.length === 1 ? 'رسالة' : 'رسائل'}` : 'لم يتم اختيار رسائل بعد'}</h3>
        ${chips ? `<ul class="rl-chips">${chips}</ul>` : ''}
        ${st.limitHit ? `<p class="rl-warn">الحد الأقصى ${LIMITS.sourcesPerRequest} رسالة في المرة.</p>` : ''}
      </section>
    </div>
    <footer class="rl-actions">
      <button type="button" class="btn btn-primary" data-act="to-type" id="rlAttach" ${st.selected.length ? '' : 'disabled'}>إرفاق الرسائل المحددة</button>
      <button type="button" class="btn btn-secondary" data-act="close">إلغاء</button>
    </footer>`;
}

function bubble(m) {
    const kind = messageSender(m);
    return `<li class="rl-bubble-row rl-bubble-row--${kind}">
        <span class="rl-msg-icon rl-msg-icon--${kind}">${SENDER_ICON[kind]}</span>
        <div class="rl-bubble"><div class="rl-bubble-meta"><b>${esc(kind === 'customer' ? (st.customerName || SENDER_LABEL.customer) : SENDER_LABEL[kind])}</b>
            <span>${esc(shortTime(m.created_at))}</span></div>
            <p>${esc(m.message_text)}</p></div>
    </li>`;
}

function renderType() {
    const chosen = orderedSelection(st.messages, st.selected);
    const sug = st.suggestion;
    const sugMeta = sug ? CATEGORY_META[sug.category] : null;
    const grid = RECORD_CATEGORIES.map((c) => {
        const meta = CATEGORY_META[c];
        const on = st.category === c;
        return `<button type="button" role="radio" aria-checked="${on}" class="rl-type ${on ? 'is-on' : ''}" data-category="${c}">
            <span class="rl-type-icon">${RELAY_ICONS[meta.icon]}</span><span>${esc(meta.label)}</span></button>`;
    }).join('');
    return `${header('معاينة النوع', 'سيتم تحديد النوع المقترح تلقائيًا بناءً على الرسائل المختارة. يمكنك تعديل النوع إذا لزم الأمر.')}
    <div class="rl-body">
      <section class="rl-card">
        <h3>الرسائل المختارة (${chosen.length})</h3>
        <ul class="rl-bubbles">${chosen.map(bubble).join('')}</ul>
      </section>
      <section class="rl-suggest ${sug ? '' : 'is-none'}" id="rlSuggest">
        <h3>النوع المقترح</h3>
        ${sug ? `<div class="rl-suggest-row">
            <span class="rl-type-icon">${RELAY_ICONS[sugMeta.icon]}</span><b id="rlSuggested">${esc(sugMeta.label)}</b>
            <span class="rl-reco">${RELAY_ICONS.sparkle}موصى به</span>
            <button type="button" class="rl-icon-btn rl-expand" data-act="why" aria-expanded="${st.detailsOpen}" aria-controls="rlWhy" aria-label="سبب الاقتراح">${RELAY_ICONS.chevron}</button>
          </div>
          <p class="rl-muted">تم اقتراح هذا النوع بناءً على محتوى الرسائل المختارة.</p>
          <p class="rl-muted rl-why" id="rlWhy" ${st.detailsOpen ? '' : 'hidden'}>اعتمد الاقتراح على: ${sug.matched.map((w) => `«${esc(w)}»`).join('، ')}. الاقتراح لا يُحفظ إلا لما تأكده.</p>`
            : `<p class="rl-muted">مفيش نوع واضح من الرسائل دي. اختار النوع المناسب من القائمة.</p>`}
      </section>
      <section>
        <h3 class="rl-h">اختيار نوع آخر</h3>
        <div class="rl-types" role="radiogroup" aria-label="نوع السجل">${grid}</div>
      </section>
      <label class="rl-field"><span>ملاحظات إضافية (اختياري)</span>
        <textarea id="rlNote" maxlength="${LIMITS.summary}" placeholder="أضف أي تفاصيل إضافية تساعد في تصنيف هذا السجل...">${esc(st.note)}</textarea>
        <small class="rl-muted">اكتب بكلامك. الرسائل نفسها بتتحفظ كمصادر، فمتنسخش نصها هنا ولا تكتب بيانات حساسة.</small></label>
    </div>
    <footer class="rl-actions">
      <button type="button" class="btn btn-primary" data-act="to-details" id="rlConfirmType" ${st.category ? '' : 'disabled'}>تأكيد النوع والمتابعة</button>
      <button type="button" class="btn btn-secondary" data-act="back">رجوع</button>
    </footer>`;
}

function renderDetails() {
    const d = st.draft;
    const canAssign = Boolean(st.access.can_assign);
    const missing = st.mode === 'new' ? missingFields(d) : [];
    const owners = ownerOptions({ agents: st.agents, meId: st.me?.id, canAssign });
    const catLabel = CATEGORY_META[st.category]?.label;
    const sensitive = st.sensitive.length ? `<div class="rl-alert" role="alert" id="rlSensitive">
        <p>الرسائل المختارة يبدو إن فيها بيانات حساسة (${esc(st.sensitive.join('، '))}). المقتطف هيتحفظ ويظهر لكل من يصل للمحادثة.</p>
        <label class="rl-check-row"><input type="checkbox" id="rlAck" ${d.sensitiveAck ? 'checked' : ''}> أفهم ذلك وأريد المتابعة</label></div>` : '';
    const modes = `<div class="rl-seg" role="radiogroup" aria-label="وجهة الرسائل">
        <button type="button" role="radio" aria-checked="${st.mode === 'new'}" class="${st.mode === 'new' ? 'is-on' : ''}" data-mode="new">سجل جديد</button>
        <button type="button" role="radio" aria-checked="${st.mode === 'existing'}" class="${st.mode === 'existing' ? 'is-on' : ''}" data-mode="existing">إرفاق بسجل موجود</button></div>`;

    let main;
    if (st.mode === 'existing') {
        const list = st.existing;
        main = list === null ? '<p class="rl-muted">بيحمّل السجلات…</p>'
            : list.length === 0 ? '<p class="rl-empty">مفيش سجلات نشطة تقدر توصلها.</p>'
                : `<div class="rl-pick" role="radiogroup" aria-label="السجل">${list.map((r) => `
                    <button type="button" role="radio" aria-checked="${st.existingId === r.id}" class="rl-pick-row ${st.existingId === r.id ? 'is-on' : ''}" data-record="${esc(r.id)}">
                      <b>${esc(r.title)}</b><small>${esc(KIND_META[r.kind]?.label || r.kind)}${r.category ? ` · ${esc(CATEGORY_META[r.category]?.label || '')}` : ''} · ${r.source_count} مصدر</small></button>`).join('')}</div>`;
    } else {
        const dueChips = st.dueCandidates.map((c, i) => {
            const m = st.messages.find((x) => x.id === c.messageId);
            return `<li><button type="button" class="rl-due-chip" data-due="${i}" ${c.past ? 'disabled' : ''}>
                ${RELAY_ICONS.calendar}<span>${esc(c.at.replace('T', ' '))}</span>
                <small>من رسالة ${esc(shortTime(m?.created_at))}: «${esc(c.literal)}»${c.timeStated ? '' : ' — الساعة مش مكتوبة'}${c.past ? ' — الموعد فات' : ''}</small></button></li>`;
        }).join('');
        main = `
        <div class="rl-kinds" role="radiogroup" aria-label="نوع السجل">${Object.entries(KIND_META).map(([k, v]) => `
            <button type="button" role="radio" aria-checked="${d.kind === k}" class="rl-kind ${d.kind === k ? 'is-on' : ''}" data-kind="${k}">
              <b>${esc(v.label)}</b><small>${esc(v.hint)}</small></button>`).join('')}</div>
        <label class="rl-field"><span>العنوان <i>مطلوب</i></span>
          <input type="text" id="rlTitleInput" maxlength="${LIMITS.title}" value="${esc(d.title)}" placeholder="${esc(titlePlaceholder(d.kind, st.category))}"></label>
        <label class="rl-field"><span>${d.kind === 'issue' ? 'وصف المشكلة <i>مطلوب</i>' : 'الملخص (اختياري)'}</span>
          <textarea id="rlSummary" maxlength="${LIMITS.summary}" placeholder="بكلامك: إيه المطلوب ومين مستني إيه">${esc(d.summary)}</textarea></label>
        <label class="rl-field"><span>الخطوة التالية ${d.kind === 'follow_up' ? '<i>مطلوب</i>' : '(اختياري)'}</span>
          <input type="text" id="rlNext" maxlength="${LIMITS.nextAction}" value="${esc(d.nextAction)}" placeholder="مثال: الاتصال بالعميل لتأكيد موعد التسليم"></label>
        <div class="rl-row">
          <label class="rl-field"><span>الموعد ${d.kind === 'follow_up' ? '<i>مطلوب</i>' : '(اختياري)'}</span>
            <input type="datetime-local" id="rlDue" value="${esc(d.dueAt)}"></label>
          <label class="rl-field"><span>المنطقة الزمنية</span>
            <select id="rlTz">${[...new Set([d.dueTz, ...TIMEZONES])].map((z) => `<option value="${esc(z)}" ${z === d.dueTz ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select></label>
        </div>
        ${dueChips ? `<div class="rl-dues"><span class="rl-muted">مواعيد مكتوبة في الرسائل:</span><ul>${dueChips}</ul></div>` : ''}
        <div class="rl-row">
          <label class="rl-field"><span>المالك</span>
            <select id="rlOwner">${owners.map((o) => `<option value="${esc(o.value)}" ${o.value === (d.ownerId || '') ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>
          ${canAssign && st.teams.length ? `<label class="rl-field"><span>الفريق (اختياري)</span>
            <select id="rlTeam"><option value="">بدون فريق</option>${st.teams.map((t) => `<option value="${esc(t.id)}" ${t.id === d.teamId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>` : ''}
          <label class="rl-field"><span>الأولوية</span>
            <select id="rlPriority">${Object.entries(PRIORITY_LABELS).map(([k, v]) => `<option value="${k}" ${Number(k) === Number(d.priority) ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
        </div>
        ${canAssign ? '' : '<p class="rl-muted" id="rlOwnerHint">تقدر تخلي السجل باسمك أو من غير مالك. الإسناد لموظف تاني للمشرفين ومن عنده صلاحية إسناد.</p>'}
        ${missing.length ? `<div class="rl-missing" id="rlMissing"><b>ناقص قبل الإنشاء:</b> ${missing.map((m) => esc(m.label)).join('، ')}</div>` : ''}`;
    }

    const disabled = st.busy || (st.mode === 'new' ? missing.length > 0 : !st.existingId) || (st.sensitive.length && !d.sensitiveAck);
    return `${header('تفاصيل السجل', `${countLabel(st.selected.length)} · ${catLabel ? `النوع: ${catLabel}` : ''}`)}
    <div class="rl-body">
      ${modes}
      ${main}
      ${sensitive}
      <div class="rl-error" id="rlError" role="alert">${esc(st.error)}</div>
    </div>
    <footer class="rl-actions">
      <button type="button" class="btn btn-primary" data-act="submit" id="rlSubmit" ${disabled ? 'disabled' : ''} aria-busy="${st.busy}">
        ${st.busy ? 'جاري الحفظ…' : st.mode === 'new' ? 'إنشاء سجل استمرارية' : 'إرفاق بالسجل'}</button>
      <button type="button" class="btn btn-secondary" data-act="back" ${st.busy ? 'disabled' : ''}>رجوع</button>
    </footer>`;
}

// ═════════════════════════════════════════════════════════════
// الأحداث
// ═════════════════════════════════════════════════════════════
function rerenderKeepingFocus() {
    const active = document.activeElement;
    const id = active?.id;
    const pos = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
    const pick = active?.dataset?.pick;
    render();
    const again = id ? dialog.querySelector(`#${CSS.escape(id)}`) : pick ? dialog.querySelector(`[data-pick="${CSS.escape(pick)}"]`) : null;
    if (again) {
        again.focus();
        if (pos && 'setSelectionRange' in again) { try { again.setSelectionRange(...pos); } catch { /* نوع لا يدعمها */ } }
    }
}

function onInput(event) {
    if (!st || rendering) return;
    const t = event.target;
    const d = st.draft;
    switch (t.id) {
    case 'rlSearch': st.filters.query = t.value; return rerenderKeepingFocus();
    case 'rlTime': st.filters.time = t.value; return rerenderKeepingFocus();
    case 'rlParticipant': st.filters.participant = t.value; return rerenderKeepingFocus();
    case 'rlType': st.filters.type = t.value; return rerenderKeepingFocus();
    case 'rlNote': st.note = t.value; return undefined;
    case 'rlTitleInput': d.title = t.value; break;
    case 'rlSummary': d.summary = t.value; break;
    case 'rlNext': d.nextAction = t.value; break;
    case 'rlDue': d.dueAt = t.value; break;
    case 'rlTz': d.dueTz = t.value; break;
    case 'rlOwner': d.ownerId = t.value; break;
    case 'rlTeam': d.teamId = t.value; break;
    case 'rlPriority': d.priority = Number(t.value); break;
    case 'rlAck': d.sensitiveAck = t.checked; break;
    default:
        if (t.dataset.pick && event.type === 'change') {
            const m = st.messages.find((x) => x.id === t.dataset.pick);
            const r = toggleSelection(st.selected, m);
            st.selected = r.selected;
            st.limitHit = r.error === 'limit';
            return rerenderKeepingFocus();
        }
        return undefined;
    }
    if (['rlTitleInput', 'rlSummary', 'rlNext', 'rlDue', 'rlAck'].includes(t.id)) {
        // تحديث الحقول الناقصة وحالة الزر بلا إعادة رسم: إعادة الرسم على change (عند مغادرة الحقل)
        // كانت بتسرق التركيز من الحقل التالي فيتكتب النص في الحقل الغلط.
        return refreshDetailsState();
    }
    return rerenderKeepingFocus();
}

function refreshDetailsState() {
    const missing = st.mode === 'new' ? missingFields(st.draft) : [];
    const box = dialog.querySelector('#rlMissing');
    if (missing.length) {
        const html = `<b>ناقص قبل الإنشاء:</b> ${missing.map((m) => esc(m.label)).join('، ')}`;
        if (box) box.innerHTML = html;
        else rerenderKeepingFocus();
    } else if (box) box.remove();
    const btn = dialog.querySelector('#rlSubmit');
    if (btn) btn.disabled = st.busy || (st.mode === 'new' ? missing.length > 0 : !st.existingId)
        || (st.sensitive.length > 0 && !st.draft.sensitiveAck);
}

function goType() {
    const chosen = orderedSelection(st.messages, st.selected);
    st.suggestion = suggestCategory(chosen);
    if (!st.category) st.category = st.suggestion?.category ?? null;
    st.step = 'type';
    render();
    dialog.querySelector('[role="radio"][aria-checked="true"], #rlNote')?.focus();
}

function goDetails() {
    const chosen = orderedSelection(st.messages, st.selected);
    const d = st.draft;
    if (!d.kind) d.kind = suggestKind(st.category);
    // الملاحظات كلام المستخدم نفسه (ليست نص رسالة) ⇒ تبدأ بها خانة الملخص.
    if (!d.summary && st.note.trim()) d.summary = st.note.trim();
    st.dueCandidates = detectDueCandidates(chosen, { tz: d.dueTz });
    st.sensitive = [...new Set(chosen.flatMap((m) => sensitiveKinds(m.message_text)))].map((k) => ({
        national_id: 'رقم قومي', card_number: 'رقم كارت', otp: 'كود تحقق', password: 'كلمة سر',
    }[k] || k));
    st.step = 'details';
    st.error = '';
    render();
    dialog.querySelector('#rlTitleInput')?.focus();
}

async function loadExisting() {
    st.existing = null;
    render();
    try {
        const rows = await listRecords({ status: ['open', 'scheduled', 'in_progress', 'waiting'], limit: 50 });
        if (!st) return;
        st.existing = rows || [];
    } catch (err) {
        if (!st) return;
        st.existing = [];
        st.error = err.message || 'تعذر تحميل السجلات.';
    }
    render();
}

function describeError(err) {
    if (err?.code === 'forbidden' && (err.field === 'owner_id' || err.field === 'team_id')) {
        return 'مش مسموح لك تسند السجل لموظف تاني أو لفريق. خليه باسمك أو من غير مالك.';
    }
    if (err?.code === 'not_found' && err.field === 'sources') return 'رسالة أو أكتر من المختارة مبقتش متاحة لك. ارجع وراجع الاختيار.';
    if (err?.code === 'validation_failed' && err.reason === 'sensitive_content') return 'الرسائل فيها بيانات حساسة. أكّد إنك فاهم قبل المتابعة.';
    if (err?.code === 'validation_failed' && err.reason === 'not_eligible') return 'الموظف ده حسابه مش نشط (مش مكمّل التحقق من الحساب أو محظور)، فمينفعش يبقى مالك للسجل.';
    if (err?.code === 'validation_failed' && err.field === 'due.at') return 'راجع الموعد: لازم يكون في المستقبل وخلال سنة.';
    return err?.message || 'حصل خطأ غير متوقع.';
}

async function submit() {
    if (st.busy) return;
    st.busy = true;
    st.error = '';
    render();
    const d = st.draft;
    try {
        let result;
        if (st.mode === 'existing') {
            const rec = st.existing.find((r) => r.id === st.existingId);
            result = await attachSources(rec.id, orderedSelection(st.messages, st.selected).map((m) => m.id), rec.version, d.sensitiveAck);
        } else {
            const base = { ...d, category: st.category, messageIds: orderedSelection(st.messages, st.selected).map((m) => m.id) };
            const fingerprint = JSON.stringify(base);
            // نفس المحتوى بعد فشل شبكة ⇒ نفس المفتاح (الخادم يرجع replayed)، أي تعديل ⇒ مفتاح جديد.
            if (!st.attempt || st.attempt.fingerprint !== fingerprint) st.attempt = { fingerprint, key: newKey() };
            result = await createRecord(buildRequestFromDraft(base, { idempotencyKey: st.attempt.key }));
        }
        const done = st.onDone;
        const mode = st.mode;
        dialog.close();
        done?.({ mode, result });
    } catch (err) {
        if (!st) return;
        st.busy = false;
        st.error = describeError(err);
        if (err?.reason === 'sensitive_content' && !st.sensitive.length) st.sensitive = ['بيانات حساسة'];
        if (err?.code === 'version_conflict' && st.mode === 'existing') { loadExisting(); return; }
        render();
    }
}

function onClick(event) {
    if (!st) return;
    if (event.target === dialog) return; // الضغط على الخلفية لا يقفل (عشان ما يضيعش الاختيار)
    const el = event.target.closest('[data-act], [data-unpick], [data-category], [data-kind], [data-mode], [data-record], [data-due]');
    if (!el || el.disabled) return;
    const { act } = el.dataset;
    if (act === 'close') return dialog.close();
    if (act === 'to-type') return goType();
    if (act === 'to-details') return goDetails();
    if (act === 'back') {
        st.step = st.step === 'details' ? 'type' : 'select';
        st.error = '';
        return render();
    }
    if (act === 'why') { st.detailsOpen = !st.detailsOpen; return render(); }
    if (act === 'submit') return submit();
    if (el.dataset.unpick) {
        st.selected = st.selected.filter((id) => id !== el.dataset.unpick);
        st.limitHit = false;
        render();
        return dialog.querySelector('#rlCount')?.focus?.();
    }
    if (el.dataset.category) {
        st.category = el.dataset.category;
        st.draft.kind = null; // النوع المقترح للسجل يتبع التصنيف الجديد حتى يغيّره المستخدم
        render();
        return dialog.querySelector(`[data-category="${CSS.escape(st.category)}"]`)?.focus();
    }
    if (el.dataset.kind) { st.draft.kind = el.dataset.kind; return rerenderKeepingFocus(); }
    if (el.dataset.mode) {
        st.mode = el.dataset.mode;
        st.error = '';
        if (st.mode === 'existing' && st.existing === null) return loadExisting();
        return render();
    }
    if (el.dataset.record) { st.existingId = el.dataset.record; return render(); }
    if (el.dataset.due) {
        const c = st.dueCandidates[Number(el.dataset.due)];
        if (c && !c.past) { st.draft.dueAt = c.at; st.draft.dueTz = c.tz; render(); }
    }
    return undefined;
}
