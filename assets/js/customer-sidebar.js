export function initCustomerSidebar(onTabChange) {
    const sidebarContainer = document.getElementById('sidebar-container');
    if (!sidebarContainer) return;

    fetch('/assets/components/customer-sidebar.html')
        .then(response => response.text())
        .then(html => {
            sidebarContainer.innerHTML = html;
            setupSidebarLogic(onTabChange);
        })
        .catch(err => console.error('Error loading customer sidebar:', err));
}

function setupSidebarLogic(onTabChange) {
    const menuToggle = document.getElementById('menuToggle');
    const sidebar = document.getElementById('sidebar');
    const sidebarClose = document.getElementById('sidebarClose');
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    const customerAvatarBtn = document.getElementById('customerAvatarBtn');
    const customerAvatarMenu = document.getElementById('customerAvatarMenu');
    const notificationBtn = document.getElementById('notificationBtn');
    const notificationMenu = document.getElementById('notificationMenu');
    const sidebarItems = document.querySelectorAll('.sidebar-item[data-tab]');

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
            
            const unreadCount = notifications.filter(n => !n.is_read).length;
            if (badge) {
                badge.textContent = unreadCount;
                badge.style.display = unreadCount > 0 ? 'flex' : 'none';
            }

            if (notifications.length === 0) {
                list.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--color-text-secondary); font-size: 0.85rem;">لا توجد إشعارات</div>';
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
            console.error('[CustomerSidebar] Error loading notifications:', err);
            list.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--color-danger); font-size: 0.85rem;">فشل تحميل الإشعارات</div>';
        }
    }

    // Setup realtime subscription for notifications
    let notificationSubscription = null;
    async function setupNotificationRealtime() {
        try {
            const { subscribeToNotifications } = await import('/notifications-service.js');
            const { supabase } = await import('/api-config.js');
            const { data: { user } } = await supabase.auth.getUser();
            
            if (user && !notificationSubscription) {
                notificationSubscription = subscribeToNotifications(user.id, (newNotification) => {
                    loadNotifications();
                    if ('Notification' in window && Notification.permission === 'granted') {
                        new Notification(newNotification.title, {
                            body: newNotification.message,
                            icon: '/assets/images/logo.png'
                        });
                    }
                });
            }
        } catch (err) {
            console.error('[CustomerSidebar] Error setting up realtime notifications:', err);
        }
    }

    // Initial load
    loadNotifications();
    setupNotificationRealtime();

    const toggleSidebar = () => {
        sidebar.classList.toggle('active');
        sidebarOverlay.classList.toggle('active');
    };

    const menuToggles = [menuToggle, document.getElementById('mobileMenuToggle')].filter(Boolean);
    menuToggles.forEach(toggle => {
        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleSidebar();
        });
    });
    
    if (sidebarClose) sidebarClose.addEventListener('click', toggleSidebar);
    if (sidebarOverlay) sidebarOverlay.addEventListener('click', toggleSidebar);

    // Tab switching logic
    sidebarItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const tabName = item.getAttribute('data-tab');
            
            // Update active state in sidebar
            sidebarItems.forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            
            // Trigger tab change in main logic
            if (onTabChange) onTabChange(tabName);
            
            // Close sidebar on mobile
            if (window.innerWidth <= 768) {
                toggleSidebar();
            }
        });
    });

    // Language Toggle Logic
    const languageToggleBtn = document.getElementById('languageToggleBtn');
    const languageMenu = document.getElementById('languageMenu');
    const langArabic = document.getElementById('langArabic');
    const langEnglish = document.getElementById('langEnglish');

    if (languageToggleBtn && languageMenu) {
        languageToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = languageMenu.style.display === 'block';
            languageMenu.style.display = isVisible ? 'none' : 'block';
            updateLanguageCheckmarks();
        });

        langArabic?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            changeLanguage('ar');
            languageMenu.style.display = 'none';
        });

        langEnglish?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            changeLanguage('en');
            languageMenu.style.display = 'none';
        });
    }

    function updateLanguageCheckmarks() {
        const currentLang = localStorage.getItem('mad3oom-language') || 'ar';
        const arabicCheck = langArabic?.querySelector('.lang-check');
        const englishCheck = langEnglish?.querySelector('.lang-check');
        
        if (arabicCheck) arabicCheck.style.display = currentLang === 'ar' ? 'inline' : 'none';
        if (englishCheck) englishCheck.style.display = currentLang === 'en' ? 'inline' : 'none';
    }

    function changeLanguage(lang) {
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
    if (customerAvatarBtn && customerAvatarMenu) {
        customerAvatarBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = customerAvatarMenu.style.display === 'block';
            customerAvatarMenu.style.display = isVisible ? 'none' : 'block';
        });

        document.addEventListener('click', () => {
            customerAvatarMenu.style.display = 'none';
            if (notificationMenu) notificationMenu.style.display = 'none';
            if (languageMenu) languageMenu.style.display = 'none';
        });
    }

    // Handle menu item clicks
    const customerProfile = document.getElementById('customerProfile');
    const customerAccountSettings = document.getElementById('customerAccountSettings');
    const customerSecuritySettings = document.getElementById('customerSecuritySettings');
    const customerHelpSupport = document.getElementById('customerHelpSupport');

    if (customerProfile) {
        customerProfile.addEventListener('click', (e) => {
            e.preventDefault();
            // Navigate to profile page
            window.location.href = '#profile';
            customerAvatarMenu.style.display = 'none';
        });
    }

    if (customerAccountSettings) {
        customerAccountSettings.addEventListener('click', async (e) => {
            e.preventDefault();
            // Open settings modal instead of navigating
            if (window.openSettingsModal) {
                window.openSettingsModal();
            }
            customerAvatarMenu.style.display = 'none';
        });
    }

    if (customerSecuritySettings) {
        customerSecuritySettings.addEventListener('click', (e) => {
            e.preventDefault();
            // Open settings modal with security tab
            if (window.openSettingsModal) {
                window.openSettingsModal();
                // Switch to security tab
                setTimeout(() => {
                    const securityTab = document.querySelector('[data-tab="security"]');
                    if (securityTab) securityTab.click();
                }, 100);
            }
            customerAvatarMenu.style.display = 'none';
        });
    }

    if (customerHelpSupport) {
        customerHelpSupport.addEventListener('click', (e) => {
            e.preventDefault();
            // Navigate to help/support
            window.location.href = '/knowledge-base.html';
            customerAvatarMenu.style.display = 'none';
        });
    }

    // Handle logout
    const customerSignOut = document.getElementById('customerSignOut');
    const sidebarSignOut = document.getElementById('sidebarSignOut');
    
    const onLogout = async (e) => {
        e.preventDefault();
        try {
            const { logout } = await import('../auth-client.js');
            await logout();
            window.location.replace('sign-in.html');
        } catch (err) {
            console.error('Logout failed:', err);
            // Fallback: try to clear local storage and redirect
            localStorage.removeItem('mad3oom-guest-session');
            window.location.replace('sign-in.html');
        }
    };

    if (customerSignOut) customerSignOut.addEventListener('click', onLogout);
    if (sidebarSignOut) sidebarSignOut.addEventListener('click', onLogout);

    // Initialize language checkmarks on load
    updateLanguageCheckmarks();
}
