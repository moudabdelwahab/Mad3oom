import { WhatsAppAPI } from '../services/whatsapp-api.js';
import { WhatsAppReports } from '../services/whatsapp-reports.js';

export class CampaignReportPage {
    constructor(container) {
        this.container = container;
        this.currentCampaign = null;
        this.reports = [];
        this.campaignsList = [];
        this.viewMode = 'list'; // 'list' or 'details'
    }

    async load(campaignData = null) {
        console.log('[CampaignReport] Loading...', campaignData);
        
        if (campaignData) {
            this.currentCampaign = campaignData;
            this.reports = campaignData.reports || [];
            this.viewMode = 'details';
            // Save to DB if it's a new campaign result
            if (!campaignData.id) {
                await WhatsAppReports.saveCampaign(campaignData, this.reports);
            }
        } else {
            this.campaignsList = await WhatsAppReports.getCampaigns();
            this.viewMode = 'list';
        }

        this.render();
    }

    async viewCampaign(id) {
        showToast('جاري تحميل تفاصيل الحملة...', 'info');
        const details = await WhatsAppReports.getCampaignDetails(id);
        if (details) {
            this.currentCampaign = details;
            this.reports = details.reports || [];
            this.viewMode = 'details';
            this.render();
        } else {
            showToast('فشل تحميل التفاصيل', 'error');
        }
    }

    render() {
        if (this.viewMode === 'list') {
            this.renderList();
        } else {
            this.renderDetails();
        }
    }

    renderList() {
        this.container.innerHTML = `
            <div class="campaign-report-page">
                <div class="section-card-header" style="margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center;">
                    <h2 style="font-size: 20px; font-weight: 700; color: var(--text-primary);">سجل التقارير</h2>
                    <button class="btn btn-primary btn-sm" onclick="navigateTo('send', document.querySelector('[data-page=send]'))">إرسال حملة جديدة</button>
                </div>

                <div class="section-card">
                    <div class="section-card-body" style="padding: 0;">
                        ${this.campaignsList.length === 0 ? `
                            <div style="text-align: center; padding: 60px 20px;">
                                <div style="font-size: 48px; margin-bottom: 16px;">📂</div>
                                <h3 style="color: var(--text-primary);">لا توجد حملات سابقة</h3>
                                <p style="color: var(--text-secondary);">ابدأ بإرسال أول حملة لك لتظهر التقارير هنا.</p>
                            </div>
                        ` : `
                            <table style="width: 100%; border-collapse: collapse; text-align: right;">
                                <thead>
                                    <tr style="background: var(--bg-surface); border-bottom: 1px solid var(--border-subtle);">
                                        <th style="padding: 16px; font-size: 13px; color: var(--text-muted);">اسم الحملة</th>
                                        <th style="padding: 16px; font-size: 13px; color: var(--text-muted);">التاريخ</th>
                                        <th style="padding: 16px; font-size: 13px; color: var(--text-muted);">الإجمالي</th>
                                        <th style="padding: 16px; font-size: 13px; color: var(--text-muted);">الحالة</th>
                                        <th style="padding: 16px; font-size: 13px; color: var(--text-muted);">الإجراء</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${this.campaignsList.map(c => `
                                        <tr style="border-bottom: 1px solid var(--border-subtle); transition: background 0.2s;" onmouseover="this.style.background='var(--bg-elevated)'" onmouseout="this.style.background='transparent'">
                                            <td style="padding: 16px; font-weight: 600;">${c.name}</td>
                                            <td style="padding: 16px; font-size: 13px; color: var(--text-secondary);">${new Date(c.created_at).toLocaleString('ar-EG')}</td>
                                            <td style="padding: 16px;">
                                                <span style="color: var(--status-success); font-weight: 600;">${c.success_count}</span> / 
                                                <span style="color: var(--status-error); font-weight: 600;">${c.fail_count}</span>
                                            </td>
                                            <td style="padding: 16px;">
                                                <span class="tag" style="background: var(--bg-surface); border: 1px solid var(--border-subtle);">مكتملة</span>
                                            </td>
                                            <td style="padding: 16px;">
                                                <button class="btn btn-ghost btn-sm" onclick="window.campaignReportPage.viewCampaign('${c.id}')" style="color: var(--brand-primary);">عرض التفاصيل</button>
                                            </td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        `}
                    </div>
                </div>
            </div>
        `;
        window.campaignReportPage = this;
    }

    renderDetails() {
        const successCount = this.reports.filter(r => r.status === 'success').length;
        const failCount = this.reports.filter(r => r.status === 'failed').length;
        const totalCount = this.reports.length;

        this.container.innerHTML = `
            <div class="campaign-report-page">
                <div style="margin-bottom: 24px; display: flex; align-items: center; gap: 12px;">
                    <button class="btn btn-ghost btn-sm" onclick="window.campaignReportPage.load()" style="padding: 8px;">
                        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 20px; height: 20px;">
                            <path d="M19 12H5M5 12L12 19M5 12L12 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                    </button>
                    <h2 style="font-size: 20px; font-weight: 700; color: var(--text-primary);">تفاصيل الحملة: ${this.currentCampaign.name || 'بدون اسم'}</h2>
                </div>

                <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; margin-bottom: 32px;">
                    <div class="section-card" style="padding: 20px; display: flex; flex-direction: column; gap: 8px;">
                        <span style="font-size: 12px; color: var(--text-muted); font-weight: 600;">إجمالي الأرقام</span>
                        <span style="font-size: 24px; font-weight: 800; color: var(--text-primary);">${totalCount}</span>
                    </div>
                    <div class="section-card" style="padding: 20px; display: flex; flex-direction: column; gap: 8px; border-right: 4px solid var(--status-success);">
                        <span style="font-size: 12px; color: var(--text-muted); font-weight: 600;">نجح الإرسال</span>
                        <span style="font-size: 24px; font-weight: 800; color: var(--status-success);">${successCount}</span>
                    </div>
                    <div class="section-card" style="padding: 20px; display: flex; flex-direction: column; gap: 8px; border-right: 4px solid var(--status-error);">
                        <span style="font-size: 12px; color: var(--text-muted); font-weight: 600;">فشل الإرسال</span>
                        <span style="font-size: 24px; font-weight: 800; color: var(--status-error);">${failCount}</span>
                    </div>
                    <div class="section-card" style="padding: 20px; display: flex; flex-direction: column; gap: 8px;">
                        <span style="font-size: 12px; color: var(--text-muted); font-weight: 600;">نسبة النجاح</span>
                        <span style="font-size: 24px; font-weight: 800; color: var(--brand-primary);">${totalCount > 0 ? Math.round((successCount/totalCount)*100) : 0}%</span>
                    </div>
                </div>

                <div class="section-card">
                    <div class="section-card-header" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
                        <div class="section-card-title">قائمة المستلمين</div>
                        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                            <div class="dropdown" style="position: relative;">
                                <button class="btn btn-secondary btn-sm" onclick="this.nextElementSibling.classList.toggle('show')" style="display: flex; align-items: center; gap: 6px;">
                                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 16px; height: 16px;">
                                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    </svg>
                                    تصدير التقرير
                                </button>
                                <div class="dropdown-menu" style="position: absolute; top: 100%; left: 0; background: var(--bg-elevated); border: 1px solid var(--border-subtle); border-radius: 8px; box-shadow: var(--shadow-lg); z-index: 10; display: none; min-width: 150px; margin-top: 4px;">
                                    <a href="#" style="display: block; padding: 10px 16px; color: var(--text-primary); text-decoration: none; font-size: 13px;" onclick="window.exportReport('excel', 'ar')">Excel (العربية)</a>
                                    <a href="#" style="display: block; padding: 10px 16px; color: var(--text-primary); text-decoration: none; font-size: 13px;" onclick="window.exportReport('excel', 'en')">Excel (English)</a>
                                    <a href="#" style="display: block; padding: 10px 16px; color: var(--text-primary); text-decoration: none; font-size: 13px;" onclick="window.exportReport('pdf', 'ar')">PDF (العربية)</a>
                                    <a href="#" style="display: block; padding: 10px 16px; color: var(--text-primary); text-decoration: none; font-size: 13px;" onclick="window.exportReport('pdf', 'en')">PDF (English)</a>
                                </div>
                            </div>
                            ${failCount > 0 ? `<button class="btn btn-primary btn-sm" onclick="window.retryFailedMessages()">إعادة إرسال الفاشل (${failCount})</button>` : ''}
                        </div>
                    </div>
                    <div class="section-card-body" style="padding: 0;">
                        <table style="width: 100%; border-collapse: collapse; text-align: right;">
                            <thead>
                                <tr style="background: var(--bg-surface); border-bottom: 1px solid var(--border-subtle);">
                                    <th style="padding: 16px; font-size: 13px; color: var(--text-muted);">الرقم</th>
                                    <th style="padding: 16px; font-size: 13px; color: var(--text-muted);">التوقيت</th>
                                    <th style="padding: 16px; font-size: 13px; color: var(--text-muted);">الحالة</th>
                                    <th style="padding: 16px; font-size: 13px; color: var(--text-muted);">التفاصيل</th>
                                    <th style="padding: 16px; font-size: 13px; color: var(--text-muted);">الإجراء</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${this.reports.map((report, index) => `
                                    <tr style="border-bottom: 1px solid var(--border-subtle); transition: background 0.2s;" onmouseover="this.style.background='var(--bg-elevated)'" onmouseout="this.style.background='transparent'">
                                        <td style="padding: 16px; font-size: 14px; font-family: monospace; direction: ltr;">${report.recipient}</td>
                                        <td style="padding: 16px; font-size: 13px; color: var(--text-secondary);">${new Date(report.sent_at || Date.now()).toLocaleTimeString('ar-EG')}</td>
                                        <td style="padding: 16px;">
                                            <span class="tag" style="background: var(--status-${report.status === 'success' ? 'success' : 'error'}-bg); color: var(--status-${report.status === 'success' ? 'success' : 'error'}); border: none;">
                                                ${report.status === 'success' ? 'تم الإرسال' : 'فشل'}
                                            </span>
                                        </td>
                                        <td style="padding: 16px;">
                                            ${report.status === 'failed' ? `
                                                <button class="btn btn-ghost btn-sm" style="color: var(--status-error); padding: 4px 8px; font-size: 12px;" onclick="alert('تفاصيل الخطأ: ${report.error_message || 'خطأ غير معروف'}')">التفاصيل</button>
                                            ` : '<span style="color: var(--text-muted); font-size: 12px;">✓ مكتمل</span>'}
                                        </td>
                                        <td style="padding: 16px;">
                                            ${report.status === 'failed' ? `
                                                <button class="btn btn-ghost btn-sm" onclick="window.retrySingleMessage(${index})" style="color: var(--brand-primary); padding: 4px 8px;">إعادة</button>
                                            ` : '-'}
                                        </td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
            <style>
                .dropdown-menu.show { display: block !important; }
            </style>
        `;

        this.setupEventListeners();
    }

    setupEventListeners() {
        window.exportReport = async (format, lang) => {
            showToast(`جاري تحضير ملف ${format.toUpperCase()}...`, 'info');
            
            const headers = lang === 'ar' 
                ? ['الرقم', 'التوقيت', 'الحالة', 'التفاصيل'] 
                : ['Phone Number', 'Time', 'Status', 'Details'];
            
            const data = this.reports.map(r => [
                r.recipient,
                new Date(r.sent_at || Date.now()).toLocaleString(lang === 'ar' ? 'ar-EG' : 'en-US'),
                r.status === 'success' ? (lang === 'ar' ? 'نجاح' : 'Success') : (lang === 'ar' ? 'فشل' : 'Failed'),
                r.status === 'success' ? (lang === 'ar' ? 'مكتمل' : 'Completed') : (r.error_message || (lang === 'ar' ? 'خطأ' : 'Error'))
            ]);

            if (format === 'excel') {
                this.exportToExcel(headers, data, lang);
            } else {
                this.exportToPDF(headers, data, lang);
            }
        };

        window.retrySingleMessage = async (index) => {
            const report = this.reports[index];
            showToast(`جاري إعادة الإرسال إلى ${report.recipient}...`, 'info');
            try {
                const result = await WhatsAppAPI.sendTemplate({
                    to: report.recipient,
                    templateName: this.currentCampaign.template_name,
                    languageCode: this.currentCampaign.language_code || 'ar'
                });
                if (result && result.messages) {
                    showToast('تمت إعادة الإرسال بنجاح', 'success');
                    // Update in DB could be added here
                }
            } catch (error) {
                showToast(`فشل الإرسال: ${error.message}`, 'error');
            }
        };
    }

    exportToExcel(headers, data, lang) {
        let csvContent = "\uFEFF"; // BOM for Excel UTF-8
        csvContent += headers.join(",") + "\n";
        data.forEach(row => {
            csvContent += row.join(",") + "\n";
        });

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", `report_${this.currentCampaign.name}_${lang}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    exportToPDF(headers, data, lang) {
        // Simple PDF generation via print or a library if available
        // For this environment, we'll use the window.print approach or a basic table layout
        const printWindow = window.open('', '_blank');
        const html = `
            <html dir="${lang === 'ar' ? 'rtl' : 'ltr'}">
            <head>
                <title>Report - ${this.currentCampaign.name}</title>
                <style>
                    body { font-family: Arial, sans-serif; padding: 40px; }
                    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
                    th, td { border: 1px solid #ddd; padding: 12px; text-align: center; }
                    th { background-color: #f4f4f4; }
                    h1 { color: #333; }
                </style>
            </head>
            <body>
                <h1>${lang === 'ar' ? 'تقرير حملة الواتساب' : 'WhatsApp Campaign Report'}</h1>
                <p><strong>${lang === 'ar' ? 'اسم الحملة' : 'Campaign Name'}:</strong> ${this.currentCampaign.name}</p>
                <p><strong>${lang === 'ar' ? 'التاريخ' : 'Date'}:</strong> ${new Date(this.currentCampaign.created_at).toLocaleString()}</p>
                <table>
                    <thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
                    <tbody>${data.map(row => `<tr>${row.map(d => `<td>${d}</td>`).join('')}</tr>`).join('')}</tbody>
                </table>
                <script>window.onload = () => { window.print(); window.close(); }</script>
            </body>
            </html>
        `;
        printWindow.document.write(html);
        printWindow.document.close();
    }
}
