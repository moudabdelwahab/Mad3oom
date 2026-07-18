/**
 * Agent Admin Page Logic
 * --------------------------------------------------------
 * منطق صفحة /admin/agent.html (إدارة وكلاء الذكاء الاصطناعي).
 * كل عمليات القراءة/الكتابة تمر عبر agent-service.js (والتي بدورها
 * تستدعي Edge Function باسم agent-manager، مع سقوط تلقائي على
 * تخزين محلي لو الدالة لسه غير منشورة على السيرفر).
 *
 * ===================== إصلاحات هذه المراجعة =====================
 * - last_error المخزّن في ai_agents لم يكن يظهر في أي مكان بالواجهة رغم أن
 *   agent-manager يحفظه فعليًا عند فشل start/stop/restart. أضفنا عرضه في
 *   كرت الوكيل (لما تكون الحالة "خطأ") وفي تبويب "الحالة والأداء".
 * - إضافة حقل health_check_interval (عمود موجود في القاعدة لم يكن له أي
 *   عنصر إدخال في الواجهة، فكان دائمًا يأخذ القيمة الافتراضية 30 فقط).
 */

import {
    callAgentManager, isUsingLocalFallback,
    AGENT_RESOURCES, AGENT_PERMISSIONS, AGENT_STATUS_LABELS,
} from '/agent-service.js';

let agentsCache = [];
let currentAgentId = null; // null = إنشاء وكيل جديد
let envVars = []; // {key, value, is_secret}
let initialized = false;

export async function initAgentAdminPage() {
    if (initialized) { loadAgents(); return; } // إعادة تحميل فقط لو استُدعيت مرة تانية
    initialized = true;

    bindStaticEvents();

    const usingLocal = await isUsingLocalFallback();
    if (usingLocal) {
        document.getElementById('backendNotice').style.display = 'flex';
    }

    loadAgents();
}

/* ================= تحميل وعرض الوكلاء ================= */
async function loadAgents() {
    try {
        const result = await callAgentManager('list');
        agentsCache = result.agents || [];
        renderAgents();
        renderDashboardStats();
    } catch (err) {
        toast(err.message, 'error');
        agentsCache = [];
        renderAgents();
    }
}

function renderDashboardStats() {
    const total = agentsCache.length;
    const active = agentsCache.filter(a => a.status === 'running').length;
    const stopped = agentsCache.filter(a => a.status === 'stopped' || !a.enabled).length;
    const errored = agentsCache.filter(a => a.status === 'error').length;
    document.getElementById('statTotal').textContent = total;
    document.getElementById('statActive').textContent = active;
    document.getElementById('statStopped').textContent = stopped;
    document.getElementById('statSystem').textContent = errored > 0 ? `⚠ ${errored} بحالة خطأ` : (total === 0 ? 'لا يوجد وكلاء' : 'مستقر');
    document.getElementById('statSystem').style.color = errored > 0 ? 'var(--color-danger)' : 'var(--color-success)';
    document.getElementById('statTasks').textContent = '—'; // Runtime metric — تُجمّع لاحقاً من status لكل وكيل نشط
}

function renderAgents(filter = '') {
    const grid = document.getElementById('agentsGrid');
    const list = agentsCache.filter(a => (a.name || '').toLowerCase().includes(filter.toLowerCase()));
    if (list.length === 0) {
        grid.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 9h6v6H9z"/></svg>
        <h3>لا يوجد وكلاء بعد</h3>
        <p>ابدأ بإضافة أول وكيل ذكاء اصطناعي في مدعوم.</p>
      </div>`;
        return;
    }
    grid.innerHTML = list.map(agentCardHTML).join('');
    grid.querySelectorAll('[data-open-agent]').forEach(el => el.addEventListener('click', () => openAgentModal(el.dataset.openAgent)));
    grid.querySelectorAll('[data-quick-act]').forEach(el => el.addEventListener('click', (e) => {
        e.stopPropagation();
        quickAction(el.dataset.quickAct, el.dataset.agentId);
    }));
}

function agentCardHTML(a) {
    const statusClass = a.enabled ? (a.status || 'unknown') : 'disabled';
    const statusLabel = a.enabled ? (AGENT_STATUS_LABELS[a.status] || a.status) : 'معطّل';
    const initial = (a.name || '?').trim().charAt(0).toUpperCase();
    const heartbeat = a.last_heartbeat ? timeAgo(a.last_heartbeat) : '—';
    // إظهار سبب الخطأ لو الوكيل واقف بسببه — last_error كان مخزّناً بدون أي عرض له
    const errorNote = (a.status === 'error' && a.last_error)
        ? `<div class="meta-row" style="color:var(--color-danger);"><span title="${escapeAttr(a.last_error)}">⚠ ${escapeHtml(truncate(a.last_error, 70))}</span></div>`
        : '';
    return `
  <div class="agent-card" data-open-agent="${a.id}">
    <div class="head">
      <div class="agent-id">
        <div class="agent-avatar">${initial}</div>
        <div style="min-width:0">
          <div class="agent-name">${escapeHtml(a.name)}</div>
          <div class="agent-type">${escapeHtml(a.type || '')} ${a.version ? '· v' + escapeHtml(a.version) : ''}</div>
        </div>
      </div>
      <span class="pill ${statusClass}"><span class="dot"></span>${statusLabel}</span>
    </div>
    ${a.description ? `<div class="agent-desc">${escapeHtml(a.description)}</div>` : ''}
    <div class="metrics-row">
      <div class="metric na"><b>—</b><span>CPU</span></div>
      <div class="metric na"><b>—</b><span>RAM</span></div>
      <div class="metric na"><b>—</b><span>Uptime</span></div>
      <div class="metric na"><b>—</b><span>المهام</span></div>
    </div>
    <div class="meta-row"><span>آخر Heartbeat: ${heartbeat}</span></div>
    ${errorNote}
    <div class="card-actions">
      <button class="btn btn-outline btn-sm" data-open-agent="${a.id}">الإعدادات</button>
      <button class="btn btn-outline btn-sm icon-only" data-quick-act="start" data-agent-id="${a.id}" title="تشغيل">▶</button>
      <button class="btn btn-outline btn-sm icon-only" data-quick-act="stop" data-agent-id="${a.id}" title="إيقاف">■</button>
      <button class="btn btn-outline btn-sm icon-only" data-quick-act="restart" data-agent-id="${a.id}" title="إعادة تشغيل">⟳</button>
    </div>
  </div>`;
}

async function quickAction(action, id) {
    try {
        toast('جاري التنفيذ...', 'info');
        const result = await callAgentManager(action, { id });
        if (result.ok === false) throw new Error(result.error || 'فشل الإجراء');
        toast('تم التنفيذ بنجاح', 'success');
        loadAgents();
    } catch (err) {
        toast(err.message, 'error');
    }
}

/* ================= ربط الأحداث الثابتة (مرة واحدة) ================= */
function bindStaticEvents() {
    document.getElementById('btnAddAgent').addEventListener('click', () => openAgentModal(null));
    document.getElementById('modalCloseBtn').addEventListener('click', closeModal);
    document.getElementById('btnCancelModal').addEventListener('click', closeModal);
    document.getElementById('agentModal').addEventListener('click', (e) => { if (e.target.id === 'agentModal') closeModal(); });

    document.getElementById('modalTabs').addEventListener('click', (e) => {
        const btn = e.target.closest('.tab-btn');
        if (!btn) return;
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.querySelector(`.tab-panel[data-panel="${btn.dataset.tab}"]`).classList.add('active');
        if (btn.dataset.tab === 'status' && currentAgentId) refreshLiveStatus();
        if (btn.dataset.tab === 'logs' && currentAgentId) loadLogs();
    });

    document.getElementById('btnAddEnvVar').addEventListener('click', () => {
        envVars.push({ key: '', value: '', is_secret: false });
        renderEnvVars();
    });

    document.getElementById('btnRefreshStatus').addEventListener('click', refreshLiveStatus);
    document.getElementById('btnLoadLogs').addEventListener('click', loadLogs);
    document.getElementById('btnDownloadLogs').addEventListener('click', () => downloadLogsAsFile());

    document.querySelector('.actions-grid')?.addEventListener('click', handleActionTileClick);
    document.getElementById('btnSaveAgent').addEventListener('click', handleSaveAgent);
    document.getElementById('searchInput').addEventListener('input', (e) => renderAgents(e.target.value));
}

/* ================= المودال: فتح/إغلاق ================= */
function closeModal() {
    document.getElementById('agentModal').classList.remove('open');
}

function openAgentModal(agentId) {
    currentAgentId = agentId;
    const isEdit = !!agentId;
    document.getElementById('modalTitle').textContent = isEdit ? 'إعدادات الوكيل' : 'إضافة وكيل جديد';
    document.querySelectorAll('.edit-only').forEach(el => el.style.display = isEdit ? '' : 'none');
    document.querySelectorAll('.tab-btn')[0].click(); // ارجع دايماً لأول تاب

    const agent = isEdit ? agentsCache.find(a => a.id === agentId) : null;

    document.getElementById('fName').value = agent?.name || '';
    document.getElementById('fSlug').value = agent?.slug || '';
    document.getElementById('fSlug').disabled = isEdit; // الـ slug ثابت بعد الإنشاء
    document.getElementById('fDescription').value = agent?.description || '';
    document.getElementById('fType').value = agent?.type || '';
    document.getElementById('fVersion').value = agent?.version || '';
    document.getElementById('fStatusReadonly').value = agent ? (AGENT_STATUS_LABELS[agent.status] || agent.status) : 'لم يُنشأ بعد';
    document.getElementById('fEnabled').checked = agent ? !!agent.enabled : true;
    document.getElementById('fAutoStart').checked = !!agent?.auto_start;
    document.getElementById('fAutoRestart').checked = !!agent?.auto_restart;

    document.getElementById('fConnectionType').value = agent?.connection_type || 'http';
    document.getElementById('fProtocol').value = agent?.protocol || '';
    document.getElementById('fPort').value = agent?.port ?? '';
    document.getElementById('fHost').value = agent?.host || '';
    document.getElementById('fEndpoint').value = agent?.endpoint || '';
    document.getElementById('fHealthEndpoint').value = agent?.health_endpoint || '';
    document.getElementById('fApiKey').value = '';
    document.getElementById('fApiKey').placeholder = agent?.api_key_last4 ? `•••• ${agent.api_key_last4} — اتركه فارغاً للإبقاء عليه` : 'اتركه فارغاً إن لم تحتج مفتاح API';
    document.getElementById('fTimeout').value = agent?.timeout_ms ?? 10000;
    document.getElementById('fRetryCount').value = agent?.retry_count ?? 3;
    document.getElementById('fRetryDelay').value = agent?.retry_delay_ms ?? 2000;
    document.getElementById('fHealthCheckInterval').value = agent?.health_check_interval ?? 30;

    document.getElementById('fExecutable').value = agent?.executable || '';
    document.getElementById('fWorkingDir').value = agent?.working_directory || '';
    document.getElementById('fCmdStart').value = agent?.command_start || '';
    document.getElementById('fCmdStop').value = agent?.command_stop || '';
    document.getElementById('fCmdRestart').value = agent?.command_restart || '';

    renderCheckboxGrid('resourcesGrid', AGENT_RESOURCES, agent?.resources || []);
    renderCheckboxGrid('permissionsGrid', AGENT_PERMISSIONS, agent?.permissions || []);

    envVars = Array.isArray(agent?.environment_variables) ? JSON.parse(JSON.stringify(agent.environment_variables)) : [];
    renderEnvVars();

    // تصفير تابات الحالة/السجلات
    document.getElementById('logsBox').innerHTML = `<div class="log-line info"><span class="ts">—</span><span class="lvl">INFO</span><span>اضغط "تحديث" لجلب السجلات من الوكيل.</span></div>`;
    ['mCpu', 'mRam', 'mUptime', 'mQueue', 'mLatency', 'mHeartbeat'].forEach(id => document.getElementById(id).textContent = '—');
    renderLastErrorNote(agent?.last_error || null);

    document.getElementById('agentModal').classList.add('open');
}

// [إضافة] عرض last_error في تبويب "الحالة والأداء" — كان مخزّناً في القاعدة
// بدون أي مكان يعرضه للمستخدم، فما كانش في طريقة لمعرفة سبب فشل وكيل متوقّف بخطأ.
function renderLastErrorNote(lastError) {
    const container = document.getElementById('liveMetricsGrid');
    const existing = document.getElementById('lastErrorNote');
    if (existing) existing.remove();
    if (!lastError) return;
    const note = document.createElement('p');
    note.id = 'lastErrorNote';
    note.className = 'metrics-note';
    note.style.color = 'var(--color-danger)';
    note.style.gridColumn = '1 / -1';
    note.textContent = `آخر خطأ مسجّل: ${lastError}`;
    container.insertAdjacentElement('afterend', note);
}

function renderCheckboxGrid(containerId, items, selected) {
    const el = document.getElementById(containerId);
    el.innerHTML = items.map(it => `
    <label class="check-item ${selected.includes(it.key) ? 'checked' : ''}">
      <input type="checkbox" value="${it.key}" ${selected.includes(it.key) ? 'checked' : ''}>
      ${it.label}
    </label>`).join('');
    el.querySelectorAll('input').forEach(cb => cb.addEventListener('change', () => cb.closest('.check-item').classList.toggle('checked', cb.checked)));
}
function getCheckedValues(containerId) {
    return Array.from(document.querySelectorAll(`#${containerId} input:checked`)).map(i => i.value);
}

/* ---------- متغيرات البيئة ---------- */
function renderEnvVars() {
    const list = document.getElementById('envvarList');
    if (envVars.length === 0) {
        list.innerHTML = `<p class="hint">لا توجد متغيرات بيئة بعد.</p>`;
        return;
    }
    list.innerHTML = envVars.map((v, i) => `
    <div class="envvar-row">
      <input type="text" placeholder="KEY" value="${escapeAttr(v.key)}" data-env-idx="${i}" data-env-field="key">
      <input type="${v.is_secret ? 'password' : 'text'}" placeholder="${v.is_secret && v.value === '••••••••' ? '•••••••• (اتركه فارغاً للإبقاء عليه)' : 'VALUE'}" value="${v.is_secret && v.value === '••••••••' ? '' : escapeAttr(v.value)}" data-env-idx="${i}" data-env-field="value">
      <label class="secret-toggle"><input type="checkbox" data-env-idx="${i}" data-env-field="is_secret" ${v.is_secret ? 'checked' : ''}> سرّي</label>
      <button class="envvar-remove" data-env-remove="${i}" title="حذف">×</button>
    </div>`).join('');

    list.querySelectorAll('[data-env-field]').forEach(el => el.addEventListener('input', onEnvVarChange));
    list.querySelectorAll("[data-env-field='is_secret']").forEach(el => el.addEventListener('change', onEnvVarChange));
    list.querySelectorAll('[data-env-remove]').forEach(el => el.addEventListener('click', () => {
        envVars.splice(Number(el.dataset.envRemove), 1);
        renderEnvVars();
    }));
}
function onEnvVarChange(e) {
    const idx = Number(e.target.dataset.envIdx);
    const field = e.target.dataset.envField;
    if (field === 'is_secret') {
        envVars[idx].is_secret = e.target.checked;
        renderEnvVars(); // إعادة رسم عشان نبدّل نوع input بين text/password
    } else {
        envVars[idx][field] = e.target.value;
    }
}

/* ================= الحالة والأداء (Runtime، لا تُخزَّن) ================= */
async function refreshLiveStatus() {
    if (!currentAgentId) return;
    ['mCpu', 'mRam', 'mUptime', 'mQueue', 'mLatency', 'mHeartbeat'].forEach(id => document.getElementById(id).textContent = '...');
    try {
        const result = await callAgentManager('status', { id: currentAgentId });
        if (!result.ok) { toast(result.error || 'تعذّر جلب الحالة', 'error'); resetLiveMetrics(); return; }
        const m = result.data || {};
        document.getElementById('mCpu').textContent = m.cpu != null ? `${m.cpu}%` : '—';
        document.getElementById('mRam').textContent = m.ram != null ? `${m.ram}%` : '—';
        document.getElementById('mUptime').textContent = m.uptime || '—';
        document.getElementById('mQueue').textContent = m.queue_size ?? '—';
        document.getElementById('mLatency').textContent = m.latency_ms != null ? `${m.latency_ms}ms` : '—';
        document.getElementById('mHeartbeat').textContent = 'الآن';
    } catch (err) {
        toast(err.message, 'error');
        resetLiveMetrics();
    }
}
function resetLiveMetrics() {
    ['mCpu', 'mRam', 'mUptime', 'mQueue', 'mLatency', 'mHeartbeat'].forEach(id => document.getElementById(id).textContent = '—');
}

/* ================= السجلات ================= */
async function loadLogs() {
    if (!currentAgentId) return;
    const box = document.getElementById('logsBox');
    box.innerHTML = `<div class="log-line info"><span class="lvl">INFO</span><span>جاري الجلب...</span></div>`;
    try {
        const level = document.getElementById('logLevelFilter').value;
        const search = document.getElementById('logSearch').value;
        const result = await callAgentManager('logs', { id: currentAgentId, level, search, limit: 300 });
        if (!result.ok) { box.innerHTML = `<div class="log-line error"><span class="lvl">ERROR</span><span>${escapeHtml(result.error || 'تعذّر جلب السجلات')}</span></div>`; return; }
        const lines = Array.isArray(result.data) ? result.data : (result.data?.logs || []);
        if (!lines.length) { box.innerHTML = `<div class="log-line info"><span class="lvl">INFO</span><span>لا توجد سجلات مطابقة.</span></div>`; return; }
        box.innerHTML = lines.map(l => `
      <div class="log-line ${l.level || 'info'}">
        <span class="ts">${l.timestamp ? new Date(l.timestamp).toLocaleTimeString('ar-EG') : ''}</span>
        <span class="lvl">${(l.level || 'info').toUpperCase()}</span>
        <span>${escapeHtml(l.message || '')}</span>
      </div>`).join('');
    } catch (err) {
        box.innerHTML = `<div class="log-line error"><span class="lvl">ERROR</span><span>${escapeHtml(err.message)}</span></div>`;
    }
}
function downloadLogsAsFile() {
    const text = Array.from(document.querySelectorAll('#logsBox .log-line')).map(l => l.textContent.trim()).join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `agent-logs-${currentAgentId || 'new'}-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
}

/* ================= الإجراءات ================= */
async function handleActionTileClick(e) {
    const tile = e.target.closest('.action-tile');
    if (!tile || !currentAgentId) return;
    const act = tile.dataset.act;
    if (act === 'download_logs_full') return downloadLogsAsFile();
    if (act === 'delete_agent') {
        if (!confirm('هل أنت متأكد من حذف هذا الوكيل نهائياً؟ لا يمكن التراجع عن هذا الإجراء.')) return;
        try {
            await callAgentManager('delete', { id: currentAgentId });
            toast('تم حذف الوكيل', 'success');
            closeModal();
            loadAgents();
        } catch (err) { toast(err.message, 'error'); }
        return;
    }
    try {
        toast('جاري التنفيذ...', 'info');
        const result = await callAgentManager(act, { id: currentAgentId });
        if (result.ok === false) throw new Error(result.error || 'فشل الإجراء');
        toast('تم التنفيذ بنجاح', 'success');
        loadAgents();
        if (act !== 'test_connection') document.getElementById('fStatusReadonly').value = 'قيد التحديث...';
    } catch (err) {
        toast(err.message, 'error');
    }
}

/* ================= الحفظ (إنشاء/تعديل) ================= */
async function handleSaveAgent() {
    const payload = {
        name: document.getElementById('fName').value.trim(),
        slug: document.getElementById('fSlug').value.trim(),
        description: document.getElementById('fDescription').value.trim() || null,
        type: document.getElementById('fType').value.trim() || 'custom',
        version: document.getElementById('fVersion').value.trim() || null,
        enabled: document.getElementById('fEnabled').checked,
        auto_start: document.getElementById('fAutoStart').checked,
        auto_restart: document.getElementById('fAutoRestart').checked,

        connection_type: document.getElementById('fConnectionType').value,
        protocol: document.getElementById('fProtocol').value || null,
        port: document.getElementById('fPort').value ? Number(document.getElementById('fPort').value) : null,
        host: document.getElementById('fHost').value.trim() || null,
        endpoint: document.getElementById('fEndpoint').value.trim() || null,
        health_endpoint: document.getElementById('fHealthEndpoint').value.trim() || null,
        timeout_ms: Number(document.getElementById('fTimeout').value) || 10000,
        retry_count: Number(document.getElementById('fRetryCount').value) || 3,
        retry_delay_ms: Number(document.getElementById('fRetryDelay').value) || 2000,
        health_check_interval: Number(document.getElementById('fHealthCheckInterval').value) || 30,

        executable: document.getElementById('fExecutable').value.trim() || null,
        working_directory: document.getElementById('fWorkingDir').value.trim() || null,
        command_start: document.getElementById('fCmdStart').value.trim() || null,
        command_stop: document.getElementById('fCmdStop').value.trim() || null,
        command_restart: document.getElementById('fCmdRestart').value.trim() || null,

        resources: getCheckedValues('resourcesGrid'),
        permissions: getCheckedValues('permissionsGrid'),
        environment_variables: envVars.filter(v => v.key.trim() !== ''),
    };

    const apiKeyVal = document.getElementById('fApiKey').value.trim();
    if (apiKeyVal) payload.api_key = apiKeyVal;

    if (!payload.name || !payload.slug) { toast('اسم الوكيل والمعرّف مطلوبان', 'error'); return; }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(payload.slug)) {
        // [إضافة] فحص شكل الـ slug في الواجهة قبل الإرسال — نفس القيد الموجود
        // فعلياً في قاعدة البيانات وفي agent-manager، كان غير مُتحقق منه هنا
        // فيضطر المستخدم ينتظر رد الخادم ليكتشف الخطأ.
        toast('المعرّف (Slug) يجب أن يبدأ بحرف/رقم ويحتوي فقط على حروف إنجليزية صغيرة وأرقام و - و _', 'error');
        return;
    }

    try {
        if (currentAgentId) {
            payload.id = currentAgentId;
            await callAgentManager('update', payload);
            toast('تم حفظ التعديلات', 'success');
        } else {
            await callAgentManager('create', payload);
            toast('تم إنشاء الوكيل', 'success');
        }
        closeModal();
        loadAgents();
    } catch (err) {
        toast(err.message, 'error');
    }
}

/* ================= أدوات مساعدة ================= */
function toast(msg, type = 'info') {
    const wrap = document.getElementById('toastWrap');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 3200);
}
function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }
function truncate(str, max) {
    const s = String(str ?? '');
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
function timeAgo(iso) {
    const diffSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (diffSec < 60) return 'الآن';
    if (diffSec < 3600) return `منذ ${Math.floor(diffSec / 60)} دقيقة`;
    if (diffSec < 86400) return `منذ ${Math.floor(diffSec / 3600)} ساعة`;
    return `منذ ${Math.floor(diffSec / 86400)} يوم`;
}
