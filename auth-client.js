
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

    // مسح علامة الخروج عند الدخول كضيف
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
        // 1. محاولة جلب الملف الشخصي
        let { data: profile, error: fetchError } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .maybeSingle();

        // 2. التعامل مع أخطاء السيرفر (مثل خطأ 500)
        if (fetchError) {
            console.error('Supabase Server Error (500/Fetch):', fetchError);
            
            // إذا كان هناك خطأ في السيرفر، لا نمنع المستخدم من الدخول
            // بل نقوم بإنشاء ملف شخصي مؤقت في الذاكرة للسماح له بالوصول للوحة التحكم
            const userMetadata = user.user_metadata || {};
            return { 
                profile: {
                    id: user.id,
                    email: user.email,
                    username: userMetadata.username || user.email.split('@')[0],
                    full_name: userMetadata.full_name || userMetadata.first_name || 'مستخدم (بيانات مؤقتة)',
                    user_type: userMetadata.user_type || 'individual',
                    role: 'customer',
                    is_temporary: true // علامة تدل على أن البيانات لم تُجلب من قاعدة البيانات
                }, 
                error: null 
            };
        }

        // 3. إذا كان الملف الشخصي موجوداً، قم بإرجاعه
        if (profile) {
            return { profile, error: null };
        }

        // 4. إذا كان مفقوداً تماماً، حاول إنشاءه
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
            console.error('Failed to create missing profile (Database Error):', insertError);
            // حتى لو فشل الإدخال، نرجع الملف الشخصي الذي حاولنا إنشاءه للسماح بالدخول
            return { profile: newProfile, error: null };
        }

        return { profile: createdProfile, error: null };
    } catch (err) {
        console.error('Unexpected error in ensureUserProfile:', err);
        // في حالة حدوث أي خطأ غير متوقع، ننشئ ملف شخصي وهمي للسماح بالدخول
        return { 
            profile: {
                id: user.id,
                email: user.email,
                role: 'customer',
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

    if (!normalizedIdentifier.includes('@')) {
        // محاولة جلب البريد الإلكتروني باستخدام اسم المستخدم
        const { data: profile, error: profileLookupError } = await supabase
            .from('profiles')
            .select('email')
            .eq('username', normalizedIdentifier)
            .maybeSingle();

        // إذا فشل جلب البريد بسبب خطأ 500، نبلغ المستخدم
        if (profileLookupError) {
            console.error('Username lookup failed (500):', profileLookupError);
            return {
                data: null,
                error: {
                    message: 'حدث خطأ في الاتصال بالسيرفر. يرجى المحاولة باستخدام البريد الإلكتروني بدلاً من اسم المستخدم.'
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

    // استخدام ensureUserProfile لضمان وجود بيانات الحساب حتى لو تعطل السيرفر
    const { profile, error: profileError } = await ensureUserProfile(user);

    if (profileError || !profile) {
        await supabase.auth.signOut();
        return {
            data: null,
            error: {
                message: 'تعذر تحميل بيانات الحساب بسبب مشكلة فنية في السيرفر.'
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

    logActivity('login', { email, hasTurnstile: !!turnstileToken }).catch(() => {});
    
    // مسح علامة الخروج عند تسجيل الدخول بنجاح
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
        profile,
        turnstileToken
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
/**
 * التحقق من توفر اسم المستخدم
 * @param {string} username - اسم المستخدم
 * @returns {Promise<{available: boolean, error: any}>}
 */
export async function checkUsernameAvailability(username) {
    try {
        const { data, error } = await supabase
            .from('profiles')
            .select('id')
            .eq('username', username.toLowerCase())
            .maybeSingle();

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
        // لا نمنع التسجيل إذا فشل التحقق بسبب خطأ 500، نترك Supabase Auth يتعامل مع التكرار
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

    // تعيين علامة لمنع إعادة التوجيه التلقائي فوراً بعد الخروج
    sessionStorage.setItem('just_logged_out', 'true');

    // مسح جميع بيانات الجلسات المحلية فوراً
    localStorage.removeItem('mad3oom-guest-session');
    
    // مسح أي بيانات أخرى قد تكون متعلقة بالجلسة (Supabase tokens)
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.includes('supabase.auth.token') || key.includes('sb-'))) {
            keysToRemove.push(key);
        }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));

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

    // التحقق من البريد الإلكتروني للأدمن الرئيسي كإجراء احتياطي (Fallback)
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

    if (requiredRole === 'customer' && isAdmin && !impersonateId) {
        return null;
    }

    return user;
}

/* =========================================================
   Auto Redirect
========================================================= */

export async function autoRedirect() {
    // إذا كان المستخدم قد سجل خروجه للتو، لا تقم بإعادة التوجيه التلقائي
    if (sessionStorage.getItem('just_logged_out')) {
        return;
    }

    const { data: { session } } = await supabase.auth.getSession();
    const guestSession = localStorage.getItem('mad3oom-guest-session');

    if (!session?.user && !guestSession) return;

    const isAuthPage =
        window.location.pathname.includes('sign-in.html') ||
        window.location.pathname.includes('sign-up.html') ||
        window.location.pathname === '/' ||
        window.location.pathname.endsWith('index.html');

    if (!isAuthPage) return;

    // إذا كان المستخدم في صفحة تسجيل الدخول ولديه جلسة نشطة، قم بتوجيهه للوحة التحكم
    if (guestSession) {
        window.location.replace('customer-dashboard.html');
        return;
    }

    if (session?.user) {
        const { profile, error } = await ensureUserProfile(session.user);

        // التحقق من البريد الإلكتروني للأدمن الرئيسي كإجراء احتياطي
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
 * @param {Object} updates - البيانات المراد تحديثها
 * @returns {Object} - نتيجة التحديث
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
 * @param {string} newPassword - كلمة المرور الجديدة
 * @returns {Object} - نتيجة التحديث
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
 * @param {string} userId - معرف المستخدم المراد تقمص شخصيته
 */
export async function adminImpersonateUser(userId) {
    if (!userId) return;
    
    // نقوم بتخزين معرف المستخدم في sessionStorage أو استخدامه مباشرة في الرابط
    // الطريقة المتبعة في المشروع تعتمد على وجود ?impersonate=ID في الرابط
    // لذا سنقوم بتوجيه المستخدم للوحة التحكم مع هذا المعامل
    window.location.href = `/customer-dashboard.html?impersonate=${userId}`;
}
