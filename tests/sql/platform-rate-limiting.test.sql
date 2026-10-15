-- ============================================================================
-- حدّ المعدل على مستوى المنصة (103) على نسخة مطابقة لشكل الإنتاج
--
--   EQ  sie_rl_spend بعد 103 ≡ جسم الإنتاج قبل 103 (نفس التوكنز والقرار لكل نداء)
--   SIE sie_rate_limit_hit / integration_rate_limit_hit / الحدود الفعالة كما هي
--   PR  الصلاحيات: anon/authenticated لا ينادون rate_limit_hit ولا الداخليات ولا يقرؤون السياسات
--   F   السلوك: تحت الحد يمر، فوقه يُرفض، Retry-After معقول، إعادة الملء، observe/off، سياسة مجهولة
--   ID  هوية الدلو: كل موضوع في دلوه، التطبيع، المجهول دلو واحد مشترك، لا IP ولا بريد خام في المفتاح
--   CC  التزامن بعشر جلسات حقيقية (dblink): السعة لا تُتجاوز
--   AD  الإدارة: القراءة للأدمن، التعديل للمالك وحده وبسبب، السجل، إعادة ضبط موضوع
--   SW  الكنس: القديم من rl:/ip: فقط؛ user:/integration: والنشِط لا يُمسّان
--   RB  التراجع يعيد sie_rl_spend حرفيًا ولا يمس دلاء SIE؛ إعادة التطبيق تعمل
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

\i tests/fixtures/prod-shape/load.sql
SET search_path = public, extensions;

DROP SCHEMA IF EXISTS t CASCADE;
CREATE SCHEMA t;
CREATE EXTENSION IF NOT EXISTS dblink SCHEMA t;
CREATE FUNCTION t.ok(p_cond boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
begin
  if p_cond is distinct from true then raise exception 'FAIL %', p_label; end if;
end $$;
CREATE FUNCTION t.act(p uuid, p_role text DEFAULT 'authenticated') RETURNS void LANGUAGE sql AS $$
  select set_config('request.jwt.claim.sub', coalesce(p::text, ''), false),
         set_config('request.jwt.claim.role', coalesce(p_role, ''), false); $$;
-- Runs p_sql as a database role with the given JWT identity; returns 'ok' or the SQLSTATE.
CREATE FUNCTION t.as_role(p_role text, p_uid uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  perform t.act(p_uid, p_role);
  execute format('set local role %I', p_role);
  execute p_sql;
  execute 'reset role';
  perform t.act(null, '');
  return 'ok';
exception when others then
  execute 'reset role';
  perform t.act(null, '');
  return sqlstate;
end $$;
CREATE FUNCTION t.val(p_role text, p_uid uuid, p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
declare v jsonb;
begin
  perform t.act(p_uid, p_role);
  execute format('set local role %I', p_role);
  execute 'select to_jsonb(x) from (' || p_sql || ') x' into v;
  execute 'reset role';
  perform t.act(null, '');
  return v;
end $$;
CREATE FUNCTION t.hit(p_policy text, p_subject text) RETURNS jsonb LANGUAGE sql AS $$
  select t.val('service_role', null, format('select * from public.rate_limit_hit(%L, %L)', p_policy, p_subject)) $$;
CREATE FUNCTION t.age(p_like text, p_seconds int) RETURNS void LANGUAGE sql AS $$
  update public.sie_rate_limit_buckets
     set updated_at = updated_at - make_interval(secs => p_seconds),
         last_request_at = last_request_at - make_interval(secs => p_seconds),
         window_started_at = window_started_at - make_interval(secs => p_seconds)
   where bucket_key like p_like $$;
CREATE FUNCTION t.conn(p_name text) RETURNS text LANGUAGE sql AS $$
  select t.dblink_connect(p_name, format('dbname=%s port=%s host=%s user=postgres', current_database(),
         current_setting('port'), split_part(current_setting('unix_socket_directories'), ',', 1))); $$;
CREATE TABLE t.saved (k text PRIMARY KEY, v text);
CREATE TABLE t.trace (phase text, run int, step int, tokens double precision, allowed boolean, PRIMARY KEY (phase, run, step));
GRANT USAGE ON SCHEMA t TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO anon, authenticated, service_role;

-- Fixture accounts (triggers off: this is setup, not behaviour under test).
SET session_replication_role = replica;
INSERT INTO auth.users (id, email) VALUES
  ('10300000-0000-4000-8000-000000000001', 'owner@t.io'),
  ('10300000-0000-4000-8000-000000000002', 'admin@t.io'),
  ('10300000-0000-4000-8000-000000000003', 'customer@t.io'),
  ('10300000-0000-4000-8000-000000000004', 'sie-customer@t.io');
INSERT INTO public.profiles (id, email, full_name, role) VALUES
  ('10300000-0000-4000-8000-000000000001', 'owner@t.io', 'مالك', 'platform_owner'),
  ('10300000-0000-4000-8000-000000000002', 'admin@t.io', 'أدمن', 'admin'),
  ('10300000-0000-4000-8000-000000000003', 'customer@t.io', 'عميل', 'user'),
  ('10300000-0000-4000-8000-000000000004', 'sie-customer@t.io', 'عميل SIE', 'user');
INSERT INTO public.platform_authority (user_id, level) VALUES ('10300000-0000-4000-8000-000000000001', 'owner');
SET session_replication_role = origin;

-- ══ ⓪ قبل 103: تتبّع sie_rl_spend الإنتاجية ═══════════════════════════════
-- Each run: 30 spends on one key, ageing the bucket between some of them, for
-- several (limit, burst) shapes including a negative burst and limit 1.
CREATE FUNCTION t.trace_run(p_phase text) RETURNS void LANGUAGE plpgsql AS $$
declare
  shapes int[][] := array[[100, 20], [1, 0], [10, 500], [7, -5], [5000, 0]];
  i int; s int; r record; k text;
begin
  for i in 1 .. array_length(shapes, 1) loop
    k := 'eqtest:' || i;
    delete from public.sie_rate_limit_buckets where bucket_key = k;
    for s in 1 .. 30 loop
      if s in (8, 15, 22) then perform t.age(k, s * 3); end if;
      select * into r from public.sie_rl_spend(k, shapes[i][1], shapes[i][2]);
      insert into t.trace values (p_phase, i, s, round(r.tokens::numeric, 9)::double precision, r.allowed);
    end loop;
    delete from public.sie_rate_limit_buckets where bucket_key = k;
  end loop;
end $$;
SELECT t.trace_run('before');
INSERT INTO t.saved SELECT 'sie_rl_spend_src', md5(prosrc) FROM pg_proc WHERE oid = 'public.sie_rl_spend(text,integer,integer)'::regprocedure;
INSERT INTO t.saved SELECT 'sie_rl_spend_acl', proacl::text FROM pg_proc WHERE oid = 'public.sie_rl_spend(text,integer,integer)'::regprocedure;

-- SIE limiter outcomes before 103 (customer with access row + integration client)
INSERT INTO public.customer_sie_access (user_id) VALUES ('10300000-0000-4000-8000-000000000004') ON CONFLICT DO NOTHING;
CREATE FUNCTION t.sie_snapshot(p_phase text) RETURNS void LANGUAGE plpgsql AS $$
declare v jsonb; n int;
begin
  delete from public.sie_rate_limit_buckets where bucket_key = 'user:10300000-0000-4000-8000-000000000004';
  for n in 1 .. 3 loop
    v := t.val('authenticated', '10300000-0000-4000-8000-000000000004', 'select * from public.sie_rate_limit_hit(null)');
    insert into t.saved values (p_phase || ':sie:' || n, v::text);
  end loop;
  insert into t.saved select p_phase || ':eff', to_jsonb(e)::text
    from public.sie_rl_effective_limits('10300000-0000-4000-8000-000000000004') e;
  delete from public.sie_rate_limit_buckets where bucket_key = 'user:10300000-0000-4000-8000-000000000004';
end $$;
SELECT t.sie_snapshot('before');

-- ══ ① 103 ════════════════════════════════════════════════════════════════
\i migrations/103_platform_rate_limiting.sql
SET search_path = public, extensions;

DO $$ BEGIN
  PERFORM t.trace_run('after');
  PERFORM t.ok((SELECT count(*) FROM t.trace WHERE phase = 'before') = 150, 'EQ trace size');
  PERFORM t.ok(NOT EXISTS (
    SELECT 1 FROM t.trace a JOIN t.trace b USING (run, step)
     WHERE a.phase = 'before' AND b.phase = 'after'
       AND (a.tokens IS DISTINCT FROM b.tokens OR a.allowed IS DISTINCT FROM b.allowed)), 'EQ every spend identical');
  PERFORM t.ok((SELECT count(*) FILTER (WHERE NOT allowed) FROM t.trace WHERE phase = 'after') > 0, 'EQ trace exercises rejections');
  PERFORM t.ok((SELECT proacl::text FROM pg_proc WHERE oid = 'public.sie_rl_spend(text,integer,integer)'::regprocedure)
               = (SELECT v FROM t.saved WHERE k = 'sie_rl_spend_acl'), 'EQ sie_rl_spend grants unchanged');
  RAISE NOTICE 'PASS EQ: sie_rl_spend بعد 103 تعطي نفس التوكنز والقرار لكل نداء (150 نداء، 5 أشكال) وبنفس الصلاحيات';
END $$;

DO $$ BEGIN
  PERFORM t.sie_snapshot('after');
  PERFORM t.ok((SELECT string_agg(v, '|' ORDER BY k) FROM t.saved WHERE k LIKE 'before:%')
             = (SELECT string_agg(v, '|' ORDER BY k) FROM t.saved WHERE k LIKE 'after:%'), 'SIE hit + effective limits identical');
  PERFORM t.ok((SELECT v::jsonb ->> 'limit_per_min' FROM t.saved WHERE k = 'after:sie:1') = '100', 'SIE default 100/min preserved');
  PERFORM t.ok((SELECT (v::jsonb ->> 'remaining')::int FROM t.saved WHERE k = 'after:sie:3') = 117, 'SIE burst 20 preserved (120 - 3)');
  PERFORM t.ok(has_function_privilege('anon', 'public.sie_rate_limit_hit(text)', 'EXECUTE'), 'SIE grants untouched by 103');
  RAISE NOTICE 'PASS SIE: حد SIE (100/دقيقة + 20) والحدود الفعالة والصلاحيات كما هي';
END $$;

-- ══ PR الصلاحيات ═══════════════════════════════════════════════════════════
DO $$
DECLARE c uuid := '10300000-0000-4000-8000-000000000003';
BEGIN
  PERFORM t.ok(t.as_role('anon', null, $q$select * from public.rate_limit_hit('public.form.ip', '1.2.3.4')$q$) = '42501', 'PR anon hit');
  PERFORM t.ok(t.as_role('authenticated', c, $q$select * from public.rate_limit_hit('ai.generate.user', 'x')$q$) = '42501', 'PR authenticated hit');
  PERFORM t.ok(t.as_role('authenticated', c, $q$select * from public.rl_spend('rl:x', 5, 1)$q$) = '42501', 'PR rl_spend');
  PERFORM t.ok(t.as_role('service_role', null, $q$select * from public.rl_spend('rl:x', 5, 1)$q$) = '42501', 'PR rl_spend service_role');
  PERFORM t.ok(t.as_role('authenticated', c, $q$select public._rl_bucket_key('a.b', 'x')$q$) = '42501', 'PR bucket key');
  PERFORM t.ok(t.as_role('authenticated', c, $q$select public.rate_limit_sweep(1)$q$) = '42501', 'PR sweep');
  PERFORM t.ok(t.as_role('anon', null, $q$select 1 from public.rate_limit_policies$q$) = '42501', 'PR anon policies');
  PERFORM t.ok(t.as_role('authenticated', c, $q$update public.rate_limit_policies set capacity = 100000$q$) = '42501', 'PR customer cannot raise own limit');
  PERFORM t.ok(t.as_role('authenticated', c, $q$select 1 from public.rate_limit_policy_changes$q$) = '42501', 'PR change log');
  PERFORM t.ok(t.as_role('authenticated', c, $q$select 1 from public.internal_service_secrets$q$) = '42501', 'PR pepper unreadable');
  PERFORM t.ok(t.as_role('anon', null, $q$select * from public.rate_limit_admin_policies()$q$) = '42501', 'PR anon admin list');
  PERFORM t.ok(t.as_role('authenticated', c, $q$select * from public.rate_limit_admin_policies()$q$) = '42501', 'PR customer admin list');
  PERFORM t.ok(t.as_role('authenticated', c, $q$select public.rate_limit_admin_set_policy('api.token', 100000, null, null, 'me')$q$) = '42501', 'PR customer set');
  PERFORM t.ok(t.as_role('authenticated', c, $q$select public.rate_limit_admin_reset('api.token', 'x')$q$) = '42501', 'PR customer reset');
  PERFORM t.ok(t.as_role('service_role', null, $q$select * from public.rate_limit_hit('public.form.ip', '1.2.3.4')$q$) = 'ok', 'PR service_role hit');
  -- RLS on the shared bucket table still hides rows from customers
  PERFORM t.ok(t.val('authenticated', c, $q$select count(*) n from public.sie_rate_limit_buckets$q$) ->> 'n' = '0', 'PR customer sees no buckets');
  PERFORM t.ok(t.val('anon', null, $q$select count(*) n from public.sie_rate_limit_buckets$q$) ->> 'n' = '0', 'PR anon sees no buckets');
  DELETE FROM public.sie_rate_limit_buckets WHERE bucket_key LIKE 'rl:%';
  RAISE NOTICE 'PASS PR: rate_limit_hit لدور الخدمة وحده، الداخليات مغلقة، العميل لا يقرأ ولا يغيّر حدوده ولا يرى الدلاء';
END $$;

-- ══ F السلوك ════════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; i int; n_ok int := 0;
BEGIN
  -- public.form.ip: 5 per 600 s ⇒ 1 token per 120 s
  FOR i IN 1 .. 5 LOOP
    r := t.hit('public.form.ip', '198.51.100.7');
    PERFORM t.ok((r ->> 'allowed')::boolean AND (r ->> 'retry_after')::int = 0, 'F1 under threshold ' || i);
  END LOOP;
  PERFORM t.ok((r ->> 'remaining')::int = 0 AND (r ->> 'limit_total')::int = 5 AND (r ->> 'window_seconds')::int = 600, 'F1 counters');
  r := t.hit('public.form.ip', '198.51.100.7');
  PERFORM t.ok(NOT (r ->> 'allowed')::boolean AND (r ->> 'would_block')::boolean AND (r ->> 'enforced')::boolean, 'F2 over threshold rejected');
  PERFORM t.ok((r ->> 'retry_after')::int BETWEEN 100 AND 120, 'F2 retry_after ≈ one refill interval: ' || (r ->> 'retry_after'));
  PERFORM t.ok((r ->> 'reset_seconds')::int BETWEEN 500 AND 600, 'F2 reset ≈ window');
  -- a rejected request does not spend: still rejected, still ~120 s
  r := t.hit('public.form.ip', '198.51.100.7');
  PERFORM t.ok(NOT (r ->> 'allowed')::boolean, 'F2 still rejected');
  -- refill: 121 s later exactly one more passes
  PERFORM t.age('rl:public.form.ip:%', 121);
  PERFORM t.ok((t.hit('public.form.ip', '198.51.100.7') ->> 'allowed')::boolean, 'F3 refill one');
  PERFORM t.ok(NOT (t.hit('public.form.ip', '198.51.100.7') ->> 'allowed')::boolean, 'F3 only one');
  -- full window later the bucket is full again (capacity, not more)
  PERFORM t.age('rl:public.form.ip:%', 86400);
  FOR i IN 1 .. 7 LOOP
    IF (t.hit('public.form.ip', '198.51.100.7') ->> 'allowed')::boolean THEN n_ok := n_ok + 1; END IF;
  END LOOP;
  PERFORM t.ok(n_ok = 5, 'F3 refill caps at capacity: ' || n_ok);
  RAISE NOTICE 'PASS F1-F3: تحت الحد يمر، فوقه 429 بـRetry-After ≈ 120ث، الرفض لا يستهلك، إعادة الملء خطية ومحدودة بالسعة';
END $$;

DO $$
DECLARE r jsonb; i int;
BEGIN
  UPDATE public.rate_limit_policies SET mode = 'observe' WHERE policy = 'public.form.ip';
  FOR i IN 1 .. 3 LOOP r := t.hit('public.form.ip', '198.51.100.7'); END LOOP;
  PERFORM t.ok((r ->> 'allowed')::boolean AND (r ->> 'would_block')::boolean AND NOT (r ->> 'enforced')::boolean, 'F4 observe never rejects but reports');
  PERFORM t.ok((SELECT total_rejected > 0 FROM public.sie_rate_limit_buckets WHERE bucket_key LIKE 'rl:public.form.ip:%' LIMIT 1), 'F4 observe still counts');
  UPDATE public.rate_limit_policies SET mode = 'off' WHERE policy = 'public.form.ip';
  DELETE FROM public.sie_rate_limit_buckets WHERE bucket_key LIKE 'rl:public.form.ip:%';
  r := t.hit('public.form.ip', '198.51.100.7');
  PERFORM t.ok((r ->> 'allowed')::boolean AND NOT (r ->> 'enforced')::boolean, 'F5 off allows');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.sie_rate_limit_buckets WHERE bucket_key LIKE 'rl:public.form.ip:%'), 'F5 off writes nothing');
  -- off for one policy leaves the others enforcing
  FOR i IN 1 .. 11 LOOP r := t.hit('auth.exchange.ip', '198.51.100.7'); END LOOP;
  PERFORM t.ok(NOT (r ->> 'allowed')::boolean, 'F5 other policies unaffected');
  UPDATE public.rate_limit_policies SET mode = 'enforce' WHERE policy = 'public.form.ip';
  PERFORM t.ok(t.as_role('service_role', null, $q$select * from public.rate_limit_hit('no.such_policy', 'x')$q$) = '22023', 'F6 unknown policy raises');
  DELETE FROM public.sie_rate_limit_buckets WHERE bucket_key LIKE 'rl:%';
  RAISE NOTICE 'PASS F4-F6: observe يعدّ ولا يرفض، off لا يكتب ولا يمس غيره، السياسة المجهولة خطأ لا تعطيل صامت';
END $$;

-- ══ ID هوية الدلو ═════════════════════════════════════════════════════════
DO $$
DECLARE i int;
BEGIN
  FOR i IN 1 .. 10 LOOP PERFORM t.hit('auth.exchange.ip', '203.0.113.9'); END LOOP;
  PERFORM t.ok(NOT (t.hit('auth.exchange.ip', '203.0.113.9') ->> 'allowed')::boolean, 'ID attacker exhausted');
  PERFORM t.ok((t.hit('auth.exchange.ip', '203.0.113.10') ->> 'allowed')::boolean, 'ID other IP unaffected');
  PERFORM t.ok((t.hit('oauth.register.ip', '203.0.113.9') ->> 'allowed')::boolean, 'ID other policy unaffected');
  PERFORM t.ok(NOT (t.hit('auth.exchange.ip', '  203.0.113.9 ') ->> 'allowed')::boolean, 'ID normalisation: whitespace');
  -- user/tenant subjects: one user exhausting does not touch another
  FOR i IN 1 .. 20 LOOP PERFORM t.hit('ai.generate.user', '10300000-0000-4000-8000-000000000003'); END LOOP;
  PERFORM t.ok(NOT (t.hit('ai.generate.user', '10300000-0000-4000-8000-000000000003') ->> 'allowed')::boolean, 'ID user exhausted');
  PERFORM t.ok((t.hit('ai.generate.user', '10300000-0000-4000-8000-000000000004') ->> 'allowed')::boolean, 'ID other user/tenant unaffected');
  -- missing subject is one shared bucket per policy, never an exemption
  FOR i IN 1 .. 10 LOOP PERFORM t.hit('auth.exchange.ip', null); END LOOP;
  PERFORM t.ok(NOT (t.hit('auth.exchange.ip', '') ->> 'allowed')::boolean, 'ID unknown subject shares one bucket');
  -- nothing identifying is stored
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.sie_rate_limit_buckets
                            WHERE bucket_key LIKE '%203.0.113%' OR bucket_key LIKE '%10300000%' OR bucket_key LIKE '%@%'), 'ID no raw subject in keys');
  PERFORM t.ok((SELECT bool_and(bucket_key ~ '^rl:[a-z0-9_.]+:[0-9a-f]{32}$') FROM public.sie_rate_limit_buckets WHERE bucket_key LIKE 'rl:%'), 'ID key shape');
  DELETE FROM public.sie_rate_limit_buckets WHERE bucket_key LIKE 'rl:%';
  RAISE NOTICE 'PASS ID: لكل موضوع دلوه، لا يستهلك أحد دلو غيره، المجهول دلو مشترك، والمفاتيح HMAC بلا IP ولا معرّف خام';
END $$;

-- ══ CC التزامن بعشر جلسات حقيقية ══════════════════════════════════════════
UPDATE public.rate_limit_policies SET capacity = 3, window_seconds = 86400 WHERE policy = 'api.token';
SELECT t.conn('c' || g) FROM generate_series(1, 10) g;
SELECT t.dblink_exec('c' || g, $s$set request.jwt.claim.role = 'service_role'$s$) FROM generate_series(1, 10) g;
SELECT t.dblink_exec('c' || g, 'set role service_role') FROM generate_series(1, 10) g;
-- Hold the row lock in c1 so the other nine queue behind it, then release.
SELECT t.dblink_exec('c1', 'begin');
SELECT x FROM t.dblink('c1', $s$select allowed::text from public.rate_limit_hit('api.token', 'tok-concurrent')$s$) AS r(x text);
SELECT t.dblink_send_query('c' || g, $s$select allowed::text from public.rate_limit_hit('api.token', 'tok-concurrent')$s$) FROM generate_series(2, 10) g;
SELECT pg_sleep(0.3);
DO $$ BEGIN
  PERFORM t.ok((SELECT bool_and(t.dblink_is_busy('c' || g) = 1) FROM generate_series(2, 10) g), 'CC nine sessions blocked on the bucket row');
END $$;
SELECT t.dblink_exec('c1', 'commit');
CREATE TABLE t.cc (x text);
INSERT INTO t.cc SELECT r.x FROM generate_series(2, 10) g, LATERAL t.dblink_get_result('c' || g) AS r(x text);
DO $$ BEGIN
  -- c1 took one token; of the nine racers exactly two more may pass.
  PERFORM t.ok((SELECT count(*) FROM t.cc) = 9, 'CC all nine answered');
  PERFORM t.ok((SELECT count(*) FROM t.cc WHERE x = 'true') = 2, 'CC capacity never exceeded: ' || (SELECT count(*) FROM t.cc WHERE x = 'true'));
  PERFORM t.ok((SELECT total_requests = 10 AND total_rejected = 7 FROM public.sie_rate_limit_buckets WHERE bucket_key LIKE 'rl:api.token:%'), 'CC counters consistent');
  RAISE NOTICE 'PASS CC: عشر جلسات متزامنة على دلو سعته 3 — مرّ 3 بالضبط ورُفض 7، والعدّادات متسقة';
END $$;
SELECT t.dblink_disconnect('c' || g) FROM generate_series(1, 10) g;
UPDATE public.rate_limit_policies SET capacity = 60, window_seconds = 60 WHERE policy = 'api.token';
DELETE FROM public.sie_rate_limit_buckets WHERE bucket_key LIKE 'rl:%';

-- ══ AD الإدارة ═════════════════════════════════════════════════════════════
DO $$
DECLARE o uuid := '10300000-0000-4000-8000-000000000001';
        a uuid := '10300000-0000-4000-8000-000000000002';
        r jsonb;
BEGIN
  PERFORM t.ok(t.as_role('authenticated', a, $q$select * from public.rate_limit_admin_policies()$q$) = 'ok', 'AD admin can list');
  r := t.val('authenticated', o, $q$select count(*) n from public.rate_limit_admin_policies()$q$);
  PERFORM t.ok((r ->> 'n')::int = 9, 'AD owner lists all 9 policies');
  PERFORM t.ok(t.as_role('authenticated', a, $q$select public.rate_limit_admin_set_policy('api.token', 120, null, null, 'more')$q$) = '42501', 'AD admin cannot change policy');
  PERFORM t.ok(t.as_role('authenticated', o, $q$select public.rate_limit_admin_set_policy('api.token', 120, null, null, null)$q$) = '22023', 'AD reason required');
  PERFORM t.ok(t.as_role('authenticated', o, $q$select public.rate_limit_admin_set_policy('new.policy', 1, 1, null, 'x')$q$) = '22023', 'AD cannot invent policies');
  PERFORM t.ok(t.as_role('authenticated', o, $q$select public.rate_limit_admin_set_policy('api.token', 0, null, null, 'x')$q$) = '23514', 'AD bounds enforced');
  PERFORM t.ok(t.as_role('authenticated', o, $q$select public.rate_limit_admin_set_policy('api.token', null, null, 'disabled', 'x')$q$) = '23514', 'AD mode enum enforced');
  PERFORM t.ok(t.as_role('authenticated', o, $q$select public.rate_limit_admin_set_policy('api.token', 120, null, 'observe', 'launch week')$q$) = 'ok', 'AD owner changes policy');
  PERFORM t.ok((SELECT capacity = 120 AND window_seconds = 60 AND mode = 'observe' AND updated_by = o FROM public.rate_limit_policies WHERE policy = 'api.token'), 'AD applied, others kept');
  PERFORM t.ok((SELECT before ->> 'capacity' = '60' AND after ->> 'capacity' = '120' AND reason = 'launch week' AND changed_by = o
                  FROM public.rate_limit_policy_changes WHERE policy = 'api.token' ORDER BY id DESC LIMIT 1), 'AD change logged');
  PERFORM t.ok((t.val('authenticated', a, $q$select count(*) n from public.rate_limit_admin_changes(10)$q$) ->> 'n')::int >= 1, 'AD admin reads log');
  PERFORM t.as_role('authenticated', o, $q$select public.rate_limit_admin_set_policy('api.token', 60, 60, 'enforce', 'restore')$q$);
  -- reset one subject (false positive) without touching others
  PERFORM t.hit('auth.exchange.ip', '192.0.2.1'); PERFORM t.hit('auth.exchange.ip', '192.0.2.2');
  r := t.val('authenticated', a, $q$select public.rate_limit_admin_reset('auth.exchange.ip', '192.0.2.1') ok$q$);
  PERFORM t.ok((r ->> 'ok')::boolean AND (SELECT count(*) FROM public.sie_rate_limit_buckets WHERE bucket_key LIKE 'rl:auth.exchange.ip:%') = 1, 'AD reset one subject only');
  -- admin list returns aggregates only: no bucket keys
  r := t.val('authenticated', a, $q$select jsonb_agg(to_jsonb(p)) j from public.rate_limit_admin_policies() p$q$);
  PERFORM t.ok(r::text NOT LIKE '%rl:%' AND (r -> 'j') @> '[{"policy": "auth.exchange.ip", "active_buckets": 1}]', 'AD aggregates only');
  DELETE FROM public.sie_rate_limit_buckets WHERE bucket_key LIKE 'rl:%';
  RAISE NOTICE 'PASS AD: القراءة وإعادة الضبط للأدمن، تعديل السياسة للمالك وحده وبسبب وضمن الحدود، وكل تغيير مسجّل';
END $$;

-- ══ SW الكنس ══════════════════════════════════════════════════════════════
DO $$
DECLARE n int;
BEGIN
  PERFORM t.hit('public.form.ip', 'old-1'); PERFORM t.hit('public.form.ip', 'old-2'); PERFORM t.hit('public.form.ip', 'fresh');
  UPDATE public.sie_rate_limit_buckets SET last_request_at = now() - interval '2 days', updated_at = now() - interval '2 days'
   WHERE bucket_key IN (public._rl_bucket_key('public.form.ip', 'old-1'), public._rl_bucket_key('public.form.ip', 'old-2'));
  INSERT INTO public.sie_rate_limit_buckets (bucket_key, tokens, updated_at, last_request_at) VALUES
    ('ip:198.51.100.1', 1, now() - interval '3 days', now() - interval '3 days'),
    ('user:10300000-0000-4000-8000-000000000004', 1, now() - interval '30 days', now() - interval '30 days'),
    ('integration:00000000-0000-4000-8000-000000000099', 1, now() - interval '30 days', now() - interval '30 days');
  n := public.rate_limit_sweep(1);
  PERFORM t.ok(n = 1, 'SW batch bound respected');
  n := public.rate_limit_sweep(50000);
  PERFORM t.ok(n = 2, 'SW deletes the rest of the idle rl:/ip: rows: ' || n);
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.sie_rate_limit_buckets WHERE bucket_key = public._rl_bucket_key('public.form.ip', 'fresh')), 'SW active kept');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.sie_rate_limit_buckets WHERE bucket_key = 'user:10300000-0000-4000-8000-000000000004'), 'SW SIE user kept');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.sie_rate_limit_buckets WHERE bucket_key LIKE 'integration:%'), 'SW integration kept');
  -- many abusive subjects: storage is one row per subject and all of it is reclaimable
  PERFORM t.hit('oauth.register.ip', 'spray-' || g) FROM generate_series(1, 200) g;
  PERFORM t.ok((SELECT count(*) FROM public.sie_rate_limit_buckets WHERE bucket_key LIKE 'rl:oauth.register.ip:%') = 200, 'SW one row per subject');
  UPDATE public.sie_rate_limit_buckets SET last_request_at = now() - interval '25 hours' WHERE bucket_key LIKE 'rl:oauth.register.ip:%';
  PERFORM public.rate_limit_sweep(50000);
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.sie_rate_limit_buckets WHERE bucket_key LIKE 'rl:oauth.register.ip:%'), 'SW spray reclaimed');
  DELETE FROM public.sie_rate_limit_buckets WHERE bucket_key LIKE 'rl:%' OR bucket_key LIKE 'user:1030%' OR bucket_key LIKE 'integration:%';
  RAISE NOTICE 'PASS SW: الكنس يحذف دلاء rl:/ip: الخاملة يومًا بدفعات محدودة، ولا يمس النشط ولا user:/integration:';
END $$;

-- ══ RB التراجع وإعادة التطبيق ═════════════════════════════════════════════
INSERT INTO public.sie_rate_limit_buckets (bucket_key, tokens) VALUES ('user:keep-me', 3);
SELECT t.hit('public.form.ip', 'rb');
\i migrations/_rollback/103_platform_rate_limiting.down.sql
DO $$ BEGIN
  PERFORM t.ok((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.sie_rl_spend(text,integer,integer)'::regprocedure)
               = (SELECT v FROM t.saved WHERE k = 'sie_rl_spend_src'), 'RB sie_rl_spend byte-for-byte');
  PERFORM t.ok((SELECT proacl::text FROM pg_proc WHERE oid = 'public.sie_rl_spend(text,integer,integer)'::regprocedure)
               = (SELECT v FROM t.saved WHERE k = 'sie_rl_spend_acl'), 'RB grants');
  PERFORM t.ok(to_regprocedure('public.rate_limit_hit(text,text)') IS NULL AND to_regclass('public.rate_limit_policies') IS NULL
           AND to_regprocedure('public.rl_spend(text,double precision,double precision)') IS NULL, 'RB objects gone');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.sie_rate_limit_buckets WHERE bucket_key LIKE 'rl:%'), 'RB rl buckets gone');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.sie_rate_limit_buckets WHERE bucket_key = 'user:keep-me'), 'RB SIE buckets kept');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.internal_service_secrets WHERE key = 'rate_limit_subject_pepper'), 'RB pepper gone');
  DELETE FROM t.trace WHERE phase = 'after';
  PERFORM t.trace_run('after');
  PERFORM t.ok(NOT EXISTS (
    SELECT 1 FROM t.trace a JOIN t.trace b USING (run, step)
     WHERE a.phase = 'before' AND b.phase = 'after' AND (a.tokens IS DISTINCT FROM b.tokens OR a.allowed IS DISTINCT FROM b.allowed)), 'RB SIE behaviour');
  RAISE NOTICE 'PASS RB: التراجع يعيد sie_rl_spend حرفيًا ويزيل كائنات 103 ودلاءها فقط';
END $$;
\i migrations/103_platform_rate_limiting.sql
\i migrations/103_platform_rate_limiting.sql
SET search_path = public, extensions;
DO $$ BEGIN
  PERFORM t.ok((SELECT count(*) FROM public.rate_limit_policies) = 9, 'RB reapply idempotent');
  PERFORM t.ok((t.hit('public.form.ip', 'again') ->> 'allowed')::boolean, 'RB works after reapply');
  RAISE NOTICE 'PASS RB2: إعادة التطبيق (مرتين) تعمل بلا تكرار';
END $$;

\echo 'ALL PLATFORM RATE LIMITING TESTS PASSED'
