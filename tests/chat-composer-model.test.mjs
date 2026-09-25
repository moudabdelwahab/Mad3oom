/**
 * chat-composer-model.test.mjs
 * ------------------------------------------------------------
 * الأجزاء النقية من الـ composer الجديد: عرض الخطة والاستخدام، والتحقق من
 * المرفقات ومساراتها، ومسجّل الصوت بمحاكي MediaRecorder. الفرض الحقيقي
 * على الخادم (0011 في مستودع SIE، و054 هنا) ومغطّى باختبارات SQL؛ هنا
 * نثبت أن الواجهة لا تخترع قواعد ولا تنكسر برد ناقص.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeEntitlement, usageView, formatResetIn, normalizeChatbotMode, downgradeErrorText, PLAN_LABELS
} from '../assets/js/sie-plan-model.js';
import { fetchEntitlement, downgradePlan } from '../assets/js/sie-plan-service.js';
import {
    validateFile, buildObjectPath, messageFieldsFor, attachmentFromMessage, renderAttachmentHtml,
    baseMime, displayName, uploadErrorText, formatBytes
} from '../assets/js/chat-attachments.js';
import { VoiceRecorder, isVoiceRecordingSupported, microphoneErrorText, pickRecordingMimeType } from '../assets/js/voice-recorder.js';

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const NOW = Date.parse('2026-09-25T21:43:00Z');
const RESET = '2026-10-01T00:00:00Z';

// ─────────────────────────── plan + usage ───────────────────────────

test('entitlement: the server decides the downgrades — the UI invents none', () => {
    const max = normalizeEntitlement({ signed_in: true, has_access: true, edition: 'max', downgrade_to: ['pro', 'free'], primary: { kind: 'unlimited', used: 3, resets_at: RESET } });
    assert.deepEqual(max.downgradeTo.map((d) => d.plan), ['pro', 'free']);
    const pro = normalizeEntitlement({ signed_in: true, has_access: true, edition: 'pro', downgrade_to: ['free'] });
    assert.deepEqual(pro.downgradeTo.map((d) => d.plan), ['free']);
    const free = normalizeEntitlement({ signed_in: true, has_access: true, edition: 'free', downgrade_to: [] });
    assert.deepEqual(free.downgradeTo, [], 'Free: nothing below');
    // unknown plans and the current plan are dropped; the list is otherwise
    // the server's — the RPC refuses anything that is not a real downgrade
    const odd = normalizeEntitlement({ signed_in: true, has_access: true, edition: 'pro', downgrade_to: ['pro', 'enterprise', 'free'] });
    assert.deepEqual(odd.downgradeTo.map((d) => d.plan), ['free']);
});

test('entitlement: missing, malformed or signed-out replies are safe states, never throw', () => {
    for (const raw of [null, undefined, 'x', 42, {}, { signed_in: true }, { signed_in: true, edition: 'gold' }]) {
        const e = normalizeEntitlement(raw);
        assert.equal(e.status, 'unavailable');
        assert.equal(e.hasAccess, false);
        assert.deepEqual(e.downgradeTo, []);
    }
    assert.equal(normalizeEntitlement({ signed_in: false }).status, 'signed_out');
});

test('usage: a monthly limit shows used / limit, remaining, percent and the reset time from the server', () => {
    const e = normalizeEntitlement({ signed_in: true, has_access: true, edition: 'pro', downgrade_to: ['free'],
        primary: { kind: 'monthly', used: 800, limit: 1000, remaining: 200, resets_at: RESET } });
    const v = usageView(e, NOW);
    assert.equal(v.usedText, '800 / 1,000');
    assert.equal(v.remainingText, '200 متبقي');
    assert.equal(v.percent, 80);
    assert.equal(v.tone, 'warn');
    assert.match(v.resetText, /^يتجدد بعد \d+ أيام$/);
});

test('usage: after a downgrade the SAME usage is shown against the NEW (smaller) limit', () => {
    const afterMaxToPro = normalizeEntitlement({ signed_in: true, has_access: false, reason: 'edition_monthly_limit', edition: 'pro',
        downgrade_to: ['free'], primary: { kind: 'monthly', used: 12, limit: 10, remaining: 0, resets_at: RESET } });
    const v = usageView(afterMaxToPro, NOW);
    assert.equal(v.usedText, '12 / 10');
    assert.equal(v.percent, 100);
    assert.equal(v.tone, 'full');
    assert.equal(afterMaxToPro.reasonText, 'وصلت لحد رسائل الشهر في خطتك الحالية.');
});

test('usage: unlimited shows this month\'s count and no bar; a lifetime quota says it does not renew', () => {
    const u = usageView(normalizeEntitlement({ signed_in: true, has_access: true, edition: 'free', downgrade_to: [],
        primary: { kind: 'unlimited', used: 42, limit: null, remaining: null, resets_at: RESET } }), NOW);
    assert.equal(u.unlimited, true);
    assert.equal(u.percent, null);
    assert.equal(u.remainingText, 'بلا حد');
    assert.equal(u.usedText, '42 رسالة هذا الشهر');
    const l = usageView(normalizeEntitlement({ signed_in: true, has_access: true, edition: 'free', downgrade_to: [],
        primary: { kind: 'lifetime', used: 35, limit: 50000, remaining: 49965, resets_at: null } }), NOW);
    assert.equal(l.resetText, 'رصيد غير متجدد');
    assert.equal(l.percent, 0);
});

test('formatResetIn: minutes, hours, days, past and junk', () => {
    const at = (ms) => new Date(NOW + ms).toISOString();
    assert.equal(formatResetIn(at(30 * 1000), NOW), 'خلال دقيقة');
    assert.equal(formatResetIn(at(45 * 60000), NOW), 'بعد 45د');
    assert.equal(formatResetIn(at((2 * 60 + 17) * 60000), NOW), 'بعد 2س 17د');
    assert.equal(formatResetIn(at(3 * 86400000), NOW), 'بعد 3 أيام');
    assert.equal(formatResetIn(at(-1000), NOW), null);
    assert.equal(formatResetIn('garbage', NOW), null);
    assert.equal(formatResetIn(null, NOW), null);
});

test('response mode: SIE is the only mode; every legacy value reads as SIE', () => {
    for (const v of ['traditional', 'ai_model', 'auto', 'sie', null, undefined, '']) assert.equal(normalizeChatbotMode(v), 'sie');
    assert.deepEqual(Object.keys(PLAN_LABELS), ['free', 'pro', 'max']);
});

test('service: the entitlement comes from the RPC; an RPC failure is a safe state, never a throw', async () => {
    const calls = [];
    const ok = { rpc: async (fn) => { calls.push(fn); return { data: { signed_in: true, has_access: true, edition: 'free', downgrade_to: [] }, error: null }; } };
    assert.equal((await fetchEntitlement(ok)).plan, 'free');
    assert.deepEqual(calls, ['sie_my_entitlement']);
    const missing = { rpc: async () => ({ data: null, error: { message: 'function sie_my_entitlement() does not exist' } }) };
    assert.equal((await fetchEntitlement(missing)).status, 'unavailable');
    const boom = { rpc: async () => { throw new Error('offline'); } };
    assert.equal((await fetchEntitlement(boom)).status, 'unavailable');
    assert.equal((await fetchEntitlement(null)).status, 'unavailable');
});

test('service: a downgrade goes through the RPC with the target only, and a refusal is explained', async () => {
    let sent = null;
    const sb = (reply) => ({ rpc: async (fn, args) => { sent = { fn, args }; return reply; } });
    assert.deepEqual(await downgradePlan(sb({ data: { ok: true, edition: 'pro', previous: 'max' }, error: null }), 'pro'),
        { ok: true, edition: 'pro', previous: 'max' });
    assert.deepEqual(sent, { fn: 'sie_customer_downgrade', args: { p_target: 'pro' } });
    const refused = await downgradePlan(sb({ data: { ok: false, error: 'not_a_downgrade' }, error: null }), 'max');
    assert.equal(refused.ok, false);
    assert.equal(refused.errorText, downgradeErrorText('not_a_downgrade'));
    assert.equal((await downgradePlan(sb({ data: null, error: { message: 'x' } }), 'free')).ok, false);
});

// ─────────────────────────── attachments ───────────────────────────

const file = (name, type, size) => ({ name, type, size });

test('attachments: images and common documents are accepted by MIME and matching extension', () => {
    assert.deepEqual(validateFile(file('shot.png', 'image/png', 2048)), { ok: true, kind: 'image', mime: 'image/png', ext: 'png' });
    assert.equal(validateFile(file('photo.JPG', 'image/jpeg', 2048)).kind, 'image');
    assert.equal(validateFile(file('report.pdf', 'application/pdf', 90000)).kind, 'file');
    assert.equal(validateFile(file('sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 9000)).kind, 'file');
    assert.equal(validateFile(file('notes.txt', 'text/plain', 10)).kind, 'file');
});

test('attachments: invalid, mismatched, empty and oversized files are refused with a reason', () => {
    const bad = (f) => { const r = validateFile(f); assert.equal(r.ok, false); assert.ok(r.error.length > 5); return r.error; };
    assert.match(bad(file('virus.exe', 'application/x-msdownload', 100)), /غير مدعوم/);
    assert.match(bad(file('page.html', 'text/html', 100)), /غير مدعوم/);
    assert.match(bad(file('logo.svg', 'image/svg+xml', 100)), /غير مدعوم/, 'SVG can carry script');
    assert.match(bad(file('evil.exe', 'image/png', 100)), /لا يطابق/, 'extension must match the type');
    assert.match(bad(file('empty.png', 'image/png', 0)), /فاضي/);
    assert.match(bad(file('big.png', 'image/png', 5 * 1024 * 1024 + 1)), /أكبر من الحد/);
    assert.match(bad(file('big.pdf', 'application/pdf', 10 * 1024 * 1024 + 1)), /أكبر من الحد/);
    assert.equal(validateFile(null).ok, false);
});

test('attachments: a recording is validated as audio, with or without codec parameters', () => {
    assert.equal(validateFile(file('voice.webm', 'audio/webm;codecs=opus', 30000), 'audio').kind, 'audio');
    assert.equal(validateFile(file('', 'audio/mp4', 30000), 'audio').ext, 'm4a');
    assert.equal(validateFile(file('x.png', 'image/png', 30000), 'audio').ok, false, 'the recorder only produces audio');
    assert.equal(baseMime('audio/webm;codecs=opus'), 'audio/webm');
});

test('attachments: the object path is always inside the sender\'s own folder', () => {
    const p = buildObjectPath('u-1', 's-9', 'PNG', 1700000000000, () => 0.5);
    assert.match(p, /^u-1\/s-9-1700000000000-[0-9a-z]{6}\.png$/);
    assert.match(buildObjectPath('u-1', 's-9', '../../etc', 1, () => 0.1), /^u-1\/s-9-1-[0-9a-z]{6}\.etc$/, 'no traversal through the extension');
});

test('attachments: message fields keep image_url / audio_url for existing renderers and carry metadata', () => {
    assert.deepEqual(messageFieldsFor({ kind: 'image', path: 'u/a.png', name: 'a.png', mime: 'image/png', size: 10 }),
        { attachment: { kind: 'image', path: 'u/a.png', name: 'a.png', mime: 'image/png', size: 10 }, image_url: 'u/a.png' });
    assert.deepEqual(messageFieldsFor({ kind: 'audio', path: 'u/v.webm', name: 'v.webm', mime: 'audio/webm;codecs=opus', size: 5, durationMs: 4200.4 }),
        { attachment: { kind: 'audio', path: 'u/v.webm', name: 'v.webm', mime: 'audio/webm', size: 5, duration_ms: 4200 }, audio_url: 'u/v.webm' });
    const f = messageFieldsFor({ kind: 'file', path: 'u/r.pdf', name: 'C:\\docs\\r.pdf', mime: 'application/pdf', size: 1 });
    assert.equal(f.attachment.name, 'r.pdf');
    assert.equal(f.image_url, undefined);
});

test('attachments: old messages (image_url only) and new ones render the same way; names are escaped', () => {
    assert.deepEqual(attachmentFromMessage({ image_url: 'u/old.png' }).kind, 'image');
    assert.equal(attachmentFromMessage({ audio_url: 'u/old.webm' }).kind, 'audio');
    assert.equal(attachmentFromMessage({ message_text: 'hi' }), null);
    const html = renderAttachmentHtml(attachmentFromMessage({ attachment: { kind: 'file', path: 'u/x.pdf', name: '<img src=x onerror=alert(1)>.pdf', size: 2048 } }), esc);
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /data-storage-path="u\/x.pdf"/);
    assert.match(html, /href="#"/, 'no URL is written before signing');
    assert.match(renderAttachmentHtml({ kind: 'image', path: 'u/a.png', name: 'a' }, esc), /loading="lazy"/);
});

test('attachments: server refusals become readable messages', () => {
    assert.match(uploadErrorText(new Error('upload 413: Payload too large')), /أكبر من الحد/);
    assert.match(uploadErrorText(new Error('mime type text/html is not supported')), /مرفوض/);
    assert.match(uploadErrorText(new Error('new row violates row-level security policy')), /مش مسموح/);
    assert.match(uploadErrorText(new Error('network')), /انقطع/);
    assert.equal(displayName(''), 'مرفق');
    assert.equal(formatBytes(1536), '1.5 KB');
});

// ─────────────────────────── voice recorder ───────────────────────────

function fakeEnv({ deny = null, supported = true } = {}) {
    const tracks = [];
    class FakeRecorder {
        static isTypeSupported(t) { return t === 'audio/webm;codecs=opus'; }
        constructor(stream, opts) { this.mimeType = opts?.mimeType || 'audio/webm'; this.state = 'inactive'; }
        start() { this.state = 'recording'; this.ondataavailable?.({ data: new Blob(['abc'], { type: this.mimeType }) }); }
        stop() { this.state = 'inactive'; queueMicrotask(() => this.onstop?.()); }
    }
    const env = {
        MediaRecorder: supported ? FakeRecorder : undefined,
        navigator: { mediaDevices: supported ? {
            getUserMedia: async () => {
                if (deny) { const e = new Error(deny); e.name = deny; throw e; }
                const t = { stopped: false, stop() { this.stopped = true; } };
                tracks.push(t);
                return { getTracks: () => [t] };
            }
        } : undefined }
    };
    return { env, tracks };
}

test('recorder: permission is requested only on start; recording → stop gives a previewable blob and frees the mic', async () => {
    const { env, tracks } = fakeEnv();
    const states = [];
    const rec = new VoiceRecorder({ env, onState: (s) => states.push(s) });
    assert.equal(tracks.length, 0, 'no microphone before the user presses the button');
    assert.equal(await rec.start(), true);
    assert.equal(rec.state, 'recording');
    const out = await rec.stop();
    assert.equal(out.mime, 'audio/webm;codecs=opus');
    assert.ok(out.blob.size > 0);
    assert.deepEqual(states, ['requesting', 'recording', 'stopped']);
    assert.equal(tracks[0].stopped, true, 'the microphone is released after stopping');
});

test('recorder: cancel discards the recording and frees the mic', async () => {
    const { env, tracks } = fakeEnv();
    const rec = new VoiceRecorder({ env });
    await rec.start();
    rec.cancel();
    assert.equal(rec.state, 'idle');
    assert.equal(rec.result, null);
    assert.equal(tracks[0].stopped, true);
});

test('recorder: a denied permission is an explained error state, not a crash', async () => {
    const { env } = fakeEnv({ deny: 'NotAllowedError' });
    const seen = [];
    const rec = new VoiceRecorder({ env, onState: (s, d) => seen.push([s, d?.message]) });
    assert.equal(await rec.start(), false);
    assert.equal(rec.state, 'error');
    assert.match(seen.at(-1)[1], /مرفوض/);
    assert.match(microphoneErrorText({ name: 'NotFoundError' }), /مفيش ميكروفون/);
});

test('recorder: an unsupported browser is detected up front (graceful fallback)', async () => {
    const { env } = fakeEnv({ supported: false });
    assert.equal(isVoiceRecordingSupported(env), false);
    const rec = new VoiceRecorder({ env });
    assert.equal(await rec.start(), false);
    assert.equal(rec.state, 'error');
    assert.equal(pickRecordingMimeType(undefined), '');
});
