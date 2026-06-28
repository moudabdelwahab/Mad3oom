// ==================== Theme Manager ====================
(function() {
    'use strict';
    
    const THEME_KEY = 'theme-preference';
    const NO_TRANSITION_CLASS = 'no-transition';
    
    function getStoredTheme() {
        try {
            if (typeof Storage !== 'undefined' && window.localStorage) {
                const stored = localStorage.getItem(THEME_KEY);
                if (stored === 'light' || stored === 'dark') return stored;
            }
        } catch (e) {
            console.warn('Unable to access localStorage:', e);
        }
        return null;
    }

    function getSystemTheme() {
        try {
            if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
                return 'dark';
            }
        } catch (e) {
            console.warn('Unable to detect system theme:', e);
        }
        return 'light';
    }

    function setThemeAttribute(theme) {
        if (document.documentElement && (theme === 'light' || theme === 'dark')) {
            document.documentElement.setAttribute('data-theme', theme);
        }
    }

    function applyTheme(theme, enableTransitions = true) {
        if (!theme || (theme !== 'light' && theme !== 'dark')) theme = 'light';

        if (!enableTransitions && document.documentElement) {
            document.documentElement.classList.add(NO_TRANSITION_CLASS);
        }

        setThemeAttribute(theme);

        try {
            if (typeof Storage !== 'undefined' && window.localStorage) {
                localStorage.setItem(THEME_KEY, theme);
            }
        } catch (e) {
            console.warn('Unable to save theme preference:', e);
        }

        if (!enableTransitions && document.documentElement) {
            setTimeout(() => {
                if (document.documentElement) {
                    document.documentElement.classList.remove(NO_TRANSITION_CLASS);
                }
            }, 100);
        }
    }

    function initializeTheme() {
        const theme = getStoredTheme() || getSystemTheme();
        setThemeAttribute(theme);
        return theme;
    }

    class ThemeManager {
        constructor() {
            this.currentTheme = getStoredTheme() || getSystemTheme() || 'light';
            this._delegated = false;
            this._observer = null;
            this.init();
        }

        init() {
            applyTheme(this.currentTheme, false);

            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => this.setupToggleButton());
            } else {
                this.setupToggleButton();
            }
        }

        applyTheme(theme, enableTransitions = true) {
            if (!theme || (theme !== 'light' && theme !== 'dark')) theme = 'light';
            this.currentTheme = theme;
            applyTheme(theme, enableTransitions);
        }

        toggleTheme() {
            const newTheme = this.currentTheme === 'light' ? 'dark' : 'light';
            this.applyTheme(newTheme, true);
            return newTheme;
        }

        setupToggleButton() {
            // ✅ Event delegation على document — يشتغل بغض النظر امتى الزر اتحمل
            // بنتحقق من _delegated عشان منضيفش listener أكتر من مرة
            if (!this._delegated) {
                document.addEventListener('click', (e) => {
                    // closest بيتحقق إن الكليك على الزر نفسه أو أي حاجة جواه (svg/path)
                    const btn = e.target.closest('#themeToggleBtn, .theme-toggle');
                    if (!btn) return;
                    // بنتأكد إنه مش notification button عشان ما يتعارضش مع غيره
                    if (btn.id === 'notificationBtn') return;
                    e.preventDefault();
                    e.stopPropagation();
                    this.toggleTheme();
                }, { capture: false });

                this._delegated = true;
            }

            // حدّث أيقونة أي زر موجود دلوقتي
            document.querySelectorAll('#themeToggleBtn, .theme-toggle').forEach(btn => {
                if (btn.id !== 'notificationBtn') this.updateToggleButton(btn);
            });

            // MutationObserver يراقب إضافة عناصر جديدة للـ DOM (زي الـ sidebar)
            // وكمان تغيير data-theme على html
            if (!this._observer) {
                this._observer = new MutationObserver((mutations) => {
                    let shouldUpdate = false;

                    for (const mutation of mutations) {
                        // لو اتضافت عناصر جديدة (sidebar fetch)
                        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                            shouldUpdate = true;
                            break;
                        }
                        // لو data-theme اتغير
                        if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
                            shouldUpdate = true;
                            break;
                        }
                    }

                    if (shouldUpdate) {
                        document.querySelectorAll('#themeToggleBtn, .theme-toggle').forEach(btn => {
                            if (btn.id !== 'notificationBtn') this.updateToggleButton(btn);
                        });
                    }
                });

                // نراقب الـ body للـ childList وdocumentElement للـ data-theme
                const target = document.body || document.documentElement;
                this._observer.observe(target, {
                    childList: true,
                    subtree: true
                });
                this._observer.observe(document.documentElement, {
                    attributes: true,
                    attributeFilter: ['data-theme']
                });
            }
        }

        updateToggleButton(button) {
            if (!button) return;
            const theme = document.documentElement.getAttribute('data-theme') || 'light';
            const sunIcon = button.querySelector('.sun-icon');
            const moonIcon = button.querySelector('.moon-icon');
            if (sunIcon && moonIcon) {
                sunIcon.style.display = theme === 'dark' ? 'block' : 'none';
                moonIcon.style.display = theme === 'dark' ? 'none' : 'block';
            }
        }

        getTheme() { return this.currentTheme; }

        setTheme(theme) {
            if (theme === 'light' || theme === 'dark') this.applyTheme(theme, true);
        }
    }

    // تطبيق الثيم فوراً قبل تحميل الـ DOM لمنع الوميض
    initializeTheme();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            window.themeManager = new ThemeManager();
        });
    } else {
        window.themeManager = new ThemeManager();
    }

    window.initTheme = function() {
        if (!window.themeManager) window.themeManager = new ThemeManager();
        return window.themeManager;
    };
})();
