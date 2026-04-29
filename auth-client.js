
import { supabase, debugAuthError } from './api-config.js';
import { logActivity } from './activity-service.js';

/* =========================================================
   Helpers
========================================================= */
export async function signInAsGuest() {
    const guestId = 'guest_' + Math.random().toString(36).substring(2, 11);

    const guestUser = {
        id: guestId,
        email: `${guestId}@mad3oom.guest`,
        isGuest: true,
        profile: {
            id: guestId,
            role: 'customer',
            full_name: 'زائر',
            is_guest: true
        }
    };

    localStorage.setItem(
        'mad3oom-guest-session',
        JSON.stringify(guestUser)
    );

    return guestUser;
}

export function isUserBanned(profile) {
    if (!profile) return false;

    if (profile.ban_status === 'permanent') return true;

    if (profile.ban_status === 'temporary' && profile.ban_until) {
        return new Date(profile.ban_until) > new Date();
    }

    return false;
}

/**
 * دالة لضمان وجود ملف شخصي للمستخدم
 * تحل مشكلة "تعذر تحميل بيانات الحساب" عبر إنشاء ملف شخصي افتراضي إذا كان مفقوداً
 */
async function ensureUserProfile(user) {
    try {
        // 1. محاولة جلب الملف الشخصي
        let { data: profile, error: fetchError } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .maybeSingle();

        if (fetchError) {
            console.error('Error fetching profile:', fetchError);
            return { profile: null, error: fetchError };
        }

        // 2. إذا كان الملف الشخصي موجوداً، قم بإرجاعه
        if (profile) {
            return { profile, error: null };
        }

        // 3. إذا كان مفقوداً، قم بإنشائه (هذا يحدث عادةً إذا فشلت عملية الإدخال أثناء التسجيل)
        console.warn('Profile missing for user, creating default profile:', user.id);
        
        const defaultUsername = user.email.split('@')[0] + Math.floor(Math.random() * 1000);
        const userMetadata = user.user_metadata || {};
        
        const newProfile = {
            id: user.id,
            email: user.email,
            username: userMetadata.username || defaultUsername,
            full_name: userMetadata.full_name || userMetadata.first_name || 'مستخدم جديد',
            user_type: userMetadata.user_type || 'individual',
            role: 'customer',
            is_verified: false,
            created_at: new Date().toISOString()
        };

        const { data: createdProfile, error: insertError } = await supabase
            .from('profiles')
            .insert([newProfile])
            .select()
            .single();

        if (insertError) {
            console.error('Failed to create missing profile:', insertError);
            return { profile: null, error: insertError };
        }

        return { profile: createdProfile, error: null };
    } catch (err) {
        console.error('Unexpected error in ensureUserProfile:', err);
        return { profile: null, error: err };
    }
}

/* =========================================================
   Auth Core
========================================================= */

export async function signIn(identifier, password) {
    const normalizedIdentifier = (identifier || '').trim();
    const normalizedPassword = password || '';

    if (!normalizedIdentifier || !normalizedPassword) {
        return {
            data: null,
            error: {
                message: 'يرجى إدخال البريد الإلكتروني/اسم المستخدم وكلمة المرور.'
            }
        };
    }

    let email = normalizedIdentifier;

    if (!normalizedIdentifier.includes('@')) {
        const { data: profile, error: profileLookupError } = await supabase
            .from('profiles')
            .select('email')
            .eq('username', normalizedIdentifier)
            .maybeSingle();

        if (profileLookupError) {
            return {
                data: null,
                error: {
                    message: 'تعذر التحقق من اسم المستخدم حالياً. حاول مرة أخرى.'
                }
            };
        }

        if (profile?.email) {
            email = profile.email.trim().toLowerCase();
        } else {
            return {
                data: null,
                error: {
                    message: 'اسم المستخدم غير موجود.'
                }
            };
        }
    } else {
        email = normalizedIdentifier.toLowerCase();
    }

    const result = await supabase.auth.signInWithPassword({
        email,
        password: normalizedPassword
    });

    if (result.error) {
        debugAuthError(result.error);
        return result;
    }

    const user = result.data.user;

    if (!user.email_confirmed_at) {
        await supabase.auth.signOut();
        return {
            data: null,
            error: {
                message: 'يرجى تأكيد البريد الإلكتروني أولاً.'
            }
        };
    }

    // إصلاح: استخدام ensureUserProfile لضمان وجود بيانات الحساب
    const { profile, error: profileError } = await ensureUserProfile(user);

    if (profileError || !profile) {
        await supabase.auth.signOut();
        return {
            data: null,
            error: {
                message: 'تعذر تحميل بيانات الحساب. يرجى التواصل مع الدعم الفني.'
            }
        };
    }

    if (isUserBanned(profile)) {
        await supabase.auth.signOut();
        return {
            data: null,
            error: {
                message: 'تم حظر هذا الحساب. يرجى التواصل مع الإدارة.'
            }
        };
    }

    logActivity('login', { email }).catch(() => {});

    if (!profile.two_factor_enabled && !(profile.telegram_otp_enabled && profile.telegram_chat_id)) {
        return {
            ...result,
            profile
        };
    }

    if (profile.two_factor_enabled) {
        const fingerprint = localStorage.getItem('device_fingerprint');

        if (fingerprint) {
            const { data: trustedDevice } = await supabase
                .from('trusted_devices')
                .select('*')
                .eq('user_id', user.id)
                .eq('device_fingerprint', fingerprint)
                .maybeSingle();

            if (trustedDevice) {
                await supabase
                    .from('trusted_devices')
                    .update({ last_used_at: new Date().toISOString() })
                    .eq('id', trustedDevice.id)
                    .then(() => {})
                    .catch((err) => {
                        console.warn('Failed to update trusted device:', err);
                    });

                return {
                    ...result,
                    profile
                };
            }
        }

        return {
            data: result.data,
            requires2FA: true,
            profile
        };
    }

    if (profile.telegram_otp_enabled && profile.telegram_chat_id) {
        supabase.functions.invoke('telegram-webhook', {
            body: {
                internal_trigger: true,
                user_id: user.id,
                action: 'send_otp'
            }
        }).catch(() => {});

        return {
            data: result.data,
            requiresTelegramOTP: true,
            profile
        };
    }

    return {
        ...result,
        profile
    };
}

export function onAuthStateChange(callback) {
    return supabase.auth.onAuthStateChange((event, session) => {
        callback(event, session);
    });
}

/**
 * التحقق من صحة البريد الإلكتروني
 * @param {string} email - البريد الإلكتروني
 * @returns {boolean} - true إذا كان البريد صحيحاً
 */
function validateEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email.trim());
}

/**
 * التحقق من صحة كلمة المرور
 * @param {string} password - كلمة المرور
 * @returns {boolean} - true إذا كانت كلمة المرور قوية
 */
function validatePasswordStrength(password) {
    if (password.length < 8) return false;
    if (!/[A-Z]/.test(password)) return false;
    if (!/[a-z]/.test(password)) return false;
    if (!/[0-9]/.test(password)) return false;
    return true;
}

/**
 * التحقق من وجود اسم مستخدم مكرر
 * @param {string} username - اسم المستخدم
 * @returns {Promise<boolean>} - true إذا كان اسم المستخدم موجود
 */
async function checkUsernameExists(username) {
    try {
        const { data, error } = await supabase
            .from('profiles')
            .select('id')
            .eq('username', username.toLowerCase())
            .maybeSingle();

        if (error) {
            console.error('Error checking username:', error);
            return false;
        }

        return !!data;
    } catch (err) {
        console.error('Unexpected error checking username:', err);
        return false;
    }
}

/**
 * دالة تسجيل حساب جديد محسّنة مع التحقق من البيانات
 * @param {string} email - البريد الإلكتروني
 * @param {string} password - كلمة المرور
 * @param {Object} metadata - بيانات إضافية (اختياري)
 * @returns {Object} - نتيجة التسجيل
 */
export async function signUp(email, password, metadata = {}) {
    if (!email || !validateEmail(email)) {
        return {
            data: null,
            error: {
                message: 'البريد الإلكتروني غير صحيح.'
            }
        };
    }

    if (!password || !validatePasswordStrength(password)) {
        return {
            data: null,
            error: {
                message: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل وتحتوي على حرف كبير وحرف صغير ورقم.'
            }
        };
    }

    const { data: existingUser, error: checkError } = await supabase
        .from('profiles')
        .select('id')
        .eq('email', email.toLowerCase())
        .maybeSingle();

    if (checkError) {
        debugAuthError(checkError);
        return {
            data: null,
            error: {
                message: 'تعذر التحقق من البريد الإلكتروني. حاول مرة أخرى.'
            }
        };
    }

    if (existingUser) {
        return {
            data: null,
            error: {
                message: 'هذا البريد الإلكتروني مسجل بالفعل.'
            }
        };
    }

    if (metadata.username) {
        const usernameExists = await checkUsernameExists(metadata.username);
        if (usernameExists) {
            return {
                data: null,
                error: {
                    message: 'اسم المستخدم مسجل بالفعل.'
                }
            };
        }
    }

    const emailRedirectTo = `${window.location.origin}/sign-in.html`;

    const result = await supabase.auth.signUp({
        email: email.toLowerCase(),
        password,
        options: {
            data: metadata,
            emailRedirectTo
        }
    });

    if (result.error) {
        debugAuthError(result.error);
        return {
            data: null,
            error: {
                message: result.error.message || 'فشل في إنشاء الحساب. حاول مرة أخرى.'
            }
        };
    }

    return result;
}

export async function logout() {
    try {
        await logActivity('logout');
    } catch (e) {}

    localStorage.removeItem('mad3oom-guest-session');

    const { error } = await supabase.auth.signOut();

    return { error };
}

/* =========================================================
   Session & User
========================================================= */

export async function getCurrentUser() {
    const { data: { user }, error } = await supabase.auth.getUser();

    if (error || !user) {
        return null;
    }

    // استخدام ensureUserProfile لضمان وجود الملف الشخصي حتى عند جلب المستخدم الحالي
    const { profile, error: profileError } = await ensureUserProfile(user);

    if (profileError || !profile) {
        console.error('Profile missing for user:', user.id);
        return null;
    }

    if (isUserBanned(profile)) {
        return {
            banned: true,
            profile
        };
    }

    return {
        ...user,
        profile
    };
}

/* =========================================================
   Authorization
========================================================= */

export async function requireAuth(requiredRole = null) {
    const guestSession = localStorage.getItem('mad3oom-guest-session');

    if (guestSession) {
        return JSON.parse(guestSession);
    }

    const user = await getCurrentUser();

    if (!user) return null;
    if (user.banned) return { banned: true };

    const role = user.profile?.role;

    const isAdmin =
        role === 'admin' ||
        role === 'support' ||
        role === 'super_user';

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

    if (requiredRole === 'admin' && !isAdmin) {
        return null;
    }

    if (requiredRole === 'customer' && isAdmin && !impersonateId) {
        return null;
    }

    return user;
}

/* =========================================================
   Auto Redirect
========================================================= */

export async function autoRedirect() {
    const { data: { session } } = await supabase.auth.getSession();
    const guestSession = localStorage.getItem('mad3oom-guest-session');

    if (!session?.user && !guestSession) return;

    const isAuthPage =
        window.location.pathname.includes('sign-in.html') ||
        window.location.pathname.includes('sign-up.html') ||
        window.location.pathname === '/' ||
        window.location.pathname.endsWith('index.html');

    if (!isAuthPage) return;

    if (guestSession) {
        window.location.replace('customer-dashboard.html');
        return;
    }

    if (session?.user) {
        // استخدام ensureUserProfile لضمان وجود الملف الشخصي قبل التوجيه
        const { profile, error } = await ensureUserProfile(session.user);

        if (error || !profile) {
            console.error('Missing profile during redirect');
            return;
        }

        const role = profile.role;

        const isAdmin =
            role === 'admin' ||
            role === 'support' ||
            role === 'super_user';

        const target = isAdmin
            ? 'admin-dashboard.html'
            : 'customer-dashboard.html';

        window.location.replace(target);
    }
}
