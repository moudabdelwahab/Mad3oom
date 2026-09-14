/**
 * اختبارات قرار الوصول — الحاجز الذي يمنع حلقة التحويل.
 *
 * الحلقة التي حدثت فعلًا:
 *   لوحة الشركة → صفحة محمية → الحارس يرفض ويحوّل إلى login.html
 *   → login يجد الجلسة سليمة فيعيده إلى لوحة الشركة → نفس الدورة بلا نهاية.
 *
 * السبب أن القرار كان يجمع «مفيش جلسة» و«الرتبة غير مسموحة» في نفس القيمة
 * (`null`)، وكل مستدعٍ يترجمها إلى «روح صفحة الدخول». الاختبارات هنا تثبّت
 * الخاصية التي تجعل الحلقة مستحيلة:
 *
 *     ما دامت هناك جلسة، لا يمكن أن يكون القرار ANONYMOUS مهما كانت الرتبة.
 *
 * ANONYMOUS هي الحالة الوحيدة التي يسمح فيها الحارس بالتحويل إلى صفحة الدخول
 * (assets/js/page-guard.js)، فإثبات هذه الخاصية = إثبات استحالة الحلقة.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
    ACCESS, STAFF_ROLES, COMPANY_ROLES, MAIN_ADMIN_EMAIL,
    classifyAccess, isStaffIdentity, canImpersonate, accessMessageFor,
    isCompanyIdentity, isCompanyAdminPayload
} = await import('../assets/js/access-policy.js');

/* ── الخاصية المركزية ───────────────────────────────────────────────────── */

test('جلسة قائمة لا تُنتج ANONYMOUS أبدًا — أيًّا كانت الرتبة أو الصفحة', () => {
    // كل ما قد يحمله عمود role اليوم، ومنه أدوار الشركة الجديدة والرتبة
    // المتقاعدة. ولا واحدة منها يجوز أن تُرسل صاحبها لصفحة الدخول.
    const roles = ['user', 'customer', 'company_admin', 'company_user',
                   'super_user', 'platform_owner', 'admin', 'support', undefined, null, ''];
    const pages = [null, 'user', 'admin'];

    for (const role of roles) {
        for (const requiredRole of pages) {
            const { status } = classifyAccess({
                identity: { email: 'owner@company.test', role },
                requiredRole
            });
            assert.notEqual(
                status, ACCESS.ANONYMOUS,
                `الرتبة ${String(role)} على صفحة ${String(requiredRole)} أنتجت ANONYMOUS — ده مدخل حلقة التحويل`
            );
        }
    }
});

test('غياب الجلسة وحده يُنتج ANONYMOUS', () => {
    assert.equal(classifyAccess({ identity: null }).status, ACCESS.ANONYMOUS);
    assert.equal(classifyAccess({ identity: null, requiredRole: 'admin' }).status, ACCESS.ANONYMOUS);
    assert.equal(classifyAccess({}).status, ACCESS.ANONYMOUS);
});

/* ── حساب الشركة على صفحات بوابة العميل ─────────────────────────────────── */

test('حساب الشركة يدخل صفحات بوابة العميل — هي حسابه الشخصي', () => {
    // ده بالظبط الرابط اللي في Sidebar لوحة الشركة (customer-dashboard.html)
    for (const role of ['super_user', 'user', 'customer']) {
        const { status } = classifyAccess({
            identity: { email: 'owner@company.test', role },
            requiredRole: 'user'
        });
        assert.equal(status, ACCESS.AUTHORIZED, `رتبة ${role} مُنعت من بوابة العميل`);
    }
});

test('حساب الشركة على صفحة إدارية: FORBIDDEN لا ANONYMOUS', () => {
    // ده الرابط اللي كان بيعمل الحلقة: زر «إضافة مستخدم» → /admin/my-users.html
    const decision = classifyAccess({
        identity: { email: 'owner@company.test', role: 'super_user' },
        requiredRole: 'admin'
    });
    assert.equal(decision.status, ACCESS.FORBIDDEN);
    assert.equal(decision.reason, 'staff-only');
});

/* ── الطاقم ─────────────────────────────────────────────────────────────── */

test('الطاقم يدخل الصفحات الإدارية', () => {
    for (const role of STAFF_ROLES) {
        assert.equal(
            classifyAccess({ identity: { role }, requiredRole: 'admin' }).status,
            ACCESS.AUTHORIZED
        );
    }
    assert.equal(
        classifyAccess({ identity: { email: MAIN_ADMIN_EMAIL }, requiredRole: 'admin' }).status,
        ACCESS.AUTHORIZED
    );
});

test('الطاقم يُمنع من بوابة العميل إلا وهو داخل كعضو — ومع ذلك FORBIDDEN لا ANONYMOUS', () => {
    const denied = classifyAccess({ identity: { role: 'admin' }, requiredRole: 'user' });
    assert.equal(denied.status, ACCESS.FORBIDDEN);
    assert.equal(denied.reason, 'customer-only');

    const impersonating = classifyAccess({
        identity: { role: 'admin' }, requiredRole: 'user', impersonating: true
    });
    assert.equal(impersonating.status, ACCESS.AUTHORIZED);
});

test('super_user لم تعد رتبة طاقم — لا تفتح الصفحات الإدارية ولا تُقصى من بوابة العميل', () => {
    assert.equal(isStaffIdentity({ role: 'super_user' }), false);
    assert.equal(canImpersonate({ role: 'super_user' }), false);
});

/* ── الحساب الموقوف ─────────────────────────────────────────────────────── */

test('الحساب الموقوف يُعلَن موقوفًا، ولا يُرسَل لصفحة الدخول', () => {
    // التحويل كان يعيده فورًا (الجلسة سليمة) — نفس الحلقة بسبب مختلف
    const decision = classifyAccess({ identity: { role: 'user' }, banned: true, requiredRole: 'user' });
    assert.equal(decision.status, ACCESS.BANNED);
    assert.notEqual(decision.status, ACCESS.ANONYMOUS);
});

/* ── الرسائل ────────────────────────────────────────────────────────────── */

test('كل سبب رفض له رسالة مفهومة، وأي سبب غير معروف له بديل آمن', () => {
    for (const reason of ['staff-only', 'customer-only', 'account-banned']) {
        assert.ok(accessMessageFor(reason).title.length > 0);
    }
    const fallback = accessMessageFor('something-new');
    assert.ok(fallback.title.length > 0);
    assert.ok(fallback.text.length > 0);
});

test('تعريف الطاقم واحد في مصدري القرار', async () => {
    // account-destination.js يقرر «أين يذهب»، وaccess-policy.js يقرر «ماذا يرى».
    // اختلافهما على معنى «طاقم» هو بالضبط ما يصنع حلقة: أحدهما يرسله والآخر يرفضه.
    const src = await import('node:fs/promises')
        .then(fs => fs.readFile(new URL('../assets/js/account-destination.js', import.meta.url), 'utf8'));
    const match = src.match(/const STAFF_ROLES = \[([^\]]*)\]/);
    assert.ok(match, 'STAFF_ROLES غير موجودة في account-destination.js');
    const other = match[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
    assert.deepEqual([...other].sort(), [...STAFF_ROLES].sort());
});

/* ── الفصل الصارم بين نطاقات السلطة (الترحيل 035) ───────────────────────── */

test('دور شركة لا يفتح لوحة الإدارة بأي حال', () => {
    for (const role of ['company_admin', 'company_user']) {
        const decision = classifyAccess({ identity: { email: 'owner@co.test', role }, requiredRole: 'admin' });
        assert.equal(decision.status, ACCESS.FORBIDDEN, `${role} فتح صفحة إدارة`);
        assert.equal(decision.reason, 'staff-only');
    }
});

test('دور شركة ليس طاقمًا، والطاقم ليس دور شركة', () => {
    assert.equal(isStaffIdentity({ role: 'company_admin' }), false);
    assert.equal(isStaffIdentity({ role: 'company_user' }), false);
    // والرتبة المتقاعدة كذلك
    assert.equal(isStaffIdentity({ role: 'super_user' }), false);

    for (const role of STAFF_ROLES) {
        assert.equal(isStaffIdentity({ role }), true, `${role} لم يُعرَف كطاقم`);
        assert.equal(COMPANY_ROLES.includes(role), false, `${role} في قائمتي السلطة معًا`);
    }
});

test('قائمة الطاقم لا تتقاطع مع قائمة أدوار الشركة إطلاقًا', () => {
    const overlap = STAFF_ROLES.filter(r => COMPANY_ROLES.includes(r));
    assert.deepEqual(overlap, [], `تقاطع بين النطاقين: ${overlap.join(', ')}`);
});

test('دور شركة لا يملك «الدخول كعضو»', () => {
    assert.equal(canImpersonate({ role: 'company_admin' }), false);
    assert.equal(canImpersonate({ role: 'company_user' }), false);
});

test('حساب شركة يُسمح له بصفحات بوابة العميل — ليس طاقمًا يُمنع منها', () => {
    for (const role of ['company_admin', 'company_user']) {
        const decision = classifyAccess({ identity: { email: 'x@co.test', role }, requiredRole: 'user' });
        assert.equal(decision.status, ACCESS.AUTHORIZED, `${role} مُنع من صفحة عميل`);
    }
});

test('تصنيف هوية الشركة يقرأ الدور ولا يخترعه', () => {
    assert.equal(isCompanyIdentity({ role: 'company_admin' }), true);
    assert.equal(isCompanyIdentity({ role: 'company_user' }), true);
    assert.equal(isCompanyIdentity({ role: 'user' }), false);
    assert.equal(isCompanyIdentity({ role: 'admin' }), false);
    assert.equal(isCompanyIdentity({}), false);
});

test('مدير الشركة يُقرأ من حمولة القاعدة لا من الرتبة وحدها', () => {
    assert.equal(isCompanyAdminPayload({ company_role: 'company_admin' }), true);
    assert.equal(isCompanyAdminPayload({ company_role: 'company_user' }), false);
    // حمولة بلا قرار = لا صلاحية. الغياب ليس سماحًا.
    assert.equal(isCompanyAdminPayload({}), false);
    assert.equal(isCompanyAdminPayload(null), false);
});
