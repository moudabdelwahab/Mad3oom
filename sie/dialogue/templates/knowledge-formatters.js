/**
 * knowledge-formatters.js
 * ------------------------------------------------------------
 * Turns structured `knowledgeData` (attached by Module 7's Knowledge
 * Resolver) into bilingual text. This is Dialogue Engine's territory —
 * the Knowledge Layer never produces text, only data; formatting that
 * data into words for a customer is exactly what belongs here.
 *
 * Each formatter only needs to know the shape of ONE source's data
 * (documented inline). Unrecognized sources return null so the caller
 * (the ANSWER template) can fall back to the scenario's static
 * resolution.text — new knowledge sources added later need a
 * corresponding case here only if their data needs custom formatting;
 * simple bilingual-text sources (like "platform_info"/"pricing") need
 * no extra work beyond the default passthrough case already handled.
 */

const TICKET_STATUS_LABELS = {
    open: { ar: 'مفتوحة', en: 'Open' },
    'in-progress': { ar: 'قيد التنفيذ', en: 'In Progress' },
    resolved: { ar: 'تم الحل', en: 'Resolved' },
    confirmed: { ar: 'مؤكدة', en: 'Confirmed' },
    rejected: { ar: 'مرفوضة', en: 'Rejected' }
};

const SUBSCRIPTION_PLAN_LABELS = {
    support: { ar: 'الدعم الفني', en: 'Support' },
    whatsapp: { ar: 'واتساب', en: 'WhatsApp' },
    bundle: { ar: 'الباقة الشاملة (دعم + واتساب)', en: 'Support + WhatsApp Bundle' }
};

const SUBSCRIPTION_STATUS_LABELS = {
    active: { ar: 'فعّال', en: 'Active' },
    expired: { ar: 'منتهي', en: 'Expired' },
    pending: { ar: 'قيد المراجعة', en: 'Pending' },
    rejected: { ar: 'مرفوض', en: 'Rejected' }
};

function formatTicketStatus(data, lang) {
    const tickets = data?.tickets || [];
    if (tickets.length === 0) {
        return lang === 'en' ? "You don't have any open tickets right now." : 'مفيش عندك أي تذاكر مفتوحة دلوقتي.';
    }
    const lines = tickets.map((t) => {
        const label = TICKET_STATUS_LABELS[t.status]?.[lang] || t.status;
        return lang === 'en'
            ? `• Ticket #${t.ticketNumber} — ${t.title} — Status: ${label}`
            : `• تذكرة #${t.ticketNumber} — ${t.title} — الحالة: ${label}`;
    });
    const header = lang === 'en' ? 'Here are your latest tickets:' : 'دي آخر تذاكرك:';
    return `${header}\n${lines.join('\n')}`;
}

function formatSubscriptionStatus(data, lang) {
    if (!data || !data.plan) {
        return lang === 'en'
            ? "It looks like you don't have a paid subscription — you're likely on the free plan."
            : 'مش لاقي عندك اشتراك مدفوع حاليًا، يبدو إنك على الخطة المجانية.';
    }
    const plan = SUBSCRIPTION_PLAN_LABELS[data.plan]?.[lang] || data.plan;
    const status = SUBSCRIPTION_STATUS_LABELS[data.status]?.[lang] || data.status;
    const cycle = data.billingCycle === 'yearly' ? (lang === 'en' ? 'yearly' : 'سنوي') : lang === 'en' ? 'monthly' : 'شهري';
    let dateInfo = '';
    if (typeof data.daysLeft === 'number') {
        dateInfo =
            lang === 'en'
                ? data.daysLeft > 0
                    ? ` (${data.daysLeft} days left)`
                    : ' (expired)'
                : data.daysLeft > 0
                  ? ` (باقي ${data.daysLeft} يوم)`
                  : ' (منتهي)';
    }
    return lang === 'en'
        ? `Your subscription: ${plan} (${cycle}) — Status: ${status}${dateInfo}`
        : `اشتراكك: ${plan} (${cycle}) — الحالة: ${status}${dateInfo}`;
}

/**
 * @param {string} source - decision.knowledgeData.source
 * @param {*} data - decision.knowledgeData.data
 * @param {'ar'|'en'} lang
 * @returns {string|null} formatted text, or null if the source isn't recognized
 */
export function formatKnowledgeData(source, data, lang) {
    if (source === 'ticket_status') return formatTicketStatus(data, lang);
    if (source === 'subscription_status') return formatSubscriptionStatus(data, lang);
    if (data && typeof data.text?.[lang] === 'string') return data.text[lang]; // "platform_info", "pricing", and any future plain-bilingual-text source
    return null;
}
