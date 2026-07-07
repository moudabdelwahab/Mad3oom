// ==================== Subscriptions Page Script ====================
import { supabase } from '/api-config.js';
import {
    PLAN_LABELS,
    BILLING_LABELS,
    createSubscriptionTicket,
    getSubscriptionStatus,
    renewSubscription,
    subscribeToSubscriptionUpdates
} from '/whatsapp-subscription-service.js';

let currentUser = null;
let currentSubscriptionStatus = null;
let unsubscribeRealtime = null;

document.addEventListener('DOMContentLoaded', async function () {
    initThemeToggle();
    initBillingToggle();
    initPlanButtons();
    setupAnchorScrolling();
    await initializePage();
});

/* ==================== Theme Toggle ==================== */
function initThemeToggle() {
    const themeToggle = document.querySelector('.theme-toggle');
    if (!themeToggle) return;

    themeToggle.addEventListener('click', function () {
        const root = document.documentElement;
        const current = root.getAttribute('data-theme') || 'light';
        const next = current === 'light' ? 'dark' : 'light';

        root.classList.add('no-transition');
        root.setAttribute('data-theme', next);

        try {
            if (window.localStorage) {
                localStorage.setItem('theme-preference', next);
            }
        } catch (e) {
            /* localStorage unavailable, ignore */
        }

        requestAnimationFrame(function () {
            root.classList.remove('no-transition');
        });
    });
}

/* ==================== Billing Toggle (Monthly / Yearly) ==================== */
function initBillingToggle() {
    const toggle = document.getElementById('billingToggle');
    if (!toggle) return;

    const options = toggle.querySelectorAll('.toggle-option');

    options.forEach(function (option) {
        option.addEventListener('click', function () {
            const period = option.dataset.period; // 'monthly' or 'yearly'

            options.forEach(function (o) {
                o.classList.remove('active');
            });
            option.classList.add('active');

            updatePricing(period);
        });
    });
}

function getActiveBillingCycle() {
    const activeOption = document.querySelector('#billingToggle .toggle-option.active');
    return activeOption ? activeOption.dataset.period : 'monthly';
}

function updatePricing(period) {
    const periodLabel = period === 'yearly' ? '/سنة' : '/شهر';
    const cards = document.querySelectorAll('.pricing-card[data-plan]');

    cards.forEach(function (card) {
        if (card.dataset.plan === 'free') return;

        const amountEl = card.querySelector('.amount');
        const periodEl = card.querySelector('.period');
        const oldPriceEl = card.querySelector('.old-price');
        const discountEl = card.querySelector('.discount-badge');
        const bonusEl = card.querySelector('.bonus-note');

        if (amountEl && amountEl.dataset[period] !== undefined) {
            amountEl.textContent = amountEl.dataset[period];
        }
        if (periodEl) {
            periodEl.textContent = periodLabel;
        }
        if (oldPriceEl && oldPriceEl.dataset[period] !== undefined) {
            oldPriceEl.textContent = oldPriceEl.dataset[period];
        }
        if (discountEl && discountEl.dataset[period] !== undefined) {
            discountEl.textContent = discountEl.dataset[period];
        }
        if (bonusEl && bonusEl.dataset[period] !== undefined) {
            bonusEl.textContent = bonusEl.dataset[period];
        }
    });
}

/* ==================== Smooth scroll for in-page anchors ==================== */
function setupAnchorScrolling() {
    document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
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
}

function scrollToSection(sectionId) {
    const el = document.getElementById(sectionId);
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}
window.scrollToSection = scrollToSection; // used by inline onclick in HTML

function contactSales() {
    alert('يرجى التواصل معنا عبر البريد الإلكتروني: support@mad3oom.online');
}
window.contactSales = contactSales; // used by inline onclick in HTML

/* ==================== Page initialization ==================== */
async function initializePage() {
    try {
        const { data: { user } } = await supabase.auth.getUser();
        currentUser = user;

        if (!user) {
            console.log('User not authenticated');
            return;
        }

        await loadSubscriptionStatus();
        unsubscribeRealtime = await subscribeToSubscriptionUpdates(function () {
            loadSubscriptionStatus();
        });

        window.addEventListener('beforeunload', function () {
            if (typeof unsubscribeRealtime === 'function') {
                unsubscribeRealtime();
            }
        });
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

    if (currentSubscriptionStatus && currentSubscriptionStatus.hasActiveSubscription) {
        const sub = currentSubscriptionStatus.activeSubscription;
        const daysRemaining = currentSubscriptionStatus.daysRemaining;
        const planLabel = PLAN_LABELS[sub.plan] || sub.plan;
        const billingLabel = BILLING_LABELS[sub.billing_cycle] || sub.billing_cycle;

        // زرار "تجديد الاشتراك الحالي" بيتولد هنا جوه مربع الاشتراك النشط نفسه
        statusContainer.innerHTML = `
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 2rem; border-radius: 1rem; margin-bottom: 2rem;">
                <h3 style="margin: 0 0 1rem 0; font-size: 1.2rem;">✓ اشتراك نشط - ${planLabel}</h3>
                <p style="margin: 0.5rem 0; font-size: 0.95rem;">
                    <strong>نوع الفترة:</strong> ${billingLabel}
                </p>
                <p style="margin: 0.5rem 0; font-size: 0.95rem;">
                    <strong>تاريخ البداية:</strong> ${new Date(sub.start_date).toLocaleDateString('ar-EG')}
                </p>
                <p style="margin: 0.5rem 0; font-size: 0.95rem;">
                    <strong>تاريخ النهاية:</strong> ${new Date(sub.end_date).toLocaleDateString('ar-EG')}
                </p>
                <p style="margin: 0.5rem 0 1.25rem 0; font-size: 0.95rem; color: #ffd700;">
                    <strong>الأيام المتبقية:</strong> ${daysRemaining} أيام
                </p>
                <button id="renewSubscriptionBtn" data-renew-plan="${sub.plan}"
                    style="background: white; color: #5a4bda; border: none; padding: 0.7rem 1.75rem; border-radius: 0.5rem; font-weight: 600; font-size: 0.95rem; cursor: pointer;">
                    تجديد الاشتراك الحالي
                </button>
            </div>
        `;

        const renewButton = document.getElementById('renewSubscriptionBtn');
        if (renewButton) {
            renewButton.addEventListener('click', handleRenew);
        }

        updatePlanButtonsState(sub.plan);
    } else {
        statusContainer.innerHTML = `
            <div style="background: #f0f0f0; color: #333; padding: 2rem; border-radius: 1rem; margin-bottom: 2rem; text-align: center;">
                <p style="margin: 0; font-size: 1rem;">لا توجد اشتراكات نشطة حالياً</p>
                <p style="margin: 0.5rem 0 0 0; font-size: 0.9rem; color: #666;">اختر إحدى الخطط أدناه للبدء</p>
            </div>
        `;

        updatePlanButtonsState(null);
    }
}

/* ==================== Plan button state (اشترك الآن / مشترك بالفعل) ==================== */
function updatePlanButtonsState(activePlan) {
    document.querySelectorAll('[data-plan-btn]').forEach(function (btn) {
        const isActivePlan = activePlan && btn.dataset.planBtn === activePlan;

        if (isActivePlan) {
            btn.textContent = 'مشترك بالفعل';
            btn.disabled = true;
            btn.classList.add('btn-subscribed');
        } else {
            btn.textContent = 'اشترك الآن';
            btn.disabled = false;
            btn.classList.remove('btn-subscribed');
        }
    });
}

/* ==================== Plan subscribe buttons ==================== */
function initPlanButtons() {
    document.querySelectorAll('[data-plan-btn]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            handleSubscribe(btn.dataset.planBtn, btn);
        });
    });
}

async function handleSubscribe(plan, buttonEl) {
    if (!currentUser) {
        alert('يرجى تسجيل الدخول أولاً');
        window.location.href = '/login.html';
        return;
    }

    const billingCycle = getActiveBillingCycle();
    const originalText = buttonEl ? buttonEl.textContent : '';

    try {
        if (buttonEl) {
            buttonEl.textContent = 'جاري المعالجة...';
            buttonEl.disabled = true;
        }

        const result = await createSubscriptionTicket(plan, billingCycle);

        alert(`تم إرسال طلب الاشتراك بنجاح!\n\nرقم التذكرة: #${result.ticket.ticket_number}\n\nسيتم التواصل معك قريباً من فريق الدعم للموافقة على طلبك.`);

        await loadSubscriptionStatus();
    } catch (error) {
        console.error('Error creating subscription:', error);
        alert('حدث خطأ أثناء إنشاء طلب الاشتراك. يرجى المحاولة مرة أخرى.');
    } finally {
        if (buttonEl) {
            buttonEl.textContent = originalText;
            buttonEl.disabled = false;
        }
    }
}

async function handleRenew() {
    if (!currentUser) {
        alert('يرجى تسجيل الدخول أولاً');
        window.location.href = '/login.html';
        return;
    }

    const renewBtn = document.getElementById('renewSubscriptionBtn');
    const plan = (renewBtn && renewBtn.dataset.renewPlan) ||
        (currentSubscriptionStatus && currentSubscriptionStatus.activeSubscription && currentSubscriptionStatus.activeSubscription.plan);

    if (!plan) {
        alert('تعذر تحديد الخطة الحالية لتجديدها.');
        return;
    }

    const billingCycle = getActiveBillingCycle();
    const originalText = renewBtn ? renewBtn.textContent : '';

    try {
        if (renewBtn) {
            renewBtn.textContent = 'جاري المعالجة...';
            renewBtn.disabled = true;
        }

        const result = await renewSubscription(plan, billingCycle);

        alert(`تم إرسال طلب التجديد بنجاح!\n\nرقم التذكرة: #${result.ticket.ticket_number}\n\nسيتم التواصل معك قريباً من فريق الدعم للموافقة على طلبك.`);

        await loadSubscriptionStatus();
    } catch (error) {
        console.error('Error renewing subscription:', error);
        alert('حدث خطأ أثناء تجديد الاشتراك. يرجى المحاولة مرة أخرى.');
    } finally {
        if (renewBtn) {
            renewBtn.textContent = originalText || 'تجديد الاشتراك الحالي';
            renewBtn.disabled = false;
        }
    }
}
