import test from 'node:test';
import assert from 'node:assert/strict';
import { formatKnowledgeData } from '../templates/knowledge-formatters.js';

test('formatKnowledgeData: ticket_status with tickets produces a bilingual bulleted list', () => {
    const data = { tickets: [{ ticketNumber: 1, title: 'X', status: 'open', createdAt: '2026-01-01' }] };
    assert.ok(formatKnowledgeData('ticket_status', data, 'ar').includes('#1'));
    assert.ok(formatKnowledgeData('ticket_status', data, 'ar').includes('مفتوحة'));
    assert.ok(formatKnowledgeData('ticket_status', data, 'en').includes('Open'));
});

test('formatKnowledgeData: ticket_status with no tickets produces the "no tickets" message', () => {
    assert.ok(formatKnowledgeData('ticket_status', { tickets: [] }, 'ar').includes('مفيش'));
    assert.ok(formatKnowledgeData('ticket_status', { tickets: [] }, 'en').toLowerCase().includes("don't have"));
});

test('formatKnowledgeData: ticket_status with an unrecognized status code falls back to the raw code', () => {
    const data = { tickets: [{ ticketNumber: 1, title: 'X', status: 'some_new_status', createdAt: 'x' }] };
    assert.ok(formatKnowledgeData('ticket_status', data, 'ar').includes('some_new_status'));
});

test('formatKnowledgeData: subscription_status with data produces a bilingual summary', () => {
    const data = { plan: 'support', status: 'active', billingCycle: 'yearly', daysLeft: 200 };
    assert.ok(formatKnowledgeData('subscription_status', data, 'ar').includes('الدعم الفني'));
    assert.ok(formatKnowledgeData('subscription_status', data, 'ar').includes('سنوي'));
    assert.ok(formatKnowledgeData('subscription_status', data, 'en').includes('Support'));
});

test('formatKnowledgeData: subscription_status with no plan produces the free-plan fallback message', () => {
    assert.ok(formatKnowledgeData('subscription_status', {}, 'ar').includes('مجانية'));
    assert.ok(formatKnowledgeData('subscription_status', null, 'en').toLowerCase().includes('free'));
});

test('formatKnowledgeData: subscription_status with daysLeft <= 0 indicates expiry rather than a countdown', () => {
    const data = { plan: 'whatsapp', status: 'expired', billingCycle: 'monthly', daysLeft: 0 };
    assert.ok(formatKnowledgeData('subscription_status', data, 'ar').includes('منتهي'));
});

test('formatKnowledgeData: a plain bilingual-text source (platform_info/pricing) passes through directly', () => {
    const data = { text: { ar: 'نص عربي', en: 'english text' } };
    assert.equal(formatKnowledgeData('platform_info', data, 'ar'), 'نص عربي');
    assert.equal(formatKnowledgeData('pricing', data, 'en'), 'english text');
});

test('formatKnowledgeData: an unrecognized source with no bilingual text returns null so the caller can fall back', () => {
    assert.equal(formatKnowledgeData('totally_unknown_source', { random: 'shape' }, 'ar'), null);
});
