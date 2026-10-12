/**
 * نافذة تأكيد/إدخال داخل الصفحة بدل window.confirm / window.prompt.
 * عرض فقط: الخادم هو اللي بيقرر في كل عملية.
 *
 *   await continuityConfirm({ title, message, confirmText, danger })   → true | false
 *   await continuityPrompt({ title, message, label, confirmText })     → النص | null
 */
import { CONTINUITY_ICONS } from './continuity-icons.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let open = null;

function show({ title, message = '', confirmText = 'تأكيد', cancelText = 'رجوع', danger = false, input = null }) {
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
      ${input ? `<div class="ct-body"><label class="ct-field"><span>${esc(input.label)}</span>
        <textarea id="ctConfirmInput" maxlength="${input.maxLength || 500}" rows="3"></textarea></label></div>` : ''}
      <footer class="ct-actions">
        <button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="ctConfirmOk" ${input ? 'disabled' : ''}>${esc(confirmText)}</button>
        <button type="button" class="btn btn-secondary" data-dlg="cancel">${esc(cancelText)}</button>
      </footer></form>`;
    document.body.append(dlg);

    return new Promise((resolve) => {
        const field = dlg.querySelector('#ctConfirmInput');
        const ok = dlg.querySelector('#ctConfirmOk');
        const finish = (value) => {
            if (!open || open.dlg !== dlg) return;
            open = null;
            if (dlg.open) dlg.close();
            dlg.remove();
            if (before && typeof before.focus === 'function' && before.isConnected) before.focus();
            resolve(value);
        };
        open = { dlg, finish };
        field?.addEventListener('input', () => { ok.disabled = !field.value.trim(); });
        dlg.addEventListener('click', (e) => {
            if (e.target.closest('[data-dlg="cancel"]')) finish(null);
        });
        dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); }); // Escape
        dlg.querySelector('form').addEventListener('submit', (e) => {
            e.preventDefault();
            if (field && !field.value.trim()) return;
            finish(field ? field.value.trim() : true);
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
