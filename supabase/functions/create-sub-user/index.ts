// create-sub-user — إنشاء مستخدم فرعي تابع لمسؤول شركة (super_user) أو لأدمن.
//
// الملف ده كان منشورًا على Supabase وغير موجود في المستودع أصلًا، فاتضاف هنا
// عشان يبقى تحت إدارة النسخ زي باقي الدوال.
//
// الخلل اللي اتصلح
//   الدالة كانت بتنادي auth.admin.createUser ثم تعمل INSERT في public.profiles
//   لنفس المعرّف. لكن على auth.users فيه trigger اسمه on_auth_user_created
//   بينفّذ handle_new_user() اللي بينشئ صف البروفايل تلقائيًا. فالـINSERT
//   الثاني كان بيصطدم بالمفتاح الأساسي، ومسار التراجع كان بيحذف المستخدم
//   المُنشأ — يعني إنشاء المستخدم الفرعي كان بيفشل دايمًا.
//   (الدليل في الإنتاج: صفر صفوف في profiles.super_user_id رغم وجود الميزة.)
//
//   الإصلاح: نكمّل الصف الموجود بـUPDATE بدل ما نحاول إنشاءه من جديد.
//   وعشان الـUPDATE ده يعدّي، لازم check_super_user_creation يسمح لمفتاح
//   الخدمة (auth.uid() فارغ) زي باقي الحرّاس في المشروع — ده اتعمل في
//   migrations/017.
//
// ملاحظة أمنية مقصودة
//   super_user_id مابيتبعتش في user_metadata. الميتاداتا دي بيتحكم فيها
//   المستخدم وقت التسجيل، ولو أي كود مستقبلي قرأ منها العمود ده هيبقى ممكن
//   تزوير تبعية الحساب (وبالتالي الوصول للوحة شركة غيرك). القيمة بتتحدد هنا
//   من هوية المنادي المتحقَّق منها فقط.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Missing authorization header" }, 401);
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const supabaseUser = createClient(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_ANON_KEY") || "",
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user: currentUser }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !currentUser) {
      return json({ error: "Unauthorized" }, 401);
    }

    const { data: currentProfile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("role")
      .eq("id", currentUser.id)
      .single();

    if (profileError || !currentProfile) {
      return json({ error: "Profile not found" }, 404);
    }

    const isAdmin = currentProfile.role === "admin" || currentProfile.role === "support";
    const isSuperUser = currentProfile.role === "super_user";

    if (!isAdmin && !isSuperUser) {
      return json({ error: "Insufficient permissions" }, 403);
    }

    const { email, password, full_name } = await req.json();
    if (!email || !password || !full_name) {
      return json({ error: "Missing required fields: email, password, full_name" }, 400);
    }

    // التبعية تُشتق من هوية المنادي، ولا تُقرأ من جسم الطلب أبدًا.
    const superUserId = isSuperUser ? currentUser.id : null;

    const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name },
    });

    if (createError || !newUser?.user) {
      return json({ error: createError?.message || "Failed to create user" }, 400);
    }

    // صف البروفايل أنشأه handle_new_user() بالفعل عبر trigger على auth.users،
    // فبنكمّله هنا بدل ما نحاول إنشاءه (وده كان سبب الفشل الدائم).
    const { data: updatedRows, error: profileUpdateError } = await supabaseAdmin
      .from("profiles")
      .update({
        email,
        full_name,
        username: email.split("@")[0],
        role: "customer",
        super_user_id: superUserId,
        is_verified: true,
      })
      .eq("id", newUser.user.id)
      .select("id");

    if (profileUpdateError || !updatedRows || updatedRows.length === 0) {
      // تراجع: نشيل المستخدم عشان مايفضلش حساب بلا بروفايل مكتمل
      await supabaseAdmin.auth.admin.deleteUser(newUser.user.id);
      return json(
        {
          error: "Failed to complete profile: " +
            (profileUpdateError?.message || "profile row not found for the new user"),
        },
        400,
      );
    }

    return json({
      success: true,
      message: "User created successfully",
      user: { id: newUser.user.id, email: newUser.user.email, full_name },
    });
  } catch (error) {
    console.error("Error:", error);
    return json({ error: (error as Error).message || "Internal server error" }, 500);
  }
});
