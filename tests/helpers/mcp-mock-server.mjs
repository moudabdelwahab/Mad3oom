// خادم MCP وهمي ملتزم بمواصفة Streamable HTTP — يُستخدم لإثبات سلوك العميل.
// يفرض ترويسة Accept، ويصدر Mcp-Session-Id، ويقدر يرد بـ JSON أو SSE.
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const TOOLS = [
  { name: 'search_repositories', description: 'ابحث في المستودعات', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
  { name: 'create_issue', description: 'أنشئ Issue', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
];

export function startMockServer({ mode = 'json', requireSession = true, requireAccept = true } = {}) {
  const sessions = new Set();
  const seen = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const accept = req.headers['accept'] || '';
      const sessionHeader = req.headers['mcp-session-id'] || null;
      let msg = {};
      try { msg = JSON.parse(raw || '{}'); } catch {}
      seen.push({ method: msg.method, accept, sessionHeader, protocolVersion: req.headers['mcp-protocol-version'] || null });

      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Only POST is supported' } }));
      }

      // المواصفة: لا بد أن يعلن العميل قبوله للنوعين معًا.
      if (requireAccept && !(accept.includes('application/json') && accept.includes('text/event-stream'))) {
        res.writeHead(406, { 'content-type': 'text/plain' });
        return res.end('Not Acceptable: client must accept both application/json and text/event-stream');
      }

      const isInit = msg.method === 'initialize';

      if (requireSession && !isInit) {
        if (!sessionHeader || !sessions.has(sessionHeader)) {
          res.writeHead(404, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32000, message: 'Session not found' } }));
        }
      }

      // إشعار بلا id → 202 بلا جسم.
      if (msg.id === undefined) {
        res.writeHead(202);
        return res.end();
      }

      let result;
      const headers = { };
      if (isInit) {
        // randomUUID لا Math.random: مولّد معرّف الجلسة يقع في سياق أمني يرصده
        // التحليل الساكن، وهذا خادم اختبار فلا داعي أصلًا لمولّد ضعيف.
        const sid = 'sess-' + randomUUID().slice(0, 8);
        sessions.add(sid);
        headers['Mcp-Session-Id'] = sid;
        result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock-mcp', version: '9.9.9' } };
      } else if (msg.method === 'tools/list') {
        result = { tools: TOOLS };
      } else if (msg.method === 'tools/call') {
        result = { content: [{ type: 'text', text: 'called ' + msg.params?.name }] };
      } else {
        res.writeHead(200, { 'content-type': 'application/json', ...headers });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } }));
      }

      const envelope = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });

      if (mode === 'sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...headers });
        // إشعار من الخادم أولًا (بلا id) ثم الرد — لاختبار الفرز الصحيح.
        res.write('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } }) + '\n\n');
        res.write('event: message\ndata: ' + envelope + '\n\n');
        // البثّ يبقى مفتوحًا عمدًا: عميل ينتظر الإغلاق سيتعلّق.
      } else {
        res.writeHead(200, { 'content-type': 'application/json', ...headers });
        res.end(envelope);
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}/mcp`, seen, close: () => server.close() });
    });
  });
}
