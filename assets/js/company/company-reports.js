/**
 * company-reports.js — قسم تقارير التذاكر في لوحة الشركة.
 *
 * مستوحى من «الإحصائيات» في لوحة الإدارة، لكن بمقاييس تخصّ صاحب الشركة لا
 * مشغّل المنصة: لا أعداد مستخدمين عامة ولا إيرادات منصة، بل حالة دعمه
 * وفريقه وعملائه.
 *
 * كل رقم محسوب من صفوف **رآها المستخدم فعلًا** عبر RLS — لا استعلام تجميعي
 * جديد ولا صلاحية إضافية. والحساب نفسه في report-model.js (خالص ومُختبَر)،
 * فهذا الملف رسم وربط فقط.
 *
 * قاعدة حاكمة: المساران لا يُجمعان في رقم واحد أبدًا. «تذاكري مع مدعوم»
 * و«تذاكر عملائي» قراءتان متعاكستان — جمعهما يخفي أيّهما المتأخر.
 */

import { escapeHtml, formatDate, renderState } from '/assets/js/customer/portal-ui.js';
import { statusInfo, TICKET_STATUS } from '/assets/js/customer/ticket-view-model.js';
import { summarizeSubscriptions, registrationInfo } from '/assets/js/company/company-model.js';
import {
    summarizeTickets, filterTickets, byCustomer, formatDuration, periodLabel,
    defaultTimeZone, buildReportSheets, flattenSheets,
    PRIORITY_LABELS, CATEGORY_LABELS
} from '/assets/js/company/report-model.js';
import {
    downloadCsv, downloadXlsx, printReport, buildPrintDocument
} from '/assets/js/company/report-export.js';
import { ui } from '/ui-service.js';

/** يُعاد تصديرها: وحدات أخرى واختبارات قائمة تستوردها من هنا. */
export { summarizeTickets };
export const formatResponseTime = formatDuration;

/** حالة المرشّحات — محلية بالكامل، فلا إعادة جلب عند تغييرها. */
const filters = { from: '', to: '', status: 'all' };

let snapshot = null;   // آخر بيانات مرسومة، ومنها يُبنى التصدير

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

    const timeZone = defaultTimeZone();
    const platformRows = filterTickets(platformTickets, filters);
    const customerRows = filterTickets(customerTickets, filters);

    const platform = summarizeTickets(platformRows, userId, { timeZone });
    const customers = summarizeTickets(customerRows, userId, { timeZone });
    const subs = summarizeSubscriptions(dashboard.subscriptions);
    const registration = registrationInfo(dashboard.registration);
    const memberRows = Array.isArray(members) ? members : [];

    snapshot = { platformRows, customerRows, userId, timeZone, companyName: dashboard.company?.name };

    container.innerHTML = `
        ${filterBar()}

        <div class="kpi-grid">
            ${kpi('تذاكر مفتوحة مع مدعوم', platform.open,
                  platform.awaiting ? `${platform.awaiting} بانتظار ردّك` : 'لا شيء ينتظر ردّك',
                  platform.awaiting ? 'kpi--warning' : '')}
            ${kpi('تذاكر عملاء مفتوحة', customers.open,
                  `${customers.total} تذكرة من عملائك إجمالًا`,
                  customers.open ? 'kpi--warning' : '')}
            ${kpi('متوسط أول استجابة لعملائك', formatDuration(customers.avgFirstResponseHours),
                  customers.responded ? `محسوب على ${customers.responded} تذكرة` : 'لا استجابات بعد')}
            ${kpi('متوسط زمن الإغلاق لعملائك', formatDuration(customers.avgResolutionHours),
                  customers.resolved ? `محسوب على ${customers.resolved} تذكرة مغلقة` : 'لا إغلاقات بعد')}
            ${kpi('مستخدمو الشركة', memberRows.length, 'الحسابات التابعة لشركتك')}
            ${kpi('اشتراكات فعّالة', subs.active,
                  subs.daysToNearestExpiry == null ? 'لا اشتراك فعّال' : `أقرب انتهاء بعد ${subs.daysToNearestExpiry} يوم`,
                  subs.active ? 'kpi--success' : 'kpi--danger')}
            ${kpi('السجل التجاري', registration.label,
                  registration.hasDate ? `ينتهي في ${formatDate(dashboard.registration.expiry_date)}` : 'غير مسجّل',
                  registration.tone === 'danger' ? 'kpi--danger' : (registration.tone === 'warning' ? 'kpi--warning' : ''))}
        </div>

        <section class="panel" aria-labelledby="reportTotalsHeading">
            <div class="panel-header">
                <div>
                    <h2 class="panel-title" id="reportTotalsHeading">إجماليات المسارين</h2>
                    <p class="panel-subtitle">لكل مسار عموده — لا رقم مجمّع يخفي الفرق بينهما</p>
                </div>
            </div>
            ${comparisonTable('المؤشّر', [
                ['إجمالي التذاكر', platform.total, customers.total],
                ['مفتوحة', platform.open, customers.open],
                ['قيد المعالجة', platform.inProgress, customers.inProgress],
                ['مغلقة', platform.closed, customers.closed],
                ['بانتظار ردّك', platform.awaiting, customers.awaiting],
                ['متوسط أول استجابة', formatDuration(platform.avgFirstResponseHours),
                                       formatDuration(customers.avgFirstResponseHours)],
                ['متوسط زمن الإغلاق', formatDuration(platform.avgResolutionHours),
                                      formatDuration(customers.avgResolutionHours)]
            ])}
        </section>

        <div class="split-grid">
            ${distributionPanel('reportStatusHeading', 'التوزيع حسب الحالة',
                'الحالة', platform.byStatus, customers.byStatus, k => statusInfo(k).label)}
            ${distributionPanel('reportPriorityHeading', 'التوزيع حسب الأولوية',
                'الأولوية', platform.byPriority, customers.byPriority, k => PRIORITY_LABELS[k] || k)}
        </div>

        <div class="split-grid">
            ${distributionPanel('reportCategoryHeading', 'التوزيع حسب التصنيف',
                'التصنيف', platform.byCategory, customers.byCategory, k => CATEGORY_LABELS[k] || k)}
            ${distributionPanel('reportPeriodHeading', 'التوزيع حسب الفترة',
                'الشهر', platform.byPeriod, customers.byPeriod, periodLabel)}
        </div>

        ${customerBreakdown(customerRows)}

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
                    <dt>متوسط زمن الإغلاق</dt>
                    <dd>يُحسب على المغلقة التي لها طابع إغلاق مسجَّل وحدها.</dd>
                </div>
                <div class="company-fact">
                    <dt>المنطقة الزمنية</dt>
                    <dd><code>${escapeHtml(timeZone)}</code> — التجميع الشهري بتقويمك المحلي لا بالـUTC.</dd>
                </div>
                <div class="company-fact">
                    <dt>التصدير</dt>
                    <dd>يحمل نفس الصفوف المعروضة أعلاه بالضبط، بنفس المرشّحات.</dd>
                </div>
            </dl>
        </section>`;

    wireFilters({ dashboard, platformTickets, customerTickets, members, userId });
    wireExports();
}

/* ── مكوّنات العرض ───────────────────────────────────────────────────────── */

function kpi(label, value, hint, tone = '') {
    return `
        <div class="kpi ${tone}">
            <p class="kpi-label">${escapeHtml(label)}</p>
            <p class="kpi-value">${escapeHtml(String(value))}</p>
            <p class="kpi-hint">${escapeHtml(hint)}</p>
        </div>`;
}

function filterBar() {
    const statuses = Object.entries(TICKET_STATUS)
        .map(([key, info]) => `<option value="${escapeHtml(key)}"${filters.status === key ? ' selected' : ''}>${escapeHtml(info.label)}</option>`)
        .join('');
    return `
        <section class="panel" aria-labelledby="reportFiltersHeading">
            <div class="panel-header">
                <div>
                    <h2 class="panel-title" id="reportFiltersHeading">تقارير التذاكر</h2>
                    <p class="panel-subtitle">صفِّ الفترة والحالة، ثم صدّر بنفس النطاق المعروض</p>
                </div>
                <div class="panel-head-actions">
                    <button type="button" class="btn btn-secondary btn-sm" data-export="csv">تصدير CSV</button>
                    <button type="button" class="btn btn-secondary btn-sm" data-export="xlsx">تصدير XLSX</button>
                    <button type="button" class="btn btn-secondary btn-sm" data-export="pdf">تصدير PDF</button>
                </div>
            </div>
            <div class="form-grid">
                <div class="form-field">
                    <label for="reportFrom">من تاريخ</label>
                    <input type="date" id="reportFrom" class="form-control" value="${escapeHtml(filters.from)}">
                </div>
                <div class="form-field">
                    <label for="reportTo">إلى تاريخ</label>
                    <input type="date" id="reportTo" class="form-control" value="${escapeHtml(filters.to)}">
                </div>
                <div class="form-field">
                    <label for="reportStatus">الحالة</label>
                    <select id="reportStatus" class="form-control">
                        <option value="all"${filters.status === 'all' ? ' selected' : ''}>كل الحالات</option>
                        ${statuses}
                    </select>
                </div>
                <div class="form-field is-end">
                    <button type="button" class="btn btn-secondary" id="reportReset">إعادة ضبط</button>
                </div>
            </div>
        </section>`;
}

function comparisonTable(firstHeader, rows) {
    return `
        <div class="table-scroll">
            <table class="report-table">
                <thead>
                    <tr>
                        <th scope="col">${escapeHtml(firstHeader)}</th>
                        <th scope="col">تذاكري مع مدعوم</th>
                        <th scope="col">تذاكر عملائي</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.map(([label, a, b]) => `
                        <tr>
                            <th scope="row">${escapeHtml(label)}</th>
                            <td>${escapeHtml(String(a))}</td>
                            <td>${escapeHtml(String(b))}</td>
                        </tr>`).join('')}
                </tbody>
            </table>
        </div>`;
}

function distributionPanel(headingId, title, keyHeader, platformRows, customerRows, labelOf) {
    const keys = [...new Set([...platformRows.map(r => r.key), ...customerRows.map(r => r.key)])];
    const body = keys.length
        ? comparisonTable(keyHeader, keys.map(key => [
            labelOf(key),
            platformRows.find(r => r.key === key)?.count || 0,
            customerRows.find(r => r.key === key)?.count || 0
        ]))
        : '<p class="panel-subtitle">لا تذاكر في هذا النطاق.</p>';

    return `
        <section class="panel" aria-labelledby="${headingId}">
            <div class="panel-header">
                <div><h2 class="panel-title" id="${headingId}">${escapeHtml(title)}</h2></div>
            </div>
            ${body}
        </section>`;
}

function customerBreakdown(customerRows) {
    const rows = byCustomer(customerRows);
    if (!rows.length) {
        return `
        <section class="panel" aria-labelledby="reportCustomersHeading">
            <div class="panel-header">
                <div><h2 class="panel-title" id="reportCustomersHeading">التذاكر حسب العميل</h2></div>
            </div>
            <p class="panel-subtitle">لم يفتح عملاؤك تذاكر في هذا النطاق.</p>
        </section>`;
    }
    return `
        <section class="panel" aria-labelledby="reportCustomersHeading">
            <div class="panel-header">
                <div>
                    <h2 class="panel-title" id="reportCustomersHeading">التذاكر حسب العميل</h2>
                    <p class="panel-subtitle">${rows.length} عميلًا فتحوا تذاكر في هذا النطاق</p>
                </div>
            </div>
            <div class="table-scroll">
                <table class="report-table">
                    <thead>
                        <tr>
                            <th scope="col">العميل</th><th scope="col">إجمالي</th>
                            <th scope="col">مفتوحة</th><th scope="col">مغلقة</th>
                            <th scope="col">متوسط أول استجابة</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.map(c => `
                            <tr>
                                <th scope="row">
                                    ${escapeHtml(c.name)}
                                    ${c.email ? `<span class="is-muted"> · ${escapeHtml(c.email)}</span>` : ''}
                                </th>
                                <td>${c.total}</td>
                                <td>${c.open}</td>
                                <td>${c.closed}</td>
                                <td>${escapeHtml(formatDuration(c.avgFirstResponseHours))}</td>
                            </tr>`).join('')}
                    </tbody>
                </table>
            </div>
        </section>`;
}

/* ── الربط ───────────────────────────────────────────────────────────────── */

function wireFilters(context) {
    const rerender = () => renderCompanyReports(context);

    document.getElementById('reportFrom')?.addEventListener('change', (e) => {
        filters.from = e.target.value; rerender();
    });
    document.getElementById('reportTo')?.addEventListener('change', (e) => {
        filters.to = e.target.value; rerender();
    });
    document.getElementById('reportStatus')?.addEventListener('change', (e) => {
        filters.status = e.target.value; rerender();
    });
    document.getElementById('reportReset')?.addEventListener('click', () => {
        filters.from = ''; filters.to = ''; filters.status = 'all'; rerender();
    });
}

function fileStamp() {
    return new Date().toISOString().slice(0, 10);
}

function currentSheets() {
    return buildReportSheets({
        platformTickets: snapshot.platformRows,
        customerTickets: snapshot.customerRows,
        userId: snapshot.userId,
        timeZone: snapshot.timeZone,
        filters
    });
}

function wireExports() {
    document.querySelectorAll('[data-export]').forEach(btn => {
        btn.addEventListener('click', () => onExport(btn.getAttribute('data-export'), btn));
    });
}

async function onExport(format, btn) {
    if (!snapshot) return;
    const sheets = currentSheets();
    const name = `tickets-report-${fileStamp()}`;

    const original = btn.textContent;
    btn.disabled = true;

    try {
        if (format === 'csv') {
            downloadCsv(flattenSheets(sheets), `${name}.csv`);
        } else if (format === 'xlsx') {
            btn.textContent = 'جارٍ التحضير…';
            await downloadXlsx(sheets, `${name}.xlsx`);
        } else if (format === 'pdf') {
            const opened = printReport(buildPrintDocument({
                title: 'تقرير التذاكر',
                subtitle: snapshot.companyName || 'لوحة الشركة',
                meta: [
                    ['من', filters.from || 'البداية'],
                    ['إلى', filters.to || 'اليوم'],
                    ['الحالة', filters.status === 'all' ? 'كل الحالات' : statusInfo(filters.status).label],
                    ['المنطقة الزمنية', snapshot.timeZone],
                    ['تاريخ الإصدار', formatDate(new Date().toISOString())]
                ],
                sections: sheets
            }));
            if (!opened) {
                ui?.showToast?.('المتصفح منع فتح نافذة الطباعة. اسمح بالنوافذ المنبثقة ثم أعد المحاولة.', 'error');
            }
        }
    } catch (err) {
        ui?.showToast?.(err?.message || 'تعذّر التصدير', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = original;
    }
}
