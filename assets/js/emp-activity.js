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

// تنبيه الخمول مرة كل ١٠ دقائق كحدّ أقصى — لا إزعاج مع كل نبضة.
const IDLE_TOAST_MIN_MS = 10 * 60 * 1000;

let _instance = null;
let _starting = null;
let _expectEmployee = false;   // صفحة موظفين يُفترض أن حسابه مربوط بملف موظف
let _authWarned = false;       // تحذير الربط مرة واحدة لكل تحميل صفحة
let _lastIdleToastAt = 0;
let _breakBanner = null;

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
 * @param {boolean} [deps.expectEmployee] صفحة موظفين (إدارة/مالك): الحساب
 *   يُفترض أن يكون مربوطًا بملف موظف، فيُحذَّر عند الرفض الصامت (EO403).
 *   صفحات العميل والشركة لا تمرّرها — موظفو الشركات ليسوا موظفي المنصة.
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
            _expectEmployee = deps.expectEmployee === true;
            _instance = client.init({ supabase, onStatus: handleEmpStatus });
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
 * معالجة حالة النبضة الواردة من الـ SDK — تنبيهات الموظف فقط، لا تتبّع.
 * لا ترمي أبدًا: أي فشل هنا يُبتلَع حتى لا يمسّ الصفحة.
 *  - auth_failed: الحساب مرفوض صامتًا (بلا ملف موظف غالبًا) — تحذير مرة
 *    واحدة لكل تحميل صفحة، وفقط في صفحات الموظفين (expectEmployee).
 *  - استراحة: لافتة قابلة للإغلاق تظهر ما دام في استراحة.
 *  - خمول: تنبيه مخنوق (مرة كل ١٠ دقائق كحدّ أقصى).
 */
function handleEmpStatus(res) {
    try {
        if (!res || typeof res !== 'object') return;
        if (res.status === 'auth_failed') {
            if (_expectEmployee && !_authWarned) {
                _authWarned = true;
                showEmpToast('حسابك غير مربوط بملف موظف — تواصل مع الإدارة لربط حسابك حتى يُحتسب نشاطك.', 'warning');
            }
            return;
        }
        if (res.presence === 'break' || res.on_break === true) {
            showBreakBanner();
        } else {
            hideBreakBanner();
        }
        if (res.presence === 'idle') {
            const now = Date.now();
            if (now - _lastIdleToastAt >= IDLE_TOAST_MIN_MS) {
                _lastIdleToastAt = now;
                showEmpToast('أنت خامل منذ فترة — وقت النشاط متوقف، لكن وقت الحضور يستمر ما دام تبويب مدعوم ظاهرًا ومركّزًا.', 'info');
            }
        }
    } catch {
        /* التنبيه ثانوي — لا يكسر شيئًا. */
    }
}

/** جذر التنبيهات — يُنشأ عند الحاجة فقط، ويُتجاهل بلا DOM حقيقي. */
function empToastRoot() {
    try {
        if (typeof document === 'undefined' || !document.body || typeof document.createElement !== 'function') return null;
        let root = typeof document.getElementById === 'function'
            ? document.getElementById('emp-activity-toasts') : null;
        if (!root) {
            root = document.createElement('div');
            root.id = 'emp-activity-toasts';
            root.setAttribute('dir', 'rtl');
            root.style.cssText = 'position:fixed;bottom:16px;inset-inline-end:16px;z-index:9999;display:flex;flex-direction:column;gap:8px;max-width:min(92vw,380px);';
            document.body.appendChild(root);
        }
        return root;
    } catch { return null; }
}

function showEmpToast(message, kind) {
    try {
        const root = empToastRoot();
        if (!root) return;
        const toast = document.createElement('div');
        toast.style.cssText = 'background:#1f2937;color:#fff;border-radius:10px;padding:10px 14px;font-size:14px;line-height:1.6;box-shadow:0 4px 16px rgba(0,0,0,.25);cursor:pointer;'
            + (kind === 'warning' ? 'border-inline-start:4px solid #f59e0b;' : 'border-inline-start:4px solid #38bdf8;');
        toast.textContent = message;
        toast.addEventListener('click', () => { try { toast.remove(); } catch {} });
        root.appendChild(toast);
        setTimeout(() => { try { toast.remove(); } catch {} }, 9000);
    } catch { /* تجاهل — التنبيه ثانوي. */ }
}

function showBreakBanner() {
    try {
        if (_breakBanner) return;
        if (typeof document === 'undefined' || !document.body || typeof document.createElement !== 'function') return;
        const banner = document.createElement('div');
        banner.id = 'emp-activity-break-banner';
        banner.setAttribute('dir', 'rtl');
        banner.style.cssText = 'position:fixed;top:0;inset-inline:0;z-index:9999;background:#fef3c7;color:#78350f;padding:10px 16px;font-size:14px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.15);';
        const text = document.createElement('span');
        text.textContent = 'أنت في استراحة — لا يُحتسب وقت نشاط الآن.';
        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = '✕';
        close.setAttribute('aria-label', 'إغلاق');
        close.style.cssText = 'margin-inline-start:12px;background:transparent;border:0;cursor:pointer;font-size:14px;color:inherit;';
        close.addEventListener('click', hideBreakBanner);
        banner.appendChild(text);
        banner.appendChild(close);
        document.body.appendChild(banner);
        _breakBanner = banner;
    } catch { /* تجاهل — التنبيه ثانوي. */ }
}

function hideBreakBanner() {
    try {
        if (!_breakBanner) return;
        _breakBanner.remove();
    } catch { /* تجاهل */ } finally { _breakBanner = null; }
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
    _expectEmployee = false;
    _authWarned = false;
    _lastIdleToastAt = 0;
    hideBreakBanner();
}
