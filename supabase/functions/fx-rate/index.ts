// ============================================================
// fx-rate — سعر الصرف الحي (دولار → جنيه) للفوترة
// ------------------------------------------------------------
// الأسعار في مدعوم بالدولار (بطاقة Meta لمصر)، والجنيه يُحسب وقت
// المحاسبة فقط — فلا رقم صرف ثابت في أي ملف. هذه الدالة هي المصدر
// الوحيد الحي لسعر الصرف، وتُستدعى من:
//   - مساري الإرسال الخلفيين (send-whatsapp / mcp) عبر fetch
//     المباشر بمفتاح الخدمة،
//   - تطبيق المتصفح (whatsapp-mad3oom) عبر
//     supabase.functions.invoke('fx-rate').
//
// ترتيب المصادر:
//   1. ذاكرة fx_rates: آخر سعر مخزَّن إن كان عمره أقل من ساعة.
//   2. البنك المركزي المصري — الجدول الرسمي "Average Market Rate"
//      (https://www.cbe.org.eg/en/economic-research/statistics/exchange-rates):
//      صف US Dollar (شراء/بيع)، والسعر هو متوسطهما. الصفحة بلا
//      JSON رسمي، فيُقرأ نصها ويُحلَّل بأسلوب دفاعي (أي فشل في
//      التحليل يسقط للمصدر التالي، لا يرمي خطأً).
//   3. Frankfurter (مرجع البنك المركزي الأوروبي، JSON بلا مفتاح):
//      GET https://api.frankfurter.dev/v2/rate/usd/egp
//      (رُوجع حيًا في 2026-11-23: {"rate": 53.999, "date": "2026-11-23"}).
//   4. آخر سعر مخزَّن مهما كان عمره (cached: true).
//   5. إن لم يوجد أي سعر: 503 { error: "fx_unavailable" }.
//
// كل سعر حي ناجح يُحفظ في fx_rates قبل إرجاعه. فشل الحفظ لا يُفشل
// الرد: السعر نفسه صحيح، والتخزين تحسين فقط.
//
// البيانات مرجعية عامة — لا فحص مستخدم هنا (بوابة Supabase نفسها
// تتحقق من الـ JWT عند functions.invoke، والنداء بمفتاح الخدمة
// يمرّ من مسار الخادم).
// ============================================================
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const CBE_RATES_URL = "https://www.cbe.org.eg/en/economic-research/statistics/exchange-rates";
const FRANKFURTER_URL = "https://api.frankfurter.dev/v2/rate/usd/egp";
const FETCH_TIMEOUT_MS = 20000;
const CACHE_TTL_MS = 60 * 60 * 1000; // ساعة واحدة

const round4 = (n: number) => Math.round(n * 10000) / 10000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

// يحلّل صف الدولار من نص صفحة البنك المركزي: "US Dollar 54.2883 54.3883"
// (شراء ثم بيع). يرجع null عند أي شك — والمنادي يسقط للبديل.
function parseCbeUsd(text: string): { buy: number; sell: number; rateDate: string | null } | null {
  const plain = stripTags(text);
  const m = plain.match(/U\.?\s*S\.?\s*Dollar\s+([\d,]+\.?\d*)\s+([\d,]+\.?\d*)/i)
    || plain.match(/دولار أمريكي\s+([\d,]+\.?\d*)\s+([\d,]+\.?\d*)/);
  if (!m) return null;
  const buy = Number(m[1].replace(/,/g, ""));
  const sell = Number(m[2].replace(/,/g, ""));
  if (!Number.isFinite(buy) || !Number.isFinite(sell)) return null;
  if (buy < 10 || buy > 200 || sell < 10 || sell > 200) return null;
  if (sell < buy) return null;
  const dateMatch = plain.match(/Average Market Rate in EGP\s+(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})/i);
  let rateDate: string | null = null;
  if (dateMatch) {
    const parsed = new Date(dateMatch[1]);
    if (!Number.isNaN(parsed.getTime())) rateDate = parsed.toISOString().slice(0, 10);
  }
  return { buy: round4(buy), sell: round4(sell), rateDate };
}

async function fetchCbe(): Promise<{ buy: number; sell: number; rateDate: string } | null> {
  try {
    const res = await fetchWithTimeout(CBE_RATES_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36", Accept: "text/html" },
    });
    if (!res.ok) {
      console.warn("[fx-rate] CBE HTTP", res.status);
      return null;
    }
    const parsed = parseCbeUsd(await res.text());
    if (!parsed) {
      console.warn("[fx-rate] CBE page parsed no USD row");
      return null;
    }
    return { ...parsed, rateDate: parsed.rateDate ?? new Date().toISOString().slice(0, 10) };
  } catch (err) {
    console.warn("[fx-rate] CBE fetch failed:", (err as Error).message);
    return null;
  }
}

async function fetchFrankfurter(): Promise<{ rate: number; rateDate: string } | null> {
  try {
    const res = await fetchWithTimeout(FRANKFURTER_URL, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      console.warn("[fx-rate] Frankfurter HTTP", res.status);
      return null;
    }
    const data = await res.json() as { rate?: unknown; date?: unknown };
    const rate = Number(data.rate);
    if (!Number.isFinite(rate) || rate < 10 || rate > 200) return null;
    const rateDate = typeof data.date === "string" ? data.date : new Date().toISOString().slice(0, 10);
    return { rate: round4(rate), rateDate };
  } catch (err) {
    console.warn("[fx-rate] Frankfurter fetch failed:", (err as Error).message);
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const readLatest = async () => {
    const { data, error } = await admin
      .from("fx_rates")
      .select("rate, buy, sell, source, rate_date, as_of")
      .eq("base", "USD")
      .eq("quote", "EGP")
      .order("as_of", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.warn("[fx-rate] fx_rates read failed:", error.message);
      return null;
    }
    return data;
  };

  const store = async (row: { rate: number; buy: number | null; sell: number | null; source: string; rate_date: string }) => {
    const { error } = await admin.from("fx_rates").insert({
      base: "USD",
      quote: "EGP",
      rate: row.rate,
      buy: row.buy,
      sell: row.sell,
      source: row.source,
      rate_date: row.rate_date,
    });
    if (error) console.warn("[fx-rate] fx_rates insert failed (rate still returned):", error.message);
  };

  const toResponse = (row: { rate: number; buy: number | null; sell: number | null; source: string; rate_date: string; as_of: string }, cached: boolean) => ({
    usd_egp: row.rate,
    buy: row.buy,
    sell: row.sell,
    source: row.source,
    rate_date: row.rate_date,
    as_of: row.as_of,
    cached,
  });

  try {
    // 1) ذاكرة الساعة.
    const latest = await readLatest();
    if (latest && Date.now() - new Date(latest.as_of).getTime() < CACHE_TTL_MS) {
      return json(toResponse(latest as never, true));
    }

    // 2) البنك المركزي المصري.
    const cbe = await fetchCbe();
    if (cbe) {
      const rate = round4((cbe.buy + cbe.sell) / 2);
      const row = { rate, buy: cbe.buy, sell: cbe.sell, source: "cbe", rate_date: cbe.rateDate };
      await store(row);
      return json(toResponse({ ...row, as_of: new Date().toISOString() }, false));
    }

    // 3) Frankfurter (مرجع ECB).
    const frank = await fetchFrankfurter();
    if (frank) {
      const row = { rate: frank.rate, buy: frank.rate, sell: frank.rate, source: "frankfurter", rate_date: frank.rateDate };
      await store(row);
      return json(toResponse({ ...row, as_of: new Date().toISOString() }, false));
    }

    // 4) آخر سعر مخزَّن مهما كان عمره.
    if (latest) {
      console.warn("[fx-rate] live sources failed, returning stale cached rate");
      return json(toResponse(latest as never, true));
    }

    // 5) لا شيء إطلاقًا.
    return json({ error: "fx_unavailable" }, 503);
  } catch (err) {
    console.error("[fx-rate] unexpected error:", (err as Error).message);
    const latest = await readLatest();
    if (latest) return json(toResponse(latest as never, true));
    return json({ error: "fx_unavailable" }, 503);
  }
});
