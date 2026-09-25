/**
 * chat-attachments.js
 * ------------------------------------------------------------
 * مرفقات الشات (صور، ملفات، رسائل صوتية) — مشتركة بين الويدجت العائم
 * (chat-widget.js) وصفحة الشات الكاملة ولوحة الأدمن (chat-logic.js).
 *
 * البنية القائمة، لا نظام موازٍ:
 *   • مستودع Supabase الخاص chat-attachments، المسار <uid>/<session>-<ts>-<rand>.<ext>
 *     (سياسة الرفع القائمة: مجلد المستخدم نفسه فقط).
 *   • الرسالة تحمل المسار — لا رابطًا — ويُوقَّع وقت العرض (storage-urls.js).
 *   • الصور في image_url والصوت في audio_url كما كانت، و attachment (054)
 *     يحمل الاسم والنوع والحجم، والملفات العادية فيه وحده.
 *
 * التحقق هنا تجربة استخدام. الفرض على الخادم (054): حد الحجم وقائمة
 * الأنواع على المستودع، ومُحفِّز يرفض أي مسار ليس في مجلد المرسل أو غير
 * موجود. لا شيء في هذا الملف يثق في المتصفح.
 *
 * بلا استيرادات: Supabase والتوقيع يُمرَّران كمعاملات، فالأجزاء النقية
 * تُختبر في Node (tests/chat-attachments-model.test.mjs).
 * ------------------------------------------------------------
 */

export const CHAT_ATTACHMENTS_BUCKET = 'chat-attachments';
export const MAX_ATTACHMENTS_PER_SEND = 4;

// النوع ← الامتدادات المقبولة. يجب أن يتفق الامتداد و MIME معًا.
const TYPES = Object.freeze({
    image: {
        max: 5 * 1024 * 1024,
        mimes: { 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/webp': ['webp'], 'image/gif': ['gif'] }
    },
    file: {
        max: 10 * 1024 * 1024,
        mimes: {
            'application/pdf': ['pdf'],
            'text/plain': ['txt', 'log'],
            'text/csv': ['csv'],
            'application/msword': ['doc'],
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
            'application/vnd.ms-excel': ['xls'],
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
            'application/vnd.ms-powerpoint': ['ppt'],
            'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx']
        }
    },
    audio: {
        max: 10 * 1024 * 1024,
        mimes: { 'audio/webm': ['webm'], 'audio/ogg': ['ogg', 'oga'], 'audio/mp4': ['m4a', 'mp4'], 'audio/mpeg': ['mp3'], 'audio/wav': ['wav'] }
    }
});

/** قيمة accept لحقل اختيار الملف (الصور والملفات؛ الصوت يأتي من المسجّل). */
export const FILE_PICKER_ACCEPT = [
    ...Object.keys(TYPES.image.mimes), ...Object.keys(TYPES.file.mimes),
    ...Object.values(TYPES.image.mimes).flat().map((e) => `.${e}`),
    ...Object.values(TYPES.file.mimes).flat().map((e) => `.${e}`)
].join(',');

/** «audio/webm;codecs=opus» → «audio/webm». */
export function baseMime(mime) {
    return String(mime || '').split(';')[0].trim().toLowerCase();
}

export function extensionOf(name) {
    const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
}

export function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * @param {{name:string, type:string, size:number}} file
 * @param {'image'|'file'|'audio'} [expectKind] - للمسجّل الصوتي: يفرض النوع
 * @returns {{ok:true, kind:string, mime:string, ext:string} | {ok:false, error:string}}
 */
export function validateFile(file, expectKind) {
    if (!file || typeof file.size !== 'number') return { ok: false, error: 'ملف غير صالح.' };
    if (file.size <= 0) return { ok: false, error: 'الملف فاضي.' };
    const mime = baseMime(file.type);
    const ext = extensionOf(file.name);
    for (const [kind, rule] of Object.entries(TYPES)) {
        if (expectKind && kind !== expectKind) continue;
        const exts = rule.mimes[mime];
        if (!exts) continue;
        // الامتداد يجب أن يطابق النوع (ملف .exe بنوع image/png مرفوض)؛ التسجيل بلا اسم يُقبل بامتداد نوعه
        if (ext && !exts.includes(ext)) return { ok: false, error: `امتداد الملف (.${ext}) لا يطابق نوعه.` };
        if (file.size > rule.max) {
            return { ok: false, error: `${kind === 'image' ? 'الصورة' : kind === 'audio' ? 'التسجيل' : 'الملف'} أكبر من الحد المسموح (${formatBytes(rule.max)}).` };
        }
        return { ok: true, kind, mime, ext: ext || exts[0] };
    }
    return { ok: false, error: 'نوع الملف غير مدعوم. المسموح: صور (PNG, JPG, WEBP, GIF) وملفات (PDF, Word, Excel, PowerPoint, TXT, CSV).' };
}

/** مسار داخل مجلد المستخدم — السياسة والمُحفِّز على الخادم يفرضان نفس القاعدة. */
export function buildObjectPath(userId, sessionId, ext, now = Date.now(), rand = Math.random) {
    const safeExt = String(ext || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
    const token = Math.floor(rand() * 36 ** 6).toString(36).padStart(6, '0');
    return `${userId}/${sessionId}-${now}-${token}.${safeExt}`;
}

/** اسم آمن للعرض (بلا مسارات ولا محارف تحكم)، بطول معقول. */
export function displayName(name) {
    const clean = String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!clean) return 'مرفق';
    return clean.length > 120 ? `${clean.slice(0, 80)}…${clean.slice(-30)}` : clean;
}

/** يبني حقول الرسالة (image_url / audio_url / attachment) لمرفق مرفوع. */
export function messageFieldsFor({ kind, path, name, mime, size, durationMs }) {
    const attachment = { kind, path, name: displayName(name), mime: baseMime(mime), size: Number(size) || 0 };
    if (kind === 'audio' && Number.isFinite(durationMs)) attachment.duration_ms = Math.round(durationMs);
    const fields = { attachment };
    if (kind === 'image') fields.image_url = path;
    if (kind === 'audio') fields.audio_url = path;
    return fields;
}

/** مرفق الرسالة من أي شكل: attachment (054)، أو image_url / audio_url القديمة. */
export function attachmentFromMessage(msg) {
    if (!msg) return null;
    const a = msg.attachment;
    if (a && typeof a === 'object' && typeof a.path === 'string' && ['image', 'file', 'audio'].includes(a.kind)) {
        return { kind: a.kind, path: a.path, name: displayName(a.name), mime: a.mime || null, size: Number(a.size) || null, durationMs: a.duration_ms ?? null };
    }
    if (msg.image_url) return { kind: 'image', path: msg.image_url, name: 'صورة', mime: null, size: null, durationMs: null };
    if (msg.audio_url) return { kind: 'audio', path: msg.audio_url, name: 'رسالة صوتية', mime: null, size: null, durationMs: null };
    return null;
}

export function formatDuration(ms) {
    const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const FILE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>';

/**
 * HTML المرفق داخل فقاعة الرسالة. الروابط **لا** تُكتب هنا: عناصر تحمل
 * data-storage-path وتُوقَّع لاحقًا (hydrateAttachments). escape إلزامي.
 */
export function renderAttachmentHtml(att, escapeHtml) {
    if (!att) return '';
    const path = escapeHtml(att.path);
    const name = escapeHtml(att.name || 'مرفق');
    if (att.kind === 'image') {
        return `<button type="button" class="cw-att cw-att-image" data-att-kind="image" aria-label="عرض الصورة: ${name}">
            <img data-storage-path="${path}" alt="${name}" loading="lazy" decoding="async" hidden>
            <span class="cw-att-loading" aria-hidden="true"></span></button>`;
    }
    if (att.kind === 'audio') {
        return `<div class="cw-att cw-att-audio" data-att-kind="audio">
            <audio data-storage-path="${path}" controls preload="none" aria-label="${name}"></audio>
            ${att.durationMs ? `<span class="cw-att-meta" dir="ltr">${escapeHtml(formatDuration(att.durationMs))}</span>` : ''}</div>`;
    }
    const meta = [att.size ? formatBytes(att.size) : null, extensionOf(att.name)?.toUpperCase() || null].filter(Boolean).join(' · ');
    return `<a class="cw-att cw-att-file" data-att-kind="file" data-storage-path="${path}" data-download="1" href="#" rel="noopener" target="_blank" aria-label="تحميل الملف: ${name}">
        <span class="cw-att-file-icon">${FILE_ICON}</span>
        <span class="cw-att-file-text"><span class="cw-att-file-name">${name}</span>${meta ? `<span class="cw-att-meta" dir="ltr">${escapeHtml(meta)}</span>` : ''}</span></a>`;
}

/**
 * يوقّع كل مرفقات جزء من الصفحة دفعة واحدة. sign(paths[], {download}) → urls[].
 * مرفق فشل توقيعه يُعلَّم «غير متاح» بدل أن يُسقط الرسالة.
 */
export async function hydrateAttachments(root, sign) {
    if (!root || typeof sign !== 'function') return;
    const els = Array.from(root.querySelectorAll('[data-storage-path]'));
    if (!els.length) return;
    const views = els.filter((el) => !el.dataset.download);
    const downloads = els.filter((el) => el.dataset.download);
    const apply = (list, urls) => list.forEach((el, i) => {
        const url = urls?.[i];
        el.removeAttribute('data-storage-path');
        const box = el.closest('.cw-att') || el;
        if (!url) { box.classList.add('is-unavailable'); box.setAttribute('title', 'المرفق غير متاح'); return; }
        if (el.tagName === 'A') el.href = url;
        else { el.src = url; el.hidden = false; }
        box.classList.add('is-ready');
    });
    try {
        if (views.length) apply(views, await sign(views.map((el) => el.dataset.storagePath), { download: false }));
        if (downloads.length) apply(downloads, await sign(downloads.map((el) => el.dataset.storagePath), { download: true }));
    } catch (err) {
        console.warn('[chat-attachments] signing failed:', err?.message || err);
        [...views, ...downloads].forEach((el) => (el.closest('.cw-att') || el).classList.add('is-unavailable'));
    }
}

/**
 * يصغّر صورة كبيرة قبل الرفع (أطول ضلع 2048px) — لا نرفع صورة 12 ميجا
 * من كاميرا الموبايل لتُعرض 240px. GIF (قد يكون متحركًا) وصورة صغيرة تُرفع
 * كما هي. أي فشل يعيد الملف الأصلي (fail-safe).
 */
export async function downscaleImage(file, { maxSide = 2048, minBytes = 1.5 * 1024 * 1024, quality = 0.85 } = {}) {
    try {
        if (!file || baseMime(file.type) === 'image/gif' || file.size < minBytes) return file;
        if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;
        const bmp = await createImageBitmap(file);
        const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(bmp.width * scale);
        canvas.height = Math.round(bmp.height * scale);
        canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
        bmp.close?.();
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
        if (!blob || blob.size >= file.size) return file;
        const name = file.name.replace(/\.[a-z0-9]+$/i, '') + '.jpg';
        return new File([blob], name, { type: 'image/jpeg' });
    } catch {
        return file;
    }
}

/**
 * يرفع ملفًا مع تقدّم حقيقي: رابط رفع موقَّع (createSignedUploadUrl — نفس
 * سياسة الإدراج) + XHR لأحداث التقدم. لو غير متاح، يرجع لـ upload() العادية
 * بلا نسب وسيطة. onProgress(0..1).
 */
export async function uploadAttachment({ supabase, path, file, contentType, onProgress = () => {}, signal }) {
    const bucket = supabase.storage.from(CHAT_ATTACHMENTS_BUCKET);
    const type = baseMime(contentType || file.type) || 'application/octet-stream';
    onProgress(0);
    if (typeof XMLHttpRequest !== 'undefined' && typeof bucket.createSignedUploadUrl === 'function') {
        try {
            const { data, error } = await bucket.createSignedUploadUrl(path);
            if (!error && data?.signedUrl) {
                await new Promise((resolve, reject) => {
                    const xhr = new XMLHttpRequest();
                    xhr.open('PUT', data.signedUrl);
                    xhr.setRequestHeader('Content-Type', type);
                    xhr.setRequestHeader('x-upsert', 'false');
                    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.min(0.99, e.loaded / e.total)); };
                    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`upload ${xhr.status}: ${xhr.responseText?.slice(0, 200)}`)));
                    xhr.onerror = () => reject(new Error('network'));
                    xhr.onabort = () => reject(new Error('aborted'));
                    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
                    xhr.send(file);
                });
                onProgress(1);
                return { path };
            }
        } catch (err) {
            if (err?.message === 'aborted') throw err;
            // رفض الخادم (حجم/نوع/صلاحية) يُعاد كما هو — لا نعيد المحاولة بطريق آخر يخفي السبب
            if (/^upload 4\d\d/.test(err?.message || '')) throw err;
            console.warn('[chat-attachments] signed upload failed, falling back:', err?.message || err);
        }
    }
    const { error } = await bucket.upload(path, file, { cacheControl: '3600', upsert: false, contentType: type });
    if (error) throw error;
    onProgress(1);
    return { path };
}

/** رسالة مفهومة لخطأ رفع (رفض الخادم للحجم/النوع، أو شبكة). */
export function uploadErrorText(err) {
    const m = String(err?.message || err || '');
    if (/413|too large|exceeded|size/i.test(m)) return 'الملف أكبر من الحد المسموح على الخادم.';
    if (/415|mime|type/i.test(m)) return 'نوع الملف مرفوض من الخادم.';
    if (/403|401|policy|security|not allowed|unauthori/i.test(m)) return 'مش مسموح برفع الملف ده.';
    if (/network|failed to fetch|abort/i.test(m)) return 'انقطع الاتصال أثناء الرفع.';
    return 'تعذّر رفع الملف.';
}

/**
 * نص رسالة مرفق بلا تعليق — يُحفظ في message_text حتى تبقى قوائم المحادثات
 * ولوحة الأدمن والنص المحمَّل مفهومة، ويُخفى داخل الفقاعة لأن المرفق نفسه ظاهر.
 */
export function autoLabelFor(att) {
    if (!att) return '';
    if (att.kind === 'image') return 'صورة مرفقة';
    if (att.kind === 'audio') return 'رسالة صوتية';
    return `ملف مرفق: ${displayName(att.name)}`;
}
