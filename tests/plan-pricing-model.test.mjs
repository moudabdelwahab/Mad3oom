import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SALE_PLAN_KEYS, PLAN_LABELS, formatMoney, discountPercent, yearlySavingPercent,
    walletView, resetText, cycleProgress
} from '../assets/js/plan-pricing-model.js';

test('الخطط المعروضة للبيع: المتقدمة والفائقة فقط (الواتساب مخفي)', () => {
    assert.deepEqual(SALE_PLAN_KEYS, ['support', 'ultimate']);
    assert.equal(PLAN_LABELS.support, 'الخطة المتقدمة');
    assert.equal(PLAN_LABELS.ultimate, 'الخطة الفائقة');
});

test('تنسيق المبالغ بالجنيه والدولار', () => {
    assert.equal(formatMoney(999, 'EGP'), '999 ج.م');
    assert.equal(formatMoney(19999, 'EGP'), '19,999 ج.م');
    assert.equal(formatMoney(12.5, 'EGP'), '12.5 ج.م');
    assert.equal(formatMoney(20, 'USD'), '$20');
    assert.equal(formatMoney(null), '—');
});

test('الخصومات', () => {
    assert.equal(discountPercent(1849, 999), 46);
    assert.equal(discountPercent(999, 999), null);
    assert.equal(yearlySavingPercent(999, 9999), 17);
    assert.equal(yearlySavingPercent(1999, 19999), 17);
});

const NOW = new Date('2026-10-05T10:00:00Z');
test('محفظة المجانية', () => {
    const v = walletView({ plan_key: 'free', plan_name_ar: 'الخطة المجانية', is_free: true, unlimited: false, monthly_limit: 20, used: 17, remaining: 3, resets_at: '2026-10-31T22:00:00Z' }, NOW);
    assert.equal(v.headline, 'متبقي 3 من 20 تذكرة');
    assert.equal(v.percent, 85);
    assert.equal(v.tone, 'warn');
    assert.equal(v.daysToReset, 27);
});

test('محفظة نفد رصيدها', () => {
    const v = walletView({ plan_key: 'free', unlimited: false, monthly_limit: 20, used: 20, remaining: 0 }, NOW);
    assert.equal(v.tone, 'empty');
    assert.match(v.sub, /نفد رصيد/);
});

test('محفظة بلا حد', () => {
    const v = walletView({ plan_key: 'ultimate', plan_name_ar: 'الخطة الفائقة', unlimited: true, monthly_limit: null, used: 140, remaining: null }, NOW);
    assert.equal(v.headline, 'تذاكر غير محدودة');
    assert.equal(v.remaining, null);
    assert.equal(v.tone, 'ok');
    assert.equal(walletView(null), null);
});

test('نص التجديد ومدة الدورة', () => {
    assert.equal(resetText(0), 'يتجدد الرصيد اليوم');
    assert.equal(resetText(1), 'يتجدد الرصيد بكرة');
    assert.equal(resetText(5), 'يتجدد الرصيد خلال 5 أيام');
    assert.equal(resetText(26), 'يتجدد الرصيد خلال 26 يوم');
    const p = cycleProgress('2026-10-01T00:00:00Z', '2026-10-31T00:00:00Z', NOW);
    assert.equal(p.totalDays, 30);
    assert.equal(p.daysLeft, 26);
});

import { planFeatureRows, nextPlanKey, subscriptionStatus } from '../assets/js/plan-pricing-model.js';

test('مزايا كل خطة', () => {
    const free = planFeatureRows('free');
    assert.equal(free[0].value, '20 تذكرة');
    assert.equal(free.find(r => r.label === 'نطاق فرعي مجاني').included, false);
    assert.ok(!free.some(r => r.label === 'واتساب بيزنس'), 'الواتساب مش بيظهر لغير المشتركين فيه');
    assert.equal(planFeatureRows('support')[0].value, '300 تذكرة');
    assert.equal(planFeatureRows('ultimate')[0].value, 'غير محدودة');
    assert.ok(planFeatureRows('bundle').some(r => r.label === 'واتساب بيزنس' && r.included));
    assert.equal(planFeatureRows('unknown')[0].value, '20 تذكرة');
});

test('الخطة التالية للترقية', () => {
    assert.equal(nextPlanKey('free'), 'support');
    assert.equal(nextPlanKey('support'), 'ultimate');
    assert.equal(nextPlanKey('ultimate'), null);
});

test('حالة الاشتراك', () => {
    const now = new Date('2026-10-05T10:00:00Z');
    assert.equal(subscriptionStatus(null).label, 'مجاني');
    assert.equal(subscriptionStatus({ status: 'active', end_date: '2026-11-01T00:00:00Z' }, now).label, 'نشط');
    assert.equal(subscriptionStatus({ status: 'active', end_date: '2026-10-08T00:00:00Z' }, now).label, 'ينتهي خلال 3 أيام');
    assert.equal(subscriptionStatus({ status: 'active', end_date: '2026-10-06T00:00:00Z' }, now).label, 'ينتهي خلال يوم');
    assert.equal(subscriptionStatus({ status: 'pending' }, now).label, 'قيد المراجعة');
});
