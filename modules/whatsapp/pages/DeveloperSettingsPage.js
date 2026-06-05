import { SupabaseIntegration } from '../supabase-integration.js';
import { WhatsAppAPI } from '../services/whatsapp-api.js';

export class DeveloperSettingsPage {
    constructor(container) {
        this.container = container;
        this.integration = null;
    }

    async mount() {
        await this.load();
    }

    async load() {
        this.container.innerHTML = `
            <div style="padding: 40px; text-align: center;">
                <div class="spinner" style="margin: 0 auto 15px;"></div>
                جاري تحميل إعدادات المطور...
            </div>
        `;
        
        try {
            this.integration = await SupabaseIntegration.getIntegration();
            this.render();
        } catch (error) {
            this.container.innerHTML = `
                <div style="padding: 40px; text-align: center; color: var(--status-error);">
                    خطأ في تحميل الإعدادات: ${error.message}
                </div>
            `;
        }
    }

    render() {
        const metadata = this.integration?.metadata || {};
        // Use access_token as the API key for now as per current structure
        const apiKey = this.integration?.access_token || 'لم يتم ربط الحساب بعد';

        this.container.innerHTML = `
            <div style="padding: 24px; max-width: 900px; margin: 0 auto;">
                <div style="margin-bottom: 32px;">
                    <h2 style="font-size: 24px; font-weight: 800; margin-bottom: 8px;">إعدادات المطور</h2>
                    <p style="color: var(--text-secondary); font-size: 14px;">إدارة مفاتيح API، روابط الويب هوك، ومعلومات الربط التقنية.</p>
                </div>

                <div style="display: flex; flex-direction: column; gap: 24px;">
                    <!-- API Access Section -->
                    <div class="section-card">
                        <div class="section-card-header">
                            <div class="section-card-title">
                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="color: var(--brand-primary); width: 20px; height: 20px;">
                                    <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3-3.5 3.5z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                                مفاتيح الوصول (API Keys)
                            </div>
                        </div>
                        <div class="section-card-body">
                            <div style="margin-bottom: 15px;">
                                <label class="form-label" style="display: block; margin-bottom: 8px; font-weight: 600;">Bearer Token</label>
                                <div style="display: flex; gap: 10px;">
                                    <input type="password" id="api-token" class="form-input" value="${apiKey}" readonly style="font-family: monospace; background: var(--bg-elevated); flex: 1;">
                                    <button class="btn btn-secondary" onclick="window.copyToClipboard('api-token')">نسخ</button>
                                    <button class="btn btn-ghost" onclick="window.toggleVisibility('api-token')">إظهار</button>
                                </div>
                            </div>
                            <p style="font-size: 12px; color: var(--text-muted);">استخدم هذا المفتاح في Header الطلبات: <code>Authorization: Bearer YOUR_TOKEN</code></p>
                        </div>
                    </div>

                    <!-- Webhooks Section -->
                    <div class="section-card">
                        <div class="section-card-header">
                            <div class="section-card-title">
                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="color: var(--status-info); width: 20px; height: 20px;">
                                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                                إعدادات الويب هوك (Webhooks)
                            </div>
                        </div>
                        <div class="section-card-body">
                            <div style="margin-bottom: 20px;">
                                <label class="form-label" style="display: block; margin-bottom: 8px; font-weight: 600;">رابط الاستقبال (Webhook URL)</label>
                                <input type="url" id="webhook-url" class="form-input" value="${metadata.webhook_url || ''}" placeholder="https://your-domain.com/webhook">
                                <p style="font-size: 11px; color: var(--text-muted); margin-top: 6px;">سيتم إرسال جميع الرسائل الواردة وتحديثات الحالة إلى هذا الرابط فور حدوثها.</p>
                            </div>
                            <div style="display: flex; justify-content: flex-end;">
                                <button class="btn btn-primary" id="save-webhook-btn" onclick="window.saveWebhookSettings()">حفظ الإعدادات</button>
                            </div>
                        </div>
                    </div>

                    <!-- Technical IDs Section -->
                    <div class="section-card">
                        <div class="section-card-header">
                            <div class="section-card-title">
                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="color: var(--status-warning); width: 20px; height: 20px;">
                                    <rect x="2" y="2" width="20" height="20" rx="5" stroke="currentColor" stroke-width="2"/>
                                    <path d="M7 7h10M7 12h10M7 17h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                                </svg>
                                معرفات القنوات (Channel IDs)
                            </div>
                        </div>
                        <div class="section-card-body">
                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
                                <div style="background: var(--bg-elevated); padding: 15px; border-radius: 12px; border: 1px solid var(--border-subtle);">
                                    <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 4px;">Phone Number ID</div>
                                    <div style="font-family: monospace; font-size: 13px; color: var(--text-primary);">${metadata.phone_number_id || 'غير متوفر'}</div>
                                </div>
                                <div style="background: var(--bg-elevated); padding: 15px; border-radius: 12px; border: 1px solid var(--border-subtle);">
                                    <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 4px;">WABA Account ID</div>
                                    <div style="font-family: monospace; font-size: 13px; color: var(--text-primary);">${metadata.waba_account_id || 'غير متوفر'}</div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Logs Placeholder Section -->
                    <div class="section-card">
                        <div class="section-card-header">
                            <div class="section-card-title">
                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="color: var(--text-secondary); width: 20px; height: 20px;">
                                    <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    <polyline points="13 2 13 9 20 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                                سجلات العمليات (API Logs)
                            </div>
                        </div>
                        <div class="section-card-body">
                            <div style="text-align: center; padding: 30px; color: var(--text-muted); border: 1px dashed var(--border-subtle); border-radius: 12px; font-size: 13px;">
                                سيتم عرض سجلات آخر 100 طلب هنا قريباً لمساعدتك في تتبع حالة الإرسال والأخطاء.
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }
}

// Global helper functions
window.copyToClipboard = function(id) {
    const input = document.getElementById(id);
    const originalType = input.type;
    input.type = 'text'; // Temporary show to copy
    input.select();
    document.execCommand('copy');
    input.type = originalType;
    window.showToast('تم النسخ إلى الحافظة', 'success');
};

window.toggleVisibility = function(id) {
    const input = document.getElementById(id);
    const btn = event.currentTarget;
    if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = 'إخفاء';
    } else {
        input.type = 'password';
        btn.textContent = 'إظهار';
    }
};

window.saveWebhookSettings = async function() {
    const url = document.getElementById('webhook-url').value;
    const btn = document.getElementById('save-webhook-btn');
    const originalText = btn.textContent;
    
    if (url && !url.startsWith('https://')) {
        window.showToast('يجب أن يبدأ رابط الويب هوك بـ https:// للأمان', 'error');
        return;
    }

    try {
        btn.disabled = true;
        btn.textContent = 'جاري الحفظ...';
        
        const integration = await SupabaseIntegration.getIntegration();
        if (!integration) throw new Error('لم يتم العثور على تكامل نشط');
        
        const updatedMetadata = {
            ...(integration.metadata || {}),
            webhook_url: url
        };
        
        const supabase = await SupabaseIntegration.initializeSupabase();
        const { error } = await supabase
            .from('integrations')
            .update({ metadata: updatedMetadata })
            .eq('id', integration.id);
            
        if (error) throw error;
        
        window.showToast('تم حفظ رابط الويب هوك بنجاح', 'success');
    } catch (error) {
        console.error('Error saving webhook:', error);
        window.showToast(`خطأ في الحفظ: ${error.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
};
