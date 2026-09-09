-- اختبار تنفيذي لـ migrations/027 — إغلاق مسارات السلطة القديمة.
--
-- كل قسم هنا يتبع نفس الشكل: نُثبت الثغرة أولًا على تعريفات الإنتاج كما هي
-- (ضابط سلبي — لو لم تُثبَت، فالاختبار الذي يليها لا يعني شيئًا)، ثم نطبّق
-- الترحيل، ثم نعيد **نفس المحاولة حرفيًا** ونتوقع رفضها.
--
-- التعريفات أدناه منسوخة من الإنتاج (pg_get_functiondef) لا مُعاد صياغتها،
-- وإلا لكان الاختبار يفحص نسختي أنا لا ما يعمل فعلًا.
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
END $$;

CREATE TABLE auth.users (id uuid PRIMARY KEY, email text UNIQUE);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.role', true), '');
$$;
GRANT USAGE ON SCHEMA auth, storage TO authenticated, anon;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO authenticated, anon;
GRANT SELECT ON auth.users TO authenticated, anon;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, email text UNIQUE, role text NOT NULL DEFAULT 'user',
  super_user_id uuid, points int DEFAULT 0,
  whatsapp_enabled boolean DEFAULT false, is_verified boolean DEFAULT false,
  ban_status text, ban_until timestamptz, ban_reason text,
  is_locked boolean DEFAULT false, failed_login_attempts int DEFAULT 0,
  custom_role_id uuid, pi_uid text UNIQUE, full_name text,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.companies (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE, company_name text);
CREATE TABLE public.tickets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, title text);
CREATE TABLE public.notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, title text, message text, type text, link text);
CREATE TABLE public.user_wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE,
  total_points int DEFAULT 0, available_points int DEFAULT 0, pending_points int DEFAULT 0,
  membership_level text DEFAULT 'عضو جديد', is_pro boolean DEFAULT false, is_frozen boolean DEFAULT false
);
CREATE TABLE public.whatsapp_wallet_topup_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, ticket_id uuid,
  amount numeric, payment_method text, status text DEFAULT 'pending',
  rejection_reason text, reviewed_by uuid, reviewed_at timestamptz
);
CREATE TABLE public.api_keys              (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, secret text);
CREATE TABLE public.bot_api_keys          (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, secret text);
CREATE TABLE public.bot_settings          (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, cfg text);
CREATE TABLE public.integrations          (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, encrypted_access_token text);
CREATE TABLE public.mcp_servers           (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
CREATE TABLE public.mcp_server_connections(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), server_id uuid);
CREATE TABLE public.landing_leads         (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, phone text);
CREATE TABLE public.wf_leads              (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, phone text);

CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid
);
CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE AS $sf$
DECLARE _parts text[];
BEGIN
  -- منسوخة حرفيًا من الإنتاج (pg_get_functiondef). الفرق الذي كان في النسخة
  -- المبسّطة: اسم بلا شرطة مائلة يعيد مصفوفة فارغة هنا، فـ[1] تساوي NULL —
  -- بينما النسخة المبسّطة كانت تعيد الاسم كله. سياسة تعتمد على ذلك كانت
  -- ستمرّ في الاختبار وتفشل على الإنتاج.
  SELECT string_to_array(name, '/') INTO _parts;
  RETURN _parts[1 : array_length(_parts,1) - 1];
END $sf$;
GRANT EXECUTE ON FUNCTION storage.foldername(text) TO authenticated, anon;

GRANT USAGE ON SCHEMA public TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public  TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects              TO authenticated, anon;

-- ── تعريفات الإنتاج، حرفيًا ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_main_admin() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN RETURN COALESCE((SELECT email FROM auth.users WHERE id = auth.uid())
  IN ('support@mad3oom.online','info@mad3oom.online'), false); END; $$;

-- الشكل المعيب: يقرأ profiles.email
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN RETURN EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid()
  AND (role = 'admin' OR email IN ('support@mad3oom.online','info@mad3oom.online'))); END; $$;
CREATE OR REPLACE FUNCTION public.is_support_user() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN RETURN EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid()
  AND (email = 'support@mad3oom.online' OR role = 'admin')); END; $$;
-- نسخة 024، وفيها نفس ضعف N9 المنقول
CREATE OR REPLACE FUNCTION public.is_platform_staff() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid()
    AND (role IN ('admin','support') OR email IN ('support@mad3oom.online','info@mad3oom.online')));
$$;
CREATE OR REPLACE FUNCTION public.is_admin_user(p_user_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_email text; v_role text; BEGIN
  IF p_user_id IS NULL THEN RETURN false; END IF;
  SELECT email INTO v_email FROM auth.users WHERE id = p_user_id;
  SELECT role  INTO v_role  FROM public.profiles WHERE id = p_user_id;
  RETURN COALESCE(v_email IN ('support@mad3oom.online','info@mad3oom.online'), false)
      OR COALESCE(v_role = 'admin', false); END; $$;
CREATE OR REPLACE FUNCTION public.is_landing_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','super_user'));
$$;
CREATE OR REPLACE FUNCTION public.wf_is_staff() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid()
    AND role = ANY (ARRAY['admin','support','super_user']));
$$;
CREATE OR REPLACE FUNCTION public.has_chatbot_entitlement(p_user_id uuid DEFAULT auth.uid()) RETURNS boolean
LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id
    AND (whatsapp_enabled = true OR role IN ('super_user','admin')));
$$;
GRANT EXECUTE ON FUNCTION public.is_admin(), public.is_support_user(), public.is_platform_staff(),
  public.is_main_admin(), public.is_landing_admin(), public.wf_is_staff(),
  public.has_chatbot_entitlement(uuid), public.is_admin_user(uuid) TO authenticated, anon;

-- ── سياسات الإنتاج، حرفيًا ──────────────────────────────────────────────────
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_select_policy ON public.profiles FOR SELECT
  USING ((auth.uid() = id) OR is_main_admin() OR (super_user_id = auth.uid()));
CREATE POLICY "Support can view all profiles" ON public.profiles FOR SELECT
  USING (is_support_user() OR (auth.uid() = id));
CREATE POLICY profiles_update_policy ON public.profiles FOR UPDATE
  USING ((auth.uid() = id) OR is_main_admin() OR (super_user_id = auth.uid()));
CREATE POLICY user_insert_self ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);

ALTER TABLE public.user_wallets ENABLE ROW LEVEL SECURITY;
CREATE POLICY wallet_insert_self ON public.user_wallets FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY wallet_select_all  ON public.user_wallets FOR SELECT USING (auth.uid() = user_id OR is_admin());

ALTER TABLE public.whatsapp_wallet_topup_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can create their own wallet topup requests" ON public.whatsapp_wallet_topup_requests
  FOR INSERT WITH CHECK ((auth.uid() = user_id) AND ((ticket_id IS NULL) OR (EXISTS (
    SELECT 1 FROM tickets WHERE tickets.id = whatsapp_wallet_topup_requests.ticket_id AND tickets.user_id = auth.uid()))));
CREATE POLICY "Users can view their own wallet topup requests" ON public.whatsapp_wallet_topup_requests
  FOR SELECT USING (auth.uid() = user_id);

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view all api_keys" ON public.api_keys FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid()
    AND (p.role = 'admin' OR p.email = 'support@mad3oom.online')));
ALTER TABLE public.bot_api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view all bot_api_keys" ON public.bot_api_keys FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid()
    AND (p.role = 'admin' OR p.email = 'support@mad3oom.online')));
ALTER TABLE public.bot_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view all bot_settings" ON public.bot_settings FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid()
    AND (p.role = 'admin' OR p.email = 'support@mad3oom.online')));
ALTER TABLE public.integrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view all integrations" ON public.integrations FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid()
    AND (p.role = 'admin' OR p.email = 'support@mad3oom.online')));
CREATE POLICY "Support can view all integrations" ON public.integrations FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid()
    AND (p.role = 'admin' OR p.email = 'support@mad3oom.online')));
ALTER TABLE public.mcp_servers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can manage mcp_servers" ON public.mcp_servers FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid()
    AND (p.role = 'admin' OR p.email = 'support@mad3oom.online')));
ALTER TABLE public.mcp_server_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can manage mcp_server_connections" ON public.mcp_server_connections FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid()
    AND (p.role = 'admin' OR p.email = 'support@mad3oom.online')));

ALTER TABLE public.landing_leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY landing_leads_admin_all ON public.landing_leads FOR ALL USING (is_landing_admin());
ALTER TABLE public.wf_leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY wf_leads_select ON public.wf_leads FOR SELECT USING (wf_is_staff());

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow authenticated users to upload" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'chat-attachments');
CREATE POLICY "Allow authenticated uploads" ON storage.objects FOR INSERT
  WITH CHECK ((bucket_id = 'tickets') AND (auth.role() = 'authenticated'));
CREATE POLICY "Allow Authenticated Insert" ON storage.objects FOR INSERT
  WITH CHECK ((bucket_id = 'avatars') AND (auth.role() = 'authenticated'));

-- ── بيانات ─────────────────────────────────────────────────────────────────
INSERT INTO auth.users(id,email) VALUES
  ('11111111-1111-4111-8111-111111111111','support@mad3oom.online'),
  ('22222222-2222-4222-8222-222222222222','victim@example.test'),
  ('33333333-3333-4333-8333-333333333333','attacker@example.test'),
  ('44444444-4444-4444-8444-444444444444','owner@example.test');
INSERT INTO public.profiles(id,email,role) VALUES
  ('11111111-1111-4111-8111-111111111111','support@mad3oom.online','admin'),
  ('22222222-2222-4222-8222-222222222222','victim@example.test','user'),
  ('33333333-3333-4333-8333-333333333333','attacker@example.test','user'),
  ('44444444-4444-4444-8444-444444444444','owner@example.test','super_user');
-- المهاجم محظور ومقفول فعلًا: بدون ذلك «فك الحظر» لا يغيّر صفًّا فلا يثبت ثغرة
UPDATE public.profiles SET ban_status='banned', ban_reason='إساءة', is_locked=true, failed_login_attempts=5
 WHERE id='33333333-3333-4333-8333-333333333333';
INSERT INTO public.companies(user_id,company_name) VALUES ('44444444-4444-4444-8444-444444444444','مدعوم');
INSERT INTO public.tickets(id,user_id,title) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001','22222222-2222-4222-8222-222222222222','تذكرة الضحية');
INSERT INTO public.api_keys(user_id,secret) VALUES ('22222222-2222-4222-8222-222222222222','SECRET');
INSERT INTO public.integrations(user_id,encrypted_access_token) VALUES ('22222222-2222-4222-8222-222222222222','ENC');
INSERT INTO public.landing_leads(name,phone) VALUES ('عميل محتمل','0100');
INSERT INTO public.wf_leads(name,phone) VALUES ('عميل محتمل','0100');
INSERT INTO public.user_wallets(user_id) VALUES ('22222222-2222-4222-8222-222222222222');
-- المهاجم بلا صف محفظة عمدًا: هي الحالة القابلة للاستغلال (6 حسابات كذلك في الإنتاج)

-- ── أداة المحاولة: تُرجع ALLOWED/DENIED بدل أن ترمي ────────────────────────
CREATE OR REPLACE FUNCTION public.attempt(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE n int; BEGIN
  EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT;
  RETURN CASE WHEN n = 0 THEN 'DENIED' ELSE 'ALLOWED' END;
EXCEPTION WHEN others THEN RETURN 'DENIED'; END $$;
GRANT EXECUTE ON FUNCTION public.attempt(text) TO authenticated, anon;

CREATE OR REPLACE FUNCTION public.reads(p_sql text) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE n int; BEGIN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') z' INTO n; RETURN n;
EXCEPTION WHEN others THEN RETURN -1; END $$;
GRANT EXECUTE ON FUNCTION public.reads(text) TO authenticated, anon;

CREATE TABLE public.results(phase text, id text, outcome text);
GRANT INSERT, SELECT ON public.results TO authenticated, anon;

-- ============================================================================
-- المرحلة أ — الضابط السلبي: الثغرات تعمل قبل الترحيل
-- ============================================================================
SET request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';
SET request.jwt.claim.role = 'authenticated';
SET ROLE authenticated;

INSERT INTO public.results VALUES
 ('before','A1 email self-write',    public.attempt($q$UPDATE public.profiles SET email='new@example.test' WHERE id='33333333-3333-4333-8333-333333333333'$q$)),
 ('before','A2 whatsapp_enabled',    public.attempt($q$UPDATE public.profiles SET whatsapp_enabled=true WHERE id='33333333-3333-4333-8333-333333333333'$q$)),
 ('before','A3 is_verified',         public.attempt($q$UPDATE public.profiles SET is_verified=true WHERE id='33333333-3333-4333-8333-333333333333'$q$)),
 ('before','A4 unban self',          public.attempt($q$UPDATE public.profiles SET ban_status=null,is_locked=false,failed_login_attempts=0 WHERE id='33333333-3333-4333-8333-333333333333'$q$)),
 ('before','A5 pi_uid squat',        public.attempt($q$UPDATE public.profiles SET pi_uid='victim-pi-uid' WHERE id='33333333-3333-4333-8333-333333333333'$q$)),
 ('before','A6 wallet self-issue',   public.attempt($q$INSERT INTO public.user_wallets(user_id,total_points,available_points,is_pro,membership_level) VALUES ('33333333-3333-4333-8333-333333333333',9999999,9999999,true,'ملكي')$q$)),
 ('before','A7 topup pre-approved',  public.attempt($q$INSERT INTO public.whatsapp_wallet_topup_requests(user_id,amount,payment_method,status) VALUES ('33333333-3333-4333-8333-333333333333',500000,'x','approved')$q$)),
 ('before','A8 upload to victim dir',public.attempt($q$INSERT INTO storage.objects(bucket_id,name,owner) VALUES ('tickets','22222222-2222-4222-8222-222222222222/forged/evil.pdf','33333333-3333-4333-8333-333333333333')$q$));

RESET ROLE;
SET request.jwt.claim.sub = '';
-- الاستحقاق صار مملوكًا بعد A2
INSERT INTO public.results VALUES ('before','A9 chatbot entitlement',
  CASE WHEN public.has_chatbot_entitlement('33333333-3333-4333-8333-333333333333') THEN 'ALLOWED' ELSE 'DENIED' END);

-- مالك الشركة (الرتبة القديمة) يقرأ بيانات العملاء المحتملين
SET request.jwt.claim.sub = '44444444-4444-4444-8444-444444444444';
SET ROLE authenticated;
INSERT INTO public.results VALUES
 ('before','A10 super_user reads landing_leads', CASE WHEN public.reads('SELECT 1 FROM public.landing_leads')>0 THEN 'ALLOWED' ELSE 'DENIED' END),
 ('before','A11 super_user reads wf_leads',      CASE WHEN public.reads('SELECT 1 FROM public.wf_leads')>0      THEN 'ALLOWED' ELSE 'DENIED' END);
RESET ROLE;
SET request.jwt.claim.sub = '';

-- رفع مجهول الهوية
SET request.jwt.claim.sub = '';
SET request.jwt.claim.role = 'anon';
SET ROLE anon;
INSERT INTO public.results VALUES ('before','A12 anonymous upload',
  public.attempt($q$INSERT INTO storage.objects(bucket_id,name,owner) VALUES ('chat-attachments','chat-media/anon.txt',null)$q$));
RESET ROLE;
SET request.jwt.claim.sub = '';

-- N9 كاملة: نُحرّر العنوان المميّز أولًا لنُظهر أن المانع الوحيد هو التعارض
UPDATE public.profiles SET email='parked@example.test' WHERE id='11111111-1111-4111-8111-111111111111';
SET request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';
SET request.jwt.claim.role = 'authenticated';
SET ROLE authenticated;
INSERT INTO public.results VALUES ('before','A13 claim admin email',
  public.attempt($q$UPDATE public.profiles SET email='support@mad3oom.online' WHERE id='33333333-3333-4333-8333-333333333333'$q$));
INSERT INTO public.results VALUES ('before','A14 is_admin() after claim',
  CASE WHEN public.is_admin() THEN 'ALLOWED' ELSE 'DENIED' END);
INSERT INTO public.results VALUES ('before','A15 reads every api_key',
  CASE WHEN public.reads('SELECT 1 FROM public.api_keys')>0 THEN 'ALLOWED' ELSE 'DENIED' END);
INSERT INTO public.results VALUES ('before','A16 reads every integration token',
  CASE WHEN public.reads('SELECT 1 FROM public.integrations')>0 THEN 'ALLOWED' ELSE 'DENIED' END);
RESET ROLE;
SET request.jwt.claim.sub = '';

DO $$
DECLARE r record; v_bad text := '';
BEGIN
  FOR r IN SELECT id, outcome FROM public.results WHERE phase='before' ORDER BY id LOOP
    IF r.outcome <> 'ALLOWED' THEN v_bad := v_bad || r.id || ' '; END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'FAIL الضابط السلبي: هذه الثغرات لم تُثبَت قبل الترحيل، فاختبارها بعده بلا معنى: %', v_bad;
  END IF;
  RAISE NOTICE 'PASS الضابط السلبي: 16 ثغرة مُثبَتة على تعريفات الإنتاج';
END $$;

-- إعادة الحالة قبل الترحيل
UPDATE public.profiles SET email='attacker@example.test', whatsapp_enabled=false, is_verified=false,
       pi_uid=null, ban_status='banned', ban_reason='إساءة', is_locked=true, failed_login_attempts=5
 WHERE id='33333333-3333-4333-8333-333333333333';
UPDATE public.profiles SET email='support@mad3oom.online' WHERE id='11111111-1111-4111-8111-111111111111';
DELETE FROM public.user_wallets WHERE user_id='33333333-3333-4333-8333-333333333333';
DELETE FROM public.whatsapp_wallet_topup_requests;
DELETE FROM storage.objects;

-- ============================================================================
-- المرحلة ب — تطبيق الترحيل
-- ============================================================================
\i migrations/027_legacy_security_closure.sql

-- ============================================================================
-- المرحلة ج — نفس المحاولات، مرفوضة الآن
-- ============================================================================
SET request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';
SET request.jwt.claim.role = 'authenticated';
SET ROLE authenticated;

INSERT INTO public.results VALUES
 ('after','A1 email self-write',    public.attempt($q$UPDATE public.profiles SET email='new@example.test' WHERE id='33333333-3333-4333-8333-333333333333'$q$)),
 ('after','A2 whatsapp_enabled',    public.attempt($q$UPDATE public.profiles SET whatsapp_enabled=true WHERE id='33333333-3333-4333-8333-333333333333'$q$)),
 ('after','A3 is_verified',         public.attempt($q$UPDATE public.profiles SET is_verified=true WHERE id='33333333-3333-4333-8333-333333333333'$q$)),
 ('after','A4 unban self',          public.attempt($q$UPDATE public.profiles SET ban_status=null,is_locked=false,failed_login_attempts=0 WHERE id='33333333-3333-4333-8333-333333333333'$q$)),
 ('after','A5 pi_uid squat',        public.attempt($q$UPDATE public.profiles SET pi_uid='victim-pi-uid' WHERE id='33333333-3333-4333-8333-333333333333'$q$)),
 ('after','A6 wallet self-issue',   public.attempt($q$INSERT INTO public.user_wallets(user_id,total_points,available_points,is_pro,membership_level) VALUES ('33333333-3333-4333-8333-333333333333',9999999,9999999,true,'ملكي')$q$)),
 ('after','A7 topup pre-approved',  public.attempt($q$INSERT INTO public.whatsapp_wallet_topup_requests(user_id,amount,payment_method,status) VALUES ('33333333-3333-4333-8333-333333333333',500000,'x','approved')$q$)),
 ('after','A8 upload to victim dir',public.attempt($q$INSERT INTO storage.objects(bucket_id,name,owner) VALUES ('tickets','22222222-2222-4222-8222-222222222222/forged/evil.pdf','33333333-3333-4333-8333-333333333333')$q$));

RESET ROLE;
SET request.jwt.claim.sub = '';
INSERT INTO public.results VALUES ('after','A9 chatbot entitlement',
  CASE WHEN public.has_chatbot_entitlement('33333333-3333-4333-8333-333333333333') THEN 'ALLOWED' ELSE 'DENIED' END);

SET request.jwt.claim.sub = '44444444-4444-4444-8444-444444444444';
SET ROLE authenticated;
INSERT INTO public.results VALUES
 ('after','A10 super_user reads landing_leads', CASE WHEN public.reads('SELECT 1 FROM public.landing_leads')>0 THEN 'ALLOWED' ELSE 'DENIED' END),
 ('after','A11 super_user reads wf_leads',      CASE WHEN public.reads('SELECT 1 FROM public.wf_leads')>0      THEN 'ALLOWED' ELSE 'DENIED' END);
RESET ROLE;
SET request.jwt.claim.sub = '';

SET request.jwt.claim.sub = '';
SET request.jwt.claim.role = 'anon';
SET ROLE anon;
INSERT INTO public.results VALUES ('after','A12 anonymous upload',
  public.attempt($q$INSERT INTO storage.objects(bucket_id,name,owner) VALUES ('chat-attachments','chat-media/anon.txt',null)$q$));
RESET ROLE;
SET request.jwt.claim.sub = '';

UPDATE public.profiles SET email='parked@example.test' WHERE id='11111111-1111-4111-8111-111111111111';
SET request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';
SET request.jwt.claim.role = 'authenticated';
SET ROLE authenticated;
INSERT INTO public.results VALUES ('after','A13 claim admin email',
  public.attempt($q$UPDATE public.profiles SET email='support@mad3oom.online' WHERE id='33333333-3333-4333-8333-333333333333'$q$));
INSERT INTO public.results VALUES ('after','A14 is_admin() after claim',
  CASE WHEN public.is_admin() THEN 'ALLOWED' ELSE 'DENIED' END);
INSERT INTO public.results VALUES ('after','A15 reads every api_key',
  CASE WHEN public.reads('SELECT 1 FROM public.api_keys')>0 THEN 'ALLOWED' ELSE 'DENIED' END);
INSERT INTO public.results VALUES ('after','A16 reads every integration token',
  CASE WHEN public.reads('SELECT 1 FROM public.integrations')>0 THEN 'ALLOWED' ELSE 'DENIED' END);
RESET ROLE;
SET request.jwt.claim.sub = '';
UPDATE public.profiles SET email='support@mad3oom.online' WHERE id='11111111-1111-4111-8111-111111111111';

DO $$
DECLARE r record; v_bad text := '';
BEGIN
  FOR r IN SELECT id, outcome FROM public.results WHERE phase='after' ORDER BY id LOOP
    IF r.outcome <> 'DENIED' THEN v_bad := v_bad || r.id || ' '; END IF;
  END LOOP;
  IF v_bad <> '' THEN RAISE EXCEPTION 'FAIL ما زالت هذه المحاولات تنجح بعد الترحيل: %', v_bad; END IF;
  RAISE NOTICE 'PASS 16 محاولة كانت تنجح صارت كلها مرفوضة';
END $$;

-- ============================================================================
-- المرحلة د — المسار المشروع لم ينكسر
-- ============================================================================
SET request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';
SET request.jwt.claim.role = 'authenticated';
SET ROLE authenticated;
DO $$
BEGIN
  IF public.attempt($q$UPDATE public.profiles SET full_name='اسمي الجديد' WHERE id='33333333-3333-4333-8333-333333333333'$q$) <> 'ALLOWED'
    THEN RAISE EXCEPTION 'FAIL D1: المستخدم لم يعد يستطيع تعديل بياناته العادية'; END IF;
  -- إرسال الصف كاملًا بقيم غير متغيّرة (نمط upsert في الواجهة) يجب أن يمر
  IF public.attempt($q$UPDATE public.profiles SET email='attacker@example.test', whatsapp_enabled=false,
       is_verified=false, full_name='اسم آخر' WHERE id='33333333-3333-4333-8333-333333333333'$q$) <> 'ALLOWED'
    THEN RAISE EXCEPTION 'FAIL D2: إرسال الصف كاملًا بقيم غير متغيّرة صار مرفوضًا'; END IF;
  IF public.attempt($q$INSERT INTO public.user_wallets(user_id) VALUES ('33333333-3333-4333-8333-333333333333')$q$) <> 'ALLOWED'
    THEN RAISE EXCEPTION 'FAIL D3: إنشاء محفظة صفرية للنفس صار مرفوضًا'; END IF;
  IF public.attempt($q$INSERT INTO public.whatsapp_wallet_topup_requests(user_id,amount,payment_method) VALUES ('33333333-3333-4333-8333-333333333333',100,'vodafone_cash')$q$) <> 'ALLOWED'
    THEN RAISE EXCEPTION 'FAIL D4: طلب شحن مشروع صار مرفوضًا'; END IF;
  IF public.attempt($q$INSERT INTO storage.objects(bucket_id,name,owner) VALUES ('chat-attachments','33333333-3333-4333-8333-333333333333/sess-1.jpg','33333333-3333-4333-8333-333333333333')$q$) <> 'ALLOWED'
    THEN RAISE EXCEPTION 'FAIL D5: رفع مرفق محادثة بعرف chat-logic.js صار مرفوضًا'; END IF;
  IF public.attempt($q$INSERT INTO storage.objects(bucket_id,name,owner) VALUES ('chat-attachments','22222222-2222-4222-8222-222222222222/sess-2.jpg','33333333-3333-4333-8333-333333333333')$q$) <> 'DENIED'
    THEN RAISE EXCEPTION 'FAIL D5b: رفع مرفق محادثة داخل مسار مستخدم آخر'; END IF;
  IF public.attempt($q$INSERT INTO storage.objects(bucket_id,name,owner) VALUES ('tickets','33333333-3333-4333-8333-333333333333/aaaaaaaa-0000-4000-8000-000000000001/ok.png','33333333-3333-4333-8333-333333333333')$q$) <> 'ALLOWED'
    THEN RAISE EXCEPTION 'FAIL D6: رفع في مسار <user_id>/… (عرف العمق 3) صار مرفوضًا'; END IF;
  RAISE NOTICE 'PASS D1..D6 المسار المشروع سليم';
END $$;
RESET ROLE;
SET request.jwt.claim.sub = '';

-- عرف العمق 2 (<ticket_id>/<file>) لصاحب التذكرة يظل يعمل، ولغيره لا
SET request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
SET ROLE authenticated;
DO $$
BEGIN
  IF public.attempt($q$INSERT INTO storage.objects(bucket_id,name,owner) VALUES ('tickets','aaaaaaaa-0000-4000-8000-000000000001/proof.png','22222222-2222-4222-8222-222222222222')$q$) <> 'ALLOWED'
    THEN RAISE EXCEPTION 'FAIL D7: صاحب التذكرة لم يعد يستطيع الرفع بعرف <ticket_id>/<file>'; END IF;
  RAISE NOTICE 'PASS D7 عرف العمق 2 محفوظ لصاحب التذكرة';
END $$;
RESET ROLE;
SET request.jwt.claim.sub = '';
SET request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';
SET ROLE authenticated;
DO $$
BEGIN
  IF public.attempt($q$INSERT INTO storage.objects(bucket_id,name,owner) VALUES ('tickets','aaaaaaaa-0000-4000-8000-000000000001/evil.png','33333333-3333-4333-8333-333333333333')$q$) <> 'DENIED'
    THEN RAISE EXCEPTION 'FAIL D8: غير صاحب التذكرة رفع داخل مجلد تذكرتها'; END IF;
  RAISE NOTICE 'PASS D8 عرف العمق 2 مقفول على غير صاحب التذكرة';
END $$;
RESET ROLE;
SET request.jwt.claim.sub = '';

-- الأدمن الحقيقي لم يفقد شيئًا
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
SET ROLE authenticated;
DO $$
BEGIN
  IF NOT public.is_admin()          THEN RAISE EXCEPTION 'FAIL E1: الأدمن فقد is_admin()'; END IF;
  IF NOT public.is_platform_staff() THEN RAISE EXCEPTION 'FAIL E2: الأدمن فقد is_platform_staff()'; END IF;
  IF NOT public.is_support_user()   THEN RAISE EXCEPTION 'FAIL E3: الأدمن فقد is_support_user()'; END IF;
  IF NOT public.is_landing_admin()  THEN RAISE EXCEPTION 'FAIL E4: الأدمن فقد is_landing_admin()'; END IF;
  IF NOT public.wf_is_staff()       THEN RAISE EXCEPTION 'FAIL E5: الأدمن فقد wf_is_staff()'; END IF;
  IF public.reads('SELECT 1 FROM public.api_keys') <= 0      THEN RAISE EXCEPTION 'FAIL E6: الأدمن فقد قراءة api_keys'; END IF;
  IF public.reads('SELECT 1 FROM public.landing_leads') <= 0 THEN RAISE EXCEPTION 'FAIL E7: الأدمن فقد قراءة landing_leads'; END IF;
  RAISE NOTICE 'PASS E1..E7 سلطة الأدمن سليمة بعد نقل مصدر الهوية';
END $$;
RESET ROLE;
SET request.jwt.claim.sub = '';

-- الأدمن الرئيسي يبقى أدمن حتى لو أُفرغت رتبته (فرع auth.users.email الاحتياطي)
UPDATE public.profiles SET role='user' WHERE id='11111111-1111-4111-8111-111111111111';
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
SET ROLE authenticated;
DO $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'FAIL E8: فرع auth.users.email الاحتياطي لا يعمل — خطر قفل خارج الحساب';
  END IF;
  RAISE NOTICE 'PASS E8 الأدمن الرئيسي محميّ من فقد الرتبة';
END $$;
RESET ROLE;
SET request.jwt.claim.sub = '';
UPDATE public.profiles SET role='admin' WHERE id='11111111-1111-4111-8111-111111111111';

-- الهوية لم تعد تُنتزع بتزوير profiles.email حتى لو كُتب مباشرة بدور الخادم
UPDATE public.profiles SET email='parked2@example.test'   WHERE id='11111111-1111-4111-8111-111111111111';
UPDATE public.profiles SET email='support@mad3oom.online' WHERE id='33333333-3333-4333-8333-333333333333';
SET request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';
SET ROLE authenticated;
DO $$
BEGIN
  IF public.is_admin() OR public.is_support_user() OR public.is_platform_staff() THEN
    RAISE EXCEPTION 'FAIL F1: profiles.email ما زال يمنح الهوية';
  END IF;
  RAISE NOTICE 'PASS F1 profiles.email لم يعد مصدر تفويض بأي حال';
END $$;
RESET ROLE;
SET request.jwt.claim.sub = '';

SELECT 'ALL 027 TESTS PASSED' AS result;

-- ============================================================================
-- المرحلة هـ — إعادة التطبيق (الترحيل يجب أن يكون قابلًا لإعادة التنفيذ)
-- ============================================================================
\i migrations/027_legacy_security_closure.sql
DO $$ BEGIN RAISE NOTICE 'PASS G1 إعادة تطبيق 027 لم تفشل'; END $$;
SELECT 'ALL 027 TESTS PASSED (idempotent)' AS result;
