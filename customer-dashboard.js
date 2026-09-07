// customer-dashboard.js — منطق بوابة دعم العميل
//
// البنية: كل قسم له وحدة render خاصة، وكلها بتقرا من طبقات مشتركة:
//   tickets-service.js                        التذاكر والردود والمرفقات
//   notifications-service.js                  الإشعارات
//   rewards-dashboard.js                      المكافآت
//   assets/js/customer/customer-data.js       حالة الحساب والخدمات
//   assets/js/customer/platform-settings.js   إعدادات الأدمن
//   assets/js/customer/ticket-view-model.js   لغة التذاكر كما يراها العميل
//   assets/js/customer/notification-router.js تحويل الإشعار إلى إجراء
//   assets/js/customer/account-health.js      "إيه اللي محتاج منك إجراء"
//   assets/js/customer/activity-model.js      سجل النشاط الآمن للعميل
//
// مفيش هنا أي منطق مكرر لحاجة ليها وحدة فوق — الملف ده تنسيق ورسم فقط.
import { requireAuth, updateProfile, updatePassword } from './auth-client.js';
import {
    initCustomerSidebar,
    updateSystemStatusPill,
    setSidebarBadge,
    setActiveSidebarTab
} from './assets/js/customer-sidebar.js';
import { initExpiryModalHandler } from './assets/js/subscription-expiry-modal.js';
import { initRewardsDashboard } from './rewards-dashboard.js';
import { initCustomerSettingsModal } from './customer-settings-modal.js';
import {
    fetchUserTickets,
    createTicket,
    fetchTicketReplies,
    addTicketReply,
    subscribeToTickets,
    deleteTicket,
    fetchTicketAttachments,
    fetchTicketTags,
    fetchTicketActivity,
    fetchTicketRating,
    submitTicketRating,
    uploadTicketAttachment
} from './tickets-service.js';
import {
    fetchNotifications,
    markAsRead,
    markAllAsRead,
    subscribeToNotifications,
    formatRelativeArabic
} from './notifications-service.js';
import { ui } from './ui-service.js';
// حالات العرض المشتركة مع باقي صفحات البوابة (مركز المساعدة يستخدم نفسها)
import {
    escapeHtml, timeAgo, formatDate, formatDateTime,
    setText, renderState, renderSkeletonLines
} from './assets/js/customer/portal-ui.js';
import {
    getPlatformSettings,
    supportAvailability,
    slaTargetHours,
    formatTime,
    dayName
} from './assets/js/customer/platform-settings.js';
import * as customerData from './assets/js/customer/customer-data.js';
import {
    TICKET_VIEWS,
    statusInfo,
    applyTicketView,
    countByView,
    availableActions,
    needsCustomerReply
} from './assets/js/customer/ticket-view-model.js';
import {
    entitlementsFrom,
    impairedForCustomer,
    incidentForService,
    isImpaired,
    orderForCustomer,
    statusInfo as serviceStatusInfo,
    episodeKeyFor
} from './assets/js/customer/service-status-model.js';
import {
    resolveNotification,
    actionLabelFor,
    destinationLabel,
    categoriesPresentIn,
    NOTIFICATION_CATEGORIES
} from './assets/js/customer/notification-router.js';
import { assessAccountHealth } from './assets/js/customer/account-health.js';
import { toTimeline } from './assets/js/customer/activity-model.js';

/* =========================================================
   حماية من bfcache (Back-Forward Cache)
   =========================================================
   لو المستخدم سجّل خروج ثم ضغط "رجوع"، بعض المتصفحات بترجّع نسخة مجمدة من
   الصفحة من الذاكرة من غير ما تعيد تنفيذ الكود، فتبان وكأنه لسه مسجّل دخول.
   إعادة التحميل القسرية بتخلي requireAuth() يشتغل تاني ويكتشف غياب الجلسة.
========================================================= */
window.addEventListener('pageshow', (event) => {
    if (event.persisted) window.location.reload();
});

/* =========================================================
   أدوات مشتركة
========================================================= */

function sanitizeUrl(url) {
    if (!url) return '';
    const trimmed = String(url).trim();
    if (/^(https?:)?\/\//i.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('./')) {
        return escapeHtml(trimmed);
    }
    return '';
}

const PRIORITY_LABELS = { high: 'عالية', medium: 'متوسطة', low: 'منخفضة' };
const CATEGORY_LABELS = { whatsapp: 'واتساب', tickets: 'تذاكر', subscription: 'اشتراك', login: 'تسجيل دخول', other: 'أخرى' };
const CATEGORY_CLASS = { whatsapp: 'cat-whatsapp', tickets: 'cat-tickets', subscription: 'cat-subscription', login: 'cat-login', other: 'cat-other' };

const ACTIVITY_LABELS = {
    create: 'تم إنشاء التذكرة',
    status_change: 'تغيّرت حالة التذكرة',
    priority_change: 'تم تحديث الأولوية',
    category_change: 'تم تحديث التصنيف',
    reply: 'تم إضافة رد',
    reopen: 'تم إعادة فتح التذكرة',
    rating: 'تم تسجيل تقييمك',
    tag_add: 'تمت إضافة وسم',
    tag_remove: 'تمت إزالة وسم'
};

// محجوبة على مستوى قاعدة البيانات (migrations/010). الفلترة هنا للعرض فقط.
const CUSTOMER_HIDDEN_ACTIVITY_TYPES = new Set(['assignee_change', 'assigned', 'internal_note']);

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

function statusBadge(status) {
    const info = statusInfo(status);
    return `<span class="pill ${info.pill}"><span class="pill-dot"></span>${escapeHtml(info.label)}</span>`;
}

function priorityBadge(priority, { onlyHigh = false } = {}) {
    if (!priority || (onlyHigh && priority !== 'high')) return '';
    return `<span class="pill priority-${escapeHtml(priority)}">${escapeHtml(PRIORITY_LABELS[priority] || priority)}</span>`;
}

function categoryBadge(category) {
    if (!category) return '';
    const cls = CATEGORY_CLASS[category] || 'cat-other';
    return `<span class="pill ${cls}">${escapeHtml(CATEGORY_LABELS[category] || category)}</span>`;
}

/** صف بيانات موحّد. value و note لازم يكونوا HTML آمن مبني مسبقاً. */
function dataRow({ label, value, note }) {
    return `
        <div class="data-row">
            <span class="data-row-label">${escapeHtml(label)}</span>
            <span class="data-row-value">${value}</span>
            ${note ? `<div class="data-row-note">${note}</div>` : ''}
        </div>`;
}

function meter(percent, tone = '') {
    const width = Math.max(0, Math.min(100, Number(percent) || 0));
    return `<div class="meter"><div class="meter-fill ${tone}" style="width:${width}%"></div></div>`;
}

/* =========================================================
   نقطة البداية
========================================================= */

(async function () {

    const user = await requireAuth('user');
    if (!user) {
        window.location.replace('login.html');
        return;
    }

    const isGuest = user.isGuest || false;
    const isImpersonated = !!user.isImpersonated;

    const settings = await getPlatformSettings();
    const cx = settings.customer_experience;

    /* ================= شريط انتحال الحساب ================= */

    if (isImpersonated) {
        const banner = document.createElement('div');
        banner.id = 'dashboardImpersonationBanner';
        banner.className = 'impersonation-banner';
        const memberName = user.profile?.full_name || user.profile?.email || 'هذا العضو';
        const isSelfLogin = user.impersonatorId && user.impersonatorId === user.id;

        const label = document.createElement('span');
        // .textContent عمدًا: الاسم قيمة قادمة من قاعدة البيانات
        label.textContent = isSelfLogin
            ? 'بتشوف حسابك كـ عضو (وضع "الدخول كعضو")'
            : `بتشوف لوحة العضو: ${memberName}`;

        const backBtn = document.createElement('button');
        backBtn.type = 'button';
        backBtn.textContent = 'رجوع لحسابي';
        backBtn.addEventListener('click', () => {
            const url = new URL(window.location.href);
            url.searchParams.delete('impersonate');
            window.location.href = url.pathname + url.search;
        });

        banner.append(label, backBtn);
        document.body.insertBefore(banner, document.body.firstChild);
    }

    /* ================= التنقّل بين الأقسام ================= */

    const SECTIONS = ['overview', 'support', 'tickets', 'notifications', 'usage', 'activity', 'security', 'rewards', 'badges', 'profile'];
    const GUEST_BLOCKED = new Set(['rewards', 'badges', 'profile', 'notifications', 'usage', 'activity', 'security']);
    let currentSection = 'overview';

    // أقسام يخفيها إعداد من لوحة الإدارة (المكافآت مرتبطة بـ enable_rewards_system)
    const disabledSections = new Set();
    if (!cx.enable_rewards_system) {
        disabledSections.add('rewards');
        const index = SECTIONS.indexOf('rewards');
        if (index > -1) SECTIONS.splice(index, 1);
        GUEST_BLOCKED.delete('rewards');
        document.getElementById('rewardsTabContent')?.remove();
    }

    const loadedOnce = new Set();

    function showSection(name, { updateHash = true } = {}) {
        if (!SECTIONS.includes(name)) name = 'overview';

        if (isGuest && GUEST_BLOCKED.has(name)) {
            ui.showToast('هذه الميزة غير متاحة في وضع الضيف. سجّل الدخول للاستفادة منها.', 'info');
            return;
        }

        currentSection = name;
        SECTIONS.forEach(section => {
            const el = document.getElementById(`${section}TabContent`);
            if (el) el.classList.toggle('active', section === name);
        });

        setActiveSidebarTab(name);
        if (updateHash && window.location.hash.slice(1) !== name) {
            history.replaceState(null, '', `#${name}`);
        }
        window.scrollTo({ top: 0, behavior: 'auto' });

        if (!loadedOnce.has(name)) {
            loadedOnce.add(name);
            lazyLoadSection(name);
        }
    }

    function lazyLoadSection(name) {
        if (name === 'badges') renderBadges();
        if (name === 'notifications') renderNotifications();
        if (name === 'profile') renderProfileSection();
        if (name === 'usage') renderUsageSection();
        if (name === 'activity') renderActivitySection();
        if (name === 'security') renderSecuritySection();
        if (name === 'support') renderSupportSection();
    }

    window.addEventListener('hashchange', () => {
        showSection(window.location.hash.slice(1) || 'overview', { updateHash: false });
    });

    /* ================= القائمة الجانبية ================= */

    initCustomerSidebar({
        onTabChange: (tabName) => showSection(tabName),
        // اللوحة بترسم نتائج البحث وحالة النظام بنفسها من نفس اللقطة، فالقشرة
        // ما بتجيبهمش تاني — نفس البيانات مرة واحدة بدل استعلامين.
        ownsSearch: true,
        ownsSystemStatus: true,
        onReady: () => {
            updateSidebarUserInfo();
            refreshNotificationBadge();
            disabledSections.forEach(section => {
                document.querySelector(`.sidebar-item[data-tab="${section}"]`)?.remove();
            });
            setActiveSidebarTab(currentSection);
            setSidebarBadge('tickets', countByView(cachedTickets, user.id).awaiting);
            bindGlobalSearch();
            updateSystemStatusPill(snapshot?.systemStatus?.ok ? snapshot.systemStatus.data : null);
        }
    });

    function updateSidebarUserInfo() {
        const initialEl = document.getElementById('customerInitial');
        if (initialEl) {
            const source = user.profile?.full_name || user.email || 'U';
            initialEl.textContent = source.trim().charAt(0).toUpperCase();
        }
    }

    if (!isGuest) {
        initExpiryModalHandler();
        initCustomerSettingsModal();
    }

    /* =========================================================
       اللقطة المشتركة: تُجلب مرة وتغذّي كل الأقسام
    ========================================================= */

    let snapshot = null;
    let cachedTickets = [];
    /** بلاغات العميل الحالية — تحدّد إن كان زر "إبلاغ الإدارة" متاحًا لكل عطل. */
    let myServiceReports = [];

    async function loadSnapshot() {
        if (isGuest) {
            snapshot = { tickets: [] };
            myServiceReports = [];
            return snapshot;
        }

        const [account, planSubs, waSub, wallet, sie, subdomains, systemStatus, badges, tickets, reports] =
            await Promise.all([
                customerData.fetchAccountStatus(),
                customerData.fetchPlanSubscriptions(),
                customerData.fetchWhatsappSubscription(),
                customerData.fetchWhatsappWallet(),
                customerData.fetchSieAccess(),
                customerData.fetchSubdomains(),
                customerData.fetchSystemStatus(),
                customerData.fetchBadgeProgress(),
                fetchUserTickets({}).catch(err => { console.error('[Snapshot] tickets:', err); return []; }),
                customerData.fetchMyServiceReports()
            ]);

        cachedTickets = tickets || [];
        myServiceReports = reports.ok ? reports.data : [];
        snapshot = { account, planSubs, waSub, wallet, sie, subdomains, systemStatus, badges, tickets: cachedTickets };
        // شارة الحالة في الشريط العلوي بتقرا من نفس اللقطة، فبتتحدّث مع كل تحديث
        updateSystemStatusPill(systemStatus.ok ? systemStatus.data : null);
        return snapshot;
    }

    /* =========================================================
       قسم: نظرة عامة (موجّه للإجراء)
    ========================================================= */

    async function renderOverview() {
        const headingEl = document.getElementById('overviewHeading');
        const welcomeEl = document.getElementById('overviewWelcomeMessage');

        const displayName = user.profile?.full_name || user.email?.split('@')[0] || 'مستخدم';
        if (headingEl) headingEl.textContent = isGuest ? 'مرحباً بك (زائر)' : `مرحباً، ${displayName}`;
        if (welcomeEl) {
            welcomeEl.textContent = cx.welcome_message?.trim()
                || 'تابع تذاكرك وحالة خدماتك من مكان واحد.';
        }

        if (isGuest) {
            renderGuestOverview();
            return;
        }

        renderAccountHealth();
        renderOverviewKpis();
        renderAccountStatus();

        const activity = await customerData.fetchAccountActivity(12);
        renderActivityTimeline(activity, 'recentActivityBody', 6);
    }

    function renderGuestOverview() {
        const kpis = document.getElementById('overviewKpis');
        if (kpis) kpis.innerHTML = '';
        document.getElementById('accountHealthCard')?.setAttribute('hidden', '');
        const notice = {
            title: 'أنت في وضع الضيف',
            text: 'سجّل الدخول بحساب لعرض تذاكرك وحالة خدماتك ومتابعة اشتراكاتك.'
        };
        ['accountStatusBody', 'recentActivityBody'].forEach(id => {
            renderState(document.getElementById(id), { variant: 'empty', ...notice });
        });
    }

    const HEALTH_ICONS = {
        healthy: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>',
        attention: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/><circle cx="12" cy="12" r="10"/></svg>',
        critical: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
    };

    const SEVERITY_TONE = { critical: 'danger', warning: 'warning', info: 'info' };

    function renderAccountHealth() {
        const card = document.getElementById('accountHealthCard');
        if (!card || !snapshot) return;

        const health = assessAccountHealth(snapshot, { userId: user.id });

        card.removeAttribute('hidden');
        card.setAttribute('data-status', health.status);
        const icon = document.getElementById('healthIcon');
        if (icon) icon.innerHTML = HEALTH_ICONS[health.status];
        setText('healthHeadline', health.headline);
        setText('healthSubline', health.subline);

        const list = document.getElementById('healthItems');
        if (!list) return;

        if (!health.items.length) {
            list.innerHTML = '';
            return;
        }

        list.innerHTML = health.items.map(item => {
            const tone = SEVERITY_TONE[item.severity] || 'info';
            const action = item.action
                ? (item.action.href
                    ? `<a class="alert-action" href="${escapeHtml(item.action.href)}">${escapeHtml(item.action.label)}</a>`
                    : `<button type="button" class="alert-action" data-goto="${escapeHtml(item.action.section)}" style="background:none;border:none;cursor:pointer;font-family:inherit;">${escapeHtml(item.action.label)}</button>`)
                : '';
            return `
                <div class="alert-item alert-item--${tone}">
                    <span class="alert-icon">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/><circle cx="12" cy="12" r="10"/></svg>
                    </span>
                    <div class="alert-body">
                        <p class="alert-title">${escapeHtml(item.title)}</p>
                        <p class="alert-text">${escapeHtml(item.text)}</p>
                    </div>
                    ${action}
                </div>`;
        }).join('');
    }

    /** متوسط زمن أول رد على تذاكر العميل — مؤشر من بياناته هو. */
    function averageFirstResponseHours(tickets) {
        const answered = (tickets || []).filter(t => t.first_response_at && t.created_at);
        if (!answered.length) return null;
        const totalMs = answered.reduce((sum, t) =>
            sum + (new Date(t.first_response_at) - new Date(t.created_at)), 0);
        return totalMs / answered.length / 3600000;
    }

    function renderOverviewKpis() {
        const container = document.getElementById('overviewKpis');
        if (!container || !snapshot) return;

        const counts = countByView(cachedTickets, user.id);
        const avgHours = averageFirstResponseHours(cachedTickets);
        const badgeData = snapshot.badges?.ok ? snapshot.badges.data : null;
        const unread = Number(container.dataset.unread || 0);

        const cards = [
            {
                label: 'تذاكر مفتوحة',
                value: counts.open,
                hint: `${counts.all} تذكرة إجمالاً`,
                tone: 'info',
                action: 'tickets'
            },
            {
                label: 'بانتظار ردّك',
                value: counts.awaiting,
                hint: counts.awaiting ? 'فيه ردود محتاجة متابعتك' : 'لا شيء ينتظر ردك',
                tone: counts.awaiting ? 'warning' : 'success',
                action: 'tickets'
            },
            {
                label: 'متوسط أول رد',
                value: avgHours === null ? '—'
                    : (avgHours < 1 ? String(Math.round(avgHours * 60)) : avgHours.toFixed(1)),
                hint: avgHours === null ? 'لم يُسجَّل رد بعد' : (avgHours < 1 ? 'دقيقة على تذاكرك' : 'ساعة على تذاكرك'),
                tone: 'accent'
            },
            {
                label: 'إشعارات غير مقروءة',
                value: unread,
                hint: badgeData ? `${badgeData.earned}/${badgeData.total} شارة مكتسبة` : '',
                tone: unread ? 'accent' : 'success',
                action: 'notifications'
            }
        ];

        container.innerHTML = cards.map(card => {
            const tag = card.action ? 'button' : 'div';
            const attrs = card.action ? ` type="button" data-goto="${card.action}"` : '';
            return `
                <${tag} class="kpi kpi--${card.tone}${card.action ? ' is-clickable' : ''}"${attrs}>
                    <span class="kpi-label">${escapeHtml(card.label)}</span>
                    <span class="kpi-value">${escapeHtml(String(card.value))}</span>
                    ${card.hint ? `<span class="kpi-hint">${escapeHtml(card.hint)}</span>` : ''}
                </${tag}>`;
        }).join('');
    }

    function renderAccountStatus() {
        const container = document.getElementById('accountStatusBody');
        if (!container || !snapshot) return;

        if (!snapshot.account?.ok) {
            renderState(container, {
                variant: 'error',
                title: 'تعذّر تحميل حالة الحساب',
                text: 'تحقق من اتصالك ثم أعد المحاولة.',
                action: { label: 'إعادة المحاولة', retry: 'overview' }
            });
            return;
        }

        const profile = snapshot.account.data || {};
        const rows = [];
        const banned = profile.ban_status && !['active', 'none'].includes(profile.ban_status);

        rows.push({
            label: 'حالة الحساب',
            value: banned
                ? '<span class="pill status-rejected"><span class="pill-dot"></span>مقيّد</span>'
                : '<span class="pill status-resolved"><span class="pill-dot"></span>نشط</span>',
            note: escapeHtml(banned
                ? (profile.ban_reason || 'تواصل مع الدعم لمعرفة التفاصيل.')
                : `عضو منذ ${formatDate(profile.created_at)}`)
        });

        const activePlans = (snapshot.planSubs?.ok ? snapshot.planSubs.data : [])
            .filter(s => s.status === 'active' && (!s.end_date || new Date(s.end_date) > new Date()));
        if (activePlans.length) {
            rows.push({
                label: 'الباقات المفعّلة',
                value: activePlans.map(s =>
                    `<span class="pill status-resolved">${escapeHtml(s.subscription_plans?.name_ar || s.subscription_plans?.name || 'باقة')}</span>`
                ).join(' ')
            });
        }

        const wa = snapshot.waSub?.ok ? snapshot.waSub.data : null;
        if (wa?.hasActiveSubscription) {
            rows.push({
                label: 'خدمة الواتساب',
                value: '<span class="pill status-resolved"><span class="pill-dot"></span>فعّالة</span>',
                note: escapeHtml(`متبقٍ ${wa.daysRemaining} يوم`)
            });
        } else if (profile.whatsapp_enabled) {
            rows.push({
                label: 'خدمة الواتساب',
                value: '<span class="pill status-resolved"><span class="pill-dot"></span>مفعّلة</span>',
                note: 'مفعّلة لحسابك من فريق الإدارة'
            });
        }

        const wallet = snapshot.wallet?.ok ? snapshot.wallet.data : null;
        if (wallet) {
            rows.push({
                label: 'رصيد الواتساب',
                value: escapeHtml(`${wallet.balance.toLocaleString('ar-EG')} ${wallet.currency || ''}`),
                note: wallet.isLow ? '<span class="pill status-in-progress">تحت الحد الأدنى</span>' : ''
            });
        }

        const sie = snapshot.sie?.ok ? snapshot.sie.data : null;
        if (sie?.is_enabled && sie.quota > 0) {
            const tone = sie.usedPercent >= 90 ? 'meter-fill--danger' : sie.usedPercent >= 70 ? 'meter-fill--warning' : '';
            rows.push({
                label: 'المحرك الذكي',
                value: escapeHtml(`${sie.used} / ${sie.quota} رسالة`),
                note: meter(sie.usedPercent, tone)
            });
        }

        const domains = snapshot.subdomains?.ok ? snapshot.subdomains.data : [];
        if (domains.length) {
            const active = domains.find(d => d.status === 'active') || domains[0];
            rows.push({
                label: 'النطاق الفرعي',
                value: `<span class="pill ${active.status === 'active' ? 'status-resolved' : 'status-in-progress'}">${escapeHtml(active.full_domain || active.subdomain)}</span>`
            });
        }

        container.innerHTML = `<div class="data-rows">${rows.map(dataRow).join('')}</div>`;
    }

    function renderActivityTimeline(result, targetId, limit) {
        const container = document.getElementById(targetId);
        if (!container) return;

        if (!result?.ok) {
            renderState(container, {
                variant: 'error',
                title: 'تعذّر تحميل سجل النشاط',
                text: 'تحقق من اتصالك ثم أعد المحاولة.',
                action: { label: 'إعادة المحاولة', retry: 'activity' }
            });
            return;
        }

        const items = toTimeline(result.data, { limit });
        if (!items.length) {
            renderState(container, {
                variant: 'empty',
                title: 'لا يوجد نشاط مسجَّل بعد',
                text: 'ستظهر هنا عملياتك على المنصة أولاً بأول — تسجيل الدخول، التذاكر، وتحديثات حسابك.'
            });
            return;
        }

        container.innerHTML = `
            <div class="activity-timeline">
                ${items.map(item => `
                    <div class="activity-item">
                        <span class="activity-icon">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        </span>
                        <div>
                            <div class="activity-text">${escapeHtml(item.label)}</div>
                            <div class="activity-time">${escapeHtml(timeAgo(item.createdAt))}${item.device ? ` · ${escapeHtml(item.device)}` : ''}</div>
                        </div>
                    </div>`).join('')}
            </div>`;
    }

    /* =========================================================
       قسم: مركز الدعم
    ========================================================= */

    function renderSupportSection() {
        renderSupportAvailability();
        renderSystemStatus();

        const hint = document.getElementById('supportTicketsHint');
        if (hint && !isGuest) {
            const counts = countByView(cachedTickets, user.id);
            hint.textContent = counts.awaiting
                ? `${counts.awaiting} تذكرة بانتظار ردّك`
                : `${counts.open} تذكرة مفتوحة من ${counts.all}`;
        }
    }

    function renderSupportAvailability() {
        const container = document.getElementById('supportAvailabilityBody');
        if (!container) return;

        const { isOnline, todayLabel } = supportAvailability(settings);
        const hours = settings.support?.working_hours || [];
        const rows = [];

        if (cx.show_support_online_status) {
            rows.push({
                label: 'حالة الفريق الآن',
                value: `<span class="pill ${isOnline ? 'status-resolved' : 'status-neutral'}"><span class="pill-dot"></span>${isOnline ? 'متاح الآن' : 'خارج ساعات العمل'}</span>`,
                note: escapeHtml(todayLabel)
            });
        }

        const slaRows = ['high', 'medium', 'low']
            .map(p => ({ p, hours: slaTargetHours(settings, p) }))
            .filter(x => x.hours !== null);

        if (slaRows.length) {
            rows.push({
                label: 'هدف أول رد',
                value: slaRows.map(x =>
                    `<span class="pill priority-${x.p}">${escapeHtml(PRIORITY_LABELS[x.p])}: ${x.hours} س</span>`
                ).join(' ')
            });
        }

        const workingDays = hours.filter(h => h.is_working_day);
        if (hours.length) {
            rows.push({
                label: 'ساعات العمل',
                value: escapeHtml(`${workingDays.length} أيام أسبوعياً`),
                note: escapeHtml(workingDays.length
                    ? workingDays.map(h => `${dayName(h.day_of_week)} ${formatTime(h.start_time)}–${formatTime(h.end_time)}`).join(' · ')
                    : 'لا توجد أيام عمل محددة')
            });
        }

        if (cx.support_whatsapp) {
            rows.push({
                label: 'واتساب الدعم',
                value: `<a class="panel-link" href="https://wa.me/${encodeURIComponent(cx.support_whatsapp)}" target="_blank" rel="noopener noreferrer">تواصل مباشر</a>`
            });
        }

        if (!rows.length) {
            renderState(container, {
                variant: 'empty',
                title: 'لم تُحدَّد ساعات عمل بعد',
                text: 'يمكنك فتح تذكرة في أي وقت وسيصلك الرد فور توفّر الفريق.',
                action: { label: 'فتح تذكرة', act: 'open-create-ticket', variant: 'btn-primary' }
            });
            return;
        }

        container.innerHTML = `<div class="data-rows">${rows.map(dataRow).join('')}</div>`;
    }

    /**
     * حالة النظام من منظور العميل.
     *
     * فرقان مهمّان عن النسخة السابقة:
     *   • الخدمات اللي العميل بيستخدمها بتتقدّم وبتتعلّم كـ"تخصّك"، والعطل
     *     في خدمة مالهوش علاقة بيه ما بياخدش نفس الأولوية.
     *   • كل خدمة متعطّلة ليها زر "إبلاغ الإدارة" — إشارة مش تذكرة.
     */
    function renderSystemStatus() {
        const container = document.getElementById('systemStatusBody');
        if (!container) return;

        const result = snapshot?.systemStatus;
        if (!result?.ok) {
            renderState(container, {
                variant: 'error',
                title: 'تعذّر تحميل حالة النظام',
                text: 'تحقق من اتصالك ثم أعد المحاولة.',
                action: { label: 'إعادة المحاولة', retry: 'support' }
            });
            return;
        }

        const { services, incidents } = result.data;
        if (!services.length) {
            renderState(container, {
                variant: 'empty',
                title: 'لا توجد خدمات مُراقَبة حالياً',
                text: 'سيظهر هنا وضع كل خدمة بمجرد تفعيل المراقبة من فريق الإدارة.'
            });
            return;
        }

        const entitlements = entitlementsFrom(snapshot);
        const mine = impairedForCustomer(result.data, entitlements);
        const ordered = orderForCustomer(services, entitlements);

        const banner = mine.length === 0
            ? `<div class="alert-item alert-item--success">
                   <span class="alert-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></span>
                   <div class="alert-body"><p class="alert-title">لا يوجد عطل يؤثر على خدماتك</p></div>
               </div>`
            : `<div class="alert-item alert-item--warning">
                   <span class="alert-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>
                   <div class="alert-body">
                       <p class="alert-title">${mine.length === 1 ? 'خدمة تستخدمها بها مشكلة حالياً' : `${mine.length} خدمات تستخدمها بها مشكلة حالياً`}</p>
                       <p class="alert-text">${escapeHtml(mine.map(m => m.service.name).join('، '))}</p>
                   </div>
               </div>`;

        const incidentsHtml = incidents.length ? `
            <div class="alert-list" style="margin-top: var(--sp-3);">
                ${incidents.map(inc => `
                    <div class="alert-item alert-item--danger">
                        <span class="alert-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/></svg></span>
                        <div class="alert-body">
                            <p class="alert-title">${escapeHtml(inc.title)}</p>
                            <p class="alert-text">${escapeHtml(inc.description || '')} — بدأ ${escapeHtml(timeAgo(inc.created_at))}${inc.updated_at ? ` · آخر تحديث ${escapeHtml(timeAgo(inc.updated_at))}` : ''}</p>
                        </div>
                    </div>`).join('')}
            </div>` : '';

        const rows = ordered.map(service => {
            const info = serviceStatusInfo(service);
            const incident = incidentForService(service, incidents);
            const impaired = isImpaired(service);
            const notes = [];

            if (impaired && (incident?.created_at || service.status_changed_at)) {
                notes.push(`بدأت ${escapeHtml(timeAgo(incident?.created_at || service.status_changed_at))}`);
            }
            if (service.last_checked) notes.push(`آخر فحص ${escapeHtml(timeAgo(service.last_checked))}`);

            const action = impaired ? renderReportButton(service, incident) : '';

            return dataRow({
                label: service.name,
                value: `<span class="pill status-tone-${info.tone}"><span class="pill-dot"></span>${escapeHtml(info.label)}</span>${action}`,
                note: notes.join(' · ')
            });
        }).join('');

        container.innerHTML = `${banner}${incidentsHtml}<div class="data-rows" style="margin-top: var(--sp-3);">${rows}</div>`;
    }

    /**
     * زر البلاغ. لو العميل بلّغ عن نفس النوبة قبل كده، بيتحوّل لحالة "تم
     * الإبلاغ" معطّلة — القيد الفريد في القاعدة هو الحكم النهائي، وده بس
     * انعكاسه في الواجهة عشان ما يضغطش على زر هيترفض.
     */
    function renderReportButton(service, incident) {
        const key = episodeKeyFor(service, incident);
        const existing = myServiceReports.find(r => r.episode_key === key);

        if (existing) {
            return `<span class="report-done" title="${escapeHtml(`أبلغت ${timeAgo(existing.created_at)}`)}">✓ تم الإبلاغ</span>`;
        }

        return `<button type="button" class="btn btn-ghost btn-sm report-service-btn"
                        data-service="${escapeHtml(service.id)}"
                        data-incident="${incident?.id ? escapeHtml(incident.id) : ''}"
                        data-name="${escapeHtml(service.name)}">إبلاغ الإدارة</button>`;
    }

    /* ---------- تدفّق الإبلاغ ---------- */
    let pendingReport = null;

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.report-service-btn');
        if (!btn) return;

        pendingReport = {
            serviceId: btn.dataset.service,
            incidentId: btn.dataset.incident || null,
            name: btn.dataset.name
        };
        setText('reportServiceName', pendingReport.name);
        document.getElementById('reportServiceModal')?.classList.add('active');
    });

    document.getElementById('reportServiceConfirm')?.addEventListener('click', async () => {
        if (!pendingReport) return;
        const confirmBtn = document.getElementById('reportServiceConfirm');
        confirmBtn.disabled = true;

        const result = await customerData.reportServiceIssue({
            serviceId: pendingReport.serviceId,
            incidentId: pendingReport.incidentId
        });

        confirmBtn.disabled = false;
        document.getElementById('reportServiceModal')?.classList.remove('active');

        if (!result.ok) {
            ui.showToast('تعذّر إرسال البلاغ. حاول مرة أخرى.', 'error');
            return;
        }

        if (result.data.duplicate) {
            ui.showToast('تم إبلاغ فريق الدعم بهذه المشكلة بالفعل.', 'info');
        } else {
            ui.showToast('تم إبلاغ فريق الدعم. شكراً لإبلاغنا.', 'success');
        }

        const refreshed = await customerData.fetchMyServiceReports();
        if (refreshed.ok) myServiceReports = refreshed.data;
        renderSystemStatus();
        pendingReport = null;
    });

    /* =========================================================
       قسم: التذاكر
    ========================================================= */

    let currentTicketId = null;
    let currentView = 'all';
    let ticketSearch = '';
    let ticketSort = 'updated';

    function sortTickets(list) {
        const copy = [...list];
        if (ticketSort === 'created') {
            copy.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        } else if (ticketSort === 'oldest') {
            copy.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        } else {
            copy.sort((a, b) =>
                new Date(b.last_updated_at || b.created_at) - new Date(a.last_updated_at || a.created_at));
        }
        return copy;
    }

    function renderTicketViewTabs() {
        const container = document.getElementById('ticketViewTabs');
        if (!container) return;
        const counts = countByView(cachedTickets, user.id);

        container.innerHTML = TICKET_VIEWS.map(view => `
            <button type="button" class="view-tab" role="tab" data-view="${view.key}"
                    aria-selected="${view.key === currentView}" title="${escapeHtml(view.hint)}">
                ${escapeHtml(view.label)}
                <span class="view-tab-count">${counts[view.key]}</span>
            </button>`).join('');
    }

    function updateTicketLimitHint() {
        const hintEl = document.getElementById('ticketsLimitHint');
        if (!hintEl) return;
        const counts = countByView(cachedTickets, user.id);
        const max = settings.limits?.max_open_tickets;
        const parts = [];
        if (max) parts.push(`لديك ${counts.open} من ${max} تذاكر مفتوحة مسموح بها في نفس الوقت.`);
        if (settings.limits?.ticket_retention_days) {
            parts.push(`تُؤرشف التذاكر تلقائياً بعد ${settings.limits.ticket_retention_days} يوماً.`);
        }
        hintEl.textContent = parts.join(' ');
    }

    function slaFriendlyHint(ticket) {
        if (!ticket?.sla_response_due_at || ticket.first_response_at || statusInfo(ticket.status).closed) return '';
        const diffHours = (new Date(ticket.sla_response_due_at) - Date.now()) / 3600000;
        if (Number.isNaN(diffHours)) return '';
        if (diffHours <= 0) {
            return '<div class="ticket-sla-hint"><span class="pill sla-warn">تأخر الرد — الفريق يتابعها</span></div>';
        }
        let label;
        if (diffHours < 1) label = `خلال ${Math.max(1, Math.round(diffHours * 60))} دقيقة`;
        else if (diffHours < 48) label = `خلال ${Math.round(diffHours)} ساعة`;
        else label = `خلال ${Math.round(diffHours / 24)} يوم`;
        return `<div class="ticket-sla-hint"><span class="pill sla-info">الرد المتوقع ${escapeHtml(label)}</span></div>`;
    }

    function renderTickets() {
        const list = document.getElementById('userTicketsList');
        const countEl = document.getElementById('ticketsResultCount');
        if (!list) return;

        renderTicketViewTabs();
        updateTicketLimitHint();

        if (isGuest) {
            renderState(list, {
                variant: 'empty',
                title: 'سجّل الدخول لعرض تذاكرك',
                text: 'تذاكر الدعم مرتبطة بحسابك. سجّل الدخول للمتابعة.'
            });
            if (countEl) countEl.textContent = '';
            clearTicketPanel();
            return;
        }

        const filtered = sortTickets(
            applyTicketView(cachedTickets, { view: currentView, search: ticketSearch, userId: user.id })
        );

        if (countEl) countEl.textContent = filtered.length ? `${filtered.length} تذكرة` : '';

        if (!filtered.length) {
            const isFiltered = currentView !== 'all' || ticketSearch;
            renderState(list, {
                variant: 'empty',
                title: isFiltered ? 'لا توجد نتائج مطابقة' : 'لا توجد تذاكر حتى الآن',
                text: isFiltered
                    ? 'جرّب مجموعة أخرى أو امسح كلمة البحث.'
                    : 'افتح تذكرة جديدة وسيتواصل معك فريق الدعم في أقرب وقت.',
                action: isFiltered
                    ? { label: 'عرض كل التذاكر', act: 'reset-ticket-filters' }
                    : { label: 'إنشاء تذكرة', act: 'open-create-ticket', variant: 'btn-primary' }
            });
            clearTicketPanel();
            return;
        }

        list.innerHTML = filtered.map(t => `
            <button type="button" class="ticket-card${needsCustomerReply(t, user.id) ? ' needs-reply' : ''}" data-id="${escapeHtml(t.id)}" role="listitem">
                <span class="ticket-card-top">
                    <span class="ticket-num">#${escapeHtml(String(t.ticket_number || '---'))}</span>
                    ${statusBadge(t.status)}
                </span>
                <span class="ticket-title">${escapeHtml(t.title)}</span>
                <span class="ticket-badges-row">
                    ${priorityBadge(t.priority, { onlyHigh: true })}
                    ${categoryBadge(t.category)}
                </span>
                <span class="ticket-footer-row">
                    <span>آخر تحديث ${escapeHtml(timeAgo(t.last_updated_at || t.created_at))}</span>
                    ${needsCustomerReply(t, user.id) ? '<span class="pill status-in-progress">بانتظار ردّك</span>' : ''}
                </span>
                ${slaFriendlyHint(t)}
            </button>`).join('');

        list.querySelectorAll('.ticket-card').forEach(card => {
            card.addEventListener('click', () => openTicket(card.dataset.id));
        });

        const keep = currentTicketId && filtered.find(t => t.id === currentTicketId);
        const target = keep || filtered[0];
        markSelectedCard(target.id);
        currentTicketId = target.id;
        showTicketInPanel(target);
    }

    function markSelectedCard(ticketId) {
        const list = document.getElementById('userTicketsList');
        if (!list) return;
        list.querySelectorAll('.ticket-card').forEach(c => c.classList.remove('selected'));
        list.querySelector(`.ticket-card[data-id="${CSS.escape(ticketId)}"]`)?.classList.add('selected');
    }

    /** يفتح تذكرة بالمعرّف — نقطة الدخول الوحيدة (قائمة، إشعار، رابط مباشر، بحث). */
    function openTicket(ticketId) {
        const ticket = cachedTickets.find(t => t.id === ticketId);
        if (!ticket) {
            ui.showToast('التذكرة غير موجودة أو تمت إزالتها من قائمتك', 'warning');
            return;
        }
        currentTicketId = ticketId;
        markSelectedCard(ticketId);
        document.getElementById('ticketsLayout')?.classList.add('detail-open');
        showTicketInPanel(ticket);
    }

    function clearTicketPanel() {
        currentTicketId = null;
        document.getElementById('ticketsLayout')?.classList.remove('detail-open');
        renderState(document.getElementById('ticketDetailsContent'), {
            variant: 'empty',
            title: 'اختر تذكرة لعرض تفاصيلها',
            text: 'التفاصيل والردود وسجل التذكرة ستظهر هنا.'
        });
    }

    function attachmentPreview(att) {
        const isImage = (att.mime_type || '').startsWith('image/');
        const url = sanitizeUrl(att.file_url);
        if (isImage && url) {
            return `<img src="${url}" alt="${escapeHtml(att.file_name || 'مرفق')}" loading="lazy">`;
        }
        return '<span class="att-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>';
    }

    async function showTicketInPanel(ticket) {
        const panel = document.getElementById('ticketDetailsContent');
        if (!panel) return;

        renderSkeletonLines(panel, 5);

        const actions = availableActions(ticket, { userId: user.id, ratingAllowed: cx.allow_ticket_rating });

        const [attachments, tags, activity, existingRating] = await Promise.all([
            fetchTicketAttachments(ticket.id).catch(() => []),
            fetchTicketTags(ticket.id).catch(() => []),
            fetchTicketActivity(ticket.id).catch(() => []),
            actions.canRate ? fetchTicketRating(ticket.id).catch(() => null) : Promise.resolve(null)
        ]);

        // تجاهُل نتيجة قديمة لو المستخدم بدّل التذكرة أثناء التحميل
        if (currentTicketId !== ticket.id) return;

        // توافق مع تذاكر قديمة كانت تخزّن صورة واحدة في image_url
        const legacyImage = (ticket.image_url && !attachments.some(a => a.file_url === ticket.image_url))
            ? [{ file_url: ticket.image_url, file_name: 'مرفق', mime_type: 'image/*' }]
            : [];
        const allAttachments = [...attachments, ...legacyImage];
        const visibleActivity = (activity || []).filter(a => !CUSTOMER_HIDDEN_ACTIVITY_TYPES.has(a.action_type));

        const slaFacts = [];
        if (ticket.sla_response_due_at) slaFacts.push(`هدف أول رد: ${formatDateTime(ticket.sla_response_due_at)}`);
        if (ticket.first_response_at) slaFacts.push(`أول رد وصل: ${formatDateTime(ticket.first_response_at)}`);

        panel.innerHTML = `
            <div class="ticket-detail-head">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:var(--sp-3); flex-wrap:wrap;">
                    <h2 class="ticket-detail-title">${escapeHtml(ticket.title)}</h2>
                    ${statusBadge(ticket.status)}
                </div>
                ${actions.needsReply ? '<div class="ticket-sla-hint" style="margin-top:var(--sp-2);"><span class="pill status-in-progress">بانتظار ردّك — فريق الدعم ردّ ولم تردّ بعد</span></div>' : ''}
                <div class="ticket-badges-row" style="margin-top:var(--sp-3);">
                    ${priorityBadge(ticket.priority)}
                    ${categoryBadge(ticket.category)}
                    ${(tags || []).map(t => `<span class="tag-chip" style="background:${escapeHtml(t.color)}22;color:${escapeHtml(t.color)}">${escapeHtml(t.name)}</span>`).join('')}
                </div>
                <div class="ticket-detail-meta">
                    <span>رقم التذكرة: <strong>#${escapeHtml(String(ticket.ticket_number || '---'))}</strong></span>
                    <span>أُنشئت ${escapeHtml(formatDate(ticket.created_at))}</span>
                    <span>آخر تحديث ${escapeHtml(timeAgo(ticket.last_updated_at || ticket.created_at))}</span>
                    ${ticket.resolved_at ? `<span>حُلّت ${escapeHtml(formatDate(ticket.resolved_at))}</span>` : ''}
                    ${ticket.reopen_count ? `<span>أُعيد فتحها ${escapeHtml(String(ticket.reopen_count))} مرة</span>` : ''}
                </div>
                ${slaFacts.length ? `<div class="ticket-detail-meta">${slaFacts.map(x => `<span>${escapeHtml(x)}</span>`).join('')}</div>` : ''}
                ${slaFriendlyHint(ticket)}
            </div>

            <div class="detail-section">
                <h3 class="detail-section-title">وصف المشكلة</h3>
                <p class="detail-body">${escapeHtml(ticket.description)}</p>
            </div>

            ${allAttachments.length ? `
            <div class="detail-section">
                <h3 class="detail-section-title">المرفقات (${allAttachments.length})</h3>
                <div class="attachments-grid">
                    ${allAttachments.map(a => `
                        <a class="attachment-item" href="${sanitizeUrl(a.file_url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(a.file_name || '')}">
                            ${attachmentPreview(a)}
                            <span class="att-name">${escapeHtml(a.file_name || 'مرفق')}</span>
                        </a>`).join('')}
                </div>
            </div>` : ''}

            ${actions.canRate ? `
            <div class="detail-section">
                <div class="panel" style="margin:0; padding:var(--sp-4);">
                    <h3 class="detail-section-title" style="margin-bottom:var(--sp-3);">تقييمك للخدمة</h3>
                    <div id="ratingContainer">
                        ${existingRating ? `
                            <div class="rating-submitted">
                                <span style="color:var(--on-warning);">${'★'.repeat(existingRating.rating)}${'☆'.repeat(5 - existingRating.rating)}</span>
                                <span>شكراً لتقييمك</span>
                            </div>
                            ${existingRating.comment ? `<p class="detail-body u-muted" style="margin-top:.5rem; font-size:var(--fs-sm);">${escapeHtml(existingRating.comment)}</p>` : ''}
                        ` : `
                            <div class="star-rating" id="panelStarRating" role="radiogroup" aria-label="تقييم الخدمة من 1 إلى 5">
                                ${[1, 2, 3, 4, 5].map(v => `<button type="button" class="star" data-value="${v}" role="radio" aria-checked="false" aria-label="${v} من 5">★</button>`).join('')}
                            </div>
                            <label class="visually-hidden" for="panelRatingComment">تعليق على التقييم</label>
                            <textarea id="panelRatingComment" class="form-control" rows="2" style="margin-top:var(--sp-3);" placeholder="أضف تعليقاً (اختياري)…"></textarea>
                            <button type="button" id="panelSubmitRating" class="btn btn-primary" style="margin-top:var(--sp-3);" disabled>إرسال التقييم</button>
                        `}
                    </div>
                </div>
            </div>` : ''}

            ${visibleActivity.length ? `
            <div class="detail-section">
                <h3 class="detail-section-title">سجل التذكرة</h3>
                <div class="activity-timeline">
                    ${visibleActivity.slice(0, 10).map(a => `
                        <div class="activity-item">
                            <span class="activity-icon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></span>
                            <div>
                                <div class="activity-text">${escapeHtml(ACTIVITY_LABELS[a.action_type] || a.action_type)}${a.action_type === 'status_change' && a.to_value ? ` — ${escapeHtml(statusInfo(a.to_value).label)}` : ''}</div>
                                <div class="activity-time">${escapeHtml(timeAgo(a.created_at))}</div>
                            </div>
                        </div>`).join('')}
                </div>
            </div>` : ''}

            <div class="detail-section" style="border-top:1px solid var(--color-border); padding-top:var(--sp-5);">
                <h3 class="detail-section-title" style="font-size:var(--fs-base);">المحادثة</h3>
                <div id="panelRepliesList" class="replies-scroll"></div>

                ${actions.canReply ? `
                    ${actions.canReopen ? '<p class="field-hint" style="margin-bottom:var(--sp-2);">التذكرة تم حلّها — إرسال ردّ جديد سيعيد فتحها لفريق الدعم.</p>' : ''}
                    <label class="visually-hidden" for="panelReplyText">اكتب ردك</label>
                    <textarea id="panelReplyText" class="form-control" rows="3" placeholder="اكتب ردك هنا…"></textarea>
                    <button type="button" id="panelSendReply" class="btn btn-primary btn-block" style="margin-top:var(--sp-3);">
                        ${actions.canReopen ? 'إرسال وإعادة فتح التذكرة' : 'إرسال الرد'}
                    </button>
                ` : `
                    <div class="alert-item alert-item--info">
                        <span class="alert-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/></svg></span>
                        <div class="alert-body">
                            <p class="alert-title">هذه التذكرة مغلقة</p>
                            <p class="alert-text">لو لسه محتاج مساعدة في نفس الموضوع، افتح تذكرة جديدة واذكر رقم هذه التذكرة.</p>
                        </div>
                        <button type="button" class="alert-action" data-action="open-create-ticket" style="background:none;border:none;cursor:pointer;font-family:inherit;">تذكرة جديدة</button>
                    </div>
                `}
            </div>

            <div style="display:flex; gap:var(--sp-3); border-top:1px solid var(--color-border); padding-top:var(--sp-5); flex-wrap:wrap;">
                ${cx.support_whatsapp ? `
                <button type="button" id="followUpWhatsApp" class="btn" style="flex:1; min-width:12rem; background:var(--on-whatsapp); color:#fff; border:none;">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0C5.383 0 0 5.383 0 12s5.383 12 12 12 12-5.383 12-12S18.617 0 12 0zm5.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.67-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.076 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/></svg>
                    متابعة على الواتساب
                </button>` : ''}
                <button type="button" id="archiveTicket" class="btn btn-secondary" style="flex:1; min-width:12rem;">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
                    إخفاء من قائمتي
                </button>
            </div>`;

        await loadRepliesInPanel(ticket.id);
        wireRatingWidget(ticket);
        wireTicketActions(ticket, actions);
    }

    function wireRatingWidget(ticket) {
        const starsEl = document.getElementById('panelStarRating');
        const submitBtn = document.getElementById('panelSubmitRating');
        if (!starsEl || !submitBtn) return;

        let selected = 0;
        const stars = Array.from(starsEl.querySelectorAll('.star'));
        const paint = (value) => stars.forEach(s => {
            s.classList.toggle('active', Number(s.dataset.value) <= value);
            s.setAttribute('aria-checked', String(Number(s.dataset.value) === value));
        });

        stars.forEach(star => {
            star.addEventListener('mouseenter', () => paint(Number(star.dataset.value)));
            star.addEventListener('mouseleave', () => paint(selected));
            star.addEventListener('click', () => {
                selected = Number(star.dataset.value);
                paint(selected);
                submitBtn.disabled = false;
            });
        });

        submitBtn.addEventListener('click', async () => {
            if (!selected) return;
            const comment = document.getElementById('panelRatingComment')?.value.trim() || '';
            submitBtn.disabled = true;
            submitBtn.textContent = 'جاري الإرسال…';
            try {
                await submitTicketRating(ticket.id, selected, comment);
                const container = document.getElementById('ratingContainer');
                if (container) {
                    container.innerHTML = `
                        <div class="rating-submitted">
                            <span style="color:var(--on-warning);">${'★'.repeat(selected)}${'☆'.repeat(5 - selected)}</span>
                            <span>شكراً لتقييمك</span>
                        </div>`;
                }
                ui.showToast('تم تسجيل تقييمك، شكراً لك', 'success');
            } catch (err) {
                ui.showToast(`تعذّر إرسال التقييم: ${err.message || 'خطأ غير متوقع'}`, 'error');
                submitBtn.disabled = false;
                submitBtn.textContent = 'إرسال التقييم';
            }
        });
    }

    function wireTicketActions(ticket, actions) {
        document.getElementById('followUpWhatsApp')?.addEventListener('click', () => {
            const summary = [
                `*تفاصيل التذكرة #${ticket.ticket_number}*`, '',
                `*العنوان:* ${ticket.title}`,
                `*الحالة:* ${statusInfo(ticket.status).label}`,
                `*تاريخ الإنشاء:* ${new Date(ticket.created_at).toLocaleDateString('ar-EG')}`, '',
                '*الوصف:*', ticket.description
            ].join('\n');
            window.open(
                `https://wa.me/${encodeURIComponent(cx.support_whatsapp)}?text=${encodeURIComponent(summary)}`,
                '_blank', 'noopener'
            );
        });

        document.getElementById('archiveTicket')?.addEventListener('click', async () => {
            const confirmed = await ui.showConfirm(
                'إخفاء التذكرة من قائمتك؟',
                `التذكرة #${ticket.ticket_number} لن تظهر بعد الآن في قائمتك، لكنها ستبقى محفوظة بالكامل لدى فريق الدعم ويمكنهم متابعتها والرد عليها.`,
                { confirmLabel: 'إخفاء', cancelLabel: 'تراجع', type: 'warning' }
            );
            if (!confirmed) return;

            try {
                await deleteTicket(ticket.id);
                currentTicketId = null;
                await refreshTickets();
                ui.showToast('تم إخفاء التذكرة من قائمتك', 'success');
            } catch (err) {
                console.error('[Tickets] archive:', err);
                ui.showToast(`تعذّر إخفاء التذكرة: ${err.message || 'خطأ غير متوقع'}`, 'error');
            }
        });

        const sendBtn = document.getElementById('panelSendReply');
        const replyInput = document.getElementById('panelReplyText');
        if (!sendBtn || !replyInput) return;

        const send = async () => {
            const message = replyInput.value.trim();
            if (!message) {
                ui.showToast('اكتب نص الرد أولاً', 'warning');
                replyInput.focus();
                return;
            }

            // الردّ على تذكرة محلولة = إعادة فتحها (trigger في migrations/012)
            if (actions.canReopen) {
                const ok = await ui.showConfirm(
                    'إعادة فتح التذكرة؟',
                    'التذكرة تم حلّها. إرسال ردّ جديد سيعيدها لفريق الدعم للمتابعة.',
                    { confirmLabel: 'إرسال وإعادة الفتح', cancelLabel: 'تراجع', type: 'info' }
                );
                if (!ok) return;
            }

            const original = sendBtn.textContent;
            sendBtn.disabled = true;
            sendBtn.textContent = 'جاري الإرسال…';
            try {
                await addTicketReply(ticket.id, message);
                replyInput.value = '';
                if (actions.canReopen) {
                    await refreshTickets();
                    ui.showToast('تم إرسال ردك وإعادة فتح التذكرة', 'success');
                } else {
                    await loadRepliesInPanel(ticket.id);
                    ui.showToast('تم إرسال ردك', 'success');
                }
            } catch (err) {
                ui.showToast(`تعذّر إرسال الرد: ${err.message || 'خطأ غير متوقع'}`, 'error');
            } finally {
                sendBtn.disabled = false;
                sendBtn.textContent = original;
            }
        };

        sendBtn.addEventListener('click', send);
        replyInput.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                send();
            }
        });
    }

    const STAFF_ROLES = new Set(['admin', 'support', 'super_user']);

    async function loadRepliesInPanel(ticketId) {
        const list = document.getElementById('panelRepliesList');
        if (!list) return;

        renderSkeletonLines(list, 2);

        try {
            const replies = await fetchTicketReplies(ticketId);
            if (!replies.length) {
                renderState(list, {
                    variant: 'empty', icon: false,
                    title: 'لا توجد ردود بعد',
                    text: 'سيظهر رد فريق الدعم هنا فور وصوله.'
                });
                return;
            }

            list.innerHTML = replies.map(r => {
                const isStaff = STAFF_ROLES.has(r.profiles?.role);
                return `
                    <div class="reply-item ${isStaff ? 'reply-item--staff' : ''}">
                        <div class="reply-head">
                            <span class="reply-author">${escapeHtml(isStaff ? (r.profiles?.full_name || 'فريق الدعم') : (r.profiles?.full_name || 'أنت'))}${isStaff ? ' <span class="pill status-open">الدعم</span>' : ''}</span>
                            <span class="reply-time">${escapeHtml(formatDateTime(r.created_at))}</span>
                        </div>
                        <p class="reply-text">${escapeHtml(r.message)}</p>
                    </div>`;
            }).join('');
            list.scrollTop = list.scrollHeight;
        } catch (err) {
            console.error('[Tickets] replies:', err);
            renderState(list, { variant: 'error', icon: false, title: 'تعذّر تحميل الردود' });
        }
    }

    /** يعيد تحميل التذاكر ويحدّث كل ما يعتمد عليها. */
    async function refreshTickets() {
        try {
            cachedTickets = await fetchUserTickets({});
        } catch (err) {
            console.error('[Tickets] refresh:', err);
            return;
        }
        if (snapshot) snapshot.tickets = cachedTickets;
        renderTickets();
        setSidebarBadge('tickets', countByView(cachedTickets, user.id).awaiting);
        if (currentSection === 'overview') {
            renderAccountHealth();
            renderOverviewKpis();
        }
        if (currentSection === 'support') renderSupportSection();
    }

    /* =========================================================
       قسم: الإشعارات (قابلة للتنفيذ)
    ========================================================= */

    let notificationFilter = 'all';
    let cachedNotifications = [];

    async function refreshNotificationBadge() {
        if (isGuest) return;
        const result = await customerData.fetchUnreadNotificationsCount();
        if (result.ok) {
            setSidebarBadge('notifications', result.data);
            const kpis = document.getElementById('overviewKpis');
            if (kpis) {
                kpis.dataset.unread = String(result.data);
                if (currentSection === 'overview' && snapshot) renderOverviewKpis();
            }
        }
    }

    function renderNotificationFilters() {
        const container = document.getElementById('notificationFilters');
        if (!container) return;

        const unreadCount = cachedNotifications.filter(n => !n.is_read).length;
        const chips = [
            { key: 'all', label: 'الكل', count: cachedNotifications.length },
            { key: 'unread', label: 'غير المقروءة', count: unreadCount },
            ...categoriesPresentIn(cachedNotifications).map(key => ({
                key,
                label: NOTIFICATION_CATEGORIES[key].label,
                count: cachedNotifications.filter(n => (n.category || 'system') === key).length
            }))
        ];

        container.innerHTML = chips.map(chip => `
            <button type="button" class="filter-chip" data-filter="${escapeHtml(chip.key)}"
                    aria-pressed="${chip.key === notificationFilter}">
                ${escapeHtml(chip.label)}
                <span class="filter-chip-count">${chip.count}</span>
            </button>`).join('');
    }

    function filterNotifications() {
        if (notificationFilter === 'all') return cachedNotifications;
        if (notificationFilter === 'unread') return cachedNotifications.filter(n => !n.is_read);
        return cachedNotifications.filter(n => (n.category || 'system') === notificationFilter);
    }

    async function renderNotifications() {
        const container = document.getElementById('notificationsList');
        if (!container) return;

        renderSkeletonLines(container, 4);

        try {
            cachedNotifications = await fetchNotifications();
        } catch (err) {
            console.error('[Notifications] render:', err);
            renderState(container, {
                variant: 'error',
                title: 'تعذّر تحميل الإشعارات',
                text: 'تحقق من اتصالك ثم أعد المحاولة.',
                action: { label: 'إعادة المحاولة', retry: 'notifications' }
            });
            return;
        }

        renderNotificationFilters();
        const items = filterNotifications();

        if (!items.length) {
            renderState(container, {
                variant: 'empty',
                title: notificationFilter === 'all' ? 'لا توجد إشعارات بعد' : 'لا توجد إشعارات في هذا التصنيف',
                text: notificationFilter === 'all'
                    ? 'ستصلك هنا تحديثات تذاكرك واشتراكاتك وأي إجراء يخص حسابك.'
                    : 'جرّب تصنيفاً آخر أو اعرض الكل.',
                action: notificationFilter === 'all' ? null : { label: 'عرض الكل', act: 'reset-notification-filter' }
            });
            return;
        }

        container.innerHTML = items.map(n => {
            const { meta, destination } = resolveNotification(n);
            // كل إشعار يفتح تفاصيله — حتى اللي مالوش وجهة، عشان يقرأ نصه كاملاً
            // وتاريخه. اللي له وجهة بس هو اللي بيعرض تلميح الإجراء، ونافذته
            // وحدها هي اللي فيها زر انتقال.
            const cta = destination.kind !== 'none' ? destinationLabel(destination) : '';
            return `
                <div class="notif-item is-actionable ${n.is_read ? '' : 'is-unread'}"
                     data-id="${escapeHtml(String(n.id))}" role="button" tabindex="0">
                    <span class="notif-icon notif-icon--${meta.tone}">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${meta.icon}</svg>
                    </span>
                    <span class="notif-body">
                        <span class="notif-head">
                            <span class="notif-title">${escapeHtml(n.title)}</span>
                            ${n.is_read ? '' : '<span class="pill status-open">جديد</span>'}
                        </span>
                        <span class="notif-text">${escapeHtml(n.message)}</span>
                        <span class="notif-meta">
                            <span>${escapeHtml(meta.label)}</span>
                            <span>${escapeHtml(formatRelativeArabic(n.created_at))}</span>
                            ${cta ? `<span class="notif-cta">${escapeHtml(cta)} ←</span>` : ''}
                        </span>
                    </span>
                    <span class="notif-actions">
                        <button type="button" class="notif-mark" data-mark="${escapeHtml(String(n.id))}"${n.is_read ? ' disabled' : ''}>
                            ${n.is_read ? 'مقروء' : 'تحديد كمقروء'}
                        </button>
                    </span>
                </div>`;
        }).join('');
    }

    /**
     * الضغط على إشعار = فتح تفاصيله، مش الانتقال لوجهته.
     *
     * السلوك القديم كان بينقل العميل فورًا (أو يرجّعه للنظرة العامة لو الوجهة
     * مش واضحة)، فيفقد مكانه من غير ما يعرف الإشعار بيقول إيه أصلاً.
     * دلوقتي: تحديد كمقروء ← نافذة تفاصيل ← زر صريح ينقل. لو مفيش وجهة
     * حقيقية، مفيش زر — بدل زر وهمي.
     */
    let activeNotificationDestination = null;

    async function activateNotification(notification) {
        const { meta, destination } = resolveNotification(notification);

        if (!notification.is_read) {
            await markAsRead(notification.id).catch(err => console.error('[Notifications] markAsRead:', err));
            notification.is_read = true;
            refreshNotificationBadge();
            document.dispatchEvent(new CustomEvent('customer:notifications-read'));
            if (currentSection === 'notifications') renderNotifications();
        }

        openNotificationModal(notification, meta, destination);
    }

    /** شدّة الإشعار كما يفهمها العميل (notifications.type). */
    const SEVERITY_LABELS = {
        error: 'عاجل', warning: 'يحتاج انتباهك', success: 'تم بنجاح', info: 'للعلم'
    };

    function openNotificationModal(notification, meta, destination) {
        const modal = document.getElementById('notificationModal');
        if (!modal) return;

        activeNotificationDestination = destination;

        const iconEl = document.getElementById('notificationModalIcon');
        if (iconEl) {
            iconEl.className = `notif-icon notif-icon--${meta.tone}`;
            iconEl.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${meta.icon}</svg>`;
        }

        setText('notificationModalTitle', notification.title);
        setText('notificationModalCategory', meta.label);
        setText('notificationModalMessage', notification.message);
        setText('notificationModalTime', formatFullDateTime(notification.created_at));
        setText('notificationModalRead', notification.is_read ? 'مقروء' : 'غير مقروء');

        const severity = SEVERITY_LABELS[notification.type];
        const severityRow = document.getElementById('notificationModalSeverityRow');
        if (severityRow) severityRow.hidden = !severity;
        if (severity) setText('notificationModalSeverity', severity);

        const actionBtn = document.getElementById('notificationModalAction');
        if (actionBtn) {
            const label = actionLabelFor(notification, destination);
            actionBtn.hidden = !label;
            if (label) actionBtn.textContent = label;
        }

        modal.classList.add('active');
        modal.querySelector('.modal-close')?.focus({ preventScroll: true });
    }

    function formatFullDateTime(value) {
        if (!value) return '—';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '—';
        return date.toLocaleString('ar-EG', {
            year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
    }

    /** زر الإجراء داخل النافذة هو الوحيد اللي بينقل العميل. */
    document.getElementById('notificationModalAction')?.addEventListener('click', async () => {
        const destination = activeNotificationDestination;
        document.getElementById('notificationModal')?.classList.remove('active');
        if (!destination) return;

        switch (destination.kind) {
            case 'ticket':
                showSection('tickets');
                // التذكرة قد تكون خارج القائمة المحمّلة (مؤرشفة مثلاً)
                if (!cachedTickets.find(t => t.id === destination.ticketId)) await refreshTickets();
                openTicket(destination.ticketId);
                break;
            case 'section':
                showSection(destination.section);
                break;
            case 'url':
                window.location.href = destination.href;
                break;
        }
    });

    document.getElementById('notificationFilters')?.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-filter]');
        if (!chip) return;
        notificationFilter = chip.dataset.filter;
        renderNotifications();
    });

    document.getElementById('notificationsList')?.addEventListener('click', async (e) => {
        const markBtn = e.target.closest('[data-mark]');
        if (markBtn) {
            e.stopPropagation();
            const id = markBtn.dataset.mark;
            const notification = cachedNotifications.find(n => String(n.id) === String(id));
            if (notification && !notification.is_read) {
                await markAsRead(id).catch(err => console.error('[Notifications] markAsRead:', err));
                notification.is_read = true;
                refreshNotificationBadge();
                renderNotifications();
            }
            return;
        }

        const item = e.target.closest('.notif-item.is-actionable');
        if (!item) return;
        const notification = cachedNotifications.find(n => String(n.id) === String(item.dataset.id));
        if (notification) activateNotification(notification);
    });

    document.getElementById('notificationsList')?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const item = e.target.closest('.notif-item.is-actionable');
        if (!item) return;
        e.preventDefault();
        const notification = cachedNotifications.find(n => String(n.id) === String(item.dataset.id));
        if (notification) activateNotification(notification);
    });

    document.getElementById('markAllNotificationsBtn')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
            await markAllAsRead();
            await Promise.all([renderNotifications(), refreshNotificationBadge()]);
            ui.showToast('تم تحديد كل الإشعارات كمقروءة', 'success');
        } catch {
            ui.showToast('تعذّر تحديث الإشعارات', 'error');
        } finally {
            btn.disabled = false;
        }
    });

    /* =========================================================
       قسم: الاستهلاك والاشتراك
    ========================================================= */

    async function renderUsageSection() {
        const container = document.getElementById('usageBody');
        if (!container) return;
        if (!snapshot) await loadSnapshot();

        const blocks = [];

        const plans = snapshot.planSubs?.ok ? snapshot.planSubs.data : [];
        const activePlans = plans.filter(p => p.status === 'active' && (!p.end_date || new Date(p.end_date) > new Date()));
        blocks.push(`
            <section class="panel">
                <div class="panel-header">
                    <div>
                        <h2 class="panel-title">الباقة الحالية</h2>
                        <p class="panel-subtitle">الباقات المفعّلة على حسابك ومدتها</p>
                    </div>
                </div>
                ${activePlans.length ? `<div class="data-rows">${activePlans.map(p => dataRow({
                    label: p.subscription_plans?.name_ar || p.subscription_plans?.name || 'باقة',
                    value: '<span class="pill status-resolved"><span class="pill-dot"></span>فعّالة</span>',
                    note: escapeHtml([
                        p.start_date ? `من ${formatDate(p.start_date)}` : '',
                        p.end_date ? `حتى ${formatDate(p.end_date)}` : 'بدون تاريخ انتهاء'
                    ].filter(Boolean).join(' · '))
                })).join('')}</div>` : `
                    <div class="state-block state-block--compact">
                        <p class="state-title">لا توجد باقة مفعّلة</p>
                        <p class="state-text">تصفّح الباقات المتاحة واختر ما يناسب استخدامك.</p>
                        <a class="btn btn-primary" href="/customer-subscriptions.html">تصفّح الباقات</a>
                    </div>`}
            </section>`);

        const wa = snapshot.waSub?.ok ? snapshot.waSub.data : null;
        const wallet = snapshot.wallet?.ok ? snapshot.wallet.data : null;
        if (wa?.hasActiveSubscription || wallet) {
            const rows = [];
            if (wa?.hasActiveSubscription) {
                rows.push(dataRow({
                    label: 'اشتراك الواتساب',
                    value: '<span class="pill status-resolved"><span class="pill-dot"></span>فعّال</span>',
                    note: escapeHtml(`متبقٍ ${wa.daysRemaining} يوم — حتى ${formatDate(wa.activeSubscription?.end_date)}`)
                }));
            }
            if (wallet) {
                const threshold = Number(wallet.low_balance_threshold) || 0;
                const percent = threshold > 0 ? Math.min(100, (wallet.balance / (threshold * 4)) * 100) : 100;
                rows.push(dataRow({
                    label: 'رصيد الواتساب',
                    value: escapeHtml(`${wallet.balance.toLocaleString('ar-EG')} ${wallet.currency || ''}`),
                    note: `${meter(percent, wallet.isLow ? 'meter-fill--danger' : '')}<span>${escapeHtml(wallet.isLow
                                ? `الرصيد تحت الحد الأدنى (${threshold}) — تواصل مع الدعم للشحن.`
                                : `الحد الأدنى للتنبيه: ${threshold}`)}</span>`
                }));
                for (const tx of (wallet.transactions || []).slice(0, 5)) {
                    rows.push(dataRow({
                        label: tx.description || (Number(tx.amount) >= 0 ? 'إضافة رصيد' : 'خصم'),
                        value: escapeHtml(`${Number(tx.amount) >= 0 ? '+' : ''}${tx.amount}`),
                        note: escapeHtml(timeAgo(tx.created_at))
                    }));
                }
            }
            blocks.push(`
                <section class="panel">
                    <div class="panel-header">
                        <div>
                            <h2 class="panel-title">خدمة الواتساب</h2>
                            <p class="panel-subtitle">حالة الاشتراك والرصيد وآخر الحركات</p>
                        </div>
                    </div>
                    <div class="data-rows">${rows.join('')}</div>
                </section>`);
        }

        const sie = snapshot.sie?.ok ? snapshot.sie.data : null;
        if (sie?.is_enabled) {
            const tone = sie.usedPercent >= 90 ? 'meter-fill--danger' : sie.usedPercent >= 70 ? 'meter-fill--warning' : '';
            blocks.push(`
                <section class="panel">
                    <div class="panel-header">
                        <div>
                            <h2 class="panel-title">المحرك الذكي</h2>
                            <p class="panel-subtitle">حصتك من الرسائل ومدى استهلاكها</p>
                        </div>
                    </div>
                    <div class="usage-card">
                        <div class="usage-row">
                            <span class="usage-value">${sie.quota > 0 ? escapeHtml(`${sie.used} / ${sie.quota}`) : 'بدون حد'}</span>
                            <span class="usage-caption">${sie.remaining !== null ? escapeHtml(`متبقٍ ${sie.remaining} رسالة`) : 'استخدام غير محدود'}</span>
                        </div>
                        ${sie.quota > 0 ? meter(sie.usedPercent, tone) : ''}
                        <div class="data-rows">
                            ${dataRow({ label: 'وضع الوصول', value: escapeHtml(sie.access_mode || '—') })}
                            ${sie.expires_at ? dataRow({
                                label: 'تاريخ الانتهاء',
                                value: escapeHtml(formatDate(sie.expires_at)),
                                note: sie.isExpired ? '<span class="pill status-rejected">منتهٍ</span>' : ''
                            }) : ''}
                            ${sie.last_used_at ? dataRow({ label: 'آخر استخدام', value: escapeHtml(timeAgo(sie.last_used_at)) }) : ''}
                        </div>
                    </div>
                </section>`);
        }

        const domains = snapshot.subdomains?.ok ? snapshot.subdomains.data : [];
        if (domains.length) {
            blocks.push(`
                <section class="panel">
                    <div class="panel-header">
                        <div>
                            <h2 class="panel-title">النطاقات الفرعية</h2>
                            <p class="panel-subtitle">النطاقات المرتبطة بحسابك وحالتها</p>
                        </div>
                    </div>
                    <div class="data-rows">${domains.map(d => dataRow({
                        label: d.full_domain || d.subdomain,
                        value: `<span class="pill ${d.status === 'active' ? 'status-resolved' : d.status === 'pending' ? 'status-in-progress' : 'status-neutral'}">${escapeHtml(d.status)}</span>`,
                        note: escapeHtml(d.status === 'active'
                            ? `مفعّل منذ ${formatDate(d.activated_at || d.created_at)}`
                            : `طُلب في ${formatDate(d.created_at)}`)
                    })).join('')}</div>
                </section>`);
        }

        container.innerHTML = blocks.join('');
    }

    /* =========================================================
       قسم: نشاط الحساب
    ========================================================= */

    async function renderActivitySection() {
        const container = document.getElementById('activityBody');
        if (!container) return;
        renderSkeletonLines(container, 6);
        const result = await customerData.fetchAccountActivity(60);
        renderActivityTimeline(result, 'activityBody', 60);
    }

    /* =========================================================
       قسم: الأمان
    ========================================================= */

    async function renderSecuritySection() {
        const container = document.getElementById('securityBody');
        if (!container) return;
        renderSkeletonLines(container, 5);

        const [accountRes, tokensRes, activityRes] = await Promise.all([
            snapshot?.account ? Promise.resolve(snapshot.account) : customerData.fetchAccountStatus(),
            customerData.fetchApiTokens(),
            customerData.fetchAccountActivity(40)
        ]);

        if (!accountRes.ok) {
            renderState(container, {
                variant: 'error',
                title: 'تعذّر تحميل بيانات الأمان',
                text: 'تحقق من اتصالك ثم أعد المحاولة.',
                action: { label: 'إعادة المحاولة', retry: 'security' }
            });
            return;
        }

        const p = accountRes.data || {};
        const protections = [
            dataRow({
                label: 'التحقق بخطوتين (2FA)',
                value: p.two_factor_enabled
                    ? '<span class="pill status-resolved"><span class="pill-dot"></span>مفعّل</span>'
                    : '<span class="pill status-neutral"><span class="pill-dot"></span>غير مفعّل</span>',
                note: p.two_factor_enabled ? '' : 'تفعيله يحمي حسابك حتى لو تسرّبت كلمة المرور.'
            }),
            dataRow({
                label: 'تنبيهات تيليجرام',
                value: p.telegram_otp_enabled
                    ? '<span class="pill status-resolved"><span class="pill-dot"></span>مفعّلة</span>'
                    : '<span class="pill status-neutral">غير مفعّلة</span>',
                note: p.telegram_username ? escapeHtml(`الحساب المرتبط: ${p.telegram_username}`) : ''
            }),
            dataRow({
                label: 'آخر تغيير لكلمة المرور',
                value: escapeHtml(p.last_password_change ? formatDate(p.last_password_change) : 'غير مسجَّل')
            }),
            dataRow({
                label: 'حالة التوثيق',
                value: p.is_verified
                    ? '<span class="pill status-resolved"><span class="pill-dot"></span>موثّق</span>'
                    : '<span class="pill status-neutral">غير موثّق</span>'
            })
        ].join('');

        // سجل الدخول من نفس allow-list سجل النشاط — فمفيش أحداث إدارية
        const loginEvents = toTimeline((activityRes.ok ? activityRes.data : []) || [], { limit: 40 })
            .filter(item => item.group === 'security')
            .slice(0, 8);

        const tokens = tokensRes.ok ? (tokensRes.data || []) : [];
        const activeTokens = tokens.filter(t => t.is_active && !t.revoked_at);

        container.innerHTML = `
            <div class="split-grid">
                <section class="panel">
                    <div class="panel-header">
                        <div>
                            <h2 class="panel-title">حماية الحساب</h2>
                            <p class="panel-subtitle">وسائل الحماية المفعّلة حالياً</p>
                        </div>
                        <a class="panel-link" href="/customer-security-settings.html">تعديل</a>
                    </div>
                    <div class="data-rows">${protections}</div>
                </section>

                <section class="panel">
                    <div class="panel-header">
                        <div>
                            <h2 class="panel-title">آخر عمليات الدخول</h2>
                            <p class="panel-subtitle">لو فيه دخول مش أنت، غيّر كلمة المرور فوراً</p>
                        </div>
                    </div>
                    ${loginEvents.length ? `
                        <div class="activity-timeline">
                            ${loginEvents.map(item => `
                                <div class="activity-item">
                                    <span class="activity-icon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></span>
                                    <div>
                                        <div class="activity-text">${escapeHtml(item.label)}</div>
                                        <div class="activity-time">${escapeHtml(timeAgo(item.createdAt))}${item.device ? ` · ${escapeHtml(item.device)}` : ''}</div>
                                    </div>
                                </div>`).join('')}
                        </div>` : `
                        <div class="state-block state-block--compact">
                            <p class="state-title">لا يوجد سجل دخول محفوظ</p>
                            <p class="state-text">ستظهر هنا عمليات الدخول إلى حسابك.</p>
                        </div>`}
                </section>
            </div>

            <section class="panel">
                <div class="panel-header">
                    <div>
                        <h2 class="panel-title">مفاتيح API</h2>
                        <p class="panel-subtitle">المفاتيح المرتبطة بحسابك — لا يُعرض السر أبداً، فقط آخر 4 خانات</p>
                    </div>
                </div>
                ${activeTokens.length ? `<div class="data-rows">${activeTokens.map(t => dataRow({
                    label: t.name || 'مفتاح API',
                    value: `<span class="pill status-resolved">••••${escapeHtml(t.secret_last_four || '')}</span>`,
                    note: escapeHtml([
                        `أُنشئ ${formatDate(t.created_at)}`,
                        t.last_used_at ? `آخر استخدام ${timeAgo(t.last_used_at)}` : 'لم يُستخدم بعد',
                        t.usage_count ? `${t.usage_count} نداء` : ''
                    ].filter(Boolean).join(' · '))
                })).join('')}</div>` : `
                    <div class="state-block state-block--compact">
                        <p class="state-title">لا توجد مفاتيح API على حسابك</p>
                        <p class="state-text">مفاتيح API تُصدر من فريق الإدارة عند الحاجة لربط أنظمتك بالمنصة.</p>
                    </div>`}
            </section>`;
    }

    /* =========================================================
       قسم: الشارات
    ========================================================= */

    async function renderBadges() {
        const grid = document.getElementById('badgesGrid');
        const summaryEl = document.getElementById('badgesProgressSummary');
        if (!grid) return;

        if (isGuest) {
            renderState(grid, { variant: 'empty', title: 'سجّل الدخول لجمع الشارات', text: 'الشارات تُمنح تلقائياً مع استخدامك للمنصة.' });
            return;
        }

        grid.innerHTML = '<div class="skeleton skeleton-card"></div>'.repeat(6);
        const { supabase } = await import('./api-config.js');

        try {
            await supabase.rpc('evaluate_customer_badges', { p_user_id: user.id });
        } catch (err) {
            console.warn('[Badges] evaluate skipped:', err?.message || err);
        }

        try {
            const [{ data: definitions, error: defError }, { data: earned, error: earnedError }] = await Promise.all([
                supabase.from('badge_definitions')
                    .select('id, key, name, description, icon, sort_order')
                    .eq('is_active', true)
                    .order('sort_order', { ascending: true }),
                supabase.from('customer_badges')
                    .select('badge_id, earned_at')
                    .eq('user_id', user.id)
            ]);
            if (defError) throw defError;
            if (earnedError) throw earnedError;

            const earnedMap = new Map((earned || []).map(e => [e.badge_id, e.earned_at]));

            if (!definitions?.length) {
                renderState(grid, { variant: 'empty', title: 'لا توجد شارات متاحة حالياً' });
                if (summaryEl) summaryEl.textContent = '';
                return;
            }

            if (summaryEl) summaryEl.textContent = `حصلت على ${earnedMap.size} من ${definitions.length} شارة`;

            grid.innerHTML = definitions.map(badge => {
                const earnedAt = earnedMap.get(badge.id);
                return `
                    <div class="badge-card ${earnedAt ? 'earned' : 'locked'}" title="${earnedAt ? 'شارة مكتسبة' : 'لم تحصل عليها بعد'}">
                        ${!earnedAt ? '<span class="badge-locked-tag">🔒</span>' : ''}
                        <div class="badge-icon">${escapeHtml(badge.icon || '🏆')}</div>
                        <h3>${escapeHtml(badge.name)}</h3>
                        <p>${escapeHtml(badge.description || '')}</p>
                        ${earnedAt ? `<div class="badge-earned-date">✓ ${escapeHtml(formatDate(earnedAt))}</div>` : ''}
                    </div>`;
            }).join('');
        } catch (err) {
            console.error('[Badges] load:', err);
            renderState(grid, {
                variant: 'error',
                title: 'تعذّر تحميل الشارات',
                text: 'تحقق من اتصالك ثم أعد المحاولة.',
                action: { label: 'إعادة المحاولة', retry: 'badges' }
            });
        }
    }

    /* =========================================================
       قسم: الملف الشخصي
    ========================================================= */

    let profileBaseline = { full_name: '', phone: '', bio: '' };

    async function renderProfileSection() {
        const result = snapshot?.account?.ok ? snapshot.account : await customerData.fetchAccountStatus();
        if (!result.ok) return;

        const profile = result.data || {};
        profileBaseline = {
            full_name: profile.full_name || '',
            phone: profile.phone || '',
            bio: profile.bio || ''
        };

        const nameInput = document.getElementById('profileFullName');
        const phoneInput = document.getElementById('profilePhone');
        const emailInput = document.getElementById('profileEmail');
        const bioInput = document.getElementById('profileBio');
        if (nameInput) nameInput.value = profileBaseline.full_name;
        if (phoneInput) phoneInput.value = profileBaseline.phone;
        if (bioInput) bioInput.value = profileBaseline.bio;
        if (emailInput) emailInput.value = profile.email || user.email || '';
    }

    document.getElementById('profileForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (isGuest) return;

        const nameInput = document.getElementById('profileFullName');
        const phoneInput = document.getElementById('profilePhone');
        const bioInput = document.getElementById('profileBio');
        const saveBtn = document.getElementById('profileSaveBtn');

        const fullName = nameInput.value.trim();
        const phone = phoneInput.value.trim();
        const bio = bioInput ? bioInput.value.trim() : profileBaseline.bio;

        clearFieldError('profileFullName');
        clearFieldError('profilePhone');

        if (fullName.length < 3) {
            showFieldError('profileFullName', 'الاسم يجب أن يكون 3 أحرف على الأقل');
            return;
        }
        if (phone && !/^[\d+\-\s()]{7,20}$/.test(phone)) {
            showFieldError('profilePhone', 'أدخل رقم هاتف صحيح');
            return;
        }
        if (fullName === profileBaseline.full_name && phone === profileBaseline.phone && bio === profileBaseline.bio) {
            ui.showToast('لا توجد تغييرات لحفظها', 'info');
            return;
        }

        saveBtn.disabled = true;
        saveBtn.textContent = 'جاري الحفظ…';
        try {
            const { error } = await updateProfile({ full_name: fullName, phone: phone || null, bio });
            if (error) throw new Error(error.message);

            profileBaseline = { full_name: fullName, phone, bio };
            if (user.profile) user.profile.full_name = fullName;
            updateSidebarUserInfo();
            const heading = document.getElementById('overviewHeading');
            if (heading) heading.textContent = `مرحباً، ${fullName}`;
            ui.showToast('تم حفظ بياناتك', 'success');
        } catch (err) {
            console.error('[Profile] update:', err);
            ui.showToast(`تعذّر حفظ البيانات: ${err.message || 'خطأ غير متوقع'}`, 'error');
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = 'حفظ التغييرات';
        }
    });

    document.getElementById('profileResetBtn')?.addEventListener('click', () => {
        document.getElementById('profileFullName').value = profileBaseline.full_name;
        document.getElementById('profilePhone').value = profileBaseline.phone;
        const bioInput = document.getElementById('profileBio');
        if (bioInput) bioInput.value = profileBaseline.bio;
        clearFieldError('profileFullName');
        clearFieldError('profilePhone');
    });

    document.getElementById('changePasswordForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (isGuest) return;

        const newPassword = document.getElementById('newPassword').value;
        const confirmPassword = document.getElementById('confirmPassword').value;
        const saveBtn = document.getElementById('passwordSaveBtn');

        clearFieldError('newPassword');
        clearFieldError('confirmPassword');

        if (newPassword.length < 8) {
            showFieldError('newPassword', 'كلمة المرور يجب أن تكون 8 أحرف على الأقل');
            return;
        }
        if (!/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
            showFieldError('newPassword', 'يجب أن تحتوي كلمة المرور على حرف ورقم على الأقل');
            return;
        }
        if (newPassword !== confirmPassword) {
            showFieldError('confirmPassword', 'كلمتا المرور غير متطابقتين');
            return;
        }

        const confirmed = await ui.showConfirm(
            'تحديث كلمة المرور؟',
            'سيتم تغيير كلمة مرور حسابك. استخدم كلمة المرور الجديدة في تسجيل الدخول القادم.',
            { confirmLabel: 'تحديث', cancelLabel: 'تراجع', type: 'warning' }
        );
        if (!confirmed) return;

        saveBtn.disabled = true;
        saveBtn.textContent = 'جاري التحديث…';
        try {
            const { error } = await updatePassword(newPassword);
            if (error) throw new Error(error.message);
            document.getElementById('changePasswordForm').reset();
            ui.showToast('تم تحديث كلمة المرور بنجاح', 'success');
        } catch (err) {
            console.error('[Profile] password:', err);
            ui.showToast(`تعذّر تحديث كلمة المرور: ${err.message || 'خطأ غير متوقع'}`, 'error');
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = 'تحديث كلمة المرور';
        }
    });

    /* =========================================================
       إنشاء تذكرة + مساعدة استباقية
    ========================================================= */

    const createTicketModal = document.getElementById('createTicketModal');
    const createTicketForm = document.getElementById('userCreateTicketForm');
    let pendingAttachments = [];

    function showFieldError(fieldId, message) {
        const errorEl = document.getElementById(`${fieldId}Error`);
        const field = document.getElementById(fieldId);
        if (errorEl) {
            errorEl.textContent = message;
            errorEl.classList.remove('u-hidden');
        }
        if (field) field.setAttribute('aria-invalid', 'true');
    }

    function clearFieldError(fieldId) {
        const errorEl = document.getElementById(`${fieldId}Error`);
        const field = document.getElementById(fieldId);
        if (errorEl) {
            errorEl.textContent = '';
            errorEl.classList.add('u-hidden');
        }
        if (field) field.removeAttribute('aria-invalid');
    }

    /**
     * مساعدة استباقية قبل الإرسال — مبنية على بيانات حقيقية فقط:
     * عُطل معلن حالياً، أو تذكرة مفتوحة عند العميل بنفس الموضوع.
     * الهدف تقليل التذاكر المكررة، مش إظهار اقتراحات مخترعة.
     */
    function renderSelfHelp() {
        const box = document.getElementById('createTicketSelfHelp');
        if (!box) return;

        const suggestions = [];
        const status = snapshot?.systemStatus?.ok ? snapshot.systemStatus.data : null;

        for (const incident of (status?.incidents || []).slice(0, 2)) {
            suggestions.push({
                tone: 'warning',
                title: 'يوجد عُطل معلن حالياً',
                text: `${incident.title} — لو مشكلتك متعلقة به، الفريق يعمل عليها بالفعل.`
            });
        }
        if (!status?.incidents?.length && status?.degraded?.length) {
            suggestions.push({
                tone: 'info',
                title: `${status.degraded.length} خدمة بأداء منخفض حالياً`,
                text: status.degraded.map(s => s.name).join('، ')
            });
        }

        const title = (document.getElementById('userTicketTitle')?.value || '').trim().toLowerCase();
        if (title.length >= 4) {
            const related = cachedTickets
                .filter(t => !statusInfo(t.status).closed && (t.title || '').toLowerCase().includes(title))
                .slice(0, 2);
            for (const t of related) {
                suggestions.push({
                    tone: 'info',
                    title: `لديك تذكرة مفتوحة مشابهة: #${t.ticket_number}`,
                    text: `${t.title} — المتابعة عليها أسرع من فتح تذكرة جديدة.`,
                    ticketId: t.id
                });
            }
        }

        if (!suggestions.length) {
            box.classList.add('u-hidden');
            box.innerHTML = '';
            return;
        }

        box.classList.remove('u-hidden');
        box.innerHTML = suggestions.map(s => `
            <div class="alert-item alert-item--${s.tone}">
                <span class="alert-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></span>
                <div class="alert-body">
                    <p class="alert-title">${escapeHtml(s.title)}</p>
                    <p class="alert-text">${escapeHtml(s.text)}</p>
                </div>
                ${s.ticketId ? `<button type="button" class="alert-action" data-open-ticket="${escapeHtml(s.ticketId)}" style="background:none;border:none;cursor:pointer;font-family:inherit;">افتح التذكرة</button>` : ''}
            </div>`).join('');
    }

    function openCreateTicketModal() {
        if (isGuest) {
            ui.showToast('سجّل الدخول أولاً لإنشاء تذكرة', 'info');
            return;
        }
        if (!createTicketModal) return;

        const attachField = document.getElementById('ticketAttachmentsField');
        if (attachField) attachField.hidden = !cx.allow_ticket_attachments;

        const max = settings.limits?.max_open_tickets;
        const openCount = countByView(cachedTickets, user.id).open;
        const notice = document.getElementById('createTicketBlockedNotice');
        const submitBtn = document.getElementById('submitTicketBtn');
        const atLimit = !!max && openCount >= max;

        if (notice && submitBtn) {
            if (atLimit) {
                notice.classList.remove('u-hidden');
                notice.innerHTML = `
                    <div class="alert-item alert-item--warning">
                        <span class="alert-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/><circle cx="12" cy="12" r="10"/></svg></span>
                        <div class="alert-body">
                            <p class="alert-title">وصلت للحد الأقصى للتذاكر المفتوحة</p>
                            <p class="alert-text">لديك ${openCount} تذاكر مفتوحة والحد المسموح ${max}. تابع تذكرة قائمة أو انتظر حلّها قبل فتح تذكرة جديدة.</p>
                        </div>
                    </div>`;
                submitBtn.disabled = true;
            } else {
                notice.classList.add('u-hidden');
                notice.innerHTML = '';
                submitBtn.disabled = false;
            }
        }

        renderSelfHelp();
        createTicketModal.classList.add('active');
        document.getElementById('userTicketTitle')?.focus();
    }

    function closeCreateTicketModal() {
        createTicketModal?.classList.remove('active');
        clearFieldError('userTicketTitle');
        clearFieldError('userTicketDescription');
    }

    let selfHelpDebounce = null;
    document.getElementById('userTicketTitle')?.addEventListener('input', () => {
        clearTimeout(selfHelpDebounce);
        selfHelpDebounce = setTimeout(renderSelfHelp, 350);
    });

    /* ================= المرفقات ================= */

    const attachmentsInput = document.getElementById('userTicketAttachments');
    const attachmentsChips = document.getElementById('ticketAttachmentsChips');

    function renderAttachmentChips() {
        if (!attachmentsChips) return;
        attachmentsChips.innerHTML = pendingAttachments.map((file, index) => `
            <span class="file-chip">
                <span class="u-truncate" style="max-width:11rem;">${escapeHtml(file.name)}</span>
                <button type="button" data-remove-attachment="${index}" aria-label="إزالة ${escapeHtml(file.name)}">×</button>
            </span>`).join('');
    }

    attachmentsInput?.addEventListener('change', () => {
        for (const file of Array.from(attachmentsInput.files || [])) {
            if (pendingAttachments.length >= MAX_ATTACHMENTS) {
                ui.showToast(`الحد الأقصى ${MAX_ATTACHMENTS} ملفات`, 'warning');
                break;
            }
            if (file.size > MAX_ATTACHMENT_BYTES) {
                ui.showToast(`الملف "${file.name}" أكبر من 5 ميجابايت ولم يُضَف`, 'warning');
                continue;
            }
            pendingAttachments.push(file);
        }
        attachmentsInput.value = '';
        renderAttachmentChips();
    });

    attachmentsChips?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-remove-attachment]');
        if (!btn) return;
        pendingAttachments.splice(Number(btn.dataset.removeAttachment), 1);
        renderAttachmentChips();
    });

    createTicketForm?.addEventListener('submit', async (e) => {
        e.preventDefault();

        const titleEl = document.getElementById('userTicketTitle');
        const descEl = document.getElementById('userTicketDescription');
        const submitBtn = document.getElementById('submitTicketBtn');

        const title = titleEl.value.trim();
        const description = descEl.value.trim();
        const priority = document.getElementById('userTicketPriority').value;
        const category = document.getElementById('userTicketCategory').value;

        clearFieldError('userTicketTitle');
        clearFieldError('userTicketDescription');

        let hasError = false;
        if (title.length < 5) {
            showFieldError('userTicketTitle', 'اكتب عنواناً واضحاً (5 أحرف على الأقل)');
            hasError = true;
        }
        if (description.length < 15) {
            showFieldError('userTicketDescription', 'اشرح المشكلة بتفصيل أكبر (15 حرفاً على الأقل) ليتمكن الفريق من مساعدتك');
            hasError = true;
        }
        if (hasError) return;

        if (settings.limits?.prevent_duplicate_tickets) {
            const normalized = title.toLowerCase();
            const duplicate = cachedTickets.find(t =>
                !statusInfo(t.status).closed && (t.title || '').trim().toLowerCase() === normalized);
            if (duplicate) {
                const proceed = await ui.showConfirm(
                    'لديك تذكرة مفتوحة بنفس العنوان',
                    `التذكرة #${duplicate.ticket_number} بنفس العنوان ما زالت مفتوحة. المتابعة عليها أسرع من فتح تذكرة جديدة. هل تريد فتحها بدلاً من ذلك؟`,
                    { confirmLabel: 'افتح التذكرة القائمة', cancelLabel: 'أنشئ تذكرة جديدة', type: 'info' }
                );
                if (proceed) {
                    closeCreateTicketModal();
                    showSection('tickets');
                    openTicket(duplicate.id);
                    return;
                }
            }
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'جاري الإرسال…';

        try {
            const ticket = await createTicket({ title, description, priority, category });

            if (cx.allow_ticket_attachments && pendingAttachments.length) {
                const results = await Promise.allSettled(
                    pendingAttachments.map(file => uploadTicketAttachment(ticket.id, file))
                );
                const failed = results.filter(r => r.status === 'rejected').length;
                if (failed) {
                    ui.showToast(`تم إنشاء التذكرة، لكن تعذّر رفع ${failed} من المرفقات`, 'warning', 6000);
                }
            }

            createTicketForm.reset();
            pendingAttachments = [];
            renderAttachmentChips();
            closeCreateTicketModal();

            currentTicketId = ticket.id;
            await refreshTickets();
            showSection('tickets');
            openTicket(ticket.id);
            ui.showToast(`تم إنشاء التذكرة #${ticket.ticket_number ?? ''} بنجاح`, 'success');
        } catch (err) {
            console.error('[Tickets] create:', err);
            ui.showToast(`تعذّر إنشاء التذكرة: ${err.message || 'خطأ غير متوقع'}`, 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'إرسال التذكرة';
        }
    });

    /* ================= فلاتر التذاكر ================= */

    document.getElementById('ticketViewTabs')?.addEventListener('click', (e) => {
        const tab = e.target.closest('[data-view]');
        if (!tab) return;
        currentView = tab.dataset.view;
        currentTicketId = null;
        renderTickets();
    });

    let searchDebounce = null;
    document.getElementById('ticketSearchInput')?.addEventListener('input', (e) => {
        clearTimeout(searchDebounce);
        const value = e.target.value;
        searchDebounce = setTimeout(() => {
            ticketSearch = value.trim();
            renderTickets();
        }, 320);
    });

    document.getElementById('ticketSortSelect')?.addEventListener('change', (e) => {
        ticketSort = e.target.value;
        renderTickets();
    });

    document.getElementById('ticketBackBtn')?.addEventListener('click', () => {
        document.getElementById('ticketsLayout')?.classList.remove('detail-open');
    });

    /* =========================================================
       البحث الشامل
    ========================================================= */

    // حقل البحث بقى جزءًا من الشريط العلوي المحقون بعد fetch، فالربط بيتم
    // في onReady مش وقت تنفيذ الوحدة — قبلها العنصر ما بيكونش موجود أصلاً.
    let searchInput = null;
    let searchResults = null;

    const SEARCHABLE_SECTIONS = [
        { key: 'support', label: 'مركز الدعم', terms: 'دعم مساعدة تواصل حالة النظام ساعات العمل' },
        { key: 'tickets', label: 'تذاكري', terms: 'تذاكر تذكرة مشكلة بلاغ' },
        { key: 'notifications', label: 'الإشعارات', terms: 'اشعارات تنبيهات' },
        { key: 'usage', label: 'الاستهلاك والاشتراك', terms: 'اشتراك باقة رصيد واتساب استهلاك حصة' },
        { key: 'activity', label: 'نشاط الحساب', terms: 'نشاط سجل' },
        { key: 'security', label: 'الأمان', terms: 'امان كلمة المرور تحقق بخطوتين مفاتيح api' },
        { key: 'profile', label: 'الملف الشخصي', terms: 'ملف شخصي بيانات هاتف بريد' },
        { key: 'badges', label: 'الشارات', terms: 'شارات انجازات' }
    ];

    function runGlobalSearch(term) {
        const q = term.trim().toLowerCase();
        if (q.length < 2) return null;

        const tickets = cachedTickets
            .filter(t => (t.title || '').toLowerCase().includes(q) || String(t.ticket_number || '').includes(q))
            .slice(0, 5)
            .map(t => ({ kind: 'ticket', id: t.id, title: `#${t.ticket_number} — ${t.title}`, meta: statusInfo(t.status).label }));

        const notifications = cachedNotifications
            .filter(n => (n.title || '').toLowerCase().includes(q) || (n.message || '').toLowerCase().includes(q))
            .slice(0, 4)
            .map(n => ({ kind: 'notification', id: n.id, title: n.title, meta: formatRelativeArabic(n.created_at) }));

        const sections = SEARCHABLE_SECTIONS
            .filter(s => SECTIONS.includes(s.key) && (s.label.toLowerCase().includes(q) || s.terms.includes(q)))
            .slice(0, 4)
            .map(s => ({ kind: 'section', id: s.key, title: s.label, meta: 'قسم' }));

        return { tickets, notifications, sections };
    }

    function renderSearchResults(term) {
        if (!searchResults) return;
        const results = runGlobalSearch(term);

        if (!results) {
            searchResults.hidden = true;
            searchInput?.setAttribute('aria-expanded', 'false');
            return;
        }

        const groups = [
            { label: 'التذاكر', items: results.tickets },
            { label: 'الإشعارات', items: results.notifications },
            { label: 'الأقسام', items: results.sections }
        ].filter(g => g.items.length);

        if (!groups.length) {
            searchResults.innerHTML = `
                <div class="state-block state-block--compact">
                    <p class="state-title">لا توجد نتائج</p>
                    <p class="state-text">جرّب كلمة أخرى، أو افتح تذكرة جديدة لتصف مشكلتك.</p>
                </div>`;
        } else {
            searchResults.innerHTML = groups.map(group => `
                <div class="search-group-label">${escapeHtml(group.label)}</div>
                ${group.items.map(item => `
                    <button type="button" class="search-result" role="option"
                            data-kind="${escapeHtml(item.kind)}" data-id="${escapeHtml(String(item.id))}">
                        <span class="search-result-title u-truncate">${escapeHtml(item.title)}</span>
                        <span class="search-result-meta">${escapeHtml(item.meta)}</span>
                    </button>`).join('')}`).join('');
        }

        searchResults.hidden = false;
        searchInput?.setAttribute('aria-expanded', 'true');
    }

    let globalSearchDebounce = null;

    function bindGlobalSearch() {
        searchInput = document.getElementById('globalSearchInput');
        searchResults = document.getElementById('globalSearchResults');
        if (!searchInput || !searchResults) return;

        searchInput.addEventListener('input', (e) => {
            clearTimeout(globalSearchDebounce);
            const value = e.target.value;
            globalSearchDebounce = setTimeout(() => renderSearchResults(value), 200);
        });

        searchInput.addEventListener('focus', () => {
            // الإشعارات مطلوبة للبحث فيها حتى لو القسم لسه ما اتفتحش
            if (!cachedNotifications.length && !isGuest) {
                fetchNotifications().then(list => { cachedNotifications = list; }).catch(() => {});
            }
        });

        // بحث قادم من صفحة أخرى في البوابة (?q=) — نفس المنطق، مصدر واحد
        const initialQuery = new URLSearchParams(window.location.search).get('q');
        if (initialQuery) {
            searchInput.value = initialQuery;
            renderSearchResults(initialQuery);
        }

        bindSearchResultClicks();
    }

    function bindSearchResultClicks() {
        searchResults?.addEventListener('click', (e) => {
        const btn = e.target.closest('.search-result');
        if (!btn) return;
        const { kind, id } = btn.dataset;

        searchResults.hidden = true;
        if (searchInput) searchInput.value = '';

        if (kind === 'ticket') {
            showSection('tickets');
            openTicket(id);
        } else if (kind === 'section') {
            showSection(id);
        } else if (kind === 'notification') {
            const notification = cachedNotifications.find(n => String(n.id) === String(id));
            if (notification) activateNotification(notification);
        }
        });
    }

    document.addEventListener('click', (e) => {
        if (searchResults && !searchResults.hidden && !e.target.closest('.portal-search')) {
            searchResults.hidden = true;
            searchInput?.setAttribute('aria-expanded', 'false');
        }
    });

    // اختصار "/" بقى مسؤولية القشرة (customer-sidebar.js) لأن الحقل بقى فيها،
    // فما بنكرّرش المعالج هنا. اللي فاضل لينا: Escape يقفل النتائج ثم النوافذ.
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (searchResults && !searchResults.hidden) {
                searchResults.hidden = true;
                searchInput?.blur();
                return;
            }
            document.querySelector('.modal.active')?.classList.remove('active');
        }
    });

    /* =========================================================
       معالجات عامة (تفويض من مستوى الصفحة)
    ========================================================= */

    document.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="open-create-ticket"]')) {
            e.preventDefault();
            openCreateTicketModal();
            return;
        }

        if (e.target.closest('[data-action="reset-ticket-filters"]')) {
            currentView = 'all';
            ticketSearch = '';
            const input = document.getElementById('ticketSearchInput');
            if (input) input.value = '';
            renderTickets();
            return;
        }

        if (e.target.closest('[data-action="reset-notification-filter"]')) {
            notificationFilter = 'all';
            renderNotifications();
            return;
        }

        const openTicketBtn = e.target.closest('[data-open-ticket]');
        if (openTicketBtn) {
            closeCreateTicketModal();
            showSection('tickets');
            openTicket(openTicketBtn.dataset.openTicket);
            return;
        }

        const retry = e.target.closest('[data-retry]');
        if (retry) {
            const target = retry.dataset.retry;
            loadSnapshot().then(() => {
                if (target === 'overview') renderOverview();
                else lazyLoadSection(target);
            });
            return;
        }

        if (e.target.closest('.close-modal')) {
            e.target.closest('.modal')?.classList.remove('active');
            return;
        }

        if (e.target.classList?.contains('modal')) {
            e.target.classList.remove('active');
            return;
        }

        const goto = e.target.closest('[data-goto]');
        if (goto) {
            e.preventDefault();
            showSection(goto.dataset.goto);
        }
    });

    /* =========================================================
       التهيئة
    ========================================================= */

    if (cx.enable_rewards_system && !isGuest) {
        initRewardsDashboard(user);
    }

    document.getElementById('overviewRefreshBtn')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
            await loadSnapshot();
            await Promise.all([renderOverview(), refreshNotificationBadge()]);
            renderTickets();
            ui.showToast('تم تحديث البيانات', 'success', 2500);
        } finally {
            btn.disabled = false;
        }
    });

    await loadSnapshot();
    await renderOverview();
    renderTickets();
    setSidebarBadge('tickets', countByView(cachedTickets, user.id).awaiting);

    /* ================= الوجهة الابتدائية =================
       ?ticket=<uuid> بييجي من روابط الإشعارات المخزّنة في قاعدة البيانات
       (customer-dashboard.html?ticket=…). كان بيتجاهَل تمامًا قبل كده. */
    const params = new URLSearchParams(window.location.search);
    const deepTicket = params.get('ticket');
    if (deepTicket && !isGuest) {
        showSection('tickets', { updateHash: false });
        openTicket(deepTicket);
    } else {
        showSection(window.location.hash.slice(1) || 'overview', { updateHash: false });
    }

    /* ================= التحديث اللحظي ================= */

    if (!isGuest) {
        subscribeToTickets(() => { refreshTickets(); });

        subscribeToNotifications(user.id, () => {
            refreshNotificationBadge();
            if (currentSection === 'notifications') renderNotifications();
        });
    }

    /* ================= تسجيل الخروج =================
       مربوط بالكامل في customer-sidebar.js على #customerSignOut و
       #sidebarSignOut (الزرّان الوحيدان الموجودان فعلياً). */

})();
