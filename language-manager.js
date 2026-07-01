/**
 * Language Manager - إدارة اللغات والترجمات
 */

const translations = {
    ar: {
        'sidebar_main_menu': 'القائمة الرئيسية',
        'sidebar_dashboard': 'لوحة التحكم',
        'sidebar_tickets': 'إدارة التذاكر',
        'sidebar_chat': 'المحادثات والبوت',
        'sidebar_users': 'المستخدمين',
        'sidebar_super_users': 'Super Users',
        'sidebar_my_users': 'مستخدميني',
        'sidebar_banned': 'المحظورين',
        'sidebar_stats': 'الإحصائيات',
        'sidebar_activity': 'سجل النشاط',
        'sidebar_status': 'حالة الخدمات',
        'sidebar_settings': 'إعدادات المنصة',
        'sidebar_community': 'مجتمع مدعوم',
        'sidebar_suggestions': 'إدارة الاقتراحات',
        'sidebar_send_email': 'إرسال بريد',
        'sidebar_knowledge': 'قاعدة المعرفة',
        'sidebar_errors': 'مشاكل الموقع',
        'sidebar_subscriptions': 'إدارة الاشتراكات',
        'sidebar_subdomains': 'النطاقات الفرعية',
        'sidebar_whatsapp': 'واتساب',
        'sidebar_logout': 'تسجيل الخروج',
        'nav_admin_panel': 'لوحة الإدارة',
        'nav_admin_badge': 'مدير النظام',
        'nav_notifications': 'الإشعارات',
        'nav_mark_all_read': 'تحديد الكل كمقروء',
        'nav_view_all': 'عرض كل الإشعارات',
        'nav_loading_notif': 'جاري تحميل الإشعارات...',
        'nav_no_notif_admin': 'لا توجد إشعارات إدارية',
        'nav_lang_arabic': 'العربية',
        'nav_lang_english': 'English',
        'avatar_profile': 'الملف الشخصي',
        'avatar_settings': 'إعدادات الحساب',
        'avatar_security': 'إعدادات الأمان',
        'avatar_help': 'الدعم والمساعدة',
        'avatar_logout': 'تسجيل الخروج',
        'dashboard_title': 'لوحة التحكم الرئيسية',
        'dashboard_subtitle': 'إدارة شاملة لجميع أقسام المنصة من مكان واحد',
        'card_tickets_title': 'إدارة التذاكر',
        'card_tickets_open': 'المفتوحة',
        'card_tickets_closed': 'المغلقة',
        'card_tickets_inprogress': 'قيد المعالجة',
        'card_tickets_resolved': 'تم الحل',
        'card_tickets_footer': 'انقر للوصول إلى إدارة التذاكر ←',
        'card_chat_title': 'المحادثات الفورية',
        'card_chat_active': 'جارية',
        'card_chat_closed': 'مغلقة',
        'card_chat_footer': 'انقر للوصول إلى المحادثات ←',
        'card_users_title': 'إدارة المستخدمين',
        'card_users_total': 'إجمالي',
        'card_users_active': 'نشط',
        'card_users_footer': 'انقر للوصول إلى المستخدمين ←',
        'card_forum_title': 'إدارة المنتدى',
        'card_forum_threads': 'المواضيع',
        'card_forum_reports': 'البلاغات',
        'card_forum_footer': 'انقر للوصول إلى المنتدى ←',
        'card_banned_title': 'المحظورين',
        'card_banned_count': 'عدد المحظورين',
        'card_banned_last': 'آخر حظر',
        'card_banned_footer': 'انقر لعرض المحظورين ←',
        'card_stats_title': 'الإحصائيات',
        'card_stats_visits': 'إجمالي الزيارات',
        'card_stats_response': 'معدل الاستجابة',
        'card_stats_footer': 'انقر لعرض الإحصائيات ←',
        'card_activity_title': 'سجل النشاطات',
        'card_activity_today': 'نشاطات اليوم',
        'card_activity_last': 'آخر نشاط',
        'card_activity_footer': 'انقر لعرض سجل النشاطات ←',
        'card_settings_title': 'الإعدادات',
        'card_settings_label': 'إعدادات النظام',
        'card_settings_footer': 'انقر للوصول إلى الإعدادات ←',

        // ==================== صفحة MCP ====================
        mcp_page_title: "إدارة خوادم MCP",
        mcp_page_subtitle: "إدارة وربط خوادم Model Context Protocol",
        mcp_stat_total: "إجمالي الخوادم",
        mcp_stat_connected: "خوادم متصلة",
        mcp_stat_error: "بها أخطاء",
        mcp_stat_tools: "إجمالي الأدوات",
        mcp_filter_status: "الحالة",
        mcp_filter_transport: "نوع النقل",
        mcp_search: "بحث",
        mcp_add: "إضافة خادم",
        mcp_refresh: "تحديث",
        mcp_status_all: "كل الحالات",
        mcp_status_connected: "متصل",
        mcp_status_disconnected: "غير متصل",
        mcp_status_error: "خطأ",
        mcp_status_error_opt: "خطأ",
        mcp_status_pending: "بانتظار",
        mcp_transport_all: "كل الأنواع",
        mcp_search_placeholder: "ابحث عن خادم...",
        mcp_loading: "جاري تحميل خوادم MCP...",
        mcp_activity_title: "آخر النشاطات",
        mcp_activity_empty: "لا يوجد نشاط مسجّل بعد",
        mcp_hint_apikey: "يُحفظ بأمان ولا يُعرض بعد الحفظ. اتركه فارغاً عند التعديل للإبقاء على القيمة الحالية.",
    },
    en: {
        'sidebar_main_menu': 'Main Menu',
        'sidebar_dashboard': 'Dashboard',
        'sidebar_tickets': 'Ticket Management',
        'sidebar_chat': 'Chats & Bot',
        'sidebar_users': 'Users',
        'sidebar_super_users': 'Super Users',
        'sidebar_my_users': 'My Users',
        'sidebar_banned': 'Banned Users',
        'sidebar_stats': 'Statistics',
        'sidebar_activity': 'Activity Log',
        'sidebar_status': 'Service Status',
        'sidebar_settings': 'Platform Settings',
        'sidebar_community': 'Mad3oom Community',
        'sidebar_suggestions': 'Suggestions',
        'sidebar_send_email': 'Send Email',
        'sidebar_knowledge': 'Knowledge Base',
        'sidebar_errors': 'Site Issues',
        'sidebar_subscriptions': 'Subscriptions',
        'sidebar_subdomains': 'Subdomains',
        'sidebar_whatsapp': 'WhatsApp',
        'sidebar_logout': 'Logout',
        'nav_admin_panel': 'Admin Panel',
        'nav_admin_badge': 'System Admin',
        'nav_notifications': 'Notifications',
        'nav_mark_all_read': 'Mark All as Read',
        'nav_view_all': 'View All Notifications',
        'nav_loading_notif': 'Loading notifications...',
        'nav_no_notif_admin': 'No admin notifications',
        'nav_lang_arabic': 'العربية',
        'nav_lang_english': 'English',
        'avatar_profile': 'Profile',
        'avatar_settings': 'Account Settings',
        'avatar_security': 'Security Settings',
        'avatar_help': 'Help & Support',
        'avatar_logout': 'Logout',
        'dashboard_title': 'Main Dashboard',
        'dashboard_subtitle': 'Manage all platform sections from one place',
        'card_tickets_title': 'Ticket Management',
        'card_tickets_open': 'Open',
        'card_tickets_closed': 'Closed',
        'card_tickets_inprogress': 'In Progress',
        'card_tickets_resolved': 'Resolved',
        'card_tickets_footer': 'Click to access ticket management →',
        'card_chat_title': 'Live Chats',
        'card_chat_active': 'Active',
        'card_chat_closed': 'Closed',
        'card_chat_footer': 'Click to access chats →',
        'card_users_title': 'User Management',
        'card_users_total': 'Total',
        'card_users_active': 'Active',
        'card_users_footer': 'Click to access users →',
        'card_forum_title': 'Forum Management',
        'card_forum_threads': 'Threads',
        'card_forum_reports': 'Reports',
        'card_forum_footer': 'Click to access forum →',
        'card_banned_title': 'Banned Users',
        'card_banned_count': 'Banned Count',
        'card_banned_last': 'Last Ban',
        'card_banned_footer': 'Click to view banned users →',
        'card_stats_title': 'Statistics',
        'card_stats_visits': 'Total Visits',
        'card_stats_response': 'Response Rate',
        'card_stats_footer': 'Click to view statistics →',
        'card_activity_title': 'Activity Log',
        'card_activity_today': "Today's Activities",
        'card_activity_last': 'Last Activity',
        'card_activity_footer': 'Click to view activity log →',
        'card_settings_title': 'Settings',
        'card_settings_label': 'System Settings',
        'card_settings_footer': 'Click to access settings →',

        // ==================== MCP Page ====================
        mcp_page_title: "MCP Servers Management",
        mcp_page_subtitle: "Manage and connect Model Context Protocol servers",
        mcp_stat_total: "Total Servers",
        mcp_stat_connected: "Connected Servers",
        mcp_stat_error: "With Errors",
        mcp_stat_tools: "Total Tools",
        mcp_filter_status: "Status",
        mcp_filter_transport: "Transport Type",
        mcp_search: "Search",
        mcp_add: "Add Server",
        mcp_refresh: "Refresh",
        mcp_status_all: "All Statuses",
        mcp_status_connected: "Connected",
        mcp_status_disconnected: "Disconnected",
        mcp_status_error: "Error",
        mcp_status_error_opt: "Error",
        mcp_status_pending: "Pending",
        mcp_transport_all: "All Types",
        mcp_search_placeholder: "Search by name or URL...",
        mcp_loading: "Loading MCP servers...",
        mcp_activity_title: "Recent Activity",
        mcp_activity_empty: "No activity logged yet",
        mcp_hint_apikey: "Stored securely and never shown after saving. Leave empty when editing to keep the current value.",
    }
};

class LanguageManager {
    constructor() {
        this.currentLanguage = this._loadLanguage();
        this.listeners = [];
        // طبّق على <html> فوراً قبل أي حاجة
        this._applyToHTML(this.currentLanguage);
        // طبّق الترجمات بعد تحميل الـ DOM
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

    _loadLanguage() {
        try {
            const saved = localStorage.getItem('mad3oom-language');
            if (saved === 'ar' || saved === 'en') return saved;
        } catch(e) {}
        return navigator.language.startsWith('ar') ? 'ar' : 'en';
    }

    _applyToHTML(lang) {
        document.documentElement.lang = lang;
        document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    }

    _applyToBody(lang) {
        if (!document.body) return;
        document.body.style.removeProperty('direction');
        document.body.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
    }

    // يطبق الترجمات على عناصر data-i18n داخل container معين (أو كامل الـ document)
    _applyTranslations(lang, container) {
        const root = container || document;
        root.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            const text = translations[lang]?.[key] || translations['ar'][key] || key;
            el.textContent = text;
        });
    }

    setLanguage(lang) {
        if (lang !== 'ar' && lang !== 'en') return;
        try { localStorage.setItem('mad3oom-language', lang); } catch(e) {}
        this.currentLanguage = lang;
        this._applyToHTML(lang);
        this._applyToBody(lang);
        this._applyTranslations(lang);
        this.notifyListeners();
    }

    // يُستدعى من sidebar.js بعد fetch الـ sidebar
    applyToContainer(container) {
        this._applyTranslations(this.currentLanguage, container);
    }

    translate(key) {
        return translations[this.currentLanguage]?.[key]
            || translations['ar'][key]
            || key;
    }

    // legacy support
    updatePageLanguage(lang) {
        this._applyToHTML(lang);
        this._applyToBody(lang);
    }

    onLanguageChange(callback) { this.listeners.push(callback); }
    notifyListeners() { this.listeners.forEach(cb => cb(this.currentLanguage)); }
    getLanguage() { return this.currentLanguage; }
    isArabic()   { return this.currentLanguage === 'ar'; }
    isEnglish()  { return this.currentLanguage === 'en'; }
}

const languageManager = new LanguageManager();
if (typeof window !== 'undefined') window.languageManager = languageManager;
if (typeof module !== 'undefined' && module.exports) module.exports = languageManager;
