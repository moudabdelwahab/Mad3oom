-- ============================================================================
-- 114_ticket_email_payload — حمولة محفّزَي بريد التذاكر على نسخة مطابقة للإنتاج
--
--   ⓪ قبل 114: حمولة UPDATE بلا الحالة السابقة، وحمولة REPLY بلا معرّف الرد
--   ① بعد 114: INSERT بلا previous_status، UPDATE بالحالة السابقة الفعلية، REPLY بمعرّف الرد
--   ② شروط الإطلاق كما هي: تحديث بلا تغيير حالة ⇒ لا نداء، ورد داخلي أو من صاحب التذكرة ⇒ لا نداء
--   ③ معاملة تراجعت ⇒ لا نداء (pg_net يرسل بعد نجاح المعاملة وحده)
--   ④ التراجع يعيد نصّي الإنتاج حرفيًا (md5) ثم إعادة التطبيق
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

\i tests/fixtures/prod-shape/load.sql
SET search_path = public, extensions;

CREATE SCHEMA IF NOT EXISTS t;
CREATE TABLE t.md5 (fn text PRIMARY KEY, before_114 text);
INSERT INTO t.md5
  SELECT p.proname, md5(pg_get_functiondef(p.oid)) FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('notify_ticket_event', 'notify_ticket_reply');

-- بيانات اصطناعية: صاحب تذكرة وموظف دعم
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-8000-0000000000e1', 'owner@example.test'),
  ('00000000-0000-4000-8000-0000000000e2', 'agent@example.test')
ON CONFLICT DO NOTHING;
INSERT INTO public.profiles (id, email, full_name, role) VALUES
  ('00000000-0000-4000-8000-0000000000e1', 'owner@example.test', 'صاحب التذكرة', 'user'),
  ('00000000-0000-4000-8000-0000000000e2', 'agent@example.test', 'موظف الدعم', 'support')
ON CONFLICT (id) DO NOTHING;

-- الإنشاء بمفتاح الخدمة (كما يفعل المحرك)، بلا محفّزات جانبية لا تخص البريد
CREATE FUNCTION t.mk_ticket() RETURNS uuid LANGUAGE plpgsql AS $$
declare v uuid;
begin
  perform set_config('request.jwt.claim.role', 'service_role', false);
  -- تغيير الحالة كما تفعله دوال الطاقم (بوابة التجاوز نفسها)، فالحارس لا يرفضه
  perform set_config('app.bypass_ticket_restrictions', 'on', false);
  insert into public.tickets (user_id, title, description, status)
  values ('00000000-0000-4000-8000-0000000000e1', 'تذكرة اختبار', 'وصف', 'open') returning id into v;
  return v;
end $$;

-- ⓪ قبل 114
DO $$
DECLARE v uuid; r uuid; c jsonb;
BEGIN
  DELETE FROM net._calls;
  v := t.mk_ticket();
  UPDATE public.tickets SET status = 'in-progress' WHERE id = v;
  SELECT body INTO c FROM net._calls WHERE url LIKE '%send-ticket-email' AND body->>'event' = 'UPDATE';
  IF c IS NULL OR c ? 'previous_status' THEN RAISE EXCEPTION 'FAIL 0a: %', c; END IF;
  RAISE NOTICE 'PASS 0: قبل 114 حمولة UPDATE بلا الحالة السابقة (المحفّز يعمل والنداء مسجَّل)';
END $$;

\i migrations/114_ticket_email_payload.sql

-- ① بعد 114
DO $$
DECLARE v uuid; rid uuid; c jsonb;
BEGIN
  DELETE FROM net._calls;
  v := t.mk_ticket();
  SELECT body INTO c FROM net._calls WHERE body->>'event' = 'INSERT' AND body->>'ticket_id' = v::text;
  IF c IS NULL OR c->'previous_status' <> 'null'::jsonb OR c->>'status' <> 'open' THEN RAISE EXCEPTION 'FAIL 1a: %', c; END IF;

  UPDATE public.tickets SET status = 'resolved' WHERE id = v;
  SELECT body INTO c FROM net._calls WHERE body->>'event' = 'UPDATE' AND body->>'ticket_id' = v::text;
  IF c->>'previous_status' <> 'open' OR c->>'status' <> 'resolved' THEN RAISE EXCEPTION 'FAIL 1b: %', c; END IF;

  INSERT INTO public.ticket_replies (ticket_id, user_id, message, is_internal)
  VALUES (v, '00000000-0000-4000-8000-0000000000e2', 'رد الدعم', false) RETURNING id INTO rid;
  SELECT body INTO c FROM net._calls WHERE body->>'event' = 'REPLY' AND body->>'ticket_id' = v::text;
  IF c->>'reply_id' <> rid::text THEN RAISE EXCEPTION 'FAIL 1c: %', c; END IF;
  IF EXISTS (SELECT 1 FROM net._calls WHERE url NOT LIKE 'https://srnelrdpqkcntbgudyto.supabase.co/functions/v1/%') THEN
    RAISE EXCEPTION 'FAIL 1d: عنوان الدالة تغيّر';
  END IF;
  RAISE NOTICE 'PASS 1: INSERT بلا حالة سابقة، UPDATE بالحالة السابقة الفعلية، REPLY بمعرّف الرد';
END $$;

-- ② شروط الإطلاق كما هي
DO $$
DECLARE v uuid; n int;
BEGIN
  v := t.mk_ticket();
  DELETE FROM net._calls;
  UPDATE public.tickets SET priority = 'high' WHERE id = v;                 -- بلا تغيير حالة
  INSERT INTO public.ticket_replies (ticket_id, user_id, message, is_internal)
  VALUES (v, '00000000-0000-4000-8000-0000000000e2', 'ملاحظة داخلية', true),  -- داخلي
         (v, '00000000-0000-4000-8000-0000000000e1', 'رد العميل', false);    -- من صاحب التذكرة
  SELECT count(*) INTO n FROM net._calls WHERE url LIKE '%send-ticket-email';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 2: % نداء', n; END IF;
  RAISE NOTICE 'PASS 2: لا بريد لتحديث بلا تغيير حالة ولا لرد داخلي ولا لرد صاحب التذكرة';
END $$;

-- ③ معاملة تراجعت ⇒ لا نداء (net._calls هنا جدول عادي يتراجع مع المعاملة، كطابور pg_net)
DELETE FROM net._calls;
BEGIN;
SELECT t.mk_ticket() IS NOT NULL;
ROLLBACK;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM net._calls) THEN RAISE EXCEPTION 'FAIL 3'; END IF;
  RAISE NOTICE 'PASS 3: تذكرة لم تُحفظ ⇒ لا طلب بريد';
END $$;

-- ④ التراجع ثم إعادة التطبيق
\i migrations/_rollback/114_ticket_email_payload.down.sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM t.md5 m JOIN pg_proc p ON p.proname = m.fn AND p.pronamespace = 'public'::regnamespace
              WHERE md5(pg_get_functiondef(p.oid)) <> m.before_114) THEN
    RAISE EXCEPTION 'FAIL 4a: التراجع لا يعيد نص الإنتاج';
  END IF;
END $$;
\i migrations/114_ticket_email_payload.sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'notify_ticket_event' AND prosrc LIKE '%previous_status%') THEN
    RAISE EXCEPTION 'FAIL 4b';
  END IF;
  RAISE NOTICE 'PASS 4: التراجع يعيد نصّي الإنتاج حرفيًا، وإعادة التطبيق سليمة';
  RAISE NOTICE 'ALL 114 PASS';
END $$;
