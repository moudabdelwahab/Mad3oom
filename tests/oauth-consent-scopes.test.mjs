/**
 * حراسة اختيار الصلاحيات في شاشة الموافقة.
 *
 * القاعدة الأمنية الوحيدة التي تجعل الاختيار حقيقيًا لا شكليًا:
 *
 *   المستخدم يستطيع **تضييق** ما طلبه التطبيق، ولا يستطيع توسيعه أبدًا.
 *
 * أي تعديل يجعل `granted_scopes` القادم من المتصفح **مصدرًا** للصلاحيات
 * بدل أن يكون **مُرشِّحًا** عليها يحوّل الشاشة إلى بوابة رفع صلاحيات:
 * يكفي أن يرسل أحدهم الطلب يدويًا بصلاحيات لم يطلبها التطبيق.
 *
 * الدالة تعمل على Deno وتستورد من jsr: فلا تُنفَّذ في Node، فتُفحص
 * مصدرًا — نفس أسلوب tests/remediation-static.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const APPROVE = readFileSync(
    path.join(ROOT, 'supabase/functions/oauth-authorize-approve/index.ts'), 'utf8');
const CONSENT = readFileSync(path.join(ROOT, 'admin/oauth-consent.html'), 'utf8');

test('ما يُكتب في كود التفويض هو المختار لا كل المطلوب', () => {
    assert.match(APPROVE, /scope:\s*grantedScopes\.join\(" "\)/,
        'يجب حفظ grantedScopes لا validScopes، وإلا فالاختيار بلا أثر');
    assert.doesNotMatch(APPROVE, /scope:\s*validScopes\.join/,
        'حفظ validScopes يتجاهل اختيار المستخدم تمامًا');
});

test('الاختيار مُرشِّح على المطلوب لا مصدر مستقل', () => {
    // الاتجاه حرج: validScopes.filter(...) يضيّق. أما بناء القائمة من
    // granted_scopes مباشرة فيسمح بصلاحية لم يطلبها التطبيق.
    assert.match(APPROVE, /grantedScopes\s*=\s*validScopes\.filter\(/,
        'التقاطع يجب أن ينطلق من validScopes');
    assert.doesNotMatch(APPROVE, /grantedScopes\s*=\s*granted_scopes\b/,
        'granted_scopes يجب ألا يصير المصدر مباشرة');
});

test('غياب الاختيار لا يُسقط التحقّق من ALLOWED_SCOPES', () => {
    // الافتراضي عند غياب الحقل هو validScopes — وهي أصلًا مُرشَّحة على
    // ALLOWED_SCOPES، فلا يوجد مسار يتخطّى تلك القائمة.
    assert.match(APPROVE, /const validScopes = requestedScopes\.filter\(\(s: string\) => ALLOWED_SCOPES\.includes\(s\)\)/);
    assert.match(APPROVE, /let grantedScopes = validScopes;/,
        'الافتراضي عند غياب granted_scopes يجب أن يكون validScopes');
});

test('اختيار فارغ يُرفض على الخادم لا على الواجهة فقط', () => {
    assert.match(APPROVE, /if \(!grantedScopes\.length\)/,
        'منح صفر صلاحية يجب أن يُرفض خادميًا');
});

test('الصلاحيات المرتفعة غير محدَّدة افتراضيًا', () => {
    // الخادم يقترح default_scopes بلا المرتفع، والواجهة تحترمه.
    assert.match(APPROVE, /default_scopes: validScopes\.filter\(\(s: string\) => !PRIVILEGED\.includes\(s\)\)/);
    assert.match(CONSENT, /info\.default_scopes/,
        'الواجهة يجب أن تقرأ default_scopes من الخادم');
    // ولو كان الخادم بنسخة أقدم لا ترسله، تشتقّه الواجهة بنفس القاعدة.
    assert.match(CONSENT, /scopes\.filter\(\(s\) => !describeScope\(s\)\.privileged\)/,
        'يجب وجود اشتقاق احتياطي لا رجوع صامت إلى «حدِّد كل شيء»');
});

test('الواجهة ترسل ما هو محدَّد فعلًا', () => {
    assert.match(CONSENT, /granted_scopes: granted/,
        'زر الموافقة يجب أن يمرّر الاختيار');
    assert.match(CONSENT, /\.oc-cb:checked/,
        'الاختيار يُقرأ من الخانات المحدَّدة');
});
