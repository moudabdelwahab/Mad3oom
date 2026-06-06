import { WhatsAppAPI } from '../services/whatsapp-api.js';
import { WhatsAppReports } from '../services/whatsapp-reports.js';

export class CampaignReportPage {
    constructor(container) {
        this.container = container;
        this.currentCampaign = null;
        this.reports = [];
        this.campaignsList = [];
        this.viewMode = 'list'; // 'list' or 'details'
        this.searchTerm = '';
        this.statusFilter = 'all';
        this.sortOrder = 'newest';
    }

    async load(campaignData = null) {
        console.log('[CampaignReport] Loading...', campaignData);
        
        if (campaignData) {
            this.currentCampaign = campaignData;
            this.reports = campaignData.reports || [];
            this.viewMode = 'details';
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
        const filteredCampaigns = this.campaignsList
            .filter(c => c.name.toLowerCase().includes(this.searchTerm.toLowerCase()))
            .sort((a, b) => {
                if (this.sortOrder === 'newest') return new Date(b.created_at) - new Date(a.created_at);
                if (this.sortOrder === 'oldest') return new Date(a.created_at) - new Date(b.created_at);
                return 0;
            });

        this.container.innerHTML = `
            <div class="campaign-report-page">
                <div class="page-header" style="margin-bottom: 32px;">
                    <div class="page-header-text">
                        <h2 style="font-size: 24px; font-weight: 800; color: var(--text-primary); letter-spacing: -0.5px;">سجل تقارير الحملات</h2>
                        <p style="color: var(--text-secondary); margin-top: 4px;">تتبع أداء حملات الواتساب الخاصة بك وتحليل النتائج.</p>
                    </div>
                    <button class="btn btn-primary" onclick="navigateTo('send', document.querySelector('[data-page=send]'))" style="display: flex; align-items: center; gap: 8px; padding: 10px 20px; border-radius: var(--radius-md); font-weight: 700;">
                        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 18px; height: 18px;">
                            <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                        إرسال حملة جديدة
                    </button>
                </div>

                <div class="section-card" style="margin-bottom: 24px; background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); overflow: hidden;">
                    <div class="section-card-header" style="padding: 16px 24px; border-bottom: 1px solid var(--border-subtle); display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.02);">
                        <div style="display: flex; gap: 16px; align-items: center; flex: 1;">
                            <div class="input-icon-wrap" style="flex: 1; max-width: 400px;">
                                <input type="text" class="form-input" placeholder="البحث عن حملة..." value="${this.searchTerm}" oninput="window.campaignReportPage.handleSearch(this.value)" style="width: 100%; padding: 10px 40px 10px 12px; background: var(--bg-elevated); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); color: var(--text-primary);">
                                <div class="inp-icon" style="right: 12px; left: auto;">
                                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 18px; height: 18px;">
                                        <circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                        <path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    </svg>
                                </div>
                            </div>
                            <select onchange="window.campaignReportPage.handleSort(this.value)" style="padding: 10px 16px; background: var(--bg-elevated); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); color: var(--text-primary); font-family: inherit; cursor: pointer;">
                                <option value="newest" ${this.sortOrder === 'newest' ? 'selected' : ''}>الأحدث أولاً</option>
                                <option value="oldest" ${this.sortOrder === 'oldest' ? 'selected' : ''}>الأقدم أولاً</option>
                            </select>
                        </div>
                    </div>
                    
                    <div class="section-card-body" style="padding: 0;">
                        ${filteredCampaigns.length === 0 ? `
                            <div style="text-align: center; padding: 80px 20px;">
                                <div style="font-size: 64px; margin-bottom: 24px; opacity: 0.5;">📂</div>
                                <h3 style="color: var(--text-primary); font-size: 18px;">لا توجد حملات متوفرة</h3>
                                <p style="color: var(--text-secondary); max-width: 300px; margin: 8px auto 24px;">ابدأ بإرسال حملتك الأولى لمتابعة تقارير الإرسال هنا.</p>
                            </div>
                        ` : `
                            <div style="overflow-x: auto;">
                                <table style="width: 100%; border-collapse: collapse; text-align: right;">
                                    <thead>
                                        <tr style="background: rgba(255,255,255,0.03); border-bottom: 1px solid var(--border-subtle);">
                                            <th style="padding: 16px 24px; font-size: 12px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">اسم الحملة</th>
                                            <th style="padding: 16px 24px; font-size: 12px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">تاريخ الإرسال</th>
                                            <th style="padding: 16px 24px; font-size: 12px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">القالب</th>
                                            <th style="padding: 16px 24px; font-size: 12px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">الإحصائيات</th>
                                            <th style="padding: 16px 24px; font-size: 12px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">الحالة</th>
                                            <th style="padding: 16px 24px; font-size: 12px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;"></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${filteredCampaigns.map(c => {
                                            const total = c.total_recipients || (c.success_count + c.fail_count);
                                            const successRate = total > 0 ? Math.round((c.success_count / total) * 100) : 0;
                                            return `
                                            <tr style="border-bottom: 1px solid var(--border-subtle); transition: all 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.02)'" onmouseout="this.style.background='transparent'">
                                                <td style="padding: 20px 24px;">
                                                    <div style="font-weight: 700; color: var(--text-primary); font-size: 14px;">${c.name}</div>
                                                    <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">ID: ${c.id.substring(0, 8)}...</div>
                                                </td>
                                                <td style="padding: 20px 24px;">
                                                    <div style="font-size: 13px; color: var(--text-primary);">${new Date(c.created_at).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
                                                    <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">${new Date(c.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}</div>
                                                </td>
                                                <td style="padding: 20px 24px;">
                                                    <span class="tag" style="background: rgba(0, 119, 204, 0.1); color: var(--brand-primary); border-color: rgba(0, 119, 204, 0.2);">${c.template_name}</span>
                                                </td>
                                                <td style="padding: 20px 24px;">
                                                    <div style="display: flex; align-items: center; gap: 12px;">
                                                        <div style="flex: 1; min-width: 100px;">
                                                            <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 4px;">
                                                                <span style="color: var(--status-success); font-weight: 700;">${c.success_count} نجاح</span>
                                                                <span style="color: var(--text-muted);">${successRate}%</span>
                                                            </div>
                                                            <div class="progress-bar-wrap" style="height: 4px; background: rgba(255,255,255,0.05);">
                                                                <div class="progress-bar-fill" style="width: ${successRate}%; height: 100%; background: var(--status-success);"></div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </td>
                                                <td style="padding: 20px 24px;">
                                                    <span class="tag" style="background: rgba(76, 175, 80, 0.1); color: var(--status-success); border: none;">
                                                        <span style="width: 6px; height: 6px; border-radius: 50%; background: var(--status-success); margin-left: 6px;"></span>
                                                        مكتملة
                                                    </span>
                                                </td>
                                                <td style="padding: 20px 24px; text-align: left;">
                                                    <button class="btn btn-ghost btn-sm" onclick="window.campaignReportPage.viewCampaign('${c.id}')" style="color: var(--brand-primary); font-weight: 700; display: inline-flex; align-items: center; gap: 4px;">
                                                        تفاصيل
                                                        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 14px; height: 14px;">
                                                            <path d="M15 18l-6-6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                                        </svg>
                                                    </button>
                                                </td>
                                            </tr>
                                        `}).join('')}
                                    </tbody>
                                </table>
                            </div>
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
        const successRate = totalCount > 0 ? Math.round((successCount / totalCount) * 100) : 0;

        const filteredReports = this.reports.filter(r => {
            const matchesSearch = r.recipient.includes(this.searchTerm);
            const matchesStatus = this.statusFilter === 'all' || r.status === this.statusFilter;
            return matchesSearch && matchesStatus;
        });

        this.container.innerHTML = `
            <div class="campaign-report-page">
                <div style="margin-bottom: 32px; display: flex; align-items: center; justify-content: space-between;">
                    <div style="display: flex; align-items: center; gap: 16px;">
                        <button class="icon-btn" onclick="window.campaignReportPage.load()" style="width: 40px; height: 40px; border-radius: 12px; background: var(--bg-elevated);">
                            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 20px; height: 20px;">
                                <path d="M19 12H5M12 19l-7-7 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                        <div>
                            <h2 style="font-size: 22px; font-weight: 800; color: var(--text-primary);">${this.currentCampaign.name}</h2>
                            <p style="color: var(--text-muted); font-size: 13px; margin-top: 2px;">تاريخ الإرسال: ${new Date(this.currentCampaign.created_at).toLocaleString('ar-EG')}</p>
                        </div>
                    </div>
                    <div style="display: flex; gap: 12px;">
                        <div class="dropdown" style="position: relative;">
                            <button class="btn btn-secondary" onclick="this.nextElementSibling.classList.toggle('show')" style="display: flex; align-items: center; gap: 8px; padding: 10px 18px; font-weight: 600;">
                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 18px; height: 18px;">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                                تصدير البيانات
                            </button>
                            <div class="dropdown-menu" style="position: absolute; top: 100%; left: 0; background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 12px; box-shadow: var(--shadow-lg); z-index: 100; display: none; min-width: 180px; margin-top: 8px; overflow: hidden;">
                                <a href="#" style="display: block; padding: 12px 16px; color: var(--text-primary); text-decoration: none; font-size: 13px; transition: background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='transparent'" onclick="window.exportReport('excel', 'ar')">Excel (العربية)</a>
                                <a href="#" style="display: block; padding: 12px 16px; color: var(--text-primary); text-decoration: none; font-size: 13px; transition: background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='transparent'" onclick="window.exportReport('pdf', 'ar')">PDF (العربية)</a>
                            </div>
                        </div>
                        ${failCount > 0 ? `
                            <button class="btn btn-primary" onclick="window.retryFailedMessages()" style="display: flex; align-items: center; gap: 8px; padding: 10px 18px; font-weight: 700;">
                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 18px; height: 18px;">
                                    <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36M20.49 15a9 9 0 0 1-14.85 3.36" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                                إعادة إرسال الفاشل (${failCount})
                            </button>
                        ` : ''}
                    </div>
                </div>

                <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; margin-bottom: 32px;">
                    <div class="card" style="padding: 24px; display: flex; flex-direction: column; gap: 12px; background: var(--bg-card); border-radius: var(--radius-lg);">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <span style="font-size: 13px; color: var(--text-muted); font-weight: 600;">إجمالي المستلمين</span>
                            <div style="width: 32px; height: 32px; border-radius: 8px; background: rgba(0, 119, 204, 0.1); color: var(--brand-primary); display: flex; align-items: center; justify-content: center;">
                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 18px; height: 18px;">
                                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm14 14v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </div>
                        </div>
                        <span style="font-size: 28px; font-weight: 800; color: var(--text-primary);">${totalCount}</span>
                    </div>
                    <div class="card" style="padding: 24px; display: flex; flex-direction: column; gap: 12px; background: var(--bg-card); border-radius: var(--radius-lg); border-right: 4px solid var(--status-success);">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <span style="font-size: 13px; color: var(--text-muted); font-weight: 600;">تم التسليم بنجاح</span>
                            <div style="width: 32px; height: 32px; border-radius: 8px; background: rgba(76, 175, 80, 0.1); color: var(--status-success); display: flex; align-items: center; justify-content: center;">
                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 18px; height: 18px;">
                                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4L12 14.01l-3-3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </div>
                        </div>
                        <span style="font-size: 28px; font-weight: 800; color: var(--status-success);">${successCount}</span>
                    </div>
                    <div class="card" style="padding: 24px; display: flex; flex-direction: column; gap: 12px; background: var(--bg-card); border-radius: var(--radius-lg); border-right: 4px solid var(--status-error);">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <span style="font-size: 13px; color: var(--text-muted); font-weight: 600;">فشل الإرسال</span>
                            <div style="width: 32px; height: 32px; border-radius: 8px; background: rgba(244, 67, 54, 0.1); color: var(--status-error); display: flex; align-items: center; justify-content: center;">
                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 18px; height: 18px;">
                                    <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    <line x1="15" y1="9" x2="9" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    <line x1="9" y1="9" x2="15" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </div>
                        </div>
                        <span style="font-size: 28px; font-weight: 800; color: var(--status-error);">${failCount}</span>
                    </div>
                    <div class="card" style="padding: 24px; display: flex; flex-direction: column; gap: 12px; background: var(--bg-card); border-radius: var(--radius-lg);">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <span style="font-size: 13px; color: var(--text-muted); font-weight: 600;">معدل النجاح</span>
                            <div style="width: 32px; height: 32px; border-radius: 8px; background: rgba(0, 136, 221, 0.1); color: var(--status-info); display: flex; align-items: center; justify-content: center;">
                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 18px; height: 18px;">
                                    <path d="M18 20V10M12 20V4M6 20v-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </div>
                        </div>
                        <span style="font-size: 28px; font-weight: 800; color: var(--brand-primary);">${successRate}%</span>
                    </div>
                </div>

                <div class="section-card" style="background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); overflow: hidden;">
                    <div class="section-card-header" style="padding: 20px 24px; border-bottom: 1px solid var(--border-subtle); display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.02);">
                        <div style="display: flex; gap: 16px; align-items: center; flex: 1;">
                            <div class="input-icon-wrap" style="flex: 1; max-width: 350px;">
                                <input type="text" class="form-input" placeholder="البحث برقم الهاتف..." value="${this.searchTerm}" oninput="window.campaignReportPage.handleDetailSearch(this.value)" style="width: 100%; padding: 10px 40px 10px 12px; background: var(--bg-elevated); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); color: var(--text-primary);">
                                <div class="inp-icon" style="right: 12px; left: auto;">
                                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 18px; height: 18px;">
                                        <circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                        <path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    </svg>
                                </div>
                            </div>
                            <div class="segment-tabs" style="background: var(--bg-elevated); padding: 4px; border-radius: 10px; display: flex; gap: 4px;">
                                <div class="seg-tab ${this.statusFilter === 'all' ? 'active' : ''}" onclick="window.campaignReportPage.handleStatusFilter('all')" style="padding: 6px 16px; font-size: 12px; font-weight: 700; cursor: pointer; border-radius: 8px; transition: all 0.2s;">الكل</div>
                                <div class="seg-tab ${this.statusFilter === 'success' ? 'active' : ''}" onclick="window.campaignReportPage.handleStatusFilter('success')" style="padding: 6px 16px; font-size: 12px; font-weight: 700; cursor: pointer; border-radius: 8px; transition: all 0.2s;">ناجح</div>
                                <div class="seg-tab ${this.statusFilter === 'failed' ? 'active' : ''}" onclick="window.campaignReportPage.handleStatusFilter('failed')" style="padding: 6px 16px; font-size: 12px; font-weight: 700; cursor: pointer; border-radius: 8px; transition: all 0.2s;">فشل</div>
                            </div>
                        </div>
                    </div>
                    <div class="section-card-body" style="padding: 0;">
                        <div style="overflow-x: auto;">
                            <table style="width: 100%; border-collapse: collapse; text-align: right;">
                                <thead>
                                    <tr style="background: rgba(255,255,255,0.03); border-bottom: 1px solid var(--border-subtle);">
                                        <th style="padding: 16px 24px; font-size: 12px; font-weight: 700; color: var(--text-muted);">المستلم</th>
                                        <th style="padding: 16px 24px; font-size: 12px; font-weight: 700; color: var(--text-muted);">التوقيت</th>
                                        <th style="padding: 16px 24px; font-size: 12px; font-weight: 700; color: var(--text-muted);">الحالة</th>
                                        <th style="padding: 16px 24px; font-size: 12px; font-weight: 700; color: var(--text-muted);">التفاصيل</th>
                                        <th style="padding: 16px 24px; font-size: 12px; font-weight: 700; color: var(--text-muted); text-align: left;">الإجراء</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${filteredReports.length === 0 ? `
                                        <tr>
                                            <td colspan="5" style="padding: 60px; text-align: center; color: var(--text-muted);">لا توجد نتائج مطابقة للبحث</td>
                                        </tr>
                                    ` : filteredReports.map((report, index) => `
                                        <tr style="border-bottom: 1px solid var(--border-subtle); transition: all 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.02)'" onmouseout="this.style.background='transparent'">
                                            <td style="padding: 18px 24px;">
                                                <div style="font-weight: 700; color: var(--text-primary); font-family: monospace; direction: ltr; font-size: 14px;">${report.recipient}</div>
                                            </td>
                                            <td style="padding: 18px 24px; font-size: 13px; color: var(--text-secondary);">
                                                ${new Date(report.sent_at || this.currentCampaign.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                            </td>
                                            <td style="padding: 18px 24px;">
                                                <span class="tag" style="background: ${report.status === 'success' ? 'rgba(76, 175, 80, 0.1)' : 'rgba(244, 67, 54, 0.1)'}; color: ${report.status === 'success' ? 'var(--status-success)' : 'var(--status-error)'}; border: none; font-weight: 700;">
                                                    ${report.status === 'success' ? 'تم الإرسال' : 'فشل'}
                                                </span>
                                            </td>
                                            <td style="padding: 18px 24px;">
                                                ${report.status === 'failed' ? `
                                                    <div style="display: flex; align-items: center; gap: 6px; color: var(--status-error); font-size: 12px;">
                                                        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 14px; height: 14px;">
                                                            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                                                            <line x1="12" y1="8" x2="12" y2="12" stroke="currentColor" stroke-width="2"/>
                                                            <line x1="12" y1="16" x2="12.01" y2="16" stroke="currentColor" stroke-width="2"/>
                                                        </svg>
                                                        ${report.error_message || 'خطأ غير معروف'}
                                                    </div>
                                                ` : `
                                                    <div style="display: flex; align-items: center; gap: 6px; color: var(--status-success); font-size: 12px;">
                                                        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 14px; height: 14px;">
                                                            <path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                                        </svg>
                                                        تم التسليم بنجاح
                                                    </div>
                                                `}
                                            </td>
                                            <td style="padding: 18px 24px; text-align: left;">
                                                ${report.status === 'failed' ? `
                                                    <button class="btn btn-ghost btn-sm" onclick="window.retrySingleMessage(${index})" style="color: var(--brand-primary); font-weight: 700; padding: 6px 12px; border: 1px solid var(--border-subtle); border-radius: 8px;">إعادة</button>
                                                ` : '-'}
                                            </td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
            <style>
                .dropdown-menu.show { display: block !important; }
                .seg-tab.active { background: var(--brand-primary) !important; color: white !important; }
                .seg-tab:not(.active):hover { background: rgba(255,255,255,0.05); }
            </style>
        `;

        this.setupEventListeners();
    }

    handleSearch(val) {
        this.searchTerm = val;
        this.renderList();
    }

    handleSort(val) {
        this.sortOrder = val;
        this.renderList();
    }

    handleDetailSearch(val) {
        this.searchTerm = val;
        this.renderDetails();
    }

    handleStatusFilter(val) {
        this.statusFilter = val;
        this.renderDetails();
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
            document.querySelector('.dropdown-menu')?.classList.remove('show');
        };

        window.retryFailedMessages = async () => {
            const failed = this.reports.filter(r => r.status === 'failed');
            if (failed.length === 0) return;
            
            showToast(`جاري إعادة إرسال ${failed.length} رسالة...`, 'info');
            for (const report of failed) {
                try {
                    await WhatsAppAPI.sendTemplate({
                        to: report.recipient,
                        templateName: this.currentCampaign.template_name,
                        languageCode: this.currentCampaign.language_code || 'ar'
                    });
                } catch (e) { console.error(e); }
            }
            showToast('اكتملت محاولة إعادة الإرسال', 'success');
            this.viewCampaign(this.currentCampaign.id);
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
                if (result && (result.messages || result.id)) {
                    showToast('تمت إعادة الإرسال بنجاح', 'success');
                    this.viewCampaign(this.currentCampaign.id);
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
        const printWindow = window.open('', '_blank');
        const html = `
            <html dir="${lang === 'ar' ? 'rtl' : 'ltr'}">
            <head>
                <title>Report - ${this.currentCampaign.name}</title>
                <style>
                    @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;700&display=swap');
                    body { font-family: 'Cairo', sans-serif; padding: 40px; background: #fff; color: #333; }
                    .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #0077CC; padding-bottom: 20px; margin-bottom: 30px; }
                    .logo { font-size: 24px; font-weight: 800; color: #0077CC; }
                    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
                    th, td { border: 1px solid #eee; padding: 12px; text-align: center; font-size: 13px; }
                    th { background-color: #f8f9fa; color: #0077CC; font-weight: 700; }
                    .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-bottom: 30px; }
                    .stat-box { background: #f8f9fa; padding: 15px; border-radius: 8px; text-align: center; }
                    .stat-label { font-size: 11px; color: #666; display: block; margin-bottom: 5px; }
                    .stat-value { font-size: 18px; font-weight: 700; color: #333; }
                </style>
            </head>
            <body>
                <div class="header">
                    <div class="logo">مدعوم | WhatsApp API</div>
                    <div style="text-align: left;">
                        <h1 style="margin: 0; font-size: 20px;">${lang === 'ar' ? 'تقرير حملة إرسال' : 'Campaign Report'}</h1>
                        <span style="font-size: 12px; color: #666;">${new Date().toLocaleString()}</span>
                    </div>
                </div>
                <div style="margin-bottom: 20px;">
                    <p><strong>${lang === 'ar' ? 'اسم الحملة' : 'Campaign Name'}:</strong> ${this.currentCampaign.name}</p>
                    <p><strong>${lang === 'ar' ? 'القالب المستخدم' : 'Template'}:</strong> ${this.currentCampaign.template_name}</p>
                </div>
                <div class="stats">
                    <div class="stat-box">
                        <span class="stat-label">${lang === 'ar' ? 'إجمالي المستلمين' : 'Total Recipients'}</span>
                        <span class="stat-value">${this.reports.length}</span>
                    </div>
                    <div class="stat-box">
                        <span class="stat-label">${lang === 'ar' ? 'ناجح' : 'Success'}</span>
                        <span class="stat-value" style="color: #4CAF50;">${this.reports.filter(r => r.status === 'success').length}</span>
                    </div>
                    <div class="stat-box">
                        <span class="stat-label">${lang === 'ar' ? 'فشل' : 'Failed'}</span>
                        <span class="stat-value" style="color: #F44336;">${this.reports.filter(r => r.status === 'failed').length}</span>
                    </div>
                    <div class="stat-box">
                        <span class="stat-label">${lang === 'ar' ? 'نسبة النجاح' : 'Success Rate'}</span>
                        <span class="stat-value">${Math.round((this.reports.filter(r => r.status === 'success').length / this.reports.length) * 100)}%</span>
                    </div>
                </div>
                <table>
                    <thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
                    <tbody>${data.map(row => `<tr>${row.map(d => `<td>${d}</td>`).join('')}</tr>`).join('')}</tbody>
                </table>
                <script>window.onload = () => { setTimeout(() => { window.print(); window.close(); }, 500); }</script>
            </body>
            </html>
        `;
        printWindow.document.write(html);
        printWindow.document.close();
    }
}
