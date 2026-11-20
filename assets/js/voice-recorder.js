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
 *   • الإيقاف أثناء انتظار الإذن = إلغاء (لا تسجيل بعد ليُوقف).
 *   • الإيقاف له حارس زمني (1.2ث): لو onstop لم يُطلق أبدًا يُنهى الإيقاف
 *     بدل التعليق في حالة 'recording' للأبد.
 *   • أي فشل في بدء التسجيل (start() يرمي، المسجّل لا يدخل حالة
 *     recording، لا بيانات إطلاقًا خلال 5ث، خطأ/توقف تلقائي من المسجّل)
 *     ينتهي بحالة 'error' صريحة — لا يبقى أبدًا في 'requesting' أو
 *     'recording' بلا تسجيل حقيقي، ولا استثناء يصعد بصمت من start().
 *   • المتصفح بلا دعم: isVoiceRecordingSupported() = false والواجهة تخفي الزر.
 *   • maxBytes (اختياري، الافتراضي بلا حد): لو تجاوز ما سُجّل الحد يتوقف التسجيل ويُرفض
 *     كله بحالة error (reason: 'too_large') — لا يُقص أبدًا. onSize يبلّغ الحجم الحالي.
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
     * @param {number} [opts.maxBytes] - حد الحجم بالبايت (الافتراضي بلا حد)
     * @param {(bytes:number) => void} [opts.onSize]
     * @param {string} [opts.tooLargeMessage]
     */
    constructor({ onState = () => {}, onTick = () => {}, maxMs = MAX_RECORDING_MS, env = globalThis,
        maxBytes = Infinity, onSize = () => {}, tooLargeMessage = 'التسجيل أطول من المسموح.' } = {}) {
        this.onState = onState;
        this.onTick = onTick;
        this.maxMs = maxMs;
        this.maxBytes = maxBytes;
        this.onSize = onSize;
        this.tooLargeMessage = tooLargeMessage;
        this.bytes = 0;
        this.env = env;
        this.state = 'idle';
        this.stream = null;
        this.recorder = null;
        this.chunks = [];
        this.startedAt = 0;
        this.timer = null;
        this.stopGuard = null;
        this.stopPromise = null; // إيقاف جارٍ: ضغطة ثانية تعيد الوعد نفسه
        this._stopSettle = null;
        this.result = null;
        this.rejected = false;
        this._dataWatchdog = null; // لا بيانات إطلاقًا خلال 5ث من بدء التسجيل = مسجّل صامت
        this._recorderErrored = false; // MediaRecorder أطلق error (جهاز فُصل، ...)
    }

    /** يوقف كل مؤقتات التسجيل (مؤقت الواجهة + حارس أول بيانات). */
    _clearTimers() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (this._dataWatchdog) { clearTimeout(this._dataWatchdog); this._dataWatchdog = null; }
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
        this.bytes = 0;
        this.rejected = false;
        this._recorderErrored = false;
        this.recorder.ondataavailable = (e) => {
            if (!e.data || !(e.data.size > 0) || this.rejected) return;
            if (this._dataWatchdog) { clearTimeout(this._dataWatchdog); this._dataWatchdog = null; }
            this.chunks.push(e.data);
            this.bytes += e.data.size;
            this.onSize(this.bytes);
            if (this.bytes > this.maxBytes) this.rejectTooLarge();
        };
        // توقف تلقائي من المسجّل نفسه (فُصل الجهاز، خطأ داخلي): بلا هذا
        // المعالج كان التسجيل «يستمر» في الواجهة والمؤقت يتقدم رغم توقف
        // المسجّل فعليًا، وstop() بعدها لا تفعل شيئًا. onstop يُستبدل في
        // stop() بـ finish، وفي cancel()/rejectTooLarge() يُلغى — فهذا
        // المعالج لا يعمل إلا أثناء تسجيل نشط لم يُطلب إيقافه.
        this.recorder.onstop = () => {
            if (this.state !== 'recording' || this.stopPromise) return;
            this._clearTimers();
            const mime = (this.recorder?.mimeType || this.chunks[0]?.type || 'audio/webm');
            const blob = new Blob(this.chunks, { type: mime });
            this.releaseStream();
            if (this._recorderErrored || !blob.size) {
                this.chunks = [];
                this.result = null;
                this.setState('error', { message: 'توقف التسجيل فجأة — تأكد من الميكروفون وجرّب تاني.' });
                return;
            }
            this.result = { blob, mime, durationMs: Math.min(this.maxMs, Date.now() - this.startedAt) };
            this.setState('stopped', this.result);
        };
        this.recorder.onerror = () => {
            this._recorderErrored = true;
            this._handleRecorderFailure('تعذّر إكمال التسجيل — تأكد من الميكروفون وجرّب تاني.');
        };
        // start() نفسه قد يرمي (InvalidStateError لو المسارات انتهت،
        // NotSupportedError، ...): قبل هذا الإصلاح كان الاستثناء يصعد
        // من start() كـ rejected promise بلا أي setState، فتبقى الحالة
        // 'requesting' والشريط عالقًا بلا أي رسالة. الآن أي فشل في بدء
        // التسجيل ينهي الحالة بـ error صريح يخفي الشريط ويعرض السبب.
        try {
            this.recorder.start(250);
        } catch (err) {
            this.releaseStream();
            this.setState('error', { message: 'تعذّر بدء التسجيل على المتصفح ده. جرّب تاني.' });
            return false;
        }
        // تجاوز الحد أثناء start (بيانات متزامنة): الرفض نهائي، فلا مؤقت ولا حالة تسجيل.
        // يُفحص قبل فحص الحالة: rejectTooLarge يوقف المسجّل بنفسه، فحالته
        // 'inactive' هنا لا تعني فشل البدء — وخطأ too_large يجب أن يبقى كما هو.
        if (this.rejected) return false;
        // start() نجح ظاهريًا لكن المسجّل لم يدخل حالة recording فعلًا
        // (مسارات منتهية/جهاز مشغول): لا مؤقت ولا حالة تسجيل بلا تسجيل.
        if (this.recorder.state !== 'recording') {
            this.releaseStream();
            this.setState('error', { message: 'تعذّر بدء التسجيل — الميكروفون غير متاح حاليًا. جرّب تاني.' });
            return false;
        }
        this.startedAt = Date.now();
        this.timer = setInterval(() => {
            const elapsed = Date.now() - this.startedAt;
            this.onTick(elapsed);
            if (elapsed >= this.maxMs) this.stop();
        }, 250);
        // مسجّل «يسجّل» بلا أي بيانات إطلاقًا: حتى الصمت ينتج بيانات مع
        // timeslice، فغيابها 5ث يعني أن الميكروفون لا يرسل صوتًا أصلًا.
        this._dataWatchdog = setTimeout(() => {
            this._dataWatchdog = null;
            if (this.state === 'recording' && !this.chunks.length) {
                this._handleRecorderFailure('الميكروفون لا يرسل صوتًا — تأكد أنه يعمل وجرّب تاني.');
            }
        }, 5000);
        this.setState('recording');
        return true;
    }

    /** فشل أثناء تسجيل نشط: أنهِ كل شيء وبلّغ الواجهة بـ error صريح
     *  (يخفي الشريط ويعرض رسالة) بدل بقاء الشريط عالقًا. */
    _handleRecorderFailure(message) {
        if (this.state !== 'recording' || this.stopPromise) return; // إيقاف جارٍ: دعه ينتهي هو (حارسه ينهيه)
        this._clearTimers();
        if (this.recorder && this.recorder.state !== 'inactive') {
            this.recorder.onstop = null;
            try { this.recorder.stop(); } catch { /* already stopped */ }
        }
        this.releaseStream();
        this.chunks = [];
        this.result = null;
        this.setState('error', { message });
    }

    /** يوقف ويُرجع {blob, mime, durationMs} للمعاينة.
     *  أثناء انتظار الإذن ('requesting') الإيقاف = إلغاء: لا يوجد تسجيل
     *  بعد ليُوقف، وstop() القديمة كانت لا تفعل شيئًا هنا فيُعلق المستخدم
     *  بلا زر يلغي الانتظار. ولو onstop لم يُطلق أبدًا (سلوك بعض المتصفحات/
     *  WebView) حارس زمني يُنهي الإيقاف بدل التعليق في 'recording' للأبد. */
    stop() {
        if (this.state === 'requesting') { this.cancel(); return Promise.resolve(null); }
        if (this.state !== 'recording' || !this.recorder) return Promise.resolve(null);
        if (this.stopPromise) return this.stopPromise; // إيقاف جارٍ بالفعل
        const durationMs = Math.min(this.maxMs, Date.now() - this.startedAt);
        this._clearTimers();
        this.stopPromise = new Promise((resolve) => {
            let done = false;
            const settle = (value) => {
                if (done) return;
                done = true;
                if (this.stopGuard) { clearTimeout(this.stopGuard); this.stopGuard = null; }
                this.stopPromise = null;
                this._stopSettle = null;
                resolve(value);
            };
            this._stopSettle = settle;
            const finish = () => {
                const mime = (this.recorder?.mimeType || this.chunks[0]?.type || 'audio/webm');
                const blob = new Blob(this.chunks, { type: mime });
                this.releaseStream();
                if (blob.size > this.maxBytes) { this.rejectTooLarge(); settle(null); return; }
                this.result = { blob, mime, durationMs };
                if (!blob.size) { this.setState('error', { message: 'التسجيل فاضي — جرّب تاني.' }); settle(null); return; }
                this.setState('stopped', this.result);
                settle(this.result);
            };
            this.recorder.onstop = finish;
            // حارس: onstop لم يُطلق خلال 1.2ث → أنهِ الإيقاف بالقوة بدل التعليق.
            this.stopGuard = setTimeout(finish, 1200);
            try { this.recorder.stop(); } catch { finish(); }
        });
        return this.stopPromise;
    }

    /** تجاوز الحد: يوقف ويحذف كل ما سُجّل (لا قص)، ويحرر الميكروفون. */
    rejectTooLarge() {
        if (this.rejected) return;
        this.rejected = true;
        this._clearTimers();
        if (this.stopGuard) { clearTimeout(this.stopGuard); this.stopGuard = null; }
        if (this._stopSettle) { const settle = this._stopSettle; this._stopSettle = null; this.stopPromise = null; settle(null); }
        if (this.recorder && this.recorder.state !== 'inactive') {
            this.recorder.onstop = null;
            try { this.recorder.stop(); } catch { /* already stopped */ }
        }
        this.releaseStream();
        this.chunks = [];
        this.result = null;
        this.setState('error', { message: this.tooLargeMessage, reason: 'too_large' });
    }

    /** يلغي في أي مرحلة ويحذف ما سُجّل. */
    cancel() {
        this._clearTimers();
        this._recorderErrored = false;
        if (this.stopGuard) { clearTimeout(this.stopGuard); this.stopGuard = null; }
        // إيقاف معلّق (onstop لم يُطلق): سوِّ وعده بـ null بدل تركه معلقًا للأبد.
        if (this._stopSettle) { const settle = this._stopSettle; this._stopSettle = null; this.stopPromise = null; settle(null); }
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
