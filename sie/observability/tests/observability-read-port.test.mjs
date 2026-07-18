import test from 'node:test';
import assert from 'node:assert/strict';
import { createObservabilityReadPort } from '../observability-read-port.js';
import { observabilityReadPortStub } from '../observability-read-port.stub.js';

test('createObservabilityReadPort: passes through a well-formed conversation', async () => {
    const port = createObservabilityReadPort(async (sessionId) => ({ sessionId, turns: [{ turn: 1, rawText: 'hi' }] }));
    const result = await port.getConversation('s1');
    assert.deepEqual(result, { sessionId: 's1', turns: [{ turn: 1, rawText: 'hi' }] });
});

test('createObservabilityReadPort: forwards the sessionId to fetchFn unchanged', async () => {
    let received;
    const port = createObservabilityReadPort(async (sessionId) => {
        received = sessionId;
        return null;
    });
    await port.getConversation('session-42');
    assert.equal(received, 'session-42');
});

test('createObservabilityReadPort: degrades to null when fetchFn throws', async () => {
    const port = createObservabilityReadPort(async () => {
        throw new Error('boom');
    });
    const result = await port.getConversation('s1');
    assert.equal(result, null);
});

test('createObservabilityReadPort: degrades to null when fetchFn returns something malformed (missing turns array)', async () => {
    const port = createObservabilityReadPort(async () => ({ sessionId: 's1' }));
    const result = await port.getConversation('s1');
    assert.equal(result, null);
});

test('createObservabilityReadPort: degrades to null when fetchFn returns null', async () => {
    const port = createObservabilityReadPort(async () => null);
    const result = await port.getConversation('s1');
    assert.equal(result, null);
});

test('observabilityReadPortStub: always reports "not found", regardless of sessionId', async () => {
    const a = await observabilityReadPortStub.getConversation('any-session');
    const b = await observabilityReadPortStub.getConversation('another-session');
    assert.equal(a, null);
    assert.equal(b, null);
});
