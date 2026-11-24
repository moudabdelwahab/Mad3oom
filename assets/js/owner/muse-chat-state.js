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

/** أقصى طول لعنوان ذكي من رسالة المستخدم — أطول قليلًا من القصّ الخام. */
export const SMART_TITLE_MAX = 48;

/**
 * بدايات تُحذف من عنوان الجلسة التلقائي لأنها لا تصف الموضوع: تحية أو
 * طلب مهذب أو مخاطبة للوكيل. تُحذف تكرارًا حتى يبقى لبّ الطلب فقط؛
 * نص كان كله بدايةً (مثل «مرحبا» وحدها) يرجع كما هو بلا حذف.
 */
const TITLE_FILLERS = [
    /^(السلام عليكم|صباح الخير|مساء الخير|أهلاً|أهلا|مرحباً|مرحبا)\s*[,،]?\s*/i,
    /^(لو سمحت|من فضلك|إذا سمحت|بعد إذنك)\s*[,،]?\s*/i,
    /^(ممكن تساعدني في|ممكن تساعدني|ساعدني في|ساعدني)\s+/i,
    /^(ممكن أن|ممكن|أريد أن|أريد|عايزة|عايز|عاوز)\s+/i,
    /^(يا Muse|Muse|يا موسى)\s*[,،]?\s*/i,
];

/**
 * عنوان ذكي من رسالة المستخدم: تُحذف البدايات المهذبة، ويُقصّ عند أول
 * نهاية جملة (. أو ؟ أو !) إن كانت الجملة الأولى وافية (8 أحرف فأكثر)،
 * ثم يُقصّ عند الحد مع «…». فراغ يرجع ''؛ وبلا لبّ بعد الحذف يرجع
 * القصّ الخام deriveTitle للنص الأصلي.
 */
export function deriveSmartTitle(text, max = SMART_TITLE_MAX) {
    const clean = (text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    let core = clean;
    for (const pattern of TITLE_FILLERS) {
        const next = core.replace(pattern, '');
        if (next.trim()) core = next.trim();
    }
    if (!core) return deriveTitle(clean, max);
    const end = core.search(/[.!؟\n]/);
    if (end >= 8) core = core.slice(0, end).trim();
    if (core.length <= max) return core;
    return `${core.slice(0, max - 1).trimEnd()}…`;
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

/* ─────────────────── الوقت النسبي وتجميع الجلسات بالتاريخ ─────────────────── */

/** كل الأوقات في الصفحة بتوقيت القاهرة، وأرقامها لاتينية كالكوتة. */
export const CAIRO_TZ = 'Africa/Cairo';

/** مفتاح يوم «YYYY-MM-DD» بتوقيت القاهرة، أو null عند تاريخ فاسد. */
export function cairoDayKey(value) {
    const d = new Date(value);
    if (Number.isNaN(d)) return null;
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: CAIRO_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(d);
    } catch (err) {
        return null;
    }
}

/** فرق الأيام التقويمية بين قيمتين بتوقيت القاهرة — سالب عند قيمة لاحقة. */
export function cairoDayDiff(value, now = new Date()) {
    const a = cairoDayKey(value);
    const b = cairoDayKey(now);
    if (!a || !b) return null;
    return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

/** وقت «11:15 ص» بتوقيت القاهرة وأرقام لاتينية، أو '—' عند تاريخ فاسد. */
export function formatTimeCairo(value) {
    const d = new Date(value);
    if (Number.isNaN(d)) return '—';
    try {
        return new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
            timeZone: CAIRO_TZ, hour: 'numeric', minute: '2-digit',
        }).format(d);
    } catch (err) {
        return '—';
    }
}

/** طابع كامل بالثواني لخاصية title: «24 نوفمبر 2026 في 11:15:00 ص». */
export function formatMessageTimestamp(value) {
    const d = new Date(value);
    if (Number.isNaN(d)) return '—';
    try {
        return new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
            timeZone: CAIRO_TZ, day: 'numeric', month: 'long', year: 'numeric',
            hour: 'numeric', minute: '2-digit', second: '2-digit',
        }).format(d);
    } catch (err) {
        return '—';
    }
}

/** جمع عربي: 1 مفرد، 2 مثنى، 3–10 جمع، 11+ مفرد منصوب. */
function arabicCount(n, singular, dual, few) {
    if (n === 1) return singular;
    if (n === 2) return dual;
    if (n >= 3 && n <= 10) return `${n} ${few}`;
    return `${n} ${singular}`;
}

/**
 * وقت نسبي من طابع زمني: «الآن» ثم «منذ 5 دقائق»، ثم «اليوم 11:15 ص»
 * و«أمس 08:32 م» و«الثلاثاء 10:04 ص»، ثم التاريخ وحده بعد أسبوع.
 * طابع مستقبلي (انحراف ساعة) يُعامل كـ «الآن».
 */
export function formatRelativeTime(value, now = new Date()) {
    const d = new Date(value);
    if (Number.isNaN(d)) return '—';
    const ref = new Date(now);
    const diffMs = ref - d;
    if (diffMs < 0) return 'الآن';
    if (diffMs < 60000) return 'الآن';
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 60) return `منذ ${arabicCount(minutes, 'دقيقة', 'دقيقتين', 'دقائق')}`;
    const days = cairoDayDiff(value, ref);
    const time = formatTimeCairo(d);
    if (days === 0) return `اليوم ${time}`;
    if (days === 1) return `أمس ${time}`;
    if (days !== null && days >= 2 && days <= 6) {
        try {
            const weekday = new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
                timeZone: CAIRO_TZ, weekday: 'long',
            }).format(d);
            return `${weekday} ${time}`;
        } catch (err) {
            return formatQuotaDate(d, false) || '—';
        }
    }
    return formatQuotaDate(d, false) || '—';
}

/** وقت فقاعة الرسالة: اليوم وقت فقط، أمس «أمس + وقت»، والأقدم تاريخ ووقت. */
export function formatMessageTime(value, now = new Date()) {
    const d = new Date(value);
    if (Number.isNaN(d)) return '—';
    const days = cairoDayDiff(value, now);
    if (days === 0) return formatTimeCairo(d);
    if (days === 1) return `أمس ${formatTimeCairo(d)}`;
    return formatQuotaDate(d, true) || '—';
}

/** مجموعات القائمة الجانبية بالترتيب: اليوم، أمس، هذا الأسبوع، أقدم. */
export const SESSION_DATE_GROUPS = Object.freeze([
    { key: 'today', label: 'اليوم' },
    { key: 'yesterday', label: 'أمس' },
    { key: 'week', label: 'هذا الأسبوع' },
    { key: 'older', label: 'أقدم' },
]);

/** مجموعة جلسة واحدة من آخر نشاط (أو إنشائها): today/yesterday/week/older. */
export function sessionDateGroup(session, now = new Date()) {
    const days = cairoDayDiff(session?.last_active_at || session?.created_at, now);
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days !== null && days >= 2 && days <= 6) return 'week';
    return 'older';
}

/**
 * تجميع الجلسات (بالترتيب الوارد — الأحدث أولًا) تحت عناوين التاريخ،
 * والمجموعات الفارغة تُحذف. لا يعيد الترتيب داخل المجموعة.
 */
export function groupSessionsByDate(sessions, now = new Date()) {
    const groups = SESSION_DATE_GROUPS.map((g) => ({ ...g, sessions: [] }));
    for (const session of sessions || []) {
        const group = groups.find((g) => g.key === sessionDateGroup(session, now));
        if (group) group.sessions.push(session);
    }
    return groups.filter((g) => g.sessions.length > 0);
}

/* ─────────────────── معاينة الجلسة وحالتها ─────────────────── */

/** أقصى طول لمعاينة آخر رسالة في بطاقة الجلسة — سطر واحد قصير. */
export const SESSION_PREVIEW_MAX = 60;

/**
 * معاينة آخر رسالة: تطبيع المسافات وقصّ عند الحد مع «…». فراغ أو رسالة
 * بلا نص ترجع '' فلا تُعرض معاينة فارغة.
 */
export function previewOfLastMessage(message, max = SESSION_PREVIEW_MAX) {
    const clean = (message?.content || '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    if (clean.length <= max) return clean;
    return `${clean.slice(0, max - 1).trimEnd()}…`;
}

/**
 * حالة الجلسة من آخر رسالة حقيقية فقط: بانتظار رد إن كانت آخر رسالة من
 * المستخدم، تم الرد إن كانت من المساعد، وبلا رسائل عند غيابها. لا عدد
 * «غير مقروء» مخترعًا — لا علامة قراءة في القاعدة أصلًا.
 */
export function sessionStatus(lastMessage) {
    if (!lastMessage) return 'empty';
    return lastMessage.role === 'user' ? 'waiting' : 'answered';
}

/** نص حالة الجلسة بالعربية — النقطة وحدها لا تحمل المعنى. */
export const SESSION_STATUS_LABEL = Object.freeze({
    waiting: 'بانتظار رد',
    answered: 'تم الرد',
    empty: 'بلا رسائل',
});

/* ─────────────────── فواصل التاريخ ومدة الرد ─────────────────── */

/**
 * نص فاصل التاريخ بين الرسائل: «اليوم — 24 نوفمبر 2026» و«أمس — …»،
 * والأقدم التاريخ وحده. تاريخ فاسد يرجع '—'.
 */
export function dateSeparatorLabel(value, now = new Date()) {
    const d = new Date(value);
    if (Number.isNaN(d)) return '—';
    const date = formatQuotaDate(d, false) || '—';
    const days = cairoDayDiff(value, now);
    if (days === 0) return `اليوم — ${date}`;
    if (days === 1) return `أمس — ${date}`;
    return date;
}

/**
 * هل يظهر فاصل تاريخ قبل هذه الرسالة؟ نعم عند أول رسالة، أو عند تغيّر
 * اليوم التقويمي (بتوقيت القاهرة) عن الرسالة السابقة.
 */
export function shouldShowDateSeparator(prev, curr) {
    if (!curr?.created_at) return false;
    if (!prev?.created_at) return true;
    return cairoDayKey(prev.created_at) !== cairoDayKey(curr.created_at);
}

/**
 * ثواني رد المساعد: من أحدث رسالة مستخدم قبل طابع الرد. بلا رسالة
 * مستخدم سابقة، أو رد ليس من المساعد، ترجع null فلا يُعرض رقم.
 */
export function replyTookFor(messages, reply) {
    if (!reply || reply.role !== 'assistant' || !reply.created_at) return null;
    const replyAt = new Date(reply.created_at);
    let prevUser = null;
    for (const m of messages || []) {
        if (m?.role === 'user' && m.created_at && new Date(m.created_at) < replyAt) {
            if (!prevUser || new Date(m.created_at) > new Date(prevUser.created_at)) prevUser = m;
        }
    }
    if (!prevUser) return null;
    return secondsBetween(prevUser.created_at, reply.created_at);
}

/** نص مدة الرد تحت فقاعة المساعد: «تم الرد خلال 47 ثانية». */
export function formatReplyDuration(seconds) {
    const n = Math.max(0, Math.round(seconds));
    return `تم الرد خلال ${n} ثانية`;
}

/* ─────────────────── مراحل الانتظار ─────────────────── */

/**
 * مراحل فقاعة الانتظار من الثواني المنصرمة فقط — تسميات زمنية، لا قياس
 * لخطوات الجسر الداخلية (الجسر معتم من هذه الصفحة): قراءة، ثم مراجعة،
 * ثم تجهيز الرد.
 */
export const THINKING_STAGES = Object.freeze([
    { until: 5, label: 'يقرأ رسالتك…' },
    { until: 15, label: 'يراجع التذاكر والبيانات…' },
    { until: Infinity, label: 'يجهّز الرد…' },
]);

/** مرحلة الانتظار الحالية من ثوانٍ منصرمة — سالبة تُقصّ إلى صفر. */
export function thinkingStage(elapsedSeconds) {
    const s = Math.max(0, Math.floor(elapsedSeconds));
    return THINKING_STAGES.find((stage) => s < stage.until).label;
}
