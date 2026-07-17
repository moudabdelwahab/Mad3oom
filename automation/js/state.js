/* =====================================================================
   state.js
   ---------------------------------------------------------------------
   Owns the single shared application state (`appState`) and the pure,
   DOM-free domain logic that operates on it:
     - the open-tab "session" model (createSession/activeSession)
     - trigger-node derivation helpers (used by list view + save/publish)
     - the workflow definition validation engine

   It also exposes a tiny service-locator (`ui`) that several tightly
   coupled builder panels (canvas, inspector, side panels, builder shell)
   use to call into each other WITHOUT importing each other directly.
   Each feature module registers the functions it owns onto `ui` when it
   loads; everyone else calls through `ui.xxx()`. This keeps the import
   graph a clean, one-directional DAG (see architecture notes) instead of
   a web of circular imports between the builder's UI panels.

   state.js itself only depends on common.js (pure helpers) — it has no
   knowledge of Supabase or of any rendering/DOM module.
   ===================================================================== */
import { isStaffFieldOptional } from './common.js';

/* ---------------------------------------------------------------------
   حالة عامة
   --------------------------------------------------------------------- */
export const appState = {
    currentUser: null,
    workflows: [],            // wf_workflows rows (list view cache), كل صف يحمل draft_version/published_version المضمَّنة
    nodeTypes: [],            // wf_node_types rows
    nodeTypesByKey: {},
    mcpTools: [],
    staff: [],
    allUsers: [],          // كل بروفايلات المنصة — لعقدة IF/ELSE عند اختيار متغيّر user_id
    ticketCategories: [],  // القيم الفعلية الحالية في tickets.category — لعقدة IF/ELSE
    integrations: [],
    currentWorkflowWebhooks: [],
    openTabs: [],             // جلسات الـ workflow المفتوحة داخل الـ Builder (تدعم تعدد التابات)
    activeTabId: null,
    view: 'list'              // 'list' | 'builder'
};

/* Service locator used only to break cycles between builder sub-panels.
   See module doc-comment above. */
export const ui = {};

/* ---------------------------------------------------------------------
   مشغّل الـ Workflow — دالة مشتركة واحدة لإيجاد مشغّل الـ Workflow — إن وُجد أكثر
   من مشغّل، يُعتمد الأول دائمًا (بنفس القاعدة في كل مكان: هنا، في validateDefinition،
   وفي عرض الملخص)
   --------------------------------------------------------------------- */
export function findTriggerNode(definition) {
    const nodes = definition?.nodes || [];
    return nodes.find(n => (n.type || '').startsWith('trigger.')) || null;
}
export function extractTriggerEventKey(definition) {
    const trigger = findTriggerNode(definition);
    if (!trigger) return null;
    return trigger.type.replace(/^trigger\./, '');
}
/* استخراج إعدادات المشغّل الفعلية (node.config) لحفظها في عمود trigger_config —
   سابقًا كان trigger_config يبقى {} دائمًا لأن لا شيء كان يربطه بإعدادات الـ node نفسه */
export function extractTriggerConfig(definition) {
    const trigger = findTriggerNode(definition);
    return trigger ? (trigger.config || {}) : {};
}

/* استخراج تصنيف/ملخص مشغّل مشتق للعرض في قائمة الـ Workflows (لا يوجد عمود category،
   فنشتقه من تعريف الإصدار المنشور، أو من المسودة إن لم يوجد إصدار منشور بعد) */
export function primaryDefinitionSource(workflow) {
    return workflow?.published_version || workflow?.draft_version || null;
}
export function deriveWorkflowCategory(workflow) {
    const trigger = findTriggerNode(primaryDefinitionSource(workflow)?.definition);
    if (!trigger) return 'بدون مشغّل';
    const key = trigger.type;
    if (key.startsWith('trigger.ticket')) return 'التذاكر';
    if (key.startsWith('trigger.whatsapp')) return 'واتساب';
    if (key.startsWith('trigger.subscription')) return 'الاشتراكات';
    if (key === 'trigger.webhook_inbound') return 'Webhook';
    if (key === 'trigger.schedule_cron') return 'مجدول (Cron)';
    return 'عام';
}

export function triggerSummary(workflow) {
    const trigger = findTriggerNode(primaryDefinitionSource(workflow)?.definition);
    if (!trigger) return 'بدون مشغّل بعد';
    const nt = appState.nodeTypesByKey[trigger.type];
    return nt ? (nt.name_ar || nt.name_en) : trigger.type;
}

/* نفس فكرة triggerSummary لكن تعمل مباشرة على تعريف جلسة مفتوحة في الـ Builder (session.definition) */
export function sessionTriggerSummary(s) {
    const trigger = findTriggerNode(s.definition);
    if (!trigger) return 'بدون مشغّل بعد';
    const nt = appState.nodeTypesByKey[trigger.type];
    return nt ? (nt.name_ar || nt.name_en) : trigger.type;
}

/* =====================================================================
   جلسات الـ Workflow (Tabs) — نموذج الجلسة المفتوحة في الـ Builder
   كل جلسة تتتبّع: بيانات wf_workflows الأساسية + الإصدار الحالي (draft_version)
   الذي يُحرَّر فعليًا على الـ Canvas، بالإضافة لمرجع للإصدار المنشور إن وُجد.
   ===================================================================== */
export function createSession(workflowFull, isNew) {
    const draft = workflowFull.draft_version || { id: null, version_number: 1, status: 'draft', definition: { nodes: [], edges: [] }, trigger_config: {}, variables: {} };
    const def = draft.definition && Array.isArray(draft.definition.nodes) && Array.isArray(draft.definition.edges)
        ? draft.definition : { nodes: [], edges: [] };
    const vars = draft.variables && typeof draft.variables === 'object' ? draft.variables : {};
    const triggerConfig = draft.trigger_config && typeof draft.trigger_config === 'object' ? draft.trigger_config : {};
    return {
        id: workflowFull.id,
        isNew: !!isNew,
        name: workflowFull.name || 'Workflow بدون اسم',
        description: workflowFull.description || '',
        status: workflowFull.status || 'draft',
        createdBy: workflowFull.created_by || null,
        updatedAt: workflowFull.updated_at,
        createdAt: workflowFull.created_at,
        draftVersionId: draft.id,
        draftVersionNumber: draft.version_number || 1,
        publishedVersion: workflowFull.published_version || null,
        maxRunsPerHour: workflowFull.max_runs_per_hour ?? null,
        definition: JSON.parse(JSON.stringify(def)),
        variables: JSON.parse(JSON.stringify(vars)),
        triggerConfig: JSON.parse(JSON.stringify(triggerConfig)),
        savedSnapshot: JSON.stringify({ definition: def, variables: vars }),
        history: [JSON.stringify(def)],
        historyIndex: 0,
        pinned: false,
        selection: { nodeIds: new Set(), edgeId: null },
        view: { pan: { x: 60, y: 60 }, zoom: 1 },
        runsCache: undefined,
        // مؤرشف فقط = للقراءة. مسودة/نشط/متوقف مؤقتًا كلها قابلة للتحرير عبر إصدار المسودة الحالي
        // (لا علاقة لذلك بتشغيل الإصدار المنشور فعليًا - current_draft_version_id لا يُستخدم أبدًا في التنفيذ).
        get readOnly() { return this.status === 'archived'; },
        get hasUnsaved() { return JSON.stringify({ definition: this.definition, variables: this.variables }) !== this.savedSnapshot; }
    };
}

export function activeSession() {
    return appState.openTabs.find(t => t.id === appState.activeTabId) || null;
}

/* =====================================================================
   VALIDATION ENGINE (حقيقي — يعمل بالكامل على تعريف الـ canvas الحالي، بدون Executor)
   ===================================================================== */
export function validateDefinition(def) {
    const issues = [];
    const nodes = def.nodes || [], edges = def.edges || [];
    if (!nodes.length) { issues.push({ level: 'error', msg: 'أضف عناصر (Nodes) إلى الـ Workflow لتتمكن من نشره', nodeId: null }); return issues; }

    const triggers = nodes.filter(n => (n.type || '').startsWith('trigger.'));
    if (!triggers.length) issues.push({ level: 'error', msg: 'يجب أن يحتوي الـ Workflow على مشغّل (Trigger) واحد على الأقل', nodeId: null });
    if (triggers.length > 1) {
        // النظام الحالي يخزّن مشغّلًا واحدًا فقط لكل Workflow (trigger_event_key) — أي مشغّل إضافي
        // يُضاف على الـ canvas يُعرض هنا بوضوح كأنه سيُتجاهل تمامًا عند النشر، بدل تحذير عام غامض
        triggers.slice(1).forEach(t => {
            const ntName = appState.nodeTypesByKey[t.type]?.name_ar || appState.nodeTypesByKey[t.type]?.name_en || t.type;
            issues.push({ level: 'warn', msg: `يوجد أكثر من مشغّل واحد — سيُعتمد المشغّل الأول فقط عند النشر، وسيتم تجاهل "${ntName}" ولن يُشغّل الـ Workflow`, nodeId: t.id });
        });
    }

    const incoming = {}; edges.forEach(e => { incoming[e.target] = (incoming[e.target] || 0) + 1; });
    const nodeIds = new Set(nodes.map(n => n.id));
    const seenIds = new Set();

    nodes.forEach(n => {
        if (seenIds.has(n.id)) issues.push({ level: 'error', msg: 'يوجد معرّف Node مكرر', nodeId: n.id });
        seenIds.add(n.id);

        const nt = appState.nodeTypesByKey[n.type];
        if (!nt) { issues.push({ level: 'error', msg: `نوع Node غير معروف أو غير نشط: ${n.type}`, nodeId: n.id }); return; }

        const fields = nt.config_schema?.fields || [];
        fields.forEach(f => {
            if (isStaffFieldOptional(f)) return;
            const val = (n.config || {})[f.key];
            if (val === undefined || val === null || val === '' || (Array.isArray(val) && !val.length)) {
                issues.push({ level: 'error', msg: `حقل "${f.label || f.key}" مطلوب في "${nt.name_ar || nt.name_en}"`, nodeId: n.id });
            }
        });

        if (!n.type.startsWith('trigger.') && !incoming[n.id]) {
            issues.push({ level: 'warn', msg: `العنصر "${nt.name_ar || nt.name_en}" غير متصل بأي مسار سابق`, nodeId: n.id });
        }

        if (n.type === 'condition.if_else') {
            const outPorts = new Set(edges.filter(e => e.source === n.id).map(e => e.source_port || 'default'));
            if (!outPorts.has('true')) issues.push({ level: 'warn', msg: 'فرع "إذا" غير متصل بأي خطوة تالية', nodeId: n.id });
            if (!outPorts.has('false')) issues.push({ level: 'warn', msg: 'فرع "لكن" غير متصل بأي خطوة تالية', nodeId: n.id });
        }
    });

    edges.forEach(e => {
        if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) {
            issues.push({ level: 'error', msg: 'اتصال (Edge) يشير إلى عنصر غير موجود على المخطط', nodeId: null });
        }
    });

    return issues;
}
