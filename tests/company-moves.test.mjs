/**
 * company-moves.js (101) — الجزء الخالص: ما يظهر لمدير الشركة من النقل والاطلاع التاريخي.
 * القرار في القاعدة (tests/sql/customer-transfers-carry.test.sql)؛ العرض الحقيقي في
 * tests/company-dashboard.render.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// الوحدة تستورد بمسارات مطلقة للمتصفح؛ الدوال الخالصة لا تحتاجها.
const src = readFileSync(new URL('../assets/js/company/company-moves.js', import.meta.url), 'utf8')
    .replace("import { supabase } from '/api-config.js';", 'const supabase = null;')
    .replace("import { escapeHtml, formatDate } from '/assets/js/customer/portal-ui.js';", 'const escapeHtml = String, formatDate = String;')
    .replace("import { ui } from '/ui-service.js';", 'const ui = null;');
const { companyMovesView, transferRowInfo, validatePurpose } = await import('data:text/javascript,' + encodeURIComponent(src));

test('اللوحة بمفتاحيها، والقائمة null (غير المدير) لا تُظهر شيئًا', () => {
    assert.deepEqual(companyMovesView(null, [], []), { show: false, showTransfers: false, showHistory: false });
    assert.deepEqual(companyMovesView({ transfers: true, historical: true }, null, null), { show: false, showTransfers: false, showHistory: false });
    assert.deepEqual(companyMovesView({ transfers: true, historical: false }, [], []), { show: true, showTransfers: true, showHistory: false });
    assert.deepEqual(companyMovesView({ transfers: false, historical: true }, [], []), { show: true, showTransfers: false, showHistory: true });
});

test('طلب النقل: القرار مرة واحدة، وعرض البقاء إضافيًا للمصدر وحده وبطلب العميل', () => {
    const out = transferRowInfo({ direction: 'outgoing', status: 'pending', my_decision: null, customer_wants_secondary: true });
    assert.equal(out.canDecide, true);
    assert.equal(out.offerSecondary, true);
    assert.doesNotMatch(out.text, /شركة [أب](?![\u0600-\u06FF])/);
    assert.equal(transferRowInfo({ direction: 'incoming', status: 'pending', my_decision: null, customer_wants_secondary: true }).offerSecondary, false);
    assert.equal(transferRowInfo({ direction: 'outgoing', status: 'pending', my_decision: null, customer_wants_secondary: false }).offerSecondary, false);
    const decided = transferRowInfo({ direction: 'incoming', status: 'pending', my_decision: 'approved' });
    assert.equal(decided.canDecide, false);
    assert.equal(decided.status, 'بانتظار الشركة الأخرى');
    assert.equal(transferRowInfo({ direction: 'incoming', status: 'completed', my_decision: 'approved' }).canDecide, false);
});

test('الغرض: 20–1000 حرف بعد القص', () => {
    assert.equal(validatePurpose('قصير').ok, false);
    assert.equal(validatePurpose('   ' + 'ا'.repeat(19) + '   ').ok, false);
    assert.deepEqual(validatePurpose('  متابعة شكوى سابقة للعميل  '), { ok: true, purpose: 'متابعة شكوى سابقة للعميل' });
    assert.equal(validatePurpose('ا'.repeat(1001)).ok, false);
});
