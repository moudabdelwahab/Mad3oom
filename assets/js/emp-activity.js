/**
 * emp-activity.js — جسر تتبّع نشاط موظفي مدعوم (emp_ops) داخل المنصة.
 * ─────────────────────────────────────────────────────────────────
 * نظام الحضور والنشاط الداخلي (مستودع emp-mad3oom) يعيش في نفس مشروع
 * Supabase ونفس الـ Auth، وملف الـ SDK بتاعه منسوخ أصلًا في
 * `sdk/mad3oom-activity-client.js` — لكنه لم يكن موصولًا بأي صفحة.
 * هذا الملف هو نقطة التوصيل الوحيدة: يهيّئ الـ SDK مرة واحدة بعميل
 * Supabase الموجود أصلًا، ويمرّر أحداث العمل الحقيقية (ردّ، تغيير حالة،
 * إسناد، فتح تذكرة، ردّ شات) إلى `eo_ingest_activity`.
 *
 * قواعد أمان الجسر (لا تُكسَر):
 * - التهيئة في صفحات فريق المنصة فقط (إدارة/مالك)، بعد نجاح المصادقة —
 *   لا تُستدعَ من صفحات العملاء أو الشركات. وعلى أي صفحة أخرى يبقى
 *   `trackEmpActivity` بلا أثر لأنه لا يوجد مثيل مهيّأ.
 * - لا يرمي أي استثناء أبدًا: فشل التهيئة أو التتبّع لا يوقف الصفحة
 *   ولا الإجراء الأساسي (الردّ، تغيير الحالة، …) — best-effort فقط.
 * - لا يقرأ محتوى التذاكر أو الردود ولا أي حرف يُكتب؛ الـ SDK نفسه
 *   يعدّ التفاعلات عدًّا فقط، والخادم لا يحتسب أي وقت بلا شيفت مفتوح
 *   وتبويب ظاهر وعليه تركيز (انظر `eo_ingest_activity`).
 * - بلا أي import ثابت: كل الاستيرادات ديناميكية داخل `initEmpActivity`
 *   وفي المتصفح فقط، فيبقى الملف آمن الاستيراد في Node والاختبارات.
 */

const SDK_PATH = '/sdk/mad3oom-activity-client.js';
const API_CONFIG_PATH = '/api-config.js';

let _instance = null;
let _starting = null;

/** هل نحن في متصفح (الـ SDK يحتاج document وBroadcastChannel)؟ */
export function isEmpActivitySupported() {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function resolveClient(mod) {
    if (!mod) return null;
    return mod.Mad3oomActivity || mod.default || mod;
}

/**
 * تهيئة تتبّع النشاط مرة واحدة لكل صفحة (آمنة للتكرار والتزامن).
 * @param {object} [deps]
 * @param {object} [deps.supabase] عميل Supabase — يُمرَّر من الصفحة إن كان
 *   مستوردًا أصلًا، وإلا يُستورَد ديناميكيًا من `api-config.js`.
 * @param {object} [deps.activityClient] وحدة الـ SDK — للحقن في الاختبارات
 *   فقط؛ في المتصفح تُستورَد من `sdk/mad3oom-activity-client.js`.
 * @returns {Promise<object|null>} مثيل الـ SDK، أو null خارج المتصفح أو عند الفشل.
 */
export async function initEmpActivity(deps = {}) {
    if (_instance) return _instance;
    if (_starting) return _starting;
    if (!isEmpActivitySupported()) return null;

    // ملاحظة: لا تُصفَّر `_starting` في finally داخل الـ IIFE — لو اكتملت
    // الـ IIFE متزامنةً (اعتماديات محقونة تفشل فورًا) لكان الإسناد الخارجي
    // `_starting = promise` قد أعاد إحياء المؤشر بعد تصفيره، فتتعطّل أي
    // إعادة محاولة للأبد. التصفير هنا يكون بعد الإسناد، عند الاستقرار.
    const starting = (async () => {
        try {
            const supabase = deps.supabase
                || (await import(API_CONFIG_PATH)).supabase;
            const sdkModule = deps.activityClient
                || await import(SDK_PATH);
            const client = resolveClient(sdkModule);
            if (!client || typeof client.init !== 'function') return null;
            if (!supabase || typeof supabase.rpc !== 'function') return null;
            _instance = client.init({ supabase });
            return _instance;
        } catch (err) {
            console.warn('[emp-activity] تعذّرت تهيئة تتبّع النشاط:', err?.message || err);
            return null;
        }
    })();
    _starting = starting;
    starting.finally(() => { if (_starting === starting) _starting = null; });
    return starting;
}

/**
 * تسجيل حدث عمل حقيقي — بلا أثر إن لم تكن التهيئة قد تمت (صفحات غير
 * صفحات الفريق)، وبلا أي استثناء مهما حدث.
 * @param {string} type نوع من كتالوج `emp_ops.activity_types`
 *   (ticket_open · ticket_reply · ticket_status · ticket_assign · chat_reply …)
 * @param {object} [opts] { entityType, entityId, metadata }
 */
export function trackEmpActivity(type, opts) {
    if (!type || !_instance) return;
    try {
        _instance.track(type, opts);
    } catch {
        /* التتبّع ثانوي — لا يكسر الإجراء الأساسي أبدًا. */
    }
}

/** هل للموظف شيفت مفتوح الآن؟ null قبل أول نبضة أو بلا تهيئة. */
export function isEmpActivityOnShift() {
    try {
        return _instance ? _instance.isOnShift : null;
    } catch {
        return null;
    }
}

/** إيقاف التتبّع (تسجيل خروج أو إغلاق) — بلا أثر إن لم يكن مهيّأً. */
export function stopEmpActivity() {
    if (!_instance) return;
    try {
        _instance.stop();
    } catch {
        /* تجاهل — الإيقاف ثانوي. */
    } finally {
        _instance = null;
    }
}

/** إعادة ضبط الحالة الداخلية — للاختبارات فقط. */
export function resetEmpActivityState() {
    _instance = null;
    _starting = null;
}
