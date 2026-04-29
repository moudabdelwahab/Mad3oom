/**
 * Language Manager - إدارة اللغات والترجمات
 * يدير تبديل اللغة بين العربية والإنجليزية
 */

const translations = {
    ar: {
        // القائمة المنسدلة
        'profile': 'الملف الشخصي',
        'account_settings': 'إعدادات الحساب',
        'security_settings': 'إعدادات الأمان',
        'help_support': 'الدعم والمساعدة',
        'logout': 'تسجيل الخروج',
        'language': 'اللغة',
        'change_language': 'تغيير اللغة',
        'arabic': 'العربية',
        'english': 'English',
        
        // رسائل عامة
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
        // Dropdown Menu
        'profile': 'Profile',
        'account_settings': 'Account Settings',
        'security_settings': 'Security Settings',
        'help_support': 'Help & Support',
        'logout': 'Logout',
        'language': 'Language',
        'change_language': 'Change Language',
        'arabic': 'العربية',
        'english': 'English',
        
        // General Messages
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

    /**
     * تهيئة اللغة عند التحميل
     */
    init() {
        this.updatePageLanguage(this.currentLanguage);
    }

    /**
     * تحميل اللغة المحفوظة من localStorage
     */
    loadLanguage() {
        const saved = localStorage.getItem('mad3oom-language');
        if (saved === 'ar' || saved === 'en') return saved;
        
        const browserLang = navigator.language.startsWith('ar') ? 'ar' : 'en';
        return browserLang;
    }

    /**
     * حفظ اللغة المختارة
     */
    saveLanguage(lang) {
        localStorage.setItem('mad3oom-language', lang);
        this.currentLanguage = lang;
    }

    /**
     * تغيير اللغة
     */
    setLanguage(lang) {
        if (lang !== 'ar' && lang !== 'en') {
            console.warn(`Invalid language: ${lang}`);
            return;
        }
        
        this.saveLanguage(lang);
        this.updatePageLanguage(lang);
        this.notifyListeners();
    }

    /**
     * الحصول على النص المترجم
     */
    translate(key) {
        const lang = this.currentLanguage;
        return translations[lang]?.[key] || translations['ar'][key] || key;
    }

    /**
     * تحديث لغة الصفحة
     */
    updatePageLanguage(lang) {
        const html = document.documentElement;
        if (html) {
            html.lang = lang;
            html.dir = lang === 'ar' ? 'rtl' : 'ltr';
        }
        
        // التأكد من أن body متاح قبل محاولة الوصول إلى style
        if (document.body) {
            document.body.style.direction = lang === 'ar' ? 'rtl' : 'ltr';
        } else {
            // إذا لم يكن body متاحاً بعد، ننتظر تحميل DOM
            document.addEventListener('DOMContentLoaded', () => {
                if (document.body) {
                    document.body.style.direction = lang === 'ar' ? 'rtl' : 'ltr';
                }
            });
        }
    }

    /**
     * تسجيل مستمع للتغييرات
     */
    onLanguageChange(callback) {
        this.listeners.push(callback);
    }

    /**
     * إخطار المستمعين بتغيير اللغة
     */
    notifyListeners() {
        this.listeners.forEach(callback => callback(this.currentLanguage));
    }

    /**
     * الحصول على اللغة الحالية
     */
    getLanguage() {
        return this.currentLanguage;
    }

    /**
     * التحقق من اللغة الحالية
     */
    isArabic() {
        return this.currentLanguage === 'ar';
    }

    isEnglish() {
        return this.currentLanguage === 'en';
    }
}

// إنشاء مثيل عام من LanguageManager
const languageManager = new LanguageManager();

// تصدير للاستخدام في الملفات الأخرى
if (typeof window !== 'undefined') {
    window.languageManager = languageManager;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = languageManager;
}
