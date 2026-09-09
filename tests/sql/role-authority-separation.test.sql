-- اختبار تنفيذي لـ migrations/024_role_authority_separation.sql
--
-- يغطي:
--   C2 — صاحب شركة كان يرقّي عضوه إلى admin ثم يدخل بحسابه.
--   H4 — الرتبة super_user كانت تُشتق من الاشتراك، والإسناد يفشل صامتًا،
--        فميزة أعضاء الشركة لم تعمل قط.
--   M2 — أدمن عادي كان يصنع أدمن آخر.
--   M3 — super_user كان يُعدّ طاقمًا ويرسل إشعارات لأي مستخدم.
--   H3 — الوظيفة الدورية كانت تقرر الامتيازات بأسماء باقات مثبَّتة نصًّا.
--
-- المبدأ الذي يثبته الاختبار: امتلاك اشتراك يمنح Entitlements ولا يمنح سلطة.
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
END $$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, email text, full_name text, username text,
  role text NOT NULL DEFAULT 'user', super_user_id uuid,
  whatsapp_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE, company_name text NOT NULL,
  commercial_registration_number text UNIQUE,
  commercial_registration_expiry date,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text NOT NULL UNIQUE,
  name text NOT NULL, name_ar text, is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE public.feature_flags (key text PRIMARY KEY, name text, name_ar text, description text);
CREATE TABLE public.plan_features (
  plan_id uuid NOT NULL REFERENCES public.subscription_plans(id) ON DELETE CASCADE,
  feature_key text NOT NULL REFERENCES public.feature_flags(key) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true, limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (plan_id, feature_key)
);
CREATE TABLE public.whatsapp_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  status text DEFAULT 'active', billing_cycle text,
  start_date timestamptz DEFAULT now(), end_date timestamptz NOT NULL,
  plan text NOT NULL DEFAULT 'whatsapp', company_id uuid,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  title text, message text, type text, link text, created_at timestamptz DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN RETURN EXISTS (SELECT 1 FROM public.profiles WHERE id=auth.uid()
  AND (role='admin' OR email IN ('support@mad3oom.online','info@mad3oom.online'))); END; $$;

CREATE OR REPLACE FUNCTION public.is_main_admin() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN RETURN COALESCE((SELECT email FROM public.profiles WHERE id=auth.uid())
  IN ('support@mad3oom.online','info@mad3oom.online'), false); END; $$;

CREATE OR REPLACE FUNCTION public.plan_feature_keys(p_plan_key text) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT coalesce(array_agg(DISTINCT pf.feature_key),'{}'::text[])
    FROM public.subscription_plans sp JOIN public.plan_features pf
      ON pf.plan_id=sp.id AND pf.enabled WHERE sp.key=p_plan_key;
$$;

CREATE OR REPLACE FUNCTION public.owned_feature_keys(p_user_id uuid DEFAULT auth.uid()) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT coalesce(array_agg(DISTINCT pf.feature_key),'{}'::text[])
    FROM public.whatsapp_subscriptions s
    JOIN public.subscription_plans sp ON sp.key=s.plan
    JOIN public.plan_features pf ON pf.plan_id=sp.id AND pf.enabled
   WHERE s.user_id=p_user_id AND s.status='active'
     AND s.start_date<=now() AND s.end_date>now();
$$;

CREATE OR REPLACE FUNCTION public.has_feature_access(p_feature_key text, p_user_id uuid DEFAULT auth.uid())
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT p_feature_key = ANY(public.owned_feature_keys(p_user_id)) OR public.is_admin();
$$;

CREATE OR REPLACE FUNCTION public.subscription_purchase_check(
  p_plan text, p_is_renewal boolean DEFAULT false, p_user_id uuid DEFAULT auth.uid())
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN RETURN jsonb_build_object('allowed',true,'code','adds_features','reason','ok'); END; $$;

CREATE OR REPLACE FUNCTION public.current_company_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT c.id FROM public.companies c
   WHERE auth.uid() IS NOT NULL
     AND (c.user_id = auth.uid()
          OR c.user_id = (SELECT p.super_user_id FROM public.profiles p WHERE p.id=auth.uid()))
   ORDER BY (c.user_id = auth.uid()) DESC LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.company_has_feature(p_feature_key text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.companies c
    JOIN public.whatsapp_subscriptions s ON (s.company_id=c.id OR s.user_id=c.user_id)
    JOIN public.subscription_plans sp ON sp.key=s.plan
    JOIN public.plan_features pf ON pf.plan_id=sp.id AND pf.enabled
   WHERE c.id=public.current_company_id() AND s.status='active'
     AND s.start_date<=now() AND s.end_date>now() AND pf.feature_key=p_feature_key);
$$;

-- دوال trigger موجودة فقط ليجد الترحيل ما يسحب صلاحيته منه
CREATE OR REPLACE FUNCTION public.notify_admin_on_new_subscription() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RETURN new; END; $$;
CREATE OR REPLACE FUNCTION public.log_customer_sie_access_change() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RETURN new; END; $$;

-- ==== النسخ القديمة (الحالة التي كانت في الإنتاج قبل 024) ====

CREATE OR REPLACE FUNCTION public.is_chat_engine_staff() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (SELECT 1 FROM profiles WHERE profiles.id=auth.uid()
    AND profiles.role IN ('admin','support','super_user'));
$$;

CREATE OR REPLACE FUNCTION public.guard_profile_role_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF new.role IS NOT DISTINCT FROM old.role THEN RETURN new; END IF;
  IF auth.uid() IS NULL THEN RETURN new; END IF;
  IF public.is_main_admin() THEN RETURN new; END IF;
  IF auth.uid() = new.id THEN
    RAISE EXCEPTION 'لا يمكنك تغيير صلاحية حسابك بنفسك' USING ERRCODE='42501'; END IF;
  RETURN new;   -- ← الثغرة C2: «super_user يدير تابعًا» يمر
END; $$;

CREATE OR REPLACE FUNCTION public.check_super_user_creation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN new; END IF;
  IF new.role='super_user' AND NOT public.is_main_admin() THEN
    RAISE EXCEPTION 'فقط support@mad3oom.online يمكنه إنشاء أو تعيين حسابات سوبر يوزر'; END IF;
  IF TG_OP='UPDATE' AND old.super_user_id IS DISTINCT FROM new.super_user_id
     AND NOT public.is_main_admin() THEN
    RAISE EXCEPTION 'لا يمكن تغيير تبعية المستخدم إلا بواسطة الإدارة العليا'; END IF;
  RETURN new;
END; $$;

CREATE OR REPLACE FUNCTION public.recompute_user_access(p_user_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_features text[]; v_whatsapp boolean; v_support boolean; v_role text; v_note text := null;
BEGIN
  IF p_user_id IS NULL THEN RETURN null; END IF;
  v_features := public.owned_feature_keys(p_user_id);
  v_whatsapp := 'whatsapp_sender' = ANY(v_features);
  v_support  := 'support_tickets' = ANY(v_features);
  UPDATE public.profiles SET whatsapp_enabled=v_whatsapp
   WHERE id=p_user_id AND whatsapp_enabled IS DISTINCT FROM v_whatsapp;
  SELECT role INTO v_role FROM public.profiles WHERE id=p_user_id;
  IF v_role='super_user' AND NOT v_support THEN
    UPDATE public.profiles SET role='user' WHERE id=p_user_id; v_role:='user';
  ELSIF v_role='user' AND v_support THEN
    BEGIN UPDATE public.profiles SET role='super_user' WHERE id=p_user_id; v_role:='super_user';
    EXCEPTION WHEN OTHERS THEN v_note:='تعذّرت الترقية'; END;   -- ← H4: فشل مبتلَع
  END IF;
  RETURN jsonb_build_object('features',to_jsonb(v_features),'whatsapp_enabled',v_whatsapp,
    'role',v_role,'note',v_note);
END; $$;

CREATE OR REPLACE FUNCTION public.expire_stale_subscriptions() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  UPDATE public.whatsapp_subscriptions SET status='expired' WHERE status='active' AND end_date<now();
  -- ← H3: أسماء باقات مثبَّتة نصًّا بدل مفاتيح الخدمات
  UPDATE public.profiles p SET whatsapp_enabled=false
   WHERE p.whatsapp_enabled AND NOT EXISTS (
     SELECT 1 FROM public.whatsapp_subscriptions s WHERE s.user_id=p.id
       AND s.status='active' AND s.plan IN ('whatsapp','bundle') AND s.end_date>now());
END; $$;

CREATE OR REPLACE FUNCTION public.company_members() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_company_id uuid; v_owner_id uuid; v_members jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RETURN null; END IF;
  v_company_id := public.current_company_id();
  IF v_company_id IS NULL THEN RETURN null; END IF;
  SELECT user_id INTO v_owner_id FROM public.companies WHERE id=v_company_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.id,'email',m.email)),'[]'::jsonb)
    INTO v_members FROM public.profiles m
   WHERE m.id=v_owner_id OR m.super_user_id=v_owner_id;
  RETURN jsonb_build_object('company_id',v_company_id,'is_owner',(v_owner_id=auth.uid()),
    'can_manage',(v_owner_id=auth.uid() AND public.company_has_feature('sub_users')),'members',v_members);
END; $$;

CREATE TRIGGER guard_profile_role_change BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_role_change();
CREATE TRIGGER tr_check_super_user_creation BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.check_super_user_creation();

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_select_policy ON public.profiles FOR SELECT
  USING ((auth.uid()=id) OR public.is_main_admin() OR (super_user_id=auth.uid()));
CREATE POLICY "Support can view all profiles" ON public.profiles FOR SELECT
  USING (public.is_admin() OR auth.uid()=id);
CREATE POLICY profiles_update_policy ON public.profiles FOR UPDATE
  USING ((auth.uid()=id) OR public.is_main_admin() OR (super_user_id=auth.uid()));
CREATE POLICY "Support can update whatsapp_enabled" ON public.profiles FOR UPDATE
  USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Company members can view their company" ON public.companies FOR SELECT
  USING (id = public.current_company_id());
CREATE POLICY "Users can view their own company" ON public.companies FOR SELECT
  USING (user_id = auth.uid());
CREATE POLICY "Staff can create notifications for any user" ON public.notifications FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=auth.uid()
    AND (p.role = ANY(ARRAY['admin','support','super_user']) OR p.email='support@mad3oom.online')));

GRANT USAGE ON SCHEMA public TO authenticated, anon;
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;

INSERT INTO public.subscription_plans (key,name,name_ar) VALUES
  ('support','Support','الدعم الفني'),('whatsapp','WhatsApp','واتساب'),('bundle','Bundle','الباقة الشاملة');
INSERT INTO public.feature_flags (key,name_ar) VALUES
  ('api_tokens','مفاتيح API'),('whatsapp_sender','إرسال واتساب'),('support_tickets','تذاكر'),
  ('priority_support','أولوية'),('sub_users','مستخدمون فرعيون');
INSERT INTO public.plan_features (plan_id, feature_key)
SELECT sp.id, f.k FROM public.subscription_plans sp JOIN (VALUES
  ('whatsapp','whatsapp_sender'),
  ('support','support_tickets'),('support','priority_support'),('support','sub_users'),('support','api_tokens'),
  ('bundle','whatsapp_sender'),('bundle','support_tickets'),('bundle','priority_support'),
  ('bundle','sub_users'),('bundle','api_tokens')
) AS f(p,k) ON f.p=sp.key;

-- الشخصيات: مالك شركة A، عضو فيها، مالك شركة B، أدمن عادي، الأدمن الرئيسي
INSERT INTO public.profiles (id,email,role,super_user_id) VALUES
  ('a0000000-0000-4000-8000-000000000001','ownerA@test.local','super_user',NULL),
  ('a0000000-0000-4000-8000-000000000002','memberA@test.local','user','a0000000-0000-4000-8000-000000000001'),
  ('b0000000-0000-4000-8000-000000000001','ownerB@test.local','super_user',NULL),
  ('b0000000-0000-4000-8000-000000000002','memberB@test.local','user','b0000000-0000-4000-8000-000000000001'),
  ('c0000000-0000-4000-8000-000000000001','plain@test.local','user',NULL),
  ('90000000-0000-4000-8000-000000000001','admin@test.local','admin',NULL),
  ('90000000-0000-4000-8000-000000000002','support@mad3oom.online','admin',NULL);

INSERT INTO public.companies (id,user_id,company_name) VALUES
  ('c1c1c1c1-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','شركة أ'),
  ('c2c2c2c2-0000-4000-8000-000000000002','b0000000-0000-4000-8000-000000000001','شركة ب');

-- كلا المالكين مشتركان في الباقة الشاملة (تمنح sub_users)
INSERT INTO public.whatsapp_subscriptions (user_id,plan,status,billing_cycle,start_date,end_date) VALUES
  ('a0000000-0000-4000-8000-000000000001','bundle','active','monthly',now(),now()+interval '30 days'),
  ('b0000000-0000-4000-8000-000000000001','bundle','active','monthly',now(),now()+interval '30 days');

\echo ''
\echo '=== 0) ضابط سلبي: C2 تعمل فعلًا قبل الترحيل ==='
SET ROLE authenticated;
SET request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000001';
DO $$ BEGIN
  UPDATE public.profiles SET role='admin' WHERE id='a0000000-0000-4000-8000-000000000002';
  IF (SELECT role FROM public.profiles WHERE id='a0000000-0000-4000-8000-000000000002') <> 'admin' THEN
    RAISE EXCEPTION 'FAIL 0: الاستغلال لم ينجح — الاختبار بعده لا يثبت شيئًا'; END IF;
  RAISE NOTICE 'PASS 0: C2 مؤكدة قبل الترحيل (صاحب الشركة رقّى عضوه إلى admin)';
END $$;
RESET ROLE;
RESET request.jwt.claim.sub;
UPDATE public.profiles SET role='user' WHERE id='a0000000-0000-4000-8000-000000000002';

\echo ''
\echo '--- applying migrations/024 ---'
\i migrations/024_role_authority_separation.sql
\echo '--- migration applied ---'
\echo ''

\echo '=== A) C2 — صاحب الشركة لا يرقّي عضوه ==='
SET ROLE authenticated;
SET request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000001';
DO $$ BEGIN
  BEGIN
    UPDATE public.profiles SET role='admin' WHERE id='a0000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'FAIL A1: صاحب الشركة رقّى عضوه إلى admin';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'FAIL A1%' THEN RAISE; END IF; END;
  RAISE NOTICE 'PASS A1: ترقية العضو إلى admin مرفوضة';

  BEGIN
    UPDATE public.profiles SET role='support' WHERE id='a0000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'FAIL A2: صاحب الشركة منح رتبة support';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'FAIL A2%' THEN RAISE; END IF; END;
  RAISE NOTICE 'PASS A2: منح أي رتبة طاقم مرفوض';

  -- لكنه ما زال يعدّل بيانات عضوه العادية (المسار الشرعي لم يُكسر)
  UPDATE public.profiles SET full_name='اسم محدّث' WHERE id='a0000000-0000-4000-8000-000000000002';
  IF (SELECT full_name FROM public.profiles WHERE id='a0000000-0000-4000-8000-000000000002') <> 'اسم محدّث' THEN
    RAISE EXCEPTION 'FAIL A3: صاحب الشركة لم يعد يستطيع تعديل بيانات عضوه'; END IF;
  RAISE NOTICE 'PASS A3: تعديل بيانات العضو العادية ما زال متاحًا للمالك';
END $$;

\echo ''
\echo '=== B) لا أحد يغيّر رتبة نفسه ==='
DO $$ BEGIN
  BEGIN
    UPDATE public.profiles SET role='admin' WHERE id=auth.uid();
    RAISE EXCEPTION 'FAIL B: تغيير رتبة النفس نجح';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'FAIL B%' THEN RAISE; END IF; END;
  RAISE NOTICE 'PASS B: تغيير رتبة النفس مرفوض';
END $$;

\echo ''
\echo '=== C) M2 — أدمن عادي لا يصنع أدمن، والإدارة العليا تستطيع ==='
SET request.jwt.claim.sub = '90000000-0000-4000-8000-000000000001';
DO $$ BEGIN
  BEGIN
    UPDATE public.profiles SET role='admin' WHERE id='c0000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'FAIL C1: أدمن عادي صنع أدمن آخر';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'FAIL C1%' THEN RAISE; END IF; END;
  RAISE NOTICE 'PASS C1: أدمن عادي لا يمنح رتبة admin';

  -- لكن إدارة الرتب غير ذات السلطة تظل متاحة له (المسار الإداري لم يُكسر)
  UPDATE public.profiles SET role='user' WHERE id='c0000000-0000-4000-8000-000000000001';
  RAISE NOTICE 'PASS C2: أدمن عادي ما زال يدير الرتب غير ذات السلطة';
END $$;

SET request.jwt.claim.sub = '90000000-0000-4000-8000-000000000002';
DO $$ BEGIN
  UPDATE public.profiles SET role='admin' WHERE id='c0000000-0000-4000-8000-000000000001';
  IF (SELECT role FROM public.profiles WHERE id='c0000000-0000-4000-8000-000000000001') <> 'admin' THEN
    RAISE EXCEPTION 'FAIL C3: الإدارة العليا لم تستطع منح admin'; END IF;
  RAISE NOTICE 'PASS C3: الإدارة العليا وحدها تمنح الرتب ذات السلطة';
  UPDATE public.profiles SET role='user' WHERE id='c0000000-0000-4000-8000-000000000001';
END $$;
RESET ROLE;
RESET request.jwt.claim.sub;

\echo ''
\echo '=== D) H4 — الاشتراك يمنح امتيازات ولا يمنح رتبة ==='
DO $$
DECLARE r jsonb; v_role_before text; v_role_after text;
BEGIN
  SELECT role INTO v_role_before FROM public.profiles WHERE id='c0000000-0000-4000-8000-000000000001';
  INSERT INTO public.whatsapp_subscriptions (user_id,plan,status,billing_cycle,start_date,end_date)
  VALUES ('c0000000-0000-4000-8000-000000000001','support','active','monthly',now(),now()+interval '30 days');

  r := public.recompute_user_access('c0000000-0000-4000-8000-000000000001');
  SELECT role INTO v_role_after FROM public.profiles WHERE id='c0000000-0000-4000-8000-000000000001';

  IF v_role_after IS DISTINCT FROM v_role_before THEN
    RAISE EXCEPTION 'FAIL D1: شراء الدعم غيّر الرتبة % ← %', v_role_before, v_role_after; END IF;
  RAISE NOTICE 'PASS D1: شراء باقة الدعم لم يمنح أي رتبة';

  IF NOT ('support_tickets' = ANY(public.owned_feature_keys('c0000000-0000-4000-8000-000000000001'))) THEN
    RAISE EXCEPTION 'FAIL D2: الاشتراك لم يمنح الامتياز'; END IF;
  RAISE NOTICE 'PASS D2: نفس الاشتراك منح الامتياز (الفصل تحقق)';

  IF r ? 'note' AND r->>'note' IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL D3: ما زال هناك فشل مبتلَع في مسار الرتبة'; END IF;
  RAISE NOTICE 'PASS D3: لا فشل صامت — الدالة لم تعد تحاول تغيير الرتبة أصلًا';
END $$;

\echo ''
\echo '=== E) H3 — الوظيفة الدورية تقرر بالخدمات لا بأسماء الباقات ==='
DO $$
DECLARE v_plan_id uuid;
BEGIN
  -- باقة رابعة تمنح whatsapp_sender باسم مختلف تمامًا
  INSERT INTO public.subscription_plans (key,name,name_ar) VALUES ('starter','Starter','المبتدئة')
    RETURNING id INTO v_plan_id;
  INSERT INTO public.plan_features (plan_id,feature_key) VALUES (v_plan_id,'whatsapp_sender');
  INSERT INTO public.whatsapp_subscriptions (user_id,plan,status,billing_cycle,start_date,end_date)
  VALUES ('c0000000-0000-4000-8000-000000000001','starter','active','monthly',now(),now()+interval '30 days');

  PERFORM public.recompute_user_access('c0000000-0000-4000-8000-000000000001');
  IF NOT (SELECT whatsapp_enabled FROM public.profiles WHERE id='c0000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'FAIL E1: الباقة الجديدة لم تمنح whatsapp_enabled'; END IF;

  PERFORM public.expire_stale_subscriptions();
  IF NOT (SELECT whatsapp_enabled FROM public.profiles WHERE id='c0000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'FAIL E2: الوظيفة الدورية سحبت الوصول من مشترك في باقة تمنحه (أسماء مثبَّتة)'; END IF;
  RAISE NOTICE 'PASS E: الوظيفة الدورية تتبع مفاتيح الخدمات لا أسماء الباقات';
END $$;

\echo ''
\echo '=== F) الوظيفة الدورية لا تلمس الرتب ==='
DO $$
DECLARE v_before text; v_after text;
BEGIN
  SELECT role INTO v_before FROM public.profiles WHERE id='a0000000-0000-4000-8000-000000000001';
  UPDATE public.whatsapp_subscriptions SET end_date=now()-interval '1 day'
   WHERE user_id='a0000000-0000-4000-8000-000000000001';
  PERFORM public.expire_stale_subscriptions();
  SELECT role INTO v_after FROM public.profiles WHERE id='a0000000-0000-4000-8000-000000000001';
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'FAIL F: الوظيفة الدورية غيّرت الرتبة % ← %', v_before, v_after; END IF;
  RAISE NOTICE 'PASS F: انتهاء الاشتراك يسحب الامتياز ولا يمس الرتبة';

  -- إعادة الاشتراك لبقية الاختبارات
  UPDATE public.whatsapp_subscriptions SET status='active', end_date=now()+interval '30 days'
   WHERE user_id='a0000000-0000-4000-8000-000000000001';
END $$;

\echo ''
\echo '=== G) M3 — super_user لم تعد رتبة طاقم ==='
SET ROLE authenticated;
SET request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000001';
DO $$ BEGIN
  IF public.is_chat_engine_staff() THEN
    RAISE EXCEPTION 'FAIL G1: super_user ما زال يُعدّ طاقمًا'; END IF;
  RAISE NOTICE 'PASS G1: super_user ليست رتبة طاقم';

  BEGIN
    INSERT INTO public.notifications (user_id,title,message)
    VALUES ('c0000000-0000-4000-8000-000000000001','تصيّد','رسالة من غير طاقم');
    RAISE EXCEPTION 'FAIL G2: super_user أرسل إشعارًا لمستخدم آخر';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'FAIL G2%' THEN RAISE; END IF; END;
  RAISE NOTICE 'PASS G2: إرسال إشعار لأي مستخدم لم يعد متاحًا لـsuper_user';
END $$;

\echo ''
\echo '=== H) إدارة الأعضاء: ملكية + امتياز، لا رتبة ==='
DO $$
DECLARE m jsonb;
BEGIN
  IF NOT public.can_manage_company_members() THEN
    RAISE EXCEPTION 'FAIL H1: مالك الشركة صاحب الاشتراك لا يستطيع الإدارة'; END IF;
  m := public.company_members();
  IF NOT (m->>'can_manage')::boolean THEN RAISE EXCEPTION 'FAIL H2: can_manage خاطئ'; END IF;
  IF jsonb_array_length(m->'members') <> 2 THEN
    RAISE EXCEPTION 'FAIL H3: عدد الأعضاء % وليس 2', jsonb_array_length(m->'members'); END IF;
  RAISE NOTICE 'PASS H: المالك صاحب امتياز sub_users يدير أعضاءه';
END $$;

SET request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';
DO $$
DECLARE m jsonb;
BEGIN
  IF public.can_manage_company_members() THEN
    RAISE EXCEPTION 'FAIL H4: العضو يستطيع إدارة الأعضاء'; END IF;
  m := public.company_members();
  IF (m->>'can_manage')::boolean THEN RAISE EXCEPTION 'FAIL H5: can_manage صحيح لعضو'; END IF;
  IF (m->>'is_owner')::boolean THEN RAISE EXCEPTION 'FAIL H6: العضو يظهر كمالك'; END IF;
  RAISE NOTICE 'PASS H4: العضو يرى شركته ولا يديرها';
END $$;

\echo ''
\echo '=== I) عزل الشركات: العضو لا يرى شركة أخرى ==='
DO $$
DECLARE m jsonb;
BEGIN
  IF (SELECT count(*) FROM public.companies) <> 1 THEN
    RAISE EXCEPTION 'FAIL I1: العضو يرى % شركة', (SELECT count(*) FROM public.companies); END IF;
  m := public.company_members();
  IF (m->>'company_id') <> 'c1c1c1c1-0000-4000-8000-000000000001' THEN
    RAISE EXCEPTION 'FAIL I2: العضو ربط بشركة خاطئة'; END IF;
  RAISE NOTICE 'PASS I: العضو يرى شركته فقط';
END $$;

\echo ''
\echo '=== J) إزالة عضو: قطع العلاقة لا حذف الحساب ==='
SET request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000001';
DO $$
DECLARE r jsonb;
BEGIN
  r := public.remove_company_member('a0000000-0000-4000-8000-000000000002');
  IF NOT (r->>'removed')::boolean THEN RAISE EXCEPTION 'FAIL J1: الإزالة فشلت'; END IF;
  RAISE NOTICE 'PASS J1: المالك أزال عضوه';
END $$;
RESET ROLE;
RESET request.jwt.claim.sub;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id='a0000000-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION 'FAIL J2: الحساب حُذف بدل قطع العلاقة'; END IF;
  IF (SELECT super_user_id FROM public.profiles WHERE id='a0000000-0000-4000-8000-000000000002') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL J3: العلاقة لم تُقطع'; END IF;
  RAISE NOTICE 'PASS J2: الحساب باقٍ والعلاقة مقطوعة';
END $$;
SET ROLE authenticated;
SET request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';
DO $$ BEGIN
  IF public.current_company_id() IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL J4: العضو المُزال ما زال مرتبطًا بالشركة'; END IF;
  IF public.company_members() IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL J5: العضو المُزال ما زال يرى لوحة الشركة'; END IF;
  RAISE NOTICE 'PASS J4: العضو المُزال فقد وصوله فورًا';
END $$;

\echo ''
\echo '=== K) IDOR: مالك A لا يزيل عضو B، والعضو لا يزيل أحدًا ==='
SET request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000001';
DO $$ BEGIN
  BEGIN
    PERFORM public.remove_company_member('b0000000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'FAIL K1: مالك A أزال عضوًا من شركة B';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'FAIL K1%' THEN RAISE; END IF; END;
  RAISE NOTICE 'PASS K1: إزالة عضو من شركة أخرى مرفوضة';

  BEGIN
    PERFORM public.remove_company_member('a0000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'FAIL K2: المالك أزال نفسه';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'FAIL K2%' THEN RAISE; END IF; END;
  RAISE NOTICE 'PASS K2: لا يمكن إزالة مالك الشركة';
END $$;

SET request.jwt.claim.sub = 'b0000000-0000-4000-8000-000000000002';
DO $$ BEGIN
  BEGIN
    PERFORM public.remove_company_member('b0000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'FAIL K3: عضو أزال مالك شركته';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'FAIL K3%' THEN RAISE; END IF; END;
  RAISE NOTICE 'PASS K3: العضو لا يزيل أحدًا';

  BEGIN
    UPDATE public.profiles SET super_user_id='a0000000-0000-4000-8000-000000000001' WHERE id=auth.uid();
    RAISE EXCEPTION 'FAIL K4: العضو نقل نفسه إلى شركة أخرى';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'FAIL K4%' THEN RAISE; END IF; END;
  RAISE NOTICE 'PASS K4: العضو لا ينقل نفسه بين الشركات';
END $$;

\echo ''
\echo '=== L) المالك بلا امتياز sub_users لا يدير الأعضاء ==='
RESET ROLE;
RESET request.jwt.claim.sub;
UPDATE public.whatsapp_subscriptions SET status='expired'
 WHERE user_id='b0000000-0000-4000-8000-000000000001';
SET ROLE authenticated;
SET request.jwt.claim.sub = 'b0000000-0000-4000-8000-000000000001';
DO $$ BEGIN
  IF public.can_manage_company_members() THEN
    RAISE EXCEPTION 'FAIL L1: مالك بلا اشتراك فعّال يدير الأعضاء'; END IF;
  BEGIN
    PERFORM public.remove_company_member('b0000000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'FAIL L2: نُفِّذت الإزالة بلا امتياز';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'FAIL L2%' THEN RAISE; END IF; END;
  RAISE NOTICE 'PASS L: انتهاء الاشتراك يسحب حق إدارة الأعضاء فورًا';
END $$;
RESET ROLE;
RESET request.jwt.claim.sub;

\echo ''
\echo '=== M) M1 — امتيازات حساب آخر لا تُقرأ بمعرّف من العميل ==='
SET ROLE authenticated;
SET request.jwt.claim.sub = 'c0000000-0000-4000-8000-000000000001';
DO $$ BEGIN
  BEGIN
    PERFORM public.owned_feature_keys('a0000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'FAIL M1: قرأ امتيازات حساب آخر';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'FAIL M1%' THEN RAISE; END IF; END;
  RAISE NOTICE 'PASS M1: قراءة امتيازات حساب آخر مرفوضة';

  IF array_length(public.owned_feature_keys(),1) IS NULL THEN
    RAISE EXCEPTION 'FAIL M2: لم يعد يقرأ امتيازات نفسه'; END IF;
  RAISE NOTICE 'PASS M2: قراءة امتيازات النفس ما زالت تعمل';
END $$;
SET request.jwt.claim.sub = '90000000-0000-4000-8000-000000000001';
DO $$
DECLARE v_rows int;
BEGIN
  PERFORM public.owned_feature_keys('a0000000-0000-4000-8000-000000000001');
  RAISE NOTICE 'PASS M3: الأدمن ما زال يقرأ امتيازات أي حساب';

  -- شكل النداء الحقيقي في admin_list_subscriptions: تفريع owned_feature_keys
  -- على user_id **لكل صف**، أي معرّفات أجنبية بالجملة. لو كسر الحارس هذا
  -- المسار لظهرت شاشة اشتراكات الإدارة فارغة تمامًا.
  SELECT count(*) INTO v_rows FROM (
    SELECT public.owned_feature_keys(s.user_id) FROM public.whatsapp_subscriptions s
  ) q;
  IF v_rows = 0 THEN RAISE EXCEPTION 'FAIL M4: لا صفوف — الإعداد خاطئ'; END IF;
  RAISE NOTICE 'PASS M4: تفريع الأدمن على % صفًّا يعمل (شاشة الإدارة سليمة)', v_rows;
END $$;
RESET ROLE;
RESET request.jwt.claim.sub;

\echo ''
\echo '=== N) إعادة تطبيق الترحيل آمنة ==='
\i migrations/024_role_authority_separation.sql
DO $$ BEGIN RAISE NOTICE 'PASS N: إعادة تطبيق 024 لم تفشل'; END $$;

\echo ''
\echo 'ALL ROLE AUTHORITY SEPARATION TESTS PASSED'
