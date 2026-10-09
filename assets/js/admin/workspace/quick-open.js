/**
 * quick-open.js — «افتح بسرعة» في مساحة العمل (Ctrl/⌘ + K وزر +)
 * ---------------------------------------------------------------------------
 * نافذة واحدة لثلاثة أشياء: فتح لوحة (الصندوق، التذاكر، سجل العملاء)، أوامر
 * الترتيب (ترتيبات جاهزة، إعادة الضبط، إعادة فتح المغلق)، والبحث في السجلات
 * (محادثات، تذاكر، عملاء) — والنتائج من قاعدة البيانات بصلاحيات الموظف.
 *
 * Enter يفتح في المجموعة النشطة، وCtrl/⌘/Alt + Enter يفتح بجانبها.
 *
 * <dialog> أصلية: حبس التركيز وEscape وإرجاع التركيز من المتصفح نفسه. الحقل
 * combobox والنتائج listbox مع aria-activedescendant، فالقارئ الصوتي يتابع
 * الاختيار والتركيز باقٍ في الحقل.
 */
import { normalize, score } from '../command-palette.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * @param {{
 *   strings: (key: string) => string,
 *   staticItems: () => Array<{id, group, title, subtitle?, icon?, run?: (side) => void, panel?}>,
 *   search: (query: string) => Promise<Array>,
 *   onPick: (item, options: {side: boolean}) => void,
 *   icon: (name: string) => string
 * }} options
 */
export function createQuickOpen({ strings: t, staticItems, search, onPick, icon }) {
    const dialog = document.createElement('dialog');
    dialog.className = 'ws-quick';
    dialog.setAttribute('aria-label', t('quickOpenTitle'));
    dialog.innerHTML = `
        <div class="ws-quick-head">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
            <input type="search" class="ws-quick-input" role="combobox" aria-autocomplete="list" aria-expanded="true"
                   aria-controls="wsQuickList" autocomplete="off" spellcheck="false" placeholder="${esc(t('quickOpenPlaceholder'))}">
            <kbd class="ws-quick-esc">Esc</kbd>
        </div>
        <div class="ws-quick-list" id="wsQuickList" role="listbox" aria-label="${esc(t('quickOpenResults'))}"></div>
        <div class="ws-quick-foot"><span>${esc(t('quickOpenHintEnter'))}</span><span>${esc(t('quickOpenHintSide'))}</span></div>`;
    document.body.appendChild(dialog);

    const input = dialog.querySelector('.ws-quick-input');
    const list = dialog.querySelector('.ws-quick-list');
    let items = [];
    let selected = 0;
    let searchSeq = 0;
    let timer = null;
    let records = [];
    let searching = false;

    function render() {
        const q = input.value.trim();
        const local = staticItems()
            .map((item) => ({ item, s: q ? Math.max(score(item.title, q), score(item.keywords || '', q)) : 0 }))
            .filter(({ s }) => s >= 0)
            .sort((a, b) => b.s - a.s)
            .map(({ item }) => item);
        items = [...local, ...records];
        if (selected >= items.length) selected = Math.max(0, items.length - 1);

        let lastGroup = null;
        list.innerHTML = items.map((item, i) => {
            const head = item.group !== lastGroup ? `<div class="ws-quick-group" role="presentation">${esc(t(`group_${item.group}`))}</div>` : '';
            lastGroup = item.group;
            return `${head}<div class="ws-quick-item${i === selected ? ' is-selected' : ''}" role="option" id="wsQuickOpt${i}"
                         aria-selected="${i === selected}" data-index="${i}">
                    <span class="ws-quick-icon">${icon(item.icon || item.type || 'command')}</span>
                    <span class="ws-quick-text"><span class="ws-quick-title">${esc(item.title)}</span>
                    ${item.subtitle ? `<span class="ws-quick-sub">${esc(item.subtitle)}</span>` : ''}</span>
                </div>`;
        }).join('') || `<div class="ws-quick-empty">${esc(searching ? t('quickOpenSearching') : t('quickOpenEmpty'))}</div>`;

        if (searching && items.length) list.insertAdjacentHTML('beforeend', `<div class="ws-quick-empty">${esc(t('quickOpenSearching'))}</div>`);
        input.setAttribute('aria-activedescendant', items.length ? `wsQuickOpt${selected}` : '');
        list.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
    }

    function runSearch() {
        const q = input.value.trim();
        const seq = ++searchSeq;
        records = [];
        if (normalize(q).length < 2 && !/^#?\d+$/.test(q)) { searching = false; render(); return; }
        searching = true;
        render();
        search(q).then((found) => {
            if (seq !== searchSeq) return;
            records = found;
        }).catch(() => {
            if (seq === searchSeq) records = [];
        }).finally(() => {
            if (seq !== searchSeq) return;
            searching = false;
            render();
        });
    }

    function pick(index, side) {
        const item = items[index];
        if (!item) return;
        dialog.close();
        onPick(item, { side });
    }

    input.addEventListener('input', () => {
        selected = 0;
        render();
        clearTimeout(timer);
        timer = setTimeout(runSearch, 250);
    });
    input.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!items.length) return;
            selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            render();
        } else if (event.key === 'Enter') {
            event.preventDefault();
            pick(selected, event.ctrlKey || event.metaKey || event.altKey);
        }
    });
    list.addEventListener('click', (event) => {
        const row = event.target.closest('[data-index]');
        if (row) pick(Number(row.dataset.index), event.ctrlKey || event.metaKey || event.altKey);
    });
    // نقرة على الخلفية (خارج المحتوى) تغلق
    dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });

    return {
        open(prefill = '') {
            if (dialog.open) { input.focus(); return; }
            input.value = prefill;
            selected = 0;
            records = [];
            searching = false;
            render();
            dialog.showModal();
            input.focus();
            if (prefill) runSearch();
        },
        close() { if (dialog.open) dialog.close(); },
        get isOpen() { return dialog.open; }
    };
}
