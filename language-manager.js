/**
 * Language Manager - إدارة اللغات والترجمات
 * يدير تبديل اللغة بين العربية والإنجليزية
 */

const translations = {
    ar: {
        'profile': 'الملف الشخصي',
        'account_settings': 'إعدادات الحساب',
        'security_settings': 'إعدادات الأمان',
        'help_support': 'الدعم والمساعدة',
        'logout': 'تسجيل الخروج',
        'language': 'اللغة',
        'change_language': 'تغيير اللغة',
        'arabic': 'العربية',
        'english': 'English',
        'welcome_user': 'مرحباً بك',
        'customer_dashboard': 'لوحة تحكم العميل',
        'admin_dashboard': 'لوحة الإدارة',
        'my_tickets': 'تذاكري',
        'rewards_points': 'المكافآت والنقاط',
        'badges': 'الشارات',
        'live_chat': 'المحادثة الفورية',
        'community': 'مجتمع مدعوم',
        'knowledge_base': 'قاعدة المعرفة',
        'system_status': 'النظام شغال',
        'notifications': 'الإشعارات',
        'mark_all_read': 'تحديد الكل كمقروء',
        'view_all_notifications': 'عرض كل الإشعارات',
        'no_notifications': 'لا توجد إشعارات',
        'loading_notifications': 'جاري تحميل الإشعارات...',
        'failed_load_notifications': 'فشل تحميل الإشعارات',
        'my_profile': 'ملفي الشخصي',
        'edit_profile': 'تعديل الملف الشخصي',
        'account_security': 'أمان الحساب',
        'privacy_settings': 'إعدادات الخصوصية',
        'contact_support': 'التواصل مع الدعم',
        'faq': 'الأسئلة الشائعة',
        'documentation': 'التوثيق',
        'admin_panel': 'لوحة الإدارة',
        'manage_users': 'إدارة المستخدمين',
        'manage_tickets': 'إدارة التذاكر',
        'manage_files': 'إدارة الملفات',
        'system_settings': 'إعدادات النظام',
    },
    en: {
        'profile': 'Profile',
        'account_settings': 'Account Settings',
        'security_settings': 'Security Settings',
        'help_support': 'Help & Support',
        'logout': 'Logout',
        'language': 'Language',
        'change_language': 'Change Language',
        'arabic': 'العربية',
        'english': 'English',
        'welcome_user': 'Welcome',
        'customer_dashboard': 'Customer Dashboard',
        'admin_dashboard': 'Admin Dashboard',
        'my_tickets': 'My Tickets',
        'rewards_points': 'Rewards & Points',
        'badges': 'Badges',
        'live_chat': 'Live Chat',
        'community': 'Mad3oom Community',
        'knowledge_base': 'Knowledge Base',
        'system_status': 'System Online',
        'notifications': 'Notifications',
        'mark_all_read': 'Mark All as Read',
        'view_all_notifications': 'View All Notifications',
        'no_notifications': 'No Notifications',
        'loading_notifications': 'Loading Notifications...',
        'failed_load_notifications': 'Failed to Load Notifications',
        'my_profile': 'My Profile',
        'edit_profile': 'Edit Profile',
        'account_security': 'Account Security',
        'privacy_settings': 'Privacy Settings',
        'contact_support': 'Contact Support',
        'faq': 'FAQ',
        'documentation': 'Documentation',
        'admin_panel': 'Admin Panel',
        'manage_users': 'Manage Users',
        'manage_tickets': 'Manage Tickets',
        'manage_files': 'Manage Files',
        'system_settings': 'System Settings',
    }
};

class LanguageManager {
    constructor() {
        this.currentLanguage = this.loadLanguage();
        this.listeners = [];
        this.init();
    }

    init() {
        // طبّق اللغة فوراً على <html> قبل أي حاجة
        this._applyToHTML(this.currentLanguage);

        // لما DOM يكون جاهز، طبّق على <body> والعناصر
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                this._applyToBody(this.currentLanguage);
                this._applyTranslations(this.currentLanguage);
            }, { once: true });
        } else {
            this._applyToBody(this.currentLanguage);
            this._applyTranslations(this.currentLanguage);
        }
    }

    loadLanguage() {
        const saved = localStorage.getItem('mad3oom-language');
        if (saved === 'ar' || saved === 'en') return saved;
        return navigator.language.startsWith('ar') ? 'ar' : 'en';
    }

    saveLanguage(lang) {
        localStorage.setItem('mad3oom-language', lang);
        this.currentLanguage = lang;
    }

    setLanguage(lang) {
        if (lang !== 'ar' && lang !== 'en') {
            console.warn(`Invalid language: ${lang}`);
            return;
        }
        this.saveLanguage(lang);
        this._applyToHTML(lang);
        this._applyToBody(lang);
        this._applyTranslations(lang);
        this.notifyListeners();
    }

    /**
     * يطبّق dir و lang على <html> فقط — بيشتغل حتى لو DOM لسه مش جاهز
     */
    _applyToHTML(lang) {
        const html = document.documentElement;
        html.lang = lang;
        html.dir = lang === 'ar' ? 'rtl' : 'ltr';
    }

    /**
     * يطبّق dir على <body> — بس لما body يكون موجود
     * بيستخدم setAttribute مش style.direction عشان يتوارث صح
     */
    _applyToBody(lang) {
        if (!document.body) return;
        // نمسح أي inline style قديم ونسيب الـ dir يتوارث من <html>
        document.body.style.removeProperty('direction');
        document.body.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
    }

    /**
     * يترجم كل العناصر اللي عندها data-i18n
     */
    _applyTranslations(lang) {
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            const text = translations[lang]?.[key] || translations['ar'][key] || key;
            el.textContent = text;
        });
    }

    // ===== Legacy method — محتفظ بيه عشان كود تاني ممكن يستخدمه =====
    updatePageLanguage(lang) {
        this._applyToHTML(lang);
        this._applyToBody(lang);
    }

    translate(key) {
        return translations[this.currentLanguage]?.[key]
            || translations['ar'][key]
            || key;
    }

    onLanguageChange(callback) {
        this.listeners.push(callback);
    }

    notifyListeners() {
        this.listeners.forEach(cb => cb(this.currentLanguage));
    }

    getLanguage() { return this.currentLanguage; }
    isArabic()    { return this.currentLanguage === 'ar'; }
    isEnglish()   { return this.currentLanguage === 'en'; }
}

// مثيل عام
const languageManager = new LanguageManager();

if (typeof window !== 'undefined') {
    window.languageManager = languageManager;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = languageManager;
}
