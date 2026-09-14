/**
 * فحوص ساكنة على مصدر create-api-token المُحصَّنة.
 *
 * الدالة لا تُختبَر هنا بالتشغيل (تحتاج Deno وSupabase حيًّا)، لكن الخصائص
 * الأمنية التي تهمّ **قابلة للإثبات من المصدر نفسه**: أي انحراف عنها يعيد
 * الثغرة، والاختبار يفشل قبل أن يصل الكود إلى مراجعة بشرية.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'supabase/functions/create-api-token/index.ts'), 'utf8');
const SUB = fs.readFileSync(path.join(ROOT, 'supabase/functions/create-sub-user/index.ts'), 'utf8');

/** جسم الدالة بلا تعليقات — الفحوص يجب أن تنظر إلى الكود لا إلى شرحه. */
function codeOnly(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter(line => !line.trim().startsWith('//'))
        .join('\n');
}

const CODE = codeOnly(SRC);
const SUB_CODE = codeOnly(SUB);

/* ── التفويض يُسأل عنه الخادم ────────────────────────────────────────────── */

test('التفويض يمرّ بدالة القاعدة لا بفحص رتبة في TypeScript', () => {
    assert.match(CODE, /rpc\("api_token_issue_context"\)/,
        'الدالة لا تسأل القاعدة عن التفويض');
    assert.match(CODE, /context\.allowed !== true/,
        'نتيجة البوابة لا تُفحص');

    // ولا إعادة بناء لشرط الرتبة محليًّا — وهي الثغرة الأصلية بالضبط
    assert.doesNotMatch(CODE, /role\s*===\s*["'](super_user|company_admin|admin|support)["']/,
        'الدالة تعيد بناء فحص الرتبة في TypeScript بدل قراءته من القاعدة');
    assert.doesNotMatch(CODE, /from\("profiles"\)/,
        'الدالة تقرأ الرتبة من الجدول مباشرةً بدل دالة البوابة');
});

test('الرفض افتراضي: أي شيء غير allowed=true يُمنع', () => {
    const gate = CODE.slice(CODE.indexOf('api_token_issue_context'), CODE.indexOf('const scopeCeiling'));
    assert.match(gate, /403/, 'لا يوجد ردّ 403 في بوابة التفويض');
    assert.match(gate, /503/, 'فشل قراءة البوابة لا يُميَّز عن الرفض');
});

test('سقف الصلاحيات مفروض على الخادم من القاعدة لا من ثابت محلي', () => {
    assert.match(CODE, /scopeCeiling/, 'لا سقف صلاحيات');
    assert.match(CODE, /filter\(\(s\) => !scopeCeiling\.includes\(s\)\)/,
        'الصلاحيات المطلوبة لا تُقارَن بالسقف');
    // القائمة الكاملة لا تُعرَّف هنا: مصدرها القاعدة
    assert.doesNotMatch(CODE, /const\s+ALLOWED_SCOPES/,
        'قائمة صلاحيات ثابتة في الملف — السقف يجب أن يأتي من القاعدة');
});

test('صلاحيات مشغّل المنصة غير مذكورة كثابت مسموح في الدالة', () => {
    // ذِكرها في تعليق شرحٌ؛ في الكود منحٌ.
    for (const scope of ['admin:full', 'settings:manage', 'oauth:manage']) {
        assert.ok(!CODE.includes(scope),
            `الدالة تذكر صلاحية مشغّل منصة في كودها: ${scope}`);
    }
});

/* ── الهوية ─────────────────────────────────────────────────────────────── */

test('الهوية من الجلسة وحدها — لا معرّف يُقرأ من جسم الطلب', () => {
    assert.match(CODE, /const userId = userData\.user\.id/);
    for (const forged of ['body.user_id', 'body.company_id', 'body.owner_id', 'body.super_user_id']) {
        assert.ok(!CODE.includes(forged), `الدالة تقرأ معرّفًا قابلًا للتزوير: ${forged}`);
    }
    // وجسم الطلب مُصرَّح بأنواعه، فأي حقل جديد يحتاج تعديلًا واعيًا
    assert.match(CODE, /let body: \{[\s\S]{0,300}?\};/);
});

/* ── السرّ ──────────────────────────────────────────────────────────────── */

test('السرّ لا يُسجَّل في أي مخرج', () => {
    for (const m of CODE.matchAll(/console\.\w+\(([^)]*)\)/g)) {
        const args = m[1];
        for (const leak of ['secret', 'apiSecret', 'bearerToken', 'body', 'token']) {
            assert.ok(!args.includes(leak), `console يسجّل قيمة حسّاسة: ${args.trim()}`);
        }
    }
});

test('المخزَّن بصمة مشفَّرة لا القيمة', () => {
    assert.match(CODE, /secret_hash: secretHash/);
    assert.match(CODE, /bearer_token_hash: bearerHash/);
    // ولا عمود يخزّن القيمة الخام
    assert.doesNotMatch(CODE, /secret:\s*apiSecret\s*,[\s\S]{0,40}insert/,
        'السرّ الخام يُكتب في الجدول');
});

test('القيم الداخلية لصفّ Bearer عشوائية ولا تُعاد للمستخدم', () => {
    assert.match(CODE, /const internalSecret = randomHex\(32\)/);
    const bearerReturn = CODE.slice(CODE.indexOf('credentialType === "bearer"'),
                                    CODE.indexOf('const keySecretResult'));
    assert.ok(!bearerReturn.includes('internalSecret'), 'القيمة الداخلية تُعاد للمستخدم');
});

/* ── الحدود ─────────────────────────────────────────────────────────────── */

test('تاريخ الانتهاء محدود ولا يقبل الماضي', () => {
    assert.match(CODE, /d\.getTime\(\) <= Date\.now\(\)/, 'تاريخ ماضٍ مقبول');
    assert.match(CODE, /MAX_EXPIRY_DAYS/, 'لا سقف لمدّة الصلاحية');
});

test('مفتاح بلا صلاحيات مرفوض — لا يصلح لشيء', () => {
    assert.match(CODE, /scopes\.length === 0/);
});

test('الافتراضيات لم تتوسّع عن الإصدار المنشور', () => {
    const defaults = CODE.match(/const DEFAULT_SCOPES = \[([^\]]*)\]/)[1];
    for (const scope of ['tickets:read', 'tickets:write', 'whatsapp:send', 'whatsapp:read', 'chatbot:read']) {
        assert.ok(defaults.includes(scope), `افتراضي مفقود: ${scope}`);
    }
    assert.equal(defaults.split(',').length, 5, 'قائمة الافتراضيات تغيّر حجمها');
});

/* ── create-sub-user: نفس المبدأ ────────────────────────────────────────── */

test('create-sub-user تسأل القاعدة عن التفويض لا عن الرتبة', () => {
    assert.match(SUB_CODE, /rpc\("sub_user_create_context"\)/);
    assert.doesNotMatch(SUB_CODE, /role\s*===\s*["'](super_user|admin|support|company_admin)["']/,
        'ما زالت تفوّض على الرتبة وحدها');
    assert.match(SUB_CODE, /context\.allowed !== true/);
    assert.match(SUB_CODE, /403/);
});

test('المساران مفصولان، والقاعدة هي من يختار بينهما', () => {
    // attach_to_company تأتي من البوابة — الطلب لا يختار مساره
    assert.match(SUB_CODE, /context\.attach_to_company === true/);
    assert.match(SUB_CODE, /const superUserId = attachToCompany \? currentUser\.id : null/,
        'التبعية لا تتبع المسار الذي قرّرته القاعدة');
    // ولا تُقرأ من جسم الطلب بحال
    for (const forged of ['body.super_user_id', 'body.company_id', 'body.attach_to_company']) {
        assert.ok(!SUB_CODE.includes(forged), `قيمة قابلة للتزوير تُقرأ من الطلب: ${forged}`);
    }
});

test('سلوك طاقم المنصة محفوظ حرفيًا: حساب مستقل بدور customer', () => {
    const update = SUB_CODE.slice(SUB_CODE.indexOf('.from("profiles")'), SUB_CODE.indexOf('.eq("id"'));
    // نفس ما كان يكتبه الإصدار السابق بالضبط
    assert.match(update, /role: "customer"/,
        'الإصدار السابق كان يكتب customer — تغييرها يغيّر سلوك لوحة الإدارة');
    assert.match(update, /super_user_id: superUserId/);
});

test('التحقق بعد الإنشاء يطابق كل مسار بمعياره', () => {
    // مسار العضو: الدور لا بد أن يكون company_user
    assert.match(SUB_CODE, /created\.role !== "company_user"/);
    // مسار الحساب المستقل: التبعية لا بد أن تكون فارغة
    assert.match(SUB_CODE, /created\.super_user_id !== null/);
    // وأي عدم تطابق يتراجع بدل ترك حالة نصف مكتملة
    assert.match(SUB_CODE, /if \(mismatch\)/);
    assert.match(SUB_CODE, /deleteUser/);
});

test('نطاق الشركة يُطلب لمسار العضو وحده', () => {
    const scope = SUB_CODE.slice(SUB_CODE.indexOf('if (attachToCompany)'),
                                 SUB_CODE.indexOf('let body:'));
    assert.match(scope, /rpc\("current_company_id"\)/,
        'مسار العضو لا يتحقق من وجود شركة');
});

test('كلتا الدالتين تتحققان من الجلسة قبل أي شيء', () => {
    for (const [label, code] of [['create-api-token', CODE], ['create-sub-user', SUB_CODE]]) {
        assert.match(code, /auth\.getUser\(\)/, `${label} لا تتحقق من الجلسة`);
        assert.match(code, /401/, `${label} بلا ردّ 401`);
    }
});
