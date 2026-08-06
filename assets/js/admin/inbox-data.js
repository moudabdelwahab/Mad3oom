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
 * فالشكل اللي تحت مش «أي حاجة تشتغل دلوقتي» — ده العقد. أي تغيير فيه
 * بعد كده هيبقى تغيير في مكانين مش واحد.
 *
 * ------------------------------------------------------------
 * الأدوار — ودي مش تفصيلة شكلية
 *
 * الصندوق ده بيخدم دورين مختلفين، وكل واحد بيشوف ناس مختلفة:
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
 * @property {string|null} ownerId - لأعضاء السوبر يوزر: مين صاحبهم
 * @property {boolean} online
 *
 * @typedef {Object} Attachment
 * @property {string} id
 * @property {'document'|'voice'} kind
 * @property {string} name
 * @property {number} size - بالبايت
 * @property {string} [mime]
 * @property {number} [durationSeconds] - للصوت بس
 * @property {string|null} url - blob: دلوقتي، ولينك تخزين بعدين
 *
 * @typedef {Object} Message
 * @property {string} id
 * @property {string} conversationId
 * @property {string} senderId
 * @property {string} body
 * @property {string} createdAt - ISO
 * @property {Attachment[]} attachments
 * @property {{fromName: string, fromConversation: string}|null} forwardedFrom
 *
 * @typedef {Object} Conversation
 * @property {string} id
 * @property {'direct'|'group'} kind
 * @property {string} title - للمجموعات؛ للفردي بيتحسب من الطرف التاني
 * @property {string[]} memberIds
 * @property {number} unread
 * @property {string|null} lastMessageAt - ISO
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

    { id: 'st_1', name: 'فريق الدعم', email: 'team@mad3oom.online', role: 'support', ownerId: null, online: true }
];

/**
 * مين الشخص ده مسموح له يكلّمه.
 *
 * ده الفرق الحقيقي بين الدورين، ومكتوب هنا مرة واحدة عشان مايتكررش في
 * كل شاشة بتعرض ناس (المحادثة الجديدة، المجموعة الجديدة، التحويل).
 */
export function listContacts() {
    const me = getCurrentUser();

    if (me.role === 'super_user') {
        // أعضاؤه هو بس. فريق الدعم مضاف عشان يقدر يوصلهم لو احتاج.
        return CONTACTS.filter((c) => c.ownerId === me.id || c.role === 'support');
    }

    // الأدمن والدعم بيشوفوا كل حد ما عدا نفسهم.
    return CONTACTS.filter((c) => c.id !== me.id);
}

export function findContact(id) {
    const me = getCurrentUser();
    if (id === me.id) return me;
    return CONTACTS.find((c) => c.id === id) || null;
}

/** أول حرفين من الاسم — بديل الصورة الرمزية. */
export function initialsOf(name) {
    return String(name || '؟')
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part[0])
        .join('');
}

// ═════════════════════════════════════════════════════════════
// المحادثات
// ═════════════════════════════════════════════════════════════

const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();

let conversations = [
    {
        id: 'c_1',
        kind: 'direct',
        title: '',
        memberIds: ['me', 'u_1'],
        unread: 2,
        lastMessageAt: minutesAgo(4)
    },
    {
        id: 'c_2',
        kind: 'group',
        title: 'فريق الدعم — الوردية الصباحية',
        memberIds: ['me', 'st_1', 'u_2', 'u_3'],
        unread: 0,
        lastMessageAt: minutesAgo(52)
    },
    {
        id: 'c_3',
        kind: 'direct',
        title: '',
        memberIds: ['me', 'u_2'],
        unread: 0,
        lastMessageAt: minutesAgo(190)
    },
    {
        id: 'c_4',
        kind: 'direct',
        title: '',
        memberIds: ['me', 'u_4'],
        unread: 1,
        lastMessageAt: minutesAgo(1500)
    },
    // بتوع السوبر يوزر
    {
        id: 'c_5',
        kind: 'direct',
        title: '',
        memberIds: ['su_1', 'm_1'],
        unread: 1,
        lastMessageAt: minutesAgo(12)
    },
    {
        id: 'c_6',
        kind: 'group',
        title: 'فريقي',
        memberIds: ['su_1', 'm_1', 'm_2', 'm_3'],
        unread: 0,
        lastMessageAt: minutesAgo(300)
    }
];

let messages = [
    {
        id: 'msg_1', conversationId: 'c_1', senderId: 'u_1',
        body: 'مساء الخير، عندي مشكلة في ربط رقم واتساب جديد على الباقة.',
        createdAt: minutesAgo(40), attachments: [], forwardedFrom: null
    },
    {
        id: 'msg_2', conversationId: 'c_1', senderId: 'me',
        body: 'أهلاً بيك. ممكن تبعتلي صورة للرسالة اللي ظهرتلك؟',
        createdAt: minutesAgo(33), attachments: [], forwardedFrom: null
    },
    {
        id: 'msg_3', conversationId: 'c_1', senderId: 'u_1',
        body: 'دي الشاشة، وده كمان تقرير من عندنا.',
        createdAt: minutesAgo(9),
        attachments: [
            { id: 'a_1', kind: 'document', name: 'تقرير-الربط.pdf', size: 284_512, mime: 'application/pdf', url: null }
        ],
        forwardedFrom: null
    },
    {
        id: 'msg_4', conversationId: 'c_1', senderId: 'u_1',
        body: '',
        createdAt: minutesAgo(4),
        attachments: [
            { id: 'a_2', kind: 'voice', name: 'رسالة صوتية', size: 41_800, durationSeconds: 17, url: null }
        ],
        forwardedFrom: null
    },

    {
        id: 'msg_5', conversationId: 'c_2', senderId: 'st_1',
        body: 'تذكير: التذاكر المفتوحة من إمبارح لازم تتقفل النهاردة.',
        createdAt: minutesAgo(140), attachments: [], forwardedFrom: null
    },
    {
        id: 'msg_6', conversationId: 'c_2', senderId: 'u_3',
        body: 'تمام، أنا خلصت اتنين وباقي واحدة.',
        createdAt: minutesAgo(52), attachments: [], forwardedFrom: null
    },

    {
        id: 'msg_7', conversationId: 'c_3', senderId: 'me',
        body: 'اتفضلي كشف الحساب بتاع الشهر ده.',
        createdAt: minutesAgo(200),
        attachments: [
            { id: 'a_3', kind: 'document', name: 'كشف-حساب-يوليو.xlsx', size: 61_204, mime: 'application/vnd.ms-excel', url: null }
        ],
        forwardedFrom: null
    },
    {
        id: 'msg_8', conversationId: 'c_3', senderId: 'u_2',
        body: 'وصلني، شكراً ليك.',
        createdAt: minutesAgo(190), attachments: [], forwardedFrom: null
    },

    {
        id: 'msg_9', conversationId: 'c_4', senderId: 'u_4',
        body: 'ممكن حد يراجع طلب الاسترداد بتاعي؟',
        createdAt: minutesAgo(1500), attachments: [], forwardedFrom: null
    },

    {
        id: 'msg_10', conversationId: 'c_5', senderId: 'm_1',
        body: 'خلصت المهام اللي بعتهالي، محتاجة مراجعة.',
        createdAt: minutesAgo(12), attachments: [], forwardedFrom: null
    },
    {
        id: 'msg_11', conversationId: 'c_6', senderId: 'su_1',
        body: 'اجتماع الفريق بكرة الساعة ١١.',
        createdAt: minutesAgo(300), attachments: [], forwardedFrom: null
    }
];

let nextId = 100;
const makeId = (prefix) => `${prefix}_${nextId++}`;

/**
 * المحادثات اللي الشخص ده طرف فيها، الأحدث الأول.
 *
 * العضوية هي الفلتر — مش الدور. الأدمن مابيشوفش محادثات الناس مع بعض،
 * بيشوف اللي هو فيها. ده هيبقى نفس شرط الـ RLS بالظبط.
 */
export function listConversations() {
    const me = getCurrentUser();
    return conversations
        .filter((c) => c.memberIds.includes(me.id))
        .map((c) => ({ ...c, title: displayTitle(c) }))
        .sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0));
}

/** المجموعة ليها اسم؛ الفردية اسمها هو الطرف التاني. */
export function displayTitle(conversation) {
    if (conversation.kind === 'group') return conversation.title || 'مجموعة بدون اسم';
    const me = getCurrentUser();
    const other = conversation.memberIds.find((id) => id !== me.id);
    return findContact(other)?.name || 'محادثة';
}

export function listMessages(conversationId) {
    return messages
        .filter((m) => m.conversationId === conversationId)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

export function lastMessageOf(conversationId) {
    const list = listMessages(conversationId);
    return list.length ? list[list.length - 1] : null;
}

export function markRead(conversationId) {
    const conversation = conversations.find((c) => c.id === conversationId);
    if (conversation) conversation.unread = 0;
}

/**
 * @param {{conversationId: string, body?: string, attachments?: Attachment[], forwardedFrom?: Object|null}} params
 * @returns {Message}
 */
export function sendMessage({ conversationId, body = '', attachments = [], forwardedFrom = null }) {
    const message = {
        id: makeId('msg'),
        conversationId,
        senderId: getCurrentUser().id,
        body: body.trim(),
        createdAt: new Date().toISOString(),
        attachments,
        forwardedFrom
    };
    messages.push(message);

    const conversation = conversations.find((c) => c.id === conversationId);
    if (conversation) conversation.lastMessageAt = message.createdAt;

    return message;
}

/**
 * محادثة فردية مع شخص. لو فيه واحدة موجودة بترجّعها بدل ما تعمل تانية —
 * محادثتين مع نفس الشخص معناها إن نص الكلام يضيع في وحدة والباقي في
 * التانية.
 */
export function openDirectConversation(contactId) {
    const me = getCurrentUser();
    const existing = conversations.find((c) =>
        c.kind === 'direct'
        && c.memberIds.length === 2
        && c.memberIds.includes(me.id)
        && c.memberIds.includes(contactId));

    if (existing) return existing;

    const conversation = {
        id: makeId('c'),
        kind: 'direct',
        title: '',
        memberIds: [me.id, contactId],
        unread: 0,
        lastMessageAt: new Date().toISOString()
    };
    conversations.push(conversation);
    return conversation;
}

/**
 * @param {{title: string, memberIds: string[]}} params
 * @returns {{conversation: Conversation|null, error: string|null}}
 */
export function createGroup({ title, memberIds }) {
    const name = String(title || '').trim();
    if (!name) return { conversation: null, error: 'المجموعة محتاجة اسم.' };
    if (!memberIds.length) return { conversation: null, error: 'اختار عضو واحد على الأقل.' };

    const me = getCurrentUser();
    const conversation = {
        id: makeId('c'),
        kind: 'group',
        title: name,
        // منشئ المجموعة عضو فيها بالضرورة — مجموعة من غير صاحبها حاجة
        // محدش يقدر يوصلها.
        memberIds: [me.id, ...memberIds.filter((id) => id !== me.id)],
        unread: 0,
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
 */
export function forwardMessage({ messageId, toConversationId }) {
    const original = messages.find((m) => m.id === messageId);
    if (!original) return null;

    const sourceConversation = conversations.find((c) => c.id === original.conversationId);
    return sendMessage({
        conversationId: toConversationId,
        body: original.body,
        attachments: original.attachments.map((a) => ({ ...a, id: makeId('a') })),
        forwardedFrom: {
            fromName: findContact(original.senderId)?.name || 'مستخدم',
            fromConversation: sourceConversation ? displayTitle(sourceConversation) : ''
        }
    });
}

/** إجمالي غير المقروء — للشارة في القايمة الجانبية. */
export function totalUnread() {
    return listConversations().reduce((sum, c) => sum + c.unread, 0);
}
