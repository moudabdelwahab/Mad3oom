/**
 * registration-mode.js — أي نموذج تسجيل يراه الزائر؟
 *
 * المصدر الوحيد: get_public_registration_settings() (migrations/109)، وهي تعيد
 * mode (open | waitlist | null) ونص الانتظار وموعد الإطلاق فقط.
 *
 * القاعدة: التسجيل المفتوح لا يُعرض إلا إذا قالت القاعدة 'open' صراحةً. أي
 * خطأ أو رد فارغ أو قيمة غير معروفة يعني 'unavailable'، لا 'open'. كانت
 * login.html تعتبر الفشل «مفتوحًا»، فرأى الزائر «إنشاء حساب جديد» شهورًا
 * والإعداد waitlist (العطل الذي يصلحه 109).
 *
 * دوال خالصة بلا DOM ولا شبكة، فتُختبر مباشرة (tests/registration-mode.test.mjs).
 */

export const REGISTRATION_MODE = Object.freeze({
    open: 'open',
    waitlist: 'waitlist',
    unavailable: 'unavailable'
});

/** نص الانتظار إن غاب من الإعداد. الموعد لا يُخمَّن: يأتي من القاعدة أو لا يُذكر. */
export const DEFAULT_WAITLIST_MESSAGE = [
    'شكرًا لتسجيلك في مدعوم.',
    'نستعد حاليًا للإطلاق الرسمي للمنصة، وحرصًا منا على تقديم أفضل تجربة وجودة خدمة منذ اليوم الأول، سيتم إضافة بياناتك إلى قائمة الانتظار في الوقت الحالي.',
    'عند الإطلاق، سنرسل إليك رابط تفعيل حسابك مباشرة.',
    'موعد الإطلاق المتوقع: {{launch_date}}',
    'نشكرك على اهتمامك بمدعوم، ونتطلع لانضمامك إلينا.'
].join('\n\n');

export const UNKNOWN_LAUNCH_DATE = 'سيُعلَن قريبًا';

/**
 * يحوّل ناتج النداء ({ data, error } كما يعيده supabase.rpc) إلى قرار عرض.
 * @param {{data?: unknown, error?: unknown} | null | undefined} result
 * @returns {{mode: 'open'|'waitlist'|'unavailable', waitlistMessage: string, launchDate: string}}
 */
export function resolveRegistrationSettings(result) {
    const unavailable = {
        mode: REGISTRATION_MODE.unavailable,
        waitlistMessage: DEFAULT_WAITLIST_MESSAGE,
        launchDate: UNKNOWN_LAUNCH_DATE
    };
    if (!result || result.error) return unavailable;

    const data = result.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return unavailable;

    const mode = data.mode === REGISTRATION_MODE.open || data.mode === REGISTRATION_MODE.waitlist
        ? data.mode
        : null;
    if (!mode) return unavailable;

    const message = typeof data.waitlist_message === 'string' && data.waitlist_message.trim()
        ? data.waitlist_message
        : DEFAULT_WAITLIST_MESSAGE;
    const launchDate = typeof data.expected_launch_date === 'string' && data.expected_launch_date.trim()
        ? data.expected_launch_date.trim()
        : UNKNOWN_LAUNCH_DATE;

    return { mode, waitlistMessage: message, launchDate };
}

/** هل يُسمح بإرسال نموذج التسجيل؟ فقط في الوضعين المعروفين. */
export function canSubmitRegistration(settings) {
    return settings?.mode === REGISTRATION_MODE.open || settings?.mode === REGISTRATION_MODE.waitlist;
}

/** نص رسالة الانتظار بعد وضع الموعد مكان {{launch_date}}. */
export function waitlistSuccessText(settings) {
    return String(settings?.waitlistMessage || DEFAULT_WAITLIST_MESSAGE)
        .replaceAll('{{launch_date}}', settings?.launchDate || UNKNOWN_LAUNCH_DATE);
}

/** نصوص لوحة التسجيل لكل وضع — مكان واحد بدل نصوص متفرقة في الصفحة. */
export const REGISTER_COPY = Object.freeze({
    open: {
        title: 'إنشاء حساب جديد',
        subtitle: 'أنشئ حسابك في منصة مدعوم',
        submit: 'إنشاء الحساب'
    },
    waitlist: {
        title: 'الانضمام لقائمة الانتظار',
        subtitle: 'المنصة تستعد للإطلاق - سجّل بياناتك وسنتواصل معك عند التفعيل',
        submit: 'الانضمام لقائمة الانتظار'
    },
    unavailable: {
        title: 'التسجيل غير متاح مؤقتًا',
        subtitle: 'تعذّر التحقق من حالة التسجيل الآن. لم يُرسَل أي شيء — حاول مرة أخرى بعد قليل.',
        submit: 'إعادة المحاولة'
    },
    pending: {
        submit: 'جارٍ التحقق من حالة التسجيل…'
    }
});
