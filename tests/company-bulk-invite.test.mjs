/**
 * الاستيراد الجماعي للعملاء من CSV — منطق التحليل والتحقق والتلخيص
 * (assets/js/company/company-model.js) + ضوابط ثابتة تربط الواجهة
 * بالمسار الصحيح (دعوة العميل company-invite-customer، لا create-sub-user).
 *
 * لا DOM ولا شبكة هنا: دوال خالصة تُستورد مباشرة، والربط يُثبَت بقراءة
 * المصدر على نمط tests/company-dashboard-ux.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    BULK_INVITE_MAX_ROWS,
    BULK_INVITE_MAX_FILE_BYTES,
    parseCustomersCsv,
    checkBulkInviteLimit,
    validateBulkInviteRows,
    summarizeBulkInviteResults
} from '../assets/js/company/company-model.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ── تحليل CSV ─────────────────────────────────────────────────────────── */

test('parseCustomersCsv: سطر عناوين email,name ثم صفوف، مع تقليم وتصغير البريد', () => {
    const { rows, errors } = parseCustomersCsv('email,name\n  New@X.test  , عميل جديد \nsecond@x.test,\n');
    assert.deepEqual(errors, []);
    assert.deepEqual(rows, [
        { line: 2, email: 'new@x.test', name: 'عميل جديد' },
        { line: 3, email: 'second@x.test', name: '' }
    ]);
});

test('parseCustomersCsv: بلا عناوين — العمود الأول بريد والثاني اسم', () => {
    const { rows } = parseCustomersCsv('a@x.test,أحمد\nb@x.test\n');
    assert.deepEqual(rows, [
        { line: 1, email: 'a@x.test', name: 'أحمد' },
        { line: 2, email: 'b@x.test', name: '' }
    ]);
});

test('parseCustomersCsv: عناوين عربية وBOM وCRLF وأسطر فارغة', () => {
    const { rows, errors } = parseCustomersCsv('\uFEFFالبريد الإلكتروني,الاسم\r\n\r\na@x.test,أحمد\r\nb@x.test,سارة\r\n');
    assert.deepEqual(errors, []);
    assert.deepEqual(rows, [
        { line: 3, email: 'a@x.test', name: 'أحمد' },
        { line: 4, email: 'b@x.test', name: 'سارة' }
    ]);
});

test('parseCustomersCsv: حقول مقتبسة فيها فاصلة، واقتباس مهرّب ""', () => {
    const { rows } = parseCustomersCsv('email,name\n"a@x.test","النجار, أحمد"\n"b@x.test","سعيد ""أبو علي"""\n');
    assert.deepEqual(rows, [
        { line: 2, email: 'a@x.test', name: 'النجار, أحمد' },
        { line: 3, email: 'b@x.test', name: 'سعيد "أبو علي"' }
    ]);
});

test('parseCustomersCsv: اقتباس غير مغلق — السطر خطأ عربي ولا يُرسَل', () => {
    const { rows, errors } = parseCustomersCsv('email,name\na@x.test,أحمد\n"b@x.test,سارة\nc@x.test,خالد\n');
    assert.deepEqual(rows, [
        { line: 2, email: 'a@x.test', name: 'أحمد' },
        { line: 4, email: 'c@x.test', name: 'خالد' }
    ]);
    assert.deepEqual(errors, [{ line: 3, reason: 'سطر غير صالح: علامة اقتباس غير مغلقة' }]);
});

test('parseCustomersCsv: سطر بلا بريد ولا اسم يُتجاهل، وسطر ببريد فارغ يبقى للتحقق', () => {
    const { rows } = parseCustomersCsv('email,name\n,\n,اسم بلا بريد\n');
    assert.deepEqual(rows, [{ line: 3, email: '', name: 'اسم بلا بريد' }]);
});

/* ── حد الصفوف ─────────────────────────────────────────────────────────── */

test('checkBulkInviteLimit: 100 صف مقبول، و101 مرفوض كاملًا برسالة عربية', () => {
    assert.equal(BULK_INVITE_MAX_ROWS, 100);
    assert.equal(checkBulkInviteLimit(100).ok, true);
    assert.equal(checkBulkInviteLimit(1).ok, true);
    const over = checkBulkInviteLimit(101);
    assert.equal(over.ok, false);
    assert.match(over.error, /101 صفًا/);
    assert.match(over.error, /100 صفوف/);
    assert.equal(checkBulkInviteLimit(0).ok, false);
    assert.match(checkBulkInviteLimit(0).error, /لا يحتوي على أي صفوف/);
    assert.ok(BULK_INVITE_MAX_FILE_BYTES >= 1024 * 1024, 'حد حجم الملف 1 ميجابايت على الأقل');
});

/* ── التحقق من الصفوف ───────────────────────────────────────────────────── */

const rows = (list) => list.map(([line, email, name = '']) => ({ line, email, name }));

test('validateBulkInviteRows: الصالح يمر، والبريد الفارغ وغير الصالح مرفوضان بنفس رسائل الدعوة الفردية', () => {
    const { valid, invalid } = validateBulkInviteRows(rows([
        [2, 'ok@x.test', 'صالح'],
        [3, '', 'بلا بريد'],
        [4, 'not-an-email', 'غير صالح'],
        [5, 'a@b', 'بلا نطاق'],
        [6, `${'x'.repeat(320)}@x.test`, 'طويل جدًا']
    ]));
    assert.deepEqual(valid.map(r => r.email), ['ok@x.test']);
    assert.deepEqual(invalid.map(r => [r.email, r.reason]), [
        ['', 'البريد الإلكتروني مطلوب'],
        ['not-an-email', 'بريد إلكتروني غير صالح'],
        ['a@b', 'بريد إلكتروني غير صالح'],
        [`${'x'.repeat(320)}@x.test`, 'بريد إلكتروني غير صالح']
    ]);
});

test('validateBulkInviteRows: المكرر داخل الملف مرفوض مهما اختلف حالة الأحرف', () => {
    const { valid, invalid } = validateBulkInviteRows(rows([
        [2, 'Dup@x.test'],
        [3, 'other@x.test'],
        [4, 'dup@X.TEST']
    ]));
    assert.deepEqual(valid.map(r => r.email), ['dup@x.test', 'other@x.test']);
    assert.deepEqual(invalid.map(r => r.reason), ['البريد مكرر داخل الملف']);
    assert.equal(invalid[0].line, 4);
});

test('validateBulkInviteRows: عميل الشركة والدعوة المعلّقة مرفوضان — بلا استهلاك للحد اليومي', () => {
    const { valid, invalid } = validateBulkInviteRows(rows([
        [2, 'member@x.test'],
        [3, 'WAIT@x.test'],
        [4, 'fresh@x.test']
    ]), { existingEmails: ['Member@X.test'], pendingEmails: ['wait@x.test'] });
    assert.deepEqual(valid.map(r => r.email), ['fresh@x.test']);
    assert.deepEqual(invalid.map(r => r.reason), ['عميل في الشركة بالفعل', 'دعوة معلّقة لهذا البريد بالفعل']);
});

test('validateBulkInviteRows: الاسم يُحفَظ للعرض ولا يؤثر في القبول', () => {
    const { valid } = validateBulkInviteRows(rows([[2, 'a@x.test', '  أحمد النجار  ']]));
    assert.equal(valid[0].name, '  أحمد النجار  ');
});

/* ── تلخيص التقرير ─────────────────────────────────────────────────────── */

test('summarizeBulkInviteResults: already_sent نجاح، وما عداه فشل', () => {
    const s = summarizeBulkInviteResults([
        { ok: true, status: 'sent' },
        { ok: true, status: 'already_sent' },
        { ok: false, status: 'server' },
        { ok: false, status: 'company_daily_cap' }
    ]);
    assert.deepEqual(s, { total: 4, sent: 1, alreadySent: 1, failed: 2, succeeded: 2 });
    assert.deepEqual(summarizeBulkInviteResults([]), { total: 0, sent: 0, alreadySent: 0, failed: 0, succeeded: 0 });
});

/* ── ضوابط الربط (قراءة المصدر) ─────────────────────────────────────────── */

test('الواجهة: كتلة الاستيراد في لوحة العملاء بكل عناصرها، وتُخفى مع نموذج الدعوة', () => {
    const html = read('company-dashboard/index.html');
    for (const id of ['companyBulkInvite', 'companyBulkInviteFile', 'companyBulkInviteTemplate',
        'companyBulkInviteError', 'companyBulkInvitePreview', 'companyBulkInviteActions',
        'companyBulkInviteSubmit', 'companyBulkInviteCancel', 'companyBulkInviteReport']) {
        assert.ok(html.includes(`id="${id}"`), `مفقود: ${id}`);
    }
    assert.match(html, /100 صف/, 'الحد مذكور في نص الواجهة');
    const dash = read('assets/js/company/company-dashboard.js');
    assert.ok(dash.includes("document.getElementById('companyBulkInvite').hidden = !view.canInvite;"),
        'الكتلة تُخفى حين لا تسمح القاعدة بالدعوة');
    assert.ok(dash.includes("document.getElementById('companyBulkInvite').hidden = true;"),
        'الكتلة تُخفى عند فشل تحميل العملاء');
});

test('الواجهة: التنفيذ عبر inviteCompanyCustomer صفًا صفًا، بلا create-sub-user في مسار الاستيراد', () => {
    const dash = read('assets/js/company/company-dashboard.js');
    assert.ok(dash.includes('wireBulkInvite();'), 'wireBulkInvite مربوط في init');
    assert.ok(dash.includes('await inviteCompanyCustomer(row.email)'), 'الدعوة لكل صف عبر المسار الموجود');
    const bulk = dash.slice(dash.indexOf('let bulkInvitePreview'), dash.indexOf('نافذة إضافة مستخدم'));
    assert.ok(bulk.length > 1000, 'قسم الاستيراد الجماعي موجود في الملف');
    assert.ok(!bulk.includes('create-sub-user'), 'create-sub-user لا يصلح لصفوف العملاء');
    assert.ok(!bulk.includes('createCompanyMember'), 'createCompanyMember ليس في مسار الاستيراد');
    assert.ok(!bulk.includes('company_invite_customer'), 'لا RPC مباشر يسجّل الصف بلا بريد');
    assert.ok(bulk.includes('bulkInvitePreview'), 'لا تنفيذ بلا معاينة سابقة');
});
