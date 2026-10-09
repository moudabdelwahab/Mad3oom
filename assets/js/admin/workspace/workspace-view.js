/**
 * workspace-view.js — رسم مساحة العمل والتفاعل معها
 * ---------------------------------------------------------------------------
 * يرسم الشجرة (تقسيمات، فواصل، مجموعات، أشرطة تبويب، أجسام فارغة تقف تحتها
 * الإطارات)، ويترجم السحب والإفلات ولوحة المفاتيح إلى نداءات للمتحكم. لا
 * يعدّل الترتيب بنفسه أبدًا — يقترح، والمتحكم (workspace.js) يقرر ويعيد الرسم.
 *
 * الرسم كامل في كل مرة: الشجرة عشرات العناصر، وإعادة رسمها أبسط وأصح من
 * مزامنة يدوية. الإطارات خارجها (frame-host.js) فلا تتأثر بإعادة الرسم.
 * الاستثناء الوحيد: سحب الفاصل يغيّر flex-grow مباشرة أثناء الحركة (إعادة
 * الرسم كانت ستُسقط التقاط المؤشر)، ثم يُثبَّت في الترتيب عند الإفلات.
 *
 * RTL: النموذج يعرف start/end فقط. الترجمة من «يمين/يسار» الشاشة تحدث هنا
 * (toLogical)، وكذلك عكس اتجاه سحب الفاصل وأسهم لوحة المفاتيح.
 */
import { groupsOf, panelOrder, findGroup } from './dock-model.js';
import { t, icon, isRtl, defaultTitle } from './workspace-strings.js';
import { panelType } from './panel-registry.js';

const MIME = 'application/x-mad3oom-panel';
const MIN_PX = { row: 220, column: 140 };
const EDGE_ZONE = 0.25;
const KEY_STEP = 0.05;

function h(tag, className, attrs = {}) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        el.setAttribute(k, v === true ? '' : String(v));
    }
    return el;
}

/** يمين/يسار الشاشة ⇒ بداية/نهاية منطقية حسب اتجاه الصفحة. */
export function toLogical(edge, rtl = isRtl()) {
    if (edge === 'left') return rtl ? 'end' : 'start';
    if (edge === 'right') return rtl ? 'start' : 'end';
    return edge;
}

/**
 * @param {{root: HTMLElement, tree: HTMLElement, drop: HTMLElement, handlers: object}} options
 *   handlers: activate, close, move, dock, resize, preview, menu, focusPanel,
 *             dragState, groupFocus, emptyAction, retry
 */
export function createView({ root, tree, drop, handlers }) {
    let model = null;
    let dragging = null;
    let menuEl = null;
    let menuReturn = null;

    /* ====================  الرسم  ==================== */

    function titleOf(panelId) {
        const p = model.layout.panels[panelId];
        return model.titles.get(panelId) || defaultTitle(p?.type);
    }

    function renderTab(panelId, group, activeId) {
        const p = model.layout.panels[panelId];
        const active = panelId === activeId;
        const status = model.status.get(panelId);
        const dirty = model.dirty.get(panelId);
        const title = titleOf(panelId);
        const tab = h('div', `ws-tab${active ? ' is-active' : ''}${status === 'unavailable' ? ' is-unavailable' : ''}`, {
            role: 'tab',
            id: `wst-${panelId}`,
            'aria-selected': active ? 'true' : 'false',
            'aria-controls': `wsb-${group}`,
            tabindex: active ? '0' : '-1',
            draggable: model.compact ? null : 'true',
            'data-panel': panelId,
            title
        });
        tab.innerHTML = `<span class="ws-tab-icon">${icon(status === 'unavailable' ? 'warning' : panelType(p.type)?.icon)}</span>`;
        const label = h('span', 'ws-tab-title');
        label.textContent = title;
        tab.appendChild(label);
        if (dirty) {
            const dot = h('span', 'ws-tab-dirty', { role: 'img', 'aria-label': t('dirtyLabel'), title: t('dirtyLabel') });
            tab.appendChild(dot);
        }
        const close = h('button', 'ws-tab-close', { type: 'button', tabindex: '-1', 'aria-label': t('closeNamed', { title }), 'data-close': panelId });
        close.innerHTML = icon('close', 13);
        tab.appendChild(close);
        return tab;
    }

    function renderBodyState(body, panelId) {
        if (!panelId) return;
        const status = model.status.get(panelId);
        if (status === 'unavailable') {
            const box = h('div', 'ws-state ws-state--warn', { role: 'status' });
            box.innerHTML = `${icon('warning', 28)}<h3></h3><p></p><div class="ws-state-actions"></div>`;
            box.querySelector('h3').textContent = t('unavailableTitle');
            box.querySelector('p').textContent = t('unavailableBody');
            const actions = box.querySelector('.ws-state-actions');
            const retry = h('button', 'ws-btn', { type: 'button', 'data-retry': panelId });
            retry.textContent = t('retry');
            const close = h('button', 'ws-btn ws-btn--primary', { type: 'button', 'data-close': panelId });
            close.textContent = t('closeTab');
            actions.append(retry, close);
            body.appendChild(box);
            return;
        }
        const loading = h('div', 'ws-state ws-state--loading', { 'aria-hidden': 'true' });
        loading.innerHTML = `<span class="ws-spinner"></span><span></span>`;
        loading.lastChild.textContent = t('loading');
        body.appendChild(loading);
    }

    function renderGroup(groupId, tabs, activeId, { isActiveGroup, compact = false }) {
        const section = h('section', `ws-group${isActiveGroup ? ' is-active' : ''}`, { 'data-group': groupId });
        const bar = h('div', 'ws-tabbar');
        const list = h('div', 'ws-tabs', { role: 'tablist', 'aria-label': t('tabsOf'), 'data-tabs': groupId });
        for (const panelId of tabs) list.appendChild(renderTab(panelId, groupId, activeId));
        bar.appendChild(list);

        const actions = h('div', 'ws-tabbar-actions');
        if (!compact) {
            const split = h('button', 'ws-icon-btn', { type: 'button', 'data-split': groupId, title: t('splitSide'), 'aria-label': t('splitSide'), disabled: tabs.length < 2 });
            split.innerHTML = icon('split');
            actions.appendChild(split);
        }
        const more = h('button', 'ws-icon-btn', { type: 'button', 'data-more': activeId || '', title: t('tabMenu'), 'aria-label': t('tabMenu'), 'aria-haspopup': 'menu', disabled: !activeId });
        more.innerHTML = icon('more');
        actions.appendChild(more);
        bar.appendChild(actions);

        const body = h('div', 'ws-group-body', {
            role: 'tabpanel', id: `wsb-${groupId}`, 'aria-labelledby': activeId ? `wst-${activeId}` : null,
            'data-body': groupId, tabindex: '-1'
        });
        renderBodyState(body, activeId);
        section.append(bar, body);
        return section;
    }

    function renderDivider(split, index) {
        const vertical = split.dir === 'row';
        const now = Math.round(split.sizes[index] * 100);
        return h('div', `ws-divider ws-divider--${split.dir}`, {
            role: 'separator', tabindex: '0',
            'aria-orientation': vertical ? 'vertical' : 'horizontal',
            'aria-label': t('resizeLabel'),
            'aria-valuenow': now, 'aria-valuemin': '0', 'aria-valuemax': '100',
            'data-split': split.id, 'data-index': index
        });
    }

    function renderNode(node) {
        if (node.kind === 'group') {
            return renderGroup(node.id, node.tabs, node.active, { isActiveGroup: node.id === model.layout.activeGroup });
        }
        const el = h('div', `ws-split ws-split--${node.dir}`, { 'data-split-node': node.id });
        node.children.forEach((child, i) => {
            if (i > 0) el.appendChild(renderDivider(node, i - 1));
            const cell = h('div', 'ws-cell', { 'data-cell': `${node.id}:${i}` });
            cell.style.flex = `${node.sizes[i]} 1 0px`;
            cell.appendChild(renderNode(child));
            el.appendChild(cell);
        });
        return el;
    }

    function renderEmpty() {
        const box = h('div', 'ws-empty');
        box.innerHTML = `${icon('layout', 40)}<h2></h2><p></p><div class="ws-empty-actions"></div>`;
        box.querySelector('h2').textContent = t('emptyTitle');
        box.querySelector('p').textContent = t('emptyBody');
        const actions = box.querySelector('.ws-empty-actions');
        for (const [action, label, primary] of [
            ['quick', t('emptyQuick'), true], ['starter:desk', t('starter_desk')], ['open:inbox', defaultTitle('inbox')],
            ['open:tickets', defaultTitle('tickets')], ['open:customers', defaultTitle('customers')]
        ]) {
            const btn = h('button', `ws-btn${primary ? ' ws-btn--primary' : ''}`, { type: 'button', 'data-empty': action });
            btn.textContent = label;
            actions.appendChild(btn);
        }
        return box;
    }

    /**
     * @param {{layout, titles: Map, dirty: Map, status: Map, compact: boolean}} next
     */
    function render(next) {
        model = next;
        // التركيز يُستعاد فقط لو كان على عنصر داخل الشجرة. الإطارات تحمل
        // data-panel أيضًا، ولو عاملناها كتبويب لسرقنا التركيز من موظف يكتب
        // داخل لوحة في كل مرة يصل فيها عنوان أو حالة مسودة.
        const focused = tree.contains(document.activeElement) ? document.activeElement : null;
        const focusKey = focused?.classList.contains('ws-tab') ? { panel: focused.dataset.panel }
            : focused?.classList.contains('ws-divider') ? { divider: `${focused.dataset.split}:${focused.dataset.index}` }
            : null;

        tree.replaceChildren();
        root.classList.toggle('is-compact', model.compact);
        if (!model.layout.root) {
            tree.appendChild(renderEmpty());
        } else if (model.compact) {
            const group = findGroup(model.layout, model.layout.activeGroup);
            tree.appendChild(renderGroup('compact', panelOrder(model.layout), group?.active ?? null, { isActiveGroup: true, compact: true }));
        } else {
            tree.appendChild(renderNode(model.layout.root));
        }

        if (focusKey?.panel) tree.querySelector(`.ws-tab[data-panel="${CSS.escape(focusKey.panel)}"]`)?.focus();
        if (focusKey?.divider) {
            const [split, index] = focusKey.divider.split(':');
            tree.querySelector(`.ws-divider[data-split="${CSS.escape(split)}"][data-index="${CSS.escape(index)}"]`)?.focus();
        }
    }

    /** جسم المجموعة الذي يقف تحته إطار التبويب النشط فيها. */
    function bodyFor(groupId) {
        return tree.querySelector(`[data-body="${CSS.escape(model?.compact ? 'compact' : groupId)}"]`);
    }

    function focusTab(panelId) {
        tree.querySelector(`.ws-tab[data-panel="${CSS.escape(panelId)}"]`)?.focus();
    }

    /* ====================  النقر ولوحة المفاتيح  ==================== */

    tree.addEventListener('click', (event) => {
        const target = event.target;
        const close = target.closest('[data-close]');
        if (close) { event.stopPropagation(); handlers.close(close.dataset.close); return; }
        const retry = target.closest('[data-retry]');
        if (retry) { handlers.retry(retry.dataset.retry); return; }
        const split = target.closest('[data-split]:not(.ws-divider)');
        if (split) { handlers.splitGroup(split.dataset.split); return; }
        const more = target.closest('[data-more]');
        if (more) { if (more.dataset.more) handlers.menu(more.dataset.more, { anchor: more }); return; }
        const empty = target.closest('[data-empty]');
        if (empty) { handlers.emptyAction(empty.dataset.empty); return; }
        const tab = target.closest('.ws-tab');
        if (tab) { handlers.activate(tab.dataset.panel); return; }
        const group = target.closest('[data-group]');
        if (group && group.dataset.group !== 'compact') handlers.groupFocus(group.dataset.group);
    });

    // زر الفأرة الأوسط يغلق التبويب، كالمتصفح.
    tree.addEventListener('auxclick', (event) => {
        const tab = event.button === 1 && event.target.closest('.ws-tab');
        if (tab) { event.preventDefault(); handlers.close(tab.dataset.panel); }
    });

    tree.addEventListener('contextmenu', (event) => {
        const tab = event.target.closest('.ws-tab');
        if (!tab) return;
        event.preventDefault();
        handlers.menu(tab.dataset.panel, { x: event.clientX, y: event.clientY, returnTo: tab });
    });

    tree.addEventListener('keydown', (event) => {
        const tab = event.target.closest?.('.ws-tab');
        if (tab && event.target === tab) return onTabKey(event, tab);
        const divider = event.target.closest?.('.ws-divider');
        if (divider) onDividerKey(event, divider);
    });

    function onTabKey(event, tab) {
        const tabs = [...tab.parentElement.querySelectorAll('.ws-tab')];
        const at = tabs.indexOf(tab);
        const panelId = tab.dataset.panel;
        const rtl = isRtl();
        const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
        // «التالي» بصريًا: يسارًا في RTL، يمينًا في LTR.
        const forward = (event.key === 'ArrowRight') !== rtl;

        if (horizontal && event.altKey && event.shiftKey) {
            event.preventDefault();
            const groupId = tab.closest('[data-group]').dataset.group;
            if (groupId === 'compact') return;
            const target = forward ? at + 2 : at - 1;
            if (target < 0 || target > tabs.length) return;
            handlers.move(panelId, groupId, target, { keepFocus: true });
            return;
        }
        if (horizontal) {
            event.preventDefault();
            tabs[(at + (forward ? 1 : -1) + tabs.length) % tabs.length].focus();
        } else if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            tabs[event.key === 'Home' ? 0 : tabs.length - 1].focus();
        } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (tab.getAttribute('aria-selected') === 'true') handlers.focusPanel(panelId);
            else handlers.activate(panelId, { keepFocus: true });
        } else if (event.key === 'Delete') {
            event.preventDefault();
            const neighbour = tabs[at + 1] || tabs[at - 1];
            handlers.close(panelId, { thenFocus: neighbour?.dataset.panel });
        } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
            event.preventDefault();
            handlers.menu(panelId, { anchor: tab, returnTo: tab });
        }
    }

    /* ====================  الفواصل  ==================== */

    function splitGeometry(divider) {
        const container = divider.parentElement;
        const dir = container.classList.contains('ws-split--row') ? 'row' : 'column';
        const rect = container.getBoundingClientRect();
        const dividers = [...container.children].filter((c) => c.classList.contains('ws-divider'));
        const thickness = dividers.reduce((sum, d) => sum + (dir === 'row' ? d.offsetWidth : d.offsetHeight), 0);
        const size = Math.max(1, (dir === 'row' ? rect.width : rect.height) - thickness);
        return { dir, size, minFraction: Math.min(0.45, MIN_PX[dir] / size) };
    }

    function onDividerKey(event, divider) {
        const { dir, minFraction } = splitGeometry(divider);
        const keys = dir === 'row' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
        if (!keys.includes(event.key)) return;
        event.preventDefault();
        let delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? KEY_STEP : -KEY_STEP;
        if (dir === 'row' && isRtl()) delta = -delta;
        handlers.resize(divider.dataset.split, Number(divider.dataset.index), delta, minFraction);
    }

    tree.addEventListener('pointerdown', (event) => {
        const divider = event.target.closest('.ws-divider');
        if (!divider || event.button !== 0) return;
        event.preventDefault();
        const { dir, size, minFraction } = splitGeometry(divider);
        const index = Number(divider.dataset.index);
        const cells = [...divider.parentElement.children].filter((c) => c.classList.contains('ws-cell'));
        const before = cells[index];
        const after = cells[index + 1];
        const a = parseFloat(before.style.flexGrow);
        const b = parseFloat(after.style.flexGrow);
        const start = dir === 'row' ? event.clientX : event.clientY;
        const sign = dir === 'row' && isRtl() ? -1 : 1;
        const min = Math.min(minFraction, (a + b) / 2);
        let delta = 0;

        divider.setPointerCapture(event.pointerId);
        divider.classList.add('is-dragging');
        handlers.dragState(true);

        const move = (e) => {
            const raw = (((dir === 'row' ? e.clientX : e.clientY) - start) / size) * sign;
            delta = Math.max(min - a, Math.min(b - min, raw));
            before.style.flexGrow = String(a + delta);
            after.style.flexGrow = String(b - delta);
            handlers.preview();
        };
        const up = () => {
            divider.removeEventListener('pointermove', move);
            divider.removeEventListener('pointerup', up);
            divider.removeEventListener('pointercancel', up);
            divider.classList.remove('is-dragging');
            handlers.dragState(false);
            if (delta !== 0) handlers.resize(divider.dataset.split, index, delta, minFraction);
        };
        divider.addEventListener('pointermove', move);
        divider.addEventListener('pointerup', up);
        divider.addEventListener('pointercancel', up);
    });

    /* ====================  السحب والإفلات  ==================== */

    function hideDrop() {
        drop.hidden = true;
        drop.className = 'ws-drop';
    }

    function showDropRect(rect, kind) {
        const base = root.getBoundingClientRect();
        drop.hidden = false;
        drop.className = `ws-drop ws-drop--${kind}`;
        drop.style.left = `${rect.left - base.left}px`;
        drop.style.top = `${rect.top - base.top}px`;
        drop.style.width = `${rect.width}px`;
        drop.style.height = `${rect.height}px`;
    }

    /** أين سيقع التبويب؟ {groupId, index} فوق شريط التبويبات، أو {groupId, edge} فوق الجسم. */
    function dropTarget(event) {
        const x = event.clientX;
        const y = event.clientY;
        const tabs = event.target.closest?.('.ws-tabbar')?.querySelector('.ws-tabs');
        if (tabs) {
            const groupId = tabs.dataset.tabs;
            if (groupId === 'compact') return null;
            const rtl = isRtl();
            const items = [...tabs.querySelectorAll('.ws-tab')];
            let index = items.length;
            for (let i = 0; i < items.length; i++) {
                const r = items[i].getBoundingClientRect();
                const mid = r.left + r.width / 2;
                if (rtl ? x > mid : x < mid) { index = i; break; }
            }
            const bar = tabs.getBoundingClientRect();
            const ref = items[index] || items[items.length - 1];
            let edgeX;
            if (!ref) edgeX = rtl ? bar.right : bar.left;
            else if (items[index]) { const r = ref.getBoundingClientRect(); edgeX = rtl ? r.right : r.left; }
            else { const r = ref.getBoundingClientRect(); edgeX = rtl ? r.left : r.right; }
            return { groupId, index, marker: { left: edgeX - 1, top: bar.top, width: 3, height: bar.height } };
        }
        const body = event.target.closest?.('.ws-group-body');
        if (!body || body.dataset.body === 'compact') return null;
        const r = body.getBoundingClientRect();
        const fx = (x - r.left) / r.width;
        const fy = (y - r.top) / r.height;
        const [edge, distance] = Object.entries({ left: fx, right: 1 - fx, top: fy, bottom: 1 - fy })
            .sort((p, q) => p[1] - q[1])[0];
        const physical = distance > EDGE_ZONE ? 'center' : edge;
        const half = {
            center: r,
            left: { left: r.left, top: r.top, width: r.width / 2, height: r.height },
            right: { left: r.left + r.width / 2, top: r.top, width: r.width / 2, height: r.height },
            top: { left: r.left, top: r.top, width: r.width, height: r.height / 2 },
            bottom: { left: r.left, top: r.top + r.height / 2, width: r.width, height: r.height / 2 }
        }[physical];
        return { groupId: body.dataset.body, edge: toLogical(physical), physical, marker: half };
    }

    tree.addEventListener('dragstart', (event) => {
        const tab = event.target.closest?.('.ws-tab');
        if (!tab || model.compact) return;
        dragging = tab.dataset.panel;
        event.dataTransfer.setData(MIME, dragging);
        event.dataTransfer.effectAllowed = 'move';
        tab.classList.add('is-drag-source');
        root.classList.add('is-dragging');
        handlers.dragState(true);
    });

    tree.addEventListener('dragover', (event) => {
        if (!dragging || !event.dataTransfer.types.includes(MIME)) return;
        const target = dropTarget(event);
        if (!target) { hideDrop(); return; }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        showDropRect(target.marker, target.edge ? `zone ws-drop--${target.physical}` : 'tab');
    });

    tree.addEventListener('dragleave', (event) => {
        if (!root.contains(event.relatedTarget)) hideDrop();
    });

    tree.addEventListener('drop', (event) => {
        if (!dragging) return;
        const target = dropTarget(event);
        const panelId = dragging;
        event.preventDefault();
        endDrag();
        if (!target) return;
        if (target.edge) handlers.dock(panelId, target.groupId, target.edge);
        else handlers.move(panelId, target.groupId, target.index);
    });

    function endDrag() {
        dragging = null;
        hideDrop();
        root.classList.remove('is-dragging');
        tree.querySelector('.is-drag-source')?.classList.remove('is-drag-source');
        handlers.dragState(false);
    }

    tree.addEventListener('dragend', () => { if (dragging) endDrag(); });

    /* ====================  القائمة  ==================== */

    function closeMenu({ restoreFocus = true } = {}) {
        if (!menuEl) return;
        menuEl.remove();
        menuEl = null;
        document.removeEventListener('pointerdown', onOutside, true);
        if (restoreFocus && menuReturn) {
            // الشجرة ربما أُعيد رسمها والقائمة مفتوحة: نعود لنفس التبويب بمعرّفه.
            const target = menuReturn.isConnected ? menuReturn
                : menuReturn.dataset?.panel ? tree.querySelector(`.ws-tab[data-panel="${CSS.escape(menuReturn.dataset.panel)}"]`) : null;
            target?.focus();
        }
        menuReturn = null;
    }

    function onOutside(event) {
        if (menuEl && !menuEl.contains(event.target)) closeMenu({ restoreFocus: false });
    }

    /**
     * @param {Array<{label: string, run?: Function, disabled?: boolean, separator?: boolean, icon?: string}>} items
     * @param {{anchor?: HTMLElement, x?: number, y?: number, returnTo?: HTMLElement}} where
     */
    function openMenu(items, where) {
        closeMenu({ restoreFocus: false });
        menuReturn = where.returnTo || where.anchor || document.activeElement;
        menuEl = h('div', 'ws-menu', { role: 'menu', 'aria-label': t('tabMenu') });
        for (const item of items) {
            if (item.separator) { menuEl.appendChild(h('div', 'ws-menu-sep', { role: 'separator' })); continue; }
            const btn = h('button', 'ws-menu-item', { type: 'button', role: 'menuitem', tabindex: '-1', disabled: item.disabled });
            btn.innerHTML = item.icon ? icon(item.icon, 14) : '<span class="ws-menu-gap"></span>';
            const label = h('span');
            label.textContent = item.label;
            btn.appendChild(label);
            btn.addEventListener('click', () => { closeMenu(); item.run?.(); });
            menuEl.appendChild(btn);
        }
        document.body.appendChild(menuEl);

        const rect = where.anchor ? where.anchor.getBoundingClientRect() : { left: where.x, right: where.x, bottom: where.y, top: where.y };
        const mw = menuEl.offsetWidth;
        const mh = menuEl.offsetHeight;
        let left = isRtl() ? rect.right - mw : rect.left;
        let top = rect.bottom + 4;
        left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
        if (top + mh > window.innerHeight - 8) top = Math.max(8, rect.top - mh - 4);
        menuEl.style.left = `${left}px`;
        menuEl.style.top = `${top}px`;

        const buttons = () => [...menuEl.querySelectorAll('.ws-menu-item:not([disabled])')];
        buttons()[0]?.focus();
        menuEl.addEventListener('keydown', (event) => {
            const list = buttons();
            const at = list.indexOf(document.activeElement);
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                list[(at + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
            } else if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault();
                list[event.key === 'Home' ? 0 : list.length - 1]?.focus();
            } else if (event.key === 'Escape' || event.key === 'Tab') {
                event.preventDefault();
                closeMenu();
            }
        });
        document.addEventListener('pointerdown', onOutside, true);
    }

    return { render, bodyFor, focusTab, openMenu, closeMenu, groupsOf: () => groupsOf(model.layout) };
}
