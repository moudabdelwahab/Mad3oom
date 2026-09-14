-- ============================================================================
-- 035_company_roles.sql
--   إدخال company_admin و company_user كجزء رسمي من معمار التفويض.
--
-- ════════════════════════════════════════════════════════════════════════════
-- لماذا لم يكن هذا مجرد إعادة تسمية
-- ════════════════════════════════════════════════════════════════════════════
--
-- قراءة الإنتاج (لا الكود) أظهرت أن الرتبة super_user كانت تؤدي **وظيفتين لا
-- علاقة بينهما**، وليست أيًّا منهما «مدير شركة»:
--
--   ① سلطة طاقم منصة — حيّة وقت الفحص على الحساب الوحيد الحامل للرتبة:
--        wf_is_staff()            → طاقم محرك سير العمل
--        is_chat_engine_staff()   → طاقم محرك المحادثة
--        is_landing_admin()       → إدارة صفحات الهبوط
--        has_chatbot_entitlement()→ استحقاق شات بوت بلا اشتراك
--        run_data_retention_cleanup() → تنفيذ تنظيف بيانات المنصة
--        و22 سياسة RLS: webhooks (إدارة كاملة)، customer_notes (CRUD على
--        ملاحظات كل العملاء)، ticket_attachments/activity/ratings (كل تذاكر
--        المنصة)، accounting_invoices (فواتير كل العملاء)، notifications
--        (إشعار لأي مستخدم)، badge_definitions (كتابة)، canned_responses،
--        ticket_tags/tag_links، customer_badges.
--
--   ② دورة حياة مرتبطة بالاشتراك — recompute_user_access() كانت ترقّي
--        user → super_user عند شراء support/bundle، و expire_stale_subscriptions()
--        تنزّلها، وتعمل كل ساعة عبر pg_cron. أي ترحيل لا يعالجهما كان سيُنقَض
--        خلال ساعة واحدة.
--
--   ③ أما صلاحيات الشركة فلم تكن من الرتبة أصلًا: current_company_id()
--        و is_owner_or_super_of() و ticket_in_my_scope() و company_members()
--        **ولا واحدة منها تقرأ profiles.role**. كلها علاقة بحتة.
--
-- ولذلك: الترحيل هنا لا «يعيد تسمية» رتبة. هو يفصل ثلاثة محاور كانت مدموجة،
-- ويشتق الرتبة الجديدة من **العلاقة** لا من الاسم القديم.
--
-- ════════════════════════════════════════════════════════════════════════════
-- الفصل الصارم المطلوب — ثلاثة نطاقات سلطة لا تتقاطع
-- ════════════════════════════════════════════════════════════════════════════
--
--   Platform Staff   platform_owner · admin · support
--                    → سلطة على المنصة. is_platform_staff()
--
--   Company Roles    company_admin · company_user
--                    → سلطة داخل شركة واحدة فقط. is_company_admin() /
--                      is_company_member()
--
--   Employee Ops     نطاق emp_ops
--                    → سلطة تشغيل الموظفين. emp_ops.is_admin()
--
-- ثلاث قواعد حاكمة، كل واحدة منها لها اختبار يفشل إن انكسرت:
--
--   ① is_platform_staff() **لا تشمل** أي دور شركة، ولا تُوسَّع لتشمله أبدًا.
--   ② دور الشركة **لا يُشتق من اسم** الدور القديم. يُشتق من العلاقة:
--      company_admin ⇔ صف في companies باسمه.
--      company_user  ⇔ super_user_id يشير إلى مالك شركة فعلي.
--   ③ emp_ops منفصل بنيويًا: emp_ops.is_admin() = emp_ops.current_rank() >= 100
--      ولا تقرأ public.profiles إطلاقًا. فالتقاطع مستحيل لا ممنوع فقط.
--
-- ════════════════════════════════════════════════════════════════════════════
-- الرتبة والعلاقة: كلاهما مطلوب، ولا يُغني أحدهما عن الآخر
-- ════════════════════════════════════════════════════════════════════════════
--
-- is_company_admin() تشترط **الرتبة و العلاقة معًا**. الرتبة مشتقّة من العلاقة
-- بمحفّز (القسم ٤)، فالشرطان متطابقان في الحالة السليمة — والفائدة تظهر عند
-- الخلل وحده: من زوّر الرتبة يفتقد العلاقة، ومن زوّر العلاقة تفتقده الرتبة،
-- وكلاهما محروس. هذا ما يجعل الدور «رسميًا» دون أن يصير نقطة الثقة الوحيدة.
--
-- ما لا يفعله هذا الترحيل
--   • لا يمنح أي دور شركة أي سلطة على المنصة — بل ينزعها.
--   • لا يغيّر منطق التسعير ولا الاستحقاقات.
--   • لا يعيد تسمية العمود super_user_id (علاقة صحيحة، وإعادة تسميته تمسّ
--     10 دوال لا علاقة لها بهذا الإصلاح — تُترك لترحيل تجميلي منفصل).
-- ============================================================================


-- ============================================================================
-- 0) تحقّق قبلي — نطبع الحالة قبل المساس بها
-- ============================================================================
do $$
declare
  v_owners int; v_members int; v_legacy int; v_staff int;
begin
  select count(*) into v_owners
    from public.profiles p
   where exists (select 1 from public.companies c where c.user_id = p.id);

  select count(*) into v_members
    from public.profiles p
   where p.super_user_id is not null
     and exists (select 1 from public.companies c where c.user_id = p.super_user_id);

  select count(*) into v_legacy from public.profiles where role = 'super_user';
  select count(*) into v_staff  from public.profiles where role in ('admin','support');

  raise notice '035 preflight: مالكو شركات=% · أعضاء شركات=% · رتبة قديمة=% · طاقم=%',
    v_owners, v_members, v_legacy, v_staff;
end $$;


-- ============================================================================
-- 1) مفردات الأدوار — قائمة مغلقة، والرتبة القديمة خارجها
-- ============================================================================
--
-- القيد يمنع عودة 'super_user' كتابةً بعد اليوم؛ فالترحيل لا يمكن أن «ينحرف»
-- رجوعًا بصمت. 'customer' مبقاة عمدًا: الدالة المنشورة create-sub-user ما زالت
-- تكتبها، وهي تُنشر بقرار منفصل — فإسقاطها الآن كان سيكسر مسارًا حيًّا.

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role is null or role in (
    -- طاقم المنصة
    'platform_owner', 'admin', 'support',
    -- أدوار الشركة
    'company_admin', 'company_user',
    -- حسابات العملاء الأفراد
    'user', 'customer'
  )) not valid;   -- not valid: نصحّح البيانات في القسم ٣ ثم نُثبّته

comment on constraint profiles_role_check on public.profiles is
  'مفردات الأدوار المغلقة. super_user متقاعدة عمدًا — العلاقة بالشركة هي '
  'مصدر صلاحيات الشركة، لا رتبة عامة.';


-- ============================================================================
-- 2) دوال السلطة — ثلاثة نطاقات، ثلاث دوال، بلا تقاطع
-- ============================================================================

-- ── ② طاقم المنصة ─────────────────────────────────────────────────────────
--
-- **لا تشمل أي دور شركة، ولا يجوز توسيعها لتشمله.** اختبار RLS مرافق يفشل
-- إن أُضيف company_admin أو company_user هنا يومًا.
create or replace function public.is_platform_staff()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid()
       and (role in ('platform_owner', 'admin', 'support')
            or email in ('support@mad3oom.online', 'info@mad3oom.online'))
  );
$$;

comment on function public.is_platform_staff() is
  'سلطة على مستوى المنصة: platform_owner|admin|support. أدوار الشركة ليست منها '
  'بأي حال، وتوسيعها لتشملها يكسر الفصل الأمني ويفشل اختبار company-roles.';

revoke all on function public.is_platform_staff() from public, anon;
grant execute on function public.is_platform_staff() to authenticated;


-- ── ملكية الشركة كعلاقة خام (بلا رتبة) ────────────────────────────────────
--
-- تُستعمل في المحفّز الذي يشتق الرتبة — ولذلك لا يجوز أن تعتمد هي نفسها على
-- الرتبة، وإلا صار التعريف دائريًا.
create or replace function public.owns_a_company(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_user_id is not null
     and exists (select 1 from public.companies c where c.user_id = p_user_id);
$$;

revoke all on function public.owns_a_company(uuid) from public, anon;
grant execute on function public.owns_a_company(uuid) to authenticated;


-- ── عضوية شركة كعلاقة خام ─────────────────────────────────────────────────
create or replace function public.belongs_to_a_company(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_user_id is not null
     and exists (
           select 1
             from public.profiles p
             join public.companies c on c.user_id = p.super_user_id
            where p.id = p_user_id
         );
$$;

revoke all on function public.belongs_to_a_company(uuid) from public, anon;
grant execute on function public.belongs_to_a_company(uuid) to authenticated;


-- ── ③ مدير الشركة — الرتبة **و** العلاقة معًا ─────────────────────────────
create or replace function public.is_company_admin()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.role = 'company_admin'
  )
  and public.owns_a_company(auth.uid());
$$;

comment on function public.is_company_admin() is
  'مدير شركة = الرتبة company_admin **و** صف في companies باسمه. الشرطان معًا: '
  'من زوّر الرتبة يفتقد العلاقة، ومن زوّر العلاقة تفتقده الرتبة.';

revoke all on function public.is_company_admin() from public, anon;
grant execute on function public.is_company_admin() to authenticated;


-- ── مستخدم الشركة — الرتبة **و** العلاقة معًا ─────────────────────────────
--
-- لا يرث شيئًا من company_admin. كل ما يملكه منصوص عليه صراحةً حيث يُمنَح.
create or replace function public.is_company_member()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.role = 'company_user'
  )
  and public.belongs_to_a_company(auth.uid());
$$;

comment on function public.is_company_member() is
  'مستخدم تابع لشركة. لا يرث صلاحيات company_admin بحال — العضوية في نفس '
  'الشركة ليست ترقية.';

revoke all on function public.is_company_member() from public, anon;
grant execute on function public.is_company_member() to authenticated;


-- ── موقع الحساب داخل شركته — مصدر واحد للخادم والواجهة ────────────────────
create or replace function public.company_role()
returns text
language sql
stable
security definer
set search_path to 'public'
as $$
  select case
    when auth.uid() is null            then null
    when public.is_company_admin()     then 'company_admin'
    when public.is_company_member()    then 'company_user'
    else null
  end;
$$;

revoke all on function public.company_role() from public, anon;
grant execute on function public.company_role() to authenticated;


-- ── الشركة التي ينتمي إليها حساب ما — أساس عزل المستأجرين ─────────────────
--
-- بلا مُعامل يوجّهها إلى شركة أخرى حين تُنادى بلا وسيط: الافتراضي auth.uid().
create or replace function public.company_of(p_user_id uuid default auth.uid())
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $$
  select c.id
    from public.companies c
   where p_user_id is not null
     and (c.user_id = p_user_id
          or c.user_id = (select p.super_user_id from public.profiles p where p.id = p_user_id))
   order by (c.user_id = p_user_id) desc
   limit 1;
$$;

revoke all on function public.company_of(uuid) from public, anon;
grant execute on function public.company_of(uuid) to authenticated;


-- ── إدارة الأعضاء = مدير شركة **و** استحقاق sub_users ─────────────────────
create or replace function public.can_manage_company_members()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.is_company_admin()
     and public.company_has_feature('sub_users');
$$;

comment on function public.can_manage_company_members() is
  'إضافة/إزالة أعضاء الشركة: الدور والعلاقة والاستحقاق — الثلاثة معًا.';

revoke all on function public.can_manage_company_members() from public, anon;
grant execute on function public.can_manage_company_members() to authenticated;


-- ============================================================================
-- 3) نقل البيانات — من العلاقة، لا من اسم الرتبة القديم
-- ============================================================================
--
-- ثلاث خطوات مرتّبة، وكل واحدة تستثني رتب المنصة صراحةً فلا يُنزَّل أدمن
-- بالخطأ. الترتيب مقصود: المالك أولًا، ثم العضو، ثم ما تبقّى من الرتبة القديمة.
--
-- ملاحظة جوهرية: لا يوجد في أي من هذه الجُمل شرط `role = 'super_user'`. الرتبة
-- الجديدة تُمنَح لمن **يملك شركة** أو **ينتمي إليها**، أيًّا كانت رتبته قبل ذلك.
-- من حمل الرتبة القديمة بلا علاقة شركة لا يحصل على شيء — يعود عميلًا عاديًا.

-- المحفّزات الحارسة تمنع كتابة الرتب من داخل جلسة مستخدم. هذا الترحيل يعمل
-- بلا auth.uid()، وكل الحرّاس يمرّرون في هذه الحالة (service/background).

-- ── ① مالكو الشركات ← company_admin ───────────────────────────────────────
update public.profiles p
   set role = 'company_admin'
 where exists (select 1 from public.companies c where c.user_id = p.id)
   and coalesce(p.role, '') not in ('platform_owner', 'admin', 'support')
   and coalesce(p.role, '') is distinct from 'company_admin';

-- ── ② أعضاء الشركات ← company_user ────────────────────────────────────────
update public.profiles p
   set role = 'company_user'
 where p.super_user_id is not null
   and exists (select 1 from public.companies c where c.user_id = p.super_user_id)
   and coalesce(p.role, '') not in ('platform_owner', 'admin', 'support')
   and coalesce(p.role, '') is distinct from 'company_user';

-- ── ③ بقايا الرتبة القديمة بلا أي علاقة شركة ← عميل عادي ──────────────────
--
-- بلا سلطة وبلا ترقية: الرتبة كانت تُمنَح آليًا لمن يشتري باقة دعم، وهذا
-- المنح نفسه يتوقف في القسم ٧. فمن حملها بلا شركة لم يكن مدير شركة قط.
update public.profiles
   set role = 'user'
 where role = 'super_user';

-- الآن صارت البيانات مطابقة للمفردات، فنُثبّت القيد.
alter table public.profiles validate constraint profiles_role_check;


-- ============================================================================
-- 4) الرتبة تتبع العلاقة تلقائيًا — فلا تنحرف إحداهما عن الأخرى
-- ============================================================================
--
-- بلا هذا المحفّز يصير الدور لقطة قديمة: يُضاف عضو فيبقى 'user'، أو تُقطع
-- العلاقة فيبقى 'company_user' بلا شركة. المحفّز يجعل الدور **مشتقًّا** —
-- ومن ثم لا يحتاج أحد إلى كتابته يدويًا أصلًا (وهو ما يمنعه القسم ٥).

create or replace function public.sync_company_role()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_target text;
begin
  -- رتب المنصة لا تُمسّ إطلاقًا: أدمن يملك شركة يظل أدمن.
  if coalesce(new.role, '') in ('platform_owner', 'admin', 'support') then
    return new;
  end if;

  if public.owns_a_company(new.id) then
    v_target := 'company_admin';
  elsif new.super_user_id is not null
        and exists (select 1 from public.companies c where c.user_id = new.super_user_id) then
    v_target := 'company_user';
  elsif coalesce(new.role, '') in ('company_admin', 'company_user') then
    -- انقطعت العلاقة: الدور يسقط معها، ولا يبقى دور شركة بلا شركة.
    v_target := 'user';
  else
    return new;
  end if;

  new.role := v_target;
  return new;
end;
$$;

revoke all on function public.sync_company_role() from public, anon, authenticated;

drop trigger if exists trg_sync_company_role on public.profiles;
create trigger trg_sync_company_role
  before insert or update of super_user_id, role on public.profiles
  for each row execute function public.sync_company_role();

-- والمالك: إنشاء الشركة نفسه هو ما يصنع company_admin.
create or replace function public.sync_company_owner_role()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update public.profiles
     set role = 'company_admin'
   where id = new.user_id
     and coalesce(role, '') not in ('platform_owner', 'admin', 'support')
     and coalesce(role, '') is distinct from 'company_admin';

  -- نُقل المِلك من حساب لآخر: المالك السابق يفقد الدور إن لم يعد يملك شيئًا.
  if tg_op = 'UPDATE' and old.user_id is distinct from new.user_id then
    update public.profiles
       set role = 'user'
     where id = old.user_id
       and coalesce(role, '') = 'company_admin'
       and not public.owns_a_company(old.user_id);
  end if;

  return new;
end;
$$;

revoke all on function public.sync_company_owner_role() from public, anon, authenticated;

drop trigger if exists trg_sync_company_owner_role on public.companies;
create trigger trg_sync_company_owner_role
  after insert or update of user_id on public.companies
  for each row execute function public.sync_company_owner_role();


-- ============================================================================
-- 5) الحرّاس — لا أحد يرقّي نفسه، ولا يبدّل شركته، ولا يمنح دور شركة يدويًا
-- ============================================================================

create or replace function public.guard_profile_role_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.role is not distinct from old.role then
    return new;
  end if;

  -- بلا auth.uid() = مفتاح خدمة أو وظيفة خلفية، لا مستخدمًا عبر الـAPI.
  -- محفّزات القسم ٤ تعمل هنا أيضًا وهي المسار المشروع لأدوار الشركة.
  if auth.uid() is null then
    return new;
  end if;

  -- تغيير رتبة النفس: غير مشروع على أي مسار، حتى للأدمن.
  -- هذا ما يمنع company_user من ترقية نفسه إلى company_admin.
  if auth.uid() = new.id then
    raise exception 'لا يمكنك تغيير صلاحية حسابك بنفسك' using errcode = '42501';
  end if;

  -- مالك الشركة ليس أدمن: ملكيته لصف تابعه تخوّله تعديل بياناته لا ترقيته.
  if not public.is_admin() then
    raise exception 'تغيير الرتب متاح للإدارة فقط' using errcode = '42501';
  end if;

  -- رتب السلطة لا يمنحها أدمن عادي.
  if new.role in ('platform_owner', 'admin', 'support') and not public.is_main_admin() then
    raise exception 'منح رتبة % يتطلب الإدارة العليا', new.role using errcode = '42501';
  end if;

  -- أدوار الشركة **مشتقّة لا ممنوحة**: تأتي من محفّزات القسم ٤ وحدها.
  -- منحها يدويًا كان سيصنع مدير شركة بلا شركة — دورًا معلّقًا في الفراغ.
  if new.role in ('company_admin', 'company_user') then
    raise exception 'أدوار الشركة تُشتق من العلاقة بالشركة ولا تُمنَح يدويًا'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.guard_profile_role_change() from public, anon, authenticated;

-- المحفّز القديم كان يحرس اسم الرتبة المتقاعدة. الحراسة الآن على التبعية،
-- وهي ما يمنع مستخدمًا من نقل نفسه إلى شركة أخرى.
create or replace function public.check_super_user_creation()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if tg_op = 'UPDATE' and old.super_user_id is distinct from new.super_user_id then
    -- المسار الشرعي الوحيد لغير الإدارة: مالك يقطع علاقة عضوه
    -- (remove_company_member). لا أحد يضمّ نفسه لشركة ولا ينتقل بينها.
    if new.super_user_id is null and old.super_user_id = auth.uid() then
      return new;
    end if;
    if not public.is_main_admin() then
      raise exception 'لا يمكن تغيير تبعية المستخدم إلا بواسطة الإدارة العليا'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.check_super_user_creation() from public, anon, authenticated;


-- ============================================================================
-- 6) نزع سلطة المنصة عن الرتبة المتقاعدة — الدوال
-- ============================================================================
--
-- كل دالة هنا كانت تضع super_user في مصفوفة الطاقم. التصنيف تمّ واحدةً واحدةً:
-- أيّها سلطة منصة تبقى للطاقم، وأيّها مجرد قائمة مُراسَلة.

-- ── سلطة: طاقم محرك سير العمل ─────────────────────────────────────────────
create or replace function public.wf_is_staff()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.is_platform_staff();
$$;

-- ── سلطة: طاقم محرك المحادثة (وكانت الدالة الوحيدة بلا search_path مثبت) ──
create or replace function public.is_chat_engine_staff()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.is_platform_staff();
$$;

-- ── سلطة: إدارة صفحات الهبوط ──────────────────────────────────────────────
-- كانت ('admin','super_user') بلا support، فلا نوسّعها إلى الطاقم كله.
create or replace function public.is_landing_admin()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.is_admin();
$$;

-- ── سلطة: تنظيف بيانات المنصة (إجراء متلف) ────────────────────────────────
--
-- كانت البوابة ('admin','super_user') — أي أن مالك شركة كان يقدر على تشغيل
-- حذف/أرشفة تذاكر المنصة كلها. **الجسد محفوظ حرفيًا كما هو على الإنتاج**؛
-- التغيير الوحيد هو سطر البوابة.
create or replace function public.run_data_retention_cleanup()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
DECLARE
  v_settings jsonb;
  v_enabled boolean;
  v_days int;
  v_action text;
  v_affected int;
BEGIN
  -- البوابة السابقة كانت تشمل الرتبة المتقاعدة إلى جانب admin.
  IF auth.role() IS NOT NULL AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'غير مصرح لك بتنفيذ هذا الإجراء' USING ERRCODE = '42501';
  END IF;

  SELECT value INTO v_settings FROM public.advanced_settings WHERE key = 'data_retention';
  IF v_settings IS NULL THEN
    RETURN jsonb_build_object('ran', false, 'reason', 'no_config');
  END IF;

  v_enabled := COALESCE((v_settings->>'enabled')::boolean, false);
  v_days := COALESCE((v_settings->>'ticket_retention_days')::int, 365);
  v_action := COALESCE(v_settings->>'action', 'archive');

  IF NOT v_enabled THEN
    RETURN jsonb_build_object('ran', false, 'reason', 'disabled');
  END IF;

  IF v_action = 'delete' THEN
    WITH deleted AS (
      DELETE FROM public.tickets
        WHERE status IN ('resolved','confirmed','rejected')
          AND created_at < now() - (v_days || ' days')::interval
        RETURNING id
    )
    SELECT count(*) INTO v_affected FROM deleted;
  ELSE
    WITH archived AS (
      UPDATE public.tickets
        SET archived_by_customer = true, archived_at = now()
        WHERE status IN ('resolved','confirmed','rejected')
          AND created_at < now() - (v_days || ' days')::interval
          AND archived_by_customer = false
        RETURNING id
    )
    SELECT count(*) INTO v_affected FROM archived;
  END IF;

  UPDATE public.advanced_settings
    SET value = jsonb_set(v_settings, '{last_run_at}', to_jsonb(now()::text)),
        updated_at = now()
    WHERE key = 'data_retention';

  RETURN jsonb_build_object('ran', true, 'affected', v_affected, 'action', v_action);
END;
$$;

revoke all on function public.run_data_retention_cleanup() from public, anon, authenticated;

-- ── استحقاق: شات بوت بلا اشتراك ───────────────────────────────────────────
-- الاختصار role in ('super_user','admin') كان يمنح الاستحقاق بلا دفع.
create or replace function public.has_chatbot_entitlement(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
set search_path to 'public'
as $$
  select exists (
    select 1 from public.profiles
     where id = p_user_id
       and (whatsapp_enabled = true or role = 'admin')
  );
$$;

-- ── قوائم مُراسَلة لا سلطة: تنبيهات تيليجرام التشغيلية ────────────────────
--
-- ليست بوابة صلاحية، لكن بقاء الرتبة المتقاعدة فيها يعني وصول تنبيه تشغيلي
-- (نص التذكرة وعنوانها) إلى حساب شركة. **الجسدان محفوظان حرفيًا**؛ التغيير
-- الوحيد هو قائمة المستقبِلين.
create or replace function public.notify_admins_on_urgent_ticket()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
DECLARE
  v_admin record;
BEGIN
  IF NEW.priority = 'high' THEN
    FOR v_admin IN
      SELECT telegram_chat_id FROM public.profiles
        WHERE role IN ('platform_owner','admin','support')
          AND telegram_chat_id IS NOT NULL
          AND 'new_urgent_ticket' = ANY(telegram_alert_events)
    LOOP
      PERFORM public.send_telegram_message(v_admin.telegram_chat_id,
        '🚨 تذكرة عاجلة جديدة رقم #' || NEW.ticket_number || E'\n' || COALESCE(NEW.title,''));
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

revoke all on function public.notify_admins_on_urgent_ticket() from public, anon, authenticated;

create or replace function public.check_sla_breaches()
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
DECLARE
  v_sla jsonb;
  v_low_hours int;
  v_medium_hours int;
  v_high_hours int;
  v_target_hours int;
  t record;
  v_admin record;
BEGIN
  SELECT value INTO v_sla FROM public.advanced_settings WHERE key = 'sla_config';
  IF v_sla IS NULL OR COALESCE((v_sla->>'enabled')::boolean, false) = false THEN
    RETURN;
  END IF;

  v_low_hours := COALESCE((v_sla->>'low_hours')::int, 48);
  v_medium_hours := COALESCE((v_sla->>'medium_hours')::int, 24);
  v_high_hours := COALESCE((v_sla->>'high_hours')::int, 4);

  FOR t IN
    SELECT * FROM public.tickets
      WHERE first_response_at IS NULL
        AND sla_alert_sent = false
        AND status = 'open'
  LOOP
    v_target_hours := CASE t.priority
      WHEN 'high' THEN v_high_hours
      WHEN 'medium' THEN v_medium_hours
      ELSE v_low_hours
    END;

    IF now() - t.created_at > (v_target_hours || ' hours')::interval THEN
      FOR v_admin IN
        SELECT telegram_chat_id FROM public.profiles
          WHERE role IN ('platform_owner','admin','support')
            AND telegram_chat_id IS NOT NULL
            AND 'sla_breach' = ANY(telegram_alert_events)
      LOOP
        PERFORM public.send_telegram_message(v_admin.telegram_chat_id,
          '⏰ تذكرة تجاوزت هدف زمن الرد (SLA) رقم #' || t.ticket_number || E'\n' || COALESCE(t.title,''));
      END LOOP;
      UPDATE public.tickets SET sla_alert_sent = true WHERE id = t.id;
    END IF;
  END LOOP;
END;
$$;

revoke all on function public.check_sla_breaches() from public, anon, authenticated;

-- ── استثناء الطاقم من شارات العملاء ───────────────────────────────────────
--
-- القائمة هنا **استثناء** لا منح: الطاقم لا يُمنح شارات عميل. وبعد الترحيل
-- صار company_admin حساب عميل فعلًا، فخروجه من قائمة الاستثناء هو الصواب.
create or replace function public.backfill_all_customer_badges()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_profile record;
  v_count int := 0;
begin
  for v_profile in
    select id from public.profiles
    where role is null or role not in ('platform_owner','admin','support')
  loop
    perform public.evaluate_customer_badges(v_profile.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.backfill_all_customer_badges() from public, anon, authenticated;


-- ============================================================================
-- 7) فصل الرتبة عن الاشتراك نهائيًا
-- ============================================================================
--
-- كان شراء support/bundle يرقّي user → super_user، والانتهاء ينزّلها، والوظيفة
-- الدورية تعمل كل ساعة. لولا هذا القسم لأعادت الوظيفة كتابة الرتبة خلال ساعة
-- ونقضت الترحيل كله.
--
-- القاعدة الجديدة: **الاشتراك يحدد الخدمات، والعلاقة تحدد دور الشركة.**
-- انتهاء الاشتراك يسحب الخدمات (عبر الاستحقاقات) ولا يسحب دور الشركة —
-- فصاحب الشركة يظل صاحبها ويرى لوحته، لكن بلا ميزات.

create or replace function public.recompute_user_access(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_features text[];
  v_whatsapp boolean;
begin
  if p_user_id is null then return null; end if;

  v_features := public.owned_feature_keys(p_user_id);
  v_whatsapp := 'whatsapp_sender' = any(v_features);

  update public.profiles
     set whatsapp_enabled = v_whatsapp
   where id = p_user_id
     and whatsapp_enabled is distinct from v_whatsapp;

  -- ولا سطر واحد يمسّ role هنا، عمدًا.
  return jsonb_build_object(
    'features',         to_jsonb(v_features),
    'whatsapp_enabled', v_whatsapp,
    'role',             (select role from public.profiles where id = p_user_id)
  );
end;
$$;

revoke all on function public.recompute_user_access(uuid) from public, anon, authenticated;

create or replace function public.expire_stale_subscriptions()
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare expired_row record;
begin
  for expired_row in
    select id, user_id, plan
      from public.whatsapp_subscriptions
     where status = 'active' and end_date < now()
  loop
    update public.whatsapp_subscriptions
       set status = 'expired', updated_at = now()
     where id = expired_row.id;

    insert into public.notifications (user_id, title, message, type, link)
    values (expired_row.user_id, 'انتهى اشتراكك',
            'انتهت صلاحية اشتراكك. يمكنك التجديد من صفحة الاشتراكات.',
            'warning', '/customer-subscriptions.html');
  end loop;

  -- الخدمات تُسحب، والرتبة لا تُمسّ.
  update public.profiles p
     set whatsapp_enabled = false
   where p.whatsapp_enabled = true
     and not exists (
       select 1 from public.whatsapp_subscriptions s
        where s.user_id = p.id
          and s.status = 'active'
          and s.plan in ('whatsapp', 'bundle')
          and s.start_date <= now()
          and s.end_date   >  now());
end;
$$;

revoke all on function public.expire_stale_subscriptions() from public, anon, authenticated;


-- ============================================================================
-- 8) السياسات — تصنيف الاثنتين وعشرين واحدةً واحدةً
-- ============================================================================
--
-- كل سياسة كانت تضع super_user مع admin/support صُنّفت بسؤال واحد:
-- «هل هذه سلطة على المنصة، أم حاجة مشروعة لشركة داخل نطاقها؟»
--
--   Platform-only (18)  ← لا علاقة لها بالشركة إطلاقًا، تبقى للطاقم وحده:
--     customer_notes ×4        ملاحظات المنصة الداخلية عن عملائها
--     webhooks · webhook_deliveries · accounting_invoices
--     badge_definitions ×2 · customer_badges
--     canned_responses · ticket_tags · ticket_tag_links ×2
--     ticket_activity (insert) · ticket_attachments (delete)
--     notifications (insert لأي مستخدم) · profiles_delete
--
--   Company-scoped (4)  ← حاجة حقيقية للشركة، لكن بنطاق صريح لا بسلطة عامة:
--     ticket_activity    (select)  نشاط تذاكر عملائها
--     ticket_attachments (select)  مرفقات تذاكر عملائها
--     ticket_attachments (insert)  إرفاق ملف في ردّها على عميلها
--     ticket_ratings     (select)  تقييمات عملائها
--
-- الأربع الأخيرة كانت تُمنَح اليوم عبر سلطة الطاقم — أي **على تذاكر المنصة
-- كلها**. البديل هنا ticket_in_my_scope() وهو نفس التعريف المستعمل في
-- الترحيل 033: تذكرتي أو تذكرة تابع لي. لا توسيع، بل تضييق جوهري.

do $$
begin
  if to_regprocedure('public.is_platform_staff()') is null then
    raise exception 'is_platform_staff غير معرَّفة — القسم ٢ لم يُنفَّذ';
  end if;
  if to_regprocedure('public.ticket_in_my_scope(uuid)') is null then
    raise exception 'ticket_in_my_scope غير معرَّفة — يجب تطبيق الترحيل 033 أولًا';
  end if;
end $$;

-- ── نشاط التذاكر ──────────────────────────────────────────────────────────
drop policy if exists "Staff can view activity" on public.ticket_activity;
create policy "Staff can view activity" on public.ticket_activity
  for select using (public.is_platform_staff());

drop policy if exists "Staff can insert activity" on public.ticket_activity;
create policy "Staff can insert activity" on public.ticket_activity
  for insert with check (public.is_platform_staff());

-- جديدة: نطاق الشركة صراحةً، لا سلطة منصة.
drop policy if exists "Company scope can view ticket activity" on public.ticket_activity;
create policy "Company scope can view ticket activity" on public.ticket_activity
  for select using (
    action_type <> all (array['assignee_change', 'assigned', 'internal_note'])
    and public.ticket_in_my_scope(ticket_id)
  );

-- ── مرفقات التذاكر ────────────────────────────────────────────────────────
drop policy if exists "Staff can view all attachments" on public.ticket_attachments;
create policy "Staff can view all attachments" on public.ticket_attachments
  for select using (public.is_platform_staff());

drop policy if exists "Staff can upload attachments" on public.ticket_attachments;
create policy "Staff can upload attachments" on public.ticket_attachments
  for insert with check (public.is_platform_staff());

drop policy if exists "Staff can delete attachments" on public.ticket_attachments;
create policy "Staff can delete attachments" on public.ticket_attachments
  for delete using (public.is_platform_staff());

drop policy if exists "Company scope can view ticket attachments" on public.ticket_attachments;
create policy "Company scope can view ticket attachments" on public.ticket_attachments
  for select using (public.ticket_in_my_scope(ticket_id));

drop policy if exists "Company scope can attach to scoped tickets" on public.ticket_attachments;
create policy "Company scope can attach to scoped tickets" on public.ticket_attachments
  for insert with check (public.ticket_in_my_scope(ticket_id));

-- ── تقييمات التذاكر ───────────────────────────────────────────────────────
drop policy if exists "Staff can view all ratings" on public.ticket_ratings;
create policy "Staff can view all ratings" on public.ticket_ratings
  for select using (public.is_platform_staff());

drop policy if exists "Company scope can view ticket ratings" on public.ticket_ratings;
create policy "Company scope can view ticket ratings" on public.ticket_ratings
  for select using (public.ticket_in_my_scope(ticket_id));

-- ── تصنيفات التذاكر: تصنيف المنصة لا الشركة ───────────────────────────────
drop policy if exists "Staff can view tags" on public.ticket_tags;
create policy "Staff can view tags" on public.ticket_tags
  for select using (public.is_platform_staff());

drop policy if exists "Staff can view tag links" on public.ticket_tag_links;
create policy "Staff can view tag links" on public.ticket_tag_links
  for select using (public.is_platform_staff());

drop policy if exists "Staff can manage tag links" on public.ticket_tag_links;
create policy "Staff can manage tag links" on public.ticket_tag_links
  for all using (public.is_platform_staff()) with check (public.is_platform_staff());

-- ── ردود جاهزة: أداة عمل داخلية للطاقم ────────────────────────────────────
drop policy if exists "Staff can view canned responses" on public.canned_responses;
create policy "Staff can view canned responses" on public.canned_responses
  for select using (public.is_platform_staff());

-- ── ملاحظات داخلية عن العملاء: تخصّ المنصة عن عملائها ─────────────────────
drop policy if exists "Admins can view customer notes" on public.customer_notes;
create policy "Admins can view customer notes" on public.customer_notes
  for select using (public.is_platform_staff());

drop policy if exists "Admins can insert customer notes" on public.customer_notes;
create policy "Admins can insert customer notes" on public.customer_notes
  for insert with check (public.is_platform_staff());

drop policy if exists "Admins can update their own notes" on public.customer_notes;
create policy "Admins can update their own notes" on public.customer_notes
  for update using (public.is_platform_staff());

drop policy if exists "Admins can delete customer notes" on public.customer_notes;
create policy "Admins can delete customer notes" on public.customer_notes
  for delete using (public.is_platform_staff());

-- ── الفوترة والويبهوكس ────────────────────────────────────────────────────
-- الثلاث لم تشمل support أصلًا، فنُبقيها على is_admin() حتى لا يوسّع الإصلاح
-- صلاحية لم تكن ممنوحة.
drop policy if exists "own_invoices_select" on public.accounting_invoices;
create policy "own_invoices_select" on public.accounting_invoices
  for select using ((user_id = auth.uid()) or public.is_admin());

drop policy if exists "Admins can view webhook deliveries" on public.webhook_deliveries;
create policy "Admins can view webhook deliveries" on public.webhook_deliveries
  for select using (public.is_admin());

drop policy if exists "Admins can manage webhooks" on public.webhooks;
create policy "Admins can manage webhooks" on public.webhooks
  for all using (public.is_admin()) with check (public.is_admin());

-- ── الشارات ───────────────────────────────────────────────────────────────
drop policy if exists "badge_definitions_admin_write" on public.badge_definitions;
create policy "badge_definitions_admin_write" on public.badge_definitions
  for all using (public.is_platform_staff()) with check (public.is_platform_staff());

drop policy if exists "badge_definitions_select_active" on public.badge_definitions;
create policy "badge_definitions_select_active" on public.badge_definitions
  for select using ((is_active = true) or public.is_platform_staff());

drop policy if exists "customer_badges_select_own" on public.customer_badges;
create policy "customer_badges_select_own" on public.customer_badges
  for select using ((user_id = auth.uid()) or public.is_platform_staff());

-- ── إشعار أي مستخدم ───────────────────────────────────────────────────────
drop policy if exists "Staff can create notifications for any user" on public.notifications;
create policy "Staff can create notifications for any user" on public.notifications
  for insert with check (public.is_platform_staff());

-- ── حذف البروفايلات ───────────────────────────────────────────────────────
--
-- كانت: is_main_admin() OR (super_user_id = uid AND role <> 'super_user')
-- أي أن مالك الشركة يحذف **صف بروفايل** عضوه — وهذا لا يحذف حساب auth، فينتج
-- حساب قادر على الدخول بلا بروفايل. البديل الصحيح قطع العلاقة
-- (remove_company_member) لا الحذف.
drop policy if exists "profiles_delete_policy" on public.profiles;
create policy "profiles_delete_policy" on public.profiles
  for delete using (public.is_main_admin());


-- ============================================================================
-- 9) إزالة عضو = قطع العلاقة، لا حذف حساب
-- ============================================================================
create or replace function public.remove_company_member(p_member_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_owner uuid := auth.uid();
  v_removed int;
begin
  if v_owner is null then
    raise exception 'يجب تسجيل الدخول أولًا' using errcode = '42501';
  end if;

  if not public.can_manage_company_members() then
    raise exception 'إدارة الأعضاء متاحة لمدير الشركة ضمن اشتراك يشمل المستخدمين الفرعيين'
      using errcode = '42501';
  end if;

  if p_member_id = v_owner then
    raise exception 'لا يمكن إزالة مدير الشركة' using errcode = '42501';
  end if;

  -- شرط super_user_id = v_owner هو ما يمنع الـIDOR: لا إزالة لعضو في شركة
  -- أخرى مهما كان المعرّف المرسل. لا مُعامل هوية شركة هنا إطلاقًا.
  update public.profiles
     set super_user_id = null
   where id = p_member_id and super_user_id = v_owner;

  get diagnostics v_removed = row_count;
  if v_removed = 0 then
    raise exception 'هذا الحساب ليس عضوًا في شركتك' using errcode = '42501';
  end if;

  return jsonb_build_object('removed', true, 'member_id', p_member_id);
end;
$$;

revoke all on function public.remove_company_member(uuid) from public, anon;
grant execute on function public.remove_company_member(uuid) to authenticated;


-- ============================================================================
-- 10) company_members() — تعلن الدور الجديد صراحةً
-- ============================================================================
create or replace function public.company_members()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company_id uuid; v_owner_id uuid; v_members jsonb;
begin
  if auth.uid() is null then return null; end if;
  v_company_id := public.current_company_id();
  if v_company_id is null then return null; end if;

  select user_id into v_owner_id from public.companies where id = v_company_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id',           m.id,
           'name',         coalesce(m.full_name, m.username, m.email),
           'email',        m.email,
           'role',         m.role,
           'is_owner',     (m.id = v_owner_id),
           'is_me',        (m.id = auth.uid()),
           'created_at',   m.created_at
         ) order by (m.id = v_owner_id) desc, m.created_at), '[]'::jsonb)
    into v_members
    from public.profiles m
   where m.id = v_owner_id or m.super_user_id = v_owner_id;

  return jsonb_build_object(
    'company_id',   v_company_id,
    'company_role', public.company_role(),          -- company_admin | company_user
    'is_owner',     (v_owner_id = auth.uid()),
    'can_manage',   public.can_manage_company_members(),
    'members',      v_members);
end;
$$;

revoke all on function public.company_members() from public, anon;
grant execute on function public.company_members() to authenticated;


-- ============================================================================
-- 11) تحقّق ذاتي — يفشل الترحيل بدل أن ينجح ناقصًا
-- ============================================================================
do $$
declare
  v_left text;
  v_admins int;
  v_orphan int;
begin
  -- ① لا سياسة واحدة تبقى تمنح سلطة للرتبة المتقاعدة
  select string_agg(c.relname || '.' || p.polname, ', ')
    into v_left
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and (coalesce(pg_get_expr(p.polqual, p.polrelid), '')
        || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) ~ '''super_user''';
  if v_left is not null then
    raise exception 'ما زالت سياسات تمنح سلطة للرتبة المتقاعدة: %', v_left;
  end if;

  -- ② لا دالة تفويض تبقى تمنح سلطة للرتبة المتقاعدة
  select string_agg(p.proname, ', ')
    into v_left
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('is_platform_staff','is_admin','is_support_user','wf_is_staff',
                       'is_chat_engine_staff','is_landing_admin','has_chatbot_entitlement',
                       'run_data_retention_cleanup')
     and pg_get_functiondef(p.oid) like '%super_user%';
  if v_left is not null then
    raise exception 'دوال تفويض ما زالت تذكر الرتبة المتقاعدة: %', v_left;
  end if;

  -- ③ الفصل الصارم: is_platform_staff لا تذكر أي دور شركة
  if pg_get_functiondef('public.is_platform_staff()'::regprocedure) ~ 'company_(admin|user)' then
    raise exception 'is_platform_staff تشمل دور شركة — الفصل الأمني مكسور';
  end if;

  -- ④ لا حساب يحمل الرتبة المتقاعدة بعد اليوم
  select count(*) into v_admins from public.profiles where role = 'super_user';
  if v_admins > 0 then
    raise exception 'بقي % حسابًا على الرتبة المتقاعدة', v_admins;
  end if;

  -- ⑤ كل مالك شركة صار company_admin (ما لم يكن طاقمًا)
  select count(*) into v_orphan
    from public.profiles p
   where exists (select 1 from public.companies c where c.user_id = p.id)
     and coalesce(p.role,'') not in ('company_admin','platform_owner','admin','support');
  if v_orphan > 0 then
    raise exception '% مالك شركة بلا دور company_admin', v_orphan;
  end if;

  -- ⑥ لا دور شركة بلا علاقة شركة (دور معلّق في الفراغ)
  select count(*) into v_orphan
    from public.profiles p
   where p.role = 'company_admin'
     and not exists (select 1 from public.companies c where c.user_id = p.id);
  if v_orphan > 0 then
    raise exception '% حساب يحمل company_admin بلا شركة', v_orphan;
  end if;

  select count(*) into v_orphan
    from public.profiles p
   where p.role = 'company_user'
     and not exists (select 1 from public.companies c where c.user_id = p.super_user_id);
  if v_orphan > 0 then
    raise exception '% حساب يحمل company_user بلا شركة', v_orphan;
  end if;

  -- ⑦ emp_ops منفصل بنيويًا: دالته لا تقرأ public.profiles إطلاقًا
  if to_regprocedure('emp_ops.is_admin()') is not null
     and pg_get_functiondef('emp_ops.is_admin()'::regprocedure) like '%public.profiles%' then
    raise exception 'emp_ops.is_admin صارت تقرأ profiles — نطاقا السلطة اختلطا';
  end if;

  -- ⑧ الرتبة لم تعد تُكتب من دورة الاشتراك
  if pg_get_functiondef('public.recompute_user_access(uuid)'::regprocedure) ~ 'set\s+role'
     or pg_get_functiondef('public.expire_stale_subscriptions()'::regprocedure) ~ 'set\s+role' then
    raise exception 'دورة الاشتراك ما زالت تكتب الرتبة — الترحيل سيُنقَض خلال ساعة';
  end if;

  raise notice 'OK 035: أدوار الشركة رسمية، وسلطة المنصة منزوعة عنها، والرتبة مفصولة عن الاشتراك';
end $$;


-- ============================================================================
-- 12) تقرير ما بعد التطبيق
-- ============================================================================
do $$
declare r record;
begin
  raise notice '── توزيع الأدوار بعد الترحيل ──';
  for r in select role, count(*) as n from public.profiles group by role order by n desc
  loop
    raise notice '   %  →  %', coalesce(r.role,'<null>'), r.n;
  end loop;
end $$;
