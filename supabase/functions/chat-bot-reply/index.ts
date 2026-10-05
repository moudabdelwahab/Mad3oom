import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

// ============================================================
// chat-bot-reply
// ------------------------------------------------------------
// نسخة مُهاجَرة (Edge Function) من محرك الرد المحلي chatbot-engine.js
// (كان بيشتغل client-side جوه chat-logic.js و chat-widget.js).
// الهدف: منطق واحد مشترك يستخدمه الموقع وتطبيق Mad3oom Chat الأصلي
// (Android/Kotlin) بدل ما كل عميل يكرر نفس الـ 500 سطر.
//
// فرق مهم عن النسخة القديمة: الدالة دي بتعمل الإدراجين (رسالة العميل +
// رد البوت) بنفسها في chat_messages، مش بس بترجع نص للعميل يحفظه هو.
// ده مقصود عشان لو أكتر من عميل (موقع + موبايل) فاتحين نفس الجلسة،
// الاتنين ياخدوا نفس الرد عن طريق Realtime بدل ما كل عميل يحسب/يخزن
// بشكل منفصل.
//
// [Phase A] هذه نقطة الدخول القانونية (canonical) المشتركة بين كل
// العملاء (website + Android). منطق أوضاع البوت (chatbot_mode /
// has_chatbot_entitlement) بيتضاف هنا تدريجيًا (Phase A: فقط حد
// الاستخدام الساعي للـ AI fallback عبر generate-ai-chat-reply؛ اختيار
// الوضع نفسه Traditional/AI Model/Auto/SIE - مرحلة لاحقة).
//
// العقد (contract) - لسه زي ما هو، بلا تغيير، للحفاظ على التوافق مع
// كل العملاء الحاليين (بما فيهم أندرويد):
//   POST body: { sessionId: string, message: string, imageUrl?: string }
//   Header: Authorization: Bearer <user JWT>  (نفس اللي بيستخدمه العميل
//           مع Supabase Auth بالظبط)
//   Response: {
//     reply?: string, options?: {label:string,value:string}[],
//     ticketCreated?: boolean, ticketNumber?: number, ticketType?: string,
//     skipped?: boolean   // true لو الجلسة في is_manual_mode (أدمن بيرد بنفسه)
//   }
// ============================================================

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// ===================== أدوات المطابقة (تطبيع + فهم تقريبي) =====================
// (منقولة بالحرف من chatbot-engine.js v6 - نفس الخوارزميات بالظبط)

function collapseRepeatedChars(text: string): string {
  return text.replace(/(.)\1{2,}/g, "$1");
}

function normalizeArabic(text: string | null | undefined): string {
  if (!text) return "";
  let t = String(text).toLowerCase();
  t = collapseRepeatedChars(t);
  t = t
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/\u0640/g, "")
    .replace(/[إأآا]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[؟،؛٪]/g, " ")
    .replace(/[^\u0600-\u06FFa-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[b.length];
}

function fuzzyWordMatch(word: string, target: string): boolean {
  if (word === target) return true;
  if (Math.abs(word.length - target.length) > 2) return false;
  const threshold = target.length >= 7 ? 2 : 1;
  return levenshtein(word, target) <= threshold;
}

function matchesPattern(normalizedText: string, rawPattern: string): boolean {
  const pattern = normalizeArabic(rawPattern);
  if (!pattern) return false;
  if (normalizedText.includes(pattern)) return true;

  const patternWords = pattern.split(" ").filter(Boolean);
  const textWords = normalizedText.split(" ").filter(Boolean);

  if (patternWords.length === 1 && patternWords[0].length >= 4) {
    return textWords.some((w) => fuzzyWordMatch(w, patternWords[0]));
  }
  if (patternWords.length >= 2 && patternWords.length <= 3) {
    return patternWords.every((pw) =>
      textWords.some((tw) => tw === pw || tw.includes(pw) || pw.includes(tw) || fuzzyWordMatch(tw, pw))
    );
  }
  return false;
}

function matchAny(normalizedText: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesPattern(normalizedText, p));
}

// ===================== قائمة الاختيارات الرئيسية =====================
interface QuickOption { label: string; value: string; }

const MAIN_MENU_OPTIONS: QuickOption[] = [
  { label: "[[icon:inquiry]] عندي استفسار", value: "عندي استفسار" },
  { label: "[[icon:problem]] عندي مشكلة", value: "عندي مشكلة" },
];

const CANCEL_OPTIONS: QuickOption[] = [
  { label: "[[icon:cancel]] إلغاء والرجوع للقائمة", value: "الغاء" },
];

const PROBLEM_CATEGORY_OPTIONS: QuickOption[] = [
  { label: "[[icon:whatsapp]] واتساب", value: "واتساب" },
  { label: "[[icon:ticket]] التذاكر", value: "التذاكر" },
  { label: "[[icon:subscription]] الاشتراك", value: "الاشتراك" },
  { label: "[[icon:login]] تسجيل الدخول", value: "تسجيل الدخول" },
  { label: "[[icon:other]] حاجة تانية", value: "حاجة تانية" },
];

const IMAGE_STEP_OPTIONS: QuickOption[] = [
  { label: "[[icon:attach]] إرفاق صورة", value: "__attach_image__" },
  { label: "[[icon:skip]] تخطي وإنشاء التذكرة", value: "تخطي" },
];

function getOptionsForFlow(flow: string | undefined): QuickOption[] {
  if (flow === "awaiting_problem_category") return PROBLEM_CATEGORY_OPTIONS;
  if (flow === "awaiting_problem_image") return IMAGE_STEP_OPTIONS;
  if (flow === "awaiting_inquiry_text" || flow === "awaiting_contact_info" || flow === "awaiting_problem_desc") {
    return CANCEL_OPTIONS;
  }
  return MAIN_MENU_OPTIONS;
}

interface Category { slug: string; label: string; }

const CATEGORY_MAP: { slug: string; label: string; patterns: string[] }[] = [
  { slug: "whatsapp", label: "واتساب", patterns: ["واتساب", "whatsapp", "وتساب", "واتس", "الواتس", "رقم الواتساب"] },
  { slug: "tickets", label: "التذاكر", patterns: ["التذاكر", "تذكره", "تذاكر", "ticket", "تيكت", "البلاغات", "بلاغ"] },
  { slug: "subscription", label: "الاشتراك", patterns: ["الاشتراك", "اشتراك", "باقه", "subscription", "فاتوره", "الدفع", "الفلوس اتخصمت"] },
  { slug: "login", label: "تسجيل الدخول", patterns: ["تسجيل الدخول", "دخول", "لوجين", "login", "باسورد", "كلمه السر", "الحساب مقفول", "نسيت الباسورد"] },
  { slug: "other", label: "حاجة تانية", patterns: ["حاجه تانيه", "اخرى", "غير ذلك", "other"] },
];

function detectCategory(raw: string): Category {
  const normalized = normalizeArabic(raw);
  for (const c of CATEGORY_MAP) {
    if (matchAny(normalized, c.patterns)) return { slug: c.slug, label: c.label };
  }
  const fallbackLabel = raw.trim().slice(0, 30) || "حاجة تانية";
  return { slug: "other", label: fallbackLabel };
}

// ===================== الكلمات المفتاحية =====================
const DEFAULT_GREETING_PATTERNS = [
  "مرحبا", "اهلا", "هاي", "هلا", "السلام عليكم", "صباح الخير", "مساء الخير",
  "ezayak", "ezayek", "hi", "hello", "هاى", "ايه الاخبار", "ازيك", "عامل ايه",
  "كيفك", "شلونك", "ايش اخبارك", "هلابيك", "يعطيك العافيه صباحا", "صباح النور",
  "مساء النور", "اخبارك ايه", "ايه الاخبار يا معلم", "تمام يا باشا",
];

const THANKS_PATTERNS = [
  "شكرا", "تسلم", "مشكور", "ربنا يخليك", "thanks", "thank you", "يعطيك العافيه",
  "متشكر", "الله يعافيك", "يسلمو", "مرسي", "تسلم ايدك", "الله يكرمك", "ثانكس",
];

const CANCEL_PATTERNS = [
  "الغاء", "كانسل", "cancel", "سيب", "بطل", "مش عايز", "رجعني", "رجوع",
  "القائمه", "الرئيسيه", "رجعني للقائمه", "back", "menu", "رجع تاني",
  "وقف كده", "خلاص بطل", "مش محتاج كده",
];

const MENU_INQUIRY_PATTERNS = [
  "عندي استفسار", "استفسار", "سؤال", "عايز اسال", "حابب اسال", "question", "1",
  "عندي سؤال", "محتاج اسال", "ممكن اسال", "عايز افهم", "حاب اعرف",
];

const MENU_PROBLEM_PATTERNS = [
  "عندي مشكله", "مشكله", "عطل", "مش شغال", "بلاغ", "شكوي", "معطل", "واقف",
  "مش عامل", "مش بيشتغل", "فيه خطا", "في خطأ", "error", "bug", "problem",
  "issue", "مش راضي يفتح", "علق", "هانج", "بطئ", "بطيء", "مش بيرد", "2",
  "حصلت مشكله", "في عطل", "واجهتني مشكله", "عندي عطل", "الموقع فاصل",
  "مش قادر ادخل", "مش عارف اعمل كذا", "حصل ايه", "خربان", "مش شغاله",
];

const TICKET_STATUS_PATTERNS = [
  "حاله تذكرتي", "حالة تذكرتي", "تذكرتي وصلت لفين", "تذكرتي ايه", "وصلت لفين",
  "اخر حاله", "رقم تذكرتي", "تذاكري", "متابعه تذكره", "تذكرتي اتحلت",
  "ticket status", "my ticket", "تذكرتي فين", "وصل البلاغ فين", "تابعت البلاغ",
  "فين تذكرتي", "ايه اخبار تذكرتي", "البلاغ بتاعي عامل ايه", "اتحل البلاغ",
  "حالة البلاغ",
];

const SUBSCRIPTION_STATUS_PATTERNS = [
  "اشتراكي", "باقتي", "خطتي ايه", "اشتراكي هيخلص", "امتي هيخلص", "امتي ينتهي",
  "تاريخ الانتهاء", "اشتراكي شغال", "subscription status", "متي ينتهي اشتراكي",
  "باقتي هتخلص", "خطتي هتخلص", "فاضلي كام يوم", "باقتي لسه شغاله",
  "اشتراكي فعال", "خطتي دلوقتي ايه",
];

const PLATFORM_INFO_PATTERNS = [
  "مدعوم ايه", "ايه هي مدعوم", "المنصه دي ايه", "بتقدموا ايه", "الخدمات بتاعتكم",
  "what is mad3oom", "about platform", "انتوا بتعملوا ايه", "الموقع ده بيعمل ايه",
  "احكيلي عن المنصه", "عايز اعرف عن الموقع", "ايه هو مدعوم بالظبط",
];

const PRICING_GENERAL_PATTERNS = [
  "اسعار", "الاسعار", "سعر", "الخطط", "الباقات", "اشتراك", "اشتراكات",
  "فلوس", "تكلفه", "price", "pricing", "plan", "plans", "كام", "بكام",
  "عايز اشترك", "عايز اعرف الاسعار", "التسعيره", "اسعاركم كام", "بتتكلفوا كام",
];

const PLAN_FREE_PATTERNS = ["مجاني", "مجانا", "فري", "free", "بدون مقابل", "من غير فلوس"];
const PLAN_SUPPORT_PATTERNS = ["دعم فني", "خطه الدعم", "تذاكر فقط", "support plan", "تيكتس", "خطه التذاكر"];
const PLAN_WHATSAPP_PATTERNS = ["واتساب", "whatsapp", "وتساب", "واتس", "خطه الواتساب"];
const PLAN_BUNDLE_PATTERNS = ["باقه", "الباقه الشامله", "bundle", "الاتنين", "دعم وواتساب", "كومبو", "الشامله", "الباقه الكبيره"];
const DISCOUNT_PATTERNS = ["خصم", "عرض", "تخفيض", "offer", "discount", "عروض", "فيه تخفيضات", "عروض الاطلاق"];
const ENTERPRISE_PATTERNS = ["شركات", "شركه", "enterprise", "مؤسسه", "بيزنس", "عندي شركه"];
const COMPARE_PATTERNS = ["فرق", "مقارنه", "ايه الفرق", "بين الخطط", "compare", "ايه احسن خطه"];

// ===================== ردود الاشتراكات =====================
const PLAN_TEXT: Record<string, string> = {
  free: `الخطة المجانية [[icon:gift]] من غير ما تدفع ولا جنيه:
• نظام تذاكر أساسي
• محادثة مع الدعم في ساعات العمل
• تقدر تبلغ عن أي مشكلة
• بتجمع نقاط على كل بلاغ
متاحة دايمًا من غير ما تنتهي.`,

  support: `خطة "الدعم الفني" [[icon:ticket]] بـ 15$/شهر بدل 25$ (خصم 40%)، أو 150$/سنة بدل 180$ (خصم 17%):
• تذاكر دعم غير محدودة يوميًا
• نطاق فرعي مجاني زي company.mad3oom.online
• مدير واحد + لغاية 25 عضو
• إحصائيات متقدمة وسجل نشاط للفريق`,

  whatsapp: `خطة "واتساب" [[icon:whatsapp]] بـ 20$/شهر بدل 30$ (خصم 33%)، أو 200$/سنة بدل 240$ (خصم 17%):
• تربط رقم الواتساب بتاعك بالمنصة
• تستقبل وترد على رسائل العملاء من لوحة التحكم
• إشعارات فورية بأي رسالة جديدة
• تقدر تضيف خدمة الرد الآلي بعدين
ولو اشتركت بالرد الآلي مع الخطة الشهرية بتاخد 14 يوم إضافي مجانًا، أو 3 شهور زيادة لو سنوي [[icon:gift]]`,

  bundle: `الباقة الشاملة "دعم فني + واتساب" [[icon:growth]] وهي الأكتر توفيرًا، بـ 30$/شهر بدل 55$ (خصم 45%)، أو 330$/سنة بدل 660$ (خصم 50%):
• كل مميزات الدعم الفني + الواتساب مع بعض
• دعم أولوية 24/7
• نقاط مكافآت مضاعفة
• شارة خاصة على بروفايلك`,

  enterprise: `بالنسبة للشركات [[icon:briefcase]] عندنا خطط مخصصة (مستخدمين مش محدودين، دعم مخصص 24/7، API وتكامل مع أنظمتك، SLA). التفاصيل والأسعار هيتم الإعلان عنها قريبًا، تحب أفتحلك تذكرة عشان فريق المبيعات يتواصل معاك؟`,

  compare: `هاديلك خلاصة سريعة:
[[icon:gift]] مجاني: تذاكر أساسية بس + دعم في ساعات العمل
[[icon:ticket]] دعم فني (15$/شهر): تذاكر غير محدودة + نطاق فرعي + فريق لغاية 25 عضو
[[icon:whatsapp]] واتساب (20$/شهر): ربط رقم واتساب بالمنصة بس من غير نظام تذاكر
[[icon:growth]] الباقة الشاملة (30$/شهر): كل حاجة مع بعض + أولوية 24/7 + شارة خاصة وأفضل توفير`,

  general: `عندنا 4 خطط:
[[icon:gift]] مجاني — 0$
[[icon:ticket]] الدعم الفني — 15$/شهر (بدل 25$)
[[icon:whatsapp]] واتساب — 20$/شهر (بدل 30$)
[[icon:growth]] دعم فني + واتساب (الأشمل) — 30$/شهر (بدل 55$، أكبر خصم وأوفر باقة)
كله متاح شهري أو سنوي بخصم إضافي.`,
};

const PLATFORM_INFO_TEXT = `منصة مدعوم [[icon:star]] هي منصة لإدارة الدعم الفني وواتساب بزنس في مكان واحد:
• نظام تذاكر لمتابعة مشاكل عملائك
• ربط رقم واتساب وإدارة الرسائل من لوحة تحكم واحدة
• رد آلي ذكي على رسائل واتساب
• محادثة مباشرة (لايف شات) مع العملاء
• نظام نقاط ومكافآت
• قاعدة معرفة لمقالات المساعدة`;

const TICKET_STATUS_LABELS: Record<string, string> = {
  open: "مفتوحة [[icon:dot-yellow]]",
  in_progress: "قيد التنفيذ [[icon:dot-blue]]",
  resolved: "تم الحل [[icon:dot-green]]",
  confirmed: "مؤكدة [[icon:dot-green]]",
  rejected: "مرفوضة [[icon:dot-red]]",
};

const SUB_PLAN_LABELS: Record<string, string> = { support: "الدعم الفني", whatsapp: "واتساب", bundle: "الباقة الشاملة (دعم + واتساب)" };
const SUB_STATUS_LABELS: Record<string, string> = {
  active: "فعّال [[icon:dot-green]]",
  expired: "منتهي [[icon:dot-red]]",
  pending: "قيد المراجعة [[icon:dot-yellow]]",
  rejected: "مرفوض [[icon:dot-red]]",
};

// ===================== استعلامات بيانات العميل (مفلترة بـ user_id دايمًا) =====================
async function getMyTicketsReply(supabase: SupabaseClient, userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("tickets")
    .select("ticket_number, title, status, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) {
    console.error("خطأ في جلب تذاكر العميل:", error);
    return "حصل خطأ بسيط وإحنا بنجيب تذاكرك، جرب تاني كمان شوية [[icon:note]]";
  }
  if (!data || data.length === 0) {
    return "مفيش عندك أي تذاكر مفتوحة دلوقتي.";
  }

  const lines = data.map((t: any) => {
    const label = TICKET_STATUS_LABELS[t.status] || t.status;
    const date = new Date(t.created_at).toLocaleDateString("ar-EG");
    return `• تذكرة #${t.ticket_number} — ${t.title} — الحالة: ${label} (${date})`;
  });

  return `دي آخر تذاكرك:\n${lines.join("\n")}`;
}

async function getMySubscriptionReply(supabase: SupabaseClient, userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("whatsapp_subscriptions")
    .select("plan, status, billing_cycle, end_date")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(3);

  if (error) {
    console.error("خطأ في جلب اشتراك العميل:", error);
    return "حصل خطأ بسيط وإحنا بنجيب بيانات اشتراكك، جرب تاني كمان شوية [[icon:note]]";
  }
  if (!data || data.length === 0) {
    return "مش لاقي عندك اشتراك مدفوع حاليًا، يبدو إنك على الخطة المجانية [[icon:gift]].";
  }

  const lines = data.map((s: any) => {
    const plan = SUB_PLAN_LABELS[s.plan] || s.plan;
    const status = SUB_STATUS_LABELS[s.status] || s.status;
    const cycle = s.billing_cycle === "yearly" ? "سنوي" : "شهري";
    let dateInfo = "";
    if (s.end_date) {
      const end = new Date(s.end_date);
      const daysLeft = Math.ceil((end.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      const dateStr = end.toLocaleDateString("ar-EG");
      dateInfo = daysLeft > 0 ? ` — هينتهي يوم ${dateStr} (باقي ${daysLeft} يوم)` : ` — انتهى يوم ${dateStr}`;
    }
    return `• ${plan} (${cycle}) — الحالة: ${status}${dateInfo}`;
  });

  return `دي بيانات اشتراكك:\n${lines.join("\n")}`;
}

function getPricingReply(normalizedText: string): string | null {
  if (matchAny(normalizedText, ENTERPRISE_PATTERNS)) return PLAN_TEXT.enterprise;
  if (matchAny(normalizedText, COMPARE_PATTERNS)) return PLAN_TEXT.compare;
  if (matchAny(normalizedText, PLAN_BUNDLE_PATTERNS)) return PLAN_TEXT.bundle;
  if (matchAny(normalizedText, PLAN_WHATSAPP_PATTERNS)) return PLAN_TEXT.whatsapp;
  if (matchAny(normalizedText, PLAN_SUPPORT_PATTERNS)) return PLAN_TEXT.support;
  if (matchAny(normalizedText, PLAN_FREE_PATTERNS)) return PLAN_TEXT.free;
  if (matchAny(normalizedText, DISCOUNT_PATTERNS)) {
    return `عروض الإطلاق الحالية [[icon:percent]] (سارية 6 شهور أو لحد ما نوصل لعدد العملاء المستهدف):
• الدعم الفني: خصم 40% شهري / 17% سنوي
• واتساب: خصم 33% شهري / 17% سنوي
• الباقة الشاملة: خصم 45% شهري / 50% سنوي (أكبر خصم!)`;
  }
  if (matchAny(normalizedText, PRICING_GENERAL_PATTERNS)) return PLAN_TEXT.general;
  return null;
}

async function detectKnownTopic(normalized: string, supabase: SupabaseClient, userId: string): Promise<string | null> {
  if (matchAny(normalized, TICKET_STATUS_PATTERNS)) return await getMyTicketsReply(supabase, userId);
  if (matchAny(normalized, SUBSCRIPTION_STATUS_PATTERNS)) return await getMySubscriptionReply(supabase, userId);
  if (matchAny(normalized, PLATFORM_INFO_PATTERNS)) return PLATFORM_INFO_TEXT;
  const pricingReply = getPricingReply(normalized);
  if (pricingReply) return pricingReply;
  return null;
}

// ===================== إنشاء التذاكر =====================
interface CreateTicketParams {
  supabase: SupabaseClient;
  userId: string;
  title?: string;
  description?: string;
  ticketType: "problem" | "inquiry";
  contactInfo?: string;
  category?: string;
  imageUrl?: string;
}

async function createTicket(params: CreateTicketParams): Promise<{ ok: boolean; ticketNumber?: number }> {
  const { supabase, userId, title, description, ticketType, contactInfo, category, imageUrl } = params;
  const payload: Record<string, unknown> = {
    user_id: userId,
    title: (title || "طلب من الشات").slice(0, 200),
    description: description || title || "",
    status: "open",
    priority: ticketType === "problem" ? "medium" : "low",
    ticket_type: ticketType,
  };
  if (contactInfo) payload.contact_info = contactInfo;
  if (category) payload.category = category;
  if (imageUrl) payload.image_url = imageUrl;

  const { data, error } = await supabase.from("tickets").insert(payload).select("ticket_number").single();

  if (error) {
    console.error("خطأ في إنشاء التذكرة من البوت:", error);
    return { ok: false };
  }
  return { ok: true, ticketNumber: data?.ticket_number };
}

async function saveBotState(supabase: SupabaseClient, sessionId: string, newState: Record<string, unknown>) {
  await supabase.from("chat_sessions").update({ bot_state: newState }).eq("id", sessionId);
}

// ===== استدعاء الرد الذكي (fallback) - نداء داخلي (server-to-server) لـ generate-ai-chat-reply =====
// بنمرر نفس الـ Authorization header بتاع طلب العميل الأصلي، عشان دالة
// generate-ai-chat-reply تقدر تتحقق من هوية المستخدم وملكيته للجلسة
// بنفس الطريقة اللي كانت شغالة بيها لما العميل كان بينادهيها مباشرة.
//
// [Phase A] generate-ai-chat-reply دلوقتي بترجع 429 + code: "quota_exceeded"
// لما الحساب المجاني يوصل لحد الرسائل الذكية في الساعة. بنميّز الحالة دي
// عشان نقدر نرجّع رسالة واضحة للعميل بدل ما تدوب في fallback "مش متأكد
// إني فهمتك صح" العام.
interface AiFallbackResult { reply: string | null; quotaExceeded?: boolean; }

async function callAiFallback(authHeader: string, sessionId: string, message: string): Promise<AiFallbackResult> {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const res = await fetch(`${supabaseUrl}/functions/v1/generate-ai-chat-reply`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      let data: any = null;
      try { data = await res.json(); } catch { /* تجاهل - مش JSON صالح */ }
      if (res.status === 429 && data?.code === "quota_exceeded") {
        return { reply: null, quotaExceeded: true };
      }
      console.warn("[AI-FALLBACK] فشل نداء generate-ai-chat-reply، كود:", res.status);
      return { reply: null };
    }
    const data = await res.json();
    if (!data?.reply) {
      console.warn("[AI-FALLBACK] مفيش reply في الرد:", data);
      return { reply: null };
    }
    return { reply: data.reply as string };
  } catch (err) {
    console.warn("[AI-FALLBACK] استثناء أثناء النداء:", (err as Error)?.message || err);
    return { reply: null };
  }
}

// ===================== رسائل ثابتة =====================
const MENU_PROMPT = "اختار من الاختيارات دي أو اكتبلي طلبك بحريتك:";
const INQUIRY_ASK = "تمام، اكتبلي استفسارك وهحاول أجاوبك فورًا [[icon:inquiry]]";
const PROBLEM_CATEGORY_ASK = "إيه نوع المشكلة؟";
const PROBLEM_ASK = "تمام، اشرحلي المشكلة بالتفصيل عشان أفتحلك تذكرة وفريق الدعم يتابعها [[icon:search]]";
const PROBLEM_IMAGE_ASK = "حابب ترفق صورة توضح المشكلة؟ (اختياري) [[icon:attach]]";
const CONTACT_ASK = "الاستفسار ده محتاج متابعة من فريق الدعم بنفسه [[icon:note]] ابعتلي رقم موبايلك أو بريدك الإلكتروني عشان نتواصل معاك بخصوصه.";
const CANCELLED_MSG = "تمام، رجعناك للقائمة الرئيسية [[icon:smile]]";
const AI_QUOTA_EXCEEDED_MSG = "وصلت للحد الأقصى من الردود الذكية المجانية للساعة دي [[icon:note]] جرب تاني بعد شوية، أو اختار من الأسئلة الجاهزة تحت.";

function buildTicketConfirmation(botSettings: any, ticketType: string, ticketNumber?: number): string {
  const baseMsg = ticketType === "inquiry"
    ? (botSettings?.ticket_confirmation_message || "تم تسجيل استفسارك وفريق الدعم هيتواصل معاك في أقرب وقت.")
    : (botSettings?.ticket_message || "تم فتح تذكرة دعم فني وسيقوم فريقنا بالرد عليك في أقرب وقت.");
  return ticketNumber
    ? `${baseMsg} رقم التذكرة بتاعتك هو #${ticketNumber} [[icon:check]]`
    : `${baseMsg} [[icon:check]]`;
}

// ===================== نقطة الدخول الرئيسية (منطق الرد) =====================
interface BotState {
  flow?: string;
  greeted?: boolean;
  ticket_draft?: { category?: Category; description?: string; inquiry_text?: string };
}

interface BotReplyResult {
  reply: string;
  options?: QuickOption[];
  ticketCreated?: boolean;
  ticketNumber?: number;
  ticketType?: string;
}

async function getBotReply(opts: {
  text: string;
  supabase: SupabaseClient; // service-role client
  authHeader: string;
  sessionId: string;
  userId: string;
  botState: BotState;
  botSettings: any;
  imageUrl?: string;
}): Promise<BotReplyResult> {
  const { text, supabase, authHeader, sessionId, userId, botSettings, imageUrl } = opts;
  const raw = (text || "").trim();
  const normalized = normalizeArabic(raw);
  const state: BotState = opts.botState && typeof opts.botState === "object" ? { ...opts.botState } : {};
  const flow = state.flow || "idle";

  // ---------- إلغاء / رجوع للقائمة ----------
  if (!imageUrl && matchAny(normalized, CANCEL_PATTERNS)) {
    state.flow = "main_menu";
    state.ticket_draft = {};
    await saveBotState(supabase, sessionId, state as Record<string, unknown>);
    return { reply: `${CANCELLED_MSG}\n${MENU_PROMPT}`, options: MAIN_MENU_OPTIONS };
  }

  // ---------- تحويلات سريعة ----------
  const canSwitchMenu = flow === "idle" || flow === "main_menu" || flow === "awaiting_inquiry_text";
  if (canSwitchMenu && matchAny(normalized, MENU_PROBLEM_PATTERNS)) {
    state.flow = "awaiting_problem_category";
    state.ticket_draft = {};
    await saveBotState(supabase, sessionId, state as Record<string, unknown>);
    return { reply: PROBLEM_CATEGORY_ASK, options: PROBLEM_CATEGORY_OPTIONS };
  }
  if (canSwitchMenu && matchAny(normalized, MENU_INQUIRY_PATTERNS)) {
    state.flow = "awaiting_inquiry_text";
    state.ticket_draft = {};
    await saveBotState(supabase, sessionId, state as Record<string, unknown>);
    return { reply: INQUIRY_ASK, options: CANCEL_OPTIONS };
  }

  // ---------- فلو: اختيار نوع المشكلة ----------
  if (flow === "awaiting_problem_category") {
    const category = detectCategory(raw);
    state.flow = "awaiting_problem_desc";
    state.ticket_draft = { category };
    await saveBotState(supabase, sessionId, state as Record<string, unknown>);
    return { reply: PROBLEM_ASK, options: CANCEL_OPTIONS };
  }

  // ---------- فلو: وصف المشكلة ----------
  if (flow === "awaiting_problem_desc") {
    state.flow = "awaiting_problem_image";
    state.ticket_draft = { ...state.ticket_draft, description: raw };
    await saveBotState(supabase, sessionId, state as Record<string, unknown>);
    return { reply: PROBLEM_IMAGE_ASK, options: IMAGE_STEP_OPTIONS };
  }

  // ---------- فلو: صورة اختيارية ثم إنشاء التذكرة ----------
  if (flow === "awaiting_problem_image") {
    const category = state.ticket_draft?.category || { slug: "other", label: "حاجة تانية" };
    const description = state.ticket_draft?.description || "مشكلة من الشات";
    const title = `${category.label} - ${description.slice(0, 50)}`;
    const fullDescription = `نوع المشكلة: ${category.label}\n\n${description}`;

    const result = await createTicket({
      supabase, userId, title, description: fullDescription,
      ticketType: "problem", category: category.slug, imageUrl,
    });

    state.flow = "main_menu";
    state.ticket_draft = {};
    await saveBotState(supabase, sessionId, state as Record<string, unknown>);

    if (!result.ok) {
      return { reply: "حصل خطأ بسيط وإحنا بنفتح التذكرة، حاول تاني كمان شوية [[icon:note]]", options: MAIN_MENU_OPTIONS };
    }
    const confirmation = buildTicketConfirmation(botSettings, "problem", result.ticketNumber);
    return {
      reply: `${confirmation}\n\n${MENU_PROMPT}`, options: MAIN_MENU_OPTIONS,
      ticketCreated: true, ticketNumber: result.ticketNumber, ticketType: "problem",
    };
  }

  // ---------- فلو: نص الاستفسار ----------
  if (flow === "awaiting_inquiry_text") {
    const knownReply = await detectKnownTopic(normalized, supabase, userId);
    if (knownReply) {
      state.flow = "main_menu";
      state.ticket_draft = {};
      await saveBotState(supabase, sessionId, state as Record<string, unknown>);
      return { reply: `${knownReply}\n\n${MENU_PROMPT}`, options: MAIN_MENU_OPTIONS };
    }

    state.flow = "awaiting_contact_info";
    state.ticket_draft = { inquiry_text: raw };
    await saveBotState(supabase, sessionId, state as Record<string, unknown>);
    return { reply: CONTACT_ASK, options: CANCEL_OPTIONS };
  }

  // ---------- فلو: بيانات التواصل ----------
  if (flow === "awaiting_contact_info") {
    const inquiryText = state.ticket_draft?.inquiry_text || "استفسار من الشات";
    const result = await createTicket({
      supabase, userId, title: inquiryText.slice(0, 60), description: inquiryText,
      ticketType: "inquiry", contactInfo: raw,
    });
    state.flow = "main_menu";
    state.ticket_draft = {};
    await saveBotState(supabase, sessionId, state as Record<string, unknown>);

    if (!result.ok) {
      return { reply: "حصل خطأ بسيط وإحنا بنسجل استفسارك، حاول تاني كمان شوية [[icon:note]]", options: MAIN_MENU_OPTIONS };
    }
    const confirmation = buildTicketConfirmation(botSettings, "inquiry", result.ticketNumber);
    return {
      reply: `${confirmation}\n\n${MENU_PROMPT}`, options: MAIN_MENU_OPTIONS,
      ticketCreated: true, ticketNumber: result.ticketNumber, ticketType: "inquiry",
    };
  }

  // ---------- idle / main_menu ----------
  const directKnownReply = await detectKnownTopic(normalized, supabase, userId);
  if (directKnownReply) {
    state.flow = "main_menu";
    await saveBotState(supabase, sessionId, state as Record<string, unknown>);
    return { reply: `${directKnownReply}\n\n${MENU_PROMPT}`, options: MAIN_MENU_OPTIONS };
  }

  if (matchAny(normalized, THANKS_PATTERNS)) {
    return { reply: "العفو يا فندم، إحنا موجودين لو احتجت أي حاجة تانية [[icon:star]]", options: MAIN_MENU_OPTIONS };
  }

  if (matchAny(normalized, DEFAULT_GREETING_PATTERNS)) {
    const isFirstGreeting = !state.greeted;
    state.greeted = true;
    state.flow = "main_menu";
    await saveBotState(supabase, sessionId, state as Record<string, unknown>);

    const welcome = isFirstGreeting
      ? (botSettings?.welcome_message || "أهلاً بيك في منصة مدعوم! [[icon:smile]]")
      : "أهلاً بيك تاني [[icon:smile]]";

    return { reply: `${welcome}\n${MENU_PROMPT}`, options: MAIN_MENU_OPTIONS };
  }

  // ---------- fallback ذكي عبر AI (لو مفعّل) ----------
  if (botSettings?.ai_enabled && botSettings?.ai_integration_id) {
    const aiResult = await callAiFallback(authHeader, sessionId, raw);
    if (aiResult.reply) {
      if (!state.greeted) state.greeted = true;
      state.flow = "main_menu";
      await saveBotState(supabase, sessionId, state as Record<string, unknown>);
      return { reply: aiResult.reply, options: MAIN_MENU_OPTIONS };
    }
    if (aiResult.quotaExceeded) {
      if (!state.greeted) state.greeted = true;
      state.flow = "main_menu";
      await saveBotState(supabase, sessionId, state as Record<string, unknown>);
      return { reply: AI_QUOTA_EXCEEDED_MSG, options: MAIN_MENU_OPTIONS };
    }
  }

  if (!state.greeted) state.greeted = true;
  state.flow = "main_menu";
  await saveBotState(supabase, sessionId, state as Record<string, unknown>);
  return {
    reply: "مش متأكد إني فهمتك صح [[icon:note]] اختار من الاختيارات دي وهساعدك:",
    options: MAIN_MENU_OPTIONS,
  };
}

// ===================== HTTP handler =====================
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData?.user) return jsonResponse({ error: "Unauthorized" }, 401);
    const userId = userData.user.id;

    let body: { sessionId?: string; message?: string; imageUrl?: string };
    try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

    const sessionId = (body.sessionId || "").trim();
    const message = (body.message || "").trim();
    const imageUrl = body.imageUrl?.trim() || undefined;
    if (!sessionId || !message) return jsonResponse({ error: "sessionId و message مطلوبين" }, 400);

    // نتأكد إن الجلسة دي فعلاً بتاعة المستخدم ده عبر RLS (userClient) قبل أي حاجة تانية
    const { data: sessionRow } = await userClient
      .from("chat_sessions")
      .select("id, is_manual_mode, bot_state")
      .eq("id", sessionId)
      .maybeSingle();
    if (!sessionRow) return jsonResponse({ error: "الجلسة مش موجودة أو ممنوع الوصول" }, 403);

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // 1) تسجيل رسالة العميل دايمًا (سواء البوت هيرد أو لأ)
    const userMessagePayload: Record<string, unknown> = {
      session_id: sessionId,
      sender_id: userId,
      message_text: message,
      is_admin_reply: false,
    };
    if (imageUrl) userMessagePayload.image_url = imageUrl;

    const { error: insertUserMsgError } = await adminClient.from("chat_messages").insert(userMessagePayload);
    if (insertUserMsgError) {
      console.error("خطأ في حفظ رسالة العميل:", insertUserMsgError);
      return jsonResponse({ error: "فشل حفظ الرسالة" }, 500);
    }

    // 2) لو الجلسة في وضع يدوي (أدمن بيرد بنفسه)، البوت يسكت
    if (sessionRow.is_manual_mode) {
      return jsonResponse({ skipped: true });
    }

    // 3) إعدادات البوت (صف واحد حاليًا)
    const { data: botSettings } = await adminClient.from("bot_settings").select("*").single();

    // 4) حساب الرد (بيحدّث bot_state بنفسه جوه getBotReply)
    const result = await getBotReply({
      text: message,
      supabase: adminClient,
      authHeader,
      sessionId,
      userId,
      botState: (sessionRow.bot_state as BotState) || {},
      botSettings,
      imageUrl,
    });

    // 5) تسجيل رد البوت
    const { error: insertBotMsgError } = await adminClient.from("chat_messages").insert({
      session_id: sessionId,
      sender_id: null,
      message_text: result.reply,
      is_admin_reply: false,
      is_bot_reply: true,
    });
    if (insertBotMsgError) console.error("خطأ في حفظ رد البوت:", insertBotMsgError);

    return jsonResponse({
      reply: result.reply,
      options: result.options,
      ticketCreated: result.ticketCreated || false,
      ticketNumber: result.ticketNumber,
      ticketType: result.ticketType,
      skipped: false,
    });
  } catch (err) {
    console.error("chat-bot-reply error:", err);
    return jsonResponse({ error: "حدث خطأ غير متوقع: " + (err as Error).message }, 500);
  }
});

// نصدّر الأدوات المشتركة (helpful لو حبينا نكتبلها اختبارات لاحقًا)
export { normalizeArabic, matchAny, matchesPattern, getOptionsForFlow, MAIN_MENU_OPTIONS };
