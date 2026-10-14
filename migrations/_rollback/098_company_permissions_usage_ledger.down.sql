-- ============================================================================
-- التراجع عن 098_company_permissions_usage_ledger — يعيد 3 دوال كما كانت بعد 097 حرفيًا ويحذف
-- صلاحيات الفريق وسياساته ودالتي الحالة والإسناد وسجل الاستهلاك وقواعد الفوترة.
--
-- حماية البيانات: يرفض التراجع إن كان المفتاح مفعّلًا، أو ضبطت شركة صلاحيات (إعداد لا يُستعاد)،
-- أو وُجد سجل تغيير صلاحيات (إلحاقي). سجل الاستهلاك ظلّ لا يفوتر شيئًا: يُحذف، ويُعاد بناؤه من
-- التذاكر عند إعادة التطبيق (عدا أثر التذاكر المحذوفة ونقل العملاء بين الشركات بعد التسجيل).
-- ============================================================================
do $$
begin
  if exists (select 1 from public.platform_feature_switches where key = 'company_permissions_enabled' and enabled) then
    raise exception 'التراجع عن 098 مرفوض: مفتاح صلاحيات الفريق مفعّل — أطفئه أولًا';
  end if;
  if to_regclass('public.company_permission_events') is not null and (
       exists (select 1 from public.company_permission_events) or exists (select 1 from public.company_role_permissions)
       or exists (select 1 from public.company_user_permissions)) then
    raise exception 'التراجع عن 098 مرفوض: توجد صلاحيات مضبوطة أو سجل تغييرها — صدّرها أولًا';
  end if;
end $$;

-- السجل والقواعد
drop trigger if exists trg_usage_on_ticket on public.tickets;
drop trigger if exists trg_usage_on_subscription_link on public.whatsapp_subscriptions;
drop function if exists public.usage_reconciliation(date);
drop function if exists public.usage_projection(integer, date);
drop function if exists public._usage_caller_ok();
drop function if exists public._usage_on_ticket();
drop function if exists public._usage_on_subscription_link();
drop function if exists public._usage_record_billing_link(uuid, text);
drop function if exists public._usage_record_ticket(public.tickets, text);
drop function if exists public._usage_period(timestamptz);
drop table if exists public.usage_ledger;
drop function if exists public._usage_ledger_append_only();
drop table if exists public.billing_rule_versions;

-- سياسات الفريق
drop policy if exists company_team_select on public.tickets;
drop policy if exists company_team_select on public.ticket_replies;
drop policy if exists company_team_insert on public.ticket_replies;
drop policy if exists company_team_select on public.ticket_attachments;
drop policy if exists company_team_insert on public.ticket_attachments;
drop policy if exists company_team_select on public.ticket_activity;
drop policy if exists company_team_select on public.ticket_ratings;
drop policy if exists company_team_ticket_files on storage.objects;
drop policy if exists company_team_ticket_upload on storage.objects;

-- الدوال كما كانت بعد 097 حرفيًا

-- public._attachment_reply_public(uuid)
CREATE OR REPLACE FUNCTION public._attachment_reply_public(p_reply uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_reply is null
      or not exists (select 1 from public.ticket_replies r where r.id = p_reply and coalesce(r.is_internal, false));
$function$;

-- public._ticket_object_allowed(text)
CREATE OR REPLACE FUNCTION public._ticket_object_allowed(p_name text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_ticket uuid;
begin
  if exists (select 1 from public.ticket_attachments a
               join public.ticket_replies r on r.id = a.reply_id
              where a.file_path = p_name and coalesce(r.is_internal, false))
     and not (coalesce(public.has_elevated_authority(), false) or coalesce(public.is_platform_staff(), false)) then
    return false;
  end if;
  if public._isolation_on() then
    v_ticket := public.storage_ticket_id(p_name);
    if v_ticket is not null and exists (select 1 from public.tickets t where t.id = v_ticket)
       and not public._ticket_id_visible(v_ticket) then
      return false;
    end if;
  end if;
  return true;
end $function$;

-- public.company_customers_list()
CREATE OR REPLACE FUNCTION public.company_customers_list()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company uuid;
  v_role    text := public.company_staff_role();
begin
  if v_role is null or v_role not in ('admin', 'supervisor') then
    return null;
  end if;
  v_company := public.current_company_id();
  return jsonb_build_object(
    'company_id', v_company,
    'can_manage', (v_role = 'admin' and coalesce(public.can_manage_company_members(), false)),
    'invitations_enabled', public._feature_on('multi_company_memberships_enabled'),
    'customers', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', p.id,
               'name', coalesce(p.full_name, p.username, 'عميل'),
               'email', p.email,
               'phone', p.phone,
               'joined_at', m.joined_at
             ) order by m.joined_at desc), '[]'::jsonb)
        from public.company_memberships m
        join public.profiles p on p.id = m.user_id
       where m.company_id = v_company and m.status = 'active'
         and public._company_staff_role_of(v_company, p.id) is null));
end $function$;


-- الصلاحيات
drop function if exists public.company_ticket_set_status(uuid, text);
drop function if exists public.company_ticket_assign(uuid, uuid);
drop function if exists public.company_tickets_list();
drop function if exists public.my_company_permissions();
drop function if exists public.company_permissions_matrix();
drop function if exists public.company_set_role_permission(text, text, boolean);
drop function if exists public.company_set_user_permission(uuid, text, boolean);
drop function if exists public._company_permissions_require_enabled();
drop function if exists public._company_reply_visible(uuid, uuid, boolean);
drop function if exists public._company_ticket_access(uuid, text);
drop function if exists public._company_ticket_row_access(uuid, uuid, text);
drop function if exists public._company_permissions_on();
drop function if exists public._company_perm(uuid, uuid, text);
drop table if exists public.company_permission_events;
drop table if exists public.company_user_permissions;
drop table if exists public.company_role_permissions;
drop table if exists public.company_permission_catalog;
drop function if exists public._company_permission_events_append_only();
delete from public.platform_feature_switches where key = 'company_permissions_enabled';
