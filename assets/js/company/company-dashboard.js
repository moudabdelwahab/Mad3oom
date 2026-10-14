/**
 * company-dashboard.js — منطق لوحة الشركة.
 *
 * البنية زي بوابة العميل بالضبط:
 *   assets/js/company/company-model.js  لغة اللوحة (دوال خالصة، مُختبَرة)
 *   assets/js/company/company-data.js   نداءات RPC المعزولة
 *   assets/js/customer/portal-ui.js     نفس حالات العرض (تحميل/فراغ/خطأ)
 *   assets/js/customer-sidebar.js       نفس القشرة والقائمة الجانبية
 *
 * مفيش هنا أي منطق صلاحيات: اللوحة بترسم اللي رجّعته
 * get_my_company_dashboard() وبس. لو الحمولة رجعت null يبقى المستخدم مش
 * تابع لشركة، وبتظهر بوابة توضّح الخطوة الجاية.
 */

import { guardPage } from '/assets/js/page-guard.js';
import { initCompanyShell, setActiveSidebarTab } from '/assets/js/customer-sidebar.js';
import { createTicketStream } from '/assets/js/company/company-tickets.js';
import { initCompanySupport, loadCompanySupport } from '/assets/js/company/company-support.js';
import { initCompanyNotifications, loadCompanyNotifications, companyDestinationFor } from '/assets/js/company/company-notifications.js';
import { loadCompanyProfile, loadCompanySecurity } from '/assets/js/company/company-account.js';
import { initCompanyApi, setCompanyApiMembers, setCompanyApiEntitlement, loadCompanyApi } from '/assets/js/company/company-api.js';
import { initApiTokenModal, openApiTokenModal } from '/assets/js/company/api-token-modal.js';
import { renderCompanyReports } from '/assets/js/company/company-reports.js';
import {
    analyzeSubscriptions, ANOMALY_NOTES, SUBSCRIPTION_STATES
} from '/assets/js/company/subscription-model.js';
import { initCompanyActivity, loadCompanyActivity } from '/assets/js/company/company-activity.js';
import { initCompanyIntegrations, loadCompanyIntegrations } from '/assets/js/company/company-integrations.js';
import {
    escapeHtml, formatDate, renderState, renderSkeletonLines
} from '/assets/js/customer/portal-ui.js';
import { ui } from '/ui-service.js';
import { renderCompanyDocuments } from '/assets/js/company/company-documents.js';
import { initCompanyMoves } from '/assets/js/company/company-moves.js';
import { fetchInboxSummary, applyInboxBadge, loadCompanyInbox } from '/assets/js/company/company-inbox.js';
import { countByView } from '/assets/js/customer/ticket-view-model.js';
import {
    fetchCompanyDashboard,
    fetchAccountKind,
    fetchCompanyMembers,
    createCompanyMember,
    removeCompanyMember,
    fetchCompanyStaff,
    setCompanyStaffRole,
    revokeCompanyStaff,
    saveCompany,
    fetchCompanyCustomers,
    fetchCompanyInvitations,
    inviteCompanyCustomer,
    cancelCompanyInvitation,
    fetchMyCompanyPermissions,
    fetchCompanyScopeTickets,
    setCompanyTicketStatus,
    assignCompanyTicket
} from '/assets/js/company/company-data.js';
import {
    subscriptionStatusInfo,
    registrationInfo,
    companyAccess,
    entitlementsByPlan,
    canManageMembers,
    membersScopeIsSelf,
    companyRoleOf,
    memberRoleInfo,
    memberActions,
    staffRoleOf,
    staffRoleInfo,
    staffActions,
    staffChangeFor,
    STAFF_ROLE_OPTIONS,
    hasEntitlement,
    viewerRoleOf,
    sectionAllowed,
    VIEWER_ROLE_LABELS,
    customersPanelView,
    isCompanyScopedTicket,
    teamTicketControls,
    TEAM_STATUS_OPTIONS,
    invitationStatusInfo,
    validateInviteEmail,
    validateCompanyForm,
    validateMemberForm
} from '/assets/js/company/company-model.js';

let dashboard = null;
let currentUserId = null;

/** 095: دور الناظر كما قرّرته القاعدة (admin | supervisor | agent). */
let viewerRole = 'admin';

/** القائمة الجانبية تُجلب بعد التحميل؛ إخفاء أقسام المدير ينتظرها. */
let shellReady = Promise.resolve();

/** المساران المستقلان — لكل واحد حالته وحاويته ومصدر قراءته. */
let platformTickets = null;   // الشركة ↔ مدعوم
let customerTickets = null;   // العميل ↔ الشركة

/** أعضاء الشركة كما رجّعتهم القاعدة — تُقرأ منها التقارير وقسم API. */
let companyMembers = [];
// 096: عملاء الشركة كما رجّعتهم القاعدة — لاختيار العميل في طلب الاطلاع التاريخي (101)
let companyCustomerList = [];
// 102: ملخص صندوق الرسائل كما رجّعته القاعدة — null يعني لا رابط في القائمة
let inboxSummary = null;

/** آخر قرار قرأناه من القاعدة لإدارة المستخدمين — للعرض فقط، لا للتفويض. */
let canManageMembersNow = false;

/** دور الحساب داخل شركته كما رجّعته company_members(): company_admin | company_user */
let myCompanyRole = null;

document.addEventListener('DOMContentLoaded', init);

async function init() {
    // اللوحة دي مفتوحة لأي حساب مسجّل؛ اللي بتعرضه بيحدده
    // get_my_company_dashboard() في القاعدة. مفيش قيد رتبة هنا عمدًا.
    const user = await guardPage();
    if (!user) return;

    currentUserId = user.id;

    // قشرة الشركة: قائمتها الخاصة، وكل عناصرها أقسام في هذه الصفحة.
    // onTabChange بيخلي عناصر القائمة تبدّل الأقسام بدل ما تنقل لأي صفحة.
    shellReady = initCompanyShell({
        onTabChange: showSection,
        // الجرس يفتح نافذة منبثقة ولا يبدّل القسم؛ «عرض الكل» وحده ينقل إليه.
        notificationsPopover: true,
        onSeeAllNotifications: () => showSection('notifications'),
        onOpenNotification: (notification) => {
            const destination = companyDestinationFor(notification);
            if (destination.kind === 'ticket') openTicketInItsStream(destination.ticketId);
            else if (destination.kind === 'section') showSection(destination.section);
            else showSection('notifications');
        }
    });

    // المسارَان يشتركان في كود العرض ويختلفان في مصدر الصفوف — والفصل
    // الحقيقي مفروض في القاعدة، لا هنا.
    platformTickets = createTicketStream('platform', {
        userId: currentUserId,
        onNewTicket: () => showSection('support')
    });
    customerTickets = createTicketStream('customers', { userId: currentUserId, keep: isCompanyScopedTicket });

    // إنشاء المفتاح صار في مكانه: نافذة داخل اللوحة تنادي الدالة المنشورة
    // create-api-token. التوجيه السابق لمركز الدعم كان مبنيًا على قراءة
    // ناقصة (غياب سياسة INSERT)، والقراءة الكاملة من الإنتاج أظهرت أن
    // الإنشاء مدعوم عبر الخادم لا عبر الجدول.
    initCompanyApi({ onCreateToken: openApiTokenModal });
    initApiTokenModal({ onCreated: () => loadCompanyApi({ selfId: currentUserId }) });
    initCompanyActivity();
    // قائمة الأعضاء لاختيار العميل عند تحويل طلب دعم وارد من الموقع إلى تذكرة
    initCompanyIntegrations({ members: () => companyMembers });
    initCompanySupport({ onCreated: onTicketCreated });
    initCompanyNotifications({
        onNavigate: showSection,
        onOpenTicket: openTicketInItsStream
    });

    wireForm();
    wireAddMember();
    wireInviteCustomer();
    wireSectionRouting();

    await load();
    inboxSummary = await fetchInboxSummary();
    // اختصار صندوق الرسائل يظهر فقط حين ترد القاعدة بصندوق لهذا الحساب
    if (dashboard) renderQuickActions();

    // البحث في الشريط العلوي بيوصل هنا كـ?q= (بيت القشرة هو لوحة الشركة
    // نفسها)، فبنفتح التذاكر عليه بدل ما يضيع.
    const query = new URLSearchParams(window.location.search).get('q');
    if (query) {
        loadedOnce.add('tickets');
        showSection('tickets');
        await platformTickets.load({ search: query });
    } else {
        showSection(sectionFromHash(), { updateHash: false });
    }
}

/* ── التنقّل بين أقسام لوحة الشركة ───────────────────────────────────────── */

/**
 * التنقّل كله داخل هذه الصفحة. مفيش قسم بيوديك لصفحة تانية، ومفيش رابط
 * لبوابة العميل — وده قرار المنتج اللي بيمنع دورة
 * «لوحة الشركة → بوابة العميل → صفحة الدخول → لوحة الشركة» من الوجود أصلًا.
 */
const SECTIONS = [
    'overview', 'members', 'subscriptions',
    'tickets',          // ① الشركة ↔ مدعوم
    'customerTickets',  // ② العميل  ↔ الشركة
    'inbox',            // ③ رسائل العملاء مع الشركة (102)
    'support', 'notifications',
    'api', 'integrations', 'reports', 'activity',
    'profile', 'security'
];

/** الأقسام اللي بتتحمّل عند أول فتح لها فقط. */
const LOADERS = {
    tickets: () => ensureStreamLoaded('tickets', platformTickets),
    customerTickets: () => ensureStreamLoaded('customerTickets', customerTickets),
    inbox: () => loadCompanyInbox(),
    support: () => loadCompanySupport(),
    notifications: () => loadCompanyNotifications(),
    profile: () => loadCompanyProfile(),
    security: () => loadCompanySecurity(),
    api: () => loadCompanyApi({ selfId: currentUserId }),
    integrations: () => loadCompanyIntegrations(),
    activity: () => loadCompanyActivity(),
    // التقارير تُبنى من المسارين، فنضمن تحميلهما أولًا بدل عرض أصفار كاذبة
    reports: () => loadReports()
};

const loadedOnce = new Set();

/** أسماء الأقسام كما في القائمة الجانبية — لمسار التنقّل وعنوان التبويب. */
const SECTION_LABELS = Object.freeze({
    overview: 'نظرة عامة',
    members: 'مستخدمو الشركة',
    subscriptions: 'الاشتراكات والخدمات',
    tickets: 'تذاكري مع مدعوم',
    customerTickets: 'تذاكر العملاء',
    inbox: 'صندوق الرسائل',
    support: 'مركز الدعم',
    notifications: 'الإشعارات',
    api: 'API',
    integrations: 'التكاملات',
    reports: 'التقارير',
    activity: 'النشاط',
    profile: 'الملف الشخصي',
    security: 'الأمان'
});

const BASE_TITLE = 'لوحة الشركة - منصة مدعوم';

/** القسم المعروض الآن — يُعاد تطبيقه على القائمة حين تصل بعد التحميل. */
let currentSection = 'overview';

function sectionFromHash() {
    const hash = (window.location.hash || '').replace(/^#/, '');
    return SECTIONS.includes(hash) ? hash : 'overview';
}

export function showSection(name, { updateHash = true } = {}) {
    // 095: أقسام المدير لا تُفتح لغيره حتى بالرابط المباشر (#subscriptions) — والقاعدة
    // لا ترسل بياناتها أصلًا لغير المدير.
    const section = SECTIONS.includes(name) && sectionAllowed(name, viewerRole) ? name : 'overview';

    SECTIONS.forEach(key => {
        const el = document.getElementById(`${key}TabContent`);
        if (el) el.classList.toggle('active', key === section);
    });

    currentSection = section;
    setActiveSidebarTab(section);
    // القائمة تُجلب بعد أول رسم: لو وصلت بعد هذا النداء نعلّم عنصرها النشط عند وصولها
    Promise.resolve(shellReady).catch(() => {}).then(() => setActiveSidebarTab(currentSection));
    renderSectionContext(section);
    if (updateHash && window.location.hash.slice(1) !== section) {
        history.replaceState(null, '', `#${section}`);
    }
    window.scrollTo({ top: 0, behavior: 'auto' });

    if (!loadedOnce.has(section) && LOADERS[section]) {
        loadedOnce.add(section);
        LOADERS[section]();
    }
}

/** مسار التنقّل في شريط الشركة وعنوان التبويب يتبعان القسم المعروض. */
function renderSectionContext(section) {
    const label = SECTION_LABELS[section] || SECTION_LABELS.overview;
    const crumb = document.getElementById('companySectionCrumb');
    if (crumb) crumb.textContent = label;
    document.title = section === 'overview' ? BASE_TITLE : `${label} · ${BASE_TITLE}`;
}

function wireSectionRouting() {
    // زر الرجوع في المتصفح والروابط الداخلية (#members مثلًا) يبدّلان القسم
    window.addEventListener('hashchange', () => showSection(sectionFromHash(), { updateHash: false }));

    // أي رابط داخل المحتوى يحمل data-tab يبدّل قسمًا بدل ما ينقل الصفحة
    document.addEventListener('click', (event) => {
        const link = event.target.closest('[data-tab]');
        if (!link || !link.closest('#companyMain')) return;
        event.preventDefault();
        showSection(link.getAttribute('data-tab'));
    });
}

/**
 * التقارير تقرأ المسارين معًا. لو لم يُفتحا بعد نحمّلهما أولًا — تقرير مبني
 * على قوائم فارغة لم تُقرأ بعدُ أسوأ من انتظار قصير.
 */
async function loadReports() {
    const [platformOk, customersOk] = await Promise.all([
        ensureStreamLoaded('tickets', platformTickets),
        ensureStreamLoaded('customerTickets', customerTickets)
    ]);

    if (!platformOk || !customersOk) {
        // تقرير على قائمة لم تُقرأ = أرقام كاذبة. نقول ذلك، ونعيد المحاولة عند العودة للقسم.
        loadedOnce.delete('reports');
        renderState(document.getElementById('companyReports'), {
            variant: 'error',
            title: 'تعذّر بناء التقارير',
            text: 'لم نتمكن من قراءة التذاكر اللازمة. افتح القسم مرة أخرى لإعادة المحاولة.'
        });
        return;
    }

    renderCompanyReports({
        dashboard,
        platformTickets: platformTickets.rows(),
        customerTickets: customerTickets.rows(),
        members: companyMembers,
        userId: currentUserId
    });
}

/** بعد فتح تذكرة من مركز الدعم: نعرضها في مسار «مع مدعوم» بلا مغادرة اللوحة. */
async function onTicketCreated() {
    loadedOnce.add('tickets');
    showSection('tickets');
    await platformTickets.load();
    // عدّادات النظرة العامة تُقرأ من نفس الصفوف بعد التحديث
    renderOverviewTickets();
}

/**
 * إشعار يشير إلى تذكرة: نفتحها في مسارها الصحيح.
 * التذكرة إمّا في مساري مع مدعوم أو في تذاكر عملائي — لا تنتمي للاثنين،
 * فنسأل كل مسار عمّا لديه بدل افتراض واحد منهما.
 */
async function openTicketInItsStream(ticketId) {
    await ensureStreamLoaded('tickets', platformTickets);
    if (platformTickets.has(ticketId)) {
        showSection('tickets');
        await platformTickets.open(ticketId);
        return;
    }

    await ensureStreamLoaded('customerTickets', customerTickets);
    if (customerTickets.has(ticketId)) {
        showSection('customerTickets');
        await customerTickets.open(ticketId);
        return;
    }

    // ليست في أي مسار (حُذفت أو خارج النطاق): نفتح المسار الافتراضي بلا خطأ
    showSection('tickets');
}

async function load() {
    const content = document.getElementById('companyContent');
    const gate = document.getElementById('companyGate');
    renderSkeletonLines(document.getElementById('companyGateBody'), 3);
    gate.hidden = false;
    content.hidden = true;

    const [result, kindResult] = await Promise.all([fetchCompanyDashboard(), fetchAccountKind()]);

    // 095 (D8): عميل الشركة له بوابة منفصلة. رسالة في مكانها وزر يدوي — بلا تحويل
    // تلقائي (قاعدة page-guard). القاعدة ترد null لحمولته على أي حال.
    if (kindResult.ok && kindResult.data === 'company_customer') {
        renderState(document.getElementById('companyGateBody'), {
            variant: 'empty',
            title: 'هذه اللوحة لفريق الشركة',
            text: 'حسابك مسجّل كعميل لدى هذه الشركة. تذاكرك ومراسلاتك معها في بوابة العملاء.',
            action: { label: 'فتح بوابة العملاء', goto: '/portal/', variant: 'btn-primary' }
        });
        return;
    }

    if (!result.ok) {
        renderState(document.getElementById('companyGateBody'), {
            variant: 'error',
            title: 'تعذّر تحميل لوحة الشركة',
            text: result.error,
            action: { label: 'إعادة المحاولة', retry: 'dashboard', variant: 'btn-primary' }
        });
        return;
    }

    dashboard = result.data;

    if (!dashboard) {
        // مش تابع لأي شركة: البوابة بتقول الخطوة الجاية، مش "لا توجد بيانات"
        renderState(document.getElementById('companyGateBody'), {
            variant: 'empty',
            title: 'لا توجد شركة مرتبطة بحسابك',
            text: 'لوحة الشركة تُفعَّل عند الاشتراك في باقة تتطلب كيان شركة. اختر باقة من صفحة الاشتراكات وأدخل بيانات شركتك أثناء الطلب.',
            action: { label: 'استعراض الباقات', goto: '/subscriptions.html', variant: 'btn-primary' }
        });
        return;
    }

    gate.hidden = true;
    content.hidden = false;

    viewerRole = viewerRoleOf(dashboard);
    applyViewerRole();

    // الاستحقاقات كما رجّعتها القاعدة — الواجهة تقرأ ولا تحسب.
    setCompanyApiEntitlement(hasEntitlement(dashboard, 'api_tokens'));

    renderBanner();
    renderKpis();
    renderProfile();
    if (viewerRole === 'admin') renderSubscriptions();
    renderEntitlements();
    await renderMembers();
    await renderCustomers();
    await configureTeamTickets();
    // بعد الأعضاء (صلاحية الإدارة) وبعد ضبط مصدر تذاكر الفريق (098)
    renderQuickActions();
    renderOverviewTickets();
    // 100: مستندات الشركة — للمدير وحده، والميزة مفعّلة (القاعدة تقرر)
    if (viewerRole === 'admin') await renderCompanyDocuments();
    // 101: قرارات نقل العملاء وطلبات الاطلاع التاريخي — للمدير وحده، والمفتاحان مفعّلان (القاعدة تقرر)
    if (viewerRole === 'admin') await initCompanyMoves({ customers: () => companyCustomerList });
}

/**
 * 098: مع تفعيل صلاحيات الفريق، «تذاكر العملاء» = تذاكر نطاق الشركة كما تسمح بها القاعدة
 * لكل عضو (كلها للمشرف، المسندة لموظف الدعم افتراضيًا)، مع أدوات الحالة والإسناد بحسب
 * الصلاحية. مطفأ أو قبل 098: القسم كما كان.
 */
async function configureTeamTickets() {
    const result = await fetchMyCompanyPermissions();
    const controls = teamTicketControls(result.ok ? result.data : null);
    if (!controls.enabled) return;
    customerTickets.configure({
        load: fetchCompanyScopeTickets,
        team: {
            canStatus: controls.canStatus,
            canAssign: controls.canAssign,
            assignees: controls.assignees,
            statusOptions: TEAM_STATUS_OPTIONS,
            setStatus: setCompanyTicketStatus,
            assign: assignCompanyTicket
        }
    });
    if (loadedOnce.has('customerTickets')) await customerTickets.load();
}

/* ── مستخدمو الشركة ─────────────────────────────────────────────────────── */

/**
 * القسم ده بيعوّض وصول مسؤول الشركة القديم إلى admin/my-users.html بعد ما بقى
 * التحويل بعد الدخول يوديه للوحة شركته. الصلاحية بتتقرر في القاعدة
 * (can_manage = مالك + امتياز sub_users فعّال)، والواجهة بترسم نتيجتها.
 *
 * الإضافة نفسها بقت هنا في سياق الشركة (نافذة addMemberModal) بدل التوجيه
 * إلى لوحة الإدارة: ذاك التوجيه كان يرتد من حارس الأدمن إلى صفحة الدخول،
 * ومنها ترجع الجلسة القائمة إلى لوحة الشركة — حلقة لا نهائية.
 */
async function renderMembers() {
    const panel = document.getElementById('companyMembersPanel');
    const container = document.getElementById('companyMembers');
    const addBtn = document.getElementById('addMemberBtn');

    // الفريق يُقرأ مع الأعضاء: null لعميل الشركة أو قبل 086، فلا يظهر شيء منه.
    const [result, staffResult] = await Promise.all([fetchCompanyMembers(), fetchCompanyStaff()]);
    if (!result.ok || !result.data) { panel.hidden = true; return; }
    const staff = staffResult.ok ? staffResult.data : null;
    renderStaffNote(staff);

    // القرار جاي من القاعدة كما هو؛ الواجهة ما بتحسبوش.
    canManageMembersNow = canManageMembers(result.data);
    myCompanyRole = companyRoleOf(result.data);
    const { members = [] } = result.data;
    companyMembers = members;
    setCompanyApiMembers(members);
    panel.hidden = false;
    addBtn.hidden = !canManageMembersNow;
    renderCompanyRoleBadge();

    // 085: غير المدير يرى نفسه ومديره فقط — نقول ذلك بدل أن تبدو القائمة ناقصة.
    const scopeNote = document.getElementById('companyMembersScopeNote');
    if (scopeNote) scopeNote.hidden = !membersScopeIsSelf(result.data);

    if (!members.length) {
        renderState(container, {
            variant: 'empty',
            title: 'لا يوجد مستخدمون بعد',
            text: canManageMembersNow
                ? 'أضف مستخدمًا ليصبح تابعًا لشركتك ويظهر هنا فورًا.'
                : 'إضافة المستخدمين متاحة لمدير الشركة ضمن اشتراك يشمل المستخدمين الفرعيين.'
        });
        return;
    }

    container.innerHTML = `
        <ul class="company-sub-list">
            ${members.map(m => {
                const role = memberRoleInfo(m);
                const actions = memberActions(m, { canManage: canManageMembersNow });
                const staffRole = staffRoleOf(m, staff);
                const staffInfo = staffRoleInfo(staffRole);
                const canEditStaff = staffActions(m, staff).canEdit;
                return `
                <li class="company-sub">
                    <div class="company-sub-main">
                        <p class="company-sub-plan">${escapeHtml(m.name || m.email || '—')}</p>
                        <p class="company-sub-dates">
                            ${escapeHtml(m.email || '')}
                            ${m.created_at ? ` · انضم ${escapeHtml(formatDate(m.created_at))}` : ''}
                        </p>
                        <p class="company-sub-dates is-muted">${escapeHtml(role.hint)}</p>
                    </div>
                    <div class="company-sub-side">
                        <span class="pill ${escapeHtml(role.pill)}">${escapeHtml(role.label)}</span>
                        ${staffInfo && !m.is_owner && !canEditStaff ? `
                        <span class="pill ${escapeHtml(staffInfo.pill)}" data-staff-pill="${escapeHtml(m.id)}"
                              title="${escapeHtml(staffInfo.hint)}">${escapeHtml(staffInfo.label)}</span>` : ''}
                        ${canEditStaff ? `
                        <label class="company-staff-role">
                            <span class="visually-hidden">دور ${escapeHtml(m.name || m.email || 'العضو')} في فريق الشركة</span>
                            <select data-staff-role="${escapeHtml(m.id)}"
                                    data-current-role="${escapeHtml(staffRole)}"
                                    data-member-name="${escapeHtml(m.name || m.email || 'المستخدم')}">
                                ${STAFF_ROLE_OPTIONS.map(o => `
                                <option value="${escapeHtml(o.value)}"${o.value === staffRole ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
                            </select>
                        </label>` : ''}
                        ${m.is_me ? '<span class="company-sub-days">أنت</span>' : ''}
                        ${actions.canRemove ? `
                        <button type="button" class="panel-link is-danger"
                                data-remove-member="${escapeHtml(m.id)}"
                                data-member-name="${escapeHtml(m.name || m.email || 'المستخدم')}">
                            إزالة من الشركة
                        </button>` : ''}
                    </div>
                </li>`;
            }).join('')}
        </ul>`;

    container.querySelectorAll('[data-remove-member]').forEach(btn => {
        btn.addEventListener('click', () => onRemoveMember(
            btn.getAttribute('data-remove-member'),
            btn.getAttribute('data-member-name')));
    });
    container.querySelectorAll('[data-staff-role]').forEach(select => {
        select.addEventListener('change', () => onStaffRoleChange(select));
    });
}

/** سطر يشرح الفرق بين الموظف والعميل — للمدير فقط، وبعد تطبيق 086. */
function renderStaffNote(staff) {
    const note = document.getElementById('companyStaffNote');
    if (!note) return;
    note.hidden = staff?.can_manage !== true;
}

/**
 * تغيير دور عضو في الفريق. القرار في القاعدة (company_staff_set/revoke):
 * المدير + sub_users، والعضو تابع لشركته فعلًا. أي فشل يعيد رسم القائمة من
 * القاعدة، فلا يبقى في الشاشة دور لم يُحفظ.
 */
async function onStaffRoleChange(select) {
    const memberId = select.getAttribute('data-staff-role');
    const memberName = select.getAttribute('data-member-name');
    const change = staffChangeFor(select.getAttribute('data-current-role'), select.value);
    if (!change) return;

    if (change.kind === 'revoke') {
        const ok = await ui.showConfirm(
            'إلغاء دور الموظف؟',
            `سيعود «${memberName}» عميلًا للشركة ويفقد صلاحيات الموظف فورًا. `
            + 'الحساب يبقى تابعًا لشركتك.',
            { confirmLabel: 'إلغاء الدور', cancelLabel: 'تراجع', danger: true }
        );
        if (!ok) { await renderMembers(); return; }
    }

    select.disabled = true;
    const result = change.kind === 'revoke'
        ? await revokeCompanyStaff(memberId)
        : await setCompanyStaffRole(memberId, change.role);

    if (!result.ok) {
        ui?.showToast?.(result.error || 'تعذّر تغيير الدور', 'error');
    } else {
        ui?.showToast?.(change.kind === 'revoke' ? 'عاد الحساب عميلًا للشركة' : 'تم تحديث دور الموظف', 'success');
    }
    await renderMembers();
}

/** شارة دور الحساب الحالي — يعرف المستخدم بأي صفة يتصرّف. */
function renderCompanyRoleBadge() {
    const badge = document.getElementById('companyRoleBadge');
    if (!badge) return;
    const info = memberRoleInfo({ role: myCompanyRole, is_owner: myCompanyRole === 'company_admin' });
    badge.hidden = !myCompanyRole;
    badge.className = `pill ${info.pill}`;
    badge.textContent = info.label;
}

/**
 * إزالة عضو. القرار النهائي في القاعدة: remove_company_member تتحقق من
 * can_manage_company_members ومن أن العضو تابع للمنادي فعلًا — فإخفاء الزر
 * تنظيم للواجهة لا حماية.
 */
async function onRemoveMember(memberId, memberName) {
    const ok = await ui.showConfirm(
        'إزالة المستخدم من الشركة؟',
        `سيصبح «${memberName}» حسابًا شخصيًا مستقلًا. الحساب لا يُحذف، لكنه يفقد `
        + 'وصوله إلى لوحة شركتك وبياناتها فورًا.',
        { confirmLabel: 'إزالة', cancelLabel: 'تراجع', danger: true }
    );
    if (!ok) return;

    const result = await removeCompanyMember(memberId);
    if (!result.ok) {
        ui?.showToast?.(result.error || 'تعذّرت إزالة المستخدم', 'error');
        return;
    }
    ui?.showToast?.('تمت إزالة المستخدم من الشركة', 'success');
    await renderMembers();
}

/* ── عملاء الشركة ودعواتهم (096) ─────────────────────────────────────────── */

/**
 * القرار في القاعدة: company_customers_list() للمدير والمشرف (null لغيرهما، وقبل 096)،
 * والدعوة لمن رجّعت له can_manage والمفتاح مفعّل. الدعوة ترد بنفس الرسالة لأي بريد،
 * فالواجهة لا تقول «الحساب موجود» أو «غير موجود» أبدًا.
 */
async function renderCustomers() {
    const panel = document.getElementById('companyCustomersPanel');
    if (!panel) return;
    const result = await fetchCompanyCustomers();
    const view = customersPanelView(result.ok ? result.data : null, viewerRole);
    companyCustomerList = Array.isArray(view.customers) ? view.customers : [];
    panel.hidden = !view.show;
    if (!view.show) return;

    document.getElementById('companyInviteForm').hidden = !view.canInvite;
    const invitationsBox = document.getElementById('companyInvitations');
    invitationsBox.innerHTML = '';
    if (view.canInvite) {
        const inv = await fetchCompanyInvitations();
        const rows = inv.ok && Array.isArray(inv.data) ? inv.data : [];
        invitationsBox.innerHTML = rows.length ? `
            <ul class="company-sub-list">
                ${rows.map(i => {
                    const info = invitationStatusInfo(i.status);
                    return `
                    <li class="company-sub">
                        <div class="company-sub-main">
                            <p class="company-sub-plan">${escapeHtml(i.email || '—')}</p>
                            <p class="company-sub-dates">أُرسلت ${escapeHtml(formatDate(i.created_at))}</p>
                        </div>
                        <div class="company-sub-side">
                            <span class="pill ${escapeHtml(info.pill)}">${escapeHtml(info.label)}</span>
                            ${i.status === 'pending' ? `
                            <button type="button" class="panel-link is-danger" data-cancel-invitation="${escapeHtml(i.id)}">إلغاء الدعوة</button>` : ''}
                        </div>
                    </li>`;
                }).join('')}
            </ul>` : '';
        invitationsBox.querySelectorAll('[data-cancel-invitation]').forEach(btn => {
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                const r = await cancelCompanyInvitation(btn.getAttribute('data-cancel-invitation'));
                if (!r.ok) ui?.showToast?.(r.error || 'تعذّر إلغاء الدعوة', 'error');
                await renderCustomers();
            });
        });
    }

    const list = document.getElementById('companyCustomers');
    if (!view.showList) { list.innerHTML = ''; return; }
    if (!view.customers.length) {
        renderState(list, { variant: 'empty', title: 'لا يوجد عملاء بعد', text: 'يظهر هنا عملاء الشركة بعد انضمامهم.' });
        return;
    }
    list.innerHTML = `
        <ul class="company-sub-list">
            ${view.customers.map(c => `
            <li class="company-sub" data-customer="${escapeHtml(c.id)}">
                <div class="company-sub-main">
                    <p class="company-sub-plan">${escapeHtml(c.name || '—')}</p>
                    <p class="company-sub-dates">${escapeHtml(c.email || '')}${c.phone ? ` · ${escapeHtml(c.phone)}` : ''}</p>
                </div>
            </li>`).join('')}
        </ul>`;
}

function wireInviteCustomer() {
    const form = document.getElementById('companyInviteForm');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const errorBox = document.getElementById('companyInviteError');
        errorBox.hidden = true;
        const check = validateInviteEmail(document.getElementById('companyInviteEmail').value);
        if (!check.ok) {
            errorBox.textContent = check.error;
            errorBox.hidden = false;
            return;
        }
        const btn = document.getElementById('companyInviteSubmit');
        btn.disabled = true;
        const result = await inviteCompanyCustomer(check.email);
        btn.disabled = false;
        if (!result.ok) {
            errorBox.textContent = result.error || 'تعذّر إرسال الدعوة';
            errorBox.hidden = false;
            return;
        }
        form.reset();
        // نفس الرسالة لأي بريد: لا تأكيد لوجود حساب
        ui?.showToast?.('سُجّلت الدعوة. إن كان للبريد حساب مؤهل فستصله في بوابة العملاء.', 'success');
        await renderCustomers();
    });
}

/* ── نافذة إضافة مستخدم ─────────────────────────────────────────────────── */

/**
 * ربط نافذة الإضافة. بتتنفّذ مرة واحدة عند التهيئة — الربط جوّه renderMembers
 * كان بيعيد تعيين المعالج مع كل تحميل، وكان بيتخطّى تمامًا لو القائمة فاضية.
 */
function wireAddMember() {
    const modal = document.getElementById('addMemberModal');
    const form = document.getElementById('addMemberForm');
    const openBtn = document.getElementById('addMemberBtn');
    if (!modal || !form || !openBtn) return;

    openBtn.addEventListener('click', () => {
        // الفتح أولًا: openMemberModal بيمسح الأخطاء، فالتحذير لازم ييجي بعده.
        openMemberModal();
        // إخفاء الزر تنظيم للواجهة لا حماية؛ الفحص الحقيقي عند الإرسال
        // (نداء جديد للقاعدة) وفي القاعدة نفسها.
        if (!canManageMembersNow) {
            showMemberError('حسابك غير مخوَّل بإضافة مستخدمين لهذه الشركة.');
        }
    });

    document.getElementById('addMemberClose')?.addEventListener('click', closeMemberModal);
    document.getElementById('cancelMemberBtn')?.addEventListener('click', closeMemberModal);

    // الضغط على الخلفية أو Escape يقفل — نفس سلوك باقي نوافذ البوابة
    modal.addEventListener('click', (event) => {
        if (event.target === modal) closeMemberModal();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && modal.classList.contains('active')) closeMemberModal();
    });

    form.addEventListener('submit', onCreateMember);
}

function openMemberModal() {
    const modal = document.getElementById('addMemberModal');
    clearMemberErrors();
    document.getElementById('addMemberForm').reset();
    modal.classList.add('active');
    document.getElementById('fMemberName')?.focus();
}

function closeMemberModal() {
    document.getElementById('addMemberModal')?.classList.remove('active');
    document.getElementById('addMemberBtn')?.focus();
}

function clearMemberErrors() {
    document.querySelectorAll('#addMemberForm [data-member-error-for]').forEach(el => {
        el.hidden = true;
        el.textContent = '';
    });
    const box = document.getElementById('addMemberError');
    box.hidden = true;
    box.textContent = '';
}

function showMemberFieldErrors(errors) {
    for (const [field, message] of Object.entries(errors)) {
        const el = document.querySelector(`#addMemberForm [data-member-error-for="${field}"]`);
        if (el) { el.textContent = message; el.hidden = false; }
    }
}

/** خطأ عام للنموذج. نص فقط — الرسالة قد تكون قادمة من الخادم. */
function showMemberError(message) {
    const box = document.getElementById('addMemberError');
    box.textContent = message;
    box.hidden = false;
}

async function onCreateMember(event) {
    event.preventDefault();
    clearMemberErrors();

    const values = {
        fullName: document.getElementById('fMemberName').value,
        email: document.getElementById('fMemberEmail').value,
        password: document.getElementById('fMemberPassword').value,
        passwordConfirm: document.getElementById('fMemberPasswordConfirm').value
    };

    const validation = validateMemberForm(values);
    if (!validation.isValid) {
        showMemberFieldErrors(validation.errors);
        return;
    }

    const btn = document.getElementById('submitMemberBtn');
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'جارٍ الإنشاء…';

    // createCompanyMember بتعيد قراءة can_manage من القاعدة قبل النداء،
    // فالرفض بيحصل على الخادم حتى لو اتلاعب أحد بالزر في المتصفح.
    const result = await createCompanyMember(values);

    btn.disabled = false;
    btn.textContent = original;

    if (!result.ok) {
        // فشل الإنشاء يظل داخل النافذة كرسالة مفهومة — مفيش أي تحويل،
        // ولا لصفحة الدخول ولا لغيرها.
        showMemberError(result.error || 'تعذّر إنشاء المستخدم. حاول مرة أخرى.');
        return;
    }

    closeMemberModal();
    ui?.showToast?.('تم إنشاء المستخدم وإضافته لشركتك', 'success');
    await renderMembers();
}

/* ── دور الناظر (095) ──────────────────────────────────────────────────── */

/** يُخفي من القائمة أقسام المدير عن المشرف وموظف الدعم. تنظيم عرض: الحماية في القاعدة. */
function applyViewerRole() {
    const current = (window.location.hash || '').replace(/^#/, '');
    if (current && !sectionAllowed(current, viewerRole)) showSection('overview');
    // display صريح لا الخاصية hidden: أنماط القائمة تفرض display على العنصر
    Promise.resolve(shellReady).catch(() => {}).then(() => {
        document.querySelectorAll('.sidebar-item[data-tab]').forEach(item => {
            const tab = item.getAttribute('data-tab');
            const allowed = sectionAllowed(tab, viewerRole) && (tab !== 'inbox' || inboxSummary !== null);
            item.hidden = !allowed;
            item.style.display = allowed ? '' : 'none';
        });
        applyInboxBadge(inboxSummary);
    });
}

/* ── شريط المستوى ───────────────────────────────────────────────────────── */

function renderBanner() {
    const banner = document.getElementById('companyBanner');
    const access = companyAccess(dashboard);
    banner.hidden = false;

    const companyName = dashboard.company.name || 'شركة بلا اسم';
    document.getElementById('companyName').textContent = companyName;
    // الحرف الأول من اسم الشركة شارةً لها — نص لا صورة، فلا مصدر خارجي
    const mark = document.getElementById('companyMark');
    if (mark) mark.textContent = Array.from(companyName.trim())[0] || '—';

    const parts = [];
    if (dashboard.company.cr_number) parts.push(`سجل تجاري: ${dashboard.company.cr_number}`);
    // viewer_role يأتي من 095؛ بدونه (خادم أقدم) تبقى العبارة كما كانت
    const roleLabel = dashboard.viewer_role ? VIEWER_ROLE_LABELS[viewerRole] : null;
    parts.push(access.isOwner ? 'أنت مالك الحساب' : (roleLabel || 'أنت عضو في هذه الشركة'));
    document.getElementById('companyMeta').textContent = parts.join(' • ');

    const pill = document.getElementById('companyAccessPill');
    pill.hidden = false;
    if (viewerRole !== 'admin') {
        // تفاصيل الاشتراكات لمدير الشركة وحده؛ الفريق يرى أن الخدمة مفعّلة أم لا فقط
        pill.className = access.hasActiveSubscription ? 'pill status-tone-success' : 'pill status-tone-danger';
        pill.textContent = access.hasActiveSubscription ? 'خدمات الشركة مفعّلة' : 'خدمات الشركة غير مفعّلة';
    } else if (access.hasActiveSubscription) {
        pill.className = 'pill status-tone-success';
        pill.textContent = `${access.activePlans.length} اشتراك فعّال`;
    } else {
        pill.className = 'pill status-tone-danger';
        pill.textContent = 'لا يوجد اشتراك فعّال';
    }
}

/* ── بطاقات الأرقام ─────────────────────────────────────────────────────── */

function renderKpis() {
    // نفس مصدر قسم الاشتراكات عمدًا — رقمان لنفس الشيء في شاشتين كانا
    // سيفترقان عند أول حالة حدّية (اشتراك لم يبدأ بعد مثلًا).
    const report = analyzeSubscriptions(dashboard.subscriptions);
    const summary = {
        active: report.active,
        pending: report.pending,
        daysToNearestExpiry: report.daysToNearestExpiry,
        nearestExpiry: report.nearest?.sub || null
    };
    const registration = registrationInfo(dashboard.registration);
    const toneClass = { success: 'kpi--success', warning: 'kpi--warning', danger: 'kpi--danger', neutral: '' };

    const cards = [
        {
            icon: 'briefcase',
            label: 'اشتراكات فعّالة',
            value: String(summary.active),
            hint: summary.pending ? `${summary.pending} طلب قيد المراجعة` : 'الباقات السارية الآن',
            tone: summary.active > 0 ? 'success' : 'danger'
        },
        {
            icon: 'clock',
            label: 'أقرب انتهاء اشتراك',
            value: summary.daysToNearestExpiry == null ? '—' : `${summary.daysToNearestExpiry} يوم`,
            hint: summary.nearestExpiry
                ? `${summary.nearestExpiry.plan_name_ar} — ${formatDate(summary.nearestExpiry.end_date)}`
                : 'لا يوجد اشتراك فعّال',
            tone: summary.daysToNearestExpiry != null && summary.daysToNearestExpiry <= 7 ? 'warning' : 'neutral'
        },
        {
            icon: 'file',
            label: 'السجل التجاري',
            value: registration.label,
            hint: registration.hasDate
                ? `ينتهي في ${formatDate(dashboard.registration.expiry_date)}`
                : 'أضف تاريخ انتهاء السجل من بيانات الشركة',
            tone: registration.tone
        },
        {
            icon: 'check',
            label: 'الخدمات المتاحة',
            value: String((dashboard.entitlements || []).length),
            hint: 'مشتقّة من الباقات الفعّالة',
            tone: 'neutral'
        }
    ];

    // 095: الاشتراكات والسجل التجاري لمدير الشركة وحده (القاعدة لا ترسلهما لغيره)
    const visibleCards = viewerRole === 'admin' ? cards : cards.slice(3);

    document.getElementById('companyKpis').innerHTML = visibleCards.map(card => `
        <div class="kpi ${toneClass[card.tone] || ''}">
            <p class="kpi-label">${icon(card.icon, 16)}${escapeHtml(card.label)}</p>
            <p class="kpi-value">${escapeHtml(card.value)}</p>
            <p class="kpi-hint">${escapeHtml(card.hint)}</p>
        </div>`).join('');
}

/* ── أيقونات اللوحة ─────────────────────────────────────────────────────────
   نفس أسلوب أيقونات القائمة الجانبية (خط 2، حواف مستديرة) فلا يختلط نظامان. */
const ICON_PATHS = {
    briefcase: '<rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path>',
    clock: '<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline>',
    check: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline>',
    mail: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>',
    alert: '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line>',
    plus: '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="16"></line><line x1="8" y1="12" x2="16" y2="12"></line>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>',
    code: '<polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline>',
    chart: '<path d="M12 20V10"></path><path d="M18 20V4"></path><path d="M6 20v-4"></path>',
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"></polyline><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path>',
    // «التالي» في واجهة عربية يتجه يسارًا؛ ويُعكس في LTR من الأنماط
    forward: '<polyline points="15 18 9 12 15 6"></polyline>'
};

function icon(name, size = 18, className = '') {
    return `<svg ${className ? `class="${className}" ` : ''}viewBox="0 0 24 24" width="${size}" height="${size}" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
}

/* ── إجراءات سريعة ─────────────────────────────────────────────────────────
   اختصارات لأقسام قائمة فعلًا ومسموحة لهذا الدور — لا زر لميزة غير جاهزة،
   ولا اختصار يتجاوز ما تعرضه القائمة الجانبية نفسها. */
function quickActionsFor() {
    const actions = [
        { tab: 'support', icon: 'plus', title: 'فتح تذكرة دعم', text: 'تواصل مع فريق مدعوم بخصوص حساب شركتك' },
        { tab: 'customerTickets', icon: 'chat', title: 'تذاكر العملاء', text: 'تابع طلبات المستخدمين التابعين لشركتك وردّ عليها' }
    ];
    if (inboxSummary !== null) {
        actions.push({ tab: 'inbox', icon: 'inbox', title: 'صندوق الرسائل', text: 'رسائل عملاء الشركة من بوابتهم' });
    }
    if (canManageMembersNow) {
        actions.push({ tab: 'members', icon: 'users', title: 'إدارة المستخدمين', text: 'أضف مستخدمين وحدّد أدوارهم في الفريق' });
    }
    actions.push(
        { tab: 'api', icon: 'code', title: 'مفاتيح API', text: 'أنشئ المفاتيح وراجع آخر النداءات' },
        { tab: 'reports', icon: 'chart', title: 'التقارير', text: 'أداء الدعم وتصدير البيانات' }
    );
    return actions.filter(action => sectionAllowed(action.tab, viewerRole));
}

function renderQuickActions() {
    const box = document.getElementById('companyQuickActions');
    if (!box) return;
    box.innerHTML = `
        <ul class="company-actions">
            ${quickActionsFor().map(action => `
                <li>
                    <a class="company-action" href="/company-dashboard/#${escapeHtml(action.tab)}" data-tab="${escapeHtml(action.tab)}">
                        <span class="company-action-icon">${icon(action.icon, 18)}</span>
                        <span class="company-action-body">
                            <span class="company-action-title">${escapeHtml(action.title)}</span>
                            <span class="company-action-text">${escapeHtml(action.text)}</span>
                        </span>
                        ${icon('forward', 16, 'company-action-go')}
                    </a>
                </li>`).join('')}
        </ul>`;
}

/* ── ملخّص التذاكر في النظرة العامة ─────────────────────────────────────────
   نفس صفوف المسارين ونفس عدّادات تبويباتهما (countByView) — رقم واحد للشيء
   الواحد في الشاشتين. يُحمَّل المساران مرة واحدة (loadedOnce) كما في التقارير،
   ولا يُعرض رقم لمسار فشلت قراءته: «تعذّر التحميل» بدل صفر كاذب. */
const streamLoads = new Map();

/**
 * تحميل واحد مشترك لكل مسار: النظرة العامة والتقارير وفتح تذكرة من إشعار
 * ينتظرون نفس الوعد، فلا يقرأ أحدهم صفوفًا لم تصل بعد فيعرض أصفارًا كاذبة.
 * الفشل يمسح الوعد فيُعاد التحميل عند فتح القسم.
 */
function ensureStreamLoaded(section, stream) {
    if (!streamLoads.has(section)) {
        loadedOnce.add(section);
        streamLoads.set(section, Promise.resolve(stream.load()).then(ok => {
            if (ok === false) {
                streamLoads.delete(section);
                loadedOnce.delete(section);
            }
            return ok !== false;
        }));
    }
    return streamLoads.get(section);
}

async function renderOverviewTickets() {
    const box = document.getElementById('companyOverviewTickets');
    if (!box) return;
    renderSkeletonLines(box, 3);

    const [platformOk, customersOk] = await Promise.all([
        ensureStreamLoaded('tickets', platformTickets),
        ensureStreamLoaded('customerTickets', customerTickets)
    ]);

    const platform = platformOk ? countByView(platformTickets.rows(), currentUserId) : null;
    const customers = customersOk ? countByView(customerTickets.rows(), currentUserId) : null;

    const stat = ({ tab, iconName, label, value, hint, tone = '' }) => `
        <li>
            <a class="company-stat ${tone}" href="/company-dashboard/#${tab}" data-tab="${tab}">
                <span class="company-stat-icon">${icon(iconName, 18)}</span>
                <span class="company-stat-body">
                    <span class="company-stat-label">${escapeHtml(label)}</span>
                    <span class="company-stat-hint">${escapeHtml(hint)}</span>
                </span>
                <span class="company-stat-value">${escapeHtml(value)}</span>
            </a>
        </li>`;

    const unavailable = 'تعذّر التحميل — افتح القسم لإعادة المحاولة';
    box.innerHTML = `
        <ul class="company-stats">
            ${stat({
                tab: 'tickets', iconName: 'mail', label: 'مفتوحة مع مدعوم',
                value: platform ? String(platform.open) : '—',
                hint: platform ? `من ${platform.all} تذكرة مع فريق مدعوم` : unavailable
            })}
            ${stat({
                tab: 'tickets', iconName: 'alert', label: 'بانتظار ردّك',
                value: platform ? String(platform.awaiting) : '—',
                hint: platform
                    ? (platform.awaiting ? 'ردّ فريق مدعوم ولم تردّ بعد' : 'لا تذكرة تنتظر ردّك')
                    : unavailable,
                tone: platform && platform.awaiting ? 'is-attention' : ''
            })}
            ${stat({
                tab: 'customerTickets', iconName: 'chat', label: 'تذاكر عملاء مفتوحة',
                value: customers ? String(customers.open) : '—',
                hint: customers ? `من ${customers.all} تذكرة من عملاء الشركة` : unavailable
            })}
        </ul>`;
}

/* ── بيانات الشركة ──────────────────────────────────────────────────────── */

function renderProfile() {
    const company = dashboard.company;
    const access = companyAccess(dashboard);
    const registration = registrationInfo(dashboard.registration);

    // المالك فقط هو اللي بيعدّل — والقاعدة بترفض غيره حتى لو ظهر الزر
    document.getElementById('editCompanyBtn').hidden = !access.isOwner;

    const rows = viewerRole !== 'admin' ? [['اسم الشركة', company.name]] : [
        ['اسم الشركة', company.name],
        ['رقم السجل التجاري', company.cr_number],
        ['انتهاء السجل التجاري', company.cr_expiry ? formatDate(company.cr_expiry) : null],
        ['البريد الإلكتروني', company.email],
        ['الهاتف', company.phone],
        ['المدينة', company.city],
        ['الدولة', company.country],
        ['العنوان', company.address],
        ['الرقم الضريبي', company.tax_id],
        ['تاريخ التسجيل', company.created_at ? formatDate(company.created_at) : null]
    ];

    document.getElementById('companyProfileBody').innerHTML = `
        ${registration.isExpired ? `
        <p class="company-notice company-notice--danger">
            السجل التجاري المسجّل منتهي الصلاحية. حدّث تاريخ الانتهاء من "تعديل البيانات".
        </p>` : ''}
        <dl class="company-facts">
            ${rows.map(([label, value]) => `
                <div class="company-fact">
                    <dt>${escapeHtml(label)}</dt>
                    <dd>${value ? escapeHtml(String(value)) : '<span class="is-muted">غير مسجّل</span>'}</dd>
                </div>`).join('')}
        </dl>`;
}

/* ── الاشتراكات ─────────────────────────────────────────────────────────── */

/**
 * قسم الاشتراكات.
 *
 * القراءة كلها من subscription-model.js (خالص ومُختبَر). الأهم فيه أنه
 * يفرّق بين «لم يبدأ بعد» و«منتهٍ» — وهما يحملان status='active' و
 * is_active=false معًا، وكانت الواجهة تعرضهما «منتهٍ» بلا تمييز. الفرق بين
 * القراءتين هو الفرق بين «جدّد الآن» و«لا تفعل شيئًا».
 *
 * الأيام المعروضة هي days_remaining كما حسبتها القاعدة بساعتها — ساعة
 * المتصفح لا تُستعمل إلا لكشف الفارق بين الساعتين وإعلانه.
 */
function renderSubscriptions() {
    const container = document.getElementById('companySubscriptions');
    const subscriptions = dashboard.subscriptions || [];

    if (!subscriptions.length) {
        renderState(container, {
            variant: 'empty',
            title: 'لا توجد اشتراكات بعد',
            text: 'اشترك في إحدى الباقات لتفعيل خدمات الشركة.',
            action: { label: 'استعراض الباقات', goto: '/subscriptions.html', variant: 'btn-primary' }
        });
        return;
    }

    const report = analyzeSubscriptions(subscriptions);

    container.innerHTML = `
        ${subscriptionSummary(report)}
        ${report.hasAnomalies ? anomalyPanel(report) : ''}
        <ul class="company-sub-list">
            ${report.rows.map(subscriptionRow).join('')}
        </ul>`;
}

function subscriptionSummary(report) {
    const cell = (label, value, hint, tone = '') => `
        <div class="kpi ${tone}">
            <p class="kpi-label">${escapeHtml(label)}</p>
            <p class="kpi-value">${escapeHtml(String(value))}</p>
            <p class="kpi-hint">${escapeHtml(hint)}</p>
        </div>`;

    const nearest = report.nearest;
    return `
        <div class="kpi-grid">
            ${cell('اشتراكات نشطة', report.active,
                   report.scheduled ? `${report.scheduled} لم يبدأ بعد` : 'السارية الآن',
                   report.active ? 'kpi--success' : 'kpi--danger')}
            ${cell('أقرب انتهاء',
                   report.daysToNearestExpiry == null ? '—' : `${report.daysToNearestExpiry} يوم`,
                   nearest ? `${nearest.sub.plan_name_ar || nearest.sub.plan} — ${formatDate(nearest.sub.end_date)}`
                           : 'لا اشتراك فعّال',
                   report.daysToNearestExpiry != null && report.daysToNearestExpiry <= 14 ? 'kpi--warning' : '')}
            ${cell('قيد المراجعة', report.pending,
                   report.pending ? 'طلبات بانتظار موافقة الإدارة' : 'لا طلبات معلّقة',
                   report.pending ? 'kpi--warning' : '')}
            ${cell('منتهية', report.expired, 'اشتراكات انقضت مدّتها')}
        </div>`;
}

/** لوحة التضاربات — تشرح الأثر لا الرمز التقني. */
function anomalyPanel(report) {
    const seen = new Map();
    for (const row of report.anomalies) {
        for (const key of row.anomalies) {
            if (!seen.has(key)) seen.set(key, []);
            seen.get(key).push(row.sub.plan_name_ar || row.sub.plan);
        }
    }

    return `
        <section class="panel" aria-labelledby="companySubIssuesHeading">
            <div class="panel-header">
                <div>
                    <h2 class="panel-title" id="companySubIssuesHeading">ملاحظات على التواريخ</h2>
                    <p class="panel-subtitle">فروق بين ما يظهر وما يُحتسب فعليًا، وسببها</p>
                </div>
            </div>
            ${[...seen.entries()].map(([key, plans]) => {
                const note = ANOMALY_NOTES[key];
                if (!note) return '';
                const toneClass = note.tone === 'danger' ? 'company-notice--danger'
                    : (note.tone === 'warning' ? 'company-notice--warning' : '');
                return `
                <p class="company-notice ${toneClass}">
                    <strong>${escapeHtml([...new Set(plans)].join('، '))}:</strong>
                    ${escapeHtml(note.text)}
                </p>`;
            }).join('')}
        </section>`;
}

function subscriptionRow(row) {
    const sub = row.sub;
    const state = row.state;

    const timing = state.key === 'scheduled'
        ? `يبدأ بعد ${escapeHtml(String(row.daysUntilStart))} يومًا`
        : (row.daysRemaining != null && (state.key === 'active' || state.key === 'expiring')
            ? `${escapeHtml(String(row.daysRemaining))} يوم متبقٍ`
            : '');

    return `
        <li class="company-sub">
            <div class="company-sub-main">
                <p class="company-sub-plan">${escapeHtml(sub.plan_name_ar || sub.plan)}</p>
                <p class="company-sub-dates">
                    ${sub.start_date ? `من ${escapeHtml(formatDate(sub.start_date))}` : 'بلا تاريخ بداية'}
                    ${sub.end_date ? ` حتى ${escapeHtml(formatDate(sub.end_date))}` : ' · بلا تاريخ انتهاء'}
                    ${sub.billing_cycle ? ` · ${escapeHtml(billingCycleLabel(sub.billing_cycle))}` : ''}
                </p>
                ${row.anomalies.length ? `
                <p class="company-sub-dates is-warning">
                    ${escapeHtml(row.anomalies.map(k => ANOMALY_NOTES[k]?.text || k).join(' '))}
                </p>` : ''}
            </div>
            <div class="company-sub-side">
                <span class="pill ${escapeHtml(state.pill)}">${escapeHtml(state.label)}</span>
                ${timing ? `<span class="company-sub-days">${timing}</span>` : ''}
            </div>
        </li>`;
}

const BILLING_CYCLES = {
    monthly: 'شهري', yearly: 'سنوي', quarterly: 'ربع سنوي', weekly: 'أسبوعي'
};
function billingCycleLabel(cycle) {
    return BILLING_CYCLES[cycle] || cycle;
}

/* ── الامتيازات ─────────────────────────────────────────────────────────── */

function renderEntitlements() {
    const container = document.getElementById('companyEntitlements');
    const groups = entitlementsByPlan(dashboard);

    if (!groups.length) {
        renderState(container, {
            variant: 'empty',
            title: 'لا توجد خدمات مفعّلة حاليًا',
            text: 'الخدمات تظهر هنا تلقائيًا عند تفعيل اشتراك الشركة، وتُسحب عند انتهائه.',
            action: { label: 'تجديد أو اشتراك', goto: '/subscriptions.html', variant: 'btn-primary' }
        });
        return;
    }

    container.innerHTML = groups.map(group => `
        <div class="company-plan-group">
            <h3 class="company-plan-name">${escapeHtml(group.planName)}</h3>
            <ul class="company-feature-list">
                ${group.features.map(feature => `
                    <li class="company-feature">
                        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>
                        <div>
                            <p class="company-feature-name">${escapeHtml(feature.name_ar || feature.feature_key)}</p>
                            ${feature.description ? `<p class="company-feature-desc">${escapeHtml(feature.description)}</p>` : ''}
                        </div>
                    </li>`).join('')}
            </ul>
        </div>`).join('');
}

/* ── نموذج تعديل بيانات الشركة ──────────────────────────────────────────── */

function wireForm() {
    const form = document.getElementById('companyForm');
    const body = document.getElementById('companyProfileBody');
    const editBtn = document.getElementById('editCompanyBtn');

    editBtn?.addEventListener('click', () => {
        fillForm();
        form.hidden = false;
        body.hidden = true;
        editBtn.hidden = true;
    });

    document.getElementById('cancelCompanyBtn')?.addEventListener('click', () => {
        form.hidden = true;
        body.hidden = false;
        editBtn.hidden = false;
        clearErrors();
    });

    form?.addEventListener('submit', onSubmit);

    // إعادة المحاولة وحالات الانتقال المشتركة مع باقي صفحات البوابة
    document.addEventListener('click', (event) => {
        const retry = event.target.closest('[data-retry]');
        if (retry) { load(); return; }
        const goto = event.target.closest('[data-goto]');
        if (goto) window.location.href = goto.getAttribute('data-goto');
    });
}

function fillForm() {
    const company = dashboard.company;
    const set = (id, value) => { document.getElementById(id).value = value || ''; };
    set('fCompanyName', company.name);
    set('fCrNumber', company.cr_number);
    set('fCrExpiry', company.cr_expiry ? String(company.cr_expiry).slice(0, 10) : '');
    set('fCompanyEmail', company.email);
    set('fCompanyPhone', company.phone);
    set('fCity', company.city);
    set('fCountry', company.country);
    set('fAddress', company.address);
    set('fTaxId', company.tax_id);
}

function clearErrors() {
    document.querySelectorAll('#companyForm [data-error-for]').forEach(el => {
        el.hidden = true;
        el.textContent = '';
    });
    const formError = document.getElementById('companyFormError');
    formError.hidden = true;
    formError.textContent = '';
}

function showErrors(errors) {
    for (const [field, message] of Object.entries(errors)) {
        const el = document.querySelector(`#companyForm [data-error-for="${field}"]`);
        if (el) { el.textContent = message; el.hidden = false; }
    }
}

async function onSubmit(event) {
    event.preventDefault();
    clearErrors();

    const values = {
        companyName: document.getElementById('fCompanyName').value,
        crNumber: document.getElementById('fCrNumber').value,
        crExpiry: document.getElementById('fCrExpiry').value,
        companyEmail: document.getElementById('fCompanyEmail').value,
        companyPhone: document.getElementById('fCompanyPhone').value,
        city: document.getElementById('fCity').value,
        country: document.getElementById('fCountry').value,
        address: document.getElementById('fAddress').value,
        taxId: document.getElementById('fTaxId').value
    };

    const validation = validateCompanyForm(values);
    if (!validation.isValid) {
        showErrors(validation.errors);
        return;
    }

    const btn = document.getElementById('saveCompanyBtn');
    btn.disabled = true;
    btn.textContent = 'جارٍ الحفظ…';

    const result = await saveCompany(values);

    btn.disabled = false;
    btn.textContent = 'حفظ البيانات';

    if (!result.ok) {
        // رسالة القاعدة بتتعرض زي ما هي (كلها عربية ومفهومة)
        const formError = document.getElementById('companyFormError');
        formError.textContent = result.error;
        formError.hidden = false;
        return;
    }

    ui?.showToast?.('تم حفظ بيانات الشركة', 'success');
    document.getElementById('companyForm').hidden = true;
    document.getElementById('companyProfileBody').hidden = false;
    document.getElementById('editCompanyBtn').hidden = false;
    await load();
}
