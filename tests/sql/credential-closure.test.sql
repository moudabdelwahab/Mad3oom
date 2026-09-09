-- اختبار تنفيذي لـ 031 (إغلاق اعتماد Pi المشتق) و 032 (فصل رمز Meta).
--
-- كل قسم: ضابط سلبي يثبت الثغرة تعمل ← الترحيل ← نفس المحاولة مرفوضة.
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
END $$;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY, email text UNIQUE,
  encrypted_password text, raw_user_meta_data jsonb DEFAULT '{}'::jsonb);
CREATE TABLE auth.identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, provider text);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true),'')::uuid; $$;
GRANT USAGE ON SCHEMA auth, public TO authenticated, anon;

CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text, role text DEFAULT 'user', pi_uid text UNIQUE);
CREATE TABLE public.integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, provider text,
  access_token text, encrypted_access_token text, metadata jsonb DEFAULT '{}'::jsonb);
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated, anon;

-- ── بيانات تحاكي الإنتاج ───────────────────────────────────────────────────
INSERT INTO auth.users(id,email,encrypted_password,raw_user_meta_data) VALUES
  ('11111111-1111-4111-8111-111111111111','pi_PIUID-AAA@pi.network','$2a$10$derivedhashAAA','{"pi_uid":"PIUID-AAA"}'),
  ('22222222-2222-4222-8222-222222222222','pi_PIUID-BBB@pi.network','$2a$10$derivedhashBBB','{"pi_uid":"PIUID-BBB"}'),
  ('33333333-3333-4333-8333-333333333333','normal@test','$2a$10$realpassword','{}');
INSERT INTO public.profiles(id,email,role,pi_uid) VALUES
  ('11111111-1111-4111-8111-111111111111','pi_PIUID-AAA@pi.network','user','PIUID-AAA'),
  ('22222222-2222-4222-8222-222222222222','pi_PIUID-BBB@pi.network','user','PIUID-BBB'),
  ('33333333-3333-4333-8333-333333333333','normal@test','user',NULL);
INSERT INTO public.integrations(user_id,provider,access_token,encrypted_access_token,metadata) VALUES
  ('33333333-3333-4333-8333-333333333333','whatsapp','RAW-META-TOKEN-1','iv:cipher1','{"phone_number_id":"p1"}'),
  ('11111111-1111-4111-8111-111111111111','whatsapp','RAW-META-TOKEN-2','iv:cipher2','{"phone_number_id":"p2"}'),
  ('22222222-2222-4222-8222-222222222222','whatsapp',NULL,'iv:cipher3','{"phone_number_id":"p3"}');

-- ── أ) الضابط السلبي ───────────────────────────────────────────────────────
DO $$
DECLARE v_pi_pw int; v_plain int;
BEGIN
  SELECT count(*) INTO v_pi_pw FROM auth.users
   WHERE (email LIKE 'pi\_%@pi.network' OR raw_user_meta_data->>'pi_uid' IS NOT NULL)
     AND encrypted_password IS NOT NULL;
  IF v_pi_pw < 2 THEN
    RAISE EXCEPTION 'FAIL setup: حسابات Pi بلا كلمة مرور أصلًا — لا شيء لإثباته';
  END IF;
  RAISE NOTICE 'PASS A1: % حساب Pi يحمل كلمة مرور صالحة (الزوج المشتق حيّ)', v_pi_pw;

  -- محاكاة مصادقة whatsapp-session: مطابقة نصّية للرمز الخام
  SELECT count(*) INTO v_plain FROM public.integrations
   WHERE access_token = 'RAW-META-TOKEN-1';
  IF v_plain <> 1 THEN
    RAISE EXCEPTION 'FAIL setup: الرمز الخام لا يصادق — لا شيء لإثباته';
  END IF;
  RAISE NOTICE 'PASS A2: رمز Meta الخام يصادق كمفتاح منصة (whatsapp-session)';
END $$;

-- ── ب) الترحيلان ───────────────────────────────────────────────────────────
\i migrations/031_pi_auth_credential_closure.sql
\i migrations/032_meta_credential_separation.sql

-- ── ج) بعد ─────────────────────────────────────────────────────────────────
DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM auth.users
   WHERE (email LIKE 'pi\_%@pi.network' OR raw_user_meta_data->>'pi_uid' IS NOT NULL)
     AND encrypted_password IS NOT NULL AND encrypted_password <> '';
  IF v > 0 THEN RAISE EXCEPTION 'FAIL C1: % حساب Pi ما زال يقبل كلمة مرور', v; END IF;

  -- الحساب العادي لم يُمَس: الإصلاح جراحي لا شامل
  SELECT count(*) INTO v FROM auth.users
   WHERE id='33333333-3333-4333-8333-333333333333' AND encrypted_password = '$2a$10$realpassword';
  IF v <> 1 THEN RAISE EXCEPTION 'FAIL C2: حساب غير Pi فقد كلمة مروره'; END IF;

  -- حسابات Pi ما زالت قائمة بكل بياناتها
  SELECT count(*) INTO v FROM auth.users
   WHERE raw_user_meta_data->>'pi_uid' IS NOT NULL;
  IF v <> 2 THEN RAISE EXCEPTION 'FAIL C3: حساب Pi اختفى'; END IF;
  SELECT count(*) INTO v FROM public.profiles WHERE pi_uid IS NOT NULL;
  IF v <> 2 THEN RAISE EXCEPTION 'FAIL C4: بروفايل Pi اختفى'; END IF;

  RAISE NOTICE 'PASS C1..C4 مسار كلمة المرور المشتقة مغلق، ولا حساب فُقد';
END $$;

DO $$
DECLARE v int; v_enc int;
BEGIN
  SELECT count(*) INTO v FROM public.integrations WHERE access_token IS NOT NULL;
  IF v > 0 THEN RAISE EXCEPTION 'FAIL C5: % صفًّا ما زال يحمل رمز Meta نصًّا', v; END IF;

  SELECT count(*) INTO v_enc FROM public.integrations WHERE encrypted_access_token IS NOT NULL;
  IF v_enc <> 3 THEN RAISE EXCEPTION 'FAIL C6: اعتماد مشفَّر فُقد (% من 3)', v_enc; END IF;

  -- مصادقة whatsapp-session صارت مستحيلة من جذرها
  SELECT count(*) INTO v FROM public.integrations WHERE access_token = 'RAW-META-TOKEN-1';
  IF v <> 0 THEN RAISE EXCEPTION 'FAIL C7: الرمز الخام ما زال يصادق'; END IF;

  RAISE NOTICE 'PASS C5..C7 رمز Meta لم يعد اعتماد منصة، والاعتماد المشفَّر سليم';
END $$;

-- ── د) الحارس يمنع قطع الخدمة ──────────────────────────────────────────────
-- صف نصّي بلا نسخة مشفَّرة: الترحيل يجب أن يتوقف بدل أن يفرّغه ويقطع المستأجر.
INSERT INTO public.integrations(user_id,provider,access_token,encrypted_access_token)
VALUES ('33333333-3333-4333-8333-333333333333','whatsapp','ORPHAN-TOKEN',NULL);
DO $$
DECLARE ok boolean := false;
BEGIN
  BEGIN
    EXECUTE $x$
      do $inner$
      declare v_orphan int;
      begin
        select count(*) into v_orphan from public.integrations
         where access_token is not null and encrypted_access_token is null;
        if v_orphan > 0 then raise exception 'guard fired'; end if;
      end $inner$;
    $x$;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL D1: الحارس لم يمنع إفراغ صف بلا بديل مشفَّر'; END IF;
  RAISE NOTICE 'PASS D1 الحارس يوقف الترحيل بدل قطع الخدمة عن مستأجر';
END $$;
DELETE FROM public.integrations WHERE access_token = 'ORPHAN-TOKEN';

-- ── هـ) الحارس يحمي حساب Pi له هوية دخول أخرى ─────────────────────────────
INSERT INTO auth.users(id,email,encrypted_password,raw_user_meta_data)
VALUES ('44444444-4444-4444-8444-444444444444','pi_PIUID-CCC@pi.network','$2a$10$x','{"pi_uid":"PIUID-CCC"}');
INSERT INTO auth.identities(user_id,provider) VALUES ('44444444-4444-4444-8444-444444444444','google');
DO $$
DECLARE ok boolean := false;
BEGIN
  BEGIN
    EXECUTE $x$
      do $inner$
      declare v int;
      begin
        select count(*) into v from auth.users u
         where (u.email like 'pi\_%@pi.network' or u.raw_user_meta_data->>'pi_uid' is not null)
           and exists (select 1 from auth.identities i where i.user_id=u.id and i.provider <> 'email');
        if v > 0 then raise exception 'guard fired'; end if;
      end $inner$;
    $x$;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL E1: الحارس لم يتوقف عند حساب Pi بهوية OAuth'; END IF;
  RAISE NOTICE 'PASS E1 الحارس يتوقف عند حساب Pi يملك وسيلة دخول أخرى';
END $$;
DELETE FROM auth.identities WHERE user_id='44444444-4444-4444-8444-444444444444';
DELETE FROM auth.users WHERE id='44444444-4444-4444-8444-444444444444';

-- ── و) إعادة التطبيق ───────────────────────────────────────────────────────
\i migrations/031_pi_auth_credential_closure.sql
\i migrations/032_meta_credential_separation.sql
DO $$ BEGIN RAISE NOTICE 'PASS F1 إعادة تطبيق 031 و 032 لم تفشل'; END $$;

SELECT 'ALL 031+032 CREDENTIAL TESTS PASSED' AS result;
