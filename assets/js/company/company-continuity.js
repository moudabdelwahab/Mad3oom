/**
 * company-continuity.js — الاستمرارية داخل لوحة الشركة (migrations/146).
 *
 * كل شيء عبر company_continuity_* في company-data.js؛ لا قراءة مباشرة
 * للجداول، ولا معرّف شركة في أي نداء. النطاق مساحة الشركة وحدها، و team_id
 * دائمًا null، والنوع follow_up/issue فقط — التسليم والمشاركات والسياسات
 * والتطهير مؤجَّلة في القاعدة (0A000)، فلا زرّ لها هنا أصلًا، وأي رفض من
 * الخادم يُعرض كما هو بدل إخفائه.
 *
 * الحالة: قائمة بفلاتر وترقيم بالمؤشر (before/before_id)، وعرض سجل واحد
 * (تفاصيل + ملاحظات + أحداث)، وإنشاء بمفتاح تكرار، وتعديل وانتقال وإسناد
 * بنسخة متوقعة — تعارض النسخة (40001) يعيد قراءة السجل ولا يخفيه.
 */
import {
    fetchContinuityAccess, fetchContinuityList, fetchContinuityRecord,
    createContinuityRecord, updateContinuityRecord, transitionContinuityRecord,
    assignContinuityRecord, addContinuityNote, fetchContinuityNotes, fetchContinuityEvents
} from '/assets/js/company/company-data.js';
import {
    CONTINUITY_CATEGORIES, CONTINUITY_KINDS, CONTINUITY_STATUSES,
    continuityListFilters, validateContinuityCreate, validateContinuityNote,
    continuityTransitionRequirement, continuityAvailableTransitions,
    continuityRecordView, continuityStatusLabel, continuityKindLabel,
    continuityCategoryLabel, continuityPriorityLabel, newIdempotencyKey
} from '/assets/js/company/company-continuity-model.js';
import { escapeHtml, formatDate, timeAgo, renderState, renderSkeletonLines } from '/assets/js/customer/portal-ui.js';
import { ui } from '/ui-service.js';

let deps = { getMembers: () => [], getCurrentUserId: () => null };
let wired = false;
let boxEl = null;
let toolbarEl = null;
let bodyEl = null;
let createEl = null;

let access = null;
let filters = { status: '', kind: '', owner: '', category: '' };
let rows = [];
let hasMore = false;
let selectedId = null;
let detail = null; // { record, notes, events }
let creating = false;
let pendingTransition = null; // { to, field, label }

export function initCompanyContinuity(nextDeps) {
    deps = { ...deps, ...nextDeps };
}

/** يُحمَّل عند أول فتح للاستمرارية فقط (LOADERS)؛ يرجّع false حين يفشل فيُعاد تحميله. */
export async function loadCompanyContinuity() {
    const box = document.getElementById('companyContinuity');
    if (!box) return false;
    if (!wired) wired = wire(box);
    if (!wired) return false;

    renderSkeletonLines(bodyEl, 4);
    const res = await fetchContinuityAccess();
    if (!res.ok) {
        renderState(bodyEl, {
            variant: 'error', title: 'تعذّر تحميل الاستمرارية',
            text: res.error || 'تحقق من اتصالك ثم أعد المحاولة.',
            action: { label: 'إعادة المحاولة', retry: 'continuity', variant: 'btn-primary' }
        });
        return false;
    }
    access = res.data;
    if (!access) {
        renderState(bodyEl, {
            variant: 'empty', title: 'الاستمرارية غير متاحة بعد',
            text: 'تُفعَّل مع تحديث قاعدة البيانات (الترحيل 146). لا شيء آخر مطلوب منك.'
        });
        return true;
    }
    if (!access.member) {
        renderState(bodyEl, {
            variant: 'empty', title: 'هذه الصفحة لفريق الشركة',
            text: 'سجلات الاستمرارية يراها ويعدّلها أعضاء فريق الشركة فقط.'
        });
        return true;
    }
    toolbarEl.hidden = false;
    return reloadList();
}

function wire(box) {
    boxEl = box;
    boxEl.innerHTML = `
        <div class="company-continuity-toolbar" id="companyContinuityToolbar" hidden>
            <div class="company-continuity-filters">
                <label>الحالة
                    <select data-continuity-filter="status">
                        <option value="">الكل</option>
                        ${CONTINUITY_STATUSES.map(s => `<option value="${s.value}">${escapeHtml(s.label)}</option>`).join('')}
                    </select></label>
                <label>النوع
                    <select data-continuity-filter="kind">
                        <option value="">الكل</option>
                        ${CONTINUITY_KINDS.map(k => `<option value="${k.value}">${escapeHtml(k.label)}</option>`).join('')}
                    </select></label>
                <label>المالك
                    <select data-continuity-filter="owner">
                        <option value="">الكل</option>
                        <option value="me">المسندة إليّ</option>
                        <option value="unassigned">بلا مالك</option>
                    </select></label>
                <label>التصنيف
                    <select data-continuity-filter="category">
                        <option value="">الكل</option>
                        ${CONTINUITY_CATEGORIES.map(c => `<option value="${c.value}">${escapeHtml(c.label)}</option>`).join('')}
                    </select></label>
            </div>
            <button type="button" class="btn btn-primary btn-sm" data-continuity-action="new">سجل جديد</button>
        </div>
        <div id="companyContinuityCreate" hidden></div>
        <div id="companyContinuityBody"></div>`;
    toolbarEl = boxEl.querySelector('#companyContinuityToolbar');
    bodyEl = boxEl.querySelector('#companyContinuityBody');
    createEl = boxEl.querySelector('#companyContinuityCreate');
    boxEl.addEventListener('click', onClick);
    boxEl.addEventListener('change', onChange);
    boxEl.addEventListener('submit', onSubmit);
    return true;
}

function memberName(id) {
    if (!id) return 'بلا مالك';
    if (id === deps.getCurrentUserId?.()) return 'أنت';
    const m = (deps.getMembers?.() || []).find(x => x.id === id);
    return m ? (m.name || m.email || 'عضو') : 'عضو';
}

function localTz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Cairo'; } catch { return 'Africa/Cairo'; }
}

function toLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ── القائمة ───────────────────────────────────────────────────────────── */

async function reloadList() {
    selectedId = null;
    detail = null;
    createEl.hidden = true;
    creating = false;
    renderSkeletonLines(bodyEl, 4);
    const res = await fetchContinuityList(continuityListFilters(filters));
    if (!res.ok) {
        renderState(bodyEl, {
            variant: 'error', title: 'تعذّر تحميل السجلات',
            text: res.error || 'تحقق من اتصالك ثم أعد المحاولة.',
            action: { label: 'إعادة المحاولة', retry: 'continuity', variant: 'btn-primary' }
        });
        return false;
    }
    rows = Array.isArray(res.data) ? res.data : [];
    hasMore = rows.length >= (continuityListFilters(filters).limit || 50);
    renderList();
    return true;
}

function renderList() {
    if (!access?.enabled && !rows.length) {
        bodyEl.innerHTML = `<p class="panel-subtitle">لا توجد سجلات استمرارية بعد — أنشئ أول سجل لتفعيل المساحة.</p>`;
        return;
    }
    bodyEl.innerHTML = listHtml();
}

function listHtml() {
    if (!rows.length) {
        return `<p class="panel-subtitle">لا توجد سجلات تطابق هذه الفلاتر — جرّب توسيعها أو أنشئ سجلًا جديدًا.</p>`;
    }
    return `
        <ul class="company-sub-list">${rows.map(r => {
            const v = continuityRecordView(r);
            return `
            <li class="company-sub is-clickable" data-continuity-open="${escapeHtml(v.id)}" tabindex="0" role="button">
                <div class="company-sub-main">
                    <p class="company-sub-plan">${escapeHtml(v.title)}</p>
                    <p class="company-sub-dates">${escapeHtml(v.kindLabel)} · ${escapeHtml(v.statusLabel)}
                        · أولوية ${escapeHtml(v.priorityLabel)} · ${escapeHtml(v.categoryLabel)}</p>
                    ${v.nextAction ? `<p class="company-sub-dates">الخطوة التالية: ${escapeHtml(v.nextAction)}</p>` : ''}
                    <p class="company-sub-dates">${escapeHtml(memberName(v.ownerId))}
                        ${v.dueAt ? ` · الموعد ${escapeHtml(formatDate(v.dueAt))}` : ''} · آخر تحديث ${escapeHtml(timeAgo(v.updatedAt))}</p>
                </div>
                <div class="company-sub-side">
                    ${v.overdue ? '<span class="pill status-tone-warning">متأخر</span>' : ''}
                    ${v.closed ? '<span class="pill">مغلق</span>' : ''}
                </div>
            </li>`;
        }).join('')}</ul>
        ${hasMore ? `<button type="button" class="btn btn-secondary btn-sm" data-continuity-action="more">عرض المزيد</button>` : ''}`;
}

/* ── الإنشاء ───────────────────────────────────────────────────────────── */

function renderCreate() {
    creating = true;
    createEl.hidden = false;
    createEl.innerHTML = `
        <form class="company-continuity-form" data-continuity-form="create">
            <h3 class="panel-title">سجل استمرارية جديد</h3>
            <div class="form-field">
                <label for="continuityNewKind">النوع</label>
                <select id="continuityNewKind" name="kind" class="form-control">
                    ${CONTINUITY_KINDS.map(k => `<option value="${k.value}">${escapeHtml(k.label)}</option>`).join('')}
                </select>
            </div>
            <div class="form-field">
                <label for="continuityNewTitle">العنوان (حتى 160 حرفًا)</label>
                <input id="continuityNewTitle" name="title" class="form-control" maxlength="160" required>
            </div>
            <div class="form-field">
                <label for="continuityNewSummary">ملخص</label>
                <textarea id="continuityNewSummary" name="summary" class="form-control" rows="2" maxlength="4000"></textarea>
            </div>
            <div class="form-field">
                <label for="continuityNewNextAction">الخطوة التالية</label>
                <input id="continuityNewNextAction" name="next_action" class="form-control" maxlength="1000">
                <p class="panel-subtitle">إلزامية للمتابعة، مع موعدها أدناه.</p>
            </div>
            <div class="form-field">
                <label for="continuityNewDue">موعد الخطوة التالية</label>
                <input id="continuityNewDue" name="due_at" type="datetime-local" class="form-control">
            </div>
            <div class="form-field">
                <label for="continuityNewPriority">الأولوية</label>
                <select id="continuityNewPriority" name="priority" class="form-control">
                    <option value="1">عاجلة</option><option value="2">مرتفعة</option>
                    <option value="3" selected>عادية</option><option value="4">منخفضة</option>
                </select>
            </div>
            <div class="form-field">
                <label for="continuityNewCategory">التصنيف</label>
                <select id="continuityNewCategory" name="category" class="form-control">
                    <option value="">بلا تصنيف</option>
                    ${CONTINUITY_CATEGORIES.map(c => `<option value="${c.value}">${escapeHtml(c.label)}</option>`).join('')}
                </select>
            </div>
            ${access?.can_assign ? `
            <div class="form-field">
                <label for="continuityNewOwner">إسناد إلى</label>
                <select id="continuityNewOwner" name="owner_id" class="form-control">
                    <option value="">بلا مالك</option>
                    ${(deps.getMembers?.() || []).map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name || m.email || 'عضو')}</option>`).join('')}
                </select>
            </div>` : ''}
            <fieldset class="company-continuity-issue" data-continuity-issue-fields hidden>
                <legend>تفاصيل المشكلة</legend>
                <div class="form-field">
                    <label for="continuityNewProblem">وصف المشكلة (إلزامي)</label>
                    <textarea id="continuityNewProblem" name="problem" class="form-control" rows="2" maxlength="4000"></textarea>
                </div>
                <div class="form-field">
                    <label for="continuityNewKnown">معلومات معروفة</label>
                    <textarea id="continuityNewKnown" name="known_facts" class="form-control" rows="2" maxlength="4000"></textarea>
                </div>
                <div class="form-field">
                    <label for="continuityNewUnknowns">معلومات ناقصة</label>
                    <textarea id="continuityNewUnknowns" name="unknowns" class="form-control" rows="2" maxlength="4000"></textarea>
                </div>
                <div class="form-field">
                    <label for="continuityNewCriteria">معايير الحل</label>
                    <textarea id="continuityNewCriteria" name="resolution_criteria" class="form-control" rows="2" maxlength="4000"></textarea>
                </div>
            </fieldset>
            <p class="field-error" data-continuity-error role="alert" hidden></p>
            <div class="company-form-actions">
                <button type="submit" class="btn btn-primary">إنشاء السجل</button>
                <button type="button" class="btn btn-secondary" data-continuity-action="cancel-new">إلغاء</button>
            </div>
        </form>`;
    createEl.querySelector('#continuityNewKind')?.focus();
}

function showCreateError(msg) {
    const el = createEl.querySelector('[data-continuity-error]');
    if (el) { el.hidden = false; el.textContent = msg; }
}

async function submitCreate(form) {
    const data = new FormData(form);
    const kind = String(data.get('kind') || 'follow_up');
    const title = String(data.get('title') || '');
    const nextAction = String(data.get('next_action') || '').trim();
    const dueRaw = String(data.get('due_at') || '');
    const problem = String(data.get('problem') || '').trim();
    const check = validateContinuityCreate({
        kind, title, nextAction, dueAt: dueRaw || null, problem
    });
    if (!check.ok) { showCreateError(check.error); return; }
    const request = {
        contract_version: '1',
        idempotency_key: newIdempotencyKey(),
        kind,
        title: title.trim(),
        summary: String(data.get('summary') || '').trim() || undefined,
        next_action: nextAction || undefined,
        priority: Number(data.get('priority') || 3),
        category: String(data.get('category') || '') || null,
        due: dueRaw ? { at: new Date(dueRaw).toISOString(), tz: localTz() } : undefined,
        owner_id: String(data.get('owner_id') || '') || undefined,
        issue: kind === 'issue' ? {
            problem,
            known_facts: String(data.get('known_facts') || '').trim() || undefined,
            unknowns: String(data.get('unknowns') || '').trim() || undefined,
            resolution_criteria: String(data.get('resolution_criteria') || '').trim() || undefined
        } : undefined
    };
    const res = await createContinuityRecord(request);
    if (!res.ok) { showCreateError(res.error || 'تعذّر إنشاء السجل. حاول مرة أخرى.'); return; }
    ui?.showToast?.(res.data?.replayed ? 'السجل موجود بالفعل — فُتح بدل إنشاء مكرر' : 'تم إنشاء السجل', 'success');
    createEl.hidden = true;
    creating = false;
    await reloadList();
    if (res.data?.record?.id) await openRecord(res.data.record.id);
}

/* ── التفاصيل ──────────────────────────────────────────────────────────── */

async function openRecord(id) {
    selectedId = id;
    renderSkeletonLines(bodyEl, 4);
    const [got, notesRes, eventsRes] = await Promise.all([
        fetchContinuityRecord(id), fetchContinuityNotes(id), fetchContinuityEvents(id)
    ]);
    if (!got.ok || !got.data?.record) {
        ui?.showToast?.(got.error || 'تعذّر فتح السجل', 'error');
        await reloadList();
        return;
    }
    detail = {
        record: continuityRecordView(got.data.record),
        raw: got.data.record,
        notes: Array.isArray(notesRes.data) ? notesRes.data : [],
        events: Array.isArray(eventsRes.data) ? eventsRes.data : []
    };
    pendingTransition = null;
    renderDetail();
}

const EVENT_LABELS = {
    created: 'أُنشئ السجل', updated: 'تعديل', transitioned: 'تغيير حالة',
    resolved: 'تم حلّه', cancelled: 'أُلغي', reopened: 'أُعيد فتحه',
    assigned: 'إسناد', note_added: 'ملاحظة جديدة'
};

function renderDetail() {
    const v = detail.record;
    const transitions = continuityAvailableTransitions(v.status);
    const canEdit = access?.supervisor || v.ownerId === deps.getCurrentUserId?.() || detail.raw.created_by === deps.getCurrentUserId?.();
    bodyEl.innerHTML = `
        <button type="button" class="btn btn-secondary btn-sm" data-continuity-action="back">‹ رجوع إلى القائمة</button>
        <h3 class="panel-title">${escapeHtml(v.title)}</h3>
        <p class="panel-subtitle">${escapeHtml(v.kindLabel)} · ${escapeHtml(v.statusLabel)} · أولوية ${escapeHtml(v.priorityLabel)}
            · ${escapeHtml(v.categoryLabel)} · المالك: ${escapeHtml(memberName(v.ownerId))}</p>
        ${v.overdue ? '<p class="panel-subtitle"><span class="pill status-tone-warning">متأخر عن موعده</span></p>' : ''}
        ${v.summary ? `<p>${escapeHtml(v.summary)}</p>` : ''}
        ${v.nextAction ? `<p><strong>الخطوة التالية:</strong> ${escapeHtml(v.nextAction)}${v.dueAt ? ` — ${escapeHtml(formatDate(v.dueAt))}` : ''}</p>` : ''}
        ${v.kind === 'issue' ? `
            ${v.problem ? `<p><strong>المشكلة:</strong> ${escapeHtml(v.problem)}</p>` : ''}
            ${v.knownFacts ? `<p><strong>معلومات معروفة:</strong> ${escapeHtml(v.knownFacts)}</p>` : ''}
            ${v.unknowns ? `<p><strong>معلومات ناقصة:</strong> ${escapeHtml(v.unknowns)}</p>` : ''}
            ${v.resolutionCriteria ? `<p><strong>معايير الحل:</strong> ${escapeHtml(v.resolutionCriteria)}</p>` : ''}` : ''}
        <p class="panel-subtitle">آخر تحديث ${escapeHtml(timeAgo(v.updatedAt))} · النسخة ${escapeHtml(String(v.version))}</p>
        <div class="company-continuity-actions">
            ${transitions.map(t => `<button type="button" class="btn btn-secondary btn-sm"
                data-continuity-transition="${escapeHtml(t.to)}">${escapeHtml(t.label)}</button>`).join('')}
            ${canEdit && !v.closed ? `<button type="button" class="btn btn-secondary btn-sm" data-continuity-action="edit">تعديل</button>` : ''}
            ${access?.can_assign ? `
                <label>إسناد إلى
                    <select data-continuity-assign>
                        <option value="">بلا مالك</option>
                        ${(deps.getMembers?.() || []).map(m => `<option value="${escapeHtml(m.id)}"${m.id === v.ownerId ? ' selected' : ''}>${escapeHtml(m.name || m.email || 'عضو')}</option>`).join('')}
                    </select></label>` : ''}
        </div>
        <div data-continuity-transition-box></div>
        <div data-continuity-edit-box></div>
        <h4 class="panel-title">الملاحظات</h4>
        ${detail.notes.length ? `<ul class="company-sub-list">${detail.notes.map(n => `
            <li class="company-sub"><div class="company-sub-main">
                <p class="company-sub-plan">${escapeHtml(n.body || '')}</p>
                <p class="company-sub-dates">${escapeHtml(memberName(n.author_id))} · ${escapeHtml(formatDate(n.created_at))}</p>
            </div></li>`).join('')}</ul>`
            : '<p class="panel-subtitle">لا ملاحظات بعد.</p>'}
        ${canEdit ? `
        <form data-continuity-form="note">
            <div class="form-field">
                <label for="continuityNoteBody">أضف ملاحظة (حتى 2000 حرف)</label>
                <textarea id="continuityNoteBody" name="body" class="form-control" rows="2" maxlength="2000"></textarea>
            </div>
            <p class="field-error" data-continuity-note-error role="alert" hidden></p>
            <button type="submit" class="btn btn-primary btn-sm">إضافة الملاحظة</button>
        </form>` : ''}
        <h4 class="panel-title">الأحداث</h4>
        ${detail.events.length ? `<ul class="company-sub-list">${detail.events.map(e => `
            <li class="company-sub"><div class="company-sub-main">
                <p class="company-sub-plan">${escapeHtml(EVENT_LABELS[e.kind] || e.kind || '')}</p>
                <p class="company-sub-dates">${escapeHtml(memberName(e.actor_id))} · ${escapeHtml(formatDate(e.created_at))}</p>
            </div></li>`).join('')}</ul>`
            : '<p class="panel-subtitle">لا أحداث مسجلة بعد.</p>'}
        <p class="panel-subtitle">سجلات الشركة بلا مصادر مرفقة وبلا تسليمات في هذه المرحلة — ما رفضه الخادم يظهر كما هو.</p>`;
}

function renderTransitionBox() {
    const box = bodyEl.querySelector('[data-continuity-transition-box]');
    if (!box) return;
    if (!pendingTransition) { box.innerHTML = ''; return; }
    box.innerHTML = `
        <form data-continuity-form="transition">
            <div class="form-field">
                <label for="continuityTransitionDetail">${escapeHtml(pendingTransition.label)}</label>
                <textarea id="continuityTransitionDetail" name="detail" class="form-control" rows="2" required></textarea>
            </div>
            <p class="field-error" data-continuity-transition-error role="alert" hidden></p>
            <div class="company-form-actions">
                <button type="submit" class="btn btn-primary btn-sm">تأكيد</button>
                <button type="button" class="btn btn-secondary btn-sm" data-continuity-action="cancel-transition">إلغاء</button>
            </div>
        </form>`;
    box.querySelector('#continuityTransitionDetail')?.focus();
}

function renderEditBox() {
    const box = bodyEl.querySelector('[data-continuity-edit-box]');
    if (!box) return;
    const v = detail.record;
    box.innerHTML = `
        <form data-continuity-form="edit">
            <h4 class="panel-title">تعديل السجل</h4>
            <div class="form-field"><label for="continuityEditTitle">العنوان</label>
                <input id="continuityEditTitle" name="title" class="form-control" maxlength="160" value="${escapeHtml(v.title)}"></div>
            <div class="form-field"><label for="continuityEditSummary">ملخص</label>
                <textarea id="continuityEditSummary" name="summary" class="form-control" rows="2" maxlength="4000">${escapeHtml(v.summary)}</textarea></div>
            <div class="form-field"><label for="continuityEditNextAction">الخطوة التالية</label>
                <input id="continuityEditNextAction" name="next_action" class="form-control" maxlength="1000" value="${escapeHtml(v.nextAction)}"></div>
            <div class="form-field"><label for="continuityEditDue">موعد الخطوة التالية</label>
                <input id="continuityEditDue" name="due_at" type="datetime-local" class="form-control" value="${escapeHtml(toLocalInput(v.dueAt))}"></div>
            <div class="form-field"><label for="continuityEditPriority">الأولوية</label>
                <select id="continuityEditPriority" name="priority" class="form-control">
                    ${[1, 2, 3, 4].map(p => `<option value="${p}"${p === v.priority ? ' selected' : ''}>${escapeHtml(continuityPriorityLabel(p))}</option>`).join('')}
                </select></div>
            <div class="form-field"><label for="continuityEditCategory">التصنيف</label>
                <select id="continuityEditCategory" name="category" class="form-control">
                    <option value="">بلا تصنيف</option>
                    ${CONTINUITY_CATEGORIES.map(c => `<option value="${c.value}"${c.value === v.category ? ' selected' : ''}>${escapeHtml(c.label)}</option>`).join('')}
                </select></div>
            ${v.kind === 'issue' ? `
            <div class="form-field"><label for="continuityEditProblem">وصف المشكلة</label>
                <textarea id="continuityEditProblem" name="problem" class="form-control" rows="2" maxlength="4000">${escapeHtml(v.problem)}</textarea></div>
            <div class="form-field"><label for="continuityEditKnown">معلومات معروفة</label>
                <textarea id="continuityEditKnown" name="known_facts" class="form-control" rows="2" maxlength="4000">${escapeHtml(v.knownFacts)}</textarea></div>
            <div class="form-field"><label for="continuityEditUnknowns">معلومات ناقصة</label>
                <textarea id="continuityEditUnknowns" name="unknowns" class="form-control" rows="2" maxlength="4000">${escapeHtml(v.unknowns)}</textarea></div>
            <div class="form-field"><label for="continuityEditCriteria">معايير الحل</label>
                <textarea id="continuityEditCriteria" name="resolution_criteria" class="form-control" rows="2" maxlength="4000">${escapeHtml(v.resolutionCriteria)}</textarea></div>` : ''}
            <p class="field-error" data-continuity-edit-error role="alert" hidden></p>
            <div class="company-form-actions">
                <button type="submit" class="btn btn-primary btn-sm">حفظ التعديلات</button>
                <button type="button" class="btn btn-secondary btn-sm" data-continuity-action="cancel-edit">إلغاء</button>
            </div>
        </form>`;
}

async function submitEdit(form) {
    const data = new FormData(form);
    const v = detail.record;
    const patch = {};
    const put = (key, value) => { if (value !== undefined) patch[key] = value; };
    const title = String(data.get('title') || '').trim();
    if (title && title !== v.title) put('title', title);
    const summary = String(data.get('summary') || '').trim();
    if (summary !== v.summary) put('summary', summary || null);
    const nextAction = String(data.get('next_action') || '').trim();
    if (nextAction !== v.nextAction) put('next_action', nextAction || null);
    const priority = Number(data.get('priority') || 3);
    if (priority !== v.priority) put('priority', priority);
    const category = String(data.get('category') || '') || null;
    if (category !== v.category) put('category', category);
    const dueRaw = String(data.get('due_at') || '');
    const dueIso = dueRaw ? new Date(dueRaw).toISOString() : null;
    if ((dueIso || null) !== (v.dueAt || null)) put('due', dueIso ? { at: dueIso, tz: localTz() } : null);
    if (v.kind === 'issue') {
        for (const [field, key] of [['problem', 'problem'], ['known_facts', 'knownFacts'],
                                    ['unknowns', 'unknowns'], ['resolution_criteria', 'resolutionCriteria']]) {
            const val = String(data.get(field) || '').trim();
            if (val !== v[key]) put(key, val || null);
        }
    }
    const errEl = form.querySelector('[data-continuity-edit-error]');
    if (!Object.keys(patch).length) { renderDetail(); return; }
    const res = await updateContinuityRecord(v.id, patch, v.version);
    if (!res.ok) {
        if (errEl) { errEl.hidden = false; errEl.textContent = res.error || 'تعذّر حفظ التعديلات.'; }
        if (String(res.error || '').includes('اتعدّل')) await openRecord(v.id);
        return;
    }
    ui?.showToast?.('تم حفظ التعديلات', 'success');
    await openRecord(v.id);
}

async function submitTransition(form) {
    const data = new FormData(form);
    const value = String(data.get('detail') || '').trim();
    const errEl = form.querySelector('[data-continuity-transition-error]');
    if (!value) {
        if (errEl) { errEl.hidden = false; errEl.textContent = 'هذا الحقل مطلوب.'; }
        return;
    }
    const res = await transitionContinuityRecord(detail.record.id, pendingTransition.to,
        { [pendingTransition.field]: value }, detail.record.version);
    if (!res.ok) {
        if (errEl) { errEl.hidden = false; errEl.textContent = res.error || 'تعذّر تغيير الحالة.'; }
        if (String(res.error || '').includes('اتعدّل')) await openRecord(detail.record.id);
        return;
    }
    ui?.showToast?.('تم تغيير الحالة', 'success');
    await openRecord(detail.record.id);
}

async function submitNote(form) {
    const data = new FormData(form);
    const check = validateContinuityNote(String(data.get('body') || ''));
    const errEl = form.querySelector('[data-continuity-note-error]');
    if (!check.ok) {
        if (errEl) { errEl.hidden = false; errEl.textContent = check.error; }
        return;
    }
    const res = await addContinuityNote(detail.record.id, check.body);
    if (!res.ok) {
        if (errEl) { errEl.hidden = false; errEl.textContent = res.error || 'تعذّرت إضافة الملاحظة.'; }
        return;
    }
    ui?.showToast?.('أُضيفت الملاحظة', 'success');
    await openRecord(detail.record.id);
}

/* ── الأحداث ───────────────────────────────────────────────────────────── */

function onClick(event) {
    const open = event.target.closest('[data-continuity-open]');
    if (open) { openRecord(open.getAttribute('data-continuity-open')); return; }
    const transition = event.target.closest('[data-continuity-transition]');
    if (transition) {
        const to = transition.getAttribute('data-continuity-transition');
        const req = continuityTransitionRequirement(to, detail.record.status);
        if (!req) {
            transitionContinuityRecord(detail.record.id, to, {}, detail.record.version).then(async (res) => {
                if (!res.ok) {
                    ui?.showToast?.(res.error || 'تعذّر تغيير الحالة.', 'error');
                    if (String(res.error || '').includes('اتعدّل')) await openRecord(detail.record.id);
                    return;
                }
                ui?.showToast?.('تم تغيير الحالة', 'success');
                await openRecord(detail.record.id);
            });
            return;
        }
        pendingTransition = { to, field: req.field, label: req.label };
        renderTransitionBox();
        return;
    }
    const btn = event.target.closest('[data-continuity-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-continuity-action');
    if (action === 'new') { renderCreate(); }
    else if (action === 'cancel-new') { createEl.hidden = true; creating = false; createEl.innerHTML = ''; }
    else if (action === 'back') { reloadList(); }
    else if (action === 'edit') { renderEditBox(); }
    else if (action === 'cancel-edit') { renderDetail(); }
    else if (action === 'cancel-transition') { pendingTransition = null; renderTransitionBox(); }
    else if (action === 'more') { loadMore(); }
}

async function loadMore() {
    if (!rows.length) return;
    const last = rows[rows.length - 1];
    const res = await fetchContinuityList(continuityListFilters({
        ...filters, before: last.updated_at, beforeId: last.id
    }));
    if (!res.ok) { ui?.showToast?.(res.error || 'تعذّر تحميل المزيد', 'error'); return; }
    const more = Array.isArray(res.data) ? res.data : [];
    rows = rows.concat(more);
    hasMore = more.length >= (continuityListFilters(filters).limit || 50);
    renderList();
}

function onChange(event) {
    const filter = event.target.closest('[data-continuity-filter]');
    if (filter) {
        filters[filter.getAttribute('data-continuity-filter')] = filter.value;
        reloadList();
        return;
    }
    const kind = event.target.closest('#continuityNewKind');
    if (kind) {
        const issueFields = createEl.querySelector('[data-continuity-issue-fields]');
        if (issueFields) issueFields.hidden = kind.value !== 'issue';
        return;
    }
    const assign = event.target.closest('[data-continuity-assign]');
    if (assign && detail) {
        const owner = assign.value || null;
        assignContinuityRecord(detail.record.id, owner, detail.record.version).then(async (res) => {
            if (!res.ok) { ui?.showToast?.(res.error || 'تعذّر الإسناد.', 'error'); renderDetail(); return; }
            if (res.data?.access === 'lost') {
                ui?.showToast?.('تم الإسناد — لم يعد السجل ظاهرًا لك', 'info');
                await reloadList();
                return;
            }
            ui?.showToast?.('تم تحديث الإسناد', 'success');
            await openRecord(detail.record.id);
        });
    }
}

function onSubmit(event) {
    const form = event.target.closest('[data-continuity-form]');
    if (!form) return;
    event.preventDefault();
    const kind = form.getAttribute('data-continuity-form');
    if (kind === 'create') submitCreate(form);
    else if (kind === 'edit') submitEdit(form);
    else if (kind === 'transition') submitTransition(form);
    else if (kind === 'note') submitNote(form);
}
