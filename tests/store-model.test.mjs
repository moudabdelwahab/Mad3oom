// ============================================================================
// 149 — بطاقات تقارير المتجر بلا مصطلحات إنجليزية ولا حاشية تقنية.
// `store_report()` لم يعد يرجع `definitions`، و`reportCards()` لا يعرض أي hint،
// حتى لو وصلت تعريفات إنجليزية قديمة من خادم لم يُرحَّل بعد.
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { reportCards } from '../assets/js/company/store-model.js';

const ENGLISH_DEFINITIONS = {
    ticket_volume: 'company tickets created in the window that the viewer may see',
    first_response_minutes_median: 'median of first_response_at - created_at over tickets with a first response',
    resolution_hours_median: 'median of resolved_at - created_at over tickets with resolved_at',
    order_related_tickets: 'tickets in the window linked to a store order or carrying an order request'
};

const REPORT = {
    days: 30, from: '2026-09-28T00:00:00Z', to: '2026-10-28T00:00:00Z',
    ticket_volume: 5, first_response_minutes_median: 42, tickets_with_response: 4,
    resolution_hours_median: 6.5, tickets_resolved: 3, unresolved_tickets: 2,
    order_related_tickets: 3, categories: {}, requests_by_kind: {}, requests_by_status: {},
    integration: { webhook_events: {}, sync_jobs: {} },
    definitions: ENGLISH_DEFINITIONS
};

test('149: بطاقات التقرير بلا أي hint — حتى مع تعريفات إنجليزية في الرد', () => {
    const cards = reportCards(REPORT);
    assert.equal(cards.length, 5);
    for (const card of cards) assert.equal(card.hint, undefined, card.key);
    assert.ok(cards.every((c) => !/[A-Za-z]/.test(c.label) && !/[A-Za-z]/.test(String(c.value))), 'لا حرف لاتيني في التسميات والقيم');
});

test('149: بطاقات التقرير بلا definitions أصلًا — نفس التسميات والقيم', () => {
    const { definitions, ...bare } = REPORT;
    const cards = reportCards(bare);
    assert.deepEqual(cards.map((c) => [c.key, c.label, c.value]), [
        ['ticket_volume', 'التذاكر الجديدة', '5'],
        ['first_response', 'وسيط أول رد', '42 دقيقة'],
        ['resolution', 'وسيط زمن الحل', '6.5 ساعة'],
        ['unresolved', 'تذاكر غير محلولة الآن', '2'],
        ['order_related', 'تذاكر مرتبطة بطلبات', '3']
    ]);
});

test('149: قيم فارغة ما زالت شرطة بلا hint', () => {
    const cards = reportCards({ ...REPORT, first_response_minutes_median: null, resolution_hours_median: null });
    assert.equal(cards.find((c) => c.key === 'first_response').value, '—');
    assert.equal(cards.find((c) => c.key === 'resolution').value, '—');
    assert.ok(cards.every((c) => c.hint === undefined));
});
