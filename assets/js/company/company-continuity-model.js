/**
 * company-continuity-model.js — الاستمرارية داخل لوحة الشركة: دوال خالصة.
 *
 * بلا DOM وبلا شبكة: التصنيفات والتحقق وبناء الفلاتر ومتطلبات الانتقال،
 * كما تفرضها migrations/146 (company_continuity_*). تُختبَر بمعزل
 * (tests/company-continuity-model.test.mjs).
 *
 * الحدود كما في القاعدة:
 *   • kind: follow_up و issue فقط — handover مرفوض بـ 0A000 (مؤجَّل).
 *   • team_id دائمًا null: الشركة بلا فرق صندوق.
 *   • sources غير مدعومة في نطاق الشركة: الإنشاء بلا مصادر.
 *   • patch keys المسموحة فقط: title, summary, next_action, problem,
 *     known_facts, unknowns, resolution_criteria, priority, due, category.
 */

/** التصنيفات التسعة الثابتة في القاعدة (146). */
export const CONTINUITY_CATEGORIES = Object.freeze([
    { value: 'order_status', label: 'حالة طلب' },
    { value: 'order_problem', label: 'مشكلة في طلب' },
    { value: 'general_inquiry', label: 'استفسار عام' },
    { value: 'return_exchange', label: 'إرجاع أو استبدال' },
    { value: 'payment_billing', label: 'دفع وفوترة' },
    { value: 'product_service', label: 'منتج أو خدمة' },
    { value: 'technical_issue', label: 'مشكلة تقنية' },
    { value: 'complaint', label: 'شكوى' },
    { value: 'other', label: 'أخرى' }
]);

export const CONTINUITY_KINDS = Object.freeze([
    { value: 'follow_up', label: 'متابعة' },
    { value: 'issue', label: 'مشكلة' }
]);

/** الحالات كما تخزّنها القاعدة؛ المغلقة: resolved و cancelled. */
export const CONTINUITY_STATUSES = Object.freeze([
    { value: 'open', label: 'مفتوح' },
    { value: 'in_progress', label: 'قيد التنفيذ' },
    { value: 'waiting', label: 'بانتظار' },
    { value: 'scheduled', label: 'مجدول' },
    { value: 'resolved', label: 'تم حلّه' },
    { value: 'cancelled', label: 'ملغى' }
]);

export const CONTINUITY_ACTIVE_STATUSES = Object.freeze(['open', 'in_progress', 'waiting', 'scheduled']);
export const CONTINUITY_CLOSED_STATUSES = Object.freeze(['resolved', 'cancelled']);

const labelOf = (list, value, fallback = '—') =>
    list.find(x => x.value === value)?.label || fallback;

export const continuityKindLabel = (kind) => labelOf(CONTINUITY_KINDS, kind);
export const continuityStatusLabel = (status) => labelOf(CONTINUITY_STATUSES, status);
export const continuityCategoryLabel = (category) =>
    category == null ? 'بلا تصنيف' : labelOf(CONTINUITY_CATEGORIES, category, category);

export const isContinuityClosed = (status) => CONTINUITY_CLOSED_STATUSES.includes(status);

/** أولوية 1–4 كما في القاعدة (1 الأعلى). */
export const CONTINUITY_PRIORITY_LABELS = Object.freeze({ 1: 'عاجلة', 2: 'مرتفعة', 3: 'عادية', 4: 'منخفضة' });
export const continuityPriorityLabel = (p) => CONTINUITY_PRIORITY_LABELS[p] || '—';

/**
 * فلاتر القائمة كما يقبلها company_continuity_list(p_filters):
 * مفاتيح فارغة تُسقَط (null تعني «بلا قيد» في القاعدة). limit يُقصّ 1–100.
 */
export function continuityListFilters({ status = null, kind = null, owner = null, category = null,
                                        limit = 50, before = null, beforeId = null } = {}) {
    const filters = {};
    const rawLimit = Number(limit);
    filters.limit = Math.max(1, Math.min(100, Number.isFinite(rawLimit) ? rawLimit : 50));
    if (status) filters.status = status;
    if (kind) filters.kind = kind;
    if (owner) filters.owner = owner;
    if (category) filters.category = category;
    if (before) filters.before = before;
    if (beforeId) filters.before_id = beforeId;
    return filters;
}

/**
 * تحقق العميل قبل الإنشاء — مرآة قواعد القاعدة لا بديل عنها:
 * follow_up مع next_action يتطلب due، و issue تتطلب problem.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateContinuityCreate({ kind, title, nextAction, dueAt, problem } = {}) {
    const t = String(title || '').trim();
    if (t.length < 1 || t.length > 160) return { ok: false, error: 'العنوان من حرف إلى 160 حرفًا' };
    if (kind === 'follow_up') {
        if (!String(nextAction || '').trim()) return { ok: false, error: 'المتابعة تحتاج خطوة تالية مكتوبة' };
        if (!dueAt) return { ok: false, error: 'المتابعة تحتاج موعدًا للخطوة التالية' };
    }
    if (kind === 'issue') {
        if (!String(problem || '').trim()) return { ok: false, error: 'المشكلة تحتاج وصفًا للمشكلة' };
    }
    if (kind !== 'follow_up' && kind !== 'issue') return { ok: false, error: 'نوع السجل غير معروف' };
    return { ok: true };
}

/** ملاحظة: 1–2000 حرف كما في company_continuity_note_add. */
export function validateContinuityNote(body) {
    const b = String(body || '').trim();
    if (b.length < 1) return { ok: false, error: 'اكتب الملاحظة أولًا' };
    if (b.length > 2000) return { ok: false, error: 'الملاحظة أطول من 2000 حرف' };
    return { ok: true, body: b };
}

/**
 * ما يتطلبه كل انتقال من details — كما في company_continuity_transition:
 * resolved ← resolution_note، cancelled ← cancel_reason، open من مغلق ←
 * reason، waiting ← waiting_on. ready_for_handover مرفوض في القاعدة (0A000).
 * @returns {{ field: string, label: string } | null}
 */
export function continuityTransitionRequirement(to, fromStatus) {
    if (to === 'resolved') return { field: 'resolution_note', label: 'ملاحظة الحل' };
    if (to === 'cancelled') return { field: 'cancel_reason', label: 'سبب الإلغاء' };
    if (to === 'waiting') return { field: 'waiting_on', label: 'بانتظار ماذا؟' };
    if (to === 'open' && isContinuityClosed(fromStatus)) return { field: 'reason', label: 'سبب إعادة الفتح' };
    return null;
}

/** الانتقالات المعروضة لسجل بحالته الحالية (بلا handover المؤجَّل). */
export function continuityAvailableTransitions(status) {
    if (isContinuityClosed(status)) return [{ to: 'open', label: 'إعادة فتح' }];
    const out = [];
    if (status !== 'in_progress') out.push({ to: 'in_progress', label: 'بدء التنفيذ' });
    if (status !== 'waiting') out.push({ to: 'waiting', label: 'بانتظار' });
    if (status !== 'scheduled') out.push({ to: 'scheduled', label: 'جدولة' });
    out.push({ to: 'resolved', label: 'حلّ السجل' });
    out.push({ to: 'cancelled', label: 'إلغاء السجل' });
    return out;
}

/**
 * عرض موحّد لصف قائمة أو سجل كامل: team_id دائمًا null و source_count
 * دائمًا 0 في نطاق الشركة — يُثبَّتان هنا لا يُستنتجان.
 */
export function continuityRecordView(record) {
    if (!record) return null;
    return {
        id: record.id,
        kind: record.kind,
        kindLabel: continuityKindLabel(record.kind),
        title: record.title || '—',
        summary: record.summary || '',
        status: record.status,
        statusLabel: continuityStatusLabel(record.status),
        closed: isContinuityClosed(record.status),
        priority: record.priority ?? 3,
        priorityLabel: continuityPriorityLabel(record.priority ?? 3),
        category: record.category || null,
        categoryLabel: continuityCategoryLabel(record.category),
        ownerId: record.owner_id || null,
        teamId: null,
        dueAt: record.due_at || null,
        dueTz: record.due_tz || null,
        nextAction: record.next_action || '',
        overdue: record.overdue === true,
        version: record.version ?? 0,
        updatedAt: record.updated_at || null,
        closedAt: record.closed_at || null,
        sourceCount: 0,
        problem: record.problem || '',
        knownFacts: record.known_facts || '',
        unknowns: record.unknowns || '',
        resolutionCriteria: record.resolution_criteria || ''
    };
}

/** مفتاح تكرار جديد لكل إنشاء (إعادة الإرسال بنفس المفتاح تعيد السجل نفسه). */
export function newIdempotencyKey() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `cont-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
