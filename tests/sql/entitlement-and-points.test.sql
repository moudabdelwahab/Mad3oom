-- اختبار تنفيذي لـ 029.
\set ON_ERROR_STOP on
\pset tuples_only on
CREATE SCHEMA IF NOT EXISTS auth;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
END $$;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text UNIQUE);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true),'')::uuid; $$;
GRANT USAGE ON SCHEMA auth, public TO authenticated, anon;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;
GRANT SELECT ON auth.users TO authenticated, anon;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, email text UNIQUE, role text DEFAULT 'user',
  points int DEFAULT 0, whatsapp_enabled boolean DEFAULT false,
  ban_status text DEFAULT 'none', ban_until timestamptz);
GRANT USAGE ON SCHEMA public TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated, anon;

CREATE OR REPLACE FUNCTION public.is_main_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE((SELECT email FROM auth.users WHERE id=auth.uid())
    IN ('support@mad3oom.online','info@mad3oom.online'),false); $$;
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND role='admin')
      OR public.is_main_admin(); $$;
CREATE OR REPLACE FUNCTION public.is_platform_staff() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND role IN ('admin','support'))
      OR public.is_main_admin(); $$;
CREATE OR REPLACE FUNCTION public.owned_feature_keys(p_user_id uuid DEFAULT auth.uid())
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT CASE WHEN p_user_id::text LIKE '5%' THEN ARRAY['whatsapp_sender'] ELSE ARRAY[]::text[] END; $$;
GRANT EXECUTE ON FUNCTION public.is_admin(), public.is_main_admin(), public.is_platform_staff(),
  public.owned_feature_keys(uuid) TO authenticated, anon;

-- الشكل المعيب
CREATE OR REPLACE FUNCTION public.has_chatbot_entitlement(p_user_id uuid DEFAULT auth.uid())
RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id=p_user_id
    AND (whatsapp_enabled = true OR role IN ('super_user','admin'))); $$;
CREATE OR REPLACE FUNCTION public.guard_profile_points_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NEW.points IS NOT DISTINCT FROM OLD.points THEN RETURN NEW; END IF;
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF COALESCE(current_setting('app.bypass_profile_points_guard', true),'') = 'on' THEN RETURN NEW; END IF;
  IF public.is_main_admin() THEN RETURN NEW; END IF;
  IF auth.uid() = NEW.id THEN RAISE EXCEPTION 'لا يمكنك تعديل نقاط حسابك بنفسك' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_profile_points_change BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_points_change();
GRANT EXECUTE ON FUNCTION public.has_chatbot_entitlement(uuid) TO authenticated, anon;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_sel ON public.profiles FOR SELECT USING (true);
CREATE POLICY p_upd ON public.profiles FOR UPDATE USING (auth.uid() = id OR public.is_admin());

INSERT INTO auth.users(id,email) VALUES
  ('11111111-1111-4111-8111-111111111111','support@mad3oom.online'),
  ('22222222-2222-4222-8222-222222222222','owner@test'),
  ('33333333-3333-4333-8333-333333333333','plain@test'),
  ('55555555-5555-4555-8555-555555555555','subscriber@test');
INSERT INTO public.profiles(id,email,role,whatsapp_enabled) VALUES
  ('11111111-1111-4111-8111-111111111111','support@mad3oom.online','admin',false),
  ('22222222-2222-4222-8222-222222222222','owner@test','super_user',false),
  ('33333333-3333-4333-8333-333333333333','plain@test','user',false),
  ('55555555-5555-4555-8555-555555555555','subscriber@test','user',true);

-- ── أ) الضابط السلبي ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT public.has_chatbot_entitlement('22222222-2222-4222-8222-222222222222') THEN
    RAISE EXCEPTION 'FAIL setup: الرتبة القديمة لا تمنح الاستحقاق — لا شيء لإثباته';
  END IF;
  RAISE NOTICE 'PASS A1: قبل الترحيل، الرتبة القديمة وحدها تمنح استحقاقًا مدفوعًا';
END $$;

SET request.jwt.claim.sub='33333333-3333-4333-8333-333333333333';
SET ROLE authenticated;
DO $$
DECLARE n int;
BEGIN
  PERFORM set_config('app.bypass_profile_points_guard','on',true);
  UPDATE public.profiles SET points=999999 WHERE id='33333333-3333-4333-8333-333333333333';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RAISE EXCEPTION 'FAIL setup: علَم التجاوز لا يعمل — لا شيء لإثباته'; END IF;
  RAISE NOTICE 'PASS A2: قبل الترحيل، ضبط العلَم داخل المعاملة يتجاوز حارس النقاط';
END $$;
RESET ROLE; SET request.jwt.claim.sub='';
UPDATE public.profiles SET points=0 WHERE id='33333333-3333-4333-8333-333333333333';

-- ── ب) الترحيل ──────────────────────────────────────────────────────────────
\i migrations/029_entitlement_and_points_guard.sql

-- ── ج) بعد ─────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF public.has_chatbot_entitlement('22222222-2222-4222-8222-222222222222') THEN
    RAISE EXCEPTION 'FAIL C1: الرتبة القديمة ما زالت تمنح الاستحقاق';
  END IF;
  IF NOT public.has_chatbot_entitlement('55555555-5555-4555-8555-555555555555') THEN
    RAISE EXCEPTION 'FAIL C2: المشترك الحقيقي فقد استحقاقه';
  END IF;
  IF NOT public.has_chatbot_entitlement('11111111-1111-4111-8111-111111111111') THEN
    RAISE EXCEPTION 'FAIL C3: الأدمن فقد استحقاقه';
  END IF;
  IF public.has_chatbot_entitlement('33333333-3333-4333-8333-333333333333') THEN
    RAISE EXCEPTION 'FAIL C4: عميل بلا اشتراك حصل على الاستحقاق';
  END IF;
  RAISE NOTICE 'PASS C1..C4 الاستحقاق للمشترك والطاقم فقط — لا للرتبة القديمة';
END $$;

SET request.jwt.claim.sub='33333333-3333-4333-8333-333333333333';
SET ROLE authenticated;
DO $$
DECLARE n int; ok boolean := false;
BEGIN
  PERFORM set_config('app.bypass_profile_points_guard','on',true);
  BEGIN
    UPDATE public.profiles SET points=999999 WHERE id='33333333-3333-4333-8333-333333333333';
    GET DIAGNOSTICS n = ROW_COUNT;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL C5: علَم التجاوز ما زال يفتح حارس النقاط'; END IF;
  RAISE NOTICE 'PASS C5 اللغم أُزيل: العلَم لم يعد يمنح شيئًا';
END $$;
RESET ROLE; SET request.jwt.claim.sub='';

-- ── د) المسار المشروع: الأدمن ما زال يعدّل نقاط غيره ───────────────────────
SET request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
SET ROLE authenticated;
DO $$
DECLARE n int;
BEGIN
  UPDATE public.profiles SET points=250 WHERE id='33333333-3333-4333-8333-333333333333';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RAISE EXCEPTION 'FAIL D1: الأدمن لم يعد يستطيع منح النقاط'; END IF;
  UPDATE public.profiles SET points=300 WHERE id='11111111-1111-4111-8111-111111111111';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RAISE EXCEPTION 'FAIL D2: الأدمن لم يعد يستطيع اعتماد بلاغ لنفسه (كان يحتاج العلَم)'; END IF;
  RAISE NOTICE 'PASS D1..D2 مسار المكافآت سليم بلا أي علَم';
END $$;
RESET ROLE; SET request.jwt.claim.sub='';

-- ── هـ) is_banned تصف الحالة ولا تُنفّذها ───────────────────────────────────
UPDATE public.profiles SET ban_status='banned' WHERE id='33333333-3333-4333-8333-333333333333';
DO $$
BEGIN
  IF NOT public.is_banned('33333333-3333-4333-8333-333333333333') THEN
    RAISE EXCEPTION 'FAIL E1: is_banned لا تتعرف على الحظر';
  END IF;
  IF public.is_banned('55555555-5555-4555-8555-555555555555') THEN
    RAISE EXCEPTION 'FAIL E2: is_banned تعتبر غير المحظور محظورًا';
  END IF;
  RAISE NOTICE 'PASS E1..E2 is_banned تقرأ الحالة (الإنفاذ قرار منفصل)';
END $$;

\i migrations/029_entitlement_and_points_guard.sql
DO $$ BEGIN RAISE NOTICE 'PASS F1 إعادة تطبيق 029 لم تفشل'; END $$;
SELECT 'ALL 029 TESTS PASSED' AS result;
