/**
 * account-service.js — كل نداءات «الملف الشخصي والأمان» في مكان واحد.
 *
 * تستخدمه لوحات العميل والشركة والإدارة عبر account-settings.js. كل كتابة
 * هنا تقع على **حساب الجلسة نفسه** (auth.uid())، ولا توجد دالة تكتب على
 * حساب مستخدم آخر — والقاعدة (049) ترفض ذلك أصلًا.
 *
 * كل دالة ترجع { ok, data, error } بدل رمي استثناء، والرسالة عربية واضحة.
 *
 * ملاحظة للاختبارات: الاستيراد من /auth-client.js محصور في updateProfile و
 * updatePassword، وهما ما يصدّره البديل الاختباري. أي اسم جديد من هناك
 * كان سيكسر ربط الوحدة في اختبارات العرض.
 */

import { supabase } from '/api-config.js';
import { updateProfile, updatePassword } from '/auth-client.js';
import { generateRecoveryCodes, normalizePhone } from '/assets/js/account/account-core.js';

const ok = (data = null) => ({ ok: true, data, error: null });
const fail = (error) => ({ ok: false, data: null, error: String(error || 'حدث خطأ غير متوقع') });

/** الأعمدة المعروضة فقط — لا select('*') على profiles. */
const ACCOUNT_COLUMNS = [
    'id', 'email', 'full_name', 'phone', 'whatsapp_phone', 'bio', 'avatar_url', 'role',
    'username', 'created_at', 'is_verified', 'two_factor_enabled', 'telegram_otp_enabled',
    'telegram_username', 'last_password_change'
].join(', ');

/** رسالة الخطأ من دالة حافة (supabase-js يخبّئها في error.context). */
async function functionError(error, data, fallback) {
    if (data?.error || data?.message) return data.message || data.error;
    try {
        const body = await error?.context?.json?.();
        if (body?.error || body?.message) return body.message || body.error;
    } catch { /* الجسم ليس JSON */ }
    return fallback;
}

export async function sessionUser() {
    try {
        const { data } = await supabase.auth.getUser();
        return data?.user || null;
    } catch {
        return null;
    }
}

/**
 * @param {string} userId  حساب الجلسة، أو الحساب المعروض في وضع التقمّص
 *                         (للقراءة فقط — RLS تسمح للأدمن بالقراءة).
 */
export async function getAccount(userId) {
    try {
        const { data, error } = await supabase
            .from('profiles').select(ACCOUNT_COLUMNS).eq('id', userId).maybeSingle();
        if (error) throw error;
        if (!data) return fail('تعذّر العثور على بيانات الحساب');
        return ok(data);
    } catch (err) {
        return fail(err?.message || 'تعذّر تحميل بيانات الحساب');
    }
}

/* ── الملف الشخصي ──────────────────────────────────────────────────────── */

export async function saveBasics({ fullName, bio }) {
    const patch = { full_name: String(fullName || '').trim() };
    if (bio !== undefined) patch.bio = String(bio || '').trim();
    const { error } = await updateProfile(patch);
    return error ? fail(error.message || 'تعذّر حفظ البيانات') : ok(patch);
}

/**
 * الهاتف عبر submit_my_phone وحده — نفس مسار بوابة الحساب: يوحّد الصيغة،
 * ويعطي رسالة واضحة عند التكرار، ويبقي whatsapp_phone متّسقًا. PATCH المباشر
 * كان يُظهر خطأ «duplicate key» الخام ويُهمل رقم واتساب.
 */
export async function savePhone(phone, account = {}) {
    const next = normalizePhone(phone);
    if (!next) return fail('رقم الهاتف غير صحيح');
    const currentWa = normalizePhone(account.whatsapp_phone);
    const sameAsPhone = !currentWa || currentWa === normalizePhone(account.phone);
    try {
        const { data, error } = await supabase.rpc('submit_my_phone', {
            p_phone: next,
            p_has_whatsapp: sameAsPhone,
            p_whatsapp_phone: sameAsPhone ? null : currentWa
        });
        if (error) throw error;
        return ok(data || { phone: next });
    } catch (err) {
        return fail(err?.message || 'تعذّر حفظ رقم الهاتف');
    }
}

/**
 * تغيير البريد عبر نظام الدخول نفسه — لا يتغيّر شيء حتى يُضغط رابط التأكيد،
 * وبعدها ينعكس على profiles بمحفّز (049). الكتابة المباشرة على
 * profiles.email مرفوضة في القاعدة.
 */
export async function requestEmailChange(newEmail) {
    try {
        const { error } = await supabase.auth.updateUser(
            { email: String(newEmail).trim().toLowerCase() },
            { emailRedirectTo: `${window.location.origin}/login.html` }
        );
        if (error) throw error;
        return ok();
    } catch (err) {
        return fail(err?.message || 'تعذّر طلب تغيير البريد');
    }
}

export async function uploadAvatar(file, userId) {
    const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' })[file.type] || 'png';
    // سياسة التخزين تشترط أن يكون أول مجلد هو auth.uid()
    const path = `${userId}/avatar-${Date.now()}.${ext}`;
    try {
        const bucket = supabase.storage.from('avatars');
        const { error: upErr } = await bucket.upload(path, file, { upsert: false, contentType: file.type });
        if (upErr) throw upErr;
        const { data } = bucket.getPublicUrl(path);
        const url = data?.publicUrl;
        if (!url) throw new Error('تعذّر الحصول على رابط الصورة');
        const { error } = await updateProfile({ avatar_url: url });
        if (error) throw error;
        return ok({ avatar_url: url });
    } catch (err) {
        return fail(err?.message || 'تعذّر رفع الصورة');
    }
}

/* ── كلمة المرور والجلسات ──────────────────────────────────────────────── */

/**
 * تغيير كلمة المرور يتطلب كلمة المرور الحالية (PS-06): جلسة مفتوحة وحدها
 * ليست دليلًا على صاحب الحساب. بعد النجاح تُنهى الجلسات الأخرى.
 */
export async function changePassword({ email, currentPassword, newPassword }) {
    if (typeof supabase.auth.signInWithPassword !== 'function') {
        return fail('تعذّر التحقق من كلمة المرور الحالية');
    }
    try {
        const { error: authErr } = await supabase.auth.signInWithPassword({
            email: String(email || '').trim().toLowerCase(), password: currentPassword
        });
        if (authErr) return fail('كلمة المرور الحالية غير صحيحة');
    } catch {
        return fail('تعذّر التحقق من كلمة المرور الحالية');
    }

    const { error } = await updatePassword(newPassword);
    if (error) return fail(error.message || 'تعذّر تحديث كلمة المرور');

    const others = await signOutOtherSessions();
    return ok({ otherSessionsEnded: others.ok });
}

/**
 * إنهاء كل جلسات الحساب ما عدا هذه. Supabase لا يتيح قائمة بالجلسات من
 * المتصفح، فلا نعرض قائمة وهمية — هذا الإجراء هو الإدارة الفعلية المتاحة.
 */
export async function signOutOtherSessions() {
    try {
        if (typeof supabase.auth.signOut !== 'function') return fail('غير متاح');
        const { error } = await supabase.auth.signOut({ scope: 'others' });
        if (error) throw error;
        return ok();
    } catch (err) {
        return fail(err?.message || 'تعذّر إنهاء الجلسات الأخرى');
    }
}

/* ── التحقق بخطوتين ────────────────────────────────────────────────────── */

export async function startTwoFactorEnrollment() {
    try {
        const { data, error } = await supabase.functions.invoke('generate-2fa-secret');
        if (error || !data?.base32) throw error || new Error();
        return ok({ secret: data.base32, otpauthUrl: data.otpauth_url });
    } catch {
        return fail('تعذّر بدء إعداد التحقق بخطوتين. حاول مرة أخرى.');
    }
}

/**
 * يتحقق من الرمز على الخادم ثم يحفظ السرّ ورموز الاستعادة. بعد 049 يحوّلها
 * محفّز إلى الجدول الخاص فلا تبقى مقروءة، والرموز تُعرض هذه المرة فقط.
 */
export async function confirmTwoFactorEnrollment({ userId, secret, code }) {
    if (!/^\d{6}$/.test(String(code || ''))) return fail('أدخل الرمز المكوّن من 6 أرقام');
    try {
        const { data, error } = await supabase.functions.invoke('verify-2fa', {
            body: { code: String(code), tempSecret: secret }
        });
        if (error) return fail(await functionError(error, data, 'الرمز غير صحيح'));
        if (!data?.verified) return fail('الرمز غير صحيح. تأكد من توقيت هاتفك وحاول مرة أخرى.');
        if (!data.enrollment) return fail('التحقق بخطوتين مفعّل بالفعل على هذا الحساب.');

        const recoveryCodes = generateRecoveryCodes();
        const { error: saveErr } = await supabase.from('profiles').update({
            two_factor_enabled: true,
            two_factor_secret: secret,
            recovery_codes: recoveryCodes
        }).eq('id', userId);
        if (saveErr) throw saveErr;
        return ok({ recoveryCodes });
    } catch (err) {
        return fail(err?.message || 'تعذّر تفعيل التحقق بخطوتين');
    }
}

/** @param {{code?: string, recoveryCode?: string}} proof */
export async function disableTwoFactor(proof) {
    try {
        const { data, error } = await supabase.functions.invoke('disable-2fa', { body: proof });
        if (error || !data?.disabled) {
            const reason = await functionError(error, data, 'invalid_code');
            return fail(reason === 'too_many_attempts'
                ? 'تجاوزت عدد المحاولات المسموح بها. حاول بعد 15 دقيقة.'
                : 'الرمز غير صحيح');
        }
        return ok();
    } catch {
        return fail('تعذّر تعطيل التحقق بخطوتين');
    }
}

/* ── الأجهزة الموثوقة ──────────────────────────────────────────────────── */

export async function listTrustedDevices(userId) {
    try {
        const { data, error } = await supabase
            .from('trusted_devices')
            .select('id, device_name, last_login, created_at, trusted_until')
            .eq('user_id', userId)
            .order('last_login', { ascending: false });
        if (error) throw error;
        return ok(data || []);
    } catch (err) {
        return fail(err?.message || 'تعذّر تحميل الأجهزة الموثوقة');
    }
}

export async function removeTrustedDevice(id) {
    try {
        const { error } = await supabase.from('trusted_devices').delete().eq('id', id);
        if (error) throw error;
        return ok();
    } catch (err) {
        return fail(err?.message || 'تعذّر إزالة الجهاز');
    }
}

export async function removeAllTrustedDevices(userId) {
    try {
        const { error } = await supabase.from('trusted_devices').delete().eq('user_id', userId);
        if (error) throw error;
        return ok();
    } catch (err) {
        return fail(err?.message || 'تعذّر إزالة الأجهزة');
    }
}

