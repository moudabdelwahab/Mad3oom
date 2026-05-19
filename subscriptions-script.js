// ==================== Subscriptions Page Script ====================
import { supabase } from '/api-config.js';
import {
    createSubscriptionTicket,
    getActiveSubscription,
    getUserSubscriptions,
    calculateDaysRemaining,
    renewSubscription,
    getSubscriptionStatus
} from '/whatsapp-subscription-service.js';

let currentUser = null;
let currentSubscriptionStatus = null;

// Stripe Price IDs (Created via MCP)
const STRIPE_PRICES = {
    monthly: 'price_1TUBXnLNI3gg0lWpD8Gx5MV8', // $15
    yearly: 'price_1TUBXrLNI3gg0lWpd7XWuYiF'   // $150
};

// Toggle billing period (monthly/yearly)
function toggleBilling() {
    const toggleBtn = document.getElementById('billingToggle');
    if (!toggleBtn) return;
    
    const options = toggleBtn.querySelectorAll('.toggle-option');
    const isYearly = !options[1].classList.contains('active');
    
    options.forEach(opt => opt.classList.toggle('active'));
    
    // Update prices based on billing period
    updatePrices(isYearly ? 'yearly' : 'monthly');
}

function updatePrices(period) {
    const premiumAmount = document.getElementById('premiumAmount');
    const premiumPeriod = document.getElementById('premiumPeriod');
    const premiumOldPrice = document.getElementById('premiumOldPrice');
    const premiumDiscount = document.getElementById('premiumDiscount');
    const limitedTimeOffer = document.getElementById('limitedTimeOffer');
    const currencyElements = document.querySelectorAll('.currency');

    // Update currency to USD
    currencyElements.forEach(el => {
        if (el.closest('.pricing-card').classList.contains('premium-plan')) {
            el.textContent = '$';
        }
    });

    if (period === 'yearly') {
        // السعر السنوي 150 دولار (بدلاً من 180)
        premiumAmount.textContent = '150';
        premiumPeriod.textContent = '/سنوياً';
        premiumOldPrice.textContent = '180';
        premiumOldPrice.style.display = 'inline';
        premiumDiscount.textContent = 'خصم 17%';
        premiumDiscount.style.display = 'inline';
        limitedTimeOffer.style.display = 'block';
    } else {
        // السعر الشهري 15 dollars
        premiumAmount.textContent = '15';
        premiumPeriod.textContent = '/شهرياً';
        premiumOldPrice.style.display = 'none';
        premiumDiscount.style.display = 'none';
        limitedTimeOffer.style.display = 'none';
    }
    
    console.log(`Updating prices to ${period}`);
}

// Scroll to section
function scrollToSection(sectionId) {
    const section = document.getElementById(sectionId);
    if (section) {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

// Contact sales function
function contactSales() {
    alert('يرجى التواصل معنا عبر البريد الإلكتروني: support@mad3oom.online');
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', async function() {
    await initializePage();
    setupEventListeners();
});

async function initializePage() {
    try {
        // Get current user
        const { data: { user } } = await supabase.auth.getUser();
        currentUser = user;

        if (!user) {
            console.log('User not authenticated');
            return;
        }

        // Load subscription status
        await loadSubscriptionStatus();

        // Setup realtime updates
        setupRealtimeUpdates();
    } catch (error) {
        console.error('Error initializing page:', error);
    }
}

async function loadSubscriptionStatus() {
    try {
        currentSubscriptionStatus = await getSubscriptionStatus();
        updateSubscriptionDisplay();
    } catch (error) {
        console.error('Error loading subscription status:', error);
    }
}

function updateSubscriptionDisplay() {
    const statusContainer = document.getElementById('subscriptionStatusContainer');
    if (!statusContainer) return;

    if (currentSubscriptionStatus.hasActiveSubscription) {
        const sub = currentSubscriptionStatus.activeSubscription;
        const daysRemaining = currentSubscriptionStatus.daysRemaining;
        
        statusContainer.innerHTML = `
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 2rem; border-radius: 1rem; margin-bottom: 2rem;">
                <h3 style="margin: 0 0 1rem 0; font-size: 1.2rem;">✓ اشتراك نشط</h3>
                <p style="margin: 0.5rem 0; font-size: 0.95rem;">
                    <strong>نوع الخطة:</strong> ${sub.plan_type === 'monthly' ? 'شهري' : 'سنوي'}
                </p>
                <p style="margin: 0.5rem 0; font-size: 0.95rem;">
                    <strong>تاريخ البداية:</strong> ${new Date(sub.start_date).toLocaleDateString('ar-EG')}
                </p>
                <p style="margin: 0.5rem 0; font-size: 0.95rem;">
                    <strong>تاريخ النهاية:</strong> ${new Date(sub.end_date).toLocaleDateString('ar-EG')}
                </p>
                <p style="margin: 0.5rem 0; font-size: 0.95rem; color: #ffd700;">
                    <strong>الأيام المتبقية:</strong> ${daysRemaining} أيام
                </p>
            </div>
        `;

        // Show renewal button
        const renewButton = document.getElementById('renewSubscriptionBtn');
        if (renewButton) {
            renewButton.style.display = 'inline-block';
        }
    } else {
        statusContainer.innerHTML = `
            <div style="background: #f0f0f0; color: #333; padding: 2rem; border-radius: 1rem; margin-bottom: 2rem; text-align: center;">
                <p style="margin: 0; font-size: 1rem;">لا توجد اشتراكات نشطة حالياً</p>
                <p style="margin: 0.5rem 0 0 0; font-size: 0.9rem; color: #666;">اختر خطة الاشتراك أدناه للبدء</p>
            </div>
        `;

        // Hide renewal button
        const renewButton = document.getElementById('renewSubscriptionBtn');
        if (renewButton) {
            renewButton.style.display = 'none';
        }
    }
}

function setupEventListeners() {
    // Add smooth scroll behavior for anchor links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            const href = this.getAttribute('href');
            if (href === '#') return;
            
            e.preventDefault();
            const target = document.querySelector(href);
            if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    });
    
    // Initialize toggle buttons
    const toggleBtn = document.getElementById('billingToggle');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', function() {
            toggleBilling();
        });
    }

    // Initialize subscribe button
    const subscribeBtn = document.getElementById('subscribeBtn');
    if (subscribeBtn) {
        subscribeBtn.addEventListener('click', handleSubscribe);
    }

    // Renew button
    const renewBtn = document.getElementById('renewSubscriptionBtn');
    if (renewBtn) {
        renewBtn.addEventListener('click', handleRenew);
    }
}

// Handle subscription
async function handleSubscribe() {
    if (!currentUser) {
        alert('يرجى تسجيل الدخول أولاً');
        window.location.href = '/sign-in.html';
        return;
    }

    try {
        const options = document.querySelectorAll('#billingToggle .toggle-option');
        const isYearly = options[1].classList.contains('active');
        const planType = isYearly ? 'yearly' : 'monthly';

        // Show loading state
        const subscribeBtn = document.getElementById('subscribeBtn');
        const originalText = subscribeBtn.textContent;
        subscribeBtn.textContent = 'جاري المعالجة...';
        subscribeBtn.disabled = true;

        // Create subscription ticket
        const result = await createSubscriptionTicket(planType);

        // Show success message
        alert(`تم إرسال طلب الاشتراك بنجاح!\n\nرقم التذكرة: #${result.ticket.ticket_number}\n\nسيتم التواصل معك قريباً من فريق الدعم للموافقة على طلبك.`);

        // Reload subscription status
        await loadSubscriptionStatus();

        // Reset button
        subscribeBtn.textContent = originalText;
        subscribeBtn.disabled = false;
    } catch (error) {
        console.error('Error creating subscription:', error);
        alert('حدث خطأ أثناء إنشاء الاشتراك. يرجى المحاولة مرة أخرى.');
        
        const subscribeBtn = document.getElementById('subscribeBtn');
        subscribeBtn.textContent = 'اشترك الآن';
        subscribeBtn.disabled = false;
    }
}

// Handle renewal
async function handleRenew() {
    if (!currentUser) {
        alert('يرجى تسجيل الدخول أولاً');
        window.location.href = '/sign-in.html';
        return;
    }

    try {
        const options = document.querySelectorAll('#billingToggle .toggle-option');
        const isYearly = options[1].classList.contains('active');
        const planType = isYearly ? 'yearly' : 'monthly';

        // Show loading state
        const renewBtn = document.getElementById('renewSubscriptionBtn');
        const originalText = renewBtn.textContent;
        renewBtn.textContent = 'جاري المعالجة...';
        renewBtn.disabled = true;

        // Create renewal ticket
        const result = await renewSubscription(planType);

        // Show success message
        alert(`تم إرسال طلب التجديد بنجاح!\n\nرقم التذكرة: #${result.ticket.ticket_number}\n\nسيتم التواصل معك قريباً من فريق الدعم للموافقة على طلبك.`);

        // Reload subscription status
        await loadSubscriptionStatus();

        // Reset button
        renewBtn.textContent = originalText;
        renewBtn.disabled = false;
    } catch (error) {
        console.error('Error renewing subscription:', error);
        alert('حدث خطأ أثناء تجديد الاشتراك. يرجى المحاولة مرة أخرى.');
        
        const renewBtn = document.getElementById('renewSubscriptionBtn');
        renewBtn.textContent = 'تجديد الاشتراك';
        renewBtn.disabled = false;
    }
}

// Setup realtime updates for subscription changes
function setupRealtimeUpdates() {
    if (!currentUser) return;

    try {
        const subscription = supabase
            .from(`whatsapp_subscriptions:user_id=eq.${currentUser.id}`)
            .on('*', payload => {
                console.log('Subscription updated:', payload);
                loadSubscriptionStatus();
            })
            .subscribe();

        // Cleanup on page unload
        window.addEventListener('beforeunload', () => {
            supabase.removeSubscription(subscription);
        });
    } catch (error) {
        console.error('Error setting up realtime updates:', error);
    }
}
