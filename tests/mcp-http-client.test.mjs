/**
 * اختبارات mcp-http.ts — عميل Streamable HTTP المشترك بين
 * test-mcp-server و mcp-invoke-tool.
 *
 * هذا الملف يشغّل tests/helpers/mcp-http-probe.mts في عملية فرعية بعلم
 * --experimental-strip-types: الملف المُختبَر مكتوب بـTypeScript لأنه يعمل
 * في Deno داخل الإنتاج، بينما مُشغّل اختبارات المستودع يقتصر على .mjs.
 * الفحص الفعلي يجري هنا على ما تطبعه العملية الفرعية، لا داخلها.
 *
 * ما تحرسه هذه الاختبارات (وكلّها كانت مكسورة قبل الإصلاح):
 *   • ترويسة Accept بالنوعين معًا  — سبب الخطأ 406 على اتصال Supabase
 *   • قراءة ردود SSE كما JSON     — الكود القديم كان ينادي res.json() دائمًا
 *   • التقاط Mcp-Session-Id وإعادتها
 *   • إرسال notifications/initialized — كان غائبًا تمامًا
 *   • غياب ترويسة إصدار البروتوكول عن initialize نفسه، ووجودها بعده
 *   • كشف التحويل (301) — سبب الخطأ 405 على خادم مدعوم
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, 'helpers', 'mcp-http-probe.mts');

/** تُشغَّل مرة واحدة؛ كل الاختبارات تحت تقرأ من نفس النتيجة. */
const report = JSON.parse(
    execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', probe], {
        encoding: 'utf8',
        timeout: 60_000,
    })
);

for (const mode of ['json', 'sse']) {
    const r = report[mode];

    test(`[${mode}] المصافحة تنجح وتقرأ بيانات الخادم`, () => {
        assert.equal(r.handshakeOk, true, `فشلت المصافحة: ${r.handshakeMessage}`);
        assert.equal(r.serverName, 'mock-mcp');
        assert.equal(r.protocolVersion, '2025-06-18');
    });

    test(`[${mode}] ترويسة Accept تُرسَل بالنوعين — الحارس المباشر ضد 406`, () => {
        assert.ok(r.acceptHeader.includes('application/json'), 'ينقصها application/json');
        assert.ok(r.acceptHeader.includes('text/event-stream'), 'ينقصها text/event-stream');
    });

    test(`[${mode}] ترويسات الجلسة وإصدار البروتوكول تتبع المواصفة`, () => {
        assert.equal(r.sessionCaptured, true, 'Mcp-Session-Id لم تُلتقط من رد initialize');
        assert.ok(r.sessionHeaderOnToolsList, 'الجلسة لم تُعَد على tools/list');
        // المواصفة: الترويسة تغيب عن initialize (لم يُتفاوض بعد) وتحضر بعده.
        assert.equal(r.protocolHeaderOnInitialize, null, 'أُرسلت ترويسة الإصدار على initialize');
        assert.equal(r.protocolHeaderOnToolsList, '2025-06-18', 'لم تُرسَل ترويسة الإصدار بعد التفاوض');
    });

    test(`[${mode}] notifications/initialized يُرسَل — كان غائبًا تمامًا`, () => {
        assert.equal(r.initializedNotificationSent, true);
    });

    test(`[${mode}] tools/list يرجع الأدوات`, () => {
        assert.equal(r.toolsOk, true);
        assert.equal(r.toolCount, 2);
    });

    test(`[${mode}] خطأ JSON-RPC يعود كرسالة لا كاستثناء`, () => {
        assert.equal(r.jsonRpcErrorOk, true);
        assert.match(r.jsonRpcErrorMessage, /Method not found/);
    });
}

test('رد ليس JSON يُشرَح بدل أن يُسقط العميل', () => {
    assert.equal(report.nonJson.ok, false);
    assert.match(report.nonJson.message, /غير JSON/);
});

test('المهلة تُحترم ولا تُترك مفتوحة', () => {
    assert.equal(report.timeout.ok, false);
    assert.match(report.timeout.message, /مهلة/);
    assert.ok(report.timeout.elapsedMs < 5000, `استغرق ${report.timeout.elapsedMs} مللي ثانية`);
});

test('التحويل (301) يُكشف ويُسمّى — سبب الخطأ 405 على خادم مدعوم', () => {
    assert.equal(report.redirect.ok, false, 'التحويل مُرّ بصمت');
    assert.match(report.redirect.message, /يحوّل الطلب إلى/);
    assert.equal(report.redirect.namesTarget, true, 'الرسالة لا تسمّي العنوان الصحيح');
    // والعنوان المباشر يعمل — ما يثبت أن التحويل وحده كان السبب.
    assert.equal(report.redirect.directOk, true);
    assert.equal(report.redirect.directServerName, 'target');
});
