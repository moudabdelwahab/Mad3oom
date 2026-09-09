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
import { initCompanyTickets, loadCompanyTickets, openCompanyTicket } from '/assets/js/company/company-tickets.js';
import { initCompanySupport, loadCompanySupport } from '/assets/js/company/company-support.js';
import { initCompanyNotifications, loadCompanyNotifications } from '/assets/js/company/company-notifications.js';
import { loadCompanyProfile, loadCompanySecurity } from '/assets/js/company/company-account.js';
import {
    escapeHtml, formatDate, renderState, renderSkeletonLines
} from '/assets/js/customer/portal-ui.js';
import { ui } from '/ui-service.js';
import {
    fetchCompanyDashboard,
    fetchCompanyMembers,
    createCompanyMember,
    saveCompany
} from '/assets/js/company/company-data.js';
import {
    subscriptionStatusInfo,
    summarizeSubscriptions,
    registrationInfo,
    companyAccess,
    entitlementsByPlan,
    canManageMembers,
    validateCompanyForm,
    validateMemberForm
} from '/assets/js/company/company-model.js';

let dashboard = null;
let currentUserId = null;

/** آخر قرار قرأناه من القاعدة لإدارة المستخدمين — للعرض فقط، لا للتفويض. */
let canManageMembersNow = false;

document.addEventListener('DOMContentLoaded', init);

async function init() {
    // اللوحة دي مفتوحة لأي حساب مسجّل؛ اللي بتعرضه بيحدده
    // get_my_company_dashboard() في القاعدة. مفيش قيد رتبة هنا عمدًا.
    const user = await guardPage();
    if (!user) return;

    currentUserId = user.id;

    // قشرة الشركة: قائمتها الخاصة، وكل عناصرها أقسام في هذه الصفحة.
    // onTabChange بيخلي عناصر القائمة تبدّل الأقسام بدل ما تنقل لأي صفحة.
    initCompanyShell({ onTabChange: showSection });

    initCompanyTickets(currentUserId, { onNewTicket: () => showSection('support') });
    initCompanySupport({ onCreated: onTicketCreated });
    initCompanyNotifications({
        onNavigate: showSection,
        onOpenTicket: (ticketId) => { showSection('tickets'); openCompanyTicket(ticketId); }
    });

    wireForm();
    wireAddMember();
    wireSectionRouting();

    await load();

    // البحث في الشريط العلوي بيوصل هنا كـ?q= (بيت القشرة هو لوحة الشركة
    // نفسها)، فبنفتح التذاكر عليه بدل ما يضيع.
    const query = new URLSearchParams(window.location.search).get('q');
    if (query) {
        loadedOnce.add('tickets');
        showSection('tickets');
        await loadCompanyTickets({ search: query });
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
const SECTIONS = ['overview', 'members', 'subscriptions', 'tickets', 'support', 'notifications', 'profile', 'security'];

/** الأقسام اللي بتتحمّل عند أول فتح لها فقط. */
const LOADERS = {
    tickets: () => loadCompanyTickets(),
    support: () => loadCompanySupport(),
    notifications: () => loadCompanyNotifications(),
    profile: () => loadCompanyProfile(),
    security: () => loadCompanySecurity()
};

const loadedOnce = new Set();

function sectionFromHash() {
    const hash = (window.location.hash || '').replace(/^#/, '');
    return SECTIONS.includes(hash) ? hash : 'overview';
}

export function showSection(name, { updateHash = true } = {}) {
    const section = SECTIONS.includes(name) ? name : 'overview';

    SECTIONS.forEach(key => {
        const el = document.getElementById(`${key}TabContent`);
        if (el) el.classList.toggle('active', key === section);
    });

    setActiveSidebarTab(section);
    if (updateHash && window.location.hash.slice(1) !== section) {
        history.replaceState(null, '', `#${section}`);
    }
    window.scrollTo({ top: 0, behavior: 'auto' });

    if (!loadedOnce.has(section) && LOADERS[section]) {
        loadedOnce.add(section);
        LOADERS[section]();
    }
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

/** بعد فتح تذكرة من مركز الدعم: نعرضها في قسم التذاكر بلا مغادرة اللوحة. */
async function onTicketCreated() {
    loadedOnce.add('tickets');
    showSection('tickets');
    await loadCompanyTickets();
}

async function load() {
    const content = document.getElementById('companyContent');
    const gate = document.getElementById('companyGate');
    renderSkeletonLines(document.getElementById('companyGateBody'), 3);
    gate.hidden = false;
    content.hidden = true;

    const result = await fetchCompanyDashboard();

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
    renderBanner();
    renderKpis();
    renderProfile();
    renderSubscriptions();
    renderEntitlements();
    await renderMembers();
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

    const result = await fetchCompanyMembers();
    if (!result.ok || !result.data) { panel.hidden = true; return; }

    // القرار جاي من القاعدة كما هو؛ الواجهة ما بتحسبوش.
    canManageMembersNow = canManageMembers(result.data);
    const { members = [] } = result.data;
    panel.hidden = false;
    addBtn.hidden = !canManageMembersNow;

    if (!members.length) {
        renderState(container, { variant: 'empty', title: 'لا يوجد مستخدمون بعد', text: '' });
        return;
    }

    container.innerHTML = `
        <ul class="company-sub-list">
            ${members.map(m => `
                <li class="company-sub">
                    <div class="company-sub-main">
                        <p class="company-sub-plan">${escapeHtml(m.name || m.email || '—')}</p>
                        <p class="company-sub-dates">${escapeHtml(m.email || '')}</p>
                    </div>
                    <div class="company-sub-side">
                        <span class="pill ${m.is_owner ? 'status-tone-accent' : 'status-neutral'}">
                            ${m.is_owner ? 'مالك الحساب' : 'مستخدم فرعي'}
                        </span>
                        ${m.is_me ? '<span class="company-sub-days">أنت</span>' : ''}
                    </div>
                </li>`).join('')}
        </ul>`;
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

/* ── شريط المستوى ───────────────────────────────────────────────────────── */

function renderBanner() {
    const banner = document.getElementById('companyBanner');
    const access = companyAccess(dashboard);
    banner.hidden = false;

    document.getElementById('companyName').textContent = dashboard.company.name || 'شركة بلا اسم';

    const parts = [];
    if (dashboard.company.cr_number) parts.push(`سجل تجاري: ${dashboard.company.cr_number}`);
    parts.push(access.isOwner ? 'أنت مالك الحساب' : 'أنت عضو في هذه الشركة');
    document.getElementById('companyMeta').textContent = parts.join(' • ');

    const pill = document.getElementById('companyAccessPill');
    pill.hidden = false;
    if (access.hasActiveSubscription) {
        pill.className = 'pill status-tone-success';
        pill.textContent = `${access.activePlans.length} اشتراك فعّال`;
    } else {
        pill.className = 'pill status-tone-danger';
        pill.textContent = 'لا يوجد اشتراك فعّال';
    }
}

/* ── بطاقات الأرقام ─────────────────────────────────────────────────────── */

function renderKpis() {
    const summary = summarizeSubscriptions(dashboard.subscriptions);
    const registration = registrationInfo(dashboard.registration);
    const toneClass = { success: 'kpi--success', warning: 'kpi--warning', danger: 'kpi--danger', neutral: '' };

    const cards = [
        {
            label: 'اشتراكات فعّالة',
            value: String(summary.active),
            hint: summary.pending ? `${summary.pending} طلب قيد المراجعة` : 'الباقات السارية الآن',
            tone: summary.active > 0 ? 'success' : 'danger'
        },
        {
            label: 'أقرب انتهاء اشتراك',
            value: summary.daysToNearestExpiry == null ? '—' : `${summary.daysToNearestExpiry} يوم`,
            hint: summary.nearestExpiry
                ? `${summary.nearestExpiry.plan_name_ar} — ${formatDate(summary.nearestExpiry.end_date)}`
                : 'لا يوجد اشتراك فعّال',
            tone: summary.daysToNearestExpiry != null && summary.daysToNearestExpiry <= 7 ? 'warning' : 'neutral'
        },
        {
            label: 'السجل التجاري',
            value: registration.label,
            hint: registration.hasDate
                ? `ينتهي في ${formatDate(dashboard.registration.expiry_date)}`
                : 'أضف تاريخ انتهاء السجل من بيانات الشركة',
            tone: registration.tone
        },
        {
            label: 'الخدمات المتاحة',
            value: String((dashboard.entitlements || []).length),
            hint: 'مشتقّة من الباقات الفعّالة',
            tone: 'neutral'
        }
    ];

    document.getElementById('companyKpis').innerHTML = cards.map(card => `
        <div class="kpi ${toneClass[card.tone] || ''}">
            <p class="kpi-label">${escapeHtml(card.label)}</p>
            <p class="kpi-value">${escapeHtml(card.value)}</p>
            <p class="kpi-hint">${escapeHtml(card.hint)}</p>
        </div>`).join('');
}

/* ── بيانات الشركة ──────────────────────────────────────────────────────── */

function renderProfile() {
    const company = dashboard.company;
    const access = companyAccess(dashboard);
    const registration = registrationInfo(dashboard.registration);

    // المالك فقط هو اللي بيعدّل — والقاعدة بترفض غيره حتى لو ظهر الزر
    document.getElementById('editCompanyBtn').hidden = !access.isOwner;

    const rows = [
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

function renderSubscriptions() {
    const container = document.getElementById('companySubscriptions');
    const subscriptions = dashboard.subscriptions || [];

    if (!subscriptions.length) {
        renderState(container, {
            variant: 'empty',
            title: 'لا توجد اشتراكات بعد',
            text: 'اشترك في إحدى الباقات لتفعيل خدمات الشركة.',
            action: { label: 'استعراض الباقات', goto: '/subscriptions.html' }
        });
        return;
    }

    container.innerHTML = `
        <ul class="company-sub-list">
            ${subscriptions.map(sub => {
                const info = subscriptionStatusInfo(sub);
                return `
                <li class="company-sub">
                    <div class="company-sub-main">
                        <p class="company-sub-plan">${escapeHtml(sub.plan_name_ar || sub.plan)}</p>
                        <p class="company-sub-dates">
                            ${sub.start_date ? `من ${escapeHtml(formatDate(sub.start_date))}` : ''}
                            ${sub.end_date ? ` حتى ${escapeHtml(formatDate(sub.end_date))}` : ''}
                        </p>
                    </div>
                    <div class="company-sub-side">
                        <span class="pill ${info.pill}">${escapeHtml(info.label)}</span>
                        ${sub.is_active ? `<span class="company-sub-days">${escapeHtml(sub.days_remaining)} يوم متبقٍ</span>` : ''}
                    </div>
                </li>`;
            }).join('')}
        </ul>`;
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
