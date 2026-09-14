/**
 * اختبارات تحليلات تقارير التذاكر وتصديرها — دوال خالصة بلا DOM.
 *
 * ثلاث خصائص تُحرَس هنا:
 *   ① الأرقام صحيحة، والمتوسطات لا تُحسب من بيانات ناقصة أو متضاربة.
 *   ② المساران لا يُجمعان في رقم واحد أبدًا.
 *   ③ التصدير يحمل **نفس** نطاق البيانات المعروض — لا أكثر ولا أقل.
 *
 * وXLSX يُختبَر بحزمة xlsx نفسها الموجودة في package.json، فما يُختبَر هو
 * ما يُنتَج فعلًا لا محاكاة له.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';

const {
    summarizeTickets, filterTickets, countBy, byPeriod, byCustomer,
    periodKey, hoursBetween, formatDuration, periodLabel,
    buildReportSheets, flattenSheets
} = await import('../assets/js/company/report-model.js');

const {
    toCsv, csvCell, neutralizeFormula, columnWidths, buildWorkbook, buildPrintDocument
} = await import('../assets/js/company/report-export.js');

const ME = 'me-0001';
const TZ = 'Asia/Riyadh';   // UTC+3 — نثبّتها فالنتائج لا تتغيّر بتغيّر جهاز التشغيل

function ticket(over = {}) {
    return {
        id: over.id || Math.random().toString(36).slice(2),
        ticket_number: over.ticket_number ?? 1,
        user_id: over.user_id || ME,
        title: over.title ?? 'عنوان',
        status: over.status ?? 'open',
        priority: over.priority ?? 'medium',
        category: over.category ?? 'technical',
        created_at: over.created_at ?? '2026-03-10T08:00:00Z',
        first_response_at: over.first_response_at ?? null,
        resolved_at: over.resolved_at ?? null,
        last_updated_by: over.last_updated_by ?? null,
        profiles: over.profiles
    };
}

/* ── التواريخ ───────────────────────────────────────────────────────────── */

test('التجميع الشهري بالتقويم المحلي لا بالـUTC', () => {
    // ٣١ ديسمبر ٢٣:٠٠ بتوقيت UTC = ١ يناير ٠٢:٠٠ بتوقيت الرياض
    assert.equal(periodKey('2026-12-31T23:00:00Z', { timeZone: 'Asia/Riyadh' }), '2027-01');
    assert.equal(periodKey('2026-12-31T23:00:00Z', { timeZone: 'UTC' }), '2026-12');
});

test('مفتاح اليوم كامل وقابل للفرز نصًّا', () => {
    assert.equal(periodKey('2026-03-10T08:00:00Z', { granularity: 'day', timeZone: TZ }), '2026-03-10');
    const keys = ['2026-10-01', '2026-02-01', '2026-01-15'].map(d =>
        periodKey(`${d}T12:00:00Z`, { granularity: 'day', timeZone: 'UTC' }));
    assert.deepEqual([...keys].sort(), ['2026-01-15', '2026-02-01', '2026-10-01']);
});

test('تاريخ غائب أو غير صالح لا يُنتج مفتاحًا مخترعًا', () => {
    assert.equal(periodKey(null, { timeZone: TZ }), null);
    assert.equal(periodKey('ليس تاريخًا', { timeZone: TZ }), null);
});

test('فارق الساعات يرفض الترتيب المقلوب بدل أن يُنتج رقمًا سالبًا', () => {
    assert.equal(hoursBetween('2026-03-10T08:00:00Z', '2026-03-10T12:00:00Z'), 4);
    assert.equal(hoursBetween('2026-03-10T12:00:00Z', '2026-03-10T08:00:00Z'), null);
    assert.equal(hoursBetween(null, '2026-03-10T08:00:00Z'), null);
    assert.equal(hoursBetween('2026-03-10T08:00:00Z', null), null);
});

/* ── الملخّص ────────────────────────────────────────────────────────────── */

test('العدّ الأساسي صحيح عبر كل الحالات', () => {
    const rows = [
        ticket({ status: 'open' }),
        ticket({ status: 'in-progress' }),
        ticket({ status: 'resolved' }),
        ticket({ status: 'confirmed' }),
        ticket({ status: 'rejected' })
    ];
    const s = summarizeTickets(rows, ME, { timeZone: TZ });
    assert.equal(s.total, 5);
    assert.equal(s.open, 2);          // open + in-progress
    assert.equal(s.inProgress, 1);
    assert.equal(s.closed, 3);        // resolved + confirmed + rejected
    assert.equal(s.open + s.closed, s.total, 'المفتوح والمغلق لا يغطّيان الإجمالي');
});

test('«بانتظار ردّك» = آخر من حدّثها ليس أنا وما زالت مفتوحة', () => {
    const rows = [
        ticket({ status: 'open', last_updated_by: 'support-1' }),
        ticket({ status: 'open', last_updated_by: ME }),
        ticket({ status: 'resolved', last_updated_by: 'support-1' })
    ];
    assert.equal(summarizeTickets(rows, ME, { timeZone: TZ }).awaiting, 1);
});

test('متوسط أول استجابة يُحسب من المستجاب لها وحدها', () => {
    const rows = [
        ticket({ created_at: '2026-03-10T08:00:00Z', first_response_at: '2026-03-10T10:00:00Z' }),
        ticket({ created_at: '2026-03-10T08:00:00Z', first_response_at: '2026-03-10T12:00:00Z' }),
        ticket({ created_at: '2026-03-10T08:00:00Z' })   // بلا ردّ: لا تدخل المتوسط
    ];
    const s = summarizeTickets(rows, ME, { timeZone: TZ });
    assert.equal(s.avgFirstResponseHours, 3);
    assert.equal(s.responded, 2, 'عدد المحسوبة يجب أن يُعلَن مع المتوسط');
});

test('تذكرة أُغلقت قبل أن تُفتح لا تُخفّض المتوسط', () => {
    const rows = [
        ticket({ status: 'resolved', created_at: '2026-03-10T08:00:00Z', resolved_at: '2026-03-10T20:00:00Z' }),
        ticket({ status: 'resolved', created_at: '2026-03-10T08:00:00Z', resolved_at: '2026-03-09T08:00:00Z' })
    ];
    const s = summarizeTickets(rows, ME, { timeZone: TZ });
    assert.equal(s.avgResolutionHours, 12);
    assert.equal(s.resolved, 1);
});

test('متوسط بلا بيانات = null لا صفر', () => {
    const s = summarizeTickets([ticket()], ME, { timeZone: TZ });
    assert.equal(s.avgFirstResponseHours, null);
    assert.equal(s.avgResolutionHours, null);
    assert.equal(formatDuration(null), '—');
});

test('قائمة فارغة لا تكسر شيئًا', () => {
    const s = summarizeTickets([], ME, { timeZone: TZ });
    assert.equal(s.total, 0);
    assert.deepEqual(s.byStatus, []);
});

/* ── التوزيعات ──────────────────────────────────────────────────────────── */

test('التوزيع حسب الحالة يغطّي الإجمالي بلا نقص', () => {
    const rows = [ticket({ status: 'open' }), ticket({ status: 'open' }), ticket({ status: 'resolved' })];
    const s = summarizeTickets(rows, ME, { timeZone: TZ });
    assert.equal(s.byStatus.reduce((n, r) => n + r.count, 0), s.total);
    assert.equal(s.byStatus[0].key, 'open');
    assert.equal(s.byStatus[0].count, 2);
});

test('التوزيع الزمني مرتّب تصاعديًا', () => {
    const rows = [
        ticket({ created_at: '2026-05-01T08:00:00Z' }),
        ticket({ created_at: '2026-01-01T08:00:00Z' }),
        ticket({ created_at: '2026-03-01T08:00:00Z' })
    ];
    assert.deepEqual(byPeriod(rows, { timeZone: 'UTC' }).map(r => r.key),
        ['2026-01', '2026-03', '2026-05']);
});

test('التوزيع حسب العميل يجمع تذاكر كل عميل ومتوسطه', () => {
    const rows = [
        ticket({ user_id: 'c1', profiles: { full_name: 'عميل أول', email: 'c1@t' },
                 created_at: '2026-03-10T08:00:00Z', first_response_at: '2026-03-10T10:00:00Z' }),
        ticket({ user_id: 'c1', profiles: { full_name: 'عميل أول', email: 'c1@t' }, status: 'resolved' }),
        ticket({ user_id: 'c2', profiles: { full_name: 'عميل ثانٍ', email: 'c2@t' } })
    ];
    const out = byCustomer(rows);
    assert.equal(out.length, 2);
    assert.equal(out[0].name, 'عميل أول');
    assert.equal(out[0].total, 2);
    assert.equal(out[0].open, 1);
    assert.equal(out[0].closed, 1);
    assert.equal(out[0].avgFirstResponseHours, 2);
});

/* ── التصفية ────────────────────────────────────────────────────────────── */

test('التصفية بمدى تاريخي شاملة للطرفين', () => {
    const rows = [
        ticket({ created_at: '2026-03-01T00:00:00Z' }),
        ticket({ created_at: '2026-03-15T12:00:00Z' }),
        ticket({ created_at: '2026-04-01T00:00:00Z' })
    ];
    assert.equal(filterTickets(rows, { from: '2026-03-01', to: '2026-03-31' }).length, 2);
    assert.equal(filterTickets(rows, {}).length, 3);
    assert.equal(filterTickets(rows, { status: 'open' }).length, 3);
    assert.equal(filterTickets(rows, { status: 'resolved' }).length, 0);
});

/* ── الفصل بين المسارين ─────────────────────────────────────────────────── */

test('التصدير يفصل المسارين في كل ورقة ولا يجمعهما', () => {
    const platform = [ticket({ ticket_number: 1, title: 'مع مدعوم' })];
    const customers = [ticket({ ticket_number: 2, title: 'من عميلي', user_id: 'c1',
                                profiles: { full_name: 'عميل', email: 'c@t' } })];
    const sheets = buildReportSheets({ platformTickets: platform, customerTickets: customers,
                                       userId: ME, timeZone: TZ });

    const summary = sheets.find(s => s.name === 'الملخّص');
    assert.deepEqual(summary.rows[0], ['المؤشّر', 'تذاكري مع مدعوم', 'تذاكر عملائي']);
    const totalRow = summary.rows.find(r => r[0] === 'إجمالي التذاكر');
    assert.equal(totalRow[1], 1);
    assert.equal(totalRow[2], 1);
    // ولا خانة واحدة تحمل المجموع 2
    assert.ok(!summary.rows.some(r => r.length === 2 && r[1] === 2),
        'ظهر رقم مجمّع يخلط المسارين');

    // وورقتا التفاصيل منفصلتان
    assert.ok(sheets.some(s => s.name === 'تفاصيل تذاكري مع مدعوم'));
    assert.ok(sheets.some(s => s.name === 'تفاصيل تذاكر عملائي'));
});

test('التصدير يحمل نفس عدد الصفوف المعروضة — لا أكثر ولا أقل', () => {
    const platform = Array.from({ length: 7 }, (_, i) => ticket({ ticket_number: i + 1 }));
    const customers = Array.from({ length: 3 }, (_, i) =>
        ticket({ ticket_number: 100 + i, user_id: 'c1', profiles: { full_name: 'ع', email: 'c@t' } }));
    const sheets = buildReportSheets({ platformTickets: platform, customerTickets: customers,
                                       userId: ME, timeZone: TZ });

    // -1 لصف العناوين
    assert.equal(sheets.find(s => s.name === 'تفاصيل تذاكري مع مدعوم').rows.length - 1, 7);
    assert.equal(sheets.find(s => s.name === 'تفاصيل تذاكر عملائي').rows.length - 1, 3);
});

test('ورقة النطاق تعلن الفترة والمنطقة الزمنية المعتمدة', () => {
    const sheets = buildReportSheets({ platformTickets: [], customerTickets: [], userId: ME,
        timeZone: TZ, filters: { from: '2026-01-01', to: '2026-03-31', status: 'open' } });
    const scope = sheets[0].rows.flat().join(' ');
    assert.match(scope, /2026-01-01/);
    assert.match(scope, /2026-03-31/);
    assert.match(scope, /Asia\/Riyadh/);
    assert.match(scope, /مفتوحة/);
});

/* ── CSV ────────────────────────────────────────────────────────────────── */

test('CSV يبدأ بـBOM وينتهي أسطره بـCRLF — شرطا فتحه في Excel', () => {
    const csv = toCsv([['العنوان', 'الحالة'], ['تذكرة', 'مفتوحة']]);
    assert.ok(csv.startsWith('﻿'), 'بلا BOM تظهر العربية مشوّهة في Excel');
    assert.ok(csv.includes('\r\n'), 'بلا CRLF لا يفصل Excel الأسطر');
    assert.match(csv, /"العنوان","الحالة"/);
});

test('CSV يهرّب الاقتباس والفواصل والأسطر داخل القيمة', () => {
    assert.equal(csvCell('قال "مرحبًا"'), '"قال ""مرحبًا"""');
    assert.equal(csvCell('أ,ب'), '"أ,ب"');
    assert.equal(csvCell('سطر\nثانٍ'), '"سطر\nثانٍ"');
    assert.equal(csvCell(null), '""');
});

test('حقن الصيغ محيَّد — عنوان تذكرة لا يصير صيغة في Excel', () => {
    // عناوين التذاكر يكتبها عملاء الشركة، والملف يُفتح على جهاز موظف
    for (const attack of ['=1+1', '+1', '-1', '@SUM(A1)', '=cmd|"/c calc"!A1']) {
        const cell = neutralizeFormula(attack);
        assert.ok(cell.startsWith("'"), `لم يُحيَّد: ${attack}`);
    }
    assert.equal(neutralizeFormula('تذكرة عادية'), 'تذكرة عادية');
    assert.equal(neutralizeFormula('10-3'), '10-3', 'قيمة مشروعة تبدأ برقم لم تتأثر');
});

/* ── XLSX ───────────────────────────────────────────────────────────────── */

test('XLSX يُقرأ بعد الكتابة وتعود العربية سليمة', () => {
    const sheets = [{ name: 'الملخّص', rows: [['المؤشّر', 'القيمة'], ['إجمالي التذاكر', 42]] }];
    const wb = buildWorkbook(XLSX, sheets);
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const back = XLSX.read(buf, { type: 'buffer' });

    const name = back.SheetNames[0];
    assert.equal(name, 'الملخّص', 'اسم الورقة العربي لم يُحفظ');
    const rows = XLSX.utils.sheet_to_json(back.Sheets[name], { header: 1 });
    assert.deepEqual(rows[0], ['المؤشّر', 'القيمة']);
    assert.equal(rows[1][0], 'إجمالي التذاكر');
});

test('XLSX: اتجاه المصنّف من اليمين', () => {
    const wb = buildWorkbook(XLSX, [{ name: 'ورقة', rows: [['أ']] }]);
    assert.equal(wb.Workbook.Views[0].RTL, true);
});

test('XLSX: الأرقام تُحفظ أرقامًا قابلة للفرز لا نصًّا', () => {
    const wb = buildWorkbook(XLSX, [{ name: 'أرقام', rows: [['العدد'], [7], [12]] }]);
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const back = XLSX.read(buf, { type: 'buffer' });
    const ws = back.Sheets[back.SheetNames[0]];
    assert.equal(ws.A2.t, 'n', 'الرقم حُفظ كنص فلا يمكن فرزه ولا جمعه');
    assert.equal(ws.A2.v, 7);
});

test('XLSX: عرض الأعمدة محسوب فلا تتكسّر', () => {
    const wb = buildWorkbook(XLSX, [{ name: 'ع',
        rows: [['قصير', 'عنوان طويل جدًّا يحتاج عمودًا أوسع بكثير من غيره']] }]);
    const cols = wb.Sheets['ع']['!cols'];
    assert.ok(cols[1].wch > cols[0].wch, 'العمود الطويل لم يُوسَّع');
    assert.ok(cols[1].wch <= 48, 'العرض تجاوز السقف فيخرج عن الصفحة');
});

test('XLSX: اسم ورقة طويل أو بمحارف ممنوعة لا يكسر الملف', () => {
    const wb = buildWorkbook(XLSX, [{ name: 'اسم/طويل:جدًّا'.repeat(5), rows: [['أ']] }]);
    const name = wb.SheetNames[0];
    assert.ok(name.length <= 31, `طول الاسم ${name.length}`);
    assert.ok(!/[:\\/?*[\]]/.test(name), 'بقيت محارف ممنوعة في اسم الورقة');
    assert.doesNotThrow(() => XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
});

test('XLSX: حقن الصيغ محيَّد في الخلايا أيضًا', () => {
    const wb = buildWorkbook(XLSX, [{ name: 'ص', rows: [['=1+1']] }]);
    assert.equal(wb.Sheets['ص'].A1.v, "'=1+1");
});

/* ── PDF (مستند الطباعة) ────────────────────────────────────────────────── */

test('مستند PDF عربي فعليًا: لغة واتجاه وخط عربي', () => {
    const html = buildPrintDocument({
        title: 'تقرير التذاكر', subtitle: 'شركة النور',
        meta: [['الفترة', 'يناير – مارس']],
        sections: [{ name: 'الملخّص', rows: [['المؤشّر', 'القيمة'], ['الإجمالي', 12]] }]
    });
    assert.match(html, /<html lang="ar" dir="rtl">/);
    assert.match(html, /direction:\s*rtl/);
    assert.match(html, /text-align:\s*right/);
    assert.match(html, /Cairo/, 'بلا خط عربي مضمَّن يخرج النص بخط بديل');
    assert.match(html, /charset="UTF-8"/i);
    assert.match(html, /تقرير التذاكر/);
    assert.match(html, /<th>المؤشّر<\/th>/);
});

test('مستند PDF: الأعمدة لا تتكسّر والرأس يتكرّر عبر الصفحات', () => {
    const html = buildPrintDocument({ title: 'ت', sections: [{ name: 'س', rows: [['أ'], ['ب']] }] });
    assert.match(html, /thead\s*{\s*display:\s*table-header-group/);
    assert.match(html, /break-inside:\s*avoid/);
    assert.match(html, /word-break:\s*break-word/);
    assert.match(html, /@page\s*{\s*size:\s*A4/);
});

test('مستند PDF يهرّب HTML فلا يحقن عنوان تذكرة وسمًا', () => {
    const html = buildPrintDocument({
        title: 'ت', sections: [{ name: 'س', rows: [['العنوان'], ['<script>alert(1)</script>']] }]
    });
    assert.ok(!html.includes('<script>alert(1)</script>'), 'عنوان تذكرة حُقن كوسم');
    assert.match(html, /&lt;script&gt;/);
});

test('مستند PDF يعلن حصر النطاق بالشركة', () => {
    const html = buildPrintDocument({ title: 'ت', sections: [] });
    assert.match(html, /محصور ببيانات شركتك/);
});

/* ── التسطيح لـCSV ──────────────────────────────────────────────────────── */

test('CSV المسطَّح يحتفظ بكل الأوراق معنونة', () => {
    const sheets = buildReportSheets({ platformTickets: [ticket()], customerTickets: [],
                                       userId: ME, timeZone: TZ });
    const flat = flattenSheets(sheets);
    const csv = toCsv(flat);
    for (const sheet of sheets) {
        assert.ok(csv.includes(`## ${sheet.name}`), `الورقة «${sheet.name}» غابت عن CSV`);
    }
});

test('تسمية الشهر بالعربي', () => {
    assert.equal(periodLabel('2026-03'), 'مارس 2026');
    assert.equal(periodLabel('2026-03-10'), '10 مارس 2026');
    assert.equal(periodLabel(null), '—');
});
