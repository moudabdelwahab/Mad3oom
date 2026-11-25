/**
 * اختبارات نموذج تصدير بيانات الشركة وحذف حسابها (الترحيل 140) — دوال
 * خالصة بلا DOM وبلا xlsx.
 *
 * ما يُحرَس هنا:
 *   ① اسم الملف حتمي ومُنظَّف وله بديل حين يغيب اسم الشركة.
 *   ② مستند التصدير متسق مع محتواه: العدّادات من المصفوفات نفسها لا
 *      من عدّاد قد يختلف، والأقسام الخمسة مضمونة.
 *   ③ الفواتير مذكورة صراحةً كغير متاحة — لا سجل مخترع ولا قسم ساقط.
 *   ④ سبب الحذف إلزامي وبحدّ الخادم نفسه (20 حرفًا)، والسياسة تذكر
 *      المحتفَظ به (الاشتراكات وaccounting_invoices والتدقيق) صراحةً.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
    EXPORT_FORMAT, EXPORT_FORMAT_VERSION, MIN_DELETION_REASON_LENGTH,
    EXPORT_INVOICE_NOTE, DELETION_POLICY, DELETION_WARNING,
    buildExportFilename, buildExportDocument, validateDeletionReason
} = await import('../assets/js/company/company-data-export-model.js');

function payload(over = {}) {
    return {
        format: EXPORT_FORMAT,
        format_version: EXPORT_FORMAT_VERSION,
        exported_at: '2026-11-25T10:00:00.000Z',
        exported_by: 'admin-1',
        company: { id: 'co-1', name: 'شركة النور' },
        members: [{ id: 'm1' }, { id: 'm2' }],
        tickets: [{ id: 't1' }],
        subscriptions: [{ id: 's1' }, { id: 's2' }],
        invoices: { ...EXPORT_INVOICE_NOTE, rows: [] },
        activity: [{ id: 'a1' }],
        membership_events: [],
        counts: { members: 2, tickets: 1, subscriptions: 2, activity: 1, membership_events: 0, invoices: 0 },
        file_name: 'mad3oom-company-data-2026-11-25.json',
        ...over
    };
}

/* ── اسم الملف ─────────────────────────────────────────────────────────── */

test('اسم الملف حتمي: الاسم والتاريخ من المدخلات لا من اليوم', () => {
    assert.equal(
        buildExportFilename('شركة النور', new Date('2026-11-25T10:00:00Z')),
        'mad3oom-company-data-شركة-النور-2026-11-25.json');
});

test('اسم الملف ينظّف المحارف غير المقبولة ويقبل نصًا للتاريخ', () => {
    assert.equal(
        buildExportFilename('شركة / النور: المحدودة', '2026-01-05T00:00:00Z'),
        'mad3oom-company-data-شركة-النور-المحدودة-2026-01-05.json');
});

test('اسم شركة غائب يعطي بديلًا لا اسم ملف مكسورًا', () => {
    assert.match(buildExportFilename('', new Date('2026-11-25T00:00:00Z')),
        /^mad3oom-company-data-company-2026-11-25\.json$/);
    assert.match(buildExportFilename(null, new Date('2026-11-25T00:00:00Z')),
        /company-2026-11-25/);
});

test('تاريخ غير صالح لا يكسر اسم الملف', () => {
    assert.match(buildExportFilename('شركة', 'ليس تاريخًا'),
        /^mad3oom-company-data-شركة-\d{4}-\d{2}-\d{2}\.json$/);
});

/* ── مستند التصدير ─────────────────────────────────────────────────────── */

test('المستند يمرّر الأقسام والشركة كما أرسلها الخادم', () => {
    const doc = buildExportDocument(payload());
    assert.equal(doc.format, EXPORT_FORMAT);
    assert.equal(doc.format_version, 1);
    assert.equal(doc.company.name, 'شركة النور');
    assert.equal(doc.members.length, 2);
    assert.equal(doc.tickets.length, 1);
    assert.equal(doc.subscriptions.length, 2);
    assert.equal(doc.file_name, 'mad3oom-company-data-2026-11-25.json');
});

test('العدّادات تُعاد من المصفوفات — عدّاد كاذب من الخادم لا يمرّ', () => {
    const doc = buildExportDocument(payload({ counts: { members: 99, tickets: 99, subscriptions: 99, activity: 99, membership_events: 99, invoices: 99 } }));
    assert.deepEqual(doc.counts,
        { members: 2, tickets: 1, subscriptions: 2, activity: 1, membership_events: 0, invoices: 0 });
});

test('الأقسام الغائبة تصير [] لا undefined', () => {
    const doc = buildExportDocument({ company: { name: 'شركة' } });
    for (const key of ['members', 'tickets', 'subscriptions', 'activity', 'membership_events']) {
        assert.deepEqual(doc[key], [], `القسم ${key} لم يُضمَّن كمصفوفة`);
    }
    assert.equal(doc.counts.members, 0);
    assert.match(doc.file_name, /mad3oom-company-data-شركة-/);
});

test('الفواتير الغائبة عن الحمولة تُملأ بالنص الموثق — لا قسم ساقط', () => {
    const { invoices, ...rest } = payload();
    const doc = buildExportDocument(rest);
    assert.equal(doc.invoices.available, false);
    assert.equal(doc.invoices.table, 'accounting_invoices');
    assert.match(doc.invoices.reason, /بلا عمود يربط الفاتورة بشركة/);
    assert.equal(doc.invoices.invoiceHome, 'subscription_request_ticket');
    assert.deepEqual(doc.invoices.rows, []);
    assert.equal(doc.counts.invoices, 0);
});

test('قسم فواتير حاضر كما أرسله الخادم يُترك كما هو — لا اختراع ولا محو', () => {
    const doc = buildExportDocument(payload());
    assert.equal(doc.invoices.available, false);
    assert.match(doc.export_notice, /الفواتير غير متاحة على مستوى الشركة/);
    assert.match(doc.export_notice, /هواتف الأعضاء وبيانات الدفع غير مشمولة/);
});

test('حمولة ليست كائنًا تُرفض بدل تنزيل ملف فارغ', () => {
    assert.throws(() => buildExportDocument(null), /غير صالحة/);
    assert.throws(() => buildExportDocument('نص'), /غير صالحة/);
    assert.throws(() => buildExportDocument([1, 2]), /غير صالحة/);
});

/* ── سبب الحذف والسياسة ────────────────────────────────────────────────── */

test('سبب الحذف: فارغ وقصير مرفوضان، و20 حرفًا مقبولة — حدّ الخادم نفسه', () => {
    assert.equal(MIN_DELETION_REASON_LENGTH, 20);
    assert.match(validateDeletionReason(''), /اكتب سبب طلب الحذف/);
    assert.match(validateDeletionReason('   '), /اكتب سبب طلب الحذف/);
    assert.match(validateDeletionReason('سبب قصير جدًا'), /20 حرفًا على الأقل/);
    assert.equal(validateDeletionReason('أغلقنا الشركة نهائيًا ونريد حذف بياناتها'), null);
    assert.equal(validateDeletionReason('  أغلقنا الشركة نهائيًا ونريد حذف بياناتها  '), null);
});

test('سياسة الحذف تذكر المحذوف والمحتفَظ به صراحةً', () => {
    assert.ok(DELETION_POLICY.deleted.some(t => t.includes('الأعضاء')),
        'المحذوف لا يذكر بيانات الأعضاء');
    assert.ok(DELETION_POLICY.deleted.some(t => t.includes('تذاكر')),
        'المحذوف لا يذكر التذاكر');
    const kept = DELETION_POLICY.kept.join(' ');
    assert.match(kept, /الاشتراكات/);
    assert.match(kept, /accounting_invoices/);
    assert.match(kept, /سجلات التدقيق/);
    assert.match(kept, /للاحتفاظ القانوني/);
});

test('التحذير صريح عن عدم التراجع وعن أن الطلب نفسه لا يحذف فورًا', () => {
    assert.match(DELETION_WARNING, /لا يمكن التراجع عنه/);
    assert.match(DELETION_WARNING, /لا يحذف شيئًا فورًا/);
    assert.match(DELETION_WARNING, /يمكنك إلغاؤه ما دام قيد الانتظار/);
});

test('نص غياب الفواتير في النموذج يطابق نص الترحيل', () => {
    assert.equal(EXPORT_INVOICE_NOTE.available, false);
    assert.equal(EXPORT_INVOICE_NOTE.table, 'accounting_invoices');
    assert.equal(EXPORT_INVOICE_NOTE.invoiceHome, 'subscription_request_ticket');
});
