/**
 * Relay المرحلة C: منطق الواجهة النقي (assets/js/relay/relay-model.js) ومطابقة
 * التصنيف للترحيل 074. الصلاحيات نفسها مقيسة على الخادم في
 * tests/sql/relay-phase-c.test.sql؛ هنا: الاقتراح لا يخترع، المالك لا يُقترح،
 * العنوان والملخص لا يُملآن من نص الرسالة، والأدوات المعروضة تطابق 074.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    CATEGORY_META, RECORD_CATEGORIES, normalizeArabic, messageSender, selectability, filterMessages, toggleSelection,
    orderedSelection, suggestCategory, suggestKind, detectDueCandidates, missingFields, ownerOptions,
    buildRequestFromDraft, validateCreateRequest, titlePlaceholder, allowedTransitions, assignmentOptions, toZonedInput,
} from '../assets/js/relay/relay-model.js';
import { LIMITS } from '../assets/js/relay/relay-contract.js';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const KEY = '4b0c2f8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f';
const m = (id, text, at, kind = 'customer', extra = {}) => ({
    id, message_text: text, created_at: at, sender_id: kind === 'bot' ? null : `${kind}-1`,
    is_admin_reply: kind === 'agent', is_bot_reply: kind === 'bot', ...extra,
});
// المحادثة نفسها في شاشة المرجع الأولى
const MOCK = [
    m('m1', 'مرحبًا، أريد الاستفسار عن حالة طلبي', '2026-10-07T07:24:00Z'),
    m('m2', 'أهلاً بك، من فضلك أرسل رقم الطلب وسنقوم بالمراجعة', '2026-10-07T07:25:00Z', 'agent'),
    m('m3', 'رقم الطلب هو 45879', '2026-10-07T07:27:00Z'),
    m('m4', 'شكرًا، جاري التحقق من حالة الطلب ...', '2026-10-07T07:30:00Z', 'agent'),
    m('m5', 'هل هناك موعد متوقع للتسليم؟', '2026-10-07T07:32:00Z'),
    m('m6', 'من المتوقع أن يتم التسليم خلال 2-3 أيام عمل', '2026-10-07T07:35:00Z', 'agent'),
    m('m7', 'شكرًا لكم', '2026-10-07T08:02:00Z'),
];

test('categories match the CHECK constraint and the parser in 074', async () => {
    const sql = await read('migrations/074_relay_phase_c.sql');
    const check = sql.match(/constraint relay_records_category check \(category is null or category in \(([^)]*)\)\)/s)[1];
    assert.deepEqual([...check.matchAll(/'([^']+)'/g)].map((x) => x[1]), [...RECORD_CATEGORIES]);
    const parser = sql.match(/_relay_parse_category[\s\S]*?not in \(([^)]*)\)/)[1];
    assert.deepEqual([...parser.matchAll(/'([^']+)'/g)].map((x) => x[1]), [...RECORD_CATEGORIES]);
    assert.deepEqual(Object.keys(CATEGORY_META), [...RECORD_CATEGORIES]);
    // التسميات التسع كما في شاشة «معاينة النوع»
    assert.deepEqual(RECORD_CATEGORIES.map((c) => CATEGORY_META[c].label), [
        'حالة طلب', 'مشكلة في الطلب', 'استفسار عام', 'إرجاع أو استبدال', 'دفع وفواتير', 'منتج أو خدمة',
        'مشكلة تقنية', 'شكوى', 'أخرى']);
});

test('normalizeArabic unifies letters and digits for matching only', () => {
    assert.equal(normalizeArabic('حالةُ الطلبِ إلى ٤٥٨٧٩'), 'حاله الطلب الي 45879');
    assert.equal(normalizeArabic('مســاءً'), 'مساء');
});

test('message selection: sender, selectable, toggle, limit, order', () => {
    assert.equal(messageSender(MOCK[0]), 'customer');
    assert.equal(messageSender(MOCK[1]), 'agent');
    assert.equal(messageSender(m('b', 'x', MOCK[0].created_at, 'bot')), 'bot');
    assert.deepEqual(selectability(m('d', 'x', MOCK[0].created_at, 'customer', { deleted_at: '2026-10-08' })), { selectable: false, reason: 'رسالة محذوفة' });
    assert.equal(selectability(m('a', '  ', MOCK[0].created_at)).selectable, false);

    let sel = [];
    for (const id of ['m6', 'm2', 'm3']) sel = toggleSelection(sel, MOCK.find((x) => x.id === id)).selected;
    assert.deepEqual(sel, ['m6', 'm2', 'm3']);
    // الترتيب في السجل زمني، مش ترتيب الضغط
    assert.deepEqual(orderedSelection(MOCK, sel).map((x) => x.id), ['m2', 'm3', 'm6']);
    // إلغاء الاختيار
    sel = toggleSelection(sel, MOCK[2]).selected;
    assert.deepEqual(sel, ['m6', 'm2']);
    // غير قابلة للاختيار
    const r = toggleSelection(sel, m('x', '', MOCK[0].created_at));
    assert.equal(r.error, 'not_selectable');
    assert.deepEqual(r.selected, sel);
    // الحد الأقصى = حد الخادم في الطلب الواحد
    const many = Array.from({ length: LIMITS.sourcesPerRequest + 1 }, (_, i) => m(`k${i}`, `نص ${i}`, MOCK[0].created_at));
    let s = [];
    let last;
    for (const x of many) { last = toggleSelection(s, x); s = last.selected; }
    assert.equal(s.length, LIMITS.sourcesPerRequest);
    assert.equal(last.error, 'limit');
});

test('filters: search (normalized), participants, time, type', () => {
    const now = new Date('2026-10-09T12:00:00Z');
    assert.deepEqual(filterMessages(MOCK, { query: 'تسليم' }).map((x) => x.id), ['m5', 'm6']);
    assert.deepEqual(filterMessages(MOCK, { query: 'حالة' }).map((x) => x.id), ['m1', 'm4']);
    assert.deepEqual(filterMessages(MOCK, { participant: 'agent' }).map((x) => x.id), ['m2', 'm4', 'm6']);
    assert.equal(filterMessages(MOCK, { time: 'today' }, now).length, 0);
    assert.equal(filterMessages(MOCK, { time: '7d' }, now).length, 7);
    const withFile = [...MOCK, m('f', 'صورة الإيصال', MOCK[0].created_at, 'customer', { attachment_path: 'a/b.png' })];
    assert.deepEqual(filterMessages(withFile, { type: 'attachment' }).map((x) => x.id), ['f']);
    assert.equal(filterMessages(withFile, { type: 'text' }).length, 7);
});

test('category suggestion is deterministic, cites matches, and never invents', () => {
    const s = suggestCategory(orderedSelection(MOCK, ['m2', 'm3', 'm6']));
    assert.equal(s.category, 'order_status');
    assert.ok(s.matched.length > 0 && s.matched.every((w) => typeof w === 'string'));
    assert.deepEqual(suggestCategory(orderedSelection(MOCK, ['m2', 'm3', 'm6'])), s, 'not deterministic');
    assert.equal(suggestCategory([m('a', 'المنتج وصل مكسور', MOCK[0].created_at)]).category, 'order_problem');
    assert.equal(suggestCategory([m('a', 'عايز أرجع المنتج وآخد refund', MOCK[0].created_at)]).category, 'return_exchange');
    assert.equal(suggestCategory([m('a', 'الفاتورة فيها خصم غلط', MOCK[0].created_at)]).category, 'payment_billing');
    assert.equal(suggestCategory([m('a', 'التطبيق مش شغال وبيطلع error', MOCK[0].created_at)]).category, 'technical_issue');
    assert.equal(suggestCategory([m('a', 'عندي شكوى من الخدمة السيئة', MOCK[0].created_at)]).category, 'complaint');
    // لا كلمات ⇒ لا اقتراح (المستخدم يختار)
    assert.equal(suggestCategory([m('a', 'شكرًا لكم', MOCK[0].created_at)]), null);
    assert.equal(suggestCategory([]), null);
    assert.equal(suggestKind('order_problem'), 'issue');
    assert.equal(suggestKind('order_status'), 'follow_up');
    assert.equal(suggestKind(null), 'follow_up');
});

test('explicit due literals only, anchored to the message day, with the source cited', () => {
    const now = new Date('2026-10-07T08:00:00Z');
    const c = detectDueCandidates([
        m('a', 'هنتصل بيك بكرة الساعة ١٠ الصبح', '2026-10-07T07:00:00Z', 'agent'),
        m('b', 'call me 10/10 at 4pm', '2026-10-07T07:00:00Z'),
        m('c', 'الاستلام يوم الخميس', '2026-10-07T07:00:00Z'),        // 2026-10-07 أربعاء ⇒ الخميس 10-08
        m('d', 'المتوقع خلال 2-3 أيام عمل', '2026-10-07T07:00:00Z'),   // مدة، مش تاريخ ⇒ لا اقتراح
        m('e', 'الموعد 2026-10-20 الساعة 14:30', '2026-10-07T07:00:00Z'),
        m('f', 'بكره', '2026-10-01T07:00:00Z'),                        // بكرة من رسالة قديمة ⇒ فات
    ], { tz: 'Africa/Cairo', now });
    const by = Object.fromEntries(c.map((x) => [x.messageId, x]));
    assert.equal(by.a.at, '2026-10-08T10:00');
    assert.equal(by.a.timeStated, true);
    assert.equal(by.b.at, '2026-10-10T16:00');
    assert.equal(by.c.at, '2026-10-08T09:00');
    assert.equal(by.c.timeStated, false, 'time not stated must be flagged');
    assert.equal(by.d, undefined, 'durations are not explicit dates');
    assert.equal(by.e.at, '2026-10-20T14:30');
    assert.equal(by.f.past, true);
    assert.ok(c.every((x) => x.tz === 'Africa/Cairo' && x.literal));
    // اليوم يُحسب في المنطقة الزمنية: 23:30 UTC يوم 7 = يوم 8 في القاهرة ⇒ بكرة = 9
    const late = detectDueCandidates([m('z', 'بكرة الساعة 9', '2026-10-07T23:30:00Z')], { tz: 'Africa/Cairo', now });
    assert.equal(late[0].at, '2026-10-09T09:00');
});

test('missing fields and request building never copy message text (M5)', () => {
    assert.deepEqual(missingFields({}).map((x) => x.field), ['kind', 'title']);
    assert.deepEqual(missingFields({ kind: 'follow_up', title: 'x' }).map((x) => x.field), ['next_action', 'due']);
    assert.deepEqual(missingFields({ kind: 'issue', title: 'x' }).map((x) => x.field), ['issue.problem']);
    assert.deepEqual(missingFields({ kind: 'follow_up', title: 'x', nextAction: 'y', dueAt: '2026-10-20T10:00', dueTz: 'Africa/Cairo' }), []);

    const draft = { kind: 'follow_up', title: 'متابعة الشحنة', summary: '', nextAction: 'اتصل', dueAt: '2026-10-20T10:00', dueTz: 'Africa/Cairo',
        ownerId: '', teamId: '', priority: 3, category: 'order_status', messageIds: ['m2', 'm3', 'm2'] };
    const req = buildRequestFromDraft(draft, { idempotencyKey: KEY });
    assert.equal(req.category, 'order_status');
    assert.equal(req.owner_id, null);
    assert.deepEqual(req.due, { at: '2026-10-20T10:00:00', tz: 'Africa/Cairo' });
    assert.deepEqual(req.sources.map((s) => s.internal.chat_message_id), ['m2', 'm3']);
    assert.ok(!JSON.stringify(req).includes('45879') && !JSON.stringify(req).includes('رقم الطلب'), 'message text leaked into request');
    assert.deepEqual(validateCreateRequest(req, { now: new Date('2026-10-09T00:00:00Z') }), []);
    assert.deepEqual(validateCreateRequest({ ...req, category: 'bogus' }, { now: new Date('2026-10-09T00:00:00Z') }), [{ field: 'category', reason: 'invalid' }]);
    // issue: الوصف = كلام المستخدم
    const issue = buildRequestFromDraft({ ...draft, kind: 'issue', summary: 'العميل مستني رد', dueAt: '' }, { idempotencyKey: KEY });
    assert.deepEqual(issue.issue, { problem: 'العميل مستني رد' });
    assert.equal(issue.due, null);
    // placeholder فقط، ولا يحتوي نص رسالة
    assert.match(titlePlaceholder('follow_up', 'order_status'), /^مثال:/);
});

test('owner options follow 074: self or nobody unless the caller can assign; owner is never proposed', () => {
    const agents = [{ id: 'me', full_name: 'أنا نفسي' }, { id: 's2', full_name: 'هبة' }, { id: 's3', email: 's3@t.io' }];
    assert.deepEqual(ownerOptions({ agents, meId: 'me', canAssign: false }).map((o) => o.value), ['', 'me']);
    assert.deepEqual(ownerOptions({ agents, meId: 'me', canAssign: true }).map((o) => o.value), ['', 'me', 's2', 's3']);
    assert.deepEqual(ownerOptions({ agents: [], meId: null, canAssign: false }).map((o) => o.value), ['']);
});

test('record tools mirror 074 P4 and 073 transitions', () => {
    const agents = [{ id: 'me' }, { id: 's2' }];
    const rec = (over) => ({ id: 'r', status: 'open', owner_id: 'me', team_id: null, ...over });
    // المالك بلا صلاحية: نفسه أو بلا مالك، بلا فريق
    let a = assignmentOptions(rec(), { agents, meId: 'me', canAssign: false });
    assert.deepEqual([a.editable, a.owners.map((o) => o.value), a.teamEditable], [true, ['', 'me'], false]);
    // سجل بلا مالك: أخذه لنفسك
    a = assignmentOptions(rec({ owner_id: null }), { agents, meId: 'me', canAssign: false });
    assert.deepEqual(a.owners.map((o) => o.value), ['', 'me']);
    // سجل غيرك بلا صلاحية: لا أدوات
    assert.equal(assignmentOptions(rec({ owner_id: 's2' }), { agents, meId: 'me', canAssign: false }).editable, false);
    // صلاحية إسناد: الكل + الفريق
    a = assignmentOptions(rec({ owner_id: 's2' }), { agents, meId: 'me', canAssign: true });
    assert.deepEqual([a.owners.map((o) => o.value), a.teamEditable], [['', 'me', 's2'], true]);
    // مقفول: لا إسناد
    assert.equal(assignmentOptions(rec({ status: 'resolved' }), { agents, meId: 'me', canAssign: true }).editable, false);

    assert.deepEqual(allowedTransitions(rec(), { meId: 'me' }).map((t) => t.to), ['in_progress', 'waiting', 'resolved', 'cancelled']);
    assert.deepEqual(allowedTransitions(rec({ owner_id: 's2' }), { meId: 'me' }), []);
    assert.deepEqual(allowedTransitions(rec({ owner_id: 's2' }), { meId: 'me', supervisor: true }).length, 4);
    assert.deepEqual(allowedTransitions(rec({ status: 'resolved' }), { meId: 'me' }).map((t) => [t.to, t.needs]), [['open', 'reason']]);
    assert.ok(allowedTransitions(rec(), { meId: 'me' }).every((t) => t.to !== 'ready_for_handover'), 'handover is Phase D');
    assert.equal(toZonedInput('2026-10-08T07:00:00Z', 'Africa/Cairo'), '2026-10-08T10:00');
    assert.equal(toZonedInput(null, 'Africa/Cairo'), '');
});

test('the composer never persists or forwards message text outside the RPC', async () => {
    for (const f of ['assets/js/relay/relay-composer.js', 'assets/js/relay/relay-model.js', 'assets/js/relay/relay-page.js', 'assets/js/relay/relay-data.js']) {
        const src = await read(f);
        assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(src), `${f} touches browser storage`);
        assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon/.test(src), `${f} sends data outside supabase.rpc`);
    }
    const data = await read('assets/js/relay/relay-data.js');
    // لا قراءة مباشرة لجداول Relay (لا صلاحيات أصلًا، ولا محاولة)
    assert.ok(!/from\('relay_/.test(data), 'direct table access to relay_*');
});
