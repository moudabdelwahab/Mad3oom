/**
 * customer-data.js — طبقة قراءة موحّدة لحالة حساب العميل.
 *
 * مبدأ التصميم: مفيش أي منطق جديد للتذاكر/الاشتراكات/المكافآت هنا. الملف ده
 * بيقرأ الجداول اللي فيها بيانات العميل مباشرة (كلها محمية بـRLS على
 * auth.uid())، وبيعيد استخدام الخدمات الموجودة لأي حاجة ليها خدمة أصلاً
 * (whatsapp-subscription-service للاشتراكات، tickets-service للتذاكر).
 *
 * كل استعلام هنا بيحط .eq('user_id', user.id) صراحةً حتى والـRLS بيفرض نفس
 * الشرط — دفاع في العمق: لو سياسة اتوسّعت غلط في المستقبل، الواجهة تفضل
 * بتطلب صف العميل نفسه بس.
 *
 * كل دالة بترجّع { ok, data, error } بدل ما ترمي استثناء، عشان فشل قسم واحد
 * في لوحة العميل ميوقّعش باقي اللوحة — القسم بيعرض حالة خطأ خاصة بيه.
 */

import { supabase } from '/api-config.js';
import { getSubscriptionStatus } from '/whatsapp-subscription-service.js';

/** غلاف موحّد: بيمنع أي استعلام من إسقاط الصفحة كلها. */
async function safe(label, fn) {
    try {
        const data = await fn();
        return { ok: true, data, error: null };
    } catch (err) {
        console.error(`[CustomerData] ${label}:`, err?.message || err);
        return { ok: false, data: null, error: err?.message || 'تعذّر تحميل البيانات' };
    }
}

async function currentUserId() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('جلسة غير صالحة');
    return user.id;
}

/* =========================================================
   1) حالة الحساب — كل ما يضبطه الأدمن على البروفايل
========================================================= */

export async function fetchAccountStatus() {
    return safe('accountStatus', async () => {
        const userId = await currentUserId();
        const { data, error } = await supabase
            .from('profiles')
            .select([
                'id', 'email', 'full_name', 'phone', 'avatar_url', 'role', 'user_type',
                'created_at', 'is_verified', 'points',
                'ban_status', 'ban_until', 'ban_reason',
                'whatsapp_enabled', 'aqar_enabled',
                'two_factor_enabled', 'telegram_otp_enabled', 'telegram_username',
                'last_password_change'
            ].join(', '))
            .eq('id', userId)
            .maybeSingle();
        if (error) throw error;
        return data;
    });
}

/* =========================================================
   2) الاشتراكات والباقات — يديرها الأدمن، والعميل يقرأ حالته
========================================================= */

/** أسماء الباقات للعرض. مفاتيحها هي نفسها في subscription_plans.key. */
const PLAN_CATALOGUE = {
    support:  { key: 'support',  name: 'Support',  name_ar: 'الدعم الفني' },
    whatsapp: { key: 'whatsapp', name: 'WhatsApp', name_ar: 'واتساب' },
    bundle:   { key: 'bundle',   name: 'Bundle',   name_ar: 'دعم فني + واتساب' }
};


/**
 * اشتراكات العميل — من whatsapp_subscriptions، وهو مصدر الحقيقة الوحيد.
 *
 * كانت هذه الدالة تقرأ من customer_subscriptions، وهو جدول **فارغ تمامًا في
 * الإنتاج (صفر صفوف)** بينما كل الاشتراكات الحقيقية في whatsapp_subscriptions.
 * فكانت لوحة العميل تعرض «لا اشتراك» لكل عميل دافع، وتتناقض مع محرك الصلاحيات
 * الذي تعتمد عليه بقية المنظومة (Finding H2).
 *
 * الشكل المُعاد ثابت كما كان حتى لا تتغير واجهة العرض.
 */
export async function fetchPlanSubscriptions() {
    return safe('planSubscriptions', async () => {
        const userId = await currentUserId();
        const { data, error } = await supabase
            .from('whatsapp_subscriptions')
            .select('id, plan, status, billing_cycle, start_date, end_date, is_renewal, created_at')
            .eq('user_id', userId)
            .order('end_date', { ascending: false });
        if (error) throw error;

        const now = Date.now();
        return (data || []).map(s => ({
            id: s.id,
            status: s.status,
            start_date: s.start_date,
            end_date: s.end_date,
            billing_cycle: s.billing_cycle,
            // «فعّال» بنفس تعريف القاعدة بالضبط: الحالة والتاريخان معًا. الاعتماد
            // على status وحده كان يعرض اشتراكًا منتهيًا على أنه فعّال.
            is_active: s.status === 'active'
                && new Date(s.start_date).getTime() <= now
                && new Date(s.end_date).getTime() > now,
            plan_key: s.plan,
            subscription_plans: PLAN_CATALOGUE[s.plan] || { key: s.plan, name: s.plan, name_ar: s.plan }
        }));
    });
}

/**
 * المميزات المتاحة فعليًا للعميل — من owned_feature_keys() في القاعدة.
 *
 * نفس الدالة التي تقرر الوصول في كل مكان آخر (has_feature_access،
 * company_has_feature، قاعدة منع التداخل)، فلا يمكن أن تعرض اللوحة شيئًا
 * والـbackend يطبّق شيئًا آخر.
 */
export async function fetchEntitlements() {
    return safe('entitlements', async () => {
        const [{ data: owned, error: ownedError }, { data: flags, error: flagsError }] = await Promise.all([
            supabase.rpc('owned_feature_keys'),
            supabase.from('feature_flags').select('key, name, name_ar, description')
        ]);
        if (ownedError) throw ownedError;
        if (flagsError) throw flagsError;

        const enabled = new Set(owned || []);
        return (flags || []).map(flag => ({
            key: flag.key,
            label: flag.name_ar || flag.name || flag.key,
            description: flag.description || '',
            enabled: enabled.has(flag.key)
        }));
    });
}

/** اشتراك خدمة الواتساب — إعادة استخدام الخدمة الموجودة بدل تكرار منطقها. */
export async function fetchWhatsappSubscription() {
    return safe('whatsappSubscription', () => getSubscriptionStatus());
}

/* =========================================================
   3) رصيد الواتساب — الأدمن هو اللي بيشحنه، العميل بيتابعه
========================================================= */

export async function fetchWhatsappWallet() {
    return safe('whatsappWallet', async () => {
        const userId = await currentUserId();
        const [{ data: wallet, error: walletError }, { data: transactions, error: txError }] = await Promise.all([
            supabase
                .from('whatsapp_wallets')
                .select('balance, currency, low_balance_threshold, updated_at')
                .eq('user_id', userId)
                .maybeSingle(),
            supabase
                .from('whatsapp_wallet_transactions')
                .select('id, amount, balance_after, transaction_type, description, created_at')
                .eq('user_id', userId)
                .order('created_at', { ascending: false })
                .limit(10)
        ]);
        if (walletError) throw walletError;
        if (txError) throw txError;

        if (!wallet) return null;

        const balance = Number(wallet.balance) || 0;
        const threshold = Number(wallet.low_balance_threshold) || 0;
        return {
            ...wallet,
            balance,
            isLow: threshold > 0 && balance <= threshold,
            transactions: transactions || []
        };
    });
}

/* =========================================================
   4) وصول المحرك الذكي (SIE) — الأدمن يمنحه ويحدد الحصة
========================================================= */

export async function fetchSieAccess() {
    return safe('sieAccess', async () => {
        const userId = await currentUserId();
        const { data, error } = await supabase
            .from('customer_sie_access')
            .select('is_enabled, access_mode, message_quota, messages_used, expires_at, last_used_at')
            .eq('user_id', userId)
            .maybeSingle();
        if (error) throw error;
        if (!data) return null;

        const quota = Number(data.message_quota) || 0;
        const used = Number(data.messages_used) || 0;
        return {
            ...data,
            quota,
            used,
            remaining: quota > 0 ? Math.max(0, quota - used) : null,
            usedPercent: quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : null,
            isExpired: !!data.expires_at && new Date(data.expires_at) < new Date()
        };
    });
}

/* =========================================================
   5) النطاق الفرعي — العميل يطلبه والأدمن يفعّله
========================================================= */

export async function fetchSubdomains() {
    return safe('subdomains', async () => {
        const userId = await currentUserId();
        const { data, error } = await supabase
            .from('subdomain_requests')
            .select('id, subdomain, full_domain, status, created_at, activated_at, suspended_at, error_message')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });
        if (error) throw error;
        return data || [];
    });
}

/* =========================================================
   6) مفاتيح API الخاصة بالعميل + استخدامها
========================================================= */

export async function fetchApiTokens() {
    return safe('apiTokens', async () => {
        const userId = await currentUserId();
        const { data, error } = await supabase
            .from('api_tokens')
            .select('id, name, description, api_key, secret_last_four, is_active, created_at, last_used_at, revoked_at, usage_count, expires_at, scopes')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });
        if (error) throw error;
        return data || [];
    });
}

/** آخر نداءات API (سجل تدقيق) — للعميل صاحب المفاتيح فقط. */
export async function fetchApiUsage(limit = 10) {
    return safe('apiUsage', async () => {
        const userId = await currentUserId();
        const { data, error } = await supabase
            .from('api_token_usage_logs')
            .select('id, created_at, endpoint, method, status_code, token_id')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(limit);
        if (error) throw error;
        return data || [];
    });
}

/* =========================================================
   7) حالة النظام — يديرها الأدمن من صفحة الحالة (قراءة عامة)
========================================================= */

export async function fetchSystemStatus() {
    return safe('systemStatus', async () => {
        const [{ data: services, error: servicesError }, { data: incidents, error: incidentsError }] = await Promise.all([
            supabase
                .from('services')
                .select('id, name, description, service_key, status, response_time, last_checked, status_changed_at, updated_at')
                .order('name', { ascending: true }),
            supabase
                .from('incidents')
                .select('id, title, description, status, affected_services, created_at, updated_at, resolved_at')
                .is('resolved_at', null)
                .order('created_at', { ascending: false })
                .limit(5)
        ]);
        if (servicesError) throw servicesError;
        if (incidentsError) throw incidentsError;

        const list = services || [];
        // الصيانة حالة معلنة ومقصودة، مش عطل — فما بتتحسبش ضمن "المتدهور"
        const degraded = list.filter(s => s.status && s.status !== 'operational' && s.status !== 'maintenance');
        return {
            services: list,
            incidents: incidents || [],
            degraded,
            maintenance: list.filter(s => s.status === 'maintenance'),
            allOperational: list.length > 0 && degraded.length === 0
        };
    });
}

/* =========================================================
   7.a بلاغات العميل عن الأعطال
========================================================= */

/**
 * بلاغات العميل الحالية. بنقراها مرة واحدة مع اللقطة عشان نعرف على أي
 * عطل بلّغ بالفعل، فالزر يظهر "تم الإبلاغ" بدل ما يسمح ببلاغ مكرر يترفض
 * من القاعدة بعد الضغط.
 */
export async function fetchMyServiceReports() {
    return safe('serviceReports', async () => {
        const userId = await currentUserId();
        const { data, error } = await supabase
            .from('customer_service_reports')
            .select('id, service_id, incident_id, episode_key, status, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(50);
        if (error) throw error;
        return data || [];
    });
}

/**
 * إبلاغ الإدارة بأن العميل متأثر بعطل.
 * episode_key بيتحسب في trigger على السيرفر، ومنع التكرار قيد فريد في
 * القاعدة — فالواجهة ما بتحاولش تفرضه بنفسها.
 */
export async function reportServiceIssue({ serviceId, incidentId = null }) {
    return safe('reportService', async () => {
        const userId = await currentUserId();
        const { data, error } = await supabase
            .from('customer_service_reports')
            .insert({ user_id: userId, service_id: serviceId, incident_id: incidentId })
            .select('id, service_id, incident_id, episode_key, created_at')
            .single();

        if (error) {
            // 23505 = انتهاك القيد الفريد: بلاغ سابق على نفس النوبة
            if (error.code === '23505') return { duplicate: true };
            throw error;
        }
        return { duplicate: false, report: data };
    });
}

/* =========================================================
   8) سجل نشاط الحساب — العميل يقرأ سجله هو فقط
========================================================= */

export async function fetchAccountActivity(limit = 12) {
    return safe('accountActivity', async () => {
        const userId = await currentUserId();
        const { data, error } = await supabase
            .from('activity_logs')
            .select('id, action, details, created_at, ip_address, device_info')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(limit);
        if (error) throw error;
        return data || [];
    });
}

/* =========================================================
   9) عدد الإشعارات غير المقروءة (للشارة في التنقّل)
========================================================= */

export async function fetchUnreadNotificationsCount() {
    return safe('unreadNotifications', async () => {
        const userId = await currentUserId();
        const { count, error } = await supabase
            .from('notifications')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('is_read', false);
        if (error) throw error;
        return count || 0;
    });
}

/* =========================================================
   10) تقدّم الشارات (عدد المكتسب / الإجمالي) للعرض المختصر
========================================================= */

export async function fetchBadgeProgress() {
    return safe('badgeProgress', async () => {
        const userId = await currentUserId();
        const [{ count: total, error: defError }, { count: earned, error: earnedError }] = await Promise.all([
            supabase.from('badge_definitions').select('id', { count: 'exact', head: true }).eq('is_active', true),
            supabase.from('customer_badges').select('id', { count: 'exact', head: true }).eq('user_id', userId)
        ]);
        if (defError) throw defError;
        if (earnedError) throw earnedError;
        return { total: total || 0, earned: earned || 0 };
    });
}
