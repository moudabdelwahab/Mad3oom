/**
 * report-model.js — تحليلات تذاكر الشركة كدوال خالصة.
 *
 * بلا DOM وبلا شبكة: كل رقم يُحسب من صفوف **رآها المستخدم فعلًا** عبر RLS،
 * فلا استعلام تجميعي جديد ولا صلاحية إضافية. ولأن الملف خالص فالأرقام
 * تُختبَر بمعزل (tests/company-report-model.test.mjs).
 *
 * ── قاعدة المنتج الحاكمة ──────────────────────────────────────────────────
 * المساران لا يُجمعان في رقم واحد أبدًا:
 *     ① الشركة ↔ مدعوم   تذاكر الشركة نفسها مع المنصة
 *     ② العميل  ↔ الشركة  تذاكر عملاء الشركة معها
 * جمعهما يخفي الفرق بين «دعمي متأخر عليّ» و«أنا متأخر على عملائي» — وهما
 * قراءتان متعاكستان لنفس الرقم.
 *
 * ── التواريخ ──────────────────────────────────────────────────────────────
 * القاعدة تخزّن timestamptz (لحظة مطلقة بالـUTC). والتجميع الشهري يجب أن
 * يكون بالتقويم **المحلي** للقارئ، وإلا ظهرت تذكرة ٣١ ديسمبر ٢٣:٠٠ بتوقيت
 * الرياض في يناير. فنشتقّ المفتاح عبر Intl بمنطقة زمنية صريحة بدل
 * getMonth() المحلي أو slice(0,7) على نص الـISO — وكلاهما خاطئ بطريقة
 * مختلفة.
 */

// مسار نسبي لا مطلق — عمدًا. الوحدة خالصة ويجب أن تُستورَد في node مباشرةً
// (tests/company-report-model.test.mjs)، وnode لا يحلّ المسارات المطلقة.
// المسار النسبي صحيح في المتصفح أيضًا، فمصدر منطق التذاكر يبقى واحدًا بدل
// أن يُنسَخ هنا لمجرد إمكانية الاختبار.
import { isClosed, needsCustomerReply, statusInfo } from '../customer/ticket-view-model.js';

/** الحالات التي تُعدّ «قيد المعالجة» كما تخزّنها القاعدة. */
export const IN_PROGRESS_STATUSES = ['in-progress'];

export const PRIORITY_LABELS = {
    high: 'عالية', medium: 'متوسطة', low: 'منخفضة'
};

export const CATEGORY_LABELS = {
    technical: 'تقنية', billing: 'فوترة', subscription: 'اشتراك',
    general: 'عامة', other: 'أخرى'
};

/** المنطقة الزمنية المعتمدة افتراضيًا: منطقة القارئ نفسه. */
export function defaultTimeZone() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
        return 'UTC';
    }
}

/**
 * مفتاح تجميع زمني ثابت (YYYY-MM أو YYYY-MM-DD) بالتقويم المحلي المطلوب.
 * 'en-CA' تُخرج ISO مرتّبة تصاعديًا نصًّا، فالفرز النصّي = الفرز الزمني.
 */
export function periodKey(iso, { granularity = 'month', timeZone = 'UTC' } = {}) {
    if (!iso) return null;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;

    const opts = granularity === 'day'
        ? { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }
        : { timeZone, year: 'numeric', month: '2-digit' };
    try {
        return new Intl.DateTimeFormat('en-CA', opts).format(date);
    } catch {
        return date.toISOString().slice(0, granularity === 'day' ? 10 : 7);
    }
}

/** فارق ساعات بين لحظتين، أو null إن نقصت إحداهما أو كانت غير صالحة. */
export function hoursBetween(fromIso, toIso) {
    if (!fromIso || !toIso) return null;
    const a = new Date(fromIso).getTime();
    const b = new Date(toIso).getTime();
    if (Number.isNaN(a) || Number.isNaN(b)) return null;
    const diff = (b - a) / 3600000;
    // فارق سالب = بيانات متضاربة (أُغلقت قبل أن تُفتح). لا نُدخلها المتوسط
    // بدل أن نخفّضه زورًا.
    return diff < 0 ? null : diff;
}

function mean(values) {
    const clean = values.filter(v => v != null);
    if (!clean.length) return null;
    return Math.round((clean.reduce((s, v) => s + v, 0) / clean.length) * 10) / 10;
}

/** تصفية بمدى تاريخي وحالة — تُطبَّق قبل كل حساب فتتفق الأرقام مع التصدير. */
export function filterTickets(tickets, { from = null, to = null, status = 'all' } = {}) {
    const fromTs = from ? new Date(`${from}T00:00:00`).getTime() : null;
    const toTs = to ? new Date(`${to}T23:59:59.999`).getTime() : null;

    return (tickets || []).filter(ticket => {
        if (status !== 'all' && ticket?.status !== status) return false;
        if (fromTs == null && toTs == null) return true;
        const created = new Date(ticket?.created_at).getTime();
        if (Number.isNaN(created)) return false;
        if (fromTs != null && created < fromTs) return false;
        if (toTs != null && created > toTs) return false;
        return true;
    });
}

/** عدّ حسب مفتاح، مرتّبًا تنازليًا — أساس كل جداول التوزيع. */
export function countBy(items, keyOf) {
    const counts = new Map();
    for (const item of items || []) {
        const key = keyOf(item);
        if (key == null) continue;
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key), 'ar'));
}

/** التوزيع الزمني مرتّبًا تصاعديًا — القراءة الطبيعية لخط زمني. */
export function byPeriod(tickets, { granularity = 'month', timeZone = 'UTC' } = {}) {
    return countBy(tickets, t => periodKey(t?.created_at, { granularity, timeZone }))
        .sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

/**
 * التذاكر حسب العميل — لمسار «العميل ↔ الشركة» وحده.
 * الاسم يأتي من الصلة profiles التي تجلبها fetchMemberTickets، ولا يُستعلم
 * عنه مجددًا.
 */
export function byCustomer(tickets) {
    const rows = new Map();
    for (const ticket of tickets || []) {
        const id = ticket?.user_id;
        if (!id) continue;
        const profile = ticket.profiles || {};
        const entry = rows.get(id) || {
            id,
            name: profile.full_name || profile.email || 'عميل',
            email: profile.email || '',
            total: 0, open: 0, closed: 0, responseHours: []
        };
        entry.total += 1;
        if (isClosed(ticket)) entry.closed += 1; else entry.open += 1;
        entry.responseHours.push(hoursBetween(ticket.created_at, ticket.first_response_at));
        rows.set(id, entry);
    }
    return [...rows.values()]
        .map(r => ({ ...r, avgFirstResponseHours: mean(r.responseHours) }))
        .sort((a, b) => b.total - a.total);
}

/**
 * ملخّص مسار واحد.
 * @param {Array} tickets
 * @param {string} userId هوية الحساب، لتمييز «بانتظار ردّك»
 */
export function summarizeTickets(tickets, userId, { timeZone = 'UTC' } = {}) {
    const rows = Array.isArray(tickets) ? tickets : [];

    const open = rows.filter(t => !isClosed(t));
    const inProgress = rows.filter(t => IN_PROGRESS_STATUSES.includes(t?.status));
    const awaiting = rows.filter(t => needsCustomerReply(t, userId));

    // متوسط أول استجابة: من التذاكر التي استُجيب لها فقط، فلا تُخفّض
    // المفتوحةُ بلا ردّ المتوسطَ زورًا.
    const responseHours = rows
        .filter(t => t.first_response_at)
        .map(t => hoursBetween(t.created_at, t.first_response_at));

    // متوسط زمن الإغلاق: من المُغلقة التي لها resolved_at فقط. تذكرة مغلقة
    // بلا طابع إغلاق لا تدخل الحساب بدل أن نخمّن لها زمنًا.
    const resolutionHours = rows
        .filter(t => isClosed(t) && t.resolved_at)
        .map(t => hoursBetween(t.created_at, t.resolved_at));

    const byStatus = countBy(rows, t => t?.status || 'unknown');

    return {
        total: rows.length,
        open: open.length,
        closed: rows.length - open.length,
        inProgress: inProgress.length,
        awaiting: awaiting.length,
        byStatus,
        byPriority: countBy(rows, t => t?.priority || 'medium'),
        byCategory: countBy(rows, t => t?.category || 'other'),
        byPeriod: byPeriod(rows, { timeZone }),
        responded: responseHours.filter(v => v != null).length,
        resolved: resolutionHours.filter(v => v != null).length,
        avgFirstResponseHours: mean(responseHours),
        avgResolutionHours: mean(resolutionHours)
    };
}

/** صياغة مدّة بوحدة مقروءة. */
export function formatDuration(hours) {
    if (hours == null) return '—';
    if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} دقيقة`;
    if (hours < 48) return `${Math.round(hours * 10) / 10} ساعة`;
    return `${Math.round(hours / 24)} يوم`;
}

/** تسمية شهر بالعربي من مفتاح YYYY-MM. */
export function periodLabel(key) {
    if (!key) return '—';
    const parts = String(key).split('-');
    if (parts.length < 2) return key;
    const months = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
                    'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
    const month = months[Number(parts[1]) - 1];
    return parts.length === 3 ? `${parts[2]} ${month} ${parts[0]}` : `${month} ${parts[0]}`;
}

/* ── بناء أوراق التصدير ──────────────────────────────────────────────────── */

const DETAIL_HEADERS = [
    'رقم التذكرة', 'العنوان', 'الحالة', 'الأولوية', 'التصنيف',
    'تاريخ الإنشاء', 'أول استجابة (ساعة)', 'زمن الإغلاق (ساعة)'
];

function detailRow(ticket, { timeZone }) {
    const first = hoursBetween(ticket.created_at, ticket.first_response_at);
    const close = hoursBetween(ticket.created_at, ticket.resolved_at);
    return [
        ticket.ticket_number ?? '',
        ticket.title || '',
        statusInfo(ticket.status).label,
        PRIORITY_LABELS[ticket.priority] || ticket.priority || '',
        CATEGORY_LABELS[ticket.category] || ticket.category || '',
        periodKey(ticket.created_at, { granularity: 'day', timeZone }) || '',
        first == null ? '' : Math.round(first * 10) / 10,
        close == null ? '' : Math.round(close * 10) / 10
    ];
}

/**
 * كل أوراق التقرير من مصدر واحد.
 *
 * نفس الصفوف التي تُرسَم على الشاشة تمامًا — فالتصدير لا يمكن أن يحمل صفًّا
 * لم يره المستخدم، ولا أن يسقط صفًّا رآه. وهذا ما يجعل «نطاق البيانات
 * محفوظ» خاصيةً مُثبَتة لا وعدًا.
 */
export function buildReportSheets({
    platformTickets = [], customerTickets = [], userId, timeZone = 'UTC', filters = {}
} = {}) {
    const platform = summarizeTickets(platformTickets, userId, { timeZone });
    const customers = summarizeTickets(customerTickets, userId, { timeZone });

    const scope = [
        ['النطاق', 'المسار', 'القيمة'],
        ['الفترة', 'من', filters.from || 'البداية'],
        ['الفترة', 'إلى', filters.to || 'اليوم'],
        ['الحالة', 'المُصفّاة', filters.status && filters.status !== 'all'
            ? statusInfo(filters.status).label : 'كل الحالات'],
        ['المنطقة الزمنية', 'المعتمدة في التجميع', timeZone]
    ];

    const kpi = (label, a, b) => [label, a, b];
    const summary = [
        ['المؤشّر', 'تذاكري مع مدعوم', 'تذاكر عملائي'],
        kpi('إجمالي التذاكر', platform.total, customers.total),
        kpi('مفتوحة', platform.open, customers.open),
        kpi('قيد المعالجة', platform.inProgress, customers.inProgress),
        kpi('مغلقة', platform.closed, customers.closed),
        kpi('بانتظار ردّك', platform.awaiting, customers.awaiting),
        kpi('متوسط أول استجابة (ساعة)',
            platform.avgFirstResponseHours ?? '—', customers.avgFirstResponseHours ?? '—'),
        kpi('عدد التذاكر المحسوبة في المتوسط', platform.responded, customers.responded),
        kpi('متوسط زمن الإغلاق (ساعة)',
            platform.avgResolutionHours ?? '—', customers.avgResolutionHours ?? '—'),
        kpi('عدد التذاكر المُغلقة المحسوبة', platform.resolved, customers.resolved)
    ];

    const distribution = (title, summaryOf, labelOf) => {
        const rows = [[title, 'تذاكري مع مدعوم', 'تذاكر عملائي']];
        const keys = new Set([
            ...summaryOf(platform).map(r => r.key),
            ...summaryOf(customers).map(r => r.key)
        ]);
        for (const key of keys) {
            rows.push([
                labelOf(key),
                summaryOf(platform).find(r => r.key === key)?.count || 0,
                summaryOf(customers).find(r => r.key === key)?.count || 0
            ]);
        }
        return rows;
    };

    const sheets = [
        { name: 'نطاق التقرير', rows: scope },
        { name: 'الملخّص', rows: summary },
        { name: 'حسب الحالة',
          rows: distribution('الحالة', s => s.byStatus, k => statusInfo(k).label) },
        { name: 'حسب الأولوية',
          rows: distribution('الأولوية', s => s.byPriority, k => PRIORITY_LABELS[k] || k) },
        { name: 'حسب التصنيف',
          rows: distribution('التصنيف', s => s.byCategory, k => CATEGORY_LABELS[k] || k) },
        { name: 'حسب الفترة',
          rows: distribution('الفترة', s => s.byPeriod, k => periodLabel(k)) }
    ];

    const customerRows = byCustomer(customerTickets);
    sheets.push({
        name: 'حسب العميل',
        rows: [['العميل', 'البريد', 'إجمالي', 'مفتوحة', 'مغلقة', 'متوسط أول استجابة (ساعة)'],
            ...customerRows.map(c => [c.name, c.email, c.total, c.open, c.closed,
                c.avgFirstResponseHours ?? '—'])]
    });

    sheets.push({
        name: 'تفاصيل تذاكري مع مدعوم',
        rows: [DETAIL_HEADERS, ...platformTickets.map(t => detailRow(t, { timeZone }))]
    });
    sheets.push({
        name: 'تفاصيل تذاكر عملائي',
        rows: [[...DETAIL_HEADERS, 'العميل'],
            ...customerTickets.map(t => [...detailRow(t, { timeZone }),
                t.profiles?.full_name || t.profiles?.email || ''])]
    });

    return sheets;
}

/** ورقة واحدة مسطّحة لـCSV — ملف واحد لا يحمل أوراقًا، فنفصل بعناوين. */
export function flattenSheets(sheets) {
    const out = [];
    for (const sheet of sheets) {
        out.push([`## ${sheet.name}`]);
        for (const row of sheet.rows) out.push(row);
        out.push([]);
    }
    return out;
}
