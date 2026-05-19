import { SupabaseIntegration } from '../supabase-integration.js';
import { WhatsAppAPI } from '../services/whatsapp-api.js';

export class SendMessagePage {
    constructor(container) {
        this.container = container;
        this.templates = [];
        this.selectedTemplate = null;
        this.recipients = [];
        this.verificationResults = {
            valid: [],
            invalid: [],
            verified: false
        };
        this.sendingInProgress = false;
        this.metaPrices = [
            { category: 'رسائل التسويق', price: '0.140', categoryEn: 'MARKETING' },
            { category: 'رسائل المرافق', price: '0.032', categoryEn: 'UTILITY' },
            { category: 'رسائل التحقق', price: '0.040', categoryEn: 'AUTHENTICATION' },
            { category: 'رسائل الخدمة', price: '0.034', categoryEn: 'SERVICE' }
        ];
        this.businessPhone = '';
        this.campaignHistory = [];
    }

    async load() {
        this.container.innerHTML = `
            <div style="padding: 40px; text-align: center;">
                <div class="spinner" style="margin: 0 auto 15px;"></div>
                جاري تحميل البيانات...
            </div>
        `;
        try {
            const stats = await SupabaseIntegration.getDashboardStats();
            if (!stats) {
                this.container.innerHTML = `
                    <div style="text-align: center; padding: 60px 20px;">
                        <div style="font-size: 48px; margin-bottom: 20px;">🔌</div>
                        <h3 style="margin-bottom: 10px;">لا يوجد رقم مرتبط</h3>
                        <p style="color: var(--text-secondary); margin-bottom: 24px;">يرجى ربط رقم واتساب أولاً لإرسال الرسائل.</p>
                        <button class="btn btn-primary" onclick="navigateTo('connect', document.querySelector('[data-page=connect]'))">ربط رقم الآن</button>
                    </div>
                `;
                return;
            }

            this.businessPhone = stats.phoneNumber;
            const response = await WhatsAppAPI.getTemplates();
            this.templates = response.data || [];
            this.render();
        } catch (error) {
            this.container.innerHTML = `
                <div style="padding: 40px; text-align: center;">
                    <div style="color: var(--status-error); margin-bottom: 15px;">❌ خطأ في تحميل البيانات: ${error.message}</div>
                    <button class="btn btn-secondary btn-sm" onclick="window.loadSendMessage ? window.loadSendMessage() : location.reload()">إعادة المحاولة</button>
                </div>
            `;
        }
    }

    render() {
        const approvedTemplates = this.templates.filter(t => t.status === 'APPROVED');
        const pendingTemplates = this.templates.filter(t => t.status === 'PENDING');
        const rejectedTemplates = this.templates.filter(t => t.status === 'REJECTED');

        this.container.innerHTML = `
            <div class="send-message-page">
                <div style="display: grid; grid-template-columns: 1fr 340px; gap: 24px;">
                    <!-- Main Content -->
                    <div class="send-message-main">
                        <!-- Section 1: Select Template -->
                        <div class="section-card" style="margin-bottom: 24px;">
                            <div class="section-card-header">
                                <div class="section-card-title">
                                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    </svg>
                                    اختر قالب الرسالة
                                </div>
                            </div>
                            <div class="section-card-body">
                                ${this.renderTemplateSelector(approvedTemplates, pendingTemplates, rejectedTemplates)}
                            </div>
                        </div>

                        <!-- Section 2: Recipients -->
                        <div class="section-card" style="margin-bottom: 24px;">
                            <div class="section-card-header">
                                <div class="section-card-title">
                                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                        <circle cx="9" cy="7" r="4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                        <path d="M23 21v-2a4 4 0 0 0-3-3.87" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                        <path d="M16 3.13a4 4 0 0 1 0 7.75" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    </svg>
                                    الأرقام المستقبلة
                                </div>
                            </div>
                            <div class="section-card-body">
                                ${this.renderRecipientsSection()}
                            </div>
                        </div>

                        <!-- Section 3: Bulk Verification -->
                        <div class="section-card" style="margin-bottom: 24px;">
                            <div class="section-card-header">
                                <div class="section-card-title">
                                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                        <path d="M9 11l3 3L22 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                        <path d="M20 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h11" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    </svg>
                                    فحص الأرقام
                                </div>
                            </div>
                            <div class="section-card-body">
                                ${this.renderVerificationSection()}
                            </div>
                        </div>

                        <!-- Section 4: Send Action -->
                        <div class="section-card">
                            <div class="section-card-body" style="display: flex; gap: 12px; flex-direction: column;">
                                <button class="btn btn-primary" id="send-btn" onclick="window.sendMessages ? window.sendMessages() : alert('جاري التحضير...')" style="width: 100%; padding: 12px; font-size: 15px; font-weight: 700;">
                                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 18px; height: 18px; margin-left: 8px;">
                                        <path d="M16 21H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                        <polyline points="23 4 23 10 17 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    </svg>
                                    إرسال الرسائل
                                </button>
                                <button class="btn btn-secondary" onclick="window.resetSendForm ? window.resetSendForm() : location.reload()" style="width: 100%; padding: 12px; font-size: 15px;">إعادة تعيين</button>
                            </div>
                        </div>
                    </div>

                    <!-- Right Sidebar -->
                    <div class="send-message-sidebar">
                        <!-- Template Preview -->
                        <div class="section-card" style="margin-bottom: 24px;">
                            <div class="section-card-header">
                                <div class="section-card-title" style="font-size: 14px;">معاينة الرسالة</div>
                            </div>
                            <div class="section-card-body" id="template-preview-container" style="min-height: 200px; display: flex; align-items: center; justify-content: center; color: var(--text-muted);">
                                اختر قالباً لمعاينته
                            </div>
                        </div>

                        <!-- Campaign Stats -->
                        <div class="section-card" style="margin-bottom: 24px;">
                            <div class="section-card-header">
                                <div class="section-card-title" style="font-size: 14px;">إحصائيات الحملة</div>
                            </div>
                            <div class="section-card-body" style="display: flex; flex-direction: column; gap: 12px;">
                                <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px; background: var(--bg-elevated); border-radius: var(--radius-md);">
                                    <span style="font-size: 13px; color: var(--text-secondary);">إجمالي الأرقام</span>
                                    <span style="font-size: 16px; font-weight: 700; color: var(--text-primary);" id="stats-total">0</span>
                                </div>
                                <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px; background: var(--bg-elevated); border-radius: var(--radius-md);">
                                    <span style="font-size: 13px; color: var(--status-success);">أرقام صحيحة</span>
                                    <span style="font-size: 16px; font-weight: 700; color: var(--status-success);" id="stats-valid">0</span>
                                </div>
                                <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px; background: var(--bg-elevated); border-radius: var(--radius-md);">
                                    <span style="font-size: 13px; color: var(--status-error);">أرقام خاطئة</span>
                                    <span style="font-size: 16px; font-weight: 700; color: var(--status-error);" id="stats-invalid">0</span>
                                </div>
                                <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px; background: var(--bg-elevated); border-radius: var(--radius-md);">
                                    <span style="font-size: 13px; color: var(--text-secondary);">التكلفة المتوقعة</span>
                                    <span style="font-size: 16px; font-weight: 700; color: var(--brand-primary);" id="stats-cost">\$0.00</span>
                                </div>
                            </div>
                        </div>

                        <!-- Campaign History -->
                        <div class="section-card" style="margin-bottom: 24px;">
                            <div class="section-card-header">
                                <div class="section-card-title" style="font-size: 14px;">سجل الحملات الأخيرة</div>
                            </div>
                            <div class="section-card-body" id="campaign-history-list" style="padding: 0; max-height: 300px; overflow-y: auto;">
                                <div style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 12px;">لا توجد حملات سابقة</div>
                            </div>
                        </div>

                        <!-- Meta Prices -->
                        <div class="section-card">
                            <div class="section-card-header" style="background: var(--brand-primary); color: white; border-radius: var(--radius-lg) var(--radius-lg) 0 0;">
                                <div class="section-card-title" style="color: white; font-size: 14px;">أسعار ميتا دولياً</div>
                            </div>
                            <div class="section-card-body" style="padding: 0;">
                                <table style="width: 100%; border-collapse: collapse;">
                                    <thead>
                                        <tr style="border-bottom: 1px solid var(--border-subtle);">
                                            <th style="text-align: right; padding: 12px 16px; font-size: 12px; color: var(--text-muted);">الفئة</th>
                                            <th style="text-align: left; padding: 12px 16px; font-size: 12px; color: var(--text-muted);">السعر</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${this.metaPrices.map(p => `
                                            <tr style="border-bottom: 1px solid var(--border-subtle);">
                                                <td style="padding: 12px 16px; font-size: 13px;">${p.category}</td>
                                                <td style="padding: 12px 16px; font-size: 13px; text-align: left; font-weight: 700;">\$${p.price}</td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Modals -->
            ${this.renderModals()}
        `;

        this.setupEventListeners();
    }

    renderTemplateSelector(approved, pending, rejected) {
        let html = '<div style="display: flex; flex-direction: column; gap: 16px;">';

        if (approved.length > 0) {
            html += `
                <div>
                    <div style="font-size: 13px; font-weight: 700; color: var(--status-success); margin-bottom: 12px; display: flex; align-items: center; gap: 6px;">
                        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 16px; height: 16px;">
                            <polyline points="20 6 9 17 4 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                        القوالب المقبولة (${approved.length})
                    </div>
                    <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px;">
                        ${approved.map(tpl => this.renderTemplateCard(tpl, 'approved')).join('')}
                    </div>
                </div>
            `;
        }

        if (pending.length > 0) {
            html += `
                <div>
                    <div style="font-size: 13px; font-weight: 700; color: var(--status-warning); margin-bottom: 12px; display: flex; align-items: center; gap: 6px;">
                        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 16px; height: 16px;">
                            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                            <polyline points="12 6 12 12 16 14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                        </svg>
                        قيد المراجعة (${pending.length})
                    </div>
                    <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px;">
                        ${pending.map(tpl => this.renderTemplateCard(tpl, 'pending')).join('')}
                    </div>
                </div>
            `;
        }

        if (rejected.length > 0) {
            html += `
                <div>
                    <div style="font-size: 13px; font-weight: 700; color: var(--status-error); margin-bottom: 12px; display: flex; align-items: center; gap: 6px;">
                        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 16px; height: 16px;">
                            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                            <line x1="15" y1="9" x2="9" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                            <line x1="9" y1="9" x2="15" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                        </svg>
                        المرفوضة (${rejected.length})
                    </div>
                    <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px;">
                        ${rejected.map(tpl => this.renderTemplateCard(tpl, 'rejected')).join('')}
                    </div>
                </div>
            `;
        }

        html += '</div>';
        return html;
    }

    renderTemplateCard(template, status) {
        const statusMap = {
            'APPROVED': { text: 'مقبول', class: 'success' },
            'REJECTED': { text: 'مرفوض', class: 'error' },
            'PENDING': { text: 'قيد المراجعة', class: 'warning' }
        };
        
        const statusInfo = statusMap[template.status] || { text: template.status, class: 'info' };
        const body = template.components.find(c => c.type === 'BODY')?.text || '';
        const isDisabled = status !== 'approved';

        return `
            <div class="template-card" onclick="${isDisabled ? '' : `window.selectTemplate('${template.name}')`}" 
                 style="
                    padding: 12px; 
                    border: 2px solid var(--border-subtle); 
                    border-radius: var(--radius-md); 
                    cursor: ${isDisabled ? 'not-allowed' : 'pointer'}; 
                    transition: all var(--transition);
                    background: var(--bg-elevated);
                    opacity: ${isDisabled ? '0.6' : '1'};
                    position: relative;
                 "
                 onmouseover="this.style.borderColor = '${isDisabled ? 'var(--border-subtle)' : 'var(--brand-primary)'}'; this.style.transform = '${isDisabled ? 'none' : 'translateY(-2px)'}';"
                 onmouseout="this.style.borderColor = 'var(--border-subtle)'; this.style.transform = 'none';">
                <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px;">
                    <div style="font-weight: 700; font-size: 13px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;">${template.name}</div>
                    <span class="tag" style="background: var(--status-${statusInfo.class}-bg); color: var(--status-${statusInfo.class}); border: none; flex-shrink: 0; font-size: 11px;">${statusInfo.text}</span>
                </div>
                <div style="font-size: 12px; color: var(--text-secondary); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">${body}</div>
            </div>
        `;
    }

    renderRecipientsSection() {
        return `
            <div style="display: flex; flex-direction: column; gap: 12px;">
                <!-- Input Method Tabs -->
                <div class="segment-tabs" style="display: flex; gap: 4px; background: var(--bg-surface); padding: 4px; border-radius: var(--radius-md);">
                    <button class="seg-tab active" onclick="window.switchRecipientInput('manual')" style="padding: 7px 16px; border-radius: var(--radius-sm); font-size: 13px; font-weight: 600; color: var(--text-secondary); cursor: pointer; transition: all var(--transition); background: var(--bg-elevated); color: var(--text-primary);">
                        إدخال يدوي
                    </button>
                    <button class="seg-tab" onclick="window.switchRecipientInput('file')" style="padding: 7px 16px; border-radius: var(--radius-sm); font-size: 13px; font-weight: 600; color: var(--text-secondary); cursor: pointer; transition: all var(--transition);">
                        استيراد من ملف
                    </button>
                </div>

                <!-- Manual Input -->
                <div id="manual-input-section" style="display: flex; flex-direction: column; gap: 12px;">
                    <textarea id="recipients-textarea" placeholder="أدخل الأرقام (واحد في كل سطر)&#10;مثال:&#10;966501234567&#10;966509876543" style="
                        width: 100%;
                        padding: 12px;
                        border: 1px solid var(--border-subtle);
                        border-radius: var(--radius-md);
                        background: var(--bg-elevated);
                        color: var(--text-primary);
                        font-family: monospace;
                        font-size: 13px;
                        min-height: 120px;
                        resize: vertical;
                    "></textarea>
                    <div style="display: flex; gap: 8px;">
                        <button class="btn btn-secondary btn-sm" onclick="window.addRecipientsFromText()" style="flex: 1;">إضافة الأرقام</button>
                        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('recipients-textarea').value = ''" style="flex: 1;">مسح</button>
                    </div>
                </div>

                <!-- File Input -->
                <div id="file-input-section" style="display: none; flex-direction: column; gap: 12px;">
                    <div style="
                        border: 2px dashed var(--border-subtle);
                        border-radius: var(--radius-md);
                        padding: 24px;
                        text-align: center;
                        cursor: pointer;
                        transition: all var(--transition);
                        background: var(--bg-elevated);
                    " onclick="document.getElementById('file-input').click()" onmouseover="this.style.borderColor = 'var(--brand-primary)'; this.style.background = 'rgba(0, 119, 204, 0.05)';" onmouseout="this.style.borderColor = 'var(--border-subtle)'; this.style.background = 'var(--bg-elevated)';">
                        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 32px; height: 32px; margin: 0 auto 8px; color: var(--brand-primary);">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            <polyline points="17 8 12 3 7 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            <line x1="12" y1="3" x2="12" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                        <div style="font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 4px;">اسحب ملف Excel أو انقر للاختيار</div>
                        <div style="font-size: 12px; color: var(--text-muted);">ملفات .xlsx أو .csv مدعومة</div>
                    </div>
                    <input type="file" id="file-input" accept=".xlsx,.xls,.csv" style="display: none;" onchange="window.handleFileUpload(event)">
                </div>

                <!-- Recipients List -->
                <div id="recipients-list-container" style="display: none; flex-direction: column; gap: 12px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div style="font-size: 13px; font-weight: 600; color: var(--text-primary);">الأرقام المضافة: <span id="recipients-count" style="color: var(--brand-primary);">0</span></div>
                        <button class="btn btn-ghost btn-sm" onclick="window.clearRecipients()" style="color: var(--status-error);">حذف الكل</button>
                    </div>
                    <div id="recipients-list" style="
                        max-height: 200px;
                        overflow-y: auto;
                        display: flex;
                        flex-direction: column;
                        gap: 6px;
                        padding: 12px;
                        background: var(--bg-surface);
                        border-radius: var(--radius-md);
                        border: 1px solid var(--border-subtle);
                    "></div>
                </div>
            </div>
        `;
    }

    renderVerificationSection() {
        return `
            <div style="display: flex; flex-direction: column; gap: 12px;">
                <button class="btn btn-secondary" onclick="window.verifyAllNumbers()" id="verify-all-btn" style="width: 100%; padding: 10px;">
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 16px; height: 16px; margin-left: 6px;">
                        <polyline points="23 4 23 10 17 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        <path d="M20.49 15a9 9 0 1 1-14.85-3.36" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    فحص جميع الأرقام
                </button>
                <div id="verify-progress" style="display: none; flex-direction: column; gap: 8px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; font-size: 12px;">
                        <span style="color: var(--text-secondary);">جاري الفحص...</span>
                        <span id="verify-progress-text" style="color: var(--brand-primary); font-weight: 700;">0%</span>
                    </div>
                    <div style="background: var(--bg-elevated); border-radius: 99px; height: 6px; overflow: hidden;">
                        <div id="verify-progress-bar" style="height: 100%; background: linear-gradient(90deg, var(--brand-primary), var(--brand-accent)); width: 0%; border-radius: 99px; transition: width 0.3s ease;"></div>
                    </div>
                </div>
                <div id="verify-result" style="display: none; padding: 12px; border-radius: var(--radius-md); border: 1px solid var(--border-subtle); font-size: 13px;"></div>
            </div>
        `;
    }

    renderModals() {
        return `
            <!-- Sending Progress Modal -->
            <div id="sending-modal" style="
                display: none;
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.7);
                z-index: 1000;
                align-items: center;
                justify-content: center;
            ">
                <div style="
                    background: var(--bg-card);
                    border: 1px solid var(--border-subtle);
                    border-radius: var(--radius-lg);
                    padding: 32px;
                    max-width: 500px;
                    width: 90%;
                ">
                    <h3 style="font-size: 18px; font-weight: 700; color: var(--text-primary); margin-bottom: 24px; text-align: center;">جاري إرسال الرسائل...</h3>
                    
                    <div style="margin-bottom: 24px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                            <span style="font-size: 13px; color: var(--text-secondary);">التقدم</span>
                            <span id="sending-progress-text" style="font-size: 13px; font-weight: 700; color: var(--brand-primary);">0/0</span>
                        </div>
                        <div style="background: var(--bg-elevated); border-radius: 99px; height: 8px; overflow: hidden;">
                            <div id="sending-progress-bar" style="height: 100%; background: linear-gradient(90deg, var(--brand-primary), var(--brand-accent)); width: 0%; border-radius: 99px; transition: width 0.3s ease;"></div>
                        </div>
                    </div>

                    <div style="background: var(--bg-elevated); border-radius: var(--radius-md); padding: 12px; margin-bottom: 24px; max-height: 150px; overflow-y: auto;">
                        <div id="sending-log" style="font-size: 12px; color: var(--text-secondary); font-family: monospace; line-height: 1.6;"></div>
                    </div>

                    <div style="display: flex; gap: 12px;">
                        <div style="flex: 1; display: flex; flex-direction: column; gap: 4px;">
                            <div style="font-size: 12px; color: var(--text-muted);">نجح</div>
                            <div style="font-size: 18px; font-weight: 700; color: var(--status-success);" id="sending-success-count">0</div>
                        </div>
                        <div style="flex: 1; display: flex; flex-direction: column; gap: 4px;">
                            <div style="font-size: 12px; color: var(--text-muted);">فشل</div>
                            <div style="font-size: 18px; font-weight: 700; color: var(--status-error);" id="sending-error-count">0</div>
                        </div>
                        <div style="flex: 1; display: flex; flex-direction: column; gap: 4px;">
                            <div style="font-size: 12px; color: var(--text-muted);">التكلفة</div>
                            <div style="font-size: 18px; font-weight: 700; color: var(--brand-primary);" id="sending-cost">\$0.00</div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Success Modal -->
            <div id="success-modal" style="
                display: none;
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.7);
                z-index: 1000;
                align-items: center;
                justify-content: center;
            ">
                <div style="
                    background: var(--bg-card);
                    border: 1px solid var(--border-subtle);
                    border-radius: var(--radius-lg);
                    padding: 32px;
                    max-width: 500px;
                    width: 90%;
                    text-align: center;
                ">
                    <div style="font-size: 48px; margin-bottom: 16px;">✅</div>
                    <h3 style="font-size: 20px; font-weight: 700; color: var(--text-primary); margin-bottom: 8px;">تم الإرسال بنجاح!</h3>
                    <p style="color: var(--text-secondary); margin-bottom: 24px; line-height: 1.6;">تم إرسال <span id="success-count" style="font-weight: 700; color: var(--status-success);">0</span> رسالة بنجاح من <span id="success-total" style="font-weight: 700;">0</span> رسالة.</p>
                    <div style="background: var(--bg-elevated); padding: 16px; border-radius: var(--radius-md); margin-bottom: 24px; text-align: left;">
                        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                            <span style="font-size: 13px; color: var(--text-secondary);">التكلفة الإجمالية:</span>
                            <span style="font-size: 13px; font-weight: 700; color: var(--text-primary);" id="success-cost">\$0.00</span>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span style="font-size: 13px; color: var(--text-secondary);">معرف الحملة:</span>
                            <span style="font-size: 13px; font-weight: 700; color: var(--brand-primary);" id="success-campaign-id">-</span>
                        </div>
                    </div>
                    <button class="btn btn-primary" onclick="document.getElementById('success-modal').style.display = 'none'; window.resetSendForm();" style="width: 100%;">حسناً</button>
                </div>
            </div>

            <!-- Error Modal -->
            <div id="error-modal" style="
                display: none;
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.7);
                z-index: 1000;
                align-items: center;
                justify-content: center;
            ">
                <div style="
                    background: var(--bg-card);
                    border: 1px solid var(--border-subtle);
                    border-radius: var(--radius-lg);
                    padding: 32px;
                    max-width: 500px;
                    width: 90%;
                    text-align: center;
                ">
                    <div style="font-size: 48px; margin-bottom: 16px;">❌</div>
                    <h3 style="font-size: 20px; font-weight: 700; color: var(--text-primary); margin-bottom: 8px;">فشل الإرسال</h3>
                    <p style="color: var(--text-secondary); margin-bottom: 24px; line-height: 1.6;" id="error-message"></p>
                    <button class="btn btn-primary" onclick="document.getElementById('error-modal').style.display = 'none'" style="width: 100%;">حسناً</button>
                </div>
            </div>
        `;
    }

    setupEventListeners() {
        window.selectTemplate = (templateName) => {
            this.selectedTemplate = this.templates.find(t => t.name === templateName);
            if (this.selectedTemplate) {
                this.updateTemplatePreview();
                document.querySelectorAll('.template-card').forEach(card => {
                    card.style.borderColor = 'var(--border-subtle)';
                    card.style.background = 'var(--bg-elevated)';
                });
                event.currentTarget.style.borderColor = 'var(--brand-primary)';
                event.currentTarget.style.background = 'rgba(0, 119, 204, 0.1)';
            }
        };

        window.switchRecipientInput = (method) => {
            const manualSection = document.getElementById('manual-input-section');
            const fileSection = document.getElementById('file-input-section');
            const tabs = document.querySelectorAll('.seg-tab');

            if (method === 'manual') {
                manualSection.style.display = 'flex';
                fileSection.style.display = 'none';
                tabs[0].style.background = 'var(--bg-elevated)';
                tabs[0].style.color = 'var(--text-primary)';
                tabs[1].style.background = 'transparent';
                tabs[1].style.color = 'var(--text-secondary)';
            } else {
                manualSection.style.display = 'none';
                fileSection.style.display = 'flex';
                tabs[0].style.background = 'transparent';
                tabs[0].style.color = 'var(--text-secondary)';
                tabs[1].style.background = 'var(--bg-elevated)';
                tabs[1].style.color = 'var(--text-primary)';
            }
        };

        window.addRecipientsFromText = () => {
            const textarea = document.getElementById('recipients-textarea');
            const numbers = textarea.value
                .split('\n')
                .map(n => n.trim())
                .filter(n => n && /^\d+$/.test(n));
            
            if (numbers.length === 0) {
                showToast('يرجى إدخال أرقام صحيحة', 'warning');
                return;
            }

            this.recipients = [...new Set([...this.recipients, ...numbers])];
            this.updateRecipientsList();
            this.updateStats();
            textarea.value = '';
            showToast(`تم إضافة ${numbers.length} رقم`, 'success');
        };

        window.handleFileUpload = async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            try {
                const text = await file.text();
                const lines = text.split('\n');
                const numbers = lines
                    .map(line => {
                        const parts = line.split(',');
                        return parts[0].trim();
                    })
                    .filter(n => n && /^\d+$/.test(n));

                if (numbers.length === 0) {
                    showToast('لم يتم العثور على أرقام صحيحة في الملف', 'warning');
                    return;
                }

                this.recipients = [...new Set([...this.recipients, ...numbers])];
                this.updateRecipientsList();
                this.updateStats();
                showToast(`تم استيراد ${numbers.length} رقم من الملف`, 'success');
            } catch (error) {
                showToast('خطأ في قراءة الملف: ' + error.message, 'error');
            }
        };

        window.clearRecipients = () => {
            if (confirm('هل أنت متأكد من حذف جميع الأرقام؟')) {
                this.recipients = [];
                this.verificationResults = { valid: [], invalid: [], verified: false };
                this.updateRecipientsList();
                this.updateStats();
                showToast('تم حذف جميع الأرقام', 'info');
            }
        };

        window.verifyAllNumbers = async () => {
            if (this.recipients.length === 0) {
                showToast('يرجى إضافة أرقام أولاً', 'warning');
                return;
            }

            const verifyBtn = document.getElementById('verify-all-btn');
            const progressDiv = document.getElementById('verify-progress');
            const resultDiv = document.getElementById('verify-result');
            const progressBar = document.getElementById('verify-progress-bar');
            const progressText = document.getElementById('verify-progress-text');

            verifyBtn.disabled = true;
            progressDiv.style.display = 'flex';
            resultDiv.style.display = 'none';

            try {
                this.verificationResults = { valid: [], invalid: [], verified: false };
                const total = this.recipients.length;

                for (let i = 0; i < this.recipients.length; i++) {
                    const number = this.recipients[i];
                    const isValid = this.validatePhoneNumber(number);
                    
                    if (isValid) {
                        this.verificationResults.valid.push(number);
                    } else {
                        this.verificationResults.invalid.push(number);
                    }

                    const progress = Math.round(((i + 1) / total) * 100);
                    progressBar.style.width = progress + '%';
                    progressText.textContent = progress + '%';

                    await new Promise(resolve => setTimeout(resolve, 50));
                }

                this.verificationResults.verified = true;

                resultDiv.innerHTML = `
                    <div style="display: flex; flex-direction: column; gap: 8px;">
                        <div style="display: flex; align-items: center; gap: 8px; color: var(--status-success);">
                            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 16px; height: 16px;">
                                <polyline points="20 6 9 17 4 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                            <span>تم فحص <strong>${this.verificationResults.valid.length}</strong> رقم صحيح</span>
                        </div>
                        ${this.verificationResults.invalid.length > 0 ? `
                            <div style="display: flex; align-items: center; gap: 8px; color: var(--status-error);">
                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 16px; height: 16px;">
                                    <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                                    <line x1="15" y1="9" x2="9" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                                    <line x1="9" y1="9" x2="15" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                                </svg>
                                <span><strong>${this.verificationResults.invalid.length}</strong> رقم خاطئ (سيتم تخطيهم)</span>
                            </div>
                        ` : ''}
                    </div>
                `;
                resultDiv.style.display = 'block';
                this.updateStats();
                showToast('تم فحص جميع الأرقام بنجاح', 'success');
            } catch (error) {
                resultDiv.innerHTML = `<div style="color: var(--status-error);">خطأ في الفحص: ${error.message}</div>`;
                resultDiv.style.display = 'block';
            } finally {
                verifyBtn.disabled = false;
                progressDiv.style.display = 'none';
            }
        };

        window.sendMessages = async () => {
            if (!this.selectedTemplate) {
                showToast('يرجى اختيار قالب رسالة', 'warning');
                return;
            }

            if (this.recipients.length === 0) {
                showToast('يرجى إضافة أرقام مستقبلة', 'warning');
                return;
            }

            if (!this.verificationResults.verified) {
                showToast('يرجى فحص الأرقام أولاً', 'warning');
                return;
            }

            if (this.verificationResults.valid.length === 0) {
                showToast('لا توجد أرقام صحيحة للإرسال', 'error');
                return;
            }

            this.sendingInProgress = true;
            const sendingModal = document.getElementById('sending-modal');
            const sendBtn = document.getElementById('send-btn');
            sendBtn.disabled = true;
            sendingModal.style.display = 'flex';

            let successCount = 0;
            let errorCount = 0;
            let totalCost = 0;
            const validNumbers = this.verificationResults.valid;
            const campaignId = 'camp_' + Date.now();
            const reports = [];

            try {
                for (let i = 0; i < validNumbers.length; i++) {
                    const recipient = validNumbers[i];
                    const progress = Math.round(((i + 1) / validNumbers.length) * 100);
                    const reportItem = {
                        recipient,
                        time: new Date().toLocaleTimeString('ar-SA'),
                        template: this.selectedTemplate.name,
                        language: this.selectedTemplate.language || 'ar'
                    };
                    
                    try {
                        // محاولة إرسال الرسالة عبر Meta API
                        const result = await WhatsAppAPI.sendTemplate({
                            to: recipient,
                            templateName: this.selectedTemplate.name,
                            languageCode: this.selectedTemplate.language || 'ar'
                        });

                        if (result && result.messages) {
                            successCount++;
                            totalCost += this.getTemplateCost();
                            this.logSending(`✓ ${recipient} - تم الإرسال`);
                            reportItem.status = 'success';
                        } else {
                            errorCount++;
                            this.logSending(`✗ ${recipient} - فشل الإرسال`);
                            reportItem.status = 'failed';
                            reportItem.error = 'فشل الإرسال من خادم ميتا';
                        }
                    } catch (error) {
                        errorCount++;
                        this.logSending(`✗ ${recipient} - ${error.message}`);
                        reportItem.status = 'failed';
                        reportItem.error = error.message;
                    }
                    reports.push(reportItem);

                    // تحديث شريط التقدم
                    document.getElementById('sending-progress-bar').style.width = progress + '%';
                    document.getElementById('sending-progress-text').textContent = `${i + 1}/${validNumbers.length}`;
                    document.getElementById('sending-success-count').textContent = successCount;
                    document.getElementById('sending-error-count').textContent = errorCount;
                    document.getElementById('sending-cost').textContent = '$' + totalCost.toFixed(2);

                    await new Promise(resolve => setTimeout(resolve, 100));
                }

                // حفظ سجل الحملة
                const campaignObj = {
                    id: campaignId,
                    name: `حملة ${new Date().toLocaleDateString('ar-SA')}`,
                    template: this.selectedTemplate.name,
                    totalSent: successCount,
                    totalFailed: errorCount,
                    cost: totalCost,
                    timestamp: new Date().toLocaleString('ar-SA'),
                    reports: reports
                };
                
                this.campaignHistory.push(campaignObj);
                localStorage.setItem('mad3oom_last_campaign', JSON.stringify(campaignObj));

                // إظهار نتيجة النجاح
                document.getElementById('success-count').textContent = successCount;
                document.getElementById('success-total').textContent = validNumbers.length;
                document.getElementById('success-cost').textContent = '$' + totalCost.toFixed(2);
                document.getElementById('success-campaign-id').textContent = campaignId;
                
                // إضافة زر الانتقال للتقرير في مودال النجاح
                const successModalBody = document.querySelector('#success-modal div');
                if (successModalBody && !document.getElementById('view-report-btn')) {
                    const reportBtn = document.createElement('button');
                    reportBtn.id = 'view-report-btn';
                    reportBtn.className = 'btn btn-secondary';
                    reportBtn.style.width = '100%';
                    reportBtn.style.marginTop = '8px';
                    reportBtn.textContent = 'عرض تقرير الإرسال المفصل';
                    reportBtn.onclick = () => {
                        document.getElementById('success-modal').style.display = 'none';
                        window.navigateTo('reports', document.querySelector('[data-page=reports]'));
                    };
                    successModalBody.appendChild(reportBtn);
                }

                this.updateCampaignHistory();
                sendingModal.style.display = 'none';
                document.getElementById('success-modal').style.display = 'flex';
                showToast(`تم إرسال ${successCount} رسالة بنجاح`, 'success');
            } catch (error) {
                document.getElementById('error-message').textContent = error.message;
                sendingModal.style.display = 'none';
                document.getElementById('error-modal').style.display = 'flex';
                showToast('خطأ في الإرسال: ' + error.message, 'error');
            } finally {
                this.sendingInProgress = false;
                sendBtn.disabled = false;
            }
        };

        window.resetSendForm = () => {
            this.selectedTemplate = null;
            this.recipients = [];
            this.verificationResults = { valid: [], invalid: [], verified: false };
            document.getElementById('recipients-textarea').value = '';
            document.getElementById('verify-result').style.display = 'none';
            this.updateRecipientsList();
            this.updateStats();
            this.updateTemplatePreview();
            document.querySelectorAll('.template-card').forEach(card => {
                card.style.borderColor = 'var(--border-subtle)';
                card.style.background = 'var(--bg-elevated)';
            });
        };
    }

    validatePhoneNumber(number) {
        // فحص أساسي للرقم (يجب أن يكون بين 10 و 15 رقم)
        return /^\d{10,15}$/.test(number);
    }

    getTemplateCost() {
        // حساب التكلفة بناءً على فئة القالب
        if (!this.selectedTemplate) return 0;
        
        const categoryMap = {
            'MARKETING': 0.140,
            'UTILITY': 0.032,
            'AUTHENTICATION': 0.040,
            'SERVICE': 0.034
        };

        return categoryMap[this.selectedTemplate.category] || 0.032;
    }

    logSending(message) {
        const logDiv = document.getElementById('sending-log');
        const timestamp = new Date().toLocaleTimeString('ar-SA');
        logDiv.innerHTML += `[${timestamp}] ${message}\n`;
        logDiv.scrollTop = logDiv.scrollHeight;
    }

    updateTemplatePreview() {
        const container = document.getElementById('template-preview-container');
        if (!this.selectedTemplate) {
            container.innerHTML = 'اختر قالباً لمعاينته';
            return;
        }

        const header = this.selectedTemplate.components.find(c => c.type === 'HEADER');
        const body = this.selectedTemplate.components.find(c => c.type === 'BODY')?.text || '';
        const footer = this.selectedTemplate.components.find(c => c.type === 'FOOTER')?.text || '';
        const buttons = this.selectedTemplate.components.find(c => c.type === 'BUTTONS')?.buttons || [];

        let html = `
            <div style="
                background: white;
                color: #000;
                border-radius: 12px;
                padding: 16px;
                width: 100%;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
            ">
        `;

        if (header) {
            html += `<div style="font-weight: 700; margin-bottom: 12px; border-bottom: 1px solid #eee; padding-bottom: 8px; font-size: 13px;">${header.format === 'TEXT' ? header.text : '📷 وسائط'}</div>`;
        }

        html += `<div style="white-space: pre-wrap; font-size: 13px; line-height: 1.5; margin-bottom: 12px;">${body}</div>`;

        if (footer) {
            html += `<div style="margin-top: 12px; font-size: 11px; color: #999; border-top: 1px dashed #eee; padding-top: 8px;">${footer}</div>`;
        }

        if (buttons.length > 0) {
            html += '<div style="margin-top: 12px; display: flex; flex-direction: column; gap: 6px;">';
            buttons.forEach(btn => {
                html += `<div style="background: #f0f0f0; color: #00a884; border: 1px solid #e9edef; padding: 8px; border-radius: 8px; text-align: center; font-size: 12px; font-weight: 600;">${btn.text}</div>`;
            });
            html += '</div>';
        }

        html += '</div>';
        container.innerHTML = html;
    }

    updateRecipientsList() {
        const container = document.getElementById('recipients-list-container');
        const list = document.getElementById('recipients-list');
        const count = document.getElementById('recipients-count');

        if (this.recipients.length === 0) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'flex';
        count.textContent = this.recipients.length;

        list.innerHTML = this.recipients.map((num, idx) => {
            const isValid = this.verificationResults.valid.includes(num);
            const isInvalid = this.verificationResults.invalid.includes(num);
            
            return `
                <div style="
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 8px 12px;
                    background: var(--bg-elevated);
                    border-radius: var(--radius-sm);
                    font-size: 13px;
                    color: var(--text-primary);
                    border-left: 3px solid ${isValid ? 'var(--status-success)' : (isInvalid ? 'var(--status-error)' : 'var(--border-subtle)')};
                ">
                    <span style="font-family: monospace; direction: ltr;">${num}</span>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        ${isValid ? '<span style="color: var(--status-success); font-size: 12px;">✓</span>' : ''}
                        ${isInvalid ? '<span style="color: var(--status-error); font-size: 12px;">✗</span>' : ''}
                        <button onclick="window.removeRecipient(${idx})" style="
                            background: none;
                            border: none;
                            color: var(--status-error);
                            cursor: pointer;
                            font-size: 16px;
                            padding: 0;
                        ">✕</button>
                    </div>
                </div>
            `;
        }).join('');

        window.removeRecipient = (idx) => {
            this.recipients.splice(idx, 1);
            this.updateRecipientsList();
            this.updateStats();
        };
    }

    updateStats() {
        const validCount = this.verificationResults.valid.length;
        const invalidCount = this.verificationResults.invalid.length;
        const totalCount = this.recipients.length;
        const cost = validCount * this.getTemplateCost();

        const totalEl = document.getElementById('stats-total');
        const validEl = document.getElementById('stats-valid');
        const invalidEl = document.getElementById('stats-invalid');
        const costEl = document.getElementById('stats-cost');

        if (totalEl) totalEl.textContent = totalCount;
        if (validEl) validEl.textContent = validCount;
        if (invalidEl) invalidEl.textContent = invalidCount;
        if (costEl) costEl.textContent = '$' + cost.toFixed(2);
    }

    updateCampaignHistory() {
        const container = document.getElementById('campaign-history-list');
        if (!container) return;

        if (this.campaignHistory.length === 0) {
            container.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 12px;">لا توجد حملات سابقة</div>';
            return;
        }

        container.innerHTML = this.campaignHistory.slice().reverse().map(camp => `
            <div style="padding: 12px 16px; border-bottom: 1px solid var(--border-subtle); background: var(--bg-card);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                    <span style="font-size: 13px; font-weight: 700; color: var(--text-primary);">${camp.template}</span>
                    <span style="font-size: 11px; color: var(--status-success); font-weight: 700;">${camp.totalSent} نجح</span>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-size: 11px; color: var(--text-muted);">${camp.timestamp}</span>
                    <span style="font-size: 11px; font-weight: 700; color: var(--brand-primary);">$${camp.cost.toFixed(2)}</span>
                </div>
            </div>
        `).join('');
    }
}
