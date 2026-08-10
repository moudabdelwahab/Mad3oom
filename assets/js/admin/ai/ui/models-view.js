/**
 * عرض الموديلات + نظام القدرات
 * --------------------------------------------------------
 * لا توجد أي قائمة موديلات مكتوبة في الكود. كل ما يُعرض هنا مصدره
 * external_integration_models، وهو جدول يُملأ بالاكتشاف من المزوّد.
 * القدرات تُعرض بجانب كل موديل حتى يعرف المستخدم "لماذا يختار هذا الموديل".
 */

import * as api from '../ai-service.js';
import { providerLabel } from '../provider-registry.js';
import {
    CAPABILITIES, MODEL_CATEGORIES, activeCapabilities, supportsDevEnvironment,
    formatContext, formatPricePerMillion, categoryLabel,
} from '../capability-registry.js';
import {
    escapeHtml, icon, toast, emptyBlock, formatNumber, formatCost, setBusy,
} from './shared.js';

let ctx = null;
let integrationFilter = 'all';
let categoryFilter = 'all';
let capabilityFilter = 'all';
let searchQuery = '';

export function init(sharedContext) { ctx = sharedContext; }

export function setIntegrationFilter(v) { integrationFilter = v; render(); }
export function setCategoryFilter(v) { categoryFilter = v; renderFilters(); render(); }
export function setCapabilityFilter(v) { capabilityFilter = v; renderFilters(); render(); }
export function setSearch(v) { searchQuery = (v || '').trim().toLowerCase(); render(); }

/* ====================  الشارات  ==================== */

function capabilityBadges(model) {
    const caps = activeCapabilities(model);
    if (!caps.length) return '<span class="ai-cap-badge ai-cap-none">بدون قدرات معروفة</span>';
    return caps.map((c) => `<span class="ai-cap-badge" title="${escapeHtml(c.en)}">${icon(c.icon, 11)} ${escapeHtml(c.label)}</span>`).join('');
}

function sourceChip(model) {
    const map = {
        manual: { label: 'معدّلة يدويًا', cls: 'ai-src-manual' },
        discovered: { label: 'من المزوّد', cls: 'ai-src-discovered' },
        heuristic: { label: 'تخمين', cls: 'ai-src-heuristic' },
    };
    const info = map[model.capabilities_source] || map.heuristic;
    return `<span class="ai-src-chip ${info.cls}" title="مصدر القدرات: التخمين مبني على اسم الموديل وقد لا يكون دقيقًا 100%">${escapeHtml(info.label)}</span>`;
}

/* ====================  الصفوف  ==================== */

function modelRow(model) {
    const integration = ctx.integrations.find((i) => i.id === model.integration_id);
    const usage = ctx.usageByModel.get(`${model.integration_id}::${model.model_id}`);
    const ctxWindow = formatContext(model.context_window);
    const inPrice = formatPricePerMillion(model.input_price);
    const outPrice = formatPricePerMillion(model.output_price);
    const canCode = supportsDevEnvironment(model);

    return `
    <div class="ai-model-row ${model.is_enabled ? '' : 'is-disabled'}" data-model-row-id="${model.id}">
        <div class="ai-model-main">
            <div class="ai-model-title">
                ${escapeHtml(model.display_name || model.model_id)}
                ${model.is_default ? '<span class="ai-default-chip">افتراضي</span>' : ''}
                <span class="ai-cat-chip">${escapeHtml(categoryLabel(model.category))}</span>
                ${sourceChip(model)}
            </div>
            <div class="ai-model-id" dir="ltr">${escapeHtml(model.model_id)}</div>
            <div class="ai-cap-row">${capabilityBadges(model)}</div>
            <div class="ai-model-meta">
                <span>${icon('cpu', 12)} ${escapeHtml(integration?.display_name || '—')} <span class="ai-dim">(${escapeHtml(providerLabel(ctx.catalog, integration?.provider))})</span></span>
                ${ctxWindow ? `<span title="نافذة السياق">${icon('expand', 12)} ${ctxWindow} توكن</span>` : ''}
                ${inPrice ? `<span title="سعر الإدخال لكل مليون توكن">${icon('dollar', 12)} إدخال ${inPrice}</span>` : ''}
                ${outPrice ? `<span title="سعر الإخراج لكل مليون توكن">${icon('dollar', 12)} إخراج ${outPrice}</span>` : ''}
                ${usage ? `<span title="الاستخدام خلال الفترة المختارة">${icon('activity', 12)} ${formatNumber(usage.requests)} طلب • ${formatCost(usage.total_cost)}</span>` : ''}
            </div>
        </div>

        <div class="ai-model-actions">
            ${canCode
                ? `<button class="btn btn-primary btn-sm" data-model-action="dev" data-id="${model.id}">${icon('code', 13)} افتح بيئة التطوير</button>`
                : `<button class="btn btn-secondary btn-sm" data-model-action="chat" data-id="${model.id}">${icon('message', 13)} ابدأ محادثة</button>`}
            <button class="btn btn-secondary btn-sm" data-model-action="caps" data-id="${model.id}">القدرات</button>
            ${model.is_default ? '' : `<button class="btn btn-secondary btn-sm" data-model-action="default" data-id="${model.id}">اجعله افتراضيًا</button>`}
            <label class="toggle-switch" title="${model.is_enabled ? 'مفعّل' : 'معطّل'}">
                <input type="checkbox" ${model.is_enabled ? 'checked' : ''} data-model-action="enabled" data-id="${model.id}">
                <span class="toggle-slider"></span>
            </label>
        </div>
    </div>`;
}

function matches(model) {
    if (integrationFilter !== 'all' && model.integration_id !== integrationFilter) return false;
    if (categoryFilter !== 'all' && model.category !== categoryFilter) return false;
    if (capabilityFilter !== 'all') {
        const cap = CAPABILITIES.find((c) => c.key === capabilityFilter);
        if (cap && !model[cap.column]) return false;
    }
    if (searchQuery && !`${model.model_id} ${model.display_name || ''}`.toLowerCase().includes(searchQuery)) return false;
    return true;
}

export function render() {
    const list = document.getElementById('aiModelsList');
    const countEl = document.getElementById('aiModelsCount');
    if (!list) return;

    if (!ctx.models.length) {
        list.innerHTML = emptyBlock({
            title: 'لا توجد موديلات مكتشفة بعد',
            body: 'اضغط "مزامنة الموديلات" على أي مزوّد في تبويب المزوّدين — القائمة تُجلب من المزوّد نفسه وليست مكتوبة في النظام.',
        });
        if (countEl) countEl.textContent = '0';
        return;
    }

    const visible = ctx.models.filter(matches)
        .sort((a, b) => Number(b.is_default) - Number(a.is_default)
            || (a.display_name || a.model_id).localeCompare(b.display_name || b.model_id));

    if (countEl) countEl.textContent = `${visible.length} / ${ctx.models.length}`;

    list.innerHTML = visible.length
        ? visible.map(modelRow).join('')
        : emptyBlock({ title: 'لا نتائج', body: 'لا يوجد موديل يطابق الفلاتر الحالية.' });
}

export function renderFilters() {
    const integrationSelect = document.getElementById('aiModelsIntegrationFilter');
    if (integrationSelect && integrationSelect.dataset.built !== String(ctx.integrations.length)) {
        integrationSelect.innerHTML = '<option value="all">كل المزوّدين</option>'
            + ctx.integrations.map((i) => `<option value="${i.id}">${escapeHtml(i.display_name)}</option>`).join('');
        integrationSelect.dataset.built = String(ctx.integrations.length);
        integrationSelect.value = integrationFilter;
    }

    const catWrap = document.getElementById('aiModelCategoryChips');
    if (catWrap) {
        const counts = ctx.models.reduce((acc, m) => {
            acc[m.category] = (acc[m.category] || 0) + 1;
            return acc;
        }, {});
        catWrap.innerHTML = MODEL_CATEGORIES
            .filter((c) => c.id === 'all' || counts[c.id])
            .map((c) => `<button class="mcp-chip ${categoryFilter === c.id ? 'active' : ''}" data-model-cat="${c.id}">
                ${escapeHtml(c.label)}<span class="filter-count">${c.id === 'all' ? ctx.models.length : counts[c.id]}</span>
            </button>`).join('');
    }

    const capSelect = document.getElementById('aiModelCapabilityFilter');
    if (capSelect && !capSelect.dataset.built) {
        capSelect.innerHTML = '<option value="all">أي قدرة</option>'
            + CAPABILITIES.map((c) => `<option value="${c.key}">${escapeHtml(c.label)} (${escapeHtml(c.en)})</option>`).join('');
        capSelect.dataset.built = '1';
    }
}

/* ====================  لوحة تعديل القدرات  ==================== */

export function openCapabilitiesPanel(modelRowId) {
    const model = ctx.models.find((m) => m.id === modelRowId);
    if (!model) return;

    const body = document.getElementById('aiCapabilitiesModalBody');
    document.getElementById('aiCapabilitiesModalTitle').textContent = model.display_name || model.model_id;

    body.innerHTML = `
        <p class="hint">القدرات تُكتشف تلقائيًا من المزوّد أو تُخمَّن من اسم الموديل. أي تعديل هنا يُعلَّم كـ
        <strong>"معدّلة يدويًا"</strong> ولا تدهسه أي مزامنة لاحقة.</p>
        <div class="ai-caps-grid">
            ${CAPABILITIES.map((c) => `
                <label class="ai-cap-toggle">
                    <input type="checkbox" data-cap-column="${c.column}" ${model[c.column] ? 'checked' : ''}>
                    <span>${icon(c.icon, 13)} ${escapeHtml(c.label)} <span class="ai-dim">${escapeHtml(c.en)}</span></span>
                </label>`).join('')}
        </div>
        <div class="form-group full" style="margin-top:1rem">
            <label>التصنيف المعروض</label>
            <select id="aiCapCategory">
                ${MODEL_CATEGORIES.filter((c) => c.id !== 'all').map((c) => `<option value="${c.id}" ${model.category === c.id ? 'selected' : ''}>${escapeHtml(c.label)}</option>`).join('')}
            </select>
        </div>`;

    body.dataset.modelRowId = modelRowId;
    document.getElementById('aiCapabilitiesModal').classList.add('open');
}

export function closeCapabilitiesPanel() {
    document.getElementById('aiCapabilitiesModal')?.classList.remove('open');
}

export async function saveCapabilities(buttonEl) {
    const body = document.getElementById('aiCapabilitiesModalBody');
    const modelRowId = body?.dataset.modelRowId;
    if (!modelRowId) return;

    const patch = { capabilities_source: 'manual', category: document.getElementById('aiCapCategory').value };
    body.querySelectorAll('[data-cap-column]').forEach((cb) => { patch[cb.dataset.capColumn] = cb.checked; });

    setBusy(buttonEl, true, 'جاري الحفظ...');
    try {
        await api.updateModel(modelRowId, patch);
        closeCapabilitiesPanel();
        toast('تم حفظ القدرات', 'success');
        await ctx.reload();
    } catch (err) {
        toast(err.message || 'فشل حفظ القدرات', 'error');
    } finally { setBusy(buttonEl, false); }
}

/* ====================  إضافة موديل يدويًا  ==================== */

/** القدرات التي يمكن ضبطها يدويًا (chat مفروضة دائمًا، وstreaming افتراضها نعم). */
const MANUAL_CAPABILITY_KEYS = ['reasoning', 'coding', 'tools', 'agent', 'vision', 'longContext'];

export function openAddModelModal() {
    const integrationSelect = document.getElementById('aiAddModelIntegration');
    if (!ctx.integrations.length) return toast('أضِف مزوّدًا أولًا', 'error');

    integrationSelect.innerHTML = ctx.integrations
        .map((i) => `<option value="${i.id}" ${i.id === integrationFilter ? 'selected' : ''}>${escapeHtml(i.display_name)}</option>`).join('');

    document.getElementById('aiAddModelId').value = '';
    document.getElementById('aiAddModelName').value = '';
    document.getElementById('aiAddModelContext').value = '';
    document.getElementById('aiAddModelError').style.display = 'none';

    document.getElementById('aiAddModelCaps').innerHTML = CAPABILITIES
        .filter((c) => MANUAL_CAPABILITY_KEYS.includes(c.key))
        .map((c) => `
            <label class="ai-cap-toggle">
                <input type="checkbox" data-manual-cap="${c.key}">
                <span>${icon(c.icon, 13)} ${escapeHtml(c.label)} <span class="ai-dim">${escapeHtml(c.en)}</span></span>
            </label>`).join('');

    document.getElementById('aiAddModelModal').classList.add('open');
    setTimeout(() => document.getElementById('aiAddModelId')?.focus(), 60);
}

export function closeAddModelModal() {
    document.getElementById('aiAddModelModal')?.classList.remove('open');
}

export async function submitAddModel(buttonEl) {
    const errBox = document.getElementById('aiAddModelError');
    const showError = (m) => { errBox.textContent = m; errBox.style.display = 'block'; };
    errBox.style.display = 'none';

    const integrationId = document.getElementById('aiAddModelIntegration').value;
    const modelId = document.getElementById('aiAddModelId').value.trim();
    if (!integrationId) return showError('اختر مزوّدًا');
    if (!modelId) return showError('معرّف الموديل مطلوب');

    const capabilities = {};
    document.querySelectorAll('#aiAddModelCaps [data-manual-cap]').forEach((cb) => {
        capabilities[cb.dataset.manualCap] = cb.checked;
    });

    const contextRaw = document.getElementById('aiAddModelContext').value;

    setBusy(buttonEl, true, 'جاري الإضافة...');
    try {
        const result = await api.addModelManually({
            integration_id: integrationId,
            model_id: modelId,
            display_name: document.getElementById('aiAddModelName').value.trim(),
            capabilities,
            context_window: contextRaw ? Number(contextRaw) : null,
        });
        closeAddModelModal();
        toast(result.message || 'تمت إضافة الموديل', 'success');
        await ctx.reload();
    } catch (err) {
        showError(err.message || 'فشل حفظ الموديل');
    } finally { setBusy(buttonEl, false); }
}

/* ====================  الإجراءات  ==================== */

export async function handleAction(action, modelRowId, element) {
    const model = ctx.models.find((m) => m.id === modelRowId);
    if (!model) return;

    if (action === 'caps') return openCapabilitiesPanel(modelRowId);

    if (action === 'default') {
        try {
            await api.setDefaultModel(model.integration_id, modelRowId);
            toast('تم تعيين الموديل الافتراضي', 'success');
            await ctx.reload();
        } catch (err) { toast(err.message || 'فشل التعيين', 'error'); }
        return;
    }

    if (action === 'enabled') {
        try {
            await api.updateModel(modelRowId, { is_enabled: element.checked });
            await ctx.reload();
        } catch (err) {
            element.checked = !element.checked;
            toast(err.message || 'فشل تحديث الحالة', 'error');
        }
        return;
    }

    if (action === 'dev' || action === 'chat') {
        ctx.openDevEnvironment({
            integrationId: model.integration_id,
            modelId: model.model_id,
            // الموديل البرمجي يبدأ في وضع Code، وغيره يبدأ في محادثة عادية
            mode: action === 'dev' ? 'code' : 'chat',
        });
    }
}
