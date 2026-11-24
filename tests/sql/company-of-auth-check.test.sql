-- ============================================================================
-- اختبار تنفيذي لـ migrations/127_company_of_auth_check.sql.
--
-- يثبّت إغلاق ثغرة عزل المستأجرين في company_of()، كل واحدة تفشل إن انكسرت:
--
--   ① المتصل يسأل عن نفسه بمُعامل صريح (يعمل — كما كان)
--   ② المتصل يسأل بلا مُعامل، أي عن نفسه بالافتراضي (يعمل — كما كان)
--   ③ المتصل يسأل عن مستخدم آخر (NULL بصمت، بلا خطأ يسرّب معلومات)
--   ④ مستخدم بلا شركة يسأل عن مالك شركة (NULL — وجود الشركة لا يُكشَف)
--   ⑤ مستخدم بلا شركة يسأل عن نفسه (NULL)
--   ⑥ تابع الشركة يسأل عن نفسه (شركة مالكه الأعلى عبر super_user_id — يعمل)،
--      ويسأل عن مالكه صراحةً (NULL)
--   ⑦ مالك المنصة يسأل عن مستخدم آخر (يعمل — الاستثناء المخوَّل)
--   ⑧ إداري (رتبة admin) يسأل عن مستخدم آخر (يعمل — الاستثناء المخوَّل)
--   ⑨ موظف دعم (support) يسأل عن مستخدم آخر (NULL — الدعم ليس إداريًا هنا)
--  ⑩ service_role بلا JWT مستخدم يسأل عن مستخدم آخر (يعمل — مسار الخادم)
--  ⑪ بلا JWT إطلاقًا (anon) يسأل عن مستخدم آخر أو بلا مُعامل (NULL)
--  ⑫ مُعامل NULL (NULL — كما كان)
--  ⑬ غلاف SECURITY DEFINER ينادي company_of(auth.uid()) — نمط 095/096 و036
--      و038 الحيّ — يعمل بلا تغيير (حماية انحدار للمستدعين القائمين)
--  ⑭ بنيوي: التوقيع والمنح وSTABLE وSECURITY DEFINER كما كانت، والحارس
--      موجود في التعريف
--
-- النمط منسوخ من chat-ratings.test.sql: دور authenticated حقيقي + ادعاء
-- JWT عبر request.jwt.claim.sub، لأن postgres (المستخدم الخارق) يتجاوز
-- RLS فلا يُقاس به شيء. بذرتا is_platform_owner() وis_admin() نسختان
-- دنيا تحاكيان منطقهما الحيّ على الجداول (المالك: صف owner في
-- platform_authority + رتبة platform_owner؛ الإداري: رتبة admin)؛
-- التعريف الحيّ يضيف owner_capability للمالك في سياق admin، والمالك
-- مغطى هنا أصلًا عبر is_platform_owner() فلا يؤثر الفرق في النتائج.
-- يُنفَّذ عبر tests/run-sql-tests.sh ضد Postgres مؤقت (CI/محلي).
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true),'')::uuid; $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.role', true),''); $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $$;
GRANT USAGE ON SCHEMA auth, public TO authenticated, anon, service_role;

-- ── الجداول الدنيا التي يمسّها الترحيل ────────────────────────────────────
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, role text DEFAULT 'user', super_user_id uuid
);
CREATE TABLE public.companies (
  id uuid PRIMARY KEY, user_id uuid NOT NULL UNIQUE, company_name text NOT NULL
);
CREATE TABLE public.platform_authority (
  user_id uuid NOT NULL, level text NOT NULL, PRIMARY KEY (user_id, level)
);

-- ── بذرتا دوال السلطة اللتين يعتمد عليهما الترحيل ────────────────────────
CREATE OR REPLACE FUNCTION public.is_platform_owner() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select exists (
    select 1
      from public.platform_authority a
      join public.profiles p on p.id = a.user_id
     where a.user_id = auth.uid()
       and a.level   = 'owner'
       and p.role    = 'platform_owner'
  ); $$;

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'); $$;

-- ── الحالة قبل 127: تعريف 035 حرفيًا، ليثبت الترحيل أنه يرقّي تثبيتًا حيًا ──
CREATE OR REPLACE FUNCTION public.company_of(p_user_id uuid default auth.uid())
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select c.id
    from public.companies c
   where p_user_id is not null
     and (c.user_id = p_user_id
          or c.user_id = (select p.super_user_id from public.profiles p where p.id = p_user_id))
   order by (c.user_id = p_user_id) desc
   limit 1;
$$;
REVOKE ALL ON FUNCTION public.company_of(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.company_of(uuid) TO authenticated;

-- ── البذور: مالك منصة، إداري، دعم، مالكا شركتين، مستخدم بلا شركة، تابع ────
INSERT INTO public.profiles (id, role, super_user_id) VALUES
  ('00000000-0000-0000-0000-000000000001', 'platform_owner', null),
  ('00000000-0000-0000-0000-000000000002', 'admin',          null),
  ('00000000-0000-0000-0000-000000000003', 'support',        null),
  ('00000000-0000-0000-0000-0000000000a1', 'company_admin',  null),
  ('00000000-0000-0000-0000-0000000000b2', 'company_admin',  null),
  ('00000000-0000-0000-0000-0000000000c3', 'user',           null),
  ('00000000-0000-0000-0000-0000000000d4', 'user', '00000000-0000-0000-0000-0000000000a1');
INSERT INTO public.platform_authority (user_id, level) VALUES
  ('00000000-0000-0000-0000-000000000001', 'owner');
INSERT INTO public.companies (id, user_id, company_name) VALUES
  ('11111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-0000000000a1', 'شركة أ'),
  ('22222222-2222-4222-8222-222222222222', '00000000-0000-0000-0000-0000000000b2', 'شركة ب');

-- ── غلاف يحاكي نمط المستدعين القائمين (095/096 my_account_kind و036 و038):
--    دالة SECURITY DEFINER تمرّر auth.uid() نفسه ───────────────────────────
CREATE OR REPLACE FUNCTION public._test_self_company() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
declare v_uid uuid := auth.uid();
begin
  return public.company_of(v_uid);
end; $$;

\echo '--- applying migrations/127 ---'
\i migrations/127_company_of_auth_check.sql

-- ① المتصل يسأل عن نفسه بمُعامل صريح.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  IF public.company_of('00000000-0000-0000-0000-0000000000a1'::uuid)
     <> '11111111-1111-4111-8111-111111111111'::uuid THEN
    RAISE EXCEPTION 'FAIL 1: السؤال عن النفس بمُعامل صريح لم يعد شركته';
  END IF;
  RESET ROLE;
  RAISE NOTICE 'PASS 1: السؤال عن النفس بمُعامل صريح يعمل';
END $$;

-- ② المتصل يسأل بلا مُعامل.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  IF public.company_of() <> '11111111-1111-4111-8111-111111111111'::uuid THEN
    RAISE EXCEPTION 'FAIL 2: الاستدعاء بلا مُعامل لم يعد شركة المتصل';
  END IF;
  RESET ROLE;
  RAISE NOTICE 'PASS 2: الاستدعاء بلا مُعامل يعمل';
END $$;

-- ③ المتصل يسأل عن مستخدم آخر — NULL بصمت (ولو رفع خطأً لفشل الملف كله).
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  IF public.company_of('00000000-0000-0000-0000-0000000000b2'::uuid) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 3: السؤال عن مستخدم آخر كشف شركته';
  END IF;
  RESET ROLE;
  RAISE NOTICE 'PASS 3: السؤال عن مستخدم آخر NULL بصمت';
END $$;

-- ④ مستخدم بلا شركة يسأل عن مالك شركة.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000c3', true);
  SET LOCAL ROLE authenticated;
  IF public.company_of('00000000-0000-0000-0000-0000000000a1'::uuid) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 4: مستخدم بلا شركة كشف وجود شركة غيره';
  END IF;
  RESET ROLE;
  RAISE NOTICE 'PASS 4: مستخدم بلا شركة يسأل عن غيره NULL';
END $$;

-- ⑤ مستخدم بلا شركة يسأل عن نفسه.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000c3', true);
  SET LOCAL ROLE authenticated;
  IF public.company_of('00000000-0000-0000-0000-0000000000c3'::uuid) IS NOT NULL
     OR public.company_of() IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 5: مستخدم بلا شركة أعيدت له شركة';
  END IF;
  RESET ROLE;
  RAISE NOTICE 'PASS 5: مستخدم بلا شركة يسأل عن نفسه NULL';
END $$;

-- ⑥ تابع الشركة: عن نفسه شركة مالكه الأعلى؛ عن مالكه صراحةً NULL.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000d4', true);
  SET LOCAL ROLE authenticated;
  IF public.company_of('00000000-0000-0000-0000-0000000000d4'::uuid)
     <> '11111111-1111-4111-8111-111111111111'::uuid THEN
    RAISE EXCEPTION 'FAIL 6a: التابع لم يعد شركة مالكه الأعلى عن نفسه';
  END IF;
  IF public.company_of('00000000-0000-0000-0000-0000000000a1'::uuid) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 6b: التابع سأل عن مالكه صراحةً فكُشفت شركته';
  END IF;
  RESET ROLE;
  RAISE NOTICE 'PASS 6: التابع عن نفسه شركة مالكه، وعن مالكه NULL';
END $$;

-- ⑦ مالك المنصة يسأل عن مستخدم آخر.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE authenticated;
  IF public.company_of('00000000-0000-0000-0000-0000000000b2'::uuid)
     <> '22222222-2222-4222-8222-222222222222'::uuid THEN
    RAISE EXCEPTION 'FAIL 7: مالك المنصة لم يعد شركة مستخدم آخر';
  END IF;
  RESET ROLE;
  RAISE NOTICE 'PASS 7: مالك المنصة يسأل عن آخر يعمل';
END $$;

-- ⑧ إداري يسأل عن مستخدم آخر.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002', true);
  SET LOCAL ROLE authenticated;
  IF public.company_of('00000000-0000-0000-0000-0000000000b2'::uuid)
     <> '22222222-2222-4222-8222-222222222222'::uuid THEN
    RAISE EXCEPTION 'FAIL 8: الإداري لم يعد شركة مستخدم آخر';
  END IF;
  RESET ROLE;
  RAISE NOTICE 'PASS 8: الإداري يسأل عن آخر يعمل';
END $$;

-- ⑨ موظف دعم يسأل عن مستخدم آخر — NULL (الدعم ليس إداريًا).
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003', true);
  SET LOCAL ROLE authenticated;
  IF public.company_of('00000000-0000-0000-0000-0000000000b2'::uuid) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 9: الدعم كشف شركة مستخدم آخر';
  END IF;
  RESET ROLE;
  RAISE NOTICE 'PASS 9: الدعم يسأل عن آخر NULL';
END $$;

-- ⑩ service_role بلا JWT مستخدم يسأل عن مستخدم آخر.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','', true);
  PERFORM set_config('request.jwt.claim.role','service_role', true);
  SET LOCAL ROLE service_role;
  IF public.company_of('00000000-0000-0000-0000-0000000000b2'::uuid)
     <> '22222222-2222-4222-8222-222222222222'::uuid THEN
    RAISE EXCEPTION 'FAIL 10: service_role لم يعد شركة مستخدم آخر';
  END IF;
  RESET ROLE;
  RAISE NOTICE 'PASS 10: service_role يسأل عن آخر يعمل';
END $$;

-- ⑪ بلا JWT إطلاقًا.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','', true);
  PERFORM set_config('request.jwt.claim.role','', true);
  IF public.company_of('00000000-0000-0000-0000-0000000000b2'::uuid) IS NOT NULL
     OR public.company_of() IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 11: بلا JWT أعيدت شركة';
  END IF;
  RAISE NOTICE 'PASS 11: بلا JWT كل شيء NULL';
END $$;

-- ⑫ مُعامل NULL.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  IF public.company_of(NULL::uuid) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 12: مُعامل NULL أعيدت له شركة';
  END IF;
  RESET ROLE;
  RAISE NOTICE 'PASS 12: مُعامل NULL يعيد NULL';
END $$;

-- ⑬ غلاف SECURITY DEFINER ينادي company_of(auth.uid()) — نمط المستدعين القائمين.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  IF public._test_self_company() <> '11111111-1111-4111-8111-111111111111'::uuid THEN
    RAISE EXCEPTION 'FAIL 13: غلاف ينادي company_of(auth.uid()) انكسر';
  END IF;
  RESET ROLE;
  RAISE NOTICE 'PASS 13: غلاف company_of(auth.uid()) يعمل';
END $$;

-- ⑭ بنيوي: التوقيع والمنح وSTABLE وSECURITY DEFINER والحارس في التعريف.
DO $$
DECLARE
  v_def text := pg_get_functiondef('public.company_of(uuid)'::regprocedure);
BEGIN
  IF v_def NOT LIKE '%p_user_id uuid DEFAULT auth.uid()%' THEN
    RAISE EXCEPTION 'FAIL 14a: التوقيع أو الافتراضي تغيّر';
  END IF;
  IF v_def NOT LIKE '%is distinct from auth.uid()%' THEN
    RAISE EXCEPTION 'FAIL 14b: حارس التمايز غائب من التعريف';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.company_of(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL 14c: authenticated فقد تنفيذ company_of()';
  END IF;
  IF has_function_privilege('anon', 'public.company_of(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL 14d: anon صار ينفّذ company_of()';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.company_of(uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'FAIL 14e: company_of() لم تعد SECURITY DEFINER';
  END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.company_of(uuid)'::regprocedure) <> 's' THEN
    RAISE EXCEPTION 'FAIL 14f: company_of() لم تعد STABLE';
  END IF;
  RAISE NOTICE 'PASS 14: التوقيع والمنح والخصائص والحارس كما هو مطلوب';
END $$;

DROP FUNCTION IF EXISTS public._test_self_company();

DO $$ BEGIN RAISE NOTICE 'ALL company-of-auth-check tests passed'; END $$;
