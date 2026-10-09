/**
 * dock-model.js — محرك ترتيب مساحة العمل (دوال خالصة، بلا DOM)
 * ---------------------------------------------------------------------------
 * الترتيب شجرة: العقدة إمّا «مجموعة» تبويبات أو «تقسيم» أفقي/رأسي لعقد أصغر.
 *
 *   Layout = { version, root, panels: {id: {id, type, params, key}}, activeGroup, seq }
 *   group  = { kind: 'group', id, tabs: [panelId…], active: panelId }
 *   split  = { kind: 'split', id, dir: 'row' | 'column', children: [node…], sizes: [كسر…] }
 *
 * الحواف منطقية لا فيزيائية: start | end | top | bottom | center. ترتيب أبناء
 * التقسيم الأفقي منطقي (من البداية للنهاية)، وflexbox يعكسه وحده في RTL —
 * فالإرساء صحيح في الاتجاهين دون أي فرع خاص هنا. ترجمة «يمين/يسار» الشاشة إلى
 * start/end مسؤولية العارض لأنه وحده يعرف اتجاه الصفحة.
 *
 * كل عملية تأخذ ترتيبًا وترجع ترتيبًا جديدًا (لا تعدّل المُدخل)، ثم تمرّ على
 * normalize() التي تحذف المجموعات الفارغة وترفع التقسيمات ذات الابن الواحد
 * وتسوّي الأحجام — فلا تحتاج أي عملية أن «تتذكر» التنظيف.
 *
 * `key` مفتاح منع التكرار (محادثة واحدة = تبويب واحد). لا يُحفظ: يحسبه سجل
 * اللوحات من النوع والمعاملات عند الفتح وعند الاستعادة.
 */

export const LAYOUT_VERSION = 1;

export const LIMITS = Object.freeze({
    maxPanels: 40,
    maxGroups: 12,
    maxDepth: 6,
    /** أصغر نصيب لجزء من تقسيم. العارض يمرّر حدًّا محسوبًا من البكسلات حين يعرفه. */
    minFraction: 0.12
});

export const EDGES = Object.freeze(['start', 'end', 'top', 'bottom', 'center']);

const ID_RE = { group: /^g\d{1,6}$/, split: /^s\d{1,6}$/, panel: /^p\d{1,6}$/ };

const clone = (value) => JSON.parse(JSON.stringify(value));
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
    && Object.getPrototypeOf(v) === Object.prototype;

export function createLayout() {
    return { version: LAYOUT_VERSION, root: null, panels: {}, activeGroup: null, seq: 0 };
}

function nextId(layout, prefix) {
    layout.seq += 1;
    return `${prefix}${layout.seq}`;
}

function newGroup(layout, tabs) {
    return { kind: 'group', id: nextId(layout, 'g'), tabs: [...tabs], active: tabs[0] ?? null };
}

/* ====================  القراءة  ==================== */

/** المجموعات بترتيب ظهورها (عمق أولًا، من البداية للنهاية ومن أعلى لأسفل). */
export function groupsOf(layout) {
    const out = [];
    const visit = (node) => {
        if (!node) return;
        if (node.kind === 'group') out.push(node);
        else node.children.forEach(visit);
    };
    visit(layout.root);
    return out;
}

export function findGroup(layout, groupId) {
    return groupsOf(layout).find((g) => g.id === groupId) || null;
}

export function groupOfPanel(layout, panelId) {
    return groupsOf(layout).find((g) => g.tabs.includes(panelId)) || null;
}

export function findNode(layout, id) {
    let found = null;
    const visit = (node) => {
        if (!node || found) return;
        if (node.id === id) { found = node; return; }
        if (node.kind === 'split') node.children.forEach(visit);
    };
    visit(layout.root);
    return found;
}

/** أب العقدة وموضعها فيه، أو null لو هي الجذر أو غير موجودة. */
function findParent(root, id) {
    let found = null;
    const visit = (node) => {
        if (!node || found || node.kind !== 'split') return;
        const index = node.children.findIndex((c) => c.id === id);
        if (index >= 0) { found = { parent: node, index }; return; }
        node.children.forEach(visit);
    };
    visit(root);
    return found;
}

function depthOf(root, id) {
    let depth = -1;
    const visit = (node, d) => {
        if (!node || depth >= 0) return;
        if (node.id === id) { depth = d; return; }
        if (node.kind === 'split') node.children.forEach((c) => visit(c, d + 1));
    };
    visit(root, 0);
    return depth;
}

/** معرّفات اللوحات بترتيب ظهورها — لشريط الوضع المضغوط وللتنقل بالكيبورد. */
export function panelOrder(layout) {
    return groupsOf(layout).flatMap((g) => g.tabs);
}

export function panelCount(layout) {
    return Object.keys(layout.panels).length;
}

export function findPanelByKey(layout, key) {
    if (!key) return null;
    return Object.values(layout.panels).find((p) => p.key === key) || null;
}

/** التبويبات التي يغلقها «أغلق الأخرى» أو «أغلق حتى النهاية» — للتحقق من المسودات قبل التنفيذ. */
export function panelsToClose(layout, panelId, mode) {
    const group = groupOfPanel(layout, panelId);
    if (!group) return [];
    const at = group.tabs.indexOf(panelId);
    if (mode === 'others') return group.tabs.filter((id) => id !== panelId);
    if (mode === 'toEnd') return group.tabs.slice(at + 1);
    return [panelId];
}

/**
 * أين يُفتح سجل طلبته لوحة أخرى (رابط عميل داخل محادثة مثلًا)؟
 * القاعدة: لا نغطي المصدر. لو هناك مجموعة أخرى نفتح في آخرها استخدامًا،
 * وإلا نرسي مجموعة جديدة بجانب المصدر — فيظهر الاثنان معًا.
 */
export function targetForOpenFrom(layout, sourcePanelId, mruGroups = []) {
    const source = groupOfPanel(layout, sourcePanelId);
    if (!source) return { group: layout.activeGroup, edge: null };
    const others = groupsOf(layout).filter((g) => g.id !== source.id);
    if (!others.length) return { group: source.id, edge: 'end' };
    const recent = mruGroups.find((id) => others.some((g) => g.id === id));
    return { group: recent || others[0].id, edge: null };
}

/* ====================  التطبيع  ==================== */

function normalizeSizes(sizes, count) {
    const clean = Array.from({ length: count }, (_, i) => {
        const v = Number(sizes?.[i]);
        return Number.isFinite(v) && v > 0 ? v : null;
    });
    const known = clean.filter((v) => v !== null);
    const fallback = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
    const filled = clean.map((v) => (v === null ? fallback : v));
    const total = filled.reduce((a, b) => a + b, 0);
    return filled.map((v) => v / total);
}

/**
 * يصلح الشجرة بعد أي عملية. يعدّل الكائن الممرَّر ويرجعه — ولذلك لا يُستدعى
 * إلا على نسخة.
 */
export function normalize(layout) {
    const seen = new Set();

    const visit = (node) => {
        if (!node) return null;
        if (node.kind === 'group') {
            node.tabs = node.tabs.filter((id) => layout.panels[id] && !seen.has(id) && seen.add(id));
            if (!node.tabs.length) return null;
            if (!node.tabs.includes(node.active)) node.active = node.tabs[0];
            return node;
        }
        const kept = [];
        const sizes = normalizeSizes(node.sizes, node.children.length);
        node.children.forEach((child, i) => {
            const fixed = visit(child);
            if (!fixed) return;
            // تقسيم داخل تقسيم بنفس الاتجاه = تقسيم واحد. نصيب الابن يتوزع على أحفاده.
            if (fixed.kind === 'split' && fixed.dir === node.dir) {
                fixed.children.forEach((grand, j) => kept.push([grand, sizes[i] * fixed.sizes[j]]));
            } else {
                kept.push([fixed, sizes[i]]);
            }
        });
        if (!kept.length) return null;
        if (kept.length === 1) return kept[0][0];
        node.children = kept.map(([c]) => c);
        node.sizes = normalizeSizes(kept.map(([, s]) => s), kept.length);
        return node;
    };

    layout.root = visit(layout.root);
    for (const id of Object.keys(layout.panels)) {
        if (!seen.has(id)) delete layout.panels[id];
    }
    const groups = groupsOf(layout);
    if (!groups.some((g) => g.id === layout.activeGroup)) layout.activeGroup = groups[0]?.id ?? null;
    return layout;
}

/* ====================  العمليات  ==================== */

function activateMut(layout, panelId) {
    const group = groupOfPanel(layout, panelId);
    if (!group) return layout;
    group.active = panelId;
    layout.activeGroup = group.id;
    return layout;
}

export function activatePanel(layout, panelId) {
    return normalize(activateMut(clone(layout), panelId));
}

export function activateGroup(layout, groupId) {
    if (!findGroup(layout, groupId)) return layout;
    const next = clone(layout);
    next.activeGroup = groupId;
    return next;
}

/** يدرج عقدة جديدة بجانب الهدف. يعيد استخدام التقسيم الأب لو كان بنفس الاتجاه. */
function insertBeside(layout, targetId, node, edge) {
    const dir = edge === 'start' || edge === 'end' ? 'row' : 'column';
    const before = edge === 'start' || edge === 'top';
    const loc = findParent(layout.root, targetId);
    if (loc && loc.parent.dir === dir) {
        const { parent, index } = loc;
        const share = parent.sizes[index] / 2;
        parent.sizes[index] = share;
        const at = before ? index : index + 1;
        parent.children.splice(at, 0, node);
        parent.sizes.splice(at, 0, share);
        return;
    }
    const target = loc ? loc.parent.children[loc.index] : layout.root;
    const split = {
        kind: 'split', id: nextId(layout, 's'), dir,
        children: before ? [node, target] : [target, node],
        sizes: [0.5, 0.5]
    };
    if (loc) loc.parent.children[loc.index] = split;
    else layout.root = split;
}

/** هل يمكن إنشاء مجموعة جديدة بجانب الهدف دون تجاوز الحدود؟ */
function canSplitBeside(layout, targetId, edge) {
    if (groupsOf(layout).length >= LIMITS.maxGroups) return false;
    const dir = edge === 'start' || edge === 'end' ? 'row' : 'column';
    const loc = findParent(layout.root, targetId);
    if (loc && loc.parent.dir === dir) return true;
    return depthOf(layout.root, targetId) + 1 <= LIMITS.maxDepth;
}

/** يزيل التبويب من مجموعته، ويختار التبويب النشط التالي لو كان هو النشط. */
function detachMut(layout, panelId) {
    const group = groupOfPanel(layout, panelId);
    if (!group) return null;
    const at = group.tabs.indexOf(panelId);
    group.tabs.splice(at, 1);
    if (group.active === panelId) group.active = group.tabs[at] ?? group.tabs[at - 1] ?? null;
    return group;
}

/**
 * يفتح لوحة، أو ينشّط الموجودة لو مفتاحها مفتوح بالفعل (سياسة منع التكرار).
 *
 * @param {{type: string, params?: object, key?: string|null}} spec
 * @param {{group?: string, edge?: string|null, index?: number|null, activate?: boolean}} options
 *        edge ≠ center ⇒ مجموعة جديدة بجانب `group` (أو النشطة).
 * @returns {{layout, panelId: string|null, existed: boolean, refused?: string}}
 */
export function openPanel(layout, { type, params = {}, key = null }, { group = null, edge = null, index = null, activate = true } = {}) {
    const existing = findPanelByKey(layout, key);
    if (existing) {
        return { layout: activate ? activatePanel(layout, existing.id) : layout, panelId: existing.id, existed: true };
    }
    if (panelCount(layout) >= LIMITS.maxPanels) return { layout, panelId: null, existed: false, refused: 'max-panels' };

    const next = clone(layout);
    const id = nextId(next, 'p');
    next.panels[id] = { id, type, params: { ...params }, key };

    const target = findGroup(next, group) || findGroup(next, next.activeGroup) || groupsOf(next)[0] || null;
    if (!target) {
        next.root = newGroup(next, [id]);
        next.activeGroup = next.root.id;
    } else if (edge && edge !== 'center' && canSplitBeside(next, target.id, edge)) {
        const fresh = newGroup(next, [id]);
        insertBeside(next, target.id, fresh, edge);
    } else {
        // الجديد بعد التبويب النشط مباشرةً، كالمتصفح — لا في آخر الشريط.
        const after = target.tabs.indexOf(target.active);
        const at = Number.isInteger(index) ? Math.max(0, Math.min(index, target.tabs.length)) : after + 1;
        target.tabs.splice(at, 0, id);
    }
    if (activate || !target) activateMut(next, id);
    return { layout: normalize(next), panelId: id, existed: false };
}

export function closePanel(layout, panelId) {
    return closePanels(layout, [panelId]);
}

/**
 * يغلق لوحات. لو فرغت المجموعة النشطة ينتقل التركيز لأقرب مجموعة مجاورة لها
 * بدل القفز لأول مجموعة في الشجرة.
 */
export function closePanels(layout, panelIds) {
    const next = clone(layout);
    for (const panelId of panelIds) {
        const group = groupOfPanel(next, panelId);
        if (!group) continue;
        detachMut(next, panelId);
        delete next.panels[panelId];
        if (!group.tabs.length && next.activeGroup === group.id) {
            const loc = findParent(next.root, group.id);
            const sibling = loc ? (loc.parent.children[loc.index + 1] || loc.parent.children[loc.index - 1]) : null;
            const firstGroup = sibling ? groupsOf({ root: sibling })[0] : null;
            next.activeGroup = firstGroup?.id ?? null;
        }
    }
    return normalize(next);
}

/**
 * ينقل تبويبًا إلى مجموعة (نفسها لإعادة الترتيب) قبل التبويب الذي في الموضع
 * `index` — الموضع محسوب على الشريط كما يراه المستخدم قبل النقل.
 */
export function movePanel(layout, panelId, targetGroupId, index = null) {
    const source = groupOfPanel(layout, panelId);
    const target = findGroup(layout, targetGroupId);
    if (!source || !target) return layout;

    const next = clone(layout);
    const src = findGroup(next, source.id);
    const dst = findGroup(next, target.id);
    let at = Number.isInteger(index) ? index : dst.tabs.length;
    if (src.id === dst.id && at > src.tabs.indexOf(panelId)) at -= 1;
    detachMut(next, panelId);
    dst.tabs.splice(Math.max(0, Math.min(at, dst.tabs.length)), 0, panelId);
    activateMut(next, panelId);
    return normalize(next);
}

/**
 * إرساء تبويب على حافة مجموعة: center ⇒ داخلها، وغير ذلك ⇒ مجموعة جديدة بجانبها.
 * يرجع نفس المرجع حين لا معنى للعملية (إرساء التبويب الوحيد على مجموعته) أو حين
 * تمنعها الحدود — والمستدعي يعرف ذلك بالمقارنة.
 */
export function dockPanel(layout, panelId, targetGroupId, edge) {
    if (!EDGES.includes(edge)) return layout;
    if (edge === 'center') return movePanel(layout, panelId, targetGroupId);
    const source = groupOfPanel(layout, panelId);
    const target = findGroup(layout, targetGroupId);
    if (!source || !target) return layout;
    if (source.id === target.id && source.tabs.length === 1) return layout;
    if (!canSplitBeside(layout, target.id, edge)) return layout;

    const next = clone(layout);
    detachMut(next, panelId);
    const fresh = newGroup(next, [panelId]);
    insertBeside(next, target.id, fresh, edge);
    next.activeGroup = fresh.id;
    return normalize(next);
}

/** «انقل لمجموعة جديدة» من القائمة أو الكيبورد = إرساء على حافة مجموعته. */
export function splitPanel(layout, panelId, edge) {
    const group = groupOfPanel(layout, panelId);
    return group ? dockPanel(layout, panelId, group.id, edge) : layout;
}

/**
 * يحرّك الفاصل بين الابن `index` والابن `index + 1` بمقدار `delta` (كسر من
 * التقسيم). الحد الأدنى يُحترم للطرفين؛ لو تعذّر يبقى الترتيب كما هو.
 */
export function resizeSplit(layout, splitId, index, delta, minFraction = LIMITS.minFraction) {
    const node = findNode(layout, splitId);
    if (!node || node.kind !== 'split' || index < 0 || index >= node.children.length - 1) return layout;
    const a = node.sizes[index];
    const b = node.sizes[index + 1];
    const min = Math.min(minFraction, (a + b) / 2);
    const clamped = Math.max(min - a, Math.min(b - min, delta));
    if (!Number.isFinite(clamped) || clamped === 0) return layout;
    const next = clone(layout);
    const split = findNode(next, splitId);
    split.sizes[index] = a + clamped;
    split.sizes[index + 1] = b - clamped;
    return next;
}

/* ====================  الحفظ والاستعادة  ==================== */

/** ما يُحفظ فقط: البنية والأنواع والمعاملات. لا عناوين ولا مفاتيح ولا أي محتوى. */
export function serializeLayout(layout) {
    const strip = (node) => (node.kind === 'group'
        ? { kind: 'group', id: node.id, tabs: [...node.tabs], active: node.active }
        : { kind: 'split', id: node.id, dir: node.dir, children: node.children.map(strip), sizes: [...node.sizes] });
    const panels = {};
    for (const p of Object.values(layout.panels)) panels[p.id] = { id: p.id, type: p.type, params: { ...p.params } };
    return {
        version: LAYOUT_VERSION,
        root: layout.root ? strip(layout.root) : null,
        panels,
        activeGroup: layout.activeGroup,
        seq: layout.seq
    };
}

/**
 * يقرأ ترتيبًا محفوظًا كمُدخل غير موثوق.
 *
 * كل كائن يُعاد بناؤه من حقول معروفة فقط (لا نسخ لمفاتيح غريبة ولا
 * __proto__). البنية المعطوبة ⇒ null فيبدأ المستخدم بترتيب افتراضي؛ أما
 * اللوحة المفردة غير الصالحة (نوع أُزيل، معرّف بشكل خاطئ، مفتاح مكرر) فتُسقَط
 * وحدها ويبقى الباقي.
 *
 * @param {(type: string, params: object) => ({params: object, key: string}|null)} validatePanel
 */
export function parseLayout(raw, { validatePanel } = {}) {
    try {
        if (!isPlainObject(raw) || raw.version !== LAYOUT_VERSION) return null;
        if (raw.panels !== undefined && !isPlainObject(raw.panels)) return null;

        const rawPanels = Object.entries(raw.panels || {});
        if (rawPanels.length > LIMITS.maxPanels) return null;

        const panels = {};
        const keys = new Set();
        let maxSeq = 0;
        const noteId = (id) => { maxSeq = Math.max(maxSeq, Number(id.slice(1))); };

        for (const [id, p] of rawPanels) {
            if (!ID_RE.panel.test(id) || !isPlainObject(p) || p.id !== id || typeof p.type !== 'string') continue;
            if (p.params !== undefined && !isPlainObject(p.params)) continue;
            const valid = validatePanel ? validatePanel(p.type, p.params || {}) : { params: {}, key: null };
            if (!valid || (valid.key && keys.has(valid.key))) continue;
            if (valid.key) keys.add(valid.key);
            panels[id] = { id, type: p.type, params: valid.params, key: valid.key ?? null };
            noteId(id);
        }

        const nodeIds = new Set();
        let groupCount = 0;
        const build = (node, depth) => {
            if (depth > LIMITS.maxDepth || !isPlainObject(node)) throw new Error('shape');
            if (typeof node.id !== 'string' || nodeIds.has(node.id)) throw new Error('id');
            nodeIds.add(node.id);
            if (node.kind === 'group') {
                if (!ID_RE.group.test(node.id) || !Array.isArray(node.tabs) || node.tabs.length > LIMITS.maxPanels) throw new Error('group');
                groupCount += 1;
                noteId(node.id);
                return {
                    kind: 'group', id: node.id,
                    tabs: node.tabs.filter((t) => typeof t === 'string'),
                    active: typeof node.active === 'string' ? node.active : null
                };
            }
            if (node.kind === 'split') {
                const { children, sizes } = node;
                if (!ID_RE.split.test(node.id) || (node.dir !== 'row' && node.dir !== 'column')) throw new Error('split');
                if (!Array.isArray(children) || children.length < 2 || children.length > LIMITS.maxGroups) throw new Error('children');
                if (!Array.isArray(sizes) || sizes.length !== children.length
                    || !sizes.every((s) => typeof s === 'number' && Number.isFinite(s) && s > 0)) throw new Error('sizes');
                noteId(node.id);
                return { kind: 'split', id: node.id, dir: node.dir, children: children.map((c) => build(c, depth + 1)), sizes: [...sizes] };
            }
            throw new Error('kind');
        };

        const root = raw.root === null || raw.root === undefined ? null : build(raw.root, 0);
        if (groupCount > LIMITS.maxGroups) return null;

        const seq = Number.isInteger(raw.seq) && raw.seq >= maxSeq && raw.seq < 1e6 ? raw.seq : maxSeq;
        const activeGroup = typeof raw.activeGroup === 'string' ? raw.activeGroup : null;
        return normalize({ version: LAYOUT_VERSION, root, panels, activeGroup, seq });
    } catch {
        return null;
    }
}
