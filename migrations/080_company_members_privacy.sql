-- ============================================================================
-- 080_company_members_privacy.sql
--   company_members(): القائمة الكاملة لمدير الشركة وحده. عميل الشركة يرى
--   نفسه ومدير شركته فقط — لا أسماء العملاء الآخرين ولا بريدهم.
--
-- المشكلة (F4 في docs/relay/CONTINUITY_MULTITENANT_ARCHITECTURE_REPORT.md §9.4)
--   company_members() كانت تشترط فقط أن يكون للمنادي شركة (current_company_id)،
--   ثم ترجع **كل** التابعين بأسمائهم وبريدهم. والتابعون هم عملاء الشركة
--   (033: «تذاكر عملائي» = تذاكر التابعين؛ القرار D2: التابع عميل افتراضيًا).
--   أي أن كل عميل لشركة يستطيع سرد أسماء وبريد كل عملائها الآخرين بنداء واحد.
--   سياسات profiles لا تسمح بذلك (supervises() للمالك وحده) — الدالة كانت
--   الثغرة الوحيدة، لأنها SECURITY DEFINER.
--
-- الإصلاح
--   scope = 'full'  ⇔ is_company_admin() (الرتبة + العلاقة + سياق المالك في 040)
--                     والمنادي مالك الشركة فعلًا، وحسابه مفعّل، وخارج المعاينة.
--                     المخرَج مطابق حرفيًا لما قبل 080 (+ مفتاح scope).
--   scope = 'self'  ⇔ أي تابع آخر (عميل الشركة)، ومعاينة عضو الشركة (041).
--                     members = مدير الشركة (الاسم فقط، بلا بريد) + المنادي نفسه.
--   null            ⇔ لا شركة — كما قبل 080.
--
--   باقي المفاتيح (company_id, company_role, is_owner, can_manage) كما هي.
--   الصلاحيات كما هي (CREATE OR REPLACE يحفظها).
--
-- ما لا يفعله
--   • لا يغيّر remove_company_member ولا can_manage_company_members ولا أي سياسة.
--   • لا يعتمد على company_staff (081): «الموظف المخوَّل» يقرأ فريقه عبر
--     company_staff_list() هناك، بلا بيانات اتصال. توسيع رؤية المشرف لقائمة
--     العملاء قرار مؤجل لصندوق الشركة (الزيادة 3).
--
-- الترقيم: 077–079 محجوزة لسلسلة continuity (#116–#118، غير مطبّقة)، و081 لفريق
--   الشركة. لا يعتمد 080 على أي منها ولا هي عليه، فترتيب التطبيق بينها حر.
--
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/080_company_members_privacy.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات: النص الحالي يجب أن يكون نص الإنتاج قبل 080 أو نص 080 نفسه
--    (إعادة تشغيل). أي نص ثالث يعني أن أحدًا عدّل الدالة، فالتراجع لن يعيد
--    ما كان قائمًا — نوقف بدل أن نكتب فوقه.
-- ============================================================================
do $$
declare
  f text;
  v_def text;
begin
  foreach f in array array[
    'public.company_members()', 'public.current_company_id()', 'public.is_company_admin()',
    'public.company_role()', 'public.can_manage_company_members()', 'public.account_is_active()',
    'public.preview_mode()'] loop
    if to_regprocedure(f) is null then
      raise exception '080 يتطلب %', f;
    end if;
  end loop;
  v_def := pg_get_functiondef('public.company_members()'::regprocedure);
  if md5(v_def) <> '0e4030f30af1586d7f8f2ced6c3e7307'          -- الإنتاج 2026-10-12 (قبل 080)
     and position('080_company_members_privacy' in v_def) = 0 then
    raise exception '080: company_members() ليست نص الإنتاج المتوقع (md5 %) — راجع قبل التطبيق', md5(v_def);
  end if;
end $$;


-- ============================================================================
-- 1) الدالة
-- ============================================================================
create or replace function public.company_members()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
-- 080_company_members_privacy: القائمة الكاملة لمدير الشركة وحده.
declare
  v_company_id uuid;
  v_owner_id   uuid;
  v_full       boolean;
  v_members    jsonb;
begin
  if auth.uid() is null then return null; end if;
  v_company_id := public.current_company_id();
  if v_company_id is null then return null; end if;
  select user_id into v_owner_id from public.companies where id = v_company_id;

  v_full := v_owner_id = auth.uid()
        and coalesce(public.is_company_admin(), false)
        and coalesce(public.account_is_active(), false)
        and not coalesce(public.preview_mode(), true);

  if v_full then
    -- نفس مخرَج ما قبل 080 حرفيًا
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', m.id,
             'name', coalesce(m.full_name, m.username, m.email),
             'email', m.email,
             'role', m.role,
             'is_owner', (m.id = v_owner_id),
             'is_me', (m.id = auth.uid()),
             'created_at', m.created_at
           ) order by (m.id = v_owner_id) desc, m.created_at), '[]'::jsonb)
      into v_members
      from public.profiles m
     where m.id = v_owner_id or m.super_user_id = v_owner_id;
  else
    -- المدير: اسمه فقط (بلا رجوع للبريد كاسم). المنادي: بياناته هو.
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', m.id,
             'name', case when m.id = auth.uid() then coalesce(m.full_name, m.username, m.email)
                          else coalesce(m.full_name, m.username, 'مدير الشركة') end,
             'email', case when m.id = auth.uid() then m.email end,
             'role', m.role,
             'is_owner', (m.id = v_owner_id),
             'is_me', (m.id = auth.uid()),
             'created_at', m.created_at
           ) order by (m.id = v_owner_id) desc, m.created_at), '[]'::jsonb)
      into v_members
      from public.profiles m
     where m.id = v_owner_id
        or (m.id = auth.uid() and m.super_user_id = v_owner_id);
  end if;

  return jsonb_build_object(
    'company_id', v_company_id,
    'company_role', public.company_role(),
    'is_owner', (v_owner_id = auth.uid()),
    'can_manage', public.can_manage_company_members(),
    'scope', case when v_full then 'full' else 'self' end,
    'members', v_members);
end;
$function$;

comment on function public.company_members() is
  '080: أعضاء شركة المنادي. scope=full (كل التابعين ببريدهم) لمدير الشركة وحده؛ scope=self '
  '(المدير بالاسم + المنادي) لأي تابع آخر وللمعاينة. بلا مُعاملات — الشركة من auth.uid().';


-- ============================================================================
-- 2) تحقق
-- ============================================================================
do $$
begin
  if has_function_privilege('anon', 'public.company_members()', 'EXECUTE') then
    raise exception '080: company_members() منفذة لـanon';
  end if;
  if not has_function_privilege('authenticated', 'public.company_members()', 'EXECUTE') then
    raise exception '080: company_members() غير منفذة لـauthenticated';
  end if;
  if position('080_company_members_privacy' in pg_get_functiondef('public.company_members()'::regprocedure)) = 0 then
    raise exception '080: الدالة لم تُستبدل';
  end if;
  raise notice '080: company_members() تقصر القائمة الكاملة على مدير الشركة';
end $$;
