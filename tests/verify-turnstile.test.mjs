// Behavioural regression tests for supabase/functions/verify-turnstile.
//
// The function has zero imports, so it can be executed under Node with a
// small Deno shim + a stubbed fetch, exactly like verify-2fa. Everything
// it touches (fetch, FormData, AbortController, Deno.env, Deno.serve)
// exists natively in Node 22.
//
// Run: node --test tests/verify-turnstile.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// ── Harness ─────────────────────────────────────────────────────────────────
const env = { TURNSTILE_SECRET_KEY: 'test-secret' };
let scenario = {};
let lastSiteverify = null;

globalThis.Deno = {
  env: {
    get: (k) => env[k],
  },
  serve: (h) => {
    globalThis.__handler = h;
  },
};

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u === SITEVERIFY) {
    const form = init.body;
    lastSiteverify = {
      secret: String(form.get('secret') ?? ''),
      token: String(form.get('response') ?? ''),
    };
    const result = scenario.siteverify
      ? scenario.siteverify({ secret: lastSiteverify.secret, token: lastSiteverify.token })
      : { success: lastSiteverify.token === 'valid-token' };
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  throw new Error('unexpected fetch: ' + u);
};

await import('../supabase/functions/verify-turnstile/index.ts');
const handler = globalThis.__handler;
assert.ok(typeof handler === 'function', 'Deno.serve handler was registered');

function call(body, method = 'POST') {
  return handler(new Request('https://fn/verify-turnstile', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  }));
}

function reset(over = {}) {
  scenario = { ...over };
  lastSiteverify = null;
  env.TURNSTILE_SECRET_KEY = 'test-secret';
}

// ── The verification itself ─────────────────────────────────────────────────

test('valid token + configured secret verifies, and the server secret is sent', async () => {
  reset();
  const res = await call({ token: 'valid-token' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true, 'error-codes': [] });
  assert.equal(lastSiteverify?.secret, 'test-secret', 'the secret must come from the server env, never the client');
  assert.equal(lastSiteverify?.token, 'valid-token');
});

test('bad token is rejected with the Cloudflare error codes', async () => {
  reset({
    siteverify: () => ({ success: false, 'error-codes': ['invalid-input-response'] }),
  });
  const res = await call({ token: 'bad-token' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    success: false,
    'error-codes': ['invalid-input-response'],
  });
});

test('missing token is a 400 and never calls siteverify', async () => {
  reset();
  const res = await call({});
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'missing_token');
  assert.equal(lastSiteverify, null);
});

test('no secret configured is a distinct 503, so the login page can warn instead of dying', async () => {
  reset();
  delete env.TURNSTILE_SECRET_KEY;
  const res = await call({ token: 'valid-token' });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'secret_not_configured');
  assert.equal(lastSiteverify, null);
});

test('a wrong server secret fails closed (proves the secret is what counts)', async () => {
  reset({
    siteverify: () => ({ success: false, 'error-codes': ['invalid-input-secret'] }),
  });
  const res = await call({ token: 'valid-token' });
  assert.equal((await res.json()).success, false);
});

// ── Transport ───────────────────────────────────────────────────────────────

test('OPTIONS preflight answers with the CORS headers', async () => {
  const res = await handler(new Request('https://fn/verify-turnstile', { method: 'OPTIONS' }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});

test('GET is rejected with 405', async () => {
  const res = await call(null, 'GET');
  assert.equal(res.status, 405);
});

test('malformed JSON is a 400', async () => {
  const res = await handler(new Request('https://fn/verify-turnstile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_json');
});

// ── The login gate (turnstile-config.js) ────────────────────────────────────
// Regression for the 2026-11-24 incident: the function answered 503
// secret_not_configured, but supabase-js turns any non-2xx into a
// FunctionsHttpError, so the login page's `data?.error` check never ran
// and every login was blocked with a generic message. The gate must read
// the error body (error.context) and fail open ONLY for that one code.
import { after as _after } from 'node:test';

const gate = await import('../turnstile-config.js');

const _warn = console.warn;
const _error = console.error;
console.warn = () => {};
console.error = () => {};
_after(() => {
  console.warn = _warn;
  console.error = _error;
});

let currentToken = 'widget-token';
let resetCalls = 0;
let invokeCalls = 0;
let invokeBehaviour = null;
const toasts = [];

globalThis.window = {
  turnstile: {
    getResponse: () => currentToken,
    reset: () => { resetCalls++; },
  },
};

const stubSupabase = {
  functions: {
    invoke: async () => {
      invokeCalls++;
      if (typeof invokeBehaviour === 'function') return invokeBehaviour();
      throw new Error('invoke stub not configured');
    },
  },
};

function gateCall(over = {}) {
  return gate.verifyTurnstileBeforeLogin({
    supabase: stubSupabase,
    withTimeout: (p) => p,
    showToast: (msg) => { toasts.push(msg); },
    tokenTimeoutMs: 30,
    ...over,
  });
}

function resetGate(over = {}) {
  currentToken = 'widget-token';
  resetCalls = 0;
  invokeCalls = 0;
  toasts.length = 0;
  invokeBehaviour = over.invokeBehaviour ?? null;
  if (over.token !== undefined) currentToken = over.token;
  if (over.noWidget) delete globalThis.window.turnstile;
  else globalThis.window.turnstile = { getResponse: () => currentToken, reset: () => { resetCalls++; } };
}

function httpError(body, status = 503) {
  return {
    message: 'Edge Function returned a non-2xx status code',
    context: new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  };
}

test('gate: successful verification lets the login proceed', async () => {
  resetGate({ invokeBehaviour: async () => ({ data: { success: true }, error: null }) });
  assert.equal(await gateCall(), true);
  assert.equal(invokeCalls, 1);
  assert.equal(resetCalls, 0);
});

test('gate: 503 secret_not_configured (Response context) warns and proceeds — the incident case', async () => {
  resetGate({
    invokeBehaviour: async () => ({
      data: null,
      error: httpError({ success: false, error: 'secret_not_configured' }, 503),
    }),
  });
  assert.equal(await gateCall(), true, 'missing server secret must not lock everyone out');
  assert.ok(toasts.some((m) => m.includes('غير مفعّل')), 'a visible warning must be shown');
  assert.equal(resetCalls, 0, 'the token was never consumed by Cloudflare');
});

test('gate: secret_not_configured as an already-parsed context object also proceeds', async () => {
  resetGate({
    invokeBehaviour: async () => ({
      data: null,
      error: { message: 'non-2xx', context: { error: 'secret_not_configured' } },
    }),
  });
  assert.equal(await gateCall(), true);
});

test('gate: any other verification failure blocks the login and resets the widget', async () => {
  resetGate({ invokeBehaviour: async () => ({ data: { success: false }, error: null }) });
  assert.equal(await gateCall(), false);
  assert.equal(resetCalls, 1);
});

test('gate: a non-2xx with a different error code blocks the login', async () => {
  resetGate({
    invokeBehaviour: async () => ({
      data: null,
      error: httpError({ success: false, 'error-codes': ['invalid-input-response'] }, 200),
    }),
  });
  assert.equal(await gateCall(), false);
  assert.equal(resetCalls, 1);
});

test('gate: no token yet means no invoke call at all', async () => {
  resetGate({ token: '' });
  assert.equal(await gateCall(), false);
  assert.equal(invokeCalls, 0);
});

test('gate: Turnstile script not loaded blocks with a reload hint, no invoke', async () => {
  resetGate({ noWidget: true });
  assert.equal(await gateCall(), false);
  assert.ok(toasts.some((m) => m.includes('أعد تحميل الصفحة')));
  assert.equal(invokeCalls, 0);
});

test('gate: an invoke that throws (network) blocks and resets', async () => {
  resetGate({
    invokeBehaviour: async () => { throw new Error('network down'); },
  });
  assert.equal(await gateCall(), false);
  assert.equal(resetCalls, 1);
});

test('readFunctionErrorCode: Response, parsed object, string, and unreadable bodies', async () => {
  assert.equal(
    await gate.readFunctionErrorCode({ context: new Response(JSON.stringify({ error: 'missing_token' }), { status: 400 }) }),
    'missing_token',
  );
  assert.equal(await gate.readFunctionErrorCode({ context: { error: 'x' } }), 'x');
  assert.equal(await gate.readFunctionErrorCode({ context: '{"error":"y"}' }), 'y');
  assert.equal(await gate.readFunctionErrorCode({ context: new Response('not json', { status: 500 }) }), null);
  assert.equal(await gate.readFunctionErrorCode({}), null);
  assert.equal(await gate.readFunctionErrorCode(null), null);
});
