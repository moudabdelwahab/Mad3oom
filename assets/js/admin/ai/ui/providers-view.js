/**
 * عرض المزوّدين + فورم الإضافة/التعديل الديناميكي
 * --------------------------------------------------------
 * كل ما يظهر في الفورم (البروتوكولات، الرابط الافتراضي، حقول الاعتماد)
 * مبني من صف الكتالوج. لا توجد أي قائمة مزوّدين مكتوبة هنا.
 */

import * as api from '../ai-service.js';
import {
    findProvider, providerLabel, effectiveProtocol, effectiveBaseUrl,
    credentialFields, supportsModelDiscovery, maskedKey,
    PROVIDER_KIND_LABELS, PROTOCOL_LABELS, AI_PROVIDER_KINDS,
} from '../provider-registry.js';
import {
    escapeHtml, icon, toast, loadingBlock, errorBlock, emptyBlock,
    statusChip, formatNumber, formatCost, formatDate, setBusy,
} from './shared.js';

let ctx = null;              // مرجع للحالة المشتركة من ai-admin.js
let searchQuery = '';
let kindFilter = 'all';

export function init(sharedContext) {
    ctx = sharedContext;
}

/* ====================  البطاقات  ==================== */

function providerCard(integration) {
    const catalogRow = findProvider(ctx.catalog, integration.provider);
    const protocol = effectiveProtocol(ctx.catalog, integration);
    const baseUrl = effectiveBaseUrl(ctx.catalog, integration, protocol);
    const models = ctx.models.filter((m) => m.integration_id === integration.id);
    const enabledModels = models.filter((m) => m.is_enabled).length;
    const usage = ctx.usageByIntegration.get(integration.id);
    const key = maskedKey(integration);

    const testChip = integration.last_test_status === 'success'
        ? statusChip('ok', 'متصل')
        : integration.last_test_status === 'failed'
            ? statusChip('error', 'فشل الاتصال')
            : statusChip('pending', 'لم يُختبر');

    const isCustomEndpoint = !!(integration.base_url || integration.credentials_meta?.base_url);

    return `
    <div class="mcp-card ai-provider-card ${integration.is_active ? 'is-connected' : ''}" data-integration-id="${integration.id}">
        <div class="card-row">
            <div class="card-head">
                <div class="card-icon">${icon('cpu', 22)}</div>
                <div class="card-title-wrap">
                    <div class="card-title">
                        ${escapeHtml(integration.display_name)}
                        ${integration.is_active ? '' : '<span class="disabled-chip">معطّل</span>'}
                    </div>
                    <div class="card-subtitle">
                        ${escapeHtml(providerLabel(ctx.catalog, integration.provider))}
                        <span class="transport-chip">${escapeHtml(PROVIDER_KIND_LABELS[catalogRow?.kind] || catalogRow?.kind || '—')}</span>
                    </div>
                </div>
            </div>
            <div>${testChip}</div>
        </div>

        <div class="card-meta">
            <span title="البروتوكول المستخدم فعليًا">${icon('globe')} ${escapeHtml(PROTOCOL_LABELS[protocol] || protocol || 'غير محدّد')}</span>
            ${baseUrl ? `<span title="${isCustomEndpoint ? 'رابط مخصّص' : 'رابط افتراضي من الكتالوج'}">${icon('route')} <code dir="ltr">${escapeHtml(baseUrl)}</code>${isCustomEndpoint ? ' <span class="ai-chip-soft">مخصّص</span>' : ''}</span>` : ''}
            ${key ? `<span title="بصمة المفتاح — المفتاح نفسه لا يُقرأ أبدًا بعد الحفظ">${icon('lock')} <code dir="ltr">${escapeHtml(key)}</code></span>` : ''}
            <span title="الموديلات المكتشفة">${icon('layers')} ${enabledModels}/${models.length} موديل</span>
            <span title="الأولوية — الأصغر يُجرَّب أولًا">${icon('star')} أولوية ${integration.priority ?? 100}</span>
        </div>

        ${usage ? `
        <div class="ai-usage-strip">
            <span>${icon('activity')} ${formatNumber(usage.requests)} طلب</span>
            <span>${icon('cpu')} ${formatNumber(usage.total_tokens)} توكن</span>
            <span>${icon('dollar')} ${formatCost(usage.total_cost)}</span>
            <span>${icon('clock')} ${usage.avg_latency_ms ? Math.round(usage.avg_latency_ms) + 'ms' : '—'}</span>
            ${usage.errors ? `<span class="ai-usage-errors">${icon('alert')} ${formatNumber(usage.errors)} خطأ</span>` : ''}
        </div>` : ''}

        ${integration.last_test_message ? `<div class="ai-note">${escapeHtml(integration.last_test_message)}</div>` : ''}
        <div class="ai-note ai-note-muted">${icon('clock')} آخر استخدام: ${formatDate(integration.last_used_at)}</div>

        <div class="card-actions">
            <button class="btn btn-test" data-ai-action="test" data-id="${integration.id}">${icon('activity')} اختبار</button>
            ${supportsModelDiscovery(ctx.catalog, integration.provider)
                ? `<button class="btn btn-tools" data-ai-action="sync" data-id="${integration.id}">${icon('refresh')} مزامنة الموديلات</button>`
                : ''}
            <button class="btn btn-edit" data-ai-action="edit" data-id="${integration.id}">تعديل</button>
            <button class="btn ${integration.is_active ? 'btn-disconnect' : 'btn-edit'}" data-ai-action="toggle" data-id="${integration.id}">${integration.is_active ? 'تعطيل' : 'تفعيل'}</button>
            <button class="btn btn-delete" data-ai-action="delete" data-id="${integration.id}">حذف</button>
        </div>
    </div>`;
}

function matchesFilters(integration) {
    const catalogRow = findProvider(ctx.catalog, integration.provider);
    if (kindFilter !== 'all' && catalogRow?.kind !== kindFilter) return false;
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return `${integration.display_name} ${integration.provider} ${catalogRow?.label || ''} ${integration.base_url || ''}`
        .toLowerCase().includes(q);
}

export function render() {
    const grid = document.getElementById('aiProvidersGrid');
    if (!grid) return;

    const visible = ctx.integrations.filter(matchesFilters);

    if (!ctx.integrations.length) {
        grid.innerHTML = emptyBlock({
            title: 'لا يوجد مزوّد مُعدّ بعد',
            body: 'أضِف أول مزوّد (AgentRouter، OpenAI، Anthropic، أو أي مزوّد آخر من الكتالوج) لتبدأ في اكتشاف الموديلات وتشغيل الجلسات.',
            actionLabel: '+ إضافة مزوّد',
            actionAttr: 'data-ai-action="add"',
        });
        return;
    }

    if (!visible.length) {
        grid.innerHTML = emptyBlock({ title: 'لا نتائج', body: 'جرّب كلمة بحث أخرى أو غيّر الفلتر.' });
        return;
    }

    grid.innerHTML = visible.map(providerCard).join('');
}

export function renderKindChips() {
    const wrap = document.getElementById('aiProviderKindChips');
    if (!wrap) return;

    const counts = { all: ctx.integrations.length };
    for (const i of ctx.integrations) {
        const kind = findProvider(ctx.catalog, i.provider)?.kind || 'custom';
        counts[kind] = (counts[kind] || 0) + 1;
    }

    const kinds = ['all', ...Object.keys(PROVIDER_KIND_LABELS).filter((k) => counts[k])];
    wrap.innerHTML = kinds.map((k) => `
        <button class="mcp-chip ${kindFilter === k ? 'active' : ''}" data-ai-kind="${k}">
            ${k === 'all' ? 'الكل' : escapeHtml(PROVIDER_KIND_LABELS[k])}
            <span class="filter-count">${counts[k] || 0}</span>
        </button>`).join('');
}

export function setSearch(value) { searchQuery = (value || '').trim(); render(); }
export function setKindFilter(value) { kindFilter = value; renderKindChips(); render(); }

/* ====================  الفورم الديناميكي  ==================== */

let editingId = null;

function fieldsHtml(providerId, integration = null) {
    const row = findProvider(ctx.catalog, providerId);
    if (!row) return '<p class="hint">اختر مزوّدًا من القائمة.</p>';

    const meta = integration?.credentials_meta || {};
    const currentProtocol = integration ? effectiveProtocol(ctx.catalog, integration) : row.protocols?.[0] || '';
    const protocols = row.protocols || [];

    const protocolBlock = protocols.length > 1 ? `
        <div class="form-group full">
            <label>البروتوكول <span class="req">*</span></label>
            <select id="aiProviderProtocol">
                ${protocols.map((p) => `<option value="${escapeHtml(p)}" ${p === currentProtocol ? 'selected' : ''}>${escapeHtml(PROTOCOL_LABELS[p] || p)}</option>`).join('')}
            </select>
            <span class="hint">هذا المزوّد يدعم أكثر من بروتوكول. كل بروتوكول له رابط مختلف — يُختار تلقائيًا من الكتالوج، ولا يُضاف <code dir="ltr">/v1</code> يدويًا.</span>
        </div>`
        : `<input type="hidden" id="aiProviderProtocol" value="${escapeHtml(currentProtocol)}">
           <div class="form-group full">
               <label>البروتوكول</label>
               <div class="ai-readonly-value" dir="ltr">${escapeHtml(PROTOCOL_LABELS[currentProtocol] || currentProtocol || '—')}</div>
           </div>`;

    const endpointPreview = protocols.map((p) => `
        <div class="ai-endpoint-row">
            <span class="ai-endpoint-proto">${escapeHtml(PROTOCOL_LABELS[p] || p)}</span>
            <code dir="ltr">${escapeHtml(row.default_endpoints?.[p] || '— يتطلب Base URL مخصّص —')}</code>
        </div>`).join('');

    const baseUrlBlock = row.allows_base_url ? `
        <div class="form-group full">
            <label>Base URL ${row.requires_base_url ? '<span class="req">*</span>' : '(اختياري)'}</label>
            <input type="text" id="aiProviderBaseUrl" dir="ltr"
                   placeholder="${escapeHtml(row.default_endpoints?.[currentProtocol] || 'https://api.example.com/v1')}"
                   value="${escapeHtml(integration?.base_url || meta.base_url || '')}">
            <span class="hint">اتركه فارغًا لاستخدام رابط الكتالوج أدناه. املأه فقط للاستضافة الذاتية أو بروكسي متوافق.</span>
            <div class="ai-endpoints-preview">${endpointPreview}</div>
        </div>` : '';

    const creds = credentialFields(ctx.catalog, providerId);
    const credsBlock = creds.map((f) => `
        <div class="form-group full">
            <label>${escapeHtml(f.label_ar || f.label)} ${f.required && !integration ? '<span class="req">*</span>' : ''}</label>
            <input type="${escapeHtml(f.type || 'password')}" id="aiCred-${escapeHtml(f.key)}" dir="ltr"
                   placeholder="${escapeHtml(f.placeholder || '')}" autocomplete="off">
        </div>`).join('');

    const currentKey = integration ? maskedKey(integration) : null;

    return `
        ${protocolBlock}
        ${baseUrlBlock}
        <div class="ai-section-label">${icon('lock')} بيانات الاعتماد</div>
        ${credsBlock || '<p class="hint">هذا المزوّد لا يحتاج بيانات اعتماد.</p>'}
        ${currentKey ? `<p class="hint">المفتاح الحالي: <code dir="ltr">${escapeHtml(currentKey)}</code> — اترك الحقل فارغًا للإبقاء عليه.</p>` : ''}
        <p class="hint">${icon('lock')} المفاتيح تُشفَّر على الخادم (AES-GCM) ولا تُقرأ مرة أخرى أبدًا. لا يُخزَّن أي مفتاح في المتصفح.</p>`;
}

function populateProviderSelect(selectedId) {
    const select = document.getElementById('aiProviderSelect');
    if (!select) return;

    const groups = {};
    for (const row of ctx.catalog) {
        (groups[row.kind] ||= []).push(row);
    }

    // المزوّدون الذكيّون أولًا، ثم البقية
    const order = [...AI_PROVIDER_KINDS, ...Object.keys(groups).filter((k) => !AI_PROVIDER_KINDS.includes(k))];

    select.innerHTML = order.filter((k) => groups[k]).map((kind) => `
        <optgroup label="${escapeHtml(PROVIDER_KIND_LABELS[kind] || kind)}">
            ${groups[kind].map((row) => `<option value="${escapeHtml(row.id)}" ${row.id === selectedId ? 'selected' : ''}>${escapeHtml(row.label_ar || row.label)}</option>`).join('')}
        </optgroup>`).join('');
}

function renderDescription(providerId) {
    const box = document.getElementById('aiProviderDescription');
    const row = findProvider(ctx.catalog, providerId);
    if (!box) return;
    if (!row?.description_ar && !row?.docs_url) { box.innerHTML = ''; return; }
    box.innerHTML = `
        ${row.description_ar ? escapeHtml(row.description_ar) : ''}
        ${row.docs_url ? ` <a href="${escapeHtml(row.docs_url)}" target="_blank" rel="noopener">التوثيق ↗</a>` : ''}`;
}

export function openModal(integrationId = null) {
    editingId = integrationId;
    const integration = integrationId ? ctx.integrations.find((i) => i.id === integrationId) : null;
    const providerId = integration?.provider || ctx.catalog[0]?.id;

    document.getElementById('aiProviderModalTitle').textContent = integration ? 'تعديل المزوّد' : 'إضافة مزوّد جديد';
    document.getElementById('aiProviderFormError').style.display = 'none';

    populateProviderSelect(providerId);
    const select = document.getElementById('aiProviderSelect');
    select.disabled = !!integration; // المزوّد لا يتغيّر بعد الإنشاء (نفس سلوك النظام الحالي)

    document.getElementById('aiProviderDisplayName').value = integration?.display_name || '';
    document.getElementById('aiProviderPriority').value = integration?.priority ?? 100;
    document.getElementById('aiProviderActive').checked = integration ? integration.is_active : true;

    renderDescription(providerId);
    document.getElementById('aiProviderDynamicFields').innerHTML = fieldsHtml(providerId, integration);
    bindProtocolChange(providerId);

    document.getElementById('aiProviderModal').classList.add('open');
    setTimeout(() => document.getElementById('aiProviderDisplayName')?.focus(), 60);
}

/** تغيير البروتوكول يحدّث الرابط الافتراضي المعروض كـ placeholder فورًا. */
function bindProtocolChange(providerId) {
    const protocolSelect = document.getElementById('aiProviderProtocol');
    const baseUrlInput = document.getElementById('aiProviderBaseUrl');
    if (!protocolSelect || !baseUrlInput || protocolSelect.tagName !== 'SELECT') return;

    protocolSelect.addEventListener('change', () => {
        const row = findProvider(ctx.catalog, providerId);
        baseUrlInput.placeholder = row?.default_endpoints?.[protocolSelect.value] || 'https://api.example.com/v1';
    });
}

export function closeModal() {
    document.getElementById('aiProviderModal')?.classList.remove('open');
    editingId = null;
}

export function onProviderChanged() {
    const providerId = document.getElementById('aiProviderSelect').value;
    renderDescription(providerId);
    document.getElementById('aiProviderDynamicFields').innerHTML = fieldsHtml(providerId);
    bindProtocolChange(providerId);

    const nameInput = document.getElementById('aiProviderDisplayName');
    if (!nameInput.value.trim()) nameInput.value = providerLabel(ctx.catalog, providerId);
}

export async function submitModal() {
    const errBox = document.getElementById('aiProviderFormError');
    const showError = (msg) => { errBox.textContent = msg; errBox.style.display = 'block'; };
    errBox.style.display = 'none';

    const providerId = document.getElementById('aiProviderSelect').value;
    const displayName = document.getElementById('aiProviderDisplayName').value.trim();
    const priorityRaw = document.getElementById('aiProviderPriority').value;
    const isActive = document.getElementById('aiProviderActive').checked;
    const protocol = document.getElementById('aiProviderProtocol')?.value || null;
    const baseUrl = document.getElementById('aiProviderBaseUrl')?.value.trim() || '';

    if (!displayName) return showError('اسم العرض مطلوب');

    const priority = priorityRaw === '' ? undefined : Number(priorityRaw);
    if (priority !== undefined && !Number.isFinite(priority)) return showError('الأولوية لازم تكون رقم');

    const row = findProvider(ctx.catalog, providerId);
    if (row?.requires_base_url && !baseUrl && !editingId) {
        return showError('هذا المزوّد يتطلب Base URL');
    }

    const credentials = {};
    let hasCredentials = false;
    for (const f of credentialFields(ctx.catalog, providerId)) {
        const el = document.getElementById(`aiCred-${f.key}`);
        const value = el?.value.trim();
        if (value) { credentials[f.key] = value; hasCredentials = true; }
        else if (f.required && !editingId) return showError(`${f.label_ar || f.label} مطلوب`);
    }

    const btn = document.getElementById('aiProviderSaveBtn');
    setBusy(btn, true, 'جاري الحفظ...');
    try {
        await api.saveIntegration({
            id: editingId || undefined,
            provider: editingId ? undefined : providerId,
            display_name: displayName,
            protocol,
            base_url: baseUrl,
            is_active: isActive,
            priority,
            credentials: hasCredentials ? credentials : undefined,
        });
        closeModal();
        toast(editingId ? 'تم تحديث المزوّد' : 'تمت إضافة المزوّد', 'success');
        await ctx.reload();
    } catch (err) {
        showError(err.message || 'فشل الحفظ');
    } finally {
        setBusy(btn, false);
    }
}

/* ====================  الإجراءات  ==================== */

export async function handleAction(action, id, buttonEl) {
    if (action === 'add') return openModal();
    if (action === 'edit') return openModal(id);

    const integration = ctx.integrations.find((i) => i.id === id);
    if (!integration && action !== 'add') return;

    if (action === 'test') {
        setBusy(buttonEl, true, 'جاري الاختبار...');
        try {
            const result = await api.testIntegration(id);
            toast(result.message + (result.latency_ms ? ` • ${result.latency_ms}ms` : ''), result.success ? 'success' : 'error');
            await ctx.reload();
        } catch (err) {
            toast(err.message || 'فشل الاختبار', 'error');
        } finally { setBusy(buttonEl, false); }
        return;
    }

    if (action === 'sync') {
        setBusy(buttonEl, true, 'جاري المزامنة...');
        try {
            const result = await api.syncModels(id);
            toast(result.message || `تم اكتشاف ${result.discovered || 0} موديل`, 'success');
            await ctx.reload();
        } catch (err) {
            toast(err.message || 'فشل جلب الموديلات', 'error');
        } finally { setBusy(buttonEl, false); }
        return;
    }

    if (action === 'toggle') {
        try {
            await api.saveIntegration({ id, is_active: !integration.is_active });
            toast(integration.is_active ? 'تم تعطيل المزوّد' : 'تم تفعيل المزوّد', 'success');
            await ctx.reload();
        } catch (err) { toast(err.message || 'فشل تحديث الحالة', 'error'); }
        return;
    }

    if (action === 'delete') {
        const modelCount = ctx.models.filter((m) => m.integration_id === id).length;
        const warning = `حذف "${integration.display_name}" نهائيًا؟\n\nسيُحذف معه ${modelCount} موديل مكتشف وأي قواعد توجيه تعتمد عليه.\nأي ميزة تستخدمه (رد الشات بوت مثلًا) ستتوقف.`;
        if (!confirm(warning)) return;
        try {
            await api.deleteIntegration(id);
            toast('تم حذف المزوّد', 'success');
            await ctx.reload();
        } catch (err) { toast(err.message || 'فشل الحذف', 'error'); }
    }
}

/** اختبار كل المزوّدين الفعّالين دفعة واحدة. */
export async function testAll(buttonEl) {
    const active = ctx.integrations.filter((i) => i.is_active);
    if (!active.length) return toast('لا يوجد مزوّد فعّال لاختباره', 'info');

    setBusy(buttonEl, true, `جاري اختبار ${active.length}...`);
    let ok = 0;
    for (const integration of active) {
        try {
            const result = await api.testIntegration(integration.id);
            if (result.success) ok++;
        } catch { /* الأخطاء تظهر في حالة البطاقة نفسها بعد إعادة التحميل */ }
    }
    setBusy(buttonEl, false);
    toast(`اكتمل الاختبار: ${ok} من ${active.length} متصل`, ok === active.length ? 'success' : 'error');
    await ctx.reload();
}
