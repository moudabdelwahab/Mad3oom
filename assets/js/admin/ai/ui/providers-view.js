/**
 * عرض المزوّدين + فورم الإضافة/التعديل الديناميكي
 * --------------------------------------------------------
 * كل ما يظهر في الفورم (البروتوكولات، الرابط الافتراضي، حقول الاعتماد)
 * مبني من صف الكتالوج. لا توجد أي قائمة مزوّدين مكتوبة هنا.
 */

import * as api from '../ai-service.js';
import {
    findProvider, providerLabel, effectiveProtocol, effectiveBaseUrl,
    credentialFields, supportsModelDiscovery, maskedKey, resolveEndpoints, looksMasked,
    PROVIDER_KIND_LABELS, PROTOCOL_LABELS, AI_PROVIDER_KINDS,
} from '../provider-registry.js';
import {
    escapeHtml, icon, toast, loadingBlock, errorBlock, emptyBlock,
    statusChip, formatNumber, formatCost, formatDate, setBusy,
} from './shared.js';

let ctx = null;              // مرجع للحالة المشتركة من ai-admin.js
let searchQuery = '';
let kindFilter = 'all';

/**
 * آخر فشل لكل تكامل مع كل تفاصيله (الرابط الذي جُرّب فعلًا + سبب مرجّح).
 * الـ toast يختفي بعد ثوانٍ، وهذه المعلومة هي بالضبط ما يحتاجه المستخدم
 * ليقرأه بتأنٍّ، فتبقى معروضة على البطاقة حتى تنجح العملية.
 */
const diagnostics = new Map();

export function init(sharedContext) {
    ctx = sharedContext;
}

function diagnosticHtml(integrationId) {
    const d = diagnostics.get(integrationId);
    if (!d) return '';
    return `
    <div class="ai-diagnostic">
        <div class="ai-diagnostic-head">${icon('alert', 13)} <strong>${escapeHtml(d.title)}</strong></div>
        <div class="ai-diagnostic-msg">${escapeHtml(d.message)}</div>
        ${d.endpoint ? `<div class="ai-diagnostic-row"><span>الرابط الذي جُرّب</span><code dir="ltr">${escapeHtml(d.endpoint)}</code></div>` : ''}
        ${d.protocol ? `<div class="ai-diagnostic-row"><span>البروتوكول</span><code dir="ltr">${escapeHtml(d.protocol)}</code></div>` : ''}
        ${attemptsHtml(d.attempts)}
        ${d.hint ? `<div class="ai-diagnostic-hint">${escapeHtml(d.hint)}</div>` : ''}
        <div class="ai-diagnostic-actions">
            <button class="btn btn-edit btn-sm" data-ai-action="edit" data-id="${integrationId}">تعديل الإعدادات</button>
            <button class="btn btn-secondary btn-sm" data-ai-action="dismiss-diagnostic" data-id="${integrationId}">إخفاء</button>
        </div>
    </div>`;
}

/**
 * كل المسارات التي جرّبها الـ Gateway فعلًا.
 * بدونها يرى المستخدم رابطًا واحدًا فاشلًا ويظنّ أن هذا كل ما حدث، بينما
 * البوابة الواحدة قد تعرض الموديلات على مسار بروتوكول آخر تمامًا.
 */
function attemptsHtml(attempts) {
    if (!Array.isArray(attempts) || attempts.length < 2) return '';
    const rows = attempts.map((a) => `
        <div class="ai-attempt-row ${a.ok ? 'is-ok' : 'is-fail'}">
            <span class="ai-endpoint-proto">${escapeHtml(a.protocol || '—')}</span>
            <code dir="ltr">${escapeHtml(a.endpoint || 'بلا رابط')}</code>
            <span class="ai-attempt-note">${escapeHtml(a.ok ? `${a.count} موديل` : (a.error || 'فشل'))}</span>
        </div>`).join('');
    return `<details class="ai-attempts"><summary>المسارات المجرَّبة (${attempts.length})</summary>${rows}</details>`;
}

/** يستخرج تفاصيل التشخيص من رد الـ Gateway (يرجّع endpoint/hint/attempts مع كل فشل). */
function recordDiagnostic(integrationId, title, err) {
    const details = err?.details || {};
    diagnostics.set(integrationId, {
        title,
        message: err?.message || 'خطأ غير معروف',
        endpoint: details.endpoint || null,
        protocol: details.protocol || null,
        attempts: Array.isArray(details.attempts) ? details.attempts : null,
        hint: details.hint || null,
    });
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
        ${diagnosticHtml(integration.id)}
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

    // رابط لكل بروتوكول: مزوّد يدعم anthropic وopenai معًا يحتاج رابطين
    // مختلفين (anthropic بلا /v1 لأنه يضيف /v1/messages، وopenai بـ /v1 لأنه
    // يضيف /chat/completions). رابط واحد مشترك يكسر أحدهما حتمًا.
    const savedBaseUrls = integration?.base_urls || {};
    const legacyBase = integration?.base_url || meta.base_url || '';

    const baseUrlInputs = protocols.map((p) => {
        const saved = savedBaseUrls[p] || (p === currentProtocol ? legacyBase : '');
        const isDiscovery = discoveryProtocolOf(row) === p;
        const roles = [
            p === currentProtocol ? 'المحادثة' : '',
            isDiscovery ? 'اكتشاف الموديلات' : '',
        ].filter(Boolean).join(' + ');

        return `
        <div class="form-group full">
            <label>
                Base URL — ${escapeHtml(PROTOCOL_LABELS[p] || p)}
                ${roles ? `<span class="ai-chip-soft">${escapeHtml(roles)}</span>` : ''}
            </label>
            <input type="text" class="ai-base-url-input" data-protocol="${escapeHtml(p)}" id="aiBaseUrl-${escapeHtml(p)}" dir="ltr"
                   placeholder="${escapeHtml(row.default_endpoints?.[p] || 'https://api.example.com')}"
                   value="${escapeHtml(saved)}">
        </div>`;
    }).join('');

    const baseUrlBlock = row.allows_base_url ? `
        <div class="ai-section-label">${icon('globe')} الروابط الأساسية</div>
        ${baseUrlInputs}
        <span class="hint">اترك أي حقل فارغًا لاستخدام رابط الكتالوج. كل بروتوكول له رابط مستقل لأن كلًا منهم يضيف مسارًا مختلفًا بعده.</span>
        <div class="ai-endpoints-preview" id="aiEndpointPreview"></div>` : '';

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

/**
 * معاينة حيّة للروابط النهائية.
 * أهم عنصر في هذا الفورم: يرى المستخدم بالضبط ما سيُنادى قبل الحفظ، فيكتشف
 * فورًا لو أن Base URL بلا /v1 سيولّد مسارًا يشير للموقع بدل واجهة الـ API.
 */
function renderEndpointPreview(providerId) {
    const box = document.getElementById('aiEndpointPreview');
    if (!box) return;

    const row = findProvider(ctx.catalog, providerId);
    if (!row) { box.innerHTML = ''; return; }

    const selected = document.getElementById('aiProviderProtocol')?.value || row.protocols?.[0] || '';
    const discovery = discoveryProtocolOf(row);
    const typed = collectBaseUrls();

    const rows = (row.protocols || []).map((p) => {
        const endpoints = resolveEndpoints(ctx.catalog, providerId, p, typed[p] || '');
        const roles = [p === selected ? 'المحادثة' : '', p === discovery ? 'الاكتشاف' : ''].filter(Boolean).join(' + ');

        if (!endpoints.base) {
            return `<div class="ai-endpoint-row"><span class="ai-endpoint-proto">${escapeHtml(PROTOCOL_LABELS[p] || p)}</span>
                <span class="ai-dim">لا يوجد رابط — أضِفه أعلاه</span></div>`;
        }

        // رقم إصدار مكرّر (/v1/v1/) = الرابط الأساسي يتضمّن مسارًا يضيفه البروتوكول بنفسه
        const duplicated = /\/v\d+\/v\d+\//.test(endpoints.chat + '/');
        const missingV1 = p === 'openai' && !/\/v\d+(\/|$)/.test(endpoints.base);

        return `
        <div class="ai-endpoint-row">
            <span class="ai-endpoint-proto">${escapeHtml(PROTOCOL_LABELS[p] || p)}${roles ? ` <span class="ai-chip-soft">${escapeHtml(roles)}</span>` : ''}</span>
        </div>
        <div class="ai-endpoint-row"><span class="ai-endpoint-proto ai-dim">توليد</span><code dir="ltr">${escapeHtml(endpoints.chat)}</code></div>
        <div class="ai-endpoint-row"><span class="ai-endpoint-proto ai-dim">موديلات</span><code dir="ltr">${escapeHtml(endpoints.models)}</code></div>
        ${duplicated ? warnHtml(
            `رقم الإصدار مكرّر في المسار. بروتوكول ${PROTOCOL_LABELS[p] || p} يضيف مسار الإصدار بنفسه، فالرابط الأساسي يجب أن يكون بدونه.`,
            p, endpoints.base.replace(/\/v\d+$/, '')) : ''}
        ${missingV1 && !duplicated ? warnHtml(
            'هذا البروتوكول يضيف /chat/completions فقط، فالرابط الأساسي يجب أن ينتهي بمسار الـ API (غالبًا /v1) وإلا ذهب النداء لمسار الموقع.',
            p, `${endpoints.base}/v1`) : ''}`;
    }).join('');

    box.innerHTML = rows;

    box.querySelectorAll('[data-fix-protocol]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const input = document.getElementById(`aiBaseUrl-${btn.dataset.fixProtocol}`);
            if (input) { input.value = btn.dataset.suggest; renderEndpointPreview(providerId); }
        });
    });
}

function warnHtml(message, protocol, suggestion) {
    return `<div class="ai-endpoint-warn">
        ${icon('alert', 13)}
        <span>${escapeHtml(message)}</span>
        ${suggestion ? `<button type="button" class="btn btn-secondary btn-sm" data-fix-protocol="${escapeHtml(protocol)}" data-suggest="${escapeHtml(suggestion)}">استخدم <span dir="ltr">${escapeHtml(suggestion)}</span></button>` : ''}
    </div>`;
}

/** بروتوكول اكتشاف الموديلات — نفس منطق الخادم. */
function discoveryProtocolOf(row) {
    if (row?.models_discovery?.supported === false) return null;
    const declared = row?.models_discovery?.protocol;
    if (declared && row.protocols?.includes(declared)) return declared;
    return row?.protocols?.[0] || null;
}

/** قيم حقول الروابط الحالية مفهرسة بالبروتوكول. */
function collectBaseUrls() {
    const out = {};
    document.querySelectorAll('.ai-base-url-input').forEach((el) => {
        const value = el.value.trim();
        if (value) out[el.dataset.protocol] = value.replace(/\/+$/, '');
    });
    return out;
}

/** يربط تحديث المعاينة بتغيّر البروتوكول أو الرابط. */
function bindProtocolChange(providerId) {
    const protocolSelect = document.getElementById('aiProviderProtocol');

    protocolSelect?.addEventListener('change', () => renderEndpointPreview(providerId));
    document.querySelectorAll('.ai-base-url-input').forEach((el) => {
        el.addEventListener('input', () => renderEndpointPreview(providerId));
    });
    renderEndpointPreview(providerId);
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
    const baseUrls = collectBaseUrls();
    const baseUrl = baseUrls[protocol] || '';

    if (!displayName) return showError('اسم العرض مطلوب');

    const priority = priorityRaw === '' ? undefined : Number(priorityRaw);
    if (priority !== undefined && !Number.isFinite(priority)) return showError('الأولوية لازم تكون رقم');

    const row = findProvider(ctx.catalog, providerId);
    if (row?.requires_base_url && !baseUrl && !editingId) {
        return showError(`هذا المزوّد يتطلب Base URL لبروتوكول ${PROTOCOL_LABELS[protocol] || protocol}`);
    }

    const credentials = {};
    let hasCredentials = false;
    for (const f of credentialFields(ctx.catalog, providerId)) {
        const el = document.getElementById(`aiCred-${f.key}`);
        const value = el?.value.trim();
        if (value) {
            // حارس ضد أشهر سبب لـ 401: نسخ القيمة المقنّعة المعروضة في جدول
            // مفاتيح المزوّد (sk-fSDF***) بدل استخدام زر النسخ.
            if (f.type === 'password' && looksMasked(value)) {
                return showError(`قيمة "${f.label_ar || f.label}" تبدو مقنّعة أو ناقصة. انسخ المفتاح الكامل من زر النسخ عند المزوّد، لا من الخانة التي تعرضه بنجوم.`);
            }
            credentials[f.key] = value;
            hasCredentials = true;
        } else if (f.required && !editingId) {
            return showError(`${f.label_ar || f.label} مطلوب`);
        }
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
            base_urls: baseUrls,
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

    if (action === 'dismiss-diagnostic') {
        diagnostics.delete(id);
        render();
        return;
    }

    if (action === 'test') {
        setBusy(buttonEl, true, 'جاري الاختبار...');
        try {
            const result = await api.testIntegration(id);
            if (result.success) diagnostics.delete(id);
            else recordDiagnostic(id, 'فشل اختبار الاتصال', { message: result.message, details: result });
            toast(result.message + (result.latency_ms ? ` • ${result.latency_ms}ms` : ''), result.success ? 'success' : 'error');
            await ctx.reload();
        } catch (err) {
            recordDiagnostic(id, 'فشل اختبار الاتصال', err);
            toast(err.message || 'فشل الاختبار', 'error');
            render();
        } finally { setBusy(buttonEl, false); }
        return;
    }

    if (action === 'sync') {
        setBusy(buttonEl, true, 'جاري المزامنة...');
        try {
            const result = await api.syncModels(id);
            diagnostics.delete(id);
            if (!result.discovered) {
                toast('لم يرجع المزوّد أي موديل — تقدر تضيف موديلًا يدويًا من تبويب الموديلات', 'info');
            } else {
                toast(result.message || `تم اكتشاف ${result.discovered} موديل`, 'success');
            }
            await ctx.reload();
        } catch (err) {
            recordDiagnostic(id, 'فشل جلب الموديلات', err);
            toast(err.message || 'فشل جلب الموديلات', 'error');
            render();
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
