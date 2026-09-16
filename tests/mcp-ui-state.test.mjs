/**
 * اختبارات mcp-ui-state.js — منطق حالة واجهة تكاملات MCP وترجمة أخطائها.
 *
 * ما تحرسه هذه الاختبارات:
 *
 *  • التمييز بين «يحتاج تفويض» و«فشل الاتصال». القاعدة تخزّن الحالتين
 *    كـerror واحدة، لكن الإجراء المطلوب من المستخدم مختلف تمامًا:
 *    الأولى تعني «أكمل تسجيل الدخول»، والثانية تعني «راجع الإعداد».
 *    خلطهما هو ما كان يجعل الواجهة تعرض «فشل» لاتصال لم يُفوَّض أصلًا.
 *
 *  • أن الرسالة التقنية الأصلية لا تُفقد أبدًا. الهدف إخفاء لغة مثل
 *    "Initialize failed (406)" عن المستخدم العادي، لا حذفها — تبقى
 *    متاحة في detail لفريق الدعم.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { UI_STATES, deriveUiState, explainError, validateCredential, isUuid } from '../assets/js/admin/mcp-ui-state.js';

/* ────────────────────────── deriveUiState ────────────────────────── */

test('خادم بلا اتصال محفوظ = غير متصل', () => {
    assert.equal(deriveUiState(null), UI_STATES.DISCONNECTED);
    assert.equal(deriveUiState({ id: 'x' }), UI_STATES.DISCONNECTED);
});

test('اتصال ناجح = متصل', () => {
    assert.equal(
        deriveUiState({ connection_id: 'c1', status: 'connected', auth_type: 'bearer' }),
        UI_STATES.CONNECTED
    );
});

test('اتصال OAuth أُنشئ ولم يُفوَّض بعد = يحتاج تفويض لا خطأ', () => {
    // هذه هي الحالة التي تسبق ضغط المستخدم على زر الموافقة عند المزوّد:
    // لا توكن بعد، فالحالة pending. عرضها كـ«خطأ» يدفع المستخدم لتصحيح
    // إعداد سليم بدل إكمال خطوة ناقصة.
    assert.equal(
        deriveUiState({ connection_id: 'c1', status: 'pending', auth_type: 'oauth2', oauth_token_expires_at: null }),
        UI_STATES.AUTH_REQUIRED
    );
});

test('خطأ OAuth بلا توكن = يحتاج تفويض', () => {
    assert.equal(
        deriveUiState({
            connection_id: 'c1', status: 'error', auth_type: 'oauth2',
            oauth_token_expires_at: null, last_error: 'no access token',
        }),
        UI_STATES.AUTH_REQUIRED
    );
});

test('خطأ 401 على اتصال غير OAuth = يحتاج تفويض كذلك', () => {
    assert.equal(
        deriveUiState({ connection_id: 'c1', status: 'error', auth_type: 'bearer', last_error: 'Initialize failed (401)' }),
        UI_STATES.AUTH_REQUIRED
    );
});

test('خطأ بروتوكول حقيقي يبقى خطأً ولا يُصنَّف تفويضًا', () => {
    // 406 كان سببه ترويسة Accept ناقصة — لا علاقة له بالتفويض،
    // و«أعد الربط» لن يصلحه. تصنيفه الصحيح يغيّر الزر المعروض.
    assert.equal(
        deriveUiState({ connection_id: 'c1', status: 'error', auth_type: 'bearer', last_error: 'Initialize failed (406)' }),
        UI_STATES.ERROR
    );
});

test('OAuth بتوكن صالح وحالة error يبقى خطأً', () => {
    assert.equal(
        deriveUiState({
            connection_id: 'c1', status: 'error', auth_type: 'oauth2',
            oauth_token_expires_at: '2099-01-01T00:00:00Z', last_error: 'Initialize failed (500)',
        }),
        UI_STATES.ERROR
    );
});

/* ────────────────────────── explainError ────────────────────────── */

test('الرسالة التقنية الأصلية تُحفَظ دائمًا في detail', () => {
    const raw = 'Initialize failed (406): Not Acceptable';
    for (const input of [raw, 'anything at all', '']) {
        const out = explainError(input);
        assert.ok(out.detail, 'detail فارغ');
        if (input) assert.equal(out.detail, input);
    }
});

test('كل رد يحمل عنوانًا ورسالة وإجراءً بالعربية', () => {
    const samples = ['401', '403', '404', '405', '406', '429', 'timeout', '500', 'غير معروف تمامًا'];
    for (const s of samples) {
        const out = explainError(s);
        assert.ok(out.title && out.message && out.action, `ينقص حقل في: ${s}`);
        // الهدف الأساسي: ألّا يرى المستخدم "Initialize failed (406)".
        assert.ok(!/initialize failed/i.test(out.title), 'العنوان ما زال تقنيًا');
    }
});

test('401 و405 يُشرحان شرحين مختلفين — الإجراء المطلوب مختلف', () => {
    const unauthorized = explainError('Initialize failed (401)');
    const badMethod = explainError('Initialize failed (405): Only POST is supported');
    assert.notEqual(unauthorized.title, badMethod.title);
    assert.equal(unauthorized.action, 'إعادة الربط');
    assert.equal(badMethod.action, 'مراجعة الرابط');
});

test('رسالة فارغة لا تُسقط الدالة', () => {
    const out = explainError(undefined);
    assert.ok(out.title);
    assert.equal(out.detail, 'لا توجد تفاصيل إضافية.');
});

/* ────────────────────── validateCredential ────────────────────── */

test('رابط في خانة اعتماد يُرفض لأي خدمة — العطل الفعلي الذي وقع', () => {
    // هذه القيمة بالحرف هي ما حُفظ في قاعدة الإنتاج كـClient ID لـSupabase،
    // فردّت Supabase: {"message":"client_id: Invalid UUID"} — على صفحتها،
    // بالإنجليزية، بعد أن غادر المستخدم المنصّة.
    const msg = validateCredential('supabase', 'oauth_client_id', 'https://srnelrdpqkcntbgudyto.supabase.co');
    assert.ok(msg, 'القيمة مُرّت بلا اعتراض');
    assert.match(msg, /رابط/);

    for (const svc of ['github', 'notion', undefined]) {
        assert.ok(validateCredential(svc, 'bearer_token', 'https://github.com/settings/tokens'), `مُرّ الرابط لـ${svc}`);
    }
});

test('Supabase يطلب UUID تحديدًا', () => {
    assert.ok(validateCredential('supabase', 'oauth_client_id', 'sbp_abc123'), 'قيمة ليست UUID مُرّت');
    assert.match(validateCredential('supabase', 'oauth_client_id', 'sbp_abc123'), /UUID/);
    assert.equal(validateCredential('supabase', 'oauth_client_id', '123e4567-e89b-12d3-a456-426614174000'), null);
});

test('قيود UUID لا تُفرض على خدمات لا تستخدمه', () => {
    // GitHub يصدر رموزًا مثل ghp_… — فرض UUID عليها كان سيمنع ربطًا سليمًا.
    assert.equal(validateCredential('github', 'bearer_token', 'ghp_0123456789abcdefghijklmnopqrstuvwxyz'), null);
    assert.equal(validateCredential('notion', 'oauth_client_id', 'some-notion-client-id'), null);
});

test('القيمة الفارغة والمسافات الداخلية تُرفضان', () => {
    assert.match(validateCredential('github', 'api_key', ''), /مطلوب/);
    assert.match(validateCredential('github', 'api_key', '   '), /مطلوب/);
    assert.match(validateCredential('github', 'api_key', 'abc def'), /مسافات/);
    // المسافات الطرفية وحدها لا تُعتبر خطأ — تُقصّ.
    assert.equal(validateCredential('github', 'api_key', '  ghp_abc  '), null);
});

test('isUuid يميّز الشكل الصحيح', () => {
    assert.equal(isUuid('123e4567-e89b-12d3-a456-426614174000'), true);
    assert.equal(isUuid('123e4567e89b12d3a456426614174000'), false);
    assert.equal(isUuid('https://x.supabase.co'), false);
});

/* ────────────────── ملخّص الصحة وترتيب العرض ────────────────── */

import { summarize, sortByHealth, needsAttention, isPopular, POPULAR_KEYS } from '../assets/js/admin/mcp-ui-state.js';
import { readFileSync } from 'node:fs';

// صفوف مختصرة. كلها تحمل connection_id لأن deriveUiState يعتبر أي صف
// بلا اتصال «غير متصل» أصلًا — وشريط الملخّص لا يُحسب إلا على الصفوف
// التي لهذا المستخدم اتصال بها فعلًا.
const connected = (tools = []) => ({ connection_id: 'c', status: 'connected', tools });
const failed = () => ({ connection_id: 'c', status: 'error', last_error: 'Initialize failed (500)' });
const needsAuth = () => ({ connection_id: 'c', status: 'error', last_error: 'unauthorized: token expired' });
const off = () => ({ connection_id: 'c', status: 'disconnected' });

test('summarize يعدّ المتصل ويحتاج-انتباه والأدوات', () => {
    const { total, connected: c, attention, tools } = summarize([
        connected([{ name: 'a' }, { name: 'b' }]),
        connected([{ name: 'c' }]),
        failed(),
        needsAuth(),
        off(),
    ]);
    assert.equal(total, 5);
    assert.equal(c, 2);
    assert.equal(attention, 2);
    assert.equal(tools, 3);
});

test('summarize لا يعدّ أدوات اتصال غير متصل', () => {
    // اتصال فاشل قد يحمل أدوات مكتشفة من جلسة سابقة؛ عدّها يعطي رقمًا
    // لا يقابله شيء قابل للاستدعاء الآن.
    const { tools } = summarize([{ connection_id: 'c', status: 'error', last_error: 'boom', tools: [{ name: 'x' }] }]);
    assert.equal(tools, 0);
});

test('summarize يحتمل مدخلًا فارغًا أو غير مصفوفة', () => {
    assert.deepEqual(summarize([]), { total: 0, connected: 0, attention: 0, tools: 0 });
    assert.deepEqual(summarize(null), { total: 0, connected: 0, attention: 0, tools: 0 });
});

test('needsAttention: الفشل والتفويض نعم، المفصول عمدًا لا', () => {
    assert.equal(needsAttention(UI_STATES.ERROR), true);
    assert.equal(needsAttention(UI_STATES.AUTH_REQUIRED), true);
    assert.equal(needsAttention(UI_STATES.DISCONNECTED), false);
    assert.equal(needsAttention(UI_STATES.CONNECTED), false);
});

test('sortByHealth يقدّم ما يحتاج تدخّلًا', () => {
    const ok = connected();
    const bad = failed();
    const gone = off();
    assert.deepEqual(sortByHealth([ok, gone, bad]), [bad, ok, gone]);
});

test('sortByHealth ثابت داخل المجموعة الواحدة ولا يعدّل المصدر', () => {
    const a = { ...connected(), id: 'a' };
    const b = { ...connected(), id: 'b' };
    const rows = [a, b];
    assert.deepEqual(sortByHealth(rows).map((r) => r.id), ['a', 'b']);
    assert.deepEqual(rows, [a, b], 'المصفوفة الأصلية لم تُمسّ');
});

test('كل مفتاح في POPULAR_KEYS موجود فعلًا في كتالوج mcp-service.js', () => {
    // يحرس ضد إعادة تسمية مفتاح في الكتالوج تترك قسم «الأكثر استخدامًا»
    // فارغًا بصمت. فحص نصّي لا استيراد: mcp-service.js يستورد بمسارات
    // مطلقة للمتصفح (/api-config.js) فلا يُحمَّل في Node — وهذا بالضبط
    // سبب فصل mcp-ui-state.js عنه.
    const src = readFileSync(new URL('../mcp-service.js', import.meta.url), 'utf8');
    for (const key of POPULAR_KEYS) {
        assert.ok(
            src.includes(`key: '${key}'`),
            `المفتاح ${key} غير موجود في MCP_CLIENT_CATALOG داخل mcp-service.js`,
        );
    }
    assert.equal(isPopular('supabase'), true);
    assert.equal(isPopular('nope'), false);
});
