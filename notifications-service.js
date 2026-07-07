import { supabase } from './api-config.js';

/**
 * جلب إشعارات المستخدم الحالي فقط
 */
export async function fetchNotifications() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return [];

    // نضمن دائماً فلترة الإشعارات حسب معرف المستخدم الحالي
    const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(20);

    if (error) {
        console.error('[Notifications] Error fetching notifications:', error);
        throw error;
    }
    return data;
}

/**
 * جلب صفحة واحدة من الإشعارات مع دعم الفلترة الكاملة
 * (تُستخدم في صفحة "كل الإشعارات" المستقلة)
 *
 * @param {Object} options
 * @param {'all'|'unread'|'read'} options.status
 * @param {string} options.type - 'all' أو أحد أنواع الإشعارات (chat, info, success, subdomain, error...)
 * @param {string|null} options.dateFrom - تاريخ بصيغة yyyy-mm-dd
 * @param {string|null} options.dateTo - تاريخ بصيغة yyyy-mm-dd
 * @param {string} options.search - بحث نصي في العنوان والرسالة
 * @param {number} options.page - رقم الصفحة (يبدأ من 1)
 * @param {number} options.pageSize
 * @returns {Promise<{data: Array, count: number}>}
 */
export async function fetchNotificationsPage({
    status = 'all',
    type = 'all',
    dateFrom = null,
    dateTo = null,
    search = '',
    page = 1,
    pageSize = 15
} = {}) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { data: [], count: 0 };

    let query = supabase
        .from('notifications')
        .select('*', { count: 'exact' })
        .eq('user_id', user.id);

    if (status === 'unread') query = query.eq('is_read', false);
    if (status === 'read') query = query.eq('is_read', true);

    if (type && type !== 'all') query = query.eq('type', type);

    if (dateFrom) {
        query = query.gte('created_at', new Date(dateFrom + 'T00:00:00').toISOString());
    }
    if (dateTo) {
        query = query.lte('created_at', new Date(dateTo + 'T23:59:59').toISOString());
    }

    if (search && search.trim()) {
        // تهريب علامات % و _ الخاصة بـ ilike عشان ميحصلش سلوك غير متوقع في البحث
        const term = search.trim().replace(/[%_]/g, '\\$&');
        query = query.or(`title.ilike.%${term}%,message.ilike.%${term}%`);
    }

    const from = (Math.max(page, 1) - 1) * pageSize;
    const to = from + pageSize - 1;

    query = query.order('created_at', { ascending: false }).range(from, to);

    const { data, error, count } = await query;

    if (error) {
        console.error('[Notifications] Error fetching notifications page:', error);
        throw error;
    }

    return { data: data || [], count: count || 0 };
}

/**
 * جلب عدد الإشعارات غير المقروءة للمستخدم الحالي (بدون فلاتر)
 */
export async function fetchUnreadCount() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return 0;

    const { count, error } = await supabase
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('is_read', false);

    if (error) {
        console.error('[Notifications] Error fetching unread count:', error);
        return 0;
    }
    return count || 0;
}

/**
 * تحديد إشعار كمقروء
 */
export async function markAsRead(notificationId) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { error } = await supabase
        .from('notifications')
        .update({ is_read: true })
        .eq('id', notificationId)
        .eq('user_id', user.id); // ضمان الأمان: لا يمكن للمستخدم تحديث إشعار غير خاص به

    if (error) throw error;
}

/**
 * إرجاع إشعار إلى حالة "غير مقروء" (تراجع)
 */
export async function markAsUnread(notificationId) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { error } = await supabase
        .from('notifications')
        .update({ is_read: false })
        .eq('id', notificationId)
        .eq('user_id', user.id);

    if (error) throw error;
}

/**
 * أنواع الإشعارات المعروفة حالياً في النظام (تُستخدم لبناء إحصائيات لوحة الأدمن)
 */
export const NOTIFICATION_TYPES = ['chat', 'info', 'success', 'subdomain', 'error'];

/**
 * جلب عدد الإشعارات لكل نوع + الإجمالي + غير المقروء، للمستخدم الحالي
 * @returns {Promise<{byType: Object<string, number>, total: number, unread: number}>}
 */
export async function fetchNotificationTypeCounts() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { byType: {}, total: 0, unread: 0 };

    const typeResults = await Promise.all(
        NOTIFICATION_TYPES.map(async (t) => {
            const { count, error } = await supabase
                .from('notifications')
                .select('*', { count: 'exact', head: true })
                .eq('user_id', user.id)
                .eq('type', t);
            if (error) {
                console.error(`[Notifications] Error counting type "${t}":`, error);
                return [t, 0];
            }
            return [t, count || 0];
        })
    );

    const byType = Object.fromEntries(typeResults);
    const total = Object.values(byType).reduce((sum, n) => sum + n, 0);
    const unread = await fetchUnreadCount();

    return { byType, total, unread };
}

/**
 * تحديد كل الإشعارات كمقروءة للمستخدم الحالي
 */
export async function markAllAsRead() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { error } = await supabase
        .from('notifications')
        .update({ is_read: true })
        .eq('user_id', user.id)
        .eq('is_read', false);

    if (error) throw error;
}

/**
 * إنشاء إشعار جديد
 */
export async function createNotification({ userId, title, message, type = 'info', link = null }) {
    if (!userId) return;

    const { error } = await supabase
        .from('notifications')
        .insert({
            user_id: userId,
            title,
            message,
            type,
            link
        });

    if (error) {
        console.error('[Notifications] Error creating notification:', error);
        throw error;
    }
}

/**
 * إرسال إشعار لجميع المستخدمين
 */
export async function broadcastNotification({ title, message, type = 'info', link = null }) {
    try {
        // 1. جلب جميع معرفات المستخدمين من جدول البروفايلات
        const { data: profiles, error: fetchError } = await supabase
            .from('profiles')
            .select('id');

        if (fetchError) {
            console.error('[Notifications] Error fetching profiles for broadcast:', fetchError);
            throw new Error('فشل جلب قائمة المستخدمين: ' + fetchError.message);
        }
        
        if (!profiles || profiles.length === 0) {
            console.warn('[Notifications] No profiles found to broadcast to');
            return;
        }

        console.log(`[Notifications] Broadcasting to ${profiles.length} users`);

        // 2. تجهيز مصفوفة الإشعارات للإدخال الجماعي
        const notifications = profiles.map(profile => ({
            user_id: profile.id,
            title,
            message,
            type,
            link,
            is_read: false
        }));

        // 3. إدخال جماعي في جدول الإشعارات
        // نقوم بتقسيم الإرسال إلى دفعات (Chunks) إذا كان العدد كبيراً جداً لتجنب تجاوز حدود الطلب
        const chunkSize = 100;
        for (let i = 0; i < notifications.length; i += chunkSize) {
            const chunk = notifications.slice(i, i + chunkSize);
            const { error: insertError } = await supabase
                .from('notifications')
                .insert(chunk);

            if (insertError) {
                console.error('[Notifications] Error inserting broadcast chunk:', insertError);
                throw new Error('فشل إدراج الإشعارات في قاعدة البيانات: ' + insertError.message);
            }
        }
        
        console.log('[Notifications] Broadcast completed successfully');
    } catch (error) {
        console.error('[Notifications] Broadcast failed:', error);
        throw error;
    }
}

/**
 * تحويل تاريخ إلى نص نسبي بالعربي (منذ دقيقة/ساعة/يوم...)
 */
export function formatRelativeArabic(dateStr) {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffMin = Math.floor(diffMs / 60000);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffMin < 1) return 'الآن';
    if (diffMin < 60) return `منذ ${diffMin} ${diffMin === 1 ? 'دقيقة' : 'دقائق'}`;
    if (diffHour < 24) return `منذ ${diffHour} ${diffHour === 1 ? 'ساعة' : 'ساعات'}`;
    if (diffDay < 30) return `منذ ${diffDay} ${diffDay === 1 ? 'يوم' : 'أيام'}`;

    return date.toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * الاشتراك في الإشعارات اللحظية للمستخدم الحالي
 */
// Store active notification channels to prevent duplicate subscriptions
const activeNotificationChannels = new Map();

/**
 * الاشتراك في الإشعارات اللحظية للمستخدم الحالي
 */
export function subscribeToNotifications(userId, callback) {
    if (!userId) return null;
    
    const channelName = `user-notifications-${userId}`;
    
    // If already subscribed to this channel, just return the existing one
    if (activeNotificationChannels.has(channelName)) {
        console.log('[Notifications] Already subscribed to notifications for user:', userId);
        return activeNotificationChannels.get(channelName);
    }
    
    console.log('[Notifications] Subscribing to notifications for user:', userId);
    
    const channel = supabase
        .channel(channelName)
        .on('postgres_changes', { 
            event: 'INSERT', 
            schema: 'public', 
            table: 'notifications',
            filter: `user_id=eq.${userId}`
        }, payload => {
            console.log('[Notifications] Realtime notification received:', payload);
            callback(payload.new);
        })
        .subscribe((status) => {
            console.log('[Notifications] Subscription status:', status);
            if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
                activeNotificationChannels.delete(channelName);
            }
        });
    
    activeNotificationChannels.set(channelName, channel);
    return channel;
}

// v1.1.0 - Added fetchNotificationsPage / fetchUnreadCount / formatRelativeArabic for the standalone notifications page
