/**
 * company-request-model.js — لغة المدخل المستقل لطلب حساب شركة (138).
 *
 * دوال خالصة بلا أي اتصال بالشبكة أو بالـDOM، عشان تتّختبر بمعزل
 * (tests/company-request-standalone.test.mjs) — نفس أسلوب company-model.js.
 *
 * القاعدة المهمة (مثل company-model.js): الدوال دي **عرض** فقط. القرار
 * بيتاخد في قاعدة البيانات (submit_standalone_company_account_request
 * + قيود الجدول في 138)، والواجهة بتقول القواعد بالعربي قبل الإرسال.
 * أي تحقق هنا يوفّر رحلة فاشلة؛ الرفض النهائي يظل عند القاعدة.
 *
 * الإثبات المشروط بنوع المتقدم (نفس قواعد 138 حرفيًا):
 *   • company  ⇒ مستند يثبت أنها شركة (PDF/PNG/JPEG ≤ 10MB)، ولا رابط.
 *   • store    ⇒ رابط الموقع/المتجر بصيغة صالحة، ولا مستند.
 *   • platform ⇒ رابط الموقع/المنصة بصيغة صالحة، ولا مستند.
 *   • other    ⇒ لا مستند ولا رابط.
 */

export const APPLICANT_TYPES = Object.freeze({
    company: 'company',
    store: 'store',
    platform: 'platform',
    other: 'other'
});

export const APPLICANT_TYPE_LABELS = Object.freeze({
    company: 'شركة',
    store: 'متجر إلكتروني',
    platform: 'منصة',
    other: 'أخرى'
});

/** نوع الإثبات الذي يطلبه كل نوع متقدم: 'document' | 'url' | 'none'. */
export function proofRequirementFor(applicantType) {
    switch (applicantType) {
        case 'company': return 'document';
        case 'store':
        case 'platform': return 'url';
        case 'other': return 'none';
        default: return null;
    }
}

export function applicantTypeLabel(applicantType) {
    return APPLICANT_TYPE_LABELS[applicantType] || 'غير محدد';
}

/** هل هذا الطلب مستقل (من المدخل الجديد) أم من مسار الشراء؟ قراءة لا حساب. */
export function isStandaloneRequest(request) {
    return request?.request_source === 'standalone';
}

/* ── رابط الموقع/المتجر (store / platform) ───────────────────────────────
 *
 * القاعدة في 138 صارمة: ^https?://host.tld... — والواجهة متساهلة خطوة
 * واحدة: رابط بلا مخطط يُكمَّل بـ https:// قبل الإرسال (مثل validStoreDomain
 * في company-onboarding.js)، فيصل الخادم دائمًا بصيغة يقبلها.
 */
const URL_HOST_RE = /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}(:[0-9]{1,5})?(\/.*)?$/;

export function validApplicantWebsiteUrl(value) {
    let s = String(value ?? '').trim();
    if (!s) return { ok: false, value: null, error: 'رابط الموقع أو المتجر مطلوب' };
    if (/\s/.test(s)) return { ok: false, value: null, error: 'رابط غير صالح — لا مسافات في الرابط' };
    if (s.length > 2048) return { ok: false, value: null, error: 'الرابط طويل جدًا' };
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    let url;
    try {
        url = new URL(s);
    } catch {
        return { ok: false, value: null, error: 'رابط غير صالح — اكتب رابطًا يبدأ بـ https://' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { ok: false, value: null, error: 'رابط غير صالح — اكتب رابطًا يبدأ بـ https://' };
    }
    const rest = s.replace(/^https?:\/\//i, '');
    if (!URL_HOST_RE.test(rest)) {
        return { ok: false, value: null, error: 'رابط غير صالح — اكتب رابطًا يبدأ بـ https://' };
    }
    return { ok: true, value: url.href, error: null };
}

/* ── مستند الإثبات (company) ──────────────────────────────────────────────
 *
 * نفس قواعد مسار مستندات الشركات (company-documents.js: PDF/PNG/JPEG ≤ 10MB)
 * — القاعدة (138) والدالة الطرفية يتحققان مرة أخرى.
 */
export const PROOF_ALLOWED_MIME = Object.freeze(['application/pdf', 'image/png', 'image/jpeg']);
export const PROOF_MAX_BYTES = 10 * 1024 * 1024;

/** فحص الملف قبل الرفع. خالصة: ترجّع رسالة الخطأ أو null. */
export function validateProofFile(file, allowed = PROOF_ALLOWED_MIME, max = PROOF_MAX_BYTES) {
    if (!file) return 'اختر ملفًا';
    if (!allowed.includes(file.type)) return 'النوع المسموح: PDF أو PNG أو JPEG';
    if (file.size < 1) return 'الملف فارغ';
    if (file.size > max) return 'الحد الأقصى 10 ميجابايت';
    return null;
}

/**
 * تحقّق من نموذج الطلب المستقل كاملًا.
 * الحقول القانونية الأساسية نفس قواعد validateCompanyForm في company-model.js
 * (الاسم، السجل، تاريخ الانتهاء، البريد)؛ وفوقها الإثبات المشروط:
 *   values = { companyName, crNumber, crExpiry, companyEmail, companyPhone,
 *              applicantType, websiteUrl, proofFile, proofUploaded }
 *   proofUploaded = true بعد رفع المستند بنجاح عبر company-document-upload
 *   (الرفع نفسه يسبق الإرسال؛ هنا نتحقق من وجوده فقط).
 */
export function validateStandaloneRequest(values) {
    const errors = {};
    const name = String(values?.companyName || '').trim();
    const cr = String(values?.crNumber || '').trim();
    const expiry = String(values?.crExpiry || '').trim();

    if (name.length < 2) errors.companyName = 'اسم الشركة مطلوب';
    if (cr.length < 3) errors.crNumber = 'رقم السجل التجاري مطلوب';
    if (!expiry) {
        errors.crExpiry = 'تاريخ انتهاء السجل التجاري مطلوب';
    } else if (Number.isNaN(new Date(expiry).getTime())) {
        errors.crExpiry = 'تاريخ غير صالح';
    }

    const email = String(values?.companyEmail || '').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errors.companyEmail = 'بريد إلكتروني غير صالح';
    }

    const requirement = proofRequirementFor(values?.applicantType);
    if (requirement === null) {
        errors.applicantType = 'اختر نوع المتقدم';
    } else if (requirement === 'document') {
        // القاعدة ترفض الرابط مع «شركة» (المستند بدل الرابط، لا معه)
        if (String(values?.websiteUrl || '').trim()) {
            errors.websiteUrl = 'نوع «شركة» يُثبَت بمستند، لا برابط';
        }
        if (values?.proofUploaded === true) {
            // رُفع بنجاح — لا شيء إضافي
        } else if (values?.proofFile) {
            const fileError = validateProofFile(values.proofFile);
            if (fileError) errors.proofFile = fileError;
        } else {
            errors.proofFile = 'مستند الإثبات مطلوب — ارفع مستندًا يثبت أنها شركة';
        }
    } else if (requirement === 'url') {
        // القاعدة ترفض المستند مع «متجر/منصة» (الرابط بدل المستند، لا معه)
        if (values?.proofFile || values?.proofUploaded === true) {
            errors.proofFile = 'نوع «متجر إلكتروني» و«منصة» يُثبَت برابط، لا بمستند';
        }
        const url = validApplicantWebsiteUrl(values?.websiteUrl);
        if (!url.ok) errors.websiteUrl = url.error;
    }
    // 'none' (أخرى): لا مستند ولا رابط — أي إثبات مرسل مرفوض عند القاعدة
    if (requirement === 'none') {
        if (String(values?.websiteUrl || '').trim()) errors.websiteUrl = 'نوع «أخرى» لا يحتاج مستندًا ولا رابطًا';
        if (values?.proofFile || values?.proofUploaded === true) errors.proofFile = 'نوع «أخرى» لا يحتاج مستندًا ولا رابطًا';
    }

    return { isValid: Object.keys(errors).length === 0, errors };
}

/**
 * ما الذي يعرضه النموذج لحقول الإثبات حسب النوع — خالص.
 * يُستخدم لإظهار/إخفاء حقل المستند أو الرابط عند تبديل النوع.
 */
export function proofFieldsFor(applicantType) {
    const requirement = proofRequirementFor(applicantType);
    return { showDocument: requirement === 'document', showUrl: requirement === 'url', requirement };
}

/** حجم ملف للعرض في قائمة المراجعة (بايتات ← «1.2 م.ب» تقريبًا). */
export function formatProofSize(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 1) return '—';
    if (n < 1024) return `${n} بايت`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} ك.ب`;
    return `${(n / (1024 * 1024)).toFixed(1)} م.ب`;
}
