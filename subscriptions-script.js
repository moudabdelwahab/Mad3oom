// ==================== Subscriptions Page Script ====================
import { supabase } from '/api-config.js';
import {
    PLAN_LABELS,
    BILLING_LABELS,
    PAYMENT_METHODS,
    PAYMENT_METHOD_LABELS,
    EXTERNAL_PAYMENT_METHODS,
    createSubscriptionTicket,
    getSubscriptionStatus,
    renewSubscription,
    subscribeToSubscriptionUpdates
} from '/whatsapp-subscription-service.js';

// بيانات الحسابات/المحافظ الحقيقية لاستقبال التحويلات
const EXTERNAL_PAYMENT_INSTRUCTIONS = {
    bank_transfer: `
        <div>البنك: كريدي أجريكول مصر</div>
        <div>رقم الحساب (IBAN): EG100036000100011258180417829</div>
        <div>اسم المستفيد: Mahmoud Abdelwahab</div>
    `,
    cash_wallet: 'حوّل على رقم محفظة كاش: 01274000741',
    instapay: `
        <div style="margin-bottom:0.65rem;">حوّل على حساب إنستاباي: mahmoudvf24ca@instapay</div>
        <a href="https://ipn.eg/S/mahmoudvf24ca/instapay/7y4Xc0" target="_blank" rel="noopener noreferrer"
           style="display:inline-flex; align-items:center; justify-content:center; gap:0.4rem; background:#6f2f8f; color:#fff; text-decoration:none; font-weight:700; padding:0.6rem 1.2rem; border-radius:0.6rem; font-size:0.85rem;">
            الدفع عبر إنستاباي
        </a>
    `
};

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

/* ==================== Payment method modal ==================== */
/**
 * يفتح مودال اختيار وسيلة الدفع (إلزامي) قبل إرسال طلب اشتراك/تجديد.
 * - تحويل بنكي خارجي: يتطلب إرفاق صورة/PDF لإثبات التحويل (إلزامي)، ومراجعته
 *   من فريق الدعم خلال ساعة كحد أقصى.
 * - بوابة دفع داخلية: لا يتطلب أي مرفق حاليًا (لحد ما تُفعّل البوابة فعليًا).
 * @returns {Promise<{paymentMethod: string, paymentReference: string, proofFile: File|null}|null>}
 *          null لو العميل ألغى العملية.
 */
function openPaymentMethodModal() {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; inset: 0; background: rgba(0,0,0,0.55);
            display: flex; align-items: center; justify-content: center;
            z-index: 10000; padding: 1rem;
        `;

        const box = document.createElement('div');
        box.style.cssText = `
            background: var(--color-surface); color: var(--color-text);
            border: 1px solid var(--color-border); border-radius: 1rem;
            padding: 1.75rem; width: 100%; max-width: 460px; max-height: 90vh;
            overflow-y: auto; box-shadow: var(--shadow-lg, 0 10px 30px rgba(0,0,0,.3));
        `;

        box.innerHTML = `
            <h3 style="margin:0 0 0.25rem; font-size:1.15rem; font-weight:800;">اختر وسيلة الدفع</h3>
            <p style="margin:0 0 1.25rem; font-size:0.85rem; color:var(--color-text-secondary);">
                اختيار وسيلة الدفع إلزامي قبل إرسال طلب الاشتراك.
            </p>

            <div id="pmMethodsList">
                ${PAYMENT_METHODS.map((method, idx) => `
                    <label style="display:flex; align-items:flex-start; gap:0.6rem; padding:0.85rem; border:2px solid var(--color-border); border-radius:0.75rem; margin-bottom:0.6rem; cursor:pointer;" data-method-option="${method}">
                        <input type="radio" name="pm_method" value="${method}" ${idx === 0 ? 'checked' : ''} style="margin-top:0.2rem;">
                        <span>
                            <strong>${PAYMENT_METHOD_LABELS[method]}</strong>
                            <div style="font-size:0.8rem; color:var(--color-text-secondary); margin-top:0.2rem;">
                                ${EXTERNAL_PAYMENT_METHODS.includes(method)
                                    ? 'تحويل خارجي - يتطلب إرفاق صورة أو PDF لإثبات التحويل. ستتم المراجعة خلال ساعة كحد أقصى.'
                                    : 'قيد الإضافة حاليًا. سيتم إرسال طلبك وسيتواصل معك فريق الدعم لإتمام الدفع.'}
                            </div>
                        </span>
                    </label>
                `).join('')}
            </div>

            <div id="pmExternalDetails" style="background:var(--color-muted); border-radius:0.75rem; padding:0.85rem; margin-bottom:1rem; font-size:0.82rem; line-height:1.9; white-space:pre-line;"></div>

            <div id="pmProofField" style="margin-bottom:1rem;">
                <label style="display:block; font-size:0.85rem; font-weight:700; margin-bottom:0.4rem;">صورة أو PDF لإثبات التحويل <span style="color:#e11d48;">*</span></label>
                <input type="file" id="pmProofInput" accept="image/*,application/pdf" style="width:100%;">
            </div>

            <div style="margin-bottom:1rem;">
                <label style="display:block; font-size:0.85rem; font-weight:700; margin-bottom:0.4rem;">رقم/مرجع التحويل (اختياري)</label>
                <input type="text" id="pmReferenceInput" placeholder="مثال: رقم العملية أو آخر 4 أرقام" style="width:100%; padding:0.6rem; border-radius:0.5rem; border:1px solid var(--color-border); background:var(--color-surface); color:var(--color-text);">
            </div>

            <p id="pmErrorMsg" style="display:none; color:#e11d48; font-size:0.82rem; margin:0 0 1rem;"></p>

            <div style="display:flex; gap:0.6rem;">
                <button id="pmCancelBtn" class="btn" style="flex:1;">إلغاء</button>
                <button id="pmConfirmBtn" class="btn btn-primary" style="flex:1;">متابعة</button>
            </div>
        `;

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const radios = box.querySelectorAll('input[name="pm_method"]');
        const externalDetailsEl = box.querySelector('#pmExternalDetails');
        const proofFieldEl = box.querySelector('#pmProofField');
        const proofInputEl = box.querySelector('#pmProofInput');
        const referenceInputEl = box.querySelector('#pmReferenceInput');
        const errorEl = box.querySelector('#pmErrorMsg');

        function updateVisibility() {
            const selected = box.querySelector('input[name="pm_method"]:checked').value;
            const isExternal = EXTERNAL_PAYMENT_METHODS.includes(selected);
            externalDetailsEl.style.display = isExternal ? 'block' : 'none';
            externalDetailsEl.innerHTML = isExternal ? (EXTERNAL_PAYMENT_INSTRUCTIONS[selected] || '') : '';
            proofFieldEl.style.display = isExternal ? 'block' : 'none';
        }
        radios.forEach((r) => r.addEventListener('change', updateVisibility));
        updateVisibility();

        function cleanup(result) {
            overlay.remove();
            resolve(result);
        }

        box.querySelector('#pmCancelBtn').addEventListener('click', () => cleanup(null));
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) cleanup(null);
        });

        box.querySelector('#pmConfirmBtn').addEventListener('click', () => {
            const selected = box.querySelector('input[name="pm_method"]:checked').value;
            errorEl.style.display = 'none';

            if (!PAYMENT_METHODS.includes(selected)) {
                errorEl.textContent = 'يجب اختيار وسيلة الدفع.';
                errorEl.style.display = 'block';
                return;
            }

            let proofFile = null;
            if (EXTERNAL_PAYMENT_METHODS.includes(selected)) {
                proofFile = proofInputEl.files && proofInputEl.files[0] ? proofInputEl.files[0] : null;
                if (!proofFile) {
                    errorEl.textContent = `إرفاق صورة أو PDF لإثبات التحويل إلزامي لوسيلة "${PAYMENT_METHOD_LABELS[selected]}".`;
                    errorEl.style.display = 'block';
                    return;
                }
                const isImage = proofFile.type && proofFile.type.startsWith('image/');
                const isPdf = proofFile.type === 'application/pdf';
                if (!isImage && !isPdf) {
                    errorEl.textContent = 'الملف يجب أن يكون صورة أو PDF فقط.';
                    errorEl.style.display = 'block';
                    return;
                }
                if (proofFile.size > 8 * 1024 * 1024) {
                    errorEl.textContent = 'حجم الملف كبير جدًا. الحد الأقصى 8 ميجابايت.';
                    errorEl.style.display = 'block';
                    return;
                }
            }

            cleanup({
                paymentMethod: selected,
                paymentReference: referenceInputEl.value || '',
                proofFile
            });
        });
    });
}

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

    const paymentInfo = await openPaymentMethodModal();
    if (!paymentInfo) return; // العميل ألغى العملية

    const billingCycle = getActiveBillingCycle();
    const originalText = buttonEl ? buttonEl.textContent : '';

    try {
        if (buttonEl) {
            buttonEl.textContent = 'جاري المعالجة...';
            buttonEl.disabled = true;
        }

        const result = await createSubscriptionTicket(plan, billingCycle, paymentInfo);

        const reviewNote = EXTERNAL_PAYMENT_METHODS.includes(paymentInfo.paymentMethod)
            ? '\n\nسيتم مراجعة إثبات التحويل خلال ساعة كحد أقصى.'
            : '';
        alert(`تم إرسال طلب الاشتراك بنجاح!\n\nرقم التذكرة: #${result.ticket.ticket_number}\n\nسيتم التواصل معك قريباً من فريق الدعم للموافقة على طلبك.${reviewNote}`);

        await loadSubscriptionStatus();
    } catch (error) {
        console.error('Error creating subscription:', error);
        alert(error.message || 'حدث خطأ أثناء إنشاء طلب الاشتراك. يرجى المحاولة مرة أخرى.');
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

    const paymentInfo = await openPaymentMethodModal();
    if (!paymentInfo) return; // العميل ألغى العملية

    const billingCycle = getActiveBillingCycle();
    const originalText = renewBtn ? renewBtn.textContent : '';

    try {
        if (renewBtn) {
            renewBtn.textContent = 'جاري المعالجة...';
            renewBtn.disabled = true;
        }

        const result = await renewSubscription(plan, billingCycle, paymentInfo);

        const reviewNote = EXTERNAL_PAYMENT_METHODS.includes(paymentInfo.paymentMethod)
            ? '\n\nسيتم مراجعة إثبات التحويل خلال ساعة كحد أقصى.'
            : '';
        alert(`تم إرسال طلب التجديد بنجاح!\n\nرقم التذكرة: #${result.ticket.ticket_number}\n\nسيتم التواصل معك قريباً من فريق الدعم للموافقة على طلبك.${reviewNote}`);

        await loadSubscriptionStatus();
    } catch (error) {
        console.error('Error renewing subscription:', error);
        alert(error.message || 'حدث خطأ أثناء تجديد الاشتراك. يرجى المحاولة مرة أخرى.');
    } finally {
        if (renewBtn) {
            renewBtn.textContent = originalText || 'تجديد الاشتراك الحالي';
            renewBtn.disabled = false;
        }
    }
}
