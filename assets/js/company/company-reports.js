/**
 * company-reports.js — تقارير الشركة.
 *
 * مستوحى من «الإحصائيات» في لوحة الإدارة، لكن بمقاييس تخصّ صاحب الشركة لا
 * مشغّل المنصة: لا أعداد مستخدمين عامة ولا إيرادات، بل حالة دعمه واشتراكه
 * وفريقه. كل رقم هنا محسوب من صفوف **رآها المستخدم فعلًا** عبر RLS — لا
 * استعلام تجميعي جديد ولا صلاحية إضافية.
 *
 * الأرقام تُمرَّر إليه محسوبة من اللوحة (نفس البيانات المعروضة في الأقسام)،
 * فالتقرير لا يعيد الجلب ولا يخترع مصدرًا ثانيًا للحقيقة.
 */

import { escapeHtml, formatDate, renderState } from '/assets/js/customer/portal-ui.js';
import { statusInfo, isClosed, needsCustomerReply } from '/assets/js/customer/ticket-view-model.js';
import { summarizeSubscriptions, registrationInfo } from '/assets/js/company/company-model.js';

/**
 * ملخّص مسار تذاكر — دالة خالصة، مُختبَرة بمعزل.
 * @param {Array} tickets
 * @param {string} userId هوية الحساب، لتمييز «بانتظار ردّك»
 */
export function summarizeTickets(tickets, userId) {
    const rows = Array.isArray(tickets) ? tickets : [];
    const byStatus = {};
    for (const ticket of rows) {
        const key = ticket?.status || 'unknown';
        byStatus[key] = (byStatus[key] || 0) + 1;
    }

    const open = rows.filter(t => !isClosed(t));
    const awaiting = rows.filter(t => needsCustomerReply(t, userId));

    // متوسط زمن أول استجابة بالساعات — يُحسب من التذاكر التي استُجيب لها فقط،
    // فلا تُخفّض التذاكر المفتوحة المتوسط زورًا.
    const responded = rows.filter(t => t.first_response_at && t.created_at);
    const avgHours = responded.length
        ? responded.reduce((sum, t) =>
              sum + (new Date(t.first_response_at) - new Date(t.created_at)) / 3600000, 0) / responded.length
        : null;

    return {
        total: rows.length,
        open: open.length,
        closed: rows.length - open.length,
        awaiting: awaiting.length,
        byStatus,
        responded: responded.length,
        avgFirstResponseHours: avgHours == null ? null : Math.round(avgHours * 10) / 10
    };
}

/** صياغة زمن الاستجابة بوحدة مقروءة. */
export function formatResponseTime(hours) {
    if (hours == null) return '—';
    if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} دقيقة`;
    if (hours < 48) return `${hours} ساعة`;
    return `${Math.round(hours / 24)} يوم`;
}

export function renderCompanyReports({ dashboard, platformTickets, customerTickets, members, userId }) {
    const container = document.getElementById('companyReports');
    if (!container) return;

    if (!dashboard) {
        renderState(container, {
            variant: 'empty',
            title: 'لا توجد بيانات لعرضها',
            text: 'تظهر التقارير بعد ربط شركتك واشتراكها.'
        });
        return;
    }

    const platform = summarizeTickets(platformTickets, userId);
    const customers = summarizeTickets(customerTickets, userId);
    const subs = summarizeSubscriptions(dashboard.subscriptions);
    const registration = registrationInfo(dashboard.registration);
    const memberRows = Array.isArray(members) ? members : [];

    const kpi = (label, value, hint, tone = '') => `
        <div class="kpi ${tone}">
            <p class="kpi-label">${escapeHtml(label)}</p>
            <p class="kpi-value">${escapeHtml(String(value))}</p>
            <p class="kpi-hint">${escapeHtml(hint)}</p>
        </div>`;

    const statusRows = (summary, emptyText) => {
        const entries = Object.entries(summary.byStatus);
        if (!entries.length) return `<p class="panel-subtitle">${escapeHtml(emptyText)}</p>`;
        return `
            <ul class="company-sub-list">
                ${entries.map(([status, count]) => {
                    const info = statusInfo(status);
                    const percent = Math.round((count / summary.total) * 100);
                    return `
                    <li class="company-sub">
                        <div class="company-sub-main">
                            <p class="company-sub-plan">${escapeHtml(info.label)}</p>
                            <p class="company-sub-dates">${percent}% من الإجمالي</p>
                        </div>
                        <div class="company-sub-side">
                            <span class="pill ${escapeHtml(info.pill)}">${escapeHtml(String(count))}</span>
                        </div>
                    </li>`;
                }).join('')}
            </ul>`;
    };

    container.innerHTML = `
        <div class="kpi-grid">
            ${kpi('تذاكر مفتوحة مع مدعوم', platform.open,
                  platform.awaiting ? `${platform.awaiting} بانتظار ردّك` : 'لا شيء ينتظر ردّك',
                  platform.awaiting ? 'kpi--warning' : '')}
            ${kpi('تذاكر عملاء مفتوحة', customers.open,
                  `${customers.total} تذكرة من عملائك إجمالًا`,
                  customers.open ? 'kpi--warning' : '')}
            ${kpi('متوسط أول استجابة لعملائك', formatResponseTime(customers.avgFirstResponseHours),
                  customers.responded ? `محسوب على ${customers.responded} تذكرة` : 'لا استجابات بعد')}
            ${kpi('مستخدمو الشركة', memberRows.length, 'الحسابات التابعة لشركتك')}
            ${kpi('اشتراكات فعّالة', subs.active,
                  subs.daysToNearestExpiry == null ? 'لا اشتراك فعّال' : `أقرب انتهاء بعد ${subs.daysToNearestExpiry} يوم`,
                  subs.active ? 'kpi--success' : 'kpi--danger')}
            ${kpi('السجل التجاري', registration.label,
                  registration.hasDate ? `ينتهي في ${formatDate(dashboard.registration.expiry_date)}` : 'غير مسجّل',
                  registration.tone === 'danger' ? 'kpi--danger' : (registration.tone === 'warning' ? 'kpi--warning' : ''))}
        </div>

        <div class="split-grid">
            <section class="panel" aria-labelledby="reportPlatformHeading">
                <div class="panel-header">
                    <div>
                        <h2 class="panel-title" id="reportPlatformHeading">تذاكري مع مدعوم — حسب الحالة</h2>
                        <p class="panel-subtitle">${escapeHtml(String(platform.total))} تذكرة إجمالًا</p>
                    </div>
                </div>
                ${statusRows(platform, 'لم تفتح تذاكر مع مدعوم بعد.')}
            </section>

            <section class="panel" aria-labelledby="reportCustomersHeading">
                <div class="panel-header">
                    <div>
                        <h2 class="panel-title" id="reportCustomersHeading">تذاكر العملاء — حسب الحالة</h2>
                        <p class="panel-subtitle">${escapeHtml(String(customers.total))} تذكرة إجمالًا</p>
                    </div>
                </div>
                ${statusRows(customers, 'لم يفتح عملاؤك تذاكر بعد.')}
            </section>
        </div>

        <section class="panel" aria-labelledby="reportScopeHeading">
            <div class="panel-header">
                <div>
                    <h2 class="panel-title" id="reportScopeHeading">نطاق هذه الأرقام</h2>
                    <p class="panel-subtitle">شفافية عمّا يُحسب وما لا يُحسب</p>
                </div>
            </div>
            <dl class="company-facts">
                <div class="company-fact">
                    <dt>المصدر</dt>
                    <dd>الصفوف التي يسمح بها حسابك فقط — لا بيانات شركة أخرى ولا عملاءها.</dd>
                </div>
                <div class="company-fact">
                    <dt>متوسط أول استجابة</dt>
                    <dd>يُحسب على التذاكر التي وصلها ردّ من غير صاحبها، لا على المفتوحة بلا ردّ.</dd>
                </div>
                <div class="company-fact">
                    <dt>التحديث</dt>
                    <dd>لحظي مع كل فتح للقسم — لا نسخة مخزّنة.</dd>
                </div>
            </dl>
        </section>`;
}
