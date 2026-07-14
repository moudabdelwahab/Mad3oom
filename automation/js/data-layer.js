/* =====================================================================
   data-layer.js
   ---------------------------------------------------------------------
   Every Supabase query used by the Workflow Builder lives in this single
   module. No other module talks to `supabase` directly — this keeps data
   access fully separated from UI/rendering logic and gives one place to
   audit table/column usage against the real schema.

   All queries below are byte-for-byte the same as the original inline
   script: table names, column names, filters and ordering are unchanged.
   ===================================================================== */
import { supabase } from '/api-config.js';

/* TODO: لا يوجد حاليًا عمود صريح لـ "event key" لكل نوع Trigger داخل wf_node_types.
   إلى أن يُعرَّف Trigger Dispatcher الفعلي (وربط كل trigger.* بمفتاح حدث رسمي)،
   نشتق مفتاحًا مبدئيًا من نوع الـ node نفسه (بإزالة بادئة "trigger."). هذه القيمة
   تُخزَّن فقط في wf_workflows.trigger_event_key / wf_workflow_versions.trigger_event_key
   كإشارة أولية، ويجب مراجعتها عند بناء الـ Dispatcher الفعلي. */

/* =====================================================================
   طبقة البيانات (Supabase) — كل الجداول والأعمدة أدناه مطابقة فعليًا لِـ Schema الحالي
   (wf_workflows + wf_workflow_versions هما مصدر الحقيقة لنموذج الإصدارات؛
   لا يوجد أي عمود definition/variables/trigger_config قابل للتحرير مباشرة
   على wf_workflows نفسها - هذه الأعمدة الثلاثة تعيش فقط داخل wf_workflow_versions).
   ===================================================================== */
export const DataLayer = {
    // يضم draft_version و published_version عبر FK embedding (بدون أي View جديد)
    async listWorkflows() {
        const { data, error } = await supabase
            .from('wf_workflows')
            .select(`*,
                draft_version:wf_workflow_versions!wf_workflows_current_draft_version_id_fkey(*),
                published_version:wf_workflow_versions!wf_workflows_published_version_id_fkey(*)
            `)
            .order('updated_at', { ascending: false });
        if (error) throw error;
        return data || [];
    },
    async getWorkflow(id) {
        const { data, error } = await supabase
            .from('wf_workflows')
            .select(`*,
                draft_version:wf_workflow_versions!wf_workflows_current_draft_version_id_fkey(*),
                published_version:wf_workflow_versions!wf_workflows_published_version_id_fkey(*)
            `)
            .eq('id', id).maybeSingle();
        if (error) throw error;
        return data;
    },
    async listNodeTypes() {
        const { data, error } = await supabase.from('wf_node_types').select('*').eq('is_active', true).order('category').order('sort_order');
        if (error) throw error;
        return data || [];
    },
    async listMcpTools() {
        const { data, error } = await supabase.from('mcp_tools_catalog').select('name, scope, description').order('sort_order');
        if (error) { console.warn('mcp_tools_catalog fetch failed', error); return []; }
        return data || [];
    },
    async listStaff() {
        const { data, error } = await supabase.from('profiles').select('id, full_name, email, role').in('role', ['admin', 'support']);
        if (error) { console.warn('staff fetch failed', error); return []; }
        return data || [];
    },
    // كل مستخدمي المنصة (وليس فقط admin/support) — تُستخدم في عقدة IF/ELSE لما
    // يكون المتغيّر المختار هو "معرّف المستخدم" (user_id)، عشان يظهر اسم حقيقي
    // بدل ما يكتب الموظف الـ UUID يدويًا.
    async listAllUsers() {
        const { data, error } = await supabase.from('profiles').select('id, full_name, email').order('full_name');
        if (error) { console.warn('all users fetch failed', error); return []; }
        return data || [];
    },
    // القيم الفعلية المستخدمة حاليًا في عمود tickets.category — تُستخدم في عقدة
    // IF/ELSE لما يكون المتغيّر المختار هو "التصنيف"، عشان تُعرض كخيارات جاهزة
    // بدل كتابة القيمة يدويًا (مع بقاء خيار "قيمة أخرى..." كـ fallback نصي حر).
    async listTicketCategories() {
        const { data, error } = await supabase.from('tickets').select('category').not('category', 'is', null);
        if (error) { console.warn('ticket categories fetch failed', error); return []; }
        return [...new Set((data || []).map(r => r.category).filter(Boolean))].sort();
    },
    async listIntegrations() {
        const { data, error } = await supabase.from('external_integrations').select('id, provider, display_name').eq('is_active', true);
        if (error) { console.warn('integrations fetch failed', error); return []; }
        return data || [];
    },
    async listWebhooks(workflowId) {
        const { data, error } = await supabase.from('wf_webhook_endpoints').select('*').eq('workflow_id', workflowId);
        if (error) { console.warn('webhooks fetch failed', error); return []; }
        return data || [];
    },
    async listRuns(workflowId, limit = 25) {
        const { data, error } = await supabase.from('wf_runs').select('*').eq('workflow_id', workflowId).order('started_at', { ascending: false }).limit(limit);
        if (error) { console.warn('runs fetch failed', error); return []; }
        return data || [];
    },
    async listVersions(workflowId) {
        const { data, error } = await supabase.from('wf_workflow_versions').select('*').eq('workflow_id', workflowId).order('version_number', { ascending: false });
        if (error) { console.warn('versions fetch failed', error); return []; }
        return data || [];
    },
    async listRunSteps(runId) {
        const { data, error } = await supabase.from('wf_run_steps').select('*').eq('run_id', runId).order('started_at', { ascending: true });
        if (error) { console.warn('run steps fetch failed', error); return []; }
        return data || [];
    },
    // يبني trigger_payload حقيقي تلقائيًا لاختبار "تشغيل الآن" بدل الاعتماد على
    // JSON يُكتب يدويًا. يبني نفس شكل المتغيرات اللي بيبنيها الـ Dispatcher الفعلي
    // (dispatch_workflow_on_ticket_created في قاعدة البيانات): كل عمود من صف
    // التذكرة كمتغير "ticket.<column>" — بدون أي هاردكود لأسماء أعمدة بعينها،
    // فيما عدا alias واحد صغير لـ "ticket.type" (الاسم الفعلي للعمود ticket_type).
    // لو مفيش أي تذكرة في المنصة أصلاً، ينشئ تذكرة اختبار مؤقتة يستخدمها.
    async buildTicketTriggerPayload() {
        let { data: ticket, error } = await supabase
            .from('tickets')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (error) throw error;

        if (!ticket) {
            const { data: anyUser, error: userErr } = await supabase
                .from('profiles').select('id').limit(1).maybeSingle();
            if (userErr) throw userErr;
            if (!anyUser) throw new Error('لا يوجد أي مستخدم على المنصة لإنشاء تذكرة اختبار به');
            const { data: created, error: createErr } = await supabase
                .from('tickets')
                .insert({
                    user_id: anyUser.id,
                    title: 'تذكرة اختبار — تشغيل الآن',
                    description: 'تم إنشاؤها تلقائيًا لاختبار الـ Workflow من محرر الأتمتة',
                    priority: 'medium',
                    ticket_type: 'inquiry',
                })
                .select('*').single();
            if (createErr) throw createErr;
            ticket = created;
        }

        const payload = {};
        for (const [key, value] of Object.entries(ticket)) payload[`ticket.${key}`] = value;
        payload['ticket.type'] = ticket.ticket_type;
        return payload;
    },
    // Executor P0 — تنفيذ يدوي فقط. يستدعي دالة الحافة wf-executor بحالة الرسم
    // الحالية (definition) كما هي في المحرر، مباشرة دون الحاجة لحفظ/نشر أولًا.
    // مدعوم حاليًا: Trigger / Condition / Action فقط — أي عنصر من فئة أخرى
    // (control/database/delay/loop/ai/api) سيُفشل التشغيل برسالة واضحة.
    async runWorkflowNow({ workflowId, workflowVersionId = null, workflowVersionNumber = null, definition, triggerPayload = {} }) {
        const { data, error } = await supabase.functions.invoke('wf-executor', {
            body: {
                workflow_id: workflowId,
                workflow_version_id: workflowVersionId,
                workflow_version_number: workflowVersionNumber,
                definition,
                trigger_payload: triggerPayload,
            },
        });
        if (error) {
            // supabase-js embeds the function's JSON error body in error.context when available
            let message = error.message || 'فشل تشغيل الـ Workflow';
            try {
                const body = await error.context?.json?.();
                if (body?.error) message = body.error;
            } catch (_) { /* ignore parse failure, fall back to error.message */ }
            throw new Error(message);
        }
        return data;
    },

    // ينشئ صف wf_workflows + أول صف wf_workflow_versions (v1, draft) ثم يربطهما عبر current_draft_version_id
    async createWorkflow({ name, description, created_by }) {
        const { data: wf, error: e1 } = await supabase.from('wf_workflows')
            .insert({ name, description: description || null, created_by: created_by || null })
            .select().single();
        if (e1) throw e1;
        const { data: ver, error: e2 } = await supabase.from('wf_workflow_versions')
            .insert({
                workflow_id: wf.id, version_number: 1, status: 'draft',
                definition: { nodes: [], edges: [] }, trigger_config: {}, variables: {},
                created_by: created_by || null
            })
            .select().single();
        if (e2) throw e2;
        const { data: wf2, error: e3 } = await supabase.from('wf_workflows')
            .update({ current_draft_version_id: ver.id })
            .eq('id', wf.id).select().single();
        if (e3) throw e3;
        return { ...wf2, draft_version: ver, published_version: null };
    },

    // يكرر Workflow بالكامل كصف جديد + إصدار v1 مسودة، بمحتوى منسوخ من مصدر (draft أو published)
    async duplicateWorkflow(sourceFull, newName, created_by) {
        const srcVersion = sourceFull.draft_version || sourceFull.published_version || { definition: { nodes: [], edges: [] }, trigger_config: {}, variables: {} };
        const { data: wf, error: e1 } = await supabase.from('wf_workflows')
            .insert({ name: newName, description: sourceFull.description || null, created_by: created_by || null })
            .select().single();
        if (e1) throw e1;
        const { data: ver, error: e2 } = await supabase.from('wf_workflow_versions')
            .insert({
                workflow_id: wf.id, version_number: 1, status: 'draft',
                definition: srcVersion.definition || { nodes: [], edges: [] },
                trigger_config: srcVersion.trigger_config || {},
                variables: srcVersion.variables || {},
                created_by: created_by || null
            })
            .select().single();
        if (e2) throw e2;
        const { data: wf2, error: e3 } = await supabase.from('wf_workflows')
            .update({ current_draft_version_id: ver.id })
            .eq('id', wf.id).select().single();
        if (e3) throw e3;
        return { ...wf2, draft_version: ver, published_version: null };
    },

    async updateWorkflowMeta(id, patch) {
        const { data, error } = await supabase.from('wf_workflows').update(patch).eq('id', id).select().single();
        if (error) throw error;
        return data;
    },

    async updateDraftVersion(versionId, patch) {
        const { data, error } = await supabase.from('wf_workflow_versions').update(patch).eq('id', versionId).select().single();
        if (error) throw error;
        return data;
    },

    // ينشر المسودة الحالية (تصبح published/immutable) ثم يفتح مسودة جديدة (version_number+1) لمتابعة التعديل
    async publishWorkflow(workflowId, draftVersionId, created_by) {
        const { data: publishedRow, error: e1 } = await supabase.from('wf_workflow_versions')
            .update({ status: 'published', published_at: new Date().toISOString() })
            .eq('id', draftVersionId).select().single();
        if (e1) throw e1;
        const { data: newDraft, error: e2 } = await supabase.from('wf_workflow_versions')
            .insert({
                workflow_id: workflowId, version_number: publishedRow.version_number + 1, status: 'draft',
                definition: publishedRow.definition, trigger_config: publishedRow.trigger_config, variables: publishedRow.variables,
                trigger_event_key: publishedRow.trigger_event_key || null,
                created_by: created_by || null
            })
            .select().single();
        if (e2) throw e2;
        const { data: wf, error: e3 } = await supabase.from('wf_workflows')
            .update({
                status: 'active',
                published_version_id: publishedRow.id,
                current_draft_version_id: newDraft.id,
                trigger_event_key: publishedRow.trigger_event_key || null,
                trigger_config: publishedRow.trigger_config || {},
                updated_at: new Date().toISOString()
            })
            .eq('id', workflowId).select().single();
        if (e3) throw e3;
        return { workflow: wf, publishedVersion: publishedRow, draftVersion: newDraft };
    },

    // يستعيد محتوى إصدار قديم داخل صف المسودة الحالي (لأن المسودة قابلة للتحرير طالما لم تُنشر)
    async restoreVersionIntoDraft(draftVersionId, versionRow) {
        return this.updateDraftVersion(draftVersionId, {
            definition: versionRow.definition, trigger_config: versionRow.trigger_config, variables: versionRow.variables
        });
    },

    async deleteWorkflow(id) {
        const { error } = await supabase.from('wf_workflows').delete().eq('id', id);
        if (error) throw error;
    }
};
