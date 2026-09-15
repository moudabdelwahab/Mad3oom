-- ============================================================================
-- 037_sub_user_create_gate.sql
--   بوابة إنشاء الحسابات عبر create-sub-user — مساران مشروعان لا مسار واحد.
--
-- الخلل الذي يعالجه
--   الترحيل 035 قاعد الرتبة super_user، والدالة المنشورة create-sub-user
--   تفوّض على `role === 'super_user'` أو `admin/support`. فالنتيجة اليوم:
--     • مدير الشركة  → 403، وإضافة عضو الشركة مكسورة.
--     • الأدمن       → ما زال يعمل (فرع admin/support).
--
--   والنسخة المُحصَّنة الأولى صحّحت المسار الأول وأغفلت الثاني: بوابتها
--   can_manage_company_members() وحدها، والأدمن ليس مدير شركة — فنشرها كان
--   سيكسر إنشاء الحسابات من لوحة الإدارة. مقايضة عطل بعطل لا إصلاح.
--
-- التصميم — مساران بدلالتين مختلفتين، والفرق جوهري لا تجميلي
--
--   ① طاقم المنصة (platform_owner · admin · support)
--        يُنشئ **حسابًا مستقلًا**: super_user_id = null.
--        هذه صلاحية إدارية قائمة منذ البداية ولا علاقة لها بالشركات،
--        ويُحافَظ عليها حرفيًا كما كانت.
--
--   ② مدير الشركة (is_company_admin + استحقاق sub_users)
--        يُنشئ **عضوًا تابعًا لشركته**: super_user_id = هويته.
--
--   attach_to_company هو ما يفرّق بينهما، وتُقرّره القاعدة لا الدالة —
--   فلا يمكن لطلب أن يختار أيّ المسارين يسلك.
--
--   ولا مُعامل هوية في الدالة إطلاقًا: النطاق من auth.uid() وحده.
-- ============================================================================

create or replace function public.sub_user_create_context()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null then
    return jsonb_build_object('allowed', false, 'actor', 'anonymous',
                              'attach_to_company', false);
  end if;

  -- ① طاقم المنصة: حساب مستقل. لا يُربط بشركة بحال — حتى لو كان الأدمن
  --    نفسه يملك شركة، فإنشاء حساب من لوحة الإدارة فعل إداري لا فعل شركة.
  if public.is_platform_staff() then
    return jsonb_build_object('allowed', true, 'actor', 'platform_staff',
                              'attach_to_company', false);
  end if;

  -- ② مدير الشركة باستحقاق فعّال: عضو تابع لشركته.
  if public.can_manage_company_members() then
    return jsonb_build_object('allowed', true, 'actor', 'company_admin',
                              'attach_to_company', true);
  end if;

  -- الرفض، مع تصنيف للتشخيص. الدالة المنادية تعرض رسالة موحّدة ولا تكشفه.
  return jsonb_build_object(
    'allowed', false,
    'actor', case
               when public.is_company_admin()  then 'company_admin_no_entitlement'
               when public.is_company_member() then 'company_user'
               else 'customer'
             end,
    'attach_to_company', false);
end;
$$;

comment on function public.sub_user_create_context() is
  'بوابة create-sub-user: طاقم منصة ← حساب مستقل، مدير شركة باستحقاق ← عضو '
  'تابع. attach_to_company تُقرّره القاعدة فلا يختار الطلب مساره.';

revoke all on function public.sub_user_create_context() from public, anon;
grant execute on function public.sub_user_create_context() to authenticated;


-- ── تحقّق ذاتي ────────────────────────────────────────────────────────────
do $$
declare v_src text;
begin
  if to_regprocedure('public.sub_user_create_context()') is null then
    raise exception 'دالة بوابة إنشاء الحسابات لم تُنشأ';
  end if;

  v_src := pg_get_functiondef('public.sub_user_create_context()'::regprocedure);

  if v_src !~ 'is_platform_staff' then
    raise exception 'البوابة لا تشمل طاقم المنصة — مسار لوحة الإدارة سينكسر';
  end if;
  if v_src !~ 'can_manage_company_members' then
    raise exception 'البوابة لا تشمل مدير الشركة';
  end if;
  if v_src ~ 'p_user_id|p_company_id' then
    raise exception 'البوابة تقبل معرّف هوية كمُعامل — قابل للتزوير';
  end if;

  raise notice 'OK 037: مساران مشروعان — طاقم المنصة (مستقل) ومدير الشركة (تابع)';
end $$;
