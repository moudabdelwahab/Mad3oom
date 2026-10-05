/**
 * plan-pricing-model.js — أسماء الخطط وأسعارها ورصيد التذاكر كدوال خالصة.
 *
 * بلا DOM وبلا شبكة، فيُختبر بمعزل (tests/plan-pricing-model.test.mjs).
 * الأسعار نفسها مصدرها subscription_plans، ورصيد التذاكر مصدره
 * my_ticket_wallet() — هنا العرض فقط.
 */

/** الخطط المعروضة للبيع. واتساب والشاملة مخفيتان حاليًا (مشتركوهما يجددون كالمعتاد). */
export const SALE_PLAN_KEYS = ['support', 'ultimate'];

export const PLAN_LABELS = {
    free: 'الخطة المجانية',
    support: 'الخطة المتقدمة',
    ultimate: 'الخطة الفائقة',
    whatsapp: 'واتساب بيزنس',
    bundle: 'الباقة الشاملة'
};

export const CURRENCY_SYMBOLS = { EGP: 'ج.م', USD: '$' };

export function currencySymbol(currency) {
    return CURRENCY_SYMBOLS[currency] || currency || '';
}

/** «9,999 ج.م» / «$20». الجنيه بعد الرقم، والدولار قبله. */
export function formatMoney(amount, currency = 'EGP') {
    if (amount === null || amount === undefined || amount === '' || Number.isNaN(Number(amount))) return '—';
    const n = Number(amount);
    const text = n.toLocaleString('en-US', { maximumFractionDigits: Number.isInteger(n) ? 0 : 2 });
    return currency === 'USD' ? `$${text}` : `${text} ${currencySymbol(currency)}`.trim();
}

/** نسبة الخصم بين سعر قبل وبعد (رقم صحيح)، أو null لو مفيش خصم. */
export function discountPercent(oldPrice, newPrice) {
    const o = Number(oldPrice), n = Number(newPrice);
    if (!(o > 0) || !(n >= 0) || n >= o) return null;
    return Math.round((1 - n / o) * 100);
}

/** التوفير السنوي مقارنةً بالدفع الشهري 12 مرة. */
export function yearlySavingPercent(monthly, yearly) {
    return discountPercent(Number(monthly) * 12, yearly);
}

/**
 * عرض محفظة التذاكر من ناتج my_ticket_wallet().
 * @returns {{ planLabel, unlimited, used, limit, remaining, percent, tone, headline, sub, resetsAt }}
 */
export function walletView(wallet, now = new Date()) {
    if (!wallet) return null;
    const unlimited = wallet.unlimited === true;
    const used = Number(wallet.used) || 0;
    const limit = unlimited ? null : Number(wallet.monthly_limit) || 0;
    const remaining = unlimited ? null : Math.max(0, Number(wallet.remaining ?? (limit - used)));
    const percent = unlimited || !limit ? 0 : Math.min(100, Math.round(used / limit * 100));
    const tone = unlimited ? 'ok' : remaining === 0 ? 'empty' : percent >= 80 ? 'warn' : 'ok';
    const resetsAt = wallet.resets_at ? new Date(wallet.resets_at) : null;
    const days = resetsAt ? Math.max(0, Math.ceil((resetsAt - now) / 86400000)) : null;
    return {
        planKey: wallet.plan_key,
        planLabel: wallet.plan_name_ar || PLAN_LABELS[wallet.plan_key] || wallet.plan_key,
        isFree: wallet.is_free === true,
        shared: wallet.shared_account === true,
        unlimited, used, limit, remaining, percent, tone, resetsAt, daysToReset: days,
        headline: unlimited ? 'تذاكر غير محدودة' : `متبقي ${remaining} من ${limit} تذكرة`,
        sub: unlimited
            ? `استخدمت ${used} تذكرة هذا الشهر`
            : remaining === 0
                ? 'نفد رصيد هذا الشهر — رقّي خطتك أو انتظر التجديد'
                : `استخدمت ${used} تذكرة هذا الشهر`
    };
}

/** «يتجدد خلال 3 أيام» / «يتجدد اليوم». */
export function resetText(days) {
    if (days === null || days === undefined) return '';
    if (days <= 0) return 'يتجدد الرصيد اليوم';
    if (days === 1) return 'يتجدد الرصيد بكرة';
    return `يتجدد الرصيد خلال ${days} ${days <= 10 ? 'أيام' : 'يوم'}`;
}

/** مدة الاشتراك المتبقية كنسبة من دورته (لشريط التقدم). */
export function cycleProgress(startIso, endIso, now = new Date()) {
    const s = new Date(startIso).getTime(), e = new Date(endIso).getTime(), t = now.getTime();
    if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return { percentLeft: 0, daysLeft: 0, totalDays: 0 };
    const daysLeft = Math.max(0, Math.ceil((e - t) / 86400000));
    const totalDays = Math.max(1, Math.round((e - s) / 86400000));
    return { percentLeft: Math.max(0, Math.min(100, Math.round((e - t) / (e - s) * 100))), daysLeft, totalDays };
}

/**
 * مزايا كل خطة كما تُعرض لصاحبها — نفس أرقام صفحة الأسعار ونفس ما تفرضه
 * القاعدة (plan_ticket_quotas وامتيازات plan_features).
 */
const FEATURE_ROWS = [
    { key: 'tickets', label: 'تذاكر الدعم الشهرية', values: { free: '20 تذكرة', support: '300 تذكرة', ultimate: 'غير محدودة', bundle: 'غير محدودة', whatsapp: '20 تذكرة' } },
    { key: 'chat', label: 'المحادثة مع الدعم', values: { free: 'ساعات العمل', support: '24/7', ultimate: '24/7', bundle: '24/7', whatsapp: 'ساعات العمل' } },
    { key: 'subdomain', label: 'نطاق فرعي مجاني', values: { free: false, support: true, ultimate: true, bundle: true, whatsapp: false } },
    { key: 'members', label: 'أعضاء الفريق', values: { free: '1', support: 'حتى 25 عضوًا', ultimate: 'حتى 25 عضوًا', bundle: 'حتى 25 عضوًا', whatsapp: '1' } },
    { key: 'api', label: 'مفاتيح API', values: { free: false, support: true, ultimate: true, bundle: true, whatsapp: false } },
    { key: 'stats', label: 'الإحصائيات المتقدمة وسجل النشاط', values: { free: false, support: true, ultimate: true, bundle: true, whatsapp: false } },
    { key: 'priority', label: 'الدعم الأولوي', values: { free: false, support: true, ultimate: '24/7', bundle: '24/7', whatsapp: false } },
    { key: 'whatsapp', label: 'واتساب بيزنس', values: { free: false, support: false, ultimate: false, bundle: true, whatsapp: true }, onlyIfIncluded: true }
];

/** @returns {Array<{label, included:boolean, value:string|null}>} */
export function planFeatureRows(planKey) {
    const key = FEATURE_ROWS[0].values[planKey] !== undefined ? planKey : 'free';
    return FEATURE_ROWS
        .filter(r => !r.onlyIfIncluded || r.values[key])
        .map(r => {
            const v = r.values[key];
            return { label: r.label, included: v !== false, value: typeof v === 'string' ? v : null };
        });
}

/** الخطة التالية للترقية، أو null لو مفيش أعلى. */
export function nextPlanKey(planKey) {
    if (planKey === 'free' || planKey === 'whatsapp' || !planKey) return 'support';
    if (planKey === 'support') return 'ultimate';
    return null;
}

const STATUS_INFO = {
    active: { label: 'نشط', tone: 'ok' },
    pending: { label: 'قيد المراجعة', tone: 'warn' },
    expired: { label: 'منتهي', tone: 'muted' },
    rejected: { label: 'مرفوض', tone: 'bad' },
    superseded: { label: 'تمت ترقيته', tone: 'muted' }
};

/** حالة صف اشتراك للعرض، مع «ينتهي قريبًا» لو باقي 7 أيام أو أقل. */
export function subscriptionStatus(sub, now = new Date()) {
    if (!sub) return { label: 'مجاني', tone: 'free' };
    const base = STATUS_INFO[sub.status] || { label: sub.status, tone: 'muted' };
    if (sub.status === 'active' && sub.end_date) {
        const days = Math.ceil((new Date(sub.end_date) - now) / 86400000);
        if (days <= 0) return { label: 'منتهي', tone: 'muted' };
        if (days <= 7) return { label: days === 1 ? 'ينتهي خلال يوم' : days === 2 ? 'ينتهي خلال يومين' : `ينتهي خلال ${days} أيام`, tone: 'warn' };
    }
    return base;
}
