/**
 * inbox-data.js — طبقة البيانات لصندوق الرسائل
 * ------------------------------------------------------------
 * ⚠️ الملف ده **بيانات تجريبية في الذاكرة**. مفيش قاعدة بيانات ولا
 * Supabase ولا رفع ملفات حقيقي. الواجهة الأمامية بس، زي ما اتطلب.
 *
 * ------------------------------------------------------------
 * ليه الوهمي في ملف لوحده
 *
 * لأن ده مكان الوصلة. `inbox.js` مابيعرفش إن البيانات وهمية — بينده على
 * نفس الدوال اللي الخلفية هتنفّذها بالظبط، وبنفس الشكل. يوم ما الجداول
 * تتعمل، **الملف ده هو اللي بيتغير**، والواجهة كلها ماتتلمسش.
 *
 * ------------------------------------------------------------
 * ده صندوق **دعم**، مش شات
 *
 * الفرق مش شكلي. الشات بيسأل «مين قال إيه»؛ صندوق الدعم بيسأل كمان
 * «الحالة دي مقفولة ولا لأ، ومين ماسكها، وإيه اللي اتقال للعميل وإيه
 * اللي اتقال بين الفريق». عشان كده الموديل هنا فيه:
 *
 *   status      — مفتوحة / قيد المعالجة / مقفولة
 *   assigneeId  — مين مسؤول، عشان محدش يفتكر إن حد تاني رد
 *   visibility  — رسالة للعميل ولا ملاحظة داخلية للفريق
 *
 * الحاجات التلاتة دي هي اللي بتخلي فريق يشتغل على نفس الصندوق من غير ما
 * يدوسوا على بعض.
 *
 * ------------------------------------------------------------
 * الأدوار — ودي مش تفصيلة شكلية
 *
 *   admin / support → كل أعضاء المنصة
 *   super_user      → أعضاؤه هو بس (اللي `owner_id` بتاعهم = هو)
 *
 * الفرق ده **متعمل هنا في `listContacts()`**، مش في الواجهة. لما الخلفية
 * تتعمل، لازم يتفرض تاني في RLS كمان — الواجهة بتخفي، والقاعدة بترفض.
 * إخفاء اسم من قايمة مش حماية.
 *
 * ------------------------------------------------------------
 * الشكل اللي الخلفية هترجّعه
 *
 * @typedef {Object} Contact
 * @property {string} id
 * @property {string} name
 * @property {string} email
 * @property {'admin'|'support'|'super_user'|'member'} role
 * @property {string|null} ownerId
 * @property {boolean} online
 *
 * @typedef {Object} Attachment
 * @property {string} id
 * @property {'document'|'voice'} kind
 * @property {string} name
 * @property {number} size
 * @property {string} [mime]
 * @property {number} [durationSeconds]
 * @property {string|null} url
 *
 * @typedef {Object} Message
 * @property {string} id
 * @property {string} conversationId
 * @property {string} senderId
 * @property {string} body
 * @property {string} createdAt - ISO
 * @property {string|null} editedAt - ISO، أو null لو مااتعدلتش
 * @property {boolean} deleted - الرسالة اتسحبت؛ بتفضل مكانها كأثر
 * @property {'reply'|'note'} visibility - 'note' = للفريق بس
 * @property {Attachment[]} attachments
 * @property {{fromName: string, fromConversation: string}|null} forwardedFrom
 * @property {string|null} replyToId
 * @property {string[]} mentions - معرّفات اللي اتمنشنوا
 * @property {Object<string, string[]>} reactions - رمز -> معرّفات
 * @property {string[]} readBy
 * @property {boolean} starred
 * @property {boolean} pinned
 *
 * @typedef {Object} Conversation
 * @property {string} id
 * @property {'direct'|'group'} kind
 * @property {string} title
 * @property {string[]} memberIds
 * @property {number} unread
 * @property {string|null} lastMessageAt
 * @property {'open'|'pending'|'closed'} status
 * @property {string|null} assigneeId
 * @property {string[]} labels
 * @property {boolean} archived
 * @property {boolean} muted
 * @property {string} draft
 */

/** مين فاتح الصفحة دلوقتي. الخلفية هتجيبه من الجلسة. */
let currentUser = {
    id: 'me',
    name: 'أنت',
    email: 'support@mad3oom.online',
    role: 'admin',
    ownerId: null,
    online: true
};

export function getCurrentUser() {
    return { ...currentUser };
}

/**
 * بيبدّل الدور المعروض. موجودة عشان الشخص اللي بيراجع الواجهة يقدر يشوف
 * الشاشتين من غير حسابين — **بتتشال أول ما الجلسة الحقيقية توصل**.
 */
export function setPreviewRole(role) {
    currentUser = {
        ...currentUser,
        role,
        name: role === 'super_user' ? 'مالك الفريق' : 'أنت',
        id: role === 'super_user' ? 'su_1' : 'me'
    };
}

// ═════════════════════════════════════════════════════════════
// الناس
// ═════════════════════════════════════════════════════════════

const CONTACTS = [
    { id: 'me', name: 'أنت', email: 'support@mad3oom.online', role: 'admin', ownerId: null, online: true },
    { id: 'u_1', name: 'محمود عبدالوهاب', email: 'mahmoud@example.com', role: 'member', ownerId: null, online: true },
    { id: 'u_2', name: 'سارة إبراهيم', email: 'sara@example.com', role: 'member', ownerId: null, online: false },
    { id: 'u_3', name: 'كريم مصطفى', email: 'karim@example.com', role: 'member', ownerId: null, online: true },
    { id: 'u_4', name: 'نورهان علي', email: 'nourhan@example.com', role: 'member', ownerId: null, online: false },
    { id: 'u_5', name: 'أحمد فتحي', email: 'ahmed@example.com', role: 'member', ownerId: null, online: false },
    { id: 'su_1', name: 'مالك الفريق', email: 'owner@company.com', role: 'super_user', ownerId: null, online: true },

    // أعضاء تبع السوبر يوزر — دول اللي هو بيشوفهم لوحدهم
    { id: 'm_1', name: 'ياسمين حسن', email: 'yasmin@company.com', role: 'member', ownerId: 'su_1', online: true },
    { id: 'm_2', name: 'عمرو سعيد', email: 'amr@company.com', role: 'member', ownerId: 'su_1', online: false },
    { id: 'm_3', name: 'دينا كمال', email: 'dina@company.com', role: 'member', ownerId: 'su_1', online: true },

    { id: 'st_1', name: 'فريق الدعم', email: 'team@mad3oom.online', role: 'support', ownerId: null, online: true },
    { id: 'st_2', name: 'هبة سمير', email: 'heba@mad3oom.online', role: 'support', ownerId: null, online: true }
];

/**
 * مين الشخص ده مسموح له يكلّمه.
 *
 * ده الفرق الحقيقي بين الدورين، ومكتوب هنا مرة واحدة عشان مايتكررش في
 * كل شاشة بتعرض ناس (المحادثة الجديدة، المجموعة، التحويل، الإسناد).
 */
export function listContacts() {
    const me = getCurrentUser();
    if (me.role === 'super_user') {
        return CONTACTS.filter((c) => c.ownerId === me.id || c.role === 'support');
    }
    return CONTACTS.filter((c) => c.id !== me.id);
}

/** اللي ينفع تسند لهم محادثة: فريق الشغل بس، مش العملاء. */
export function listAssignableAgents() {
    const me = getCurrentUser();
    return CONTACTS.filter((c) => ['admin', 'support', 'super_user'].includes(c.role) && c.id !== me.id)
        .concat([{ ...me }]);
}

export function findContact(id) {
    return CONTACTS.find((c) => c.id === id) || (id === currentUser.id ? getCurrentUser() : null);
}

/** أول حرفين من الاسم — بديل الصورة الرمزية. */
export function initialsOf(name) {
    return String(name || '؟').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('');
}

// ═════════════════════════════════════════════════════════════
// الردود الجاهزة
// ═════════════════════════════════════════════════════════════

/**
 * الردود اللي بتتكتب خمسين مرة في اليوم.
 *
 * `{{الاسم}}` بتتبدّل باسم الطرف التاني وقت الإدراج — رد جاهز بيوصل
 * للعميل باسم حد تاني أسوأ من إنه يتكتب من الأول.
 */
const CANNED_REPLIES = [
    { id: 'cr_1', shortcut: 'ترحيب', title: 'ترحيب', body: 'أهلاً {{الاسم}}، معاك فريق دعم مدعوم. إزاي أقدر أساعدك؟' },
    { id: 'cr_2', shortcut: 'استنى', title: 'طلب مهلة', body: 'تمام {{الاسم}}، براجع الموضوع دلوقتي وهرجعلك خلال شوية.' },
    { id: 'cr_3', shortcut: 'تفاصيل', title: 'طلب تفاصيل', body: 'ممكن تبعتلي صورة للشاشة اللي ظهرتلك، والوقت التقريبي اللي حصلت فيه المشكلة؟' },
    { id: 'cr_4', shortcut: 'اتحلت', title: 'تأكيد الحل', body: 'تمام، المشكلة اتحلت من عندنا. جرّب تاني وقولي لو لسه فيه حاجة.' },
    { id: 'cr_5', shortcut: 'قفل', title: 'إقفال المحادثة', body: 'هقفل المحادثة دي دلوقتي. لو احتجت أي حاجة تانية، ابعتلي في أي وقت.' }
];

export function listCannedReplies() {
    return CANNED_REPLIES.map((r) => ({ ...r }));
}

/** بيحطّ اسم الطرف التاني مكان `{{الاسم}}`. */
export function fillCannedReply(body, conversationId) {
    const conversation = conversations.find((c) => c.id === conversationId);
    const name = conversation ? counterpartName(conversation) : '';
    return body.replace(/\{\{\s*الاسم\s*\}\}/g, name);
}

function counterpartName(conversation) {
    const me = getCurrentUser();
    if (conversation.kind === 'group') return conversation.title;
    return findContact(conversation.memberIds.find((id) => id !== me.id))?.name || '';
}

// ═════════════════════════════════════════════════════════════
// المحادثات
// ═════════════════════════════════════════════════════════════

export const STATUS_LABELS = { open: 'مفتوحة', pending: 'قيد المعالجة', closed: 'مقفولة' };
export const LABEL_COLORS = {
    'عاجل': 'danger', 'فوترة': 'warn', 'تقني': 'accent', 'متابعة': 'muted'
};

const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();

const baseConversation = {
    unread: 0, status: 'open', assigneeId: null, labels: [],
    archived: false, muted: false, draft: ''
};

let conversations = [
    { ...baseConversation, id: 'c_1', kind: 'direct', title: '', memberIds: ['me', 'u_1'], unread: 2, lastMessageAt: minutesAgo(4), assigneeId: 'me', labels: ['عاجل', 'تقني'] },
    { ...baseConversation, id: 'c_2', kind: 'group', title: 'فريق الدعم — الوردية الصباحية', memberIds: ['me', 'st_1', 'st_2', 'u_3'], lastMessageAt: minutesAgo(52) },
    { ...baseConversation, id: 'c_3', kind: 'direct', title: '', memberIds: ['me', 'u_2'], lastMessageAt: minutesAgo(190), status: 'closed', assigneeId: 'me', labels: ['فوترة'] },
    { ...baseConversation, id: 'c_4', kind: 'direct', title: '', memberIds: ['me', 'u_4'], unread: 1, lastMessageAt: minutesAgo(1500), status: 'pending', labels: ['متابعة'] },
    { ...baseConversation, id: 'c_7', kind: 'direct', title: '', memberIds: ['me', 'u_5'], lastMessageAt: minutesAgo(4300), archived: true },
    // بتوع السوبر يوزر
    { ...baseConversation, id: 'c_5', kind: 'direct', title: '', memberIds: ['su_1', 'm_1'], unread: 1, lastMessageAt: minutesAgo(12), assigneeId: 'su_1' },
    { ...baseConversation, id: 'c_6', kind: 'group', title: 'فريقي', memberIds: ['su_1', 'm_1', 'm_2', 'm_3'], lastMessageAt: minutesAgo(300) }
];

const baseMessage = {
    editedAt: null, deleted: false, visibility: 'reply', attachments: [],
    forwardedFrom: null, replyToId: null, mentions: [], reactions: {},
    readBy: [], starred: false, pinned: false
};

let messages = [
    { ...baseMessage, id: 'msg_1', conversationId: 'c_1', senderId: 'u_1', body: 'مساء الخير، عندي مشكلة في ربط رقم واتساب جديد على الباقة.', createdAt: minutesAgo(40), readBy: ['me'], pinned: true },
    { ...baseMessage, id: 'msg_2', conversationId: 'c_1', senderId: 'me', body: 'أهلاً بيك. ممكن تبعتلي صورة للرسالة اللي ظهرتلك؟', createdAt: minutesAgo(33), readBy: ['u_1'], replyToId: 'msg_1' },
    { ...baseMessage, id: 'msg_note_1', conversationId: 'c_1', senderId: 'me', body: 'ملاحظة: الحساب ده عليه تذكرتين مقفولين لنفس السبب. لو اتكرر، نصعّد للفريق التقني.', createdAt: minutesAgo(30), visibility: 'note' },
    { ...baseMessage, id: 'msg_3', conversationId: 'c_1', senderId: 'u_1', body: 'دي الشاشة، وده كمان تقرير من عندنا.', createdAt: minutesAgo(9), readBy: ['me'], reactions: { '👍': ['me'] }, attachments: [{ id: 'a_1', kind: 'document', name: 'تقرير-الربط.pdf', size: 284_512, mime: 'application/pdf', url: null }] },
    { ...baseMessage, id: 'msg_4', conversationId: 'c_1', senderId: 'u_1', body: '', createdAt: minutesAgo(4), attachments: [{ id: 'a_2', kind: 'voice', name: 'رسالة صوتية', size: 41_800, durationSeconds: 17, url: null }] },

    { ...baseMessage, id: 'msg_5', conversationId: 'c_2', senderId: 'st_1', body: 'تذكير: التذاكر المفتوحة من إمبارح لازم تتقفل النهاردة.', createdAt: minutesAgo(140), pinned: true, readBy: ['me', 'st_2'] },
    { ...baseMessage, id: 'msg_6', conversationId: 'c_2', senderId: 'u_3', body: 'تمام، أنا خلصت اتنين وباقي واحدة.', createdAt: minutesAgo(52), reactions: { '✅': ['me', 'st_1'] } },
    { ...baseMessage, id: 'msg_6b', conversationId: 'c_2', senderId: 'st_2', body: '@أنت ممكن تراجع التذكرة ٤١٢ لما تفضى؟', createdAt: minutesAgo(50), mentions: ['me'] },

    { ...baseMessage, id: 'msg_7', conversationId: 'c_3', senderId: 'me', body: 'اتفضلي كشف الحساب بتاع الشهر ده.', createdAt: minutesAgo(200), readBy: ['u_2'], attachments: [{ id: 'a_3', kind: 'document', name: 'كشف-حساب-يوليو.xlsx', size: 61_204, mime: 'application/vnd.ms-excel', url: null }] },
    { ...baseMessage, id: 'msg_8', conversationId: 'c_3', senderId: 'u_2', body: 'وصلني، شكراً ليك.', createdAt: minutesAgo(190), readBy: ['me'] },

    { ...baseMessage, id: 'msg_9', conversationId: 'c_4', senderId: 'u_4', body: 'ممكن حد يراجع طلب الاسترداد بتاعي؟', createdAt: minutesAgo(1500) },
    { ...baseMessage, id: 'msg_10', conversationId: 'c_5', senderId: 'm_1', body: 'خلصت المهام اللي بعتهالي، محتاجة مراجعة.', createdAt: minutesAgo(12) },
    { ...baseMessage, id: 'msg_11', conversationId: 'c_6', senderId: 'su_1', body: 'اجتماع الفريق بكرة الساعة ١١.', createdAt: minutesAgo(300) },
    { ...baseMessage, id: 'msg_12', conversationId: 'c_7', senderId: 'u_5', body: 'تمام، اتحلت. شكراً.', createdAt: minutesAgo(4300), readBy: ['me'] }
];

let nextId = 100;
const makeId = (prefix) => `${prefix}_${nextId++}`;

// ── القراءة ──────────────────────────────────────────────────

/**
 * المحادثات اللي الشخص ده طرف فيها، الأحدث الأول.
 *
 * العضوية هي الفلتر — مش الدور. الأدمن مابيشوفش محادثات الناس مع بعض،
 * بيشوف اللي هو فيها. ده هيبقى نفس شرط الـ RLS بالظبط.
 */
export function listConversations({ view = 'all', query = '' } = {}) {
    const me = getCurrentUser();
    const q = query.trim().toLowerCase();

    return conversations
        .filter((c) => c.memberIds.includes(me.id))
        .filter((c) => matchesView(c, view, me))
        .filter((c) => {
            if (!q) return true;
            // البحث بيدوّر في نص الرسايل والعناوين والوسوم — الناس
            // بتفتكر اللي اتقال أكتر ما بتفتكر مع مين.
            const hay = [
                displayTitle(c), ...c.labels,
                ...listMessages(c.id, { includeNotes: true }).map((m) => m.body)
            ].join(' ').toLowerCase();
            return hay.includes(q);
        })
        .map((c) => ({ ...c, title: displayTitle(c) }))
        .sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0));
}

/**
 * المشهد المختار. «المؤرشفة» بتتخفي من كل المشاهد التانية عن قصد — ده
 * معنى الأرشفة أصلاً، وإلا الزرار مابيعملش حاجة.
 */
function matchesView(conversation, view, me) {
    if (view === 'archived') return conversation.archived;
    if (conversation.archived) return false;

    switch (view) {
        case 'unread': return conversation.unread > 0;
        case 'mine': return conversation.assigneeId === me.id;
        case 'unassigned': return !conversation.assigneeId && conversation.status !== 'closed';
        case 'open': return conversation.status !== 'closed';
        case 'closed': return conversation.status === 'closed';
        default: return true;
    }
}

/** عدّاد كل مشهد — عشان الأرقام تبان جنب الأسماء من غير ما الواجهة تحسبها. */
export function viewCounts() {
    const views = ['all', 'unread', 'mine', 'unassigned', 'open', 'closed', 'archived'];
    return Object.fromEntries(views.map((v) => [v, listConversations({ view: v }).length]));
}

export function displayTitle(conversation) {
    if (conversation.kind === 'group') return conversation.title || 'مجموعة بدون اسم';
    return counterpartName(conversation) || 'محادثة';
}

export function findConversation(id) {
    const conversation = conversations.find((c) => c.id === id);
    return conversation ? { ...conversation, title: displayTitle(conversation) } : null;
}

/**
 * @param {string} conversationId
 * @param {{includeNotes?: boolean}} [options] - الملاحظات الداخلية بتتشال
 *   لما نحاكي «إيه اللي العميل شافه»
 */
export function listMessages(conversationId, { includeNotes = true } = {}) {
    return messages
        .filter((m) => m.conversationId === conversationId)
        .filter((m) => includeNotes || m.visibility !== 'note')
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

export function findMessage(id) {
    return messages.find((m) => m.id === id) || null;
}

export function lastMessageOf(conversationId) {
    const list = listMessages(conversationId);
    return list.length ? list[list.length - 1] : null;
}

/** المثبّتة فوق، عشان اللي بيفتح المحادثة يشوف الأهم من غير ما يمرّر. */
export function pinnedMessages(conversationId) {
    return listMessages(conversationId).filter((m) => m.pinned && !m.deleted);
}

export function starredMessages() {
    const me = getCurrentUser();
    const mine = new Set(conversations.filter((c) => c.memberIds.includes(me.id)).map((c) => c.id));
    return messages.filter((m) => m.starred && mine.has(m.conversationId));
}

/** كل المرفقات في محادثة — لتبويب الملفات. */
export function conversationAttachments(conversationId) {
    return listMessages(conversationId)
        .filter((m) => !m.deleted)
        .flatMap((m) => m.attachments.map((a) => ({ ...a, messageId: m.id, senderId: m.senderId, createdAt: m.createdAt })));
}

/** اللي لسه ماقروش رسالتي — إيصال القراءة في المجموعات. */
export function readReceipt(message, conversation) {
    const others = conversation.memberIds.filter((id) => id !== message.senderId);
    const read = others.filter((id) => message.readBy.includes(id));
    return { read: read.length, total: others.length, names: read.map((id) => findContact(id)?.name).filter(Boolean) };
}

// ── الكتابة ──────────────────────────────────────────────────

export function markRead(conversationId) {
    const conversation = conversations.find((c) => c.id === conversationId);
    if (conversation) conversation.unread = 0;

    const me = getCurrentUser();
    listMessages(conversationId).forEach((m) => {
        if (m.senderId !== me.id && !m.readBy.includes(me.id)) m.readBy.push(me.id);
    });
}

/**
 * @param {Object} params
 * @param {string} params.conversationId
 * @param {string} [params.body]
 * @param {Attachment[]} [params.attachments]
 * @param {'reply'|'note'} [params.visibility]
 * @param {string|null} [params.replyToId]
 * @param {Object|null} [params.forwardedFrom]
 * @returns {Message}
 */
export function sendMessage({
    conversationId, body = '', attachments = [],
    visibility = 'reply', replyToId = null, forwardedFrom = null
}) {
    const message = {
        ...baseMessage,
        id: makeId('msg'),
        conversationId,
        senderId: getCurrentUser().id,
        body: body.trim(),
        createdAt: new Date().toISOString(),
        attachments,
        visibility,
        replyToId,
        forwardedFrom,
        mentions: extractMentions(body, conversationId),
        reactions: {},
        readBy: []
    };
    messages.push(message);

    const conversation = conversations.find((c) => c.id === conversationId);
    if (conversation) {
        // الملاحظة الداخلية مابتحرّكش المحادثة لفوق ولا بتفتحها من تاني —
        // دي مذكرة للفريق، مش رد على العميل.
        if (visibility === 'reply') {
            conversation.lastMessageAt = message.createdAt;
            if (conversation.status === 'closed') conversation.status = 'open';
        }
        conversation.draft = '';
    }
    return message;
}

/** «@اسم» -> معرّف، من أعضاء المحادثة بس. */
function extractMentions(body, conversationId) {
    const conversation = conversations.find((c) => c.id === conversationId);
    if (!conversation) return [];
    return conversation.memberIds.filter((id) => {
        const name = findContact(id)?.name;
        return name && body.includes(`@${name}`);
    });
}

/**
 * التعديل بيسيب أثر (`editedAt`) عن قصد.
 *
 * رسالة اتغيرت من غير ما حد يعرف بتخلي سجل المحادثة غير موثوق — واللي
 * بيقرا بعد كده مايقدرش يفرّق بين «ده اللي اتقال» و«ده اللي بقى مكتوب».
 */
export function editMessage(messageId, newBody) {
    const message = messages.find((m) => m.id === messageId);
    if (!message) return { ok: false, error: 'الرسالة مش موجودة.' };
    if (message.senderId !== getCurrentUser().id) return { ok: false, error: 'مينفعش تعدّل رسالة حد تاني.' };
    if (message.deleted) return { ok: false, error: 'الرسالة دي اتسحبت.' };

    const body = String(newBody || '').trim();
    if (!body) return { ok: false, error: 'الرسالة ماينفعش تبقى فاضية.' };

    message.body = body;
    message.editedAt = new Date().toISOString();
    message.mentions = extractMentions(body, message.conversationId);
    return { ok: true };
}

/**
 * السحب بيسيب مكان الرسالة فاضي بدل ما يشيلها خالص.
 *
 * لأن الرد اللي تحتها بيبقى مالوش معنى من غيرها، ولأن «الرسالة دي
 * اتسحبت» معلومة في حد ذاتها لأي حد كان شايفها.
 */
export function deleteMessage(messageId) {
    const message = messages.find((m) => m.id === messageId);
    if (!message) return { ok: false, error: 'الرسالة مش موجودة.' };
    if (message.senderId !== getCurrentUser().id) return { ok: false, error: 'مينفعش تسحب رسالة حد تاني.' };

    message.deleted = true;
    message.body = '';
    message.attachments = [];
    message.reactions = {};
    message.pinned = false;
    return { ok: true };
}

export function toggleReaction(messageId, emoji) {
    const message = messages.find((m) => m.id === messageId);
    if (!message || message.deleted) return;

    const me = getCurrentUser().id;
    const list = message.reactions[emoji] || [];
    message.reactions[emoji] = list.includes(me) ? list.filter((id) => id !== me) : [...list, me];
    if (!message.reactions[emoji].length) delete message.reactions[emoji];
}

export function toggleStar(messageId) {
    const message = messages.find((m) => m.id === messageId);
    if (message) message.starred = !message.starred;
}

export function togglePin(messageId) {
    const message = messages.find((m) => m.id === messageId);
    if (message && !message.deleted) message.pinned = !message.pinned;
}

export function setStatus(conversationId, status) {
    const conversation = conversations.find((c) => c.id === conversationId);
    if (conversation && status in STATUS_LABELS) conversation.status = status;
}

export function setAssignee(conversationId, assigneeId) {
    const conversation = conversations.find((c) => c.id === conversationId);
    if (conversation) conversation.assigneeId = assigneeId || null;
}

export function toggleLabel(conversationId, label) {
    const conversation = conversations.find((c) => c.id === conversationId);
    if (!conversation) return;
    conversation.labels = conversation.labels.includes(label)
        ? conversation.labels.filter((l) => l !== label)
        : [...conversation.labels, label];
}

export function setArchived(conversationId, archived) {
    const conversation = conversations.find((c) => c.id === conversationId);
    if (conversation) conversation.archived = Boolean(archived);
}

export function setMuted(conversationId, muted) {
    const conversation = conversations.find((c) => c.id === conversationId);
    if (conversation) conversation.muted = Boolean(muted);
}

/**
 * المسودة بتتحفظ لكل محادثة لوحدها.
 *
 * اللي بيشتغل على صندوق دعم بيقفز بين محادثات طول اليوم؛ لو نص الرد
 * بيضيع كل مرة يبص على حاجة تانية، هيبطّل يقفز — أو هيبطّل يكتب ردود
 * طويلة.
 */
export function saveDraft(conversationId, text) {
    const conversation = conversations.find((c) => c.id === conversationId);
    if (conversation) conversation.draft = text;
}

export function openDirectConversation(contactId) {
    const me = getCurrentUser();
    const existing = conversations.find((c) =>
        c.kind === 'direct' && c.memberIds.length === 2
        && c.memberIds.includes(me.id) && c.memberIds.includes(contactId));
    if (existing) {
        // لو كانت مؤرشفة، بترجع من الأرشيف. من غير كده اللي بيختار الشخص
        // من «محادثة جديدة» بتتفتحله محادثة مش موجودة في أي قايمة —
        // يعني يقفلها ومايلاقيهاش تاني.
        existing.archived = false;
        return existing;
    }

    const conversation = {
        ...baseConversation,
        id: makeId('c'), kind: 'direct', title: '',
        memberIds: [me.id, contactId],
        lastMessageAt: new Date().toISOString()
    };
    conversations.push(conversation);
    return conversation;
}

export function createGroup({ title, memberIds }) {
    const name = String(title || '').trim();
    if (!name) return { conversation: null, error: 'المجموعة محتاجة اسم.' };
    if (!memberIds.length) return { conversation: null, error: 'اختار عضو واحد على الأقل.' };

    const me = getCurrentUser();
    const conversation = {
        ...baseConversation,
        id: makeId('c'), kind: 'group', title: name,
        // منشئ المجموعة عضو فيها بالضرورة — مجموعة من غير صاحبها حاجة
        // محدش يقدر يوصلها.
        memberIds: [me.id, ...memberIds.filter((id) => id !== me.id)],
        lastMessageAt: new Date().toISOString()
    };
    conversations.push(conversation);
    return { conversation, error: null };
}

/**
 * تحويل رسالة لمحادثة تانية.
 *
 * بتتنسخ مع مصدرها، مش بتتنقل: الرسالة الأصلية بتفضل مكانها في سياقها،
 * واللي بيستقبلها بيشوف إنها محوّلة ومن مين — رسالة بتظهر من غير سياق
 * بتتقري كإن اللي محوّلها هو اللي قالها.
 *
 * الملاحظات الداخلية بتتحوّل كملاحظات، مش كردود. تحويل ملاحظة فريق
 * لمحادثة عميل هو بالظبط التسريب اللي الفصل ده موجود عشانه.
 */
export function forwardMessage({ messageId, toConversationId }) {
    const original = messages.find((m) => m.id === messageId);
    if (!original || original.deleted) return null;

    const source = conversations.find((c) => c.id === original.conversationId);
    return sendMessage({
        conversationId: toConversationId,
        body: original.body,
        attachments: original.attachments.map((a) => ({ ...a, id: makeId('a') })),
        visibility: original.visibility,
        forwardedFrom: {
            fromName: findContact(original.senderId)?.name || 'مستخدم',
            fromConversation: source ? displayTitle(source) : ''
        }
    });
}

/** إجمالي غير المقروء — للشارة في القايمة الجانبية. */
export function totalUnread() {
    return listConversations().reduce((sum, c) => sum + c.unread, 0);
}
