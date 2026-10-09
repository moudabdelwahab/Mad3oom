/**
 * company-onboarding.js — سؤال «فرد أم شركة؟» داخل مسار الاشتراك القائم.
 *
 * مسار الاشتراك نفسه ما اتغيّرش: لسه
 *   طلب اشتراك (تذكرة + صف pending) → مراجعة الإدارة → تفعيل
 * الملف ده بيقرر قبله العميل هيكمل إزاي:
 *   • حسابه حساب شركة بالفعل (مالك أو عضو) ⇒ مفيش سؤال؛ يكمل للدفع، والاشتراك
 *     بيترتبط بشركته بعد إنشائه.
 *   • غير كده بيتسأل:
 *       فرد  ⇒ يكمل لنافذة الدفع زي ما هو.
 *       شركة ⇒ يملأ بيانات الشركة وتتبعت كطلب (migrations/068). مفيش دفع ولا
 *              شركة دلوقتي: الإدارة تراجع، وعند الموافقة القاعدة تُنشئ الشركة
 *              فيتحوّل الحساب لحساب شركة، ويرجع يكمل الاشتراك كشركة.
 *
 * الملف ده ما بيقررش حالة الحساب: وجود الشركة وحالة الطلب جايين من القاعدة،
 * والقاعدة هي اللي بترفض الطلب المكرر أو حساب الشركة اللي يطلب تاني.
 */

import {
    hasCompany,
    submitCompanyAccountRequest,
    fetchMyCompanyAccountRequest,
    linkSubscriptionToCompany
} from '/assets/js/company/company-data.js';
import { validateCompanyForm } from '/assets/js/company/company-model.js';
import { escapeHtml } from '/assets/js/customer/portal-ui.js';

export const PURCHASE_AS = Object.freeze({ individual: 'individual', company: 'company' });

/**
 * بأي صفة يشتري العميل؟
 * @param {{plan: string, billingCycle: string}} purchase الباقة اللي ضغط عليها،
 *        بتتسجّل مع طلب الشركة عشان إخطار الموافقة يقوله يكمل اشتراكه فيها.
 * @returns {Promise<{proceed: boolean, asCompany: boolean}>}
 *   proceed=true  → كمّل لنافذة الدفع (asCompany=true: اربط الاشتراك بالشركة)
 *   proceed=false → العميل لغى، أو بعت طلب شركة (النافذة عرضت النتيجة بنفسها)
 */
export async function choosePurchaseAccount({ plan, billingCycle } = {}) {
    if (await hasCompany()) return { proceed: true, asCompany: true };

    const last = await fetchMyCompanyAccountRequest();
    const lastRequest = last.ok ? last.data : null;

    const choice = await openAccountTypeModal(lastRequest);
    if (choice === PURCHASE_AS.individual) return { proceed: true, asCompany: false };
    if (choice === PURCHASE_AS.company) await openCompanyModal({ plan, billingCycle, lastRequest });
    return { proceed: false, asCompany: false };
}

/**
 * يربط الاشتراك المُنشأ للتو بشركة المستخدم، لو عنده شركة.
 * الفشل هنا مش بيوقف المسار: طلب الاشتراك اتسجّل فعلًا، والربط بيتعوّض
 * تلقائيًا وقت العرض (اللوحة بتحسب اشتراكات مالك الشركة كمان)، فبنسجّل
 * التحذير وبس بدل ما نقلق العميل برسالة خطأ عن عملية نجحت.
 */
export async function linkSubscriptionToMyCompany(subscriptionId) {
    if (!subscriptionId) return false;
    if (!(await hasCompany())) return false;

    const result = await linkSubscriptionToCompany(subscriptionId);
    if (!result.ok || result.data !== true) {
        console.warn('[CompanyOnboarding] تعذّر ربط الاشتراك بالشركة:', result.error || 'لم يتم الربط');
        return false;
    }
    return true;
}

/* ==================== النوافذ ==================== */

/**
 * هيكل نافذة بنفس أسلوب نافذة وسيلة الدفع في subscriptions-script.js (تُبنى
 * وقت الحاجة وتُرجع Promise)، عشان يفضل نفس السلوك في نفس الصفحة.
 */
function createModal({ maxWidth, label, onDismiss }) {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position: fixed; inset: 0; background: rgba(0,0,0,0.55);
        display: flex; align-items: center; justify-content: center;
        z-index: 10000; padding: 1rem;
    `;

    const box = document.createElement('div');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', label);
    box.style.cssText = `
        background: var(--color-surface); color: var(--color-text);
        border: 1px solid var(--color-border); border-radius: 1rem;
        padding: 1.75rem; width: 100%; max-width: ${maxWidth}px; max-height: 90vh;
        overflow-y: auto; box-shadow: var(--shadow-lg, 0 10px 30px rgba(0,0,0,.3));
    `;

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const onKeydown = (event) => { if (event.key === 'Escape') onDismiss(); };
    document.addEventListener('keydown', onKeydown);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) onDismiss(); });

    const remove = () => {
        overlay.remove();
        document.removeEventListener('keydown', onKeydown);
    };
    return { box, remove };
}

const PRIMARY_BTN = `flex:1; padding:0.75rem; border:none; border-radius:0.6rem; background:var(--color-accent);
    color:#fff; font-weight:700; font-family:inherit; cursor:pointer;`;
const SECONDARY_BTN = `flex:1; padding:0.75rem; border:1px solid var(--color-border); border-radius:0.6rem;
    background:transparent; color:var(--color-text); font-weight:700; font-family:inherit; cursor:pointer;`;

const ICONS = {
    individual: `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
    company: `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/><path d="M9 9v.01M9 12v.01M9 15v.01"/></svg>`
};

/**
 * نافذة «اشترك بصفتك: فرد أم شركة؟».
 * لو للعميل طلب شركة قيد المراجعة، خيار الشركة بيظهر بحالته ومقفول — والفرد
 * متاح عادي. ولو الطلب السابق اترفض، سبب الرفض بيظهر قبل ما يبعت تاني.
 * @returns {Promise<'individual'|'company'|null>}
 */
export function openAccountTypeModal(lastRequest = null) {
    return new Promise((resolve) => {
        const pending = lastRequest?.status === 'pending';
        const rejected = lastRequest?.status === 'rejected';

        const close = (value) => { remove(); resolve(value); };
        const { box, remove } = createModal({
            maxWidth: 540, label: 'نوع الحساب', onDismiss: () => close(null)
        });

        const option = (value, title, text, { disabled = false, badge = '' } = {}) => `
            <button type="button" data-account-type="${value}" ${disabled ? 'disabled aria-disabled="true"' : ''}
                style="display:flex; flex-direction:column; align-items:flex-start; gap:0.45rem; text-align:start;
                       padding:1.1rem; border:2px solid var(--color-border); border-radius:0.85rem;
                       background:transparent; color:var(--color-text); font-family:inherit;
                       cursor:${disabled ? 'not-allowed' : 'pointer'}; opacity:${disabled ? '0.75' : '1'};">
                <span style="color:var(--color-accent);">${ICONS[value]}</span>
                <span style="display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap;">
                    <strong style="font-size:1rem;">${title}</strong>${badge}
                </span>
                <span style="font-size:0.8rem; color:var(--color-text-secondary); line-height:1.7;">${text}</span>
            </button>`;

        const pendingBadge = `<span style="font-size:0.7rem; font-weight:700; padding:0.15rem 0.55rem; border-radius:999px;
            background:rgba(224,168,0,0.15); color:var(--color-warning,#b7791f);">قيد المراجعة</span>`;

        const companyText = pending
            ? `طلب حساب الشركة «${escapeHtml(lastRequest.company_name)}» لدى فريق الإدارة الآن، وسنُخطرك فور البت فيه. يمكنك الاشتراك كفرد في الأثناء.`
            : 'أرسل بيانات شركتك ليراجعها فريق الإدارة، وعند الموافقة يتحوّل حسابك إلى حساب شركة وتكمل الاشتراك باسمها.';

        box.innerHTML = `
            <h3 style="margin:0 0 0.25rem; font-size:1.15rem; font-weight:800;">هل تشترك كفرد أم كشركة؟</h3>
            <p style="margin:0 0 1.25rem; font-size:0.85rem; color:var(--color-text-secondary); line-height:1.7;">
                اختر نوع الحساب الذي سيُفعَّل عليه الاشتراك.
            </p>
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:0.75rem;">
                ${option('individual', 'فرد', 'اشترك باسمك الشخصي وأكمل بيانات الدفع الآن.')}
                ${option('company', 'شركة', companyText, { disabled: pending, badge: pending ? pendingBadge : '' })}
            </div>
            ${rejected ? `
            <p data-rejected-note style="margin:1rem 0 0; padding:0.75rem 0.9rem; border-radius:0.6rem; font-size:0.8rem; line-height:1.7;
                      background:rgba(217,83,79,0.1); color:var(--color-text);">
                لم تتم الموافقة على طلبك السابق${lastRequest.review_note ? `: ${escapeHtml(lastRequest.review_note)}` : '.'}
                يمكنك إرسال طلب جديد ببيانات مصحّحة.
            </p>` : ''}
            <div style="display:flex; margin-top:1.25rem;">
                <button type="button" data-account-cancel style="${SECONDARY_BTN}">إلغاء</button>
            </div>`;

        box.querySelectorAll('[data-account-type]:not([disabled])').forEach((btn) => {
            btn.addEventListener('click', () => close(btn.dataset.accountType));
        });
        box.querySelector('[data-account-cancel]').addEventListener('click', () => close(null));
        box.querySelector('[data-account-type]:not([disabled])')?.focus();
    });
}

/**
 * نموذج بيانات الشركة — بيبعت الطلب من جوّه النافذة نفسها.
 * رسالة القاعدة (سجل مسجّل، طلب قائم…) بتظهر في النموذج والبيانات لسه فيه،
 * بدل ما النافذة تتقفل والعميل يكتب كل حاجة من الأول. وعند النجاح النافذة
 * نفسها بتقول للعميل إيه اللي هيحصل بعد كده.
 * @returns {Promise<boolean>} true لو الطلب اتبعت
 */
export function openCompanyModal({ plan = null, billingCycle = null, lastRequest = null } = {}) {
    return new Promise((resolve) => {
        let submitted = false;
        let busy = false;
        const close = () => { if (busy) return; remove(); resolve(submitted); };
        const { box, remove } = createModal({ maxWidth: 480, label: 'بيانات الشركة', onDismiss: close });

        const field = (id, label, type, required, hint, value = '') => `
            <label style="display:block; margin-bottom:0.9rem;">
                <span style="display:block; font-size:0.85rem; font-weight:700; margin-bottom:0.35rem;">
                    ${label}${required ? ' <span style="color:var(--color-danger,#e5484d)">*</span>' : ''}
                </span>
                <input id="${id}" type="${type}" value="${escapeHtml(value)}"
                       style="width:100%; box-sizing:border-box; padding:0.7rem 0.9rem; border-radius:0.6rem;
                              border:1px solid var(--color-border); background:var(--color-surface-2, transparent);
                              color:var(--color-text); font-family:inherit; font-size:0.9rem;">
                ${hint ? `<span style="display:block; font-size:0.75rem; color:var(--color-text-secondary); margin-top:0.3rem;">${hint}</span>` : ''}
                <span data-error-for="${id}" style="display:none; font-size:0.75rem; color:var(--color-danger,#e5484d); margin-top:0.3rem;"></span>
            </label>`;

        box.innerHTML = `
            <div data-company-form>
                <h3 style="margin:0 0 0.25rem; font-size:1.15rem; font-weight:800;">بيانات الشركة</h3>
                <p style="margin:0 0 1.25rem; font-size:0.85rem; color:var(--color-text-secondary); line-height:1.7;">
                    أدخل البيانات القانونية الأساسية لشركتك. يراجعها فريق الإدارة، وعند الموافقة
                    يتحوّل حسابك إلى حساب شركة وتظهر لك لوحة الشركة.
                </p>
                ${field('cmCompanyName', 'اسم الشركة', 'text', true, '', lastRequest?.company_name || '')}
                ${field('cmCrNumber', 'رقم السجل التجاري', 'text', true, '')}
                ${field('cmCrExpiry', 'تاريخ انتهاء السجل التجاري', 'date', true, 'يُحفظ ضمن بيانات الشركة للتحقق مستقبلًا')}
                ${field('cmCompanyEmail', 'البريد الإلكتروني للشركة', 'email', false, '')}
                ${field('cmCompanyPhone', 'هاتف الشركة', 'tel', false, '')}
                <p id="cmFormError" role="alert" style="display:none; font-size:0.8rem; color:var(--color-danger,#e5484d); margin:0 0 0.9rem; line-height:1.6;"></p>
                <div style="display:flex; gap:0.6rem; margin-top:1.25rem;">
                    <button type="button" id="cmSubmit" style="${PRIMARY_BTN}">إرسال الطلب للمراجعة</button>
                    <button type="button" id="cmCancel" style="${SECONDARY_BTN}">إلغاء</button>
                </div>
            </div>
            <div data-company-done hidden style="text-align:center;">
                <div style="width:56px; height:56px; margin:0 auto 1rem; border-radius:50%; display:flex; align-items:center;
                            justify-content:center; background:rgba(46,138,58,0.12); color:var(--color-success,#2e8a3a);">
                    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
                </div>
                <h3 style="margin:0 0 0.5rem; font-size:1.15rem; font-weight:800;">تم إرسال طلب حساب الشركة</h3>
                <p style="margin:0 0 1.25rem; font-size:0.85rem; color:var(--color-text-secondary); line-height:1.8;">
                    يراجع فريق الإدارة بيانات شركتك الآن، وسنُرسل لك إشعارًا فور البت في الطلب.
                    عند الموافقة يتحوّل حسابك إلى حساب شركة، ثم تكمل الاشتراك والدفع باسمها.
                </p>
                <button type="button" id="cmDone" style="${PRIMARY_BTN} width:100%;">حسنًا</button>
            </div>`;

        const formErrorEl = box.querySelector('#cmFormError');
        const submitBtn = box.querySelector('#cmSubmit');
        box.querySelector('#cmCancel').addEventListener('click', close);
        box.querySelector('#cmDone').addEventListener('click', close);

        submitBtn.addEventListener('click', async () => {
            box.querySelectorAll('[data-error-for]').forEach(el => { el.style.display = 'none'; el.textContent = ''; });
            formErrorEl.style.display = 'none';

            const values = {
                companyName: box.querySelector('#cmCompanyName').value,
                crNumber: box.querySelector('#cmCrNumber').value,
                crExpiry: box.querySelector('#cmCrExpiry').value,
                companyEmail: box.querySelector('#cmCompanyEmail').value,
                companyPhone: box.querySelector('#cmCompanyPhone').value
            };

            // نفس قواعد submit_company_account_request في القاعدة — الرسالة بالعربي قبل الإرسال
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

            busy = true;
            submitBtn.disabled = true;
            submitBtn.textContent = 'جاري الإرسال...';
            const result = await submitCompanyAccountRequest(values, { plan, billingCycle });
            busy = false;
            submitBtn.disabled = false;
            submitBtn.textContent = 'إرسال الطلب للمراجعة';

            if (!result.ok) {
                formErrorEl.textContent = result.error || 'تعذّر إرسال الطلب. حاول مرة أخرى.';
                formErrorEl.style.display = 'block';
                return;
            }

            submitted = true;
            box.querySelector('[data-company-form]').hidden = true;
            box.querySelector('[data-company-done]').hidden = false;
            box.querySelector('#cmDone').focus();
        });

        box.querySelector('#cmCompanyName').focus();
    });
}
