/**
 * قرار وضع التسجيل (assets/js/registration-mode.js): الفشل لا يفتح التسجيل أبدًا.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    REGISTRATION_MODE,
    REGISTER_COPY,
    DEFAULT_WAITLIST_MESSAGE,
    UNKNOWN_LAUNCH_DATE,
    resolveRegistrationSettings,
    canSubmitRegistration,
    waitlistSuccessText
} from '../assets/js/registration-mode.js';

const WAITLIST = { mode: 'waitlist', waitlist_message: 'رسالة\n\nموعد الإطلاق المتوقع: {{launch_date}}', expected_launch_date: 'يناير 2027' };

test('waitlist from the database is shown as waitlist, with its message and date', () => {
    const s = resolveRegistrationSettings({ data: WAITLIST, error: null });
    assert.equal(s.mode, REGISTRATION_MODE.waitlist);
    assert.equal(waitlistSuccessText(s), 'رسالة\n\nموعد الإطلاق المتوقع: يناير 2027');
    assert.equal(canSubmitRegistration(s), true);
});

test('open registration only when the database says open explicitly', () => {
    const s = resolveRegistrationSettings({ data: { mode: 'open' }, error: null });
    assert.equal(s.mode, REGISTRATION_MODE.open);
    assert.equal(canSubmitRegistration(s), true);
});

test('every failure or unknown value is "unavailable", never "open"', () => {
    const cases = [
        ['rpc error (e.g. 42501)', { data: null, error: { code: '42501', message: 'permission denied' } }],
        ['thrown / timeout', { error: new Error('timeout') }],
        ['no result at all', undefined],
        ['null data (row missing)', { data: null, error: null }],
        ['mode null (invalid value in DB)', { data: { mode: null }, error: null }],
        ['unknown mode', { data: { mode: 'closed' }, error: null }],
        ['mode with different case', { data: { mode: 'OPEN' }, error: null }],
        ['array instead of object (old table read shape)', { data: [{ value: { mode: 'open' } }], error: null }],
        ['string payload', { data: 'open', error: null }]
    ];
    for (const [label, result] of cases) {
        const s = resolveRegistrationSettings(result);
        assert.equal(s.mode, REGISTRATION_MODE.unavailable, label);
        assert.equal(canSubmitRegistration(s), false, `${label}: submit must be blocked`);
    }
});

test('an error is unavailable even if data also looks valid', () => {
    const s = resolveRegistrationSettings({ data: { mode: 'open' }, error: { message: 'x' } });
    assert.equal(s.mode, REGISTRATION_MODE.unavailable);
});

test('missing message or date fall back without inventing a launch date', () => {
    const s = resolveRegistrationSettings({ data: { mode: 'waitlist' }, error: null });
    assert.equal(s.waitlistMessage, DEFAULT_WAITLIST_MESSAGE);
    assert.equal(s.launchDate, UNKNOWN_LAUNCH_DATE);
    assert.ok(!waitlistSuccessText(s).includes('أكتوبر 2026'), 'no stale hard-coded date');
    assert.ok(!waitlistSuccessText(s).includes('{{launch_date}}'));
});

test('copy exists for every mode, and the unavailable state offers retry, not signup', () => {
    for (const mode of Object.values(REGISTRATION_MODE)) {
        assert.ok(REGISTER_COPY[mode]?.title && REGISTER_COPY[mode]?.submit, mode);
    }
    assert.equal(REGISTER_COPY.waitlist.submit, 'الانضمام لقائمة الانتظار');
    assert.equal(REGISTER_COPY.open.submit, 'إنشاء الحساب');
    assert.notEqual(REGISTER_COPY.unavailable.submit, REGISTER_COPY.open.submit);
});

test('canSubmitRegistration rejects anything that is not a verified mode', () => {
    for (const v of [null, undefined, {}, { mode: 'unavailable' }, { mode: 'closed' }]) {
        assert.equal(canSubmitRegistration(v), false);
    }
});
