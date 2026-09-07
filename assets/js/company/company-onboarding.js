/**
 * company-onboarding.js — خطوة "بيانات الشركة" داخل مسار الاشتراك القائم.
 *
 * الهدف إن مسار الاشتراك الحالي ما يتغيّرش: هو لسه بيعمل
 *   طلب اشتراك (تذكرة + صف pending) → مراجعة الإدارة → تفعيل
 * الملف ده بيضيف خطوتين صغيرتين حواليه فقط:
 *   1) قبل إرسال الطلب: لو الباقة بتستلزم شركة والمستخدم لسه ملهوش شركة،
 *      بنطلب بياناتها ونسجّلها.
 *   2) بعد إنشاء الطلب: بنربط صف الاشتراك بالشركة.
 *
 * "هل الباقة بتستلزم شركة؟" سؤال بيانات (subscription_plans.requires_company)
 * مش قائمة أسماء مكتوبة هنا — باقة جديدة بتشتغل من غير تعديل الملف ده.
 */

import {
    fetchCompanyRequiringPlans,
    hasCompany,
    saveCompany,
    linkSubscriptionToCompany
} from '/assets/js/company/company-data.js';
import { validateCompanyForm } from '/assets/js/company/company-model.js';

let cachedPlans = null;

async function companyPlans() {
    if (cachedPlans) return cachedPlans;
    const result = await fetchCompanyRequiringPlans();
    cachedPlans = result.ok ? result.data : [];
    return cachedPlans;
}

/** هل الباقة دي بتستلزم كيان شركة؟ */
export async function planNeedsCompany(planKey) {
    const plans = await companyPlans();
    return plans.some(p => p.key === planKey);
}

/**
 * يتأكد إن للمستخدم شركة قبل إرسال طلب اشتراك في باقة تستلزمها.
 * @returns {Promise<{ok: boolean, cancelled: boolean, error: string|null}>}
 *   ok=true          → يمكن المتابعة (له شركة أصلًا أو أنشأها الآن)
 *   cancelled=true   → العميل أغلق النموذج، والمسار يتوقف بهدوء بلا رسالة خطأ
 */
export async function ensureCompanyForPlan(planKey) {
    if (!(await planNeedsCompany(planKey))) {
        return { ok: true, cancelled: false, error: null };
    }

    if (await hasCompany()) {
        return { ok: true, cancelled: false, error: null };
    }

    const values = await openCompanyModal();
    if (!values) return { ok: false, cancelled: true, error: null };

    const result = await saveCompany(values);
    if (!result.ok) {
        return { ok: false, cancelled: false, error: result.error };
    }
    return { ok: true, cancelled: false, error: null };
}

/**
 * يربط الاشتراك المُنشأ للتو بشركة المستخدم.
 * الفشل هنا مش بيوقف المسار: طلب الاشتراك اتسجّل فعلًا، والربط بيتعوّض
 * تلقائيًا وقت العرض (اللوحة بتحسب اشتراكات مالك الشركة كمان)، فبنسجّل
 * التحذير وبس بدل ما نقلق العميل برسالة خطأ عن عملية نجحت.
 */
export async function linkSubscriptionIfCompanyPlan(planKey, subscriptionId) {
    if (!subscriptionId) return false;
    if (!(await planNeedsCompany(planKey))) return false;

    const result = await linkSubscriptionToCompany(subscriptionId);
    if (!result.ok || result.data !== true) {
        console.warn('[CompanyOnboarding] تعذّر ربط الاشتراك بالشركة:', result.error || 'لم يتم الربط');
        return false;
    }
    return true;
}

/**
 * نموذج بيانات الشركة.
 * مبني بنفس أسلوب نافذة وسيلة الدفع في subscriptions-script.js (نافذة
 * تُبنى وقت الحاجة وتُرجع Promise) عشان يفضل نفس السلوك في نفس الصفحة.
 * @returns {Promise<Object|null>} null لو العميل ألغى
 */
export function openCompanyModal() {
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
            padding: 1.75rem; width: 100%; max-width: 480px; max-height: 90vh;
            overflow-y: auto; box-shadow: var(--shadow-lg, 0 10px 30px rgba(0,0,0,.3));
        `;

        const field = (id, label, type, required, hint) => `
            <label style="display:block; margin-bottom:0.9rem;">
                <span style="display:block; font-size:0.85rem; font-weight:700; margin-bottom:0.35rem;">
                    ${label}${required ? ' <span style="color:var(--color-danger,#e5484d)">*</span>' : ''}
                </span>
                <input id="${id}" type="${type}"
                       style="width:100%; box-sizing:border-box; padding:0.7rem 0.9rem; border-radius:0.6rem;
                              border:1px solid var(--color-border); background:var(--color-surface-2, transparent);
                              color:var(--color-text); font-family:inherit; font-size:0.9rem;">
                ${hint ? `<span style="display:block; font-size:0.75rem; color:var(--color-text-secondary); margin-top:0.3rem;">${hint}</span>` : ''}
                <span data-error-for="${id}" style="display:none; font-size:0.75rem; color:var(--color-danger,#e5484d); margin-top:0.3rem;"></span>
            </label>`;

        box.innerHTML = `
            <h3 style="margin:0 0 0.25rem; font-size:1.15rem; font-weight:800;">بيانات الشركة</h3>
            <p style="margin:0 0 1.25rem; font-size:0.85rem; color:var(--color-text-secondary); line-height:1.7;">
                هذه الباقة تُفعَّل باسم شركة. أدخل البيانات القانونية الأساسية مرة واحدة،
                وستُربط بها اشتراكاتك وتظهر لك لوحة الشركة.
            </p>
            ${field('cmCompanyName', 'اسم الشركة', 'text', true, '')}
            ${field('cmCrNumber', 'رقم السجل التجاري', 'text', true, '')}
            ${field('cmCrExpiry', 'تاريخ انتهاء السجل التجاري', 'date', true, 'يُحفظ ضمن بيانات الشركة للتحقق مستقبلًا')}
            ${field('cmCompanyEmail', 'البريد الإلكتروني للشركة', 'email', false, '')}
            ${field('cmCompanyPhone', 'هاتف الشركة', 'tel', false, '')}
            <p id="cmFormError" style="display:none; font-size:0.8rem; color:var(--color-danger,#e5484d); margin:0 0 0.9rem; line-height:1.6;"></p>
            <div style="display:flex; gap:0.6rem; margin-top:1.25rem;">
                <button id="cmSubmit" style="flex:1; padding:0.75rem; border:none; border-radius:0.6rem; background:var(--color-accent); color:#fff; font-weight:700; font-family:inherit; cursor:pointer;">حفظ ومتابعة</button>
                <button id="cmCancel" style="flex:1; padding:0.75rem; border:1px solid var(--color-border); border-radius:0.6rem; background:transparent; color:var(--color-text); font-weight:700; font-family:inherit; cursor:pointer;">إلغاء</button>
            </div>`;

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const close = (value) => {
            overlay.remove();
            document.removeEventListener('keydown', onKeydown);
            resolve(value);
        };
        const onKeydown = (event) => { if (event.key === 'Escape') close(null); };
        document.addEventListener('keydown', onKeydown);

        overlay.addEventListener('click', (event) => { if (event.target === overlay) close(null); });
        box.querySelector('#cmCancel').addEventListener('click', () => close(null));

        box.querySelector('#cmSubmit').addEventListener('click', () => {
            box.querySelectorAll('[data-error-for]').forEach(el => { el.style.display = 'none'; el.textContent = ''; });

            const values = {
                companyName: box.querySelector('#cmCompanyName').value,
                crNumber: box.querySelector('#cmCrNumber').value,
                crExpiry: box.querySelector('#cmCrExpiry').value,
                companyEmail: box.querySelector('#cmCompanyEmail').value,
                companyPhone: box.querySelector('#cmCompanyPhone').value
            };

            // نفس قواعد upsert_my_company في القاعدة — الرسالة بالعربي قبل الإرسال
            const fieldIds = {
                companyName: 'cmCompanyName',
                crNumber: 'cmCrNumber',
                crExpiry: 'cmCrExpiry',
                companyEmail: 'cmCompanyEmail'
            };
            const validation = validateCompanyForm(values);
            if (!validation.isValid) {
                for (const [key, message] of Object.entries(validation.errors)) {
                    const el = box.querySelector(`[data-error-for="${fieldIds[key]}"]`);
                    if (el) { el.textContent = message; el.style.display = 'block'; }
                }
                return;
            }

            close(values);
        });

        box.querySelector('#cmCompanyName').focus();
    });
}
