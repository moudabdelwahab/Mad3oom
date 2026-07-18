import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealStaticKnowledgeProvider } from './helpers/node-providers.js';

test('static knowledge: the real shipped content.json loads with zero validation warnings', async () => {
    const provider = createRealStaticKnowledgeProvider();
    const warnings = await provider.getLoadWarnings();
    assert.deepEqual(warnings, [], 'content.json should be fully schema-valid');
});

test('static knowledge: includes "platform_info" and "pricing", matching every knowledgeSource referenced by a static resolution in the scenario catalog', async () => {
    const provider = createRealStaticKnowledgeProvider();
    const platformInfo = await provider.getEntryByKey('platform_info');
    const pricing = await provider.getEntryByKey('pricing');
    assert.ok(platformInfo, 'expected a "platform_info" entry');
    assert.ok(pricing, 'expected a "pricing" entry');
});

test('static knowledge: every entry has non-empty bilingual text', async () => {
    const provider = createRealStaticKnowledgeProvider();
    const entries = await provider.getAllEntries();
    assert.ok(entries.length >= 2);
    for (const entry of entries) {
        assert.ok(entry.text.ar.length > 0, `${entry.key} missing Arabic text`);
        assert.ok(entry.text.en.length > 0, `${entry.key} missing English text`);
    }
});

test('static knowledge: getEntryByKey returns null for a key with no static content (e.g. a live-only source)', async () => {
    const provider = createRealStaticKnowledgeProvider();
    const result = await provider.getEntryByKey('ticket_status');
    assert.equal(result, null, 'ticket_status is per-customer and must not have static content');
});
