// ============================================================
// edge-tts.ts — عميل Edge TTS (محرك التوليد الصوتي المجاني)
// ------------------------------------------------------------
// منقول من مكتبة edge-tts 7.3.1 ‏(communicate.py + drm.py +
// data_classes.py + constants.py):
//   • رابط الـ WS والتوكن الموثوق وإصدار Sec-MS-GEC.
//   • توليد توكن Sec-MS-GEC v2 (هضم SHA-256 معدّل + CS64).
//   • رسالة speech.config ثم SSML، واستقبال مقاطع MP3 حتى turn.end.
//   • تحويل اسم الصوت القصير إلى الصيغة الطويلة التي يرسلها Edge.
//   • تقسيم النص الطويل إلى مقاطع (نفس خوارزمية المكتبة).
//   • إعادة المحاولة مرة واحدة عند 403 مع تصحيح انحراف الساعة من
//     هيدر Date (كما في DRM.handle_client_response_error).
//
// لا تستخدم هذه الوحدة WebSocket الجاهز في Deno لأنه لا يقبل هيدرات
// مخصصة (Origin وUser-Agent وCookie) — بل تنفّذ مصافحة الـ WS يدويًا
// فوق Deno.connectTls، فتقرأ حالة HTTP الفعلية (101 أو 403…).
//
// مرآة المنطق النقي في assets/js/owner/voice-studio-state.js
// (نفس الخوارزميات والثوابت) — أي تغيير هنا يطابق هناك.
// التوليف الحي لم يُتحقق منه من بيئة الوكيل (شبكتها تمنع TLS إلى
// speech.platform.bing.com) — الفحص الحي يجب أن يتم من الـ Function
// المنشورة؛ خطواته في تعليق LIVE CHECK أسفل هذا الملف.
// ============================================================

export const EDGE_TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
export const EDGE_SEC_MS_GEC_VERSION = "2-143.0.3650.75";
export const EDGE_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

const EDGE_HOST = "speech.platform.bing.com";
const EDGE_WSS_PATH = "/consumer/speech/synthesize/readaloud/edge/v1";
const EDGE_VOICE_NAME_PATTERN = /^ar-[A-Z]{2}-[A-Za-z]+Neural$/;
const EDGE_VOICE_DEFAULT = "ar-SA-ZariyahNeural";
const CHROMIUM_VERSION = "143.0.3650.75";
const CONNECT_TIMEOUT_MS = 10000;
const RECEIVE_TIMEOUT_MS = 60000;
const MAX_CHUNK_BYTES = 4096;

/** انحراف الساعة عن خادم مايكروسوفت (ثوانٍ) — يُصحح بعد 403. */
let clockSkewSeconds = 0;

export type EdgeProsody = { rate: string; pitch: string; volume: string };
export interface EdgeSynthesizeOptions {
  text: string;
  voice: string;
  controls?: Record<string, string>;
  voiceType?: string;
}

/* ── أدوات 32-بت ─────────────────────────────────────────────── */

const U32 = (n: number): number => n >>> 0;
const ROTR = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0;
const ROL16 = (v: number): number => (((v << 16) | (v >>> 16)) >>> 0);

function bytesToHexUpper(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(binary);
}

/* ── توليد توكن Sec-MS-GEC (نفس خوارزمية drm.py) ─────────────── */

const SHA256_INITIAL = [
  0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A,
  0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19,
];
const SHA256_DRM_STATE = [
  0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A,
  0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2,
];
const SHA256_DRM_SCHEDULE = [
  0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA,
  0xA622EE8C, 0xD1DD9491, 0xC0DD25A0, 0xF9E70AB6,
  0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33,
  0xD258B060, 0x72766564,
];
const SHA256_ROUND_CONSTANTS = [
  0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1,
  0x923F82A4, 0xAB1C5ED5, 0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3,
  0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174, 0xE49B69C1, 0xEFBE4786,
  0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
  0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147,
  0x06CA6351, 0x14292967, 0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13,
  0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85, 0xA2BFE8A1, 0xA81A664B,
  0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
  0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A,
  0x5B9CCA4F, 0x682E6FF3, 0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208,
  0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2,
];
const SHA256_ADJUSTMENT = 0xC9DC06A7;
const SHA256_BLOCK_CONSTANTS = [
  ...SHA256_ROUND_CONSTANTS.slice(0, 14),
  SHA256_ADJUSTMENT,
  ...SHA256_ROUND_CONSTANTS.slice(15),
];
const SHA256_SIGMA0_ADJUSTMENT = 0x059C0B80;
const SHA256_SIGMA1_ADJUSTMENT = 0x000B92C0;

const CS64_COEFFICIENTS: Array<[number, number]> = [
  [0xE82E91B1, 0xB32700D0], [0x44DE24C6, 0x88DFF51D],
  [0x3BEB65BC, 0x29514038], [0xC89C5933, 0xB328CBDF],
  [0x8D1EC211, 0xD405B4D5], [0x314EF5D5, 0x26E55F3C],
  [0xE92491B1, 0x607801C6], [0xF0A5B9D5, 0x82B2C1FB],
  [0x06064CF3, 0xFA51A3DA], [0xDA79FA60, 0x207CC464],
  [0xBED20560, 0x3C3C74F3], [0x89F9C9F8, 0xD2D14B61],
  [0x35FA38C6, 0xBB04A2C1], [0xCB49E3C6, 0xC5626167],
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xF2F90B1A;
const CS64_ADJUSTMENT1 = 0x0B1A0000;
const WIN_EPOCH = 11644473600;

function sigma0(value: number): number {
  return U32((value >>> 7) ^ (value << 25) ^ (value >>> 18) ^ (value << 14) ^ (value >>> 3));
}

function sigma1(value: number): number {
  return U32((value >>> 17) ^ (value << 15) ^ (value >>> 19) ^ (value << 13) ^ (value >>> 10));
}

function add32(...values: number[]): number {
  return values.reduce((sum, v) => U32(sum + v), 0);
}

function sha256Rounds(state: number[], words: number[], firstRound = 0): number[] {
  let [a, b, c, d, e, f, g, h] = state;
  const constants = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;
  for (let i = firstRound; i < 64; i++) {
    const s1 = U32(ROTR(e, 6) ^ ROTR(e, 11) ^ ROTR(e, 25));
    const ch = U32(g ^ (e & (f ^ g)));
    const temp1 = add32(h, s1, ch, constants[i], words[i]);
    const s0 = U32(ROTR(a, 2) ^ ROTR(a, 13) ^ ROTR(a, 22));
    const maj = U32((a & b) | (c & (a | b)));
    const temp2 = add32(s0, maj);
    h = g; g = f; f = e; e = add32(d, temp1);
    d = c; c = b; b = a; a = add32(temp1, temp2);
  }
  return [a, b, c, d, e, f, g, h];
}

function expandSha256Schedule(words: number[], firstWord = 16): void {
  for (let i = firstWord; i < 64; i++) {
    words.push(add32(sigma1(words[i - 2]), words[i - 7], sigma0(words[i - 15]), words[i - 16]));
  }
}

function sha256DrmInit(data: Uint8Array): number[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const words: number[] = new Array(14).fill(0);
  words.push(U32((data[0] << 16) | (data[1] << 8) | data[2]));
  words.push(view.getUint32(3, false));
  for (let index = 16; index < 30; index++) {
    let value = SHA256_DRM_SCHEDULE[index - 16];
    if (index - 2 >= 14) {
      value += index === 16
        ? U32(sigma1(words[index - 2]) ^ SHA256_SIGMA1_ADJUSTMENT)
        : sigma1(words[index - 2]);
    }
    if (index - 7 >= 14) value += words[index - 7];
    if (index - 15 >= 14) {
      value += index === 29
        ? U32(sigma0(words[index - 15]) ^ SHA256_SIGMA0_ADJUSTMENT)
        : sigma0(words[index - 15]);
    }
    words.push(U32(value));
  }
  words.push(U32(
    sigma1(words[28]) + words[23] + sigma0(words[15]) + words[14]
    + SHA256_ADJUSTMENT - SHA256_ROUND_CONSTANTS[14],
  ));
  expandSha256Schedule(words, 31);
  const working = sha256Rounds(SHA256_DRM_STATE, words, 14);
  return SHA256_INITIAL.map((x, i) => U32(x + working[i]));
}

function sha256DrmDigest(data: Uint8Array): Uint8Array {
  if (data.length < 7) throw new Error("Token salt must contain at least seven bytes");
  const length = 57 + data.length;
  const zeroCount = ((55 - length) % 64 + 64) % 64;
  const padded = new Uint8Array(data.length - 7 + 1 + zeroCount + 8);
  padded.set(data.subarray(7), 0);
  padded[data.length - 7] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = length * 8;
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(padded.length - 4, U32(bitLength), false);
  let state = sha256DrmInit(data.subarray(0, 7));
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words: number[] = [];
    for (let i = 0; i < 16; i++) words.push(view.getUint32(offset + i * 4, false));
    expandSha256Schedule(words);
    const working = sha256Rounds(state, words);
    state = state.map((x, i) => U32(x + working[i]));
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  state.forEach((w, i) => outView.setUint32(i * 4, w, false));
  return out;
}

function wordsLe4Even(data: Uint8Array): number[] {
  const padded = new Uint8Array(Math.ceil(data.length / 4) * 4);
  padded.set(data, 0);
  const view = new DataView(padded.buffer);
  const words: number[] = [];
  for (let i = 0; i < padded.length / 4; i++) words.push(view.getUint32(i * 4, true));
  if (words.length % 2) words.push(0);
  return words;
}

function cs64Digest(data: Uint8Array, digest: Uint8Array): [number, number] {
  const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  const keyA = U32(view.getUint32(0, true) | 1);
  const keyB = U32(view.getUint32(4, true) | 1);
  const factors = [U32(Math.imul(keyA, CS64_FACTOR)), U32(Math.imul(keyB, CS64_FACTOR))];
  const terms = CS64_COEFFICIENTS.map(([coef], i) => U32(Math.imul(coef, factors[i % 2])));
  const offsets = CS64_COEFFICIENTS.map(([, off]) => off);
  const salted = new Uint8Array(data.length + 1);
  salted.set(data, 1);
  for (const [index, word] of wordsLe4Even(salted).entries()) {
    const even = index % 2 === 0;
    let term = Math.imul(word, even ? keyA : keyB);
    let offset = Math.imul(ROL16(word), even ? 0xEF0569FB : 0xC31713DB);
    if (index === 0) {
      term += Math.imul(CS64_ADJUSTMENT0, factors[0]);
      offset += CS64_ADJUSTMENT1;
    }
    terms.push(U32(term));
    offsets.push(U32(offset));
  }
  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;
  for (let index = 0; index < terms.length; index += 2) {
    const x = terms[index];
    const y = terms[index + 1];
    let t = ROL16(U32(offsets[index] + x));
    let q = U32(Math.imul(t, 0x76F50F34));
    swapAcc += U32(Math.imul(ROL16(q), 0xC3EFEA97) + q);
    t = ROL16(U32(offsets[index + 1] + y));
    q = U32(Math.imul(t, 0x1881CE3C));
    swapLast = U32(Math.imul(ROL16(q), 0x35BD1EC9) + q);
    swapAcc = U32(swapAcc + swapLast);
    state = U32(Math.imul(state, keyA) + x);
    state = U32(Math.imul(ROL16(state), 0xCF98B111));
    state = U32(Math.imul(ROL16(state), 0x87085B9F));
    state = U32(Math.imul(ROL16(state), 0x12CEB96D));
    state = U32(Math.imul(ROL16(state), 0x257E1D83));
    acc += state;
    t = U32(Math.imul(state, keyB) + y);
    t = U32(Math.imul(ROL16(t), 0xA27416F5));
    t = U32(Math.imul(ROL16(t), 0xD38396FF));
    state = U32(Math.imul(ROL16(U32(Math.imul(ROL16(t), 0x7C932B89))), 0xBFA49F69));
    acc = U32(acc + state);
  }
  return [U32(swapLast ^ state), U32(swapAcc ^ acc)];
}

export function generateSecMsGec(unixTimestamp: number = Date.now() / 1000): string {
  let ticks = Number(unixTimestamp) + clockSkewSeconds;
  ticks += WIN_EPOCH;
  ticks -= ticks % 300;
  ticks *= 1e9 / 100;
  const strToHash = `${ticks.toFixed(0)}${EDGE_TRUSTED_CLIENT_TOKEN}`;
  const data = new TextEncoder().encode(strToHash);
  const digest = sha256DrmDigest(data);
  const [csA, csB] = cs64Digest(data, digest);
  const csBytes = new Uint8Array(8);
  new DataView(csBytes.buffer).setUint32(0, csA, true);
  new DataView(csBytes.buffer).setUint32(4, csB, true);
  return `${bytesToHexUpper(csBytes)}-${bytesToHexUpper(digest)}`;
}

/* ── SSML وأدوات الاستوديو ───────────────────────────────────────── */

export function removeIncompatibleCharacters(text: string): string {
  return Array.from(String(text ?? "")).map((ch) => {
    const code = ch.codePointAt(0) || 0;
    return (code <= 8 || (code >= 11 && code <= 12) || (code >= 14 && code <= 31)) ? " " : ch;
  }).join("");
}

export function escapeXmlText(text: string): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** الصيغة الطويلة لاسم الصوت كما في TTSConfig ‏(edge-tts). */
export function edgeVoiceSsmlName(voice: string): string {
  const name = String(voice || "");
  const match = /^([a-z]{2,})-([A-Z]{2,})-(.+Neural)$/.exec(name);
  if (!match) return edgeVoiceSsmlName(EDGE_VOICE_DEFAULT);
  const lang = match[1];
  let region = match[2];
  let voiceName = match[3];
  const dash = voiceName.indexOf("-");
  if (dash !== -1) {
    region = `${region}-${voiceName.slice(0, dash)}`;
    voiceName = voiceName.slice(dash + 1);
  }
  return `Microsoft Server Speech Text to Speech Voice (${lang}-${region}, ${voiceName})`;
}

export function buildEdgeSsml(
  { text, voice, rate = "+0%", pitch = "+0Hz", volume = "+0%" }: {
    text: string; voice: string; rate?: string; pitch?: string; volume?: string;
  },
): string {
  const clean = escapeXmlText(removeIncompatibleCharacters(text));
  const safeVoice = EDGE_VOICE_NAME_PATTERN.test(String(voice || "")) ? voice : EDGE_VOICE_DEFAULT;
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${edgeVoiceSsmlName(safeVoice)}'><prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>${clean}</prosody></voice></speak>`;
}

const EDGE_SPEED_RATES: Record<string, number> = { "بطيئة": -15, "متوسطة": 0, "سريعة": 15 };
const EDGE_PITCH_OFFSETS: Record<string, number> = { "عالية": 6, "متوسطة": 0, "منخفضة": -6 };
const EDGE_DEPTH_OFFSETS: Record<string, number> = { "خفيفة": 4, "متوسطة": 0, "عميقة": -4 };
const EDGE_VOICE_TYPE_ADJUST: Record<string, { rate: number; pitch: number }> = {
  "كبار السن": { rate: -10, pitch: -4 },
  "شخصية كارتونية": { rate: 10, pitch: 8 },
  "بالغ": { rate: 0, pitch: 0 },
};

/**
 * يترجم أدوات الاستوديو إلى prosody — مرآة edgeProsodyForControls في
 * voice-studio-state.js. ما لا يدعمه Edge ‏(temp/emotion/drama/
 * purpose) يُتجاهل بصراحة ولا يُرسل.
 */
export function edgeProsodyForControls(
  controls: Record<string, string> = {},
  voiceType = "بالغ",
): EdgeProsody {
  let rate = EDGE_SPEED_RATES[controls?.speed] ?? 0;
  let pitch = (EDGE_PITCH_OFFSETS[controls?.pitch] ?? 0)
    + (EDGE_DEPTH_OFFSETS[controls?.depth] ?? 0);
  const adjust = EDGE_VOICE_TYPE_ADJUST[voiceType] || { rate: 0, pitch: 0 };
  rate += adjust.rate;
  pitch += adjust.pitch;
  const fmt = (n: number, unit: string): string => `${n >= 0 ? "+" : ""}${n}${unit}`;
  return { rate: fmt(rate, "%"), pitch: fmt(pitch, "Hz"), volume: "+0%" };
}

/** سلسلة تاريخ بأسلوب JavaScript كما في date_to_string ‏(edge-tts). */
export function edgeDateString(date: Date = new Date()): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${pad(date.getUTCDate())} ${date.getUTCFullYear()} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

/* ── تقسيم النص (نفس خوارزمية split_text_by_byte_length) ──────────
   ملاحظة موثّقة: عند غياب أي مسافة أو سطر جديد داخل نافذة 4096 بايت
   تعيد المكتبة نقطة تقسيم آمنة من النص الكامل — فينتج مقطع أطول من
   4096 بايت. هذا سلوك المكتبة نفسها، ويُحفظ هنا كما هو. */

function findLastByte(data: Uint8Array, byte: number, limit: number): number {
  for (let i = Math.min(limit, data.length) - 1; i >= 0; i--) {
    if (data[i] === byte) return i;
  }
  return -1;
}

function safeUtf8SplitPoint(data: Uint8Array): number {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let splitAt = data.length;
  while (splitAt > 0) {
    try {
      decoder.decode(data.subarray(0, splitAt));
      return splitAt;
    } catch {
      splitAt--;
    }
  }
  return splitAt;
}

function adjustSplitForXmlEntity(data: Uint8Array, splitAt: number): number {
  const decoder = new TextDecoder();
  while (splitAt > 0) {
    const head = decoder.decode(data.subarray(0, splitAt));
    const amp = head.lastIndexOf("&");
    if (amp === -1) break;
    if (head.indexOf(";", amp) !== -1) break;
    splitAt = amp;
  }
  return splitAt;
}

export function splitEdgeText(text: string, byteLength = MAX_CHUNK_BYTES): string[] {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let rest = encoder.encode(text);
  const chunks: string[] = [];
  while (rest.length > byteLength) {
    let splitAt = findLastByte(rest, 0x0a, byteLength);
    if (splitAt < 0) splitAt = findLastByte(rest, 0x20, byteLength);
    if (splitAt < 0) splitAt = safeUtf8SplitPoint(rest);
    splitAt = adjustSplitForXmlEntity(rest, splitAt);
    if (splitAt <= 0) splitAt = 1;
    const chunk = decoder.decode(rest.subarray(0, splitAt)).trim();
    if (chunk) chunks.push(chunk);
    rest = rest.slice(splitAt);
  }
  const tail = decoder.decode(rest).trim();
  if (tail) chunks.push(tail);
  return chunks;
}

/* ── عميل WebSocket خام فوق TLS ───────────────────────────────────── */

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** قارئ مخزّن يقرأ عددًا دقيقًا من البايتات من دالة سحب. */
export class BufferedReader {
  private buf = new Uint8Array(0);
  private pull: () => Promise<Uint8Array | null>;

  constructor(pull: () => Promise<Uint8Array | null>) {
    this.pull = pull;
  }

  private async fill(minBytes: number): Promise<void> {
    while (this.buf.length < minBytes) {
      const chunk = await this.pull();
      if (chunk === null) throw new Error("Edge TTS: أُغلق الاتصال أثناء القراءة");
      const next = new Uint8Array(this.buf.length + chunk.length);
      next.set(this.buf, 0);
      next.set(chunk, this.buf.length);
      this.buf = next;
    }
  }

  async readExact(n: number, timeoutMs: number): Promise<Uint8Array> {
    await withTimeout(this.fill(n), timeoutMs, "Edge TTS: انتهت مهلة استقبال الصوت");
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }

  async readUntil(delim: Uint8Array, timeoutMs: number): Promise<Uint8Array> {
    const idx = (): number => {
      for (let i = 0; i + delim.length <= this.buf.length; i++) {
        let ok = true;
        for (let j = 0; j < delim.length; j++) {
          if (this.buf[i + j] !== delim[j]) { ok = false; break; }
        }
        if (ok) return i;
      }
      return -1;
    };
    while (idx() < 0) {
      await withTimeout(this.fill(this.buf.length + 1), timeoutMs, "Edge TTS: انتهت مهلة الاتصال");
    }
    const at = idx();
    const out = this.buf.slice(0, at);
    this.buf = this.buf.slice(at + delim.length);
    return out;
  }
}

async function secWebSocketAccept(key: string): Promise<string> {
  const data = new TextEncoder().encode(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
  const digest = await crypto.subtle.digest("SHA-1", data);
  return bytesToBase64(new Uint8Array(digest));
}

function randomHexUpper(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bytesToHexUpper(buf);
}

function connectId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function wsHeaders(): Record<string, string> {
  return {
    "Pragma": "no-cache",
    "Cache-Control": "no-cache",
    "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
    "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_VERSION.split(".")[0]}.0.0.0 Safari/537.36 Edg/${CHROMIUM_VERSION.split(".")[0]}.0.0.0`,
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,en;q=0.9",
    "Cookie": `muid=${randomHexUpper(16)};`,
  };
}

/** يشفر إطار WS نصيًا/ثنائيًا (مقنّع — إطارات العميل دائمًا مقنّعة). */
export function encodeWsFrame(opcode: number, payload: Uint8Array, maskKey?: Uint8Array): Uint8Array {
  const mask = maskKey || (() => {
    const m = new Uint8Array(4);
    crypto.getRandomValues(m);
    return m;
  })();
  let header: Uint8Array;
  if (payload.length < 126) {
    header = new Uint8Array([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    header = new Uint8Array([0x80 | opcode, 0x80 | 126, (payload.length >> 8) & 0xff, payload.length & 0xff]);
  } else {
    header = new Uint8Array(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    new DataView(header.buffer).setUint32(6, payload.length, false);
  }
  const masked = new Uint8Array(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  const frame = new Uint8Array(header.length + 4 + masked.length);
  frame.set(header, 0);
  frame.set(mask, header.length);
  frame.set(masked, header.length + 4);
  return frame;
}

export interface WsMessage {
  opcode: number;
  data: Uint8Array;
}

/**
 * يقرأ رسالة WS كاملة (يجمع التجزئة). يعيد null عند إطار الإغلاق.
 * يرد تلقائيًا على ping بـ pong.
 */
export async function readWsMessage(
  reader: BufferedReader,
  sendFrame: (frame: Uint8Array) => Promise<void>,
  timeoutMs: number = RECEIVE_TIMEOUT_MS,
): Promise<WsMessage | null> {
  let opcode = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const head = await reader.readExact(2, timeoutMs);
    const fin = (head[0] & 0x80) !== 0;
    const op = head[0] & 0x0f;
    const masked = (head[1] & 0x80) !== 0;
    let len = head[1] & 0x7f;
    if (len === 126) {
      const ext = await reader.readExact(2, timeoutMs);
      len = (ext[0] << 8) | ext[1];
    } else if (len === 127) {
      const ext = await reader.readExact(8, timeoutMs);
      const view = new DataView(ext.buffer, ext.byteOffset, ext.byteLength);
      if (view.getUint32(0, false) !== 0) throw new Error("Edge TTS: رسالة أكبر من المتوقع");
      len = view.getUint32(4, false);
    }
    let mask: Uint8Array | null = null;
    if (masked) mask = await reader.readExact(4, timeoutMs);
    let payload = await reader.readExact(len, timeoutMs);
    if (mask) {
      const unmasked = new Uint8Array(payload.length);
      for (let i = 0; i < payload.length; i++) unmasked[i] = payload[i] ^ mask[i % 4];
      payload = unmasked;
    }
    if (op === 9) {
      await sendFrame(encodeWsFrame(10, payload));
      continue;
    }
    if (op === 8) return null;
    if (op === 0) {
      chunks.push(payload);
    } else {
      opcode = op;
      chunks.push(payload);
    }
    if (fin) {
      let total = 0;
      for (const c of chunks) total += c.length;
      const data = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { data.set(c, off); off += c.length; }
      return { opcode, data };
    }
  }
}

function parseHeaders(headText: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of headText.split("\r\n")) {
    const i = line.indexOf(":");
    if (i > 0) headers.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return headers;
}

/** يحلل رسالة نصية: الترويسات حتى ‎\r\n\r\n‎ والجسم بعدها. */
export function parseTextMessage(data: Uint8Array): { headers: Map<string, string>; body: string } {
  const text = new TextDecoder().decode(data);
  const sep = text.indexOf("\r\n\r\n");
  const head = sep >= 0 ? text.slice(0, sep) : text;
  const body = sep >= 0 ? text.slice(sep + 4) : "";
  return { headers: parseHeaders(head), body };
}

/**
 * يحلل رسالة ثنائية: أول بايتين طول الترويسة (يشمل البايتين
 * نفسيهما — كما في get_headers_and_data ‏(edge-tts))، ثم الترويسات،
 * ثم ‎\r\n‎، ثم حمولة الصوت.
 */
export function parseBinaryMessage(data: Uint8Array): { headers: Map<string, string>; audio: Uint8Array } {
  if (data.length < 2) throw new Error("Edge TTS: رسالة ثنائية قصيرة");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const headerLength = view.getUint16(0, false);
  if (headerLength > data.length) throw new Error("Edge TTS: طول ترويسة غير صالح");
  const headText = new TextDecoder().decode(data.subarray(2, headerLength));
  return { headers: parseHeaders(headText), audio: data.slice(headerLength + 2) };
}

class EdgeHttpError extends Error {
  status: number;
  date: string | null;
  constructor(status: number, date: string | null) {
    super(`Edge TTS: رفض الخادم الاتصال (HTTP ${status})`);
    this.status = status;
    this.date = date;
  }
}

interface WsConnection {
  conn: Deno.Conn;
  reader: BufferedReader;
}

async function wsConnect(): Promise<WsConnection> {
  const gec = generateSecMsGec();
  const query = `${EDGE_WSS_PATH}?TrustedClientToken=${EDGE_TRUSTED_CLIENT_TOKEN}`
    + `&ConnectionId=${connectId()}&Sec-MS-GEC=${encodeURIComponent(gec)}`
    + `&Sec-MS-GEC-Version=${encodeURIComponent(EDGE_SEC_MS_GEC_VERSION)}`;
  const conn = await withTimeout(
    Deno.connectTls({ hostname: EDGE_HOST, port: 443 }),
    CONNECT_TIMEOUT_MS,
    "Edge TTS: انتهت مهلة الاتصال",
  );
  const keyBytes = new Uint8Array(16);
  crypto.getRandomValues(keyBytes);
  const key = bytesToBase64(keyBytes);
  const requestLines = [
    `GET ${query} HTTP/1.1`,
    `Host: ${EDGE_HOST}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    ...Object.entries(wsHeaders()).map(([k, v]) => `${k}: ${v}`),
    "",
    "",
  ];
  const pull = async (): Promise<Uint8Array | null> => {
    const buf = new Uint8Array(8192);
    const n = await conn.read(buf);
    return n === null ? null : buf.slice(0, n);
  };
  const reader = new BufferedReader(pull);
  try {
    await conn.write(new TextEncoder().encode(requestLines.join("\r\n")));
    const head = await reader.readUntil(
      new TextEncoder().encode("\r\n\r\n"),
      CONNECT_TIMEOUT_MS,
    );
    const headText = new TextDecoder().decode(head);
    const lines = headText.split("\r\n");
    const status = parseInt((lines[0] || "").split(" ")[1] || "0", 10);
    const resHeaders = parseHeaders(lines.slice(1).join("\r\n"));
    if (status !== 101) {
      throw new EdgeHttpError(status, resHeaders.get("date") || null);
    }
    const accept = resHeaders.get("sec-websocket-accept") || "";
    if (accept !== (await secWebSocketAccept(key))) {
      throw new Error("Edge TTS: فشل التحقق من مصافحة الاتصال");
    }
  } catch (err) {
    try { conn.close(); } catch { /* تجاهل */ }
    throw err;
  }
  return { conn, reader };
}

function configMessage(): string {
  return `X-Timestamp:${edgeDateString()}\r\n`
    + "Content-Type:application/json; charset=utf-8\r\n"
    + "Path:speech.config\r\n\r\n"
    + `{"context":{"synthesis":{"audio":{"metadataoptions":{`
    + `"sentenceBoundaryEnabled":"true","wordBoundaryEnabled":"false"},`
    + `"outputFormat":"${EDGE_OUTPUT_FORMAT}"`
    + "}}}}\r\n";
}

function ssmlMessage(ssml: string): string {
  return `X-RequestId:${connectId()}\r\n`
    + "Content-Type:application/ssml+xml\r\n"
    + `X-Timestamp:${edgeDateString()}Z\r\n`
    + "Path:ssml\r\n\r\n"
    + ssml;
}

async function synthesizeChunk(ssml: string): Promise<Uint8Array> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let ws: WsConnection | null = null;
    try {
      ws = await wsConnect();
      const sendFrame = async (frame: Uint8Array): Promise<void> => {
        await ws!.conn.write(frame);
      };
      const sendText = async (text: string): Promise<void> => {
        await sendFrame(encodeWsFrame(1, new TextEncoder().encode(text)));
      };
      await sendText(configMessage());
      await sendText(ssmlMessage(ssml));
      const parts: Uint8Array[] = [];
      let audioReceived = false;
      while (true) {
        const msg = await readWsMessage(ws.reader, sendFrame);
        if (msg === null) break;
        if (msg.opcode === 1) {
          const { headers } = parseTextMessage(msg.data);
          if (headers.get("Path") === "turn.end") break;
          continue;
        }
        if (msg.opcode !== 2) continue;
        const { headers, audio } = parseBinaryMessage(msg.data);
        if (headers.get("Path") !== "audio") continue;
        const contentType = headers.get("Content-Type");
        if (contentType === undefined || contentType === null) {
          if (audio.length === 0) continue;
          throw new Error("Edge TTS: رسالة صوت بلا نوع محتوى");
        }
        if (contentType !== "audio/mpeg") {
          throw new Error(`Edge TTS: نوع محتوى صوتي غير متوقع (${contentType})`);
        }
        if (audio.length === 0) throw new Error("Edge TTS: رسالة صوت بلا بيانات");
        audioReceived = true;
        parts.push(audio);
      }
      try {
        await sendFrame(encodeWsFrame(8, new Uint8Array(0)));
      } catch { /* تجاهل */ }
      try { ws.conn.close(); } catch { /* تجاهل */ }
      if (!audioReceived) throw new Error("Edge TTS: لم يصل أي صوت من الخدمة");
      let total = 0;
      for (const p of parts) total += p.length;
      const out = new Uint8Array(total);
      let off = 0;
      for (const p of parts) { out.set(p, off); off += p.length; }
      return out;
    } catch (err) {
      lastError = err;
      if (ws) { try { ws.conn.close(); } catch { /* تجاهل */ } }
      // إعادة واحدة عند 403 مع تصحيح انحراف الساعة (كما في المكتبة).
      if (err instanceof EdgeHttpError && err.status === 403 && err.date) {
        const serverTime = Date.parse(err.date);
        if (!Number.isNaN(serverTime)) {
          clockSkewSeconds += (serverTime / 1000) - (Date.now() / 1000 + clockSkewSeconds);
          continue;
        }
      }
      throw err;
    }
  }
  throw lastError;
}

/**
 * يولّد صوت MP3 لنص كامل عبر Edge TTS (بلا مفتاح). يرمي خطأً عربيًا
 * يذكر المحرك والسبب عند الفشل — لا سقوط صامت.
 */
export async function synthesizeEdge(options: EdgeSynthesizeOptions): Promise<Uint8Array> {
  const text = String(options.text || "").trim();
  if (!text) throw new Error("Edge TTS: النص مطلوب للتوليد الصوتي");
  const voice = String(options.voice || "");
  if (!EDGE_VOICE_NAME_PATTERN.test(voice)) {
    throw new Error(`Edge TTS: اسم صوت غير صالح (${voice || "فارغ"})`);
  }
  const prosody = edgeProsodyForControls(options.controls || {}, options.voiceType || "بالغ");
  // التقسيم على النص المنظّف، والهروب يتم داخل buildEdgeSsml لكل مقطع
  // (فلا خطر من قطع كيان XML أثناء التقسيم).
  const chunks = splitEdgeText(removeIncompatibleCharacters(text));
  const parts: Uint8Array[] = [];
  for (const chunk of chunks) {
    const ssml = buildEdgeSsml({ text: chunk, voice, ...prosody });
    parts.push(await synthesizeChunk(ssml));
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/* ── LIVE CHECK (فحص حي يدوي بعد النشر — لا يُنفذ هنا) ─────────────
   من الـ Function المنشورة (بعد supabase functions deploy voice-studio):
   1. استدعِ الإجراء tts بنص «أهلاً بيك في مدعوم» وصوت ar-EG-SalmaNeural
      (engine: edge) — يجب أن يرجع audioBase64 بصيغة audio/mpeg.
   2. كرر بصوت ar-EG-ShakirNeural ثم بصوت سعودي ar-SA-HamedNeural.
   3. شغّل ملف mp3 الناتج وتأكد من وضوح الصوت العربي ولهجته.
   4. جرّب نصًا طويلًا (أكثر من 4096 بايت) للتأكد من تقسيم المقاطع.
   الشبكة في بيئة الوكيل تمنع TLS إلى speech.platform.bing.com، لذلك
   لم يُتحقق من التوليف حيًا هنا — لا يُدّعى نجاحه قبل هذا الفحص. */
