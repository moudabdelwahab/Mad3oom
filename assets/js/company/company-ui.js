/**
 * company-ui.js — مكوّنات عرض مشتركة بين صفحات لوحة الشركة.
 *
 * لا بيانات ولا صلاحيات هنا: أيقونات بنفس أسلوب القائمة الجانبية، ورأس المجال
 * (عنوان + وصف + شريط الصفحات الشقيقة)، ومسار التنقّل. الحالات (تحميل/فراغ/خطأ)
 * تبقى في portal-ui.js المشترك مع بوابة العميل.
 */
import { escapeHtml } from '/assets/js/customer/portal-ui.js';

const ICON_PATHS = {
    briefcase: '<rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path>',
    clock: '<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline>',
    check: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline>',
    mail: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>',
    alert: '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line>',
    warning: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>',
    info: '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line>',
    plus: '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="16"></line><line x1="8" y1="12" x2="16" y2="12"></line>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>',
    code: '<polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline>',
    chart: '<path d="M12 20V10"></path><path d="M18 20V4"></path><path d="M6 20v-4"></path>',
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"></polyline><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path>',
    bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path>',
    gauge: '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"></path><path d="M22 12A10 10 0 0 0 12 2v10z"></path>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>',
    // «التالي» في واجهة عربية يتجه يسارًا؛ ويُعكس في LTR من الأنماط
    forward: '<polyline points="15 18 9 12 15 6"></polyline>'
};

/** أيقونة SVG خطّية (زخرفية: aria-hidden دائمًا؛ النص المجاور يحمل المعنى). */
export function icon(name, size = 18, className = '') {
    return `<svg ${className ? `class="${className}" ` : ''}viewBox="0 0 24 24" width="${size}" height="${size}" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
}

/**
 * رأس المجال: العنوان والوصف وشريط الصفحات الشقيقة. head = pageHeadFor(...) أو null.
 * الروابط href حقيقية (#page) + data-tab، فتعمل بلوحة المفاتيح وبفتح تبويب جديد.
 */
export function renderPageHead(container, head) {
    if (!container) return;
    if (!head) {
        container.hidden = true;
        container.innerHTML = '';
        return;
    }
    container.hidden = false;
    container.innerHTML = `
        <div class="company-page-head-text">
            <h2 class="company-page-title">${escapeHtml(head.title)}</h2>
            ${head.description ? `<p class="company-page-desc">${escapeHtml(head.description)}</p>` : ''}
        </div>
        ${head.tabs.length > 1 ? `
        <nav class="company-subnav" aria-label="صفحات ${escapeHtml(head.title)}">
            ${head.tabs.map(tab => `
                <a class="company-subnav-item${tab.current ? ' is-current' : ''}"
                   href="/company-dashboard/#${escapeHtml(tab.page)}" data-tab="${escapeHtml(tab.page)}"
                   ${tab.current ? 'aria-current="page"' : ''}>${escapeHtml(tab.label)}</a>`).join('')}
        </nav>` : ''}`;
}

/** مسار التنقّل: كل عنصر نص؛ الأخير هو الصفحة الحالية. */
export function renderBreadcrumb(list, trail) {
    if (!list) return;
    list.innerHTML = trail.map((label, i) => {
        const last = i === trail.length - 1;
        if (i === 0) return `<li><span class="company-level-tag">${escapeHtml(label)}</span></li>`;
        return `<li${last ? ' id="companySectionCrumb" aria-current="page"' : ''}>${escapeHtml(label)}</li>`;
    }).join('');
}
