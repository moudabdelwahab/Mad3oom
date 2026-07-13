/* =====================================================================
   workflow-list.js
   ---------------------------------------------------------------------
   The "Workflow List" view: search/filter/sort toolbar, the card grid,
   the per-card overflow menu (edit/duplicate/pause/archive/delete), and
   the "create workflow" modal.

   Opening a workflow into the builder is the one thing this view can't
   do itself (that lives in builder-shell.js, which needs to import this
   module for `refreshWorkflowsList`/`openCreateWorkflowModal`). To avoid
   a circular import, this module calls `ui.openWorkflowInBuilder(id)` —
   a function builder-shell registers on the shared `ui` service locator
   in state.js — instead of importing builder-shell.js directly.
   ===================================================================== */
import { escapeHtml, timeAgo, toast, ic, STATUS_LABEL, STATUS_BADGE_CLASS } from './common.js';
import { appState, ui, primaryDefinitionSource, deriveWorkflowCategory, triggerSummary } from './state.js';
import { DataLayer } from './data-layer.js';

/* ---------------- List rendering / filtering ---------------- */
function populateCategoryFilter() {
    const sel = document.getElementById('wfFilterCategory');
    const cats = new Set(appState.workflows.map(deriveWorkflowCategory));
    sel.innerHTML = '<option value="">كل التصنيفات</option>' +
        [...cats].sort().map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
}

function getFilteredWorkflows() {
    const q = (document.getElementById('wfSearchInput')?.value || '').trim().toLowerCase();
    const cat = document.getElementById('wfFilterCategory')?.value || '';
    const status = document.getElementById('wfFilterStatus')?.value || '';
    const sort = document.getElementById('wfSortBy')?.value || 'updated_desc';

    let list = appState.workflows.filter(w => {
        if (q && !(`${w.name} ${w.description || ''}`.toLowerCase().includes(q))) return false;
        if (cat && deriveWorkflowCategory(w) !== cat) return false;
        if (status && w.status !== status) return false;
        return true;
    });

    if (sort === 'name_asc') list = list.slice().sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    else if (sort === 'created_desc') list = list.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    else list = list.slice().sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

    return list;
}

function renderWorkflowList() {
    const body = document.getElementById('wfListBody');
    const list = getFilteredWorkflows();

    if (!appState.workflows.length) {
        body.innerHTML = `
            <div class="wf-empty" style="min-height:50vh;">
                <div class="wf-empty-icon" style="color:var(--wf-accent-soft);">${ic('zap', 24)}</div>
                <h4>لا توجد Workflows بعد</h4>
                <p>الأتمتة تساعدك على تنفيذ إجراءات تلقائية عند حدوث أحداث معيّنة — مثل إرسال رسالة واتساب عند إنشاء تذكرة جديدة. أنشئ أول Workflow لتبدأ.</p>
                <button class="wf-btn wf-btn-primary" style="margin-top:.5rem;" id="wfEmptyCreateBtn">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    إنشاء أول Workflow
                </button>
            </div>`;
        document.getElementById('wfEmptyCreateBtn')?.addEventListener('click', openCreateWorkflowModal);
        return;
    }

    if (!list.length) {
        body.innerHTML = `
            <div class="wf-empty" style="min-height:40vh;">
                <div class="wf-empty-icon">${ic('search', 22)}</div>
                <h4>لا توجد نتائج</h4>
                <p>جرّب تغيير كلمات البحث أو إزالة بعض الفلاتر.</p>
            </div>`;
        return;
    }

    body.innerHTML = `<div class="wf-grid">${list.map(workflowCardHtml).join('')}</div>`;

    body.querySelectorAll('.wf-wf-card').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target.closest('.wf-menu-btn')) return;
            ui.openWorkflowInBuilder(card.dataset.id);
        });
    });
    body.querySelectorAll('.wf-menu-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleCardMenu(btn);
        });
    });
}

function workflowCardHtml(w) {
    const defSource = primaryDefinitionSource(w);
    const nodes = defSource?.definition?.nodes || [];
    const nodesCount = nodes.length;
    const category = deriveWorkflowCategory(w);
    const trig = triggerSummary(w);
    const triggerNode = nodes.find(n => (n.type || '').startsWith('trigger.'));
    const icon = triggerNode ? (appState.nodeTypesByKey[triggerNode.type]?.icon || ic('zap', 17)) : ic('box', 17);
    return `
    <div class="wf-card wf-wf-card" data-id="${w.id}">
        <div class="wf-wf-card-top">
            <div class="wf-wf-icon">${icon}</div>
            <div style="display:flex;align-items:center;gap:.35rem;">
                <span class="wf-badge ${STATUS_BADGE_CLASS[w.status] || 'wf-badge-gray'}"><span class="wf-badge-dot"></span>${STATUS_LABEL[w.status] || w.status}</span>
                <div class="wf-menu-btn">
                    <button class="wf-btn wf-btn-icon wf-btn-sm" title="خيارات إضافية">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
                    </button>
                </div>
            </div>
        </div>
        <div>
            <h3>${escapeHtml(w.name || 'بدون اسم')}</h3>
            <div class="wf-wf-desc">${escapeHtml(w.description || 'بدون وصف')}</div>
        </div>
        <div class="wf-wf-meta">
            <span title="التصنيف">${ic('tag', 12)} ${escapeHtml(category)}</span>
            <span title="المشغّل">${ic('zap', 12)} ${escapeHtml(trig)}</span>
            <span title="عدد العناصر">${ic('box', 12)} ${nodesCount} عنصر</span>
        </div>
        <div class="wf-wf-meta">
            <span title="آخر تحديث">${ic('clock', 12)} ${timeAgo(w.updated_at)}</span>
            <span title="الإصدار المنشور">${w.published_version ? `${ic('pin', 12)} v${w.published_version.version_number}` : '— لم يُنشر بعد'}</span>
        </div>
        <div class="wf-wf-actions">
            <button class="wf-btn wf-btn-sm wf-card-edit">فتح</button>
            <button class="wf-btn wf-btn-sm wf-card-duplicate">تكرار</button>
        </div>
    </div>`;
}

function toggleCardMenu(btn) {
    document.querySelectorAll('.wf-dropdown').forEach(d => d.remove());
    const card = btn.closest('.wf-wf-card');
    const w = appState.workflows.find(x => x.id === card.dataset.id);
    if (!w) return;
    const menu = document.createElement('div');
    menu.className = 'wf-dropdown';
    const pauseLabel = w.status === 'active' ? `${ic('pause', 13)} إيقاف مؤقت` : (w.status === 'paused' ? `${ic('play', 13)} استئناف` : null);
    menu.innerHTML = `
        <button data-act="edit">${ic('edit', 13)} فتح للتعديل</button>
        <button data-act="duplicate">${ic('copy', 13)} تكرار</button>
        ${pauseLabel ? `<button data-act="pause">${pauseLabel}</button>` : ''}
        ${w.status !== 'archived' ? `<button data-act="archive">${ic('archive', 13)} أرشفة</button>` : ''}
        <hr>
        <button data-act="delete" class="wf-danger-item">${ic('trash', 13)} حذف نهائي</button>
    `;
    btn.closest('.wf-menu-btn').appendChild(menu);
    menu.addEventListener('click', async (e) => {
        e.stopPropagation();
        const act = e.target.closest('button')?.dataset.act;
        if (!act) return;
        menu.remove();
        if (act === 'edit') ui.openWorkflowInBuilder(w.id);
        if (act === 'duplicate') await duplicateWorkflow(w.id);
        if (act === 'pause') await togglePauseWorkflow(w);
        if (act === 'archive') await archiveWorkflow(w.id);
        if (act === 'delete') await deleteWorkflowConfirm(w);
    });
    setTimeout(() => document.addEventListener('click', function h() { menu.remove(); document.removeEventListener('click', h); }), 0);
}

export async function refreshWorkflowsList() {
    try {
        appState.workflows = await DataLayer.listWorkflows();
        populateCategoryFilter();
        renderWorkflowList();
    } catch (err) {
        console.error(err);
        document.getElementById('wfListBody').innerHTML = `<div class="wf-empty"><div class="wf-empty-icon" style="color:var(--wf-danger);">${ic('alertTriangle', 22)}</div><h4>تعذّر تحميل الـ Workflows</h4><p>${escapeHtml(err.message || '')}</p></div>`;
    }
}

['wfSearchInput', 'wfFilterCategory', 'wfFilterStatus', 'wfSortBy'].forEach(id => {
    document.addEventListener('input', (e) => { if (e.target.id === id) renderWorkflowList(); });
    document.addEventListener('change', (e) => { if (e.target.id === id) renderWorkflowList(); });
});

/* ---------- Create workflow modal ---------- */
export function openCreateWorkflowModal() {
    const overlay = document.createElement('div');
    overlay.className = 'wf-modal-overlay';
    overlay.innerHTML = `
        <div class="wf-modal">
            <div class="wf-modal-head"><h3 style="font-size:1rem;">Workflow جديد</h3>
                <button class="wf-btn wf-btn-icon wf-btn-sm" id="wfModalClose">${ic('x', 14)}</button>
            </div>
            <div class="wf-modal-body">
                <div class="wf-field"><label>الاسم</label><input class="wf-input" id="wfNewName" placeholder="مثال: ترحيب بالعملاء الجدد" autofocus></div>
                <div class="wf-field"><label>الوصف <span class="wf-field-hint">(اختياري)</span></label><textarea class="wf-textarea" id="wfNewDesc" placeholder="ماذا يفعل هذا الـ Workflow؟"></textarea></div>
            </div>
            <div class="wf-modal-foot">
                <button class="wf-btn wf-btn-sm" id="wfModalCancel">إلغاء</button>
                <button class="wf-btn wf-btn-primary wf-btn-sm" id="wfModalCreate">إنشاء وفتح المحرر</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.getElementById('wfModalClose').addEventListener('click', close);
    document.getElementById('wfModalCancel').addEventListener('click', close);
    document.getElementById('wfModalCreate').addEventListener('click', async () => {
        const name = document.getElementById('wfNewName').value.trim();
        if (!name) { toast('اكتب اسمًا للـ Workflow', 'error'); return; }
        const desc = document.getElementById('wfNewDesc').value.trim();
        try {
            const row = await DataLayer.createWorkflow({
                name,
                description: desc || null,
                created_by: appState.currentUser?.id || null
            });
            appState.workflows.unshift(row);
            close();
            ui.openWorkflowInBuilder(row.id, row);
            toast('تم إنشاء الـ Workflow — ابدأ بإضافة مشغّل (Trigger)', 'success');
        } catch (err) {
            console.error(err);
            toast('تعذّر إنشاء الـ Workflow: ' + (err.message || ''), 'error');
        }
    });
}
document.getElementById('wfCreateBtn')?.addEventListener('click', openCreateWorkflowModal);

/* ---------- Quick actions ---------- */
export async function duplicateWorkflow(id) {
    let full = appState.workflows.find(x => x.id === id);
    if (!full) full = await DataLayer.getWorkflow(id);
    if (!full) return;
    try {
        const row = await DataLayer.duplicateWorkflow(full, `${full.name} (نسخة)`, appState.currentUser?.id || null);
        appState.workflows.unshift(row);
        renderWorkflowList();
        toast('تم إنشاء نسخة كمسودة', 'success');
    } catch (err) {
        console.error(err);
        toast('تعذّر تكرار الـ Workflow: ' + (err.message || ''), 'error');
    }
}

async function togglePauseWorkflow(w) {
    const newStatus = w.status === 'active' ? 'paused' : 'active';
    try {
        const row = await DataLayer.updateWorkflowMeta(w.id, { status: newStatus, updated_at: new Date().toISOString() });
        Object.assign(w, row);
        renderWorkflowList();
        toast(newStatus === 'paused' ? 'تم إيقاف الـ Workflow مؤقتًا' : 'تم استئناف الـ Workflow', 'success');
    } catch (err) {
        toast('تعذّر تنفيذ العملية: ' + (err.message || ''), 'error');
    }
}

async function archiveWorkflow(id) {
    try {
        const row = await DataLayer.updateWorkflowMeta(id, { status: 'archived', updated_at: new Date().toISOString() });
        const w = appState.workflows.find(x => x.id === id);
        if (w) Object.assign(w, row);
        renderWorkflowList();
        toast('تم أرشفة الـ Workflow', 'success');
    } catch (err) {
        toast('تعذّر الأرشفة: ' + (err.message || ''), 'error');
    }
}

async function deleteWorkflowConfirm(w) {
    if (!confirm(`هل أنت متأكد من حذف "${w.name}" نهائيًا؟ لا يمكن التراجع عن هذا الإجراء.`)) return;
    try {
        await DataLayer.deleteWorkflow(w.id);
        appState.workflows = appState.workflows.filter(x => x.id !== w.id);
        renderWorkflowList();
        toast('تم الحذف', 'success');
    } catch (err) {
        console.error(err);
        const msg = /foreign key|violates/i.test(err.message || '')
            ? 'لا يمكن حذف Workflow له إصدارات أو سجل تشغيل سابق (Versions/Runs) — استخدم الأرشفة بدلًا من الحذف.'
            : ('تعذّر الحذف: ' + (err.message || ''));
        toast(msg, 'error');
    }
}
