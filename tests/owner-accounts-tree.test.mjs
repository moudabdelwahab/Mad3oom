/**
 * اختبارات المنطق الخالص لصفحة «شجرة الحسابات» (المرحلة 1، قراءة فقط).
 *
 * على نمط tests/company-model.test.mjs: الوحدات الخالصة في
 * assets/js/owner/accounts-tree-model.js تُختبر بمعزل عن المتصفح وعن
 * قاعدة البيانات — قرار الصلاحية نفسه (owner_only) مُختبَر في
 * tests/sql/owner-account-tree.test.sql لأنه يُتخذ في القاعدة لا هنا.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
    buildAccountTree, flattenTree, searchTree, applyFilters,
    defaultCollapsed, loadCollapsed, saveCollapsed, toggleCollapsed,
    statusInfo, subscriptionInfo, STORAGE_KEY, MAX_UNIT_DEPTH
} = await import('../assets/js/owner/accounts-tree-model.js');

function person(over = {}) {
    return {
        id: 'p1', full_name: 'عميل الشركة', email: 'cust@example.com', phone: '01000000002',
        role: 'user', points: 120, status: 'active',
        wallet: { total_points: 120, available_points: 120, is_frozen: false },
        manager: null, manager_history: [],
        subscription: { plan: 'whatsapp', plan_name_ar: 'واتساب بيزنس', status: 'active', is_active: true, end_date: '2027-01-01T00:00:00Z' },
        memberships: [], open_tickets: 2, account_type: 'company_customer', direct_since: null,
        kind: 'customer', ...over
    };
}

function company(over = {}) {
    return {
        company_id: 'c1', name: 'شركة الاختبار', status: 'active',
        members_count: 1, customers_count: 1, open_tickets: 3,
        people: [
            { ...person({ id: 'p0', full_name: 'مالك الشركة', email: 'cowner@example.com', phone: '01000000001', account_type: 'company_owner', open_tickets: 0 }), kind: 'owner' },
            person()
        ],
        events: [], ...over
    };
}

function payload(over = {}) {
    return {
        delegation_enabled: false,
        units: [
            { id: 'u1', parent_id: null, name: 'وحدة الجذر', description: null, members: [], companies: [], delegations: [], events: [] },
            { id: 'u2', parent_id: 'u1', name: 'وحدة الابنة', description: null, members: [], companies: [company()], delegations: [], events: [] }
        ],
        unassigned_companies: [company({ company_id: 'c2', name: 'شركة بلا وحدة', status: 'suspended', members_count: 0, customers_count: 0, open_tickets: 0, people: [] })],
        direct_customers: [person({ id: 'p9', full_name: 'عميل مباشر', email: 'direct@example.com', phone: '01000000003', account_type: 'direct', open_tickets: 0 })],
        counts: { units: 2, companies: 2, direct_customers: 1, members: 3, customers: 2, open_tickets: 3 },
        ...over
    };
}

const keysOf = (root) => flattenTree(root).map(({ node }) => node.key);
const find = (root, key) => flattenTree(root).find(({ node }) => node.key === key)?.node;

/* ── بناء الشجرة المتداخلة ─────────────────────────────────────────────── */

test('الوحدات تُبنى متداخلة من الصفوف المسطحة عبر parent_id', () => {
    const root = buildAccountTree(payload());
    const child = find(root, 'unit:u2');
    assert.ok(child, 'الوحدة الابنة موجودة');
    assert.equal(child.parentKey, 'unit:u1');
    assert.equal(find(root, 'unit:u1').children.filter(c => c.type === 'unit').length, 1);
    assert.equal(child.data.depth, 1);
});

test('الشركة تحت وحدتها، وأعضاؤها وعملاؤها تحتها بالترتيب مالك ثم عميل', () => {
    const root = buildAccountTree(payload());
    const comp = find(root, 'company:c1');
    assert.ok(comp, 'الشركة موجودة');
    assert.equal(comp.parentKey, 'unit:u2');
    assert.equal(comp.children.length, 2);
    assert.equal(comp.children[0].data.kind, 'owner');
    assert.equal(comp.children[1].data.kind, 'customer');
});

test('فرع العملاء المباشرين وجراب الشركات بلا وحدة تحت الجذر', () => {
    const root = buildAccountTree(payload());
    assert.ok(find(root, 'direct'), 'فرع المباشرين موجود');
    assert.equal(find(root, 'direct').children.length, 1);
    assert.equal(find(root, 'direct').children[0].data.kind, 'direct');
    assert.ok(find(root, 'unassigned'), 'جراب بلا وحدة موجود');
    assert.equal(find(root, 'unassigned').children[0].key, 'company:c2');
});

test('وحدة أمّها غائبة تُعلَّق تحت الجذر مع علامة يتيم لا تُخفى', () => {
    const root = buildAccountTree(payload({
        units: [{ id: 'u9', parent_id: 'missing', name: 'وحدة يتيمة', members: [], companies: [], delegations: [], events: [] }]
    }));
    const orphan = find(root, 'unit:u9');
    assert.ok(orphan);
    assert.equal(orphan.parentKey, 'root');
    assert.equal(orphan.data.orphan, true);
    assert.ok(keysOf(root).includes('unit:u9'));
});

test('عمق أعمق من 6 يُثبَّت عند 6 وتُعلَّق الوحدة تحت الجذر', () => {
    const units = [];
    for (let i = 0; i < 8; i++) {
        units.push({
            id: `d${i}`, parent_id: i === 0 ? null : `d${i - 1}`,
            name: `مستوى ${i}`, members: [], companies: [], delegations: [], events: []
        });
    }
    const root = buildAccountTree(payload({ units }));
    assert.equal(MAX_UNIT_DEPTH, 6);
    const deepest = find(root, 'unit:d7');
    assert.ok(deepest);
    assert.equal(deepest.data.depthCapped, true);
    assert.equal(deepest.parentKey, 'root');
    const level6 = find(root, 'unit:d6');
    assert.equal(level6.data.depth, 6);
    assert.equal(level6.data.depthCapped, false);
});

test('العدّادات تصعد من الأوراق: التذاكر المفتوحة والأعضاء والعملاء', () => {
    const root = buildAccountTree(payload());
    const child = find(root, 'unit:u2');
    assert.equal(child.counts.openTickets, 3);
    assert.equal(child.counts.members, 1); // مالك الشركة عضو
    assert.equal(child.counts.customers, 1);
    assert.equal(root.counts.openTickets, 3);
    assert.equal(root.counts.customers, 2); // عميل شركة + عميل مباشر
});

/* ── البحث مع فتح المسار ───────────────────────────────────────────────── */

test('البحث يجد بالبريد والجوال ويعيد مفاتيح الأسلاف لفتح مسارها', () => {
    const root = buildAccountTree(payload());
    const byEmail = searchTree(root, 'direct@example.com');
    assert.deepEqual(byEmail.matches, ['person:p9']);
    assert.ok(byEmail.expand.includes('direct'));
    assert.ok(byEmail.expand.includes('root'));
    const byPhone = searchTree(root, '01000000002');
    assert.deepEqual(byPhone.matches, ['person:p1']);
    assert.ok(byPhone.expand.includes('company:c1'));
    assert.ok(byPhone.expand.includes('unit:u2'));
    assert.ok(byPhone.expand.includes('unit:u1'));
});

test('بحث فارغ أو بلا مصطلح يعيد لا شيء', () => {
    const root = buildAccountTree(payload());
    assert.deepEqual(searchTree(root, ''), { matches: [], expand: [] });
    assert.deepEqual(searchTree(root, '   '), { matches: [], expand: [] });
    assert.deepEqual(searchTree(root, 'لا_يوجد_مثل_هذا').matches, []);
});

/* ── الفلاتر ───────────────────────────────────────────────────────────── */

test('فلتر النوع يُبقي الشركات وأسلافها فقط', () => {
    const filtered = applyFilters(buildAccountTree(payload()), { type: 'company' });
    const keys = keysOf(filtered);
    assert.ok(keys.includes('company:c1'));
    assert.ok(keys.includes('company:c2'));
    assert.ok(!keys.includes('person:p1'), 'الأشخاص يُستبعدون');
    assert.ok(keys.includes('unit:u2'), 'سلف الشركة يبقى');
});

test('فلتر الحالة الموقوفة يُبقي الشركة الموقوفة وحدها', () => {
    const filtered = applyFilters(buildAccountTree(payload()), { status: 'suspended' });
    assert.ok(keysOf(filtered).includes('company:c2'));
    assert.ok(!keysOf(filtered).includes('company:c1'));
});

test('فلتر «بلا مدير حساب» يُبقي من لا مدير له ويستبعد من له مدير', () => {
    const withManager = payload({
        direct_customers: [person({ id: 'p9', full_name: 'عميل مباشر', account_type: 'direct', manager: { id: 'm1', name: 'إداري' } })]
    });
    const filtered = applyFilters(buildAccountTree(withManager), { noManager: true });
    assert.ok(!keysOf(filtered).includes('person:p9'));
    assert.ok(keysOf(filtered).includes('person:p1'));
});

test('فلتر الرصيد المجمّد يجد الشخص ذا المحفظة المجمّدة فقط', () => {
    const frozen = payload({
        direct_customers: [person({ id: 'p9', full_name: 'عميل مباشر', account_type: 'direct', wallet: { total_points: 5, available_points: 5, is_frozen: true } })]
    });
    const filtered = applyFilters(buildAccountTree(frozen), { status: 'frozen' });
    assert.ok(keysOf(filtered).includes('person:p9'));
    assert.ok(!keysOf(filtered).includes('person:p1'));
});

test('فلتر الوحدة يقصر الشجرة على فرعها', () => {
    const filtered = applyFilters(buildAccountTree(payload()), { unit: 'u2' });
    assert.ok(keysOf(filtered).includes('company:c1'));
    assert.ok(!keysOf(filtered).includes('company:c2'));
    assert.ok(!keysOf(filtered).includes('direct'));
});

/* ── الطي/الفتح والحفظ ─────────────────────────────────────────────────── */

test('قلب الطي يعيد مجموعة جديدة ولا يعدّل الأصلية', () => {
    const before = new Set(['unit:u1']);
    const after = toggleCollapsed(before, 'unit:u2');
    assert.ok(after.has('unit:u1') && after.has('unit:u2'));
    assert.ok(!before.has('unit:u2'));
    assert.ok(!toggleCollapsed(after, 'unit:u2').has('unit:u2'));
});

test('الحفظ والتحميل في التخزين ذهابًا وإيابًا، والتالف يُتجاهل', () => {
    const store = new Map();
    const storage = {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => { store.set(k, v); }
    };
    saveCollapsed(storage, new Set(['unit:u1', 'company:c1']));
    assert.deepEqual([...loadCollapsed(storage)], ['unit:u1', 'company:c1']);
    store.set(STORAGE_KEY, 'ليس json');
    assert.equal(loadCollapsed(storage), null);
    assert.equal(loadCollapsed(null), null);
});

test('الافتراضي: الوحدات العميقة (عمق ≥2) مطوية والباقي مفتوح', () => {
    const units = [];
    for (let i = 0; i < 4; i++) {
        units.push({
            id: `d${i}`, parent_id: i === 0 ? null : `d${i - 1}`,
            name: `مستوى ${i}`, members: [], companies: [], delegations: [], events: []
        });
    }
    const collapsed = defaultCollapsed(buildAccountTree(payload({ units })));
    assert.ok(!collapsed.has('unit:d0'));
    assert.ok(!collapsed.has('unit:d1'));
    assert.ok(collapsed.has('unit:d2'));
});

/* ── التسميات ─────────────────────────────────────────────────────────── */

test('كل حالة عقدة معروفة لها تسمية وشارة، والمجهولة تُعرض كما هي', () => {
    assert.equal(statusInfo('active').label, 'نشط');
    assert.equal(statusInfo('suspended').label, 'موقوف');
    assert.equal(statusInfo('suspended').tone, 'status-rejected');
    assert.equal(statusInfo(null).label, '');
    assert.equal(statusInfo('weird_state').label, 'weird_state');
    assert.equal(statusInfo('active', true).label, 'رصيد مجمّد');
});

test('اشتراك حالته active لكن تاريخه فات يُعرض منتهيًا لا فعّالًا', () => {
    assert.equal(subscriptionInfo({ status: 'active', is_active: false }).label, 'منتهٍ');
    assert.equal(subscriptionInfo({ status: 'active', is_active: true }).label, 'فعّال');
    assert.equal(subscriptionInfo(null).label, 'بلا اشتراك');
    assert.equal(subscriptionInfo({ status: 'nope', is_active: false }).label, 'غير محددة');
});
