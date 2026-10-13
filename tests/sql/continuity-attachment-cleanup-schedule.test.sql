-- ============================================================================
-- مدعوم — الاستمرارية: جدولة الحذف الفعلي لملفات المرفقات (088) على نسخة مطابقة لشكل
-- الإنتاج (073 → 080 → 088):
--   C1  السر يُولَّد داخل القاعدة (64 hex)، ولا يُقرأ إلا بدور الخدمة؛ إعادة التشغيل لا تغيّره
--   C2  دالة النداء: ترسل للدالة الطرفية الصحيحة بالسر في الترويسة، بلا جسم؛ مغلقة على الجميع
--   C3  بلا سر ⇒ لا نداء
--   RB  التراجع يحذف الدالة والسر؛ إعادة التطبيق تولّد سرًا جديدًا
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

\i tests/fixtures/prod-shape/load.sql
SET search_path = public, extensions;
ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS file_size_limit bigint, ADD COLUMN IF NOT EXISTS allowed_mime_types text[];

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

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
\i migrations/073_relay_core.sql
SET search_path = public, extensions;
UPDATE public.relay_workspaces SET enabled = true WHERE kind = 'platform';
\i migrations/074_relay_phase_c.sql
SET search_path = public, extensions;
\i migrations/076_relay_trash_owner.sql
SET search_path = public, extensions;
\i migrations/077_continuity_namespace.sql
SET search_path = public, extensions;
\i migrations/078_continuity_policies.sql
SET search_path = public, extensions;
\i migrations/079_continuity_reopen_lifecycle.sql
SET search_path = public, extensions;
\i migrations/080_continuity_attachments.sql
SET search_path = public, extensions;
INSERT INTO t.saved SELECT 'secrets_before', string_agg(key || '=' || value, ',' ORDER BY key) FROM public.internal_service_secrets;

\i migrations/088_continuity_attachment_cleanup_schedule.sql
SET search_path = public, extensions;

-- C1
DO $$
DECLARE v text := (SELECT value FROM public.internal_service_secrets WHERE key = 'continuity_attachment_cleanup');
BEGIN
  PERFORM t.ok(v ~ '^[0-9a-f]{64}$', 'C1 secret shape');
  PERFORM t.ok(t.as_role('authenticated', 'select 1 from public.internal_service_secrets') = '42501', 'C1 authenticated cannot read');
  PERFORM t.ok(t.as_role('anon', 'select 1 from public.internal_service_secrets') = '42501', 'C1 anon cannot read');
  INSERT INTO t.saved VALUES ('secret', v);
  RAISE NOTICE 'PASS C1: السر مولَّد داخل القاعدة وغير مقروء لغير الخدمة';
END $$;
\i migrations/088_continuity_attachment_cleanup_schedule.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok((SELECT value FROM public.internal_service_secrets WHERE key = 'continuity_attachment_cleanup') = (SELECT v FROM t.saved WHERE k = 'secret'), 'C1 rerun keeps secret');
  PERFORM t.ok((SELECT count(*) FROM public.internal_service_secrets WHERE key <> 'continuity_attachment_cleanup')
               = (SELECT count(*) FROM regexp_split_to_table(nullif((SELECT v FROM t.saved WHERE k = 'secrets_before'), ''), ',')), 'C1 other secrets untouched');
  RAISE NOTICE 'PASS C1-rerun: إعادة التشغيل لا تغيّر السر ولا تمس غيره';
END $$;

-- C2
DO $$
DECLARE v_call bigint; c record;
BEGIN
  v_call := public._continuity_attachment_cleanup_call();
  SELECT * INTO c FROM net._calls WHERE net._calls.id = v_call;
  PERFORM t.ok(c.url = 'https://srnelrdpqkcntbgudyto.supabase.co/functions/v1/continuity-attachment-cleanup', 'C2 url');
  PERFORM t.ok(c.headers ->> 'X-Cleanup-Secret' = (SELECT v FROM t.saved WHERE k = 'secret'), 'C2 header');
  PERFORM t.ok(c.body = '{}'::jsonb, 'C2 no body');
  PERFORM t.ok(t.as_role('authenticated', 'select public._continuity_attachment_cleanup_call()') = '42501', 'C2 authenticated');
  PERFORM t.ok(t.as_role('anon', 'select public._continuity_attachment_cleanup_call()') = '42501', 'C2 anon');
  PERFORM t.ok(t.as_role('service_role', 'select public._continuity_attachment_cleanup_call()') = '42501', 'C2 service_role');
  RAISE NOTICE 'PASS C2: النداء للدالة الصحيحة بالسر في الترويسة فقط؛ مغلقة على كل الأدوار';
END $$;

-- C3
DO $$
DECLARE n int := (SELECT count(*) FROM net._calls);
BEGIN
  DELETE FROM public.internal_service_secrets WHERE key = 'continuity_attachment_cleanup';
  PERFORM t.ok(public._continuity_attachment_cleanup_call() IS NULL AND (SELECT count(*) FROM net._calls) = n, 'C3 no secret no call');
  INSERT INTO public.internal_service_secrets (key, value) VALUES ('continuity_attachment_cleanup', (SELECT v FROM t.saved WHERE k = 'secret'));
  RAISE NOTICE 'PASS C3: بلا سر لا نداء';
END $$;

-- RB
\i migrations/_rollback/088_continuity_attachment_cleanup_schedule.down.sql
DO $$
BEGIN
  PERFORM t.ok(to_regprocedure('public._continuity_attachment_cleanup_call()') IS NULL, 'RB function gone');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.internal_service_secrets WHERE key = 'continuity_attachment_cleanup'), 'RB secret gone');
  RAISE NOTICE 'PASS RB-a: التراجع يحذف الدالة والسر';
END $$;
\i migrations/088_continuity_attachment_cleanup_schedule.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok((SELECT value FROM public.internal_service_secrets WHERE key = 'continuity_attachment_cleanup') <> (SELECT v FROM t.saved WHERE k = 'secret'), 'RB-b new secret');
  RAISE NOTICE 'PASS RB-b: إعادة التطبيق تولّد سرًا جديدًا';
END $$;

\echo 'ALL continuity-attachment-cleanup-schedule tests passed'
