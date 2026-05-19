/**
 * WhatsApp Subscription Service
 * Manages WhatsApp project subscriptions for customers
 */

import { supabase } from '/api-config.js';

/**
 * Create a WhatsApp subscription ticket
 * @param {string} planType - 'monthly' or 'yearly'
 * @returns {Promise<Object>} - Subscription ticket details
 */
export async function createSubscriptionTicket(planType) {
    try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error('User not authenticated');

        // Calculate end date based on plan type
        const startDate = new Date();
        const endDate = new Date();
        if (planType === 'monthly') {
            endDate.setMonth(endDate.getMonth() + 1);
        } else if (planType === 'yearly') {
            endDate.setFullYear(endDate.getFullYear() + 1);
        } else {
            throw new Error('Invalid plan type');
        }

        // Create a support ticket for subscription request
        const { data: ticket, error: ticketError } = await supabase
            .from('tickets')
            .insert({
                user_id: user.id,
                title: `طلب اشتراك مشروع واتساب - ${planType === 'monthly' ? 'شهري' : 'سنوي'}`,
                description: `طلب اشتراك جديد في مشروع الواتساب\n\nنوع الخطة: ${planType === 'monthly' ? 'شهري' : 'سنوي'}\nتاريخ البداية: ${startDate.toLocaleString('ar-EG')}\nتاريخ النهاية: ${endDate.toLocaleString('ar-EG')}`,
                status: 'open',
                priority: 'high'
            })
            .select()
            .single();

        if (ticketError) throw ticketError;

        // Create subscription record with pending status
        const { data: subscription, error: subError } = await supabase
            .from('whatsapp_subscriptions')
            .insert({
                user_id: user.id,
                ticket_id: ticket.id,
                plan_type: planType,
                start_date: startDate.toISOString(),
                end_date: endDate.toISOString(),
                status: 'pending'
            })
            .select()
            .single();

        if (subError) throw subError;

        return {
            success: true,
            ticket,
            subscription
        };
    } catch (error) {
        console.error('Error creating subscription ticket:', error);
        throw error;
    }
}

/**
 * Get user's active WhatsApp subscription
 * @returns {Promise<Object|null>} - Active subscription or null
 */
export async function getActiveSubscription() {
    try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return null;

        const now = new Date().toISOString();
        
        const { data: subscription, error } = await supabase
            .from('whatsapp_subscriptions')
            .select('*')
            .eq('user_id', user.id)
            .eq('status', 'active')
            .gt('end_date', now)
            .order('end_date', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error) throw error;
        return subscription;
    } catch (error) {
        console.error('Error fetching active subscription:', error);
        return null;
    }
}

/**
 * Get all user's subscriptions (active and expired)
 * @returns {Promise<Array>} - Array of subscriptions
 */
export async function getUserSubscriptions() {
    try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return [];

        const { data: subscriptions, error } = await supabase
            .from('whatsapp_subscriptions')
            .select('*')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false });

        if (error) throw error;
        return subscriptions || [];
    } catch (error) {
        console.error('Error fetching user subscriptions:', error);
        return [];
    }
}

/**
 * Check if subscription is expiring soon (within 7 days)
 * @returns {Promise<Object|null>} - Subscription if expiring soon, null otherwise
 */
export async function checkExpiringSubscription() {
    try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return null;

        const now = new Date();
        const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

        const { data: subscription, error } = await supabase
            .from('whatsapp_subscriptions')
            .select('*')
            .eq('user_id', user.id)
            .eq('status', 'active')
            .gt('end_date', now.toISOString())
            .lte('end_date', sevenDaysFromNow.toISOString())
            .order('end_date', { ascending: true })
            .limit(1)
            .maybeSingle();

        if (error) throw error;
        return subscription;
    } catch (error) {
        console.error('Error checking expiring subscription:', error);
        return null;
    }
}

/**
 * Calculate days remaining for subscription
 * @param {Date|string} endDate - Subscription end date
 * @returns {number} - Days remaining
 */
export function calculateDaysRemaining(endDate) {
    const end = new Date(endDate);
    const now = new Date();
    const diffTime = end - now;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return Math.max(0, diffDays);
}

/**
 * Renew subscription by creating a new ticket
 * @param {string} planType - 'monthly' or 'yearly'
 * @returns {Promise<Object>} - New subscription details
 */
export async function renewSubscription(planType) {
    try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error('User not authenticated');

        // Create renewal ticket
        return await createSubscriptionTicket(planType);
    } catch (error) {
        console.error('Error renewing subscription:', error);
        throw error;
    }
}

/**
 * Get subscription status for display
 * @returns {Promise<Object>} - Status information
 */
export async function getSubscriptionStatus() {
    try {
        const activeSubscription = await getActiveSubscription();
        const expiringSubscription = await checkExpiringSubscription();

        return {
            hasActiveSubscription: !!activeSubscription,
            activeSubscription,
            isExpiringsoon: !!expiringSubscription,
            expiringSubscription,
            daysRemaining: activeSubscription ? calculateDaysRemaining(activeSubscription.end_date) : 0
        };
    } catch (error) {
        console.error('Error getting subscription status:', error);
        return {
            hasActiveSubscription: false,
            activeSubscription: null,
            isExpiringoon: false,
            expiringSubscription: null,
            daysRemaining: 0
        };
    }
}

/**
 * Subscribe to real-time subscription updates
 * @param {Function} callback - Callback function when subscription changes
 * @returns {Function} - Unsubscribe function
 */
export async function subscribeToSubscriptionUpdates(callback) {
    try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return () => {};

        const subscription = supabase
            .from(`whatsapp_subscriptions:user_id=eq.${user.id}`)
            .on('*', payload => {
                callback(payload);
            })
            .subscribe();

        return () => {
            supabase.removeSubscription(subscription);
        };
    } catch (error) {
        console.error('Error subscribing to subscription updates:', error);
        return () => {};
    }
}

/**
 * Mark subscription as expired (admin function)
 * @param {string} subscriptionId - Subscription ID
 * @returns {Promise<Object>} - Updated subscription
 */
export async function expireSubscription(subscriptionId) {
    try {
        const { data: subscription, error } = await supabase
            .from('whatsapp_subscriptions')
            .update({ status: 'expired' })
            .eq('id', subscriptionId)
            .select()
            .single();

        if (error) throw error;
        return subscription;
    } catch (error) {
        console.error('Error expiring subscription:', error);
        throw error;
    }
}

/**
 * Activate a pending subscription (admin function)
 * @param {string} subscriptionId - Subscription ID
 * @returns {Promise<Object>} - Updated subscription
 */
export async function activateSubscription(subscriptionId) {
    try {
        const { data: subscription, error } = await supabase
            .from('whatsapp_subscriptions')
            .update({ status: 'active' })
            .eq('id', subscriptionId)
            .select()
            .single();

        if (error) throw error;
        return subscription;
    } catch (error) {
        console.error('Error activating subscription:', error);
        throw error;
    }
}
