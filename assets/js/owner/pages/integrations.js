/**
 * owner/integrations.html — وصول الأنظمة الخارجية تحت إشراف المالك.
 *
 *   • api_tokens: «Admin can view/update any api token» ← is_admin() (المالك في سياقه). الكتابة هنا الإيقاف
 *     والتفعيل وحدهما (is_active/revoked_at)؛ أعمدة الاعتماد مرفوضة لكل JWT بحارس 110 مهما أُرسل.
 *   • api_token_usage_logs: القراءة ← is_admin().
 *   • external_integrations: القراءة لنطاق platform للجميع، والتحديث لنطاق platform ← is_admin(). الأعمدة
 *     مسمّاة: credentials_encrypted لا تُطلب أبدًا.
 */
import {
    supabase, bootOwnerPage, announce, esc, when, num, table, kpis, errorBlock, loadingBlock,
    writeResult, friendlyError, openModal
} from '/assets/js/owner/owner-page.js';
import { ROLE_LABELS, label, searchTerm } from '/assets/js/owner/owner-labels.js';
import {
    createServer, updateServer, deleteServer, saveCredentials, startOAuth, testServer
} from '/mcp-service.js';
import {
    normalizeMcpServers, mcpStatusLabel, mcpStatusTone, MCP_TRANSPORT_LABELS, MCP_AUTH_LABELS,
    canManageMcpServer, canTestMcpServer, credentialFields, validateServerForm
} from '/assets/js/owner/owner-mcp-model.js';

const $ = (id) => document.getElementById(id);
let tokens = [];
let mcpServers = [];
let meId = null;
const people = new Map();
const say = (text, tone = 'info') => announce($('pageStatus'), text, tone);

async function loadPeople(ids) {
    const missing = [...new Set(ids.filter(id => id && !people.has(id)))];
    if (!missing.length) return;
    // فشل القراءة لا يوقف الجدول: الصاحب يُعرض بمعرّفه كما في renderTokens.
    try {
        const { data } = await supabase.from('profiles').select('id, full_name, email, role').in('id', missing);
        (data || []).forEach(p => people.set(p.id, p));
    } catch (err) {
        console.error('[OwnerIntegrations] loadPeople:', err?.message || err);
    }
}

const tokenLive = (t) => t.is_active && !t.revoked_at && (!t.expires_at || new Date(t.expires_at) > new Date());

async function loadTokens() {
    $('tokensTable').innerHTML = loadingBlock();
    // انقطاع الشبكة يرمي: بلا التقاط يبقى الهيكل العظمي بلا تفسير.
    let data, error = null;
    try {
        ({ data, error } = await supabase.from('api_tokens')
            .select('id, user_id, name, description, is_active, revoked_at, expires_at, created_at, last_used_at, usage_count, credential_type, created_by_role, secret_last_four')
            .order('created_at', { ascending: false }));
    } catch (err) {
        error = err;
    }
    if (error) { $('tokensTable').innerHTML = errorBlock(friendlyError(error)); tokens = []; return; }
    tokens = data || [];
    await loadPeople(tokens.map(t => t.user_id));
    renderTokens();
}

function renderTokens() {
    const term = searchTerm($('tokensSearch').value).toLowerCase();
    const state = $('tokensState').value;
    const rows = tokens.filter(t => {
        if (state === 'active' && !tokenLive(t)) return false;
        if (state === 'inactive' && tokenLive(t)) return false;
        if (!term) return true;
        const p = people.get(t.user_id);
        return [t.name, p?.full_name, p?.email].some(v => String(v || '').toLowerCase().includes(term));
    });
    const box = $('tokensTable');
    box.innerHTML = table(['المفتاح', 'صاحبه', 'النوع', 'الحالة', 'الاستخدام', 'آخر استخدام', ''], rows, t => {
        const p = people.get(t.user_id);
        const live = tokenLive(t);
        const expired = t.expires_at && new Date(t.expires_at) <= new Date();
        return `<tr>
            <td><div class="owner-account">
                <span class="owner-account-name">${esc(t.name || '—')}</span>
                ${t.secret_last_four ? `<span class="owner-account-email owner-mono">••••${esc(t.secret_last_four)}</span>` : ''}
            </div></td>
            <td><div class="owner-account">
                <span class="owner-account-name">${esc(p?.full_name || p?.email || t.user_id)}</span>
                <span class="owner-account-email">${esc(label(ROLE_LABELS, p?.role))}</span>
            </div></td>
            <td>${esc(t.credential_type || '—')}</td>
            <td>${live ? '<span class="pill status-resolved">فعّال</span>'
                : expired ? '<span class="pill status-neutral">منتهٍ</span>'
                : '<span class="pill status-rejected">موقوف</span>'}</td>
            <td>${esc(num(t.usage_count || 0))}</td>
            <td>${esc(when(t.last_used_at))}</td>
            <td>${expired ? '' : t.is_active && !t.revoked_at
                ? `<button type="button" class="btn btn-outline btn-sm" data-token="${esc(t.id)}" data-active="false">إيقاف</button>`
                : `<button type="button" class="btn btn-primary btn-sm" data-token="${esc(t.id)}" data-active="true">تفعيل</button>`}</td>
        </tr>`;
    }, { empty: tokens.length ? 'لا مفاتيح مطابقة.' : 'لا مفاتيح واجهة برمجية على المنصة.' });

    box.querySelectorAll('[data-token]').forEach(b => b.addEventListener('click', () =>
        setToken(tokens.find(t => t.id === b.dataset.token), b.dataset.active === 'true', b)));
    renderKpis();
}

async function setToken(token, active, btn) {
    if (!token) return;
    const owner = people.get(token.user_id);
    const question = active
        ? `إعادة تفعيل المفتاح «${token.name}»؟ سيعود صاحبه (${owner?.email || ''}) للوصول به.`
        : `إيقاف المفتاح «${token.name}»؟ كل نظام يستعمله يفقد الوصول فورًا.`;
    if (!window.confirm(question)) return;
    btn.disabled = true;
    let result;
    try {
        // إصلاح: كان `patch` غير معرّف إطلاقًا (ReferenceError عند كل نقرة إيقاف/تفعيل) —
        // نفس حمولة toggleApiToken في mcp-service.js.
        result = writeResult(await supabase.from('api_tokens')
            .update({ is_active: active, revoked_at: active ? null : new Date().toISOString() })
            .eq('id', token.id).select('id'));
    } catch (err) {
        result = { ok: false, message: friendlyError(err) };
    }
    if (!result.ok) { btn.disabled = false; say(result.message, 'error'); return; }
    say(active ? 'تم تفعيل المفتاح.' : 'تم إيقاف المفتاح.', 'success');
    loadTokens();
}

let platform = [];
async function loadPlatform() {
    $('platformIntegrations').innerHTML = loadingBlock();
    let data, error = null;
    try {
        ({ data, error } = await supabase.from('external_integrations')
            .select('id, provider, display_name, protocol, is_active, last_tested_at, last_test_status, last_test_message, last_used_at, priority')
            .eq('owner_scope', 'platform').order('priority', { ascending: true }));
    } catch (err) {
        error = err;
    }
    if (error) { $('platformIntegrations').innerHTML = errorBlock(friendlyError(error)); platform = []; renderKpis(); return; }
    platform = data || [];
    const box = $('platformIntegrations');
    box.innerHTML = table(['التكامل', 'البروتوكول', 'الحالة', 'آخر اختبار', 'آخر استخدام', ''], platform, i => `<tr>
        <td><div class="owner-account">
            <span class="owner-account-name">${esc(i.display_name || i.provider)}</span>
            <span class="owner-account-email">${esc(i.provider)}</span>
        </div></td>
        <td>${esc(i.protocol || '—')}</td>
        <td>${i.is_active ? '<span class="pill status-resolved">مفعّل</span>' : '<span class="pill status-neutral">معطّل</span>'}</td>
        <td>${i.last_tested_at
            ? `<span class="pill ${i.last_test_status === 'success' || i.last_test_status === 'ok' ? 'status-resolved' : 'status-rejected'}">${esc(i.last_test_status || '—')}</span>
               <span class="owner-cell-muted">${esc(when(i.last_tested_at))}</span>`
            : '<span class="owner-cell-muted">لم يُختبر</span>'}</td>
        <td>${esc(when(i.last_used_at))}</td>
        <td><button type="button" class="btn btn-sm ${i.is_active ? 'btn-outline' : 'btn-primary'}" data-integration="${esc(i.id)}" data-active="${i.is_active ? 'false' : 'true'}">${i.is_active ? 'تعطيل' : 'تفعيل'}</button></td>
    </tr>`, { empty: 'لا تكاملات بنطاق المنصة.' });
    box.querySelectorAll('[data-integration]').forEach(b => b.addEventListener('click', async () => {
        const item = platform.find(i => i.id === b.dataset.integration);
        const active = b.dataset.active === 'true';
        if (!window.confirm(`${active ? 'تفعيل' : 'تعطيل'} «${item?.display_name || item?.provider}» لكل المنصة؟`)) return;
        b.disabled = true;
        let result;
        try {
            result = writeResult(await supabase.from('external_integrations').update({ is_active: active }).eq('id', item.id).select('id'));
        } catch (err) {
            result = { ok: false, message: friendlyError(err) };
        }
        if (!result.ok) { b.disabled = false; say(result.message, 'error'); return; }
        say(active ? 'تم تفعيل التكامل.' : 'تم تعطيل التكامل.', 'success');
        loadPlatform();
    }));
    renderKpis();
}

async function loadUsage() {
    $('usageTable').innerHTML = loadingBlock();
    let data, error = null;
    try {
        ({ data, error } = await supabase.from('api_token_usage_logs')
            .select('id, token_id, user_id, endpoint, method, status_code, ip_address, created_at')
            .order('created_at', { ascending: false }).limit(50));
    } catch (err) {
        error = err;
    }
    if (error) { $('usageTable').innerHTML = errorBlock(friendlyError(error)); return; }
    const rows = data || [];
    await loadPeople(rows.map(r => r.user_id));
    $('usageTable').innerHTML = table(['الطلب', 'النتيجة', 'الحساب', 'العنوان', 'الوقت'], rows, r => {
        const p = people.get(r.user_id);
        const ok = Number(r.status_code) < 400;
        return `<tr>
            <td><span class="owner-mono">${esc(r.method || '')} ${esc(r.endpoint || '')}</span></td>
            <td><span class="pill ${ok ? 'status-resolved' : 'status-rejected'}">${esc(r.status_code ?? '—')}</span></td>
            <td>${esc(p?.full_name || p?.email || '—')}</td>
            <td dir="ltr">${esc(r.ip_address || '—')}</td>
            <td>${esc(when(r.created_at))}</td>
        </tr>`;
    }, { empty: 'لا استدعاءات مسجّلة بعد.' });
}

function renderKpis() {
    const live = tokens.filter(tokenLive).length;
    const usedWeek = tokens.filter(t => t.last_used_at && new Date(t.last_used_at) > new Date(Date.now() - 7 * 864e5)).length;
    const failing = platform.filter(i => i.is_active && i.last_test_status && !['success', 'ok'].includes(i.last_test_status)).length;
    const mcpConnected = mcpServers.filter(s => s.status === 'connected').length;
    $('integrationsKpis').innerHTML = kpis([
        ['مفاتيح الواجهة البرمجية الفعّالة', num(live), 'kpi--success'],
        ['موقوفة أو منتهية', num(tokens.length - live), ''],
        ['استُخدمت خلال 7 أيام', num(usedWeek), 'kpi--info'],
        ['تكاملات المنصة المفعّلة', num(platform.filter(i => i.is_active).length), ''],
        ['آخر اختبار فاشل', num(failing), failing ? 'kpi--danger' : ''],
        ['خوادم MCP', num(mcpServers.length), ''],
        ['خوادم MCP متصلة', num(mcpConnected), mcpConnected ? 'kpi--success' : '']
    ]);
}

/* ── خوادم MCP ─────────────────────────────────────────────────────────────
   القراءة عبر owner_list_mcp_servers() (147): كل خوادم المنصة بلا أسرار.
   الكتابة على التعريف مباشرة عبر mcp-service.js (سياسات 048: مالكه وحده)،
   والاعتماد والاختبار وOAuth عبر دوال الحافة كما هي. */

const MCP_MISSING = new Set(['PGRST202', '42883', 'PGRST404']);

async function loadMcp() {
    $('mcpTable').innerHTML = loadingBlock();
    let data, error = null;
    try {
        ({ data, error } = await supabase.rpc('owner_list_mcp_servers'));
    } catch (err) {
        error = err;
    }
    if (error) {
        $('mcpTable').innerHTML = errorBlock(MCP_MISSING.has(error.code) || error.status === 404
            ? 'دالة owner_list_mcp_servers غير مطبّقة بعد (الترحيل 147).'
            : friendlyError(error));
        mcpServers = [];
        renderKpis();
        return;
    }
    mcpServers = normalizeMcpServers(data || [], meId);
    await loadPeople(mcpServers.map(s => s.owner_id).filter(Boolean));
    renderMcp();
    renderKpis();
}

function renderMcp() {
    const term = searchTerm($('mcpSearch').value).toLowerCase();
    const state = $('mcpState').value;
    const rows = mcpServers.filter(s => {
        if (state === 'mine' && !s.mine) return false;
        if (state && state !== 'mine' && s.status !== state) return false;
        if (!term) return true;
        return [s.name, s.url, s.description].some(v => String(v || '').toLowerCase().includes(term));
    });
    const box = $('mcpTable');
    box.innerHTML = table(['الخادم', 'الناقل', 'المالك', 'الحالة', 'الأدوات', 'آخر فحص', ''], rows, s => {
        const owner = people.get(s.owner_id);
        const mine = canManageMcpServer(s, meId);
        const tools = Array.isArray(s.tools) ? s.tools.filter(t => t.enabled !== false).length : 0;
        return `<tr>
            <td><div class="owner-account">
                <span class="owner-account-name">${esc(s.name || '—')}</span>
                <span class="owner-account-email owner-mono">${esc(s.url || s.command || '—')}</span>
                ${s.description ? `<span class="owner-account-email">${esc(s.description)}</span>` : ''}
            </div></td>
            <td>${esc(MCP_TRANSPORT_LABELS[s.transport] || s.transport || '—')}</td>
            <td>${esc(owner?.full_name || owner?.email || (mine ? 'أنت' : '—'))}</td>
            <td><span class="pill ${mcpStatusTone(s.status)}">${esc(mcpStatusLabel(s.status))}</span>
                ${s.last_error ? `<span class="owner-cell-muted">${esc(s.last_error)}</span>` : ''}</td>
            <td>${esc(num(tools))}</td>
            <td>${esc(when(s.last_checked_at))}</td>
            <td><div class="owner-row-actions">
                ${s.mine && s.connection_id ? `<button type="button" class="btn btn-outline btn-sm" data-mcp-test="${esc(s.id)}">اختبار</button>` : ''}
                ${mine ? `<button type="button" class="btn btn-outline btn-sm" data-mcp-creds="${esc(s.id)}">بيانات الاعتماد (${esc(MCP_AUTH_LABELS[s.auth_type] || s.auth_type)})</button>` : `<span class="owner-cell-muted">${esc(MCP_AUTH_LABELS[s.auth_type] || s.auth_type || '—')}</span>`}
                ${mine ? `<button type="button" class="btn btn-outline btn-sm" data-mcp-edit="${esc(s.id)}">تعديل</button>` : ''}
                ${mine ? `<button type="button" class="btn btn-outline btn-sm" data-mcp-toggle="${esc(s.id)}" data-enabled="${s.enabled ? 'false' : 'true'}">${s.enabled ? 'تعطيل' : 'تفعيل'}</button>` : ''}
                ${mine ? `<button type="button" class="btn btn-outline btn-sm" data-mcp-del="${esc(s.id)}">حذف</button>` : ''}
            </div></td>
        </tr>`;
    }, { empty: mcpServers.length ? 'لا خوادم مطابقة.' : 'لا خوادم MCP على المنصة بعد.' });

    box.querySelectorAll('[data-mcp-test]').forEach(b => b.addEventListener('click', async () => {
        const server = mcpServers.find(s => s.id === b.dataset.mcpTest);
        if (!server || !canTestMcpServer(server)) return;
        b.disabled = true;
        say('جارٍ اختبار الاتصال…');
        try {
            const result = await testServer(server.id);
            say(result?.ok ? `نجح اختبار «${server.name}» — ${result.tools ?? 0} أداة.` : `فشل اختبار «${server.name}»: ${result?.message || 'تعذّر الاتصال'}.`, result?.ok ? 'success' : 'error');
        } catch (err) {
            say(`فشل اختبار «${server.name}»: ${friendlyError(err)}`, 'error');
        } finally {
            b.disabled = false;
            loadMcp();
        }
    }));
    box.querySelectorAll('[data-mcp-creds]').forEach(b => b.addEventListener('click', () => {
        const server = mcpServers.find(s => s.id === b.dataset.mcpCreds);
        if (server) openCredentialsModal(server);
    }));
    box.querySelectorAll('[data-mcp-edit]').forEach(b => b.addEventListener('click', () => {
        const server = mcpServers.find(s => s.id === b.dataset.mcpEdit);
        if (server) openServerModal(server);
    }));
    box.querySelectorAll('[data-mcp-toggle]').forEach(b => b.addEventListener('click', async () => {
        const server = mcpServers.find(s => s.id === b.dataset.mcpToggle);
        if (!server) return;
        b.disabled = true;
        try {
            await updateServer(server.id, { enabled: b.dataset.enabled === 'true' });
            say(b.dataset.enabled === 'true' ? `تم تفعيل «${server.name}».` : `تم تعطيل «${server.name}».`, 'success');
        } catch (err) {
            say(friendlyError(err), 'error');
        } finally {
            b.disabled = false;
            loadMcp();
        }
    }));
    box.querySelectorAll('[data-mcp-del]').forEach(b => b.addEventListener('click', async () => {
        const server = mcpServers.find(s => s.id === b.dataset.mcpDel);
        if (!server) return;
        if (!window.confirm(`حذف خادم «${server.name}» نهائيًا؟ بيانات اعتماده واتصاله تُحذف معه.`)) return;
        b.disabled = true;
        try {
            await deleteServer(server.id);
            say(`تم حذف «${server.name}».`, 'success');
        } catch (err) {
            say(friendlyError(err), 'error');
        } finally {
            b.disabled = false;
            loadMcp();
        }
    }));
}

/** نافذة إضافة/تعديل تعريف خادم — حقول normalizePayload في mcp-service.js، بلا أسرار. */
function openServerModal(server) {
    const isNew = !server;
    const { body, close } = openModal({
        title: isNew ? 'إضافة خادم MCP' : `تعديل خادم «${server.name}»`, wide: true
    });
    body.innerHTML = `
        <form id="mcpServerForm" novalidate>
            <label for="mcpName">اسم الخادم</label>
            <input class="form-control" id="mcpName" type="text" maxlength="120" value="${esc(server?.name || '')}" dir="auto">
            <label for="mcpTransport">نوع النقل</label>
            <select class="form-control" id="mcpTransport">
                ${Object.entries(MCP_TRANSPORT_LABELS).map(([v, l]) => `<option value="${esc(v)}" ${server?.transport === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
            </select>
            <label for="mcpType">نوع الموصّل</label>
            <select class="form-control" id="mcpType">
                <option value="mcp_server" ${server?.connector_type !== 'oauth_connector' ? 'selected' : ''}>خادم MCP (JSON-RPC)</option>
                <option value="oauth_connector" ${server?.connector_type === 'oauth_connector' ? 'selected' : ''}>موصّل OAuth فقط (بلا استدعاء MCP)</option>
            </select>
            <label for="mcpUrl">عنوان URL (لغير stdio)</label>
            <input class="form-control" id="mcpUrl" type="url" dir="ltr" value="${esc(server?.url || '')}" placeholder="https://…">
            <label for="mcpCommand">أمر التشغيل (stdio)</label>
            <input class="form-control" id="mcpCommand" type="text" dir="ltr" value="${esc(server?.command || '')}">
            <label for="mcpDesc">الوصف</label>
            <input class="form-control" id="mcpDesc" type="text" maxlength="300" value="${esc(server?.description || '')}" dir="auto">
            <label for="mcpCategory">الفئة</label>
            <input class="form-control" id="mcpCategory" type="text" maxlength="60" value="${esc(server?.category || 'general')}" dir="auto">
            <p class="state-text" id="mcpServerError" role="alert" style="color: var(--color-danger, #c0392b)" hidden></p>
            <div class="owner-row-actions">
                <button type="submit" class="btn btn-primary" id="mcpServerSave">${isNew ? 'إضافة الخادم' : 'حفظ التعديل'}</button>
                <button type="button" class="btn btn-outline" data-mcp-cancel>إلغاء</button>
            </div>
        </form>`;
    const errorEl = body.querySelector('#mcpServerError');
    body.querySelector('[data-mcp-cancel]').addEventListener('click', close);
    body.querySelector('#mcpServerForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        errorEl.hidden = true;
        const payload = {
            name: body.querySelector('#mcpName').value.trim(),
            transport: body.querySelector('#mcpTransport').value,
            connector_type: body.querySelector('#mcpType').value,
            url: body.querySelector('#mcpUrl').value.trim(),
            command: body.querySelector('#mcpCommand').value.trim(),
            description: body.querySelector('#mcpDesc').value.trim(),
            category: body.querySelector('#mcpCategory').value.trim() || 'general'
        };
        const check = validateServerForm(payload);
        if (!check.ok) { errorEl.textContent = check.error; errorEl.hidden = false; return; }
        const submit = body.querySelector('#mcpServerSave');
        submit.disabled = true;
        try {
            const saved = isNew ? await createServer(payload) : await updateServer(server.id, payload);
            close();
            say(isNew ? `تمت إضافة «${saved.name}» — أضف بيانات اعتماده الآن.` : `تم حفظ «${saved.name}».`, 'success');
            await loadMcp();
            if (isNew) {
                const fresh = mcpServers.find(s => s.id === saved.id);
                if (fresh) openCredentialsModal(fresh);
            }
        } catch (err) {
            errorEl.textContent = friendlyError(err);
            errorEl.hidden = false;
        } finally {
            submit.disabled = false;
        }
    });
}

/** نافذة بيانات الاعتماد — تُرسَل مرة واحدة إلى save-mcp-credentials ولا تُقرأ أبدًا. */
function openCredentialsModal(server) {
    const { body, close } = openModal({ title: `بيانات اعتماد «${server.name}»`, wide: true });
    const renderFields = (authType) => {
        const fields = credentialFields(authType);
        body.querySelector('#mcpCredFields').innerHTML = fields.map(f => `
            <label for="mcpCred-${esc(f.key)}">${esc(f.label)}</label>
            ${f.type === 'textarea'
                ? `<textarea class="form-control" id="mcpCred-${esc(f.key)}" rows="4" dir="ltr" placeholder='{"Header": "value"}'></textarea>`
                : `<input class="form-control" id="mcpCred-${esc(f.key)}" type="${esc(f.type)}" dir="ltr" ${f.required ? 'required' : ''}>`}
        `).join('');
        body.querySelector('#mcpOauthStart').hidden = authType !== 'oauth2';
    };
    body.innerHTML = `
        <form id="mcpCredForm" novalidate>
            <p class="state-text">الأسرار تُشفَّر في الدالة الطرفية ولا تظهر هنا بعد الحفظ — حقل سر فارغ يعني «كما هو».</p>
            <label for="mcpAuthType">نوع المصادقة</label>
            <select class="form-control" id="mcpAuthType">
                ${Object.entries(MCP_AUTH_LABELS).map(([v, l]) => `<option value="${esc(v)}" ${server.auth_type === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
            </select>
            <div id="mcpCredFields"></div>
            <p class="state-text" id="mcpCredError" role="alert" style="color: var(--color-danger, #c0392b)" hidden></p>
            <p class="state-text" id="mcpCredDone" role="status" hidden></p>
            <div class="owner-row-actions">
                <button type="submit" class="btn btn-primary" id="mcpCredSave">حفظ بيانات الاعتماد</button>
                <button type="button" class="btn btn-outline" id="mcpOauthStart" hidden>بدء ربط OAuth</button>
                <button type="button" class="btn btn-outline" id="mcpTestAfter">اختبار الاتصال</button>
                <button type="button" class="btn btn-outline" data-mcp-cancel>إغلاق</button>
            </div>
        </form>`;
    const errorEl = body.querySelector('#mcpCredError');
    const doneEl = body.querySelector('#mcpCredDone');
    renderFields(server.auth_type || 'none');
    body.querySelector('#mcpAuthType').addEventListener('change', (e) => renderFields(e.target.value));
    body.querySelector('[data-mcp-cancel]').addEventListener('click', close);
    body.querySelector('#mcpCredForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        errorEl.hidden = true;
        doneEl.hidden = true;
        const authType = body.querySelector('#mcpAuthType').value;
        const payload = { auth_type: authType };
        for (const f of credentialFields(authType)) {
            const el = body.querySelector(`#mcpCred-${f.key}`);
            const value = el?.value.trim() || '';
            if (f.required && !value) {
                errorEl.textContent = `${f.label} مطلوب.`;
                errorEl.hidden = false;
                return;
            }
            if (value) payload[f.key] = value;
        }
        const submit = body.querySelector('#mcpCredSave');
        submit.disabled = true;
        try {
            await saveCredentials(server.id, payload);
            doneEl.textContent = 'تم حفظ بيانات الاعتماد.';
            doneEl.hidden = false;
            say(`تم حفظ بيانات اعتماد «${server.name}».`, 'success');
            await loadMcp();
        } catch (err) {
            errorEl.textContent = friendlyError(err);
            errorEl.hidden = false;
        } finally {
            submit.disabled = false;
        }
    });
    body.querySelector('#mcpOauthStart').addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        try {
            const data = await startOAuth(server.id);
            if (data?.authorize_url) location.href = data.authorize_url;
            else { errorEl.textContent = 'لم يرجع مزود OAuth رابط تفويض.'; errorEl.hidden = false; }
        } catch (err) {
            errorEl.textContent = friendlyError(err);
            errorEl.hidden = false;
        } finally {
            e.currentTarget.disabled = false;
        }
    });
    body.querySelector('#mcpTestAfter').addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        try {
            const result = await testServer(server.id);
            doneEl.textContent = result?.ok
                ? `نجح الاختبار — ${result.tools ?? 0} أداة.`
                : `فشل الاختبار: ${result?.message || 'تعذّر الاتصال'}.`;
            doneEl.hidden = false;
            await loadMcp();
        } catch (err) {
            errorEl.textContent = friendlyError(err);
            errorEl.hidden = false;
        } finally {
            e.currentTarget.disabled = false;
        }
    });
}

(async function init() {
    const boot = await bootOwnerPage();
    if (!boot) return;
    meId = boot.session?.user?.id || null;
    $('tokensFilters').addEventListener('submit', (e) => { e.preventDefault(); renderTokens(); });
    $('tokensSearch').addEventListener('input', renderTokens);
    $('tokensState').addEventListener('change', renderTokens);
    $('mcpFilters').addEventListener('submit', (e) => { e.preventDefault(); renderMcp(); });
    $('mcpSearch').addEventListener('input', renderMcp);
    $('mcpState').addEventListener('change', renderMcp);
    $('mcpAdd').addEventListener('click', () => openServerModal(null));
    $('integrationsRefresh').addEventListener('click', () => { loadTokens(); loadPlatform(); loadUsage(); loadMcp(); });
    loadTokens();
    loadPlatform();
    loadUsage();
    loadMcp();
})();
