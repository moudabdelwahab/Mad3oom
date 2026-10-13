/**
 * نافذة تأكيد/إدخال داخل الصفحة بدل window.confirm / window.prompt.
 * عرض فقط: الخادم هو اللي بيقرر في كل عملية.
 *
 *   await continuityConfirm({ title, message, confirmText, danger })   → true | false
 *   await continuityPrompt({ title, message, label, confirmText })     → النص | null
 *   await continuityReopen({ needsDue, keepsDue, tz, timezones, dueNote }) → { reason, due } | null
 *     due = { at: 'YYYY-MM-DDTHH:MM:00', tz } أو null (يفضل الموعد الحالي)
 *   await continuityHandover({ targets, message })                        → { to, reason, note } | null
 *   await continuityShare({ targets?, sources, attachments, submit, ... })   → true | null (091)
 */
import { CONTINUITY_ICONS } from './continuity-icons.js';
import { SHARE_DURATIONS, SHARE_SESSION_DURATIONS, SHARE_DEFAULT_MINUTES, shareMissing } from './continuity-model.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let open = null;

function show({ title, message = '', confirmText = 'تأكيد', cancelText = 'رجوع', danger = false, input = null, due = null, select = null, note = null }) {
    if (open) open.finish(null);
    const before = document.activeElement;
    const dlg = document.createElement('dialog');
    dlg.className = 'ct-dialog ct-dialog--sm';
    dlg.id = 'ctConfirm';
    dlg.setAttribute('dir', 'rtl');
    dlg.setAttribute('aria-labelledby', 'ctConfirmTitle');
    dlg.innerHTML = `<form method="dialog" class="ct-sheet ct-confirm${danger ? ' is-danger' : ''}">
      <header class="ct-head">
        <span class="ct-confirm-icon" aria-hidden="true">${danger ? CONTINUITY_ICONS.alert : CONTINUITY_ICONS.continuity}</span>
        <div class="ct-head-text"><h2 id="ctConfirmTitle">${esc(title)}</h2>${message ? `<p id="ctConfirmMsg">${esc(message)}</p>` : ''}</div>
        <button type="button" class="ct-icon-btn" data-dlg="cancel" aria-label="إغلاق">${CONTINUITY_ICONS.close}</button>
      </header>
      ${input ? `<div class="ct-body">${select ? `<label class="ct-field"><span>${esc(select.label)}</span>
        <select id="ctConfirmSelect" required><option value="">اختار…</option>${select.options.map((o) =>
            `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select></label>` : ''}
        <label class="ct-field"><span>${esc(input.label)}</span>
        <textarea id="ctConfirmInput" maxlength="${input.maxLength || 500}" rows="3"></textarea></label>
        ${due ? `<div class="ct-detail-grid">
          <label class="ct-field"><span>${due.required ? 'الموعد الجديد (مطلوب)' : 'موعد جديد (اختياري)'}</span>
            <input type="datetime-local" id="ctConfirmDue" ${due.required ? 'required aria-required="true"' : ''}></label>
          <label class="ct-field"><span>المنطقة الزمنية</span>
            <select id="ctConfirmTz" dir="ltr">${due.timezones.map((z) => `<option value="${esc(z)}" ${z === due.tz ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select></label>
        </div>${due.note ? `<p class="ct-muted" id="ctConfirmDueNote">${esc(due.note)}</p>` : ''}` : ''}
        ${note ? `<label class="ct-field"><span>${esc(note.label)}</span>
          <textarea id="ctConfirmNote" maxlength="${note.maxLength || 4000}" rows="3"></textarea></label>` : ''}</div>` : ''}
      <footer class="ct-actions">
        <button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="ctConfirmOk" ${input ? 'disabled' : ''}>${esc(confirmText)}</button>
        <button type="button" class="btn btn-secondary" data-dlg="cancel">${esc(cancelText)}</button>
      </footer></form>`;
    document.body.append(dlg);

    return new Promise((resolve) => {
        const field = dlg.querySelector('#ctConfirmInput');
        const dueAt = dlg.querySelector('#ctConfirmDue');
        const dueTz = dlg.querySelector('#ctConfirmTz');
        const ok = dlg.querySelector('#ctConfirmOk');
        const pick = dlg.querySelector('#ctConfirmSelect');
        const extra = dlg.querySelector('#ctConfirmNote');
        const ready = () => Boolean(field.value.trim()) && !(due?.required && !dueAt.value) && !(pick && !pick.value);
        const finish = (value) => {
            if (!open || open.dlg !== dlg) return;
            open = null;
            if (dlg.open) dlg.close();
            dlg.remove();
            if (before && typeof before.focus === 'function' && before.isConnected) before.focus();
            resolve(value);
        };
        open = { dlg, finish };
        field?.addEventListener('input', () => { ok.disabled = !ready(); });
        dueAt?.addEventListener('input', () => { ok.disabled = !ready(); });
        pick?.addEventListener('change', () => { ok.disabled = !ready(); });
        dlg.addEventListener('click', (e) => {
            if (e.target.closest('[data-dlg="cancel"]')) finish(null);
        });
        dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); }); // Escape
        dlg.querySelector('form').addEventListener('submit', (e) => {
            e.preventDefault();
            if (field && !ready()) return;
            if (!field) return finish(true);
            if (select) return finish({ to: pick.value, reason: field.value.trim(), note: extra?.value.trim() || null });
            if (!due) return finish(field.value.trim());
            const at = dueAt.value;
            return finish({
                reason: field.value.trim(),
                due: at ? { at: at.length === 16 ? `${at}:00` : at, tz: dueTz.value } : null,
            });
        });
        dlg.showModal();
        (field || ok).focus();
    });
}

export async function continuityConfirm(opts) {
    return (await show({ ...opts, input: null })) === true;
}

export function continuityPrompt({ label, maxLength, ...opts }) {
    return show({ ...opts, input: { label: label || opts.title, maxLength } });
}

/** إعادة فتح سجل مقفول (079): السبب إلزامي، والموعد إلزامي لو needsDue. الخادم يعيد الفحص. */
export function continuityReopen({ needsDue = false, tz = 'Africa/Cairo', timezones = [], dueNote = '', ...opts }) {
    return show({
        title: 'إعادة فتح السجل', confirmText: 'إعادة فتح', ...opts,
        input: { label: 'سبب إعادة الفتح', maxLength: 1000 },
        due: { required: needsDue, tz, timezones: [...new Set([tz, ...timezones])], note: dueNote },
    });
}

/** طلب تسليم (081): المستلم والسبب إلزاميان، والسياق اختياري. الخادم يعيد كل الفحوص. */
export function continuityHandover({ targets = [], ...opts }) {
    return show({
        title: 'تسليم السجل', confirmText: 'إرسال الطلب', ...opts,
        select: { label: 'المستلم', options: targets },
        input: { label: 'سبب التسليم', maxLength: 1000 },
        note: { label: 'سياق للمستلم (اختياري)', maxLength: 4000 },
    });
}

/**
 * سجل جديد من صفحة الاستمرارية (087): متابعة أو مشكلة بلا رسائل.
 *   submit(draft) → null (نجح، تُغلق النافذة) | نص خطأ (يظهر داخلها وتظل مفتوحة)
 * يرجع true لو اتعمل السجل، وnull لو اتلغت. الخادم يعيد كل الفحوص (P3: المالك لغيرك
 * أو الفريق لصاحب صلاحية الإسناد فقط).
 */
export function continuityNewRecord({ owners = [], teams = [], canAssign = false, categories = [], priorities = {},
    timezones = ['Africa/Cairo'], missing = () => [], submit }) {
    if (open) open.finish(null);
    const before = document.activeElement;
    const dlg = document.createElement('dialog');
    dlg.className = 'ct-dialog';
    dlg.id = 'ctNewDialog';
    dlg.setAttribute('dir', 'rtl');
    dlg.setAttribute('aria-labelledby', 'ctNewTitle');
    const opt = (v, l, sel = false) => `<option value="${esc(v)}" ${sel ? 'selected' : ''}>${esc(l)}</option>`;
    dlg.innerHTML = `<form method="dialog" class="ct-sheet ct-new" novalidate>
      <header class="ct-head">
        <span class="ct-confirm-icon" aria-hidden="true">${CONTINUITY_ICONS.continuity}</span>
        <div class="ct-head-text"><h2 id="ctNewTitle">سجل جديد</h2>
          <p>من غير رسائل. تقدر ترفق رسائل بعدين من صندوق الرسائل («سجل استمرارية» ← «إرفاق بسجل موجود»).</p></div>
        <button type="button" class="ct-icon-btn" data-dlg="cancel" aria-label="إغلاق">${CONTINUITY_ICONS.close}</button>
      </header>
      <div class="ct-body ct-detail-grid">
        <fieldset class="ct-field" style="grid-column:1/-1"><legend>النوع</legend>
          <label><input type="radio" name="kind" value="follow_up" checked> متابعة</label>
          <label><input type="radio" name="kind" value="issue"> مشكلة</label></fieldset>
        <label class="ct-field" style="grid-column:1/-1"><span>العنوان</span>
          <input type="text" name="title" maxlength="160" required></label>
        <label class="ct-field" style="grid-column:1/-1" data-kind="follow_up"><span>الملخص (اختياري)</span>
          <textarea name="summary" maxlength="4000" rows="2"></textarea></label>
        <label class="ct-field" style="grid-column:1/-1" data-kind="issue" hidden><span>وصف المشكلة</span>
          <textarea name="problem" maxlength="4000" rows="2"></textarea></label>
        <label class="ct-field" style="grid-column:1/-1" data-kind="issue" hidden><span>المعروف لحد دلوقتي (اختياري)</span>
          <textarea name="knownFacts" maxlength="4000" rows="2"></textarea></label>
        <label class="ct-field" style="grid-column:1/-1" data-kind="issue" hidden><span>اللي لسه مش معروف (اختياري)</span>
          <textarea name="unknowns" maxlength="4000" rows="2"></textarea></label>
        <label class="ct-field" style="grid-column:1/-1" data-kind="issue" hidden><span>تتحل إمتى (اختياري)</span>
          <textarea name="resolutionCriteria" maxlength="4000" rows="2"></textarea></label>
        <label class="ct-field" style="grid-column:1/-1"><span>الخطوة التالية <small data-kind="follow_up">(مطلوبة للمتابعة)</small></span>
          <input type="text" name="nextAction" maxlength="1000"></label>
        <label class="ct-field"><span>الموعد <small data-kind="follow_up">(مطلوب للمتابعة)</small></span>
          <input type="datetime-local" name="dueAt"></label>
        <label class="ct-field"><span>المنطقة الزمنية</span>
          <select name="dueTz" dir="ltr">${timezones.map((z, i) => opt(z, z, i === 0)).join('')}</select></label>
        <label class="ct-field"><span>الأولوية</span>
          <select name="priority">${Object.entries(priorities).map(([k, v]) => opt(k, v, Number(k) === 3)).join('')}</select></label>
        <label class="ct-field"><span>التصنيف</span>
          <select name="category"><option value="">بدون</option>${categories.map((c) => opt(c.value, c.label)).join('')}</select></label>
        <label class="ct-field"><span>المالك</span>
          <select name="ownerId">${owners.map((o, i) => opt(o.value, o.label, i === 1 || (owners.length === 1))).join('')}</select></label>
        ${canAssign && teams.length ? `<label class="ct-field"><span>الفريق</span>
          <select name="teamId"><option value="">بدون فريق</option>${teams.map((t) => opt(t.id, t.name)).join('')}</select></label>` : ''}
        <p class="ct-muted" id="ctNewMissing" style="grid-column:1/-1" aria-live="polite"></p>
        <p class="ct-error" id="ctNewError" role="alert" style="grid-column:1/-1"></p>
      </div>
      <footer class="ct-actions">
        <button type="submit" class="btn btn-primary" id="ctNewSave" disabled>إنشاء السجل</button>
        <button type="button" class="btn btn-secondary" data-dlg="cancel">إلغاء</button>
      </footer></form>`;
    document.body.append(dlg);

    return new Promise((resolve) => {
        const form = dlg.querySelector('form');
        const save = dlg.querySelector('#ctNewSave');
        const errEl = dlg.querySelector('#ctNewError');
        const missEl = dlg.querySelector('#ctNewMissing');
        let busy = false;
        const draft = () => {
            const fd = new FormData(form);
            const o = Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)]));
            return { ...o, priority: Number(o.priority) || 3 };
        };
        const refresh = () => {
            const d = draft();
            dlg.querySelectorAll('[data-kind]').forEach((el) => { el.hidden = el.dataset.kind !== d.kind; });
            const m = missing(d);
            missEl.textContent = m.length ? `ناقص: ${m.join('، ')}` : '';
            save.disabled = busy || m.length > 0;
        };
        const finish = (value) => {
            if (!open || open.dlg !== dlg) return;
            open = null;
            if (dlg.open) dlg.close();
            dlg.remove();
            if (before && typeof before.focus === 'function' && before.isConnected) before.focus();
            resolve(value);
        };
        open = { dlg, finish };
        form.addEventListener('input', () => { errEl.textContent = ''; refresh(); });
        form.addEventListener('change', refresh);
        dlg.addEventListener('click', (e) => { if (e.target.closest('[data-dlg="cancel"]') && !busy) finish(null); });
        dlg.addEventListener('cancel', (e) => { e.preventDefault(); if (!busy) finish(null); });
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (busy || missing(draft()).length) return;
            busy = true;
            save.disabled = true;
            save.textContent = 'بيتعمل…';
            errEl.textContent = '';
            let failure;
            try { failure = await submit(draft()); } catch (err) { failure = err?.message || 'حصل خطأ'; }
            busy = false;
            save.textContent = 'إنشاء السجل';
            if (failure) { errEl.textContent = failure; refresh(); return; }
            finish(true);
        });
        refresh();
        dlg.showModal();
        form.querySelector('[name="title"]').focus();
    });
}

/**
 * مشاركة للمراجعة (091): عرض فقط لرسائل ومرفقات **مختارة صراحة**، لمدة تبدأ عند القبول.
 *   targets      المرشحون (فارغ ⇒ تعديل نطاق مشاركة قائمة: بلا مستلم ولا سبب)
 *   sources      [{ id, label }] رسائل السجل النشطة · attachments [{ id, label }]
 *   initial      { sources, attachments, expiryKind, minutes } للتعديل
 *   preview(to, sourceIds) → Promise<عدد الرسائل التي لن يرى المستلم نصها | null>
 *   submit(draft) → null (نجح) | نص خطأ (يظهر داخل النافذة وتظل مفتوحة)
 * لا خيار «الكل» يتوسع وحده: القائمة تُرسل معرّفات صريحة، والخادم يحسمها ويثبتها.
 */
export function continuityShare({ title = 'مشاركة للمراجعة', targets = [], sources = [], attachments = [], timezones = ['Africa/Cairo'],
    initial = null, message = '', confirmText = 'إرسال الطلب', preview = null, submit }) {
    if (open) open.finish(null);
    const amend = !targets.length;
    const before = document.activeElement;
    const dlg = document.createElement('dialog');
    dlg.className = 'ct-dialog';
    dlg.id = 'ctShareDialog';
    dlg.setAttribute('dir', 'rtl');
    dlg.setAttribute('aria-labelledby', 'ctShareTitle');
    const opt = (v, l, sel = false) => `<option value="${esc(v)}" ${sel ? 'selected' : ''}>${esc(l)}</option>`;
    const pick = new Set(initial?.sources || []);
    const pickA = new Set(initial?.attachments || []);
    const kind0 = initial?.expiryKind || 'duration';
    const min0 = Number(initial?.minutes) || SHARE_DEFAULT_MINUTES;
    const tzs = (z) => timezones.map((t, i) => opt(t, t, z ? t === z : i === 0)).join('');
    dlg.innerHTML = `<form method="dialog" class="ct-sheet ct-share" novalidate>
      <header class="ct-head">
        <span class="ct-confirm-icon" aria-hidden="true">${CONTINUITY_ICONS.continuity}</span>
        <div class="ct-head-text"><h2 id="ctShareTitle">${esc(title)}</h2>
          <p>${esc(message || 'عرض فقط للي تختاره. المستلم لازم يراجع ويقبل، والمدة تبدأ من القبول. الملكية ما بتتغيرش، وتقدر تسحب المشاركة في أي وقت.')}</p></div>
        <button type="button" class="ct-icon-btn" data-dlg="cancel" aria-label="إغلاق">${CONTINUITY_ICONS.close}</button>
      </header>
      <div class="ct-body">
        ${amend ? '' : `<label class="ct-field"><span>المستلم</span>
          <select name="to" required><option value="">اختار…</option>${targets.map((t) => opt(t.value, t.label)).join('')}</select></label>
        <label class="ct-field"><span>سبب المشاركة</span><textarea name="reason" maxlength="1000" rows="2"></textarea></label>`}
        <fieldset class="ct-field ct-share-list"><legend>الرسائل <button type="button" class="btn btn-secondary ct-btn-sm" data-all="src">اختيار الكل</button></legend>
          ${sources.length ? sources.map((x) => `<label><input type="checkbox" name="src" value="${esc(x.id)}" ${pick.has(x.id) ? 'checked' : ''}> <span dir="auto">${esc(x.label)}</span></label>`).join('')
            : '<p class="ct-muted">مفيش رسائل في السجل.</p>'}</fieldset>
        ${attachments.length ? `<fieldset class="ct-field ct-share-list"><legend>المرفقات</legend>
          ${attachments.map((x) => `<label><input type="checkbox" name="att" value="${esc(x.id)}" ${pickA.has(x.id) ? 'checked' : ''}> <span dir="auto">${esc(x.label)}</span></label>`).join('')}</fieldset>` : ''}
        <details class="ct-field"><summary>فترة زمنية (اختياري)</summary>
          <p class="ct-muted">من الرسائل المختارة، يظهر بس اللي اتبعت من البداية لحد قبل النهاية.</p>
          <div class="ct-detail-grid">
            <label class="ct-field"><span>من</span><input type="datetime-local" name="rangeFrom"></label>
            <label class="ct-field"><span>لحد</span><input type="datetime-local" name="rangeTo"></label>
            <label class="ct-field"><span>المنطقة الزمنية</span><select name="rangeTz" dir="ltr">${tzs()}</select></label>
          </div></details>
        <fieldset class="ct-field"><legend>المدة (تبدأ من القبول)</legend>
          <label><input type="radio" name="expiryKind" value="duration" ${kind0 === 'duration' ? 'checked' : ''}> مدة
            <select name="minutes">${SHARE_DURATIONS.map((x) => opt(x.minutes, x.label, x.minutes === min0)).join('')}</select></label>
          <label><input type="radio" name="expiryKind" value="session" ${kind0 === 'session' ? 'checked' : ''}> جلسة دخول المستلم فقط، بحد أقصى
            <select name="sessionMinutes">${SHARE_SESSION_DURATIONS.map((x) => opt(x.minutes, x.label, x.minutes === 720)).join('')}</select></label>
          <label><input type="radio" name="expiryKind" value="until" ${kind0 === 'until' ? 'checked' : ''}> لحد
            <input type="datetime-local" name="untilAt"> <select name="untilTz" dir="ltr">${tzs()}</select></label>
        </fieldset>
        <p class="ct-muted" id="ctSharePreview" aria-live="polite"></p>
        <p class="ct-muted" id="ctShareMissing" aria-live="polite"></p>
        <p class="ct-error" id="ctShareError" role="alert"></p>
      </div>
      <footer class="ct-actions">
        <button type="submit" class="btn btn-primary" id="ctShareSave" disabled>${esc(confirmText)}</button>
        <button type="button" class="btn btn-secondary" data-dlg="cancel">إلغاء</button>
      </footer></form>`;
    document.body.append(dlg);

    return new Promise((resolve) => {
        const form = dlg.querySelector('form');
        const save = dlg.querySelector('#ctShareSave');
        const errEl = dlg.querySelector('#ctShareError');
        const missEl = dlg.querySelector('#ctShareMissing');
        const prevEl = dlg.querySelector('#ctSharePreview');
        let busy = false;
        let previewSeq = 0;
        const draft = () => {
            const fd = new FormData(form);
            const kind = String(fd.get('expiryKind') || 'duration');
            return {
                to: amend ? null : String(fd.get('to') || ''), reason: amend ? null : String(fd.get('reason') || ''),
                sources: fd.getAll('src').map(String), attachments: fd.getAll('att').map(String),
                expiryKind: kind,
                minutes: Number(kind === 'session' ? fd.get('sessionMinutes') : fd.get('minutes')),
                untilAt: String(fd.get('untilAt') || ''), untilTz: String(fd.get('untilTz') || ''),
                rangeFrom: String(fd.get('rangeFrom') || ''), rangeTo: String(fd.get('rangeTo') || ''), rangeTz: String(fd.get('rangeTz') || ''),
            };
        };
        const refresh = () => {
            const m = shareMissing(draft(), { needsRecipient: !amend });
            missEl.textContent = m.length ? `ناقص: ${m.join('، ')}` : '';
            save.disabled = busy || m.length > 0;
        };
        const runPreview = async () => {
            const d = draft();
            if (!preview || amend || !d.to || !d.sources.length) { prevEl.textContent = ''; return; }
            const seq = ++previewSeq;
            const hidden = await preview(d.to, d.sources).catch(() => null);
            if (seq !== previewSeq) return;
            prevEl.textContent = hidden == null ? ''
                : hidden ? `${hidden} من الرسائل المختارة مش هيظهر نصها للمستلم لأنه مش مسموح له يفتح المحادثة.`
                    : 'المستلم يقدر يشوف نص كل الرسائل المختارة.';
        };
        const finish = (value) => {
            if (!open || open.dlg !== dlg) return;
            open = null;
            if (dlg.open) dlg.close();
            dlg.remove();
            if (before && typeof before.focus === 'function' && before.isConnected) before.focus();
            resolve(value);
        };
        open = { dlg, finish };
        form.addEventListener('input', () => { errEl.textContent = ''; refresh(); });
        form.addEventListener('change', (e) => { refresh(); if (e.target.name === 'to' || e.target.name === 'src') runPreview(); });
        dlg.addEventListener('click', (e) => {
            if (e.target.closest('[data-dlg="cancel"]') && !busy) { finish(null); return; }
            if (e.target.closest('[data-all="src"]')) {
                e.preventDefault();
                const boxes = [...form.querySelectorAll('input[name="src"]')];
                const on = boxes.some((b) => !b.checked);
                boxes.forEach((b) => { b.checked = on; });
                refresh();
                runPreview();
            }
        });
        dlg.addEventListener('cancel', (e) => { e.preventDefault(); if (!busy) finish(null); });
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const d = draft();
            if (busy || shareMissing(d, { needsRecipient: !amend }).length) return;
            busy = true;
            save.disabled = true;
            const label = save.textContent;
            save.textContent = 'بيتبعت…';
            errEl.textContent = '';
            let failure;
            try { failure = await submit(d); } catch (err) { failure = err?.message || 'حصل خطأ'; }
            busy = false;
            save.textContent = label;
            if (failure) { errEl.textContent = failure; refresh(); return; }
            finish(true);
        });
        refresh();
        dlg.showModal();
        (form.querySelector('[name="to"]') || form.querySelector('input')).focus();
    });
}
