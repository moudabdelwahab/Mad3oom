/**
 * account-health.js — يحوّل حالة الحساب من "بيانات" إلى "إجراءات".
 *
 * الفكرة (المطلوبة صراحةً): بدل ما اللوحة تقول "دي بياناتك"، تقول
 * "دي حالتك، ودي الحاجات اللي محتاجة منك إجراء".
 *
 * كل بند هنا مشتق من بيانات حقيقية في حساب العميل — مفيش أي بند ثابت أو
 * تجريبي. لو مفيش أي مشكلة، الحالة بترجع "سليم" بدل ما نخترع تنبيهات.
 *
 * الوحدة دي حسابية بحتة: بتاخد اللقطة اللي جمّعتها customer-data.js وترجّع
 * وصفًا، من غير ما تلمس DOM ولا تعمل أي استعلام. كده نفس المنطق يتاخد
 * ويتّختبر بمعزل عن الواجهة.
 */

import { countByView } from './ticket-view-model.js';
import { isAccountRestricted } from '../account-status.js';

/**
 * @typedef {{severity:'critical'|'warning'|'info', title:string, text:string,
 *            action?:{label:string, section?:string, href?:string}}} HealthItem
 */

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };

/**
 * @returns {{status:'critical'|'attention'|'healthy', headline:string,
 *            subline:string, items:HealthItem[]}}
 */
export function assessAccountHealth(snapshot, { userId } = {}) {
    const items = [];

    const profile = snapshot?.account?.ok ? snapshot.account.data : null;
    const tickets = snapshot?.tickets || [];
    const wa      = snapshot?.waSub?.ok ? snapshot.waSub.data : null;
    const wallet  = snapshot?.wallet?.ok ? snapshot.wallet.data : null;
    const sie     = snapshot?.sie?.ok ? snapshot.sie.data : null;
    const system  = snapshot?.systemStatus?.ok ? snapshot.systemStatus.data : null;
    const plans   = snapshot?.planSubs?.ok ? snapshot.planSubs.data : null;

    // ── 1) الحساب مقيّد — أخطر حالة، تسبق كل شيء ───────────────────────────
    if (isAccountRestricted(profile)) {
        items.push({
            severity: 'critical',
            title: 'حسابك مقيّد حالياً',
            text: profile.ban_reason || 'تواصل مع فريق الدعم لمعرفة التفاصيل وإعادة التفعيل.',
            action: { label: 'تواصل مع الدعم', section: 'support' }
        });
    }

    // ── 2) تذاكر تنتظر ردّ العميل ──────────────────────────────────────────
    const counts = countByView(tickets, userId);
    if (counts.awaiting > 0) {
        items.push({
            severity: 'warning',
            title: `${counts.awaiting} ${counts.awaiting === 1 ? 'تذكرة تنتظر' : 'تذاكر تنتظر'} ردّك`,
            text: 'فريق الدعم ردّ عليك ولم تردّ بعد — الرد السريع يقصّر زمن الحل.',
            action: { label: 'عرض التذاكر', section: 'tickets' }
        });
    }

    // ── 3) اشتراك واتساب على وشك الانتهاء ──────────────────────────────────
    if (wa?.isExpiringSoon && wa.expiringSubscription) {
        items.push({
            severity: wa.daysRemaining <= 3 ? 'critical' : 'warning',
            title: `اشتراك الواتساب ينتهي خلال ${wa.daysRemaining} يوم`,
            text: 'جدّد قبل الانتهاء حتى لا تتوقف الخدمة عن العمل.',
            action: { label: 'إدارة الاشتراك', href: '/customer-subscriptions.html' }
        });
    }

    // ── 4) باقة منصة على وشك الانتهاء ──────────────────────────────────────
    for (const sub of plans || []) {
        if (sub.status !== 'active' || !sub.end_date) continue;
        const days = Math.ceil((new Date(sub.end_date) - Date.now()) / 86400000);
        if (days > 0 && days <= 14) {
            items.push({
                severity: days <= 5 ? 'warning' : 'info',
                title: `${sub.subscription_plans?.name_ar || 'باقتك'} تنتهي خلال ${days} يوم`,
                text: 'راجع تفاصيل الباقة وجدّدها للاستمرار بنفس المميزات.',
                action: { label: 'الاستهلاك والاشتراك', section: 'usage' }
            });
        }
    }

    // ── 5) رصيد واتساب منخفض ───────────────────────────────────────────────
    if (wallet?.isLow) {
        items.push({
            severity: wallet.balance <= 0 ? 'critical' : 'warning',
            title: wallet.balance <= 0 ? 'نفد رصيد الواتساب' : 'رصيد الواتساب منخفض',
            text: `الرصيد الحالي ${wallet.balance} ${wallet.currency || ''} وهو تحت الحد الأدنى المحدد لحسابك.`,
            action: { label: 'تفاصيل الرصيد', section: 'usage' }
        });
    }

    // ── 6) حصة المحرك الذكي ────────────────────────────────────────────────
    if (sie?.is_enabled && sie.usedPercent !== null && sie.usedPercent >= 80) {
        items.push({
            severity: sie.usedPercent >= 100 ? 'critical' : 'warning',
            title: sie.usedPercent >= 100
                ? 'استُهلكت حصة المحرك الذكي بالكامل'
                : 'اقتربت من نهاية حصة المحرك الذكي',
            text: `استخدمت ${sie.used} من ${sie.quota} رسالة.`,
            action: { label: 'الاستهلاك والاشتراك', section: 'usage' }
        });
    }
    if (sie?.is_enabled && sie.isExpired) {
        items.push({
            severity: 'critical',
            title: 'انتهت صلاحية وصولك للمحرك الذكي',
            text: 'تواصل مع فريق الدعم لتجديد الوصول.',
            action: { label: 'تواصل مع الدعم', section: 'support' }
        });
    }

    // ── 7) عُطل معلن على خدمة من خدمات المنصة ──────────────────────────────
    if (system?.incidents?.length) {
        const incident = system.incidents[0];
        items.push({
            severity: 'info',
            title: 'يوجد عُطل معلن حالياً',
            text: `${incident.title} — قد يفسّر ما تواجهه قبل فتح تذكرة جديدة.`,
            action: { label: 'حالة النظام', section: 'support' }
        });
    } else if (system?.degraded?.length) {
        items.push({
            severity: 'info',
            title: `${system.degraded.length} خدمة بأداء منخفض`,
            text: system.degraded.map(s => s.name).join('، '),
            action: { label: 'حالة النظام', section: 'support' }
        });
    }

    // ── 8) استكمال إعداد الحساب (بيانات ناقصة تعطّل التواصل) ───────────────
    if (profile && !profile.phone) {
        items.push({
            severity: 'info',
            title: 'أكمل بيانات حسابك',
            text: 'إضافة رقم هاتف تساعد فريق الدعم على الوصول إليك أسرع عند الحاجة.',
            action: { label: 'الملف الشخصي', section: 'profile' }
        });
    }
    if (profile && profile.two_factor_enabled === false) {
        items.push({
            severity: 'info',
            title: 'فعّل التحقق بخطوتين',
            text: 'يحمي حسابك حتى لو تسرّبت كلمة المرور.',
            action: { label: 'الأمان', section: 'security' }
        });
    }

    items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

    const actionable = items.filter(i => i.severity !== 'info').length;
    const critical = items.some(i => i.severity === 'critical');

    let status, headline, subline;
    if (critical) {
        status = 'critical';
        headline = 'حسابك يحتاج إجراءً عاجلاً';
        subline = 'فيه بند أو أكثر قد يوقف خدمة تستخدمها.';
    } else if (actionable > 0) {
        status = 'attention';
        headline = `عندك ${actionable} ${actionable === 1 ? 'بند يحتاج' : 'بنود تحتاج'} انتباهك`;
        subline = 'خلّصها دلوقتي عشان كل حاجة تفضل شغالة.';
    } else {
        status = 'healthy';
        headline = 'حسابك بحالة جيدة';
        subline = items.length
            ? 'مفيش حاجة عاجلة — في اقتراحات اختيارية تحت.'
            : 'مفيش حاجة محتاجة منك إجراء حالياً.';
    }

    return { status, headline, subline, items };
}
