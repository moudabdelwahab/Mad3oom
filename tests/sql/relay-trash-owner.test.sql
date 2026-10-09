-- ============================================================================
-- Relay — المحذوفات والتحكم الأكبر للمالك (076_relay_trash_owner) على نسخة
-- مطابقة لشكل الإنتاج (073 + 074 مطبقان ومفعّل، كما في الإنتاج 2026-10-09)
--
-- قرار المالك 2026-10-09 15:39 UTC ("محذوفات + مسح للمالك"):
--   T1 إزالة واسترجاع لكل من يرى السجل · T2 المسح النهائي لمالك المنصة فقط ولا
--   رجوع عنه · T3 منح/سحب صلاحية الإسناد لمالك المنصة فقط
--
--   ⓪ 073 + 074 + بيانات قائمة
--   ① 076: عدم المساس، الصلاحيات، my_access، T1، C3 في المحذوفات، الإرفاق يسترجع،
--      T2، M8 كما هو، T3، التسرب، C5 على المحذوفات، انحدار P3
--   ② إعادة التشغيل، التراجع (رفض مع بيانات، النصوص قبل 076 حرفيًا)، إعادة التطبيق
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
         -- شكل الإنتاج: PostgREST يضبط claims كاملة (بلا relay_client للمسار الأصلي)
         set_config('request.jwt.claims', case when p is null then ''
                      else jsonb_build_object('sub', p, 'role', 'authenticated')::text end, false); $$;
-- نداء عبر relay-api (المرحلة G): claim relay_client
CREATE FUNCTION t.act_api(p uuid) RETURNS void LANGUAGE sql AS $$
  select set_config('request.jwt.claim.sub', p::text, false),
         set_config('request.jwt.claim.role', 'authenticated', false),
         set_config('request.jwt.claims', jsonb_build_object('sub', p, 'role', 'authenticated',
                                                             'relay_client', 'extension')::text, false); $$;
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
  select (t.call(p, format('public.relay_create(%L::jsonb)', t.req(p_key, p_msgs, p_extra))) -> 'record' ->> 'id')::uuid $$;
CREATE FUNCTION t.get(p uuid, p_rec uuid) RETURNS jsonb LANGUAGE sql AS $$
  select t.call(p, format('public.relay_get(%L::uuid)', p_rec)) $$;
CREATE FUNCTION t.ver(p_rec uuid) RETURNS int LANGUAGE plpgsql AS $$
begin return (select version from public.relay_records where id = p_rec); end $$;
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
  select format('public.relay_create(%L::jsonb)', t.req(p_key, p_msgs, p_extra)) $$;
CREATE FUNCTION t.assign_sql(p_rec uuid, p_owner uuid, p_team uuid) RETURNS text LANGUAGE sql AS $$
  select format('public.relay_assign(%L::uuid, %L::uuid, %L::uuid, %s)', p_rec, p_owner, p_team, t.ver(p_rec)) $$;
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
-- نص الدوال اللي 076 يعيد تعريفها، قبل 076 (لإثبات أن التراجع يعيدها حرفيًا).
CREATE FUNCTION t.fn_digest() RETURNS text LANGUAGE sql AS $$
  select md5(string_agg(pg_get_functiondef(f::regprocedure), '#' order by f))
    from unnest(array['public._relay_full(uuid,boolean)', 'public.relay_list(jsonb)',
                      'public.relay_attach_sources(uuid,jsonb,integer,boolean)', 'public.relay_redact_source(uuid,text)',
                      'public.relay_find_by_source(jsonb)', 'public.relay_my_access()',
                      'public.relay_list_assigners()', 'public.relay_grant_assigner(uuid)',
                      'public.relay_revoke_assigner(uuid)']) f $$;
-- الجداول تنشأ مع 073 لاحقًا
SET check_function_bodies = off;
CREATE FUNCTION t.src(p_rec uuid, p_msg text) RETURNS uuid LANGUAGE sql AS $$
  select id from public.relay_sources where record_id = p_rec and chat_message_id = ('3e550000-0000-4000-8000-0000000000' || p_msg)::uuid $$;
CREATE FUNCTION t.rm_sql(p_src uuid) RETURNS text LANGUAGE sql AS $$
  select format('public.relay_remove_source(%L::uuid, %s)', p_src,
                (select version from public.relay_records r join public.relay_sources s on s.record_id = r.id where s.id = p_src)) $$;
CREATE FUNCTION t.rs_sql(p_src uuid) RETURNS text LANGUAGE sql AS $$
  select format('public.relay_restore_source(%L::uuid, %s)', p_src,
                (select version from public.relay_records r join public.relay_sources s on s.record_id = r.id where s.id = p_src)) $$;
CREATE FUNCTION t.attach_sql(p_rec uuid, p_msgs uuid[]) RETURNS text LANGUAGE sql AS $$
  select format('public.relay_attach_sources(%L::uuid, %L::jsonb, %s, false)', p_rec,
                (select jsonb_agg(jsonb_build_object('type', 'mad3oom_message', 'provider', 'mad3oom',
                                   'internal', jsonb_build_object('chat_message_id', m))) from unnest(p_msgs) m),
                t.ver(p_rec)) $$;
CREATE FUNCTION t.ids(p jsonb) RETURNS text LANGUAGE sql AS $$
  select coalesce(string_agg(e ->> 'id', ',' order by (e ->> 'position')::int), '') from jsonb_array_elements(p) e $$;
RESET check_function_bodies;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

DO $$
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.act(t.u('S1'));
  PERFORM t.ok(public.is_platform_staff() AND public.account_is_active() AND NOT public._inbox_is_supervisor(), 'SETUP S1');
  PERFORM t.act(t.u('GR'));
  PERFORM t.ok(public.is_platform_staff() AND NOT public._inbox_is_supervisor()
               AND NOT public.inbox_can_access('5e550000-0000-4000-8000-0000000000a1'), 'SETUP GR');
  PERFORM t.act(t.u('EA'));
  PERFORM t.ok(public._inbox_is_supervisor(), 'SETUP EA');
  PERFORM t.act(t.u('AD'));
  PERFORM t.ok(public.is_platform_staff() AND NOT public._inbox_is_supervisor(), 'SETUP AD');
  PERFORM t.act(t.u('BN'));
  PERFORM t.ok(NOT public.account_is_active(), 'SETUP BN');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS SETUP: عميلان، 4 دعم (منهم GR)، أدمن عادي، مشرف، المالك في admin، دعم محظور، 3 محادثات، فريق';
END $$;

-- ============================================================================
-- ⓪ 073 + 074 كما في الإنتاج اليوم
-- ============================================================================
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
\i migrations/073_relay_core.sql
SET search_path = public, extensions;
UPDATE public.relay_workspaces SET enabled = true WHERE kind = 'platform';
\i migrations/074_relay_phase_c.sql
SET search_path = public, extensions;
INSERT INTO t.saved SELECT 'fn_074', t.fn_digest();

-- REC: أنشأه S1 من SA (a1,a2,a3) ومالكه S1 · OWN2: أنشأه EA من SA ومالكه S2 (بلا وصول لـ SA)
-- CLOSED: أنشأه S1 من SA (a1) ثم اتقفل
DO $$
DECLARE rid uuid;
BEGIN
  PERFORM t.ctx('admin');
  rid := t.mk(t.u('S1'), 'REC', array['3e550000-0000-4000-8000-0000000000a1', '3e550000-0000-4000-8000-0000000000a2',
                                      '3e550000-0000-4000-8000-0000000000a3']::uuid[], jsonb_build_object('owner_id', t.u('S1')));
  INSERT INTO t.saved VALUES ('REC', rid::text);
  rid := t.mk(t.u('EA'), 'OWN2', array['3e550000-0000-4000-8000-0000000000a1', '3e550000-0000-4000-8000-0000000000a2']::uuid[],
              jsonb_build_object('owner_id', t.u('S2')));
  INSERT INTO t.saved VALUES ('OWN2', rid::text);
  rid := t.mk(t.u('S1'), 'CLOSED', array['3e550000-0000-4000-8000-0000000000a1']::uuid[], '{}');
  PERFORM t.call(t.u('S1'), format('public.relay_transition(%L::uuid, ''resolved'', ''{"resolution_note":"تم"}'', %s)', rid, t.ver(rid)));
  INSERT INTO t.saved VALUES ('CLOSED', rid::text);
  PERFORM t.ok((SELECT count(*) FROM public.relay_sources) = 6, 'SETUP 6 sources');
  PERFORM t.act(NULL);
END $$;
INSERT INTO t.saved SELECT 'matrix_before', t.matrix();
INSERT INTO t.saved SELECT 'chat_before', t.chat_digest();
INSERT INTO t.saved SELECT 'rec_get_before', t.get(t.u('S1'), (SELECT v::uuid FROM t.saved WHERE k = 'REC'))::text;
INSERT INTO t.saved SELECT 'sources_before', (SELECT md5(string_agg(md5(to_jsonb(s)::text), ',' order by s.id)) FROM public.relay_sources s);
INSERT INTO t.saved SELECT 'snaps_before', (SELECT md5(string_agg(md5(to_jsonb(s)::text), ',' order by s.id)) FROM public.relay_source_snapshots s);

-- ============================================================================
-- ① تطبيق 076
-- ============================================================================
\i migrations/076_relay_trash_owner.sql
SET search_path = public, extensions;

-- ── X0: لا مساس ─────────────────────────────────────────────────────────────
DO $$
DECLARE g jsonb; b jsonb := (SELECT v::jsonb FROM t.saved WHERE k = 'rec_get_before');
BEGIN
  PERFORM t.ok(t.matrix() = (SELECT v FROM t.saved WHERE k = 'matrix_before'), 'X0 matrix');
  PERFORM t.ok(t.chat_digest() = (SELECT v FROM t.saved WHERE k = 'chat_before'), 'X0 chat');
  PERFORM t.ok((SELECT md5(string_agg(md5((to_jsonb(s) - 'removed_at' - 'removed_by' - 'purged_at' - 'purged_by')::text), ',' order by s.id))
                  FROM public.relay_sources s) = (SELECT v FROM t.saved WHERE k = 'sources_before'), 'X0 sources unchanged');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.relay_sources WHERE removed_at IS NOT NULL OR purged_at IS NOT NULL), 'X0 nothing removed');
  PERFORM t.ok((SELECT md5(string_agg(md5(to_jsonb(s)::text), ',' order by s.id)) FROM public.relay_source_snapshots s)
               = (SELECT v FROM t.saved WHERE k = 'snaps_before'), 'X0 snapshots unchanged');
  g := t.get(t.u('S1'), (SELECT v::uuid FROM t.saved WHERE k = 'REC'));
  PERFORM t.ok(g - 'removed' = b AND g -> 'removed' = '[]'::jsonb, 'X0 get = before + removed []');
  PERFORM t.ok((SELECT enabled FROM public.relay_workspaces WHERE kind = 'platform'), 'X0 still enabled');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS X0: تطبيق 076 لا يغيّر inbox_can_access ولا الشات/الصندوق ولا المصادر واللقطات القائمة، وrelay_get نفسه + removed فاضية';
END $$;

-- ── X1: الصلاحيات ───────────────────────────────────────────────────────────
DO $$
DECLARE f text;
BEGIN
  PERFORM t.ok((SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND (p.proname LIKE 'relay\_%' OR p.proname LIKE '\_relay\_%')
                   AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) = 19, 'X1 exactly 19 public RPCs');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                            WHERE n.nspname = 'public' AND (p.proname LIKE 'relay\_%' OR p.proname LIKE '\_relay\_%')
                              AND (has_function_privilege('service_role', p.oid, 'EXECUTE')
                                   OR has_function_privilege('anon', p.oid, 'EXECUTE'))), 'X1 no anon/service_role');
  FOREACH f IN ARRAY array['public._relay_is_owner()', 'public._relay_require_owner()',
                           'public._relay_purge(''00000000-0000-4000-8000-000000000000''::uuid, ''manual'')',
                           'public._relay_full(''00000000-0000-4000-8000-000000000000''::uuid, false)'] LOOP
    PERFORM t.ok(t.err(t.u('OW'), f) = '42501', 'X1 internal ' || f);
  END LOOP;
  FOREACH f IN ARRAY array['select public.relay_list_removed()', 'select public.relay_purge_removed()',
                           'select public.relay_remove_source(null, 1)', 'select public.relay_restore_source(null, 1)'] LOOP
    PERFORM t.ok(t.err_anon(f) = '42501', 'X1 anon ' || f);
  END LOOP;
  -- الأعمدة الجديدة: لا تحديث مباشر (حتى المالك)
  PERFORM t.ok(t.err_stmt(t.u('OW'), 'update public.relay_sources set removed_at = now()') = '42501', 'X1 direct update');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS X1: 19 RPC عامة بالضبط (4 جديدة)؛ بلا anon/service_role؛ المساعدات الجديدة و_relay_full ⇒ 42501 حتى للمالك؛ لا تحديث مباشر للمصادر';
END $$;

-- ── X2: relay_my_access.owner ───────────────────────────────────────────────
DO $$
BEGIN
  PERFORM t.ok(t.call(t.u('S1'), 'public.relay_my_access()') = '{"member":true,"enabled":true,"supervisor":false,"can_assign":false,"owner":false}'::jsonb, 'X2 S1');
  PERFORM t.ok(t.call(t.u('EA'), 'public.relay_my_access()') = '{"member":true,"enabled":true,"supervisor":true,"can_assign":true,"owner":false}'::jsonb, 'X2 EA');
  PERFORM t.ok(t.call(t.u('OW'), 'public.relay_my_access()') = '{"member":true,"enabled":true,"supervisor":true,"can_assign":true,"owner":true}'::jsonb, 'X2 OW');
  PERFORM t.ok(t.call_api(t.u('OW'), 'public.relay_my_access()') ->> 'owner' = 'false', 'X2 OW via api');
  PERFORM t.ok(t.call(t.u('C1'), 'public.relay_my_access()') ->> 'owner' = 'false', 'X2 customer');
  PERFORM t.ok(t.call(t.u('BN'), 'public.relay_my_access()') ->> 'owner' = 'false', 'X2 banned');
  PERFORM t.ctx('customer');
  PERFORM t.ok(t.call(t.u('OW'), 'public.relay_my_access()') = '{"member":false,"enabled":false,"supervisor":false,"can_assign":false,"owner":false}'::jsonb, 'X2 OW customer ctx');
  PERFORM t.ok(t.err(t.u('OW'), 'public.relay_purge_removed()') = '42501', 'X2 OW customer ctx purge');
  PERFORM t.ctx('admin');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS X2: owner=true لمالك المنصة في سياق admin فقط؛ المشرف والدعم والعميل والمحظور والمالك عبر الـAPI أو في سياق العميل ⇒ false';
END $$;

-- ── X3: T1 الإزالة والاسترجاع ───────────────────────────────────────────────
DO $$
DECLARE rid uuid := (SELECT v::uuid FROM t.saved WHERE k = 'REC'); s2 uuid; g jsonb; v0 int; l jsonb; e text;
BEGIN
  s2 := t.src(rid, 'a2');
  v0 := t.ver(rid);
  -- من لا يرى السجل ⇒ نفس رد غير الموجود؛ العميل والمحظور ⇒ 42501؛ نسخة قديمة ⇒ 40001
  PERFORM t.ok(t.err(t.u('S2'), t.rm_sql(s2)) = 'P0002', 'T1 S2 cannot see');
  PERFORM t.ok(t.err(t.u('S2'), format('public.relay_remove_source(%L::uuid, 1)', gen_random_uuid())) = 'P0002', 'T1 unknown id same reply');
  PERFORM t.ok(t.err(t.u('C1'), t.rm_sql(s2)) = '42501', 'T1 customer');
  PERFORM t.ok(t.err(t.u('BN'), t.rm_sql(s2)) = '42501', 'T1 banned');
  PERFORM t.ok(t.err(t.u('S1'), format('public.relay_remove_source(%L::uuid, %s)', s2, v0 - 1)) = '40001', 'T1 stale version');
  PERFORM t.ok(t.err(t.u('S1'), format('public.relay_remove_source(%L::uuid, null)', s2)) = '22023', 'T1 null version');
  PERFORM t.ok(t.ver(rid) = v0 AND NOT EXISTS (SELECT 1 FROM public.relay_sources WHERE removed_at IS NOT NULL), 'T1 nothing written');
  -- S1 يزيل a2
  g := t.call(t.u('S1'), t.rm_sql(s2));
  PERFORM t.ok(jsonb_array_length(g -> 'sources') = 2 AND NOT (g -> 'sources')::text LIKE '%MARKERA2%', 'T1 gone from sources');
  PERFORM t.ok(jsonb_array_length(g -> 'removed') = 1 AND g -> 'removed' -> 0 ->> 'id' = s2::text
               AND g -> 'removed' -> 0 ->> 'excerpt' LIKE 'MARKERA2%' AND g -> 'removed' -> 0 ->> 'removed_by' = t.u('S1')::text
               AND g -> 'removed' -> 0 ->> 'removed_at' IS NOT NULL, 'T1 in removed ' || (g -> 'removed')::text);
  PERFORM t.ok((g -> 'record' ->> 'version')::int = v0 + 1, 'T1 version bump');
  PERFORM t.ok((SELECT excerpt LIKE 'MARKERA2%' AND redacted_at IS NULL FROM public.relay_source_snapshots WHERE source_id = s2), 'T1 excerpt kept');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.relay_events WHERE record_id = rid AND kind = 'source_removed'
                         AND payload = jsonb_build_object('source_id', s2, 'position', 2) AND actor_id = t.u('S1')), 'T1 event');
  -- إعادة الإزالة لا تفعل شيئًا
  g := t.call(t.u('S1'), t.rm_sql(s2));
  PERFORM t.ok((g -> 'record' ->> 'version')::int = v0 + 1
               AND (SELECT count(*) FROM public.relay_events WHERE record_id = rid AND kind = 'source_removed') = 1, 'T1 idempotent');
  -- القائمة والعدد والتتبع
  l := t.call(t.u('S1'), 'public.relay_list()');
  PERFORM t.ok((SELECT (x ->> 'source_count')::int FROM jsonb_array_elements(l) x WHERE x ->> 'id' = rid::text) = 2, 'T1 list count');
  PERFORM t.ok(t.call(t.u('S1'), format('public.relay_find_by_source(%L::jsonb)',
                 '{"type":"mad3oom_message","internal":{"chat_message_id":"3e550000-0000-4000-8000-0000000000a2"}}'))::text
               NOT LIKE '%' || rid::text || '%', 'T1 find_by_source excludes removed');
  PERFORM t.ok(t.call(t.u('S1'), format('public.relay_find_by_source(%L::jsonb)',
                 '{"type":"mad3oom_message","internal":{"chat_message_id":"3e550000-0000-4000-8000-0000000000a1"}}'))::text
               LIKE '%' || rid::text || '%', 'T1 find_by_source keeps others');
  -- المحذوفات عبر السجلات
  l := t.call(t.u('S1'), 'public.relay_list_removed()');
  PERFORM t.ok(jsonb_array_length(l) = 1 AND l -> 0 -> 'record' ->> 'id' = rid::text AND l -> 0 -> 'source' ->> 'excerpt' LIKE 'MARKERA2%'
               AND (l -> 0 -> 'record' ->> 'version')::int = v0 + 1, 'T1 list_removed S1');
  PERFORM t.ok(t.call(t.u('S2'), 'public.relay_list_removed()') = '[]'::jsonb, 'T1 list_removed S2 sees nothing');
  PERFORM t.ok(jsonb_array_length(t.call(t.u('EA'), 'public.relay_list_removed()')) = 1, 'T1 list_removed supervisor');
  PERFORM t.ok(t.err(t.u('C1'), 'public.relay_list_removed()') = '42501', 'T1 list_removed customer');
  -- الاسترجاع: من لا يرى ⇒ P0002؛ S3 (عضو؟ لا) ؛ المالك S1 يسترجع لنفس المكان
  PERFORM t.ok(t.err(t.u('S2'), t.rs_sql(s2)) = 'P0002', 'T1 restore S2');
  PERFORM t.ok(t.err(t.u('S1'), format('public.relay_restore_source(%L::uuid, %s)', s2, t.ver(rid) - 1)) = '40001', 'T1 restore stale');
  g := t.call(t.u('S1'), t.rs_sql(s2));
  PERFORM t.ok(jsonb_array_length(g -> 'sources') = 3 AND g -> 'sources' -> 1 ->> 'id' = s2::text
               AND g -> 'sources' -> 1 ->> 'excerpt' LIKE 'MARKERA2%' AND g -> 'removed' = '[]'::jsonb, 'T1 restored in place');
  PERFORM t.ok((g -> 'record' ->> 'version')::int = v0 + 2
               AND (SELECT removed_at IS NULL AND removed_by IS NULL FROM public.relay_sources WHERE id = s2), 'T1 restore columns');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.relay_events WHERE record_id = rid AND kind = 'source_restored'
                         AND payload = jsonb_build_object('source_id', s2, 'position', 2)), 'T1 restore event');
  -- استرجاع مصدر مش محذوف ⇒ لا شيء
  g := t.call(t.u('S1'), t.rs_sql(s2));
  PERFORM t.ok((g -> 'record' ->> 'version')::int = v0 + 2, 'T1 restore idempotent');
  -- المشرف يزيل ويسترجع في سجل غيره (يرى كل السجلات)
  PERFORM t.ok(t.err(t.u('EA'), t.rm_sql(t.src(rid, 'a3'))) = 'ok' AND t.err(t.u('EA'), t.rs_sql(t.src(rid, 'a3'))) = 'ok', 'T1 supervisor');
  -- سجل مقفول ⇒ 55000 للإزالة والاسترجاع
  rid := (SELECT v::uuid FROM t.saved WHERE k = 'CLOSED');
  PERFORM t.ok(t.err(t.u('S1'), t.rm_sql(t.src(rid, 'a1'))) = '55000', 'T1 closed remove');
  UPDATE public.relay_sources SET removed_at = now(), removed_by = t.u('S1') WHERE id = t.src(rid, 'a1');
  PERFORM t.ok(t.err(t.u('S1'), t.rs_sql(t.src(rid, 'a1'))) = '55000', 'T1 closed restore');
  UPDATE public.relay_sources SET removed_at = NULL, removed_by = NULL WHERE id = t.src(rid, 'a1');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS T1: الإزالة تنقل المصدر للمحذوفات بلا مسح للمقتطف (version+1، حدث بلا نص)، وتخرجه من العدد والتتبع؛ الاسترجاع يرجّعه لنفس المكان؛ التكرار لا يفعل شيئًا؛ من لا يرى ⇒ P0002 بنفس رد غير الموجود، العميل/المحظور ⇒ 42501، نسخة قديمة ⇒ 40001، مقفول ⇒ 55000؛ list_removed حسب رؤية السجل';
END $$;

-- ── X4: C3 في المحذوفات + الإرفاق يسترجع ───────────────────────────────────
DO $$
DECLARE rid uuid := (SELECT v::uuid FROM t.saved WHERE k = 'OWN2'); s1 uuid; g jsonb; l jsonb;
BEGIN
  s1 := t.src(rid, 'a1');
  -- S2 مالك السجل بلا وصول لـ SA: يزيل (P1) لكن لا يرى المقتطف لا في المصادر ولا في المحذوفات
  g := t.call(t.u('S2'), t.rm_sql(s1));
  PERFORM t.ok(g -> 'removed' -> 0 ->> 'excerpt_hidden' = 'no_conversation_access' AND NOT (g::text LIKE '%MARKERA%')
               AND NOT (g -> 'removed' -> 0 ? 'sender_label'), 'C3 removed hidden for S2');
  l := t.call(t.u('S2'), 'public.relay_list_removed()');
  PERFORM t.ok(jsonb_array_length(l) = 1 AND l -> 0 -> 'source' ->> 'excerpt_hidden' = 'no_conversation_access'
               AND NOT (l::text LIKE '%MARKERA%'), 'C3 list_removed hidden for S2');
  -- نقل المحادثة لـ S2 ⇒ يرى في القراءة التالية؛ ورجوعها ⇒ يختفي
  UPDATE public.inbox_conversations SET assignee_id = t.u('S2') WHERE session_id = '5e550000-0000-4000-8000-0000000000a1';
  PERFORM t.ok(t.get(t.u('S2'), rid) -> 'removed' -> 0 ->> 'excerpt' LIKE 'MARKERA1%', 'C3 removed visible after assign');
  UPDATE public.inbox_conversations SET assignee_id = t.u('S1') WHERE session_id = '5e550000-0000-4000-8000-0000000000a1';
  PERFORM t.ok(t.call(t.u('S2'), 'public.relay_list_removed()') -> 0 -> 'source' ->> 'excerpt_hidden' = 'no_conversation_access', 'C3 hidden again');
  -- إعادة إرفاق رسالة محذوفة: S2 لا يقرأ SA ⇒ نفس رد غير الموجود ولا استرجاع
  PERFORM t.ok(t.err(t.u('S2'), t.attach_sql(rid, array['3e550000-0000-4000-8000-0000000000a1']::uuid[])) = 'P0002', 'ATT S2 no access');
  PERFORM t.ok((SELECT removed_at IS NOT NULL FROM public.relay_sources WHERE id = s1), 'ATT still removed');
  -- EA (يقرأ SA) يعيد إرفاقها ⇒ ترجع بدل التجاهل
  g := t.call(t.u('EA'), t.attach_sql(rid, array['3e550000-0000-4000-8000-0000000000a1']::uuid[]));
  PERFORM t.ok((g ->> 'added')::int = 0 AND (g ->> 'restored')::int = 1 AND g -> 'removed' = '[]'::jsonb
               AND t.ids(g -> 'sources') = s1::text || ',' || t.src(rid, 'a2')::text, 'ATT restored ' || g::text);
  PERFORM t.ok((SELECT count(*) FROM public.relay_sources WHERE record_id = rid) = 2, 'ATT no duplicate row');
  -- إرفاق رسالة جديدة + محذوفة في نفس الطلب
  PERFORM t.call(t.u('EA'), t.rm_sql(s1));
  g := t.call(t.u('EA'), t.attach_sql(rid, array['3e550000-0000-4000-8000-0000000000a1', '3e550000-0000-4000-8000-0000000000a3']::uuid[]));
  PERFORM t.ok((g ->> 'added')::int = 1 AND (g ->> 'restored')::int = 1 AND jsonb_array_length(g -> 'sources') = 3, 'ATT mixed');
  -- إرفاق مكرر بالكامل بلا محذوفات ⇒ لا تغيير في النسخة
  PERFORM t.ok((t.call(t.u('EA'), t.attach_sql(rid, array['3e550000-0000-4000-8000-0000000000a1']::uuid[])) -> 'record' ->> 'version')::int
               = t.ver(rid), 'ATT dup no bump');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS C3/ATT: المقتطف في المحذوفات خاضع لـ C3 في كل قراءة (get وlist_removed)؛ إعادة إرفاق رسالة محذوفة ترجّعها بدل التجاهل (بلا صف مكرر)، ومن لا يقرأ المحادثة ⇒ P0002 بلا استرجاع';
END $$;

-- ── X5: T2 المسح النهائي للمالك فقط ─────────────────────────────────────────
DO $$
DECLARE rid uuid := (SELECT v::uuid FROM t.saved WHERE k = 'REC'); s3 uuid; s1 uuid; g jsonb; v0 int; n jsonb; c text;
BEGIN
  s3 := t.src(rid, 'a3');
  s1 := t.src(rid, 'a1');
  -- منشئ ومالك السجل S1 والمشرف EA كان مسموح لهم في 073؛ الآن ⇒ 42501 forbidden field owner
  PERFORM t.ok(t.errfull(t.u('S1'), format('public.relay_redact_source(%L::uuid)', s3)) LIKE '42501|%"field": "owner"%', 'T2 S1 forbidden');
  PERFORM t.ok(t.err(t.u('EA'), format('public.relay_redact_source(%L::uuid, ''manual'')', s3)) = '42501', 'T2 EA forbidden');
  PERFORM t.ok(t.call_api(t.u('OW'), format('public.relay_my_access()')) ->> 'owner' = 'false', 'T2 api not owner');
  BEGIN
    PERFORM t.call_api(t.u('OW'), format('public.relay_redact_source(%L::uuid)', s3));
    c := 'ok';
  EXCEPTION WHEN others THEN c := sqlstate;
  END;
  -- عبر الـAPI المالك طاقم عادي: لا يرى سجل غيره (P0002)، ولا مسح في كل الأحوال
  PERFORM t.ok(c IN ('42501', 'P0002'), 'T2 OW via api refused ' || c);
  PERFORM t.ok(t.err(t.u('OW'), format('public.relay_redact_source(%L::uuid, ''bogus'')', s3)) = '22023', 'T2 bad reason');
  PERFORM t.ok((SELECT excerpt IS NOT NULL FROM public.relay_source_snapshots WHERE source_id = s3)
               AND (SELECT purged_at IS NULL FROM public.relay_sources WHERE id = s3), 'T2 nothing written');
  -- المالك يمسح مصدرًا ظاهرًا مباشرة
  v0 := t.ver(rid);
  g := t.call(t.u('OW'), format('public.relay_redact_source(%L::uuid)', s3));
  PERFORM t.ok(NOT (g::text LIKE '%' || s3::text || '%') AND NOT (g::text LIKE '%MARKERA3%'), 'T2 gone everywhere ' || g::text);
  PERFORM t.ok((SELECT excerpt IS NULL AND sender_label IS NULL AND redaction_reason = 'manual' AND redacted_by = t.u('OW')
                  FROM public.relay_source_snapshots WHERE source_id = s3), 'T2 snapshot redacted');
  PERFORM t.ok((SELECT purged_at IS NOT NULL AND purged_by = t.u('OW') AND removed_at IS NOT NULL AND removed_by = t.u('OW')
                  FROM public.relay_sources WHERE id = s3), 'T2 source purged');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.relay_events WHERE kind = 'source_redacted' AND actor_id = t.u('OW')
                         AND payload = jsonb_build_object('source_id', s3, 'reason', 'manual', 'purged', true)), 'T2 event');
  -- لا رجوع: استرجاع/إزالة ⇒ نفس رد غير الموجود، والمحفز يرفض حتى المالك الخارق
  PERFORM t.ok(t.err(t.u('OW'), t.rs_sql(s3)) = 'P0002' AND t.err(t.u('S1'), t.rs_sql(s3)) = 'P0002', 'T2 no restore');
  PERFORM t.ok(t.err(t.u('S1'), t.rm_sql(s3)) = 'P0002', 'T2 no remove');
  BEGIN
    UPDATE public.relay_sources SET removed_at = NULL, removed_by = NULL WHERE id = s3;
    c := 'ok';
  EXCEPTION WHEN others THEN c := sqlstate;
  END;
  PERFORM t.ok(c = '42501', 'T2 guard blocks un-purge as superuser');
  BEGIN
    UPDATE public.relay_sources SET purged_at = NULL, purged_by = NULL WHERE id = s3;
    c := 'ok';
  EXCEPTION WHEN others THEN c := sqlstate;
  END;
  PERFORM t.ok(c = '42501', 'T2 guard blocks purged_at reset');
  BEGIN
    UPDATE public.relay_sources SET removed_by = t.u('OW') WHERE id = s1;
    c := 'ok';
  EXCEPTION WHEN others THEN c := sqlstate;
  END;
  PERFORM t.ok(c = '23514', 'T2 removed_by needs removed_at ' || c);
  -- الحجب المسبق لا يتكرر: نفس النداء مرة تانية لا يضيف حدثًا
  PERFORM t.call(t.u('OW'), format('public.relay_redact_source(%L::uuid)', s3));
  PERFORM t.ok((SELECT count(*) FROM public.relay_events WHERE kind = 'source_redacted' AND payload ->> 'source_id' = s3::text) = 1, 'T2 idempotent');
  -- لا إعادة التقاط: إرفاق نفس الرسالة بعد المسح لا يرجّع شيئًا
  g := t.call(t.u('S1'), t.attach_sql(rid, array['3e550000-0000-4000-8000-0000000000a3']::uuid[]));
  PERFORM t.ok((g ->> 'added')::int = 0 AND (g ->> 'restored')::int = 0 AND NOT (g::text LIKE '%MARKERA3%'), 'T2 no recapture');
  -- تفريغ المحذوفات: غير المالك ⇒ 42501
  PERFORM t.call(t.u('S1'), t.rm_sql(s1));
  PERFORM t.ok(t.err(t.u('S1'), 'public.relay_purge_removed()') = '42501' AND t.err(t.u('EA'), 'public.relay_purge_removed()') = '42501'
               AND t.err(t.u('S1'), format('public.relay_purge_removed(%L::uuid)', rid)) = '42501', 'T2 purge forbidden');
  PERFORM t.ok(t.err(t.u('OW'), format('public.relay_purge_removed(%L::uuid)', gen_random_uuid())) = 'P0002', 'T2 purge unknown record');
  -- المالك يفرّغ محذوفات سجل واحد: OWN2 فيه محذوف كمان ويفضل
  PERFORM t.call(t.u('EA'), t.rm_sql(t.src((SELECT v::uuid FROM t.saved WHERE k = 'OWN2'), 'a2')));
  n := t.call(t.u('OW'), format('public.relay_purge_removed(%L::uuid)', rid));
  PERFORM t.ok(n = '{"purged":1}'::jsonb, 'T2 purge one record ' || n::text);
  PERFORM t.ok((SELECT purged_at IS NOT NULL FROM public.relay_sources WHERE id = s1)
               AND (SELECT excerpt IS NULL FROM public.relay_source_snapshots WHERE source_id = s1), 'T2 s1 purged');
  PERFORM t.ok(jsonb_array_length(t.call(t.u('OW'), 'public.relay_list_removed()')) = 1, 'T2 other record kept');
  n := t.call(t.u('OW'), 'public.relay_purge_removed()');
  PERFORM t.ok(n = '{"purged":1}'::jsonb AND t.call(t.u('OW'), 'public.relay_list_removed()') = '[]'::jsonb, 'T2 purge all');
  PERFORM t.ok(t.call(t.u('OW'), 'public.relay_purge_removed()') = '{"purged":0}'::jsonb, 'T2 purge empty');
  -- المسح على سجل مقفول مسموح للمالك (يقلل الانكشاف فقط)
  rid := (SELECT v::uuid FROM t.saved WHERE k = 'CLOSED');
  g := t.call(t.u('OW'), format('public.relay_redact_source(%L::uuid)', t.src(rid, 'a1')));
  PERFORM t.ok(g -> 'sources' = '[]'::jsonb AND g -> 'removed' = '[]'::jsonb, 'T2 closed purge');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS T2: المسح النهائي (relay_redact_source manual وتفريغ المحذوفات لسجل أو للكل) لمالك المنصة فقط: المنشئ والمالك والمشرف ⇒ 42501 والمالك عبر الـAPI مرفوض؛ يمسح المقتطف ويخفي المصدر من كل مكان؛ لا استرجاع ولا إزالة بعده (P0002) والمحفز يرفض حتى للمالك الخارق؛ لا إعادة التقاط؛ يعمل على سجل مقفول';
END $$;

-- ── X6: M8 كما هو (حجب للمشرف بلا إخفاء) ────────────────────────────────────
DO $$
DECLARE rid uuid; sid uuid; g jsonb; n int;
BEGIN
  rid := t.mk(t.u('S3'), 'DSR', array['3e550000-0000-4000-8000-0000000000c1', '3e550000-0000-4000-8000-0000000000c2']::uuid[], '{}');
  sid := t.src(rid, 'c1');
  PERFORM t.ok(t.err(t.u('S3'), format('public.relay_redact_source(%L::uuid, ''data_subject_request'')', sid)) = '42501', 'M8 staff forbidden');
  g := t.call(t.u('EA'), format('public.relay_redact_source(%L::uuid, ''data_subject_request'')', sid));
  PERFORM t.ok(g -> 'sources' -> 0 ->> 'id' = sid::text AND g -> 'sources' -> 0 -> 'redacted' ->> 'reason' = 'data_subject_request'
               AND (SELECT purged_at IS NULL AND removed_at IS NULL FROM public.relay_sources WHERE id = sid), 'M8 redacted, not hidden');
  n := t.call(t.u('EA'), format('public.relay_redact_for_subject(%L::uuid)', t.u('C1')))::text::int;
  PERFORM t.ok(n >= 1 AND NOT EXISTS (SELECT 1 FROM public.relay_source_snapshots ss WHERE ss.origin_customer_id = t.u('C1') AND ss.excerpt IS NOT NULL), 'M8 subject');
  PERFORM t.ok(t.err(t.u('S1'), format('public.relay_redact_for_subject(%L::uuid)', t.u('C1'))) = '42501', 'M8 subject staff');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS M8: طلب حذف البيانات كما في 073: للمشرف فقط، حجب بلا إخفاء، وrelay_redact_for_subject بلا تغيير';
END $$;

-- ── X7: T3 صلاحية الإسناد للمالك فقط ────────────────────────────────────────
DO $$
DECLARE g jsonb; c text;
BEGIN
  PERFORM t.ok(t.errfull(t.u('EA'), format('public.relay_grant_assigner(%L::uuid)', t.u('GR'))) LIKE '42501|%"field": "owner"%', 'T3 EA grant');
  PERFORM t.ok(t.err(t.u('EA'), format('public.relay_revoke_assigner(%L::uuid)', t.u('GR'))) = '42501', 'T3 EA revoke');
  PERFORM t.ok(t.err(t.u('EA'), 'public.relay_list_assigners()') = '42501', 'T3 EA list');
  PERFORM t.ok(t.err(t.u('S1'), format('public.relay_grant_assigner(%L::uuid)', t.u('GR'))) = '42501', 'T3 S1 grant');
  PERFORM t.ok(t.err(t.u('C1'), 'public.relay_list_assigners()') = '42501', 'T3 customer');
  BEGIN
    PERFORM t.call_api(t.u('OW'), format('public.relay_grant_assigner(%L::uuid)', t.u('GR')));
    c := 'ok';
  EXCEPTION WHEN others THEN c := sqlstate;
  END;
  PERFORM t.ok(c = '42501', 'T3 OW via api');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.relay_assigners), 'T3 nothing written');
  g := t.call(t.u('OW'), format('public.relay_grant_assigner(%L::uuid)', t.u('GR')));
  PERFORM t.ok(g ->> 'changed' = 'true' AND (SELECT granted_by FROM public.relay_assigners WHERE user_id = t.u('GR')) = t.u('OW'), 'T3 OW grant');
  PERFORM t.ok(t.call(t.u('GR'), 'public.relay_my_access()') ->> 'can_assign' = 'true', 'T3 GR can assign');
  PERFORM t.ok(jsonb_array_length(t.call(t.u('OW'), 'public.relay_list_assigners()')) = 1, 'T3 OW list');
  PERFORM t.ok(t.err(t.u('OW'), format('public.relay_grant_assigner(%L::uuid)', t.u('BN'))) = '22023', 'T3 not eligible');
  g := t.call(t.u('OW'), format('public.relay_revoke_assigner(%L::uuid)', t.u('GR')));
  PERFORM t.ok(g ->> 'changed' = 'true' AND t.call(t.u('GR'), 'public.relay_my_access()') ->> 'can_assign' = 'false', 'T3 OW revoke');
  PERFORM t.ok(t.call(t.u('EA'), 'public.relay_my_access()') ->> 'can_assign' = 'true', 'T3 supervisor still assigns');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS T3: منح وسحب وعرض صلاحية الإسناد لمالك المنصة فقط (المشرف والدعم والعميل والمالك عبر الـAPI ⇒ 42501 field owner)؛ المشرف ما زال يسند بنفسه';
END $$;

-- ── X8: التسرب + الاحتفاظ على المحذوفات + انحدار P3 ─────────────────────────
DO $$
DECLARE rid uuid; sid uuid; g jsonb; h text; n int; a text;
BEGIN
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.relay_events WHERE payload::text ~ '(MARKER|TITLEMARK|SUMMARYMARK|45879)'), 'LEAK events text');
  FOR h IN SELECT excerpt_sha256 FROM public.relay_source_snapshots LOOP
    PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.relay_events WHERE payload::text LIKE '%' || h || '%'), 'LEAK events hash');
  END LOOP;
  FOREACH a IN ARRAY array['S1', 'S2', 'S3', 'EA', 'OW'] LOOP
    PERFORM t.ok(NOT (t.call(t.u(a), 'public.relay_list_removed()')::text ~ '(excerpt_sha256|origin_customer_id)'), 'LEAK list_removed ' || a);
  END LOOP;
  -- (رسالة C2: بيانات C1 اتحجبت في M8 فلا تُلتقط تاني)
  -- C5: مصدر في المحذوفات لسجل مقفول من 365 يوم ⇒ الكنس يمسح نصه، ويظل في المحذوفات
  rid := t.mk(t.u('S2'), 'RET', array['3e550000-0000-4000-8000-0000000000b1']::uuid[], '{}');
  sid := t.src(rid, 'b1');
  PERFORM t.call(t.u('S2'), t.rm_sql(sid));
  PERFORM t.call(t.u('S2'), format('public.relay_transition(%L::uuid, ''resolved'', ''{"resolution_note":"تم"}'', %s)', rid, t.ver(rid)));
  UPDATE public.relay_records SET closed_at = now() - interval '8760 hours' - interval '1 minute' WHERE id = rid;
  g := t.get(t.u('S2'), rid);
  PERFORM t.ok((g -> 'removed' -> 0 ->> 'retention_expired')::boolean AND NOT (g::text LIKE '%MARKERB1%'), 'C5 mask on removed');
  n := public.relay_retention_sweep();
  PERFORM t.ok(n >= 1 AND (SELECT excerpt IS NULL AND redaction_reason = 'retention' FROM public.relay_source_snapshots WHERE source_id = sid), 'C5 sweep removed');
  -- P3 كما هو
  PERFORM t.ok(t.err(t.u('S1'), t.create_sql('P3a', '{}', jsonb_build_object('owner_id', t.u('S2')))) = '42501', 'P3 staff still forbidden');
  PERFORM t.ok(t.err(t.u('EA'), t.create_sql('P3b', '{}', jsonb_build_object('owner_id', t.u('S2')))) = 'ok', 'P3 supervisor ok');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS LEAK/C5/P3: لا نص ولا بصمة في الأحداث وlist_removed؛ الاحتفاظ يسري على المحذوفات (قناع ثم كنس)؛ P3 كما هو';
END $$;

-- ============================================================================
-- ② إعادة التشغيل والتراجع وإعادة التطبيق
-- ============================================================================
\i migrations/076_relay_trash_owner.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok((SELECT count(*) FROM public.relay_sources WHERE purged_at IS NOT NULL) = 4
               AND (SELECT count(*) FROM public.relay_sources WHERE removed_at IS NOT NULL AND purged_at IS NULL) = 1, 'RERUN data kept');
  RAISE NOTICE 'PASS RERUN: إعادة تشغيل 076 تنجح وتحتفظ بالمحذوفات والممسوح';
END $$;

\set rollback_sql `cat migrations/_rollback/076_relay_trash_owner.down.sql`
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
  PERFORM t.ok(to_regprocedure('public.relay_remove_source(uuid,integer)') IS NOT NULL, 'RB nothing removed');
  RAISE NOTICE 'PASS RB-a: التراجع يرفض لو فيه مصادر في المحذوفات أو ممسوحة بلا relay.rollback_discard_data=on';
END $$;
INSERT INTO t.saved SELECT 'counts_before_rb', (SELECT count(*) FROM public.relay_records)::text || '/' || (SELECT count(*) FROM public.relay_sources)::text;
INSERT INTO t.saved SELECT 'chat_before_rb', t.chat_digest();
SET relay.rollback_discard_data = 'on';
\i migrations/_rollback/076_relay_trash_owner.down.sql
RESET relay.rollback_discard_data;
DO $$
DECLARE rid uuid := (SELECT v::uuid FROM t.saved WHERE k = 'OWN2'); g jsonb;
BEGIN
  PERFORM t.ok(t.fn_digest() = (SELECT v FROM t.saved WHERE k = 'fn_074'), 'RB functions identical to pre-076');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'relay_sources'
                            AND column_name IN ('removed_at', 'removed_by', 'purged_at', 'purged_by'))
               AND to_regprocedure('public.relay_remove_source(uuid,integer)') IS NULL
               AND to_regprocedure('public._relay_is_owner()') IS NULL, 'RB objects gone');
  PERFORM t.ok((SELECT count(*) FROM public.relay_records)::text || '/' || (SELECT count(*) FROM public.relay_sources)::text
               = (SELECT v FROM t.saved WHERE k = 'counts_before_rb'), 'RB records and sources kept');
  PERFORM t.ok(t.chat_digest() = (SELECT v FROM t.saved WHERE k = 'chat_before_rb'), 'RB chat untouched');
  -- قواعد 073/074 رجعت: المشرف يمنح، والمنشئ يحجب
  PERFORM t.ok(t.err(t.u('EA'), format('public.relay_grant_assigner(%L::uuid)', t.u('GR'))) = 'ok', 'RB supervisor grants again');
  g := t.get(t.u('EA'), rid);
  PERFORM t.ok(jsonb_array_length(g -> 'sources') = 3 AND NOT (g ? 'removed'), 'RB removed sources back in record');
  PERFORM t.ok((SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND (p.proname LIKE 'relay\_%' OR p.proname LIKE '\_relay\_%')
                   AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) = 15, 'RB 15 RPCs');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS RB-b: بعد التراجع الدوال مطابقة لنصها قبل 076 حرفيًا، لا أعمدة ولا دوال محذوفات، السجلات والمصادر باقية، الشات لم يُلمس، وقواعد 074 رجعت';
END $$;
\i migrations/076_relay_trash_owner.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok(t.call(t.u('OW'), 'public.relay_my_access()') ->> 'owner' = 'true'
               AND t.err(t.u('EA'), format('public.relay_revoke_assigner(%L::uuid)', t.u('GR'))) = '42501', 'RB-c owner rules back');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS RB-c: إعادة تطبيق 076 بعد التراجع تنجح وقواعد المالك ترجع';
END $$;
