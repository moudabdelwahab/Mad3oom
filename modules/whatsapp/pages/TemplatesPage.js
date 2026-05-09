import { WhatsAppAPI } from '../services/whatsapp-api.js';

export class TemplatesPage {
    constructor(container) {
        this.container = container;
    }

    async load() {
        this.container.innerHTML = '<div style="padding: 40px; text-align: center;">جاري تحميل القوالب...</div>';
        try {
            const response = await WhatsAppAPI.getTemplates();
            this.render(response.data || []);
        } catch (error) {
            this.container.innerHTML = `<div style="padding: 40px; text-align: center; color: var(--status-error);">خطأ في تحميل القوالب: ${error.message}</div>`;
        }
    }

    render(templates) {
        if (templates.length === 0) {
            this.container.innerHTML = `
                <div style="text-align: center; padding: 60px 20px;">
                    <div style="font-size: 48px; margin-bottom: 20px;">📄</div>
                    <h3 style="margin-bottom: 10px;">لا توجد قوالب حالياً</h3>
                    <p style="color: var(--text-secondary); margin-bottom: 24px;">قم بإنشاء أول قالب لك للبدء في إرسال الرسائل.</p>
                    <button class="btn btn-primary" onclick="window.openNewTemplateModal()">إنشاء قالب جديد</button>
                </div>
            `;
            return;
        }

        let html = `
            <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; padding: 20px;">
        `;

        templates.forEach(tpl => {
            const statusClass = tpl.status === 'APPROVED' ? 'success' : (tpl.status === 'REJECTED' ? 'error' : 'warning');
            const statusText = tpl.status === 'APPROVED' ? 'مقبول' : (tpl.status === 'REJECTED' ? 'مرفوض' : 'قيد المراجعة');
            
            html += `
                <div class="section-card" style="display: flex; flex-direction: column;">
                    <div class="section-card-header" style="padding: 15px 20px;">
                        <div style="font-weight: 700; font-size: 14px;">${tpl.name}</div>
                        <span class="tag" style="background: var(--status-${statusClass}-bg); color: var(--status-${statusClass}); border: none;">${statusText}</span>
                    </div>
                    <div class="section-card-body" style="flex: 1; padding: 15px 20px;">
                        <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 8px;">اللغة: ${tpl.language} | الفئة: ${tpl.category}</div>
                        <div style="background: var(--bg-elevated); padding: 12px; border-radius: 8px; font-size: 13px; white-space: pre-wrap; max-height: 150px; overflow-y: auto;">${tpl.components.find(c => c.type === 'BODY')?.text || ''}</div>
                    </div>
                    <div style="padding: 12px 20px; border-top: 1px solid var(--border-subtle); display: flex; justify-content: flex-end; gap: 10px;">
                        <button class="btn btn-ghost btn-sm" onclick="window.deleteTemplate('${tpl.name}')" style="color: var(--status-error);">حذف</button>
                    </div>
                </div>
            `;
        });

        html += `</div>`;
        this.container.innerHTML = html;
    }
}
