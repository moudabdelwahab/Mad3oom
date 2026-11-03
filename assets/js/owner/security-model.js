/**
 * security-model.js — تسميات وقواعد عرض مركز الأمان والصلاحيات (121). خالصة — tests/security-ui.test.mjs.
 * لا قرار أمان هنا: التحقق من القيم يكرر حدود القاعدة لرسالة أوضح فقط، والقاعدة ترفض ما يتجاوزها.
 */

export const EVENT_LABELS = Object.freeze({
    'auth.login': 'دخول ناجح',
    'auth.login_failed': 'محاولة دخول فاشلة',
    'auth.failed_burst': 'تكرار محاولات فاشلة',
    'auth.session_ended': 'خروج / انتهاء جلسة',
    'ip.shared': 'IP مشترك بين حسابات',
    'step_up.verified': 'فتح جلسة تحرير',
    'step_up.failed': 'رمز تحقق خاطئ',
    'step_up.ended': 'إنهاء جلسة تحرير',
    'permission.changed': 'تغيير صلاحية دور',
    'security_policy.changed': 'تغيير سياسة الأمان',
    'settings.rolled_back': 'تراجع عن تغيير',
    'session.revoked': 'إلغاء جلسة',
    'session.global_logout': 'خروج من كل الأجهزة',
    'owner.password_change_blocked': 'حجز تغيير كلمة مرور المالك',
    'owner.email_change_blocked': 'حجز تغيير بريد المالك',
    'owner.password_change_approved': 'موافقة على تغيير كلمة المرور',
    'owner.email_change_approved': 'موافقة على تغيير البريد',
    'owner.password_change_rejected': 'رفض تغيير كلمة المرور',
    'owner.email_change_rejected': 'رفض تغيير البريد',
    'owner.account_change_bad_token': 'رابط موافقة/رفض غير صالح',
    'access.denied': 'محاولة وصول غير مصرّح بها',
    'alert.sent': 'أُرسل تنبيه بالبريد',
    'alert.failed': 'تعذّر إرسال تنبيه'
});

/** أسماء عمليات privileged_audit (053) داخل سجل جلسات التحرير */
const AUDIT_LABELS = Object.freeze({
    'role.change': 'تغيير رتبة', 'account.restriction': 'حظر / قفل حساب', 'security_policy.set': 'تغيير سياسة الأمان',
    'permission.set': 'تغيير صلاحيات دور', 'platform_authority.insert': 'منح سلطة منصة', 'platform_authority.delete': 'سحب سلطة منصة',
    'platform_capability_grants.insert': 'منح تفويض', 'platform_capability_grants.delete': 'سحب تفويض'
});

export const SEVERITY = Object.freeze({
    info: { label: 'معلومة', pill: 'status-neutral' },
    notice: { label: 'ملاحظة', pill: 'status-open' },
    warning: { label: 'تحذير', pill: 'status-pending' },
    critical: { label: 'حرج', pill: 'status-rejected' }
});

export const CHANGE_TABLE_LABELS = Object.freeze({
    advanced_settings: 'الإعدادات المتقدمة', working_hours: 'ساعات العمل', ticket_distribution_config: 'توزيع التذاكر',
    rules_engine: 'قواعد الأتمتة', custom_roles: 'الأدوار المخصصة', owner_security_policy: 'سياسة الأمان',
    role_permission_rules: 'مصفوفة الصلاحيات'
});

export const PERMISSION_CATEGORIES = Object.freeze({
    platform: 'المنصة', content: 'المحتوى', support: 'الدعم والتذاكر', users: 'المستخدمون'
});

export const eventLabel = (type) => EVENT_LABELS[type] || AUDIT_LABELS[type] || type;

const FAILURE = { invalid_credentials: 'بيانات دخول خاطئة', email_not_confirmed: 'بريد غير مؤكَّد', rate_limited: 'تجاوز الحد',
                  banned: 'حساب محظور', mfa_failed: 'رمز التحقق خاطئ', other: 'سبب آخر' };

/** سطر قصير يشرح الحدث من تفاصيله — بلا أي قيمة سرية (لا تُحفظ أصلًا). */
export function eventSummary(e) {
    const d = e?.details || {};
    switch (e?.event_type) {
        case 'auth.login': return d.new_ip ? 'من عنوان جديد لهذا الحساب' : '';
        case 'auth.login_failed': return FAILURE[d.reason] || '';
        case 'auth.failed_burst': return `${d.failures ?? '?'} محاولة خلال ${d.window_minutes ?? 15} دقيقة`;
        case 'auth.session_ended': return { revoked_by_owner: 'ألغاها المالك', global_logout: 'خروج من كل الأجهزة',
            account_change_approved: 'بعد الموافقة على تغيير الحساب', account_change_rejected: 'بعد رفض تغيير الحساب' }[d.reason] || 'خروج أو انتهاء';
        case 'ip.shared': return `مع ${(d.other_accounts || []).length} حساب آخر خلال ${d.window_days ?? '?'} يومًا`;
        case 'step_up.verified': return `${d.method === 'recovery_code' ? 'برمز استرداد' : 'بتطبيق المصادقة'} لمدة ${d.minutes ?? '?'} دقيقة`;
        case 'step_up.failed': return d.locked ? 'قُفل التحقق 15 دقيقة' : `المحاولة ${d.attempts ?? '?'}`;
        case 'permission.changed': return `${d.role === 'platform_owner' ? 'المالك' : d.role}: ${d.permission} ← ${d.new ? 'نعم' : 'لا'}`;
        case 'access.denied': return d.action || '';
        case 'alert.sent': case 'alert.failed': return d.kind || '';
        default: return '';
    }
}

/**
 * قيم نموذج السياسة ⇒ حمولة owner_set_security_policy، أو رسالة خطأ. نفس حدود القاعدة.
 * @returns {{ ok: true, payload: object } | { ok: false, message: string }}
 */
export function policyPayload({ minutes, passwordLocked, emailLocked, loginAlerts, sharedWindow, failThreshold }) {
    const int = (v) => (String(v ?? '').trim() === '' ? NaN : Number(v));
    const m = int(minutes);
    if (!Number.isInteger(m) || m < 1 || m > 240) return { ok: false, message: 'مدة جلسة التحرير بين 1 و240 دقيقة.' };
    const w = int(sharedWindow);
    if (!Number.isInteger(w) || w < 1 || w > 365) return { ok: false, message: 'نافذة IP المشترك بين 1 و365 يومًا.' };
    const f = int(failThreshold);
    if (!Number.isInteger(f) || f < 3 || f > 50) return { ok: false, message: 'حد المحاولات الفاشلة بين 3 و50.' };
    return { ok: true, payload: { step_up_minutes: m, password_change_locked: !!passwordLocked, email_change_locked: !!emailLocked,
                                  login_alerts: !!loginAlerts, shared_ip_window_days: w, failed_login_threshold: f } };
}

const OUTCOME = {
    step_up_required: 'لم يكتمل التحقق بخطوتين — لم يُنفَّذ شيء.',
    forbidden: 'مرفوض: لمالك المنصة وحده داخل واجهته.',
    invalid: 'قيمة غير مقبولة.',
    out_of_range: 'قيمة خارج الحدود المسموحة.',
    current_session: 'الجلسة الحالية لا تُلغى من هنا.',
    not_staff_account: 'ليس حساب فريق منصة.',
    not_found: 'غير موجود.',
    already_rolled_back: 'تم التراجع عنه من قبل.',
    not_reversible: 'هذا التغيير لا يُتراجع عنه من هنا.',
    invalid_token: 'الرابط غير صالح أو استُخدم من قبل.',
    expired: 'انتهت مهلة الطلب (30 دقيقة).'
};

/** نتيجة نداء RPC كتابة: خطأ PostgREST، أو { ok:false, error }، أو نجاح. */
export function rpcOutcome({ data, error }) {
    if (error) return { ok: false, message: error.message || 'تعذّر التنفيذ.' };
    if (data && data.ok === false) {
        const key = String(data.error || '');
        return { ok: false, code: key, message: OUTCOME[key] || (key.startsWith('already_') ? 'تم البت في الطلب من قبل.' : 'تعذّر التنفيذ.') };
    }
    return { ok: true, data };
}

/** صفوف المصفوفة مجمّعة حسب الفئة بترتيب الكتالوج. */
export function groupPermissions(perms) {
    const groups = [];
    for (const p of perms || []) {
        let g = groups.find(x => x.category === p.category);
        if (!g) groups.push(g = { category: p.category, label: PERMISSION_CATEGORIES[p.category] || p.category, items: [] });
        g.items.push(p);
    }
    return groups;
}
