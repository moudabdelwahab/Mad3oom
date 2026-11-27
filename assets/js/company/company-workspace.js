/**
 * company-workspace.js — مساحة عمل الشركة (dock فوق المسارين الموجودين).
 *
 * ليست صفحة إدارة مضمّنة ولا نسخة ثانية من التذاكر: اللوحات تقرأ صفوف
 * المسارين المحمَّلين بالفعل (platformTickets/customerTickets عبر rows())،
 * وملخص الصندوق كما رجّعته القاعدة في الإقلاع — فلا جلب ثانٍ ولا iframe.
 * الترتيب شجرة dock-model (مجموعات وتقسيمات)، ويُحفظ في localStorage وحده
 * في v1 — لا دالة تخطيط جديدة في القاعدة.
 *
 * النقر على تذكرة يفتحها في مسارها الكامل (openTicketInItsStream من
 * company-dashboard.js)؛ و«فتح القسم كاملًا» رابط hash داخل اللوحة نفسها
 * (data-tab) فيحوّله موجّه اللوحة لا المتصفح.
 */
import {
    groupsOf, openPanel, closePanel, activatePanel, resizeSplit
} from '/assets/js/admin/workspace/dock-model.js';
import {
    WORKSPACE_PANELS, defaultWorkspaceLayout, parseWorkspaceLayout, serializeWorkspaceLayout,
    toggleWorkspaceDirection, workspaceCounts, recentTickets, workspacePanelKey, workspaceStorageKey
} from '/assets/js/company/company-workspace-model.js';
import {
    escapeHtml, timeAgo, renderState, renderSkeletonLines
} from '/assets/js/customer/portal-ui.js';

let deps = null;
let layout = null;
let wired = false;
let boxEl = null;
let dockEl = null;
let toolbarEl = null;
let streamsOk = { platform: true, customers: true };

export function initCompanyWorkspace(nextDeps) {
    deps = nextDeps;
}

/** يُحمَّل عند أول فتح للمساحة فقط (LOADERS)؛ الفشل يُبقي زر «إعادة المحاولة» العام. */
export async function loadCompanyWorkspace() {
    const box = document.getElementById('companyWorkspace');
    if (!box) return;
    if (!deps) return;
    if (!wired) wired = wire(box);
    if (!wired) return;

    renderSkeletonLines(dockEl, 4);
    let results = [true, true];
    try {
        results = await deps.ensureStreams();
    } catch {
        results = [false, false];
    }
    streamsOk = { platform: results[0] !== false, customers: results[1] !== false };
    if (!streamsOk.platform && !streamsOk.customers) {
        renderState(dockEl, {
            variant: 'error', title: 'تعذّر تحميل مساحة العمل',
            text: 'تحقق من اتصالك ثم أعد المحاولة.',
            action: { label: 'إعادة المحاولة', retry: 'workspace', variant: 'btn-primary' }
        });
        return;
    }
    if (!layout) layout = loadLayout();
    render();
}

function loadLayout() {
    let saved = null;
    try {
        saved = window.localStorage.getItem(workspaceStorageKey(deps.getCompanyId?.()));
    } catch {
        saved = null;
    }
    const parsed = parseWorkspaceLayout(saved);
    if (parsed && groupsOf(parsed).length) return parsed;
    return defaultWorkspaceLayout();
}

function saveLayout() {
    if (!layout) return;
    try {
        const raw = serializeWorkspaceLayout(layout);
        if (raw !== null) window.localStorage.setItem(workspaceStorageKey(deps.getCompanyId?.()), raw);
    } catch {
        // التخزين المحلي قد يكون ممتلئًا أو محظورًا — الترتيب يبقى للجلسة
    }
}

function wire(box) {
    boxEl = box;
    boxEl.innerHTML = `
        <section class="panel" aria-labelledby="companyWorkspaceHeading">
            <div class="panel-header">
                <div>
                    <h2 class="panel-title" id="companyWorkspaceHeading">مساحة العمل</h2>
                    <p class="panel-subtitle">تذاكر العملاء وصندوق الرسائل جنبًا إلى جنب — رتّب اللوحات كما يناسبك، ويُحفظ الترتيب على هذا الجهاز.</p>
                </div>
            </div>
            <div class="company-workspace-toolbar" id="companyWorkspaceToolbar"></div>
            <div class="company-workspace-dock" id="companyWorkspaceDock"></div>
        </section>`;
    toolbarEl = boxEl.querySelector('#companyWorkspaceToolbar');
    dockEl = boxEl.querySelector('#companyWorkspaceDock');
    toolbarEl.addEventListener('click', onToolbarClick);
    dockEl.addEventListener('click', onDockClick);
    dockEl.addEventListener('pointerdown', onDividerPointerDown);
    dockEl.addEventListener('keydown', onDividerKeyDown);
    return true;
}

function counts() {
    return workspaceCounts({
        customerRows: deps.getCustomerRows?.() || [],
        platformRows: deps.getPlatformRows?.() || [],
        inboxSummary: deps.getInboxSummary?.() || null
    });
}

function render() {
    renderToolbar();
    dockEl.innerHTML = layout?.root ? renderNode(layout.root) : '';
}

function renderToolbar() {
    const dir = layout?.root?.kind === 'split' ? layout.root.dir : 'row';
    const openKeys = new Set(Object.values(layout?.panels || {}).map(p => p.type));
    const missing = Object.keys(WORKSPACE_PANELS).filter(t => !openKeys.has(t));
    toolbarEl.innerHTML = `
        <button type="button" class="btn btn-secondary btn-sm" data-ws-action="direction">
            ${dir === 'row' ? 'عرض فوق بعض' : 'عرض جنبًا إلى جنب'}</button>
        <button type="button" class="btn btn-secondary btn-sm" data-ws-action="reset">إعادة تعيين الترتيب</button>
        ${missing.map(t => `
            <button type="button" class="btn btn-secondary btn-sm" data-ws-add="${escapeHtml(t)}">
                إضافة: ${escapeHtml(WORKSPACE_PANELS[t].label)}</button>`).join('')}`;
}

function onToolbarClick(event) {
    const btn = event.target.closest('[data-ws-action], [data-ws-add]');
    if (!btn || !layout) return;
    if (btn.hasAttribute('data-ws-add')) {
        const type = btn.getAttribute('data-ws-add');
        const res = openPanel(layout, { type, key: workspacePanelKey(type) }, {});
        if (res.panelId) { layout = res.layout; saveLayout(); render(); }
        return;
    }
    const action = btn.getAttribute('data-ws-action');
    if (action === 'direction') {
        layout = toggleWorkspaceDirection(layout);
        saveLayout();
        render();
    } else if (action === 'reset') {
        layout = defaultWorkspaceLayout();
        saveLayout();
        render();
    }
}

function renderNode(node) {
    if (node.kind === 'split') {
        const dir = node.dir === 'column' ? 'column' : 'row';
        return `<div class="company-workspace-split is-${dir}" data-ws-split="${escapeHtml(node.id)}">${node.children.map((child, i) => `
            <div class="company-workspace-cell" style="flex:${Number(node.sizes[i]) || 1} 1 0">${renderNode(child)}</div>
            ${i < node.children.length - 1
                ? `<div class="company-workspace-divider" data-ws-split="${escapeHtml(node.id)}" data-ws-index="${i}"
                       role="separator" tabindex="0" aria-label="تغيير حجم اللوحتين" aria-orientation="${dir === 'row' ? 'vertical' : 'horizontal'}"></div>`
                : ''}`).join('')}</div>`;
    }
    const group = node;
    const active = group.tabs.includes(group.active) ? group.active : group.tabs[0];
    return `<div class="company-workspace-group" data-ws-group="${escapeHtml(group.id)}">
        <div class="view-tabs" role="tablist">${group.tabs.map(panelId => {
            const panel = layout.panels[panelId];
            const def = WORKSPACE_PANELS[panel?.type];
            if (!def) return '';
            return `<button type="button" role="tab" class="view-tab" aria-selected="${panelId === active}"
                        data-ws-tab="${escapeHtml(panelId)}">${escapeHtml(def.label)}</button>`;
        }).join('')}
        ${group.tabs.length > 1 ? group.tabs.map(panelId => `
            <button type="button" class="view-tab-close" data-ws-panel-close="${escapeHtml(panelId)}"
                    aria-label="إغلاق لوحة ${escapeHtml(WORKSPACE_PANELS[layout.panels[panelId]?.type]?.label || '')}">×</button>`).join('') : ''}
        </div>
        <div class="company-workspace-body">${active ? renderPanel(layout.panels[active]) : ''}</div>
    </div>`;
}

function renderPanel(panel) {
    if (!panel) return '';
    const def = WORKSPACE_PANELS[panel.type];
    if (!def) return '';
    const c = counts();
    if (panel.type === 'inbox') {
        const open = c.inboxOpen;
        const unread = c.inboxUnread;
        const head = `
            <div class="company-workspace-panel-head">
                <span class="pill">${escapeHtml(String(open))} مفتوحة</span>
                ${unread ? `<span class="pill status-tone-warning">${escapeHtml(String(unread))} غير مقروءة</span>` : ''}
                <a class="panel-link" href="/company-dashboard/#inbox" data-tab="inbox">فتح القسم كاملًا</a>
            </div>`;
        if (!c.inboxAvailable) {
            return `${head}<p class="panel-subtitle">صندوق الرسائل غير مفعّل لهذه الشركة بعد — يُفعَّل من لوحة مالك المنصة.</p>`;
        }
        if (!open && !unread) {
            return `${head}<p class="panel-subtitle">لا محادثات مفتوحة الآن — تظهر هنا رسائل عملاء الشركة من بوابتهم.</p>`;
        }
        return `${head}<p class="panel-subtitle">أحدث المحادثات تظهر في قسم صندوق الرسائل — افتحه للرد والإسناد.</p>`;
    }
    const isCustomers = panel.type === 'customerTickets';
    const rows = isCustomers ? (deps.getCustomerRows?.() || []) : (deps.getPlatformRows?.() || []);
    const ok = isCustomers ? streamsOk.customers : streamsOk.platform;
    const total = isCustomers ? c.customersTotal : c.platformTotal;
    const openCount = isCustomers ? c.customersOpen : c.platformOpen;
    const head = `
        <div class="company-workspace-panel-head">
            <span class="pill">${escapeHtml(String(openCount))} مفتوحة من ${escapeHtml(String(total))}</span>
            <a class="panel-link" href="/company-dashboard/#${escapeHtml(def.tab)}" data-tab="${escapeHtml(def.tab)}">فتح القسم كاملًا</a>
        </div>`;
    if (!ok) return `${head}<p class="panel-subtitle">تعذّر تحميل هذا المسار — افتح قسمه الكامل لإعادة المحاولة.</p>`;
    const items = recentTickets(rows, 5);
    if (!items.length) {
        return `${head}<p class="panel-subtitle">${isCustomers ? 'لا توجد تذاكر من عملائك بعد.' : 'لا توجد تذاكر مع مدعوم.'}</p>`;
    }
    return `${head}<ul class="company-sub-list">${items.map(t => `
        <li class="company-sub is-clickable" data-ws-open-ticket="${escapeHtml(t.id)}" tabindex="0" role="button">
            <div class="company-sub-main">
                <p class="company-sub-plan">#${escapeHtml(String(t.number ?? '—'))} — ${escapeHtml(t.title)}</p>
                <p class="company-sub-dates">${t.closed ? 'مغلقة' : 'مفتوحة'} · آخر تحديث ${escapeHtml(timeAgo(t.updatedAt))}</p>
            </div>
        </li>`).join('')}</ul>`;
}

function onDockClick(event) {
    const tabBtn = event.target.closest('[data-ws-tab]');
    if (tabBtn) {
        const next = activatePanel(layout, tabBtn.getAttribute('data-ws-tab'));
        if (next !== layout) { layout = next; saveLayout(); render(); }
        return;
    }
    const closeBtn = event.target.closest('[data-ws-panel-close]');
    if (closeBtn) {
        layout = closePanel(layout, closeBtn.getAttribute('data-ws-panel-close'));
        saveLayout();
        render();
        return;
    }
    const ticket = event.target.closest('[data-ws-open-ticket]');
    if (ticket) {
        deps.onOpenTicket?.(ticket.getAttribute('data-ws-open-ticket'));
    }
}

/* ── سحب الفاصل: يحرّك العرض حيًّا، ويُثبَّت عند الإفلات ─────────────── */

let drag = null;

function onDividerPointerDown(event) {
    const divider = event.target.closest('[data-ws-split]');
    if (!divider || !layout) return;
    const splitEl = divider.closest('[data-ws-split]');
    const cells = [...splitEl.querySelectorAll(':scope > .company-workspace-cell')];
    const index = Number(divider.getAttribute('data-ws-index'));
    const splitId = divider.getAttribute('data-ws-split');
    if (!cells[index] || !cells[index + 1]) return;
    event.preventDefault();
    divider.setPointerCapture?.(event.pointerId);
    const rect = splitEl.getBoundingClientRect();
    const horizontal = splitEl.classList.contains('is-row');
    drag = { splitId, index, rect, horizontal, start: horizontal ? event.clientX : event.clientY };
    document.addEventListener('pointermove', onDividerPointerMove);
    document.addEventListener('pointerup', onDividerPointerUp, { once: true });
}

function onDividerPointerMove(event) {
    if (!drag) return;
    const total = drag.horizontal ? drag.rect.width : drag.rect.height;
    const pos = (drag.horizontal ? event.clientX : event.clientY) - (drag.horizontal ? drag.rect.left : drag.rect.top);
    const fraction = Math.max(0.12, Math.min(0.88, pos / total));
    const splitEl = dockEl.querySelector(`[data-ws-split="${drag.splitId}"]`);
    const cells = [...(splitEl?.querySelectorAll(':scope > .company-workspace-cell') || [])];
    if (!cells[drag.index] || !cells[drag.index + 1]) return;
    cells[drag.index].style.flex = `${fraction} 1 0`;
    cells[drag.index + 1].style.flex = `${1 - fraction} 1 0`;
    drag.fraction = fraction;
}

function onDividerPointerUp() {
    document.removeEventListener('pointermove', onDividerPointerMove);
    if (!drag || drag.fraction === undefined) { drag = null; return; }
    const { splitId, index, fraction } = drag;
    drag = null;
    // resizeSplit يحسب الفرق من الحجم الحالي؛ نمرّر الفرق بين المطلوب والحالي
    const node = findSplitNode(layout.root, splitId);
    if (!node) return;
    const delta = fraction - (node.sizes[index] || 0.5);
    const next = resizeSplit(layout, splitId, index, delta);
    if (next !== layout) { layout = next; saveLayout(); render(); }
    else render();
}

function findSplitNode(node, id) {
    if (!node) return null;
    if (node.id === id) return node;
    if (node.kind === 'split') {
        for (const child of node.children) {
            const found = findSplitNode(child, id);
            if (found) return found;
        }
    }
    return null;
}

function onDividerKeyDown(event) {
    const divider = event.target.closest('[data-ws-split]');
    if (!divider || !layout) return;
    const horizontal = divider.closest('.company-workspace-split')?.classList.contains('is-row');
    const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -0.05
        : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 0.05 : 0;
    if (!step) return;
    if ((horizontal && (event.key === 'ArrowUp' || event.key === 'ArrowDown'))
        || (!horizontal && (event.key === 'ArrowLeft' || event.key === 'ArrowRight'))) return;
    event.preventDefault();
    const next = resizeSplit(layout, divider.getAttribute('data-ws-split'),
        Number(divider.getAttribute('data-ws-index')), step);
    if (next !== layout) { layout = next; saveLayout(); render(); }
}

// للاختبار اليدوي من وحدة التحكم: إعادة رسم المساحة من الصفوف الحالية.
export function refreshCompanyWorkspace() {
    if (wired && layout) render();
}
