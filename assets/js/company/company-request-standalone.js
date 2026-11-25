/**
 * company-request-standalone.js — المدخل المستقل لطلب حساب شركة (138).
 *
 * طلب من خارج مسار الشراء، يفتح من:
 *   • صفحة الدخول/التسجيل (login.html) — زر «اطلب إنشاء حساب شركة»،
 *     ويُفتح تلقائيًا مع ?company_request=1 (رابط من index.html).
 *   • لوحة الشركة (company-dashboard) — بوابة «لا توجد شركة».
 *
 * المسار:
 *   1. نوع المتقدم: شركة | متجر إلكتروني | منصة | أخرى.
 *   2. البيانات القانونية الأساسية (نفس حقول طلب الشراء في 068).
 *   3. الإثبات المشروط (company-request-model.js، ونفس قواعد القاعدة في 138):
 *        شركة   ⇒ رفع مستند يثبت أنها شركة (عبر company-document-upload
 *                  بوضع إثبات الطلب) قبل الإرسال.
 *        متجر/منصة ⇒ رابط الموقع/المتجر بصيغة صالحة.
 *        أخرى   ⇒ لا شيء.
 *   4. الإرسال عبر submitStandaloneCompanyAccountRequest (138): بلا باقة،
 *      وبلا شركة قبل موافقة الإدارة — النافذة نفسها تقول ذلك عند النجاح.
 *
 * بلا جلسة: النافذة تعرض بوابة «سجّل الدخول أو أنشئ حسابًا أولًا» بدل
 * النموذج — الطلب لحساب مسجَّل مفعَّل (بوابة 068 في القاعدة)، فلا نموذج
 * لزائر بلا حساب. طلب قيد المراجعة: النافذة تعرض حالته ولا تسمح بطلب ثانٍ.
 */

import { supabase } from '/api-config.js';
import {
    hasCompany,
    submitStandaloneCompanyAccountRequest,
    uploadStandaloneProof,
    fetchMyCompanyAccountRequest
} from '/assets/js/company/company-data.js';
import {
    APPLICANT_TYPES,
    APPLICANT_TYPE_LABELS,
    proofRequirementFor,
    validApplicantWebsiteUrl,
    validateProofFile,
    validateStandaloneRequest
} from '/assets/js/company/company-request-model.js';
import { escapeHtml } from '/assets/js/customer/portal-ui.js';

const TYPE_ORDER = [APPLICANT_TYPES.company, APPLICANT_TYPES.store, APPLICANT_TYPES.platform, APPLICANT_TYPES.other];

const TYPE_HINTS = {
    company: 'ارفع مستندًا يثبت أنها شركة (السجل التجاري مثلًا).',
    store: 'اكتب رابط متجرك الإلكتروني — يُراجَع بدل المستند.',
    platform: 'اكتب رابط منصتك — يُراجَع بدل المستند.',
    other: 'بلا مستند ولا رابط — اكتب بياناتك وسيتواصل معك فريق الإدارة.'
};

/* نافذة بنفس أسلوب company-onboarding.js (تُبنى وقت الحاجة وتُرجع Promise). */
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
    const remove = () => { overlay.remove(); document.removeEventListener('keydown', onKeydown); };
    return { box, remove };
}

const PRIMARY_BTN = `flex:1; padding:0.75rem; border:none; border-radius:0.6rem; background:var(--color-accent);
    color:#fff; font-weight:700; font-family:inherit; cursor:pointer;`;
const SECONDARY_BTN = `flex:1; padding:0.75rem; border:1px solid var(--color-border); border-radius:0.6rem;
    background:transparent; color:var(--color-text); font-weight:700; font-family:inherit; cursor:pointer;`;

/**
 * يفتح نافذة الطلب المستقل.
 * @returns {Promise<boolean>} true لو أُرسل طلب جديد
 */
export async function openStandaloneCompanyRequestModal() {
    const { data: { session } = {} } = await supabase.auth.getSession();

    return new Promise((resolve) => {
        let submitted = false;
        let busy = false;
        const close = () => { if (busy) return; remove(); resolve(submitted); };
        const { box, remove } = createModal({ maxWidth: 520, label: 'طلب إنشاء حساب شركة', onDismiss: close });

        if (!session) {
            box.innerHTML = `
                <h3 style="margin:0 0 0.5rem; font-size:1.15rem; font-weight:800;">طلب إنشاء حساب شركة</h3>
                <p style="margin:0 0 1.25rem; font-size:0.9rem; color:var(--color-text-secondary); line-height:1.8;">
                    هذا الطلب لحساب مسجَّل في المنصة: سجّل الدخول أولًا، أو أنشئ حسابًا
                    جديدًا ثم اطلب إنشاء حساب الشركة من هنا. يراجع فريق الإدارة طلبك،
                    ولا يُفعَّل أي شيء قبل الموافقة.
                </p>
                <div style="display:flex; gap:0.6rem;">
                    <a href="/login.html" style="${PRIMARY_BTN} text-align:center; text-decoration:none;">تسجيل الدخول</a>
                    <a href="/login.html#register" style="${SECONDARY_BTN} text-align:center; text-decoration:none;">إنشاء حساب جديد</a>
                </div>
                <div style="display:flex; margin-top:0.6rem;">
                    <button type="button" data-close style="${SECONDARY_BTN}">إغلاق</button>
                </div>`;
            box.querySelector('[data-close]').addEventListener('click', close);
            return;
        }

        // حالة الحساب والطلب القائم من القاعدة — لا من حالة محفوظة في الصفحة
        Promise.all([hasCompany(), fetchMyCompanyAccountRequest()]).then(([alreadyCompany, last]) => {
            if (alreadyCompany) {
                box.innerHTML = `
                    <h3 style="margin:0 0 0.5rem; font-size:1.15rem; font-weight:800;">حسابك حساب شركة بالفعل</h3>
                    <p style="margin:0 0 1.25rem; font-size:0.9rem; color:var(--color-text-secondary); line-height:1.8;">
                        لوحة الشركة مفعّلة لحسابك، فلا حاجة لطلب جديد.
                    </p>
                    <div style="display:flex; gap:0.6rem;">
                        <a href="/company-dashboard/" style="${PRIMARY_BTN} text-align:center; text-decoration:none;">فتح لوحة الشركة</a>
                        <button type="button" data-close style="${SECONDARY_BTN}">إغلاق</button>
                    </div>`;
                box.querySelector('[data-close]').addEventListener('click', close);
                return;
            }

            const lastRequest = last.ok ? last.data : null;
            if (lastRequest?.status === 'pending') {
                const typeLabel = APPLICANT_TYPE_LABELS[lastRequest.applicant_type] || 'شركة';
                box.innerHTML = `
                    <h3 style="margin:0 0 0.5rem; font-size:1.15rem; font-weight:800;">طلبك قيد المراجعة</h3>
                    <p style="margin:0 0 1.25rem; font-size:0.9rem; color:var(--color-text-secondary); line-height:1.8;">
                        طلب حساب ${escapeHtml(typeLabel)} «${escapeHtml(lastRequest.company_name)}» لدى فريق الإدارة الآن،
                        وسنُخطرك فور البت فيه. لم يُفعَّل أي شيء بعد — التفعيل بعد الموافقة فقط.
                    </p>
                    <div style="display:flex;">
                        <button type="button" data-close style="${PRIMARY_BTN}">حسنًا</button>
                    </div>`;
                box.querySelector('[data-close]').addEventListener('click', close);
                return;
            }

            renderForm(box, close, {
                onSubmitted: () => { submitted = true; },
                isBusy: () => busy,
                setBusy: (value) => { busy = value; },
                rejectedNote: lastRequest?.status === 'rejected' ? lastRequest.review_note : null,
                lastName: lastRequest?.company_name || ''
            });
        });
    });
}

function renderForm(box, close, { onSubmitted, isBusy, setBusy, rejectedNote, lastName }) {
    let applicantType = APPLICANT_TYPES.company;
    let proofFile = null;
    let proofToken = null;
    let proofUploaded = false;
    let proofName = '';

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
        <div data-request-form>
            <h3 style="margin:0 0 0.25rem; font-size:1.15rem; font-weight:800;">طلب إنشاء حساب شركة</h3>
            <p style="margin:0 0 1.25rem; font-size:0.85rem; color:var(--color-text-secondary); line-height:1.7;">
                طلب مستقل من خارج مسار الشراء — بلا باقة وبلا دفع. يراجعه فريق الإدارة
                ويتواصل معك للاتفاق، ولا يُفعَّل أي شيء قبل الموافقة.
            </p>
            ${rejectedNote ? `
            <p data-rejected-note style="margin:0 0 1rem; padding:0.75rem 0.9rem; border-radius:0.6rem; font-size:0.8rem; line-height:1.7;
                      background:rgba(217,83,79,0.1); color:var(--color-text);">
                لم تتم الموافقة على طلبك السابق: ${escapeHtml(rejectedNote)}
                يمكنك إرسال طلب جديد ببيانات مصحّحة.
            </p>` : ''}
            <fieldset style="border:none; padding:0; margin:0 0 1rem;">
                <legend style="font-size:0.85rem; font-weight:700; margin-bottom:0.5rem; padding:0;">نوع المتقدم <span style="color:var(--color-danger,#e5484d)">*</span></legend>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.6rem;" role="radiogroup" aria-label="نوع المتقدم">
                    ${TYPE_ORDER.map((type) => `
                    <button type="button" role="radio" aria-checked="${type === applicantType}" data-applicant-type="${type}"
                        style="padding:0.8rem; border-radius:0.6rem; text-align:start; font-family:inherit; cursor:pointer;
                               border:2px solid ${type === applicantType ? 'var(--color-accent)' : 'var(--color-border)'};
                               background:transparent; color:var(--color-text);">
                        <strong style="display:block; font-size:0.9rem;">${APPLICANT_TYPE_LABELS[type]}</strong>
                        <span style="display:block; font-size:0.75rem; color:var(--color-text-secondary); line-height:1.6; margin-top:0.2rem;">${TYPE_HINTS[type]}</span>
                    </button>`).join('')}
                </div>
                <span data-error-for="applicantType" style="display:none; font-size:0.75rem; color:var(--color-danger,#e5484d); margin-top:0.3rem;"></span>
            </fieldset>
            <div data-proof-document>
                <label style="display:block; margin-bottom:0.9rem;">
                    <span style="display:block; font-size:0.85rem; font-weight:700; margin-bottom:0.35rem;">
                        مستند يثبت أنها شركة <span style="color:var(--color-danger,#e5484d)">*</span>
                    </span>
                    <input id="srProofFile" type="file" accept="application/pdf,image/png,image/jpeg"
                           style="width:100%; box-sizing:border-box; padding:0.7rem 0.9rem; border-radius:0.6rem;
                                  border:1px solid var(--color-border); background:var(--color-surface-2, transparent);
                                  color:var(--color-text); font-family:inherit; font-size:0.9rem;">
                    <span style="display:block; font-size:0.75rem; color:var(--color-text-secondary); margin-top:0.3rem;">السجل التجاري مثلًا — PDF أو PNG أو JPEG، حتى 10 ميجابايت. يُرفع أولًا ثم يُرسَل الطلب.</span>
                    <span data-proof-status style="display:none; font-size:0.8rem; color:var(--color-success,#2e8a3a); margin-top:0.3rem;"></span>
                    <span data-error-for="srProofFile" style="display:none; font-size:0.75rem; color:var(--color-danger,#e5484d); margin-top:0.3rem;"></span>
                </label>
            </div>
            <div data-proof-url hidden>
                ${field('srWebsiteUrl', 'رابط الموقع أو المتجر', 'url', true, 'مثال: https://my-store.com — يُراجَع بدل المستند')}
            </div>
            ${field('srCompanyName', 'اسم الشركة', 'text', true, '', lastName)}
            ${field('srCrNumber', 'رقم السجل التجاري', 'text', true, '')}
            ${field('srCrExpiry', 'تاريخ انتهاء السجل التجاري', 'date', true, 'يُحفظ ضمن بيانات الشركة للتحقق مستقبلًا')}
            ${field('srCompanyEmail', 'البريد الإلكتروني للشركة', 'email', false, '')}
            ${field('srCompanyPhone', 'هاتف الشركة', 'tel', false, '')}
            <p data-form-error role="alert" style="display:none; font-size:0.8rem; color:var(--color-danger,#e5484d); margin:0 0 0.9rem; line-height:1.6;"></p>
            <div style="display:flex; gap:0.6rem; margin-top:1.25rem;">
                <button type="button" data-submit style="${PRIMARY_BTN}">إرسال الطلب للمراجعة</button>
                <button type="button" data-cancel style="${SECONDARY_BTN}">إلغاء</button>
            </div>
        </div>
        <div data-request-done hidden style="text-align:center;">
            <div style="width:56px; height:56px; margin:0 auto 1rem; border-radius:50%; display:flex; align-items:center;
                        justify-content:center; background:rgba(46,138,58,0.12); color:var(--color-success,#2e8a3a);">
                <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <h3 style="margin:0 0 0.5rem; font-size:1.15rem; font-weight:800;">تم إرسال طلب حساب الشركة</h3>
            <p style="margin:0 0 1.25rem; font-size:0.85rem; color:var(--color-text-secondary); line-height:1.8;">
                يراجع فريق الإدارة طلبك الآن وسيتواصل معك للاتفاق، وسنُرسل لك إشعارًا فور البت فيه.
                لم يُفعَّل أي شيء بعد — التفعيل بعد الموافقة فقط.
            </p>
            <button type="button" data-done style="${PRIMARY_BTN} width:100%;">حسنًا</button>
        </div>`;

    const formErrorEl = box.querySelector('[data-form-error]');
    const submitBtn = box.querySelector('[data-submit]');
    const proofDocBox = box.querySelector('[data-proof-document]');
    const proofUrlBox = box.querySelector('[data-proof-url]');
    const proofStatusEl = box.querySelector('[data-proof-status]');
    const proofInput = box.querySelector('#srProofFile');

    const showFieldError = (id, message) => {
        const el = box.querySelector(`[data-error-for="${id}"]`);
        if (el) { el.textContent = message; el.style.display = message ? 'block' : 'none'; }
    };
    const clearErrors = () => {
        box.querySelectorAll('[data-error-for]').forEach(el => { el.style.display = 'none'; el.textContent = ''; });
        formErrorEl.style.display = 'none';
    };

    const applyType = (type) => {
        applicantType = type;
        // تبديل النوع يُسقط إثبات النوع السابق — مستند نوع «شركة» لا يصلح
        // لرابط نوع «متجر»، والعكس صحيح (القاعدة ترفضهما معًا أصلًا).
        proofFile = null;
        proofToken = null;
        proofUploaded = false;
        proofName = '';
        if (proofInput) proofInput.value = '';
        proofStatusEl.style.display = 'none';
        box.querySelectorAll('[data-applicant-type]').forEach((btn) => {
            const active = btn.dataset.applicantType === type;
            btn.setAttribute('aria-checked', String(active));
            btn.style.borderColor = active ? 'var(--color-accent)' : 'var(--color-border)';
        });
        const requirement = proofRequirementFor(type);
        proofDocBox.hidden = requirement !== 'document';
        proofUrlBox.hidden = requirement !== 'url';
    };

    box.querySelectorAll('[data-applicant-type]').forEach((btn) => {
        btn.addEventListener('click', () => { applyType(btn.dataset.applicantType); clearErrors(); });
    });
    proofInput.addEventListener('change', () => {
        proofFile = proofInput.files?.[0] || null;
        proofUploaded = false;
        proofToken = null;
        proofName = proofFile?.name || '';
        const invalid = proofFile ? validateProofFile(proofFile) : null;
        showFieldError('srProofFile', invalid || '');
        proofStatusEl.style.display = 'none';
    });
    box.querySelector('[data-cancel]').addEventListener('click', close);
    box.querySelector('[data-done]').addEventListener('click', close);

    submitBtn.addEventListener('click', async () => {
        clearErrors();
        const values = {
            companyName: box.querySelector('#srCompanyName').value,
            crNumber: box.querySelector('#srCrNumber').value,
            crExpiry: box.querySelector('#srCrExpiry').value,
            companyEmail: box.querySelector('#srCompanyEmail').value,
            companyPhone: box.querySelector('#srCompanyPhone').value,
            applicantType,
            websiteUrl: proofUrlBox.hidden ? '' : box.querySelector('#srWebsiteUrl').value,
            proofFile: proofDocBox.hidden ? null : proofFile,
            proofUploaded
        };
        const fieldIds = {
            companyName: 'srCompanyName', crNumber: 'srCrNumber', crExpiry: 'srCrExpiry',
            companyEmail: 'srCompanyEmail', applicantType: 'applicantType',
            websiteUrl: 'srWebsiteUrl', proofFile: 'srProofFile'
        };
        const validation = validateStandaloneRequest(values);
        if (!validation.isValid) {
            for (const [key, message] of Object.entries(validation.errors)) showFieldError(fieldIds[key], message);
            return;
        }

        // رابط المتجر/المنصة يُطبَّع قبل الإرسال (بلا مخطط ⇒ https://)
        let websiteUrl = null;
        if (proofRequirementFor(applicantType) === 'url') {
            websiteUrl = validApplicantWebsiteUrl(values.websiteUrl).value;
        }

        setBusy(true);
        submitBtn.disabled = true;
        submitBtn.textContent = 'جاري الإرسال...';
        try {
            // نوع «شركة»: المستند يُرفع أولًا (138) — رمزه يُرسَل مع الطلب
            if (proofRequirementFor(applicantType) === 'document' && !proofUploaded) {
                submitBtn.textContent = 'جاري رفع المستند...';
                const token = crypto.randomUUID();
                const upload = await uploadStandaloneProof(proofFile, {
                    proofToken: token, idempotencyKey: crypto.randomUUID()
                });
                if (!upload.ok) {
                    formErrorEl.textContent = upload.error || 'تعذّر رفع المستند. حاول مرة أخرى.';
                    formErrorEl.style.display = 'block';
                    return;
                }
                proofToken = token;
                proofUploaded = true;
                proofStatusEl.textContent = `تم رفع المستند: ${proofName}`;
                proofStatusEl.style.display = 'block';
                submitBtn.textContent = 'جاري الإرسال...';
            }

            const result = await submitStandaloneCompanyAccountRequest(values, {
                applicantType, websiteUrl, proofToken
            });
            if (!result.ok) {
                formErrorEl.textContent = result.error || 'تعذّر إرسال الطلب. حاول مرة أخرى.';
                formErrorEl.style.display = 'block';
                return;
            }
            onSubmitted();
            box.querySelector('[data-request-form]').hidden = true;
            box.querySelector('[data-request-done]').hidden = false;
            box.querySelector('[data-done]').focus();
        } finally {
            setBusy(false);
            submitBtn.disabled = false;
            submitBtn.textContent = 'إرسال الطلب للمراجعة';
        }
    });

    box.querySelector('[data-applicant-type]')?.focus();
}

/* ── الربط: أي زر [data-standalone-company-request] في أي صفحة ───────────
 *
 * تفويض على مستوى المستند (زر واحد لكل صفحة أو أكثر)، وحارس ضد الربط
 * المكرر عند استدعاء init من أكثر من وحدة في الصفحة نفسها.
 * ?company_request=1 (رابط من index.html) يفتح النافذة تلقائيًا.
 */
let wired = false;

export function initStandaloneCompanyRequestEntry() {
    if (wired) return;
    wired = true;
    document.addEventListener('click', (event) => {
        const trigger = event.target?.closest?.('[data-standalone-company-request]');
        if (!trigger) return;
        event.preventDefault();
        openStandaloneCompanyRequestModal();
    });
    const params = new URLSearchParams(window.location.search || '');
    if (params.get('company_request') === '1') {
        openStandaloneCompanyRequestModal();
    }
}
