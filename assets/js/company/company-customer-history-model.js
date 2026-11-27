/**
 * company-customer-history-model.js — سجل العميل داخل الشركة: دوال خالصة.
 *
 * بلا DOM وبلا شبكة: تلخيص حزمة company_customer_history (146) وتجميع
 * ردودها تحت تذاكرها. تُختبَر بمعزل (tests/company-customer-history-model.test.mjs).
 *
 * الحزمة كما ترجعها القاعدة (أو null حين لا وصول):
 *   customer, tickets (≤100), replies (≤200), conversations (≤50),
 *   conversation_messages (≤200), moves (≤50), subscriptions (≤50).
 * الربط بمعرّف العميل وحده — لا مطابقة واتساب برقم الهاتف إطلاقًا
 * (تتسرب عبر الشركات)، ولا خلط مع طلب الاطلاع التاريخي (101) بين الشركات.
 */

/** عدّادات أقسام الحزمة — null تعني «لا وصول» لا «صفر». */
export function summarizeCustomerHistory(bundle) {
    if (!bundle) return null;
    const n = (xs) => Array.isArray(xs) ? xs.length : 0;
    return {
        customer: bundle.customer || null,
        tickets: n(bundle.tickets),
        replies: n(bundle.replies),
        conversations: n(bundle.conversations),
        conversationMessages: n(bundle.conversation_messages),
        moves: n(bundle.moves),
        subscriptions: n(bundle.subscriptions)
    };
}

const byCreatedDesc = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''));

/**
 * الردود مجمّعة تحت تذاكرها (الأحدث أولًا). ردّ تذكرته خارج أول 100
 * تذكرة في الحزمة يقع تحت «تذاكر أقدم» بدل أن يختفي بصمت.
 */
export function groupRepliesByTicket(bundle) {
    const tickets = Array.isArray(bundle?.tickets) ? [...bundle.tickets].sort(byCreatedDesc) : [];
    const replies = Array.isArray(bundle?.replies) ? [...bundle.replies].sort(byCreatedDesc) : [];
    const byId = new Map(tickets.map(t => [t.id, { ticket: t, replies: [] }]));
    const older = [];
    for (const r of replies) {
        const group = byId.get(r.ticket_id);
        if (group) group.replies.push(r);
        else older.push(r);
    }
    const groups = tickets.filter(t => byId.get(t.id).replies.length).map(t => byId.get(t.id));
    if (older.length) groups.push({ ticket: null, replies: older });
    return groups;
}

/** رسائل محادثة واحدة من الحزمة، الأقدم أولًا للقراءة. */
export function messagesOfConversation(bundle, conversationId) {
    const all = Array.isArray(bundle?.conversation_messages) ? bundle.conversation_messages : [];
    return all.filter(m => m.conversation_id === conversationId)
        .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
}

/** أقسام العرض بترتيبها وعدّاداتها — لعناوين التبويب الداخلي. */
export function customerHistorySections(bundle) {
    const s = summarizeCustomerHistory(bundle);
    if (!s) return [];
    return [
        { key: 'tickets', label: 'التذاكر', count: s.tickets },
        { key: 'replies', label: 'الردود', count: s.replies },
        { key: 'conversations', label: 'المحادثات', count: s.conversations },
        { key: 'moves', label: 'النقل', count: s.moves },
        { key: 'subscriptions', label: 'الاشتراكات', count: s.subscriptions }
    ];
}

/** وصف اشتراك كما في الحزمة — الاسم العربي أولًا، ثم المفتاح. */
export function subscriptionLabel(sub) {
    return sub?.plan_name || sub?.plan_key || 'باقة';
}
