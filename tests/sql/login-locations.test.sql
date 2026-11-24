-- ============================================================================
-- اختبار تنفيذي لـ migrations/131_login_locations.sql.
--
-- يثبّت الخصائص التي طُلبت صراحةً، كل واحدة تفشل إن انكسرت:
--
--   ① صاحب الحساب يدرج موقعه (إحداثيات صحيحة + دقة)
--   ② خط عرض خارج -90..90 مرفوض (قيد الفحص)
--   ③ خط طول خارج -180..180 مرفوض (قيد الفحص)
--   ④ دقة صفر أو سالبة مرفوضة (قيد الفحص)
--   ⑤ مصدر غير 'browser' مرفوض (قيد الفحص)
--   ⑥ غير صاحب الصف لا يستطيع الإدراج عنه (RLS)
--   ⑦ غير صاحب الصف لا يرى موقعه (RLS تقيس بعدد الصفوف الفعلي)
--   ⑧ صاحب الصف يرى موقعه
--   ⑨ المصدر الافتراضي 'browser' وcaptured_at تُملأ تلقائيًا
--   ⑩ التعديل مرفوض (لا سياسة UPDATE — سجل إلحاقي)
--   ⑪ الحذف مرفوض (لا سياسة DELETE — سجل إلحاقي)
--
-- النمط منسوخ من chat-ratings.test.sql: دور authenticated حقيقي + ادعاء
-- JWT عبر request.jwt.claim.sub، لأن postgres (المستخدم الخارق) يتجاوز
-- RLS فلا يُقاس به شيء.
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true),'')::uuid; $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
END $$;
GRANT USAGE ON SCHEMA auth, public TO authenticated, anon;

\echo '--- applying migrations/131 ---'
\i migrations/131_login_locations.sql

-- ① صاحب الحساب يدرج موقعه.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  INSERT INTO public.login_locations (user_id, latitude, longitude, accuracy_m)
  VALUES ('00000000-0000-0000-0000-0000000000a1', 30.0444, 31.2357, 25);
  RESET ROLE;
  RAISE NOTICE 'PASS 1: المالك أدرج موقعه (30.0444, 31.2357, دقة 25م)';
END $$;

-- ② خط عرض خارج -90..90 مرفوض.
DO $$
DECLARE v_ok boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO public.login_locations (user_id, latitude, longitude)
    VALUES ('00000000-0000-0000-0000-0000000000a1', 91, 31.2357);
  EXCEPTION WHEN check_violation THEN v_ok := true;
  END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL 2: خط عرض 91 لم يُرفض'; END IF;
  RAISE NOTICE 'PASS 2: خط عرض خارج النطاق مرفوض';
END $$;

-- ③ خط طول خارج -180..180 مرفوض.
DO $$
DECLARE v_ok boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO public.login_locations (user_id, latitude, longitude)
    VALUES ('00000000-0000-0000-0000-0000000000a1', 30.0444, 181);
  EXCEPTION WHEN check_violation THEN v_ok := true;
  END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL 3: خط طول 181 لم يُرفض'; END IF;
  RAISE NOTICE 'PASS 3: خط طول خارج النطاق مرفوض';
END $$;

-- ④ دقة صفر أو سالبة مرفوضة.
DO $$
DECLARE v_ok boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO public.login_locations (user_id, latitude, longitude, accuracy_m)
    VALUES ('00000000-0000-0000-0000-0000000000a1', 30.0444, 31.2357, 0);
  EXCEPTION WHEN check_violation THEN v_ok := true;
  END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL 4: دقة 0 لم تُرفض'; END IF;
  RAISE NOTICE 'PASS 4: دقة صفر مرفوضة';
END $$;

-- ⑤ مصدر غير 'browser' مرفوض.
DO $$
DECLARE v_ok boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO public.login_locations (user_id, latitude, longitude, source)
    VALUES ('00000000-0000-0000-0000-0000000000a1', 30.0444, 31.2357, 'manual');
  EXCEPTION WHEN check_violation THEN v_ok := true;
  END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL 5: مصدر manual لم يُرفض'; END IF;
  RAISE NOTICE 'PASS 5: مصدر غير browser مرفوض';
END $$;

-- ⑥ غير صاحب الصف لا يستطيع الإدراج عنه.
DO $$
DECLARE v_ok boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b2', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO public.login_locations (user_id, latitude, longitude)
    VALUES ('00000000-0000-0000-0000-0000000000a1', 30.0444, 31.2357);
  EXCEPTION WHEN insufficient_privilege THEN v_ok := true;
  END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL 6: الغريب أدرج موقعًا عن المالك'; END IF;
  RAISE NOTICE 'PASS 6: إدراج الغريب عن المالك مرفوض بـ RLS';
END $$;

-- ⑦ الغريب لا يرى موقع المالك (عدد الصفوف الفعلي = 0).
DO $$
DECLARE v_n int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b2', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.login_locations;
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL 7: الغريب رأى % صف', v_n; END IF;
  RAISE NOTICE 'PASS 7: الغريب لا يرى أي موقع';
END $$;

-- ⑧ صاحب الصف يرى موقعه.
DO $$
DECLARE v_n int; v_lat double precision; v_lng double precision; v_acc int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*), max(latitude), max(longitude), max(accuracy_m)
    INTO v_n, v_lat, v_lng, v_acc FROM public.login_locations;
  RESET ROLE;
  IF v_n <> 1 OR v_lat <> 30.0444 OR v_lng <> 31.2357 OR v_acc <> 25 THEN
    RAISE EXCEPTION 'FAIL 8: المالك رأى n=% lat=% lng=% acc=%', v_n, v_lat, v_lng, v_acc;
  END IF;
  RAISE NOTICE 'PASS 8: المالك يرى موقعه (30.0444, 31.2357, دقة 25م)';
END $$;

-- ⑨ المصدر الافتراضي 'browser' وcaptured_at تُملأ تلقائيًا.
DO $$
DECLARE v_src text; v_at timestamptz;
BEGIN
  SELECT source, captured_at INTO v_src, v_at FROM public.login_locations LIMIT 1;
  IF v_src <> 'browser' OR v_at IS NULL THEN
    RAISE EXCEPTION 'FAIL 9: source=% captured_at=%', v_src, v_at;
  END IF;
  RAISE NOTICE 'PASS 9: الافتراضيات سليمة (source=browser, captured_at مضبوط)';
END $$;

-- ⑩ التعديل مرفوض (لا سياسة UPDATE).
DO $$
DECLARE v_n int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  UPDATE public.login_locations SET latitude = 31.0 WHERE user_id = '00000000-0000-0000-0000-0000000000a1';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL 10: التعديل عدّل % صف', v_n; END IF;
  RAISE NOTICE 'PASS 10: التعديل مرفوض (0 صف)';
END $$;

-- ⑪ الحذف مرفوض (لا سياسة DELETE).
DO $$
DECLARE v_n int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  DELETE FROM public.login_locations WHERE user_id = '00000000-0000-0000-0000-0000000000a1';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL 11: الحذف حذف % صف', v_n; END IF;
  RAISE NOTICE 'PASS 11: الحذف مرفوض (0 صف)';
END $$;

\echo 'ALL login-locations checks passed'
