-- ============================================================================
-- اختبار تنفيذي لـ 161: عقدة «تواصل → تذكرة» في واتساب.
--
-- يثبّت الخصائص التي جاء 161 ليغلقها، كل واحدة تفشل إن انكسرت:
--
--   ① الـ RPC تنشئ التذكرة + أول رد (نص المحادثة) + صف الربط في
--      معاملة واحدة وتعيد ticket_number؛ والتذكرة scope='mad3oom_support'
--      وcompany_id NULL وsource='whatsapp_flow' وsource_ref=flow_run_id
--      والفئة 'whatsapp_support'.
--   ② تكرار نفس flow_run_id يعيد نفس الرقم ولا ينشئ شيئًا (لا تذكرة
--      ولا رد ولا رابط جديد).
--   ③ الإعفاء من الحصة: مالك مستنفد الرصيد (used = limit) تُرفض
--      تذكرته اليدوية، لكن تذكرة واتساب (عبر الـ RPC أو بإدراج مباشر
--      source='whatsapp_flow') تُقبل.
--   ④ الإشعارات تُطلق: شرط WHEN الحي (scope <> 'company' OR NOT
--      _isolation_on()) مع عزل مفعَّل — بريد لمالك التذكرة عبر
--      send-ticket-email، وإشعاران لكل admin، وحدث ticket_created
--      في سجل الويبهوك.
--   ⑤ ربط رسائل نطاق التشغيل: رسائل المالك من flow_started_at فصاعدًا
--      (واردة وصادرة) تُربط، وما قبل البدء ورسائل مرسل آخر لا تُربط،
--      ورسالة مربوطة أصلًا لا تُمسّ.
--   ⑥ العنوان والفئة الافتراضيان عند غيابهما؛ ورفض صريح لمالك غير
--      موجود وflow_run_id فارغ.
--   ⑦ المنح: الـ RPC لـ service_role فقط (بلا authenticated/anon)،
--      والجدول قراءة فقط لـ authenticated.
--   ⑧ التراجع يسقط الدالة والجدول والأعمدة ويعيد enforce_ticket_quota
--      بلا فرع واتساب؛ وإعادة 161 تعيد كل شيء.
--
-- يحمّل `migrations/161_whatsapp_ticket_links.sql` نفسه، لا نسخًا من
-- أجسامه. البدلاء هنا بدائل مخطط مصغّرة (stub) لما حول 161 فقط:
-- tickets/ticket_replies/messages/profiles كما في الإنتاج الحي
-- (الأعمدة الإلزامية والقيود نفسها)، وenforce_ticket_quota بنسخة
-- الإنتاج قبل 161 حرفيًا، وset_ticket_number وnotify_ticket_event
-- وnotify_all_admins_on_ticket وnotify_admin_on_new_ticket بنصوصها
-- الحية حرفيًا، و_ticket_scope_stamp مبسَّطًا (الفرعان اللذان يمسّان
-- هذا الترحيل: NULL ← mad3oom_support، وmad3oom_support بلا شركة)،
-- وdispatch_ticket_webhooks مبسَّطًا (يسجّل الإرسال في dispatch_log
-- بدل POST فعلي — نصه الحي يقرأ webhooks وينادي net.http_post)،
-- وticket_quota_status يقرأ جدول رصيد قابل للضبط في الاختبار،
-- و_isolation_on() = true (الحالة الأشد: العزل مفعَّل).
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true),'')::uuid; $$;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $$;
GRANT USAGE ON SCHEMA auth, public, extensions TO authenticated, anon, service_role;

-- ── الجداول (كما في الإنتاج الحي: الأعمدة الإلزامية والقيود) ───────────────
CREATE SEQUENCE public.ticket_number_seq AS bigint START 1001 INCREMENT 1;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, email text, full_name text, phone text,
  role text DEFAULT 'user', created_at timestamptz DEFAULT now()
);

CREATE TABLE public.tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  status text DEFAULT 'open'::text,
  priority text DEFAULT 'medium'::text,
  created_at timestamptz DEFAULT now(),
  ticket_number bigint DEFAULT nextval('ticket_number_seq'::regclass),
  ticket_type text DEFAULT 'problem'::text NOT NULL,
  contact_info text,
  category text,
  assigned_to uuid,
  company_id uuid,
  scope text NOT NULL,
  CONSTRAINT tickets_priority_check CHECK (priority = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text])),
  CONSTRAINT tickets_status_check CHECK (status = ANY (ARRAY['open'::text, 'in-progress'::text, 'resolved'::text, 'confirmed'::text, 'rejected'::text, 'closed'::text])),
  CONSTRAINT tickets_ticket_type_check CHECK (ticket_type = ANY (ARRAY['problem'::text, 'inquiry'::text]))
);

CREATE TABLE public.ticket_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  message text NOT NULL,
  created_at timestamptz DEFAULT now(),
  is_internal boolean DEFAULT false
);
ALTER TABLE public.ticket_replies
  ADD CONSTRAINT ticket_replies_user_profile_fk FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

CREATE TABLE public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  from_number text, to_number text, message_text text,
  message_type text DEFAULT 'text'::text,
  direction text DEFAULT 'inbound'::text,
  status text DEFAULT 'received'::text,
  waba_id text, "timestamp" timestamptz DEFAULT now(),
  raw_data jsonb, created_at timestamptz DEFAULT now(),
  contact_bsuid text, wa_message_id text
);

CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid, title text NOT NULL, message text NOT NULL,
  type text DEFAULT 'info'::text, link text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE public.internal_service_secrets (key text PRIMARY KEY, value text);
CREATE TABLE public.http_calls (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, url text, headers jsonb, body jsonb, at timestamptz DEFAULT now());
CREATE TABLE public.webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), url text, secret text,
  events text[], is_active boolean DEFAULT true,
  last_triggered_at timestamptz, last_status text
);
CREATE TABLE public.dispatch_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  webhook_id uuid, event text, ticket_number bigint, at timestamptz DEFAULT now()
);
-- رصيد الحصة القابل للضبط في الاختبار
CREATE TABLE public.t_quota_stub (
  user_id uuid PRIMARY KEY, used int NOT NULL DEFAULT 0,
  monthly_limit int NOT NULL DEFAULT 20, unlimited boolean NOT NULL DEFAULT false,
  billing_used int NOT NULL DEFAULT 0, billing_limit int NOT NULL DEFAULT 5,
  plan_name_ar text NOT NULL DEFAULT 'الأساسية'
);

-- كما في اختبار 160: سياسات RLS تقرأ profiles (is_admin والطاقم).
GRANT SELECT ON public.profiles TO authenticated;

-- ── دوال مساعدة (بدائل مصغّرة) ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin');
$$;

CREATE OR REPLACE FUNCTION public.ticket_account_owner(p_user_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$ select p_user_id; $$;

CREATE OR REPLACE FUNCTION public.ticket_quota_status(p_user_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select jsonb_build_object(
    'used', coalesce(q.used, 0), 'monthly_limit', coalesce(q.monthly_limit, 20),
    'unlimited', coalesce(q.unlimited, false),
    'billing_used', coalesce(q.billing_used, 0), 'billing_limit', coalesce(q.billing_limit, 5),
    'plan_name_ar', coalesce(q.plan_name_ar, 'الأساسية'))
  from (select 1) s left join public.t_quota_stub q on q.user_id = p_user_id;
$$;

-- _isolation_on() = true: الحالة الأشد (العزل مفعَّل) — فشرط WHEN في
-- محفّزات الإشعار لا ينقذها إلا scope <> 'company'.
CREATE OR REPLACE FUNCTION public._isolation_on() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$ select true; $$;

CREATE OR REPLACE FUNCTION public.set_ticket_number() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $function$
    BEGIN
        IF NEW.ticket_number IS NULL THEN
            NEW.ticket_number := nextval('ticket_number_seq');
        END IF;
        RETURN NEW;
    END;
$function$;

-- مبسَّط: الفرعان اللذان يمسّان 161 (الحي يشتق شركة العميل عند NULL —
-- الـ RPC يضع scope صراحةً فلا يمر بهذا الفرع إطلاقًا).
CREATE OR REPLACE FUNCTION public._ticket_scope_stamp() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
begin
  if tg_op = 'UPDATE' then return new; end if;
  if new.scope is null then new.scope := 'mad3oom_support'; return new; end if;
  if new.scope = 'mad3oom_support' then
    if new.company_id is not null then
      raise exception 'تذكرة فريق مدعوم لا تحمل شركة' using errcode = '22023';
    end if;
    return new;
  end if;
  raise exception 'نطاق تذكرة غير معروف' using errcode = '22023';
end $function$;

-- enforce_ticket_quota بنسخة الإنتاج قبل 161 حرفيًا (069 + carry 101).
CREATE OR REPLACE FUNCTION public.enforce_ticket_quota()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_status jsonb;
begin
  if coalesce(current_setting('app.ticket_carry', true), '') = 'on' then
    return new;
  end if;
  if new.user_id is null
     or public.is_admin()
     or exists (select 1 from public.profiles p
                 where p.id = new.user_id and p.role in ('admin', 'support', 'platform_owner')) then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ticket_quota:' || public.ticket_account_owner(new.user_id)::text, 0));
  v_status := public.ticket_quota_status(new.user_id);
  if coalesce(new.category, '') = 'whatsapp_wallet_topup'
     or (new.category = 'subscription'
         and coalesce(current_setting('mad3oom.billing_request_ticket', true), '') = 'on') then
    if (v_status->>'billing_used')::int >= (v_status->>'billing_limit')::int then
      raise exception 'وصلت للحد الأقصى من طلبات الاشتراك والفوترة هذا الشهر (% طلبات). لو محتاج مساعدة تواصل مع الدعم عبر المحادثة.',
        v_status->>'billing_limit'
        using errcode = 'P0001', hint = 'billing_quota_exceeded';
    end if;
    return new;
  end if;
  if (v_status->>'unlimited')::boolean is not true
     and (v_status->>'used')::int >= (v_status->>'monthly_limit')::int then
    raise exception 'وصلت للحد الأقصى من التذاكر في %: % تذكرة شهريًا. رقّي خطتك من صفحة الاشتراكات، أو انتظر تجدّد الرصيد أول الشهر.',
      v_status->>'plan_name_ar', v_status->>'monthly_limit'
      using errcode = 'P0001', hint = 'ticket_quota_exceeded';
  end if;
  return new;
end;
$function$;

-- http_post بديل يسجّل النداء بدل الإرسال (كما في prod-shape net stub).
CREATE OR REPLACE FUNCTION public.http_post(url text, headers jsonb, body jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
begin
  insert into public.http_calls (url, headers, body) values (url, headers, body);
end $$;

-- notify_ticket_event بنصه الحي حرفيًا (يرسل بريدًا عبر send-ticket-email).
CREATE OR REPLACE FUNCTION public.notify_ticket_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
    payload JSONB;
    customer_email TEXT;
    customer_name TEXT;
    v_internal_secret text;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;
    SELECT email, full_name INTO customer_email, customer_name
    FROM profiles
    WHERE id = NEW.user_id;
    IF customer_email IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT value INTO v_internal_secret FROM public.internal_service_secrets WHERE key = 'send_ticket_email_internal';
    payload = jsonb_build_object(
        'event', TG_OP,
        'ticket_id', NEW.id,
        'previous_status', CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END,
        'ticket_number', NEW.ticket_number,
        'title', NEW.title,
        'status', NEW.status,
        'description', NEW.description,
        'customer_email', customer_email,
        'customer_name', customer_name,
        'created_at', NEW.created_at
    );
    BEGIN
        PERFORM public.http_post(
            url := 'https://srnelrdpqkcntbgudyto.supabase.co/functions/v1/send-ticket-email',
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'X-Internal-Trigger-Secret', v_internal_secret
            ),
            body := payload
        );
    EXCEPTION WHEN OTHERS THEN
        RAISE LOG 'notify_ticket_event: failed to send email for ticket %: %', NEW.id, SQLERRM;
    END;
    RETURN NEW;
END;
$function$;

-- notify_all_admins_on_ticket بنصه الحي حرفيًا.
CREATE OR REPLACE FUNCTION public.notify_all_admins_on_ticket()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  admin_record record;
begin
  for admin_record in select id from profiles where role = 'admin' loop
    insert into notifications (user_id, title, message, created_at)
    values (admin_record.id, 'تذكرة جديدة', 'تم إنشاء تذكرة جديدة بواسطة عميل', now());
  end loop;
  return new;
end;
$function$;

-- notify_admin_on_new_ticket بنصه الحي حرفيًا.
CREATE OR REPLACE FUNCTION public.notify_admin_on_new_ticket()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  admin_record record;
  customer_name text;
begin
  select full_name into customer_name from profiles where id = new.user_id;
  if customer_name is null then
    customer_name := 'عميل جديد';
  end if;
  for admin_record in select id from profiles where role = 'admin' loop
    insert into notifications (user_id, title, message, type, link)
    values (
      admin_record.id,
      'تذكرة جديدة',
      'العميل ' || customer_name || ' أنشأ تذكرة جديدة: ' || new.title,
      'info',
      'admin/tickets.html?id=' || new.id
    );
  end loop;
  return new;
end;
$function$;

-- dispatch_ticket_webhooks مبسَّط: نفس أحداثه وشرط WHEN الحي، لكنه
-- يسجّل الإرسال في dispatch_log بدل net.http_post فعلي.
CREATE OR REPLACE FUNCTION public.dispatch_ticket_webhooks()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_event text;
  v_hook record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_event := 'ticket_created';
  ELSIF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    v_event := CASE WHEN NEW.status = 'resolved' THEN 'ticket_resolved' ELSE 'ticket_status_changed' END;
  ELSE
    RETURN NEW;
  END IF;
  FOR v_hook IN SELECT * FROM public.webhooks WHERE is_active = true AND v_event = ANY(events)
  LOOP
    INSERT INTO public.dispatch_log (webhook_id, event, ticket_number)
    VALUES (v_hook.id, v_event, NEW.ticket_number);
    UPDATE public.webhooks SET last_triggered_at = now(), last_status = 'sent' WHERE id = v_hook.id;
  END LOOP;
  RETURN NEW;
END;
$function$;

-- المحفّزات على tickets (بشروط WHEN الحية حرفيًا حيث وُجدت).
CREATE TRIGGER a_ticket_scope_stamp BEFORE INSERT ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION _ticket_scope_stamp();
CREATE TRIGGER tickets_enforce_quota BEFORE INSERT ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION enforce_ticket_quota();
CREATE TRIGGER tr_set_ticket_number BEFORE INSERT ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION set_ticket_number();
CREATE TRIGGER on_ticket_created AFTER INSERT ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION notify_ticket_event();
CREATE TRIGGER ticket_notification_trigger AFTER INSERT ON public.tickets
  FOR EACH ROW WHEN ((new.scope <> 'company'::text) OR (NOT _isolation_on()))
  EXECUTE FUNCTION notify_all_admins_on_ticket();
CREATE TRIGGER tr_on_new_ticket AFTER INSERT ON public.tickets
  FOR EACH ROW WHEN ((new.scope <> 'company'::text) OR (NOT _isolation_on()))
  EXECUTE FUNCTION notify_admin_on_new_ticket();
CREATE TRIGGER trg_dispatch_ticket_webhooks AFTER INSERT OR UPDATE ON public.tickets
  FOR EACH ROW WHEN ((new.scope <> 'company'::text) OR (NOT _isolation_on()))
  EXECUTE FUNCTION dispatch_ticket_webhooks();

-- ── الفاعلون والبيانات ──────────────────────────────────────────────────────
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-8000-0000000000a1', 'owner@mad3oom.test'),
  ('00000000-0000-4000-8000-0000000000a2', 'admin@mad3oom.test'),
  ('00000000-0000-4000-8000-0000000000a3', 'plain@mad3oom.test');
INSERT INTO public.profiles (id, email, full_name, role) VALUES
  ('00000000-0000-4000-8000-0000000000a1', 'owner@mad3oom.test', 'مالك الرقم', 'user'),
  ('00000000-0000-4000-8000-0000000000a2', 'admin@mad3oom.test', 'مدير المنصة', 'admin'),
  ('00000000-0000-4000-8000-0000000000a3', 'plain@mad3oom.test', 'عميل عادي', 'user');
INSERT INTO public.internal_service_secrets (key, value) VALUES ('send_ticket_email_internal', 'stub-secret');
INSERT INTO public.webhooks (id, url, secret, events, is_active) VALUES
  ('00000000-0000-4000-8000-0000000000b1', 'https://example.test/hook', 's3cr3t', ARRAY['ticket_created'], true);
-- المالك مستنفد الرصيد من البداية (used = limit) — لاختبار الإعفاء ③.
INSERT INTO public.t_quota_stub (user_id, used, monthly_limit) VALUES
  ('00000000-0000-4000-8000-0000000000a1', 20, 20),
  ('00000000-0000-4000-8000-0000000000a3', 0, 20);

-- رسائل نطاق التشغيل (قبل تحميل 161 — فعمود ticket_id يأتي معه).
-- T0 = 2026-11-28 15:00 UTC؛ التشغيل يبدأ عندها.
INSERT INTO public.messages (user_id, from_number, to_number, direction, message_text, "timestamp") VALUES
  ('00000000-0000-4000-8000-0000000000a1', '+201000000001', '+201112223344', 'inbound', 'رسالة قبل التشغيل — لا تُربط', '2026-11-28 14:50:00+00'),
  ('00000000-0000-4000-8000-0000000000a1', '+201000000001', '+201112223344', 'inbound', 'أريد المساعدة', '2026-11-28 15:01:00+00'),
  ('00000000-0000-4000-8000-0000000000a1', '+201112223344', '+201000000001', 'outbound', 'كيف أساعدك؟', '2026-11-28 15:02:00+00'),
  ('00000000-0000-4000-8000-0000000000a1', '+201000000099', '+201112223344', 'inbound', 'رسالة مرسل آخر — لا تُربط', '2026-11-28 15:03:00+00'),
  ('00000000-0000-4000-8000-0000000000a1', '+201000000001', '+201112223344', 'inbound', 'تفاصيل المشكلة', '2026-11-28 15:04:00+00');

-- ── تحميل الترحيل نفسه ─────────────────────────────────────────────────────
\i migrations/161_whatsapp_ticket_links.sql

-- مساعد: استدعاء الـ RPC (دالة SQL تتحقق من جسمها عند الإنشاء،
-- فتُعرَّف بعد تحميل 161 لا قبله). SECURITY DEFINER كما يفعل الويبهوك
-- بمفتاح الخدمة.
CREATE OR REPLACE FUNCTION t_call_wa(p_owner uuid, p_sender text, p_run uuid, p_started timestamptz,
  p_transcript text, p_name text, p_phone text, p_title text, p_category text)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$
  select public.wa_create_ticket_from_flow(p_owner, p_sender, p_run, p_started, p_transcript, p_name, p_phone, p_title, p_category);
$$;
GRANT EXECUTE ON FUNCTION t_call_wa(uuid, text, uuid, timestamptz, text, text, text, text, text) TO authenticated, anon, service_role;

-- ① المسار السعيد: إنشاء + رد + رابط + حقول التذكرة.
DO $$
DECLARE
  v_num text;
  v_t public.tickets%rowtype;
  v_replies int;
  v_links int;
BEGIN
  SELECT t_call_wa('00000000-0000-4000-8000-0000000000a1', '+201000000001',
    '11111111-1111-4111-8111-111111111111', '2026-11-28 15:00:00+00',
    '[15:01] العميل: أريد المساعدة' || chr(10) || '[15:02] البوت: كيف أساعدك؟',
    'أحمد', '+201000000001', 'واتساب — أحمد — أريد المساعدة', 'whatsapp_support')
    INTO v_num;
  IF v_num IS NULL OR v_num <> '1001' THEN
    RAISE EXCEPTION 'FAIL 1A: رقم التذكرة جاء % لا 1001', v_num;
  END IF;
  SELECT * INTO v_t FROM public.tickets WHERE ticket_number = 1001;
  IF v_t.scope <> 'mad3oom_support' OR v_t.company_id IS NOT NULL
     OR v_t.source <> 'whatsapp_flow'
     OR v_t.source_ref <> '11111111-1111-4111-8111-111111111111'
     OR v_t.category <> 'whatsapp_support' OR v_t.status <> 'open'
     OR v_t.user_id <> '00000000-0000-4000-8000-0000000000a1' THEN
    RAISE EXCEPTION 'FAIL 1B: حقول التذكرة خاطئة: scope=% company=% source=% ref=% cat=% status=%',
      v_t.scope, v_t.company_id, v_t.source, v_t.source_ref, v_t.category, v_t.status;
  END IF;
  SELECT count(*) INTO v_replies FROM public.ticket_replies WHERE ticket_id = v_t.id;
  IF v_replies <> 1 THEN
    RAISE EXCEPTION 'FAIL 1C: الردود على التذكرة % لا 1', v_replies;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ticket_replies WHERE ticket_id = v_t.id
                  AND message LIKE '%أريد المساعدة%' AND is_internal = false) THEN
    RAISE EXCEPTION 'FAIL 1D: أول رد لا يحمل نص المحادثة';
  END IF;
  SELECT count(*) INTO v_links FROM public.whatsapp_ticket_links WHERE flow_run_id = '11111111-1111-4111-8111-111111111111';
  IF v_links <> 1 THEN
    RAISE EXCEPTION 'FAIL 1E: صفوف الربط % لا 1', v_links;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.whatsapp_ticket_links
                  WHERE flow_run_id = '11111111-1111-4111-8111-111111111111'
                    AND ticket_id = v_t.id AND owner_user_id = '00000000-0000-4000-8000-0000000000a1'
                    AND sender_key = '+201000000001' AND contact_name = 'أحمد'
                    AND contact_phone = '+201000000001'
                    AND flow_started_at = '2026-11-28 15:00:00+00'
                    AND transcript_snapshot LIKE '%أريد المساعدة%') THEN
    RAISE EXCEPTION 'FAIL 1F: حقول صف الربط خاطئة';
  END IF;
  RAISE NOTICE 'PASS 1: إنشاء التذكرة + الرد + الربط برقم %', v_num;
END $$;

-- ② منع التكرار: نفس flow_run_id يعيد نفس الرقم بلا أي إنشاء جديد.
DO $$
DECLARE
  v_num text;
  v_tickets int; v_replies int; v_links int;
BEGIN
  SELECT t_call_wa('00000000-0000-4000-8000-0000000000a1', '+201000000001',
    '11111111-1111-4111-8111-111111111111', '2026-11-28 15:00:00+00',
    'نص مختلف تمامًا', 'أحمد', '+201000000001', 'عنوان مختلف', 'whatsapp_support')
    INTO v_num;
  IF v_num <> '1001' THEN
    RAISE EXCEPTION 'FAIL 2A: التكرار أعاد % لا 1001', v_num;
  END IF;
  SELECT count(*) INTO v_tickets FROM public.tickets;
  SELECT count(*) INTO v_replies FROM public.ticket_replies;
  SELECT count(*) INTO v_links FROM public.whatsapp_ticket_links;
  IF v_tickets <> 1 OR v_replies <> 1 OR v_links <> 1 THEN
    RAISE EXCEPTION 'FAIL 2B: التكرار أنشأ شيئًا: تذاكر=% ردود=% روابط=%', v_tickets, v_replies, v_links;
  END IF;
  RAISE NOTICE 'PASS 2: تكرار نفس flow_run_id يعيد 1001 بلا إنشاء';
END $$;

-- ③ الإعفاء من الحصة (المالك مستنفد: used=20/limit=20).
DO $$
DECLARE v_err text;
BEGIN
  -- (أ) تذكرة يدوية للمالك المستنفد تُرفض.
  BEGIN
    INSERT INTO public.tickets (user_id, title, description, status, priority, category, scope)
    VALUES ('00000000-0000-4000-8000-0000000000a1', 'يدوية', 'وصف', 'open', 'medium', 'other', 'mad3oom_support');
    RAISE EXCEPTION 'FAIL 3A: التذكرة اليدوية للمستنفد قُبلت';
  EXCEPTION WHEN OTHERS THEN
    IF sqlerrm NOT LIKE '%وصلت للحد الأقصى من التذاكر%' THEN
      RAISE EXCEPTION 'FAIL 3A: رفض اليدوية برسالة غير متوقعة: %', sqlerrm;
    END IF;
  END;
  -- (ب) إدراج مباشر source='whatsapp_flow' للمستنفد يُقبل.
  INSERT INTO public.tickets (user_id, title, description, status, priority, category, scope, source, source_ref)
  VALUES ('00000000-0000-4000-8000-0000000000a1', 'واتساب مباشرة', 'وصف', 'open', 'medium', 'whatsapp_support', 'mad3oom_support', 'whatsapp_flow', 'direct-1');
  -- (ج) الـ RPC للمستنفد تُقبل بتشغيل جديد. (الإدراج الفاشل في (أ)
  -- استهلك الرقم 1002 من التسلسل، والمباشر في (ب) أخذ 1003،
  -- فالـ RPC هنا تأخذ 1004.)
  IF t_call_wa('00000000-0000-4000-8000-0000000000a1', '+201000000001',
    '22222222-2222-4222-8222-222222222222', '2026-11-28 16:00:00+00',
    'محادثة ثانية', 'منى', '+201000000001', null, null) <> '1004' THEN
    RAISE EXCEPTION 'FAIL 3C: الـ RPC للمستنفد لم تعد 1004';
  END IF;
  RAISE NOTICE 'PASS 3: المستنفد تُرفض يدوته وتُقبل واتسابه (مباشر + RPC)';
END $$;

-- ④ الإشعارات تُطلق رغم العزل المفعَّل (تذكرة 1001 من §1).
DO $$
DECLARE
  v_admin_notes int; v_named int; v_dispatch int; v_mail int;
BEGIN
  SELECT count(*) INTO v_admin_notes FROM public.notifications
   WHERE user_id = '00000000-0000-4000-8000-0000000000a2' AND title = 'تذكرة جديدة';
  -- إشعاران لكل تذكرة (notify_all_admins + notify_admin_on_new_ticket)
  -- × 3 تذاكر أنشئت حتى الآن (1001 + المباشرة 1003 + 1004) = 6.
  IF v_admin_notes <> 6 THEN
    RAISE EXCEPTION 'FAIL 4A: إشعارات الadmin % لا 6', v_admin_notes;
  END IF;
  SELECT count(*) INTO v_named FROM public.notifications
   WHERE link LIKE 'admin/tickets.html?id=%' AND message LIKE '%مالك الرقم%';
  IF v_named <> 3 THEN
    RAISE EXCEPTION 'FAIL 4B: إشعارات العنوان/الرابط % لا 3', v_named;
  END IF;
  SELECT count(*) INTO v_dispatch FROM public.dispatch_log WHERE event = 'ticket_created';
  IF v_dispatch <> 3 THEN
    RAISE EXCEPTION 'FAIL 4C: أحداث ticket_created في سجل الويبهوك % لا 3', v_dispatch;
  END IF;
  SELECT count(*) INTO v_mail FROM public.http_calls
   WHERE url LIKE '%/send-ticket-email' AND body->>'customer_email' = 'owner@mad3oom.test';
  IF v_mail <> 3 THEN
    RAISE EXCEPTION 'FAIL 4D: رسائل بريد التذكرة % لا 3', v_mail;
  END IF;
  RAISE NOTICE 'PASS 4: بريد للمالك + إشعاران لكل admin + ويبهوك ticket_created (عزل مفعَّل)';
END $$;

-- ⑤ ربط رسائل نطاق التشغيل (تذكرة 1001، بدء 15:00).
DO $$
DECLARE v_linked int;
BEGIN
  SELECT count(*) INTO v_linked FROM public.messages
   WHERE ticket_id = (SELECT id FROM public.tickets WHERE ticket_number = 1001);
  IF v_linked <> 3 THEN
    RAISE EXCEPTION 'FAIL 5A: الرسائل المربوطة % لا 3', v_linked;
  END IF;
  IF EXISTS (SELECT 1 FROM public.messages WHERE message_text LIKE 'رسالة قبل التشغيل%' AND ticket_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.messages WHERE message_text LIKE 'رسالة مرسل آخر%' AND ticket_id IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL 5B: رُبطت رسالة خارج النطاق';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.messages WHERE message_text = 'أريد المساعدة' AND ticket_id IS NOT NULL)
     OR NOT EXISTS (SELECT 1 FROM public.messages WHERE message_text = 'كيف أساعدك؟' AND ticket_id IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL 5C: رسالة داخل النطاق لم تُربط (واردة/صادرة)';
  END IF;
  RAISE NOTICE 'PASS 5: 3 رسائل مربوطة (واردة + صادرة داخل النطاق) وما قبل البدء والمرسل الآخر بلا ربط';
END $$;

-- ⑥ الافتراضيات والرفض الصريح.
DO $$
DECLARE v_t public.tickets%rowtype;
BEGIN
  -- عنوان وفئة افتراضيان من §3 (تذكرة 1004: p_title وp_category NULL).
  SELECT * INTO v_t FROM public.tickets WHERE ticket_number = 1004;
  IF v_t.title <> 'واتساب — منى' THEN
    RAISE EXCEPTION 'FAIL 6A: العنوان الافتراضي جاء % لا «واتساب — منى»', v_t.title;
  END IF;
  IF v_t.category <> 'whatsapp_support' THEN
    RAISE EXCEPTION 'FAIL 6B: الفئة الافتراضية جاءت %', v_t.category;
  END IF;
  -- مالك غير موجود → رفض صريح P0002.
  BEGIN
    PERFORM t_call_wa('00000000-0000-4000-8000-0000000000ff', '+201000000001',
      '33333333-3333-4333-8333-333333333333', now(), 'نص', 'س', '+201000000001', 'ع', 'whatsapp_support');
    RAISE EXCEPTION 'FAIL 6C: مالك غير موجود قُبل';
  EXCEPTION WHEN OTHERS THEN
    IF sqlstate <> 'P0002' THEN
      RAISE EXCEPTION 'FAIL 6C: رفض المالك الغائب بحالة % لا P0002: %', sqlstate, sqlerrm;
    END IF;
  END;
  -- flow_run_id فارغ → رفض صريح.
  BEGIN
    PERFORM t_call_wa('00000000-0000-4000-8000-0000000000a1', '+201000000001',
      null, now(), 'نص', 'س', '+201000000001', 'ع', 'whatsapp_support');
    RAISE EXCEPTION 'FAIL 6D: flow_run_id فارغ قُبل';
  EXCEPTION WHEN OTHERS THEN
    IF sqlerrm NOT LIKE '%معرف تشغيل التدفق%' THEN
      RAISE EXCEPTION 'FAIL 6D: رفض التشغيل الفارغ برسالة غير متوقعة: %', sqlerrm;
    END IF;
  END;
  RAISE NOTICE 'PASS 6: افتراضيات العنوان/الفئة + رفض المالك الغائب والتشغيل الفارغ';
END $$;

-- ⑦ المنح وRLS: الـ RPC لـ service_role فقط؛ والجدول قراءة فقط.
DO $$
BEGIN
  IF has_function_privilege('authenticated',
        'public.wa_create_ticket_from_flow(uuid,text,uuid,timestamptz,text,text,text,text,text)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon',
        'public.wa_create_ticket_from_flow(uuid,text,uuid,timestamptz,text,text,text,text,text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL 7A: الـ RPC ممنوحة لـ authenticated/anon';
  END IF;
  IF NOT has_function_privilege('service_role',
        'public.wa_create_ticket_from_flow(uuid,text,uuid,timestamptz,text,text,text,text,text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL 7B: الـ RPC غير ممنوحة لـ service_role';
  END IF;
  IF has_table_privilege('authenticated', 'public.whatsapp_ticket_links', 'INSERT') THEN
    RAISE EXCEPTION 'FAIL 7C: authenticated له كتابة على الجدول';
  END IF;
  -- المالك يرى رابطه كـ authenticated، وعميل آخر لا يراه.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  IF (SELECT count(*) FROM public.whatsapp_ticket_links) <> 2 THEN
    RAISE EXCEPTION 'FAIL 7D: المالك يرى % من روابطه لا 2', (SELECT count(*) FROM public.whatsapp_ticket_links);
  END IF;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a3', true);
  IF (SELECT count(*) FROM public.whatsapp_ticket_links) <> 0 THEN
    RAISE EXCEPTION 'FAIL 7E: عميل آخر يرى روابط ليست له';
  END IF;
  RESET ROLE;
  RAISE NOTICE 'PASS 7: RPC لـ service_role فقط + الجدول قراءة فقط + المالك يرى روابطه وحده';
END $$;

-- ⑧ التراجع وإعادة التطبيق (على نمط اختبار 160 §6).
-- t_call_wa تعتمد على الدالة، فتُسقط قبل التراجع (وإلا رفض DROP
-- لوجود معتمدين) وتُعاد بعد إعادة التطبيق.
DROP FUNCTION IF EXISTS t_call_wa(uuid, text, uuid, timestamptz, text, text, text, text, text);
\i migrations/_rollback/161_whatsapp_ticket_links.down.sql
DO $$
BEGIN
  IF to_regprocedure('public.wa_create_ticket_from_flow(uuid,text,uuid,timestamptz,text,text,text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 8A: الدالة باقية بعد التراجع';
  END IF;
  IF to_regclass('public.whatsapp_ticket_links') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 8B: الجدول باقٍ بعد التراجع';
  END IF;
  IF pg_get_functiondef('public.enforce_ticket_quota()'::regprocedure) LIKE '%whatsapp_flow%' THEN
    RAISE EXCEPTION 'FAIL 8C: فرع واتساب باقٍ في الحارس بعد التراجع';
  END IF;
  RAISE NOTICE 'PASS 8A: التراجع أسقط الدالة والجدول والأعمدة وأعاد الحارس';
END $$;
\i migrations/161_whatsapp_ticket_links.sql
CREATE OR REPLACE FUNCTION t_call_wa(p_owner uuid, p_sender text, p_run uuid, p_started timestamptz,
  p_transcript text, p_name text, p_phone text, p_title text, p_category text)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$
  select public.wa_create_ticket_from_flow(p_owner, p_sender, p_run, p_started, p_transcript, p_name, p_phone, p_title, p_category);
$$;
DO $$
BEGIN
  IF to_regprocedure('public.wa_create_ticket_from_flow(uuid,text,uuid,timestamptz,text,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'FAIL 8D: إعادة 161 لم تعد الدالة';
  END IF;
  IF pg_get_functiondef('public.enforce_ticket_quota()'::regprocedure) NOT LIKE '%whatsapp_flow%' THEN
    RAISE EXCEPTION 'FAIL 8E: إعادة 161 لم تعد فرع الإعفاء';
  END IF;
  RAISE NOTICE 'PASS 8B: إعادة 161 بعد التراجع تعيد الدالة وفرع الإعفاء';
END $$;

\echo 'ALL WHATSAPP TICKET 161 TESTS PASSED'
