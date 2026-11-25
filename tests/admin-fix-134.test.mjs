/**
 * اختبارات إصلاحات لوحة الإدارة — ترحيل 134 (2026-11-25).
 *
 * تُحرَس هنا:
 *  ① محوِّل الأتمتة: مخطط الواجهة ←→ تعريف wf-executor، بلا إسقاط صامت
 *     لعقد غير قابلة للتنفيذ، وبلا اختراع أنواع أو قيم.
 *  ② عدّادات اللوحة: «المغلقة» حالة مستقلة عن «المحلولة»، ومعدل
 *     الاستجابة يعدّ التذاكر ذات الرد الفعلي (first_response_at).
 *  ③ ترقيم التذاكر على الخادم: نطاق الصفحة والفلاتر المدفوعة للخادم.
 *  ④ وجود الحارس والإصلاحات في الملفات نفسها (فحص نصي ثابت).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
    serializeAutomationGraph,
    validateAutomationDefinition,
    deserializeAutomationDefinition,
} = await import('../assets/js/admin/automation-serializer.js');
const {
    countTicketStatuses,
    computeResponseRate,
    countRespondedTickets,
    responseRateFromTickets,
} = await import('../assets/js/admin/dashboard-stats-model.js');
const {
    pageRange,
    totalPages,
    clampPageSize,
    applyTicketServerFilter,
} = await import('../assets/js/admin/tickets-page-model.js');

function read(path) {
    return readFileSync(new URL(path, import.meta.url), 'utf8');
}

/* مخطط العرض التجريبي كما يبنيه buildInitialGraph() في admin/automation.html */
function demoGraph() {
    return {
        graphNodes: {
            trigger1: { id: 'trigger1', type: 'trigger', x: 460, y: 40, width: 300 },
            condition1: { id: 'condition1', type: 'condition', x: 460, y: 230, width: 300 },
            email1: { id: 'email1', type: 'email', x: 140, y: 430, width: 300 },
            wait1: { id: 'wait1', type: 'wait', x: 140, y: 640, width: 300 },
            notify1: { id: 'notify1', type: 'notify', x: 140, y: 830, width: 300 },
            endYes: { id: 'endYes', sentinel: true, label: 'نهاية المسار', icon: 'i-check', stop: false, x: 190, y: 1010, width: 150 },
            endNo: { id: 'endNo', sentinel: true, label: 'إيقاف التدفق', icon: 'i-x', stop: true, x: 760, y: 460, width: 150 },
        },
        edges: [
            { id: 'edge_1', from: 'trigger1', fromPort: 'out', to: 'condition1', toPort: 'in' },
            { id: 'edge_2', from: 'condition1', fromPort: 'outYes', to: 'email1', toPort: 'in' },
            { id: 'edge_3', from: 'email1', fromPort: 'out', to: 'wait1', toPort: 'in' },
            { id: 'edge_4', from: 'wait1', fromPort: 'out', to: 'notify1', toPort: 'in' },
            { id: 'edge_5', from: 'notify1', fromPort: 'out', to: 'endYes', toPort: 'in' },
            { id: 'edge_6', from: 'condition1', fromPort: 'outNo', to: 'endNo', toPort: 'in' },
        ],
        answers: {
            trigger1: { event: 'new_ticket' },
            email1: { from: 'support@mad3oom.com', to: 'ticket_owner', subject: 'تحديث بخصوص تذكرتك', body: 'مرحبًا' },
            wait1: { duration: { n: 30, unit: 'دقائق' } },
            notify1: { to: 'admin_portal', text: 'تذكرة عاجلة بانتظار الرد' },
        },
        conditionState: {
            condition1: { rows: [{ field: 'الأولوية', op: 'تساوي', value: 'عاجلة' }], logic: 'and' },
        },
    };
}

test('المحوِّل: المخطط التجريبي يُسلسل لأنواع المنفِّذ، والانتظار والإشعار الإداري غير قابلين للتنفيذ لا مسقوطين', () => {
    const { definition, triggerEventKey, unsupported } = serializeAutomationGraph(demoGraph());
    assert.equal(triggerEventKey, 'ticket_created');
    const byId = Object.fromEntries(definition.nodes.map((n) => [n.id, n.type]));
    assert.equal(byId.trigger1, 'trigger.ticket_created');
    assert.equal(byId.condition1, 'condition.if_else');
    assert.equal(byId.email1, 'action.send_email');
    assert.equal(byId.wait1, 'unsupported.wait');
    assert.equal(byId.notify1, 'unsupported.notify');
    // عقد النهاية للعرض فقط — لا تدخل التعريف ولا الحواف إليها.
    assert.ok(!byId.endYes && !byId.endNo);
    assert.ok(definition.edges.every((e) => e.target !== 'endYes' && e.target !== 'endNo'));
    // فرع الشرط: نعم/لا ← true/false كما يقرأها BRANCH_PORT_RESOLVERS.
    const yesEdge = definition.edges.find((e) => e.source === 'condition1' && e.target === 'email1');
    assert.equal(yesEdge.source_port, 'true');
    assert.equal(unsupported.length, 2);
    assert.ok(unsupported.every((u) => u.reason && u.reason.length > 5));
    // الشرط: الأولوية «عاجلة» ← ticket.priority equals high (القاعدة low/medium/high فقط).
    const cond = definition.nodes.find((n) => n.id === 'condition1');
    assert.deepEqual(cond.config, { variable: 'ticket.priority', operator: 'equals', value: 'high' });
    // البريد: ticket_id قالب يُستبدل من حمولة المشغِّل، والإرسال لصاحب التذكرة.
    const email = definition.nodes.find((n) => n.id === 'email1');
    assert.equal(email.config.ticket_id, '{{ticket.id}}');
    assert.equal(email.config.from_email, 'support@mad3oom.com');
});

test('المحوِّل: تدفق قابل للنشر يجتاز التحقق، والتجريبي يُرفض نشره بأسباب', () => {
    const good = {
        graphNodes: {
            t1: { id: 't1', type: 'trigger', x: 0, y: 0, width: 300 },
            e1: { id: 'e1', type: 'email', x: 0, y: 200, width: 300 },
        },
        edges: [{ id: 'a', from: 't1', fromPort: 'out', to: 'e1', toPort: 'in' }],
        answers: { t1: { event: 'ticket_updated' }, e1: { from: 'support@mad3oom.com', to: 'customer', subject: 'س', body: 'ص' } },
        conditionState: {},
    };
    const { definition } = serializeAutomationGraph(good);
    assert.equal(validateAutomationDefinition(definition).ok, true);
    assert.deepEqual(validateAutomationDefinition(definition).errors, []);

    const demo = serializeAutomationGraph(demoGraph());
    const check = validateAutomationDefinition(demo.definition);
    assert.equal(check.ok, false);
    assert.ok(check.errors.some((e) => e.includes('wait')));
    assert.ok(check.errors.some((e) => e.includes('notify')));

    assert.equal(validateAutomationDefinition({ nodes: [], edges: [] }).ok, false);
});

test('المحوِّل: ذهاب وعودة — تعريف منفِّذ صالح يُعاد بناؤه في المصمم', () => {
    const { definition } = serializeAutomationGraph({
        graphNodes: {
            t1: { id: 't1', type: 'trigger', x: 10, y: 20, width: 300 },
            c1: { id: 'c1', type: 'condition', x: 10, y: 220, width: 300 },
            e1: { id: 'e1', type: 'email', x: 10, y: 420, width: 300 },
        },
        edges: [
            { id: 'a', from: 't1', fromPort: 'out', to: 'c1', toPort: 'in' },
            { id: 'b', from: 'c1', fromPort: 'outYes', to: 'e1', toPort: 'in' },
        ],
        answers: {
            t1: { event: 'new_ticket' },
            e1: { from: 'support@mad3oom.com', to: 'ticket_owner', subject: 'س', body: 'ص' },
        },
        conditionState: { c1: { rows: [{ field: 'الأولوية', op: 'تساوي', value: 'عاجلة' }], logic: 'and' } },
    });
    const back = deserializeAutomationDefinition(definition);
    assert.equal(back.ok, true);
    assert.equal(back.graphNodes.t1.type, 'trigger');
    assert.equal(back.answers.t1.event, 'new_ticket');
    assert.equal(back.conditionState.c1.rows[0].field, 'الأولوية');
    assert.equal(back.conditionState.c1.rows[0].value, 'عاجلة');
    assert.equal(back.edges.find((e) => e.from === 'c1').fromPort, 'outYes');

    const bad = deserializeAutomationDefinition({ nodes: [{ id: 'x', type: 'action.call_webhook', config: {} }], edges: [] });
    assert.equal(bad.ok, false);
});

test('العدّادات: closed تُحسب وحدها لا كـ resolved، والاستجابة من أول رد فعلي', () => {
    const tickets = [
        { status: 'open' },
        { status: 'in-progress', first_response_at: '2026-11-25T08:00:00Z' },
        { status: 'resolved', first_response_at: '2026-11-25T08:00:00Z' },
        { status: 'confirmed' },
        { status: 'confirmed', first_response_at: '2026-11-25T08:00:00Z' },
        { status: 'closed', first_response_at: '2026-11-25T08:00:00Z' },
        { status: 'closed' },
        { status: 'rejected' },
    ];
    const counts = countTicketStatuses(tickets);
    assert.equal(counts.total, 8);
    assert.equal(counts.resolved, 1);
    assert.equal(counts.closed, 2);
    assert.notEqual(counts.closed, counts.resolved);
    assert.equal(countRespondedTickets(tickets), 4);
    // القديم كان يعدّ كل ما ليس open مستجابًا (7/8)؛ الصحيح 4/8.
    assert.equal(responseRateFromTickets(tickets), 50);
    assert.equal(computeResponseRate(0, 0), 0);
    assert.equal(computeResponseRate(3, 1), 33);
});

test('الترقيم: نطاق الصفحة شامل الطرفين، وحجم الصفحة يُقيَّد 1..100', () => {
    assert.deepEqual(pageRange(1, 20), { from: 0, to: 19, page: 1, pageSize: 20 });
    assert.deepEqual(pageRange(3, 50), { from: 100, to: 149, page: 3, pageSize: 50 });
    assert.equal(totalPages(43, 20), 3);
    assert.equal(totalPages(0, 20), 1);
    assert.equal(clampPageSize(500), 100);
    assert.equal(clampPageSize('x'), 20);
});

test('الترقيم: الفلاتر الدقيقة تُدفع للخادم بترتيب الأحدث', () => {
    const calls = [];
    const fake = new Proxy({}, {
        get: (_t, method) => (...args) => { calls.push([method, ...args]); return fake; },
    });
    applyTicketServerFilter(fake, {
        status: 'open', priority: 'high', category: 'login',
        assignee: 'me', search: '123', sort: 'newest',
    }, 'user-1');
    assert.ok(calls.some(([m, c, v]) => m === 'eq' && c === 'status' && v === 'open'));
    assert.ok(calls.some(([m, c, v]) => m === 'eq' && c === 'priority' && v === 'high'));
    assert.ok(calls.some(([m, c, v]) => m === 'eq' && c === 'category' && v === 'login'));
    assert.ok(calls.some(([m, c, v]) => m === 'eq' && c === 'assigned_to' && v === 'user-1'));
    assert.ok(calls.some(([m, v]) => m === 'or' && String(v).includes('ticket_number.eq.123')));
    assert.ok(calls.some(([m, c, o]) => m === 'order' && c === 'created_at' && o.ascending === false));
});

test('ثابت: حارس الأدمن أولًا في الصفحات الست، وقبل أي تحميل بيانات', () => {
    const pages = [
        'admin/subscriptions.html',
        'admin/send-email.html',
        'admin/knowledge-base-admin.html',
        'admin/errors.html',
        'admin/status-page.html',
        'admin/mailbox.html',
    ];
    for (const page of pages) {
        const text = page.endsWith('send-email.html')
            ? read('../assets/js/admin/send-email.js')
            : page.endsWith('mailbox.html')
                ? read('../assets/js/admin/mailbox.js')
                : read('../' + page);
        const guardAt = text.indexOf('checkAdminAuth');
        assert.ok(guardAt > -1, page + ': بلا checkAdminAuth');
        if (page === 'admin/subscriptions.html') {
            // الاستدعاء الأولي لـ refreshAll انتقل بعد الحارس.
            assert.ok(!/^refreshAll\(\);$/m.test(text), 'subscriptions: استدعاء refreshAll قبل الحارس');
            assert.ok(text.indexOf('window.refreshAll?.()') > guardAt);
        }
    }
});

test('ثابت: زرا الحفظ/النشر في الأتمتة مربوطان بوحدة الحفظ لا ميتان', () => {
    const html = read('../admin/automation.html');
    assert.ok(html.includes('id="saveWorkflowBtn"'));
    assert.ok(html.includes('id="savePublishWorkflowBtn"'));
    assert.ok(html.includes("supabase.functions.invoke('wf-executor'"));
    assert.ok(html.includes("supabase.rpc('publish_workflow'"));
    assert.ok(html.includes("supabase.rpc('create_workflow_draft_version'"));
    assert.ok(html.includes("from('wf_workflows')"));
    assert.ok(html.includes("from('wf_workflow_versions')"));
});

test('ثابت: الترحيل 134 يعرّف الاقتراحات ودوال المحفظة وسير العمل', () => {
    const sql = read('../migrations/134_admin_fix_suggestions_wallet_workflows.sql');
    assert.ok(sql.includes('create table if not exists public.suggestions'));
    assert.ok(sql.includes("category in ('general', 'feature', 'improvement', 'design', 'other')"));
    assert.ok(sql.includes("status in ('pending', 'reviewed', 'implemented')"));
    for (const fn of [
        'manage_user_points(target_user_email text, amount_change bigint, action_type text)',
        'transfer_points_from_central(target_user_email text, amount_to_transfer bigint)',
        'send_test_telegram_alert()',
        'create_workflow_draft_version(p_workflow_id uuid',
        'publish_workflow(p_workflow_id uuid',
        'publish_workflow_version(p_version_id uuid)',
    ]) assert.ok(sql.includes(fn), 'مفقود: ' + fn);
    // التثبيت: 125 جدولًا + الاقتراحات، وبلا أي جدول SIE.
    const tables = sql.match(/create table if not exists public\.\w+/g) || [];
    assert.equal(tables.length, 126);
    assert.ok(!/create table if not exists public\.sie_/.test(sql));
    assert.ok(!/create table if not exists public\.customer_sie_/.test(sql));
});

test('ثابت: التذاكر تُرقَّم على الخادم والريلتايم يعيد تحميل الصفحة الحالية مع debounce', () => {
    const tickets = read('../assets/js/admin/tickets.js');
    assert.ok(tickets.includes('.range(from, to)'));
    assert.ok(tickets.includes("debounce(() => { loadTickets(); }, 600)"));
    assert.ok(tickets.includes('serverTotalPages(totalTicketsCount, pageSize)'));
    assert.ok(!tickets.includes("subscribeToTickets((payload) => { loadTickets();"));
    const service = read('../tickets-service.js');
    assert.ok(service.includes(".range((page - 1) * pageSize, page * pageSize - 1)"));
    assert.ok(service.includes("count: 'exact', head: true"));
    const logic = read('../assets/js/admin/dashboard-logic.js');
    assert.ok(logic.includes("updateElement('ticketsClosed', closed)"));
    assert.ok(!logic.includes("updateElement('ticketsClosed', resolved)"));
    assert.ok(logic.includes("not('first_response_at', 'is', null)"));
});
