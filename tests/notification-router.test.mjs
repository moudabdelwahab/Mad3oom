/**
 * اختبارات موجّه الإشعارات.
 *
 * الوحدة دي بتفكّ رابط الإشعار (نص حر كتبته خدمات مختلفة على مدار الوقت)
 * وتحوّله لوجهة. علشان كده بتتعامل مع الرابط كمدخل غير موثوق، والاختبارات
 * هنا بتثبّت الرفض قبل القبول.
 *
 * الوحدة بتستخدم window.location.origin، فبنركّب stub بسيط قبل الاستيراد.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { location: { origin: 'https://mad3oom.com' } };

const {
    resolveDestination, resolveNotification, destinationLabel,
    categoriesPresentIn, NOTIFICATION_CATEGORIES
} = await import('../assets/js/customer/notification-router.js');

const TICKET_UUID = '13b4890f-2bab-40fd-8d7f-fcad9aab250a';

/* ── الوجهات المقبولة ───────────────────────────────────────────────────── */

test('رابط التذكرة الحقيقي في قاعدة البيانات يُفكّ إلى وجهة تذكرة', () => {
    // ده الشكل المخزَّن فعلاً في notifications.link للعملاء
    const d = resolveDestination(`customer-dashboard.html?ticket=${TICKET_UUID}`);
    assert.equal(d.kind, 'ticket');
    assert.equal(d.ticketId, TICKET_UUID);
});

test('الرابط المطلق لنفس النطاق مقبول أيضاً', () => {
    const d = resolveDestination(`https://mad3oom.com/customer-dashboard.html?ticket=${TICKET_UUID}`);
    assert.equal(d.kind, 'ticket');
});

test('رابط اللوحة بدون معرّف يفتح النظرة العامة', () => {
    assert.deepEqual(resolveDestination('/customer-dashboard.html'), { kind: 'section', section: 'overview' });
});

test('الـhash يحدد القسم عندما يكون قسمًا معروفًا', () => {
    assert.deepEqual(resolveDestination('/customer-dashboard.html#usage'), { kind: 'section', section: 'usage' });
});

test('hash غير معروف لا يفتح قسمًا غير موجود', () => {
    assert.deepEqual(resolveDestination('/customer-dashboard.html#admin-panel'), { kind: 'section', section: 'overview' });
});

test('صفحة عميل أخرى تُفتح كرابط داخلي', () => {
    const d = resolveDestination('/customer-subscriptions.html');
    assert.equal(d.kind, 'url');
    assert.equal(d.href, '/customer-subscriptions.html');
});

/* ── الوجهات المرفوضة (أمان) ────────────────────────────────────────────── */

test('javascript: مرفوض', () => {
    assert.deepEqual(resolveDestination('javascript:alert(1)'), { kind: 'none' });
    assert.deepEqual(resolveDestination('JavaScript:alert(1)'), { kind: 'none' });
});

test('data: مرفوض', () => {
    assert.deepEqual(resolveDestination('data:text/html,<script>alert(1)</script>'), { kind: 'none' });
});

test('أي نطاق خارجي مرفوض', () => {
    assert.deepEqual(resolveDestination('https://evil.example/customer-dashboard.html'), { kind: 'none' });
    assert.deepEqual(resolveDestination('//evil.example/x'), { kind: 'none' });
});

test('القيم الفارغة أو غير النصية لا تكسر الموجّه', () => {
    for (const value of [null, undefined, '', '   ', 42, {}, []]) {
        assert.deepEqual(resolveDestination(value), { kind: 'none' }, `فشل مع ${JSON.stringify(value)}`);
    }
});

test('معرّف تذكرة غير صالح لا يُعامَل كتذكرة', () => {
    assert.notEqual(resolveDestination('customer-dashboard.html?ticket=1').kind, 'ticket');
    assert.notEqual(resolveDestination('customer-dashboard.html?ticket=../../etc').kind, 'ticket');
    assert.notEqual(resolveDestination("customer-dashboard.html?ticket='or'1").kind, 'ticket');
});

/* ── التصنيفات ──────────────────────────────────────────────────────────── */

test('كل تصنيف له تسمية عربية وأيقونة ولون', () => {
    for (const [key, meta] of Object.entries(NOTIFICATION_CATEGORIES)) {
        assert.ok(meta.label, `${key} بلا تسمية`);
        assert.ok(meta.icon, `${key} بلا أيقونة`);
        assert.ok(meta.tone, `${key} بلا لون`);
    }
});

test('التصنيفات المطلوبة كلها موجودة', () => {
    for (const key of ['tickets', 'account', 'whatsapp', 'sie', 'subscription', 'system', 'security', 'billing']) {
        assert.ok(NOTIFICATION_CATEGORIES[key], `التصنيف ${key} ناقص`);
    }
});

test('التصنيف المجهول يرجع لتصنيف افتراضي بدل ما يكسر العرض', () => {
    const r = resolveNotification({ category: 'not_a_real_category', link: null });
    assert.equal(r.category, 'system');
    assert.ok(r.meta.label);
});

test('التصنيف الغائب (صف قديم) يرجع للافتراضي', () => {
    assert.equal(resolveNotification({ link: null }).category, 'system');
});

test('قائمة التصنيفات للتصفية مبنية على ما وصل فعلاً', () => {
    const present = categoriesPresentIn([
        { category: 'tickets' }, { category: 'tickets' }, { category: 'billing' }, { category: 'unknown' }
    ]);
    assert.deepEqual(present.sort(), ['billing', 'system', 'tickets'].sort());
});

test('نص الإجراء يوضح ما سيحدث عند الضغط', () => {
    assert.equal(destinationLabel({ kind: 'ticket' }), 'فتح التذكرة');
    assert.equal(destinationLabel({ kind: 'section' }), 'فتح القسم');
    assert.equal(destinationLabel({ kind: 'url' }), 'فتح الصفحة');
    assert.equal(destinationLabel({ kind: 'none' }), '');
});

test('resolveNotification يجمع التصنيف والوجهة معاً', () => {
    const r = resolveNotification({
        category: 'tickets',
        title: 'رد جديد على تذكرتك',
        link: `customer-dashboard.html?ticket=${TICKET_UUID}`
    });
    assert.equal(r.category, 'tickets');
    assert.equal(r.destination.kind, 'ticket');
    assert.equal(r.destination.ticketId, TICKET_UUID);
});
