import { SupabaseIntegration } from '../supabase-integration.js';

export class AutoReplyPage {

    constructor(container) {
        this.container = container;
    }

    async load() {

        this.container.innerHTML = `
            <div style="padding: 40px; text-align: center;">
                جاري تحميل القواعد...
            </div>
        `;

        try {

            const supabase =
                await SupabaseIntegration.initializeSupabase();

            // التحقق من الجلسة
            const {
                data: { session }
            } = await supabase.auth.getSession();

            if (!session || !session.user) {

                this.container.innerHTML = `
                    <div style="
                        padding:40px;
                        text-align:center;
                        color:var(--status-error);
                    ">
                        يجب تسجيل الدخول أولاً
                    </div>
                `;

                return;
            }

            const userId = session.user.id;

            const { data, error } = await supabase
                .from('bot_settings')
                .select('*')
                .eq('user_id', userId);

            if (error) throw error;

            this.render(data || []);

        } catch (error) {

            console.error(error);

            this.container.innerHTML = `
                <div style="
                    padding:40px;
                    text-align:center;
                    color:var(--status-error);
                ">
                    خطأ في تحميل البيانات:
                    ${error.message}
                </div>
            `;
        }
    }
    async load() {
        this.container.innerHTML = '<div style="padding: 40px; text-align: center;">جاري تحميل القواعد...</div>';
        try {
            const supabase = await SupabaseIntegration.initializeSupabase();
            const userId = await SupabaseIntegration.getCurrentUserId();
            const { data, error } = await supabase
                .from('bot_settings')
                .select('*')
                .eq('user_id', userId);
            
            if (error) throw error;
            this.render(data || []);
        } catch (error) {
            this.container.innerHTML = `<div style="padding: 40px; text-align: center; color: var(--status-error);">خطأ في تحميل البيانات: ${error.message}</div>`;
        }
    }

    render(rules) {
        let html = '';
        
        // Modal for adding new rule (hidden by default)
        html += `
            <div id="autoreply-modal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:1000; align-items:center; justify-content:center; padding:20px; backdrop-filter:blur(5px);">
                <div class="section-card" style="width:100%; max-width:500px; background:var(--bg-card);">
                    <div class="section-card-header">
                        <div class="section-card-title">إضافة قاعدة رد آلي</div>
                        <button onclick="document.getElementById('autoreply-modal').style.display='none'" class="btn btn-ghost btn-sm">إغلاق</button>
                    </div>
                    <div class="section-card-body">
                        <div class="form-group">
                            <label class="form-label">الكلمات المفتاحية (مثال: ترحيب, سعر, حجز)</label>
                            <input type="text" id="ar-keywords" class="form-input" placeholder="ادخل الكلمات مفصولة بفاصلة">
                        </div>
                        <div class="form-group">
                            <label class="form-label">نص الرد التلقائي</label>
                            <textarea id="ar-message" class="form-textarea" placeholder="اكتب الرد الذي سيتم إرساله للعميل"></textarea>
                        </div>
                        <button onclick="window.saveNewAutoReply()" class="btn btn-primary btn-full">حفظ القاعدة</button>
                    </div>
                </div>
            </div>
        `;

        if (rules.length === 0) {
            html += `
                <div style="text-align: center; padding: 60px 20px;">
                    <div style="font-size: 48px; margin-bottom: 20px;">🤖</div>
                    <h3 style="margin-bottom: 10px;">لا توجد قواعد رد آلي</h3>
                    <p style="color: var(--text-secondary); margin-bottom: 24px;">قم ببرمجة أول رد تلقائي لمساعدة عملائك بشكل أسرع.</p>
                    <button class="btn btn-primary" onclick="window.openNewAutoReplyModal()">إضافة قاعدة جديدة</button>
                </div>
            `;
            this.container.innerHTML = html;
            return;
        }

        html += `
            <div style="padding: 20px;">
                <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                    <thead>
                        <tr style="text-align: right; border-bottom: 2px solid var(--border-subtle);">
                            <th style="padding: 12px;">الكلمة المفتاحية</th>
                            <th style="padding: 12px;">الرد</th>
                            <th style="padding: 12px;">الحالة</th>
                            <th style="padding: 12px;">الإجراءات</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        rules.forEach(rule => {
            html += `
                <tr style="border-bottom: 1px solid var(--border-subtle);">
                    <td style="padding: 12px;">${rule.keywords || 'ترحيب'}</td>
                    <td style="padding: 12px; color: var(--text-secondary);">${rule.welcome_message || '—'}</td>
                    <td style="padding: 12px;">
                        <span class="tag" style="background: ${rule.is_enabled ? 'var(--status-success-bg)' : 'var(--bg-elevated)'}; color: ${rule.is_enabled ? 'var(--status-success)' : 'var(--text-muted)'};">
                            ${rule.is_enabled ? 'نشط' : 'معطل'}
                        </span>
                    </td>
                    <td style="padding: 12px;">
                        <button class="btn btn-ghost btn-sm" onclick="window.deleteAutoReply('${rule.id}')" style="color: var(--status-error);">حذف</button>
                    </td>
                </tr>
            `;
        });

        html += `</tbody></table></div>`;
        this.container.innerHTML = html;
    }
}
