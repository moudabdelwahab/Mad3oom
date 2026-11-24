import test from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../login-location.js');
const { captureLoginLocation, LOGIN_LOCATION_OWNER_EMAIL } = mod;

const OWNER = { id: '00000000-0000-0000-0000-0000000000a1', email: LOGIN_LOCATION_OWNER_EMAIL };
const OTHER = { id: '00000000-0000-0000-0000-0000000000b2', email: 'someone@else.com' };

let inserted = [];
let insertBehaviour = null;

function stubSupabase() {
  return {
    from: (table) => {
      assert.equal(table, 'login_locations');
      return {
        insert: async (row) => {
          inserted.push(row);
          if (typeof insertBehaviour === 'function') return insertBehaviour(row);
          return { error: null };
        },
      };
    },
  };
}

function setNavigator(value) {
  // Node يعرّف navigator كخاصية getter فقط — الاستبدال المباشر يفشل،
  // فالضبط يكون عبر defineProperty (قابلة لإعادة التعريف).
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

function stubGeolocation(mode, coords = { latitude: 30.0444, longitude: 31.2357, accuracy: 24.6 }) {
  setNavigator({
    geolocation: {
      getCurrentPosition: (ok, err) => {
        if (mode === 'success') ok({ coords });
        else if (mode === 'denied') err({ code: 1, message: 'denied' });
        // 'silent': never calls back — the timeout must rescue it.
      },
    },
  });
}

function reset(mode = 'success') {
  inserted = [];
  insertBehaviour = null;
  stubGeolocation(mode);
}

test('non-owner account: no prompt, no insert', async () => {
  reset('success');
  assert.equal(await captureLoginLocation(stubSupabase(), OTHER), null);
  assert.equal(inserted.length, 0);
});

test('no user: nothing happens', async () => {
  reset('success');
  assert.equal(await captureLoginLocation(stubSupabase(), null), null);
  assert.equal(inserted.length, 0);
});

test('no Geolocation support: resolves null without throwing', async () => {
  setNavigator(undefined);
  assert.equal(await captureLoginLocation(stubSupabase(), OWNER), null);
  assert.equal(inserted.length, 0);
});

test('success: inserts the owner row with rounded accuracy', async () => {
  reset('success');
  const row = await captureLoginLocation(stubSupabase(), OWNER, { timeoutMs: 1000 });
  assert.equal(inserted.length, 1);
  assert.equal(row.user_id, OWNER.id);
  assert.equal(row.latitude, 30.0444);
  assert.equal(row.longitude, 31.2357);
  assert.equal(row.accuracy_m, 25);
  assert.equal(row.source, 'browser');
});

test('permission denied: resolves null, no insert', async () => {
  reset('denied');
  assert.equal(await captureLoginLocation(stubSupabase(), OWNER, { timeoutMs: 1000 }), null);
  assert.equal(inserted.length, 0);
});

test('insert error: resolves null, never rejects', async () => {
  reset('success');
  insertBehaviour = async () => ({ error: { message: 'RLS denied' } });
  assert.equal(await captureLoginLocation(stubSupabase(), OWNER, { timeoutMs: 1000 }), null);
});

test('insert throws: resolves null, never rejects', async () => {
  reset('success');
  insertBehaviour = async () => { throw new Error('network down'); };
  assert.equal(await captureLoginLocation(stubSupabase(), OWNER, { timeoutMs: 1000 }), null);
});

test('geolocation never answers: the timeout rescues it', async () => {
  reset('silent');
  const started = Date.now();
  assert.equal(await captureLoginLocation(stubSupabase(), OWNER, { timeoutMs: 60 }), null);
  assert.ok(Date.now() - started < 1000, 'must resolve near the timeout, not hang');
  assert.equal(inserted.length, 0);
});
