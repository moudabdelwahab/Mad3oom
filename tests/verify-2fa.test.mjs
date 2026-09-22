// Behavioural regression tests for supabase/functions/verify-2fa.
//
// verify-2fa is the one changed Edge Function with zero imports, so it can be
// executed under Node with a small Deno shim + a stubbed fetch. Everything the
// function touches (crypto.subtle, fetch, atob/btoa) exists natively in Node 22.
//
// Run: node --test tests/
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const SUPABASE_URL = 'https://stub.supabase.co';
const USER_ID = '11111111-1111-4111-8111-111111111111';

// Two distinct, valid base32 secrets.
const STORED_SECRET   = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const ATTACKER_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

function base32Decode(b32) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of b32.replace(/=+$/, '').toUpperCase()) {
    const v = A.indexOf(c);
    if (v !== -1) bits += v.toString(2).padStart(5, '0');
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

// Independent TOTP implementation, so the test does not borrow the code under test.
function totp(secretB32, counter = Math.floor(Date.now() / 1000 / 30)) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter % 0x100000000, 4);
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
  return String(bin % 1000000).padStart(6, '0');
}

// ── Harness ─────────────────────────────────────────────────────────────────
let scenario;

globalThis.Deno = {
  env: {
    get: (k) => ({
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-stub',
    })[k],
  },
  serve: (h) => { globalThis.__handler = h; },
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const json = (body, ok = true) =>
    ({ ok, status: ok ? 200 : 401, json: async () => body });

  if (u.includes('/auth/v1/user')) {
    return scenario.authOk === false ? json({}, false) : json({ id: USER_ID });
  }
  if (u.includes('/rest/v1/user_mfa_secrets')) {
    assert.ok(u.includes(`user_id=eq.${USER_ID}`), 'private lookup must filter by the authenticated user id');
    if ((init.method || 'GET') === 'PATCH') {
      assert.match(init.headers.Authorization, /service-role-stub/);
      scenario.privatePatch = JSON.parse(init.body);
      return json({});
    }
    return json(scenario.privateRow ? [scenario.privateRow] : []);
  }
  if (u.includes('/rest/v1/profiles')) {
    // The function must scope the lookup to the authenticated user.
    assert.ok(u.includes(`id=eq.${USER_ID}`), 'profile lookup must filter by the authenticated user id');
    if ((init.method || 'GET') === 'PATCH') {
      scenario.profilePatch = JSON.parse(init.body);
      return json({});
    }
    return json([{ two_factor_secret: scenario.storedSecret, two_factor_enabled: !!scenario.storedSecret,
                   recovery_codes: scenario.legacyCodes || null }]);
  }
  if (u.includes('/rest/v1/twofa_rate_limits')) {
    if ((init.method || 'GET') === 'GET') return json(scenario.rateLimitRow ? [scenario.rateLimitRow] : []);
    scenario.upserts.push(JSON.parse(init.body));
    return json({});
  }
  throw new Error('unexpected fetch: ' + u);
};

await import('../supabase/functions/verify-2fa/index.ts');
const handler = globalThis.__handler;
assert.ok(typeof handler === 'function', 'Deno.serve handler was registered');

function call(body, headers = { authorization: 'Bearer stub-jwt' }) {
  return handler(new Request('https://fn/verify-2fa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }));
}

function reset(over = {}) {
  scenario = { storedSecret: null, privateRow: null, rateLimitRow: null, upserts: [], ...over };
}

// ── The fix ─────────────────────────────────────────────────────────────────

test('enrolled user: a caller-supplied secret is ignored (the reported defect)', async () => {
  reset({ storedSecret: STORED_SECRET });
  // Attacker knows a valid code for a secret THEY chose. Before the fix this
  // returned {verified:true} unconditionally.
  const res = await call({ code: totp(ATTACKER_SECRET), tempSecret: ATTACKER_SECRET });
  assert.equal((await res.json()).verified, false);
});

test('enrolled user: a code from the STORED secret verifies', async () => {
  reset({ storedSecret: STORED_SECRET });
  const res = await call({ code: totp(STORED_SECRET), tempSecret: ATTACKER_SECRET });
  assert.equal((await res.json()).verified, true, 'stored secret is the one that counts');
});

test('enrolled user: body secret omitted entirely still verifies', async () => {
  reset({ storedSecret: STORED_SECRET });
  const res = await call({ code: totp(STORED_SECRET) });
  assert.equal((await res.json()).verified, true, 'the body secret is not required at all');
});

test('enrolled user: a wrong code is still rejected', async () => {
  reset({ storedSecret: STORED_SECRET });
  const res = await call({ code: '000000', tempSecret: STORED_SECRET });
  assert.equal((await res.json()).verified, false);
});

// ── Enrollment must keep working ────────────────────────────────────────────

test('enrollment: no stored secret yet, the client-held secret is accepted', async () => {
  reset({ storedSecret: null });
  const res = await call({ code: totp(STORED_SECRET), tempSecret: STORED_SECRET });
  const body = await res.json();
  assert.equal(body.verified, true, 'customer-settings-modal.js enrollment must not break');
  assert.equal(body.enrollment, true);
});

test('enrollment: wrong code is rejected', async () => {
  reset({ storedSecret: null });
  const res = await call({ code: '000000', tempSecret: STORED_SECRET });
  assert.equal((await res.json()).verified, false);
});

test('enrollment: neither stored nor supplied secret is a 400, not a crash', async () => {
  reset({ storedSecret: null });
  const res = await call({ code: '123456' });
  assert.equal(res.status, 400);
});

// ── Auth + rate limiting must be preserved ──────────────────────────────────

test('unauthenticated callers are rejected before any secret lookup', async () => {
  reset({ storedSecret: STORED_SECRET, authOk: false });
  const res = await call({ code: totp(STORED_SECRET) });
  assert.equal(res.status, 401);
});

test('missing Authorization header is rejected', async () => {
  reset({ storedSecret: STORED_SECRET });
  const res = await call({ code: totp(STORED_SECRET) }, {});
  assert.equal(res.status, 401);
});

test('a missing code is rejected', async () => {
  reset({ storedSecret: STORED_SECRET });
  const res = await call({ tempSecret: STORED_SECRET });
  assert.equal(res.status, 400);
});

test('an active lockout still returns 429', async () => {
  reset({
    storedSecret: STORED_SECRET,
    rateLimitRow: {
      failed_attempts: 5,
      window_start: new Date().toISOString(),
      locked_until: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    },
  });
  const res = await call({ code: totp(STORED_SECRET) });
  assert.equal(res.status, 429, 'existing rate limiting is preserved');
  assert.equal((await res.json()).error, 'too_many_attempts');
});

test('a failed attempt still increments the counter, and locks at the 5th', async () => {
  reset({
    storedSecret: STORED_SECRET,
    rateLimitRow: { failed_attempts: 4, window_start: new Date().toISOString(), locked_until: null },
  });
  await call({ code: '000000' });
  assert.equal(scenario.upserts.length, 1);
  assert.equal(scenario.upserts[0].failed_attempts, 5);
  assert.ok(scenario.upserts[0].locked_until, 'lockout is applied on the 5th failure');
});

test('a success still clears the counter', async () => {
  reset({
    storedSecret: STORED_SECRET,
    rateLimitRow: { failed_attempts: 3, window_start: new Date().toISOString(), locked_until: null },
  });
  await call({ code: totp(STORED_SECRET) });
  assert.equal(scenario.upserts[0].failed_attempts, 0);
  assert.equal(scenario.upserts[0].locked_until, null);
});

// Restore in an `after` hook, not at module scope: module-body statements run
// as soon as the tests are *registered*, which would hand the real fetch back
// before a single test had actually executed.
after(() => { globalThis.fetch = realFetch; });

// ── Migration 049 + PS-16: recovery codes at login ─────────────────────────

const sha256 = (c) => crypto.createHash('sha256').update(String(c).trim().toUpperCase()).digest('hex');

test('049: an enrolled secret in user_mfa_secrets is the one verified', async () => {
  reset({ privateRow: { totp_secret: STORED_SECRET, recovery_code_hashes: [] } });
  const body = await (await call({ code: totp(STORED_SECRET), tempSecret: ATTACKER_SECRET })).json();
  assert.equal(body.verified, true);
  assert.equal(body.enrollment, undefined, 'a private-table secret means enrolled, not enrollment');
  reset({ privateRow: { totp_secret: STORED_SECRET, recovery_code_hashes: [] } });
  assert.equal((await (await call({ code: totp(ATTACKER_SECRET), tempSecret: ATTACKER_SECRET })).json()).verified, false);
});

test('PS-16: a valid recovery code signs in once and is consumed', async () => {
  reset({ privateRow: { totp_secret: STORED_SECRET, recovery_code_hashes: [sha256('AAAA111111'), sha256('BBBB222222')] } });
  const body = await (await call({ recoveryCode: ' aaaa111111 ' })).json();
  assert.equal(body.verified, true);
  assert.equal(body.usedRecoveryCode, true);
  assert.equal(body.remainingRecoveryCodes, 1);
  assert.deepEqual(scenario.privatePatch.recovery_code_hashes, [sha256('BBBB222222')]);
});

test('PS-16: a wrong recovery code fails and counts as an attempt', async () => {
  reset({ privateRow: { totp_secret: STORED_SECRET, recovery_code_hashes: [sha256('AAAA111111')] } });
  const body = await (await call({ recoveryCode: 'ZZZZ999999' })).json();
  assert.equal(body.verified, false);
  assert.equal(scenario.privatePatch, undefined, 'nothing consumed');
  assert.equal(scenario.upserts[0].failed_attempts, 1);
});

test('PS-16: a recovery code is refused during a lockout', async () => {
  reset({ privateRow: { totp_secret: STORED_SECRET, recovery_code_hashes: [sha256('AAAA111111')] },
          rateLimitRow: { failed_attempts: 5, window_start: new Date().toISOString(),
                          locked_until: new Date(Date.now() + 600000).toISOString() } });
  assert.equal((await call({ recoveryCode: 'AAAA111111' })).status, 429);
});

test('PS-16: a recovery code means nothing for an account without 2FA', async () => {
  reset();
  assert.equal((await call({ recoveryCode: 'AAAA111111' })).status, 400);
});

test('PS-16: legacy plaintext codes (before 049) are consumed from profiles', async () => {
  reset({ storedSecret: STORED_SECRET, legacyCodes: ['AAAA111111', 'BBBB222222'] });
  const body = await (await call({ recoveryCode: 'bbbb222222' })).json();
  assert.equal(body.verified, true);
  assert.deepEqual(scenario.profilePatch, { recovery_codes: ['AAAA111111'] });
});
