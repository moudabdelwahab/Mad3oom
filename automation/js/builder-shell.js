/* =====================================================================
   builder-shell.js
   ---------------------------------------------------------------------
   The container that orchestrates the builder view as a whole:
     - switching between the list view and the builder view
     - the tab bar (open workflow sessions, pin/duplicate/close)
     - mounting the active session into every builder panel (canvas,
       node library, inspector, versions, bottom panel)
     - save-draft / publish / "duplicate as new draft" flows
     - the periodic autosave + the beforeunload guard

   This module directly imports the panel modules it mounts (canvas,
   node-library, inspector, side-panels) and the list view (to refresh it
   when navigating back, and to reuse its create/duplicate actions). None
   of those modules import this one back — instead they call through the
   `ui` service locator (state.js) for the handful of functions defined
   here that they need (`saveDraft`, `publishWorkflow`,
   `duplicateAsDraftFromBuilder`, `mountActiveSession`, `updateSaveState`,
   `renderTabbar`, `openWorkflowInBuilder`). Registering those functions
   onto `ui` at the bottom of this file is what keeps the whole module
   graph acyclic.
   ===================================================================== */
import { ic, escapeHtml, toast, confirmDialog, STATUS_LABEL, STATUS_BADGE_CLASS } from './common.js';
import { appState, ui, activeSession, createSession, extractTriggerConfig, extractTriggerEventKey, validateDefinition } from './state.js';
import { DataLayer } from './data-layer.js';
import { Canvas } from './canvas.js';
import { renderNodeLibrary } from './node-library.js';
import { renderInspector } from './inspector.js';
import { renderVersionsPanel, renderBottomPanel, openBottomTab, showRunResultInLogs } from './side-panels.js';
import { refreshWorkflowsList, openCreateWorkflowModal, duplicateWorkflow } from './workflow-list.js';

/* =====================================================================
   VIEW SWITCHING
   ===================================================================== */
export function showView(view) {
    appState.view = view;
    document.getElementById('wfListView').classList.toggle('wf-active', view === 'list');
    document.getElementById('wfBuilderView').classList.toggle('wf-active', view === 'builder');
    if (view === 'list') refreshWorkflowsList();
}
document.getElementById('wfBackToList')?.addEventListener('click', () => showView('list'));

/* =====================================================================
   جلسات الـ Workflow (Tabs)
   ===================================================================== */
export async function openWorkflowInBuilder(id, preloadedRow) {
    let existing = appState.openTabs.find(t => t.id === id);
    if (!existing) {
        let row = preloadedRow;
        if (!row) {
            try { row = await DataLayer.getWorkflow(id); }
            catch (err) { toast('تعذّر فتح الـ Workflow: ' + (err.message || ''), 'error'); return; }
        }
        if (!row) { toast('الـ Workflow غير موجود', 'error'); return; }
        existing = createSession(row);
        appState.openTabs.push(existing);
    }
    appState.activeTabId = existing.id;
    showView('builder');
    renderTabbar();
    mountActiveSession();
}

export async function closeTab(id, force) {
    const tab = appState.openTabs.find(t => t.id === id);
    if (!tab) return;
    if (!force && tab.hasUnsaved) {
        if (!await confirmDialog(`لديك تغييرات غير محفوظة في "${tab.name}". هل تريد إغلاق التاب على أي حال؟`, { okLabel: 'إغلاق على أي حال', danger: true })) return;
    }
    appState.openTabs = appState.openTabs.filter(t => t.id !== id);
    if (appState.activeTabId === id) {
        const next = appState.openTabs[appState.openTabs.length - 1];
        appState.activeTabId = next ? next.id : null;
    }
    if (!appState.openTabs.length) { showView('list'); return; }
    renderTabbar();
    mountActiveSession();
}

export function renderTabbar() {
    const bar = document.getElementById('wfTabbar');
    bar.innerHTML = appState.openTabs.map(t => {
        const dotColor = t.status === 'active' ? 'var(--wf-pill-green-text)' : (t.hasUnsaved ? 'var(--wf-pill-amber-text)' : 'var(--wf-text-3)');
        return `
        <div class="wf-tab ${t.id === appState.activeTabId ? 'wf-tab-active' : ''}" data-tab="${t.id}" title="${escapeHtml(t.name)}">
            ${t.pinned ? `<span title="مثبّت" style="display:flex;color:var(--wf-accent);">${ic('pin', 12)}</span>` : `<span class="wf-tab-dot" style="background:${dotColor}"></span>`}
            <span class="wf-tab-title">${escapeHtml(t.name)}</span>
            ${t.hasUnsaved ? '<span title="تغييرات غير محفوظة" style="color:var(--wf-pill-amber-text);">•</span>' : ''}
            <span class="wf-tab-close" data-close="${t.id}">${ic('x', 11)}</span>
        </div>`;
    }).join('') + `<div class="wf-tab-add" id="wfTabAdd" title="Workflow جديد">${ic('plus', 14)}</div>`;

    bar.querySelectorAll('.wf-tab').forEach(el => {
        el.addEventListener('click', (e) => {
            if (e.target.dataset.close) return;
            appState.activeTabId = el.dataset.tab;
            renderTabbar(); mountActiveSession();
        });
        el.addEventListener('dblclick', () => {
            const t = appState.openTabs.find(x => x.id === el.dataset.tab);
            if (t) { t.pinned = !t.pinned; renderTabbar(); }
        });
        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const t = appState.openTabs.find(x => x.id === el.dataset.tab);
            if (!t) return;
            const menu = document.createElement('div');
            menu.className = 'wf-dropdown';
            menu.style.position = 'fixed'; menu.style.top = e.clientY + 'px'; menu.style.insetInlineStart = e.clientX + 'px';
            menu.innerHTML = `
                <button data-a="pin">${ic('pin', 13)} ${t.pinned ? 'إلغاء التثبيت' : 'تثبيت'}</button>
                <button data-a="dup">${ic('copy', 13)} تكرار</button>
                <button data-a="close">${ic('x', 13)} إغلاق</button>`;
            document.body.appendChild(menu);
            menu.addEventListener('click', async (ev) => {
                const a = ev.target.closest('button')?.dataset.a;
                menu.remove();
                if (a === 'pin') { t.pinned = !t.pinned; renderTabbar(); }
                if (a === 'dup') await duplicateWorkflow(t.id);
                if (a === 'close') closeTab(t.id);
            });
            setTimeout(() => document.addEventListener('click', function h() { menu.remove(); document.removeEventListener('click', h); }), 0);
        });
    });
    bar.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', (e) => { e.stopPropagation(); closeTab(el.dataset.close); }));
    document.getElementById('wfTabAdd')?.addEventListener('click', () => { showView('list'); openCreateWorkflowModal(); });
}

/* =====================================================================
   تركيب الجلسة النشطة في الـ Builder
   ===================================================================== */
export function mountActiveSession() {
    const s = activeSession();
    if (!s) return;

    const nameInput = document.getElementById('wfNameInput');
    nameInput.value = s.name;
    nameInput.disabled = s.readOnly;

    const statusBadge = document.getElementById('wfStatusBadge');
    statusBadge.textContent = STATUS_LABEL[s.status] || s.status;
    statusBadge.className = 'wf-badge ' + (STATUS_BADGE_CLASS[s.status] || 'wf-badge-gray');

    updateSaveState();

    document.getElementById('wfSaveDraftBtn').disabled = s.readOnly;
    document.getElementById('wfRunNowBtn').disabled = (s.definition.nodes || []).length === 0;
    document.getElementById('wfPublishBtn').textContent = s.publishedVersion ? 'نشر التحديثات' : 'نشر';
    document.getElementById('wfPublishBtn').disabled = s.readOnly || (s.definition.nodes || []).length === 0;

    renderNodeLibrary();
    Canvas.mount(s);
    renderInspector();
    renderVersionsPanel();
    renderBottomPanel();

    appState.currentWorkflowWebhooks = [];
    DataLayer.listWebhooks(s.id).then(hooks => {
        appState.currentWorkflowWebhooks = hooks;
        if (activeSession() === s && s.selection.nodeIds.size === 1) renderInspector();
    });
}

export function updateSaveState() {
    const s = activeSession();
    const el = document.getElementById('wfSaveState');
    if (!s) return;
    if (s.readOnly) { el.textContent = 'مؤرشف — للقراءة فقط'; el.classList.remove('wf-unsaved'); return; }
    if (s.hasUnsaved) { el.textContent = 'تغييرات غير محفوظة'; el.classList.add('wf-unsaved'); }
    else { el.textContent = 'محفوظ'; el.classList.remove('wf-unsaved'); }
}

document.getElementById('wfNameInput')?.addEventListener('input', (e) => {
    const s = activeSession(); if (!s || s.readOnly) return;
    s.name = e.target.value;
    renderTabbar();
});

/* =====================================================================
   حفظ / نشر
   ===================================================================== */
export async function saveDraft(silent) {
    const s = activeSession();
    if (!s || s.readOnly) return;
    const issues = validateDefinition(s.definition);
    const errorCount = issues.filter(i => i.level === 'error').length;
    try {
        const wfRow = await DataLayer.updateWorkflowMeta(s.id, {
            name: s.name || 'Workflow بدون اسم',
            description: s.description,
            updated_at: new Date().toISOString()
        });
        let verRow = null;
        if (s.draftVersionId) {
            // إعدادات المشغّل الفعلية تعيش داخل node.config على الـ canvas، وليس في حقل منفصل —
            // نشتقها من التعريف الحالي في كل حفظ بدل الاعتماد على s.triggerConfig الذي لا يُحدَّث أبدًا لولا هذا
            s.triggerConfig = extractTriggerConfig(s.definition);
            verRow = await DataLayer.updateDraftVersion(s.draftVersionId, {
                definition: s.definition,
                variables: s.variables,
                trigger_config: s.triggerConfig
            });
        }
        s.savedSnapshot = JSON.stringify({ definition: s.definition, variables: s.variables });
        s.updatedAt = wfRow.updated_at;
        const cached = appState.workflows.find(w => w.id === s.id);
        if (cached) { Object.assign(cached, wfRow); if (verRow) cached.draft_version = verRow; }
        renderTabbar(); updateSaveState();
        if (!silent) toast(errorCount ? `تم الحفظ كمسودة (${errorCount} ملاحظة تحتاج مراجعة)` : 'تم الحفظ كمسودة', errorCount ? undefined : 'success');
    } catch (err) {
        console.error(err);
        toast('تعذّر الحفظ: ' + (err.message || ''), 'error');
    }
}
document.getElementById('wfSaveDraftBtn')?.addEventListener('click', () => saveDraft(false));

export async function publishWorkflow() {
    const s = activeSession();
    if (!s || s.readOnly) return;
    const issues = validateDefinition(s.definition);
    const errors = issues.filter(i => i.level === 'error');
    if (errors.length) {
        toast(`لا يمكن النشر — يوجد ${errors.length} خطأ يجب إصلاحه أولًا (راجع لوحة "التحقق" أسفل الشاشة)`, 'error');
        openBottomTab('validation');
        return;
    }
    if (!await confirmDialog('نشر هذا الإصدار سيجعله حيًّا الآن. سيتم فتح مسودة جديدة تلقائيًا لمتابعة التعديل بعد النشر. متابعة؟', { okLabel: 'نشر' })) return;
    try {
        // تأكد من حفظ آخر التعديلات في صف المسودة قبل ترقيته لمنشور (يشمل مزامنة trigger_config)
        await saveDraft(true);
        const eventKey = extractTriggerEventKey(s.definition);
        if (eventKey) {
            await DataLayer.updateDraftVersion(s.draftVersionId, { trigger_event_key: eventKey });
        }
        const result = await DataLayer.publishWorkflow(s.id, s.draftVersionId, appState.currentUser?.id || null);
        s.status = result.workflow.status;
        s.publishedVersion = result.publishedVersion;
        s.draftVersionId = result.draftVersion.id;
        s.draftVersionNumber = result.draftVersion.version_number;
        s.updatedAt = result.workflow.updated_at;
        s.savedSnapshot = JSON.stringify({ definition: s.definition, variables: s.variables });
        const cached = appState.workflows.find(w => w.id === s.id);
        if (cached) { Object.assign(cached, result.workflow); cached.draft_version = result.draftVersion; cached.published_version = result.publishedVersion; }
        mountActiveSession(); renderTabbar();
        toast(`تم النشر — الإصدار v${result.publishedVersion.version_number} نشط الآن`, 'success');
    } catch (err) {
        console.error(err);
        toast('تعذّر النشر: ' + (err.message || ''), 'error');
    }
}
document.getElementById('wfPublishBtn')?.addEventListener('click', publishWorkflow);

/* =====================================================================
   تشغيل تجريبي يدوي (Executor P0)
   ---------------------------------------------------------------------
   يستدعي دالة الحافة wf-executor مباشرة بحالة الرسم الحالية في الذاكرة
   (s.definition) — لا حاجة للحفظ أو النشر أولًا. مدعوم حاليًا فقط:
   Trigger / Condition / Action. أي عنصر من فئة أخرى (control/database/
   delay/loop/ai/api) سيُفشل التشغيل برسالة واضحة بدل تجاهله أو محاكاته.
   ===================================================================== */
export async function runNow() {
    const s = activeSession();
    if (!s) return;
    const triggerNode = (s.definition.nodes || []).find(n => (n.type || '').startsWith('trigger.'));
    if (!triggerNode) {
        toast('لا يوجد Trigger في هذا الـ Workflow — أضِف عنصر مشغّل أولًا', 'error');
        return;
    }

    const btn = document.getElementById('wfRunNowBtn');
    if (btn) { btn.disabled = true; }
    toast('جارِ تشغيل الـ Workflow...', undefined);
    let triggerPayload = {};
    try {
        // Triggers المبنية على تذكرة (ticket_created/status_changed/closed) محتاجة
        // بيانات تذكرة حقيقية عشان {{ticket.*}} تتحل صح — نجيبها تلقائيًا بدل ما
        // نطلب من المستخدم يكتب JSON يدوي.
        if (triggerNode.type.startsWith('trigger.ticket_')) {
            triggerPayload = await DataLayer.buildTicketTriggerPayload();
        }
    } catch (err) {
        console.error(err);
        toast('تعذّر تجهيز بيانات اختبار التذكرة: ' + (err.message || ''), 'error');
        if (btn) btn.disabled = false;
        return;
    }
    try {
        const result = await DataLayer.runWorkflowNow({
            workflowId: s.id,
            workflowVersionId: s.draftVersionId || null,
            workflowVersionNumber: s.draftVersionNumber || null,
            definition: s.definition,
            triggerPayload,
        });
        if (result.status === 'completed') {
            toast('اكتمل التشغيل بنجاح', 'success');
        } else {
            toast('فشل التشغيل: ' + (result.error || ''), 'error');
        }
        s.runsCache = undefined; // لإظهار التشغيل الجديد فورًا لو رجع المستخدم للسان "سجل التشغيل"
        if (result.run_id) await showRunResultInLogs(result.run_id, s);
        else { openBottomTab('runs'); renderBottomPanel(); }
    } catch (err) {
        console.error(err);
        toast('تعذّر تشغيل الـ Workflow: ' + (err.message || ''), 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}
document.getElementById('wfRunNowBtn')?.addEventListener('click', runNow);

export async function duplicateAsDraftFromBuilder() {
    const s = activeSession();
    if (!s) return;
    try {
        const full = appState.workflows.find(w => w.id === s.id) || await DataLayer.getWorkflow(s.id);
        const row = await DataLayer.duplicateWorkflow(full, `${s.name} (نسخة قابلة للتعديل)`, appState.currentUser?.id || null);
        appState.workflows.unshift(row);
        openWorkflowInBuilder(row.id, row);
        toast('تم إنشاء نسخة قابلة للتعديل — تابع التعديل عليها ثم انشرها', 'success');
    } catch (err) {
        toast('تعذّر إنشاء نسخة: ' + (err.message || ''), 'error');
    }
}

/* حفظ تلقائي دوري بسيط للمسودات (كل 45 ثانية إن وُجد تغيير) */
setInterval(() => {
    const s = activeSession();
    if (s && !s.readOnly && s.hasUnsaved) saveDraft(true);
}, 45000);

window.addEventListener('beforeunload', (e) => {
    const hasUnsaved = appState.openTabs.some(t => !t.readOnly && t.hasUnsaved);
    if (hasUnsaved) { e.preventDefault(); e.returnValue = ''; }
});

/* Register this module's functions on the shared service locator so
   canvas.js / inspector.js / side-panels.js / workflow-list.js can call
   them without importing this module directly (which would create a
   circular import, since this module already imports all of them). */
ui.updateSaveState = updateSaveState;
ui.renderTabbar = renderTabbar;
ui.saveDraft = saveDraft;
ui.publishWorkflow = publishWorkflow;
ui.duplicateAsDraftFromBuilder = duplicateAsDraftFromBuilder;
ui.mountActiveSession = mountActiveSession;
ui.openWorkflowInBuilder = openWorkflowInBuilder;
