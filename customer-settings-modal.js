import { supabase } from './api-config.js';
import { renderChatbotModeInto } from './assets/js/chatbot-mode-selector.js';

// التحقق بخطوتين والأجهزة الموثوقة كانت منسوخة هنا بقواعد مختلفة (رموز
// استعادة من Math.random، و HTML بلا هروب). صارت في قسم «الأمان» باللوحة
// عبر الوحدة الموحّدة assets/js/account، وتبويب الأمان هنا رابط إليها.
let currentUser = null;

/**
 * Initialize the customer settings modal
 */
export async function initCustomerSettingsModal() {
    const container = document.createElement('div');
    container.id = 'settings-modal-container';
    document.body.appendChild(container);

    // Load the modal HTML
    try {
        const response = await fetch('/customer-settings-modal.html');
        const html = await response.text();
        container.innerHTML = html;
        setupSettingsModalLogic();
    } catch (err) {
        console.error('Error loading settings modal:', err);
    }
}

/**
 * Setup all modal logic and event listeners
 */
async function setupSettingsModalLogic() {
    const modal = document.getElementById('customerSettingsModal');
    const closeBtn = document.getElementById('closeSettingsModal');
    const closeFooterBtn = document.getElementById('closeSettingsBtn');
    if (!modal) return;

    // Get current user
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        console.error('No user logged in');
        return;
    }

    currentUser = user;

    // Setup tab switching
    setupTabSwitching();

    // Setup general settings
    setupGeneralSettings();

    // Close modal handlers
    if (closeBtn) {
        closeBtn.addEventListener('click', () => closeSettingsModal());
    }

    if (closeFooterBtn) {
        closeFooterBtn.addEventListener('click', () => closeSettingsModal());
    }

    // Close on outside click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeSettingsModal();
        }
    });

    // رابط تبويب الأمان يفتح القسم في نفس اللوحة، فتُغلق النافذة معه
    document.getElementById('openSecuritySectionLink')?.addEventListener('click', () => closeSettingsModal());
}

/**
 * Setup tab switching functionality
 */
function setupTabSwitching() {
    const tabButtons = document.querySelectorAll('.settings-tab-btn');
    const tabContents = document.querySelectorAll('.settings-tab-content');
    let chatbotTabLoaded = false;

    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabName = btn.getAttribute('data-tab');

            // Update active button
            tabButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // Update active content
            tabContents.forEach(content => {
                if (content.getAttribute('data-tab') === tabName) {
                    content.classList.add('active');
                    content.style.display = 'block';
                } else {
                    content.classList.remove('active');
                    content.style.display = 'none';
                }
            });

            // تحميل قسم "الشات بوت" (خطة SIE واستخدامها) عند أول فتح فقط (Lazy load) بدل تحميله
            // دايمًا حتى لو المستخدم مافتحش التبويب ده أبدًا في هذه الجلسة
            if (tabName === 'chatbot' && !chatbotTabLoaded) {
                chatbotTabLoaded = true;
                const container = document.getElementById('chatbotModeSettingsContainer');
                if (container && currentUser) {
                    renderChatbotModeInto(container, { userId: currentUser.id });
                }
            }
        });
    });
}

/**
 * Setup general settings (language and theme)
 */
function setupGeneralSettings() {
    const languageSelect = document.getElementById('languageSelect');
    const themeButtons = document.querySelectorAll('.theme-option-btn');

    // Load saved language
    const savedLanguage = localStorage.getItem('mad3oom-language') || 'ar';
    languageSelect.value = savedLanguage;

    // Language change handler
    languageSelect.addEventListener('change', (e) => {
        const lang = e.target.value;
        localStorage.setItem('mad3oom-language', lang);

        if (window.languageManager) {
            window.languageManager.setLanguage(lang);
        } else {
            const html = document.documentElement;
            html.lang = lang;
            html.dir = lang === 'ar' ? 'rtl' : 'ltr';
            document.body.style.direction = lang === 'ar' ? 'rtl' : 'ltr';
        }

        showAlert('تم تغيير اللغة بنجاح', 'success');
    });

    // Load saved theme
    const savedTheme = localStorage.getItem('theme-preference') || 'light';
    themeButtons.forEach(btn => {
        if (btn.getAttribute('data-theme') === savedTheme) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }

        btn.addEventListener('click', () => {
            const theme = btn.getAttribute('data-theme');
            localStorage.setItem('theme-preference', theme);

            if (window.themeManager) {
                window.themeManager.setTheme(theme);
            } else {
                document.documentElement.setAttribute('data-theme', theme);
            }

            // Update button states
            themeButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            showAlert('تم تغيير السمة بنجاح', 'success');
        });
    });
}

/**
 * Show alert message
 */
function showAlert(message, type) {
    const alert = document.getElementById('settingsAlert');
    if (!alert) return;

    alert.textContent = message;
    alert.className = `alert alert-${type}`;
    alert.style.display = 'block';

    setTimeout(() => {
        alert.style.display = 'none';
    }, 5000);
}

/**
 * Open settings modal
 */
export function openSettingsModal() {
    const modal = document.getElementById('customerSettingsModal');
    if (modal) {
        modal.classList.add('active');
    }
}

/**
 * Close settings modal
 */
function closeSettingsModal() {
    const modal = document.getElementById('customerSettingsModal');
    if (modal) {
        modal.classList.remove('active');
    }
}

/**
 * Export for global access
 */
window.openSettingsModal = openSettingsModal;
