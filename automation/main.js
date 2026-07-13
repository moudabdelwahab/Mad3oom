/* =====================================================================
   main.js
   ---------------------------------------------------------------------
   The single entry point / composition root. Responsibilities:
     - import every feature module so their top-level side effects run
       once (DOM event-listener wiring, `ui` service-locator registration)
     - authenticate the admin user and mount the shared sidebar
     - load the reference data every panel needs (node types, MCP tools,
       staff, integrations)
     - render the initial (list) view

   This is the only module allowed to depend on virtually everything
   else — by design, nothing imports main.js back.
   ===================================================================== */
import { initSidebar } from '/assets/js/admin/sidebar.js';
import { checkAdminAuth, updateAdminUI } from '/assets/js/admin/auth.js';

import { toast } from './common.js';
import { appState } from './state.js';
import { DataLayer } from './data-layer.js';
import { Canvas } from './canvas.js';
import { renderNodeLibrary } from './node-library.js';
import { refreshWorkflowsList } from './workflow-list.js';

// Imported for their module-level side effects only (event listeners +
// `ui` service-locator registration) — see each module's header comment.
import './inspector.js';
import './side-panels.js';
import './builder-shell.js';

/* =====================================================================
   BOOT
   ===================================================================== */
async function init() {
    initSidebar();
    const user = await checkAdminAuth();
    if (!user) return;
    appState.currentUser = { id: user.id || user.profile?.id, ...user };
    updateAdminUI(user);

    document.getElementById('wfAuthGate').classList.add('wf-hidden');
    document.getElementById('wfListView').classList.add('wf-active');

    Canvas.init();

    try {
        const [nodeTypes, mcpTools, staff, integrations] = await Promise.all([
            DataLayer.listNodeTypes(),
            DataLayer.listMcpTools(),
            DataLayer.listStaff(),
            DataLayer.listIntegrations()
        ]);
        appState.nodeTypes = nodeTypes;
        appState.nodeTypesByKey = Object.fromEntries(nodeTypes.map(nt => [nt.key, nt]));
        appState.mcpTools = mcpTools;
        appState.staff = staff;
        appState.integrations = integrations;
    } catch (err) {
        console.error(err);
        toast('تعذّر تحميل بيانات النظام (أنواع العناصر): ' + (err.message || ''), 'error');
    }

    renderNodeLibrary();
    await refreshWorkflowsList();
}

init();
