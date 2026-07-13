/* =====================================================================
   inspector.js
   ---------------------------------------------------------------------
   The right-hand "Inspector" panel: renders settings for whatever is
   currently selected (a single node, an edge, multiple nodes, or nothing
   -> workflow-level settings), and dynamically builds form controls from
   each node type's `config_schema.fields` (text/select/number/tags/
   key-value/variable-picker/staff-picker/etc).

   Depends on `Canvas` (to trigger re-renders / history pushes / deletes)
   and on the `ui` service locator in state.js to reach the builder shell's
   `updateSaveState`/`renderTabbar` without importing builder-shell.js
   directly (which would create a cycle, since builder-shell imports this
   module's `renderInspector`).
   ===================================================================== */
import { escapeHtml, ic, icFilled, nodeIcon, isStaffFieldOptional, promptDialog, CATEGORY_LABELS } from './common.js';
import { appState, ui, activeSession, sessionTriggerSummary } from './state.js';
import { Canvas } from './canvas.js';

/* ---------------------------------------------------------------------
   تبسيط أسماء المتغيرات التقنية (dot-notation) إلى تسميات عربية بسيطة تناسب
   المستخدم العادي — بدل عرض "subscription.user_id" نعرض "معرّف المستخدم".
   يعمل حصرًا على العرض (label)؛ القيمة الفعلية المُدرَجة في الحقل تبقى {{subscription.user_id}} كما هي.
   --------------------------------------------------------------------- */
const VAR_WORD_MAP = {
    user: 'المستخدم', customer: 'العميل', ticket: 'التذكرة', subscription: 'الاشتراك',
    order: 'الطلب', payment: 'الدفعة', invoice: 'الفاتورة', agent: 'الموظف', staff: 'الموظف',
    email: 'البريد الإلكتروني', phone: 'الهاتف', name: 'الاسم', full: 'الكامل',
    plan: 'الخطة', status: 'الحالة', amount: 'المبلغ', total: 'الإجمالي', price: 'السعر',
    reason: 'السبب', reference: 'المرجع', number: 'الرقم', code: 'الرمز', title: 'العنوان',
    content: 'المحتوى', body: 'النص', type: 'النوع', category: 'التصنيف', priority: 'الأولوية',
    subject: 'الموضوع', message: 'الرسالة', url: 'الرابط', link: 'الرابط', channel: 'القناة',
    notification: 'الإشعار', id: 'الرقم', end: 'الانتهاء', start: 'البدء',
    created: 'الإنشاء', updated: 'التحديث'
};
function humanizeVarKey(key) {
    const lastSeg = String(key || '').split('.').pop();
    const tokens = lastSeg.split('_').filter(Boolean).map(t => t.toLowerCase());
    if (!tokens.length) return null;
    const last = tokens[tokens.length - 1];
    if (tokens.length > 1 && last === 'id') {
        const base = tokens.slice(0, -1).map(t => VAR_WORD_MAP[t]).filter(Boolean).join(' ');
        return base ? `معرّف ${base}` : 'المعرّف';
    }
    if (tokens.length > 1 && (last === 'date' || last === 'at')) {
        const base = tokens.slice(0, -1).map(t => VAR_WORD_MAP[t]).filter(Boolean).join(' ');
        return base ? `تاريخ ${base}` : 'التاريخ';
    }
    const mapped = tokens.map(t => VAR_WORD_MAP[t]).filter(Boolean);
    return mapped.length ? mapped.join(' ') : null;
}
/* التسمية النهائية المعروضة للمستخدم لخيار متغيّر — تُخفي الاسم التقني تمامًا؛
   إن تعذّرت الترجمة تُعرض فقط تسمية العنصر المصدر (from) دون أي صياغة تقنية */
function friendlyVarLabel(u) {
    const humanized = humanizeVarKey(u.v);
    return humanized ? `${humanized} — ${u.from}` : u.from;
}

/* ---------------------------------------------------------------------
   تسميات عربية لقيم قوائم select الفعلية (وليست فقط أسماء المتغيرات) — هذه
   القيم مأخوذة حرفيًا من config_schema.fields[].options في wf_node_types
   (مُدقَّقة من قاعدة البيانات الفعلية)، وكانت تُعرض للمستخدم كما هي بالإنجليزية
   التقنية (مثال: "in-progress" بدل "قيد التنفيذ"). القيمة المخزَّنة في
   node.config لا تتغيّر أبدًا — هذه التسمية للعرض فقط.
   ملاحظة: قيم HTTP method (GET/POST/...) في عقدة "استدعاء API خارجي" تُركت
   كما هي عمدًا لأنها مصطلحات تقنية عالمية موجّهة لمستخدم يبني تكاملًا فعليًا.
   --------------------------------------------------------------------- */
const OPTION_LABELS = {
    any: 'أي قيمة',
    low: 'منخفضة', medium: 'متوسطة', high: 'عالية',
    open: 'مفتوحة', 'in-progress': 'قيد التنفيذ', resolved: 'محلولة',
    confirmed: 'مؤكدة', rejected: 'مرفوضة', closed: 'مغلقة',
    whatsapp: 'واتساب', email: 'البريد الإلكتروني',
    user_id: 'معرّف المستخدم', phone: 'رقم الهاتف',
    tickets: 'التذاكر', profiles: 'الملفات الشخصية', whatsapp_subscriptions: 'اشتراكات واتساب',
    ticket_replies: 'ردود التذاكر', messages: 'الرسائل',
    equals: 'يساوي', not_equals: 'لا يساوي', contains: 'يحتوي على',
    greater_than: 'أكبر من', less_than: 'أصغر من', is_empty: 'فارغ', is_not_empty: 'غير فارغ',
    success: 'نجاح', failed: 'فشل',
    duration: 'مدة محددة', until_time: 'حتى وقت معيّن',
    minutes: 'دقائق', hours: 'ساعات', days: 'أيام'
};
function optionLabel(raw) {
    return OPTION_LABELS[raw] ?? raw;
}

function getUpstreamVariables(session, nodeId) {
    const edges = session.definition.edges, nodes = session.definition.nodes;
    const byId = {}; nodes.forEach(n => byId[n.id] = n);
    const incoming = {}; edges.forEach(e => { (incoming[e.target] = incoming[e.target] || []).push(e.source); });
    const visited = new Set(), queue = [nodeId], ancestors = [];
    while (queue.length) {
        const id = queue.shift();
        (incoming[id] || []).forEach(srcId => { if (!visited.has(srcId)) { visited.add(srcId); ancestors.push(srcId); queue.push(srcId); } });
    }
    const vars = [];
    ancestors.forEach(aid => {
        const n = byId[aid]; if (!n) return;
        const nt = appState.nodeTypesByKey[n.type]; if (!nt) return;
        (nt.output_vars || []).forEach(v => vars.push({ v, from: n.label || nt.name_ar || nt.name_en }));
    });
    Object.keys(session.variables || {}).forEach(k => vars.push({ v: k, from: 'متغيرات الـ Workflow' }));
    return vars;
}

function commitInspectorChange(rerenderCanvas) {
    const s = activeSession(); if (!s) return;
    if (rerenderCanvas !== false) Canvas.render();
    Canvas.pushHistory();
    ui.updateSaveState(); ui.renderTabbar();
}

export function renderInspector() {
    const s = activeSession();
    const wrap = document.getElementById('wfInspectorContent');
    if (!s) { wrap.innerHTML = ''; return; }

    if (s.selection.edgeId) { renderEdgeInspector(s, wrap); return; }

    const selectedIds = [...s.selection.nodeIds];
    if (selectedIds.length > 1) {
        wrap.innerHTML = `
        <div class="wf-inspector-head"><h3>تم تحديد ${selectedIds.length} عناصر</h3></div>
        <div class="wf-inspector-body">
            <button class="wf-btn wf-btn-sm" style="width:100%;margin-bottom:.5rem;" id="wfBulkDup" ${s.readOnly ? 'disabled' : ''}>${ic('copy', 13)} تكرار المحدد</button>
            <button class="wf-btn wf-btn-sm wf-btn-danger" style="width:100%;" id="wfBulkDel" ${s.readOnly ? 'disabled' : ''}>${ic('trash', 13)} حذف المحدد</button>
        </div>`;
        document.getElementById('wfBulkDup')?.addEventListener('click', () => Canvas.duplicateSelection());
        document.getElementById('wfBulkDel')?.addEventListener('click', () => Canvas.deleteSelection());
        return;
    }

    if (selectedIds.length === 1) { renderNodeInspector(s, wrap, selectedIds[0]); return; }

    renderWorkflowInspector(s, wrap);
}

function renderEdgeInspector(s, wrap) {
    const edge = s.definition.edges.find(e => e.id === s.selection.edgeId);
    if (!edge) { wrap.innerHTML = ''; return; }
    const sourceNode = s.definition.nodes.find(n => n.id === edge.source);
    const targetNode = s.definition.nodes.find(n => n.id === edge.target);
    wrap.innerHTML = `
    <div class="wf-inspector-head"><h3>الاتصال (Edge)</h3></div>
    <div class="wf-inspector-body">
        <div class="wf-field"><label>من</label><div class="wf-input" style="background:transparent;">${escapeHtml(appState.nodeTypesByKey[sourceNode?.type]?.name_ar || '—')}</div></div>
        <div class="wf-field"><label>إلى</label><div class="wf-input" style="background:transparent;">${escapeHtml(appState.nodeTypesByKey[targetNode?.type]?.name_ar || '—')}</div></div>
        <button class="wf-btn wf-btn-sm wf-btn-danger" id="wfDeleteEdge" style="width:100%;" ${s.readOnly ? 'disabled' : ''}>${ic('trash', 13)} حذف الاتصال</button>
    </div>`;
    document.getElementById('wfDeleteEdge')?.addEventListener('click', () => Canvas.deleteSelection());
}

function renderWorkflowInspector(s, wrap) {
    const varsEntries = Object.entries(s.variables || {});
    wrap.innerHTML = `
    <div class="wf-inspector-head"><div class="wf-node-icon" style="background:var(--wf-primary)">${ic('zap', 15)}</div>
        <div><h3>إعدادات الـ Workflow</h3><p>${(s.definition.nodes || []).length} عنصر</p></div>
    </div>
    <div class="wf-inspector-body">
        <div class="wf-field"><label>الوصف</label><textarea class="wf-textarea" id="wfDescField" ${s.readOnly ? 'disabled' : ''}>${escapeHtml(s.description || '')}</textarea></div>

        <div class="wf-inspector-section-title">المشغّل الحالي</div>
        <div class="wf-field"><div class="wf-input" style="background:var(--wf-glass);">${escapeHtml(sessionTriggerSummary(s))}</div></div>

        <div class="wf-inspector-section-title">متغيرات الـ Workflow (تُحفظ ضمن الإصدار الحالي)</div>
        <p class="wf-field-hint" style="margin:-.3rem 0 .6rem;">قيم ثابتة تُستخدم داخل أي عنصر بالـ Workflow، مثل رقم هاتف الدعم أو اسم الشركة — اكتب اسمًا وقيمة، ثم أدرجها لاحقًا داخل أي حقل نصي بالضغط على زر "إدراج بيانات".</p>
        <div id="wfWorkflowVars">${varsEntries.map(([k, v], i) => `
            <div class="wf-kv-row" data-i="${i}">
                <input class="wf-input" value="${escapeHtml(k)}" data-role="key" ${s.readOnly ? 'disabled' : ''} placeholder="اسم المتغير">
                <input class="wf-input" value="${escapeHtml(typeof v === 'string' ? v : JSON.stringify(v))}" data-role="val" ${s.readOnly ? 'disabled' : ''} placeholder="القيمة">
                ${s.readOnly ? '' : `<button class="wf-btn wf-btn-icon wf-btn-sm" data-role="rm">${ic('x', 12)}</button>`}
            </div>`).join('') || '<div class="wf-field-hint">لا توجد متغيرات محدَّدة يدويًا بعد.</div>'}
        </div>
        ${s.readOnly ? '' : '<button class="wf-btn wf-btn-sm" id="wfAddVar">+ إضافة متغير</button>'}
    </div>`;

    document.getElementById('wfDescField')?.addEventListener('input', (e) => { s.description = e.target.value; });
    document.getElementById('wfDescField')?.addEventListener('blur', () => { ui.updateSaveState(); ui.renderTabbar(); });

    function collectVars() {
        const obj = {};
        wrap.querySelectorAll('#wfWorkflowVars .wf-kv-row').forEach(row => {
            const k = row.querySelector('[data-role="key"]').value.trim();
            const v = row.querySelector('[data-role="val"]').value;
            if (k) obj[k] = v;
        });
        s.variables = obj;
        ui.updateSaveState(); ui.renderTabbar();
    }
    wrap.querySelectorAll('#wfWorkflowVars input').forEach(inp => inp.addEventListener('blur', collectVars));
    wrap.querySelectorAll('[data-role="rm"]').forEach(btn => btn.addEventListener('click', (e) => { e.target.closest('.wf-kv-row').remove(); collectVars(); renderWorkflowInspector(s, wrap); }));
    document.getElementById('wfAddVar')?.addEventListener('click', () => {
        s.variables = s.variables || {};
        let name = 'متغير_جديد', n = 2;
        while (Object.prototype.hasOwnProperty.call(s.variables, name)) { name = `متغير_جديد_${n++}`; }
        s.variables = { ...s.variables, [name]: '' };
        renderWorkflowInspector(s, wrap);
    });
}

function renderNodeInspector(s, wrap, nodeId) {
    const node = s.definition.nodes.find(n => n.id === nodeId);
    if (!node) { wrap.innerHTML = ''; return; }
    const nt = appState.nodeTypesByKey[node.type];
    if (!nt) {
        wrap.innerHTML = `<div class="wf-inspector-head"><h3>نوع غير معروف</h3></div>
        <div class="wf-inspector-body"><p style="font-size:.78rem;color:var(--wf-text-2);">النوع "${escapeHtml(node.type)}" غير موجود ضمن wf_node_types النشطة حاليًا.</p>
        <button class="wf-btn wf-btn-sm wf-btn-danger" id="wfDelUnknown" style="width:100%;margin-top:.5rem;">حذف العنصر</button></div>`;
        document.getElementById('wfDelUnknown')?.addEventListener('click', () => { s.selection.nodeIds = new Set([node.id]); Canvas.deleteSelection(); });
        return;
    }

    const upstream = getUpstreamVariables(s, node.id);
    const fields = nt.config_schema?.fields || [];

    wrap.innerHTML = `
    <div class="wf-inspector-head">
        <div class="wf-node-icon" style="background:${nt.color}">${nodeIcon(nt, 15)}</div>
        <div><h3>${escapeHtml(nt.name_ar || nt.name_en)}</h3><p>${CATEGORY_LABELS[nt.category] || nt.category}${nt.handler_type ? '' : ' · بانتظار التنفيذ'}</p></div>
    </div>
    <div class="wf-inspector-body">
        <div class="wf-field"><label>اسم مخصّص <span class="wf-field-hint">(اختياري)</span></label>
            <input class="wf-input" id="wfNodeLabel" value="${escapeHtml(node.label || '')}" placeholder="${escapeHtml(nt.name_ar || nt.name_en)}" ${s.readOnly ? 'disabled' : ''}>
        </div>
        ${!fields.length ? '<div class="wf-field-hint">لا توجد إعدادات إضافية لهذا العنصر.</div>' : '<div class="wf-inspector-section-title">الإعدادات</div>'}
        <div id="wfFieldsContainer"></div>
        ${nt.output_vars?.length ? `
        <div class="wf-inspector-section-title">البيانات المتاحة لاستخدامها لاحقًا</div>
        <div>${nt.output_vars.map(v => `<span class="wf-tag-chip" title="${escapeHtml(v)}">${escapeHtml(humanizeVarKey(v) || (nt.name_ar || nt.name_en))}</span>`).join('')}</div>` : ''}
        <button class="wf-btn wf-btn-sm wf-btn-danger" id="wfDeleteNode" style="width:100%;margin-top:1.2rem;" ${s.readOnly ? 'disabled' : ''}>${ic('trash', 13)} حذف العنصر</button>
    </div>`;

    document.getElementById('wfNodeLabel')?.addEventListener('input', (e) => { node.label = e.target.value; });
    document.getElementById('wfNodeLabel')?.addEventListener('blur', () => commitInspectorChange());
    document.getElementById('wfDeleteNode')?.addEventListener('click', () => { s.selection.nodeIds = new Set([node.id]); Canvas.deleteSelection(); });

    const container = document.getElementById('wfFieldsContainer');
    fields.forEach(f => container.appendChild(buildFieldControl(s, node, nt, f, upstream)));
}

function buildFieldControl(session, node, nt, field, upstream) {
    node.config = node.config || {};
    const wrapDiv = document.createElement('div');
    wrapDiv.className = 'wf-field';
    const label = document.createElement('label');
    label.innerHTML = `<span>${escapeHtml(field.label || field.key)}${isStaffFieldOptional(field) ? '' : ' <span style="color:var(--wf-danger)">*</span>'}</span>`;
    wrapDiv.appendChild(label);

    const disabled = session.readOnly;
    let control;
    const commit = (skipCanvasRender) => commitInspectorChange(!skipCanvasRender);

    if (field.supports_variables) {
        const varBtn = document.createElement('button');
        varBtn.className = 'wf-var-btn'; varBtn.type = 'button';
        varBtn.style.display = 'inline-flex'; varBtn.style.alignItems = 'center'; varBtn.style.gap = '.25rem';
        varBtn.innerHTML = `${ic('tag', 11)} إدراج بيانات`;
        varBtn.title = 'أدرج بيانات من عنصر سابق أو من متغيرات الـ Workflow (مثل اسم العميل أو رقم الهاتف) تلقائيًا داخل هذا الحقل';
        varBtn.disabled = disabled;
        varBtn.addEventListener('click', (e) => openVarMenu(e, upstream, (chosen) => {
            const el = wrapDiv.querySelector('textarea,input[type=text]');
            if (el) { el.value = (el.value || '') + `{{${chosen}}}`; node.config[field.key] = el.value; commit(); }
        }));
        label.appendChild(varBtn);
    }

    switch (field.type) {
        case 'textarea':
            control = document.createElement('textarea');
            control.className = 'wf-textarea';
            control.value = node.config[field.key] ?? '';
            control.placeholder = field.placeholder || '';
            control.disabled = disabled;
            control.addEventListener('input', () => { node.config[field.key] = control.value; });
            control.addEventListener('blur', () => commit());
            break;

        case 'select': {
            control = document.createElement('select');
            control.className = 'wf-select';
            control.disabled = disabled;
            control.innerHTML = '<option value="">— اختر —</option>' + (field.options || []).map(o => `<option value="${escapeHtml(o)}">${escapeHtml(optionLabel(o))}</option>`).join('');
            control.value = node.config[field.key] ?? '';
            control.addEventListener('change', () => { node.config[field.key] = control.value; commit(); });
            break;
        }

        case 'number':
            control = document.createElement('input');
            control.type = 'number'; control.className = 'wf-input'; control.disabled = disabled;
            control.value = node.config[field.key] ?? '';
            control.addEventListener('input', () => { node.config[field.key] = control.value === '' ? '' : Number(control.value); });
            control.addEventListener('blur', () => commit());
            break;

        case 'tags': {
            control = buildTagsControl(node.config[field.key] || [], disabled, (arr) => { node.config[field.key] = arr; commit(true); });
            break;
        }

        case 'key_value_list': {
            control = buildKeyValueControl(node.config[field.key] || {}, disabled, (obj) => { node.config[field.key] = obj; commit(true); });
            break;
        }

        case 'variable_picker': {
            control = document.createElement('select');
            control.className = 'wf-select'; control.disabled = disabled;
            control.innerHTML = '<option value="">— اختر —</option>' + upstream.map(u => `<option value="{{${escapeHtml(u.v)}}}">${escapeHtml(friendlyVarLabel(u))}</option>`).join('') + `<option value="__manual__">إدخال يدوي...</option>`;
            const current = node.config[field.key] ?? '';
            if (upstream.some(u => `{{${u.v}}}` === current) || current === '') control.value = current;
            else control.value = '__manual__';
            control.addEventListener('change', async () => {
                if (control.value === '__manual__') {
                    const manual = await promptDialog('اكتب القيمة يدويًا:', current || '');
                    if (manual !== null) { node.config[field.key] = manual; }
                } else node.config[field.key] = control.value;
                commit();
                renderNodeInspector(session, document.getElementById('wfInspectorContent'), node.id);
            });
            break;
        }

        case 'staff_picker': {
            control = document.createElement('select');
            control.className = 'wf-select'; control.disabled = disabled;
            control.innerHTML = '<option value="">— اختر موظفًا —</option>' + appState.staff.map(p => `<option value="${p.id}">${escapeHtml(p.full_name || p.email)}</option>`).join('');
            control.value = node.config[field.key] ?? '';
            control.addEventListener('change', () => { node.config[field.key] = control.value; commit(); });
            break;
        }

        case 'integration_picker': {
            control = document.createElement('select');
            control.className = 'wf-select'; control.disabled = disabled;
            control.innerHTML = '<option value="">— اختر تكاملًا —</option>' + appState.integrations.map(it => `<option value="${it.id}">${escapeHtml(it.display_name || it.provider || it.id)}</option>`).join('');
            control.value = node.config[field.key] ?? '';
            control.addEventListener('change', () => { node.config[field.key] = control.value; commit(); });
            break;
        }

        case 'mcp_tool_picker': {
            control = document.createElement('select');
            control.className = 'wf-select'; control.disabled = disabled;
            control.innerHTML = '<option value="">— اختر أداة MCP —</option>' + appState.mcpTools.map(t => `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)} (${escapeHtml(t.scope)})</option>`).join('');
            control.value = node.config[field.key] ?? '';
            control.addEventListener('change', () => { node.config[field.key] = control.value; commit(); });
            break;
        }

        case 'webhook_picker': {
            control = document.createElement('select');
            control.className = 'wf-select'; control.disabled = disabled;
            const hooks = appState.currentWorkflowWebhooks || [];
            control.innerHTML = '<option value="">— اختر Webhook —</option>' + hooks.map(h => `<option value="${h.id}">${escapeHtml(h.slug)}</option>`).join('') + '<option value="__manual__">إدخال معرّف يدويًا...</option>';
            control.value = node.config[field.key] ?? '';
            control.addEventListener('change', () => { node.config[field.key] = control.value; commit(); });
            break;
        }

        default: // text
            control = document.createElement('input');
            control.type = 'text'; control.className = 'wf-input'; control.disabled = disabled;
            control.value = node.config[field.key] ?? '';
            control.placeholder = field.placeholder || '';
            control.addEventListener('input', () => { node.config[field.key] = control.value; });
            control.addEventListener('blur', () => commit());
    }

    wrapDiv.appendChild(control);
    if (field.source_table) {
        const hint = document.createElement('div');
        hint.className = 'wf-field-hint'; hint.textContent = `المصدر: ${field.source_table}`;
        wrapDiv.appendChild(hint);
    }
    return wrapDiv;
}

function buildTagsControl(initial, disabled, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'wf-tags-wrap';
    let tags = Array.isArray(initial) ? [...initial] : [];
    function redraw() {
        wrap.innerHTML = '';
        tags.forEach((t, i) => {
            const chip = document.createElement('span'); chip.className = 'wf-tag-chip';
            chip.innerHTML = `<span>${escapeHtml(t)}</span>`;
            if (!disabled) {
                const rm = document.createElement('button'); rm.innerHTML = ic('x', 10); rm.type = 'button';
                rm.addEventListener('click', () => { tags.splice(i, 1); onChange(tags); redraw(); });
                chip.appendChild(rm);
            }
            wrap.appendChild(chip);
        });
        if (!disabled) {
            const input = document.createElement('input');
            input.placeholder = 'اكتب واضغط Enter'; input.type = 'text';
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && input.value.trim()) { e.preventDefault(); tags.push(input.value.trim()); onChange(tags); input.value = ''; redraw(); }
            });
            wrap.appendChild(input);
        }
    }
    redraw();
    return wrap;
}

function buildKeyValueControl(initial, disabled, onChange) {
    const wrap = document.createElement('div');
    let obj = typeof initial === 'object' && initial ? { ...initial } : {};
    function redraw() {
        wrap.innerHTML = '';
        Object.entries(obj).forEach(([k, v]) => {
            const row = document.createElement('div'); row.className = 'wf-kv-row';
            row.innerHTML = `<input class="wf-input" data-role="k" value="${escapeHtml(k)}" placeholder="المفتاح" ${disabled ? 'disabled' : ''}>
                              <input class="wf-input" data-role="v" value="${escapeHtml(v)}" placeholder="القيمة" ${disabled ? 'disabled' : ''}>
                              ${disabled ? '' : `<button class="wf-btn wf-btn-icon wf-btn-sm" type="button" data-role="rm">${ic('x', 12)}</button>`}`;
            const commitRow = () => {
                const nk = row.querySelector('[data-role="k"]').value.trim();
                const nv = row.querySelector('[data-role="v"]').value;
                if (nk && nk !== k) { delete obj[k]; obj[nk] = nv; }
                else if (nk) obj[nk] = nv;
                onChange(obj);
            };
            row.querySelectorAll('input').forEach(inp => inp.addEventListener('blur', commitRow));
            row.querySelector('[data-role="rm"]')?.addEventListener('click', () => { delete obj[k]; onChange(obj); redraw(); });
            wrap.appendChild(row);
        });
        if (!disabled) {
            const addBtn = document.createElement('button');
            addBtn.className = 'wf-btn wf-btn-sm'; addBtn.type = 'button'; addBtn.textContent = '+ إضافة';
            addBtn.addEventListener('click', () => { obj[`key_${Object.keys(obj).length + 1}`] = ''; onChange(obj); redraw(); });
            wrap.appendChild(addBtn);
        }
    }
    redraw();
    return wrap;
}

function openVarMenu(e, upstream, onPick) {
    document.querySelectorAll('.wf-var-menu').forEach(m => m.remove());
    const menu = document.createElement('div');
    menu.className = 'wf-var-menu';
    const shell = document.getElementById('wfShell');
    const shellRect = shell.getBoundingClientRect();
    const rect = e.target.getBoundingClientRect();
    // إحداثيات نسبية إلى #wfShell (الآن هو الأب المُموضَع positioned ancestor)
    // بدل الإحداثيات المطلقة على الصفحة، لأن العنصر بقى يُلحَق داخل wfShell
    // بدل document.body مباشرة (انظر تعليق أعلى الملف بخصوص متغيرات الثيم).
    menu.style.top = (rect.bottom - shellRect.top + 4) + 'px';
    menu.style.insetInlineStart = (rect.left - shellRect.left) + 'px';
    menu.innerHTML = upstream.length
        ? upstream.map(u => `<button data-v="${escapeHtml(u.v)}">${escapeHtml(friendlyVarLabel(u))}</button>`).join('')
        : '<div class="wf-var-empty">لا توجد بيانات متاحة من عناصر سابقة متصلة بهذا العنصر بعد.</div>';
    shell.appendChild(menu);
    menu.addEventListener('click', (ev) => { const v = ev.target.closest('button')?.dataset.v; if (v) { onPick(v); menu.remove(); } });
    setTimeout(() => document.addEventListener('click', function h() { menu.remove(); document.removeEventListener('click', h); }), 0);
}

ui.renderInspector = renderInspector;
