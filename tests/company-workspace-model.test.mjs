/**
 * نموذج مساحة عمل الشركة — دوال خالصة: اللوحات، الترتيب الافتراضي،
 * الحفظ والاستعادة من localStorage، وعدّ التذاكر وأحدثها.
 *
 * القاعدة: المساحة تقرأ صفوف المسارين كما هي، بلا جلب ثانٍ؛ و«مفتوحة»
 * بمعنى statusInfo نفسه لا قائمة حالات مكررة.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    WORKSPACE_PANELS, workspaceStorageKey, workspacePanelKey, validateWorkspacePanel,
    defaultWorkspaceLayout, parseWorkspaceLayout, serializeWorkspaceLayout,
    toggleWorkspaceDirection, workspaceCounts, recentTickets
} from '../assets/js/company/company-workspace-model.js';
import { groupsOf, panelOrder } from '../assets/js/admin/workspace/dock-model.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('اللوحات الثلاث معروفة، ولكلٍّ قسمها الكامل في اللوحة', () => {
    assert.deepEqual(Object.keys(WORKSPACE_PANELS), ['customerTickets', 'inbox', 'platformTickets']);
    assert.equal(WORKSPACE_PANELS.customerTickets.tab, 'customerTickets');
    assert.equal(WORKSPACE_PANELS.inbox.tab, 'inbox');
    assert.equal(WORKSPACE_PANELS.platformTickets.tab, 'tickets');
});

test('الترتيب الافتراضي: تذاكر العملاء بجانب صندوق الرسائل، بلا تكرار', () => {
    const layout = defaultWorkspaceLayout();
    assert.equal(layout.root.kind, 'split');
    assert.equal(layout.root.dir, 'row');
    assert.equal(groupsOf(layout).length, 2);
    assert.deepEqual(panelOrder(layout).map(id => layout.panels[id].type),
        ['customerTickets', 'inbox']);
    // مفتاح منع التكرار: اللوحة نفسها لا تُفتح مرتين
    assert.equal(new Set(Object.values(layout.panels).map(p => p.key)).size, 2);
});

test('مفتاح الحفظ لشركة بعينها، فلا يتسرب ترتيب شركة إلى أخرى', () => {
    assert.equal(workspaceStorageKey('c-1'), 'mad3oom:company-workspace:c-1');
    assert.notEqual(workspaceStorageKey('c-1'), workspaceStorageKey('c-2'));
    assert.equal(workspacePanelKey('inbox'), 'workspace:inbox');
});

test('الحفظ والاستعادة جولة كاملة؛ والمعطوب والمجهول لا يكسر المساحة', () => {
    const raw = serializeWorkspaceLayout(defaultWorkspaceLayout());
    assert.equal(typeof raw, 'string');
    const back = parseWorkspaceLayout(raw);
    assert.deepEqual(panelOrder(back).map(id => back.panels[id].type), ['customerTickets', 'inbox']);

    assert.equal(parseWorkspaceLayout(null), null);
    assert.equal(parseWorkspaceLayout(''), null);
    assert.equal(parseWorkspaceLayout('{معطوب'), null);
    assert.equal(parseWorkspaceLayout('{"version":99,"root":null,"panels":{}}'), null, 'إصدار غير معروف');

    // لوحة بنوع أُزيل تُسقَط وحدها ويبقى الباقي
    const parsed = JSON.parse(raw);
    const extraId = 'p99';
    parsed.panels[extraId] = { id: extraId, type: 'removedPanel', params: {} };
    parsed.root.children[0].tabs.push(extraId);
    const kept = parseWorkspaceLayout(JSON.stringify(parsed));
    assert.deepEqual(panelOrder(kept).map(id => kept.panels[id].type), ['customerTickets', 'inbox']);

    assert.equal(validateWorkspacePanel('nope'), null);
    assert.equal(validateWorkspacePanel('inbox').key, 'workspace:inbox');
});

test('قلب الاتجاه: صف ↔ عمود، وبلا تقسيم جذري يبقى الترتيب كما هو', () => {
    const layout = defaultWorkspaceLayout();
    const column = toggleWorkspaceDirection(layout);
    assert.equal(column.root.dir, 'column');
    assert.equal(toggleWorkspaceDirection(column).root.dir, 'row');
    assert.equal(layout.root.dir, 'row', 'القلب لا يعدّل الترتيب الأصلي');
    const empty = { version: 1, root: null, panels: {}, activeGroup: null, seq: 0 };
    assert.equal(toggleWorkspaceDirection(empty), empty);
});

test('الأعداد من الصفوف وملخص الصندوق — «مفتوحة» بمعنى statusInfo', () => {
    const rows = [
        { id: '1', status: 'open' },
        { id: '2', status: 'in-progress' },
        { id: '3', status: 'resolved' },
        { id: '4', status: 'confirmed' }
    ];
    const c = workspaceCounts({ customerRows: rows, platformRows: [], inboxSummary: { open: 2, unread: 1 } });
    assert.equal(c.customersTotal, 4);
    assert.equal(c.customersOpen, 2, 'resolved وconfirmed مغلقتان');
    assert.equal(c.platformTotal, 0);
    assert.equal(c.inboxOpen, 2);
    assert.equal(c.inboxUnread, 1);
    assert.equal(c.inboxAvailable, true);

    const none = workspaceCounts({ customerRows: null, platformRows: undefined, inboxSummary: null });
    assert.equal(none.customersTotal, 0);
    assert.equal(none.inboxAvailable, false, 'ملخص null يعني لا صندوق لهذا الحساب');
});

test('أحدث التذاكر: الأحدث تحديثًا أولًا، وبحدّ أقصى خمس', () => {
    const rows = [
        { id: 'a', ticket_number: 1, title: 'قديمة', status: 'open', created_at: '2026-01-01T00:00:00Z', last_updated_at: '2026-01-02T00:00:00Z' },
        { id: 'b', ticket_number: 2, title: 'أحدث', status: 'resolved', created_at: '2026-01-03T00:00:00Z', last_updated_at: '2026-01-05T00:00:00Z' },
        { id: 'c', ticket_number: 3, title: 'بلا تحديث', status: 'open', created_at: '2026-01-04T00:00:00Z' }
    ];
    const recent = recentTickets(rows, 2);
    assert.deepEqual(recent.map(t => t.id), ['b', 'c']);
    assert.equal(recent[0].closed, true);
    assert.equal(recent[0].number, 2);
    assert.equal(recentTickets([], 5).length, 0);
    assert.equal(recentTickets(rows, 0).length, 0);
});

/* ── ضوابط ثابتة على وحدة العرض ─────────────────────────────────────────── */

test('وحدة العرض لا تجلب شيئًا ولا تضمّن صفحة إدارة — تقرأ ما حُمِّل فقط', () => {
    const src = read('assets/js/company/company-workspace.js');
    assert.doesNotMatch(src, /supabase\.rpc|fetch\(/, 'مساحة العمل تجلب بيانات بنفسها');
    assert.doesNotMatch(src, /<iframe[\s>]/i, 'تضمين صفحة إدارة');
    assert.doesNotMatch(src, /href\s*=\s*["']\/admin\//, 'رابط إلى لوحة الإدارة');
    assert.doesNotMatch(src, /href\s*=\s*["']\/customer-dashboard/, 'رابط إلى بوابة العميل');
    // إعادة الاستخدام الوحيدة من الإدارة: محرك الترتيب الخالص، استيرادًا لا تنقّلًا
    assert.match(src, /from '\/assets\/js\/admin\/workspace\/dock-model\.js'/);
    assert.match(src, /getCustomerRows|getPlatformRows|getInboxSummary/, 'تقرأ من المسارات لا من القاعدة');
    assert.match(src, /localStorage/, 'الترتيب في localStorage في v1');
    assert.match(src, /retry: 'workspace'/, 'الفشل له زر إعادة محاولة عبر الموجّه العام');
});
