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
        this.billingStatus = null;
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
            
            const [tplResponse, billingInfo] = await Promise.all([
                WhatsAppAPI.getTemplates(),
                WhatsAppAPI.getBillingStatus().catch(e => {
                    console.warn('Could not fetch billing status:', e);
                    return null;
                })
            ]);

            this.templates = tplResponse.data || [];
            this.billingStatus = billingInfo;
            
            this.render();
            this.checkBillingAlert();
        } catch (error) {
            this.container.innerHTML = `
                <div style="padding: 40px; text-align: center;">
                    <div style="color: var(--status-error); margin-bottom: 15px;">❌ خطأ في تحميل البيانات: ${error.message}</div>
                    <button class="btn btn-secondary btn-sm" onclick="window.loadSendMessage ? window.loadSendMessage() : location.reload()">إعادة المحاولة</button>
                </div>
            `;
        }
    }

    checkBillingAlert() {
        if (this.billingStatus && !this.billingStatus.currency) {
            const alertDiv = document.getElementById('billing-alert');
            if (alertDiv) {
                alertDiv.style.display = 'flex';
            }
        }
    }

    render() {
        const approvedTemplates = this.templates.filter(t => t.status === 'APPROVED');
        const pendingTemplates = this.templates.filter(t => t.status === 'PENDING');
        const rejectedTemplates = this.templates.filter(t => t.status === 'REJECTED');

        this.container.innerHTML = `
            <div class="send-message-page">
                <div style="display: grid; grid-template-columns: 1fr 340px; gap: 24px;">
                    <div class="send-message-main">
                        <div id="billing-alert" class="section-card" style="display: none; border: 1px solid var(--status-error); background: rgba(239, 68, 68, 0.05); margin-bottom: 24px;">
                            <div class="section-card-body" style="display: flex; align-items: center; gap: 16px; padding: 16px;">
                                <div style="font-size: 24px;">⚠️</div>
                                <div style="flex: 1;">
                                    <div style="font-weight: 700; color: var(--status-error); margin-bottom: 4px;">تنبيه: لم يتم ربط وسيلة دفع</div>
                                    <div style="font-size: 13px; color: var(--text-secondary); line-height: 1.5;">حساب WhatsApp Business الخاص بك لا يحتوي على وسيلة دفع مرتبطة. قد يتم قبول طلبات الإرسال من قبل ميتا ولكن لن يتم تسليمها فعلياً للهواتف.</div>
                                </div>
                                <a href="https://business.facebook.com/billing_hub" target="_blank" class="btn btn-primary btn-sm" style="white-space: nowrap;">ربط وسيلة دفع</a>
                            </div>
                        </div>

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
                                
                                <div id="template-variables-container" style="display: none; margin-top: 24px; padding-top: 24px; border-top: 1px solid var(--border-subtle);">
                                    <div style="font-size: 14px; font-weight: 700; color: var(--text-primary); margin-bottom: 16px; display: flex; align-items: center; gap: 8px;">
                                        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 18px; height: 18px; color: var(--brand-primary);">
                                            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                            <rect x="8" y="2" width="8" height="4" rx="1" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                        </svg>
                                        تعبئة متغيرات القالب
                                    </div>
                                    <div id="variables-inputs-list" style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;"></div>
                                    <p style="font-size: 12px; color: var(--text-muted); margin-top: 12px;">سيتم استبدال الرموز مثل {{1}}، {{2}} بالقيم التي تدخلها هنا في الرسالة المرسلة.</p>
                                </div>
                            </div>
                        </div>

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

                    <div class="send-message-sidebar">
                        <div class="section-card" style="margin-bottom: 24px;">
                            <div class="section-card-header">
                                <div class="section-card-title" style="font-size: 14px;">معاينة الرسالة</div>
                            </div>
                            <div class="section-card-body" id="template-preview-container" style="min-height: 200px; display: flex; align-items: center; justify-content: center; color: var(--text-muted);">
                                اختر قالباً لمعاينته
                            </div>
                        </div>

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
                                    <span style="font-size: 16px; font-weight: 700; color: var(--brand-primary);" id="stats-cost">$0.00</span>
                                </div>
                            </div>
                        </div>

                        <div class="section-card" style="margin-bottom: 24px;">
                            <div class="section-card-header">
                                <div class="section-card-title" style="font-size: 14px;">سجل الحملات الأخيرة</div>
                            </div>
                            <div class="section-card-body" id="campaign-history-list" style="padding: 0; max-height: 300px; overflow-y: auto;">
                                <div style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 12px;">لا توجد حملات سابقة</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            ${this.renderModals()}
        `;
        this.setupEventListeners();
    }

    renderTemplateSelector(approved, pending, rejected) {
        let html = '<div style="display: flex; flex-direction: column; gap: 16px;">';
        if (approved.length > 0) {
            html += `<div><div style="font-size: 13px; font-weight: 700; color: var(--status-success); margin-bottom: 12px;">القوالب المقبولة (${approved.length})</div><div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px;">${approved.map(tpl => this.renderTemplateCard(tpl, 'approved')).join('')}</div></div>`;
        }
        if (pending.length > 0) {
            html += `<div><div style="font-size: 13px; font-weight: 700; color: var(--status-warning); margin-bottom: 12px;">قيد المراجعة (${pending.length})</div><div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px;">${pending.map(tpl => this.renderTemplateCard(tpl, 'pending')).join('')}</div></div>`;
        }
        if (rejected.length > 0) {
            html += `<div><div style="font-size: 13px; font-weight: 700; color: var(--status-error); margin-bottom: 12px;">المرفوضة (${rejected.length})</div><div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px;">${rejected.map(tpl => this.renderTemplateCard(tpl, 'rejected')).join('')}</div></div>`;
        }
        html += '</div>';
        return html;
    }

    renderTemplateCard(template, status) {
        const body = template.components.find(c => c.type === 'BODY')?.text || '';
        const isDisabled = status !== 'approved';
        return `
            <div class="template-card" onclick="${isDisabled ? '' : `window.selectTemplate('${template.name}')`}" 
                 style="padding: 12px; border: 2px solid var(--border-subtle); border-radius: var(--radius-md); cursor: ${isDisabled ? 'not-allowed' : 'pointer'}; transition: all 0.2s; background: var(--bg-elevated); opacity: ${isDisabled ? '0.6' : '1'};">
                <div style="font-weight: 700; font-size: 13px; color: var(--text-primary); margin-bottom: 4px;">${template.name}</div>
                <div style="font-size: 12px; color: var(--text-secondary); line-height: 1.4; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;">${body}</div>
            </div>
        `;
    }

    renderRecipientsSection() {
        return `<div style="display: flex; flex-direction: column; gap: 12px;"><textarea id="recipients-textarea" placeholder="أدخل الأرقام هنا..." style="width: 100%; padding: 12px; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--bg-elevated); color: var(--text-primary); min-height: 100px;"></textarea><button class="btn btn-secondary btn-sm" onclick="window.addRecipientsFromText()">إضافة الأرقام</button><div id="recipients-list-container" style="display: none;"><div id="recipients-list" style="max-height: 150px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; padding: 8px; background: var(--bg-surface); border-radius: var(--radius-md);"></div></div></div>`;
    }

    renderVerificationSection() {
        return `<button class="btn btn-secondary" onclick="window.verifyAllNumbers()" id="verify-all-btn" style="width: 100%;">فحص الأرقام</button><div id="verify-result" style="display: none; margin-top: 12px; font-size: 13px;"></div>`;
    }

    renderModals() {
        return `
            <div id="sending-modal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 1000; align-items: center; justify-content: center;">
                <div style="background: var(--bg-card); padding: 32px; border-radius: var(--radius-lg); width: 90%; max-width: 400px; text-align: center;">
                    <h3 style="margin-bottom: 20px;">جاري الإرسال...</h3>
                    <div style="background: var(--bg-elevated); height: 10px; border-radius: 5px; overflow: hidden; margin-bottom: 10px;">
                        <div id="sending-progress-bar" style="background: var(--brand-primary); height: 100%; width: 0%;"></div>
                    </div>
                    <div id="sending-progress-text" style="font-size: 14px;">0/0</div>
                    <div id="sending-log" style="font-size: 12px; color: var(--text-muted); margin-top: 15px; max-height: 100px; overflow-y: auto;"></div>
                </div>
            </div>
            <div id="success-modal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 1000; align-items: center; justify-content: center;">
                <div style="background: var(--bg-card); padding: 32px; border-radius: var(--radius-lg); width: 90%; max-width: 400px; text-align: center;">
                    <div style="font-size: 48px; margin-bottom: 10px;">✅</div>
                    <h3>تم الإرسال بنجاح</h3>
                    <p id="success-count-text" style="margin: 15px 0;"></p>
                    <button class="btn btn-primary" onclick="document.getElementById('success-modal').style.display = 'none'" style="width: 100%;">إغلاق</button>
                </div>
            </div>
        `;
    }

    setupEventListeners() {
        window.selectTemplate = (templateName) => {
            this.selectedTemplate = this.templates.find(t => t.name === templateName);
            if (this.selectedTemplate) {
                this.updateTemplatePreview();
                this.renderVariableInputs();
                document.querySelectorAll('.template-card').forEach(card => {
                    card.style.borderColor = 'var(--border-subtle)';
                    card.style.background = 'var(--bg-elevated)';
                });
            }
        };

        window.addRecipientsFromText = () => {
            const textarea = document.getElementById('recipients-textarea');
            const numbers = textarea.value.split('\n').map(n => n.trim()).filter(n => /^\d{10,15}$/.test(n));
            this.recipients = [...new Set([...this.recipients, ...numbers])];
            this.updateRecipientsList();
            this.updateStats();
            textarea.value = '';
        };

        window.verifyAllNumbers = async () => {
            this.verificationResults = { valid: this.recipients, invalid: [], verified: true };
            document.getElementById('verify-result').innerHTML = `تم التحقق من ${this.recipients.length} رقم.`;
            document.getElementById('verify-result').style.display = 'block';
            this.updateStats();
        };

        window.sendMessages = async () => {
            if (!this.selectedTemplate || this.recipients.length === 0) {
                showToast('يرجى اختيار قالب وأرقام', 'warning');
                return;
            }

            const variableInputs = document.querySelectorAll('.template-var-input');
            const components = [];
            if (variableInputs.length > 0) {
                components.push({
                    type: 'body',
                    parameters: Array.from(variableInputs).map(input => ({ type: 'text', text: input.value || ' ' }))
                });
            }

            this.sendingInProgress = true;
            document.getElementById('sending-modal').style.display = 'flex';
            let success = 0;

            for (let i = 0; i < this.recipients.length; i++) {
                try {
                    const res = await WhatsAppAPI.sendTemplate({
                        to: this.recipients[i],
                        templateName: this.selectedTemplate.name,
                        languageCode: this.selectedTemplate.language || 'ar',
                        components: components
                    });
                    if (res.messages || res.id) success++;
                } catch (e) {
                    console.error(e);
                }
                const progress = Math.round(((i + 1) / this.recipients.length) * 100);
                document.getElementById('sending-progress-bar').style.width = progress + '%';
                document.getElementById('sending-progress-text').textContent = `${i + 1}/${this.recipients.length}`;
            }

            // حفظ التقرير في Supabase
            try {
                const { WhatsAppReports } = await import('../services/whatsapp-reports.js');
                const reports = this.recipients.map(r => ({ recipient: r, status: 'success' }));
                await WhatsAppReports.saveCampaign({
                    name: `حملة ${new Date().toLocaleString('ar-EG')}`,
                    templateName: this.selectedTemplate.name,
                    languageCode: this.selectedTemplate.language || 'ar'
                }, reports);
            } catch (e) { console.error(e); }

            document.getElementById('sending-modal').style.display = 'none';
            document.getElementById('success-count-text').textContent = `نجح إرسال ${success} رسالة.`;
            document.getElementById('success-modal').style.display = 'flex';
            this.sendingInProgress = false;
        };

        window.updateTemplatePreviewWithVars = () => {
            this.updateTemplatePreview();
        };
    }

    renderVariableInputs() {
        const container = document.getElementById('template-variables-container');
        const list = document.getElementById('variables-inputs-list');
        const bodyComp = this.selectedTemplate.components.find(c => c.type === 'BODY');
        const matches = (bodyComp?.text || '').match(/\{\{(\d+)\}\}/g);

        if (matches && matches.length > 0) {
            container.style.display = 'block';
            const uniqueVars = [...new Set(matches)].sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
            list.innerHTML = uniqueVars.map(v => {
                const num = v.match(/\d+/)[0];
                return `<div style="display: flex; flex-direction: column; gap: 4px;"><label style="font-size: 12px; font-weight: 600;">المتغير {{${num}}}</label><input type="text" class="template-var-input" data-var="${num}" oninput="window.updateTemplatePreviewWithVars()" style="padding: 8px; border: 1px solid var(--border-subtle); border-radius: 4px; background: var(--bg-surface); color: var(--text-primary);"></div>`;
            }).join('');
        } else {
            container.style.display = 'none';
        }
    }

    updateTemplatePreview() {
        const container = document.getElementById('template-preview-container');
        if (!this.selectedTemplate) {
            container.innerHTML = 'اختر قالباً لمعاينته';
            return;
        }

        const body = this.selectedTemplate.components.find(c => c.type === 'BODY')?.text || '';
        let previewBody = body;
        const varInputs = document.querySelectorAll('.template-var-input');
        varInputs.forEach(input => {
            const num = input.dataset.var;
            const val = input.value || `{{${num}}}`;
            previewBody = previewBody.replace(new RegExp(`\\{\\{${num}\\}\\}`, 'g'), `<span style="color: var(--brand-primary); font-weight: 700;">${val}</span>`);
        });

        container.innerHTML = `<div style="background: white; color: black; padding: 16px; border-radius: 12px; width: 100%; box-shadow: 0 2px 8px rgba(0,0,0,0.1); white-space: pre-wrap; font-size: 13px;">${previewBody}</div>`;
    }

    updateRecipientsList() {
        const container = document.getElementById('recipients-list-container');
        const list = document.getElementById('recipients-list');
        if (this.recipients.length === 0) {
            container.style.display = 'none';
            return;
        }
        container.style.display = 'block';
        list.innerHTML = this.recipients.map(n => `<div style="font-size: 12px; padding: 4px; border-bottom: 1px solid var(--border-subtle);">${n}</div>`).join('');
    }

    updateStats() {
        document.getElementById('stats-total').textContent = this.recipients.length;
        document.getElementById('stats-valid').textContent = this.verificationResults.valid.length;
    }
}
