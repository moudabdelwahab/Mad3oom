// Behavioural tests for supabase/functions/ban-user.
//
// The real handler runs here: the TypeScript is stripped with node:module,
// the jsr import is swapped for an in-memory Supabase double, and Deno.serve
// hands us the handler. What it does to profiles / auth is asserted on the
// double's state.
//
// The bugs/decisions this pins:
//   • The old admin UI wrote profiles.ban_status directly (PostgREST) and
//     never touched Auth: the banned user kept their session and their
//     auth.users.banned_until stayed empty.
//   • There is NO Admin API endpoint to sign out another user by id
//     (verified against the GoTrue OpenAPI: no /admin/users/{id}/signout;
//     admin signOut takes a JWT, not a user id). The function must NOT
//     fake a global sign-out call — revocation is ban_duration
//     (blocks sign-in + refresh) + the RLS gate (144) for immediate
//     enforcement — and the response must say sessions.revoked=false
//     instead of lying about it.
//   • The platform owner can never be banned through this function, and
//     nobody can ban themselves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const SRC = new URL('../supabase/functions/ban-user/index.ts', import.meta.url);
const RAW = readFileSync(SRC, 'utf8');

let db;      // { profiles: [], platform_authority: [] }
let calls;   // { updateUserById: [], signOut: [] }
let caller;  // { id, isOwner, criticalOk, banOk } | null
let failAuthUpdate; // Error message to simulate updateUserById failure, or null

function builder(table) {
  const q = { table, filters: [], patch: null, single: false };
  const rows = () => db[table].filter((r) => q.filters.every((f) => f(r)));
  const run = () => {
    if (q.patch) {
      const found = rows();
      for (const r of found) Object.assign(r, q.patch);
      return { data: found.map((r) => ({ id: r.id })), error: null };
    }
    const found = rows();
    if (q.single) return { data: found[0] ? { ...found[0] } : null, error: null };
    return { data: found.map((r) => ({ ...r })), error: null };
  };
  const api = {
    select() { return api; },
    update(patch) { q.patch = patch; return api; },
    eq(col, val) { q.filters.push((r) => r[col] === val); return api; },
    maybeSingle() { q.single = true; return Promise.resolve(run()); },
    then(res, rej) { return Promise.resolve(run()).then(res, rej); },
  };
  return api;
}

function createClient(_url, key) {
  const isService = key === 'service-role-stub';
  return {
    from: (t) => builder(t),
    rpc: async (fn, params) => {
      if (fn === 'is_platform_owner') return { data: caller?.isOwner ?? false, error: null };
      if (fn === 'owner_critical_ok') return { data: caller?.criticalOk ?? false, error: null };
      if (fn === 'staff_write_ok') {
        assert.equal(params?.p_permission, 'users.ban');
        if (caller?.banOk === false) return { data: null, error: { message: 'permission denied' } };
        return { data: true, error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
    auth: {
      getUser: async () =>
        (caller
          ? { data: { user: { id: caller.id } }, error: null }
          : { data: null, error: { message: 'no session' } }),
      admin: {
        updateUserById: async (userId, attrs) => {
          calls.updateUserById.push({ userId, attrs });
          if (failAuthUpdate) return { data: null, error: { message: failAuthUpdate } };
          return { data: { user: { id: userId } }, error: null };
        },
        // Present only to catch a fake global sign-out call: the function
        // must never invoke it (it takes a JWT, not a user id).
        signOut: async (...args) => {
          calls.signOut.push(args);
          return { error: null };
        },
      },
    },
  };
}

globalThis.__createClient = createClient;
globalThis.Deno = {
  env: { get: (k) => ({ SUPABASE_URL: 'https://stub.supabase.co', SUPABASE_ANON_KEY: 'anon-stub', SUPABASE_SERVICE_ROLE_KEY: 'service-role-stub' })[k] },
  serve: (h) => { globalThis.__handler = h; },
};

const ts = RAW
  .replace(/^import "jsr:@supabase\/functions-js[^\n]*\n/m, '')
  .replace(/^import \{ createClient \} from "jsr:@supabase\/supabase-js@2";\n/m, 'const createClient = globalThis.__createClient;\n');
assert.ok(ts.includes('globalThis.__createClient'), 'the supabase import must be swappable');
await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(ts)));
const handler = globalThis.__handler;

async function call(body, { auth = true, method = 'POST' } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth) headers.Authorization = 'Bearer caller';
  const res = await handler(new Request('https://x/ban-user', {
    method,
    headers,
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  }));
  return { status: res.status, body: await res.json() };
}

function reset() {
  calls = { updateUserById: [], signOut: [] };
  failAuthUpdate = null;
  caller = { id: 'admin-1', isOwner: false, criticalOk: false, banOk: true };
  db = {
    profiles: [
      { id: 'owner-1', email: 'mahmoud@mad3oom.com', role: 'platform_owner', ban_status: 'none', ban_until: null, ban_reason: null },
      { id: 'admin-1', email: 'admin@mad3oom.com', role: 'admin', ban_status: 'none', ban_until: null, ban_reason: null },
      { id: 'support-1', email: 'support@mad3oom.com', role: 'support', ban_status: 'none', ban_until: null, ban_reason: null },
      { id: 'cust-1', email: 'cust@gmail.com', role: 'user', ban_status: 'none', ban_until: null, ban_reason: null },
    ],
    platform_authority: [{ user_id: 'owner-1', level: 'owner' }],
  };
}

test('الحظر الدائم: profiles + banned_until في Auth (10 سنوات) — وبلا نداء signOut وهمي', async () => {
  reset();
  const { status, body } = await call({ user_id: 'cust-1', action: 'ban', reason: 'إساءة متكررة' });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.ban_status, 'permanent');
  assert.equal(body.ban_until, null);
  assert.equal(body.auth_ban_applied, true);
  assert.equal(body.auth_error, null);
  assert.equal(body.sessions.revoked, false, 'no admin sign-out-by-id endpoint exists — must not claim revocation');
  assert.equal(body.sessions.reason, 'no_admin_signout_endpoint');
  assert.ok(body.sessions.note);

  const p = db.profiles.find((x) => x.id === 'cust-1');
  assert.equal(p.ban_status, 'permanent');
  assert.equal(p.ban_until, null);
  assert.equal(p.ban_reason, 'إساءة متكررة');

  assert.equal(calls.updateUserById.length, 1);
  assert.equal(calls.updateUserById[0].userId, 'cust-1');
  assert.equal(calls.updateUserById[0].attrs.ban_duration, '87600h');
  assert.equal(calls.signOut.length, 0, 'admin signOut takes a JWT, not a user id — never call it');
});

test('الحظر المؤقت: ban_until تُحفظ وban_duration ساعات حتى نهايتها', async () => {
  reset();
  const until = new Date(Date.now() + 50 * 3_600_000).toISOString();
  const { status, body } = await call({ user_id: 'cust-1', action: 'ban', reason: 'مخالفة مؤقتة', ban_until: until });
  assert.equal(status, 200);
  assert.equal(body.ban_status, 'temporary');
  assert.equal(body.ban_until, until);
  const p = db.profiles.find((x) => x.id === 'cust-1');
  assert.equal(p.ban_status, 'temporary');
  assert.equal(p.ban_until, until);
  const hours = Number(calls.updateUserById[0].attrs.ban_duration.replace('h', ''));
  assert.ok(hours >= 49 && hours <= 50, `ban_duration ${hours}h should cover ~50h`);
  assert.equal(calls.signOut.length, 0);
});

test('رفع الحظر: profiles تُصفَّر وban_duration تصبح none', async () => {
  reset();
  db.profiles.find((x) => x.id === 'cust-1').ban_status = 'permanent';
  db.profiles.find((x) => x.id === 'cust-1').ban_reason = 'إساءة متكررة';
  const { status, body } = await call({ user_id: 'cust-1', action: 'unban' });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.ban_status, 'none');
  const p = db.profiles.find((x) => x.id === 'cust-1');
  assert.equal(p.ban_status, 'none');
  assert.equal(p.ban_until, null);
  assert.equal(p.ban_reason, null);
  assert.equal(calls.updateUserById[0].attrs.ban_duration, 'none');
});

test('بلا Authorization → 401؛ وعميل عادي → 403 بلا أي كتابة', async () => {
  reset();
  assert.equal((await call({ user_id: 'cust-1', action: 'ban', reason: 'إساءة متكررة' }, { auth: false })).status, 401);

  reset();
  caller = { id: 'cust-1', isOwner: false, criticalOk: false, banOk: true };
  const { status } = await call({ user_id: 'admin-1', action: 'ban', reason: 'إساءة متكررة' });
  assert.equal(status, 403);
  assert.equal(calls.updateUserById.length, 0);
  assert.equal(db.profiles.find((x) => x.id === 'admin-1').ban_status, 'none');
});

test('فريق بلا صلاحية users.ban → 403؛ ومالك بلا تحقّق بخطوتين حديث → 403', async () => {
  reset();
  caller = { id: 'support-1', isOwner: false, criticalOk: false, banOk: false };
  assert.equal((await call({ user_id: 'cust-1', action: 'ban', reason: 'إساءة متكررة' })).status, 403);

  reset();
  caller = { id: 'owner-1', isOwner: true, criticalOk: false, banOk: true };
  assert.equal((await call({ user_id: 'cust-1', action: 'ban', reason: 'إساءة متكررة' })).status, 403);
  assert.equal(calls.updateUserById.length, 0);
});

test('مالك بتحقّق بخطوتين حديث يحظر؛ وحظر الذات مرفوض؛ وحظر المالك مرفوض دائمًا', async () => {
  reset();
  caller = { id: 'owner-1', isOwner: true, criticalOk: true, banOk: true };
  assert.equal((await call({ user_id: 'cust-1', action: 'ban', reason: 'إساءة متكررة' })).status, 200);

  reset();
  caller = { id: 'owner-1', isOwner: true, criticalOk: true, banOk: true };
  const self = await call({ user_id: 'owner-1', action: 'ban', reason: 'إساءة متكررة' });
  assert.equal(self.status, 403);

  reset();
  const banOwner = await call({ user_id: 'owner-1', action: 'ban', reason: 'إساءة متكررة' });
  assert.equal(banOwner.status, 403);
  assert.equal(db.profiles.find((x) => x.id === 'owner-1').ban_status, 'none');
  assert.equal(calls.updateUserById.length, 0);
});

test('التحقق من المدخلات: سبب قصير، وتاريخ ماضٍ، وهدف غير موجود، وaction غير صالح', async () => {
  reset();
  assert.equal((await call({ user_id: 'cust-1', action: 'ban', reason: 'سيئ' })).status, 400);
  assert.equal((await call({ user_id: 'cust-1', action: 'ban' })).status, 400);
  assert.equal((await call({ user_id: 'cust-1', action: 'ban', reason: 'إساءة متكررة', ban_until: new Date(Date.now() - 1000).toISOString() })).status, 400);
  assert.equal((await call({ user_id: 'cust-1', action: 'ban', reason: 'إساءة متكررة', ban_until: 'ليس تاريخًا' })).status, 400);
  assert.equal((await call({ user_id: 'cust-1', action: 'freeze', reason: 'إساءة متكررة' })).status, 400);
  assert.equal((await call({ user_id: 'ghost-1', action: 'ban', reason: 'إساءة متكررة' })).status, 404);
  assert.equal(db.profiles.find((x) => x.id === 'cust-1').ban_status, 'none');
  assert.equal(calls.updateUserById.length, 0);
});

test('فشل Auth لا يخفيه نجاح profiles: auth_ban_applied=false مع الخطأ', async () => {
  reset();
  failAuthUpdate = 'Auth unavailable';
  const { status, body } = await call({ user_id: 'cust-1', action: 'ban', reason: 'إساءة متكررة' });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.auth_ban_applied, false);
  assert.equal(body.auth_error, 'Auth unavailable');
  assert.equal(db.profiles.find((x) => x.id === 'cust-1').ban_status, 'permanent');
});

test('ثوابت المصدر: ban_duration عبر updateUserById، ولا نداء signOut بمعرّف مستخدم', () => {
  assert.ok(RAW.includes('updateUserById'), 'Auth ban must go through updateUserById');
  assert.ok(RAW.includes('ban_duration'), 'ban_duration must be set on the Auth user');
  assert.ok(!RAW.includes('.auth.admin.signOut('), 'no admin signOut call with a user id — it takes a JWT');
  assert.ok(RAW.includes('87600h'), 'permanent ban must map to a documented long duration');
  assert.ok(RAW.includes("ban_duration: 'none'") || RAW.includes('ban_duration: "none"') || RAW.includes("ban_duration: banDuration"), 'unban must clear the Auth ban');
});
