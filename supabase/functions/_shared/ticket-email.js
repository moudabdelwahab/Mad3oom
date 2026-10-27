/**
 * ticket-email.js — قوالب بريد التذاكر بهوية مدعوم (وحدة خالصة بلا Deno، مُختبَرة في tests/ticket-email.test.mjs).
 *
 * قالب واحد لكل رسائل المنصة الخاصة بالتذاكر: الرأس (الشعار + نوع الإشعار + رقم التذكرة)، التحية،
 * بطاقة الحالة، تفاصيل التذكرة، زر «عرض التذكرة»، التوقيع والتذييل. يتغير العنوان والنص والبيانات
 * بحسب الحدث فقط، فلا تختلف رسالة عن أخرى في الشكل.
 *
 * البيانات تأتي من صف التذكرة الفعلي (handler.js في send-ticket-email يقرؤه من القاعدة)، لا من القالب:
 *   - الحالات = قيد tickets_status_check كما هو (open، in-progress، resolved، confirmed، rejected، closed)،
 *     بأسماء لوحة العميل نفسها (assets/js/customer/ticket-view-model.js). حالة خارج القائمة تُعرض «غير محددة».
 *   - الحقل الغائب لا يظهر صفّه؛ لا قيم افتراضية مضلِّلة.
 *
 * التوافق: جداول متداخلة وCSS مضمّن لكل عنصر مهم (Gmail وOutlook)، و<style> للشاشات الصغيرة فقط
 * تحسينًا لا اعتمادًا. لا JavaScript ولا Flexbox/Grid ولا صور غير الشعار.
 *
 * الأمان: كل نص من خارج القالب يُهرَّب (عنوان التذكرة ونص الرد واسم العميل والشركة). الاستثناء الوحيد
 * messageHtml في رسائل الطاقم (CUSTOM وسير العمل): HTML يكتبه الأدمن/الدعم كما كان قبل القالب.
 * الرابط لا يحمل إلا معرّف التذكرة؛ فتحها يمر بتسجيل الدخول وسياسات RLS كأي زيارة للوحة.
 */

export const BRAND = Object.freeze({
    nameAr: 'مدعوم',
    nameEn: 'Mad3oom',
    color: '#0077CC',        // --color-accent في color-system.css
    colorDark: '#003366',    // --color-primary
    supportEmail: 'support@mad3oom.com',
    linkedin: 'https://www.linkedin.com/company/mad3oom/'
});

export const DEFAULT_SITE_ORIGIN = 'https://mad3oom.com';
export const LOGO_PATH = '/assets/images/email/mad3oom-logo.png';
export const TICKET_PATH = '/customer-dashboard.html';
export const DEFAULT_TIME_ZONE = 'Africa/Cairo';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** الحالات المعتمدة في القاعدة. closed: الحالة تُعامل كإغلاق في الرسائل. */
export const TICKET_STATUSES = Object.freeze({
    'open':        { ar: 'مفتوحة',       en: 'Open',        closed: false, icon: '•', fg: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE', dot: '#2563EB' },
    'in-progress': { ar: 'قيد المعالجة', en: 'In progress', closed: false, icon: '…', fg: '#B45309', bg: '#FFFBEB', border: '#FDE68A', dot: '#D97706' },
    'resolved':    { ar: 'تم الحل',      en: 'Resolved',    closed: true,  icon: '✓', fg: '#047857', bg: '#ECFDF5', border: '#A7F3D0', dot: '#10B981' },
    'confirmed':   { ar: 'مكتملة',       en: 'Completed',   closed: true,  icon: '✓', fg: '#15803D', bg: '#F0FDF4', border: '#BBF7D0', dot: '#16A34A' },
    'rejected':    { ar: 'مرفوضة',       en: 'Rejected',    closed: true,  icon: '✕', fg: '#B91C1C', bg: '#FEF2F2', border: '#FECACA', dot: '#DC2626' },
    'closed':      { ar: 'مغلقة',        en: 'Closed',      closed: true,  icon: '✓', fg: '#334155', bg: '#F8FAFC', border: '#CBD5E1', dot: '#64748B' }
});
const UNKNOWN_STATUS = Object.freeze({ ar: 'غير محددة', en: 'Unknown', closed: false, icon: '•', fg: '#334155', bg: '#F8FAFC', border: '#CBD5E1', dot: '#64748B' });

export const TICKET_TYPES = Object.freeze({
    problem: { ar: 'مشكلة', en: 'Problem' },
    inquiry: { ar: 'استفسار', en: 'Inquiry' }
});

/** أسماء التصنيفات كما في لوحة الإدارة (assets/js/admin/tickets.js). غير المعروف يُعرض كما هو. */
export const TICKET_CATEGORIES = Object.freeze({
    whatsapp: { ar: 'واتساب', en: 'WhatsApp' },
    tickets: { ar: 'تذاكر', en: 'Tickets' },
    subscription: { ar: 'اشتراك', en: 'Subscription' },
    whatsapp_wallet_topup: { ar: 'شحن رصيد واتساب', en: 'WhatsApp wallet top-up' },
    login: { ar: 'تسجيل الدخول', en: 'Login' },
    api: { ar: 'API', en: 'API' },
    other: { ar: 'أخرى', en: 'Other' }
});

export const statusInfo = (status) => TICKET_STATUSES[status] || UNKNOWN_STATUS;

const COPY = {
    ar: {
        dir: 'rtl', start: 'right', end: 'left', lang: 'ar',
        tagline: 'منصة دعم وإدارة العملاء',
        ticketNo: 'رقم التذكرة',
        hello: (name) => name ? `مرحبًا ${name}،` : 'مرحبًا،',
        currentStatus: 'الحالة الحالية',
        updatedAt: 'تم التحديث في',
        createdAt: 'تاريخ الإنشاء',
        fields: { number: 'رقم التذكرة', title: 'عنوان التذكرة', company: 'اسم الشركة', category: 'القسم', type: 'نوع الطلب',
                  created: 'تاريخ الإنشاء', updated: 'آخر تحديث' },
        replyLabel: 'نص الرد',
        button: 'عرض التذكرة',
        buttonHint: 'سيُطلب منك تسجيل الدخول بحسابك في مدعوم إن لم تكن مسجّلًا، ولا تُفتح التذكرة إلا لصاحب الصلاحية.',
        fallbackLink: 'إن لم يعمل الزر، انسخ هذا الرابط إلى المتصفح:',
        help: (email) => `لأي استفسار تابع المحادثة من صفحة التذكرة، أو راسلنا على ${email}.`,
        thanks: 'شكرًا لتواصلك معنا،',
        team: 'فريق مدعوم',
        website: 'الموقع الرسمي',
        why: (n) => `تصلك هذه الرسالة لأنك صاحب التذكرة #${n} على منصة مدعوم.`,
        whyCustom: 'تصلك هذه الرسالة من فريق منصة مدعوم.',
        events: {
            created:  { heading: 'تم استلام تذكرتك', subject: (n, t) => `تم استلام تذكرتك #${n}${t ? `: ${t}` : ''}`,
                        intro: (n) => `تم إنشاء تذكرتك رقم ${n} بنجاح، وسيتابعها فريق الدعم في أقرب وقت.` },
            status:   { heading: 'تحديث حالة التذكرة', subject: (n, s) => `تحديث حالة التذكرة #${n}: ${s}`,
                        intro: (n) => `نود إعلامك بأنه تم تحديث حالة تذكرتك رقم ${n}.` },
            resolved: { heading: 'تم حل تذكرتك', subject: (n) => `تم حل التذكرة #${n}`,
                        intro: (n) => `نود إعلامك بأن فريق الدعم أنهى معالجة تذكرتك رقم ${n}. إن لم تُحل المشكلة يمكنك إعادة فتحها من صفحة التذكرة.` },
            closed:   { heading: 'تم إغلاق التذكرة', subject: (n) => `تم إغلاق التذكرة #${n}`,
                        intro: (n) => `نود إعلامك بأنه تم إغلاق تذكرتك رقم ${n}. شكرًا لثقتك بنا.` },
            reopened: { heading: 'تمت إعادة فتح التذكرة', subject: (n) => `إعادة فتح التذكرة #${n}`,
                        intro: (n) => `تمت إعادة فتح تذكرتك رقم ${n}، وعادت إلى متابعة فريق الدعم.` },
            reply:    { heading: 'رد جديد على تذكرتك', subject: (n) => `رد جديد على التذكرة #${n}`,
                        intro: (n) => `أضاف فريق الدعم ردًا جديدًا على تذكرتك رقم ${n}.` },
            workflow: { heading: 'تحديث بخصوص تذكرتك', subject: (n) => `تحديث بخصوص التذكرة #${n}`,
                        intro: (n) => `لديك رسالة جديدة بخصوص تذكرتك رقم ${n}.` },
            custom:   { heading: 'رسالة من فريق مدعوم', subject: () => 'رسالة من منصة مدعوم', intro: () => '' }
        }
    },
    en: {
        dir: 'ltr', start: 'left', end: 'right', lang: 'en',
        tagline: 'Customer support & management platform',
        ticketNo: 'Ticket',
        hello: (name) => name ? `Hello ${name},` : 'Hello,',
        currentStatus: 'Current status',
        updatedAt: 'Updated on',
        createdAt: 'Created on',
        fields: { number: 'Ticket number', title: 'Ticket title', company: 'Company', category: 'Department', type: 'Request type',
                  created: 'Created on', updated: 'Last updated' },
        replyLabel: 'Reply',
        button: 'View ticket',
        buttonHint: 'You will be asked to sign in to your Mad3oom account if needed; the ticket opens only for authorised users.',
        fallbackLink: 'If the button does not work, copy this link into your browser:',
        help: (email) => `For any questions, continue the conversation on the ticket page or email us at ${email}.`,
        thanks: 'Thank you for contacting us,',
        team: 'The Mad3oom team',
        website: 'Website',
        why: (n) => `You are receiving this email because you own ticket #${n} on Mad3oom.`,
        whyCustom: 'You are receiving this email from the Mad3oom team.',
        events: {
            created:  { heading: 'We received your ticket', subject: (n, t) => `Ticket #${n} received${t ? `: ${t}` : ''}`,
                        intro: (n) => `Your ticket ${n} was created successfully. Our support team will follow up shortly.` },
            status:   { heading: 'Ticket status updated', subject: (n, s) => `Ticket #${n} status: ${s}`,
                        intro: (n) => `The status of your ticket ${n} has been updated.` },
            resolved: { heading: 'Your ticket was resolved', subject: (n) => `Ticket #${n} resolved`,
                        intro: (n) => `Our support team has finished working on your ticket ${n}. If the issue persists you can reopen it from the ticket page.` },
            closed:   { heading: 'Ticket closed', subject: (n) => `Ticket #${n} closed`,
                        intro: (n) => `Your ticket ${n} has been closed. Thank you for trusting us.` },
            reopened: { heading: 'Ticket reopened', subject: (n) => `Ticket #${n} reopened`,
                        intro: (n) => `Your ticket ${n} has been reopened and is back with our support team.` },
            reply:    { heading: 'New reply on your ticket', subject: (n) => `New reply on ticket #${n}`,
                        intro: (n) => `Our support team added a new reply to your ticket ${n}.` },
            workflow: { heading: 'Update on your ticket', subject: (n) => `Update on ticket #${n}`,
                        intro: (n) => `You have a new message about your ticket ${n}.` },
            custom:   { heading: 'A message from Mad3oom', subject: () => 'A message from Mad3oom', intro: () => '' }
        }
    }
};

export const EMAIL_EVENTS = Object.freeze(Object.keys(COPY.ar.events));

export const normalizeLocale = (locale) => (String(locale || '').toLowerCase().startsWith('en') ? 'en' : 'ar');

/** تهريب HTML لكل نص من خارج القالب. */
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** نص سطر واحد: بلا محارف تحكم (لا سطر جديد في الموضوع)، مقصوص. */
export function oneLine(value, max = 120) {
    const s = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** نص متعدد الأسطر (رد الدعم) ⇒ HTML آمن بأسطره. */
export function textToHtml(value, max = 5000) {
    const s = String(value ?? '').replace(/\r\n?/g, '\n').trim();
    const cut = s.length > max ? `${s.slice(0, max)}…` : s;
    return esc(cut).replace(/\n/g, '<br>');
}

/** أصل الموقع: https وبلا مسار، وإلا الافتراضي. */
export function siteOriginFrom(value) {
    try {
        const u = new URL(String(value || ''));
        return u.protocol === 'https:' ? u.origin : DEFAULT_SITE_ORIGIN;
    } catch { return DEFAULT_SITE_ORIGIN; }
}

/**
 * رابط التذكرة في لوحة العميل — نفس رابط الإشعارات داخل المنصة (customer-dashboard.html?ticket=<uuid>).
 * المعرّف وحده في الرابط؛ لا رمز ولا بيانات. المعرّف غير الصالح ⇒ null (فلا زر).
 */
export function ticketUrl(origin, ticketId) {
    if (!UUID_RE.test(String(ticketId || ''))) return null;
    return `${siteOriginFrom(origin)}${TICKET_PATH}?ticket=${String(ticketId).toLowerCase()}`;
}

/** تاريخ ووقت بأرقام لاتينية في توقيت المنصة («23/10/2026 - 7:54 مساءً»)، أو '' لقيمة غير صالحة. */
export function formatDateTime(value, locale = 'ar', timeZone = DEFAULT_TIME_ZONE) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    let parts;
    try {
        parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
            day: '2-digit', month: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone
        }).formatToParts(d).map(p => [p.type, p.value]));
    } catch {
        return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    }
    const pm = String(parts.dayPeriod).toUpperCase() === 'PM';
    const period = normalizeLocale(locale) === 'en' ? (pm ? 'PM' : 'AM') : (pm ? 'مساءً' : 'صباحًا');
    return `${parts.day}/${parts.month}/${parts.year} - ${parts.hour}:${parts.minute} ${period}`;
}

/**
 * نوع الرسالة لتغيير الحالة، من الحالتين الفعليتين قبل التغيير وبعده.
 * @returns {'resolved'|'closed'|'reopened'|'status'}
 */
export function statusEventKind(previousStatus, status) {
    if (status === 'resolved') return 'resolved';
    if (status === 'confirmed' || status === 'closed') return 'closed';
    if ((status === 'open' || status === 'in-progress') && previousStatus && statusInfo(previousStatus).closed
        && TICKET_STATUSES[previousStatus]) return 'reopened';
    return 'status';
}

const labelOf = (map, key, locale) => {
    if (key === null || key === undefined || key === '') return '';
    return map[key]?.[locale] || oneLine(key, 60);
};

/* ── أجزاء القالب ─────────────────────────────────────────────────────────── */

const FONT = "'Cairo','Segoe UI',Tahoma,Arial,sans-serif";

function header(c, { heading, ticketNumber, logoUrl }) {
    const brandName = c.lang === 'ar' ? BRAND.nameAr : BRAND.nameEn;
    return `
<tr><td style="padding:28px 32px 20px 32px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="${c.dir}">
    <tr>
      <td class="stack" valign="middle" style="text-align:${c.start};font-family:${FONT};">
        <div style="font-size:18px;line-height:28px;font-weight:700;color:#0F172A;">${esc(heading)}</div>
        ${ticketNumber ? `<div style="font-size:13px;line-height:22px;color:#64748B;">${esc(c.ticketNo)} <span dir="ltr">#${esc(ticketNumber)}</span></div>` : ''}
      </td>
      <td class="stack brand-cell" valign="middle" align="${c.end}" style="text-align:${c.end};font-family:${FONT};">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${c.end}" dir="${c.dir}">
          <tr>
            <td valign="middle" style="padding-${c.end}:10px;">
              <img src="${esc(logoUrl)}" width="44" height="45" alt="${esc(brandName)}" style="display:block;border:0;outline:none;text-decoration:none;width:44px;height:45px;">
            </td>
            <td valign="middle" style="text-align:${c.start};">
              <div style="font-size:24px;line-height:28px;font-weight:800;color:${BRAND.colorDark};">${esc(brandName)}</div>
              <div style="font-size:12px;line-height:18px;color:#64748B;">${esc(c.tagline)}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</td></tr>
<tr><td style="padding:0 32px;"><div style="height:1px;line-height:1px;font-size:1px;background:#E2E8F0;">&nbsp;</div></td></tr>`;
}

function statusCard(c, { status, dateLabel, dateValue }) {
    const s = statusInfo(status);
    const label = s[c.lang];
    return `
<tr><td style="padding:8px 32px 0 32px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="${c.dir}"
         style="background:${s.bg};border:1px solid ${s.border};border-radius:12px;border-collapse:separate;">
    <tr>
      <td class="stack" valign="middle" style="padding:18px 20px;text-align:${c.start};font-family:${FONT};">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" dir="${c.dir}">
          <tr>
            <td valign="middle" style="padding-${c.end}:14px;">
              <div style="width:44px;height:44px;line-height:44px;border-radius:22px;background:${s.dot};color:#FFFFFF;font-size:22px;font-weight:700;text-align:center;font-family:Arial,sans-serif;">${s.icon}</div>
            </td>
            <td valign="middle" style="text-align:${c.start};">
              <div style="font-size:14px;line-height:22px;font-weight:700;color:${s.fg};">${esc(c.currentStatus)}</div>
              <div style="font-size:24px;line-height:34px;font-weight:800;color:${s.fg};">${esc(label)}</div>
            </td>
          </tr>
        </table>
      </td>
      ${dateValue ? `
      <td class="stack status-date" valign="middle" style="padding:18px 20px;text-align:${c.end};font-family:${FONT};border-${c.start}:1px solid ${s.border};">
        <div style="font-size:14px;line-height:22px;color:#475569;">${esc(dateLabel)}</div>
        <div style="font-size:17px;line-height:28px;font-weight:600;color:#0F172A;" dir="${c.dir}">${dateHtml(dateValue)}</div>
      </td>` : ''}
    </tr>
  </table>
</td></tr>`;
}

/** «التاريخ - الوقت» بلا كسر داخل أيٍّ منهما (يُكسر السطر عند الشرطة فقط على الشاشات الضيقة). */
const dateHtml = (value) => String(value).split(' - ').map(part => `<span style="white-space:nowrap;">${esc(part)}</span>`).join(' - ');

function detailsTable(c, rows) {
    const visible = rows.filter(r => r.value !== '' && r.value !== null && r.value !== undefined);
    if (!visible.length) return '';
    const trs = visible.map(r => `
          <tr>
            <td valign="top" width="38%" style="padding:7px 0;font-size:14px;line-height:22px;color:#64748B;text-align:${c.start};font-family:${FONT};">${esc(r.label)}</td>
            <td valign="top" style="padding:7px 0;font-size:15px;line-height:22px;color:#0F172A;font-weight:600;text-align:${c.start};font-family:${FONT};word-break:break-word;"${r.ltr ? ' dir="ltr"' : ''}>${r.date ? dateHtml(r.value) : esc(r.value)}</td>
          </tr>`).join('');
    return `
<tr><td style="padding:16px 32px 0 32px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="${c.dir}"
         style="background:#F8FAFC;border-radius:12px;border-collapse:separate;">
    <tr><td style="padding:12px 20px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="${c.dir}">${trs}
      </table>
    </td></tr>
  </table>
</td></tr>`;
}

function messageBlock(c, { label, html }) {
    if (!html) return '';
    return `
<tr><td style="padding:16px 32px 0 32px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="${c.dir}"
         style="background:#FFFFFF;border:1px solid #E2E8F0;border-${c.start}:4px solid ${BRAND.color};border-radius:12px;border-collapse:separate;">
    <tr><td style="padding:16px 20px;text-align:${c.start};font-family:${FONT};font-size:15px;line-height:26px;color:#1E293B;">
      ${label ? `<div style="font-size:13px;line-height:20px;font-weight:700;color:#64748B;padding-bottom:6px;">${esc(label)}</div>` : ''}
      <div>${html}</div>
    </td></tr>
  </table>
</td></tr>`;
}

function button(c, url) {
    if (!url) return '';
    return `
<tr><td align="center" style="padding:24px 32px 8px 32px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
    <tr><td align="center" bgcolor="${BRAND.color}" style="border-radius:10px;background:${BRAND.color};">
      <a href="${esc(url)}" target="_blank" class="cta"
         style="display:inline-block;padding:14px 56px;font-family:${FONT};font-size:17px;line-height:24px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:10px;mso-padding-alt:0;">${esc(c.button)}</a>
    </td></tr>
  </table>
</td></tr>
<tr><td style="padding:6px 32px 0 32px;text-align:center;font-family:${FONT};font-size:12px;line-height:20px;color:#64748B;">${esc(c.buttonHint)}</td></tr>
<tr><td style="padding:10px 32px 0 32px;text-align:center;font-family:${FONT};font-size:12px;line-height:20px;color:#64748B;">
  ${esc(c.fallbackLink)}<br><a href="${esc(url)}" target="_blank" dir="ltr" style="color:${BRAND.color};text-decoration:underline;word-break:break-all;">${esc(url)}</a>
</td></tr>`;
}

function footer(c, { origin, logoUrl }) {
    const brandName = c.lang === 'ar' ? BRAND.nameAr : BRAND.nameEn;
    const host = origin.replace(/^https:\/\//, '');
    return `
<tr><td style="padding:20px 32px 0 32px;text-align:${c.start};font-family:${FONT};font-size:14px;line-height:22px;color:#475569;">
  ${esc(c.help(BRAND.supportEmail))}
</td></tr>
<tr><td style="padding:16px 32px 28px 32px;text-align:${c.start};font-family:${FONT};">
  <div style="font-size:15px;line-height:24px;color:#334155;">${esc(c.thanks)}</div>
  <div style="font-size:17px;line-height:26px;font-weight:800;color:${BRAND.color};">${esc(c.team)}</div>
</td></tr>
<tr><td style="background:#EEF3FA;border-radius:0 0 16px 16px;padding:18px 32px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="${c.dir}">
    <tr>
      <td class="stack" valign="middle" style="text-align:${c.start};font-family:${FONT};">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" dir="${c.dir}">
          <tr>
            <td valign="middle" style="padding-${c.end}:8px;"><img src="${esc(logoUrl)}" width="30" height="31" alt="" style="display:block;border:0;width:30px;height:31px;"></td>
            <td valign="middle" style="text-align:${c.start};">
              <div style="font-size:17px;line-height:22px;font-weight:800;color:${BRAND.colorDark};">${esc(brandName)}</div>
              <div style="font-size:11px;line-height:16px;color:#64748B;">${esc(c.tagline)}</div>
            </td>
          </tr>
        </table>
      </td>
      <td class="stack footer-links" valign="middle" style="text-align:${c.end};font-family:${FONT};font-size:13px;line-height:22px;">
        <a href="${esc(origin)}" target="_blank" style="display:inline-block;padding:0 6px;color:${BRAND.color};text-decoration:none;font-weight:600;">${esc(c.website)}</a>
        <a href="${esc(BRAND.linkedin)}" target="_blank" style="display:inline-block;padding:0 6px;color:${BRAND.color};text-decoration:none;font-weight:600;">LinkedIn</a>
        <a href="mailto:${esc(BRAND.supportEmail)}" style="display:inline-block;padding:0 6px;color:${BRAND.color};text-decoration:none;font-weight:600;" dir="ltr">${esc(BRAND.supportEmail)}</a>
        <div style="font-size:11px;line-height:16px;color:#94A3B8;padding:2px 6px 0 6px;" dir="ltr">${esc(host)}</div>
      </td>
    </tr>
  </table>
</td></tr>`;
}

function finePrint(why) {
    return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
<tr><td style="padding:14px 24px 0 24px;text-align:center;font-family:${FONT};font-size:11px;line-height:18px;color:#94A3B8;">${esc(why)}</td></tr>
</table>`;
}

function documentShell(c, { title, preheader, rows, after = '' }) {
    return `<!doctype html>
<html lang="${c.lang}" dir="${c.dir}" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(title)}</title>
<!--[if mso]><style>table,td,div,a{font-family:Tahoma,Arial,sans-serif !important;}</style><![endif]-->
<style>
  body{margin:0;padding:0;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
  table{border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0;}
  img{-ms-interpolation-mode:bicubic;}
  a[x-apple-data-detectors]{color:inherit !important;text-decoration:none !important;}
  @media only screen and (max-width:620px){
    .container{width:100% !important;border-radius:0 !important;}
    .stack{display:block !important;width:100% !important;box-sizing:border-box;}
    .brand-cell{padding-top:14px !important;}
    .brand-cell table{float:none !important;}
    .status-date{border-left:0 !important;border-right:0 !important;padding-top:0 !important;}
    .footer-links{padding-top:12px !important;}
    .cta{display:block !important;padding:14px 20px !important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background:#F1F5FB;" dir="${c.dir}">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#F1F5FB;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F1F5FB" style="background:#F1F5FB;" dir="${c.dir}">
<tr><td align="center" style="padding:24px 8px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" class="container" width="100%" cellpadding="0" cellspacing="0" border="0" dir="${c.dir}"
       style="max-width:600px;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:16px;border-collapse:separate;">
${rows}
</table>${after}
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}

/* ── الواجهة ─────────────────────────────────────────────────────────────── */

/**
 * بريد تذكرة كامل.
 *
 * @param {{
 *   event: 'created'|'status'|'resolved'|'closed'|'reopened'|'reply'|'workflow'|'custom',
 *   ticket?: { id: string, ticket_number: number|string, title?: string, status?: string, ticket_type?: string,
 *              category?: string|null, created_at?: string, last_updated_at?: string|null } | null,
 *   recipientName?: string|null,
 *   companyName?: string|null,
 *   replyText?: string|null,          // نص رد الدعم (يُهرَّب)
 *   messageHtml?: string|null,        // رسائل الطاقم وسير العمل: HTML موثوق من الأدمن/الدعم
 *   subject?: string|null,            // موضوع يحدده الطاقم (custom/workflow)
 *   locale?: string,
 *   siteOrigin?: string,
 *   logoUrl?: string,
 *   timeZone?: string,
 *   now?: Date
 * }} input
 * @returns {{ subject: string, html: string, text: string, url: string|null }}
 */
export function ticketEmail(input) {
    const locale = normalizeLocale(input?.locale);
    const c = COPY[locale];
    const event = EMAIL_EVENTS.includes(input?.event) ? input.event : 'status';
    const ev = c.events[event];
    const origin = siteOriginFrom(input?.siteOrigin);
    const logoUrl = input?.logoUrl || `${origin}${LOGO_PATH}`;
    const tz = input?.timeZone || DEFAULT_TIME_ZONE;
    const ticket = event === 'custom' ? null : (input?.ticket || null);

    const number = ticket?.ticket_number !== undefined && ticket?.ticket_number !== null ? oneLine(ticket.ticket_number, 20) : '';
    const title = oneLine(ticket?.title, 120);
    const status = ticket?.status || null;
    const statusLabel = status ? statusInfo(status)[locale] : '';
    const name = oneLine(input?.recipientName, 80);
    const url = ticket ? ticketUrl(origin, ticket.id) : null;

    const customSubject = oneLine(input?.subject, 180);
    const subject = (event === 'custom' || event === 'workflow') && customSubject
        ? customSubject
        : oneLine(ev.subject(number, event === 'created' ? oneLine(title, 80) : statusLabel), 180);
    const heading = event === 'custom' && customSubject ? customSubject : ev.heading;

    const intro = ticket ? ev.intro(number) : '';
    const introHtml = intro && number
        ? esc(intro).replace(esc(number), `<span dir="ltr" style="color:${BRAND.color};font-weight:800;">#${esc(number)}</span>`)
        : esc(intro);

    const createdAt = formatDateTime(ticket?.created_at, locale, tz);
    const updatedAt = formatDateTime(ticket?.last_updated_at, locale, tz);
    const cardDate = event === 'created'
        ? { dateLabel: c.createdAt, dateValue: createdAt }
        : { dateLabel: c.updatedAt, dateValue: updatedAt || formatDateTime(input?.now || new Date(), locale, tz) };

    const typeLabel = labelOf(TICKET_TYPES, ticket?.ticket_type, locale);
    const categoryLabel = labelOf(TICKET_CATEGORIES, ticket?.category, locale);
    const company = oneLine(input?.companyName, 120);

    const bodyHtml = event === 'reply'
        ? textToHtml(input?.replyText)
        : (event === 'custom' || event === 'workflow') ? String(input?.messageHtml || '') : '';

    const rows = [
        header(c, { heading, ticketNumber: number, logoUrl }),
        `
<tr><td style="padding:22px 32px 6px 32px;text-align:${c.start};font-family:${FONT};">
  <div style="font-size:22px;line-height:34px;font-weight:800;color:#0F172A;">${esc(c.hello(name))}</div>
  ${introHtml ? `<div style="font-size:16px;line-height:28px;color:#475569;padding-top:4px;">${introHtml}</div>` : ''}
</td></tr>`,
        ticket && status ? statusCard(c, { status, ...cardDate }) : '',
        messageBlock(c, { label: event === 'reply' ? c.replyLabel : '', html: bodyHtml }),
        ticket ? detailsTable(c, [
            { label: c.fields.number, value: number ? `#${number}` : '', ltr: true },
            { label: c.fields.title, value: title },
            { label: c.fields.company, value: company },
            { label: c.fields.category, value: categoryLabel },
            { label: c.fields.type, value: typeLabel },
            { label: c.fields.created, value: event === 'created' ? '' : createdAt, date: true },
            { label: c.fields.updated, value: event === 'created' || !updatedAt || updatedAt === createdAt ? '' : updatedAt, date: true }
        ]) : '',
        button(c, url),
        footer(c, { origin, logoUrl })
    ].join('');

    const why = ticket && number ? c.why(number) : c.whyCustom;
    const html = documentShell(c, { title: subject, preheader: intro || heading, rows, after: finePrint(why) });
    const text = ticketEmailText(c, { heading, name, intro, status: statusLabel, number, title, company, categoryLabel, typeLabel,
                                      createdAt, replyText: event === 'reply' ? input?.replyText : '', messageHtml: bodyHtml && event !== 'reply' ? bodyHtml : '', url,
                                      why });
    return { subject, html, text, url };
}

/** البديل النصي (عملاء البريد بلا HTML، وفلاتر البريد المزعج). */
function ticketEmailText(c, d) {
    const stripped = d.messageHtml
        ? String(d.messageHtml).replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim()
        : '';
    const lines = [
        d.heading,
        '',
        c.hello(d.name),
        d.intro && d.number ? d.intro.replace(d.number, `#${d.number}`) : d.intro,
        '',
        d.status ? `${c.currentStatus}: ${d.status}` : '',
        d.replyText ? `${c.replyLabel}:\n${String(d.replyText).trim()}` : '',
        stripped,
        '',
        d.number ? `${c.fields.number}: #${d.number}` : '',
        d.title ? `${c.fields.title}: ${d.title}` : '',
        d.company ? `${c.fields.company}: ${d.company}` : '',
        d.categoryLabel ? `${c.fields.category}: ${d.categoryLabel}` : '',
        d.typeLabel ? `${c.fields.type}: ${d.typeLabel}` : '',
        d.createdAt ? `${c.fields.created}: ${d.createdAt}` : '',
        '',
        d.url ? `${c.button}: ${d.url}` : '',
        d.url ? c.buttonHint : '',
        '',
        c.thanks,
        c.team,
        '',
        d.why
    ];
    return lines.filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== '')).join('\n').trim();
}
