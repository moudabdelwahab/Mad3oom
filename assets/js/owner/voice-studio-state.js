/**
 * voice-studio-state.js — المنطق النقي للاستوديو الصوتي (مدعوم).
 *
 * بلا DOM وبلا نداءات شبكة، فيُختبر مباشرة في node:
 *  • أقفال اللهجات الصوتية (phonetic locks) وبرومبت TTS — مرآة ما في
 *    supabase/functions/voice-studio/index.ts (نفس النصوص).
 *  • بصمة الصوت، وتغليف PCM في WAV، ودمج مقاطع WAV.
 *  • تنسيق الوقت، وبناء SRT، وغلاف DOCX، وأسماء ملفات الإخراج.
 *  • توزيع الأصوات الذكي (كتاب صوتي وبودكاست).
 *  • محرك Edge TTS: خريطة الأصوات، وبناء SSML من أدوات الاستوديو،
 *    وتوليد توكن Sec-MS-GEC — مرآة ما في
 *    supabase/functions/voice-studio/edge-tts.ts (نفس الخوارزمية،
 *    محمولة من مكتبة edge-tts 7.3.1 ‏(drm.py + communicate.py)).
 *  • فحص إعادة التسمية: لا أثر للاسم القديم في البيانات.
 *
 * ملاحظة: نمط العلامة المحظورة مبني من مقاطع متصلة قصدًا، حتى يبقى
 * هذا الملف نفسه نظيفًا عند فحص إعادة التسمية بـ grep.
 */

import { EDGE_VOICE_MAP, EDGE_VOICE_DEFAULT } from './voice-studio-data.js';

export const EDGE_ACTIONS = [
  'preprocess-text',
  'identify-key-sentences',
  'analyze-and-segment',
  'transcribe-media',
  'extract-text',
  'generate-podcast-script',
  'tts',
  'generate-stream',
];

/* أقفال اللهجات الصوتية — من server.ts في المشروع الأصلي، حرفيًا. */
export const DIALECT_PHONETIC_LOCKS = {
  egyptian: `STRICT EGYPTIAN PHONETIC LOCK: 1. Pronounce ALL words using natural Egyptian phonetics. 2. (ج) must be soft 'g'. 3. Casual rhythm.`,
  saudi: `STRICT SAUDI PHONETIC LOCK: 1. Authentic Saudi prosody. 2. Najdi/Hejazi inflections.`,
  khaleeji: `STRICT KHALEEJI PHONETIC LOCK: 1. Gulf White phonetics. 2. Traditional elongation.`,
  levantine: `STRICT LEVANTINE PHONETIC LOCK: 1. Syrian/Levantine melodic prosody.`,
  sudanese: `STRICT SUDANESE PHONETIC LOCK: 1. Authentic Sudanese phonetics. 2. Proper pronunciation of Sudanese 'qaf' and 'jeem'. 3. Calm, warm Sudanese rhythmic pacing.`,
  yemeni: `STRICT YEMENI PHONETIC LOCK: 1. Clear Arabic pronunciation with a natural urban Yemeni tone. 2. Neutral urban Yemeni style (avoid aggressive tribal sub-dialects). 3. Avoid Gulf-style elongation or Saudi heavy inflections. 4. Calm and natural rhythmic pacing.`,
  lebanese: `STRICT LEBANESE PHONETIC LOCK: 1. Soft, smooth Arabic pronunciation with light Lebanese musical intonation. 2. Natural urban Lebanese style (Beirut/Modern urban style). 3. Avoid Gulf-style heaviness or strong Egyptian influence. 4. Natural conversational pacing. 5. Specific vowel elongation characteristic of elegant Lebanese speech.`,
  fusha: `STRICT MSA LOCK: 1. Formal academic Arabic. 2. Correct case endings.`,
};

export const PURPOSE_DIRECTIVES = {
  'إعلان': 'DELIVERY STYLE: Advertisement - energetic, engaging, confident pacing.',
  'قصصي': 'DELIVERY STYLE: Narrative - warm, flowing, expressive pacing.',
  'توعوي': 'DELIVERY STYLE: Awareness - calm, sincere, reassuring delivery.',
  'إخباري': 'DELIVERY STYLE: Informational - neutral, professional, concise.',
  'تعليمي': 'DELIVERY STYLE: Educational - clear, steady, explanatory tone.',
};

/** يستنتج معرّف اللهجة من بادئة معرّف الصوت، كما في server.ts. */
export function resolveDialectId(profileId, fallbackId) {
  if (typeof profileId === 'string') {
    if (profileId.startsWith('egy_')) return 'egyptian';
    if (profileId.startsWith('sau_')) return 'saudi';
  }
  return fallbackId || 'fusha';
}

export function phoneticLockForDialect(dialectId) {
  return DIALECT_PHONETIC_LOCKS[dialectId] || DIALECT_PHONETIC_LOCKS.fusha;
}

/** بصمة الصوت: نفس دالة التجزئة في server.ts (8 خانات عشرية). */
export function generateVoiceFingerprint(name) {
  let hash = 0;
  const value = String(name || 'Default');
  for (let i = 0; i < value.length; i++) {
    const char = value.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString().substring(0, 8);
}

/**
 * برومبت TTS الكامل — نفس بنية server.ts، بهوية «مدعوم Voice».
 * يُبنى في الخادم (Edge Function)؛ هذه النسخة للاختبار والتوثيق.
 */
export function buildTtsPrompt({ text, profile, controls, performanceNote, dialectId }) {
  const fingerprint = generateVoiceFingerprint(profile?.name || 'Default');
  const targetDialect = dialectId || resolveDialectId(profile?.id);
  const phoneticLock = phoneticLockForDialect(targetDialect);
  const purposeDirective = controls?.purpose ? PURPOSE_DIRECTIVES[controls.purpose] || '' : '';
  const identityName = profile?.name || 'مدعوم Voice';
  return `
MODE: READY_FOR_TTS (Text-to-Speech Synthesis Only)
IDENTITY: ${identityName} (${profile?.description || ''})
FINGERPRINT: ${fingerprint}
DIALECT: ${targetDialect}
${phoneticLock}
${purposeDirective}
CONTROLS: Speed ${controls?.speed || '1'}, Pitch ${controls?.pitch || '0'}, Emotion ${controls?.emotion || 'natural'}.
${performanceNote || ''}

TEXT_TO_SYNTHESIZE: "${text}"
    `.trim();
}

/** تنسيق مدة بالثواني: د:ثث (كما في مشغّل المشروع الأصلي). */
export function formatTime(time) {
  const total = Math.max(0, Math.floor(Number(time) || 0));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/** طابع SRT: HH:MM:SS,mmm. */
export function formatSrtTime(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.floor((total - Math.floor(total)) * 1000);
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/**
 * يغلّف PCM خام (24kHz، أحادي، 16-bit افتراضيًا) في WAV صالح.
 * إن كان المدخل WAV جاهزًا (يبدأ بـ RIFF) يُعاد كما هو — نفس
 * ensureWavBuffer في server.ts، بنسخة Uint8Array قابلة للاختبار.
 */
export function ensureWavBuffer(bytes, sampleRate = 24000, numChannels = 1, bitDepth = 16) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (input.length >= 4
    && input[0] === 0x52 && input[1] === 0x49 && input[2] === 0x46 && input[3] === 0x46) {
    return input;
  }
  const dataLength = input.length;
  const out = new Uint8Array(44 + dataLength);
  const view = new DataView(out.buffer);
  const writeAscii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  const byteRate = (sampleRate * numChannels * bitDepth) / 8;
  const blockAlign = (numChannels * bitDepth) / 8;
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataLength, true);
  out.set(input, 44);
  return out;
}

/**
 * يدمج مقاطع WAV (نفس الترويسة 44 بايت، نفس المعدل والقنوات) في ملف
 * واحد: تُقرأ حمولة PCM من كل مقطع وتُعاد كتابتها بترويسة جديدة.
 * يُستخدم لدمج مقاطع البودكاست والكتاب الصوتي النهائي.
 */
export function concatWavBuffers(buffers, sampleRate = 24000, numChannels = 1, bitDepth = 16) {
  const payloads = [];
  let total = 0;
  for (const raw of buffers || []) {
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw || []);
    if (bytes.length < 44) continue;
    const payload = bytes.slice(44);
    payloads.push(payload);
    total += payload.length;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const payload of payloads) {
    merged.set(payload, offset);
    offset += payload.length;
  }
  return ensureWavBuffer(merged, sampleRate, numChannels, bitDepth);
}

/** يقسّم النص إلى فقرات غير فارغة (التقسيم اليدوي للكتاب الصوتي). */
export function splitTextByParagraphs(text) {
  return String(text || '').split(/\n+/).map((p) => p.trim()).filter(Boolean);
}

/**
 * يبني SRT من تفريغ نصي:
 *  • إن وُجدت طوابع [MM:SS] في النص تُستخدم حدودًا للمقاطع.
 *  • وإلا تُقسَّم الجمل على مقاطع متتالية مدة كل منها 4 ثوانٍ.
 */
export function buildSrt(transcript) {
  const text = String(transcript || '').trim();
  if (!text) return '';
  const timed = [...text.matchAll(/\[(\d{1,2}):(\d{2})\]\s*([^\[]*)/g)];
  const blocks = [];
  if (timed.length > 0) {
    timed.forEach((m, i) => {
      const start = Number(m[1]) * 60 + Number(m[2]);
      const end = i + 1 < timed.length
        ? Number(timed[i + 1][1]) * 60 + Number(timed[i + 1][2])
        : start + 4;
      const body = (m[3] || '').trim();
      if (body) blocks.push({ start, end: Math.max(end, start + 1), body });
    });
  } else {
    const sentences = text.split(/(?<=[.!؟\n])\s+/).map((s) => s.trim()).filter(Boolean);
    sentences.forEach((body, i) => {
      blocks.push({ start: i * 4, end: (i + 1) * 4, body });
    });
  }
  return blocks.map((b, i) =>
    `${i + 1}\n${formatSrtTime(b.start)} --> ${formatSrtTime(b.end)}\n${b.body}`).join('\n\n') + '\n';
}

/** غلاف DOCX (HTML يُفتح في Word) — كما في المشروع الأصلي، بخط Cairo. */
export function buildDocxHtml(transcript) {
  const escaped = String(transcript || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  return `<!DOCTYPE html><html><body><div style="direction:rtl; font-family: 'Cairo', sans-serif;">${escaped}</div></body></html>`;
}

/** اسم ملف التفريغ: mad3oom_transcript_<اسم المصدر>.<الامتداد>. */
export function transcriptFileName(format, sourceName) {
  const base = String(sourceName || 'result').replace(/\.[^.]+$/, '') || 'result';
  const safe = base.replace(/[\\/:*?"<>|]/g, '_');
  return `mad3oom_transcript_${safe}.${format}`;
}

/** اسم ملف الصوت المولّد: العنوان أو mad3oom_audio، بامتداد wav
 *  افتراضيًا (Gemini) أو mp3 (Edge) حسب المحرك. */
export function audioFileName(title, extension = 'wav') {
  const safe = String(title || '').trim().replace(/[\\/:*?"<>|]/g, '_');
  const ext = String(extension || 'wav').replace(/^\./, '').toLowerCase() || 'wav';
  return `${safe || 'mad3oom_audio'}.${ext}`;
}

/* ── محرك Edge TTS ───────────────────────────────────────────────────
   خدمة غير رسمية من مايكروسوفت (بلا عقد ولا مفتاح) — قد تتوقف أو
   تتغير دون إشعار، وليست خدمة مضمونة. الناتج MP3
   (audio-24khz-48kbitrate-mono-mp3) لا WAV.
   البروتوكول منقول من مكتبة edge-tts 7.3.1 (communicate.py + drm.py):
   اتصال WebSocket، ثم رسالة speech.config، ثم SSML، واستقبال مقاطع
   MP3 ثنائية حتى رسالة turn.end. التوليف الحي لم يُتحقق منه من بيئة
   الوكيل (شبكتها تمنع TLS إلى speech.platform.bing.com) — الفحص الحي
   يجب أن يتم من الـ Function المنشورة (انظر edge-tts.ts). */

/** التوكن الموثوق العام الذي تستخدمه مكتبة edge-tts.
 *  تنبيه موثّق: هذا هو توكن edge-tts 7.3.1 المثبتة فعلًا
 *  (…FB37E23D68491D6F4)، لا التوكن الأقدم …FB9E31F41671B9D9 الذي ورد
 *  في وصف المهمة — المكتبة نفسها تستخدم هذا التوكن في رابط الـ WS
 *  وفي حساب Sec-MS-GEC معًا، فيجب أن يتطابقا. */
export const EDGE_TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
export const EDGE_SEC_MS_GEC_VERSION = '2-143.0.3650.75';
export const EDGE_WSS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
export const EDGE_VOICE_LIST_URL = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4';
export const EDGE_OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
export const EDGE_TTS_ENGINES = ['edge', 'gemini'];
export const EDGE_TTS_ENGINE_DEFAULT = 'edge';
/** اسم صوت Edge صالح: ar-XX-NameNeural. */
export const EDGE_VOICE_NAME_PATTERN = /^ar-[A-Z]{2}-[A-Za-z]+Neural$/;

/** يحلّ صوتًا مسمّى (لهجة + جنس) إلى اسم صوت Edge الحقيقي. */
export function resolveEdgeVoice(profile, dialectId) {
  const dialect = dialectId || resolveDialectId(profile?.id);
  const entry = EDGE_VOICE_MAP[dialect] || EDGE_VOICE_MAP.fusha;
  const gender = profile?.gender === 'female' || profile?.gender === 'أنثى' ? 'female' : 'male';
  return {
    voice: gender === 'female' ? entry.female : entry.male,
    dialectId: dialect in EDGE_VOICE_MAP ? dialect : 'fusha',
    gender,
    isFallback: !!entry.fallback,
  };
}

/**
 * يختار محرك التوليد: الافتراضي edge. gemini يعمل فقط عند وجود مفتاح
 * (وإلا يرجع خطأً صريحًا لا سقوطًا صامتًا على edge).
 */
export function resolveTtsEngine(requestedEngine, hasGeminiKey) {
  const requested = typeof requestedEngine === 'string' ? requestedEngine.toLowerCase() : '';
  if (requested === 'gemini') {
    if (hasGeminiKey) return { engine: 'gemini' };
    return { engine: null, error: 'gemini-key-required' };
  }
  return { engine: 'edge' };
}

/* ── SSML من أدوات الاستوديو ─────────────────────────────────────────
   ما يُترجم إلى Edge (prosody فقط):
   • سرعة الإلقاء ← rate، طبقة الصوت ← pitch، عمق النبرة ← pitch أيضًا.
   • نوع الصوت «كبار السن» يُقارب بإبطاء وخفض الطبقة، و«شخصية كارتونية»
     بتسريع ورفع الطبقة — تقريب موثّق، لا صوت مختلف.
   ما لا يدعمه Edge فيُتجاهل بصراحة (لا يُرسل ولا يُدّعى):
   حرارة الصوت (temp)، مستوى الانفعال (emotion)، شدة التأثير الدرامي
   (drama)، والغرض (purpose) — لا معامل انفعال في هذا الـ API، ولا
   برومبت نصي كما في Gemini. */
export const EDGE_IGNORED_CONTROLS = ['temp', 'emotion', 'drama', 'purpose'];

const EDGE_SPEED_RATES = { 'بطيئة': -15, 'متوسطة': 0, 'سريعة': 15 };
const EDGE_PITCH_OFFSETS = { 'عالية': 6, 'متوسطة': 0, 'منخفضة': -6 };
const EDGE_DEPTH_OFFSETS = { 'خفيفة': 4, 'متوسطة': 0, 'عميقة': -4 };
const EDGE_VOICE_TYPE_ADJUST = {
  'كبار السن': { rate: -10, pitch: -4 },
  'شخصية كارتونية': { rate: 10, pitch: 8 },
  'بالغ': { rate: 0, pitch: 0 },
};

export function edgeProsodyForControls(controls = {}, voiceType = 'بالغ') {
  let rate = EDGE_SPEED_RATES[controls?.speed] ?? 0;
  let pitch = (EDGE_PITCH_OFFSETS[controls?.pitch] ?? 0)
    + (EDGE_DEPTH_OFFSETS[controls?.depth] ?? 0);
  const adjust = EDGE_VOICE_TYPE_ADJUST[voiceType] || { rate: 0, pitch: 0 };
  rate += adjust.rate;
  pitch += adjust.pitch;
  const fmt = (n, unit) => `${n >= 0 ? '+' : ''}${n}${unit}`;
  return { rate: fmt(rate, '%'), pitch: fmt(pitch, 'Hz'), volume: '+0%' };
}

/** يزيل المحارف التي يرفضها Edge (كما في communicate.py). */
export function removeIncompatibleCharacters(text) {
  return Array.from(String(text ?? '')).map((ch) => {
    const code = ch.codePointAt(0);
    return (code <= 8 || (code >= 11 && code <= 12) || (code >= 14 && code <= 31)) ? ' ' : ch;
  }).join('');
}

export function escapeXmlText(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * يحوّل اسم صوت قصير (ar-EG-SalmaNeural) إلى الصيغة الطويلة التي
 * يرسلها Edge نفسه، كما في TTSConfig ‏(edge-tts): الاسم القصير لا
 * يُرسل كما هو أبدًا. الاسم غير المطابق للنمط يسقط للصوت الافتراضي.
 */
export function edgeVoiceSsmlName(voice) {
  const name = String(voice || '');
  const match = /^([a-z]{2,})-([A-Z]{2,})-(.+Neural)$/.exec(name);
  if (!match) return edgeVoiceSsmlName(EDGE_VOICE_DEFAULT);
  let lang = match[1];
  let region = match[2];
  let voiceName = match[3];
  const dash = voiceName.indexOf('-');
  if (dash !== -1) {
    region = `${region}-${voiceName.slice(0, dash)}`;
    voiceName = voiceName.slice(dash + 1);
  }
  return `Microsoft Server Speech Text to Speech Voice (${lang}-${region}, ${voiceName})`;
}

/** يبني SSML كما في mkssml ‏(edge-tts): نفس البنية والسمات حرفيًا. */
export function buildEdgeSsml({ text, voice, rate = '+0%', pitch = '+0Hz', volume = '+0%' }) {
  const clean = escapeXmlText(removeIncompatibleCharacters(text));
  const safeVoice = EDGE_VOICE_NAME_PATTERN.test(String(voice || '')) ? voice : EDGE_VOICE_DEFAULT;
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${edgeVoiceSsmlName(safeVoice)}'><prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>${clean}</prosody></voice></speak>`;
}

/** سلسلة تاريخ بأسلوب JavaScript كما في date_to_string ‏(edge-tts). */
export function edgeDateString(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${d.getUTCFullYear()} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

/* ── توليد توكن Sec-MS-GEC (نفس خوارزمية drm.py في edge-tts 7.3.1) ──
   التوكن = "<16 خانة hex>-<64 خانة hex>" من طابع زمني (Windows file
   time، مقروبًا لأقرب 5 دقائق) + التوكن الموثوق. الهضم نسخة معدّلة من
   SHA-256 (حالة أولية وثوابت جولة معدّلة) ثم هضم CS64 — كلها حسابات
   32-بت منقولة حرفيًا؛ الدوال هنا مكافئة رياضيًا لنسخة المكتبة
   (الضرب في 2**32+1 يُختزل إلى ROTR، كما يشرح تعليق المكتبة نفسه).
   يُختبر بالحتمية والشكل وقيم مرجعية من المكتبة نفسها — لا قيمة ضد
   خادم حي (الشبكة تمنعه من هنا). */

const U32 = (n) => n >>> 0;
const ROTR = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;
const ROL16 = (v) => (((v << 16) | (v >>> 16)) >>> 0);

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

const CS64_COEFFICIENTS = [
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

function sigma0(value) {
  return U32((value >>> 7) ^ (value << 25) ^ (value >>> 18) ^ (value << 14) ^ (value >>> 3));
}

function sigma1(value) {
  return U32((value >>> 17) ^ (value << 15) ^ (value >>> 19) ^ (value << 13) ^ (value >>> 10));
}

function add32(...values) {
  return values.reduce((sum, v) => U32(sum + v), 0);
}

/* ضغط SHA-256 القياسي (مكافئ لـ _sha256_rounds في المكتبة). */
function sha256Rounds(state, words, firstRound = 0) {
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

function expandSha256Schedule(words, firstWord = 16) {
  for (let i = firstWord; i < 64; i++) {
    words.push(add32(sigma1(words[i - 2]), words[i - 7], sigma0(words[i - 15]), words[i - 16]));
  }
}

function sha256DrmInit(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const words = new Array(14).fill(0);
  words.push(((data[0] << 16) | (data[1] << 8) | data[2]) >>> 0);
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

function sha256DrmDigest(data) {
  if (data.length < 7) throw new Error('Token salt must contain at least seven bytes');
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
    const words = [];
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

function wordsLe4Even(data) {
  const padded = new Uint8Array(Math.ceil(data.length / 4) * 4);
  padded.set(data, 0);
  const view = new DataView(padded.buffer);
  const words = [];
  for (let i = 0; i < padded.length / 4; i++) words.push(view.getUint32(i * 4, true));
  if (words.length % 2) words.push(0);
  return words;
}

function cs64Digest(data, digest) {
  const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  let keyA = U32(view.getUint32(0, true) | 1);
  let keyB = U32(view.getUint32(4, true) | 1);
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

function bytesToHexUpper(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/**
 * يولّد توكن Sec-MS-GEC v2 من طابع زمني يونكس (ثوانٍ). حتمي: نفس
 * الطابع في نفس نافذة 5 دقائق يعطي نفس التوكن دائمًا.
 */
export function generateSecMsGec(unixTimestamp = Date.now() / 1000, clockSkewSeconds = 0) {
  let ticks = Number(unixTimestamp) + Number(clockSkewSeconds || 0);
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

/* ── دمج الصوت بعد فك التشفير ─────────────────────────────────────────
   دمج الكتاب الصوتي والبودكاست يتم في المتصفح عبر Web Audio: كل مقطع
   (MP3 من Edge أو WAV من Gemini) يُفك تشفيره أولًا، ثم تُلصق قنوات
   PCM وتُعاد كتابتها WAV هنا. المقاطع كلها بنفس معدل العينة لأن
   decodeAudioData يعيد أخذ العينات لمعدل سياق الصوت نفسه. */

export function encodePcmToWav(interleaved, sampleRate = 24000, numChannels = 1) {
  const pcm = interleaved instanceof Float32Array
    ? interleaved
    : new Float32Array(interleaved || []);
  const dataLength = pcm.length * 2;
  const out = new Uint8Array(44 + dataLength);
  const view = new DataView(out.buffer);
  const writeAscii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  const byteRate = (sampleRate * numChannels * 16) / 8;
  const blockAlign = (numChannels * 16) / 8;
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataLength, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return out;
}

/**
 * يدمج مقاطع مفكوكة التشفير ({sampleRate, channels: Float32Array[]})
 * في WAV واحد. القنوات الناقصة في مقطع تُملأ بصمت.
 */
export function mergeDecodedAudio(segments) {
  const list = (segments || []).filter(
    (s) => s && Array.isArray(s.channels) && s.channels.length,
  );
  if (!list.length) return encodePcmToWav(new Float32Array(0), 24000, 1);
  const sampleRate = list[0].sampleRate || 24000;
  const numChannels = list[0].channels.length;
  let totalFrames = 0;
  for (const seg of list) totalFrames += seg.channels[0].length;
  const interleaved = new Float32Array(totalFrames * numChannels);
  let frame = 0;
  for (const seg of list) {
    const frames = seg.channels[0].length;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numChannels; c++) {
        interleaved[(frame + i) * numChannels + c] = seg.channels[c] ? (seg.channels[c][i] || 0) : 0;
      }
    }
    frame += frames;
  }
  return encodePcmToWav(interleaved, sampleRate, numChannels);
}

/** يربط دورًا سرديًا بصوت: الراوي يأخذ صوت رواية/وثائقي، وغيره توزيع ثابت بالبصمة. */
export function mapRoleToVoice(role, voices) {
  const list = Array.isArray(voices) ? voices : [];
  if (!list.length) return '';
  if (String(role || '').includes('الراوي')) {
    const narrator = list.find((v) => v.categoryKey === 'novels' || v.categoryKey === 'doc');
    if (narrator) return narrator.name;
  }
  const hash = String(role || '').split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return list[hash % list.length].name;
}

/**
 * التوزيع الذكي لأصوات البودكاست: يطابق الجنس وفئة الصوت المقترحة،
 * ولا يعيد استخدام صوت سبق إسناده إلا عند نفاد البدائل.
 */
export function smartDistributeSpeakers(speakers, voices) {
  const map = {};
  const used = new Set();
  const list = Array.isArray(voices) ? voices : [];
  for (const speaker of speakers || []) {
    let matches = list.filter((v) => speaker.gender === 'any' || v.gender === speaker.gender);
    let best = matches.filter((v) => v.categoryKey === speaker.categoryHint);
    if (!best.length) best = matches;
    const selected = best.find((v) => !used.has(v.id)) || best[0];
    if (selected) {
      map[speaker.id] = selected.id;
      used.add(selected.id);
    }
  }
  return map;
}

/* ── فحص إعادة التسمية ────────────────────────────────────────────────
   النمط مبني من مقاطع حتى لا يظهر الاسم القديم حرفيًا في هذا الملف
   نفسه (فحص grep يجب أن يرجع صفرًا في كل الملفات الجديدة). */
export function forbiddenBrandPattern() {
  const parts = [
    ['sa', 'vio'].join(''),
    ['\u0633', '\u0627', '\u0641', '\u064a', '\u0648'].join(''),
    ['ai', 'studio', '-', 'build'].join(''),
  ];
  return new RegExp(parts.join('|'), 'i');
}

export function hasForbiddenBrand(text) {
  return forbiddenBrandPattern().test(String(text || ''));
}

/** يفحص كل حقول البيانات النصية ويعيد مسارات أي مخالفة (فارغة = نظيف). */
export function findForbiddenBrandInData(data) {
  const pattern = forbiddenBrandPattern();
  const hits = [];
  const walk = (value, path) => {
    if (typeof value === 'string') {
      if (pattern.test(value)) hits.push(path);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) walk(item, path ? `${path}.${key}` : key);
    }
  };
  walk(data, '');
  return hits;
}
