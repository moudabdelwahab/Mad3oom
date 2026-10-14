-- ============================================================================
-- التراجع عن 096_company_memberships — يعيد نصوص الدوال كما كانت بعد 095 حرفيًا
-- (current_company_id بنهايات CRLF كما على الإنتاج) ويحذف كائنات 096.
--
-- حماية البيانات: يرفض التراجع إن وُجدت عضوية إضافية نشطة أو دعوة — هذه لا تمثّلها
-- المرآة super_user_id وحدها، فحذفها يضيع علاقات قائمة. العضويات الأساسية تُستعاد من
-- super_user_id كما كانت قبل 096 (المرآة مطابقة لها دائمًا).
-- ============================================================================
do $$
begin
  if to_regclass('public.company_memberships') is not null and (
       exists (select 1 from public.company_memberships where status = 'active' and not is_primary)
       or exists (select 1 from public.company_membership_invitations)) then
    raise exception 'التراجع عن 096 مرفوض: توجد عضويات إضافية أو دعوات — أنهِها أو صدّرها أولًا';
  end if;
end $$;

drop trigger if exists trg_membership_mirror on public.profiles;

-- public.current_company_id(): النص على الإنتاج بنهايات CRLF — يُعاد حرفيًا
do $rb$
begin
  execute replace($rbsrc$CREATE OR REPLACE FUNCTION public.current_company_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select c.id
    from public.companies c
   where auth.uid() is not null
     and (
       c.user_id = auth.uid()
       or c.user_id = (select p.super_user_id from public.profiles p where p.id = auth.uid())
     )
   -- المالك أولًا لو حصل تداخل نظري بين الحالتين
   order by (c.user_id = auth.uid()) desc
   limit 1;
$function$
$rbsrc$, E'\n', E'\r\n');
end $rb$;

-- public.my_account_kind()
CREATE OR REPLACE FUNCTION public.my_account_kind()
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid  uuid := auth.uid();
  v_role text;
  v_company uuid;
begin
  if v_uid is null then
    return 'anonymous';
  end if;
  if coalesce(public.is_platform_owner(), false) then
    return 'platform_owner';
  end if;
  select p.role into v_role from public.profiles p where p.id = v_uid;
  if v_role in ('admin', 'support') then
    return 'platform_staff';
  end if;
  if public.owns_a_company(v_uid) then
    return 'company_admin';
  end if;
  v_company := public.company_of(v_uid);
  if v_company is not null then
    if public._company_staff_role_of(v_company, v_uid) in ('supervisor', 'agent') then
      return 'company_employee';
    end if;
    return 'company_customer';
  end if;
  return 'independent';
end $function$
;

-- public.my_company_portal()
CREATE OR REPLACE FUNCTION public.my_company_portal()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid     uuid := auth.uid();
  v_kind    text;
  v_preview boolean;
  v_company public.companies%rowtype;
begin
  if v_uid is null then
    return null;
  end if;
  v_kind := public.my_account_kind();
  v_preview := coalesce(public.preview_mode(), false);
  if not (v_kind = 'company_customer' or (v_kind = 'platform_owner' and v_preview)) then
    return null;
  end if;
  select * into v_company from public.companies c where c.id = public.company_of(v_uid);
  if v_company.id is null then
    return null;
  end if;
  return jsonb_build_object(
    'company', jsonb_build_object('id', v_company.id, 'name', v_company.company_name),
    'preview', v_preview);
end $function$
;

-- public.company_members()
CREATE OR REPLACE FUNCTION public.company_members()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- 085_company_members_privacy: القائمة الكاملة لمدير الشركة وحده.
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
    -- نفس مخرَج ما قبل 085 حرفيًا
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
$function$
;

-- public.remove_company_member(uuid)
CREATE OR REPLACE FUNCTION public.remove_company_member(p_member_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_owner uuid := auth.uid(); v_removed int;
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
  update public.profiles set super_user_id = null
   where id = p_member_id and super_user_id = v_owner;
  get diagnostics v_removed = row_count;
  if v_removed = 0 then
    raise exception 'هذا الحساب ليس عضوًا في شركتك' using errcode = '42501';
  end if;
  return jsonb_build_object('removed', true, 'member_id', p_member_id);
end;
$function$
;

-- public.check_super_user_creation()
CREATE OR REPLACE FUNCTION public.check_super_user_creation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.super_user_id is distinct from new.super_user_id then
    if new.super_user_id is null and old.super_user_id = auth.uid() then
      return new;
    end if;
    if not public.is_main_admin() then
      raise exception 'لا يمكن تغيير تبعية المستخدم إلا بواسطة الإدارة العليا' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$function$
;

-- public._ihub_guard_customer_link()
CREATE OR REPLACE FUNCTION public._ihub_guard_customer_link()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if tg_op = 'INSERT' then
    if new.unlinked_at is not null then
      raise exception 'لا يُدرَج ربط ملغى' using errcode = '23514';
    end if;
    if not exists (select 1 from public.ihub_connections ic
                     join public.companies c on c.id = ic.company_id
                     join public.profiles p on p.super_user_id = c.user_id
                    where ic.id = new.connection_id and ic.company_id = new.company_id
                      and p.id = new.customer_id and p.id <> c.user_id) then
      raise exception 'العميل ليس من عملاء شركة هذا الربط' using errcode = '23514';
    end if;
    return new;
  end if;
  if old.unlinked_at is not null then
    raise exception 'الربط الملغى سجل ثابت' using errcode = '23514';
  end if;
  if new.id <> old.id or new.company_id <> old.company_id or new.connection_id <> old.connection_id
     or new.customer_id <> old.customer_id or new.external_customer_id <> old.external_customer_id then
    raise exception 'هوية الربط لا تتغير' using errcode = '23514';
  end if;
  return new;
end $function$
;

-- public.ihub_customer_link(uuid,uuid,text)
CREATE OR REPLACE FUNCTION public.ihub_customer_link(p_connection uuid, p_customer uuid, p_external_customer_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company uuid;
  r         public.ihub_connections;
  v_ext     text := btrim(coalesce(p_external_customer_id, ''));
  l         public.ihub_customer_links;
begin
  v_company := public._ihub_require_admin();
  r := public._ihub_my_connection(p_connection, v_company);
  if r.provider not in ('woocommerce', 'salla', 'daftra') then
    raise exception 'هذا المزوّد لا يدعم ربط العملاء' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  if v_ext !~ '^[A-Za-z0-9_-]{1,120}$' then
    raise exception 'معرّف العميل الخارجي غير صالح' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  -- نفس الخطأ للحساب الغريب وغير الموجود
  if not exists (select 1 from public.profiles p join public.companies c on c.user_id = p.super_user_id
                  where p.id = p_customer and c.id = v_company and p.id <> c.user_id) then
    raise exception 'هذا الحساب ليس من عملاء شركتك' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  begin
    insert into public.ihub_customer_links (company_id, connection_id, customer_id, external_customer_id, linked_by)
    values (v_company, r.id, p_customer, v_ext, auth.uid())
    returning * into l;
  exception when unique_violation then
    raise exception 'العميل أو المعرّف الخارجي مربوط بالفعل في هذا الربط — ألغِ الربط القائم أولًا'
      using errcode = '23505', detail = '{"code":"already_linked"}';
  end;
  perform public._ihub_audit(v_company, r.id, 'user', 'customer.linked',
                                    jsonb_build_object('customer_id', p_customer));
  return jsonb_build_object('link_id', l.id, 'linked', true);
end $function$
;

-- public.ihub_intake_convert(uuid,uuid)
CREATE OR REPLACE FUNCTION public.ihub_intake_convert(p_intake uuid, p_customer uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company uuid;
  i         public.ihub_intake_requests;
  v_ticket  uuid;
  v_number  text;
begin
  v_company := public._ihub_require_admin();
  select * into i from public.ihub_intake_requests
   where id = p_intake and company_id = v_company and status = 'new'
   for update;
  if not found then
    raise exception 'الطلب غير موجود أو تمت معالجته' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  if not exists (select 1 from public.profiles p join public.companies c on c.user_id = p.super_user_id
                  where p.id = p_customer and c.id = v_company and p.id <> c.user_id) then
    raise exception 'هذا الحساب ليس من عملاء شركتك' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  if not coalesce(public._inbox_account_active(p_customer), false) then
    raise exception 'حساب العميل غير مفعّل أو محظور' using errcode = '22023',
      detail = '{"code":"validation_failed","reason":"customer_inactive"}';
  end if;

  insert into public.tickets (user_id, title, description, priority, ticket_type, category, contact_info)
  values (p_customer, i.subject,
          i.message || E'\n\n— ورد عبر نموذج الدعم في موقع الشركة (ووردبريس).',
          'medium', 'problem', null, null)
  returning id, ticket_number::text into v_ticket, v_number;

  update public.ihub_intake_requests
     set status = 'converted', ticket_id = v_ticket, decided_by = auth.uid(), decided_at = now()
   where id = i.id;
  perform public._ihub_audit(v_company, i.connection_id, 'user', 'intake.converted',
                                    jsonb_build_object('intake_id', i.id, 'ticket_id', v_ticket));
  return jsonb_build_object('ticket_id', v_ticket, 'ticket_number', v_number,
                            'external_order_ref', i.external_order_ref);
end $function$
;

drop function if exists public.membership_mirror_drift();
drop function if exists public.set_primary_company(uuid);
drop function if exists public.leave_company(uuid);
drop function if exists public.my_company_memberships();
drop function if exists public.enter_customer_company(uuid);
drop function if exists public.company_invitation_respond(uuid, boolean);
drop function if exists public.my_company_invitations();
drop function if exists public.company_invitation_cancel(uuid);
drop function if exists public.company_invitations_list();
drop function if exists public.company_invite_customer(text);
drop function if exists public._membership_require_multi();
drop function if exists public.company_customers_list();
drop function if exists public._company_member_active(uuid, uuid);
drop function if exists public._company_customer_active(uuid, uuid);
drop function if exists public._membership_on_profile_link();
drop function if exists public._membership_end(uuid, text);
drop function if exists public._membership_apply_mirror(uuid);
drop function if exists public._membership_event(uuid, uuid, text, jsonb);
drop function if exists public.owner_feature_switches();
drop function if exists public.owner_set_feature_switch(text, boolean, text);

drop table if exists public.company_membership_events;
drop table if exists public.customer_company_context;
drop table if exists public.company_membership_invitations;
drop table if exists public.company_memberships;
drop function if exists public._company_membership_events_append_only();
drop function if exists public._company_memberships_guard();

-- مفاتيح التفعيل يشترك فيها ما بعد 096؛ تُحذف فقط إن لم يبقَ غير مفتاح 096
do $$
begin
  if to_regclass('public.platform_feature_switches') is not null
     and not exists (select 1 from public.platform_feature_switches where key <> 'multi_company_memberships_enabled') then
    drop table public.platform_feature_switches;
    drop function if exists public._feature_on(text);
  elsif to_regclass('public.platform_feature_switches') is not null then
    delete from public.platform_feature_switches where key = 'multi_company_memberships_enabled';
  end if;
end $$;
