-- ============================================================================
-- مدعوم — الاستمرارية: السياسات ومفاتيح الإيقاف (078_continuity_policies) على نسخة
-- مطابقة لشكل الإنتاج (073 + 074 + 076 + 077 مطبقة ومفعّل)
--
-- قرارات المالك 2026-10-12: D1–D4 قيم افتراضية قابلة للضبط، R1 التغيير للمالك فقط،
-- وكل قدرة مطفأة ولا تُفعَّل قبل تثبيت كودها.
--
--   ⓪ 073 + 074 + 076 + بيانات، ولقطة نصوص الدوال ونتائج continuity_my_access
--   ① 078: لا مساس، الافتراضيات، القراءة، الكتابة للمالك فقط، التحقق، النسخة،
--      السجل، منع تفعيل غير المثبت، continuity_my_access، الصلاحيات، الثبات
--   ② إعادة التشغيل، التراجع (رفض مع سجل، النص قبل 078 حرفيًا)، إعادة التطبيق
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

-- ── أدوات ─────────────────────────────────────────────────────────────────
CREATE FUNCTION t.act(p uuid) RETURNS void LANGUAGE sql AS $$
  select set_config('request.jwt.claim.sub', coalesce(p::text, ''), false),
         set_config('request.jwt.claim.role', case when p is null then '' else 'authenticated' end, false),
         -- شكل الإنتاج: PostgREST يضبط claims كاملة (بلا continuity_client للمسار الأصلي)
         set_config('request.jwt.claims', case when p is null then ''
                      else jsonb_build_object('sub', p, 'role', 'authenticated')::text end, false); $$;
-- نداء عبر continuity-api (المرحلة G): claim continuity_client
CREATE FUNCTION t.act_api(p uuid) RETURNS void LANGUAGE sql AS $$
  select set_config('request.jwt.claim.sub', p::text, false),
         set_config('request.jwt.claim.role', 'authenticated', false),
         set_config('request.jwt.claims', jsonb_build_object('sub', p, 'role', 'authenticated',
                                                             'continuity_client', 'extension')::text, false); $$;
-- ينفّذ تعبيرًا كدور authenticated للمستخدم p ويرجع النتيجة jsonb
CREATE FUNCTION t.call(p uuid, p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
declare v jsonb;
begin
  if p is not null then perform t.act(p); end if;
  execute 'set local role authenticated';
  execute 'select to_jsonb((' || p_sql || '))' into v;
  execute 'reset role';
  return v;
end $$;
CREATE FUNCTION t.call_api(p uuid, p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
declare v jsonb;
begin
  perform t.act_api(p);
  v := t.call(null, p_sql);
  perform t.act(null);
  return v;
exception when others then
  perform t.act(null);
  raise;
end $$;
CREATE FUNCTION t.err(p uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  perform t.call(p, p_sql);
  return 'ok';
exception when others then
  return sqlstate;
end $$;
-- الخطأ كاملًا (للبحث عن تسرب في نص الخطأ وتفاصيله)
CREATE FUNCTION t.errfull(p uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
declare m text; d text; h text;
begin
  perform t.call(p, p_sql);
  return 'ok';
exception when others then
  get stacked diagnostics m = message_text, d = pg_exception_detail, h = pg_exception_hint;
  return sqlstate || '|' || m || '|' || coalesce(d, '') || '|' || coalesce(h, '');
end $$;
-- جملة كاملة كدور authenticated (للـ INSERT/UPDATE/DELETE المباشر)
CREATE FUNCTION t.err_stmt(p uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  perform t.act(p);
  execute 'set local role authenticated';
  execute p_sql;
  execute 'reset role';
  return 'ok';
exception when others then
  return sqlstate;
end $$;
-- كدور anon (بلا مستخدم)
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
CREATE FUNCTION t.ctx(p_context text, p_live boolean DEFAULT true) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
begin
  perform set_config('app.owner_context_write', 'on', true);
  insert into public.owner_context_state (user_id, context, entered_at, expires_at)
  values ('00000000-0000-4000-8000-0000000000f0', p_context, now(),
          case when p_live then now() + interval '12 hours' else now() - interval '1 minute' end)
  on conflict (user_id) do update set context = excluded.context, entered_at = excluded.entered_at,
                                      expires_at = excluded.expires_at;
  perform set_config('app.owner_context_write', 'off', true);
end $$;
-- طلب إنشاء متابعة: موعد بكرة 12:00 بتوقيت القاهرة
CREATE FUNCTION t.req(p_key text, p_msgs uuid[], p_extra jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  select jsonb_build_object(
    'contract_version', 1,
    'idempotency_key', md5(p_key)::uuid,
    'kind', 'follow_up',
    'title', 'TITLEMARK ' || p_key,
    'summary', 'SUMMARYMARK ' || p_key,
    'next_action', 'اتصل بالعميل',
    'due', jsonb_build_object('at', to_char((now() at time zone 'Africa/Cairo')::date + 1, 'YYYY-MM-DD') || 'T12:00:00',
                              'tz', 'Africa/Cairo'),
    'sources', coalesce((select jsonb_agg(jsonb_build_object('type', 'mad3oom_message', 'provider', 'mad3oom',
                                   'internal', jsonb_build_object('chat_message_id', m)))
                           from unnest(p_msgs) m), '[]'::jsonb)) || p_extra $$;
CREATE FUNCTION t.mk(p uuid, p_key text, p_msgs uuid[], p_extra jsonb DEFAULT '{}') RETURNS uuid LANGUAGE sql AS $$
  select (t.call(p, format('public.continuity_create(%L::jsonb)', t.req(p_key, p_msgs, p_extra))) -> 'record' ->> 'id')::uuid $$;
CREATE FUNCTION t.get(p uuid, p_rec uuid) RETURNS jsonb LANGUAGE sql AS $$
  select t.call(p, format('public.continuity_get(%L::uuid)', p_rec)) $$;
CREATE FUNCTION t.ver(p_rec uuid) RETURNS int LANGUAGE plpgsql AS $$
begin return (select version from public.continuity_records where id = p_rec); end $$;
-- بصمة جداول الشات والصندوق (لإثبات عدم المساس)
CREATE FUNCTION t.chat_digest() RETURNS text LANGUAGE sql AS $$
  select md5(concat_ws('#',
    (select string_agg(md5(x::text), ',' order by x.id) from public.chat_sessions x),
    (select string_agg(md5(x::text), ',' order by x.id) from public.chat_messages x),
    (select string_agg(md5(x::text), ',' order by x.session_id) from public.inbox_conversations x),
    (select string_agg(md5(x::text), ',' order by x.id) from public.inbox_teams x),
    (select string_agg(md5(x::text), ',' order by x.team_id, x.user_id) from public.inbox_team_members x),
    (select string_agg(md5(x::text), ',' order by x.id) from public.notifications x),
    (select string_agg(md5(x::text), ',' order by x.id) from public.chat_message_revisions x),
    (select string_agg(md5(x::text), ',' order by x.id) from public.inbox_events x),
    (select string_agg(md5(x::text), ',' order by x.id) from public.tickets x),
    (select string_agg(md5(x::text), ',' order by x.id) from public.profiles x))) $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;


-- مختصرات الفاعلين (نفس معرّفات relay-core.test.sql + GR)
CREATE FUNCTION t.u(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  select (case p when 'C1' then '00000000-0000-4000-8000-0000000000c1' when 'C2' then '00000000-0000-4000-8000-0000000000c2'
                 when 'S1' then '00000000-0000-4000-8000-0000000000a5' when 'S2' then '00000000-0000-4000-8000-0000000000a6'
                 when 'S3' then '00000000-0000-4000-8000-0000000000a7' when 'GR' then '00000000-0000-4000-8000-0000000000a8'
                 when 'AD' then '00000000-0000-4000-8000-0000000000ad' when 'EA' then '00000000-0000-4000-8000-0000000000ea'
                 when 'OW' then '00000000-0000-4000-8000-0000000000f0' when 'BN' then '00000000-0000-4000-8000-0000000000b0'
                 when 'T1' then '7ea70000-0000-4000-8000-000000000001' end)::uuid $$;
CREATE FUNCTION t.create_sql(p_key text, p_msgs uuid[], p_extra jsonb DEFAULT '{}') RETURNS text LANGUAGE sql AS $$
  select format('public.continuity_create(%L::jsonb)', t.req(p_key, p_msgs, p_extra)) $$;
CREATE FUNCTION t.assign_sql(p_rec uuid, p_owner uuid, p_team uuid) RETURNS text LANGUAGE sql AS $$
  select format('public.continuity_assign(%L::uuid, %L::uuid, %L::uuid, %s)', p_rec, p_owner, p_team, t.ver(p_rec)) $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ── الفاعلون ──────────────────────────────────────────────────────────────
--  C1/C2 عملاء · S1/S2/S3 دعم · GR دعم سيُمنح صلاحية الإسناد · AD أدمن عادي
--  EA أدمن مرتفع (مشرف) · OW المالك (سياق admin) · BN دعم محظور
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-8000-0000000000c1', 'c1@t.io'), ('00000000-0000-4000-8000-0000000000c2', 'c2@t.io'),
  ('00000000-0000-4000-8000-0000000000a5', 's1@t.io'), ('00000000-0000-4000-8000-0000000000a6', 's2@t.io'),
  ('00000000-0000-4000-8000-0000000000a7', 's3@t.io'), ('00000000-0000-4000-8000-0000000000a8', 'gr@t.io'),
  ('00000000-0000-4000-8000-0000000000ad', 'ad@t.io'), ('00000000-0000-4000-8000-0000000000ea', 'ea@t.io'),
  ('00000000-0000-4000-8000-0000000000f0', 'ow@t.io'), ('00000000-0000-4000-8000-0000000000b0', 'bn@t.io');
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at) VALUES
  ('00000000-0000-4000-8000-0000000000c1', 'c1@t.io', 'عميل واحد', 'user', '01000000041', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000c2', 'c2@t.io', 'عميل اتنين', 'user', '01000000042', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000a5', 's1@t.io', 'دعم 1', 'support', '01000000043', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000a6', 's2@t.io', 'دعم 2', 'support', '01000000044', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000a7', 's3@t.io', 'دعم 3', 'support', '01000000045', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000a8', 'gr@t.io', 'دعم مُسند', 'support', '01000000050', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000ad', 'ad@t.io', 'أدمن', 'admin', '01000000046', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000ea', 'ea@t.io', 'أدمن مرتفع', 'admin', '01000000047', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000f0', 'ow@t.io', 'المالك', 'platform_owner', '01000000048', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000b0', 'bn@t.io', 'دعم محظور', 'support', '01000000049', '2026-09-01');
UPDATE public.profiles SET ban_status = 'banned' WHERE id = '00000000-0000-4000-8000-0000000000b0';
INSERT INTO public.platform_authority (user_id, level) VALUES
  ('00000000-0000-4000-8000-0000000000f0', 'owner'), ('00000000-0000-4000-8000-0000000000ea', 'elevated_admin');

-- SA (C1، مسندة S1)، SB (C2، مسندة S2)، SC (C1، فريق T1 فيه S3)
INSERT INTO public.chat_sessions (id, user_id) VALUES
  ('5e550000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1'),
  ('5e550000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000c2'),
  ('5e550000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000c1');
INSERT INTO public.inbox_teams (id, name) VALUES ('7ea70000-0000-4000-8000-000000000001', 'فريق المتابعة');
INSERT INTO public.inbox_team_members (team_id, user_id) VALUES
  ('7ea70000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a7');
INSERT INTO public.inbox_conversations (session_id, assignee_id, team_id) VALUES
  ('5e550000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a5', NULL),
  ('5e550000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a6', NULL),
  ('5e550000-0000-4000-8000-0000000000c1', NULL, '7ea70000-0000-4000-8000-000000000001');
INSERT INTO public.chat_messages (id, session_id, sender_id, message_text, is_admin_reply, created_at) VALUES
  ('3e550000-0000-4000-8000-0000000000a1', '5e550000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1',
   'MARKERA1 مرحبًا، أريد الاستفسار عن حالة طلبي', false, '2026-10-07 07:24+00'),
  ('3e550000-0000-4000-8000-0000000000a2', '5e550000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a5',
   'MARKERA2 أهلًا بك، من فضلك أرسل رقم الطلب', true, '2026-10-07 07:25+00'),
  ('3e550000-0000-4000-8000-0000000000a3', '5e550000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1',
   'MARKERA3 رقم الطلب هو 45879', false, '2026-10-07 07:27+00'),
  ('3e550000-0000-4000-8000-0000000000b1', '5e550000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000c2',
   'MARKERB1 عميل تاني', false, '2026-10-07 10:00+00'),
  ('3e550000-0000-4000-8000-0000000000c1', '5e550000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000c1',
   'MARKERC1 محادثة الفريق', false, '2026-10-07 11:00+00'),
  ('3e550000-0000-4000-8000-0000000000c2', '5e550000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000c1',
   'MARKERC2 متابعة في محادثة الفريق', false, '2026-10-07 11:05+00');

CREATE TABLE t.actors (name text PRIMARY KEY, id uuid NOT NULL);
INSERT INTO t.actors SELECT n, t.u(n) FROM unnest(array['S1', 'S2', 'S3', 'GR', 'AD', 'EA', 'OW', 'BN', 'C1']) n;
CREATE FUNCTION t.matrix() RETURNS text LANGUAGE plpgsql AS $$
declare a record; s uuid; o text := '';
begin
  perform t.ctx('admin');
  for a in select * from t.actors order by name loop
    perform t.act(a.id);
    foreach s in array array['5e550000-0000-4000-8000-0000000000a1', '5e550000-0000-4000-8000-0000000000b1',
                             '5e550000-0000-4000-8000-0000000000c1']::uuid[] loop
      o := o || a.name || ':' || public.inbox_can_access(s)::text || ' ';
    end loop;
  end loop;
  perform t.act(null);
  return o;
end $$;
CREATE TABLE t.saved (k text PRIMARY KEY, v text);
-- الدوال الـ18 العامة التي لا يمسها 078 (continuity_my_access يُفحص وحده).
CREATE FUNCTION t.fn18_digest() RETURNS text LANGUAGE sql AS $$
  select md5(string_agg(pg_get_functiondef(f::regprocedure), '#' order by f))
    from unnest(array['public.continuity_create(jsonb)', 'public.continuity_get(uuid)', 'public.continuity_list(jsonb)',
                      'public.continuity_update(uuid,jsonb,integer)', 'public.continuity_assign(uuid,uuid,uuid,integer)',
                      'public.continuity_transition(uuid,text,jsonb,integer)',
                      'public.continuity_attach_sources(uuid,jsonb,integer,boolean)', 'public.continuity_redact_source(uuid,text)',
                      'public.continuity_redact_for_subject(uuid,text)', 'public.continuity_find_by_source(jsonb)',
                      'public.continuity_events_for(uuid,bigint,integer)', 'public.continuity_list_assigners()',
                      'public.continuity_grant_assigner(uuid)', 'public.continuity_revoke_assigner(uuid)',
                      'public.continuity_remove_source(uuid,integer)', 'public.continuity_restore_source(uuid,integer)',
                      'public.continuity_list_removed(integer)', 'public.continuity_purge_removed(uuid)']) f $$;
-- continuity_my_access لكل فاعل (المسار الأصلي) + المالك عبر الـAPI، بدون مفتاح capabilities.
CREATE FUNCTION t.access_matrix() RETURNS text LANGUAGE plpgsql AS $$
declare a record; o text := '';
begin
  perform t.ctx('admin');
  for a in select * from t.actors order by name loop
    o := o || a.name || '=' || (t.call(a.id, 'public.continuity_my_access()') - 'capabilities')::text || ';';
  end loop;
  o := o || 'OW_API=' || (t.call_api(t.u('OW'), 'public.continuity_my_access()') - 'capabilities')::text;
  perform t.act(null);
  return o;
end $$;
SET check_function_bodies = off;
CREATE FUNCTION t.set_sql(p_patch jsonb) RETURNS text LANGUAGE sql AS $$
  select format('public.continuity_set_policies(%L::jsonb, %s)', p_patch,
                (select version from public.continuity_policies p join public.continuity_workspaces w on w.id = p.workspace_id
                  where w.kind = 'platform')) $$;
RESET check_function_bodies;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

DO $$
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.act(t.u('S1'));
  PERFORM t.ok(public.is_platform_staff() AND public.account_is_active() AND NOT public._inbox_is_supervisor(), 'SETUP S1');
  PERFORM t.act(t.u('EA'));
  PERFORM t.ok(public._inbox_is_supervisor(), 'SETUP EA');
  PERFORM t.act(t.u('BN'));
  PERFORM t.ok(NOT public.account_is_active(), 'SETUP BN');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS SETUP: عميلان، دعم، أدمن عادي، مشرف، المالك في admin، دعم محظور';
END $$;

-- ============================================================================
-- ⓪ 073 + 074 + 076 كما في الإنتاج اليوم
-- ============================================================================
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
\i migrations/073_relay_core.sql
SET search_path = public, extensions;
UPDATE public.relay_workspaces SET enabled = true WHERE kind = 'platform';
\i migrations/074_relay_phase_c.sql
SET search_path = public, extensions;
\i migrations/076_relay_trash_owner.sql
SET search_path = public, extensions;
\i migrations/077_continuity_namespace.sql
SET search_path = public, extensions;

DO $$
DECLARE rid uuid;
BEGIN
  PERFORM t.ctx('admin');
  rid := t.mk(t.u('S1'), 'REC', array['3e550000-0000-4000-8000-0000000000a1']::uuid[], jsonb_build_object('owner_id', t.u('S1')));
  INSERT INTO t.saved VALUES ('REC', rid::text);
  PERFORM t.call(t.u('OW'), format('public.continuity_grant_assigner(%L::uuid)', t.u('GR')));
  PERFORM t.act(NULL);
END $$;
INSERT INTO t.saved SELECT 'fn18_076', t.fn18_digest();
INSERT INTO t.saved SELECT 'myaccess_077', pg_get_functiondef('public.continuity_my_access()'::regprocedure);
INSERT INTO t.saved SELECT 'access_076', t.access_matrix();
INSERT INTO t.saved SELECT 'chat_before', t.chat_digest();
INSERT INTO t.saved SELECT 'continuity_before', (SELECT md5(concat_ws('#',
  (SELECT string_agg(md5(to_jsonb(r)::text), ',' ORDER BY r.id) FROM public.continuity_records r),
  (SELECT string_agg(md5(to_jsonb(s)::text), ',' ORDER BY s.id) FROM public.continuity_sources s),
  (SELECT string_agg(md5(to_jsonb(s)::text), ',' ORDER BY s.id) FROM public.continuity_source_snapshots s),
  (SELECT string_agg(md5(to_jsonb(e)::text), ',' ORDER BY e.id) FROM public.continuity_events e),
  (SELECT string_agg(md5(to_jsonb(a)::text), ',' ORDER BY a.id) FROM public.continuity_assigners a))));

-- ============================================================================
-- ① تطبيق 078
-- ============================================================================
\i migrations/078_continuity_policies.sql
SET search_path = public, extensions;

-- ── X0: لا مساس ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM t.ok(t.fn18_digest() = (SELECT v FROM t.saved WHERE k = 'fn18_076'), 'X0 18 functions byte-identical');
  PERFORM t.ok(t.access_matrix() = (SELECT v FROM t.saved WHERE k = 'access_076'), 'X0 continuity_my_access old keys unchanged');
  PERFORM t.ok(t.chat_digest() = (SELECT v FROM t.saved WHERE k = 'chat_before'), 'X0 chat untouched');
  PERFORM t.ok((SELECT md5(concat_ws('#',
      (SELECT string_agg(md5(to_jsonb(r)::text), ',' ORDER BY r.id) FROM public.continuity_records r),
      (SELECT string_agg(md5(to_jsonb(s)::text), ',' ORDER BY s.id) FROM public.continuity_sources s),
      (SELECT string_agg(md5(to_jsonb(s)::text), ',' ORDER BY s.id) FROM public.continuity_source_snapshots s),
      (SELECT string_agg(md5(to_jsonb(e)::text), ',' ORDER BY e.id) FROM public.continuity_events e),
      (SELECT string_agg(md5(to_jsonb(a)::text), ',' ORDER BY a.id) FROM public.continuity_assigners a))))
    = (SELECT v FROM t.saved WHERE k = 'continuity_before'), 'X0 relay data untouched');
  RAISE NOTICE 'PASS X0: الدوال الـ18 حرفيًا كما هي، ومفاتيح continuity_my_access القديمة بنفس القيم لكل فاعل وللمالك عبر الـAPI، والشات وبيانات الاستمرارية لم تُلمس';
END $$;

-- ── P1: الافتراضيات (D1–D4) وكل القدرات مطفأة ─────────────────────────────────
DO $$
DECLARE g jsonb; p jsonb;
BEGIN
  PERFORM t.ctx('admin');
  g := t.call(t.u('S1'), 'public.continuity_get_policies()');
  p := g -> 'policy';
  PERFORM t.ok(p -> 'reminder_offsets_minutes' = '[60]'::jsonb, 'P1 D1 offset 60');
  PERFORM t.ok((p ->> 'due_alert')::boolean, 'P1 D1 due alert');
  PERFORM t.ok(p -> 'overdue_repeat_minutes' = 'null'::jsonb, 'P1 D2 off');
  PERFORM t.ok((p ->> 'escalate_after_minutes')::int = 240 AND p ->> 'escalation_recipients' = 'supervisors', 'P1 D3');
  PERFORM t.ok((p ->> 'handover_remind_after_minutes')::int = 60 AND (p ->> 'handover_escalate_after_minutes')::int = 240, 'P1 D4');
  PERFORM t.ok((p ->> 'respect_working_hours')::boolean, 'P1 working hours');
  PERFORM t.ok(NOT (p ->> 'handovers_enabled')::boolean AND NOT (p ->> 'reminders_enabled')::boolean
               AND NOT (p ->> 'escalation_enabled')::boolean AND NOT (p ->> 'monitor_enabled')::boolean
               AND NOT (p ->> 'attachments_enabled')::boolean AND NOT (p ->> 'ai_enabled')::boolean, 'P1 all switches off');
  PERFORM t.ok(g -> 'capabilities_installed' = '{"ai":false,"monitor":false,"handovers":false,"reminders":false,"escalation":false,"attachments":false}'::jsonb,
               'P1 nothing installed: ' || (g -> 'capabilities_installed')::text);
  PERFORM t.ok(g -> 'capabilities' = g -> 'capabilities_installed', 'P1 effective = all false');
  PERFORM t.ok((g ->> 'version')::int = 1, 'P1 version 1');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS P1: الافتراضيات = D1–D4 (60 قبل الموعد، إشعار عند الموعد، تصعيد بعد 240 للمشرفين، تسليم 60/240)، التكرار مطفأ، وكل القدرات مطفأة وغير مثبتة';
END $$;

-- ── P2: القراءة للأعضاء فقط ────────────────────────────────────────────────
DO $$
DECLARE a text;
BEGIN
  PERFORM t.ctx('admin');
  FOREACH a IN ARRAY array['S1', 'GR', 'AD', 'EA', 'OW'] LOOP
    PERFORM t.ok(t.err(t.u(a), 'public.continuity_get_policies()') = 'ok', 'P2 member reads ' || a);
  END LOOP;
  PERFORM t.ok(t.err(t.u('C1'), 'public.continuity_get_policies()') = '42501', 'P2 customer');
  PERFORM t.ok(t.err(t.u('BN'), 'public.continuity_get_policies()') = '42501', 'P2 banned');
  PERFORM t.ok(t.err_anon('select public.continuity_get_policies()') = '42501', 'P2 anon');
  PERFORM t.ok(t.err_stmt(t.u('OW'), 'select * from public.continuity_policies') = '42501'
               AND t.err_stmt(t.u('OW'), 'select * from public.continuity_policy_history') = '42501', 'P2 no table read');
  PERFORM t.ctx('customer');
  PERFORM t.ok(t.err(t.u('OW'), 'public.continuity_get_policies()') = '42501', 'P2 owner in customer context');
  PERFORM t.ctx('admin');
  UPDATE public.continuity_workspaces SET enabled = false WHERE kind = 'platform';
  PERFORM t.ok(t.err(t.u('S1'), 'public.continuity_get_policies()') = '0A000', 'P2 relay disabled');
  UPDATE public.continuity_workspaces SET enabled = true WHERE kind = 'platform';
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS P2: القراءة لأعضاء الطاقم فقط؛ العميل والمحظور وanon والمالك خارج سياق الإدارة مرفوضون، ولا قراءة مباشرة للجداول، وRelay المطفأ يرفض';
END $$;

-- ── P3: الكتابة للمالك فقط (R1) ─────────────────────────────────────────────
DO $$
DECLARE a text; patch jsonb := '{"escalate_after_minutes": 180}';
BEGIN
  PERFORM t.ctx('admin');
  FOREACH a IN ARRAY array['S1', 'GR', 'AD', 'EA', 'BN', 'C1'] LOOP
    PERFORM t.ok(t.err(t.u(a), t.set_sql(patch)) = '42501', 'P3 refused ' || a);
  END LOOP;
  PERFORM t.ok(t.err_anon(format('select %s', t.set_sql(patch))) = '42501', 'P3 anon');
  BEGIN
    PERFORM t.call_api(t.u('OW'), t.set_sql(patch));
    RAISE EXCEPTION 'FAIL P3 owner via api allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM t.ok(t.err_stmt(t.u('OW'), 'update public.continuity_policies set escalate_after_minutes = 5') = '42501', 'P3 no direct update');
  PERFORM t.ok((SELECT escalate_after_minutes FROM public.continuity_policies) = 240 AND NOT EXISTS (SELECT 1 FROM public.continuity_policy_history),
               'P3 nothing written');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS P3: الكتابة مرفوضة للدعم وصاحب صلاحية الإسناد والأدمن والمشرف والمحظور والعميل وanon والمالك عبر الـAPI، ولا تحديث مباشر';
END $$;

-- ── P4: المالك يكتب، بفحص النسخة، وسجل لكل تغيير، وبلا تغيير = لا شيء ──────────
DO $$
DECLARE g jsonb; h record;
BEGIN
  PERFORM t.ctx('admin');
  g := t.call(t.u('OW'), t.set_sql('{"escalate_after_minutes": 180, "reminder_offsets_minutes": [1440, 60], "due_alert": true}'));
  PERFORM t.ok((g -> 'policy' ->> 'escalate_after_minutes')::int = 180 AND g -> 'policy' -> 'reminder_offsets_minutes' = '[1440, 60]'::jsonb
               AND (g ->> 'version')::int = 2 AND (g ->> 'updated_by')::uuid = t.u('OW'), 'P4 applied');
  SELECT * INTO h FROM public.continuity_policy_history ORDER BY id DESC LIMIT 1;
  PERFORM t.ok(h.changed = array['escalate_after_minutes', 'reminder_offsets_minutes'] AND h.actor_id = t.u('OW')
               AND h.before = '{"escalate_after_minutes": 240, "reminder_offsets_minutes": [60]}'::jsonb
               AND h.after = '{"escalate_after_minutes": 180, "reminder_offsets_minutes": [1440, 60]}'::jsonb,
               'P4 history row: ' || to_jsonb(h)::text);
  -- بلا فرق: لا نسخة جديدة ولا سجل
  g := t.call(t.u('OW'), t.set_sql('{"escalate_after_minutes": 180}'));
  PERFORM t.ok((g ->> 'version')::int = 2 AND (SELECT count(*) FROM public.continuity_policy_history) = 1, 'P4 no-op');
  -- نسخة قديمة
  PERFORM t.ok(t.err(t.u('OW'), 'public.continuity_set_policies(''{"stale_after_days": 9}''::jsonb, 1)') = '40001', 'P4 stale version');
  -- إلغاء التصعيد (null) ورجوع القيمة
  g := t.call(t.u('OW'), t.set_sql('{"escalate_after_minutes": null}'));
  PERFORM t.ok(g -> 'policy' -> 'escalate_after_minutes' = 'null'::jsonb, 'P4 null allowed');
  g := t.call(t.u('OW'), t.set_sql('{"escalate_after_minutes": 240, "reminder_offsets_minutes": [60]}'));
  PERFORM t.ok((g ->> 'version')::int = 4 AND (SELECT count(*) FROM public.continuity_policy_history) = 3, 'P4 back to defaults');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS P4: المالك يغيّر القيم بفحص النسخة، كل تغيير فعلي يكتب صف سجل بالقيم قبل وبعد، والتغيير بلا فرق لا يكتب شيئًا';
END $$;

-- ── P5: التحقق من الأنواع والحدود ─────────────────────────────────────────────
DO $$
DECLARE bad jsonb;
BEGIN
  PERFORM t.ctx('admin');
  FOREACH bad IN ARRAY array[
    '{"escalate_after_minutes": "240"}', '{"escalate_after_minutes": 2.5}', '{"escalate_after_minutes": 1}',
    '{"escalate_after_minutes": 50000}', '{"reminder_offsets_minutes": 60}', '{"reminder_offsets_minutes": [1]}',
    '{"reminder_offsets_minutes": [60, 60, 60, 60, 60, 60]}', '{"reminder_offsets_minutes": ["60"]}',
    '{"reminder_offsets_minutes": [20000]}', '{"due_alert": "yes"}', '{"escalation_recipients": "everyone"}',
    '{"escalation_recipients": 1}', '{"stale_after_days": 0}', '{"stale_after_days": null}',
    '{"postpone_flag_count": 99}', '{"overdue_repeat_minutes": 5}', '{"overdue_repeat_max": 0}',
    '{"version": 9}', '{"workspace_id": "00000000-0000-0000-0000-000000000000"}', '{"updated_by": null}',
    '{"unknown": 1}', '{}']::jsonb[] LOOP
    PERFORM t.ok(t.err(t.u('OW'), t.set_sql(bad)) = '22023', 'P5 rejected ' || bad::text);
  END LOOP;
  PERFORM t.ok(t.err(t.u('OW'), 'public.continuity_set_policies(''[]''::jsonb, 4)') = '22023'
               AND t.err(t.u('OW'), 'public.continuity_set_policies(''{"stale_after_days": 9}''::jsonb, null)') = '22023', 'P5 shapes');
  PERFORM t.ok((SELECT version FROM public.continuity_policies) = 4 AND (SELECT count(*) FROM public.continuity_policy_history) = 3, 'P5 nothing written');
  PERFORM t.ok(t.err(t.u('OW'), t.set_sql('{"reminder_offsets_minutes": []}')) = 'ok', 'P5 empty offsets allowed');
  PERFORM t.call(t.u('OW'), t.set_sql('{"reminder_offsets_minutes": [60]}'));
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS P5: نص بدل رقم، كسر، خارج الحدود، أكثر من 5 تذكيرات، قيمة غير معروفة، مفاتيح غير قابلة للتعديل، ورقعة فارغة أو بنسخة null — كلها 22023 ولا يُكتب شيء';
END $$;

-- ── P6: لا تفعيل لقدرة غير مثبتة ─────────────────────────────────────────────
DO $$
DECLARE c text;
BEGIN
  PERFORM t.ctx('admin');
  FOREACH c IN ARRAY array['handovers', 'reminders', 'escalation', 'monitor', 'attachments', 'ai'] LOOP
    PERFORM t.ok(t.err(t.u('OW'), t.set_sql(jsonb_build_object(c || '_enabled', true))) = '0A000', 'P6 enable ' || c);
    -- الإطفاء (لا تغيير) مسموح
    PERFORM t.ok(t.err(t.u('OW'), t.set_sql(jsonb_build_object(c || '_enabled', false))) = 'ok', 'P6 disable ' || c);
  END LOOP;
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.continuity_policies WHERE handovers_enabled OR reminders_enabled OR escalation_enabled
                                                             OR monitor_enabled OR attachments_enabled OR ai_enabled), 'P6 still off');
  -- العلامة: لو هجرة قدرة أنشأت _continuity_capability_monitor() يصبح التفعيل ممكنًا (ثم نحذفها)
  CREATE FUNCTION public._continuity_capability_monitor() RETURNS boolean LANGUAGE sql AS 'select true';
  PERFORM t.ok(t.err(t.u('OW'), t.set_sql('{"monitor_enabled": true}')) = 'ok', 'P6 installed marker allows enable');
  PERFORM t.ok((t.call(t.u('S1'), 'public.continuity_my_access()') -> 'capabilities' ->> 'monitor')::boolean
               AND NOT (t.call(t.u('S1'), 'public.continuity_my_access()') -> 'capabilities' ->> 'handovers')::boolean, 'P6 effective monitor');
  PERFORM t.call(t.u('OW'), t.set_sql('{"monitor_enabled": false}'));
  DROP FUNCTION public._continuity_capability_monitor();
  PERFORM t.ok(NOT (t.call(t.u('S1'), 'public.continuity_my_access()') -> 'capabilities' ->> 'monitor')::boolean, 'P6 back off');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS P6: تفعيل أي قدرة قبل تثبيت كودها مرفوض (0A000)، والإطفاء مسموح؛ وبعد العلامة يصبح التفعيل ممكنًا ويظهر في capabilities';
END $$;

-- ── P7: continuity_my_access و الصلاحيات والثبات ─────────────────────────────────
DO $$
DECLARE m jsonb; c text;
BEGIN
  PERFORM t.ctx('admin');
  m := t.call(t.u('S1'), 'public.continuity_my_access()');
  PERFORM t.ok(m -> 'capabilities' = '{"ai":false,"monitor":false,"handovers":false,"reminders":false,"escalation":false,"attachments":false}'::jsonb,
               'P7 member capabilities');
  m := t.call(t.u('C1'), 'public.continuity_my_access()');
  PERFORM t.ok(m = '{"member":false,"enabled":false,"supervisor":false,"can_assign":false,"owner":false,"capabilities":{"ai":false,"monitor":false,"handovers":false,"reminders":false,"escalation":false,"attachments":false}}'::jsonb,
               'P7 non-member ' || m::text);
  PERFORM t.ok((SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND (p.proname LIKE 'continuity\_%' OR p.proname LIKE '\_continuity\_%')
                   AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) = 21, 'P7 21 RPCs');
  FOREACH c IN ARRAY array['public._continuity_capabilities()', 'public._continuity_capability_installed(text)',
                           'public._continuity_effective_capabilities()', 'public._continuity_policy_json(public.continuity_policies)'] LOOP
    PERFORM t.ok(NOT has_function_privilege('authenticated', c, 'EXECUTE') AND NOT has_function_privilege('anon', c, 'EXECUTE')
                 AND NOT has_function_privilege('service_role', c, 'EXECUTE'), 'P7 internal ' || c);
  END LOOP;
  PERFORM t.ok(NOT has_function_privilege('service_role', 'public.continuity_set_policies(jsonb,integer)', 'EXECUTE')
               AND NOT has_table_privilege('service_role', 'public.continuity_policies', 'UPDATE'), 'P7 service_role');
  -- الثبات حتى للمالك الخارق
  BEGIN UPDATE public.continuity_policy_history SET changed = '{}'; RAISE EXCEPTION 'FAIL P7 history update';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN DELETE FROM public.continuity_policy_history; RAISE EXCEPTION 'FAIL P7 history delete';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN TRUNCATE public.continuity_policy_history; RAISE EXCEPTION 'FAIL P7 history truncate';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN DELETE FROM public.continuity_policies; RAISE EXCEPTION 'FAIL P7 policy delete';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN TRUNCATE public.continuity_policies; RAISE EXCEPTION 'FAIL P7 policy truncate';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  -- القيود تحمي حتى من التحديث المباشر للمالك الخارق
  BEGIN UPDATE public.continuity_policies SET reminder_offsets_minutes = '{1}'; RAISE EXCEPTION 'FAIL P7 check';
  EXCEPTION WHEN check_violation THEN NULL; END;
  -- وضع المعاينة لا يكتب
  PERFORM t.ok(public.preview_mode() IS NOT NULL, 'P7 preview fn');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS P7: capabilities كلها false للعضو وغير العضو، 21 دالة فقط لـ authenticated، المساعدات وservice_role بلا صلاحية، والسجل والسياسة لا يُحذفان ولا يُفرَّغان حتى للمالك الخارق';
END $$;

-- ============================================================================
-- ② إعادة التشغيل والتراجع وإعادة التطبيق
-- ============================================================================
\i migrations/078_continuity_policies.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok((SELECT count(*) FROM public.continuity_policies) = 1 AND (SELECT count(*) FROM public.continuity_policy_history) >= 3
               AND (SELECT version FROM public.continuity_policies) >= 4, 'RERUN data kept');
  RAISE NOTICE 'PASS RERUN: إعادة تشغيل 078 تنجح وتحتفظ بالسياسة والسجل';
END $$;

\set rollback_sql `cat migrations/_rollback/078_continuity_policies.down.sql`
SELECT set_config('t.rollback_sql', :'rollback_sql', false) IS NOT NULL;
DO $$
DECLARE c text;
BEGIN
  PERFORM t.dblink_connect('rb', format('dbname=%s port=%s host=%s user=postgres', current_database(),
            current_setting('port'), split_part(current_setting('unix_socket_directories'), ',', 1)));
  BEGIN
    PERFORM t.dblink_exec('rb', current_setting('t.rollback_sql'));
    c := 'ok';
  EXCEPTION WHEN others THEN c := sqlerrm;
  END;
  PERFORM t.dblink_disconnect('rb');
  PERFORM t.ok(c LIKE '%rollback_discard_data%', 'RB refusal: ' || c);
  PERFORM t.ok(to_regclass('public.continuity_policies') IS NOT NULL, 'RB nothing removed');
  RAISE NOTICE 'PASS RB-a: التراجع يرفض لو سجل السياسات فيه تغييرات بلا continuity.rollback_discard_data=on';
END $$;
SET continuity.rollback_discard_data = 'on';
\i migrations/_rollback/078_continuity_policies.down.sql
RESET continuity.rollback_discard_data;
DO $$
BEGIN
  PERFORM t.ok(pg_get_functiondef('public.continuity_my_access()'::regprocedure) = (SELECT v FROM t.saved WHERE k = 'myaccess_077'),
               'RB continuity_my_access identical to 076');
  PERFORM t.ok(t.fn18_digest() = (SELECT v FROM t.saved WHERE k = 'fn18_076'), 'RB 18 functions untouched');
  PERFORM t.ok(t.access_matrix() = (SELECT v FROM t.saved WHERE k = 'access_076'), 'RB access matrix');
  PERFORM t.ok(to_regclass('public.continuity_policies') IS NULL AND to_regclass('public.continuity_policy_history') IS NULL
               AND to_regprocedure('public.continuity_set_policies(jsonb,integer)') IS NULL, 'RB objects gone');
  PERFORM t.ok(t.chat_digest() = (SELECT v FROM t.saved WHERE k = 'chat_before'), 'RB chat untouched');
  PERFORM t.ok((SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND (p.proname LIKE 'continuity\_%' OR p.proname LIKE '\_continuity\_%')
                   AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) = 19, 'RB 19 RPCs');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS RB-b: بعد التراجع continuity_my_access مطابقة لنصها في 077 حرفيًا، والدوال الـ18 كما هي، ولا جداول ولا دوال سياسات، والشات لم يُلمس';
END $$;
\i migrations/078_continuity_policies.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok((SELECT version FROM public.continuity_policies) = 1
               AND (t.call(t.u('S1'), 'public.continuity_get_policies()') -> 'policy' ->> 'escalate_after_minutes')::int = 240, 'RB-c defaults');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS RB-c: إعادة تطبيق 078 بعد التراجع تنجح بالقيم الافتراضية';
END $$;

\echo 'ALL continuity-policies tests passed'
