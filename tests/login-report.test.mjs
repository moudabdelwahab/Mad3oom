/**
 * login-report.js (121): الإبلاغ عن دخول فاشل — بريد وسبب فقط، ولا يكسر الدخول أبدًا.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { reportLoginFailure, failureReason } from '../assets/js/security/login-report.js';

test('بريد وسبب فقط، ولا يكسر الدخول', async () => {
    const calls = [];
    reportLoginFailure({ functions: { invoke: async (name, opts) => { calls.push([name, opts]); } } },
        ' User@Example.com ', { message: 'Invalid login credentials' });
    assert.deepEqual(calls, [['security-event', { body: { action: 'login_failed', email: 'user@example.com', reason: 'invalid_credentials' } }]]);

    // فشل الدالة (مرفوض/استثناء متزامن) لا يرمي
    reportLoginFailure({ functions: { invoke: () => Promise.reject(new Error('down')) } }, 'a@b.co', null);
    reportLoginFailure({ functions: { invoke: () => { throw new Error('sync'); } } }, 'a@b.co', null);
    reportLoginFailure(null, 'a@b.co', null);
    reportLoginFailure({ functions: { invoke: () => calls.push('x') } }, 'username-not-email', null);
    assert.equal(calls.length, 1, 'لا إبلاغ بلا بريد صالح');
    await new Promise(r => setTimeout(r, 5));

    assert.equal(failureReason({ message: 'Email not confirmed' }), 'email_not_confirmed');
    assert.equal(failureReason({ message: 'Request rate limit reached' }), 'rate_limited');
    assert.equal(failureReason({ message: 'weird' }), 'other');
});
