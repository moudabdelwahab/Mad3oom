
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

    const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .maybeSingle();

    if (profileError || !profile) {
        await supabase.auth.signOut();
        return {
            data: null,
            error: {
                message: 'تعذر تحميل بيانات الحساب.'
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
                supabase
                    .from('trusted_devices')
                    .update({ last_used_at: new Date().toISOString() })
                    .eq('id', trustedDevice.id)
                    .then();

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

    const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .maybeSingle();

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
        const { data: profile, error } = await supabase
            .from('profiles')
            .select('role')
            .eq('id', session.user.id)
            .maybeSingle();

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
