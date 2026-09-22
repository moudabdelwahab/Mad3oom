// Unit tests for assets/js/account/account-core.js — the shared rules behind
// the unified "Profile & Security" module (customer, company and admin panels).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    validateNewPassword, validateFullName, validateEmail, validatePhone, normalizePhone,
    validateAvatarFile, generateRecoveryCodes, protectionFacts, passwordChangeKnown,
    isTrustedDeviceActive, trustedUntilFromNow, accountMode
} from '../assets/js/account/account-core.js';

test('one password rule everywhere: 8+ chars, upper, lower, digit', () => {
    assert.equal(validateNewPassword('Abcdefg1', 'Abcdefg1').isValid, true);
    assert.match(validateNewPassword('abcdefg1').errors.password, /حرف كبير/, 'letter+digit alone was the old customer rule');
    assert.match(validateNewPassword('Abc1').errors.password, /8 أحرف/);
    assert.match(validateNewPassword('').errors.password, /مطلوبة/);
    assert.match(validateNewPassword('Abcdefg1', 'Abcdefg2').errors.confirm, /غير متطابقتين/);
});

test('normalizePhone mirrors public.normalize_phone() case for case', () => {
    // Same inputs as tests/sql/profile-security-hardening.test.sql and the live function.
    const cases = [
        ['01000000044', '+201000000044'],
        ['+20 100 000 0044', '+201000000044'],
        ['00201000000044', '+201000000044'],
        ['201000000044', '+201000000044'],
        ['not-a-phone', null],
        ['0100000000', null],   // 10 digits — the fixture phone, invalid in the DB too
        ['', null],
        [null, null]
    ];
    for (const [input, expected] of cases) assert.equal(normalizePhone(input), expected, String(input));
    assert.equal(validatePhone(''), 'رقم الهاتف مطلوب — الحساب يحتاجه ليبقى مفعّلًا',
        'clearing the phone would gate the account, so it is refused');
    assert.equal(validatePhone('01012345678'), null);
});

test('name, email and avatar validation', () => {
    assert.ok(validateFullName('ab'));
    assert.equal(validateFullName('أحمد'), null);
    assert.ok(validateEmail('nope'));
    assert.equal(validateEmail('a@b.co'), null);
    assert.ok(validateAvatarFile({ type: 'image/gif', size: 10 }));
    assert.ok(validateAvatarFile({ type: 'image/png', size: 3 * 1024 * 1024 }));
    assert.equal(validateAvatarFile({ type: 'image/webp', size: 1024 }), null);
});

test('recovery codes come from a CSPRNG and are distinct', () => {
    let calls = 0;
    const fake = { getRandomValues: (a) => { calls++; for (let i = 0; i < a.length; i++) a[i] = (i * 37 + calls) & 255; return a; } };
    const codes = generateRecoveryCodes(8, 10, fake);
    assert.equal(calls, 8, 'every code draws from getRandomValues');
    assert.equal(codes.length, 8);
    assert.ok(codes.every(c => /^[A-HJ-NP-Z2-9]{10}$/.test(c)), 'unambiguous alphabet only');
    const real = generateRecoveryCodes();
    assert.equal(new Set(real).size, real.length);
    assert.throws(() => generateRecoveryCodes(8, 10, {}), /secure random/);
});

test('Telegram OTP is never shown as active, even when the stored flag says so (PS-03)', () => {
    const tg = protectionFacts({ telegram_otp_enabled: true }).find(f => f.key === 'telegram_otp');
    assert.equal(tg.state, 'unavailable');
    assert.equal(tg.value, 'غير متاح حاليًا');
    assert.match(tg.note, /لا تُطلب عند الدخول/);
});

test('2FA is described as enforced at sign-in, not as full server protection', () => {
    const on = protectionFacts({ two_factor_enabled: true }).find(f => f.key === 'two_factor');
    assert.equal(on.state, 'partial');
    assert.match(on.note, /قيد التنفيذ/);
    const off = protectionFacts({ two_factor_enabled: false }).find(f => f.key === 'two_factor');
    assert.equal(off.state, 'off');
});

test('phone is never presented as verified', () => {
    const p = protectionFacts({ phone: '+201000000044' }).find(f => f.key === 'phone');
    assert.match(p.value, /غير موثّق/);
});

test('last password change equal to creation time means "unknown", not a real date', () => {
    const created = '2026-01-01T00:00:00Z';
    assert.equal(passwordChangeKnown({ created_at: created, last_password_change: '2026-01-01T00:00:00.300Z' }), false);
    assert.equal(passwordChangeKnown({ created_at: created, last_password_change: '2026-03-01T00:00:00Z' }), true);
    assert.equal(passwordChangeKnown({ created_at: created }), false);
});

test('a trusted device only skips 2FA until trusted_until (PS-18)', () => {
    const now = Date.parse('2026-09-22T00:00:00Z');
    assert.equal(isTrustedDeviceActive({ trusted_until: '2026-10-01T00:00:00Z' }, now), true);
    assert.equal(isTrustedDeviceActive({ trusted_until: '2026-09-01T00:00:00Z' }, now), false);
    assert.equal(isTrustedDeviceActive({ trusted_until: null }, now), false, 'legacy rows without expiry no longer skip 2FA');
    assert.equal(Date.parse(trustedUntilFromNow(now)) - now, 30 * 24 * 60 * 60 * 1000);
});

test('impersonation and preview are read-only (PS-17)', () => {
    assert.deepEqual(accountMode({ isImpersonated: true }), { readOnly: true, reason: 'impersonation' });
    assert.deepEqual(accountMode({ isPreview: true }), { readOnly: true, reason: 'preview' });
    assert.deepEqual(accountMode({}), { readOnly: false, reason: null });
});
