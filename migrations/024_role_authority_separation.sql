-- 024_role_authority_separation.sql
-- إصلاح C2 + H4: فصل ثلاثة مفاهيم كانت مدمجة في عمود واحد.
-- ============================================================================
--
-- المشكلة الجذرية
--   عمود profiles.role كان يحمل ثلاثة معانٍ لا علاقة بينها في وقت واحد:
--     • هوية الحساب (عميل / إدارة)
--     • ملكية شركة        ← وهي علاقة، لا رتبة
--     • سلطة داخل المنصة  ← 22 سياسة RLS تعامل super_user كطاقم
--
--   ومن هذا الدمج جاءت C2 و H4 معًا:
--     C2 — من يحمل super_user يعدّل صفوف تابعيه بلا قيد أعمدة، فيرقّي عضوه
--          إلى admin ثم يدخل بحسابه (وهو من حدّد كلمة مروره).
--     H4 — والرتبة نفسها تُشتق من الاشتراك في الكود بينما القاعدة تشترط
--          الأدمن الرئيسي لإسنادها، فالإسناد يفشل دائمًا **والفشل مبتلَع**،
--          وميزة أعضاء الشركة لم تعمل قط (صفر صفوف في super_user_id).
--
-- التصميم المعتمد — ثلاثة محاور مستقلة، لا يُغني أحدها عن الآخر
--
--   ① الرتبة  (profiles.role)      → هوية الحساب وسلطته على مستوى المنصة
--        customer      عميل فرد
--        عضو الشركة    حساب مرتبط بشركة   ← **بلا أي سلطة على المنصة**
--        support       طاقم داخلي
--        admin         إدارة المنصة
--
--   ② علاقة الشركة (بيانات، لا رتبة)
--        Owner   : companies.user_id = uid            (قيد UNIQUE)
--        Member  : profiles.super_user_id = owner_uid
--        ← الملكية تُثبَت من companies.user_id وحدها، لا من الرتبة إطلاقًا.
--
--   ③ الامتيازات (الاشتراك)        → أي خدمات متاحة
--        whatsapp_subscriptions → plan_features → owned_feature_keys()
--
--   القاعدة الحاكمة: **الارتباط بشركة لا يعني admin بأي شكل، وشراء أي باقة لا
--   يمنح رتبة إطلاقًا.** الاشتراك يحدد الخدمات، والعلاقة تحدد صلاحيات الشركة،
--   والرتبة تحدد هوية الحساب وسلطته.
--
-- ملاحظة على اسم العمود super_user_id
--   احتُفظ به كما هو عمدًا. هو **علاقة** صحيحة (عضو ← مالك) ولا يحمل أي سلطة،
--   وإعادة تسميته تمس 10 دوال وسياسات لا علاقة لها بهذا الإصلاح. التسمية
--   الأنسب (company_owner_id) تُترك لترحيل تجميلي منفصل.
--
-- ما لا يفعله هذا الترحيل
--   لا يغيّر رتبة أي مستخدم قائم. إعادة تسمية الرتبة القديمة في ترحيل
--   البيانات 026 المنفصل، وهو موقوف على موافقة صريحة.

-- ============================================================================
-- 1) مفردات الهوية والسلطة
-- ============================================================================

-- طاقم المنصة = من له سلطة داخلية فعلية. عضو الشركة ليس منها بأي حال.
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
       and (role in ('admin', 'support')
            or email in ('support@mad3oom.online', 'info@mad3oom.online'))
  );
$$;

revoke all on function public.is_platform_staff() from public, anon;
grant execute on function public.is_platform_staff() to authenticated;

-- ============================================================================
-- 2) علاقة الشركة — تُثبَت من البيانات لا من الرتبة
-- ============================================================================

create or replace function public.is_company_owner()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  -- الملكية = صف في companies باسم هذا الحساب. لا شأن للرتبة بها.
  select exists (select 1 from public.companies c where c.user_id = auth.uid());
$$;

revoke all on function public.is_company_owner() from public, anon;
grant execute on function public.is_company_owner() to authenticated;

/**
 * موقع الحساب داخل شركته: 'owner' أو 'member' أو NULL.
 * مصدر واحد يستخدمه الخادم والواجهة، فلا يمكن أن يختلف الجوابان.
 */
create or replace function public.company_role()
returns text
language sql
stable
security definer
set search_path to 'public'
as $$
  select case
    when auth.uid() is null then null
    when exists (select 1 from public.companies c where c.user_id = auth.uid()) then 'owner'
    when exists (
      select 1 from public.profiles p
       join public.companies c on c.user_id = p.super_user_id
      where p.id = auth.uid()
    ) then 'member'
    else null
  end;
$$;

revoke all on function public.company_role() from public, anon;
grant execute on function public.company_role() to authenticated;

-- إدارة الأعضاء = ملكية شركة **و** امتياز sub_users من اشتراك فعّال.
-- لا رتبة في المعادلة إطلاقًا.
create or replace function public.can_manage_company_members()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.is_company_owner()
     and public.has_feature_access('sub_users', auth.uid());
$$;

revoke all on function public.can_manage_company_members() from public, anon;
grant execute on function public.can_manage_company_members() to authenticated;

-- ============================================================================
-- 3) C2 — حارس الرتب
-- ============================================================================

create or replace function public.guard_profile_role_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  -- المسار الشائع: الرتبة لم تُمس.
  if new.role is not distinct from old.role then
    return new;
  end if;

  -- لا auth.uid() = مفتاح خدمة أو وظيفة خلفية، لا مستخدمًا عبر الـAPI.
  if auth.uid() is null then
    return new;
  end if;

  -- تغيير رتبة النفس: غير مشروع على أي مسار، حتى للأدمن.
  if auth.uid() = new.id then
    raise exception 'لا يمكنك تغيير صلاحية حسابك بنفسك' using errcode = '42501';
  end if;

  -- C2: مالك الشركة ليس أدمن. ملكيته لصف تابعه تخوّله تعديل بياناته لا ترقيته.
  if not public.is_admin() then
    raise exception 'تغيير الرتب متاح للإدارة فقط' using errcode = '42501';
  end if;

  -- M2: الرتب ذات السلطة لا يمنحها أدمن عادي.
  -- رتبة العميل ليست منها — إدارتها متاحة لأي أدمن.
  if new.role in ('admin', 'support', 'super_user') and not public.is_main_admin() then
    raise exception 'منح رتبة % يتطلب الإدارة العليا', new.role using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.guard_profile_role_change() from public, anon, authenticated;

-- الرتبة القديمة super_user لم تعد تُسند لأحد جديد؛ والعلاقة تُحرَس كما كانت
-- مع استثناء واحد صريح: مالك الشركة يزيل عضوه عبر remove_company_member.
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

  if new.role = 'super_user' and not public.is_main_admin() then
    raise exception 'الرتبة super_user متوقفة؛ استعمل علاقة الشركة بدل الرتبة';
  end if;

  if tg_op = 'UPDATE' and old.super_user_id is distinct from new.super_user_id then
    -- إزالة عضو من شركة المنادي — المسار الشرعي الوحيد لغير الإدارة العليا.
    if new.super_user_id is null and old.super_user_id = auth.uid() then
      return new;
    end if;
    if not public.is_main_admin() then
      raise exception 'لا يمكن تغيير تبعية المستخدم إلا بواسطة الإدارة العليا';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.check_super_user_creation() from public, anon, authenticated;

-- ============================================================================
-- 4) H4 — الاشتراك يمنح امتيازات، لا رتبة
-- ============================================================================

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

  -- لا سطر واحد يمس role هنا، عمدًا. كان يحاول الترقية ويفشل صامتًا (H4)،
  -- والآن لم يعد مطلوبًا أصلًا لأن صلاحيات الشركة تأتي من العلاقة.
  return jsonb_build_object(
    'features',         to_jsonb(v_features),
    'whatsapp_enabled', v_whatsapp,
    'role',             (select role from public.profiles where id = p_user_id)
  );
end;
$$;

revoke all on function public.recompute_user_access(uuid) from public, anon, authenticated;

create or replace function public.admin_recompute_user_access(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not public.is_admin() then
    raise exception 'هذه العملية متاحة للإدارة فقط' using errcode = '42501';
  end if;
  return public.recompute_user_access(p_user_id);
end;
$$;

revoke all on function public.admin_recompute_user_access(uuid) from public, anon;
grant execute on function public.admin_recompute_user_access(uuid) to authenticated;

-- H3 — الوظيفة الدورية كانت تقرر الامتيازات بأسماء باقات مثبَّتة نصًّا
-- وتُنزّل الرتب. الآن تنتهي عند الحالة وتفوّض الحساب لمحرك الامتيازات.
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
    values (
      expired_row.user_id,
      'انتهى اشتراكك',
      'انتهت صلاحية اشتراكك. يمكنك التجديد من صفحة الاشتراكات.',
      'warning',
      '/customer-subscriptions.html'
    );
  end loop;

  perform public.recompute_user_access(p.id)
     from public.profiles p
    where p.whatsapp_enabled is true
      and not ('whatsapp_sender' = any(public.owned_feature_keys(p.id)));
end;
$$;

revoke all on function public.expire_stale_subscriptions() from public, anon, authenticated;

-- ============================================================================
-- 5) نزع السلطة عن الرتبة القديمة
-- ============================================================================

-- L1 أيضًا: كانت الدالة الوحيدة من 194 بلا search_path مثبت.
create or replace function public.is_chat_engine_staff()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.is_platform_staff();
$$;

revoke all on function public.is_chat_engine_staff() from public, anon;
grant execute on function public.is_chat_engine_staff() to authenticated;

-- M3: إرسال إشعار لأي مستخدم كان متاحًا لـsuper_user — أي لمالك شركة.
drop policy if exists "Staff can create notifications for any user" on public.notifications;
create policy "Staff can create notifications for any user" on public.notifications
  for insert with check (public.is_platform_staff());

-- ============================================================================
-- 6) M1 — امتيازات حساب آخر لا تُقرأ بمعرّف يرسله العميل
-- ============================================================================

create or replace function public.owned_feature_keys(p_user_id uuid default auth.uid())
returns text[]
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  -- auth.uid() فارغ = مفتاح خدمة أو وظيفة خلفية. غير ذلك: نفسك أو الإدارة.
  -- الإدارة مستثناة لأن admin_list_subscriptions تفرّع هذه الدالة على user_id
  -- لكل صف؛ بدون الاستثناء تظهر شاشة اشتراكات الإدارة فارغة تمامًا.
  if auth.uid() is not null
     and p_user_id is distinct from auth.uid()
     and not public.is_admin() then
    raise exception 'لا يمكنك قراءة امتيازات حساب آخر' using errcode = '42501';
  end if;

  return (
    select coalesce(array_agg(distinct pf.feature_key), '{}'::text[])
      from public.whatsapp_subscriptions s
      join public.subscription_plans sp on sp.key = s.plan
      join public.plan_features pf on pf.plan_id = sp.id and pf.enabled = true
     where s.user_id = p_user_id
       and s.status = 'active'
       and s.start_date <= now()
       and s.end_date   >  now()
  );
end;
$$;

revoke all on function public.owned_feature_keys(uuid) from public, anon;
grant execute on function public.owned_feature_keys(uuid) to authenticated;

create or replace function public.subscription_purchase_check(
  p_plan text, p_is_renewal boolean default false, p_user_id uuid default auth.uid()
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_offered text[]; v_owned text[]; v_missing text[]; v_same_active boolean;
begin
  if p_user_id is null then
    return jsonb_build_object('allowed', false, 'code', 'not_authenticated',
                              'reason', 'يجب تسجيل الدخول أولًا');
  end if;

  if auth.uid() is not null
     and p_user_id is distinct from auth.uid()
     and not public.is_admin() then
    raise exception 'لا يمكنك فحص اشتراك حساب آخر' using errcode = '42501';
  end if;

  if not exists (select 1 from public.subscription_plans where key = p_plan and is_active) then
    return jsonb_build_object('allowed', false, 'code', 'unknown_plan',
                              'reason', 'باقة غير معروفة أو غير مفعّلة');
  end if;

  v_offered := public.plan_feature_keys(p_plan);
  v_owned   := public.owned_feature_keys(p_user_id);

  select exists (
    select 1 from public.whatsapp_subscriptions s
     where s.user_id = p_user_id and s.plan = p_plan
       and s.status = 'active' and s.end_date > now()
  ) into v_same_active;

  if p_is_renewal and v_same_active then
    return jsonb_build_object('allowed', true, 'code', 'renewal', 'reason', 'تجديد اشتراك قائم');
  end if;

  if v_same_active then
    return jsonb_build_object('allowed', false, 'code', 'duplicate_plan',
      'reason', 'لديك اشتراك فعّال في هذه الباقة بالفعل. استخدم زر التجديد لتمديده.');
  end if;

  select coalesce(array_agg(f), '{}'::text[]) into v_missing
    from unnest(v_offered) f where not (f = any(v_owned));

  if array_length(v_missing, 1) is null then
    return jsonb_build_object('allowed', false, 'code', 'redundant',
      'reason', 'كل خدمات هذه الباقة متاحة لك بالفعل ضمن اشتراكك الحالي.',
      'owned_features', to_jsonb(v_owned));
  end if;

  return jsonb_build_object('allowed', true, 'code', 'adds_features',
    'reason', 'الباقة تضيف خدمات جديدة', 'new_features', to_jsonb(v_missing));
end;
$$;

revoke all on function public.subscription_purchase_check(text, boolean, uuid) from public, anon;
grant execute on function public.subscription_purchase_check(text, boolean, uuid) to authenticated;

-- ============================================================================
-- 7) H4 — المسار الشرعي لإدارة أعضاء الشركة
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
           'id', m.id,
           'name', coalesce(m.full_name, m.username, m.email),
           'email', m.email,
           'is_owner', (m.id = v_owner_id),
           'is_me', (m.id = auth.uid()),
           'created_at', m.created_at
         ) order by (m.id = v_owner_id) desc, m.created_at), '[]'::jsonb)
    into v_members
    from public.profiles m
   where m.id = v_owner_id or m.super_user_id = v_owner_id;

  return jsonb_build_object(
    'company_id',   v_company_id,
    'company_role', public.company_role(),   -- owner | member
    'is_owner',     (v_owner_id = auth.uid()),
    'can_manage',   public.can_manage_company_members(),
    'members',      v_members);
end;
$$;

revoke all on function public.company_members() from public, anon;
grant execute on function public.company_members() to authenticated;

-- إزالة عضو = قطع العلاقة فقط، لا حذف حساب.
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
    raise exception 'إدارة الأعضاء متاحة لمالك الشركة ضمن اشتراك يشمل المستخدمين الفرعيين'
      using errcode = '42501';
  end if;

  if p_member_id = v_owner then
    raise exception 'لا يمكن إزالة مالك الشركة' using errcode = '42501';
  end if;

  -- شرط super_user_id = v_owner هو ما يمنع الـIDOR: لا إزالة لعضو في شركة أخرى
  -- مهما كان المعرّف المرسل.
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

-- L8 — إتمام ما بدأه 022.
revoke all on function public.notify_admin_on_new_subscription() from public, anon, authenticated;
revoke all on function public.log_customer_sie_access_change() from public, anon, authenticated;
