/**
 * Relay — منطق الواجهة النقي للمرحلة C (بلا DOM ولا شبكة).
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
import { RECORD_CATEGORIES, LIMITS, buildCreateRequest, validateCreateRequest } from './relay-contract.js';

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
});
