/**
 * Continuity — منطق الواجهة النقي للمرحلة C (بلا DOM ولا شبكة).
 *
 * يخدم شاشتي المرجع: «اختيار الرسائل» (الفلترة والتحديد) و«معاينة النوع»
 * (اقتراح التصنيف)، ثم خطوة التفاصيل (الموعد الصريح، الحقول الناقصة، بناء الطلب).
 *
 * **استشاري فقط.** الاقتراح لا يُحفظ إلا لو المستخدم أكّده، والخادم (073 + 074)
 * يعيد التحقق من كل شيء: الصلاحيات، الأهلية، الوصول للمحادثة، الأنماط الحساسة.
 * الاقتراح يقرأ فقط نص رسائل يراها المستخدم الآن في الصندوق، ولا يُخزَّن ولا يُرسل.
 *
 * قواعد §16: العنوان والملخص لا يُملآن أبدًا من نص الرسالة (M5)؛ الموعد يُقترح
 * فقط من تاريخ/وقت مكتوب صراحةً مع ذكر الرسالة؛ المالك لا يُقترح أبدًا.
 */
import { RECORD_CATEGORIES, LIMITS, buildCreateRequest, validateCreateRequest } from './continuity-contract.js';
import { ATTACHMENT_KINDS, kindOfMime, baseMime, checkDeclared, signatureMatches, formatBytes } from './continuity-media.js';

export const CATEGORY_META = Object.freeze({
    order_status: { label: 'حالة طلب', icon: 'box', kind: 'follow_up' },
    order_problem: { label: 'مشكلة في الطلب', icon: 'alert', kind: 'issue' },
    general_inquiry: { label: 'استفسار عام', icon: 'chat', kind: 'follow_up' },
    return_exchange: { label: 'إرجاع أو استبدال', icon: 'undo', kind: 'follow_up' },
    payment_billing: { label: 'دفع وفواتير', icon: 'card', kind: 'follow_up' },
    product_service: { label: 'منتج أو خدمة', icon: 'tag', kind: 'follow_up' },
    technical_issue: { label: 'مشكلة تقنية', icon: 'gear', kind: 'issue' },
    complaint: { label: 'شكوى', icon: 'megaphone', kind: 'issue' },
    other: { label: 'أخرى', icon: 'dots', kind: 'follow_up' },
});

export const KIND_META = Object.freeze({
    follow_up: { label: 'متابعة بموعد محدد', hint: 'خطوة تالية وموعد لازم يتنفذ فيه.' },
    issue: { label: 'مشكلة تحتاج حلًا', hint: 'مشكلة مفتوحة لحد ما تتحل.' },
});

export const PRIORITY_LABELS = Object.freeze({ 1: 'عاجلة', 2: 'عالية', 3: 'عادية', 4: 'منخفضة' });

export const STATUS_LABELS = Object.freeze({
    open: 'مفتوح', scheduled: 'مجدول', in_progress: 'جاري العمل', waiting: 'بانتظار طرف آخر',
    ready_for_handover: 'جاهز للتسليم', resolved: 'اتحل', cancelled: 'ملغي',
});

export const SENDER_LABEL = Object.freeze({ customer: 'العميل', agent: 'الدعم', bot: 'البوت' });

/** placeholder للعنوان حسب النوع — لا قيمة مبدئية أبدًا (M5). */
export function titlePlaceholder(kind, category) {
    const what = CATEGORY_META[category]?.label;
    if (kind === 'issue') return what ? `مثال: ${what} — وصف قصير للمشكلة` : 'مثال: وصف قصير للمشكلة';
    return what ? `مثال: متابعة ${what} مع العميل` : 'مثال: متابعة مع العميل';
}

// ─────────────────────────────────────────────────────────────
// تطبيع النص العربي (للمطابقة فقط، لا للعرض)
// ─────────────────────────────────────────────────────────────
export function normalizeArabic(text) {
    return String(text ?? '')
        .replace(/[ً-ْٰـ]/g, '')   // تشكيل وتطويل
        .replace(/[أإآٱ]/g, 'ا')
        .replace(/ة/g, 'ه')
        .replace(/ى/g, 'ي')
        .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
        .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
        .toLowerCase();
}

// ─────────────────────────────────────────────────────────────
// الرسائل: النوع، القابلية للاختيار، الفلترة
// ─────────────────────────────────────────────────────────────
/** نفس تصنيف inbox-model.senderKind (الصندوق) — للعرض فقط؛ الخادم يحدد المرسل بنفسه. */
export function messageSender(message) {
    if (message?.is_admin_reply) return 'agent';
    if (message?.is_bot_reply || !message?.sender_id) return 'bot';
    return 'customer';
}

const hasAttachment = (m) => Boolean(m?.attachment_path || m?.image_url || m?.attachment_kind);

/** الخادم يرفض رسالة محذوفة أو بلا نص (message_has_no_text)، فلا نعرضها كقابلة للاختيار. */
export function selectability(message) {
    if (message?.deleted_at) return { selectable: false, reason: 'رسالة محذوفة' };
    if (!String(message?.message_text ?? '').trim()) return { selectable: false, reason: 'مرفق بلا نص' };
    return { selectable: true, reason: null };
}

export const TIME_FILTERS = Object.freeze({ all: 'كل الوقت', today: 'اليوم', '7d': 'آخر 7 أيام', '30d': 'آخر 30 يوم' });
export const PARTICIPANT_FILTERS = Object.freeze({ all: 'كل المشاركين', customer: 'العميل', agent: 'الدعم', bot: 'البوت' });
export const TYPE_FILTERS = Object.freeze({ all: 'كل الأنواع', text: 'نص فقط', attachment: 'فيها مرفق' });

export function filterMessages(messages, { query = '', time = 'all', participant = 'all', type = 'all' } = {}, now = new Date()) {
    const q = normalizeArabic(query).trim();
    const since = { today: 1, '7d': 7, '30d': 30 }[time];
    const cutoff = since ? now.getTime() - since * 86400000 : null;
    return (messages || []).filter((m) => {
        if (q && !normalizeArabic(m.message_text).includes(q)) return false;
        if (cutoff !== null && Date.parse(m.created_at) < cutoff) return false;
        if (participant !== 'all' && messageSender(m) !== participant) return false;
        if (type === 'text' && hasAttachment(m)) return false;
        if (type === 'attachment' && !hasAttachment(m)) return false;
        return true;
    });
}

/**
 * تبديل اختيار رسالة. يرجع مجموعة جديدة بترتيب الإضافة، ويرفض ما بعد الحد
 * (LIMITS.sourcesPerRequest) أو غير القابل للاختيار.
 */
export function toggleSelection(selected, message) {
    const next = [...(selected || [])];
    const at = next.indexOf(message.id);
    if (at >= 0) {
        next.splice(at, 1);
        return { selected: next, error: null };
    }
    if (!selectability(message).selectable) return { selected: next, error: 'not_selectable' };
    if (next.length >= LIMITS.sourcesPerRequest) return { selected: next, error: 'limit' };
    next.push(message.id);
    return { selected: next, error: null };
}

/** الرسائل المختارة بالترتيب الزمني (ترتيب المصادر في السجل). */
export function orderedSelection(messages, selectedIds) {
    const set = new Set(selectedIds || []);
    return (messages || []).filter((m) => set.has(m.id))
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

// ─────────────────────────────────────────────────────────────
// اقتراح التصنيف (حتمي، بالكلمات المفتاحية)
// ─────────────────────────────────────────────────────────────
// عبارة من كلمتين أو أكثر وزنها 2، والكلمة الواحدة 1، وكلمات التصنيفين العامّين
// (منتج/خدمة، استفسار) نصف وزن حتى لا تغلب كلمة «منتج» على «مكسور». الترتيب يكسر التعادل.
const CATEGORY_KEYWORDS = {
    order_problem: ['الطلب ناقص', 'طلب ناقص', 'منتج تالف', 'تالف', 'مكسور', 'غلط في الطلب', 'خطا في الطلب', 'ماوصلش', 'موصلش',
        'لم يصل', 'ما وصل', 'متاخر', 'تاخير', 'اتاخر', 'wrong item', 'damaged', 'missing item', 'late delivery'],
    return_exchange: ['ارجاع', 'استرجاع', 'استبدال', 'تبديل', 'رجع المنتج', 'refund', 'return', 'exchange'],
    payment_billing: ['الدفع', 'دفع', 'فاتوره', 'الفاتوره', 'فواتير', 'اتخصم', 'خصم', 'الفلوس', 'تحويل بنكي', 'محفظه',
        'تجديد الاشتراك', 'payment', 'invoice', 'billing', 'charged', 'refund pending'],
    technical_issue: ['مشكله تقنيه', 'مش شغال', 'لا يعمل', 'بيعلق', 'error', 'خطا', 'تسجيل الدخول', 'مش عارف ادخل',
        'كلمه السر', 'الباسورد', 'التطبيق', 'الموقع واقع', 'bug', 'crash', 'login'],
    complaint: ['شكوي', 'اشتكي', 'اشتكيت', 'سيء', 'سيئه', 'زعلان', 'غير راضي', 'مش راضي', 'مستاء', 'اسوا', 'complaint', 'unacceptable'],
    order_status: ['حاله الطلب', 'حاله طلبي', 'رقم الطلب', 'طلبي', 'الشحنه', 'الشحن', 'التوصيل', 'التسليم', 'موعد التسليم',
        'تتبع', 'order status', 'tracking', 'shipment', 'delivery', 'order number'],
    product_service: ['المنتج', 'منتج', 'الخدمه', 'خدمه', 'الباقه', 'باقه', 'مواصفات', 'product', 'service', 'plan'],
    general_inquiry: ['استفسار', 'سؤال', 'عايز اعرف', 'اريد معرفه', 'ممكن اعرف', 'هل يمكن', 'inquiry', 'question'],
};

export function suggestCategory(messages) {
    const text = normalizeArabic((messages || []).map((m) => m?.message_text ?? '').join('\n'));
    let best = null;
    for (const [category, words] of Object.entries(CATEGORY_KEYWORDS)) {
        const matched = words.filter((w) => text.includes(normalizeArabic(w)));
        const generic = category === 'product_service' || category === 'general_inquiry' ? 0.5 : 1;
        const score = matched.reduce((n, w) => n + (w.includes(' ') ? 2 : 1) * generic, 0);
        if (score > 0 && (!best || score > best.score)) best = { category, score, matched };
    }
    return best ? { category: best.category, matched: best.matched } : null;
}

export const suggestKind = (category) => CATEGORY_META[category]?.kind ?? 'follow_up';

// ─────────────────────────────────────────────────────────────
// الموعد الصريح (§16): تاريخ/وقت مكتوب حرفيًا، بالنسبة لوقت الرسالة
// ─────────────────────────────────────────────────────────────
const WEEKDAYS = { 'الاحد': 0, 'الاثنين': 1, 'الاتنين': 1, 'الثلاثاء': 2, 'التلات': 2, 'الاربعاء': 3, 'الاربع': 3,
    'الخميس': 4, 'الجمعه': 5, 'السبت': 6 };
const RELATIVE = [
    [/(?:^|[^\p{L}])(?:بعد بكره|بعد بكرا|بعد غد|day after tomorrow)(?=$|[^\p{L}])/u, 2],
    [/(?:^|[^\p{L}])(?:بكره|بكرا|غدا|tomorrow)(?=$|[^\p{L}])/u, 1],
    [/(?:^|[^\p{L}])(?:النهارده|النهارد|اليوم|today)(?=$|[^\p{L}])/u, 0],
];
const TIME = /(?:الساعه|ساعه|at)\s*(\d{1,2})(?::(\d{2}))?\s*(ص|صباحا|الصبح|م|مساء|بالليل|العصر|الضهر|الظهر|am|pm)?|(\d{1,2})(?::(\d{2}))?\s*(am|pm|ص|م)(?=$|[^\p{L}])|(\d{1,2}):(\d{2})/u;
const DATE_DMY = /(?:^|[^\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?=$|[^\d/])/;
const DATE_ISO = /(?:^|\D)(\d{4})-(\d{2})-(\d{2})(?=$|\D)/;

/** أجزاء التاريخ في منطقة زمنية (بدون مكتبات). */
function zonedParts(date, tz) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((p) => [p.type, p.value]));
    const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday];
    return { y: +parts.year, m: +parts.month, d: +parts.day, wd, hh: +parts.hour, mm: +parts.minute };
}
const pad = (n) => String(n).padStart(2, '0');
function addDays({ y, m, d }, n) {
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
const validDate = (y, m, d) => {
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

function readTime(text) {
    const t = text.match(TIME);
    if (!t) return null;
    let h; let min; let mer;
    if (t[1] !== undefined) [h, min, mer] = [+t[1], +(t[2] ?? 0), t[3]];
    else if (t[4] !== undefined) [h, min, mer] = [+t[4], +(t[5] ?? 0), t[6]];
    else [h, min, mer] = [+t[7], +t[8], null];
    if (min > 59 || h > 23) return null;
    const pm = /^(م|مساء|بالليل|العصر|pm)$/.test(mer ?? '') || (/^(الضهر|الظهر)$/.test(mer ?? '') && h < 11);
    const am = /^(ص|صباحا|الصبح|am)$/.test(mer ?? '');
    if (pm && h < 12) h += 12;
    if (am && h === 12) h = 0;
    return { h, min, literal: t[0].trim() };
}

/**
 * مواعيد مكتوبة صراحةً في الرسائل المختارة. اليوم النسبي («بكرة») يُحسب من
 * يوم الرسالة نفسها في المنطقة tz، لا من الآن. الوقت غير المكتوب = 09:00 مع
 * علامة timeStated=false. الموعد الذي فات يُعلَّم past=true (الخادم يرفضه).
 */
export function detectDueCandidates(messages, { tz = 'Africa/Cairo', now = new Date() } = {}) {
    const out = [];
    for (const m of messages || []) {
        const text = normalizeArabic(m?.message_text);
        if (!text) continue;
        const base = zonedParts(new Date(m.created_at), tz);
        let date = null; let literal = '';
        const iso = text.match(DATE_ISO);
        const dmy = text.match(DATE_DMY);
        if (iso && validDate(+iso[1], +iso[2], +iso[3])) {
            date = { y: +iso[1], m: +iso[2], d: +iso[3] }; literal = iso[0].trim();
        } else if (dmy) {
            const d = +dmy[1]; const mo = +dmy[2];
            let y = dmy[3] ? +dmy[3] : base.y;
            if (!dmy[3] && (mo < base.m || (mo === base.m && d < base.d))) y += 1;
            if (validDate(y, mo, d)) { date = { y, m: mo, d }; literal = dmy[0].trim(); }
        }
        if (!date) {
            for (const [re, n] of RELATIVE) {
                const r = text.match(re);
                if (r) { date = addDays(base, n); literal = r[0].trim(); break; }
            }
        }
        if (!date) {
            for (const [word, wd] of Object.entries(WEEKDAYS)) {
                const r = text.match(new RegExp(`(?:^|[^\\p{L}])(?:يوم\\s+)?${word}(?=$|[^\\p{L}])`, 'u'));
                if (r) {
                    const ahead = ((wd - base.wd + 7) % 7) || 7;
                    date = addDays(base, ahead); literal = r[0].trim();
                    break;
                }
            }
        }
        if (!date) continue;
        const time = readTime(text);
        const at = `${date.y}-${pad(date.m)}-${pad(date.d)}T${pad(time ? time.h : 9)}:${pad(time ? time.min : 0)}`;
        const nowLocal = zonedParts(now, tz);
        const nowKey = `${nowLocal.y}-${pad(nowLocal.m)}-${pad(nowLocal.d)}T${pad(nowLocal.hh)}:${pad(nowLocal.mm)}`;
        out.push({
            at, tz, messageId: m.id, timeStated: Boolean(time),
            literal: [literal, time?.literal].filter(Boolean).join(' '),
            past: at <= nowKey,
        });
    }
    return out;
}

// ─────────────────────────────────────────────────────────────
// المسودة: الحقول الناقصة وبناء الطلب
// ─────────────────────────────────────────────────────────────
const FIELD_LABELS = Object.freeze({
    kind: 'نوع السجل', title: 'العنوان', next_action: 'الخطوة التالية', due: 'الموعد',
    'issue.problem': 'وصف المشكلة', sources: 'الرسائل',
});

/** الحقول المطلوبة الناقصة في المسودة (§16 missing[]). */
export function missingFields(draft) {
    const missing = [];
    if (!draft?.kind) missing.push('kind');
    if (!String(draft?.title ?? '').trim()) missing.push('title');
    if (draft?.kind === 'follow_up') {
        if (!String(draft?.nextAction ?? '').trim()) missing.push('next_action');
        if (!draft?.dueAt || !draft?.dueTz) missing.push('due');
    }
    if (draft?.kind === 'issue' && !String(draft?.summary ?? '').trim()) missing.push('issue.problem');
    return missing.map((field) => ({ field, label: FIELD_LABELS[field] }));
}

/**
 * من يقدر المستخدم يختاره مالكًا (للعرض فقط؛ الخادم يقرر بـ 074 P3).
 * بلا صلاحية إسناد: نفسه أو بلا مالك. بصلاحية: كل الطاقم المؤهل.
 */
export function ownerOptions({ agents = [], meId = null, canAssign = false } = {}) {
    const name = (a) => a.full_name || a.email || 'موظف';
    const opts = [{ value: '', label: 'بدون مالك الآن' }];
    const me = agents.find((a) => a.id === meId);
    if (meId) opts.push({ value: meId, label: me ? `أنا (${name(me)})` : 'أنا' });
    if (canAssign) {
        for (const a of agents) if (a.id !== meId) opts.push({ value: a.id, label: name(a) });
    }
    return opts;
}

export function buildRequestFromDraft(draft, { idempotencyKey }) {
    const kind = draft.kind;
    return buildCreateRequest({
        idempotencyKey,
        kind,
        title: draft.title,
        summary: String(draft.summary ?? '').trim() || null,
        nextAction: String(draft.nextAction ?? '').trim() || null,
        priority: Number(draft.priority) || 3,
        ownerId: draft.ownerId || null,
        teamId: draft.teamId || null,
        due: draft.dueAt && draft.dueTz ? { at: draft.dueAt.length === 16 ? `${draft.dueAt}:00` : draft.dueAt, tz: draft.dueTz } : null,
        issue: kind === 'issue' ? { problem: String(draft.summary ?? '').trim() || null } : null,
        messageIds: draft.messageIds || [],
        sensitiveAck: Boolean(draft.sensitiveAck),
        category: draft.category || null,
    });
}

export { validateCreateRequest, RECORD_CATEGORIES };

// ─────────────────────────────────────────────────────────────
// صفحة السجل: ما يُعرض من أدوات (للعرض فقط؛ الخادم يقرر)
// ─────────────────────────────────────────────────────────────
const ACTIVE = ['open', 'scheduled', 'in_progress', 'waiting'];

/** انتقالات 073 §7: للمالك أو المشرف فقط. needs = الحقل النصي المطلوب. */
export function allowedTransitions(record, { meId, supervisor = false } = {}) {
    if (!record || !(supervisor || (meId && record.owner_id === meId))) return [];
    if (ACTIVE.includes(record.status)) {
        return [
            { to: 'in_progress', label: 'بدأت الشغل', needs: null },
            { to: 'waiting', label: 'بانتظار طرف آخر', needs: 'waiting_on', prompt: 'مستني مين أو إيه؟' },
            { to: 'resolved', label: 'اتحل', needs: 'resolution_note', prompt: 'اتحل إزاي؟' },
            { to: 'cancelled', label: 'إلغاء', needs: 'cancel_reason', prompt: 'سبب الإلغاء' },
        ].filter((t) => t.to !== record.status);
    }
    if (record.status === 'resolved' || record.status === 'cancelled') {
        return [{ to: 'open', label: 'إعادة فتح', needs: 'reason', prompt: 'سبب إعادة الفتح' }];
    }
    return [];
}

/**
 * متطلبات إعادة الفتح (079): نفس قاعدة الخادم، للعرض فقط.
 *   متابعة موعدها فات أو خلال 5 دقائق أو بلا موعد ⇒ needsDue (موعد جديد إلزامي).
 *   موعد مستقبلي ⇒ keepsDue (يفضل كما هو ما لم يُحدَّد جديد).
 * سجل غير مقفول ⇒ null.
 */
export const REOPEN_DUE_MARGIN_MS = 5 * 60 * 1000;
export function reopenRequirements(record, now = new Date()) {
    if (!record || (record.status !== 'resolved' && record.status !== 'cancelled')) return null;
    const dueMs = record.due_at ? Date.parse(record.due_at) : NaN;
    const keepsDue = Number.isFinite(dueMs) && dueMs > now.getTime() + REOPEN_DUE_MARGIN_MS;
    return {
        needsDue: record.kind === 'follow_up' && !keepsDue,
        keepsDue,
        expiredDue: Number.isFinite(dueMs) && !keepsDue,
        tz: record.due_tz || 'Africa/Cairo',
    };
}

const CLOSED_LABELS = Object.freeze({ resolved: 'اتحل', cancelled: 'اتلغى' });

/**
 * تاريخ الإغلاق كما أرسله الخادم (_continuity_full.closures، الأحدث أولًا) ⇒ صفوف عرض.
 * إغلاق قديم أعيد فتحه قبل 079 لا نص له ولا سبب لإعادة فتحه (backfilled): يُقال ذلك صراحة بدل خانة فارغة.
 */
export function closureHistory(closures) {
    if (!Array.isArray(closures)) return [];
    return closures.map((c) => {
        const resolved = c.closed_status === 'resolved';
        const note = (resolved ? c.resolution_note : c.cancel_reason) || null;
        return {
            seq: c.seq,
            statusLabel: CLOSED_LABELS[c.closed_status] || c.closed_status,
            closedAt: c.closed_at,
            closedBy: c.closed_by || null,
            noteLabel: resolved ? 'الحل' : 'سبب الإلغاء',
            note,
            noteMissing: !note && Boolean(c.backfilled),
            reopened: Boolean(c.reopened_at),
            reopenedAt: c.reopened_at || null,
            reopenedBy: c.reopened_by || null,
            reopenReason: c.reopen_reason || null,
            reopenReasonMissing: Boolean(c.reopened_at) && !c.reopen_reason && Boolean(c.backfilled),
        };
    });
}

/**
 * نافذة السجل المستقلة: الرابط يحمل معرّف السجل فقط (UUID)، ولا يمنح أي وصول؛
 * الخادم يقرر في continuity_get. معرّف غير صالح ⇒ لا نداء أصلًا.
 */
const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isRecordId = (id) => typeof id === 'string' && RECORD_ID.test(id);
export function standaloneRecordUrl(id) {
    if (!isRecordId(id)) throw new TypeError('record id');
    return `/admin/continuity-record.html?id=${id.toLowerCase()}`;
}

/**
 * أدوات الإسناد على سجل قائم (074 P4):
 *   صلاحية إسناد ⇒ أي موظف مؤهل + الفريق؛ المالك ⇒ نفسه أو بلا مالك؛
 *   سجل بلا مالك ⇒ أخذه لنفسك؛ غير ذلك ⇒ لا أدوات.
 */
export function assignmentOptions(record, { agents = [], meId = null, canAssign = false } = {}) {
    if (!record || !['open', 'scheduled', 'in_progress', 'waiting'].includes(record.status)) {
        return { editable: false, owners: [], teamEditable: false };
    }
    if (canAssign) return { editable: true, owners: ownerOptions({ agents, meId, canAssign: true }), teamEditable: true };
    if (record.owner_id && record.owner_id === meId) {
        return { editable: true, owners: ownerOptions({ agents, meId, canAssign: false }), teamEditable: false };
    }
    if (!record.owner_id) {
        return { editable: true, owners: ownerOptions({ agents, meId, canAssign: false }), teamEditable: false };
    }
    return { editable: false, owners: [], teamEditable: false };
}

/** موعد timestamptz ⇒ قيمة datetime-local في منطقته (due_tz). */
export function toZonedInput(iso, tz) {
    if (!iso || !tz) return '';
    try {
        const p = zonedParts(new Date(iso), tz);
        return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}`;
    } catch {
        return '';
    }
}

export const EVENT_LABELS = Object.freeze({
    created: 'أنشأ السجل', updated: 'عدّل السجل', assigned: 'غيّر المالك', transitioned: 'غيّر الحالة',
    resolved: 'قفل السجل كمحلول', cancelled: 'ألغى السجل', reopened: 'أعاد فتح السجل',
    source_attached: 'أرفق رسالة', source_redacted: 'حذف محتوى مصدر', sensitive_ack: 'أكّد إرفاق محتوى حساس',
    source_removed: 'شال رسالة للمحذوفات', source_restored: 'رجّع رسالة من المحذوفات', source_purged: 'مسح رسالة نهائيًا',
    attachment_added: 'أرفق ملفًا', attachment_removed: 'شال مرفقًا للمحذوفات', attachment_restored: 'رجّع مرفقًا',
    attachment_purged: 'مسح مرفقًا نهائيًا', attachment_redacted: 'انتهى احتفاظ مرفق',
    handover_requested: 'طلب تسليم السجل', handover_accepted: 'قبل تسليم السجل', handover_declined: 'رفض تسليم السجل',
    handover_cancelled: 'ألغى طلب التسليم', handover_expired: 'انتهى طلب التسليم',
});

// ─────────────────────────────────────────────────────────────
// سياسات الاستمرارية (078): وصف للعرض فقط؛ الخادم يقرر ويفرض
// ─────────────────────────────────────────────────────────────
export const CAPABILITY_LABELS = Object.freeze({
    handovers: 'التسليم بين الموظفين', reminders: 'التذكيرات', escalation: 'التصعيد',
    monitor: 'مراقب الاستمرارية', attachments: 'المرفقات', ai: 'الاستخراج بالذكاء الاصطناعي',
});

const minutesLabel = (m) => {
    if (m == null) return 'لا';
    if (m % 1440 === 0) return m === 1440 ? 'يوم' : `${m / 1440} أيام`;
    if (m % 60 === 0) return m === 60 ? 'ساعة' : `${m / 60} ساعات`;
    return `${m} دقيقة`;
};

/**
 * يحوّل رد continuity_get_policies لصفوف عرض { label, value, off? }.
 * القيم كما أرسلها الخادم؛ لا افتراضيات هنا (الافتراضي في القاعدة: D1–D4).
 */
export function describePolicy(res) {
    const p = res?.policy || {};
    const installed = res?.capabilities_installed || {};
    const capabilities = Object.keys(CAPABILITY_LABELS).map((key) => {
        const enabled = Boolean(p[`${key}_enabled`]);
        const isInstalled = Boolean(installed[key]);
        return {
            label: CAPABILITY_LABELS[key],
            value: enabled && isInstalled ? 'مفعّلة' : isInstalled ? 'مطفأة' : 'مطفأة · غير مثبتة بعد',
            off: !(enabled && isInstalled),
        };
    });
    const offsets = Array.isArray(p.reminder_offsets_minutes) ? p.reminder_offsets_minutes : [];
    const timings = [
        { label: 'تذكير قبل الموعد', value: offsets.length ? offsets.map(minutesLabel).join('، ') : 'لا' },
        { label: 'إشعار عند حلول الموعد', value: p.due_alert ? 'نعم' : 'لا' },
        { label: 'تكرار أثناء التأخير', value: p.overdue_repeat_minutes == null ? 'لا' : `كل ${minutesLabel(p.overdue_repeat_minutes)} (حتى ${p.overdue_repeat_max} مرات)` },
        { label: 'تصعيد بعد التأخير', value: p.escalate_after_minutes == null ? 'لا'
            : `بعد ${minutesLabel(p.escalate_after_minutes)} ${p.escalation_recipients === 'team_then_supervisors' ? 'للفريق ثم المشرفين' : 'للمشرفين'}` },
        { label: 'ساعات العمل في التصعيد', value: p.respect_working_hours ? 'تُراعى' : 'لا تُراعى' },
        { label: 'تسليم معلّق: تذكير', value: p.handover_remind_after_minutes == null ? 'لا' : `بعد ${minutesLabel(p.handover_remind_after_minutes)}` },
        { label: 'تسليم معلّق: تصعيد', value: p.handover_escalate_after_minutes == null ? 'لا' : `بعد ${minutesLabel(p.handover_escalate_after_minutes)}` },
        { label: 'سجل بلا نشاط', value: `${p.stale_after_days ?? '—'} أيام` },
        { label: 'تأجيل متكرر', value: `${p.postpone_flag_count ?? '—'} مرات` },
    ];
    return { capabilities, timings, version: res?.version ?? null };
}

// ─────────────────────────────────────────────────────────────
// المرفقات (080): فحص مبكر للعرض فقط؛ دالة الرفع والقاعدة تعيدان الفحص كاملًا
// ─────────────────────────────────────────────────────────────
export const ATTACHMENT_ACCEPT = Object.values(ATTACHMENT_KINDS).flatMap((k) => k.mimes).join(',');
export const KIND_LABELS = Object.freeze({ image: 'صورة', video: 'فيديو', audio: 'تسجيل صوتي' });
export const ATTACHMENT_LIMITS_TEXT = `صور حتى ${formatBytes(ATTACHMENT_KINDS.image.max)}، فيديو حتى ${formatBytes(ATTACHMENT_KINDS.video.max)}، صوت حتى ${formatBytes(ATTACHMENT_KINDS.audio.max)}`;
const NOT_ALLOWED_TEXT = 'النوع ده مش مسموح. المسموح: صور (PNG، JPEG، WebP، GIF)، فيديو (MP4، WebM، MOV)، وصوت (WebM، Ogg، MP3، M4A، WAV).';

/**
 * ملف من المتصفح ⇒ { kind, mime, size } أو { error }.
 * head: أول بايتات الملف (اختياري) لفحص التوقيع مبكرًا.
 */
export function prepareAttachment(file, head = null) {
    const mime = baseMime(file?.type);
    const kind = kindOfMime(mime);
    if (!kind) return { error: NOT_ALLOWED_TEXT };
    const size = Number(file?.size);
    const bad = checkDeclared({ kind, mime, size });
    if (bad?.reason === 'too_large') {
        return { error: `${KIND_LABELS[kind]} أكبر من الحد (${formatBytes(ATTACHMENT_KINDS[kind].max)}). الملف ${formatBytes(size)}.` };
    }
    if (bad) return { error: size === 0 ? 'الملف فاضي.' : NOT_ALLOWED_TEXT };
    if (head && !signatureMatches(mime, head)) {
        return { error: 'محتوى الملف مش من النوع اللي بيقول عليه. ارفع الملف الأصلي.' };
    }
    return { kind, mime, size };
}

/** رفض الخادم (دالة الرفع أو القاعدة) ⇒ نص مفهوم. لا يعرض نص الخادم. */
export function attachmentErrorText(err) {
    const code = err?.code;
    const reason = err?.reason;
    if (code === 'network' || code === 'aborted') return err.message;
    if (reason === 'signature_mismatch') return 'محتوى الملف مش من النوع اللي بيقول عليه. ارفع الملف الأصلي.';
    if (reason === 'too_large') return 'الملف أكبر من الحد المسموح لنوعه.';
    if (reason === 'not_allowed') return NOT_ALLOWED_TEXT;
    if (reason === 'too_many_attachments') return 'وصلت للحد: 20 مرفق نشط في السجل. شيل مرفق الأول.';
    if (reason === 'size_mismatch' || reason === 'mime_mismatch' || reason === 'missing') return 'الملف وصل ناقص أو مختلف. جرّب تاني.';
    if (code === 'feature_not_enabled') return 'المرفقات مش مفعّلة حاليًا.';
    if (code === 'invalid_transition') return 'السجل مقفول. أعد فتحه عشان ترفع أو تعدّل المرفقات.';
    if (code === 'not_found') return 'السجل أو المرفق غير موجود أو مش مسموح لك.';
    if (code === 'forbidden') return err?.field === 'owner' ? 'المسح النهائي لحساب مالك المنصة بس.' : 'مش مسموح لك.';
    if (code === 'version_conflict') return 'السجل اتعدّل — حدّث الصفحة.';
    if (code === 'unauthorized') return 'الجلسة انتهت. سجّل الدخول من جديد.';
    return 'حصلت مشكلة في الرفع. جرّب تاني.';
}

/** صف عرض لمرفق كما أرسله الخادم (_continuity_full.attachments). */
export function attachmentView(a) {
    const kind = ATTACHMENT_KINDS[a?.kind] ? a.kind : null;
    return {
        id: a?.id, kind, path: a?.path,
        label: KIND_LABELS[kind] || 'ملف',
        name: a?.name || KIND_LABELS[kind] || 'ملف',
        size: formatBytes(Number(a?.size)),
        createdBy: a?.created_by || null, createdAt: a?.created_at || null,
        removedBy: a?.removed_by || null, removedAt: a?.removed_at || null,
    };
}

// ─────────────────────────────────────────────────────────────
// التسليم (081) — عرض فقط؛ الخادم يعيد كل الفحوص
// ─────────────────────────────────────────────────────────────
export const HANDOVER_STATE_LABELS = Object.freeze({
    pending: 'بانتظار القبول', accepted: 'اتقبل', declined: 'اترفض', cancelled: 'اتلغى', expired: 'انتهى',
});
export const HANDOVER_CANCEL_LABELS = Object.freeze({
    initiator: 'ألغاه صاحب الطلب', supervisor: 'ألغاه مشرف', reassigned: 'اتلغى لأن السجل اتسند مباشرة',
    record_closed: 'اتلغى لأن السجل اتقفل', target_ineligible: 'المستلم لم يعد مؤهلًا',
    requester_lost_authority: 'صاحب الطلب لم يعد مسؤولًا عن السجل',
});

/**
 * ما يظهر على سجل مفتوح (نفس قواعد 081):
 *   canRequest: المالك الحالي أو مشرف/صاحب إسناد، سجل نشط، بلا طلب معلّق.
 *   canCancel: صاحب الطلب أو مشرف/صاحب إسناد.
 */
export function handoverActions(record, { meId = null, canAssign = false, enabled = false, pending = null } = {}) {
    const active = record && !['resolved', 'cancelled'].includes(record.status);
    const manager = Boolean(record && ((meId && record.owner_id === meId) || canAssign));
    return {
        canRequest: Boolean(enabled && active && manager && !pending),
        canCancel: Boolean(enabled && pending && (pending.created_by === meId || canAssign)),
    };
}

/** المرشحون للاستلام: موظفون مؤهلون غير المالك الحالي. */
export function handoverTargets(agents, record) {
    return (agents || []).filter((a) => a?.id && a.id !== record?.owner_id)
        .map((a) => ({ value: a.id, label: a.full_name || a.email || 'موظف' }));
}

/** رفض الخادم للتسليم ⇒ نص مفهوم. */
export function handoverErrorText(err) {
    const r = err?.reason;
    if (r === 'handover_pending') return 'فيه طلب تسليم معلّق للسجل ده بالفعل.';
    if (r === 'not_eligible') return 'الموظف ده مش مؤهل يستلم سجلات دلوقتي.';
    if (r === 'already_owner') return 'الموظف ده هو المالك الحالي.';
    if (r === 'required') return 'اكتب سبب الرفض.';
    if (typeof r === 'string' && r.startsWith('handover_')) return 'الطلب ده اتحسم بالفعل.';
    if (err?.code === 'version_conflict') return 'السجل اتعدّل بعد ما شفت الطلب. راجع البيانات وجرّب تاني.';
    if (err?.code === 'feature_not_enabled') return 'التسليم مش مفعّل حاليًا.';
    if (err?.code === 'invalid_transition') return 'السجل مقفول.';
    if (err?.code === 'forbidden') return 'مش مسموح لك. التسليم للمالك الحالي أو المشرف أو صاحب صلاحية الإسناد.';
    if (err?.code === 'not_found') return 'الطلب أو السجل غير موجود أو مش مسموح لك.';
    return err?.message || 'حصل خطأ';
}

// ─────────────────────────────────────────────────────────────
// 087: صلاحيات السجل كما قررها الخادم (للعرض فقط؛ كل RPC يقرر بنفسه)
// ─────────────────────────────────────────────────────────────
/**
 * permissions من القراءة الكاملة. قاعدة قبل 087 (لا permissions): من يرى يعدّل (P1/T1)
 * كما كان، وlegacy = true.
 */
export function recordPermissions(full, { attachmentsOn = false } = {}) {
    if (full?.permissions && typeof full.permissions === 'object') return { ...full.permissions, legacy: false };
    const closed = ['resolved', 'cancelled'].includes(full?.record?.status);
    return { edit: !closed, sources: !closed, attachments: !closed && attachmentsOn, reason: closed ? 'closed' : null, legacy: true };
}

/** لماذا لا يقدر المنادي يعدّل — جملة واحدة، أو null لو يقدر. */
export function editNotice(perms, ownerName = 'المالك') {
    switch (perms?.reason) {
        case 'closed': return 'السجل مقفول. أعد فتحه للتعديل.';
        case 'unassigned': return 'السجل من غير مالك. خده لنفسك عشان تعدّله وتدير مصادره ومرفقاته.';
        case 'not_owner': return `تقدر تشوف السجل بس. التعديل والمصادر والمرفقات لمالكه (${ownerName}) أو للمشرف.`;
        default: return null;
    }
}

/** رفض بوابة التعديل (087) ⇒ نص مفهوم، أو null لو مش هو. */
export function editRefusalText(err) {
    if (err?.code !== 'forbidden' || err.field !== 'record') return null;
    return err.reason === 'unassigned'
        ? 'السجل من غير مالك. خده لنفسك الأول عشان تعدّله.'
        : 'التعديل لمالك السجل أو للمشرف. تقدر تشوفه بس.';
}

/** حقول المشكلة (issue) القابلة للتعديل، بنفس حدود الخادم. */
export const ISSUE_FIELDS = Object.freeze([
    { key: 'problem', label: 'وصف المشكلة', required: true },
    { key: 'known_facts', label: 'المعروف لحد دلوقتي' },
    { key: 'unknowns', label: 'اللي لسه مش معروف' },
    { key: 'resolution_criteria', label: 'تتحل إمتى (شرط الحل)' },
]);

const CHANGED_FIELD_LABELS = Object.freeze({
    title: 'العنوان', summary: 'الملخص', next_action: 'الخطوة التالية', problem: 'وصف المشكلة',
    known_facts: 'المعروف', unknowns: 'غير المعروف', resolution_criteria: 'شرط الحل',
    priority: 'الأولوية', category: 'النوع', due_at: 'الموعد', due_tz: 'الموعد',
});

/**
 * تفاصيل حدث من السجل بأسماء الحقول والقيم الثابتة فقط. النصوص الحرة لا تصل أصلًا (بصمات في
 * الخادم)، فلا شيء هنا يعرض محتوى.
 */
export function describeEvent(e, { name = () => 'موظف' } = {}) {
    const p = e?.payload || {};
    switch (e?.kind) {
        case 'updated': {
            const fields = [...new Set((Array.isArray(p.changed) ? p.changed : []).map((f) => CHANGED_FIELD_LABELS[f] || null).filter(Boolean))];
            const parts = [];
            if (fields.length) parts.push(fields.join('، '));
            if (p.priority?.to != null) parts.push(`الأولوية: ${PRIORITY_LABELS[p.priority.from] || '—'} ← ${PRIORITY_LABELS[p.priority.to] || '—'}`);
            if (p.category && 'to' in p.category) parts.push(`النوع: ${CATEGORY_META[p.category.to]?.label || 'بدون'}`);
            return parts.join(' · ');
        }
        case 'assigned':
            return p.from_owner === p.to_owner ? 'تغيير الفريق' : `${name(p.from_owner)} ← ${name(p.to_owner)}`;
        case 'transitioned':
            return p.from && p.to ? `${STATUS_LABELS[p.from] || p.from} ← ${STATUS_LABELS[p.to] || p.to}` : '';
        case 'reopened':
            return p.from ? `من «${STATUS_LABELS[p.from] || p.from}»${p.due ? ' بموعد جديد' : ''}` : '';
        case 'source_attached': case 'source_removed': case 'source_restored': case 'source_redacted':
            return Number.isInteger(p.position) ? `رسالة #${p.position}` : '';
        case 'attachment_added': case 'attachment_removed': case 'attachment_restored': case 'attachment_purged':
            return KIND_LABELS[p.kind] || '';
        default:
            return '';
    }
}

/**
 * طلب إنشاء من صفحة الاستمرارية (بلا رسائل): نفس العقد، وحقول المشكلة كاملة. الرسائل تُرفق
 * لاحقًا من صندوق الرسائل («إرفاق بسجل موجود»).
 */
export function buildManualRequest(draft, { idempotencyKey }) {
    const text = (v) => String(v ?? '').trim() || null;
    const issue = draft.kind === 'issue' ? {
        problem: text(draft.problem), known_facts: text(draft.knownFacts),
        unknowns: text(draft.unknowns), resolution_criteria: text(draft.resolutionCriteria),
    } : null;
    return buildCreateRequest({
        idempotencyKey,
        kind: draft.kind,
        title: draft.title,
        summary: draft.kind === 'issue' ? null : text(draft.summary),
        nextAction: text(draft.nextAction),
        priority: Number(draft.priority) || 3,
        ownerId: draft.ownerId || null,
        teamId: draft.teamId || null,
        due: draft.dueAt && draft.dueTz ? { at: draft.dueAt.length === 16 ? `${draft.dueAt}:00` : draft.dueAt, tz: draft.dueTz } : null,
        issue,
        messageIds: [],
        category: draft.category || null,
    });
}

/** الناقص في مسودة إنشاء يدوي (للعرض؛ الخادم يقرر). */
export function manualMissing(draft) {
    const missing = [];
    if (!String(draft?.title ?? '').trim()) missing.push('العنوان');
    if (draft?.kind === 'follow_up') {
        if (!String(draft?.nextAction ?? '').trim()) missing.push('الخطوة التالية');
        if (!draft?.dueAt) missing.push('الموعد');
    }
    if (draft?.kind === 'issue' && !String(draft?.problem ?? '').trim()) missing.push('وصف المشكلة');
    return missing;
}

// ─────────────────────────────────────────────────────────────
// إعدادات الاستمرارية (078) — نموذج مالك المنصة. يحسب الفرق فقط؛ الخادم يتحقق ويرفض.
// ─────────────────────────────────────────────────────────────
export const POLICY_NUMBER_FIELDS = Object.freeze([
    { key: 'escalate_after_minutes', label: 'تصعيد بعد تأخير (دقائق)', nullable: true },
    { key: 'overdue_repeat_minutes', label: 'تكرار التنبيه أثناء التأخير كل (دقائق، فاضي = لا)', nullable: true },
    { key: 'overdue_repeat_max', label: 'أقصى عدد للتكرار' },
    { key: 'handover_remind_after_minutes', label: 'تسليم معلّق: تذكير بعد (دقائق)', nullable: true },
    { key: 'handover_escalate_after_minutes', label: 'تسليم معلّق: تصعيد بعد (دقائق)', nullable: true },
    { key: 'stale_after_days', label: 'سجل بلا نشاط بعد (أيام)' },
    { key: 'postpone_flag_count', label: 'تأجيل متكرر بعد (مرات)' },
]);
export const POLICY_BOOL_FIELDS = Object.freeze([
    { key: 'due_alert', label: 'إشعار عند حلول الموعد' },
    { key: 'respect_working_hours', label: 'التصعيد يراعي ساعات العمل' },
]);

/**
 * values: قيم النموذج كنصوص/منطقيات ({ handovers_enabled: true, reminder_offsets_minutes: '60, 15', ... }).
 * يرجع { patch, errors }: patch = المتغير فقط عن policy. errors = [{ field, reason }] قبل الإرسال.
 */
export function policyPatchFromForm(values, policy) {
    const patch = {};
    const errors = [];
    const p = policy || {};
    for (const c of Object.keys(CAPABILITY_LABELS)) {
        const k = `${c}_enabled`;
        if (k in values && Boolean(values[k]) !== Boolean(p[k])) patch[k] = Boolean(values[k]);
    }
    for (const { key } of POLICY_BOOL_FIELDS) {
        if (key in values && Boolean(values[key]) !== Boolean(p[key])) patch[key] = Boolean(values[key]);
    }
    for (const { key, nullable } of POLICY_NUMBER_FIELDS) {
        if (!(key in values)) continue;
        const raw = String(values[key] ?? '').trim();
        let v;
        if (raw === '') {
            if (!nullable) { errors.push({ field: key, reason: 'required' }); continue; }
            v = null;
        } else if (!/^\d+$/.test(raw)) {
            errors.push({ field: key, reason: 'integer_expected' });
            continue;
        } else v = Number(raw);
        if (v !== (p[key] ?? null)) patch[key] = v;
    }
    if ('reminder_offsets_minutes' in values) {
        const raw = String(values.reminder_offsets_minutes ?? '').trim();
        const parts = raw ? raw.split(/[\s,،]+/).filter(Boolean) : [];
        if (parts.some((x) => !/^\d+$/.test(x))) errors.push({ field: 'reminder_offsets_minutes', reason: 'integer_expected' });
        else {
            const list = [...new Set(parts.map(Number))].sort((a, b) => b - a);
            const cur = Array.isArray(p.reminder_offsets_minutes) ? p.reminder_offsets_minutes : [];
            if (JSON.stringify(list) !== JSON.stringify([...cur].sort((a, b) => b - a))) patch.reminder_offsets_minutes = list;
        }
    }
    if ('escalation_recipients' in values && values.escalation_recipients !== p.escalation_recipients) {
        patch.escalation_recipients = values.escalation_recipients;
    }
    return { patch, errors };
}
