/**
 * مرفقات الاستمرارية: قائمة الأنواع والحدود وفحص التوقيع (magic bytes).
 *
 * نسختان متطابقتان حرفيًا (tests/continuity-attachments.test.mjs يفرض ذلك):
 *   supabase/functions/_shared/continuity-media.js   ← دالة الرفع (Deno)
 *   assets/js/continuity/continuity-media.js         ← المتصفح (تنبيه مبكر فقط)
 * والقاعدة (migrations/080_continuity_attachments.sql) تفرض نفس الحدود مرة ثالثة.
 *
 * 1 MiB = 1,048,576 بايت. لا SVG ولا HTML ولا PDF ولا أي نوع آخر مهما كان الامتداد.
 * JavaScript صافٍ بلا اعتماديات: يعمل في Deno وNode والمتصفح.
 */

export const MIB = 1048576;

export const ATTACHMENT_KINDS = Object.freeze({
    image: Object.freeze({ max: 3 * MIB, mimes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']) }),
    video: Object.freeze({ max: 16 * MIB, mimes: Object.freeze(['video/mp4', 'video/webm', 'video/quicktime']) }),
    audio: Object.freeze({ max: 8 * MIB, mimes: Object.freeze(['audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav']) }),
});

export const MAX_ATTACHMENTS_PER_RECORD = 20;
export const MAX_ATTACHMENT_BYTES = 16 * MIB;
export const ATTACHMENT_NAME_MAX = 200;

/** "audio/webm;codecs=opus" ⇒ "audio/webm". */
export function baseMime(mime) {
    return String(mime ?? '').split(';')[0].trim().toLowerCase();
}

export function kindOfMime(mime) {
    const m = baseMime(mime);
    for (const [kind, spec] of Object.entries(ATTACHMENT_KINDS)) {
        if (spec.mimes.includes(m)) return kind;
    }
    return null;
}

/**
 * فحص ما يعلنه العميل قبل أي بايت: النوع، والـMIME ضمن نوعه، والحجم ضمن حده.
 * ⇒ null لو سليم، وإلا { field, reason } بنفس أسماء أخطاء القاعدة.
 */
export function checkDeclared({ kind, mime, size }) {
    const spec = ATTACHMENT_KINDS[kind];
    if (!spec) return { field: 'kind', reason: 'not_allowed' };
    if (!spec.mimes.includes(baseMime(mime))) return { field: 'mime', reason: 'not_allowed' };
    if (!Number.isSafeInteger(size) || size <= 0) return { field: 'size', reason: 'invalid' };
    if (size > spec.max) return { field: 'size', reason: 'too_large' };
    return null;
}

const at = (b, i, bytes) => bytes.every((x, k) => b[i + k] === x);
const ascii = (b, i, s) => at(b, i, [...s].map((c) => c.charCodeAt(0)));

/** الحاوية من أول البايتات. ⇒ 'png' | 'jpeg' | 'gif' | 'webp' | 'wav' | 'isobmff' | 'quicktime' | 'ebml' | 'ogg' | 'mp3' | null */
export function sniffContainer(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (b.length < 4) return null;
    if (at(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
    if (at(b, 0, [0xff, 0xd8, 0xff])) return 'jpeg';
    if (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) return 'gif';
    if (ascii(b, 0, 'RIFF') && b.length >= 12) {
        if (ascii(b, 8, 'WEBP')) return 'webp';
        if (ascii(b, 8, 'WAVE')) return 'wav';
        return null;
    }
    if (b.length >= 12 && ascii(b, 4, 'ftyp')) return ascii(b, 8, 'qt  ') ? 'quicktime' : 'isobmff';
    // QuickTime قديم يبدأ بذرّة أخرى غير ftyp
    if (b.length >= 8 && ['moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].some((t) => ascii(b, 4, t))) return 'quicktime';
    if (at(b, 0, [0x1a, 0x45, 0xdf, 0xa3])) return 'ebml';
    if (ascii(b, 0, 'OggS')) return 'ogg';
    if (ascii(b, 0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
    return null;
}

const CONTAINERS = Object.freeze({
    'image/png': ['png'],
    'image/jpeg': ['jpeg'],
    'image/gif': ['gif'],
    'image/webp': ['webp'],
    'video/mp4': ['isobmff'],
    'video/quicktime': ['quicktime', 'isobmff'],
    'video/webm': ['ebml'],
    'audio/webm': ['ebml'],
    'audio/ogg': ['ogg'],
    'audio/mpeg': ['mp3'],
    'audio/mp4': ['isobmff'],
    'audio/wav': ['wav'],
    'audio/x-wav': ['wav'],
});

/** هل البايتات الأولى تطابق الـMIME المعلن؟ (لا يكفي الامتداد ولا ما يقوله المتصفح.) */
export function signatureMatches(mime, bytes) {
    const allowed = CONTAINERS[baseMime(mime)];
    const found = sniffContainer(bytes);
    return Boolean(allowed && found && allowed.includes(found));
}

/** اسم العرض: آخر جزء من المسار، بلا محارف تحكم أو اتجاه، مقصوص. ⇒ نص أو null. */
export function cleanDisplayName(name) {
    const last = String(name ?? '').split(/[\\/]/).pop();
    // محارف التحكم (C0/C1) وعلامات الاتجاه/العرض الصفري التي تُستخدم لتزييف الامتداد.
    const cleaned = last.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').trim();
    return cleaned ? [...cleaned].slice(0, ATTACHMENT_NAME_MAX).join('') : null;
}

/** «1.5 ميجا» إلخ للعرض. */
export function formatBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1024) return `${n} بايت`;
    if (n < MIB) return `${Math.round(n / 1024)} كيلو`;
    const v = n / MIB;
    return `${Number.isInteger(v) ? v : v.toFixed(v < 10 ? 1 : 0)} ميجا`;
}
