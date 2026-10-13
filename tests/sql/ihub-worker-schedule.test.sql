-- ============================================================================
-- مركز التكاملات: جدولة العامل الخلفي (090) على نسخة مطابقة لشكل الإنتاج (086 → 088 → 090):
--   W1  السر يُولَّد داخل القاعدة (72 hex)، ولا يُقرأ إلا بدور الخدمة؛ إعادة التشغيل لا تغيّره
--       ولا تمس أسرار غيره
--   W2  دالة النداء: ترسل لـ integrations-worker بالسر في الترويسة، بلا جسم؛ مغلقة على الجميع
--   W3  بلا سر ⇒ لا نداء
--   W4  لا تكرار: نداءان متتاليان لحجز الأحداث لا يأخذان الحدث نفسه (تأجيل 5 دقائق)
--   RB  التراجع يحذف الدالة والسر؛ إعادة التطبيق تولّد سرًا جديدًا
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

\i tests/fixtures/prod-shape/load.sql
SET search_path = public, extensions;

DROP SCHEMA IF EXISTS t CASCADE;
CREATE SCHEMA t;
CREATE FUNCTION t.ok(p_cond boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
begin
  if p_cond is distinct from true then raise exception 'FAIL %', p_label; end if;
end $$;
CREATE FUNCTION t.as_role(p_role text, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  execute format('set local role %I', p_role);
  execute p_sql;
  execute 'reset role';
  return 'ok';
exception when others then
  execute 'reset role';
  return sqlstate;
end $$;
CREATE TABLE t.saved (k text PRIMARY KEY, v text);
GRANT USAGE ON SCHEMA t TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO anon, authenticated, service_role;

SET check_function_bodies = off;
\i migrations/086_company_staff.sql
SET search_path = public, extensions;
\i migrations/088_integrations_hub.sql
SET search_path = public, extensions;
INSERT INTO public.internal_service_secrets (key, value) VALUES ('other_service', 'keep-me')
ON CONFLICT DO NOTHING;
INSERT INTO t.saved SELECT 'secrets_before', string_agg(key || '=' || value, ',' ORDER BY key) FROM public.internal_service_secrets;

\i migrations/090_ihub_worker_schedule.sql
SET search_path = public, extensions;

-- W1
DO $$
DECLARE v text := (SELECT value FROM public.internal_service_secrets WHERE key = 'ihub_worker');
BEGIN
  PERFORM t.ok(v ~ '^[0-9a-f]{72}$', 'W1 secret shape');
  PERFORM t.ok(t.as_role('authenticated', 'select 1 from public.internal_service_secrets') = '42501', 'W1 authenticated cannot read');
  PERFORM t.ok(t.as_role('anon', 'select 1 from public.internal_service_secrets') = '42501', 'W1 anon cannot read');
  INSERT INTO t.saved VALUES ('secret', v);
  RAISE NOTICE 'PASS W1: السر مولَّد داخل القاعدة وغير مقروء لغير الخدمة';
END $$;
\i migrations/090_ihub_worker_schedule.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok((SELECT value FROM public.internal_service_secrets WHERE key = 'ihub_worker') = (SELECT v FROM t.saved WHERE k = 'secret'), 'W1 rerun keeps secret');
  PERFORM t.ok((SELECT string_agg(key || '=' || value, ',' ORDER BY key) FROM public.internal_service_secrets WHERE key <> 'ihub_worker')
               = (SELECT v FROM t.saved WHERE k = 'secrets_before'), 'W1 other secrets untouched');
  RAISE NOTICE 'PASS W1-rerun: إعادة التشغيل لا تغيّر السر ولا تمس غيره';
END $$;

-- W2
DO $$
DECLARE v_call bigint; c record;
BEGIN
  v_call := public._ihub_worker_call();
  SELECT * INTO c FROM net._calls WHERE net._calls.id = v_call;
  PERFORM t.ok(c.url = 'https://srnelrdpqkcntbgudyto.supabase.co/functions/v1/integrations-worker', 'W2 url');
  PERFORM t.ok(c.headers ->> 'x-ihub-worker-secret' = (SELECT v FROM t.saved WHERE k = 'secret'), 'W2 header');
  PERFORM t.ok(c.body = '{}'::jsonb, 'W2 no body');
  PERFORM t.ok(t.as_role('authenticated', 'select public._ihub_worker_call()') = '42501', 'W2 authenticated');
  PERFORM t.ok(t.as_role('anon', 'select public._ihub_worker_call()') = '42501', 'W2 anon');
  PERFORM t.ok(t.as_role('service_role', 'select public._ihub_worker_call()') = '42501', 'W2 service_role');
  RAISE NOTICE 'PASS W2: النداء للعامل بالسر في الترويسة فقط؛ مغلقة على كل الأدوار';
END $$;

-- W3
DO $$
DECLARE n int := (SELECT count(*) FROM net._calls);
BEGIN
  DELETE FROM public.internal_service_secrets WHERE key = 'ihub_worker';
  PERFORM t.ok(public._ihub_worker_call() IS NULL AND (SELECT count(*) FROM net._calls) = n, 'W3 no secret no call');
  INSERT INTO public.internal_service_secrets (key, value) VALUES ('ihub_worker', (SELECT v FROM t.saved WHERE k = 'secret'));
  RAISE NOTICE 'PASS W3: بلا سر لا نداء';
END $$;

-- W4: حدث فاشل مستحق واحد؛ حجزان متتاليان (كما يفعل عاملان متداخلان) لا يأخذانه مرتين
DO $$
DECLARE v_company uuid; v_conn uuid; first jsonb; second jsonb;
BEGIN
  INSERT INTO auth.users (id, email) VALUES ('00000000-0000-4000-8000-0000000000a1', 'w4@t.io');
  INSERT INTO public.profiles (id, email, full_name, role, phone, created_at)
  VALUES ('00000000-0000-4000-8000-0000000000a1', 'w4@t.io', 'مالك', 'user', '01000000901', '2026-09-01');
  INSERT INTO public.companies (id, user_id, company_name, commercial_registration_number)
  VALUES ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000a1', 'شركة', 'CR-W4')
  RETURNING id INTO v_company;
  INSERT INTO public.ihub_connections (company_id, provider, status, external_account_id, base_url)
  VALUES (v_company, 'woocommerce', 'active', 'https://shop.example.com/', 'https://shop.example.com')
  RETURNING id INTO v_conn;
  INSERT INTO public.ihub_webhook_events (connection_id, company_id, provider, topic, dedupe_key, external_type,
                                         external_id, status, attempts, next_attempt_at)
  VALUES (v_conn, v_company, 'woocommerce', 'order.updated', repeat('a', 64), 'order', '1007', 'failed', 1, now() - interval '1 minute');
  first  := public.ihub_svc_claim_due_events(20);
  second := public.ihub_svc_claim_due_events(20);
  PERFORM t.ok(jsonb_array_length(first) = 1, 'W4 first run claims the due event');
  PERFORM t.ok(jsonb_array_length(second) = 0, 'W4 second run does not claim it again');
  PERFORM t.ok((SELECT next_attempt_at > now() + interval '4 minutes' FROM public.ihub_webhook_events WHERE connection_id = v_conn),
               'W4 lease pushed forward');
  DELETE FROM public.ihub_webhook_events WHERE connection_id = v_conn;
  DELETE FROM public.ihub_connections WHERE id = v_conn;
  RAISE NOTICE 'PASS W4: لا تكرار — الحجز يؤجّل الحدث فلا يأخذه نداء متداخل';
END $$;

-- RB
\i migrations/_rollback/090_ihub_worker_schedule.down.sql
DO $$
BEGIN
  PERFORM t.ok(to_regprocedure('public._ihub_worker_call()') IS NULL, 'RB function gone');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.internal_service_secrets WHERE key = 'ihub_worker'), 'RB secret gone');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.internal_service_secrets WHERE key = 'other_service'), 'RB other secrets kept');
  RAISE NOTICE 'PASS RB-a: التراجع يحذف الدالة والسر فقط';
END $$;
\i migrations/090_ihub_worker_schedule.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok((SELECT value FROM public.internal_service_secrets WHERE key = 'ihub_worker') <> (SELECT v FROM t.saved WHERE k = 'secret'), 'RB-b new secret');
  RAISE NOTICE 'PASS RB-b: إعادة التطبيق تولّد سرًا جديدًا';
END $$;

\echo 'ALL ihub-worker-schedule tests passed'
