/**
 * Shared Constants for Mad3oom.online
 * Centralized configuration to avoid duplication across files
 */

// ==================== Ticket Status ====================
export const TICKET_STATUS = {
    OPEN: 'open',
    IN_PROGRESS: 'in-progress',
    RESOLVED: 'resolved'
};

export const TICKET_STATUS_LABELS = {
    [TICKET_STATUS.OPEN]: 'مفتوحة',
    [TICKET_STATUS.IN_PROGRESS]: 'قيد المعالجة',
    [TICKET_STATUS.RESOLVED]: 'محلولة'
};

// ==================== Ticket Priority ====================
export const TICKET_PRIORITY = {
    LOW: 'low',
    MEDIUM: 'medium',
    HIGH: 'high'
};

export const TICKET_PRIORITY_LABELS = {
    [TICKET_PRIORITY.LOW]: 'أولوية منخفضة',
    [TICKET_PRIORITY.MEDIUM]: 'أولوية متوسطة',
    [TICKET_PRIORITY.HIGH]: 'أولوية عالية'
};

export const TICKET_PRIORITY_CLASSES = {
    [TICKET_PRIORITY.LOW]: 'priority-low',
    [TICKET_PRIORITY.MEDIUM]: 'priority-medium',
    [TICKET_PRIORITY.HIGH]: 'priority-high'
};

// ==================== User Roles ====================
export const USER_ROLES = {
    ADMIN: 'admin',
    SUPPORT: 'support',
    SUPER_USER: 'super_user',
    CUSTOMER: 'customer',
    GUEST: 'guest'
};

export const USER_ROLE_LABELS = {
    [USER_ROLES.ADMIN]: 'مدير',
    [USER_ROLES.SUPPORT]: 'دعم فني',
    [USER_ROLES.SUPER_USER]: 'مسؤول شركة',
    [USER_ROLES.CUSTOMER]: 'مستخدم',
    [USER_ROLES.GUEST]: 'زائر'
};

// ==================== Activity Limits ====================
export const ACTIVITY_LIMITS = {
    DEFAULT: 50,
    MAX: 1000,
    ADMIN_DASHBOARD: 100
};

// ==================== Notification Types ====================
export const NOTIFICATION_TYPES = {
    INFO: 'info',
    SUCCESS: 'success',
    WARNING: 'warning',
    ERROR: 'error'
};

// ==================== Theme ====================
export const THEMES = {
    LIGHT: 'light',
    DARK: 'dark'
};

export const THEME_STORAGE_KEY = 'theme-preference';

// ==================== Local Storage Keys ====================
export const STORAGE_KEYS = {
    THEME: 'theme-preference',
    GUEST_SESSION: 'mad3oom-guest-session',
    DEVICE_FINGERPRINT: 'device_fingerprint',
    LAST_LOGIN_TIME: 'lastLoginTime'
};

// ==================== API Status ====================
export const API_KEY_STATUS = {
    ACTIVE: 'active',
    READ_ONLY: 'read_only',
    RATE_LIMITED: 'rate_limited',
    MAINTENANCE: 'maintenance'
};

export const API_KEY_STATUS_LABELS = {
    [API_KEY_STATUS.ACTIVE]: 'نشط',
    [API_KEY_STATUS.READ_ONLY]: 'للقراءة فقط',
    [API_KEY_STATUS.RATE_LIMITED]: 'محدد السرعة',
    [API_KEY_STATUS.MAINTENANCE]: 'صيانة'
};

// ==================== Ban Status ====================
export const BAN_STATUS = {
    NONE: null,
    TEMPORARY: 'temporary',
    PERMANENT: 'permanent'
};

// ==================== Report Status ====================
export const REPORT_STATUS = {
    PENDING: 'pending',
    APPROVED: 'approved',
    REJECTED: 'rejected'
};

// ==================== Severity Levels ====================
export const SEVERITY_LEVELS = {
    LOW: 'low',
    MEDIUM: 'medium',
    HIGH: 'high',
    CRITICAL: 'critical'
};

// ==================== Date Formats ====================
export const DATE_FORMATS = {
    LOCALE: 'ar-EG',
    TIME_OPTIONS: { hour: '2-digit', minute: '2-digit' },
    DATE_OPTIONS: { day: 'numeric', month: 'short' },
    FULL_OPTIONS: { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }
};

// ==================== Validation ====================
export const VALIDATION = {
    COMMON_DOMAINS: [
        'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 
        'aol.com', 'zoho.com', 'mail.com', 'protonmail.com', 'yandex.com',
        'live.com', 'msn.com', 'me.com'
    ],
    MIN_PASSWORD_LENGTH: 6,
    MAX_TICKET_TITLE_LENGTH: 200,
    MAX_TICKET_DESCRIPTION_LENGTH: 2000,
    MAX_REPLY_LENGTH: 1000
};

// ==================== Timeouts ====================
export const TIMEOUTS = {
    NOTIFICATION_DISPLAY: 3000,
    TOAST_DISPLAY: 3000,
    DEBOUNCE_SEARCH: 300,
    RETRY_DELAY: 500
};

// ==================== Helper Functions ====================

/**
 * Get ticket status label in Arabic
 * @param {string} status - Ticket status key
 * @returns {string} Arabic label
 */
export function getTicketStatusLabel(status) {
    return TICKET_STATUS_LABELS[status] || status;
}

/**
 * Get ticket priority label in Arabic
 * @param {string} priority - Priority key
 * @returns {string} Arabic label
 */
export function getTicketPriorityLabel(priority) {
    return TICKET_PRIORITY_LABELS[priority] || priority;
}

/**
 * Get user role label in Arabic
 * @param {string} role - Role key
 * @returns {string} Arabic label
 */
export function getUserRoleLabel(role) {
    return USER_ROLE_LABELS[role] || role;
}

/**
 * Check if user is admin or support
 * @param {string} role - User role
 * @returns {boolean}
 */
export function isAdminRole(role) {
    return role === USER_ROLES.ADMIN || role === USER_ROLES.SUPPORT;
}

/**
 * Format date in Arabic locale
 * @param {string|Date} date - Date to format
 * @param {object} options - Intl.DateTimeFormat options
 * @returns {string} Formatted date
 */
export function formatDate(date, options = {}) {
    return new Date(date).toLocaleString(DATE_FORMATS.LOCALE, options);
}

/**
 * Format date with time
 * @param {string|Date} date - Date to format
 * @returns {string} Formatted date with time
 */
export function formatDateTime(date) {
    return formatDate(date, DATE_FORMATS.FULL_OPTIONS);
}

/**
 * Format date only
 * @param {string|Date} date - Date to format
 * @returns {string} Formatted date
 */
export function formatDateOnly(date) {
    return new Date(date).toLocaleDateString(DATE_FORMATS.LOCALE);
}
