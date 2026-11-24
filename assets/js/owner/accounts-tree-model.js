/**
 * accounts-tree-model.js — المنطق الخالص لصفحة «شجرة الحسابات» (المرحلة 1، قراءة فقط).
 *
 * ملف خالص بلا DOM ولا شبكة — يُختبر مباشرةً في node
 * (tests/owner-accounts-tree.test.mjs)، وتستورده صفحة owner/accounts.html
 * عبر assets/js/owner/pages/accounts.js.
 *
 * مصدر البيانات الوحيد owner_account_tree() (مigrations/128): وحدات مسطحة
 * مع parent_id، وشركات كل وحدة، وأعضاء كل شركة وعملاؤها، وفرع العملاء
 * المباشرين، وشركات بلا وحدة. البناء المتداخل هنا لا في القاعدة.
 */
import { SUB_STATUS_LABELS, SUB_STATUS_TONES } from './owner-labels.js';

export const MAX_UNIT_DEPTH = 6;
export const STORAGE_KEY = 'mad3oom-accounts-tree-collapsed';

export const TYPE_LABELS = Object.freeze({
    root: 'مالك المنصة',
    unit: 'وحدة إدارية',
    company: 'شركة',
    person: 'حساب',
    direct: 'عملاء مباشرون للمنصة',
    unassigned: 'شركات بلا وحدة'
});

export const ACCOUNT_TYPE_LABELS = Object.freeze({
    direct: 'عميل مباشر',
    direct_and_company: 'مباشر وعميل شركة',
    company_customer: 'عميل شركة',
    company_owner: 'مالك شركة',
    company_staff: 'موظف شركة',
    platform_staff: 'طاقم المنصة',
    unclassified: 'غير مصنّف'
});

export const PERSON_KIND_LABELS = Object.freeze({
    owner: 'مالك الشركة',
    staff: 'موظف',
    customer: 'عميل',
    unit_member: 'عضو وحدة',
    direct: 'عميل مباشر'
});

/** حالة العقدة للعرض: القيم نفس قيود القاعدة، والمجهول يُعرض كما هو لا يُخفى. */
export function statusInfo(status, walletFrozen = false) {
    if (walletFrozen) return { label: 'رصيد مجمّد', tone: 'status-pending' };
    switch (status) {
        case 'active': return { label: 'نشط', tone: 'status-resolved' };
        case 'suspended': return { label: 'موقوف', tone: 'status-rejected' };
        case 'banned': return { label: 'محظور', tone: 'status-rejected' };
        case null:
        case undefined:
        case '': return { label: '', tone: '' };
        default: return { label: String(status), tone: 'status-neutral' };
    }
}

/** حالة الاشتراك للعرض: نفس تعريف القاعدة — is_active لا عمود status وحده. */
export function subscriptionInfo(sub) {
    if (!sub) return { label: 'بلا اشتراك', tone: 'status-neutral' };
    const active = sub.is_active === true;
    const label = SUB_STATUS_LABELS[sub.status];
    if (sub.status === 'active' && !active) return { label: 'منتهٍ', tone: SUB_STATUS_TONES.expired };
    if (!label) return { label: 'غير محددة', tone: 'status-neutral' };
    return { label, tone: SUB_STATUS_TONES[sub.status] || 'status-neutral' };
}

const asArray = (v) => (Array.isArray(v) ? v : []);
const toInt = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** نص يُبحث فيه عن العقدة: الاسم والبريد والجوال والشركة. خالص. */
export function nodeSearchText(node) {
    const d = node.data || {};
    return [node.name, d.email, d.phone, d.companyName, d.accountTypeLabel, node.subtitle]
        .filter(Boolean).join(' ');
}

function personNode(person, parentKey, kind) {
    const sub = subscriptionInfo(person.subscription);
    const st = statusInfo(person.status, person.wallet?.is_frozen === true);
    return {
        key: `person:${person.id}`,
        type: 'person',
        id: person.id,
        parentKey,
        name: person.full_name || person.email || 'حساب بلا اسم',
        subtitle: PERSON_KIND_LABELS[kind] || ACCOUNT_TYPE_LABELS[person.account_type] || '',
        status: person.status || null,
        statusLabel: st.label,
        statusTone: st.tone,
        counts: { members: 0, customers: 0, openTickets: toInt(person.open_tickets), children: 0 },
        children: [],
        data: {
            kind,
            email: person.email || null,
            phone: person.phone || null,
            role: person.role || null,
            accountType: person.account_type || null,
            accountTypeLabel: ACCOUNT_TYPE_LABELS[person.account_type] || null,
            manager: person.manager || null,
            managerHistory: asArray(person.manager_history),
            subscription: person.subscription || null,
            subscriptionLabel: sub.label,
            subscriptionTone: sub.tone,
            memberships: asArray(person.memberships),
            points: toInt(person.points),
            wallet: person.wallet || null,
            directSince: person.direct_since || null
        }
    };
}

function companyNode(company, parentKey) {
    const st = statusInfo(company.status);
    const people = asArray(company.people).map(p => personNode(p, `company:${company.company_id}`, p.kind || 'customer'));
    return {
        key: `company:${company.company_id}`,
        type: 'company',
        id: company.company_id,
        parentKey,
        name: company.name || 'شركة بلا اسم',
        subtitle: TYPE_LABELS.company,
        status: company.status || null,
        statusLabel: st.label,
        statusTone: st.tone,
        counts: {
            members: toInt(company.members_count),
            customers: toInt(company.customers_count),
            openTickets: toInt(company.open_tickets),
            children: people.length
        },
        children: people,
        data: {
            events: asArray(company.events),
            membersCount: toInt(company.members_count),
            customersCount: toInt(company.customers_count)
        }
    };
}

/**
 * يبني الشجرة المتداخلة من ردّ owner_account_tree() المسطح.
 * الجذر «مالك المنصة» ← وحدات (parent_id، عمق ≤6) ← شركات ← أشخاص؛
 * وفرع «عملاء مباشرون للمنصة»؛ وجراب «شركات بلا وحدة». وحدة أمّها غائبة
 * (مؤرشفة أو خارج الرد) تُعلَّق تحت الجذر مع orphan: true لا تُخفى،
 * ووحدة أعمق من 6 تُثبَّت عند 6 دفاعًا (القاعدة تمنع إنشاءها أصلًا).
 */
export function buildAccountTree(payload = {}) {
    const root = {
        key: 'root',
        type: 'root',
        id: null,
        parentKey: null,
        name: TYPE_LABELS.root,
        subtitle: '',
        status: null,
        statusLabel: '',
        statusTone: '',
        counts: { members: 0, customers: 0, openTickets: 0, children: 0 },
        children: [],
        data: { counts: payload.counts || {}, delegationEnabled: payload.delegation_enabled === true }
    };

    const units = asArray(payload.units);
    const byId = new Map();
    for (const u of units) {
        const st = statusInfo(null);
        byId.set(u.id, {
            key: `unit:${u.id}`,
            type: 'unit',
            id: u.id,
            parentKey: u.parent_id ? `unit:${u.parent_id}` : 'root',
            name: u.name || 'وحدة بلا اسم',
            subtitle: TYPE_LABELS.unit,
            status: null,
            statusLabel: st.label,
            statusTone: st.tone,
            counts: { members: 0, customers: 0, openTickets: 0, children: 0 },
            children: [],
            data: {
                description: u.description || null,
                members: asArray(u.members),
                delegations: asArray(u.delegations),
                events: asArray(u.events),
                orphan: false,
                depthCapped: false
            }
        });
    }
    // العمق من الجذر؛ دورة parent_id (لا تحدث: القاعدة تمنعها) تُكسر عند 6.
    const depthOf = (node) => {
        let depth = 0;
        let cur = node;
        const seen = new Set([cur.id]);
        while (cur.parentKey && cur.parentKey !== 'root' && byId.has(cur.id)) {
            const parent = byId.get(String(cur.parentKey).replace(/^unit:/, ''));
            if (!parent || seen.has(parent.id)) break;
            seen.add(parent.id);
            depth += 1;
            cur = parent;
            if (depth > MAX_UNIT_DEPTH) break;
        }
        return depth;
    };
    for (const node of byId.values()) {
        const depth = depthOf(node);
        node.data.depth = Math.min(depth, MAX_UNIT_DEPTH);
        if (depth > MAX_UNIT_DEPTH) node.data.depthCapped = true;
        const parentId = node.parentKey === 'root' ? null : String(node.parentKey).replace(/^unit:/, '');
        const parent = parentId === null ? root : byId.get(parentId);
        if (parent && parent !== node && depth <= MAX_UNIT_DEPTH) {
            parent.children.push(node);
        } else {
            // أمّ غائبة (مؤرشفة أو خارج الرد) أو عمق فوق الحد: تحت الجذر مع علامة، لا تُخفى.
            node.data.orphan = parentId !== null || depth > MAX_UNIT_DEPTH;
            node.parentKey = 'root';
            node.data.depth = 0;
            root.children.push(node);
        }
    }
    // أعضاء الوحدة (طاقم) وشركاتها تحتها، بعد الوحدات الفرعية.
    for (const node of byId.values()) {
        const raw = units.find(u => u.id === node.id) || {};
        for (const c of asArray(raw.companies)) node.children.push(companyNode(c, node.key));
        for (const m of asArray(raw.members)) {
            node.children.push({
                key: `person:${m.user_id}`,
                type: 'person',
                id: m.user_id,
                parentKey: node.key,
                name: m.name || 'حساب بلا اسم',
                subtitle: PERSON_KIND_LABELS.unit_member,
                status: null,
                statusLabel: '',
                statusTone: '',
                counts: { members: 0, customers: 0, openTickets: toInt(m.open_tickets), children: 0 },
                children: [],
                data: {
                    kind: 'unit_member',
                    email: null,
                    phone: null,
                    role: m.role || null,
                    accountType: 'platform_staff',
                    accountTypeLabel: ACCOUNT_TYPE_LABELS.platform_staff,
                    manager: null,
                    managerHistory: [],
                    subscription: null,
                    subscriptionLabel: 'بلا اشتراك',
                    subscriptionTone: 'status-neutral',
                    memberships: [],
                    points: 0,
                    wallet: null,
                    directSince: null,
                    memberSince: m.since || null
                }
            });
        }
    }
    // فرع العملاء المباشرين.
    const direct = asArray(payload.direct_customers);
    if (direct.length) {
        root.children.push({
            key: 'direct',
            type: 'direct',
            id: null,
            parentKey: 'root',
            name: TYPE_LABELS.direct,
            subtitle: '',
            status: null,
            statusLabel: '',
            statusTone: '',
            counts: { members: 0, customers: direct.length, openTickets: direct.reduce((s, p) => s + toInt(p.open_tickets), 0), children: direct.length },
            children: direct.map(p => personNode(p, 'direct', 'direct')),
            data: {}
        });
    }
    // جراب الشركات بلا وحدة.
    const unassigned = asArray(payload.unassigned_companies);
    if (unassigned.length) {
        root.children.push({
            key: 'unassigned',
            type: 'unassigned',
            id: null,
            parentKey: 'root',
            name: TYPE_LABELS.unassigned,
            subtitle: '',
            status: null,
            statusLabel: '',
            statusTone: '',
            counts: {
                members: unassigned.reduce((s, c) => s + toInt(c.members_count), 0),
                customers: unassigned.reduce((s, c) => s + toInt(c.customers_count), 0),
                openTickets: unassigned.reduce((s, c) => s + toInt(c.open_tickets), 0),
                children: unassigned.length
            },
            children: unassigned.map(c => companyNode(c, 'unassigned')),
            data: {}
        });
    }
    // ترتيب أبناء كل عقدة: وحدات ثم شركات ثم أشخاص؛ داخل الشركة: مالك ثم موظف ثم عميل؛ وبالاسم داخل كل مرتبة.
    const order = { unit: 0, company: 1, direct: 1, unassigned: 1, person: 2, root: 0 };
    const kindOrder = { owner: 0, staff: 1, customer: 2, unit_member: 3, direct: 0 };
    const sortChildren = (node) => {
        node.children.sort((a, b) => (order[a.type] - order[b.type])
            || ((kindOrder[a.data?.kind] ?? 9) - (kindOrder[b.data?.kind] ?? 9))
            || String(a.name).localeCompare(String(b.name), 'ar'));
        node.children.forEach(sortChildren);
    };
    sortChildren(root);
    // عدّادات تصعد من الأوراق: كل عقدة تجمع أبناءها.
    const rollUp = (node) => {
        for (const child of node.children) rollUp(child);
        if (node.type === 'unit' || node.type === 'root') {
            node.counts.members = node.children.reduce((s, c) => s + (c.counts?.members || 0), 0)
                + (node.type === 'unit' ? asArray(node.data.members).length : 0);
            node.counts.customers = node.children.reduce((s, c) => s + (c.counts?.customers || 0), 0);
            node.counts.openTickets = node.children.reduce((s, c) => s + (c.counts?.openTickets || 0), 0);
        }
        node.counts.children = node.children.length;
    };
    rollUp(root);
    return root;
}

/** كل العقد في قائمة مسطحة مع مسار مفاتيحها من الجذر. خالصة. */
export function flattenTree(root) {
    const out = [];
    const walk = (node, path) => {
        out.push({ node, path: [...path, node.key] });
        for (const child of node.children || []) walk(child, [...path, node.key]);
    };
    if (root) walk(root, []);
    return out;
}

/** تطبيع البحث: فراغات زائدة وحالة أحرف — بلا تخمين لغوي. */
export function normalizeSearch(term) {
    return String(term || '').trim().toLowerCase();
}

/** هل تطابق العقدة مصطلح البحث (اسم/بريد/جوال/شركة)؟ */
export function nodeMatchesSearch(node, term) {
    const t = normalizeSearch(term);
    if (!t) return false;
    return nodeSearchText(node).toLowerCase().includes(t);
}

/**
 * البحث: مفاتيح المطابقات + مفاتيح الأسلاف التي يجب فتحها لتصل إليها.
 * لا نتيجة بلا مصطلح: { matches: [], expand: [] }.
 */
export function searchTree(root, term) {
    const t = normalizeSearch(term);
    if (!t || !root) return { matches: [], expand: [] };
    const matches = [];
    const expand = new Set();
    for (const { node, path } of flattenTree(root)) {
        if (nodeMatchesSearch(node, t)) {
            matches.push(node.key);
            path.slice(0, -1).forEach(k => expand.add(k));
        }
    }
    return { matches, expand: [...expand] };
}

/**
 * الفلاتر على الشجرة المبنية: تُبقي العقدة إن طابقت أو كان لها سليل مطابق،
 * مع أسلافها حتى الجذر. فلاتر: type (unit/company/person/direct)،
 * status (active/suspended/frozen)، unit (معرّف وحدة: فرعها وحده)،
 * noManager (أشخاص بلا مدير حساب).
 */
export function applyFilters(root, filters = {}) {
    if (!root) return null;
    const type = filters.type || '';
    const status = filters.status || '';
    const unitId = filters.unit || '';
    const noManager = filters.noManager === true;

    const personMatches = (node) => {
        if (type === 'unit' || type === 'company') return false;
        if (type === 'direct' && node.data?.kind !== 'direct') return false;
        if (type === 'person' && node.type !== 'person') return false;
        if (status === 'active' && node.status !== 'active') return false;
        if (status === 'suspended' && node.status !== 'suspended') return false;
        if (status === 'frozen' && node.data?.wallet?.is_frozen !== true) return false;
        if (noManager && node.data?.manager) return false;
        return true;
    };
    const nodeMatches = (node) => {
        if (node.type === 'person') return personMatches(node);
        if (type === 'unit' && node.type !== 'unit') return false;
        if (type === 'company' && node.type !== 'company') return false;
        if (type === 'direct' && node.type !== 'direct' && node.type !== 'person') return false;
        if (type === 'person' && node.type !== 'person') return false;
        if (status === 'suspended' && node.type === 'company' && node.status !== 'suspended') return false;
        if (status === 'active' && node.type === 'company' && node.status !== 'active') return false;
        return true;
    };
    // فلتر الوحدة: أسلاف الوحدة المطلوبة وفرعها كاملًا فقط.
    let unitScope = null;
    if (unitId) {
        unitScope = new Set();
        const hit = flattenTree(root).find(({ node }) => node.key === `unit:${unitId}`);
        if (hit) {
            hit.path.forEach(k => unitScope.add(k));
            const walk = (n) => { unitScope.add(n.key); (n.children || []).forEach(walk); };
            walk(hit.node);
        }
    }
    const inUnitScope = (node) => !unitScope || unitScope.has(node.key);
    const prune = (node, path) => {
        const here = [...path, node.key];
        if (!inUnitScope(node, here)) return null;
        const children = (node.children || []).map(c => prune(c, here)).filter(Boolean);
        const self = nodeMatches(node);
        if (!self && children.length === 0) return null;
        return { ...node, children };
    };
    return prune(root, []);
}

/* ── الطي/الفتح: مجموعة مفاتيح مطوية تُحفظ في localStorage ─────────────── */

/** الافتراضي بلا حفظ سابق: الوحدات العميقة (عمق ≥2) مطوية، والباقي مفتوح. */
export function defaultCollapsed(root) {
    const collapsed = new Set();
    for (const { node } of flattenTree(root)) {
        if (node.type === 'unit' && (node.data?.depth ?? 0) >= 2 && node.children.length) {
            collapsed.add(node.key);
        }
    }
    return collapsed;
}

export function loadCollapsed(storage) {
    try {
        const raw = storage?.getItem?.(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? new Set(parsed.filter(k => typeof k === 'string')) : null;
    } catch {
        return null;
    }
}

export function saveCollapsed(storage, collapsed) {
    try {
        storage?.setItem?.(STORAGE_KEY, JSON.stringify([...collapsed]));
    } catch {
        // تخزين غير متاح (وضع خاص): الطي يعمل للجلسة ولا يُحفظ.
    }
}

/** يقلب طيّ عقدة ويعيد مجموعة جديدة (لا يعدّل الأصلية). */
export function toggleCollapsed(collapsed, key) {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
}
