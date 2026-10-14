-- ============================================================================
-- 097_ticket_scope_isolation.sql
--   A2 — نطاق التذكرة، مفتاح عزل الشركات، وطلبات الوصول المؤقت المسجَّلة.
--
-- القرارات: D9 والسؤال 8 (لا وصول افتراضي لطاقم المنصة إلى بيانات الشركة الخاصة؛ مالك المنصة
--   يوافق على كل طلب؛ الطلب محدد النطاق ومؤقت — 24 ساعة افتراضيًا و7 أيام حدًا أقصى — ومسجَّل
--   وقابل للإلغاء، ولا موافقة ذاتية)، والسؤال 16 (قواعد قابلة للضبط لمن يحق له الطلب)،
--   والسؤال 17 (مفتاح العزل يبقى مطفأ حتى تنجح الاختبارات وتصدر موافقة صريحة منفصلة).
--
-- النموذج
--   tickets.scope        'company' | 'mad3oom_support'. التذكرة بين عميل الشركة وفريقها = company
--                        (company_id = الشركة). تذاكر الحسابات المستقلة ومالكي الشركات وموظفيها
--                        وطلبات الفوترة الشخصية (category = 'subscription') = mad3oom_support.
--   tickets.company_id   يُختم عند الإنشاء (محفّز a_ticket_scope_stamp) ولا يتغير بعده: النقل بين
--                        الشركات تذكرة جديدة (H2). بلا مفتاح أجنبي عمدًا: حذف شركة لا يحوّل
--                        تذاكرها الخاصة إلى تذاكر منصة (تبقى لصاحبها وحده).
--
-- المفاتيح (كلها مطفأة)
--   company_isolation_enforced   سياسات تقييدية على التذاكر وردودها ومرفقاتها ونشاطها وتقييماتها
--                                ووسومها وملفاتها في التخزين، وبوابات القنوات الجانبية (إشعارات
--                                الطاقم، Telegram، webhooks، سير العمل، التوزيع الآلي، SLA، MCP).
--                                مطفأ = السلوك حرفيًا كما قبل 097.
--   data_access_grants_enabled   طلبات الوصول ومنحه والقراءة عبره.
--
-- إصلاح دائم (لا يتبع مفتاحًا): مرفقات الملاحظات الداخلية كانت ظاهرة لصاحب التذكرة (الجدول
--   والملف). الآن تتبع قاعدة الرد الداخلي نفسها: طاقم المنصة والسلطة المرتفعة فقط.
--
-- الوصول الممنوح لا يمر عبر RLS: القراءة عبر دوال تسجّل كل نداء في company_access_audit
--   (إلحاقي)، فلا قراءة بلا أثر. والشركة ترى سجل الوصول إلى بياناتها (company_access_log).
--
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/097_ticket_scope_isolation.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public._feature_on(text)', 'public._company_customer_active(uuid,uuid)', 'public._company_staff_role_of(uuid,uuid)',
    'public.owner_critical_ok()', 'public.owner_capability(text)', 'public.log_privileged(text,uuid,jsonb,jsonb)',
    'public.is_platform_staff()', 'public.has_elevated_authority()', 'public.storage_ticket_id(text)',
    'public.check_sla_breaches()', 'public.wf_assign_ticket(uuid,uuid,uuid)', 'public.wf_update_ticket_status(uuid,text,uuid)',
    'public.mcp_admin_update_ticket(uuid,uuid,jsonb)', 'public._ihub_ticket_company(uuid)',
    'public.ihub_intake_convert(uuid,uuid)', 'public.account_is_active()'] loop
    if to_regprocedure(f) is null then
      raise exception '097 يتطلب % (096_company_memberships وما قبله)', f;
    end if;
  end loop;
  if to_regclass('public.company_memberships') is null then
    raise exception '097 يتطلب 096_company_memberships';
  end if;
end $$;


-- ============================================================================
-- 1) المفاتيح
-- ============================================================================
insert into public.platform_feature_switches (key, enabled, description) values
  ('company_isolation_enforced', false,
   'عزل تذاكر الشركات عن طاقم المنصة وقنواته الجانبية (097). يتطلب موافقة صريحة منفصلة قبل التفعيل.'),
  ('data_access_grants_enabled', false,
   'طلبات الوصول المؤقت إلى بيانات شركة بموافقة مالك المنصة، مع تسجيل كل قراءة (097).')
on conflict (key) do nothing;

-- يُقرأ داخل السياسات وشروط المحفّزات، فيلزم أن يُنفَّذ لكل دور يكتب أو يقرأ.
create or replace function public._isolation_on()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public._feature_on('company_isolation_enforced');
$$;
-- يُنفَّذ لكل الأدوار: صلاحية الدالة تُفحص عند تخطيط الاستعلام حتى لو لم تُقيَّم (anon على
-- جدول بلا سماح له كان يرى نتيجة فارغة لا خطأ صلاحية — نُبقي ذلك).
revoke all on function public._isolation_on() from public;
grant execute on function public._isolation_on() to anon, authenticated, service_role;


-- ============================================================================
-- 2) نطاق التذكرة
-- ============================================================================
alter table public.tickets add column if not exists company_id uuid;
alter table public.tickets add column if not exists scope text;
comment on column public.tickets.scope is
  '097: company = بين عميل الشركة وفريقها (خاصة بالشركة)؛ mad3oom_support = مع فريق مدعوم.';
comment on column public.tickets.company_id is
  '097: الشركة التي تخدم التذكرة (scope = company). يُختم عند الإنشاء ولا يتغير.';

-- شركة «العميل» لحساب: السياق الذي اختاره بنفسه (إن كان هو المنشئ)، ثم الأساسية إن كان فيها
-- عميلًا (الموظف في شركته الأساسية يراسل مدعوم)، ثم — بلا أساسية والمفتاح مفعّل — أقدم عضوية عميل.
create or replace function public._ticket_customer_company(p_user uuid)
returns uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_multi   boolean := public._feature_on('multi_company_memberships_enabled');
begin
  if p_user is null then
    return null;
  end if;
  if v_multi and auth.uid() = p_user then
    select x.company_id into v_company from public.customer_company_context x where x.user_id = p_user;
    if v_company is not null and public._company_customer_active(v_company, p_user) then
      return v_company;
    end if;
  end if;
  select m.company_id into v_company from public.company_memberships m
   where m.user_id = p_user and m.status = 'active' and m.is_primary;
  if v_company is not null then
    return case when public._company_customer_active(v_company, p_user) then v_company end;
  end if;
  if v_multi then
    select m.company_id into v_company from public.company_memberships m
     where m.user_id = p_user and m.status = 'active' and public._company_customer_active(m.company_id, p_user)
     order by m.joined_at, m.id limit 1;
  end if;
  return v_company;
end $$;
revoke all on function public._ticket_customer_company(uuid) from public, anon, authenticated;

-- الملء الأولي: تذكرة عميل شركة (أساسية نشطة، ليس موظفًا) = company، والباقي mad3oom_support.
-- لا يغيّر الحالة ولا الأولوية ولا الإسناد، فلا نشاط ولا إشعار ولا webhook (مُثبت في الاختبار).
do $$
begin
  if exists (select 1 from public.tickets where scope is null) then
    perform set_config('app.bypass_ticket_restrictions', 'on', true);
    update public.tickets t
       set company_id = m.company_id, scope = 'company'
      from public.company_memberships m
     where t.scope is null and m.user_id = t.user_id and m.status = 'active' and m.is_primary
       and coalesce(t.category, '') <> 'subscription'
       and public._company_customer_active(m.company_id, t.user_id);
    update public.tickets set scope = 'mad3oom_support' where scope is null;
    perform set_config('app.bypass_ticket_restrictions', 'off', true);
  end if;
end $$;
alter table public.tickets alter column scope set not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tickets_scope_check' and conrelid = 'public.tickets'::regclass) then
    alter table public.tickets add constraint tickets_scope_check
      check (scope in ('company', 'mad3oom_support'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tickets_scope_company_iff' and conrelid = 'public.tickets'::regclass) then
    alter table public.tickets add constraint tickets_scope_company_iff
      check ((scope = 'company') = (company_id is not null));
  end if;
end $$;
create index if not exists tickets_company_scope_idx on public.tickets (company_id, created_at desc) where scope = 'company';

-- الختم عند الإنشاء، والثبات بعده. الاسم يبدأ بـ a_ ليسبق كل محفّزات BEFORE الأخرى
-- (تُنفَّذ أبجديًا)، فترى شروط WHEN أدناه النطاق مختومًا.
create or replace function public._ticket_scope_stamp()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if tg_op = 'UPDATE' then
    if (new.scope is distinct from old.scope or new.company_id is distinct from old.company_id)
       and coalesce(current_setting('app.ticket_scope_admin', true), '') <> 'on' then
      raise exception 'نطاق التذكرة وشركتها لا يتغيران بعد الإنشاء — النقل تذكرة جديدة' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.scope is null and new.company_id is null then
    -- طلبات الفوترة الشخصية لمدعوم دائمًا (السؤال 10)
    new.company_id := case when coalesce(new.category, '') = 'subscription' then null
                           else public._ticket_customer_company(new.user_id) end;
    new.scope := case when new.company_id is null then 'mad3oom_support' else 'company' end;
    return new;
  end if;

  if new.scope = 'mad3oom_support' then
    if new.company_id is not null then
      raise exception 'تذكرة فريق مدعوم لا تحمل شركة' using errcode = '22023';
    end if;
    return new;
  end if;

  if new.scope is not null and new.scope <> 'company' then
    raise exception 'نطاق تذكرة غير معروف' using errcode = '22023';
  end if;
  if coalesce(new.category, '') = 'subscription' then
    raise exception 'طلبات الاشتراك الشخصية تُرسل إلى فريق مدعوم' using errcode = '22023';
  end if;
  if new.company_id is null then
    new.company_id := public._ticket_customer_company(new.user_id);
  end if;
  if new.company_id is null or not public._company_customer_active(new.company_id, new.user_id) then
    raise exception 'صاحب التذكرة ليس عميلًا نشطًا لهذه الشركة' using errcode = '42501';
  end if;
  new.scope := 'company';
  return new;
end $$;
revoke all on function public._ticket_scope_stamp() from public, anon, authenticated;

drop trigger if exists a_ticket_scope_stamp on public.tickets;
create trigger a_ticket_scope_stamp
  before insert or update on public.tickets
  for each row execute function public._ticket_scope_stamp();


-- ============================================================================
-- 3) العزل — سياسات تقييدية خلف المفتاح
-- ============================================================================
-- من يرى تذكرة والعزل مفعّل: صاحبها؛ وطاقم المنصة لتذاكر mad3oom_support؛ وفريق الشركة
-- (المالك أو موظف نشط) لتذاكر شركته. السياسات المسموحة القائمة تبقى تقرر الباقي: هذه تمنع فقط.
create or replace function public._ticket_row_visible(p_user uuid, p_scope text, p_company uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select auth.uid() is not null and (
           p_user = auth.uid()
        or (p_scope = 'mad3oom_support' and (coalesce(public.is_platform_staff(), false)
                                             or coalesce(public.has_elevated_authority(), false)))
        or (p_scope = 'company' and public._company_staff_role_of(p_company, auth.uid()) is not null));
$$;

create or replace function public._ticket_id_visible(p_ticket uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (select 1 from public.tickets t
                  where t.id = p_ticket and public._ticket_row_visible(t.user_id, t.scope, t.company_id));
$$;
revoke all on function public._ticket_row_visible(uuid, text, uuid) from public;
revoke all on function public._ticket_id_visible(uuid) from public;
grant execute on function public._ticket_row_visible(uuid, text, uuid) to anon, authenticated;
grant execute on function public._ticket_id_visible(uuid) to anon, authenticated;

-- (select …) يجعل قراءة المفتاح مرة واحدة لكل استعلام لا لكل صف.
drop policy if exists tenant_isolation on public.tickets;
create policy tenant_isolation on public.tickets as restrictive for all
  using (not (select public._isolation_on()) or public._ticket_row_visible(user_id, scope, company_id))
  with check (not (select public._isolation_on()) or public._ticket_row_visible(user_id, scope, company_id));

do $$
declare t text;
begin
  foreach t in array array['ticket_replies', 'ticket_attachments', 'ticket_activity', 'ticket_ratings', 'ticket_tag_links'] loop
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format('create policy tenant_isolation on public.%I as restrictive for all
                      using (not (select public._isolation_on()) or public._ticket_id_visible(ticket_id))
                      with check (not (select public._isolation_on()) or public._ticket_id_visible(ticket_id))', t);
  end loop;
end $$;

-- إصلاح دائم: مرفق رد داخلي = رد داخلي (نفس قاعدة ticket_replies_select_policy).
create or replace function public._attachment_reply_public(p_reply uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_reply is null
      or not exists (select 1 from public.ticket_replies r where r.id = p_reply and coalesce(r.is_internal, false));
$$;
revoke all on function public._attachment_reply_public(uuid) from public;
grant execute on function public._attachment_reply_public(uuid) to anon, authenticated;

drop policy if exists internal_reply_attachments on public.ticket_attachments;
create policy internal_reply_attachments on public.ticket_attachments as restrictive for all
  using (public._attachment_reply_public(reply_id) or public.has_elevated_authority() or public.is_platform_staff())
  with check (public._attachment_reply_public(reply_id) or public.has_elevated_authority() or public.is_platform_staff());

-- ملفات حاوية tickets: نفس القاعدتين على الملف نفسه (المسار لا يكفي سرًّا).
create or replace function public._ticket_object_allowed(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $$
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
end $$;
revoke all on function public._ticket_object_allowed(text) from public;
grant execute on function public._ticket_object_allowed(text) to anon, authenticated;

drop policy if exists ticket_files_isolation on storage.objects;
create policy ticket_files_isolation on storage.objects as restrictive for all
  using (bucket_id <> 'tickets' or public._ticket_object_allowed(name))
  with check (bucket_id <> 'tickets' or public._ticket_object_allowed(name));


-- ============================================================================
-- 4) القنوات الجانبية — تذاكر الشركة لا تخرج إلى طاقم المنصة والعزل مفعّل
-- ============================================================================
-- نفس المحفّزات والدوال، مع شرط WHEN (لا تعديل على أجسامها).
create or replace function public._ticket_private_to_company(p_ticket uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public._isolation_on()
     and exists (select 1 from public.tickets t where t.id = p_ticket and t.scope = 'company');
$$;
revoke all on function public._ticket_private_to_company(uuid) from public, anon, authenticated;

do $$
declare
  r record;
begin
  for r in select * from (values
      ('ticket_notification_trigger',            'AFTER INSERT',           'notify_all_admins_on_ticket'),
      ('tr_on_new_ticket',                       'AFTER INSERT',           'notify_admin_on_new_ticket'),
      ('trg_notify_urgent_ticket',               'AFTER INSERT',           'notify_admins_on_urgent_ticket'),
      ('trg_notify_support_on_ticket_rejected',  'AFTER UPDATE',           'notify_support_on_ticket_rejected'),
      ('trg_assign_ticket_round_robin',          'BEFORE INSERT',          'assign_ticket_round_robin'),
      ('trg_dispatch_ticket_webhooks',           'AFTER INSERT OR UPDATE', 'dispatch_ticket_webhooks'),
      ('trg_dispatch_workflow_on_ticket_created','AFTER INSERT',           'dispatch_workflow_on_ticket_created')
    ) v(name, timing, fn) loop
    execute format('drop trigger if exists %I on public.tickets', r.name);
    execute format('create trigger %I %s on public.tickets for each row
                      when (new.scope <> ''company'' or not public._isolation_on())
                      execute function public.%I()', r.name, r.timing, r.fn);
  end loop;
end $$;

-- تنبيهات SLA عبر Telegram للطاقم: تتخطى تذاكر الشركات والعزل مفعّل.
create or replace function public.check_sla_breaches()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
        -- 097: تذاكر الشركة لا تُبلَّغ لطاقم المنصة والعزل مفعّل
        AND (scope <> 'company' OR NOT public._isolation_on())
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

-- أتمتة المنصة (سير العمل) وأداة MCP للأدمن لا تكتب في تذكرة شركة والعزل مفعّل.
create or replace function public.wf_assign_ticket(p_ticket_id uuid, p_assigned_to uuid, p_run_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  -- 097
  IF public._ticket_private_to_company(p_ticket_id) THEN
    RAISE EXCEPTION 'تذكرة خاصة بشركة — خارج نطاق أتمتة المنصة' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('app.bypass_ticket_restrictions', 'on', true);
  UPDATE public.tickets SET assigned_to = p_assigned_to WHERE id = p_ticket_id;
  INSERT INTO public.ticket_activity (ticket_id, action_type, to_value, meta)
  VALUES (p_ticket_id, 'assigned', p_assigned_to::text, jsonb_build_object('source','workflow_run','run_id', p_run_id));
END;
$function$;

create or replace function public.wf_update_ticket_status(p_ticket_id uuid, p_new_status text, p_run_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  -- 097
  IF public._ticket_private_to_company(p_ticket_id) THEN
    RAISE EXCEPTION 'تذكرة خاصة بشركة — خارج نطاق أتمتة المنصة' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('app.bypass_ticket_restrictions', 'on', true);
  UPDATE public.tickets SET status = p_new_status, last_updated_at = now() WHERE id = p_ticket_id;
  INSERT INTO public.ticket_activity (ticket_id, action_type, to_value, meta)
  VALUES (p_ticket_id, 'status_change', p_new_status, jsonb_build_object('source','workflow_run','run_id', p_run_id));
END;
$function$;

create or replace function public.mcp_admin_update_ticket(p_ticket_id uuid, p_actor_id uuid, p_updates jsonb)
 returns tickets
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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

  -- 097: نفس رد التذكرة غير الموجودة — لا كشف لوجود تذكرة شركة
  IF public._ticket_private_to_company(p_ticket_id) THEN
    RAISE EXCEPTION 'التذكرة غير موجودة' USING ERRCODE = 'P0002';
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

-- سياق MCP (يعمل بمفتاح الخدمة، فلا RLS): حالة العزل وشركة الفاعل التي هو في فريقها.
create or replace function public.mcp_ticket_tenancy(p_actor uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'isolation_on', public._isolation_on(),
    'team_company_ids', coalesce((
       select jsonb_agg(c.id order by c.id) from public.companies c
        where public._company_staff_role_of(c.id, p_actor) is not null), '[]'::jsonb));
$$;
revoke all on function public.mcp_ticket_tenancy(uuid) from public, anon, authenticated;
grant execute on function public.mcp_ticket_tenancy(uuid) to service_role;


-- ============================================================================
-- 5) مركز التكاملات: شركة التذكرة من ختمها
-- ============================================================================
create or replace function public._ihub_ticket_company(p_ticket uuid)
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $$
  -- 097: التذكرة تحمل شركتها. تذكرة mad3oom_support ليست تذكرة شركة.
  select t.company_id from public.tickets t where t.id = p_ticket and t.scope = 'company';
$$;

create or replace function public.ihub_intake_convert(p_intake uuid, p_customer uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
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

  -- 097: الشركة صريحة — العميل قد يكون عضوًا إضافيًا فيها، فلا تُشتق من أساسيته
  insert into public.tickets (user_id, title, description, priority, ticket_type, category, contact_info, scope, company_id)
  values (p_customer, i.subject,
          i.message || E'\n\n— ورد عبر نموذج الدعم في موقع الشركة (ووردبريس).',
          'medium', 'problem', null, null, 'company', v_company)
  returning id, ticket_number::text into v_ticket, v_number;

  update public.ihub_intake_requests
     set status = 'converted', ticket_id = v_ticket, decided_by = auth.uid(), decided_at = now()
   where id = i.id;
  perform public._ihub_audit(v_company, i.connection_id, 'user', 'intake.converted',
                                    jsonb_build_object('intake_id', i.id, 'ticket_id', v_ticket));
  return jsonb_build_object('ticket_id', v_ticket, 'ticket_number', v_number,
                            'external_order_ref', i.external_order_ref);
end $$;


-- ============================================================================
-- 6) طلبات الوصول ومنحه (D9، السؤال 8 و16)
-- ============================================================================
create table if not exists public.access_requester_rules (
  requester_kind text primary key check (requester_kind in ('elevated_admin', 'admin', 'support')),
  may_request    boolean not null default false,
  max_hours      integer not null default 24 check (max_hours between 1 and 168),
  updated_by     uuid,
  updated_at     timestamptz not null default now()
);
comment on table public.access_requester_rules is
  '097: من يحق له طلب وصول مؤقت إلى بيانات شركة، وأقصى مدة. يضبطها مالك المنصة وحده. '
  'مالك المنصة ليس طالبًا (لا موافقة ذاتية).';
insert into public.access_requester_rules (requester_kind, may_request, max_hours) values
  ('elevated_admin', true, 168), ('admin', true, 72), ('support', true, 24)
on conflict (requester_kind) do nothing;

create table if not exists public.data_access_requests (
  id              uuid primary key default gen_random_uuid(),
  requester_id    uuid not null references public.profiles(id) on delete cascade,
  requester_kind  text not null check (requester_kind in ('elevated_admin', 'admin', 'support')),
  company_id      uuid not null,
  scope           text not null default 'tickets' check (scope in ('tickets')),
  ticket_id       uuid,
  reason          text not null check (char_length(btrim(reason)) between 20 and 1000),
  requested_hours integer not null default 24 check (requested_hours between 1 and 168),
  status          text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  created_at      timestamptz not null default now(),
  decided_by      uuid,
  decided_at      timestamptz,
  decision_note   text check (decision_note is null or char_length(decision_note) <= 1000),
  constraint data_access_requests_decided_iff check ((status = 'pending') = (decided_at is null))
);
create unique index if not exists data_access_requests_one_pending
  on public.data_access_requests (requester_id, company_id, coalesce(ticket_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status = 'pending';

create table if not exists public.data_access_grants (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid not null unique references public.data_access_requests(id),
  grantee_id    uuid not null references public.profiles(id) on delete cascade,
  company_id    uuid not null,
  scope         text not null check (scope in ('tickets')),
  ticket_id     uuid,
  granted_by    uuid not null,
  starts_at     timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  revoked_by    uuid,
  revoke_reason text check (revoke_reason is null or char_length(revoke_reason) <= 500),
  constraint data_access_grants_window check (expires_at > starts_at and expires_at <= starts_at + interval '7 days'),
  constraint data_access_grants_no_self check (granted_by <> grantee_id)
);

-- كل قراءة عبر منحة وكل قرار: سطر إلحاقي.
create table if not exists public.company_access_audit (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  company_id  uuid not null,
  actor_id    uuid,
  grant_id    uuid,
  request_id  uuid,
  action      text not null check (action in ('requested', 'approved', 'rejected', 'cancelled',
                                              'revoked', 'list_tickets', 'view_ticket')),
  object_id   uuid,
  detail      jsonb not null default '{}'::jsonb
);
create index if not exists company_access_audit_company_idx on public.company_access_audit (company_id, at desc);

do $$
declare t text;
begin
  foreach t in array array['access_requester_rules', 'data_access_requests', 'data_access_grants', 'company_access_audit'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('drop policy if exists gate_account_active on public.%I', t);
    execute format('create policy gate_account_active on public.%I as restrictive for all
                      using (public.account_is_active()) with check (public.account_is_active())', t);
  end loop;
end $$;

-- السجل والمنحة: هوية لا تتغير، والسجل لا يُعدَّل ولا يُحذف
create or replace function public._access_audit_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'سجل الوصول إلحاقي' using errcode = '23514';
end $$;
drop trigger if exists trg_access_audit_append_only on public.company_access_audit;
create trigger trg_access_audit_append_only before update or delete on public.company_access_audit
  for each row execute function public._access_audit_append_only();
drop trigger if exists trg_access_audit_no_truncate on public.company_access_audit;
create trigger trg_access_audit_no_truncate before truncate on public.company_access_audit
  for each statement execute function public._access_audit_append_only();

create or replace function public._access_grant_guard()
returns trigger
language plpgsql
as $$
begin
  if new.id <> old.id or new.request_id <> old.request_id or new.grantee_id <> old.grantee_id
     or new.company_id <> old.company_id or new.scope <> old.scope
     or new.ticket_id is distinct from old.ticket_id or new.granted_by <> old.granted_by
     or new.starts_at <> old.starts_at or new.expires_at > old.expires_at then
    raise exception 'المنحة لا تتغير ولا تُمدَّد — اطلب منحة جديدة' using errcode = '23514';
  end if;
  if old.revoked_at is not null then
    raise exception 'المنحة الملغاة سجل ثابت' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists trg_access_grant_guard on public.data_access_grants;
create trigger trg_access_grant_guard before update on public.data_access_grants
  for each row execute function public._access_grant_guard();
drop trigger if exists trg_access_grant_no_delete on public.data_access_grants;
create trigger trg_access_grant_no_delete before delete on public.data_access_grants
  for each row execute function public._access_audit_append_only();

create or replace function public._access_audit(p_company uuid, p_action text, p_grant uuid, p_request uuid,
                                                p_object uuid, p_detail jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path to 'public'
as $$
  insert into public.company_access_audit (company_id, actor_id, grant_id, request_id, action, object_id, detail)
  values (p_company, auth.uid(), p_grant, p_request, p_action, p_object, coalesce(p_detail, '{}'::jsonb));
$$;

-- نوع الطالب: الطاقم فقط (لا مالك المنصة: لا موافقة ذاتية)
create or replace function public._access_requester_kind(p_user uuid)
returns text
language sql
stable
security definer
set search_path to 'public'
as $$
  select case
    when p.role = 'admin' and exists (select 1 from public.platform_authority a
                                       where a.user_id = p.id and a.level = 'elevated_admin') then 'elevated_admin'
    when p.role = 'admin' then 'admin'
    when p.role = 'support' then 'support'
  end
  from public.profiles p where p.id = p_user;
$$;

create or replace function public._access_require_enabled()
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public._feature_on('data_access_grants_enabled') then
    raise exception 'طلبات الوصول غير مفعّلة' using errcode = '0A000', detail = '{"code":"feature_not_enabled"}';
  end if;
end $$;

-- منحة سارية للمنادي على شركة (وتذكرة إن حُددت)
create or replace function public._access_grant_active(p_grant uuid)
returns public.data_access_grants
language sql
stable
security definer
set search_path to 'public'
as $$
  select g.* from public.data_access_grants g
   where g.id = p_grant and g.grantee_id = auth.uid() and g.revoked_at is null
     and now() >= g.starts_at and now() < g.expires_at
     and public._feature_on('data_access_grants_enabled')
     and coalesce(public.account_is_active(), false);
$$;

do $$
declare f text;
begin
  foreach f in array array['public._access_audit(uuid,text,uuid,uuid,uuid,jsonb)', 'public._access_requester_kind(uuid)',
                           'public._access_require_enabled()', 'public._access_grant_active(uuid)',
                           'public._access_audit_append_only()', 'public._access_grant_guard()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- طلب وصول: الطاقم المسموح له بالقاعدة، بسبب واضح ومدة ضمن الحد.
create or replace function public.request_data_access(p_company uuid, p_ticket uuid, p_reason text, p_hours integer default 24)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid    uuid := auth.uid();
  v_kind   text;
  v_rule   public.access_requester_rules;
  v_hours  integer := coalesce(p_hours, 24);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_req    uuid;
begin
  perform public._access_require_enabled();
  if v_uid is null or not coalesce(public.account_is_active(), false) then
    raise exception 'غير مسموح' using errcode = '42501';
  end if;
  v_kind := public._access_requester_kind(v_uid);
  select * into v_rule from public.access_requester_rules where requester_kind = v_kind;
  if v_kind is null or not coalesce(v_rule.may_request, false) then
    raise exception 'حسابك لا يملك حق طلب الوصول' using errcode = '42501';
  end if;
  if char_length(v_reason) < 20 or char_length(v_reason) > 1000 then
    raise exception 'اكتب سببًا واضحًا (20 حرفًا على الأقل)' using errcode = '22023';
  end if;
  if v_hours < 1 or v_hours > v_rule.max_hours then
    raise exception 'المدة خارج الحد المسموح (% ساعة)', v_rule.max_hours using errcode = '22023';
  end if;
  if not exists (select 1 from public.companies c where c.id = p_company)
     or (p_ticket is not null and not exists (select 1 from public.tickets t
                                               where t.id = p_ticket and t.company_id = p_company and t.scope = 'company')) then
    raise exception 'الشركة أو التذكرة غير موجودة' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.data_access_requests r
              where r.requester_id = v_uid and r.company_id = p_company and r.status = 'pending'
                and r.ticket_id is not distinct from p_ticket) then
    raise exception 'لديك طلب معلّق لهذا النطاق' using errcode = '23505';
  end if;

  insert into public.data_access_requests (requester_id, requester_kind, company_id, ticket_id, reason, requested_hours)
  values (v_uid, v_kind, p_company, p_ticket, v_reason, v_hours)
  returning id into v_req;
  perform public._access_audit(p_company, 'requested', null, v_req, p_ticket, jsonb_build_object('hours', v_hours));

  insert into public.notifications (user_id, title, message, type, link, category)
  select a.user_id, 'طلب وصول إلى بيانات شركة',
         'طلب من فريق المنصة بانتظار قرارك.', 'warning', '/owner-dashboard.html#access-requests', 'security'
    from public.platform_authority a where a.level = 'owner';
  return jsonb_build_object('request_id', v_req, 'status', 'pending');
end $$;

-- قرار المالك: بسياق المالك وتحقق خطوتين، ولا موافقة لطلبه هو.
create or replace function public.owner_decide_access_request(p_request uuid, p_approve boolean, p_note text default null,
                                                              p_hours integer default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r       public.data_access_requests;
  v_rule  public.access_requester_rules;
  v_hours integer;
  v_grant uuid;
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform public._access_require_enabled();
  if not coalesce(public.owner_critical_ok(), false) then
    raise exception 'القرار لمالك المنصة وحده بعد التحقق بخطوتين' using errcode = '42501';
  end if;
  if p_approve is null then
    raise exception 'القرار مطلوب' using errcode = '22023';
  end if;
  select * into r from public.data_access_requests where id = p_request for update;
  if not found or r.status <> 'pending' or r.created_at < now() - interval '7 days' then
    raise exception 'الطلب غير موجود أو لم يعد معلّقًا' using errcode = 'P0002';
  end if;
  if r.requester_id = auth.uid() then
    raise exception 'لا موافقة على طلبك أنت' using errcode = '42501';
  end if;

  if not p_approve then
    update public.data_access_requests
       set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_note = v_note
     where id = r.id;
    perform public._access_audit(r.company_id, 'rejected', null, r.id, r.ticket_id);
    perform public.log_privileged('data_access.rejected', r.requester_id, null,
                                  jsonb_build_object('request_id', r.id, 'company_id', r.company_id));
    insert into public.notifications (user_id, title, message, type, category)
    values (r.requester_id, 'رُفض طلب الوصول', coalesce(v_note, 'رفض مالك المنصة طلبك.'), 'error', 'security');
    return jsonb_build_object('request_id', r.id, 'status', 'rejected');
  end if;

  -- الطالب ما زال مؤهلًا؟ والمدة: الأقل من المطلوب وحد القاعدة الآن وما يحدده المالك
  select * into v_rule from public.access_requester_rules
   where requester_kind = public._access_requester_kind(r.requester_id);
  if not coalesce(v_rule.may_request, false) then
    raise exception 'الطالب لم يعد مؤهلًا للوصول' using errcode = '42501';
  end if;
  v_hours := least(r.requested_hours, v_rule.max_hours, coalesce(p_hours, r.requested_hours), 168);
  if v_hours < 1 then
    raise exception 'مدة غير صالحة' using errcode = '22023';
  end if;

  update public.data_access_requests
     set status = 'approved', decided_by = auth.uid(), decided_at = now(), decision_note = v_note
   where id = r.id;
  insert into public.data_access_grants (request_id, grantee_id, company_id, scope, ticket_id, granted_by, expires_at)
  values (r.id, r.requester_id, r.company_id, r.scope, r.ticket_id, auth.uid(), now() + make_interval(hours => v_hours))
  returning id into v_grant;
  perform public._access_audit(r.company_id, 'approved', v_grant, r.id, r.ticket_id, jsonb_build_object('hours', v_hours));
  perform public.log_privileged('data_access.approved', r.requester_id, null,
                                jsonb_build_object('request_id', r.id, 'grant_id', v_grant, 'company_id', r.company_id,
                                                   'ticket_id', r.ticket_id, 'hours', v_hours));
  insert into public.notifications (user_id, title, message, type, category)
  values (r.requester_id, 'تمت الموافقة على طلب الوصول',
          'الوصول مؤقت لمدة ' || v_hours || ' ساعة ومسجَّل.', 'success', 'security');
  return jsonb_build_object('request_id', r.id, 'status', 'approved', 'grant_id', v_grant, 'hours', v_hours);
end $$;

-- الطالب يلغي طلبه المعلّق
create or replace function public.cancel_data_access_request(p_request uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r public.data_access_requests;
begin
  select * into r from public.data_access_requests
   where id = p_request and requester_id = auth.uid() and status = 'pending' for update;
  if not found then
    raise exception 'الطلب غير موجود أو لم يعد معلّقًا' using errcode = 'P0002';
  end if;
  update public.data_access_requests set status = 'cancelled', decided_by = auth.uid(), decided_at = now() where id = r.id;
  perform public._access_audit(r.company_id, 'cancelled', null, r.id, r.ticket_id);
  return jsonb_build_object('request_id', r.id, 'status', 'cancelled');
end $$;

-- الإلغاء: مالك المنصة (أي منحة) أو صاحب المنحة نفسه. يسري فورًا.
create or replace function public.revoke_data_access_grant(p_grant uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  g public.data_access_grants;
begin
  select * into g from public.data_access_grants where id = p_grant and revoked_at is null for update;
  if not found or not (g.grantee_id = auth.uid() or coalesce(public.owner_capability('owner_only'), false)) then
    raise exception 'المنحة غير موجودة أو ملغاة' using errcode = 'P0002';
  end if;
  update public.data_access_grants
     set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = left(nullif(btrim(coalesce(p_reason, '')), ''), 500)
   where id = g.id;
  perform public._access_audit(g.company_id, 'revoked', g.id, g.request_id, g.ticket_id);
  if g.grantee_id <> auth.uid() then
    perform public.log_privileged('data_access.revoked', g.grantee_id, null, jsonb_build_object('grant_id', g.id));
  end if;
  return jsonb_build_object('grant_id', g.id, 'revoked', true);
end $$;

-- طلبات المنادي ومنحه السارية
create or replace function public.my_data_access()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'can_request', coalesce((select ru.may_request from public.access_requester_rules ru
                              where ru.requester_kind = public._access_requester_kind(auth.uid())), false)
                   and public._feature_on('data_access_grants_enabled'),
    'requests', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'company_id', r.company_id, 'company_name', c.company_name, 'ticket_id', r.ticket_id,
        'status', case when r.status = 'pending' and r.created_at < now() - interval '7 days' then 'expired' else r.status end,
        'requested_hours', r.requested_hours, 'created_at', r.created_at, 'decision_note', r.decision_note)
        order by r.created_at desc)
        from public.data_access_requests r left join public.companies c on c.id = r.company_id
       where r.requester_id = auth.uid()), '[]'::jsonb),
    'grants', coalesce((select jsonb_agg(jsonb_build_object(
        'id', g.id, 'company_id', g.company_id, 'company_name', c.company_name, 'ticket_id', g.ticket_id,
        'expires_at', g.expires_at) order by g.expires_at)
        from public.data_access_grants g left join public.companies c on c.id = g.company_id
       where g.grantee_id = auth.uid() and g.revoked_at is null and now() < g.expires_at), '[]'::jsonb));
$$;

-- لوحة المالك: الطلبات (المعلّقة أولًا) والمنح السارية
create or replace function public.owner_access_requests()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not coalesce(public.owner_capability('owner_only'), false) then
    raise exception 'لمالك المنصة وحده' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'requests', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'requester_id', r.requester_id, 'requester_name', coalesce(p.full_name, p.email),
        'requester_kind', r.requester_kind, 'company_id', r.company_id, 'company_name', c.company_name,
        'ticket_id', r.ticket_id, 'reason', r.reason, 'requested_hours', r.requested_hours,
        'status', case when r.status = 'pending' and r.created_at < now() - interval '7 days' then 'expired' else r.status end,
        'created_at', r.created_at, 'decided_at', r.decided_at)
        order by (r.status = 'pending') desc, r.created_at desc)
        from (select * from public.data_access_requests order by created_at desc limit 200) r
        left join public.profiles p on p.id = r.requester_id
        left join public.companies c on c.id = r.company_id), '[]'::jsonb),
    'active_grants', coalesce((select jsonb_agg(jsonb_build_object(
        'id', g.id, 'grantee_id', g.grantee_id, 'grantee_name', coalesce(p.full_name, p.email),
        'company_name', c.company_name, 'ticket_id', g.ticket_id, 'expires_at', g.expires_at,
        'reads', (select count(*) from public.company_access_audit a
                   where a.grant_id = g.id and a.action in ('list_tickets', 'view_ticket')))
        order by g.expires_at)
        from public.data_access_grants g
        left join public.profiles p on p.id = g.grantee_id
        left join public.companies c on c.id = g.company_id
       where g.revoked_at is null and now() < g.expires_at), '[]'::jsonb));
end $$;

-- قراءة عبر منحة: قائمة تذاكر الشركة (أو التذكرة المحددة وحدها). كل نداء مسجَّل.
create or replace function public.granted_company_tickets(p_grant uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  g public.data_access_grants;
begin
  g := public._access_grant_active(p_grant);
  if g.id is null then
    raise exception 'لا منحة سارية' using errcode = '42501';
  end if;
  perform public._access_audit(g.company_id, 'list_tickets', g.id, g.request_id, g.ticket_id);
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'id', t.id, 'ticket_number', t.ticket_number, 'title', t.title, 'status', t.status,
            'priority', t.priority, 'created_at', t.created_at) order by t.created_at desc), '[]'::jsonb)
            from (select * from public.tickets t
                   where t.scope = 'company' and t.company_id = g.company_id
                     and (g.ticket_id is null or t.id = g.ticket_id)
                   order by t.created_at desc limit 200) t);
end $$;

-- تذكرة واحدة عبر منحة: نصها وردودها غير الداخلية وبيانات مرفقاتها (بلا روابط ملفات).
create or replace function public.granted_ticket_view(p_grant uuid, p_ticket uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  g public.data_access_grants;
  t public.tickets;
begin
  g := public._access_grant_active(p_grant);
  if g.id is null then
    raise exception 'لا منحة سارية' using errcode = '42501';
  end if;
  select * into t from public.tickets x
   where x.id = p_ticket and x.scope = 'company' and x.company_id = g.company_id
     and (g.ticket_id is null or x.id = g.ticket_id);
  if t.id is null then
    raise exception 'التذكرة خارج نطاق المنحة' using errcode = 'P0002';
  end if;
  perform public._access_audit(g.company_id, 'view_ticket', g.id, g.request_id, t.id);
  return jsonb_build_object(
    'ticket', jsonb_build_object('id', t.id, 'ticket_number', t.ticket_number, 'title', t.title,
                                 'description', t.description, 'status', t.status, 'priority', t.priority,
                                 'category', t.category, 'created_at', t.created_at),
    'replies', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'message', r.message, 'created_at', r.created_at,
        'from', case when r.user_id = t.user_id then 'customer' else 'company' end) order by r.created_at)
        from public.ticket_replies r where r.ticket_id = t.id and not coalesce(r.is_internal, false)), '[]'::jsonb),
    'attachments', coalesce((select jsonb_agg(jsonb_build_object(
        'file_name', a.file_name, 'mime_type', a.mime_type, 'file_size', a.file_size, 'created_at', a.created_at)
        order by a.created_at)
        from public.ticket_attachments a
       where a.ticket_id = t.id and public._attachment_reply_public(a.reply_id)), '[]'::jsonb),
    'expires_at', g.expires_at);
end $$;

-- الشفافية: مدير الشركة يرى من وصل إلى بياناتها ومتى (الدور لا الاسم، وبلا سبب الطلب).
create or replace function public.company_access_log()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
begin
  if public.company_staff_role() is distinct from 'admin' then
    return null;
  end if;
  v_company := public.current_company_id();
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'grant_id', g.id, 'requester_kind', r.requester_kind, 'ticket_id', g.ticket_id,
            'starts_at', g.starts_at, 'expires_at', g.expires_at, 'revoked_at', g.revoked_at,
            'reads', (select count(*) from public.company_access_audit a
                       where a.grant_id = g.id and a.action in ('list_tickets', 'view_ticket')))
            order by g.starts_at desc), '[]'::jsonb)
            from public.data_access_grants g join public.data_access_requests r on r.id = g.request_id
           where g.company_id = v_company);
end $$;

-- قواعد الطالبين: مالك المنصة بتحقق خطوتين وسبب.
create or replace function public.owner_set_access_requester_rule(p_kind text, p_may_request boolean, p_max_hours integer,
                                                                  p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_old public.access_requester_rules;
begin
  if not coalesce(public.owner_critical_ok(), false) then
    raise exception 'لمالك المنصة وحده بعد التحقق بخطوتين' using errcode = '42501';
  end if;
  if p_may_request is null or p_max_hours is null or p_max_hours not between 1 and 168
     or char_length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'القيم والسبب (10 أحرف على الأقل) مطلوبة، والمدة بين 1 و168 ساعة' using errcode = '22023';
  end if;
  select * into v_old from public.access_requester_rules where requester_kind = p_kind for update;
  if not found then
    raise exception 'نوع طالب غير معروف' using errcode = 'P0002';
  end if;
  update public.access_requester_rules
     set may_request = p_may_request, max_hours = p_max_hours, updated_by = auth.uid(), updated_at = now()
   where requester_kind = p_kind;
  perform public.log_privileged('data_access.rule.' || p_kind, null,
                                jsonb_build_object('may_request', v_old.may_request, 'max_hours', v_old.max_hours),
                                jsonb_build_object('may_request', p_may_request, 'max_hours', p_max_hours,
                                                   'reason', btrim(p_reason)));
  return jsonb_build_object('requester_kind', p_kind, 'may_request', p_may_request, 'max_hours', p_max_hours);
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.request_data_access(uuid,uuid,text,integer)',
                           'public.owner_decide_access_request(uuid,boolean,text,integer)',
                           'public.cancel_data_access_request(uuid)', 'public.revoke_data_access_grant(uuid,text)',
                           'public.my_data_access()', 'public.owner_access_requests()',
                           'public.granted_company_tickets(uuid)', 'public.granted_ticket_view(uuid,uuid)',
                           'public.company_access_log()', 'public.owner_set_access_requester_rule(text,boolean,integer,text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;


-- ============================================================================
-- 7) تحقق ذاتي
-- ============================================================================
do $$
begin
  if exists (select 1 from public.platform_feature_switches where enabled) then
    raise exception '097: مفتاح مفعّل بعد الترحيل — يجب أن تكون كلها مطفأة';
  end if;
  if exists (select 1 from public.tickets where scope is null
                                             or (scope = 'company') <> (company_id is not null)) then
    raise exception '097: تذكرة بلا نطاق صالح';
  end if;
  if (select count(*) from pg_policies where policyname = 'tenant_isolation' and permissive = 'RESTRICTIVE'
         and tablename in ('tickets', 'ticket_replies', 'ticket_attachments', 'ticket_activity', 'ticket_ratings',
                           'ticket_tag_links')) <> 6 then
    raise exception '097: سياسات العزل ناقصة';
  end if;
end $$;
