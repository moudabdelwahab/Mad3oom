import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveKnowledgeProvider } from '../live-knowledge.provider.js';
import { liveKnowledgeProviderStub } from '../live-knowledge.stub.js';

test('createLiveKnowledgeProvider: passes through a well-formed result', async () => {
    const provider = createLiveKnowledgeProvider(async () => ({ available: true, data: { tickets: [] } }));
    const result = await provider.getLiveKnowledge({ source: 'ticket_status', userId: 'u1', turn: 1 });
    assert.deepEqual(result, { available: true, data: { tickets: [] } });
});

test('createLiveKnowledgeProvider: forwards the context to fetchFn unchanged', async () => {
    let received;
    const provider = createLiveKnowledgeProvider(async (context) => {
        received = context;
        return { available: false, data: null };
    });
    await provider.getLiveKnowledge({ source: 'subscription_status', userId: 'u42', turn: 3 });
    assert.deepEqual(received, { source: 'subscription_status', userId: 'u42', turn: 3 });
});

test('createLiveKnowledgeProvider: degrades to unavailable when fetchFn throws', async () => {
    const provider = createLiveKnowledgeProvider(async () => {
        throw new Error('boom');
    });
    const result = await provider.getLiveKnowledge({ source: 'ticket_status', userId: 'u1', turn: 1 });
    assert.deepEqual(result, { available: false, data: null });
});

test('createLiveKnowledgeProvider: degrades to unavailable when fetchFn returns something malformed', async () => {
    const provider = createLiveKnowledgeProvider(async () => 'not a result object');
    const result = await provider.getLiveKnowledge({ source: 'ticket_status', userId: 'u1', turn: 1 });
    assert.deepEqual(result, { available: false, data: null });
});

test('createLiveKnowledgeProvider: degrades to unavailable when fetchFn returns null', async () => {
    const provider = createLiveKnowledgeProvider(async () => null);
    const result = await provider.getLiveKnowledge({ source: 'ticket_status', userId: 'u1', turn: 1 });
    assert.deepEqual(result, { available: false, data: null });
});

test('liveKnowledgeProviderStub: always reports unavailable, regardless of source', async () => {
    const a = await liveKnowledgeProviderStub.getLiveKnowledge({ source: 'ticket_status', userId: 'u1', turn: 1 });
    const b = await liveKnowledgeProviderStub.getLiveKnowledge({ source: 'subscription_status', userId: 'u1', turn: 1 });
    assert.deepEqual(a, { available: false, data: null });
    assert.deepEqual(b, { available: false, data: null });
});
