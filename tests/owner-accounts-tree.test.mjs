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
    statusInfo, subscriptionInfo, STORAGE_KEY, MAX_UNIT_DEPTH,
    TRANSFER_MIN_REASON, validateTransferReason, newIdempotencyKey, isIdempotencyKey,
    primaryMembership, canTransferPerson, ownedCompanyIds, transferTargets, buildTransferPayload,
    buildFullAccountDetails, validateProfileEdit, profileEditRequiresStepUp,
    EDITABLE_PROFILE_FIELDS, READONLY_PROFILE_FIELDS, SENSITIVE_PROFILE_ROLES,
    auditActionLabel, auditSourceLabel, usageEventLabel, usageCounterLabel, usageSourceLabel,
    transferStatusLabel, transferInitiatedLabel, accountRequestTypeLabel, accountRequestStatusLabel,
    joinedViaLabel, membershipStatusLabel, managerEndCauseLabel
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
            person({ memberships: [{ company_id: 'c1', company_name: 'شركة الاختبار', is_primary: true, status: 'active', joined_at: '2026-01-01' }] })
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

/* ── النقل بين آباء الشجرة (المرحلة 2) ───────────────────────────────────── */

test('سبب النقل: أقل من 20 حرفًا مرفوض، و20 مقبولة، والفارغ والمسافات مرفوضة', () => {
    assert.equal(TRANSFER_MIN_REASON, 20);
    assert.equal(validateTransferReason('قصير').ok, false);
    assert.equal(validateTransferReason(''.padEnd(19, 'س')).ok, false);
    assert.equal(validateTransferReason('   ').ok, false);
    const ok = validateTransferReason('  ' + 'س'.repeat(20) + '  ');
    assert.equal(ok.ok, true);
    assert.equal(ok.reason, 'س'.repeat(20), 'السبب يُقصّ قبل العدّ والحفظ');
});

test('مفتاح منع التكرار: UUID صالح وفريد في كل توليد', () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    assert.ok(isIdempotencyKey(a));
    assert.ok(isIdempotencyKey(b));
    assert.notEqual(a, b);
    assert.equal(isIdempotencyKey('ليس-uuid'), false);
    assert.equal(isIdempotencyKey(null), false);
});

test('العضوية الأساسية السارية وحدها تصلح مصدرًا للنقل', () => {
    const data = { memberships: [
        { company_id: 'c-old', company_name: 'قديمة', is_primary: true, status: 'ended', joined_at: '2025-01-01' },
        { company_id: 'c1', company_name: 'حالية', is_primary: true, status: 'active', joined_at: '2026-01-01' },
        { company_id: 'c2', company_name: 'إضافية', is_primary: false, status: 'active', joined_at: '2026-02-01' }
    ] };
    assert.equal(primaryMembership(data).company_id, 'c1');
    assert.equal(primaryMembership({ memberships: [] }), null);
    assert.equal(primaryMembership({}), null);
});

test('زر النقل يظهر للعميل ذي العضوية الأساسية فقط — لا لمالك الشركة ولا للموظف ولا لبلا عضوية', () => {
    const root = buildAccountTree(payload());
    assert.equal(canTransferPerson(find(root, 'person:p1')), true, 'عميل الشركة');
    assert.equal(canTransferPerson(find(root, 'person:p0')), false, 'مالك الشركة');
    assert.equal(canTransferPerson(find(root, 'person:p9')), false, 'مباشر بلا عضوية أساسية');
    assert.equal(canTransferPerson(find(root, 'company:c1')), false, 'عقدة شركة ليست شخصًا');
    assert.equal(canTransferPerson(null), false);
    const withPrimary = payload({
        direct_customers: [person({ id: 'p9', full_name: 'عميل مباشر', account_type: 'direct_and_company',
            memberships: [{ company_id: 'c1', company_name: 'شركة الاختبار', is_primary: true, status: 'active', joined_at: '2026-01-01' }] })]
    });
    assert.equal(canTransferPerson(find(buildAccountTree(withPrimary), 'person:p9')), true, 'مباشر وعميل شركة معًا');
});

test('وجهات نقل العميل تستبعد مصدره والشركات التي يملكها، وتذكر وحدة كل وجهة', () => {
    const root = buildAccountTree(payload());
    const targets = transferTargets(root, find(root, 'person:p1'));
    assert.equal(targets.kind, 'person');
    assert.equal(targets.sourceCompanyId, 'c1');
    assert.deepEqual(targets.options.map(o => o.id), ['c2'], 'شركة بلا وحدة وحدها؛ c1 مصدر، ولا شركة يملكها العميل');
    assert.equal(targets.options[0].unitName, 'بلا وحدة');
    // مالك الشركة يملك c1 فتُستبعد من وجهات نقله لو كان عميلًا فيها — تحقق عبر شجرة يملك فيها شركة أخرى.
    const owned = ownedCompanyIds(root, 'p0');
    assert.ok(owned.has('c1'));
    assert.ok(!ownedCompanyIds(root, 'p1').size);
});

test('وجهات نقل الشركة: كل الوحدات إلا وحدتها الحالية، مع خيار بلا وحدة', () => {
    const root = buildAccountTree(payload());
    const targets = transferTargets(root, find(root, 'company:c1'));
    assert.equal(targets.kind, 'company');
    assert.equal(targets.currentUnitId, 'u2');
    assert.deepEqual(targets.options.map(o => o.id), ['u1']);
    assert.equal(targets.canUnassign, true);
    const free = transferTargets(root, find(root, 'company:c2'));
    assert.equal(free.currentUnitId, null);
    assert.equal(free.canUnassign, false, 'بلا وحدة أصلًا فلا خيار إزالة');
});

test('بناء نداء النقل: العميل إلى owner_account_transfer، والشركة إلى owner_assign_company_unit القائم', () => {
    const root = buildAccountTree(payload());
    const personPayload = buildTransferPayload({
        node: find(root, 'person:p1'), tree: root, targetId: 'c2',
        reason: 'تصحيح ربط خاطئ بطلب موثَّق من العميل', keepSourceSecondary: true
    });
    assert.equal(personPayload.ok, true);
    assert.equal(personPayload.rpc, 'owner_account_transfer');
    assert.deepEqual(personPayload.args, {
        p_customer: 'p1', p_to_company: 'c2',
        p_reason: 'تصحيح ربط خاطئ بطلب موثَّق من العميل',
        p_keep_source_secondary: true, p_idempotency_key: personPayload.idempotencyKey
    });
    assert.ok(isIdempotencyKey(personPayload.idempotencyKey));
    const companyPayload = buildTransferPayload({
        node: find(root, 'company:c1'), tree: root, targetId: 'u1',
        reason: 'إعادة هيكلة الوحدات بعد مراجعة الإدارة'
    });
    assert.equal(companyPayload.ok, true);
    assert.equal(companyPayload.rpc, 'owner_assign_company_unit');
    assert.deepEqual(companyPayload.args, { p_company: 'c1', p_unit: 'u1', p_reason: 'إعادة هيكلة الوحدات بعد مراجعة الإدارة' });
    const unassign = buildTransferPayload({
        node: find(root, 'company:c1'), tree: root, targetId: null, reason: 'إعادة هيكلة الوحدات بعد مراجعة الإدارة'
    });
    assert.equal(unassign.args.p_unit, null, 'بلا وحدة = إنهاء الإسناد');
});

test('بناء نداء النقل يرفض السبب القصير والوجهة غير الصالحة والعميل بلا مصدر', () => {
    const root = buildAccountTree(payload());
    assert.equal(buildTransferPayload({
        node: find(root, 'person:p1'), tree: root, targetId: 'c2', reason: 'قصير'
    }).ok, false);
    assert.equal(buildTransferPayload({
        node: find(root, 'person:p1'), tree: root, targetId: 'c1', reason: 'تصحيح ربط خاطئ بطلب موثَّق من العميل'
    }).ok, false, 'المصدر نفسه ليس وجهة');
    assert.equal(buildTransferPayload({
        node: find(root, 'person:p1'), tree: root, targetId: 'لا-شركة', reason: 'تصحيح ربط خاطئ بطلب موثَّق من العميل'
    }).ok, false);
    assert.equal(buildTransferPayload({
        node: find(root, 'person:p9'), tree: root, targetId: 'c2', reason: 'تصحيح ربط خاطئ بطلب موثَّق من العميل'
    }).ok, false, 'مباشر بلا عضوية أساسية');
    assert.equal(buildTransferPayload({ node: find(root, 'unit:u1'), tree: root }).ok, false, 'الوحدة لا تُنقل');
});

/* ── التفاصيل الكاملة (المرحلة 2) ─────────────────────────────────────────── */

function fullRaw(over = {}) {
    return {
        profile: { id: 'p1', full_name: 'عميل الشركة', email: 'cust@example.com', phone: '01000000002', role: 'user', points: 120 },
        account_type: 'company_customer',
        memberships: [
            { company_id: 'c1', company_name: 'شركة الاختبار', is_primary: true, status: 'active', joined_at: '2026-01-01' },
            { company_id: 'c0', company_name: 'شركة قديمة', is_primary: false, status: 'ended', joined_at: '2025-01-01', ended_at: '2025-06-01' }
        ],
        manager: { id: 'm1', name: 'إداري' },
        manager_history: [{ manager_id: 'm0', manager_name: 'سابق', assigned_at: '2025-01-01', ended_at: '2025-12-01' }],
        subscriptions: [
            { plan: 'whatsapp', plan_name_ar: 'واتساب بيزنس', status: 'active', is_active: true, end_date: '2027-01-01T00:00:00Z', start_date: '2026-01-01T00:00:00Z', billing_cycle: 'monthly' },
            { plan: 'whatsapp', plan_name_ar: 'واتساب بيزنس', status: 'expired', is_active: false, end_date: '2025-06-01T00:00:00Z', start_date: '2025-01-01T00:00:00Z', billing_cycle: 'monthly' }
        ],
        wallet: { total_points: 120, available_points: 100, is_frozen: false },
        usage: [
            { recorded_at: '2026-11-20T10:00:00Z', period: '2026-11-01', event: 'ticket_created', counter: 'used', units: 1, ticket_id: 't1' },
            { recorded_at: '2026-11-21T10:00:00Z', period: '2026-11-01', event: 'billing_linked', counter: 'billing', units: 1, ticket_id: 't1' }
        ],
        tickets: {
            counts: { open: 1, 'in-progress': 1, resolved: 2 },
            open: 2,
            latest: [{ id: 't1', ticket_number: 42, title: 'مشكلة', status: 'open', created_at: '2026-11-20T10:00:00Z' }]
        },
        transfers: { pending: 0, latest: [{ id: 'x1', from_company: 'قديمة', to_company: 'شركة الاختبار', status: 'completed', initiated_as: 'owner', created_at: '2026-02-01T00:00:00Z' }] },
        requests: [{ id: 'r1', request_type: 'join', status: 'pending', requested_at: '2026-01-15T00:00:00Z' }],
        audit: [
            { source: 'membership', action: 'joined', actor_name: 'إداري', at: '2026-01-01T00:00:00Z' },
            { source: 'privileged', action: 'customer.transfer.owner', actor_name: 'مالك المنصة', at: '2026-02-01T00:00:00Z' },
            { source: 'subscription', action: 'renewed', actor_name: 'النظام', at: '2025-12-01T00:00:00Z' }
        ],
        history_note: 'ملاحظة السجل',
        ...over
    };
}

test('التفاصيل الكاملة: كل الاشتراكات لا الأحدث فقط، والعضويات السارية والمنتهية منفصلتان', () => {
    const full = buildFullAccountDetails(fullRaw());
    assert.equal(full.subscriptions.length, 2, 'المنتهي لا يُسقط');
    assert.equal(full.subscriptionsActive.length, 1);
    assert.equal(full.memberships.length, 2);
    assert.equal(full.membershipsActive.length, 1);
    assert.equal(full.membershipsEnded.length, 1);
    assert.equal(full.membershipsEnded[0].company_id, 'c0');
    assert.equal(full.wallet.available_points, 100);
    assert.equal(full.usage.length, 2);
});

test('التفاصيل الكاملة: عدّادات التذاكر حسب الحالة وأحدثها، والنقل والطلبات', () => {
    const full = buildFullAccountDetails(fullRaw());
    assert.deepEqual(full.tickets.counts, { open: 1, 'in-progress': 1, resolved: 2 });
    assert.equal(full.tickets.open, 2);
    assert.equal(full.tickets.latest[0].ticket_number, 42);
    assert.equal(full.transfers.latest[0].status, 'completed');
    assert.equal(full.requests.length, 1);
    assert.equal(full.manager.name, 'إداري');
    assert.equal(full.managerHistory.length, 1);
});

test('التفاصيل الكاملة: سجل التدقيق مدمج مرتب تنازليًا ومقصوص عند 50', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
        source: 'membership', action: `e${i}`, actor_name: 'x', at: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`
    }));
    const full = buildFullAccountDetails(fullRaw({ audit: many }));
    assert.equal(full.audit.length, 50);
    assert.ok(full.audit[0].at >= full.audit[1].at, 'الأحدث أولًا');
    const ordered = buildFullAccountDetails(fullRaw());
    assert.equal(ordered.audit[0].action, 'customer.transfer.owner', 'الأحدث زمنيًا أولًا رغم ترتيب المصدر');
    assert.equal(ordered.audit[2].source, 'subscription');
});

test('التفاصيل الكاملة: الغائب يُطبَّع إلى فارغ لا ينهار', () => {
    const full = buildFullAccountDetails({});
    assert.deepEqual(full.subscriptions, []);
    assert.deepEqual(full.membershipsActive, []);
    assert.equal(full.tickets.open, 0);
    assert.deepEqual(full.tickets.counts, {});
    assert.equal(full.wallet, null);
    assert.equal(full.audit.length, 0);
});

/* ── تعديل بيانات الحساب (المرحلة 2) ─────────────────────────────────────── */

test('الحقول المسموحة للتعديل الاسم والجوال فقط؛ البريد والرتبة قراءة فقط مع السبب', () => {
    assert.deepEqual([...EDITABLE_PROFILE_FIELDS], ['full_name', 'phone']);
    assert.ok(READONLY_PROFILE_FIELDS.email.includes('Auth'));
    assert.ok(READONLY_PROFILE_FIELDS.role.includes('مراجعات'));
    assert.equal(READONLY_PROFILE_FIELDS.email.includes('مسار'), true);
});

test('تعديل الحساب الحسّاس يتطلب تحققًا بخطوتين، وحساب العميل لا', () => {
    assert.deepEqual([...SENSITIVE_PROFILE_ROLES], ['platform_owner', 'admin', 'support']);
    assert.equal(profileEditRequiresStepUp('platform_owner'), true);
    assert.equal(profileEditRequiresStepUp('admin'), true);
    assert.equal(profileEditRequiresStepUp('support'), true);
    assert.equal(profileEditRequiresStepUp('user'), false);
    assert.equal(profileEditRequiresStepUp('company_admin'), false);
    assert.equal(profileEditRequiresStepUp(null), false);
});

test('التحقق من التعديل: قيم صالحة تُقبل كتغييرات، والمطابقة للحالية عدم تغيير', () => {
    const current = { full_name: 'عميل الشركة', phone: '01000000002' };
    const ok = validateProfileEdit({ fullName: '  عميل جديد  ', phone: '01000000009', current });
    assert.equal(ok.ok, true);
    assert.equal(ok.noop, false);
    assert.deepEqual(ok.changes, { full_name: 'عميل جديد', phone: '01000000009' });
    assert.equal(validateProfileEdit({ fullName: 'عميل الشركة', phone: '01000000002', current }).noop, true);
    assert.equal(validateProfileEdit({ fullName: 'عميل الشركة', current }).noop, true, 'حقل واحد مطابق = لا تغيير');
    assert.deepEqual(validateProfileEdit({ phone: '01000000009', current }).changes, { phone: '01000000009' });
});

test('التحقق من التعديل: الجوال الفارغ مسح، والاسم القصير والجوال بحروف مرفوضان، وبلا حقل مرفوض', () => {
    const current = { full_name: 'عميل الشركة', phone: '01000000002' };
    const cleared = validateProfileEdit({ phone: '   ', current });
    assert.equal(cleared.ok, true);
    assert.deepEqual(cleared.changes, { phone: null });
    assert.equal(validateProfileEdit({ fullName: 'س', current }).ok, false);
    assert.equal(validateProfileEdit({ fullName: 'س'.repeat(121), current }).ok, false);
    assert.equal(validateProfileEdit({ phone: 'abc123', current }).ok, false);
    assert.equal(validateProfileEdit({ phone: '+20 100 000 0002', current }).ok, true, 'علامة + ومسافات مسموحة');
    assert.equal(validateProfileEdit({ phone: '0'.repeat(31), current }).ok, false, 'أكثر من 30 حرفًا');
    assert.equal(validateProfileEdit({ current }).ok, false, 'لا حقل للتعديل');
});

test('اشتراك حالته active لكن تاريخه فات يُعرض منتهيًا لا فعّالًا', () => {
    assert.equal(subscriptionInfo({ status: 'active', is_active: false }).label, 'منتهٍ');
    assert.equal(subscriptionInfo({ status: 'active', is_active: true }).label, 'فعّال');
    assert.equal(subscriptionInfo(null).label, 'بلا اشتراك');
    assert.equal(subscriptionInfo({ status: 'nope', is_active: false }).label, 'غير محددة');
});

test('تسمية إجراء التدقيق: رفض نقل العضو بالعربية نفسها في صفحة العضو', () => {
    assert.equal(auditActionLabel('member_transfer_rejected'), 'رفضت المنصة نقله');
    assert.equal(auditActionLabel('member_transfer_approved'), 'وافقت المنصة على نقله');
    assert.equal(auditActionLabel('transferred_in'), 'نُقل إلى الشركة');
    assert.equal(auditActionLabel('joined'), 'انضم للشركة');
});

test('تسمية إجراء التدقيق: امتيازات وهرمية واشتراكات', () => {
    assert.equal(auditActionLabel('customer.transfer.owner'), 'نقل المالك عميلًا بين شركتين');
    assert.equal(auditActionLabel('company.member_transfer.rejected'), 'رفضت المنصة نقل عضو');
    assert.equal(auditActionLabel('profile.update.owner'), 'عدّل المالك بيانات حساب');
    assert.equal(auditActionLabel('step_up.verified'), 'تم التحقق بخطوتين');
    assert.equal(auditActionLabel('customer.transferred'), 'نُقل عميل من الشركة');
    assert.equal(auditActionLabel('customer.transferred_in'), 'نُقل عميل إلى الشركة');
    assert.equal(auditActionLabel('company.assigned'), 'أُسندت شركة إلى وحدة');
    assert.equal(auditActionLabel('update'), 'حُدّث الاشتراك');
    assert.equal(auditActionLabel('upgrade'), 'رُقّي الاشتراك');
    assert.equal(auditActionLabel('deactivate'), 'أُلغي تفعيل الاشتراك');
});

test('تسمية إجراء التدقيق: بادئات ديناميكية، والمجهول يُعرض كما هو لا يُخفى', () => {
    assert.equal(auditActionLabel('company.status.suspended'), 'تغيّرت حالة الشركة');
    assert.equal(auditActionLabel('feature_switch.customer_transfers_enabled'), 'تغيّر مفتاح ميزة');
    assert.equal(auditActionLabel('data_access.rule.foo'), 'تغيّرت قاعدة وصول للبيانات');
    assert.equal(auditActionLabel('some_future_action'), 'some_future_action');
    assert.equal(auditActionLabel(''), '');
    assert.equal(auditActionLabel(null), '');
});

test('تسمية مصدر سجل التدقيق: المصدر نفسه يشرح المعنى بالعربية', () => {
    assert.equal(auditSourceLabel('membership'), 'عضويات الشركات');
    assert.equal(auditSourceLabel('privileged'), 'إجراءات المالك المميزة');
    assert.equal(auditSourceLabel('hierarchy'), 'هيكل الحسابات');
    assert.equal(auditSourceLabel('subscription'), 'الاشتراكات');
    assert.equal(auditSourceLabel('unknown_source'), 'unknown_source');
    assert.equal(auditSourceLabel(''), '');
});

test('تسميات قيود الاستهلاك والنقل والطلبات في لوحة التفاصيل', () => {
    assert.equal(usageEventLabel('ticket_created'), 'أُنشئت تذكرة');
    assert.equal(usageEventLabel('billing_linked'), 'رُبطت بالفوترة');
    assert.equal(usageCounterLabel('used'), 'مستخدَمة');
    assert.equal(usageCounterLabel('none'), 'بلا احتساب');
    assert.equal(usageSourceLabel('trigger'), 'تلقائي');
    assert.equal(usageSourceLabel('backfill'), 'تعبئة تاريخية');
    assert.equal(transferStatusLabel('pending'), 'معلّق');
    assert.equal(transferStatusLabel('completed'), 'مكتمل');
    assert.equal(transferStatusLabel('expired'), 'منتهٍ');
    assert.equal(transferInitiatedLabel('customer'), 'بطلب العميل');
    assert.equal(transferInitiatedLabel('owner'), 'بقرار المالك');
    assert.equal(accountRequestTypeLabel('add_to_company'), 'إضافة عميل إلى شركة');
    assert.equal(accountRequestTypeLabel('transfer_direct_to_company'), 'نقل عميل مباشر إلى شركة');
    assert.equal(accountRequestStatusLabel('pending'), 'بانتظار القرار');
    assert.equal(accountRequestStatusLabel('approved'), 'موافَق عليه');
});

test('طريقة الانضمام وحالة العضوية وسبب انتهاء المدير بالعربية', () => {
    assert.equal(joinedViaLabel('backfill'), 'منذ إنشاء الحساب');
    assert.equal(joinedViaLabel('invitation'), 'دعوة');
    assert.equal(joinedViaLabel('transfer'), 'نقل من شركة أخرى');
    assert.equal(joinedViaLabel('account_request'), 'طلب حساب');
    assert.equal(membershipStatusLabel('active'), 'نشطة');
    assert.equal(membershipStatusLabel('ended'), 'منتهية');
    assert.equal(managerEndCauseLabel('reassigned'), 'أُعيد إسناده');
    assert.equal(managerEndCauseLabel('manager_deleted'), 'حُذف المدير');
    assert.equal(joinedViaLabel('future_via'), 'future_via');
});
