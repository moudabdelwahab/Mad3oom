import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, accept",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// كلمة مرور مؤقتة قوية: حروف كبيرة/صغيرة وأرقام ورموز، بدون أحرف ملتبسة.
function generateTempPassword(length = 16): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#%*?";
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // ── التحقق من أن المُنادي أدمن ──
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) return json({ error: "Unauthorized" }, 401);

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: callerProfile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", userData.user.id)
    .maybeSingle();

  // is_admin() = أدمن أو مالك المنصة بقدرة الإدارة — نفس مُسنَد RLS على القائمة.
  const { data: callerIsAdmin } = await userClient.rpc("is_admin");

  if (callerProfile?.role !== "admin" && callerIsAdmin !== true) {
    return json({ error: "هذه الميزة مقصورة على فريق الإدارة" }, 403);
  }

  // ── قراءة الطلب ──
  let entryId: string | undefined;
  try {
    ({ entry_id: entryId } = await req.json());
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!entryId) return json({ error: "entry_id مطلوب" }, 400);

  const { data: entry, error: entryError } = await admin
    .from("waitlist_entries")
    .select("id, name, email, phone, status, approved_user_id, source")
    .eq("id", entryId)
    .maybeSingle();

  if (entryError) return json({ error: entryError.message }, 500);
  if (!entry) return json({ error: "الطلب غير موجود" }, 404);

  // موافقة سابقة أنتجت حسابًا بالفعل: لا نعيد إنشاءه ولا نغيّر كلمة مروره.
  if (entry.status === "approved" && entry.approved_user_id) {
    return json({
      user_id: entry.approved_user_id,
      email: entry.email,
      created: false,
      already_approved: true,
    });
  }

  const email = String(entry.email).trim().toLowerCase();

  // ── طلب مربوط بحساب قائم (سجّل عبر Google/GitHub أو أُضيف تلقائيًا) ──
  // الحساب موجود ويدخل بطريقته المعتادة: نختم الموافقة فقط، بلا حساب جديد
  // ولا كلمة مرور ولا تعديل لبياناته. قبل ذلك كان هذا الطلب يُعامَل كأنه
  // «متوافق عليه» فيرجع دون تغيير حالته، فيبقى صاحبه محجوبًا للأبد.
  if (entry.approved_user_id) {
    const { data: linkedProfile } = await admin
      .from("profiles")
      .select("id, full_name")
      .eq("id", entry.approved_user_id)
      .maybeSingle();

    if (linkedProfile) {
      if (!linkedProfile.full_name && entry.name) {
        await admin.from("profiles").update({ full_name: entry.name }).eq("id", linkedProfile.id);
      }

      const { error: approveError } = await admin
        .from("waitlist_entries")
        .update({
          status: "approved",
          reviewed_at: new Date().toISOString(),
          reviewed_by: userData.user.id,
        })
        .eq("id", entry.id);

      if (approveError) return json({ error: approveError.message }, 500);

      return json({
        user_id: linkedProfile.id,
        email,
        created: false,
        already_approved: false,
        linked_existing: true,
        source: entry.source ?? null,
        temp_password: null,
      });
    }
    // الحساب المربوط حُذف: نكمل كطلب عادي وننشئ حسابًا.
  }

  const tempPassword = generateTempPassword();

  // ── إنشاء الحساب مؤكَّدًا بدون إرسال بريد تحقق ──
  let userId: string | null = null;
  let created = false;
  let tempPasswordIssued = false;

  const { data: createdUser, error: createError } = await admin.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
    user_metadata: {
      full_name: entry.name,
      phone: entry.phone ?? null,
      source: "waitlist",
    },
  });

  if (createdUser?.user) {
    userId = createdUser.user.id;
    created = true;
    tempPasswordIssued = true;
  } else {
    // البريد مسجَّل بالفعل: نربط الطلب بالحساب القائم بدل إنشاء حساب مكرر،
    // ولا نلمس كلمة مروره.
    const message = createError?.message ?? "";
    const alreadyExists =
      /already/i.test(message) || /registered/i.test(message) || /exists/i.test(message);

    if (!alreadyExists) {
      return json({ error: message || "تعذر إنشاء الحساب" }, 500);
    }

    const { data: existingProfile } = await admin
      .from("profiles")
      .select("id")
      .ilike("email", email)
      .maybeSingle();

    if (!existingProfile) {
      return json(
        { error: "البريد مسجَّل مسبقًا في نظام الحسابات ولم يتم العثور على ملفه الشخصي" },
        409,
      );
    }
    userId = existingProfile.id;
  }

  // ── استكمال بيانات الملف الشخصي ──
  // تريجر handle_new_user ينشئ الصف لكنه لا يملأ full_name، والاسم في
  // قائمة الانتظار حقل واحد وليس first/last.
  const { error: profileError } = await admin
    .from("profiles")
    .update({
      full_name: entry.name,
      email,
      ...(entry.phone ? { phone: entry.phone } : {}),
    })
    .eq("id", userId);

  if (profileError) console.error("profile update failed:", profileError.message);

  // ── ختم الطلب بالموافقة ──
  const { error: updateError } = await admin
    .from("waitlist_entries")
    .update({
      status: "approved",
      reviewed_at: new Date().toISOString(),
      reviewed_by: userData.user.id,
      approved_user_id: userId,
    })
    .eq("id", entry.id);

  if (updateError) return json({ error: updateError.message }, 500);

  return json({
    user_id: userId,
    email,
    created,
    already_approved: false,
    // تُعرض للأدمن مرة واحدة فقط ولا تُخزَّن في أي مكان.
    temp_password: tempPasswordIssued ? tempPassword : null,
  });
});
