/**
 * Subscription Service
 * Manages subscription requests for all plans (support / whatsapp / bundle).
 *
 * NOTE: kept at this file path (/whatsapp-subscription-service.js) so any other
 * page that already imports from here keeps working. Internally it is now
 * generic across all three plans via the `plan` + `billing_cycle` columns on
 * public.whatsapp_subscriptions.
 *
 * BREAKING CHANGE vs the previous version of this file:
 *   createSubscriptionTicket(planType) -> createSubscriptionTicket(plan, billingCycle)
 *   renewSubscription(planType)        -> renewSubscription(plan, billingCycle)
 * If any other page still calls these with the old single-argument signature,
 * it needs to be updated to pass both a plan id and a billing cycle.
 *
 * This module intentionally contains NO payment provider logic (no Stripe, no
 * price IDs, no payment links). It only creates a subscription *request*
 * (a ticket + a pending row). Activation happens later via
 * confirmPurchaseTicket() (admin side), once a payment provider is wired up.
 */

import { supabase } from '/api-config.js';

export const PLANS = ['support', 'whatsapp', 'bundle'];
export const BILLING_CYCLES = ['monthly', 'yearly'];

export const PLAN_LABELS = {
    support: 'الدعم الفني',
    whatsapp: 'واتساب',
    bundle: 'دعم فني + واتساب'
};

export const BILLING_LABELS = {
    monthly: 'شهري',
    yearly: 'سنوي'
};

function assertValidPlan(plan) {
    if (!PLANS.includes(plan)) {
        throw new Error(`Invalid plan: ${plan}. Expected one of: ${PLANS.join(', ')}`);
    }
}

function assertValidBillingCycle(billingCycle) {
    if (!BILLING_CYCLES.includes(billingCycle)) {
        throw new Error(`Invalid billing cycle: ${billingCycle}. Expected one of: ${BILLING_CYCLES.join(', ')}`);
    }
}

/**
 * Create a subscription request ticket for any plan.
 * @param {string} plan - 'support' | 'whatsapp' | 'bundle'
 * @param {string} billingCycle - 'monthly' | 'yearly'
 * @returns {Promise<Object>} - { success, ticket, subscription }
 */
export async function createSubscriptionTicket(plan, billingCycle) {
    assertValidPlan(plan);
    assertValidBillingCycle(billingCycle);

    try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error('User not authenticated');

        const startDate = new Date();
        const endDate = new Date();
        if (billingCycle === 'monthly') {
            endDate.setMonth(endDate.getMonth() + 1);
        } else {
            endDate.setFullYear(endDate.getFullYear() + 1);
        }

        const planLabel = PLAN_LABELS[plan];
        const billingLabel = BILLING_LABELS[billingCycle];

        // Create a support ticket for the subscription request
        const { data: ticket, error: ticketError } = await supabase
            .from('tickets')
            .insert({
                user_id: user.id,
                title: `طلب اشتراك - ${planLabel} (${billingLabel})`,
                description: `طلب اشتراك جديد\n\nالخطة: ${planLabel}\nنوع الفترة: ${billingLabel}\nتاريخ البداية: ${startDate.toLocaleString('ar-EG')}\nتاريخ النهاية: ${endDate.toLocaleString('ar-EG')}`,
                status: 'open',
                priority: 'high'
            })
            .select()
            .single();

        if (ticketError) throw ticketError;

        // Create subscription record with pending status (no payment taken yet)
        const { data: subscription, error: subError } = await supabase
            .from('whatsapp_subscriptions')
            .insert({
                user_id: user.id,
                ticket_id: ticket.id,
                plan,
                billing_cycle: billingCycle,
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
 * Get the user's currently active subscription.
 * @param {string} [plan] - Optional: filter to a specific plan ('support' | 'whatsapp' | 'bundle')
 * @returns {Promise<Object|null>}
 */
export async function getActiveSubscription(plan) {
    try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return null;

        const now = new Date().toISOString();

        let query = supabase
            .from('whatsapp_subscriptions')
            .select('*')
            .eq('user_id', user.id)
            .eq('status', 'active')
            .gt('end_date', now)
            .order('end_date', { ascending: false })
            .limit(1);

        if (plan) {
            assertValidPlan(plan);
            query = query.eq('plan', plan);
        }

        const { data: subscription, error } = await query.maybeSingle();

        if (error) throw error;
        return subscription;
    } catch (error) {
        console.error('Error fetching active subscription:', error);
        return null;
    }
}

/**
 * Get all of the user's subscriptions (active, pending, expired, rejected).
 * @returns {Promise<Array>}
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
 * Check if the active subscription is expiring soon (within 7 days).
 * @returns {Promise<Object|null>}
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
 * @param {Date|string} endDate
 * @returns {number} days remaining (never negative)
 */
export function calculateDaysRemaining(endDate) {
    const end = new Date(endDate);
    const now = new Date();
    const diffTime = end - now;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return Math.max(0, diffDays);
}

/**
 * Renew a subscription by creating a new request ticket.
 * @param {string} plan - 'support' | 'whatsapp' | 'bundle'
 * @param {string} billingCycle - 'monthly' | 'yearly'
 * @returns {Promise<Object>}
 */
export async function renewSubscription(plan, billingCycle) {
    try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error('User not authenticated');

        return await createSubscriptionTicket(plan, billingCycle);
    } catch (error) {
        console.error('Error renewing subscription:', error);
        throw error;
    }
}

/**
 * Get subscription status for display, across any plan.
 * @returns {Promise<Object>}
 */
export async function getSubscriptionStatus() {
    try {
        const activeSubscription = await getActiveSubscription();
        const expiringSubscription = await checkExpiringSubscription();

        return {
            hasActiveSubscription: !!activeSubscription,
            activeSubscription,
            isExpiringSoon: !!expiringSubscription,
            expiringSubscription,
            daysRemaining: activeSubscription ? calculateDaysRemaining(activeSubscription.end_date) : 0
        };
    } catch (error) {
        console.error('Error getting subscription status:', error);
        return {
            hasActiveSubscription: false,
            activeSubscription: null,
            isExpiringSoon: false,
            expiringSubscription: null,
            daysRemaining: 0
        };
    }
}

/**
 * Subscribe to real-time subscription updates for the current user.
 * @param {Function} callback
 * @returns {Promise<Function>} unsubscribe function
 */
export async function subscribeToSubscriptionUpdates(callback) {
    try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return () => {};

        const channel = supabase
            .channel(`whatsapp_subscriptions_updates_${user.id}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'whatsapp_subscriptions',
                    filter: `user_id=eq.${user.id}`
                },
                (payload) => callback(payload)
            )
            .subscribe();

        return () => {
            supabase.removeChannel(channel);
        };
    } catch (error) {
        console.error('Error subscribing to subscription updates:', error);
        return () => {};
    }
}

/* ==================== Admin functions ==================== */

/**
 * Mark a subscription as expired (admin function).
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
 * Activate a pending subscription directly (admin function).
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

/**
 * Confirm a subscription request ticket: activates the subscription and the
 * ticket, and flips profiles.whatsapp_enabled on for plans that include
 * WhatsApp access ('whatsapp' and 'bundle'). Plan-specific entitlement logic
 * lives here so it stays in one place as more plans are added later.
 * @param {string} ticketId
 * @returns {Promise<Object>}
 */
export async function confirmPurchaseTicket(ticketId) {
    try {
        console.log('Confirming purchase ticket:', ticketId);

        const { data: subscription, error: fetchError } = await supabase
            .from('whatsapp_subscriptions')
            .select('*')
            .eq('ticket_id', ticketId)
            .maybeSingle();

        if (fetchError) throw fetchError;

        if (subscription) {
            const { error: subUpdateError } = await supabase
                .from('whatsapp_subscriptions')
                .update({
                    status: 'active',
                    updated_at: new Date().toISOString()
                })
                .eq('id', subscription.id);

            if (subUpdateError) throw subUpdateError;

            // Only plans that include WhatsApp access should flip this flag
            if (subscription.plan === 'whatsapp' || subscription.plan === 'bundle') {
                await supabase
                    .from('profiles')
                    .update({ whatsapp_enabled: true })
                    .eq('id', subscription.user_id);
            }
        }

        const { error: ticketUpdateError } = await supabase
            .from('tickets')
            .update({ status: 'confirmed' })
            .eq('id', ticketId);

        if (ticketUpdateError) throw ticketUpdateError;

        return { success: true };
    } catch (error) {
        console.error('Error confirming purchase ticket:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Reject a subscription request ticket.
 * @param {string} ticketId
 * @param {string} [reason]
 * @returns {Promise<Object>}
 */
export async function rejectPurchaseTicket(ticketId, reason = '') {
    try {
        console.log('Rejecting purchase ticket:', ticketId, reason);

        const { error: updateTicketError } = await supabase
            .from('tickets')
            .update({ status: 'rejected' })
            .eq('id', ticketId);

        if (updateTicketError) throw updateTicketError;

        await supabase
            .from('whatsapp_subscriptions')
            .update({ status: 'rejected' })
            .eq('ticket_id', ticketId);

        return { success: true };
    } catch (error) {
        console.error('Error rejecting purchase ticket:', error);
        return { success: false, error: error.message };
    }
}
