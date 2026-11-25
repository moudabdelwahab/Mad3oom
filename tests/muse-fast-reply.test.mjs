// Behavioural tests for supabase/functions/muse-chat-reply/index.ts
// (the fast reply path for owner/muse-chat.html — migration 132).
//
// The function has zero imports, so it can be executed under Node with a
// small Deno shim + a stubbed fetch, exactly like verify-turnstile.
// Everything it touches (fetch, AbortController, Deno.env, Deno.serve)
// exists natively in Node 22.
//
// Run: node --test tests/muse-fast-reply.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const SUPABASE_URL = 'https://test.supabase.co';
const SERVICE_KEY = 'test-service-key';
const WEBHOOK_SECRET = 'test-webhook-secret';
const CEREBRAS_ID = '9c8eab8c-de82-49cf-9b6a-57fbc4622fca';
const ACK_PREFIX = '⏳ جارٍ التنفيذ — ';

// ── Harness ─────────────────────────────────────────────────────────────────
const env = {
  MUSE_REPLY_WEBHOOK_SECRET: WEBHOOK_SECRET,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
};

globalThis.Deno = {
  env: { get: (k) => env[k] },
  serve: (h) => { globalThis.__handler = h; },
};

let scenario = {};
const calls = [];

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = (init.method || 'GET').toUpperCase();
  let parsedBody = null;
  try { parsedBody = init.body ? JSON.parse(init.body) : null; } catch { parsedBody = init.body; }
  calls.push({ url: u, method, body: parsedBody, headers: init.headers || {} });

  // ai-gateway
  if (u.startsWith(`${SUPABASE_URL}/functions/v1/ai-gateway`)) {
    if (scenario.gatewayThrow) throw new Error(scenario.gatewayThrow);
    if (scenario.gateway) return jsonResponse(scenario.gateway.status ?? 200, scenario.gateway.body ?? {});
    return jsonResponse(200, { reply: 'رد تجريبي من الـ gateway' });
  }

  // PostgREST — route by table + query shape.
  if (u.includes('/rest/v1/ai_session_messages')) {
    if (method === 'POST') {
      if (scenario.insertFail) return jsonResponse(500, { message: 'insert failed' });
      return jsonResponse(201, [{ id: 'new-row-id', ...(parsedBody || {}) }]);
    }
    if (u.includes('role=eq.assistant')) return jsonResponse(200, scenario.assistantAfter ?? []);
    if (u.includes('select=role,content')) return jsonResponse(200, scenario.history ?? []);
    return jsonResponse(200, scenario.message ? [scenario.message] : []);
  }
  if (u.includes('/rest/v1/ai_sessions')) {
    if (method === 'PATCH') return new Response(null, { status: 204 });
    return jsonResponse(200, scenario.session ? [scenario.session] : []);
  }
  if (u.includes('/rest/v1/muse_account_activations')) {
    return jsonResponse(200, scenario.activation ?? []);
  }
  if (u.includes('/rest/v1/muse_reply_claims')) {
    if (method === 'DELETE') return new Response(null, { status: 204 });
    if (scenario.claim === 'conflict') return jsonResponse(201, []);
    return jsonResponse(201, [{ message_id: 'msg-1', session_id: 'sess-1', status: 'claimed' }]);
  }
  if (u.includes('/rest/v1/agent_activity_log')) {
    if (scenario.activityFail) return jsonResponse(500, { message: 'log failed' });
    return jsonResponse(201, [{}]);
  }
  if (u.includes('/rest/v1/tickets')) {
    if (u.includes('select=status')) return jsonResponse(200, scenario.ticketStatus ?? [{ status: 'confirmed' }, { status: 'resolved' }]);
    return jsonResponse(200, scenario.lastTickets ?? [{ ticket_number: '1101', title: 'تذكرة تجريبية', status: 'confirmed', created_at: '2026-11-24T10:00:00Z' }]);
  }
  if (u.includes('/rest/v1/profiles')) {
    return jsonResponse(200, [], { 'content-range': '0-0/3' });
  }
  throw new Error(`unexpected fetch: ${method} ${u}`);
};

const { classifyMuseMessage, isDataQuestion, ackTextFor } = await import(
  '../supabase/functions/muse-chat-reply/index.ts'
);

function baseScenario(overrides = {}) {
  scenario = {
    message: { id: 'msg-1', session_id: 'sess-1', role: 'user', content: 'ازيك عامل ايه', created_at: '2026-11-24T19:00:00Z' },
    session: { id: 'sess-1', owner_id: 'owner-1', model_id: 'muse', status: 'active' },
    activation: [{ owner_id: 'owner-1' }],
    history: [{ role: 'user', content: 'ازيك عامل ايه' }],
    assistantAfter: [],
    ...overrides,
  };
  calls.length = 0;
}

async function invoke(body, secret = WEBHOOK_SECRET) {
  const headers = { 'Content-Type': 'application/json' };
  if (secret !== null) headers['X-Muse-Reply-Secret'] = secret;
  const req = new Request(`${SUPABASE_URL}/functions/v1/muse-chat-reply`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const res = await globalThis.__handler(req);
  return { status: res.status, body: await res.json().catch(() => null) };
}

const gatewayCalls = () => calls.filter((c) => c.url.includes('/functions/v1/ai-gateway'));
const messageInserts = () => calls.filter((c) => c.url.includes('/rest/v1/ai_session_messages') && c.method === 'POST');
const claimDeletes = () => calls.filter((c) => c.url.includes('/rest/v1/muse_reply_claims') && c.method === 'DELETE');

// ── Classification ──────────────────────────────────────────────────────────

test('classify: page build requests are heavy', () => {
  assert.equal(classifyMuseMessage('ابنِ صفحة جديدة للتقارير'), 'heavy');
  assert.equal(classifyMuseMessage('عدّل صفحة الشات'), 'heavy');
  assert.equal(classifyMuseMessage('ضيف تبويب جديد في لوحة المالك'), 'heavy');
});

test('classify: reminders, quota and write actions are heavy', () => {
  assert.equal(classifyMuseMessage('فكرني أتابع التذكرة دي بكرة 10'), 'heavy');
  assert.equal(classifyMuseMessage('كم المتبقي من الكوتة؟'), 'heavy');
  assert.equal(classifyMuseMessage('أرسلها للتذكرة'), 'heavy');
  assert.equal(classifyMuseMessage('ابعت واتساب للعميل'), 'heavy');
  assert.equal(classifyMuseMessage('ألغِ الاشتراك'), 'heavy');
});

test('classify: greetings and data questions are normal', () => {
  assert.equal(classifyMuseMessage('ازيك عامل ايه'), 'normal');
  assert.equal(classifyMuseMessage('كم عدد التذاكر؟'), 'normal');
  assert.equal(classifyMuseMessage('إيه إحصائيات النهاردة؟'), 'normal');
  assert.equal(classifyMuseMessage('مين آخر عميل سجل؟'), 'normal');
});

test('isDataQuestion: tickets, stats and customers — but not reminders', () => {
  assert.equal(isDataQuestion('كم عدد التذاكر؟'), true);
  assert.equal(isDataQuestion('إيه إحصائيات النهاردة؟'), true);
  assert.equal(isDataQuestion('ازيك عامل ايه'), false);
  assert.equal(isDataQuestion('فكرني أتابع التذكرة دي بكرة'), false);
});

test('ackTextFor: short, honest, never claims completion', () => {
  assert.match(ackTextFor('ابنِ صفحة جديدة'), /صفحة/);
  assert.match(ackTextFor('فكرني بكرة'), /تذكير/);
  assert.match(ackTextFor('كم المتبقي من الكوتة؟'), /الحصة/);
  assert.doesNotMatch(ackTextFor('ابنِ صفحة جديدة'), /تم|خلص|جاهز/);
});

// ── Webhook auth ────────────────────────────────────────────────────────────

test('auth: missing or wrong secret is rejected, missing env secret is 503', async () => {
  baseScenario();
  const noHeader = await invoke({ message_id: 'msg-1', session_id: 'sess-1' }, null);
  assert.equal(noHeader.status, 401);
  assert.equal(noHeader.body.error, 'unauthorized');
  const wrong = await invoke({ message_id: 'msg-1', session_id: 'sess-1' }, 'nope');
  assert.equal(wrong.status, 401);
  assert.equal(calls.length, 0, 'rejected before any Supabase call');

  env.MUSE_REPLY_WEBHOOK_SECRET = '';
  const unconfigured = await invoke({ message_id: 'msg-1', session_id: 'sess-1' });
  assert.equal(unconfigured.status, 503);
  assert.equal(unconfigured.body.error, 'secret_not_configured');
  env.MUSE_REPLY_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

test('validation: missing ids are 400', async () => {
  baseScenario();
  const res = await invoke({ session_id: 'sess-1' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'message_id_and_session_id_required');
});

// ── Ignore paths ────────────────────────────────────────────────────────────

test('ignore: unknown message, non-user message, inactive or non-muse session, unactivated owner', async () => {
  baseScenario({ message: null });
  let res = await invoke({ message_id: 'msg-1', session_id: 'sess-1' });
  assert.equal(res.body.action, 'ignored');
  assert.equal(res.body.reason, 'not_a_user_message');

  baseScenario({ message: { id: 'msg-1', session_id: 'sess-1', role: 'assistant', content: 'x', created_at: '2026-11-24T19:00:00Z' } });
  res = await invoke({ message_id: 'msg-1', session_id: 'sess-1' });
  assert.equal(res.body.reason, 'not_a_user_message');

  baseScenario({ session: { id: 'sess-1', owner_id: 'owner-1', model_id: 'muse', status: 'archived' } });
  res = await invoke({ message_id: 'msg-1', session_id: 'sess-1' });
  assert.equal(res.body.reason, 'not_an_active_muse_session');

  baseScenario({ session: { id: 'sess-1', owner_id: 'owner-1', model_id: 'gpt-5', status: 'active' } });
  res = await invoke({ message_id: 'msg-1', session_id: 'sess-1' });
  assert.equal(res.body.reason, 'not_an_active_muse_session');

  baseScenario({ activation: [] });
  res = await invoke({ message_id: 'msg-1', session_id: 'sess-1' });
  assert.equal(res.body.reason, 'owner_not_activated');
  assert.equal(gatewayCalls().length, 0, 'ignored before any gateway call');
});

test('claim: a taken claim exits silently with no gateway call', async () => {
  baseScenario({ claim: 'conflict' });
  const res = await invoke({ message_id: 'msg-1', session_id: 'sess-1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.action, 'ignored');
  assert.equal(res.body.reason, 'already_claimed');
  assert.equal(gatewayCalls().length, 0);
  assert.equal(messageInserts().length, 0);
});

test('race: bridge already answered — no duplicate reply', async () => {
  baseScenario({ assistantAfter: [{ content: 'رد الجسر' }] });
  const res = await invoke({ message_id: 'msg-1', session_id: 'sess-1' });
  assert.equal(res.body.action, 'ignored');
  assert.equal(res.body.reason, 'already_answered');
  assert.equal(gatewayCalls().length, 0);
  assert.equal(messageInserts().length, 0);
});

test('race: an ack alone does not count as an answer', async () => {
  baseScenario({ assistantAfter: [{ content: `${ACK_PREFIX}استلمت طلبك.` }] });
  const res = await invoke({ message_id: 'msg-1', session_id: 'sess-1' });
  assert.equal(res.body.action, 'replied');
  assert.equal(gatewayCalls().length, 1);
});

// ── Heavy path ──────────────────────────────────────────────────────────────

test('heavy: instant ack with the prefix, session model_id, no gateway call', async () => {
  baseScenario({
    message: { id: 'msg-1', session_id: 'sess-1', role: 'user', content: 'ابنِ صفحة جديدة للتقارير', created_at: '2026-11-24T19:00:00Z' },
    session: { id: 'sess-1', owner_id: 'owner-1', model_id: 'muse-assistant', status: 'active' },
  });
  const res = await invoke({ message_id: 'msg-1', session_id: 'sess-1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.action, 'acknowledged');
  assert.equal(gatewayCalls().length, 0, 'heavy tasks never call the gateway');
  assert.equal(messageInserts().length, 1);
  assert.ok(messageInserts()[0].body.content.startsWith(ACK_PREFIX), 'ack carries the bridge-exclusion prefix');
  assert.equal(messageInserts()[0].body.model_id, 'muse-assistant', 'ack uses the session’s own model_id');
  assert.equal(messageInserts()[0].body.role, 'assistant');
  const log = calls.find((c) => c.url.includes('/rest/v1/agent_activity_log'));
  assert.equal(log?.body.action, 'ack_sent');
});

// ── Fast path ───────────────────────────────────────────────────────────────

test('fast: one gateway call (Cerebras first, max_attempts=2), reply inserted with session model_id', async () => {
  baseScenario();
  const res = await invoke({ message_id: 'msg-1', session_id: 'sess-1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.action, 'replied');
  assert.equal(gatewayCalls().length, 1);
  const gw = gatewayCalls()[0].body;
  assert.equal(gw.integration_id, CEREBRAS_ID);
  assert.equal(gw.mode, 'chat');
  assert.equal(gw.max_attempts, 2);
  assert.equal(gw.source, 'muse-fast-reply');
  assert.ok(Array.isArray(gw.messages) && gw.messages.some((m) => m.content === 'ازيك عامل ايه'));
  assert.equal(messageInserts().length, 1);
  assert.equal(messageInserts()[0].body.content, 'رد تجريبي من الـ gateway');
  assert.equal(messageInserts()[0].body.model_id, 'muse');
  assert.equal(messageInserts()[0].body.role, 'assistant');
  const patch = calls.find((c) => c.url.includes('/rest/v1/ai_sessions') && c.method === 'PATCH');
  assert.ok(patch?.body.last_active_at, 'last_active_at updated');
  const log = calls.find((c) => c.url.includes('/rest/v1/agent_activity_log'));
  assert.equal(log?.body.action, 'reply_sent');
  assert.equal(log?.body.details.message_id, 'msg-1');
});

test('fast: data questions pass live platform data as gateway system context', async () => {
  baseScenario({
    message: { id: 'msg-1', session_id: 'sess-1', role: 'user', content: 'كم عدد التذاكر؟', created_at: '2026-11-24T19:00:00Z' },
    history: [{ role: 'user', content: 'كم عدد التذاكر؟' }],
  });
  const res = await invoke({ message_id: 'msg-1', session_id: 'sess-1' });
  assert.equal(res.body.action, 'replied');
  const gw = gatewayCalls()[0].body;
  assert.match(gw.system, /بيانات حيّة من المنصة/);
  assert.match(gw.system, /1101/);
  assert.match(gw.system, /عدد العملاء/);
});

test('fast: gateway failure releases the claim and inserts nothing (bridge picks it up)', async () => {
  baseScenario({ gateway: { status: 502, body: { error: 'provider down' } } });
  const res = await invoke({ message_id: 'msg-1', session_id: 'sess-1' });
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'gateway_failed');
  assert.equal(messageInserts().length, 0);
  assert.equal(claimDeletes().length, 1, 'claim released so the bridge can answer');
});

test('fast: gateway throw (timeout) also releases the claim', async () => {
  baseScenario({ gatewayThrow: 'fetch aborted' });
  const res = await invoke({ message_id: 'msg-1', session_id: 'sess-1' });
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'gateway_failed');
  assert.equal(claimDeletes().length, 1);
  assert.equal(messageInserts().length, 0);
});

test('fast: reply insert failure releases the claim', async () => {
  baseScenario({ insertFail: true });
  const res = await invoke({ message_id: 'msg-1', session_id: 'sess-1' });
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'reply_insert_failed');
  assert.equal(claimDeletes().length, 1);
});

test('fast: activity-log failure never blocks the reply', async () => {
  baseScenario({ activityFail: true });
  const res = await invoke({ message_id: 'msg-1', session_id: 'sess-1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.action, 'replied');
  assert.equal(messageInserts().length, 1);
});
