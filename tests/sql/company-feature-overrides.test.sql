-- ============================================================================
-- استثناء امتياز لشركة بعينها (091) على نسخة مطابقة لشكل الإنتاج:
--   F0  تعريف company_has_feature في النسخة = بصمة الإنتاج قبل 091
--   F1  شرط الباقة لا يتغير: شركة مشتركة تحتفظ بامتيازها، وغير المشتركة بلا امتياز
--   F2  الاستثناء يمنح شركته وحدها، ولهذا الامتياز وحده
--   F3  الاستثناء المنتهي لا يمنح شيئًا
--   F4  قيد التجربة: لا استثناء إلا لـ integrations_hub
--   F5  الجدول مغلق: لا قراءة ولا كتابة لأي دور، والدالة بصلاحياتها السابقة
--   RB  التراجع يعيد التعريف حرفيًا ويحذف الجدول؛ إعادة التطبيق تعمل
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
-- company_has_feature كما يراها مستخدم مسجّل (auth.uid() من request.jwt.claim.sub)
CREATE FUNCTION t.has(p_user uuid, p_feature text) RETURNS boolean LANGUAGE plpgsql AS $$
declare v boolean;
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  execute 'set local role authenticated';
  v := public.company_has_feature(p_feature);
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  return v;
end $$;
CREATE FUNCTION t.u(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  select (md5('cfo:' || p))::uuid $$;
CREATE TABLE t.saved (k text PRIMARY KEY, v text);
GRANT USAGE ON SCHEMA t TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO anon, authenticated, service_role;

-- F0
DO $$
BEGIN
  PERFORM t.ok(md5(pg_get_functiondef('public.company_has_feature(text)'::regprocedure)) = '82ff4a3898fe0a0bdac756767119f0cf',
               'F0 fixture definition = production fingerprint');
  INSERT INTO t.saved VALUES ('acl', (SELECT proacl::text FROM pg_proc WHERE oid = 'public.company_has_feature(text)'::regprocedure));
  RAISE NOTICE 'PASS F0: التعريف في النسخة يطابق الإنتاج';
END $$;

-- البيانات: شركتان؛ الأولى مشتركة في باقة فيها api_tokens، والثانية بلا اشتراك
INSERT INTO auth.users (id, email) VALUES (t.u('OA'), 'oa@cfo.io'), (t.u('OB'), 'ob@cfo.io');
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at) VALUES
  (t.u('OA'), 'oa@cfo.io', 'مالك أ', 'user', '01000000801', '2026-09-01'),
  (t.u('OB'), 'ob@cfo.io', 'مالك ب', 'user', '01000000802', '2026-09-01');
INSERT INTO public.companies (id, user_id, company_name, commercial_registration_number) VALUES
  (t.u('CA'), t.u('OA'), 'شركة أ', 'CR-CFO-A'), (t.u('CB'), t.u('OB'), 'شركة ب', 'CR-CFO-B');
INSERT INTO public.feature_flags (key, name) VALUES ('integrations_hub', 'Integrations Hub') ON CONFLICT DO NOTHING;
INSERT INTO public.feature_flags (key, name) VALUES ('api_tokens', 'API tokens') ON CONFLICT DO NOTHING;
-- باقة 'support' من بيانات الإنتاج؛ نضمن أن فيها api_tokens وليس فيها integrations_hub
DELETE FROM public.plan_features WHERE feature_key = 'integrations_hub';
INSERT INTO public.plan_features (plan_id, feature_key, enabled)
SELECT sp.id, 'api_tokens', true FROM public.subscription_plans sp WHERE sp.key = 'support'
   AND NOT EXISTS (SELECT 1 FROM public.plan_features pf WHERE pf.plan_id = sp.id AND pf.feature_key = 'api_tokens');
UPDATE public.plan_features pf SET enabled = true FROM public.subscription_plans sp
 WHERE sp.id = pf.plan_id AND sp.key = 'support' AND pf.feature_key = 'api_tokens';
INSERT INTO public.whatsapp_subscriptions (user_id, company_id, plan, status, start_date, end_date)
VALUES (t.u('OA'), t.u('CA'), 'support', 'active', now() - interval '1 day', now() + interval '30 days');

DO $$
BEGIN
  PERFORM t.ok(t.has(t.u('OA'), 'api_tokens'), 'pre plan grants A');
  PERFORM t.ok(NOT t.has(t.u('OB'), 'api_tokens'), 'pre B has nothing');
  PERFORM t.ok(NOT t.has(t.u('OA'), 'integrations_hub') AND NOT t.has(t.u('OB'), 'integrations_hub'), 'pre nobody has hub');
END $$;

\i migrations/091_company_feature_overrides.sql
SET search_path = public, extensions;

-- F1
DO $$
BEGIN
  PERFORM t.ok(t.has(t.u('OA'), 'api_tokens'), 'F1 plan path unchanged (A)');
  PERFORM t.ok(NOT t.has(t.u('OB'), 'api_tokens'), 'F1 plan path unchanged (B)');
  PERFORM t.ok(NOT t.has(t.u('OB'), 'integrations_hub'), 'F1 no override, no hub');
  RAISE NOTICE 'PASS F1: شرط الباقة كما هو';
END $$;

-- F2
INSERT INTO public.company_feature_overrides (company_id, feature_key, reason) VALUES (t.u('CB'), 'integrations_hub', 'pilot');
DO $$
BEGIN
  PERFORM t.ok(t.has(t.u('OB'), 'integrations_hub'), 'F2 override grants B');
  PERFORM t.ok(NOT t.has(t.u('OA'), 'integrations_hub'), 'F2 does not leak to A');
  PERFORM t.ok(NOT t.has(t.u('OB'), 'api_tokens'), 'F2 does not grant other features');
  PERFORM t.ok(public.company_has_feature('integrations_hub') IS FALSE, 'F2 anonymous caller gets nothing');
  RAISE NOTICE 'PASS F2: الاستثناء لشركته ولامتيازه فقط';
END $$;

-- F3
UPDATE public.company_feature_overrides SET expires_at = now() - interval '1 minute' WHERE company_id = t.u('CB');
DO $$
BEGIN
  PERFORM t.ok(NOT t.has(t.u('OB'), 'integrations_hub'), 'F3 expired override grants nothing');
  RAISE NOTICE 'PASS F3: الاستثناء المنتهي لا يمنح';
END $$;
UPDATE public.company_feature_overrides SET expires_at = now() + interval '30 days' WHERE company_id = t.u('CB');

-- F4
DO $$
BEGIN
  BEGIN
    INSERT INTO public.company_feature_overrides (company_id, feature_key, reason) VALUES (t.u('CB'), 'api_tokens', 'nope');
    PERFORM t.ok(false, 'F4 non-pilot feature must be rejected');
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS F4: لا استثناء إلا لـ integrations_hub';
END $$;

-- F5
DO $$
BEGIN
  PERFORM t.ok(t.as_role('authenticated', 'select 1 from public.company_feature_overrides') = '42501', 'F5 authenticated cannot read');
  PERFORM t.ok(t.as_role('anon', 'select 1 from public.company_feature_overrides') = '42501', 'F5 anon cannot read');
  PERFORM t.ok(t.as_role('service_role', 'select 1 from public.company_feature_overrides') = '42501', 'F5 service_role cannot read');
  PERFORM t.ok(t.as_role('authenticated', format('insert into public.company_feature_overrides (company_id, feature_key, reason) values (%L, %L, %L)', t.u('CA'), 'integrations_hub', 'self-grant')) = '42501', 'F5 authenticated cannot self-grant');
  PERFORM t.ok((SELECT proacl::text FROM pg_proc WHERE oid = 'public.company_has_feature(text)'::regprocedure) = (SELECT v FROM t.saved WHERE k = 'acl'), 'F5 function grants unchanged');
  RAISE NOTICE 'PASS F5: الجدول مغلق على كل الأدوار، وصلاحيات الدالة كما هي';
END $$;

-- إعادة التشغيل لا تمس الصفوف
\i migrations/091_company_feature_overrides.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok((SELECT count(*) FROM public.company_feature_overrides) = 1 AND t.has(t.u('OB'), 'integrations_hub'), 'rerun keeps rows');
  RAISE NOTICE 'PASS rerun: إعادة التطبيق لا تمس الاستثناءات';
END $$;

-- RB
\i migrations/_rollback/091_company_feature_overrides.down.sql
DO $$
BEGIN
  PERFORM t.ok(md5(pg_get_functiondef('public.company_has_feature(text)'::regprocedure)) = '82ff4a3898fe0a0bdac756767119f0cf',
               'RB definition restored byte for byte');
  PERFORM t.ok((SELECT proacl::text FROM pg_proc WHERE oid = 'public.company_has_feature(text)'::regprocedure) = (SELECT v FROM t.saved WHERE k = 'acl'), 'RB grants unchanged');
  PERFORM t.ok(to_regclass('public.company_feature_overrides') IS NULL, 'RB table gone');
  PERFORM t.ok(NOT t.has(t.u('OB'), 'integrations_hub') AND t.has(t.u('OA'), 'api_tokens'), 'RB behaviour back to plan-only');
  RAISE NOTICE 'PASS RB-a: التراجع يعيد التعريف حرفيًا ويحذف الجدول';
END $$;
\i migrations/091_company_feature_overrides.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok(to_regclass('public.company_feature_overrides') IS NOT NULL AND (SELECT count(*) FROM public.company_feature_overrides) = 0, 'RB-b reapply');
  RAISE NOTICE 'PASS RB-b: إعادة التطبيق بعد التراجع تعمل';
END $$;

\echo 'ALL company-feature-overrides tests passed'
