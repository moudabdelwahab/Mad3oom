/**
 * Relay — العقد المشترك (المرحلة B، الإصدار 1).
 *
 * وحدة نقية بلا DOM ولا شبكة: حدود الحقول والقيم المسموحة، بناء طلب الإنشاء
 * القانوني (§10.3)، تحقق مبدئي للواجهة، وترجمة أخطاء الخادم.
 *
 * **استشاري فقط.** الخادم (migrations/073_relay_core.sql) يعيد التحقق من كل شيء
 * ويشتق كل ما يخص الدليل الداخلي (نص المقتطف، المرسل، المحادثة، المنشئ، المساحة).
 * لا تبنِ أي قرار صلاحية على هذه الوحدة، ولا تخزن المقتطفات في المتصفح
 * (لا localStorage ولا تخزين الإضافة).
 */

export const CONTRACT_VERSION = 1;

export const RECORD_KINDS = Object.freeze(['follow_up', 'issue', 'handover']);
/** المفعّل في المرحلة 1/B: handover يرجع feature_not_enabled حتى المرحلة D. */
export const ENABLED_KINDS = Object.freeze(['follow_up', 'issue']);

export const STATUSES = Object.freeze([
    'open', 'scheduled', 'in_progress', 'waiting', 'ready_for_handover', 'resolved', 'cancelled',
]);
export const ACTIVE_STATUSES = Object.freeze(['open', 'scheduled', 'in_progress', 'waiting']);
export const CLOSED_STATUSES = Object.freeze(['resolved', 'cancelled']);

export const SOURCE_TYPES = Object.freeze([
    'mad3oom_message', 'mad3oom_conversation', 'mad3oom_ticket', 'web_selection',
    'url', 'external_message', 'email', 'manual_note', 'integration',
]);
/** المرحلة B: رسائل صندوق المنصة فقط. */
export const ENABLED_SOURCE_TYPES = Object.freeze(['mad3oom_message']);

export const REDACTION_REASONS = Object.freeze(['retention', 'manual', 'data_subject_request']);
export const SENDER_LABELS = Object.freeze(['العميل', 'الدعم', 'البوت']);

export const LIMITS = Object.freeze({
    title: 160,
    summary: 4000,
    nextAction: 1000,
    issueField: 4000,
    resolutionNote: 4000,
    cancelReason: 1000,
    waitingOn: 1000,
    excerpt: 4000,
    sourcesPerRequest: 20,
    sourcesPerRecord: 100,
    requestBytes: 65536,
    dueMaxDaysAhead: 365,
    retentionDays: 365,
});

/** C5: 365 × 24 ساعة بالضبط من الإغلاق (لا أيام تقويمية). */
export const RETENTION_MS = LIMITS.retentionDays * 24 * 60 * 60 * 1000;

/** SQLSTATE → رمز العقد (§10.6). أي شيء غير معروف = unknown_error. */
export const ERROR_CODES = Object.freeze({
    '22023': 'validation_failed',
    P0002: 'not_found',
    '42501': 'forbidden',
    '40001': 'version_conflict',
    '23505': 'idempotency_conflict',
    '55000': 'invalid_transition',
    '0A000': 'feature_not_enabled',
});

const ERROR_MESSAGES = Object.freeze({
    validation_failed: 'في بيانات ناقصة أو غير صالحة.',
    not_found: 'السجل غير موجود أو مش مسموح لك تشوفه.',
    forbidden: 'مش مسموح لك تعمل ده.',
    version_conflict: 'حد عدّل السجل قبلك. حدّث الصفحة وحاول تاني.',
    idempotency_conflict: 'الطلب ده اتبعت قبل كده ببيانات مختلفة.',
    invalid_transition: 'الحالة دي مش مسموحة من الحالة الحالية.',
    feature_not_enabled: 'الميزة دي مش متاحة حاليًا.',
    unknown_error: 'حصل خطأ غير متوقع.',
});

const HIDDEN_MESSAGES = Object.freeze({
    no_conversation_access: 'محتوى من محادثة لا تملك صلاحية الوصول إليها',
    no_provider_rule: 'محتوى من مصدر غير مدعوم بعد',
});

/**
 * يحوّل خطأ supabase-js/PostgREST ({ code, message, details }) لشكل ثابت.
 * لا يعيد نص الخادم كما هو للمستخدم (رسائل عربية ثابتة)، والتفاصيل بتتقرا كـ JSON
 * للحقل والسبب فقط.
 */
export function mapRelayError(error) {
    const code = ERROR_CODES[error?.code] ?? 'unknown_error';
    let detail = null;
    try {
        detail = error?.details ? JSON.parse(error.details) : null;
    } catch {
        detail = null;
    }
    return {
        code,
        field: typeof detail?.field === 'string' ? detail.field : null,
        reason: typeof detail?.reason === 'string' ? detail.reason : null,
        kinds: Array.isArray(detail?.kinds) ? detail.kinds.filter((k) => typeof k === 'string') : [],
        currentVersion: Number.isInteger(detail?.current_version) ? detail.current_version : null,
        message: ERROR_MESSAGES[code],
    };
}

/** نسخة استشارية من فحص M1 على الخادم (_relay_sensitive_kinds) لتنبيه المستخدم مبكرًا. */
export function sensitiveKinds(text) {
    const v = String(text ?? '').replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
        .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
    const kinds = [];
    if (/(^|[^0-9])[23][0-9]{13}([^0-9]|$)/.test(v)) kinds.push('national_id');
    if (/(^|[^0-9])([0-9][ -]?){12,18}[0-9]([^0-9]|$)/.test(v)) kinds.push('card_number');
    if (/(otp|one[- ]time|verification|code|pin|كود|رمز|الرمز|التحقق)[^0-9]{0,25}[0-9]{4,8}([^0-9]|$)/i.test(v)) kinds.push('otp');
    if (/(password|passwd|pwd|passcode|باسورد|الباسورد|كلمة ?(ال)?سر|كلمة ?المرور)\s*(:|=|هي|is)\s*\S+/i.test(v)) kinds.push('password');
    return kinds;
}

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

/**
 * يبني طلب الإنشاء القانوني. مصادر Mad3oom = معرّف الرسالة فقط: الخادم يملأ
 * النص والمرسل والوقت والمحادثة من قاعدة البيانات (§8.4). العنوان والملخص لا
 * يُملآن أبدًا من نص الرسالة (M5).
 */
export function buildCreateRequest({
    idempotencyKey, kind, title, summary = null, nextAction = null, priority = 3,
    ownerId = null, teamId = null, due = null, issue = null, messageIds = [], sensitiveAck = false,
}) {
    const request = {
        contract_version: CONTRACT_VERSION,
        idempotency_key: idempotencyKey,
        kind,
        title: typeof title === 'string' ? title.trim() : title,
        summary,
        next_action: nextAction,
        priority,
        owner_id: ownerId,
        team_id: teamId,
        due: due ? { at: due.at, tz: due.tz } : null,
        issue,
        sources: [...new Set(messageIds)].map((id) => ({
            type: 'mad3oom_message',
            provider: 'mad3oom',
            adapter: 'mad3oom-inbox',
            adapter_version: '1',
            internal: { chat_message_id: id },
        })),
    };
    if (sensitiveAck) request.sensitive_ack = true;
    return request;
}

const tooLong = (v, n) => typeof v === 'string' && [...v].length > n;

/** تحقق مبدئي للواجهة. يرجع قائمة { field, reason }؛ فاضية = يبان سليم (والخادم يقرر). */
export function validateCreateRequest(request, { now = new Date() } = {}) {
    const errors = [];
    const add = (field, reason) => errors.push({ field, reason });
    if (request?.contract_version !== CONTRACT_VERSION) add('contract_version', 'unsupported');
    if (typeof request?.idempotency_key !== 'string' || !/^[0-9a-f-]{36}$/i.test(request.idempotency_key)) {
        add('idempotency_key', 'required');
    }
    if (!RECORD_KINDS.includes(request?.kind)) add('kind', 'invalid');
    else if (!ENABLED_KINDS.includes(request.kind)) add('kind', 'feature_not_enabled');
    const title = typeof request?.title === 'string' ? request.title.trim() : '';
    if (!title || tooLong(title, LIMITS.title)) add('title', 'length');
    if (tooLong(request?.summary, LIMITS.summary)) add('summary', 'length');
    if (tooLong(request?.next_action, LIMITS.nextAction)) add('next_action', 'length');
    if (!Number.isInteger(request?.priority ?? 3) || (request?.priority ?? 3) < 1 || (request?.priority ?? 3) > 4) {
        add('priority', 'range');
    }
    const due = request?.due;
    if (due) {
        if (!due.at || !due.tz) add('due', 'at_and_tz_required');
        else if (!LOCAL_TIME.test(due.at)) add('due.at', 'local_time_expected');
        else {
            const approx = Date.parse(`${due.at}Z`);
            if (approx > now.getTime() + (LIMITS.dueMaxDaysAhead + 1) * 86400000) add('due.at', 'too_far');
        }
    }
    if (request?.kind === 'follow_up' && (!request?.next_action?.trim?.() || !due)) {
        add('follow_up', 'next_action_and_due_required');
    }
    if (request?.kind === 'issue' && !(request?.issue?.problem || request?.summary)) add('issue.problem', 'required');
    const sources = request?.sources ?? [];
    if (!Array.isArray(sources)) add('sources', 'invalid');
    else {
        if (sources.length > LIMITS.sourcesPerRequest) add('sources', 'too_many');
        for (const s of sources) {
            if (!ENABLED_SOURCE_TYPES.includes(s?.type)) add('sources.type', 'feature_not_enabled');
            else if (!s?.internal?.chat_message_id) add('sources.internal.chat_message_id', 'required');
        }
    }
    if (new TextEncoder().encode(JSON.stringify(request ?? {})).length > LIMITS.requestBytes) add('request', 'too_large');
    return errors;
}

/**
 * يصنّف مصدرًا كما رجع من relay_get للعرض. لا يملك أي منطق صلاحية: يقرأ فقط
 * ما قرره الخادم في هذه القراءة.
 */
export function describeSource(source) {
    if (source?.excerpt_hidden) {
        return { state: 'hidden', label: HIDDEN_MESSAGES[source.excerpt_hidden] ?? HIDDEN_MESSAGES.no_conversation_access };
    }
    if (source?.redacted) return { state: 'redacted', label: 'تم حذف المحتوى', reason: source.redacted.reason ?? null };
    if (source?.retention_expired) return { state: 'retention_expired', label: 'انتهت مدة الاحتفاظ بالمحتوى' };
    if (typeof source?.excerpt === 'string') {
        return {
            state: 'visible',
            excerpt: source.excerpt,
            senderLabel: source.sender_label ?? null,
            deletedAtSource: Boolean(source.source_deleted),
            editedAfterCapture: Boolean(source.edited_after_capture),
        };
    }
    return { state: 'hidden', label: HIDDEN_MESSAGES.no_conversation_access };
}

/** C5: موعد الحجب لسجل مغلق (null للسجل النشط). للعرض فقط؛ الخادم يحجب بنفسه. */
export function retentionDeadline(closedAt) {
    if (!closedAt) return null;
    const t = Date.parse(closedAt);
    return Number.isNaN(t) ? null : new Date(t + RETENTION_MS);
}
