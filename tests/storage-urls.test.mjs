// اختبارات toObjectPath — تحليل قيمة التخزين المخزَّنة.
//
// الدالة تقرر أي مسار يُوقَّع، ومدخلها يكتبه المستخدم (chat_messages.image_url
// مثلًا). النسخة الأولى بحثت عن العلامة داخل نص الرابط كله بـindexOf، فكان
// رابط خارجي يحمل العلامة في استعلامه يُقرأ كأنه مسار تخزين صالح. هذه
// الاختبارات تثبّت أن القرار صار من pathname وحده مثبَّتًا في أوله.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// الوحدة تستورد عميل Supabase الذي لا يُحل في Node، ونحن نختبر دالة نقيّة
// لا تلمسه — فنجرّد الاستيراد ونقيّم الوحدة.
const SRC = path.resolve(import.meta.dirname, '../storage-urls.js');
const src = fs.readFileSync(SRC, 'utf8').replace(/^import\s+\{[^}]*\}\s+from\s+'\/api-config\.js';\s*$/m, '');
const mod = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
const { toObjectPath, SIGNED_URL_TTL } = mod;

test('الرابط العام الحقيقي يُختزل إلى مساره', () => {
    assert.equal(
        toObjectPath('tickets', 'https://ref.supabase.co/storage/v1/object/public/tickets/abc/proof.png'),
        'abc/proof.png');
});

test('الرابط الموقَّع يُختزل كذلك، بلا معاملات الاستعلام', () => {
    assert.equal(
        toObjectPath('tickets', 'https://ref.supabase.co/storage/v1/object/sign/tickets/abc/proof.png?token=xyz'),
        'abc/proof.png');
});

test('المسار المجرّد يمرّ كما هو', () => {
    assert.equal(toObjectPath('tickets', 'abc/proof.png'), 'abc/proof.png');
    assert.equal(toObjectPath('tickets', '/abc/proof.png'), 'abc/proof.png');
});

test('رابط خارجي يحمل العلامة في الاستعلام لا يُقرأ كمسار تخزين', () => {
    // هذا ما كانت النسخة الأولى تقبله
    assert.equal(
        toObjectPath('tickets', 'https://evil.test/x?next=/object/public/tickets/secret.pdf'),
        null);
});

test('رابط خارجي يحمل العلامة في المرساة لا يُقرأ كمسار تخزين', () => {
    assert.equal(
        toObjectPath('tickets', 'https://evil.test/x#/storage/v1/object/public/tickets/secret.pdf'),
        null);
});

test('رابط خارجي يحمل العلامة في مساره لكن على مضيف آخر — المضيف ليس الحدّ، المسار هو', () => {
    // نقبل هذا عمدًا: الحدّ الحقيقي هو RLS عند التوقيع، لا اسم المضيف.
    // المهم أن التحليل مثبَّت في أول pathname لا مبعثرًا في النص.
    assert.equal(
        toObjectPath('tickets', 'https://other.test/storage/v1/object/public/tickets/a/b.png'),
        'a/b.png');
});

test('مستودع آخر لا يُقبل', () => {
    assert.equal(
        toObjectPath('tickets', 'https://ref.supabase.co/storage/v1/object/public/avatars/a/b.png'),
        null);
});

test('صعود في الشجرة مرفوض', () => {
    assert.equal(toObjectPath('tickets', '../../etc/passwd'), null);
    assert.equal(toObjectPath('tickets', 'a/../../b'), null);
    assert.equal(
        toObjectPath('tickets', 'https://ref.supabase.co/storage/v1/object/public/tickets/..%2F..%2Fx'),
        null);
});

test('القيم الفارغة وغير النصية تُرفض بلا رمي', () => {
    for (const v of [null, undefined, '', '   ', 42, {}, []]) {
        assert.equal(toObjectPath('tickets', v), null, `فشل عند ${JSON.stringify(v)}`);
    }
});

test('رابط تالف لا يُسقط الصفحة', () => {
    assert.equal(toObjectPath('tickets', 'https://['), null);
});

test('مدة التوقيع خمس دقائق', () => {
    assert.equal(SIGNED_URL_TTL, 300);
});
