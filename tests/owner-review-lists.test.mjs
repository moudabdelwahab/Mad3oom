/**
 * صفحات/أقسام المراجعة في لوحة المالك (F1) — اختبارات ثابتة بلا متصفح.
 *
 * يثبت:
 *   ① الصفحتان الجديدتان (طلبات الحسابات، دليل العملاء) موجودتان بوحدتيهما،
 *      وقسم طلبات الشركات في owner/stores.html موجود بفلاتره
 *   ② لا رابط من كود المالك الملموس هنا إلى /admin/ — الروابط المعاد توجيهها
 *      تقود إلى /owner/ أو إلى مرساة داخل الصفحة نفسها
 *      (استثناء مقصود واحد: استيراد customers-model.js من /assets/js/admin/
 *      — إعادة استخدام منطق خالص، لا رابط لوحة)
 *   ③ وحدات الصفحات تنادي دوال القاعدة المعتمدة بأسمائها، ولا تنشئ طلبًا
 *      من الدليل (account_request_submit ليس مسار مالك)
 *   ④ المنطق الخالص لقسم طلبات الشركات: غير-المتاجر فقط، وتسمية الباقة،
 *      والرفض بلا سبب مرفوض قبل النداء
 *   ⑤ مساعدات customers-model المعاد استخدامها: حال زر الموافقة، ونص النتيجة،
 *      وبناء فلاتر الدليل
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    isNonStoreCompanyRequest, companyRequestPlanLabel, companyRequestReviewError,
    COMPANY_REQUEST_STATUS_LABELS
} from '../assets/js/owner/company-requests-model.js';
import {
    approvalState, decisionResultText, directoryFilters, pageSummary
} from '../assets/js/admin/customers-model.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ── الوجود ─────────────────────────────────────────────────────────────── */

test('F1: صفحتا المالك الجديدتان وقسم طلبات الشركات موجودة', () => {
    for (const f of ['owner/account-requests.html', 'owner/customers.html',
                     'assets/js/owner/pages/account-requests.js', 'assets/js/owner/pages/customers.js',
                     'assets/js/owner/company-requests-model.js']) {
        assert.ok(fs.existsSync(path.join(ROOT, f)), `ملف مفقود: ${f}`);
    }
    const stores = read('owner/stores.html');
    assert.ok(stores.includes('id="companyRequests"'), 'قسم طلبات الشركات مفقود من stores.html');
    assert.ok(stores.includes('id="companyReqStatus"'), 'فلتر حالة طلبات الشركات مفقود');
    assert.ok(stores.includes('id="companyReqSearch"'), 'بحث طلبات الشركات مفقود');
    for (const f of ['owner/account-requests.html', 'owner/customers.html']) {
        const html = read(f);
        assert.ok(html.includes('id="ownerGate"'), `${f}: بلا بوابة`);
        assert.ok(html.includes('id="ownerContent"'), `${f}: بلا ownerContent`);
        assert.ok(html.includes('id="pageStatus"'), `${f}: بلا pageStatus`);
        assert.ok(html.includes('bootOwnerPage') || html.includes('pages/account-requests.js') || html.includes('pages/customers.js'), `${f}: بلا وحدة صفحة`);
    }
});

/* ── لا روابط /admin/ ───────────────────────────────────────────────────── */

test('F1: لا رابط من كود المالك الملموس إلى /admin/', () => {
    const files = [
        'owner-dashboard.html',
        'owner/account-requests.html', 'owner/customers.html', 'owner/stores.html',
        'assets/js/owner/pages/account-requests.js', 'assets/js/owner/pages/customers.js',
        'assets/js/owner/pages/accounts.js', 'assets/js/owner/pages/stores.js'
    ];
    for (const f of files) {
        // «المستخدمون» استثناء قائم موثّق في tests/owner-pages.render.test.mjs
        // (data-tab يفتح القسم داخل اللوحة، والرابط احتياط) — خارج نطاق F1
        const src = f === 'owner-dashboard.html'
            ? read(f).replaceAll('href="/admin/users.html"', '')
            : read(f);
        assert.ok(!src.includes('href="/admin/'), `${f}: رابط href إلى /admin/`);
        assert.ok(!src.includes("href='/admin/"), `${f}: رابط href إلى /admin/`);
        assert.ok(!src.includes('location.href = \'/admin/'), `${f}: تحويل إلى /admin/`);
        assert.ok(!src.includes('location.href = "/admin/'), `${f}: تحويل إلى /admin/`);
    }
    // إعادة التوجيه نفسها: روابط الحوكمة تقود إلى صفحتي المالك الجديدتين
    const dash = read('owner-dashboard.html');
    assert.ok(dash.includes('href="/owner/account-requests.html"'), 'رابط طلبات الحسابات لم يُعاد توجيهه');
    assert.ok(dash.includes('href="/owner/customers.html"'), 'رابط إدارة العملاء لم يُعاد توجيهه');
    const accounts = read('assets/js/owner/pages/accounts.js');
    assert.ok(!accounts.includes('/admin/customers.html'), 'accounts.js ما زال يشير إلى /admin/customers.html');
    assert.ok(accounts.includes('/owner/customers.html'), 'accounts.js لا يشير إلى دليل المالك');
    const stores = read('assets/js/owner/pages/stores.js');
    assert.ok(!stores.includes('/admin/company-requests.html'), 'stores.js ما زال يشير إلى /admin/company-requests.html');
    assert.ok(stores.includes('href="#storeRequests"') || stores.includes('href="#companyRequests"'),
        'stores.js: رابط التشخيص لم يُعاد إلى مرساة داخل الصفحة');
});

/* ── نداءات القاعدة ─────────────────────────────────────────────────────── */

test('F1: صفحات المراجعة تنادي دوال القاعدة المعتمدة بأسمائها', () => {
    const ar = read('assets/js/owner/pages/account-requests.js');
    for (const rpc of ['account_requests_overview', 'owner_account_requests', 'owner_account_request_details',
                       'owner_decide_account_request', 'admin_customer_filter_options']) {
        assert.ok(ar.includes(`'${rpc}'`), `account-requests.js لا ينادي ${rpc}`);
    }
    assert.ok(!ar.includes('my_account_requests'), 'صفحة المالك لا تعرض فرع مقدّم الطلبات');
    assert.ok(!ar.includes('account_request_cancel'), 'صفحة المالك لا تعرض إلغاء مقدّم الطلب');
    assert.ok(ar.includes('writeResult(res'), 'account-requests.js: قرار طلب الحساب بلا إثبات نجاح (writeResult)');

    const cm = read('assets/js/owner/pages/customers.js');
    for (const rpc of ['admin_customer_filter_options', 'admin_customer_directory', 'owner_account_details',
                       'admin_customer_details', 'customer_manager_assign']) {
        assert.ok(cm.includes(`'${rpc}'`), `customers.js لا ينادي ${rpc}`);
    }
    assert.ok(!cm.includes("rpc('account_request_submit'"), 'الدليل لا ينشئ طلب حساب (ليس مسار مالك)');
    assert.ok(cm.includes('writeResult(res'), 'customers.js: إسناد مدير الحساب بلا إثبات نجاح (writeResult)');

    const st = read('assets/js/owner/pages/stores.js');
    for (const rpc of ['admin_list_company_account_requests', 'admin_review_company_account_request']) {
        assert.ok(st.includes(`'${rpc}'`), `stores.js لا ينادي ${rpc}`);
    }
    assert.ok(st.includes('fetchStandaloneProofUrl'), 'stores.js لا يستخدم تنزيل الإثبات الموقّع');
    assert.ok(st.includes('writeResult(await rpc(\'admin_review_company_account_request\''), 'stores.js: قرار طلب الشركة بلا إثبات نجاح (writeResult)');
    assert.ok(st.includes('owner_store_requests'), 'stores.js: قسم المتاجر ما زال قائمًا');
    assert.ok(st.includes('owner_store_request_decide'), 'stores.js: قرار المتاجر ما زال قائمًا');
});

/* ── المنطق الخالص: طلبات الشركات ───────────────────────────────────────── */

test('F1: قسم طلبات الشركات يعرض غير-المتاجر فقط', () => {
    assert.equal(isNonStoreCompanyRequest({ account_kind: 'company' }), true);
    assert.equal(isNonStoreCompanyRequest({ account_kind: null }), true);
    assert.equal(isNonStoreCompanyRequest({}), true);
    assert.equal(isNonStoreCompanyRequest({ account_kind: 'ecommerce_store' }), false);
    assert.equal(isNonStoreCompanyRequest(null), false);
    assert.equal(companyRequestPlanLabel({ requested_plan: 'ultimate', requested_plan_name_ar: 'الفائقة', requested_billing_cycle: 'monthly' }), 'الفائقة (شهري)');
    assert.equal(companyRequestPlanLabel({ requested_plan: 'support', requested_billing_cycle: 'yearly' }), 'support (سنوي)');
    assert.equal(companyRequestPlanLabel({}), '—');
    assert.equal(COMPANY_REQUEST_STATUS_LABELS.pending, 'قيد المراجعة');
    assert.equal(companyRequestReviewError({ decision: 'reject', note: '' }), 'اكتب سبب الرفض — سيظهر للعميل في الإشعار.');
    assert.equal(companyRequestReviewError({ decision: 'reject', note: 'بيانات ناقصة' }), null);
    assert.equal(companyRequestReviewError({ decision: 'approve', note: '' }), null);
    assert.match(companyRequestReviewError({ decision: 'maybe', note: '' }), /غير معروف/);
});

/* ── المنطق الخالص المعاد استخدامه: customers-model ─────────────────────── */

test('F1: حال زر الموافقة ونص النتيجة وفلاتر الدليل (customers-model)', () => {
    // موافقة مفعّلة فقط حين التنفيذ متاح والشروط متحققة والتحقق حديث
    assert.deepEqual(approvalState({ status: 'pending', execution: { available: true }, checks: [{ code: 'company_exists', ok: true }], can_decide: true }),
        { enabled: true, label: 'موافقة وتنفيذ' });
    assert.equal(approvalState({ status: 'pending', self_requested: true }).enabled, false);
    assert.equal(approvalState({ status: 'pending', execution: { available: false, missing: ['company_isolation_enforced'] } }).label, 'التنفيذ غير متاح بعد');
    assert.equal(approvalState({ status: 'approved' }).label, 'نهائي');
    assert.match(decisionResultText({ status: 'approved', primary: true, direct_relationship_ended: true }),
        /أصبح العميل عضوًا أساسيًا في الشركة/);
    assert.equal(decisionResultText({ status: 'rejected' }), 'رُفض الطلب.');
    assert.equal(decisionResultText({ status: 'approved', outcome: 'failed', code: 'execution_failed' }), 'تعذّر التنفيذ ولم يتغير شيء. يمكن إعادة المحاولة أو رفض الطلب.');
    // فلاتر الدليل: القيم الفارغة لا تُرسل، والترتيب ينقسم إلى حقل واتجاه
    assert.deepEqual(directoryFilters({ view: 'suspended', sort: 'full_name:asc', limit: 50, offset: 0, q: '  ' }),
        { view: 'suspended', sort: 'full_name', dir: 'asc', limit: 50, offset: 0 });
    assert.equal(pageSummary(0, 0, 0), 'لا نتائج');
    assert.equal(pageSummary(60, 25, 25), '26–50 من 60');
});
