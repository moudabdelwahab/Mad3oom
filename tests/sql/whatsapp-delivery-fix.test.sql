-- ============================================================================
-- اختبار تنفيذي لـ migrations/123_whatsapp_delivery_rate_fix.sql.
--
-- يثبّت أن معدل التسليم يُحسب من delivery_status لا من status:
--
--   ① رسائل delivery_status='delivered' تُحسب مسلَّمة
--   ② رسائل status='delivered' وحدها لا تُحسب (الخطأ الأصلي بالضبط)
--   ③ 'read' لا تُحسب كمُسلَّمة (الوصفة المعتمدة: delivered فقط)
--   ④ العدّ معزول لكل مستخدم (auth.uid)
--   ⑤ بلا رسائل صادرة اليوم المعدل 0 لا قسمة على صفر
--
-- النمط منسوخ من account-gate.test.sql: ادعاء JWT عبر
-- request.jwt.claim.sub؛ الدالة SECURITY DEFINER فتقرأ auth.uid() من
-- الادعاء كما في الإنتاج.
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true),'')::uuid; $$;

CREATE TABLE public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  direction text,
  status text,
  delivery_status text,
  created_at timestamptz DEFAULT now()
);

-- المستخدم أ: 5 صادرة اليوم — 2 delivered، 1 read، 1 sent، 1 failed؛
-- وواحدة status='delivered' لكن delivery_status='sent' (فخ الانحدار).
-- المستخدم ب: 2 صادرة delivered (للعزل).
INSERT INTO public.messages (user_id, direction, status, delivery_status, created_at) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'outbound', 'sent', 'delivered', CURRENT_DATE + interval '1 hour'),
  ('00000000-0000-0000-0000-0000000000a1', 'outbound', 'sent', 'delivered', CURRENT_DATE + interval '2 hour'),
  ('00000000-0000-0000-0000-0000000000a1', 'outbound', 'sent', 'read',      CURRENT_DATE + interval '3 hour'),
  ('00000000-0000-0000-0000-0000000000a1', 'outbound', 'sent', 'sent',      CURRENT_DATE + interval '4 hour'),
  ('00000000-0000-0000-0000-0000000000a1', 'outbound', 'failed', 'failed',  CURRENT_DATE + interval '5 hour'),
  ('00000000-0000-0000-0000-0000000000a1', 'outbound', 'delivered', 'sent', CURRENT_DATE + interval '6 hour'),
  ('00000000-0000-0000-0000-0000000000b2', 'outbound', 'sent', 'delivered', CURRENT_DATE + interval '1 hour'),
  ('00000000-0000-0000-0000-0000000000b2', 'outbound', 'sent', 'delivered', CURRENT_DATE + interval '2 hour'),
  -- واردة اليوم (لا تدخل العدّ) + صادرة أمس (خارج النافذة).
  ('00000000-0000-0000-0000-0000000000a1', 'inbound',  'received', 'sent',  CURRENT_DATE + interval '1 hour'),
  ('00000000-0000-0000-0000-0000000000a1', 'outbound', 'sent', 'delivered', CURRENT_DATE - interval '1 day');

\echo '--- applying migrations/123 ---'
\i migrations/123_whatsapp_delivery_rate_fix.sql

-- ①②③ المستخدم أ: sent_today=6، delivered=2، المعدل 33.33.
DO $$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SELECT public.get_whatsapp_dashboard_stats() INTO v;
  IF (v->>'sent_today')::int <> 6 THEN
    RAISE EXCEPTION 'FAIL 1: sent_today=% (المتوقع 6)', v->>'sent_today'; END IF;
  IF (v->>'delivery_rate')::numeric <> 33.33 THEN
    RAISE EXCEPTION 'FAIL 1: delivery_rate=% (المتوقع 33.33 — 2 من 6)', v->>'delivery_rate'; END IF;
  RAISE NOTICE 'PASS 1: delivered من delivery_status فقط (2 من 6 = 33.33%%)، وstatus=delivered وحدها لا تُحسب، وread لا تُحسب';
END $$;

-- ④ المستخدم ب معزول: sent_today=2، المعدل 100.
DO $$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b2', true);
  SELECT public.get_whatsapp_dashboard_stats() INTO v;
  IF (v->>'sent_today')::int <> 2 OR (v->>'delivery_rate')::numeric <> 100 THEN
    RAISE EXCEPTION 'FAIL 2: sent=% rate=% (المتوقع 2 و100)', v->>'sent_today', v->>'delivery_rate'; END IF;
  RAISE NOTICE 'PASS 2: العدّ معزول لكل مستخدم';
END $$;

-- ⑤ مستخدم بلا رسائل: المعدل 0 لا خطأ قسمة.
DO $$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000c3', true);
  SELECT public.get_whatsapp_dashboard_stats() INTO v;
  IF (v->>'sent_today')::int <> 0 OR (v->>'delivery_rate')::numeric <> 0 THEN
    RAISE EXCEPTION 'FAIL 3: sent=% rate=% (المتوقع 0 و0)', v->>'sent_today', v->>'delivery_rate'; END IF;
  RAISE NOTICE 'PASS 3: بلا رسائل المعدل 0';
END $$;

\echo 'ALL whatsapp-delivery-fix checks passed'
