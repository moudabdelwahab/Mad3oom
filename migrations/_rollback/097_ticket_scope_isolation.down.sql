-- ============================================================================
-- التراجع عن 097_ticket_scope_isolation — يعيد 6 دوال و7 محفّزات كما كانت بعد 096 حرفيًا
-- ويحذف نطاق التذاكر وسياسات العزل وطلبات الوصول ومنحه.
--
-- حماية البيانات: يرفض التراجع إن كان مفتاح من مفاتيح 097 مفعّلًا، أو وُجد أي طلب وصول أو
-- منحة أو سطر في سجل الوصول (سجل إلحاقي لا يُحذف بتراجع)، أو تذكرة شركة لا تمثّلها قاعدة ما قبل
-- 097 (شركتها ليست الأساسية الحالية لصاحبها) — حذف ختمها يضيع لمن تعود.
-- ============================================================================
do $$
begin
  if exists (select 1 from public.platform_feature_switches
              where key in ('company_isolation_enforced', 'data_access_grants_enabled') and enabled) then
    raise exception 'التراجع عن 097 مرفوض: مفتاح العزل أو الوصول مفعّل — أطفئه أولًا';
  end if;
  if to_regclass('public.data_access_requests') is not null and (
       exists (select 1 from public.data_access_requests) or exists (select 1 from public.data_access_grants)
       or exists (select 1 from public.company_access_audit)) then
    raise exception 'التراجع عن 097 مرفوض: توجد طلبات وصول أو منح أو سجل وصول — سجل إلحاقي لا يُحذف';
  end if;
  if exists (select 1 from public.tickets t
              where t.scope = 'company'
                and t.company_id is distinct from (select m.company_id from public.company_memberships m
                                                    where m.user_id = t.user_id and m.status = 'active' and m.is_primary)) then
    raise exception 'التراجع عن 097 مرفوض: تذاكر شركات لا تمثّلها قاعدة ما قبل 097 (ليست شركة صاحبها الأساسية)';
  end if;
end $$;

-- الطلبات والمنح والسجل والقواعد
drop function if exists public.request_data_access(uuid, uuid, text, integer);
drop function if exists public.owner_decide_access_request(uuid, boolean, text, integer);
drop function if exists public.cancel_data_access_request(uuid);
drop function if exists public.revoke_data_access_grant(uuid, text);
drop function if exists public.my_data_access();
drop function if exists public.owner_access_requests();
drop function if exists public.granted_company_tickets(uuid);
drop function if exists public.granted_ticket_view(uuid, uuid);
drop function if exists public.company_access_log();
drop function if exists public.owner_set_access_requester_rule(text, boolean, integer, text);
drop function if exists public._access_audit(uuid, text, uuid, uuid, uuid, jsonb);
drop function if exists public._access_requester_kind(uuid);
drop function if exists public._access_require_enabled();
drop function if exists public._access_grant_active(uuid);
drop table if exists public.company_access_audit;
drop table if exists public.data_access_grants;
drop table if exists public.data_access_requests;
drop table if exists public.access_requester_rules;
drop function if exists public._access_audit_append_only();
drop function if exists public._access_grant_guard();
drop function if exists public.mcp_ticket_tenancy(uuid);

-- السياسات
drop policy if exists tenant_isolation on public.tickets;
drop policy if exists tenant_isolation on public.ticket_replies;
drop policy if exists tenant_isolation on public.ticket_attachments;
drop policy if exists tenant_isolation on public.ticket_activity;
drop policy if exists tenant_isolation on public.ticket_ratings;
drop policy if exists tenant_isolation on public.ticket_tag_links;
drop policy if exists internal_reply_attachments on public.ticket_attachments;
drop policy if exists ticket_files_isolation on storage.objects;

-- المحفّزات كما كانت (بلا شرط WHEN)
drop trigger if exists ticket_notification_trigger on public.tickets;
CREATE TRIGGER ticket_notification_trigger AFTER INSERT ON public.tickets FOR EACH ROW EXECUTE FUNCTION public.notify_all_admins_on_ticket();
drop trigger if exists tr_on_new_ticket on public.tickets;
CREATE TRIGGER tr_on_new_ticket AFTER INSERT ON public.tickets FOR EACH ROW EXECUTE FUNCTION public.notify_admin_on_new_ticket();
drop trigger if exists trg_notify_urgent_ticket on public.tickets;
CREATE TRIGGER trg_notify_urgent_ticket AFTER INSERT ON public.tickets FOR EACH ROW EXECUTE FUNCTION public.notify_admins_on_urgent_ticket();
drop trigger if exists trg_notify_support_on_ticket_rejected on public.tickets;
CREATE TRIGGER trg_notify_support_on_ticket_rejected AFTER UPDATE ON public.tickets FOR EACH ROW EXECUTE FUNCTION public.notify_support_on_ticket_rejected();
drop trigger if exists trg_assign_ticket_round_robin on public.tickets;
CREATE TRIGGER trg_assign_ticket_round_robin BEFORE INSERT ON public.tickets FOR EACH ROW EXECUTE FUNCTION public.assign_ticket_round_robin();
drop trigger if exists trg_dispatch_ticket_webhooks on public.tickets;
CREATE TRIGGER trg_dispatch_ticket_webhooks AFTER INSERT OR UPDATE ON public.tickets FOR EACH ROW EXECUTE FUNCTION public.dispatch_ticket_webhooks();
drop trigger if exists trg_dispatch_workflow_on_ticket_created on public.tickets;
CREATE TRIGGER trg_dispatch_workflow_on_ticket_created AFTER INSERT ON public.tickets FOR EACH ROW EXECUTE FUNCTION public.dispatch_workflow_on_ticket_created();

-- الدوال كما كانت بعد 096 حرفيًا
-- public.check_sla_breaches()
CREATE OR REPLACE FUNCTION public.check_sla_breaches()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      WHERE first_response_at IS NULL AND sla_alert_sent = false AND status = 'open'
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
$function$;

-- public.wf_assign_ticket(uuid,uuid,uuid)
CREATE OR REPLACE FUNCTION public.wf_assign_ticket(p_ticket_id uuid, p_assigned_to uuid, p_run_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM set_config('app.bypass_ticket_restrictions', 'on', true);
  UPDATE public.tickets SET assigned_to = p_assigned_to WHERE id = p_ticket_id;
  INSERT INTO public.ticket_activity (ticket_id, action_type, to_value, meta)
  VALUES (p_ticket_id, 'assigned', p_assigned_to::text, jsonb_build_object('source','workflow_run','run_id', p_run_id));
END;
$function$;

-- public.wf_update_ticket_status(uuid,text,uuid)
CREATE OR REPLACE FUNCTION public.wf_update_ticket_status(p_ticket_id uuid, p_new_status text, p_run_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM set_config('app.bypass_ticket_restrictions', 'on', true);
  UPDATE public.tickets SET status = p_new_status, last_updated_at = now() WHERE id = p_ticket_id;
  INSERT INTO public.ticket_activity (ticket_id, action_type, to_value, meta)
  VALUES (p_ticket_id, 'status_change', p_new_status, jsonb_build_object('source','workflow_run','run_id', p_run_id));
END;
$function$;

-- public.mcp_admin_update_ticket(uuid,uuid,jsonb)
CREATE OR REPLACE FUNCTION public.mcp_admin_update_ticket(p_ticket_id uuid, p_actor_id uuid, p_updates jsonb)
 RETURNS tickets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.tickets;
  v_key text;
  v_set_parts text[] := ARRAY[]::text[];
  v_allowed_columns text[] := ARRAY[
    'title', 'description', 'status', 'priority', 'category', 'ticket_type',
    'contact_info', 'image_url', 'assigned_to', 'archived_by_customer',
    'last_updated_by', 'last_updated_at', 'resolved_at', 'first_response_at',
    'sla_alert_sent'
  ];
BEGIN
  IF NOT public.is_admin_user(auth.uid()) THEN
    RAISE EXCEPTION 'ليس لديك صلاحية تعديل هذه التذكرة' USING ERRCODE = '42501';
  END IF;

  IF p_ticket_id IS NULL THEN
    RAISE EXCEPTION 'ticket_id مطلوب' USING ERRCODE = '22023';
  END IF;

  IF p_updates IS NULL OR p_updates = '{}'::jsonb THEN
    RAISE EXCEPTION 'لا يوجد تعديلات لتطبيقها' USING ERRCODE = '22023';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_updates) LOOP
    IF NOT (v_key = ANY(v_allowed_columns)) THEN
      RAISE EXCEPTION 'عمود غير مسموح بتعديله عبر هذه الدالة: %', v_key USING ERRCODE = '42501';
    END IF;
    v_set_parts := v_set_parts || format('%I = %L', v_key, p_updates->>v_key);
  END LOOP;

  PERFORM set_config('app.bypass_ticket_restrictions', 'on', true);

  EXECUTE format(
    'UPDATE public.tickets SET %s WHERE id = %L RETURNING *',
    array_to_string(v_set_parts, ', '), p_ticket_id
  ) INTO v_row;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'التذكرة غير موجودة' USING ERRCODE = 'P0002';
  END IF;

  RETURN v_row;
END;
$function$;

-- public._ihub_ticket_company(uuid)
CREATE OR REPLACE FUNCTION public._ihub_ticket_company(p_ticket uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select c.id
    from public.tickets t
    join public.profiles p on p.id = t.user_id
    join public.companies c on c.user_id = p.super_user_id
   where t.id = p_ticket
     and p.id <> c.user_id;
$function$;

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
  -- 096: عميل نشط للشركة (لا موظف)
  if not public._company_customer_active(v_company, p_customer) then
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
end $function$;


-- نطاق التذاكر
drop trigger if exists a_ticket_scope_stamp on public.tickets;
drop function if exists public._ticket_scope_stamp();
drop function if exists public._ticket_object_allowed(text);
drop function if exists public._attachment_reply_public(uuid);
drop function if exists public._ticket_private_to_company(uuid);
drop function if exists public._ticket_id_visible(uuid);
drop function if exists public._ticket_row_visible(uuid, text, uuid);
drop function if exists public._ticket_customer_company(uuid);
drop index if exists public.tickets_company_scope_idx;
alter table public.tickets drop constraint if exists tickets_scope_company_iff;
alter table public.tickets drop constraint if exists tickets_scope_check;
alter table public.tickets drop column if exists scope;
alter table public.tickets drop column if exists company_id;

-- المفاتيح
drop function if exists public._isolation_on();
delete from public.platform_feature_switches where key in ('company_isolation_enforced', 'data_access_grants_enabled');
