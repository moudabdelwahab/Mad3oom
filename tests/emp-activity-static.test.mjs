/**
 * فحوص ساكنة على توصيل تتبّع نشاط موظفي مدعوم (emp_ops).
 *
 * صفحات الدخول لا تُختبَر هنا بالتشغيل (تحتاج متصفحًا وجلسة)، لكن قواعد
 * التوصيل قابلة للإثبات من المصدر نفسه: التهيئة بعد المصادقة فقط، وفي
 * الصفحات الست المعتمدة، وعبر الجسر وحده — وأي انحراف يفشل قبل المراجعة.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function read(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** جسم الملف بلا تعليقات — الفحوص تنظر إلى الكود لا إلى شرحه. */
function codeOnly(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
}

const BRIDGE = codeOnly(read('assets/js/emp-activity.js'));

/* ── الجسر وحده يتحدث مع الـ SDK ─────────────────────────────────────── */

test('الجسر بلا أي import ثابت — آمن الاستيراد في Node والاختبارات', () => {
    assert.doesNotMatch(BRIDGE, /^import\s/m, 'الجسر يستورد statically');
    assert.match(BRIDGE, /await import\(SDK_PATH\)/, 'الـ SDK لا يُستورَد ديناميكيًا');
    assert.match(BRIDGE, /typeof window !== 'undefined'/, 'لا يوجد حارس بيئة المتصفح');
});

test('لا أحد ينادي الـ SDK مباشرةً إلا الجسر', () => {
    const entryFiles = [
        'assets/js/admin/tickets.js',
        'assets/js/admin/inbox.js',
        'assets/js/admin/dashboard-logic.js',
        'assets/js/owner/pages/tickets.js',
        'customer-dashboard.js',
        'assets/js/company/company-dashboard.js',
        'tickets-service.js',
    ];
    for (const rel of entryFiles) {
        const code = codeOnly(read(rel));
        assert.doesNotMatch(code, /Mad3oomActivity/, `${rel} ينادي الـ SDK مباشرةً بدل الجسر`);
        assert.doesNotMatch(code, /eo_ingest_activity/, `${rel} ينادي دالة الحضور مباشرةً`);
    }
});

/* ── التهيئة بعد المصادقة، في الصفحات الست ───────────────────────────── */

const ENTRIES = [
    { rel: 'assets/js/admin/tickets.js', auth: 'checkAdminAuth()', call: 'initEmpActivity({ supabase })' },
    { rel: 'assets/js/admin/inbox.js', auth: 'checkAdminAuth()', call: 'initEmpActivity()' },
    { rel: 'assets/js/admin/dashboard-logic.js', auth: 'checkAdminAuth()', call: 'initEmpActivity({ supabase })' },
    { rel: 'assets/js/owner/pages/tickets.js', auth: 'bootOwnerPage()', call: 'initEmpActivity({ supabase })' },
    { rel: 'customer-dashboard.js', auth: "guardPage('user')", call: 'if (!isGuest) initEmpActivity()' },
    { rel: 'assets/js/company/company-dashboard.js', auth: 'guardPage()', call: 'initEmpActivity()' },
];

for (const { rel, auth, call } of ENTRIES) {
    test(`${rel}: التهيئة بعد المصادقة عبر الجسر`, () => {
        const code = codeOnly(read(rel));
        assert.match(code, /initEmpActivity/, `${rel} لا يهيّئ التتبّع`);
        assert.match(code, /from ['"]\S*emp-activity\.js['"]/, `${rel} لا يستورد الجسر`);
        assert.ok(code.indexOf(auth) !== -1, `${rel} بلا نقطة مصادقة معروفة`);
        assert.ok(code.indexOf(auth) < code.indexOf(call),
            `${rel}: التهيئة قبل المصادقة`);
    });
}

test('لوحة العميل: الضيف يُتخطَّى — بلا جلسة أصلًا', () => {
    const code = codeOnly(read('customer-dashboard.js'));
    assert.match(code, /if \(!isGuest\) initEmpActivity\(\)/,
        'لوحة العميل تهيّئ التتبّع للضيف أيضًا');
});

/* ── أحداث العمل في خدمة التذاكر والصندوق ───────────────────────────── */

test('أحداث التذاكر الخمسة تُسجَّل بعد نجاح الإجراء، لا قبله', () => {
    const code = codeOnly(read('tickets-service.js'));
    const pairs = [
        ['ticket_create', 'ticket_open'],
        ['ticket_reply', 'ticket_reply'],
        ['ticket_status_update', 'ticket_status'],
        ['ticket_assignee_update', 'ticket_assign'],
    ];
    for (const [logged, tracked] of pairs) {
        const logAt = code.indexOf(`logActivity('${logged}'`);
        const trackAt = code.indexOf(`trackEmpActivity('${tracked}'`);
        assert.ok(logAt !== -1 && trackAt !== -1, `الحدث ${tracked} مفقود`);
        assert.ok(logAt < trackAt, `الحدث ${tracked} يُسجَّل قبل نجاح الإجراء`);
    }
});

test('ردّ الشات والملاحظة الداخلية يُسجَّلان بعد نجاح الإرسال', () => {
    const code = codeOnly(read('assets/js/admin/inbox.js'));
    assert.ok(code.indexOf('await sendReply(') < code.indexOf("trackEmpActivity('chat_reply'"),
        'ردّ الشات يُسجَّل قبل نجاح الإرسال');
    assert.ok(code.indexOf('await addNote(') < code.indexOf("trackEmpActivity('ticket_note'"),
        'الملاحظة تُسجَّل قبل نجاح إنشائها');
});
