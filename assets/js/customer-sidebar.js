/**
 * customer-sidebar.js — قشرة بوابة الدعم المشتركة (شريط علوي + قائمة جانبية).
 *
 * الملف ده هو نقطة الدخول الوحيدة لكل صفحات بوابة العميل:
 *   customer-dashboard, knowledge-base, customer-subscriptions,
 *   customer-security-settings, community, roadmap.
 *
 * التوقيع بيقبل الشكلين للتوافق مع النداءات القديمة:
 *   initCustomerSidebar(fn)                        ← الشكل القديم
 *   initCustomerSidebar({ onTabChange, onReady })  ← الشكل الجديد
 *
 * الصفحات اللي مش لوحة العميل ما بتمرّرش onTabChange، فعناصر الأقسام فيها
 * بتشتغل كروابط عادية للوحة (href مكتوب في الـHTML أصلاً) بدل ما تكون ميتة.
 */

const DASHBOARD_PATH = '/customer-dashboard.html';
const COLLAPSE_KEY = 'mad3oom-sidebar-collapsed';

let tabChangeHandler = null;

/** هل المستخدم مفضّل القائمة مطوية؟ (يُقرأ قبل الرسم لتفادي أي قفزة) */
export function isSidebarCollapsed() {
    try {
        return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
        return false;
    }
}

/**
 * يطبّق حالة الطي ويحفظها.
 * العلَم على <html> مش على <body>: السكربت اللي بيشتغل قبل أول رسم في <head>
 * ما بيقدرش يوصل لـbody، فلو الحالة اتحطت على body هتحصل قفزة في عرض المحتوى
 * بعد التحميل. الاتنين بيكتبوا نفس السمة هنا.
 */
export function setSidebarCollapsed(collapsed, { persist = true } = {}) {
    document.documentElement.setAttribute('data-sidebar', collapsed ? 'collapsed' : 'expanded');

    const btn = document.getElementById('sidebarCollapseBtn');
    if (btn) {
        btn.setAttribute('aria-expanded', String(!collapsed));
        btn.setAttribute('aria-label', collapsed ? 'توسيع القائمة الجانبية' : 'طي القائمة الجانبية');
        btn.title = collapsed ? 'توسيع القائمة' : 'طي القائمة';
    }

    if (persist) {
        try {
            localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
        } catch { /* التخزين غير متاح (وضع خاص) — الحالة تفضل للجلسة الحالية */ }
    }
}

export function initCustomerSidebar(optionsOrCallback) {
    const options = typeof optionsOrCallback === 'function'
        ? { onTabChange: optionsOrCallback }
        : (optionsOrCallback || {});

    tabChangeHandler = options.onTabChange || null;

    const sidebarContainer = document.getElementById('sidebar-container');
    if (!sidebarContainer) return Promise.resolve();

    // تُطبَّق قبل جلب الـHTML: كده المحتوى الرئيسي بيترسم بعرضه الصحيح من أول
    // لحظة بدل ما يتحرك بعد وصول القائمة.
    setSidebarCollapsed(isSidebarCollapsed(), { persist: false });

    return fetch('/assets/components/customer-sidebar.html')
        .then(response => response.text())
        .then(html => {
            sidebarContainer.innerHTML = html;
            setupSidebarLogic(tabChangeHandler, options);
            setupCollapseToggle();
            syncNavHeight();
            markActivePage();
            loadAccountIdentity();
            if (options.ownsSystemStatus !== true) loadSystemStatusPill();
            if (typeof options.onReady === 'function') options.onReady();
        })
        .catch(err => console.error('Error loading customer sidebar:', err));
}

/**
 * يعرض عدّاداً بجوار عنصر في القائمة (تذاكر مفتوحة، إشعارات غير مقروءة…).
 * تمرير 0 أو قيمة غير صالحة يخفي العدّاد.
 */
export function setSidebarBadge(tabName, count) {
    const item = document.querySelector(`.sidebar-item[data-tab="${tabName}"]`);
    if (!item) return;

    let badge = item.querySelector('.nav-count');
    const value = Number(count) || 0;

    if (value <= 0) {
        badge?.remove();
        return;
    }
    if (!badge) {
        badge = document.createElement('span');
        badge.className = 'nav-count';
        item.appendChild(badge);
    }
    badge.textContent = value > 99 ? '99+' : String(value);
}

/** يحدّد العنصر النشط في القائمة (يُستدعى عند تبديل القسم من أي مكان). */
export function setActiveSidebarTab(tabName) {
    document.querySelectorAll('.sidebar-item').forEach(item => {
        item.classList.toggle('active', item.getAttribute('data-tab') === tabName);
    });
}

/**
 * على الصفحات المستقلة (مركز المساعدة، الباقات، المجتمع…) العنصر النشط
 * بيتحدّد من اسم الملف، مش من قسم داخل اللوحة.
 */
function markActivePage() {
    const segments = window.location.pathname.split('/').filter(Boolean);
    let file = (segments.pop() || '').replace(/\.html$/, '');
    // مسار مجلد (/company-dashboard/ أو /company-dashboard/index.html):
    // الاسم يُؤخذ من المجلد نفسه بدل ما يبقى فاضي أو 'index'
    if (!file || file === 'index') file = segments.pop() || '';
    if (!file || file === 'customer-dashboard') return;

    document.querySelectorAll('.sidebar-item[data-page]').forEach(item => {
        item.classList.toggle('active', item.getAttribute('data-page') === file);
    });
}

/**
 * حالة النظام في الشريط العلوي: كانت نصًا ثابتًا "النظام شغال" مهما كانت
 * الحالة الحقيقية. دلوقتي بتتقرا من نفس مصدر قسم حالة النظام.
 */
export function updateSystemStatusPill(status) {
    const pill = document.getElementById('portalSystemStatus');
    const dot = document.getElementById('portalSystemStatusDot');
    const text = document.getElementById('portalSystemStatusText');
    if (!pill || !dot || !text) return;

    if (!status || !Array.isArray(status.services) || status.services.length === 0) {
        pill.hidden = true;
        return;
    }

    const down = status.services.filter(s => s.status === 'down' || s.status === 'partial_outage');
    const degraded = status.services.filter(s => s.status === 'degraded');
    const maintenance = status.services.filter(s => s.status === 'maintenance');

    let tone = 'online';
    let label = 'كل الخدمات تعمل';
    if (down.length) {
        tone = 'down';
        label = down.length === 1 ? 'عطل في خدمة' : `عطل في ${down.length} خدمات`;
    } else if (degraded.length) {
        tone = 'degraded';
        label = degraded.length === 1 ? 'خدمة بأداء منخفض' : `${degraded.length} خدمات بأداء منخفض`;
    } else if (maintenance.length) {
        tone = 'maintenance';
        label = 'صيانة مجدولة';
    }

    dot.className = `status-dot status-${tone}`;
    text.textContent = label;
    pill.title = label;
    pill.hidden = false;
}

async function loadSystemStatusPill() {
    try {
        const { fetchSystemStatus } = await import('/assets/js/customer/customer-data.js');
        const result = await fetchSystemStatus();
        if (result.ok) updateSystemStatusPill(result.data);
    } catch (err) {
        // فشل جلب الحالة ما يوقفش الصفحة — الشارة تفضل مخفية بدل ما تدّعي حالة
        console.error('[CustomerSidebar] Error loading system status:', err);
    }
}

/** اسم المستخدم وبريده وحالته داخل قائمة الحساب. */
async function loadAccountIdentity() {
    try {
        const { getCurrentUser } = await import('../auth-client.js');
        const user = await getCurrentUser();
        if (!user) return;

        const name = user.profile?.full_name || user.email || 'حسابي';
        const initial = document.getElementById('customerInitial');
        const menuName = document.getElementById('customerMenuName');
        const menuEmail = document.getElementById('customerMenuEmail');
        const menuState = document.getElementById('customerMenuState');

        if (initial) initial.textContent = String(name).trim().charAt(0).toUpperCase() || 'U';
        if (menuName) menuName.textContent = name;
        if (menuEmail) menuEmail.textContent = user.email || '';

        // حالة الحساب معلومة يملكها العميل عن نفسه، ومفيدة قبل ما يسأل الدعم.
        const ban = user.profile?.ban_status;
        if (menuState && ban && ban !== 'active') {
            menuState.textContent = ban === 'banned' ? 'الحساب موقوف' : 'الحساب مقيّد';
            menuState.className = 'badge badge-danger portal-menu-state';
            menuState.hidden = false;
        }
    } catch (err) {
        console.error('[CustomerSidebar] Error loading account identity:', err);
    }
}

function setupCollapseToggle() {
    // الحالة المحفوظة تُطبَّق فورًا (بدون حفظ) قبل أي تفاعل
    setSidebarCollapsed(isSidebarCollapsed(), { persist: false });

    const btn = document.getElementById('sidebarCollapseBtn');
    if (!btn) return;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setSidebarCollapsed(document.documentElement.getAttribute('data-sidebar') !== 'collapsed');
    });
}

/**
 * ارتفاع الشريط العلوي بيتغيّر حسب حجم الشاشة، والقائمة الثابتة والمحتوى
 * الاتنين بيبدأوا من تحته. بنقيسه فعلياً بدل ما نفترضه.
 */
function syncNavHeight() {
    const nav = document.querySelector('.admin-nav');
    if (!nav) return;

    // القيمة دي بتتحكم في padding-top للصفحة، وتغييرها بيغيّر ارتفاع المستند
    // وبالتالي ظهور شريط التمرير وبالتالي عرض الشريط — يعني ResizeObserver
    // يقدر يفضل يوقظ نفسه. الحارس ده بيكسر الدورة: ما بنكتبش غير لما يتغيّر
    // الارتفاع فعلاً.
    let lastHeight = 0;
    const apply = () => {
        const height = Math.round(nav.getBoundingClientRect().height);
        if (height > 0 && height !== lastHeight) {
            lastHeight = height;
            document.documentElement.style.setProperty('--customer-nav-h', `${height}px`);
        }
    };

    apply();
    if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(apply).observe(nav);
    } else {
        window.addEventListener('resize', apply);
    }
}

/** فتح/غلق قائمة منسدلة مع ضبط aria وإغلاق باقي القوائم. */
function toggleMenu(menu, trigger, force) {
    const open = force !== undefined ? force : menu.hidden;
    document.querySelectorAll('.portal-menu').forEach(other => {
        if (other !== menu) {
            other.hidden = true;
            const otherTrigger = other.parentElement?.querySelector('[aria-haspopup]');
            otherTrigger?.setAttribute('aria-expanded', 'false');
        }
    });
    menu.hidden = !open;
    trigger?.setAttribute('aria-expanded', String(open));
}

function setupSidebarLogic(onTabChange, options = {}) {
    const menuToggle = document.getElementById('menuToggle');
    const sidebar = document.getElementById('sidebar');
    const sidebarClose = document.getElementById('sidebarClose');
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    const customerAvatarBtn = document.getElementById('customerAvatarBtn');
    const customerAvatarMenu = document.getElementById('customerAvatarMenu');
    const notificationBtn = document.getElementById('notificationBtn');
    const sidebarItems = document.querySelectorAll('.sidebar-item[data-tab]');

    if (!menuToggle || !sidebar) return;

    // ── الإشعارات ────────────────────────────────────────────────────────────
    // الجرس بينقل لصفحة الإشعارات الكاملة (مش قائمة منسدلة): مصدر واحد لعرض
    // الإشعارات بدل نسختين من نفس المنطق.
    if (notificationBtn) {
        notificationBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (onTabChange) {
                setActiveSidebarTab('notifications');
                onTabChange('notifications');
            } else {
                window.location.href = `${DASHBOARD_PATH}#notifications`;
            }
        });
    }

    /** يحدّث شارة العدد على الجرس وفي القائمة الجانبية. */
    async function refreshUnreadBadge() {
        const badge = document.getElementById('notificationBadge');
        try {
            const { fetchUnreadCount } = await import('/notifications-service.js');
            const unread = await fetchUnreadCount();
            if (badge) {
                badge.textContent = unread > 99 ? '99+' : String(unread);
                badge.hidden = unread <= 0;
                notificationBtn?.setAttribute(
                    'aria-label',
                    unread > 0 ? `الإشعارات — ${unread} غير مقروء` : 'الإشعارات'
                );
            }
            setSidebarBadge('notifications', unread);
        } catch (err) {
            console.error('[CustomerSidebar] Error loading unread count:', err);
        }
    }

    // ── الاشتراك اللحظي في الإشعارات ─────────────────────────────────────────
    let notificationSubscription = null;
    async function setupNotificationRealtime() {
        try {
            const { subscribeToNotifications } = await import('/notifications-service.js');
            const { supabase } = await import('/api-config.js');
            const { data: { user } } = await supabase.auth.getUser();

            if (user && !notificationSubscription) {
                notificationSubscription = subscribeToNotifications(user.id, (newNotification) => {
                    refreshUnreadBadge();
                    document.dispatchEvent(new CustomEvent('customer:notification', { detail: newNotification }));
                    if ('Notification' in window && Notification.permission === 'granted') {
                        new Notification(newNotification.title, {
                            body: newNotification.message,
                            icon: '/logo.png'
                        });
                    }
                });
            }
        } catch (err) {
            console.error('[CustomerSidebar] Error setting up realtime notifications:', err);
        }
    }

    refreshUnreadBadge();
    setupNotificationRealtime();
    checkWhatsAppPermission();
    checkCompanyMembership();
    document.addEventListener('customer:notifications-read', refreshUnreadBadge);

    // ── الدرج على الشاشات الصغيرة ────────────────────────────────────────────
    const setDrawer = (open) => {
        sidebar.classList.toggle('active', open);
        sidebarOverlay?.classList.toggle('active', open);
        menuToggle.setAttribute('aria-expanded', String(open));
        if (open) sidebar.querySelector('.sidebar-item')?.focus({ preventScroll: true });
    };
    const toggleSidebar = () => setDrawer(!sidebar.classList.contains('active'));

    [menuToggle, document.getElementById('mobileMenuToggle')].filter(Boolean).forEach(toggle => {
        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleSidebar();
        });
    });

    if (sidebarClose) sidebarClose.addEventListener('click', () => setDrawer(false));
    if (sidebarOverlay) sidebarOverlay.addEventListener('click', () => setDrawer(false));

    // ── التنقّل بين الأقسام ──────────────────────────────────────────────────
    sidebarItems.forEach(item => {
        item.addEventListener('click', (e) => {
            const tabName = item.getAttribute('data-tab');

            // خارج لوحة العميل: نسيب الرابط يشتغل عادي (href في الـHTML)
            if (!onTabChange) return;

            e.preventDefault();
            setActiveSidebarTab(tabName);
            onTabChange(tabName);
            if (sidebar.classList.contains('active')) setDrawer(false);
        });
    });

    // ── البحث الشامل ─────────────────────────────────────────────────────────
    setupPortalSearch(options);

    // ── اللغة ────────────────────────────────────────────────────────────────
    const languageToggleBtn = document.getElementById('languageToggleBtn');
    const languageMenu = document.getElementById('languageMenu');
    const langArabic = document.getElementById('langArabic');
    const langEnglish = document.getElementById('langEnglish');

    if (languageToggleBtn && languageMenu) {
        languageToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleMenu(languageMenu, languageToggleBtn);
            updateLanguageCheckmarks();
        });

        langArabic?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            changeLanguage('ar');
        });

        langEnglish?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            changeLanguage('en');
        });
    }

    function updateLanguageCheckmarks() {
        const currentLang = localStorage.getItem('mad3oom-language') || 'ar';
        langArabic?.querySelector('.lang-check')?.toggleAttribute('hidden', currentLang !== 'ar');
        langEnglish?.querySelector('.lang-check')?.toggleAttribute('hidden', currentLang !== 'en');
    }

    function changeLanguage(lang) {
        if (window.languageManager) {
            window.languageManager.setLanguage(lang);
        } else {
            localStorage.setItem('mad3oom-language', lang);
            const html = document.documentElement;
            html.lang = lang;
            html.dir = lang === 'ar' ? 'rtl' : 'ltr';
        }
        window.location.reload();
    }

    // ── قائمة الحساب ─────────────────────────────────────────────────────────
    if (customerAvatarBtn && customerAvatarMenu) {
        customerAvatarBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleMenu(customerAvatarMenu, customerAvatarBtn);
        });
        customerAvatarMenu.addEventListener('click', e => e.stopPropagation());
    }

    // معالج واحد مسمّى حتى لا تتراكم النسخ عند إعادة تهيئة القائمة
    const closeAllMenus = () => {
        document.querySelectorAll('.portal-menu').forEach(menu => { menu.hidden = true; });
        document.querySelectorAll('[aria-haspopup]').forEach(t => t.setAttribute('aria-expanded', 'false'));
    };
    document.removeEventListener('click', document._sidebarCloseMenus);
    document._sidebarCloseMenus = closeAllMenus;
    document.addEventListener('click', closeAllMenus);

    // Escape يقفل أي قائمة مفتوحة أو الدرج — مخرج واحد متوقَّع من أي حالة
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const anyMenuOpen = [...document.querySelectorAll('.portal-menu')].some(m => !m.hidden);
        if (anyMenuOpen) { closeAllMenus(); return; }
        if (sidebar.classList.contains('active')) { setDrawer(false); menuToggle.focus(); }
    });

    // ── عناصر قائمة الحساب ───────────────────────────────────────────────────
    const customerProfile = document.getElementById('customerProfile');
    const customerAccountSettings = document.getElementById('customerAccountSettings');
    const customerSecuritySettings = document.getElementById('customerSecuritySettings');

    // داخل اللوحة الأقسام بتتبدّل من غير إعادة تحميل؛ برّه الروابط تشتغل عادي.
    [[customerProfile, 'profile'], [customerSecuritySettings, 'security']].forEach(([el, tab]) => {
        el?.addEventListener('click', (e) => {
            if (!onTabChange) return;
            e.preventDefault();
            closeAllMenus();
            setActiveSidebarTab(tab);
            onTabChange(tab);
        });
    });

    if (customerAccountSettings) {
        customerAccountSettings.addEventListener('click', (e) => {
            e.preventDefault();
            closeAllMenus();
            if (window.openSettingsModal) window.openSettingsModal();
            else window.location.href = `${DASHBOARD_PATH}#profile`;
        });
    }

    // ── تسجيل الخروج ─────────────────────────────────────────────────────────
    const onLogout = async (e) => {
        e.preventDefault();
        try {
            const { logout } = await import('../auth-client.js');
            await logout();
            window.location.replace('/login.html');
        } catch (err) {
            console.error('Logout failed:', err);
            localStorage.removeItem('mad3oom-guest-session');
            window.location.replace('/login.html');
        }
    };

    document.getElementById('customerSignOut')?.addEventListener('click', onLogout);
    document.getElementById('sidebarSignOut')?.addEventListener('click', onLogout);

    updateLanguageCheckmarks();
}

/**
 * البحث: مربع واحد في الشريط العلوي لكل الصفحات.
 * لو الصفحة سجّلت معالجًا (اللوحة) بترسم نتائجها في مكانها؛ وإلا الإدخال
 * بينقل للوحة ومعاه النص في ?q= فتكمّل هي البحث بنفس منطقها.
 */
function setupPortalSearch(options) {
    const wrap = document.getElementById('portalSearch');
    const input = document.getElementById('globalSearchInput');
    const trigger = document.getElementById('portalSearchTrigger');
    const closeBtn = document.getElementById('portalSearchClose');
    if (!wrap || !input) return;

    const openOverlay = () => {
        wrap.classList.add('is-open');
        input.focus();
    };
    const closeOverlay = () => {
        wrap.classList.remove('is-open');
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
    };

    trigger?.addEventListener('click', (e) => { e.stopPropagation(); openOverlay(); });
    closeBtn?.addEventListener('click', (e) => { e.stopPropagation(); closeOverlay(); });

    // اختصار "/" يركّز البحث من أي مكان، إلا وإحنا بنكتب في حقل تاني
    document.addEventListener('keydown', (e) => {
        if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const tag = document.activeElement?.tagName;
            const editing = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;
            if (editing) return;
            e.preventDefault();
            openOverlay();
        } else if (e.key === 'Escape' && document.activeElement === input) {
            closeOverlay();
            input.blur();
        }
    });

    // اللوحة بترسم نتائجها بنفسها في نفس الحقل؛ برّه اللوحة الحقل بينقل إليها.
    if (options.ownsSearch === true) return;

    input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const term = input.value.trim();
        if (!term) return;
        window.location.href = `${DASHBOARD_PATH}?q=${encodeURIComponent(term)}`;
    });

    // برّه اللوحة مفيش نتائج تُرسم هنا، فبنوضّح ده بدل صندوق فاضي
    input.setAttribute('placeholder', 'ابحث ثم اضغط Enter…');
}

async function checkWhatsAppPermission() {
    try {
        const { initSubscriptionHandler } = await import('/assets/js/sidebar-subscription-handler.js');
        await initSubscriptionHandler();
    } catch (err) {
        console.error('[CustomerSidebar] Error checking WhatsApp permission:', err);
    }
}

/**
 * مدخل لوحة الشركة بيظهر فقط للمستخدم التابع لشركة (مالك أو عضو فرعي).
 * القرار بيتاخد في القاعدة (current_company_id)، والواجهة بترسم نتيجته —
 * الإخفاء هنا تنظيم للقائمة مش حماية؛ الحماية في RLS ودوال الـRPC نفسها.
 */
async function checkCompanyMembership() {
    const link = document.getElementById('companyDashboardLink');
    if (!link) return;
    try {
        const { hasCompany } = await import('/assets/js/company/company-data.js');
        link.hidden = !(await hasCompany());
    } catch (err) {
        console.error('[CustomerSidebar] Error checking company membership:', err);
        link.hidden = true;
    }
}
