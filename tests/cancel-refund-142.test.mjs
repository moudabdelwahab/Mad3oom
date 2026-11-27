/**
 * تعويض إلغاء الاشتراكات المدفوعة (142) — منطق خالص بلا DOM ولا شبكة +
 * فحوص ساكنة على الترحيل والواجهتين:
 *   ① المعادلة: المثالان الرقميان بالضبط (666.33 و 5479.18) والكامل،
 *      وحدود المدخلات، والأيام كما تحسبها القاعدة (ceil/round)
 *   ② العرض: قراءة مؤهلة وتطابق الرقم المحلي مع رقم القاعدة (تناسبي
 *      وكامل)، وأكواد عدم الأهلية برسائلها العربية
 *   ③ وسائط الطلب والقرار وبيانات التحويل وتسجيل الدفع (الحدود والرسائل
 *      والرسوم)
 *   ④ قراءة الطلب والحالة (يحتاج بيانات تحويل؟ يفتح تذكرة؟ يسجّل دفعًا؟
 *      مغلق؟)
 *   ⑤ الترحيل نفسه: كل الباقات المدفوعة، بلا مسار دفع خارجي، والعرض
 *      قراءة فقط، والتراجع يغلق الطلب المفتوح ويمدّد السنوي هدية
 *   ⑥ الواجهتان موجودتان ومربوطتان: قسم التعويض في لوحة الشركة (عرض
 *      المبلغ ونوعه قبل التأكيد + نص الحدود + نموذج بيانات التحويل)،
 *      وصفحة المالك owner/refunds.html ورابطها في الشريط الجانبي
 * المنطق الخادمي (SQL) موثَّق في tests/sql/cancel-refund-142.test.sql.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    REFUND_PLAN_KEYS, REFUND_PLAN_LABEL, REFUND_CURRENCY, REFUND_STATUS_LABELS,
    REFUND_TRANSFER_METHODS, REFUND_TRANSFER_METHOD_LABELS, REFUND_RULES_TEXT,
    REFUND_TICKET_LIMITS, REFUND_KIND_LABELS,
    isRefundablePlan, computeRefund, remainingDaysUntil, cycleDaysBetween, formatEgp,
    refundQuoteView, refundQuoteCodeMessage, refundRequestArgs, refundTransferArgs,
    refundDecisionArgs, refundPaidArgs, refundRequestView, refundStatusView
} from '../assets/js/cancel-refund-model.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const MIGRATION = fs.readFileSync(path.join(ROOT, 'migrations/142_cancel_refund.sql'), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(ROOT, 'migrations/_rollback/142_cancel_refund.down.sql'), 'utf8');
const MODEL = fs.readFileSync(path.join(ROOT, 'assets/js/cancel-refund-model.js'), 'utf8');
const COMPANY_DATA = fs.readFileSync(path.join(ROOT, 'assets/js/company/company-data.js'), 'utf8');
const COMPANY_DASHBOARD = fs.readFileSync(path.join(ROOT, 'assets/js/company/company-dashboard.js'), 'utf8');
const OWNER_PAGE = fs.readFileSync(path.join(ROOT, 'owner/refunds.html'), 'utf8');
const OWNER_JS = fs.readFileSync(path.join(ROOT, 'assets/js/owner/pages/refunds.js'), 'utf8');
const SIDEBAR = fs.readFileSync(path.join(ROOT, 'assets/components/owner-sidebar.html'), 'utf8');

/** جسم الترحيل بلا تعليقات — الفحوص تنظر إلى الكود لا إلى شرحه. */
function codeOnly(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter(line => !line.trim().startsWith('--'))
        .join('\n');
}
const CODE = codeOnly(MIGRATION);
/** الكود قبل كتلة التحقق الذاتي (آخر `do $$` في الملف) — ألفاظ الحارس
 *  نفسها (pg_net و stripe) تظهر في الحارس الذي يفحص غيابها عن الدوال،
 *  فالفحص يستثني الحارس. */
const CODE_BEFORE_SELF_CHECK = CODE.slice(0, CODE.lastIndexOf('do $$'));
/** تعريف جدول الطلبات وحده. */
const TABLE_DEF = CODE.slice(CODE.indexOf('create table if not exists public.refund_requests'),
    CODE.indexOf('comment on table public.refund_requests'));
/** تعريف دالة العرض وحدها. */
const QUOTE_DEF = CODE.slice(CODE.indexOf('create or replace function public.refund_quote'),
    CODE.indexOf('comment on function public.refund_quote'));

// ── ① المعادلة التناسبية والكامل ─────────────────────────────────────────
test('① التعويض تناسبي وكامل: المثالان الرقميان بالضبط وحدود المدخلات', () => {
    assert.deepEqual(REFUND_PLAN_KEYS, ['support', 'ultimate', 'whatsapp', 'bundle']);
    assert.equal(REFUND_CURRENCY, 'EGP');
    assert.equal(computeRefund(1999, 10, 30), 666.33);
    assert.equal(computeRefund(19999, 100, 365), 5479.18);
    assert.equal(computeRefund(1999, 30, 30), 1999);
    assert.equal(computeRefund(1999, 0, 30), 0);
    assert.equal(computeRefund(1999, 1, 30), 66.63);
    assert.equal(computeRefund(0, 10, 30), null);
    assert.equal(computeRefund(-5, 10, 30), null);
    assert.equal(computeRefund(1999, 31, 30), null);
    assert.equal(computeRefund(1999, -1, 30), null);
    assert.equal(computeRefund(1999, 10, 0), null);
    assert.equal(computeRefund('ليس رقمًا', 10, 30), null);
    assert.equal(computeRefund(1999, 10, 30), computeRefund('1999', '10', '30'));
    // الكامل: المدفوع كاملًا بلا أيام
    assert.equal(computeRefund(1999, 10, 30, 'full'), 1999);
    assert.equal(computeRefund(999, 0, 30, 'full'), 999);
    assert.equal(computeRefund(0, 10, 30, 'full'), null);
    // حدود الـ10% لكل باقة
    assert.deepEqual(REFUND_TICKET_LIMITS, { support: 30, ultimate: 30, whatsapp: 2, bundle: 30 });
    assert.equal(REFUND_KIND_LABELS.full, 'تعويض كامل');
    assert.equal(REFUND_KIND_LABELS.prorated, 'تعويض تناسبي');
    // الأيام كما تحسبها القاعدة: المتبقي ceil، والإجمالي round
    assert.equal(remainingDaysUntil('2026-12-11T00:00:00.000Z', Date.parse('2026-12-01T00:00:00.000Z')), 10);
    assert.equal(remainingDaysUntil('2026-12-01T12:00:00.000Z', Date.parse('2026-12-01T00:00:00.000Z')), 1);
    assert.equal(remainingDaysUntil('2026-11-30T00:00:00.000Z', Date.parse('2026-12-01T00:00:00.000Z')), 0);
    assert.equal(cycleDaysBetween('2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z'), 30);
    assert.equal(cycleDaysBetween('2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'), 365);
    assert.equal(formatEgp(666.33).includes('جنيه'), true);
    assert.equal(formatEgp('ليس رقمًا'), '—');
    assert.match(REFUND_RULES_TEXT, /لا إلغاء فوري/);
    assert.match(REFUND_RULES_TEXT, /لا صرف مال تلقائيًا/);
    assert.match(REFUND_RULES_TEXT, /للمراجعة والقرار/);
});

// ── ② العرض ─────────────────────────────────────────────────────────────
test('② العرض: مؤهل وتطابق الرقم، وأكواد عدم الأهلية برسائل عربية', () => {
    const view = refundQuoteView({
        eligible: true, subscription_id: 's1', plan: 'ultimate', plan_name_ar: 'الخطة الفائقة',
        billing_cycle: 'monthly', end_date: '2026-12-11T00:00:00.000Z',
        remaining_days: 10, cycle_days: 30, amount_paid: 1999, refund_kind: 'prorated',
        refund_amount: 666.33, currency: 'EGP'
    });
    assert.equal(view.eligible, true);
    assert.equal(view.refundAmount, 666.33);
    assert.equal(view.refundKind, 'prorated');
    assert.equal(view.amountMismatch, false);
    const mismatch = refundQuoteView({
        eligible: true, remaining_days: 10, cycle_days: 30, amount_paid: 1999, refund_amount: 100
    });
    assert.equal(mismatch.amountMismatch, true);
    const full = refundQuoteView({
        eligible: true, remaining_days: 28, cycle_days: 30, amount_paid: 999, refund_kind: 'full',
        refund_amount: 999, tickets_used: 0, ticket_limit: 30
    });
    assert.equal(full.refundKind, 'full');
    assert.equal(full.refundKindLabel, 'تعويض كامل');
    assert.equal(full.amountMismatch, false);
    const fullMismatch = refundQuoteView({
        eligible: true, remaining_days: 28, cycle_days: 30, amount_paid: 999, refund_kind: 'full',
        refund_amount: 900
    });
    assert.equal(fullMismatch.amountMismatch, true);
    assert.equal(refundQuoteView({ eligible: false, code: 'not_refundable_plan' }).message,
        'طلب التعويض للباقات المدفوعة (المتقدمة والفائقة والواتساب والشاملة) — هذه الباقة لها مسار إلغاء نهاية المدة العادي.');
    assert.equal(refundQuoteView({ eligible: false, code: 'trial_no_refund' }).message,
        'التجربة المجانية بلا مبلغ مدفوع، فلا تعويض عليها.');
    assert.equal(refundQuoteView({ eligible: false, code: 'already_requested' }).message,
        'لديك بالفعل طلب تعويض مفتوح على هذا الاشتراك — بانتظار قرار المالك.');
    assert.equal(refundQuoteView(null).code, 'quote_failed');
    assert.equal(refundQuoteCodeMessage('no_active_subscription'), 'لا يوجد اشتراك فعّال يمكن إلغاؤه مع تعويض.');
    assert.equal(isRefundablePlan('ultimate'), true);
    assert.equal(isRefundablePlan('support'), true);
    assert.equal(isRefundablePlan('whatsapp'), true);
    assert.equal(isRefundablePlan('bundle'), true);
    assert.equal(isRefundablePlan('store'), false);
    assert.equal(isRefundablePlan('free'), false);
    assert.match(REFUND_PLAN_LABEL, /المدفوعة/);
});

// ── ③ وسائط الطلب والقرار وبيانات التحويل وتسجيل الدفع ───────────────────
test('③ الوسائط: سبب ≤500، ووسيلة من الثلاث، ورفض بسبب ≥10، ودفع بملاحظة ≥10 ورسوم', () => {
    assert.deepEqual(refundRequestArgs({ subscriptionId: 's1', reason: '' }).args,
        { p_subscription_id: 's1', p_reason: null });
    assert.equal(refundRequestArgs({}).error, 'حدّد الاشتراك المراد إلغاؤه.');
    assert.match(refundRequestArgs({ subscriptionId: 's1', reason: 'x'.repeat(501) }).error, /500/);
    assert.deepEqual(refundTransferArgs({ requestId: 'r1', method: 'instapay', account: '01000000000' }).args,
        { p_request: 'r1', p_transfer_method: 'instapay', p_transfer_account: '01000000000' });
    assert.equal(refundTransferArgs({ requestId: 'r1', method: 'card', account: '01000000000' }).error.includes('وسيلة'), true);
    assert.match(refundTransferArgs({ requestId: 'r1', method: 'instapay', account: '123' }).error, /6 أحرف/);
    assert.equal(refundTransferArgs({ method: 'instapay', account: '01000000000' }).error, 'حدّد طلب التعويض.');
    assert.deepEqual(Object.keys(REFUND_TRANSFER_METHOD_LABELS).sort(), ['bank_transfer', 'cash_wallet', 'instapay']);
    assert.equal(REFUND_TRANSFER_METHOD_LABELS.bank_transfer, 'تحويل بنكي');
    assert.deepEqual(refundDecisionArgs({ decision: 'approved', reason: '' }).args, { p_decision: 'approved', p_reason: null });
    assert.match(refundDecisionArgs({ decision: 'rejected', reason: 'قصير' }).error, /10 أحرف/);
    assert.match(refundDecisionArgs({ decision: 'rejected', reason: '' }).error, /10 أحرف/);
    assert.equal(refundDecisionArgs({ decision: 'maybe' }).error, 'القرار موافقة أو رفض فقط.');
    assert.deepEqual(refundPaidArgs({ note: 'حوّلت المبلغ اليوم' }).args,
        { p_note: 'حوّلت المبلغ اليوم', p_transfer_fee: 0 });
    assert.deepEqual(refundPaidArgs({ note: 'حوّلت المبلغ اليوم', fee: 25.5 }).args,
        { p_note: 'حوّلت المبلغ اليوم', p_transfer_fee: 25.5 });
    assert.match(refundPaidArgs({ note: 'حوّلت المبلغ اليوم', fee: -5 }).error, /رسوم/);
    assert.match(refundPaidArgs({ note: 'حوّلت المبلغ اليوم', fee: 'ليس رقمًا' }).error, /رسوم/);
    assert.match(refundPaidArgs({ note: 'تم' }).error, /10 أحرف/);
    assert.match(refundPaidArgs({}).error, /ملاحظة الدفع/);
});

// ── ④ قراءة الطلب والحالة ────────────────────────────────────────────────
test('④ قراءة الطلب: ما ينتظره كل حالة (تذكرة؟ بيانات تحويل؟ تسجيل دفع؟ مغلق؟)', () => {
    assert.deepEqual(Object.keys(REFUND_STATUS_LABELS).sort(), ['approved', 'closed', 'paid', 'pending', 'rejected']);
    assert.equal(REFUND_STATUS_LABELS.approved, 'وافق المالك — بانتظار بيانات التحويل');
    assert.equal(REFUND_STATUS_LABELS.closed, 'أُغلق — تراجع العميل عن الإلغاء');
    const pending = refundRequestView({ status: 'pending', can_open_ticket: false, can_mark_paid: false, needs_transfer_details: false });
    assert.equal(pending.canDecide, true);
    assert.equal(pending.canOpenTicket, false);
    const approvedNoTicket = refundRequestView({ status: 'approved', can_open_ticket: true, can_mark_paid: false, needs_transfer_details: false });
    assert.equal(approvedNoTicket.canOpenTicket, true);
    assert.equal(approvedNoTicket.canMarkPaid, false);
    const approvedTicket = refundRequestView({
        status: 'approved', can_open_ticket: false, can_mark_paid: false, needs_transfer_details: true,
        transfer_method: 'instapay'
    });
    assert.equal(approvedTicket.needsTransferDetails, true);
    assert.equal(approvedTicket.transferMethodLabel, 'إنستاباي');
    const ready = refundRequestView({ status: 'approved', can_open_ticket: false, can_mark_paid: true, needs_transfer_details: false });
    assert.equal(ready.canMarkPaid, true);
    const closed = refundRequestView({ status: 'closed', refund_kind: 'full', close_reason: 'تراجع العميل' });
    assert.equal(closed.isClosed, true);
    assert.equal(closed.canDecide, false);
    assert.equal(closed.canMarkPaid, false);
    assert.equal(closed.refundKindLabel, 'تعويض كامل');
    assert.equal(refundRequestView(null), null);
    const status = refundStatusView({
        has_company: true, company_name: 'شركة أ', can_request: true,
        requests: [
            { status: 'pending' }, { status: 'approved' }, { status: 'paid' }, { status: 'rejected' },
            { status: 'closed' }
        ]
    });
    assert.equal(status.hasCompany, true);
    assert.equal(status.openRequests.length, 2);
    assert.equal(status.pastRequests.length, 3);
    assert.equal(refundStatusView(null).hasCompany, false);
});

// ── ⑤ الترحيل: كل الباقات المدفوعة، بلا دفع خارجي، والعرض قراءة فقط ──────
test('⑤ الترحيل: الباقات المدفوعة الأربع، بلا مسار دفع، والعرض لا يلغي ولا ينشئ', () => {
    assert.match(TABLE_DEF, /plan in \('support', 'ultimate', 'whatsapp', 'bundle'\)/);
    assert.match(TABLE_DEF, /status in \('pending', 'approved', 'rejected', 'paid', 'closed'\)/);
    assert.match(TABLE_DEF, /refund_kind in \('full', 'prorated'\)/);
    assert.match(TABLE_DEF, /refund_amount = case when refund_kind = 'full' then amount_paid/);
    assert.match(TABLE_DEF, /round\(amount_paid \* remaining_days \/ cycle_days, 2\)/);
    assert.match(TABLE_DEF, /refund_net\s+numeric\(14,2\) generated always as \(refund_amount - transfer_fee\) stored/);
    assert.match(TABLE_DEF, /transfer_method in \('bank_transfer', 'instapay', 'cash_wallet'\)/);
    assert.match(CODE_BEFORE_SELF_CHECK, /refund_requests_one_open/);
    assert.match(CODE_BEFORE_SELF_CHECK, /enable row level security/);
    // بلا مسار دفع خارجي في أي دالة (قبل كتلة التحقق الذاتي التي تذكرها)
    assert.equal(CODE_BEFORE_SELF_CHECK.includes('pg_net'), false);
    assert.equal(CODE_BEFORE_SELF_CHECK.includes('http_post'), false);
    assert.equal(CODE_BEFORE_SELF_CHECK.includes('stripe'), false);
    assert.equal(CODE_BEFORE_SELF_CHECK.includes('paymob'), false);
    // العرض قراءة فقط: بلا إلغاء وبلا إنشاء طلب
    assert.equal(QUOTE_DEF.includes('cancel_my_active_subscription'), false);
    assert.equal(QUOTE_DEF.includes('insert into public.refund_requests'), false);
    assert.match(QUOTE_DEF, /round\(/);
    assert.match(QUOTE_DEF, /not_refundable_plan/);
    assert.match(QUOTE_DEF, /_refund_is_new_subscription/);
    assert.match(QUOTE_DEF, /_refund_ticket_usage/);
    assert.match(QUOTE_DEF, /_refund_sie_usage/);
    assert.match(QUOTE_DEF, /trial_no_refund/);
    // الطلب يمر عبر العرض ويلغي نهاية المدة عبر 136 ويُشعر المالك
    const REQUEST_DEF = CODE.slice(CODE.indexOf('create or replace function public.request_cancel_refund'),
        CODE.indexOf('comment on function public.request_cancel_refund'));
    assert.match(REQUEST_DEF, /refund_quote/);
    assert.match(REQUEST_DEF, /cancel_my_active_subscription/);
    assert.match(REQUEST_DEF, /_notify_platform_owners/);
    assert.match(CODE_BEFORE_SELF_CHECK, /platform_authority a\s*\n?\s*where a\.level = 'owner'/);
    assert.match(CODE_BEFORE_SELF_CHECK, /\/owner\/refunds\.html/);
    // التذكرة على الآلية القائمة: مدعوم بلا شركة، فئة subscription، علم الفوترة
    const TICKET_DEF = CODE.slice(CODE.indexOf('create or replace function public.owner_open_refund_ticket'),
        CODE.indexOf('comment on function public.owner_open_refund_ticket'));
    assert.match(TICKET_DEF, /'mad3oom_support'/);
    assert.match(TICKET_DEF, /mad3oom\.billing_request_ticket/);
    assert.match(TICKET_DEF, /'subscription'/);
    assert.match(TICKET_DEF, /company_id\)\s*\n?\s*values \(v_req\.user_id/);
    // رقم الحساب حساس: لا يُكشف إلا لمالك الشركة صاحبة الطلب أو للمالك
    assert.match(CODE_BEFORE_SELF_CHECK, /p_show_transfer boolean default false/);
    assert.match(CODE_BEFORE_SELF_CHECK, /case when p_show_transfer then r\.transfer_account else null end/);
    assert.match(CODE_BEFORE_SELF_CHECK, /_refund_request_json\(r\.id, v_co\.user_id = auth\.uid\(\)\)/);
    // القرار والتذكرة والدفع بتحقق حديث
    for (const fn of ['owner_decide_refund', 'owner_open_refund_ticket', 'owner_mark_refund_paid']) {
        const def = CODE.slice(CODE.indexOf(`function public.${fn}`), CODE.indexOf(`function public.${fn}`) + 6000);
        assert.match(def, /owner_critical_ok/);
        assert.match(def, /log_privileged/);
    }
    // تسجيل الدفع برسوم فعلية اختيارية لا تتجاوز الإجمالي
    assert.match(CODE_BEFORE_SELF_CHECK, /p_transfer_fee numeric default 0/);
    assert.match(CODE_BEFORE_SELF_CHECK, /v_fee > v_req\.refund_amount/);
    // التراجع (136 + 142): يغلق طلبات التعويض المفتوحة ويمدّد السنوي هدية
    const RESUME_DEF = CODE.slice(CODE.indexOf('create or replace function public.resume_my_subscription'),
        CODE.indexOf('comment on function public.resume_my_subscription'));
    assert.match(RESUME_DEF, /refund_requests/);
    assert.match(RESUME_DEF, /refund_gift_granted_for_start/);
    assert.match(RESUME_DEF, /gift_days_added/);
    assert.match(RESUME_DEF, /refund_requests_closed/);
    assert.match(RESUME_DEF, /'closed'/);
    // حدود صريحة موثقة في الملف نفسه
    assert.match(MIGRATION, /لا إلغاء فوري/);
    assert.match(MIGRATION, /لا صرف مال تلقائيًا/);
    // التراجع يحذف الدوال والجدول ويثبّت بقاء إلغاء نهاية المدة، ويعيد التراجع لنص 136
    assert.match(ROLLBACK, /drop table if exists public\.refund_requests/);
    assert.match(ROLLBACK, /drop function if exists public\.request_cancel_refund/);
    assert.match(ROLLBACK, /drop column if exists refund_gift_granted_for_start/);
    assert.match(ROLLBACK, /cancel_at_period_end/);
    assert.match(ROLLBACK, /cancel_revoked/);
});

// ── ⑥ الواجهتان ──────────────────────────────────────────────────────────
test('⑥ لوحة الشركة: زر الباقة المدفوعة يعرض المبلغ ونوعه قبل التأكيد + قسم التعويض + نموذج التحويل', () => {
    assert.match(COMPANY_DATA, /refund_quote/);
    assert.match(COMPANY_DATA, /request_cancel_refund/);
    assert.match(COMPANY_DATA, /my_refund_requests/);
    assert.match(COMPANY_DATA, /submit_refund_transfer_details/);
    assert.match(COMPANY_DASHBOARD, /إلغاء مع تعويض/);
    assert.match(COMPANY_DASHBOARD, /openRefundCancelModal/);
    assert.match(COMPANY_DASHBOARD, /REFUND_RULES_TEXT/);
    assert.match(COMPANY_DASHBOARD, /طلبات تعويض إلغاء الاشتراك/);
    assert.match(COMPANY_DASHBOARD, /renderRefundSection/);
    assert.match(COMPANY_DASHBOARD, /data-refund-transfer/);
    assert.match(COMPANY_DASHBOARD, /لا ترسل بيانات بطاقة ولا كلمة مرور/);
    assert.match(COMPANY_DASHBOARD, /onCancelWithRefund/);
    assert.match(COMPANY_DASHBOARD, /isRefundablePlan/);
    // النموذج نفسه لا يعرف مسار دفع
    assert.equal(MODEL.includes('stripe') || MODEL.includes('paymob'), false);
});

test('⑥ صفحة المالك: طلبات التعويض مع القرار والتذكرة وتسجيل الدفع + رابط الشريط', () => {
    assert.match(OWNER_PAGE, /طلبات تعويض إلغاء الاشتراكات/);
    assert.match(OWNER_PAGE, /لا إلغاء فوري للاشتراك ولا صرف مال تلقائيًا/);
    assert.match(OWNER_PAGE, /id="refundRequests"/);
    assert.match(OWNER_PAGE, /id="refundKpis"/);
    assert.match(OWNER_PAGE, /value="closed"/);
    assert.match(OWNER_JS, /owner_list_refund_requests/);
    assert.match(OWNER_JS, /owner_decide_refund/);
    assert.match(OWNER_JS, /owner_open_refund_ticket/);
    assert.match(OWNER_JS, /owner_mark_refund_paid/);
    assert.match(OWNER_JS, /فتح تذكرة تعويض/);
    assert.match(OWNER_JS, /تسجيل الدفع/);
    assert.match(OWNER_JS, /data-critical/);
    assert.match(OWNER_JS, /p_transfer_fee/);
    assert.match(SIDEBAR, /\/owner\/refunds\.html/);
    assert.match(SIDEBAR, /data-page="refunds"/);
    assert.match(SIDEBAR, /طلبات التعويض/);
});
