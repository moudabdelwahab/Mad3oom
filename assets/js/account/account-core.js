/**
 * account-core.js — منطق «الملف الشخصي والأمان» الخالص، المشترك بين لوحات
 * العميل والشركة والإدارة.
 *
 * بلا شبكة ولا DOM عمدًا: كل قرار عرض أو تحقّق هنا دالة يمكن اختبارها
 * مباشرة (tests/account-core.test.mjs). الواجهة (account-settings.js)
 * والنداءات (account-service.js) تبنيان فوقه ولا تكرّران قواعده.
 *
 * مبدأ الصدق في العرض: لا يُوصف شيء بأنه «مفعّل» ما لم يكن مفروضًا فعلًا.
 * قيمة محفوظة في قاعدة البيانات لا تعني حماية.
 */

/* ── التحقق من المدخلات ──────────────────────────────────────────────────── */

/**
 * قاعدة كلمة المرور الوحيدة في المنصة: نفس قاعدة التسجيل (auth-client.js
 * validatePasswordStrength) — كانت أربع قواعد مختلفة في أربعة أماكن.
 */
export const PASSWORD_RULE_TEXT = '8 أحرف على الأقل، وتحتوي على حرف كبير وحرف صغير ورقم.';

export function validateNewPassword(password, confirm) {
    const errors = {};
    const pw = String(password || '');
    if (!pw) errors.password = 'كلمة المرور الجديدة مطلوبة';
    else if (pw.length < 8) errors.password = 'كلمة المرور يجب أن تكون 8 أحرف على الأقل';
    else if (!/[A-Z]/.test(pw) || !/[a-z]/.test(pw) || !/[0-9]/.test(pw)) {
        errors.password = 'كلمة المرور يجب أن تحتوي على حرف كبير وحرف صغير ورقم';
    }
    if (!errors.password && confirm !== undefined && String(confirm || '') !== pw) {
        errors.confirm = 'كلمتا المرور غير متطابقتين';
    }
    return { isValid: Object.keys(errors).length === 0, errors };
}

export function validateFullName(name) {
    const v = String(name || '').trim();
    if (v.length < 3) return 'الاسم يجب أن يكون 3 أحرف على الأقل';
    if (v.length > 120) return 'الاسم طويل جدًا';
    return null;
}

export function validateEmail(email) {
    const v = String(email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'أدخل بريدًا إلكترونيًا صحيحًا';
    return null;
}

/**
 * نسخة الواجهة من public.normalize_phone() حرفيًا — القاعدة هي الحَكَم، لكن
 * مطابقتها هنا تمنع رسالة «رقم غير صحيح» خام بعد رحلة للخادم. أي تعديل
 * على الدالة في القاعدة يجب أن ينعكس هنا (tests/account-core.test.mjs).
 */
export function normalizePhone(phone) {
    if (phone === null || phone === undefined || String(phone).trim() === '') return null;
    let v = String(phone).replace(/[^0-9+]/g, '');
    if (/^00[1-9][0-9]{7,14}$/.test(v)) v = '+' + v.slice(2);
    if (/^01[0-9]{9}$/.test(v)) v = '+2' + v;
    if (/^[1-9][0-9]{9,14}$/.test(v)) v = '+' + v;
    if (/^\+[1-9][0-9]{7,14}$/.test(v)) return v;
    return null;
}

export function validatePhone(phone) {
    if (!String(phone || '').trim()) return 'رقم الهاتف مطلوب — الحساب يحتاجه ليبقى مفعّلًا';
    if (!normalizePhone(phone)) return 'أدخل رقم هاتف صحيح، مثل 01012345678 أو ‎+201012345678';
    return null;
}

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export function validateAvatarFile(file) {
    if (!file) return 'اختر صورة';
    if (!AVATAR_TYPES.includes(file.type)) return 'الصيغ المسموحة: PNG أو JPG أو WEBP';
    if (file.size > AVATAR_MAX_BYTES) return 'حجم الصورة يجب ألا يتجاوز 2 ميجابايت';
    return null;
}

/* ── رموز الاستعادة ─────────────────────────────────────────────────────── */

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // بلا O/0/I/1 المتشابهة

/**
 * 8 رموز من 10 خانات بمولّد عشوائي تشفيري. كانت نافذة الإعدادات تستخدم
 * Math.random، وهو غير صالح لسرّ.
 */
export function generateRecoveryCodes(count = 8, length = 10, cryptoImpl = globalThis.crypto) {
    if (!cryptoImpl?.getRandomValues) throw new Error('no secure random source');
    const codes = [];
    for (let i = 0; i < count; i++) {
        const bytes = new Uint8Array(length);
        cryptoImpl.getRandomValues(bytes);
        let code = '';
        for (const b of bytes) code += RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length];
        codes.push(code);
    }
    return codes;
}

/* ── حالة الحماية كما تُعرض ─────────────────────────────────────────────── */

/**
 * هل سُجّل تغيير لكلمة المرور فعلًا؟ last_password_change قيمته الافتراضية
 * now() لحظة الإنشاء ولم يكن يُكتب قبل 049، فمطابقته لتاريخ الإنشاء تعني
 * «لا نعرف»، لا «غُيّرت يوم إنشاء الحساب».
 */
export function passwordChangeKnown(profile) {
    const changed = Date.parse(profile?.last_password_change || '');
    const created = Date.parse(profile?.created_at || '');
    if (!Number.isFinite(changed)) return false;
    if (!Number.isFinite(created)) return true;
    return changed - created > 60 * 1000;
}

/**
 * وسائل الحماية كما يجب أن تُعرض بصدق.
 *   state: 'on' | 'off' | 'partial' | 'unavailable' | 'unknown'
 */
export function protectionFacts(profile = {}) {
    const facts = [];

    facts.push(profile.two_factor_enabled
        ? {
            key: 'two_factor', label: 'التحقق بخطوتين (2FA)', state: 'partial',
            value: 'مفعّل عند تسجيل الدخول',
            note: 'يُطلب الرمز عند الدخول من المنصة. الفرض الكامل من الخادم على كل طرق الوصول قيد التنفيذ.'
        }
        : {
            key: 'two_factor', label: 'التحقق بخطوتين (2FA)', state: 'off',
            value: 'غير مفعّل', note: 'تفعيله يطلب رمزًا من تطبيق المصادقة عند كل دخول.'
        });

    // تيليجرام: لا يوجد مسار يرسل الرمز فعلًا، فلا يُعرض مفعّلًا أبدًا — حتى
    // لو كانت القيمة المحفوظة true (حسابان في الإنتاج).
    facts.push({
        key: 'telegram_otp', label: 'رمز الدخول عبر تيليجرام', state: 'unavailable',
        value: 'غير متاح حاليًا',
        note: profile.telegram_otp_enabled
            ? 'هذه الميزة غير مكتملة ولا تُطلب عند الدخول، رغم أنها كانت مسجّلة على حسابك. اعتمد على التحقق بخطوتين.'
            : 'هذه الميزة غير مكتملة ولا تُطلب عند الدخول.'
    });

    facts.push({
        key: 'phone', label: 'رقم الهاتف', state: profile.phone ? 'unknown' : 'off',
        value: profile.phone ? 'مسجّل (غير موثّق برمز)' : 'غير مسجّل',
        note: profile.phone ? 'لا يوجد تحقق برمز للهاتف حتى الآن.' : ''
    });

    facts.push({
        key: 'password', label: 'آخر تغيير لكلمة المرور',
        state: passwordChangeKnown(profile) ? 'on' : 'unknown',
        value: passwordChangeKnown(profile) ? profile.last_password_change : null,
        note: passwordChangeKnown(profile) ? '' : 'غير مسجَّل'
    });

    return facts;
}

/* ── الأجهزة الموثوقة ≠ الجلسات ─────────────────────────────────────────── */

export const TRUSTED_DEVICE_DAYS = 30;

/**
 * الجهاز الموثوق هو جهاز يتخطّى خطوة رمز 2FA فقط — ليس جلسة دخول، وحذفه
 * لا يُخرج أحدًا. trusted_until لم يكن يُفحص؛ الآن الصف بلا تاريخ صلاحية أو
 * بتاريخ منتهٍ لا يتخطّى الرمز.
 */
export function isTrustedDeviceActive(device, now = Date.now()) {
    const until = Date.parse(device?.trusted_until || '');
    return Number.isFinite(until) && until > now;
}

export function trustedUntilFromNow(now = Date.now(), days = TRUSTED_DEVICE_DAYS) {
    return new Date(now + days * 24 * 60 * 60 * 1000).toISOString();
}

/* ── وضع العرض ─────────────────────────────────────────────────────────── */

/**
 * هل يُسمح بالكتابة؟ في التقمّص الجلسة جلسة الأدمن، فأي كتابة «شخصية» تقع
 * على حساب الأدمن لا العميل المعروض (PS-17). المعاينة للقراءة فقط.
 */
export function accountMode({ isImpersonated = false, isPreview = false } = {}) {
    if (isImpersonated || isPreview) {
        return { readOnly: true, reason: isImpersonated ? 'impersonation' : 'preview' };
    }
    return { readOnly: false, reason: null };
}
