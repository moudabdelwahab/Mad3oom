/**
 * workspace.js — مساحة العمل: المتحكم
 * ---------------------------------------------------------------------------
 * يملك الحالة ويقرر. الترتيب في dock-model.js (خالص)، والرسم في
 * workspace-view.js، والإطارات في frame-host.js، والحفظ في workspace-store.js.
 *
 * الحالة:
 *   layout   الشجرة (الشيء الوحيد الذي يُحفظ — بنية وأنواع ومعرّفات)
 *   titles   عناوين حيّة: من الصفحة المضمّنة نفسها أو من التحقق من الوصول
 *   dirty    آخر ما أبلغت به كل صفحة عن كلام لم يُرسل (لنقطة التبويب)
 *   status   'unavailable' للسجل المحذوف أو الذي لم يعد مسموحًا
 *   mru      المجموعات بترتيب آخر استخدام (أين يُفتح السجل المرتبط)
 *   closed   آخر التبويبات المغلقة (إعادة الفتح)
 *
 * قواعد سلامة البيانات (docs/WORKSPACE_DOCKABLE_ARCHITECTURE.md §5):
 *   • مساحة العمل لا تكتب أي سجل؛ كل إرسال وتحديث يحدث داخل الصفحة نفسها.
 *   • لا إغلاق ولا إعادة ضبط ولا إعادة تحميل فوق كلام لم يُرسل بلا تأكيد —
 *     والسؤال يذهب للصفحة مباشرةً لحظة الإغلاق، لا لآخر رسالة وصلت.
 *   • نقل التبويبات لا يعيد تحميل أي إطار (frame-host.js).
 */
import { supabase } from '/api-config.js';
import { checkAdminAuth, updateAdminUI } from '../auth.js';
import { initSidebar } from '../sidebar.js';
import * as dock from './dock-model.js';
import { validatePanel, panelUrl, isPanelAllowed, panelEntity, panelTypes, panelType } from './panel-registry.js';
import { FrameHost } from './frame-host.js';
import { createView, toLogical } from './workspace-view.js';
import { createStore } from './workspace-store.js';
import { resolvePanels, searchRecords } from './workspace-data.js';
import { createQuickOpen } from './quick-open.js';
import { t, icon, defaultTitle } from './workspace-strings.js';

const $ = (id) => document.getElementById(id);
const NS = 'mad3oom-ws';
const STAFF_ROLES = ['admin', 'support', 'platform_owner'];
const COMPACT_QUERY = '(max-width: 900px)';
const MAX_CLOSED = 15;

const state = {
    user: null,
    role: null,
    layout: dock.createLayout(),
    titles: new Map(),
    /** العناوين التي أرسلتها الصفحة نفسها — لا يطغى عليها عنوان التحقق الأقدم. */
    liveTitles: new Set(),
    dirty: new Map(),
    status: new Map(),
    mru: [],
    closed: [],
    compact: false,
    /** سحب تبويب أو فاصل جارٍ: الرسم يؤجَّل (إعادة الرسم تقطع السحب). */
    busy: false,
    renderPending: false
};

let view = null;
let host = null;
let store = null;
let quick = null;

/* ====================  أدوات  ==================== */

function toast(message, kind = 'ok') {
    const el = $('wsToast');
    el.textContent = message;
    el.className = `ws-toast${kind === 'err' ? ' ws-toast--err' : ''}`;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 4200);
}

function titleOf(panelId) {
    const panel = state.layout.panels[panelId];
    return state.titles.get(panelId) || defaultTitle(panel?.type);
}

/** المسودة: سؤال مباشر للصفحة، ثم آخر ما أبلغت به. اللوحة التي لم تُحمَّل لا مسودة فيها. */
function isDirty(panelId) {
    const asked = host?.askDirty(panelId);
    return asked ?? !!state.dirty.get(panelId);
}

function confirmDialog({ title, lines = [], note = '', confirmLabel }) {
    const dialog = $('wsConfirm');
    dialog.querySelector('h2').textContent = title;
    const list = dialog.querySelector('.ws-confirm-list');
    list.replaceChildren(...lines.map((line) => { const li = document.createElement('li'); li.textContent = line; return li; }));
    list.hidden = !lines.length;
    dialog.querySelector('.ws-confirm-body').textContent = lines.length ? t('confirmCloseBody') : '';
    dialog.querySelector('.ws-confirm-note').textContent = note;
    dialog.querySelector('[data-confirm]').textContent = confirmLabel;
    dialog.querySelector('[data-cancel]').textContent = t('cancel');
    return new Promise((resolve) => {
        const done = (ok) => () => { dialog.close(); resolve(ok); };
        dialog.querySelector('[data-confirm]').onclick = done(true);
        dialog.querySelector('[data-cancel]').onclick = done(false);
        dialog.oncancel = (e) => { e.preventDefault(); done(false)(); };
        dialog.showModal();
        dialog.querySelector('[data-cancel]').focus();
    });
}

/** تأكيد قبل أي فعل يُسقط لوحات فيها كلام لم يُرسل. */
async function allowDiscard(panelIds, title = t('confirmCloseTitle')) {
    const dirty = panelIds.filter(isDirty);
    if (!dirty.length) return true;
    return confirmDialog({ title, lines: dirty.map(titleOf), note: t('confirmCloseNote'), confirmLabel: t('confirmDiscard') });
}

/* ====================  الرسم والحفظ  ==================== */

function model() {
    return { layout: state.layout, titles: state.titles, dirty: state.dirty, status: state.status, compact: state.compact };
}

function render() {
    if (state.busy) { state.renderPending = true; return; }
    state.renderPending = false;
    view.render(model());
    syncFrames();
}

function syncFrames() {
    const visible = new Map();
    if (state.compact) {
        const group = dock.findGroup(state.layout, state.layout.activeGroup);
        if (group) visible.set(group.active, view.bodyFor('compact'));
    } else {
        for (const group of dock.groupsOf(state.layout)) visible.set(group.active, view.bodyFor(group.id));
    }
    const entries = Object.values(state.layout.panels)
        .filter((p) => state.status.get(p.id) !== 'unavailable')
        .map((p) => ({ panelId: p.id, url: panelUrl(p), title: titleOf(p.id), body: visible.get(p.id) || null }));
    host.sync(entries);
}

function trackMru() {
    const groups = new Set(dock.groupsOf(state.layout).map((g) => g.id));
    const active = state.layout.activeGroup;
    state.mru = [active, ...state.mru.filter((id) => id !== active)].filter((id) => id && groups.has(id));
}

function persist() {
    store.save(dock.serializeLayout(state.layout));
}

/** يثبّت ترتيبًا جديدًا. نفس المرجع = لم يتغير شيء. */
function commit(next, { save = true } = {}) {
    if (next === state.layout) return false;
    // الحالة الحيّة (عنوان، مسودة، إتاحة) تخص لوحة بعينها: لو اختفى المعرّف أو
    // صار يشير لسجل آخر تسقط معه.
    const same = (id) => next.panels[id] && next.panels[id].key === state.layout.panels[id]?.key;
    for (const map of [state.titles, state.dirty, state.status]) {
        for (const id of [...map.keys()]) if (!same(id)) map.delete(id);
    }
    for (const id of [...state.liveTitles]) if (!same(id)) state.liveTitles.delete(id);
    state.layout = next;
    trackMru();
    render();
    if (save) persist();
    return true;
}

function showSaveStatus(status) {
    const el = $('wsSaveStatus');
    if (status === 'conflict') { toast(t('conflict')); return; }
    const text = { saved: t('saved'), local: t('savedLocal'), error: t('saveError') }[status];
    if (!text) return;
    el.textContent = text;
    el.dataset.state = status;
}

/* ====================  الفتح والتحقق  ==================== */

/**
 * يفتح لوحة أو ينشّط الموجودة.
 * @param {{type, params?, title?}} spec
 * @param {{group?, edge?, from?: string, side?: boolean, focus?: boolean}} options
 *        from: معرّف اللوحة التي طلبت الفتح (رابط داخلها) ⇒ لا نغطيها.
 */
function openSpec(spec, { group = null, edge = null, from = null, side = false, focus = false } = {}) {
    const valid = validatePanel(spec?.type, spec?.params || {});
    if (!valid || !isPanelAllowed(spec.type, state.role)) { toast(t('notAllowed'), 'err'); return null; }

    let target = { group, edge };
    if (from) target = dock.targetForOpenFrom(state.layout, from, state.mru);
    if (side) target = { group: (from && dock.groupOfPanel(state.layout, from)?.id) || state.layout.activeGroup, edge: 'end' };

    const result = dock.openPanel(state.layout, { type: spec.type, params: valid.params, key: valid.key }, target);
    if (result.refused) { toast(t('maxPanels'), 'err'); return null; }
    if (!result.existed && spec.title) state.titles.set(result.panelId, String(spec.title).slice(0, 120));
    if (!commit(result.layout)) render();
    if (!result.existed && panelEntity(spec.type)) revalidate([result.panelId]);
    if (focus) view.focusTab(result.panelId);
    return result.panelId;
}

/**
 * هل ما زال الموظف يرى هذه السجلات؟ (RLS — نفس صلاحياته في الصفحة نفسها)
 * غير المرئي ⇒ تبويب «غير متاح» بلا إطار. خطأ الشبكة لا يُعدّ رفضًا.
 */
async function revalidate(panelIds) {
    const panels = panelIds.map((id) => state.layout.panels[id]).filter((p) => p && panelEntity(p.type));
    if (!panels.length) return;
    const result = await resolvePanels(panels);
    let changed = false;
    for (const [id, answer] of result) {
        if (!state.layout.panels[id]) continue;
        if (!answer.ok) {
            if (state.status.get(id) !== 'unavailable') { state.status.set(id, 'unavailable'); changed = true; }
            continue;
        }
        if (state.status.get(id) === 'unavailable') { state.status.delete(id); changed = true; }
        if (answer.title && !state.liveTitles.has(id)) { state.titles.set(id, answer.title); changed = true; }
    }
    if (changed) render();
}

/* ====================  الإغلاق  ==================== */

async function requestClose(panelIds, { thenFocus = null } = {}) {
    const ids = panelIds.filter((id) => state.layout.panels[id]);
    if (!ids.length) return false;
    if (!(await allowDiscard(ids))) return false;
    for (const id of ids) {
        const { type, params } = state.layout.panels[id];
        state.closed.push({ type, params });
        state.liveTitles.delete(id);
    }
    state.closed = state.closed.slice(-MAX_CLOSED);
    commit(dock.closePanels(state.layout, ids));
    if (thenFocus && state.layout.panels[thenFocus]) view.focusTab(thenFocus);
    return true;
}

function reopenClosed() {
    while (state.closed.length) {
        const spec = state.closed.pop();
        if (validatePanel(spec.type, spec.params) && isPanelAllowed(spec.type, state.role)) {
            openSpec(spec, { focus: true });
            return;
        }
    }
}

async function reloadPanel(panelId) {
    if (!(await allowDiscard([panelId], t('reloadPanel')))) return;
    state.dirty.delete(panelId);
    host.reload(panelId);
    render();
}

/* ====================  الترتيبات الجاهزة  ==================== */

function starterLayout(name) {
    // التسلسل يكمل من الترتيب الحالي: معرّف قديم لا يُعاد استخدامه للوحة أخرى.
    let layout = { ...dock.createLayout(), seq: state.layout.seq };
    const add = (type, options = {}) => {
        if (!isPanelAllowed(type, state.role)) return null;
        const valid = validatePanel(type, {});
        const result = dock.openPanel(layout, { type, params: valid.params, key: valid.key }, options);
        layout = result.layout;
        return result.panelId;
    };
    add('inbox');
    if (name === 'desk' || name === 'full') {
        const tickets = add('tickets', { edge: 'end' });
        if (name === 'full' && tickets) add('customers', { group: dock.groupOfPanel(layout, tickets).id, edge: 'bottom' });
    }
    const first = dock.groupsOf(layout)[0];
    return first ? dock.activatePanel(layout, first.active) : layout;
}

async function applyStarter(name, { confirmTitle = t('confirmResetTitle') } = {}) {
    if (!(await allowDiscard(Object.keys(state.layout.panels), confirmTitle))) return;
    commit(starterLayout(name));
}

/* ====================  القوائم  ==================== */

function tabMenu(panelId, where) {
    const group = dock.groupOfPanel(state.layout, panelId);
    if (!group) return;
    const single = group.tabs.length === 1;
    const others = dock.groupsOf(state.layout).filter((g) => g.id !== group.id);
    const toEnd = dock.panelsToClose(state.layout, panelId, 'toEnd');

    const items = [
        { label: t('focusPanel'), run: () => { handlers.activate(panelId); host.focus(panelId); } },
        { label: t('close'), icon: 'close', run: () => requestClose([panelId]) },
        { label: t('closeOthers'), disabled: single, run: () => requestClose(dock.panelsToClose(state.layout, panelId, 'others')) },
        { label: t('closeToEnd'), disabled: !toEnd.length, run: () => requestClose(toEnd) }
    ];
    if (!state.compact) {
        items.push({ separator: true });
        for (const edge of ['right', 'left', 'top', 'bottom']) {
            items.push({ label: t(`move_${edge}`), icon: 'split', disabled: single, run: () => handlers.dock(panelId, group.id, toLogical(edge)) });
        }
        for (const other of others) {
            items.push({ label: t('moveToGroup', { title: titleOf(other.active) }), run: () => handlers.move(panelId, other.id) });
        }
    }
    items.push({ separator: true });
    items.push({ label: t('reloadPanel'), icon: 'reload', disabled: !host.has(panelId), run: () => reloadPanel(panelId) });
    items.push({ label: t('reopenClosed'), icon: 'undo', disabled: !state.closed.length, run: reopenClosed });
    view.openMenu(items, where);
}

function layoutMenu(anchor) {
    view.openMenu([
        { label: t('starter_inbox'), icon: 'layout', run: () => applyStarter('inbox') },
        { label: t('starter_desk'), icon: 'layout', run: () => applyStarter('desk') },
        { label: t('starter_full'), icon: 'layout', run: () => applyStarter('full') },
        { separator: true },
        { label: t('reopenClosed'), icon: 'undo', disabled: !state.closed.length, run: reopenClosed },
        { label: t('resetLayout'), icon: 'reset', run: () => applyStarter('desk') }
    ], { anchor, returnTo: anchor });
}

/* ====================  أوامر العرض  ==================== */

const handlers = {
    activate(panelId) {
        const group = dock.groupOfPanel(state.layout, panelId);
        if (group?.active === panelId && state.layout.activeGroup === group.id) return;
        commit(dock.activatePanel(state.layout, panelId));
    },
    close(panelId, { thenFocus } = {}) {
        requestClose([panelId], { thenFocus });
    },
    move(panelId, groupId, index = null) {
        commit(dock.movePanel(state.layout, panelId, groupId, index));
    },
    dock(panelId, groupId, edge) {
        const next = dock.dockPanel(state.layout, panelId, groupId, edge);
        if (next !== state.layout) { commit(next); return; }
        const source = dock.groupOfPanel(state.layout, panelId);
        const trivial = source?.id === groupId && source.tabs.length === 1;
        if (!trivial && edge !== 'center') toast(t('cannotDock'), 'err');
    },
    splitGroup(groupId) {
        const group = dock.findGroup(state.layout, groupId);
        if (group) handlers.dock(group.active, groupId, 'end');
    },
    resize(splitId, index, delta, minFraction) {
        if (!commit(dock.resizeSplit(state.layout, splitId, index, delta, minFraction))) render();
    },
    preview() {
        host.schedule();
    },
    menu(panelId, where) {
        tabMenu(panelId, where);
    },
    focusPanel(panelId) {
        if (!host.focus(panelId)) view.bodyFor(dock.groupOfPanel(state.layout, panelId)?.id)?.focus();
    },
    dragState(active) {
        state.busy = active;
        host.setPassive(active);
        if (!active && state.renderPending) render();
    },
    groupFocus(groupId) {
        if (groupId !== state.layout.activeGroup) commit(dock.activateGroup(state.layout, groupId));
    },
    emptyAction(action) {
        if (action === 'quick') quick.open();
        else if (action.startsWith('starter:')) applyStarter(action.slice(8));
        else if (action.startsWith('open:')) openSpec({ type: action.slice(5), params: {} }, { focus: true });
    },
    retry(panelId) {
        state.status.delete(panelId);
        render();
        revalidate([panelId]);
    }
};

/* ====================  رسائل الصفحات المضمّنة  ==================== */

function onFrameMessage(event) {
    if (event.origin !== window.location.origin) return;
    const msg = event.data;
    if (!msg || msg.ns !== NS || msg.v !== 1) return;
    // الهوية من الإطار المرسل نفسه، لا من محتوى الرسالة.
    const panelId = host.panelForSource(event.source);
    if (!panelId || !state.layout.panels[panelId]) return;

    switch (msg.type) {
        case 'ready':
            host.post(panelId, { ns: NS, v: 1, type: 'theme', theme: document.documentElement.getAttribute('data-theme') || 'light' });
            break;
        case 'title':
            if (typeof msg.title === 'string' && msg.title.trim()) {
                state.titles.set(panelId, msg.title.trim().slice(0, 120));
                state.liveTitles.add(panelId);
                render();
            }
            break;
        case 'dirty':
            if (!!msg.dirty !== !!state.dirty.get(panelId)) { state.dirty.set(panelId, !!msg.dirty); render(); }
            break;
        case 'open':
            if (msg.panel && typeof msg.panel === 'object') openSpec({ type: msg.panel.type, params: msg.panel.params || {} }, { from: panelId, side: !!msg.side });
            break;
        case 'changed':
            host.broadcast({
                ns: NS, v: 1, type: 'refresh',
                entity: typeof msg.entity === 'string' ? msg.entity : null,
                id: typeof msg.id === 'string' ? msg.id : null,
                customerId: typeof msg.customerId === 'string' ? msg.customerId : null
            }, { except: panelId });
            break;
        case 'unavailable':
            state.status.set(panelId, 'unavailable');
            state.dirty.delete(panelId);
            render();
            break;
        case 'shortcut':
            if (msg.name === 'quickOpen') quick.open();
            break;
        default:
            break;
    }
}

/* ====================  البحث السريع  ==================== */

function quickStaticItems() {
    const items = [];
    for (const type of panelTypes()) {
        const def = panelType(type);
        if (!def.singleton || !isPanelAllowed(type, state.role)) continue;
        items.push({ id: `open:${type}`, group: 'panel', type, title: defaultTitle(type), panel: { type, params: {} } });
    }
    for (const name of ['inbox', 'desk', 'full']) {
        items.push({ id: `starter:${name}`, group: 'layout', icon: 'layout', title: t(`starter_${name}`), run: () => applyStarter(name) });
    }
    if (state.closed.length) items.push({ id: 'reopen', group: 'command', icon: 'undo', title: t('reopenClosed'), run: reopenClosed });
    items.push({ id: 'reset', group: 'command', icon: 'reset', title: t('resetLayout'), run: () => applyStarter('desk') });
    return items;
}

/* ====================  الإقلاع  ==================== */

function wire() {
    $('wsQuickBtn').addEventListener('click', () => quick.open());
    $('wsNewBtn').addEventListener('click', () => quick.open());
    $('wsLayoutBtn').addEventListener('click', (e) => layoutMenu(e.currentTarget));

    document.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.code === 'KeyK') {
            event.preventDefault();
            quick.open();
        }
    });
    window.addEventListener('message', onFrameMessage);

    // سمة الألوان تتبع مساحة العمل في كل اللوحات.
    new MutationObserver(() => {
        host.broadcast({ ns: NS, v: 1, type: 'theme', theme: document.documentElement.getAttribute('data-theme') || 'light' });
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    window.languageManager?.onLanguageChange?.(() => { applyChromeStrings(); render(); });

    const compact = window.matchMedia(COMPACT_QUERY);
    state.compact = compact.matches;
    compact.addEventListener('change', (e) => { state.compact = e.matches; view.closeMenu({ restoreFocus: false }); render(); });

    window.addEventListener('beforeunload', (event) => {
        if (Object.keys(state.layout.panels).some(isDirty)) {
            event.preventDefault();
            event.returnValue = '';
        }
    });
    window.addEventListener('pagehide', () => store.flush());
}

/** نصوص الشريط الثابتة في الـ HTML بالعربية؛ نعيد كتابتها بلغة الواجهة الحالية. */
function applyChromeStrings() {
    document.title = `${t('workspaceTitle')} - ${document.documentElement.lang === 'en' ? 'Admin' : 'لوحة الإدارة'}`;
    document.querySelector('.ws-heading').textContent = t('workspaceTitle');
    document.querySelector('#wsQuickBtn span').textContent = t('quickOpenButton');
    for (const [id, key] of [['wsNewBtn', 'newTab'], ['wsLayoutBtn', 'layoutMenu']]) {
        $(id).title = t(key);
        $(id).setAttribute('aria-label', t(key));
    }
}

function denyNonStaff() {
    $('wsRoot').innerHTML = '';
    const box = document.createElement('div');
    box.className = 'ws-empty';
    const p = document.createElement('p');
    p.textContent = t('staffOnly');
    box.appendChild(p);
    $('wsRoot').appendChild(box);
}

async function boot() {
    initSidebar();
    const user = await checkAdminAuth();
    if (!user) return;
    updateAdminUI(user);
    state.user = user;
    state.role = user.profile?.role || null;

    // عرض فقط: RLS وحارس كل صفحة مضمّنة هما الفرض الحقيقي.
    if (!STAFF_ROLES.includes(state.role)) { denyNonStaff(); return; }

    host = new FrameHost($('wsFrames'), { isDirty: (id) => !!state.dirty.get(id) || host.askDirty(id) === true });
    view = createView({ root: $('wsRoot'), tree: $('wsTree'), drop: $('wsDrop'), handlers });
    store = createStore({ userId: user.id, client: supabase, onStatus: showSaveStatus });
    quick = createQuickOpen({
        strings: t,
        icon: (name) => icon(panelType(name)?.icon || name),
        staticItems: quickStaticItems,
        search: (q) => searchRecords(q).then((rows) => rows.filter((r) => isPanelAllowed(r.type, state.role))),
        onPick: (item, { side }) => {
            if (item.run) item.run();
            else openSpec({ type: item.panel?.type || item.type, params: item.panel?.params || item.params, title: item.panel ? null : item.title }, { side, focus: true });
        }
    });
    wire();
    applyChromeStrings();

    const { raw } = await store.load();
    const restored = raw
        ? dock.parseLayout(raw, { validatePanel: (type, params) => (isPanelAllowed(type, state.role) ? validatePanel(type, params) : null) })
        : null;
    if (raw && !restored) toast(t('restoreFailed'), 'err');
    else if (restored && raw?.panels && typeof raw.panels === 'object'
        && Object.keys(restored.panels).length < Object.keys(raw.panels).length) toast(t('restoreDropped'));

    state.layout = restored || starterLayout('desk');
    trackMru();
    render();
    if (!restored) persist();
    revalidate(Object.keys(state.layout.panels));
    document.documentElement.dataset.workspaceReady = 'true';
}

boot();
