/* =====================================================================
   side-panels.js
   ---------------------------------------------------------------------
   The two auxiliary panels that live alongside the canvas in the builder
   view:
     - the bottom panel (validation issues / run history / logs / timeline
       / metrics tabs)
     - the versions sidebar (current draft+published summary, publish /
       pause / duplicate actions, and the version history list with
       "restore into draft")

   Both depend on `Canvas` (to re-render the canvas / jump to a node) and
   on the `ui` service locator for the handful of builder-shell actions
   they trigger (publish, duplicate-as-draft, mount, save-state, tabbar)
   so this module never needs to import builder-shell.js directly.
   ===================================================================== */
import { escapeHtml, ic, toast, confirmDialog, timeAgo, STATUS_LABEL, STATUS_BADGE_CLASS, VERSION_STATUS_LABEL } from './common.js';
import { appState, ui, activeSession, validateDefinition } from './state.js';
import { Canvas } from './canvas.js';
import { DataLayer } from './data-layer.js';

/* =====================================================================
   BOTTOM PANEL
   ===================================================================== */
let bottomActiveTab = 'validation';

export function openBottomTab(name) {
    bottomActiveTab = name;
    document.querySelectorAll('.wf-bottom-tab').forEach(t => t.classList.toggle('wf-bottom-tab-active', t.dataset.bottomtab === name));
    document.getElementById('wfBottomPanel').classList.remove('wf-bottom-collapsed');
    renderBottomPanel();
}
document.querySelectorAll('.wf-bottom-tab').forEach(t => t.addEventListener('click', () => openBottomTab(t.dataset.bottomtab)));
document.getElementById('wfBottomToggle')?.addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('wfBottomPanel').classList.toggle('wf-bottom-collapsed');
});
document.getElementById('wfBottomToggle')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault(); e.stopPropagation();
        document.getElementById('wfBottomPanel').classList.toggle('wf-bottom-collapsed');
    }
});

export function renderBottomPanel() {
    const s = activeSession();
    const content = document.getElementById('wfBottomContent');
    if (!s) { content.innerHTML = ''; return; }
    if (bottomActiveTab === 'validation') return renderValidationTab(s, content);
    if (bottomActiveTab === 'runs') return renderRunsTab(s, content);
    if (bottomActiveTab === 'logs') return renderLogsTab(s, content);
    // لوحة الجدول الزمني/التوقيت (delay/loop) خارج نطاق Executor P0 عمدًا (Trigger/Condition/Action فقط)
    if (bottomActiveTab === 'timeline') return renderPlaceholderTab(content, 'clock', 'الجدول الزمني', 'الجدول الزمني (بما في ذلك التأخيرات وحالات الانتظار عبر wf_scheduled_resumes) خارج نطاق النسخة الحالية من محرك التنفيذ (P0)، والتي تدعم Trigger / Condition / Action فقط. استخدم لسان "السجلات" لعرض خطوات كل تشغيل.');
    if (bottomActiveTab === 'metrics') return renderPlaceholderTab(content, 'barChart', 'المقاييس', 'ستظهر هنا مقاييس الأداء: عدد مرات التشغيل، نسبة النجاح، متوسط وقت التنفيذ لكل عنصر — بمجرد توفر بيانات تشغيل فعلية في wf_runs / wf_run_steps.');
}

export function updateValidationCount(issues) {
    const errCount = issues.filter(i => i.level === 'error').length;
    const el = document.getElementById('wfValidationCount');
    if (el) { el.textContent = String(issues.length); el.classList.toggle('wf-count-error', errCount > 0); }
}

function renderValidationTab(s, content) {
    const issues = validateDefinition(s.definition);
    updateValidationCount(issues);
    if (!issues.length) {
        content.innerHTML = `<div class="wf-empty" style="padding:1.2rem;min-height:auto;"><div class="wf-empty-icon" style="width:36px;height:36px;color:var(--wf-success);">${ic('checkCircle', 18)}</div><h4 style="font-size:.8rem;">لا توجد مشاكل</h4><p style="font-size:.72rem;">الـ Workflow جاهز للنشر من ناحية صحة الإعدادات.</p></div>`;
        return;
    }
    content.innerHTML = issues.map(i => {
        const nt = i.nodeId ? appState.nodeTypesByKey[(s.definition.nodes.find(n => n.id === i.nodeId) || {}).type] : null;
        return `<div class="wf-issue-row wf-issue-${i.level}" data-node="${i.nodeId || ''}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 9v4M12 17h.01"/><circle cx="12" cy="12" r="10"/></svg>
            <div><div>${escapeHtml(i.msg)}</div>${nt ? `<div style="color:var(--wf-text-3);font-size:.65rem;">${escapeHtml(nt.name_ar)}</div>` : ''}</div>
        </div>`;
    }).join('');
    content.querySelectorAll('.wf-issue-row').forEach(row => row.addEventListener('click', () => {
        const nid = row.dataset.node;
        if (!nid) return;
        s.selection.nodeIds = new Set([nid]); s.selection.edgeId = null;
        Canvas.render(); ui.renderInspector();
    }));
}

function renderPlaceholderTab(content, iconName, title, desc) {
    content.innerHTML = `<div class="wf-empty" style="padding:1rem;min-height:auto;"><div class="wf-empty-icon" style="width:36px;height:36px;">${ic(iconName, 18)}</div><h4 style="font-size:.8rem;">${escapeHtml(title)}</h4><p style="font-size:.72rem;">${escapeHtml(desc)}</p></div>`;
}

const RUN_STATUS_BADGE = { pending: 'wf-badge-gray', running: 'wf-badge-blue', waiting: 'wf-badge-amber', completed: 'wf-badge-green', failed: 'wf-badge-red', cancelled: 'wf-badge-gray' };
const RUN_STATUS_LABEL = { pending: 'قيد الانتظار', running: 'جارٍ التنفيذ', waiting: 'معلّق', completed: 'مكتمل', failed: 'فشل', cancelled: 'أُلغي' };

function renderRunsTab(s, content) {
    if (s.runsCache === undefined) {
        content.innerHTML = `<div class="wf-empty" style="padding:1.5rem;"><div class="wf-spinner"></div></div>`;
        DataLayer.listRuns(s.id).then(rows => { s.runsCache = rows; if (bottomActiveTab === 'runs' && activeSession() === s) renderRunsTab(s, content); });
        return;
    }
    if (!s.runsCache.length) {
        renderPlaceholderTab(content, 'activity', 'سجل التشغيل', 'لم يعمل هذا الـ Workflow بعد. بمجرد تفعيل محرك التنفيذ (Executor) وبدء تشغيله فعليًا، سيظهر هنا كل Run بحالته ووقته.');
        return;
    }
    content.innerHTML = s.runsCache.map(r => `
        <div class="wf-run-row" data-run="${r.id}" style="cursor:pointer;" title="عرض تفاصيل هذا التشغيل في لسان السجلات">
            <span class="wf-badge ${RUN_STATUS_BADGE[r.status] || 'wf-badge-gray'}"><span class="wf-badge-dot"></span>${RUN_STATUS_LABEL[r.status] || r.status}</span>
            <span style="color:var(--wf-text-3);font-family:var(--wf-font-data);">${new Date(r.started_at).toLocaleString('ar-EG')}</span>
            <span style="margin-inline-start:auto;color:var(--wf-text-3);">v${r.workflow_version_number ?? '—'}</span>
        </div>`).join('');
    content.querySelectorAll('.wf-run-row').forEach(row => row.addEventListener('click', () => {
        openBottomTab('logs');
        showRunResultInLogs(row.dataset.run, s);
    }));
}

/* =====================================================================
   لسان السجلات (Logs) — يعرض خطوات wf_run_steps لتشغيل واحد محدَّد.
   (Executor P0: Trigger / Condition / Action فقط)
   ===================================================================== */
const STEP_STATUS_BADGE = { running: 'wf-badge-blue', success: 'wf-badge-green', failed: 'wf-badge-red' };
const STEP_STATUS_LABEL = { running: 'جارٍ', success: 'نجح', failed: 'فشل' };

export async function showRunResultInLogs(runId, sessionArg) {
    const s = sessionArg || activeSession();
    if (!s) return;
    s.selectedRunId = runId;
    s.runStepsCache = undefined; // إجبار إعادة الجلب لأن التشغيل قد يكون جديدًا للتو
    openBottomTab('logs'); // يستدعي renderBottomPanel داخليًا
}

function renderLogsTab(s, content) {
    if (!s.selectedRunId) {
        renderPlaceholderTab(content, 'fileText', 'السجلات (Logs)', 'اختر تشغيلاً (Run) من لسان "سجل التشغيل" لعرض خطواته بالتفصيل هنا (المدخلات/المخرجات/الأخطاء).');
        return;
    }
    if (s.runStepsCache === undefined) {
        content.innerHTML = `<div class="wf-empty" style="padding:1.5rem;"><div class="wf-spinner"></div></div>`;
        DataLayer.listRunSteps(s.selectedRunId).then(rows => {
            s.runStepsCache = rows;
            if (bottomActiveTab === 'logs' && activeSession() === s) renderLogsTab(s, content);
        });
        return;
    }
    if (!s.runStepsCache.length) {
        renderPlaceholderTab(content, 'fileText', 'لا توجد خطوات', 'هذا التشغيل لم يسجّل أي خطوة تنفيذ بعد (على الأرجح توقّف عند المشغّل مباشرة).');
        return;
    }
    content.innerHTML = `<div style="font-size:.68rem;color:var(--wf-text-3);padding:.3rem .2rem .6rem;">تشغيل رقم ${escapeHtml(s.selectedRunId)}</div>` +
        s.runStepsCache.map(step => {
            const nt = appState.nodeTypesByKey[step.node_key];
            const label = nt ? (nt.name_ar || nt.name_en) : step.node_key;
            return `<div class="wf-run-row" style="flex-direction:column;align-items:stretch;gap:.35rem;">
                <div style="display:flex;align-items:center;gap:.5rem;">
                    <span class="wf-badge ${STEP_STATUS_BADGE[step.status] || 'wf-badge-gray'}"><span class="wf-badge-dot"></span>${STEP_STATUS_LABEL[step.status] || step.status}</span>
                    <strong style="font-size:.75rem;">${escapeHtml(label)}</strong>
                    <span style="margin-inline-start:auto;color:var(--wf-text-3);font-family:var(--wf-font-data);font-size:.65rem;">${step.duration_ms != null ? step.duration_ms + ' ms' : ''}</span>
                </div>
                ${step.error ? `<div style="color:var(--wf-danger);font-size:.68rem;">${escapeHtml(step.error)}</div>` : ''}
                ${step.output && Object.keys(step.output).length ? `<pre style="font-size:.62rem;background:var(--wf-surface-2);border-radius:6px;padding:.4rem .5rem;margin:0;overflow:auto;direction:ltr;text-align:left;">${escapeHtml(JSON.stringify(step.output, null, 2))}</pre>` : ''}
            </div>`;
        }).join('');
}

/* =====================================================================
   VERSIONS SIDEBAR (يعمل على جدول wf_workflow_versions الحقيقي)
   ===================================================================== */
let versionsActiveTab = 'current';
document.getElementById('wfToggleVersions')?.addEventListener('click', () => {
    document.getElementById('wfVersionPanel').classList.toggle('wf-hidden');
});
document.querySelectorAll('.wf-version-tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.wf-version-tab').forEach(x => x.classList.remove('wf-version-tab-active'));
    t.classList.add('wf-version-tab-active');
    versionsActiveTab = t.dataset.vtab;
    renderVersionsPanel();
}));

export async function renderVersionsPanel() {
    const s = activeSession();
    const body = document.getElementById('wfVersionBody');
    if (!s) { body.innerHTML = ''; return; }

    if (versionsActiveTab === 'history') {
        body.innerHTML = `<div class="wf-empty" style="padding:1.5rem;"><div class="wf-spinner"></div></div>`;
        let versions = [];
        try { versions = await DataLayer.listVersions(s.id); }
        catch (err) { console.error(err); }
        if (activeSession() !== s || versionsActiveTab !== 'history') return;

        if (!versions.length) {
            body.innerHTML = `<div class="wf-empty" style="padding:1rem;min-height:auto;">
                <div class="wf-empty-icon" style="width:36px;height:36px;">${ic('archive', 18)}</div>
                <h4 style="font-size:.8rem;">لا يوجد سجل بعد</h4>
                <p style="font-size:.72rem;">سيظهر هنا كل إصدار (Version) تم إنشاؤه لهذا الـ Workflow، بدءًا من أول مسودة.</p>
            </div>`;
            return;
        }

        body.innerHTML = versions.map(v => `
            <div class="wf-version-item">
                <div class="wf-version-item-head">
                    <span class="wf-vnum">v${v.version_number}</span>
                    <span class="wf-badge ${v.status === 'published' ? 'wf-badge-green' : (v.status === 'archived' ? 'wf-badge-red' : 'wf-badge-gray')}">${VERSION_STATUS_LABEL[v.status] || v.status}</span>
                </div>
                <div class="wf-version-meta">
                    <span>${ic('box', 11)} ${(v.definition?.nodes || []).length} عنصر</span>
                    <span>${ic('clock', 11)} ${timeAgo(v.published_at || v.created_at)}</span>
                </div>
                ${(v.id !== s.draftVersionId && !s.readOnly) ? `<button class="wf-btn wf-btn-sm" data-restore="${v.id}" style="width:100%;">${ic('undo', 13)} استخدام كمسودة حالية</button>` : ''}
            </div>`).join('');

        body.querySelectorAll('[data-restore]').forEach(btn => btn.addEventListener('click', async () => {
            const vid = btn.dataset.restore;
            const target = versions.find(v => v.id === vid);
            if (!target || !s.draftVersionId) return;
            if (!await confirmDialog('سيتم استبدال محتوى المسودة الحالية بمحتوى هذا الإصدار. متابعة؟', { okLabel: 'استبدال' })) return;
            try {
                const updated = await DataLayer.restoreVersionIntoDraft(s.draftVersionId, target);
                s.definition = JSON.parse(JSON.stringify(updated.definition || { nodes: [], edges: [] }));
                s.variables = JSON.parse(JSON.stringify(updated.variables || {}));
                s.triggerConfig = JSON.parse(JSON.stringify(updated.trigger_config || {}));
                s.savedSnapshot = JSON.stringify({ definition: s.definition, variables: s.variables });
                s.history = [JSON.stringify(s.definition)]; s.historyIndex = 0;
                s.selection = { nodeIds: new Set(), edgeId: null };
                Canvas.mount(s); ui.renderInspector(); ui.updateSaveState(); ui.renderTabbar();
                toast('تم استرجاع الإصدار إلى المسودة الحالية', 'success');
            } catch (err) {
                console.error(err);
                toast('تعذّر الاسترجاع: ' + (err.message || ''), 'error');
            }
        }));
        return;
    }

    // تبويب "الحالي"
    const authorName = appState.staff.find(p => p.id === s.createdBy)?.full_name || 'فريق العمل';
    let actionsHtml = '';
    if (s.readOnly) {
        actionsHtml = `
            <div class="wf-readonly-banner">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
                <span>هذا الـ Workflow مؤرشف وللقراءة فقط. لإعادة استخدامه، كرّره كمسودة جديدة.</span>
            </div>
            <button class="wf-btn wf-btn-sm" id="wfVersionDuplicate" style="width:100%;">${ic('copy', 13)} تكرار كمسودة جديدة</button>
        `;
    } else {
        actionsHtml = `<button class="wf-btn wf-btn-primary wf-btn-sm" id="wfVersionPublish" style="width:100%;margin-bottom:.5rem;">${s.publishedVersion ? 'نشر التحديثات' : 'نشر هذه المسودة'}</button>`;
        if (s.status === 'active' || s.status === 'paused') {
            actionsHtml += `<button class="wf-btn wf-btn-sm" id="wfVersionPauseToggle" style="width:100%;">${s.status === 'active' ? `${ic('pause', 13)} إيقاف مؤقت` : `${ic('play', 13)} استئناف`}</button>`;
        }
    }

    body.innerHTML = `
        <div class="wf-version-item">
            <div class="wf-version-item-head">
                <span class="wf-vnum">مسودة v${s.draftVersionNumber}</span>
                <span class="wf-badge wf-badge-gray">مسودة</span>
            </div>
            <div class="wf-version-meta">
                <span>${ic('user', 11)} ${escapeHtml(authorName)}</span>
                <span>${ic('clock', 11)} آخر تحديث: ${timeAgo(s.updatedAt)}</span>
                <span>${ic('box', 11)} ${(s.definition.nodes || []).length} عنصر</span>
            </div>
        </div>
        ${s.publishedVersion ? `
        <div class="wf-version-item">
            <div class="wf-version-item-head">
                <span class="wf-vnum">منشور v${s.publishedVersion.version_number}</span>
                <span class="wf-badge ${STATUS_BADGE_CLASS[s.status] || 'wf-badge-gray'}">${STATUS_LABEL[s.status] || s.status}</span>
            </div>
            <div class="wf-version-meta">
                <span>${ic('clock', 11)} نُشر: ${timeAgo(s.publishedVersion.published_at)}</span>
            </div>
        </div>` : ''}
        <div class="wf-version-actions" style="flex-direction:column;">${actionsHtml}</div>
    `;

    document.getElementById('wfVersionPublish')?.addEventListener('click', () => ui.publishWorkflow());
    document.getElementById('wfVersionDuplicate')?.addEventListener('click', () => ui.duplicateAsDraftFromBuilder());
    document.getElementById('wfVersionPauseToggle')?.addEventListener('click', async () => {
        const newStatus = s.status === 'active' ? 'paused' : 'active';
        try {
            const row = await DataLayer.updateWorkflowMeta(s.id, { status: newStatus, updated_at: new Date().toISOString() });
            s.status = row.status; s.updatedAt = row.updated_at;
            const cached = appState.workflows.find(w => w.id === s.id); if (cached) Object.assign(cached, row);
            ui.mountActiveSession(); ui.renderTabbar();
            toast(newStatus === 'paused' ? 'تم الإيقاف المؤقت' : 'تم الاستئناف', 'success');
        } catch (err) { toast('تعذّر تنفيذ العملية: ' + (err.message || ''), 'error'); }
    });
}

ui.renderBottomPanel = renderBottomPanel;
ui.updateValidationCount = updateValidationCount;
ui.renderVersionsPanel = renderVersionsPanel;
