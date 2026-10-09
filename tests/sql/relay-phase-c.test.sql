-- ============================================================================
-- Relay — المرحلة C (074_relay_phase_c) على نسخة مطابقة لشكل الإنتاج
--
-- قرارات المالك 2026-10-09 (14:21 و14:24 UTC):
--   P1 تعديل السجل لكل من يراه · P2 إرفاق المصادر لكل من يراه (والوصول للمحادثة
--   ما زال شرطًا) · P3 الإسناد عند الإنشاء للمشرف ومن مُنح الصلاحية فقط ·
--   P4 المالك بلا صلاحية ينقل لنفسه أو لا أحد فقط.
--
--   ⓪ 073 مفعّل (حالة الإنتاج) + سجل من المرحلة B
--   ① 074: عدم المساس، الصلاحيات المباشرة، my_access، P3، المنح/السحب، P4،
--      P1/P2، التصنيف، C3 على كل قراءة، التسرب، الحجب، C5، انحدار المرحلة B
--   ② إعادة التشغيل، التراجع (رفض مع بيانات، نص 073 حرفيًا)، إعادة التطبيق
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
-- نص الدوال كما ثبتها 073 (لإثبات أن التراجع يعيدها حرفيًا). relay_assign منفصلة:
-- التراجع يعيدها بنص 073 مع استثناء واحد مقصود (coalesce يقفل ثغرة NULL).
CREATE FUNCTION t.fn_digest() RETURNS text LANGUAGE sql AS $$
  select md5(string_agg(pg_get_functiondef(f::regprocedure), '#' order by f))
    from unnest(array['public.relay_create(jsonb)',
                      'public.relay_update(uuid,jsonb,integer)', 'public.relay_list(jsonb)',
                      'public._relay_record_json(uuid)']) f $$;
CREATE FUNCTION t.assign_def() RETURNS text LANGUAGE sql AS $$
  select pg_get_functiondef(to_regprocedure('public.relay_assign(uuid,uuid,uuid,integer)')) $$;
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
-- ⓪ المرحلة B (073) كما في الإنتاج اليوم
-- ============================================================================
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
\i migrations/073_relay_core.sql
SET search_path = public, extensions;
-- الإنتاج: Relay مفعّل لمساحة المنصة (2026-10-09 ~13:45 UTC)
UPDATE public.relay_workspaces SET enabled = true WHERE kind = 'platform';
INSERT INTO t.saved SELECT 'fn_073', t.fn_digest();
INSERT INTO t.saved SELECT 'assign_073', t.assign_def();

-- ثغرة 073 (موجودة في الإنتاج اليوم): سجل بلا مالك، "r.owner_id = auth.uid()" = NULL
-- و"not NULL" لا ترفض ⇒ منشئ السجل (غير مشرف) يسنده لأي حد أو يغيّر فريقه.
-- نثبتها هنا كدليل؛ 074 يقفلها (P4) والتراجع لا يرجّعها (RB).
DO $$
DECLARE rid uuid;
BEGIN
  rid := t.mk(t.u('S1'), 'HOLE073', '{}', '{}');
  PERFORM t.ok(t.err(t.u('S1'), t.assign_sql(rid, NULL, t.u('T1'))) = 'ok', 'HOLE 073 team change on unassigned');
  PERFORM t.ok(t.err(t.u('S1'), t.assign_sql(rid, t.u('S2'), NULL)) = 'ok', 'HOLE 073 assign unassigned to other');
  PERFORM t.ok((SELECT owner_id = t.u('S2') FROM public.relay_records WHERE id = rid), 'HOLE 073 reproduced');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS HOLE-073: (دليل) في 073 أي مشاهد لسجل بلا مالك يقدر يسنده لغيره أو يغيّر فريقه';
END $$;

-- سجل من المرحلة B: S1 أسنده لـ S2 (مسموح في 073)
DO $$
DECLARE rid uuid;
BEGIN
  rid := t.mk(t.u('S1'), 'PRE', array['3e550000-0000-4000-8000-0000000000a1']::uuid[], jsonb_build_object('owner_id', t.u('S2')));
  PERFORM t.ok(rid IS NOT NULL, 'B: S1 assigns S2 under 073');
  INSERT INTO t.saved VALUES ('PRE', rid::text);
  PERFORM t.act(NULL);
END $$;
INSERT INTO t.saved SELECT 'matrix_before', t.matrix();
INSERT INTO t.saved SELECT 'chat_before', t.chat_digest();
INSERT INTO t.saved SELECT 'pre_row', (SELECT md5(to_jsonb(r)::text) FROM public.relay_records r WHERE id = (SELECT v::uuid FROM t.saved WHERE k = 'PRE'));

-- ============================================================================
-- ① تطبيق 074
-- ============================================================================
\i migrations/074_relay_phase_c.sql
SET search_path = public, extensions;

-- ── C0: لا مساس بالصندوق ولا بالبيانات القائمة ───────────────────────────────
DO $$
DECLARE g jsonb;
BEGIN
  PERFORM t.ok(t.matrix() = (SELECT v FROM t.saved WHERE k = 'matrix_before'), 'C0 matrix');
  PERFORM t.ok(t.chat_digest() = (SELECT v FROM t.saved WHERE k = 'chat_before'), 'C0 chat');
  PERFORM t.ok((SELECT md5((to_jsonb(r) - 'category')::text) FROM public.relay_records r WHERE id = (SELECT v::uuid FROM t.saved WHERE k = 'PRE'))
               = (SELECT v FROM t.saved WHERE k = 'pre_row'), 'C0 existing record unchanged');
  g := t.get(t.u('S1'), (SELECT v::uuid FROM t.saved WHERE k = 'PRE'));
  PERFORM t.ok(g -> 'record' -> 'category' = 'null'::jsonb AND g -> 'sources' -> 0 ->> 'excerpt' LIKE 'MARKERA1%', 'C0 read ' || g::text);
  PERFORM t.ok((SELECT enabled FROM public.relay_workspaces WHERE kind = 'platform'), 'C0 still enabled');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS C0: تطبيق 074 لا يغيّر inbox_can_access ولا الشات/الصندوق ولا السجلات القائمة (category = null) ولا حالة التفعيل';
END $$;

-- ── C1: الصلاحيات المباشرة والدوال ──────────────────────────────────────────
DO $$
DECLARE f text;
BEGIN
  PERFORM t.ok(t.err(t.u('EA'), '(select count(*) from public.relay_assigners)') = '42501', 'C1 select assigners');
  PERFORM t.ok(t.err_stmt(t.u('EA'), format('insert into public.relay_assigners (user_id) values (%L)', t.u('S1'))) = '42501', 'C1 insert');
  PERFORM t.ok(t.err_stmt(t.u('EA'), 'delete from public.relay_assigners') = '42501', 'C1 delete');
  PERFORM t.ok(t.err_anon('select count(*) from public.relay_assigners') = '42501', 'C1 anon');
  PERFORM t.ok(NOT has_table_privilege('service_role', 'public.relay_assigners', 'SELECT')
               AND NOT has_table_privilege('service_role', 'public.relay_assigners', 'INSERT'), 'C1 service_role table');
  PERFORM t.ok((SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND (p.proname LIKE 'relay\_%' OR p.proname LIKE '\_relay\_%')
                   AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) = 15, 'C1 exactly 15 public RPCs');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                            WHERE n.nspname = 'public' AND (p.proname LIKE 'relay\_%' OR p.proname LIKE '\_relay\_%')
                              AND (has_function_privilege('service_role', p.oid, 'EXECUTE')
                                   OR has_function_privilege('anon', p.oid, 'EXECUTE'))), 'C1 no anon/service_role');
  FOREACH f IN ARRAY array['public._relay_can_assign()', 'public._relay_has_assigner_grant(''00000000-0000-4000-8000-0000000000a5''::uuid)',
                           'public._relay_parse_category(''"other"''::jsonb)', 'public._relay_require_supervisor()',
                           'public._relay_forbidden(''x'')'] LOOP
    PERFORM t.ok(t.err(t.u('EA'), f) = '42501', 'C1 internal ' || f);
  END LOOP;
  PERFORM t.ok(t.err_anon('select public.relay_my_access()') = '42501', 'C1 anon my_access');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'relay_assigners' AND permissive = 'PERMISSIVE'), 'C1 policy');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS C1: relay_assigners بلا أي صلاحية مباشرة (authenticated حتى المشرف، anon، service_role)؛ 15 RPC عامة بالضبط؛ الدوال الداخلية الجديدة ⇒ 42501';
END $$;

-- ── C2: relay_my_access ──────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM t.ok(t.call(t.u('S1'), 'public.relay_my_access()') = '{"member":true,"enabled":true,"supervisor":false,"can_assign":false}'::jsonb, 'C2 S1');
  PERFORM t.ok(t.call(t.u('AD'), 'public.relay_my_access()') = '{"member":true,"enabled":true,"supervisor":false,"can_assign":false}'::jsonb, 'C2 AD');
  PERFORM t.ok(t.call(t.u('EA'), 'public.relay_my_access()') = '{"member":true,"enabled":true,"supervisor":true,"can_assign":true}'::jsonb, 'C2 EA');
  PERFORM t.ok(t.call(t.u('OW'), 'public.relay_my_access()') ->> 'can_assign' = 'true', 'C2 OW admin ctx');
  PERFORM t.ok(t.call(t.u('C1'), 'public.relay_my_access()') = '{"member":false,"enabled":false,"supervisor":false,"can_assign":false}'::jsonb, 'C2 customer');
  PERFORM t.ok(t.call(t.u('BN'), 'public.relay_my_access()') = '{"member":false,"enabled":false,"supervisor":false,"can_assign":false}'::jsonb, 'C2 banned');
  -- المشرف عبر الـAPI = طاقم عادي (073 R2-2)
  PERFORM t.ok(t.call_api(t.u('EA'), 'public.relay_my_access()') ->> 'can_assign' = 'false', 'C2 EA via api');
  PERFORM t.ctx('customer');
  PERFORM t.ok(t.call(t.u('OW'), 'public.relay_my_access()') ->> 'member' = 'false', 'C2 OW customer ctx');
  PERFORM t.ctx('admin');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS C2: relay_my_access: الدعم والأدمن العادي can_assign=false، المشرف والمالك في admin true، العميل والمحظور والمالك في customer لا شيء، المشرف عبر الـAPI false';
END $$;

-- ── C3: P3 الإسناد عند الإنشاء ───────────────────────────────────────────────
DO $$
DECLARE c text; rid uuid;
BEGIN
  -- غير المصرّح لهم: مالك آخر أو فريق ⇒ 42501 forbidden مع الحقل
  c := t.errfull(t.u('S1'), t.create_sql('P3a', '{}', jsonb_build_object('owner_id', t.u('S2'))));
  PERFORM t.ok(c LIKE '42501|%' AND c LIKE '%"field": "owner_id"%' AND c LIKE '%"code": "forbidden"%', 'P3 S1->S2 ' || c);
  c := t.errfull(t.u('S1'), t.create_sql('P3b', '{}', jsonb_build_object('team_id', t.u('T1'))));
  PERFORM t.ok(c LIKE '42501|%' AND c LIKE '%"field": "team_id"%', 'P3 S1 team ' || c);
  c := t.errfull(t.u('S1'), t.create_sql('P3c', '{}', jsonb_build_object('owner_id', t.u('S1'), 'team_id', t.u('T1'))));
  PERFORM t.ok(c LIKE '42501|%' AND c LIKE '%"field": "team_id"%', 'P3 S1 self+team ' || c);
  PERFORM t.ok(t.err(t.u('AD'), t.create_sql('P3d', '{}', jsonb_build_object('owner_id', t.u('S1')))) = '42501', 'P3 AD->S1');
  PERFORM t.ok(t.err(t.u('GR'), t.create_sql('P3e', '{}', jsonb_build_object('owner_id', t.u('S1')))) = '42501', 'P3 GR before grant');
  -- قبل الأهلية: غير المصرّح له لا يعرف شيئًا عن المستهدف (عميل/محظور/غير موجود = نفس الرد)
  PERFORM t.ok(t.errfull(t.u('S1'), t.create_sql('P3f', '{}', jsonb_build_object('owner_id', t.u('C1'))))
               = t.errfull(t.u('S1'), t.create_sql('P3f', '{}', jsonb_build_object('owner_id', gen_random_uuid()))), 'P3 no eligibility oracle');
  PERFORM t.ok(t.err(t.u('S1'), t.create_sql('P3f', '{}', jsonb_build_object('owner_id', t.u('BN')))) = '42501', 'P3 banned target');
  -- المشرف عبر الـAPI = طاقم عادي
  BEGIN
    PERFORM t.call_api(t.u('EA'), t.create_sql('P3g', '{}', jsonb_build_object('owner_id', t.u('S1'))));
    c := 'ok';
  EXCEPTION WHEN others THEN c := sqlstate;
  END;
  PERFORM t.ok(c = '42501', 'P3 supervisor via api ' || c);
  -- لا شيء اتكتب في كل محاولات الرفض
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.relay_records WHERE title LIKE 'TITLEMARK P3%'), 'P3 nothing written');

  -- المسموح لغير المصرّح له: نفسه أو بلا مالك
  rid := t.mk(t.u('S1'), 'P3self', '{}', jsonb_build_object('owner_id', t.u('S1')));
  PERFORM t.ok((SELECT owner_id = t.u('S1') AND team_id IS NULL FROM public.relay_records WHERE id = rid), 'P3 self');
  rid := t.mk(t.u('S1'), 'P3none', '{}');
  PERFORM t.ok((SELECT owner_id IS NULL FROM public.relay_records WHERE id = rid), 'P3 unassigned');
  INSERT INTO t.saved VALUES ('UNASSIGNED', rid::text);
  rid := t.mk(t.u('AD'), 'P3adself', '{}', jsonb_build_object('owner_id', t.u('AD')));
  PERFORM t.ok(rid IS NOT NULL, 'P3 AD self');

  -- المشرف: أي مالك مؤهل وأي فريق
  rid := t.mk(t.u('EA'), 'P3ea', '{}', jsonb_build_object('owner_id', t.u('S2'), 'team_id', t.u('T1')));
  PERFORM t.ok((SELECT owner_id = t.u('S2') AND team_id = t.u('T1') FROM public.relay_records WHERE id = rid), 'P3 EA');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.relay_events WHERE record_id = rid AND kind = 'created' AND actor_id = t.u('EA')
                         AND payload ->> 'owner_id' = t.u('S2')::text), 'P3 EA event');
  rid := t.mk(t.u('OW'), 'P3ow', '{}', jsonb_build_object('owner_id', t.u('S3')));
  PERFORM t.ok(rid IS NOT NULL, 'P3 OW admin ctx');
  -- أهلية المستهدف للمصرّح لهم: عميل، محظور، غير موجود ⇒ 22023 not_eligible
  FOREACH c IN ARRAY array[t.u('C1')::text, t.u('BN')::text, gen_random_uuid()::text] LOOP
    PERFORM t.ok(t.errfull(t.u('EA'), t.create_sql('P3elig' || c, '{}', jsonb_build_object('owner_id', c))) LIKE '22023|%not_eligible%', 'P3 eligibility ' || c);
  END LOOP;
  PERFORM t.ok(t.err(t.u('EA'), t.create_sql('P3team', '{}', jsonb_build_object('team_id', gen_random_uuid()))) = '22023', 'P3 bad team');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS P3: الدعم/الأدمن العادي/GR قبل المنح ⇒ 42501 forbidden (field owner_id أو team_id) لمالك آخر أو فريق، وبلا كتابة، وبلا كشف أهلية المستهدف؛ المشرف عبر الـAPI ⇒ 42501؛ نفسه أو بلا مالك ⇒ مسموح؛ المشرف والمالك في admin ⇒ أي مالك مؤهل وفريق؛ غير المؤهل ⇒ 22023';
END $$;

-- ── C4: منح وسحب صلاحية الإسناد ─────────────────────────────────────────────
DO $$
DECLARE r jsonb; c text; rid uuid; n int;
BEGIN
  -- غير المشرف لا يمنح ولا يسحب ولا يقرأ القائمة (حتى لنفسه)
  FOREACH c IN ARRAY array['S1', 'AD', 'GR', 'S3'] LOOP
    PERFORM t.ok(t.err(t.u(c), format('public.relay_grant_assigner(%L::uuid)', t.u(c))) = '42501', 'GRANT self ' || c);
    PERFORM t.ok(t.err(t.u(c), format('public.relay_grant_assigner(%L::uuid)', t.u('GR'))) = '42501', 'GRANT other ' || c);
    PERFORM t.ok(t.err(t.u(c), format('public.relay_revoke_assigner(%L::uuid)', t.u('GR'))) = '42501', 'REVOKE ' || c);
    PERFORM t.ok(t.err(t.u(c), 'public.relay_list_assigners()') = '42501', 'LIST ' || c);
  END LOOP;
  PERFORM t.ok(t.err(t.u('C1'), format('public.relay_grant_assigner(%L::uuid)', t.u('GR'))) = '42501', 'GRANT customer');
  PERFORM t.ok(t.err(t.u('BN'), format('public.relay_grant_assigner(%L::uuid)', t.u('GR'))) = '42501', 'GRANT banned');
  BEGIN
    PERFORM t.call_api(t.u('EA'), format('public.relay_grant_assigner(%L::uuid)', t.u('GR')));
    c := 'ok';
  EXCEPTION WHEN others THEN c := sqlstate;
  END;
  PERFORM t.ok(c = '42501', 'GRANT supervisor via api ' || c);
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.relay_assigners), 'GRANT nothing yet');
  -- المنح لغير مؤهل ⇒ 22023
  FOREACH c IN ARRAY array[t.u('C1')::text, t.u('BN')::text, gen_random_uuid()::text] LOOP
    PERFORM t.ok(t.err(t.u('EA'), format('public.relay_grant_assigner(%L::uuid)', c)) = '22023', 'GRANT ineligible ' || c);
  END LOOP;
  -- المشرف يمنح GR؛ التكرار لا يضيف صفًا
  r := t.call(t.u('EA'), format('public.relay_grant_assigner(%L::uuid)', t.u('GR')));
  PERFORM t.ok(r ->> 'changed' = 'true', 'GRANT ok ' || r::text);
  r := t.call(t.u('EA'), format('public.relay_grant_assigner(%L::uuid)', t.u('GR')));
  PERFORM t.ok(r ->> 'changed' = 'false' AND (SELECT count(*) FROM public.relay_assigners) = 1, 'GRANT idempotent');
  PERFORM t.ok((SELECT granted_by = t.u('EA') AND revoked_at IS NULL FROM public.relay_assigners WHERE user_id = t.u('GR')), 'GRANT row');
  r := t.call(t.u('EA'), 'public.relay_list_assigners()');
  PERFORM t.ok(jsonb_array_length(r) = 1 AND r -> 0 ->> 'user_id' = t.u('GR')::text AND (r -> 0 ->> 'eligible')::boolean, 'LIST ' || r::text);
  PERFORM t.ok(t.call(t.u('GR'), 'public.relay_my_access()') ->> 'can_assign' = 'true', 'GRANT my_access');

  -- GR الآن يسند عند الإنشاء لأي مالك مؤهل ولفريق
  rid := t.mk(t.u('GR'), 'G1', '{}', jsonb_build_object('owner_id', t.u('S2'), 'team_id', t.u('T1')));
  PERFORM t.ok((SELECT owner_id = t.u('S2') AND team_id = t.u('T1') FROM public.relay_records WHERE id = rid), 'GR create assign');
  PERFORM t.ok(t.errfull(t.u('GR'), t.create_sql('G1x', '{}', jsonb_build_object('owner_id', t.u('C1')))) LIKE '22023|%not_eligible%', 'GR eligibility');
  -- المنح لكل مستخدم لا لسياق: يسري عبر الـAPI أيضًا
  r := t.call_api(t.u('GR'), t.create_sql('G1api', '{}', jsonb_build_object('owner_id', t.u('S2'))));
  PERFORM t.ok(r -> 'record' ->> 'owner_id' = t.u('S2')::text AND r -> 'record' ->> 'created_via' = 'extension', 'GR via api');

  -- الحظر يُسقط الصلاحية فورًا (العضوية تتطلب حسابًا نشطًا)
  PERFORM t.act(NULL);  -- تعديل الحظر محصور في مالك المنصة؛ هنا كمالك القاعدة
  UPDATE public.profiles SET ban_status = 'banned' WHERE id = t.u('GR');
  PERFORM t.ok(t.err(t.u('GR'), t.create_sql('G1ban', '{}', jsonb_build_object('owner_id', t.u('S2')))) = '42501', 'GR banned');
  PERFORM t.ok(t.call(t.u('EA'), 'public.relay_list_assigners()') -> 0 ->> 'eligible' = 'false', 'LIST shows ineligible');
  PERFORM t.act(NULL);  -- تعديل الحظر محصور في مالك المنصة؛ هنا كمالك القاعدة
  UPDATE public.profiles SET ban_status = NULL WHERE id = t.u('GR');
  PERFORM t.ok(t.call(t.u('GR'), 'public.relay_my_access()') ->> 'can_assign' = 'true', 'GR unbanned');

  -- السحب: صلاحية GR تسقط، الصف يبقى للتاريخ
  r := t.call(t.u('EA'), format('public.relay_revoke_assigner(%L::uuid)', t.u('GR')));
  PERFORM t.ok(r ->> 'changed' = 'true', 'REVOKE ok');
  r := t.call(t.u('EA'), format('public.relay_revoke_assigner(%L::uuid)', t.u('GR')));
  PERFORM t.ok(r ->> 'changed' = 'false', 'REVOKE idempotent');
  PERFORM t.ok((SELECT count(*) FROM public.relay_assigners WHERE user_id = t.u('GR') AND revoked_at IS NOT NULL
                   AND revoked_by = t.u('EA')) = 1, 'REVOKE history kept');
  PERFORM t.ok(t.err(t.u('GR'), t.create_sql('G2', '{}', jsonb_build_object('owner_id', t.u('S2')))) = '42501', 'GR after revoke');
  PERFORM t.ok(t.call(t.u('EA'), 'public.relay_list_assigners()') = '[]'::jsonb, 'LIST after revoke');
  -- لا رجوع عن سحب ولا تعديل منح، حتى كمالك القاعدة (المحفز)
  BEGIN
    UPDATE public.relay_assigners SET revoked_at = NULL, revoked_by = NULL WHERE user_id = t.u('GR');
    c := 'ok';
  EXCEPTION WHEN others THEN c := sqlstate;
  END;
  PERFORM t.ok(c = '42501', 'GUARD un-revoke ' || c);
  BEGIN
    UPDATE public.relay_assigners SET user_id = t.u('S1') WHERE user_id = t.u('GR');
    c := 'ok';
  EXCEPTION WHEN others THEN c := sqlstate;
  END;
  PERFORM t.ok(c = '42501', 'GUARD retarget ' || c);
  -- إعادة المنح = صف جديد
  PERFORM t.call(t.u('EA'), format('public.relay_grant_assigner(%L::uuid)', t.u('GR')));
  PERFORM t.ok((SELECT count(*) FROM public.relay_assigners WHERE user_id = t.u('GR')) = 2
               AND (SELECT count(*) FROM public.relay_assigners WHERE user_id = t.u('GR') AND revoked_at IS NULL) = 1, 'REGRANT');
  -- الإدارة مطفأة مع Relay
  UPDATE public.relay_workspaces SET enabled = false WHERE kind = 'platform';
  PERFORM t.ok(t.err(t.u('EA'), format('public.relay_grant_assigner(%L::uuid)', t.u('S1'))) = '0A000', 'GRANT disabled');
  PERFORM t.ok(t.call(t.u('EA'), 'public.relay_my_access()') ->> 'enabled' = 'false', 'my_access disabled');
  UPDATE public.relay_workspaces SET enabled = true WHERE kind = 'platform';
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS P3-grant: المنح/السحب/القائمة للمشرف فقط (الدعم، الأدمن العادي، GR لنفسه، العميل، المحظور، المشرف عبر الـAPI ⇒ 42501)؛ المنح لغير مؤهل ⇒ 22023؛ GR بعد المنح يسند عند الإنشاء (وعبر الـAPI)؛ الحظر والسحب يسقطانها فورًا؛ التاريخ محفوظ ولا رجوع عن سحب؛ مطفأ ⇒ 0A000';
END $$;

-- ── C5: P4 إعادة الإسناد ─────────────────────────────────────────────────────
DO $$
DECLARE rid uuid; r jsonb; c text;
BEGIN
  -- سجل أنشأه المشرف ومالكه S1 (S1 ليس المنشئ)
  rid := t.mk(t.u('EA'), 'P4', '{}', jsonb_build_object('owner_id', t.u('S1')));
  PERFORM t.ok(t.err(t.u('S1'), t.assign_sql(rid, t.u('S2'), NULL)) = '42501', 'P4 owner -> other');
  PERFORM t.ok(t.err(t.u('S1'), t.assign_sql(rid, t.u('S1'), t.u('T1'))) = '42501', 'P4 owner adds team');
  PERFORM t.ok(t.err(t.u('S1'), t.assign_sql(rid, NULL, t.u('T1'))) = '42501', 'P4 owner release to team');
  PERFORM t.ok(t.err(t.u('S1'), t.assign_sql(rid, t.u('C1'), NULL)) = '42501', 'P4 no eligibility oracle');
  PERFORM t.ok((SELECT owner_id = t.u('S1') AND team_id IS NULL FROM public.relay_records WHERE id = rid), 'P4 unchanged');
  PERFORM t.ok(t.err(t.u('S1'), t.assign_sql(rid, t.u('S1'), NULL)) = 'ok', 'P4 owner keeps self (no-op)');
  -- المالك يترك السجل بلا مالك ⇒ يفقد الوصول (ليس المنشئ) — M9
  r := t.call(t.u('S1'), t.assign_sql(rid, NULL, NULL));
  PERFORM t.ok(r ->> 'access' = 'lost' AND (SELECT owner_id IS NULL FROM public.relay_records WHERE id = rid), 'P4 owner release');
  -- أخذ سجل بلا مالك لنفسك: من يراه فقط (المنشئ هنا = EA). S2 لا يراه ⇒ P0002
  PERFORM t.ok(t.err(t.u('S2'), t.assign_sql(rid, t.u('S2'), NULL)) = 'P0002', 'P4 claim needs access');
  -- سجل بلا مالك أنشأه S1 (غير مصرّح له): يأخذه لنفسه؛ ولا يسنده لغيره
  rid := (SELECT v::uuid FROM t.saved WHERE k = 'UNASSIGNED');
  PERFORM t.ok(t.err(t.u('S1'), t.assign_sql(rid, t.u('S2'), NULL)) = '42501', 'P4 creator unassigned -> other');
  -- ثغرة NULL في 073 مقفولة: لا تغيير فريق على سجل بلا مالك، ولا حتى طلب بلا تغيير (يرفض بدل NULL)
  PERFORM t.ok(t.err(t.u('S1'), t.assign_sql(rid, NULL, t.u('T1'))) = '42501', 'P4 unassigned team change (073 hole)');
  PERFORM t.ok(t.err(t.u('S1'), t.assign_sql(rid, NULL, NULL)) = '42501', 'P4 unassigned null/null fails closed');
  PERFORM t.ok((SELECT owner_id IS NULL AND team_id IS NULL FROM public.relay_records WHERE id = rid), 'P4 unassigned unchanged');
  PERFORM t.ok(t.err(t.u('S1'), t.assign_sql(rid, t.u('S1'), NULL)) = 'ok', 'P4 claim self');
  -- المشرف: أي مالك مؤهل وفريق؛ غير مؤهل ⇒ 22023
  PERFORM t.ok(t.err(t.u('EA'), t.assign_sql(rid, t.u('S2'), t.u('T1'))) = 'ok', 'P4 supervisor');
  PERFORM t.ok(t.errfull(t.u('EA'), t.assign_sql(rid, t.u('C1'), NULL)) LIKE '22023|%not_eligible%', 'P4 supervisor ineligible');
  PERFORM t.ok(t.err(t.u('EA'), t.assign_sql(rid, t.u('BN'), NULL)) = '22023', 'P4 supervisor banned target');
  -- GR (ممنوح) على سجل يراه: يسند لأي مالك مؤهل
  rid := t.mk(t.u('GR'), 'P4gr', '{}', jsonb_build_object('owner_id', t.u('GR')));
  PERFORM t.ok(t.err(t.u('GR'), t.assign_sql(rid, t.u('S3'), t.u('T1'))) = 'ok', 'P4 grantee reassigns');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.relay_events WHERE record_id = rid AND kind = 'assigned' AND actor_id = t.u('GR')
                         AND payload ->> 'to_owner' = t.u('S3')::text), 'P4 event');
  -- GR لا يرى سجلات غيره لمجرد المنح (المنح ليس صلاحية رؤية)
  PERFORM t.ok(t.err(t.u('GR'), format('public.relay_get(%L::uuid)', (SELECT v FROM t.saved WHERE k = 'PRE'))) = 'P0002', 'P4 grant is not visibility');
  PERFORM t.ok(t.err(t.u('GR'), t.assign_sql((SELECT v::uuid FROM t.saved WHERE k = 'PRE'), t.u('GR'), NULL)) = 'P0002', 'P4 grantee needs access');
  -- بعد السحب: GR مالك ⇒ نفس قيد المالك
  PERFORM t.call(t.u('EA'), format('public.relay_revoke_assigner(%L::uuid)', t.u('GR')));
  rid := t.mk(t.u('EA'), 'P4gr2', '{}', jsonb_build_object('owner_id', t.u('GR')));
  PERFORM t.ok(t.err(t.u('GR'), t.assign_sql(rid, t.u('S2'), NULL)) = '42501', 'P4 revoked grantee');
  PERFORM t.call(t.u('EA'), format('public.relay_grant_assigner(%L::uuid)', t.u('GR')));
  -- المشرف عبر الـAPI ليس مشرفًا: لا إعادة إسناد لسجل لا يملكه
  rid := t.mk(t.u('EA'), 'P4api', '{}', jsonb_build_object('owner_id', t.u('S1')));
  BEGIN
    PERFORM t.call_api(t.u('EA'), t.assign_sql(rid, t.u('S2'), NULL));
    c := 'ok';
  EXCEPTION WHEN others THEN c := sqlstate;
  END;
  PERFORM t.ok(c = '42501', 'P4 supervisor via api ' || c);
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS P4: المالك بلا صلاحية ⇒ 42501 لنقل لغيره أو تغيير الفريق (وبلا كشف أهلية)، ومسموح لنفسه أو بلا مالك (ويفقد الوصول)؛ أخذ سجل بلا مالك لنفسك فقط؛ المشرف وGR ⇒ أي مالك مؤهل؛ المنح ليس رؤية؛ بعد السحب نفس قيد المالك؛ المشرف عبر الـAPI ⇒ 42501';
END $$;

-- ── C6: P1 التعديل وP2 الإرفاق لكل من يرى السجل ─────────────────────────────
DO $$
DECLARE rid uuid; r jsonb; c text; n_src int;
BEGIN
  -- EA ينشئ سجلًا مالكه S2 وفريقه T1؛ يراه: EA، S2، S3 (عضو T1)
  rid := t.mk(t.u('EA'), 'P12', '{}', jsonb_build_object('owner_id', t.u('S2'), 'team_id', t.u('T1')));
  INSERT INTO t.saved VALUES ('P12', rid::text);
  -- P1: عضو الفريق (ليس المالك ولا المنشئ) يعدّل
  PERFORM t.ok(t.err(t.u('S3'), format('public.relay_update(%L::uuid, %L::jsonb, %s)', rid, '{"title":"TEAMEDITMARK"}', t.ver(rid))) = 'ok', 'P1 team member edits');
  PERFORM t.ok(t.err(t.u('S2'), format('public.relay_update(%L::uuid, %L::jsonb, %s)', rid, '{"priority":1}', t.ver(rid))) = 'ok', 'P1 owner edits');
  PERFORM t.ok(t.err(t.u('EA'), format('public.relay_update(%L::uuid, %L::jsonb, %s)', rid, '{"priority":2}', t.ver(rid))) = 'ok', 'P1 supervisor edits');
  -- من لا يرى: P0002 (نفس رد غير الموجود)، بلا كتابة
  FOREACH c IN ARRAY array['S1', 'AD', 'GR'] LOOP
    PERFORM t.ok(t.err(t.u(c), format('public.relay_update(%L::uuid, %L::jsonb, %s)', rid, '{"title":"X"}', t.ver(rid))) = 'P0002', 'P1 ' || c);
  END LOOP;
  PERFORM t.ok(t.err(t.u('C1'), format('public.relay_update(%L::uuid, %L::jsonb, %s)', rid, '{"title":"X"}', t.ver(rid))) = '42501', 'P1 customer');
  PERFORM t.ok(t.err(t.u('BN'), format('public.relay_update(%L::uuid, %L::jsonb, %s)', rid, '{"title":"X"}', t.ver(rid))) = '42501', 'P1 banned');
  PERFORM t.ok((SELECT title FROM public.relay_records WHERE id = rid) = 'TEAMEDITMARK', 'P1 stored');
  -- التعديل لا يغيّر المالك أو الفريق (ليس مسار إسناد)
  PERFORM t.ok(t.err(t.u('S3'), format('public.relay_update(%L::uuid, %L::jsonb, %s)', rid, jsonb_build_object('owner_id', t.u('S3')), t.ver(rid))) = '22023', 'P1 owner not updatable');
  PERFORM t.ok(t.err(t.u('S3'), format('public.relay_update(%L::uuid, %L::jsonb, %s)', rid, jsonb_build_object('team_id', NULL), t.ver(rid))) = '22023', 'P1 team not updatable');
  -- P2: S3 يرفق رسالة من SC (له وصول عبر الفريق)
  r := t.call(t.u('S3'), format('public.relay_attach_sources(%L::uuid, %L::jsonb, %s)', rid,
         '[{"type":"mad3oom_message","internal":{"chat_message_id":"3e550000-0000-4000-8000-0000000000c1"}}]', t.ver(rid)));
  PERFORM t.ok((r ->> 'added')::int = 1 AND r -> 'sources' -> 0 ->> 'excerpt' LIKE 'MARKERC1%', 'P2 team member attaches');
  -- P2 لا يتخطى C3: S3 يرى السجل لكن لا يصل لـ SA ⇒ P0002 وبلا كتابة
  SELECT count(*) INTO n_src FROM public.relay_sources WHERE record_id = rid;
  PERFORM t.ok(t.err(t.u('S3'), format('public.relay_attach_sources(%L::uuid, %L::jsonb, %s)', rid,
         '[{"type":"mad3oom_message","internal":{"chat_message_id":"3e550000-0000-4000-8000-0000000000a1"}}]', t.ver(rid))) = 'P0002', 'P2 needs conversation access');
  -- نفس الرد لرسالة غير موجودة (لا استنتاج)
  PERFORM t.ok(t.errfull(t.u('S3'), format('public.relay_attach_sources(%L::uuid, %L::jsonb, %s)', rid,
         '[{"type":"mad3oom_message","internal":{"chat_message_id":"3e550000-0000-4000-8000-0000000000a1"}}]', t.ver(rid)))
               = t.errfull(t.u('S3'), format('public.relay_attach_sources(%L::uuid, %L::jsonb, %s)', rid,
         jsonb_build_array(jsonb_build_object('type', 'mad3oom_message', 'internal', jsonb_build_object('chat_message_id', gen_random_uuid()))), t.ver(rid))), 'P2 no oracle');
  PERFORM t.ok((SELECT count(*) FROM public.relay_sources WHERE record_id = rid) = n_src, 'P2 nothing written');
  -- من لا يرى السجل لا يرفق حتى من محادثة يصلها (S1 يصل لـ SA)
  PERFORM t.ok(t.err(t.u('S1'), format('public.relay_attach_sources(%L::uuid, %L::jsonb, %s)', rid,
         '[{"type":"mad3oom_message","internal":{"chat_message_id":"3e550000-0000-4000-8000-0000000000a1"}}]', t.ver(rid))) = 'P0002', 'P2 non-viewer');
  -- المالك S2 يرى السجل لكن لا يصل لـ SC ⇒ المصدر الذي أرفقه S3 مخفي عنه (C3 على كل قراءة)
  r := t.get(t.u('S2'), rid);
  PERFORM t.ok(r -> 'sources' -> 0 ->> 'excerpt_hidden' = 'no_conversation_access' AND NOT (r::text LIKE '%MARKERC1%'), 'P2 C3 owner hidden');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS P1/P2: عضو الفريق والمالك والمشرف يعدّلون ويرفقون؛ من لا يرى ⇒ P0002 والعميل/المحظور ⇒ 42501؛ التعديل لا يمس المالك/الفريق؛ الإرفاق ما زال يتطلب وصولًا للمحادثة (نفس رد الرسالة غير الموجودة، بلا كتابة)؛ المالك بلا وصول للمحادثة يرى placeholder';
END $$;

-- ── C7: التصنيف ──────────────────────────────────────────────────────────────
DO $$
DECLARE rid uuid; r jsonb; c text; ev jsonb;
BEGIN
  rid := t.mk(t.u('S1'), 'CAT', array['3e550000-0000-4000-8000-0000000000a1', '3e550000-0000-4000-8000-0000000000a3']::uuid[],
              '{"category":"order_status"}');
  INSERT INTO t.saved VALUES ('CAT', rid::text);
  r := t.get(t.u('S1'), rid);
  PERFORM t.ok(r -> 'record' ->> 'category' = 'order_status', 'CAT get');
  SELECT payload INTO ev FROM public.relay_events WHERE record_id = rid AND kind = 'created';
  PERFORM t.ok(ev ->> 'category' = 'order_status', 'CAT created event');
  -- قيم غير صالحة ⇒ 22023 field=category (لا تحويل صامت)
  FOREACH c IN ARRAY array['"bogus"', '1', '{"x":1}', '["other"]', '"ORDER_STATUS"', '""'] LOOP
    PERFORM t.ok(t.errfull(t.u('S1'), t.create_sql('CATbad' || c, '{}', jsonb_build_object('category', c::jsonb))) LIKE '22023|%"field": "category"%', 'CAT invalid ' || c);
  END LOOP;
  PERFORM t.ok(t.err(t.u('S1'), t.create_sql('CATnull', '{}', '{"category":null}')) = 'ok', 'CAT null ok');
  -- التعديل: قيمة صالحة، ثم null، ثم غير صالحة
  PERFORM t.ok(t.err(t.u('S1'), format('public.relay_update(%L::uuid, %L::jsonb, %s)', rid, '{"category":"order_problem"}', t.ver(rid))) = 'ok', 'CAT update');
  SELECT payload INTO ev FROM public.relay_events WHERE record_id = rid AND kind = 'updated' ORDER BY id DESC LIMIT 1;
  PERFORM t.ok(ev -> 'category' = '{"from":"order_status","to":"order_problem"}'::jsonb AND ev -> 'changed' = '["category"]'::jsonb, 'CAT update event ' || ev::text);
  PERFORM t.ok(t.err(t.u('S1'), format('public.relay_update(%L::uuid, %L::jsonb, %s)', rid, '{"category":"nope"}', t.ver(rid))) = '22023', 'CAT update invalid');
  PERFORM t.ok(t.err(t.u('S1'), format('public.relay_update(%L::uuid, %L::jsonb, %s)', rid, '{"category":null}', t.ver(rid))) = 'ok', 'CAT clear');
  PERFORM t.ok((SELECT category IS NULL FROM public.relay_records WHERE id = rid), 'CAT cleared');
  PERFORM t.call(t.u('S1'), format('public.relay_update(%L::uuid, %L::jsonb, %s)', rid, '{"category":"complaint"}', t.ver(rid)));
  -- القائمة: التصنيف ظاهر، الفلتر يعمل، فلتر غير صالح ⇒ 22023، ولا مقتطف
  r := t.call(t.u('S1'), 'public.relay_list(''{"category":"complaint"}''::jsonb)');
  PERFORM t.ok(jsonb_array_length(r) = 1 AND r -> 0 ->> 'id' = rid::text AND r -> 0 ->> 'category' = 'complaint'
               AND NOT (r::text LIKE '%MARKER%') AND NOT (r::text LIKE '%excerpt%'), 'CAT list filter');
  PERFORM t.ok(t.err(t.u('S1'), 'public.relay_list(''{"category":"nope"}''::jsonb)') = '22023', 'CAT list invalid');
  -- القيد على الجدول نفسه (دفاع في العمق)
  BEGIN
    UPDATE public.relay_records SET category = 'bogus' WHERE id = rid;
    c := 'ok';
  EXCEPTION WHEN others THEN c := sqlstate;
  END;
  PERFORM t.ok(c = '23514', 'CAT check constraint ' || c);
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS CAT: التصنيف يُحفظ ويُرجع في get/list ويُسجَّل كقيمة ثابتة؛ قيم غير صالحة (نص، رقم، كائن، مصفوفة، حالة أحرف) ⇒ 22023 field=category؛ التعديل والمسح يعملان؛ فلتر القائمة يعمل؛ قيد الجدول ⇒ 23514';
END $$;

-- ── C8: C3 على كل قراءة + الاحتفاظ + الحجب + التسرب (بعد 074) ──────────────
DO $$
DECLARE rid uuid := (SELECT v::uuid FROM t.saved WHERE k = 'PRE'); g jsonb; sid uuid; l jsonb; ev jsonb; a text; h text;
BEGIN
  -- PRE: أنشأه S1 من SA ومالكه S2 (بلا وصول لـ SA)
  g := t.get(t.u('S2'), rid);
  PERFORM t.ok(g -> 'sources' -> 0 ->> 'excerpt_hidden' = 'no_conversation_access' AND NOT (g::text LIKE '%MARKERA%')
               AND NOT (g -> 'sources' -> 0 ? 'sender_label'), 'C3 owner hidden');
  -- نقل المحادثة لـ S2 ⇒ يرى في القراءة التالية، والمنشئ S1 يفقدها
  UPDATE public.inbox_conversations SET assignee_id = t.u('S2') WHERE session_id = '5e550000-0000-4000-8000-0000000000a1';
  PERFORM t.ok(t.get(t.u('S2'), rid) -> 'sources' -> 0 ->> 'excerpt' LIKE 'MARKERA1%', 'C3 owner gains');
  PERFORM t.ok(t.get(t.u('S1'), rid) -> 'sources' -> 0 ->> 'excerpt_hidden' = 'no_conversation_access', 'C3 creator loses');
  UPDATE public.inbox_conversations SET assignee_id = t.u('S1') WHERE session_id = '5e550000-0000-4000-8000-0000000000a1';
  PERFORM t.ok(t.get(t.u('S2'), rid) -> 'sources' -> 0 ->> 'excerpt_hidden' = 'no_conversation_access', 'C3 owner hidden again');
  -- الحصول على المنح لا يمنح رؤية مقتطف: GR مالك لسجل من SA
  PERFORM t.ok(t.call(t.u('GR'), 'public.relay_my_access()') ->> 'can_assign' = 'true', 'C3 GR has grant');
  g := t.call(t.u('EA'), t.create_sql('C3gr', array['3e550000-0000-4000-8000-0000000000a2']::uuid[], jsonb_build_object('owner_id', t.u('GR'))));
  g := t.get(t.u('GR'), (g -> 'record' ->> 'id')::uuid);
  PERFORM t.ok(g -> 'sources' -> 0 ->> 'excerpt_hidden' = 'no_conversation_access' AND NOT (g::text LIKE '%MARKERA2%'), 'C3 grantee hidden');
  -- التسرب: list/events/find_by_source/my_access/list_assigners لكل الفاعلين بلا نص
  FOREACH a IN ARRAY array['S1', 'S2', 'S3', 'GR', 'EA'] LOOP
    l := t.call(t.u(a), 'public.relay_list()');
    PERFORM t.ok(NOT (l::text ~ '(MARKER|excerpt|sender_label)'), 'LEAK list ' || a);
    l := t.call(t.u(a), 'public.relay_my_access()');
    PERFORM t.ok(NOT (l::text ~ '(MARKER|TITLEMARK)'), 'LEAK my_access ' || a);
  END LOOP;
  l := t.call(t.u('EA'), 'public.relay_list_assigners()');
  PERFORM t.ok(NOT (l::text ~ '(MARKER|TITLEMARK|SUMMARYMARK)'), 'LEAK assigners');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.relay_events WHERE payload::text ~ '(MARKER|TITLEMARK|SUMMARYMARK|TEAMEDITMARK|اتصل بالعميل|45879)'), 'LEAK events text');
  FOR h IN SELECT excerpt_sha256 FROM public.relay_source_snapshots LOOP
    PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.relay_events WHERE payload::text LIKE '%' || h || '%'), 'LEAK events hash');
  END LOOP;
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.relay_events WHERE kind = 'updated'
                         AND payload -> 'fields' ->> 'title' = public._relay_hash('TEAMEDITMARK')), 'M5 digest after 074');
  -- الحجب: نهائي، وتعديل التصنيف بعده لا يعيد شيئًا
  rid := (SELECT v::uuid FROM t.saved WHERE k = 'CAT');
  SELECT id INTO sid FROM public.relay_sources WHERE record_id = rid AND chat_message_id = '3e550000-0000-4000-8000-0000000000a3';
  PERFORM t.call(t.u('S1'), format('public.relay_redact_source(%L::uuid)', sid));
  PERFORM t.call(t.u('S1'), format('public.relay_update(%L::uuid, %L::jsonb, %s)', rid, '{"category":"other"}', t.ver(rid)));
  g := t.get(t.u('S1'), rid);
  PERFORM t.ok(g -> 'sources' -> 1 -> 'redacted' ->> 'reason' = 'manual' AND NOT (g::text LIKE '%MARKERA3%')
               AND (SELECT excerpt IS NULL FROM public.relay_source_snapshots WHERE source_id = sid), 'REDACT final');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS C3/LEAK/REDACT بعد 074: المالك بلا وصول للمحادثة يرى placeholder ويرى المقتطف فقط بعد إسناد المحادثة له؛ المنح لا يكشف مقتطفًا؛ لا نص ولا بصمة في list/my_access/list_assigners/events؛ الحجب نهائي بعد التعديل';
END $$;

-- الاحتفاظ (C5) بعد 074: إغلاق ثم إرجاع الساعة
DO $$
DECLARE rid uuid := (SELECT v::uuid FROM t.saved WHERE k = 'CAT'); g jsonb; n int;
BEGIN
  PERFORM t.call(t.u('S1'), format('public.relay_transition(%L::uuid, ''resolved'', ''{"resolution_note":"تم"}'', %s)', rid, t.ver(rid)));
  UPDATE public.relay_records SET closed_at = now() - interval '8760 hours' - interval '1 minute' WHERE id = rid;
  g := t.get(t.u('S1'), rid);
  PERFORM t.ok((g -> 'sources' -> 0 ->> 'retention_expired')::boolean AND NOT (g::text LIKE '%MARKERA1%')
               AND g -> 'record' ->> 'category' = 'other', 'C5 mask ' || g::text);
  n := public.relay_retention_sweep();
  PERFORM t.ok(n >= 1 AND (SELECT count(*) FROM public.relay_source_snapshots WHERE record_id = rid AND excerpt IS NOT NULL) = 0, 'C5 sweep');
  -- لا تعديل على سجل مغلق (ومنه التصنيف)
  PERFORM t.ok(t.err(t.u('S1'), format('public.relay_update(%L::uuid, %L::jsonb, %s)', rid, '{"category":"other"}', t.ver(rid))) = '55000', 'C5 closed update');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS C5 بعد 074: مغلق 8760h+1m ⇒ retention_expired قبل الكنس والكنس يمسح النص؛ التصنيف يبقى؛ السجل المغلق لا يُعدَّل';
END $$;

-- ── C9: انحدار المرحلة B ─────────────────────────────────────────────────────
DO $$
DECLARE rid uuid; r jsonb; c text; vv int;
BEGIN
  -- التكرار الآمن (P3 لا يمس إعادة التشغيل)
  r := t.call(t.u('EA'), t.create_sql('IDEM', array['3e550000-0000-4000-8000-0000000000a1']::uuid[], jsonb_build_object('owner_id', t.u('S1'), 'category', 'other')));
  rid := (r -> 'record' ->> 'id')::uuid;
  r := t.call(t.u('EA'), t.create_sql('IDEM', array['3e550000-0000-4000-8000-0000000000a1']::uuid[], jsonb_build_object('owner_id', t.u('S1'), 'category', 'other')));
  PERFORM t.ok((r ->> 'replayed')::boolean AND (r -> 'record' ->> 'id')::uuid = rid, 'B idem replay');
  PERFORM t.ok(t.err(t.u('EA'), t.create_sql('IDEM', '{}', '{"category":"complaint"}')) = '23505', 'B idem conflict');
  -- النسخ
  PERFORM t.ok(t.err(t.u('S1'), format('public.relay_update(%L::uuid, ''{"priority":1}'', %s)', rid, t.ver(rid) + 3)) = '40001', 'B version');
  PERFORM t.ok(t.err(t.u('S1'), format('public.relay_assign(%L::uuid, null, null, %s)', rid, t.ver(rid) + 3)) = '40001', 'B assign version');
  -- الانتقالات كما هي: المالك أو المشرف؛ handover مطفأ
  vv := t.ver(rid);
  PERFORM t.ok(t.err(t.u('S1'), format('public.relay_transition(%L::uuid, ''in_progress'', ''{}'', %s)', rid, vv)) = 'ok', 'B transition owner');
  PERFORM t.ok(t.err(t.u('EA'), format('public.relay_transition(%L::uuid, ''ready_for_handover'', ''{}'', %s)', rid, t.ver(rid))) = '0A000', 'B handover off');
  PERFORM t.ok(t.err(t.u('S1'), t.create_sql('HO', '{}', '{"kind":"handover"}')) = '0A000', 'B handover create');
  -- M1: نص حساس يتطلب sensitive_ack، والحدث بلا فئة
  INSERT INTO public.chat_messages (id, session_id, sender_id, message_text, is_admin_reply, created_at)
  VALUES ('3e550000-0000-4000-8000-0000000000a9', '5e550000-0000-4000-8000-0000000000a1', t.u('C1'),
          'رقم الكارت 4111 1111 1111 1111', false, now());
  c := t.errfull(t.u('S1'), t.create_sql('SENS', array['3e550000-0000-4000-8000-0000000000a9']::uuid[]));
  PERFORM t.ok(c LIKE '22023|%sensitive_content%', 'B M1 ' || c);
  PERFORM t.ok(t.err(t.u('S1'), t.create_sql('SENS', array['3e550000-0000-4000-8000-0000000000a9']::uuid[], '{"sensitive_ack":true}')) = 'ok', 'B M1 ack');
  -- مطفأ ⇒ كل الـRPC الأصلية 0A000
  UPDATE public.relay_workspaces SET enabled = false WHERE kind = 'platform';
  PERFORM t.ok(t.err(t.u('EA'), 'public.relay_list()') = '0A000' AND t.err(t.u('EA'), t.create_sql('OFF', '{}')) = '0A000', 'B off');
  UPDATE public.relay_workspaces SET enabled = true WHERE kind = 'platform';
  -- الأدوار: عميل/محظور/المالك في customer ⇒ 42501
  PERFORM t.ok(t.err(t.u('C1'), 'public.relay_list()') = '42501' AND t.err(t.u('BN'), 'public.relay_list()') = '42501', 'B roles');
  PERFORM t.ok(t.matrix() = (SELECT v FROM t.saved WHERE k = 'matrix_before'), 'B inbox matrix');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS B-regression: التكرار الآمن (replay/23505)، النسخ 40001، الانتقالات وhandover 0A000، M1 sensitive_ack، المفتاح المطفأ 0A000، الأدوار، ومصفوفة الصندوق كما هي';
END $$;

-- ============================================================================
-- ② إعادة التشغيل والتراجع وإعادة التطبيق
-- ============================================================================
\i migrations/074_relay_phase_c.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok((SELECT count(*) FROM public.relay_assigners WHERE user_id = t.u('GR') AND revoked_at IS NULL) = 1
               AND EXISTS (SELECT 1 FROM public.relay_records WHERE category IS NOT NULL), 'RERUN data kept');
  RAISE NOTICE 'PASS RERUN: إعادة تشغيل 074 تنجح وتحتفظ بالمنح والتصنيفات';
END $$;

\set rollback_sql `cat migrations/_rollback/074_relay_phase_c.down.sql`
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
  PERFORM t.ok(to_regclass('public.relay_assigners') IS NOT NULL AND to_regprocedure('public.relay_my_access()') IS NOT NULL, 'RB nothing removed');
  RAISE NOTICE 'PASS RB-a: التراجع يرفض لو فيه تصنيفات أو منح بلا relay.rollback_discard_data=on';
END $$;
INSERT INTO t.saved SELECT 'records_before_rb', (SELECT count(*) FROM public.relay_records)::text;
INSERT INTO t.saved SELECT 'chat_before_rb', t.chat_digest();
SET relay.rollback_discard_data = 'on';
\i migrations/_rollback/074_relay_phase_c.down.sql
RESET relay.rollback_discard_data;
DO $$
BEGIN
  PERFORM t.ok(t.fn_digest() = (SELECT v FROM t.saved WHERE k = 'fn_073'), 'RB functions identical to 073');
  -- relay_assign = نص 073 حرفيًا ما عدا شرط السماح (coalesce + سطر تعليق)
  PERFORM t.ok(t.assign_def() = replace((SELECT v FROM t.saved WHERE k = 'assign_073'),
$a$  if not (public._relay_is_supervisor() or r.owner_id = auth.uid()
          or (r.owner_id is null and p_owner = auth.uid() and p_team is not distinct from r.team_id)) then$a$,
$b$  -- الاستثناء الوحيد عن نص 073: coalesce يقفل ثغرة NULL (سجل بلا مالك كان يُسند لأي حد).
  if not coalesce(public._relay_is_supervisor() or r.owner_id = auth.uid()
          or (r.owner_id is null and p_owner = auth.uid() and p_team is not distinct from r.team_id), false) then$b$),
    'RB relay_assign = 073 + coalesce only');
  PERFORM t.ok(t.assign_def() <> (SELECT v FROM t.saved WHERE k = 'assign_073'), 'RB relay_assign hole fix present');
  PERFORM t.ok(to_regclass('public.relay_assigners') IS NULL AND to_regprocedure('public.relay_my_access()') IS NULL
               AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'relay_records' AND column_name = 'category'), 'RB objects gone');
  PERFORM t.ok((SELECT count(*) FROM public.relay_records)::text = (SELECT v FROM t.saved WHERE k = 'records_before_rb'), 'RB records kept');
  PERFORM t.ok(t.chat_digest() = (SELECT v FROM t.saved WHERE k = 'chat_before_rb'), 'RB chat untouched');
  -- قواعد المرحلة B رجعت
  PERFORM t.ok(t.err(t.u('S1'), t.create_sql('RB-B', '{}', jsonb_build_object('owner_id', t.u('S2')))) = 'ok', 'RB phase B rule back');
  -- لكن ثغرة NULL لا ترجع مع التراجع
  PERFORM t.ok(t.err(t.u('S1'), t.assign_sql(t.mk(t.u('S1'), 'RB-HOLE', '{}', '{}'), t.u('S2'), NULL)) = '42501', 'RB hole stays closed');
  PERFORM t.ok((SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND (p.proname LIKE 'relay\_%' OR p.proname LIKE '\_relay\_%')
                   AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) = 11, 'RB 11 RPCs');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS RB-b: بعد التراجع الدوال مطابقة لنص 073 حرفيًا (relay_assign + إغلاق ثغرة NULL فقط)، لا جدول منح ولا عمود تصنيف، السجلات باقية، الشات لم يُلمس، وقواعد المرحلة B رجعت';
END $$;
\i migrations/074_relay_phase_c.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok(t.err(t.u('S1'), t.create_sql('RB-C', '{}', jsonb_build_object('owner_id', t.u('S2')))) = '42501', 'RB re-apply P3');
  PERFORM t.ok(t.call(t.u('EA'), 'public.relay_list_assigners()') = '[]'::jsonb, 'RB re-apply empty grants');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS RB-c: إعادة تطبيق 074 بعد التراجع تنجح وقيد الإسناد يرجع';
END $$;

\echo 'ALL relay-phase-c tests passed'
