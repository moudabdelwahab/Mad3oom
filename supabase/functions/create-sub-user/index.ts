// create-sub-user — إنشاء حساب: مستقل (طاقم المنصة) أو عضو شركة (مدير الشركة).
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
// ولأن الترحيل 035 قاعد الرتبة super_user، صار شرط `role === "super_user"`
// لا يتحقق لأحد — فإضافة عضو الشركة مكسورة اليوم حتى يُنشَر هذا الإصدار.
//
// ════════════════════════════════════════════════════════════════════════════
// مساران مشروعان — والفرق بينهما جوهري
// ════════════════════════════════════════════════════════════════════════════
//   ① طاقم المنصة   → حساب **مستقل**: super_user_id = null، role = "customer".
//                     صلاحية إدارية قائمة منذ البداية، محفوظة هنا حرفيًا كما
//                     كانت. (لوحة الإدارة: my-users و super-users.)
//   ② مدير الشركة   → **عضو تابع** لشركته: super_user_id = هويته.
//
// أيّهما يسلك الطلبُ **تقرّره القاعدة لا هذه الدالة**: sub_user_create_context()
// (الترحيل 037) تعيد { allowed, actor, attach_to_company } في نداء واحد ذرّي
// يجمع الرتبة والعلاقة والاستحقاق. فلا يختار الطلب مساره، ولا يُعاد بناء أي
// شرط في TypeScript — إعادة بنائه كانت ستصنع نسخة ثانية تنحرف عن الأولى.
//
// ملاحظة أمنية مقصودة (محفوظة من الإصدار السابق)
//   super_user_id لا يُقرأ من جسم الطلب ولا من user_metadata إطلاقًا. الميتاداتا
//   يتحكم فيها المستخدم وقت التسجيل، ولو قُرئ منها العمود لأمكن تزوير تبعية
//   الحساب. القيمة تُشتق من هوية المنادي المتحقَّق منها وحدها.

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

    // ── التفويض: تُقرِّره القاعدة، لا هذه الدالة ───────────────────────────
    //
    // نداء واحد ذرّي يجمع الرتبة والعلاقة والاستحقاق، ويحدّد المسار.
    const { data: context, error: permError } = await supabaseUser
      .rpc("sub_user_create_context");

    if (permError || !context) {
      console.error("permission check failed:", permError?.message);
      return json({ error: "تعذّر التحقق من صلاحيتك الآن. حاول مرة أخرى." }, 503);
    }

    if (context.allowed !== true) {
      // رسالة واحدة لكل أسباب الرفض عمدًا: التمييز بين «لست مديرًا» و«لا
      // استحقاق» يكشف حالة حساب الشركة لمن لا يملكه.
      return json({
        error:
          "إضافة المستخدمين متاحة لمدير الشركة ضمن اشتراك يشمل المستخدمين الفرعيين.",
      }, 403);
    }

    // المسار تقرّره القاعدة: عضو تابع، أم حساب مستقل.
    const attachToCompany = context.attach_to_company === true;

    // ── نطاق الشركة يُشتق من الخادم (لمسار العضو التابع وحده) ──────────────
    if (attachToCompany) {
      const { data: companyId, error: companyError } = await supabaseUser
        .rpc("current_company_id");
      if (companyError || !companyId) {
        return json({ error: "حسابك غير مرتبط بشركة." }, 403);
      }
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
    // التبعية من هوية المنادي المتحقَّق منها وحدها، وللمسار الذي قرّرته
    // القاعدة: طاقم المنصة يُنشئ حسابًا مستقلًا (null) كما كان دائمًا.
    const superUserId = attachToCompany ? currentUser.id : null;

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
    // role: "customer" مكتوبة كما في الإصدار السابق حرفيًا — هي دور الحساب
    // المستقل الذي يُنشئه طاقم المنصة. وعلى مسار عضو الشركة يرفعها محفّز
    // sync_company_role (الترحيل 035) إلى company_user لأن super_user_id يشير
    // إلى مالك شركة. فالمسار الإداري يبقى كما كان بالضبط، والمسار الجديد
    // يأخذ دوره من العلاقة لا من هذه الدالة.
    const { data: updatedRows, error: profileUpdateError } = await supabaseAdmin
      .from("profiles")
      .update({
        email,
        full_name: fullName,
        username: email.split("@")[0],
        role: "customer",
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

    // ── تحقّق أخير: الناتج يطابق المسار المقصود ───────────────────────────
    //
    // مسار العضو: الدور لا بد أن يكون company_user. لو لم يكن فالمحفّز غائب
    // (لم يُطبَّق الترحيل 035)، والحساب حينها عضو بلا دور — فنتراجع بدل أن
    // نترك حالة نصف مكتملة.
    //
    // مسار الحساب المستقل: التبعية لا بد أن تكون فارغة. أي قيمة فيها تعني
    // أن حسابًا إداريًا رُبط بشركة عن غير قصد.
    const mismatch = attachToCompany
      ? (created.role !== "company_user" ? "لم يُسنَد دور العضو داخل الشركة" : null)
      : (created.super_user_id !== null ? "رُبط الحساب المستقل بشركة" : null);

    if (mismatch) {
      await supabaseAdmin.auth.admin.deleteUser(newUser.user.id);
      console.error("post-create mismatch:", mismatch);
      return json({ error: "تعذّر إكمال إنشاء الحساب. راجع الدعم الفني." }, 500);
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
