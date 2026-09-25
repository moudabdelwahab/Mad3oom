/**
 * sie-plan-model.js
 * ------------------------------------------------------------
 * عرض خطة SIE واستخدامها — دوال نقية (بلا DOM ولا شبكة) تُختبر في Node.
 *
 * مصدر الحقيقة الوحيد هو الخادم: sie_my_entitlement() (migration 0011 في
 * مستودع SIE). هذه الوحدة **لا تحتوي أي قاعدة من قواعد الخطط**: لا تعرف
 * أي انتقال مسموح (الخادم يرسل downgrade_to)، ولا أي حد أو إعادة ضبط
 * (الخادم يرسل limits / primary / resets_at). وظيفتها التنسيق فقط:
 * تحويل ما قاله الخادم إلى نص عربي وأرقام ونسبة، والتعامل بأمان مع رد ناقص
 * أو تالف (fail-safe): رد غير مفهوم يُعرض «غير متاح حاليًا»، لا يرمي.
 * ------------------------------------------------------------
 */

export const PLAN_LABELS = Object.freeze({ free: 'المجاني', pro: 'برو', max: 'ماكس' });

/** وضع الرد الوحيد المتاح. أي قيمة قديمة ('traditional' / 'ai_model' / 'auto') تُقرأ SIE. */
export const RESPONSE_MODE = 'sie';
export function normalizeChatbotMode() {
    return RESPONSE_MODE;
}

export const REASON_TEXT = Object.freeze({
    not_enabled: 'محرك الدعم الذكي (SIE) غير مفعّل لحسابك حاليًا.',
    disabled: 'تم إيقاف محرك الدعم الذكي (SIE) لحسابك.',
    expired: 'انتهت صلاحية استخدامك لمحرك الدعم الذكي (SIE).',
    quota_exceeded: 'استهلكت كل رسائل محرك الدعم الذكي (SIE) المتاحة لحسابك.',
    edition_monthly_limit: 'وصلت لحد رسائل الشهر في خطتك الحالية.'
});

const KNOWN_PLANS = new Set(['free', 'pro', 'max']);
const KNOWN_KINDS = new Set(['lifetime', 'monthly', 'unlimited']);

function num(v) {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
    return Number.isFinite(n) ? n : null;
}

function normalizeLimit(raw) {
    if (!raw || typeof raw !== 'object' || !KNOWN_KINDS.has(raw.kind)) return null;
    const used = Math.max(0, num(raw.used) ?? 0);
    const limit = raw.kind === 'unlimited' ? null : num(raw.limit);
    if (raw.kind !== 'unlimited' && (limit === null || limit <= 0)) return null;
    const remaining = limit === null ? null : Math.max(0, num(raw.remaining) ?? limit - used);
    const resetsAt = typeof raw.resets_at === 'string' && !Number.isNaN(Date.parse(raw.resets_at)) ? raw.resets_at : null;
    return { kind: raw.kind, used, limit, remaining, resetsAt };
}

/**
 * يحوّل رد sie_my_entitlement() الخام إلى شكل آمن للعرض.
 * @returns {{status:'ok'|'signed_out'|'unavailable', plan:string|null, planLabel:string|null,
 *            hasAccess:boolean, reason:string|null, reasonText:string|null,
 *            downgradeTo:Array<{plan:string,label:string}>, primary:Object|null}}
 */
export function normalizeEntitlement(raw) {
    const unavailable = {
        status: 'unavailable', plan: null, planLabel: null, hasAccess: false, reason: null,
        reasonText: null, downgradeTo: [], primary: null
    };
    if (!raw || typeof raw !== 'object') return unavailable;
    if (raw.signed_in === false) return { ...unavailable, status: 'signed_out' };
    if (raw.signed_in !== true) return unavailable;

    const plan = KNOWN_PLANS.has(raw.edition) ? raw.edition : null;
    if (!plan) return unavailable;

    const reason = typeof raw.reason === 'string' ? raw.reason : null;
    const downgradeTo = (Array.isArray(raw.downgrade_to) ? raw.downgrade_to : [])
        .filter((p) => KNOWN_PLANS.has(p) && p !== plan)
        .map((p) => ({ plan: p, label: PLAN_LABELS[p] }));

    return {
        status: 'ok',
        plan,
        planLabel: PLAN_LABELS[plan],
        hasAccess: raw.has_access === true,
        reason,
        reasonText: reason ? (REASON_TEXT[reason] || 'محرك الدعم الذكي (SIE) غير متاح لحسابك حاليًا.') : null,
        downgradeTo,
        primary: normalizeLimit(raw.primary)
    };
}

/** «بعد 2س 17د» / «بعد 3 أيام» / «خلال دقيقة». null لو الوقت مش معروف أو فات. */
export function formatResetIn(resetsAt, now = Date.now()) {
    if (!resetsAt) return null;
    const at = typeof resetsAt === 'number' ? resetsAt : Date.parse(resetsAt);
    if (!Number.isFinite(at)) return null;
    const ms = at - now;
    if (ms <= 0) return null;
    const minutes = Math.ceil(ms / 60000);
    if (minutes < 2) return 'خلال دقيقة';
    const days = Math.floor(minutes / 1440);
    if (days >= 2) return `بعد ${days} أيام`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours === 0) return `بعد ${minutes}د`;
    return rest ? `بعد ${hours}س ${rest}د` : `بعد ${hours}س`;
}

const nf = new Intl.NumberFormat('en-US');

/**
 * أرقام مربع الاستخدام. tone: ok < 80% ≤ warn < 100% ≤ full.
 * بلا حد: لا نسبة ولا شريط — عدد رسائل الشهر فقط.
 */
export function usageView(ent, now = Date.now()) {
    const p = ent?.primary;
    if (!ent || ent.status !== 'ok' || !p) {
        return { available: false, unlimited: false, percent: null, tone: 'ok', usedText: null, remainingText: null, totalText: null, resetText: null };
    }
    const resetText = formatResetIn(p.resetsAt, now);
    if (p.kind === 'unlimited') {
        return {
            available: true, unlimited: true, percent: null, tone: ent.hasAccess ? 'ok' : 'full',
            usedText: `${nf.format(p.used)} رسالة هذا الشهر`, remainingText: 'بلا حد', totalText: null,
            resetText: resetText ? `العدّاد يتجدد ${resetText}` : null
        };
    }
    const percent = Math.min(100, Math.round((p.used / p.limit) * 100));
    const tone = !ent.hasAccess || p.remaining === 0 ? 'full' : percent >= 80 ? 'warn' : 'ok';
    return {
        available: true, unlimited: false, percent, tone,
        usedText: `${nf.format(p.used)} / ${nf.format(p.limit)}`,
        remainingText: `${nf.format(p.remaining)} متبقي`,
        totalText: nf.format(p.limit),
        resetText: p.kind === 'monthly' && resetText ? `يتجدد ${resetText}` : (p.kind === 'lifetime' ? 'رصيد غير متجدد' : null)
    };
}

export const DOWNGRADE_ERRORS = Object.freeze({
    forbidden: 'مش مسموح بتغيير الخطة من الجلسة دي.',
    invalid_target: 'الخطة المطلوبة غير متاحة للتحويل.',
    not_a_downgrade: 'التحويل ده مش تنزيل لخطة أقل — الترقية بتتم من فريق المنصة.',
    edition_unavailable: 'الخطة دي متوقفة حاليًا.',
    no_access: 'حسابك مالوش وصول لـ SIE حاليًا.'
});

export function downgradeErrorText(code) {
    return DOWNGRADE_ERRORS[code] || 'تعذّر تغيير الخطة. حاول مرة أخرى.';
}
