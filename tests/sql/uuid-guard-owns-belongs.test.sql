-- ============================================================================
-- اختبار تنفيذي لـ migrations/130_uuid_guard_owns_belongs.sql.
--
-- يثبّت إغلاق ثغرة عزل المستأجرين في owns_a_company() وbelongs_to_a_company()،
-- كل واحدة تفشل إن انكسرت:
--
--   ① المتصل يسأل عن نفسه: يملك شركة (true — كما كان)
--   ② المتصل يسأل عن نفسه: لا يملك شركة (false — كما كان)
--   ③ مالك شركة يسأل عن مالك شركة آخر (false بصمت — الثغرة نفسها)
--   ④ مستخدم بلا شركة يسأل عن مالك شركة (false — وجود العلاقة لا يُكشَف)
--   ⑤ تابع يسأل عن نفسه: عضو في شركة (true — كما كان)
--   ⑥ مالك شركة يسأل عن تابع آخر: هل هو عضو؟ (false بصمت — الثغرة نفسها)
--   ⑦ مالك المنصة يسأل عن مستخدم آخر (true — الاستثناء المخوَّل)
--   ⑧ إداري (رتبة admin) يسأل عن مستخدم آخر (true — الاستثناء المخوَّل)
--   ⑨ موظف دعم (support) يسأل عن مستخدم آخر (false — الدعم ليس إداريًا)
--  ⑩ service_role بلا JWT مستخدم يسأل عن مستخدم آخر (true — مسار الخادم)
--  ⑪ بلا JWT إطلاقًا (anon) يسأل عن مستخدم آخر أو بلا مُعامل (false)
--  ⑫ مُعامل NULL (false — كما كان)
--  ⑬ غلاف SECURITY DEFINER ينادي owns_a_company(auth.uid()) — نمط 095/096
--      و036 و038 الحيّ — يعمل بلا تغيير (حماية انحدار للمستدعين القائمين)
--  ⑭ الداخليتان _owns_a_company / _belongs_to_a_company تجيبان عن مستخدم
--      آخر (true — كود الخادم محفوظ)، وممنوعتان على authenticated
--  ⑮ محفّز sync_company_role يشتق company_admin لملف يُكتَب من جلسة إداري
--      (new.id ≠ auth.uid()) — حماية انحدار لمسار المزامنة العابر للحسابات
--  ⑯ بنيوي: التوقيع والمنح وSTABLE وSECURITY DEFINER كما كانت، والحارس
--      موجود في التعريف، والمستدعون الخمسة أُعيدوا إلى الداخليتين
--
-- النمط منسوخ من company-of-auth-check.test.sql: دور authenticated حقيقي +
-- ادعاء JWT عبر request.jwt.claim.sub، لأن postgres (المستخدم الخارق) يتجاوز
-- RLS فلا يُقاس به شيء. بذرتا is_platform_owner() وis_admin() نسختان
-- دنيا تحاكيان منطقهما الحيّ على الجداول.
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

-- ── الحالة قبل 130: تعريفا 035 حرفيًا، ليثبت الترحيل أنه يرقّي تثبيتًا حيًا ──
CREATE OR REPLACE FUNCTION public.owns_a_company(p_user_id uuid default auth.uid())
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select p_user_id is not null
     and exists (select 1 from public.companies c where c.user_id = p_user_id);
$$;
REVOKE ALL ON FUNCTION public.owns_a_company(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.owns_a_company(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.belongs_to_a_company(p_user_id uuid default auth.uid())
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select p_user_id is not null
     and exists (
           select 1
             from public.profiles p
             join public.companies c on c.user_id = p.super_user_id
            where p.id = p_user_id
         );
$$;
REVOKE ALL ON FUNCTION public.belongs_to_a_company(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.belongs_to_a_company(uuid) TO authenticated;

-- ── الحالة قبل 130: محفّز المزامنة من 035 حرفيًا + محفّزه ────────────────
CREATE OR REPLACE FUNCTION public.sync_company_role()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
declare
  v_target text;
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
$$;
REVOKE ALL ON FUNCTION public.sync_company_role() FROM public, anon, authenticated;
DROP TRIGGER IF EXISTS trg_sync_company_role ON public.profiles;
CREATE TRIGGER trg_sync_company_role
  BEFORE INSERT OR UPDATE OF super_user_id, role ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.sync_company_role();

-- ── البذور: مالك منصة، إداري، دعم، مالكا شركتين، مستخدم بلا شركة، تابع ────
-- 00e5 مالك شركة ج لكن بلا صف ملف بعد — يُدرَج في اختبار المحفّز (⑮).
-- الشركات أولًا: محفّز المزامنة يشتق الرتبة عند إدراج الملف، فيجب أن يرى الشركة.
INSERT INTO public.companies (id, user_id, company_name) VALUES
  ('11111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-0000000000a1', 'شركة أ'),
  ('22222222-2222-4222-8222-222222222222', '00000000-0000-0000-0000-0000000000b2', 'شركة ب'),
  ('33333333-3333-4333-8333-333333333333', '00000000-0000-0000-0000-0000000000e5', 'شركة ج');
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
-- اختبار المحفّز (⑮) يُدخل ملفًا بدور authenticated، فيحتاج المنح على الجدول.
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;

-- ── غلاف يحاكي نمط المستدعين القائمين (095/096 my_account_kind و036 و038):
--    دالة SECURITY DEFINER تمرّر auth.uid() نفسه ───────────────────────────
CREATE OR REPLACE FUNCTION public._test_self_owns() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
declare v_uid uuid := auth.uid();
begin
  return public.owns_a_company(v_uid);
end; $$;

\echo '--- applying migrations/130 ---'
\i migrations/130_uuid_guard_owns_belongs.sql

-- ① المتصل يسأل عن نفسه: يملك شركة.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  IF NOT public.owns_a_company('00000000-0000-0000-0000-0000000000a1'::uuid) THEN
    RAISE EXCEPTION 'FAIL 1: السؤال عن النفس لم يعد أنه يملك شركة';
  END IF;
  IF NOT public.owns_a_company() THEN
    RAISE EXCEPTION 'FAIL 1b: الاستدعاء بلا مُعامل لم يعد أنه يملك شركة';
  END IF;
  RESET ROLE;
  RAISE NOTICE 'PASS 1: السؤال عن النفس يعمل (يملك شركة)';
END $$;

-- ② المتصل يسأل عن نفسه: لا يملك شركة.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000c3', true);
  SET LOCAL ROLE authenticated;
  IF public.owns_a_company('00000000-0000-0000-0000-0000000000c3'::uuid) THEN
    RAISE EXCEPTION 'FAIL 2: مستخدم بلا شركة أعيد أنه يملك شركة';
  END IF;
  RESET ROLE;
  RAISE NOTICE 'PASS 2: السؤال عن النفس يعمل (لا يملك شركة)';
END $$;

-- ③ مالك شركة يسأل عن مالك شركة آخر — false بصمت (الثغرة نفسها).
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  IF public.owns_a_company('00000000-0000-0000-0000-0000000000b2'::uuid) THEN
    RAISE EXCEPTION 'FAIL 3: السؤال عن مستخدم آخر كشف أنه يملك شركة';
  END IF;
  RESET ROLE;
  RAISE NOTICE 'PASS 3: السؤال عن مستخدم آخر false بصمت';
END $$;

-- ④ مستخدم بلا شركة يسأل عن مالك شركة.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000c3', true);
  SET LOCAL ROLE authenticated;
  IF public.owns_a_company('00000000-0000-0000-0000-0000000000a1'::uuid) THEN
    RAISE EXCEPTION 'FAIL 4: مستخدم بلا شركة كشف علاقة غيره';
  END IF;
  RESET ROLE;
  RAISE NOTICE 'PASS 4: مستخدم بلا شركة يسأل عن غيره false';
END $$;

-- ⑤ تابع يسأل عن نفسه: عضو في شركة.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000d4', true);
  SET LOCAL ROLE authenticated;
  IF NOT public.belongs_to_a_company('00000000-0000-0000-0000-0000000000d4'::uuid) THEN
    RAISE EXCEPTION 'FAIL 5: التابع لم يعد أنه عضو في شركة';
  END IF;
  IF NOT public.belongs_to_a_company() THEN
    RAISE EXCEPTION 'FAIL 5b: الاستدعاء بلا مُعامل لم يعد عضوية التابع';
  END IF;
  RESET ROLE;
  RAISE NOTICE 'PASS 5: التابع عن نفسه عضو في شركة';
END $$;

-- ⑥ مالك شركة يسأل عن تابع آخر: هل هو عضو؟ — false بصمت.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  IF public.belongs_to_a_company('00000000-0000-0000-0000-0000000000d4'::uuid) THEN
    RAISE EXCEPTION 'FAIL 6: السؤال عن تابع آخر كشف عضويته';
  END IF;
  RESET ROLE;
  RAISE NOTICE 'PASS 6: السؤال عن عضوية مستخدم آخر false بصمت';
END $$;

-- ⑦ مالك المنصة يسأل عن مستخدم آخر.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE authenticated;
  IF NOT public.owns_a_company('00000000-0000-0000-0000-0000000000b2'::uuid) THEN
    RAISE EXCEPTION 'FAIL 7: مالك المنصة لم يعد أن الآخر يملك شركة';
  END IF;
  IF NOT public.belongs_to_a_company('00000000-0000-0000-0000-0000000000d4'::uuid) THEN
    RAISE EXCEPTION 'FAIL 7b: مالك المنصة لم يعد عضوية التابع';
  END IF;
  RESET ROLE;
  RAISE NOTICE 'PASS 7: مالك المنصة يسأل عن آخر يعمل';
END $$;

-- ⑧ إداري يسأل عن مستخدم آخر.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002', true);
  SET LOCAL ROLE authenticated;
  IF NOT public.owns_a_company('00000000-0000-0000-0000-0000000000b2'::uuid) THEN
    RAISE EXCEPTION 'FAIL 8: الإداري لم يعد أن الآخر يملك شركة';
  END IF;
  RESET ROLE;
  RAISE NOTICE 'PASS 8: الإداري يسأل عن آخر يعمل';
END $$;

-- ⑨ موظف دعم يسأل عن مستخدم آخر — false (الدعم ليس إداريًا).
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003', true);
  SET LOCAL ROLE authenticated;
  IF public.owns_a_company('00000000-0000-0000-0000-0000000000b2'::uuid) THEN
    RAISE EXCEPTION 'FAIL 9: الدعم كشف أن مستخدمًا آخر يملك شركة';
  END IF;
  IF public.belongs_to_a_company('00000000-0000-0000-0000-0000000000d4'::uuid) THEN
    RAISE EXCEPTION 'FAIL 9b: الدعم كشف عضوية مستخدم آخر';
  END IF;
  RESET ROLE;
  RAISE NOTICE 'PASS 9: الدعم يسأل عن آخر false';
END $$;

-- ⑩ service_role بلا JWT مستخدم يسأل عن مستخدم آخر.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','', true);
  PERFORM set_config('request.jwt.claim.role','service_role', true);
  SET LOCAL ROLE service_role;
  IF NOT public.owns_a_company('00000000-0000-0000-0000-0000000000b2'::uuid) THEN
    RAISE EXCEPTION 'FAIL 10: service_role لم يعد أن الآخر يملك شركة';
  END IF;
  RESET ROLE;
  RAISE NOTICE 'PASS 10: service_role يسأل عن آخر يعمل';
END $$;

-- ⑪ بلا JWT إطلاقًا.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','', true);
  PERFORM set_config('request.jwt.claim.role','', true);
  IF public.owns_a_company('00000000-0000-0000-0000-0000000000b2'::uuid) THEN
    RAISE EXCEPTION 'FAIL 11: بلا JWT أعيد أن مستخدمًا يملك شركة';
  END IF;
  IF public.owns_a_company() THEN
    RAISE EXCEPTION 'FAIL 11b: بلا JWT وبلا مُعامل أعيد أنه يملك شركة';
  END IF;
  IF public.belongs_to_a_company('00000000-0000-0000-0000-0000000000d4'::uuid) THEN
    RAISE EXCEPTION 'FAIL 11c: بلا JWT أعيدت عضوية مستخدم';
  END IF;
  RAISE NOTICE 'PASS 11: بلا JWT كل شيء false';
END $$;

-- ⑫ مُعامل NULL.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  IF public.owns_a_company(NULL::uuid) THEN
    RAISE EXCEPTION 'FAIL 12: مُعامل NULL أعيد true';
  END IF;
  IF public.belongs_to_a_company(NULL::uuid) THEN
    RAISE EXCEPTION 'FAIL 12b: مُعامل NULL أعيد true للعضوية';
  END IF;
  RESET ROLE;
  RAISE NOTICE 'PASS 12: مُعامل NULL يعيد false';
END $$;

-- ⑬ غلاف SECURITY DEFINER ينادي owns_a_company(auth.uid()).
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  IF NOT public._test_self_owns() THEN
    RAISE EXCEPTION 'FAIL 13: غلاف ينادي owns_a_company(auth.uid()) انكسر';
  END IF;
  RESET ROLE;
  RAISE NOTICE 'PASS 13: غلاف owns_a_company(auth.uid()) يعمل';
END $$;

-- ⑭ الداخليتان تجيبان عن مستخدم آخر، وممنوعتان على authenticated.
--    الاستدعاء المباشر هنا بصفة postgres (مالك الدوال) — فحص المنح منفصل أدناه.
DO $$
BEGIN
  IF NOT public._owns_a_company('00000000-0000-0000-0000-0000000000b2'::uuid) THEN
    RAISE EXCEPTION 'FAIL 14a: _owns_a_company لم تعد أن الآخر يملك شركة';
  END IF;
  IF NOT public._belongs_to_a_company('00000000-0000-0000-0000-0000000000d4'::uuid) THEN
    RAISE EXCEPTION 'FAIL 14b: _belongs_to_a_company لم تعد عضوية التابع';
  END IF;
  IF has_function_privilege('authenticated', 'public._owns_a_company(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL 14c: _owns_a_company ممنوحة لـ authenticated';
  END IF;
  IF has_function_privilege('authenticated', 'public._belongs_to_a_company(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL 14d: _belongs_to_a_company ممنوحة لـ authenticated';
  END IF;
  IF has_function_privilege('anon', 'public._owns_a_company(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL 14e: _owns_a_company ممنوحة لـ anon';
  END IF;
  RAISE NOTICE 'PASS 14: الداخليتان تجيبان عن آخر، وممنوعتان على authenticated';
END $$;

-- ⑮ محفّز المزامنة: إداري يُدخل ملف مالك شركة ج (new.id ≠ auth.uid()).
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002', true);
  SET LOCAL ROLE authenticated;
  INSERT INTO public.profiles (id, role, super_user_id)
  VALUES ('00000000-0000-0000-0000-0000000000e5', 'user', null);
  RESET ROLE;
  IF (SELECT role FROM public.profiles WHERE id = '00000000-0000-0000-0000-0000000000e5') <> 'company_admin' THEN
    RAISE EXCEPTION 'FAIL 15: المزامنة لم تشتق company_admin لمالك شركة ج';
  END IF;
  RAISE NOTICE 'PASS 15: المزامنة تشتق company_admin عبر الداخليتين';
END $$;

-- ⑯ بنيوي: التوقيع والمنح وSTABLE وSECURITY DEFINER والحارس وإعادة التوجيه.
DO $$
DECLARE
  v_def text := pg_get_functiondef('public.owns_a_company(uuid)'::regprocedure);
  v_def2 text := pg_get_functiondef('public.belongs_to_a_company(uuid)'::regprocedure);
BEGIN
  IF v_def NOT LIKE '%p_user_id uuid DEFAULT auth.uid()%' THEN
    RAISE EXCEPTION 'FAIL 16a: توقيع owns_a_company أو افتراضيه تغيّر';
  END IF;
  IF v_def NOT LIKE '%is distinct from auth.uid()%' THEN
    RAISE EXCEPTION 'FAIL 16b: حارس التمايز غائب من owns_a_company';
  END IF;
  IF v_def2 NOT LIKE '%is distinct from auth.uid()%' THEN
    RAISE EXCEPTION 'FAIL 16c: حارس التمايز غائب من belongs_to_a_company';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.owns_a_company(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL 16d: authenticated فقد تنفيذ owns_a_company()';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.belongs_to_a_company(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL 16e: authenticated فقد تنفيذ belongs_to_a_company()';
  END IF;
  IF has_function_privilege('anon', 'public.owns_a_company(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL 16f: anon صار ينفّذ owns_a_company()';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.owns_a_company(uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'FAIL 16g: owns_a_company() لم تعد SECURITY DEFINER';
  END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.owns_a_company(uuid)'::regprocedure) <> 's' THEN
    RAISE EXCEPTION 'FAIL 16h: owns_a_company() لم تعد STABLE';
  END IF;
  IF pg_get_functiondef('public.sync_company_role()'::regprocedure) NOT LIKE '%_owns_a_company(new.id)%' THEN
    RAISE EXCEPTION 'FAIL 16i: sync_company_role() لم تُعَد إلى الداخليتين';
  END IF;
  IF pg_get_functiondef('public.sync_company_owner_role()'::regprocedure) NOT LIKE '%_owns_a_company(old.user_id)%' THEN
    RAISE EXCEPTION 'FAIL 16j: sync_company_owner_role() لم تُعَد إلى الداخليتين';
  END IF;
  IF pg_get_functiondef('public.guard_profile_role_change()'::regprocedure) NOT LIKE '%_belongs_to_a_company(new.id)%' THEN
    RAISE EXCEPTION 'FAIL 16k: guard_profile_role_change() لم تُعَد إلى الداخليتين';
  END IF;
  IF pg_get_functiondef('public.company_invite_customer(text)'::regprocedure) NOT LIKE '%_owns_a_company(p.id)%' THEN
    RAISE EXCEPTION 'FAIL 16l: company_invite_customer() لم تُعَد إلى الداخليتين';
  END IF;
  IF pg_get_functiondef('public._hierarchy_eligible(uuid)'::regprocedure) NOT LIKE '%_owns_a_company(p_user)%' THEN
    RAISE EXCEPTION 'FAIL 16m: _hierarchy_eligible() لم تُعَد إلى الداخليتين';
  END IF;
  RAISE NOTICE 'PASS 16: التوقيع والمنح والخصائص والحارس وإعادة التوجيه كما هو مطلوب';
END $$;

DROP FUNCTION IF EXISTS public._test_self_owns();

DO $$ BEGIN RAISE NOTICE 'ALL uuid-guard-owns-belongs tests passed'; END $$;
