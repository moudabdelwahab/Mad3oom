// ==================== Subscriptions Page Script ====================

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
document.addEventListener('DOMContentLoaded', function() {
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
        subscribeBtn.addEventListener('click', function() {
            const options = document.querySelectorAll('#billingToggle .toggle-option');
            const isYearly = options[1].classList.contains('active');
            const period = isYearly ? 'yearly' : 'monthly';
            const priceId = STRIPE_PRICES[period];
            
            // Since we can't create payment links directly due to missing business name,
            // we'll redirect to a checkout session or a custom payment page.
            // For now, we'll use a placeholder or the payment.html if it supports Stripe.
            window.location.href = `payment.html?plan=premium&period=${period}&priceId=${priceId}`;
        });
    }
});
