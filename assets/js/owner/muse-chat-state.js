/**
 * muse-chat-state.js — منطق نقي بلا DOM وبلا Supabase لصفحة شات Muse
 * (owner/muse-chat.html).
 *
 * الصفحة نفسها في assets/js/owner/pages/muse-chat.js؛ هذا الملف يحمل الثوابت
 * ودمج الرسائل فقط، حتى تُختبَر بلا متصفح وبلا قاعدة (نفس نمط
 * assets/js/admin/agent-connection-state.js).
 *
 * لا يوجد هنا أي نداء شبكة ولا أي حالة «متصل»: الرد يصل عبر الجسر
 * الدائم الذي يفحص الجلسة كل 15 ثانية، والصفحة تستطلع الرسائل
 * الجديدة كل POLL_MS.
 */

/** موديل جلسة Muse الداخلية — نفس القيمة في ai_sessions.model_id. */
export const MUSE_MODEL_ID = 'muse';

/** عنوان الجلسة عند إنشائها لأول مرة — نفس عنوان الجلسة التجريبية الحالية. */
export const MUSE_SESSION_TITLE = 'Muse — وكيل داخلي';

/**
 * التوجيه الذي يُحفظ مع أي جلسة جديدة. نص حرفي من الجلسة التجريبية الحالية
 * (ai_sessions 79967908-6004-40cd-8939-dda2b4a5d250) حتى لا تنشأ جلسة
 * بسلوك مختلف.
 */
export const MUSE_SYSTEM_PROMPT = 'أنت Muse، وكيل ذكاء اصطناعي داخلي في منصة Mad3oom. تتكلم مع مالك المنصة محمود (mahmoud@mad3oom.com) فقط، بالعربية. تنفذ طلباته على المنصة عبر أدوات Mad3oom (تذاكر، عملاء، واتساب، اشتراكات، إشعارات) وقراءة قاعدة البيانات. لا تلمس SIE ولا شات العملاء أبدا. لا ترسل واتساب ولا تنشئ تذاكر ولا تغير بيانات إلا بطلب صريح منه في الرسالة. لو الطلب غامض، اسأل قبل ما تنفذ.';

/** رسالة الترحيب التي تُحفظ مع أي جلسة جديدة — نفس ترحيب الجلسة الحالية. */
export const MUSE_GREETING = 'أهلا محمود، أنا Muse، وكيلك الداخلي في مدعوم. دي جلسة تجريبية على حسابك بس، وبرد عليك هنا في أقل من دقيقة عادةً. أقدر أعرض التذاكر والعملاء والاشتراكات، وأنفذ اللي تطلبه مني. جرّب تسألني عن التذاكر المفتوحة.';

/* ─────────────────── الوكلاء: Muse + الوكلاء الفرعيون ─────────────────── */

/**
 * وكلاء الشات الداخلي. كل وكيل له model_id خاص به — جلساته في ai_sessions
 * تحمل model_id نفسه، فيظهر في قائمة الجلسات نفسها بعلامة تميّزه.
 *
 * الوكيل الرئيسي يعيد استخدام توجيه الجلسة التجريبية حرفيًا. الوكيل
 * المساعد العام (muse-assistant) غير مقيّد بتخصص — طلب محمود الصريح:
 * مساعد عام بصلاحيات Muse نفسها، لا متخصص ضيق؛ توجيهه عام بنفس قواعد
 * الحماية (العربية، محمود فقط، لا SIE ولا شات عملاء، لا تغيير بيانات
 * إلا بطلب صريح)، وطلبات برمجة الصفحات تُمرَّر للوكيل الرئيسي ولا تُبنى
 * من داخل جلسة المساعد. التوجيه يُستخدم عند إنشاء الجلسة فقط؛ جلسة
 * موجودة للوكيل تُستخدم كما هي.
 */
export const MUSE_AGENTS = [
    {
        modelId: 'muse',
        label: 'Muse — الوكيل الداخلي',
        shortLabel: 'Muse',
        specialty: null,
        systemPrompt: MUSE_SYSTEM_PROMPT,
        greeting: MUSE_GREETING,
    },
    {
        modelId: 'muse-assistant',
        label: 'Muse Assistant — مساعد عام',
        shortLabel: 'المساعد العام',
        specialty: 'مساعد عام',
        systemPrompt: 'أنت Muse Assistant، وكيل ذكاء اصطناعي داخلي عام في منصة Mad3oom — مساعد Muse بلا تخصص مقيّد. تتكلم مع مالك المنصة محمود (mahmoud@mad3oom.com) فقط، بالعربية. تنفذ طلباته على المنصة عبر أدوات Mad3oom (تذاكر، عملاء، واتساب، اشتراكات، إشعارات) وقراءة قاعدة البيانات. لا تلمس SIE ولا شات العملاء أبدا. لا ترسل واتساب ولا تنشئ تذاكر ولا تغير بيانات إلا بطلب صريح منه في الرسالة. طلبات برمجة صفحات جديدة تُمرَّر للوكيل الرئيسي ولا تُبنى من داخل هذه الجلسة. لو الطلب غامض، اسأل قبل ما تنفذ.',
        greeting: 'أهلا محمود، أنا Muse Assistant، مساعدك العام في مدعوم. أقدر أساعدك في التذاكر والعملاء والاشتراكات وأي طلب عام، وطلبات برمجة الصفحات بمرّرها للوكيل الرئيسي. جرّب تسألني عن التذاكر المفتوحة.',
    },
];

/** وكيل من model_id — غير المعروف يرجع للوكيل الرئيسي، لا ينهار. */
export function agentForModelId(modelId) {
    return MUSE_AGENTS.find((a) => a.modelId === modelId) || MUSE_AGENTS[0];
}

/** كل model_id التي تظهر في قائمة الجلسات — الرئيسي والفرعيون فقط. */
export function agentModelIds() {
    return MUSE_AGENTS.map((a) => a.modelId);
}

/* ─────────────────── الجلسات: ترتيب واختيار وعناوين ─────────────────── */

/** مفتاح localStorage: معرّفات الجلسات التي أعاد المستخدم تسميتها يدويًا. */
export const RENAMED_SESSIONS_KEY = 'muse-chat-renamed-sessions';

/** مفتاح localStorage: الجلسة النشطة الأخيرة حتى تبقى بعد إعادة التحميل. */
export const ACTIVE_SESSION_KEY = 'muse-chat-active-session';

/** ترتيب الجلسات: الأحدث نشاطًا أولًا، وcreated_at بديلًا عند غياب النشاط. */
export function sortSessions(sessions) {
    return [...(sessions || [])].sort((a, b) =>
        new Date(b.last_active_at || b.created_at || 0)
        - new Date(a.last_active_at || a.created_at || 0));
}

/**
 * الجلسة التي تُفتح عند التحميل: المفضلة المحفوظة إن كانت في القائمة،
 * وإلا الأحدث نشاطًا، وإلا null — فينشئ المتصفح جلسة جديدة.
 */
export function pickActiveSession(sessions, preferredId) {
    const sorted = sortSessions(sessions);
    if (preferredId) {
        const preferred = sorted.find((s) => s && s.id === preferredId);
        if (preferred) return preferred;
    }
    return sorted[0] || null;
}

/** أقصى طول لعنوان تلقائي من أول رسالة — يبقى العنوان سطرًا واحدًا قصيرًا. */
export const AUTO_TITLE_MAX = 40;

/**
 * عنوان تلقائي من أول رسالة للمستخدم: تطبيع المسافات وقصّ عند الحد مع «…».
 * فراغ أو نص فارغ يرجع '' فلا يُكتب عنوان فارغ.
 */
export function deriveTitle(text, max = AUTO_TITLE_MAX) {
    const clean = (text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    if (clean.length <= max) return clean;
    return `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** هل أعيدت تسمية الجلسة يدويًا؟ مجموعة المعرّفات المحفوظة هي المصدر. */
export function isRenamed(renamedIds, sessionId) {
    return !!(renamedIds && typeof renamedIds.has === 'function' && renamedIds.has(sessionId));
}

/** نسخة جديدة من المجموعة بعد إضافة جلسة أعيدت تسميتها — بلا تعديل للأصل. */
export function withRenamed(renamedIds, sessionId) {
    const next = new Set(renamedIds || []);
    next.add(sessionId);
    return next;
}

/** نسخة جديدة من المجموعة بعد إزالة جلسة — تُستخدم عند حذفها. */
export function withoutRenamed(renamedIds, sessionId) {
    const next = new Set(renamedIds || []);
    next.delete(sessionId);
    return next;
}

/**
 * هل يُسمح بالتسمية التلقائية لهذه الجلسة؟ فقط إن لم يُعد المستخدم
 * تسميتها يدويًا — فلا يكتب عنوان أول رسالة فوق عنوان اختاره هو.
 */
export function shouldAutoTitle(session, renamedIds) {
    return !!session && !isRenamed(renamedIds, session.id);
}

/** هل الجلسة بلا أي رسالة مستخدم بعد؟ عنوان أول رسالة يُكتب مرة واحدة فقط. */
export function hasUserMessage(messages) {
    return (messages || []).some((m) => m && m.role === 'user');
}

/* ─────────────────── الكوتة: تحليل لقطة extensions.quota وعرضها ─────────────────── */

/**
 * تحليل لقطة الكوتة إلى بنية عرض، ونصها في سطر واحد — من
 * ai_sessions.extensions.quota فقط، بالشكل الذي يدمجه الجسر:
 * {plan, used, remaining, reset, updated_at}. الصيغتان الحيّتان
 * مقبولتان: النسب تُستخرج من "51%" أو من "67% of free weekly limit"،
 * وتاريخ التجديد يُحلَّل من "2026-11-26 23:15 EET" أو من
 * "Nov 26 at 11:15 PM EET" إلى تاريخ عربي. ترجع null عند غياب quota
 * أو غياب remaining، فلا يُعرض أي رقم من مصدر آخر ولا رقم مخترع.
 */

/**
 * نسبة مئوية من قيمة لقطة: "51%" أو "67% of free weekly limit"
 * ترجع 51؛ قيمة بلا علامة % — مثل "50 رسالة" أو عدد خام 120 (عدد
 * رسائل لا نسبة) — ترجع null فلا يُرسم شريط.
 */
export function parseQuotaPercent(value) {
    if (typeof value !== 'string') return null;
    const m = value.match(/(\d+(?:\.\d+)?)\s*%/);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
}

/** أشهر إنجليزية قصيرة → رقم الشهر، لتحليل "Nov 26 at 11:15 PM EET". */
const EN_MONTHS = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * طابع تجديد الكوتة → Date بتوقيت القاهرة أو null.
 * الصيغتان الحيّتان: "2026-11-26 23:15 EET" و"Nov 26 at 11:15 PM EET".
 * الصيغة الإنجليزية بلا سنة تأخذ سنتها من updated_at (مرجع اللقطة) أو
 * من السنة الحالية عند غيابه — فالتجديد دائمًا في المستقبل القريب.
 */
export function parseQuotaReset(value, updatedAt) {
    if (value instanceof Date) return Number.isNaN(value) ? null : value;
    if (typeof value !== 'string' || !value.trim()) return null;
    const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if (iso) {
        const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T${iso[4]}:${iso[5]}:00+02:00`);
        return Number.isNaN(d) ? null : d;
    }
    const en = value.match(/^([A-Za-z]{3}) (\d{1,2}) at (\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (en) {
        const month = EN_MONTHS[en[1].toLowerCase()];
        if (month === undefined) return null;
        let hour = Number(en[3]);
        if (en[5].toUpperCase() === 'PM' && hour < 12) hour += 12;
        if (en[5].toUpperCase() === 'AM' && hour === 12) hour = 0;
        const refYear = updatedAt ? new Date(updatedAt).getFullYear() : new Date().getFullYear();
        const year = Number.isFinite(refYear) ? refYear : new Date().getFullYear();
        const d = new Date(Date.UTC(year, month, Number(en[2]), hour - 2, Number(en[4])));
        return Number.isNaN(d) ? null : d;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed) ? null : parsed;
}

/**
 * تاريخ عربي بأرقام لاتينية — "26 نوفمبر 2026 في 11:15 م"؛ بلا وقت عند
 * withTime=false ("1 ديسمبر 2026"). ترجع null عند تاريخ فاسد.
 */
export function formatQuotaDate(date, withTime = true) {
    if (!(date instanceof Date) || Number.isNaN(date)) return null;
    const options = { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Cairo' };
    if (withTime) {
        options.hour = 'numeric';
        options.minute = '2-digit';
    }
    try {
        return new Intl.DateTimeFormat('ar-EG-u-nu-latn', options).format(date);
    } catch (err) {
        return null;
    }
}

/**
 * اسم الخطة بالعربية: "free" و"Free (weekly limit)" → "المجانية (أسبوعية)"؛
 * خطة غير مجانية تُعرض كما هي — فلا يُخترع اسم خطة.
 */
export function normalizeQuotaPlan(plan) {
    if (plan === null || plan === undefined) return null;
    const raw = String(plan).trim();
    if (!raw) return null;
    if (!raw.toLowerCase().includes('free')) return raw;
    return raw.toLowerCase().includes('week') ? 'المجانية (أسبوعية)' : 'المجانية';
}

/** حد الكوتة المنخفضة: أقل من 20% متبقٍ يُعرض كتحذير أحمر. */
export const QUOTA_LOW_THRESHOLD = 20;

/**
 * تحليل لقطة الكوتة إلى بنية عرض. البنية: remainingLabel (نص العرض،
 * مثل "51%")، remainingPct وusedPct (أرقام للشريط أو null)، pct (النسبة
 * المتبقية للشريط — من used عند غياب remaining المئوية)، low (أقل من
 * الحد)، planLabel وresetLabel (عربي)، updatedAt (Date أو null).
 */
export function parseQuota(quota) {
    if (!quota || typeof quota !== 'object') return null;
    const remaining = quota.remaining;
    if (remaining === null || remaining === undefined || remaining === '') return null;
    const remainingPct = parseQuotaPercent(remaining);
    const usedPct = parseQuotaPercent(quota.used);
    const pct = remainingPct ?? (usedPct === null ? null : 100 - usedPct);
    const resetRaw = quota.reset ? String(quota.reset) : '';
    const resetDate = parseQuotaReset(quota.reset, quota.updated_at);
    const resetHasTime = /:\d{2}/.test(resetRaw);
    const updatedDate = quota.updated_at ? new Date(quota.updated_at) : null;
    return {
        remainingLabel: remainingPct !== null ? `${remainingPct}%` : String(remaining),
        remainingPct,
        usedPct,
        pct,
        low: pct !== null && pct < QUOTA_LOW_THRESHOLD,
        planLabel: normalizeQuotaPlan(quota.plan),
        resetLabel: resetDate
            ? (formatQuotaDate(resetDate, resetHasTime) || resetRaw)
            : (resetRaw || null),
        updatedAt: updatedDate && !Number.isNaN(updatedDate) ? updatedDate : null,
    };
}

/**
 * نص الكوتة في سطر واحد — من parseQuota نفسه، فالنص والبطاقة لا يختلفان
 * أبدًا: «المتبقي من الكوتة: 51% — الخطة: المجانية (أسبوعية) — التجديد:
 * 26 نوفمبر 2026 في 11:15 م». ترجع null عند غياب quota أو غياب remaining.
 */
export function formatQuota(quota) {
    const parsed = parseQuota(quota);
    if (!parsed) return null;
    let text = `المتبقي من الكوتة: ${parsed.remainingLabel}`;
    if (parsed.planLabel) text += ` — الخطة: ${parsed.planLabel}`;
    if (parsed.resetLabel) text += ` — التجديد: ${parsed.resetLabel}`;
    return text;
}

/** استطلاع الرسائل الجديدة كل 5 ثوانٍ — كافٍ لظهور الرد بلا تحديث يدوي. */
export const POLL_MS = 5000;

/** أقصى رسائل تُحفظ في الذاكرة وتُعرض من الجلسة. */
export const MESSAGES_LIMIT = 200;

/**
 * دمج رسائل واردة مع المعروضة: إزالة المكرر بالمعرّف، وترتيب زمني تصاعدي،
 * وقصّ الأقدم عند تجاوز الحد. لا يعدّل أيًا من المصفوفتين.
 */
export function mergeMessages(existing, incoming, limit = MESSAGES_LIMIT) {
    const byId = new Map();
    for (const m of [...(existing || []), ...(incoming || [])]) {
        if (m && m.id) byId.set(m.id, m);
    }
    const merged = [...byId.values()].sort((a, b) =>
        new Date(a.created_at || 0) - new Date(b.created_at || 0));
    return merged.slice(-limit);
}

/* ─────────────────── قائمة السياق: تفاعل وردّ ونسخ ─────────────────── */

/**
 * التفاعلات المتاحة في قائمة سياق الرسالة — مجموعة ثابتة صغيرة، بلا عدّادات
 * مخترعة: الشارة تعرض فقط التفاعلات المحفوظة فعلًا في reactions للرسالة.
 * التفاعل هنا لمالك واحد (التجربة على حساب محمود فقط)، فالمحفوظ قائمة
 * إيموجي بلا عدد ولا هوية مرسِل.
 */
export const REACTION_EMOJIS = ['❤️', '👍', '😂', '😮', '😢', '🔥'];

/**
 * تبديل تفاعل على رسالة: إضافته إن غاب، وإزالته إن وُجد. ترجع نسخة جديدة
 * ولا تعدّل المدخلة. إيموجي خارج المجموعة الثابتة يُتجاهل — فلا يُحفظ
 * تفاعل لم يعرضه الشريط أبدًا.
 */
export function toggleReaction(reactions, emoji) {
    if (!REACTION_EMOJIS.includes(emoji)) return [...(reactions || [])];
    const current = reactionsOf({ reactions });
    return current.includes(emoji)
        ? current.filter((e) => e !== emoji)
        : [...current, emoji];
}

/**
 * تفاعلات رسالة كما حُفظت: مصفوفة إيموجي، أو [] عند غيابها أو فسادها —
 * فلا يعرض الشريط أبدًا تفاعلًا غير محفوظ.
 */
export function reactionsOf(message) {
    const list = message?.reactions;
    return Array.isArray(list) ? list.filter((e) => typeof e === 'string') : [];
}

/** أقصى طول لنص الاقتباس في شريط الرد وعرض الرد — يبقى الاقتباس سطرًا قصيرًا. */
export const QUOTE_MAX = 120;

/**
 * معاينة اقتباس: تطبيع المسافات وقصّ عند الحد مع «…». فراغ أو نص فارغ
 * يرجع '' فلا يُعرض اقتباس فارغ.
 */
export function quotePreview(content, max = QUOTE_MAX) {
    const clean = (content || '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    if (clean.length <= max) return clean;
    return `${clean.slice(0, max - 1).trimEnd()}…`;
}

/**
 * موضع قائمة السياق عند المؤشر، مقصوصة داخل نافذة العرض حتى لا تخرج
 * عنها قرب الحواف. ترجع {left, top} بالبكسل؛ قائمة أكبر من النافذة
 * تُثبَّت عند 0.
 */
export function clampMenuPosition(x, y, menuWidth, menuHeight, viewportWidth, viewportHeight) {
    const left = Math.max(0, Math.min(x, viewportWidth - menuWidth));
    const top = Math.max(0, Math.min(y, viewportHeight - menuHeight));
    return { left, top };
}

/* ─────────────────── توقيت الرد بالثانية ─────────────────── */

/**
 * نص عدّاد الانتظار الحي — ثوانٍ حقيقية منصرمة منذ الإرسال، بلا تقريب
 * يخفيها: «بانتظار الرد… 23 ث».
 */
export function formatWaitSeconds(seconds) {
    const n = Math.max(0, Math.floor(seconds));
    return `بانتظار الرد… ${n} ث`;
}

/** نص وصول الرد — من طابعي الإرسال والرد الحقيقيين: «وصل الرد في 47 ثانية». */
export function formatReplyTook(seconds) {
    const n = Math.max(0, Math.round(seconds));
    return `وصل الرد في ${n} ثانية`;
}

/** ثوانٍ بين طابعين زمنيين — سالبة تُقصّ إلى صفر، لا أرقام وهمية. */
export function secondsBetween(from, to) {
    const ms = new Date(to || 0) - new Date(from || 0);
    return Math.max(0, ms / 1000);
}

/**
 * هل المحادثة بانتظار رد؟ آخر رسالة من المستخدم ولا رد مساعد بعدها —
 * طابع إرسالها هو بداية العدّاد، حتى بعد إعادة تحميل الصفحة.
 * ترجع طابع الإرسال أو null.
 */
export function waitingSince(messages) {
    const rows = [...(messages || [])]
        .filter((m) => m && m.id)
        .sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
    if (!rows.length) return null;
    const last = rows[rows.length - 1];
    return last.role === 'user' ? (last.created_at || null) : null;
}
