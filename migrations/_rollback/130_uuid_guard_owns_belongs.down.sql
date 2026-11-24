-- تراجع 130: إعادة تعريف owns_a_company() وbelongs_to_a_company() كما كانا في 035 حرفيًا،
-- وإعادة المستدعين الخمسة إلى الاستدعاء العام، وحذف الداخليتين.
-- تحذير: هذا يعيد الثغرة (أي مستخدم موثَّق يسأل عن علاقة شركة أي مستخدم)؛
-- يُستعمل فقط إن تقرر التراجع الطارئ عن 130، مع العلم أن البديل الآمن
-- هو إبقاء 130 وإصلاح المستدعِي المنكسر بدل إعادة الثغرة.
drop function if exists public._owns_a_company(uuid);
drop function if exists public._belongs_to_a_company(uuid);

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


-- إعادة المستدعين الخمسة إلى أجسامهم الأصلية حرفيًا.
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

create or replace function public.guard_profile_role_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.role is not distinct from old.role then
    return new;
  end if;
  if auth.uid() is null then
    return new;
  end if;
  if exists (select 1 from public.platform_authority a
              where a.user_id = new.id and a.level = 'owner') then
    raise exception 'رتبة مالك المنصة ثابتة ولا تُغيَّر من جلسة'
      using errcode = '42501';
  end if;
  if auth.uid() = new.id then
    raise exception 'لا يمكنك تغيير صلاحية حسابك بنفسك' using errcode = '42501';
  end if;
  if new.role = 'platform_owner' then
    raise exception 'رتبة مالك المنصة لا تُمنح من أي جلسة' using errcode = '42501';
  end if;
  if new.role in ('company_admin', 'company_user') then
    if pg_trigger_depth() > 1
       and new.role = (case
                         when public.owns_a_company(new.id)       then 'company_admin'
                         when public.belongs_to_a_company(new.id) then 'company_user'
                       end) then
      return new;
    end if;
    raise exception 'أدوار الشركة تُشتق من العلاقة بالشركة ولا تُمنَح يدويًا'
      using errcode = '42501';
  end if;
  if new.role = 'admin' or old.role = 'admin'
     or exists (select 1 from public.platform_authority a where a.user_id = new.id) then
    if public.owner_critical_ok() then return new; end if;
    raise exception 'منح رتبة الإدارة أو سحبها لمالك المنصة وحده بعد التحقق بخطوتين'
      using errcode = '42501';
  end if;
  if new.role = 'support' or old.role = 'support' then
    if public.owner_critical_ok() or public.has_capability('staff.support') then
      return new;
    end if;
    raise exception 'إدارة فريق الدعم تتطلب تفويضًا من مالك المنصة' using errcode = '42501';
  end if;
  if not public.is_admin() then
    raise exception 'تغيير الرتب متاح للإدارة فقط' using errcode = '42501';
  end if;
  return new;
end;
$function$;

revoke all on function public.guard_profile_role_change() from public, anon, authenticated;

create or replace function public.company_invite_customer(p_email text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_company uuid;
  v_email   text := lower(btrim(coalesce(p_email, '')));
  v_invitee uuid;
  v_inv     uuid;
  v_name    text;
begin
  perform public._membership_require_multi();
  v_company := public._company_staff_require_manager();
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or char_length(v_email) > 320 then
    raise exception 'بريد إلكتروني غير صالح' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  if (select count(*) from public.company_membership_invitations
       where company_id = v_company and status = 'pending') >= 200 then
    raise exception 'دعوات معلّقة كثيرة — ألغِ بعضها أولًا' using errcode = '54000';
  end if;
  -- 112: الدعوة المعلّقة نفسها للبريد نفسه (لا صف ثانٍ؛ إعادة الإرسال تمر بها)
  select id into v_inv from public.company_membership_invitations
   where company_id = v_company and lower(invited_email) = v_email and status = 'pending'
     and expires_at > now();
  if v_inv is not null then
    return jsonb_build_object('status', 'pending', 'invitation_id', v_inv, 'existing', true);
  end if;
  -- معلّقة منتهية: تُغلق فتُفسح للفهرس الفريد دعوة جديدة
  update public.company_membership_invitations set status = 'expired', responded_at = now()
   where company_id = v_company and lower(invited_email) = v_email and status = 'pending' and expires_at <= now();

  select p.id into v_invitee from public.profiles p
   where lower(p.email) = v_email
     and coalesce(p.role, '') not in ('platform_owner', 'admin', 'support')
     and not public.owns_a_company(p.id)
     and not public._company_member_active(v_company, p.id)
   limit 1;

  insert into public.company_membership_invitations (company_id, invited_email, invitee_user_id, invited_by)
  values (v_company, v_email, v_invitee, auth.uid())
  returning id into v_inv;

  if v_invitee is not null then
    select company_name into v_name from public.companies where id = v_company;
    perform public._membership_event(v_company, v_invitee, 'invited', jsonb_build_object('invitation_id', v_inv));
    insert into public.notifications (user_id, title, message, type, link, category)
    values (v_invitee, 'دعوة للانضمام إلى شركة',
            'دعتك شركة «' || coalesce(v_name, '') || '» لتكون من عملائها. راجع الدعوة في بوابة العملاء.',
            'info', '/portal/#invitations', 'account');
  end if;
  return jsonb_build_object('status', 'pending', 'invitation_id', v_inv, 'existing', false);
end
$function$;

revoke all on function public.company_invite_customer(text) from public, anon;
grant execute on function public.company_invite_customer(text) to authenticated;

create or replace function public._hierarchy_eligible(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_user is not null
     and exists (select 1 from public.profiles p where p.id = p_user and p.role in ('admin', 'support')
                   and coalesce(p.ban_status, 'none') = 'none')
     and not coalesce(public.owns_a_company(p_user), false)
     and not exists (select 1 from public.company_memberships m where m.user_id = p_user and m.status = 'active')
     and not exists (select 1 from public.company_staff s where s.user_id = p_user and s.revoked_at is null);
$$;

