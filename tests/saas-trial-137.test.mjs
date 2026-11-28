/**
 * التجربة المجانية 3 أيام (137) — منطق خالص بلا DOM ولا شبكة + فحوص ساكنة
 * على الترحيل والواجهتين:
 *   ① المدة 3 أيام بالضبط، والنهاية = البداية + 3 أيام
 *   ② الباقات المشمولة (162: support وultimate فقط — باقة المتاجر
 *      أُلغيت، وتسميتها باقية في TRIAL_PLAN_LABELS لعرض الطلبات القديمة)
 *   ③ وسائط الطلب والقرار (رفض بسبب ≥10 أحرف، موافقة بلا حقل دفع)
 *   ④ قراءة الطلب والحالة (جارية/معلّقة/منتهية، والأيام المتبقية)
 *   ⑤ الترحيل نفسه: بلا sandbox في الكود، وبلا عمود دفع/بطاقة، وبلا
 *      إنشاء اشتراك في دالة الطلب، وبلا تجديد تلقائي
 *   ⑥ الواجهتان موجودتان ومربوطتان: صفحة المالك owner/trials.html
 *      ورابطها في الشريط الجانبي، وقسم التجربة في لوحة الشركة
 * المنطق الخادمي (SQL) موثَّق في tests/sql/saas-trial-137.test.sql.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    TRIAL_DAYS, TRIAL_PLAN_KEYS, TRIAL_PLAN_LABELS, TRIAL_STATUS_LABELS,
    isTrialPlan, trialPlanAllowed, trialEndAt, trialLengthDays,
    trialRequestArgs, trialDecisionArgs, isTrialSubscription,
    trialRequestView, trialStatusView, TRIAL_RULES_TEXT
} from '../assets/js/saas-trial-model.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const MIGRATION = fs.readFileSync(path.join(ROOT, 'migrations/137_saas_trial_3_days.sql'), 'utf8');
const OWNER_PAGE = fs.readFileSync(path.join(ROOT, 'owner/trials.html'), 'utf8');
const OWNER_JS = fs.readFileSync(path.join(ROOT, 'assets/js/owner/pages/trials.js'), 'utf8');
const COMPANY_BILLING = fs.readFileSync(path.join(ROOT, 'assets/js/company/company-billing.js'), 'utf8');
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
/** الكود قبل سطر حارس sandbox في كتلة التحقق الذاتي — الكلمة تظهر في
 *  الحارس نفسه فقط (هو من يفحص غيابها عن الدوال)، فالفحص يستثني الحارس
 *  وما بعده لا الكود. */
const CODE_BEFORE_SELF_CHECK = CODE.slice(0, CODE.indexOf("position('sandbox'"));
/** تعريف جدول الطلبات وحده — فحص أعمدة الدفع يخصّه لا الملف كله. */
const TABLE_DEF = CODE.slice(CODE.indexOf('create table if not exists public.saas_trial_requests'),
    CODE.indexOf('comment on table public.saas_trial_requests'));

// ── ① المدة 3 أيام بالضبط ───────────────────────────────────────────────
test('① المدة 3 أيام بالضبط: ثابت وباقات وقاعدة النهاية', () => {
    assert.equal(TRIAL_DAYS, 3);
    assert.deepEqual(TRIAL_PLAN_KEYS, ['support', 'ultimate']);
    assert.equal(TRIAL_PLAN_LABELS.support, 'الخطة المتقدمة');
    assert.equal(TRIAL_PLAN_LABELS.ultimate, 'الخطة الفائقة');
    // 162: تسمية store باقية لعرض طلبات التجربة القديمة فقط، لا كخيار.
    assert.equal(TRIAL_PLAN_LABELS.store, 'باقة المتاجر الإلكترونية');
    assert.equal(trialEndAt('2026-11-25T10:00:00.000Z'), '2026-11-28T10:00:00.000Z');
    assert.equal(trialLengthDays('2026-11-25T10:00:00.000Z', '2026-11-28T10:00:00.000Z'), 3);
    assert.notEqual(trialLengthDays('2026-11-25T10:00:00.000Z', '2026-11-29T10:00:00.000Z'), 3);
    assert.equal(trialEndAt('ليس تاريخًا'), null);
    assert.match(TRIAL_RULES_TEXT, /3 أيام/);
    assert.match(TRIAL_RULES_TEXT, /بلا بطاقة وبلا دفع/);
    assert.match(TRIAL_RULES_TEXT, /بلا تجديد تلقائي/);
    assert.match(TRIAL_RULES_TEXT, /لا تتحول لاشتراك مدفوع/);
});

// ── ② الباقات والجمهور ──────────────────────────────────────────────────
test('② الباقات المشمولة اثنتان فقط، وstore ليست باقة تجربة (162)', () => {
    assert.equal(isTrialPlan('support'), true);
    assert.equal(isTrialPlan('ultimate'), true);
    assert.equal(isTrialPlan('store'), false);
    assert.equal(isTrialPlan('whatsapp'), false);
    assert.equal(isTrialPlan('bundle'), false);
    assert.equal(isTrialPlan('free'), false);
    assert.equal(trialPlanAllowed('support', 'company'), true);
    assert.equal(trialPlanAllowed('ultimate', 'ecommerce_store'), true);
    assert.equal(trialPlanAllowed('ultimate', 'company'), true);
    assert.equal(trialPlanAllowed('store', 'ecommerce_store'), false);
    assert.equal(trialPlanAllowed('store', 'company'), false);
    assert.equal(trialPlanAllowed('store', 'individual'), false);
    assert.equal(trialPlanAllowed('whatsapp', 'company'), false);
});

// ── ③ وسائط الطلب والقرار ───────────────────────────────────────────────
test('③ طلب التجربة: خطة صالحة فقط، وبلا أي حقل دفع أو بطاقة', () => {
    assert.deepEqual(trialRequestArgs({ planKey: 'ultimate' }).args, { p_plan_key: 'ultimate' });
    assert.match(trialRequestArgs({ planKey: 'store' }).error, /باقات التجربة/);
    assert.match(trialRequestArgs({ planKey: 'whatsapp' }).error, /باقات التجربة/);
    assert.match(trialRequestArgs({}).error, /باقات التجربة/);
    assert.equal('card' in (trialRequestArgs({ planKey: 'support' }).args || {}), false);
    assert.equal('amount' in (trialRequestArgs({ planKey: 'support' }).args || {}), false);
});

test('③ قرار المالك: موافقة أو رفض فقط، والرفض بسبب 10 أحرف على الأقل', () => {
    assert.deepEqual(trialDecisionArgs({ decision: 'approved' }).args, { p_decision: 'approved' });
    assert.deepEqual(trialDecisionArgs({ decision: 'approved', reason: 'موافقة للاختبار' }).args,
        { p_decision: 'approved', p_reason: 'موافقة للاختبار' });
    assert.deepEqual(trialDecisionArgs({ decision: 'rejected', reason: 'سبب رفض كافٍ للاختبار' }).args,
        { p_decision: 'rejected', p_reason: 'سبب رفض كافٍ للاختبار' });
    assert.match(trialDecisionArgs({ decision: 'rejected', reason: 'قصير' }).error, /10 أحرف/);
    assert.match(trialDecisionArgs({ decision: 'rejected' }).error, /10 أحرف/);
    assert.match(trialDecisionArgs({ decision: 'maybe' }).error, /موافقة أو رفض/);
    assert.match(trialDecisionArgs({}).error, /موافقة أو رفض/);
});

// ── ④ قراءة الطلب والحالة ───────────────────────────────────────────────
test('④ اشتراك التجربة يُعرف بعلامة trial وحدها لا بالباقة أو التاريخ', () => {
    assert.equal(isTrialSubscription({ plan: 'support', price_snapshot: { trial: true } }), true);
    assert.equal(isTrialSubscription({ plan: 'support', price_snapshot: { trial: false } }), false);
    assert.equal(isTrialSubscription({ plan: 'support', price_snapshot: {} }), false);
    assert.equal(isTrialSubscription({ plan: 'support' }), false);
    assert.equal(isTrialSubscription(null), false);
});

test('④ طلب جارٍ: الأيام المتبقية 3 عند البداية ثم تنقص', () => {
    const now = new Date('2026-11-26T10:00:00Z').getTime();
    const view = trialRequestView({
        id: 'r1', plan_key: 'ultimate', status: 'approved',
        trial_ends_at: '2026-11-28T10:00:00.000Z'
    }, { now });
    assert.equal(view.planLabel, 'الخطة الفائقة');
    assert.equal(view.statusLabel, 'تجربة جارية');
    assert.equal(view.isActive, true);
    assert.equal(view.daysRemaining, 2);
    assert.equal(view.canCancel, false);
    assert.equal(view.canDecide, false);
});

test('④ طلب معلّق يقبل القرار والإلغاء، والمنتهي لا يقبل شيئًا', () => {
    const pending = trialRequestView({ id: 'r2', plan_key: 'store', status: 'pending' });
    assert.equal(pending.statusLabel, 'بانتظار قرار المالك');
    assert.equal(pending.isPending, true);
    assert.equal(pending.canCancel, true);
    assert.equal(pending.canDecide, true);
    assert.equal(pending.daysRemaining, 0);
    const now = new Date('2026-11-30T10:00:00Z').getTime();
    const expired = trialRequestView({
        id: 'r3', plan_key: 'support', status: 'approved',
        trial_ends_at: '2026-11-28T10:00:00.000Z'
    }, { now });
    assert.equal(expired.isActive, false);
    assert.equal(expired.isFinished, true);
    assert.equal(expired.daysRemaining, 0);
    assert.equal(trialRequestView(null), null);
    assert.equal(TRIAL_STATUS_LABELS.rejected, 'مرفوضة');
    assert.equal(TRIAL_STATUS_LABELS.expired, 'انتهت');
    assert.equal(TRIAL_STATUS_LABELS.cancelled, 'ملغاة');
});

test('④ حالة الشركة: الجارية والباقات المؤهلة وغير المؤهلة مع السبب', () => {
    const now = new Date('2026-11-26T10:00:00Z').getTime();
    const view = trialStatusView({
        has_company: true, can_request: true, company_name: 'شركة أ', account_kind: 'company',
        active_trial: { id: 'r1', plan_key: 'ultimate', status: 'approved', trial_ends_at: '2026-11-28T10:00:00.000Z' },
        requests: [
            { id: 'r1', plan_key: 'ultimate', status: 'approved', trial_ends_at: '2026-11-28T10:00:00.000Z' },
            { id: 'r0', plan_key: 'support', status: 'rejected' }
        ],
        eligible_plans: [
            { plan_key: 'support', plan_name_ar: 'الخطة المتقدمة', eligible: true },
            { plan_key: 'ultimate', plan_name_ar: 'الخطة الفائقة', eligible: false, reason: 'سبق أن استخدمت هذه الشركة التجربة المجانية لهذه الباقة' }
        ]
    }, { now });
    assert.equal(view.hasCompany, true);
    assert.equal(view.canRequest, true);
    assert.equal(view.activeTrial.planKey, 'ultimate');
    assert.equal(view.activeTrial.daysRemaining, 2);
    assert.equal(view.pendingRequests.length, 0);
    assert.deepEqual(view.eligiblePlans.map(p => p.planKey), ['support']);
    assert.equal(view.ineligiblePlans.length, 1);
    assert.match(view.ineligiblePlans[0].reason, /سبق أن استخدمت/);
    assert.deepEqual(trialStatusView({ has_company: false }),
        { hasCompany: false, canRequest: false, activeTrial: null, requests: [], eligiblePlans: [] });
    assert.deepEqual(trialStatusView(null),
        { hasCompany: false, canRequest: false, activeTrial: null, requests: [], eligiblePlans: [] });
});

// ── ⑤ الترحيل: بلا sandbox وبلا دفع وبلا تجديد ──────────────────────────
test('⑤ الترحيل: لا sandbox في الكود — التجربة على الحساب الحي نفسه', () => {
    assert.doesNotMatch(CODE_BEFORE_SELF_CHECK, /sandbox/i, 'لفظ sandbox في كود الترحيل 137 قبل الحارس');
    assert.match(CODE, /interval '3 days'/, 'مدة 3 أيام غائبة من الترحيل');
    assert.match(CODE, /trial_ends_at = trial_starts_at \+ interval '3 days'/, 'قيد 3 أيام غائب من الجدول');
    assert.match(CODE, /no_auto_renew/, 'علامة بلا تجديد تلقائي غائبة');
    assert.match(CODE, /no_payment_method/, 'علامة بلا طريقة دفع غائبة');
});

test('⑤ الترحيل: جدول الطلبات بلا عمود دفع أو بطاقة، والطلب لا ينشئ اشتراكًا', () => {
    assert.doesNotMatch(TABLE_DEF, /card|payment|sandbox/i,
        'عمود دفع/بطاقة في جدول طلبات التجربة');
    const requestFn = CODE.slice(CODE.indexOf('request_saas_trial'), CODE.indexOf('cancel_saas_trial'));
    assert.doesNotMatch(requestFn, /insert into public\.whatsapp_subscriptions/,
        'دالة الطلب تنشئ اشتراكًا — الطلب وحده مسموح');
    assert.match(requestFn, /current_company_id/, 'دالة الطلب بلا شركة الحالية');
    const decideFn = CODE.slice(CODE.indexOf('owner_decide_saas_trial'));
    assert.match(decideFn, /owner_critical_ok/, 'قرار المالك بلا تحقق حديث');
    assert.match(decideFn, /payment_method, payment_reference, price_snapshot/, 'صف التجربة بلا موضع دفع');
    assert.match(CODE, /expire_stale_subscriptions/, 'الانتهاء لا يمر عبر الوظيفة القائمة');
    assert.match(CODE, /grant execute on function public\.expire_saas_trials\(\) to service_role/,
        'وظيفة الانتهاء ليست لدور service_role');
});

// ── ⑥ الواجهتان موجودتان ومربوطتان ───────────────────────────────────────
test('⑥ صفحة المالك: عنوان وقائمة موافقات وقرارات ورسائل عربية', () => {
    assert.match(OWNER_PAGE, /طلبات التجربة المجانية/, 'عنوان صفحة المالك غائب');
    assert.match(OWNER_PAGE, /id="trialRequests"/, 'حاوية قائمة الطلبات غائبة');
    assert.match(OWNER_PAGE, /id="trialFilters"/, 'مرشحات الحالة غائبة');
    assert.match(OWNER_PAGE, /id="trialKpis"/, 'مؤشرات الطلبات غائبة');
    assert.match(OWNER_PAGE, /بلا بطاقة وبلا دفع/, 'قاعدة بلا دفع غائبة من الصفحة');
    assert.match(OWNER_PAGE, /تنتهي تلقائيًا بعد 3 أيام بلا تجديد/, 'قاعدة الانتهاء غائبة من الصفحة');
    assert.match(OWNER_PAGE, /assets\/js\/owner\/pages\/trials\.js/, 'سكربت الصفحة غير مربوط');
    assert.match(OWNER_JS, /owner_list_saas_trial_requests/, 'قائمة الطلبات لا تُقرأ من الدالة');
    assert.match(OWNER_JS, /owner_decide_saas_trial/, 'القرار لا يمر عبر دالة المالك');
    assert.match(OWNER_JS, /trialDecisionArgs/, 'القرار لا يمر عبر تحقق الواجهة');
});

test('⑥ الشريط الجانبي للمالك يصل إلى صفحة التجربة، ولوحة الشركة تعرض قسمها', () => {
    assert.match(SIDEBAR, /\/owner\/trials\.html/, 'رابط صفحة التجربة غائب من الشريط الجانبي');
    assert.match(SIDEBAR, /التجربة المجانية/, 'تسمية رابط التجربة غائبة');
    assert.match(COMPANY_BILLING, /my_saas_trial_status|fetchSaasTrialStatus/, 'لوحة الشركة لا تقرأ حالة التجربة');
    assert.match(COMPANY_BILLING, /request_saas_trial|requestSaasTrial/, 'لوحة الشركة لا ترسل طلب التجربة');
    assert.match(COMPANY_BILLING, /trialRequestView|trialStatusView/, 'لوحة الشركة لا تستخدم نموذج التجربة');
});
