/**
 * tests/company-continuity-model.test.mjs — الاستمرارية داخل لوحة الشركة:
 * دوال خالصة في assets/js/company/company-continuity-model.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CONTINUITY_CATEGORIES, CONTINUITY_KINDS, CONTINUITY_STATUSES,
    continuityListFilters, validateContinuityCreate, validateContinuityNote,
    continuityTransitionRequirement, continuityAvailableTransitions,
    continuityRecordView, continuityStatusLabel, continuityKindLabel,
    continuityCategoryLabel, continuityPriorityLabel, isContinuityClosed,
    newIdempotencyKey
} from '../assets/js/company/company-continuity-model.js';

test('التصنيفات التسعة الثابتة كما في القاعدة (146)، بلا handover', () => {
    assert.deepEqual(CONTINUITY_CATEGORIES.map(c => c.value), [
        'order_status', 'order_problem', 'general_inquiry', 'return_exchange',
        'payment_billing', 'product_service', 'technical_issue', 'complaint', 'other'
    ]);
    assert.deepEqual(CONTINUITY_KINDS.map(k => k.value), ['follow_up', 'issue']);
    assert.equal(continuityKindLabel('follow_up'), 'متابعة');
    assert.equal(continuityKindLabel('handover'), '—', 'التسليم ليس نوعًا هنا');
    assert.equal(continuityCategoryLabel(null), 'بلا تصنيف');
    assert.equal(continuityCategoryLabel('complaint'), 'شكوى');
    assert.equal(continuityStatusLabel('resolved'), 'تم حلّه');
    assert.equal(continuityPriorityLabel(1), 'عاجلة');
    assert.equal(continuityPriorityLabel(9), '—');
});

test('المغلق resolved و cancelled وحدهما', () => {
    for (const s of ['open', 'in_progress', 'waiting', 'scheduled']) assert.equal(isContinuityClosed(s), false, s);
    for (const s of ['resolved', 'cancelled']) assert.equal(isContinuityClosed(s), true, s);
    assert.deepEqual(CONTINUITY_STATUSES.map(s => s.value),
        ['open', 'in_progress', 'waiting', 'scheduled', 'resolved', 'cancelled']);
});

test('continuityListFilters: يسقط الفارغ ويقصّ الحد 1–100', () => {
    assert.deepEqual(continuityListFilters({}), { limit: 50 });
    assert.deepEqual(continuityListFilters({ status: 'open', kind: 'issue', owner: 'me', category: 'complaint' }),
        { limit: 50, status: 'open', kind: 'issue', owner: 'me', category: 'complaint' });
    assert.equal(continuityListFilters({ limit: 500 }).limit, 100);
    assert.equal(continuityListFilters({ limit: 0 }).limit, 1);
    assert.equal(continuityListFilters({ limit: 'abc' }).limit, 50);
    assert.deepEqual(continuityListFilters({ before: '2026-01-01T00:00:00Z', beforeId: 'uuid-1' }),
        { limit: 50, before: '2026-01-01T00:00:00Z', before_id: 'uuid-1' });
});

test('validateContinuityCreate: قواعد القاعدة مرآةً لا بديلًا', () => {
    assert.deepEqual(validateContinuityCreate({ kind: 'follow_up', title: 'ت', nextAction: '', dueAt: '2026-12-01T10:00:00Z' }),
        { ok: false, error: 'المتابعة تحتاج خطوة تالية مكتوبة' });
    assert.deepEqual(validateContinuityCreate({ kind: 'follow_up', title: 'ت', nextAction: 'اتصل', dueAt: null }),
        { ok: false, error: 'المتابعة تحتاج موعدًا للخطوة التالية' });
    assert.deepEqual(validateContinuityCreate({ kind: 'issue', title: 'ت', problem: '  ' }),
        { ok: false, error: 'المشكلة تحتاج وصفًا للمشكلة' });
    assert.equal(validateContinuityCreate({ kind: 'follow_up', title: 'ت', nextAction: 'اتصل', dueAt: '2026-12-01T10:00:00Z' }).ok, true);
    assert.equal(validateContinuityCreate({ kind: 'issue', title: 'ت', problem: 'العطل' }).ok, true);
    assert.equal(validateContinuityCreate({ kind: 'handover', title: 'ت' }).ok, false, 'التسليم مرفوض');
    assert.equal(validateContinuityCreate({ kind: 'follow_up', title: '' }).ok, false);
    assert.equal(validateContinuityCreate({ kind: 'follow_up', title: 'x'.repeat(161), nextAction: 'ا', dueAt: '2026-12-01' }).ok, false);
});

test('validateContinuityNote: 1–2000 حرف كما في القاعدة', () => {
    assert.equal(validateContinuityNote('').ok, false);
    assert.equal(validateContinuityNote('   ').ok, false);
    assert.equal(validateContinuityNote('x'.repeat(2001)).ok, false);
    assert.deepEqual(validateContinuityNote('  ملاحظة  '), { ok: true, body: 'ملاحظة' });
});

test('continuityTransitionRequirement: كل انتقال وما يتطلبه من details', () => {
    assert.deepEqual(continuityTransitionRequirement('resolved', 'open'), { field: 'resolution_note', label: 'ملاحظة الحل' });
    assert.deepEqual(continuityTransitionRequirement('cancelled', 'waiting'), { field: 'cancel_reason', label: 'سبب الإلغاء' });
    assert.deepEqual(continuityTransitionRequirement('waiting', 'open'), { field: 'waiting_on', label: 'بانتظار ماذا؟' });
    assert.deepEqual(continuityTransitionRequirement('open', 'resolved'), { field: 'reason', label: 'سبب إعادة الفتح' });
    assert.equal(continuityTransitionRequirement('open', 'open'), null);
    assert.equal(continuityTransitionRequirement('in_progress', 'open'), null);
    assert.equal(continuityTransitionRequirement('scheduled', 'open'), null);
});

test('continuityAvailableTransitions: بلا handover، والمغلق يُعاد فتحه فقط', () => {
    assert.deepEqual(continuityAvailableTransitions('resolved'), [{ to: 'open', label: 'إعادة فتح' }]);
    assert.deepEqual(continuityAvailableTransitions('cancelled'), [{ to: 'open', label: 'إعادة فتح' }]);
    const open = continuityAvailableTransitions('open').map(t => t.to);
    assert.deepEqual(open, ['in_progress', 'waiting', 'scheduled', 'resolved', 'cancelled']);
    assert.ok(!open.includes('ready_for_handover'), 'التسليم مؤجَّل في القاعدة');
    assert.deepEqual(continuityAvailableTransitions('in_progress').map(t => t.to),
        ['waiting', 'scheduled', 'resolved', 'cancelled']);
});

test('continuityRecordView: team_id null و source_count 0 دائمًا في نطاق الشركة', () => {
    const v = continuityRecordView({
        id: 'r1', kind: 'follow_up', title: 'تابع العميل', status: 'open', priority: 2,
        category: 'order_status', owner_id: 'u1', team_id: 't1', due_at: '2026-12-01T10:00:00Z',
        due_tz: 'Africa/Cairo', next_action: 'اتصل', overdue: true, version: 3,
        updated_at: '2026-11-26T10:00:00Z', source_count: 5
    });
    assert.equal(v.teamId, null, 'الشركة بلا فرق — ولو رجّعت القاعدة قيمة');
    assert.equal(v.sourceCount, 0, 'سجلات الشركة بلا مصادر');
    assert.equal(v.kindLabel, 'متابعة');
    assert.equal(v.statusLabel, 'مفتوح');
    assert.equal(v.priorityLabel, 'مرتفعة');
    assert.equal(v.categoryLabel, 'حالة طلب');
    assert.equal(v.overdue, true);
    assert.equal(v.version, 3);
    assert.equal(continuityRecordView(null), null);
    const bare = continuityRecordView({ id: 'r2' });
    assert.equal(bare.priority, 3, 'الأولوية الافتراضية 3');
    assert.equal(bare.categoryLabel, 'بلا تصنيف');
    assert.equal(bare.closed, false);
});

test('newIdempotencyKey: مفتاح جديد في كل إنشاء', () => {
    const a = newIdempotencyKey(), b = newIdempotencyKey();
    assert.equal(typeof a, 'string');
    assert.ok(a.length > 0);
    assert.notEqual(a, b);
});
