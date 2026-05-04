/**
 * Facebook OAuth Helper
 * يوفر وظائف للتعامل مع تسجيل الدخول وربط الحساب باستخدام Facebook عبر Supabase Auth
 */

import { supabase } from './api-config.js';

/**
 * بدء عملية تسجيل الدخول/إنشاء حساب باستخدام Facebook
 * @param {string} redirectUrl - URL للتحويل بعد المصادقة (مثل: https://mad3oom.online/auth/callback)
 * @returns {Promise<{error: Error|null}>}
 */
export async function signInWithFacebook(redirectUrl = 'https://mad3oom.online/auth/callback') {
    try {
        const { data, error } = await supabase.auth.signInWithOAuth({
            provider: 'facebook',
            options: {
                redirectTo: redirectUrl,
                scopes: 'public_profile,email'
            }
        });

        if (error) {
            console.error('[FacebookOAuth] Sign in error:', error);
            return { error };
        }

        console.log('[FacebookOAuth] Sign in initiated successfully');
        return { error: null };
    } catch (err) {
        console.error('[FacebookOAuth] Unexpected error during sign in:', err);
        return { error: err };
    }
}

/**
 * ربط حساب Facebook بالحساب الحالي للمستخدم
 * @param {string} redirectUrl - URL للتحويل بعد المصادقة
 * @returns {Promise<{error: Error|null}>}
 */
export async function linkFacebookIdentity(redirectUrl = 'https://mad3oom.online/auth/callback') {
    try {
        const { data, error } = await supabase.auth.linkIdentity({
            provider: 'facebook',
            options: {
                redirectTo: redirectUrl,
                scopes: 'public_profile,email'
            }
        });

        if (error) {
            console.error('[FacebookOAuth] Link identity error:', error);
            return { error };
        }

        console.log('[FacebookOAuth] Link identity initiated successfully');
        return { error: null };
    } catch (err) {
        console.error('[FacebookOAuth] Unexpected error during link identity:', err);
        return { error: err };
    }
}

/**
 * التحقق من ربط حساب Facebook بالحساب الحالي
 * @returns {Promise<{isFacebookLinked: boolean, error: Error|null}>}
 */
export async function isFacebookLinked() {
    try {
        const { data: { user }, error: userError } = await supabase.auth.getUser();

        if (userError || !user) {
            console.error('[FacebookOAuth] Failed to get user:', userError);
            return { isFacebookLinked: false, error: userError };
        }

        // التحقق من وجود Facebook في قائمة الهويات المرتبطة
        const isFacebookLinked = user.identities?.some(identity => identity.provider === 'facebook') || false;

        console.log('[FacebookOAuth] Facebook linked status:', isFacebookLinked);
        return { isFacebookLinked, error: null };
    } catch (err) {
        console.error('[FacebookOAuth] Unexpected error checking Facebook link:', err);
        return { isFacebookLinked: false, error: err };
    }
}

/**
 * الحصول على معلومات الهويات المرتبطة بالحساب
 * @returns {Promise<{identities: Array, error: Error|null}>}
 */
export async function getLinkedIdentities() {
    try {
        const { data: { user }, error: userError } = await supabase.auth.getUser();

        if (userError || !user) {
            console.error('[FacebookOAuth] Failed to get user:', userError);
            return { identities: [], error: userError };
        }

        const identities = user.identities || [];
        console.log('[FacebookOAuth] Linked identities:', identities);
        return { identities, error: null };
    } catch (err) {
        console.error('[FacebookOAuth] Unexpected error getting identities:', err);
        return { identities: [], error: err };
    }
}

/**
 * فصل حساب Facebook عن الحساب الحالي
 * @returns {Promise<{error: Error|null}>}
 */
export async function unlinkFacebookIdentity() {
    try {
        const { data: { user }, error: userError } = await supabase.auth.getUser();

        if (userError || !user) {
            console.error('[FacebookOAuth] Failed to get user:', userError);
            return { error: userError };
        }

        // البحث عن Facebook identity
        const facebookIdentity = user.identities?.find(identity => identity.provider === 'facebook');

        if (!facebookIdentity) {
            console.warn('[FacebookOAuth] Facebook identity not found');
            return { error: new Error('حساب Facebook غير مرتبط بهذا الحساب') };
        }

        // استخدام unlinkIdentity لفصل الحساب
        const { error } = await supabase.auth.unlinkIdentity(facebookIdentity);

        if (error) {
            console.error('[FacebookOAuth] Unlink error:', error);
            return { error };
        }

        console.log('[FacebookOAuth] Facebook identity unlinked successfully');
        return { error: null };
    } catch (err) {
        console.error('[FacebookOAuth] Unexpected error during unlink:', err);
        return { error: err };
    }
}

/**
 * معالجة رد الاتصال من Facebook (يتم استدعاؤها من صفحة callback)
 * @returns {Promise<{session: Session|null, user: User|null, error: Error|null}>}
 */
export async function handleFacebookCallback() {
    try {
        // الحصول على session من URL parameters
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();

        if (sessionError) {
            console.error('[FacebookOAuth] Session error:', sessionError);
            return { session: null, user: null, error: sessionError };
        }

        if (!session) {
            console.warn('[FacebookOAuth] No session found after callback');
            return { session: null, user: null, error: new Error('لم يتم العثور على جلسة') };
        }

        console.log('[FacebookOAuth] Session retrieved successfully:', session.user.id);
        return { session, user: session.user, error: null };
    } catch (err) {
        console.error('[FacebookOAuth] Unexpected error handling callback:', err);
        return { session: null, user: null, error: err };
    }
}

/**
 * الحصول على معلومات المستخدم الحالي
 * @returns {Promise<{user: User|null, error: Error|null}>}
 */
export async function getCurrentUser() {
    try {
        const { data: { user }, error } = await supabase.auth.getUser();

        if (error) {
            console.error('[FacebookOAuth] Failed to get user:', error);
            return { user: null, error };
        }

        return { user, error: null };
    } catch (err) {
        console.error('[FacebookOAuth] Unexpected error getting user:', err);
        return { user: null, error: err };
    }
}
