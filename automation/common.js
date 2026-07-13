/* =====================================================================
   common.js
   ---------------------------------------------------------------------
   Shared, feature-agnostic building blocks used by every other module:
     - generic helpers (id generation, escaping, relative time, toasts)
     - the small SVG icon set (ic/icFilled) used throughout the UI
     - static lookup-table constants (category/status labels & colors)
     - localStorage-backed "favorites/recent" helpers for the node library

   This module has NO dependency on any other module in the app, and is
   safe to import from anywhere (state, canvas, inspector, panels, views).
   ===================================================================== */

/* ---------------------------------------------------------------------
   Generic helpers
   --------------------------------------------------------------------- */
export function uid(prefix) {
    return (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}

export function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function timeAgo(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    const diffMs = Date.now() - d.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'الآن';
    if (mins < 60) return `منذ ${mins} د`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `منذ ${hrs} س`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `منذ ${days} يوم`;
    return d.toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function toast(message, type) {
    const wrap = document.getElementById('wfToastWrap');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = 'wf-toast' + (type ? ` wf-toast-${type}` : '');
    const iconName = type === 'error' ? 'alertTriangle' : type === 'success' ? 'checkCircle' : 'info';
    const iconColor = type === 'error' ? 'var(--wf-danger)' : type === 'success' ? 'var(--wf-success)' : 'var(--wf-accent-soft)';
    el.innerHTML = `<span style="display:flex;color:${iconColor}">${ic(iconName, 16)}</span><span>${escapeHtml(message)}</span>`;
    wrap.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s ease'; setTimeout(() => el.remove(), 300); }, 3800);
}

export function isStaffFieldOptional(field) {
    if (!field) return true;
    if (field.optional === true) return true;
    if (field.default !== undefined && field.default !== null && field.default !== '') return true;
    if (typeof field.label === 'string' && field.label.includes('اختياري')) return true;
    return false;
}

/* ---------------------------------------------------------------------
   مكتبة أيقونات SVG (بدلًا من الإيموجي) — أسلوب Feather-icons، متسقة مع
   الأيقونات الثابتة الموجودة أصلًا في الـ HTML (stroke=currentColor, viewBox 0 0 24 24)
   ملاحظة: أيقونات أنواع الـ Nodes (nt.icon/nt.color) تأتي من قاعدة البيانات
   (wf_node_types) وتبقى كما هي — هذه المكتبة تغطي فقط الرموز المكتوبة يدويًا في الكود.
   --------------------------------------------------------------------- */
export const ICON_PATHS = {
    box: '<path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
    alertTriangle: '<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    tag: '<path d="M20.59 13.41L13.42 20.58a2 2 0 01-2.83 0L2.41 12.4A2 2 0 012 11V4a2 2 0 012-2h7a2 2 0 011.41.59l8.18 8.18a2 2 0 010 2.83z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/>',
    play: '<polygon points="5 3 19 12 5 21 5 3"/>',
    pause: '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
    archive: '<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>',
    barChart: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
    fileText: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
    activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    user: '<path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    tool: '<path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    checkCircle: '<path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    edit: '<path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 012-2h2a2 2 0 012 2v2"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
    undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 00-9-9 9 9 0 00-6 2.3L3 13"/>',
    info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'
};

/* أيقونة outline (الشكل الافتراضي): ترث currentColor لتتلوّن حسب أب العنصر */
export function ic(name, size) {
    size = size || 14;
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;vertical-align:-2px;">${ICON_PATHS[name] || ''}</svg>`;
}
/* أيقونة معبّأة (للتشغيل/الإيقاف/النجمة المفعّلة) */
export function icFilled(name, size) {
    size = size || 14;
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" stroke="none" style="flex-shrink:0;vertical-align:-2px;">${ICON_PATHS[name] || ''}</svg>`;
}

/* ---------------------------------------------------------------------
   ثوابت وخرائط عرض (Category / Status labels) — مطابقة لقيد wf_node_types.category
   ومطابقة لحالتي wf_workflows.status و wf_workflow_versions.status
   --------------------------------------------------------------------- */
export const CATEGORY_LABELS = {
    trigger: 'المشغلات', condition: 'الشروط', action: 'الإجراءات', ai: 'الذكاء الاصطناعي',
    api: 'API وتكاملات', database: 'قاعدة البيانات', delay: 'التأخير', loop: 'التكرار', control: 'التحكم'
};
export const CATEGORY_ORDER = ['trigger', 'condition', 'action', 'ai', 'api', 'database', 'delay', 'loop', 'control'];
export const CATEGORY_ACCENT = {
    trigger: '#22C55E', condition: '#3B82F6', action: '#0EA5E9', ai: '#A855F7',
    api: '#6366F1', database: '#14B8A6', delay: '#F97316', loop: '#F97316', control: '#EF4444'
};
/* الحالة على مستوى wf_workflows.status (حالة تشغيلية) */
export const STATUS_LABEL = { draft: 'مسودة', active: 'نشط (منشور)', paused: 'متوقف مؤقتًا', archived: 'مؤرشف' };
export const STATUS_BADGE_CLASS = { draft: 'wf-badge-gray', active: 'wf-badge-green', paused: 'wf-badge-amber', archived: 'wf-badge-red' };
/* الحالة على مستوى wf_workflow_versions.status (حالة الإصدار نفسه) */
export const VERSION_STATUS_LABEL = { draft: 'مسودة', published: 'منشور', archived: 'مؤرشف' };

/* ---------------------------------------------------------------------
   Node-library "favorites" / "recently used" persistence (localStorage)
   Shared by the node-library panel (renders the star toggle & tabs) and
   the canvas engine (records a node type as "recent" whenever it is
   actually dropped/added onto the canvas).
   --------------------------------------------------------------------- */
const LIB_FAV_KEY = 'wf_lib_favorites';
const LIB_RECENT_KEY = 'wf_lib_recent';

export function getFavorites() { try { return JSON.parse(localStorage.getItem(LIB_FAV_KEY) || '[]'); } catch { return []; } }
export function setFavorites(arr) { localStorage.setItem(LIB_FAV_KEY, JSON.stringify(arr)); }
export function toggleFavorite(key) {
    const favs = getFavorites();
    const i = favs.indexOf(key);
    if (i === -1) favs.push(key); else favs.splice(i, 1);
    setFavorites(favs);
}
export function getRecent() { try { return JSON.parse(localStorage.getItem(LIB_RECENT_KEY) || '[]'); } catch { return []; } }
export function pushRecent(key) {
    let r = getRecent().filter(k => k !== key);
    r.unshift(key);
    r = r.slice(0, 8);
    localStorage.setItem(LIB_RECENT_KEY, JSON.stringify(r));
}
