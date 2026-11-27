/**
 * tests/company-customer-history-model.test.mjs — سجل العميل داخل الشركة:
 * دوال خالصة في assets/js/company/company-customer-history-model.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    summarizeCustomerHistory, groupRepliesByTicket, messagesOfConversation,
    customerHistorySections, subscriptionLabel
} from '../assets/js/company/company-customer-history-model.js';

const bundle = {
    customer: { id: 'c1', name: 'عميل', email: 'c@example.com', phone: '010', joined_at: '2026-01-01' },
    tickets: [
        { id: 't1', ticket_number: 7, title: 'أقدم', created_at: '2026-11-20T10:00:00Z' },
        { id: 't2', ticket_number: 8, title: 'أحدث', created_at: '2026-11-25T10:00:00Z' }
    ],
    replies: [
        { id: 'r1', ticket_id: 't1', message: 'رد قديم', created_at: '2026-11-20T11:00:00Z' },
        { id: 'r2', ticket_id: 't2', message: 'رد أحدث', created_at: '2026-11-25T11:00:00Z' },
        { id: 'r3', ticket_id: 't9', message: 'رد تذكرته خارج أول 100', created_at: '2026-11-26T11:00:00Z' }
    ],
    conversations: [{ id: 'v1', subject: 'محادثة', status: 'open', last_message_at: '2026-11-25T12:00:00Z' }],
    conversation_messages: [
        { id: 'm2', conversation_id: 'v1', body: 'ثانية', created_at: '2026-11-25T12:01:00Z' },
        { id: 'm1', conversation_id: 'v1', body: 'أولى', created_at: '2026-11-25T12:00:00Z' },
        { id: 'm3', conversation_id: 'v2', body: 'محادثة أخرى', created_at: '2026-11-25T12:02:00Z' }
    ],
    moves: [{ id: 'x1', direction: 'incoming', status: 'pending', created_at: '2026-11-24T00:00:00Z' }],
    subscriptions: [{ id: 's1', plan_key: 'support', plan_name: 'الدعم', status: 'active', start_date: '2026-11-01', end_date: '2026-12-01' }]
};

test('summarizeCustomerHistory: العدّادات، و null حين لا وصول', () => {
    assert.equal(summarizeCustomerHistory(null), null);
    assert.deepEqual(summarizeCustomerHistory(bundle), {
        customer: bundle.customer, tickets: 2, replies: 3, conversations: 1,
        conversationMessages: 3, moves: 1, subscriptions: 1
    });
    assert.deepEqual(summarizeCustomerHistory({}), {
        customer: null, tickets: 0, replies: 0, conversations: 0,
        conversationMessages: 0, moves: 0, subscriptions: 0
    });
});

test('groupRepliesByTicket: تحت تذاكرها، واليتيم تحت «تذاكر أقدم» لا يختفي', () => {
    const groups = groupRepliesByTicket(bundle);
    assert.equal(groups.length, 3);
    assert.equal(groups[0].ticket.id, 't2', 'الأحدث أولًا');
    assert.deepEqual(groups[0].replies.map(r => r.id), ['r2']);
    assert.equal(groups[1].ticket.id, 't1');
    assert.equal(groups[2].ticket, null);
    assert.deepEqual(groups[2].replies.map(r => r.id), ['r3']);
    assert.deepEqual(groupRepliesByTicket({ tickets: [], replies: [] }), []);
});

test('messagesOfConversation: محادثة واحدة، الأقدم أولًا للقراءة', () => {
    assert.deepEqual(messagesOfConversation(bundle, 'v1').map(m => m.id), ['m1', 'm2']);
    assert.deepEqual(messagesOfConversation(bundle, 'v2').map(m => m.id), ['m3']);
    assert.deepEqual(messagesOfConversation(bundle, 'nope'), []);
});

test('customerHistorySections: الأقسام الخمسة بعدّاداتها', () => {
    assert.deepEqual(customerHistorySections(bundle).map(s => [s.key, s.count]), [
        ['tickets', 2], ['replies', 3], ['conversations', 1], ['moves', 1], ['subscriptions', 1]
    ]);
    assert.deepEqual(customerHistorySections(null), []);
});

test('subscriptionLabel: الاسم العربي أولًا ثم المفتاح', () => {
    assert.equal(subscriptionLabel({ plan_name: 'الدعم', plan_key: 'support' }), 'الدعم');
    assert.equal(subscriptionLabel({ plan_key: 'support' }), 'support');
    assert.equal(subscriptionLabel({}), 'باقة');
});
