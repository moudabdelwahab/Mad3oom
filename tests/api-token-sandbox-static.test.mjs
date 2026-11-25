/**
 * فحوص ساكنة على ساندبوكس API (الترحيل 141).
 *
 * دوال Edge لا تُختبَر هنا بالتشغيل (تحتاج Deno وSupabase حيًّا)، لكن
 * الخصائص الأمنية التي تهمّ **قابلة للإثبات من المصدر نفسه**:
 *   • مفتاح الاختبار يُصدر ببادئة مميزة ويُخزَّن ببيئته.
 *   • التدوير يحتفظ ببادئة الاختبار ولا يحوّل البيئة.
 *   • التحقق من المفتاح يرفض مفتاح الاختبار على كل نقطة حية (403)
 *     قبل حدّ المعدّل وقبل تسجيل الاستخدام.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function read(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** جسم الملف بلا تعليقات — الفحوص تنظر إلى الكود لا إلى شرحه. */
function codeOnly(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter(line => !line.trim().startsWith('//'))
        .join('\n');
}

const CREATE = codeOnly(read('supabase/functions/create-api-token/index.ts'));
const REGEN = codeOnly(read('supabase/functions/regenerate-api-token-secret/index.ts'));
const MCP_AUTH = codeOnly(read('supabase/functions/mcp/_shared/api-auth.ts'));
const WA_AUTH = codeOnly(read('supabase/functions/send-whatsapp/_shared/api-auth.ts'));

/* ── الإصدار ──────────────────────────────────────────────────────────── */

test('create-api-token: بيئة المفتاح تُقرأ وتُفحص وتُخزَّن', () => {
    assert.match(CREATE, /body\.environment/, 'الدالة لا تقرأ environment من الجسم');
    assert.match(CREATE, /environment !== "live" && environment !== "test"/, 'قيم البيئة لا تُفحص');
    assert.match(CREATE, /const environment = body\.environment === undefined \? "live" : body\.environment/,
        'الافتراضي ليس live صراحةً');
    // تُخزَّن في الصف: إدراجا api_key_secret والـbearer معًا
    assert.equal((CREATE.match(/^\s*environment,$/gm) || []).length, 2,
        'environment لا تُخزَّن في كلا الإدراجين');
    assert.match(CREATE, /\.select\("id, name, description, api_key, is_active, created_at, scopes, expires_at, credential_type, environment"\)/,
        'الرد لا يعيد environment');
});

test('create-api-token: مفتاح الاختبار ببادئة مميزة في النوعين', () => {
    assert.match(CREATE, /mad3oom_pk_test_\$\{randomHex\(16\)\}/, 'بادئة api_key للاختبار غائبة');
    assert.match(CREATE, /mad3oom_bt_test_\$\{randomHex\(32\)\}/, 'بادئة bearer للاختبار غائبة');
    assert.match(CREATE, /mad3oom_pk_\$\{randomHex\(16\)\}/, 'بادئة api_key للحي غائبة');
    assert.match(CREATE, /mad3oom_bt_\$\{randomHex\(32\)\}/, 'بادئة bearer للحي غائبة');
    // البادئة تُختار من البيئة لا من معامل آخر
    assert.match(CREATE, /isTest \? `mad3oom_pk_test_/);
    assert.match(CREATE, /isTest \? `mad3oom_bt_test_/);
});

/* ── التدوير ──────────────────────────────────────────────────────────── */

test('regenerate: يقرأ البيئة ويحتفظ ببادئة الاختبار', () => {
    assert.match(REGEN, /\.select\("id, user_id, name, credential_type, environment"\)/,
        'التدوير لا يقرأ environment قبل التجديد');
    assert.match(REGEN, /existing\.environment === "test"/, 'التدوير لا يفرّع على البيئة');
    assert.match(REGEN, /mad3oom_bt_test_\$\{randomHex\(32\)\}/, 'تدوير bearer للاختبار بلا بادئة مميزة');
    // api_key_secret لا يمسّ api_key أصلًا — فبادئة الاختبار تبقى حتمًا
    assert.doesNotMatch(REGEN, /api_key: `mad3oom_pk_/,
        'التدوير يولّد api_key جديدًا — كان سيُسقط بادئة الاختبار');
});

/* ── التحقق: الرفض على النقاط الحية ───────────────────────────────────── */

for (const [name, src] of [['mcp', MCP_AUTH], ['send-whatsapp', WA_AUTH]]) {
    test(`verifyApiToken (${name}): مفتاح الاختبار يُرفَض 403 قبل حدّ المعدّل`, () => {
        assert.match(src, /environment/, `${name}: عمود environment لا يُقرأ في التحقق`);
        assert.match(src, /row\.environment === "test"/, `${name}: لا فحص لبيئة الاختبار`);
        assert.match(src, /status: 403, error: "Test API keys cannot access live endpoints"/,
            `${name}: الرفض ليس 403 بالرسالة المتفق عليها`);
        // الرفض قبل فحص حدّ المعدّل: مفتاح الاختبار لا يستهلك حصة
        const rejectAt = src.indexOf('row.environment === "test"');
        const rateCheckAt = src.indexOf('>= RATE_LIMIT_MAX_PER_MINUTE');
        assert.ok(rejectAt !== -1 && rateCheckAt !== -1 && rejectAt < rateCheckAt,
            `${name}: رفض الاختبار يأتي بعد فحص الحدّ`);
        // وlogApiUsage لا تُنادى إلا بعد نجاح verifyApiToken أصلًا (في index.ts
        // المتصل)، فالمرفوض لا يُسجَّل استخدامًا حيًا.
    });
}
