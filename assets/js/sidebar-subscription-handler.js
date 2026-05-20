/**
 * Sidebar Subscription Handler
 * Manages WhatsApp link visibility based on subscription status
 */

import { supabase } from '/api-config.js';
import { getActiveSubscription } from '/whatsapp-subscription-service.js';

/**
 * Check and update WhatsApp link visibility
 */
export async function checkAndUpdateWhatsAppLink() {
    try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
            hideWhatsAppLink();
            return;
        }

        // Check for active subscription or admin-enabled status
        const subscription = await getActiveSubscription();
        
        // Check profile for manual activation
        const { data: profile } = await supabase
            .from('profiles')
            .select('whatsapp_enabled')
            .eq('id', user.id)
            .single();

        const isEnabled = subscription || (profile && profile.whatsapp_enabled);
        const whatsappLink = document.getElementById('whatsappLink');

        if (whatsappLink) {
            if (isEnabled) {
                // Show WhatsApp link
                whatsappLink.style.display = 'flex';
                // Add active indicator
                whatsappLink.classList.add('subscription-active');
            } else {
                // Hide WhatsApp link
                whatsappLink.style.display = 'none';
                whatsappLink.classList.remove('subscription-active');
            }
        }
    } catch (error) {
        console.error('[Sidebar Subscription] Error checking subscription:', error);
        hideWhatsAppLink();
    }
}

/**
 * Hide WhatsApp link
 */
function hideWhatsAppLink() {
    const whatsappLink = document.getElementById('whatsappLink');
    if (whatsappLink) {
        whatsappLink.style.display = 'none';
    }
}

/**
 * Setup real-time subscription monitoring
 */
export function setupSubscriptionMonitoring() {
    try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;

        // Initial check
        checkAndUpdateWhatsAppLink();

        // Setup real-time listener for subscription changes
        const subscription = supabase
            .from(`whatsapp_subscriptions:user_id=eq.${user.id}`)
            .on('*', payload => {
                console.log('[Sidebar Subscription] Subscription changed:', payload);
                checkAndUpdateWhatsAppLink();
            })
            .subscribe();

        // Cleanup on page unload
        window.addEventListener('beforeunload', () => {
            supabase.removeSubscription(subscription);
        });

        // Also check periodically (every 5 minutes)
        setInterval(() => {
            checkAndUpdateWhatsAppLink();
        }, 5 * 60 * 1000);
    } catch (error) {
        console.error('[Sidebar Subscription] Error setting up monitoring:', error);
    }
}

/**
 * Add subscription status badge to WhatsApp link
 */
export async function addSubscriptionBadge() {
    try {
        const whatsappLink = document.getElementById('whatsappLink');
        if (!whatsappLink) return;

        const subscription = await getActiveSubscription();
        if (!subscription) return;

        // Check if badge already exists
        let badge = whatsappLink.querySelector('.subscription-badge');
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'subscription-badge';
            badge.style.cssText = `
                display: inline-block;
                background: #25D366;
                color: white;
                border-radius: 50%;
                width: 24px;
                height: 24px;
                font-size: 12px;
                font-weight: bold;
                text-align: center;
                line-height: 24px;
                position: absolute;
                top: -8px;
                right: -8px;
                border: 2px solid var(--color-surface);
            `;
            whatsappLink.style.position = 'relative';
            whatsappLink.appendChild(badge);
        }

        // Update badge with days remaining
        const now = new Date();
        const endDate = new Date(subscription.end_date);
        const daysRemaining = Math.ceil((endDate - now) / (1000 * 60 * 60 * 24));
        
        if (daysRemaining > 0) {
            badge.textContent = daysRemaining > 99 ? '∞' : daysRemaining;
            badge.title = `${daysRemaining} أيام متبقية`;
        }
    } catch (error) {
        console.error('[Sidebar Subscription] Error adding badge:', error);
    }
}

/**
 * Initialize subscription handler
 */
export async function initSubscriptionHandler() {
    try {
        // Check and update WhatsApp link visibility
        await checkAndUpdateWhatsAppLink();
        
        // Add subscription badge
        await addSubscriptionBadge();
        
        // Setup monitoring
        setupSubscriptionMonitoring();
    } catch (error) {
        console.error('[Sidebar Subscription] Error initializing handler:', error);
    }
}
