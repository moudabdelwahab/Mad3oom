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
    MCP_OAUTH_REDIRECT_URI,fetchMcpServerInfo, setMcpServerToolEnabled, fetchOAuthConfig,

    fetchApiTokens, fetchApiUsageLogs, createApiToken, regenerateApiTokenSecret,
    toggleApiToken, deleteApiToken, API_TOKEN_ALLOWED_SCOPES, API_TOKEN_DEFAULT_SCOPES,
    fetchExternalIntegrations, saveExternalIntegration, deleteExternalIntegration,
    testExternalIntegration, fetchDefaultAiProvider, saveDefaultAiProvider,
    fetchIntegrationModels, OPENAI_COMPATIBLE_PROVIDERS,
    INTEGRATION_PROVIDER_LABELS, INTEGRATION_CREDENTIAL_FIELDS, AI_INTEGRATION_PROVIDERS,
    MCP_CLIENT_CATALOG, MCP_CATALOG_CATEGORIES, invokeMcpTool, findConnectedServerForCatalogEntry,
} from '/mcp-service.js';

let mcpMarketCategory = 'all';
let mcpMarketSearchQuery = '';
let explorerSearchQuery = '';

/** عنوان ربط مدعوم كـ MCP Connector (OAuth) - نفس الرابط اللي يتضاف كـ Connector في Claude أو أي عميل MCP يدعم Streamable HTTP */
const MCP_CONNECTOR_URL = 'https://mad3oom.online/mcp';

let allServers = [];
let editingId = null;
let toolsModalServerId = null;
let toolsSearchQuery = '';

/* ====================  أيقونات SVG صغيرة (بديل الإيموجي)  ==================== */
function ic(inner) {
    return `<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;flex-shrink:0">${inner}</svg>`;
}
const ICN = {
    link: ic('<path d="M10 13a5 5 0 0 0 7.07 0l1.93-1.93a5 5 0 0 0-7.07-7.07L10.5 5.5"></path><path d="M14 11a5 5 0 0 0-7.07 0L5 12.93a5 5 0 0 0 7.07 7.07L13.5 18.5"></path>'),
    gear: ic('<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>'),
    tools: ic('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>'),
    clock: ic('<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>'),
    tag: ic('<path d="M20.59 13.41L13.42 20.58a2 2 0 0 1-2.83 0L2 12.99V2h10.99l8.6 8.6a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line>'),
    alert: ic('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>'),
    lock: ic('<rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>'),
    key: ic('<circle cx="7.5" cy="15.5" r="5.5"></circle><path d="M21 2l-9.6 9.6"></path><path d="M15.5 7.5l3 3L22 7l-3-3"></path>'),
    ticket: ic('<path d="M3 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2z"></path><line x1="13" y1="5" x2="13" y2="19"></line>'),
    signal: ic('<circle cx="12" cy="12" r="2"></circle><path d="M16.24 7.76a6 6 0 0 1 0 8.48M7.76 16.24a6 6 0 0 1 0-8.48M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"></path>'),
    barChart: ic('<line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line>'),
    calendar: ic('<rect x="3" y="4" width="18" height="18" rx="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line>'),
    cpu: ic('<rect x="6" y="6" width="12" height="12" rx="1"></rect><line x1="9" y1="1" x2="9" y2="4"></line><line x1="15" y1="1" x2="15" y2="4"></line><line x1="9" y1="20" x2="9" y2="23"></line><line x1="15" y1="20" x2="15" y2="23"></line><line x1="20" y1="9" x2="23" y2="9"></line><line x1="20" y1="15" x2="23" y2="15"></line><line x1="1" y1="9" x2="4" y2="9"></line><line x1="1" y1="15" x2="4" y2="15"></line>'),
    globe: ic('<circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 0 20 15.3 15.3 0 0 1 0-20z"></path>'),
    target: ic('<circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle>'),
    eye: ic('<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"></path><circle cx="12" cy="12" r="3"></circle>'),
    zap: ic('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>'),
    hourglass: ic('<path d="M6 2h12M6 22h12M8 2v4a4 4 0 0 0 8 0V2M8 22v-4a4 4 0 0 1 8 0v4"></path>'),
};

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
        // البيانات مشتركة مع تبويب "MCP العميل" الجديد - نحدّثه كل ما يتغيّر allServers هنا
        if (document.getElementById('connectorGrid')) renderConnectorGrid();
        if (document.getElementById('toolExplorerList')) renderToolExplorer();
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
                ${s.url ? `<span title="عنوان الخادم">${ICN.link} <code dir="ltr">${escapeHtml(s.url)}</code></span>` : ''}
                ${s.command ? `<span title="أمر التشغيل">${ICN.gear} <code dir="ltr">${escapeHtml(s.command)}</code></span>` : ''}
                <span title="الأدوات المفعّلة/الإجمالي">${ICN.tools} ${enabledCount}/${toolCount} أداة مفعّلة</span>
                <span title="آخر فحص">${ICN.clock} ${lastChecked}</span>
                ${s.category ? `<span title="التصنيف">${ICN.tag} ${escapeHtml(s.category)}</span>` : ''}
            </div>
            ${s.last_error ? `<div class="card-error">${ICN.alert} ${escapeHtml(s.last_error)}</div>` : ''}

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

/* ====================  MCP Client Marketplace (جديد)  ==================== */

function connectorIconSvg(iconPaths, fallbackInitial) {
    if (!iconPaths) return escapeHtml(fallbackInitial || '?');
    return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconPaths}</svg>`;
}

function renderCategoryChips() {
    const container = document.getElementById('mcpCategoryChips');
    if (!container) return;
    container.innerHTML = MCP_CATALOG_CATEGORIES.map((c) => `
        <button type="button" class="mcp-chip ${mcpMarketCategory === c.key ? 'active' : ''}" data-cat="${c.key}">${escapeHtml(c.label)}</button>
    `).join('');
    container.querySelectorAll('.mcp-chip').forEach((btn) => {
        btn.addEventListener('click', () => {
            mcpMarketCategory = btn.dataset.cat;
            renderConnectorGrid();
            renderCategoryChips();
        });
    });
}

async function loadMcpClientMarketplace() {
    renderCategoryChips();
    if (!allServers.length) await loadServers(); // loadServers نفسه بينادي renderConnectorGrid/renderToolExplorer في النهاية
    else { renderConnectorGrid(); renderToolExplorer(); }
}

function connectorStatusChip(server) {
    if (!server) return '<span class="status-chip st-disconnected"><span class="dot"></span>غير متصل</span>';
    return statusBadge(server.status);
}

function renderConnectorGrid() {
    const grid = document.getElementById('connectorGrid');
    if (!grid) return;

    const q = mcpMarketSearchQuery.trim().toLowerCase();
    const catalogFiltered = MCP_CLIENT_CATALOG.filter((c) => {
        if (mcpMarketCategory !== 'all' && c.category !== mcpMarketCategory) return false;
        if (q && !(c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))) return false;
        return true;
    });

    // أي خادم مضاف يدويًا (من تبويب Servers) ولا يطابق أي عنصر كتالوج - نعرضه كبطاقة مخصّصة كمان
    const catalogUrls = new Set(MCP_CLIENT_CATALOG.map((c) => (c.url || '').trim().toLowerCase().replace(/\/+$/, '')));
    const extraServers = allServers.filter((s) => !catalogUrls.has((s.url || '').trim().toLowerCase().replace(/\/+$/, '')));

    if (!catalogFiltered.length && !extraServers.length) {
        grid.innerHTML = `<div class="state-block empty"><p>لا توجد نتائج مطابقة للبحث/التصنيف المحدد.</p></div>`;
        return;
    }

    const catalogCards = catalogFiltered.map((c) => {
        const server = c.isCustomBlank ? null : findConnectedServerForCatalogEntry(c, allServers);
        const isConnected = server && server.status === MCP_STATUSES.CONNECTED;
        const toolCount = server && Array.isArray(server.tools) ? server.tools.length : 0;

        const actions = c.isCustomBlank
            ? `<button class="btn btn-primary" onclick="window.mcpAdd()">+ إضافة خادم مخصّص</button>`
            : server
                ? `
                    <button class="btn btn-tools" onclick="window.mcpOpenTools('${server.id}')">الأدوات (${toolCount})</button>
                    <button class="btn btn-edit" onclick="window.mcpEdit('${server.id}')">إدارة</button>
                    ${isConnected ? `<button class="btn btn-disconnect" onclick="window.mcpDisconnect('${server.id}')">فصل</button>` : ''}
                  `
                : `<button class="btn btn-primary" onclick="window.mcpConnectCatalog('${c.key}')">ربط (Connect)</button>`;

        return `
        <div class="connector-card ${isConnected ? 'is-connected' : ''}">
            <div class="connector-card-top">
                <div class="connector-icon" style="background:${c.brandColor}">${connectorIconSvg(c.icon, c.initial)}</div>
                <div class="connector-name-wrap">
                    <div class="connector-name">${escapeHtml(c.name)}</div>
                    <div class="connector-desc">${escapeHtml(c.description)}</div>
                </div>
            </div>
            <div class="connector-meta-row">
                ${connectorStatusChip(server)}
                ${server ? `<span>🛠️ ${toolCount} أداة</span>` : ''}
            </div>
            ${!server && c.setup_note ? `<div class="connector-setup-note">${escapeHtml(c.setup_note)}</div>` : ''}
            <div class="connector-actions">${actions}</div>
        </div>`;
    }).join('');

    const extraCards = (mcpMarketCategory === 'all' || mcpMarketCategory === 'custom') ? extraServers.filter((s) => {
        if (!q) return true;
        return (s.name || '').toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q);
    }).map((s) => {
        const isConnected = s.status === MCP_STATUSES.CONNECTED;
        const toolCount = Array.isArray(s.tools) ? s.tools.length : 0;
        return `
        <div class="connector-card ${isConnected ? 'is-connected' : ''}">
            <div class="connector-card-top">
                <div class="connector-icon" style="background:#64748b">${connectorIconSvg('<rect x="2" y="3" width="20" height="8" rx="2"></rect><rect x="2" y="13" width="20" height="8" rx="2"></rect><line x1="6" y1="7" x2="6.01" y2="7"></line><line x1="6" y1="17" x2="6.01" y2="17"></line>', (s.name || '?').trim().charAt(0).toUpperCase())}</div>
                <div class="connector-name-wrap">
                    <div class="connector-name">${escapeHtml(s.name)}</div>
                    <div class="connector-desc">${escapeHtml(s.description || 'خادم مخصّص مُضاف يدويًا')}</div>
                </div>
            </div>
            <div class="connector-meta-row">${connectorStatusChip(s)}<span>🛠️ ${toolCount} أداة</span></div>
            <div class="connector-actions">
                <button class="btn btn-tools" onclick="window.mcpOpenTools('${s.id}')">الأدوات (${toolCount})</button>
                <button class="btn btn-edit" onclick="window.mcpEdit('${s.id}')">إدارة</button>
                ${isConnected ? `<button class="btn btn-disconnect" onclick="window.mcpDisconnect('${s.id}')">فصل</button>` : ''}
            </div>
        </div>`;
    }).join('') : '';

    grid.innerHTML = catalogCards + extraCards;
}

/** يفتح نفس مودال "إضافة خادم" الموجود بالفعل، ويملأ الحقول بقيم الكتالوج الافتراضية فقط - العملية الفعلية
 *  (createServer/saveCredentials/startOAuth) هي نفسها تمامًا بدون أي تعديل. */
window.mcpConnectCatalog = function (catalogKey) {
    const entry = MCP_CLIENT_CATALOG.find((c) => c.key === catalogKey);
    if (!entry) return;

    openModal(null);
    document.getElementById('modalTitle').textContent = `ربط ${entry.name}`;
    setValue('fName', entry.name);
    setValue('fTransport', entry.transport || 'streamable_http');
    setValue('fUrl', entry.url || '');
    setValue('fCategory', entry.category || 'general');
    setValue('fDescription', entry.description || '');
    setValue('fAuthType', entry.auth_type || 'none');
    if (entry.auth_type === 'oauth2') {
        setValue('fOauthAuthorizeUrl', entry.oauth_authorize_url || '');
        setValue('fOauthTokenUrl', entry.oauth_token_url || '');
        setValue('fOauthScope', entry.oauth_scope || '');
    }
    // نعيد استدعاء نفس دوال إظهار/إخفاء الحقول الموجودة بالفعل عشان تعكس القيم الجديدة
    if (typeof onTransportChange === 'function') onTransportChange();
    if (typeof onAuthTypeChange === 'function') onAuthTypeChange();

    if (entry.needsManualUrl && !entry.url) {
        toast('هذا الموصل يحتاج رابط خادم خاص بإعدادك - راجع التوثيق قبل الحفظ', 'info');
    }
};

/* ====================  Tool Explorer (جديد) - تشغيل أي أداة مباشرة من الواجهة  ==================== */

function renderToolExplorer() {
    const list = document.getElementById('toolExplorerList');
    if (!list) return;

    const q = explorerSearchQuery.trim().toLowerCase();
    const rows = [];
    allServers.forEach((server) => {
        if (server.status !== MCP_STATUSES.CONNECTED || !Array.isArray(server.tools)) return;
        server.tools.forEach((t) => {
            if (!t.enabled) return;
            if (q && !(t.name.toLowerCase().includes(q) || (server.name || '').toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q))) return;
            rows.push({ server, tool: t });
        });
    });

    if (!rows.length) {
        list.innerHTML = `<div class="tools-empty">لا توجد أدوات مفعّلة من موصلات متصلة بعد. اربط موصلًا من فوق وفعّل أدواته.</div>`;
        return;
    }

    list.innerHTML = rows.map(({ server, tool }, idx) => {
        const rowId = `explorer_${idx}_${server.id}_${sanitizeId(tool.name)}`;
        return `
        <div class="tool-row" style="flex-direction:column;align-items:stretch;gap:0.5rem">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem">
                <div class="tool-info">
                    <div class="tool-name">${escapeHtml(tool.name)} <span class="transport-chip">${escapeHtml(server.name)}</span></div>
                    <div class="tool-desc">${escapeHtml(tool.description || '—')}</div>
                </div>
                <button class="btn btn-test" onclick="window.mcpToggleRunPanel('${rowId}')">▶ تشغيل</button>
            </div>
            <div class="tool-run-panel" id="panel_${rowId}">
                <label style="font-size:0.78rem;font-weight:700;color:var(--color-text-secondary)">المعاملات (JSON)</label>
                <textarea id="args_${rowId}" placeholder="{}">{}</textarea>
                <div style="display:flex;gap:0.5rem;margin-top:0.5rem">
                    <button class="btn btn-primary" onclick="window.mcpRunTool('${rowId}', '${escapeHtml(tool.name)}')">تشغيل الأداة</button>
                </div>
                <div id="result_${rowId}"></div>
            </div>
        </div>`;
    }).join('');
}

function sanitizeId(str) { return String(str).replace(/[^a-zA-Z0-9_]/g, '_'); }

window.mcpToggleRunPanel = function (rowId) {
    const panel = document.getElementById(`panel_${rowId}`);
    if (panel) panel.classList.toggle('open');
};

window.mcpRunTool = async function (rowId, toolName) {
    const textarea = document.getElementById(`args_${rowId}`);
    const resultBox = document.getElementById(`result_${rowId}`);
    let args = {};
    try {
        args = textarea.value.trim() ? JSON.parse(textarea.value) : {};
    } catch {
        resultBox.innerHTML = `<div class="tool-run-result error">المعاملات مش JSON صالح - تأكد من الصيغة.</div>`;
        return;
    }

    resultBox.innerHTML = `<div class="tool-run-result">جاري التنفيذ...</div>`;
    try {
        const res = await invokeMcpTool(toolName, args);
        resultBox.innerHTML = `<div class="tool-run-result success">${escapeHtml(JSON.stringify(res.result ?? res, null, 2))}</div>`;
    } catch (err) {
        resultBox.innerHTML = `<div class="tool-run-result error">${escapeHtml(err.message || 'فشل تنفيذ الأداة')}</div>`;
    }
};

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

/* ============================================================
 *  تبويب رئيسي: خوادم MCP / مفاتيح API / External Integrations
 *  (منقول بالكامل من صفحة الإعدادات - مصدر واحد فقط لإدارة الـ API)
 * ============================================================ */

function switchDevTab(tab) {
    document.querySelectorAll('.dev-tab').forEach((b) => b.classList.toggle('active', b.dataset.devtab === tab));
    document.getElementById('devSectionMcpClient').classList.toggle('active', tab === 'mcpclient');
    document.getElementById('devSectionServers').classList.toggle('active', tab === 'servers');
    document.getElementById('devSectionMcpServer').classList.toggle('active', tab === 'mcpserver');
    document.getElementById('devSectionApiTokens').classList.toggle('active', tab === 'apitokens');
    document.getElementById('devSectionIntegrations').classList.toggle('active', tab === 'integrations');

    if (tab === 'mcpclient' && !mcpClientMarketLoadedOnce) { mcpClientMarketLoadedOnce = true; loadMcpClientMarketplace(); }
    if (tab === 'mcpserver' && !mcpServerLoadedOnce) { mcpServerLoadedOnce = true; loadMcpServerSection(); }
    if (tab === 'apitokens' && !apiTokensLoadedOnce) { apiTokensLoadedOnce = true; loadApiTokensSection(); }
    if (tab === 'integrations' && !integrationsLoadedOnce) { integrationsLoadedOnce = true; loadIntegrationsSection(); }
}

let mcpClientMarketLoadedOnce = false;

let apiTokensLoadedOnce = false;
let integrationsLoadedOnce = false;
let allApiTokens = [];
let allIntegrations = [];
let pendingCreateApiTokenResult = null;

/* ====================  Mad3oom كـ MCP Server (Phase 3)  ==================== */

let mcpServerLoadedOnce = false;

/** خريطة تسميات فقط للعرض - أي مفتاح جديد في capabilities من الباك إند
 *  بيتعرض تلقائياً حتى لو مش موجود هنا (بيرجع اسم المفتاح نفسه كـ fallback) */
function capabilityLabel(key) {
    return { tools: 'Tools', resources: 'Resources', prompts: 'Prompts', streaming: 'Streaming', oauth: 'OAuth' }[key] || key;
}

/** true → شارة "مدعومة" فعلية (أخضر). false → "Coming Soon" مميزة بصريًا بوضوح - مش بتتعرض كأنها شغالة */
function renderCapabilityBadge(key, supported) {
    return supported
        ? `<span class="status-chip st-connected"><span class="dot"></span>${capabilityLabel(key)}</span>`
        : `<span class="status-chip st-pending"><span class="dot"></span>${capabilityLabel(key)} — Coming Soon</span>`;
}

function authMethodLabel(m) {
    return { api_key_secret: 'API Key + Secret', bearer: 'Bearer Token' }[m] || m;
}

async function loadMcpServerSection() {
    const card = document.getElementById('mcpServerStatusCard');
    card.innerHTML = loadingHtml();
    try {
        const info = await fetchMcpServerInfo('status');
        renderMcpServerStatus(info);
        renderMcpServerTools(info.tools || []);
    } catch (err) {
        card.innerHTML = errorHtml(err.message);
    }
    await loadOAuthConfigSection();
}

/* ====================  إعدادات OAuth (Phase 4) - عرض تلقائي بالكامل  ==================== */

async function loadOAuthConfigSection() {
    const card = document.getElementById('oauthConfigCard');
    if (!card) return;
    card.innerHTML = loadingHtml();
    try {
        const cfg = await fetchOAuthConfig();
        renderOAuthConfig(cfg);
    } catch (err) {
        card.innerHTML = errorHtml(err.message || 'تعذّر تحميل إعدادات OAuth');
    }
}

function oauthStatusBadge(cfg) {
    return cfg.status === 'connected'
        ? '<span class="status-chip st-connected"><span class="dot"></span>مفعّل ويعمل (Active)</span>'
        : '<span class="status-chip st-error"><span class="dot"></span>غير متاح حاليًا</span>';
}

/** صف حقل بقيمة للقراءة فقط + زر نسخ - نفس نمط secret-reveal-box الموجود بالفعل، بدون تكرار CSS جديد */
function oauthCopyRow(label, value) {
    return `
        <div class="form-group full" style="margin-bottom:0.85rem">
            <label>${label}</label>
            <div class="oauth-field-row">
                <input type="text" class="reveal-field" readonly dir="ltr" value="${escapeHtml(value || '—')}">
                <button type="button" class="btn btn-secondary btn-copy" onclick="window.mcpCopyText('${escapeHtml(value || '')}')">نسخ</button>
            </div>
        </div>`;
}

function renderOAuthConfig(cfg) {
    const card = document.getElementById('oauthConfigCard');
    const statusHtml = oauthStatusBadge(cfg);

    if (cfg.status !== 'connected') {
        card.innerHTML = `
            <div class="card-row">
                <div class="card-head">
                    <div class="card-icon">
                        <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
                    </div>
                    <div class="card-title-wrap">
                        <div class="card-title">إعدادات OAuth 2.1 ${statusHtml}</div>
                        <div class="card-subtitle">لربط ChatGPT وأي عميل MCP آخر تلقائيًا</div>
                    </div>
                </div>
            </div>
            <div class="card-error">${ICN.alert} ${escapeHtml(cfg.error || 'تعذّر الاتصال بخدمات OAuth')}</div>
            ${oauthCopyRow('عنوان ربط MCP (استخدمه عند إضافة مدعوم كـ Connector في Claude أو أي عميل MCP)', MCP_CONNECTOR_URL)}
            ${oauthCopyRow('رابط اكتشاف OAuth (Discovery URL)', cfg.discovery_url)}
            ${oauthCopyRow('رابط بيانات المورد المحمي (Protected Resource Metadata URL)', cfg.protected_resource_metadata_url)}
        `;
        return;
    }

    card.innerHTML = `
        <div class="card-row">
            <div class="card-head">
                <div class="card-icon">
                    <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
                </div>
                <div class="card-title-wrap">
                    <div class="card-title">إعدادات OAuth 2.1 (ChatGPT / عملاء MCP) ${statusHtml}</div>
                    <div class="card-subtitle">تُجلب تلقائيًا من الخادم في كل مرة - انسخ أي رابط تحتاجه مباشرة، بدون كتابة يدوية.</div>
                </div>
            </div>
        </div>
        <div style="margin-top:1rem">
            ${oauthCopyRow('عنوان ربط MCP (استخدمه عند إضافة مدعوم كـ Connector في Claude أو أي عميل MCP)', MCP_CONNECTOR_URL)}
            ${oauthCopyRow('Issuer', cfg.issuer)}
            ${oauthCopyRow('رابط التفويض (Authorization URL)', cfg.authorization_endpoint)}
            ${oauthCopyRow('رابط الحصول على التوكن (Token URL)', cfg.token_endpoint)}
            ${oauthCopyRow('رابط تسجيل العملاء تلقائيًا (Registration URL - DCR)', cfg.registration_endpoint)}
            ${oauthCopyRow('رابط اكتشاف OAuth (Discovery URL)', cfg.discovery_url)}
            ${oauthCopyRow('رابط بيانات المورد المحمي (Protected Resource Metadata URL)', cfg.protected_resource_metadata_url)}
        </div>
        <div class="card-meta" style="margin-top:0.25rem">
            <span title="طريقة PKCE المدعومة">${ICN.lock} PKCE المدعوم: ${(cfg.code_challenge_methods_supported || []).join(', ') || '—'}</span>
            <span title="طرق مصادقة عميل التوكن المدعومة">${ICN.key} مصادقة العميل: ${(cfg.token_endpoint_auth_methods_supported || []).join(', ') || '—'}</span>
        </div>
    `;
}

function renderMcpServerStatus(info) {
    const card = document.getElementById('mcpServerStatusCard');

    // Capabilities: بيانات-محورة بالكامل - أي مفتاح جديد يُضاف من الباك إند
    // مستقبلاً (resources/prompts/streaming حقيقية) بيتعرض تلقائياً هنا
    // بدون أي تعديل في هذا الملف.
    // 'oauth' مستبعد هنا عمدًا: العلم الثابت القادم من mcp-server-info قديم ولا يعكس التنفيذ
    // الفعلي - الحالة الحقيقية بتتعرض دلوقتي في قسم "إعدادات OAuth" المستقل تحت (loadOAuthConfigSection).
    const capBadges = Object.entries(info.capabilities || {})
        .filter(([k]) => k !== 'oauth')
        .map(([k, v]) => renderCapabilityBadge(k, v)).join(' ');

    const authBadges = (info.authentication_methods || [])
        .map((m) => `<span class="transport-chip">${escapeHtml(authMethodLabel(m))}</span>`).join(' ');

    // Resources معلوماتية فقط - مميّزة بشارة "Info Only" واضحة، ومش جوه capabilities
    const resourcesHtml = (info.resources_info || []).map((r) => `
        <div class="tool-row">
            <div class="tool-info">
                <div class="tool-name">${escapeHtml(r.name)} <span class="disabled-chip" style="background:#e0e7ff;color:#3730a3;">Info Only</span></div>
                <div class="tool-desc">${escapeHtml(r.description)}</div>
            </div>
        </div>`).join('');

    card.innerHTML = `
        <div class="card-row">
            <div class="card-head">
                <div class="card-icon">
                    <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"></rect><rect x="2" y="14" width="20" height="8" rx="2"></rect></svg>
                </div>
                <div class="card-title-wrap">
                    <div class="card-title">
                        ${escapeHtml(info.server_info?.name || 'Mad3oom MCP Server')}
                        <span class="status-chip st-connected"><span class="dot"></span>Online</span>
                    </div>
                    <div class="card-subtitle">Version ${escapeHtml(info.server_info?.version || '—')}</div>
                </div>
            </div>
        </div>
        <div class="card-meta">
            <span title="Endpoint">${ICN.link} <code dir="ltr">${escapeHtml(info.endpoint)}</code>
                <button class="btn btn-secondary btn-copy" style="padding:2px 8px;font-size:0.72rem" onclick="window.mcpCopyText('${escapeHtml(info.endpoint)}')">نسخ</button></span>
            <span title="Protocol Version">${ICN.signal} ${escapeHtml(info.protocol_version)}</span>
            <span title="Transport">${ICN.zap} ${escapeHtml(info.transport)}</span>
        </div>
        <div class="card-meta" style="margin-top:-0.5rem">${authBadges}</div>
        <div class="card-actions" style="border-top:none;flex-wrap:wrap;">${capBadges}</div>
        ${resourcesHtml ? `<div class="tools-list" style="margin-top:1rem">${resourcesHtml}</div>` : ''}
    `;
}

function renderMcpServerTools(tools) {
    const list = document.getElementById('mcpServerToolsList');
    if (!tools.length) { list.innerHTML = `<div class="tools-empty">لا توجد أدوات معرّفة.</div>`; return; }
    list.innerHTML = tools.map((t) => `
        <div class="tool-row">
            <div class="tool-info">
                <div class="tool-name">${escapeHtml(t.name)} <span class="transport-chip">${escapeHtml(t.scope)}</span></div>
                <div class="tool-desc">${escapeHtml(t.description || '—')}</div>
            </div>
            <label class="toggle-switch">
                <input type="checkbox" ${t.enabled ? 'checked' : ''} onchange="window.mcpServerToggleTool('${escapeHtml(t.name)}', this.checked)">
                <span class="toggle-slider"></span>
            </label>
        </div>`).join('');
}

async function handleMcpServerToggleTool(toolName, enabled) {
    try {
        const result = await setMcpServerToolEnabled(toolName, enabled);
        renderMcpServerTools(result.tools || []);
        toast(enabled ? `تم تفعيل "${toolName}" لكل عملاء MCP` : `تم تعطيل "${toolName}" لكل عملاء MCP`, 'success');
    } catch (err) {
        toast(err.message || 'فشل تحديث حالة الأداة', 'error');
        loadMcpServerSection();
    }
}

async function handleTestMcpServer() {
    const btn = document.getElementById('testMcpServerBtn');
    btn.disabled = true; btn.textContent = 'جاري الاختبار...';
    try {
        await fetchMcpServerInfo('test');
        toast('الخادم شغال بشكل صحيح', 'success');
        await loadMcpServerSection();
    } catch (err) {
        toast(err.message || 'فشل الاختبار', 'error');
    } finally {
        btn.disabled = false; btn.textContent = 'اختبار الاتصال';
    }
}

/* ====================  مفاتيح API  ==================== */

function credentialTypeLabel(t) {
    return { api_key_secret: `${ICN.key} API Key + Secret`, bearer: `${ICN.ticket} Bearer Token` }[t] || t;
}

async function loadApiTokensSection() {
    const list = document.getElementById('apiTokensList');
    list.innerHTML = loadingHtml();
    try {
        allApiTokens = await fetchApiTokens();
        renderApiTokens();
        await loadApiUsageLog();
    } catch (err) {
        console.error('[MCP] loadApiTokensSection failed:', err);
        list.innerHTML = errorHtml(err.message);
    }
}

function renderApiTokens() {
    const list = document.getElementById('apiTokensList');
    if (!allApiTokens.length) {
        list.innerHTML = `<div class="state-block empty">
            <h3>لا توجد مفاتيح API بعد</h3>
            <p>ولّد أول مفتاح API للوصول إلى Ticket System وWhatsApp System من أنظمة خارجية.</p>
            <button class="btn btn-primary" onclick="window.mcpAddToken()">+ توليد أول مفتاح</button>
        </div>`;
        return;
    }

    list.innerHTML = allApiTokens.map((t) => {
        const scopesHtml = (t.scopes || []).map((s) => `<span class="transport-chip">${escapeHtml(s)}</span>`).join(' ');
        const keyLine = t.api_key && t.credential_type === 'api_key_secret'
            ? `<span title="API Key">${ICN.key} <code dir="ltr">${escapeHtml(t.api_key)}</code>
                 <button class="btn btn-secondary btn-copy" style="padding:2px 8px;font-size:0.72rem" onclick="window.mcpCopyText('${escapeHtml(t.api_key)}')">نسخ</button></span>`
            : '';
        const secretHint = t.credential_type === 'bearer'
            ? `<span title="آخر 4 خانات">${ICN.ticket} ••••${escapeHtml(t.bearer_last_four || '----')}</span>`
            : `<span title="آخر 4 خانات">${ICN.lock} ••••${escapeHtml(t.secret_last_four || '----')}</span>`;
        const lastUsed = t.last_used_at ? new Date(t.last_used_at).toLocaleString('ar-EG') : 'لم يُستخدم بعد';
        const expiresChip = t.expires_at ? `<span title="ينتهي في">${ICN.hourglass} ${new Date(t.expires_at).toLocaleDateString('ar-EG')}</span>` : '';
        const groupNote = t.credential_group_id ? `<span title="مرتبط بمفتاح آخر ضمن نفس مجموعة الإنشاء">${ICN.link} مجموعة مزدوجة</span>` : '';

        return `
        <div class="mcp-card ${t.is_active ? 'is-connected' : ''}" data-token-id="${t.id}">
            <div class="card-row">
                <div class="card-head">
                    <div class="card-icon">
                        <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3"></path></svg>
                    </div>
                    <div class="card-title-wrap">
                        <div class="card-title">
                            ${escapeHtml(t.name)}
                            <span class="credtype-chip">${credentialTypeLabel(t.credential_type)}</span>
                            ${t.is_active ? '' : '<span class="disabled-chip">معطّل</span>'}
                        </div>
                        <div class="card-subtitle">${escapeHtml(t.description || '—')}</div>
                    </div>
                </div>
                <div class="card-actions-top">${t.is_active ? statusBadge(MCP_STATUSES.CONNECTED) : statusBadge(MCP_STATUSES.DISCONNECTED)}</div>
            </div>
            <div class="card-meta">
                ${keyLine}
                ${secretHint}
                <span title="عدد مرات الاستخدام">${ICN.barChart} ${t.usage_count ?? 0} استدعاء</span>
                <span title="آخر استخدام">${ICN.clock} ${lastUsed}</span>
                ${expiresChip}
                ${groupNote}
                <span title="تاريخ الإنشاء">${ICN.calendar} ${new Date(t.created_at).toLocaleDateString('ar-EG')}</span>
            </div>
            <div class="card-meta" style="margin-top:-0.5rem">${scopesHtml}</div>
            <div class="card-actions">
                <button class="btn btn-test" onclick="window.mcpRegenToken('${t.id}')">
                    <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"></path></svg>
                    تجديد السر
                </button>
                <button class="btn ${t.is_active ? 'btn-disconnect' : 'btn-edit'}" onclick="window.mcpToggleToken('${t.id}', ${t.is_active})">
                    ${t.is_active ? 'تعطيل' : 'تفعيل'}
                </button>
                <button class="btn btn-delete" onclick="window.mcpDeleteToken('${t.id}')">حذف</button>
            </div>
        </div>`;
    }).join('');
}

async function loadApiUsageLog() {
    const container = document.getElementById('apiUsageLogList');
    if (!container) return;
    try {
        const logs = await fetchApiUsageLogs(30);
        if (!logs.length) { container.innerHTML = '<div class="activity-empty">لا يوجد استخدام مسجّل بعد</div>'; return; }
        container.innerHTML = logs.map((l) => `
            <div class="activity-item">
                <span class="activity-tag act-tested">${escapeHtml(l.method || '-')}</span>
                <span class="activity-name">${escapeHtml(l.api_tokens?.name || '—')}</span>
                <span class="activity-msg"><code dir="ltr">${escapeHtml(l.endpoint || '-')}</code> • ${l.status_code ?? '-'}${l.ip_address ? ' • ' + escapeHtml(l.ip_address) : ''}</span>
                <span class="activity-time">${new Date(l.created_at).toLocaleString('ar-EG')}</span>
            </div>`).join('');
    } catch (err) { console.warn('[MCP] usage log failed:', err); }
}

function renderScopesGrid() {
    const grid = document.getElementById('scopesGrid');
    grid.innerHTML = API_TOKEN_ALLOWED_SCOPES.map((s) => `
        <label style="display:flex;align-items:center;gap:0.4rem;font-size:0.82rem;font-weight:600;cursor:pointer">
            <input type="checkbox" class="scope-cb" value="${s}" ${API_TOKEN_DEFAULT_SCOPES.includes(s) ? 'checked' : ''} style="width:16px;height:16px;accent-color:var(--color-accent)">
            ${s}
        </label>`).join('');
}

function openApiTokenModal() {
    document.getElementById('tName').value = '';
    document.getElementById('tDescription').value = '';
    document.getElementById('tExpiresAt').value = '';
    document.querySelector('input[name="credType"][value="api_key_secret"]').checked = true;
    renderScopesGrid();
    document.getElementById('apiTokenFormError').style.display = 'none';
    document.getElementById('apiTokenModal').classList.add('open');
}
function closeApiTokenModal() { document.getElementById('apiTokenModal').classList.remove('open'); }

async function handleCreateApiToken() {
    const name = document.getElementById('tName').value.trim();
    const description = document.getElementById('tDescription').value.trim();
    const credential_type = document.querySelector('input[name="credType"]:checked').value;
    const scopes = Array.from(document.querySelectorAll('.scope-cb:checked')).map((cb) => cb.value);
    const expiresAtRaw = document.getElementById('tExpiresAt').value;
    const errBox = document.getElementById('apiTokenFormError');
    errBox.style.display = 'none';

    if (!name) { errBox.textContent = 'الاسم مطلوب'; errBox.style.display = 'block'; return; }
    if (!scopes.length) { errBox.textContent = 'اختر صلاحية واحدة على الأقل'; errBox.style.display = 'block'; return; }

    const btn = document.getElementById('confirmCreateApiTokenBtn');
    btn.disabled = true; btn.textContent = 'جاري التوليد...';
    try {
        const result = await createApiToken({
            name, description: description || undefined, credential_type, scopes,
            expires_at: expiresAtRaw ? new Date(expiresAtRaw).toISOString() : null,
        });
        closeApiTokenModal();
        showSecretReveal(result);
        toast('تم توليد المفتاح بنجاح', 'success');
        await loadApiTokensSection();
    } catch (err) {
        errBox.textContent = err.message || 'حدث خطأ أثناء التوليد';
        errBox.style.display = 'block';
    } finally {
        btn.disabled = false; btn.textContent = 'توليد';
    }
}

/** result شكله يختلف حسب credential_type - شوف تعليق create-api-token */
function showSecretReveal(result) {
    const box = document.getElementById('secretRevealContent');
    let html = '';

    const row = (label, value) => `
        <div class="form-group full" style="margin-bottom:0.85rem">
            <label>${label}</label>
            <div class="oauth-field-row">
                <input type="text" class="reveal-field" readonly dir="ltr" value="${escapeHtml(value)}">
                <button type="button" class="btn btn-secondary btn-copy" onclick="window.mcpCopyText('${escapeHtml(value)}')">نسخ</button>
            </div>
        </div>`;

    if (result.credential_group_id) {
        html += `<h3>API Key + Secret</h3>${row('API Key', result.api_key_secret.token.api_key)}${row('API Secret', result.api_key_secret.secret)}`;
        html += `<h3 style="margin-top:1rem">Bearer Token</h3>${row('Bearer Token', result.bearer.bearer_token)}`;
    } else if (result.secret) {
        html += row('API Key', result.token.api_key) + row('API Secret', result.secret);
    } else if (result.bearer_token) {
        html += row('Bearer Token', result.bearer_token);
    }

    box.innerHTML = html;
    document.getElementById('apiSecretRevealModal').classList.add('open');
}

async function handleRegenToken(tokenId) {
    if (!confirm('تجديد السر سيُلغي صلاحية السر القديم فورًا. متابعة؟')) return;
    try {
        const result = await regenerateApiTokenSecret(tokenId);
        showSecretReveal(result);
        toast('تم تجديد السر بنجاح', 'success');
        await loadApiTokensSection();
    } catch (err) { toast(err.message || 'فشل التجديد', 'error'); }
}

async function handleToggleToken(tokenId, currentlyActive) {
    try {
        await toggleApiToken(tokenId, currentlyActive);
        toast(currentlyActive ? 'تم تعطيل المفتاح' : 'تم تفعيل المفتاح', 'success');
        await loadApiTokensSection();
    } catch (err) { toast(err.message || 'فشل تحديث الحالة', 'error'); }
}

async function handleDeleteToken(tokenId) {
    if (!confirm('حذف هذا المفتاح نهائيًا؟ لا يمكن التراجع عن هذا الإجراء.')) return;
    try {
        await deleteApiToken(tokenId);
        toast('تم حذف المفتاح', 'success');
        await loadApiTokensSection();
    } catch (err) { toast(err.message || 'فشل الحذف', 'error'); }
}

function copyText(value) {
    navigator.clipboard.writeText(value).then(() => toast('تم النسخ', 'success')).catch(() => toast('تعذّر النسخ', 'error'));
}

/* ====================  External Integrations  ==================== */

async function loadIntegrationsSection() {
    const grid = document.getElementById('integrationsGrid');
    grid.innerHTML = loadingHtml();
    try {
        allIntegrations = await fetchExternalIntegrations();
        renderIntegrations();
        await populateDefaultAiProviderSelect();
    } catch (err) {
        console.error('[MCP] loadIntegrationsSection failed:', err);
        grid.innerHTML = errorHtml(err.message);
    }
}

function renderIntegrations() {
    const grid = document.getElementById('integrationsGrid');
    if (!allIntegrations.length) {
        grid.innerHTML = `<div class="state-block empty">
            <h3>لا توجد تكاملات مضافة بعد</h3>
            <p>أضف مزوّد ذكاء اصطناعي أو بوت تيليجرام أو Webhook لاستخدامه داخل المنصة.</p>
            <button class="btn btn-primary" onclick="window.mcpAddIntegration()">+ إضافة تكامل جديد</button>
        </div>`;
        return;
    }

    // ترتيب العرض حسب priority (الأصغر أولاً) - نفس الترتيب اللي هيستخدمه AI Router مستقبلاً
    const sorted = [...allIntegrations].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

    grid.innerHTML = sorted.map((i) => {
        const testChip = i.last_test_status === 'success' ? '<span class="status-chip st-connected"><span class="dot"></span>آخر اختبار: نجح</span>'
            : i.last_test_status === 'failed' ? '<span class="status-chip st-error"><span class="dot"></span>آخر اختبار: فشل</span>'
            : '<span class="status-chip st-pending"><span class="dot"></span>لم يُختبر بعد</span>';

        const modelChip = i.credentials_meta?.model ? `<span title="الموديل الحالي">${ICN.cpu} <code dir="ltr">${escapeHtml(i.credentials_meta.model)}</code></span>` : '';
        const baseUrlChip = i.credentials_meta?.base_url ? `<span title="Base URL مخصّص">${ICN.globe} <code dir="ltr">${escapeHtml(i.credentials_meta.base_url)}</code></span>` : '';

        return `
        <div class="mcp-card ${i.is_active ? 'is-connected' : ''}" data-integration-id="${i.id}">
            <div class="card-row">
                <div class="card-head">
                    <div class="card-icon">
                        <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"></path></svg>
                    </div>
                    <div class="card-title-wrap">
                        <div class="card-title">${escapeHtml(i.display_name)} ${i.is_active ? '' : '<span class="disabled-chip">معطّل</span>'}</div>
                        <div class="card-subtitle">${INTEGRATION_PROVIDER_LABELS[i.provider] || i.provider}</div>
                    </div>
                </div>
            </div>
            <div class="card-meta">
                ${testChip}
                <span title="الأولوية (الأصغر = أعلى أولوية عند وجود أكثر من مزود)">${ICN.target} أولوية: ${i.priority ?? 100}</span>
                ${modelChip}
                ${baseUrlChip}
            </div>
            ${i.last_test_message ? `<div class="card-meta" style="margin-top:-0.5rem">${escapeHtml(i.last_test_message)}</div>` : ''}
            <div class="card-actions">
                <button class="btn btn-test" onclick="window.mcpTestIntegration('${i.id}')">اختبار الاتصال</button>
                <button class="btn btn-edit" onclick="window.mcpEditIntegration('${i.id}')">تعديل</button>
                <button class="btn ${i.is_active ? 'btn-disconnect' : 'btn-edit'}" onclick="window.mcpToggleIntegration('${i.id}', ${i.is_active})">${i.is_active ? 'تعطيل' : 'تفعيل'}</button>
                <button class="btn btn-delete" onclick="window.mcpDeleteIntegration('${i.id}')">حذف</button>
            </div>
        </div>`;
    }).join('');
}

async function populateDefaultAiProviderSelect() {
    const select = document.getElementById('defaultAiProviderSelect');
    const activeAi = allIntegrations.filter((i) => AI_INTEGRATION_PROVIDERS.includes(i.provider) && i.is_active);
    select.innerHTML = '<option value="">— بدون (الرد الآلي البسيط فقط) —</option>' +
        activeAi.map((i) => `<option value="${i.id}">${escapeHtml(i.display_name)} (${INTEGRATION_PROVIDER_LABELS[i.provider]})</option>`).join('');
    try {
        const current = await fetchDefaultAiProvider();
        if (current) select.value = current;
    } catch (err) { console.warn('[MCP] fetchDefaultAiProvider failed:', err); }
}

/**
 * فورم بيانات الاعتماد الديناميكي + (جديد) Base URL اختياري للمزودين المتوافقين
 * مع OpenAI + اختيار الموديل: قائمة تُجلب تلقائيًا من الموديلات المكتشفة (external_integration_models)
 * لو فيه integrationId، مع fallback دايمًا لإدخال يدوي (زر "إدخال يدوي" / "رجوع لقائمة الموديلات").
 */
function renderIntegrationCredentialFields(provider, prefillMeta = {}, integrationId = null) {
    const container = document.getElementById('integrationCredentialFields');
    const fields = INTEGRATION_CREDENTIAL_FIELDS[provider] || [];

    let html = fields.map((f) => `
        <div class="form-group full">
            <label>${f.label}</label>
            <input type="${f.type}" id="cred-${f.key}" placeholder="${f.placeholder}" dir="ltr">
        </div>`).join('') + (fields.length ? `<span class="hint">اترك الحقل فارغًا عند التعديل للإبقاء على القيمة الحالية.</span>` : '');

    if (OPENAI_COMPATIBLE_PROVIDERS.includes(provider)) {
        html += `
            <div class="form-group full">
                <label>Base URL (اختياري - لاستضافة ذاتية أو بروكسي متوافق مع OpenAI)</label>
                <input type="text" id="cred-meta-base-url" placeholder="https://api.example.com/v1" dir="ltr" value="${escapeHtml(prefillMeta.base_url || '')}">
                <span class="hint">اتركه فارغًا لاستخدام الرابط الرسمي للمزود.</span>
            </div>`;
    }

    if (AI_INTEGRATION_PROVIDERS.includes(provider)) {
        html += `
            <div class="form-group full">
                <label>
                    الموديل (اختياري)
                    <button type="button" id="modelManualToggleBtn" class="btn btn-secondary btn-copy" style="margin-inline-start:0.5rem; display:none; padding:0.2rem 0.6rem; font-size:0.72rem;">إدخال يدوي</button>
                </label>
                <select id="cred-meta-model-select" style="display:none"></select>
                <input type="text" id="cred-meta-model" placeholder="مثال: gpt-4o-mini" value="${escapeHtml(prefillMeta.model || '')}">
                <span class="hint" id="cred-meta-model-hint">${integrationId ? 'جاري تحميل الموديلات المكتشفة...' : 'هيظهر اختيار تلقائي للموديلات بعد أول اختبار اتصال ناجح لهذا التكامل.'}</span>
            </div>`;
    }

    container.innerHTML = html;

    if (AI_INTEGRATION_PROVIDERS.includes(provider) && integrationId) {
        loadModelChoicesForIntegration(integrationId, prefillMeta.model || '');
    }
}

/** يجلب الموديلات المكتشفة (external_integration_models) ويحوّل الحقل لقائمة اختيار مع فallback يدوي */
async function loadModelChoicesForIntegration(integrationId, currentModel) {
    const select = document.getElementById('cred-meta-model-select');
    const manualInput = document.getElementById('cred-meta-model');
    const hint = document.getElementById('cred-meta-model-hint');
    const toggleBtn = document.getElementById('modelManualToggleBtn');
    if (!select || !manualInput || !hint) return;

    try {
        const models = await fetchIntegrationModels(integrationId);
        if (!models.length) {
            hint.textContent = 'مفيش موديلات مكتشفة بعد - اعمل "اختبار الاتصال" أولاً لجلبها تلقائيًا، أو اكتب اسم الموديل يدويًا.';
            return;
        }

        select.innerHTML = '<option value="">— اختر من الموديلات المكتشفة —</option>' + models.map((m) => {
            const badges = [
                m.supports_vision ? `${ICN.eye} Vision` : '',
                m.supports_tools ? `${ICN.tools} Tools` : '',
                m.supports_streaming ? `${ICN.zap} Streaming` : '',
            ].filter(Boolean).join(' • ');
            const selected = m.model_id === currentModel ? 'selected' : '';
            return `<option value="${escapeHtml(m.model_id)}" ${selected}>${escapeHtml(m.display_name || m.model_id)}${badges ? ' — ' + badges : ''}</option>`;
        }).join('');

        const foundCurrent = models.some((m) => m.model_id === currentModel);
        select.style.display = 'block';
        manualInput.style.display = 'none';
        toggleBtn.style.display = 'inline-flex';
        toggleBtn.textContent = 'إدخال يدوي';
        hint.textContent = 'القائمة مبنية على الموديلات المكتشفة فعليًا من آخر اختبار اتصال ناجح.';
        if (foundCurrent) manualInput.value = currentModel;

        select.addEventListener('change', () => { manualInput.value = select.value; });

        toggleBtn.addEventListener('click', () => {
            const usingManual = manualInput.style.display !== 'none';
            if (usingManual) {
                manualInput.style.display = 'none';
                select.style.display = 'block';
                toggleBtn.textContent = 'إدخال يدوي';
            } else {
                manualInput.style.display = 'block';
                select.style.display = 'none';
                toggleBtn.textContent = 'رجوع لقائمة الموديلات المكتشفة';
            }
        });
    } catch (err) {
        console.warn('[MCP] loadModelChoicesForIntegration failed:', err);
        hint.textContent = 'تعذّر تحميل قائمة الموديلات - تقدر تكتب اسم الموديل يدويًا.';
    }
}

function openAddIntegrationModal() {
    document.getElementById('integrationModalTitle').textContent = 'إضافة تكامل جديد';
    document.getElementById('editIntegrationId').value = '';
    document.getElementById('integrationProvider').value = 'openai';
    document.getElementById('integrationProvider').disabled = false;
    document.getElementById('integrationDisplayName').value = '';
    document.getElementById('integrationPriority').value = 100;
    document.getElementById('integrationIsActive').checked = true;
    document.getElementById('integrationFormError').style.display = 'none';
    renderIntegrationCredentialFields('openai');
    document.getElementById('integrationModal').classList.add('open');
}

function openEditIntegrationModal(id) {
    const integ = allIntegrations.find((i) => i.id === id);
    if (!integ) return;
    document.getElementById('integrationModalTitle').textContent = 'تعديل التكامل';
    document.getElementById('editIntegrationId').value = integ.id;
    document.getElementById('integrationProvider').value = integ.provider;
    document.getElementById('integrationProvider').disabled = true;
    document.getElementById('integrationDisplayName').value = integ.display_name;
    document.getElementById('integrationPriority').value = integ.priority ?? 100;
    document.getElementById('integrationIsActive').checked = integ.is_active;
    document.getElementById('integrationFormError').style.display = 'none';
    renderIntegrationCredentialFields(integ.provider, integ.credentials_meta || {}, integ.id);
    document.getElementById('integrationModal').classList.add('open');
}

function closeIntegrationModal() { document.getElementById('integrationModal').classList.remove('open'); }

async function handleSaveIntegration() {
    const id = document.getElementById('editIntegrationId').value || undefined;
    const provider = document.getElementById('integrationProvider').value;
    const display_name = document.getElementById('integrationDisplayName').value.trim();
    const is_active = document.getElementById('integrationIsActive').checked;
    const priorityRaw = document.getElementById('integrationPriority').value;
    const priority = priorityRaw !== '' ? Number(priorityRaw) : undefined;
    const errBox = document.getElementById('integrationFormError');
    errBox.style.display = 'none';

    if (!display_name) { errBox.textContent = 'اسم العرض مطلوب'; errBox.style.display = 'block'; return; }
    if (priority !== undefined && !Number.isFinite(priority)) { errBox.textContent = 'الأولوية لازم تكون رقم'; errBox.style.display = 'block'; return; }

    const fields = INTEGRATION_CREDENTIAL_FIELDS[provider] || [];
    const credentials = {};
    let hasAnyCred = false;
    fields.forEach((f) => {
        const el = document.getElementById(`cred-${f.key}`);
        if (el && el.value.trim()) { credentials[f.key] = el.value.trim(); hasAnyCred = true; }
    });

    if (!id && !hasAnyCred && provider !== 'custom') {
        errBox.textContent = 'بيانات الاعتماد مطلوبة عند إنشاء تكامل جديد';
        errBox.style.display = 'block';
        return;
    }

    const credentials_meta = {};
    const modelInput = document.getElementById('cred-meta-model');
    if (modelInput && modelInput.value.trim()) credentials_meta.model = modelInput.value.trim();
    const baseUrlInput = document.getElementById('cred-meta-base-url');
    if (baseUrlInput && baseUrlInput.value.trim()) credentials_meta.base_url = baseUrlInput.value.trim();

    const btn = document.getElementById('saveIntegrationBtn');
    btn.disabled = true; btn.textContent = 'جاري الحفظ...';
    try {
        await saveExternalIntegration({
            id, provider, display_name, is_active, priority,
            credentials: hasAnyCred ? credentials : undefined,
            credentials_meta,
        });
        closeIntegrationModal();
        toast(id ? 'تم تحديث التكامل' : 'تم إضافة التكامل بنجاح', 'success');
        await loadIntegrationsSection();
    } catch (err) {
        errBox.textContent = err.message || 'حدث خطأ أثناء الحفظ';
        errBox.style.display = 'block';
    } finally {
        btn.disabled = false; btn.textContent = 'حفظ';
    }
}

async function handleToggleIntegration(id, currentlyActive) {
    try {
        await saveExternalIntegration({ id, is_active: !currentlyActive });
        toast(currentlyActive ? 'تم تعطيل التكامل' : 'تم تفعيل التكامل', 'success');
        await loadIntegrationsSection();
    } catch (err) { toast(err.message || 'فشل تحديث الحالة', 'error'); }
}

async function handleDeleteIntegration(id) {
    if (!confirm('حذف هذا التكامل نهائيًا؟ أي ميزة تعتمد عليه (مثل رد الذكاء الاصطناعي) ستتوقف.')) return;
    try {
        await deleteExternalIntegration(id);
        toast('تم حذف التكامل', 'success');
        await loadIntegrationsSection();
    } catch (err) { toast(err.message || 'فشل الحذف', 'error'); }
}

async function handleTestIntegration(id) {
    try {
        toast('جاري اختبار الاتصال...', 'info');
        const result = await testExternalIntegration(id);
        const modelsNote = Array.isArray(result.models) && result.models.length ? ` • تم اكتشاف ${result.models.length} موديل` : '';
        toast((result.message || '') + modelsNote, result.success ? 'success' : 'error');
        await loadIntegrationsSection();
    } catch (err) { toast(err.message || 'فشل الاختبار', 'error'); }
}

async function handleSaveDefaultAiProvider() {
    const value = document.getElementById('defaultAiProviderSelect').value;
    try {
        await saveDefaultAiProvider(value);
        toast('تم حفظ المزود الافتراضي للذكاء الاصطناعي', 'success');
    } catch (err) { toast(err.message || 'فشل الحفظ', 'error'); }
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
        window.mcpServerToggleTool = handleMcpServerToggleTool;

    window.mcpOnTransportChange = onTransportChange;
    window.mcpOnAuthTypeChange = onAuthTypeChange;
    window.mcpConnectOAuth = handleConnectOAuth;
    window.mcpCopyRedirectUri = copyRedirectUri;
    window.mcpOpenTools = openToolsModal;
    window.mcpCloseToolsModal = closeToolsModal;
    window.mcpToggleTool = handleToggleTool;
    window.mcpSyncTools = handleSyncTools;

    // مفاتيح API
    window.mcpAddToken = openApiTokenModal;
    window.mcpRegenToken = handleRegenToken;
    window.mcpToggleToken = handleToggleToken;
    window.mcpDeleteToken = handleDeleteToken;
    window.mcpCopyText = copyText;

    // External Integrations
    window.mcpAddIntegration = openAddIntegrationModal;
    window.mcpEditIntegration = openEditIntegrationModal;
    window.mcpToggleIntegration = handleToggleIntegration;
    window.mcpDeleteIntegration = handleDeleteIntegration;
    window.mcpTestIntegration = handleTestIntegration;

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
    document.getElementById('testMcpServerBtn')
    .addEventListener('click', handleTestMcpServer);
    document.getElementById('toolsSearchInput').addEventListener('input', debounce((e) => {
        toolsSearchQuery = e.target.value;
        renderToolsModal();
    }, 250));

    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); closeToolsModal(); closeApiTokenModal(); closeIntegrationModal(); } });

    // تبويب Developer Center
    document.getElementById('devTabMcpClient').addEventListener('click', () => switchDevTab('mcpclient'));
    document.getElementById('devTabServers').addEventListener('click', () => switchDevTab('servers'));
    document.getElementById('devTabMcpServer').addEventListener('click', () => switchDevTab('mcpserver'));
    document.getElementById('devTabApiTokens').addEventListener('click', () => switchDevTab('apitokens'));
    document.getElementById('devTabIntegrations').addEventListener('click', () => switchDevTab('integrations'));

    // MCP Client Marketplace - أحداث البحث والتصنيفات ومستكشف الأدوات
    document.getElementById('mcpMarketSearch').addEventListener('input', debounce((e) => {
        mcpMarketSearchQuery = e.target.value;
        renderConnectorGrid();
    }, 250));
    document.getElementById('explorerSearchInput').addEventListener('input', debounce((e) => {
        explorerSearchQuery = e.target.value;
        renderToolExplorer();
    }, 250));


    // مفاتيح API - أحداث
    document.getElementById('addTokenBtn').addEventListener('click', openApiTokenModal);
    document.getElementById('refreshTokensBtn').addEventListener('click', loadApiTokensSection);
    document.getElementById('cancelApiTokenBtn').addEventListener('click', closeApiTokenModal);
    document.getElementById('apiTokenModalClose').addEventListener('click', closeApiTokenModal);
    document.getElementById('confirmCreateApiTokenBtn').addEventListener('click', handleCreateApiToken);
    document.getElementById('closeSecretRevealBtn').addEventListener('click', () => {
        document.getElementById('apiSecretRevealModal').classList.remove('open');
        document.getElementById('secretRevealContent').innerHTML = '';
    });
    document.getElementById('apiTokenModal').addEventListener('click', (e) => { if (e.target.id === 'apiTokenModal') closeApiTokenModal(); });

    // External Integrations - أحداث
    document.getElementById('addIntegrationBtn').addEventListener('click', openAddIntegrationModal);
    document.getElementById('refreshIntegrationsBtn').addEventListener('click', loadIntegrationsSection);
    document.getElementById('cancelIntegrationBtn').addEventListener('click', closeIntegrationModal);
    document.getElementById('integrationModalClose').addEventListener('click', closeIntegrationModal);
    document.getElementById('saveIntegrationBtn').addEventListener('click', handleSaveIntegration);
    document.getElementById('integrationProvider').addEventListener('change', (e) => renderIntegrationCredentialFields(e.target.value));
    document.getElementById('defaultAiProviderSelect').addEventListener('change', handleSaveDefaultAiProvider);
    document.getElementById('integrationModal').addEventListener('click', (e) => { if (e.target.id === 'integrationModal') closeIntegrationModal(); });

    handleOauthReturn();
    await loadServers();
    mcpClientMarketLoadedOnce = true;
    await loadMcpClientMarketplace();
});
