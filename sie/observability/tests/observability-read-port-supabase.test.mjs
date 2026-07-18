import test from 'node:test';
import assert from 'node:assert/strict';
import { createObservabilityReadSupabasePort } from '../observability-read-port.supabase.js';
import { createMockSupabaseQueryClient, createFailingMockSupabaseQueryClient } from '../../scenarios/tests/helpers/mock-supabase-query-client.js';

function messageRow(sessionId, turn, sender, text) {
    return { session_id: sessionId, turn, sender, text };
}

test('supabase read port: returns only customer messages, ordered by turn', async () => {
    const client = createMockSupabaseQueryClient({
        chat_messages: [
            messageRow('s1', 2, 'customer', 'second message'),
            messageRow('s1', 1, 'customer', 'first message'),
            messageRow('s1', 1, 'bot', 'a bot reply, should be excluded')
        ]
    });
    const port = createObservabilityReadSupabasePort(client);
    const result = await port.getConversation('s1');
    assert.deepEqual(result.turns, [
        { turn: 1, rawText: 'first message' },
        { turn: 2, rawText: 'second message' }
    ]);
});

test('supabase read port: only returns messages for the requested session', async () => {
    const client = createMockSupabaseQueryClient({
        chat_messages: [messageRow('s1', 1, 'customer', 'mine'), messageRow('s2', 1, 'customer', 'not mine')]
    });
    const port = createObservabilityReadSupabasePort(client);
    const result = await port.getConversation('s1');
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].rawText, 'mine');
});

test('supabase read port: an unknown session returns null, not an empty conversation object', async () => {
    const client = createMockSupabaseQueryClient({ chat_messages: [] });
    const port = createObservabilityReadSupabasePort(client);
    const result = await port.getConversation('does-not-exist');
    assert.equal(result, null);
});

test('supabase read port: a query error degrades gracefully (via the interface\'s try/catch) rather than crashing', async () => {
    const client = createFailingMockSupabaseQueryClient('connection refused');
    const port = createObservabilityReadSupabasePort(client);
    const result = await port.getConversation('s1');
    assert.equal(result, null);
});
