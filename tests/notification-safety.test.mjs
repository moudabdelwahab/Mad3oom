/**
 * safeNotificationHref: روابط الإشعارات في لوحة الإدارة تُتبع فقط على نفس الأصل.
 * محتوى notifications غير موثوق (أي موظف يُدرج إشعارًا لأي مستخدم).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { safeNotificationHref } from '../assets/js/admin/notification-safety.js';

const ORIGIN = 'https://mad3oom.com';

test('مسارات نفس الأصل تمر كما هي (مسار + استعلام + مرساة)', () => {
    assert.equal(safeNotificationHref('/admin/inbox.html?session=abc', ORIGIN), '/admin/inbox.html?session=abc');
    assert.equal(safeNotificationHref('  /admin/tickets.html#t1  ', ORIGIN), '/admin/tickets.html#t1');
    assert.equal(safeNotificationHref('https://mad3oom.com/admin/continuity.html?record=1', ORIGIN), '/admin/continuity.html?record=1');
    assert.equal(safeNotificationHref('customer-dashboard.html?ticket=1', ORIGIN), '/customer-dashboard.html?ticket=1');
});

test('مخططات التنفيذ مرفوضة بكل أشكال التمويه', () => {
    for (const link of [
        'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)',
        'java\nscript:alert(1)', '\u0001javascript:alert(1)', 'data:text/html,<script>alert(1)</script>',
        'vbscript:msgbox(1)', 'blob:https://mad3oom.com/x', 'file:///etc/passwd',
    ]) {
        assert.equal(safeNotificationHref(link, ORIGIN), null, JSON.stringify(link));
    }
});

test('نطاقات أخرى مرفوضة، بما فيها الروابط بلا مخطط والشرطة المائلة العكسية', () => {
    for (const link of [
        'https://evil.example/x', '//evil.example/x', '/\\evil.example/x', '\\\\evil.example/x',
        'http://mad3oom.com/admin', 'https://mad3oom.com.evil.example/', 'https://mad3oom.com:8443/x',
        'https://user@evil.example/',
    ]) {
        assert.equal(safeNotificationHref(link, ORIGIN), null, JSON.stringify(link));
    }
});

test('قيم غير نصية أو فارغة أو بمسافات داخلية لا تُتبع', () => {
    for (const link of [null, undefined, '', '   ', 42, {}, ['/admin'], '/admin/inbox.html?q=a b']) {
        assert.equal(safeNotificationHref(link, ORIGIN), null, JSON.stringify(link));
    }
    assert.equal(safeNotificationHref('/admin', 'not a url'), null, 'أصل غير صالح ⇒ لا تنقل');
    assert.equal(safeNotificationHref('/admin', 'file:///'), null, 'أصل غير http(s) ⇒ لا تنقل');
});
