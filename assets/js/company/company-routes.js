/**
 * company-routes.js — خريطة صفحات لوحة الشركة (دوال خالصة، مُختبَرة في node).
 *
 * اللوحة صفحات مستقلة لا مستند واحد طويل: لكل صفحة مسار (#hash) وحاوية
 * ‎#<page>TabContent‎، وتُجمَّع الصفحات في مجالات عمل (الدعم، الفريق، الفوترة…).
 * المجال يعطي القائمة الجانبية عناوينها، ومسار التنقّل مستواه الأوسط، وشريط
 * الصفحات الشقيقة في رأس كل مجال.
 *
 * هذه الوحدة لا تقرّر صلاحية: «متاحة» هنا معناها «تستحق رابطًا في التنقّل لهذا
 * الدور». القاعدة تبقى الحارس الوحيد لكل قراءة وكتابة.
 *
 * مسارات نسبية عمدًا (لا مطلقة) حتى تُستورد في node مباشرةً.
 */
import { sectionAllowed } from './company-model.js';

/** الصفحات: اسمها في التنقّل ووصفها المختصر. المفتاح = الـhash = بادئة الحاوية. */
export const COMPANY_PAGES = Object.freeze({
    overview:        { label: 'نظرة عامة' },
    tickets:         { label: 'تذاكري مع مدعوم' },
    customerTickets: { label: 'تذاكر العملاء' },
    inbox:           { label: 'صندوق الرسائل' },
    support:         { label: 'فتح تذكرة ومساعدة' },
    members:         { label: 'أعضاء الفريق' },
    customers:       { label: 'عملاء الشركة' },
    permissions:     { label: 'الأدوار والصلاحيات' },
    accessLog:       { label: 'سجل وصول مدعوم' },
    subscriptions:   { label: 'الاشتراكات' },
    entitlements:    { label: 'الخدمات والامتيازات' },
    usage:           { label: 'الاستخدام والحدود' },
    integrations:    { label: 'التكاملات' },
    api:             { label: 'مفاتيح API' },
    reports:         { label: 'التقارير' },
    activity:        { label: 'النشاط' },
    notifications:   { label: 'الإشعارات' },
    company:         { label: 'بيانات الشركة' },
    profile:         { label: 'الملف الشخصي' },
    security:        { label: 'الأمان' }
});

/** مجالات العمل بترتيب القائمة الجانبية. */
export const COMPANY_GROUPS = Object.freeze([
    { key: 'home', label: 'الرئيسية', pages: ['overview'] },
    {
        key: 'support', label: 'الدعم والتذاكر',
        description: 'تذاكرك مع فريق مدعوم، وطلبات عملاء شركتك، وفتح تذكرة جديدة.',
        pages: ['tickets', 'customerTickets', 'inbox', 'support']
    },
    {
        key: 'team', label: 'الفريق والصلاحيات',
        description: 'أعضاء الشركة وأدوارهم، والعملاء، ومن يصل إلى بيانات الشركة.',
        pages: ['members', 'customers', 'permissions', 'accessLog']
    },
    {
        key: 'billing', label: 'الاشتراك والفوترة',
        description: 'باقات الشركة، والخدمات التي تتيحها، ورصيد التذاكر هذا الشهر.',
        pages: ['subscriptions', 'entitlements', 'usage']
    },
    {
        key: 'connect', label: 'التكاملات وواجهة API',
        description: 'ربط متجرك أو نظامك المحاسبي، ومفاتيح الوصول البرمجي.',
        pages: ['integrations', 'api']
    },
    {
        key: 'insights', label: 'التقارير والنشاط',
        description: 'أداء الدعم من تذاكر الشركة، وسجل ما جرى على الحساب.',
        pages: ['reports', 'activity']
    },
    { key: 'notifications', label: 'الإشعارات', pages: ['notifications'] },
    { key: 'company', label: 'حساب الشركة', pages: ['company'] },
    {
        key: 'account', label: 'حسابي والأمان',
        description: 'بياناتك الشخصية وإعدادات حماية دخولك — منفصلة عن بيانات الشركة.',
        pages: ['profile', 'security']
    }
]);

export const COMPANY_ROUTES = Object.freeze(COMPANY_GROUPS.flatMap(g => g.pages));

/** صفحات لمدير الشركة وحده في التنقّل (القاعدة ترفض غيره على أي حال). */
const ADMIN_PAGES = new Set(['permissions', 'accessLog']);

/**
 * هل تستحق الصفحة رابطًا لهذا الناظر؟
 * ctx: { viewerRole: 'admin'|'supervisor'|'agent', inbox: boolean }
 * - inbox: يظهر فقط حين ترد القاعدة بصندوق لهذا الحساب (company_inbox_summary).
 * - customers: للمدير (الدعوات) والمشرف (القائمة)؛ لا شيء لموظف الدعم فيها.
 */
export function pageAvailable(page, { viewerRole = 'admin', inbox = false } = {}) {
    if (!COMPANY_ROUTES.includes(page)) return false;
    if (!sectionAllowed(page, viewerRole)) return false;
    if (ADMIN_PAGES.has(page) && viewerRole !== 'admin') return false;
    if (page === 'inbox' && inbox !== true) return false;
    if (page === 'customers' && !['admin', 'supervisor'].includes(viewerRole)) return false;
    return true;
}

/** المسار من الـhash؛ أي قيمة غير معروفة تعود إلى النظرة العامة. */
export function routeFromHash(hash) {
    const key = String(hash || '').replace(/^#/, '').split(/[?&/]/)[0];
    return COMPANY_ROUTES.includes(key) ? key : 'overview';
}

export function groupOf(page) {
    return COMPANY_GROUPS.find(g => g.pages.includes(page)) || COMPANY_GROUPS[0];
}

/** الصفحات الشقيقة المتاحة في مجال الصفحة — لشريط الصفحات في رأس المجال. */
export function siblingsOf(page, ctx = {}) {
    return groupOf(page).pages.filter(p => pageAvailable(p, ctx));
}

/**
 * مسار التنقّل: «لوحة الشركة / المجال / الصفحة». المجال يُسقط حين يطابق الصفحة
 * (الرئيسية، الإشعارات، حساب الشركة) فلا يتكرر الاسم.
 */
export function breadcrumbFor(page) {
    const group = groupOf(page);
    const label = (COMPANY_PAGES[page] || COMPANY_PAGES.overview).label;
    const trail = ['لوحة الشركة'];
    if (group.pages.length > 1) trail.push(group.label);
    trail.push(label);
    return trail;
}

/**
 * رأس الصفحة: المجالات متعددة الصفحات لها عنوان ووصف وشريط صفحات؛ الصفحة المفردة
 * تكتفي بعنوان لوحتها (لا تكرار للعنوان نفسه مرتين). النظرة العامة لها ترحيبها.
 */
export function pageHeadFor(page, ctx = {}) {
    const group = groupOf(page);
    const siblings = siblingsOf(page, ctx);
    if (group.pages.length <= 1) return null;
    return {
        title: group.label,
        description: group.description || '',
        tabs: siblings.map(p => ({ page: p, label: COMPANY_PAGES[p].label, current: p === page }))
    };
}
