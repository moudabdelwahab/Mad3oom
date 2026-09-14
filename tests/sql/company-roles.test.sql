-- ============================================================================
-- اختبار تنفيذي لـ migrations/035_company_roles.sql
--
-- يثبّت الفصل الصارم بين ثلاثة نطاقات سلطة:
--   Platform Staff  platform_owner · admin · support
--   Company Roles   company_admin · company_user
--   Employee Ops    emp_ops (نطاق مستقل)
--
-- وكل تأكيد هنا يفشل إن عاد أي تسريب بين النطاقات.
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
-- إثبات التسرّب **قبل** الإصلاح — وإلا لا معنى للإصلاح
-- ============================================================================
RESET ROLE;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$
BEGIN
  IF NOT public.wf_is_staff() THEN RAISE EXCEPTION 'التمهيد خاطئ: التسرّب غير قائم'; END IF;
  IF NOT public.is_chat_engine_staff() THEN RAISE EXCEPTION 'التمهيد خاطئ'; END IF;
  IF NOT public.is_landing_admin() THEN RAISE EXCEPTION 'التمهيد خاطئ'; END IF;
  RAISE NOTICE 'PASS 0: قبل الإصلاح — مالك الشركة كان طاقم منصة في 3 دوال';
END $$;

-- ============================================================================
\i migrations/035_company_roles.sql
-- ============================================================================

-- ============================================================================
-- ١) نقل البيانات — من العلاقة لا من الاسم
-- ============================================================================
DO $$
DECLARE v text;
BEGIN
  SELECT role INTO v FROM public.profiles WHERE id='11111111-1111-4111-8111-111111111111';
  IF v <> 'company_admin' THEN RAISE EXCEPTION 'مالك شركة أ صار % بدل company_admin', v; END IF;

  SELECT role INTO v FROM public.profiles WHERE id='1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
  IF v <> 'company_user' THEN RAISE EXCEPTION 'عضو شركة أ صار % بدل company_user', v; END IF;

  -- الأهم: من حمل الرتبة القديمة بلا شركة **لا** يصير مدير شركة
  SELECT role INTO v FROM public.profiles WHERE id='33333333-3333-4333-8333-333333333333';
  IF v <> 'user' THEN
    RAISE EXCEPTION 'حساب بلا شركة صار % — الترحيل اشتقّ الدور من الاسم لا من العلاقة', v;
  END IF;

  -- رتب المنصة لا تُمسّ ولو ملك صاحبها شركة
  SELECT role INTO v FROM public.profiles WHERE id='44444444-4444-4444-8444-444444444444';
  IF v <> 'admin' THEN RAISE EXCEPTION 'رتبة أدمن تغيّرت إلى %', v; END IF;

  SELECT role INTO v FROM public.profiles WHERE id='55555555-5555-4555-8555-555555555555';
  IF v <> 'user' THEN RAISE EXCEPTION 'عميل عادي تغيّر إلى %', v; END IF;

  IF EXISTS (SELECT 1 FROM public.profiles WHERE role='super_user') THEN
    RAISE EXCEPTION 'بقيت حسابات على الرتبة المتقاعدة';
  END IF;
  RAISE NOTICE 'PASS 1: الأدوار اشتُقّت من العلاقة، والرتبة المتقاعدة زالت';
END $$;

-- ============================================================================
-- ٢) الفصل الصارم — company_admin ليس طاقم منصة
-- ============================================================================
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$
BEGIN
  IF public.is_platform_staff() THEN RAISE EXCEPTION 'company_admin صار طاقم منصة'; END IF;
  IF public.is_admin()          THEN RAISE EXCEPTION 'company_admin صار admin'; END IF;
  IF public.is_support_user()   THEN RAISE EXCEPTION 'company_admin صار support'; END IF;
  IF public.wf_is_staff()       THEN RAISE EXCEPTION 'company_admin صار طاقم سير العمل'; END IF;
  IF public.is_chat_engine_staff() THEN RAISE EXCEPTION 'company_admin صار طاقم المحادثة'; END IF;
  IF public.is_landing_admin()  THEN RAISE EXCEPTION 'company_admin صار أدمن الهبوط'; END IF;
  IF emp_ops.is_admin()         THEN RAISE EXCEPTION 'company_admin حصل على سلطة emp_ops'; END IF;

  -- وما يملكه فعلًا
  IF NOT public.is_company_admin() THEN RAISE EXCEPTION 'company_admin لا يُعرَف كمدير شركة'; END IF;
  IF public.is_company_member()    THEN RAISE EXCEPTION 'المدير صُنّف عضوًا أيضًا'; END IF;
  IF public.company_role() <> 'company_admin' THEN RAISE EXCEPTION 'company_role خاطئ'; END IF;
  RAISE NOTICE 'PASS 2: company_admin ليس admin ولا support ولا emp_ops';
END $$;

-- ============================================================================
-- ٣) company_user لا يرث company_admin
-- ============================================================================
SET request.jwt.claim.sub = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
DO $$
BEGIN
  IF public.is_platform_staff()  THEN RAISE EXCEPTION 'company_user صار طاقم منصة'; END IF;
  IF public.is_admin()           THEN RAISE EXCEPTION 'company_user صار admin'; END IF;
  IF public.is_support_user()    THEN RAISE EXCEPTION 'company_user صار support'; END IF;
  IF emp_ops.is_admin()          THEN RAISE EXCEPTION 'company_user حصل على سلطة emp_ops'; END IF;

  -- العضوية في نفس الشركة ليست ترقية
  IF public.is_company_admin()   THEN RAISE EXCEPTION 'company_user ورث صلاحيات المدير'; END IF;
  IF public.can_manage_company_members() THEN RAISE EXCEPTION 'company_user يدير الأعضاء'; END IF;
  IF NOT public.is_company_member() THEN RAISE EXCEPTION 'company_user لا يُعرَف كعضو'; END IF;
  RAISE NOTICE 'PASS 3: company_user لا يرث company_admin ولا أي سلطة منصة';
END $$;

-- ============================================================================
-- ٤) الرتبة وحدها لا تكفي، والعلاقة وحدها لا تكفي
-- ============================================================================
-- نزوّر الرتبة على حساب بلا شركة ونتأكد أنها لا تفتح شيئًا.
RESET ROLE;
SET request.jwt.claim.sub = '';
UPDATE public.profiles SET role='user' WHERE id='33333333-3333-4333-8333-333333333333';
-- الكتابة المباشرة تمرّ هنا فقط لأن auth.uid() فارغ (سياق خدمة). محفّز
-- sync_company_role سيصحّحها فورًا — وهذا بالضبط ما نثبته.
UPDATE public.profiles SET role='company_admin' WHERE id='33333333-3333-4333-8333-333333333333';
DO $$
DECLARE v text;
BEGIN
  SELECT role INTO v FROM public.profiles WHERE id='33333333-3333-4333-8333-333333333333';
  IF v = 'company_admin' THEN
    RAISE EXCEPTION 'أمكن تثبيت دور شركة على حساب بلا شركة — الدور ليس مشتقًّا';
  END IF;
  RAISE NOTICE 'PASS 4: الدور مشتقّ من العلاقة — لا يثبت بلا شركة (صار %)', v;
END $$;

-- ============================================================================
-- ٥) عزل المستأجرين — شركة أ لا ترى شركة ب
-- ============================================================================
RESET ROLE;
ALTER TABLE public.ticket_activity     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_attachments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_ratings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_notes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhooks            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canned_responses    ENABLE ROW LEVEL SECURITY;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$
DECLARE n int;
BEGIN
  -- نشاط تذاكر نطاقه: تذكرته وتذكرة عضوه، وبلا الملاحظات الداخلية
  SELECT count(*) INTO n FROM public.ticket_activity;
  IF n <> 1 THEN RAISE EXCEPTION 'نشاط التذاكر المرئي = % (المتوقع 1: نشاط تذكرة عضوه بلا internal_note)', n; END IF;

  SELECT count(*) INTO n FROM public.ticket_attachments;
  IF n <> 1 THEN RAISE EXCEPTION 'المرفقات المرئية = % (المتوقع 1: مرفق عضوه فقط)', n; END IF;

  SELECT count(*) INTO n FROM public.ticket_ratings;
  IF n <> 1 THEN RAISE EXCEPTION 'التقييمات المرئية = % (المتوقع 1)', n; END IF;

  -- ولا شيء من نطاق شركة ب
  IF EXISTS (SELECT 1 FROM public.ticket_attachments WHERE file_name='proof-b.png') THEN
    RAISE EXCEPTION 'شركة أ ترى مرفقات شركة ب';
  END IF;
  RAISE NOTICE 'PASS 5: نطاق الشركة صريح — تذاكرها وتذاكر أعضائها وحدها';
END $$;

-- ============================================================================
-- ٦) صلاحيات المنصة منزوعة فعليًا عن company_admin
-- ============================================================================
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.customer_notes;
  IF n <> 0 THEN RAISE EXCEPTION 'company_admin يقرأ ملاحظات المنصة الداخلية (% صفًّا)', n; END IF;

  SELECT count(*) INTO n FROM public.webhooks;
  IF n <> 0 THEN RAISE EXCEPTION 'company_admin يرى ويبهوكس المنصة (% صفًّا)', n; END IF;

  SELECT count(*) INTO n FROM public.canned_responses;
  IF n <> 0 THEN RAISE EXCEPTION 'company_admin يقرأ الردود الجاهزة الداخلية (% صفًّا)', n; END IF;

  -- فواتيره هو مرئية، وفواتير غيره لا
  SELECT count(*) INTO n FROM public.accounting_invoices;
  IF n <> 0 THEN RAISE EXCEPTION 'company_admin يرى فواتير عملاء المنصة (% صفًّا)', n; END IF;
  RAISE NOTICE 'PASS 6: أسطح المنصة الداخلية مغلقة أمام company_admin';
END $$;

-- كتابة في أسطح المنصة مرفوضة
DO $$
BEGIN
  BEGIN
    INSERT INTO public.customer_notes (user_id, note) VALUES
      ('55555555-5555-4555-8555-555555555555','محاولة كتابة');
    RAISE EXCEPTION 'company_admin كتب ملاحظة داخلية عن عميل';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.webhooks (url) VALUES ('https://evil.example');
    RAISE EXCEPTION 'company_admin أنشأ ويبهوك على المنصة';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS 7: الكتابة في أسطح المنصة مرفوضة';
END $$;

-- ============================================================================
-- ٧) طاقم المنصة لم يفقد شيئًا
-- ============================================================================
SET request.jwt.claim.sub = '99999999-9999-4999-8999-999999999999';
DO $$
DECLARE n int;
BEGIN
  IF NOT public.is_platform_staff() THEN RAISE EXCEPTION 'الأدمن فقد صفة الطاقم'; END IF;
  SELECT count(*) INTO n FROM public.customer_notes;
  IF n < 1 THEN RAISE EXCEPTION 'الأدمن فقد قراءة ملاحظات العملاء'; END IF;
  SELECT count(*) INTO n FROM public.ticket_attachments;
  IF n < 2 THEN RAISE EXCEPTION 'الأدمن فقد قراءة المرفقات (% صفًّا)', n; END IF;
  RAISE NOTICE 'PASS 8: طاقم المنصة احتفظ بصلاحياته كاملة';
END $$;

-- ============================================================================
-- ٨) الحرّاس — لا ترقية ذاتية ولا تبديل شركة
-- ============================================================================
SET request.jwt.claim.sub = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
DO $$
BEGIN
  BEGIN
    UPDATE public.profiles SET role='company_admin'
     WHERE id='1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
    RAISE EXCEPTION 'company_user رقّى نفسه إلى company_admin';
  EXCEPTION WHEN sqlstate '42501' OR insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE public.profiles SET role='admin'
     WHERE id='1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
    RAISE EXCEPTION 'company_user رقّى نفسه إلى admin';
  EXCEPTION WHEN sqlstate '42501' OR insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE public.profiles SET super_user_id='22222222-2222-4222-8222-222222222222'
     WHERE id='1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
    RAISE EXCEPTION 'company_user نقل نفسه إلى شركة أخرى';
  EXCEPTION WHEN sqlstate '42501' OR insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS 9: لا ترقية ذاتية ولا انتقال بين الشركات';
END $$;

-- مدير الشركة لا يرقّي عضوه أيضًا
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$
BEGIN
  BEGIN
    UPDATE public.profiles SET role='admin'
     WHERE id='1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
    RAISE EXCEPTION 'company_admin رقّى عضوه إلى admin';
  EXCEPTION WHEN sqlstate '42501' OR insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS 10: مدير الشركة لا يرقّي عضوه (ثغرة C2 مغلقة)';
END $$;

-- ============================================================================
-- ٩) إزالة عضو: قطع علاقة لا حذف، ومحصورة بالشركة
-- ============================================================================
RESET ROLE;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$
DECLARE v text;
BEGIN
  -- عضو شركة أخرى: يُرفض مهما كان المعرّف المرسل
  BEGIN
    PERFORM public.remove_company_member('22222222-2222-4222-8222-222222222222');
    RAISE EXCEPTION 'أمكن إزالة حساب من شركة أخرى';
  EXCEPTION WHEN sqlstate '42501' THEN NULL;
  END;

  PERFORM public.remove_company_member('1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a');

  -- الحساب باقٍ، والعلاقة انقطعت، والدور سقط معها
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id='1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a') THEN
    RAISE EXCEPTION 'الإزالة حذفت الحساب بدل قطع العلاقة';
  END IF;
  SELECT role INTO v FROM public.profiles WHERE id='1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
  IF v = 'company_user' THEN RAISE EXCEPTION 'بقي دور company_user بلا شركة'; END IF;
  RAISE NOTICE 'PASS 11: الإزالة تقطع العلاقة ويسقط الدور معها (صار %)', v;
END $$;

-- ============================================================================
-- ١٠) الاشتراك لم يعد يكتب الرتبة
-- ============================================================================
RESET ROLE;
SET request.jwt.claim.sub = '';
DO $$
DECLARE v_before text; v_after text;
BEGIN
  SELECT role INTO v_before FROM public.profiles WHERE id='11111111-1111-4111-8111-111111111111';
  PERFORM public.recompute_user_access('11111111-1111-4111-8111-111111111111');
  PERFORM public.expire_stale_subscriptions();
  SELECT role INTO v_after FROM public.profiles WHERE id='11111111-1111-4111-8111-111111111111';

  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'دورة الاشتراك غيّرت الرتبة من % إلى % — الترحيل سيُنقَض', v_before, v_after;
  END IF;
  IF v_after <> 'company_admin' THEN
    RAISE EXCEPTION 'مدير الشركة فقد دوره بانتهاء الاشتراك (صار %)', v_after;
  END IF;
  RAISE NOTICE 'PASS 12: الرتبة مفصولة عن الاشتراك — لا ترقية ولا تنزيل';
END $$;

-- ============================================================================
-- ١١) إنشاء شركة جديدة يصنع company_admin تلقائيًا
-- ============================================================================
DO $$
DECLARE v text;
BEGIN
  INSERT INTO public.companies (user_id, company_name)
  VALUES ('55555555-5555-4555-8555-555555555555','شركة هـ');
  SELECT role INTO v FROM public.profiles WHERE id='55555555-5555-4555-8555-555555555555';
  IF v <> 'company_admin' THEN
    RAISE EXCEPTION 'إنشاء شركة لم يصنع company_admin (الدور %)', v;
  END IF;

  -- وضمّ عضو يصنع company_user
  UPDATE public.profiles SET super_user_id='55555555-5555-4555-8555-555555555555'
   WHERE id='33333333-3333-4333-8333-333333333333';
  SELECT role INTO v FROM public.profiles WHERE id='33333333-3333-4333-8333-333333333333';
  IF v <> 'company_user' THEN
    RAISE EXCEPTION 'ضمّ عضو لم يصنع company_user (الدور %)', v;
  END IF;
  RAISE NOTICE 'PASS 13: الدور يتبع العلاقة إنشاءً وضمًّا';
END $$;

-- ============================================================================
-- ١٢) is_platform_staff لا تُوسَّع لتشمل أدوار الشركة — ضمانة دائمة
-- ============================================================================
DO $$
BEGIN
  IF pg_get_functiondef('public.is_platform_staff()'::regprocedure) ~ 'company_(admin|user)' THEN
    RAISE EXCEPTION 'is_platform_staff تشمل دور شركة — الفصل الأمني مكسور';
  END IF;
  IF pg_get_functiondef('public.is_company_admin()'::regprocedure) !~ 'owns_a_company' THEN
    RAISE EXCEPTION 'is_company_admin لا تشترط العلاقة — الرتبة صارت مصدر الثقة الوحيد';
  END IF;
  IF pg_get_functiondef('public.is_company_member()'::regprocedure) !~ 'belongs_to_a_company' THEN
    RAISE EXCEPTION 'is_company_member لا تشترط العلاقة';
  END IF;
  RAISE NOTICE 'PASS 14: الفصل الصارم مثبَّت في تعريف الدوال نفسها';
END $$;

SELECT 'ALL COMPANY ROLE TESTS PASSED';
