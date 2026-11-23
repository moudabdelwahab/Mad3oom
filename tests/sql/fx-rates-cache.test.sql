-- ============================================================================
-- اختبار تنفيذي لـ migrations/126_fx_rates_cache.sql.
--
-- يثبّت أن ذاكرة أسعار الصرف موجودة وتقبل الصفوف وترفض الفاسد منها:
--
--   ① إدراج سعر من البنك المركزي يُحفظ ويُقرأ كأحدث سعر
--   ② سعر أحدث (من Frankfurter) يتقدم في ترتيب as_of
--   ③ سعر صفر أو سالب مرفوض (قيد الفحص)
--   ④ مصدر خارج {cbe, frankfurter} مرفوض (قيد الفحص)
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on

\echo '--- applying migrations/126 ---'
\i migrations/126_fx_rates_cache.sql

-- ① إدراج سعر البنك المركزي.
INSERT INTO public.fx_rates (base, quote, rate, buy, sell, source, rate_date, as_of)
VALUES ('USD', 'EGP', 54.3383, 54.2883, 54.3883, 'cbe', '2026-11-23', '2026-11-23 12:00:00+00');

DO $$
DECLARE v_rate numeric; v_source text;
BEGIN
  SELECT rate, source INTO v_rate, v_source FROM public.fx_rates
  WHERE base = 'USD' AND quote = 'EGP' ORDER BY as_of DESC LIMIT 1;
  IF v_rate <> 54.3383 OR v_source <> 'cbe' THEN
    RAISE EXCEPTION 'FAIL 1: latest=% source=% (المتوقع 54.3383 وcbe)', v_rate, v_source; END IF;
  RAISE NOTICE 'PASS 1: سعر البنك المركزي محفوظ ومقروء كأحدث سعر';
END $$;

-- ② سعر أحدث من Frankfurter يتقدم.
INSERT INTO public.fx_rates (base, quote, rate, buy, sell, source, rate_date, as_of)
VALUES ('USD', 'EGP', 53.999, 53.999, 53.999, 'frankfurter', '2026-11-23', '2026-11-23 13:00:00+00');

DO $$
DECLARE v_rate numeric; v_source text;
BEGIN
  SELECT rate, source INTO v_rate, v_source FROM public.fx_rates
  WHERE base = 'USD' AND quote = 'EGP' ORDER BY as_of DESC LIMIT 1;
  IF v_rate <> 53.999 OR v_source <> 'frankfurter' THEN
    RAISE EXCEPTION 'FAIL 2: latest=% source=% (المتوقع 53.999 وfrankfurter)', v_rate, v_source; END IF;
  RAISE NOTICE 'PASS 2: أحدث سعر (Frankfurter) يتقدم في الترتيب';
END $$;

-- ③ سعر صفر مرفوض.
DO $$
DECLARE v_ok boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.fx_rates (base, quote, rate, source, rate_date)
    VALUES ('USD', 'EGP', 0, 'cbe', '2026-11-23');
  EXCEPTION WHEN check_violation THEN v_ok := true;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL 3: سعر صفر لم يُرفض'; END IF;
  RAISE NOTICE 'PASS 3: سعر صفر مرفوض';
END $$;

-- ④ مصدر خارج القائمة مرفوض.
DO $$
DECLARE v_ok boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.fx_rates (base, quote, rate, source, rate_date)
    VALUES ('USD', 'EGP', 54.0, 'random-site', '2026-11-23');
  EXCEPTION WHEN check_violation THEN v_ok := true;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL 4: مصدر غير معتمد لم يُرفض'; END IF;
  RAISE NOTICE 'PASS 4: مصدر خارج {cbe, frankfurter} مرفوض';
END $$;

\echo 'ALL fx-rates-cache checks passed'
