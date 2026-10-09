/**
 * اختبارات محرك ترتيب مساحة العمل (assets/js/admin/workspace/dock-model.js)
 * وسجل اللوحات (panel-registry.js) — دوال خالصة.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createLayout, openPanel, closePanel, closePanels, movePanel, dockPanel, splitPanel,
    resizeSplit, activatePanel, groupsOf, groupOfPanel, panelOrder, panelsToClose,
    targetForOpenFrom, serializeLayout, parseLayout, findNode, LIMITS
} from '../assets/js/admin/workspace/dock-model.js';
import {
    validatePanel, panelUrl, panelFromUrl, isPanelAllowed, recordId, UUID_RE
} from '../assets/js/admin/workspace/panel-registry.js';

const S1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const S2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const T1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const C1 = 'cccccccc-0000-4000-8000-000000000001';

/** يفتح لوحة بنفس الطريقة التي يفتح بها المتحكم: التحقق من السجل ثم المحرك. */
function open(layout, type, params = {}, options = {}) {
    const valid = validatePanel(type, params);
    assert.ok(valid, `لوحة غير صالحة: ${type}`);
    return openPanel(layout, { type, params: valid.params, key: valid.key }, options);
}

/** ثلاث لوحات في مجموعة واحدة: صندوق، محادثة، تذكرة (النشطة = التذكرة). */
function threeTabs() {
    let r = open(createLayout(), 'inbox');
    const inbox = r.panelId;
    r = open(r.layout, 'conversation', { sessionId: S1 });
    const conv = r.panelId;
    r = open(r.layout, 'ticket', { ticketId: T1 });
    return { layout: r.layout, inbox, conv, ticket: r.panelId };
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const near = (a, b) => Math.abs(a - b) < 1e-9;

/* ====================  المجموعات والتبويبات  ==================== */

test('أول لوحة تنشئ مجموعة الجذر وتصبح النشطة', () => {
    const { layout, panelId } = open(createLayout(), 'inbox');
    assert.equal(layout.root.kind, 'group');
    assert.deepEqual(layout.root.tabs, [panelId]);
    assert.equal(layout.root.active, panelId);
    assert.equal(layout.activeGroup, layout.root.id);
});

test('اللوحة الجديدة تُدرج بعد التبويب النشط مباشرةً لا في آخر الشريط', () => {
    let { layout, inbox, conv, ticket } = threeTabs();
    layout = activatePanel(layout, inbox);
    const r = open(layout, 'customer', { customerId: C1 });
    assert.deepEqual(groupsOf(r.layout)[0].tabs, [inbox, r.panelId, conv, ticket]);
});

test('منع التكرار: فتح نفس المحادثة مرة ثانية ينشّط تبويبها ولا ينشئ آخر', () => {
    const { layout, conv } = threeTabs();
    const upper = S1.toUpperCase();
    const r = open(layout, 'conversation', { sessionId: upper });
    assert.equal(r.existed, true);
    assert.equal(r.panelId, conv);
    assert.equal(Object.keys(r.layout.panels).length, 3);
    assert.equal(groupOfPanel(r.layout, conv).active, conv);
    // اللوحات الفردية (الصندوق) مفتاحها نوعها
    assert.equal(open(r.layout, 'inbox').existed, true);
});

test('حد عدد اللوحات يُرفض بصراحة بدل كسر الترتيب', () => {
    let layout = createLayout();
    for (let i = 0; i < LIMITS.maxPanels; i++) {
        const id = `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`;
        layout = open(layout, 'conversation', { sessionId: id }).layout;
    }
    const r = open(layout, 'ticket', { ticketId: T1 });
    assert.equal(r.refused, 'max-panels');
    assert.equal(r.layout, layout);
});

test('إغلاق التبويب النشط ينشّط جاره، وإغلاق آخر تبويب يفرغ الترتيب', () => {
    let { layout, conv, ticket, inbox } = threeTabs();
    layout = activatePanel(layout, conv);
    layout = closePanel(layout, conv);
    assert.equal(groupsOf(layout)[0].active, ticket, 'التالي بعد المغلق');
    layout = closePanels(layout, [ticket, inbox]);
    assert.equal(layout.root, null);
    assert.equal(layout.activeGroup, null);
    assert.deepEqual(layout.panels, {});
});

test('أغلق الأخرى / أغلق حتى النهاية تحسب التبويبات الصحيحة', () => {
    const { layout, inbox, conv, ticket } = threeTabs();
    assert.deepEqual(panelsToClose(layout, conv, 'others'), [inbox, ticket]);
    assert.deepEqual(panelsToClose(layout, inbox, 'toEnd'), [conv, ticket]);
    assert.deepEqual(panelsToClose(layout, ticket, 'toEnd'), []);
});

/* ====================  النقل وإعادة الترتيب  ==================== */

test('إعادة ترتيب داخل المجموعة: الموضع محسوب على الشريط قبل النقل', () => {
    const { layout, inbox, conv, ticket } = threeTabs();
    const g = groupsOf(layout)[0].id;
    // اسحب الصندوق (0) وأسقطه قبل التذكرة (2) ⇒ محادثة، صندوق، تذكرة
    assert.deepEqual(groupsOf(movePanel(layout, inbox, g, 2))[0].tabs, [conv, inbox, ticket]);
    // للنهاية
    assert.deepEqual(groupsOf(movePanel(layout, inbox, g, 3))[0].tabs, [conv, ticket, inbox]);
    // للبداية
    assert.deepEqual(groupsOf(movePanel(layout, ticket, g, 0))[0].tabs, [ticket, inbox, conv]);
});

test('نقل تبويب بين مجموعتين يحفظ هويته، والمجموعة التي فرغت تُحذف', () => {
    let { layout, inbox, conv, ticket } = threeTabs();
    layout = splitPanel(layout, ticket, 'end');
    const [left, right] = groupsOf(layout);
    assert.deepEqual(right.tabs, [ticket]);

    layout = movePanel(layout, conv, right.id, 0);
    assert.deepEqual(groupsOf(layout).find((g) => g.id === right.id).tabs, [conv, ticket]);
    assert.equal(layout.panels[conv].params.sessionId, S1, 'نفس السجل');
    assert.equal(layout.activeGroup, right.id);

    // التذكرة كانت الوحيدة مع المحادثة في اليمين؛ لو نقلنا كل ما في اليسار يختفي اليسار
    layout = movePanel(layout, inbox, right.id);
    assert.equal(groupsOf(layout).length, 1);
    assert.equal(layout.root.kind, 'group', 'التقسيم ذو الابن الواحد يُرفع');
    assert.ok(!findNode(layout, left.id));
});

/* ====================  الإرساء والتقسيم  ==================== */

for (const [edge, dir, newIndex] of [['start', 'row', 0], ['end', 'row', 1], ['top', 'column', 0], ['bottom', 'column', 1]]) {
    test(`إرساء على الحافة ${edge} ينشئ تقسيم ${dir} والمجموعة الجديدة في الموضع ${newIndex}`, () => {
        const { layout, conv } = threeTabs();
        const target = groupsOf(layout)[0];
        const next = dockPanel(layout, conv, target.id, edge);
        assert.equal(next.root.kind, 'split');
        assert.equal(next.root.dir, dir);
        assert.ok(near(sum(next.root.sizes), 1));
        const fresh = next.root.children[newIndex];
        assert.deepEqual(fresh.tabs, [conv]);
        assert.equal(next.activeGroup, fresh.id);
        assert.ok(!next.root.children[1 - newIndex].tabs.includes(conv));
    });
}

test('الإرساء في المركز ينقل التبويب داخل المجموعة الهدف', () => {
    let { layout, conv, ticket } = threeTabs();
    layout = splitPanel(layout, ticket, 'end');
    const right = groupsOf(layout)[1];
    layout = dockPanel(layout, conv, right.id, 'center');
    assert.deepEqual(groupsOf(layout)[1].tabs, [ticket, conv]);
});

test('إرساء التبويب الوحيد على مجموعته لا يفعل شيئًا (نفس المرجع)', () => {
    const { layout } = open(createLayout(), 'inbox');
    assert.equal(dockPanel(layout, 'p1', layout.root.id, 'end'), layout);
    assert.equal(splitPanel(layout, 'p1', 'bottom'), layout);
    assert.equal(dockPanel(layout, 'p1', layout.root.id, 'diagonal'), layout, 'حافة غير معروفة');
});

test('تقسيمات متداخلة: أفقي داخله رأسي، والتقسيم بنفس الاتجاه يعاد استخدامه', () => {
    let { layout, inbox, conv, ticket } = threeTabs();
    layout = splitPanel(layout, conv, 'end');          // [inbox,ticket] | [conv]
    layout = splitPanel(layout, ticket, 'end');        // نفس الاتجاه ⇒ [inbox] | [ticket] | [conv] بلا تداخل
    assert.equal(layout.root.dir, 'row');
    assert.equal(layout.root.children.length, 3);
    assert.ok(near(sum(layout.root.sizes), 1));

    const convGroup = groupOfPanel(layout, conv);
    const r = open(layout, 'customer', { customerId: C1 }, { group: convGroup.id, edge: 'bottom' });
    layout = r.layout;
    const column = layout.root.children.find((c) => c.kind === 'split');
    assert.equal(column.dir, 'column');
    assert.deepEqual(column.children.map((c) => c.tabs[0]), [conv, r.panelId]);
    assert.deepEqual(panelOrder(layout), [inbox, ticket, conv, r.panelId]);
});

test('تقسيم بنفس الاتجاه داخل تقسيم يُسطَّح بأحجام متناسبة', () => {
    const raw = {
        version: 1, seq: 9, activeGroup: 'g1',
        panels: { p1: { id: 'p1', type: 'inbox', params: {} }, p2: { id: 'p2', type: 'tickets', params: {} }, p3: { id: 'p3', type: 'customers', params: {} } },
        root: { kind: 'split', id: 's1', dir: 'row', sizes: [0.5, 0.5], children: [
            { kind: 'group', id: 'g1', tabs: ['p1'], active: 'p1' },
            { kind: 'split', id: 's2', dir: 'row', sizes: [0.5, 0.5], children: [
                { kind: 'group', id: 'g2', tabs: ['p2'], active: 'p2' },
                { kind: 'group', id: 'g3', tabs: ['p3'], active: 'p3' }] }] }
    };
    const layout = parseLayout(raw, { validatePanel });
    assert.equal(layout.root.children.length, 3);
    assert.deepEqual(layout.root.sizes.map((s) => +s.toFixed(3)), [0.5, 0.25, 0.25]);
});

test('حد عدد المجموعات: الإرساء يُرفض والفتح الجانبي يقع داخل المجموعة', () => {
    let layout = createLayout();
    for (let i = 0; i < LIMITS.maxGroups + 1; i++) {
        const id = `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`;
        layout = open(layout, 'conversation', { sessionId: id }, { edge: 'end' }).layout;
    }
    assert.equal(groupsOf(layout).length, LIMITS.maxGroups);
    const panel = groupsOf(layout)[0].tabs[0];
    const extra = open(layout, 'ticket', { ticketId: T1 }, { group: groupsOf(layout)[0].id }).layout;
    assert.equal(dockPanel(extra, panel, groupsOf(extra)[0].id, 'bottom'), extra);
});

/* ====================  تغيير الحجم  ==================== */

test('تحريك الفاصل يحافظ على المجموع ويحترم الحد الأدنى للطرفين', () => {
    let { layout, ticket } = threeTabs();
    layout = splitPanel(layout, ticket, 'end');
    const split = layout.root.id;

    const wider = resizeSplit(layout, split, 0, 0.2);
    assert.deepEqual(wider.root.sizes.map((s) => +s.toFixed(3)), [0.7, 0.3]);
    assert.deepEqual(layout.root.sizes, [0.5, 0.5], 'المدخل لم يتغير');

    const clamped = resizeSplit(layout, split, 0, 5);
    assert.ok(near(clamped.root.sizes[1], LIMITS.minFraction));
    assert.ok(near(sum(clamped.root.sizes), 1));

    const pixels = resizeSplit(layout, split, 0, -5, 0.3);
    assert.ok(near(pixels.root.sizes[0], 0.3), 'الحد المحسوب من البكسلات');

    assert.equal(resizeSplit(layout, split, 1, 0.1), layout, 'لا فاصل بعد آخر ابن');
    assert.equal(resizeSplit(layout, 'nope', 0, 0.1), layout);
});

/* ====================  فتح سجل من لوحة أخرى  ==================== */

test('رابط من لوحة يُفتح بجانبها، وفي آخر مجموعة أخرى مستخدمة لو وجدت', () => {
    let { layout, inbox, conv, ticket } = threeTabs();
    assert.deepEqual(targetForOpenFrom(layout, conv), { group: groupsOf(layout)[0].id, edge: 'end' });

    layout = splitPanel(layout, ticket, 'end');        // [inbox, conv] | [ticket]
    layout = splitPanel(layout, inbox, 'bottom');      // ([conv] / [inbox]) | [ticket]
    const [convGroup, inboxGroup, ticketGroup] = groupsOf(layout);
    assert.deepEqual(convGroup.tabs, [conv]);
    const t = targetForOpenFrom(layout, conv, [convGroup.id, ticketGroup.id, inboxGroup.id]);
    assert.deepEqual(t, { group: ticketGroup.id, edge: null }, 'لا يغطي المصدر');
});

/* ====================  الحفظ والاستعادة  ==================== */

test('الحفظ ثم الاستعادة يعيدان نفس الشجرة المتداخلة واللوحات والمفاتيح', () => {
    let { layout, conv, ticket } = threeTabs();
    layout = splitPanel(layout, conv, 'end');
    layout = splitPanel(layout, ticket, 'bottom');
    layout = resizeSplit(layout, layout.root.id, 0, 0.15);

    const saved = JSON.parse(JSON.stringify(serializeLayout(layout)));
    for (const p of Object.values(saved.panels)) assert.ok(!('key' in p), 'المفتاح لا يُحفظ');
    const restored = parseLayout(saved, { validatePanel });
    assert.deepEqual(restored, layout);
});

test('الحفظ لا يحمل إلا البنية والأنواع والمعرّفات', () => {
    const { layout, conv } = threeTabs();
    layout.panels[conv].title = 'أحمد محمد'; // لو تسرّب عنوان للحالة لا يصل للحفظ
    const text = JSON.stringify(serializeLayout(layout));
    assert.ok(!text.includes('أحمد'));
    assert.deepEqual(Object.keys(serializeLayout(layout)).sort(), ['activeGroup', 'panels', 'root', 'seq', 'version']);
});

test('ترتيب معطوب البنية يُرفض كله', () => {
    const { layout } = threeTabs();
    const good = serializeLayout(layout);
    const bad = [
        null, 'x', [], { ...good, version: 2 },
        { ...good, root: { kind: 'weird', id: 'g1' } },
        { ...good, root: { kind: 'split', id: 's1', dir: 'diagonal', children: [], sizes: [] } },
        { ...good, root: { kind: 'split', id: 's1', dir: 'row', children: [good.root, good.root], sizes: [1, 1] } }, // معرّف مكرر
        { ...good, root: { kind: 'split', id: 's1', dir: 'row', children: [good.root, { ...good.root, id: 'g9' }], sizes: [1, -1] } },
        { ...good, root: { ...good.root, id: '../x' } },
        { ...good, panels: [] }
    ];
    for (const raw of bad) assert.equal(parseLayout(raw, { validatePanel }), null, JSON.stringify(raw)?.slice(0, 80));

    // عمق زائد
    let deep = { kind: 'group', id: 'g1', tabs: ['p1'], active: 'p1' };
    for (let i = 0; i < LIMITS.maxDepth + 1; i++) {
        deep = { kind: 'split', id: `s${i + 10}`, dir: i % 2 ? 'row' : 'column', sizes: [1, 1],
            children: [deep, { kind: 'group', id: `g${i + 20}`, tabs: [], active: null }] };
    }
    assert.equal(parseLayout({ ...good, root: deep }, { validatePanel }), null);
});

test('اللوحة غير الصالحة تُسقط وحدها ويبقى الباقي', () => {
    const { layout, inbox, conv, ticket } = threeTabs();
    const raw = serializeLayout(layout);
    raw.panels[conv].params.sessionId = "x' or 1=1 --";
    raw.panels[ticket].type = 'removedModule';
    raw.panels.p9 = { id: 'p9', type: 'inbox', params: {} }; // مفتاح مكرر مع الصندوق، وغير مشار إليه
    raw.panels[inbox].params.impersonate = 'someone';
    const restored = parseLayout(raw, { validatePanel });
    assert.deepEqual(Object.keys(restored.panels), [inbox]);
    assert.deepEqual(restored.panels[inbox].params, {}, 'الحقل الغريب لا يُنسخ');
    assert.deepEqual(restored.root.tabs, [inbox]);
});

test('الاستعادة لا تنسخ مفاتيح غريبة ولا تلوّث النموذج الأولي', () => {
    const { layout } = threeTabs();
    const text = JSON.stringify(serializeLayout(layout)).replace('"version":1', '"version":1,"__proto__":{"polluted":true},"extra":1');
    const restored = parseLayout(JSON.parse(text), { validatePanel });
    assert.ok(restored);
    assert.equal({}.polluted, undefined);
    assert.ok(!('extra' in restored));
});

test('ترتيب فارغ محفوظ يُستعاد فارغًا، وseq لا يرجع لمعرّف مستخدم', () => {
    assert.deepEqual(parseLayout({ version: 1, root: null, panels: {}, activeGroup: null, seq: 0 }), createLayout());
    const { layout } = threeTabs();
    const raw = serializeLayout(layout);
    raw.seq = 1;
    const restored = parseLayout(raw, { validatePanel });
    const r = open(restored, 'customer', { customerId: C1 });
    assert.ok(!(r.panelId in layout.panels), 'معرّف جديد لا يصطدم بالقديم');
});

/* ====================  سجل اللوحات  ==================== */

test('السجل: الروابط تُبنى من قالب ثابت ومعرّف UUID فقط', () => {
    assert.equal(panelUrl({ type: 'conversation', params: { sessionId: S1 } }),
        `/admin/inbox.html?embed=1&view=thread&session=${S1}`);
    assert.equal(panelUrl({ type: 'ticket', params: { ticketId: T1 } }),
        `/admin/tickets.html?embed=1&view=ticket&ticket_id=${T1}`);
    assert.equal(panelUrl({ type: 'customer', params: { customerId: C1 } }),
        `/customer-history.html?embed=1&view=customer&customer_id=${C1}`);
    assert.equal(panelUrl({ type: 'inbox', params: { impersonate: 'x' } }), '/admin/inbox.html?embed=1');
    assert.equal(panelUrl({ type: 'ticket', params: { ticketId: `${T1}&impersonate=x` } }), null);
    assert.equal(panelUrl({ type: 'javascript', params: {} }), null);
    assert.equal(panelUrl({ type: 'constructor', params: {} }), null, 'لا أنواع من النموذج الأولي');
    assert.equal(recordId({ type: 'ticket', params: { ticketId: T1 } }), T1);
    assert.ok(UUID_RE.test(S2));
});

test('السجل: روابط الصفحات المعروفة تتحول إلى لوحات، وغيرها يبقى رابطًا', () => {
    const origin = 'https://mad3oom.com';
    assert.deepEqual(panelFromUrl(`/customer-history.html?customer_id=${C1}`, origin), { type: 'customer', params: { customerId: C1 } });
    assert.deepEqual(panelFromUrl(`/admin/tickets.html?ticket_id=${T1.toUpperCase()}`, origin), { type: 'ticket', params: { ticketId: T1 } });
    assert.deepEqual(panelFromUrl(`${origin}/admin/inbox.html?session_id=${S1}`, origin), { type: 'conversation', params: { sessionId: S1 } });
    assert.deepEqual(panelFromUrl('/admin/tickets.html', origin), { type: 'tickets', params: {} });
    assert.deepEqual(panelFromUrl('/admin/tickets.html?ticket_id=nope', origin), { type: 'tickets', params: {} });
    assert.equal(panelFromUrl(`https://evil.example/customer-history.html?customer_id=${C1}`, origin), null);
    assert.equal(panelFromUrl('/admin/users.html', origin), null);
    assert.equal(panelFromUrl('javascript:alert(1)', origin), null);
});

test('السجل: الأنواع تظهر للطاقم فقط (عرض)', () => {
    for (const role of ['admin', 'support', 'platform_owner']) assert.ok(isPanelAllowed('conversation', role));
    for (const role of ['user', 'super_user', 'company_owner', undefined]) assert.ok(!isPanelAllowed('conversation', role));
    assert.ok(!isPanelAllowed('nope', 'admin'));
});
