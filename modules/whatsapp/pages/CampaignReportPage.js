import { WhatsAppAPI } from '../services/whatsapp-api.js';

export class CampaignReportPage {
    constructor(container) {
        this.container = container;
        this.currentCampaign = null;
        this.reports = []; // Array of {recipient, status, time, error, template}
    }

    async load(campaignData = null) {
        console.log('[CampaignReport] Loading data...', campaignData);
        
        if (campaignData) {
            this.currentCampaign = campaignData;
            this.reports = campaignData.reports || [];
        } else {
            // Try to load last campaign from localStorage if no data provided
            const saved = localStorage.getItem('mad3oom_last_campaign');
            if (saved) {
                try {
                    this.currentCampaign = JSON.parse(saved);
                    this.reports = this.currentCampaign.reports || [];
                    console.log('[CampaignReport] Loaded from localStorage:', this.currentCampaign);
                } catch (e) {
                    console.error('[CampaignReport] Error parsing saved campaign:', e);
                }
            }
        }

        if (!this.currentCampaign) {
            this.container.innerHTML = `
                <div style="text-align: center; padding: 100px 20px;">
                    <div style="font-size: 64px; margin-bottom: 20px;">📊</div>
                    <h3 style="margin-bottom: 10px; color: var(--text-primary);">لا توجد تقارير متاحة</h3>
                    <p style="color: var(--text-secondary); margin-bottom: 24px;">ابدأ بإرسال حملة جديدة لعرض التقارير هنا.</p>
                    <button class="btn btn-primary" onclick="navigateTo('send', document.querySelector('[data-page=send]'))">إرسال حملة جديدة</button>
                </div>
            `;
            return;
        }

        this.render();
    }

    render() {
        const successCount = this.reports.filter(r => r.status === 'success').length;
        const failCount = this.reports.filter(r => r.status === 'failed').length;
        const totalCount = this.reports.length;

        this.container.innerHTML = `
            <div class="campaign-report-page">
                <!-- Header Stats -->
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

                <!-- Report Table -->
                <div class="section-card">
                    <div class="section-card-header" style="display: flex; justify-content: space-between; align-items: center;">
                        <div class="section-card-title">
                            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                <polyline points="14 2 14 8 20 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                <line x1="16" y1="13" x2="8" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                <line x1="16" y1="17" x2="8" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                <polyline points="10 9 9 9 8 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                            تفاصيل الحملة: ${this.currentCampaign.name || 'بدون اسم'}
                        </div>
                        <div style="display: flex; gap: 10px;">
                            <button class="btn btn-secondary btn-sm" onclick="window.exportReportCSV()">تصدير CSV</button>
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
                                    <th style="padding: 16px; font-size: 13px; color: var(--text-muted);">السبب/التفاصيل</th>
                                    <th style="padding: 16px; font-size: 13px; color: var(--text-muted);">الإجراء</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${this.reports.map((report, index) => `
                                    <tr style="border-bottom: 1px solid var(--border-subtle); transition: background 0.2s;" onmouseover="this.style.background='var(--bg-elevated)'" onmouseout="this.style.background='transparent'">
                                        <td style="padding: 16px; font-size: 14px; font-family: monospace; direction: ltr;">${report.recipient}</td>
                                        <td style="padding: 16px; font-size: 13px; color: var(--text-secondary);">${report.time}</td>
                                        <td style="padding: 16px;">
                                            <span class="tag" style="background: var(--status-${report.status === 'success' ? 'success' : 'error'}-bg); color: var(--status-${report.status === 'success' ? 'success' : 'error'}); border: none;">
                                                ${report.status === 'success' ? 'تم الإرسال' : 'فشل'}
                                            </span>
                                        </td>
                                        <td style="padding: 16px; font-size: 13px; color: ${report.status === 'success' ? 'var(--text-muted)' : 'var(--status-error)'};">
                                            ${report.status === 'success' ? '✓ مكتمل' : (report.error || 'خطأ غير معروف')}
                                        </td>
                                        <td style="padding: 16px;">
                                            ${report.status === 'failed' ? `
                                                <button class="btn btn-ghost btn-sm" onclick="window.retrySingleMessage(${index})" style="color: var(--brand-primary); padding: 4px 8px;">
                                                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 14px; height: 14px; margin-left: 4px;">
                                                        <polyline points="23 4 23 10 17 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                                        <path d="M20.49 15a9 9 0 1 1-14.85-3.36" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                                    </svg>
                                                    إعادة
                                                </button>
                                            ` : '-'}
                                        </td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;

        this.setupEventListeners();
    }

    setupEventListeners() {
        window.retrySingleMessage = async (index) => {
            const report = this.reports[index];
            if (!report) return;

            showToast(`جاري إعادة الإرسال إلى ${report.recipient}...`, 'info');
            try {
                const result = await WhatsAppAPI.sendTemplate({
                    to: report.recipient,
                    templateName: report.template,
                    languageCode: report.language || 'ar'
                });

                if (result && result.messages) {
                    this.reports[index].status = 'success';
                    this.reports[index].error = null;
                    this.reports[index].time = new Date().toLocaleTimeString('ar-SA');
                    showToast('تمت إعادة الإرسال بنجاح', 'success');
                    this.saveAndRender();
                }
            } catch (error) {
                showToast(`فشل الإرسال مجدداً: ${error.message}`, 'error');
            }
        };

        window.retryFailedMessages = async () => {
            const failed = this.reports.filter(r => r.status === 'failed');
            if (failed.length === 0) return;

            if (!confirm(`هل تريد إعادة إرسال ${failed.length} رسالة فاشلة؟`)) return;

            showToast('جاري بدء إعادة الإرسال الجماعي...', 'info');
            let successCount = 0;

            for (let i = 0; i < this.reports.length; i++) {
                if (this.reports[i].status === 'failed') {
                    try {
                        const result = await WhatsAppAPI.sendTemplate({
                            to: this.reports[i].recipient,
                            templateName: this.reports[i].template,
                            languageCode: this.reports[i].language || 'ar'
                        });
                        if (result && result.messages) {
                            this.reports[i].status = 'success';
                            this.reports[i].error = null;
                            this.reports[i].time = new Date().toLocaleTimeString('ar-SA');
                            successCount++;
                        }
                    } catch (e) {
                        console.error('Retry failed for', this.reports[i].recipient, e);
                    }
                    // Small delay to avoid rate limiting
                    await new Promise(r => setTimeout(r, 200));
                }
            }

            showToast(`اكتملت العملية: نجح ${successCount} من أصل ${failed.length}`, 'success');
            this.saveAndRender();
        };

        window.exportReportCSV = () => {
            let csv = 'الرقم,التوقيت,الحالة,التفاصيل\n';
            this.reports.forEach(r => {
                csv += `${r.recipient},${r.time},${r.status === 'success' ? 'نجاح' : 'فشل'},${r.error || 'تم'}\n`;
            });
            
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            const url = URL.createObjectURL(blob);
            link.setAttribute('href', url);
            link.setAttribute('download', `report_${this.currentCampaign.id || 'campaign'}.csv`);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        };
    }

    saveAndRender() {
        this.currentCampaign.reports = this.reports;
        localStorage.setItem('mad3oom_last_campaign', JSON.stringify(this.currentCampaign));
        this.render();
    }
}
