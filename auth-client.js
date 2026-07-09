import { supabase, debugAuthError } from './api-config.js';
import { logActivity } from './activity-service.js';

/* =========================================================
   ✅ جديد: حماية من التعليق اللانهائي (navigator.locks deadlock /
   شبكة بطيئة). أي عملية Supabase بتاخد وقت أطول من المسموح
   بترفض برسالة واضحة بدل ما تسيب الواجهة عالقة على "جاري التحميل"
   للأبد.
========================================================= */
function withTimeout(promise, ms = 10000, label = 'العملية') {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`استغرقت ${label} وقتاً أطول من المتوقع. تحقق من الاتصال وحاول مرة أخرى.`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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
            role: 'user',
            full_name: 'زائر',
            is_guest: true
        }
    };

    localStorage.setItem(
        'mad3oom-guest-session',
        JSON.stringify(guestUser)
    );

    sessionStorage.removeItem('just_logged_out');

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
 * تم تحسينها للتعامل مع أخطاء السيرفر (500) عبر توفير ملف شخصي مؤقت
 */
async function ensureUserProfile(user) {
    try {
        let { data: profile, error: fetchError } = await withTimeout(
            supabase.from('profiles').select('*').eq('id', user.id).maybeSingle(),
            10000,
            'تحميل الملف الشخصي'
        );

        if (fetchError) {
            console.error('Supabase Server Error (500/Fetch):', fetchError);

            const userMetadata = user.user_metadata || {};
            return {
                profile: {
                    id: user.id,
                    email: user.email,
                    username: userMetadata.username || user.email.split('@')[0],
                    full_name: userMetadata.full_name || userMetadata.first_name || 'مستخدم (بيانات مؤقتة)',
                    user_type: userMetadata.user_type || 'individual',
                    role: 'user',
                    is_temporary: true
                },
                error: null
            };
        }

        if (profile) {
            return { profile, error: null };
        }

        console.warn('Profile missing for user, creating default profile:', user.id);

        const defaultUsername = user.email.split('@')[0] + Math.floor(Math.random() * 1000);
        const userMetadata = user.user_metadata || {};

        const newProfile = {
            id: user.id,
            email: user.email,
            username: userMetadata.username || defaultUsername,
            full_name: userMetadata.full_name || userMetadata.first_name || 'مستخدم جديد',
            user_type: userMetadata.user_type || 'individual',
            role: 'user',
            is_verified: false,
            created_at: new Date().toISOString()
        };

        const { data: createdProfile, error: insertError } = await withTimeout(
            supabase.from('profiles').insert([newProfile]).select().single(),
            10000,
            'إنشاء الملف الشخصي'
        );

        if (insertError) {
            console.error('Failed to create missing profile (Database Error):', insertError);
            return { profile: newProfile, error: null };
        }

        return { profile: createdProfile, error: null };
    } catch (err) {
        console.error('Unexpected error in ensureUserProfile:', err);
        return {
            profile: {
                id: user.id,
                email: user.email,
                role: 'user',
                is_fallback: true
            },
            error: null
        };
    }
}

/* =========================================================
   Auth Core
========================================================= */

export async function signIn(identifier, password, options = {}) {
    console.log('signIn function started');
    const normalizedIdentifier = (identifier || '').trim();
    const normalizedPassword = password || '';
    const { turnstileToken } = options;

    if (!normalizedIdentifier || !normalizedPassword) {
        return {
            data: null,
            error: {
                message: 'يرجى إدخال البريد الإلكتروني/اسم المستخدم وكلمة المرور.'
            }
        };
    }

    let email = normalizedIdentifier;

    try {
        if (!normalizedIdentifier.includes('@')) {
            console.log('Searching username:', normalizedIdentifier);

            // ملاحظة أمنية: كانت view مفتوحة تسمح بسحب usernames/emails
            // كل المستخدمين دفعة واحدة. استبدلناها بدالة RPC آمنة (كانت
            // موجودة بالفعل بدون استخدام: get_email_by_username) تُرجع
            // نتيجة واحدة فقط لاسم مستخدم واحد بالظبط.
            const { data: lookupRows, error: profileLookupError } = await withTimeout(
                supabase.rpc('get_email_by_username', {
                    p_username: normalizedIdentifier.trim()
                }),
                10000,
                'البحث عن اسم المستخدم'
            );

            console.log('profileLookupError =', profileLookupError);

            if (profileLookupError) {
                console.error('Username lookup failed:', profileLookupError);

                return {
                    data: null,
                    error: {
                        message: 'حدث خطأ في الاتصال بالسيرفر. يرجى المحاولة مرة أخرى.'
                    }
                };
            }

            const lookedUpEmail = lookupRows?.[0]?.email;

            if (!lookedUpEmail) {
                return {
                    data: null,
                    error: {
                        message: 'اسم المستخدم غير موجود.'
                    }
                };
            }

            email = lookedUpEmail.trim().toLowerCase();

        } else {
            email = normalizedIdentifier.trim().toLowerCase();
        }

        const result = await withTimeout(
            supabase.auth.signInWithPassword({ email, password: normalizedPassword }),
            10000,
            'تسجيل الدخول'
        );

        if (result.error) {
            debugAuthError(result.error);
            return result;
        }
        const user = result.data.user;

        if (!user.email_confirmed_at) {
            await withTimeout(supabase.auth.signOut(), 6000, 'تسجيل الخروج').catch(() => {});
            return {
                data: null,
                error: {
                    message: 'يرجى تأكيد البريد الإلكتروني أولاً.'
                }
            };
        }

        const { profile, error: profileError } = await ensureUserProfile(user);

        if (profileError || !profile) {
            await withTimeout(supabase.auth.signOut(), 6000, 'تسجيل الخروج').catch(() => {});
            return {
                data: null,
                error: {
                    message: 'تعذر تحميل بيانات الحساب بسبب مشكلة فنية في السيرفر.'
                }
            };
        }

        if (isUserBanned(profile)) {
            await withTimeout(supabase.auth.signOut(), 6000, 'تسجيل الخروج').catch(() => {});
            return {
                data: null,
                error: {
                    message: 'تم حظر هذا الحساب. يرجى التواصل مع الإدارة.'
                }
            };
        }

        logActivity('login', { email, hasTurnstile: !!turnstileToken }).catch(() => {});

        sessionStorage.removeItem('just_logged_out');

        if (!profile.two_factor_enabled && !(profile.telegram_otp_enabled && profile.telegram_chat_id)) {
            return {
                ...result,
                profile
            };
        }

        if (profile.two_factor_enabled) {
            const fingerprint = localStorage.getItem('device_fingerprint');

            if (fingerprint) {
                const { data: trustedDevice } = await withTimeout(
                    supabase
                        .from('trusted_devices')
                        .select('*')
                        .eq('user_id', user.id)
                        .eq('device_fingerprint', fingerprint)
                        .maybeSingle(),
                    10000,
                    'التحقق من الجهاز الموثوق'
                );

                if (trustedDevice) {
                    supabase
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
            profile,
            turnstileToken
        };

    } catch (err) {
        // ✅ أي timeout أو خطأ غير متوقع بيوصل هنا بدل ما يعلّق الواجهة للأبد
        console.error('signIn unexpected error:', err);
        return {
            data: null,
            error: {
                message: err.message || 'حدث خطأ غير متوقع أثناء تسجيل الدخول، حاول مرة أخرى.'
            }
        };
    }
}

export function onAuthStateChange(callback) {
    return supabase.auth.onAuthStateChange((event, session) => {
        callback(event, session);
    });
}

/**
 * التحقق من صحة البريد الإلكتروني
 */
function validateEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email.trim());
}

/**
 * التحقق من صحة كلمة المرور
 */
function validatePasswordStrength(password) {
    if (password.length < 8) return false;
    if (!/[A-Z]/.test(password)) return false;
    if (!/[a-z]/.test(password)) return false;
    if (!/[0-9]/.test(password)) return false;
    return true;
}

/**
 * التحقق من توفر اسم المستخدم
 */
export async function checkUsernameAvailability(username) {
    try {
        const { data, error } = await withTimeout(
            supabase.from('profiles').select('id').eq('username', username.toLowerCase()).maybeSingle(),
            10000,
            'التحقق من اسم المستخدم'
        );

        if (error) {
            console.error('Error checking username availability:', error);
            return { available: false, error };
        }

        return { available: !data, error: null };
    } catch (err) {
        console.error('Unexpected error checking username availability:', err);
        return { available: false, error: err };
    }
}

async function checkUsernameExists(username) {
    const { available } = await checkUsernameAvailability(username);
    return !available;
}

/**
 * دالة تسجيل حساب جديد محسّنة مع التحقق من البيانات
 */
export async function signUp(email, password, metadata = {}) {
    if (!email || !validateEmail(email)) {
        return {
            data: null,
            error: { message: 'البريد الإلكتروني غير صحيح.' }
        };
    }

    if (!password || !validatePasswordStrength(password)) {
        return {
            data: null,
            error: { message: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل وتحتوي على حرف كبير وحرف صغير ورقم.' }
        };
    }

    try {
        const { data: existingUser, error: checkError } = await withTimeout(
            supabase.from('profiles').select('id').eq('email', email.toLowerCase()).maybeSingle(),
            10000,
            'التحقق من البريد الإلكتروني'
        );

        if (checkError) {
            debugAuthError(checkError);
        }

        if (existingUser) {
            return {
                data: null,
                error: { message: 'هذا البريد الإلكتروني مسجل بالفعل.' }
            };
        }

        if (metadata.username) {
            const usernameExists = await checkUsernameExists(metadata.username);
            if (usernameExists) {
                return {
                    data: null,
                    error: { message: 'اسم المستخدم مسجل بالفعل.' }
                };
            }
        }

        const emailRedirectTo = `${window.location.origin}/login.html`;
        const result = await withTimeout(
            supabase.auth.signUp({
                email: email.toLowerCase(),
                password,
                options: { data: metadata, emailRedirectTo }
            }),
            10000,
            'إنشاء الحساب'
        );

        if (result.error) {
            debugAuthError(result.error);
            return {
                data: null,
                error: { message: result.error.message || 'فشل في إنشاء الحساب. حاول مرة أخرى.' }
            };
        }

        return result;
    } catch (err) {
        console.error('signUp unexpected error:', err);
        return {
            data: null,
            error: { message: err.message || 'حدث خطأ غير متوقع أثناء إنشاء الحساب، حاول مرة أخرى.' }
        };
    }
}

export async function logout() {
    try {
        await logActivity('logout');
    } catch (e) {}

    /* =========================================================
       ✅ تعيين علامة منع إعادة التوجيه التلقائي *قبل* أي محاولة
       signOut، عشان حتى لو signOut اتعلقت (timeout)، الصفحة برضه
       متعملش auto-redirect غلط.
    ========================================================= */
    sessionStorage.setItem('just_logged_out', 'true');

    /* =========================================================
       ملاحظة مهمة على الترتيب:
       لازم نستدعي supabase.auth.signOut() *قبل* ما نمسح مفاتيح
       sb-* من localStorage، لتجنب AuthSessionMissingError.
       ✅ جديد: signOut دلوقتي ملفوف بـ withTimeout — لو العملية
       اتعلقت (مثلاً بسبب navigator.locks deadlock)، هنكمل تنظيف
       التخزين المحلي يدوياً بدل ما نفضل واقفين للأبد. ده بالظبط
       اللي كان بيسبب "لازم امسح الكوكيز عشان أقدر أسجل دخول تاني".
    ========================================================= */

    let signOutError = null;
    try {
        const { error } = await withTimeout(
            supabase.auth.signOut({ scope: 'global' }),
            8000,
            'تسجيل الخروج'
        );
        signOutError = error;
    } catch (err) {
        console.error('supabase.auth.signOut threw an exception or timed out:', err);
        signOutError = err;
    } finally {
        localStorage.removeItem('mad3oom-guest-session');

        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && (key.includes('supabase.auth.token') || key.includes('sb-'))) {
                keysToRemove.push(key);
            }
        }
        keysToRemove.forEach(key => localStorage.removeItem(key));

        const sessionKeysToRemove = [];
        for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            if (key && (key.includes('supabase.auth.token') || key.includes('sb-'))) {
                sessionKeysToRemove.push(key);
            }
        }
        sessionKeysToRemove.forEach(key => sessionStorage.removeItem(key));
    }

    return { error: signOutError };
}

/* =========================================================
   Session & User
========================================================= */

export async function getCurrentUser() {
    const { data: { user }, error } = await supabase.auth.getUser();

    if (error || !user) {
        return null;
    }

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

    const isMainAdminEmail = user.email === 'support@mad3oom.online';
    const role = user.profile?.role;

    const isAdmin =
        isMainAdminEmail ||
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

    if (requiredRole === 'user' && isAdmin && !impersonateId) {
        return null;
    }

    return user;
}

/* =========================================================
   Auto Redirect
========================================================= */

export async function autoRedirect() {
    if (sessionStorage.getItem('just_logged_out')) {
        return;
    }

    const { data: { session } } = await supabase.auth.getSession();
    const guestSession = localStorage.getItem('mad3oom-guest-session');

    if (!session?.user && !guestSession) return;
    const isAuthPage =
        window.location.pathname.includes('login.html') ||
        window.location.pathname === '/' ||
        window.location.pathname.endsWith('index.html');

    if (!isAuthPage) return;

    if (guestSession) {
        window.location.replace('customer-dashboard.html');
        return;
    }

    if (session?.user) {
        const { profile, error } = await ensureUserProfile(session.user);

        const isMainAdminEmail = session.user.email === 'support@mad3oom.online';

        let isAdmin = isMainAdminEmail;

        if (profile) {
            const role = profile.role;
            isAdmin = isAdmin || role === 'admin' || role === 'support' || role === 'super_user';
        }

        const target = isAdmin ? 'admin-dashboard.html' : 'customer-dashboard.html';
        window.location.replace(target);
    }
}

/**
 * تحديث بيانات الملف الشخصي
 */
export async function updateProfile(updates) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: { message: 'يجب تسجيل الدخول أولاً' } };

    const { data, error } = await supabase
        .from('profiles')
        .update(updates)
        .eq('id', user.id)
        .select()
        .single();

    if (error) {
        console.error('Error updating profile:', error);
        return { error };
    }

    return { data };
}

/**
 * تحديث كلمة المرور
 */
export async function updatePassword(newPassword) {
    const { data, error } = await supabase.auth.updateUser({
        password: newPassword
    });

    if (error) {
        console.error('Error updating password:', error);
        return { error };
    }

    return { data };
}

/**
 * دالة للأدمن لتقمص شخصية مستخدم آخر
 */
export async function adminImpersonateUser(userId) {
    if (!userId) return;
    window.location.href = `/customer-dashboard.html?impersonate=${userId}`;
}
