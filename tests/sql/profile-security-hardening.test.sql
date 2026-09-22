-- اختبار تنفيذي لـ migrations/049_profile_security_hardening.sql.
--
-- نفس نهج 027: نُثبت كل ثغرة أولًا على تعريفات الإنتاج الحيّة (ضابط سلبي)،
-- ثم نطبّق الترحيل ونعيد نفس المحاولة حرفيًا تحت SET ROLE authenticated،
-- أي بـ RLS الحقيقية لا بصلاحيات superuser. ثم نتحقق أن المسارات المشروعة
-- (الإدارة، صاحب الحساب، service_role) ما زالت تعمل.
--
-- السياسات والدوال أدناه منسوخة من الإنتاج (pg_policies / pg_get_functiondef،
-- 2026-09-22). المُبسَّط منها مذكور صراحةً.
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
END $$;

CREATE TABLE auth.users (id uuid PRIMARY KEY, email text UNIQUE, encrypted_password text);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
GRANT USAGE ON SCHEMA auth, extensions TO authenticated, anon;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, email text, role text DEFAULT 'user', full_name text,
  phone text, whatsapp_phone text, username text, bio text,
  super_user_id uuid, points int DEFAULT 0, whatsapp_enabled boolean DEFAULT false,
  is_verified boolean DEFAULT false, ban_status text DEFAULT 'none', ban_until timestamptz, ban_reason text,
  is_locked boolean DEFAULT false, failed_login_attempts int DEFAULT 0,
  custom_role_id uuid, pi_uid text,
  two_factor_enabled boolean DEFAULT false, two_factor_secret text, recovery_codes text[],
  mfa_enabled boolean DEFAULT false,
  telegram_chat_id text, telegram_username text, telegram_otp_enabled boolean DEFAULT false,
  last_password_change timestamptz DEFAULT now(), created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX profiles_email_unique ON public.profiles (email);
CREATE UNIQUE INDEX profiles_phone_unique ON public.profiles (phone);

CREATE TABLE public.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, company_name text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended'))
);
CREATE TABLE public.email_lookup_rate_limits (bucket_key text PRIMARY KEY, count int, window_start timestamptz);

GRANT USAGE ON SCHEMA public TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated, anon;

-- ── دوال الإنتاج ──────────────────────────────────────────────────────────
-- مُبسَّط: is_admin / is_support_user بلا فرع owner_capability، و
-- has_elevated_authority = false (نختبر الأدمن العادي، وهو مصدر ثغرة PS-07).
CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin') $$;
CREATE FUNCTION public.is_support_user() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin') $$;
CREATE FUNCTION public.has_elevated_authority() RETURNS boolean LANGUAGE sql STABLE AS $$ select false $$;
CREATE FUNCTION public.supervises(p_user_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select p_user_id is not null and exists (select 1 from public.profiles p where p.id = p_user_id and p.super_user_id = auth.uid()) $$;

CREATE FUNCTION public.normalize_phone(p_phone text) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path TO '' AS $function$
declare v text;
begin
  if p_phone is null or btrim(p_phone) = '' then return null; end if;
  v := regexp_replace(p_phone, '[^0-9+]', '', 'g');
  if v ~ '^00[1-9][0-9]{7,14}$' then v := '+' || substring(v from 3); end if;
  if v ~ '^01[0-9]{9}$'         then v := '+2' || v; end if;
  if v ~ '^[1-9][0-9]{9,14}$'   then v := '+' || v; end if;
  if v ~ '^\+[1-9][0-9]{7,14}$' then return v; end if;
  return null;
end;
$function$;

CREATE FUNCTION public.guard_profile_phone_format() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
declare v text;
begin
  if new.phone is not null and btrim(new.phone) <> '' then
    v := public.normalize_phone(new.phone);
    if v is null then raise exception 'رقم الهاتف غير صحيح: %', new.phone using errcode = '22023'; end if;
    new.phone := v;
  end if;
  return new;
end;
$function$;
CREATE TRIGGER guard_profile_phone_format BEFORE INSERT OR UPDATE OF phone, whatsapp_phone ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION guard_profile_phone_format();

CREATE FUNCTION public.guard_profile_protected_columns() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
begin
  if  new.email                 is not distinct from old.email
  and new.whatsapp_enabled      is not distinct from old.whatsapp_enabled
  and new.is_verified           is not distinct from old.is_verified
  and new.ban_status            is not distinct from old.ban_status
  and new.ban_until             is not distinct from old.ban_until
  and new.ban_reason            is not distinct from old.ban_reason
  and new.is_locked             is not distinct from old.is_locked
  and new.failed_login_attempts is not distinct from old.failed_login_attempts
  and new.custom_role_id        is not distinct from old.custom_role_id
  and new.pi_uid                is not distinct from old.pi_uid
  then return new; end if;
  if auth.uid() is null then return new; end if;
  if public.is_admin() then return new; end if;
  raise exception 'هذه الحقول لا تُعدَّل من حساب المستخدم' using errcode = '42501';
end $function$;
CREATE TRIGGER guard_profile_protected_columns BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION guard_profile_protected_columns();

\i migrations/006_2fa_change_requires_challenge.sql

CREATE FUNCTION public._check_email_lookup_rate_limit(p_key text, p_max integer, p_window_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_count int;
BEGIN
  INSERT INTO email_lookup_rate_limits (bucket_key, count, window_start) VALUES (p_key, 1, now())
  ON CONFLICT (bucket_key) DO UPDATE SET count = email_lookup_rate_limits.count + 1
  RETURNING count INTO v_count;
  RETURN v_count <= p_max;
END;
$function$;
CREATE FUNCTION public.get_email_by_phone(p_phone text) RETURNS TABLE(email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF NOT public._check_email_lookup_rate_limit('phone:' || lower(coalesce(p_phone, '')), 5, 600) THEN
    RAISE EXCEPTION 'محاولات كثيرة جدًا، حاول لاحقًا' USING ERRCODE = '42901';
  END IF;
  IF NOT public._check_email_lookup_rate_limit('global', 60, 300) THEN
    RAISE EXCEPTION 'محاولات كثيرة جدًا، حاول لاحقًا' USING ERRCODE = '42901';
  END IF;
  RETURN QUERY SELECT profiles.email FROM profiles WHERE phone = p_phone;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.get_email_by_phone(text) TO anon, authenticated;

-- ── سياسات الإنتاج حرفيًا ────────────────────────────────────────────────
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_select_policy ON public.profiles FOR SELECT
  USING ((auth.uid() = id) OR has_elevated_authority() OR supervises(id));
CREATE POLICY "Support can view all profiles" ON public.profiles FOR SELECT
  USING (is_support_user() OR (auth.uid() = id));
CREATE POLICY profiles_update_policy ON public.profiles FOR UPDATE
  USING ((auth.uid() = id) OR has_elevated_authority() OR supervises(id));
CREATE POLICY "Support can update whatsapp_enabled" ON public.profiles FOR UPDATE
  USING (is_support_user()) WITH CHECK (is_support_user());
CREATE POLICY user_insert_self ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their own company" ON public.companies FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Users can update their own company" ON public.companies FOR UPDATE USING (user_id = auth.uid());

-- ── البيانات ──────────────────────────────────────────────────────────────
-- A = أدمن عادي · O = صاحب شركة · M = عضو في شركته · V = عميل عادي بـ 2FA
-- D = حساب بريده في profiles لا يطابق auth.users (حالة الإنتاج)
INSERT INTO auth.users VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001','admin@x.test','h1'),
  ('aaaaaaaa-0000-4000-8000-000000000002','owner@x.test','h2'),
  ('aaaaaaaa-0000-4000-8000-000000000003','member@x.test','h3'),
  ('aaaaaaaa-0000-4000-8000-000000000004','victim@x.test','h4'),
  ('aaaaaaaa-0000-4000-8000-000000000005','real@x.test','h5');
INSERT INTO public.profiles (id, email, role, full_name, phone, super_user_id, two_factor_enabled, two_factor_secret, recovery_codes) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001','admin@x.test','admin','A', NULL, NULL, false, NULL, NULL),
  ('aaaaaaaa-0000-4000-8000-000000000002','owner@x.test','company_admin','O', NULL, NULL, false, NULL, NULL),
  ('aaaaaaaa-0000-4000-8000-000000000003','member@x.test','company_user','M', '+201000000003', 'aaaaaaaa-0000-4000-8000-000000000002', false, NULL, NULL),
  ('aaaaaaaa-0000-4000-8000-000000000004','victim@x.test','user','V', '+201000000004', NULL, true, 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', ARRAY['AAAA111111','bbbb222222']),
  ('aaaaaaaa-0000-4000-8000-000000000005','stale@x.test','user','D', NULL, NULL, false, NULL, NULL);
INSERT INTO public.companies (id, user_id, company_name, status) VALUES
  ('cccccccc-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000002','Co','suspended');

CREATE FUNCTION pg_temp.as_user(p uuid) RETURNS void LANGUAGE sql AS $$
  select set_config('request.jwt.claim.sub', p::text, false), set_config('role', 'authenticated', false) $$;
CREATE FUNCTION pg_temp.as_service() RETURNS void LANGUAGE sql AS $$
  select set_config('request.jwt.claim.sub', '', false), set_config('role', 'postgres', false) $$;

\echo '=== 0) الضوابط السلبية: الثغرات قائمة على تعريفات الإنتاج ==='
BEGIN;
SELECT pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
DO $$ DECLARE s text; BEGIN
  SELECT two_factor_secret INTO s FROM public.profiles WHERE id='aaaaaaaa-0000-4000-8000-000000000004';
  IF s IS NULL THEN RAISE EXCEPTION 'FAIL N1: control did not reproduce'; END IF;
  RAISE NOTICE 'PASS N1: قبل الترحيل — الأدمن يقرأ سرّ TOTP لعميل آخر';
END $$;
DO $$ DECLARE n int; BEGIN
  UPDATE public.profiles SET phone='+201099999999', telegram_chat_id='attacker' WHERE id='aaaaaaaa-0000-4000-8000-000000000004';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL N2: control did not reproduce'; END IF;
  RAISE NOTICE 'PASS N2: قبل الترحيل — الأدمن يغيّر هاتف وتيليجرام عميل آخر';
END $$;
DO $$ DECLARE n int; BEGIN
  UPDATE public.profiles SET email='hijack@x.test' WHERE id='aaaaaaaa-0000-4000-8000-000000000004';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL N3: control did not reproduce'; END IF;
  RAISE NOTICE 'PASS N3: قبل الترحيل — الأدمن يغيّر profiles.email بعيدًا عن auth.users';
END $$;
SELECT pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000002');
DO $$ DECLARE n int; BEGIN
  UPDATE public.profiles SET two_factor_enabled=true, two_factor_secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
   WHERE id='aaaaaaaa-0000-4000-8000-000000000003';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL N4: control did not reproduce'; END IF;
  RAISE NOTICE 'PASS N4: قبل الترحيل — صاحب الشركة يفعّل 2FA على عضو بسرّ يختاره';
END $$;
DO $$ DECLARE n int; BEGIN
  UPDATE public.companies SET status='active' WHERE id='cccccccc-0000-4000-8000-000000000001';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL N5: control did not reproduce'; END IF;
  RAISE NOTICE 'PASS N5: قبل الترحيل — الشركة الموقوفة ترفع الإيقاف بنفسها';
END $$;
SELECT pg_temp.as_service();
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM public.get_email_by_phone('01000000004');
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL N6: control did not reproduce'; END IF;
  RAISE NOTICE 'PASS N6: قبل الترحيل — الدخول بصيغة 010… لا يجد الحساب';
END $$;
ROLLBACK;

\echo '--- applying migrations/049 ---'
SELECT pg_temp.as_service();
\i migrations/049_profile_security_hardening.sql
TRUNCATE public.email_lookup_rate_limits;

\echo '=== 1) PS-02 الأسرار خرجت من profiles ==='
DO $$ DECLARE r record; BEGIN
  SELECT p.two_factor_enabled, p.two_factor_secret, p.recovery_codes, s.totp_secret, s.recovery_code_hashes INTO r
    FROM public.profiles p JOIN public.user_mfa_secrets s ON s.user_id = p.id
   WHERE p.id='aaaaaaaa-0000-4000-8000-000000000004';
  IF r.two_factor_enabled IS NOT TRUE OR r.two_factor_secret IS NOT NULL OR r.recovery_codes IS NOT NULL
     OR r.totp_secret <> 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
     OR r.recovery_code_hashes <> ARRAY[
          encode(extensions.digest('AAAA111111','sha256'),'hex'),
          encode(extensions.digest('BBBB222222','sha256'),'hex')] THEN
    RAISE EXCEPTION 'FAIL P1: data move wrong %', r;
  END IF;
  RAISE NOTICE 'PASS P1: السرّ نُقل، الرموز hashes، والأعمدة في profiles فارغة، و2FA ما زال مفعّلًا';
END $$;

SELECT pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
DO $$ DECLARE s text; BEGIN
  SELECT two_factor_secret INTO s FROM public.profiles WHERE id='aaaaaaaa-0000-4000-8000-000000000004';
  IF s IS NOT NULL THEN RAISE EXCEPTION 'FAIL P2: admin still reads the secret'; END IF;
  RAISE NOTICE 'PASS P2: الأدمن لم يعد يقرأ السرّ من profiles';
END $$;
DO $$ BEGIN
  PERFORM 1 FROM public.user_mfa_secrets;
  RAISE EXCEPTION 'FAIL P3: authenticated can query user_mfa_secrets';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS P3: user_mfa_secrets مغلق أمام authenticated';
END $$;
SELECT pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000004');
DO $$ BEGIN
  PERFORM 1 FROM public.user_mfa_secrets WHERE user_id = auth.uid();
  RAISE EXCEPTION 'FAIL P3b: owner can read own raw secret';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS P3b: حتى صاحب الحساب لا يقرأ السرّ الخام';
END $$;

\echo '=== 2) حماية 2FA القائمة لم تتأثر ==='
DO $$ BEGIN
  UPDATE public.profiles SET two_factor_enabled=false WHERE id = auth.uid();
  RAISE EXCEPTION 'FAIL P4: 2FA disable bypass reopened';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS P4: التعطيل المباشر ما زال مرفوضًا (006)';
END $$;
DO $$ BEGIN
  UPDATE public.profiles SET two_factor_secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' WHERE id = auth.uid();
  RAISE EXCEPTION 'FAIL P5: secret rotation allowed while enabled';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS P5: تدوير السرّ وهو مفعّل ما زال مرفوضًا';
END $$;
DO $$ BEGIN
  UPDATE public.profiles SET full_name='V2', phone='01000000044' WHERE id = auth.uid();
  IF (SELECT phone FROM public.profiles WHERE id = auth.uid()) <> '+201000000044' THEN RAISE EXCEPTION 'FAIL P6'; END IF;
  IF NOT (SELECT two_factor_enabled FROM public.profiles WHERE id = auth.uid()) THEN RAISE EXCEPTION 'FAIL P6: 2FA lost'; END IF;
  RAISE NOTICE 'PASS P6: صاحب الحساب يعدّل اسمه وهاتفه، و2FA لا يتأثر';
END $$;

\echo '=== 3) التسجيل والتعطيل ما زالا يعملان ==='
SELECT pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000003');
UPDATE public.profiles SET two_factor_enabled=true, two_factor_secret='KRSXG5CTMVRXEZLU',
       recovery_codes=ARRAY['ccccc33333'] WHERE id = auth.uid();
SELECT pg_temp.as_service();
DO $$ DECLARE r record; BEGIN
  SELECT p.two_factor_secret, s.totp_secret, s.recovery_code_hashes INTO r
    FROM public.profiles p JOIN public.user_mfa_secrets s ON s.user_id=p.id
   WHERE p.id='aaaaaaaa-0000-4000-8000-000000000003';
  IF r.two_factor_secret IS NOT NULL OR r.totp_secret <> 'KRSXG5CTMVRXEZLU'
     OR r.recovery_code_hashes <> ARRAY[public.hash_recovery_code('CCCCC33333')] THEN
    RAISE EXCEPTION 'FAIL P7 %', r;
  END IF;
  RAISE NOTICE 'PASS P7: التسجيل من المتصفح يعمل كما هو، والسرّ يُحوَّل للجدول الخاص';
END $$;
UPDATE public.profiles SET two_factor_enabled=false, two_factor_secret=NULL, recovery_codes=NULL
 WHERE id='aaaaaaaa-0000-4000-8000-000000000003';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.user_mfa_secrets WHERE user_id='aaaaaaaa-0000-4000-8000-000000000003') THEN
    RAISE EXCEPTION 'FAIL P8: secret survived disable';
  END IF;
  RAISE NOTICE 'PASS P8: تعطيل service_role (disable-2fa) يحذف السرّ';
END $$;

\echo '=== 4) PS-07 لا أحد يعدّل بيانات أمان غيره ==='
SELECT pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
DO $$ BEGIN
  UPDATE public.profiles SET phone='+201099999999' WHERE id='aaaaaaaa-0000-4000-8000-000000000004';
  RAISE EXCEPTION 'FAIL P9';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS P9: الأدمن لا يغيّر هاتف عميل';
END $$;
DO $$ BEGIN
  UPDATE public.profiles SET telegram_chat_id='attacker', telegram_otp_enabled=false WHERE id='aaaaaaaa-0000-4000-8000-000000000004';
  RAISE EXCEPTION 'FAIL P10';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS P10: الأدمن لا يغيّر تيليجرام عميل';
END $$;
DO $$ BEGIN
  UPDATE public.profiles SET username='support' WHERE id='aaaaaaaa-0000-4000-8000-000000000004';
  RAISE EXCEPTION 'FAIL P11';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS P11: الأدمن لا يغيّر اسم دخول عميل';
END $$;
DO $$ BEGIN
  UPDATE public.profiles SET email='hijack@x.test' WHERE id='aaaaaaaa-0000-4000-8000-000000000004';
  RAISE EXCEPTION 'FAIL P12';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS P12: الأدمن لا يكتب profiles.email';
END $$;
DO $$ DECLARE n int; BEGIN
  UPDATE public.profiles SET full_name='V-admin-edit', whatsapp_enabled=true, points=10
   WHERE id='aaaaaaaa-0000-4000-8000-000000000004';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL P13: admin lost legitimate ops'; END IF;
  RAISE NOTICE 'PASS P13: عمليات الإدارة المشروعة (الاسم، whatsapp_enabled، النقاط) ما زالت تعمل';
END $$;

SELECT pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000002');
DO $$ BEGIN
  UPDATE public.profiles SET two_factor_enabled=true, two_factor_secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
   WHERE id='aaaaaaaa-0000-4000-8000-000000000003';
  RAISE EXCEPTION 'FAIL P14';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS P14: صاحب الشركة لا يفعّل 2FA على عضو';
END $$;
DO $$ BEGIN
  UPDATE public.profiles SET phone='+201011111111' WHERE id='aaaaaaaa-0000-4000-8000-000000000003';
  RAISE EXCEPTION 'FAIL P15';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS P15: صاحب الشركة لا يغيّر هاتف عضو';
END $$;
DO $$ DECLARE s text; BEGIN
  SELECT coalesce(two_factor_secret,'') || coalesce(array_to_string(recovery_codes,','),'') INTO s
    FROM public.profiles WHERE id='aaaaaaaa-0000-4000-8000-000000000003';
  IF s <> '' THEN RAISE EXCEPTION 'FAIL P16'; END IF;
  RAISE NOTICE 'PASS P16: صاحب الشركة لا يرى أسرار أعضائه';
END $$;

SELECT pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000004');
DO $$ BEGIN
  UPDATE public.profiles SET email='mine@x.test' WHERE id = auth.uid();
  RAISE EXCEPTION 'FAIL P17';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS P17: ولا صاحب الحساب يكتب profiles.email مباشرة';
END $$;
DO $$ DECLARE n int; BEGIN
  UPDATE public.profiles SET username='victim2' WHERE id = auth.uid();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL P18'; END IF;
  RAISE NOTICE 'PASS P18: صاحب الحساب يعدّل بياناته هو';
END $$;
DO $$ DECLARE n int; BEGIN
  UPDATE public.profiles SET phone='+201000000003' WHERE id='aaaaaaaa-0000-4000-8000-000000000003';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL P19'; END IF;
  RAISE NOTICE 'PASS P19: عميل عادي لا يصل لصف غيره أصلًا (RLS القائمة)';
END $$;

\echo '=== 5) PS-13 / PS-20 البريد وكلمة المرور من auth.users ==='
SELECT pg_temp.as_service();
DO $$ BEGIN
  IF (SELECT email FROM public.profiles WHERE id='aaaaaaaa-0000-4000-8000-000000000005') <> 'real@x.test' THEN
    RAISE EXCEPTION 'FAIL P20: one-time sync';
  END IF;
  RAISE NOTICE 'PASS P20: الحساب غير المتطابق صُحِّح إلى بريد الدخول';
END $$;
UPDATE auth.users SET email='victim-new@x.test' WHERE id='aaaaaaaa-0000-4000-8000-000000000004';
UPDATE auth.users SET encrypted_password='h4b' WHERE id='aaaaaaaa-0000-4000-8000-000000000004';
DO $$ DECLARE r record; BEGIN
  SELECT email, last_password_change INTO r FROM public.profiles WHERE id='aaaaaaaa-0000-4000-8000-000000000004';
  IF r.email <> 'victim-new@x.test' OR r.last_password_change < now() - interval '5 seconds' THEN
    RAISE EXCEPTION 'FAIL P21 %', r;
  END IF;
  RAISE NOTICE 'PASS P21: تغيير البريد وكلمة المرور في auth.users ينعكس على profiles';
END $$;
DO $$ BEGIN
  UPDATE auth.users SET email='admin@x.test-dup' WHERE id='aaaaaaaa-0000-4000-8000-000000000005';
  UPDATE public.profiles SET email='taken@x.test' WHERE id='aaaaaaaa-0000-4000-8000-000000000001';
  UPDATE auth.users SET email='taken@x.test' WHERE id='aaaaaaaa-0000-4000-8000-000000000005';
  RAISE NOTICE 'PASS P22: تعارض البريد لا يُفشل تغيير بريد الدخول';
END $$;

\echo '=== 6) PS-09 حالة الشركة ==='
SELECT pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000002');
DO $$ BEGIN
  UPDATE public.companies SET status='active' WHERE id='cccccccc-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'FAIL P23';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS P23: الشركة الموقوفة لا ترفع الإيقاف بنفسها';
END $$;
DO $$ DECLARE n int; BEGIN
  UPDATE public.companies SET company_name='Co2' WHERE id='cccccccc-0000-4000-8000-000000000001';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL P24'; END IF;
  RAISE NOTICE 'PASS P24: صاحب الشركة ما زال يعدّل بيانات شركته';
END $$;
SELECT pg_temp.as_service();
UPDATE public.companies SET status='active' WHERE id='cccccccc-0000-4000-8000-000000000001';
\echo 'PASS P25: service_role يغيّر الحالة'

\echo '=== 7) PS-14 الدخول بالهاتف ==='
DO $$ DECLARE e text; BEGIN
  SELECT email INTO e FROM public.get_email_by_phone('01000000044');
  IF e IS DISTINCT FROM 'victim-new@x.test' THEN RAISE EXCEPTION 'FAIL P26 %', e; END IF;
  SELECT email INTO e FROM public.get_email_by_phone('+20 100 000 0044');
  IF e IS DISTINCT FROM 'victim-new@x.test' THEN RAISE EXCEPTION 'FAIL P27 %', e; END IF;
  IF EXISTS (SELECT 1 FROM public.get_email_by_phone('not-a-phone')) THEN RAISE EXCEPTION 'FAIL P28'; END IF;
  RAISE NOTICE 'PASS P26-28: الصيغ المحلية والدولية تجد الحساب، والنص العشوائي لا يجد شيئًا';
END $$;

\echo '=== 8) إعادة التطبيق آمنة ==='
\i migrations/049_profile_security_hardening.sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_mfa_secrets WHERE user_id='aaaaaaaa-0000-4000-8000-000000000004') THEN
    RAISE EXCEPTION 'FAIL P29: re-run lost the secret';
  END IF;
  RAISE NOTICE 'PASS P29: إعادة تطبيق 049 لم تُفسد شيئًا';
END $$;

\echo 'ALL PROFILE SECURITY HARDENING TESTS PASSED'
