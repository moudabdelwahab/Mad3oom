/**
 * tests/company-billing-readonly.test.mjs — نواقص لوحة الشركة P1 (الجزء ج):
 * سجل فواتير للقراءة فقط، ومسار «جدّد الآن»، وقيد Pi مبكرًا.
 *
 * ما يُختبَر هنا منطق خالص بلا DOM ولا Playwright:
 *   (أ) حكم مصدر الفواتير: لا يوجد مصدر موثوق على مستوى الشركة، فلا سجل مخترع.
 *   (ب) حالة الفراغ الصريحة: تربط الفواتير بتذاكر طلبات الاشتراك، برابط إلى
 *       قسم التذاكر مع مدعوم حيث أمكن — لا رابط تذكرة بعينها، لأن حمولة
 *       اللوحة لا تحمل ticket_id أصلًا.
 *   (ج) سياق زر التجديد: من التقرير المحسوب أصلًا، بدورة الفوترة الحالية —
 *       والتجديد نفسه يتم **داخل اللوحة** (136): نافذة تختار الدورة ووسيلة
 *       الدفع، وتُرسَل عبر مسار طلب الاشتراك الموجود — بلا مسار دفع جديد
 *       وبلا معامل خطة في رابط. رابط «استعراض كل الباقات» ثانوي للتصفح.
 *   (د) قيد Pi يظهر مبكرًا في قسم الاشتراكات، لا عند خطوة الدفع وحدها.
 *   (هـ) ضوابط ثابتة على المصدر: لا قراءة مباشرة لجدول الفواتير، لا منطق
 *       دفع جديد في اللوحة، لا واتساب في الكود الجديد.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
    resolveCompanyInvoiceSource, invoiceEmptyState, piCompanyLimitation
} from '../assets/js/company/company-invoices-model.js';
import {
    analyzeSubscription, analyzeSubscriptions, renewalContext
} from '../assets/js/company/subscription-model.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const NOW = Date.parse('2026-09-14T12:00:00Z');
const day = 86400000;
const iso = (offsetDays) => new Date(NOW + offsetDays * day).toISOString();

/** صفّ كما ترجّعه get_my_company_dashboard() بالضبط — بلا ticket_id. */
function sub(over = {}) {
    return {
        id: over.id || 's1',
        plan: over.plan ?? 'bundle',
        plan_name_ar: over.plan_name_ar ?? 'الباقة الشاملة',
        status: over.status ?? 'active',
        billing_cycle: over.billing_cycle ?? 'monthly',
        start_date: 'start_date' in over ? over.start_date : iso(-30),
        end_date: 'end_date' in over ? over.end_date : iso(60),
        is_active: 'is_active' in over ? over.is_active : true,
        days_remaining: 'days_remaining' in over ? over.days_remaining : 60
    };
}

/* ── (أ) مصدر الفواتير: غير موثوق على مستوى الشركة ─────────────────────── */

test('مصدر الفواتير غير متاح: الجدول بلا عمود شركة، والربط فردي فقط', () => {
    const src = resolveCompanyInvoiceSource();
    assert.equal(src.available, false, 'لا تُبنى قائمة فواتير بلا مصدر موثوق');
    assert.equal(src.table, 'accounting_invoices');
    assert.equal(src.hasCompanyColumn, false, 'الترحيل 005 بلا company_id');
    assert.deepEqual([...src.linkColumns], ['ticket_id', 'user_id', 'subscription_id']);
    assert.ok(!src.linkColumns.includes('company_id'), 'لا رابط شركويًا في الأعمدة');
    assert.equal(src.dashboardCarriesTicketLink, false,
        'حمولة اللوحة (016) بلا ticket_id فلا ربط اشتراك↔تذكرة من الواجهة');
    assert.equal(src.invoiceHome, 'subscription_request_ticket',
        'موطن الفاتورة: داخل تذكرة طلب الاشتراك مع مدعوم');
});

test('سياسة قراءة الفواتير فردية: عضو الشركة غير المالك لا يرى شيئًا', () => {
    const src = resolveCompanyInvoiceSource();
    assert.equal(src.readPolicy, 'own_invoices_select');
});

/* ── (ب) حالة الفراغ الصريحة ───────────────────────────────────────────── */

test('حالة الفراغ تربط الفواتير بتذاكر طلبات الاشتراك لا بسجل مخترع', () => {
    const state = invoiceEmptyState();
    assert.match(state.title, /لا يوجد سجل فواتير/);
    assert.match(state.text, /تذكرة طلب الاشتراك/);
    assert.match(state.text, /لا مصدر موثوق/);
    assert.match(state.ticketHint, /مرفقة داخل تذكرته/);
    assert.equal(state.ticketTab, 'tickets', 'الرابط إلى قسم التذاكر مع مدعوم داخل اللوحة');
    assert.ok(state.ticketLabel.length > 0);
    // لا رابط تذكرة بعينها: لا معرّف تذكرة في الحالة أصلًا
    assert.ok(!('ticketId' in state) && !('ticketNumber' in state),
        'لا يمكن ربط تذكرة بعينها — الحمولة لا تحمل ticket_id');
});

/* ── (ج) سياق زر التجديد ───────────────────────────────────────────────── */

test('تجديد: أقرب اشتراك نشط يعطي زر «جدّد الآن» بسياق الباقة وتاريخ انتهائها', () => {
    const report = analyzeSubscriptions([sub({ days_remaining: 60 })], { now: NOW });
    const ctx = renewalContext(report);
    assert.equal(ctx.kind, 'renew');
    assert.equal(ctx.label, 'جدّد الآن');
    assert.equal(ctx.planKey, 'bundle');
    assert.equal(ctx.planName, 'الباقة الشاملة');
    assert.equal(ctx.endDate, iso(60));
    assert.equal(ctx.daysRemaining, 60);
    assert.equal(ctx.billingCycle, 'monthly', 'التجديد داخل اللوحة يبدأ من دورة الفوترة الحالية');
    assert.equal(ctx.href, '/subscriptions.html', 'رابط ثانوي لاستعراض الباقات — لا مسار التجديد');
    assert.ok(!ctx.href.includes('?'), 'صفحة الاشتراكات لا تقرأ أي معامل من الرابط');
});

test('تجديد: اشتراك ينتهي قريبًا يُجدَّد أيضًا، والمجدول وحده لا زر له', () => {
    const expiring = renewalContext(
        analyzeSubscriptions([sub({ days_remaining: 5 })], { now: NOW }));
    assert.equal(expiring?.kind, 'renew');

    const scheduled = renewalContext(analyzeSubscriptions(
        [sub({ start_date: iso(2), end_date: iso(1500), is_active: false, days_remaining: 1500 })],
        { now: NOW }));
    assert.equal(scheduled, null, 'لم يبدأ بعد لا يحتاج تجديدًا');
});

test('تجديد: قيد المراجعة وحده لا زر له، والمنتهي وحده يعطي «اشترك مجددًا»', () => {
    const pending = renewalContext(analyzeSubscriptions(
        [sub({ status: 'pending', is_active: false })], { now: NOW }));
    assert.equal(pending, null, 'طلب قيد المراجعة لا يُجدَّد ولا يُعاد');

    const expired = renewalContext(analyzeSubscriptions(
        [sub({ start_date: iso(-90), end_date: iso(-1), is_active: false, days_remaining: 0 })],
        { now: NOW }));
    assert.equal(expired?.kind, 'resubscribe');
    assert.equal(expired?.label, 'اشترك مجددًا');
    assert.equal(expired?.planName, 'الباقة الشاملة');
    assert.equal(expired?.endDate, iso(-1));
    assert.equal(expired?.href, '/subscriptions.html');
});

test('تجديد: بلا اشتراكات وبلا تقرير لا زر', () => {
    assert.equal(renewalContext(analyzeSubscriptions([], { now: NOW })), null);
    assert.equal(renewalContext(null), null);
});

test('تجديد: أقرب انتهاء هو سياق الزر لا أبعد اشتراك', () => {
    const report = analyzeSubscriptions([
        sub({ id: 'far', plan: 'support', plan_name_ar: 'الدعم الفني', days_remaining: 200, end_date: iso(200) }),
        sub({ id: 'near', plan: 'bundle', plan_name_ar: 'الباقة الشاملة', days_remaining: 10, end_date: iso(10) })
    ], { now: NOW });
    const ctx = renewalContext(report);
    assert.equal(ctx.planKey, 'bundle');
    assert.equal(ctx.daysRemaining, 10);
});

/* ── (د) قيد Pi مبكرًا ─────────────────────────────────────────────────── */

test('قيد Pi: النص يصرّح بأن حسابات الشركات مستثناة قبل خطوة الدفع', () => {
    const note = piCompanyLimitation();
    assert.match(note.text, /حسابات الفردية/);
    assert.match(note.text, /لا يشمل حسابات الشركات/);
    assert.match(note.text, /وسيلة دفع أخرى/);
    assert.ok(note.currentlySurfacedAt.length >= 2, 'موضعا الظهور الحاليان موثّقان');
    for (const spot of note.currentlySurfacedAt) {
        assert.equal(spot.file, 'subscriptions-script.js');
    }
});

test('قيد Pi: نص التنبيه نفسه موجود اليوم في خطوة الدفع فقط', () => {
    const src = read('subscriptions-script.js');
    assert.match(src, /الدفع بـPi متاح للحسابات الفردية حاليًا/,
        'القيد مصدره subscriptions-script.js لا نص مخترع هنا');
    // والقيد يظهر هناك مرتين: وضع Pi واختيار Pi في المودال
    assert.equal(src.split('الدفع بـPi متاح للحسابات الفردية حاليًا.').length - 1, 2);
});

/* ── (هـ) ضوابط ثابتة على المصدر ───────────────────────────────────────── */

test('الفوترة: قسم «فواتير الشركة» يُرسم في الاستخدام بحالة الفراغ ورابط التذاكر', () => {
    const src = read('assets/js/company/company-billing.js');
    assert.match(src, /import \{ invoiceEmptyState \}/);
    assert.match(src, /فواتير الشركة/);
    assert.match(src, /renderCompanyInvoices\(box\)/);
    // الرابط داخل اللوحة نفسها: هاش + data-tab، لا رابط خارجي
    assert.match(src, /data-tab="\$\{escapeHtml\(state\.ticketTab\)\}"/);
    // بلا قراءة مباشرة لجدول الفواتير من الواجهة
    assert.doesNotMatch(src, /supabase\.from\(['"]accounting_invoices['"]\)/);
    assert.doesNotMatch(src, /rpc\(['"]record_accounting_invoice['"]\)/);
});

test('الاشتراكات: تنبيه Pi وزر التجديد يُرسمان في renderSubscriptions', () => {
    const src = read('assets/js/company/company-dashboard.js');
    assert.match(src, /import \{ piCompanyLimitation \}/);
    assert.match(src, /renewalContext\(report\)/);
    assert.match(src, /piNoticeHtml\(\)/);
    assert.match(src, /renewalPanelHtml\(renewalContext\(report\)\)/);
    // حالة الفراغ تحمل تنبيه Pi أيضًا لا «استعراض الباقات» وحده
    assert.match(src, /container\.insertAdjacentHTML\('beforeend', piNoticeHtml\(\)\)/);
});

test('لا منطق دفع جديد في اللوحة: التجديد داخلها عبر مسار الطلب الموجود', () => {
    for (const rel of ['assets/js/company/company-dashboard.js',
                       'assets/js/company/company-billing.js',
                       'assets/js/company/company-invoices-model.js',
                       'assets/js/company/subscription-model.js']) {
        const src = read(rel);
        assert.doesNotMatch(src, /payWithPi/, rel);
        assert.doesNotMatch(src, /PI_METHOD/, rel);
        assert.doesNotMatch(src, /request_subscription_purchase/, rel);
        assert.doesNotMatch(src, /renewSubscription\(/, rel);
        assert.doesNotMatch(src, /openPaymentMethodModal/, rel);
    }
    // زر التجديد داخل اللوحة (نافذة)، لا رابط إلى صفحة الاشتراكات
    const dash = read('assets/js/company/company-dashboard.js');
    assert.match(dash, /data-renew-plan/, 'زر التجديد داخل اللوحة');
    assert.match(dash, /openRenewalModal\(/, 'نافذة التجديد في اللوحة');
    assert.match(dash, /createSubscriptionTicket\(plan, renewal\.cycle/, 'التجديد عبر مسار طلب الاشتراك الموجود');
    assert.match(dash, /submitDowngradeRequest\(/, 'التخفيض عبر مسار 136');
    assert.match(dash, /cancelActiveSubscription\(/, 'الإلغاء عبر مسار 136');
    // الترقية تسري عند تأكيد الدفع لا عند نهاية الدورة (136): لا تاريخ نهاية
    // كتاريخ سريان للترقية، ونافذة معاد الاشتراك زرّها «إرسال طلب الاشتراك»
    assert.doesNotMatch(dash, /fmtDate\(isUpgrade \? cur\.end_date/, 'تاريخ سريان الترقية ليس نهاية الدورة');
    assert.match(dash, /فور تأكيد الدفع من فريق الدعم/, 'الترقية تسري فور تأكيد الدفع');
    assert.match(dash, /kind === 'resubscribe' \? 'إرسال طلب الاشتراك'/, 'معاد الاشتراك زرّه «إرسال طلب الاشتراك»');
    // رابط الاشتراكات الوحيد في لوحة التجديد ثانوي للتصفح
    assert.match(dash, /استعراض كل الباقات/);
    assert.match(dash, /href="\$\{escapeHtml\(context\.href\)\}"/);
});

test('لا واتساب في الكود الجديد', () => {
    assert.doesNotMatch(read('assets/js/company/company-invoices-model.js'), /whatsapp/i);
});
