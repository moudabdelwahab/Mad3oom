import { SupabaseIntegration } from '../supabase-integration.js';
import { WhatsAppAPI } from '../services/whatsapp-api.js';

export class DeveloperSettingsPage {
    constructor(container) {
        this.container = container;
        this.integration = null;
        this._apiTokens = [];
        this._pendingRevealSecret = null; // السر يُحفظ هنا للحظة العرض فقط، يُمحى فور إغلاق النافذة
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
            await this._loadApiTokens();
            this.render();
            this._bindApiTokenEvents();
        } catch (error) {
            this.container.innerHTML = `
                <div style="padding: 40px; text-align: center; color: var(--status-error);">
                    خطأ في تحميل الإعدادات: ${error.message}
                </div>
            `;
        }
    }

    /* ============================================================
       API Tokens (مفاتيح منصة مدعوم) — Data layer
       ============================================================ */

    async _loadApiTokens() {
        try {
            const supabase = await SupabaseIntegration.initializeSupabase();
            const { data, error } = await supabase
                .from('api_tokens')
                .select('id, name, description, api_key, is_active, created_at')
                .order('created_at', { ascending: false });

            if (error) throw error;
            this._apiTokens = data || [];
        } catch (error) {
            console.error('[DeveloperSettingsPage] Error loading api_tokens:', error);
            this._apiTokens = [];
        }
    }

    async _createApiToken({ name, description }) {
        const supabase = await SupabaseIntegration.initializeSupabase();
        const { data, error } = await supabase.functions.invoke('create-api-token', {
            body: { name, description }
        });

        if (error) {
            let message = 'فشل إنشاء المفتاح، حاول مرة أخرى';
            try {
                const ctx = await error.context?.json?.();
                if (ctx?.error) message = ctx.error;
            } catch (_) { /* تجاهل، استخدم الرسالة الافتراضية */ }
            throw new Error(message);
        }

        if (!data || data.error) {
            throw new Error(data?.error || 'فشل إنشاء المفتاح، حاول مرة أخرى');
        }

        return { token: data.token, secret: data.secret };
    }

    async _setApiTokenActive(id, isActive) {
        const supabase = await SupabaseIntegration.initializeSupabase();
        const { error } = await supabase
            .from('api_tokens')
            .update({ is_active: isActive })
            .eq('id', id);
        if (error) throw error;
    }

    async _deleteApiToken(id) {
        const supabase = await SupabaseIntegration.initializeSupabase();
        const { error } = await supabase
            .from('api_tokens')
            .delete()
            .eq('id', id);
        if (error) throw error;
    }

    /* ============================================================
       Render
       ============================================================ */

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
                    <!-- Meta Access Token Section -->
                    <div class="section-card">
                        <div class="section-card-header">
                            <div class="section-card-title">
                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="color: var(--brand-primary); width: 20px; height: 20px;">
                                    <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3-3.5 3.5z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                                Meta Access Token
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
                            <p style="font-size: 12px; color: var(--text-muted);">هذا هو رمز الوصول الخاص بربط رقم واتساب مع ميتا (Meta)، ويُستخدم داخليًا فقط من قِبَل منصة مدعوم لتنفيذ عمليات واتساب نيابةً عنك.</p>
                        </div>
                    </div>

                    <!-- مدعوم API Tokens Section -->
                    <div class="section-card">
                        <div class="section-card-header">
                            <div class="section-card-title">
                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="color: var(--brand-accent); width: 20px; height: 20px;">
                                    <rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" stroke-width="2"/>
                                    <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" stroke-width="2"/>
                                </svg>
                                مفاتيح API الخاصة بمنصة مدعوم
                            </div>
                            <button class="btn btn-primary btn-sm" id="dt-create-token-btn">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px; margin-left: 4px;"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                                إنشاء مفتاح جديد
                            </button>
                        </div>
                        <div class="section-card-body">
                            <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 18px;">أنشئ مفاتيح API (Key + Secret) لاستخدامها من تطبيقاتك الخارجية للوصول إلى منصة مدعوم. الـ Secret يظهر مرة واحدة فقط عند الإنشاء.</p>
                            <div id="dt-tokens-area">${this._renderTokensArea()}</div>
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

            ${this._renderCreateTokenModal()}
            ${this._renderRevealTokenModal()}
            ${this._renderConfirmTokenModal()}
        `;
    }

    _renderTokensArea() {
        if (this._apiTokens.length === 0) {
            return `
                <div style="text-align: center; padding: 36px 20px; border: 1px dashed var(--border-subtle); border-radius: 12px;">
                    <p style="color: var(--text-secondary); font-size: 13px; margin-bottom: 14px;">لا يوجد مفاتيح API حتى الآن.</p>
                    <button class="btn btn-secondary btn-sm" id="dt-create-token-empty-btn">إنشاء أول مفتاح</button>
                </div>
            `;
        }

        const escapeHtml = (str) => {
            const div = document.createElement('div');
            div.textContent = str ?? '';
            return div.innerHTML;
        };

        const formatDate = (iso) => {
            try {
                return new Date(iso).toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' });
            } catch (_) {
                return '';
            }
        };

        return `
            <div style="display: flex; flex-direction: column; gap: 10px;">
                ${this._apiTokens.map(t => `
                    <div class="dt-token-row" data-id="${t.id}" style="display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; background: var(--bg-elevated); border: 1px solid var(--border-subtle); border-radius: 12px; padding: 14px 16px;">
                        <div style="min-width: 0; flex: 1;">
                            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 4px;">
                                <span style="font-weight: 700; color: var(--text-primary); font-size: 14px;">${escapeHtml(t.name)}</span>
                                <span style="font-size: 11px; font-weight: 700; padding: 2px 9px; border-radius: 99px; ${t.is_active ? 'background: rgba(0,200,83,0.12); color: var(--status-success);' : 'background: var(--bg-surface); color: var(--text-muted);'}">${t.is_active ? 'نشط' : 'معطّل'}</span>
                            </div>
                            ${t.description ? `<div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 6px;">${escapeHtml(t.description)}</div>` : ''}
                            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                                <code style="font-family: monospace; font-size: 12px; background: var(--bg-surface); border: 1px solid var(--border-subtle); padding: 3px 8px; border-radius: 6px; direction: ltr;">${escapeHtml(t.api_key)}</code>
                                <button type="button" class="btn btn-ghost btn-sm dt-copy-key-btn" data-key="${escapeHtml(t.api_key)}" style="padding: 2px 8px; font-size: 11px;">نسخ</button>
                                <span style="font-size: 11px; color: var(--text-muted);">أُنشئ في ${formatDate(t.created_at)}</span>
                            </div>
                        </div>
                        <div style="display: flex; gap: 6px; flex-shrink: 0;">
                            <button type="button" class="btn btn-ghost btn-sm dt-toggle-token-btn" data-id="${t.id}" data-active="${t.is_active}">${t.is_active ? 'تعطيل' : 'تفعيل'}</button>
                            <button type="button" class="btn btn-ghost btn-sm dt-delete-token-btn" data-id="${t.id}" style="color: var(--status-error);">حذف نهائي</button>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
    }

    _renderCreateTokenModal() {
        return `
            <div id="dt-create-modal" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px); align-items: center; justify-content: center; z-index: 10000; padding: 20px;">
                <div style="background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 20px; width: 100%; max-width: 440px; box-shadow: 0 20px 50px rgba(0,0,0,0.3); overflow: hidden;">
                    <div style="padding: 20px 24px; border-bottom: 1px solid var(--border-subtle); display: flex; justify-content: space-between; align-items: center;">
                        <h3 style="margin: 0; font-size: 17px; font-weight: 700; color: var(--text-primary);">إنشاء مفتاح API جديد</h3>
                        <button type="button" class="btn btn-ghost" id="dt-close-create-modal" style="font-size: 22px; padding: 0; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center;">&times;</button>
                    </div>
                    <div style="padding: 24px;">
                        <div style="margin-bottom: 16px;">
                            <label class="form-label" style="display: block; margin-bottom: 6px; font-weight: 600;">اسم المفتاح</label>
                            <input type="text" id="dt-token-name" class="form-input" placeholder="مثال: تطبيق الموبايل" maxlength="80">
                            <p id="dt-token-name-error" style="display: none; color: var(--status-error); font-size: 12px; margin-top: 6px;">يرجى إدخال اسم للمفتاح</p>
                        </div>
                        <div>
                            <label class="form-label" style="display: block; margin-bottom: 6px; font-weight: 600;">وصف / ملاحظة (اختياري)</label>
                            <textarea id="dt-token-desc" class="form-input" style="height: 70px; resize: vertical;" maxlength="200" placeholder="مثال: يُستخدم لإرسال رسائل واتساب من نظام الطلبات"></textarea>
                        </div>
                    </div>
                    <div style="padding: 16px 24px; border-top: 1px solid var(--border-subtle); display: flex; justify-content: flex-end; gap: 10px;">
                        <button type="button" class="btn btn-secondary" id="dt-cancel-create-btn">إلغاء</button>
                        <button type="button" class="btn btn-primary" id="dt-submit-create-btn">إنشاء المفتاح</button>
                    </div>
                </div>
            </div>
        `;
    }

    _renderRevealTokenModal() {
        return `
            <div id="dt-reveal-modal" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px); align-items: center; justify-content: center; z-index: 10000; padding: 20px;">
                <div style="background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 20px; width: 100%; max-width: 460px; box-shadow: 0 20px 50px rgba(0,0,0,0.3); overflow: hidden;">
                    <div style="padding: 20px 24px; border-bottom: 1px solid var(--border-subtle); display: flex; justify-content: space-between; align-items: center;">
                        <h3 style="margin: 0; font-size: 17px; font-weight: 700; color: var(--text-primary);">مفتاح API الجديد</h3>
                        <button type="button" class="btn btn-ghost" id="dt-close-reveal-modal" style="font-size: 22px; padding: 0; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center;">&times;</button>
                    </div>
                    <div style="padding: 24px;">
                        <div style="display: flex; gap: 8px; background: rgba(255,179,0,0.08); border: 1px solid rgba(255,179,0,0.25); color: var(--status-warning); padding: 12px 14px; border-radius: 10px; font-size: 12px; margin-bottom: 18px;">
                            <span style="flex-shrink: 0; display: flex;"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="12" y1="17" x2="12.01" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>
                            <span>احتفظ بالـ API Secret الآن في مكان آمن. لن يكون بإمكانك رؤيته مرة أخرى بعد إغلاق هذه النافذة.</span>
                        </div>

                        <div style="margin-bottom: 14px;">
                            <label class="form-label" style="display: block; margin-bottom: 6px; font-weight: 600; font-size: 12px; color: var(--text-secondary);">API Key</label>
                            <div style="display: flex; align-items: center; gap: 6px; background: var(--bg-elevated); border: 1px solid var(--border-subtle); border-radius: 10px; padding: 8px 10px;">
                                <code id="dt-reveal-key" style="flex: 1; font-family: monospace; font-size: 13px; color: var(--text-primary); direction: ltr; overflow-x: auto; white-space: nowrap;"></code>
                                <button type="button" class="btn btn-ghost btn-sm" id="dt-copy-reveal-key">نسخ</button>
                            </div>
                        </div>

                        <div>
                            <label class="form-label" style="display: block; margin-bottom: 6px; font-weight: 600; font-size: 12px; color: var(--text-secondary);">API Secret</label>
                            <div style="display: flex; align-items: center; gap: 6px; background: var(--bg-elevated); border: 1px solid var(--border-subtle); border-radius: 10px; padding: 8px 10px;">
                                <code id="dt-reveal-secret" style="flex: 1; font-family: monospace; font-size: 13px; color: var(--text-primary); direction: ltr; overflow-x: auto; white-space: nowrap;">••••••••••••••••••••••••••••••••</code>
                                <button type="button" class="btn btn-ghost btn-sm" id="dt-toggle-reveal-secret">إظهار</button>
                                <button type="button" class="btn btn-ghost btn-sm" id="dt-copy-reveal-secret">نسخ</button>
                            </div>
                        </div>
                    </div>
                    <div style="padding: 16px 24px; border-top: 1px solid var(--border-subtle); display: flex; justify-content: flex-end;">
                        <button type="button" class="btn btn-primary" id="dt-done-reveal-btn">تم، لقد حفظت المفتاح</button>
                    </div>
                </div>
            </div>
        `;
    }

    _renderConfirmTokenModal() {
        return `
            <div id="dt-confirm-modal" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px); align-items: center; justify-content: center; z-index: 10000; padding: 20px;">
                <div style="background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 20px; width: 100%; max-width: 400px; padding: 28px; text-align: center; box-shadow: 0 20px 50px rgba(0,0,0,0.3);">
                    <div id="dt-confirm-title" style="font-size: 17px; font-weight: 700; color: var(--text-primary); margin-bottom: 10px;"></div>
                    <div id="dt-confirm-text" style="font-size: 13px; color: var(--text-secondary); line-height: 1.6; margin-bottom: 22px;"></div>
                    <div style="display: flex; gap: 10px;">
                        <button type="button" class="btn btn-secondary" style="flex: 1;" id="dt-confirm-cancel-btn">إلغاء</button>
                        <button type="button" class="btn btn-primary" style="flex: 1;" id="dt-confirm-action-btn">تأكيد</button>
                    </div>
                </div>
            </div>
        `;
    }

    /* ============================================================
       Events
       ============================================================ */

    _bindApiTokenEvents() {
        const root = this.container;
        let pendingConfirmAction = null;

        const createModal = root.querySelector('#dt-create-modal');
        const revealModal = root.querySelector('#dt-reveal-modal');
        const confirmModal = root.querySelector('#dt-confirm-modal');

        const openCreateModal = () => {
            root.querySelector('#dt-token-name').value = '';
            root.querySelector('#dt-token-desc').value = '';
            root.querySelector('#dt-token-name-error').style.display = 'none';
            const submitBtn = root.querySelector('#dt-submit-create-btn');
            submitBtn.disabled = false;
            submitBtn.textContent = 'إنشاء المفتاح';
            createModal.style.display = 'flex';
        };

        const topCreateBtn = root.querySelector('#dt-create-token-btn');
        if (topCreateBtn) topCreateBtn.addEventListener('click', openCreateModal);

        const emptyCreateBtn = root.querySelector('#dt-create-token-empty-btn');
        if (emptyCreateBtn) emptyCreateBtn.addEventListener('click', openCreateModal);

        root.querySelector('#dt-close-create-modal').addEventListener('click', () => {
            createModal.style.display = 'none';
        });
        root.querySelector('#dt-cancel-create-btn').addEventListener('click', () => {
            createModal.style.display = 'none';
        });

        root.querySelector('#dt-submit-create-btn').addEventListener('click', async () => {
            const nameInput = root.querySelector('#dt-token-name');
            const descInput = root.querySelector('#dt-token-desc');
            const nameError = root.querySelector('#dt-token-name-error');
            const submitBtn = root.querySelector('#dt-submit-create-btn');

            const name = nameInput.value.trim();
            if (!name) {
                nameError.style.display = 'block';
                nameInput.focus();
                return;
            }
            nameError.style.display = 'none';

            submitBtn.disabled = true;
            submitBtn.textContent = 'جاري الإنشاء...';

            try {
                const { token, secret } = await this._createApiToken({
                    name,
                    description: descInput.value
                });

                createModal.style.display = 'none';
                await this._loadApiTokens();
                this._refreshTokensArea();
                this._openRevealModal(token, secret);
            } catch (error) {
                window.showToast(error.message || 'فشل إنشاء المفتاح، حاول مرة أخرى', 'error');
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = 'إنشاء المفتاح';
            }
        });

        // Reveal modal
        const closeRevealModal = () => {
            this._pendingRevealSecret = null;
            root.querySelector('#dt-reveal-secret').textContent = '•'.repeat(34);
            root.querySelector('#dt-toggle-reveal-secret').textContent = 'إظهار';
            revealModal.style.display = 'none';
        };

        root.querySelector('#dt-close-reveal-modal').addEventListener('click', closeRevealModal);
        root.querySelector('#dt-done-reveal-btn').addEventListener('click', closeRevealModal);

        root.querySelector('#dt-toggle-reveal-secret').addEventListener('click', (e) => {
            if (!this._pendingRevealSecret) return;
            const secretEl = root.querySelector('#dt-reveal-secret');
            const isHidden = e.currentTarget.textContent.trim() === 'إظهار';
            secretEl.textContent = isHidden ? this._pendingRevealSecret : '•'.repeat(34);
            e.currentTarget.textContent = isHidden ? 'إخفاء' : 'إظهار';
        });

        root.querySelector('#dt-copy-reveal-key').addEventListener('click', () => {
            const key = root.querySelector('#dt-reveal-key').textContent;
            this._copyToClipboardText(key);
        });

        root.querySelector('#dt-copy-reveal-secret').addEventListener('click', () => {
            if (!this._pendingRevealSecret) return;
            this._copyToClipboardText(this._pendingRevealSecret);
        });

        // Confirm modal
        const closeConfirmModal = () => {
            pendingConfirmAction = null;
            confirmModal.style.display = 'none';
        };
        root.querySelector('#dt-confirm-cancel-btn').addEventListener('click', closeConfirmModal);

        root.querySelector('#dt-confirm-action-btn').addEventListener('click', async () => {
            const action = pendingConfirmAction;
            closeConfirmModal();
            if (action) {
                try {
                    await action();
                } catch (error) {
                    window.showToast(error.message || 'حدث خطأ أثناء تنفيذ الإجراء', 'error');
                }
            }
        });

        this._askConfirm = ({ title, text, danger, onConfirm }) => {
            root.querySelector('#dt-confirm-title').textContent = title;
            root.querySelector('#dt-confirm-text').textContent = text;
            const actionBtn = root.querySelector('#dt-confirm-action-btn');
            actionBtn.textContent = danger ? 'حذف نهائي' : 'تأكيد';
            actionBtn.style.background = danger ? 'var(--status-error)' : '';
            pendingConfirmAction = onConfirm;
            confirmModal.style.display = 'flex';
        };

        // Tokens area actions (delegated, re-bound after every refresh)
        this._bindTokensAreaEvents();

        // Close on overlay click
        [createModal, revealModal, confirmModal].forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target !== modal) return;
                if (modal === revealModal) closeRevealModal();
                else if (modal === createModal) createModal.style.display = 'none';
                else closeConfirmModal();
            });
        });
    }

    _bindTokensAreaEvents() {
        const area = this.container.querySelector('#dt-tokens-area');
        if (!area) return;

        area.addEventListener('click', async (e) => {
            const copyBtn = e.target.closest('.dt-copy-key-btn');
            if (copyBtn) {
                this._copyToClipboardText(copyBtn.dataset.key);
                return;
            }

            const toggleBtn = e.target.closest('.dt-toggle-token-btn');
            if (toggleBtn) {
                const id = toggleBtn.dataset.id;
                const isActive = toggleBtn.dataset.active === 'true';
                this._askConfirm({
                    title: isActive ? 'تعطيل المفتاح' : 'تفعيل المفتاح',
                    text: isActive
                        ? 'سيتم تعطيل هذا المفتاح فورًا، ولن يستطيع استخدامه للوصول إلى المنصة حتى تُفعّله مرة أخرى.'
                        : 'سيتم تفعيل هذا المفتاح وسيصبح صالحًا للاستخدام مرة أخرى.',
                    onConfirm: async () => {
                        await this._setApiTokenActive(id, !isActive);
                        await this._loadApiTokens();
                        this._refreshTokensArea();
                        window.showToast(isActive ? 'تم تعطيل المفتاح' : 'تم تفعيل المفتاح', 'success');
                    }
                });
                return;
            }

            const deleteBtn = e.target.closest('.dt-delete-token-btn');
            if (deleteBtn) {
                const id = deleteBtn.dataset.id;
                this._askConfirm({
                    title: 'حذف المفتاح نهائيًا',
                    text: 'لا يمكن التراجع عن هذا الإجراء. أي تطبيق يستخدم هذا المفتاح سيفقد الوصول إلى المنصة فورًا.',
                    danger: true,
                    onConfirm: async () => {
                        await this._deleteApiToken(id);
                        await this._loadApiTokens();
                        this._refreshTokensArea();
                        window.showToast('تم حذف المفتاح نهائيًا', 'success');
                    }
                });
                return;
            }

            const emptyCreateBtn = e.target.closest('#dt-create-token-empty-btn');
            if (emptyCreateBtn) {
                this.container.querySelector('#dt-create-token-btn')?.click();
            }
        });
    }

    _refreshTokensArea() {
        const area = this.container.querySelector('#dt-tokens-area');
        if (!area) return;
        // event delegation في _bindTokensAreaEvents معلّق على #dt-tokens-area نفسه
        // (عنصر ثابت لا يُعاد إنشاؤه)، فهو يغطي تلقائيًا أي عناصر جديدة هنا
        // (بما فيها زرار "إنشاء أول مفتاح" في حالة Empty State) دون أي ربط إضافي.
        area.innerHTML = this._renderTokensArea();
    }

    _openRevealModal(token, secret) {
        this._pendingRevealSecret = secret;
        this.container.querySelector('#dt-reveal-key').textContent = token.api_key;
        this.container.querySelector('#dt-reveal-secret').textContent = '•'.repeat(34);
        this.container.querySelector('#dt-toggle-reveal-secret').textContent = 'إظهار';
        this.container.querySelector('#dt-reveal-modal').style.display = 'flex';
    }

    _copyToClipboardText(text) {
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).then(
                () => window.showToast('تم النسخ إلى الحافظة', 'success'),
                () => this._fallbackCopy(text)
            );
        } else {
            this._fallbackCopy(text);
        }
    }

    _fallbackCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            window.showToast('تم النسخ إلى الحافظة', 'success');
        } catch (_) {
            window.showToast('تعذّر النسخ، حاول تحديد النص يدويًا', 'error');
        }
        document.body.removeChild(ta);
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
