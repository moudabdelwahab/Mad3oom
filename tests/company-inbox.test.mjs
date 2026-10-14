/**
 * company-inbox.js (102) — الجزء الخالص. القرار في القاعدة (tests/sql/company-conversations.test.sql)؛
 * العرض الحقيقي في tests/company-dashboard.render.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../assets/js/company/company-inbox.js', import.meta.url), 'utf8')
    .replace("import { supabase } from '/api-config.js';", 'const supabase = null;')
    .replace("import { escapeHtml, formatDate, renderState } from '/assets/js/customer/portal-ui.js';",
             'const escapeHtml = String, formatDate = String, renderState = () => {};')
    .replace("import { ui } from '/ui-service.js';", 'const ui = null;');
const { inboxBadge, inboxRowView, INBOX_FILTERS } = await import('data:text/javascript,' + encodeURIComponent(src));

test('الشارة: غير المقروء فقط، وبحد أقصى 99+', () => {
    assert.equal(inboxBadge(null), '');
    assert.equal(inboxBadge({ unread: 0 }), '');
    assert.equal(inboxBadge({ unread: 3 }), '3');
    assert.equal(inboxBadge({ unread: 250 }), '99+');
});

test('صف القائمة: بانتظار الرد حين آخر رسالة من العميل والمحادثة مفتوحة', () => {
    const open = inboxRowView({ id: 'c', subject: 'س', customer_name: 'ع', status: 'open', last_sender_kind: 'customer', unread: true });
    assert.deepEqual(open, { id: 'c', subject: 'س', customer: 'ع', assignee: 'غير مسندة', status: 'مفتوحة', waiting: true, unread: true });
    assert.equal(inboxRowView({ status: 'closed', last_sender_kind: 'customer' }).waiting, false);
    assert.equal(inboxRowView({ status: 'open', last_sender_kind: 'staff', assignee_name: 'موظف' }).assignee, 'موظف');
});

test('المرشّحات تطابق ما تقبله القاعدة', () => {
    assert.deepEqual(INBOX_FILTERS.map(f => f.value), ['open', 'unassigned', 'mine', 'closed', 'all']);
});
