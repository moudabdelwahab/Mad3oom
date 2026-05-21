import { WhatsAppAPI } from '../services/whatsapp-api.js';

export class TemplatesPage {
    constructor(container) {
        this.container = container;
        this.templates = [];
    }

    async load() {
        this.container.innerHTML = `
            <div style="padding: 40px; text-align: center;">
                <div class="spinner" style="margin: 0 auto 15px;"></div>
                جاري تحميل القوالب من ميتا...
            </div>
        `;
        try {
            const response = await WhatsAppAPI.getTemplates();
            this.templates = response.data || [];
            this.render(this.templates);
        } catch (error) {
            this.container.innerHTML = `
                <div style="padding: 40px; text-align: center;">
                    <div style="color: var(--status-error); margin-bottom: 15px;">❌ خطأ في تحميل القوالب: ${error.message}</div>
                    <button class="btn btn-secondary btn-sm" onclick="window.loadTemplates()">إعادة المحاولة</button>
                </div>
            `;
        }
    }

    render(templates) {
        if (templates.length === 0) {
            this.container.innerHTML = `
                <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 100px 20px; text-align: center;">
                    <div style="width: 120px; height: 120px; background: var(--bg-elevated); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-bottom: 30px; border: 4px solid var(--border-subtle); position: relative;">
                        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 60px; height: 60px; color: var(--text-muted);">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                            <polyline points="14 2 14 8 20 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                            <line x1="16" y1="13" x2="8" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                            <line x1="16" y1="17" x2="8" y2="17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                            <polyline points="10 9 9 9 8 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                        <div style="position: absolute; bottom: 5px; right: 5px; background: var(--brand-primary); width: 32px; height: 32px; border-radius: 50%; border: 4px solid var(--bg-card); display: flex; align-items: center; justify-content: center; color: white;">
                            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 16px; height: 16px;">
                                <line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
                                <line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
                            </svg>
                        </div>
                    </div>
                    <h3 style="margin: 0 0 12px; font-size: 22px; font-weight: 800; color: var(--text-primary);">لا توجد قوالب حالياً</h3>
                    <p style="color: var(--text-secondary); margin: 0 0 32px; max-width: 400px; line-height: 1.6; font-size: 15px;">ابدأ الآن بإنشاء أول قالب رسالة لك ليتم مراجعته واستخدامه في حملاتك عبر واتساب.</p>
                    <button class="btn btn-primary" onclick="window.openNewTemplateModal()" style="padding: 12px 32px; font-size: 15px; font-weight: 700; border-radius: 12px; box-shadow: 0 10px 20px -5px var(--brand-primary-alpha);">إنشاء قالب جديد</button>
                </div>
            `;
            return;
        }

        let html = `
            <div style="padding: 20px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                    <div style="font-size: 14px; color: var(--text-secondary);">إجمالي القوالب: <strong>${templates.length}</strong></div>
                    <button class="btn btn-ghost btn-sm" onclick="window.loadTemplates()" style="display: flex; align-items: center; gap: 6px;">
                        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 14px; height: 14px;">
                            <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36M20.49 15a9 9 0 0 1-14.85 3.36" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                        مزامنة مع ميتا
                    </button>
                </div>
                <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 20px;">
        `;

        templates.forEach(tpl => {
            const statusMap = {
                'APPROVED': { text: 'مقبول', class: 'success' },
                'REJECTED': { text: 'مرفوض', class: 'error' },
                'PENDING': { text: 'قيد المراجعة', class: 'warning' },
                'PAUSED': { text: 'متوقف مؤقتاً', class: 'warning' },
                'DISABLED': { text: 'معطل', class: 'error' }
            };
            
            const status = statusMap[tpl.status] || { text: tpl.status, class: 'info' };
            const categoryMap = {
                'MARKETING': 'تسويق',
                'UTILITY': 'خدمي',
                'AUTHENTICATION': 'تحقق'
            };
            
            const body = tpl.components.find(c => c.type === 'BODY')?.text || '';
            const header = tpl.components.find(c => c.type === 'HEADER');
            const footer = tpl.components.find(c => c.type === 'FOOTER')?.text || '';
            const buttons = tpl.components.find(c => c.type === 'BUTTONS')?.buttons || [];

            // Find rejection reason if exists
            const rejectionReason = tpl.rejected_reason || '';

            html += `
                <div class="section-card" style="display: flex; flex-direction: column; transition: transform 0.2s; height: 100%; position: relative;">
                    <div class="section-card-header" style="padding: 15px 20px; border-bottom: 1px solid var(--border-subtle);">
                        <div style="overflow: hidden;">
                            <div style="font-weight: 700; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${tpl.name}">${tpl.name}</div>
                            <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">${categoryMap[tpl.category] || tpl.category} • ${tpl.language}</div>
                        </div>
                        <span class="tag" style="background: var(--status-${status.class}-bg); color: var(--status-${status.class}); border: none; flex-shrink: 0;">${status.text}</span>
                    </div>
                    <div class="section-card-body" style="flex: 1; padding: 15px 20px; display: flex; flex-direction: column; gap: 10px;">
                        ${tpl.status === 'REJECTED' ? `
                            <div style="background: rgba(255, 82, 82, 0.1); border: 1px solid rgba(255, 82, 82, 0.2); padding: 12px; border-radius: 12px; font-size: 12px; color: #ff5252; margin-bottom: 10px; line-height: 1.4;">
                                <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
                                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 14px; height: 14px;"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><line x1="12" y1="8" x2="12" y2="12" stroke="currentColor" stroke-width="2"/><line x1="12" y1="16" x2="12.01" y2="16" stroke="currentColor" stroke-width="2"/></svg>
                                    <strong>تم رفض القالب من ميتا</strong>
                                </div>
                                <div style="margin-bottom: 8px; opacity: 0.9;">${rejectionReason || 'السبب: مخالفة سياسات ميتا أو نقص في الأمثلة (Examples) للمتغيرات.'}</div>
                                <button class="btn btn-primary btn-sm" style="width: 100%; background: #ff5252; border: none; font-size: 11px; height: 28px;" onclick='window.editRejectedTemplate(${JSON.stringify(tpl).replace(/'/g, "&apos;")})'>تعديل وإعادة إرسال ✍️</button>
                            </div>
                        ` : ''}
                        
                        <div style="background: var(--bg-elevated); padding: 15px; border-radius: 12px; font-size: 13px; border: 1px solid var(--border-subtle); position: relative; flex: 1;">
                            ${header ? `<div style="font-weight: 700; margin-bottom: 8px; border-bottom: 1px solid var(--border-subtle); padding-bottom: 5px; font-size: 12px; color: var(--text-primary);">${header.format === 'TEXT' ? header.text : '📷 وسائط (' + header.format + ')'}</div>` : ''}
                            <div style="white-space: pre-wrap; color: var(--text-primary); line-height: 1.5;">${body}</div>
                            ${footer ? `<div style="margin-top: 10px; font-size: 11px; color: var(--text-muted); border-top: 1px dashed var(--border-subtle); padding-top: 5px;">${footer}</div>` : ''}
                        </div>
                        
                        ${buttons.length > 0 ? `
                            <div style="display: flex; flex-direction: column; gap: 6px;">
                                ${buttons.map(btn => `
                                    <div style="background: white; color: #00a884; border: 1px solid #e9edef; padding: 8px; border-radius: 8px; text-align: center; font-size: 12px; font-weight: 600;">
                                        ${btn.type === 'URL' ? '🔗 ' : (btn.type === 'PHONE_NUMBER' ? '📞 ' : '💬 ')}${btn.text}
                                    </div>
                                `).join('')}
                            </div>
                        ` : ''}
                    </div>
                    <div style="padding: 12px 20px; border-top: 1px solid var(--border-subtle); display: flex; justify-content: flex-end; gap: 10px; background: var(--bg-surface);">
                        <button class="btn btn-ghost btn-sm" onclick="window.deleteTemplate('${tpl.name}')" style="color: var(--status-error); padding: 5px 10px;">
                            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 14px; height: 14px; margin-left: 4px;">
                                <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                            حذف من ميتا
                        </button>
                    </div>
                </div>
            `;
        });

        html += `</div></div>`;
        this.container.innerHTML = html;
    }
}
