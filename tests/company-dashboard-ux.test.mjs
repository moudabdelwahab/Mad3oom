/**
 * tests/company-dashboard-ux.test.mjs — إصلاحات UX لوحات الشركة.
 *
 * ما يُختبَر هنا وحدويًا بلا DOM ولا Playwright:
 *   (أ) viewerRoleOf / sectionAllowed من company-model.js (دوال خالصة).
 *   (ب) isUnknownHash من company-routes.js (دالة خالصة استُخرجت لفحص الهاش
 *       المجهول قبل Toast العودة للنظرة العامة).
 *   (ج) ضوابط ثابتة (قراءة المصدر، على نمط company-routes.test.mjs):
 *       المُحمِّلان الجديدان، إزالة اقتطاع الإجراءات السريعة، الـplaceholder،
 *       توحيد مفاتيح مجموعات القائمة، وجلب التصنيفات وتوازي Shopify.
 *
 * ملاحظة عن LOADERS: كائن المُحمِّلات في company-dashboard.js لا يُستورد في
 * node — الملف يستورد وحدات متصفح (guardPage و/ui-service.js وdocument عند
 * التحميل)، فيُثبَت وجود المُحمِّلين بقراءة المصدر بدل استيراده.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { viewerRoleOf, sectionAllowed } from '../assets/js/company/company-model.js';
import {
    COMPANY_GROUPS, COMPANY_ROUTES, isUnknownHash, routeFromHash
} from '../assets/js/company/company-routes.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ── (أ) دور الناظر كما قرّرته القاعدة ─────────────────────────────────── */

test('viewerRoleOf: الأدوار الصريحة كما هي، والدور غير المعروف موظف دعم', () => {
    assert.equal(viewerRoleOf({ viewer_role: 'admin' }), 'admin');
    assert.equal(viewerRoleOf({ viewer_role: 'supervisor' }), 'supervisor');
    assert.equal(viewerRoleOf({ viewer_role: 'agent' }), 'agent');
    assert.equal(viewerRoleOf({ viewer_role: 'owner' }), 'agent', 'دور غير معروف لا يرفع صلاحية');
    assert.equal(viewerRoleOf({ viewer_role: '' }), 'agent');
});

test('viewerRoleOf: غياب viewer_role يعني admin — السلوك الحالي المُثبَت، لا قرار جديد', () => {
    // حمولة بلا viewer_role = خادم قبل 095، وكانت تُرسل للمالك والأعضاء معًا؛
    // تُعامل كما كانت تُعرض (admin). تغيير هذا الافتراضي قرار صلاحيات خارج
    // نطاق إصلاحات الواجهة، فيُسجَّل هنا كملاحظة فقط ولا يُغيَّر.
    assert.equal(viewerRoleOf({}), 'admin');
    assert.equal(viewerRoleOf({ viewer_role: null }), 'admin');
    assert.equal(viewerRoleOf({ viewer_role: undefined }), 'admin');
    assert.equal(viewerRoleOf(null), 'admin');
});

test('sectionAllowed: الاشتراكات ومفاتيح API للمدير وحده، وباقي الأقسام للجميع', () => {
    for (const section of ['subscriptions', 'api']) {
        assert.equal(sectionAllowed(section, 'admin'), true, section);
        assert.equal(sectionAllowed(section, 'supervisor'), false, section);
        assert.equal(sectionAllowed(section, 'agent'), false, section);
    }
    for (const section of ['overview', 'tickets', 'customerTickets', 'members', 'entitlements',
                           'usage', 'reports', 'notifications']) {
        assert.equal(sectionAllowed(section, 'agent'), true, section);
    }
});

/* ── (ب) الهاش المجهول ─────────────────────────────────────────────────── */

test('isUnknownHash: الفارغ والمعروف ليسا مجهولين، والغريب مجهول', () => {
    assert.equal(isUnknownHash(''), false);
    assert.equal(isUnknownHash('#overview'), false);
    assert.equal(isUnknownHash('#members'), false);
    assert.equal(isUnknownHash('#members?x=1'), false, 'الاستعلام لا يجعل الهاش مجهولًا');
    assert.equal(isUnknownHash('#admin'), true);
    assert.equal(isUnknownHash('#../../etc'), true);
    assert.equal(isUnknownHash('#nope'), true);
    // والمسار نفسه يعيد المجهول إلى النظرة العامة (السلوك القائم لم يتغيّر)
    assert.equal(routeFromHash('#admin'), 'overview');
    assert.equal(routeFromHash('#members'), 'members');
});

/* ── (ج) ضوابط ثابتة على التعديلات ─────────────────────────────────────── */

test('LOADERS يغطي الآن 32 صفحة من 32: مُحمِّلان لـ subscriptions وentitlements', () => {
    const src = read('assets/js/company/company-dashboard.js');
    for (const page of ['subscriptions', 'entitlements']) {
        assert.match(src, new RegExp(`${page}:\\s*\\(\\)\\s*=>`),
            `القسم ${page} ما زال بلا مُحمِّل`);
    }
    // سياسة الإلغاء والاسترداد محتوى ثابت: مُحمِّلها لا يقرأ شيئًا
    assert.match(src, /refundPolicy: \(\) => Promise\.resolve\(\)/);
    // كل صفحة معلَنة في الخريطة لها مُحمِّل — بلا استثناءات بعد المرحلة ب.
    for (const page of COMPANY_ROUTES) {
        assert.match(src, new RegExp(`${page}:\\s*\\(\\)\\s*=>`), `القسم ${page} بلا مُحمِّل`);
    }
    // مُحمِّلات المرحلة ب تمسح القسم من loadedOnce عند الفشل فيُعاد تحميله
    for (const page of ['continuity', 'customerHistory', 'teamPerformance']) {
        assert.match(src, new RegExp(`${page}:\\s*\\(\\)\\s*=>[^\\n]*loadedOnce\\.delete\\('${page}'\\)`),
            `مُحمِّل ${page} لا يمسح القسم من loadedOnce عند الفشل`);
    }
    // المُحمِّلان يعيدان قراءة الحمولة مع حالة خطأ وزر إعادة محاولة بمفتاح القسم
    assert.match(src, /async function loadSubscriptionsSection\(\)[\s\S]*?refreshDashboardPayload\(\)[\s\S]*?retry: 'subscriptions'/);
    assert.match(src, /async function loadEntitlementsSection\(\)[\s\S]*?refreshDashboardPayload\(\)[\s\S]*?retry: 'entitlements'/);
    // وحالة تحميل (skeleton) قبل القراءة
    assert.match(src, /async function loadSubscriptionsSection\(\)[\s\S]*?renderSkeletonLines\(container, 3\)/);
    assert.match(src, /async function loadEntitlementsSection\(\)[\s\S]*?renderSkeletonLines\(container, 3\)/);
});

test('الإجراءات السريعة الستة: لا اقتطاع صامت في quickActionsFor', () => {
    const src = read('assets/js/company/company-overview.js');
    assert.doesNotMatch(src, /quickActionsFor[\s\S]{0,200}\.slice\(0,\s*4\)/, 'الاقتطاع إلى 4 ما زال موجودًا');
    assert.match(src, /return QUICK_ACTIONS\.filter\(action => pageAvailable\(action\.page, ctx\)\);/);
});

test('نافذة «إضافة مستخدم»: الفحص قبل الفتح، والـToast بدل الخطأ داخل النافذة', () => {
    const src = read('assets/js/company/company-dashboard.js');
    const wire = src.slice(src.indexOf('function wireAddMember'), src.indexOf('function openMemberModal'));
    const guardAt = wire.indexOf("if (!canManageMembersNow)");
    const openAt = wire.indexOf('openMemberModal()');
    assert.ok(guardAt !== -1 && openAt !== -1 && guardAt < openAt, 'الفحص يجب أن يسبق openMemberModal');
    assert.match(wire, /showToast\?.\('حسابك غير مخوَّل بإضافة مستخدمين لهذه الشركة\.', 'error'\)/);
    assert.doesNotMatch(wire, /showMemberError\('حسابك غير مخوَّل/, 'الخطأ داخل النافذة بعد فتحها ما زال موجودًا');
});

test('إعادة التوجيه الصامت صارت بصوت: Toast للدور وللهاش المجهول', () => {
    const src = read('assets/js/company/company-dashboard.js');
    assert.match(src, /showToast\?.\('هذه الصفحة متاحة لمدير الشركة فقط\.', 'info'\)/);
    assert.match(src, /showToast\?.\('الصفحة المطلوبة غير موجودة — عُدت إلى النظرة العامة\.', 'info'\)/);
    // وجهة إعادة التوجيه لم تتغيّر: غير المتاح يعود إلى النظرة العامة
    assert.match(src, /const section = pageAvailable\(requested, navContext\(\)\) \? requested : 'overview';/);
});

test('وعد البحث العام: الـplaceholder يقول التذاكر فقط', () => {
    const nav = read('assets/components/company-sidebar.html');
    assert.match(nav, /placeholder="ابحث في التذاكر…"/);
    assert.doesNotMatch(nav, /ابحث في التذاكر والأقسام/);
});

test('مفاتيح مجموعات القائمة تطابق مفاتيح COMPANY_GROUPS', () => {
    const nav = read('assets/components/company-sidebar.html');
    const keys = new Set(COMPANY_GROUPS.map(g => g.key));
    const found = [...nav.matchAll(/data-group="([^"]+)"/g)].map(m => m[1]);
    assert.equal(found.length, 9, 'مجموعات القائمة: 9 — الإشعارات بلا مجموعة مستقلة (عنصر في «الرئيسية»)');
    for (const key of found) {
        assert.ok(keys.has(key), `مجموعة في القائمة بلا مقابل في COMPANY_GROUPS: ${key}`);
    }
    // كل مجموعة في الخريطة لها مجموعة في القائمة (الإشعارات عنصر داخل
    // «الرئيسية» في القائمة عمدًا — لا مجموعة مستقلة لها هناك)
    for (const key of [...keys].filter(k => k !== 'notifications')) {
        assert.ok(found.includes(key), `مجموعة ${key} بلا مقابل في القائمة`);
    }
});

test('قائمة «ابدأ هنا»: الدالة الخالصة والمفتاح وربطها في loadOverview', () => {
    const overview = read('assets/js/company/company-overview.js');
    assert.match(overview, /export function gettingStartedSteps\(/);
    assert.match(overview, /export const GETTING_STARTED_DISMISSED_KEY = 'mad3oom\.company\.getting-started\.dismissed\.v1';/);
    assert.match(overview, /export function renderGettingStarted\(/);
    // الخطوات الأربع بأسمائها وصفحاتها، دون أي جلب جديد (لا fetch في الدالتين)
    const block = overview.slice(overview.indexOf('export function gettingStartedSteps'),
        overview.indexOf('/* ── ملخّص التذاكر'));
    for (const [title, page] of [['أضف فريقك', 'members'], ['ادعُ عملاءك', 'customers'],
                                 ['اربط متجرك', 'shopify'], ['افتح أول تذكرة', 'support']]) {
        assert.ok(block.includes(title), `خطوة مفقودة: ${title}`);
        assert.ok(block.includes(`page: '${page}'`), `صفحة الخطوة مفقودة: ${title} → ${page}`);
    }
    assert.doesNotMatch(block, /fetch\(|fetch[A-Z]/, 'اشتقاق الخطوات يجلب بيانات جديدة');
    const dash = read('assets/js/company/company-dashboard.js');
    assert.match(dash, /renderGettingStarted\(\{[\s\S]*?membersCount: companyMembers\.length[\s\S]*?customersCount: companyCustomerList\.length[\s\S]*?platformTicketsCount: platformTickets\.rows\(\)\.length/);
});

test('تقارير المتجر تجلب التصنيفات بنفسها، وShopify تجلب المستقل معًا', () => {
    const src = read('assets/js/company/company-store.js');
    const reports = src.slice(src.indexOf('export async function loadStoreReports'));
    assert.match(reports, /Promise\.all\(\[fetchStoreReport\(reportDays\), fetchCategories\(\)\]\)/);
    const shopify = src.slice(src.indexOf('export async function loadShopifyPage'));
    assert.match(shopify, /Promise\.all\(\[fetchSyncStatus\(conn\.id\), fetchComplianceList\(\)\]\)/);
    // معالجة الأخطاء لكل قراءة كما كانت: كل نتيجة تُفحص بـ ok وحدها
    assert.match(shopify, /const status = s\.ok \? s\.data : null;/);
    assert.match(shopify, /const compliance = comp\.ok && Array\.isArray\(comp\.data\) \? comp\.data : \[\];/);
});
