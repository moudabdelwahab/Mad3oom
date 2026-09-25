/**
 * voice-recorder.js
 * ------------------------------------------------------------
 * تسجيل رسالة صوتية في المتصفح (MediaRecorder). مستقل عن SIE تمامًا:
 * ينتج Blob يُرسل كمرفق عادي (chat-attachments.js).
 *
 *   • إذن الميكروفون يُطلب **عند الضغط فقط** (start)، لا عند تحميل الصفحة.
 *   • الحالات: idle → requesting → recording → stopped | idle (إلغاء) | error.
 *   • أقصى مدة 3 دقائق ثم يتوقف تلقائيًا.
 *   • الإيقاف/الإلغاء يطفئ الميكروفون دائمًا (tracks.stop) — لا مؤشر
 *     تسجيل عالق في المتصفح.
 *   • المتصفح بلا دعم: isVoiceRecordingSupported() = false والواجهة تخفي الزر.
 * ------------------------------------------------------------
 */

export const MAX_RECORDING_MS = 3 * 60 * 1000;

const PREFERRED_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

export function isVoiceRecordingSupported(env = globalThis) {
    return !!(env?.navigator?.mediaDevices?.getUserMedia && typeof env.MediaRecorder === 'function');
}

export function pickRecordingMimeType(MediaRecorderCtor = globalThis.MediaRecorder) {
    if (!MediaRecorderCtor || typeof MediaRecorderCtor.isTypeSupported !== 'function') return '';
    return PREFERRED_TYPES.find((t) => MediaRecorderCtor.isTypeSupported(t)) || '';
}

/** نص مفهوم لخطأ getUserMedia. */
export function microphoneErrorText(err) {
    switch (err?.name) {
        case 'NotAllowedError':
        case 'SecurityError':
            return 'الوصول للميكروفون مرفوض. اسمح به من إعدادات المتصفح وجرّب تاني.';
        case 'NotFoundError':
        case 'OverconstrainedError':
            return 'مفيش ميكروفون متاح على الجهاز ده.';
        case 'NotReadableError':
            return 'الميكروفون مستخدم في تطبيق تاني حاليًا.';
        default:
            return 'تعذّر بدء التسجيل.';
    }
}

export class VoiceRecorder {
    /**
     * @param {Object} [opts]
     * @param {(state:string, detail?:Object) => void} [opts.onState]
     * @param {(elapsedMs:number) => void} [opts.onTick]
     * @param {number} [opts.maxMs]
     * @param {Object} [opts.env] - للاختبار: {navigator, MediaRecorder}
     */
    constructor({ onState = () => {}, onTick = () => {}, maxMs = MAX_RECORDING_MS, env = globalThis } = {}) {
        this.onState = onState;
        this.onTick = onTick;
        this.maxMs = maxMs;
        this.env = env;
        this.state = 'idle';
        this.stream = null;
        this.recorder = null;
        this.chunks = [];
        this.startedAt = 0;
        this.timer = null;
        this.result = null;
    }

    setState(state, detail) {
        this.state = state;
        this.onState(state, detail);
    }

    async start() {
        if (this.state === 'recording' || this.state === 'requesting') return false;
        if (!isVoiceRecordingSupported(this.env)) {
            this.setState('error', { message: 'المتصفح ده مش بيدعم تسجيل الصوت.' });
            return false;
        }
        this.setState('requesting');
        try {
            this.stream = await this.env.navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err) {
            this.releaseStream();
            this.setState('error', { message: microphoneErrorText(err), name: err?.name });
            return false;
        }
        // أُلغي أثناء انتظار الإذن
        if (this.state !== 'requesting') { this.releaseStream(); return false; }

        const mimeType = pickRecordingMimeType(this.env.MediaRecorder);
        try {
            this.recorder = mimeType ? new this.env.MediaRecorder(this.stream, { mimeType }) : new this.env.MediaRecorder(this.stream);
        } catch (err) {
            this.releaseStream();
            this.setState('error', { message: 'تعذّر بدء التسجيل على المتصفح ده.' });
            return false;
        }
        this.chunks = [];
        this.recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) this.chunks.push(e.data); };
        this.recorder.start(250);
        this.startedAt = Date.now();
        this.timer = setInterval(() => {
            const elapsed = Date.now() - this.startedAt;
            this.onTick(elapsed);
            if (elapsed >= this.maxMs) this.stop();
        }, 250);
        this.setState('recording');
        return true;
    }

    /** يوقف ويُرجع {blob, mime, durationMs} للمعاينة. */
    stop() {
        if (this.state !== 'recording' || !this.recorder) return Promise.resolve(null);
        const durationMs = Math.min(this.maxMs, Date.now() - this.startedAt);
        clearInterval(this.timer);
        return new Promise((resolve) => {
            const finish = () => {
                const mime = (this.recorder?.mimeType || this.chunks[0]?.type || 'audio/webm');
                const blob = new Blob(this.chunks, { type: mime });
                this.releaseStream();
                this.result = { blob, mime, durationMs };
                if (!blob.size) { this.setState('error', { message: 'التسجيل فاضي — جرّب تاني.' }); resolve(null); return; }
                this.setState('stopped', this.result);
                resolve(this.result);
            };
            this.recorder.onstop = finish;
            try { this.recorder.stop(); } catch { finish(); }
        });
    }

    /** يلغي في أي مرحلة ويحذف ما سُجّل. */
    cancel() {
        clearInterval(this.timer);
        if (this.recorder && this.recorder.state !== 'inactive') {
            this.recorder.onstop = null;
            try { this.recorder.stop(); } catch { /* already stopped */ }
        }
        this.releaseStream();
        this.chunks = [];
        this.result = null;
        this.setState('idle');
    }

    releaseStream() {
        this.stream?.getTracks?.().forEach((t) => t.stop());
        this.stream = null;
    }
}
