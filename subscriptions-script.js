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
    subscribeToSubscriptionUpdates,
    checkPurchaseAllowed,
    getUpgradeQuote,
    getPlanPrices
} from '/whatsapp-subscription-service.js';
// خطوة بيانات الشركة للباقات التي تستلزمها (subscription_plans.requires_company).
// المسار نفسه لم يتغيّر: طلب اشتراك → مراجعة الإدارة → تفعيل.
import {
    ensureCompanyForPlan,
    linkSubscriptionIfCompanyPlan
} from '/assets/js/company/company-onboarding.js';

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
    // الأسعار تُحمَّل من قاعدة البيانات قبل أي رسم: القيم المكتوبة في HTML
    // بقت مجرد قيمة ظاهرة لحظة التحميل الأولى، مش مصدر فوترة.
    await loadPricesFromDatabase();
    initBillingToggle();
    initPlanButtons();
    setupAnchorScrolling();
    await initializePage();
});

/**
 * يملأ أسعار البطاقات من subscription_plans.
 * قبل كده كان السعر مكتوبًا في سمتَي data-monthly/data-yearly في صفحتين
 * منفصلتين، فأي تغيير سعر كان لازم يتعمل في مكانين ومفيش ضمان إنهم متطابقين
 * ولا إن القاعدة تعرفهم أصلًا.
 */
async function loadPricesFromDatabase() {
    const plans = await getPlanPrices();
    if (!plans.length) return; // فشل التحميل: تُترك القيم الظاهرة كما هي

    for (const plan of plans) {
        const card = document.querySelector(`.pricing-card[data-plan="${plan.key}"]`);
        if (!card) continue;

        const amountEl = card.querySelector('.amount');
        if (amountEl && plan.price_monthly != null && plan.price_yearly != null) {
            amountEl.dataset.monthly = String(plan.price_monthly);
            amountEl.dataset.yearly = String(plan.price_yearly);
        }
        const currencyEl = card.querySelector('.currency');
        if (currencyEl && plan.currency) {
            currencyEl.textContent = plan.currency === 'USD' ? '$' : plan.currency;
        }
    }

    updatePricing(getActiveBillingCycle());
}

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
        // مكوّن الحالة الموحّد في البوابة بدل ألوان ثابتة: كان #f0f0f0 على
        // #333، فيفضل صندوقًا فاتحًا وسط صفحة داكنة في الوضع الليلي.
        statusContainer.innerHTML = `
            <div class="state-block">
                <p class="state-title">لا توجد اشتراكات نشطة حالياً</p>
                <p class="state-text">اختر إحدى الخطط أدناه للبدء</p>
            </div>
        `;

        updatePlanButtonsState(null);
    }
}

/* ==================== Plan button state (اشترك الآن / مشترك بالفعل) ==================== */
/**
 * حالة كل زر باقة.
 *
 * كانت تقارن اسم الباقة الفعّالة باسم زر الباقة فقط، فالعميل صاحب "الباقة
 * الشاملة" كان يرى زر "اشترك الآن" على واتساب والدعم الفني رغم أن الخدمتين
 * ضمن اشتراكه بالفعل — ثم يدفع مقابل ما يملكه.
 *
 * دلوقتي كل زر بيسأل نفس دالة القاعدة التي تفرض المنع
 * (subscription_purchase_check)، فالواجهة والقاعدة بيقولوا نفس الشيء دايمًا.
 * الأزرار هنا مجرد انعكاس للقرار — المنع الحقيقي في الـtrigger.
 */
async function updatePlanButtonsState(activePlan) {
    const buttons = Array.from(document.querySelectorAll('[data-plan-btn]'));

    await Promise.all(buttons.map(async function (btn) {
        const plan = btn.dataset.planBtn;
        const isActivePlan = activePlan && plan === activePlan;

        if (isActivePlan) {
            btn.textContent = 'مشترك بالفعل';
            btn.disabled = true;
            btn.title = 'اشتراكك الحالي في هذه الباقة. استخدم زر التجديد لتمديده.';
            btn.classList.add('btn-subscribed');
            return;
        }

        // ترقية متاحة؟ الزر لازم يقول كده صراحةً بدل "اشترك الآن"، عشان
        // العميل يعرف إنه هيدفع فرق السعر لا السعر الكامل.
        const quote = await getUpgradeQuote(plan);
        if (quote && quote.eligible === true) {
            const cy = quote.currency === 'USD' ? '$' : (quote.currency || '');
            btn.textContent = 'ترقية ودمج الباقة';
            btn.disabled = false;
            btn.title = `تدفع فرق السعر فقط (${cy}${quote.amount_due}) عن ${quote.remaining_days} يومًا متبقية، بنفس تاريخ انتهاء اشتراكك الحالي.`;
            btn.classList.remove('btn-subscribed');
            return;
        }

        const check = await checkPurchaseAllowed(plan, false);

        if (check && check.allowed === false) {
            // 'redundant' = الخدمات كلها مملوكة ضمن باقة أخرى (الحالة التي
            // كانت تظهر كزر شراء عادي)
            btn.textContent = check.code === 'redundant' ? 'مشمولة في باقتك' : 'غير متاحة';
            btn.disabled = true;
            btn.title = check.reason || '';
            btn.classList.add('btn-subscribed');
            return;
        }

        btn.textContent = 'اشترك الآن';
        btn.disabled = false;
        btn.title = '';
        btn.classList.remove('btn-subscribed');
    }));
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

/**
 * نافذة "ترقية ودمج الباقة".
 * بتعرض كل أرقام العملية قبل أي طلب دفع، وكلها جاية من القاعدة
 * (subscription_upgrade_quote) — الواجهة ما بتحسبش أي مبلغ.
 * @returns {Promise<boolean>} هل أكّد العميل؟
 */
function openUpgradeModal(quote) {
    return new Promise((resolve) => {
        const cur = quote.current, tgt = quote.target;
        const cy = quote.currency === 'USD' ? '$' : (quote.currency || '');
        const cycleLabel = BILLING_LABELS[cur.billing_cycle] || cur.billing_cycle;
        const fmtDate = (d) => new Date(d).toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' });
        const row = (label, value, strong) => `
            <div style="display:flex; justify-content:space-between; gap:1rem; padding:.45rem 0; ${strong ? 'font-weight:800; font-size:1.05rem;' : ''}">
                <span style="color:var(--color-text-secondary);">${label}</span>
                <span>${value}</span>
            </div>`;

        const overlay = document.createElement('div');
        overlay.style.cssText = `position:fixed; inset:0; background:rgba(0,0,0,.55);
            display:flex; align-items:center; justify-content:center; z-index:10000; padding:1rem;`;
        const box = document.createElement('div');
        box.style.cssText = `background:var(--color-surface); color:var(--color-text);
            border:1px solid var(--color-border); border-radius:1rem; padding:1.75rem;
            width:100%; max-width:520px; max-height:90vh; overflow-y:auto;
            box-shadow:var(--shadow-lg, 0 10px 30px rgba(0,0,0,.3));`;

        box.innerHTML = `
            <h3 style="margin:0 0 .25rem; font-size:1.15rem; font-weight:800;">ترقية ودمج الباقة</h3>
            <p style="margin:0 0 1.25rem; font-size:.85rem; color:var(--color-text-secondary); line-height:1.8;">
                لن تبدأ دورة اشتراك جديدة. تحتفظ بنفس تاريخ انتهاء اشتراكك الحالي،
                وتدفع فرق السعر عن الأيام المتبقية فقط.
            </p>
            <div style="border:1px solid var(--color-border); border-radius:.75rem; padding:1rem; margin-bottom:1rem;">
                ${row('الباقة الحالية', `${cur.plan_name_ar} — ${cy}${cur.price}`)}
                ${row('الباقة الجديدة', `${tgt.plan_name_ar} — ${cy}${tgt.price}`)}
                ${row('دورة الفوترة', cycleLabel)}
                ${row('ينتهي اشتراكك في', fmtDate(cur.end_date))}
                ${row('الأيام المتبقية', `${quote.remaining_days} من ${quote.cycle_days}`)}
                ${row('فرق السعر للدورة كاملة', `${cy}${quote.price_difference}`)}
            </div>
            <div style="border:1px solid var(--color-accent); border-radius:.75rem; padding:1rem; margin-bottom:1rem;">
                ${row('المبلغ المطلوب الآن', `${cy}${quote.amount_due}`, true)}
                <p style="margin:.5rem 0 0; font-size:.78rem; color:var(--color-text-secondary); line-height:1.7;">
                    فرق السعر محسوبًا على ${quote.remaining_days} يومًا متبقية.
                </p>
            </div>
            <p style="margin:0 0 1.25rem; font-size:.8rem; color:var(--color-text-secondary); line-height:1.7;">
                عند التجديد بعد ${fmtDate(cur.end_date)} ستُجدَّد باقة "${tgt.plan_name_ar}"
                بالسعر الكامل ${cy}${quote.next_renewal_price} ${cycleLabel}.
            </p>
            <div style="display:flex; gap:.6rem;">
                <button id="upConfirm" style="flex:1; padding:.75rem; border:none; border-radius:.6rem;
                    background:var(--color-accent); color:#fff; font-weight:700; font-family:inherit; cursor:pointer;">
                    متابعة الترقية</button>
                <button id="upCancel" style="flex:1; padding:.75rem; border:1px solid var(--color-border);
                    border-radius:.6rem; background:transparent; color:var(--color-text);
                    font-weight:700; font-family:inherit; cursor:pointer;">إلغاء</button>
            </div>`;

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const close = (v) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
        const onKey = (e) => { if (e.key === 'Escape') close(false); };
        document.addEventListener('keydown', onKey);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
        box.querySelector('#upCancel').addEventListener('click', () => close(false));
        box.querySelector('#upConfirm').addEventListener('click', () => close(true));
    });
}

async function handleSubscribe(plan, buttonEl) {
    if (!currentUser) {
        alert('يرجى تسجيل الدخول أولاً');
        window.location.href = '/login.html';
        return;
    }

    // ترقية أم شراء جديد؟ القاعدة هي التي تقرّر، لا الواجهة.
    const quote = await getUpgradeQuote(plan);
    const isUpgrade = !!(quote && quote.eligible === true);

    if (isUpgrade) {
        const confirmed = await openUpgradeModal(quote);
        if (!confirmed) return;
    }

    // لو الباقة بتستلزم شركة والمستخدم لسه ملهوش واحدة، بنطلب بياناتها الأول.
    // بيحصل قبل نافذة الدفع عشان العميل ما يدفعش ثم يتعثّر في خطوة بيانات.
    const companyStep = await ensureCompanyForPlan(plan);
    if (companyStep.cancelled) return;
    if (!companyStep.ok) {
        alert(companyStep.error || 'تعذّر حفظ بيانات الشركة. يرجى المحاولة مرة أخرى.');
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

        const result = await createSubscriptionTicket(plan, billingCycle, { ...paymentInfo, isUpgrade });
        await linkSubscriptionIfCompanyPlan(plan, result.subscription?.id);

        const reviewNote = EXTERNAL_PAYMENT_METHODS.includes(paymentInfo.paymentMethod)
            ? '\n\nسيتم مراجعة إثبات التحويل خلال ساعة كحد أقصى.'
            : '';
        alert(isUpgrade
            ? `تم إرسال طلب الترقية بنجاح!\n\nرقم التذكرة: #${result.ticket.ticket_number}\nالمبلغ المطلوب: ${result.subscription?.upgrade_amount ?? quote.amount_due}\n\nلن تتغيّر باقتك قبل تأكيد الدفع من فريق الدعم.${reviewNote}`
            : `تم إرسال طلب الاشتراك بنجاح!\n\nرقم التذكرة: #${result.ticket.ticket_number}\n\nسيتم التواصل معك قريباً من فريق الدعم للموافقة على طلبك.${reviewNote}`);

        // إكمال مسار الشركة: لو الشركة اتكوّنت للتو، المستخدم المفروض يشوف
        // لوحتها بدل ما يفضل في صفحة الباقات ومايعرفش إن ليه لوحة أصلًا.
        // التحويل مبني على أن الشركة اتكوّنت فعلًا في المسار ده، لا على أي
        // قيمة في الرابط.
        if (companyStep.created) {
            window.location.href = '/company-dashboard/';
            return;
        }

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
        await linkSubscriptionIfCompanyPlan(plan, result.subscription?.id);

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
