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
