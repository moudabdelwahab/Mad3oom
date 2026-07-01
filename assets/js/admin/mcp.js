
/**
 * MCP Page Logic - منطق صفحة إدارة خوادم MCP
 * --------------------------------------------------------
 * يربط الواجهة (admin/mcp.html) بخدمة mcp-service.js.
 * يلتزم بنمط بقية صفحات الإدارة: تهيئة السايدبار + المصادقة،
 * وتعريض الإجراءات على window لاستدعائها من معالجات HTML.
 */
 
import { initSidebar } from '/assets/js/admin/sidebar.js';
import { checkAdminAuth, updateAdminUI } from '/assets/js/admin/auth.js';
import {
    fetchServers,
    createServer,
    updateServer,
    deleteServer,
    testServer,
    disconnectServer,
    fetchStats,
    fetchMcpActivity,
    MCP_STATUSES,
    MCP_TRANSPORTS,
} from '/mcp-service.js';
 
let allServers = [];
let editingId = null;
 
/* ====================  العرض  ==================== */
 
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
 
function transportLabel(t) {
    return { stdio: 'stdio', sse: 'SSE', streamable_http: 'HTTP' }[t] || t;
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
 
    if (!servers.length) {
        container.innerHTML = emptyHtml();
        return;
    }
 
    container.innerHTML = servers
        .map((s) => {
            const toolCount = Array.isArray(s.tools) ? s.tools.length : 0;
            const lastChecked = s.last_checked_at
                ? new Date(s.last_checked_at).toLocaleString('ar-EG')
                : 'لم يُختبر بعد';
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
                                ${s.enabled ? '' : '<span class="disabled-chip">معطّل</span>'}
                            </div>
                            <div class="card-subtitle">${escapeHtml(s.description || '—')}</div>
                        </div>
                    </div>
                    <div class="card-actions-top">
                        ${statusBadge(s.status)}
                    </div>
                </div>
 
                <div class="card-meta">
                    ${s.url ? `<span title="عنوان الخادم">🔗 <code dir="ltr">${escapeHtml(s.url)}</code></span>` : ''}
                    ${s.command ? `<span title="أمر التشغيل">⚙️ <code dir="ltr">${escapeHtml(s.command)}</code></span>` : ''}
                    <span title="عدد الأدوات المسجّلة">🛠️ ${toolCount} أداة</span>
                    <span title="آخر فحص">🕒 ${lastChecked}</span>
                    ${s.category ? `<span title="التصنيف">🏷️ ${escapeHtml(s.category)}</span>` : ''}
                </div>
 
                <div class="card-actions">
                    <button class="btn btn-test" onclick="window.mcpTest('${s.id}')" ${s.status === MCP_STATUSES.CONNECTED ? 'disabled' : ''}>
                        <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>
                        اختبار الاتصال
                    </button>
                    <button class="btn btn-edit" onclick="window.mcpEdit('${s.id}')">
                        <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                        تعديل
                    </button>
                    ${s.status === MCP_STATUSES.CONNECTED
                        ? `<button class="btn btn-disconnect" onclick="window.mcpDisconnect('${s.id}')">فصل</button>`
                        : ''}
                    <button class="btn btn-delete" onclick="window.mcpDelete('${s.id}')">
                        <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                        حذف
                    </button>
                </div>
            </div>`;
        })
        .join('');
}
 
/* ====================  الإحصائيات والنشاط  ==================== */
 
async function loadStats() {
    try {
        const s = await fetchStats();
        setText('statTotal', s.total);
        setText('statConnected', s.connected);
        setText('statError', s.error);
        setText('statTools', s.tools);
    } catch (e) {
        console.warn('[MCP] stats failed:', e);
    }
}
 
async function loadActivity() {
    const container = document.getElementById('activityList');
    if (!container) return;
    try {
        const log = await fetchMcpActivity(8);
        if (!log.length) {
            container.innerHTML =
                '<div class="activity-empty">لا يوجد نشاط مسجّل بعد</div>';
            return;
        }
        container.innerHTML = log
            .map((a) => {
                const map = {
                    created: { label: 'إضافة', cls: 'act-created' },
                    updated: { label: 'تعديل', cls: 'act-updated' },
                    deleted: { label: 'حذف', cls: 'act-deleted' },
                    connected: { label: 'اتصال ناجح', cls: 'act-connected' },
                    disconnected: { label: 'فصل', cls: 'act-disconnected' },
                    error: { label: 'خطأ', cls: 'act-error' },
                    tested: { label: 'اختبار', cls: 'act-tested' },
                };
                const info = map[a.action] || { label: a.action, cls: '' };
                return `
                <div class="activity-item">
                    <span class="activity-tag ${info.cls}">${info.label}</span>
                    <span class="activity-name">${escapeHtml(a.details?.name || '—')}</span>
                    ${a.details?.message ? `<span class="activity-msg">${escapeHtml(a.details.message)}</span>` : ''}
                    <span class="activity-time">${new Date(a.created_at).toLocaleString('ar-EG')}</span>
                </div>`;
            })
            .join('');
    } catch (e) {
        console.warn('[MCP] activity failed:', e);
    }
}
 
/* ====================  النماذج (إضافة / تعديل)  ==================== */
 
function openModal(id = null) {
    editingId = id;
    const modal = document.getElementById('mcpModal');
    const title = document.getElementById('modalTitle');
    const form = document.getElementById('mcpForm');
    form.reset();
    clearError();
 
    if (id) {
        title.textContent = 'تعديل خادم MCP';
        const server = allServers.find((s) => s.id === id);
        if (server) fillForm(server);
    } else {
        title.textContent = 'إضافة خادم MCP جديد';
        // افتراضيات مناسبة
        document.getElementById('fTransport').value = 'streamable_http';
        document.getElementById('fEnabled').checked = true;
    }
 
    onTransportChange();
    modal.classList.add('open');
}
 
function closeModal() {
    document.getElementById('mcpModal').classList.remove('open');
    editingId = null;
}
 
function fillForm(s) {
    setValue('fName', s.name);
    setValue('fTransport', s.transport);
    setValue('fUrl', s.url || '');
    setValue('fCommand', s.command || '');
    setValue('fArgs', Array.isArray(s.args) ? s.args.join(' ') : '');
    setValue('fEnv', s.env ? JSON.stringify(s.env, null, 2) : '');
    setValue('fHeaders', s.headers ? JSON.stringify(s.headers, null, 2) : '');
    setValue('fApiKey', ''); // لا نملأ المفتاح للحرص الأمني
    setValue('fDescription', s.description || '');
    setValue('fCategory', s.category || 'general');
    document.getElementById('fEnabled').checked = s.enabled !== false;
}
 
function collectForm() {
    return {
        name: document.getElementById('fName').value,
        transport: document.getElementById('fTransport').value,
        url: document.getElementById('fUrl').value,
        command: document.getElementById('fCommand').value,
        args: document.getElementById('fArgs').value,
        env: document.getElementById('fEnv').value,
        headers: document.getElementById('fHeaders').value,
        api_key: document.getElementById('fApiKey').value,
        description: document.getElementById('fDescription').value,
        category: document.getElementById('fCategory').value,
        enabled: document.getElementById('fEnabled').checked,
    };
}
 
async function submitForm() {
    clearError();
    const btn = document.getElementById('saveBtn');
    btn.disabled = true;
    btn.textContent = 'جاري الحفظ...';
 
    try {
        const payload = collectForm();
        if (editingId) {
            await updateServer(editingId, payload);
            toast('تم تحديث الخادم بنجاح', 'success');
        } else {
            await createServer(payload);
            toast('تمت إضافة الخادم بنجاح', 'success');
        }
        closeModal();
        await loadServers();
    } catch (err) {
        showError(err.message || 'حدث خطأ أثناء الحفظ');
    } finally {
        btn.disabled = false;
        btn.textContent = 'حفظ الخادم';
    }
}
 
function onTransportChange() {
    const t = document.getElementById('fTransport').value;
    const httpFields = document.getElementById('httpFields');
    const stdioFields = document.getElementById('stdioFields');
    httpFields.style.display = t === 'stdio' ? 'none' : 'block';
    stdioFields.style.display = t === 'stdio' ? 'block' : 'none';
}
 
/* ====================  الإجراءات المعروضة على window  ==================== */
 
async function handleTest(id) {
    const card = document.querySelector(`.mcp-card[data-id="${id}"]`);
    if (card) card.classList.add('testing');
    try {
        toast('جاري اختبار الاتصال...', 'info');
        const result = await testServer(id);
        if (result.ok) {
            toast(`${result.message} • زمن الاستجابة ${result.latency ?? '—'} مللي ثانية`, 'success');
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
    const name = server?.name || '';
    if (!confirm(`هل أنت متأكد من حذف خادم "${name}"؟ لا يمكن التراجع عن هذا الإجراء.`)) return;
    try {
        await deleteServer(id);
        toast('تم حذف الخادم', 'success');
        await loadServers();
    } catch (err) {
        toast(err.message || 'فشل الحذف', 'error');
    }
}
 
async function handleDisconnect(id) {
    try {
        await disconnectServer(id);
        toast('تم فصل الخادم', 'success');
        await loadServers();
    } catch (err) {
        toast(err.message || 'فشل الفصل', 'error');
    }
}
 
/* ====================  مساعدات الواجهة  ==================== */
 
function loadingHtml() {
    return `<div class="state-block"><div class="spinner"></div><p>جاري تحميل خوادم MCP...</p></div>`;
}
 
function emptyHtml() {
    return `
    <div class="state-block empty">
        <svg viewBox="0 0 24 24" width="56" height="56" stroke="var(--color-text-secondary)" stroke-width="1" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg>
        <h3>لا توجد خوادم MCP مضافة</h3>
        <p>ابدأ بربط أول خادم Model Context Protocol للاستفادة من أدواته داخل المنصة.</p>
        <button class="btn btn-primary" onclick="window.mcpAdd()">+ إضافة أول خادم</button>
    </div>`;
}
 
function errorHtml(message) {
    return `
    <div class="state-block error">
        <svg viewBox="0 0 24 24" width="48" height="48" stroke="var(--color-danger)" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
        <h3>تعذّر تحميل البيانات</h3>
        <p>${escapeHtml(message)}</p>
        <button class="btn btn-primary" onclick="window.mcpReload()">إعادة المحاولة</button>
    </div>`;
}
 
function toast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `<span>${escapeHtml(message)}</span>`;
    container.appendChild(el);
    // Animation entry
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
        el.classList.remove('show');
        setTimeout(() => el.remove(), 300);
    }, 4000);
}
 
function showError(msg) {
    const box = document.getElementById('formError');
    box.textContent = msg;
    box.style.display = 'block';
}
 
function clearError() {
    const box = document.getElementById('formError');
    box.textContent = '';
    box.style.display = 'none';
}
 
function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
 
function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}
function setValue(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val ?? '';
}
 
function debounce(fn, wait = 350) {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), wait);
    };
}
 
/* ====================  التهيئة  ==================== */
 
document.addEventListener('DOMContentLoaded', async () => {
    // المصادقة + السايدبار أولاً
    const user = await checkAdminAuth();
    if (user) updateAdminUI(user);
    initSidebar();
 
    // تعريض الإجراءات على window
    window.mcpAdd = () => openModal();
    window.mcpEdit = (id) => openModal(id);
    window.mcpDelete = handleDelete;
    window.mcpTest = handleTest;
    window.mcpDisconnect = handleDisconnect;
    window.mcpReload = loadServers;
    window.mcpCloseModal = closeModal;
    window.mcpSubmit = submitForm;
    window.mcpOnTransportChange = onTransportChange;
 
    // ربط أحداث الواجهة
    document.getElementById('addBtn').addEventListener('click', () => openModal());
    document.getElementById('refreshBtn').addEventListener('click', loadServers);
    document.getElementById('saveBtn').addEventListener('click', submitForm);
 
    document.getElementById('filterStatus').addEventListener('change', loadServers);
    document.getElementById('filterTransport').addEventListener('change', loadServers);
    document.getElementById('searchInput').addEventListener('input', debounce(loadServers, 400));
 
    document.getElementById('fTransport').addEventListener('change', onTransportChange);
 
    // إغلاق المودال بالنقر خارجه أو زر الإغلاق
    document.getElementById('mcpModal').addEventListener('click', (e) => {
        if (e.target.id === 'mcpModal') closeModal();
    });
    document.getElementById('modalClose').addEventListener('click', closeModal);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeModal();
    });
 
    await loadServers();
});
