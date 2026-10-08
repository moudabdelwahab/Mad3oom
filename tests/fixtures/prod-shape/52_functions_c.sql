CREATE OR REPLACE FUNCTION public.recalc_ticket_sla()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.priority IS DISTINCT FROM OLD.priority THEN
    NEW.sla_response_due_at := NEW.created_at + CASE NEW.priority
      WHEN 'high' THEN interval '4 hours'
      WHEN 'low' THEN interval '24 hours'
      ELSE interval '8 hours'
    END;
    NEW.sla_resolution_due_at := NEW.created_at + CASE NEW.priority
      WHEN 'high' THEN interval '8 hours'
      WHEN 'low' THEN interval '72 hours'
      ELSE interval '24 hours'
    END;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.recompute_user_access(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_features text[]; v_whatsapp boolean;
begin
  if p_user_id is null then return null; end if;
  v_features := public.owned_feature_keys(p_user_id);
  v_whatsapp := 'whatsapp_sender' = any(v_features);
  update public.profiles set whatsapp_enabled = v_whatsapp
   where id = p_user_id and whatsapp_enabled is distinct from v_whatsapp;
  return jsonb_build_object(
    'features', to_jsonb(v_features),
    'whatsapp_enabled', v_whatsapp,
    'role', (select role from public.profiles where id = p_user_id));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.record_accounting_invoice(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_settings   jsonb;
  v_base_url   text;
  v_existing   public.accounting_invoices;
  v_invoice    public.accounting_invoices;
  v_ticket_id  uuid;
  v_user_id    uuid;
begin
  if p_payload is null or p_payload->>'external_invoice_id' is null then
    raise exception 'external_invoice_id مطلوب';
  end if;

  select value into v_settings from public.advanced_settings where key = 'accounting_integration';
  v_base_url := coalesce(v_settings->>'public_invoice_base_url', 'https://mad3oom.com/invoice.html');

  select * into v_existing from public.accounting_invoices
   where external_invoice_id = (p_payload->>'external_invoice_id')::uuid;

  if found then
    return jsonb_build_object(
      'status',       'already_recorded',
      'invoice_id',   v_existing.id,
      'public_token', v_existing.public_token,
      'public_url',   v_base_url || '?t=' || v_existing.public_token,
      'reply_id',     v_existing.reply_id
    );
  end if;

  v_ticket_id := nullif(p_payload->>'ticket_id', '')::uuid;
  v_user_id   := nullif(p_payload->>'user_id', '')::uuid;

  if v_user_id is null and v_ticket_id is not null then
    select user_id into v_user_id from public.tickets where id = v_ticket_id;
  end if;

  insert into public.accounting_invoices (
    external_invoice_id, invoice_number, ticket_id, user_id, subscription_id,
    plan, billing_cycle, subtotal, tax_amount, total, currency,
    issue_date, due_date, status
  ) values (
    (p_payload->>'external_invoice_id')::uuid,
    coalesce(p_payload->>'invoice_number', '—'),
    v_ticket_id,
    v_user_id,
    nullif(p_payload->>'subscription_id', '')::uuid,
    p_payload->>'plan',
    p_payload->>'billing_cycle',
    coalesce((p_payload->>'subtotal')::numeric, 0),
    coalesce((p_payload->>'tax_amount')::numeric, 0),
    coalesce((p_payload->>'total')::numeric, 0),
    coalesce(p_payload->>'currency', 'USD'),
    nullif(p_payload->>'issue_date', '')::date,
    nullif(p_payload->>'due_date', '')::date,
    p_payload->>'status'
  ) returning * into v_invoice;

  return jsonb_build_object(
    'status',       'recorded',
    'invoice_id',   v_invoice.id,
    'public_token', v_invoice.public_token,
    'public_url',   v_base_url || '?t=' || v_invoice.public_token,
    'reply_id',     null
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.redeem_passcode(p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'لا توجد جلسة' using errcode = '42501';
  end if;

  if p_code is null or btrim(p_code) = '' then
    return jsonb_build_object('ok', false, 'reason', 'empty');
  end if;

  select c.id into v_id
    from public.access_passcodes c
   where c.is_active
     and c.code_hash = extensions.crypt(btrim(p_code), c.code_hash)
   limit 1;

  if v_id is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  insert into public.passcode_redemptions (user_id, passcode_id)
  values (auth.uid(), v_id)
  on conflict (user_id) do update
    set passcode_id = excluded.passcode_id, redeemed_at = now();

  return jsonb_build_object('ok', true);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.reject_reward_report(p_report_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_report public.user_reports;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin') THEN
        RAISE EXCEPTION 'غير مصرح: هذا الإجراء متاح للأدمن فقط';
    END IF;

    SELECT * INTO v_report FROM public.user_reports WHERE id = p_report_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'البلاغ غير موجود';
    END IF;
    IF v_report.status <> 'pending' THEN
        RAISE EXCEPTION 'تمت مراجعة هذا البلاغ بالفعل';
    END IF;

    UPDATE public.user_reports
        SET status = 'rejected', rejection_reason = p_reason, approved_at = now()
        WHERE id = p_report_id;

    UPDATE public.user_wallets
        SET pending_points = GREATEST(0, COALESCE(pending_points, 0) - COALESCE(v_report.estimated_points, 0)),
            updated_at = now()
        WHERE user_id = v_report.user_id;

    INSERT INTO public.reward_activity_logs (user_id, activity_type, details)
    VALUES (v_report.user_id, 'report_rejected', jsonb_build_object('reportId', p_report_id, 'reason', p_reason));

    RETURN jsonb_build_object('report_id', p_report_id, 'user_id', v_report.user_id);
END;
$function$
;

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

CREATE OR REPLACE FUNCTION public.reopen_ticket_in_my_scope(p_ticket_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_status text;
begin
  if auth.uid() is null then
    raise exception 'يجب تسجيل الدخول أولاً' using errcode = '42501';
  end if;

  if not public.ticket_in_my_scope(p_ticket_id) then
    raise exception 'التذكرة غير موجودة أو خارج نطاق حسابك' using errcode = '42501';
  end if;

  select t.status into v_status from public.tickets t where t.id = p_ticket_id;

  if v_status <> 'resolved' then
    raise exception 'لا يمكن إعادة فتح تذكرة حالتها %', coalesce(v_status, 'غير معروفة')
      using errcode = '22023';
  end if;

  perform set_config('app.bypass_ticket_restrictions', 'on', true);

  update public.tickets
     set status           = 'open',
         reopen_count     = coalesce(reopen_count, 0) + 1,
         last_reopened_at = now(),
         resolved_at      = null,
         last_updated_by  = auth.uid(),
         last_updated_at  = now()
   where id = p_ticket_id
     and status = 'resolved';

  perform set_config('app.bypass_ticket_restrictions', 'off', true);

  return jsonb_build_object('id', p_ticket_id, 'status', 'open');
end;
$function$
;

CREATE OR REPLACE FUNCTION public.request_subscription_purchase(p_plan text, p_billing_cycle text, p_ticket_id uuid DEFAULT NULL::uuid, p_is_renewal boolean DEFAULT false, p_payment_method text DEFAULT NULL::text, p_payment_reference text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid        uuid := auth.uid();
  v_check      jsonb;
  v_days       int;
  v_prev_end   timestamptz := null;
  v_start      timestamptz := now();
  v_row        public.whatsapp_subscriptions%rowtype;
begin
  if v_uid is null then
    raise exception 'يجب تسجيل الدخول أولًا' using errcode = '42501';
  end if;

  if p_plan is null or not exists (
       select 1 from public.subscription_plans where key = p_plan and is_active) then
    raise exception 'باقة غير معروفة أو غير مفعّلة' using errcode = '22023';
  end if;

  if p_billing_cycle is null or p_billing_cycle not in ('monthly', 'yearly') then
    raise exception 'دورة فوترة غير صالحة' using errcode = '22023';
  end if;

  if p_payment_method is not null
     and p_payment_method not in ('bank_transfer', 'cash_wallet', 'instapay', 'gateway') then
    raise exception 'وسيلة دفع غير صالحة' using errcode = '22023';
  end if;

  -- التذكرة لا تُقبل إلا إذا كانت تخص المنادي.
  if p_ticket_id is not null and not exists (
       select 1 from public.tickets where id = p_ticket_id and user_id = v_uid) then
    raise exception 'التذكرة غير موجودة أو لا تخص حسابك' using errcode = '42501';
  end if;

  -- طلب معلّق لنفس الباقة
  if exists (
       select 1 from public.whatsapp_subscriptions
        where user_id = v_uid and plan = p_plan and status = 'pending') then
    raise exception 'لديك بالفعل طلب في هذه الباقة قيد المراجعة. انتظر رد فريق الدعم قبل إرسال طلب جديد.'
      using errcode = '42501';
  end if;

  v_check := public.subscription_purchase_check(p_plan, p_is_renewal, v_uid);
  if not (v_check->>'allowed')::boolean then
    raise exception '%', v_check->>'reason' using errcode = '42501';
  end if;

  v_days := case when p_billing_cycle = 'yearly' then 365 else 30 end;

  if p_is_renewal then
    select max(end_date) into v_prev_end
      from public.whatsapp_subscriptions
     where user_id = v_uid and plan = p_plan
       and status = 'active' and end_date > now();
  end if;

  insert into public.whatsapp_subscriptions (
    user_id, ticket_id, plan, billing_cycle,
    start_date, end_date, status, is_renewal,
    duration_days, previous_end_date, payment_method, payment_reference
  ) values (
    v_uid, p_ticket_id, p_plan, p_billing_cycle,
    v_start, v_start + make_interval(days => v_days), 'pending', coalesce(p_is_renewal, false),
    v_days, v_prev_end, p_payment_method,
    nullif(btrim(coalesce(p_payment_reference, '')), '')
  )
  returning * into v_row;

  return jsonb_build_object(
    'subscription_id', v_row.id,
    'status',          v_row.status,
    'plan',            v_row.plan,
    'billing_cycle',   v_row.billing_cycle,
    'is_renewal',      v_row.is_renewal,
    'previous_end_date', v_row.previous_end_date
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.request_subscription_upgrade(p_plan text, p_ticket_id uuid DEFAULT NULL::uuid, p_payment_method text DEFAULT NULL::text, p_payment_reference text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid(); v_quote jsonb; v_cur_id uuid;
  v_new public.whatsapp_subscriptions%rowtype; v_cur public.whatsapp_subscriptions%rowtype;
begin
  if v_uid is null then raise exception 'يجب تسجيل الدخول أولًا' using errcode = '42501'; end if;
  v_quote := public.subscription_upgrade_quote(p_plan);
  if (v_quote->>'eligible')::boolean is not true then
    raise exception 'لا يمكن ترقية اشتراكك إلى هذه الباقة (%).', coalesce(v_quote->>'code', 'unknown');
  end if;

  v_cur_id := (v_quote->'current'->>'subscription_id')::uuid;
  select * into v_cur from public.whatsapp_subscriptions where id = v_cur_id for update;
  if v_cur.status <> 'active' or v_cur.end_date <= now() then
    raise exception 'الاشتراك الحالي لم يعد صالحًا للترقية';
  end if;

  insert into public.whatsapp_subscriptions (
    user_id, ticket_id, plan, status, billing_cycle, start_date, end_date, duration_days,
    payment_method, payment_reference,
    upgraded_from_subscription_id, upgrade_amount, price_snapshot, company_id
  ) values (
    v_uid, p_ticket_id, p_plan, 'pending', v_cur.billing_cycle,
    v_cur.start_date, v_cur.end_date, v_cur.duration_days,
    nullif(btrim(coalesce(p_payment_method, '')), ''),
    nullif(btrim(coalesce(p_payment_reference, '')), ''),
    v_cur.id, (v_quote->>'amount_due')::numeric,
    jsonb_build_object('quoted_at', now(),
      'from_plan', v_quote->'current'->>'plan', 'from_price', (v_quote->'current'->>'price')::numeric,
      'to_plan', p_plan, 'to_price', (v_quote->'target'->>'price')::numeric,
      'billing_cycle', v_cur.billing_cycle,
      'remaining_days', (v_quote->>'remaining_days')::int, 'cycle_days', (v_quote->>'cycle_days')::int,
      'price_difference', (v_quote->>'price_difference')::numeric,
      'amount_due', (v_quote->>'amount_due')::numeric, 'currency', v_quote->>'currency'),
    v_cur.company_id
  ) returning * into v_new;

  return jsonb_build_object('subscription_id', v_new.id, 'amount_due', v_new.upgrade_amount,
    'currency', v_quote->>'currency', 'quote', v_quote);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.request_user_agent()
 RETURNS text
 LANGUAGE plpgsql
 STABLE
AS $function$
begin
  return nullif(btrim(coalesce(
    (current_setting('request.headers', true))::jsonb ->> 'user-agent', '')), '');
exception when others then
  return null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.resolve_company_member_login(p_company text, p_member text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_company_id uuid; v_owner_id uuid; v_email text; v_member text; v_company text;
begin
  if p_company is null or p_member is null then return null; end if;

  v_company := btrim(p_company);
  if v_company = '' then return null; end if;

  if not public._check_email_lookup_rate_limit('company:' || lower(v_company), 5, 600) then
    raise exception 'محاولات كثيرة جدًا، حاول لاحقًا' using errcode='42901';
  end if;
  if not public._check_email_lookup_rate_limit('company_global', 60, 300) then
    raise exception 'محاولات كثيرة جدًا، حاول لاحقًا' using errcode='42901';
  end if;

  -- الشركة تُعرَف ببياناتها أو بمعرّفات مالكها. الترتيب صريح: أعمدة الشركة
  -- أولًا، فلا يزاحم بريدُ مالكٍ شركةً طابقت ببريدها هي.
  select c.id, c.user_id into v_company_id, v_owner_id
    from public.companies c
    left join public.profiles o on o.id = c.user_id
   where c.status = 'active'
     and (lower(c.company_email) = lower(v_company)
          or c.commercial_registration_number = v_company
          or public.normalize_phone(c.company_phone) = public.normalize_phone(v_company)
          or lower(o.email) = lower(v_company)
          or public.normalize_phone(o.phone) = public.normalize_phone(v_company))
   order by case
              when lower(c.company_email) = lower(v_company)                            then 1
              when c.commercial_registration_number = v_company                          then 2
              when public.normalize_phone(c.company_phone) = public.normalize_phone(v_company) then 3
              when lower(o.email) = lower(v_company)                                     then 4
              else 5
            end,
            c.id
   limit 1;
  if v_company_id is null then return null; end if;

  -- إثبات العضوية — منقول حرفيًا من 042 بلا تغيير.
  v_member := btrim(p_member);
  select p.email into v_email from public.profiles p
   where (p.super_user_id = v_owner_id or p.id = v_owner_id)
     and (lower(p.email) = lower(v_member)
          or public.normalize_phone(p.phone) = public.normalize_phone(v_member))
   limit 1;
  return v_email;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.restrict_customer_ticket_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  is_caller_admin boolean;
BEGIN
  IF current_setting('app.bypass_ticket_restrictions', true) = 'on' THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  ) INTO is_caller_admin;

  IF is_caller_admin THEN
    RETURN NEW;
  END IF;

  IF auth.uid() = OLD.user_id THEN
    IF NEW.title IS DISTINCT FROM OLD.title
       OR NEW.description IS DISTINCT FROM OLD.description
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.priority IS DISTINCT FROM OLD.priority
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.image_url IS DISTINCT FROM OLD.image_url
       OR NEW.ticket_number IS DISTINCT FROM OLD.ticket_number THEN
      RAISE EXCEPTION 'العميل غير مسموح له بتعديل هذه الحقول، يمكنه فقط أرشفة التذكرة';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.revoke_my_pending_2fa_session()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;

  DELETE FROM auth.refresh_tokens WHERE user_id = auth.uid()::text;
  UPDATE auth.sessions SET not_after = now() WHERE user_id = auth.uid();
END;
$function$
;

CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.run_data_retention_cleanup()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_settings jsonb;
  v_enabled boolean;
  v_days int;
  v_action text;
  v_affected int;
BEGIN
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
$function$
;

CREATE OR REPLACE FUNCTION public.search_help_articles(p_query text DEFAULT NULL::text, p_category text DEFAULT NULL::text, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, title text, category text, excerpt text, updated_at timestamp with time zone, view_count integer, relevance integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with q as (select nullif(btrim(coalesce(p_query, '')), '') as term)
  select a.id, a.title, a.category, a.excerpt, a.updated_at, a.view_count,
         case
           when (select term from q) is null then 0
           when a.title    ilike '%' || (select term from q) || '%' then 3
           when a.excerpt  ilike '%' || (select term from q) || '%' then 2
           else 1
         end as relevance
    from public.knowledge_base a
   where (p_category is null or a.category = p_category)
     and (
       (select term from q) is null
       or a.title   ilike '%' || (select term from q) || '%'
       or a.excerpt ilike '%' || (select term from q) || '%'
       or a.content ilike '%' || (select term from q) || '%'
     )
   order by relevance desc, a.view_count desc, a.updated_at desc
   limit greatest(1, least(coalesce(p_limit, 20), 50))
  offset greatest(0, coalesce(p_offset, 0));
$function$
;

CREATE OR REPLACE FUNCTION public.send_bulk_notification(target_role text, notification_title text, notification_message text, notification_type text DEFAULT 'info'::text, notification_link text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    user_record RECORD;
BEGIN
    FOR user_record IN SELECT id FROM public.profiles WHERE role = target_role LOOP
        INSERT INTO public.notifications (user_id, title, message, type, link, created_at)
        VALUES (user_record.id, notification_title, notification_message, notification_type, notification_link, NOW());
    END LOOP;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.send_telegram_message(p_chat_id text, p_message text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_token text;
BEGIN
  SELECT telegram_token INTO v_token FROM public.api_keys LIMIT 1;
  IF v_token IS NULL OR v_token = '' OR p_chat_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object('chat_id', p_chat_id, 'text', p_message, 'parse_mode', 'HTML')
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.send_test_telegram_alert()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_chat_id text;
BEGIN
  SELECT telegram_chat_id INTO v_chat_id FROM public.profiles WHERE id = auth.uid();
  IF v_chat_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_telegram_linked');
  END IF;
  PERFORM public.send_telegram_message(v_chat_id, '✅ تم تفعيل تنبيهات تيليجرام بنجاح من لوحة إعدادات مدعوم.');
  RETURN jsonb_build_object('success', true);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.set_ai_agents_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_board_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_external_integration_models_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.set_kb_published_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.status = 'published' and new.published_at is null then
    new.published_at := now();
  end if;
  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_mcp_servers_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
    new.updated_at = now();
    return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_notification_action()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_category text;
begin
  v_category := coalesce(
    nullif(btrim(coalesce(new.category, '')), ''),
    public.derive_notification_category(new.type, new.title, new.link)
  );

  if new.reference_id is null then
    new.reference_id := public.notification_link_ticket_id(new.link);
  end if;

  if new.action is null or btrim(new.action) = '' then
    new.action := public.derive_notification_action(v_category, new.link);
  end if;

  if new.action_target is null or btrim(new.action_target) = '' then
    new.action_target := public.derive_notification_action_target(v_category, new.link);
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_notification_category()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.category is null or btrim(new.category) = '' then
    new.category := public.derive_notification_category(new.type, new.title, new.link);
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_service_report_episode()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_changed_at timestamptz;
begin
  if new.incident_id is not null then
    new.episode_key := 'incident:' || new.incident_id::text;
  else
    select s.status_changed_at into v_changed_at
      from public.services s where s.id = new.service_id;
    new.episode_key := 'service:' || new.service_id::text || ':'
                    || coalesce(extract(epoch from v_changed_at)::bigint, 0)::text;
  end if;

  new.source := 'customer_portal';
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_ticket_number()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
    BEGIN
        IF NEW.ticket_number IS NULL THEN
            NEW.ticket_number := nextval('ticket_number_seq');
        END IF;
        RETURN NEW;
    END;
    $function$
;

CREATE OR REPLACE FUNCTION public.set_ticket_sla()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.sla_response_due_at IS NULL THEN
    NEW.sla_response_due_at := NEW.created_at + CASE NEW.priority
      WHEN 'high' THEN interval '4 hours'
      WHEN 'low' THEN interval '24 hours'
      ELSE interval '8 hours'
    END;
  END IF;
  IF NEW.sla_resolution_due_at IS NULL THEN
    NEW.sla_resolution_due_at := NEW.created_at + CASE NEW.priority
      WHEN 'high' THEN interval '8 hours'
      WHEN 'low' THEN interval '72 hours'
      ELSE interval '24 hours'
    END;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.sie_admin_rate_limit_status(p_user_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(user_id uuid, is_overridden boolean, effective_enabled boolean, effective_limit integer, effective_burst integer, override_enabled boolean, override_limit integer, override_burst integer, notes text, window_requests integer, window_rejected integer, total_requests bigint, total_rejected bigint, last_request_at timestamp with time zone, tokens_remaining integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
    if not (is_sie_admin() or is_chat_engine_staff()) then
        raise exception 'access denied';
    end if;

    return query
    select
        a.user_id,
        (o.user_id is not null and (o.is_enabled is not null or o.requests_per_minute is not null or o.burst is not null)),
        e.enabled,
        e.limit_per_min,
        e.burst,
        o.is_enabled,
        o.requests_per_minute,
        o.burst,
        o.notes,
        coalesce(case when now() - b.window_started_at >= interval '1 minute' then 0 else b.window_requests end, 0),
        coalesce(case when now() - b.window_started_at >= interval '1 minute' then 0 else b.window_rejected end, 0),
        coalesce(b.total_requests, 0::bigint),
        coalesce(b.total_rejected, 0::bigint),
        b.last_request_at,
        coalesce(
            least(
                e.limit_per_min + e.burst,
                floor(b.tokens + extract(epoch from (now() - b.updated_at)) * (e.limit_per_min / 60.0))
            )::integer,
            e.limit_per_min + e.burst
        )
      from public.customer_sie_access a
      cross join lateral public.sie_rl_effective_limits(a.user_id) e
      left join public.sie_rate_limit_overrides o on o.user_id = a.user_id
      left join public.sie_rate_limit_buckets  b on b.bucket_key = 'user:' || a.user_id::text
     where p_user_id is null or a.user_id = p_user_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sie_admin_reset_rate_limit(p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
    if not is_sie_admin() then
        raise exception 'access denied';
    end if;
    delete from public.sie_rate_limit_buckets where bucket_key = 'user:' || p_user_id::text;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sie_admin_reset_usage(p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
    if not is_sie_admin() then
        raise exception 'access denied: sie admin privileges required';
    end if;

    update public.customer_sie_access
    set messages_used = 0,
        updated_by = auth.uid(),
        updated_at = now()
    where user_id = p_user_id;

    if not found then
        raise exception 'no sie access row found for user %', p_user_id;
    end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sie_admin_set_access(p_user_id uuid, p_is_enabled boolean, p_access_mode text, p_message_quota integer, p_expires_at timestamp with time zone, p_notes text, p_edition text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
    if not is_sie_admin() then
        raise exception 'access denied: sie admin privileges required';
    end if;

    if p_access_mode not in ('unlimited', 'quota', 'expiration') then
        raise exception 'invalid access_mode: %, must be unlimited/quota/expiration', p_access_mode;
    end if;

    if p_access_mode = 'quota' and (p_message_quota is null or p_message_quota < 1) then
        raise exception 'message_quota must be a positive integer when access_mode is quota';
    end if;

    if p_access_mode = 'expiration' and p_expires_at is null then
        raise exception 'expires_at is required when access_mode is expiration';
    end if;

    if p_edition is not null and p_edition not in ('free', 'pro', 'max', 'default') then
        raise exception 'invalid edition: %, must be free/pro/max/default', p_edition;
    end if;

    if not exists (select 1 from public.profiles where id = p_user_id) then
        raise exception 'no profile found for user %', p_user_id;
    end if;

    insert into public.customer_sie_access (
        user_id, is_enabled, access_mode, message_quota, expires_at, notes, edition, created_by, updated_by
    )
    values (
        p_user_id,
        p_is_enabled,
        p_access_mode,
        case when p_access_mode = 'quota' then p_message_quota else null end,
        case when p_access_mode = 'expiration' then p_expires_at else null end,
        p_notes,
        case when p_edition in ('free', 'pro', 'max') then p_edition else null end,
        auth.uid(),
        auth.uid()
    )
    on conflict (user_id) do update
    set is_enabled = excluded.is_enabled,
        access_mode = excluded.access_mode,
        message_quota = excluded.message_quota,
        expires_at = excluded.expires_at,
        notes = excluded.notes,
        edition = case
            when p_edition is null then customer_sie_access.edition
            when p_edition = 'default' then null
            else p_edition end,
        updated_by = auth.uid(),
        updated_at = now();
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sie_admin_set_rate_limit(p_user_id uuid, p_is_enabled boolean DEFAULT NULL::boolean, p_requests_per_minute integer DEFAULT NULL::integer, p_burst integer DEFAULT NULL::integer, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
    if not is_sie_admin() then
        raise exception 'access denied';
    end if;
    if p_user_id is null then
        raise exception 'user id is required';
    end if;
    insert into public.sie_rate_limit_overrides as o
        (user_id, is_enabled, requests_per_minute, burst, notes, updated_at, updated_by)
    values
        (p_user_id, p_is_enabled, p_requests_per_minute, p_burst, p_notes, now(), auth.uid())
    on conflict (user_id) do update set
        is_enabled          = excluded.is_enabled,
        requests_per_minute = excluded.requests_per_minute,
        burst               = excluded.burst,
        notes               = excluded.notes,
        updated_at          = now(),
        updated_by          = auth.uid();
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sie_api_key_create(p_user_id uuid, p_name text, p_environment text DEFAULT 'live'::text, p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(id uuid, api_key text, key_prefix text, key_last4 text, environment text, expires_at timestamp with time zone, created_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
    v_secret text;
    v_key    text;
    v_id     uuid;
    v_env    text := coalesce(nullif(trim(p_environment), ''), 'live');
    v_name   text := nullif(trim(p_name), '');
begin
    -- إدارة المفاتيح لمسؤول المحرك بس. نفس البوابة اللي بتتحكم في
    -- صلاحيات العملاء، مش بوابة جديدة.
    if not public.is_sie_admin() then
        raise exception 'access denied' using errcode = '42501';
    end if;
    if p_user_id is null then
        raise exception 'user_id is required' using errcode = '22023';
    end if;
    if v_name is null then
        raise exception 'name is required' using errcode = '22023';
    end if;
    if v_env not in ('live', 'test') then
        raise exception 'environment must be live or test' using errcode = '22023';
    end if;

    -- base64url من 32 بايت: 43 حرف، من غير حروف بتتكسر في URL أو shell.
    v_secret := translate(encode(gen_random_bytes(32), 'base64'), '+/=', '-_');
    v_key    := 'sie_' || v_env || '_' || v_secret;
    v_id     := gen_random_uuid();

    insert into public.sie_api_keys (id, user_id, name, environment, key_prefix, key_last4, key_hash, expires_at, created_by)
    values (
        v_id,
        p_user_id,
        v_name,
        v_env,
        left(v_key, 16),
        right(v_key, 4),
        encode(digest(v_key, 'sha256'), 'hex'),
        p_expires_at,
        auth.uid()
    );

    return query
    select v_id, v_key, left(v_key, 16), right(v_key, 4), v_env, p_expires_at, now();
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sie_api_key_list(p_user_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, user_id uuid, name text, environment text, key_prefix text, key_last4 text, status text, expires_at timestamp with time zone, last_used_at timestamp with time zone, revoked_at timestamp with time zone, created_at timestamp with time zone, request_count bigint)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select
        k.id, k.user_id, k.name, k.environment, k.key_prefix, k.key_last4,
        -- الانتهاء حالة محسوبة، مش عمود: مفتاح خلصت مدته مش «نشط» حتى لو
        -- الصف لسه مكتوب فيه كده، والتحقق بيرفضه فعلاً.
        case
            when k.status = 'revoked' then 'revoked'
            when k.expires_at is not null and k.expires_at <= now() then 'expired'
            else 'active'
        end as status,
        k.expires_at, k.last_used_at, k.revoked_at, k.created_at,
        (select count(*) from public.sie_api_requests r where r.api_key_id = k.id) as request_count
    from public.sie_api_keys k
    where (public.is_sie_admin() or public.is_chat_engine_staff() or k.user_id = auth.uid())
      and (p_user_id is null or k.user_id = p_user_id)
    order by k.created_at desc;
$function$
;

CREATE OR REPLACE FUNCTION public.sie_api_key_revoke(p_key_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_updated integer;
begin
    if not public.is_sie_admin() then
        raise exception 'access denied' using errcode = '42501';
    end if;

    update public.sie_api_keys
       set status = 'revoked', revoked_at = now()
     where id = p_key_id and status <> 'revoked';

    get diagnostics v_updated = row_count;
    return v_updated > 0;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sie_api_key_rotate(p_key_id uuid)
 RETURNS TABLE(id uuid, api_key text, key_prefix text, key_last4 text, environment text, expires_at timestamp with time zone, created_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
    v_old   public.sie_api_keys%rowtype;
    v_new   record;
begin
    if not public.is_sie_admin() then
        raise exception 'access denied' using errcode = '42501';
    end if;

    select * into v_old from public.sie_api_keys where sie_api_keys.id = p_key_id;
    if not found then
        raise exception 'key not found' using errcode = 'P0002';
    end if;

    select * into v_new
      from public.sie_api_key_create(v_old.user_id, v_old.name, v_old.environment, v_old.expires_at);

    update public.sie_api_keys set rotated_from = v_old.id where sie_api_keys.id = v_new.id;
    update public.sie_api_keys set status = 'revoked', revoked_at = now() where sie_api_keys.id = v_old.id;

    return query select v_new.id, v_new.api_key, v_new.key_prefix, v_new.key_last4,
                        v_new.environment, v_new.expires_at, v_new.created_at;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sie_api_key_verify(p_key_hash text)
 RETURNS TABLE(key_id uuid, user_id uuid, environment text, key_prefix text, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_row public.sie_api_keys%rowtype;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'access denied' using errcode = '42501';
    end if;

    select * into v_row from public.sie_api_keys where key_hash = p_key_hash;

    if not found then
        return query select null::uuid, null::uuid, null::text, null::text, 'invalid'::text;
        return;
    end if;
    if v_row.status = 'revoked' then
        return query select v_row.id, null::uuid, v_row.environment, v_row.key_prefix, 'revoked'::text;
        return;
    end if;
    if v_row.expires_at is not null and v_row.expires_at <= now() then
        return query select v_row.id, null::uuid, v_row.environment, v_row.key_prefix, 'expired'::text;
        return;
    end if;

    -- «آخر استخدام» بيتكتب هنا، في نفس النداء اللي بيتحقق — مافيش نداء
    -- تاني ممكن يتنسى أو يفشل ويسيب العمود بيكدب.
    update public.sie_api_keys set last_used_at = now() where id = v_row.id;

    return query select v_row.id, v_row.user_id, v_row.environment, v_row.key_prefix, null::text;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sie_api_log_request(p_request_id text, p_api_key_id uuid, p_user_id uuid, p_method text, p_path text, p_status integer, p_error_code text DEFAULT NULL::text, p_duration_ms integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'access denied' using errcode = '42501';
    end if;

    insert into public.sie_api_requests
        (request_id, api_key_id, user_id, method, path, status, error_code, duration_ms)
    values
        (left(p_request_id, 64), p_api_key_id, p_user_id, left(p_method, 10),
         left(p_path, 200), p_status, left(p_error_code, 64), p_duration_ms);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sie_api_rate_limit_hit(p_user_id uuid, p_client_ip text DEFAULT NULL::text)
 RETURNS TABLE(allowed boolean, enabled boolean, limit_per_min integer, remaining integer, reset_seconds integer, retry_after integer, key_used text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_key       text;
    v_enabled   boolean;
    v_limit     integer;
    v_burst     integer;
    v_capacity  double precision;
    v_refill    double precision;
    v_tokens    double precision;
    v_allowed   boolean;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'access denied' using errcode = '42501';
    end if;

    if p_user_id is not null then
        v_key := 'user:' || p_user_id::text;
    elsif p_client_ip is not null and length(trim(p_client_ip)) > 0 then
        v_key := 'ip:' || left(trim(p_client_ip), 100);
    else
        v_key := 'anon:unknown';
    end if;

    select e.enabled, e.limit_per_min, e.burst into v_enabled, v_limit, v_burst
      from public.sie_rl_effective_limits(p_user_id) e;

    if v_enabled is not true then
        return query select true, false, v_limit, v_limit, 0, 0, v_key;
        return;
    end if;

    select s.tokens, s.allowed into v_tokens, v_allowed
      from public.sie_rl_spend(v_key, v_limit, v_burst) s;

    v_capacity := v_limit::double precision + greatest(v_burst, 0)::double precision;
    v_refill   := v_limit::double precision / 60.0;

    return query select
        v_allowed,
        true,
        v_limit,
        greatest(floor(v_tokens)::integer, 0),
        greatest(ceil((v_capacity - v_tokens) / v_refill)::integer, 0),
        case when v_allowed then 0
             else greatest(ceil((1 - v_tokens) / v_refill)::integer, 1) end,
        v_key;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sie_api_usage_summary(p_user_id uuid DEFAULT NULL::uuid, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(user_id uuid, total_requests bigint, ok_requests bigint, error_requests bigint, rate_limited bigint, last_request_at timestamp with time zone, active_keys bigint)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    with scope as (
        select r.*
          from public.sie_api_requests r
         where (public.is_sie_admin() or public.is_chat_engine_staff() or r.user_id = auth.uid())
           and (p_user_id is null or r.user_id = p_user_id)
           and (p_since is null or r.created_at >= p_since)
    )
    select
        p_user_id,
        (select count(*) from scope),
        (select count(*) from scope where status >= 200 and status < 300),
        (select count(*) from scope where status >= 400),
        (select count(*) from scope where status = 429),
        (select max(created_at) from scope),
        (select count(*) from public.sie_api_keys k
          where (public.is_sie_admin() or public.is_chat_engine_staff() or k.user_id = auth.uid())
            and (p_user_id is null or k.user_id = p_user_id)
            and k.status = 'active'
            and (k.expires_at is null or k.expires_at > now()));
$function$
;

CREATE OR REPLACE FUNCTION public.sie_consume_message(p_user_id uuid)
 RETURNS TABLE(allowed boolean, reason text, remaining integer, edition text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_row     public.customer_sie_access%rowtype;
    v_edition text;
    v_cap     integer;
    v_month   date := date_trunc('month', timezone('utc', now()))::date;
    v_used    integer;
begin
    if p_user_id is null then
        return query select false, 'unauthorized'::text, null::integer, null::text;
        return;
    end if;

    -- Either the caller IS this user, or the caller is the service role
    -- acting for them from a channel webhook. (Unchanged from 0004.)
    if p_user_id <> coalesce(auth.uid(), p_user_id) or
       (auth.uid() is null and coalesce(auth.role(), '') <> 'service_role') then
        return query select false, 'unauthorized'::text, null::integer, null::text;
        return;
    end if;

    select * into v_row
    from public.customer_sie_access
    where user_id = p_user_id
    for update;

    if not found then
        return query select false, 'not_enabled'::text, null::integer, null::text;
        return;
    end if;

    v_edition := sie_effective_edition(v_row.edition);

    if not v_row.is_enabled then
        return query select false, 'disabled'::text, null::integer, v_edition;
        return;
    end if;

    if v_row.access_mode = 'expiration' and v_row.expires_at is not null and v_row.expires_at < now() then
        return query select false, 'expired'::text, null::integer, v_edition;
        return;
    end if;

    if v_row.access_mode = 'quota' and v_row.messages_used >= coalesce(v_row.message_quota, 0) then
        return query select false, 'quota_exceeded'::text, 0, v_edition;
        return;
    end if;

    -- The edition's monthly cap. 0 or unset = no edition cap (the default,
    -- which is why applying this migration changes nothing on its own).
    v_cap := sie_edition_setting_int(v_edition, '_monthly_messages');
    v_used := case when v_row.edition_period_start = v_month then v_row.edition_period_used else 0 end;
    if v_cap is not null and v_cap > 0 and v_used >= v_cap then
        return query select false, 'edition_monthly_limit'::text, 0, v_edition;
        return;
    end if;

    update public.customer_sie_access
    set messages_used = messages_used + 1,
        edition_period_start = v_month,
        edition_period_used = v_used + 1,
        last_used_at = now()
    where user_id = p_user_id
    returning messages_used into v_row.messages_used;

    if v_row.access_mode = 'quota' then
        return query select true, null::text,
            least(greatest(v_row.message_quota - v_row.messages_used, 0),
                  case when v_cap > 0 then greatest(v_cap - v_used - 1, 0) else 2147483647 end),
            v_edition;
    elsif v_cap is not null and v_cap > 0 then
        return query select true, null::text, greatest(v_cap - v_used - 1, 0), v_edition;
    else
        return query select true, null::text, null::integer, v_edition;
    end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sie_customer_downgrade(p_target text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_uid     uuid := auth.uid();
    v_row     public.customer_sie_access%rowtype;
    v_current text;
    v_ask     jsonb := jsonb_build_object('requested', p_target);
begin
    if v_uid is null or public.preview_mode() then
        perform public.log_privileged('sie.edition.self_downgrade.denied', v_uid, null, v_ask || '{"result":"forbidden"}');
        return jsonb_build_object('ok', false, 'error', 'forbidden');
    end if;

    if p_target is null or p_target not in ('free', 'pro') then
        perform public.log_privileged('sie.edition.self_downgrade.failed', v_uid, null, v_ask || '{"result":"invalid_target"}');
        return jsonb_build_object('ok', false, 'error', 'invalid_target');
    end if;

    select * into v_row from public.customer_sie_access where user_id = v_uid for update;
    if not found then
        perform public.log_privileged('sie.edition.self_downgrade.failed', v_uid, null, v_ask || '{"result":"no_access"}');
        return jsonb_build_object('ok', false, 'error', 'no_access');
    end if;

    v_current := public.sie_effective_edition(v_row.edition);
    if public.sie_edition_rank(p_target) >= public.sie_edition_rank(v_current) then
        perform public.log_privileged('sie.edition.self_downgrade.failed', v_uid,
            jsonb_build_object('effective', v_current), v_ask || '{"result":"not_a_downgrade"}');
        return jsonb_build_object('ok', false, 'error', 'not_a_downgrade', 'current', v_current);
    end if;
    if not public.sie_edition_available(p_target) then
        perform public.log_privileged('sie.edition.self_downgrade.failed', v_uid,
            jsonb_build_object('effective', v_current), v_ask || '{"result":"edition_unavailable"}');
        return jsonb_build_object('ok', false, 'error', 'edition_unavailable', 'current', v_current);
    end if;

    update public.customer_sie_access
       set edition = p_target, updated_by = v_uid, updated_at = now()
     where user_id = v_uid;

    perform public.log_privileged('sie.edition.self_downgrade', v_uid,
        jsonb_build_object('edition', v_row.edition, 'effective', v_current),
        jsonb_build_object('edition', p_target, 'effective', public.sie_effective_edition(p_target), 'result', 'success'));

    return jsonb_build_object('ok', true, 'previous', v_current, 'edition', p_target,
                              'effective', public.sie_effective_edition(p_target));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sie_edition_available(p_edition text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_raw jsonb;
begin
    if p_edition = 'free' then
        return true;
    end if;
    if p_edition is null or p_edition not in ('pro', 'max') then
        return false;
    end if;
    select value into v_raw from public.sie_settings where key = 'edition_' || p_edition || '_enabled';
    return v_raw is null or v_raw = 'true'::jsonb;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sie_edition_rank(p_edition text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$
    select case p_edition when 'free' then 1 when 'pro' then 2 when 'max' then 3 else 0 end;
$function$
;

CREATE OR REPLACE FUNCTION public.sie_edition_setting_int(p_edition text, p_suffix text)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_raw jsonb;
begin
    if p_edition not in ('free', 'pro', 'max') then
        return null;
    end if;
    select value into v_raw from public.sie_settings
     where key = 'edition_' || p_edition || p_suffix;
    if v_raw is null or jsonb_typeof(v_raw) <> 'number' then
        return null;
    end if;
    return floor((v_raw #>> '{}')::numeric)::integer;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sie_edition_write_allowed()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select case
        when auth.uid() is not null or coalesce(auth.role(), '') in ('anon', 'authenticated')
            then public.sie_owner_authority()
        else true
    end;
$function$
;

CREATE OR REPLACE FUNCTION public.sie_effective_edition(p_row_edition text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_default text;
begin
    if p_row_edition in ('free', 'pro', 'max') then
        return case when public.sie_edition_available(p_row_edition) then p_row_edition else 'free' end;
    end if;
    select value #>> '{}' into v_default from public.sie_settings where key = 'default_edition';
    if v_default in ('free', 'pro', 'max') and public.sie_edition_available(v_default) then
        return v_default;
    end if;
    return 'free';
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sie_is_edition_setting_key(p_key text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
    select coalesce(p_key = 'default_edition' or p_key ~ '^edition_(free|pro|max)_[a-z_]+$', false);
$function$
;

CREATE OR REPLACE FUNCTION public.sie_my_entitlement()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_uid       uuid := auth.uid();
    v_row       public.customer_sie_access%rowtype;
    v_edition   text;
    v_reason    text;
    v_month     date := date_trunc('month', timezone('utc', now()))::date;
    v_reset     timestamptz := (date_trunc('month', timezone('utc', now())) + interval '1 month') at time zone 'utc';
    v_cap       integer;
    v_period    integer;
    v_limits    jsonb := '[]'::jsonb;
    v_primary   jsonb;
    v_down      jsonb := '[]'::jsonb;
    v_e         text;
begin
    if v_uid is null then
        return jsonb_build_object('signed_in', false);
    end if;

    select * into v_row from public.customer_sie_access where user_id = v_uid;
    if not found then
        return jsonb_build_object('signed_in', true, 'has_access', false, 'reason', 'not_enabled',
            'edition', public.sie_effective_edition(null), 'assigned_edition', null,
            'downgrade_to', '[]'::jsonb, 'limits', '[]'::jsonb, 'primary', null);
    end if;

    v_edition := public.sie_effective_edition(v_row.edition);
    v_cap := coalesce(public.sie_edition_setting_int(v_edition, '_monthly_messages'), 0);
    v_period := case when v_row.edition_period_start = v_month then v_row.edition_period_used else 0 end;

    if v_row.access_mode = 'quota' then
        v_limits := v_limits || jsonb_build_array(jsonb_build_object(
            'kind', 'lifetime', 'used', v_row.messages_used, 'limit', v_row.message_quota,
            'remaining', greatest(coalesce(v_row.message_quota, 0) - v_row.messages_used, 0), 'resets_at', null));
    end if;
    if v_cap > 0 then
        v_limits := v_limits || jsonb_build_array(jsonb_build_object(
            'kind', 'monthly', 'used', v_period, 'limit', v_cap,
            'remaining', greatest(v_cap - v_period, 0), 'resets_at', v_reset));
    end if;

    -- The binding limit is the one with the least left.
    select l into v_primary from jsonb_array_elements(v_limits) l
     order by (l ->> 'remaining')::int asc limit 1;
    if v_primary is null then
        v_primary := jsonb_build_object('kind', 'unlimited', 'used', v_period, 'limit', null,
                                        'remaining', null, 'resets_at', v_reset);
    end if;

    -- The same order as sie_consume_message().
    if not v_row.is_enabled then
        v_reason := 'disabled';
    elsif v_row.access_mode = 'expiration' and v_row.expires_at is not null and v_row.expires_at < now() then
        v_reason := 'expired';
    elsif v_row.access_mode = 'quota' and v_row.messages_used >= coalesce(v_row.message_quota, 0) then
        v_reason := 'quota_exceeded';
    elsif v_cap > 0 and v_period >= v_cap then
        v_reason := 'edition_monthly_limit';
    end if;

    if not public.preview_mode() then
        foreach v_e in array array['pro', 'free'] loop
            if public.sie_edition_rank(v_e) < public.sie_edition_rank(v_edition) and public.sie_edition_available(v_e) then
                v_down := v_down || to_jsonb(v_e);
            end if;
        end loop;
    end if;

    return jsonb_build_object(
        'signed_in', true,
        'has_access', v_reason is null,
        'reason', v_reason,
        'edition', v_edition,
        'assigned_edition', v_row.edition,
        'access_mode', v_row.access_mode,
        'expires_at', v_row.expires_at,
        'downgrade_to', v_down,
        'limits', v_limits,
        'primary', v_primary
    );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sie_owner_authority()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- coalesce لنفس سبب 040: أي NULL هنا كان سيُسقط حارسًا بصمت.
  select coalesce(public.is_platform_owner() and not public.preview_mode(), false);
$function$
;

CREATE OR REPLACE FUNCTION public.sie_owner_edition_overview()
 RETURNS TABLE(edition text, enabled boolean, is_default boolean, assigned_customers integer, effective_customers integer, active_customers integer, messages_this_month bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_month date := date_trunc('month', timezone('utc', now()))::date;
begin
    if not public.sie_owner_authority() then
        raise exception 'نظرة الإصدارات لمالك المنصة وحده' using errcode = '42501';
    end if;

    return query
    with ids(id, ord) as (values ('free', 1), ('pro', 2), ('max', 3)),
         rows as (
             select a.edition as own, public.sie_effective_edition(a.edition) as eff, a.is_enabled,
                    case when a.edition_period_start = v_month then a.edition_period_used else 0 end as used
               from public.customer_sie_access a
         )
    select i.id,
           public.sie_edition_available(i.id),
           public.sie_effective_edition(null) = i.id,
           (select count(*)::int from rows r where r.own = i.id),
           (select count(*)::int from rows r where r.eff = i.id),
           (select count(*)::int from rows r where r.eff = i.id and r.is_enabled),
           (select coalesce(sum(r.used), 0)::bigint from rows r where r.eff = i.id)
      from ids i
     order by i.ord;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sie_owner_set_customer_edition(p_user_id uuid, p_edition text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_old   text;
    v_new   text;
    v_found boolean;
    v_ask   jsonb := jsonb_build_object('requested', p_edition);
begin
    if not public.sie_owner_authority() then
        perform public.log_privileged('sie.edition.assign.denied', p_user_id, null, v_ask || '{"result":"denied"}');
        return jsonb_build_object('ok', false, 'error', 'forbidden');
    end if;

    if p_user_id is null or p_edition is null or p_edition not in ('free', 'pro', 'max', 'default') then
        perform public.log_privileged('sie.edition.assign.failed', p_user_id, null, v_ask || '{"result":"invalid_edition"}');
        return jsonb_build_object('ok', false, 'error', 'invalid_edition');
    end if;

    select a.edition, true into v_old, v_found
      from public.customer_sie_access a where a.user_id = p_user_id for update;
    if not coalesce(v_found, false) then
        perform public.log_privileged('sie.edition.assign.failed', p_user_id, null, v_ask || '{"result":"no_access"}');
        return jsonb_build_object('ok', false, 'error', 'no_access');
    end if;

    v_new := case when p_edition = 'default' then null else p_edition end;
    if v_new is not distinct from v_old then
        return jsonb_build_object('ok', true, 'changed', false, 'edition', v_new,
                                  'effective', public.sie_effective_edition(v_new));
    end if;

    update public.customer_sie_access
       set edition = v_new, updated_by = auth.uid(), updated_at = now()
     where user_id = p_user_id;

    perform public.log_privileged('sie.edition.assign', p_user_id,
        jsonb_build_object('edition', v_old, 'effective', public.sie_effective_edition(v_old)),
        jsonb_build_object('edition', v_new, 'effective', public.sie_effective_edition(v_new), 'result', 'success'));

    return jsonb_build_object('ok', true, 'changed', true, 'previous', v_old, 'edition', v_new,
                              'effective', public.sie_effective_edition(v_new));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sie_owner_set_edition_setting(p_key text, p_value jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_knob    text;
    v_edition text;
    v_error   text;
    v_ask     jsonb := jsonb_build_object('key', p_key, 'value', p_value);
begin
    if not public.sie_owner_authority() then
        perform public.log_privileged('sie.edition.setting.denied', null, null, v_ask || '{"result":"denied"}');
        return jsonb_build_object('ok', false, 'error', 'forbidden');
    end if;

    if p_key = 'default_edition' then
        if jsonb_typeof(p_value) <> 'string' or (p_value #>> '{}') not in ('free', 'pro', 'max') then
            v_error := 'invalid_value';
        elsif not public.sie_edition_available(p_value #>> '{}') then
            v_error := 'edition_disabled';
        end if;
    elsif p_key ~ '^edition_(free|pro|max)_[a-z_]+$' then
        v_edition := substring(p_key from '^edition_(free|pro|max)_');
        v_knob := substring(p_key from '^edition_(?:free|pro|max)_([a-z_]+)$');
        if v_knob = 'enabled' then
            if v_edition = 'free' then
                v_error := 'free_always_enabled';
            elsif jsonb_typeof(p_value) <> 'boolean' then
                v_error := 'invalid_value';
            elsif p_value = 'false'::jsonb
                  and (select value #>> '{}' from public.sie_settings where key = 'default_edition') = v_edition then
                v_error := 'edition_is_default';
            end if;
        elsif v_knob in ('max_scenarios', 'max_message_chars', 'retrieval_max_candidates', 'max_evidence_tokens',
                         'rate_limit_per_minute', 'rate_limit_burst', 'monthly_messages') then
            if jsonb_typeof(p_value) <> 'number'
               or (p_value #>> '{}')::numeric <> floor((p_value #>> '{}')::numeric)
               or (p_value #>> '{}')::numeric < 0
               or (p_value #>> '{}')::numeric > 1000000 then
                v_error := 'invalid_value';
            end if;
        else
            v_error := 'unknown_setting';
        end if;
    else
        v_error := 'unknown_setting';
    end if;

    if v_error is not null then
        perform public.log_privileged('sie.edition.setting.failed', null, null, v_ask || jsonb_build_object('result', v_error));
        return jsonb_build_object('ok', false, 'error', v_error);
    end if;

    insert into public.sie_settings (key, value) values (p_key, p_value)
    on conflict (key) do update set value = excluded.value;

    return jsonb_build_object('ok', true, 'key', p_key, 'value', p_value);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sie_provision_free_access()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
    begin
        insert into public.customer_sie_access (user_id, is_enabled, access_mode, notes)
        values (new.id, true, 'unlimited', 'SIE Free — provisioned automatically')
        on conflict (user_id) do nothing;
    exception when others then
        -- Never fail a signup over SIE: the widget reports "not enabled"
        -- and support can enable the customer by hand.
        raise warning 'sie_provision_free_access(%): %', new.id, sqlerrm;
    end;
    return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sie_rate_limit_hit(p_client_ip text DEFAULT NULL::text)
 RETURNS TABLE(allowed boolean, enabled boolean, limit_per_min integer, remaining integer, reset_seconds integer, retry_after integer, key_used text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_uid       uuid := auth.uid();
    v_key       text;
    v_enabled   boolean;
    v_limit     integer;
    v_burst     integer;
    v_capacity  double precision;
    v_refill    double precision;
    v_tokens    double precision;
    v_allowed   boolean;
begin
    if v_uid is not null then
        v_key := 'user:' || v_uid::text;
    elsif p_client_ip is not null and length(trim(p_client_ip)) > 0 then
        v_key := 'ip:' || left(trim(p_client_ip), 100);
    else
        v_key := 'anon:unknown';
    end if;

    select e.enabled, e.limit_per_min, e.burst into v_enabled, v_limit, v_burst
      from public.sie_rl_effective_limits(v_uid) e;

    if v_enabled is not true then
        return query select true, false, v_limit, v_limit, 0, 0, v_key;
        return;
    end if;

    select s.tokens, s.allowed into v_tokens, v_allowed
      from public.sie_rl_spend(v_key, v_limit, v_burst) s;

    v_capacity := v_limit::double precision + greatest(v_burst, 0)::double precision;
    v_refill   := v_limit::double precision / 60.0;

    return query select
        v_allowed,
        true,
        v_limit,
        greatest(floor(v_tokens)::integer, 0),
        greatest(ceil((v_capacity - v_tokens) / v_refill)::integer, 0),
        case when v_allowed then 0
             else greatest(ceil((1 - v_tokens) / v_refill)::integer, 1) end,
        v_key;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sie_request_human(p_session uuid, p_reason text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_owner uuid;
begin
  select s.user_id into v_owner from public.chat_sessions s where s.id = p_session;
  if not found then
    raise exception 'المحادثة غير موجودة' using errcode = 'P0002';
  end if;
  if not (auth.uid() is not null and auth.uid() = v_owner)
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'مش مسموحلك تطلب تسليم المحادثة دي' using errcode = '42501';
  end if;
  return public._handoff_set(p_session, true,
    'sie:' || coalesce(nullif(btrim(p_reason), ''), 'escalation'), 'sie', auth.uid());
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sie_rl_available(p_tokens double precision, p_updated_at timestamp with time zone, p_capacity double precision, p_refill_per_sec double precision)
 RETURNS double precision
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
    select least(
        p_capacity,
        p_tokens + greatest(extract(epoch from (now() - p_updated_at)), 0) * p_refill_per_sec
    );
$function$
;

CREATE OR REPLACE FUNCTION public.sie_rl_effective_limits(p_user_id uuid)
 RETURNS TABLE(enabled boolean, limit_per_min integer, burst integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_enabled   boolean;
    v_limit     integer;
    v_burst     integer;
    v_edition   text;
    v_ed_limit  integer;
    v_ed_burst  integer;
    v_o_enabled boolean;
    v_o_limit   integer;
    v_o_burst   integer;
begin
    select coalesce((value #>> '{}')::boolean, true) into v_enabled
      from public.sie_settings where key = 'rate_limit_enabled';
    v_enabled := coalesce(v_enabled, true);

    select coalesce((value #>> '{}')::integer, 100) into v_limit
      from public.sie_settings where key = 'rate_limit_requests_per_minute';
    v_limit := coalesce(v_limit, 100);

    select coalesce((value #>> '{}')::integer, 20) into v_burst
      from public.sie_settings where key = 'rate_limit_burst';
    v_burst := coalesce(v_burst, 20);

    if p_user_id is not null then
        -- Edition: a configured rate (> 0) replaces the global rate and
        -- brings its own burst, clamped to the console's hard limits
        -- (10–5000, 0–500) so a hand-written row cannot size a bucket of 0.
        -- The on/off switch is NOT an edition knob: an edition cannot turn
        -- the limiter off.
        select sie_effective_edition(a.edition) into v_edition
          from public.customer_sie_access a where a.user_id = p_user_id;
        v_edition := coalesce(v_edition, sie_effective_edition(null));
        v_ed_limit := sie_edition_setting_int(v_edition, '_rate_limit_per_minute');
        if v_ed_limit is not null and v_ed_limit > 0 then
            v_limit := least(greatest(v_ed_limit, 10), 5000);
            v_ed_burst := sie_edition_setting_int(v_edition, '_rate_limit_burst');
            if v_ed_burst is not null then
                v_burst := least(greatest(v_ed_burst, 0), 500);
            end if;
        end if;

        -- The customer's own override wins, column by column. Separate
        -- variables: "no row" must not wipe the values above.
        select o.is_enabled, o.requests_per_minute, o.burst
          into v_o_enabled, v_o_limit, v_o_burst
          from public.sie_rate_limit_overrides o
         where o.user_id = p_user_id;
        v_enabled := coalesce(v_o_enabled, v_enabled);
        v_limit   := coalesce(v_o_limit, v_limit);
        v_burst   := coalesce(v_o_burst, v_burst);
    end if;

    return query select v_enabled, v_limit, v_burst;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sie_rl_spend(p_key text, p_limit integer, p_burst integer)
 RETURNS TABLE(tokens double precision, allowed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_capacity double precision := p_limit::double precision + greatest(p_burst, 0)::double precision;
    v_refill   double precision := p_limit::double precision / 60.0;
begin
    return query
    with hit as (
        insert into public.sie_rate_limit_buckets as b (
            bucket_key, tokens, updated_at, window_started_at,
            window_requests, window_rejected, total_requests, total_rejected,
            last_request_at, last_allowed
        )
        values (p_key, v_capacity - 1, now(), now(), 1, 0, 1, 0, now(), true)
        on conflict (bucket_key) do update set
            tokens = case
                when public.sie_rl_available(b.tokens, b.updated_at, v_capacity, v_refill) >= 1
                then public.sie_rl_available(b.tokens, b.updated_at, v_capacity, v_refill) - 1
                else public.sie_rl_available(b.tokens, b.updated_at, v_capacity, v_refill)
            end,
            last_allowed = public.sie_rl_available(b.tokens, b.updated_at, v_capacity, v_refill) >= 1,
            updated_at = now(),
            last_request_at = now(),
            window_started_at = case
                when now() - b.window_started_at >= interval '1 minute' then now()
                else b.window_started_at end,
            window_requests = case
                when now() - b.window_started_at >= interval '1 minute' then 1
                else b.window_requests + 1 end,
            window_rejected = case
                when now() - b.window_started_at >= interval '1 minute'
                    then case when public.sie_rl_available(b.tokens, b.updated_at, v_capacity, v_refill) >= 1 then 0 else 1 end
                else b.window_rejected
                    + case when public.sie_rl_available(b.tokens, b.updated_at, v_capacity, v_refill) >= 1 then 0 else 1 end
            end,
            total_requests = b.total_requests + 1,
            total_rejected = b.total_rejected
                + case when public.sie_rl_available(b.tokens, b.updated_at, v_capacity, v_refill) >= 1 then 0 else 1 end
        returning b.tokens, b.last_allowed
    )
    select hit.tokens, hit.last_allowed from hit;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.step_up_fresh()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce((
    select s.expires_at > now()
       and s.session_id is not distinct from public._jwt_session_id()
      from public.privileged_step_ups s
     where s.user_id = auth.uid()
  ), false)
  and public.is_platform_owner();
$function$
;

CREATE OR REPLACE FUNCTION public.storage_ticket_id(p_name text)
 RETURNS uuid
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare parts text[]; v uuid;
begin
  parts := string_to_array(coalesce(p_name,''), '/');
  -- عمق 3: الجزء الثاني هو التذكرة
  if array_length(parts,1) >= 3 then
    begin v := parts[2]::uuid; return v; exception when others then null; end;
  end if;
  -- عمق 2: الجزء الأول هو التذكرة
  if array_length(parts,1) >= 2 then
    begin v := parts[1]::uuid; return v; exception when others then null; end;
  end if;
  return null;
end $function$
;

CREATE OR REPLACE FUNCTION public.sub_user_create_context()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.submit_my_phone(p_phone text, p_has_whatsapp boolean DEFAULT true, p_whatsapp_phone text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_phone text;
  v_wa    text;
begin
  if auth.uid() is null then
    raise exception 'لا توجد جلسة' using errcode = '42501';
  end if;

  v_phone := public.normalize_phone(p_phone);
  if v_phone is null then
    raise exception 'رقم الهاتف غير صحيح' using errcode = '22023';
  end if;

  -- تفرّد الرقم: رسالة واضحة بدل خطأ قاعدة بيانات خام
  if exists (select 1 from public.profiles p
              where p.id <> auth.uid()
                and public.normalize_phone(p.phone) = v_phone) then
    raise exception 'رقم الهاتف مسجّل بحساب آخر بالفعل' using errcode = '23505';
  end if;

  if p_has_whatsapp then
    v_wa := v_phone;
  else
    v_wa := public.normalize_phone(p_whatsapp_phone);
    if p_whatsapp_phone is not null and btrim(p_whatsapp_phone) <> '' and v_wa is null then
      raise exception 'رقم واتساب غير صحيح' using errcode = '22023';
    end if;
    if v_wa is not null and exists (
         select 1 from public.profiles p
          where p.id <> auth.uid() and public.normalize_phone(p.whatsapp_phone) = v_wa) then
      raise exception 'رقم واتساب مسجّل بحساب آخر بالفعل' using errcode = '23505';
    end if;
  end if;

  update public.profiles
     set phone = v_phone,
         whatsapp_phone = v_wa
   where id = auth.uid();

  return jsonb_build_object('ok', true, 'phone', v_phone, 'whatsapp_phone', v_wa);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.subscription_purchase_check(p_plan text, p_is_renewal boolean DEFAULT false, p_user_id uuid DEFAULT auth.uid())
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_offered text[]; v_owned text[]; v_missing text[]; v_same_active boolean;
begin
  if p_user_id is null then
    return jsonb_build_object('allowed', false, 'code', 'not_authenticated',
                              'reason', 'يجب تسجيل الدخول أولًا');
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

  if p_is_renewal then
    if v_same_active then
      return jsonb_build_object('allowed', true, 'code', 'renewal', 'reason', 'تجديد اشتراك قائم');
    end if;
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
$function$
;

CREATE OR REPLACE FUNCTION public.subscription_upgrade_quote(p_plan text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid(); v_cur public.whatsapp_subscriptions%rowtype;
  v_owned text[]; v_offered text[]; v_added text[];
  v_old_price numeric; v_new_price numeric;
  v_remaining int; v_cycle int; v_amount numeric; v_currency text;
begin
  if v_uid is null then return jsonb_build_object('eligible', false, 'code', 'not_authenticated'); end if;
  if not exists (select 1 from public.subscription_plans where key = p_plan and is_active) then
    return jsonb_build_object('eligible', false, 'code', 'unknown_plan');
  end if;

  select * into v_cur from public.whatsapp_subscriptions s
   where s.user_id = v_uid and s.status = 'active'
     and s.start_date <= now() and s.end_date > now()
   order by s.end_date desc limit 1;

  if v_cur.id is null then return jsonb_build_object('eligible', false, 'code', 'no_active_subscription'); end if;
  if v_cur.plan = p_plan then return jsonb_build_object('eligible', false, 'code', 'duplicate_plan'); end if;

  v_owned := public.owned_feature_keys(v_uid);
  v_offered := public.plan_feature_keys(p_plan);
  select coalesce(array_agg(f), '{}'::text[]) into v_added
    from unnest(v_offered) f where not (f = any(v_owned));
  if array_length(v_added, 1) is null then
    return jsonb_build_object('eligible', false, 'code', 'redundant');
  end if;

  v_old_price := public.plan_price(v_cur.plan, v_cur.billing_cycle);
  v_new_price := public.plan_price(p_plan, v_cur.billing_cycle);
  if v_old_price is null or v_new_price is null then
    return jsonb_build_object('eligible', false, 'code', 'price_missing');
  end if;
  if v_new_price <= v_old_price then
    return jsonb_build_object('eligible', false, 'code', 'not_an_upgrade');
  end if;

  v_remaining := greatest(0, ceil (extract(epoch from (v_cur.end_date - now()))            / 86400))::int;
  v_cycle     := greatest(1, round(extract(epoch from (v_cur.end_date - v_cur.start_date)) / 86400))::int;
  v_amount    := round((v_new_price - v_old_price) * v_remaining::numeric / v_cycle, 2);

  select currency into v_currency from public.subscription_plans where key = p_plan;

  return jsonb_build_object(
    'eligible', true, 'code', 'upgrade', 'currency', coalesce(v_currency, 'USD'),
    'current', jsonb_build_object('subscription_id', v_cur.id, 'plan', v_cur.plan,
      'plan_name_ar', (select coalesce(name_ar, name, v_cur.plan) from public.subscription_plans where key = v_cur.plan),
      'billing_cycle', v_cur.billing_cycle, 'start_date', v_cur.start_date,
      'end_date', v_cur.end_date, 'price', v_old_price),
    'target', jsonb_build_object('plan', p_plan,
      'plan_name_ar', (select coalesce(name_ar, name, p_plan) from public.subscription_plans where key = p_plan),
      'price', v_new_price),
    'remaining_days', v_remaining, 'cycle_days', v_cycle,
    'price_difference', v_new_price - v_old_price, 'amount_due', v_amount,
    'next_renewal_price', v_new_price, 'added_features', to_jsonb(v_added));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.supervises(p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_user_id is not null
     and not public.preview_mode()
     and exists (
           select 1 from public.profiles p
            where p.id = p_user_id
              and p.super_user_id = auth.uid()
         );
$function$
;

CREATE OR REPLACE FUNCTION public.sync_company_owner_role()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update public.profiles
     set role = 'company_admin'
   where id = new.user_id
     and coalesce(role, '') not in ('platform_owner', 'admin', 'support')
     and coalesce(role, '') is distinct from 'company_admin';
  if tg_op = 'UPDATE' and old.user_id is distinct from new.user_id then
    update public.profiles
       set role = 'user'
     where id = old.user_id
       and coalesce(role, '') = 'company_admin'
       and not public.owns_a_company(old.user_id);
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sync_company_role()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_target text;
begin
  if coalesce(new.role, '') in ('platform_owner', 'admin', 'support') then
    return new;
  end if;
  if public.owns_a_company(new.id) then
    v_target := 'company_admin';
  elsif new.super_user_id is not null
        and exists (select 1 from public.companies c where c.user_id = new.super_user_id) then
    v_target := 'company_user';
  elsif coalesce(new.role, '') in ('company_admin', 'company_user') then
    v_target := 'user';
  else
    return new;
  end if;
  new.role := v_target;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sync_profile_from_auth()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.email is distinct from old.email then
    begin
      update public.profiles set email = new.email where id = new.id;
    exception when unique_violation then
      raise warning 'sync_profile_from_auth: email for % not mirrored (unique conflict)', new.id;
    end;
  end if;
  if new.encrypted_password is distinct from old.encrypted_password then
    update public.profiles set last_password_change = now() where id = new.id;
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.ticket_account_owner(p_user_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce((select p.super_user_id from public.profiles p where p.id = p_user_id), p_user_id);
$function$
;

CREATE OR REPLACE FUNCTION public.ticket_in_my_scope(p_ticket_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select auth.uid() is not null
     and exists (
           select 1
             from public.tickets t
            where t.id = p_ticket_id
              and (t.user_id = auth.uid() or public.supervises(t.user_id))
         );
$function$
;

CREATE OR REPLACE FUNCTION public.ticket_invoice_status(p_ticket_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_inv public.accounting_invoices;
begin
  if not public.is_platform_staff() then
    raise exception 'حالة الفاتورة متاحة لطاقم المنصة فقط' using errcode = '42501';
  end if;

  select * into v_inv from public.accounting_invoices
   where ticket_id = p_ticket_id
   order by created_at desc
   limit 1;

  if not found then
    return jsonb_build_object('state', 'none');
  end if;

  return jsonb_build_object(
    'state',          case when v_inv.reply_id is null then 'ready' else 'attached' end,
    'invoice_number', v_inv.invoice_number,
    'total',          v_inv.total,
    'currency',       v_inv.currency
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.ticket_quota_status(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_owner        uuid := public.ticket_account_owner(p_user_id);
  v_period_start timestamptz := date_trunc('month', now() at time zone 'Africa/Cairo') at time zone 'Africa/Cairo';
  v_period_end   timestamptz := (date_trunc('month', now() at time zone 'Africa/Cairo') + interval '1 month') at time zone 'Africa/Cairo';
  v_plan         text;
  v_sub          public.whatsapp_subscriptions%rowtype;
  v_unlimited    boolean;
  v_limit        integer;
  v_used         integer;
  v_billing      integer;
begin
  if p_user_id is null then
    return null;
  end if;

  select s.* into v_sub
    from public.whatsapp_subscriptions s
    join public.plan_ticket_quotas q on q.plan_key = s.plan
   where s.user_id = v_owner and s.status = 'active'
     and s.start_date <= now() and s.end_date > now()
   order by (q.monthly_tickets is null) desc, q.monthly_tickets desc nulls first, s.end_date desc
   limit 1;

  v_plan := coalesce(v_sub.plan, 'free');
  select q.monthly_tickets is null, q.monthly_tickets into v_unlimited, v_limit
    from public.plan_ticket_quotas q where q.plan_key = v_plan;
  if not found then
    v_unlimited := false; v_limit := 20;
  end if;

  select count(*) into v_used
    from public.tickets t
   where (t.user_id = v_owner or t.user_id in (select p.id from public.profiles p where p.super_user_id = v_owner))
     and t.created_at >= v_period_start
     and coalesce(t.category, '') not in ('subscription', 'whatsapp_wallet_topup');

  select count(*) into v_billing
    from public.tickets t
   where (t.user_id = v_owner or t.user_id in (select p.id from public.profiles p where p.super_user_id = v_owner))
     and t.created_at >= v_period_start
     and t.category in ('subscription', 'whatsapp_wallet_topup');

  return jsonb_build_object(
    'plan_key',          v_plan,
    'plan_name_ar',      coalesce((select coalesce(sp.name_ar, sp.name) from public.subscription_plans sp where sp.key = v_plan), 'الخطة المجانية'),
    'is_free',           v_sub.id is null,
    'subscription_id',   v_sub.id,
    'subscription_end',  v_sub.end_date,
    'billing_cycle',     v_sub.billing_cycle,
    'account_owner',     v_owner,
    'shared_account',    v_owner is distinct from p_user_id,
    'unlimited',         coalesce(v_unlimited, false),
    'monthly_limit',     case when v_unlimited then null else v_limit end,
    'used',              v_used,
    'remaining',         case when v_unlimited then null else greatest(0, v_limit - v_used) end,
    'billing_used',      v_billing,
    'billing_limit',     5,
    'period_start',      v_period_start,
    'resets_at',         v_period_end);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.touch_customer_sie_access_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$ begin new.updated_at = now(); return new; end; $function$
;

CREATE OR REPLACE FUNCTION public.touch_sie_settings_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
    new.updated_at := now();
    new.updated_by := auth.uid();
    return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.track_first_response()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_owner uuid;
begin
  if new.is_internal is true then
    return new;
  end if;

  select t.user_id into v_owner from public.tickets t where t.id = new.ticket_id;

  if v_owner is null or new.user_id = v_owner then
    return new;
  end if;

  perform set_config('app.bypass_ticket_restrictions', 'on', true);

  update public.tickets
     set first_response_at = now()
   where id = new.ticket_id
     and first_response_at is null;

  perform set_config('app.bypass_ticket_restrictions', 'off', true);

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.track_service_status_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if tg_op = 'INSERT' then
    new.status_changed_at := coalesce(new.status_changed_at, now());
  elsif new.status is distinct from old.status then
    new.status_changed_at := now();
    new.updated_at := now();
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.transfer_points_from_central(target_user_email text, amount_to_transfer bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    target_uid UUID;
    current_central_balance BIGINT;
    admin_uid UUID;
    transaction_id UUID;
    user_wallet_before BIGINT;
    user_wallet_after BIGINT;
BEGIN
    admin_uid := auth.uid();

    IF COALESCE(auth.jwt() ->> 'email', '') != 'support@mad3oom.online' THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'غير مصرح لك بالقيام بهذه العملية',
            'error_code', 'UNAUTHORIZED'
        );
    END IF;

    IF target_user_email IS NULL OR target_user_email = '' THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'بريد العميل مطلوب',
            'error_code', 'INVALID_EMAIL'
        );
    END IF;

    IF amount_to_transfer IS NULL OR amount_to_transfer <= 0 THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'يجب أن يكون عدد النقاط أكبر من صفر',
            'error_code', 'INVALID_AMOUNT'
        );
    END IF;

    SELECT id INTO target_uid FROM auth.users WHERE email = target_user_email;

    IF target_uid IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'المستخدم غير موجود: ' || target_user_email,
            'error_code', 'USER_NOT_FOUND'
        );
    END IF;

    SELECT balance INTO current_central_balance FROM central_wallet LIMIT 1;

    IF current_central_balance IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'المحفظة المركزية غير موجودة',
            'error_code', 'WALLET_NOT_FOUND'
        );
    END IF;

    IF current_central_balance < amount_to_transfer THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'رصيد المحفظة المركزية غير كافٍ. الرصيد الحالي: ' || current_central_balance,
            'error_code', 'INSUFFICIENT_BALANCE',
            'current_balance', current_central_balance
        );
    END IF;

    SELECT available_points INTO user_wallet_before
    FROM user_wallets
    WHERE user_id = target_uid;

    IF user_wallet_before IS NULL THEN
        user_wallet_before := 0;
    END IF;

    UPDATE central_wallet
    SET balance = balance - amount_to_transfer,
        total_transferred = total_transferred + amount_to_transfer,
        updated_at = NOW()
    WHERE id = (SELECT id FROM central_wallet LIMIT 1);

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'فشل تحديث المحفظة المركزية',
            'error_code', 'UPDATE_FAILED'
        );
    END IF;

    INSERT INTO user_wallets (user_id, available_points, total_points, created_at, updated_at)
    VALUES (target_uid, amount_to_transfer, amount_to_transfer, NOW(), NOW())
    ON CONFLICT (user_id) DO UPDATE
    SET available_points = user_wallets.available_points + amount_to_transfer,
        total_points = user_wallets.total_points + amount_to_transfer,
        updated_at = NOW();

    SELECT available_points INTO user_wallet_after
    FROM user_wallets
    WHERE user_id = target_uid;

    IF user_wallet_after != (user_wallet_before + amount_to_transfer) THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'فشل التحقق من تحديث محفظة العميل',
            'error_code', 'VERIFICATION_FAILED',
            'expected', user_wallet_before + amount_to_transfer,
            'actual', user_wallet_after
        );
    END IF;

    INSERT INTO central_wallet_transactions (
        admin_id,
        target_user_id,
        amount,
        transaction_type,
        previous_balance,
        new_balance,
        created_at
    )
    VALUES (
        admin_uid,
        target_uid,
        amount_to_transfer,
        'transfer',
        current_central_balance,
        current_central_balance - amount_to_transfer,
        NOW()
    )
    RETURNING id INTO transaction_id;

    RETURN jsonb_build_object(
        'success', true,
        'message', 'تم تحويل النقاط بنجاح',
        'transaction_id', transaction_id,
        'amount_transferred', amount_to_transfer,
        'user_email', target_user_email,
        'user_new_balance', user_wallet_after,
        'central_wallet_new_balance', current_central_balance - amount_to_transfer
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'message', 'حدث خطأ غير متوقع: ' || SQLERRM,
        'error_code', 'SYSTEM_ERROR'
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_badges_on_forum_reply()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if NEW.author_id is not null then
    perform public.evaluate_customer_badges(NEW.author_id);
  end if;
  return NEW;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_badges_on_forum_thread()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if NEW.author_id is not null then
    perform public.evaluate_customer_badges(NEW.author_id);
  end if;
  return NEW;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_badges_on_points()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if NEW.points is distinct from OLD.points then
    perform public.evaluate_customer_badges(NEW.id);
  end if;
  return NEW;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_badges_on_rating()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.evaluate_customer_badges(NEW.user_id);
  return NEW;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_badges_on_reply()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_owner uuid;
begin
  select user_id into v_owner from public.tickets where id = NEW.ticket_id;
  if v_owner is not null then
    perform public.evaluate_customer_badges(v_owner);
  end if;
  return NEW;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_badges_on_subdomain()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if NEW.status = 'success' and NEW.user_id is not null then
    perform public.evaluate_customer_badges(NEW.user_id);
  end if;
  return NEW;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_badges_on_ticket()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.evaluate_customer_badges(NEW.user_id);
  return NEW;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_badges_on_whatsapp()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if NEW.status = 'active' and NEW.user_id is not null then
    perform public.evaluate_customer_badges(NEW.user_id);
  end if;
  return NEW;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.trigger_assign_channel_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$ BEGIN IF NEW.channel_id IS NULL THEN NEW.channel_id := generate_unique_channel_id(); END IF; RETURN NEW; END; $function$
;

CREATE OR REPLACE FUNCTION public.unarchive_ticket_on_external_reply()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  ticket_owner_id uuid;
BEGIN
  -- نتجاهل الردود الداخلية، العميل مش يفترض يشوفها فما لها لازمة تلغي الأرشفة
  IF NEW.is_internal IS TRUE THEN
    RETURN NEW;
  END IF;

  SELECT user_id INTO ticket_owner_id FROM public.tickets WHERE id = NEW.ticket_id;

  -- لو الرد جاي من حد مختلف عن مالك التذكرة (يعني أدمن بيرد على تذكرة عميل)
  -- نلغي الأرشفة تلقائيًا حتى يظهر الرد الجديد في لوحة العميل
  IF ticket_owner_id IS NOT NULL AND NEW.user_id IS DISTINCT FROM ticket_owner_id THEN
    UPDATE public.tickets
    SET archived_by_customer = false,
        archived_at = NULL
    WHERE id = NEW.ticket_id
      AND archived_by_customer = true;
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_bot_user_states_last_interaction()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
    NEW.last_interaction = NOW();
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_companies_timestamp()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_flow_templates_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_forum_counts()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$ BEGIN IF (TG_OP = 'INSERT') THEN IF (TG_TABLE_NAME = 'forum_threads') THEN UPDATE forum_subforums SET threads_count = threads_count + 1, last_activity_at = NOW() WHERE id = NEW.subforum_id; ELSIF (TG_TABLE_NAME = 'forum_replies') THEN UPDATE forum_threads SET replies_count = replies_count + 1, last_post_at = NOW() WHERE id = NEW.thread_id; UPDATE forum_subforums SET posts_count = posts_count + 1, last_activity_at = NOW() WHERE id = (SELECT subforum_id FROM forum_threads WHERE id = NEW.thread_id); END IF; ELSIF (TG_OP = 'DELETE') THEN IF (TG_TABLE_NAME = 'forum_threads') THEN UPDATE forum_subforums SET threads_count = threads_count - 1 WHERE id = OLD.subforum_id; ELSIF (TG_TABLE_NAME = 'forum_replies') THEN UPDATE forum_threads SET replies_count = replies_count - 1 WHERE id = OLD.thread_id; UPDATE forum_subforums SET posts_count = posts_count - 1 WHERE id = (SELECT subforum_id FROM forum_threads WHERE id = OLD.thread_id); END IF; END IF; RETURN NULL; END; $function$
;

CREATE OR REPLACE FUNCTION public.update_individuals_timestamp()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_scheduled_messages_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $function$
;

CREATE OR REPLACE FUNCTION public.upsert_my_company(p_company_name text, p_commercial_registration_number text, p_commercial_registration_expiry date, p_company_email text DEFAULT NULL::text, p_company_phone text DEFAULT NULL::text, p_address text DEFAULT NULL::text, p_city text DEFAULT NULL::text, p_country text DEFAULT NULL::text, p_tax_id text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid        uuid := auth.uid();
  v_name       text := nullif(btrim(coalesce(p_company_name, '')), '');
  v_cr         text := nullif(btrim(coalesce(p_commercial_registration_number, '')), '');
  v_existing   uuid;
  v_member_of  uuid;
begin
  if v_uid is null then
    raise exception 'يجب تسجيل الدخول أولًا';
  end if;

  if v_name is null or char_length(v_name) < 2 then
    raise exception 'اسم الشركة مطلوب';
  end if;

  if v_cr is null or char_length(v_cr) < 3 then
    raise exception 'رقم السجل التجاري مطلوب';
  end if;

  if p_commercial_registration_expiry is null then
    raise exception 'تاريخ انتهاء السجل التجاري مطلوب';
  end if;

  select id into v_existing from public.companies where user_id = v_uid;

  if v_existing is null then
    -- عضو في شركة قائمة (مستخدم فرعي) لا ينشئ شركة موازية
    v_member_of := public.current_company_id();
    if v_member_of is not null then
      raise exception 'حسابك عضو في شركة قائمة بالفعل';
    end if;

    -- رقم السجل التجاري فريد على مستوى المنصة (قيد UNIQUE موجود أصلًا).
    -- الفحص هنا لإعطاء رسالة عربية واضحة بدل خطأ قاعدة بيانات خام.
    if exists (select 1 from public.companies where commercial_registration_number = v_cr) then
      raise exception 'رقم السجل التجاري مسجل بالفعل';
    end if;

    insert into public.companies (
      user_id, company_name, commercial_registration_number,
      commercial_registration_expiry, company_email, company_phone,
      address, city, country, tax_id
    ) values (
      v_uid, v_name, v_cr,
      p_commercial_registration_expiry, nullif(btrim(coalesce(p_company_email, '')), ''),
      nullif(btrim(coalesce(p_company_phone, '')), ''),
      nullif(btrim(coalesce(p_address, '')), ''),
      nullif(btrim(coalesce(p_city, '')), ''),
      nullif(btrim(coalesce(p_country, '')), ''),
      nullif(btrim(coalesce(p_tax_id, '')), '')
    )
    returning id into v_existing;

    return v_existing;
  end if;

  if exists (
    select 1 from public.companies
     where commercial_registration_number = v_cr and id <> v_existing
  ) then
    raise exception 'رقم السجل التجاري مسجل بالفعل';
  end if;

  update public.companies
     set company_name                   = v_name,
         commercial_registration_number = v_cr,
         commercial_registration_expiry = p_commercial_registration_expiry,
         company_email = coalesce(nullif(btrim(coalesce(p_company_email, '')), ''), company_email),
         company_phone = coalesce(nullif(btrim(coalesce(p_company_phone, '')), ''), company_phone),
         address       = coalesce(nullif(btrim(coalesce(p_address, '')), ''), address),
         city          = coalesce(nullif(btrim(coalesce(p_city, '')), ''), city),
         country       = coalesce(nullif(btrim(coalesce(p_country, '')), ''), country),
         tax_id        = coalesce(nullif(btrim(coalesce(p_tax_id, '')), ''), tax_id)
   where id = v_existing;

  return v_existing;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.wa_insert_inbound_message(p_user_id uuid, p_wa_message_id text, p_from_number text, p_to_number text, p_contact_bsuid text, p_message_text text, p_message_type text, p_waba_id text, p_timestamp timestamp with time zone, p_raw_data jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid;
  v_wamid text := nullif(btrim(p_wa_message_id), '');
begin
  insert into public.messages (user_id, from_number, to_number, contact_bsuid, message_text, message_type,
                               direction, status, waba_id, "timestamp", raw_data, wa_message_id)
  values (p_user_id, p_from_number, p_to_number, p_contact_bsuid, p_message_text, p_message_type,
          'inbound', 'received', p_waba_id, coalesce(p_timestamp, now()), p_raw_data, v_wamid)
  on conflict (user_id, wa_message_id) where direction = 'inbound' do nothing
  returning id into v_id;
  -- NULL = نفس الرسالة اتخزّنت قبل كده (إعادة إرسال من ميتا). رسالة من غير
  -- معرّف مابتتعارضش أبدًا (NULL مش مساوي لـNULL) فبتتدرج زي الأول.
  return v_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.wa_is_billing_admin()
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public.is_whatsapp_billing_admin();
$function$
;

CREATE OR REPLACE FUNCTION public.wa_set_integration_billing_method(p_integration_id uuid, p_billing_method text)
 RETURNS integrations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.integrations;
begin
  if not public.is_whatsapp_billing_admin() then
    raise exception 'غير مصرح لك بتغيير وسيلة احتساب تكلفة الرسائل';
  end if;

  if p_billing_method not in ('wallet', 'meta') then
    raise exception 'قيمة غير صالحة لوسيلة الفوترة: %', p_billing_method;
  end if;

  select * into v_row from public.integrations
  where id = p_integration_id and provider = 'whatsapp'
  for update;

  if not found then
    raise exception 'لم يتم العثور على ربط واتساب بهذا المعرّف';
  end if;

  update public.integrations
    set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{billing_method}', to_jsonb(p_billing_method), true)
    where id = p_integration_id
    returning * into v_row;

  return v_row;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.wa_wallet_adjust(p_user_id uuid, p_amount numeric, p_type text, p_description text DEFAULT NULL::text, p_ticket_id uuid DEFAULT NULL::uuid)
 RETURNS whatsapp_wallet_transactions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_wallet public.whatsapp_wallets;
  v_before numeric(12,2);
  v_after numeric(12,2);
  v_tx public.whatsapp_wallet_transactions;
BEGIN
  IF NOT public.wa_wallet_is_staff() THEN
    RAISE EXCEPTION 'هذا الإجراء متاح فقط لفريق الدعم والإدارة';
  END IF;

  IF p_type NOT IN ('topup','manual_adjustment','refund','correction') THEN
    RAISE EXCEPTION 'نوع عملية غير صالح: %', p_type;
  END IF;

  IF p_amount = 0 THEN
    RAISE EXCEPTION 'قيمة العملية لا يجوز أن تكون صفر';
  END IF;

  PERFORM public.wa_wallet_get_or_create(p_user_id);

  SELECT * INTO v_wallet FROM public.whatsapp_wallets WHERE user_id = p_user_id FOR UPDATE;

  v_before := v_wallet.balance;
  v_after := v_before + p_amount;

  IF v_after < 0 THEN
    RAISE EXCEPTION 'لا يمكن أن يصبح الرصيد سالبًا';
  END IF;

  UPDATE public.whatsapp_wallets
    SET balance = v_after, updated_at = now()
    WHERE id = v_wallet.id;

  INSERT INTO public.whatsapp_wallet_transactions (
    wallet_id, user_id, amount, balance_before, balance_after,
    transaction_type, description, ticket_id, performed_by
  ) VALUES (
    v_wallet.id, p_user_id, p_amount, v_before, v_after,
    p_type, p_description, p_ticket_id, auth.uid()
  ) RETURNING * INTO v_tx;

  RETURN v_tx;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.wa_wallet_charge_message(p_user_id uuid, p_amount numeric, p_description text DEFAULT NULL::text, p_ticket_id uuid DEFAULT NULL::uuid)
 RETURNS whatsapp_wallet_transactions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_wallet public.whatsapp_wallets;
  v_before numeric(12,2);
  v_after numeric(12,2);
  v_tx public.whatsapp_wallet_transactions;
BEGIN
  IF NOT (p_user_id = auth.uid() OR public.wa_wallet_is_staff()
          OR coalesce(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'غير مصرح لك بتنفيذ هذا الإجراء';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'قيمة تكلفة الرسالة غير صالحة';
  END IF;

  PERFORM public.wa_wallet_get_or_create(p_user_id);

  SELECT * INTO v_wallet FROM public.whatsapp_wallets WHERE user_id = p_user_id FOR UPDATE;

  v_before := v_wallet.balance;

  IF v_before < p_amount THEN
    RAISE EXCEPTION 'insufficient_balance';
  END IF;

  v_after := v_before - p_amount;

  UPDATE public.whatsapp_wallets
    SET balance = v_after, updated_at = now()
    WHERE id = v_wallet.id;

  INSERT INTO public.whatsapp_wallet_transactions (
    wallet_id, user_id, amount, balance_before, balance_after,
    transaction_type, description, ticket_id, performed_by
  ) VALUES (
    v_wallet.id, p_user_id, -p_amount, v_before, v_after,
    'message_charge', p_description, p_ticket_id, auth.uid()
  ) RETURNING * INTO v_tx;

  RETURN v_tx;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.wa_wallet_check_sufficient(p_user_id uuid, p_amount numeric)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_balance numeric(12,2);
BEGIN
  IF NOT (p_user_id = auth.uid() OR public.wa_wallet_is_staff()
          OR coalesce(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'غير مصرح لك بالوصول لهذا الرصيد';
  END IF;

  PERFORM public.wa_wallet_get_or_create(p_user_id);

  SELECT balance INTO v_balance FROM public.whatsapp_wallets WHERE user_id = p_user_id;
  RETURN COALESCE(v_balance, 0) >= p_amount;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.wa_wallet_get_or_create(p_user_id uuid)
 RETURNS whatsapp_wallets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_wallet public.whatsapp_wallets;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id مطلوب';
  END IF;

  IF NOT (p_user_id = auth.uid() OR public.wa_wallet_is_staff()) THEN
    RAISE EXCEPTION 'غير مصرح لك بالوصول لهذا الرصيد';
  END IF;

  SELECT * INTO v_wallet FROM public.whatsapp_wallets WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    INSERT INTO public.whatsapp_wallets (user_id) VALUES (p_user_id)
    ON CONFLICT (user_id) DO NOTHING
    RETURNING * INTO v_wallet;

    IF v_wallet.id IS NULL THEN
      SELECT * INTO v_wallet FROM public.whatsapp_wallets WHERE user_id = p_user_id;
    END IF;
  END IF;

  RETURN v_wallet;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.wa_wallet_is_staff()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN public.is_admin() OR EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'support'
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.wa_wallet_recompute_balance(p_user_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_wallet_id uuid;
  v_sum numeric(12,2);
BEGIN
  IF NOT (p_user_id = auth.uid() OR public.wa_wallet_is_staff()) THEN
    RAISE EXCEPTION 'غير مصرح لك بالوصول لهذا الرصيد';
  END IF;

  SELECT id INTO v_wallet_id FROM public.whatsapp_wallets WHERE user_id = p_user_id;
  IF v_wallet_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_sum
  FROM public.whatsapp_wallet_transactions
  WHERE wallet_id = v_wallet_id;

  RETURN v_sum;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.waitlist_drop_auto_entry_on_role()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.role in ('admin', 'support', 'platform_owner', 'company_admin', 'company_user')
     and new.role is distinct from old.role then
    delete from public.waitlist_entries w
     where w.approved_user_id = new.id and w.status = 'pending' and w.source <> 'form';
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.waitlist_enqueue_new_account()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_email    text := lower(btrim(new.email));
  v_provider text;
  v_meta     jsonb;
  v_name     text;
begin
  if v_email is null or v_email !~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' then
    return new;
  end if;
  if public.account_is_whitelisted(new.id) then
    return new;
  end if;

  update public.waitlist_entries w
     set approved_user_id = new.id
   where lower(w.email) = v_email and w.status = 'pending' and w.approved_user_id is null;
  if found then
    return new;
  end if;

  if exists (select 1 from public.waitlist_entries w
              where w.status <> 'rejected'
                and (w.approved_user_id = new.id or lower(w.email) = v_email)) then
    return new;
  end if;

  select u.raw_app_meta_data->>'provider', u.raw_user_meta_data
    into v_provider, v_meta
    from auth.users u where u.id = new.id;

  v_name := coalesce(
    nullif(btrim(new.full_name), ''),
    nullif(btrim(concat_ws(' ', new.first_name, new.last_name)), ''),
    nullif(btrim(v_meta->>'full_name'), ''),
    nullif(btrim(v_meta->>'name'), ''),
    split_part(v_email, '@', 1));

  insert into public.waitlist_entries (name, email, phone, status, approved_user_id, source)
  values (v_name, v_email, new.phone, 'pending', new.id,
          case when v_provider in ('google', 'github') then v_provider else 'email' end)
  on conflict do nothing;

  return new;
exception when others then
  raise warning 'waitlist_enqueue_new_account(%): %', new.id, sqlerrm;
  return new;
end;
$function$
;

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
$function$
;

CREATE OR REPLACE FUNCTION public.wf_demo_get_showcase()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
    'workflow', (
      select jsonb_build_object(
        'id', w.id,
        'name', w.name,
        'description', w.description,
        'status', w.status,
        'is_active', w.is_active,
        'definition', v.definition,
        'updated_at', w.updated_at
      )
      from public.wf_workflows w
      join public.wf_workflow_versions v on v.id = w.published_version_id
      where w.name = '[عرض توضيحي] تذكير بالتذاكر العاجلة'
      limit 1
    ),
    'node_types', (
      select jsonb_agg(jsonb_build_object(
        'key', key, 'category', category, 'name_ar', name_ar,
        'description', description, 'color', color, 'sort_order', sort_order
      ) order by category, sort_order)
      from public.wf_node_types
      where is_active = true
    )
  );
$function$
;

CREATE OR REPLACE FUNCTION public.wf_is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = (SELECT auth.uid())
      AND role = 'admin'
  );
$function$
;

CREATE OR REPLACE FUNCTION public.wf_is_staff()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ select public.is_platform_staff(); $function$
;

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
$function$
;
