// ============================================================
// voice-studio — الاستوديو الصوتي (مدعوم) في لوحة المالك
// ------------------------------------------------------------
// نقل نقاط server.ts الثماني من مشروع الاستوديو الصوتي الأصلي
// (Express + GoogleGenAI) إلى Edge Function واحدة بلا خادم:
//   preprocess-text، identify-key-sentences، analyze-and-segment،
//   transcribe-media، extract-text، generate-podcast-script،
//   tts، generate-stream (SSE).
//
// محركا التوليد الصوتي (tts):
//   edge (الافتراضي، بلا مفتاح): Edge TTS من مايكروسوفت عبر
//     edge-tts.ts — خدمة غير رسمية بلا عقد ولا مفتاح، والناتج MP3.
//   gemini (اختياري، بمفتاح فقط): مسار Gemini السابق، والناتج WAV.
//   عند فشل Edge والمفتاح مضبوط يُستخدم Gemini كبديل صريح موثّق
//   (engine: gemini مع fallbackFrom: edge)؛ وبدون مفتاح يرجع خطأً
//   صريحًا يذكر المحرك والسبب. gemini بلا مفتاح مرفوض صراحةً.
//
// النداء: supabase.functions.invoke('voice-studio',
//   { body: { action: 'tts', ...payload } })
// والمفتاح الشخصي للمالك يُرسل في هيدر x-gemini-api-key إن وُجد،
// وإلا يُستخدم متغير البيئة GEMINI_API_KEY. لا WebSocket Live هنا:
// لا خادم WS في Edge Functions، وواجهة المشروع الأصلي لم تكن
// تستخدمه أصلًا (دالة connectLiveSession معرّفة بلا أي منادٍ).
//
// برومبتات TTS وأقفال اللهجات مرآة
// assets/js/owner/voice-studio-state.js (نفس النصوص)، وقوائم
// نماذج الـ fallback ورسائل الخطأ العربية من server.ts حرفيًا.
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

const TEXT_MODELS = ["gemini-3.8-flash", "gemini-3-flash-preview"];
const TRANSCRIBE_MODELS = [
  "gemini-3.5-transcribe",
  "gemini-3-flash-preview",
  "gemini-3.8-flash",
];
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

interface GenerateParams {
  apiKey: string;
  models?: string[];
  contents: unknown;
  config?: Record<string, unknown>;
}

async function generateContentWithFallback(
  params: GenerateParams,
): Promise<{ text: string; audioBase64?: string }> {
  const candidates = params.models || TEXT_MODELS;
  let lastError: unknown = null;
  for (const model of candidates) {
    try {
      const res = await fetchWithTimeout(
        `${GEMINI_API_BASE}/models/${model}:generateContent?key=${encodeURIComponent(params.apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: params.contents, generationConfig: params.config }),
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
      const firstPart = (parts?.parts as Array<Record<string, unknown>>)?.[0];
      const inline = firstPart?.inlineData as Record<string, unknown> | undefined;
      const text = (firstPart?.text as string) || "";
      if (inline?.data) return { text, audioBase64: inline.data as string };
      if (text) return { text };
      throw new Error("empty Gemini response");
    } catch (err) {
      lastError = err;
      console.warn(`[voice-studio] model ${model} failed:`, (err as Error).message?.slice(0, 120));
    }
  }
  throw lastError;
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

const DIALECT_INSTRUCTIONS: Record<string, string> = {
  sudanese: `
أنت خبير لغوي في اللهجة السودانية.
المهمة: تحويل النص التالي إلى اللهجة السودانية الدارجة الخفيفة والمفهومة.
القواعد:
1. استخدم مفردات سودانية أصيلة ومفهومة (مثلاً: شديد، هسة، زول، تمام).
2. طبق قواعد صياغة الجمل السودانية مع الحفاظ على المعنى الأصلي بدقة.
3. تجنب المصطلحات شديدة الصعوبة أو "الراندوك" المبالغ فيه.
4. ابتعد تماماً عن أنماط الحديث المصرية أو الخليجية.
5. أخرج النص المعدل فقط.
      `,
  yemeni: `
أنت خبير لغوي في اللهجة اليمنية.
المهمة: تحويل النص التالي إلى اللهجة اليمنية البيضاء (المدنية) المفهومة واللطيفة.
القواعد:
1. استخدم مفردات يمنية دارجة خفيفة ومحببة (مثلاً: الحين، كذا، عاد، خلّينا، نشوف، تمام).
2. طبق قواعد صياغة الجمل اليمنية مع الحفاظ على المعنى الأصلي بدقة.
3. التزم بالنبرة اليمنية المدنية الواضحة والمباشرة.
4. تجنب المصطلحات قبلية أو إقليمية شديدة الصعوبة؛ اجعلها "لهجة بيضاء" يمنية.
5. ابتعد تماماً عن أنماط الحديث الخليجية أو السعودية الثقيلة.
6. أخرج النص المعدل فقط.
      `,
  lebanese: `
أنت خبير لغوي في اللهجة اللبنانية.
المهمة: تحويل النص التالي إلى اللهجة اللبنانية البيضاء (المدنية) الأنيقة واللطيفة.
القواعد:
1. استخدم مفردات لبنانية دارجة خفيفة ومحببة (مثلاً: هلق، كتير، هيك، خلّينا، تمام، أكيد، مش مشكلة).
2. طبق قواعد صياغة الجمل اللبنانية مع الحفاظ على المعنى الأصلي بدقة ومرونة.
3. التزم بالنبرة اللبنانية المدنية الراقية والواضحة.
4. تجنب المبالغة في اللكنة أو استخدام المصطلحات سوقية؛ اجعلها "لهجة بيضاء" لبنانية مهذبة تناسب المحتوى الاحترافي.
5. ابتعد تماماً عن أنماط الحديث المصرية أو الخليجية.
6. أخرج النص المعدل فقط.
      `,
};

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

const PODCAST_STYLE_GUIDES: Record<string, string> = {
  egyptian: "يجب توطين الحوار لغويًا ليعكس روح اللهجة المصرية العامية. استخدم تعبيرات مصرية دارجة (مثل: عشان، كده، إيه، مفيش) مع الحفاظ على سلاسة الحوار. يفضل تجنب المفردات شديدة الرسمية.",
  saudi: "يجب توطين الحوار ليعكس نمط الحديث السعودي الدارج والمهذب. استخدم مفردات وروح اللهجة السعودية.",
  khaleeji: "يجب أن يعكس الحوار نمط الحديث الخليجي الأبيض الواضح والمريح.",
  levantine: "يجب توطين الحوار لغويًا ليعكس روح اللهجة الشامية بأسلوبها العذب وتعبيراتها الدارجة (مثل: هيك، شو، كرمال).",
  sudanese: "يجب توطين الحوار لغويًا ليعكس روح اللهجة السودانية الدافئة. استخدم تعبيرات سودانية دارجة ومحببة (مثل: يا زول، هسة، تمام شديد) مع الحفاظ على الوقار السوداني المعتاد في الحديث.",
  yemeni: "يجب توطين الحوار ليعكس الأصالة اليمنية والأسلوب اليمني المدني الودود في الحديث. استخدم كلمات مثل (الحين، كذا، عاد، نشوف).",
  lebanese: "يجب توطين الحوار ليعكس الرقة والأناقة اللبنانية في التعبير (مثل: هلق، كتير، هيك، شو، كيفك، ميرسي، كرمالك، أكيد).",
  fusha: "يجب أن يكون الحوار باللغة العربية الفصحى السليمة والمعاصرة.",
};

function safeJsonParse(text: string, fallback: unknown): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

type Handler = (apiKey: string, body: Record<string, unknown>) => Promise<Response>;

const handlers: Record<string, Handler> = {
  // 1. معالجة النص وتكييفه مع اللهجة
  "preprocess-text": async (apiKey, body) => {
    const text = typeof body.text === "string" ? body.text : "";
    if (!text) return json({ text: "" });
    const options = (body.options as Record<string, unknown>) || {};
    const dialect = String(options.dialect || "العربية الفصحى");
    const dialectKey = dialect.toLowerCase();
    let dialectInstruction = `الالتزام بنمط وروح اللهجة: ${dialect}.`;
    if (dialectKey.includes("سودانية") || dialectKey === "sudanese") {
      dialectInstruction = DIALECT_INSTRUCTIONS.sudanese;
    } else if (dialectKey.includes("يمنية") || dialectKey === "yemeni") {
      dialectInstruction = DIALECT_INSTRUCTIONS.yemeni;
    } else if (dialectKey.includes("لبنانية") || dialectKey === "lebanese") {
      dialectInstruction = DIALECT_INSTRUCTIONS.lebanese;
    }
    const prompt = `
أنت خبير معالجة نصوص في استوديو "مدعوم". مهمتك هي إعادة صياغة النص العربي التالي ليناسب الأداء الصوتي المحترف.
${dialectInstruction}
النص المراد معالجته:
"${text}"
أخرج النص المعالج فقط بالعربية.
    `;
    try {
      const result = await generateContentWithFallback({
        apiKey,
        contents: [{ parts: [{ text: prompt }] }],
      });
      return json({ text: result.text || text });
    } catch (err) {
      console.error("[voice-studio] preprocess-text error:", (err as Error).message);
      return json({ text });
    }
  },

  // 2. الجمل المحورية
  "identify-key-sentences": async (apiKey, body) => {
    const text = typeof body.text === "string" ? body.text : "";
    if (!text || text.length < 20) return json({ sentences: [] });
    const prompt = `
أنت خبير تحليل محتوى عربي. قم بتحليل النص المرفق واستخرج أهم جملة أو جملتين (الجمل المحورية) فقط.
الجمل المحورية هي التي تمثل:
1. الفكرة الأساسية (Main Idea).
2. الرسالة المركزية (Key Message).
3. رؤية عميقة (Central Insight).
4. دعوة واضحة لاتخاذ إجراء (Call-to-Action).

القواعد الصارمة:
- استخرج الجمل كما هي حرفياً من النص الأصلي بدون أي تعديل أو إعادة صياغة.
- لا تضف أي شرح أو تعليق.
- أخرج النتائج بتنسيق JSON حصراً كصفوف في مصفوفة تحت مفتاح "sentences".
- إذا كان النص لا يحتوي على جمل واضحة، أخرج مصفوفة فارغة.

النص المرفق: "${text}"
    `;
    try {
      const result = await generateContentWithFallback({
        apiKey,
        contents: [{ parts: [{ text: prompt }] }],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: { sentences: { type: "ARRAY", items: { type: "STRING" } } },
            required: ["sentences"],
          },
        },
      });
      const parsed = safeJsonParse(result.text || '{"sentences":[]}', { sentences: [] }) as {
        sentences?: string[];
      };
      return json({ sentences: parsed.sentences || [] });
    } catch (err) {
      console.error("[voice-studio] identify-key-sentences error:", (err as Error).message);
      return json({ sentences: [] });
    }
  },

  // 3. تحليل النص وتقسيمه لمقاطع سردية (الكتاب الصوتي)
  "analyze-and-segment": async (apiKey, body) => {
    const text = typeof body.text === "string" ? body.text : "";
    const systemInstruction = `
أنت مخرج كتب صوتية خبير في استوديو "مدعوم". مهمتك هي تحليل النص العربي المرفق وتقسيمه إلى مقاطع سردية منطقية لتوزيع الأصوات.
القواعد:
1. ميز بين السرد (الراوي) والحوار (الشخصيات).
2. قسم النص إلى فقرات أو حوارات مترابطة.
3. اقترح "دور" (Role) لكل مقطع (مثلاً: الراوي، البطل، شخصية عابرة).
4. أخرج النتائج بتنسيق JSON حصراً كصفوف تحتوي على (label, role, text).
5. الالتزام باللغة العربية في المخرجات.
    `;
    try {
      const result = await generateContentWithFallback({
        apiKey,
        contents: [{ parts: [{ text: `قم بتحليل وتقسيم النص التالي: "${text}"` }] }],
        config: {
          systemInstruction: { parts: [{ text: systemInstruction }] },
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              segments: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    label: { type: "STRING" },
                    role: { type: "STRING" },
                    text: { type: "STRING" },
                  },
                  required: ["label", "role", "text"],
                },
              },
            },
            required: ["segments"],
          },
        },
      });
      const parsed = safeJsonParse(result.text || '{"segments":[]}', { segments: [] }) as {
        segments?: unknown[];
      };
      return json({
        segments: parsed.segments?.length
          ? parsed.segments
          : [{ label: "مقطع افتراضي", role: "الراوي", text }],
      });
    } catch (err) {
      console.error("[voice-studio] analyze-and-segment error:", (err as Error).message);
      return json({ segments: [{ label: "مقطع افتراضي", role: "الراوي", text }] });
    }
  },

  // 4. تفريغ ملف صوتي إلى نص
  "transcribe-media": async (apiKey, body) => {
    const base64 = typeof body.base64 === "string" ? body.base64 : "";
    const mimeType = typeof body.mimeType === "string" ? body.mimeType : "audio/mp3";
    const includeTimestamps = body.includeTimestamps === true;
    const language = typeof body.language === "string" ? body.language : "Auto";
    const timestampInstruction = includeTimestamps
      ? "قم بتقسيم النص إلى فقرات مع إضافة طوابع زمنية دقيقة بتنسيق [MM:SS] في بداية كل جملة أو فقرة منطقية."
      : "لا تضف أي طوابع زمنية، استخرج النص بشكل متصل مع مراعاة الفقرات.";
    const langInstruction = language === "Auto"
      ? "تعرف على اللغة تلقائياً وحافظ عليها."
      : `اللغة المتوقعة في الملف هي: ${language}. التزم بها بدقة.`;
    const prompt = `
أنت خبير تفريغ نصوص صوتية احترافي (Audio-to-Text). مهمتك هي استخراج النص الكامل من الملف الصوتي المرفق بدقة متناهية.
القواعد الصارمة:
1. استخرج النص كاملاً كما نُطق تماماً (Verbatim Transcription).
2. ممنوع التلخيص نهائياً (Do NOT summarize).
3. ممنوع الاختصار أو حذف أي كلمات (Do NOT shorten or skip).
4. ممنوع إعادة الصياغة؛ انقل الكلمات حرفياً (Do NOT paraphrase).
5. ${langInstruction}
6. حافظ على لهجة المتحدث الأصلية كما هي.
7. لا تقم بتنظيف اللغة أو تصحيح القواعد؛ استخرج ما قيل حرفياً.
8. ${timestampInstruction}
9. أخرج النص المفرغ فقط, بدون أي مقدمات أو تعليقات خارجية.
    `;
    try {
      const result = await generateContentWithFallback({
        apiKey,
        models: TRANSCRIBE_MODELS,
        contents: [{ parts: [{ inlineData: { mimeType, data: base64 } }, { text: prompt }] }],
      });
      return json({ text: result.text || "" });
    } catch (err) {
      console.error("[voice-studio] transcribe-media error:", (err as Error).message);
      return json(
        { error: (err as Error).message || "فشل في تفريغ النص من الملف الصوتي." },
        500,
      );
    }
  },

  // 5. استخراج النص من ملف/مستند
  "extract-text": async (apiKey, body) => {
    const base64 = typeof body.base64 === "string" ? body.base64 : "";
    const mimeType = typeof body.mimeType === "string" ? body.mimeType : "image/png";
    const prompt = "استخرج كافة النصوص العربية المقروءة من الملف المرفق بشكل نظيف وصالح للقراءة الصوتية.";
    try {
      const result = await generateContentWithFallback({
        apiKey,
        contents: [{ parts: [{ inlineData: { mimeType, data: base64 } }, { text: prompt }] }],
      });
      const text = result.text || "";
      if (!text.trim()) return json({ error: "تعذر تحليل المحتوى." }, 400);
      return json({ text });
    } catch (err) {
      console.error("[voice-studio] extract-text error:", (err as Error).message);
      return json({ error: "تعذر تحليل المحتوى. يُرجى مراجعة الملف أو تقسيمه." }, 500);
    }
  },

  // 6. توليد سكربت بودكاست (شخصيات + أدوار حوارية)
  "generate-podcast-script": async (apiKey, body) => {
    const content = typeof body.content === "string" ? body.content : "";
    const dialect = typeof body.dialect === "string" ? body.dialect : "فصحى";
    const dialectId = typeof body.dialectId === "string" ? body.dialectId : "fusha";
    const existingSpeakers = Array.isArray(body.existingSpeakers) ? body.existingSpeakers : [];
    if (!content.trim()) {
      return json({ turns: [], speakers: [], error: "لا يوجد نص لتحليله." });
    }
    const styleGuide = PODCAST_STYLE_GUIDES[dialectId]
      || `الالتزام بنمط الحديث الخاص بـ ${dialect}.`;
    let speakersInstruction = "";
    if (existingSpeakers.length > 0) {
      speakersInstruction = `
STRICT REQUIREMENT: The user has manually defined the following speakers. You MUST include ALL of them in the generated script turns:
${existingSpeakers.map((s) => `- ID: ${(s as Record<string, unknown>).id}, Role: ${(s as Record<string, unknown>).role}, Tone: ${(s as Record<string, unknown>).tone}`).join("\n")}

INSTRUCTIONS:
1. Re-analyze the content balance to include all these defined speakers naturally.
2. DO NOT delete, rename, or overwrite any of the IDs or Roles provided above.
3. If the script was previously two speakers and now there are more, expand the narrative turns to give the new characters significant presence.
4. Return all speakers (including the ones provided above) in the "speakers" array.
      `;
    }
    const analysisSystemInstruction = `
أنت خبير صياغة حوارات بودكاست ومخرج فني في استوديو "مدعوم".
المهمة: تحليل النص المرفق وتنفيذ معالجة ذكية للسيناريو والشخصيات:
1. تحليل الشخصيات: تحديد كافة المتحدثين المذكورين أو المستنبطين من النص بدقة. استخرج العدد الحقيقي للمتحدثين الذين يثرون الحوار بناءً على تعقيد المحتوى.
2. تصنيف الأدوار: حدد الدور لكل شخصية ونبرة الحديث (هادئ، متحمس، رسمي).
3. ذكاء التوزيع: اقترح أفضل فئة صوتية (categoryHint) من الخيارات التالية لكل شخصية جديدة: [doc, ads, cartoon, podcast, novels, youtube, drama, edu, corporate].
4. صياغة السيناريو: تحويل المحتوى إلى حوار منساب طبيعي بين الشخصيات.

${speakersInstruction}

إرشاد اللهجة:
${styleGuide}

المخرجات المطلوبة بتنسيق JSON:
- "speakers": مصفوفة من الكائنات تحتوي على (id, role, tone, style, gender ['male', 'female', 'any'], categoryHint, description, reasoning).
- "turns": مصفوفة من الكائنات (speakerId, text).
    `;
    try {
      const result = await generateContentWithFallback({
        apiKey,
        contents: [{ parts: [{ text: `المحتوى المراد تحليله: "${content}"` }] }],
        config: {
          systemInstruction: { parts: [{ text: analysisSystemInstruction }] },
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              error: { type: "STRING" },
              speakers: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    id: { type: "STRING" },
                    role: { type: "STRING" },
                    tone: { type: "STRING" },
                    style: { type: "STRING" },
                    gender: { type: "STRING", enum: ["male", "female", "any"] },
                    categoryHint: {
                      type: "STRING",
                      enum: ["doc", "ads", "cartoon", "podcast", "novels", "youtube", "drama", "edu", "corporate"],
                    },
                    description: { type: "STRING" },
                    reasoning: { type: "STRING" },
                  },
                  required: ["id", "role", "tone", "style", "gender", "categoryHint", "description", "reasoning"],
                },
              },
              turns: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    speakerId: { type: "STRING" },
                    text: { type: "STRING" },
                  },
                  required: ["speakerId", "text"],
                },
              },
            },
            required: ["turns", "speakers"],
          },
        },
      });
      const parsed = safeJsonParse(result.text || '{"turns":[], "speakers":[]}', {
        turns: [],
        speakers: [],
      });
      return json(parsed as Record<string, unknown>);
    } catch (err) {
      console.error("[voice-studio] generate-podcast-script error:", (err as Error).message);
      return json({ turns: [], speakers: [], error: "تعذر تحليل المحتوى." });
    }
  },

  // 7. تحويل النص إلى صوت (TTS) — ليس هنا: يُرسَل قبل بوابة المفتاح
  // في serve() إلى handleTts، لأن محرك edge يعمل بلا مفتاح.
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
  if (action === "generate-stream") {
    return handleStream(req, body);
  }
  if (action === "tts") {
    return handleTts(req, body);
  }
  const handler = handlers[action];
  if (!handler) {
    return json({ error: "إجراء غير معروف." }, 400);
  }
  const apiKey = resolveApiKey(req, body);
  if (!apiKey) {
    return json(
      { error: "هذه الوظيفة تحتاج مفتاح Gemini — أدخل مفتاحك الشخصي في إعدادات الاستوديو الصوتي أو اضبط GEMINI_API_KEY. التوليد الصوتي وحده يعمل بلا مفتاح عبر محرك Edge TTS." },
      503,
    );
  }
  try {
    return await handler(apiKey, body);
  } catch (err) {
    console.error(`[voice-studio] ${action} unexpected error:`, (err as Error).message);
    return json({ error: formatAIErrorMessage(err) }, 500);
  }
});

// 8. توليد نصي متدفق (SSE) — يمرّر بث Gemini كما هو بصيغة data: {"text": ...}
async function handleStream(req: Request, body: Record<string, unknown>): Promise<Response> {
  const apiKey = resolveApiKey(req, body);
  if (!apiKey) {
    return new Response(
      `data: ${JSON.stringify({ error: "لم يُضبط مفتاح Gemini بعد." })}\n\ndata: [DONE]\n\n`,
      { headers: { ...CORS_HEADERS, "Content-Type": "text/event-stream" } },
    );
  }
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const model = typeof body.model === "string" && body.model ? body.model : "gemini-3.8-flash";
  const systemInstruction = typeof body.systemInstruction === "string" ? body.systemInstruction : "";
  let upstream: Response;
  try {
    upstream = await fetchWithTimeout(
      `${GEMINI_API_BASE}/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          ...(systemInstruction
            ? { systemInstruction: { parts: [{ text: systemInstruction }] } }
            : {}),
        }),
      },
    );
  } catch (err) {
    return new Response(
      `data: ${JSON.stringify({ error: (err as Error).message || "Streaming failed" })}\n\ndata: [DONE]\n\n`,
      { headers: { ...CORS_HEADERS, "Content-Type": "text/event-stream" } },
    );
  }
  if (!upstream.ok || !upstream.body) {
    return new Response(
      `data: ${JSON.stringify({ error: "فشل بدء البث المباشر." })}\n\ndata: [DONE]\n\n`,
      { headers: { ...CORS_HEADERS, "Content-Type": "text/event-stream" } },
    );
  }
  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const raw = trimmed.slice(5).trim();
            if (!raw) continue;
            try {
              const parsed = JSON.parse(raw) as Record<string, unknown>;
              const parts = (parsed?.candidates as Array<Record<string, unknown>>)?.[0]
                ?.content as Record<string, unknown>;
              const text = (parts?.parts as Array<Record<string, unknown>>)?.[0]?.text as string;
              if (text) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
              }
            } catch {
              // سطر غير JSON يُتجاهل
            }
          }
        }
      } catch (err) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: (err as Error).message })}\n\n`),
        );
      } finally {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
