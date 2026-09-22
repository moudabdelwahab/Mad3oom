// Behavioural tests for supabase/functions/disable-2fa.
//
// This is the sanctioned way past the enforce_2fa_change_requires_challenge
// trigger, so what it accepts IS the security boundary. Like verify-2fa it has
// no imports, so the real handler runs here under a Deno shim.
//
// The DIRECT bypass (PATCH profiles through PostgREST) is covered separately
// and for real in tests/sql/2fa-trigger.test.sql, against a live Postgres.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const SUPABASE_URL = 'https://stub.supabase.co';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const OTHER_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

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
function totp(secretB32, counter = Math.floor(Date.now() / 1000 / 30)) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter % 0x100000000, 4);
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const o = h[h.length - 1] & 0x0f;
  const bin = ((h[o] & 0x7f) << 24) | ((h[o + 1] & 0xff) << 16) | ((h[o + 2] & 0xff) << 8) | (h[o + 3] & 0xff);
  return String(bin % 1000000).padStart(6, '0');
}

let scenario;
globalThis.Deno = {
  env: { get: (k) => ({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: 'service-role-stub' })[k] },
  serve: (h) => { globalThis.__handler = h; },
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const json = (body, ok = true) => ({ ok, status: ok ? 200 : 401, json: async () => body });

  if (u.includes('/auth/v1/user')) {
    return scenario.authOk === false ? json({}, false) : json({ id: USER_ID });
  }
  if (u.includes('/rest/v1/profiles')) {
    if ((init.method || 'GET') === 'GET') {
      assert.ok(u.includes(`id=eq.${USER_ID}`), 'profile lookup must be scoped to the caller');
      return json([{
        two_factor_enabled: scenario.enabled,
        two_factor_secret: scenario.secret,
        recovery_codes: scenario.recoveryCodes,
      }]);
    }
    assert.equal(init.method, 'PATCH');
    assert.match(u, new RegExp(`id=eq\\.${USER_ID}`), 'the clear must target only the caller');
    // Only the service-role key may perform the clear — that is what the
    // trigger's auth.uid() IS NULL exemption relies on.
    assert.match(init.headers.Authorization, /service-role-stub/);
    scenario.cleared = JSON.parse(init.body);
    return json({});
  }
  if (u.includes('/rest/v1/user_mfa_secrets')) {
    // Migration 049: the secret lives here. `privateRow` null models either
    // "no row" or "table not created yet" (pre-migration deploy order).
    assert.ok(u.includes(`user_id=eq.${USER_ID}`), 'private lookup must be scoped to the caller');
    if (scenario.privateMissingTable) return { ok: false, status: 404, json: async () => ({}) };
    return json(scenario.privateRow ? [scenario.privateRow] : []);
  }
  if (u.includes('/rest/v1/twofa_rate_limits')) {
    if ((init.method || 'GET') === 'GET') return json(scenario.rateLimitRow ? [scenario.rateLimitRow] : []);
    scenario.upserts.push(JSON.parse(init.body));
    return json({});
  }
  throw new Error('unexpected fetch: ' + u);
};

await import('../supabase/functions/disable-2fa/index.ts');
const handler = globalThis.__handler;

function call(body, headers = { authorization: 'Bearer stub-jwt' }) {
  return handler(new Request('https://fn/disable-2fa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }));
}
function reset(over = {}) {
  scenario = {
    enabled: true, secret: SECRET, recoveryCodes: ['AAAA111111', 'BBBB222222'],
    rateLimitRow: null, upserts: [], cleared: null, privateRow: null, ...over,
  };
}

// ── The attacker: valid session, no second factor ───────────────────────────

test('attacker with a session but no code cannot disable 2FA', async () => {
  reset();
  const res = await call({});
  assert.equal(res.status, 400);
  assert.equal(scenario.cleared, null, '2FA must not be cleared');
});

test('attacker guessing a code cannot disable 2FA', async () => {
  reset();
  const res = await call({ code: '000000' });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'invalid_code');
  assert.equal(scenario.cleared, null);
});

test('a code from a secret the attacker chose is rejected', async () => {
  reset();
  const res = await call({ code: totp(OTHER_SECRET) });
  assert.equal(res.status, 401);
  assert.equal(scenario.cleared, null);
});

test('a wrong recovery code is rejected', async () => {
  reset();
  const res = await call({ recoveryCode: 'ZZZZ999999' });
  assert.equal(res.status, 401);
  assert.equal(scenario.cleared, null);
});

test('an unauthenticated caller is rejected before any lookup', async () => {
  reset({ authOk: false });
  const res = await call({ code: totp(SECRET) });
  assert.equal(res.status, 401);
  assert.equal(scenario.cleared, null);
});

test('repeated failures lock the account out', async () => {
  reset({ rateLimitRow: { failed_attempts: 4, window_start: new Date().toISOString(), locked_until: null } });
  await call({ code: '000000' });
  assert.equal(scenario.upserts[0].failed_attempts, 5);
  assert.ok(scenario.upserts[0].locked_until, 'lockout applied');

  reset({ rateLimitRow: { failed_attempts: 5, window_start: new Date().toISOString(),
                          locked_until: new Date(Date.now() + 600000).toISOString() } });
  const res = await call({ code: totp(SECRET) });
  assert.equal(res.status, 429, 'a correct code during lockout is still refused');
  assert.equal(scenario.cleared, null);
});

// ── The legitimate owner ────────────────────────────────────────────────────

test('the owner with a current authenticator code can disable 2FA', async () => {
  reset();
  const res = await call({ code: totp(SECRET) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).disabled, true);
  assert.deepEqual(scenario.cleared,
    { two_factor_enabled: false, two_factor_secret: null, recovery_codes: null });
});

test('the owner who lost the authenticator can use a recovery code', async () => {
  reset();
  const res = await call({ recoveryCode: 'bbbb222222' }); // case-insensitive
  assert.equal(res.status, 200);
  assert.equal((await res.json()).disabled, true);
  assert.ok(scenario.cleared);
});

test('a code from the previous 30s window still works (clock skew)', async () => {
  reset();
  const prev = totp(SECRET, Math.floor(Date.now() / 1000 / 30) - 1);
  assert.equal((await (await call({ code: prev })).json()).disabled, true);
});

test('disabling is idempotent when 2FA is already off', async () => {
  reset({ enabled: false, secret: null });
  const res = await call({ code: '000000' });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.disabled, true);
  assert.equal(body.alreadyDisabled, true);
});

test('a success resets the failure counter', async () => {
  reset({ rateLimitRow: { failed_attempts: 3, window_start: new Date().toISOString(), locked_until: null } });
  await call({ code: totp(SECRET) });
  const last = scenario.upserts[scenario.upserts.length - 1];
  assert.equal(last.failed_attempts, 0);
  assert.equal(last.locked_until, null);
});

// ── Migration 049: secret in user_mfa_secrets, profiles columns NULL ───────

const sha256 = (c) => crypto.createHash('sha256').update(String(c).trim().toUpperCase()).digest('hex');

test('049: the secret is read from user_mfa_secrets when profiles holds none', async () => {
  reset({ secret: null, recoveryCodes: null,
          privateRow: { totp_secret: SECRET, recovery_code_hashes: [sha256('AAAA111111')] } });
  const res = await call({ code: totp(SECRET) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).disabled, true);
});

test('049: a recovery code is matched by its hash', async () => {
  reset({ secret: null, recoveryCodes: null,
          privateRow: { totp_secret: SECRET, recovery_code_hashes: [sha256('AAAA111111')] } });
  assert.equal((await (await call({ recoveryCode: 'aaaa111111' })).json()).disabled, true);
  reset({ secret: null, recoveryCodes: null,
          privateRow: { totp_secret: SECRET, recovery_code_hashes: [sha256('AAAA111111')] } });
  assert.equal((await call({ recoveryCode: sha256('AAAA111111') })).status, 401,
    'the stored hash itself is not a valid recovery code');
});

test('049: a code from an attacker-chosen secret is still rejected', async () => {
  reset({ secret: null, recoveryCodes: null, privateRow: { totp_secret: SECRET, recovery_code_hashes: [] } });
  assert.equal((await call({ code: totp(OTHER_SECRET) })).status, 401);
  assert.equal(scenario.cleared, null);
});

test('deploy-before-migration: a missing user_mfa_secrets table falls back to profiles', async () => {
  reset({ privateMissingTable: true });
  assert.equal((await (await call({ code: totp(SECRET) })).json()).disabled, true);
});

after(() => { globalThis.fetch = realFetch; });
