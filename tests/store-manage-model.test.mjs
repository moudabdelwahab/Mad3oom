// ============================================================================
// 120 — نموذج «إدارة المتجر»: ما تبنيه نماذج الواجهة يقبله تحقق الخادم نفسه (shopify-admin.js)،
// والنصوص لا تدّعي ما لم يؤكده Shopify.
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../assets/js/company/store-manage-model.js';
import * as A from '../supabase/functions/_shared/integrations/shopify-admin.js';
import { G } from './fixtures/shopify/admin-fixtures.mjs';
import * as SM from '../assets/js/company/store-model.js';
import * as S from '../supabase/functions/_shared/integrations/shopify.js';

const NOW = Date.parse('2026-10-28T10:00:00Z');
const ADDR = { first_name: 'سارة', address1: '1 شارع النيل', city: 'القاهرة', country_code: 'eg' };
/** قيم كما يملؤها المستخدم + سياق السجل المفتوح. */
const CASES = {
    'product.create': [{ title: 'قميص كتان', description_html: '<p>ناعم</p>', tags: 'صيفي، كتان', options: 'المقاس: S، M\nاللون: أبيض' }, {}],
    'product.update': [{ title: 'قميص', tags: '' }, { id: G.product }],
    'product.set_status': [{ status: 'ACTIVE' }, { id: G.product }],
    'product.archive': [{}, { id: G.product }],
    'product.delete': [{}, { id: G.product }],
    'product.publish': [{ publication_ids: [G.publication] }, { id: G.product }],
    'product.unpublish': [{ publication_ids: [G.publication] }, { id: G.product }],
    'product.set_collections': [{ join: '601, 602', leave: '' }, { id: G.product }],
    'variant.create': [{ option1_name: 'المقاس', option1_value: 'L', price: '120', compare_at_price: '150', sku: 'SH-L', tracked: true }, { product_id: G.product }],
    'variant.update': [{ price: '99.5', clear_compare: true, tracked: 'no', inventory_policy: 'DENY' }, { product_id: G.product, variant_id: G.variant }],
    'variant.delete': [{}, { product_id: G.product, variant_id: G.variant }],
    'metafield.set': [{ namespace: 'custom', key: 'care', type: 'single_line_text_field', value: 'غسيل يدوي' }, { owner_id: G.product }],
    'collection.create': [{ title: 'الصيف', sort_order: 'MANUAL' }, {}],
    'collection.update': [{ title: 'الصيف 26', sort_order: '' }, { id: G.collection }],
    'collection.delete': [{}, { id: G.collection }],
    'order.update_notes': [{ note: 'اتصل قبل التسليم', tags: 'vip' }, { id: G.order }],
    'order.update_contact': [{ email: 'Sara@Example.com', ...ADDR }, { id: G.order }],
    'order.create': [{ lines: '201 × 2\ngid://shopify/ProductVariant/202 x 1', customer_id: '555', ...ADDR, test: true, inventory: 'DECREMENT_OBEYING_POLICY' }, {}],
    'order.cancel': [{ reason: 'CUSTOMER', restock: true }, { id: G.order }],
    'draft_order.create': [{ lines: '201 × 1', discount_percent: '5', discount_title: 'وفاء' }, {}],
    'draft_order.update': [{ note: 'محدّث', lines: '201 × 3' }, { id: G.draft }],
    'draft_order.delete': [{}, { id: G.draft }],
    'customer.create': [{ first_name: 'سارة', email: 'sara@example.com', phone: '+201001234567', tags: 'vip' }, {}],
    'customer.update': [{ note: 'تفضّل واتساب' }, { id: G.customer }],
    'inventory.adjust': [{ name: 'available', reason: 'damaged', delta: '-2', expected_quantity: '10' }, { inventory_item_id: G.item, location_id: G.location }],
    'inventory.set': [{ name: 'on_hand', reason: 'cycle_count_available', quantity: '12', expected_quantity: '11' }, { inventory_item_id: G.item, location_id: G.location }],
    'inventory.activate': [{ location_id: G.location2, available: '5' }, { inventory_item_id: G.item }],
    'discount.code_create': [{ title: 'شتاء 10', code: 'winter10', value_type: 'percentage', amount: '10', items: 'all', starts_at: '2026-11-01T00:00',
                               ends_at: '2026-12-01T00:00', usage_limit: '100', once_per_customer: true, minimum_type: 'subtotal', minimum_value: '200', combine_shipping: true }, {}],
    'discount.code_update': [{ usage_limit: '200', ends_at: '2026-12-15T00:00', once_per_customer: '' }, { id: G.codeDiscount }],
    'discount.automatic_create': [{ title: 'تلقائي', value_type: 'fixed_amount', amount: '25', items: 'collections', item_ids: '601', starts_at: '2026-11-01T00:00', minimum_type: 'none' }, {}],
    'discount.automatic_update': [{ title: 'تلقائي 25' }, { id: G.autoDiscount }],
    'discount.activate': [{}, { type: 'code', id: G.codeDiscount }],
    'discount.deactivate': [{}, { type: 'automatic', id: G.autoDiscount }],
    'discount.delete': [{}, { type: 'code', id: G.codeDiscount }],
    'fulfillment.create': [{ quantities: { [G.foLine]: '2' }, company: 'Aramex', number: 'TRK123', url: 'https://track.example/TRK123' }, { order_id: G.order, fulfillment_order_id: G.fo }],
    'fulfillment.tracking_update': [{ number: 'DHL999' }, { fulfillment_id: G.fulfillment }],
    'return.create': [{ quantities: { [G.fli]: '1' }, note: 'مقاس صغير' }, { order_id: G.order }],
    'return.approve': [{}, { id: G.ret }],
    'return.decline': [{ reason: 'FINAL_SALE' }, { id: G.ret }],
    'return.cancel': [{}, { id: G.ret }],
    'return.close': [{}, { id: G.ret }]
};

test('every write operation has a form, and what the form builds passes the server validator unchanged', () => {
    const writes = A.OPERATION_KEYS.filter((k) => A.OPERATIONS[k].risk !== 'read');
    assert.deepEqual(Object.keys(M.FORMS).sort(), writes);
    assert.deepEqual(Object.keys(CASES).sort(), writes);
    for (const op of writes) {
        const [values, ctx] = CASES[op];
        assert.deepEqual(M.formErrors(op, values), {}, `${op}: client-side errors`);
        const input = M.FORMS[op].build(values, ctx);
        assert.doesNotThrow(() => A.validateOperation(op, input, { nowMs: NOW }), (e) => `${op}: ${e?.field}`);
        assert.ok(!('company_id' in input) && !('connection_id' in input), op);
        assert.ok(M.OP_LABELS[op], `${op}: label`);
        if (A.OPERATIONS[op].confirm) assert.ok(M.CONSEQUENCES[op], `${op}: the confirmation says what happens`);
    }
});

test('forms: required fields and number formats are checked before sending; prices never come from the order form', () => {
    assert.deepEqual(M.formErrors('inventory.adjust', { reason: 'damaged', delta: '', expected_quantity: '' }), { delta: 'مطلوب', expected_quantity: 'مطلوب' });
    assert.equal(M.formErrors('variant.create', { option1_name: 'x', option1_value: 'y', price: '1,5' }).price, 'رقم موجب بحد أقصى 4 خانات عشرية');
    assert.equal(M.formErrors('order.create', { lines: '201' }).lines, undefined, 'quantity defaults to 1');
    assert.equal(M.formErrors('order.create', { lines: 'abc' }).lines, 'كل سطر: معرّف المتغير × الكمية');
    assert.ok(!M.FORMS['order.create'].fields.some((f) => /price/.test(f.name)), 'no price field when creating an order');
    assert.ok(!M.FORMS['draft_order.create'].fields.some((f) => /price/.test(f.name)));
    assert.equal(M.FORMS['order.create'].build({ lines: '201 x 2' }).send_receipt, undefined, 'no receipt unless ticked');
    assert.equal(M.FORMS['order.cancel'].build({ reason: 'CUSTOMER' }, { id: G.order }).notify_customer, false, 'no customer message unless ticked');
    assert.deepEqual(M.parseLines('201 × 2\n 202x3 \n\ngid://shopify/ProductVariant/9'), [{ variant_id: '201', quantity: 2 }, { variant_id: '202', quantity: 3 },
                                                                                       { variant_id: 'gid://shopify/ProductVariant/9', quantity: 1 }]);
    assert.deepEqual(M.parseOptions('المقاس: S، M\nاللون:أبيض'), [{ name: 'المقاس', values: ['S', 'M'] }, { name: 'اللون', values: ['أبيض'] }]);
});

test('server field → form field mapping highlights the right input', () => {
    assert.equal(M.formFieldFor('variant.update', 'variants.0.price'), 'price');
    assert.equal(M.formFieldFor('variant.update', 'variants.0.compare_at_price'), 'compare_at_price');
    assert.equal(M.formFieldFor('order.update_contact', 'shipping_address.city'), 'city');
    assert.equal(M.formFieldFor('inventory.adjust', 'changes.0.expected_quantity'), 'expected_quantity');
    assert.equal(M.formFieldFor('order.create', 'lines.1.variant_id'), 'lines');
    assert.equal(M.formFieldFor('product.create', 'nonsense'), null);
});

test('payment label: «paid» only when Shopify confirms PAID and fully paid; otherwise Shopify’s status, marked as such', () => {
    assert.equal(M.paymentLabel({ paid_confirmed: true }).text, 'مدفوع (أكّده Shopify)');
    for (const p of [{ financial_status: 'PAID', fully_paid: false }, { financial_status: 'PENDING' }, { financial_status: 'AUTHORIZED' },
                     { financial_status: 'PARTIALLY_PAID' }, {}, null]) {
        const t = M.paymentLabel(p).text;
        assert.notEqual(t, 'مدفوع (أكّده Shopify)', JSON.stringify(p));
        assert.equal(M.paymentLabel(p).tone, 'warning');
    }
    assert.match(M.paymentLabel({ financial_status: 'PAID' }).text, /دون تأكيد/);
    assert.match(M.paymentLabel({ financial_status: 'PENDING' }).text, /بانتظار الدفع \(حسب Shopify\)/);
});

test('availability: hidden without permission, disabled (with the missing scopes) without a Shopify scope, nothing when disabled', () => {
    const status = { enabled: true, ops: [
        { key: 'product.list', permitted: true, missing_scopes: [], risk: 'read', confirm: false },
        { key: 'product.delete', permitted: true, missing_scopes: ['write_products'], risk: 'destructive', confirm: true },
        { key: 'order.cancel', permitted: false, missing_scopes: [], risk: 'destructive', confirm: true }] };
    assert.deepEqual(M.opAvailability(status, 'product.list'), { visible: true, enabled: true, reason: null, confirm: false, risk: 'read' });
    assert.deepEqual(M.opAvailability(status, 'product.delete'), { visible: true, enabled: false, reason: 'missing_scope', scopes: ['write_products'] });
    assert.equal(M.opAvailability(status, 'order.cancel').visible, false);
    assert.equal(M.opAvailability({ ...status, enabled: false }, 'product.list').visible, false);
    assert.equal(M.sectionVisible(status, M.MANAGE_SECTIONS.find((s) => s.key === 'log'), 'agent'), false);
    assert.equal(M.sectionVisible(status, M.MANAGE_SECTIONS.find((s) => s.key === 'log'), 'admin'), true);
    assert.equal(M.isDestructive(status, 'product.delete'), true);
});

test('error texts: never imply a refund or completion; unknown outcome says to check Shopify', () => {
    assert.match(M.manageErrorText({ error: 'not_eligible', reason: 'cancel_requires_refund_review' }), /لا يرد المال/);
    assert.match(M.manageErrorText({ error: 'timeout', outcome: 'unknown' }), /قد تكون العملية نُفّذت/);
    assert.match(M.manageErrorText({ error: 'provider_rejected', user_errors: [{ field: 'product.title' }] }, () => 'اسم المنتج'), /اسم المنتج/);
    assert.match(M.manageErrorText({ error: 'rate_limited', retry_after: 7 }), /7 ثانية/);
    assert.match(M.manageErrorText({ error: 'missing_scope' }), /أعد التفويض/);
    assert.match(M.manageErrorText({ error: 'invalid_input', field: 'changes.0.location_id' }), /قيمة غير صالحة/);
    assert.match(M.eligibilityText('changes.0.location_id'), /غير مخزّن/);
    for (const v of Object.values(M.CONSEQUENCES)) assert.doesNotMatch(v, /يُسترد المبلغ|تم الدفع|مدفوع/);
});

test('preview: inventory shows current vs. what the user saw and warns when stale; order lines show Shopify’s prices', () => {
    const inv = M.previewView('inventory.adjust', { name: 'available', reason: 'damaged', changes: [{ location_name: 'Main', current: 7, expected: 10, stale: true, delta: -2, after: 5 }] });
    assert.deepEqual(inv.tables[0].rows[0], ['Main', '7', '10 ⚠ تغيّر', '5']);
    assert.match(inv.tables[0].warn, /سيرفض Shopify/);
    assert.ok(inv.rows.some((r) => r.label === 'السبب' && r.value === 'تالف'));
    const order = M.previewView('order.create', { currency: 'EGP', lines: [{ title: 'قميص', variant_title: 'M', quantity: 2, unit_price: '100.00' }],
                                                   subtotal_before_tax_shipping: '200', financial_status: 'PENDING', receipt: false, test: true });
    assert.deepEqual(order.tables[0].rows[0], ['قميص — M', '2', '100.00']);
    assert.ok(order.rows.some((r) => r.label === 'حالة الدفع في Shopify' && r.value === 'PENDING'));
    const cancel = M.previewView('order.cancel', { name: '#1001', refund: false, restock: true, total: { amount: '200.00', currency: 'EGP' } });
    assert.ok(cancel.rows.some((r) => r.label === 'استرداد مالي' && r.value === 'لا'));
});

test('upgrade path: the browser management scope list equals the server list, and write_x covers read_x', () => {
    assert.deepEqual([...SM.MANAGEMENT_SCOPES], [...S.MANAGEMENT_SCOPES]);
    assert.deepEqual(SM.missingManagementScopes(S.REQUESTED_SCOPES), []);
    assert.deepEqual(SM.missingManagementScopes(S.MANAGEMENT_SCOPES.filter((x) => x.startsWith('write_')).concat(['read_locations'])), [],
                     'Shopify may return only write scopes after approval');
    assert.equal(SM.missingManagementScopes(S.SHOPIFY_SCOPES).length, 16, 'a read-only connection lacks every management scope');
    assert.doesNotMatch(SM.MANAGEMENT_SCOPE_SUMMARY, /مدفوع|استرداد مبلغ/);
});
