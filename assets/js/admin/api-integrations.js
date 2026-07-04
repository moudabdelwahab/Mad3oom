// ============================================================
// api-integrations.js
// ------------------------------------------------------------
// منطق قسم "Mad3oom API Tokens" و"External Integrations" داخل
// صفحة الإعدادات. يُستورد ويُستدعى من settings.js (شوف التعليمات
// في نهاية الملف تحت "// --- الدمج مع settings.js ---").
// ============================================================
import { supabase } from '/api-config.js';

const FUNCTIONS_BASE = 'https://srnelrdpqkcntbgudyto.supabase.co/functions/v1';

const PROVIDER_LABELS = {
    openai: 'OpenAI',
    claude: 'Claude (Anthropic)',
    gemini: 'Gemini (Google)',
    openrouter: 'OpenRouter',
    groq: 'Groq',
    telegram_bot: 'Telegram Bot',
    webhook: 'Webhook',
    custom: 'مزوّد آخر',
};

const SCOPE_LABELS = { tickets: 'التذاكر', whatsapp: 'واتساب', chatbot: 'شات بوت' };

let apiTokensCache = [];
let integrationsCache = [];

async function callEdgeFunction(name, payload) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('يجب تسجيل الدخول أولاً');

    const res = await fetch(`${FUNCTIONS_BASE}/${name}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(payload || {}),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `فشل الطلب (كود ${res.status})`);
    return data;
}

// ============================================================
// Mad3oom API Tokens
// ============================================================

export async function loadApiTokens(showAlert) {
    const tbody = document.getElementById('apiTokensBody');
    if (!tbody) return;
    try {
        const { data, error } = await supabase
            .from('api_tokens')
            .select('*')
            .order('created_at', { ascending: false });
        if (error) throw error;

        apiTokensCache = data || [];

        if (!apiTokensCache.length) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:2rem;">لا توجد مفاتيح API بعد</td></tr>';
            return;
        }

        tbody.innerHTML = apiTokensCache.map(t => {
            const scopes = (t.scopes || []).map(s => `<span class="badge badge-info" style="margin-inline-end:2px;">${s}</span>`).join(' ');
            const statusBadge = t.is_active
                ? '<span class="badge badge-success">نشط</span>'
                : '<span class="badge badge-danger">معطّل</span>';
            const lastUsed = t.last_used_at ? new Date(t.last_used_at).toLocaleString('ar-EG') : 'لم يُستخدم بعد';
            const created = new Date(t.created_at).toLocaleDateString('ar-EG');

            return `
            <tr>
                <td><strong>${escapeHtml(t.name)}</strong>${t.description ? `<div style="font-size:0.8rem;color:var(--color-text-secondary)">${escapeHtml(t.description)}</div>` : ''}</td>
                <td>
                    <div style="display:flex;align-items:center;gap:0.4rem;">
                        <code style="font-size:0.8rem;">${t.api_key}</code>
                        <button class="btn btn-secondary btn-sm copy-inline-btn" data-copy-value="${t.api_key}">نسخ</button>
                    </div>
                </td>
                <td><code>••••${t.secret_last_four || '----'}</code></td>
                <td>${scopes || '-'}</td>
                <td>${lastUsed}</td>
                <td>${created}</td>
                <td>${statusBadge}</td>
                <td>
                    <div style="display:flex;flex-wrap:wrap;gap:0.3rem;">
                        <button class="btn btn-secondary btn-sm regen-token-btn" data-token-id="${t.id}">تجديد السر</button>
                        <button class="btn ${t.is_active ? 'btn-secondary' : 'btn-primary'} btn-sm toggle-token-btn" data-token-id="${t.id}" data-active="${t.is_active}">${t.is_active ? 'تعطيل' : 'تفعيل'}</button>
                        <button class="btn btn-danger btn-sm delete-token-btn" data-token-id="${t.id}">حذف</button>
                    </div>
                </td>
            </tr>`;
        }).join('');

        tbody.querySelectorAll('.regen-token-btn').forEach(b => b.addEventListener('click', () => regenerateApiTokenSecret(b.dataset.tokenId, showAlert)));
        tbody.querySelectorAll('.toggle-token-btn').forEach(b => b.addEventListener('click', () => toggleApiToken(b.dataset.tokenId, b.dataset.active === 'true', showAlert)));
        tbody.querySelectorAll('.delete-token-btn').forEach(b => b.addEventListener('click', () => deleteApiToken(b.dataset.tokenId, showAlert)));
        tbody.querySelectorAll('.copy-inline-btn').forEach(b => b.addEventListener('click', () => copyToClipboard(b.dataset.copyValue, showAlert)));
    } catch (err) {
        console.error('loadApiTokens error:', err);
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:2rem; color:var(--color-danger)">فشل تحميل المفاتيح</td></tr>';
    }
}

export async function loadApiUsageLogs() {
    const tbody = document.getElementById('apiUsageLogBody');
    if (!tbody) return;
    try {
        const { data, error } = await supabase
            .from('api_token_usage_logs')
            .select('*, api_tokens(name)')
            .order('created_at', { ascending: false })
            .limit(50);
        if (error) throw error;

        if (!data || !data.length) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:1.5rem;">لا يوجد استخدام مسجّل بعد</td></tr>';
            return;
        }

        tbody.innerHTML = data.map(l => `
            <tr>
                <td>${escapeHtml(l.api_tokens?.name || '—')}</td>
                <td><code>${escapeHtml(l.endpoint || '-')}</code></td>
                <td>${escapeHtml(l.method || '-')}</td>
                <td><span class="badge ${l.status_code && l.status_code < 400 ? 'badge-success' : 'badge-danger'}">${l.status_code ?? '-'}</span></td>
                <td>${escapeHtml(l.ip_address || '-')}</td>
                <td>${new Date(l.created_at).toLocaleString('ar-EG')}</td>
            </tr>`).join('');
    } catch (err) {
        console.error('loadApiUsageLogs error:', err);
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:1.5rem; color:var(--color-danger)">فشل تحميل سجل الاستخدام</td></tr>';
    }
}

export async function createApiToken(showAlert) {
    const name = document.getElementById('apiTokenName').value.trim();
    const description = document.getElementById('apiTokenDescription').value.trim();
    if (!name) { showAlert('الاسم مطلوب', 'error'); return; }

    const btn = document.getElementById('confirmCreateApiTokenBtn');
    setBtnLoading(btn, true);
    try {
        const result = await callEdgeFunction('create-api-token', { name, description });
        document.getElementById('apiTokenFormModal').style.display = 'none';
        document.getElementById('apiTokenName').value = '';
        document.getElementById('apiTokenDescription').value = '';
        revealSecret(result.token.api_key, result.secret);
        showAlert('تم توليد المفتاح بنجاح', 'success');
        await loadApiTokens(showAlert);
    } catch (err) {
        showAlert('خطأ: ' + err.message, 'error');
    } finally {
        setBtnLoading(btn, false);
    }
}

export async function regenerateApiTokenSecret(tokenId, showAlert) {
    if (!confirm('تجديد السر سيُلغي صلاحية السر القديم فورًا. متابعة؟')) return;
    try {
        const result = await callEdgeFunction('regenerate-api-token-secret', { token_id: tokenId });
        revealSecret(result.token.api_key, result.secret);
        showAlert('تم تجديد السر بنجاح', 'success');
        await loadApiTokens(showAlert);
    } catch (err) {
        showAlert('خطأ: ' + err.message, 'error');
    }
}

export async function toggleApiToken(tokenId, currentlyActive, showAlert) {
    try {
        const { error } = await supabase
            .from('api_tokens')
            .update({ is_active: !currentlyActive, revoked_at: currentlyActive ? new Date().toISOString() : null })
            .eq('id', tokenId);
        if (error) throw error;
        showAlert(currentlyActive ? 'تم تعطيل المفتاح' : 'تم تفعيل المفتاح', 'success');
        await loadApiTokens(showAlert);
    } catch (err) {
        showAlert('خطأ: ' + err.message, 'error');
    }
}

export async function deleteApiToken(tokenId, showAlert) {
    if (!confirm('حذف هذا المفتاح نهائيًا؟ لا يمكن التراجع عن هذا الإجراء.')) return;
    try {
        const { error } = await supabase.from('api_tokens').delete().eq('id', tokenId);
        if (error) throw error;
        showAlert('تم حذف المفتاح', 'success');
        await loadApiTokens(showAlert);
    } catch (err) {
        showAlert('خطأ: ' + err.message, 'error');
    }
}

function revealSecret(apiKey, secret) {
    document.getElementById('revealedApiKey').value = apiKey;
    document.getElementById('revealedApiSecret').value = secret;
    document.getElementById('apiSecretRevealModal').style.display = 'block';
}

// ============================================================
// External Integrations
// ============================================================

const CREDENTIAL_FIELDS = {
    openai: [{ key: 'api_key', label: 'API Key', type: 'password', placeholder: 'sk-...' }],
    claude: [{ key: 'api_key', label: 'API Key', type: 'password', placeholder: 'sk-ant-...' }],
    gemini: [{ key: 'api_key', label: 'API Key', type: 'password', placeholder: 'AIza...' }],
    openrouter: [{ key: 'api_key', label: 'API Key', type: 'password', placeholder: 'sk-or-...' }],
    groq: [{ key: 'api_key', label: 'API Key', type: 'password', placeholder: 'gsk_...' }],
    telegram_bot: [{ key: 'bot_token', label: 'Bot Token', type: 'password', placeholder: '123456:ABC-DEF...' }],
    webhook: [{ key: 'url', label: 'Webhook URL', type: 'url', placeholder: 'https://example.com/webhook' }],
    custom: [
        { key: 'api_key', label: 'API Key (اختياري)', type: 'password', placeholder: '' },
        { key: 'url', label: 'Base URL (اختياري)', type: 'url', placeholder: '' },
    ],
};

const AI_PROVIDERS = ['openai', 'claude', 'gemini', 'openrouter', 'groq'];

export function renderCredentialFields(provider) {
    const container = document.getElementById('integrationCredentialFields');
    const fields = CREDENTIAL_FIELDS[provider] || [];
    container.innerHTML = fields.map(f => `
        <div class="form-group">
            <label for="cred-${f.key}">${f.label}</label>
            <input type="${f.type}" id="cred-${f.key}" class="form-control" placeholder="${f.placeholder}">
        </div>
    `).join('') + (fields.length ? `<p style="font-size:0.8rem;color:var(--color-text-secondary);">اترك الحقل فارغًا عند التعديل للإبقاء على القيمة الحالية.</p>` : '');

    if (provider === 'openai' || provider === 'groq' || provider === 'openrouter' || provider === 'claude' || provider === 'gemini') {
        container.insertAdjacentHTML('beforeend', `
            <div class="form-group">
                <label for="cred-meta-model">الموديل (اختياري)</label>
                <input type="text" id="cred-meta-model" class="form-control" placeholder="مثال: gpt-4o-mini">
            </div>
        `);
    }
}

export async function loadExternalIntegrations(showAlert) {
    const grid = document.getElementById('integrationsGrid');
    if (!grid) return;
    try {
        const { data, error } = await supabase
            .from('external_integrations')
            .select('*')
            .eq('owner_scope', 'platform')
            .order('created_at', { ascending: false });
        if (error) throw error;

        integrationsCache = data || [];
        renderIntegrationsGrid(showAlert);
        populateDefaultAiProviderSelect();
        await loadDefaultAiProviderSetting();
    } catch (err) {
        console.error('loadExternalIntegrations error:', err);
        grid.innerHTML = '<p style="text-align:center; padding:1rem; color:var(--color-danger)">فشل تحميل التكاملات</p>';
    }
}

function renderIntegrationsGrid(showAlert) {
    const grid = document.getElementById('integrationsGrid');
    if (!integrationsCache.length) {
        grid.innerHTML = '<p style="text-align:center; padding:1rem; color:var(--color-text-secondary);">لا توجد تكاملات مضافة بعد</p>';
        return;
    }

    grid.innerHTML = integrationsCache.map(i => {
        const testBadge = i.last_test_status === 'success'
            ? '<span class="badge badge-success">آخر اختبار: نجح</span>'
            : i.last_test_status === 'failed'
                ? '<span class="badge badge-danger">آخر اختبار: فشل</span>'
                : '<span class="badge badge-warning">لم يُختبر بعد</span>';

        return `
        <div class="settings-card" style="margin:0;">
            <div class="card-body" style="padding:1rem;">
                <div style="display:flex;justify-content:space-between;align-items:start;">
                    <div>
                        <h4 style="margin:0 0 0.25rem;">${escapeHtml(i.display_name)}</h4>
                        <p style="margin:0;font-size:0.85rem;color:var(--color-text-secondary);">${PROVIDER_LABELS[i.provider] || i.provider}</p>
                    </div>
                    <span class="badge ${i.is_active ? 'badge-success' : 'badge-warning'}">${i.is_active ? 'نشط' : 'معطّل'}</span>
                </div>
                <div style="margin:0.75rem 0;">${testBadge}</div>
                ${i.last_test_message ? `<p style="font-size:0.8rem;color:var(--color-text-secondary);margin:0 0 0.75rem;">${escapeHtml(i.last_test_message)}</p>` : ''}
                <div style="display:flex;flex-wrap:wrap;gap:0.4rem;">
                    <button class="btn btn-secondary btn-sm test-integ-btn" data-id="${i.id}">اختبار الاتصال</button>
                    <button class="btn btn-secondary btn-sm edit-integ-btn" data-id="${i.id}">تعديل</button>
                    <button class="btn ${i.is_active ? 'btn-secondary' : 'btn-primary'} btn-sm toggle-integ-btn" data-id="${i.id}" data-active="${i.is_active}">${i.is_active ? 'تعطيل' : 'تفعيل'}</button>
                    <button class="btn btn-danger btn-sm delete-integ-btn" data-id="${i.id}">حذف</button>
                </div>
            </div>
        </div>`;
    }).join('');

    grid.querySelectorAll('.test-integ-btn').forEach(b => b.addEventListener('click', () => testIntegrationConnection(b.dataset.id, showAlert)));
    grid.querySelectorAll('.edit-integ-btn').forEach(b => b.addEventListener('click', () => openEditIntegration(b.dataset.id)));
    grid.querySelectorAll('.toggle-integ-btn').forEach(b => b.addEventListener('click', () => toggleIntegration(b.dataset.id, b.dataset.active === 'true', showAlert)));
    grid.querySelectorAll('.delete-integ-btn').forEach(b => b.addEventListener('click', () => deleteIntegration(b.dataset.id, showAlert)));
}

function populateDefaultAiProviderSelect() {
    const select = document.getElementById('defaultAiProviderSelect');
    if (!select) return;
    const activeAiIntegrations = integrationsCache.filter(i => AI_PROVIDERS.includes(i.provider) && i.is_active);
    select.innerHTML = '<option value="">— بدون (الرد الآلي البسيط فقط) —</option>' +
        activeAiIntegrations.map(i => `<option value="${i.id}">${escapeHtml(i.display_name)} (${PROVIDER_LABELS[i.provider]})</option>`).join('');
}

async function loadDefaultAiProviderSetting() {
    try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;

        const { data, error } = await supabase
            .from('bot_settings')
            .select('id, ai_integration_id')
            .eq('user_id', user.id)
            .is('phone_number_id', null)
            .limit(1)
            .maybeSingle();
        if (error) throw error;

        const select = document.getElementById('defaultAiProviderSelect');
        if (select && data?.ai_integration_id) select.value = data.ai_integration_id;
    } catch (err) {
        console.error('loadDefaultAiProviderSetting error:', err);
    }
}

export async function saveDefaultAiProvider(showAlert) {
    const select = document.getElementById('defaultAiProviderSelect');
    const value = select.value || null;

    try {
        const { data: { user }, error: userError } = await supabase.auth.getUser();
        if (userError || !user) throw new Error('يجب تسجيل الدخول أولاً');

        const { data: existing, error: fetchError } = await supabase
            .from('bot_settings')
            .select('id')
            .eq('user_id', user.id)
            .is('phone_number_id', null)
            .limit(1)
            .maybeSingle();
        if (fetchError) throw fetchError;

        let error;
        if (existing) {
            ({ error } = await supabase
                .from('bot_settings')
                .update({ ai_integration_id: value, ai_enabled: !!value })
                .eq('id', existing.id)
                .eq('user_id', user.id)); // حماية إضافية بجانب RLS
        } else {
            ({ error } = await supabase
                .from('bot_settings')
                .insert({
                    user_id: user.id,
                    phone_number_id: null,
                    ai_integration_id: value,
                    ai_enabled: !!value,
                }));
        }
        if (error) throw error;

        showAlert('تم حفظ المزود الافتراضي للذكاء الاصطناعي', 'success');
    } catch (err) {
        showAlert('خطأ: ' + err.message, 'error');
    }
}

export function openAddIntegration() {
    document.getElementById('integrationModalTitle').textContent = 'إضافة تكامل جديد';
    document.getElementById('editIntegrationId').value = '';
    document.getElementById('integrationProvider').value = 'openai';
    document.getElementById('integrationProvider').disabled = false;
    document.getElementById('integrationDisplayName').value = '';
    document.getElementById('integrationIsActive').checked = true;
    renderCredentialFields('openai');
    document.getElementById('integrationFormModal').style.display = 'block';
}

function openEditIntegration(id) {
    const integ = integrationsCache.find(i => i.id === id);
    if (!integ) return;
    document.getElementById('integrationModalTitle').textContent = 'تعديل التكامل';
    document.getElementById('editIntegrationId').value = integ.id;
    document.getElementById('integrationProvider').value = integ.provider;
    document.getElementById('integrationProvider').disabled = true; // المزوّد لا يتغيّر بعد الإنشاء
    document.getElementById('integrationDisplayName').value = integ.display_name;
    document.getElementById('integrationIsActive').checked = integ.is_active;
    renderCredentialFields(integ.provider);
    if (integ.credentials_meta?.model) {
        const modelInput = document.getElementById('cred-meta-model');
        if (modelInput) modelInput.value = integ.credentials_meta.model;
    }
    document.getElementById('integrationFormModal').style.display = 'block';
}

export async function saveIntegration(showAlert) {
    const id = document.getElementById('editIntegrationId').value;
    const provider = document.getElementById('integrationProvider').value;
    const display_name = document.getElementById('integrationDisplayName').value.trim();
    const is_active = document.getElementById('integrationIsActive').checked;

    if (!display_name) { showAlert('اسم العرض مطلوب', 'error'); return; }

    const fields = CREDENTIAL_FIELDS[provider] || [];
    const credentials = {};
    let hasAnyCred = false;
    fields.forEach(f => {
        const el = document.getElementById(`cred-${f.key}`);
        if (el && el.value.trim()) { credentials[f.key] = el.value.trim(); hasAnyCred = true; }
    });

    if (!id && !hasAnyCred && provider !== 'custom') {
        showAlert('بيانات الاعتماد مطلوبة عند إنشاء تكامل جديد', 'error');
        return;
    }

    const credentials_meta = {};
    const modelInput = document.getElementById('cred-meta-model');
    if (modelInput && modelInput.value.trim()) credentials_meta.model = modelInput.value.trim();

    const btn = document.getElementById('saveIntegrationBtn');
    setBtnLoading(btn, true);
    try {
        const payload = {
            action: id ? 'update' : 'create',
            ...(id ? { id } : { provider, owner_scope: 'platform' }),
            display_name,
            is_active,
            credentials_meta,
        };
        if (hasAnyCred) payload.credentials = credentials;

        await callEdgeFunction('manage-external-integration', payload);
        document.getElementById('integrationFormModal').style.display = 'none';
        showAlert(id ? 'تم تحديث التكامل' : 'تم إضافة التكامل بنجاح', 'success');
        await loadExternalIntegrations(showAlert);
    } catch (err) {
        showAlert('خطأ: ' + err.message, 'error');
    } finally {
        setBtnLoading(btn, false);
    }
}

export async function toggleIntegration(id, currentlyActive, showAlert) {
    try {
        await callEdgeFunction('manage-external-integration', { action: 'update', id, is_active: !currentlyActive });
        showAlert(currentlyActive ? 'تم تعطيل التكامل' : 'تم تفعيل التكامل', 'success');
        await loadExternalIntegrations(showAlert);
    } catch (err) {
        showAlert('خطأ: ' + err.message, 'error');
    }
}

export async function deleteIntegration(id, showAlert) {
    if (!confirm('حذف هذا التكامل نهائيًا؟ أي ميزة تعتمد عليه (مثل رد الذكاء الاصطناعي) ستتوقف.')) return;
    try {
        await callEdgeFunction('manage-external-integration', { action: 'delete', id });
        showAlert('تم حذف التكامل', 'success');
        await loadExternalIntegrations(showAlert);
    } catch (err) {
        showAlert('خطأ: ' + err.message, 'error');
    }
}

export async function testIntegrationConnection(id, showAlert) {
    try {
        const result = await callEdgeFunction('test-integration-connection', { id });
        showAlert(result.message, result.success ? 'success' : 'error');
        await loadExternalIntegrations(showAlert);
    } catch (err) {
        showAlert('خطأ: ' + err.message, 'error');
    }
}

// ============================================================
// Helpers
// ============================================================

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setBtnLoading(btn, loading) {
    if (!btn) return;
    if (loading) { btn.disabled = true; btn.dataset.orig = btn.textContent; btn.textContent = 'جاري المعالجة...'; }
    else { btn.disabled = false; btn.textContent = btn.dataset.orig || btn.textContent; }
}

async function copyToClipboard(value, showAlert) {
    try {
        await navigator.clipboard.writeText(value);
        showAlert('تم النسخ', 'success');
    } catch {
        showAlert('تعذّر النسخ', 'error');
    }
}

// ============================================================
// --- الدمج مع settings.js ---
// في أعلى settings.js أضف:
//   import * as apiIntegrations from './api-integrations.js';
//
// داخل loadAllSettings()، استبدل الخطوة القديمة رقم 10 "Load API Keys"
// (اللي كانت بتقرأ من جدول api_keys) بـ:
//   await apiIntegrations.loadApiTokens(showAlert);
//   await apiIntegrations.loadApiUsageLogs();
//   await apiIntegrations.loadExternalIntegrations(showAlert);
//
// داخل setupEventListeners()، أضف:
//   document.getElementById('createApiTokenBtn')?.addEventListener('click', () => {
//       document.getElementById('apiTokenFormModal').style.display = 'block';
//   });
//   document.getElementById('cancelApiTokenBtn')?.addEventListener('click', () => {
//       document.getElementById('apiTokenFormModal').style.display = 'none';
//   });
//   document.getElementById('confirmCreateApiTokenBtn')?.addEventListener('click', () => apiIntegrations.createApiToken(showAlert));
//   document.getElementById('closeSecretRevealBtn')?.addEventListener('click', () => {
//       document.getElementById('apiSecretRevealModal').style.display = 'none';
//       document.getElementById('revealedApiKey').value = '';
//       document.getElementById('revealedApiSecret').value = '';
//   });
//
//   document.getElementById('addIntegrationBtn')?.addEventListener('click', apiIntegrations.openAddIntegration);
//   document.getElementById('cancelIntegrationBtn')?.addEventListener('click', () => {
//       document.getElementById('integrationFormModal').style.display = 'none';
//   });
//   document.getElementById('saveIntegrationBtn')?.addEventListener('click', () => apiIntegrations.saveIntegration(showAlert));
//   document.getElementById('integrationProvider')?.addEventListener('change', (e) => apiIntegrations.renderCredentialFields(e.target.value));
//   document.getElementById('defaultAiProviderSelect')?.addEventListener('change', () => apiIntegrations.saveDefaultAiProvider(showAlert));
//
// احذف من setupEventListeners() الاستماع القديم على '#saveApiKeysBtn' (مبقاش له زر في الـ HTML الجديد)،
// واحذف من loadAllSettings() ودالة saveApiKeys() القديمة بالكامل (البند 10 والدالة نفسها) لأن الجدول
// القديم api_keys بقى داخليًا بس (يتزامن تلقائيًا من manage-external-integration لتوكن تيليجرام فقط،
// شوف تعليق mirrorTelegramToLegacyTable في نفس الـ Edge Function).
// ============================================================
