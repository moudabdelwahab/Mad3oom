// ============================================================================
// 139 — تنبيهات مخزون Shopify: دوال النموذج الخالصة + الغياب الموثّق لعمليتين.
//
// تنبيه صدق: لا شيء هنا يثبت أن Shopify الحقيقي يقبل طلبات المخزون —
// التنفيذ الفعلي يُتحقق منه على متجر تطوير. ما يثبته هذا الملف:
//   • منطق الحدود والتقييم وبناء تقرير الفحص (خالص، بلا شبكة).
//   • أن عمليات الطلبات المهملة والشحن غير موجودة فعلًا في كتالوج 120
//     ولا في موصّل shopify-admin.js — فالواجهة تعرض غيابها ولا تخترع نداءً.
//   • أن عمليات الخصومات المطلوبة (عرض/إنشاء/تعديل كود) موجودة في الكتالوج
//     والموصّل، وأن قسم «الشحن» لا يدّعي تعديل خيارات الشحن.
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import * as M from '../assets/js/company/store-manage-model.js';
import * as A from '../supabase/functions/_shared/integrations/shopify-admin.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const ITEM = 'gid://shopify/InventoryItem/111';
const ITEM_B = 'gid://shopify/InventoryItem/222';
const VARIANT = 'gid://shopify/ProductVariant/201';
const VARIANT_B = 'gid://shopify/ProductVariant/202';

const STORE_TH = { id: 't-store', scope: 'store', inventory_item_id: null, variant_id: null, product_title: null, min_quantity: 5 };
const VAR_TH = { id: 't-var', scope: 'variant', inventory_item_id: ITEM, variant_id: VARIANT, product_title: 'قميص — L', min_quantity: 3 };
const VAR_TH_B = { id: 't-var-b', scope: 'variant', inventory_item_id: ITEM_B, variant_id: VARIANT_B, product_title: 'بنطال — M', min_quantity: 10 };

/* ── التحقق من الحد ─────────────────────────────────────────────────────── */

test('حد متجر صحيح بلا أخطاء، والحد 0 (النفاد) مقبول', () => {
    assert.deepEqual(M.validateThreshold({ scope: 'store', min_quantity: '0' }), {});
    assert.deepEqual(M.validateThreshold({ scope: 'store', min_quantity: 5 }), {});
});

test('حد متغير صحيح بمعرّفي gid وعنوان', () => {
    assert.deepEqual(M.validateThreshold({
        scope: 'variant', inventory_item_id: ITEM, variant_id: VARIANT, product_title: 'قميص', min_quantity: '3'
    }), {});
});

test('نطاق غير معروف ومعرّفات غير صالحة وحد خارج المدى كلها أخطاء', () => {
    const e = M.validateThreshold({ scope: 'product', inventory_item_id: '111', variant_id: 'x', min_quantity: '-1' });
    assert.ok(e.scope && e.min_quantity);
    const e2 = M.validateThreshold({ scope: 'variant', inventory_item_id: '111', variant_id: VARIANT, min_quantity: '3' });
    assert.ok(e2.inventory_item_id && !e2.variant_id);
    const e3 = M.validateThreshold({ scope: 'variant', inventory_item_id: ITEM, variant_id: VARIANT, min_quantity: '1000000' });
    assert.ok(e3.min_quantity);
    const e4 = M.validateThreshold({ scope: 'variant', inventory_item_id: ITEM, variant_id: VARIANT, product_title: 'x'.repeat(121), min_quantity: 1 });
    assert.ok(e4.product_title);
});

/* ── الحد الفعّال ───────────────────────────────────────────────────────── */

test('حد المتغير يغلب حد المتجر، وحد المتجر بديل، وبلا حدود لا حد', () => {
    assert.equal(M.resolveThreshold([STORE_TH, VAR_TH], ITEM).min_quantity, 3);
    assert.equal(M.resolveThreshold([STORE_TH, VAR_TH], ITEM).scope, 'variant');
    assert.equal(M.resolveThreshold([STORE_TH, VAR_TH], ITEM_B).min_quantity, 5);
    assert.equal(M.resolveThreshold([STORE_TH, VAR_TH], ITEM_B).scope, 'store');
    assert.equal(M.resolveThreshold([VAR_TH], ITEM_B).min_quantity, null);
    assert.equal(M.resolveThreshold([], ITEM).min_quantity, null);
    assert.equal(M.resolveThreshold(null, ITEM).min_quantity, null);
});

/* ── المتاح والتقييم ────────────────────────────────────────────────────── */

test('المتاح مجموع المواقع، ويُتجاهل غير الصحيح، وبلا قراءة صالحة null', () => {
    assert.equal(M.availableOf([{ quantities: { available: 2 } }, { quantities: { available: 3 } }]), 5);
    assert.equal(M.availableOf([{ quantities: { available: 'x' } }, { quantities: {} }]), null);
    assert.equal(M.availableOf([]), null);
    assert.equal(M.availableOf(null), null);
});

test('التقييم: تحت الحد وفوقه وتعذّرت قراءته', () => {
    const out = M.evaluateInventoryAlerts([STORE_TH, VAR_TH, VAR_TH_B], {
        [ITEM]: [{ quantities: { available: 2 } }],
        [ITEM_B]: [{ quantities: { available: 10 } }, { quantities: { available: 1 } }]
    });
    assert.equal(out.length, 2, 'حد المتجر لا يُقيَّم بلا مسح كامل للمنتجات');
    const [a, b] = out;
    assert.equal(a.status, 'below');
    assert.equal(a.below, true);
    assert.equal(a.available, 2);
    assert.equal(b.status, 'ok');
    assert.equal(b.available, 11);
    const unknown = M.evaluateInventoryAlerts([VAR_TH], {});
    assert.equal(unknown[0].status, 'unknown');
    assert.equal(unknown[0].available, null);
});

test('الحد يساوي المتاح = فوق الحد (لا تنبيه عند المساواة)', () => {
    const [a] = M.evaluateInventoryAlerts([VAR_TH], { [ITEM]: [{ quantities: { available: 3 } }] });
    assert.equal(a.status, 'ok');
});

/* ── عناصر تقرير الفحص ─────────────────────────────────────────────────── */

test('التقرير يشمل المقروءة فقط (تحت الحد أو فوقه للحلّ) ويحمل معرّف الحد', () => {
    const evaluated = M.evaluateInventoryAlerts([VAR_TH, VAR_TH_B], {
        [ITEM]: [{ quantities: { available: 1 } }],
        [ITEM_B]: [{ quantities: { available: 12 } }]
    });
    const items = M.buildAlertReportItems([...evaluated, { threshold: VAR_TH, available: null, min_quantity: 3 }]);
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], { threshold_id: 't-var', inventory_item_id: ITEM, product_title: 'قميص — L', available: 1, min_quantity: 3 });
    assert.equal(items[1].threshold_id, 't-var-b');
});

test('عنصر تقرير حد المتجر من عرض المخزون: لحد المتجر فقط، وبقراءة صالحة', () => {
    const eff = { threshold: { id: 't-store', scope: 'store', min_quantity: 5 }, min_quantity: 5, scope: 'store' };
    assert.deepEqual(M.storeThresholdReportItem(eff, ITEM, 'قميص — L', 2),
        { threshold_id: 't-store', inventory_item_id: ITEM, product_title: 'قميص — L', available: 2, min_quantity: 5 });
    assert.deepEqual(M.storeThresholdReportItem(eff, ITEM, 'قميص — L', 9).available, 9);
    assert.equal(M.storeThresholdReportItem(eff, ITEM, 'قميص — L', null), null);
    assert.equal(M.storeThresholdReportItem(eff, ITEM, 'قميص — L', -1), null);
    assert.equal(M.storeThresholdReportItem(eff, 'bad', 'قميص — L', 2), null);
    assert.equal(M.storeThresholdReportItem({ threshold: null, min_quantity: 5, scope: 'store' }, ITEM, 'قميص — L', 2), null);
});

test('عنصر تقرير حد المتجر: حد المتغير لا يُبلَّغ من عرض المخزون', () => {
    const eff = { threshold: VAR_TH, min_quantity: 3, scope: 'variant' };
    assert.equal(M.storeThresholdReportItem(eff, ITEM, 'قميص — L', 1), null);
});

function sqlCatalogKeys() {
    const sql = read('migrations/120_shopify_store_management.sql');
    const body = sql.slice(sql.indexOf('create or replace function public._ihub_shopify_op_catalog()'), sql.indexOf('-- النطاقات الناقصة'));
    return [...body.matchAll(/\('([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]);
}

test('عمليات الطلبات المهملة والشحن غير موجودة في كتالوج 120', () => {
    const keys = sqlCatalogKeys();
    for (const missing of [...M.ABANDONED_CHECKOUTS_UNAVAILABLE.missingOps, ...M.SHIPPING_UNAVAILABLE.missingOps]) {
        assert.ok(!keys.includes(missing), `${missing} ظهر في الكتالوج`);
    }
    assert.ok(keys.includes('discount.list') && keys.includes('discount.code_create') && keys.includes('discount.code_update'),
        'عمليات الخصومات المطلوبة موجودة في الكتالوج');
});

test('عمليات الطلبات المهملة والشحن غير موجودة في موصّل shopify-admin.js', () => {
    for (const missing of [...M.ABANDONED_CHECKOUTS_UNAVAILABLE.missingOps, ...M.SHIPPING_UNAVAILABLE.missingOps]) {
        assert.ok(!A.OPERATION_KEYS.includes(missing), `${missing} ظهر في الموصّل`);
    }
    for (const op of ['discount.list', 'discount.get', 'discount.code_create', 'discount.code_update', 'discount.activate', 'discount.deactivate', 'discount.delete', 'inventory.levels']) {
        assert.ok(A.OPERATION_KEYS.includes(op), `${op} ناقص من الموصّل`);
    }
});

test('نصا الغياب يذكران العملية الغائبة صراحة ولا يعدان بما لا يوجد', () => {
    assert.match(M.ABANDONED_CHECKOUTS_UNAVAILABLE.text, /لا توجد عملية/);
    assert.match(M.ABANDONED_CHECKOUTS_UNAVAILABLE.text, /abandoned checkouts/);
    assert.match(M.ABANDONED_CHECKOUTS_UNAVAILABLE.text, /مسودات الطلبات ليست طلبات مهملة/);
    assert.match(M.SHIPPING_UNAVAILABLE.text, /لا توجد عملية/);
    assert.match(M.SHIPPING_UNAVAILABLE.text, /لوحة Shopify/);
});

test('أقسام إدارة المتجر الجديدة ظاهرة بنفس قاعدة الصلاحية (لا قسم بلا عملية قراءة)', () => {
    const keys = sqlCatalogKeys();
    for (const s of M.MANAGE_SECTIONS) {
        if (s.key === 'log') continue;
        assert.ok(keys.includes(s.read), `قسم ${s.key} بلا عملية قراءة في الكتالوج: ${s.read}`);
    }
    assert.ok(M.MANAGE_SECTIONS.some((s) => s.key === 'alerts'));
    assert.ok(M.MANAGE_SECTIONS.some((s) => s.key === 'abandoned'));
    assert.ok(M.MANAGE_SECTIONS.some((s) => s.key === 'shipping'));
});

test('تسميات الحالات والحدود عربية', () => {
    assert.equal(M.ALERT_STATUS_LABELS.below, 'وصل للحد الأدنى');
    assert.equal(M.ALERT_STATUS_LABELS.ok, 'فوق الحد');
});
