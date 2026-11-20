import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { VoiceRecorder, isVoiceRecordingSupported } from '../assets/js/voice-recorder.js';

/**
 * ------------------------------------------------------------
 * الجولة الثانية لإصلاح شريط التسجيل (chat-customer-recording-round2).
 *
 * التشخيص (بالدليل):
 *  1. CSS كان يهزم خاصية hidden: `.recorder-bar{display:flex}` و
 *     `.rec-btn{display:flex}` تتغلبان على `[hidden]` في ورقة أنماط
 *     المتصفح، فظهر الشريط وكل أزراره معًا (إيقاف + حذف + X) في أي وضع.
 *  2. `MediaRecorder.start()` بلا try/catch: لو رمى استثناءً صعد من
 *     `VoiceRecorder.start()` كـ rejected promise بلا أي setState،
 *     فتبقى الحالة 'requesting' والشريط عالقًا بلا رسالة.
 *  3. لا معالج لـ onstop/onerror التلقائي من المسجّل نفسه، ولا تحقق
 *     من دخول حالة recording فعلًا، ولا من وصول أي بيانات.
 * هذه الاختبارات تغطي كل مسار حدّي في VoiceRecorder، وتثبّت نصيًا
 * ربط الواجهة (الحارس، الـ cache-busting، الأفاتار) في chat-logic.js
 * و chat-customer.html.
 * ------------------------------------------------------------
 */

const root = (p) => fileURLToPath(new URL(p, import.meta.url));
const read = (p) => readFile(root(p), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeStream() {
    let stopped = 0;
    return {
        getTracks: () => [{ stop() { stopped++; } }],
        get stoppedCount() { return stopped; },
    };
}

function makeEnv({ gum, Recorder }) {
    return {
        navigator: { mediaDevices: { getUserMedia: gum } },
        MediaRecorder: Recorder,
    };
}

/** مسجّل وهمي قابل للضبط: start يرمي / لا يدخل recording / لا يطلق onstop / يصمت. */
function fakeRecorderClass(behavior = {}) {
    return class FakeMediaRecorder {
        static isTypeSupported() { return true; }
        constructor(stream, opts) {
            this.stream = stream;
            this.mimeType = opts?.mimeType || 'audio/webm';
            this.state = 'inactive';
            this.ondataavailable = null;
            this.onstop = null;
            this.onerror = null;
            this._dataTimer = null;
        }
        start() {
            if (behavior.startThrows) throw new Error('start failed');
            if (behavior.stayInactive) return; // start «نجح» بلا دخول recording
            this.state = 'recording';
            if (behavior.silent) return; // يسجّل بلا أي بيانات إطلاقًا
            this._dataTimer = setInterval(() => {
                this.ondataavailable?.({ data: new Blob(['chunk']) });
            }, 100);
        }
        stop() {
            if (this.state === 'inactive') throw new Error('InvalidState');
            this.state = 'inactive';
            if (this._dataTimer) { clearInterval(this._dataTimer); this._dataTimer = null; }
            if (behavior.neverFiresOnstop) return;
            setTimeout(() => this.onstop?.(), 0);
        }
    };
}

function collectStates() {
    const states = [];
    return {
        states,
        onState: (s, d) => states.push([s, d?.message || d?.reason || '']),
    };
}

test('start() يرمي: لا استثناء يصعد، والحالة تنتهي بـ error صريح والشريط يُخفى', async () => {
    const stream = fakeStream();
    const { states, onState } = collectStates();
    const rec = new VoiceRecorder({
        onState,
        env: makeEnv({
            gum: async () => stream,
            Recorder: fakeRecorderClass({ startThrows: true }),
        }),
    });
    let threw = false;
    try { await rec.start(); } catch { threw = true; }
    assert.equal(threw, false, 'start() يجب ألا يرمي أبدًا');
    assert.equal(rec.state, 'error');
    assert.equal(stream.stoppedCount, 1, 'الميكروفون يُحرَّر');
    assert.match(states.at(-1)[1], /تعذّر بدء التسجيل/);
});

test('start() «ينجح» بلا دخول recording: error بدل شريط متجمد', async () => {
    const { states, onState } = collectStates();
    const rec = new VoiceRecorder({
        onState,
        env: makeEnv({
            gum: async () => fakeStream(),
            Recorder: fakeRecorderClass({ stayInactive: true }),
        }),
    });
    assert.equal(await rec.start(), false);
    assert.equal(rec.state, 'error');
    assert.match(states.at(-1)[1], /الميكروفون غير متاح/);
});

test('تسجيل طبيعي: النبضات تتقدم، والإيقاف يرجع معاينة ببيانات', async () => {
    const ticks = [];
    const { states, onState } = collectStates();
    const rec = new VoiceRecorder({
        onState,
        onTick: (ms) => ticks.push(ms),
        env: makeEnv({
            gum: async () => fakeStream(),
            Recorder: fakeRecorderClass(),
        }),
    });
    assert.equal(await rec.start(), true);
    assert.equal(rec.state, 'recording');
    await sleep(600);
    assert.ok(ticks.length >= 2, `النبضات يجب أن تصل (وصل ${ticks.length})`);
    assert.ok(ticks.at(-1) > ticks[0], 'المؤقت يتقدم فعلًا');
    const result = await rec.stop();
    assert.ok(result?.blob?.size > 0);
    assert.equal(rec.state, 'stopped');
    assert.deepEqual(states.map(([s]) => s), ['requesting', 'recording', 'stopped']);
});

test('onstop لا يُطلق أبدًا: حارس 1.2ث ينهي الإيقاف بدل التعليق', async () => {
    const rec = new VoiceRecorder({
        onState: () => {},
        env: makeEnv({
            gum: async () => fakeStream(),
            Recorder: fakeRecorderClass({ neverFiresOnstop: true }),
        }),
    });
    await rec.start();
    await sleep(400); // بيانات تتراكم أولًا (إيقاف فوري بلا بيانات = تسجيل فاضٍ، وerror صحيح)
    const done = await Promise.race([
        rec.stop().then(() => 'settled'),
        sleep(3000).then(() => 'TIMEOUT'),
    ]);
    assert.equal(done, 'settled');
    assert.equal(rec.state, 'stopped');
});

test('إذن معلّق ثم X: الإلغاء أثناء requesting ينهي كل شيء', async () => {
    let release;
    const pending = new Promise((r) => { release = r; });
    const stream = fakeStream();
    const { states, onState } = collectStates();
    const rec = new VoiceRecorder({
        onState,
        env: makeEnv({
            gum: () => pending,
            Recorder: fakeRecorderClass(),
        }),
    });
    const started = rec.start();
    await sleep(50);
    assert.equal(rec.state, 'requesting');
    rec.cancel();
    assert.equal(rec.state, 'idle');
    assert.equal(states.at(-1)[0], 'idle');
    release(stream); // الإذن يصل بعد الإلغاء: يجب ألا يبدأ تسجيل
    assert.equal(await started, false);
    assert.equal(rec.state, 'idle', 'لا تسجيل يبدأ بعد الإلغاء');
});

test('إذن مرفوض: error برسالة عربية واضحة', async () => {
    const { states, onState } = collectStates();
    const rec = new VoiceRecorder({
        onState,
        env: makeEnv({
            gum: async () => { const e = new Error('denied'); e.name = 'NotAllowedError'; throw e; },
            Recorder: fakeRecorderClass(),
        }),
    });
    assert.equal(await rec.start(), false);
    assert.equal(rec.state, 'error');
    assert.match(states.at(-1)[1], /مرفوض/);
});

test('ضغطتا ميكروفون متتاليتان: تسجيل واحد فقط، والثانية ترجع false', async () => {
    let release;
    const pending = new Promise((r) => { release = r; });
    const rec = new VoiceRecorder({
        onState: () => {},
        env: makeEnv({
            gum: () => pending,
            Recorder: fakeRecorderClass(),
        }),
    });
    const first = rec.start();
    assert.equal(await rec.start(), false, 'الضغطة الثانية أثناء الانتظار تُرفض');
    release(fakeStream());
    assert.equal(await first, true);
    assert.equal(rec.state, 'recording');
    rec.cancel();
});

test('توقف تلقائي من المسجّل (فُصل الجهاز) أثناء التسجيل: لا شريط عالق', async () => {
    const { states, onState } = collectStates();
    const rec = new VoiceRecorder({
        onState,
        env: makeEnv({
            gum: async () => fakeStream(),
            Recorder: fakeRecorderClass(),
        }),
    });
    await rec.start();
    await sleep(300); // بيانات وصلت
    rec.recorder.onstop(); // يحاكي توقفًا تلقائيًا من المتصفح
    assert.equal(rec.state, 'stopped');
    assert.ok(rec.result?.blob?.size > 0);
    assert.equal(states.at(-1)[0], 'stopped');
    clearInterval(rec.recorder._dataTimer); // الوهمي لا يوقف نفسه؛ الحقيقي يتوقف مع onstop
});

test('توقف تلقائي بلا أي بيانات: error بدل معاينة فاضية عالقة', async () => {
    const rec = new VoiceRecorder({
        onState: () => {},
        env: makeEnv({
            gum: async () => fakeStream(),
            Recorder: fakeRecorderClass({ silent: true }),
        }),
    });
    await rec.start();
    // أوقف حارس الصمت مؤقتًا لعزل هذا المسار: التوقف التلقائي نفسه هو المُختبَر
    clearTimeout(rec._dataWatchdog);
    rec.recorder.onstop();
    assert.equal(rec.state, 'error');
});

test('خطأ من المسجّل أثناء التسجيل: error صريح والمؤقت يتوقف', async () => {
    const ticks = [];
    const rec = new VoiceRecorder({
        onState: () => {},
        onTick: (ms) => ticks.push(ms),
        env: makeEnv({
            gum: async () => fakeStream(),
            Recorder: fakeRecorderClass(),
        }),
    });
    await rec.start();
    const before = ticks.length;
    rec.recorder.onerror(new Event('error'));
    assert.equal(rec.state, 'error');
    await sleep(600);
    assert.equal(ticks.length, before, 'لا نبضات بعد الفشل');
});

test('مسجّل صامت بلا بيانات 5ث: error «الميكروفون لا يرسل صوتًا»', { timeout: 15000 }, async () => {
    const rec = new VoiceRecorder({
        onState: () => {},
        env: makeEnv({
            gum: async () => fakeStream(),
            Recorder: fakeRecorderClass({ silent: true }),
        }),
    });
    await rec.start();
    assert.equal(rec.state, 'recording');
    await sleep(5500);
    assert.equal(rec.state, 'error');
});

test('الواجهة: قاعدة [hidden] العامة موجودة في chat-customer.html', async () => {
    const html = await read('../chat-customer.html');
    assert.match(html, /\[hidden\] \{ display: none !important; \}/);
    assert.doesNotMatch(html, /mad3oom-avatar-3d\.webp/);
    assert.match(html, /src="\/assets\/js\/chat-logic\.js\?v=2"/);
    assert.match(html, /mad3oom-avatar-typing-laptop\.webp/);
});

test('الواجهة: chat-logic.js يربط الحارس والكتابة والأفاتار القطني', async () => {
    const src = await read('../assets/js/chat-logic.js');
    assert.match(src, /voice-recorder\.js\?v=2/);
    assert.match(src, /MAD3OOM_AVATAR_SRC = '\/assets\/images\/mad3oom-avatar-fluffy\.webp'/);
    assert.match(src, /MAD3OOM_AVATAR_TYPING_SRC = '\/assets\/images\/mad3oom-avatar-typing-laptop\.webp'/);
    assert.match(src, /showTypingAvatar\(true\)/);
    assert.match(src, /recordingFirstTickWatchdog/);
    assert.match(src, /await voiceRecorder\.start\(\);\s*\n\s*\} catch/);
    assert.match(src, /setupAvatarLife\(\)/);
    assert.match(src, /rand\(3000, 7000\)/); // رمشة غير منتظمة 3–7ث
});

test('صورة الكتابة في الأصول هي النسخة الثالثة المصححة فقط', async () => {
    const buf = await readFile(root('../assets/images/mad3oom-avatar-typing-laptop.webp'));
    const sha = createHash('sha256').update(buf).digest('hex');
    assert.equal(sha, '0f958c69dffd0a06dfeb3025dc60b3c3771d0e05d6316e4501a75f3083151f1d');
    assert.notEqual(sha, '7e2a99fc80455401a3636da8359e4b0d566f52d4c19b47edcaac08287e211beb', 'ليست النسخة الأولى');
    assert.notEqual(sha, 'f75ecb3dad04a12481469047fd3ceb55923661836f22353f71541ec1e7f31b4a', 'ليست النسخة الثانية');
    assert.ok(buf.length > 100000, 'ملف webp حقيقي غير فاضي');
});

test('الأفاتار القطني موجود والويدجت لم يُمس (ما زال 3D)', async () => {
    const fluffy = await readFile(root('../assets/images/mad3oom-avatar-fluffy.webp'));
    assert.equal(createHash('sha256').update(fluffy).digest('hex'),
        '3dc5e7b4073812e17e37b192b53909c275857b22c1c96eb28e12f2b58465b9eb');
    const widget = await read('../chat-widget.js');
    assert.match(widget, /mad3oom-avatar-3d\.webp/);
});
