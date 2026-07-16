/* =====================================================================
   canvas.js
   ---------------------------------------------------------------------
   The visual node-graph engine: rendering nodes/edges, pan & zoom,
   drag-to-move, drag-to-link, marquee selection, the minimap, undo/redo
   history and keyboard shortcuts, and auto-layout.

   This is a fairly direct lift of the original `Canvas` IIFE. It depends
   only on `common.js` (pure helpers/icons) and `state.js` (appState +
   the validation engine + the `ui` service locator). It deliberately does
   NOT import the inspector/side-panels/builder-shell modules directly —
   calls into those (e.g. "re-render the inspector after a node moves")
   go through `ui.xxx()` instead, since those modules need to call back
   into the canvas too (e.g. "Canvas.render()" after a version restore).
   Routing through the `ui` registry keeps this module's dependencies
   one-directional instead of circular.
   ===================================================================== */
import { escapeHtml, ic, nodeIcon, uid, pushRecent, CATEGORY_LABELS } from './common.js';
import { appState, ui, validateDefinition } from './state.js';

const NODE_W = 220, NODE_H_APPROX = 90;

export const Canvas = (() => {
    let session = null;
    let viewport, world, edgesSvg, edgesGroup, nodesLayer, canvasWrap;
    let dragState = null;      // { mode: 'pan'|'node'|'marquee'|'link', ... }
    let linkingFrom = null;    // { nodeId } while dragging a new edge from an output port

    function init() {
        viewport = document.getElementById('wfViewport');
        world = document.getElementById('wfWorld');
        edgesSvg = document.getElementById('wfEdgesSvg');
        edgesGroup = document.getElementById('wfEdgesGroup');
        nodesLayer = document.getElementById('wfNodesLayer');
        canvasWrap = document.getElementById('wfCanvasWrap');
        canvasWrap.setAttribute('dir', 'ltr'); // إحداثيات المخطط دائمًا LTR (يمين=مخرج، يسار=مدخل) بصرف النظر عن اتجاه الواجهة

        viewport.addEventListener('pointerdown', onViewportPointerDown);
        viewport.addEventListener('contextmenu', (e) => e.preventDefault());
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        viewport.addEventListener('wheel', onWheel, { passive: false });
        viewport.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
        viewport.addEventListener('drop', onDrop);
        document.addEventListener('keydown', onKeyDown);

        document.getElementById('wfZoomIn').addEventListener('click', () => zoomBy(1.2));
        document.getElementById('wfZoomOut').addEventListener('click', () => zoomBy(1 / 1.2));
        document.getElementById('wfZoomFit').addEventListener('click', zoomToFit);
        document.getElementById('wfUndoBtn').addEventListener('click', undo);
        document.getElementById('wfRedoBtn').addEventListener('click', redo);
        document.getElementById('wfAutoLayoutBtn').addEventListener('click', autoLayout);
    }

    function mount(s) {
        session = s;
        applyTransform();
        render();
    }

    function applyTransform() {
        world.style.transform = `translate(${session.view.pan.x}px, ${session.view.pan.y}px) scale(${session.view.zoom})`;
        document.getElementById('wfZoomLevel').textContent = Math.round(session.view.zoom * 100) + '%';
    }

    /* ---------------- Rendering ---------------- */
    function render() {
        if (!session) return;
        const nodes = session.definition.nodes || [];
        const issues = validateDefinition(session.definition);
        const issuesByNode = {};
        issues.forEach(i => { if (i.nodeId) (issuesByNode[i.nodeId] = issuesByNode[i.nodeId] || []).push(i); });

        document.getElementById('wfCanvasEmpty').classList.toggle('wf-hidden', nodes.length > 0);

        nodesLayer.innerHTML = nodes.map(n => nodeHtml(n, issuesByNode[n.id])).join('');
        nodesLayer.querySelectorAll('.wf-node').forEach(bindNodeEvents);
        updateEdgePaths();
        renderMinimap();
        ui.updateValidationCount(issues);
        ui.renderBottomPanel();
    }

    function nodeHtml(n, nodeIssues) {
        const nt = appState.nodeTypesByKey[n.type];
        const selected = session.selection.nodeIds.has(n.id);
        const hasError = (nodeIssues || []).some(i => i.level === 'error');
        const hasWarn = (nodeIssues || []).some(i => i.level === 'warn');
        const badge = nodeStatusBadge(n, nt, hasError);
        if (!nt) {
            return `<div class="wf-node wf-node-selected" data-id="${n.id}" data-type="${escapeHtml(n.type)}" style="left:${n.position.x}px;top:${n.position.y}px;border-color:var(--wf-danger)">
                <div class="wf-node-head"><div class="wf-node-icon" style="background:var(--wf-danger)">${ic('alertTriangle', 14)}</div><div class="wf-node-title">نوع غير معروف: ${escapeHtml(n.type)}</div></div>
                <span class="wf-port wf-port-in"></span><span class="wf-port wf-port-out"></span>
            </div>`;
        }
        const isIfElse = n.type === 'condition.if_else';
        const outPortsHtml = isIfElse ? `
            <span class="wf-port-branch wf-port-branch-true" data-port="true">
                <span class="wf-port-branch-label">إذا</span><span class="wf-port wf-port-out" data-port="true"></span>
            </span>
            <span class="wf-port-branch wf-port-branch-false" data-port="false">
                <span class="wf-port-branch-label">لكن</span><span class="wf-port wf-port-out" data-port="false"></span>
            </span>` : '<span class="wf-port wf-port-out" data-port="default"></span>';
        return `
        <div class="wf-node ${selected ? 'wf-node-selected' : ''}" data-id="${n.id}" data-type="${escapeHtml(n.type)}" style="left:${n.position.x}px;top:${n.position.y}px;">
            <div class="wf-node-head">
                <div class="wf-node-icon" style="background:${nt.color}">${nodeIcon(nt, 14)}</div>
                <div class="wf-node-title">${escapeHtml(n.label || nt.name_ar || nt.name_en)}</div>
                ${hasError ? '<span title="يوجد خطأ في الإعدادات" style="color:var(--wf-danger)">●</span>' : (hasWarn ? '<span title="ملاحظة" style="color:var(--wf-pill-amber-text)">●</span>' : '')}
            </div>
            <div class="wf-node-body">${escapeHtml(nt.description || '')}</div>
            <div class="wf-node-foot">${badge}<span style="font-size:.6rem;color:var(--wf-text-3);font-family:var(--wf-font-data)">${CATEGORY_LABELS[nt.category] || nt.category}</span></div>
            ${nt.category !== 'trigger' ? '<span class="wf-port wf-port-in" data-port="in"></span>' : ''}
            ${outPortsHtml}
        </div>`;
    }

    function nodeStatusBadge(n, nt, hasError) {
        if (hasError) return '<span class="wf-badge wf-badge-red"><span class="wf-badge-dot"></span>خطأ</span>';
        if (!nt) return '';
        if (!nt.handler_type) return '<span class="wf-badge wf-badge-amber"><span class="wf-badge-dot"></span>بانتظار التنفيذ</span>';
        if (session.status === 'active') return '<span class="wf-badge wf-badge-green"><span class="wf-badge-dot"></span>منشور</span>';
        return '<span class="wf-badge wf-badge-blue"><span class="wf-badge-dot"></span>جاهز</span>';
    }

    function updateEdgePaths() {
        const nodes = session.definition.nodes || [];
        const edges = session.definition.edges || [];
        const byId = {}; nodes.forEach(n => byId[n.id] = n);

        let maxX = 400, maxY = 300;
        nodesLayer.querySelectorAll('.wf-node').forEach(el => {
            const id = el.dataset.id; const n = byId[id]; if (!n) return;
            maxX = Math.max(maxX, n.position.x + el.offsetWidth + 200);
            maxY = Math.max(maxY, n.position.y + el.offsetHeight + 200);
        });
        edgesSvg.setAttribute('width', maxX);
        edgesSvg.setAttribute('height', maxY);

        edgesGroup.innerHTML = edges.map(e => {
            const s = byId[e.source], t = byId[e.target];
            if (!s || !t) return '';
            const sEl = nodesLayer.querySelector(`.wf-node[data-id="${e.source}"]`);
            const tEl = nodesLayer.querySelector(`.wf-node[data-id="${e.target}"]`);
            const sh = sEl ? sEl.offsetHeight : 90, th = tEl ? tEl.offsetHeight : 90;
            const portFrac = s.type === 'condition.if_else' ? (e.source_port === 'false' ? 0.70 : 0.36) : 0.5;
            const x1 = s.position.x + NODE_W, y1 = s.position.y + sh * portFrac;
            const x2 = t.position.x, y2 = t.position.y + th / 2;
            const dx = Math.max(60, Math.abs(x2 - x1) * 0.5);
            const d = `M ${x1},${y1} C ${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
            const selected = session.selection.edgeId === e.id;
            const branchClass = s.type === 'condition.if_else' ? (e.source_port === 'false' ? 'wf-edge-branch-false' : 'wf-edge-branch-true') : '';
            return `<path class="wf-edge-hit" data-edge="${e.id}" d="${d}"></path>
                    <path class="wf-edge-path ${selected ? 'wf-edge-selected' : ''} ${branchClass}" d="${d}" marker-end="url(#wfArrow)" data-edge-visual="${e.id}"></path>`;
        }).join('');

        edgesGroup.querySelectorAll('.wf-edge-hit').forEach(p => {
            p.addEventListener('click', (e) => {
                e.stopPropagation();
                session.selection.edgeId = p.dataset.edge;
                session.selection.nodeIds.clear();
                render(); ui.renderInspector();
            });
        });
    }

    function renderMinimap() {
        const inner = document.getElementById('wfMinimapInner');
        const nodes = session.definition.nodes || [];
        if (!nodes.length) { inner.innerHTML = ''; return; }
        const xs = nodes.map(n => n.position.x), ys = nodes.map(n => n.position.y);
        const minX = Math.min(...xs) - 40, maxX = Math.max(...xs) + NODE_W + 40;
        const minY = Math.min(...ys) - 40, maxY = Math.max(...ys) + NODE_H_APPROX + 40;
        const spanX = Math.max(200, maxX - minX), spanY = Math.max(140, maxY - minY);
        const scale = Math.min(170 / spanX, 110 / spanY);

        let html = nodes.map(n => {
            const nt = appState.nodeTypesByKey[n.type];
            const x = (n.position.x - minX) * scale, y = (n.position.y - minY) * scale;
            return `<div class="wf-minimap-node" style="left:${x}px;top:${y}px;width:${NODE_W * scale}px;height:${20 * scale + 4}px;background:${nt ? nt.color : '#888'}"></div>`;
        }).join('');

        const vpW = canvasWrap.clientWidth / session.view.zoom, vpH = canvasWrap.clientHeight / session.view.zoom;
        const vpX = (-session.view.pan.x / session.view.zoom - minX) * scale;
        const vpY = (-session.view.pan.y / session.view.zoom - minY) * scale;
        html += `<div class="wf-minimap-viewport" style="left:${vpX}px;top:${vpY}px;width:${vpW * scale}px;height:${vpH * scale}px;"></div>`;
        inner.innerHTML = html;
    }
    document.getElementById('wfMinimap')?.addEventListener('click', (e) => {
        if (!session || !(session.definition.nodes || []).length) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const nodes = session.definition.nodes;
        const xs = nodes.map(n => n.position.x), ys = nodes.map(n => n.position.y);
        const minX = Math.min(...xs) - 40, maxX = Math.max(...xs) + NODE_W + 40;
        const minY = Math.min(...ys) - 40, maxY = Math.max(...ys) + NODE_H_APPROX + 40;
        const spanX = Math.max(200, maxX - minX), spanY = Math.max(140, maxY - minY);
        const scale = Math.min(170 / spanX, 110 / spanY);
        const clickX = (e.clientX - rect.left) / scale + minX;
        const clickY = (e.clientY - rect.top) / scale + minY;
        session.view.pan.x = -(clickX * session.view.zoom) + canvasWrap.clientWidth / 2;
        session.view.pan.y = -(clickY * session.view.zoom) + canvasWrap.clientHeight / 2;
        applyTransform(); renderMinimap();
    });

    /* ---------------- Node events (drag / select) ---------------- */
    function bindNodeEvents(el) {
        el.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.wf-port')) return;
            e.stopPropagation();
            const id = el.dataset.id;
            if (!session.selection.nodeIds.has(id)) {
                if (!e.shiftKey) session.selection.nodeIds.clear();
                session.selection.nodeIds.add(id);
            } else if (e.shiftKey) {
                session.selection.nodeIds.delete(id);
            }
            session.selection.edgeId = null;
            document.querySelectorAll('.wf-node').forEach(nEl => nEl.classList.toggle('wf-node-selected', session.selection.nodeIds.has(nEl.dataset.id)));
            ui.renderInspector();
            if (session.readOnly) return;

            const startX = e.clientX, startY = e.clientY;
            const startPositions = {};
            session.selection.nodeIds.forEach(nid => {
                const n = session.definition.nodes.find(x => x.id === nid);
                if (n) startPositions[nid] = { x: n.position.x, y: n.position.y };
            });
            dragState = { mode: 'node', startX, startY, startPositions, moved: false };
            el.classList.add('wf-node-dragging');
            el.setPointerCapture?.(e.pointerId);
        });

        el.querySelectorAll('.wf-port-out').forEach(portEl => {
            portEl.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                if (session.readOnly) return;
                linkingFrom = { nodeId: el.dataset.id, port: portEl.dataset.port || 'default' };
                dragState = { mode: 'link', startX: e.clientX, startY: e.clientY };
            });
        });
        // إكمال الاتصال: بنقبله لو الإفلات حصل في أي مكان على مربع العقدة الهدف،
        // مش بس لو لمس نقطة الدخول (.wf-port-in) بالظبط — أسهل بكتير وأدق في
        // الاستخدام اليومي وعلى شاشات اللمس.
        el.addEventListener('pointerup', () => {
            if (!linkingFrom || linkingFrom.nodeId === el.dataset.id) return;
            const targetNt = appState.nodeTypesByKey[el.dataset.type];
            if (targetNt && targetNt.category === 'trigger') return; // المشغّلات لا تقبل اتصالًا داخلًا
            addEdge(linkingFrom.nodeId, el.dataset.id, linkingFrom.port);
        });
    }

    function screenDeltaToWorld(dx, dy) { return { x: dx / session.view.zoom, y: dy / session.view.zoom }; }

    /* ---------------- Viewport-level pointer handling (pan / marquee) ---------------- */
    let marqueeEl = null;
    let spaceHeld = false;
    document.addEventListener('keydown', (e) => { if (e.code === 'Space') spaceHeld = true; });
    document.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceHeld = false; });

    function onViewportPointerDown(e) {
        if (e.target.closest('.wf-node')) return;
        if (!session) return;
        session.selection.nodeIds.clear();
        session.selection.edgeId = null;
        document.querySelectorAll('.wf-node').forEach(nEl => nEl.classList.remove('wf-node-selected'));
        ui.renderInspector();

        if (e.button === 1 || spaceHeld || e.button === 2) {
            e.preventDefault();
            dragState = { mode: 'pan', startX: e.clientX, startY: e.clientY, startPan: { ...session.view.pan } };
            viewport.classList.add('wf-panning');
        } else {
            const rect = canvasWrap.getBoundingClientRect();
            dragState = { mode: 'marquee', startX: e.clientX, startY: e.clientY, rect, shift: e.shiftKey };
            marqueeEl = document.createElement('div');
            marqueeEl.className = 'wf-marquee';
            canvasWrap.appendChild(marqueeEl);
        }
    }

    function onPointerMove(e) {
        if (!dragState) {
            if (linkingFrom) renderTempLink(e);
            return;
        }
        if (dragState.mode === 'pan') {
            session.view.pan.x = dragState.startPan.x + (e.clientX - dragState.startX);
            session.view.pan.y = dragState.startPan.y + (e.clientY - dragState.startY);
            applyTransform(); renderMinimap();
        } else if (dragState.mode === 'node') {
            const wd = screenDeltaToWorld(e.clientX - dragState.startX, e.clientY - dragState.startY);
            if (Math.abs(wd.x) + Math.abs(wd.y) > 2) dragState.moved = true;
            Object.keys(dragState.startPositions).forEach(nid => {
                const n = session.definition.nodes.find(x => x.id === nid);
                if (!n) return;
                n.position.x = Math.round(dragState.startPositions[nid].x + wd.x);
                n.position.y = Math.round(dragState.startPositions[nid].y + wd.y);
                const el = nodesLayer.querySelector(`.wf-node[data-id="${nid}"]`);
                if (el) { el.style.left = n.position.x + 'px'; el.style.top = n.position.y + 'px'; }
            });
            updateEdgePaths(); renderMinimap();
        } else if (dragState.mode === 'marquee') {
            const x1 = Math.min(dragState.startX, e.clientX) - dragState.rect.left;
            const y1 = Math.min(dragState.startY, e.clientY) - dragState.rect.top;
            const w = Math.abs(e.clientX - dragState.startX), h = Math.abs(e.clientY - dragState.startY);
            Object.assign(marqueeEl.style, { left: x1 + 'px', top: y1 + 'px', width: w + 'px', height: h + 'px' });
        } else if (dragState.mode === 'link') {
            renderTempLink(e);
        }
    }

    function renderTempLink(e) {
        let tmp = document.getElementById('wfTempLink');
        if (!tmp) {
            tmp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            tmp.id = 'wfTempLink'; tmp.setAttribute('class', 'wf-edge-path'); tmp.style.strokeDasharray = '5,4';
            edgesGroup.appendChild(tmp);
        }
        const fromEl = nodesLayer.querySelector(`.wf-node[data-id="${linkingFrom.nodeId}"]`);
        if (!fromEl) return;
        const n = session.definition.nodes.find(x => x.id === linkingFrom.nodeId);
        const portFrac = n.type === 'condition.if_else' ? (linkingFrom.port === 'false' ? 0.70 : 0.36) : 0.5;
        const x1 = n.position.x + NODE_W, y1 = n.position.y + fromEl.offsetHeight * portFrac;
        const wrapRect = canvasWrap.getBoundingClientRect();
        const x2 = (e.clientX - wrapRect.left - session.view.pan.x) / session.view.zoom;
        const y2 = (e.clientY - wrapRect.top - session.view.pan.y) / session.view.zoom;
        tmp.setAttribute('d', `M ${x1},${y1} L ${x2},${y2}`);
    }

    function onPointerUp(e) {
        if (dragState?.mode === 'pan') viewport.classList.remove('wf-panning');
        if (dragState?.mode === 'node' && dragState.moved) pushHistory();
        if (dragState?.mode === 'marquee') {
            const x1 = Math.min(dragState.startX, e.clientX), x2 = Math.max(dragState.startX, e.clientX);
            const y1 = Math.min(dragState.startY, e.clientY), y2 = Math.max(dragState.startY, e.clientY);
            if (Math.abs(x2 - x1) > 4 || Math.abs(y2 - y1) > 4) {
                if (!dragState.shift) session.selection.nodeIds.clear();
                nodesLayer.querySelectorAll('.wf-node').forEach(el => {
                    const r = el.getBoundingClientRect();
                    if (r.left < x2 && r.right > x1 && r.top < y2 && r.bottom > y1) session.selection.nodeIds.add(el.dataset.id);
                });
                document.querySelectorAll('.wf-node').forEach(nEl => nEl.classList.toggle('wf-node-selected', session.selection.nodeIds.has(nEl.dataset.id)));
                ui.renderInspector();
            }
            marqueeEl?.remove(); marqueeEl = null;
        }
        if (dragState?.mode === 'link') {
            document.getElementById('wfTempLink')?.remove();
            linkingFrom = null;
        }
        nodesLayer.querySelectorAll('.wf-node-dragging').forEach(el => el.classList.remove('wf-node-dragging'));
        dragState = null;
    }

    function onWheel(e) {
        if (!session) return;
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
            const rect = canvasWrap.getBoundingClientRect();
            const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
            const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
            zoomAt(cx, cy, factor);
        } else {
            session.view.pan.x -= e.deltaX;
            session.view.pan.y -= e.deltaY;
            applyTransform(); renderMinimap();
        }
    }

    function zoomAt(cx, cy, factor) {
        const oldZoom = session.view.zoom;
        const newZoom = Math.min(2, Math.max(0.2, oldZoom * factor));
        session.view.pan.x = cx - ((cx - session.view.pan.x) / oldZoom) * newZoom;
        session.view.pan.y = cy - ((cy - session.view.pan.y) / oldZoom) * newZoom;
        session.view.zoom = newZoom;
        applyTransform(); renderMinimap();
    }
    function zoomBy(factor) {
        if (!session) return;
        zoomAt(canvasWrap.clientWidth / 2, canvasWrap.clientHeight / 2, factor);
    }
    function zoomToFit() {
        if (!session || !(session.definition.nodes || []).length) { session.view.pan = { x: 60, y: 60 }; session.view.zoom = 1; applyTransform(); return; }
        const nodes = session.definition.nodes;
        const xs = nodes.map(n => n.position.x), ys = nodes.map(n => n.position.y);
        const minX = Math.min(...xs), maxX = Math.max(...xs) + NODE_W;
        const minY = Math.min(...ys), maxY = Math.max(...ys) + NODE_H_APPROX;
        const spanX = Math.max(200, maxX - minX + 120), spanY = Math.max(150, maxY - minY + 120);
        const zoom = Math.min(1.3, Math.max(0.3, Math.min(canvasWrap.clientWidth / spanX, canvasWrap.clientHeight / spanY)));
        session.view.zoom = zoom;
        session.view.pan.x = -minX * zoom + 60;
        session.view.pan.y = -minY * zoom + 60;
        applyTransform(); renderMinimap();
    }

    /* ---------------- Drop from library ---------------- */
    function onDrop(e) {
        e.preventDefault();
        const key = e.dataTransfer.getData('text/wf-node-type');
        if (!key || !session || session.readOnly) return;
        const rect = canvasWrap.getBoundingClientRect();
        const x = (e.clientX - rect.left - session.view.pan.x) / session.view.zoom - NODE_W / 2;
        const y = (e.clientY - rect.top - session.view.pan.y) / session.view.zoom - 40;
        addNode(key, x, y);
    }

    function addNodeAtCenter(key) {
        if (!session || session.readOnly) return;
        const x = (canvasWrap.clientWidth / 2 - session.view.pan.x) / session.view.zoom - NODE_W / 2;
        const y = (canvasWrap.clientHeight / 2 - session.view.pan.y) / session.view.zoom - 40;
        addNode(key, x, y);
    }

    function addNode(typeKey, x, y) {
        const nt = appState.nodeTypesByKey[typeKey];
        if (!nt) return;
        const config = {};
        (nt.config_schema?.fields || []).forEach(f => { if (f.default !== undefined) config[f.key] = f.default; });
        const node = { id: uid('n'), type: typeKey, position: { x: Math.round(x), y: Math.round(y) }, config };
        session.definition.nodes.push(node);
        pushRecent(typeKey);
        session.selection.nodeIds = new Set([node.id]);
        session.selection.edgeId = null;
        pushHistory();
        render(); ui.renderInspector(); ui.updateSaveState(); ui.renderTabbar();
    }

    function addEdge(sourceId, targetId, sourcePort) {
        if (sourceId === targetId) return;
        sourcePort = sourcePort || 'default';
        const edges = session.definition.edges;
        if (edges.some(e => e.source === sourceId && e.target === targetId && (e.source_port || 'default') === sourcePort)) return;
        edges.push({ id: uid('e'), source: sourceId, target: targetId, source_port: sourcePort, type: 'sequential', condition: null });
        pushHistory();
        render(); ui.updateSaveState(); ui.renderTabbar();
    }

    /* ---------------- Delete / duplicate selection ---------------- */
    function deleteSelection() {
        if (!session || session.readOnly) return;
        let changed = false;
        if (session.selection.edgeId) {
            session.definition.edges = session.definition.edges.filter(e => e.id !== session.selection.edgeId);
            session.selection.edgeId = null; changed = true;
        }
        if (session.selection.nodeIds.size) {
            const ids = session.selection.nodeIds;
            session.definition.nodes = session.definition.nodes.filter(n => !ids.has(n.id));
            session.definition.edges = session.definition.edges.filter(e => !ids.has(e.source) && !ids.has(e.target));
            session.selection.nodeIds = new Set();
            changed = true;
        }
        if (changed) { pushHistory(); render(); ui.renderInspector(); ui.updateSaveState(); ui.renderTabbar(); }
    }

    function duplicateSelection() {
        if (!session || session.readOnly || !session.selection.nodeIds.size) return;
        const idMap = {};
        const newNodes = [];
        session.definition.nodes.forEach(n => {
            if (session.selection.nodeIds.has(n.id)) {
                const newId = uid('n');
                idMap[n.id] = newId;
                newNodes.push({ ...n, id: newId, position: { x: n.position.x + 30, y: n.position.y + 30 }, config: JSON.parse(JSON.stringify(n.config || {})) });
            }
        });
        session.definition.nodes.push(...newNodes);
        session.definition.edges.forEach(e => {
            if (idMap[e.source] && idMap[e.target]) {
                session.definition.edges.push({ ...e, id: uid('e'), source: idMap[e.source], target: idMap[e.target] });
            }
        });
        session.selection.nodeIds = new Set(Object.values(idMap));
        pushHistory(); render(); ui.renderInspector(); ui.updateSaveState(); ui.renderTabbar();
    }

    /* ---------------- Auto layout (layered BFS) ---------------- */
    function autoLayout() {
        if (!session || session.readOnly || !session.definition.nodes.length) return;
        const nodes = session.definition.nodes, edges = session.definition.edges;
        const outgoing = {}; nodes.forEach(n => outgoing[n.id] = []);
        edges.forEach(e => { if (outgoing[e.source]) outgoing[e.source].push(e.target); });
        const incomingCount = {}; nodes.forEach(n => incomingCount[n.id] = 0);
        edges.forEach(e => { if (incomingCount[e.target] !== undefined) incomingCount[e.target]++; });

        const layer = {};
        const roots = nodes.filter(n => incomingCount[n.id] === 0);
        (roots.length ? roots : nodes.slice(0, 1)).forEach(r => layer[r.id] = 0);
        let queue = roots.length ? roots.map(r => r.id) : [nodes[0].id];
        const visited = new Set(queue);
        while (queue.length) {
            const id = queue.shift();
            (outgoing[id] || []).forEach(t => {
                const nl = layer[id] + 1;
                if (layer[t] === undefined || nl > layer[t]) layer[t] = nl;
                if (!visited.has(t)) { visited.add(t); queue.push(t); }
            });
        }
        nodes.forEach(n => { if (layer[n.id] === undefined) layer[n.id] = 0; });

        const byLayer = {};
        nodes.forEach(n => { (byLayer[layer[n.id]] = byLayer[layer[n.id]] || []).push(n); });
        const COL_GAP = 300, ROW_GAP = 130;
        Object.keys(byLayer).sort((a, b) => a - b).forEach(l => {
            byLayer[l].forEach((n, i) => {
                n.position = { x: Number(l) * COL_GAP + 40, y: i * ROW_GAP + 40 };
            });
        });
        pushHistory(); render(); zoomToFit(); ui.updateSaveState(); ui.renderTabbar();
    }

    /* ---------------- Undo / redo ---------------- */
    function pushHistory() {
        const snap = JSON.stringify(session.definition);
        if (session.history[session.historyIndex] === snap) return;
        session.history = session.history.slice(0, session.historyIndex + 1);
        session.history.push(snap);
        session.historyIndex = session.history.length - 1;
        ui.updateSaveState(); ui.renderTabbar();
    }
    function undo() {
        if (!session || session.historyIndex <= 0) return;
        session.historyIndex--;
        session.definition = JSON.parse(session.history[session.historyIndex]);
        session.selection = { nodeIds: new Set(), edgeId: null };
        render(); ui.renderInspector(); ui.updateSaveState(); ui.renderTabbar();
    }
    function redo() {
        if (!session || session.historyIndex >= session.history.length - 1) return;
        session.historyIndex++;
        session.definition = JSON.parse(session.history[session.historyIndex]);
        session.selection = { nodeIds: new Set(), edgeId: null };
        render(); ui.renderInspector(); ui.updateSaveState(); ui.renderTabbar();
    }

    /* ---------------- Keyboard shortcuts ---------------- */
    function onKeyDown(e) {
        if (appState.view !== 'builder' || !session) return;
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;

        const meta = e.ctrlKey || e.metaKey;
        if ((e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); deleteSelection(); }
        else if (meta && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelection(); }
        else if (meta && e.key.toLowerCase() === 'a') { e.preventDefault(); session.selection.nodeIds = new Set(session.definition.nodes.map(n => n.id)); document.querySelectorAll('.wf-node').forEach(el => el.classList.add('wf-node-selected')); ui.renderInspector(); }
        else if (meta && e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); redo(); }
        else if (meta && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
        else if (meta && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
        else if (meta && e.key.toLowerCase() === 's') { e.preventDefault(); if (!session.readOnly) ui.saveDraft(false); }
        else if (e.key === 'Escape') { session.selection = { nodeIds: new Set(), edgeId: null }; document.querySelectorAll('.wf-node').forEach(el => el.classList.remove('wf-node-selected')); ui.renderInspector(); }
        else if (e.key.startsWith('Arrow') && session.selection.nodeIds.size && !session.readOnly) {
            e.preventDefault();
            const step = e.shiftKey ? 20 : 5;
            const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
            const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
            session.selection.nodeIds.forEach(id => {
                const n = session.definition.nodes.find(x => x.id === id);
                if (n) { n.position.x += dx; n.position.y += dy; }
            });
            updateEdgePaths(); renderMinimap();
        }
    }
    document.addEventListener('keyup', (e) => {
        if (e.key.startsWith('Arrow') && session && !session.readOnly) pushHistory();
    });

    return { init, mount, render, addNodeAtCenter, deleteSelection, duplicateSelection, pushHistory, updateEdgePaths, get session() { return session; } };
})();
