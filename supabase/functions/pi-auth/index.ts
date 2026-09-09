import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * pi-auth — تبادل توكن Pi بجلسة على المنصة.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ما كان معطوبًا
 *
 *   النسخة السابقة كانت تشتق **كلمة المرور** من معرّف Pi اشتقاقًا حتميًّا،
 *   وتشتق البريد من نفس المعرّف، ثم تسجّل الدخول بـsignInWithPassword.
 *
 *   ومعرّف Pi ليس سرًّا: تراه كل تطبيقات Pi التي يأذن لها المستخدم. فمن عرفه
 *   ملك **الزوج كاملًا** (بريد + كلمة مرور)، وسجّل الدخول من **نقطة المصادقة
 *   العادية** — أي أن التحقق من Pi في هذه الدالة كان يُتخطّى بالكامل لأنه ليس
 *   على ذلك المسار أصلًا. استيلاء كامل على الحساب بمعرفة معرّف عام.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ما تغيّر
 *
 *   1. **لا كلمة مرور مشتقة، ولا كلمة مرور أصلًا.** حساب Pi يُنشأ بلا كلمة
 *      مرور صالحة، فمسار signInWithPassword مغلق له نهائيًّا — لا مضاف إليه
 *      مسار جديد بجانبه، بل **مقفول**. (migrations/031 يغلقه للحسابين القائمين.)
 *
 *   2. **الجلسة تُصدَر بـmagiclink + verifyOtp** — وهو النمط المطبَّق أصلًا في
 *      `aqar-auth` في هذا المشروع، فالإصلاح تبنٍّ لنمط قائم لا اختراع.
 *
 *   3. **الهوية تُقرأ من `auth.users.user_metadata.pi_uid`** لا من
 *      `profiles.pi_uid`. الأخير عمود في جدول يكتبه المستخدم، وقد ثبت أنه كان
 *      قابلًا للكتابة ⇒ حجز هوية Pi لشخص آخر (أُغلق في 027، لكن المصدر الصحيح
 *      للهوية هو ما تكتبه هذه الدالة بدور الخدمة لا ما يكتبه العميل).
 *
 *   4. **ترقيم صفحات في البحث بالبريد.** النسخة السابقة كانت تقرأ أول صفحة
 *      فقط (50 مستخدمًا افتراضًا) ثم تحاول الإنشاء ⇒ تعارض بعد نمو المنصة.
 *
 *   لا يُسجَّل توكن Pi ولا أي جزء من بيانات الاعتماد في أي سجل أو رد.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/** بريد اصطناعي ثابت للهوية. **معرّف لا اعتماد** — لا يمنح دخولًا وحده. */
function piEmailFor(piUid: string): string {
  return `pi_${piUid}@pi.network`;
}

/** يبحث عن مستخدم بالبريد عبر كل الصفحات، لا الأولى فقط. */
async function findUserByEmail(admin: any, email: string): Promise<any | null> {
  const perPage = 200;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`listUsers: ${error.message}`);
    const users = data?.users ?? [];
    const hit = users.find((u: any) => u.email?.toLowerCase() === email);
    if (hit) return hit;
    if (users.length < perPage) return null;
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let accessToken: string;
  try {
    const body = await req.json();
    accessToken = (body?.accessToken ?? "").trim();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!accessToken) return json({ error: "accessToken is required" }, 400);

  // ── 1) التحقق من التوكن لدى Pi — الحدّ الوحيد للهوية ──────────────────────
  let piUser: { uid: string; username?: string };
  try {
    const piRes = await fetch("https://api.minepi.com/v2/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!piRes.ok) {
      // لا نُعيد نص خطأ المزوّد للعميل: قد يحمل تفاصيل عن التوكن.
      console.error("[pi-auth] Pi API rejected the token:", piRes.status);
      return json({ error: "Pi token validation failed" }, 401);
    }
    piUser = await piRes.json();
  } catch (err) {
    console.error("[pi-auth] Pi API unreachable:", err instanceof Error ? err.message : err);
    return json({ error: "Could not reach Pi Network API" }, 502);
  }
  if (!piUser?.uid) return json({ error: "Pi API returned no UID" }, 401);

  const piUid = piUser.uid;
  const piUsername = piUser.username || `pi_${piUid.slice(0, 8)}`;
  const email = piEmailFor(piUid);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  try {
    // ── 2) الهوية من بيانات المستخدم التي يكتبها الخادم، لا من جدول العميل ──
    let authUser = await findUserByEmail(admin, email);

    if (!authUser) {
      // كلمة مرور عشوائية عالية الإنتروبيا **تُنسى فورًا**: لا تُشتق ولا تُخزَّن
      // ولا تُعاد. وجودها ضرورة تقنية للإنشاء فقط، ويُبطلها القسم 3 بعدها.
      const throwaway = crypto.randomUUID() + crypto.randomUUID();
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password: throwaway,
        email_confirm: true,
        user_metadata: { full_name: piUsername, pi_uid: piUid, source: "pi" },
      });
      if (createErr || !created?.user) {
        console.error("[pi-auth] createUser failed:", createErr?.message);
        return json({ error: "Failed to create user account" }, 500);
      }
      authUser = created.user;

      const { error: upsertErr } = await admin.from("profiles").upsert(
        { id: authUser.id, email, full_name: piUsername, role: "user", pi_uid: piUid },
        { onConflict: "id" },
      );
      if (upsertErr) {
        console.error("[pi-auth] profiles upsert failed:", upsertErr.message);
        return json({ error: "Failed to create user profile" }, 500);
      }
    }

    // ── 3) إغلاق مسار كلمة المرور نهائيًّا لكل حساب Pi ────────────────────
    //
    // يُنفَّذ عند **كل** تبادل ناجح، لا عند الإنشاء فقط: أي حساب قديم ما زال
    // يحمل كلمة المرور المشتقة يفقدها أول مرة يدخل بعد النشر. وmigrations/031
    // يغلق الحسابين القائمين فورًا دون انتظار دخولهما.
    const { error: lockErr } = await admin.auth.admin.updateUserById(authUser.id, {
      password: crypto.randomUUID() + crypto.randomUUID(),
      user_metadata: { ...(authUser.user_metadata ?? {}), pi_uid: piUid, source: "pi" },
    });
    if (lockErr) {
      // لا نُصدر جلسة إن لم نستطع إغلاق المسار القديم: الفشل هنا يعني أن
      // الزوج المشتق قد يكون ما زال صالحًا.
      console.error("[pi-auth] could not rotate credential:", lockErr.message);
      return json({ error: "Failed to secure the account" }, 500);
    }

    // ── 4) الجلسة عبر توكن لمرة واحدة (نمط aqar-auth) ─────────────────────
    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    if (linkErr || !link?.properties?.hashed_token) {
      console.error("[pi-auth] generateLink failed:", linkErr?.message);
      return json({ error: "Failed to create session" }, 500);
    }

    const { data: profileRow } = await admin
      .from("profiles").select("role").eq("id", authUser.id).single();

    // لا access_token ولا refresh_token هنا: العميل يبدّل token_hash بجلسة
    // عبر supabase.auth.verifyOtp({ type: 'magiclink' }).
    return json({
      token_hash: link.properties.hashed_token,
      email,
      user_id: authUser.id,
      role: profileRow?.role ?? "user",
    });
  } catch (err) {
    console.error("[pi-auth]", err instanceof Error ? err.message : err);
    return json({ error: "Internal server error" }, 500);
  }
});
