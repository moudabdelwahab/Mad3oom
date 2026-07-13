/* =====================================================================
   node-library.js
   ---------------------------------------------------------------------
   The left-hand "Node Library" panel in the builder: search, the
   all/favorites/recent tabs, collapsible category groups, drag-to-canvas
   and the favorite-star toggle. Depends on the canvas engine only to
   place a node when a library item is double-clicked (no other module
   needs to reach back into this one, so this stays a clean leaf feature).
   ===================================================================== */
import { escapeHtml, ic, icFilled, CATEGORY_LABELS, CATEGORY_ORDER, CATEGORY_ACCENT, getFavorites, toggleFavorite, getRecent } from './common.js';
import { appState } from './state.js';
import { Canvas } from './canvas.js';

let libActiveTab = 'all';
let libCollapsedCats = new Set();

export function renderNodeLibrary() {
    const body = document.getElementById('wfLibBody');
    const q = (document.getElementById('wfLibSearch')?.value || '').trim().toLowerCase();
    const favs = getFavorites();
    let types = appState.nodeTypes.filter(nt => !q || `${nt.name_ar} ${nt.name_en} ${nt.key}`.toLowerCase().includes(q));

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

    if (libActiveTab !== 'all') {
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
    });
}

function libItemHtml(nt, favs) {
    const isFav = favs.includes(nt.key);
    return `
    <div class="wf-lib-item" draggable="true" data-key="${nt.key}" title="${escapeHtml(nt.description || nt.name_ar)}">
        <div class="wf-lib-icon" style="background:${nt.color}22;color:${nt.color}">${nt.icon || ic('settings', 14)}</div>
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
