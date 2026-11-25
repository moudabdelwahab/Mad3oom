/**
 * إصلاحات لوحة المتاجر (135) — منطق خالص بلا DOM ولا شبكة:
 *   ① مسار حفظ سعر الباقة 500/5000 (storePlanPriceArgs + storePriceError)
 *   ② إلغاء تفعيل الباقة (storePlanPriceArgs مع p_deactivate)
 *   ③ أساس حساب الانتهاء عند الاستئناف (storeResumeBasis)
 *   ④ تحذير تعطيل المزايا في نموذج الحصة (storeQuotaDisableWarning)
 *   ⑤ باقة السعر من إعداد الباقة لا من التشخيص (storePlanFromConfig)
 * المنطق الخادمي (SQL) موثَّق في tests/sql/owner-stores-135.test.sql.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    storePriceError, storePlanPriceArgs, storePlanFromConfig,
    storeQuotaDisableWarning, storeResumeBasis
} from '../assets/js/owner/owner-labels.js';

// ── ① حفظ سعر الباقة 500/5000 ──────────────────────────────────────────
test('① السعر المعتمد 500/5000 يمرّ التحقق ويُرسل كما هو بلا حقول زائدة', () => {
    assert.equal(storePriceError({ monthly: 500, yearly: 5000 }), null);
    assert.equal(storePriceError({ monthly: '500', yearly: '5000' }), null);
    assert.deepEqual(storePlanPriceArgs({ monthly: '500', yearly: '5000' }).args,
        { p_monthly: 500, p_yearly: 5000, p_activate: false });
    assert.deepEqual(storePlanPriceArgs({ monthly: 500, yearly: 5000, activate: true }).args,
        { p_monthly: 500, p_yearly: 5000, p_activate: true });
});

test('① سعر غير موجب أو غير رقمي يرفض قبل النداء', () => {
    assert.match(storePlanPriceArgs({ monthly: 0, yearly: 5000 }).error, /الشهري/);
    assert.match(storePlanPriceArgs({ monthly: 500, yearly: '' }).error, /السنوي/);
    assert.match(storePlanPriceArgs({ monthly: 'abc', yearly: 5000 }).error, /الشهري/);
    assert.match(storePlanPriceArgs({ monthly: null, yearly: 5000 }).error, /الشهري/);
});

// ── ② إلغاء تفعيل الباقة ─────────────────────────────────────────────
test('② الإلغاء يرسل الأسعار المحفوظة مع p_deactivate ولا يغيّرها', () => {
    assert.deepEqual(storePlanPriceArgs({ monthly: 500, yearly: 5000, deactivate: true, reason: 'إلغاء تفعيل الباقة للاختبار' }).args,
        { p_monthly: 500, p_yearly: 5000, p_activate: false, p_deactivate: true, p_reason: 'إلغاء تفعيل الباقة للاختبار' });
});

test('② الإلغاء بلا أسعار محفوظة يرسل null (إبقاء الحالي) بلا سبب زائد', () => {
    assert.deepEqual(storePlanPriceArgs({ monthly: null, yearly: null, deactivate: true }).args,
        { p_monthly: null, p_yearly: null, p_activate: false, p_deactivate: true });
});

test('② الإلغاء بسعر مرسل غير موجب يرفض، والتفعيل مع الإلغاء مرفوضان', () => {
    assert.match(storePlanPriceArgs({ monthly: 0, yearly: 5000, deactivate: true }).error, /موجبان/);
    assert.match(storePlanPriceArgs({ monthly: -5, yearly: null, deactivate: true }).error, /موجبان/);
    assert.match(storePlanPriceArgs({ monthly: 500, yearly: 5000, activate: true, deactivate: true }).error, /معًا/);
});

// ── ⑤ باقة السعر من إعداد الباقة ──────────────────────────────────────
test('⑤ إعداد الباقة يبني نموذج السعر: التفعيل والسعران والمزايا المفعّلة فقط', () => {
    assert.equal(storePlanFromConfig(null), null);
    assert.equal(storePlanFromConfig(undefined), null);
    assert.deepEqual(storePlanFromConfig({}), {
        key: 'store', is_active: null, price_monthly: null, price_yearly: null, currency: 'EGP',
        features: [], ticket_quota_defined: false
    });
    assert.deepEqual(storePlanFromConfig({
        is_active: true, price_monthly: 500, price_yearly: 5000, currency: 'EGP', quota_defined: true,
        features: [
            { feature_key: 'shopify_integration', enabled: true },
            { feature_key: 'store_support', enabled: false },
            { feature_key: 'integrations_hub', enabled: true }]
    }), {
        key: 'store', is_active: true, price_monthly: 500, price_yearly: 5000, currency: 'EGP',
        features: ['shopify_integration', 'integrations_hub'], ticket_quota_defined: true
    });
});

// ── ④ تحذير تعطيل المزايا ────────────────────────────────────────────
test('④ لا تغيير أو تعطيل ميزة عادية وحدها: بلا تحذير', () => {
    const current = ['integrations_hub', 'shopify_integration', 'store_support'];
    assert.equal(storeQuotaDisableWarning({ currentFeatures: current, selectedFeatures: current }), null);
    assert.equal(storeQuotaDisableWarning({ currentFeatures: current, selectedFeatures: ['integrations_hub', 'shopify_integration'] }), null);
    assert.equal(storeQuotaDisableWarning({ currentFeatures: [], selectedFeatures: [] }), null);
});

test('④ تعطيل shopify_integration يستدعي التحذير ويسمّي ما سيُعطَّل', () => {
    const w = storeQuotaDisableWarning({
        currentFeatures: ['integrations_hub', 'shopify_integration'],
        selectedFeatures: ['integrations_hub']
    });
    assert.deepEqual(w.disabling, ['shopify_integration']);
    assert.equal(w.disablesShopify, true);
    assert.equal(w.disablesAll, false);
});

test('④ إلغاء كل المزايا يستدعي التحذير حتى بلا شوبيفاي', () => {
    const w = storeQuotaDisableWarning({
        currentFeatures: ['integrations_hub', 'store_support'],
        selectedFeatures: []
    });
    assert.deepEqual(w.disabling, ['integrations_hub', 'store_support']);
    assert.equal(w.disablesShopify, false);
    assert.equal(w.disablesAll, true);
});

// ── ③ أساس الاستئناف ─────────────────────────────────────────────────
test('③ التاريخ اليدوي أثناء الإيقاف يفوز، ثم تحويل الدورة، ثم التمديد', () => {
    assert.equal(storeResumeBasis({ end_date_set_while_paused: true, cycle_changed_while_paused: true }), 'manual');
    assert.equal(storeResumeBasis({ end_date_set_while_paused: false, cycle_changed_while_paused: true }), 'cycle');
    assert.equal(storeResumeBasis({ end_date_set_while_paused: false, cycle_changed_while_paused: false }), 'extension');
    assert.equal(storeResumeBasis({}), 'extension');
    assert.equal(storeResumeBasis(null), 'extension');
});
