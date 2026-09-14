// create-sub-user — إنشاء مستخدم تابع لشركة (company_user).
//
// ════════════════════════════════════════════════════════════════════════════
// الخلل الأمني الذي يصلحه هذا الإصدار
// ════════════════════════════════════════════════════════════════════════════
// الإصدار السابق كان يفوّض على **الرتبة وحدها**:
//
//     const isSuperUser = currentProfile.role === "super_user";
//     if (!isAdmin && !isSuperUser) return 403;
//
// وثلاث فجوات تتبع ذلك:
//   ① لا فحص للعلاقة بالشركة — حامل الرتبة بلا شركة كان يُنشئ «تابعًا» له،
//      فينتج عضو بلا شركة، ودور معلّق في الفراغ.
//   ② لا فحص للاستحقاق — شركة بلا ميزة sub_users كانت تُنشئ أعضاء بنداء
//      مباشر للدالة، متخطّيةً بوابة الواجهة تمامًا.
//   ③ الرتبة نفسها كانت تُمنَح آليًا لكل من يشتري باقة دعم، فالتفويض كان
//      فعليًا «من اشترى باقة» لا «من يملك شركة».
//
// الإصلاح: التفويض يُسأل عنه **القاعدة** بهوية المنادي نفسه، لا يُعاد بناؤه
// هنا. can_manage_company_members() (الترحيل 035) تتحقق في نداء واحد ذرّي من:
//     الدور company_admin  ∧  ملكية صف في companies  ∧  استحقاق sub_users فعّال
// وتُنفَّذ بجلسة المنادي (anon key + Authorization)، فلا سبيل لتزوير أي طرف.
//
// ملاحظة أمنية مقصودة (محفوظة من الإصدار السابق)
//   super_user_id لا يُقرأ من جسم الطلب ولا من user_metadata إطلاقًا. الميتاداتا
//   يتحكم فيها المستخدم وقت التسجيل، ولو قُرئ منها العمود لأمكن تزوير تبعية
//   الحساب. القيمة تُشتق من هوية المنادي المتحقَّق منها وحدها.
//
// الدور: لا نكتبه هنا. محفّز sync_company_role في الترحيل 035 يشتقّه من
// العلاقة فور كتابة super_user_id — فمصدر واحد للحقيقة بدل اثنين قد يفترقا.

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

/** نفس قاعدة المنصة في auth-validation.validatePassword و company-model.js */
function passwordProblem(password: string): string | null {
  if (password.length < 8) return "كلمة المرور يجب أن تكون 8 أحرف على الأقل";
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    return "كلمة المرور يجب أن تحتوي على حرف كبير وحرف صغير ورقم";
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing authorization header" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

    // عميل بهوية المنادي — كل فحص تفويض يمرّ من خلاله، لا من خلال service role.
    const supabaseUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user: currentUser }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !currentUser) return json({ error: "Unauthorized" }, 401);

    // ── التفويض: تُقرَّره القاعدة، لا هذه الدالة ───────────────────────────
    //
    // نداء واحد ذرّي يجمع الدور والعلاقة والاستحقاق. أي محاولة لإعادة بناء
    // الشروط هنا كانت ستصير نسخة ثانية قد تنحرف عن القاعدة.
    const { data: canManage, error: permError } = await supabaseUser
      .rpc("can_manage_company_members");

    if (permError) {
      console.error("permission check failed:", permError.message);
      return json({ error: "تعذّر التحقق من صلاحيتك الآن. حاول مرة أخرى." }, 503);
    }

    if (canManage !== true) {
      // رسالة واحدة لكل أسباب الرفض عمدًا: التمييز بين «لست مديرًا» و«لا
      // استحقاق» يكشف حالة حساب الشركة لمن لا يملكه.
      return json({
        error:
          "إضافة المستخدمين متاحة لمدير الشركة ضمن اشتراك يشمل المستخدمين الفرعيين.",
      }, 403);
    }

    // ── نطاق الشركة يُشتق من الخادم ────────────────────────────────────────
    const { data: companyId, error: companyError } = await supabaseUser
      .rpc("current_company_id");

    if (companyError || !companyId) {
      return json({ error: "حسابك غير مرتبط بشركة." }, 403);
    }

    // ── المدخلات ───────────────────────────────────────────────────────────
    let body: { email?: string; password?: string; full_name?: string };
    try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const fullName = String(body.full_name || "").trim();

    if (!email || !password || !fullName) {
      return json({ error: "Missing required fields: email, password, full_name" }, 400);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: "بريد إلكتروني غير صالح" }, 400);
    }
    if (fullName.length < 2 || fullName.length > 120) {
      return json({ error: "اسم المستخدم غير صالح" }, 400);
    }
    const pwProblem = passwordProblem(password);
    if (pwProblem) return json({ error: pwProblem }, 400);

    // أي معرّف هوية في الجسم يُتجاهَل صراحةً — لا يُقرأ ولا يُمرَّر.
    // التبعية من هوية المنادي المتحقَّق منها وحدها.
    const superUserId = currentUser.id;

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });

    if (createError || !newUser?.user) {
      return json({ error: createError?.message || "Failed to create user" }, 400);
    }

    // صف البروفايل أنشأه handle_new_user() عبر trigger على auth.users، فنكمّله
    // بـUPDATE بدل محاولة إنشائه (وهو ما كان يفشل دائمًا قبل الإصلاح السابق).
    //
    // role لا يُكتب هنا: محفّز sync_company_role يشتقّه من super_user_id.
    const { data: updatedRows, error: profileUpdateError } = await supabaseAdmin
      .from("profiles")
      .update({
        email,
        full_name: fullName,
        username: email.split("@")[0],
        super_user_id: superUserId,
        is_verified: true,
      })
      .eq("id", newUser.user.id)
      .select("id, role, super_user_id");

    if (profileUpdateError || !updatedRows || updatedRows.length === 0) {
      // تراجع: نشيل المستخدم عشان ما يفضلش حساب بلا بروفايل مكتمل
      await supabaseAdmin.auth.admin.deleteUser(newUser.user.id);
      return json({
        error: "Failed to complete profile: " +
          (profileUpdateError?.message || "profile row not found for the new user"),
      }, 400);
    }

    const created = updatedRows[0];

    // تحقّق أخير: الدور المشتقّ لا بد أن يكون company_user. لو لم يكن، فالمحفّز
    // غائب (لم يُطبَّق الترحيل 035) — والحساب حينها عضو بلا دور، فنتراجع بدل
    // أن نترك حالة نصف مكتملة.
    if (created.role !== "company_user") {
      await supabaseAdmin.auth.admin.deleteUser(newUser.user.id);
      return json({
        error: "تعذّر إسناد دور المستخدم داخل الشركة. راجع الدعم الفني.",
      }, 500);
    }

    return json({
      success: true,
      message: "User created successfully",
      user: {
        id: newUser.user.id,
        email: newUser.user.email,
        full_name: fullName,
        role: created.role,
      },
    });
  } catch (error) {
    console.error("Error:", error);
    return json({ error: (error as Error).message || "Internal server error" }, 500);
  }
});
