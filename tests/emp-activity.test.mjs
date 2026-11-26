import test from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../assets/js/emp-activity.js');
const {
    initEmpActivity,
    trackEmpActivity,
    stopEmpActivity,
    isEmpActivityOnShift,
    isEmpActivitySupported,
    resetEmpActivityState,
} = mod;

const fakeSupabase = { rpc: async () => ({ data: {}, error: null }) };

function makeFakeInstance() {
    return {
        trackCalls: [],
        stopCalls: 0,
        isOnShift: true,
        track(type, opts) { this.trackCalls.push({ type, opts }); },
        stop() { this.stopCalls++; },
    };
}

function makeFakeClient(instance) {
    const client = {
        initCalls: [],
        init(opts) {
            client.initCalls.push(opts);
            return instance;
        },
    };
    return { Mad3oomActivity: client, __client: client };
}

function setBrowser() {
    globalThis.window = {};
    globalThis.document = { visibilityState: 'visible' };
}

function clearBrowser() {
    delete globalThis.window;
    delete globalThis.document;
}

test('outside the browser: init is a no-op and the injected client is never touched', async () => {
    resetEmpActivityState();
    clearBrowser();
    assert.equal(isEmpActivitySupported(), false);
    const instance = makeFakeInstance();
    const fake = makeFakeClient(instance);
    assert.equal(await initEmpActivity({ supabase: fakeSupabase, activityClient: fake }), null);
    assert.equal(fake.__client.initCalls.length, 0);
});

test('track/stop/isOnShift before init never throw and report no shift', () => {
    resetEmpActivityState();
    clearBrowser();
    assert.doesNotThrow(() => trackEmpActivity('ticket_reply', { entityType: 'ticket', entityId: 't-1' }));
    assert.doesNotThrow(() => stopEmpActivity());
    assert.equal(isEmpActivityOnShift(), null);
});

test('in the browser: init once, track forwards, stop clears', async () => {
    resetEmpActivityState();
    setBrowser();
    try {
        assert.equal(isEmpActivitySupported(), true);
        const instance = makeFakeInstance();
        const fake = makeFakeClient(instance);
        const first = await initEmpActivity({ supabase: fakeSupabase, activityClient: fake });
        assert.equal(first, instance);
        assert.equal(fake.__client.initCalls.length, 1);
        assert.equal(fake.__client.initCalls[0].supabase, fakeSupabase);
        assert.equal(isEmpActivityOnShift(), true);

        // التهيئة الثانية ترجع نفس المثيل ولا تعيد استدعاء init.
        assert.equal(await initEmpActivity({ supabase: fakeSupabase, activityClient: fake }), instance);
        assert.equal(fake.__client.initCalls.length, 1);

        trackEmpActivity('ticket_reply', { entityType: 'ticket', entityId: 't-1', metadata: { to: 'resolved' } });
        assert.equal(instance.trackCalls.length, 1);
        assert.equal(instance.trackCalls[0].type, 'ticket_reply');
        assert.equal(instance.trackCalls[0].opts.entityId, 't-1');

        stopEmpActivity();
        assert.equal(instance.stopCalls, 1);
        assert.equal(isEmpActivityOnShift(), null);
        trackEmpActivity('ticket_reply', { entityType: 'ticket', entityId: 't-2' });
        assert.equal(instance.trackCalls.length, 1);
    } finally {
        resetEmpActivityState();
        clearBrowser();
    }
});

test('init failure returns null, never throws, and a later init can retry', async () => {
    resetEmpActivityState();
    setBrowser();
    try {
        const failing = { Mad3oomActivity: { init() { throw new Error('boom'); } } };
        assert.equal(await initEmpActivity({ supabase: fakeSupabase, activityClient: failing }), null);
        assert.equal(isEmpActivityOnShift(), null);

        const instance = makeFakeInstance();
        const fake = makeFakeClient(instance);
        assert.equal(await initEmpActivity({ supabase: fakeSupabase, activityClient: fake }), instance);
    } finally {
        resetEmpActivityState();
        clearBrowser();
    }
});

test('init with a client module lacking init returns null', async () => {
    resetEmpActivityState();
    setBrowser();
    try {
        assert.equal(await initEmpActivity({ supabase: fakeSupabase, activityClient: {} }), null);
    } finally {
        resetEmpActivityState();
        clearBrowser();
    }
});
