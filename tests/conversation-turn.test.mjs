// Behavioural tests for supabase/functions/conversation-turn (the Conversation
// Core orchestrator, phase 3 in docs/CONVERSATION_CORE_GATE_AR.md §8).
//
// core.ts has no imports on purpose, so the real orchestrator runs here under
// Node: the TypeScript is stripped with node:module and every dependency
// (database RPCs, SIE decide, trace, quota) is an in-memory double that
// records what it was asked to do. The database guarantees themselves
// (idempotency, version checks, quota savepoint, single writer) are proven in
// tests/sql/conversation-core-gate.test.sql; this file proves the orchestrator
// drives them correctly.
//
// index.ts is exercised at the end with a Supabase double, to pin the wiring:
// RPC names and arguments, and that nothing is written while the flag is off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const CORE = new URL('../supabase/functions/conversation-turn/core.ts', import.meta.url);
const INDEX = new URL('../supabase/functions/conversation-turn/index.ts', import.meta.url);

const coreJs = stripTypeScriptTypes(readFileSync(CORE, 'utf8'));
assert.ok(!/^\s*import\s/m.test(coreJs), 'core.ts must stay import-free so it runs outside Deno');
const core = await import('data:text/javascript,' + encodeURIComponent(coreJs));

const USER = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';
const MSG = '33333333-3333-4333-8333-333333333333';

const decision = (over = {}) => ({
  contractVersion: '1',
  decisionId: 'd-1',
  outcome: 'reply',
  reply: { text: 'أهلاً، أقدر أساعدك إزاي؟', parts: [], options: [] },
  intent: { name: 'greeting', confidence: 0.9 },
  state: { flow: 'main' },
  ticket: null,
  handoff: null,
  confidence: 0.9,
  trace: { engineVersion: 'abc123', latencyMs: 40 },
  ...over,
});

/**
 * A database + SIE double. `conflicts` makes the next N commits answer
 * version_conflict (as a concurrent message would), `owner` flips ownership.
 */
function world(opts = {}) {
  const calls = { ingest: [], decide: [], commit: [], consume: [], trace: [], log: [] };
  const state = {
    enabled: opts.enabled ?? true,
    entitlement: opts.entitlement ?? { has_access: true, edition: 'pro' },
    stateVersion: 1,
    owner: opts.owner ?? 'agent',
    status: 'active',
    replies: new Map(), // turnKey -> { id, text, metadata }
    conflicts: opts.conflicts ?? 0,
    seq: 1,
  };
  if (opts.existingReply) state.replies.set(MSG, opts.existingReply);
  const deps = {
    async channelEnabled(uid) { assert.equal(uid, USER); return state.enabled; },
    async sieEntitlement() { return state.entitlement; },
    async ingest(args) {
      calls.ingest.push(args);
      if (opts.ingestError) throw opts.ingestError;
      state.stateVersion += 1;
      state.seq += 1;
      return {
        created: !opts.duplicate, duplicate: !!opts.duplicate,
        conversation: { id: CONV, stateVersion: state.stateVersion },
        message: { id: MSG, seq: state.seq }, owner: state.owner, stateVersion: state.stateVersion,
      };
    },
    async loadConversation(id) {
      assert.equal(id, CONV);
      return { id, stateVersion: state.stateVersion, owner: state.owner, status: state.status, state: { flow: 'old' } };
    },
    async loadMessages() {
      return opts.rows ?? [
        { id: 'm0', seq: null, sender_id: USER, message_text: 'قديمة', is_bot_reply: false, is_admin_reply: false, attachment: null, created_at: '2026-09-01T00:00:00Z' },
        { id: MSG, seq: 2, sender_id: USER, message_text: 'السلام عليكم', is_bot_reply: false, is_admin_reply: false, attachment: null, created_at: '2026-10-08T00:00:00Z' },
      ];
    },
    async findReply(id, key) { return state.replies.get(key) ?? null; },
    async ticketQuota() { return { remaining: 3, unlimited: false, used: 17 }; },
    async decide(request, timeoutMs) {
      calls.decide.push({ request, timeoutMs });
      if (opts.decide) return opts.decide(request, calls.decide.length);
      return decision();
    },
    async commit(args) {
      calls.commit.push(args);
      if (state.conflicts > 0) {
        state.conflicts -= 1;
        state.stateVersion += 1; // the other message moved the conversation on
        return { committed: false, reason: 'version_conflict', owner: 'agent', stateVersion: state.stateVersion };
      }
      if (opts.commitReject) return { committed: false, reason: opts.commitReject, stateVersion: state.stateVersion };
      if (args.p_expected_version !== state.stateVersion) {
        return { committed: false, reason: 'version_conflict', stateVersion: state.stateVersion };
      }
      state.stateVersion += 1;
      state.seq += 1;
      const ticketNumber = args.p_ticket ? (opts.ticketError ? null : 1119) : null;
      let text = args.p_reply_text;
      if (args.p_ticket && ticketNumber && args.p_ticket.confirmation) text += '\n' + args.p_ticket.confirmation.replace('{ticket_number}', ticketNumber);
      if (args.p_ticket && opts.ticketError) text += '\nوصلت للحد الأقصى من التذاكر';
      state.replies.set(args.p_turn_key, {
        id: 'reply-1', text,
        metadata: { parts: args.p_reply_parts, agentId: args.p_agent_id, turnKey: args.p_turn_key,
          ...(ticketNumber ? { ticketNumber } : {}), ...(opts.ticketError ? { ticketError: opts.ticketError } : {}) },
      });
      return { committed: true, duplicate: false, messageId: 'reply-1', seq: state.seq,
        ticketNumber, ticketError: opts.ticketError ?? null, handoff: !!args.p_handoff_reason,
        owner: args.p_handoff_reason ? 'human' : 'agent', stateVersion: state.stateVersion };
    },
    async consume(uid) { calls.consume.push(uid); if (opts.consumeFails) throw new Error('consume down'); return [{ allowed: true }]; },
    async trace(row) { calls.trace.push(row); if (opts.traceFails) throw new Error('trace down'); },
    log(event, data) { calls.log.push({ event, ...data }); },
    now: (() => { let t = 1000; return () => (t += 25); })(),
  };
  return { deps, calls, state };
}

const send = (w, over = {}) =>
  core.runTurn(w.deps, { userId: USER, message: 'السلام عليكم', clientMessageId: 'c-0001-abcd', ...over });

// ── gates before any write ─────────────────────────────────────────────────

test('flag off: 409 core_disabled and nothing is written or decided', async () => {
  const w = world({ enabled: false });
  const r = await send(w);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'core_disabled');
  assert.equal(w.calls.ingest.length, 0);
  assert.equal(w.calls.decide.length, 0);
  assert.equal(w.calls.commit.length, 0);
});

test('no SIE access: 403 with the server reason, before ingest', async () => {
  const w = world({ entitlement: { has_access: false, reason: 'quota_exceeded' } });
  const r = await send(w);
  assert.deepEqual([r.status, r.body.error, r.body.reason], [403, 'sie_unavailable', 'quota_exceeded']);
  assert.equal(w.calls.ingest.length, 0);
});

test('input is validated before anything else', async () => {
  for (const [over, status] of [
    [{ clientMessageId: 'short' }, 400],
    [{ clientMessageId: 'has spaces in it' }, 400],
    [{ message: '' }, 400],
    [{ message: 'x'.repeat(4001) }, 400],
    [{ message: 'hi', attachment: 'path' }, 400],
  ]) {
    const w = world();
    const r = await send(w, over);
    assert.equal(r.status, status, JSON.stringify(over));
    assert.equal(w.calls.ingest.length, 0);
  }
});

test('an inactive account (G1) is 403 account_inactive, nothing decided', async () => {
  const err = Object.assign(new Error('الحساب غير مفعّل للمحادثة'), { code: '42501', hint: 'account_inactive' });
  const w = world({ ingestError: err });
  const r = await send(w);
  assert.deepEqual([r.status, r.body.error], [403, 'account_inactive']);
  assert.equal(w.calls.decide.length, 0);
});

test('a malformed message rejected by ingest (22023) is 400 with its reason', async () => {
  const err = Object.assign(new Error('مرفق غير مدعوم'), { code: '22023' });
  const r = await send(world({ ingestError: err }), { attachment: { kind: 'video', path: 'x' } });
  assert.deepEqual([r.status, r.body.error], [400, 'مرفق غير مدعوم']);
});

test('ingest gets the website channel, a namespaced external id and the attachment', async () => {
  const w = world();
  const att = { kind: 'image', path: `${USER}/a.png`, name: 'a.png' };
  await send(w, { message: '  شوف الصورة  ', attachment: att });
  const a = w.calls.ingest[0];
  assert.equal(a.p_channel, 'website');
  assert.equal(a.p_user_id, USER);
  assert.equal(a.p_external_thread_id, '');
  assert.equal(a.p_external_id, 'web:c-0001-abcd');
  assert.equal(a.p_text, 'شوف الصورة');
  assert.deepEqual(a.p_attachment, att);
});

// ── the happy path and the contract mapping ────────────────────────────────

test('reply: decide on the latest state, commit once, consume once, trace once', async () => {
  const w = world();
  const r = await send(w);
  assert.equal(r.status, 200);
  assert.equal(r.body.reply, 'أهلاً، أقدر أساعدك إزاي؟');
  assert.equal(r.body.skipped, false);
  assert.equal(r.body.agent, 'sie');
  assert.equal(r.body.conversationId, CONV);

  assert.equal(w.calls.decide.length, 1);
  assert.equal(w.calls.decide[0].timeoutMs, 8000);
  const req = w.calls.decide[0].request;
  assert.equal(req.contractVersion, '1');
  assert.equal(req.turnKey, MSG, 'turnKey = the customer message id');
  assert.deepEqual(req.conversation, { id: CONV, channel: 'website', stateVersion: 2, owner: 'agent' });
  assert.deepEqual(req.state, { flow: 'old' });
  assert.deepEqual(req.facts.ticketQuota, { remaining: 3, unlimited: false });
  assert.deepEqual(req.facts.entitlement, { hasAccess: true, edition: 'pro' });
  assert.deepEqual(req.messages.map((m) => [m.id, m.role]), [['m0', 'customer'], [MSG, 'customer']],
    'legacy rows (seq NULL) come first');

  assert.equal(w.calls.commit.length, 1);
  const c = w.calls.commit[0];
  assert.equal(c.p_conversation_id, CONV);
  assert.equal(c.p_expected_version, 2);
  assert.equal(c.p_turn_key, MSG);
  assert.equal(c.p_agent_id, 'sie@abc123');
  assert.equal(c.p_delivery_required, false);
  assert.deepEqual(c.p_state, { flow: 'main' });
  assert.equal(c.p_ticket, null);
  assert.equal(c.p_handoff_reason, null);

  assert.deepEqual(w.calls.consume, [USER]);
  assert.equal(w.calls.trace.length, 1);
  assert.equal(w.calls.trace[0].session_id, CONV);
  assert.equal(w.calls.trace[0].decision.decisionId, 'd-1');
});

test('intent / confidence / trace never reach the message metadata', async () => {
  const w = world();
  await send(w);
  const c = w.calls.commit[0];
  const visible = JSON.stringify([c.p_reply_parts, c.p_reply_text, c.p_state]);
  for (const secret of ['greeting', 'latencyMs', 'confidence', 'decisionId']) {
    assert.ok(!visible.includes(secret), `${secret} leaked into what the customer can read`);
  }
  assert.ok(w.calls.trace[0].decision.intent, 'but the trace keeps it');
});

test('clarify: options are committed as a part and returned', async () => {
  const opts = [{ label: 'طريقة الاشتراك', value: 'how_to' }, { label: 'سعر الاشتراك', value: 'price' }];
  const w = world({ decide: () => decision({ outcome: 'clarify', reply: { text: 'تقصد إيه بالظبط؟', options: opts } }) });
  const r = await send(w);
  assert.deepEqual(w.calls.commit[0].p_reply_parts, [{ type: 'options', options: opts }]);
  assert.deepEqual(r.body.options, opts);
});

test('handoff: the reason goes to commit, a default text when SIE gave none', async () => {
  const w = world({ decide: () => decision({ outcome: 'handoff', reply: null, handoff: { reason: 'customer_asked' } }) });
  const r = await send(w);
  assert.equal(w.calls.commit[0].p_handoff_reason, 'customer_asked');
  assert.equal(w.calls.commit[0].p_reply_text, core.HANDOFF_DEFAULT_TEXT);
  assert.equal(r.body.handoff, true);
});

test('handoff on a non-handoff outcome is ignored (only outcome=handoff hands off)', async () => {
  const w = world({ decide: () => decision({ handoff: { reason: 'stray' } }) });
  await send(w);
  assert.equal(w.calls.commit[0].p_handoff_reason, null);
});

test('ticket: mapped to commit; the confirmation number comes from the database', async () => {
  const ticket = { category: 'دعم', description: 'الواتساب واقف', type: 'problem', priority: 'high',
    confirmation: 'اتفتحتلك تذكرة #{ticket_number}' };
  const w = world({ decide: () => decision({ ticket }) });
  const r = await send(w);
  assert.deepEqual(w.calls.commit[0].p_ticket, ticket);
  assert.equal(r.body.ticketCreated, true);
  assert.equal(r.body.ticketNumber, 1119);
  assert.match(r.body.reply, /#1119/);
});

test('ticket over quota (D1): the reply still lands, ticketError is reported', async () => {
  const w = world({ ticketError: 'ticket_quota_exceeded',
    decide: () => decision({ ticket: { description: 'x' } }) });
  const r = await send(w);
  assert.equal(r.status, 200);
  assert.equal(r.body.ticketCreated, false);
  assert.equal(r.body.ticketError, 'ticket_quota_exceeded');
  assert.match(r.body.reply, /الأقصى من التذاكر/);
});

test('noop: nothing committed, nothing consumed, the decision is traced', async () => {
  const w = world({ decide: () => decision({ outcome: 'noop', reply: null }) });
  const r = await send(w);
  assert.deepEqual([r.body.skipped, r.body.reason], [true, 'noop']);
  assert.equal(w.calls.commit.length, 0);
  assert.equal(w.calls.consume.length, 0);
  assert.equal(w.calls.trace.length, 1);
});

// ── failure handling ───────────────────────────────────────────────────────

for (const [name, decide] of [
  ['SIE times out', () => { throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }); }],
  ['SIE is not configured', () => { throw new Error('SIE decide is not configured'); }],
  ['SIE returns a wrong contract version', () => ({ ...decision(), contractVersion: '2' })],
  ['SIE returns garbage', () => '<html>502</html>'],
  ['SIE returns an empty reply', () => decision({ reply: { text: '   ' } })],
  ['SIE returns a clarify without options', () => decision({ outcome: 'clarify' })],
  ['SIE returns a bad ticket', () => decision({ ticket: { description: 'x', priority: 'urgent' } })],
]) {
  test(`fallback when ${name}: fixed system reply, no ticket, no state, nothing consumed`, async () => {
    const w = world({ decide });
    const r = await send(w);
    assert.equal(r.status, 200);
    assert.equal(r.body.agent, 'system');
    assert.equal(r.body.reply, core.SYSTEM_FALLBACK_TEXT);
    const c = w.calls.commit[0];
    assert.deepEqual([c.p_agent_id, c.p_ticket, c.p_state, c.p_handoff_reason], ['system', null, null, null]);
    assert.equal(w.calls.consume.length, 0, 'a system reply is not SIE usage');
    assert.equal(w.calls.trace[0].decision.outcome, 'fallback');
    assert.ok(w.calls.log.some((l) => l.event === 'decide_fallback'));
  });
}

test('version_conflict: decide again on the newer state, at most twice', async () => {
  const w = world({ conflicts: 2 });
  const r = await send(w);
  assert.equal(r.status, 200);
  assert.equal(r.body.skipped, false);
  assert.equal(w.calls.decide.length, 3);
  assert.deepEqual(w.calls.commit.map((c) => c.p_expected_version), [2, 3, 4],
    'each retry carries the version it actually decided on');
  assert.equal(w.calls.consume.length, 1);
});

test('version_conflict three times: give up quietly, nothing consumed', async () => {
  const w = world({ conflicts: 3 });
  const r = await send(w);
  assert.deepEqual([r.body.skipped, r.body.reason], [true, 'version_conflict']);
  assert.equal(w.calls.decide.length, 3);
  assert.equal(w.calls.consume.length, 0);
});

test('human owner at ingest: no decide (the customer message is still recorded)', async () => {
  const w = world({ owner: 'human' });
  const r = await send(w);
  assert.deepEqual([r.body.skipped, r.body.reason], [true, 'human_owner']);
  assert.equal(w.calls.ingest.length, 1);
  assert.equal(w.calls.decide.length, 0);
});

test('human took over during decide: commit refuses, nothing consumed', async () => {
  const w = world({ commitReject: 'human_owner' });
  const r = await send(w);
  assert.deepEqual([r.body.skipped, r.body.reason], [true, 'human_owner']);
  assert.equal(w.calls.consume.length, 0);
});

test('a resent message that already has a reply returns that reply, no decide', async () => {
  const w = world({ duplicate: true,
    existingReply: { id: 'reply-0', text: 'الرد الأول', metadata: { parts: [], ticketNumber: 1100 } } });
  const r = await send(w);
  assert.equal(r.body.reply, 'الرد الأول');
  assert.equal(r.body.duplicate, true);
  assert.equal(r.body.ticketNumber, 1100);
  assert.equal(w.calls.decide.length, 0);
  assert.equal(w.calls.commit.length, 0);
});

test('a resent message whose first turn never committed is answered now', async () => {
  const w = world({ duplicate: true });
  const r = await send(w);
  assert.equal(r.body.skipped, false);
  assert.equal(w.calls.commit[0].p_turn_key, MSG, 'same turn key ⇒ commit stays idempotent');
});

test('trace and consume failures never fail a committed turn', async () => {
  const w = world({ traceFails: true, consumeFails: true });
  const r = await send(w);
  assert.equal(r.status, 200);
  assert.equal(r.body.reply, 'أهلاً، أقدر أساعدك إزاي؟');
  assert.ok(w.calls.log.some((l) => l.event === 'trace_failed'));
  assert.ok(w.calls.log.some((l) => l.event === 'consume_failed'));
});

// ── the Decision contract on its own ───────────────────────────────────────

test('parseDecision accepts the documented shape and ignores unknown actions', () => {
  const p = core.parseDecision({ ...decision(), actions: [{ type: 'link', href: 'x' }], extra: 1 });
  assert.equal(p.ok, true);
  assert.equal(p.decision.outcome, 'reply');
});

test('parseDecision rejects each broken field with a reason', () => {
  const cases = [
    [{ outcome: 'escalate' }, /outcome/],
    [{ decisionId: '' }, /decisionId/],
    [{ reply: { text: 'x'.repeat(4001) } }, /reply.text/],
    [{ reply: { text: 'ok', options: [{ label: 'a' }] } }, /options/],
    [{ state: [] }, /state/],
    [{ ticket: { category: 'x' } }, /description/],
    [{ ticket: { description: 'x', type: 'bug' } }, /ticket.type/],
    [{ outcome: 'handoff', handoff: null }, /handoff/],
    [{ confidence: 1.5 }, /confidence/],
    [{ trace: { engineVersion: '' } }, /engineVersion/],
  ];
  for (const [over, re] of cases) {
    const p = core.parseDecision(decision(over));
    assert.equal(p.ok, false, JSON.stringify(over));
    assert.match(p.errors.join(' | '), re);
  }
});

test('agent id: sie@<engineVersion>, without doubling an existing prefix', () => {
  const d = (ev) => core.parseDecision(decision({ trace: { engineVersion: ev } })).decision;
  assert.equal(core.agentIdOf(d('abc')), 'sie@abc');
  assert.equal(core.agentIdOf(d('sie@abc')), 'sie@abc');
});

test('history: roles from the row, storage paths never sent to SIE, capped at 20', () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({
    id: `m${i}`, seq: i + 1, sender_id: i % 2 ? USER : null, message_text: `t${i}`,
    is_bot_reply: i % 2 === 0 && i % 4 === 0, is_admin_reply: i % 4 === 2,
    attachment: i === 24 ? { kind: 'image', path: `${USER}/secret.png`, name: 's.png', mime: 'image/png' } : null,
    created_at: '2026-10-08T00:00:00Z',
  }));
  const msgs = core.toDecideMessages(rows, USER);
  assert.equal(msgs.length, 20);
  assert.equal(msgs[0].id, 'm5');
  assert.deepEqual(new Set(msgs.map((m) => m.role)), new Set(['agent', 'human', 'customer']));
  assert.deepEqual(msgs.at(-1).attachment, { kind: 'image', mime: 'image/png', name: 's.png' });
  assert.ok(!JSON.stringify(msgs).includes(`${USER}/secret.png`), 'storage path leaked to SIE');
});

// ── index.ts wiring ────────────────────────────────────────────────────────

const rpcCalls = [];
let flagOn = false;
globalThis.Deno = {
  env: { get: (k) => ({ SUPABASE_URL: 'https://stub.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service' })[k] },
  serve: (h) => { globalThis.__turnHandler = h; },
};
globalThis.__createClient = (url, key, options) => ({
  auth: {
    getUser: async () => (options?.global?.headers?.Authorization === 'Bearer good'
      ? { data: { user: { id: USER } }, error: null }
      : { data: null, error: { message: 'bad jwt' } }),
  },
  rpc: async (fn, args) => {
    rpcCalls.push({ fn, args, key });
    if (fn === 'conv_channel_enabled') return { data: flagOn, error: null };
    if (fn === 'sie_my_entitlement') return { data: { has_access: false, reason: 'not_enabled' }, error: null };
    return { data: null, error: { message: `unexpected rpc ${fn}` } };
  },
  from: () => { throw new Error('no table access expected in these cases'); },
});
const indexTs = readFileSync(INDEX, 'utf8')
  .replace(/^import "jsr:@supabase\/functions-js[^\n]*\n/m, '')
  .replace(/^import \{ createClient \} from "jsr:@supabase\/supabase-js@2";\n/m, 'const createClient = globalThis.__createClient;\n')
  .replace(/^import \{ runTurn, type Deps, type DbError \} from "\.\/core\.ts";\n/m, 'const { runTurn } = globalThis.__core;\n');
assert.ok(indexTs.includes('globalThis.__createClient') && indexTs.includes('globalThis.__core'),
  'index.ts imports must stay swappable');
globalThis.__core = core;
await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(indexTs)));
const handler = globalThis.__turnHandler;
const post = (auth, body) => handler(new Request('https://x/conversation-turn', {
  method: 'POST',
  headers: { ...(auth ? { Authorization: auth } : {}), 'content-type': 'application/json' },
  body: JSON.stringify(body),
}));

test('index: no or bad JWT is 401 before any RPC', async () => {
  rpcCalls.length = 0;
  assert.equal((await post(null, {})).status, 401);
  assert.equal((await post('Bearer nope', {})).status, 401);
  assert.equal(rpcCalls.length, 0);
});

test('index: flag off ⇒ 409, and the only call is the flag check (service role)', async () => {
  rpcCalls.length = 0;
  flagOn = false;
  const res = await post('Bearer good', { message: 'hi', clientMessageId: 'c-0001-abcd' });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'core_disabled' });
  assert.deepEqual(rpcCalls, [{ fn: 'conv_channel_enabled', args: { p_channel: 'website', p_user: USER }, key: 'service' }]);
});

test('index: entitlement is read with the customer token, and no access stops before ingest', async () => {
  rpcCalls.length = 0;
  flagOn = true;
  const res = await post('Bearer good', { message: 'hi', clientMessageId: 'c-0001-abcd' });
  assert.equal(res.status, 403);
  assert.deepEqual(rpcCalls.map((c) => [c.fn, c.key]), [['conv_channel_enabled', 'service'], ['sie_my_entitlement', 'anon']]);
});

test('index: the service role key is never sent to SIE', () => {
  const src = readFileSync(INDEX, 'utf8');
  const decideBlock = src.slice(src.indexOf('decide: async'), src.indexOf('commit: (args)'));
  assert.ok(decideBlock.includes('SIE_DECIDE_TOKEN') || decideBlock.includes('decideToken'));
  assert.ok(!/SERVICE_ROLE/.test(decideBlock), 'service role key in the SIE request');
});
