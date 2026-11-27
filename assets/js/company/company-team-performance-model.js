/**
 * company-team-performance-model.js — أداء فريق الشركة: دوال خالصة.
 *
 * بلا DOM وبلا شبكة: تكييف حزمة company_team_performance (146) مع شكل
 * صفوف نموذج الأداء المشترك (team-performance-model.js في لوحة الإدارة)
 * حتى يعمل عليها sortRows كما هو — بلا نسخ ولا تفريع للنموذج.
 * تُختبَر بمعزل (tests/company-team-performance-model.test.mjs).
 *
 * حدود صادقة في التكييف (لا أرقام مختلقة):
 *   • buildTeamPerformance و dailyResolved يحتاجان صفوف تذاكر خامًا،
 *     وتبويب الشركة ممنوع من استعلام tickets/profiles/chat_sessions
 *     مباشرةً — فلا يُستدعيان هنا؛ الحزمة مجمّعة سلفًا من القاعدة.
 *   • التقييمات والشات على مستوى الشركة فقط (بلا إسناد عضو): كل عضو
 *     rating {average:null,count:0} و chatReplies null — تُعرض «—» مع
 *     الإجمالي في قسم الشركة، لا كنسبة وهمية لكل عضو.
 *   • التذاكر المفتوحة لكل عضو غير موجودة في الحزمة (الإجمالي فقط):
 *     openCount/inProgress/overdue null — فرزها يضعها في الأسفل كما
 *     يفعل sortRows مع القيم الفارغة.
 *   • tickets_created في الحزمة = أُنشئت في النافذة والمسند إليه العضو؛
 *     تُعرض كما هي في عمودها، لا تُجمع مع المحلولة.
 */

export const TEAM_ROLE_LABELS = Object.freeze({
    admin: 'أدمن', supervisor: 'مشرف', agent: 'دعم فني'
});

const secondsToHours = (s) =>
    (s === null || s === undefined || s === '' || Number.isNaN(Number(s))) ? null : Number(s) / 3600;

/**
 * صفوف الأعضاء بشكل صفوف buildTeamPerformance (الحقول التي يقرأها
 * sortRows/SORT_KEYS)، مع null حيث لا تملك الحزمة إسنادًا صادقًا.
 */
export function teamPerformanceRows(payload) {
    const members = Array.isArray(payload?.members) ? payload.members : [];
    return members.map(m => ({
        id: m.id,
        name: m.name || '—',
        email: '',
        role: m.role || null,
        roleLabel: TEAM_ROLE_LABELS[m.role] || m.role || '',
        former: false,
        openCount: null,
        inProgress: null,
        overdue: null,
        resolved: Number(m.tickets_resolved) || 0,
        ticketsCreated: Number(m.tickets_created) || 0,
        firstResponseHours: secondsToHours(m.avg_first_response_seconds),
        resolutionHours: secondsToHours(m.avg_resolution_seconds),
        sla: { met: 0, total: 0, rate: null },
        replies: Number(m.replies_public) || 0,
        notes: Number(m.replies_internal) || 0,
        repliesTotal: Number(m.replies_total) || 0,
        chatReplies: null,
        rating: { average: null, count: 0 }
    }));
}

/** إجماليات الشركة من الحزمة — بما فيها التقييمات والشات على مستواها. */
export function teamPerformanceTotals(payload) {
    const t = payload?.totals || {};
    return {
        companyId: payload?.company_id || null,
        from: payload?.from || null,
        to: payload?.to || null,
        generatedAt: payload?.generated_at || null,
        ticketsCreated: Number(t.tickets_created) || 0,
        ticketsResolved: Number(t.tickets_resolved) || 0,
        ticketsOpenNow: Number(t.tickets_open_now) || 0,
        avgFirstResponseHours: secondsToHours(t.avg_first_response_seconds),
        avgResolutionHours: secondsToHours(t.avg_resolution_seconds),
        ratings: {
            count: Number(t.ratings?.count) || 0,
            avg: (t.ratings?.avg === null || t.ratings?.avg === undefined) ? null : Number(t.ratings.avg)
        },
        chat: {
            sessions: Number(t.chat?.sessions) || 0,
            messages: Number(t.chat?.messages) || 0
        }
    };
}

/** تاريخ YYYY-MM-DD محليًا (القاعدة تأخذ date، لا لحظة). */
export function toISODate(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** نافذة الإعدادات الجاهزة: آخر N يومًا شاملة اليوم. */
export function presetWindow(days, now = new Date()) {
    const to = new Date(now.getTime());
    const from = new Date(now.getTime());
    from.setDate(from.getDate() - (Math.max(1, days) - 1));
    return { from: toISODate(from), to: toISODate(to) };
}

/** تحقق النافذة المخصصة — مرآة حد القاعدة (366 يومًا كحد أقصى). */
export function validateWindow(from, to) {
    if (!from || !to) return { ok: false, error: 'حدّد تاريخي البداية والنهاية' };
    const f = new Date(`${from}T00:00:00`), t = new Date(`${to}T00:00:00`);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) return { ok: false, error: 'التاريخ غير صحيح' };
    if (f > t) return { ok: false, error: 'تاريخ البداية بعد تاريخ النهاية' };
    if ((t - f) / 86400000 > 366) return { ok: false, error: 'النافذة أطول من 366 يومًا' };
    return { ok: true };
}
