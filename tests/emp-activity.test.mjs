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

/** DOM وهمي يكفي لمساعدي التنبيه في الجسر (createElement/body/getElementById). */
function makeEl() {
    const el = {
        children: [], style: {}, id: '', className: '', textContent: '', type: '', removed: false,
        appendChild(c) { this.children.push(c); return c; },
        addEventListener() {},
        remove() { this.removed = true; },
        setAttribute(k, v) { this[k] = v; },
    };
    return el;
}

function setRichBrowser() {
    const body = makeEl();
    globalThis.window = {};
    globalThis.document = {
        visibilityState: 'visible',
        body,
        createElement: () => makeEl(),
        getElementById: (id) => body.children.find((c) => c.id === id) || null,
    };
    return body;
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

test('init passes an onStatus handler to the SDK', async () => {
    resetEmpActivityState();
    setBrowser();
    try {
        const instance = makeFakeInstance();
        const fake = makeFakeClient(instance);
        await initEmpActivity({ supabase: fakeSupabase, activityClient: fake });
        assert.equal(typeof fake.__client.initCalls[0].onStatus, 'function');
    } finally {
        resetEmpActivityState();
        clearBrowser();
    }
});

test('auth_failed warns once per page load, only on staff pages (expectEmployee)', async () => {
    resetEmpActivityState();
    const body = setRichBrowser();
    try {
        const instance = makeFakeInstance();
        const fake = makeFakeClient(instance);
        await initEmpActivity({ supabase: fakeSupabase, activityClient: fake, expectEmployee: true });
        const onStatus = fake.__client.initCalls[0].onStatus;

        onStatus({ status: 'auth_failed', code: 'EO403' });
        onStatus({ status: 'auth_failed', code: 'EO403' });
        const root = body.children.find((c) => c.id === 'emp-activity-toasts');
        assert.ok(root, 'لم يظهر جذر التنبيهات');
        assert.equal(root.children.length, 1, 'تحذير الربط ظهر أكثر من مرة');
        assert.match(root.children[0].textContent, /غير مربوط بملف موظف/);
    } finally {
        resetEmpActivityState();
        clearBrowser();
    }
});

test('auth_failed stays silent on non-staff pages (no expectEmployee)', async () => {
    resetEmpActivityState();
    const body = setRichBrowser();
    try {
        const instance = makeFakeInstance();
        const fake = makeFakeClient(instance);
        await initEmpActivity({ supabase: fakeSupabase, activityClient: fake });
        fake.__client.initCalls[0].onStatus({ status: 'auth_failed', code: 'EO403' });
        assert.equal(body.children.length, 0, 'ظهر تحذير رغم أن الصفحة ليست صفحة موظفين');
    } finally {
        resetEmpActivityState();
        clearBrowser();
    }
});

test('idle toasts once per window, break banner shows and clears', async () => {
    resetEmpActivityState();
    const body = setRichBrowser();
    try {
        const instance = makeFakeInstance();
        const fake = makeFakeClient(instance);
        await initEmpActivity({ supabase: fakeSupabase, activityClient: fake, expectEmployee: true });
        const onStatus = fake.__client.initCalls[0].onStatus;

        onStatus({ status: 'ok', presence: 'idle', idle_seconds: 700 });
        onStatus({ status: 'ok', presence: 'idle', idle_seconds: 800 });
        const root = body.children.find((c) => c.id === 'emp-activity-toasts');
        assert.ok(root, 'لم يظهر تنبيه الخمول');
        assert.equal(root.children.length, 1, 'تنبيه الخمول تكرر داخل نافذة الـ ١٠ دقائق');

        onStatus({ status: 'ok', presence: 'break', on_break: true });
        const banner = body.children.find((c) => c.id === 'emp-activity-break-banner');
        assert.ok(banner, 'لافتة الاستراحة لم تظهر');
        onStatus({ status: 'ok', presence: 'break', on_break: true });
        assert.equal(body.children.filter((c) => c.id === 'emp-activity-break-banner').length, 1,
            'لافتة الاستراحة تكررت');

        onStatus({ status: 'ok', presence: 'active', on_break: false });
        assert.equal(banner.removed, true, 'لافتة الاستراحة لم تُزَل بعد انتهائها');
    } finally {
        resetEmpActivityState();
        clearBrowser();
    }
});
