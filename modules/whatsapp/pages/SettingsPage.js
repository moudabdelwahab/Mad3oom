import { WhatsAppAPI } from '../services/whatsapp-api.js';
import { SupabaseIntegration } from '../supabase-integration.js';

export class SettingsPage {
    constructor(container) {
        this.container = container;
    }

    async load() {
        this.container.innerHTML = `
            <div style="padding: 40px; text-align: center;">
                <div class="spinner" style="margin: 0 auto 15px;"></div>
                جاري تحميل الإعدادات...
            </div>
        `;
        
        try {
            const integration = await SupabaseIntegration.getIntegration();
            const profile = integration?.metadata || {};
            this.render(profile);
        } catch (error) {
            this.container.innerHTML = `
                <div style="padding: 40px; text-align: center; color: var(--status-error);">
                    خطأ في تحميل الإعدادات: ${error.message}
                </div>
            `;
        }
    }

    render(profile) {
        this.container.innerHTML = `
            <div style="padding: 24px; max-width: 800px; margin: 0 auto;">
                <div style="margin-bottom: 32px;">
                    <h2 style="font-size: 24px; font-weight: 800; margin-bottom: 8px;">إعدادات الواتساب</h2>
                    <p style="color: var(--text-secondary); font-size: 14px;">إدارة ملف تعريف أعمالك وإعدادات الربط مع ميتا.</p>
                </div>

                <div style="display: flex; flex-direction: column; gap: 24px;">
                    <!-- Business Profile Section -->
                    <div class="section-card">
                        <div class="section-card-header" style="padding: 20px 24px; border-bottom: 1px solid var(--border-subtle);">
                            <div style="font-weight: 700; display: flex; align-items: center; gap: 10px;">
                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 20px; height: 20px; color: var(--brand-primary);">
                                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    <circle cx="12" cy="7" r="4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                                ملف تعريف الأعمال
                            </div>
                        </div>
                        <div class="section-card-body" style="padding: 24px;">
                            <form id="business-profile-form" onsubmit="event.preventDefault(); window.saveBusinessProfile()">
                                <div style="margin-bottom: 20px;">
                                    <label class="form-label" style="display: block; margin-bottom: 8px; font-weight: 600;">اسم العرض (Display Name)</label>
                                    <input type="text" id="set-display-name" class="form-input" value="${profile.phone_number || ''}" placeholder="اسم نشاطك التجاري" readonly style="background: var(--bg-elevated); cursor: not-allowed;">
                                    <p style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">يتم تحديد اسم العرض من خلال إعدادات ميتا مباشرة.</p>
                                </div>

                                <div style="margin-bottom: 20px;">
                                    <label class="form-label" style="display: block; margin-bottom: 8px; font-weight: 600;">وصف النشاط التجاري</label>
                                    <textarea id="set-description" class="form-input" style="height: 100px; resize: none;" placeholder="اكتب وصفاً مختصراً لعملك يظهر للعملاء على واتساب...">${profile.description || ''}</textarea>
                                </div>

                                <div style="margin-bottom: 20px;">
                                    <label class="form-label" style="display: block; margin-bottom: 8px; font-weight: 600;">العنوان</label>
                                    <input type="text" id="set-address" class="form-input" value="${profile.address || ''}" placeholder="عنوان مقر العمل">
                                </div>

                                <div style="display: flex; justify-content: flex-end;">
                                    <button type="submit" class="btn btn-primary" style="padding: 10px 24px;">حفظ التغييرات</button>
                                </div>
                            </form>
                        </div>
                    </div>

                    <!-- Connection Info Section -->
                    <div class="section-card">
                        <div class="section-card-header" style="padding: 20px 24px; border-bottom: 1px solid var(--border-subtle);">
                            <div style="font-weight: 700; display: flex; align-items: center; gap: 10px;">
                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 20px; height: 20px; color: var(--status-success);">
                                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    <polyline points="22 4 12 14.01 9 11.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                                معلومات الربط التقنية
                            </div>
                        </div>
                        <div class="section-card-body" style="padding: 24px; background: var(--bg-surface);">
                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
                                <div style="background: var(--bg-card); padding: 15px; border-radius: 12px; border: 1px solid var(--border-subtle);">
                                    <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 4px;">Phone Number ID</div>
                                    <div style="font-family: monospace; font-size: 13px; color: var(--text-primary);">${profile.phone_number_id || 'غير متوفر'}</div>
                                </div>
                                <div style="background: var(--bg-card); padding: 15px; border-radius: 12px; border: 1px solid var(--border-subtle);">
                                    <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 4px;">WABA Account ID</div>
                                    <div style="font-family: monospace; font-size: 13px; color: var(--text-primary);">${profile.waba_account_id || 'غير متوفر'}</div>
                                </div>
                            </div>
                            <div style="margin-top: 20px; padding: 15px; background: rgba(255, 179, 0, 0.05); border: 1px solid rgba(255, 179, 0, 0.1); border-radius: 12px; display: flex; align-items: center; gap: 12px;">
                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 20px; height: 20px; color: var(--status-warning);">
                                    <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                                    <line x1="12" y1="8" x2="12" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                                    <line x1="12" y1="16" x2="12.01" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                                </svg>
                                <span style="font-size: 12px; color: var(--status-warning);">هذه المعلومات حساسة، لا تشاركها مع أي شخص غير مخول.</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }
}

window.saveBusinessProfile = async function() {
    const submitBtn = document.querySelector('#business-profile-form .btn-primary');
    const originalText = submitBtn.textContent;
    
    try {
        const description = document.getElementById('set-description').value;
        const address = document.getElementById('set-address').value;
        
        submitBtn.disabled = true;
        submitBtn.textContent = 'جاري الحفظ...';
        
        await WhatsAppAPI.updateBusinessProfile({ 
            description, 
            address 
        });
        
        showToast('تم تحديث ملف تعريف الأعمال بنجاح', 'success');
    } catch (error) {
        showToast(`خطأ في الحفظ: ${error.message}`, 'error');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
    }
};
