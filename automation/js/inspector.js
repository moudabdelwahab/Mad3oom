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
   تصنيف بيانات المتغيرات إلى فئات مفهومة (تذكرة/عميل/واتساب/اشتراك/ذكاء
   اصطناعي/نظام...) بالاعتماد على أول جزء من اسم المتغير التقني (قبل أول
   نقطة) — يُستخدم فقط لتقسيم قائمة "إدراج بيانات" بصريًا، ولا يغيّر القيمة
   المخزَّنة في node.config.
   --------------------------------------------------------------------- */
const VAR_CATEGORY_BY_PREFIX = {
    ticket: 'التذاكر', tickets: 'التذاكر', ticket_replies: 'التذاكر',
    customer: 'العميل', user: 'العميل', profile: 'العميل', profiles: 'العميل',
    whatsapp: 'واتساب', whatsapp_subscriptions: 'واتساب', wa: 'واتساب', message: 'واتساب', messages: 'واتساب',
    subscription: 'الاشتراك', subscriptions: 'الاشتراك', plan: 'الاشتراك',
    payment: 'المدفوعات', invoice: 'المدفوعات', order: 'الطلبات',
    ai: 'الذكاء الاصطناعي', agent: 'الموظفون', staff: 'الموظفون',
    system: 'النظام', workflow: 'النظام'
};
const VAR_CATEGORY_ORDER = ['التذاكر', 'العميل', 'واتساب', 'الاشتراك', 'المدفوعات', 'الطلبات', 'الذكاء الاصطناعي', 'الموظفون', 'النظام', 'متغيرات الـ Workflow', 'عام'];
function classifyVar(u) {
    if (u.from === 'متغيرات الـ Workflow') return 'متغيرات الـ Workflow';
    const prefix = String(u.v || '').split('.')[0]?.toLowerCase();
    return VAR_CATEGORY_BY_PREFIX[prefix] || 'عام';
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

/* ---------------------------------------------------------------------
   عقدة IF/ELSE: حقل "القيمة" يتغيّر شكله حسب "المتغيّر" المختار فوقه — بدل ما
   يكتب الموظف قيمة حرة يدويًا لحاجة زي الأولوية أو الحالة (واللي غالبًا هيغلط
   في كتابتها بالإنجليزية التقنية)، بيتحول تلقائيًا لقائمة اختيار مطابقة تمامًا
   لقيم النظام الفعلية. أي متغيّر تاني مش من القائمة المعروفة يفضل حقل نص حر
   زي ما كان (سلوك افتراضي بدون كسر أي حالة قديمة).
   --------------------------------------------------------------------- */
const IFELSE_VALUE_SUFFIX_OPTIONS = {
    priority: ['low', 'medium', 'high'],
    status: ['open', 'in-progress', 'resolved', 'confirmed', 'rejected', 'closed'],
    from_status: ['open', 'in-progress', 'resolved', 'confirmed', 'rejected', 'closed'],
    to_status: ['open', 'in-progress', 'resolved', 'confirmed', 'rejected', 'closed'],
    new_status: ['open', 'in-progress', 'resolved', 'confirmed', 'rejected', 'closed']
};
function varSuffix(raw) {
    const m = String(raw || '').match(/^\{\{(.+)\}\}$/);
    return String(m ? m[1] : raw || '').split('.').pop();
}
function buildIfElseValueControl(node, field, disabled, commit) {
    const suffix = varSuffix(node.config.variable);
    const fixedOptions = IFELSE_VALUE_SUFFIX_OPTIONS[suffix];
    if (fixedOptions) {
        const control = document.createElement('select');
        control.className = 'wf-select'; control.disabled = disabled;
        control.innerHTML = '<option value="">— اختر —</option>' + fixedOptions.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(optionLabel(o))}</option>`).join('');
        control.value = node.config[field.key] ?? '';
        control.addEventListener('change', () => { node.config[field.key] = control.value; commit(); });
        return control;
    }
    if (suffix === 'user_id') {
        const control = document.createElement('select');
        control.className = 'wf-select'; control.disabled = disabled;
        control.innerHTML = '<option value="">— اختر مستخدمًا —</option>' + (appState.allUsers || []).map(p => `<option value="${p.id}">${escapeHtml(p.full_name || p.email || p.id)}</option>`).join('');
        control.value = node.config[field.key] ?? '';
        control.addEventListener('change', () => { node.config[field.key] = control.value; commit(); });
        return control;
    }
    if (suffix === 'category' && (appState.ticketCategories || []).length) {
        const control = document.createElement('select');
        control.className = 'wf-select'; control.disabled = disabled;
        const cur = node.config[field.key] ?? '';
        const known = appState.ticketCategories.includes(cur);
        control.innerHTML = '<option value="">— اختر تصنيفًا —</option>'
            + appState.ticketCategories.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')
            + `<option value="__manual__">قيمة أخرى...</option>`;
        control.value = known ? cur : (cur ? '__manual__' : '');
        control.addEventListener('change', async () => {
            if (control.value === '__manual__') {
                const manual = await promptDialog('اكتب التصنيف:', cur);
                if (manual !== null) { node.config[field.key] = manual; commit(); }
                else control.value = known ? cur : '';
            } else { node.config[field.key] = control.value; commit(); }
        });
        return control;
    }
    return null; // لا يوجد تصنيف معروف لهذا المتغيّر — يفضل حقل نص حر (السلوك الافتراضي)
}

/* ---------------------------------------------------------------------
   تجميع حقول config_schema إلى أقسام منطقية — يعتمد فقط على field.type
   (وليس على مفتاح تقني خاص بعنصر معيّن)، بحيث يُطبَّق نفس النمط تلقائيًا
   وباتساق على كل أنواع الـ Nodes الحالية والمستقبلية.
   --------------------------------------------------------------------- */
const FIELD_GROUP_META = {
    destination: { title: 'الوجهة والربط', icon: 'link' },
    content: { title: 'المحتوى', icon: 'fileText' },
    conditions: { title: 'الشروط والبيانات', icon: 'gitBranch' }
};
const FIELD_GROUP_ORDER = ['destination', 'content', 'conditions'];
function fieldGroup(field) {
    if (['staff_picker', 'integration_picker', 'mcp_tool_picker', 'webhook_picker'].includes(field.type)) return 'destination';
    // حقلا "من"/"إلى" (مثلًا from_email + to في عقدة إرسال بريد) ينتميان منطقيًا
    // لقسم "الوجهة والربط" مهما كان نوع الحقل نفسه (select أو variable_picker)
    if (['from_email', 'to', 'chat_id'].includes(field.key)) return 'destination';
    if (field.type === 'textarea') return 'content';
    if ((!field.type || field.type === 'text') && field.supports_variables) return 'content';
    return 'conditions';
}

/* نص توضيحي قصير أسفل الحقل — عام حسب نوع الحقل، لا يعتمد على بيانات تقنية */
function fieldHelpText(field) {
    switch (field.type) {
        case 'variable_picker': return 'اختر بيانات من عنصر سابق متصل بهذا العنصر، أو أدخلها يدويًا.';
        case 'staff_picker': return 'سيتم إسناد هذا الإجراء تلقائيًا للموظف الذي تختاره.';
        case 'integration_picker': return 'اختر التكامل المُعدّ مسبقًا الذي سيُنفَّذ عبره هذا الإجراء.';
        case 'mcp_tool_picker': return 'أداة من أدوات الذكاء الاصطناعي المتاحة حاليًا للنظام.';
        case 'webhook_picker': return 'اختر الرابط (Webhook) الذي سيستقبل هذا الطلب.';
        case 'tags': return 'اكتب القيمة ثم اضغط Enter لإضافتها، ويمكن إضافة أكثر من قيمة.';
        case 'key_value_list': return 'أضف أزواجًا من (مفتاح ↔ قيمة) حسب الحاجة.';
        case 'select': return '';
        case 'number': return '';
        default: return field.supports_variables ? 'يمكنك كتابة نص حر، أو إدراج بيانات ديناميكية (مثل اسم العميل) بالضغط على "إدراج بيانات" أعلاه.' : '';
    }
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
    // المشغّل (Trigger) هو دايمًا أول خطوة فعلية في أي Workflow، فبياناته (مثل رقم
    // التذكرة أو اسم العميل) لازم تكون متاحة لأي عنصر تاني حتى لو العنصر مش متوصّل
    // بخط صريح بالمشغّل على الـ canvas — بدل ما يُطلب من موظف غير تقني إنه يفهم
    // مفهوم "التوصيل اليدوي بين العناصر" عشان بس يقدر يستخدم بيانات التذكرة الأساسية.
    const trigger = nodes.find(n => (n.type || '').startsWith('trigger.'));
    if (trigger && trigger.id !== nodeId && !visited.has(trigger.id)) { visited.add(trigger.id); ancestors.unshift(trigger.id); }

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

function buildAdvancedSection(count, defaultOpen) {
    const sec = document.createElement('div');
    sec.className = 'wf-insec' + (defaultOpen ? ' wf-insec-open' : '');
    sec.innerHTML = `
        <div class="wf-insec-head">
            <span class="wf-insec-ic">${ic('settings', 13)}</span>
            <h4>إعدادات متقدمة</h4>
            <span class="wf-insec-count">${count}</span>
            <span class="wf-insec-chevron">${ic('chevronDown', 13)}</span>
        </div>
        <div class="wf-insec-body"></div>`;
    sec.querySelector('.wf-insec-head').addEventListener('click', () => sec.classList.toggle('wf-insec-open'));
    return sec;
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

        <div class="wf-inspector-section-title">الحد الأقصى للتشغيلات بالساعة</div>
        <p class="wf-field-hint" style="margin:-.3rem 0 .6rem;">لحماية هذا الـ Workflow من التشغيل المتكرر بشكل مبالغ فيه (مثلًا بسبب حلقة أو خطأ في المشغّل). اتركه فارغًا لعدم وضع أي حد.</p>
        <div class="wf-field"><input type="number" min="1" class="wf-input" id="wfMaxRunsPerHour" placeholder="بلا حد" value="${s.maxRunsPerHour ?? ''}" ${s.readOnly ? 'disabled' : ''}></div>

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

    document.getElementById('wfMaxRunsPerHour')?.addEventListener('change', (e) => {
        const raw = e.target.value.trim();
        const n = raw === '' ? null : Math.max(1, parseInt(raw, 10) || 1);
        s.maxRunsPerHour = n;
        e.target.value = n ?? '';
        ui.updateSaveState(); ui.renderTabbar();
    });

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
    const requiredFields = fields.filter(f => !isStaffFieldOptional(f));
    const optionalFields = fields.filter(f => isStaffFieldOptional(f));

    wrap.innerHTML = `
    <div class="wf-inspector-head">
        <div class="wf-node-icon" style="background:${nt.color}">${nodeIcon(nt, 15)}</div>
        <div><h3>${escapeHtml(nt.name_ar || nt.name_en)}</h3><p>${CATEGORY_LABELS[nt.category] || nt.category}${nt.handler_type ? '' : ' · بانتظار التنفيذ'}</p></div>
    </div>
    <div class="wf-inspector-body">
        <div class="wf-field"><label>اسم مخصّص <span class="wf-field-hint">(اختياري)</span></label>
            <input class="wf-input" id="wfNodeLabel" value="${escapeHtml(node.label || '')}" placeholder="${escapeHtml(nt.name_ar || nt.name_en)}" ${s.readOnly ? 'disabled' : ''}>
        </div>
        ${!fields.length ? '<div class="wf-field-hint">لا توجد إعدادات إضافية لهذا العنصر.</div>' : ''}
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
    FIELD_GROUP_ORDER.forEach(g => {
        const groupFields = requiredFields.filter(f => fieldGroup(f) === g);
        if (!groupFields.length) return;
        const title = document.createElement('div');
        title.className = 'wf-inspector-section-title';
        title.textContent = FIELD_GROUP_META[g].title;
        container.appendChild(title);
        groupFields.forEach(f => container.appendChild(buildFieldControl(s, node, nt, f, upstream)));
    });
    if (optionalFields.length) {
        const advSec = buildAdvancedSection(optionalFields.length, requiredFields.length === 0);
        const body = advSec.querySelector('.wf-insec-body');
        optionalFields.forEach(f => body.appendChild(buildFieldControl(s, node, nt, f, upstream)));
        container.appendChild(advSec);
    }
}

function buildFieldControl(session, node, nt, field, upstream) {
    node.config = node.config || {};
    const wrapDiv = document.createElement('div');
    wrapDiv.className = 'wf-field';
    const disabled = session.readOnly;
    const optional = isStaffFieldOptional(field);
    let control;
    const commit = (skipCanvasRender) => commitInspectorChange(!skipCanvasRender);

    const label = document.createElement('label');
    label.innerHTML = `<span style="display:inline-flex;align-items:center;gap:.4rem;">${escapeHtml(field.label || field.key)}<span class="wf-field-badge ${optional ? 'wf-field-badge-opt' : 'wf-field-badge-req'}">${optional ? 'اختياري' : 'مطلوب'}</span></span>`;
    wrapDiv.appendChild(label);


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

    if (nt.key === 'condition.if_else' && field.key === 'value') {
        control = buildIfElseValueControl(node, field, disabled, commit);
    }

    if (!control) switch (field.type) {
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
            control = document.createElement('button');
            control.type = 'button';
            control.className = 'wf-varpicker';
            control.disabled = disabled;
            // في عقدة IF/ELSE، حقل "القيمة" بيتغيّر شكله حسب المتغيّر المختار هنا
            // (مثلًا يظهر كقائمة أولويات لو اخترت "الأولوية") — فلازم نعيد رسم
            // اللوحة كلها بعد أي تغيير هنا عشان حقل "القيمة" يتحدّث فورًا.
            const isIfElseVariable = nt.key === 'condition.if_else' && field.key === 'variable';
            const refreshIfNeeded = () => { if (isIfElseVariable) renderNodeInspector(session, document.getElementById('wfInspectorContent'), node.id); };
            const currentVal = () => node.config[field.key] ?? '';
            const renderBtn = () => {
                const val = currentVal();
                const match = upstream.find(u => `{{${u.v}}}` === val);
                if (val && match) {
                    control.innerHTML = `<span class="wf-varpicker-chip">${escapeHtml(friendlyVarLabel(match))}${disabled ? '' : `<button type="button" data-role="clear">${ic('x', 9)}</button>`}</span>`;
                } else if (val) {
                    const short = val.length > 30 ? val.slice(0, 28) + '…' : val;
                    control.innerHTML = `<span class="wf-varpicker-chip" title="${escapeHtml(val)}">${escapeHtml(short)}${disabled ? '' : `<button type="button" data-role="clear">${ic('x', 9)}</button>`}</span>`;
                } else {
                    control.innerHTML = `<span style="color:var(--wf-text-3);">— اختر بيانات —</span><span class="wf-varpicker-ic">${ic('search', 13)}</span>`;
                }
                control.querySelector('[data-role="clear"]')?.addEventListener('click', (ev) => {
                    ev.stopPropagation(); node.config[field.key] = ''; commit(); renderBtn(); refreshIfNeeded();
                });
            };
            renderBtn();
            control.addEventListener('click', (e) => {
                if (disabled) return;
                openVarMenu(e, upstream, async (chosen) => {
                    if (chosen === '__manual__') {
                        const manual = await promptDialog('اكتب القيمة يدويًا:', currentVal() || '');
                        if (manual !== null) { node.config[field.key] = manual; commit(); renderBtn(); refreshIfNeeded(); }
                    } else {
                        node.config[field.key] = `{{${chosen}}}`;
                        commit(); renderBtn(); refreshIfNeeded();
                    }
                }, { manualOption: true, manualLabel: 'إدخال يدوي...' });
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
        hint.className = 'wf-field-hint'; hint.textContent = `المصدر: ${optionLabel(field.source_table)}`;
        wrapDiv.appendChild(hint);
    }
    const help = fieldHelpText(field);
    if (help) {
        const helpEl = document.createElement('div');
        helpEl.className = 'wf-field-help';
        helpEl.textContent = help;
        wrapDiv.appendChild(helpEl);
    }

    // عقدة "إرسال بريد إلكتروني": لا يوجد حقل لاختيار المستلم يدويًا (كان
    // سابقًا متغيّرًا حرًّا وده كان مربكًا) — البريد يُرسل تلقائيًا لصاحب
    // التذكرة المختارة، فبنوضّح ده بشكل صريح تحت حقل التذكرة.
    if (nt.key === 'action.send_email' && field.key === 'ticket_id') {
        const autoHint = document.createElement('div');
        autoHint.className = 'wf-field-help';
        autoHint.textContent = 'سيُرسَل البريد تلقائيًا إلى البريد الإلكتروني المسجَّل لصاحب هذه التذكرة (العميل الذي أنشأها) — لا حاجة لاختيار المستلم يدويًا.';
        wrapDiv.appendChild(autoHint);
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

function openVarMenu(e, upstream, onPick, opts) {
    opts = opts || {};
    document.querySelectorAll('.wf-var-menu').forEach(m => m.remove());
    const menu = document.createElement('div');
    menu.className = 'wf-var-menu';
    const shell = document.getElementById('wfShell');
    const shellRect = shell.getBoundingClientRect();
    const anchor = e.currentTarget || e.target;
    const rect = anchor.getBoundingClientRect();
    menu.style.top = (rect.bottom - shellRect.top + 4) + 'px';
    const isRtl = getComputedStyle(shell).direction === 'rtl';
    const menuWidth = Math.max(230, rect.width);
    let insetStart = isRtl ? (shellRect.right - rect.right) : (rect.left - shellRect.left);
    insetStart = Math.max(4, Math.min(insetStart, shellRect.width - menuWidth - 4));
    menu.style.insetInlineStart = insetStart + 'px';
    menu.style.width = menuWidth + 'px';

    const grouped = {};
    upstream.forEach(u => { const c = classifyVar(u); (grouped[c] = grouped[c] || []).push(u); });
    const cats = [...VAR_CATEGORY_ORDER.filter(c => grouped[c]), ...Object.keys(grouped).filter(c => !VAR_CATEGORY_ORDER.includes(c))];

    menu.innerHTML = `
        <div class="wf-var-menu-search-wrap"><input type="text" placeholder="ابحث عن بيانات... (مثال: اسم العميل، حالة التذكرة)"></div>
        <div class="wf-var-menu-list"></div>
        ${opts.manualOption ? `<div class="wf-var-menu-manual"><button type="button" data-v="__manual__">${ic('edit', 11)} ${escapeHtml(opts.manualLabel || 'إدخال يدوي...')}</button></div>` : ''}`;
    const listEl = menu.querySelector('.wf-var-menu-list');
    const searchInput = menu.querySelector('input');

    function renderList(q) {
        q = (q || '').trim().toLowerCase();
        let html = '';
        cats.forEach(cat => {
            const items = grouped[cat].filter(u => !q || friendlyVarLabel(u).toLowerCase().includes(q) || cat.toLowerCase().includes(q));
            if (!items.length) return;
            html += `<div class="wf-var-menu-group-title">${escapeHtml(cat)}</div>`;
            html += items.map(u => `<button type="button" data-v="${escapeHtml(u.v)}">${escapeHtml(friendlyVarLabel(u))}</button>`).join('');
        });
        listEl.innerHTML = html || `<div class="wf-var-empty">${upstream.length ? 'لا توجد نتائج مطابقة.' : 'لا توجد بيانات متاحة من عناصر سابقة متصلة بهذا العنصر بعد.'}</div>`;
    }
    renderList('');
    searchInput.addEventListener('input', () => renderList(searchInput.value));

    shell.appendChild(menu);
    menu.addEventListener('click', (ev) => { const v = ev.target.closest('button')?.dataset.v; if (v) { onPick(v); menu.remove(); } });
    setTimeout(() => {
        searchInput.focus();
        document.addEventListener('click', function h(ev) { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', h); } });
    }, 0);
}

ui.renderInspector = renderInspector;
