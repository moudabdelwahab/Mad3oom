/**
 * اختبارات الوحدات الخالصة في لوحة الشركة.
 *
 * الوحدات دي بتحدد اللي صاحب الشركة بيشوفه (حالة الاشتراك، الامتيازات،
 * حالة السجل التجاري) وقواعد نموذج بيانات الشركة. بتتّختبر هنا بمعزل عن
 * المتصفح وعن قاعدة البيانات — قرار الصلاحية نفسه مُختبَر في
 * tests/sql/company-dashboard.test.sql لأنه بيتاخد في القاعدة مش هنا.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
    subscriptionStatusInfo, activeSubscriptions, summarizeSubscriptions,
    registrationInfo, companyAccess, hasEntitlement, entitlementsByPlan,
    validateCompanyForm, planRequiresCompany
} = await import('../assets/js/company/company-model.js');

function sub(over = {}) {
    return {
        id: 's1', plan: 'whatsapp', plan_name_ar: 'واتساب بيزنس',
        status: 'active', billing_cycle: 'monthly',
        start_date: '2026-01-01T00:00:00Z', end_date: '2026-12-01T00:00:00Z',
        is_active: true, days_remaining: 90, ...over
    };
}

function dashboard(over = {}) {
    return {
        company: { id: 'c1', name: 'شركة أ', cr_number: '1010', is_owner: true },
        registration: { expiry_date: '2027-01-01', is_expired: false, days_to_expiry: 300 },
        subscriptions: [sub()],
        entitlements: [
            { feature_key: 'whatsapp_sender', name_ar: 'إرسال واتساب', description: '', granted_by: ['whatsapp'] }
        ],
        access: { active_plans: ['whatsapp'], has_active_subscription: true },
        ...over
    };
}

/* ── حالة الاشتراك ──────────────────────────────────────────────────────── */

test('كل حالة مخزّنة في whatsapp_subscriptions لها تسمية للشركة', () => {
    for (const status of ['active', 'pending', 'expired', 'rejected']) {
        const info = subscriptionStatusInfo(sub({ status, is_active: status === 'active' }));
        assert.ok(info.label && info.label !== 'غير محددة', `الحالة ${status} بلا تسمية`);
        assert.ok(info.pill, `الحالة ${status} بلا شكل`);
    }
});

test('صف حالته active لكن تاريخه فات يُعرض منتهيًا', () => {
    // القاعدة بتحسب is_active = (status='active' AND end_date > now())،
    // والعرض لازم يتبع نفس التعريف مش عمود status وحده.
    assert.equal(subscriptionStatusInfo(sub({ status: 'active', is_active: false })).label, 'منتهٍ');
    assert.equal(subscriptionStatusInfo(sub({ status: 'active', is_active: true })).label, 'فعّال');
});

test('الحالة غير المعروفة لا تُعرض كنص خام', () => {
    assert.equal(subscriptionStatusInfo(sub({ status: 'some_internal_state' })).label, 'غير محددة');
    assert.equal(subscriptionStatusInfo(null).label, 'غير محددة');
});

test('الفعّال يُحسب من is_active الآتية من القاعدة فقط', () => {
    const list = [sub({ id: 'a' }), sub({ id: 'b', status: 'expired', is_active: false }), sub({ id: 'c', status: 'pending', is_active: false })];
    assert.deepEqual(activeSubscriptions(list).map(s => s.id), ['a']);
    assert.deepEqual(activeSubscriptions(null), []);
});

test('الملخّص يعدّ كل حالة ويجد أقرب اشتراك على الانتهاء', () => {
    const list = [
        sub({ id: 'a', days_remaining: 90 }),
        sub({ id: 'b', plan: 'support', days_remaining: 12 }),
        sub({ id: 'c', status: 'pending', is_active: false }),
        sub({ id: 'd', status: 'expired', is_active: false })
    ];
    const summary = summarizeSubscriptions(list);
    assert.equal(summary.total, 4);
    assert.equal(summary.active, 2);
    assert.equal(summary.pending, 1);
    assert.equal(summary.expired, 1);
    assert.equal(summary.nearestExpiry.id, 'b');
    assert.equal(summary.daysToNearestExpiry, 12);
});

test('الملخّص بلا اشتراكات لا ينهار', () => {
    const summary = summarizeSubscriptions([]);
    assert.equal(summary.active, 0);
    assert.equal(summary.nearestExpiry, null);
    assert.equal(summary.daysToNearestExpiry, null);
});

/* ── السجل التجاري ──────────────────────────────────────────────────────── */

test('حالة السجل التجاري تتبع تاريخ الانتهاء', () => {
    assert.equal(registrationInfo(null).tone, 'neutral');
    assert.equal(registrationInfo({ expiry_date: null }).hasDate, false);
    assert.equal(registrationInfo({ expiry_date: '2020-01-01', is_expired: true, days_to_expiry: -100 }).tone, 'danger');
    assert.equal(registrationInfo({ expiry_date: '2026-10-01', is_expired: false, days_to_expiry: 20 }).tone, 'warning');
    assert.equal(registrationInfo({ expiry_date: '2028-01-01', is_expired: false, days_to_expiry: 400 }).tone, 'success');
});

/* ── الوصول والامتيازات ─────────────────────────────────────────────────── */

test('لا شركة يعني لا وصول', () => {
    const access = companyAccess(null);
    assert.equal(access.hasCompany, false);
    assert.equal(access.hasActiveSubscription, false);
    assert.deepEqual(access.activePlans, []);
});

test('الوصول يُقرأ من حمولة القاعدة لا من اجتهاد الواجهة', () => {
    const access = companyAccess(dashboard());
    assert.equal(access.hasCompany, true);
    assert.equal(access.hasActiveSubscription, true);
    assert.equal(access.isOwner, true);
    assert.deepEqual(access.activePlans, ['whatsapp']);
});

test('العضو الفرعي ليس مالكًا', () => {
    const d = dashboard();
    d.company.is_owner = false;
    assert.equal(companyAccess(d).isOwner, false);
});

test('انتهاء الاشتراك يُسقط الوصول والامتيازات', () => {
    const d = dashboard({
        subscriptions: [sub({ status: 'expired', is_active: false })],
        entitlements: [],
        access: { active_plans: [], has_active_subscription: false }
    });
    assert.equal(companyAccess(d).hasActiveSubscription, false);
    assert.equal(hasEntitlement(d, 'whatsapp_sender'), false);
    assert.deepEqual(entitlementsByPlan(d), []);
});

test('الامتيازات تُجمَّع تحت الباقة التي منحتها', () => {
    const d = dashboard({
        subscriptions: [
            sub({ id: 'a', plan: 'whatsapp', plan_name_ar: 'واتساب بيزنس' }),
            sub({ id: 'b', plan: 'support', plan_name_ar: 'الدعم الفني' })
        ],
        entitlements: [
            { feature_key: 'whatsapp_sender', name_ar: 'إرسال واتساب', granted_by: ['whatsapp'] },
            { feature_key: 'support_tickets', name_ar: 'تذاكر الدعم', granted_by: ['support'] },
            { feature_key: 'api_tokens', name_ar: 'مفاتيح API', granted_by: ['support'] }
        ],
        access: { active_plans: ['whatsapp', 'support'], has_active_subscription: true }
    });
    const groups = entitlementsByPlan(d);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map(g => g.planKey), ['whatsapp', 'support']);
    assert.deepEqual(groups[0].features.map(f => f.feature_key), ['whatsapp_sender']);
    assert.equal(groups[1].features.length, 2);
});

test('امتياز ممنوح من باقة غير فعّالة لا يظهر تحتها', () => {
    // الباقة الشاملة منتهية، وواتساب فعّالة: الامتياز يظهر تحت واتساب فقط
    const d = dashboard({
        subscriptions: [
            sub({ id: 'a', plan: 'whatsapp', plan_name_ar: 'واتساب بيزنس' }),
            sub({ id: 'b', plan: 'bundle', plan_name_ar: 'الباقة الشاملة', status: 'expired', is_active: false })
        ],
        entitlements: [
            { feature_key: 'whatsapp_sender', name_ar: 'إرسال واتساب', granted_by: ['whatsapp', 'bundle'] }
        ],
        access: { active_plans: ['whatsapp'], has_active_subscription: true }
    });
    const groups = entitlementsByPlan(d);
    assert.deepEqual(groups.map(g => g.planKey), ['whatsapp']);
});

/* ── نموذج بيانات الشركة ────────────────────────────────────────────────── */

test('البيانات القانونية الثلاثة إلزامية — نفس قواعد القاعدة', () => {
    const bad = validateCompanyForm({ companyName: ' ', crNumber: '', crExpiry: '' });
    assert.equal(bad.isValid, false);
    assert.ok(bad.errors.companyName);
    assert.ok(bad.errors.crNumber);
    assert.ok(bad.errors.crExpiry);
});

test('نموذج صحيح يمر، والبيانات الاختيارية لا تُطلب', () => {
    const good = validateCompanyForm({ companyName: 'شركة أ', crNumber: '1010101010', crExpiry: '2027-01-01' });
    assert.equal(good.isValid, true);
    assert.deepEqual(good.errors, {});
});

test('تاريخ غير صالح وبريد غير صالح يُرفضان', () => {
    assert.ok(validateCompanyForm({ companyName: 'شركة أ', crNumber: '1010101010', crExpiry: 'ليس تاريخًا' }).errors.crExpiry);
    assert.ok(validateCompanyForm({
        companyName: 'شركة أ', crNumber: '1010101010', crExpiry: '2027-01-01', companyEmail: 'ليس بريدًا'
    }).errors.companyEmail);
});

test('استلزام الشركة قرار بيانات لا قائمة أسماء في الكود', () => {
    const plans = [
        { key: 'whatsapp', requires_company: true },
        { key: 'personal', requires_company: false }
    ];
    assert.equal(planRequiresCompany(plans, 'whatsapp'), true);
    assert.equal(planRequiresCompany(plans, 'personal'), false);
    assert.equal(planRequiresCompany(plans, 'plan_غير_موجود'), false);
    // باقة جديدة تُضاف كصف في قاعدة البيانات وتشتغل فورًا
    assert.equal(planRequiresCompany([...plans, { key: 'enterprise', requires_company: true }], 'enterprise'), true);
});
