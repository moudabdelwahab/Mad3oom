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
import { STORE_PAGES } from './store-model.js';

/** الصفحات: اسمها في التنقّل ووصفها المختصر. المفتاح = الـhash = بادئة الحاوية. */
export const COMPANY_PAGES = Object.freeze({
    overview:        { label: 'نظرة عامة' },
    storeOverview:   { label: 'نظرة المتجر' },
    shopify:         { label: 'Shopify' },
    storeOrders:     { label: 'العملاء والطلبات' },
    storeManage:     { label: 'إدارة المتجر' },
    storeRequests:   { label: 'طلبات المتابعة' },
    storeReports:    { label: 'تقارير المتجر' },
    tickets:         { label: 'تذاكري مع مدعوم' },
    customerTickets: { label: 'تذاكر العملاء' },
    inbox:           { label: 'صندوق الرسائل' },
    workspace:       { label: 'مساحة العمل' },
    continuity:      { label: 'الاستمرارية' },
    support:         { label: 'فتح تذكرة ومساعدة' },
    users:           { label: 'المستخدمون' },
    members:         { label: 'أعضاء الفريق' },
    customers:       { label: 'عملاء الشركة' },
    customerHistory: { label: 'سجل العميل' },
    teamPerformance: { label: 'أداء الفريق' },
    // وحدة الموارد البشرية (الترحيل 143): تُحجب بالكامل حين تكون ctx.hr غير true
    // — الاستحقاق يُحسب من القاعدة (مفتاح المنصة + اشتراك الشركة + تجاوز المالك).
    hrOverview:      { label: 'نظرة الموارد البشرية' },
    hrEmployees:     { label: 'الموظفون' },
    hrDepartments:   { label: 'الأقسام والفروع والمسميات' },
    hrImport:        { label: 'استيراد الموظفين' },
    permissions:     { label: 'الأدوار والصلاحيات' },
    accessLog:       { label: 'سجل وصول مدعوم' },
    subscriptions:   { label: 'الاشتراكات' },
    refundPolicy:    { label: 'سياسة الإلغاء والاسترداد' },
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
        // 118/119: لحسابات المتاجر الإلكترونية وحدها (ctx.store)
        key: 'store', label: 'المتجر',
        description: 'ربط متجرك في Shopify، وطلبات العملاء وسياقها في الدعم، وإدارة المنتجات والطلبات والمخزون، ومتابعة الإرجاع والاستبدال والإلغاء.',
        pages: ['storeOverview', 'shopify', 'storeOrders', 'storeManage', 'storeRequests', 'storeReports']
    },
    {
        key: 'support', label: 'الدعم والتذاكر',
        description: 'مساحة عمل تجمع مسارَي التذاكر وصندوق الرسائل، وتذاكرك مع فريق مدعوم، وطلبات عملاء شركتك، واستمرارية المتابعة، وفتح تذكرة جديدة.',
        pages: ['workspace', 'tickets', 'customerTickets', 'inbox', 'continuity', 'support']
    },
    {
        key: 'team', label: 'الفريق والصلاحيات',
        description: 'أعضاء الشركة وأدوارهم، والعملاء وسجلّ كل عميل، وأداء الفريق، ومن يصل إلى بيانات الشركة.',
        // users: الأعضاء والعملاء والدعوات في مكان واحد بالبحث والفلاتر وقائمة «خيارات»
        pages: ['users', 'members', 'customers', 'customerHistory', 'teamPerformance', 'permissions', 'accessLog']
    },
    {
        key: 'hr', label: 'الموارد البشرية',
        description: 'ملفات الموظفين والأقسام والفروع والمسميات والاستيراد الجماعي.',
        pages: ['hrOverview', 'hrEmployees', 'hrDepartments', 'hrImport']
    },
    {
        key: 'billing', label: 'الاشتراك والفوترة',
        description: 'باقات الشركة، والخدمات التي تتيحها، ورصيد التذاكر هذا الشهر.',
        pages: ['subscriptions', 'refundPolicy', 'entitlements', 'usage']
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
const ADMIN_PAGES = new Set(['permissions', 'accessLog', 'shopify']);

/** صفحات الموارد البشرية: تُحجب كلها حين تكون ctx.hr غير true. */
const HR_PAGES = new Set(['hrOverview', 'hrEmployees', 'hrDepartments', 'hrImport']);

/**
 * هل تستحق الصفحة رابطًا لهذا الناظر؟
 * ctx: { viewerRole: 'admin'|'supervisor'|'agent', inbox: boolean, store: boolean, hr: boolean }
 * - inbox: يظهر فقط حين ترد القاعدة بصندوق لهذا الحساب (company_inbox_summary).
 * - store: صفحات المتجر لحساب ecommerce_store وحده (my_account_type()).
 * - hr: صفحات الموارد البشرية حين ترد القاعدة باستحقاق 'hr' أو 'hr_employees'
 *   للشركة (checkCompanyFeature في boot()) — بلا استحقاق تُحجب بالكامل.
 * - customers: للمدير (الدعوات) والمشرف (القائمة)؛ لا شيء لموظف الدعم فيها.
 * - teamPerformance: للمدير والمشرف؛ لا شيء لموظف الدعم فيها — كـ customers تمامًا.
 */
export function pageAvailable(page, { viewerRole = 'admin', inbox = false, store = false, hr = false } = {}) {
    if (!COMPANY_ROUTES.includes(page)) return false;
    if (HR_PAGES.has(page) && hr !== true) return false;
    if (STORE_PAGES.includes(page) && store !== true) return false;
    if (page === 'storeReports' && !['admin', 'supervisor'].includes(viewerRole)) return false;
    if (!sectionAllowed(page, viewerRole)) return false;
    if (ADMIN_PAGES.has(page) && viewerRole !== 'admin') return false;
    if (page === 'inbox' && inbox !== true) return false;
    if (page === 'customers' && !['admin', 'supervisor'].includes(viewerRole)) return false;
    if (page === 'teamPerformance' && !['admin', 'supervisor'].includes(viewerRole)) return false;
    return true;
}

/** المسار من الـhash؛ أي قيمة غير معروفة تعود إلى النظرة العامة. */
export function routeFromHash(hash) {
    const key = String(hash || '').replace(/^#/, '').split(/[?&/]/)[0];
    return COMPANY_ROUTES.includes(key) ? key : 'overview';
}

/**
 * هل الـhash قيمة غير معروفة؟ (هاش فارغ أو #overview ليسا مجهولين.)
 * خالصة لتُختبَر في node؛ الـToast نفسه يعرضه الموجّه (company-dashboard.js)
 * عند العودة للنظرة العامة، لأن هذه الوحدة لا تعرف الـDOM.
 */
export function isUnknownHash(hash) {
    const key = String(hash || '').replace(/^#/, '').split(/[?&/]/)[0];
    return key !== '' && !COMPANY_ROUTES.includes(key);
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
