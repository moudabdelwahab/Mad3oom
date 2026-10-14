/**
 * بوابة عملاء الشركة (D8، الترحيل 095) — الجزء الخالص في الواجهة.
 *
 * القرار في القاعدة (my_company_portal: الاسم فقط لعميل الشركة، null لغيره،
 * tests/sql/account-boundaries.test.sql). هنا: ترجمة الرد إلى حالة عرض، وتحقق النموذج.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// portal-data.js يستورد /api-config.js بمسار مطلق؛ الدوال الخالصة لا تحتاجه، فنقرأ
// الوحدة بعد استبدال الاستيراد ببديل فارغ.
const src = readFileSync(new URL('../assets/js/portal/portal-data.js', import.meta.url), 'utf8')
    .replace("import { supabase } from '/api-config.js';", 'const supabase = null;');
const { portalState, validateTicketForm, membershipView, portalTicketFilter, movesView, carrySummary, transferStatusLabel, historyStatusLabel } = await import('data:text/javascript,' + encodeURIComponent(src));

test('حالة العرض: الاسم فقط لعميل الشركة', () => {
    assert.deepEqual(portalState({ ok: true, data: { company: { id: 'c', name: 'شركة أ' }, preview: false } }),
        { kind: 'ready', companyName: 'شركة أ', preview: false });
    assert.deepEqual(portalState({ ok: true, data: { company: { id: 'c', name: 'شركة أ' }, preview: true } }),
        { kind: 'ready', companyName: 'شركة أ', preview: true });
});

test('غير عميل الشركة (null) يرى رسالة لا بوابة', () => {
    assert.equal(portalState({ ok: true, data: null }).kind, 'not-customer');
    assert.equal(portalState({ ok: true, data: { company: null } }).kind, 'not-customer');
    assert.equal(portalState({ ok: true, data: { company: { id: 'c' } } }).kind, 'not-customer');
});

test('قبل 095 أو عند الخطأ: حالة صريحة، لا افتراض', () => {
    assert.equal(portalState({ ok: true, data: null, unavailable: true }).kind, 'unavailable');
    assert.equal(portalState({ ok: false, data: null, error: 'x' }).kind, 'error');
    assert.equal(portalState(undefined).kind, 'error');
    // preview لا تُقبل إلا true صريحة
    assert.equal(portalState({ ok: true, data: { company: { name: 'x' }, preview: 'yes' } }).preview, false);
});

test('تحقق نموذج التذكرة', () => {
    assert.equal(validateTicketForm({ title: '  ', description: 'وصف طويل بما يكفي' }).ok, false);
    assert.equal(validateTicketForm({ title: 'مشكلة', description: 'قصير' }).ok, false);
    const ok = validateTicketForm({ title: '  مشكلة في الطلب ', description: '  لم يصل الطلب حتى الآن  ' });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.values, { title: 'مشكلة في الطلب', description: 'لم يصل الطلب حتى الآن' });
    assert.equal(validateTicketForm({ title: 'x'.repeat(201), description: 'وصف طويل بما يكفي' }).ok, false);
});

test('البوابة لا تحمل شراء باقات ولا أقسام الشركة الداخلية', () => {
    const html = readFileSync(new URL('../portal/index.html', import.meta.url), 'utf8');
    const js = readFileSync(new URL('../assets/js/portal/portal.js', import.meta.url), 'utf8')
        + readFileSync(new URL('../assets/js/portal/portal-moves.js', import.meta.url), 'utf8');
    for (const forbidden of ['subscriptions.html', 'payment.html', 'chat-widget', '/company-dashboard/',
                             'get_my_company_dashboard', 'company_members', 'api-token', 'integrations']) {
        assert.ok(!html.includes(forbidden) && !js.includes(forbidden), `البوابة تشير إلى ${forbidden}`);
    }
});

test('096: محوّل الشركات من رد الخادم', () => {
    const base = { company: { id: 'c1', name: 'أ' }, preview: false, multi_company: true };
    const two = membershipView({ ...base, memberships: [
        { company_id: 'c1', name: 'أ', is_primary: true, is_current: true },
        { company_id: 'c2', name: 'ب', is_primary: false, is_current: false }] });
    assert.equal(two.showSwitcher, true);
    assert.equal(two.current.id, 'c1');
    assert.equal(two.canSetPrimary, false, 'له أساسية: تغييرها نقل بموافقات');
    assert.equal(two.canLeave, true);
    const noPrimary = membershipView({ ...base, memberships: [{ company_id: 'c2', name: 'ب', is_primary: false, is_current: true }] });
    assert.equal(noPrimary.showSwitcher, false);
    assert.equal(noPrimary.canSetPrimary, true);
    // المفتاح مطفأ أو منظور المالك: لا شيء
    for (const data of [{ ...base, multi_company: false, memberships: two.options }, { ...base, preview: true },
                        null, { ...base, memberships: 'x' }]) {
        const v = membershipView(data);
        assert.equal(v.showSwitcher || v.canLeave || v.canSetPrimary, false);
    }
});

test('097: البوابة تعرض تذاكر الشركة الحالية فقط، وقبل 097 كل التذاكر', () => {
    const keep = portalTicketFilter('c1');
    assert.equal(keep({ id: 1, scope: 'company', company_id: 'c1' }), true);
    assert.equal(keep({ id: 2, scope: 'company', company_id: 'c2' }), false, 'شركة أخرى للعميل نفسه');
    assert.equal(keep({ id: 3, scope: 'mad3oom_support', company_id: null }), false, 'فوترته الشخصية مع مدعوم');
    assert.equal(keep({ id: 4 }), true, 'صف قبل 097 بلا نطاق');
    assert.equal(portalTicketFilter(undefined)({ scope: 'company', company_id: 'c1' }), false);
});

test('101: أدوات النقل والنسخ والاطلاع تظهر بمفاتيحها فقط', () => {
    const ON = { transfers: true, carry: true, historical: true };
    const OFF = { transfers: false, carry: false, historical: false };
    const two = membershipView({ multi_company: true, memberships: [
        { company_id: 'a', name: 'أ', is_primary: true, is_current: false },
        { company_id: 'b', name: 'ب', is_primary: false, is_current: true }] });
    // المفاتيح مطفأة (الافتراضي): لا شيء
    assert.deepEqual(movesView(OFF, two), { canTransfer: false, showTransfers: false, carrySources: [], showHistory: false });
    assert.deepEqual(movesView(null, two), { canTransfer: false, showTransfers: false, carrySources: [], showHistory: false });
    // الحالية إضافية ولها أساسية: طلب نقل، والنسخ من الأخرى
    const v = movesView(ON, two);
    assert.equal(v.canTransfer, true);
    assert.deepEqual(v.carrySources.map(o => o.id), ['a']);
    // الحالية هي الأساسية: لا نقل إليها
    const onPrimary = membershipView({ multi_company: true, memberships: [
        { company_id: 'a', name: 'أ', is_primary: true, is_current: true },
        { company_id: 'b', name: 'ب', is_primary: false, is_current: false }] });
    assert.equal(movesView(ON, onPrimary).canTransfer, false);
    // بلا أساسية: يكفي تعيينها (096)، لا نقل
    const noPrimary = membershipView({ multi_company: true, memberships: [{ company_id: 'b', name: 'ب', is_primary: false, is_current: true }] });
    assert.equal(movesView(ON, noPrimary).canTransfer, false);
    assert.deepEqual(movesView(ON, noPrimary).carrySources, []);
    // قبل 096 أو منظور العضو: لا نقل ولا نسخ، والاطلاع التاريخي بمفتاحه
    const single = membershipView({ multi_company: false });
    assert.deepEqual(movesView(ON, single), { canTransfer: false, showTransfers: false, carrySources: [], showHistory: true });
});

test('101: ملخص النسخ يقول ما يُنسخ وما لا يُنسخ', () => {
    assert.equal(carrySummary({ replies_included: 2, attachments_included: 1, replies_excluded_staff: 3, replies_excluded_internal: 1, attachments_excluded: 0 }),
        'يُنسخ: وصفك و2 من رسائلك و1 من مرفقاتك. لا تُنسخ ردود فريق الشركة وملاحظاته ومرفقاته (4).');
    assert.equal(carrySummary({}), 'يُنسخ: وصفك.');
    assert.equal(carrySummary(null), 'يُنسخ: وصفك.');
    assert.equal(transferStatusLabel('pending'), 'بانتظار موافقة الشركتين');
    assert.equal(transferStatusLabel('x'), '—');
    assert.equal(historyStatusLabel('awaiting_customer'), 'بانتظار قرارك');
});
