-- ============================================================================
-- Relay — المرحلة B (073_relay_core) على نسخة مطابقة لشكل الإنتاج
--
-- يغطي حالات الاختبار العدائية 1–24 المطلوبة (رسالة المالك 2026-10-09 11:22 UTC)
-- وضوابط المرحلة B: M1، M4–M8، M9 (جزء B)، M10، M11. كل كتلة تطبع PASS بالرقم.
--
--   ⓪ قبل 073: مصفوفة inbox_can_access + بصمات جداول الشات والصندوق
--   ① بعد 073: مطفأ افتراضيًا، C1، الأدوار، C3/M11، C4، C5/M6/M7، الحجب M10،
--      التسرب M4/M5، الاستنتاج، الصلاحيات المباشرة، التكرار، الانتقالات،
--      التوازي (dblink)، الفشل الجزئي
--   ② التراجع وإعادة التطبيق
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

-- ── الفاعلون ──────────────────────────────────────────────────────────────
--  C1/C2 عملاء · S1/S2/S3 دعم · AD أدمن عادي · EA أدمن مرتفع (مشرف) · OW المالك
--  BN دعم محظور · CA مالك شركة (دور شركة)
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-8000-0000000000c1', 'c1@t.io'), ('00000000-0000-4000-8000-0000000000c2', 'c2@t.io'),
  ('00000000-0000-4000-8000-0000000000a5', 's1@t.io'), ('00000000-0000-4000-8000-0000000000a6', 's2@t.io'),
  ('00000000-0000-4000-8000-0000000000a7', 's3@t.io'), ('00000000-0000-4000-8000-0000000000ad', 'ad@t.io'),
  ('00000000-0000-4000-8000-0000000000ea', 'ea@t.io'), ('00000000-0000-4000-8000-0000000000f0', 'ow@t.io'),
  ('00000000-0000-4000-8000-0000000000b0', 'bn@t.io'), ('00000000-0000-4000-8000-0000000000ca', 'ca@t.io');
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at) VALUES
  ('00000000-0000-4000-8000-0000000000c1', 'c1@t.io', 'عميل واحد', 'user', '01000000041', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000c2', 'c2@t.io', 'عميل اتنين', 'user', '01000000042', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000a5', 's1@t.io', 'دعم 1', 'support', '01000000043', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000a6', 's2@t.io', 'دعم 2', 'support', '01000000044', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000a7', 's3@t.io', 'دعم 3', 'support', '01000000045', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000ad', 'ad@t.io', 'أدمن', 'admin', '01000000046', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000ea', 'ea@t.io', 'أدمن مرتفع', 'admin', '01000000047', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000f0', 'ow@t.io', 'المالك', 'platform_owner', '01000000048', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000b0', 'bn@t.io', 'دعم محظور', 'support', '01000000049', '2026-09-01');
UPDATE public.profiles SET ban_status = 'banned' WHERE id = '00000000-0000-4000-8000-0000000000b0';
INSERT INTO public.platform_authority (user_id, level) VALUES
  ('00000000-0000-4000-8000-0000000000f0', 'owner'), ('00000000-0000-4000-8000-0000000000ea', 'elevated_admin');

-- المحادثات: SA (C1، مسندة S1)، SB (C2، مسندة S2)، SC (C1، فريق T1 فيه S3)، SD (C2، مسندة S1، ستُحذف)
INSERT INTO public.chat_sessions (id, user_id) VALUES
  ('5e550000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1'),
  ('5e550000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000c2'),
  ('5e550000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000c1'),
  ('5e550000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000c2');
INSERT INTO public.inbox_teams (id, name) VALUES ('7ea70000-0000-4000-8000-000000000001', 'فريق المتابعة');
INSERT INTO public.inbox_team_members (team_id, user_id) VALUES
  ('7ea70000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a7');
INSERT INTO public.inbox_conversations (session_id, assignee_id, team_id) VALUES
  ('5e550000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a5', NULL),
  ('5e550000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a6', NULL),
  ('5e550000-0000-4000-8000-0000000000c1', NULL, '7ea70000-0000-4000-8000-000000000001'),
  ('5e550000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000a5', NULL);
INSERT INTO public.chat_messages (id, session_id, sender_id, message_text, is_admin_reply, created_at) VALUES
  ('3e550000-0000-4000-8000-0000000000a1', '5e550000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1',
   'MARKERA1 العميل بيسأل عن الشحنة', false, '2026-10-01 09:00+00'),
  ('3e550000-0000-4000-8000-0000000000a2', '5e550000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a5',
   'MARKERA2 رد الدعم: هنتابع بكرة', true, '2026-10-01 09:05+00'),
  ('3e550000-0000-4000-8000-0000000000a3', '5e550000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1',
   'رقم الكارت 4111 1111 1111 1111 لو احتجته', false, '2026-10-01 09:06+00'),
  ('3e550000-0000-4000-8000-0000000000a4', '5e550000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1',
   'MARKERA4 رسالة للاحتفاظ', false, '2026-10-01 09:07+00'),
  ('3e550000-0000-4000-8000-0000000000b1', '5e550000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000c2',
   'MARKERB1 عميل تاني', false, '2026-10-01 10:00+00'),
  ('3e550000-0000-4000-8000-0000000000c1', '5e550000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000c1',
   'MARKERC1 محادثة الفريق', false, '2026-10-01 11:00+00'),
  ('3e550000-0000-4000-8000-0000000000d1', '5e550000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000c2',
   'MARKERD1 محادثة ستُحذف', false, '2026-10-01 12:00+00');

CREATE TABLE t.actors (name text PRIMARY KEY, id uuid NOT NULL);
INSERT INTO t.actors VALUES
  ('S1', '00000000-0000-4000-8000-0000000000a5'), ('S2', '00000000-0000-4000-8000-0000000000a6'),
  ('S3', '00000000-0000-4000-8000-0000000000a7'), ('AD', '00000000-0000-4000-8000-0000000000ad'),
  ('EA', '00000000-0000-4000-8000-0000000000ea'), ('OW', '00000000-0000-4000-8000-0000000000f0'),
  ('BN', '00000000-0000-4000-8000-0000000000b0'), ('C1', '00000000-0000-4000-8000-0000000000c1');
-- مصفوفة الوصول للمحادثات (المالك في سياق admin)
CREATE FUNCTION t.matrix() RETURNS text LANGUAGE plpgsql AS $$
declare a record; s uuid; o text := '';
begin
  perform t.ctx('admin');
  for a in select * from t.actors order by name loop
    perform t.act(a.id);
    foreach s in array array['5e550000-0000-4000-8000-0000000000a1', '5e550000-0000-4000-8000-0000000000b1',
                             '5e550000-0000-4000-8000-0000000000c1', '5e550000-0000-4000-8000-0000000000d1',
                             '00000000-0000-4000-8000-00000000dead']::uuid[] loop
      o := o || a.name || ':' || public.inbox_can_access(s)::text || ' ';
    end loop;
    o := o || public.inbox_is_agent()::text || '; ';
  end loop;
  perform t.act(null);
  return o;
end $$;
CREATE TABLE t.saved (k text PRIMARY KEY, v text);

DO $$
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.act('00000000-0000-4000-8000-0000000000a5');
  PERFORM t.ok(public.is_platform_staff() AND public.account_is_active() AND NOT public._inbox_is_supervisor()
               AND public.inbox_can_access('5e550000-0000-4000-8000-0000000000a1')
               AND NOT public.inbox_can_access('5e550000-0000-4000-8000-0000000000b1'), 'SETUP S1');
  PERFORM t.act('00000000-0000-4000-8000-0000000000ea');
  PERFORM t.ok(public._inbox_is_supervisor() AND public.account_is_active(), 'SETUP EA supervisor');
  PERFORM t.act('00000000-0000-4000-8000-0000000000ad');
  PERFORM t.ok(public.is_platform_staff() AND NOT public._inbox_is_supervisor(), 'SETUP AD plain admin');
  PERFORM t.act('00000000-0000-4000-8000-0000000000b0');
  PERFORM t.ok(public.is_banned('00000000-0000-4000-8000-0000000000b0') AND NOT public.account_is_active(), 'SETUP BN banned');
  PERFORM t.act('00000000-0000-4000-8000-0000000000f0');
  PERFORM t.ok(public._inbox_is_supervisor(), 'SETUP OW admin ctx supervisor');
  PERFORM t.act('00000000-0000-4000-8000-0000000000a7');
  PERFORM t.ok(public.inbox_can_access('5e550000-0000-4000-8000-0000000000c1')
               AND NOT public.inbox_can_access('5e550000-0000-4000-8000-0000000000a1'), 'SETUP S3 team');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS SETUP: عميلان، 3 دعم، أدمن عادي، أدمن مرتفع، المالك في سياق admin، دعم محظور، 4 محادثات، فريق';
END $$;

-- ============================================================================
-- ⓪ قبل 073
-- ============================================================================
INSERT INTO t.saved SELECT 'matrix_before', t.matrix();
INSERT INTO t.saved SELECT 'chat_before', t.chat_digest();
INSERT INTO t.saved SELECT 'notif_before', (SELECT count(*) FROM public.notifications)::text;

-- ============================================================================
-- ① بعد 073
-- ============================================================================
-- صلاحيات Supabase الافتراضية (كل دالة/جدول جديد ممنوح لـ anon و authenticated و
-- service_role) — الترحيل لازم يسحبها بنفسه
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
\i migrations/073_relay_core.sql
SET search_path = public, extensions;

-- ── 21: لا مساس بالصندوق والشات ─────────────────────────────────────────────
DO $$
BEGIN
  PERFORM t.ok(t.matrix() = (SELECT v FROM t.saved WHERE k = 'matrix_before'), '21a: مصفوفة inbox_can_access اتغيرت');
  PERFORM t.ok(t.chat_digest() = (SELECT v FROM t.saved WHERE k = 'chat_before'), '21b: بيانات الشات/الصندوق اتغيرت');
  RAISE NOTICE 'PASS 21 (جزء 1): تطبيق 073 لا يغيّر inbox_can_access لأي فاعل/محادثة ولا أي صف في الشات/الصندوق/التذاكر/الإشعارات';
END $$;

-- ── مطفأ افتراضيًا (لا تفعيل للمستخدمين) + C1 ───────────────────────────────
DO $$
DECLARE c text;
BEGIN
  PERFORM t.ok((SELECT count(*) FROM public.relay_workspaces) = 1
               AND (SELECT kind FROM public.relay_workspaces) = 'platform'
               AND NOT (SELECT enabled FROM public.relay_workspaces), 'OFF: الحالة بعد الترحيل');
  c := t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_create(%L::jsonb)', t.req('off', '{}')));
  PERFORM t.ok(c = '0A000', 'OFF: create ' || c);
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000ea', 'public.relay_list()') = '0A000', 'OFF: list');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000ea', format('public.relay_get(%L::uuid)', gen_random_uuid())) = '0A000', 'OFF: get');
  RAISE NOTICE 'PASS OFF: Relay مطفأ بعد الترحيل (enabled=false): create/list/get ⇒ 0A000 feature_not_enabled';
END $$;

UPDATE public.relay_workspaces SET enabled = true WHERE kind = 'platform';

-- ── 8: الأدوار ونطاق الشركات ────────────────────────────────────────────────
DO $$
DECLARE c text; r jsonb;
BEGIN
  -- عميل، محظور، بلا مستخدم، المالك في سياق customer أو سياق منتهٍ ⇒ 42501
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000c1', 'public.relay_list()') = '42501', '8a customer');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000b0', 'public.relay_list()') = '42501', '8b banned');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000b0',
                     format('public.relay_create(%L::jsonb)', t.req('bn', '{}'))) = '42501', '8b banned create');
  PERFORM t.act(NULL);
  PERFORM t.ok(t.err(NULL, 'public.relay_list()') = '42501', '8c no uid');
  PERFORM t.ok(t.err_anon('select public.relay_list()') = '42501', '8c anon');
  PERFORM t.ctx('customer');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000f0', 'public.relay_list()') = '42501', '8d owner customer ctx');
  PERFORM t.ctx('admin', false);
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000f0', 'public.relay_list()') = '42501', '8d owner expired ctx');
  PERFORM t.ctx('admin');
  -- الطاقم: دعم، أدمن عادي، مشرف، المالك في admin
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', 'public.relay_list()') = 'ok', '8e support');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000ad', 'public.relay_list()') = 'ok', '8e admin');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000f0', 'public.relay_list()') = 'ok', '8e owner admin ctx');
  -- C1: أي مساحة غير المنصة ⇒ feature_not_enabled، حتى لو المعرّف مزوّر لمساحة موجودة
  c := t.err('00000000-0000-4000-8000-0000000000a5',
             format('public.relay_create(%L::jsonb)', t.req('ws', '{}', jsonb_build_object('workspace_id', gen_random_uuid()))));
  PERFORM t.ok(c = '0A000', '8f company workspace create ' || c);
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5',
                     format('public.relay_list(%L::jsonb)', jsonb_build_object('workspace_id', gen_random_uuid()))) = '0A000', '8f list');
  -- handover (المرحلة D) غير مفعّل
  c := t.err('00000000-0000-4000-8000-0000000000a5',
             format('public.relay_create(%L::jsonb)', t.req('ho', '{}', '{"kind":"handover"}')));
  PERFORM t.ok(c = '0A000', '8g handover ' || c);
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS 8: عميل/محظور/بلا جلسة/anon/المالك في customer أو سياق منتهٍ ⇒ 42501؛ الدعم والأدمن والمالك في admin ⇒ مسموح؛ مساحة غير المنصة وhandover ⇒ 0A000';
END $$;

-- مساحة شركة مزروعة مباشرة (كأنها من مرحلة لاحقة) — لا أحد يصل لسجلاتها
INSERT INTO public.companies (id, user_id, company_name, commercial_registration_number)
VALUES ('c0000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c2', 'شركة', 'CR-1');
INSERT INTO public.relay_workspaces (id, kind, company_id, enabled)
VALUES ('c0000000-0000-4000-8000-0000000000ff', 'company', 'c0000000-0000-4000-8000-000000000001', true);
INSERT INTO public.relay_records (id, workspace_id, kind, title, owner_id, created_by, idempotency_key, request_hash, status,
                                  resolution_note, resolved_at, closed_at)
VALUES ('c0000000-0000-4000-8000-0000000000a1', 'c0000000-0000-4000-8000-0000000000ff', 'issue', 'شركة',
        '00000000-0000-4000-8000-0000000000a5', '00000000-0000-4000-8000-0000000000a5', gen_random_uuid(), 'x',
        'resolved', 'تم', now() - interval '10 days', now() - interval '10 days');
INSERT INTO public.relay_sources (id, record_id, workspace_id, position, source_type, provider, dedupe_key)
VALUES ('c0000000-0000-4000-8000-0000000000b1', 'c0000000-0000-4000-8000-0000000000a1',
        'c0000000-0000-4000-8000-0000000000ff', 1, 'mad3oom_message', 'mad3oom', 'company-src');
INSERT INTO public.relay_source_snapshots (source_id, record_id, workspace_id, origin_session_id, excerpt, excerpt_sha256)
VALUES ('c0000000-0000-4000-8000-0000000000b1', 'c0000000-0000-4000-8000-0000000000a1',
        'c0000000-0000-4000-8000-0000000000ff', '5e550000-0000-4000-8000-0000000000a1', 'COMPANYMARK', public._relay_hash('COMPANYMARK'));

DO $$
BEGIN
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000ea', 'public.relay_get(''c0000000-0000-4000-8000-0000000000a1''::uuid)') = 'P0002', '8h supervisor company record');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', 'public.relay_get(''c0000000-0000-4000-8000-0000000000a1''::uuid)') = 'P0002', '8h owner company record');
  PERFORM t.ok(NOT (t.call('00000000-0000-4000-8000-0000000000ea', 'public.relay_list()')::text LIKE '%c0000000-0000-4000-8000-0000000000a1%'), '8h list');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS 8 (شركة): سجل في مساحة شركة (مزروع مباشرة) غير مرئي حتى لمالكه وللمشرف — relay_can_access يتطلب مساحة المنصة';
END $$;

-- ── 1 + M11: سجل مع وصول للمحادثة ⇒ المقتطف ─────────────────────────────────
DO $$
DECLARE rid uuid; g jsonb; s1 jsonb; s2 jsonb;
BEGIN
  -- S1 ينشئ متابعة من رسالتين في SA، المالك S2 (مؤهل)
  rid := t.mk('00000000-0000-4000-8000-0000000000a5', 'R1',
              array['3e550000-0000-4000-8000-0000000000a1', '3e550000-0000-4000-8000-0000000000a2']::uuid[],
              jsonb_build_object('owner_id', '00000000-0000-4000-8000-0000000000a6'));
  INSERT INTO t.saved VALUES ('R1', rid::text);
  g := t.get('00000000-0000-4000-8000-0000000000a5', rid);
  s1 := g -> 'sources' -> 0; s2 := g -> 'sources' -> 1;
  PERFORM t.ok(s1 ->> 'excerpt' = 'MARKERA1 العميل بيسأل عن الشحنة' AND s1 ->> 'sender_label' = 'العميل'
               AND s2 ->> 'excerpt' LIKE 'MARKERA2%' AND s2 ->> 'sender_label' = 'الدعم'
               AND (s1 ->> 'chat_session_id')::uuid = '5e550000-0000-4000-8000-0000000000a1'
               AND (s1 ->> 'source_deleted')::boolean = false AND (s1 ->> 'edited_after_capture')::boolean = false
               AND s1 ->> 'excerpt_hidden' IS NULL, '1: ' || g::text);
  PERFORM t.ok(NOT (g::text LIKE '%excerpt_sha256%') AND NOT (g::text LIKE '%' || public._relay_hash('MARKERA1 العميل بيسأل عن الشحنة') || '%'), '1: hash leaked');
  -- المشرف EA: مقتطف (inbox_can_access للمشرف)
  g := t.get('00000000-0000-4000-8000-0000000000ea', rid);
  PERFORM t.ok(g -> 'sources' -> 0 ->> 'excerpt' LIKE 'MARKERA1%', '1: supervisor');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS 1: صاحب السجل مع وصول حالي لـ SA يرى المقتطفين بتصنيف المرسل والروابط؛ المشرف يرى؛ لا بصمة في الرد';
END $$;

-- ── 2: صلاحية السجل بلا صلاحية المحادثة ⇒ placeholder ───────────────────────
DO $$
DECLARE rid uuid := (SELECT v::uuid FROM t.saved WHERE k = 'R1'); g jsonb; s jsonb; i int;
BEGIN
  -- S2 مالك السجل لكن SA مسندة لـ S1
  g := t.get('00000000-0000-4000-8000-0000000000a6', rid);
  PERFORM t.ok(g -> 'record' ->> 'id' = rid::text AND jsonb_array_length(g -> 'sources') = 2, '2: record visible');
  FOR i IN 0..1 LOOP
    s := g -> 'sources' -> i;
    PERFORM t.ok(s ->> 'excerpt_hidden' = 'no_conversation_access' AND s -> 'excerpt' = 'null'::jsonb
                 AND NOT s ? 'sender_label' AND NOT s ? 'original_created_at' AND NOT s ? 'chat_session_id'
                 AND NOT s ? 'chat_message_id' AND NOT s ? 'truncated' AND NOT s ? 'source_deleted'
                 AND NOT s ? 'redacted' AND NOT s ? 'retention_expired', '2: placeholder ' || s::text);
  END LOOP;
  PERFORM t.ok(NOT (g::text LIKE '%MARKERA%') AND NOT (g::text LIKE '%5e550000-0000-4000-8000-0000000000a1%'), '2: leak');
  -- S3 (فريق آخر) لا يرى السجل أصلًا
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a7', format('public.relay_get(%L::uuid)', rid)) = 'P0002', '2: S3');
  -- الأدمن العادي AD (طاقم، ليس مشرفًا) لا يرى سجل غيره
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000ad', format('public.relay_get(%L::uuid)', rid)) = 'P0002', '2: AD');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS 2: S2 (مالك السجل، بلا وصول لـ SA) يرى السجل ومصدرين مخفيين {excerpt:null, excerpt_hidden} بلا مرسل/وقت/جلسة/رسالة/بصمة؛ S3 والأدمن العادي ⇒ P0002';
END $$;

-- ── 3: سحب صلاحية المحادثة بعد الإنشاء ⇒ القراءة التالية مخفية ─────────────
DO $$
DECLARE rid uuid := (SELECT v::uuid FROM t.saved WHERE k = 'R1'); g jsonb;
BEGIN
  UPDATE public.inbox_conversations SET assignee_id = '00000000-0000-4000-8000-0000000000a6'
   WHERE session_id = '5e550000-0000-4000-8000-0000000000a1';
  g := t.get('00000000-0000-4000-8000-0000000000a5', rid);   -- S1 المنشئ: فقد المحادثة
  PERFORM t.ok(g -> 'sources' -> 0 ->> 'excerpt_hidden' = 'no_conversation_access' AND NOT (g::text LIKE '%MARKERA%'), '3a creator hidden');
  g := t.get('00000000-0000-4000-8000-0000000000a6', rid);   -- S2 المالك: اكتسبها
  PERFORM t.ok(g -> 'sources' -> 0 ->> 'excerpt' LIKE 'MARKERA1%', '3b owner now sees');
  -- رجوع
  UPDATE public.inbox_conversations SET assignee_id = '00000000-0000-4000-8000-0000000000a5'
   WHERE session_id = '5e550000-0000-4000-8000-0000000000a1';
  g := t.get('00000000-0000-4000-8000-0000000000a5', rid);
  PERFORM t.ok(g -> 'sources' -> 0 ->> 'excerpt' LIKE 'MARKERA1%', '3c restored');
  g := t.get('00000000-0000-4000-8000-0000000000a6', rid);
  PERFORM t.ok(g -> 'sources' -> 0 ->> 'excerpt_hidden' = 'no_conversation_access', '3d S2 hidden again');
  -- سحب عبر الفريق: S3 عضو فريق T1 على SC؛ سجل S3 من SC ثم إخراج S3 من الفريق
  PERFORM t.ok(t.mk('00000000-0000-4000-8000-0000000000a7', 'R3', array['3e550000-0000-4000-8000-0000000000c1']::uuid[]) IS NOT NULL, '3e create');
  INSERT INTO t.saved SELECT 'R3', id::text FROM public.relay_records WHERE idempotency_key = md5('R3')::uuid;
  g := t.get('00000000-0000-4000-8000-0000000000a7', (SELECT v::uuid FROM t.saved WHERE k = 'R3'));
  PERFORM t.ok(g -> 'sources' -> 0 ->> 'excerpt' LIKE 'MARKERC1%', '3e team sees');
  DELETE FROM public.inbox_team_members WHERE user_id = '00000000-0000-4000-8000-0000000000a7';
  g := t.get('00000000-0000-4000-8000-0000000000a7', (SELECT v::uuid FROM t.saved WHERE k = 'R3'));
  PERFORM t.ok(g -> 'sources' -> 0 ->> 'excerpt_hidden' = 'no_conversation_access', '3f team removal hides');
  -- فريق مؤرشف كذلك
  INSERT INTO public.inbox_team_members (team_id, user_id) VALUES ('7ea70000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a7');
  UPDATE public.inbox_teams SET archived_at = now() WHERE id = '7ea70000-0000-4000-8000-000000000001';
  g := t.get('00000000-0000-4000-8000-0000000000a7', (SELECT v::uuid FROM t.saved WHERE k = 'R3'));
  PERFORM t.ok(g -> 'sources' -> 0 ->> 'excerpt_hidden' = 'no_conversation_access', '3g archived team hides');
  UPDATE public.inbox_teams SET archived_at = NULL WHERE id = '7ea70000-0000-4000-8000-000000000001';
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS 3: نقل إسناد SA من S1 ⇒ القراءة التالية للمنشئ مخفية والمالك الجديد يرى؛ الإرجاع يعيدها؛ الإخراج من الفريق أو أرشفته يخفي';
END $$;

-- ── M1: أنماط حساسة ─────────────────────────────────────────────────────────
DO $$
DECLARE c text; rid uuid; e jsonb;
BEGIN
  PERFORM t.ok(public._relay_sensitive_kinds('الكارت 4111 1111 1111 1111') @> array['card_number'], 'M1 card');
  PERFORM t.ok(public._relay_sensitive_kinds('الرقم القومي 29801011234567') @> array['national_id'], 'M1 nid');
  PERFORM t.ok(public._relay_sensitive_kinds('كود التحقق ٤٨٢٩١٣') @> array['otp'], 'M1 otp arabic digits');
  PERFORM t.ok(public._relay_sensitive_kinds('your verification code is 1234') @> array['otp'], 'M1 otp en');
  PERFORM t.ok(public._relay_sensitive_kinds('الباسورد: Abc123') @> array['password'], 'M1 pwd ar');
  PERFORM t.ok(public._relay_sensitive_kinds('password = hunter2') @> array['password'], 'M1 pwd en');
  PERFORM t.ok(cardinality(public._relay_sensitive_kinds('رقمي 01000000041 والطلب 1234 بكرة الساعة 10')) = 0, 'M1 no false positive');
  -- بلا إقرار ⇒ رفض، بلا أرقام في الخطأ
  c := t.errfull('00000000-0000-4000-8000-0000000000a5',
                 format('public.relay_create(%L::jsonb)', t.req('M1', array['3e550000-0000-4000-8000-0000000000a3']::uuid[])));
  PERFORM t.ok(c LIKE '22023|%' AND c LIKE '%sensitive_content%' AND c LIKE '%card_number%'
               AND NOT (c LIKE '%4111%') AND NOT (c LIKE '%الكارت%'), 'M1 reject: ' || c);
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.relay_records WHERE idempotency_key = md5('M1')::uuid), 'M1 nothing stored');
  -- بالإقرار ⇒ مقبول، والحدث فيه العلم والفئة فقط
  rid := t.mk('00000000-0000-4000-8000-0000000000a5', 'M1', array['3e550000-0000-4000-8000-0000000000a3']::uuid[],
              '{"sensitive_ack": true}');
  SELECT payload INTO e FROM public.relay_events WHERE record_id = rid AND kind = 'sensitive_ack';
  -- العلم فقط: الفئة استنتاج من محتوى قد يكون مخفيًا عن قارئ الأحداث
  PERFORM t.ok(e = '{"sensitive_ack": true}'::jsonb, 'M1 event ' || coalesce(e::text, 'null'));
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.relay_events WHERE payload::text LIKE '%4111%'), 'M1 no digits in events');
  INSERT INTO t.saved VALUES ('RM1', rid::text);
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS M1: كارت/رقم قومي/OTP (أرقام عربية)/باسورد مكتشفة، رقم موبايل لا؛ الإنشاء بلا sensitive_ack ⇒ 22023 بالفئة فقط ولا شيء يُخزن؛ بالإقرار يُقبل والحدث = {sensitive_ack} فقط';
END $$;

-- ── 7: معرّفات مزوّرة ───────────────────────────────────────────────────────
DO $$
DECLARE rid uuid; c text; snap record; req jsonb;
BEGIN
  -- S2 يحاول التقاط رسالة من SA (لا يصل لها) — حتى مع chat_session_id مزوّر لمحادثته SB
  req := t.req('F1', '{}', jsonb_build_object('sources', jsonb_build_array(jsonb_build_object(
           'type', 'mad3oom_message', 'internal', jsonb_build_object('chat_message_id', '3e550000-0000-4000-8000-0000000000a1',
                                                                    'chat_session_id', '5e550000-0000-4000-8000-0000000000b1')))));
  c := t.err('00000000-0000-4000-8000-0000000000a6', format('public.relay_create(%L::jsonb)', req));
  PERFORM t.ok(c = 'P0002', '7a forged session ' || c);
  -- S1 يرسل نص مقتطف ومرسل وجلسة ومنشئ ومساحة مزوّرة: الخادم يتجاهلها كلها
  req := t.req('F2', '{}', jsonb_build_object(
           'created_by', '00000000-0000-4000-8000-0000000000a6', 'created_via', 'system',
           'workspace_id', 'platform', 'request_hash', 'x', 'version', 99, 'status', 'resolved',
           'sources', jsonb_build_array(jsonb_build_object('type', 'mad3oom_message',
             'internal', jsonb_build_object('chat_message_id', '3e550000-0000-4000-8000-0000000000a1',
                                            'chat_session_id', '5e550000-0000-4000-8000-0000000000b1'),
             'excerpt', jsonb_build_object('text', 'FORGEDTEXT', 'sender_label', 'الدعم',
                                           'original_created_at', '2020-01-01T00:00:00Z')))));
  rid := (t.call('00000000-0000-4000-8000-0000000000a5', format('public.relay_create(%L::jsonb)', req)) -> 'record' ->> 'id')::uuid;
  SELECT ss.* INTO snap FROM public.relay_source_snapshots ss WHERE ss.record_id = rid;
  PERFORM t.ok(snap.excerpt = 'MARKERA1 العميل بيسأل عن الشحنة' AND snap.sender_label = 'العميل'
               AND snap.origin_session_id = '5e550000-0000-4000-8000-0000000000a1'
               AND snap.origin_customer_id = '00000000-0000-4000-8000-0000000000c1'
               AND snap.original_created_at = '2026-10-01 09:00+00', '7b server-derived snapshot');
  PERFORM t.ok((SELECT created_by = '00000000-0000-4000-8000-0000000000a5' AND created_via = 'native'
                       AND status = 'open' AND version = 1 AND request_hash <> 'x'
                  FROM public.relay_records WHERE id = rid), '7c server-derived record');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.relay_source_snapshots WHERE excerpt LIKE '%FORGED%'), '7d forged text');
  -- معرّف سجل عشوائي أو سجل غيرك ⇒ نفس P0002
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a6', format('public.relay_get(%L::uuid)', gen_random_uuid())) = 'P0002', '7e random');
  -- معرّف مستخدم في relay_redact_for_subject من غير مشرف ⇒ 42501
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5',
                     'public.relay_redact_for_subject(''00000000-0000-4000-8000-0000000000c1''::uuid)') = '42501', '7f subject');
  -- claim دور مزوّر لا يغيّر شيئًا: الهوية = sub
  PERFORM set_config('request.jwt.claim.role', 'service_role', false);
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000c1', 'public.relay_list()') = '42501', '7g role claim');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS 7: رسالة من محادثة غير مسموحة مع session مزوّر ⇒ P0002؛ نص/مرسل/وقت/جلسة/منشئ/مساحة/حالة/نسخة مزوّرة تُتجاهل والخادم يشتقها؛ معرّف عشوائي ⇒ P0002';
END $$;

-- ── 4 + C4: حذف الرسالة الأصلية / حذف المحادثة ──────────────────────────────
DO $$
DECLARE rid uuid := (SELECT v::uuid FROM t.saved WHERE k = 'R1'); g jsonb; s jsonb; rd uuid;
BEGIN
  -- S1 يحذف رده MA2 من الصندوق (المسار الحقيقي inbox_delete_message)
  PERFORM t.call('00000000-0000-4000-8000-0000000000a5', 'public.inbox_delete_message(''3e550000-0000-4000-8000-0000000000a2''::uuid)');
  PERFORM t.ok((SELECT deleted_at IS NOT NULL AND message_text = '' FROM public.chat_messages WHERE id = '3e550000-0000-4000-8000-0000000000a2'), '4 deleted');
  PERFORM t.ok((SELECT excerpt LIKE 'MARKERA2%' FROM public.relay_source_snapshots ss JOIN public.relay_sources s ON s.id = ss.source_id
                 WHERE s.record_id = rid AND s.chat_message_id = '3e550000-0000-4000-8000-0000000000a2'), '4 C4 retained in storage');
  -- مع وصول للمحادثة: المقتطف + علامة الحذف
  g := t.get('00000000-0000-4000-8000-0000000000a5', rid);
  s := g -> 'sources' -> 1;
  PERFORM t.ok(s ->> 'excerpt' LIKE 'MARKERA2%' AND (s ->> 'source_deleted')::boolean AND s ->> 'source_deleted_at' IS NOT NULL
               AND (s ->> 'edited_after_capture')::boolean = false, '4a with access ' || s::text);
  -- بلا وصول: placeholder (C4 لا يتخطى C3)
  g := t.get('00000000-0000-4000-8000-0000000000a6', rid);
  PERFORM t.ok(g -> 'sources' -> 1 ->> 'excerpt_hidden' = 'no_conversation_access' AND NOT (g::text LIKE '%MARKERA2%')
               AND NOT (g -> 'sources' -> 1 ? 'source_deleted'), '4b without access');
  -- حذف المحادثة SD كاملة (الصف نفسه) ⇒ مخفي للجميع حتى المشرف (U9 / fail closed)
  rd := t.mk('00000000-0000-4000-8000-0000000000a5', 'R4', array['3e550000-0000-4000-8000-0000000000d1']::uuid[]);
  INSERT INTO t.saved VALUES ('R4', rd::text);
  g := t.get('00000000-0000-4000-8000-0000000000ea', rd);
  PERFORM t.ok(g -> 'sources' -> 0 ->> 'excerpt' LIKE 'MARKERD1%', '4c before delete');
  DELETE FROM public.inbox_conversations WHERE session_id = '5e550000-0000-4000-8000-0000000000d1';
  DELETE FROM public.chat_messages WHERE session_id = '5e550000-0000-4000-8000-0000000000d1';
  DELETE FROM public.chat_sessions WHERE id = '5e550000-0000-4000-8000-0000000000d1';
  PERFORM t.ctx('admin');
  PERFORM t.act('00000000-0000-4000-8000-0000000000ea');
  PERFORM t.ok(public.inbox_can_access('5e550000-0000-4000-8000-0000000000d1'), '4d U9 baseline: inbox_can_access true for missing session');
  FOREACH rd IN ARRAY array['00000000-0000-4000-8000-0000000000ea', '00000000-0000-4000-8000-0000000000f0',
                            '00000000-0000-4000-8000-0000000000a5']::uuid[] LOOP
    g := t.get(rd, (SELECT v::uuid FROM t.saved WHERE k = 'R4'));
    PERFORM t.ok(g -> 'sources' -> 0 ->> 'excerpt_hidden' = 'no_conversation_access' AND NOT (g::text LIKE '%MARKERD1%'),
                 '4e deleted session hidden for ' || rd::text);
  END LOOP;
  PERFORM t.ok((SELECT excerpt LIKE 'MARKERD1%' AND origin_session_id = '5e550000-0000-4000-8000-0000000000d1'
                  FROM public.relay_source_snapshots WHERE record_id = (SELECT v::uuid FROM t.saved WHERE k = 'R4')), '4f C4 storage');
  PERFORM t.ok((SELECT chat_message_id IS NULL AND chat_session_id IS NULL FROM public.relay_sources
                 WHERE record_id = (SELECT v::uuid FROM t.saved WHERE k = 'R4')), '4g FK set null');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS 4: رد محذوف ⇒ المقتطف محفوظ (C4) ويظهر بعلامة الحذف لمن يصل للمحادثة فقط؛ محادثة محذوفة ⇒ مخفي للمشرف والمالك والمنشئ رغم أن inbox_can_access=true (U9)';
END $$;

-- ── 5: تفويض غير محسوم ⇒ مخفي ───────────────────────────────────────────────
BEGIN;
CREATE OR REPLACE FUNCTION public.inbox_can_access(p_session uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
begin raise exception 'simulated authorization failure'; end $$;
DO $$
DECLARE g jsonb;
BEGIN
  g := t.get('00000000-0000-4000-8000-0000000000a5', (SELECT v::uuid FROM t.saved WHERE k = 'R1'));
  PERFORM t.ok(g -> 'record' ->> 'id' IS NOT NULL AND g -> 'sources' -> 0 ->> 'excerpt_hidden' = 'no_conversation_access'
               AND NOT (g::text LIKE '%MARKERA%'), '5a raising check');
  PERFORM t.act(NULL);
END $$;
ROLLBACK;
BEGIN;
CREATE OR REPLACE FUNCTION public.inbox_can_access(p_session uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$ select null::boolean $$;
DO $$
DECLARE g jsonb;
BEGIN
  g := t.get('00000000-0000-4000-8000-0000000000a5', (SELECT v::uuid FROM t.saved WHERE k = 'R1'));
  PERFORM t.ok(g -> 'sources' -> 0 ->> 'excerpt_hidden' = 'no_conversation_access', '5b null check');
  PERFORM t.act(NULL);
END $$;
ROLLBACK;
-- origin_session_id = null (مزروع) ومزوّد بلا قاعدة
INSERT INTO public.relay_sources (id, record_id, workspace_id, position, source_type, provider, dedupe_key)
SELECT 'eeee0000-0000-4000-8000-000000000001', id, workspace_id, 10, 'mad3oom_message', 'mad3oom', 'null-origin'
  FROM public.relay_records WHERE id = (SELECT v::uuid FROM t.saved WHERE k = 'R1');
INSERT INTO public.relay_source_snapshots (source_id, record_id, workspace_id, origin_session_id, excerpt, excerpt_sha256)
SELECT 'eeee0000-0000-4000-8000-000000000001', id, workspace_id, NULL, 'NULLORIGINMARK', 'x'
  FROM public.relay_records WHERE id = (SELECT v::uuid FROM t.saved WHERE k = 'R1');
INSERT INTO public.relay_sources (id, record_id, workspace_id, position, source_type, provider, url_canonical, dedupe_key)
SELECT 'eeee0000-0000-4000-8000-000000000002', id, workspace_id, 11, 'web_selection', 'web', 'https://example.com', 'web-1'
  FROM public.relay_records WHERE id = (SELECT v::uuid FROM t.saved WHERE k = 'R1');
INSERT INTO public.relay_source_snapshots (source_id, record_id, workspace_id, origin_session_id, excerpt, excerpt_sha256)
SELECT 'eeee0000-0000-4000-8000-000000000002', id, workspace_id, '5e550000-0000-4000-8000-0000000000a1', 'WEBMARK', 'x'
  FROM public.relay_records WHERE id = (SELECT v::uuid FROM t.saved WHERE k = 'R1');
DO $$
DECLARE g jsonb;
BEGIN
  g := t.get('00000000-0000-4000-8000-0000000000ea', (SELECT v::uuid FROM t.saved WHERE k = 'R1'));
  PERFORM t.ok(g -> 'sources' -> 2 ->> 'excerpt_hidden' = 'no_conversation_access'
               AND g -> 'sources' -> 3 ->> 'excerpt_hidden' = 'no_provider_rule'
               AND NOT (g::text LIKE '%NULLORIGINMARK%') AND NOT (g::text LIKE '%WEBMARK%')
               AND g -> 'sources' -> 0 ->> 'excerpt' LIKE 'MARKERA1%', '5c ' || (g -> 'sources')::text);
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS 5: inbox_can_access يرفع خطأ أو يرجع NULL ⇒ السجل يرجع والمقتطف مخفي؛ origin_session_id=null ⇒ مخفي للمشرف؛ مزوّد web بلا قاعدة ⇒ no_provider_rule للمشرف';
END $$;

-- ── M11 عبر الـAPI: المالك في سياق admin يُعامَل كطاقم عادي ─────────────────
DO $$
DECLARE c text; g jsonb; rid uuid;
BEGIN
  PERFORM t.ctx('admin');
  -- native: المالك مشرف يرى سجل S1
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000f0', format('public.relay_get(%L::uuid)', (SELECT v FROM t.saved WHERE k = 'R1'))) = 'ok', 'API native');
  -- API: لا يرى سجل غيره
  BEGIN
    PERFORM t.call_api('00000000-0000-4000-8000-0000000000f0', format('public.relay_get(%L::uuid)', (SELECT v FROM t.saved WHERE k = 'R1')));
    c := 'ok';
  EXCEPTION WHEN others THEN c := sqlstate;
  END;
  PERFORM t.ok(c = 'P0002', 'API owner other record ' || c);
  -- API: سجل المالك نفسه من SA (غير مسندة له) ⇒ لا يقدر يلتقط؛ نزرعه native ثم نقرأ عبر API
  rid := t.mk('00000000-0000-4000-8000-0000000000f0', 'OWAPI', array['3e550000-0000-4000-8000-0000000000a1']::uuid[]);
  g := t.call_api('00000000-0000-4000-8000-0000000000f0', format('public.relay_get(%L::uuid)', rid));
  PERFORM t.ok(g -> 'sources' -> 0 ->> 'excerpt_hidden' = 'no_conversation_access', 'API owner unassigned hidden');
  g := t.get('00000000-0000-4000-8000-0000000000f0', rid);
  PERFORM t.ok(g -> 'sources' -> 0 ->> 'excerpt' LIKE 'MARKERA1%', 'API owner native sees');
  -- API: claims غير صالحة ⇒ تعامل كـ API (الأقل صلاحية)
  PERFORM set_config('request.jwt.claims', '{not json', false);
  PERFORM t.act('00000000-0000-4000-8000-0000000000f0');
  PERFORM set_config('request.jwt.claims', '{not json', false);
  PERFORM t.ok(public._relay_via_api() AND NOT public._relay_is_supervisor(), 'API malformed claims');
  PERFORM set_config('request.jwt.claims', '', false);
  PERFORM t.ok(public._relay_via_api() AND NOT public._relay_is_supervisor(), 'API absent claims with uid');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS M11/API: المالك في سياق admin عبر relay_client=extension ليس مشرفًا (سجل غيره ⇒ P0002) ومقتطف محادثة غير مسندة له مخفي؛ claims تالفة أو غائبة مع مستخدم ⇒ أقل صلاحية';
END $$;

-- بعد حذف SD في 4 (تغيير مقصود في الصندوق نفسه) — مرجع المقارنة لما بعد عمليات Relay
INSERT INTO t.saved SELECT 'matrix_mid', t.matrix();

-- ── 6 + 18 + M4/M5: مسارات القراءة البديلة والتسرب ───────────────────────────
DO $$
DECLARE rid uuid := (SELECT v::uuid FROM t.saved WHERE k = 'R1'); l jsonb; ev jsonb; f jsonb; h text; a uuid;
BEGIN
  FOREACH a IN ARRAY array['00000000-0000-4000-8000-0000000000a5', '00000000-0000-4000-8000-0000000000a6',
                           '00000000-0000-4000-8000-0000000000ea']::uuid[] LOOP
    l := t.call(a, 'public.relay_list()');
    PERFORM t.ok(jsonb_array_length(l) >= 1 AND NOT (l::text LIKE '%MARKER%') AND NOT (l::text LIKE '%excerpt%')
                 AND NOT (l::text LIKE '%sender_label%') AND NOT (l::text LIKE '%الشحنة%'), '6a list ' || a::text);
    ev := t.call(a, format('public.relay_events_for(%L::uuid)', rid));
    PERFORM t.ok(jsonb_array_length(ev) >= 3 AND NOT (ev::text LIKE '%MARKER%') AND NOT (ev::text LIKE '%TITLEMARK%')
                 AND NOT (ev::text LIKE '%SUMMARYMARK%'), '6b events ' || a::text);
  END LOOP;
  -- لا بصمة مقتطف في أي حدث (جدول الأحداث كله)
  FOR h IN SELECT excerpt_sha256 FROM public.relay_source_snapshots WHERE excerpt_sha256 ~ '^[0-9a-f]{64}$' LOOP
    PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.relay_events WHERE payload::text LIKE '%' || h || '%'), '18 hash in events');
  END LOOP;
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.relay_events
                            WHERE payload::text ~ '(MARKER|TITLEMARK|SUMMARYMARK|اتصل بالعميل|4111)'), '18 text in events');
  -- M5: حدث الإنشاء فيه بصمات 64 hex للنصوص الحرة
  SELECT payload INTO ev FROM public.relay_events WHERE record_id = rid AND kind = 'created';
  PERFORM t.ok(ev -> 'fields' ->> 'title' = public._relay_hash('TITLEMARK R1') AND ev -> 'fields' ->> 'title' ~ '^[0-9a-f]{64}$', 'M5 title digest');
  -- find_by_source: S1 يصل ⇒ يرجع السجل بلا مقتطف؛ S2 لا يصل لـ SA ⇒ []
  f := t.call('00000000-0000-4000-8000-0000000000a5', format('public.relay_find_by_source(%L::jsonb)',
         '{"type":"mad3oom_message","internal":{"chat_message_id":"3e550000-0000-4000-8000-0000000000a1"}}'));
  PERFORM t.ok(f::text LIKE '%' || rid::text || '%' AND NOT (f::text LIKE '%MARKER%') AND NOT (f::text LIKE '%excerpt%'), '6c find S1');
  f := t.call('00000000-0000-4000-8000-0000000000a6', format('public.relay_find_by_source(%L::jsonb)',
         '{"type":"mad3oom_message","internal":{"chat_message_id":"3e550000-0000-4000-8000-0000000000a1"}}'));
  PERFORM t.ok(f = '[]'::jsonb, '6d find S2 (owner of R1, no SA access) ' || f::text);
  f := t.call('00000000-0000-4000-8000-0000000000a6', format('public.relay_find_by_source(%L::jsonb)',
         '{"type":"mad3oom_conversation","internal":{"chat_session_id":"5e550000-0000-4000-8000-0000000000a1"}}'));
  PERFORM t.ok(f = '[]'::jsonb, '6e find conversation S2');
  -- B2: لا إشعارات من Relay في المرحلة B
  PERFORM t.ok((SELECT count(*) FROM public.notifications)::text = (SELECT v FROM t.saved WHERE k = 'notif_before'), '18 notifications');
  -- لا raise notice/warning في دوال Relay (لا مسار للسجلات)
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                            WHERE n.nspname = 'public' AND (p.proname LIKE 'relay\_%' OR p.proname LIKE '\_relay\_%')
                              AND p.prosrc ~* 'raise\s+(notice|warning|info|log|debug)'), '18 logs');
  -- الدوال الداخلية غير قابلة للاستدعاء
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000ea', format('public._relay_source_view(%L::uuid)', gen_random_uuid())) = '42501', '6f source_view');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000ea', format('public._relay_full(%L::uuid, false)', rid)) = '42501', '6f full');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000ea', format('public.relay_can_access(%L::uuid)', rid)) = '42501', '6f can_access');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000ea', 'public._relay_can_read_conversation(''5e550000-0000-4000-8000-0000000000a1''::uuid)') = '42501', '6f conv');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS 6/18/M4/M5: relay_list وrelay_events_for لـ S1/S2/المشرف بلا مقتطف ولا مرسل ولا نص حر؛ لا بصمة مقتطف في أي حدث؛ find_by_source بلا وصول ⇒ []؛ 0 إشعارات؛ لا raise notice؛ الدوال الداخلية ⇒ 42501';
END $$;

-- ── 19: لا استنتاج من فروق الرد ─────────────────────────────────────────────
DO $$
DECLARE a text; b text; p1 jsonb; p2 jsonb;
BEGIN
  -- سجل غير موجود مقابل سجل موجود بلا صلاحية: نفس الخطأ حرفيًا
  a := t.errfull('00000000-0000-4000-8000-0000000000a7', format('public.relay_get(%L::uuid)', gen_random_uuid()));
  b := t.errfull('00000000-0000-4000-8000-0000000000a7', format('public.relay_get(%L::uuid)', (SELECT v FROM t.saved WHERE k = 'R1')));
  PERFORM t.ok(a = b AND a LIKE 'P0002|%', '19a get: ' || a || ' vs ' || b);
  a := t.errfull('00000000-0000-4000-8000-0000000000a7', format('public.relay_events_for(%L::uuid)', gen_random_uuid()));
  b := t.errfull('00000000-0000-4000-8000-0000000000a7', format('public.relay_events_for(%L::uuid)', (SELECT v FROM t.saved WHERE k = 'R1')));
  PERFORM t.ok(a = b, '19b events');
  -- رسالة غير موجودة مقابل رسالة موجودة بلا صلاحية: نفس الخطأ
  a := t.errfull('00000000-0000-4000-8000-0000000000a6', format('public.relay_create(%L::jsonb)',
         t.req('I1', array[gen_random_uuid()])));
  b := t.errfull('00000000-0000-4000-8000-0000000000a6', format('public.relay_create(%L::jsonb)',
         t.req('I1', array['3e550000-0000-4000-8000-0000000000a1']::uuid[])));
  PERFORM t.ok(a = b AND a LIKE 'P0002|%', '19c attach: ' || a || ' vs ' || b);
  -- find_by_source: متتبَّعة بلا صلاحية = غير متتبَّعة = غير موجودة ⇒ []
  PERFORM t.ok(t.call('00000000-0000-4000-8000-0000000000a6', format('public.relay_find_by_source(%L::jsonb)',
                 jsonb_build_object('type', 'mad3oom_message', 'internal', jsonb_build_object('chat_message_id', gen_random_uuid())))) = '[]'::jsonb
               AND t.call('00000000-0000-4000-8000-0000000000a6', format('public.relay_find_by_source(%L::jsonb)',
                 '{"type":"mad3oom_message","internal":{"chat_message_id":"3e550000-0000-4000-8000-0000000000a4"}}')) = '[]'::jsonb, '19d find');
  -- placeholder بلا وصول = placeholder محادثة محذوفة (نفس المفاتيح والقيم إلا المعرّفات)
  p1 := t.get('00000000-0000-4000-8000-0000000000a6', (SELECT v::uuid FROM t.saved WHERE k = 'R1')) -> 'sources' -> 0;
  p2 := t.get('00000000-0000-4000-8000-0000000000a5', (SELECT v::uuid FROM t.saved WHERE k = 'R4')) -> 'sources' -> 0;
  PERFORM t.ok((p1 - 'id' - 'captured_at' - 'position') = (p2 - 'id' - 'captured_at' - 'position'), '19e placeholders: ' || p1::text || ' vs ' || p2::text);
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS 19: نفس SQLSTATE/الرسالة/التفاصيل لسجل غير موجود وسجل محجوب ولرسالة غير موجودة ورسالة غير مسموحة؛ find_by_source ⇒ [] في الحالات الثلاث؛ placeholder عدم الوصول = placeholder المحادثة المحذوفة';
END $$;

-- ── 20: الصلاحيات المباشرة ──────────────────────────────────────────────────
DO $$
DECLARE tb text; c text;
BEGIN
  FOREACH tb IN ARRAY array['relay_workspaces', 'relay_records', 'relay_sources', 'relay_source_snapshots', 'relay_events'] LOOP
    c := t.err('00000000-0000-4000-8000-0000000000ea', format('(select count(*) from public.%I)', tb));
    PERFORM t.ok(c = '42501', '20 select ' || tb || ' ' || c);
    PERFORM t.ok(t.err_stmt('00000000-0000-4000-8000-0000000000ea', format('delete from public.%I', tb)) = '42501', '20 delete ' || tb);
    PERFORM t.ok(t.err_stmt('00000000-0000-4000-8000-0000000000ea', format('insert into public.%I default values', tb)) = '42501', '20 insert ' || tb);
    PERFORM t.ok(t.err_anon(format('select count(*) from public.%I', tb)) = '42501', '20 anon ' || tb);
    PERFORM t.ok(NOT has_table_privilege('service_role', 'public.' || tb, 'SELECT')
                 AND NOT has_table_privilege('service_role', 'public.' || tb, 'INSERT'), '20 service_role ' || tb);
  END LOOP;
  -- رغم الصلاحيات الافتراضية: لا دالة Relay لـ anon/service_role، وauthenticated للـRPC العامة فقط
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                            WHERE n.nspname = 'public' AND (p.proname LIKE 'relay\_%' OR p.proname LIKE '\_relay\_%')
                              AND (has_function_privilege('service_role', p.oid, 'EXECUTE')
                                   OR has_function_privilege('anon', p.oid, 'EXECUTE'))), '20 functions service_role/anon');
  PERFORM t.ok((SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND (p.proname LIKE 'relay\_%' OR p.proname LIKE '\_relay\_%')
                   AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) = 11, '20 exactly 11 public RPCs');
  PERFORM t.ok(NOT has_sequence_privilege('service_role', 'public.relay_events_id_seq', 'USAGE'), '20 sequence');
  PERFORM t.ok(t.err_stmt('00000000-0000-4000-8000-0000000000ea', 'update public.relay_source_snapshots set redacted_at = null') = '42501', '20 update');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000ea', 'public.relay_retention_sweep()') = '42501', '20 sweep');
  PERFORM t.ok(t.err_anon('select public.relay_get(gen_random_uuid())') = '42501', '20 anon rpc');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename LIKE 'relay\_%' AND permissive = 'PERMISSIVE'), '20 no permissive policy');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS 20: authenticated (حتى المشرف) وanon ⇒ 42501 على SELECT/INSERT/UPDATE/DELETE لكل جداول relay؛ service_role بلا صلاحيات على الجداول والدوال رغم الصلاحيات الافتراضية؛ 11 RPC فقط لـ authenticated؛ الكنس غير قابل للاستدعاء؛ لا سياسة سماح';
END $$;

-- ── M9 + إسناد ──────────────────────────────────────────────────────────────
DO $$
DECLARE rid uuid; r jsonb; c text;
BEGIN
  -- EA ينشئ سجلًا مالكه S1؛ S1 يعيد الإسناد لـ S2 ⇒ S1 يفقد الوصول
  rid := t.mk('00000000-0000-4000-8000-0000000000ea', 'M9', '{}', jsonb_build_object('owner_id', '00000000-0000-4000-8000-0000000000a5'));
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_get(%L::uuid)', rid)) = 'ok', 'M9 owner sees');
  r := t.call('00000000-0000-4000-8000-0000000000a5', format('public.relay_assign(%L::uuid, %L::uuid, null, %s)', rid, '00000000-0000-4000-8000-0000000000a6', t.ver(rid)));
  PERFORM t.ok(r ->> 'access' = 'lost', 'M9 assign result');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_get(%L::uuid)', rid)) = 'P0002', 'M9 previous owner loses');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000ea', format('public.relay_get(%L::uuid)', rid)) = 'ok', 'M9 creator keeps');
  -- غير مالك وغير مشرف لا يعيد الإسناد (S2 الآن المالك؛ AD لا يرى أصلًا)
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000ad', format('public.relay_assign(%L::uuid, %L::uuid, null, %s)', rid, '00000000-0000-4000-8000-0000000000ad', t.ver(rid))) = 'P0002', 'M9 AD');
  -- مستهدف غير مؤهل: عميل، محظور، غير موجود ⇒ 22023
  FOREACH c IN ARRAY array['00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000b0', gen_random_uuid()::text] LOOP
    PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000ea', format('public.relay_assign(%L::uuid, %L::uuid, null, %s)', rid, c, t.ver(rid))) = '22023', 'eligibility ' || c);
  END LOOP;
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_create(%L::jsonb)',
                 t.req('elig', '{}', jsonb_build_object('owner_id', '00000000-0000-4000-8000-0000000000c1')))) = '22023', 'eligibility create');
  -- أخذ سجل بلا مالك لنفسك (المنشئ)
  rid := t.mk('00000000-0000-4000-8000-0000000000a6', 'CLAIM', '{}');
  PERFORM t.ok((SELECT owner_id IS NULL FROM public.relay_records WHERE id = rid), 'claim null owner');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a6', format('public.relay_assign(%L::uuid, %L::uuid, null, %s)', rid, '00000000-0000-4000-8000-0000000000a6', t.ver(rid))) = 'ok', 'claim self');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS M9: المالك السابق يفقد الوصول بعد إعادة الإسناد والمنشئ يحتفظ؛ عميل/محظور/غير موجود كمستهدف ⇒ 22023؛ أخذ سجل بلا مالك لنفسك مسموح';
END $$;

-- ── التكرار الآمن والنسخ والانتقالات ────────────────────────────────────────
DO $$
DECLARE rid uuid; r jsonb; c text; vv int;
BEGIN
  r := t.call('00000000-0000-4000-8000-0000000000a5', format('public.relay_create(%L::jsonb)', t.req('R1',
         array['3e550000-0000-4000-8000-0000000000a1', '3e550000-0000-4000-8000-0000000000a2']::uuid[],
         jsonb_build_object('owner_id', '00000000-0000-4000-8000-0000000000a6'))));
  PERFORM t.ok((r ->> 'replayed')::boolean AND r -> 'record' ->> 'id' = (SELECT v FROM t.saved WHERE k = 'R1')
               AND (SELECT count(*) FROM public.relay_records WHERE idempotency_key = md5('R1')::uuid) = 1, 'IDEM replay');
  c := t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_create(%L::jsonb)', t.req('R1', '{}')));
  PERFORM t.ok(c = '23505', 'IDEM conflict ' || c);
  -- نفس المفتاح من مستخدم آخر = سجل جديد (المفتاح لكل منشئ)
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000ad', format('public.relay_create(%L::jsonb)', t.req('R1', '{}'))) = 'ok', 'IDEM per user');

  rid := t.mk('00000000-0000-4000-8000-0000000000a5', 'TR', '{}', jsonb_build_object('owner_id', '00000000-0000-4000-8000-0000000000a5'));
  vv := t.ver(rid);
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_update(%L::uuid, %L::jsonb, %s)', rid, '{"priority":1}', vv + 5)) = '40001', 'VER conflict');
  PERFORM t.ok(t.ver(rid) = vv, 'VER unchanged');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_update(%L::uuid, %L::jsonb, %s)', rid, '{"owner_id":"x"}', vv)) = '22023', 'UPD unknown field');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_update(%L::uuid, %L::jsonb, %s)', rid, '{"due":null}', vv)) = '22023', 'UPD follow_up needs due');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_update(%L::uuid, %L::jsonb, %s)', rid, '{"title":"NEWTITLEMARK"}', vv)) = 'ok', 'UPD title');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.relay_events WHERE payload::text LIKE '%NEWTITLEMARK%')
               AND EXISTS (SELECT 1 FROM public.relay_events WHERE record_id = rid AND kind = 'updated'
                              AND payload -> 'fields' ->> 'title' = public._relay_hash('NEWTITLEMARK')), 'M5 update digest');
  vv := t.ver(rid);
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_transition(%L::uuid, ''waiting'', ''{}'', %s)', rid, vv)) = '22023', 'TR waiting needs note');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_transition(%L::uuid, ''ready_for_handover'', ''{}'', %s)', rid, vv)) = '0A000', 'TR handover');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_transition(%L::uuid, ''resolved'', ''{}'', %s)', rid, vv)) = '22023', 'TR resolve needs note');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_transition(%L::uuid, ''open'', ''{"reason":"x"}'', %s)', rid, vv)) = '55000', 'TR open->open');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_transition(%L::uuid, ''bogus'', ''{}'', %s)', rid, vv)) = '55000', 'TR bogus');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000ea', format('public.relay_transition(%L::uuid, ''in_progress'', ''{}'', %s)', rid, vv)) = 'ok', 'TR supervisor');
  vv := t.ver(rid);
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_transition(%L::uuid, ''resolved'', ''{"resolution_note":"تم"}'', %s)', rid, vv)) = 'ok', 'TR resolve');
  PERFORM t.ok((SELECT closed_at IS NOT NULL AND resolved_by = '00000000-0000-4000-8000-0000000000a5' FROM public.relay_records WHERE id = rid), 'TR closed_at');
  vv := t.ver(rid);
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_update(%L::uuid, ''{"priority":1}'', %s)', rid, vv)) = '55000', 'UPD closed');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_transition(%L::uuid, ''open'', ''{}'', %s)', rid, vv)) = '22023', 'TR reopen needs reason');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_transition(%L::uuid, ''open'', ''{"reason":"رجع"}'', %s)', rid, vv)) = 'ok', 'TR reopen');
  PERFORM t.ok((SELECT closed_at IS NULL AND resolution_note IS NULL FROM public.relay_records WHERE id = rid), 'TR reopen clears');
  -- غير مالك وغير مشرف (المنشئ بعد إعادة الإسناد مثلًا) لا ينقل الحالة
  rid := t.mk('00000000-0000-4000-8000-0000000000a5', 'TR2', '{}', jsonb_build_object('owner_id', '00000000-0000-4000-8000-0000000000a6'));
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_transition(%L::uuid, ''in_progress'', ''{}'', %s)', rid, t.ver(rid))) = '42501', 'TR creator not owner');
  -- issue بلا problem ولا summary ⇒ 22023؛ due بإزاحة صريحة ⇒ 22023؛ due في الماضي ⇒ 22023
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_create(%L::jsonb)',
                 jsonb_build_object('contract_version', 1, 'idempotency_key', gen_random_uuid(), 'kind', 'issue', 'title', 'x'))) = '22023', 'issue problem');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_create(%L::jsonb)',
                 t.req('dz', '{}', '{"due":{"at":"2030-01-01T10:00:00Z","tz":"Africa/Cairo"}}'))) = '22023', 'due Z');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_create(%L::jsonb)',
                 t.req('dp', '{}', '{"due":{"at":"2020-01-01T10:00:00","tz":"Africa/Cairo"}}'))) = '22023', 'due past');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_create(%L::jsonb)',
                 t.req('dt', '{}', '{"due":{"at":"2026-12-01T10:00:00","tz":"Mars/Base"}}'))) = '22023', 'due tz');
  -- خلط الأنواع في jsonb ⇒ 22023 (لا 22P02 خام، ولا تحويل صامت لنص)
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_create(%L::jsonb)',
                 t.req('ty1', '{}', '{"due":{"at":"2026-12-01 10:00 America/New_York","tz":"Africa/Cairo"}}'))) = '22023', 'due named zone');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_create(%L::jsonb)',
                 t.req('ty2', '{}', '{"sensitive_ack":"maybe"}'))) = '22023', 'ack type');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_create(%L::jsonb)',
                 t.req('ty3', '{}', '{"title":12345}'))) = '22023', 'title type');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_create(%L::jsonb)',
                 t.req('ty4', '{}', '{"summary":{"x":[1,2]}}'))) = '22023', 'summary type');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_create(%L::jsonb)',
                 t.req('ty5', '{}', '{"priority":"high"}'))) = '22023', 'priority type');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_create(%L::jsonb)',
                 t.req('ty6', '{}', '{"due":"tomorrow"}'))) = '22023', 'due type');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_create(%L::jsonb)', '[]')) = '22023', 'request array');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_create(%L::jsonb)',
                 t.req('ty7', '{}', jsonb_build_object('sources', jsonb_build_array('x'))))) = '22023', 'source type');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_list(%L::jsonb)', '{"limit":"many"}')) = '22023', 'list filter type');
  -- مؤشر الصفحات (updated_at, id)
  PERFORM t.ok(jsonb_array_length(t.call('00000000-0000-4000-8000-0000000000a5', 'public.relay_list(''{"limit":2}''::jsonb)')) = 2, 'list limit');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS IDEM/VER/TR: نفس المفتاح ⇒ replayed بلا تكرار، مفتاح بطلب مختلف ⇒ 23505؛ نسخة قديمة ⇒ 40001 بلا كتابة؛ انتقالات غير مسموحة ⇒ 55000؛ resolve/cancel/reopen/waiting تتطلب نصوصها؛ due مُتحقَّق منه؛ خلط الأنواع في jsonb ⇒ 22023';
END $$;

-- ── 16 (جزء): التوقيت الصيفي في تحويل الموعد ────────────────────────────────
DO $$
DECLARE c text;
BEGIN
  BEGIN
    PERFORM public._relay_local_to_utc('2026-04-24 00:30', 'Africa/Cairo');
    c := 'ok';
  EXCEPTION WHEN others THEN c := sqlstate;
  END;
  PERFORM t.ok(c = '22023', '16 DST gap ' || c);
  PERFORM t.ok(public._relay_local_to_utc('2026-10-29 23:30', 'Africa/Cairo') = '2026-10-29 20:30+00', '16 DST overlap earlier');
  PERFORM t.ok(public._relay_local_to_utc('2026-12-01 10:00', 'Africa/Cairo') = '2026-12-01 08:00+00', '16 winter');
  PERFORM set_config('TimeZone', 'Pacific/Kiritimati', true);
  PERFORM t.ok(public._relay_local_to_utc('2026-12-01 10:00', 'Africa/Cairo') = '2026-12-01 08:00+00', '16 session tz independent');
  RAISE NOTICE 'PASS 16 (موعد): 2026-04-24 00:30 القاهرة (فجوة) ⇒ 22023؛ 2026-10-29 23:30 (التباس) ⇒ 20:30Z (الأبكر)؛ مستقل عن TimeZone الجلسة';
END $$;

-- ── 9–16 + M6/M7: الاحتفاظ ──────────────────────────────────────────────────
-- سجلات من S1 على MA4: نشط قديم، مغلق 364 يومًا، مغلق 365 يومًا + دقيقة، ومُلغى قديم
DO $$
DECLARE k text; rid uuid;
BEGIN
  FOREACH k IN ARRAY array['RET_ACTIVE', 'RET_364', 'RET_EXP', 'RET_EXP2', 'RET_REOPEN', 'RET_FAIL', 'RET_EDGE_IN', 'RET_EDGE_OUT'] LOOP
    rid := t.mk('00000000-0000-4000-8000-0000000000a5', k, array['3e550000-0000-4000-8000-0000000000a4', '3e550000-0000-4000-8000-0000000000a1']::uuid[],
                jsonb_build_object('owner_id', '00000000-0000-4000-8000-0000000000a5'));
    INSERT INTO t.saved VALUES (k, rid::text);
    IF k <> 'RET_ACTIVE' THEN
      PERFORM t.call('00000000-0000-4000-8000-0000000000a5',
                     format('public.relay_transition(%L::uuid, ''resolved'', ''{"resolution_note":"تم"}'', %s)', rid, t.ver(rid)));
    END IF;
  END LOOP;
  PERFORM t.act(NULL);
END $$;
-- إرجاع الساعة (كمالك القاعدة: لا مسار لهذا عبر الـRPC)
UPDATE public.relay_records SET created_at = now() - interval '900 days', updated_at = now() - interval '900 days'
 WHERE id = (SELECT v::uuid FROM t.saved WHERE k = 'RET_ACTIVE');
UPDATE public.relay_records SET created_at = now() - interval '900 days', closed_at = now() - interval '364 days', resolved_at = now() - interval '364 days'
 WHERE id = (SELECT v::uuid FROM t.saved WHERE k = 'RET_364');
UPDATE public.relay_records SET closed_at = now() - interval '8760 hours' - interval '1 minute', resolved_at = now() - interval '400 days'
 WHERE id IN (SELECT v::uuid FROM t.saved WHERE k IN ('RET_EXP', 'RET_EXP2', 'RET_REOPEN', 'RET_FAIL'));
UPDATE public.relay_records SET closed_at = now() - interval '8760 hours' + interval '1 second'
 WHERE id = (SELECT v::uuid FROM t.saved WHERE k = 'RET_EDGE_IN');
UPDATE public.relay_records SET closed_at = now() - interval '8760 hours'
 WHERE id = (SELECT v::uuid FROM t.saved WHERE k = 'RET_EDGE_OUT');

DO $$
DECLARE g jsonb; tz text;
BEGIN
  -- 9: نشط عمره 900 يوم ⇒ المقتطف ظاهر
  g := t.get('00000000-0000-4000-8000-0000000000a5', (SELECT v::uuid FROM t.saved WHERE k = 'RET_ACTIVE'));
  PERFORM t.ok(g -> 'sources' -> 0 ->> 'excerpt' LIKE 'MARKERA4%', '9 active old');
  -- 10: مغلق 364 يومًا ⇒ ظاهر
  g := t.get('00000000-0000-4000-8000-0000000000a5', (SELECT v::uuid FROM t.saved WHERE k = 'RET_364'));
  PERFORM t.ok(g -> 'sources' -> 0 ->> 'excerpt' LIKE 'MARKERA4%', '10 closed 364d');
  -- 15/M6: منتهٍ ⇒ القراءة تخفي قبل الكنس، والنص ما زال في التخزين
  g := t.get('00000000-0000-4000-8000-0000000000a5', (SELECT v::uuid FROM t.saved WHERE k = 'RET_EXP'));
  PERFORM t.ok((g -> 'sources' -> 0 ->> 'retention_expired')::boolean AND g -> 'sources' -> 0 -> 'excerpt' = 'null'::jsonb
               AND NOT (g::text LIKE '%MARKERA%') AND NOT (g -> 'sources' -> 0 ? 'sender_label'), '15 mask ' || g::text);
  PERFORM t.ok((SELECT count(*) FROM public.relay_source_snapshots WHERE record_id = (SELECT v::uuid FROM t.saved WHERE k = 'RET_EXP')
                  AND excerpt IS NOT NULL) = 2, '15 still stored before sweep');
  -- بلا صلاحية المحادثة: لا retention_expired (لا استنتاج)
  g := t.get('00000000-0000-4000-8000-0000000000ea', (SELECT v::uuid FROM t.saved WHERE k = 'RET_EXP'));
  PERFORM t.ok((g -> 'sources' -> 0 ->> 'retention_expired')::boolean, '15 supervisor mask');
  -- 16: الحدود — 8760 ساعة إلا ثانية ⇒ ظاهر؛ 8760 ساعة بالضبط ⇒ منتهٍ؛ نفس النتيجة بأي TimeZone
  FOREACH tz IN ARRAY array['UTC', 'Africa/Cairo', 'America/New_York', 'Pacific/Chatham', 'Asia/Kolkata'] LOOP
    PERFORM set_config('TimeZone', tz, true);
    g := t.get('00000000-0000-4000-8000-0000000000a5', (SELECT v::uuid FROM t.saved WHERE k = 'RET_EDGE_IN'));
    PERFORM t.ok(g -> 'sources' -> 0 ->> 'excerpt' LIKE 'MARKERA4%', '16 edge in ' || tz);
    g := t.get('00000000-0000-4000-8000-0000000000a5', (SELECT v::uuid FROM t.saved WHERE k = 'RET_EDGE_OUT'));
    PERFORM t.ok((g -> 'sources' -> 0 ->> 'retention_expired')::boolean, '16 edge out ' || tz);
  END LOOP;
  -- الحساب بالساعات لا بالأيام التقويمية: مستقل عن منطقة الجلسة
  PERFORM t.ok(public._relay_retention_expired(now() - interval '8760 hours', 365)
               AND NOT public._relay_retention_expired(now() - interval '8760 hours' + interval '1 second', 365)
               AND NOT public._relay_retention_expired(NULL, 365), '16 function');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS 9/10/15/16/M6: نشط عمره 900 يوم ظاهر؛ مغلق 364 يومًا ظاهر؛ مغلق 8760h+1m مخفي في القراءة (retention_expired) والنص ما زال مخزنًا؛ الحد 8760h بالضبط منتهٍ و-1s ظاهر في 5 مناطق زمنية';
END $$;

-- 22c: إعادة فتح متزامنة مع الكنس — الكنس يتخطى السجل المقفول (skip locked)
SELECT t.dblink_connect('other', format('dbname=%s port=%s host=%s user=postgres', current_database(),
         current_setting('port'), split_part(current_setting('unix_socket_directories'), ',', 1)));
SELECT t.dblink_exec('other', 'begin');
SELECT t.dblink_exec('other', format('update public.relay_records set updated_at = updated_at where id = %L', (SELECT v FROM t.saved WHERE k = 'RET_REOPEN')));

-- بصمات قبل الكنس (14)
INSERT INTO t.saved SELECT 'sweep_chat', t.chat_digest();
INSERT INTO t.saved SELECT 'sweep_records', md5(string_agg(md5(r::text), ',' ORDER BY r.id)) FROM public.relay_records r;
INSERT INTO t.saved SELECT 'sweep_sources', md5(string_agg(md5(s::text), ',' ORDER BY s.id)) FROM public.relay_sources s;
INSERT INTO t.saved SELECT 'sweep_other_snaps', md5(string_agg(md5(ss::text), ',' ORDER BY ss.id))
  FROM public.relay_source_snapshots ss
 WHERE ss.record_id NOT IN (SELECT v::uuid FROM t.saved WHERE k IN ('RET_EXP', 'RET_EXP2', 'RET_FAIL', 'RET_EDGE_OUT', 'RET_REOPEN'));
INSERT INTO t.saved SELECT 'sweep_snap_count', count(*)::text FROM public.relay_source_snapshots;

-- 23: فشل صف واحد لا يوقف الدفعة (حقن فشل على لقطات RET_FAIL)
CREATE FUNCTION t.inject_fail() RETURNS trigger LANGUAGE plpgsql AS $$
begin
  if new.record_id = (select v::uuid from t.saved where k = 'RET_FAIL') and new.redacted_at is not null then
    raise exception 'injected failure';
  end if;
  return new;
end $$;
CREATE TRIGGER zz_inject_fail BEFORE UPDATE ON public.relay_source_snapshots FOR EACH ROW EXECUTE FUNCTION t.inject_fail();

DO $$
DECLARE n int; e record;
BEGIN
  PERFORM set_config('lock_timeout', '3s', true);
  n := public.relay_retention_sweep();
  -- RET_EXP (2) + RET_EXP2 (2) + RET_EDGE_OUT (2) + سجل الشركة المغلق منذ 10 أيام لا؛ RET_REOPEN مقفول ⇒ متخطى؛ RET_FAIL يفشل
  PERFORM t.ok(n = 6, '11/12 sweep count ' || n);
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.relay_source_snapshots
                            WHERE record_id IN (SELECT v::uuid FROM t.saved WHERE k IN ('RET_EXP', 'RET_EXP2', 'RET_EDGE_OUT'))
                              AND (excerpt IS NOT NULL OR sender_label IS NOT NULL OR redacted_at IS NULL
                                   OR redaction_reason <> 'retention' OR redacted_by IS NOT NULL)), '12 storage cleared');
  PERFORM t.ok((SELECT bool_and(excerpt_sha256 ~ '^[0-9a-f]{64}$') FROM public.relay_source_snapshots
                 WHERE record_id = (SELECT v::uuid FROM t.saved WHERE k = 'RET_EXP')), '12 hash kept');
  PERFORM t.ok((SELECT count(*) FROM public.relay_events WHERE kind = 'source_redacted' AND client = 'cron' AND actor_id IS NULL
                   AND payload ->> 'reason' = 'retention') = 6, '12 events');
  -- 23: RET_FAIL ما زال مخزنًا لكن مخفي في القراءة، وحدث فشل بلا محتوى
  PERFORM t.ok((SELECT count(*) FROM public.relay_source_snapshots WHERE record_id = (SELECT v::uuid FROM t.saved WHERE k = 'RET_FAIL')
                  AND excerpt IS NOT NULL) = 2, '23 failed row untouched');
  PERFORM t.ok((SELECT count(*) FROM public.relay_events WHERE kind = 'retention_redaction_failed'
                  AND record_id = (SELECT v::uuid FROM t.saved WHERE k = 'RET_FAIL') AND payload ? 'sqlstate'
                  AND NOT (payload::text LIKE '%MARKER%')) = 2, '23 failure events');
  PERFORM t.ok((t.get('00000000-0000-4000-8000-0000000000a5', (SELECT v::uuid FROM t.saved WHERE k = 'RET_FAIL')) -> 'sources' -> 0 ->> 'retention_expired')::boolean,
               '23 failed row masked on read');
  -- 22c: RET_REOPEN متخطى (مقفول في الجلسة الأخرى)
  PERFORM t.ok((SELECT count(*) FROM public.relay_source_snapshots WHERE record_id = (SELECT v::uuid FROM t.saved WHERE k = 'RET_REOPEN')
                  AND redacted_at IS NULL) = 2, '22c skipped locked');
  -- 14: لا مساس بغير المستحق
  PERFORM t.ok(t.chat_digest() = (SELECT v FROM t.saved WHERE k = 'sweep_chat'), '14 chat');
  PERFORM t.ok((SELECT md5(string_agg(md5(r::text), ',' ORDER BY r.id)) FROM public.relay_records r) = (SELECT v FROM t.saved WHERE k = 'sweep_records'), '14 records');
  PERFORM t.ok((SELECT md5(string_agg(md5(s::text), ',' ORDER BY s.id)) FROM public.relay_sources s) = (SELECT v FROM t.saved WHERE k = 'sweep_sources'), '14 sources');
  PERFORM t.ok((SELECT md5(string_agg(md5(ss::text), ',' ORDER BY ss.id)) FROM public.relay_source_snapshots ss
                  WHERE ss.record_id NOT IN (SELECT v::uuid FROM t.saved WHERE k IN ('RET_EXP', 'RET_EXP2', 'RET_FAIL', 'RET_EDGE_OUT', 'RET_REOPEN')))
               = (SELECT v FROM t.saved WHERE k = 'sweep_other_snaps'), '14 other snapshots (incl. active 900d, closed 364d, edge-in, company)');
  PERFORM t.ok((SELECT count(*)::text FROM public.relay_source_snapshots) = (SELECT v FROM t.saved WHERE k = 'sweep_snap_count'), '14 no deletes');
  RAISE NOTICE 'PASS 11/12/14/23/M7: الكنس يمسح excerpt وsender_label فعليًا لـ 6 لقطات منتهية فقط (السبب retention، البصمة باقية، حدث cron لكل لقطة)؛ لا مساس بالنشطة/364 يومًا/الحد-1s/الشركة/الشات؛ لا حذف؛ فشل صف لا يوقف الباقي ويظل مخفيًا في القراءة';
END $$;

SELECT t.dblink_exec('other', 'commit');
DROP TRIGGER zz_inject_fail ON public.relay_source_snapshots;

DO $$
DECLARE n int; ev int;
BEGIN
  SELECT count(*) INTO ev FROM public.relay_events;
  n := public.relay_retention_sweep();   -- RET_FAIL و RET_REOPEN الآن
  PERFORM t.ok(n = 4, '23 retry ' || n);
  n := public.relay_retention_sweep();
  PERFORM t.ok(n = 0 AND (SELECT count(*) FROM public.relay_events) = ev + 4, '13 idempotent');
  -- 9 مرة أخرى بعد الكنس: النشط القديم ما زال سليمًا
  PERFORM t.ok((SELECT count(*) FROM public.relay_source_snapshots WHERE record_id = (SELECT v::uuid FROM t.saved WHERE k = 'RET_ACTIVE')
                  AND excerpt IS NOT NULL) = 2, '9 active after sweep');
  RAISE NOTICE 'PASS 13/23 (إعادة): التشغيل التالي يكمل الصف الفاشل والمتخطى (4)، والتشغيل الثالث = 0 بلا أحداث جديدة';
END $$;

-- ── إعادة الفتح/الإغلاق وC5 ─────────────────────────────────────────────────
DO $$
DECLARE rid uuid; g jsonb;
BEGIN
  -- إعادة فتح بعد الحجب ⇒ يظل محجوبًا
  rid := (SELECT v::uuid FROM t.saved WHERE k = 'RET_EXP');
  PERFORM t.call('00000000-0000-4000-8000-0000000000a5', format('public.relay_transition(%L::uuid, ''open'', ''{"reason":"رجع"}'', %s)', rid, t.ver(rid)));
  g := t.get('00000000-0000-4000-8000-0000000000a5', rid);
  PERFORM t.ok(g -> 'sources' -> 0 -> 'redacted' ->> 'reason' = 'retention' AND g -> 'sources' -> 0 -> 'excerpt' = 'null'::jsonb, 'C5 reopen after redaction');
  -- إعادة فتح قبل 365 ⇒ الساعة تتوقف؛ إغلاق جديد يبدأ ساعة جديدة
  rid := (SELECT v::uuid FROM t.saved WHERE k = 'RET_364');
  PERFORM t.call('00000000-0000-4000-8000-0000000000a5', format('public.relay_transition(%L::uuid, ''open'', ''{"reason":"رجع"}'', %s)', rid, t.ver(rid)));
  PERFORM t.ok((SELECT closed_at IS NULL FROM public.relay_records WHERE id = rid), 'C5 reopen clears clock');
  PERFORM t.call('00000000-0000-4000-8000-0000000000a5', format('public.relay_transition(%L::uuid, ''cancelled'', ''{"cancel_reason":"خلاص"}'', %s)', rid, t.ver(rid)));
  PERFORM t.ok((SELECT closed_at > now() - interval '1 minute' FROM public.relay_records WHERE id = rid), 'C5 re-close new clock');
  g := t.get('00000000-0000-4000-8000-0000000000a5', rid);
  PERFORM t.ok(g -> 'sources' -> 0 ->> 'excerpt' LIKE 'MARKERA4%', 'C5 visible after re-close');
  -- منتهٍ لم يُكنس بعد ثم أعيد فتحه ⇒ يُحجب فورًا (لا رجوع لمحتوى منتهي)
  rid := t.mk('00000000-0000-4000-8000-0000000000a5', 'RET_LATE', array['3e550000-0000-4000-8000-0000000000a4']::uuid[],
              jsonb_build_object('owner_id', '00000000-0000-4000-8000-0000000000a5'));
  PERFORM t.call('00000000-0000-4000-8000-0000000000a5', format('public.relay_transition(%L::uuid, ''resolved'', ''{"resolution_note":"تم"}'', %s)', rid, t.ver(rid)));
  UPDATE public.relay_records SET closed_at = now() - interval '9000 hours' WHERE id = rid;
  PERFORM t.call('00000000-0000-4000-8000-0000000000a5', format('public.relay_transition(%L::uuid, ''open'', ''{"reason":"رجع"}'', %s)', rid, t.ver(rid)));
  PERFORM t.ok((SELECT excerpt IS NULL AND redaction_reason = 'retention' FROM public.relay_source_snapshots WHERE record_id = rid), 'C5 late reopen redacts');
  g := t.get('00000000-0000-4000-8000-0000000000a5', rid);
  PERFORM t.ok(NOT (g::text LIKE '%MARKERA4%'), 'C5 late reopen read');
  -- snapshot_retention_days ثابت 365
  BEGIN
    UPDATE public.relay_workspaces SET snapshot_retention_days = 30;
    RAISE EXCEPTION 'FAIL C5 retention days changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS C5: إعادة فتح بعد الحجب ⇒ يظل محجوبًا؛ إعادة فتح قبل الموعد توقف الساعة والإغلاق التالي يبدأ ساعة جديدة؛ إعادة فتح منتهٍ لم يُكنس ⇒ حجب فوري؛ snapshot_retention_days ≠ 365 مرفوض';
END $$;

-- ── 17 + M10: الحجب نهائي ───────────────────────────────────────────────────
DO $$
DECLARE rid uuid := (SELECT v::uuid FROM t.saved WHERE k = 'R1'); sid uuid; snapid uuid; g jsonb; c text; ev int; r jsonb;
BEGIN
  SELECT s.id, ss.id INTO sid, snapid FROM public.relay_sources s JOIN public.relay_source_snapshots ss ON ss.source_id = s.id
   WHERE s.record_id = rid AND s.chat_message_id = '3e550000-0000-4000-8000-0000000000a1';
  -- غير مالك وغير منشئ وغير مشرف (S3 لا يرى) ⇒ P0002؛ سبب غير مسموح ⇒ 22023
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a7', format('public.relay_redact_source(%L::uuid)', sid)) = 'P0002', '17 S3');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', format('public.relay_redact_source(%L::uuid, ''retention'')', sid)) = '22023', '17 reason');
  -- المالك S2 (بلا وصول للمحادثة) يقدر يحجب: الحجب يقلل الانكشاف
  r := t.call('00000000-0000-4000-8000-0000000000a6', format('public.relay_redact_source(%L::uuid)', sid));
  PERFORM t.ok(NOT (r::text LIKE '%MARKERA1%'), '17 redact response');
  PERFORM t.ok((SELECT excerpt IS NULL AND sender_label IS NULL AND redaction_reason = 'manual'
                       AND redacted_by = '00000000-0000-4000-8000-0000000000a6' FROM public.relay_source_snapshots WHERE id = snapid), '17 stored');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.relay_events WHERE record_id = rid AND kind = 'source_redacted'
                         AND actor_id = '00000000-0000-4000-8000-0000000000a6' AND payload = jsonb_build_object('source_id', sid, 'reason', 'manual')), 'M10 event');
  g := t.get('00000000-0000-4000-8000-0000000000a5', rid);
  PERFORM t.ok(g -> 'sources' -> 0 -> 'redacted' ->> 'reason' = 'manual' AND NOT (g::text LIKE '%MARKERA1%'), '17 read');
  g := t.get('00000000-0000-4000-8000-0000000000a6', rid);
  PERFORM t.ok(NOT (g -> 'sources' -> 0 ? 'redacted'), '17 redaction details only after access check');
  -- تكرار ⇒ بلا حدث جديد
  SELECT count(*) INTO ev FROM public.relay_events;
  PERFORM t.call('00000000-0000-4000-8000-0000000000a5', format('public.relay_redact_source(%L::uuid)', sid));
  PERFORM t.ok((SELECT count(*) FROM public.relay_events) = ev, '17 idempotent');
  -- إعادة إرفاق نفس الرسالة ⇒ لا التقاط جديد
  r := t.call('00000000-0000-4000-8000-0000000000a5', format('public.relay_attach_sources(%L::uuid, %L::jsonb, %s)', rid,
         '[{"type":"mad3oom_message","internal":{"chat_message_id":"3e550000-0000-4000-8000-0000000000a1"}}]', t.ver(rid)));
  PERFORM t.ok((r ->> 'added')::int = 0 AND (SELECT excerpt IS NULL FROM public.relay_source_snapshots WHERE id = snapid), '17 reattach');
  -- حتى مالك القاعدة: لا رجوع ولا حذف ولا truncate
  FOREACH c IN ARRAY array[
    format('update public.relay_source_snapshots set excerpt = ''RESTORED'' where id = %L', snapid),
    format('update public.relay_source_snapshots set redacted_at = null, redaction_reason = null, excerpt = ''RESTORED'' where id = %L', snapid),
    format('update public.relay_source_snapshots set source_deleted_at = now() where id = %L', snapid),
    format('delete from public.relay_source_snapshots where id = %L', snapid),
    'truncate public.relay_source_snapshots',
    'update public.relay_events set payload = ''{}''',
    'delete from public.relay_events',
    'truncate public.relay_events',
    format('delete from public.relay_records where id = %L', rid),
    format('delete from public.relay_sources where id = %L', sid),
    format('update public.relay_sources set chat_message_id = ''3e550000-0000-4000-8000-0000000000b1'' where id = %L', sid)] LOOP
    BEGIN
      EXECUTE c;
      RAISE EXCEPTION 'FAIL 17 superuser path allowed: %', c;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;
  -- لقطة غير محجوبة: لا تعديل للمحتوى بلا حجب
  BEGIN
    UPDATE public.relay_source_snapshots SET excerpt = 'CHANGED' WHERE record_id = (SELECT v::uuid FROM t.saved WHERE k = 'RET_ACTIVE');
    RAISE EXCEPTION 'FAIL 17 content edit allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- لا دالة Relay تكتب excerpt بقيمة غير null
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                            WHERE n.nspname = 'public' AND (p.proname LIKE 'relay\_%' OR p.proname LIKE '\_relay\_%')
                              AND p.prosrc ~* 'set\s+excerpt\s*=\s*[^n[:space:]]'), '17 no writer');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS 17/M10: الحجب اليدوي (حتى من مالك بلا وصول للمحادثة) يمسح النص والمرسل ويُسجَّل (فاعل، سبب)؛ تكراره بلا أثر؛ إعادة الإرفاق لا تعيد الالتقاط؛ مالك القاعدة لا يقدر يرجّع أو يحذف أو يفرّغ؛ لا دالة تكتب نصًا';
END $$;

-- ── M8: طلب حذف بيانات عميل ─────────────────────────────────────────────────
DO $$
DECLARE n int; c text; before_b int;
BEGIN
  SELECT count(*) INTO before_b FROM public.relay_source_snapshots WHERE origin_customer_id = '00000000-0000-4000-8000-0000000000c2' AND redacted_at IS NULL;
  -- لقطة من C2 (SB) يلتقطها S2
  PERFORM t.mk('00000000-0000-4000-8000-0000000000a6', 'M8B', array['3e550000-0000-4000-8000-0000000000b1']::uuid[]);
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', 'public.relay_redact_for_subject(''00000000-0000-4000-8000-0000000000c1''::uuid)') = '42501', 'M8 support');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000ad', 'public.relay_redact_for_subject(''00000000-0000-4000-8000-0000000000c1''::uuid)') = '42501', 'M8 admin');
  BEGIN
    PERFORM t.call_api('00000000-0000-4000-8000-0000000000ea', 'public.relay_redact_for_subject(''00000000-0000-4000-8000-0000000000c1''::uuid)');
    c := 'ok';
  EXCEPTION WHEN others THEN c := sqlstate;
  END;
  PERFORM t.ok(c = '42501', 'M8 via API ' || c);
  n := (t.call('00000000-0000-4000-8000-0000000000ea', 'public.relay_redact_for_subject(''00000000-0000-4000-8000-0000000000c1''::uuid)'))::int;
  PERFORM t.ok(n > 0 AND NOT EXISTS (SELECT 1 FROM public.relay_source_snapshots WHERE origin_customer_id = '00000000-0000-4000-8000-0000000000c1'
                                        AND redacted_at IS NULL), 'M8 all C1 redacted');
  PERFORM t.ok((SELECT count(*) FROM public.relay_source_snapshots WHERE origin_customer_id = '00000000-0000-4000-8000-0000000000c2'
                  AND redacted_at IS NULL) = before_b + 1 AND EXISTS (SELECT 1 FROM public.relay_source_snapshots WHERE excerpt LIKE 'MARKERB1%'), 'M8 C2 untouched');
  PERFORM t.ok((SELECT count(*) FROM public.relay_events WHERE kind = 'source_redacted' AND payload ->> 'reason' = 'data_subject_request'
                  AND actor_id = '00000000-0000-4000-8000-0000000000ea') = n, 'M8 events');
  -- لا إعادة التقاط لمحادثات عميل حُجب لطلب حذف (رسالة MA1 ما زالت موجودة في SA)
  c := t.errfull('00000000-0000-4000-8000-0000000000a5', format('public.relay_create(%L::jsonb)',
         t.req('M8RE', array['3e550000-0000-4000-8000-0000000000a1']::uuid[])));
  PERFORM t.ok(c LIKE '22023|%subject_redacted%' AND NOT (c LIKE '%MARKER%'), 'M8 recapture blocked: ' || c);
  -- سبب data_subject_request للمشرف وحده
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a6', format('public.relay_redact_source(%L::uuid, ''data_subject_request'')',
                 (SELECT s.id FROM public.relay_sources s JOIN public.relay_records r ON r.id = s.record_id
                   WHERE r.idempotency_key = md5('M8B')::uuid))) = '22023', 'M8 reason non-supervisor');
  -- غير المشرف يرى في السجل أن مقتطفًا حُجب، لا أن طلب حذف بيانات قُدِّم
  PERFORM t.ok(NOT (t.call('00000000-0000-4000-8000-0000000000a5', format('public.relay_events_for(%L::uuid, null, 200)', (SELECT v FROM t.saved WHERE k = 'R1')))::text
                    LIKE '%data_subject_request%')
               AND t.call('00000000-0000-4000-8000-0000000000a5', format('public.relay_events_for(%L::uuid, null, 200)', (SELECT v FROM t.saved WHERE k = 'R1')))::text LIKE '%not_shown%'
               AND t.call('00000000-0000-4000-8000-0000000000ea', format('public.relay_events_for(%L::uuid, null, 200)', (SELECT v FROM t.saved WHERE k = 'R1')))::text LIKE '%data_subject_request%', 'M8 reason visibility');
  -- يعمل حتى لو Relay مطفأ
  UPDATE public.relay_workspaces SET enabled = false WHERE kind = 'platform';
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000ea', 'public.relay_redact_for_subject(''00000000-0000-4000-8000-0000000000c1''::uuid)') = 'ok', 'M8 when disabled');
  PERFORM t.ok(public.relay_retention_sweep() >= 0, 'sweep when disabled');
  UPDATE public.relay_workspaces SET enabled = true WHERE kind = 'platform';
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS M8: الدعم/الأدمن العادي/المشرف عبر API ⇒ 42501؛ المشرف يحجب % لقطة لـ C1 فقط (C2 سليم) بحدث data_subject_request لكل لقطة؛ لا إعادة التقاط لمحادثات C1 بعدها (22023 subject_redacted)؛ السبب للمشرف وحده ومخفي (not_shown) عن غيره في الأحداث؛ يعمل والكنس يعمل حتى وRelay مطفأ', n;
END $$;

-- ── 22: التوازي (جلستان حقيقيتان عبر dblink) ────────────────────────────────
-- 22a: سحب الصلاحية في معاملة غير مثبتة ثم تثبيتها
DO $$
DECLARE rid uuid;
BEGIN
  rid := t.mk('00000000-0000-4000-8000-0000000000a6', 'CONC', array['3e550000-0000-4000-8000-0000000000b1']::uuid[],
              jsonb_build_object('owner_id', '00000000-0000-4000-8000-0000000000a6'));
  INSERT INTO t.saved VALUES ('CONC', rid::text);
  PERFORM t.act(NULL);
END $$;
SELECT t.dblink_exec('other', 'begin');
SELECT t.dblink_exec('other', 'update public.inbox_conversations set assignee_id = ''00000000-0000-4000-8000-0000000000a5'' where session_id = ''5e550000-0000-4000-8000-0000000000b1''');
DO $$
BEGIN
  PERFORM t.ok(t.get('00000000-0000-4000-8000-0000000000a6', (SELECT v::uuid FROM t.saved WHERE k = 'CONC')) -> 'sources' -> 0 ->> 'excerpt' LIKE 'MARKERB1%', '22a before commit (still authorized)');
  PERFORM t.act(NULL);
END $$;
SELECT t.dblink_exec('other', 'commit');
DO $$
BEGIN
  PERFORM t.ok(t.get('00000000-0000-4000-8000-0000000000a6', (SELECT v::uuid FROM t.saved WHERE k = 'CONC')) -> 'sources' -> 0 ->> 'excerpt_hidden' = 'no_conversation_access', '22a after commit hidden');
  PERFORM t.act(NULL);
END $$;
UPDATE public.inbox_conversations SET assignee_id = '00000000-0000-4000-8000-0000000000a6' WHERE session_id = '5e550000-0000-4000-8000-0000000000b1';
-- 22b: حجب متزامن
SELECT t.dblink_exec('other', 'begin');
SELECT t.dblink_exec('other', $q$set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a6'$q$);
SELECT t.dblink_exec('other', 'set local role authenticated');
SELECT length(x) > 0 FROM t.dblink('other', format('select public.relay_redact_source(%L::uuid)::text',
  (SELECT s.id FROM public.relay_sources s WHERE s.record_id = (SELECT v::uuid FROM t.saved WHERE k = 'CONC')))) AS r(x text);
DO $$
BEGIN
  PERFORM t.ok(t.get('00000000-0000-4000-8000-0000000000a6', (SELECT v::uuid FROM t.saved WHERE k = 'CONC')) -> 'sources' -> 0 ->> 'excerpt' LIKE 'MARKERB1%', '22b before commit');
  PERFORM t.act(NULL);
END $$;
SELECT t.dblink_exec('other', 'commit');
DO $$
DECLARE g jsonb;
BEGIN
  g := t.get('00000000-0000-4000-8000-0000000000a6', (SELECT v::uuid FROM t.saved WHERE k = 'CONC'));
  PERFORM t.ok(g -> 'sources' -> 0 -> 'redacted' ->> 'reason' = 'manual' AND NOT (g::text LIKE '%MARKERB1%'), '22b after commit');
  PERFORM t.act(NULL);
END $$;
-- 22d: إنشاءان متزامنان بنفس المفتاح ⇒ سجل واحد والثاني replayed
SELECT t.dblink_connect('third', format('dbname=%s port=%s host=%s user=postgres', current_database(),
         current_setting('port'), split_part(current_setting('unix_socket_directories'), ',', 1)));
SELECT t.dblink_exec('other', 'begin');
SELECT t.dblink_exec('other', $q$set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a6'$q$);
SELECT t.dblink_exec('other', 'set local role authenticated');
SELECT x FROM t.dblink('other', format('select (public.relay_create(%L::jsonb))->>''replayed''', t.req('PAR', '{}'))) AS r(x text);
SELECT t.dblink_exec('third', $q$set request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a6'$q$);
SELECT t.dblink_exec('third', 'set role authenticated');
SELECT t.dblink_send_query('third', format('select (public.relay_create(%L::jsonb))::text', t.req('PAR', '{}')));
SELECT pg_sleep(0.5);
SELECT t.dblink_exec('other', 'commit');
DO $$
DECLARE res text;
BEGIN
  SELECT x INTO res FROM t.dblink_get_result('third') AS r(x text);
  PERFORM t.ok((res::jsonb ->> 'replayed')::boolean AND (SELECT count(*) FROM public.relay_records WHERE idempotency_key = md5('PAR')::uuid) = 1,
               '22d concurrent idempotency: ' || coalesce(res, 'null'));
  RAISE NOTICE 'PASS 22: سحب صلاحية/حجب في معاملة متزامنة ⇒ يظهر حتى التثبيت ويختفي في القراءة التالية بعده؛ الكنس يتخطى سجلًا مقفولًا بإعادة فتح؛ إنشاءان متزامنان بنفس المفتاح ⇒ سجل واحد والثاني replayed (لا 23505)';
END $$;
SELECT t.dblink_get_result('third') IS NULL;
SELECT t.dblink_disconnect('third');
SELECT t.dblink_disconnect('other');

-- ── 23: فشل جزئي في الإنشاء ⇒ لا شيء يُكتب ──────────────────────────────────
DO $$
DECLARE c text; n_rec int; n_src int; n_snap int; n_ev int;
BEGIN
  SELECT count(*) INTO n_rec FROM public.relay_records; SELECT count(*) INTO n_src FROM public.relay_sources;
  SELECT count(*) INTO n_snap FROM public.relay_source_snapshots; SELECT count(*) INTO n_ev FROM public.relay_events;
  -- S2 يصل لـ SB: مصدر صالح أولًا ثم مصدر غير موجود
  c := t.err('00000000-0000-4000-8000-0000000000a6', format('public.relay_create(%L::jsonb)',
         t.req('PART', array['3e550000-0000-4000-8000-0000000000b1', gen_random_uuid()])));
  PERFORM t.ok(c = 'P0002', '23 partial ' || c);
  c := t.errfull('00000000-0000-4000-8000-0000000000a5', format('public.relay_create(%L::jsonb)',
         t.req('PART2', array['3e550000-0000-4000-8000-0000000000a2']::uuid[])));
  PERFORM t.ok(c LIKE '22023|%message_has_no_text%', '23 deleted message source ' || c);
  PERFORM t.ok((SELECT count(*) FROM public.relay_records) = n_rec AND (SELECT count(*) FROM public.relay_sources) = n_src
               AND (SELECT count(*) FROM public.relay_source_snapshots) = n_snap AND (SELECT count(*) FROM public.relay_events) = n_ev, '23 nothing written');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS 23: إنشاء بمصدر صالح + مصدر غير موجود ⇒ P0002، وبمصدر محذوف ⇒ 22023؛ صفر سجلات/مراجع/لقطات/أحداث جديدة';
END $$;

-- ── 21 (جزء 2): الصندوق يعمل كما هو ─────────────────────────────────────────
DO $$
BEGIN
  PERFORM t.ok(t.matrix() = (SELECT v FROM t.saved WHERE k = 'matrix_mid'), '21c matrix after relay ops');
  RAISE NOTICE 'PASS 21 (جزء 2): مصفوفة inbox_can_access بعد كل عمليات Relay (إنشاء، حجب، كنس، إسناد، انتقالات) مطابقة لما قبلها';
END $$;

-- ============================================================================
-- ② التراجع وإعادة التطبيق
-- ============================================================================
INSERT INTO t.saved SELECT 'chat_before_rollback', t.chat_digest();
INSERT INTO t.saved SELECT 'matrix_before_rollback', t.matrix();
-- محاولة التراجع والبيانات موجودة، في جلسة منفصلة لالتقاط الرفض
\set rollback_sql `cat migrations/_rollback/073_relay_core.down.sql`
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
  PERFORM t.ok(c LIKE '%rollback_discard_data%', '24a refusal message: ' || c);
  PERFORM t.ok(to_regclass('public.relay_records') IS NOT NULL AND to_regprocedure('public.relay_get(uuid)') IS NOT NULL
               AND (SELECT count(*) FROM public.relay_records) > 0, '24a rollback refused with data');
  RAISE NOTICE 'PASS 24a: التراجع يرفض لو فيه سجلات Relay بلا relay.rollback_discard_data=on (لا شيء اتشال)';
END $$;
SET relay.rollback_discard_data = 'on';
\i migrations/_rollback/073_relay_core.down.sql
RESET relay.rollback_discard_data;
DO $$
BEGIN
  PERFORM t.ok(to_regclass('public.relay_records') IS NULL AND to_regprocedure('public.relay_get(uuid)') IS NULL
               AND to_regprocedure('public.relay_retention_sweep(integer)') IS NULL, '24b objects gone');
  PERFORM t.ok(t.chat_digest() = (SELECT v FROM t.saved WHERE k = 'chat_before_rollback'), '24c chat untouched by rollback');
  PERFORM t.ok(t.matrix() = (SELECT v FROM t.saved WHERE k = 'matrix_before_rollback'), '24d inbox matrix after rollback');
  RAISE NOTICE 'PASS 24b: بعد التراجع لا جداول ولا دوال Relay، والشات/الصندوق/التذاكر/الإشعارات لم تُلمس، ومصفوفة الوصول كما قبل التراجع';
END $$;
\i migrations/073_relay_core.sql
DO $$
BEGIN
  PERFORM t.ok(NOT (SELECT enabled FROM public.relay_workspaces WHERE kind = 'platform'), '24e re-apply disabled');
  PERFORM t.ok(t.err('00000000-0000-4000-8000-0000000000a5', 'public.relay_list()') = '0A000', '24e re-apply off');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS 24c: إعادة التطبيق تنجح (كتلة التحقق) ويعود Relay مطفأ';
END $$;

\echo 'ALL relay-core tests passed'
