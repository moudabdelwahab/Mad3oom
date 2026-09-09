/**
 * اختبارات إضافة مستخدم للشركة — الجزء الخالص + الضوابط الثابتة على الكود.
 *
 * الجزء التفاعلي (فتح النافذة، الإرسال، حالة التحميل، تحديث القائمة) مُختبَر
 * في متصفح فعلي في tests/company-add-member.render.test.mjs. اللي هنا:
 *   1) قواعد التحقق كدوال خالصة.
 *   2) ضوابط ثابتة تمنع رجوع الخلل الأصلي: أي رابط من لوحة الشركة إلى
 *      /admin/، وأي حارس يترجم «مصرَّح لكن غير مخوَّل» إلى صفحة الدخول.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const { validateMemberForm, canManageMembers } =
    await import('../assets/js/company/company-model.js');

/* ── التحقق من النموذج ──────────────────────────────────────────────────── */

const VALID = {
    fullName: 'محمد العلي',
    email: 'member@company.test',
    password: 'Passw0rdX',
    passwordConfirm: 'Passw0rdX'
};

test('النموذج الصحيح يمرّ', () => {
    assert.deepEqual(validateMemberForm(VALID), { isValid: true, errors: {} });
});

test('الحقول الثلاثة إلزامية — نفس ما ترفضه create-sub-user بـ400', () => {
    const { isValid, errors } = validateMemberForm({});
    assert.equal(isValid, false);
    assert.ok(errors.fullName);
    assert.ok(errors.email);
    assert.ok(errors.password);
});

test('البريد غير الصالح يُرفض قبل الرحلة للخادم', () => {
    for (const email of ['نص', 'a@b', 'a b@c.com', '@company.test']) {
        const { isValid, errors } = validateMemberForm({ ...VALID, email });
        assert.equal(isValid, false, `قُبل بريد غير صالح: ${email}`);
        assert.ok(errors.email);
    }
});

test('كلمة المرور تتبع نفس قاعدة المنصة: 8 أحرف + كبير + صغير + رقم', () => {
    const weak = ['short1A', 'alllowercase1', 'ALLUPPERCASE1', 'NoDigitsHere'];
    for (const password of weak) {
        const { isValid, errors } =
            validateMemberForm({ ...VALID, password, passwordConfirm: password });
        assert.equal(isValid, false, `قُبلت كلمة مرور ضعيفة: ${password}`);
        assert.ok(errors.password);
    }
});

test('عدم تطابق التأكيد يُرفض، ولا يُبلَّغ عنه كخطأ في كلمة المرور نفسها', () => {
    const { isValid, errors } = validateMemberForm({ ...VALID, passwordConfirm: 'Passw0rdY' });
    assert.equal(isValid, false);
    assert.ok(errors.passwordConfirm);
    assert.equal(errors.password, undefined);
});

test('المسافات حول الاسم والبريد لا تُعدّ محتوى', () => {
    const { isValid, errors } = validateMemberForm({ ...VALID, fullName: '   ', email: '   ' });
    assert.equal(isValid, false);
    assert.ok(errors.fullName);
    assert.ok(errors.email);
});

/* ── الصلاحية تُقرأ ولا تُحسَب ──────────────────────────────────────────── */

test('can_manage تُقرأ من حمولة القاعدة حرفيًا — والواجهة لا تخمّنها', () => {
    assert.equal(canManageMembers({ can_manage: true }), true);
    assert.equal(canManageMembers({ can_manage: false }), false);
    assert.equal(canManageMembers({}), false);
    assert.equal(canManageMembers(null), false);
    // قيم رخوة لا تُقبل: الغياب أو أي شكل آخر معناه "لا"
    assert.equal(canManageMembers({ can_manage: 'true' }), false);
    assert.equal(canManageMembers({ can_manage: 1 }), false);
    // ملكية الشركة وحدها لا تكفي — الامتياز شرط، والقاعدة هي من يجمعهما
    assert.equal(canManageMembers({ is_owner: true, can_manage: false }), false);
});

/* ── ضوابط ثابتة تمنع رجوع الخلل ────────────────────────────────────────── */

const COMPANY_SHELL = [
    'company-dashboard/index.html',
    'assets/js/company/company-dashboard.js',
    'assets/js/company/company-data.js',
    'assets/js/company/company-model.js',
    'assets/js/company/company-onboarding.js',
    'assets/components/customer-sidebar.html',
    'assets/js/customer-sidebar.js'
];

test('لا رابط واحد من لوحة الشركة أو قائمتها الجانبية يؤدي إلى /admin/', () => {
    // ده الفحص الكامل للـSidebar المطلوب: القائمة الجانبية للوحة الشركة هي
    // نفسها قشرة بوابة العميل، فبنفحصها كلها لا الرابط الذي ظهر فيه الخطأ.
    for (const rel of COMPANY_SHELL) {
        const src = read(rel);
        const hits = [...src.matchAll(/["'`]\/admin\/[^"'`]*/g)].map(m => m[0]);
        assert.deepEqual(hits, [], `${rel} ما زال يشير إلى صفحة إدارية: ${hits.join(', ')}`);
    }
});

test('زر «إضافة مستخدم» يفتح نافذة في مكانه، ولا ينقل المستخدم لأي صفحة', () => {
    const src = read('assets/js/company/company-dashboard.js');
    assert.ok(src.includes('addMemberModal'), 'النافذة غير مربوطة');
    assert.ok(src.includes('createCompanyMember'), 'مسار الإنشاء غير مستخدم');
    // نفحص النصوص المقتبسة وحدها: التعليقات تشرح الخلل القديم وتذكر اسم
    // الصفحة عمدًا، لكن أي مسار **قابل للتنقّل** إليها ممنوع.
    const navigable = [...src.matchAll(/["'`][^"'`\n]*my-users[^"'`\n]*["'`]/g)].map(m => m[0]);
    assert.deepEqual(navigable, [], `ما زال هناك مسار إلى صفحة إدارة المستخدمين: ${navigable.join(', ')}`);
});

test('مسار الإنشاء ينادي create-sub-user الموجودة، ولا يخترع API جديدًا', () => {
    const src = read('assets/js/company/company-data.js');
    assert.match(src, /functions\.invoke\(\s*'create-sub-user'/);
    // super_user_id لا يُرسَل من العميل إطلاقًا — الدالة تشتقّه من هوية
    // المنادي المتحقَّق منها. نمنعه كمفتاح في أي حمولة (ذِكره في تعليق شرح).
    assert.doesNotMatch(src, /super_user_id\s*:/,
        'التبعية تُرسَل من العميل — ده بالظبط باب تزوير تبعية الحساب');
});

test('الصلاحية تُعاد قراءتها من الخادم قبل الإنشاء، لا من حالة الصفحة', () => {
    const src = read('assets/js/company/company-data.js');
    const fn = src.slice(src.indexOf('export async function createCompanyMember'));
    const permissionAt = fn.indexOf('fetchCompanyMembers');
    const invokeAt = fn.indexOf('functions.invoke');
    assert.ok(permissionAt > -1, 'مفيش إعادة تحقق من الصلاحية قبل الإنشاء');
    assert.ok(permissionAt < invokeAt, 'التحقق من الصلاحية يحدث بعد النداء لا قبله');
    assert.match(fn, /can_manage\s*!==\s*true/, 'الرفض غير مبني على can_manage القادمة من القاعدة');
});

/* ── الحرّاس: التحويل لصفحة الدخول عند غياب الجلسة فقط ──────────────────── */

const GUARDED_PAGES = [
    'customer-dashboard.js',
    'assets/js/customer/help-center.js',
    'assets/js/chat-logic.js',
    'assets/js/admin/auth.js',
    'assets/js/company/company-dashboard.js'
];

test('كل حارس صفحة يمرّ عبر guardPage — لا ترجمة يدوية لـnull إلى login', () => {
    for (const rel of GUARDED_PAGES) {
        const src = read(rel);
        assert.match(src, /guardPage\(/, `${rel} لا يستخدم الحارس الموحّد`);
        assert.doesNotMatch(
            src, /\brequireAuth\s*\(/,
            `${rel} ما زال ينادي requireAuth مباشرةً — وهي تجمع 401 و403 في null واحدة`
        );
    }
});

test('الحارس الموحّد وحده يملك التحويل لصفحة الدخول، وفي حالة ANONYMOUS فقط', () => {
    const src = read('assets/js/page-guard.js');
    // كل إشارة إلى صفحة الدخول في الحارس
    const loginRefs = [...src.matchAll(/location\.(replace|href|assign)\(\s*LOGIN_PATH/g)];
    assert.equal(loginRefs.length, 2,
        'عدد مسارات التحويل لصفحة الدخول تغيّر — راجعها واحدًا واحدًا');

    // الأول: ANONYMOUS. الثاني: بعد تسجيل خروج صريح بفعل المستخدم.
    const anonymousBlock = src.slice(
        src.indexOf('access.status === ACCESS.ANONYMOUS'),
        src.indexOf('if (typeof options.onDenied')
    );
    assert.match(anonymousBlock, /location\.replace\(\s*LOGIN_PATH/);

    // FORBIDDEN و BANNED لا يحوّلان إطلاقًا
    const deniedFn = src.slice(src.indexOf('export function renderAccessDenied'));
    const autoNav = deniedFn.match(/location\.(replace|href|assign)/g) || [];
    assert.equal(autoNav.length, 2,
        'التنقّل داخل لوحة الرفض يجب أن يكون بزرين بفعل المستخدم فقط');
    assert.ok(deniedFn.includes('addEventListener(\'click\''),
        'التنقّل في لوحة الرفض ليس مربوطًا بفعل المستخدم');
});
