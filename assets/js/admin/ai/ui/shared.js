/**
 * عناصر واجهة مشتركة لقسم AI
 * --------------------------------------------------------
 * تستخدم نفس نظام التصميم الحالي للصفحة (نفس متغيّرات الألوان ونفس
 * أصناف .mcp-card / .status-chip / .btn) — لا يُعرَّف هنا أي لون جديد.
 */

export function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

/** أيقونة SVG صغيرة بنفس مقاس أيقونات الصفحة الحالية. */
export function icon(name, size = 14) {
    const paths = {
        message: '<path d="M21 11.5a8.38 8.38 0 0 1-9 8.4 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5a8.5 8.5 0 0 1 8.5-8.5 8.38 8.38 0 0 1 8.5 8.5z"></path>',
        brain: '<path d="M12 4a3 3 0 0 0-3 3v1a3 3 0 0 0-2 5.2A3 3 0 0 0 9 19a3 3 0 0 0 3-1 3 3 0 0 0 3 1 3 3 0 0 0 2-5.8A3 3 0 0 0 15 8V7a3 3 0 0 0-3-3z"></path>',
        code: '<polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline>',
        tool: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>',
        layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline>',
        eye: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"></path><circle cx="12" cy="12" r="3"></circle>',
        expand: '<polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line>',
        zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>',
        mic: '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line>',
        bug: '<rect x="8" y="6" width="8" height="14" rx="4"></rect><path d="M19 9h-3M8 9H5M19 15h-3M8 15H5M15 4l-1 2M9 4l1 2"></path>',
        search: '<circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>',
        refresh: '<polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>',
        plus: '<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>',
        globe: '<circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 0 20 15.3 15.3 0 0 1 0-20z"></path>',
        key: '<circle cx="7.5" cy="15.5" r="5.5"></circle><path d="M21 2l-9.6 9.6"></path><path d="M15.5 7.5l3 3L22 7l-3-3"></path>',
        cpu: '<rect x="6" y="6" width="12" height="12" rx="1"></rect><line x1="9" y1="1" x2="9" y2="4"></line><line x1="15" y1="1" x2="15" y2="4"></line><line x1="9" y1="20" x2="9" y2="23"></line><line x1="15" y1="20" x2="15" y2="23"></line><line x1="20" y1="9" x2="23" y2="9"></line><line x1="20" y1="15" x2="23" y2="15"></line><line x1="1" y1="9" x2="4" y2="9"></line><line x1="1" y1="15" x2="4" y2="15"></line>',
        activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>',
        dollar: '<line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>',
        clock: '<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>',
        route: '<circle cx="6" cy="19" r="3"></circle><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"></path><circle cx="18" cy="5" r="3"></circle>',
        send: '<line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>',
        file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline>',
        trash: '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>',
        lock: '<rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>',
        alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>',
        check: '<polyline points="20 6 9 17 4 12"></polyline>',
        star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>',
    };
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;flex-shrink:0">${paths[name] || paths.cpu}</svg>`;
}

/** التنبيهات تمر عبر نفس دالة toast الموجودة في mcp.js (مصدر واحد للتنبيهات). */
export function toast(message, type = 'info') {
    if (typeof window.mcpToast === 'function') window.mcpToast(message, type);
    else console.log(`[${type}] ${message}`);
}

export function loadingBlock(text = 'جاري التحميل...') {
    return `<div class="state-block"><div class="spinner"></div><p>${escapeHtml(text)}</p></div>`;
}

export function errorBlock(message) {
    return `<div class="state-block"><h3>تعذّر التحميل</h3><p>${escapeHtml(message)}</p></div>`;
}

export function emptyBlock({ title, body, actionLabel, actionAttr }) {
    return `<div class="state-block empty">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(body)}</p>
        ${actionLabel ? `<button class="btn btn-primary" ${actionAttr || ''}>${escapeHtml(actionLabel)}</button>` : ''}
    </div>`;
}

export function statusChip(kind, label) {
    const cls = { ok: 'st-connected', error: 'st-error', idle: 'st-disconnected', pending: 'st-pending' }[kind] || 'st-pending';
    return `<span class="status-chip ${cls}"><span class="dot"></span>${escapeHtml(label)}</span>`;
}

export function formatNumber(n) {
    return new Intl.NumberFormat('en-US').format(Number(n) || 0);
}

export function formatCost(n) {
    const v = Number(n) || 0;
    if (v === 0) return '$0';
    return v < 0.01 ? `$${v.toFixed(5)}` : `$${v.toFixed(2)}`;
}

export function formatDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' });
}

export function setBusy(btn, busy, busyText = 'جاري...') {
    if (!btn) return;
    if (busy) {
        btn.dataset.originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = escapeHtml(busyText);
    } else {
        btn.disabled = false;
        if (btn.dataset.originalHtml) btn.innerHTML = btn.dataset.originalHtml;
    }
}

export function debounce(fn, wait = 300) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}
