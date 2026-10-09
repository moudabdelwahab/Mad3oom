-- ============================================================================
-- رصيد التذاكر وتذاكر الفوترة (069) — على نسخة مطابقة لشكل الإنتاج
--
-- قاعدة الإنتاج كاملة (tests/fixtures/prod-shape): محفّزات tickets كلها (منها
-- الحصة 065 والترقيم والـ SLA)، ومحفّزات whatsapp_subscriptions (قواعد الشراء)،
-- وبوابة الحساب، والسياسات — ثم 069 كما هو، ثم التراجع وإعادة التطبيق.
--
-- ⓪ (الإنتاج قبل 069): تذكرة «اشتراك» يفتحها العميل بنفسه لا تُحسب من الرصيد.
-- ① (بعد 069): اليدوية من الرصيد ومرفوضة عند نفاده؛ طلب الاشتراك/الترقية من
--    الخادم معفى (سقف الفوترة 5 فقط) وذرّي؛ العلم لا يُزوَّر ولا يتسرّب؛ المسار
--    القديم (الواجهة المنشورة) ما زال يعمل.
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

\i tests/fixtures/prod-shape/load.sql
SET search_path = public, extensions;

DROP SCHEMA IF EXISTS t CASCADE;
CREATE SCHEMA t;
GRANT USAGE ON SCHEMA t TO authenticated, service_role, anon;
CREATE FUNCTION t.act(p uuid) RETURNS void LANGUAGE sql AS $$
  select set_config('request.jwt.claim.sub', coalesce(p::text, ''), false),
         set_config('request.jwt.claim.role', case when p is null then '' else 'authenticated' end, false); $$;
CREATE FUNCTION t.try(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  execute p_sql;
  raise exception using errcode = 'TT000';
exception when others then
  return case when sqlstate = 'TT000' then 'ok' else sqlstate end;
end $$;
CREATE FUNCTION t.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlerrm;
end $$;
-- رصيد الحساب كما تراه الواجهة
CREATE FUNCTION t.w(p uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$ select public.ticket_quota_status(p) $$;
-- تذكرة دعم عادية يفتحها العميل من المتصفح (نفس إدراج tickets-service)
CREATE FUNCTION t.manual(p_category text) RETURNS text LANGUAGE sql AS $$
  select t.try(format($q$insert into public.tickets (user_id, title, description, status, priority, category)
                         values (auth.uid(), 'تذكرة يدوية', 'وصف', 'open', 'medium', %L)$q$, p_category)) $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ── الفاعلون ───────────────────────────────────────────────────────────────
--   U1 عميل مجاني  U2 عميل مجاني (سقف الفوترة)  U3 مشترك «المتقدمة» (ترقية)
--   UW في قائمة الانتظار
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-8000-0000000000b1', 'b1@t.io'), ('00000000-0000-4000-8000-0000000000b2', 'b2@t.io'),
  ('00000000-0000-4000-8000-0000000000b3', 'b3@t.io'), ('00000000-0000-4000-8000-0000000000bb', 'bw@t.io');
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at) VALUES
  ('00000000-0000-4000-8000-0000000000b1', 'b1@t.io', 'عميل واحد', 'user', '01000000021', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000b2', 'b2@t.io', 'عميل اتنين', 'user', '01000000022', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000b3', 'b3@t.io', 'عميل تلاتة', 'user', '01000000023', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000bb', 'bw@t.io', 'منتظر', 'user', '01000000024', now());
-- U3: اشتراك «المتقدمة» فعّال شهري (بلا جلسة = مسار الإدارة/الخدمة)
INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days)
VALUES ('00000000-0000-4000-8000-0000000000b3', 'support', 'active', 'monthly', now() - interval '10 days', now() + interval '20 days', 30);

DO $$
BEGIN
  IF NOT public.account_is_whitelisted('00000000-0000-4000-8000-0000000000b1')
     OR public.account_is_whitelisted('00000000-0000-4000-8000-0000000000bb') THEN
    RAISE EXCEPTION 'SETUP: بوابة الحساب مش زي المتوقع';
  END IF;
  RAISE NOTICE 'PASS SETUP: نسخة الإنتاج + عملاء مجانيين ومشترك ومنتظر';
END $$;

-- ============================================================================
-- ⓪ قبل 069
-- ============================================================================
DO $$
DECLARE before jsonb; after jsonb;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000b1');
  SET LOCAL ROLE authenticated;
  before := t.w(auth.uid());
  IF t.manual('subscription') <> 'ok' THEN RESET ROLE; RAISE EXCEPTION 'SETUP ⓪: الإدراج اليدوي فشل'; END IF;
  -- t.try بيرجّع الأثر؛ نعيد الإدراج فعليًا
  INSERT INTO public.tickets (user_id, title, description, status, priority, category)
  VALUES (auth.uid(), 'مشكلة الاشتراك', 'وصف', 'open', 'high', 'subscription');
  after := t.w(auth.uid());
  RESET ROLE;
  IF (after->>'used')::int <> (before->>'used')::int OR (after->>'billing_used')::int <> (before->>'billing_used')::int + 1 THEN
    RAISE EXCEPTION 'FAIL ⓪: السلوك قبل 069 مش زي الإنتاج (%→%)', before, after;
  END IF;
  RAISE NOTICE 'PROVEN GAP ⓪ (قبل 069): تذكرة «اشتراك» يدوية ⇒ used % → % (ما اتحسبتش)، billing % → %',
    before->>'used', after->>'used', before->>'billing_used', after->>'billing_used';
  PERFORM t.act(NULL);
END $$;

-- ============================================================================
-- ① بعد 069
-- ============================================================================
\i migrations/069_billing_ticket_quota.sql
SET search_path = public, extensions;

-- ── B1: اليدوية (ومنها تذكرة ⓪) من الرصيد ─────────────────────────────────
DO $$
DECLARE w jsonb;
BEGIN
  w := t.w('00000000-0000-4000-8000-0000000000b1');
  IF (w->>'used')::int <> 1 OR (w->>'billing_used')::int <> 0 THEN
    RAISE EXCEPTION 'FAIL B1: تذكرة ⓪ لسه مش محسوبة (%)', w;
  END IF;
  PERFORM t.act('00000000-0000-4000-8000-0000000000b1');
  SET LOCAL ROLE authenticated;
  INSERT INTO public.tickets (user_id, title, description, status, priority, category)
  VALUES (auth.uid(), 'سؤال عن الفاتورة', 'وصف', 'open', 'medium', 'subscription');
  w := t.w(auth.uid());
  RESET ROLE;
  IF (w->>'used')::int <> 2 OR (w->>'billing_used')::int <> 0 OR (w->>'remaining')::int <> 18 THEN
    RAISE EXCEPTION 'FAIL B1: اليدوية مااتحسبتش من الرصيد (%)', w;
  END IF;
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS B1: تذكرة «اشتراك» يدوية ⇒ من الـ 20 (used=2, remaining=18)، والقديمة اتحسبت كمان';
END $$;

-- ── B2: الرصيد خلص ⇒ «اشتراك» اليدوية مرفوضة زي أي تذكرة ──────────────────
DO $$
DECLARE e text;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000b1');
  SET LOCAL ROLE authenticated;
  INSERT INTO public.tickets (user_id, title, description, status, priority, category)
  SELECT auth.uid(), 'تذكرة ' || g, 'وصف', 'open', 'medium', 'tickets' FROM generate_series(1, 18) g;
  e := t.err($s$insert into public.tickets (user_id, title, description, status, priority, category)
                values (auth.uid(), 'كمان واحدة', 'وصف', 'open', 'high', 'subscription')$s$);
  RESET ROLE;
  IF e NOT LIKE 'وصلت للحد الأقصى من التذاكر%' THEN RAISE EXCEPTION 'FAIL B2: %', e; END IF;
  IF (t.w('00000000-0000-4000-8000-0000000000b1')->>'used')::int <> 20 THEN RAISE EXCEPTION 'FAIL B2: العدّ'; END IF;
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS B2: عند 20/20 تذكرة «اشتراك» اليدوية مرفوضة برسالة الرصيد';
END $$;

-- ── B3: طلب الاشتراك من الخادم معفى ومرتبط، حتى والرصيد خالص ──────────────
DO $$
DECLARE r jsonb; w jsonb; tk record; n_before int; n_after int;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000b1');
  SET LOCAL ROLE authenticated;
  r := public.submit_subscription_request('support', 'monthly', 'طلب اشتراك - الخطة المتقدمة (شهري)',
         'طلب اشتراك جديد\nوسيلة الدفع: تحويل بنكي', false, 'bank_transfer', 'REF-1');
  w := t.w(auth.uid());
  RESET ROLE;
  SELECT * INTO tk FROM public.tickets WHERE id = (r->'ticket'->>'id')::uuid;
  IF tk.user_id <> '00000000-0000-4000-8000-0000000000b1' OR tk.category <> 'subscription' OR tk.priority <> 'high'
     OR tk.status <> 'open' OR tk.ticket_number IS NULL
     OR tk.sla_response_due_at NOT BETWEEN now() + interval '59 minutes' AND now() + interval '61 minutes' THEN
    RAISE EXCEPTION 'FAIL B3: التذكرة مش بقيم الخادم (%)', row_to_json(tk);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.whatsapp_subscriptions WHERE id = (r->>'subscription_id')::uuid
                  AND ticket_id = tk.id AND status = 'pending' AND payment_method = 'bank_transfer' AND payment_reference = 'REF-1') THEN
    RAISE EXCEPTION 'FAIL B3: الطلب مش مرتبط بالتذكرة';
  END IF;
  IF (w->>'used')::int <> 20 OR (w->>'billing_used')::int <> 1 THEN
    RAISE EXCEPTION 'FAIL B3: طلب الاشتراك اتحسب من الرصيد (%)', w;
  END IF;

  -- B4: الطلب يترفض ⇒ مفيش تذكرة يتيمة (ذرّي)
  SELECT count(*) INTO n_before FROM public.tickets WHERE user_id = '00000000-0000-4000-8000-0000000000b1';
  PERFORM t.act('00000000-0000-4000-8000-0000000000b1');
  SET LOCAL ROLE authenticated;
  IF t.err($s$select public.submit_subscription_request('support', 'monthly', 'طلب', 'وصف', false, 'bank_transfer')$s$)
       NOT LIKE 'لديك بالفعل طلب في هذه الباقة%' THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL B4: الطلب المكرر عدّى';
  END IF;
  RESET ROLE;
  SELECT count(*) INTO n_after FROM public.tickets WHERE user_id = '00000000-0000-4000-8000-0000000000b1';
  IF n_after <> n_before THEN RAISE EXCEPTION 'FAIL B4: فضلت تذكرة يتيمة'; END IF;
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS B3: عند 20/20 طلب الاشتراك اتسجّل بتذكرته (subscription/high/open، SLA ساعة للتحويل)، مرتبط، ومحسوب فوترة (used=20, billing=1)';
  RAISE NOTICE 'PASS B4: طلب مرفوض (مكرر) ⇒ التذكرة رجعت معاه — مفيش يتيمة';
END $$;

-- ── B5: العلم مايتزوّرش ومايتسرّبش ─────────────────────────────────────────
DO $$
DECLARE e text; st text;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000b1');
  SET LOCAL ROLE authenticated;
  -- فتح تذكرة معفاة مباشرةً
  st := t.try($s$select public._open_billing_request_ticket('x', 'y', 'bank_transfer')$s$);
  IF st <> '42501' THEN RESET ROLE; RAISE EXCEPTION 'FAIL B5a: الدالة الداخلية متاحة للعميل (%)', st; END IF;
  -- طلب ناجح (ترقية مش ممكنة لمجاني، فنجرب باقة تانية) ثم تذكرة يدوية في نفس المعاملة
  PERFORM public.submit_subscription_request('ultimate', 'monthly', 'طلب اشتراك - الفائقة', 'وصف', false, 'gateway');
  e := t.err($s$insert into public.tickets (user_id, title, description, status, priority, category)
                values (auth.uid(), 'بعد الطلب', 'وصف', 'open', 'high', 'subscription')$s$);
  RESET ROLE;
  IF e NOT LIKE 'وصلت للحد الأقصى من التذاكر%' THEN RAISE EXCEPTION 'FAIL B5b: العلم اتسرّب لإدراج لاحق (%)', e; END IF;
  SET LOCAL ROLE anon;
  IF t.try($s$select public.submit_subscription_request('support', 'monthly', 't', 'd')$s$) <> '42501' THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL B5c: anon نادى submit';
  END IF;
  RESET ROLE;
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS B5: _open_billing_request_ticket مقفولة على العميل (42501)، العلم مابيتسرّبش لإدراج بعده في نفس المعاملة، و anon برا';
END $$;

-- ── B6: سقف الفوترة (5) لسه سارٍ على المسار المعفى ─────────────────────────
DO $$
DECLARE e text; i int;
BEGIN
  -- 5 طلبات فوترة مرتبطة هذا الشهر (إعداد بمسار الخادم)
  PERFORM set_config('mad3oom.billing_request_ticket', 'on', true);
  FOR i IN 1..5 LOOP
    WITH tk AS (
      INSERT INTO public.tickets (user_id, title, description, status, priority, category)
      VALUES ('00000000-0000-4000-8000-0000000000b2', 'طلب ' || i, 'وصف', 'open', 'high', 'subscription')
      RETURNING id)
    INSERT INTO public.whatsapp_subscriptions (user_id, ticket_id, plan, status, billing_cycle, start_date, end_date, duration_days)
    SELECT '00000000-0000-4000-8000-0000000000b2', tk.id, 'support', 'rejected', 'monthly', now(), now() + interval '30 days', 30 FROM tk;
  END LOOP;
  PERFORM set_config('mad3oom.billing_request_ticket', 'off', true);
  IF (t.w('00000000-0000-4000-8000-0000000000b2')->>'billing_used')::int <> 5 THEN RAISE EXCEPTION 'SETUP B6'; END IF;

  PERFORM t.act('00000000-0000-4000-8000-0000000000b2');
  SET LOCAL ROLE authenticated;
  e := t.err($s$select public.submit_subscription_request('support', 'monthly', 'طلب', 'وصف', false, 'bank_transfer')$s$);
  RESET ROLE;
  IF e NOT LIKE 'وصلت للحد الأقصى من طلبات الاشتراك والفوترة%' THEN RAISE EXCEPTION 'FAIL B6: %', e; END IF;
  -- وتذكرة يدوية عادية لسه متاحة من الـ 20
  SET LOCAL ROLE authenticated;
  IF t.manual('subscription') <> 'ok' THEN RESET ROLE; RAISE EXCEPTION 'FAIL B6: الرصيد العادي اتقفل بسقف الفوترة'; END IF;
  RESET ROLE;
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS B6: 5 طلبات فوترة ⇒ السادس مرفوض بسقف الفوترة، والرصيد العادي لسه متاح';
END $$;

-- ── B7: الترقية من الخادم بنفس القواعد ─────────────────────────────────────
DO $$
DECLARE r jsonb; w jsonb;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000b3');
  SET LOCAL ROLE authenticated;
  r := public.submit_subscription_upgrade('ultimate', 'طلب ترقية ودمج الباقة - الفائقة', 'وصف الترقية', 'instapay', 'IP-9');
  w := t.w(auth.uid());
  RESET ROLE;
  IF NOT EXISTS (SELECT 1 FROM public.whatsapp_subscriptions s JOIN public.tickets tk ON tk.id = s.ticket_id
                  WHERE s.id = (r->>'subscription_id')::uuid AND s.status = 'pending' AND s.plan = 'ultimate'
                    AND s.upgraded_from_subscription_id IS NOT NULL AND s.upgrade_amount > 0
                    AND tk.id = (r->'ticket'->>'id')::uuid AND tk.category = 'subscription') THEN
    RAISE EXCEPTION 'FAIL B7: طلب الترقية مش مرتبط بتذكرته (%)', r;
  END IF;
  IF (w->>'used')::int <> 0 OR (w->>'billing_used')::int <> 1 OR r->>'amount_due' IS NULL THEN
    RAISE EXCEPTION 'FAIL B7: العدّ أو المبلغ (%)', w;
  END IF;
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS B7: الترقية من الخادم ⇒ طلب pending بالمبلغ مرتبط بتذكرته، ومحسوبة فوترة';
END $$;

-- ── B8: بوابة الحساب والمدخلات ──────────────────────────────────────────────
DO $$
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000bb');
  SET LOCAL ROLE authenticated;
  IF t.try($s$select public.submit_subscription_request('support', 'monthly', 'طلب', 'وصف')$s$) <> '42501' THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL B8a: حساب في قائمة الانتظار فتح طلب';
  END IF;
  RESET ROLE;
  PERFORM t.act('00000000-0000-4000-8000-0000000000b3');
  SET LOCAL ROLE authenticated;
  IF t.try($s$select public.submit_subscription_request('support', 'monthly', '  ', 'وصف')$s$) <> '22023'
     OR t.try(format($f$select public.submit_subscription_request('support', 'monthly', 'طلب', %L)$f$, repeat('x', 4001))) <> '22023' THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL B8b: عنوان/وصف غلط عدّى';
  END IF;
  RESET ROLE;
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS B8: المنتظر مرفوض (42501)، وعنوان فاضي أو وصف طويل ⇒ 22023';
END $$;

-- ── B9: المسار القديم (الواجهة المنشورة قبل الدمج) لسه شغال ────────────────
DO $$
DECLARE tid uuid; r jsonb; w_mid jsonb; w_end jsonb;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000b3');
  SET LOCAL ROLE authenticated;
  INSERT INTO public.tickets (user_id, title, description, status, priority, category)
  VALUES (auth.uid(), 'طلب اشتراك - واتساب', 'وصف', 'open', 'high', 'subscription') RETURNING id INTO tid;
  w_mid := t.w(auth.uid());
  r := public.request_subscription_purchase('whatsapp', 'monthly', tid, false, 'bank_transfer', null);
  w_end := t.w(auth.uid());
  RESET ROLE;
  IF (w_mid->>'used')::int <> 1 OR (w_end->>'used')::int <> 0 OR (w_end->>'billing_used')::int <> 2 THEN
    RAISE EXCEPTION 'FAIL B9: المسار القديم (% ثم %)', w_mid, w_end;
  END IF;
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS B9: الواجهة القديمة (تذكرة من المتصفح + request_subscription_purchase) لسه شغالة، والتذكرة بتتحسب فوترة بمجرد ارتباطها';
END $$;

-- ============================================================================
-- ② التراجع وإعادة التطبيق
-- ============================================================================
\i migrations/_rollback/069_billing_ticket_quota.down.sql
DO $$
DECLARE w jsonb;
BEGIN
  IF to_regprocedure('public.submit_subscription_request(text,text,text,text,boolean,text,text)') IS NOT NULL
     OR to_regprocedure('public._open_billing_request_ticket(text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL RB1: دوال 069 لسه موجودة';
  END IF;
  -- العدّ رجع بالتصنيف: «اشتراك» اليدوية لـ U1 رجعت فوترة
  w := t.w('00000000-0000-4000-8000-0000000000b1');
  IF (w->>'used')::int <> 18 THEN RAISE EXCEPTION 'FAIL RB1: العدّ مارجعش لسلوك 065 (%)', w; END IF;
  RAISE NOTICE 'PASS RB1: التراجع بيرجّع عدّ 065 بالتصنيف ويشيل الدوال، والتذاكر والطلبات باقية';
END $$;
\i migrations/069_billing_ticket_quota.sql
SET search_path = public, extensions;
DO $$
BEGIN
  IF (t.w('00000000-0000-4000-8000-0000000000b1')->>'used')::int <> 20 THEN RAISE EXCEPTION 'FAIL RB2'; END IF;
  RAISE NOTICE 'PASS RB2: إعادة التطبيق idempotent';
END $$;

SELECT 'ALL BILLING TICKET QUOTA TESTS PASSED';
