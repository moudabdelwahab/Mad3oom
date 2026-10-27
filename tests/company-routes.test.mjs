/**
 * خريطة صفحات لوحة الشركة ونماذج عرض صفحاتها الجديدة — دوال خالصة.
 *
 * الخريطة مصدر واحد للقائمة الجانبية ومسار التنقّل ورأس كل مجال؛ هنا نثبت أن
 * كل صفحة لها مجال وحاوية ورابط، وأن «متاحة» لا تفتح لدور ما لا يخصه.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    COMPANY_PAGES, COMPANY_GROUPS, COMPANY_ROUTES, pageAvailable, routeFromHash,
    groupOf, siblingsOf, breadcrumbFor, pageHeadFor
} from '../assets/js/company/company-routes.js';
import {
    overviewAlerts, permissionsView, grantState, REQUESTER_LABELS
} from '../assets/js/company/company-pages-model.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ── الخريطة ─────────────────────────────────────────────────────────────── */

test('كل صفحة في مجال واحد بالضبط، ولها اسم وحاوية ورابط في القائمة', () => {
    const html = read('company-dashboard/index.html');
    const nav = read('assets/components/company-sidebar.html');
    const seen = new Map();
    for (const group of COMPANY_GROUPS) {
        assert.ok(group.label && group.pages.length, `مجال بلا اسم أو صفحات: ${group.key}`);
        for (const page of group.pages) {
            assert.ok(!seen.has(page), `الصفحة ${page} في مجالين`);
            seen.set(page, group.key);
            assert.ok(COMPANY_PAGES[page]?.label, `الصفحة ${page} بلا اسم`);
            assert.ok(html.includes(`id="${page}TabContent"`), `الصفحة ${page} بلا حاوية`);
            assert.ok(nav.includes(`data-tab="${page}"`), `الصفحة ${page} بلا رابط في القائمة`);
        }
    }
    assert.deepEqual([...seen.keys()].sort(), Object.keys(COMPANY_PAGES).sort());
    assert.equal(COMPANY_ROUTES.length, Object.keys(COMPANY_PAGES).length);
});

test('المجالات التسعة كما في هيكل المعلومات', () => {
    assert.deepEqual(COMPANY_GROUPS.map(g => g.label), [
        'الرئيسية', 'الدعم والتذاكر', 'الفريق والصلاحيات', 'الاشتراك والفوترة',
        'التكاملات وواجهة API', 'التقارير والنشاط', 'الإشعارات', 'حساب الشركة', 'حسابي والأمان'
    ]);
    // بيانات الشركة منفصلة عن الحساب الشخصي
    assert.notEqual(groupOf('company').key, groupOf('profile').key);
    assert.equal(groupOf('security').key, groupOf('profile').key);
});

test('الروابط القديمة تبقى صالحة، والمجهول يعود إلى النظرة العامة', () => {
    for (const legacy of ['overview', 'members', 'subscriptions', 'tickets', 'customerTickets', 'inbox',
                          'support', 'notifications', 'api', 'integrations', 'reports', 'activity',
                          'profile', 'security']) {
        assert.equal(routeFromHash(`#${legacy}`), legacy, `رابط قديم انكسر: #${legacy}`);
    }
    assert.equal(routeFromHash('#usage'), 'usage');
    assert.equal(routeFromHash(''), 'overview');
    assert.equal(routeFromHash('#admin'), 'overview');
    assert.equal(routeFromHash('#../../etc'), 'overview');
});

test('الإتاحة حسب الدور: صفحات المدير لا تظهر للمشرف ولا لموظف الدعم', () => {
    const adminOnly = ['subscriptions', 'api', 'permissions', 'accessLog'];
    for (const page of adminOnly) {
        assert.equal(pageAvailable(page, { viewerRole: 'admin' }), true, page);
        assert.equal(pageAvailable(page, { viewerRole: 'supervisor' }), false, page);
        assert.equal(pageAvailable(page, { viewerRole: 'agent' }), false, page);
    }
    // العملاء: للمدير (الدعوة) والمشرف (القائمة)، لا لموظف الدعم
    assert.equal(pageAvailable('customers', { viewerRole: 'supervisor' }), true);
    assert.equal(pageAvailable('customers', { viewerRole: 'agent' }), false);
    // صفحات الجميع
    for (const page of ['overview', 'tickets', 'customerTickets', 'support', 'members', 'entitlements',
                        'usage', 'integrations', 'reports', 'activity', 'notifications', 'company',
                        'profile', 'security']) {
        assert.equal(pageAvailable(page, { viewerRole: 'agent' }), true, page);
    }
    assert.equal(pageAvailable('nope', { viewerRole: 'admin' }), false);
});

test('صندوق الرسائل لا يظهر إلا حين ترد القاعدة بصندوق', () => {
    assert.equal(pageAvailable('inbox', { viewerRole: 'admin', inbox: false }), false);
    assert.equal(pageAvailable('inbox', { viewerRole: 'admin' }), false);
    assert.equal(pageAvailable('inbox', { viewerRole: 'agent', inbox: true }), true);
});

test('مسار التنقّل ثلاثي في المجالات، وثنائي حين يطابق المجال الصفحة', () => {
    assert.deepEqual(breadcrumbFor('customerTickets'), ['لوحة الشركة', 'الدعم والتذاكر', 'تذاكر العملاء']);
    assert.deepEqual(breadcrumbFor('usage'), ['لوحة الشركة', 'الاشتراك والفوترة', 'الاستخدام والحدود']);
    assert.deepEqual(breadcrumbFor('overview'), ['لوحة الشركة', 'نظرة عامة']);
    assert.deepEqual(breadcrumbFor('notifications'), ['لوحة الشركة', 'الإشعارات']);
    assert.deepEqual(breadcrumbFor('company'), ['لوحة الشركة', 'بيانات الشركة']);
});

test('رأس المجال: الصفحات الشقيقة المتاحة فقط، والحالية معلَّمة', () => {
    const head = pageHeadFor('members', { viewerRole: 'agent' });
    assert.equal(head.title, 'الفريق والصلاحيات');
    assert.deepEqual(head.tabs.map(t => t.page), ['users', 'members'], 'موظف الدعم يرى صفحات المدير في رأس المجال');
    const admin = pageHeadFor('permissions', { viewerRole: 'admin' });
    assert.deepEqual(admin.tabs.map(t => t.page), ['users', 'members', 'customers', 'permissions', 'accessLog']);
    assert.deepEqual(admin.tabs.filter(t => t.current).map(t => t.page), ['permissions']);
    // المجال ذو الصفحة الواحدة بلا رأس (لا عنوان مكرّر فوق عنوان لوحته)
    assert.equal(pageHeadFor('notifications', { viewerRole: 'admin' }), null);
    assert.equal(pageHeadFor('overview', { viewerRole: 'admin' }), null);
    assert.deepEqual(siblingsOf('tickets', { viewerRole: 'admin', inbox: true }),
        ['tickets', 'customerTickets', 'inbox', 'support']);
});

/* ── تنبيهات النظرة العامة ──────────────────────────────────────────────── */

function dashboardWith({ subs = [], registration = { expiry_date: '2030-01-01', is_expired: false, days_to_expiry: 900 },
                         active = true } = {}) {
    return {
        company: { id: 'c', name: 'ش', is_owner: true },
        registration,
        subscriptions: subs,
        entitlements: [],
        access: { active_plans: active ? ['support'] : [], has_active_subscription: active }
    };
}

test('التنبيهات لمدير الشركة وحده، ومن الحمولة فقط', () => {
    const dash = dashboardWith({ registration: { expiry_date: '2020-01-01', is_expired: true, days_to_expiry: -5 } });
    assert.equal(overviewAlerts(dash, 'agent').length, 0);
    assert.equal(overviewAlerts(dash, 'supervisor').length, 0);
    const alerts = overviewAlerts(dash, 'admin');
    assert.equal(alerts[0].tone, 'danger');
    assert.equal(alerts[0].page, 'company');
    assert.equal(overviewAlerts(null, 'admin').length, 0);
});

test('اشتراك قارب على الانتهاء وطلب قيد المراجعة وغياب الاشتراك — كلٌّ يشير لصفحته', () => {
    const soon = { id: 's1', plan: 'support', plan_name_ar: 'باقة الدعم', status: 'active', is_active: true,
                   start_date: '2026-01-01', end_date: '2099-01-01', days_remaining: 5 };
    const pending = { id: 's2', plan: 'whatsapp', plan_name_ar: 'واتساب', status: 'pending', is_active: false };
    const alerts = overviewAlerts(dashboardWith({ subs: [soon, pending] }), 'admin');
    const titles = alerts.map(a => a.title);
    assert.ok(titles.some(t => /باقة الدعم ينتهي قريبًا/.test(t)), titles.join(' | '));
    assert.ok(titles.some(t => /1 طلب اشتراك قيد المراجعة/.test(t)));
    assert.ok(alerts.every(a => COMPANY_ROUTES.includes(a.page)));

    const none = overviewAlerts(dashboardWith({ active: false }), 'admin');
    assert.ok(none.some(a => a.title === 'لا يوجد اشتراك فعّال' && a.page === 'subscriptions'));
    // حال سليمة: لا تنبيه مختلق
    assert.deepEqual(overviewAlerts(dashboardWith(), 'admin'), []);
});

/* ── الأدوار والصلاحيات وسجل الوصول ─────────────────────────────────────── */

test('مصفوفة الصلاحيات تُقرأ كما رجّعتها القاعدة، وenabled لا يُفترض', () => {
    assert.equal(permissionsView(null), null);
    assert.equal(permissionsView({ enabled: true }), null, 'حمولة بلا كتالوج');
    const view = permissionsView({
        catalog: [{ key: 'tickets.assign', label: 'إسناد', supervisor: true, agent: 'yes' }],
        overrides: [{ user_id: 'u1', permission: 'tickets.assign', allowed: true },
                    { user_id: 'u1', permission: 'tickets.view_all', allowed: false }]
    });
    assert.equal(view.enabled, false, 'غياب enabled يعني للقراءة فقط');
    assert.equal(view.rows[0].supervisor, true);
    assert.equal(view.rows[0].agent, false, 'قيمة غير منطقية صريحة لا تُعدّ سماحًا');
    assert.equal(view.overridesCount, 2);
    assert.equal(view.overriddenUsers, 1);
});

test('حالة منح الوصول: ملغى، منتهٍ، ساري', () => {
    const now = new Date('2026-10-14T12:00:00Z');
    assert.equal(grantState({ revoked_at: '2026-10-10T00:00:00Z', expires_at: '2026-12-01' }, now).key, 'revoked');
    assert.equal(grantState({ expires_at: '2026-10-14T11:59:00Z' }, now).key, 'expired');
    assert.equal(grantState({ expires_at: '2026-10-14T13:00:00Z' }, now).key, 'active');
    assert.equal(REQUESTER_LABELS.support, 'فريق دعم مدعوم');
});

/* ── حدود الأمان في الوحدات الجديدة ─────────────────────────────────────── */

test('الصفحات الجديدة تقرأ وتكتب عبر RPC فقط، بلا معرّف شركة من الواجهة', () => {
    const data = read('assets/js/company/company-data.js');
    for (const fn of ['company_permissions_matrix', 'company_set_role_permission', 'company_access_log',
                      'my_ticket_wallet', 'cancel_my_subscription_request']) {
        assert.match(data, new RegExp(`rpc\\('${fn}'`), `${fn} ليس نداء RPC`);
    }
    const setRole = data.slice(data.indexOf("rpc('company_set_role_permission'"));
    assert.doesNotMatch(setRole.slice(0, 200), /company_id|p_company/, 'معرّف شركة يُرسل من الواجهة');
    for (const file of ['company-access.js', 'company-billing.js', 'company-overview.js', 'company-routes.js',
                        'company-pages-model.js', 'company-ui.js']) {
        const src = read(`assets/js/company/${file}`);
        assert.doesNotMatch(src, /\.from\(['"][a-z_]+['"]\)\s*\.(insert|update|delete|upsert)/, `${file} يكتب في جدول مباشرةً`);
        assert.doesNotMatch(src, /service_role|SERVICE_ROLE/, `${file} يذكر مفتاح الخدمة`);
    }
});

test('صفحة الصلاحيات لا تعرض مفاتيح تعديل حين تقول القاعدة إن الميزة مطفأة', () => {
    const src = read('assets/js/company/company-access.js');
    // الخلية في وضع القراءة شارة نصية؛ الـinput لا يُبنى إلا بعد فحص enabled
    const cell = src.slice(src.indexOf('function permissionCell'), src.indexOf('async function onToggle'));
    assert.match(cell, /if \(!enabled\) \{[\s\S]*?return `<span class="pill/);
    // فشل الحفظ يعيد القيمة ولا يعلن نجاحًا
    const toggle = src.slice(src.indexOf('async function onToggle'));
    assert.match(toggle, /if \(!result\.ok\) \{[\s\S]*?input\.checked = !next;[\s\S]*?return;/);
});
