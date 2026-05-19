/**
 * Subscription Expiry Modal Handler
 * Shows a popup notification when subscription is expiring within 7 days
 */

import { supabase } from '/api-config.js';
import { checkExpiringSubscription, calculateDaysRemaining } from '/whatsapp-subscription-service.js';

let expiryModalShown = false;
let expiryCheckInterval = null;

/**
 * Create and show expiry modal
 */
function showExpiryModal(subscription) {
    const daysRemaining = calculateDaysRemaining(subscription.end_date);
    
    // Create modal HTML
    const modalHTML = `
        <div id="subscriptionExpiryModal" class="subscription-expiry-modal" style="
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.5);
            backdrop-filter: blur(4px);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
            padding: 1rem;
        ">
            <div class="modal-content" style="
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                padding: 2.5rem;
                border-radius: 1.5rem;
                max-width: 500px;
                width: 100%;
                box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
                animation: slideUp 0.3s ease-out;
            ">
                <div style="text-align: center; margin-bottom: 1.5rem;">
                    <svg style="width: 60px; height: 60px; margin: 0 auto 1rem; opacity: 0.9;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"></circle>
                        <polyline points="12 6 12 12 16 14"></polyline>
                    </svg>
                    <h2 style="margin: 0 0 0.5rem 0; font-size: 1.5rem; font-weight: 800;">تنبيه مهم</h2>
                    <p style="margin: 0; font-size: 0.95rem; opacity: 0.9;">اشتراكك سينتهي قريباً</p>
                </div>
                
                <div style="background: rgba(255, 255, 255, 0.1); padding: 1.5rem; border-radius: 1rem; margin-bottom: 1.5rem; text-align: center;">
                    <p style="margin: 0 0 0.5rem 0; font-size: 0.9rem; opacity: 0.9;">الأيام المتبقية:</p>
                    <p style="margin: 0; font-size: 2.5rem; font-weight: 800; color: #ffd700;">${daysRemaining}</p>
                    <p style="margin: 0.5rem 0 0 0; font-size: 0.85rem; opacity: 0.9;">
                        تاريخ الانتهاء: ${new Date(subscription.end_date).toLocaleDateString('ar-EG')}
                    </p>
                </div>
                
                <p style="margin: 0 0 1.5rem 0; font-size: 0.95rem; line-height: 1.6;">
                    مشروعك <strong>${subscription.plan_type === 'monthly' ? 'الشهري' : 'السنوي'}</strong> سينتهي خلال <strong>${daysRemaining} أيام</strong>. 
                    قم بتجديد اشتراكك الآن لتجنب انقطاع الخدمة.
                </p>
                
                <div style="display: flex; gap: 1rem; margin-bottom: 1rem;">
                    <button id="renewNowBtn" class="btn-primary" style="
                        flex: 1;
                        background: white;
                        color: #667eea;
                        border: none;
                        padding: 1rem;
                        border-radius: 0.75rem;
                        font-weight: 700;
                        font-size: 1rem;
                        cursor: pointer;
                        transition: all 0.3s;
                    ">تجديد الآن</button>
                    <button id="remindLaterBtn" class="btn-secondary" style="
                        flex: 1;
                        background: rgba(255, 255, 255, 0.2);
                        color: white;
                        border: 2px solid white;
                        padding: 1rem;
                        border-radius: 0.75rem;
                        font-weight: 700;
                        font-size: 1rem;
                        cursor: pointer;
                        transition: all 0.3s;
                    ">تذكرني لاحقاً</button>
                </div>
                
                <button id="closeModalBtn" class="btn-close" style="
                    width: 100%;
                    background: transparent;
                    color: white;
                    border: none;
                    padding: 0.75rem;
                    font-size: 0.9rem;
                    cursor: pointer;
                    opacity: 0.7;
                    transition: opacity 0.3s;
                ">إغلاق</button>
            </div>
        </div>
        
        <style>
            @keyframes slideUp {
                from {
                    opacity: 0;
                    transform: translateY(30px);
                }
                to {
                    opacity: 1;
                    transform: translateY(0);
                }
            }
            
            #renewNowBtn:hover {
                transform: translateY(-2px);
                box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
            }
            
            #remindLaterBtn:hover {
                background: rgba(255, 255, 255, 0.3);
            }
            
            #closeModalBtn:hover {
                opacity: 1;
            }
        </style>
    `;
    
    // Remove existing modal if any
    const existingModal = document.getElementById('subscriptionExpiryModal');
    if (existingModal) {
        existingModal.remove();
    }
    
    // Add modal to body
    document.body.insertAdjacentHTML('beforeend', modalHTML);
    
    // Setup event listeners
    const renewBtn = document.getElementById('renewNowBtn');
    const remindBtn = document.getElementById('remindLaterBtn');
    const closeBtn = document.getElementById('closeModalBtn');
    const modal = document.getElementById('subscriptionExpiryModal');
    
    if (renewBtn) {
        renewBtn.addEventListener('click', () => {
            closeExpiryModal();
            window.location.href = '/customer-subscriptions.html';
        });
    }
    
    if (remindBtn) {
        remindBtn.addEventListener('click', () => {
            // Store reminder for 24 hours
            const remindTime = new Date().getTime() + (24 * 60 * 60 * 1000);
            localStorage.setItem('subscription-expiry-remind-time', remindTime.toString());
            closeExpiryModal();
        });
    }
    
    if (closeBtn) {
        closeBtn.addEventListener('click', closeExpiryModal);
    }
    
    // Close on background click
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeExpiryModal();
            }
        });
    }
    
    expiryModalShown = true;
}

/**
 * Close expiry modal
 */
function closeExpiryModal() {
    const modal = document.getElementById('subscriptionExpiryModal');
    if (modal) {
        modal.style.animation = 'slideDown 0.3s ease-out';
        setTimeout(() => {
            modal.remove();
        }, 300);
    }
    expiryModalShown = false;
}

/**
 * Check if should show expiry modal
 */
async function checkAndShowExpiryModal() {
    try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;
        
        // Check if user has already been reminded in the last 24 hours
        const remindTime = localStorage.getItem('subscription-expiry-remind-time');
        if (remindTime && new Date().getTime() < parseInt(remindTime)) {
            return;
        }
        
        // Check for expiring subscription
        const subscription = await checkExpiringSubscription();
        
        if (subscription && !expiryModalShown) {
            showExpiryModal(subscription);
        }
    } catch (error) {
        console.error('[Subscription Expiry Modal] Error checking expiry:', error);
    }
}

/**
 * Setup periodic checks for expiring subscriptions
 */
export function setupExpiryModalMonitoring() {
    try {
        // Initial check
        checkAndShowExpiryModal();
        
        // Check every 30 minutes
        expiryCheckInterval = setInterval(() => {
            checkAndShowExpiryModal();
        }, 30 * 60 * 1000);
        
        // Cleanup on page unload
        window.addEventListener('beforeunload', () => {
            if (expiryCheckInterval) {
                clearInterval(expiryCheckInterval);
            }
        });
    } catch (error) {
        console.error('[Subscription Expiry Modal] Error setting up monitoring:', error);
    }
}

/**
 * Initialize expiry modal handler
 */
export async function initExpiryModalHandler() {
    try {
        // Setup monitoring
        setupExpiryModalMonitoring();
    } catch (error) {
        console.error('[Subscription Expiry Modal] Error initializing handler:', error);
    }
}
