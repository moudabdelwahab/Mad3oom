/**
 * تبويب «الطلبات» المجمّع في لوحة المالك (142) — منطق خالص بلا DOM ولا
 * شبكة + فحوص ساكنة على الترحيل والواجهة:
 *   ① النموذج: تسميات الأنواع والمصادر والحالات، والترشيح حسب النوع
 *      والمصدر والحالة، وعدّاد المعلّقة الكلي وحسب المصدر، ونص المبلغ
 *   ② الترحيل نفسه: دالة تجميع واحدة للمالك، UNION على الجداول الخمسة
 *      القائمة، بلا جدول جديد وبلا أي كتابة، والتعويض مرة واحدة،
 *      والتعويض لكل الباقات المدفوعة لا الفائقة وحدها
 *   ③ التراجع: يحذف الدالة وحدها — بلا DROP TABLE
 *   ④ الواجهة موجودة ومربوطة: owner/requests.html + وحدتها + رابطها في
 *      الشريط الجانبي بعد طلبات التعويض، وكل صف يربط بصفحته الأصلية
 *   ⑤ اختبار العرض يغطي الصفحة: requests في PAGES وبيانات وهمية
 *      لـ owner_list_requests
 * المنطق الخادمي (SQL) موثَّق في tests/sql/owner-requests-aggregator-142.test.sql.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    REQUEST_TYPES, REQUEST_TYPE_LABELS, REQUEST_SOURCES, REQUEST_SOURCE_LABELS,
    REQUEST_STATUS_LABELS, REQUEST_TYPE_SOURCE, isRequestType, isRequestStatus,
    requestSource, requestTypeLabel, requestStatusLabel, filterRequests,
    countPending, countPendingBySource, requestAmountText
} from '../assets/js/owner-requests-model.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const MIGRATION = fs.readFileSync(path.join(ROOT, 'migrations/142_owner_requests_aggregator.sql'), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(ROOT, 'migrations/_rollback/142_owner_requests_aggregator.down.sql'), 'utf8');
const MODEL = fs.readFileSync(path.join(ROOT, 'assets/js/owner-requests-model.js'), 'utf8');
const OWNER_PAGE = fs.readFileSync(path.join(ROOT, 'owner/requests.html'), 'utf8');
const OWNER_JS = fs.readFileSync(path.join(ROOT, 'assets/js/owner/pages/requests.js'), 'utf8');
const SIDEBAR = fs.readFileSync(path.join(ROOT, 'assets/components/owner-sidebar.html'), 'utf8');
const RENDER_TEST = fs.readFileSync(path.join(ROOT, 'tests/owner-pages.render.test.mjs'), 'utf8');

/** جسم الترحيل بلا تعليقات — الفحوص تنظر إلى الكود لا إلى شرحه. */
function codeOnly(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter(line => !line.trim().startsWith('--'))
        .join('\n');
}
const CODE = codeOnly(MIGRATION);
/** الكود قبل كتلة التحقق الذاتي (آخر `do $$` في الملف). */
const CODE_BEFORE_SELF_CHECK = CODE.slice(0, CODE.lastIndexOf('do $$'));

const ROWS = [
    { id: '1', type: 'company_account', source: 'companies', title: 'طلب إنشاء حساب متجر إلكتروني', status: 'pending', requested_at: '2026-11-25T10:00:00Z', account_kind: 'ecommerce_store', in_store_queue: true, amount: null, detail_url: '/owner/stores.html#storeRequestsHeading' },
    { id: '2', type: 'trial', source: 'companies', title: 'طلب تجربة مجانية — الخطة الفائقة', status: 'pending', requested_at: '2026-11-25T09:00:00Z', plan_key: 'ultimate', amount: null, detail_url: '/owner/trials.html#trialRequestsHeading' },
    { id: '3', type: 'refund', source: 'companies', title: 'طلب تعويض إلغاء اشتراك — الخطة الفائقة', status: 'approved', requested_at: '2026-11-24T09:00:00Z', amount: 666.33, currency: 'EGP', detail_url: '/owner/refunds.html#refundRequestsHeading' },
    { id: '4', type: 'deletion', source: 'customers', title: 'طلب حذف حساب الشركة', status: 'pending', requested_at: '2026-11-24T08:00:00Z', amount: null, detail_url: '/owner/accounts.html?id=c1' },
    { id: '5', type: 'suggestion', source: 'management', title: 'اقتراح اختبار', status: 'implemented', requested_at: '2026-11-23T08:00:00Z', amount: null, detail_url: '/admin/suggestions.html' },
    { id: '6', type: 'trial', source: 'companies', title: 'طلب تجربة مجانية — باقة المتاجر الإلكترونية', status: 'rejected', requested_at: '2026-11-22T08:00:00Z', plan_key: 'store', amount: null, detail_url: '/owner/trials.html#trialRequestsHeading' }
];

// ── ① النموذج: التسميات والترشيح والعدّاد ───────────────────────────────
test('① الأنواع والمصادر والحالات الخمسة بتسمياتها العربية', () => {
    assert.deepEqual(REQUEST_TYPES, ['company_account', 'trial', 'refund', 'deletion', 'suggestion']);
    assert.equal(REQUEST_TYPE_LABELS.company_account, 'إنشاء حساب شركة');
    assert.equal(REQUEST_TYPE_LABELS.trial, 'تجربة مجانية');
    assert.equal(REQUEST_TYPE_LABELS.refund, 'تعويض إلغاء الاشتراك');
    assert.equal(REQUEST_TYPE_LABELS.deletion, 'حذف حساب');
    assert.equal(REQUEST_TYPE_LABELS.suggestion, 'اقتراح');
    assert.deepEqual(REQUEST_SOURCES, ['companies', 'management', 'customers']);
    assert.equal(REQUEST_SOURCE_LABELS.companies, 'طلبات الشركات');
    assert.equal(REQUEST_SOURCE_LABELS.management, 'طلبات الإدارة');
    assert.equal(REQUEST_SOURCE_LABELS.customers, 'طلبات العملاء');
    // التعويض مصدر واحد (شركات) — لا صف ثانٍ له في مصدر آخر
    assert.equal(REQUEST_TYPE_SOURCE.refund, 'companies');
    assert.equal(REQUEST_STATUS_LABELS.pending, 'معلّق');
    assert.equal(REQUEST_STATUS_LABELS.approved, 'موافَق عليه');
    assert.equal(REQUEST_STATUS_LABELS.rejected, 'مرفوض');
    assert.equal(REQUEST_STATUS_LABELS.paid, 'مدفوع');
    assert.equal(REQUEST_STATUS_LABELS.closed, 'مغلق (تراجع العميل)');
    assert.equal(REQUEST_STATUS_LABELS.executed, 'منفَّذ');
    assert.equal(REQUEST_STATUS_LABELS.reviewed, 'قيد المراجعة');
    assert.equal(REQUEST_STATUS_LABELS.implemented, 'مطبَّق');
    assert.equal(isRequestType('trial'), true);
    assert.equal(isRequestType('store'), false);
    assert.equal(isRequestStatus('pending'), true);
    assert.equal(isRequestStatus('open'), false);
    assert.equal(isRequestStatus(''), false);
    assert.equal(requestSource(ROWS[0]), 'companies');
    assert.equal(requestSource({ type: 'deletion' }), 'customers');
    assert.equal(requestSource({ type: 'suggestion' }), 'management');
    assert.equal(requestSource(null), '');
    assert.equal(requestTypeLabel(ROWS[2]), 'تعويض إلغاء الاشتراك');
    assert.equal(requestStatusLabel(ROWS[4]), 'مطبَّق');
    // التعويض لكل الباقات المدفوعة — لا تمييز للفائقة وحدها، وباقة
    // المتجر هي المستثناة لا الشاملة
    assert.ok(MODEL.includes('التعويض يغطي كل الباقات المدفوعة'), 'النموذج بلا تعميم التعويض');
    assert.equal(requestAmountText(ROWS[2]), '666.33 EGP');
    assert.equal(requestAmountText(ROWS[0]), null);
    assert.equal(requestAmountText(null), null);
});

test('① الترشيح حسب النوع والمصدر والحالة — والعدّاد الكلي وحسب المصدر', () => {
    assert.equal(filterRequests(ROWS, {}).length, 6);
    assert.deepEqual(filterRequests(ROWS, { type: 'trial' }).map(r => r.id), ['2', '6']);
    assert.deepEqual(filterRequests(ROWS, { type: 'refund' }).map(r => r.id), ['3']);
    assert.deepEqual(filterRequests(ROWS, { source: 'customers' }).map(r => r.id), ['4']);
    assert.deepEqual(filterRequests(ROWS, { source: 'management' }).map(r => r.id), ['5']);
    assert.deepEqual(filterRequests(ROWS, { status: 'pending' }).map(r => r.id), ['1', '2', '4']);
    assert.deepEqual(filterRequests(ROWS, { type: 'trial', status: 'pending' }).map(r => r.id), ['2']);
    assert.deepEqual(filterRequests(ROWS, { type: 'suggestion', status: 'pending' }), []);
    assert.deepEqual(filterRequests(null, {}), []);
    assert.equal(countPending(ROWS), 3);
    assert.equal(countPending([]), 0);
    assert.deepEqual(countPendingBySource(ROWS), { total: 3, companies: 2, management: 0, customers: 1 });
    assert.deepEqual(countPendingBySource([]), { total: 0, companies: 0, management: 0, customers: 0 });
});

// ── ② الترحيل: دالة واحدة، خمسة جداول، بلا جدول وبلا كتابة ──────────────
test('② الترحيل دالة تجميع واحدة للمالك على الجداول الخمسة القائمة', () => {
    assert.match(CODE_BEFORE_SELF_CHECK, /create or replace function public\.owner_list_requests\(p_type text default null, p_status text default null\)/);
    assert.match(CODE_BEFORE_SELF_CHECK, /perform public\._owner_require\(\)/);
    assert.match(CODE_BEFORE_SELF_CHECK, /security definer/);
    assert.match(CODE_BEFORE_SELF_CHECK, /stable/);
    assert.ok(!/create table/i.test(CODE), 'الترحيل ينشئ جدولًا — المجمّع قراءة وحدها');
    assert.ok(!/insert into/i.test(CODE_BEFORE_SELF_CHECK), 'الترحيل يكتب');
    assert.ok(!/update public\./i.test(CODE_BEFORE_SELF_CHECK), 'الترحيل يكتب');
    assert.ok(!/delete from public\./i.test(CODE_BEFORE_SELF_CHECK), 'الترحيل يكتب');
    for (const table of ['company_account_requests', 'saas_trial_requests', 'refund_requests',
        'company_deletion_requests', 'suggestions']) {
        assert.ok(CODE_BEFORE_SELF_CHECK.includes(table), `الترحيل لا يقرأ ${table}`);
    }
    // التعويض مصدر واحد في الدالة — ظهوره في UNION فرع واحد فقط
    assert.equal((CODE_BEFORE_SELF_CHECK.match(/from public\.refund_requests/g) || []).length, 1,
        'التعويض يُقرأ من أكثر من فرع — تكرار');
    assert.match(CODE_BEFORE_SELF_CHECK, /revoke all on function public\.owner_list_requests\(text, text\) from public, anon/);
    assert.match(CODE_BEFORE_SELF_CHECK, /grant execute on function public\.owner_list_requests\(text, text\) to authenticated/);
    // الروابط العميقة الخمسة في الدالة نفسها
    for (const url of ['/owner/trials.html#trialRequestsHeading', '/owner/refunds.html#refundRequestsHeading',
        '/owner/stores.html#storeRequestsHeading', '/admin/company-requests.html',
        '/owner/accounts.html?id=', '/admin/suggestions.html']) {
        assert.ok(CODE_BEFORE_SELF_CHECK.includes(url), `الدالة بلا رابط ${url}`);
    }
    // التعويض لكل الباقات المدفوعة — وباقة المتجر هي المستثناة
    assert.ok(MIGRATION.includes('التعويض يغطي كل الباقات المدفوعة'), 'الترحيل بلا تعميم التعويض');
    // التحقق الذاتي: الدالة والصلاحيات وبلا جدول وبلا كتابة والجداول الخمسة
    assert.match(CODE, /relname = 'owner_requests'/);
    assert.match(CODE, /prosecdef/);
    assert.match(CODE, /grant execute on function public\.owner_list_requests/);
});

// ── ③ التراجع ────────────────────────────────────────────────────────────
test('③ التراجع يحذف الدالة وحدها — بلا DROP TABLE', () => {
    assert.match(ROLLBACK, /drop function if exists public\.owner_list_requests\(text, text\)/);
    assert.ok(!/drop table/i.test(ROLLBACK), 'التراجع يحذف جدولًا');
    assert.ok(!/delete from/i.test(codeOnly(ROLLBACK)), 'التراجع يحذف صفوفًا');
});

// ── ④ الواجهة: الصفحة ووحدتها ورابط الشريط الجانبي ──────────────────────
test('④ صفحة الطلبات موجودة ومربوطة: الفلاتر والعدّاد والروابط العميقة', () => {
    assert.match(OWNER_PAGE, /data-owner-page="requests"/);
    assert.match(OWNER_PAGE, /<script type="module" src="\/assets\/js\/owner\/pages\/requests\.js"><\/script>/);
    assert.match(OWNER_PAGE, /id="requestsKpis"/);
    assert.match(OWNER_PAGE, /id="requestsFilters"/);
    for (const id of ['requestsType', 'requestsSource', 'requestsStatus', 'requestsTable', 'requestsRefresh']) {
        assert.ok(OWNER_PAGE.includes(`id="${id}"`), `الصفحة بلا ${id}`);
    }
    assert.match(OWNER_PAGE, /<option value="pending" selected>معلّقة<\/option>/);
    for (const value of ['company_account', 'trial', 'refund', 'deletion', 'suggestion']) {
        assert.ok(OWNER_PAGE.includes(`value="${value}"`), `مرشّح النوع بلا ${value}`);
    }
    for (const value of ['companies', 'management', 'customers']) {
        assert.ok(OWNER_PAGE.includes(`value="${value}"`), `مرشّح المصدر بلا ${value}`);
    }
    assert.ok(!/'bundle'/.test(OWNER_PAGE) && !/"bundle"/.test(OWNER_PAGE), 'الصفحة تستعمل bundle مفتاح خطة');
    assert.ok(OWNER_PAGE.includes('التعويض يغطي كل الباقات المدفوعة'), 'الصفحة بلا تعميم التعويض');
    assert.ok(OWNER_JS.includes("rpc('owner_list_requests'"), 'الوحدة لا تنادي دالة التجميع');
    assert.ok(OWNER_JS.includes('bootOwnerPage'), 'الوحدة بلا بوابة المالك');
    assert.ok(OWNER_JS.includes('detail_url'), 'الصف لا يربط بصفحته الأصلية');
    assert.ok(OWNER_JS.includes('فتح التفاصيل'), 'الصف بلا زر فتح التفاصيل');
    assert.ok(OWNER_JS.includes('countPendingBySource'), 'الوحدة بلا عدّاد المعلّقة حسب المصدر');
    assert.ok(!/owner_decide|owner_store_request_decide/.test(OWNER_JS), 'الصفحة تقرر — القرار في الصفحة الأصلية وحدها');
    assert.ok(!/'bundle'/.test(OWNER_JS) && !/"bundle"/.test(OWNER_JS), 'الوحدة تستعمل bundle مفتاح خطة');
    // الشريط الجانبي: رابط الطلبات بعد طلبات التعويض مباشرةً
    assert.ok(SIDEBAR.includes('href="/owner/requests.html"'), 'الشريط بلا رابط الطلبات');
    assert.ok(SIDEBAR.includes('data-page="requests"'), 'الرابط بلا data-page');
    assert.ok(SIDEBAR.indexOf('/owner/requests.html') > SIDEBAR.indexOf('/owner/refunds.html'),
        'رابط الطلبات ليس بعد طلبات التعويض');
    assert.ok(SIDEBAR.indexOf('/owner/requests.html') < SIDEBAR.indexOf('/owner/accounts.html'),
        'رابط الطلبات ليس قبل شجرة الحسابات');
});

// ── ⑤ اختبار العرض يغطي الصفحة ───────────────────────────────────────────
test('⑤ اختبار العرض: requests في PAGES وبيانات وهمية لدالة التجميع', () => {
    assert.match(RENDER_TEST, /requests: '#requestsTable table'/);
    assert.match(RENDER_TEST, /owner_list_requests: \[/);
    for (const type of ['company_account', 'trial', 'refund', 'deletion', 'suggestion']) {
        assert.ok(RENDER_TEST.includes(`type: '${type}'`), `البيانات الوهمية بلا نوع ${type}`);
    }
    assert.ok(RENDER_TEST.includes("status: 'pending'"), 'البيانات الوهمية بلا صف معلّق');
});
