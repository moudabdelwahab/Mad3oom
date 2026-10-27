/**
 * owner-workspace.js — تبويبات داخلية لأقسام لوحة المالك الطويلة («السلطة والمنح»، «حوكمة الشركات»).
 *
 * عرض فقط: كل لوحة (tabpanel) موجودة في الصفحة من البداية وتُحمَّل بياناتها مرة واحدة كما كانت؛
 * التبديل يُظهر لوحة ويخفي البقية بـhidden، فلا يُعاد تنفيذ نداء ولا تُحذف حالة نموذج.
 * لا قرار صلاحية هنا: الأزرار الحرجة تتبع applyCriticalState، والرفض الحقيقي في القاعدة.
 *
 * البنية المتوقعة داخل root:
 *   [role=tablist] > button[role=tab][data-ws-tab=name][aria-controls=panelId] > .view-tab-count[data-ws-count]
 *   [role=tabpanel][data-ws-panel=name]
 *   [data-ws-anchor]   — أعلى مساحة العمل، يُمرَّر إليه عند تبديل التبويب إن كان خارج الشاشة
 * وأي رابط في الصفحة يحمل data-ws-open="name" يفتح التبويب الذي يملك تلك اللوحة.
 */

const STORAGE_PREFIX = 'mad3oom-owner-tab:';
const hideTimers = new WeakMap();

/**
 * رسالة حالة عملية (نجاح/فشل/جارٍ) في عنصرها. رسالة النجاح تختفي وحدها بعد مهلة، والخطأ يبقى
 * حتى العملية التالية أو النقر عليه. النص يبقى في العنصر بعد الإخفاء.
 */
export function announce(el, text, tone = 'info') {
    if (!el) return;
    clearTimeout(hideTimers.get(el));
    el.textContent = text;
    el.dataset.tone = tone;
    el.hidden = !text;
    if (text && tone === 'success') hideTimers.set(el, setTimeout(() => { el.hidden = true; }, 8000));
}

/** نص الشارة للعرض: null/undefined/'' يخفيها. خالصة. */
export function badgeText(value) {
    if (value === null || value === undefined || value === '') return null;
    return String(value);
}

const readStored = (key) => {
    try { return localStorage.getItem(key); } catch { return null; }
};
const writeStored = (key, value) => {
    try { localStorage.setItem(key, value); } catch { /* تخزين محجوب: يبقى التبويب الافتراضي */ }
};

export function createWorkspaceTabs({ root, id, fallback } = {}) {
    if (!root) return null;
    const tabs = [...root.querySelectorAll('[role="tab"][data-ws-tab]')];
    const names = tabs.map(t => t.dataset.wsTab);
    const panelOf = (name) => root.querySelector(`[role="tabpanel"][data-ws-panel="${CSS.escape(name)}"]`);
    const storageKey = STORAGE_PREFIX + id;
    let current = null;

    function select(name, { focus = false, remember = true, reveal = false } = {}) {
        if (!names.includes(name)) name = fallback && names.includes(fallback) ? fallback : names[0];
        for (const tab of tabs) {
            const on = tab.dataset.wsTab === name;
            tab.setAttribute('aria-selected', String(on));
            tab.tabIndex = on ? 0 : -1;
            const panel = panelOf(tab.dataset.wsTab);
            if (panel) panel.hidden = !on;
        }
        const changed = current !== name;
        current = name;
        root.dataset.wsActive = name;
        if (remember) writeStored(storageKey, name);
        const tab = tabs.find(t => t.dataset.wsTab === name);
        if (focus) tab?.focus();
        // التبويب نفسه يبقى ظاهرًا في الشريط القابل للتمرير أفقيًا (الجوال)
        tab?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        // إن مُرِّرت الصفحة تحت بداية مساحة العمل، تبدأ اللوحة الجديدة من أولها لا من منتصفها
        if (changed && reveal) {
            const anchor = root.querySelector('[data-ws-anchor]') || root;
            if (anchor.getBoundingClientRect().top < 0) anchor.scrollIntoView({ block: 'start' });
        }
        root.dispatchEvent(new CustomEvent('workspace:tab', { detail: { name } }));
    }

    /** شارة التبويب: عدد أو حالة قصيرة. tone: attention | success | danger | (محايد). */
    function setBadge(name, value, tone = '') {
        const el = root.querySelector(`[data-ws-count="${CSS.escape(name)}"]`);
        if (!el) return;
        const text = badgeText(value);
        el.textContent = text ?? '';
        el.hidden = text === null;
        if (tone) el.dataset.tone = tone; else delete el.dataset.tone;
    }

    tabs.forEach(tab => {
        tab.addEventListener('click', () => select(tab.dataset.wsTab, { reveal: true }));
        tab.addEventListener('keydown', (e) => {
            const i = tabs.indexOf(tab);
            // RTL: السهم الأيسر يتقدّم بصريًا إلى التبويب التالي
            const rtl = getComputedStyle(root).direction === 'rtl';
            const step = { ArrowLeft: rtl ? 1 : -1, ArrowRight: rtl ? -1 : 1 }[e.key];
            let next = null;
            if (step) next = tabs[(i + step + tabs.length) % tabs.length];
            else if (e.key === 'Home') next = tabs[0];
            else if (e.key === 'End') next = tabs[tabs.length - 1];
            if (!next) return;
            e.preventDefault();
            select(next.dataset.wsTab, { focus: true, reveal: true });
        });
    });

    // روابط من خارج مساحة العمل (مثلًا «التحقق بخطوتين» في الحوكمة) تفتح لوحتها هنا
    document.addEventListener('click', (e) => {
        const link = e.target.closest?.('[data-ws-open]');
        if (link && names.includes(link.dataset.wsOpen)) select(link.dataset.wsOpen);
    });

    // رسائل الحالة العائمة: نقرة تخفيها
    root.querySelectorAll('.ows-toast').forEach(t => t.addEventListener('click', () => { t.hidden = true; }));

    select(readStored(storageKey) || fallback || names[0], { remember: false });

    return { select, setBadge, get current() { return current; } };
}
