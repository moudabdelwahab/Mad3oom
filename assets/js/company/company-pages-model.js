/**
 * company-pages-model.js — نماذج عرض خالصة لصفحات لوحة الشركة الجديدة
 * (النظرة العامة، الأدوار والصلاحيات، سجل وصول مدعوم). مُختبَرة في node.
 *
 * لا DOM ولا شبكة هنا، ومسارات نسبية حتى تُستورد في node مباشرةً. التنسيق
 * (التواريخ) يبقى للعرض: النماذج ترجع قيمًا خامًا.
 */
import { analyzeSubscriptions } from './subscription-model.js';
import { registrationInfo, companyAccess } from './company-model.js';

/* ── تنبيهات النظرة العامة ──────────────────────────────────────────────── */

/**
 * من حمولة اللوحة وحدها. الاشتراكات والسجل التجاري لا تصل لغير مدير الشركة (095)،
 * فلا تنبيه عنها لغيره. كل تنبيه يشير إلى الصفحة التي يُعالَج فيها؛ date (إن وُجد)
 * يُنسَّق عند العرض بعد text.
 */
export function overviewAlerts(dashboard, viewerRole) {
    if (!dashboard || viewerRole !== 'admin') return [];
    const alerts = [];
    const registration = registrationInfo(dashboard.registration);
    const days = dashboard.registration?.days_to_expiry;

    if (registration.isExpired) {
        alerts.push({ tone: 'danger', page: 'company', action: 'تحديث البيانات',
            title: 'السجل التجاري منتهي الصلاحية',
            text: 'حدّث تاريخ انتهاء السجل التجاري من بيانات الشركة.' });
    } else if (registration.hasDate && Number.isFinite(days) && days <= 30) {
        alerts.push({ tone: 'warning', page: 'company', action: 'بيانات الشركة',
            title: `السجل التجاري ينتهي خلال ${days} يوم`,
            text: 'تاريخ الانتهاء', date: dashboard.registration.expiry_date });
    }

    const report = analyzeSubscriptions(dashboard.subscriptions || []);
    if (!companyAccess(dashboard).hasActiveSubscription) {
        alerts.push({ tone: 'danger', page: 'subscriptions', action: 'الاشتراكات',
            title: 'لا يوجد اشتراك فعّال',
            text: 'خدمات الشركة متوقفة حتى يُفعَّل اشتراك.' });
    }
    for (const row of report.rows.filter(r => r.state.key === 'expiring')) {
        alerts.push({ tone: 'warning', page: 'subscriptions', action: 'الاشتراكات',
            title: `${row.sub.plan_name_ar || row.sub.plan} ينتهي قريبًا`,
            text: row.daysRemaining != null ? `يتبقى ${row.daysRemaining} يوم — ينتهي` : 'ينتهي',
            date: row.sub.end_date });
    }
    if (report.pending) {
        alerts.push({ tone: 'info', page: 'subscriptions', action: 'الاشتراكات',
            title: `${report.pending} طلب اشتراك قيد المراجعة`,
            text: 'سيصلك إشعار عند قرار فريق مدعوم.' });
    }
    return alerts;
}

/* ── الأدوار والصلاحيات (098) ──────────────────────────────────────────── */

export const PERMISSION_ROLES = Object.freeze([
    { key: 'supervisor', label: 'المشرف' },
    { key: 'agent', label: 'موظف الدعم' }
]);

/** حمولة company_permissions_matrix → صفوف عرض. null/شكل غير متوقع → null (لا تخمين). */
export function permissionsView(payload) {
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.catalog)) return null;
    const overrides = Array.isArray(payload.overrides) ? payload.overrides : [];
    return {
        enabled: payload.enabled === true,
        overridesCount: overrides.length,
        overriddenUsers: new Set(overrides.map(o => o.user_id)).size,
        rows: payload.catalog.map(c => ({
            key: String(c.key),
            label: c.label || c.key,
            description: c.description || '',
            supervisor: c.supervisor === true,
            agent: c.agent === true
        }))
    };
}

/* ── سجل وصول مدعوم (097) ──────────────────────────────────────────────── */

export const REQUESTER_LABELS = Object.freeze({
    elevated_admin: 'الإدارة العليا في مدعوم',
    admin: 'مدير في مدعوم',
    support: 'فريق دعم مدعوم'
});

/** حالة منح الوصول بساعة المتصفح للعرض فقط (القاعدة تطبّق الانتهاء بساعتها). */
export function grantState(grant, now = new Date()) {
    if (grant?.revoked_at) return { key: 'revoked', label: 'أُلغي', pill: 'status-neutral' };
    if (grant?.expires_at && new Date(grant.expires_at) <= now) return { key: 'expired', label: 'انتهى', pill: 'status-neutral' };
    return { key: 'active', label: 'ساري', pill: 'status-tone-warning' };
}
