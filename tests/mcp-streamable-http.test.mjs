/**
 * اختبارات ناقل Streamable HTTP — العطلان اللذان أوقفا كل اتصالات MCP.
 *
 * كان الاتصالان الوحيدان في القاعدة بحالة `error`:
 *
 *   Supabase      → "Initialize failed (406)"
 *   Mad3oom MCP   → "Initialize failed (405)"
 *
 * وسببهما مختلف تمامًا:
 *
 *   406 — العميل كان يرسل `Content-Type` فقط. ومواصفة Streamable HTTP
 *         تُلزمه بإعلان قبوله للنوعين معًا:
 *             Accept: application/json, text/event-stream
 *         والخوادم الملتزمة ترد 406 بدونها.
 *
 *   405 — النطاق القديم mad3oom.online صار يحوّل (301) إلى mad3oom.com،
 *         ومواصفة Fetch تحوّل POST إلى GET عند 301/302/303. فيصل الطلب
 *         إلى الخادم كـGET فيرد "Only POST is supported".
 *         لا علاقة للأمر بمجلد mcp/ — راجع التقرير.
 *
 * كل اختبار هنا يشغّل خادمًا حقيقيًا على سوكِت حقيقي، لا وهميًا في الذاكرة:
 * الخطأ الذي نصلحه خطأ بروتوكول على السلك، ومحاكاة fetch لن تلتقطه.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { startMockServer } from './helpers/mcp-mock-server.mjs';
import { createStreamableHttpTransport } from '../mcp/transport/transports/streamable-http.js';

/** يشغّل الاختبار ثم يغلق الخادم مهما حدث. */
async function withServer(options, fn) {
    const srv = await startMockServer(options);
    try {
        return await fn(srv);
    } finally {
        srv.close();
    }
}

test('الترويسات القديمة (Content-Type وحده) تنتج 406 — إعادة إنتاج العطل', async () => {
    await withServer({ mode: 'json', requireSession: false }, async (srv) => {
        const res = await fetch(srv.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        });
        assert.equal(res.status, 406, 'خادم ملتزم بالمواصفة لا بد أن يرفض طلبًا بلا Accept');
    });
});

for (const mode of ['json', 'sse']) {
    test(`الناقل يكمل دورة كاملة على خادم يعمل بجلسات — ردود ${mode}`, async () => {
        await withServer({ mode, requireSession: true }, async (srv) => {
            const transport = createStreamableHttpTransport();
            const notifications = [];
            transport.onMessage((m) => notifications.push(m));
            await transport.open(srv.url);

            try {
                const init = await transport.send({
                    jsonrpc: '2.0', id: 1, method: 'initialize',
                    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
                });
                assert.equal(init.status, 200);
                assert.equal(init.body?.result?.serverInfo?.name, 'mock-mcp');

                const sentAccept = srv.seen[0].accept;
                assert.ok(sentAccept.includes('application/json'), 'Accept ينقصه application/json');
                assert.ok(sentAccept.includes('text/event-stream'), 'Accept ينقصه text/event-stream');

                // إشعار بلا id: الرد المتوقّع 202 بلا جسم.
                const notified = await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
                assert.equal(notified.status, 202);
                assert.equal(notified.body, null);

                // ينجح فقط لو أُعيد إرسال Mcp-Session-Id الملتقطة من رد initialize.
                const tools = await transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
                assert.equal(tools.status, 200, 'tools/list رُفض — الجلسة لم تُعَد');
                assert.equal(tools.body?.result?.tools?.length, 2);

                const toolsRequest = srv.seen.find((s) => s.method === 'tools/list');
                assert.ok(toolsRequest.sessionHeader, 'الخادم لم يستلم Mcp-Session-Id');

                const called = await transport.send({
                    jsonrpc: '2.0', id: 3, method: 'tools/call',
                    params: { name: 'create_issue', arguments: { title: 'x' } },
                });
                assert.equal(called.body?.result?.content?.[0]?.text, 'called create_issue');

                if (mode === 'sse') {
                    // الخادم يرسل إشعارًا (بلا id) قبل الرد داخل نفس البثّ.
                    // لا بد أن يُفرز إلى onMessage ولا يُعاد كأنه نتيجة الطلب.
                    assert.ok(notifications.length >= 1, 'إشعار الخادم لم يصل إلى onMessage');
                    assert.ok(notifications.every((n) => n.id === undefined), 'إشعار يحمل id — الفرز خاطئ');
                }
            } finally {
                await transport.close();
            }
        });
    });
}

test('رد SSE يُقرأ تدريجيًا ولا ينتظر إغلاق البثّ', async () => {
    // خادم المحاكاة يُبقي بثّ SSE مفتوحًا عمدًا بعد إرسال الرد.
    // قارئ يستدعي res.text() كان سيتعلّق حتى المهلة.
    await withServer({ mode: 'sse', requireSession: false }, async (srv) => {
        const transport = createStreamableHttpTransport();
        await transport.open(srv.url);
        try {
            const started = Date.now();
            const res = await transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
            const elapsed = Date.now() - started;
            assert.equal(res.body?.result?.serverInfo?.name, 'mock-mcp');
            assert.ok(elapsed < 2000, `استغرق ${elapsed} مللي ثانية — يبدو أنه انتظر إغلاق البثّ`);
        } finally {
            await transport.close();
        }
    });
});

test('التحويل (301) يُكشف ويُسمّى بدل أن يتحوّل بصمت إلى 405', async () => {
    // إعادة إنتاج عطل mad3oom.online → mad3oom.com بالضبط.
    const target = http.createServer((req, res) => {
        if (req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Only POST is supported' } }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'target', version: '1' } } }));
    });
    await new Promise((r) => target.listen(0, '127.0.0.1', r));
    const targetUrl = `http://127.0.0.1:${target.address().port}/mcp`;

    const legacyDomain = http.createServer((_req, res) => {
        res.writeHead(301, { location: targetUrl });
        res.end();
    });
    await new Promise((r) => legacyDomain.listen(0, '127.0.0.1', r));
    const legacyUrl = `http://127.0.0.1:${legacyDomain.address().port}/mcp`;

    try {
        // السلوك القديم: اتباع التحويل يحوّل POST إلى GET فينتج 405.
        const naive = await fetch(legacyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        });
        assert.equal(naive.status, 405);
        assert.equal((await naive.json()).error.message, 'Only POST is supported');

        // بعد الإصلاح: الناقل يرفض التحويل ويسمّي الوجهة الصحيحة.
        const transport = createStreamableHttpTransport();
        await transport.open(legacyUrl);
        await assert.rejects(
            () => transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
            (err) => {
                assert.match(err.message, /يحوّل الطلب إلى/);
                assert.ok(err.message.includes(targetUrl), 'الرسالة لا تذكر العنوان الصحيح');
                return true;
            }
        );
        await transport.close();

        // والعنوان المباشر يعمل — ما يؤكّد أن التحويل وحده كان السبب.
        const direct = createStreamableHttpTransport();
        await direct.open(targetUrl);
        const ok = await direct.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
        assert.equal(ok.body?.result?.serverInfo?.name, 'target');
        await direct.close();
    } finally {
        target.close();
        legacyDomain.close();
    }
});

test('رد ليس JSON لا يكسر الناقل', async () => {
    const plain = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html>not an mcp endpoint</html>');
    });
    await new Promise((r) => plain.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${plain.address().port}/`;
    try {
        const transport = createStreamableHttpTransport();
        await transport.open(url);
        const res = await transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
        // النصّ يُعاد كما هو بدل رمي خطأ تحليل — الطبقة الأعلى تقرّر.
        assert.equal(typeof res.body, 'string');
        assert.match(res.body, /not an mcp endpoint/);
        await transport.close();
    } finally {
        plain.close();
    }
});
