/**
 * dashboard-nav.js — سلوك القائمة الجانبية المشترك بين اللوحات الثلاث
 * (الإدارة، المالك، الشركة).
 *
 * يملك هذا الملف شيئين فقط، وكلاهما عرض لا تفويض:
 *   1) حالة طي القائمة (أيقونات فقط) — مفضّلة واحدة لكل اللوحات، تُقرأ قبل
 *      الرسم من نفس المفتاح في localStorage.
 *   2) مجموعات القائمة القابلة للطي (.sidebar-group) — كل مجموعة تُفتح وتُغلق
 *      بزرّها، وتُحفظ الحالة لكل لوحة على حدة.
 *
 * ما تراه كل لوحة من عناصر يقرّره كود اللوحة نفسها (والقاعدة قبله)؛ هنا لا
 * يُضاف عنصر ولا يُحذف. مجموعة كل عناصرها مخفية تختفي بالـCSS
 * (dashboard-layout.css) فلا يبقى عنوان بلا محتوى.
 */

const COLLAPSE_KEY = 'mad3oom-sidebar-collapsed';
const GROUPS_KEY = 'mad3oom-nav-groups';

/** هل المستخدم مفضّل القائمة مطوية؟ (يُقرأ قبل الرسم لتفادي أي قفزة) */
export function isSidebarCollapsed() {
    try {
        return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
        return false;
    }
}

/**
 * يطبّق حالة الطي ويحفظها.
 * العلَم على <html> مش على <body>: السكربت اللي بيشتغل قبل أول رسم في <head>
 * ما بيقدرش يوصل لـbody، فلو الحالة اتحطت على body هتحصل قفزة في عرض المحتوى
 * بعد التحميل. الاتنين بيكتبوا نفس السمة هنا.
 */
export function setSidebarCollapsed(collapsed, { persist = true } = {}) {
    document.documentElement.setAttribute('data-sidebar', collapsed ? 'collapsed' : 'expanded');

    const btn = document.getElementById('sidebarCollapseBtn');
    if (btn) {
        btn.setAttribute('aria-expanded', String(!collapsed));
        btn.setAttribute('aria-label', collapsed ? 'توسيع القائمة الجانبية' : 'طي القائمة الجانبية');
        btn.title = collapsed ? 'توسيع القائمة' : 'طي القائمة';
    }

    if (persist) {
        try {
            localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
        } catch { /* التخزين غير متاح (وضع خاص) — الحالة تفضل للجلسة الحالية */ }
    }
}

/** يربط زر الطي (#sidebarCollapseBtn) بعد تطبيق الحالة المحفوظة. */
export function initCollapseToggle() {
    setSidebarCollapsed(isSidebarCollapsed(), { persist: false });

    const btn = document.getElementById('sidebarCollapseBtn');
    if (!btn || btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setSidebarCollapsed(document.documentElement.getAttribute('data-sidebar') !== 'collapsed');
    });
}

function readClosedGroups(scope) {
    try {
        const all = JSON.parse(localStorage.getItem(GROUPS_KEY) || '{}');
        return new Set(Array.isArray(all?.[scope]) ? all[scope] : []);
    } catch {
        return new Set();
    }
}

function writeClosedGroups(scope, closed) {
    try {
        const all = JSON.parse(localStorage.getItem(GROUPS_KEY) || '{}') || {};
        all[scope] = [...closed];
        localStorage.setItem(GROUPS_KEY, JSON.stringify(all));
    } catch { /* التخزين غير متاح — الحالة للجلسة الحالية فقط */ }
}

function setGroupOpen(group, open) {
    group.classList.toggle('is-closed', !open);
    group.querySelector(':scope > .sidebar-group-toggle')?.setAttribute('aria-expanded', String(open));
}

/**
 * يفعّل المجموعات القابلة للطي داخل القائمة.
 * scope: اسم اللوحة ('admin' | 'owner' | 'company') — لكل لوحة حالتها.
 * المجموعة التي فيها العنصر النشط تُفتح دائمًا، فلا يختفي موضع المستخدم.
 */
export function initNavGroups(sidebar, scope) {
    if (!sidebar) return;
    const groups = sidebar.querySelectorAll('.sidebar-group[data-group]');
    if (!groups.length) return;

    const closed = readClosedGroups(scope);

    groups.forEach(group => {
        const key = group.dataset.group;
        const toggle = group.querySelector(':scope > .sidebar-group-toggle');
        setGroupOpen(group, !closed.has(key));

        toggle?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const open = group.classList.contains('is-closed');
            setGroupOpen(group, open);
            if (open) closed.delete(key); else closed.add(key);
            writeClosedGroups(scope, closed);
        });
    });

    revealActiveNavItem(sidebar);
}

/**
 * تلميح باسم العنصر حين تكون القائمة مطوية (أيقونات فقط).
 *
 * التلميح عنصر واحد ثابت الموضع على مستوى الصفحة، لا ‎::after‎ داخل العنصر:
 * القائمة حاوية تمرير (overflow-y)، وأي شيء يُرسم خارج حدودها يُقصّ — فكان
 * التلميح موجودًا ولا يُرى. الاسم نفسه متاح لقارئ الشاشة داخل العنصر، فالتلميح
 * بصري فقط (aria-hidden).
 */
export function initCollapsedTooltips(sidebar) {
    if (!sidebar || sidebar.dataset.tooltips === '1') return;
    sidebar.dataset.tooltips = '1';

    const tip = document.createElement('div');
    tip.className = 'dash-tooltip';
    tip.setAttribute('aria-hidden', 'true');
    tip.hidden = true;
    document.body.appendChild(tip);

    const wide = window.matchMedia('(min-width: 1100px)');
    const collapsed = () => wide.matches && document.documentElement.getAttribute('data-sidebar') === 'collapsed';
    const hide = () => { tip.hidden = true; };
    const show = (item) => {
        const label = item?.dataset.label;
        if (!label || !collapsed()) { hide(); return; }
        const r = item.getBoundingClientRect();
        tip.textContent = label;
        tip.style.top = `${r.top + r.height / 2}px`;
        // يسار القائمة في RTL: الحافة اليمنى للتلميح عند الحافة اليسرى للعنصر
        tip.style.right = `${document.documentElement.clientWidth - r.left + 10}px`;
        tip.hidden = false;
    };

    // pointermove لا pointerover: بعد تمرير القائمة (الذي يخفي التلميح) يعود التلميح
    // بأول حركة فوق العنصر نفسه، دون الحاجة لمغادرته ثم العودة.
    let current = null;
    sidebar.addEventListener('pointermove', (e) => {
        const item = e.target.closest('.sidebar-item');
        if (item === current && !tip.hidden) return;
        current = item;
        show(item);
    });
    sidebar.addEventListener('pointerleave', hide);
    sidebar.addEventListener('focusin', (e) => show(e.target.closest('.sidebar-item')));
    sidebar.addEventListener('focusout', hide);
    sidebar.addEventListener('click', hide);
    sidebar.querySelector('.sidebar-menu')?.addEventListener('scroll', hide, { passive: true });
}

/** يفتح المجموعة التي تحوي العنصر النشط (بدون حفظ — تفضيل المستخدم يبقى كما هو). */
export function revealActiveNavItem(sidebar = document.getElementById('sidebar')) {
    const group = sidebar?.querySelector('.sidebar-item.active')?.closest('.sidebar-group');
    if (group) setGroupOpen(group, true);
}
