import { supabase } from '/api-config.js';

export function initSidebar() {
    const sidebarContainer = document.getElementById('sidebar-container');
    if (!sidebarContainer) return;

    // Load sidebar HTML - Use absolute path to ensure it works from any directory
    fetch('/assets/components/sidebar.html')
        .then(response => response.text())
        .then(html => {
            sidebarContainer.innerHTML = html;
            setupSidebarLogic();
            highlightActiveLink();
        })
        .catch(err => console.error('Error loading sidebar:', err));
}

function setupSidebarLogic() {
    const menuToggle = document.getElementById('menuToggle');
    const sidebar = document.getElementById('sidebar');
    const sidebarClose = document.getElementById('sidebarClose');
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    const adminAvatarBtn = document.getElementById('adminAvatarBtn');
    const adminAvatarMenu = document.getElementById('adminAvatarMenu');
    const notificationBtn = document.getElementById('notificationBtn');
    const notificationMenu = document.getElementById('notificationMenu');

    if (!menuToggle || !sidebar) return;

    // Notification Logic
    if (notificationBtn && notificationMenu) {
        notificationBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = notificationMenu.style.display === 'block';
            notificationMenu.style.display = isVisible ? 'none' : 'block';
            if (!isVisible) {
                loadNotifications();
            }
        });

        document.getElementById('markAllReadBtn')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            const { markAllAsRead } = await import('/notifications-service.js');
            await markAllAsRead();
            loadNotifications();
        });
    }

    async function loadNotifications() {
        const list = document.getElementById('notificationList');
        const badge = document.getElementById('notificationBadge');
        if (!list) return;

        try {
            const { fetchNotifications, markAsRead } = await import('/notifications-service.js');
            const notifications = await fetchNotifications();
            
            // في لوحة الإدارة، نعرض فقط الإشعارات الموجهة للأدمن (التي تم جلبها بالفعل بناءً على user_id في الخدمة)
            const unreadCount = notifications.filter(n => !n.is_read).length;
            if (badge) {
                badge.textContent = unreadCount;
                badge.style.display = unreadCount > 0 ? 'flex' : 'none';
            }

            if (notifications.length === 0) {
                list.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--color-text-secondary); font-size: 0.85rem;">لا توجد إشعارات إدارية</div>';
                return;
            }

            list.innerHTML = notifications.map(n => `
                <div class="notification-item ${n.is_read ? '' : 'unread'}" data-id="${n.id}" style="padding: 12px 16px; border-bottom: 1px solid var(--color-border); cursor: pointer; transition: background 0.2s; ${n.is_read ? '' : 'background: rgba(0, 119, 204, 0.05);'}">
                    <div style="font-weight: 700; font-size: 0.85rem; margin-bottom: 4px; color: var(--color-text);">${n.title}</div>
                    <div style="font-size: 0.8rem; color: var(--color-text-secondary); line-height: 1.4;">${n.message}</div>
                    <div style="font-size: 0.7rem; color: #999; margin-top: 6px;">${new Date(n.created_at).toLocaleString('ar-EG')}</div>
                </div>
            `).join('');

            list.querySelectorAll('.notification-item').forEach(item => {
                item.addEventListener('click', async () => {
                    const id = item.dataset.id;
                    await markAsRead(id);
                    const notification = notifications.find(n => n.id == id);
                    if (notification && notification.link) {
                        window.location.href = notification.link;
                    } else {
                        loadNotifications();
                    }
                });
            });
        } catch (err) {
            console.error('[Sidebar] Error loading notifications:', err);
            list.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--color-danger); font-size: 0.85rem;">فشل تحميل الإشعارات</div>';
        }
    }

    // Setup realtime subscription for notifications
    let notificationSubscription = null;
    async function setupNotificationRealtime() {
        const { subscribeToNotifications } = await import('/notifications-service.js');
        const { data: { user } } = await supabase.auth.getUser();
        
        if (user && !notificationSubscription) {
            notificationSubscription = subscribeToNotifications(user.id, (newNotification) => {
                loadNotifications();
                
                // Show browser notification if supported
                if ('Notification' in window && Notification.permission === 'granted') {
                    new Notification(newNotification.title, {
                        body: newNotification.message,
                        icon: '/assets/images/logo.png'
                    });
                }
            });
        }
    }

    // Initial load
    loadNotifications();
    setupNotificationRealtime();
    applySidebarPermissions();

    const toggleSidebar = () => {
        sidebar.classList.toggle('active');
        sidebarOverlay.classList.toggle('active');
    };

    menuToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSidebar();
    });
    
    if (sidebarClose) sidebarClose.addEventListener('click', toggleSidebar);
    if (sidebarOverlay) sidebarOverlay.addEventListener('click', toggleSidebar);

    // Language Toggle Logic
    const adminLanguageToggleBtn = document.getElementById('adminLanguageToggleBtn');
    const adminLanguageMenu = document.getElementById('adminLanguageMenu');
    const adminLangArabic = document.getElementById('adminLangArabic');
    const adminLangEnglish = document.getElementById('adminLangEnglish');

    if (adminLanguageToggleBtn && adminLanguageMenu) {
        adminLanguageToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = adminLanguageMenu.style.display === 'block';
            adminLanguageMenu.style.display = isVisible ? 'none' : 'block';
            updateAdminLanguageCheckmarks();
        });

        adminLangArabic?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            changeAdminLanguage('ar');
            adminLanguageMenu.style.display = 'none';
        });

        adminLangEnglish?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            changeAdminLanguage('en');
            adminLanguageMenu.style.display = 'none';
        });
    }

    function updateAdminLanguageCheckmarks() {
        const currentLang = localStorage.getItem('mad3oom-language') || 'ar';
        const arabicChecks = document.querySelectorAll('.admin-lang-check');
        arabicChecks.forEach((check, idx) => {
            check.style.display = (idx === 0 && currentLang === 'ar') || (idx === 1 && currentLang === 'en') ? 'none' : 'none';
        });
        const arabicCheck = adminLangArabic?.querySelector('.admin-lang-check');
        const englishCheck = adminLangEnglish?.querySelector('.admin-lang-check');
        
        if (arabicCheck) arabicCheck.style.display = currentLang === 'ar' ? 'inline' : 'none';
        if (englishCheck) englishCheck.style.display = currentLang === 'en' ? 'inline' : 'none';
    }

    function changeAdminLanguage(lang) {
        if (window.languageManager) {
            window.languageManager.setLanguage(lang);
        } else {
            localStorage.setItem('mad3oom-language', lang);
            const html = document.documentElement;
            html.lang = lang;
            html.dir = lang === 'ar' ? 'rtl' : 'ltr';
            document.body.style.direction = lang === 'ar' ? 'rtl' : 'ltr';
        }
        
        // Reload page to apply language changes
        window.location.reload();
    }

    // Avatar Menu Logic
    if (adminAvatarBtn && adminAvatarMenu) {
        adminAvatarBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = adminAvatarMenu.style.display === 'block';
            adminAvatarMenu.style.display = isVisible ? 'none' : 'block';
        });

        document.addEventListener('click', () => {
            if (adminAvatarMenu) adminAvatarMenu.style.display = 'none';
            if (notificationMenu) notificationMenu.style.display = 'none';
            if (adminLanguageMenu) adminLanguageMenu.style.display = 'none';
        });
    }

    // Handle menu item clicks
    const adminProfile = document.getElementById('adminProfile');
    const adminAccountSettings = document.getElementById('adminAccountSettings');
    const adminSecuritySettings = document.getElementById('adminSecuritySettings');
    const adminHelpSupport = document.getElementById('adminHelpSupport');

    if (adminProfile) {
        adminProfile.addEventListener('click', (e) => {
            e.preventDefault();
            // Navigate to profile page
            window.location.href = '#profile';
            adminAvatarMenu.style.display = 'none';
        });
    }

    if (adminAccountSettings) {
        adminAccountSettings.addEventListener('click', (e) => {
            e.preventDefault();
            // Navigate to account settings
            window.location.href = '/admin/settings.html';
            adminAvatarMenu.style.display = 'none';
        });
    }

    if (adminSecuritySettings) {
        adminSecuritySettings.addEventListener('click', (e) => {
            e.preventDefault();
            // Navigate to security settings
            window.location.href = '/admin-security-settings.html';
            adminAvatarMenu.style.display = 'none';
        });
    }

    if (adminHelpSupport) {
        adminHelpSupport.addEventListener('click', (e) => {
            e.preventDefault();
            // Navigate to help/support
            window.location.href = '/knowledge-base.html';
            adminAvatarMenu.style.display = 'none';
        });
    }

    // Initialize language checkmarks on load
    updateAdminLanguageCheckmarks();

    // Handle logout
    const adminSignOut = document.getElementById('adminSignOut');
    const sidebarSignOut = document.getElementById('sidebarSignOut');
    
    const onLogout = async (e) => {
        e.preventDefault();
        const { handleLogout } = await import('./auth.js');
        await handleLogout();
    };

    if (adminSignOut) adminSignOut.addEventListener('click', onLogout);
    if (sidebarSignOut) sidebarSignOut.addEventListener('click', onLogout);

    // Initialize language checkmarks on load
    updateAdminLanguageCheckmarks();
}

// أقسام لا يجب أن يراها "Super User" (مستخدم مميز/باقة) لأنها تعرض بيانات
// على مستوى المنصة بالكامل (كل العملاء/التذاكر/الإعدادات)، وليست خاصة بحسابه.
// الأدمن والدعم لا يتأثرون بهذه القائمة إطلاقاً — سلوكهم يبقى كما هو.
const STAFF_ONLY_LINK_IDS = [
    'ticketsLink', 'chatAdminLink', 'usersLink', 'customerHistoryLink', 'bannedLink',
    'statsLink', 'activityLogLink', 'statusPageLink', 'settingsLink', 'suggestionsLink',
    'sendEmailLink', 'knowledgeBaseLink', 'subscriptionsLink', 'subdomainsLink', 'mcpLink'
];

function showLink(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'flex';
}

function hideLink(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
}

// نقطة واحدة تجلب صلاحيات المستخدم الحالي وتبني السايدبار بناءً عليها
// (بدلاً من عدة استعلامات منفصلة لنفس الملف الشخصي).
async function applySidebarPermissions() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data: profile } = await supabase
        .from('profiles')
        .select('email, role, whatsapp_enabled')
        .eq('id', user.id)
        .maybeSingle();

    if (!profile) return;

    const isMainAdmin = user.email === 'support@mad3oom.online';
    const isAdmin = profile.role === 'admin';
    const isSupport = profile.role === 'support';
    const isSuperUser = profile.role === 'super_user';

    // --- الصلاحيات الحالية (بدون أي تغيير في سلوكها) ---
    if (isAdmin) {
        showLink('errorTrackerLink');
        showLink('rewardsLink');
    }

    if (isMainAdmin) {
        showLink('superUserLink');
    }

    if (isSuperUser || isAdmin) {
        showLink('myUsersLink');
    }

    if (isMainAdmin || isAdmin || profile.whatsapp_enabled) {
        showLink('whatsappLink');
    }

    if (isAdmin || isSupport || isSuperUser) {
        showLink('agentsLink');
    }

    // --- سايدبار ديناميكي لـ Super User: إخفاء أقسام الإدارة العامة للمنصة ---
    if (isSuperUser && !isAdmin && !isSupport && !isMainAdmin) {
        STAFF_ONLY_LINK_IDS.forEach(hideLink);

        // --- عنوان لوحة مختلف لـ Super User فقط (تغيير نصي بحت، بدون مسارات/صفحات جديدة) ---
        const panelTitle = document.getElementById('adminPanelTitle');
        if (panelTitle) panelTitle.textContent = 'لوحة المسؤول';
    }
}

function highlightActiveLink() {
    const currentPath = window.location.pathname;
    const sidebarItems = document.querySelectorAll('.sidebar-item');
    
    sidebarItems.forEach(item => {
        const href = item.getAttribute('href');
        if (!href || href === '#') return;

        const cleanPath = currentPath.replace(/\/$/, '');
        const cleanHref = href.replace(/\/$/, '');

        if (cleanPath.endsWith(cleanHref) || 
           (cleanPath === '' && cleanHref === '/admin-dashboard.html') ||
           (cleanPath.endsWith('/admin/') && cleanHref.endsWith('/admin/dashboard.html')) ||
           (cleanPath.endsWith('/admin/dashboard.html') && cleanHref.endsWith('/admin-dashboard.html'))) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });
}
