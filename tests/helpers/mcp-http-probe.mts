/**
 * يُشغَّل كعملية فرعية من tests/mcp-http-client.test.mjs بعلم
 * --experimental-strip-types، لأن mcp-http.ts ملف TypeScript يعمل في Deno
 * داخل الإنتاج، ومُشغّل اختبارات المستودع يقتصر على .mjs.
 * يطبع سطر JSON واحدًا يلخّص ما جرى، والأب هو من يؤكّد عليه.
 */
import { startMockServer } from './mcp-mock-server.mjs';
import { createMcpSession, mcpHandshake, mcpPost } from '../../supabase/functions/test-mcp-server/_shared/mcp-http.ts';

const out: Record<string, unknown> = {};

// دورة كاملة على خادم يفرض Accept ويعمل بجلسات، بردود JSON ثم SSE.
for (const mode of ['json', 'sse']) {
    const srv: any = await startMockServer({ mode, requireSession: true, requireAccept: true });
    const session = createMcpSession();

    const handshake = await mcpHandshake(srv.url, {}, session, { timeoutMs: 5000 });
    const tools = await mcpPost(srv.url, {}, session, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { timeoutMs: 5000 });
    const unknown = await mcpPost(srv.url, {}, session, { jsonrpc: '2.0', id: 4, method: 'nope/nope' }, { timeoutMs: 5000 });

    const initReq = srv.seen.find((s: any) => s.method === 'initialize');
    const toolsReq = srv.seen.find((s: any) => s.method === 'tools/list');

    out[mode] = {
        handshakeOk: handshake.ok,
        handshakeMessage: handshake.message ?? null,
        serverName: handshake.serverName ?? null,
        protocolVersion: handshake.protocolVersion ?? null,
        sessionCaptured: !!session.sessionId,
        initializedNotificationSent: !!srv.seen.find((s: any) => s.method === 'notifications/initialized'),
        acceptHeader: initReq?.accept ?? null,
        protocolHeaderOnInitialize: initReq?.protocolVersion ?? null,
        protocolHeaderOnToolsList: toolsReq?.protocolVersion ?? null,
        sessionHeaderOnToolsList: toolsReq?.sessionHeader ?? null,
        toolsOk: tools.ok,
        toolCount: (tools.result as any)?.tools?.length ?? 0,
        jsonRpcErrorOk: unknown.ok === false,
        jsonRpcErrorMessage: unknown.message ?? null,
    };
    srv.close();
}

// رد ليس JSON
const http = await import('node:http');
const plain = http.createServer((_req: any, res: any) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>not an mcp endpoint</html>');
});
await new Promise<void>((r) => plain.listen(0, '127.0.0.1', () => r()));
const nonJson = await mcpHandshake(`http://127.0.0.1:${(plain.address() as any).port}/`, {}, createMcpSession(), { timeoutMs: 4000 });
out.nonJson = { ok: nonJson.ok, message: nonJson.message ?? null };
plain.close();

// مهلة
const hang = http.createServer(() => { /* لا رد أبدًا */ });
await new Promise<void>((r) => hang.listen(0, '127.0.0.1', () => r()));
const t0 = Date.now();
const timedOut = await mcpHandshake(`http://127.0.0.1:${(hang.address() as any).port}/`, {}, createMcpSession(), { timeoutMs: 1200 });
out.timeout = { ok: timedOut.ok, message: timedOut.message ?? null, elapsedMs: Date.now() - t0 };
hang.close();

// تحويل 301
const target = http.createServer((req: any, res: any) => {
    if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Only POST is supported' } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'target', version: '1' } } }));
});
await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
const targetUrl = `http://127.0.0.1:${(target.address() as any).port}/mcp`;
const legacy = http.createServer((_req: any, res: any) => { res.writeHead(301, { location: targetUrl }); res.end(); });
await new Promise<void>((r) => legacy.listen(0, '127.0.0.1', () => r()));
const redirected = await mcpHandshake(`http://127.0.0.1:${(legacy.address() as any).port}/mcp`, {}, createMcpSession(), { timeoutMs: 4000 });
const direct = await mcpHandshake(targetUrl, {}, createMcpSession(), { timeoutMs: 4000 });
out.redirect = {
    ok: redirected.ok,
    message: redirected.message ?? null,
    namesTarget: (redirected.message ?? '').includes(targetUrl),
    directOk: direct.ok,
    directServerName: direct.serverName ?? null,
};
target.close(); legacy.close();

console.log(JSON.stringify(out));
