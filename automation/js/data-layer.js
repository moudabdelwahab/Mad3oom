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
