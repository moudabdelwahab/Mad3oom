/* =====================================================================
   node-library.js
   ---------------------------------------------------------------------
   The left-hand "Node Library" panel in the builder: search, the
   all/favorites/recent tabs, collapsible category groups, drag-to-canvas
   and the favorite-star toggle. Depends on the canvas engine only to
   place a node when a library item is double-clicked (no other module
   needs to reach back into this one, so this stays a clean leaf feature).
   ===================================================================== */
import { escapeHtml, ic, icFilled, nodeIcon, CATEGORY_LABELS, CATEGORY_ORDER, CATEGORY_ACCENT, getFavorites, toggleFavorite, getRecent } from './common.js';
import { appState, ui } from './state.js';
import { Canvas } from './canvas.js';

let libActiveTab = 'all';
let libActiveCategory = null; // null = كل التصنيفات؛ وإلا مفتاح تصنيف واحد (trigger/action/...)
let libCollapsedCats = new Set();

export function renderNodeLibrary() {
    const body = document.getElementById('wfLibBody');
    const q = (document.getElementById('wfLibSearch')?.value || '').trim().toLowerCase();
    const favs = getFavorites();
    let types = appState.nodeTypes.filter(nt => !q || `${nt.name_ar} ${nt.name_en} ${nt.key} ${nt.description || ''}`.toLowerCase().includes(q));

    renderLibCatBar();
    if (libActiveCategory) types = types.filter(nt => nt.category === libActiveCategory);

    if (libActiveTab === 'favorites') types = types.filter(nt => favs.includes(nt.key));
    if (libActiveTab === 'recent') {
        const recent = getRecent();
        types = types.filter(nt => recent.includes(nt.key)).sort((a, b) => recent.indexOf(a.key) - recent.indexOf(b.key));
    }

    if (!types.length) {
        body.innerHTML = `<div class="wf-empty" style="padding:2rem 1rem;">
            <div class="wf-empty-icon">${ic('tool', 20)}</div>
            <h4 style="font-size:.8rem;">${libActiveTab === 'favorites' ? 'لا مفضلات بعد' : libActiveTab === 'recent' ? 'لم تُستخدم عناصر بعد' : 'لا نتائج'}</h4>
            <p style="font-size:.7rem;display:flex;align-items:center;justify-content:center;gap:.25rem;flex-wrap:wrap;">${libActiveTab === 'favorites' ? `اضغط ${ic('star', 11)} بجانب أي عنصر لإضافته هنا.` : 'جرّب كلمة بحث مختلفة.'}</p>
        </div>`;
        return;
    }

    if (libActiveTab !== 'all' || libActiveCategory) {
        body.innerHTML = types.map(nt => libItemHtml(nt, favs)).join('');
    } else {
        const byCat = {};
        types.forEach(nt => { (byCat[nt.category] = byCat[nt.category] || []).push(nt); });
        body.innerHTML = CATEGORY_ORDER.filter(c => byCat[c]?.length).map(cat => `
            <div class="wf-lib-cat ${libCollapsedCats.has(cat) ? 'wf-collapsed' : ''}" data-cat="${cat}">
                <div class="wf-lib-cat-head">
                    <span style="width:8px;height:8px;border-radius:50%;background:${CATEGORY_ACCENT[cat]}"></span>
                    ${CATEGORY_LABELS[cat] || cat} <span style="opacity:.6;font-weight:600;">(${byCat[cat].length})</span>
                    <svg class="wf-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="6 9 12 15 18 9"/></svg>
                </div>
                <div class="wf-lib-cat-items">${byCat[cat].map(nt => libItemHtml(nt, favs)).join('')}</div>
            </div>`).join('');
    }

    body.querySelectorAll('.wf-lib-cat-head').forEach(h => h.addEventListener('click', () => {
        const cat = h.parentElement.dataset.cat;
        if (libCollapsedCats.has(cat)) libCollapsedCats.delete(cat); else libCollapsedCats.add(cat);
        renderNodeLibrary();
    }));
    body.querySelectorAll('.wf-lib-fav').forEach(f => f.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFavorite(f.dataset.key);
        renderNodeLibrary();
    }));
    body.querySelectorAll('.wf-lib-item').forEach(item => {
        item.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/wf-node-type', item.dataset.key);
            e.dataTransfer.effectAllowed = 'copy';
        });
        item.addEventListener('dblclick', () => {
            Canvas.addNodeAtCenter(item.dataset.key);
        });
        // السحب والإفلات (HTML5 DnD) مش شغّال بشكل موثوق على شاشات اللمس، فبنضيف
        // نقرة عادية (tap) كطريقة بديلة لإضافة العنصر على الجوال — بتضيف العنصر
        // في وسط الكانفاس نفس سلوك الدبل-كليك، وبعدين تقفل لوحة المكتبة تلقائيًا
        // لو كانت فاتحة كطبقة فوق الكانفاس (يعني إحنا في وضع الجوال).
        item.addEventListener('click', () => {
            const isMobileOverlay = getComputedStyle(item.closest('.wf-lib')).position === 'absolute';
            if (!isMobileOverlay) return;
            Canvas.addNodeAtCenter(item.dataset.key);
            ui.closeMobilePanels?.();
        });
    });
}

/* شريط أفقي قابل للتمرير لتصنيفات الـ Nodes — يُبنى ديناميكيًا من التصنيفات
   المتوفرة فعليًا ضمن wf_node_types النشطة (لا تصنيفات ثابتة بالكود)، بحيث لو
   اختفى تصنيف كامل (كـ database/api بعد إخفاء nodes الإصدار الأول) يختفي معه
   تلقائيًا من الشريط دون أي تعديل هنا. */
function renderLibCatBar() {
    const bar = document.getElementById('wfLibCatBar');
    if (!bar) return;
    const byCat = {};
    appState.nodeTypes.forEach(nt => { byCat[nt.category] = (byCat[nt.category] || 0) + 1; });
    const cats = CATEGORY_ORDER.filter(c => byCat[c]);
    if (!cats.length) { bar.innerHTML = ''; return; }
    bar.innerHTML = `
        <div class="wf-lib-chip ${!libActiveCategory ? 'wf-lib-chip-active' : ''}" data-cat="" style="${!libActiveCategory ? 'background:var(--wf-accent);' : ''}">الكل</div>
        ${cats.map(c => `
        <div class="wf-lib-chip ${libActiveCategory === c ? 'wf-lib-chip-active' : ''}" data-cat="${c}" style="${libActiveCategory === c ? `background:${CATEGORY_ACCENT[c]};` : ''}">
            <span class="wf-lib-chip-dot" style="background:${CATEGORY_ACCENT[c]}"></span>${CATEGORY_LABELS[c] || c}
        </div>`).join('')}`;
    bar.querySelectorAll('.wf-lib-chip').forEach(chip => chip.addEventListener('click', () => {
        libActiveCategory = chip.dataset.cat || null;
        renderNodeLibrary();
    }));
}

function libItemHtml(nt, favs) {
    const isFav = favs.includes(nt.key);
    return `
    <div class="wf-lib-item" draggable="true" data-key="${nt.key}" title="${escapeHtml(nt.description || nt.name_ar)}">
        <div class="wf-lib-icon" style="background:${nt.color}22;color:${nt.color}">${nodeIcon(nt, 14)}</div>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(nt.name_ar || nt.name_en)}</span>
        <span class="wf-lib-fav ${isFav ? 'wf-fav-on' : ''}" data-key="${nt.key}" style="display:flex;">${isFav ? icFilled('star', 13) : ic('star', 13)}</span>
    </div>`;
}

document.querySelectorAll('.wf-lib-tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.wf-lib-tab').forEach(x => x.classList.remove('wf-lib-tab-active'));
    t.classList.add('wf-lib-tab-active');
    libActiveTab = t.dataset.libtab;
    renderNodeLibrary();
}));
document.getElementById('wfLibSearch')?.addEventListener('input', renderNodeLibrary);
