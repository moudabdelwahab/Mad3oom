/**
 * التوجيه وسلسلة الاحتياطي (Routing & Fallback)
 * --------------------------------------------------------
 * سلسلة واحدة = كل القواعد التي تشترك في (نوع المطابقة + القيمة)، مرتّبة
 * بـ position. الأول هو الأساسي، وما بعده احتياطي بالترتيب.
 * زر "معاينة" يسأل الـ Gateway عن السلسلة الفعلية دون أي نداء لمزوّد.
 */

import * as api from '../ai-service.js';
import { providerLabel } from '../provider-registry.js';
import { escapeHtml, icon, toast, emptyBlock, loadingBlock, setBusy } from './shared.js';

let ctx = null;
let editingRuleId = null;

export function init(sharedContext) { ctx = sharedContext; }

const MATCH_KIND_LABELS = {
    mode: 'حسب الوضع',
    capability: 'حسب القدرة المطلوبة',
    tag: 'حسب الوسم',
    default: 'الافتراضي العام',
};

function chainKey(rule) {
    return `${rule.match_kind}::${rule.match_value || ''}`;
}

function chainTitle(rule) {
    if (rule.match_kind === 'default') return 'الافتراضي العام (يُستخدم عند عدم تطابق أي قاعدة)';
    const modeLabel = ctx.modes.find((m) => m.id === rule.match_value)?.label_ar;
    return `${MATCH_KIND_LABELS[rule.match_kind]}: ${escapeHtml(modeLabel || rule.match_value || '—')}`;
}

function ruleRow(rule, index) {
    const integration = ctx.integrations.find((i) => i.id === rule.integration_id);
    const roleLabel = index === 0 ? 'أساسي' : `احتياطي ${index}`;

    return `
    <div class="ai-rule-row ${rule.is_active ? '' : 'is-disabled'}">
        <span class="ai-rule-role ${index === 0 ? 'is-primary' : ''}">${escapeHtml(roleLabel)}</span>
        <div class="ai-rule-body">
            <div class="ai-rule-target">
                ${escapeHtml(integration?.display_name || 'تكامل محذوف')}
                <span class="ai-dim">(${escapeHtml(providerLabel(ctx.catalog, integration?.provider))})</span>
                ${integration && !integration.is_active ? '<span class="disabled-chip">المزوّد معطّل</span>' : ''}
            </div>
            <div class="ai-rule-model" dir="ltr">${escapeHtml(rule.model_id || '— الموديل الافتراضي للمزوّد —')}</div>
        </div>
        <div class="ai-rule-actions">
            <button class="btn btn-secondary btn-sm" data-rule-action="edit" data-id="${rule.id}">تعديل</button>
            <button class="btn btn-delete btn-sm" data-rule-action="delete" data-id="${rule.id}">حذف</button>
        </div>
    </div>`;
}

export function render() {
    const container = document.getElementById('aiRoutingList');
    if (!container) return;

    if (!ctx.routingRules.length) {
        container.innerHTML = emptyBlock({
            title: 'لا توجد قواعد توجيه',
            body: 'بدون قواعد، النظام يستخدم المزوّد الافتراضي في إعدادات الشات بوت، ثم أعلى مزوّد فعّال حسب الأولوية. أضِف قاعدة لتوجيه كل وضع لموديل مناسب (وضع البرمجة لموديل برمجة، والمحادثة البسيطة لموديل أرخص).',
            actionLabel: '+ إضافة قاعدة',
            actionAttr: 'data-rule-action="add"',
        });
        return;
    }

    const chains = new Map();
    for (const rule of ctx.routingRules) {
        const key = chainKey(rule);
        if (!chains.has(key)) chains.set(key, []);
        chains.get(key).push(rule);
    }

    container.innerHTML = [...chains.values()].map((rules) => {
        const sorted = [...rules].sort((a, b) => a.position - b.position);
        return `
        <div class="mcp-card ai-chain-card">
            <div class="card-row">
                <div class="card-head">
                    <div class="card-icon">${icon('route', 20)}</div>
                    <div class="card-title-wrap">
                        <div class="card-title">${chainTitle(sorted[0])}</div>
                        <div class="card-subtitle">${sorted.length} خطوة في السلسلة</div>
                    </div>
                </div>
                <button class="btn btn-test btn-sm" data-rule-action="preview"
                        data-match-kind="${escapeHtml(sorted[0].match_kind)}"
                        data-match-value="${escapeHtml(sorted[0].match_value || '')}">معاينة المسار</button>
            </div>
            <div class="ai-chain-rows">${sorted.map(ruleRow).join('')}</div>
        </div>`;
    }).join('');
}

/* ====================  فورم القاعدة  ==================== */

function modelOptionsFor(integrationId, selected) {
    const models = ctx.models.filter((m) => m.integration_id === integrationId && m.is_enabled);
    return '<option value="">— الموديل الافتراضي للمزوّد —</option>'
        + models.map((m) => `<option value="${escapeHtml(m.model_id)}" ${m.model_id === selected ? 'selected' : ''}>${escapeHtml(m.display_name || m.model_id)}</option>`).join('');
}

export function openRuleModal(ruleId = null) {
    editingRuleId = ruleId;
    const rule = ruleId ? ctx.routingRules.find((r) => r.id === ruleId) : null;

    document.getElementById('aiRuleModalTitle').textContent = rule ? 'تعديل قاعدة التوجيه' : 'إضافة قاعدة توجيه';
    document.getElementById('aiRuleFormError').style.display = 'none';

    document.getElementById('aiRuleName').value = rule?.name || '';
    document.getElementById('aiRuleMatchKind').value = rule?.match_kind || 'mode';
    document.getElementById('aiRulePosition').value = rule?.position ?? 0;
    document.getElementById('aiRuleActive').checked = rule ? rule.is_active : true;

    const integrationSelect = document.getElementById('aiRuleIntegration');
    integrationSelect.innerHTML = ctx.integrations
        .filter((i) => i.is_active)
        .map((i) => `<option value="${i.id}" ${i.id === rule?.integration_id ? 'selected' : ''}>${escapeHtml(i.display_name)}</option>`).join('');

    renderMatchValueField(rule?.match_kind || 'mode', rule?.match_value);
    document.getElementById('aiRuleModel').innerHTML = modelOptionsFor(integrationSelect.value, rule?.model_id);

    document.getElementById('aiRuleModal').classList.add('open');
}

export function closeRuleModal() {
    document.getElementById('aiRuleModal')?.classList.remove('open');
    editingRuleId = null;
}

/** قيمة المطابقة تختلف شكلًا حسب النوع: قائمة أوضاع، أو قائمة قدرات، أو نص حر. */
export function renderMatchValueField(matchKind, currentValue) {
    const wrap = document.getElementById('aiRuleMatchValueWrap');
    if (!wrap) return;

    if (matchKind === 'default') {
        wrap.innerHTML = '<p class="hint">القاعدة الافتراضية لا تحتاج قيمة — تُستخدم عندما لا يتطابق أي شيء آخر.</p>';
        return;
    }

    if (matchKind === 'mode') {
        wrap.innerHTML = `
            <label>الوضع <span class="req">*</span></label>
            <select id="aiRuleMatchValue">
                ${ctx.modes.map((m) => `<option value="${escapeHtml(m.id)}" ${m.id === currentValue ? 'selected' : ''}>${escapeHtml(m.label_ar || m.label)} (${escapeHtml(m.label)})</option>`).join('')}
            </select>`;
        return;
    }

    if (matchKind === 'capability') {
        const caps = ['reasoning', 'coding', 'agent', 'vision', 'tools', 'longContext'];
        wrap.innerHTML = `
            <label>القدرة المطلوبة <span class="req">*</span></label>
            <select id="aiRuleMatchValue">
                ${caps.map((c) => `<option value="${c}" ${c === currentValue ? 'selected' : ''}>${c}</option>`).join('')}
            </select>`;
        return;
    }

    wrap.innerHTML = `
        <label>الوسم <span class="req">*</span></label>
        <input type="text" id="aiRuleMatchValue" value="${escapeHtml(currentValue || '')}" placeholder="critical">`;
}

export function onRuleIntegrationChanged() {
    const integrationId = document.getElementById('aiRuleIntegration').value;
    document.getElementById('aiRuleModel').innerHTML = modelOptionsFor(integrationId, null);
}

export async function submitRule(buttonEl) {
    const errBox = document.getElementById('aiRuleFormError');
    const showError = (m) => { errBox.textContent = m; errBox.style.display = 'block'; };
    errBox.style.display = 'none';

    const matchKind = document.getElementById('aiRuleMatchKind').value;
    const matchValue = document.getElementById('aiRuleMatchValue')?.value || null;
    const integrationId = document.getElementById('aiRuleIntegration').value;
    const name = document.getElementById('aiRuleName').value.trim();

    if (!integrationId) return showError('اختر مزوّدًا');
    if (matchKind !== 'default' && !matchValue) return showError('قيمة المطابقة مطلوبة');

    setBusy(buttonEl, true, 'جاري الحفظ...');
    try {
        await api.saveRoutingRule({
            id: editingRuleId || undefined,
            name: name || `${MATCH_KIND_LABELS[matchKind]} ${matchValue || ''}`.trim(),
            match_kind: matchKind,
            match_value: matchKind === 'default' ? null : matchValue,
            integration_id: integrationId,
            model_id: document.getElementById('aiRuleModel').value || null,
            position: Number(document.getElementById('aiRulePosition').value) || 0,
            is_active: document.getElementById('aiRuleActive').checked,
        });
        closeRuleModal();
        toast('تم حفظ القاعدة', 'success');
        await ctx.reload();
    } catch (err) {
        showError(err.message || 'فشل الحفظ');
    } finally { setBusy(buttonEl, false); }
}

export async function handleAction(action, id, element) {
    if (action === 'add') return openRuleModal();
    if (action === 'edit') return openRuleModal(id);

    if (action === 'delete') {
        if (!confirm('حذف هذه الخطوة من سلسلة التوجيه؟')) return;
        try {
            await api.deleteRoutingRule(id);
            toast('تم الحذف', 'success');
            await ctx.reload();
        } catch (err) { toast(err.message || 'فشل الحذف', 'error'); }
        return;
    }

    if (action === 'preview') {
        const matchKind = element.dataset.matchKind;
        const matchValue = element.dataset.matchValue;
        setBusy(element, true, 'جاري...');
        try {
            const result = await api.previewRoute({
                mode: matchKind === 'mode' ? matchValue : undefined,
                capability: matchKind === 'capability' ? matchValue : undefined,
            });
            showPreview(result.chain || []);
        } catch (err) {
            toast(err.message || 'فشلت المعاينة', 'error');
        } finally { setBusy(element, false); }
    }
}

function showPreview(chain) {
    const body = document.getElementById('aiRoutePreviewBody');
    body.innerHTML = chain.length
        ? `<p class="hint">هذا هو الترتيب الفعلي الذي سينفّذه الـ Gateway. لم يُرسل أي طلب لأي مزوّد.</p>
           <ol class="ai-preview-list">
             ${chain.map((step) => `
               <li>
                 <strong>${escapeHtml(step.role === 'primary' ? 'أساسي' : 'احتياطي ' + step.position)}</strong>
                 — ${escapeHtml(step.integration_name)}
                 <span class="ai-dim">(${escapeHtml(step.provider)} / ${escapeHtml(step.protocol)})</span>
                 <div class="ai-model-id" dir="ltr">${escapeHtml(step.model || 'بدون موديل محدّد')}</div>
                 <div class="ai-dim">مصدر القرار: <code dir="ltr">${escapeHtml(step.origin)}</code></div>
               </li>`).join('')}
           </ol>`
        : '<p class="hint">لن يجد النظام أي مزوّد صالح لهذا المسار. أضِف قاعدة أو فعّل مزوّدًا.</p>';

    document.getElementById('aiRoutePreviewModal').classList.add('open');
}

export function closePreview() {
    document.getElementById('aiRoutePreviewModal')?.classList.remove('open');
}
