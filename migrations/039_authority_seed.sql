-- ============================================================================
-- 039_authority_seed.sql
--   زرع السلطة: مالك واحد، وحسابان مرتفعان — بمعرّفات لا ببريد.
--
-- ════════════════════════════════════════════════════════════════════════════
-- البريد هنا، ولا يناقض «ممنوع البريد كآلية تفويض»
-- ════════════════════════════════════════════════════════════════════════════
--
-- الفرق بين الأمرين ليس لفظيًا:
--
--   آلية تفويض   تُقيَّم **وقت كل طلب**، ومُدخَلها عمود قد يتغير أو يُكتَب،
--                 فتتغير الصلاحية بتغيّره. هذا ما نزيله في 040.
--   محدِّد بيانات تُقيَّم **مرة واحدة** داخل ترحيل بمراجعة بشرية، ونتيجتها
--                 معرّف ثابت (uuid) يُخزَّن. وبعدها لا يُقرأ البريد أبدًا.
--
-- ولذلك القراءة هنا من auth.users.email — لا public.profiles.email. الثاني
-- قابل للكتابة من العميل (موثَّق في 027، وصف حقيقي في الإنتاج يحمل email=''
-- بينما auth.users يحمل عنوانًا صحيحًا)، والأول لا.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ترتيب مقصود: 039 قبل 040
-- ════════════════════════════════════════════════════════════════════════════
--
-- 040 هو الذي ينزع مسارات البريد من دوال التفويض. فلو سبق 039، لمرّت لحظة
-- يفقد فيها support@ و info@ سلطتهما المرتفعة. الزرع أولًا يجعل الانتقال
-- بلا فجوة: البديل الصريح قائم قبل أن يُنزَع القديم.
--
-- وكل جملة هنا idempotent، فإعادة التشغيل لا تُنتج أثرًا ثانيًا.
-- ============================================================================

do $$
begin
  if to_regprocedure('public.is_platform_owner()') is null
     or to_regclass('public.platform_authority') is null then
    raise exception 'يجب تطبيق migrations/038 أولًا';
  end if;
end $$;


-- ============================================================================
-- 1) تحقّق قبلي — نطبع الحالة قبل المساس بها
-- ============================================================================
do $$
declare
  v_owner_role text; v_owner_company int; v_admins int; v_auth int;
begin
  select p.role into v_owner_role
    from auth.users u join public.profiles p on p.id = u.id
   where u.email = 'mahmoud@mad3oom.com';

  select count(*) into v_owner_company
    from public.companies c join auth.users u on u.id = c.user_id
   where u.email = 'mahmoud@mad3oom.com';

  select count(*) into v_admins from public.profiles where role = 'admin';
  select count(*) into v_auth   from public.platform_authority;

  raise notice '039 preflight: رتبة المالك=% · شركاته=% · أدمنز=% · صفوف سلطة=%',
    coalesce(v_owner_role, '(غير موجود)'), v_owner_company, v_admins, v_auth;
end $$;


-- ============================================================================
-- 2) المالك — الرتبة والسلطة معًا، وإلا فلا شيء
-- ============================================================================
--
-- الشرطان يُكتبان في معاملة واحدة لأن is_platform_owner() تشترطهما معًا:
-- صف سلطة بلا رتبة لا يمنح، ورتبة بلا صف سلطة لا تمنح.
--
-- ملاحظة على المحفّزات: هذا الترحيل يعمل بلا auth.uid()، فـ
-- guard_profile_role_change تمرّره، و sync_company_role تستثني رتب المنصة
-- صراحةً (قسم ٤ من 035) — فامتلاكه شركةً لن يُعيده company_admin لاحقًا.

do $$
declare v_id uuid;
begin
  select u.id into v_id from auth.users u where u.email = 'mahmoud@mad3oom.com';

  if v_id is null then
    raise exception 'حساب المالك mahmoud@mad3oom.com غير موجود — الزرع يتوقف';
  end if;

  -- ① الرتبة: الهوية الأساسية الثابتة. لا تتغير عند تبديل السياق أبدًا.
  update public.profiles set role = 'platform_owner'
   where id = v_id and coalesce(role, '') is distinct from 'platform_owner';

  -- ② السلطة: المصدر الفعلي. الفهرس الفريد في 038 يضمن ألا يصير اثنين.
  insert into public.platform_authority (user_id, level, note)
  values (v_id, 'owner', 'مالك المنصة الوحيد — زُرع في 039')
  on conflict (user_id) do update set level = 'owner';

  raise notice '039: المالك %', v_id;
end $$;


-- ============================================================================
-- 3) السلطة المرتفعة — حفظ الوضع القائم بمنح صريح بدل البريد
-- ============================================================================
--
-- هذان الحسابان يملكان اليوم كل ما يمنحه is_main_admin(): حذف أي حساب،
-- قراءة وتعديل كل الحسابات، كل الإشعارات والمحادثات، منح رتب المنصة، تعديل
-- النقاط، مفتاح Aqar. و040 ينقل تلك السياسات إلى has_elevated_authority()،
-- فالصفّان هنا هما ما يمنع سقوط صلاحياتهما لحظة تطبيقه.
--
-- وليست وراثةً لسلطة المالك: السطح الحصري الجديد (تبديل السياقات · إدارة
-- platform_authority · منح رتبة platform_owner · لوحة المالك) يظل
-- is_platform_owner() وحده. أما هذه فسلطة سابقة لوجود المالك، تُحفظ مؤقتًا،
-- وتضييقها بند موثَّق لمرحلة 1.5.

do $$
declare
  v_email text;
  v_id    uuid;
begin
  foreach v_email in array array['support@mad3oom.online', 'info@mad3oom.online'] loop
    select u.id into v_id from auth.users u where u.email = v_email;

    if v_id is null then
      raise exception 'الحساب المرتفع % غير موجود — الزرع يتوقف حتى لا يفقد صلاحيته في 040', v_email;
    end if;

    insert into public.platform_authority (user_id, level, note)
    values (v_id, 'elevated_admin', 'حفظ سلطة is_main_admin القائمة — زُرع في 039')
    on conflict (user_id) do nothing;

    raise notice '039: سلطة مرتفعة % (%)', v_email, v_id;
  end loop;
end $$;


-- ============================================================================
-- 4) تحقّق بَعدي — الترحيل يُثبت نتيجته بنفسه
-- ============================================================================
do $$
declare
  v_owners int; v_elevated int; v_role text; v_owns boolean;
begin
  select count(*) into v_owners   from public.platform_authority where level = 'owner';
  select count(*) into v_elevated from public.platform_authority where level = 'elevated_admin';

  select p.role into v_role
    from auth.users u join public.profiles p on p.id = u.id
   where u.email = 'mahmoud@mad3oom.com';

  select exists (select 1 from public.companies c join auth.users u on u.id = c.user_id
                  where u.email = 'mahmoud@mad3oom.com') into v_owns;

  if v_owners <> 1 then
    raise exception 'عدد المالكين % وليس 1', v_owners;
  end if;
  if v_role is distinct from 'platform_owner' then
    raise exception 'رتبة المالك % وليست platform_owner', v_role;
  end if;
  if v_elevated <> 2 then
    raise exception 'عدد الحسابات المرتفعة % وليس 2', v_elevated;
  end if;
  -- ملكية الشركة علاقة لا رتبة، فتغيير الرتبة لا يجوز أن يمسّها.
  if not v_owns then
    raise exception 'المالك فقد صف الشركة — الملكية كانت مشتقّة من الرتبة وهذا خطأ';
  end if;

  raise notice '039 postflight: مالك=1 · مرتفع=2 · الرتبة=% · الشركة محفوظة', v_role;
end $$;
