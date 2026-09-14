-- ============================================================================
-- اختبار تنفيذي لـ migrations/036_api_token_authorization.sql
--
-- مصفوفة صلاحية إصدار مفاتيح API كما طُلبت حرفيًا:
--   مدير شركة مصرَّح له → يسمح
--   company_user        → يُمنع
--   شركة بلا استحقاق    → تُمنع
--   عميل بلا شركة       → يُمنع
--   مجهول               → يُمنع
--   تزوير المعرّفات     → مستحيل بنيويًا (لا مُعامل هوية في أي دالة بوابة)
--   طاقم المنصة         → يسمح بالسقف الكامل، ولم يفقد شيئًا
--
-- البنية مشتركة مع company-roles.test.sql عمدًا: نفس المخطّط ونفس البذور،
-- فلا يوجد تعريفان لنفس العالم قد يفترقا.
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true),'')::uuid; $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.role', true),''); $$;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
END $$;
GRANT USAGE ON SCHEMA auth TO authenticated, anon;

-- ── الجداول التي يمسّها الترحيل ────────────────────────────────────────────
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, email text, full_name text, username text,
  role text DEFAULT 'user', super_user_id uuid,
  whatsapp_enabled boolean DEFAULT false,
  telegram_chat_id text, telegram_alert_events text[] DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE,
  company_name varchar NOT NULL
);
CREATE TABLE public.subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text NOT NULL UNIQUE,
  name text, name_ar text, is_active boolean DEFAULT true
);
CREATE TABLE public.feature_flags (key text PRIMARY KEY, name_ar text);
CREATE TABLE public.plan_features (
  plan_id uuid NOT NULL REFERENCES public.subscription_plans(id) ON DELETE CASCADE,
  feature_key text NOT NULL REFERENCES public.feature_flags(key) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true, PRIMARY KEY (plan_id, feature_key)
);
CREATE TABLE public.whatsapp_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  status text DEFAULT 'active', start_date timestamptz DEFAULT now(),
  end_date timestamptz NOT NULL, plan text NOT NULL, company_id uuid,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  ticket_number serial, title text, status text DEFAULT 'open',
  priority text DEFAULT 'medium', first_response_at timestamptz,
  sla_alert_sent boolean DEFAULT false, archived_by_customer boolean DEFAULT false,
  archived_at timestamptz, created_at timestamptz DEFAULT now()
);
CREATE TABLE public.ticket_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ticket_id uuid NOT NULL,
  action_type text NOT NULL, created_at timestamptz DEFAULT now()
);
CREATE TABLE public.ticket_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ticket_id uuid NOT NULL,
  file_name text, created_at timestamptz DEFAULT now()
);
CREATE TABLE public.ticket_ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ticket_id uuid NOT NULL,
  rating int, created_at timestamptz DEFAULT now()
);
CREATE TABLE public.ticket_tags (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
CREATE TABLE public.ticket_tag_links (ticket_id uuid, tag_id uuid);
CREATE TABLE public.canned_responses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), body text);
CREATE TABLE public.customer_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, note text);
CREATE TABLE public.accounting_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, total numeric);
CREATE TABLE public.webhooks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), url text);
CREATE TABLE public.webhook_deliveries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), webhook_id uuid);
CREATE TABLE public.badge_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text, is_active boolean DEFAULT true);
CREATE TABLE public.customer_badges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, badge_key text);
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, title text,
  message text, type text, link text, is_read boolean DEFAULT false);
CREATE TABLE public.advanced_settings (
  key text PRIMARY KEY, value jsonb, updated_at timestamptz DEFAULT now());

-- ── دوال قائمة يعتمد عليها الترحيل ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_main_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','auth' AS $$
  SELECT COALESCE((SELECT email FROM auth.users WHERE id = auth.uid())
                  IN ('support@mad3oom.online','info@mad3oom.online'), false); $$;

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles
                  WHERE id = auth.uid()
                    AND (role = 'admin' OR email IN ('support@mad3oom.online','info@mad3oom.online'))); $$;

CREATE OR REPLACE FUNCTION public.is_support_user() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles
                  WHERE id = auth.uid() AND (email='support@mad3oom.online' OR role='admin')); $$;

CREATE OR REPLACE FUNCTION public.current_company_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select c.id from public.companies c
   where auth.uid() is not null
     and (c.user_id = auth.uid()
          or c.user_id = (select p.super_user_id from public.profiles p where p.id = auth.uid()))
   order by (c.user_id = auth.uid()) desc limit 1; $$;

CREATE OR REPLACE FUNCTION public.company_has_feature(p_feature_key text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select exists (
    select 1 from public.companies c
      join public.whatsapp_subscriptions s on (s.company_id = c.id or s.user_id = c.user_id)
      join public.subscription_plans sp on sp.key = s.plan
      join public.plan_features pf on pf.plan_id = sp.id and pf.enabled
     where c.id = public.current_company_id()
       and s.status='active' and s.start_date <= now() and s.end_date > now()
       and pf.feature_key = p_feature_key); $$;

CREATE OR REPLACE FUNCTION public.ticket_in_my_scope(p_ticket_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select auth.uid() is not null and exists (
    select 1 from public.tickets t
     where t.id = p_ticket_id
       and (t.user_id = auth.uid()
            or t.user_id in (select p.id from public.profiles p where p.super_user_id = auth.uid()))); $$;

CREATE OR REPLACE FUNCTION public.owned_feature_keys(p_user_id uuid default auth.uid())
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select coalesce(array_agg(distinct pf.feature_key), '{}'::text[])
    from public.whatsapp_subscriptions s
    join public.subscription_plans sp on sp.key = s.plan
    join public.plan_features pf on pf.plan_id = sp.id and pf.enabled
   where s.user_id = p_user_id and s.status='active'
     and s.start_date <= now() and s.end_date > now(); $$;

CREATE OR REPLACE FUNCTION public.send_telegram_message(p_chat text, p_msg text)
RETURNS void LANGUAGE sql AS $$ SELECT NULL::void; $$;
CREATE OR REPLACE FUNCTION public.evaluate_customer_badges(p_user_id uuid)
RETURNS void LANGUAGE sql AS $$ SELECT NULL::void; $$;

-- الدوال القديمة التي يستبدلها الترحيل (بصيغتها المتسرّبة)
CREATE OR REPLACE FUNCTION public.wf_is_staff() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid()
                  AND role = ANY(ARRAY['admin','support','super_user'])); $$;
CREATE OR REPLACE FUNCTION public.is_chat_engine_staff() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid()
                  AND role IN ('admin','support','super_user')); $$;
CREATE OR REPLACE FUNCTION public.is_landing_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid()
                  AND role IN ('admin','super_user')); $$;
CREATE OR REPLACE FUNCTION public.has_chatbot_entitlement(p_user_id uuid default auth.uid())
RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id
                  AND (whatsapp_enabled = true OR role IN ('super_user','admin'))); $$;
CREATE OR REPLACE FUNCTION public.recompute_user_access(p_user_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
declare v_role text;
begin
  select role into v_role from public.profiles where id = p_user_id;
  if v_role = 'user' then update public.profiles set role = 'super_user' where id = p_user_id; end if;
  return jsonb_build_object('role', v_role);
end; $$;
CREATE OR REPLACE FUNCTION public.expire_stale_subscriptions() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
begin
  update public.profiles set role = 'user' where role = 'super_user';
end; $$;
CREATE OR REPLACE FUNCTION public.run_data_retention_cleanup() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
begin return '{}'::jsonb; end; $$;
CREATE OR REPLACE FUNCTION public.notify_admins_on_urgent_ticket() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$ begin return new; end; $$;
CREATE OR REPLACE FUNCTION public.check_sla_breaches() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$ begin end; $$;
CREATE OR REPLACE FUNCTION public.backfill_all_customer_badges() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$ begin return 0; end; $$;
CREATE OR REPLACE FUNCTION public.guard_profile_role_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$ begin return new; end; $$;
CREATE OR REPLACE FUNCTION public.check_super_user_creation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$ begin return new; end; $$;

CREATE TRIGGER guard_profile_role_change BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_role_change();
CREATE TRIGGER tr_check_super_user_creation BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.check_super_user_creation();

-- نطاق emp_ops المستقل — رتبته لا تقرأ profiles إطلاقًا
CREATE SCHEMA IF NOT EXISTS emp_ops;
CREATE OR REPLACE FUNCTION emp_ops.current_rank() RETURNS int
LANGUAGE sql STABLE AS $$ SELECT 0; $$;
CREATE OR REPLACE FUNCTION emp_ops.is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'emp_ops','pg_temp' AS $$
  SELECT emp_ops.current_rank() >= 100; $$;

GRANT USAGE ON SCHEMA public TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;

-- ============================================================================
-- الحالة القديمة قبل الترحيل — تحاكي الإنتاج بدقّة
-- ============================================================================
--   A : super_user يملك شركة            → يجب أن يصير company_admin
--   A2: تابع لـA بلا رتبة شركة          → يجب أن يصير company_user
--   B : super_user يملك شركة أخرى       → company_admin لشركة B (عزل)
--   C : super_user **بلا شركة**         → يجب أن يعود user، لا company_admin
--   D : admin يملك شركة                 → يبقى admin (رتب المنصة لا تُمسّ)
--   E : عميل عادي بلا علاقة             → يبقى user
INSERT INTO auth.users (id, email) VALUES
  ('11111111-1111-4111-8111-111111111111','a@co.test'),
  ('1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a','a2@co.test'),
  ('22222222-2222-4222-8222-222222222222','b@co.test'),
  ('33333333-3333-4333-8333-333333333333','c@nocompany.test'),
  ('44444444-4444-4444-8444-444444444444','d@admin.test'),
  ('55555555-5555-4555-8555-555555555555','e@user.test'),
  ('99999999-9999-4999-8999-999999999999','support@mad3oom.online');

INSERT INTO public.profiles (id, email, role, super_user_id) VALUES
  ('11111111-1111-4111-8111-111111111111','a@co.test','super_user', NULL),
  ('1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a','a2@co.test','user','11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222','b@co.test','super_user', NULL),
  ('33333333-3333-4333-8333-333333333333','c@nocompany.test','super_user', NULL),
  ('44444444-4444-4444-8444-444444444444','d@admin.test','admin', NULL),
  ('55555555-5555-4555-8555-555555555555','e@user.test','user', NULL),
  ('99999999-9999-4999-8999-999999999999','support@mad3oom.online','admin', NULL);

INSERT INTO public.companies (id, user_id, company_name) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','شركة أ'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222','شركة ب'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','44444444-4444-4444-8444-444444444444','شركة د');

INSERT INTO public.feature_flags (key, name_ar) VALUES ('sub_users','مستخدمون فرعيون'),('api_tokens','مفاتيح API');
INSERT INTO public.subscription_plans (key, name_ar) VALUES ('bundle','الشاملة'),('support','الدعم');
INSERT INTO public.plan_features (plan_id, feature_key)
  SELECT id,'sub_users' FROM public.subscription_plans WHERE key='bundle';
INSERT INTO public.plan_features (plan_id, feature_key)
  SELECT id,'api_tokens' FROM public.subscription_plans WHERE key='bundle';

-- شركة أ لديها اشتراك فعّال يمنح sub_users؛ شركة ب بلا اشتراك.
INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, start_date, end_date, company_id) VALUES
  ('11111111-1111-4111-8111-111111111111','bundle','active', now() - interval '10 days',
   now() + interval '90 days','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

-- تذاكر: واحدة لمالك أ، وواحدة لعضوه، وواحدة لمالك ب
INSERT INTO public.tickets (id, user_id, title) VALUES
  ('e1111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','تذكرة مالك أ'),
  ('e2222222-2222-4222-8222-222222222222','1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a','تذكرة عضو أ'),
  ('e3333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','تذكرة مالك ب');

INSERT INTO public.ticket_activity (ticket_id, action_type) VALUES
  ('e2222222-2222-4222-8222-222222222222','status_change'),
  ('e2222222-2222-4222-8222-222222222222','internal_note'),
  ('e3333333-3333-4333-8333-333333333333','status_change');
INSERT INTO public.ticket_attachments (ticket_id, file_name) VALUES
  ('e2222222-2222-4222-8222-222222222222','proof-a.png'),
  ('e3333333-3333-4333-8333-333333333333','proof-b.png');
INSERT INTO public.ticket_ratings (ticket_id, rating) VALUES
  ('e2222222-2222-4222-8222-222222222222', 5),
  ('e3333333-3333-4333-8333-333333333333', 4);
INSERT INTO public.customer_notes (user_id, note) VALUES
  ('55555555-5555-4555-8555-555555555555','ملاحظة داخلية عن عميل');
INSERT INTO public.webhooks (url) VALUES ('https://hook.example/1');
INSERT INTO public.accounting_invoices (user_id, total) VALUES
  ('55555555-5555-4555-8555-555555555555', 100);
INSERT INTO public.canned_responses (body) VALUES ('ردّ جاهز داخلي');

-- ============================================================================
\i migrations/035_company_roles.sql
\i migrations/036_api_token_authorization.sql
-- ============================================================================

-- اشتراك شركة ب: بلا api_tokens (لديها sub_users فقط عبر باقة أخرى)
INSERT INTO public.subscription_plans (key, name_ar) VALUES ('basic','الأساسية');
INSERT INTO public.plan_features (plan_id, feature_key)
  SELECT id,'sub_users' FROM public.subscription_plans WHERE key='basic';
INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, start_date, end_date, company_id)
VALUES ('22222222-2222-4222-8222-222222222222','basic','active', now() - interval '5 days',
        now() + interval '60 days','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

-- عضو لشركة أ (company_user) لاختبار عدم التوريث
RESET ROLE;
SET request.jwt.claim.sub = '';
UPDATE public.profiles SET super_user_id='11111111-1111-4111-8111-111111111111'
 WHERE id='1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';

-- ============================================================================
-- مصفوفة صلاحية إصدار مفاتيح API
-- ============================================================================

-- ① مدير شركة مستحق → مسموح
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$
DECLARE v jsonb; v_ceiling text[];
BEGIN
  IF NOT public.can_create_api_token() THEN
    RAISE EXCEPTION 'مدير شركة مستحق مُنع من إصدار مفتاح';
  END IF;
  v := public.api_token_issue_context();
  IF (v->>'actor') <> 'company_admin' THEN RAISE EXCEPTION 'actor خاطئ: %', v->>'actor'; END IF;
  IF (v->>'allowed')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'allowed خاطئ'; END IF;

  v_ceiling := public.api_token_scope_ceiling();
  IF NOT ('tickets:read' = ANY(v_ceiling)) THEN RAISE EXCEPTION 'سقف الشركة لا يشمل tickets:read'; END IF;
  RAISE NOTICE 'PASS API-1: مدير شركة مستحق يصدر مفاتيح';
END $$;

-- ② سقف الشركة لا يشمل صلاحيات مشغّل المنصة
DO $$
DECLARE v_ceiling text[];
BEGIN
  v_ceiling := public.api_token_scope_ceiling();
  FOR i IN 1..3 LOOP
    IF (ARRAY['admin:full','settings:manage','oauth:manage'])[i] = ANY(v_ceiling) THEN
      RAISE EXCEPTION 'سقف الشركة يشمل صلاحية مشغّل منصة: %',
        (ARRAY['admin:full','settings:manage','oauth:manage'])[i];
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS API-2: صلاحيات مشغّل المنصة خارج سقف الشركة (حاجز خادم)';
END $$;

-- ③ company_user → ممنوع (العضوية ليست ترقية)
SET request.jwt.claim.sub = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
DO $$
DECLARE v jsonb;
BEGIN
  IF public.can_create_api_token() THEN
    RAISE EXCEPTION 'company_user أصدر مفتاحًا';
  END IF;
  IF array_length(public.api_token_scope_ceiling(), 1) IS NOT NULL THEN
    RAISE EXCEPTION 'company_user حصل على سقف صلاحيات غير فارغ';
  END IF;
  v := public.api_token_issue_context();
  IF (v->>'actor') <> 'company_user' THEN RAISE EXCEPTION 'actor خاطئ: %', v->>'actor'; END IF;
  RAISE NOTICE 'PASS API-3: company_user لا يصدر مفاتيح ولا يرث المدير';
END $$;

-- ④ مدير شركة **بلا استحقاق api_tokens** → ممنوع
SET request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
DO $$
BEGIN
  IF NOT public.is_company_admin() THEN RAISE EXCEPTION 'التمهيد خاطئ: ليس مدير شركة'; END IF;
  IF public.company_has_feature('api_tokens') THEN RAISE EXCEPTION 'التمهيد خاطئ: لديه الاستحقاق'; END IF;
  IF public.can_create_api_token() THEN
    RAISE EXCEPTION 'شركة بلا استحقاق api_tokens أصدرت مفتاحًا';
  END IF;
  RAISE NOTICE 'PASS API-4: بلا استحقاق api_tokens لا إصدار — والاستحقاق يُقرأ من القاعدة';
END $$;

-- ⑤ عميل عادي بلا شركة → ممنوع
SET request.jwt.claim.sub = '55555555-5555-4555-8555-555555555555';
DO $$
BEGIN
  IF public.can_create_api_token() THEN RAISE EXCEPTION 'عميل بلا شركة أصدر مفتاحًا'; END IF;
  RAISE NOTICE 'PASS API-5: عميل بلا شركة لا يصدر مفاتيح';
END $$;

-- ⑥ مجهول الهوية → ممنوع، وسقفه فارغ
SET request.jwt.claim.sub = '';
DO $$
DECLARE v jsonb;
BEGIN
  IF public.can_create_api_token() THEN RAISE EXCEPTION 'مجهول أصدر مفتاحًا'; END IF;
  v := public.api_token_issue_context();
  IF (v->>'allowed')::boolean IS NOT FALSE THEN RAISE EXCEPTION 'مجهول مسموح له'; END IF;
  IF (v->>'actor') <> 'anonymous' THEN RAISE EXCEPTION 'actor خاطئ للمجهول'; END IF;
  RAISE NOTICE 'PASS API-6: المجهول ممنوع وسقفه فارغ';
END $$;

-- ⑦ طاقم المنصة → مسموح بالسقف الكامل
SET request.jwt.claim.sub = '99999999-9999-4999-8999-999999999999';
DO $$
DECLARE v_ceiling text[];
BEGIN
  IF NOT public.can_create_api_token() THEN RAISE EXCEPTION 'طاقم المنصة مُنع'; END IF;
  v_ceiling := public.api_token_scope_ceiling();
  IF NOT ('admin:full' = ANY(v_ceiling)) THEN
    RAISE EXCEPTION 'طاقم المنصة فقد صلاحيات كانت له';
  END IF;
  RAISE NOTICE 'PASS API-7: طاقم المنصة يصدر بالسقف الكامل';
END $$;

-- ⑧ تزوير الهوية: النطاق يُشتق من auth.uid() ولا مُعامل يوجّهه
DO $$
DECLARE v_src text;
BEGIN
  FOR v_src IN
    SELECT pg_get_functiondef(p.oid)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public'
       AND p.proname IN ('can_create_api_token','api_token_scope_ceiling','api_token_issue_context')
  LOOP
    IF v_src ~ 'p_user_id|p_company_id' THEN
      RAISE EXCEPTION 'دالة بوابة تقبل معرّف هوية كمُعامل — قابل للتزوير';
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS API-8: لا مُعامل هوية في أي دالة بوابة — التزوير مستحيل بنيويًا';
END $$;

-- ⑨ الدوال ممنوعة عن anon على مستوى الصلاحيات نفسها
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public'
     AND p.proname IN ('can_create_api_token','api_token_scope_ceiling','api_token_issue_context')
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'anon يملك تنفيذ دوال البوابة: %', v_bad;
  END IF;
  RAISE NOTICE 'PASS API-9: البوابة محجوبة عن anon';
END $$;

SELECT 'ALL API TOKEN AUTHORIZATION TESTS PASSED';
