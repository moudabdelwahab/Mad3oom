// ============================================================
// voice-studio — الاستوديو الصوتي (مدعوم) في لوحة المالك
// ------------------------------------------------------------
// الدالة الآن توليد صوتي فقط (tts) — تدقيق 2026-11-25:
//   edge (الافتراضي، بلا مفتاح): Edge TTS من مايكروسوفت عبر
//     edge-tts.ts — خدمة غير رسمية بلا عقد ولا مفتاح، والناتج MP3.
//   gemini (اختياري، بمفتاح فقط): مسار Gemini السابق، والناتج WAV.
//   عند فشل Edge والمفتاح مضبوط يُستخدم Gemini كبديل صريح موثّق
//   (engine: gemini مع fallbackFrom: edge)؛ وبدون مفتاح يرجع خطأً
//   صريحًا يذكر المحرك والسبب. gemini بلا مفتاح مرفوض صراحةً.
//
// حُذفت الإجراءات السبعة غير الصوتية: preprocess-text،
// identify-key-sentences، analyze-and-segment، generate-podcast-script
// (الأربعة النصية تُوجَّه الآن إلى ai-gateway من الصفحة مباشرة
// بمفاتيح المنصة الخادمية — بلا مفتاح Gemini شخصي)، وtranscribe-media
// وextract-text وgenerate-stream (بلا بديل: التفريغ والاستخراج
// يحتاجان صوتًا/رؤية لا توفرهما ai-gateway النصية، والبث بلا منادٍ).
// فلا إجراء ميت في الدالة: أي action غير tts يرجع 400.
//
// النداء: supabase.functions.invoke('voice-studio',
//   { body: { action: 'tts', ...payload } })
// والمفتاح الشخصي للمالك يُرسل في هيدر x-gemini-api-key إن وُجد،
// وإلا يُستخدم متغير البيئة GEMINI_API_KEY. لا WebSocket Live هنا:
// لا خادم WS في Edge Functions، وواجهة المشروع الأصلي لم تكن
// تستخدمه أصلًا.
//
// برومبتات TTS وأقفال اللهجات مرآة
// assets/js/owner/voice-studio-state.js (نفس النصوص).
//
// ملاحظة أمنية (خارج نطاق تدقيق 2026-11-25، متابعة مقترحة):
// الدالة بلا تحقق مصادقة (لا Authorization ولا getUser) — أي حامل
// للمفتاح العام يستطيع نداء tts edge. فرض JWT مالك عليها قرار
// منفصل لم يُنفَّذ هنا قصدًا.
// ============================================================
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { synthesizeEdge } from "./edge-tts.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-gemini-api-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const FETCH_TIMEOUT_MS = 120000;

const TTS_MODELS = [
  "gemini-3.1-flash-tts-preview",
  "gemini-2.5-flash-preview-tts",
  "gemini-3.8-flash-lite-tts",
  "gemini-3.8-flash-tts",
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function resolveApiKey(req: Request, body: Record<string, unknown>): string | null {
  const headerKey = req.headers.get("x-gemini-api-key");
  if (headerKey && headerKey.trim().length > 10) return headerKey.trim();
  const bodyKey = typeof body?.userApiKey === "string" ? body.userApiKey : "";
  if (bodyKey.trim().length > 10) return bodyKey.trim();
  const envKey = Deno.env.get("GEMINI_API_KEY") || "";
  if (envKey.trim().length > 10) return envKey.trim();
  return null;
}

function formatAIErrorMessage(error: unknown): string {
  const msg = typeof error === "string" ? error : ((error as Error)?.message || "");
  if (
    msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") ||
    msg.includes("quota") || msg.includes("Quota")
  ) {
    return "تم استنفاد الحصة المجانية المؤقتة لنموذج الصوت (الحد الأقصى المجاني 10 طلبات يومياً). للمتابعة فوراً بحصتك الشخصية بدون قيود: أدخل مفتاحك الشخصي في إعدادات الاستوديو الصوتي.";
  }
  if (msg.includes("503") || msg.includes("UNAVAILABLE") || msg.includes("high demand")) {
    return "النموذج يواجه ضغطاً مؤقتاً، يرجى المحاولة مرة أخرى خلال لحظات.";
  }
  return msg || "فشل توليد الصوت من الخادم.";
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function generateVoiceFingerprint(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    const char = name.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString().substring(0, 8);
}

// تغليف PCM خام (24kHz، أحادي، 16-bit) في WAV — مرآة ensureWavBuffer
// في server.ts وفي assets/js/owner/voice-studio-state.js.
function ensureWavBuffer(buffer: Uint8Array, sampleRate = 24000, numChannels = 1, bitDepth = 16): Uint8Array {
  if (
    buffer.length >= 4 && buffer[0] === 0x52 && buffer[1] === 0x49 &&
    buffer[2] === 0x46 && buffer[3] === 0x46
  ) {
    return buffer;
  }
  const out = new Uint8Array(44 + buffer.length);
  const view = new DataView(out.buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  const byteRate = (sampleRate * numChannels * bitDepth) / 8;
  const blockAlign = (numChannels * bitDepth) / 8;
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + buffer.length, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeAscii(36, "data");
  view.setUint32(40, buffer.length, true);
  out.set(buffer, 44);
  return out;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(binary);
}

const DIALECT_PHONETIC_LOCKS: Record<string, string> = {
  egyptian: `STRICT EGYPTIAN PHONETIC LOCK: 1. Pronounce ALL words using natural Egyptian phonetics. 2. (ج) must be soft 'g'. 3. Casual rhythm.`,
  saudi: `STRICT SAUDI PHONETIC LOCK: 1. Authentic Saudi prosody. 2. Najdi/Hejazi inflections.`,
  khaleeji: `STRICT KHALEEJI PHONETIC LOCK: 1. Gulf White phonetics. 2. Traditional elongation.`,
  levantine: `STRICT LEVANTINE PHONETIC LOCK: 1. Syrian/Levantine melodic prosody.`,
  sudanese: `STRICT SUDANESE PHONETIC LOCK: 1. Authentic Sudanese phonetics. 2. Proper pronunciation of Sudanese 'qaf' and 'jeem'. 3. Calm, warm Sudanese rhythmic pacing.`,
  yemeni: `STRICT YEMENI PHONETIC LOCK: 1. Clear Arabic pronunciation with a natural urban Yemeni tone. 2. Neutral urban Yemeni style (avoid aggressive tribal sub-dialects). 3. Avoid Gulf-style elongation or Saudi heavy inflections. 4. Calm and natural rhythmic pacing.`,
  lebanese: `STRICT LEBANESE PHONETIC LOCK: 1. Soft, smooth Arabic pronunciation with light Lebanese musical intonation. 2. Natural urban Lebanese style (Beirut/Modern urban style). 3. Avoid Gulf-style heaviness or strong Egyptian influence. 4. Natural conversational pacing. 5. Specific vowel elongation characteristic of elegant Lebanese speech.`,
  fusha: `STRICT MSA LOCK: 1. Formal academic Arabic. 2. Correct case endings.`,
};

const PURPOSE_DIRECTIVES: Record<string, string> = {
  "إعلان": "DELIVERY STYLE: Advertisement - energetic, engaging, confident pacing.",
  "قصصي": "DELIVERY STYLE: Narrative - warm, flowing, expressive pacing.",
  "توعوي": "DELIVERY STYLE: Awareness - calm, sincere, reassuring delivery.",
  "إخباري": "DELIVERY STYLE: Informational - neutral, professional, concise.",
  "تعليمي": "DELIVERY STYLE: Educational - clear, steady, explanatory tone.",
};

// ── التوليد الصوتي بمحركين ──────────────────────────────────────────

/** مسار Gemini السابق (WAV): يُستدعى فقط عند وجود مفتاح. */
async function synthesizeGeminiTts(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const text = typeof body.text === "string" ? body.text : "";
  if (!text) return json({ error: "النص مطلوب للتوليد الصوتي." }, 400);
  const profile = (body.profile as Record<string, unknown>) || {};
  const controls = (body.controls as Record<string, unknown>) || {};
  const performanceNote = typeof body.performanceNote === "string" ? body.performanceNote : "";
  const profileId = typeof profile.id === "string" ? profile.id : "";
  const dialectId = typeof body.dialectId === "string"
    ? body.dialectId
    : profileId.startsWith("egy_")
    ? "egyptian"
    : profileId.startsWith("sau_")
    ? "saudi"
    : "fusha";
  const fingerprint = generateVoiceFingerprint(
    typeof profile.name === "string" ? profile.name : "Default",
  );
  const phoneticLock = DIALECT_PHONETIC_LOCKS[dialectId] || DIALECT_PHONETIC_LOCKS.fusha;
  const purposeDirective = typeof controls.purpose === "string"
    ? PURPOSE_DIRECTIVES[controls.purpose] || ""
    : "";
  const studioDirective = `
MODE: READY_FOR_TTS (Text-to-Speech Synthesis Only)
IDENTITY: ${typeof profile.name === "string" ? profile.name : "مدعوم Voice"} (${typeof profile.description === "string" ? profile.description : ""})
FINGERPRINT: ${fingerprint}
DIALECT: ${dialectId}
${phoneticLock}
${purposeDirective}
CONTROLS: Speed ${controls.speed || "1"}, Pitch ${controls.pitch || "0"}, Emotion ${controls.emotion || "natural"}.
${performanceNote}

TEXT_TO_SYNTHESIZE: "${text}"
    `;
  const voice = typeof body.voiceName === "string" && body.voiceName ? body.voiceName : "Fenrir";
  let lastError: unknown = null;
  for (const model of TTS_MODELS) {
    try {
      const res = await fetchWithTimeout(
        `${GEMINI_API_BASE}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: studioDirective }] }],
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
              },
            },
          }),
        },
      );
      const data = await res.json() as Record<string, unknown>;
      if (!res.ok) {
        const message = (data?.error as Record<string, unknown>)?.message as string
          || `Gemini HTTP ${res.status}`;
        throw new Error(message);
      }
      const parts = (data?.candidates as Array<Record<string, unknown>>)?.[0]
        ?.content as Record<string, unknown>;
      const inline = (parts?.parts as Array<Record<string, unknown>>)?.[0]
        ?.inlineData as Record<string, unknown> | undefined;
      if (inline?.data) {
        const wav = ensureWavBuffer(base64ToBytes(inline.data as string), 24000, 1, 16);
        return json({ audioBase64: bytesToBase64(wav), mimeType: "audio/wav", engine: "gemini" });
      }
      throw new Error("empty TTS response");
    } catch (err) {
      lastError = err;
      console.warn(`[voice-studio] TTS model ${model} failed:`, (err as Error).message?.slice(0, 120));
    }
  }
  return json({ error: formatAIErrorMessage(lastError) }, 500);
}

/**
 * إجراء tts بمحركين — يُرسَل قبل بوابة مفتاح Gemini لأن محرك edge
 * يعمل بلا مفتاح:
 *  • engine=edge (افتراضي): يولّد عبر Edge TTS ويرجع MP3. عند الفشل
 *    يرجع خطأً صريحًا يذكر المحرك والسبب، إلا إن كان مفتاح Gemini
 *    مضبوطًا فيسقط عليه كبديل صريح موثّق (fallbackFrom: edge).
 *  • engine=gemini: يعمل فقط مع مفتاح، وإلا يرجع 503 صريحًا.
 */
async function handleTts(req: Request, body: Record<string, unknown>): Promise<Response> {
  const text = typeof body.text === "string" ? body.text : "";
  if (!text) return json({ error: "النص مطلوب للتوليد الصوتي." }, 400);
  const engine = typeof body.engine === "string" ? body.engine.toLowerCase() : "edge";
  const apiKey = resolveApiKey(req, body);

  if (engine === "gemini") {
    if (!apiKey) {
      return json(
        { error: "محرك Gemini يحتاج مفتاحًا — أدخل مفتاحك الشخصي في إعدادات الاستوديو، أو استخدم محرك Edge TTS المجاني (الافتراضي)." },
        503,
      );
    }
    return await synthesizeGeminiTts(apiKey, body);
  }

  // المحرك الافتراضي: Edge TTS (بلا مفتاح، والناتج MP3).
  const profile = (body.profile as Record<string, unknown>) || {};
  const controls = (body.controls as Record<string, unknown>) || {};
  const voiceName = typeof body.voiceName === "string" ? body.voiceName : "";
  try {
    const mp3 = await synthesizeEdge({
      text,
      voice: voiceName,
      controls: controls as Record<string, string>,
      voiceType: typeof profile.voiceType === "string" ? profile.voiceType : "بالغ",
    });
    return json({ audioBase64: bytesToBase64(mp3), mimeType: "audio/mpeg", engine: "edge" });
  } catch (edgeErr) {
    const reason = (edgeErr as Error).message || "خطأ غير معروف";
    console.warn("[voice-studio] Edge TTS failed:", reason.slice(0, 200));
    if (!apiKey) {
      return json(
        { error: `فشل محرك Edge TTS: ${reason} — جرّب مرة أخرى، أو أدخل مفتاح Gemini الشخصي ليُستخدم كبديل.` },
        500,
      );
    }
    // بديل صريح موثّق (لا تلقائي خفي): Gemini بمفتاح مضبوط.
    console.warn("[voice-studio] Edge failed, falling back to Gemini (key configured)");
    const geminiRes = await synthesizeGeminiTts(apiKey, body);
    if (!geminiRes.ok) return geminiRes;
    const payload = await geminiRes.json() as Record<string, unknown>;
    return json({ ...payload, engine: "gemini", fallbackFrom: "edge", fallbackReason: reason });
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return json({ error: "طلب غير صالح: JSON مطلوب." }, 400);
  }

  const action = typeof body.action === "string" ? body.action : "";
  if (action === "tts") {
    return handleTts(req, body);
  }
  // الدالة توليد صوتي فقط: أي إجراء آخر (ومنها الإجراءات النصية
  // السبعة المحذوفة) يرجع 400 صريحًا بدل بوابة 503 أو نجاح زائف.
  return json({ error: "إجراء غير معروف — الدالة تدعم tts فقط." }, 400);
});
