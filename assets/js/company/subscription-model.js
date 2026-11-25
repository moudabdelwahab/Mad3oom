/**
 * subscription-model.js — قراءة اشتراكات الشركة كدوال خالصة.
 *
 * ── مصدر الحقيقة في التواريخ ──────────────────────────────────────────────
 *
 * القاعدة تخزّن timestamptz (لحظة مطلقة بالـUTC) وتحسب بنفسها:
 *     is_active      = status='active' AND start_date <= now() AND end_date > now()
 *     days_remaining = ceil((end_date - now()) / يوم)، بحدٍّ أدنى صفر
 *
 * و**ساعة القاعدة هي المرجع**، لا ساعة المتصفح: جهاز المستخدم قد يكون
 * مضبوطًا خطأً أو في منطقة أخرى، فحساب «هل انتهى اشتراكي؟» محليًّا يعطي
 * جوابًا يخالف ما يفرضه الخادم فعليًا عند أول نداء.
 *
 * فنقرأ is_active و days_remaining كما جاءا، ونحسب محليًّا **فقط** لكشف
 * الفارق بين الساعتين ونعلنه — لا لتصحيح الرقم.
 *
 * ── الخلل الذي يعالجه هذا الملف ───────────────────────────────────────────
 *
 * subscriptionStatusInfo القديمة كانت تقول:
 *     status='active' و is_active=false  ⇒  «منتهٍ»
 *
 * وهذا خطأ في حالة واحدة حقيقية وموجودة على الإنتاج اليوم: اشتراك
 * **لم يبدأ بعد** (start_date في المستقبل) يحمل status='active' و
 * is_active=false تمامًا كالمنتهي — فيُعرض «منتهٍ» وهو في الحقيقة
 * «يبدأ بعد يومين». والفرق بين القراءتين هو الفرق بين «جدّد الآن» و«لا
 * تفعل شيئًا».
 *
 * التمييز ممكن بلا أي تغيير في القاعدة: start_date موجود في الحمولة أصلًا.
 */

/** حدّ التنبيه على قرب الانتهاء — أسبوعان يكفيان لقرار تجديد. */
export const EXPIRY_WARNING_DAYS = 14;

/** فارق مقبول بين ساعة القاعدة وساعة المتصفح قبل أن يُعلَن. */
export const CLOCK_SKEW_TOLERANCE_DAYS = 1;

export const SUBSCRIPTION_STATES = {
    active:    { key: 'active',    label: 'نشط',           pill: 'status-tone-success' },
    expiring:  { key: 'expiring',  label: 'ينتهي قريبًا',  pill: 'status-tone-warning' },
    scheduled: { key: 'scheduled', label: 'لم يبدأ بعد',   pill: 'status-tone-accent'  },
    expired:   { key: 'expired',   label: 'منتهٍ',         pill: 'status-tone-danger'  },
    pending:   { key: 'pending',   label: 'قيد المراجعة',  pill: 'status-tone-warning' },
    rejected:  { key: 'rejected',  label: 'مرفوض',         pill: 'status-tone-danger'  },
    unknown:   { key: 'unknown',   label: 'غير محددة',     pill: 'status-neutral'      }
};

function ms(value) {
    if (!value) return null;
    const t = new Date(value).getTime();
    return Number.isNaN(t) ? null : t;
}

function days(fromMs, toMs) {
    if (fromMs == null || toMs == null) return null;
    return Math.ceil((toMs - fromMs) / 86400000);
}

/**
 * قراءة اشتراك واحد: حالته، أيامه، وأي تضارب في تواريخه.
 *
 * @param {object} sub    صف كما رجّعته get_my_company_dashboard()
 * @param {number} now    لحظة المرجع (للاختبار)
 */
export function analyzeSubscription(sub, { now = Date.now() } = {}) {
    const anomalies = [];
    if (!sub) return { state: SUBSCRIPTION_STATES.unknown, anomalies, daysRemaining: null, daysUntilStart: null };

    const start = ms(sub.start_date);
    const end = ms(sub.end_date);

    if (sub.start_date && start == null) anomalies.push('invalid_start');
    if (sub.end_date && end == null) anomalies.push('invalid_end');
    if (!sub.end_date) anomalies.push('missing_end');
    if (start != null && end != null && end < start) anomalies.push('inverted_range');

    const daysUntilStart = start != null && start > now ? days(now, start) : null;
    const localDaysRemaining = end != null ? days(now, end) : null;

    // ── فارق الساعتين ─────────────────────────────────────────────────────
    // القاعدة حسبت days_remaining بساعتها، ونحن نحسب بساعة المتصفح. الفارق
    // الكبير يعني جهازًا مضبوطًا خطأً — نعلنه ولا نصحّح الرقم.
    const serverDays = typeof sub.days_remaining === 'number' ? sub.days_remaining : null;
    if (serverDays != null && localDaysRemaining != null
        && Math.abs(serverDays - Math.max(0, localDaysRemaining)) > CLOCK_SKEW_TOLERANCE_DAYS) {
        anomalies.push('clock_skew');
    }

    // ── الحالة ────────────────────────────────────────────────────────────
    let state;
    if (sub.status === 'pending') {
        state = SUBSCRIPTION_STATES.pending;
    } else if (sub.status === 'rejected') {
        state = SUBSCRIPTION_STATES.rejected;
    } else if (sub.status === 'expired') {
        state = SUBSCRIPTION_STATES.expired;
    } else if (sub.status === 'active') {
        if (start != null && start > now) {
            // الحالة التي كانت تُعرض «منتهٍ» خطأً
            state = SUBSCRIPTION_STATES.scheduled;
            anomalies.push('future_start');
        } else if (sub.is_active === true) {
            state = serverDays != null && serverDays <= EXPIRY_WARNING_DAYS
                ? SUBSCRIPTION_STATES.expiring
                : SUBSCRIPTION_STATES.active;
        } else {
            // status='active' لكن المدة انقضت: الوظيفة الدورية لم تمرّ بعد.
            state = SUBSCRIPTION_STATES.expired;
            anomalies.push('stale_active');
        }
    } else {
        state = SUBSCRIPTION_STATES.unknown;
    }

    return {
        state,
        anomalies,
        daysRemaining: serverDays,
        localDaysRemaining,
        daysUntilStart,
        isActive: sub.is_active === true,
        // 136: علَم الإلغاء في نهاية المدة كما رجّعته حمولة اللوحة. الحالة
        // تبقى «نشط» حتى الانتهاء — العلَم ليس حالة جديدة ولا تضاربًا.
        cancelAtPeriodEnd: sub.cancel_at_period_end === true
    };
}

/** شرح بشري لكل تضارب — يقول ما حدث وما أثره، لا رمزًا تقنيًا. */
export const ANOMALY_NOTES = {
    future_start: {
        tone: 'accent',
        text: 'هذا الاشتراك لم تبدأ مدّته بعد، فخدماته لا تُحتسب حتى تاريخ البداية. '
            + 'هو ليس منتهيًا ولا يحتاج تجديدًا.'
    },
    stale_active: {
        tone: 'danger',
        text: 'انقضت مدّة هذا الاشتراك وما زالت حالته «نشط» في السجل. '
            + 'الخدمات مسحوبة فعليًا، والحالة تُصحَّح آليًا خلال ساعة.'
    },
    inverted_range: {
        tone: 'danger',
        text: 'تاريخ النهاية قبل تاريخ البداية. راجع الدعم — هذا الصف لا يمكن الاعتماد عليه.'
    },
    missing_end: {
        tone: 'danger',
        text: 'لا تاريخ انتهاء مسجّل لهذا الاشتراك.'
    },
    invalid_start: { tone: 'danger', text: 'تاريخ البداية غير صالح في السجل.' },
    invalid_end:   { tone: 'danger', text: 'تاريخ الانتهاء غير صالح في السجل.' },
    clock_skew: {
        tone: 'warning',
        text: 'ساعة جهازك تختلف عن ساعة الخادم بأكثر من يوم. الأرقام المعروضة '
            + 'محسوبة على ساعة الخادم وهي المعتمدة.'
    },
    overlap: {
        tone: 'warning',
        text: 'تتداخل مدّة هذا الاشتراك مع اشتراك آخر في نفس الباقة. '
            + 'الخدمات لا تتضاعف — المدّتان تغطّيان نفس الفترة.'
    },
    gap: {
        tone: 'warning',
        text: 'بين هذا الاشتراك وسابقه في نفس الباقة فترة انقطاع لم تكن الخدمات متاحة فيها.'
    }
};

/**
 * قراءة المجموعة كاملة: ما يخصّ كل صف، وما لا يظهر إلا بالمقارنة بين الصفوف
 * (تداخل المدد، وفجوات سلسلة التجديد).
 */
export function analyzeSubscriptions(subscriptions, { now = Date.now() } = {}) {
    const rows = (subscriptions || []).map(sub => ({
        sub,
        ...analyzeSubscription(sub, { now })
    }));

    // ── تداخل وفجوات داخل كل باقة على حدة ─────────────────────────────────
    const byPlan = new Map();
    for (const row of rows) {
        const key = row.sub?.plan;
        if (!key || row.sub.status === 'rejected') continue;
        if (!byPlan.has(key)) byPlan.set(key, []);
        byPlan.get(key).push(row);
    }

    for (const chain of byPlan.values()) {
        const ordered = chain
            .filter(r => ms(r.sub.start_date) != null && ms(r.sub.end_date) != null)
            .sort((a, b) => ms(a.sub.start_date) - ms(b.sub.start_date));

        for (let i = 1; i < ordered.length; i++) {
            const prevEnd = ms(ordered[i - 1].sub.end_date);
            const thisStart = ms(ordered[i].sub.start_date);
            if (thisStart < prevEnd) {
                if (!ordered[i].anomalies.includes('overlap')) ordered[i].anomalies.push('overlap');
                if (!ordered[i - 1].anomalies.includes('overlap')) ordered[i - 1].anomalies.push('overlap');
            } else if (thisStart - prevEnd > 86400000) {
                if (!ordered[i].anomalies.includes('gap')) ordered[i].anomalies.push('gap');
            }
        }
    }

    const current = rows.filter(r => r.state.key === 'active' || r.state.key === 'expiring');
    const scheduled = rows.filter(r => r.state.key === 'scheduled');
    const anomalous = rows.filter(r => r.anomalies.length > 0);

    // أقرب انتهاء بين الفعّالة — الرقم الأهم لصاحب الشركة
    const nearest = current
        .slice()
        .sort((a, b) => (a.daysRemaining ?? Infinity) - (b.daysRemaining ?? Infinity))[0] || null;

    return {
        rows,
        total: rows.length,
        active: current.length,
        scheduled: scheduled.length,
        pending: rows.filter(r => r.state.key === 'pending').length,
        expired: rows.filter(r => r.state.key === 'expired').length,
        // 136: اشتراكات فعّالة ألغاها صاحبها في نهاية مدّتها — ما زالت نشطة
        // حتى الانتهاء، لكنها لا تُجدَّد.
        cancelling: rows.filter(r => r.cancelAtPeriodEnd).length,
        nearest,
        daysToNearestExpiry: nearest ? nearest.daysRemaining : null,
        anomalies: anomalous,
        hasAnomalies: anomalous.length > 0
    };
}

/**
 * سياق زر «جدّد الآن» في لوحة الشركة.
 *
 * مسار التجديد الموجود هو صفحة الاشتراكات (/subscriptions.html): زر
 * «تجديد الاشتراك الحالي» يُولَّد هناك بجانب الاشتراك النشط نفسه
 * (subscriptions-script.js: updateSubscriptionDisplay) وhandleRenew يرسل
 * طلب التجديد. الصفحة لا تقرأ أي معامل من الرابط، فلا نمرّر خطة في الرابط —
 * الرابط إلى الصفحة كما هي، والسياق (اسم الباقة وتاريخ الانتهاء) معروض هنا.
 *
 * القواعد — من التقرير المحسوب أصلًا، بلا قراءة جديدة:
 *   - أقرب اشتراك نشط أو ينتهي قريبًا ⇒ «جدّد الآن» بسياقه.
 *   - بلا فعّال، مع منتهٍ واحد على الأقل ⇒ «اشترك مجددًا» بسياق أحدث منتهٍ.
 *   - قيد المراجعة وحده أو لم يبدأ بعد وحده ⇒ لا زر: الطلب يُراجَع،
 *     والمجدول لا يحتاج تجديدًا (التمييز الذي يحرسه analyzeSubscription).
 *   - بلا اشتراكات ⇒ لا زر (حالة الفراغ لها «استعراض الباقات» أصلًا).
 */
export function renewalContext(report) {
    if (!report) return null;

    const nearest = report.nearest;
    if (nearest) {
        return {
            kind: 'renew',
            planKey: nearest.sub.plan,
            planName: nearest.sub.plan_name_ar || nearest.sub.plan,
            endDate: nearest.sub.end_date || null,
            daysRemaining: nearest.daysRemaining ?? null,
            // 136: دورة الفوترة الحالية — التجديد داخل اللوحة يبدأ منها،
            // ويمكن تغييرها في نافذة التجديد نفسها.
            billingCycle: nearest.sub.billing_cycle || 'monthly',
            href: '/subscriptions.html',
            label: 'جدّد الآن'
        };
    }

    const expiredRows = (report.rows || [])
        .filter(r => r.state.key === 'expired')
        .sort((a, b) => String(b.sub.end_date || '').localeCompare(String(a.sub.end_date || '')));
    if (expiredRows.length) {
        const last = expiredRows[0];
        return {
            kind: 'resubscribe',
            planKey: last.sub.plan,
            planName: last.sub.plan_name_ar || last.sub.plan,
            endDate: last.sub.end_date || null,
            daysRemaining: null,
            billingCycle: last.sub.billing_cycle || 'monthly',
            href: '/subscriptions.html',
            label: 'اشترك مجددًا'
        };
    }

    return null;
}

/**
 * ما الذي تحصل عليه الشركة فعلًا الآن؟
 * الاستحقاقات تأتي محسوبة من القاعدة (اتحاد امتيازات الباقات الفعّالة)،
 * فنعرضها كما هي ولا نشتقّها من أسماء الباقات.
 */
export function upgradeCandidates(plans, dashboard) {
    const activeKeys = new Set((dashboard?.access?.active_plans) || []);
    return (plans || [])
        .filter(plan => plan.is_active !== false && !activeKeys.has(plan.key))
        .map(plan => ({
            key: plan.key,
            name: plan.name_ar || plan.name || plan.key,
            requiresCompany: plan.requires_company === true
        }));
}

/**
 * رسائل عربية لأكواد عدم أهلية عروض تغيير الباقة — نفس الأكواد التي ترجّعها
 * subscription_upgrade_quote (019) و subscription_downgrade_quote (136).
 * الواجهة تعرض رسالة القاعدة كما هي؛ هذا التحويل لعرض السبب قبل إرسال أي
 * طلب، لا لحساب أهلية من المتصفح.
 */
export const QUOTE_CODE_MESSAGES = {
    not_authenticated: 'يجب تسجيل الدخول أولًا.',
    unknown_plan: 'باقة غير معروفة أو غير مفعّلة.',
    no_active_subscription: 'لا يوجد اشتراك فعّال يمكن تغييره.',
    duplicate_plan: 'هذه هي باقتك الحالية.',
    price_missing: 'سعر هذه الباقة غير مسجّل بعد. راجع الدعم.',
    not_an_upgrade: 'هذه الباقة ليست أغلى من باقتك الحالية — الترقية للباقات الأغلى فقط.',
    not_a_downgrade: 'هذه الباقة ليست أرخص من باقتك الحالية — التخفيض للباقات الأرخص فقط.',
    redundant: 'هذه الباقة لا تضيف خدمات جديدة إلى اشتراكك الحالي.',
    quote_failed: 'تعذّر حساب عرض تغيير الباقة. تحقق من اتصالك ثم أعد المحاولة.'
};

export function quoteCodeMessage(code) {
    return QUOTE_CODE_MESSAGES[code] || null;
}

/**
 * طلب معلّق على باقة بعينها — تجديدها مثلًا مرفوض في القاعدة ما دام هذا
 * الطلب قيد المراجعة (023)، فنعطّل الزر هنا برسالة واضحة بدل خطأ لاحق.
 */
export function pendingRequestFor(report, planKey) {
    if (!report || !planKey) return null;
    return (report.rows || []).find(r => r.state.key === 'pending' && r.sub?.plan === planKey) || null;
}

/**
 * إجراءات الإدارة الذاتية المتاحة على صفّ اشتراك واحد (136).
 *
 *   - فعّال/ينتهي قريبًا + مالك الشركة: تجديد، وتغيير باقة (ترقية/تخفيض
 *     حسب عرض القاعدة)، وإلغاء في نهاية المدة — أو التراجع عنه إن كان
 *     ملغى أصلًا. الخدمة تبقى حتى الانتهاء في كل الأحوال.
 *   - قيد المراجعة + مالك: إلغاء الطلب نفسه (023) فقط.
 *   - غير المالك، أو لم يبدأ بعد، أو منتهٍ، أو مرفوض: لا إجراء من هنا —
 *     دوال القاعدة ترفض غير المالك أصلًا، فلا نعرض زرًا يفشل حتمًا.
 */
export function subscriptionActions(row, { isOwner = false } = {}) {
    if (!row || !isOwner) return [];
    const state = row.state?.key;
    if (state === 'pending') return ['cancel-request'];
    if (state === 'active' || state === 'expiring') {
        return row.cancelAtPeriodEnd
            ? ['renew', 'change-plan', 'resume']
            : ['renew', 'change-plan', 'cancel'];
    }
    return [];
}
