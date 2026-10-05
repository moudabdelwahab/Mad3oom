/**
 * team-performance-model.js — أداء كل موظف دعم كدوال خالصة.
 *
 * بلا DOM وبلا شبكة: كل رقم يُحسب من صفوف رآها الطاقم فعلًا عبر RLS
 * (tickets / ticket_replies / ticket_ratings / chat_messages)، فلا استعلام
 * تجميعي جديد ولا صلاحية إضافية. والملف خالص فيُختبَر بمعزل
 * (tests/team-performance-model.test.mjs).
 *
 * ── من المسؤول عن الرقم؟ ──────────────────────────────────────────────────
 * التذكرة تُنسب لـ assigned_to — المسؤول عنها وقت القراءة. أول ردّ وزمن
 * الحل يُحسبان من أعمدة تكتبها القاعدة نفسها (first_response_at من
 * track_first_response، و resolved_at من close_ticket_in_my_scope)، لا من
 * ساعة المتصفح. والردود والمحادثات تُنسب لكاتبها (user_id / sender_id).
 *
 * ── الفترة ────────────────────────────────────────────────────────────────
 * «الحِمل الحالي» لقطة الآن بلا فترة. وكل ما عداه داخل الفترة المختارة:
 * المحلولة بلحظة حلّها، وأول ردّ بلحظة فتح التذكرة، والردود بلحظة كتابتها.
 */

// مسار نسبي عمدًا: الوحدة تُستورَد في node مباشرةً، والمسار النسبي صحيح في المتصفح أيضًا.
import { hoursBetween } from '../company/report-model.js';

/** الحالات كما تخزّنها القاعدة (migrations/034). */
export const OPEN_STATUSES = ['open', 'in-progress'];
export const RESOLVED_STATUSES = ['resolved', 'confirmed'];

export const PERIODS = {
    today: { label: 'اليوم', days: 0 },
    '7d': { label: '7 أيام', days: 7 },
    '30d': { label: '30 يوم', days: 30 },
    '90d': { label: '90 يوم', days: 90 }
};
export const DEFAULT_PERIOD = '30d';

export const ROLE_LABELS = { admin: 'أدمن', support: 'دعم فني', platform_owner: 'مالك المنصة' };

/** بداية الفترة كلحظة مطلقة. «اليوم» = منتصف الليل بتوقيت القارئ. */
export function periodStart(key, now = new Date()) {
    const p = PERIODS[key] || PERIODS[DEFAULT_PERIOD];
    const d = new Date(now.getTime());
    if (p.days === 0) { d.setHours(0, 0, 0, 0); return d; }
    return new Date(d.getTime() - p.days * 86400000);
}

const time = (iso) => { const v = iso ? new Date(iso).getTime() : NaN; return Number.isNaN(v) ? null : v; };
const within = (iso, since, now) => { const v = time(iso); return v !== null && v >= since && v <= now; };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** لحظة حل التذكرة: resolved_at، وللصفوف الأقدم من العمود آخر تحديث. */
export function resolvedAt(t) {
    return RESOLVED_STATUSES.includes(t?.status) ? (t.resolved_at || t.last_updated_at || null) : null;
}

/** تذكرة مفتوحة تجاوزت موعد الحل الآن. */
export function isOverdue(t, now = Date.now()) {
    const due = time(t?.sla_resolution_due_at);
    return OPEN_STATUSES.includes(t?.status) && due !== null && due < now;
}

/** هل حُلّت التذكرة داخل موعدها؟ null لو مالهاش موعد أو لسه ماتحلتش. */
export function metSla(t) {
    const due = time(t?.sla_resolution_due_at), done = time(resolvedAt(t));
    if (due === null || done === null) return null;
    return done <= due;
}

function ticketMetrics(tickets, { since, now }) {
    const open = tickets.filter(t => OPEN_STATUSES.includes(t.status));
    const resolved = tickets.filter(t => within(resolvedAt(t), since, now));
    const firstResponse = tickets
        .filter(t => within(t.created_at, since, now))
        .map(t => hoursBetween(t.created_at, t.first_response_at))
        .filter(h => h !== null);
    const resolution = resolved.map(t => hoursBetween(t.created_at, resolvedAt(t))).filter(h => h !== null);
    const slaChecked = resolved.map(metSla).filter(v => v !== null);
    const slaMet = slaChecked.filter(Boolean).length;
    return {
        openCount: open.length,
        inProgress: open.filter(t => t.status === 'in-progress').length,
        overdue: open.filter(t => isOverdue(t, now)).length,
        resolved: resolved.length,
        firstResponseHours: mean(firstResponse),
        resolutionHours: mean(resolution),
        sla: { met: slaMet, total: slaChecked.length, rate: slaChecked.length ? slaMet / slaChecked.length : null }
    };
}

function ratingMetrics(ratings) {
    const values = ratings.map(r => Number(r.rating)).filter(v => v >= 1 && v <= 5);
    return { average: mean(values), count: values.length };
}

/**
 * @param {object} input
 *   agents      [{ id, full_name, email, role }]  الطاقم (أدمن/دعم)
 *   tickets     صفوف tickets (assigned_to, status, created_at, first_response_at, resolved_at, sla_resolution_due_at …)
 *   replies     صفوف ticket_replies (user_id, is_internal, created_at)
 *   ratings     صفوف ticket_ratings (ticket_id, rating, created_at)
 *   chatReplies صفوف chat_messages الخاصة بردود الدعم (sender_id, created_at)
 *   since, now  حدود الفترة (Date أو ms)
 * @returns {{ team, rows }}
 */
export function buildTeamPerformance({ agents = [], tickets = [], replies = [], ratings = [], chatReplies = [], since, now = Date.now() } = {}) {
    const range = { since: +since, now: +now };
    const ticketById = new Map(tickets.map(t => [t.id, t]));
    const inPeriodRatings = ratings.filter(r => within(r.created_at, range.since, range.now));

    // موظف خرج من الطاقم وما زالت تذاكر مسندة له: يظهر كـ«موظف سابق» بدل أن تختفي تذاكره من الحساب.
    const roster = [...agents];
    for (const id of new Set(tickets.map(t => t.assigned_to).filter(Boolean))) {
        if (!roster.some(a => a.id === id)) roster.push({ id, full_name: null, email: null, role: null, former: true });
    }

    const rows = roster.map(agent => {
        const mine = tickets.filter(t => t.assigned_to === agent.id);
        const myReplies = replies.filter(r => r.user_id === agent.id && within(r.created_at, range.since, range.now));
        return {
            id: agent.id,
            name: agent.full_name || agent.email || 'موظف سابق',
            email: agent.email || '',
            role: agent.role,
            roleLabel: agent.former ? 'موظف سابق' : (ROLE_LABELS[agent.role] || agent.role || ''),
            ...ticketMetrics(mine, range),
            replies: myReplies.filter(r => !r.is_internal).length,
            notes: myReplies.filter(r => r.is_internal).length,
            chatReplies: chatReplies.filter(m => m.sender_id === agent.id && within(m.created_at, range.since, range.now)).length,
            rating: ratingMetrics(inPeriodRatings.filter(r => ticketById.get(r.ticket_id)?.assigned_to === agent.id))
        };
    });

    const team = {
        ...ticketMetrics(tickets, range),
        unassigned: tickets.filter(t => OPEN_STATUSES.includes(t.status) && !t.assigned_to).length,
        rating: ratingMetrics(inPeriodRatings),
        // ردود العملاء على تذاكرهم في نفس الجدول — الفريق = مجموع صفوف الطاقم بس.
        replies: rows.reduce((a, r) => a + r.replies, 0),
        chatReplies: rows.reduce((a, r) => a + r.chatReplies, 0)
    };
    return { team, rows };
}

/** فرز صفوف الموظفين. القيم الفارغة (لا بيانات) دايمًا تحت مهما كان الاتجاه. */
export const SORT_KEYS = {
    name: r => r.name,
    workload: r => r.openCount,
    resolved: r => r.resolved,
    firstResponse: r => r.firstResponseHours,
    resolution: r => r.resolutionHours,
    sla: r => r.sla.rate,
    replies: r => r.replies,
    chats: r => r.chatReplies,
    rating: r => r.rating.average
};
/** الاتجاه الطبيعي لكل عمود: الأقل أفضل للأزمنة، والأكثر أفضل للباقي. */
export const NATURAL_DIR = { name: 'asc', firstResponse: 'asc', resolution: 'asc' };

export function sortRows(rows, key = 'resolved', dir = NATURAL_DIR[key] || 'desc') {
    const get = SORT_KEYS[key] || SORT_KEYS.resolved;
    const sign = dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
        const va = get(a), vb = get(b);
        const ea = va === null || va === undefined, eb = vb === null || vb === undefined;
        if (ea || eb) return ea === eb ? a.name.localeCompare(b.name, 'ar') : ea ? 1 : -1;
        const c = typeof va === 'string' ? va.localeCompare(vb, 'ar') : va - vb;
        return c ? c * sign : a.name.localeCompare(b.name, 'ar');
    });
}

/** «12 د» / «3.5 س» / «2.1 يوم» — أو «—» لو مفيش بيانات. */
export function formatHours(h) {
    if (h === null || h === undefined || Number.isNaN(h)) return '—';
    if (h < 1) return `${Math.max(1, Math.round(h * 60))} د`;
    if (h < 24) return `${(Math.round(h * 10) / 10).toString()} س`;
    return `${(Math.round(h / 24 * 10) / 10).toString()} يوم`;
}

export function formatPercent(rate) {
    return rate === null || rate === undefined ? '—' : `${Math.round(rate * 100)}%`;
}

/** درجة لون نسبة الالتزام: ≥90 جيد، ≥70 تحذير، وأقل خطر. */
export function slaTone(rate) {
    if (rate === null || rate === undefined) return 'none';
    return rate >= 0.9 ? 'ok' : rate >= 0.7 ? 'warn' : 'bad';
}

/**
 * التذاكر المحلولة يوميًا لموظف واحد (آخر n يوم حتى now)، بالتقويم المحلي.
 * @returns {Array<{ day: Date, count: number }>}
 */
export function dailyResolved(tickets, agentId, { days = 14, now = new Date() } = {}) {
    const end = new Date(now.getTime()); end.setHours(0, 0, 0, 0);
    const buckets = [];
    for (let i = days - 1; i >= 0; i--) {
        const day = new Date(end.getTime()); day.setDate(end.getDate() - i);
        buckets.push({ day, count: 0 });
    }
    for (const t of tickets) {
        if (t.assigned_to !== agentId) continue;
        const v = time(resolvedAt(t)); if (v === null) continue;
        const d = new Date(v); d.setHours(0, 0, 0, 0);
        const b = buckets.find(x => x.day.getTime() === d.getTime());
        if (b) b.count++;
    }
    return buckets;
}

export function initialsOf(name) {
    return String(name || '؟').trim().split(/\s+/).slice(0, 2).map(p => p[0]).join('') || '؟';
}
