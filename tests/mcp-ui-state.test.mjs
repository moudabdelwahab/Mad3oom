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
