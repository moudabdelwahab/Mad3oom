/**
 * company-data-export-model.js — تصدير بيانات الشركة وحذف حسابها ذاتيًا.
 *
 * دوال خالصة بلا DOM (عدا downloadJsonDocument) لتُختبَر في node:
 * بناء اسم الملف، وتطبيع مستند التصدير الآتي من company_export_data()،
 * وسياسة الحذف والتحقق من سبب الطلب.
 *
 * ── الفواتير ─────────────────────────────────────────────────────────────
 * لا يوجد مصدر موثوق لقائمة فواتير على مستوى الشركة
 * (company-invoices-model.js: COMPANY_INVOICE_SOURCE.available = false).
 * فالمستند يذكر غيابها صراحةً في قسم invoices — بنفس نص الترحيل 140 —
 * ولا يُخترع سجل. وإن غاب القسم عن حمولة الخادم لأي سبب، يملؤه
 * buildExportDocument بالنص الموثق نفسه بدل تركه فارغًا.
 *
 * ── التنزيل ──────────────────────────────────────────────────────────────
 * بنمط Blob نفسه في report-export.js (downloadBlob): رابط مؤقت، نقرة
 * برمجية، ثم إلغاء الرابط بعد مهلة قصيرة.
 */

/** صيغة ملف التصدير — يطابقها الترحيل 140. */
export const EXPORT_FORMAT = 'mad3oom-company-data-export';
export const EXPORT_FORMAT_VERSION = 1;

/** أقل طول لسبب طلب الحذف — يطابق قيد الترحيل 140 والدالة. */
export const MIN_DELETION_REASON_LENGTH = 20;

/**
 * نص غياب الفواتير — نفس نص الترحيل 140 حرفيًا قدر الإمكان، فالواجهة
 * والملف والقاعدة تقول الشيء نفسه.
 */
export const EXPORT_INVOICE_NOTE = Object.freeze({
    available: false,
    table: 'accounting_invoices',
    reason: 'الفواتير لا تُسجَّل على مستوى الشركة: جدول الفواتير بلا عمود يربط الفاتورة بشركة، والفاتورة تُرفق داخل تذكرة طلب الاشتراك نفسها.',
    invoiceHome: 'subscription_request_ticket'
});

/**
 * سياسة تنفيذ الحذف — ما يُحذف/يُجهَّل وما يُحتفظ به ولِمَ.
 * تطابق تعليق company_request_account_deletion() في الترحيل 140.
 * تُعرض في الواجهة قبل تأكيد الطلب، فلا يطلب أحد حذفًا وهو يجهل أثره.
 */
export const DELETION_POLICY = Object.freeze({
    deleted: Object.freeze([
        'الحقول الشخصية في ملف الشركة: البريد والهاتف والعنوان',
        'بيانات الأعضاء الشخصية: الأسماء والبريد والهاتف',
        'محتوى تذاكر الشركة — وتُجهَّل الهويات فلا يبقى رابط إلى شخص'
    ]),
    kept: Object.freeze([
        'الاشتراكات والسجلات المالية — للاحتفاظ القانوني والمحاسبي',
        'صفوف الفواتير (accounting_invoices) — للاحتفاظ القانوني والمحاسبي',
        'سجلات التدقيق (سجل التصدير وطلبات الحذف وسجل العضويات) — للاحتفاظ القانوني'
    ])
});

/** ما يظهر فوق زر الحذف: تحذير صريح عن عدم التراجع بعد التنفيذ. */
export const DELETION_WARNING =
    'تحذير: بعد أن ينفّذ مالك المنصة طلب الحذف لا يمكن التراجع عنه — '
    + 'تُحذف بيانات الشركة والأعضاء الشخصية نهائيًا، وتبقى الشركة متوقفة. '
    + 'الطلب نفسه لا يحذف شيئًا فورًا، ويمكنك إلغاؤه ما دام قيد الانتظار.';

/**
 * اسم ملف التصدير. الاسم يُنظَّف لما يقبله نظام الملفات، والتاريخ من
 * تاريخ التصدير نفسه لا من اليوم افتراضًا.
 */
export function buildExportFilename(companyName, when = new Date()) {
    const date = when instanceof Date ? when : new Date(when);
    const stamp = Number.isNaN(date.getTime())
        ? new Date().toISOString().slice(0, 10)
        : date.toISOString().slice(0, 10);
    const slug = String(companyName || '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^\p{L}\p{N}_-]+/gu, '')
        .replace(/-+/g, '-')
        .replace(/^[-_]+|[-_]+$/g, '')
        .slice(0, 40) || 'company';
    return `mad3oom-company-data-${slug}-${stamp}.json`;
}

/** يعيد المصفوفة كما هي، أو [] لغير المصفوفة — فلا يكسر مستند ناقص. */
function asArray(value) {
    return Array.isArray(value) ? value : [];
}

/**
 * يطبّع حمولة company_export_data() إلى مستند التنزيل.
 *   • الأقسام الخمسة مضمونة كمصفوفات (ولو غاب أحدها).
 *   • العدّادات تُعاد حسابها من المصفوفات نفسها، فالمستند متسق مع
 *     محتواه ولا يعتمد على عدّاد قد يختلف.
 *   • قسم الفواتير: إن غاب أو فقد شكله، يُملأ بالنص الموثق
 *     (available=false)؛ وإن حضر كما أرسله الخادم يُترك كما هو.
 *   • يرفض حمولة ليست كائنًا — فلا يُنزَّل ملف من لا شيء.
 */
export function buildExportDocument(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('حمولة التصدير غير صالحة');
    }
    const members = asArray(payload.members);
    const tickets = asArray(payload.tickets);
    const subscriptions = asArray(payload.subscriptions);
    const activity = asArray(payload.activity);
    const membershipEvents = asArray(payload.membership_events);
    const invoices = payload.invoices && typeof payload.invoices === 'object' && !Array.isArray(payload.invoices)
        && typeof payload.invoices.available === 'boolean'
        ? payload.invoices
        : { ...EXPORT_INVOICE_NOTE, rows: [] };

    return {
        format: EXPORT_FORMAT,
        format_version: EXPORT_FORMAT_VERSION,
        exported_at: payload.exported_at || new Date().toISOString(),
        exported_by: payload.exported_by || null,
        company: payload.company || null,
        members,
        tickets,
        subscriptions,
        invoices,
        activity,
        membership_events: membershipEvents,
        counts: {
            members: members.length,
            tickets: tickets.length,
            subscriptions: subscriptions.length,
            activity: activity.length,
            membership_events: membershipEvents.length,
            invoices: Array.isArray(invoices.rows) ? invoices.rows.length : 0
        },
        file_name: typeof payload.file_name === 'string' && payload.file_name
            ? payload.file_name
            : buildExportFilename(payload.company?.name, payload.exported_at),
        export_notice: 'هذا الملف نسخة من بيانات شركتك كما هي في المنصة وقت التصدير. '
            + 'الفواتير غير متاحة على مستوى الشركة (انظر قسم invoices)، '
            + 'وهواتف الأعضاء وبيانات الدفع غير مشمولة في التصدير.'
    };
}

/**
 * تنزيل مستند JSON — نمط Blob نفسه في report-export.js.
 * (تأثير جانبي معزول: كل ما سبقه خالص وقابل للاختبار في node.)
 */
export function downloadJsonDocument(doc, filename) {
    const text = JSON.stringify(doc, null, 2);
    const blob = new Blob([text], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // الإلغاء بعد مهلة قصيرة: بعض المتصفحات تقرأ الـURL بعد النقرة
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * التحقق من سبب طلب الحذف — نفس حدّ الخادم (20 حرفًا).
 * يرجع رسالة الخطأ العربية، أو null إن كان السبب مقبولًا.
 */
export function validateDeletionReason(reason) {
    const text = String(reason || '').trim();
    if (!text) {
        return 'اكتب سبب طلب الحذف — يراجعه مالك المنصة قبل أي إجراء.';
    }
    if (text.length < MIN_DELETION_REASON_LENGTH) {
        return `السبب قصير: اكتب ${MIN_DELETION_REASON_LENGTH} حرفًا على الأقل حتى يفهم مالك المنصة طلبك.`;
    }
    return null;
}
