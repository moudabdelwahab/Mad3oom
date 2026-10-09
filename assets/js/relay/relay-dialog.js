/**
 * نافذة تأكيد/إدخال داخل الصفحة بدل window.confirm / window.prompt.
 * عرض فقط: الخادم هو اللي بيقرر في كل عملية.
 *
 *   await relayConfirm({ title, message, confirmText, danger })   → true | false
 *   await relayPrompt({ title, message, label, confirmText })     → النص | null
 */
import { RELAY_ICONS } from './relay-icons.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let open = null;

function show({ title, message = '', confirmText = 'تأكيد', cancelText = 'رجوع', danger = false, input = null }) {
    if (open) open.finish(null);
    const before = document.activeElement;
    const dlg = document.createElement('dialog');
    dlg.className = 'rl-dialog rl-dialog--sm';
    dlg.id = 'rlConfirm';
    dlg.setAttribute('dir', 'rtl');
    dlg.setAttribute('aria-labelledby', 'rlConfirmTitle');
    dlg.innerHTML = `<form method="dialog" class="rl-sheet rl-confirm${danger ? ' is-danger' : ''}">
      <header class="rl-head">
        <span class="rl-confirm-icon" aria-hidden="true">${danger ? RELAY_ICONS.alert : RELAY_ICONS.relay}</span>
        <div class="rl-head-text"><h2 id="rlConfirmTitle">${esc(title)}</h2>${message ? `<p id="rlConfirmMsg">${esc(message)}</p>` : ''}</div>
        <button type="button" class="rl-icon-btn" data-dlg="cancel" aria-label="إغلاق">${RELAY_ICONS.close}</button>
      </header>
      ${input ? `<div class="rl-body"><label class="rl-field"><span>${esc(input.label)}</span>
        <textarea id="rlConfirmInput" maxlength="${input.maxLength || 500}" rows="3"></textarea></label></div>` : ''}
      <footer class="rl-actions">
        <button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="rlConfirmOk" ${input ? 'disabled' : ''}>${esc(confirmText)}</button>
        <button type="button" class="btn btn-secondary" data-dlg="cancel">${esc(cancelText)}</button>
      </footer></form>`;
    document.body.append(dlg);

    return new Promise((resolve) => {
        const field = dlg.querySelector('#rlConfirmInput');
        const ok = dlg.querySelector('#rlConfirmOk');
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

export async function relayConfirm(opts) {
    return (await show({ ...opts, input: null })) === true;
}

export function relayPrompt({ label, maxLength, ...opts }) {
    return show({ ...opts, input: { label: label || opts.title, maxLength } });
}
