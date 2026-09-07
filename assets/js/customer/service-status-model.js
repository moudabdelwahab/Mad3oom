/**
 * service-status-model.js — قراءة حالة النظام من منظور العميل.
 *
 * ليه وحدة مستقلة؟ لأن نفس المنطق محتاج في تلات أماكن على الأقل: قسم حالة
 * النظام، بطاقة الإجراءات في النظرة العامة، ومركز المساعدة (لما العميل يبحث
 * عن مشكلة والنظام عارف إنها عطل معلن). المنطق مكتوب هنا مرة واحدة وبيتّاخد
 * بالاستيراد، وبيتّختبر لوحده من غير متصفح.
 *
 * مفيش هنا أي استعلام ولا رسم.
 */

/** الحالات الخمس كما تظهر للعميل. المفاتيح = قيم services.status. */
export const SERVICE_STATUS = Object.freeze({
    operational:    { label: 'تعمل بشكل طبيعي', tone: 'success', severity: 0 },
    maintenance:    { label: 'صيانة مجدولة',     tone: 'accent',  severity: 1 },
    degraded:       { label: 'أداء منخفض',       tone: 'warning', severity: 2 },
    partial_outage: { label: 'عطل جزئي',         tone: 'warning', severity: 3 },
    down:           { label: 'عطل كامل',         tone: 'danger',  severity: 4 }
});

const FALLBACK_STATUS = 'operational';

/**
 * الخدمات المرتبطة بما يملكه العميل تحديدًا. أي مفتاح غير موجود هنا يعتبر
 * بنية تحتية عامة تخص كل العملاء (API، قاعدة البيانات، المصادقة…).
 *
 * الربط بالمفتاح مش بالاسم المعروض: الاسم نص تحريري يتغيّر، والمفتاح ثابت.
 */
const ENTITLEMENT_KEYS = Object.freeze({
    whatsapp: 'whatsapp',
    sie: 'sie',
    aqar: 'aqar'
});

export function statusInfo(service) {
    const key = SERVICE_STATUS[service?.status] ? service.status : FALLBACK_STATUS;
    return { key, ...SERVICE_STATUS[key] };
}

/** هل الخدمة معطّلة فعلاً (الصيانة المعلنة ليست عطلاً)؟ */
export function isImpaired(service) {
    const { key } = statusInfo(service);
    return key === 'degraded' || key === 'partial_outage' || key === 'down';
}

/**
 * هل الخدمة تخص هذا العميل؟
 * البنية التحتية العامة تخص الجميع. الخدمات المرتبطة باشتراك تخص من يملكه فقط.
 *
 * @param {object} service
 * @param {{whatsapp?:boolean, sie?:boolean, aqar?:boolean}} entitlements
 */
export function isCustomerService(service, entitlements = {}) {
    const key = service?.service_key;
    if (!key || !ENTITLEMENT_KEYS[key]) return true;      // بنية تحتية عامة
    return entitlements[ENTITLEMENT_KEYS[key]] === true;
}

/**
 * الحادثة المعلنة المرتبطة بخدمة، إن وُجدت.
 * incidents.affected_services مصفوفة نصية بتحمل مفاتيح أو معرّفات أو أسماء —
 * بنقبل التلاتة عشان البيانات القديمة ما تسقطش من الربط.
 */
export function incidentForService(service, incidents = []) {
    if (!service) return null;
    const candidates = [service.id, service.service_key, service.name]
        .filter(Boolean)
        .map(v => String(v));

    return incidents.find(incident =>
        Array.isArray(incident?.affected_services) &&
        incident.affected_services.some(entry => candidates.includes(String(entry)))
    ) || null;
}

/**
 * مفتاح نوبة العطل — **يجب أن يطابق** ما يحسبه trigger
 * set_service_report_episode في migrations/014، وإلا الواجهة هتقول "لم تبلّغ"
 * والقاعدة هترفض البلاغ كمكرر.
 */
export function episodeKeyFor(service, incident) {
    if (incident?.id) return `incident:${incident.id}`;
    const changedAt = service?.status_changed_at;
    const seconds = changedAt ? Math.floor(new Date(changedAt).getTime() / 1000) : 0;
    return `service:${service?.id}:${Number.isFinite(seconds) ? seconds : 0}`;
}

/**
 * ترتيب الخدمات للعرض: الأسوأ أولاً، والخدمات التي يستخدمها العميل قبل
 * البنية التحتية العامة عند تساوي الشدّة.
 */
export function orderForCustomer(services = [], entitlements = {}) {
    return [...services].sort((a, b) => {
        const diff = statusInfo(b).severity - statusInfo(a).severity;
        if (diff !== 0) return diff;

        const aMine = !!a.service_key && !!ENTITLEMENT_KEYS[a.service_key];
        const bMine = !!b.service_key && !!ENTITLEMENT_KEYS[b.service_key];
        if (aMine !== bMine) return aMine ? -1 : 1;

        return String(a.name || '').localeCompare(String(b.name || ''), 'ar');
    }).filter(s => s && (isCustomerService(s, entitlements) || !ENTITLEMENT_KEYS[s.service_key]));
}

/**
 * الأعطال التي تمسّ هذا العميل فعلاً — أساس ما يُعرض في النظرة العامة
 * وفي مركز المساعدة. خدمة معطّلة لا يستخدمها العميل لا ترتقي لهذا المستوى.
 */
export function impairedForCustomer(status, entitlements = {}) {
    const services = status?.services || [];
    const incidents = status?.incidents || [];

    return services
        .filter(service => isImpaired(service) && isCustomerService(service, entitlements))
        .map(service => {
            const incident = incidentForService(service, incidents);
            return {
                service,
                incident,
                info: statusInfo(service),
                episodeKey: episodeKeyFor(service, incident),
                // بداية المشكلة: وقت الحادثة المعلنة إن وُجدت، وإلا لحظة تغيّر
                // حالة الخدمة. الاتنين بيانات حقيقية مش تقدير.
                startedAt: incident?.created_at || service.status_changed_at || null,
                lastUpdate: incident?.updated_at || service.updated_at || service.last_checked || null
            };
        });
}

/** اشتقاق ما يملكه العميل من لقطة اللوحة — مصدر واحد لكل الشاشات. */
export function entitlementsFrom(snapshot) {
    const account = snapshot?.account?.ok ? snapshot.account.data : null;
    const sie = snapshot?.sie?.ok ? snapshot.sie.data : null;
    const wa = snapshot?.waSub?.ok ? snapshot.waSub.data : null;

    return {
        whatsapp: account?.whatsapp_enabled === true || wa?.isActive === true,
        sie: sie?.is_enabled === true,
        aqar: account?.aqar_enabled === true
    };
}
