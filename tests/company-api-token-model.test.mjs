/**
 * اختبارات نموذج مفاتيح API — دوال خالصة بلا DOM ولا شبكة.
 *
 * القيمة الحقيقية هنا: الملف ده **مرآة لعقد الدالة المنشورة**
 * create-api-token. الاختبارات بتثبّت المرآة، فلو اتغيّر العقد على الخادم
 * من غير ما يتغيّر هنا (أو العكس) الاختبار بيقع بدل ما المستخدم يقع.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ALLOWED_SCOPES, DEFAULT_SCOPES, PRIVILEGED_SCOPES, SELECTABLE_SCOPES,
    SCOPE_CATALOG, CREDENTIAL_TYPES, EXPIRY_PRESETS, MAX_EXPIRY_DAYS,
    validateTokenForm, toCreatePayload, expiryFromPreset, credentialsFromResponse,
    minCustomExpiryDate, maxCustomExpiryDate
} from '../assets/js/company/api-token-model.js';

const NOW = Date.parse('2026-09-09T12:00:00Z');

/* ── مطابقة عقد الدالة المنشورة ─────────────────────────────────────────── */

test('قائمة الصلاحيات مطابقة لـALLOWED_SCOPES في الدالة المنشورة', () => {
    // منقولة من مصدر create-api-token المقروء من الإنتاج، لا من الذاكرة
    const deployed = [
        'tickets:read', 'tickets:write', 'tickets:delete',
        'knowledge_base:read', 'knowledge_base:write',
        'customers:read', 'customers:write',
        'whatsapp:read', 'whatsapp:send',
        'analytics:read',
        'settings:manage',
        'oauth:manage',
        'mcp:connect',
        'chatbot:read',
        'admin:full',
        'subscriptions:read', 'subscriptions:write', 'subscriptions:renew',
        'subscriptions:cancel', 'subscriptions:plans',
        'notifications:read', 'notifications:send', 'notifications:manage'
    ];
    assert.deepEqual([...ALLOWED_SCOPES].sort(), deployed.sort());
});

test('الافتراضيات مطابقة لـDEFAULT_SCOPES في الدالة المنشورة', () => {
    assert.deepEqual([...DEFAULT_SCOPES].sort(),
        ['tickets:read', 'tickets:write', 'whatsapp:send', 'whatsapp:read', 'chatbot:read'].sort());
});

test('أنواع الاعتماد الثلاثة هي ما تقبله الدالة ولا شيء غيرها', () => {
    assert.deepEqual(CREDENTIAL_TYPES.map(t => t.key), ['api_key_secret', 'bearer', 'both']);
});

/* ── أقلّ امتياز ────────────────────────────────────────────────────────── */

test('الصلاحيات المعروضة كلها من القائمة المسموحة — لا صلاحية مخترعة', () => {
    for (const scope of SELECTABLE_SCOPES) {
        assert.ok(ALLOWED_SCOPES.includes(scope), `صلاحية معروضة غير مسموحة: ${scope}`);
    }
});

test('صلاحيات مشغّل المنصة لا تُعرض في لوحة الشركة', () => {
    for (const scope of PRIVILEGED_SCOPES) {
        assert.ok(!SELECTABLE_SCOPES.includes(scope), `صلاحية مشغّل معروضة: ${scope}`);
    }
    assert.ok(PRIVILEGED_SCOPES.includes('admin:full'));
});

test('لا تكرار لصلاحية بين المجموعات — الاختيار مرة واحدة لا مرتين', () => {
    assert.equal(new Set(SELECTABLE_SCOPES).size, SELECTABLE_SCOPES.length);
});

test('الافتراضيات كلها قابلة للاختيار من الواجهة', () => {
    for (const scope of DEFAULT_SCOPES) {
        assert.ok(SELECTABLE_SCOPES.includes(scope), `افتراضي غير معروض: ${scope}`);
    }
});

/* ── التحقّق ────────────────────────────────────────────────────────────── */

const valid = {
    name: 'تكامل المبيعات',
    description: '',
    credentialType: 'api_key_secret',
    scopes: ['tickets:read'],
    expiryPreset: '90'
};

test('نموذج سليم يمرّ', () => {
    assert.equal(validateTokenForm(valid, { now: NOW }).isValid, true);
});

test('الاسم مطلوب، وحدّه 80 حرفًا كما في الدالة', () => {
    assert.equal(validateTokenForm({ ...valid, name: '   ' }, { now: NOW }).errors.name, 'الاسم مطلوب');
    const long = validateTokenForm({ ...valid, name: 'ا'.repeat(81) }, { now: NOW });
    assert.match(long.errors.name, /80/);
    assert.equal(validateTokenForm({ ...valid, name: 'ا'.repeat(80) }, { now: NOW }).isValid, true);
});

test('الوصف حدّه 200 حرف كما في الدالة', () => {
    assert.match(validateTokenForm({ ...valid, description: 'ب'.repeat(201) }, { now: NOW }).errors.description, /200/);
    assert.equal(validateTokenForm({ ...valid, description: 'ب'.repeat(200) }, { now: NOW }).isValid, true);
});

test('مفتاح بلا صلاحيات مرفوض — الخادم يقبله لكنه لا يصلح لشيء', () => {
    const result = validateTokenForm({ ...valid, scopes: [] }, { now: NOW });
    assert.equal(result.isValid, false);
    assert.match(result.errors.scopes, /صلاحية واحدة على الأقل/);
});

test('صلاحية خارج القائمة مرفوضة قبل الرحلة للخادم', () => {
    assert.match(validateTokenForm({ ...valid, scopes: ['tickets:destroy'] }, { now: NOW }).errors.scopes, /غير معروفة/);
});

test('صلاحية مشغّل منصة مرفوضة حتى لو أُرسلت من نموذج معدَّل', () => {
    const result = validateTokenForm({ ...valid, scopes: ['tickets:read', 'admin:full'] }, { now: NOW });
    assert.equal(result.isValid, false);
    assert.match(result.errors.scopes, /مشغّل المنصة/);
});

test('نوع اعتماد غير معروف مرفوض', () => {
    assert.equal(validateTokenForm({ ...valid, credentialType: 'jwt' }, { now: NOW }).isValid, false);
});

/* ── التواريخ ───────────────────────────────────────────────────────────── */

test('تاريخ مخصَّص فارغ أو ماضٍ أو أبعد من الحد مرفوض', () => {
    assert.match(validateTokenForm({ ...valid, expiryPreset: 'custom', customExpiry: '' }, { now: NOW }).errors.expiry, /حدّد/);
    assert.match(validateTokenForm({ ...valid, expiryPreset: 'custom', customExpiry: '2020-01-01' }, { now: NOW }).errors.expiry, /المستقبل/);
    const far = new Date(NOW + (MAX_EXPIRY_DAYS + 10) * 86400000).toISOString().slice(0, 10);
    assert.match(validateTokenForm({ ...valid, expiryPreset: 'custom', customExpiry: far }, { now: NOW }).errors.expiry, /أقصى مدّة/);
});

test('«بلا انتهاء» تُرسل null لا تاريخًا', () => {
    assert.equal(expiryFromPreset('never', { now: NOW }), null);
});

test('المدّة الجاهزة تُحسب من الآن بالضبط', () => {
    const iso = expiryFromPreset('90', { now: NOW });
    assert.equal(new Date(iso).getTime(), NOW + 90 * 86400000);
});

test('التاريخ المخصَّص يعني نهاية اليوم لا أوله — وإلا مات المفتاح في يومه', () => {
    const iso = expiryFromPreset('custom', { customDate: '2026-12-31' });
    assert.match(new Date(iso).toISOString(), /^2026-12-31T|^2027-01-01T/);
    assert.ok(new Date(iso).getTime() > Date.parse('2026-12-31T12:00:00'));
});

test('حدّا حقل التاريخ: من الغد إلى سقف المدّة', () => {
    assert.equal(minCustomExpiryDate(NOW), '2026-09-10');
    assert.equal(maxCustomExpiryDate(NOW), new Date(NOW + MAX_EXPIRY_DAYS * 86400000).toISOString().slice(0, 10));
});

test('كل مدّة معروضة إمّا لها أيام أو هي «مخصَّص»/«بلا انتهاء»', () => {
    for (const preset of EXPIRY_PRESETS) {
        assert.ok(preset.days !== null || preset.key === 'custom', `مدّة بلا أيام: ${preset.key}`);
    }
});

/* ── حمولة الطلب ────────────────────────────────────────────────────────── */

test('الحمولة تحمل مفاتيح الدالة بالضبط', () => {
    const payload = toCreatePayload(valid, { now: NOW });
    assert.deepEqual(Object.keys(payload).sort(),
        ['credential_type', 'description', 'expires_at', 'name', 'scopes'].sort());
    assert.equal(payload.name, 'تكامل المبيعات');
    assert.equal(payload.description, undefined);
    assert.equal(payload.credential_type, 'api_key_secret');
    assert.deepEqual(payload.scopes, ['tickets:read']);
    assert.equal(payload.expires_at, new Date(NOW + 90 * 86400000).toISOString());
});

test('الحمولة لا تحمل أي معرّف مستخدم — الهوية من الجلسة وحدها', () => {
    const payload = toCreatePayload({ ...valid, userId: 'x', user_id: 'x' }, { now: NOW });
    assert.ok(!('user_id' in payload) && !('userId' in payload));
});

/* ── قراءة الرد ─────────────────────────────────────────────────────────── */

test('رد api_key_secret يُقرأ كاعتماد واحد برأس جاهز', () => {
    const list = credentialsFromResponse({
        token: { id: 't1', api_key: 'mad3oom_pk_abc' }, secret: 'mad3oom_sk_xyz'
    });
    assert.equal(list.length, 1);
    assert.equal(list[0].kind, 'api_key_secret');
    assert.equal(list[0].apiKey, 'mad3oom_pk_abc');
    assert.equal(list[0].headerValue, 'Bearer mad3oom_pk_abc.mad3oom_sk_xyz');
});

test('رد bearer يُقرأ كرمز واحد بلا معرّف علني', () => {
    const list = credentialsFromResponse({ token: { id: 't2' }, bearer_token: 'mad3oom_bt_123' });
    assert.equal(list.length, 1);
    assert.equal(list[0].kind, 'bearer');
    assert.equal(list[0].apiKey, null);
    assert.equal(list[0].headerValue, 'Bearer mad3oom_bt_123');
});

test('رد both يُقرأ كاعتمادين مرتبطين', () => {
    const list = credentialsFromResponse({
        credential_group_id: 'g1',
        api_key_secret: { token: { id: 'a', api_key: 'pk' }, secret: 'sk' },
        bearer: { token: { id: 'b' }, bearer_token: 'bt' }
    });
    assert.deepEqual(list.map(c => c.kind), ['api_key_secret', 'bearer']);
});

test('رد بلا سرّ لا يخترع اعتمادًا فارغًا', () => {
    assert.deepEqual(credentialsFromResponse(null), []);
    assert.deepEqual(credentialsFromResponse({ token: { id: 'x' } }), []);
});

/* ── سلامة الكتالوج ─────────────────────────────────────────────────────── */

test('كل مجموعة لها تسمية عربية وصلاحية واحدة على الأقل', () => {
    assert.ok(SCOPE_CATALOG.length >= 5);
    for (const group of SCOPE_CATALOG) {
        assert.ok(group.label && group.hint, `مجموعة بلا تسمية: ${group.key}`);
        assert.ok(group.scopes.length > 0);
        for (const scope of group.scopes) assert.ok(scope.label, `صلاحية بلا تسمية: ${scope.key}`);
    }
});
