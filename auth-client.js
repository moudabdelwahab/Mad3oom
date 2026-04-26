import { supabase, debugAuthError } from './api-config.js';
import { logActivity } from './activity-service.js';

/* =========================================================
   Helpers
========================================================= */

/**
 * التحقق هل المستخدم محظور
 */
export function isUserBanned(profile) {
    if (!profile) return false;

    if (profile.ban_status === 'permanent') return true;

    if (profile.ban_status === 'temporary' && profile.ban_until) {
        return new Date(profile.ban_until) > new Date();
    }

    return false;
}

/* =========================================================
   Auth Core
========================================================= */

/**
 * تسجيل الدخول اللحظي
 */
export async function signIn(identifier, password) {
    const normalizedIdentifier = (identifier || '').trim();
    const normalizedPassword = password || '';

    if (!normalizedIdentifier || !normalizedPassword) {
        return { data: null, error: { message: 'يرجى إدخال البريد الإلكتروني/اسم المستخدم وكلمة المرور.' } };
    }

    let email = normalizedIdentifier;

    // إذا لم يكن المعرف بريداً إلكترونياً، نفترض أنه اسم مستخدم ونبحث عن البريد المرتبط به
    if (!normalizedIdentifier.includes('@')) {
        const { data: profile, error: profileLookupError } = await supabase
            .from('profiles')
            .select('email')
            .eq('username', normalizedIdentifier)
            .maybeSingle();

        if (profileLookupError) {
            return { data: null, error: { message: 'تعذر التحقق من اسم المستخدم حالياً. حاول مرة أخرى.' } };
        }
        
        if (profile?.email) {
            email = profile.email.trim().toLowerCase();
        } else {
            return { data: null, error: { message: 'اسم المستخدم غير موجود.' } };
        }
    } else {
        email = normalizedIdentifier.toLowerCase();
    }

    // محاولة تسجيل الدخول
    const result = await supabase.auth.signInWithPassword({ email, password: normalizedPassword });
    if (result.error) {
        debugAuthError(result.error);
        return result;
    }

    const user = result.data.user;

    // تأكيد الإيميل (تحقق سريع من بيانات الجلسة)
    if (!user.email_confirmed_at) {
        await supabase.auth.signOut();
        return { data: null, error: { message: 'يرجى تأكيد البريد الإلكتروني أولاً.' } };
    }

    // جلب البروفايل مع استخدام cache أو التحقق السريع
    const { data: profile } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .maybeSingle();

    // فحص الحظر
    if (isUserBanned(profile)) {
        await supabase.auth.signOut();
        return { data: null, error: { message: 'تم حظر هذا الحساب. يرجى التواصل مع الإدارة.' } };
    }

    // تسجيل النشاط في الخلفية
    logActivity('login', { email }).catch(() => {});

    // التحقق من 2FA أو Telegram (إذا لم تكن مفعلة، نوجه فوراً)
    if (!profile?.two_factor_enabled && !(profile?.telegram_otp_enabled && profile?.telegram_chat_id)) {
        return {
            ...result,
            profile: profile || { id: user.id, role: 'customer', email: user.email }
        };
    }

    // منطق 2FA (إذا كان مفعلاً)
    if (profile?.two_factor_enabled) {
        const fingerprint = localStorage.getItem('device_fingerprint');
        if (fingerprint) {
            const { data: trustedDevice } = await supabase
                .from('trusted_devices')
                .select('*')
                .eq('user_id', user.id)
                .eq('device_fingerprint', fingerprint)
                .maybeSingle();

            if (trustedDevice) {
                supabase.from('trusted_devices').update({ last_used_at: new Date().toISOString() }).eq('id', trustedDevice.id).then();
                logActivity('login', { email, method: 'trusted_device' }).catch(() => {});
                return { ...result, profile: profile || { id: user.id, role: 'customer', email: user.email } };
            }
        }
        return { data: result.data, requires2FA: true, profile };
    }

    // منطق Telegram OTP
    if (profile?.telegram_otp_enabled && profile?.telegram_chat_id) {
        supabase.functions.invoke('telegram-webhook', {
            body: { internal_trigger: true, user_id: user.id, action: 'send_otp' }
        }).catch(() => {});
        return { data: result.data, requiresTelegramOTP: true, profile: profile || { id: user.id, role: 'customer', email: user.email } };
    }

    return { ...result, profile: profile || { id: user.id, role: 'customer', email: user.email } };
}

/**
 * مراقبة حالة المصادقة لحظياً (Realtime Auth Listener)
 */
export function onAuthStateChange(callback) {
    return supabase.auth.onAuthStateChange((event, session) => {
        callback(event, session);
    });
}

/**
 * إنشاء حساب
 */
export async function signUp(email, password, metadata = {}) {
    const result = await supabase.auth.signUp({ 
        email, 
        password,
        options: {
            data: metadata,
            emailRedirectTo: `${window.location.origin}/sign-in.html`
        }
    });

    if (result.error) {
        debugAuthError(result.error);
    }

    // ملاحظة: في Supabase، عند تفعيل تأكيد البريد، قد لا يتم إنشاء سجل في جدول profiles فوراً 
    // إلا إذا كان هناك Trigger في قاعدة البيانات. البيانات الواردة في metadata سيتم تخزينها 
    // في raw_user_meta_data داخل جدول auth.users تلقائياً.
    
    return result;
}

/**
 * التحقق من توفر اسم المستخدم
 */
export async function checkUsernameAvailability(username) {
    try {
        const { data, error } = await supabase
            .from('profiles')
            .select('username')
            .eq('username', username)
            .maybeSingle();
        
        if (error && error.code !== 'PGRST116') throw error;
        
        return { available: !data, error: null };
    } catch (error) {
        return { available: false, error };
    }
}

/**
 * تسجيل الخروج
 */
export async function logout() {
    try {
        await logActivity('logout');
    } catch (e) {}

    // مسح جلسة الضيف
    localStorage.removeItem('mad3oom-guest-session');
    
    // مسح أي بيانات أخرى متعلقة بالجلسة في localStorage إذا وجدت
    // localStorage.clear(); // خيار جذري إذا لزم الأمر

    const { error } = await supabase.auth.signOut();
    if (error) console.error('Error during signOut:', error);
    
    return { error };
}

/* =========================================================
   Session & User
========================================================= */

/**
 * جلب المستخدم الحالي (❌ بدون Redirect)
 */
export async function getCurrentUser() {
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error) {
        debugSupabaseAuthError(error);
        return null;
    }

    if (!user) return null;

    const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .maybeSingle();

    // إذا لم يوجد بروفايل، نعتبره مستخدم عادي (customer) بشكل افتراضي
    const safeProfile = profile || { id: user.id, role: 'customer', email: user.email };

    if (isUserBanned(safeProfile)) {
        return { banned: true, profile: safeProfile };
    }

    return { ...user, profile: safeProfile };
}

/* =========================================================
   Authorization (NO REDIRECTS HERE)
========================================================= */

/**
 * حماية الصفحات
 * ❌ لا Redirect
 * ✔️ ترجع user أو null فقط
 */
export async function requireAuth(requiredRole = null) {
    // Guest
    const guestSession = localStorage.getItem('mad3oom-guest-session');
    if (guestSession) return JSON.parse(guestSession);

    const user = await getCurrentUser();
    if (!user) return null;
    if (user.banned) return { banned: true };

    const role = user.profile?.role || 'customer';
    const isAdmin = role === 'admin' || role === 'support' || role === 'super_user';

    // impersonation
    const params = new URLSearchParams(window.location.search);
    const impersonateId = params.get('impersonate');

    if (impersonateId && isAdmin) {
        const { data: targetProfile } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', impersonateId)
            .maybeSingle();

        if (targetProfile) {
            return {
                id: impersonateId,
                profile: targetProfile,
                isImpersonated: true
            };
        }
    }

    // Role check
    if (requiredRole === 'admin' && !isAdmin) return null;
    if (requiredRole === 'customer' && isAdmin && !impersonateId) {
        // إذا كان أدمن يحاول دخول لوحة العميل بدون impersonation، نسمح له لكنه سيرى بياناته كأدمن
        // أو يمكن منعه حسب رغبة العميل، هنا سنسمح له لضمان عدم حدوث Loop
        return user;
    }

    return user;
}

/* =========================================================
   Impersonation (ONE redirect only)
========================================================= */

export async function adminImpersonateUser(userId) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;

    const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .maybeSingle();

    const isAdmin = profile?.role === 'admin' || profile?.role === 'support' || profile?.role === 'super_user';
    if (!isAdmin) return false;

    window.location.replace(
        `/customer-dashboard.html?impersonate=${userId}`
    );

    return true;
}

/* =========================================================
   Profile
========================================================= */

export async function updateProfile(updates) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Not authenticated');

    const { data, error } = await supabase
        .from('profiles')
        .upsert({ id: user.id, ...updates })
        .select();

    if (!error) {
        await logActivity('profile_updated', updates);
    }

    return { data, error };
}

/* =========================================================
   Admin Utilities
========================================================= */

export async function adminUpdateUserRole(userId, newRole) {
    const { data, error } = await supabase
        .from('profiles')
        .update({ role: newRole })
        .eq('id', userId);

    if (!error) {
        await logActivity('admin_updated_role', {
            target_user_id: userId,
            new_data: { role: newRole }
        });
    }

    return { data, error };
}

/* =========================================================
   Password & Email
========================================================= */

export async function resetPasswordEmail(email) {
    return await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password.html`
    });
}

export async function updatePassword(newPassword) {
    const { data, error } = await supabase.auth.updateUser({
        password: newPassword
    });

    if (!error) await logActivity('password_changed');
    return { data, error };
}

export async function updateEmail(newEmail) {
    return await supabase.auth.updateUser({ email: newEmail });
}

/* =========================================================
   Guest & Redirection
   ========================================================= */

/**
 * تسجيل الدخول كضيف
 */
export async function signInAsGuest() {
    const guestId = 'guest_' + Math.random().toString(36).substring(2, 11);
    const guestUser = {
        id: guestId,
        email: `${guestId}@mad3oom.guest`,
        isGuest: true,
        profile: {
            id: guestId,
            full_name: 'زائر',
            role: 'customer',
            is_guest: true
        }
    };
    localStorage.setItem('mad3oom-guest-session', JSON.stringify(guestUser));
    await logActivity('guest_login', { guest_id: guestId });
    return guestUser;
}

/**
 * التوجيه التلقائي بناءً على حالة المصادقة
 */
export async function autoRedirect() {
    // جلب الجلسة الحالية أولاً
    const { data: { session } } = await supabase.auth.getSession();
    const guestSession = localStorage.getItem('mad3oom-guest-session');
    
    // إذا لم يكن هناك مستخدم مسجل ولا ضيف، لا نفعل شيئاً (نحن بالفعل في صفحة عامة)
    if (!session?.user && !guestSession) return;

    const isAuthPage = window.location.pathname.includes('sign-in.html') || 
                      window.location.pathname.includes('sign-up.html') || 
                      window.location.pathname === '/' || 
                      window.location.pathname.endsWith('index.html');

    // إذا كنا في صفحة مصادقة (تسجيل دخول/إنشاء حساب) وهناك جلسة نشطة، نوجه للوحة التحكم
    if (isAuthPage) {
        if (guestSession) {
            window.location.replace('customer-dashboard.html');
            return;
        }

        if (session?.user) {
            const { data: profile } = await supabase
                .from('profiles')
                .select('role')
                .eq('id', session.user.id)
                .maybeSingle();
            
            const role = profile?.role || 'customer';
            const isAdmin = role === 'admin' || role === 'support' || role === 'super_user';
            const target = isAdmin ? 'admin-dashboard.html' : 'customer-dashboard.html';
            window.location.replace(target);
        }
    }
}
