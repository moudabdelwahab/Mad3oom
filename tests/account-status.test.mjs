/**
 * «الحساب مقيّد» — الواجهة تطابق is_banned() في القاعدة حرفيًا.
 *
 * العيب الذي يحرسه هذا الاختبار: القائمة الجانبية كانت تعتبر كل ما ليس
 * 'active' مقيّدًا، و'none' هي القيمة الافتراضية لكل الحسابات على الإنتاج —
 * فظهرت شارة «الحساب مقيّد» لكل عميل سليم.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isAccountRestricted, accountRestrictionLabel } from '../assets/js/account-status.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const NOW = new Date('2026-09-23T12:00:00Z');

test('الحساب الافتراضي (none) والنشط (active) وغير المحدد ليست مقيّدة', () => {
    for (const ban_status of ['none', 'active', null, undefined, '']) {
        assert.equal(isAccountRestricted({ ban_status }, NOW), false, String(ban_status));
        assert.equal(accountRestrictionLabel({ ban_status }, NOW), null);
    }
    assert.equal(isAccountRestricted(null, NOW), false);
});

test('الحظر الدائم والمؤقت الساري مقيّدان، بتسمية صحيحة', () => {
    assert.equal(accountRestrictionLabel({ ban_status: 'permanent' }, NOW), 'الحساب موقوف');
    assert.equal(accountRestrictionLabel({ ban_status: 'banned' }, NOW), 'الحساب موقوف');
    assert.equal(accountRestrictionLabel({ ban_status: 'temporary', ban_until: '2026-10-01T00:00:00Z' }, NOW),
        'الحساب مقيّد مؤقتًا');
    assert.equal(accountRestrictionLabel({ ban_status: 'suspended' }, NOW), 'الحساب مقيّد');
});

test('الحظر المؤقت المنتهي لا يُعرض — نفس شرط ban_until في is_banned()', () => {
    assert.equal(isAccountRestricted({ ban_status: 'temporary', ban_until: '2026-09-01T00:00:00Z' }, NOW), false);
});

test('لا واجهة تعيد كتابة شرط الحظر بنفسها', () => {
    // الشروط القديمة الثلاثة المتعارضة يجب ألا تعود
    const files = ['assets/js/customer-sidebar.js', 'assets/js/customer/account-health.js',
        'customer-dashboard.js', 'customer-history.js'];
    for (const f of files) {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        assert.doesNotMatch(src, /ban_status\s*(!==|===|&&)/, `${f} يقرأ ban_status مباشرة`);
        assert.match(src, /account-status\.js/, `${f} لا يستخدم account-status.js`);
    }
});

test('اللغة الافتراضية عربية بغض النظر عن لغة المتصفح', () => {
    const src = fs.readFileSync(path.join(ROOT, 'language-manager.js'), 'utf8');
    const body = src.slice(src.indexOf('_loadLanguage() {'), src.indexOf('_applyToHTML(lang) {'));
    assert.doesNotMatch(body, /navigator\.language/, 'اتجاه الصفحة عاد يُشتق من لغة المتصفح');
    assert.match(body, /return 'ar';/);
});
