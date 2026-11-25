/**
 * automation-serializer.js — تحويل بين مخطط الأتمتة في admin/automation.html
 * وتعريف التنفيذ الذي يفهمه supabase/functions/wf-executor.
 *
 * دوال خالصة بلا DOM وبلا Supabase، لتُختبَر في node.
 *
 * حقائق المصدر (لا تُغيَّر هنا بلا مراجعة wf-executor/index.ts):
 *  - wf-executor يقبل POST ‏{definition:{nodes,edges}, workflow_id, ...}‏،
 *    ويتطلب عقدة trigger.*، ويرفض أي نوع غير مسجَّل في NODE_REGISTRY.
 *  - الأنواع المدعومة: trigger.ticket_created / ticket_status_changed /
 *    ticket_closed / whatsapp_message_received / subscription_expiring /
 *    subscription_expired / webhook_inbound / schedule_cron،
 *    condition.if_else / switch، وأفعال action.* (منها send_email و
 *    send_notification و update_ticket_status و add_ticket_tag و
 *    assign_ticket و log_ticket_activity).
 *  - h_if_else يقرأ {variable, operator, value} من config، ويدعم
 *    equals/not_equals/contains/greater_than/less_than/is_empty/is_not_empty.
 *  - h_send_email يتطلب ticket_id ويُرسل دائمًا لصاحب التذكرة.
 *  - h_send_notification يتطلب user_id صريحًا.
 *  - لا توجد عقدة انتظار (wait) ولا إسناد تلقائي (least_busy) في المنفِّذ.
 *  - dispatch_workflow_on_ticket_created يمرّر الحمولة مسطّحة بمفاتيح
 *    'ticket.id' و 'ticket.priority' و 'ticket.user_id' ...، فيُكتب
 *    ticket_id في الإعدادات كـ '{{ticket.id}}' ليُستبدل عند التشغيل.
 *  - أولوية التذاكر في القاعدة low/medium/high فقط (tickets_priority_check)،
 *    فتسمية الواجهة «عاجلة» تُطابِق high.
 */

// أنواع المنفِّذ التي يمكن لهذا المحوِّل إصدارها.
export const EXECUTOR_NODE_TYPES = new Set([
    'trigger.ticket_created',
    'trigger.ticket_status_changed',
    'condition.if_else',
    'action.send_email',
    'action.send_notification',
    'action.update_ticket_status',
    'action.add_ticket_tag',
    'action.assign_ticket',
    'action.log_ticket_activity',
]);

const TRIGGER_EVENT_MAP = {
    new_ticket: 'trigger.ticket_created',
    ticket_updated: 'trigger.ticket_status_changed',
    // لا مشغِّل منفِّذ لتعليق جديد ولا لتذكرة بلا موظف — يُرفض النشر بسببهما.
};

const PRIORITY_LABEL_TO_VALUE = { 'عاجلة': 'high', 'عالية': 'high', 'متوسطة': 'medium', 'منخفضة': 'low' };
const PRIORITY_VALUE_TO_LABEL = { high: 'عاجلة', medium: 'متوسطة', low: 'منخفضة' };
const CONDITION_FIELD_TO_VARIABLE = { 'الأولوية': 'ticket.priority' };
const CONDITION_OP_MAP = { 'تساوي': 'equals', 'لا تساوي': 'not_equals' };

export const TICKET_ID_TEMPLATE = '{{ticket.id}}';
export const TICKET_USER_ID_TEMPLATE = '{{ticket.user_id}}';

// خريطة عكسية: نوع المنفِّذ ← نوع عقدة الواجهة.
const EXECUTOR_TO_UI_TYPE = {
    'trigger.ticket_created': 'trigger',
    'trigger.ticket_status_changed': 'trigger',
    'condition.if_else': 'condition',
    'action.send_email': 'email',
    'action.send_notification': 'notify',
    'action.update_ticket_status': 'update_ticket',
    'action.add_ticket_tag': 'update_ticket',
    'action.assign_ticket': 'assign',
    'action.log_ticket_activity': 'internal_note',
};

/**
 * يحوّل مخطط الواجهة إلى تعريف منفِّذ.
 * العقد غير القابلة للتنفيذ لا تُسقَط صامتة: تُحفَظ بنوع 'unsupported.<uiType>'
 * في المسودة، وتُدرَج في `unsupported` بأسباب عربية، فيرفض النشر لا الحفظ.
 */
export function serializeAutomationGraph({ graphNodes = {}, edges = [], answers = {}, conditionState = {} }) {
    const nodes = [];
    const unsupported = [];
    let triggerEventKey = null;

    for (const inst of Object.values(graphNodes)) {
        if (inst.sentinel) continue; // عقد «نهاية/إيقاف» للعرض فقط — لا معنى لها في المنفِّذ.
        const ans = answers[inst.id] || {};
        const mapped = mapNodeToExecutor(inst, ans, conditionState[inst.id]);
        if (mapped.unsupported) {
            unsupported.push({ nodeId: inst.id, label: mapped.label, reason: mapped.unsupported });
            nodes.push({
                id: inst.id, type: `unsupported.${inst.type}`,
                config: { uiType: inst.type, answers: ans },
                x: inst.x, y: inst.y, width: inst.width,
            });
        } else {
            nodes.push({
                id: inst.id, type: mapped.type, config: mapped.config,
                x: inst.x, y: inst.y, width: inst.width,
            });
            if (mapped.type.startsWith('trigger.') && !triggerEventKey) triggerEventKey = mapped.eventKey;
        }
    }

    const keptIds = new Set(nodes.map((n) => n.id));
    const outEdges = edges
        .filter((e) => keptIds.has(e.from) && keptIds.has(e.to))
        .map((e) => ({
            id: e.id,
            source: e.from,
            target: e.to,
            source_port: e.fromPort === 'outYes' ? 'true' : e.fromPort === 'outNo' ? 'false' : 'default',
        }));

    return { definition: { nodes, edges: outEdges }, triggerEventKey, unsupported };
}

function mapNodeToExecutor(inst, ans, cond) {
    const label = inst.type;
    switch (inst.type) {
        case 'trigger': {
            const event = ans.event || 'new_ticket';
            const type = TRIGGER_EVENT_MAP[event];
            if (!type) {
                return { unsupported: `الحدث «${event}» بلا مشغِّل مقابل في محرك التنفيذ (wf-executor) — المتاح: إنشاء تذكرة أو تحديثها.`, label };
            }
            const eventKey = event === 'new_ticket' ? 'ticket_created' : 'ticket_status_changed';
            return { type, eventKey, config: {}, label };
        }
        case 'condition': {
            const rows = cond?.rows || [];
            if (rows.length === 0) return { unsupported: 'عقدة الشرط بلا أي صف شرط.', label };
            if (rows.length > 1) {
                return { unsupported: 'الشرط متعدد الصفوف لا يُطابِق عقدة if_else واحدة في المنفِّذ — احتفظ بشرط واحد فقط قبل النشر.', label };
            }
            const row = rows[0];
            const variable = CONDITION_FIELD_TO_VARIABLE[row.field];
            if (!variable) {
                return { unsupported: `حقل الشرط «${row.field}» لا يُطابِق متغيرًا في المنفِّذ — المتاح للنشر: الأولوية فقط (قائمة قيم الواجهة أولويات).`, label };
            }
            const operator = CONDITION_OP_MAP[row.op];
            if (!operator) return { unsupported: `عملية الشرط «${row.op}» غير مدعومة.`, label };
            const value = PRIORITY_LABEL_TO_VALUE[row.value];
            if (value === undefined) return { unsupported: `قيمة الشرط «${row.value}» ليست أولوية معروفة.`, label };
            return { type: 'condition.if_else', config: { variable, operator, value }, label };
        }
        case 'email': {
            if (ans.to === 'other') {
                return { unsupported: 'إرسال البريد لـ «بريد آخر» يحتاج عنوانًا لا توفره الواجهة؛ المنفِّذ يرسل لصاحب التذكرة فقط.', label };
            }
            if (!ans.subject || !ans.body) return { unsupported: 'البريد بلا موضوع أو نص.', label };
            return {
                type: 'action.send_email',
                config: { ticket_id: TICKET_ID_TEMPLATE, from_email: ans.from || 'support@mad3oom.com', subject: ans.subject, body: ans.body },
                label,
            };
        }
        case 'notify': {
            if (ans.to !== 'customer_portal') {
                return { unsupported: 'الإشعار الداخلي يتطلب user_id صريحًا في المنفِّذ؛ المتاح للنشر: لوحة العميل (صاحب التذكرة) فقط.', label };
            }
            if (!ans.text) return { unsupported: 'الإشعار بلا نص.', label };
            return {
                type: 'action.send_notification',
                config: { user_id: TICKET_USER_ID_TEMPLATE, title: 'إشعار من تدفق العمل', message: ans.text },
                label,
            };
        }
        case 'wait':
            return { unsupported: 'لا توجد عقدة انتظار (wait/delay) في محرك التنفيذ — لا يمكن نشر تدفق فيه انتظار.', label };
        case 'assign':
            return { unsupported: 'الإسناد في المنفِّذ يتطلب معرِّف موظف (assigned_to) صريحًا؛ الواجهة لا توفر اختيار موظف، و«الأقل انشغالًا» بلا مقابل.', label };
        case 'update_ticket': {
            if (ans.field === 'status') {
                const allowed = ['open', 'in-progress', 'resolved', 'confirmed', 'rejected', 'closed'];
                if (!allowed.includes(ans.value)) return { unsupported: `الحالة «${ans.value}» ليست حالة تذكرة معروفة.`, label };
                return { type: 'action.update_ticket_status', config: { ticket_id: TICKET_ID_TEMPLATE, new_status: ans.value }, label };
            }
            if (ans.field === 'tag') {
                return { unsupported: 'إضافة الوسم تحتاج اسم وسم لا توفره الواجهة (خيارات القيمة حالات لا أسماء وسوم).', label };
            }
            return { unsupported: `تحديث «${ans.field}» بلا فعل مقابل في المنفِّذ — المتاح للنشر: الحالة فقط.`, label };
        }
        case 'internal_note': {
            if (!ans.note) return { unsupported: 'التعليق الداخلي فارغ.', label };
            return { type: 'action.log_ticket_activity', config: { ticket_id: TICKET_ID_TEMPLATE, action_type: 'note', note: ans.note }, label };
        }
        default:
            return { unsupported: `نوع العقدة «${inst.type}» غير معروف للمحوِّل (منها «قريبًا» في المكتبة).`, label };
    }
}

/** تحقق النشر: التعريف جاهز للمنفِّذ؟ */
export function validateAutomationDefinition(definition) {
    const errors = [];
    const nodes = Array.isArray(definition?.nodes) ? definition.nodes : [];
    const edges = Array.isArray(definition?.edges) ? definition.edges : [];
    if (!nodes.some((n) => (n.type || '').startsWith('trigger.'))) {
        errors.push('لا يوجد مشغِّل (Trigger) في التدفق — لا يمكن نشره.');
    }
    for (const n of nodes) {
        if ((n.type || '').startsWith('unsupported.')) {
            errors.push(`العقدة «${n.id}» من نوع غير قابل للتنفيذ (${n.type.replace('unsupported.', '')}).`);
        } else if (!EXECUTOR_NODE_TYPES.has(n.type)) {
            errors.push(`العقدة «${n.id}» من نوع غير معروف للمنفِّذ: «${n.type}».`);
        }
    }
    const ids = new Set(nodes.map((n) => n.id));
    for (const e of edges) {
        if (!ids.has(e.source) || !ids.has(e.target)) errors.push(`حافة تشير لعقدة غير موجودة: ${e.source} ← ${e.target}.`);
    }
    return { ok: errors.length === 0, errors };
}

/**
 * يعيد بناء مخطط الواجهة من تعريف منفِّذ محفوظ.
 * يرجع {ok:false, error} بدل الإسقاط الصامت إن احتوى التعريف ما لا يُرمَّم.
 */
export function deserializeAutomationDefinition(definition) {
    const nodes = Array.isArray(definition?.nodes) ? definition.nodes : [];
    const edges = Array.isArray(definition?.edges) ? definition.edges : [];
    const graphNodes = {};
    const answers = {};
    const conditionState = {};

    // تموضع احتياطي حسب العمق من المشغِّل إن غابت الإحداثيات.
    const depth = {};
    const children = {};
    for (const e of edges) (children[e.source] ||= []).push(e.target);
    const queue = nodes.filter((n) => (n.type || '').startsWith('trigger.')).map((n) => n.id);
    for (const id of queue) depth[id] = 0;
    for (let i = 0; i < queue.length; i++) {
        for (const c of children[queue[i]] || []) {
            if (depth[c] === undefined) { depth[c] = depth[queue[i]] + 1; queue.push(c); }
        }
    }

    let yCursor = 40;
    for (const n of nodes) {
        const uiType = (n.type || '').startsWith('unsupported.')
            ? (n.config?.uiType || n.type.replace('unsupported.', ''))
            : EXECUTOR_TO_UI_TYPE[n.type];
        if (!uiType) return { ok: false, error: `تعريف التدفق يحوي عقدة لا يمكن عرضها في المصمم: «${n.type}».` };
        const x = typeof n.x === 'number' ? n.x : 460;
        const y = typeof n.y === 'number' ? n.y : (yCursor += 190);
        graphNodes[n.id] = { id: n.id, type: uiType, x, y, width: n.width || 300 };
        const back = nodeConfigToAnswers(uiType, n.config || {}, n.type || '');
        if (back.error) return { ok: false, error: back.error };
        if (back.answers) answers[n.id] = back.answers;
        if (back.condition) conditionState[n.id] = back.condition;
    }

    const outEdges = [];
    let seq = 1;
    for (const e of edges) {
        if (!graphNodes[e.source] || !graphNodes[e.target]) continue;
        outEdges.push({
            id: e.id || `edge_${seq++}`,
            from: e.source,
            to: e.target,
            fromPort: e.source_port === 'true' ? 'outYes' : e.source_port === 'false' ? 'outNo' : 'out',
            toPort: 'in',
        });
    }
    return { ok: true, graphNodes, edges: outEdges, answers, conditionState };
}

function nodeConfigToAnswers(uiType, cfg, executorType = '') {
    switch (uiType) {
        case 'trigger': {
            const event = executorType === 'trigger.ticket_status_changed' ? 'ticket_updated' : 'new_ticket';
            return { answers: { event } };
        }
        case 'condition': {
            if (cfg.variable !== 'ticket.priority') {
                return { error: `شرط على المتغير «${cfg.variable}» لا يمكن عرضه في المصمم (المتاح: أولوية التذكرة).` };
            }
            const op = cfg.operator === 'equals' ? 'تساوي' : cfg.operator === 'not_equals' ? 'لا تساوي' : null;
            if (!op) return { error: `عملية الشرط «${cfg.operator}» لا يمكن عرضها في المصمم.` };
            const value = PRIORITY_VALUE_TO_LABEL[cfg.value];
            if (!value) return { error: `قيمة الشرط «${cfg.value}» ليست أولوية معروفة.` };
            return { condition: { rows: [{ field: 'الأولوية', op, value }], logic: 'and' } };
        }
        case 'email':
            return { answers: { from: cfg.from_email || 'support@mad3oom.com', to: 'ticket_owner', subject: cfg.subject || '', body: cfg.body || '' } };
        case 'notify':
            return { answers: { to: 'customer_portal', text: cfg.message || '' } };
        case 'update_ticket':
            return { answers: { field: 'status', value: cfg.new_status || 'resolved' } };
        case 'internal_note':
            return { answers: { note: cfg.note || '' } };
        case 'assign':
        case 'wait':
            return { answers: {} };
        default:
            return { error: `نوع عقدة لا يمكن عرضه: «${uiType}».` };
    }
}
