-- ============================================================================
-- 146_company_five_sections — الأقسام الخمسة داخل لوحة الشركة.
--
-- على نمط company-data-export-140.test.sql: بذور دنيا لما يعتمد عليه
-- الترحيل فقط، ثم الترحيل نفسه مرتين (قابلية إعادة التشغيل)، ثم التراجع
-- وإعادة التطبيق. البذور أمينة للمسارات المُختبَرة لا نسخة من الإنتاج:
--   • current_company_id() بذرة: شركة يملكها ← أقدم شركة موظف نشط فيها ←
--     عضويته الأساسية (096 يضيف سياق العميل والمفتاح؛ البوابة المُختبَرة
--     هنا هي «عضو الفريق مقابل عميل/غريب» لا تفاصيل ذلك السياق).
--   • company_staff_role() بذرة: مالك ← admin، وصف company_staff ← الدور
--     (086 يضيف فحص account_is_active و preview_mode و is_company_admin؛
--     بوابة الحساب لها اختبارها في account-gate-ban-144.test.sql).
--   • _company_is_eligible_agent() بذرة: دور staff غير null وحساب غير
--     محظور (الحقيقي يضيف _inbox_account_active؛ المنع هنا حد أدنى).
--   • _company_perm() بذرة: admin/supervisor كل شيء، agent ما يخصه
--     (الكتالوج والتجاوزات في 098؛ البوابة المُختبَرة هي customers.view).
--   • دوال _continuity_* بذور أمينة للمنطق المستعمل (تحقق النصوص،
--     التصنيف، الموعد، البصمة، السجل) — لا نسخة من 073/077/093.
--
--   ⓪ الدوال الـ12 موجودة SECURITY DEFINER، بلا معامل company_id، ولا
--      منح لـ anon، ولا منح على الداخلية للمصادَقين
--   ① my_access: العضو/العميل/المجهول؛ enabled=false قبل أي سجل
--   ② الإنشاء: مساحة company تُنشأ كسولًا؛ إعادة مفتاح التكرار؛ تعارضه؛
--      handover و sources و follow_up بلا موعد مرفوضة
--   ③ العزل: شركة ب لا ترى سجلات أ؛ العميل 42501؛ عضو شركة أخرى P0002
--   ④ التعديل: النسخة، والمفتاح الممنوع، والغريب
--   ⑤ الانتقال: آلة الحالات كاملة + ready_for_handover مرفوض
--   ⑥ الإسناد: المشرف يُسند، والمالك لنفسه فقط، والعميل/شركة أخرى مرفوض
--   ⑦ الملاحظات والأحداث: الإلحاق، والبوابة، والتعتيم على الغريب
--   ⑧ سجل العميل: الحزمة كاملة، وعميل شركة أخرى null، والعميل-الموظف null
--   ⑨ الأداء: القائمة من المالك + company_staff لا profiles.role،
--      والتذاكر/الردود/المتوسطات، والتقييمات والشات على مستوى الشركة
--   ⑩ إعادة التطبيق، ثم التراجع (الدوال تزول والبيانات تبقى)، وإعادة التطبيق
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
END $$;
GRANT USAGE ON SCHEMA auth, public, extensions TO authenticated, anon, service_role;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid; $$;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text);

DROP SCHEMA IF EXISTS t CASCADE;
CREATE SCHEMA t;
GRANT USAGE ON SCHEMA t TO authenticated, service_role, anon;

CREATE FUNCTION t.act(p uuid) RETURNS void LANGUAGE sql AS $$
  select set_config('request.jwt.claim.sub', coalesce(p::text, ''), false),
         set_config('request.jwt.claim.role', case when p is null then '' else 'authenticated' end, false),
         set_config('request.jwt.claims', case when p is null then ''
                      else jsonb_build_object('sub', p, 'role', 'authenticated')::text end, false); $$;
CREATE FUNCTION t.call(p uuid, p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
declare v jsonb;
begin
  perform t.act(p);
  execute 'set local role authenticated';
  execute 'select to_jsonb((' || p_sql || '))' into v;
  execute 'reset role';
  return v;
end $$;
CREATE FUNCTION t.err(p uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  perform t.call(p, p_sql);
  return 'ok';
exception when others then
  return sqlstate;
end $$;
CREATE FUNCTION t.ok(p_cond boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
begin
  if p_cond is distinct from true then raise exception 'FAIL %', p_label; end if;
end $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ── الجداول (الحد الأدنى بأعمدته وقيوده كما في 073/077/093/096/097/098/101/102/124/134) ──
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, email text, full_name text, username text, phone text,
  role text DEFAULT 'user', super_user_id uuid, ban_status text, ban_until timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE,
  company_name varchar NOT NULL, company_email text, status text DEFAULT 'active'
);
CREATE TABLE public.platform_feature_switches (key text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false, description text);
CREATE TABLE public.company_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  is_primary boolean NOT NULL DEFAULT false, status text NOT NULL DEFAULT 'active',
  joined_at timestamptz NOT NULL DEFAULT now(), joined_via text NOT NULL DEFAULT 'invitation',
  ended_at timestamptz, end_cause text
);
CREATE TABLE public.company_staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role text NOT NULL, granted_by uuid, updated_by uuid, revoked_at timestamptz
);
CREATE TABLE public.continuity_workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('platform', 'company')),
  company_id uuid UNIQUE REFERENCES public.companies(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false, default_timezone text NOT NULL DEFAULT 'Africa/Cairo',
  snapshot_retention_days int NOT NULL DEFAULT 365 CHECK (snapshot_retention_days = 365),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT continuity_workspaces_company_iff CHECK ((kind = 'company') = (company_id IS NOT NULL))
);
CREATE TABLE public.continuity_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.continuity_workspaces(id),
  kind text NOT NULL CHECK (kind IN ('follow_up', 'issue', 'handover')),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 160),
  summary text CHECK (char_length(summary) <= 4000),
  next_action text CHECK (char_length(next_action) <= 1000),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'scheduled', 'in_progress', 'waiting', 'ready_for_handover', 'resolved', 'cancelled')),
  waiting_on text CHECK (char_length(waiting_on) <= 1000),
  priority smallint NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 4),
  category text CHECK (category IS NULL OR category IN (
    'order_status', 'order_problem', 'general_inquiry', 'return_exchange', 'payment_billing',
    'product_service', 'technical_issue', 'complaint', 'other')),
  owner_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  team_id uuid,
  due_at timestamptz, due_tz text,
  problem text CHECK (char_length(problem) <= 4000),
  known_facts text CHECK (char_length(known_facts) <= 4000),
  unknowns text CHECK (char_length(unknowns) <= 4000),
  resolution_criteria text CHECK (char_length(resolution_criteria) <= 4000),
  resolution_note text CHECK (char_length(resolution_note) <= 4000),
  resolved_at timestamptz, resolved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  cancel_reason text CHECK (char_length(cancel_reason) <= 1000),
  closed_at timestamptz, created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_via text NOT NULL DEFAULT 'native' CHECK (created_via IN ('native', 'extension', 'integration', 'system')),
  idempotency_key uuid NOT NULL, request_hash text NOT NULL,
  CONSTRAINT continuity_records_due_pair CHECK ((due_at IS NULL) = (due_tz IS NULL)),
  CONSTRAINT continuity_records_closed_iff CHECK ((status IN ('resolved', 'cancelled')) = (closed_at IS NOT NULL)),
  CONSTRAINT continuity_records_resolved_note CHECK (status <> 'resolved' OR (resolution_note IS NOT NULL AND resolved_at IS NOT NULL)),
  CONSTRAINT continuity_records_cancel_reason CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL),
  CONSTRAINT continuity_records_followup_due CHECK (kind <> 'follow_up' OR status IN ('resolved', 'cancelled') OR due_at IS NOT NULL),
  CONSTRAINT continuity_records_idempotency UNIQUE (created_by, idempotency_key)
);
CREATE TABLE public.continuity_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id uuid NOT NULL REFERENCES public.continuity_records(id),
  workspace_id uuid NOT NULL REFERENCES public.continuity_workspaces(id),
  handover_id uuid, author_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.continuity_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  record_id uuid NOT NULL, workspace_id uuid NOT NULL, actor_id uuid, client text,
  kind text NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, title text NOT NULL,
  description text, status text DEFAULT 'open', priority text DEFAULT 'medium',
  created_at timestamptz DEFAULT now(), ticket_number bigint,
  category text, assigned_to uuid, first_response_at timestamptz, resolved_at timestamptz,
  company_id uuid, scope text,
  CONSTRAINT tickets_scope_check CHECK (scope IN ('company', 'mad3oom_support')),
  CONSTRAINT tickets_scope_company_iff CHECK ((scope = 'company') = (company_id IS NOT NULL))
);
CREATE TABLE public.ticket_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ticket_id uuid NOT NULL, user_id uuid NOT NULL,
  message text NOT NULL, created_at timestamptz DEFAULT now(), is_internal boolean DEFAULT false
);
CREATE TABLE public.company_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, customer_id uuid NOT NULL,
  subject text NOT NULL CHECK (char_length(btrim(subject)) BETWEEN 3 AND 200),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  assigned_to uuid, idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(), last_sender_kind text NOT NULL DEFAULT 'customer',
  closed_at timestamptz, closed_by uuid,
  CONSTRAINT company_conversations_closed_iff CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
CREATE TABLE public.company_conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL REFERENCES public.company_conversations(id) ON DELETE CASCADE,
  sender_id uuid, sender_kind text NOT NULL CHECK (sender_kind IN ('customer', 'staff')),
  is_internal boolean NOT NULL DEFAULT false,
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.customer_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL,
  from_company uuid NOT NULL, to_company uuid NOT NULL, status text NOT NULL,
  initiated_as text, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz
);
CREATE TABLE public.subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text NOT NULL, name text NOT NULL, name_ar text,
  is_active boolean DEFAULT true NOT NULL, sort_order integer DEFAULT 100 NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL, updated_at timestamptz DEFAULT now() NOT NULL,
  requires_company boolean DEFAULT false NOT NULL, price_monthly numeric(14,2), price_yearly numeric(14,2),
  currency text DEFAULT 'USD'::text NOT NULL
);
CREATE TABLE public.customer_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, plan_id uuid NOT NULL,
  status text DEFAULT 'active'::text NOT NULL, start_date timestamptz DEFAULT now() NOT NULL,
  end_date timestamptz, created_at timestamptz DEFAULT now() NOT NULL, updated_at timestamptz DEFAULT now() NOT NULL
);
CREATE TABLE public.chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status text DEFAULT 'active'::text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  guest_id text, is_manual_mode boolean DEFAULT false, bot_state jsonb DEFAULT '{}'::jsonb NOT NULL
);
CREATE TABLE public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid, sender_id uuid, message_text text NOT NULL,
  is_bot_reply boolean DEFAULT false, created_at timestamptz DEFAULT now(), is_admin_reply boolean DEFAULT false,
  image_url text, audio_url text, attachment jsonb, edited_at timestamptz, deleted_at timestamptz
);
CREATE TABLE public.chat_ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL, rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment text, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_ratings_one_per_session UNIQUE (session_id)
);

-- ── بذور الدوال التي يعتمد عليها 146 ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public._feature_on(p_key text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT coalesce((SELECT enabled FROM public.platform_feature_switches WHERE key = p_key), false);
$$;
CREATE OR REPLACE FUNCTION public._company_staff_role_of(p_company uuid, p_user uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT CASE
    WHEN p_company IS NULL OR p_user IS NULL THEN NULL
    WHEN EXISTS (SELECT 1 FROM public.companies c WHERE c.id = p_company AND c.user_id = p_user) THEN 'admin'
    ELSE (SELECT s.role FROM public.company_staff s
           WHERE s.company_id = p_company AND s.user_id = p_user AND s.revoked_at IS NULL)
  END;
$$;
CREATE OR REPLACE FUNCTION public.current_company_id() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v uuid;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NULL; END IF;
  SELECT c.id INTO v FROM public.companies c WHERE c.user_id = auth.uid() LIMIT 1;
  IF v IS NOT NULL THEN RETURN v; END IF;
  SELECT s.company_id INTO v FROM public.company_staff s
   WHERE s.user_id = auth.uid() AND s.revoked_at IS NULL ORDER BY s.company_id LIMIT 1;
  IF v IS NOT NULL THEN RETURN v; END IF;
  SELECT m.company_id INTO v FROM public.company_memberships m
   WHERE m.user_id = auth.uid() AND m.status = 'active' AND m.is_primary LIMIT 1;
  RETURN v;
END $$;
CREATE OR REPLACE FUNCTION public.company_staff_role() RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_company uuid;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NULL; END IF;
  v_company := public.current_company_id();
  IF v_company IS NULL THEN RETURN NULL; END IF;
  RETURN public._company_staff_role_of(v_company, auth.uid());
END $$;
CREATE OR REPLACE FUNCTION public._company_is_eligible_agent(p_company uuid, p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT public._company_staff_role_of(p_company, p_user) IS NOT NULL
     AND coalesce((SELECT p.ban_status IS NULL OR p.ban_status IN ('none') FROM public.profiles p WHERE p.id = p_user), false);
$$;
CREATE OR REPLACE FUNCTION public._company_customer_active(p_company uuid, p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT p_company IS NOT NULL AND p_user IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.company_memberships m
                  WHERE m.company_id = p_company AND m.user_id = p_user AND m.status = 'active')
     AND NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = p_company AND c.user_id = p_user)
     AND public._company_staff_role_of(p_company, p_user) IS NULL;
$$;
CREATE OR REPLACE FUNCTION public._company_perm(p_company uuid, p_user uuid, p_key text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT CASE public._company_staff_role_of(p_company, p_user)
    WHEN 'admin' THEN true
    WHEN 'supervisor' THEN true
    WHEN 'agent' THEN p_key IN ('tickets.view_assigned', 'conversations.view_assigned', 'conversations.reply')
    ELSE false END;
$$;
CREATE OR REPLACE FUNCTION public._continuity_validation(p_field text, p_reason text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  RAISE EXCEPTION 'بيانات غير صالحة: %', p_field USING errcode = '22023',
    detail = jsonb_build_object('code', 'validation_failed', 'field', p_field, 'reason', p_reason)::text;
END $$;
CREATE OR REPLACE FUNCTION public._continuity_text_ok(p jsonb, p_field text, p_max integer) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public' AS $$
BEGIN
  IF p IS NULL OR jsonb_typeof(p) = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(p) <> 'string' OR char_length(p #>> '{}') > p_max THEN
    PERFORM public._continuity_validation(p_field);
  END IF;
  RETURN p #>> '{}';
END $$;
CREATE OR REPLACE FUNCTION public._continuity_parse_category(p jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public' AS $$
BEGIN
  IF p IS NULL OR jsonb_typeof(p) = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(p) <> 'string' OR (p #>> '{}') NOT IN (
       'order_status', 'order_problem', 'general_inquiry', 'return_exchange', 'payment_billing',
       'product_service', 'technical_issue', 'complaint', 'other') THEN
    PERFORM public._continuity_validation('category');
  END IF;
  RETURN p #>> '{}';
END $$;
CREATE OR REPLACE FUNCTION public._continuity_parse_due(p_due jsonb, p_kind text, p_is_new boolean, OUT o_at timestamptz, OUT o_tz text)
LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  o_at := NULL; o_tz := NULL;
  IF p_due IS NULL OR jsonb_typeof(p_due) = 'null' THEN RETURN; END IF;
  BEGIN
    o_at := (p_due ->> 'at')::timestamptz;
    o_tz := p_due ->> 'tz';
  EXCEPTION WHEN OTHERS THEN
    PERFORM public._continuity_validation('due');
  END;
END $$;
CREATE OR REPLACE FUNCTION public._continuity_hash(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $$
  SELECT CASE WHEN p IS NULL THEN NULL ELSE encode(sha256(convert_to(p, 'UTF8')), 'hex') END;
$$;
CREATE OR REPLACE FUNCTION public._continuity_client() RETURNS text
LANGUAGE sql STABLE SET search_path TO 'public' AS $$ SELECT 'native'; $$;
CREATE OR REPLACE FUNCTION public._continuity_record_json(p_record uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT jsonb_build_object(
    'id', r.id, 'kind', r.kind, 'title', r.title, 'summary', r.summary, 'next_action', r.next_action,
    'status', r.status, 'waiting_on', r.waiting_on, 'priority', r.priority, 'category', r.category,
    'owner_id', r.owner_id, 'team_id', r.team_id, 'due_at', r.due_at, 'due_tz', r.due_tz,
    'overdue', (r.status NOT IN ('resolved', 'cancelled') AND r.due_at IS NOT NULL AND r.due_at < now()),
    'problem', r.problem, 'known_facts', r.known_facts, 'unknowns', r.unknowns,
    'resolution_criteria', r.resolution_criteria, 'resolution_note', r.resolution_note,
    'resolved_at', r.resolved_at, 'resolved_by', r.resolved_by, 'cancel_reason', r.cancel_reason,
    'closed_at', r.closed_at, 'created_by', r.created_by, 'created_at', r.created_at,
    'updated_at', r.updated_at, 'version', r.version, 'created_via', r.created_via)
  FROM public.continuity_records r WHERE r.id = p_record;
$$;
CREATE OR REPLACE FUNCTION public._continuity_note_json(x public.continuity_notes) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT jsonb_build_object('id', x.id, 'record_id', x.record_id, 'workspace_id', x.workspace_id,
    'handover_id', x.handover_id, 'author_id', x.author_id, 'body', x.body, 'created_at', x.created_at);
$$;
CREATE OR REPLACE FUNCTION public._continuity_log(p_record uuid, p_workspace uuid, p_kind text, p_payload jsonb, p_client text DEFAULT NULL) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$
  INSERT INTO public.continuity_events (record_id, workspace_id, actor_id, client, kind, payload)
  VALUES (p_record, p_workspace, auth.uid(), coalesce(p_client, 'native'), p_kind, p_payload);
$$;

-- ── الفاعلون والبيانات ─────────────────────────────────────────────────────
--   أ: مالك a1، مشرف a2، موظف a3، عميلان a4/a5 · ب: مالك b1، موظف b2، عميل b3 · فرد c1
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-8000-0000000000a1', 'owner-a@t.io'), ('00000000-0000-4000-8000-0000000000a2', 'sup-a@t.io'),
  ('00000000-0000-4000-8000-0000000000a3', 'agent-a@t.io'), ('00000000-0000-4000-8000-0000000000a4', 'cust-a1@t.io'),
  ('00000000-0000-4000-8000-0000000000a5', 'cust-a2@t.io'), ('00000000-0000-4000-8000-0000000000b1', 'owner-b@t.io'),
  ('00000000-0000-4000-8000-0000000000b2', 'agent-b@t.io'), ('00000000-0000-4000-8000-0000000000b3', 'cust-b1@t.io'),
  ('00000000-0000-4000-8000-0000000000c1', 'solo@t.io');
INSERT INTO public.profiles (id, email, full_name, role) VALUES
  ('00000000-0000-4000-8000-0000000000a1', 'owner-a@t.io', 'مالك أ', 'user'),
  ('00000000-0000-4000-8000-0000000000a2', 'sup-a@t.io', 'مشرف أ', 'company_user'),
  ('00000000-0000-4000-8000-0000000000a3', 'agent-a@t.io', 'موظف أ', 'company_user'),
  ('00000000-0000-4000-8000-0000000000a4', 'cust-a1@t.io', 'عميل أ1', 'user'),
  ('00000000-0000-4000-8000-0000000000a5', 'cust-a2@t.io', 'عميل أ2', 'user'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner-b@t.io', 'مالك ب', 'user'),
  ('00000000-0000-4000-8000-0000000000b2', 'agent-b@t.io', 'موظف ب', 'company_user'),
  ('00000000-0000-4000-8000-0000000000b3', 'cust-b1@t.io', 'عميل ب1', 'user'),
  ('00000000-0000-4000-8000-0000000000c1', 'solo@t.io', 'فرد', 'user');
INSERT INTO public.companies (id, user_id, company_name) VALUES
  ('10000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a1', 'شركة أ'),
  ('10000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b1', 'شركة ب');
INSERT INTO public.company_staff (company_id, user_id, role) VALUES
  ('10000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2', 'supervisor'),
  ('10000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a3', 'agent'),
  ('10000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2', 'agent');
INSERT INTO public.company_memberships (company_id, user_id, is_primary, status, joined_via) VALUES
  ('10000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a4', true, 'active', 'invitation'),
  ('10000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a5', true, 'active', 'invitation'),
  ('10000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b3', true, 'active', 'invitation');
INSERT INTO public.platform_feature_switches (key, enabled) VALUES
  ('company_permissions_enabled', false), ('company_inbox_enabled', false), ('multi_company_memberships_enabled', false);
INSERT INTO public.tickets (id, user_id, title, status, priority, created_at, ticket_number, category, assigned_to, first_response_at, resolved_at, company_id, scope) VALUES
  ('20000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a4', 'مشكلة الفاتورة', 'open', 'high', now() - interval '5 days', 1001, 'billing', '00000000-0000-4000-8000-0000000000a3', NULL, NULL, '10000000-0000-4000-8000-0000000000a1', 'company'),
  ('20000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000a4', 'طلب إرجاع', 'resolved', 'medium', now() - interval '6 days', 1002, 'return', '00000000-0000-4000-8000-0000000000a3', now() - interval '6 days' + interval '1 hour', now() - interval '4 days', '10000000-0000-4000-8000-0000000000a1', 'company'),
  ('20000000-0000-4000-8000-0000000000a3', '00000000-0000-4000-8000-0000000000a5', 'استفسار عام', 'in-progress', 'low', now() - interval '2 days', 1003, 'general', '00000000-0000-4000-8000-0000000000a2', NULL, NULL, '10000000-0000-4000-8000-0000000000a1', 'company'),
  ('20000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b3', 'مشكلة ب', 'open', 'medium', now() - interval '3 days', 2001, 'general', '00000000-0000-4000-8000-0000000000b2', NULL, NULL, '10000000-0000-4000-8000-0000000000b1', 'company'),
  ('20000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000a4', 'دعم المنصة', 'open', 'medium', now() - interval '5 days', 3001, 'general', NULL, NULL, NULL, NULL, 'mad3oom_support');
INSERT INTO public.ticket_replies (id, ticket_id, user_id, message, is_internal, created_at) VALUES
  ('30000000-0000-4000-8000-0000000000a1', '20000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a3', 'رد علني', false, now() - interval '5 days' + interval '30 minutes'),
  ('30000000-0000-4000-8000-0000000000a2', '20000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a3', 'ملاحظة داخلية', true, now() - interval '5 days' + interval '40 minutes'),
  ('30000000-0000-4000-8000-0000000000a3', '20000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000a3', 'تم الإرجاع', false, now() - interval '5 days'),
  ('30000000-0000-4000-8000-0000000000b1', '20000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2', 'رد ب', false, now() - interval '3 days');
INSERT INTO public.company_conversations (id, company_id, customer_id, subject, status, assigned_to, idempotency_key, last_message_at) VALUES
  ('40000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a4', 'محادثة أ1', 'open', '00000000-0000-4000-8000-0000000000a3', gen_random_uuid(), now() - interval '1 day');
INSERT INTO public.company_conversation_messages (id, conversation_id, sender_id, sender_kind, is_internal, body, created_at) VALUES
  ('50000000-0000-4000-8000-0000000000a1', '40000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a4', 'customer', false, 'مرحبًا', now() - interval '1 day'),
  ('50000000-0000-4000-8000-0000000000a2', '40000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a3', 'staff', false, 'أهلًا بك', now() - interval '1 day' + interval '10 minutes'),
  ('50000000-0000-4000-8000-0000000000a3', '40000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a3', 'staff', true, 'تابع لاحقًا', now() - interval '1 day' + interval '20 minutes');
INSERT INTO public.customer_transfers (id, customer_id, from_company, to_company, status, initiated_as, created_at, expires_at) VALUES
  ('60000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a4', '10000000-0000-4000-8000-0000000000b1', '10000000-0000-4000-8000-0000000000a1', 'approved', 'customer', now() - interval '10 days', now() + interval '5 days'),
  ('60000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000a5', '10000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000b1', 'pending', 'customer', now() - interval '2 days', now() + interval '5 days');
INSERT INTO public.subscription_plans (id, key, name, name_ar) VALUES
  ('70000000-0000-4000-8000-0000000000a1', 'support', 'Support', 'الدعم'),
  ('70000000-0000-4000-8000-0000000000b1', 'ultimate', 'Ultimate', 'الفائقة');
INSERT INTO public.customer_subscriptions (id, user_id, plan_id, status, start_date, end_date) VALUES
  ('80000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a4', '70000000-0000-4000-8000-0000000000a1', 'active', now() - interval '20 days', now() + interval '10 days'),
  ('80000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b3', '70000000-0000-4000-8000-0000000000b1', 'active', now() - interval '20 days', now() + interval '10 days');
INSERT INTO public.chat_sessions (id, user_id, created_at) VALUES
  ('90000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a4', now() - interval '3 days'),
  ('90000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b3', now() - interval '3 days');
INSERT INTO public.chat_messages (id, session_id, sender_id, message_text, created_at) VALUES
  ('91000000-0000-4000-8000-0000000000a1', '90000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a4', 'سؤال', now() - interval '3 days'),
  ('91000000-0000-4000-8000-0000000000a2', '90000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a3', 'جواب', now() - interval '3 days' + interval '5 minutes'),
  ('91000000-0000-4000-8000-0000000000a3', '90000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a4', 'شكرًا', now() - interval '3 days' + interval '6 minutes'),
  ('91000000-0000-4000-8000-0000000000b1', '90000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b3', 'سؤال ب', now() - interval '3 days');
INSERT INTO public.chat_ratings (id, session_id, user_id, rating, created_at) VALUES
  ('92000000-0000-4000-8000-0000000000a1', '90000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a4', 5, now() - interval '3 days'),
  ('92000000-0000-4000-8000-0000000000b1', '90000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b3', 2, now() - interval '3 days');

-- ── ⓪ قبل 146 ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM t.ok(to_regprocedure('public.company_continuity_get(uuid)') IS NULL, '0a: الدوال غير موجودة قبل الترحيل');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a1', '(select 1 from public.company_continuity_my_access())') = '42883', '0b: النداء قبل 146 هو 42883');
  RAISE NOTICE 'PASS 0: قبل 146 لا دوال — الواجهة تعرف ذلك';
END $$;

\i migrations/146_company_five_sections.sql
SET search_path = public, extensions;

-- إعادة التطبيق فورًا: قابلة لإعادة التشغيل بلا تضاعف.
\i migrations/146_company_five_sections.sql
SET search_path = public, extensions;

DO $$
DECLARE
  v_n int;
  v_owner_a constant uuid := '00000000-0000-4000-8000-0000000000a1';
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
     AND p.proname IN ('company_continuity_my_access', 'company_continuity_list', 'company_continuity_get',
                       'company_continuity_create', 'company_continuity_update', 'company_continuity_transition',
                       'company_continuity_assign', 'company_continuity_note_add', 'company_continuity_notes_for',
                       'company_continuity_events_for', 'company_customer_history', 'company_team_performance');
  PERFORM t.ok(v_n = 12, '0c: 12 دالة SECURITY DEFINER (وجد ' || v_n || ')');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name LIKE 'company\_continuity\_%'
      AND grantee IN ('anon', 'PUBLIC')), '0d: لا منح لـ anon على دوال الاستمرارية');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name LIKE '\_company\_continuity\_%'
      AND grantee IN ('anon', 'authenticated', 'service_role', 'PUBLIC')), '0e: لا منح على الداخلية');
  PERFORM t.ok((t.call(v_owner_a, '(select public.company_continuity_my_access())') ->> 'enabled')::boolean = false,
               '0f: إعادة التطبيق لم تُنشئ مساحة (enabled=false)');
  RAISE NOTICE 'PASS 0b: 12 دالة SECURITY DEFINER، والمنح كما يجب، وإعادة التطبيق آمنة';
END $$;

-- ── ① my_access ───────────────────────────────────────────────────────────
DO $$
DECLARE
  v_owner_a constant uuid := '00000000-0000-4000-8000-0000000000a1';
  v_agent_a constant uuid := '00000000-0000-4000-8000-0000000000a3';
  v_cust_a1 constant uuid := '00000000-0000-4000-8000-0000000000a4';
  r jsonb;
BEGIN
  r := t.call(v_owner_a, '(select public.company_continuity_my_access())');
  PERFORM t.ok((r ->> 'member')::boolean AND (r ->> 'role') = 'admin' AND (r ->> 'supervisor')::boolean
               AND (r ->> 'enabled')::boolean = false AND (r ->> 'company_id') = '10000000-0000-4000-8000-0000000000a1', '1a: مالك أ ' || r::text);
  r := t.call(v_agent_a, '(select public.company_continuity_my_access())');
  PERFORM t.ok((r ->> 'member')::boolean AND (r ->> 'role') = 'agent' AND NOT (r ->> 'supervisor')::boolean, '1b: موظف أ ' || r::text);
  r := t.call(v_cust_a1, '(select public.company_continuity_my_access())');
  PERFORM t.ok(NOT (r ->> 'member')::boolean AND (r ->> 'role') IS NULL, '1c: عميل أ ليس عضو فريق');
  PERFORM t.ok(t.err(NULL, '(select public.company_continuity_my_access())') = 'ok'
               AND (t.call(NULL, '(select public.company_continuity_my_access())') ->> 'member') = 'false', '1d: مجهول member=false');
  RAISE NOTICE 'PASS 1: my_access يفرّق المالك والموظف والعميل والمجهول، وenabled=false قبل أي سجل';
END $$;

-- ── ② الإنشاء ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_agent_a constant uuid := '00000000-0000-4000-8000-0000000000a3';
  v_owner_b constant uuid := '00000000-0000-4000-8000-0000000000b1';
  v_key constant uuid := '40000000-0000-4000-8000-0000000000a1';
  v_req jsonb;
  r jsonb;
  v_id uuid;
BEGIN
  PERFORM t.ok((t.call(v_agent_a, '(select public.company_continuity_list())')::text) = '[]', '2a: القائمة فارغة قبل الإنشاء');
  v_req := jsonb_build_object('contract_version', '1', 'idempotency_key', v_key, 'kind', 'issue',
    'title', 'مشكلة متكررة', 'summary', 'تتكرر كل أسبوع', 'category', 'technical_issue',
    'issue', jsonb_build_object('problem', 'الخدمة تتوقف'));
  r := t.call(v_agent_a, format('(select public.company_continuity_create(%L::jsonb))', v_req));
  v_id := (r -> 'record' ->> 'id')::uuid;
  PERFORM t.ok(v_id IS NOT NULL AND (r -> 'record' ->> 'status') = 'open' AND (r -> 'record' ->> 'kind') = 'issue'
               AND (r -> 'record' ->> 'team_id') IS NULL AND (r -> 'sources') = '[]'::jsonb
               AND (r ->> 'replayed')::boolean = false, '2b: الإنشاء ' || r::text);
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.continuity_workspaces w
    WHERE w.kind = 'company' AND w.company_id = '10000000-0000-4000-8000-0000000000a1' AND w.enabled), '2c: مساحة شركة أ أُنشئت كسولًا مفعّلة');
  PERFORM t.ok((SELECT count(*) FROM public.continuity_workspaces WHERE kind = 'company') = 1, '2d: مساحة واحدة فقط');
  -- إعادة مفتاح التكرار نفسه: نفس السجل، replayed=true، بلا صف جديد.
  r := t.call(v_agent_a, format('(select public.company_continuity_create(%L::jsonb))', v_req));
  PERFORM t.ok((r -> 'record' ->> 'id')::uuid = v_id AND (r ->> 'replayed')::boolean = true, '2e: إعادة المفتاح تعيد التشغيل');
  PERFORM t.ok((SELECT count(*) FROM public.continuity_records) = 1, '2f: صف واحد رغم الإعادة');
  -- نفس المفتاح بحمولة مختلفة: تعارض.
  PERFORM t.ok(t.err(v_agent_a, format('(select public.company_continuity_create(%L::jsonb))',
    v_req || jsonb_build_object('title', 'عنوان مختلف'))) = '23505', '2g: تعارض مفتاح التكرار');
  -- handover مرفوض، و sources مرفوض، و follow_up بلا موعد مرفوض، وعقد قديم مرفوض.
  PERFORM t.ok(t.err(v_agent_a, format('(select public.company_continuity_create(%L::jsonb))',
    v_req || jsonb_build_object('kind', 'handover', 'idempotency_key', gen_random_uuid()))) = '0A000', '2h: handover مؤجَّل');
  PERFORM t.ok(t.err(v_agent_a, format('(select public.company_continuity_create(%L::jsonb))',
    v_req || jsonb_build_object('sources', '[]'::jsonb, 'idempotency_key', gen_random_uuid()))) = '22023', '2i: sources مرفوض صراحةً');
  PERFORM t.ok(t.err(v_agent_a, format('(select public.company_continuity_create(%L::jsonb))',
    jsonb_build_object('contract_version', '1', 'idempotency_key', gen_random_uuid(), 'kind', 'follow_up',
                       'title', 'متابعة', 'next_action', 'اتصل'))) = '22023', '2j: follow_up بلا موعد');
  PERFORM t.ok(t.err(v_agent_a, format('(select public.company_continuity_create(%L::jsonb))',
    v_req || jsonb_build_object('contract_version', '0', 'idempotency_key', gen_random_uuid()))) = '22023', '2k: عقد قديم');
  -- مفتاح التكرار لكل منشئ على حدة: مالك ب بنفس المفتاح ينجح، في مساحته هو.
  r := t.call(v_owner_b, format('(select public.company_continuity_create(%L::jsonb))', v_req));
  PERFORM t.ok((r -> 'record' ->> 'id')::uuid IS NOT NULL AND (r -> 'record' ->> 'id')::uuid <> v_id
               AND (r ->> 'replayed')::boolean = false, '2l: نفس المفتاح لمنشئ آخر حر ' || r::text);
  PERFORM t.ok((SELECT count(*) FROM public.continuity_records) = 2
               AND (SELECT count(*) FROM public.continuity_workspaces WHERE kind = 'company') = 2,
               '2m: سجلان ومساحتان (أ وب)، ومفتاح أ لم يعِد تشغيل سجل ب');
  RAISE NOTICE 'PASS 2: الإنشاء والمساحة الكسولة وإعادة التكرار والرفوضات';
END $$;

-- معرّفا سجلَّي الشركتين للكتل التالية (الأقدم في كل مساحة).
CREATE FUNCTION t.rec_a() RETURNS uuid LANGUAGE sql AS $$
  SELECT r.id FROM public.continuity_records r JOIN public.continuity_workspaces w ON w.id = r.workspace_id
   WHERE w.company_id = '10000000-0000-4000-8000-0000000000a1' ORDER BY r.created_at LIMIT 1; $$;
CREATE FUNCTION t.rec_b() RETURNS uuid LANGUAGE sql AS $$
  SELECT r.id FROM public.continuity_records r JOIN public.continuity_workspaces w ON w.id = r.workspace_id
   WHERE w.company_id = '10000000-0000-4000-8000-0000000000b1' ORDER BY r.created_at LIMIT 1; $$;
GRANT EXECUTE ON FUNCTION t.rec_a() TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION t.rec_b() TO authenticated, service_role, anon;

-- ── ③ العزل ───────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_owner_a constant uuid := '00000000-0000-4000-8000-0000000000a1';
  v_sup_a constant uuid := '00000000-0000-4000-8000-0000000000a2';
  v_agent_a constant uuid := '00000000-0000-4000-8000-0000000000a3';
  v_cust_a1 constant uuid := '00000000-0000-4000-8000-0000000000a4';
  v_owner_b constant uuid := '00000000-0000-4000-8000-0000000000b1';
  v_agent_b constant uuid := '00000000-0000-4000-8000-0000000000b2';
  r jsonb;
BEGIN
  r := t.call(v_owner_a, '(select public.company_continuity_list())');
  PERFORM t.ok(jsonb_array_length(r) = 1 AND (r -> 0 ->> 'title') = 'مشكلة متكررة', '3a: قائمة أ تحوي سجل أ وحده ' || r::text);
  r := t.call(v_owner_b, '(select public.company_continuity_list())');
  PERFORM t.ok(jsonb_array_length(r) = 1 AND (r -> 0 ->> 'title') = 'مشكلة متكررة', '3b: قائمة ب تحوي سجل ب وحده (نفس العنوان، سجل آخر)');
  PERFORM t.ok((t.call(v_owner_a, '(select public.company_continuity_list())') -> 0 ->> 'id')
               <> (t.call(v_owner_b, '(select public.company_continuity_list())') -> 0 ->> 'id'), '3c: السجلان مختلفان');
  PERFORM t.ok(t.err(v_agent_b, format('(select public.company_continuity_get(%L::uuid))', t.rec_a())) = 'P0002', '3d: موظف ب على سجل أ → P0002');
  PERFORM t.ok(t.err(v_cust_a1, format('(select public.company_continuity_get(%L::uuid))', t.rec_a())) = '42501', '3e: عميل أ على سجل أ → 42501 (ليس عضو فريق)');
  PERFORM t.ok(t.err(v_owner_a, format('(select public.company_continuity_get(%L::uuid))', t.rec_b())) = 'P0002', '3f: مالك أ على سجل ب → P0002');
  r := t.call(v_sup_a, format('(select public.company_continuity_get(%L::uuid))', t.rec_a()));
  PERFORM t.ok((r -> 'record' ->> 'title') = 'مشكلة متكررة', '3g: مشرف أ يرى سجل أ');
  r := t.call(v_agent_a, format('(select public.company_continuity_get(%L::uuid))', t.rec_a()));
  PERFORM t.ok((r -> 'record' ->> 'title') = 'مشكلة متكررة', '3h: منشئ السجل يراه');
  PERFORM t.ok((t.call(v_owner_a, '(select public.company_continuity_my_access())') ->> 'enabled')::boolean = true,
               '3i: enabled=true بعد إنشاء أول سجل');
  RAISE NOTICE 'PASS 3: العزل بين الشركتين — كل شركة ترى سجلاتها وحدها، والعميل مرفوض';
END $$;

-- ── ④ التعديل ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_agent_a constant uuid := '00000000-0000-4000-8000-0000000000a3';
  v_agent_b constant uuid := '00000000-0000-4000-8000-0000000000b2';
  r jsonb;
BEGIN
  r := t.call(v_agent_a, format('(select public.company_continuity_update(%L::uuid, %L::jsonb, 1))',
    t.rec_a(), '{"title": "مشكلة متكررة — محدثة"}'::jsonb));
  PERFORM t.ok((r -> 'record' ->> 'title') = 'مشكلة متكررة — محدثة' AND (r -> 'record' ->> 'version')::int = 2, '4a: التعديل يرفع النسخة ' || r::text);
  PERFORM t.ok(t.err(v_agent_a, format('(select public.company_continuity_update(%L::uuid, %L::jsonb, 1))',
    t.rec_a(), '{"title": "قديم"}'::jsonb)) = '40001', '4b: نسخة قديمة → 40001');
  PERFORM t.ok(t.err(v_agent_a, format('(select public.company_continuity_update(%L::uuid, %L::jsonb, 2))',
    t.rec_a(), '{"status": "resolved"}'::jsonb)) = '22023', '4c: مفتاح غير قابل للتعديل');
  PERFORM t.ok(t.err(v_agent_b, format('(select public.company_continuity_update(%L::uuid, %L::jsonb, 2))',
    t.rec_a(), '{"title": "تخريب"}'::jsonb)) = 'P0002', '4d: موظف ب يعدّل سجل أ → P0002');
  PERFORM t.ok(t.err(v_agent_a, format('(select public.company_continuity_update(%L::uuid, %L::jsonb, 2))',
    t.rec_a(), '{"priority": 9}'::jsonb)) = '22023', '4e: أولوية خارج 1..4');
  RAISE NOTICE 'PASS 4: التعديل بفحص النسخة والقائمة البيضاء للحقول';
END $$;

-- ── ⑤ الانتقال ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_agent_a constant uuid := '00000000-0000-4000-8000-0000000000a3';
  r jsonb;
BEGIN
  PERFORM t.ok(t.err(v_agent_a, format('(select public.company_continuity_transition(%L::uuid, %L::text, %L::jsonb, 2))',
    t.rec_a(), 'waiting', '{}'::jsonb)) = '22023', '5a: waiting بلا waiting_on');
  r := t.call(v_agent_a, format('(select public.company_continuity_transition(%L::uuid, %L::text, %L::jsonb, 2))',
    t.rec_a(), 'waiting', '{"waiting_on": "بانتظار العميل"}'::jsonb));
  PERFORM t.ok((r -> 'record' ->> 'status') = 'waiting' AND (r -> 'record' ->> 'version')::int = 3, '5b: إلى waiting ' || r::text);
  PERFORM t.ok(t.err(v_agent_a, format('(select public.company_continuity_transition(%L::uuid, %L::text, %L::jsonb, 3))',
    t.rec_a(), 'resolved', '{}'::jsonb)) = '22023', '5c: resolved بلا ملاحظة');
  r := t.call(v_agent_a, format('(select public.company_continuity_transition(%L::uuid, %L::text, %L::jsonb, 3))',
    t.rec_a(), 'resolved', '{"resolution_note": "أُصلحت"}'::jsonb));
  PERFORM t.ok((r -> 'record' ->> 'status') = 'resolved' AND (r -> 'record' ->> 'closed_at') IS NOT NULL
               AND (r -> 'record' ->> 'version')::int = 4, '5d: إلى resolved مع closed_at');
  PERFORM t.ok(t.err(v_agent_a, format('(select public.company_continuity_transition(%L::uuid, %L::text, %L::jsonb, 4))',
    t.rec_a(), 'in_progress', '{}'::jsonb)) = '55000', '5e: انتقال من مغلق لنشط مباشرةً');
  r := t.call(v_agent_a, format('(select public.company_continuity_transition(%L::uuid, %L::text, %L::jsonb, 4))',
    t.rec_a(), 'open', '{"reason": "عادت المشكلة"}'::jsonb));
  PERFORM t.ok((r -> 'record' ->> 'status') = 'open' AND (r -> 'record' ->> 'closed_at') IS NULL
               AND (r -> 'record' ->> 'version')::int = 5, '5f: إعادة الفتح تمسح closed_at');
  PERFORM t.ok(t.err(v_agent_a, format('(select public.company_continuity_transition(%L::uuid, %L::text, %L::jsonb, 5))',
    t.rec_a(), 'ready_for_handover', '{}'::jsonb)) = '0A000', '5g: ready_for_handover مؤجَّل');
  RAISE NOTICE 'PASS 5: آلة الحالات — waiting/resolved/إعادة الفتح، والتسليم مرفوض';
END $$;

-- ── ⑥ الإسناد ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_sup_a constant uuid := '00000000-0000-4000-8000-0000000000a2';
  v_agent_a constant uuid := '00000000-0000-4000-8000-0000000000a3';
  v_cust_a1 constant uuid := '00000000-0000-4000-8000-0000000000a4';
  v_agent_b constant uuid := '00000000-0000-4000-8000-0000000000b2';
  r jsonb;
BEGIN
  r := t.call(v_sup_a, format('(select public.company_continuity_assign(%L::uuid, %L::uuid, 5))',
    t.rec_a(), v_agent_a));
  PERFORM t.ok((r -> 'record' ->> 'owner_id') = v_agent_a::text AND (r -> 'record' ->> 'version')::int = 6, '6a: المشرف يُسند لموظف أ ' || r::text);
  PERFORM t.ok(t.err(v_agent_a, format('(select public.company_continuity_assign(%L::uuid, %L::uuid, 6))',
    t.rec_a(), v_sup_a)) = '42501', '6b: المالك لا يُسند لغير نفسه');
  r := t.call(v_agent_a, format('(select public.company_continuity_assign(%L::uuid, %L::uuid, 6))',
    t.rec_a(), v_agent_a));
  PERFORM t.ok((r -> 'record' ->> 'version')::int = 6, '6c: إسناد لنفس المالك الحالي بلا تغيير');
  PERFORM t.ok(t.err(v_sup_a, format('(select public.company_continuity_assign(%L::uuid, %L::uuid, 6))',
    t.rec_a(), v_cust_a1)) = '22023', '6d: إسناد لعميل مرفوض (غير مؤهل)');
  PERFORM t.ok(t.err(v_sup_a, format('(select public.company_continuity_assign(%L::uuid, %L::uuid, 6))',
    t.rec_a(), v_agent_b)) = '22023', '6e: إسناد لموظف شركة أخرى مرفوض');
  r := t.call(v_sup_a, format('(select public.company_continuity_assign(%L::uuid, %L::uuid, 6))', t.rec_a(), NULL));
  PERFORM t.ok((r -> 'record' ->> 'owner_id') IS NULL AND (r -> 'record' ->> 'version')::int = 7, '6f: إلغاء الإسناد');
  RAISE NOTICE 'PASS 6: الإسناد — المشرف يُسند، والمالك لنفسه فقط، والغريب مرفوض';
END $$;

-- ── ⑦ الملاحظات والأحداث ───────────────────────────────────────────────────
DO $$
DECLARE
  v_agent_a constant uuid := '00000000-0000-4000-8000-0000000000a3';
  v_agent_b constant uuid := '00000000-0000-4000-8000-0000000000b2';
  v_cust_a1 constant uuid := '00000000-0000-4000-8000-0000000000a4';
  r jsonb;
BEGIN
  r := t.call(v_agent_a, format('(select public.company_continuity_note_add(%L::uuid, %L::text))',
    t.rec_a(), 'ملاحظة الفريق الأولى'));
  PERFORM t.ok((r ->> 'body') = 'ملاحظة الفريق الأولى' AND (r ->> 'handover_id') IS NULL
               AND (r ->> 'author_id') = v_agent_a::text, '7a: إضافة ملاحظة ' || r::text);
  PERFORM t.ok(t.err(v_agent_a, format('(select public.company_continuity_note_add(%L::uuid, %L::text))',
    t.rec_a(), '   ')) = '22023', '7b: ملاحظة فارغة');
  PERFORM t.ok(t.err(v_cust_a1, format('(select public.company_continuity_note_add(%L::uuid, %L::text))',
    t.rec_a(), 'عميل يكتب')) = '42501', '7c: عميل يضيف ملاحظة → 42501');
  r := t.call(v_agent_a, format('(select public.company_continuity_notes_for(%L::uuid))', t.rec_a()));
  PERFORM t.ok(jsonb_array_length(r) = 1 AND (r -> 0 ->> 'body') = 'ملاحظة الفريق الأولى', '7d: قراءة الملاحظات');
  PERFORM t.ok(t.err(v_agent_b, format('(select public.company_continuity_notes_for(%L::uuid))', t.rec_a())) = 'P0002', '7e: موظف ب يقرأ ملاحظات أ → P0002');
  r := t.call(v_agent_a, format('(select public.company_continuity_events_for(%L::uuid))', t.rec_a()));
  PERFORM t.ok(jsonb_array_length(r) >= 5
               AND EXISTS (SELECT 1 FROM jsonb_array_elements(r) e WHERE e ->> 'kind' = 'created')
               AND EXISTS (SELECT 1 FROM jsonb_array_elements(r) e WHERE e ->> 'kind' = 'note_added'),
               '7f: الأحداث تحوي created و note_added (' || jsonb_array_length(r) || ' حدثًا)');
  PERFORM t.ok(t.err(v_agent_b, format('(select public.company_continuity_events_for(%L::uuid))', t.rec_a())) = 'P0002', '7g: موظف ب يقرأ أحداث أ → P0002');
  RAISE NOTICE 'PASS 7: الملاحظات إلحاق فقط بلا handover، والأحداث مسجَّلة ومعزولة';
END $$;

-- ── ⑧ سجل العميل ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v_owner_a constant uuid := '00000000-0000-4000-8000-0000000000a1';
  v_sup_a constant uuid := '00000000-0000-4000-8000-0000000000a2';
  v_agent_a constant uuid := '00000000-0000-4000-8000-0000000000a3';
  v_cust_a1 constant uuid := '00000000-0000-4000-8000-0000000000a4';
  v_cust_b1 constant uuid := '00000000-0000-4000-8000-0000000000b3';
  v_owner_b constant uuid := '00000000-0000-4000-8000-0000000000b1';
  r jsonb;
BEGIN
  r := t.call(v_owner_a, format('(select public.company_customer_history(%L::uuid))', v_cust_a1));
  PERFORM t.ok((r -> 'customer' ->> 'name') = 'عميل أ1', '8a: العميل ' || (r -> 'customer')::text);
  PERFORM t.ok(jsonb_array_length(r -> 'tickets') = 2, '8b: تذكرتا أ1 الشركيتان (بلا تذكرة المنصة 3001)');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'tickets') t WHERE (t ->> 'ticket_number') IN ('2001', '3001')), '8c: لا تذكرة ب ولا تذكرة mad3oom_support');
  PERFORM t.ok(jsonb_array_length(r -> 'replies') = 3, '8d: ردود أ1 الثلاثة (منها داخلي واحد)');
  PERFORM t.ok(EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'replies') x WHERE (x ->> 'is_internal')::boolean), '8e: الرد الداخلي ظاهر للفريق');
  PERFORM t.ok(jsonb_array_length(r -> 'conversations') = 1 AND jsonb_array_length(r -> 'conversation_messages') = 3, '8f: محادثة أ1 ورسائلها الثلاث');
  PERFORM t.ok(jsonb_array_length(r -> 'moves') = 1 AND (r -> 'moves' -> 0 ->> 'direction') = 'incoming', '8g: نقل أ1 الوارد');
  PERFORM t.ok(jsonb_array_length(r -> 'subscriptions') = 1 AND (r -> 'subscriptions' -> 0 ->> 'plan_key') = 'support', '8h: اشتراك أ1');
  PERFORM t.ok(t.call(v_owner_a, format('(select public.company_customer_history(%L::uuid))', v_cust_b1)) IS NULL, '8i: عميل ب لمالك أ → null');
  PERFORM t.ok(t.call(v_owner_b, format('(select public.company_customer_history(%L::uuid))', v_cust_a1)) IS NULL, '8j: عميل أ لمالك ب → null');
  PERFORM t.ok(t.call(v_owner_a, format('(select public.company_customer_history(%L::uuid))', v_agent_a)) IS NULL, '8k: موظف كـ«عميل» → null (ليس عميلًا)');
  -- المفتاح مطفأ: المشرف يرى، والموظف لا.
  PERFORM t.ok(t.call(v_sup_a, format('(select public.company_customer_history(%L::uuid))', v_cust_a1)) IS NOT NULL, '8l: مشرف أ يرى سجل أ1 (المفتاح مطفأ)');
  PERFORM t.ok(t.call(v_agent_a, format('(select public.company_customer_history(%L::uuid))', v_cust_a1)) IS NULL, '8m: موظف أ لا يرى (المفتاح مطفأ)');
  -- المفتاح مفعّل: customers.view للمدير/المشرف، لا للموظف.
  UPDATE public.platform_feature_switches SET enabled = true WHERE key = 'company_permissions_enabled';
  PERFORM t.ok(t.call(v_sup_a, format('(select public.company_customer_history(%L::uuid))', v_cust_a1)) IS NOT NULL, '8n: مشرف أ يرى (المفتاح مفعّل)');
  PERFORM t.ok(t.call(v_agent_a, format('(select public.company_customer_history(%L::uuid))', v_cust_a1)) IS NULL, '8o: موظف أ بلا customers.view → null');
  PERFORM t.ok(t.call(v_owner_a, format('(select public.company_customer_history(%L::uuid))', v_cust_a1)) IS NOT NULL, '8p: مالك أ يرى (المفتاح مفعّل)');
  UPDATE public.platform_feature_switches SET enabled = false WHERE key = 'company_permissions_enabled';
  RAISE NOTICE 'PASS 8: سجل العميل — الحزمة كاملة لعميل الشركة، وnull لغيره';
END $$;

-- ── ⑨ أداء الفريق ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v_owner_a constant uuid := '00000000-0000-4000-8000-0000000000a1';
  v_agent_a constant uuid := '00000000-0000-4000-8000-0000000000a3';
  v_cust_a1 constant uuid := '00000000-0000-4000-8000-0000000000a4';
  v_owner_b constant uuid := '00000000-0000-4000-8000-0000000000b1';
  r jsonb;
  m jsonb;
BEGIN
  r := t.call(v_owner_a, '(select public.company_team_performance())');
  -- القائمة من المالك + company_staff (3): لا profile واحد هنا برتبة
  -- admin/support، فلو كانت القائمة من profiles.role لكانت فارغة.
  PERFORM t.ok(jsonb_array_length(r -> 'members') = 3, '9a: ثلاثة أعضاء في أ ' || (r -> 'members')::text);
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'members') x WHERE (x ->> 'id') = '00000000-0000-4000-8000-0000000000c1'), '9b: الفرد ليس في القائمة');
  m := (SELECT x FROM jsonb_array_elements(r -> 'members') x WHERE x ->> 'id' = v_agent_a::text);
  PERFORM t.ok((m ->> 'role') = 'agent' AND (m ->> 'tickets_created')::int = 2 AND (m ->> 'tickets_resolved')::int = 1
               AND (m ->> 'replies_total')::int = 3 AND (m ->> 'replies_public')::int = 2 AND (m ->> 'replies_internal')::int = 1
               AND (m ->> 'avg_first_response_seconds')::int = 3600 AND (m ->> 'avg_resolution_seconds')::int = 172800,
               '9c: موظف أ ' || m::text);
  m := (SELECT x FROM jsonb_array_elements(r -> 'members') x WHERE x ->> 'role' = 'supervisor');
  PERFORM t.ok((m ->> 'tickets_created')::int = 1 AND (m ->> 'tickets_resolved')::int = 0 AND (m ->> 'replies_total')::int = 0
               AND (m ->> 'avg_first_response_seconds') IS NULL, '9d: مشرف أ ' || m::text);
  PERFORM t.ok((r -> 'totals' ->> 'tickets_created')::int = 3 AND (r -> 'totals' ->> 'tickets_resolved')::int = 1
               AND (r -> 'totals' ->> 'tickets_open_now')::int = 2
               AND (r -> 'totals' ->> 'avg_first_response_seconds')::int = 3600
               AND (r -> 'totals' ->> 'avg_resolution_seconds')::int = 172800, '9e: إجماليات أ ' || (r -> 'totals')::text);
  PERFORM t.ok((r -> 'totals' -> 'ratings' ->> 'count')::int = 1 AND (r -> 'totals' -> 'ratings' ->> 'avg')::numeric = 5.00, '9f: تقييم أ1 وحده (5)');
  PERFORM t.ok((r -> 'totals' -> 'chat' ->> 'sessions')::int = 1 AND (r -> 'totals' -> 'chat' ->> 'messages')::int = 3, '9g: شات أ1 (جلسة + 3 رسائل)');
  r := t.call(v_owner_b, '(select public.company_team_performance())');
  PERFORM t.ok(jsonb_array_length(r -> 'members') = 2, '9h: عضوان في ب');
  PERFORM t.ok((r -> 'totals' ->> 'tickets_created')::int = 1 AND (r -> 'totals' ->> 'tickets_open_now')::int = 1
               AND (r -> 'totals' -> 'ratings' ->> 'count')::int = 1 AND (r -> 'totals' -> 'ratings' ->> 'avg')::numeric = 2.00
               AND (r -> 'totals' -> 'chat' ->> 'sessions')::int = 1, '9i: إجماليات ب (بلا تسرب من أ)');
  PERFORM t.ok(t.call(v_agent_a, '(select public.company_team_performance())') IS NULL, '9j: موظف أ لا يرى الأداء');
  PERFORM t.ok(t.call(v_cust_a1, '(select public.company_team_performance())') IS NULL, '9k: عميل لا يرى الأداء');
  PERFORM t.ok(t.err(v_owner_a, '(select public.company_team_performance(''2026-01-10''::date, ''2026-01-01''::date))') = '22023', '9l: نافذة معكوسة');
  PERFORM t.ok(t.err(v_owner_a, '(select public.company_team_performance(''2025-01-01''::date, ''2026-06-01''::date))') = '22023', '9m: نافذة أطول من 366 يومًا');
  RAISE NOTICE 'PASS 9: أداء الفريق — القائمة من العضوية، والأرقام من تذاكر الشركة وحدها';
END $$;

-- ── ⑩ التراجع وإعادة التطبيق ───────────────────────────────────────────────
\i migrations/_rollback/146_company_five_sections.down.sql
DO $$
DECLARE
  v_owner_a constant uuid := '00000000-0000-4000-8000-0000000000a1';
BEGIN
  PERFORM t.ok(to_regprocedure('public.company_continuity_get(uuid)') IS NULL
               AND to_regprocedure('public.company_customer_history(uuid)') IS NULL
               AND to_regprocedure('public.company_team_performance(date,date)') IS NULL, '10a: الدوال زالت بالتراجع');
  PERFORM t.ok(t.err(v_owner_a, '(select 1 from public.company_continuity_my_access())') = '42883', '10b: النداء بعد التراجع 42883');
  PERFORM t.ok((SELECT count(*) FROM public.continuity_records) = 2
               AND (SELECT count(*) FROM public.continuity_workspaces WHERE kind = 'company') = 2,
               '10c: التراجع كود لا بيانات — السجلات والمساحات باقية');
  RAISE NOTICE 'PASS 10a: التراجع يحذف الدوال ويُبقي بيانات الشركتين';
END $$;
\i migrations/146_company_five_sections.sql
SET search_path = public, extensions;
DO $$
DECLARE
  v_owner_a constant uuid := '00000000-0000-4000-8000-0000000000a1';
  r jsonb;
BEGIN
  PERFORM t.ok(to_regprocedure('public.company_continuity_get(uuid)') IS NOT NULL
               AND to_regprocedure('public.company_customer_history(uuid)') IS NOT NULL
               AND to_regprocedure('public.company_team_performance(date,date)') IS NOT NULL, '10d: الدوال عادت');
  r := t.call(v_owner_a, '(select public.company_continuity_my_access())');
  PERFORM t.ok((r ->> 'enabled')::boolean = true, '10e: المساحة باقية مفعّلة بعد التراجع وإعادة التطبيق');
  r := t.call(v_owner_a, '(select public.company_continuity_list())');
  PERFORM t.ok(jsonb_array_length(r) = 1, '10f: سجل أ ما زال يُقرأ');
  RAISE NOTICE 'PASS 10b: إعادة التطبيق بعد التراجع تنجح والبيانات سليمة';
END $$;

\echo 'ALL company-five-sections tests passed'
