/**
 * نافذة تأكيد/إدخال داخل الصفحة بدل window.confirm / window.prompt.
 * عرض فقط: الخادم هو اللي بيقرر في كل عملية.
 *
 *   await continuityConfirm({ title, message, confirmText, danger })   → true | false
 *   await continuityPrompt({ title, message, label, confirmText })     → النص | null
 *   await continuityReopen({ needsDue, keepsDue, tz, timezones, dueNote }) → { reason, due } | null
 *     due = { at: 'YYYY-MM-DDTHH:MM:00', tz } أو null (يفضل الموعد الحالي)
 *   await continuityHandover({ targets, message })                        → { to, reason, note } | null
 */
import { CONTINUITY_ICONS } from './continuity-icons.js';

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
