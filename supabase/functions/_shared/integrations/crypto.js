// ============================================================================
// crypto.js — مركز التكاملات: التشفير والتوقيع.
//
// Web Crypto فقط (متاح في Deno وفي Node 22)، فالملف نفسه يُختبر في node بلا
// نسخة ثانية من المنطق.
//
//   • بيانات الاعتماد: AES-256-GCM. المفتاح = SHA-256(IHUB_ENC_KEY) — نفس اشتقاق
//     INTEGRATIONS_ENC_KEY القائم، لكن بسرّ منفصل. AAD = معرّف الربط والمزوّد،
//     فالنص المشفّر المنسوخ من ربط إلى آخر لا يُفك (لا تبديل أسرار بين الشركات).
//   • التواقيع: HMAC-SHA256 ومقارنة ثابتة الزمن.
// ============================================================================

const enc = new TextEncoder();
const dec = new TextDecoder();

export const CIPHER_PREFIX = 'ihub1';

export function bytesToB64(bytes) {
    let s = '';
    const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(s);
}

export function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

export function bytesToB64Url(bytes) {
    return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64UrlToBytes(s) {
    const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
    return b64ToBytes(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

export function bytesToHex(bytes) {
    return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(byteLength = 32) {
    return bytesToB64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Hex(input) {
    const data = typeof input === 'string' ? enc.encode(input) : input;
    return bytesToHex(await crypto.subtle.digest('SHA-256', data));
}

/** مقارنة ثابتة الزمن لنصّين (لا تختصر عند أول فرق). */
export function timingSafeEqual(a, b) {
    const x = enc.encode(String(a ?? ''));
    const y = enc.encode(String(b ?? ''));
    let diff = x.length ^ y.length;
    const n = Math.max(x.length, y.length);
    for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
    return diff === 0;
}

async function hmacKey(secret) {
    const raw = typeof secret === 'string' ? enc.encode(secret) : secret;
    return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/** HMAC-SHA256 كبايتات. data نص أو Uint8Array (الجسم الخام كما وصل). */
export async function hmacSha256(secret, data) {
    const key = await hmacKey(secret);
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes));
}

async function aesKey(secret) {
    if (!secret || String(secret).length < 32) {
        throw new Error('IHUB_ENC_KEY missing or shorter than 32 characters');
    }
    const material = await crypto.subtle.digest('SHA-256', enc.encode(String(secret)));
    return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export function credentialAad(connectionId, provider) {
    return `ihub:v1:${connectionId}:${provider}`;
}

/** يشفّر كائن JSON. الناتج: ihub1.<iv b64url>.<ciphertext b64url>. */
export async function encryptJson(secret, payload, aad) {
    if (!aad) throw new Error('AAD is required');
    const key = await aesKey(secret);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(JSON.stringify(payload)));
    return `${CIPHER_PREFIX}.${bytesToB64Url(iv)}.${bytesToB64Url(new Uint8Array(cipher))}`;
}

export async function decryptJson(secret, text, aad) {
    const parts = String(text || '').split('.');
    if (parts.length !== 3 || parts[0] !== CIPHER_PREFIX) throw new Error('Unrecognised ciphertext format');
    const key = await aesKey(secret);
    const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64UrlToBytes(parts[1]), additionalData: enc.encode(aad) }, key, b64UrlToBytes(parts[2]));
    return JSON.parse(dec.decode(plain));
}
