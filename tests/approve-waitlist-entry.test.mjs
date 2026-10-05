// Behavioural tests for supabase/functions/approve-waitlist-entry.
//
// The real handler runs here: the TypeScript is stripped with node:module,
// the jsr import is swapped for an in-memory Supabase double, and Deno.serve
// hands us the handler. What it does to waitlist_entries / profiles / auth is
// asserted on the double's state.
//
// The bug this pins: an entry already linked to an account (Google/GitHub
// signup, added by migration 066) was answered "already approved" without
// ever flipping its status, so the customer stayed behind the gate forever.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const SRC = new URL('../supabase/functions/approve-waitlist-entry/index.ts', import.meta.url);

let db;          // { profiles: [], waitlist_entries: [] }
let calls;       // { createUser: [] }
let caller;      // { id, role, isAdmin }

function builder(table) {
  const q = { table, filters: [], patch: null, single: false };
  const rows = () => db[table].filter(r => q.filters.every(f => f(r)));
  const run = () => {
    if (q.patch) {
      for (const r of rows()) Object.assign(r, q.patch);
      return { data: null, error: null };
    }
    const found = rows();
    if (q.single) return { data: found[0] ? { ...found[0] } : null, error: null };
    return { data: found.map(r => ({ ...r })), error: null };
  };
  const api = {
    select() { return api; },
    update(patch) { q.patch = patch; return api; },
    eq(col, val) { q.filters.push(r => r[col] === val); return api; },
    is(col, val) { q.filters.push(r => (r[col] ?? null) === val); return api; },
    ilike(col, val) { q.filters.push(r => String(r[col] ?? '').toLowerCase() === String(val).toLowerCase()); return api; },
    maybeSingle() { q.single = true; return Promise.resolve(run()); },
    then(res, rej) { return Promise.resolve(run()).then(res, rej); },
  };
  return api;
}

function createClient(_url, key) {
  const isService = key === 'service-role-stub';
  return {
    from: (t) => builder(t),
    rpc: async (fn) => {
      assert.equal(fn, 'is_admin');
      assert.ok(!isService, 'is_admin must be evaluated as the caller, not the service role');
      return { data: caller.isAdmin, error: null };
    },
    auth: {
      getUser: async () => (caller ? { data: { user: { id: caller.id } }, error: null } : { data: null, error: { message: 'no' } }),
      admin: {
        createUser: async (args) => {
          calls.createUser.push(args);
          if (db.profiles.some(p => p.email === args.email)) {
            return { data: { user: null }, error: { message: 'A user with this email address has already been registered' } };
          }
          const id = `new-${calls.createUser.length}`;
          db.profiles.push({ id, email: args.email, full_name: null, role: 'user' });
          return { data: { user: { id } }, error: null };
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

const ts = readFileSync(SRC, 'utf8')
  .replace(/^import "jsr:@supabase\/functions-js[^\n]*\n/m, '')
  .replace(/^import \{ createClient \} from "jsr:@supabase\/supabase-js@2";\n/m, 'const createClient = globalThis.__createClient;\n');
assert.ok(ts.includes('globalThis.__createClient'), 'the supabase import must be swappable');
await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(ts)));
const handler = globalThis.__handler;

async function approve(entryId) {
  const res = await handler(new Request('https://x/approve', {
    method: 'POST',
    headers: { Authorization: 'Bearer caller', 'content-type': 'application/json' },
    body: JSON.stringify({ entry_id: entryId }),
  }));
  return { status: res.status, body: await res.json() };
}

function reset() {
  calls = { createUser: [] };
  caller = { id: 'admin-1', isAdmin: true };
  db = {
    profiles: [
      { id: 'admin-1', email: 'admin@mad3oom.com', role: 'admin', full_name: 'Admin' },
      { id: 'owner-1', email: 'owner@mad3oom.com', role: 'platform_owner', full_name: 'Owner' },
      { id: 'cust-1', email: 'cust@gmail.com', role: 'user', full_name: 'Cust' },
      { id: 'g-1', email: 'asmaa@gmail.com', role: 'user', full_name: null },
    ],
    waitlist_entries: [
      { id: 'e-google', name: 'Asmaa Ojeam', email: 'asmaa@gmail.com', phone: null, status: 'pending', approved_user_id: 'g-1', source: 'google' },
      { id: 'e-form', name: 'زائر', email: 'visitor@gmail.com', phone: null, status: 'pending', approved_user_id: null, source: 'form' },
      { id: 'e-done', name: 'Done', email: 'cust@gmail.com', phone: null, status: 'approved', approved_user_id: 'cust-1', source: 'form' },
    ],
  };
}

test('entry linked to an existing Google account is really approved — no new account, no password', async () => {
  reset();
  const { status, body } = await approve('e-google');
  assert.equal(status, 200);
  assert.equal(body.linked_existing, true);
  assert.equal(body.already_approved, false);
  assert.equal(body.temp_password, null);
  assert.equal(body.user_id, 'g-1');
  assert.equal(calls.createUser.length, 0, 'must not try to create a second account');
  const e = db.waitlist_entries.find(x => x.id === 'e-google');
  assert.equal(e.status, 'approved', 'the status must actually flip — this was the bug');
  assert.equal(e.reviewed_by, 'admin-1');
  assert.ok(e.reviewed_at);
  assert.equal(db.profiles.find(p => p.id === 'g-1').full_name, 'Asmaa Ojeam', 'an empty name is filled from the entry');
});

test('an existing name on the linked account is not overwritten', async () => {
  reset();
  db.profiles.find(p => p.id === 'g-1').full_name = 'اسم العميل';
  await approve('e-google');
  assert.equal(db.profiles.find(p => p.id === 'g-1').full_name, 'اسم العميل');
});

test('already approved stays a no-op', async () => {
  reset();
  const { body } = await approve('e-done');
  assert.equal(body.already_approved, true);
  assert.equal(calls.createUser.length, 0);
});

test('form entry without an account still creates one with a one-time password', async () => {
  reset();
  const { status, body } = await approve('e-form');
  assert.equal(status, 200);
  assert.equal(body.created, true);
  assert.ok(body.temp_password && body.temp_password.length >= 16);
  assert.equal(calls.createUser.length, 1);
  const e = db.waitlist_entries.find(x => x.id === 'e-form');
  assert.equal(e.status, 'approved');
  assert.equal(e.approved_user_id, body.user_id);
});

test('platform owner (is_admin) may approve; a plain customer may not', async () => {
  reset();
  caller = { id: 'owner-1', isAdmin: true };
  assert.equal((await approve('e-google')).status, 200);

  reset();
  caller = { id: 'cust-1', isAdmin: false };
  const { status } = await approve('e-google');
  assert.equal(status, 403);
  assert.equal(db.waitlist_entries.find(x => x.id === 'e-google').status, 'pending');
});
