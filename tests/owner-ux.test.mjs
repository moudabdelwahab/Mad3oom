/**
 * اختبارات إصلاحات تسهيل استخدام لوحة المالك (المرحلة ج).
 *
 * ما تحرسه هذه الاختبارات:
 *
 *  • focusSelectorFor (owner-workspace.js): محدِّد إعادة العثور على زرّ بعد
 *    إعادة رسم لوحته، لإعادة التركيز إليه بدل أن يسقط إلى أول الصفحة.
 *    يُستبعد `on` (تنقلب قيمته بعد التبديل) و`critical` (بلا قيمة)، فلا
 *    يطابقا الزر الجديد؛ وتُهرَّب القيم لصلاحية المحدِّد.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { focusSelectorFor } from '../assets/js/owner/owner-workspace.js';

test('محدِّد من مفتاح واحد', () => {
    assert.equal(
        focusSelectorFor({ switch: 'company_isolation_enforced' }),
        '[data-switch="company_isolation_enforced"]');
});

test('مفاتيح عدة تُجمع في محدِّد واحد', () => {
    assert.equal(
        focusSelectorFor({ access: 'r1', approve: 'true' }),
        '[data-access="r1"][data-approve="true"]');
});

test('يُستبعد on (تنقلب بعد التبديل) وcritical (بلا قيمة)', () => {
    assert.equal(
        focusSelectorFor({ switch: 'company_isolation_enforced', on: 'true', critical: '' }),
        '[data-switch="company_isolation_enforced"]');
});

test('camelCase في dataset يصير kebab-case في الخاصية', () => {
    assert.equal(
        focusSelectorFor({ reviewSave: 'u1', docReview: 'v9' }),
        '[data-review-save="u1"][data-doc-review="v9"]');
});

test('القيم تُهرَّب فلا تكسر المحدِّد', () => {
    assert.equal(
        focusSelectorFor({ docReview: 'a"b\\c' }),
        '[data-doc-review="a\\"b\\\\c"]');
});

test('بلا مفاتيح مميِّزة ⇒ null (لا محاولة تركيز)', () => {
    assert.equal(focusSelectorFor({}), null);
    assert.equal(focusSelectorFor({ on: 'true', critical: '' }), null);
    assert.equal(focusSelectorFor(null), null);
    assert.equal(focusSelectorFor(undefined), null);
});

test('القيم الفارغة تُستبعد', () => {
    assert.equal(focusSelectorFor({ access: '', approve: 'false' }), '[data-approve="false"]');
});
