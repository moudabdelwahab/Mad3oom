-- ============================================================================
-- 080_company_members_privacy على نسخة مطابقة لشكل الإنتاج
--
-- F4: company_members() كانت ترجع أسماء وبريد كل تابعي الشركة لأي تابع، أي
-- أن كل عميل يسرد عملاء شركته الآخرين. بعد 080: القائمة الكاملة لمدير الشركة
-- وحده، وغيره يرى نفسه ومديره (بالاسم فقط).
--
--   ⓪ الإعداد + نص الدالة مطابق للإنتاج + الثغرة قائمة قبل 080
--   ① 080
--   ② المدير: مخرَج مطابق حرفيًا لما قبل 080 (+ scope)
--   ③ عميل الشركة: نفسه ومديره فقط، بلا بريد المدير ولا أي عميل آخر
--   ④ عبر الشركات، مالك المنصة وسياقاته، المعاينة، الطاقم، anon، الحساب الموقوف
--   ⑤ المسارات الأخرى ما زالت مغلقة (profiles RLS) والإدارة تعمل
--   ⑥ إعادة التشغيل، حارس النص غير المتوقع، التراجع الحرفي، إعادة التطبيق
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

\i tests/fixtures/prod-shape/load.sql
SET search_path = public, extensions;

DROP SCHEMA IF EXISTS t CASCADE;
CREATE SCHEMA t;
CREATE EXTENSION IF NOT EXISTS dblink SCHEMA t;
GRANT USAGE ON SCHEMA t TO authenticated, service_role, anon;

CREATE FUNCTION t.act(p uuid) RETURNS void LANGUAGE sql AS $$
  select set_config('request.jwt.claim.sub', coalesce(p::text, ''), false),
         set_config('request.jwt.claim.role', case when p is null then '' else 'authenticated' end, false),
         set_config('request.jwt.claims', case when p is null then ''
                      else jsonb_build_object('sub', p, 'role', 'authenticated')::text end, false); $$;
CREATE FUNCTION t.call(p uuid, p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
declare v jsonb;
begin
  perform t.act(p);
  execute 'set local role authenticated';
  execute 'select to_jsonb((' || p_sql || '))' into v;
  execute 'reset role';
  perform t.act(null);
  return v;
exception when others then
  perform t.act(null);
  raise;
end $$;
CREATE FUNCTION t.rows(p uuid, p_sql text) RETURNS int LANGUAGE plpgsql AS $$
declare n int;
begin
  perform t.act(p);
  execute 'set local role authenticated';
  execute p_sql into n;
  execute 'reset role';
  perform t.act(null);
  return n;
end $$;
CREATE FUNCTION t.err_anon(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  perform t.act(null);
  execute 'set local role anon';
  execute p_sql;
  execute 'reset role';
  return 'ok';
exception when others then
  return sqlstate;
end $$;
CREATE FUNCTION t.ok(p_cond boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
begin
  if p_cond is distinct from true then raise exception 'FAIL %', p_label; end if;
end $$;
CREATE FUNCTION t.u(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  select (case p
    when 'OA'  then '00000000-0000-4000-8000-000000000201' when 'OB'  then '00000000-0000-4000-8000-000000000202'
    when 'OW'  then '00000000-0000-4000-8000-0000000002f0'
    when 'A1'  then '00000000-0000-4000-8000-000000000211' when 'A2'  then '00000000-0000-4000-8000-000000000212'
    when 'A3'  then '00000000-0000-4000-8000-000000000213'
    when 'B1'  then '00000000-0000-4000-8000-000000000221' when 'W1'  then '00000000-0000-4000-8000-000000000231'
    when 'PU'  then '00000000-0000-4000-8000-000000000241' when 'SUP' then '00000000-0000-4000-8000-000000000242'
    when 'EA'  then '00000000-0000-4000-8000-000000000243'
    when 'CA'  then 'c0000000-0000-4000-8000-00000000020a' when 'CB'  then 'c0000000-0000-4000-8000-00000000020b'
    when 'CW'  then 'c0000000-0000-4000-8000-00000000020f'
  end)::uuid $$;
CREATE FUNCTION t.ctx(p_context text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
begin
  perform set_config('app.owner_context_write', 'on', true);
  insert into public.owner_context_state (user_id, context, entered_at, expires_at)
  values (t.u('OW'), p_context, now(), now() + interval '12 hours')
  on conflict (user_id) do update set context = excluded.context, entered_at = excluded.entered_at,
                                      expires_at = excluded.expires_at;
  perform set_config('app.owner_context_write', 'off', true);
end $$;
CREATE FUNCTION t.cm(p text) RETURNS jsonb LANGUAGE sql AS $$ select t.call(t.u(p), 'public.company_members()') $$;
CREATE FUNCTION t.ids(p jsonb) RETURNS text LANGUAGE sql AS $$
  select coalesce(string_agg(e ->> 'id', ',' order by e ->> 'id'), '') from jsonb_array_elements(p -> 'members') e $$;
CREATE FUNCTION t.idset(VARIADIC p text[]) RETURNS text LANGUAGE sql AS $$
  select string_agg(t.u(x)::text, ',' order by t.u(x)::text) from unnest(p) x $$;
CREATE FUNCTION t.fn_md5() RETURNS text LANGUAGE sql AS $$
  select md5(pg_get_functiondef('public.company_members()'::regprocedure)) $$;
CREATE FUNCTION t.others_digest() RETURNS text LANGUAGE sql AS $$
  select md5(concat_ws('#',
    (select string_agg(pg_get_functiondef(p.oid), '#' order by p.oid::regprocedure::text)
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname <> 'company_members' and p.prokind = 'f'),
    (select string_agg(concat_ws('|', tablename, policyname, permissive, cmd, qual, with_check), '#'
                       order by tablename, policyname) from pg_policies))) $$;
CREATE TABLE t.saved (k text PRIMARY KEY, v text);
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ── الفاعلون ──────────────────────────────────────────────────────────────
--  OA مالك أ (بلا اسم ولا اسم مستخدم: يختبر ألا يتحوّل بريده إلى «اسم»)
--  OB مالك ب · OW مالك المنصة ويملك W · A1..A3 عملاء أ · B1 عميل ب · W1 عميل W
--  PU مستخدم بلا شركة · SUP دعم · EA أدمن مرتفع
INSERT INTO auth.users (id, email)
SELECT t.u(n), lower(n) || '@t.io'
  FROM unnest(array['OA','OB','OW','A1','A2','A3','B1','W1','PU','SUP','EA']) n;
INSERT INTO public.profiles (id, email, full_name, username, role, phone, created_at) VALUES
  (t.u('OA'),  'oa@t.io',  NULL,          NULL, 'user',           '01000000201', '2026-09-01'),
  (t.u('OB'),  'ob@t.io',  'مالك ب',      NULL, 'user',           '01000000202', '2026-09-01'),
  (t.u('OW'),  'ow@t.io',  'مالك المنصة', NULL, 'platform_owner', '01000000203', '2026-09-01'),
  (t.u('PU'),  'pu@t.io',  'مستخدم',      NULL, 'user',           '01000000241', '2026-09-01'),
  (t.u('SUP'), 'sup@t.io', 'دعم',         NULL, 'support',        '01000000242', '2026-09-01'),
  (t.u('EA'),  'ea@t.io',  'أدمن مرتفع',  NULL, 'admin',          '01000000243', '2026-09-01');
INSERT INTO public.platform_authority (user_id, level) VALUES (t.u('OW'), 'owner'), (t.u('EA'), 'elevated_admin');
INSERT INTO public.companies (id, user_id, company_name, commercial_registration_number) VALUES
  (t.u('CA'), t.u('OA'), 'شركة أ', 'CR-PA'), (t.u('CB'), t.u('OB'), 'شركة ب', 'CR-PB'),
  (t.u('CW'), t.u('OW'), 'شركة المالك', 'CR-PW');
INSERT INTO public.profiles (id, email, full_name, role, phone, super_user_id, created_at) VALUES
  (t.u('A1'), 'a1@t.io', 'عميل أ1', 'user', '01000000211', t.u('OA'), '2026-09-02'),
  (t.u('A2'), 'a2@t.io', 'عميل أ2', 'user', '01000000212', t.u('OA'), '2026-09-03'),
  (t.u('A3'), 'a3@t.io', 'عميل أ3', 'user', '01000000213', t.u('OA'), '2026-09-04'),
  (t.u('B1'), 'b1@t.io', 'عميل ب1', 'user', '01000000221', t.u('OB'), '2026-09-02'),
  (t.u('W1'), 'w1@t.io', 'عميل W1', 'user', '01000000231', t.u('OW'), '2026-09-02');
INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, company_id) VALUES
  (t.u('OA'), 'support', 'active', 'monthly', now() - interval '5 days', now() + interval '25 days', 30, t.u('CA')),
  (t.u('OB'), 'support', 'active', 'monthly', now() - interval '5 days', now() + interval '25 days', 30, t.u('CB')),
  (t.u('OW'), 'support', 'active', 'monthly', now() - interval '5 days', now() + interval '25 days', 30, t.u('CW'));
INSERT INTO public.tickets (id, user_id, title, description) VALUES
  ('e0000000-0000-4000-8000-000000000212', t.u('A2'), 'تذكرة العميل أ2', 'وصف');

-- ══ ⓪ قبل 080 ════════════════════════════════════════════════════════════
DO $$
DECLARE v jsonb;
BEGIN
  PERFORM t.ok(t.fn_md5() = '0e4030f30af1586d7f8f2ced6c3e7307', '⓪ نص الدالة في النسخة = نص الإنتاج (md5 ' || t.fn_md5() || ')');
  PERFORM t.act(t.u('OA'));
  PERFORM t.ok(public.is_company_admin() AND public.account_is_active() AND public.can_manage_company_members(), '⓪ OA مدير');
  PERFORM t.act(t.u('A1'));
  PERFORM t.ok(public.is_company_member() AND NOT public.is_company_admin(), '⓪ A1 عضو');
  PERFORM t.act(null);
  v := t.cm('A1');
  PERFORM t.ok(v::text LIKE '%a2@t.io%' AND v::text LIKE '%a3@t.io%' AND v::text LIKE '%oa@t.io%',
               '⓪ الثغرة قائمة: A1 يرى بريد A2 وA3 والمدير');
  RAISE NOTICE 'PASS ⓪ قبل 080: عميل الشركة يسرد أسماء وبريد كل عملائها (F4 مُعاد إنتاجه)';
END $$;
INSERT INTO t.saved VALUES ('oa', t.cm('OA')::text), ('ob', t.cm('OB')::text), ('others', t.others_digest());
SELECT t.ctx('company_admin');
INSERT INTO t.saved VALUES ('ow', t.cm('OW')::text);
SELECT t.ctx('admin');

-- ══ ① 080 ════════════════════════════════════════════════════════════════
\i migrations/080_company_members_privacy.sql

-- ══ ② المدير ═════════════════════════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ok(t.cm('OA') = (SELECT s.v::jsonb FROM t.saved s WHERE k = 'oa') || '{"scope":"full"}', '② OA: نفس المخرَج حرفيًا + scope');
  PERFORM t.ok(t.cm('OB') = (SELECT s.v::jsonb FROM t.saved s WHERE k = 'ob') || '{"scope":"full"}', '② OB كذلك');
  PERFORM t.ok(t.ids(t.cm('OA')) = t.idset('OA', 'A1', 'A2', 'A3'), '② OA يرى كل عملائه');
  PERFORM t.ok((t.cm('OA') ->> 'can_manage')::boolean, '② can_manage كما هو');
  RAISE NOTICE 'PASS ② مدير الشركة: المخرَج مطابق لما قبل 080 حرفيًا (إدارة الأعضاء لم تتغير)';
END $$;

-- ══ ③ عميل الشركة ════════════════════════════════════════════════════════
DO $$
DECLARE v jsonb; n text;
BEGIN
  FOREACH n IN ARRAY array['A1', 'A2', 'A3'] LOOP
    v := t.cm(n);
    PERFORM t.ok(v ->> 'scope' = 'self' AND (v ->> 'company_id')::uuid = t.u('CA'), '③ ' || n || ' scope self');
    PERFORM t.ok(t.ids(v) = t.idset('OA', n), '③ ' || n || ' يرى نفسه ومديره فقط: ' || t.ids(v));
    PERFORM t.ok(NOT (v::text LIKE '%oa@t.io%'), '③ ' || n || ' لا يرى بريد المدير');
    PERFORM t.ok(v::text LIKE '%' || lower(n) || '@t.io%', '③ ' || n || ' يرى بريده هو');
    PERFORM t.ok(NOT (v ->> 'can_manage')::boolean AND NOT (v ->> 'is_owner')::boolean, '③ ' || n || ' لا إدارة');
    PERFORM t.ok(v -> 'members' -> 0 ->> 'name' = 'مدير الشركة', '③ اسم المدير البديل لا بريده: ' || (v -> 'members' -> 0 ->> 'name'));
  END LOOP;
  v := t.cm('A1');
  PERFORM t.ok(NOT (v::text LIKE '%a2@t.io%') AND NOT (v::text LIKE '%a3@t.io%')
               AND NOT (v::text LIKE '%عميل أ2%') AND NOT (v::text LIKE '%عميل أ3%')
               AND NOT (v::text LIKE '%' || t.u('A2') || '%') AND NOT (v::text LIKE '%' || t.u('A3') || '%')
               AND NOT (v::text LIKE '%0100000021%'), '③ لا اسم ولا بريد ولا معرّف ولا هاتف لعميل آخر');
  PERFORM t.ok(v -> 'members' -> 0 -> 'email' = 'null'::jsonb, '③ بريد المدير null صراحة');
  -- المدير باسم: يظهر الاسم لا البريد
  v := t.cm('B1');
  PERFORM t.ok(t.ids(v) = t.idset('OB', 'B1') AND v -> 'members' -> 0 ->> 'name' = 'مالك ب' AND NOT (v::text LIKE '%ob@t.io%'), '③ B1');
  RAISE NOTICE 'PASS ③ عميل الشركة يرى نفسه ومديره بالاسم فقط — لا تعداد للعملاء الآخرين';
END $$;

-- ══ ④ عبر الشركات والمنصة ════════════════════════════════════════════════
DO $$
DECLARE v jsonb;
BEGIN
  PERFORM t.ok(NOT (t.cm('B1')::text LIKE '%' || t.u('A1') || '%') AND NOT (t.cm('OB')::text LIKE '%a1@t.io%'), '④ ب لا ترى أ');
  PERFORM t.ok(NOT (t.cm('OA')::text LIKE '%b1@t.io%'), '④ أ لا ترى ب');
  PERFORM t.ok(t.cm('PU') IS NULL AND t.cm('SUP') IS NULL AND t.cm('EA') IS NULL, '④ بلا شركة / طاقم: null كما كان');

  PERFORM t.ctx('company_admin');
  v := t.cm('OW');
  PERFORM t.ok(v = (SELECT s.v::jsonb FROM t.saved s WHERE k = 'ow') || '{"scope":"full"}' AND t.ids(v) = t.idset('OW', 'W1'),
               '④ مالك المنصة في سياق company_admin: شركته كاملة كما كانت');
  PERFORM t.ctx('owner');
  PERFORM t.ok(t.cm('OW') ->> 'scope' = 'full' AND t.ids(t.cm('OW')) = t.idset('OW', 'W1'), '④ سياق owner: شركته فقط');
  PERFORM t.ctx('admin');
  v := t.cm('OW');
  PERFORM t.ok(v ->> 'scope' = 'self' AND t.ids(v) = t.idset('OW') AND NOT (v::text LIKE '%w1@t.io%'), '④ سياق admin: لا قائمة');
  PERFORM t.ctx('company_user_preview');
  v := t.cm('OW');
  PERFORM t.ok(v ->> 'scope' = 'self' AND NOT (v::text LIKE '%w1@t.io%'), '④ المعاينة ترى ما يراه العضو لا ما يراه المدير');
  PERFORM t.ctx('admin');

  -- مدير موقوف: لا قائمة كاملة
  UPDATE public.profiles SET ban_status = 'banned' WHERE id = t.u('OB');
  v := t.cm('OB');
  PERFORM t.ok(v ->> 'scope' = 'self' AND NOT (v::text LIKE '%b1@t.io%'), '④ مدير محظور: لا قائمة');
  UPDATE public.profiles SET ban_status = 'none' WHERE id = t.u('OB');
  PERFORM t.ok(t.cm('OB') ->> 'scope' = 'full', '④ رفع الحظر يعيدها');
  RAISE NOTICE 'PASS ④ لا عبور بين الشركات؛ مالك المنصة يرى شركته في سياقها فقط؛ المعاينة والحظر لا قائمة';
END $$;
SELECT 'PASS ④ anon: ' || t.err_anon('select public.company_members()') WHERE t.err_anon('select public.company_members()') = '42501';
DO $$
BEGIN
  PERFORM t.ok(NOT has_function_privilege('anon', 'public.company_members()', 'EXECUTE')
               AND has_function_privilege('authenticated', 'public.company_members()', 'EXECUTE'), '④ الصلاحيات كما هي');
  RAISE NOTICE 'PASS ④ صلاحيات الدالة لم تتغير';
END $$;

-- ══ ⑤ المسارات الأخرى والإدارة ═══════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ok(t.rows(t.u('A1'), format('select count(*)::int from public.profiles where id = %L', t.u('A2'))) = 0, '⑤ profiles: A1 لا يقرأ A2');
  PERFORM t.ok(t.rows(t.u('A1'), format('select count(*)::int from public.profiles where super_user_id = %L', t.u('OA'))) = 1, '⑤ profiles: A1 يقرأ نفسه فقط');
  PERFORM t.ok(t.rows(t.u('A1'), 'select count(*)::int from public.tickets where title = ''تذكرة العميل أ2''') = 0, '⑤ تذاكر A2 مخفية عن A1');
  PERFORM t.ok(t.rows(t.u('OA'), format('select count(*)::int from public.profiles where id = %L', t.u('A2'))) = 1, '⑤ المدير يقرأ عميله');
  PERFORM t.call(t.u('OA'), format('public.remove_company_member(%L::uuid)', t.u('A3')));
  PERFORM t.ok(t.ids(t.cm('OA')) = t.idset('OA', 'A1', 'A2') AND t.cm('A3') IS NULL, '⑤ الإزالة تعمل، والمُزال بلا شركة');
  RAISE NOTICE 'PASS ⑤ لا مسار بديل للتعداد (profiles/tickets)، وإدارة الأعضاء تعمل';
END $$;

-- ══ ⑥ إعادة التشغيل، الحارس، التراجع، إعادة التطبيق ═════════════════════
INSERT INTO t.saved VALUES ('fn080', t.fn_md5());
\i migrations/080_company_members_privacy.sql
DO $$
BEGIN
  PERFORM t.ok(t.fn_md5() = (SELECT s.v FROM t.saved s WHERE k = 'fn080'), '⑥ إعادة التشغيل لا تغيّر شيئًا');
  PERFORM t.ok(t.others_digest() = (SELECT s.v FROM t.saved s WHERE k = 'others'), '⑥ لا دالة أخرى ولا سياسة تغيّرت');
  RAISE NOTICE 'PASS ⑥ إعادة تشغيل 080 آمنة، ولم يتغير غير company_members()';
END $$;

-- نص ثالث (تعديل يدوي على الإنتاج مثلًا): 080 يرفض بدل الكتابة فوقه
\set mig_sql `cat migrations/080_company_members_privacy.sql`
SELECT set_config('t.mig_sql', :'mig_sql', false) IS NOT NULL;
DO $$
DECLARE c text;
BEGIN
  PERFORM t.dblink_connect('g', format('dbname=%s port=%s host=%s user=postgres', current_database(),
            current_setting('port'), split_part(current_setting('unix_socket_directories'), ',', 1)));
  PERFORM t.dblink_exec('g', 'begin');
  PERFORM t.dblink_exec('g', $s$create or replace function public.company_members() returns jsonb language sql stable security definer set search_path to 'public' as $f$ select null::jsonb $f$ $s$);
  BEGIN
    PERFORM t.dblink_exec('g', current_setting('t.mig_sql'));
    c := 'ok';
  EXCEPTION WHEN others THEN c := sqlerrm;
  END;
  PERFORM t.dblink_exec('g', 'rollback');
  PERFORM t.dblink_disconnect('g');
  PERFORM t.ok(c LIKE '%ليست نص الإنتاج المتوقع%', '⑥ الحارس: ' || c);
  PERFORM t.ok(t.fn_md5() = (SELECT s.v FROM t.saved s WHERE k = 'fn080'), '⑥ لا أثر');
  RAISE NOTICE 'PASS ⑥ 080 يرفض الكتابة فوق نص غير متوقع';
END $$;

\i migrations/_rollback/080_company_members_privacy.down.sql
DO $$
BEGIN
  PERFORM t.ok(t.fn_md5() = '0e4030f30af1586d7f8f2ced6c3e7307', '⑥ التراجع يعيد نص الإنتاج حرفيًا');
  PERFORM t.ok(t.cm('A1')::text LIKE '%a2@t.io%', '⑥ بعد التراجع تعود الثغرة (موثّق في ملف التراجع)');
  RAISE NOTICE 'PASS ⑥ التراجع حرفي (md5 = الإنتاج)';
END $$;

\i migrations/080_company_members_privacy.sql
DO $$
BEGIN
  PERFORM t.ok(t.fn_md5() = (SELECT s.v FROM t.saved s WHERE k = 'fn080') AND t.cm('A1') ->> 'scope' = 'self', '⑥ إعادة التطبيق');
  RAISE NOTICE 'PASS ⑥ إعادة التطبيق بعد التراجع';
END $$;

SELECT 'ALL company-members-privacy checks PASSED';
