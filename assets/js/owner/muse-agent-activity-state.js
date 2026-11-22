/**
 * muse-agent-activity-state.js — منطق خالص مشترك بين صفحتي الوكيل الداخلي
 * في لوحة المالك: سجل نشاط الوكيل (owner/muse-activity-log.html) وصفحة
 * تفعيل الوكيل لحسابات تانية (owner/muse-activations.html).
 *
 * لا نداءات شبكة هنا ولا قراءة DOM — دوال خالصة تُختبر في
 * tests/muse-agent-activity.test.mjs. صفحتا العرض تستوردان منها التسميات
 * وبناء الحمولات فقط؛ القرار في القاعدة (RLS)، وهذه الدوال تعرض ما وصل
 * فعلًا ولا تخترع شيئًا.
 *
 * السجل: agent_activity_log للقراءة وحدها من الصفحة — كل صف يُرسم كما
 * سُجّل، وبلا صفوف مخترعة. التفعيل: muse_account_activations سجل واحد
 * لكل مالك (owner_id فريد)؛ غياب السجل = غير مفعّل، والتفعيل لا يحدث
 * إلا بمبدّل الصفحة الصريح.
 */
export const LOG_COLUMNS = 'id, action, details, session_id, model_id, created_at';
export const ACTIVATION_COLUMNS = 'id, owner_id, email, active, activated_at, activated_by, created_at, updated_at';
export const LOG_PAGE_SIZE = 50;
export const ACCOUNTS_PAGE_SIZE = 50;

/** تسميات أحداث السجل المعروفة — غير المعروف يُعرض بنصه كما سُجّل. */
export const ACTION_LABELS = {
    muse_trial_setup: 'إعداد تجربة الوكيل',
    session_started: 'بدء جلسة',
    reply_sent: 'إرسال رد',
    draft_created: 'إنشاء مسودة رد',
    page_built: 'بناء صفحة',
    quota_checked: 'فحص الكوتة',
    muse_activation_changed: 'تغيير تفعيل حساب',
    bridge_run: 'تشغيل الجسر',
    briefing_sent: 'إرسال الإحاطة الصباحية',
};

export const MODEL_LABELS = {
    muse: 'Muse',
    'muse-assistant': 'المساعد العام',
};

export function actionLabel(action) {
    return ACTION_LABELS[action] || action || '—';
}

export function modelLabel(modelId) {
    return MODEL_LABELS[modelId] || modelId || '—';
}

/** معرّف مختصر للعرض (أول 8 أحرف) — لا معرّف كامل في الجدول. */
export function shortId(id) {
    return id ? String(id).slice(0, 8) : '—';
}

/** تفاصيل الصف نصًا: JSON منسّق كما سُجّل، أو «—» عند الفراغ. */
export function formatDetails(details) {
    if (!details) return '—';
    if (typeof details === 'string') return details || '—';
    const keys = Object.keys(details);
    if (!keys.length) return '—';
    return JSON.stringify(details, null, 2);
}

/**
 * خريطة التفعيل من صفوف muse_account_activations: owner_id ← الصف.
 * صف واحد لكل مالك (owner_id فريد في القاعدة)، فلا تعارض.
 */
export function buildActivationMap(rows) {
    const map = new Map();
    for (const row of rows || []) {
        if (row && row.owner_id) map.set(row.owner_id, row);
    }
    return map;
}

/** هل الحساب مفعّل؟ غياب السجل = غير مفعّل — لا افتراض تفعيل أبدًا. */
export function isAccountActive(map, ownerId) {
    return Boolean(map?.get(ownerId)?.active);
}

/** ملخص العدادات في ترويسة صفحة التفعيل — من الصفوف المقروءة فعلًا. */
export function activationSummary(accounts, map) {
    const total = accounts.length;
    const active = accounts.filter(a => isAccountActive(map, a.id)).length;
    return { total, active, inactive: total - active };
}

/**
 * حمولة المبدّل عند التفعيل: upsert بالسجل الكامل (onConflict owner_id).
 * activated_at لحظة التفعيل، وactivated_by هو المالك الذي ضغط المبدّل.
 */
export function activationUpsertPayload({ owner, byUserId, now = new Date().toISOString() }) {
    return {
        owner_id: owner.id,
        email: owner.email,
        active: true,
        activated_at: now,
        activated_by: byUserId,
        updated_at: now,
    };
}

/** حمولة المبدّل عند الإيقاف: تحديث السجل الموجود — لا حذف للسجل أبدًا. */
export function activationDeactivatePayload({ byUserId, now = new Date().toISOString() }) {
    return {
        active: false,
        activated_at: null,
        activated_by: byUserId,
        updated_at: now,
    };
}

/**
 * صف السجل الذي يكتبه تغيير التفعيل: فعل حقيقي حدث فعلًا بمبدّل الصفحة.
 * الكتابة best-effort من صفحة التفعيل — فشلها لا يلغي التفعيل نفسه.
 */
export function logRowForToggle({ owner, active, byUserId }) {
    return {
        action: 'muse_activation_changed',
        details: { owner_id: owner.id, email: owner.email, active, changed_by: byUserId },
        session_id: null,
        model_id: 'muse',
    };
}

/**
 * حالة المبدّل بعد فشل الكتابة: يعود إلى ما كان عليه قبل الضغطة،
 * فلا يعرض المبدّل حالة لم تحدث في القاعدة.
 */
export function revertToggleState(wasActive) {
    return wasActive;
}
