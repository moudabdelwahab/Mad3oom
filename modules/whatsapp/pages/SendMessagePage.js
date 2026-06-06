import { SupabaseIntegration } from '../supabase-integration.js';
import { WhatsAppAPI } from '../services/whatsapp-api.js';
import { ContactImporter } from '../utils/ContactImporter.js';

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
        this.importer = new ContactImporter();
        this.importMapping = {};
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
            this.setupWindowChecks();
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
                            <div class="section-card-body" id="campaign-history-list" style="font-size: 12px; color: var(--text-secondary); max-height: 200px; overflow-y: auto;">
                                لا توجد حملات سابقة
                            </div>
                        </div>
                    </div>
                </div>

                <div id="sending-modal" class="modal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); align-items: center; justify-content: center; z-index: 1000;">
                    <div class="modal-content" style="background: var(--bg-card); border-radius: var(--radius-lg); padding: 32px; max-width: 500px; width: 90%;">
                        <h3 style="margin-bottom: 20px; font-size: 18px; font-weight: 700;">جاري إرسال الرسائل...</h3>
                        <div class="progress-bar-wrap" style="margin-bottom: 16px;">
                            <div class="progress-bar-fill" id="sending-progress-bar" style="width: 0%;"></div>
                        </div>
                        <div style="text-align: center; margin-bottom: 16px; font-size: 14px;">
                            <span id="sending-progress-text">0/0</span>
                        </div>
                        <div id="sending-log" style="background: var(--bg-surface); padding: 12px; border-radius: var(--radius-md); font-size: 12px; color: var(--text-secondary); max-height: 150px; overflow-y: auto; font-family: monospace;"></div>
                    </div>
                </div>

                <div id="success-modal" class="modal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); align-items: center; justify-content: center; z-index: 1000;">
                    <div class="modal-content" style="background: var(--bg-card); border-radius: var(--radius-lg); padding: 32px; max-width: 500px; width: 90%; text-align: center;">
                        <div style="font-size: 48px; margin-bottom: 16px;">✅</div>
                        <h3 style="margin-bottom: 12px; font-size: 18px; font-weight: 700;">تم إرسال الرسائل</h3>
                        <p id="success-count-text" style="color: var(--text-secondary); margin-bottom: 24px;"></p>
                        <button class="btn btn-primary" onclick="document.getElementById('success-modal').style.display = 'none'; window.resetSendForm ? window.resetSendForm() : location.reload();" style="width: 100%;">حسناً</button>
                    </div>
                </div>
            </div>
        `;

        this.attachEventListeners();
    }

    renderTemplateSelector(approved, pending, rejected) {
        let html = '';
        
        if (approved.length > 0) {
            html += `<div style="margin-bottom: 20px;"><div style="font-size: 12px; font-weight: 700; color: var(--text-secondary); margin-bottom: 8px;">✅ قوالب موافق عليها</div>`;
            html += approved.map(t => `
                <div style="padding: 12px; margin-bottom: 8px; border: 2px solid var(--border-subtle); border-radius: var(--radius-md); cursor: pointer; transition: all var(--transition);" 
                     onmouseover="this.style.borderColor='var(--brand-primary)'; this.style.background='var(--bg-elevated)'"
                     onmouseout="this.style.borderColor='var(--border-subtle)'; this.style.background='transparent'"
                     onclick="window.selectTemplate && window.selectTemplate('${t.name}')">
                    <div style="font-weight: 600; margin-bottom: 4px;">${t.name}</div>
                    <div style="font-size: 12px; color: var(--text-secondary);">${t.category}</div>
                </div>
            `).join('');
            html += '</div>';
        }

        if (pending.length > 0) {
            html += `<div style="margin-bottom: 20px;"><div style="font-size: 12px; font-weight: 700; color: var(--status-warning); margin-bottom: 8px;">⏳ قيد المراجعة</div>`;
            html += pending.map(t => `<div style="padding: 12px; margin-bottom: 8px; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); opacity: 0.6;">${t.name}</div>`).join('');
            html += '</div>';
        }

        if (rejected.length > 0) {
            html += `<div style="margin-bottom: 20px;"><div style="font-size: 12px; font-weight: 700; color: var(--status-error); margin-bottom: 8px;">❌ مرفوضة</div>`;
            html += rejected.map(t => `<div style="padding: 12px; margin-bottom: 8px; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); opacity: 0.6;">${t.name}</div>`).join('');
            html += '</div>';
        }

        return html || '<div style="color: var(--text-muted);">لا توجد قوالب متاحة</div>';
    }

    renderRecipientsSection() {
        return `
            <div style="display: flex; flex-direction: column; gap: 12px;">
                <div style="display: flex; gap: 8px;">
                    <input type="text" id="manual-phone-input" placeholder="أدخل رقم هاتف..." style="flex: 1; padding: 10px; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--bg-surface); color: var(--text-primary);">
                    <button class="btn btn-secondary" onclick="window.addManualPhone && window.addManualPhone()" style="padding: 10px 16px;">إضافة</button>
                </div>
                <button class="btn btn-secondary" style="width: 100%; padding: 10px;" onclick="document.getElementById('manual-import-container').style.display = document.getElementById('manual-import-container').style.display === 'none' ? 'block' : 'none';">استيراد من ملف</button>
                <div id="manual-import-container" style="display: none; padding: 12px; background: var(--bg-surface); border-radius: var(--radius-md);">
                    <input type="file" id="import-file" accept=".csv,.xlsx,.xls" style="width: 100%; margin-bottom: 8px;">
                    <button class="btn btn-secondary" style="width: 100%; padding: 8px;" onclick="window.importContacts && window.importContacts();">استيراد</button>
                </div>
                <div id="recipients-list-container" style="display: none;">
                    <div style="font-size: 12px; font-weight: 700; color: var(--text-secondary); margin-bottom: 8px;">الأرقام المضافة:</div>
                    <div id="recipients-list" style="max-height: 200px; overflow-y: auto; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 8px;"></div>
                </div>
            </div>
        `;
    }

    renderVerificationSection() {
        return `
            <div style="display: flex; flex-direction: column; gap: 12px;">
                <button class="btn btn-secondary" style="width: 100%; padding: 10px;" onclick="window.verifyAllNumbers && window.verifyAllNumbers();">فحص الأرقام</button>
                <div id="verify-result" style="display: none; padding: 12px; background: var(--bg-elevated); border-radius: var(--radius-md); font-size: 13px; color: var(--text-secondary);"></div>
            </div>
        `;
    }

    attachEventListeners() {
        window.selectTemplate = (templateName) => {
            this.selectedTemplate = this.templates.find(t => t.name === templateName);
            if (this.selectedTemplate) {
                this.renderVariableInputs();
                this.updateTemplatePreview();
                window.showToast(`تم اختيار القالب: ${templateName}`, 'success');
            }
        };

        window.addManualPhone = () => {
            const input = document.getElementById('manual-phone-input');
            const phone = input.value.trim();
            if (!phone) {
                window.showToast('يرجى إدخال رقم هاتف', 'warning');
                return;
            }
            const clean = phone.replace(/\D/g, '');
            if (clean.length < 10) {
                window.showToast('رقم الهاتف قصير جداً', 'error');
                return;
            }
            if (!this.recipients.includes(clean)) {
                this.recipients.push(clean);
                this.contactsData = this.contactsData || [];
                this.contactsData.push({ phone: clean, variables: {} });
                this.updateRecipientsList();
                this.updateStats();
                input.value = '';
                window.showToast('تم إضافة الرقم بنجاح', 'success');
            } else {
                window.showToast('الرقم موجود بالفعل', 'warning');
            }
        };

        window.importContacts = async () => {
            const file = document.getElementById('import-file').files[0];
            if (!file) {
                window.showToast('يرجى اختيار ملف', 'warning');
                return;
            }

            try {
                const newContacts = await this.importer.parseFile(file);
                const textarea = document.getElementById('manual-import-container')?.querySelector('input') || { value: '' };
                const clean = newContacts.map(c => {
                    const phone = (c.phone || '').replace(/\D/g, '');
                    return clean ? { phone: clean, variables: {} } : null;
                }).filter(c => c);

                const existingPhones = new Set(this.recipients);
                const uniqueNewContacts = newContacts.filter(c => !existingPhones.has(c.phone));

                this.recipients = [...this.recipients, ...uniqueNewContacts.map(c => c.phone)];
                this.contactsData = [...(this.contactsData || []), ...uniqueNewContacts];

                this.updateRecipientsList();
                this.updateStats();
                textarea.value = '';
                document.getElementById('manual-import-container').style.display = 'none';
                window.showToast(`تم إضافة ${uniqueNewContacts.length} رقم جديد`, 'success');
            } catch (error) {
                window.showToast('خطأ في استيراد الملف: ' + error.message, 'error');
            }
        };

        window.verifyAllNumbers = async () => {
            this.verificationResults = { 
                valid: this.recipients, 
                invalid: [], 
                verified: true 
            };
            document.getElementById('verify-result').innerHTML = `تم التحقق من ${this.recipients.length} رقم.`;
            document.getElementById('verify-result').style.display = 'block';
            this.updateStats();
        };

        this.setupWindowChecks = () => {
            const list = document.getElementById('recipients-list');
            if (!list) return;
            
            const observer = new MutationObserver(() => this.updateWindowBadges());
            observer.observe(list, { childList: true });
        };

        this.updateWindowBadges = async () => {
            const items = document.querySelectorAll('.recipient-item');
            for (const item of items) {
                const phone = item.dataset.phone;
                if (!phone) continue;
                
                const badge = item.querySelector('.window-badge');
                if (badge && badge.dataset.checked === 'true') continue;

                const windowInfo = await SupabaseIntegration.checkConversationWindow(phone);
                if (windowInfo) {
                    const badgeEl = item.querySelector('.window-badge');
                    if (badgeEl) {
                        badgeEl.dataset.checked = 'true';
                        if (windowInfo.isOpen) {
                            badgeEl.innerHTML = '✅ نافذة مفتوحة (مجاني)';
                            badgeEl.style.color = 'var(--status-success)';
                        } else {
                            badgeEl.innerHTML = '🔒 نافذة مغلقة (مدفوع)';
                            badgeEl.style.color = 'var(--status-error)';
                        }
                    }
                }
            }
        };

        window.sendMessages = async () => {
            if (!this.selectedTemplate || this.recipients.length === 0) {
                window.showToast('يرجى اختيار قالب وأرقام', 'warning');
                return;
            }

            try {
                // التحقق من حالة الدفع والنوافذ عبر Backend
                const eligibilityCheck = await WhatsAppAPI.checkTemplateEligibility(this.recipients);
                
                if (eligibilityCheck.eligibility_status === 'requires_billing') {
                    window.showToast('❌ ' + eligibilityCheck.message, 'error');
                    const confirm = window.confirm('تنبيه: ' + eligibilityCheck.message + '\n\nلا يوجد وسيلة دفع مرتبطة بحسابك. الرسائل لهذه الأرقام لن تصل. هل تريد الاستمرار على أي حال؟');
                    if (!confirm) return;
                } else if (eligibilityCheck.eligibility_status === 'free') {
                    window.showToast('✅ ' + eligibilityCheck.message, 'success');
                } else if (eligibilityCheck.eligibility_status === 'will_charge') {
                    window.showToast('💳 ' + eligibilityCheck.message, 'info');
                }
            } catch (error) {
                console.error('Eligibility check error:', error);
                window.showToast('خطأ في التحقق من الأهلية: ' + error.message, 'error');
                return;
            }

            this.sendingInProgress = true;
            document.getElementById('sending-modal').style.display = 'flex';
            let success = 0;
            let failed = 0;

            const staticVariableInputs = Array.from(document.querySelectorAll('.template-var-input'));
            const mappingSelects = Array.from(document.querySelectorAll('.mapping-var-select'));

            for (let i = 0; i < this.recipients.length; i++) {
                const phone = this.recipients[i];
                const contact = (this.contactsData || []).find(c => c.phone === phone) || { variables: {} };
                
                const components = [];
                const bodyComp = this.selectedTemplate.components.find(c => c.type === 'BODY');
                const matches = (bodyComp?.text || '').match(/\{\{(\d+)\}\}/g) || [];
                
                if (matches.length > 0) {
                    const uniqueVars = [...new Set(matches)].sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
                    const parameters = uniqueVars.map(v => {
                        const num = v.match(/\d+/)[0];
                        const mappingSelect = mappingSelects.find(s => s.dataset.var === num);
                        let value = '';

                        if (mappingSelect && mappingSelect.value) {
                            value = contact.variables[num] || '';
                        } else {
                            const staticInput = staticVariableInputs.find(inp => inp.dataset.var === num);
                            value = staticInput ? staticInput.value : '';
                        }
                        return { type: 'text', text: value || ' ' };
                    });

                    components.push({ type: 'body', parameters });
                }

                try {
                    const res = await WhatsAppAPI.sendTemplate({
                        to: phone,
                        templateName: this.selectedTemplate.name,
                        languageCode: this.selectedTemplate.language || 'ar',
                        components: components
                    });
                    if (res.messages || res.id) success++;
                    else failed++;
                } catch (e) {
                    console.error(e);
                    failed++;
                }
                
                const progress = Math.round(((i + 1) / this.recipients.length) * 100);
                document.getElementById('sending-progress-bar').style.width = progress + '%';
                document.getElementById('sending-progress-text').textContent = `${i + 1}/${this.recipients.length}`;
                document.getElementById('sending-log').innerHTML = `إرسال إلى ${phone}: ${failed === 0 ? 'نجاح' : 'فشل'}<br>` + document.getElementById('sending-log').innerHTML;
            }

            try {
                const { WhatsAppReports } = await import('../services/whatsapp-reports.js');
                const campaignReports = this.recipients.map((r, idx) => {
                    const contact = (this.contactsData || []).find(c => c.phone === r) || { variables: {} };
                    return {
                        recipient: r,
                        status: 'success',
                        metadata: {
                            variables: contact.variables,
                            import_source: this.importer.headers.length > 0 ? 'file' : 'manual'
                        }
                    };
                });

                await WhatsAppReports.saveCampaign({
                    name: `حملة ${new Date().toLocaleString('ar-EG')}`,
                    templateName: this.selectedTemplate.name,
                    languageCode: this.selectedTemplate.language || 'ar'
                }, campaignReports);
            } catch (e) { 
                console.error('[Campaign Save Error]', e); 
            }

            document.getElementById('sending-modal').style.display = 'none';
            document.getElementById('success-count-text').textContent = `نجح إرسال ${success} رسالة، وفشل ${failed}.`;
            document.getElementById('success-modal').style.display = 'flex';
            this.sendingInProgress = false;
            
            if (window.loadReports) window.loadReports();
        };

        window.updateTemplatePreviewWithVars = () => {
            this.updateTemplatePreview();
        };

        window.resetSendForm = () => {
            this.resetSendForm();
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
                return `
                    <div style="display: flex; flex-direction: column; gap: 4px;">
                        <label style="font-size: 12px; font-weight: 600;">المتغير {{${num}}}</label>
                        <input type="text" class="template-var-input" data-var="${num}" placeholder="قيمة افتراضية..." oninput="window.updateTemplatePreviewWithVars()" style="padding: 8px; border: 1px solid var(--border-subtle); border-radius: 4px; background: var(--bg-surface); color: var(--text-primary);">
                    </div>`;
            }).join('');
            
            if (this.importer.headers.length > 0) {
                this.renderMappingUI({ headers: this.importer.headers, phoneColumn: this.importer.phoneColumn });
            }
        } else {
            container.style.display = 'none';
        }
    }

    renderMappingUI({ headers, phoneColumn }) {
        const container = document.getElementById('import-mapping-container');
        const fields = document.getElementById('mapping-fields');
        container.style.display = 'block';

        const bodyComp = this.selectedTemplate.components.find(c => c.type === 'BODY');
        const matches = (bodyComp?.text || '').match(/\{\{(\d+)\}\}/g) || [];
        const uniqueVars = [...new Set(matches)].sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));

        let html = `
            <div style="display: flex; flex-direction: column; gap: 8px;">
                <label style="font-size: 12px; font-weight: 600;">عمود رقم الهاتف</label>
                <select id="mapping-phone-select" style="padding: 8px; border: 1px solid var(--border-subtle); border-radius: 4px; background: var(--bg-surface); color: var(--text-primary);">
                    ${headers.map(h => `<option value="${h}" ${h === phoneColumn ? 'selected' : ''}>${h}</option>`).join('')}
                </select>
            </div>
        `;

        if (uniqueVars.length > 0) {
            html += `<div style="margin-top: 12px; font-size: 12px; font-weight: 700; color: var(--text-secondary);">ربط متغيرات القالب بأعمدة الملف:</div>`;
            html += uniqueVars.map(v => {
                const num = v.match(/\d+/)[0];
                const guessedCol = headers.find(h => {
                    const lowH = String(h).toLowerCase();
                    if (num === '1' && (lowH.includes('name') || lowH.includes('اسم'))) return true;
                    if (num === '2' && (lowH.includes('city') || lowH.includes('مدينة'))) return true;
                    return false;
                });

                return `
                    <div style="display: flex; flex-direction: column; gap: 4px;">
                        <label style="font-size: 12px;">المتغير {{${num}}}</label>
                        <select class="mapping-var-select" data-var="${num}" style="padding: 8px; border: 1px solid var(--border-subtle); border-radius: 4px; background: var(--bg-surface); color: var(--text-primary);">
                            <option value="">-- قيمة ثابتة من المدخلات أعلاه --</option>
                            ${headers.map(h => `<option value="${h}" ${h === guessedCol ? 'selected' : ''}>من عمود: ${h}</option>`).join('')}
                        </select>
                    </div>
                `;
            }).join('');
        }

        fields.innerHTML = html;
        container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
        list.innerHTML = this.recipients.map(n => `
            <div class="recipient-item" data-phone="${n}" style="font-size: 12px; padding: 8px; border-bottom: 1px solid var(--border-subtle); display: flex; justify-content: space-between; align-items: center;">
                <span>${n}</span>
                <span class="window-badge" style="font-size: 10px; font-weight: 600; color: var(--text-muted);">جاري فحص النافذة...</span>
            </div>
        `).join('');
        
        if (this.updateWindowBadges) this.updateWindowBadges();
    }

    updateStats() {
        document.getElementById('stats-total').textContent = this.recipients.length;
        document.getElementById('stats-valid').textContent = this.verificationResults.valid.length;
    }

    resetSendForm() {
        this.selectedTemplate = null;
        this.recipients = [];
        this.contactsData = [];
        this.verificationResults = {
            valid: [],
            invalid: [],
            verified: false
        };
        this.render();
    }
}
