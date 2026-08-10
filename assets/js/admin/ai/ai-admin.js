/**
 * وحدة تحكّم قسم AI داخل admin/mcp.html
 * --------------------------------------------------------
 * تحمّل الحالة مرة واحدة، وتوزّعها على الواجهات الفرعية، وتلتقط كل
 * الأحداث بالتفويض (event delegation) من جذر القسم — لذلك إعادة رسم أي
 * لوحة لا تتطلّب إعادة ربط مستمعات، ولا يوجد onclick داخل أي HTML مولّد.
 *
 * هذه الصفحة لوحة إدارة فقط: لا تنادي أي مزوّد، ولا ترى أي مفتاح.
 * كل تشغيل حقيقي يحدث في Edge Functions (ai-gateway / ai-session).
 */

import { fetchProviderCatalog, invalidateProviderCatalog } from './provider-registry.js';
import * as api from './ai-service.js';
import { toast, escapeHtml, debounce } from './ui/shared.js';

import * as providersView from './ui/providers-view.js';
import * as modelsView from './ui/models-view.js';
import * as routingView from './ui/routing-view.js';
import * as usageView from './ui/usage-view.js';
import * as devEnv from './ui/dev-environment.js';

/* ====================  الحالة المشتركة  ==================== */

const ctx = {
    catalog: [],
    integrations: [],
    models: [],
    routingRules: [],
    modes: [],
    usageSummary: [],
    usageEvents: [],
    usageByIntegration: new Map(),
    usageByModel: new Map(),
    reload,
    openDevEnvironment,
};

let activeSubTab = 'providers';
let mounted = false;
let loading = false;

const SUB_TABS = ['providers', 'models', 'routing', 'usage', 'dev'];

/* ====================  التحميل  ==================== */

function indexUsage() {
    ctx.usageByIntegration = new Map();
    ctx.usageByModel = new Map();

    for (const row of ctx.usageSummary) {
        ctx.usageByModel.set(`${row.integration_id}::${row.model_id}`, row);

        const acc = ctx.usageByIntegration.get(row.integration_id) || {
            requests: 0, errors: 0, total_tokens: 0, total_cost: 0,
            latencyWeighted: 0, latencyRequests: 0, avg_latency_ms: 0,
        };
        acc.requests += Number(row.requests) || 0;
        acc.errors += Number(row.errors) || 0;
        acc.total_tokens += Number(row.total_tokens) || 0;
        acc.total_cost += Number(row.total_cost) || 0;
        if (row.avg_latency_ms) {
            acc.latencyWeighted += Number(row.avg_latency_ms) * (Number(row.requests) || 0);
            acc.latencyRequests += Number(row.requests) || 0;
        }
        acc.avg_latency_ms = acc.latencyRequests ? acc.latencyWeighted / acc.latencyRequests : 0;
        ctx.usageByIntegration.set(row.integration_id, acc);
    }
}

export async function reload({ force = false } = {}) {
    if (loading) return;
    loading = true;
    try {
        if (force) invalidateProviderCatalog();

        // الاستخدام قد يفشل لو لم تُطبَّق الـ migration بعد — لا يجب أن يُسقط باقي القسم
        const [catalog, integrations, models, routingRules, modes] = await Promise.all([
            fetchProviderCatalog({ force }),
            api.fetchIntegrations(),
            api.fetchModels(),
            api.fetchRoutingRules().catch(() => []),
            api.fetchAgentModes().catch(() => []),
        ]);

        ctx.catalog = catalog;
        ctx.integrations = integrations;
        ctx.models = models;
        ctx.routingRules = routingRules;
        ctx.modes = modes;

        const [summary, events] = await Promise.all([
            api.fetchUsageSummary(usageView.sinceIso()).catch(() => []),
            api.fetchRecentUsageEvents(40).catch(() => []),
        ]);
        ctx.usageSummary = summary;
        ctx.usageEvents = events;
        indexUsage();

        renderHeaderStats();
        renderActive();
    } catch (err) {
        console.error('[AI] reload failed:', err);
        const grid = document.getElementById('aiProvidersGrid');
        if (grid) grid.innerHTML = `<div class="state-block"><h3>تعذّر تحميل قسم AI</h3><p>${escapeHtml(err.message)}</p></div>`;
    } finally {
        loading = false;
    }
}

function renderHeaderStats() {
    const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };

    const active = ctx.integrations.filter((i) => i.is_active).length;
    const connected = ctx.integrations.filter((i) => i.last_test_status === 'success').length;
    const totalCost = ctx.usageSummary.reduce((s, r) => s + (Number(r.total_cost) || 0), 0);

    set('devTabAiCount', String(ctx.integrations.length));
    set('aiStatProviders', `${active}/${ctx.integrations.length}`);
    set('aiStatConnected', String(connected));
    set('aiStatModels', String(ctx.models.length));
    set('aiStatCost', totalCost < 0.01 && totalCost > 0 ? `$${totalCost.toFixed(4)}` : `$${totalCost.toFixed(2)}`);
}

function renderActive() {
    if (activeSubTab === 'providers') { providersView.renderKindChips(); providersView.render(); }
    else if (activeSubTab === 'models') { modelsView.renderFilters(); modelsView.render(); }
    else if (activeSubTab === 'routing') routingView.render();
    else if (activeSubTab === 'usage') { usageView.renderPeriodChips(); usageView.render(); }
    else if (activeSubTab === 'dev') devEnv.render();
}

/* ====================  التبويبات الفرعية  ==================== */

export function switchSubTab(tab) {
    if (!SUB_TABS.includes(tab)) return;
    activeSubTab = tab;

    document.querySelectorAll('#aiSubTabs .api-subtab').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.aisubtab === tab);
    });
    SUB_TABS.forEach((t) => {
        const section = document.getElementById(`aiSubsection-${t}`);
        if (section) section.classList.toggle('active', t === tab);
    });

    renderActive();
}

function openDevEnvironment(options) {
    switchSubTab('dev');
    devEnv.render();
    devEnv.open(options);
}

/* ====================  التركيب  ==================== */

export async function mount() {
    if (mounted) { await reload(); return; }
    mounted = true;

    [providersView, modelsView, routingView, usageView, devEnv].forEach((view) => view.init(ctx));

    const root = document.getElementById('devSectionAi');
    if (!root) return;

    // كل الأحداث بالتفويض من جذر القسم — أي HTML يُعاد رسمه يظل يعمل بدون إعادة ربط
    root.addEventListener('click', onRootClick);
    root.addEventListener('change', onRootChange);

    document.getElementById('aiProviderSearch')?.addEventListener('input', debounce((e) => providersView.setSearch(e.target.value), 250));
    document.getElementById('aiModelsSearch')?.addEventListener('input', debounce((e) => modelsView.setSearch(e.target.value), 250));

    document.getElementById('aiDevInput')?.addEventListener('keydown', onComposerKey);
    root.addEventListener('keydown', (e) => {
        if (e.target?.id === 'aiDevInput') onComposerKey(e);
    });

    // إغلاق النوافذ بالنقر على الخلفية
    ['aiProviderModal', 'aiCapabilitiesModal', 'aiRuleModal', 'aiRoutePreviewModal'].forEach((id) => {
        document.getElementById(id)?.addEventListener('click', (e) => {
            if (e.target.id === id) closeAllModals();
        });
    });

    await reload();
    switchSubTab('providers');
}

export function closeAllModals() {
    providersView.closeModal();
    modelsView.closeCapabilitiesPanel();
    routingView.closeRuleModal();
    routingView.closePreview();
}

function onComposerKey(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        devEnv.send();
    }
}

/* ====================  توجيه الأحداث  ==================== */

function onRootClick(e) {
    const el = e.target.closest('[data-ai-action], [data-ai-kind], [data-model-action], [data-model-cat], [data-rule-action], [data-usage-period], [data-aisubtab], [data-dev-action], [data-dev-mode], [data-dev-bottom], [data-dev-session]');
    if (!el) return;

    if (el.dataset.aisubtab) return switchSubTab(el.dataset.aisubtab);
    if (el.dataset.aiKind) return providersView.setKindFilter(el.dataset.aiKind);
    if (el.dataset.modelCat) return modelsView.setCategoryFilter(el.dataset.modelCat);
    if (el.dataset.usagePeriod) return usageView.setPeriod(el.dataset.usagePeriod);
    if (el.dataset.devMode) return devEnv.setMode(el.dataset.devMode);
    if (el.dataset.devBottom) return devEnv.setBottomTab(el.dataset.devBottom);
    if (el.dataset.devSession) return devEnv.loadSession(el.dataset.devSession);
    if (el.dataset.devAction) return devEnv.handleAction(el.dataset.devAction, el);
    if (el.dataset.aiAction) return providersView.handleAction(el.dataset.aiAction, el.dataset.id, el);
    if (el.dataset.ruleAction) return routingView.handleAction(el.dataset.ruleAction, el.dataset.id, el);

    if (el.dataset.modelAction && el.tagName !== 'INPUT') {
        return modelsView.handleAction(el.dataset.modelAction, el.dataset.id, el);
    }
}

function onRootChange(e) {
    const el = e.target;
    if (el.id === 'aiModelsIntegrationFilter') return modelsView.setIntegrationFilter(el.value);
    if (el.id === 'aiModelCapabilityFilter') return modelsView.setCapabilityFilter(el.value);
    if (el.dataset.modelAction === 'enabled') return modelsView.handleAction('enabled', el.dataset.id, el);
}

/* ====================  ربط أزرار النوافذ (خارج جذر القسم)  ==================== */

export function bindModalControls() {
    const on = (id, event, handler) => document.getElementById(id)?.addEventListener(event, handler);

    on('aiAddProviderBtn', 'click', () => providersView.openModal());
    on('aiRefreshBtn', 'click', () => reload({ force: true }));
    on('aiTestAllBtn', 'click', (e) => providersView.testAll(e.currentTarget));

    on('aiProviderModalClose', 'click', providersView.closeModal);
    on('aiProviderCancelBtn', 'click', providersView.closeModal);
    on('aiProviderSaveBtn', 'click', providersView.submitModal);
    on('aiProviderSelect', 'change', providersView.onProviderChanged);

    on('aiCapabilitiesModalClose', 'click', modelsView.closeCapabilitiesPanel);
    on('aiCapabilitiesCancelBtn', 'click', modelsView.closeCapabilitiesPanel);
    on('aiCapabilitiesSaveBtn', 'click', (e) => modelsView.saveCapabilities(e.currentTarget));

    on('aiAddRuleBtn', 'click', () => routingView.openRuleModal());
    on('aiRuleModalClose', 'click', routingView.closeRuleModal);
    on('aiRuleCancelBtn', 'click', routingView.closeRuleModal);
    on('aiRuleSaveBtn', 'click', (e) => routingView.submitRule(e.currentTarget));
    on('aiRuleMatchKind', 'change', (e) => routingView.renderMatchValueField(e.target.value));
    on('aiRuleIntegration', 'change', routingView.onRuleIntegrationChanged);
    on('aiRoutePreviewClose', 'click', routingView.closePreview);
}
