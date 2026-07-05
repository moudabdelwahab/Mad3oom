/**
 * MCP Page Logic
 * --------------------------------------------------------
 * فورم ديناميكي حسب auth_type + واجهة إدارة الأدوات (تفعيل/تعطيل/بحث/مزامنة)
 * + معالجة رجوع OAuth (query params في الرابط بعد الـ redirect).
 */

import { initSidebar } from '/assets/js/admin/sidebar.js';
import { checkAdminAuth, updateAdminUI } from '/assets/js/admin/auth.js';
import {
    fetchServers, fetchServerById, createServer, updateServer, deleteServer,
    saveCredentials, startOAuth, testServer, syncTools, setToolEnabled, disconnectServer,
    fetchStats, fetchMcpActivity, MCP_STATUSES, MCP_TRANSPORTS, MCP_AUTH_TYPES,
    MCP_OAUTH_REDIRECT_URI,
} from '/mcp-service.js';

let allServers = [];
let editingId = null;
let toolsModalServerId = null;
let toolsSearchQuery = '';

/* ====================  العرض - قائمة الخوادم  ==================== */

function statusBadge(status) {
    const map = {
        [MCP_STATUSES.CONNECTED]: { label: 'متصل', cls: 'st-connected' },
        [MCP_STATUSES.DISCONNECTED]: { label: 'غير متصل', cls: 'st-disconnected' },
        [MCP_STATUSES.ERROR]: { label: 'خطأ', cls: 'st-error' },
        [MCP_STATUSES.PENDING]: { label: 'بانتظار', cls: 'st-pending' },
    };
    const info = map[status] || map[MCP_STATUSES.PENDING];
    return `<span class="status-chip ${info.cls}"><span class="dot"></span>${info.label}</span>`;
}

function oauthConnectionBadge(server) {
    if (server.auth_type !== 'oauth2') return '';
    const expired = server.oauth_token_expires_at && new Date(server.oauth_token_expires_at) < new Date();
    if (expired) return '<span class="status-chip st-error"><span class="dot"></span>منتهي (Expired)</span>';
    if (server.status === MCP_STATUSES.CONNECTED) return '<span class="status-chip st-connected"><span class="dot"></span>متصل عبر OAuth</span>';
    return '<span class="status-chip st-disconnected"><span class="dot"></span>غير مرتبط بعد</span>';
}

function transportLabel(t) { return { stdio: 'stdio', sse: 'SSE', streamable_http: 'HTTP' }[t] || t; }
function authTypeLabel(t) {
    return { none: 'بدون', api_key: 'API Key', bearer: 'Bearer Token', oauth2: 'OAuth 2.0', custom: 'Custom Headers' }[t] || t;
}

function getFilters() {
    return {
        status: document.getElementById('filterStatus').value,
        transport: document.getElementById('filterTransport').value,
        search: document.getElementById('searchInput').value,
    };
}

async function loadServers() {
    const list = document.getElementById('serversList');
    list.innerHTML = loadingHtml();
    try {
        allServers = await fetchServers(getFilters());
        renderServers(allServers);
        await loadStats();
        await loadActivity();
    } catch (err) {
        console.error('[MCP] loadServers failed:', err);
        list.innerHTML = errorHtml(err.message);
    }
}

function renderServers(servers) {
    const container = document.getElementById('serversList');
    if (!servers.length) { container.innerHTML = emptyHtml(); return; }

    container.innerHTML = servers.map((s) => {
        const toolCount = Array.isArray(s.tools) ? s.tools.length : 0;
        const enabledCount = Array.isArray(s.tools) ? s.tools.filter((t) => t.enabled).length : 0;
        const lastChecked = s.last_checked_at ? new Date(s.last_checked_at).toLocaleString('ar-EG') : 'لم يُختبر بعد';
        return `
        <div class="mcp-card ${s.status === MCP_STATUSES.CONNECTED ? 'is-connected' : ''}" data-id="${s.id}">
            <div class="card-row">
                <div class="card-head">
                    <div class="card-icon">
                        <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
                    </div>
                    <div class="card-title-wrap">
                        <div class="card-title">
                            ${escapeHtml(s.name)}
                            <span class="transport-chip">${transportLabel(s.transport)}</span>
                            <span class="transport-chip">${authTypeLabel(s.auth_type)}</span>
                            ${s.enabled ? '' : '<span class="disabled-chip">معطّل</span>'}
                        </div>
                        <div class="card-subtitle">${escapeHtml(s.description || '—')}</div>
                    </div>
                </div>
                <div class="card-actions-top">
                    ${s.auth_type === 'oauth2' ? oauthConnectionBadge(s) : statusBadge(s.status)}
                </div>
            </div>

            <div class="card-meta">
                ${s.url ? `<span title="عنوان الخادم">🔗 <code dir="ltr">${escapeHtml(s.url)}</code></span>` : ''}
                ${s.command ? `<span title="أمر التشغيل">⚙️ <code dir="ltr">${escapeHtml(s.command)}</code></span>` : ''}
                <span title="الأدوات المفعّلة/الإجمالي">🛠️ ${enabledCount}/${toolCount} أداة مفعّلة</span>
                <span title="آخر فحص">🕒 ${lastChecked}</span>
                ${s.category ? `<span title="التصنيف">🏷️ ${escapeHtml(s.category)}</span>` : ''}
            </div>
            ${s.last_error ? `<div class="card-error">⚠️ ${escapeHtml(s.last_error)}</div>` : ''}

            <div class="card-actions">
                <button class="btn btn-test" onclick="window.mcpTest('${s.id}')">
                    <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>
                    اختبار الاتصال
                </button>
                <button class="btn btn-tools" onclick="window.mcpOpenTools('${s.id}')">
                    <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>
                    الأدوات (${toolCount})
                </button>
                <button class="btn btn-edit" onclick="window.mcpEdit('${s.id}')">
                    <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                    تعديل
                </button>
                ${s.status === MCP_STATUSES.CONNECTED ? `<button class="btn btn-disconnect" onclick="window.mcpDisconnect('${s.id}')">فصل</button>` : ''}
                <button class="btn btn-delete" onclick="window.mcpDelete('${s.id}')">
                    <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    حذف
                </button>
            </div>
        </div>`;
    }).join('');
}

/* ====================  الإحصائيات والنشاط  ==================== */

async function loadStats() {
    try {
        const s = await fetchStats();
        setText('statTotal', s.total);
        setText('statConnected', s.connected);
        setText('statError', s.error);
        setText('statTools', s.tools);
    } catch (e) { console.warn('[MCP] stats failed:', e); }
}

async function loadActivity() {
    const container = document.getElementById('activityList');
    if (!container) return;
    try {
        const log = await fetchMcpActivity(8);
        if (!log.length) { container.innerHTML = '<div class="activity-empty">لا يوجد نشاط مسجّل بعد</div>'; return; }
        container.innerHTML = log.map((a) => {
            const map = {
                created: { label: 'إضافة', cls: 'act-created' }, updated: { label: 'تعديل', cls: 'act-updated' },
                deleted: { label: 'حذف', cls: 'act-deleted' }, connected: { label: 'اتصال ناجح', cls: 'act-connected' },
                disconnected: { label: 'فصل', cls: 'act-disconnected' }, error: { label: 'خطأ', cls: 'act-error' },
                tested: { label: 'اختبار', cls: 'act-tested' },
            };
            const info = map[a.action] || { label: a.action, cls: '' };
            return `<div class="activity-item">
                <span class="activity-tag ${info.cls}">${info.label}</span>
                <span class="activity-name">${escapeHtml(a.details?.name || '—')}</span>
                ${a.details?.message ? `<span class="activity-msg">${escapeHtml(a.details.message)}</span>` : ''}
                <span class="activity-time">${new Date(a.created_at).toLocaleString('ar-EG')}</span>
            </div>`;
        }).join('');
    } catch (e) { console.warn('[MCP] activity failed:', e); }
}

/* ====================  الفورم الديناميكي (إضافة/تعديل)  ==================== */

function resetForm() {
    setValue('fName', ''); setValue('fTransport', 'streamable_http'); setValue('fUrl', '');
    setValue('fCommand', ''); setValue('fArgs', ''); setValue('fEnv', ''); setValue('fHeaders', '');
    setValue('fDescription', ''); setValue('fCategory', 'general');
    setValue('fAuthType', 'none');
    setValue('fApiKey', ''); setValue('fApiSecret', '');
    setValue('fBearerToken', '');
    setValue('fCustomConfig', '');
    setValue('fOauthClientId', ''); setValue('fOauthClientSecret', '');
    setValue('fOauthAuthorizeUrl', ''); setValue('fOauthTokenUrl', ''); setValue('fOauthScope', '');
    setValue('fOauthRedirectUri', MCP_OAUTH_REDIRECT_URI);
    document.getElementById('fEnabled').checked = true;
    document.getElementById('oauthStatusBadge').innerHTML = '';
    document.getElementById('oauthConnectBtn').disabled = false;
}

function openModal(id = null) {
    editingId = id;
    const modal = document.getElementById('mcpModal');
    const title = document.getElementById('modalTitle');
    resetForm();
    clearError();

    if (id) {
        title.textContent = 'تعديل خادم MCP';
        const server = allServers.find((s) => s.id === id);
        if (server) fillForm(server);
    } else {
        title.textContent = 'إضافة خادم MCP جديد';
    }

    onTransportChange();
    onAuthTypeChange();
    modal.classList.add('open');
}

function closeModal() {
    document.getElementById('mcpModal').classList.remove('open');
    editingId = null;
}

function fillForm(s) {
    setValue('fName', s.name); setValue('fTransport', s.transport); setValue('fUrl', s.url || '');
    setValue('fCommand', s.command || ''); setValue('fArgs', Array.isArray(s.args) ? s.args.join(' ') : '');
    setValue('fEnv', s.env ? JSON.stringify(s.env, null, 2) : '');
    setValue('fHeaders', s.headers ? JSON.stringify(s.headers, null, 2) : '');
    setValue('fDescription', s.description || ''); setValue('fCategory', s.category || 'general');
    document.getElementById('fEnabled').checked = s.enabled !== false;

    setValue('fAuthType', s.auth_type || 'none');
    // لا نملأ أي سر أبداً (api_key/secret/bearer/custom/client_secret) - فاضي = "سيبه زي ما هو"
    setValue('fOauthClientId', s.oauth_client_id || '');
    setValue('fOauthAuthorizeUrl', s.oauth_authorize_url || '');
    setValue('fOauthTokenUrl', s.oauth_token_url || '');
    setValue('fOauthScope', s.oauth_scope || '');
    setValue('fOauthRedirectUri', MCP_OAUTH_REDIRECT_URI);

    renderOauthStatusBadge(s);
}

function renderOauthStatusBadge(s) {
    const el = document.getElementById('oauthStatusBadge');
    if (!el) return;
    if (s.auth_type !== 'oauth2') { el.innerHTML = ''; return; }
    const expired = s.oauth_token_expires_at && new Date(s.oauth_token_expires_at) < new Date();
    if (expired) el.innerHTML = '<span class="status-chip st-error"><span class="dot"></span>منتهي - يحتاج إعادة ربط</span>';
    else if (s.status === MCP_STATUSES.CONNECTED) el.innerHTML = '<span class="status-chip st-connected"><span class="dot"></span>متصل</span>';
    else el.innerHTML = '<span class="status-chip st-disconnected"><span class="dot"></span>غير متصل بعد</span>';
}

/** إظهار/إخفاء حقول النقل (نفس السلوك القديم) */
function onTransportChange() {
    const t = document.getElementById('fTransport').value;
    document.getElementById('httpFields').style.display = t === 'stdio' ? 'none' : 'block';
    document.getElementById('stdioFields').style.display = t === 'stdio' ? 'block' : 'none';
}

/** إظهار/إخفاء قسم المصادقة المناسب فقط - Dynamic Form */
function onAuthTypeChange() {
    const t = document.getElementById('fAuthType').value;
    const sections = { api_key: 'authSectionApiKey', bearer: 'authSectionBearer', custom: 'authSectionCustom', oauth2: 'authSectionOauth' };
    Object.entries(sections).forEach(([type, elId]) => {
        document.getElementById(elId).style.display = t === type ? 'block' : 'none';
    });
}

function collectBaseForm() {
    return {
        name: document.getElementById('fName').value,
        transport: document.getElementById('fTransport').value,
        url: document.getElementById('fUrl').value,
        command: document.getElementById('fCommand').value,
        args: document.getElementById('fArgs').value,
        env: document.getElementById('fEnv').value,
        headers: document.getElementById('fHeaders').value,
        description: document.getElementById('fDescription').value,
        category: document.getElementById('fCategory').value,
        enabled: document.getElementById('fEnabled').checked,
    };
}

function collectCredentialsPayload() {
    const authType = document.getElementById('fAuthType').value;
    const payload = { auth_type: authType };

    if (authType === 'api_key') {
        payload.api_key = document.getElementById('fApiKey').value;
        payload.api_secret = document.getElementById('fApiSecret').value;
    } else if (authType === 'bearer') {
        payload.bearer_token = document.getElementById('fBearerToken').value;
    } else if (authType === 'custom') {
        payload.custom_config = document.getElementById('fCustomConfig').value;
    } else if (authType === 'oauth2') {
        payload.oauth_client_id = document.getElementById('fOauthClientId').value;
        payload.oauth_client_secret = document.getElementById('fOauthClientSecret').value;
        payload.oauth_authorize_url = document.getElementById('fOauthAuthorizeUrl').value;
        payload.oauth_token_url = document.getElementById('fOauthTokenUrl').value;
        payload.oauth_scope = document.getElementById('fOauthScope').value;
    }
    return payload;
}

async function submitForm() {
    clearError();
    const btn = document.getElementById('saveBtn');
    btn.disabled = true;
    btn.textContent = 'جاري الحفظ...';

    try {
        const basePayload = collectBaseForm();
        let serverId = editingId;

        if (editingId) {
            await updateServer(editingId, basePayload);
        } else {
            const created = await createServer(basePayload);
            serverId = created.id;
        }

        await saveCredentials(serverId, collectCredentialsPayload());

        toast(editingId ? 'تم تحديث الخادم بنجاح' : 'تمت إضافة الخادم بنجاح', 'success');
        closeModal();
        await loadServers();
    } catch (err) {
        showError(err.message || 'حدث خطأ أثناء الحفظ');
    } finally {
        btn.disabled = false;
        btn.textContent = 'حفظ الخادم';
    }
}

/** ربط OAuth - يحفظ إعدادات التطبيق أولاً (لو تغيّرت) ثم يحوّل المتصفح لرابط الموافقة */
async function handleConnectOAuth() {
    if (!editingId) { showError('احفظ الخادم أولاً قبل الربط عبر OAuth'); return; }
    const btn = document.getElementById('oauthConnectBtn');
    btn.disabled = true;
    try {
        await saveCredentials(editingId, collectCredentialsPayload());
        const { authorize_url } = await startOAuth(editingId);
        window.location.href = authorize_url;
    } catch (err) {
        showError(err.message || 'فشل بدء ربط OAuth');
        btn.disabled = false;
    }
}

/* ====================  الإجراءات المعروضة على window  ==================== */

async function handleTest(id) {
    const card = document.querySelector(`.mcp-card[data-id="${id}"]`);
    if (card) card.classList.add('testing');
    try {
        toast('جاري اختبار الاتصال...', 'info');
        const result = await testServer(id);
        if (result.ok) {
            const extra = result.serverName ? ` • ${result.serverName}${result.serverVersion ? ' v' + result.serverVersion : ''}` : '';
            toast(`${result.message} • زمن الاستجابة ${result.latency ?? '—'} مللي ثانية${extra}`, 'success');
        } else {
            toast(result.message || 'فشل الاتصال', 'error');
        }
        await loadServers();
    } catch (err) {
        toast(err.message || 'فشل الاختبار', 'error');
    } finally {
        if (card) card.classList.remove('testing');
    }
}

async function handleDelete(id) {
    const server = allServers.find((s) => s.id === id);
    if (!confirm(`هل أنت متأكد من حذف خادم "${server?.name || ''}"؟ لا يمكن التراجع عن هذا الإجراء.`)) return;
    try {
        await deleteServer(id);
        toast('تم حذف الخادم', 'success');
        await loadServers();
    } catch (err) { toast(err.message || 'فشل الحذف', 'error'); }
}

async function handleDisconnect(id) {
    try {
        await disconnectServer(id);
        toast('تم فصل الخادم', 'success');
        await loadServers();
    } catch (err) { toast(err.message || 'فشل الفصل', 'error'); }
}

/* ====================  مودال إدارة الأدوات  ==================== */

function openToolsModal(serverId) {
    toolsModalServerId = serverId;
    toolsSearchQuery = '';
    document.getElementById('toolsSearchInput').value = '';
    renderToolsModal();
    document.getElementById('toolsModal').classList.add('open');
}

function closeToolsModal() {
    document.getElementById('toolsModal').classList.remove('open');
    toolsModalServerId = null;
}

function renderToolsModal() {
    const server = allServers.find((s) => s.id === toolsModalServerId);
    if (!server) return;

    document.getElementById('toolsModalTitle').textContent = `إدارة أدوات: ${server.name}`;

    const tools = (Array.isArray(server.tools) ? server.tools : []).filter((t) => {
        if (!toolsSearchQuery) return true;
        const q = toolsSearchQuery.toLowerCase();
        return t.name.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q);
    });

    const list = document.getElementById('toolsList');
    if (!Array.isArray(server.tools) || server.tools.length === 0) {
        list.innerHTML = `<div class="tools-empty">مفيش أدوات مكتشفة بعد. اعمل "اختبار اتصال" أو "مزامنة الأدوات" أولاً.</div>`;
        return;
    }
    if (!tools.length) {
        list.innerHTML = `<div class="tools-empty">مفيش نتائج بحث مطابقة.</div>`;
        return;
    }

    list.innerHTML = tools.map((t) => `
        <div class="tool-row">
            <div class="tool-info">
                <div class="tool-name">${escapeHtml(t.name)}</div>
                <div class="tool-desc">${escapeHtml(t.description || '—')}</div>
            </div>
            <label class="toggle-switch">
                <input type="checkbox" ${t.enabled ? 'checked' : ''} onchange="window.mcpToggleTool('${escapeHtml(t.name)}', this.checked)">
                <span class="toggle-slider"></span>
            </label>
        </div>
    `).join('');
}

async function handleToggleTool(toolName, enabled) {
    const server = allServers.find((s) => s.id === toolsModalServerId);
    if (!server) return;
    try {
        const updatedTools = await setToolEnabled(server.connection_id, toolName, enabled);
        server.tools = updatedTools;
        renderToolsModal();
        renderServers(allServers);
    } catch (err) {
        toast(err.message || 'فشل تحديث حالة الأداة', 'error');
        renderToolsModal();
    }
}

async function handleSyncTools() {
    if (!toolsModalServerId) return;
    const btn = document.getElementById('syncToolsBtn');
    btn.disabled = true;
    btn.textContent = 'جاري المزامنة...';
    try {
        const result = await syncTools(toolsModalServerId);
        await loadServers();
        if (result.ok) toast(`تمت المزامنة (${result.tools} أداة)`, 'success');
        else toast(result.message || 'فشلت المزامنة', 'error');
        renderToolsModal();
    } catch (err) {
        toast(err.message || 'فشلت المزامنة', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'مزامنة الأدوات';
    }
}

/* ====================  رجوع OAuth (query params بعد الـ redirect)  ==================== */

function handleOauthReturn() {
    const params = new URLSearchParams(window.location.search);
    const oauthResult = params.get('oauth');
    if (!oauthResult) return;

    if (oauthResult === 'success') toast('تم الربط عبر OAuth بنجاح', 'success');
    else toast(params.get('message') || 'فشل الربط عبر OAuth', 'error');

    // تنظيف الرابط عشان ميتكررش عند أي refresh
    const cleanUrl = window.location.pathname;
    window.history.replaceState({}, document.title, cleanUrl);
}

/* ====================  مساعدات عامة  ==================== */

function loadingHtml() { return `<div class="state-block"><div class="spinner"></div><p>جاري تحميل خوادم MCP...</p></div>`; }
function emptyHtml() {
    return `<div class="state-block empty">
        <svg viewBox="0 0 24 24" width="56" height="56" stroke="var(--color-text-secondary)" stroke-width="1" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg>
        <h3>لا توجد خوادم MCP مضافة</h3>
        <p>ابدأ بربط أول خادم Model Context Protocol للاستفادة من أدواته داخل المنصة.</p>
        <button class="btn btn-primary" onclick="window.mcpAdd()">+ إضافة أول خادم</button>
    </div>`;
}
function errorHtml(message) {
    return `<div class="state-block error">
        <svg viewBox="0 0 24 24" width="48" height="48" stroke="var(--color-danger)" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
        <h3>تعذّر تحميل البيانات</h3><p>${escapeHtml(message)}</p>
        <button class="btn btn-primary" onclick="window.mcpReload()">إعادة المحاولة</button>
    </div>`;
}
function toast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `<span>${escapeHtml(message)}</span>`;
    container.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 4000);
}
function showError(msg) { const box = document.getElementById('formError'); box.textContent = msg; box.style.display = 'block'; }
function clearError() { const box = document.getElementById('formError'); box.textContent = ''; box.style.display = 'none'; }
function escapeHtml(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function setValue(id, val) { const el = document.getElementById(id); if (el) el.value = val ?? ''; }
function debounce(fn, wait = 350) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); }; }

function copyRedirectUri() {
    navigator.clipboard.writeText(MCP_OAUTH_REDIRECT_URI).then(() => toast('تم نسخ الرابط', 'success'));
}

/* ====================  التهيئة  ==================== */

document.addEventListener('DOMContentLoaded', async () => {
    const user = await checkAdminAuth();
    if (user) updateAdminUI(user);
    initSidebar();

    window.mcpAdd = () => openModal();
    window.mcpEdit = (id) => openModal(id);
    window.mcpDelete = handleDelete;
    window.mcpTest = handleTest;
    window.mcpDisconnect = handleDisconnect;
    window.mcpReload = loadServers;
    window.mcpCloseModal = closeModal;
    window.mcpSubmit = submitForm;
    window.mcpOnTransportChange = onTransportChange;
    window.mcpOnAuthTypeChange = onAuthTypeChange;
    window.mcpConnectOAuth = handleConnectOAuth;
    window.mcpCopyRedirectUri = copyRedirectUri;
    window.mcpOpenTools = openToolsModal;
    window.mcpCloseToolsModal = closeToolsModal;
    window.mcpToggleTool = handleToggleTool;
    window.mcpSyncTools = handleSyncTools;

    document.getElementById('addBtn').addEventListener('click', () => openModal());
    document.getElementById('refreshBtn').addEventListener('click', loadServers);
    document.getElementById('saveBtn').addEventListener('click', submitForm);
    document.getElementById('filterStatus').addEventListener('change', loadServers);
    document.getElementById('filterTransport').addEventListener('change', loadServers);
    document.getElementById('searchInput').addEventListener('input', debounce(loadServers, 400));
    document.getElementById('fTransport').addEventListener('change', onTransportChange);
    document.getElementById('fAuthType').addEventListener('change', onAuthTypeChange);

    document.getElementById('mcpModal').addEventListener('click', (e) => { if (e.target.id === 'mcpModal') closeModal(); });
    document.getElementById('modalClose').addEventListener('click', closeModal);

    document.getElementById('toolsModal').addEventListener('click', (e) => { if (e.target.id === 'toolsModal') closeToolsModal(); });
    document.getElementById('toolsModalClose').addEventListener('click', closeToolsModal);
    document.getElementById('syncToolsBtn').addEventListener('click', handleSyncTools);
    document.getElementById('toolsSearchInput').addEventListener('input', debounce((e) => {
        toolsSearchQuery = e.target.value;
        renderToolsModal();
    }, 250));

    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); closeToolsModal(); } });

    handleOauthReturn();
    await loadServers();
});
