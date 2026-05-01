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

// v1.0.1 - Fixed export for dynamic import
