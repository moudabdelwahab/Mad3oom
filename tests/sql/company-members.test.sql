-- اختبار تنفيذي لـ migrations/020_company_members.sql
-- يثبّت العزل بين الشركات وربط الإدارة بامتياز فعلي لا باسم باقة.
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true),'')::uuid; $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
END $$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, email text, full_name text, username text,
  role text NOT NULL DEFAULT 'user', super_user_id uuid,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE,
  company_name varchar NOT NULL, commercial_registration_number varchar NOT NULL UNIQUE
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
  end_date timestamptz NOT NULL, plan text NOT NULL, company_id uuid
);

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

GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;

INSERT INTO public.subscription_plans (key,name_ar) VALUES ('whatsapp','واتساب'),('bundle','الشاملة');
INSERT INTO public.feature_flags (key,name_ar) VALUES ('sub_users','مستخدمون فرعيون'),('whatsapp_sender','إرسال');
INSERT INTO public.plan_features (plan_id,feature_key)
SELECT sp.id,f.k FROM public.subscription_plans sp JOIN (VALUES
  ('whatsapp','whatsapp_sender'),('bundle','whatsapp_sender'),('bundle','sub_users')
) AS f(p,k) ON f.p=sp.key;

INSERT INTO public.profiles (id,email,full_name,role,super_user_id) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','owner-a@t.local','مالك أ','super_user',NULL),
  ('a5a5a5a5-a5a5-4a5a-8a5a-a5a5a5a5a5a5','staff-a@t.local','موظف أ','customer','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','owner-b@t.local','مالك ب','super_user',NULL);
INSERT INTO public.companies (id,user_id,company_name,commercial_registration_number) VALUES
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','شركة أ','1010'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','شركة ب','2020');
INSERT INTO public.whatsapp_subscriptions (user_id,plan,status,end_date) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bundle','active', now() + interval '30 days'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','whatsapp','active', now() + interval '30 days');

\echo ''
\echo '--- applying migrations/020 ---'
\i migrations/020_company_members.sql
GRANT EXECUTE ON FUNCTION public.company_members() TO authenticated;
\echo ''

SET ROLE authenticated;
\echo '=== A) المالك يرى أعضاء شركته ويستطيع الإدارة ==='
SET request.jwt.claim.sub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
DO $$
DECLARE r jsonb; BEGIN
  r := public.company_members();
  IF jsonb_array_length(r->'members') <> 2 THEN
    RAISE EXCEPTION 'FAIL A1: عدد الأعضاء % بدل 2', jsonb_array_length(r->'members'); END IF;
  IF (r->>'is_owner')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'FAIL A2'; END IF;
  IF (r->>'can_manage')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL A3: المالك بباقة شاملة لا يستطيع الإدارة'; END IF;
  IF NOT (r->'members' @> '[{"email":"staff-a@t.local"}]'::jsonb) THEN
    RAISE EXCEPTION 'FAIL A4: المستخدم الفرعي غير ظاهر'; END IF;
  RAISE NOTICE 'PASS A: المالك يرى عضوَي شركته ويملك الإدارة';
END $$;

\echo ''
\echo '=== B) العضو الفرعي يرى ولا يدير ==='
SET request.jwt.claim.sub = 'a5a5a5a5-a5a5-4a5a-8a5a-a5a5a5a5a5a5';
DO $$
DECLARE r jsonb; BEGIN
  r := public.company_members();
  IF jsonb_array_length(r->'members') <> 2 THEN RAISE EXCEPTION 'FAIL B1'; END IF;
  IF (r->>'is_owner')::boolean IS NOT FALSE THEN RAISE EXCEPTION 'FAIL B2: العضو معلَّم كمالك'; END IF;
  IF (r->>'can_manage')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'FAIL B3: العضو الفرعي يستطيع إدارة الأعضاء'; END IF;
  RAISE NOTICE 'PASS B: العضو الفرعي يقرأ فقط';
END $$;

\echo ''
\echo '=== C) العزل: لا يرى أعضاء شركة أخرى ==='
SET request.jwt.claim.sub = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
DO $$
DECLARE r jsonb; BEGIN
  r := public.company_members();
  IF (r->>'company_id') <> 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' THEN
    RAISE EXCEPTION 'FAIL C1: شركة خاطئة'; END IF;
  IF jsonb_array_length(r->'members') <> 1 THEN
    RAISE EXCEPTION 'FAIL C2: رأى % عضوًا (تسرّب من شركة أخرى)', jsonb_array_length(r->'members'); END IF;
  IF r->'members' @> '[{"email":"staff-a@t.local"}]'::jsonb THEN
    RAISE EXCEPTION 'FAIL C3: تسرّب عضو من شركة أ'; END IF;
  -- باقة واتساب لا تمنح sub_users، فالإدارة مغلقة رغم أنه مالك
  IF (r->>'can_manage')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'FAIL C4: الإدارة متاحة بلا امتياز sub_users'; END IF;
  RAISE NOTICE 'PASS C: عزل كامل، والإدارة مربوطة بالامتياز لا بالملكية وحدها';
END $$;

\echo ''
\echo '=== D) بلا شركة / بلا جلسة ==='
SET request.jwt.claim.sub = '';
DO $$ BEGIN
  IF public.company_members() IS NOT NULL THEN RAISE EXCEPTION 'FAIL D1'; END IF;
  RAISE NOTICE 'PASS D: لا بيانات لغير المسجّلين';
END $$;
RESET ROLE;

\echo ''
\echo '=== E) قابل لإعادة التطبيق ==='
\i migrations/020_company_members.sql
DO $$ BEGIN RAISE NOTICE 'PASS E: إعادة التطبيق لم تفشل'; END $$;

\echo ''
\echo 'ALL COMPANY MEMBERS TESTS PASSED'
