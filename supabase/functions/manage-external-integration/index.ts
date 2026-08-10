import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================
// manage-external-integration
// ------------------------------------------------------------
// إنشاء/تعديل/حذف ربط خارجي. المفاتيح الحقيقية تُشفّر (AES-GCM) هنا فقط
// قبل الحفظ، ولا تُقرأ أو تُرجع للواجهة أبداً. التحقق من الصلاحيات
// يتم يدوياً هنا (بالإضافة لـ RLS) لأن الكتابة تتم بـ service_role لتشفير
// البيانات قبل التخزين.
//
// [تحديث] قائمة المزوّدين لم تعد ثابتة في الكود:
//   VALID_PROVIDERS كانت مصفوفة جامدة، وأصبحت تُقرأ من ai_provider_catalog.
//   إضافة مزوّد جديد (AgentRouter، DeepSeek، أي شيء لاحقاً) = صف في الكتالوج،
//   بدون إعادة نشر هذه الدالة. المصفوفة القديمة باقية كـ fallback فقط لو
//   تعذّرت قراءة الكتالوج لأي سبب، حتى لا ينكسر أي شيء يعمل اليوم.
//
// [تحديث] حقول جديدة مدعومة: protocol و base_url (يُتحقق من البروتوكول
//   مقابل البروتوكولات المعلنة للمزوّد في الكتالوج)، بالإضافة لتقنيع المفتاح
//   (key_prefix + key_last_four) ليُعرض في الواجهة كـ sk-••••••••8F92 دون
//   الحاجة لقراءة المفتاح نفسه مرة أخرى.
//
// ملاحظة مهمة (توافق مع النظام القديم):
// دالة Postgres send_telegram_message() المستخدمة في تنبيهات SLA/التذاكر
// العاجلة بتقرأ التوكن من public.api_keys.telegram_token كـ نص صريح، لأنها
// تعمل داخل قاعدة البيانات ومش قادرة تفك تشفير AES-GCM. عشان كده، أي ربط
// telegram_bot بنطاق platform هنا بيتعمله "mirror" تلقائي في
// api_keys.telegram_token.
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

/** يُستخدم فقط لو تعذّرت قراءة ai_provider_catalog — يحافظ على سلوك ما قبل الكتالوج. */
const FALLBACK_PROVIDERS = ["openai", "claude", "gemini", "openrouter", "groq", "telegram_bot", "webhook", "custom"];

const RETURN_COLUMNS =
  "id, provider, display_name, owner_id, owner_scope, is_active, priority, protocol, base_url, credentials_meta, capabilities_override, last_tested_at, last_test_status, created_at";

interface CatalogEntry {
  id: string;
  protocols: string[];
  allows_base_url: boolean;
  requires_base_url: boolean;
}

/** كتالوج المزوّدين المفعّلين. الرجوع لـ null يعني "اقرأ من القائمة الاحتياطية". */
async function loadCatalog(adminClient: any): Promise<Map<string, CatalogEntry> | null> {
  try {
    const { data, error } = await adminClient
      .from("ai_provider_catalog")
      .select("id, protocols, allows_base_url, requires_base_url")
      .eq("is_enabled", true);
    if (error || !data?.length) return null;
    return new Map(data.map((r: any) => [r.id, r as CatalogEntry]));
  } catch {
    return null;
  }
}

async function getAesKey(): Promise<CryptoKey> {
  const secret = Deno.env.get("INTEGRATIONS_ENC_KEY");
  if (!secret) throw new Error("INTEGRATIONS_ENC_KEY is not configured");
  const keyMaterial = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", keyMaterial, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptJson(payload: unknown): Promise<string> {
  const key = await getAesKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  const combined = new Uint8Array(iv.length + cipherBuf.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipherBuf), iv.length);
  return btoa(String.fromCharCode(...combined));
}

/**
 * بصمة عرض للمفتاح فقط (بادئة + آخر 4 محارف) — تكفي لتمييز المفتاح في الواجهة
 * دون تخزين أو إرجاع أي جزء قابل للاستخدام منه.
 */
function buildKeyMask(credentials?: Record<string, unknown>): Record<string, string> | null {
  if (!credentials) return null;
  const candidate = ["api_key", "bot_token", "bearer_token", "token"]
    .map((k) => credentials[k])
    .find((v) => typeof v === "string" && v.length >= 8) as string | undefined;
  if (!candidate) return null;

  const prefixMatch = candidate.match(/^(sk-[a-z]*-?|gsk_|xai-|AIza)/i);
  return {
    key_prefix: prefixMatch ? prefixMatch[1] : candidate.slice(0, 3),
    key_last_four: candidate.slice(-4),
  };
}

// يزامن توكن بوت تيليجرام (نطاق platform فقط) مع الجدول القديم api_keys
async function mirrorTelegramToLegacyTable(
  adminClient: ReturnType<typeof createClient>,
  provider: string,
  ownerScope: string,
  isActive: boolean,
  credentials?: Record<string, unknown>
) {
  if (provider !== "telegram_bot" || ownerScope !== "platform") return;

  const token = isActive ? (credentials?.bot_token as string | undefined) : "";
  if (token === undefined) return;

  const { data: existingRow } = await adminClient.from("api_keys").select("id").limit(1).maybeSingle();
  if (existingRow) {
    await adminClient.from("api_keys").update({ telegram_token: token, updated_at: new Date().toISOString() }).eq("id", existingRow.id);
  } else {
    await adminClient.from("api_keys").insert({ telegram_token: token });
  }
}

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
    const callerId = userData.user.id;

    let body: {
      action?: "create" | "update" | "delete";
      id?: string;
      provider?: string;
      display_name?: string;
      owner_id?: string | null;
      owner_scope?: "platform" | "super_user" | "user";
      is_active?: boolean;
      priority?: number;
      protocol?: string | null;
      base_url?: string | null;
      credentials?: Record<string, unknown>;
      credentials_meta?: Record<string, unknown>;
      capabilities_override?: Record<string, unknown>;
    };
    try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

    const action = body.action;
    if (!action || !["create", "update", "delete"].includes(action)) {
      return jsonResponse({ error: "action لازم (create|update|delete)" }, 400);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const catalog = await loadCatalog(adminClient);

    const { data: isAdminData } = await userClient.rpc("is_admin");
    const isAdmin = !!isAdminData;

    if (action === "delete") {
      const id = (body.id || "").trim();
      if (!id) return jsonResponse({ error: "id مطلوب" }, 400);
      const { data: row } = await userClient.from("external_integrations").select("id, provider, owner_scope").eq("id", id).maybeSingle();
      if (!row) return jsonResponse({ error: "الربط الخارجي مش موجود أو ممنوع الوصول" }, 404);
      const { error: delError } = await adminClient.from("external_integrations").delete().eq("id", id);
      if (delError) return jsonResponse({ error: "فشل الحذف: " + delError.message }, 500);

      if (row.provider === "telegram_bot" && row.owner_scope === "platform") {
        await mirrorTelegramToLegacyTable(adminClient, "telegram_bot", "platform", false, { bot_token: "" });
      }
      return jsonResponse({ success: true });
    }

    const provider = (body.provider || "").trim();
    const displayName = (body.display_name || "").trim();

    if (action === "create") {
      const known = catalog ? catalog.has(provider) : FALLBACK_PROVIDERS.includes(provider);
      if (!known) {
        return jsonResponse({
          error: `المزوّد "${provider}" غير معرَّف في كتالوج المزوّدين. أضِفه للكتالوج أولاً.`,
        }, 400);
      }
      if (!displayName) return jsonResponse({ error: "display_name مطلوب" }, 400);
    }

    // البروتوكول لازم يكون من ضمن البروتوكولات المعلنة للمزوّد في الكتالوج
    let protocol: string | null | undefined = undefined;
    if ("protocol" in body) {
      const requested = (body.protocol || "").trim();
      if (!requested) {
        protocol = null; // إعادة للافتراضي (أول بروتوكول في الكتالوج)
      } else {
        const existingId = (body.id || "").trim();
        const providerId = provider || (existingId
          ? (await adminClient.from("external_integrations").select("provider").eq("id", existingId).maybeSingle()).data?.provider
          : "");
        const entry = catalog?.get(providerId || "");
        if (entry && !entry.protocols.includes(requested)) {
          return jsonResponse({
            error: `البروتوكول "${requested}" غير مدعوم للمزوّد "${providerId}". المدعوم: ${entry.protocols.join(", ")}`,
          }, 400);
        }
        protocol = requested;
      }
    }

    const baseUrl = "base_url" in body ? ((body.base_url || "").trim() || null) : undefined;

    let ownerId = body.owner_id ?? callerId;
    let ownerScope = body.owner_scope || "user";

    if (!isAdmin) {
      ownerScope = ownerScope === "platform" ? "user" : ownerScope;
      const { data: allowed } = await userClient.rpc("is_owner_or_super_of", { target_id: ownerId });
      if (!allowed) return jsonResponse({ error: "ليس لديك صلاحية لهذا المستخدم" }, 403);
    } else if (ownerScope === "platform") {
      ownerId = null;
    }

    const hasCredentials = !!(body.credentials && Object.keys(body.credentials).length);
    const encryptedPayload = hasCredentials ? await encryptJson(body.credentials) : undefined;

    // بصمة العرض تُدمج مع credentials_meta المرسلة (ولا تلغيها)
    const keyMask = buildKeyMask(body.credentials);
    const mergedMeta = (body.credentials_meta || keyMask)
      ? { ...(body.credentials_meta || {}), ...(keyMask || {}) }
      : undefined;

    const hasPriority = typeof body.priority === "number" && Number.isFinite(body.priority);

    if (action === "create") {
      const isActive = body.is_active ?? true;
      const insertRow: Record<string, unknown> = {
        owner_id: ownerId,
        owner_scope: ownerScope,
        provider,
        display_name: displayName,
        credentials_meta: mergedMeta || {},
        is_active: isActive,
      };
      if (encryptedPayload) insertRow.credentials_encrypted = encryptedPayload;
      if (hasPriority) insertRow.priority = Math.trunc(body.priority as number);
      if (protocol !== undefined) insertRow.protocol = protocol;
      if (baseUrl !== undefined) insertRow.base_url = baseUrl;
      if (body.capabilities_override) insertRow.capabilities_override = body.capabilities_override;

      const { data: inserted, error: insertError } = await adminClient
        .from("external_integrations")
        .insert(insertRow)
        .select(RETURN_COLUMNS)
        .single();

      if (insertError || !inserted) return jsonResponse({ error: "فشل الإنشاء: " + (insertError?.message || "") }, 500);

      await mirrorTelegramToLegacyTable(adminClient, provider, ownerScope, isActive, body.credentials);
      return jsonResponse({ integration: inserted });
    }

    // action === 'update'
    const id = (body.id || "").trim();
    if (!id) return jsonResponse({ error: "id مطلوب للتعديل" }, 400);

    const { data: existing } = await userClient.from("external_integrations").select("id, provider, owner_scope").eq("id", id).maybeSingle();
    if (!existing) return jsonResponse({ error: "الربط الخارجي مش موجود أو ممنوع الوصول" }, 404);

    const updateRow: Record<string, unknown> = {};
    if (displayName) updateRow.display_name = displayName;
    if (mergedMeta) updateRow.credentials_meta = mergedMeta;
    if (typeof body.is_active === "boolean") updateRow.is_active = body.is_active;
    if (hasPriority) updateRow.priority = Math.trunc(body.priority as number);
    if (protocol !== undefined) updateRow.protocol = protocol;
    if (baseUrl !== undefined) updateRow.base_url = baseUrl;
    if (body.capabilities_override) updateRow.capabilities_override = body.capabilities_override;
    if (encryptedPayload) updateRow.credentials_encrypted = encryptedPayload;

    if (!Object.keys(updateRow).length) return jsonResponse({ error: "لا يوجد ما يُحدَّث" }, 400);

    const { data: updated, error: updateError } = await adminClient
      .from("external_integrations")
      .update(updateRow)
      .eq("id", id)
      .select(RETURN_COLUMNS)
      .single();

    if (updateError || !updated) return jsonResponse({ error: "فشل التحديث: " + (updateError?.message || "") }, 500);

    const finalIsActive = typeof body.is_active === "boolean" ? body.is_active : (updated as any).is_active;
    await mirrorTelegramToLegacyTable(adminClient, existing.provider, existing.owner_scope, finalIsActive, body.credentials);

    return jsonResponse({ integration: updated });
  } catch (err) {
    console.error("Unexpected error:", err);
    return jsonResponse({ error: "حدث خطأ غير متوقع" }, 500);
  }
});
