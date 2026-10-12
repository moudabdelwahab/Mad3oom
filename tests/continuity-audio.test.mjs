/**
 * تسجيل صوتي للاستمرارية (§15.4): حد الحجم في VoiceRecorder (اختياري، والافتراضي بلا حد كما
 * يستخدمه صندوق الرسائل). التسجيل الأكبر من الحد يُرفض كله ولا يُقص، والميكروفون يُطفأ.
 * السلوك في المتصفح مقيس في tests/continuity-phase-c.render.test.mjs («audio (§15.4)»).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { VoiceRecorder } from '../assets/js/voice-recorder.js';
import { ATTACHMENT_KINDS } from '../assets/js/continuity/continuity-media.js';

function env({ chunks = [], finalChunk = 0 } = {}) {
    const tracks = [];
    class Rec {
        static isTypeSupported(t) { return t === 'audio/webm;codecs=opus'; }
        constructor(stream, opts) { this.mimeType = opts?.mimeType || 'audio/webm'; this.state = 'inactive'; }
        start() { this.state = 'recording'; for (const n of chunks) this.ondataavailable?.({ data: new Blob([new Uint8Array(n)]) }); }
        stop() {
            if (this.state === 'inactive') return;
            this.state = 'inactive';
            if (finalChunk) this.ondataavailable?.({ data: new Blob([new Uint8Array(finalChunk)]) });
            queueMicrotask(() => this.onstop?.());
        }
    }
    return {
        tracks,
        env: { MediaRecorder: Rec, navigator: { mediaDevices: { getUserMedia: async () => {
            const t = { stopped: false, stop() { this.stopped = true; } };
            tracks.push(t);
            return { getTracks: () => [t] };
        } } } },
    };
}

test('حد الحجم أثناء التسجيل: يتوقف ويُرفض كله ويُطفأ الميكروفون، لا قص', async () => {
    const { env: e, tracks } = env({ chunks: [600, 600] });
    const states = [];
    const sizes = [];
    const rec = new VoiceRecorder({ env: e, maxBytes: 1000, tooLargeMessage: 'كبير', onSize: (b) => sizes.push(b),
        onState: (s, d) => states.push([s, d?.reason, d?.message]) });
    await rec.start();
    assert.equal(rec.state, 'error');
    assert.deepEqual(states.at(-1), ['error', 'too_large', 'كبير']);
    assert.deepEqual(sizes, [600, 1200]);
    assert.equal(rec.chunks.length, 0, 'nothing kept');
    assert.equal(rec.result, null);
    assert.equal(tracks[0].stopped, true);
    assert.equal(await rec.stop(), null, 'nothing to stop or preview');
});

test('حد الحجم عند الإيقاف: آخر جزء يتجاوز ⇒ رفض، وما دونه ⇒ معاينة عادية', async () => {
    let x = env({ chunks: [500], finalChunk: 600 });
    let rec = new VoiceRecorder({ env: x.env, maxBytes: 1000 });
    await rec.start();
    assert.equal(await rec.stop(), null);
    assert.equal(rec.state, 'error');
    assert.equal(x.tracks[0].stopped, true);
    x = env({ chunks: [500], finalChunk: 500 });
    rec = new VoiceRecorder({ env: x.env, maxBytes: 1000 });
    await rec.start();
    const out = await rec.stop();
    assert.equal(out.blob.size, 1000, 'exactly at the limit is accepted');
    assert.equal(rec.state, 'stopped');
});

test('بلا maxBytes (صندوق الرسائل): السلوك كما كان، بلا حد', async () => {
    const { env: e } = env({ chunks: [5_000_000, 5_000_000] });
    const rec = new VoiceRecorder({ env: e });
    await rec.start();
    const out = await rec.stop();
    assert.equal(out.blob.size, 10_000_000);
});

test('الصفحة تستخدم حد الصوت نفسه (8 MiB) ولا تقص، وتطفئ الميكروفون عند مغادرة الصفحة أو فتح سجل آخر', async () => {
    const page = await readFile(new URL('../assets/js/continuity/continuity-page.js', import.meta.url), 'utf8');
    assert.equal(ATTACHMENT_KINDS.audio.max, 8388608);
    assert.match(page, /maxBytes: ATTACHMENT_KINDS\.audio\.max/);
    assert.match(page, /window\.addEventListener\('pagehide', \(\) => resetRecorder\(\)\);/);
    assert.match(page, /if \(state\.rec && state\.rec\.recordId !== id\) resetRecorder\(\);/);
    assert.match(page, /مش هيتقص/);
});
