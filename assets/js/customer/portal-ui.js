/**
 * portal-ui.js — عناصر العرض المشتركة بين صفحات بوابة الدعم.
 *
 * اتنقلت هنا من customer-dashboard.js لما مركز المساعدة احتاج نفس الحالات
 * بالظبط (تحميل / فراغ / خطأ / إعادة محاولة). نسخة تانية من نفس الدوال كانت
 * هتخلي حالة الفراغ في صفحة تختلف عن الأخرى بعد أول تعديل — وده بالظبط اللي
 * البوابة دي بتحاول تتخلص منه.
 *
 * كلها دوال خالصة أو بتكتب في عنصر تُمرَّر إليه؛ مفيش حالة داخلية.
 */

export function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function timeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'الآن';
    if (minutes < 60) return `منذ ${minutes} دقيقة`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `منذ ${hours} ساعة`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `منذ ${days} يوم`;
    return new Date(dateStr).toLocaleDateString('ar-EG');
}

export function formatDate(dateStr) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' });
}

export function formatDateTime(dateStr) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleString('ar-EG');
}

export function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value == null ? '' : String(value);
}

/**
 * حالة موحّدة (فراغ/خطأ) مع إجراء اختياري.
 * قاعدة المنتج: حالة الفراغ لازم تقول الخطوة الجاية، مش "لا توجد بيانات".
 * الإجراء بيتحوّل لسمة data-* والصفحة هي اللي بتفوّض عليها.
 */
export function renderState(container, { variant = 'empty', title, text, icon = true, action } = {}) {
    if (!container) return;
    const iconSvg = icon
        ? (variant === 'error'
            ? '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
            : '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>')
        : '';
    const actionHtml = action
        ? `<button type="button" class="btn ${action.variant || 'btn-secondary'}"${action.goto ? ` data-goto="${escapeHtml(action.goto)}"` : ''}${action.act ? ` data-action="${escapeHtml(action.act)}"` : ''}${action.retry ? ` data-retry="${escapeHtml(action.retry)}"` : ''}>${escapeHtml(action.label)}</button>`
        : '';
    container.innerHTML = `
        <div class="state-block ${variant === 'error' ? 'state-block--error' : ''}">
            ${iconSvg}
            <p class="state-title">${escapeHtml(title || '')}</p>
            ${text ? `<p class="state-text">${escapeHtml(text)}</p>` : ''}
            ${actionHtml}
        </div>`;
}

export function renderSkeletonLines(container, count = 3) {
    if (!container) return;
    container.innerHTML = Array.from({ length: count }, () => '<div class="skeleton skeleton-line"></div>').join('');
}

/** هياكل بطاقات للشبكات (المقالات مثلاً) بدل خطوط مسطّحة. */
export function renderSkeletonCards(container, count = 3) {
    if (!container) return;
    container.innerHTML = Array.from({ length: count }, () =>
        '<div class="skeleton skeleton-card"></div>').join('');
}
