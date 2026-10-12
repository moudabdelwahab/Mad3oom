-- ============================================================================
-- مدعوم — الاستمرارية: تاريخ الإغلاق وإعادة الفتح المنضبطة (079) على نسخة مطابقة
-- لشكل الإنتاج (073 + 074 + 076 + 077 + 078)
--
--   ⓪ سجلات اتقفلت واتفتحت قبل 079 (لإثبات ترحيل التاريخ)
--   ① 079: الترحيل، الإغلاق يكتب تاريخًا، إعادة الفتح لا تمحو، الموعد عند إعادة الفتح،
--      الصلاحيات، التكرار والتزامن، الثبات، الاحتفاظ، الأغلفة
--   ② إعادة التشغيل، التراجع (رفض مع تاريخ سيضيع، النص قبل 079 حرفيًا)، إعادة التطبيق
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
SET check_function_bodies = off;
CREATE FUNCTION t.ver2(p_rec uuid) RETURNS int LANGUAGE plpgsql AS $$
begin return (select version from public.continuity_records where id = p_rec); end $$;
CREATE FUNCTION t.mk2(p uuid, p_key text, p_extra jsonb DEFAULT '{}') RETURNS uuid LANGUAGE sql AS $$
  select (t.call(p, format('public.continuity_create(%L::jsonb)', t.req(p_key, array['3e550000-0000-4000-8000-0000000000a1']::uuid[], p_extra))) -> 'record' ->> 'id')::uuid $$;
CREATE FUNCTION t.tr(p uuid, p_rec uuid, p_to text, p_details jsonb) RETURNS jsonb LANGUAGE sql AS $$
  select t.call(p, format('public.continuity_transition(%L::uuid, %L, %L::jsonb, %s)', p_rec, p_to, p_details, t.ver2(p_rec))) $$;
CREATE FUNCTION t.tr_err(p uuid, p_rec uuid, p_to text, p_details jsonb) RETURNS text LANGUAGE sql AS $$
  select t.err(p, format('public.continuity_transition(%L::uuid, %L, %L::jsonb, %s)', p_rec, p_to, p_details, t.ver2(p_rec))) $$;
CREATE FUNCTION t.closures(p_rec uuid) RETURNS jsonb LANGUAGE sql AS $$
  select coalesce(jsonb_agg(to_jsonb(c) - 'id' - 'record_id' - 'workspace_id' order by c.seq), '[]') from public.continuity_closures c where c.record_id = p_rec $$;
CREATE FUNCTION t.tomorrow(p_hour int) RETURNS jsonb LANGUAGE sql AS $$
  select jsonb_build_object('at', to_char((now() at time zone 'Africa/Cairo')::date + 1, 'YYYY-MM-DD') || 'T' || lpad(p_hour::text, 2, '0') || ':00:00',
                            'tz', 'Africa/Cairo') $$;
RESET check_function_bodies;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ============================================================================
-- ⓪ 073 → 078، وسجلات قبل 079
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
\i migrations/078_continuity_policies.sql
SET search_path = public, extensions;

-- PA: اتحل ← اتفتح ← اتحل (مقفول الآن) · PB: اتلغى (مقفول) · PC: نشط لم يُقفل أبدًا
DO $$
DECLARE a uuid; b uuid; c uuid;
BEGIN
  PERFORM t.ctx('admin');
  a := t.mk2(t.u('S1'), 'PA', jsonb_build_object('owner_id', t.u('S1')));
  PERFORM t.tr(t.u('S1'), a, 'resolved', '{"resolution_note":"PREOLD حل قديم"}');
  PERFORM t.tr(t.u('S1'), a, 'open', '{"reason":"PREREASON رجع"}');
  PERFORM t.tr(t.u('S1'), a, 'resolved', '{"resolution_note":"PRENOW حل حالي"}');
  b := t.mk2(t.u('S1'), 'PB', jsonb_build_object('owner_id', t.u('S1')));
  PERFORM t.tr(t.u('S1'), b, 'cancelled', '{"cancel_reason":"PRECANCEL ملغي"}');
  c := t.mk2(t.u('S1'), 'PC', jsonb_build_object('owner_id', t.u('S1')));
  INSERT INTO t.saved VALUES ('PA', a::text), ('PB', b::text), ('PC', c::text);
  PERFORM t.act(NULL);
END $$;
INSERT INTO t.saved SELECT 'events_before', (SELECT md5(string_agg(md5(to_jsonb(e)::text), ',' ORDER BY e.id)) FROM public.continuity_events e);
INSERT INTO t.saved SELECT 'transition_078', pg_get_functiondef('public.continuity_transition(uuid,text,jsonb,integer)'::regprocedure);
INSERT INTO t.saved SELECT 'full_078', pg_get_functiondef('public._continuity_full(uuid,boolean)'::regprocedure);

-- ============================================================================
-- ① تطبيق 079
-- ============================================================================
\i migrations/079_continuity_reopen_lifecycle.sql
SET search_path = public, extensions;

-- L1: ترحيل التاريخ من الأحداث
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'PA'); b uuid := (SELECT v::uuid FROM t.saved WHERE k = 'PB');
  c uuid := (SELECT v::uuid FROM t.saved WHERE k = 'PC'); h jsonb;
BEGIN
  h := t.closures(a);
  PERFORM t.ok(jsonb_array_length(h) = 2 AND (SELECT closure_seq FROM public.continuity_records WHERE id = a) = 2, 'L1 PA two closures');
  PERFORM t.ok(h -> 0 ->> 'closed_status' = 'resolved' AND (h -> 0 ->> 'backfilled')::boolean AND h -> 0 ->> 'reopened_at' IS NOT NULL
               AND h -> 0 -> 'resolution_note' = 'null'::jsonb AND (h -> 0 ->> 'reopened_by')::uuid = t.u('S1'), 'L1 PA seq1 backfilled without text: ' || (h -> 0)::text);
  PERFORM t.ok(h -> 1 ->> 'resolution_note' = 'PRENOW حل حالي' AND NOT (h -> 1 ->> 'backfilled')::boolean
               AND h -> 1 ->> 'reopened_at' IS NULL AND (h -> 1 ->> 'closed_by')::uuid = t.u('S1'), 'L1 PA seq2 current with text');
  h := t.closures(b);
  PERFORM t.ok(jsonb_array_length(h) = 1 AND h -> 0 ->> 'cancel_reason' = 'PRECANCEL ملغي' AND h -> 0 -> 'resolution_note' = 'null'::jsonb, 'L1 PB');
  PERFORM t.ok(t.closures(c) = '[]'::jsonb AND (SELECT closure_seq FROM public.continuity_records WHERE id = c) = 0, 'L1 PC none');
  PERFORM t.ok((SELECT md5(string_agg(md5(to_jsonb(e)::text), ',' ORDER BY e.id)) FROM public.continuity_events e)
               = (SELECT v FROM t.saved WHERE k = 'events_before'), 'L1 events untouched');
  RAISE NOTICE 'PASS L1: الترحيل يبني الإغلاقات من الأحداث بالترتيب: الإغلاق الحالي بنصه من صف السجل، والسابق المعاد فتحه بلا نص (backfilled)، ولا يُمس أي حدث';
END $$;

-- L2: الإغلاق الحالي مرئي في السجل لمن يراه؛ إعادة الفتح تحفظ التاريخ وتنتقل إلى open
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'PA'); g jsonb; h jsonb; ev bigint;
BEGIN
  PERFORM t.ctx('admin');
  g := t.call(t.u('S1'), format('public.continuity_get(%L::uuid)', a));
  PERFORM t.ok(jsonb_array_length(g -> 'closures') = 2 AND g -> 'closures' -> 0 ->> 'seq' = '2'
               AND g -> 'closures' -> 0 ->> 'resolution_note' = 'PRENOW حل حالي', 'L2 closures newest first in get');
  PERFORM t.ok(t.err(t.u('S2'), format('public.continuity_get(%L::uuid)', a)) = 'P0002', 'L2 history only for record viewers');
  ev := (SELECT max(id) FROM public.continuity_events);
  -- الموعد مستقبلي ⇒ إعادة الفتح بلا موعد جديد مسموحة، والموعد يبقى
  g := t.tr(t.u('S1'), a, 'open', '{"reason":"REOPEN1 العميل رجع"}');
  PERFORM t.ok(g -> 'record' ->> 'status' = 'open' AND g -> 'record' -> 'closed_at' = 'null'::jsonb
               AND g -> 'record' -> 'resolution_note' = 'null'::jsonb, 'L2 open, row cleared as before');
  h := t.closures(a);
  PERFORM t.ok(h -> 1 ->> 'resolution_note' = 'PRENOW حل حالي' AND h -> 1 ->> 'reopen_reason' = 'REOPEN1 العميل رجع'
               AND (h -> 1 ->> 'reopened_by')::uuid = t.u('S1') AND h -> 1 ->> 'reopened_at' IS NOT NULL, 'L2 closure kept with reopen');
  PERFORM t.ok((SELECT count(*) FROM public.continuity_events WHERE id > ev AND kind = 'reopened') = 1
               AND (SELECT (payload ->> 'closure_seq')::int FROM public.continuity_events WHERE id > ev AND kind = 'reopened') = 2
               AND NOT ((SELECT payload::text FROM public.continuity_events WHERE id > ev AND kind = 'reopened') LIKE '%REOPEN1%'),
               'L2 one event, no free text');
  -- تعديل بعد إعادة الفتح ثم إغلاق جديد
  PERFORM t.call(t.u('S1'), format('public.continuity_update(%L::uuid, ''{"next_action":"اتصال تاني"}''::jsonb, %s)', a, t.ver2(a)));
  g := t.tr(t.u('S1'), a, 'cancelled', '{"cancel_reason":"CANCEL3 خلاص"}');
  h := t.closures(a);
  PERFORM t.ok(jsonb_array_length(h) = 3 AND h -> 2 ->> 'closed_status' = 'cancelled' AND h -> 2 ->> 'cancel_reason' = 'CANCEL3 خلاص'
               AND (SELECT closure_seq FROM public.continuity_records WHERE id = a) = 3
               AND h -> 1 ->> 'resolution_note' = 'PRENOW حل حالي', 'L2 third closure, earlier kept');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS L2: الإغلاق يكتب صفًا في التاريخ؛ إعادة الفتح تملأ reopened_* ولا تمحو نص الحل؛ الحالة open؛ حدث واحد بلا نص؛ التعديل وإعادة الإغلاق تعمل والتاريخ يتراكم';
END $$;

-- L3: الموعد عند إعادة الفتح (§15.1)
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'PA'); d uuid; g jsonb; ev bigint;
BEGIN
  PERFORM t.ctx('admin');
  -- موعد فات (تعديل مباشر كمالك خارق لمحاكاة مرور الوقت)
  UPDATE public.continuity_records SET due_at = now() - interval '2 hours' WHERE id = a;
  PERFORM t.ok(t.tr_err(t.u('S1'), a, 'open', '{"reason":"بدون موعد"}') = '22023', 'L3 past due requires new due');
  PERFORM t.ok(t.errfull(t.u('S1'), format('public.continuity_transition(%L::uuid, ''open'', ''{"reason":"x"}''::jsonb, %s)', a, t.ver2(a)))
               LIKE '%due_required_on_reopen%', 'L3 reason code');
  -- موعد خلال 5 دقائق: نفس الشيء
  UPDATE public.continuity_records SET due_at = now() + interval '3 minutes' WHERE id = a;
  PERFORM t.ok(t.tr_err(t.u('S1'), a, 'open', '{"reason":"قريب جدًا"}') = '22023', 'L3 due within 5 min');
  -- موعد جديد في الماضي ⇒ مرفوض بقاعدة الإنشاء
  PERFORM t.ok(t.tr_err(t.u('S1'), a, 'open', jsonb_build_object('reason', 'x', 'due', jsonb_build_object('at', '2020-01-01T10:00:00', 'tz', 'Africa/Cairo'))) = '22023', 'L3 new due in past');
  -- موعد جديد قبل دقائق (مسموح عند الإنشاء بهامش 5 دقائق) ⇒ مرفوض عند إعادة الفتح
  PERFORM t.ok(t.errfull(t.u('S1'), format('public.continuity_transition(%L::uuid, ''open'', %L::jsonb, %s)', a,
                 jsonb_build_object('reason', 'x', 'due', jsonb_build_object('tz', 'Africa/Cairo',
                   'at', to_char((now() - interval '2 minutes') AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD"T"HH24:MI:SS'))), t.ver2(a)))
               LIKE '%in_past%', 'L3 new due minutes ago refused on reopen');
  ev := (SELECT max(id) FROM public.continuity_events);
  g := t.tr(t.u('S1'), a, 'open', jsonb_build_object('reason', 'بموعد جديد', 'due', t.tomorrow(10)));
  PERFORM t.ok(g -> 'record' ->> 'status' = 'open' AND (g -> 'record' ->> 'due_at')::timestamptz > now() + interval '1 hour'
               AND g -> 'record' ->> 'due_tz' = 'Africa/Cairo', 'L3 new due applied');
  PERFORM t.ok((SELECT payload -> 'due' ->> 'to' FROM public.continuity_events WHERE id > ev AND kind = 'reopened') IS NOT NULL, 'L3 due change in event');
  -- مشكلة (issue) بلا موعد: إعادة الفتح بلا موعد مسموحة
  d := (t.call(t.u('S1'), format('public.continuity_create(%L::jsonb)', jsonb_build_object('contract_version', 1, 'idempotency_key', md5('ISS')::uuid,
          'kind', 'issue', 'title', 'مشكلة', 'issue', jsonb_build_object('problem', 'تعطل'), 'owner_id', t.u('S1')))) -> 'record' ->> 'id')::uuid;
  PERFORM t.tr(t.u('S1'), d, 'resolved', '{"resolution_note":"تم"}');
  PERFORM t.ok(t.tr_err(t.u('S1'), d, 'open', '{"reason":"رجعت"}') = 'ok', 'L3 issue reopen without due');
  INSERT INTO t.saved VALUES ('ISS', d::text);
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS L3: متابعة موعدها فات أو خلال 5 دقائق لا تُفتح بلا موعد جديد (due_required_on_reopen)؛ الموعد الجديد بقواعد الإنشاء ومستقبلي فعلًا (بلا هامش الدقائق الخمس) ويظهر في الحدث؛ المشكلة بلا موعد تُفتح عادي';
END $$;

-- L4: الصلاحيات
DO $$
DECLARE b uuid := (SELECT v::uuid FROM t.saved WHERE k = 'PB'); r text;
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.tr_err(t.u('S2'), b, 'open', jsonb_build_object('reason', 'x', 'due', t.tomorrow(11))) = 'P0002', 'L4 other support: not found');
  PERFORM t.ok(t.tr_err(t.u('GR'), b, 'open', jsonb_build_object('reason', 'x', 'due', t.tomorrow(11))) = 'P0002', 'L4 assigner without access');
  PERFORM t.ok(t.tr_err(t.u('C1'), b, 'open', jsonb_build_object('reason', 'x', 'due', t.tomorrow(11))) = '42501', 'L4 customer');
  PERFORM t.ok(t.tr_err(t.u('BN'), b, 'open', jsonb_build_object('reason', 'x', 'due', t.tomorrow(11))) = '42501', 'L4 banned');
  BEGIN
    PERFORM t.call_api(t.u('EA'), format('public.continuity_transition(%L::uuid, ''open'', %L::jsonb, %s)', b,
                       jsonb_build_object('reason', 'x', 'due', t.tomorrow(11)), t.ver2(b)));
    RAISE EXCEPTION 'FAIL L4 supervisor via api reopened';
  EXCEPTION WHEN others THEN
    IF sqlerrm LIKE 'FAIL%' THEN RAISE; END IF;
  END;
  PERFORM t.ok(t.err_stmt(t.u('S1'), 'select * from public.continuity_closures') = '42501', 'L4 no direct read');
  PERFORM t.ok(t.err_stmt(t.u('S1'), format('insert into public.continuity_closures (record_id, workspace_id, seq, closed_status, closed_at) select id, workspace_id, 99, ''resolved'', now() from public.continuity_records where id = %L', b)) = '42501', 'L4 no direct insert');
  PERFORM t.ok((SELECT status FROM public.continuity_records WHERE id = b) = 'cancelled', 'L4 nothing changed');
  -- المشرف (أصلي) يعيد الفتح
  PERFORM t.ok(t.tr_err(t.u('EA'), b, 'open', jsonb_build_object('reason', 'المشرف', 'due', t.tomorrow(12))) = 'ok', 'L4 supervisor native');
  PERFORM t.ok((t.closures(b) -> 0 ->> 'reopened_by')::uuid = t.u('EA'), 'L4 actor recorded');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS L4: إعادة الفتح للمالك أو المشرف فقط: دعم آخر وصاحب صلاحية إسناد بلا وصول ⇒ P0002، العميل والمحظور ⇒ 42501، المشرف عبر الـAPI مرفوض، لا قراءة ولا إدراج مباشر في التاريخ؛ المشرف الأصلي ينجح ويُسجَّل';
END $$;

-- L5: التكرار والنسخة القديمة
DO $$
DECLARE b uuid := (SELECT v::uuid FROM t.saved WHERE k = 'PB'); v int; n_ev int; n_cl int;
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.tr(t.u('S1'), b, 'resolved', '{"resolution_note":"مرة تانية"}');
  v := t.ver2(b);
  PERFORM t.call(t.u('S1'), format('public.continuity_transition(%L::uuid, ''open'', %L::jsonb, %s)', b,
                 jsonb_build_object('reason', 'أول', 'due', t.tomorrow(13)), v));
  n_ev := (SELECT count(*) FROM public.continuity_events WHERE record_id = b AND kind = 'reopened');
  n_cl := (SELECT count(*) FROM public.continuity_closures WHERE record_id = b AND reopened_at IS NOT NULL);
  -- نفس الطلب بنفس النسخة (إعادة إرسال بعد انقطاع) ⇒ 40001 ولا شيء يُكتب
  PERFORM t.ok(t.err(t.u('S1'), format('public.continuity_transition(%L::uuid, ''open'', %L::jsonb, %s)', b,
                 jsonb_build_object('reason', 'أول', 'due', t.tomorrow(13)), v)) = '40001', 'L5 retry stale');
  PERFORM t.ok((SELECT count(*) FROM public.continuity_events WHERE record_id = b AND kind = 'reopened') = n_ev
               AND (SELECT count(*) FROM public.continuity_closures WHERE record_id = b AND reopened_at IS NOT NULL) = n_cl, 'L5 no duplicates');
  -- إعادة فتح سجل مفتوح ⇒ انتقال غير مسموح
  PERFORM t.ok(t.tr_err(t.u('S1'), b, 'open', '{"reason":"x"}') = '55000', 'L5 open from open');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS L5: إعادة إرسال نفس إعادة الفتح بنفس النسخة ⇒ 40001 بلا حدث ولا صف مكرر؛ open من open ⇒ 55000';
END $$;

-- L6: تزامن حقيقي — جلستان تعيدان فتح نفس السجل بنفس النسخة ⇒ واحدة تنجح
DO $$
DECLARE c uuid := (SELECT v::uuid FROM t.saved WHERE k = 'PC');
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.tr(t.u('S1'), c, 'resolved', '{"resolution_note":"للتزامن"}');
  INSERT INTO t.saved VALUES ('PC_VER', t.ver2(c)::text);
  PERFORM t.act(NULL);
END $$;
SELECT t.dblink_connect('one', format('dbname=%s port=%s host=%s user=postgres', current_database(),
         current_setting('port'), split_part(current_setting('unix_socket_directories'), ',', 1)));
SELECT t.dblink_connect('two', format('dbname=%s port=%s host=%s user=postgres', current_database(),
         current_setting('port'), split_part(current_setting('unix_socket_directories'), ',', 1)));
SELECT t.dblink_exec('one', 'begin');
SELECT t.dblink_exec('one', $q$set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a5'$q$);
SELECT t.dblink_exec('one', $q$set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000a5","role":"authenticated"}'$q$);
SELECT t.dblink_exec('one', 'set local role authenticated');
SELECT x FROM t.dblink('one', format('select (public.continuity_transition(%L::uuid, ''open'', %L::jsonb, %s))->''record''->>''status''',
       (SELECT v FROM t.saved WHERE k = 'PC'), jsonb_build_object('reason', 'one', 'due', t.tomorrow(14)), (SELECT v FROM t.saved WHERE k = 'PC_VER'))) AS r(x text);
SELECT t.dblink_exec('two', $q$set request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a5'$q$);
SELECT t.dblink_exec('two', $q$set request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000a5","role":"authenticated"}'$q$);
SELECT t.dblink_exec('two', 'set role authenticated');
SELECT t.dblink_send_query('two', format($q$do $b$ begin perform public.continuity_transition(%L::uuid, 'open', %L::jsonb, %s); raise notice 'two-ok'; exception when others then raise notice 'two-%%', sqlstate; end $b$;$q$,
       (SELECT v FROM t.saved WHERE k = 'PC'), jsonb_build_object('reason', 'two', 'due', t.tomorrow(15)), (SELECT v FROM t.saved WHERE k = 'PC_VER')));
SELECT pg_sleep(0.5);
SELECT t.dblink_exec('one', 'commit');
SELECT pg_sleep(0.3);
SELECT t.dblink_get_result('two') IS NOT NULL;
SELECT t.dblink_get_result('two') IS NULL;
DO $$
DECLARE c uuid := (SELECT v::uuid FROM t.saved WHERE k = 'PC'); h jsonb;
BEGIN
  h := t.closures(c);
  PERFORM t.ok((SELECT count(*) FROM public.continuity_events WHERE record_id = c AND kind = 'reopened') = 1
               AND jsonb_array_length(h) = 1 AND h -> 0 ->> 'reopen_reason' = 'one', 'L6 exactly one reopen: ' || h::text);
  RAISE NOTICE 'PASS L6: جلستان متزامنتان تعيدان فتح نفس السجل بنفس النسخة ⇒ واحدة فقط تنجح، حدث واحد وصف إغلاق واحد';
END $$;
SELECT t.dblink_disconnect('one');
SELECT t.dblink_disconnect('two');

-- L7: الثبات حتى للمالك الخارق
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'PA');
BEGIN
  BEGIN UPDATE public.continuity_closures SET resolution_note = 'تزوير' WHERE record_id = a AND seq = 2; RAISE EXCEPTION 'FAIL L7 text';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN UPDATE public.continuity_closures SET reopen_reason = 'تزوير' WHERE record_id = a AND reopened_at IS NOT NULL; RAISE EXCEPTION 'FAIL L7 reopen twice';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN UPDATE public.continuity_closures SET reopened_at = NULL WHERE record_id = a; RAISE EXCEPTION 'FAIL L7 un-reopen';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN DELETE FROM public.continuity_closures; RAISE EXCEPTION 'FAIL L7 delete';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN TRUNCATE public.continuity_closures; RAISE EXCEPTION 'FAIL L7 truncate';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'PASS L7: تاريخ الإغلاق لا يُعدَّل نصه ولا يُعاد فتحه مرتين ولا يُلغى ولا يُحذف ولا يُفرَّغ حتى للمالك الخارق';
END $$;

-- L8: الاحتفاظ عند إعادة الفتح: المحجوب يبقى محجوبًا، والمنتهي يُحجب فورًا
DO $$
DECLARE d uuid; g jsonb;
BEGIN
  PERFORM t.ctx('admin');
  d := t.mk2(t.u('S1'), 'RET', jsonb_build_object('owner_id', t.u('S1')));
  PERFORM t.tr(t.u('S1'), d, 'resolved', '{"resolution_note":"قديم"}');
  -- إغلاق منذ أكثر من 365 يومًا (تعديل مباشر)
  ALTER TABLE public.continuity_closures DISABLE TRIGGER trg_continuity_closure_guard;
  UPDATE public.continuity_closures SET closed_at = now() - interval '366 days' WHERE record_id = d;
  ALTER TABLE public.continuity_closures ENABLE TRIGGER trg_continuity_closure_guard;
  UPDATE public.continuity_records SET closed_at = now() - interval '366 days' WHERE id = d;
  g := t.tr(t.u('S1'), d, 'open', jsonb_build_object('reason', 'بعد سنة', 'due', t.tomorrow(9)));
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.continuity_source_snapshots WHERE record_id = d AND redacted_at IS NULL), 'L8 expired redacted on reopen');
  PERFORM t.ok(g -> 'sources' -> 0 -> 'excerpt' = 'null'::jsonb, 'L8 not restored');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS L8: إعادة فتح سجل انتهى احتفاظه تحجب مقتطفاته فورًا ولا ترجعها';
END $$;

-- L9: الغلاف relay_transition يأخذ السلوك الجديد
DO $$
DECLARE d uuid := (SELECT v::uuid FROM t.saved WHERE k = 'ISS'); g jsonb;
BEGIN
  PERFORM t.ctx('admin');
  g := t.call(t.u('S1'), format('public.relay_transition(%L::uuid, ''resolved'', ''{"resolution_note":"عبر الغلاف"}''::jsonb, %s)', d, t.ver2(d)));
  PERFORM t.ok(g -> 'closures' -> 0 ->> 'resolution_note' = 'عبر الغلاف', 'L9 wrapper writes history');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS L9: الغلاف relay_transition يكتب تاريخ الإغلاق ويرجع closures';
END $$;

-- ============================================================================
-- ② إعادة التشغيل، التراجع، إعادة التطبيق
-- ============================================================================
INSERT INTO t.saved SELECT 'closures_count', (SELECT count(*) FROM public.continuity_closures)::text;
\i migrations/079_continuity_reopen_lifecycle.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok((SELECT count(*) FROM public.continuity_closures)::text = (SELECT v FROM t.saved WHERE k = 'closures_count'), 'RERUN no duplicate backfill');
  RAISE NOTICE 'PASS RERUN: إعادة تشغيل 079 لا تكرر الترحيل';
END $$;

-- ترتيب التراجع: تراجع 078 يرفض و079 مطبق (حتى مع إذن حذف البيانات)، ولا يمس شيئًا
\set rollback078_sql `cat migrations/_rollback/078_continuity_policies.down.sql`
SELECT set_config('t.rollback078_sql', 'set continuity.rollback_discard_data = ''on''; ' || :'rollback078_sql', false) IS NOT NULL;
DO $$
DECLARE c text;
BEGIN
  PERFORM t.dblink_connect('rb78', format('dbname=%s port=%s host=%s user=postgres', current_database(),
            current_setting('port'), split_part(current_setting('unix_socket_directories'), ',', 1)));
  BEGIN
    PERFORM t.dblink_exec('rb78', current_setting('t.rollback078_sql'));
    c := 'ok';
  EXCEPTION WHEN others THEN c := sqlerrm;
  END;
  PERFORM t.dblink_disconnect('rb78');
  PERFORM t.ok(c LIKE '%079+%', 'RB-078 refusal: ' || c);
  PERFORM t.ok(to_regclass('public.continuity_policies') IS NOT NULL
               AND to_regprocedure('public.continuity_get_policies()') IS NOT NULL, 'RB-078 nothing removed');
  RAISE NOTICE 'PASS RB-078: تراجع 078 يرفض و079 مطبق (الترتيب: الأحدث أولًا)';
END $$;

\set rollback_sql `cat migrations/_rollback/079_continuity_reopen_lifecycle.down.sql`
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
  PERFORM t.ok(to_regclass('public.continuity_closures') IS NOT NULL, 'RB nothing removed');
  RAISE NOTICE 'PASS RB-a: التراجع يرفض لو فيه تاريخ إغلاق سيضيع بلا continuity.rollback_discard_data=on';
END $$;
SET continuity.rollback_discard_data = 'on';
\i migrations/_rollback/079_continuity_reopen_lifecycle.down.sql
RESET continuity.rollback_discard_data;
DO $$
BEGIN
  PERFORM t.ok(pg_get_functiondef('public.continuity_transition(uuid,text,jsonb,integer)'::regprocedure) = (SELECT v FROM t.saved WHERE k = 'transition_078'), 'RB transition identical');
  PERFORM t.ok(pg_get_functiondef('public._continuity_full(uuid,boolean)'::regprocedure) = (SELECT v FROM t.saved WHERE k = 'full_078'), 'RB full identical');
  PERFORM t.ok(to_regclass('public.continuity_closures') IS NULL AND NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'continuity_records' AND column_name = 'closure_seq'), 'RB objects gone');
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.err(t.u('S1'), 'public.continuity_list(''{}''::jsonb)') = 'ok', 'RB still works');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS RB-b: بعد التراجع continuity_transition و _continuity_full مطابقتان لنصهما قبل 079 حرفيًا، ولا جدول ولا عمود';
END $$;
\i migrations/079_continuity_reopen_lifecycle.sql
SET search_path = public, extensions;
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'PA');
BEGIN
  PERFORM t.ok((SELECT closure_seq FROM public.continuity_records WHERE id = a) >= 1
               AND (SELECT count(*) FROM public.continuity_closures WHERE record_id = a) = (SELECT closure_seq FROM public.continuity_records WHERE id = a),
               'RB-c backfill again consistent');
  RAISE NOTICE 'PASS RB-c: إعادة تطبيق 079 بعد التراجع تعيد بناء التاريخ من الأحداث بشكل متسق';
END $$;

\echo 'ALL continuity-reopen tests passed'
