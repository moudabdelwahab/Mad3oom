/**
 * اختبارات قراءة اشتراكات الشركة — دوال خالصة.
 *
 * الخلل المركزي الذي تحرسه: اشتراك **لم يبدأ بعد** كان يُعرض «منتهٍ».
 * الحالتان تحملان status='active' و is_active=false، والفرق بينهما هو
 * الفرق بين «جدّد الآن» و«لا تفعل شيئًا» — وهو موجود على الإنتاج فعلًا.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
    analyzeSubscription, analyzeSubscriptions, upgradeCandidates,
    SUBSCRIPTION_STATES, EXPIRY_WARNING_DAYS, ANOMALY_NOTES
} = await import('../assets/js/company/subscription-model.js');

const NOW = Date.parse('2026-09-14T12:00:00Z');
const day = 86400000;
const iso = (offsetDays) => new Date(NOW + offsetDays * day).toISOString();

/** صفّ كما ترجّعه get_my_company_dashboard() بالضبط. */
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

/* ── الخلل المركزي ──────────────────────────────────────────────────────── */

test('اشتراك لم يبدأ بعد يُقرأ «لم يبدأ» لا «منتهٍ»', () => {
    // الحالة الحقيقية على الإنتاج: bundle يبدأ بعد يومين
    const r = analyzeSubscription(
        sub({ start_date: iso(2), end_date: iso(1500), is_active: false, days_remaining: 1500 }),
        { now: NOW });
    assert.equal(r.state.key, 'scheduled');
    assert.equal(r.state.label, 'لم يبدأ بعد');
    assert.equal(r.daysUntilStart, 2);
    assert.ok(r.anomalies.includes('future_start'));
});

test('اشتراك انقضت مدّته وحالته «نشط» يُقرأ منتهيًا ويُعلَن التضارب', () => {
    const r = analyzeSubscription(
        sub({ start_date: iso(-90), end_date: iso(-1), is_active: false, days_remaining: 0 }),
        { now: NOW });
    assert.equal(r.state.key, 'expired');
    assert.ok(r.anomalies.includes('stale_active'));
});

test('الحالتان تُفرَّقان رغم تطابق status و is_active', () => {
    const notStarted = analyzeSubscription(
        sub({ start_date: iso(5), end_date: iso(400), is_active: false, days_remaining: 400 }), { now: NOW });
    const finished = analyzeSubscription(
        sub({ start_date: iso(-400), end_date: iso(-5), is_active: false, days_remaining: 0 }), { now: NOW });

    assert.equal(notStarted.state.key, 'scheduled');
    assert.equal(finished.state.key, 'expired');
    assert.notEqual(notStarted.state.pill, finished.state.pill,
        'الحالتان تظهران بنفس اللون — المستخدم لا يفرّق بينهما');
});

/* ── الحالات ────────────────────────────────────────────────────────────── */

test('نشط وينتهي قريبًا يُفرَّقان عند الحدّ', () => {
    assert.equal(analyzeSubscription(sub({ days_remaining: EXPIRY_WARNING_DAYS + 1 }), { now: NOW }).state.key, 'active');
    assert.equal(analyzeSubscription(sub({ days_remaining: EXPIRY_WARNING_DAYS }), { now: NOW }).state.key, 'expiring');
    assert.equal(analyzeSubscription(sub({ days_remaining: 1 }), { now: NOW }).state.key, 'expiring');
});

test('قيد المراجعة والمرفوض يُقرآن كما هما', () => {
    assert.equal(analyzeSubscription(sub({ status: 'pending', is_active: false }), { now: NOW }).state.key, 'pending');
    assert.equal(analyzeSubscription(sub({ status: 'rejected', is_active: false }), { now: NOW }).state.key, 'rejected');
});

test('صفّ غائب أو بحالة مجهولة لا يكسر شيئًا', () => {
    assert.equal(analyzeSubscription(null, { now: NOW }).state.key, 'unknown');
    assert.equal(analyzeSubscription(sub({ status: 'weird', is_active: false }), { now: NOW }).state.key, 'unknown');
});

/* ── تضارب التواريخ ─────────────────────────────────────────────────────── */

test('نهاية قبل بداية تُعلَن تضاربًا', () => {
    const r = analyzeSubscription(sub({ start_date: iso(10), end_date: iso(5), is_active: false }), { now: NOW });
    assert.ok(r.anomalies.includes('inverted_range'));
});

test('تاريخ انتهاء غائب أو غير صالح يُعلَن', () => {
    assert.ok(analyzeSubscription(sub({ end_date: null }), { now: NOW }).anomalies.includes('missing_end'));
    assert.ok(analyzeSubscription(sub({ end_date: 'ليس تاريخًا' }), { now: NOW }).anomalies.includes('invalid_end'));
});

test('فارق ساعة المتصفح عن الخادم يُعلَن ولا يُصحَّح الرقم', () => {
    // الخادم يقول 60 يومًا، والتواريخ محليًّا تعطي 10 — جهاز مضبوط خطأً
    const r = analyzeSubscription(sub({ end_date: iso(10), days_remaining: 60 }), { now: NOW });
    assert.ok(r.anomalies.includes('clock_skew'));
    assert.equal(r.daysRemaining, 60, 'الرقم المعروض يجب أن يظل رقم الخادم');
    assert.equal(r.localDaysRemaining, 10);
});

test('فارق يوم واحد لا يُعلَن — تقريب لا خلل', () => {
    const r = analyzeSubscription(sub({ end_date: iso(60), days_remaining: 61 }), { now: NOW });
    assert.ok(!r.anomalies.includes('clock_skew'));
});

test('لكل تضارب شرح بشري يقول الأثر لا رمزًا تقنيًا', () => {
    for (const key of ['future_start', 'stale_active', 'inverted_range', 'missing_end',
                       'invalid_start', 'invalid_end', 'clock_skew', 'overlap', 'gap']) {
        assert.ok(ANOMALY_NOTES[key]?.text?.length > 20, `شرح ناقص لـ${key}`);
        assert.ok(ANOMALY_NOTES[key].tone, `نبرة ناقصة لـ${key}`);
    }
});

/* ── المقارنة بين الصفوف ────────────────────────────────────────────────── */

test('تداخل مدّتين في نفس الباقة يُعلَن على الصفّين', () => {
    const list = [
        sub({ id: 'a', plan: 'bundle', start_date: iso(-30), end_date: iso(2), days_remaining: 2 }),
        sub({ id: 'b', plan: 'bundle', start_date: iso(-5), end_date: iso(300), days_remaining: 300 })
    ];
    const out = analyzeSubscriptions(list, { now: NOW });
    const flagged = out.rows.filter(r => r.anomalies.includes('overlap'));
    assert.equal(flagged.length, 2, 'التداخل يخصّ الصفّين معًا لا واحدًا');
});

test('تداخل بين باقتين مختلفتين ليس تداخلًا', () => {
    const list = [
        sub({ id: 'a', plan: 'bundle', start_date: iso(-30), end_date: iso(60) }),
        sub({ id: 'b', plan: 'support', start_date: iso(-10), end_date: iso(20) })
    ];
    const out = analyzeSubscriptions(list, { now: NOW });
    assert.equal(out.rows.filter(r => r.anomalies.includes('overlap')).length, 0);
});

test('فجوة في سلسلة التجديد تُعلَن', () => {
    const list = [
        sub({ id: 'a', plan: 'support', start_date: iso(-90), end_date: iso(-40), status: 'expired', is_active: false, days_remaining: 0 }),
        sub({ id: 'b', plan: 'support', start_date: iso(-10), end_date: iso(50), days_remaining: 50 })
    ];
    const out = analyzeSubscriptions(list, { now: NOW });
    assert.ok(out.rows.find(r => r.sub.id === 'b').anomalies.includes('gap'));
});

test('تجديد متّصل بلا فجوة ولا تداخل لا يُعلَن عليه شيء', () => {
    const list = [
        sub({ id: 'a', plan: 'support', start_date: iso(-60), end_date: iso(-30), status: 'expired', is_active: false, days_remaining: 0 }),
        sub({ id: 'b', plan: 'support', start_date: iso(-30), end_date: iso(30), days_remaining: 30 })
    ];
    const out = analyzeSubscriptions(list, { now: NOW });
    assert.equal(out.hasAnomalies, false, `ظهر تضارب: ${JSON.stringify(out.anomalies.map(a => a.anomalies))}`);
});

test('المرفوض لا يدخل حساب التداخل — ليس مدّة قائمة', () => {
    const list = [
        sub({ id: 'a', plan: 'bundle', start_date: iso(-30), end_date: iso(60) }),
        sub({ id: 'b', plan: 'bundle', start_date: iso(-20), end_date: iso(40), status: 'rejected', is_active: false })
    ];
    assert.equal(analyzeSubscriptions(list, { now: NOW }).rows
        .filter(r => r.anomalies.includes('overlap')).length, 0);
});

/* ── الملخّص ────────────────────────────────────────────────────────────── */

test('الملخّص يفصل «لم يبدأ» عن «نشط» وعن «منتهٍ»', () => {
    const list = [
        sub({ id: 'a', plan: 'bundle', days_remaining: 60 }),
        sub({ id: 'b', plan: 'support', start_date: iso(3), end_date: iso(100), is_active: false, days_remaining: 100 }),
        sub({ id: 'c', plan: 'whatsapp', status: 'expired', is_active: false, start_date: iso(-90), end_date: iso(-10), days_remaining: 0 }),
        sub({ id: 'd', plan: 'aqar', status: 'pending', is_active: false })
    ];
    const out = analyzeSubscriptions(list, { now: NOW });
    assert.equal(out.total, 4);
    assert.equal(out.active, 1);
    assert.equal(out.scheduled, 1);
    assert.equal(out.expired, 1);
    assert.equal(out.pending, 1);
});

test('أقرب انتهاء يُحسب من الفعّالة وحدها', () => {
    const list = [
        sub({ id: 'a', plan: 'bundle', days_remaining: 90 }),
        sub({ id: 'b', plan: 'support', days_remaining: 7 }),
        sub({ id: 'c', plan: 'whatsapp', status: 'expired', is_active: false, days_remaining: 0,
              start_date: iso(-90), end_date: iso(-1) })
    ];
    const out = analyzeSubscriptions(list, { now: NOW });
    assert.equal(out.daysToNearestExpiry, 7);
    assert.equal(out.nearest.sub.id, 'b');
});

test('قائمة فارغة لا تكسر شيئًا', () => {
    const out = analyzeSubscriptions([], { now: NOW });
    assert.equal(out.total, 0);
    assert.equal(out.nearest, null);
    assert.equal(out.hasAnomalies, false);
});

/* ── الترقيات ───────────────────────────────────────────────────────────── */

test('الترقيات المتاحة تستثني الباقات الفعّالة', () => {
    const plans = [
        { key: 'bundle', name_ar: 'الشاملة', is_active: true },
        { key: 'support', name_ar: 'الدعم', is_active: true },
        { key: 'old', name_ar: 'قديمة', is_active: false }
    ];
    const dashboard = { access: { active_plans: ['bundle'] } };
    const out = upgradeCandidates(plans, dashboard);
    assert.deepEqual(out.map(p => p.key), ['support'], 'الباقة الفعّالة أو المعطّلة ظهرت كترقية');
});
