import { SupabaseIntegration } from '../supabase-integration.js';
import { WhatsAppAPI } from '../services/whatsapp-api.js';

export class StatusPage {
    constructor(container) {
        this.container = container;
    }

    async load() {
        this.container.innerHTML = '<div style="padding: 40px; text-align: center;">جاري تحميل حالة الخدمة...</div>';
        try {
            const stats = await SupabaseIntegration.getDashboardStats();
            const templatesResponse = await WhatsAppAPI.getTemplates();
            const templates = templatesResponse.data || [];
            
            if (!stats) {
                this.container.innerHTML = `
                    <div style="text-align: center; padding: 60px 20px;">
                        <div style="font-size: 48px; margin-bottom: 20px;">🔌</div>
                        <h3 style="margin-bottom: 10px;">لا يوجد رقم مرتبط</h3>
                        <p style="color: var(--text-secondary); margin-bottom: 24px;">يرجى ربط رقم واتساب أولاً لعرض حالة الخدمة.</p>
                        <button class="btn btn-primary" onclick="navigateTo('connect', document.querySelector('[data-page=connect]'))">ربط رقم الآن</button>
                    </div>
                `;
                return;
            }

            this.render(stats, templates);
        } catch (error) {
            this.container.innerHTML = `<div style="padding: 40px; text-align: center; color: var(--status-error);">خطأ في تحميل البيانات: ${error.message}</div>`;
        }
    }

    render(stats, templates) {
        const activeTemplatesCount = templates.filter(t => t.status === 'APPROVED').length;
        
        // Sample Meta prices (Mock data since Meta API for pricing is complex and requires specific permissions)
        const metaPrices = [
            { category: 'رسائل التسويق', price: '0.140' },
            { category: 'رسائل المرافق', price: '0.032' },
            { category: 'رسائل التحقق', price: '0.040' },
            { category: 'رسائل الخدمة', price: '0.034' }
        ];

        this.container.innerHTML = `
            <div class="status-page-layout" style="display: grid; grid-template-columns: 1fr 300px; gap: 24px; padding: 20px;">
                <!-- Main Status Cards -->
                <div class="status-main-section">
                    <div class="status-grid" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 24px;">
                        <div class="stat-card" style="flex-direction: column; align-items: flex-start; padding: 20px;">
                            <div class="stat-label">اسم العرض</div>
                            <div class="stat-value" style="font-size: 18px; margin-top: 8px;">${stats.verifiedName}</div>
                        </div>
                        <div class="stat-card" style="flex-direction: column; align-items: flex-start; padding: 20px;">
                            <div class="stat-label">حالة الرقم</div>
                            <div class="stat-value" style="font-size: 18px; margin-top: 8px;">
                                <span class="tag" style="background: rgba(0, 200, 83, 0.1); color: var(--status-success); border: none; padding: 4px 12px;">${this.translateStatus(stats.status)}</span>
                            </div>
                        </div>
                        <div class="stat-card" style="flex-direction: column; align-items: flex-start; padding: 20px;">
                            <div class="stat-label">جودة الرقم</div>
                            <div class="stat-value" style="font-size: 18px; margin-top: 8px;">
                                <span class="tag" style="background: rgba(0, 200, 83, 0.1); color: var(--status-success); border: none; padding: 4px 12px;">${this.translateQuality(stats.qualityRating)}</span>
                            </div>
                        </div>
                        <div class="stat-card" style="flex-direction: column; align-items: flex-start; padding: 20px;">
                            <div class="stat-label">حد الإرسال</div>
                            <div class="stat-value" style="font-size: 18px; margin-top: 8px;">
                                <span class="tag" style="background: rgba(0, 119, 204, 0.1); color: var(--brand-primary); border: none; padding: 4px 12px;">${stats.limitTier}</span>
                            </div>
                        </div>
                        <div class="stat-card" style="flex-direction: column; align-items: flex-start; padding: 20px;">
                            <div class="stat-label">حالة التحقق</div>
                            <div class="stat-value" style="font-size: 18px; margin-top: 8px;">
                                <span class="tag" style="background: rgba(0, 200, 83, 0.1); color: var(--status-success); border: none; padding: 4px 12px;">${this.translateVerification(stats.verification)}</span>
                            </div>
                        </div>
                        <div class="stat-card" style="flex-direction: column; align-items: flex-start; padding: 20px;">
                            <div class="stat-label">عدد القوالب النشطة</div>
                            <div class="stat-value" style="font-size: 18px; margin-top: 8px;">
                                <span class="tag" style="background: rgba(0, 200, 83, 0.1); color: var(--status-success); border: none; padding: 4px 12px;">${activeTemplatesCount} قوالب</span>
                            </div>
                        </div>
                        <div class="stat-card" style="flex-direction: column; align-items: flex-start; padding: 20px;">
                            <div class="stat-label">رقم WABA</div>
                            <div class="stat-value" style="font-size: 14px; margin-top: 8px; color: var(--text-secondary);">${stats.wabaId}</div>
                        </div>
                        <div class="stat-card" style="flex-direction: column; align-items: flex-start; padding: 20px;">
                            <div class="stat-label">رقم الهاتف</div>
                            <div class="stat-value" style="font-size: 14px; margin-top: 8px; color: var(--text-secondary); direction: ltr;">${stats.phoneNumber}</div>
                        </div>
                    </div>
                </div>

                <!-- Sidebar: Meta Prices -->
                <div class="status-sidebar">
                    <div class="section-card">
                        <div class="section-card-header" style="background: var(--brand-primary); color: white; border-radius: var(--radius-lg) var(--radius-lg) 0 0;">
                            <div class="section-card-title" style="color: white;">أسعار ميتا دولياً</div>
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
                                    ${metaPrices.map(p => `
                                        <tr style="border-bottom: 1px solid var(--border-subtle);">
                                            <td style="padding: 12px 16px; font-size: 13px;">${p.category}</td>
                                            <td style="padding: 12px 16px; font-size: 13px; text-align: left; font-weight: 700;">${p.price}</td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    translateStatus(status) {
        const map = {
            'CONNECTED': 'متصل',
            'DISCONNECTED': 'غير متصل',
            'PENDING': 'قيد الانتظار',
            'APPROVED': 'معتمد',
            'ACTIVE': 'نشط'
        };
        return map[status] || status;
    }

    translateQuality(quality) {
        const map = {
            'GREEN': 'ممتازة',
            'YELLOW': 'متوسطة',
            'RED': 'ضعيفة',
            'NA': 'غير متوفر'
        };
        return map[quality] || quality;
    }

    translateVerification(status) {
        const map = {
            'verified': 'تم التحقق',
            'not_verified': 'غير محقق',
            'pending': 'قيد المراجعة',
            'expired': 'منتهي'
        };
        return map[status] || 'تم التحقق';
    }
}

// Add styles for the status page layout
const style = document.createElement('style');
style.textContent = `
    .status-page-layout {
        animation: fadeIn 0.5s ease;
    }
    @keyframes fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
    }
    @media (max-width: 1024px) {
        .status-page-layout {
            grid-template-columns: 1fr !important;
        }
        .status-sidebar {
            order: -1;
        }
    }
    .status-grid .stat-card {
        background: var(--bg-card);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        transition: transform 0.2s ease, box-shadow 0.2s ease;
    }
    .status-grid .stat-card:hover {
        transform: translateY(-2px);
        box-shadow: var(--shadow-md);
    }
    .status-grid .stat-label {
        color: var(--text-muted);
        font-size: 12px;
        font-weight: 600;
    }
    .status-grid .stat-value {
        color: var(--text-primary);
        font-weight: 700;
    }
`;
document.head.appendChild(style);
