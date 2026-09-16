import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
// نسخة مطابقة بايتيًا لنسخة oauth-authorize-approve — قاعدة التضييق واحدة
// في المنح وفي التعديل، ويحرس تطابقهما اختبار.
import { decideGrantedScopes, isPrivileged } from "./_shared/scope-grant.js";

// ============================================================
// oauth-connected-apps — إدارة التطبيقات الخارجية المتصلة بمدعوم
// ------------------------------------------------------------
// الاتجاه هنا **معاكس** لبقية دوال MCP في اللوحة: تلك تصف مدعوم وهو
// عميل يتصل بخوادم خارجية؛ هذه تصف مدعوم وهو **خادم** تتصل به تطبيقات
// خارجية (Claude، ChatGPT، أي عميل MCP) عبر OAuth.
//
// الربط بين التوكن والتطبيق ليس في api_tokens — لا عمود client_id فيه
// إطلاقًا. الجسر هو oauth_refresh_tokens الذي يحمل client_id و
// api_token_id معًا، فكل استعلام هنا يمرّ به.
//
// كل عملية تتحقق من الملكية أولًا: لا يلمس أحد توكنًا ليس له، ولو كان
// أدمن. النطاق هو «تطبيقاتي المتصلة» لا «تطبيقات المنصّة».
// ============================================================

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}

/** أقصى مدى لتاريخ انتهاء مخصَّص — سنتان، نفس حدّ نموذج مفاتيح API. */
const MAX_EXPIRY_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/**
 * الحقول الآمنة للإرجاع للمتصفح. قائمة بيضاء صريحة لا `select("*")`:
 * الجدول يحمل secret_hash و bearer_token_hash، ولا يخرج أيٌّ منهما أبدًا.
 */
const TOKEN_FIELDS = "id, user_id, name, scopes, is_active, revoked_at, expires_at, created_at, last_used_at, last_used_ip, usage_count, credential_type";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Unauthorized" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) return json({ error: "Unauthorized" }, 401);
  const userId = userData.user.id;

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const action = body?.action || "list";

  const admin = createClient(supabaseUrl, serviceRoleKey);

  /**
   * يجلب الاتصال الحيّ ويتحقق أنه لهذا المستخدم.
   * كل عملية تعديل تمرّ من هنا — نقطة تحقّق واحدة لا مكرّرة.
   */
  async function loadOwnedConnection(apiTokenId: unknown) {
    if (typeof apiTokenId !== "string" || !apiTokenId) {
      return { err: json({ error: "api_token_id مطلوب" }, 400) };
    }

    const { data: token } = await admin
      .from("api_tokens").select(TOKEN_FIELDS).eq("id", apiTokenId).maybeSingle();

    if (!token) return { err: json({ error: "التوكن غير موجود" }, 404) };
    // الملكية تُفحص على الصفّ المقروء، لا على ما أرسله المتصفح.
    if (token.user_id !== userId) return { err: json({ error: "لا تملك صلاحية إدارة هذا الاتصال" }, 403) };

    const { data: refreshRows } = await admin
      .from("oauth_refresh_tokens")
      .select("id, client_id, scope, expires_at, revoked_at, created_at")
      .eq("api_token_id", apiTokenId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    return { token, refreshRows: refreshRows || [] };
  }

  // ── list ────────────────────────────────────────────────────────────
  if (action === "list") {
    const { data: refreshRows } = await admin
      .from("oauth_refresh_tokens")
      .select("id, client_id, api_token_id, scope, expires_at, revoked_at, created_at")
      .eq("user_id", userId)
      .is("revoked_at", null)
      .order("created_at", { ascending: false });

    const rows = refreshRows || [];
    if (!rows.length) return json({ apps: [] });

    const tokenIds = [...new Set(rows.map((r: any) => r.api_token_id))];
    const clientIds = [...new Set(rows.map((r: any) => r.client_id))];

    const [{ data: tokens }, { data: clients }] = await Promise.all([
      admin.from("api_tokens").select(TOKEN_FIELDS).in("id", tokenIds),
      admin.from("oauth_clients").select("client_id, client_name, redirect_uris, created_at, is_active").in("client_id", clientIds),
    ]);

    const tokenById = new Map((tokens || []).map((t: any) => [t.id, t]));
    const clientById = new Map((clients || []).map((c: any) => [c.client_id, c]));

    const now = Date.now();
    const apps = [];
    const seenToken = new Set<string>();

    for (const r of rows) {
      // التجديد يُلغي الصفّ القديم ويُنشئ جديدًا، فالصفوف غير المُلغاة هي
      // الاتصالات الحيّة. نتجاهل أي تكرار على نفس التوكن احتياطًا.
      if (seenToken.has(r.api_token_id)) continue;
      seenToken.add(r.api_token_id);

      const t: any = tokenById.get(r.api_token_id);
      if (!t) continue;
      if (!t.is_active || t.revoked_at) continue;

      const client: any = clientById.get(r.client_id);
      const scopes: string[] = Array.isArray(t.scopes) ? t.scopes : [];
      const tokenExpired = t.expires_at ? new Date(t.expires_at).getTime() < now : false;

      apps.push({
        api_token_id: t.id,
        client_id: r.client_id,
        client_name: client?.client_name || "تطبيق غير معروف",
        redirect_uris: Array.isArray(client?.redirect_uris) ? client.redirect_uris : [],
        client_active: client?.is_active !== false,
        connected_at: r.created_at,
        scopes,
        privileged_scopes: scopes.filter((s) => isPrivileged(s)),
        // انتهاء التوكن قصير (ساعة) ويتجدّد تلقائيًا؛ انتهاء التجديد هو
        // العمر الحقيقي للاتصال، فيُعرضان منفصلَين لا مدموجَين.
        access_expires_at: t.expires_at,
        access_expired: tokenExpired,
        session_expires_at: r.expires_at,
        last_used_at: t.last_used_at,
        last_used_ip: t.last_used_ip,
        usage_count: t.usage_count ?? 0,
      });
    }

    return json({ apps });
  }

  // ── update_scopes: التضييق فقط ──────────────────────────────────────
  if (action === "update_scopes") {
    const loaded = await loadOwnedConnection(body?.api_token_id);
    if ("err" in loaded) return loaded.err;
    const { token, refreshRows } = loaded;

    const current: string[] = Array.isArray(token.scopes) ? token.scopes : [];
    // نفس قاعدة شاشة الموافقة: المصدر هو ما يملكه التوكن الآن، والمُرسَل
    // مُرشِّح عليه. فلا يستطيع أحد إضافة صلاحية لم تكن ممنوحة أصلًا.
    const decision = decideGrantedScopes(current, body?.scopes);
    if (!decision.ok) return json({ error: decision.error, reason: decision.reason }, 400);

    const next = decision.scopes;

    const { error: tokErr } = await admin
      .from("api_tokens").update({ scopes: next }).eq("id", token.id).eq("user_id", userId);
    if (tokErr) return json({ error: "تعذّر حفظ الصلاحيات: " + tokErr.message }, 500);

    // ⚠️ حاسم: oauth-token يشتقّ صلاحيات التوكن الجديد عند التجديد من
    // oauth_refresh_tokens.scope لا من api_tokens.scopes. فتحديث الأول
    // وحده كان سيُلغى تلقائيًا عند أول تجديد (خلال ساعة).
    // والعمود jsonb يحمل **نصًّا** مفصولًا بمسافات لا مصفوفة — وهذا ما
    // يقرؤه ذلك الكود بـ.split(" ").
    const live = refreshRows.filter((r: any) => !r.revoked_at);
    for (const r of live) {
      await admin.from("oauth_refresh_tokens").update({ scope: next.join(" ") }).eq("id", r.id);
    }

    return json({ success: true, scopes: next, removed: current.filter((s) => !next.includes(s)) });
  }

  // ── set_expiry ──────────────────────────────────────────────────────
  if (action === "set_expiry") {
    const loaded = await loadOwnedConnection(body?.api_token_id);
    if ("err" in loaded) return loaded.err;
    const { token, refreshRows } = loaded;

    const raw = body?.expires_at;
    let expiresAt: string | null = null;

    if (raw !== null && raw !== undefined && raw !== "") {
      const t = new Date(raw).getTime();
      if (!Number.isFinite(t)) return json({ error: "تاريخ غير صالح" }, 400);
      if (t <= Date.now()) {
        return json({ error: "التاريخ يجب أن يكون في المستقبل - لإنهاء الاتصال الآن استخدم «فصل»" }, 400);
      }
      if (t - Date.now() > MAX_EXPIRY_MS) return json({ error: "أقصى مدة مسموحة سنتان" }, 400);
      expiresAt = new Date(t).toISOString();
    }

    // التوكن نفسه قصير العمر ويتجدّد، فضبط انتهاء الاتصال يعني ضبط انتهاء
    // صفّ التجديد: هو ما يحكم متى يتوقف التطبيق عن القدرة على الاستمرار.
    const live = refreshRows.filter((r: any) => !r.revoked_at);
    if (!live.length) return json({ error: "لا يوجد اتصال حيّ لهذا التوكن" }, 404);

    if (expiresAt === null) {
      return json({ error: "الاتصال لا بد له من تاريخ انتهاء - اختر مدة" }, 400);
    }

    for (const r of live) {
      const { error } = await admin.from("oauth_refresh_tokens").update({ expires_at: expiresAt }).eq("id", r.id);
      if (error) return json({ error: "تعذّر ضبط المدة: " + error.message }, 500);
    }

    // لو كان انتهاء التوكن القصير أبعد من انتهاء الاتصال، نقصّه إليه حتى
    // لا يبقى وصول صالح بعد انتهاء المدة التي اختارها المستخدم.
    if (token.expires_at && new Date(token.expires_at).getTime() > new Date(expiresAt).getTime()) {
      await admin.from("api_tokens").update({ expires_at: expiresAt }).eq("id", token.id).eq("user_id", userId);
    }

    return json({ success: true, session_expires_at: expiresAt });
  }

  // ── revoke ──────────────────────────────────────────────────────────
  if (action === "revoke") {
    const loaded = await loadOwnedConnection(body?.api_token_id);
    if ("err" in loaded) return loaded.err;
    const { token, refreshRows } = loaded;

    const nowIso = new Date().toISOString();

    // ⚠️ الترتيب مقصود: تُلغى صفوف التجديد أولًا. إلغاء التوكن وحده ليس
    // فصلًا — refresh token حيّ يستطيع أن يسكّ توكنًا جديدًا فورًا
    // (oauth-token يفحص revoked_at على صفّ التجديد، وهذا ما يوقفه).
    for (const r of refreshRows) {
      if (r.revoked_at) continue;
      await admin.from("oauth_refresh_tokens").update({ revoked_at: nowIso }).eq("id", r.id);
    }

    const { error } = await admin
      .from("api_tokens")
      .update({ is_active: false, revoked_at: nowIso })
      .eq("id", token.id).eq("user_id", userId);
    if (error) return json({ error: "تعذّر الفصل: " + error.message }, 500);

    return json({ success: true });
  }

  return json({ error: `إجراء غير معروف: ${action}` }, 400);
});
