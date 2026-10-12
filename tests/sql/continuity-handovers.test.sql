-- ============================================================================
-- مدعوم — الاستمرارية: التسليم بقبول المستلم (081) على نسخة مطابقة لشكل الإنتاج
-- (073 → 080). كل ضابط من §14.3 له اختبار:
--
--   H0  قبل التفعيل: لا شيء؛ العلامة مثبتة
--   H1  من يطلب ولمن (المالك/المشرف/صاحب الإسناد؛ مستلم مؤهل؛ سجل نشط؛ طلب واحد)
--   H2  المعلّق لا يمنح وصولًا: حزمة بلا مقتطفات ولا مسارات؛ لا قراءة ولا تعديل للسجل
--   H3  القبول: يعيد التحقق، يغيّر المالك فقط (الفريق كما هو)، بالنسخة التي رآها المستلم
--   H4  الرفض بسبب إلزامي ولا يغيّر شيئًا
--   H5  الإلغاء: صاحب الطلب أو مشرف/صاحب إسناد
--   H6  الإسناد المباشر أو الإغلاق يلغي المعلّق في نفس المعاملة
--   H7  صاحب الطلب فقد صلاحيته ⇒ القبول يلغي ولا ينقل
--   H8  تزامن حقيقي: قبول مقابل إلغاء، وقبول مقابل إسناد
--   H9  الإسناد المباشر بلا تغيير (P3/P4)
--   H10 الثبات، وحذف حساب المستلم
--   H11 مفتاح الإيقاف
--   H12 طلباتي، وتاريخ السجل
--   RERUN، RB
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

ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS file_size_limit bigint, ADD COLUMN IF NOT EXISTS allowed_mime_types text[];

SET check_function_bodies = off;
CREATE FUNCTION t.pol(p_patch jsonb) RETURNS jsonb LANGUAGE sql AS $$
  select t.call(t.u('OW'), format('public.continuity_set_policies(%L::jsonb, %s)', p_patch,
                                  (select version from public.continuity_policies p join public.continuity_workspaces w on w.id = p.workspace_id and w.kind = 'platform'))) $$;
CREATE FUNCTION t.req_sql(p_rec uuid, p_to uuid, p_reason text, p_key text, p_note text DEFAULT NULL) RETURNS text LANGUAGE sql AS $$
  select format('public.continuity_handover_request(%L::uuid, %L::uuid, %L, %L, %s, %L::uuid)',
                p_rec, p_to, p_reason, p_note, t.ver2(p_rec), md5('HO-' || p_key)::uuid) $$;
CREATE FUNCTION t.decide_sql(p_h uuid, p_decision text, p_note text, p_ver int) RETURNS text LANGUAGE sql AS $$
  select format('public.continuity_handover_decide(%L::uuid, %L, %L, %s)', p_h, p_decision, p_note, coalesce(p_ver::text, 'null')) $$;
CREATE FUNCTION t.cancel_sql(p_h uuid, p_note text DEFAULT NULL) RETURNS text LANGUAGE sql AS $$
  select format('public.continuity_handover_cancel(%L::uuid, %L)', p_h, p_note) $$;
CREATE FUNCTION t.owner(p_rec uuid) RETURNS uuid LANGUAGE sql AS $$ select owner_id from public.continuity_records where id = p_rec $$;
CREATE FUNCTION t.evs(p_rec uuid, p_kind text) RETURNS int LANGUAGE sql AS $$
  select count(*)::int from public.continuity_events where record_id = p_rec and kind = p_kind $$;
RESET check_function_bodies;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ============================================================================
-- ⓪ 073 → 080 وسجلات
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
\i migrations/079_continuity_reopen_lifecycle.sql
SET search_path = public, extensions;
\i migrations/080_continuity_attachments.sql
SET search_path = public, extensions;

-- RA: S1 مالك، فريق T1 (فيه S3) · RU: بلا مالك (منشئه S1)
DO $$
DECLARE a uuid; u uuid;
BEGIN
  PERFORM t.ctx('admin');
  a := t.mk2(t.u('S1'), 'RA', jsonb_build_object('owner_id', t.u('S1')));
  PERFORM t.call(t.u('EA'), format('public.continuity_assign(%L::uuid, %L::uuid, %L::uuid, %s)', a, t.u('S1'), t.u('T1'), t.ver2(a)));
  u := t.mk2(t.u('S1'), 'RU', '{}'::jsonb);
  INSERT INTO t.saved VALUES ('RA', a::text), ('RU', u::text);
  PERFORM t.act(NULL);
END $$;
INSERT INTO t.saved SELECT 'chat_before', t.chat_digest();
INSERT INTO t.saved SELECT 'assign_080', pg_get_functiondef('public.continuity_assign(uuid,uuid,uuid,integer)'::regprocedure);
INSERT INTO t.saved SELECT 'transition_080', pg_get_functiondef('public.continuity_transition(uuid,text,jsonb,integer)'::regprocedure);
INSERT INTO t.saved SELECT 'full_080', pg_get_functiondef('public._continuity_full(uuid,boolean)'::regprocedure);

\i migrations/081_continuity_handovers.sql
SET search_path = public, extensions;

-- H0
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA');
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.ok(public._continuity_capability_installed('handovers'), 'H0 installed');
  PERFORM t.ok(t.err(t.u('S1'), t.req_sql(a, t.u('S2'), 'x', 'h0')) = '0A000', 'H0 off');
  PERFORM t.ok(t.err(t.u('S1'), 'public.continuity_handovers_mine()') = '0A000', 'H0 off: mine');
  PERFORM t.pol('{"handovers_enabled": true}');
  PERFORM t.ok((t.call(t.u('S1'), 'public.continuity_my_access()') -> 'capabilities' ->> 'handovers')::boolean, 'H0 enabled for the test');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS H0: التسليم مثبت ومطفأ: لا طلب ولا قراءة قبل التفعيل';
END $$;

-- H1: من يطلب ولمن
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); u uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RU'); g jsonb; v int;
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.err(t.u('S2'), t.req_sql(a, t.u('S3'), 'x', 'h1a')) = 'P0002', 'H1 no access');
  PERFORM t.ok(t.errfull(t.u('S3'), t.req_sql(a, t.u('S2'), 'x', 'h1b')) LIKE '42501%', 'H1 team viewer is not a manager');
  PERFORM t.ok(t.err(t.u('C1'), t.req_sql(a, t.u('S2'), 'x', 'h1c')) = '42501', 'H1 customer');
  PERFORM t.ok(t.err(t.u('BN'), t.req_sql(a, t.u('S2'), 'x', 'h1d')) = '42501', 'H1 banned');
  BEGIN PERFORM t.call_api(t.u('S1'), t.req_sql(a, t.u('S2'), 'x', 'h1e')); RAISE EXCEPTION 'FAIL H1 api';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM t.ok(t.errfull(t.u('S1'), t.req_sql(a, t.u('C1'), 'x', 'h1f')) LIKE '%not_eligible%', 'H1 customer target');
  PERFORM t.ok(t.errfull(t.u('S1'), t.req_sql(a, t.u('BN'), 'x', 'h1g')) LIKE '%not_eligible%', 'H1 banned target');
  PERFORM t.ok(t.errfull(t.u('S1'), t.req_sql(a, t.u('S1'), 'x', 'h1h')) LIKE '%already_owner%', 'H1 self');
  PERFORM t.ok(t.err(t.u('S1'), t.req_sql(a, t.u('S2'), '   ', 'h1i')) = '22023', 'H1 reason required');
  PERFORM t.ok(t.err(t.u('S1'), format('public.continuity_handover_request(%L::uuid, %L::uuid, ''x'', null, %s, %L::uuid)', a, t.u('S2'), t.ver2(a) - 1, md5('stale')::uuid)) = '40001', 'H1 stale version');
  -- سجل بلا مالك: المنشئ لا يطلب، المشرف يطلب
  PERFORM t.ok(t.err(t.u('S1'), t.req_sql(u, t.u('S2'), 'x', 'h1j')) = '42501', 'H1 unassigned: creator cannot');
  -- المالك يطلب
  v := t.ver2(a);
  g := t.call(t.u('S1'), t.req_sql(a, t.u('S2'), 'REASONMARK سفر', 'main', 'NOTEMARK سياق'));
  PERFORM t.ok(g -> 'handover' ->> 'state' = 'pending' AND (g -> 'handover' ->> 'to_owner')::uuid = t.u('S2')
               AND t.owner(a) = t.u('S1') AND t.ver2(a) = v + 1 AND g -> 'record' IS NOT NULL, 'H1 requested, owner unchanged');
  PERFORM t.ok((SELECT payload::text FROM public.continuity_events WHERE record_id = a AND kind = 'handover_requested') NOT LIKE '%MARK%', 'H1 event without text');
  PERFORM t.ok(t.evs(a, 'handover_requested') = 1, 'H1 one event');
  -- تكرار بنفس المفتاح ⇒ نفس الطلب؛ طلب مختلف ⇒ 23505؛ طلب ثانٍ ⇒ 55000
  g := t.call(t.u('S1'), format('public.continuity_handover_request(%L::uuid, %L::uuid, %L, %L, %s, %L::uuid)', a, t.u('S2'), 'REASONMARK سفر', 'NOTEMARK سياق', t.ver2(a), md5('HO-main')::uuid));
  PERFORM t.ok((g -> 'replayed')::boolean AND t.evs(a, 'handover_requested') = 1, 'H1 replay');
  PERFORM t.ok(t.err(t.u('S1'), t.req_sql(a, t.u('S3'), 'آخر', 'main')) = '23505', 'H1 key reuse');
  PERFORM t.ok(t.errfull(t.u('EA'), t.req_sql(a, t.u('S3'), 'ثاني', 'h1k')) LIKE '%handover_pending%', 'H1 one pending per record');
  INSERT INTO t.saved VALUES ('H_MAIN', g -> 'handover' ->> 'id');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS H1: يطلب المالك أو المشرف أو صاحب الإسناد فقط، لمستلم مؤهل غيره، على سجل نشط بالنسخة؛ طلب واحد معلّق؛ تكرار آمن؛ حدث بلا نص';
END $$;

-- H2: المعلّق لا يمنح وصولًا
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); h uuid := (SELECT v::uuid FROM t.saved WHERE k = 'H_MAIN'); g jsonb; m jsonb;
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.err(t.u('S2'), format('public.continuity_get(%L::uuid)', a)) = 'P0002', 'H2 target cannot read the record');
  PERFORM t.ok(t.err(t.u('S2'), format('public.continuity_events_for(%L::uuid, null, 50)', a)) = 'P0002', 'H2 nor its events');
  PERFORM t.ok(t.err(t.u('S2'), format('public.continuity_update(%L::uuid, ''{"title":"x"}''::jsonb, %s)', a, t.ver2(a))) = 'P0002', 'H2 nor edit');
  PERFORM t.ok(t.err(t.u('S2'), format('public.continuity_handovers_for_record(%L::uuid)', a)) = 'P0002', 'H2 nor history');
  g := t.call(t.u('S2'), format('public.continuity_handover_get(%L::uuid)', h));
  PERFORM t.ok(g -> 'record' = 'null'::jsonb AND g -> 'package' ->> 'title' LIKE 'TITLEMARK%'
               AND (g -> 'package' ->> 'source_count')::int = 1 AND (g -> 'package' ->> 'version')::int = t.ver2(a), 'H2 package: ' || (g -> 'package')::text);
  PERFORM t.ok(g::text NOT LIKE '%MARKERA%' AND NOT (g -> 'package') ? 'sources' AND g::text NOT LIKE '%"path"%', 'H2 no excerpt or path');
  PERFORM t.ok(g -> 'handover' ->> 'reason' = 'REASONMARK سفر' AND g -> 'handover' ->> 'context_note' = 'NOTEMARK سياق', 'H2 reason visible to target');
  m := t.call(t.u('S2'), 'public.continuity_handovers_mine()');
  PERFORM t.ok(jsonb_array_length(m -> 'incoming') = 1 AND m -> 'incoming' -> 0 -> 'package' ->> 'id' = a::text AND m::text NOT LIKE '%MARKERA%', 'H2 mine incoming');
  m := t.call(t.u('S1'), 'public.continuity_handovers_mine()');
  PERFORM t.ok(jsonb_array_length(m -> 'outgoing') = 1 AND jsonb_array_length(m -> 'incoming') = 0, 'H2 mine outgoing');
  PERFORM t.ok(t.err(t.u('C1'), format('public.continuity_handover_get(%L::uuid)', h)) = '42501'
               AND t.err(t.u('S1'), format('public.continuity_handover_get(%L::uuid)', h)) = 'ok', 'H2 others');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS H2: الطلب المعلّق لا يمنح المستلم قراءة السجل أو أحداثه أو تعديله؛ يرى حزمة وصفية فقط بلا مقتطفات ولا مسارات';
END $$;

-- H3: القبول
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); h uuid := (SELECT v::uuid FROM t.saved WHERE k = 'H_MAIN'); g jsonb; v int;
BEGIN
  PERFORM t.ctx('admin');
  v := t.ver2(a);
  PERFORM t.ok(t.err(t.u('S3'), t.decide_sql(h, 'accept', null, v)) = 'P0002', 'H3 not the target');
  PERFORM t.ok(t.err(t.u('S1'), t.decide_sql(h, 'accept', null, v)) = 'P0002', 'H3 requester cannot accept');
  PERFORM t.ok(t.err(t.u('S2'), t.decide_sql(h, 'accept', null, v - 1)) = '40001' AND t.owner(a) = t.u('S1'), 'H3 stale version: nothing changes');
  PERFORM t.ok(t.err(t.u('S2'), t.decide_sql(h, 'maybe', null, v)) = '22023', 'H3 decision value');
  g := t.call(t.u('S2'), t.decide_sql(h, 'accept', 'تمام', v));
  PERFORM t.ok((g ->> 'accepted')::boolean AND t.owner(a) = t.u('S2')
               AND (SELECT team_id FROM public.continuity_records WHERE id = a) = t.u('T1') AND t.ver2(a) = v + 1
               AND g -> 'record' -> 'record' ->> 'owner_id' = t.u('S2')::text, 'H3 accepted: owner only');
  PERFORM t.ok(t.err(t.u('S2'), format('public.continuity_get(%L::uuid)', a)) = 'ok', 'H3 access after acceptance');
  PERFORM t.ok(t.evs(a, 'handover_accepted') = 1
               AND (SELECT payload::text FROM public.continuity_events WHERE record_id = a AND kind = 'handover_accepted') NOT LIKE '%تمام%', 'H3 event');
  g := t.call(t.u('S2'), t.decide_sql(h, 'accept', null, v + 1));
  PERFORM t.ok((g -> 'replayed')::boolean AND t.evs(a, 'handover_accepted') = 1, 'H3 double accept is idempotent');
  PERFORM t.ok(t.err(t.u('S2'), t.decide_sql(h, 'decline', 'لا', t.ver2(a))) = '55000', 'H3 decided');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS H3: القبول للمستلم وحده بالنسخة التي رآها؛ يغيّر المالك فقط (الفريق كما هو) في نفس المعاملة؛ مرة واحدة';
END $$;

-- H4/H5: الرفض والإلغاء
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); g jsonb; h uuid; v int;
BEGIN
  PERFORM t.ctx('admin');
  -- S2 المالك الآن يطلب لـ S3
  g := t.call(t.u('S2'), t.req_sql(a, t.u('S3'), 'رفض؟', 'h4'));
  h := (g -> 'handover' ->> 'id')::uuid;
  v := t.ver2(a);
  PERFORM t.ok(t.errfull(t.u('S3'), t.decide_sql(h, 'decline', '  ', v)) LIKE '%required%', 'H4 note required');
  g := t.call(t.u('S3'), t.decide_sql(h, 'decline', 'DECLINEMARK مشغول', v));
  PERFORM t.ok(g -> 'handover' ->> 'state' = 'declined' AND t.owner(a) = t.u('S2') AND t.ver2(a) = v + 1, 'H4 declined: owner unchanged');
  PERFORM t.ok((SELECT payload::text FROM public.continuity_events WHERE record_id = a AND kind = 'handover_declined') NOT LIKE '%MARK%', 'H4 event');
  -- إلغاء: صاحب الطلب
  g := t.call(t.u('S2'), t.req_sql(a, t.u('S3'), 'إلغاء', 'h5a'));
  h := (g -> 'handover' ->> 'id')::uuid;
  PERFORM t.ok(t.err(t.u('S3'), t.cancel_sql(h)) = '42501', 'H5 target is a team viewer, not a manager: cannot cancel');
  g := t.call(t.u('S2'), t.cancel_sql(h));
  PERFORM t.ok(g -> 'handover' ->> 'cancel_cause' = 'initiator' AND t.owner(a) = t.u('S2'), 'H5 initiator');
  -- إلغاء: مشرف
  g := t.call(t.u('S2'), t.req_sql(a, t.u('S1'), 'مشرف', 'h5b'));
  h := (g -> 'handover' ->> 'id')::uuid;
  g := t.call(t.u('EA'), t.cancel_sql(h, 'مش لازم'));
  PERFORM t.ok(g -> 'handover' ->> 'cancel_cause' = 'supervisor', 'H5 supervisor');
  PERFORM t.ok(t.err(t.u('S1'), t.decide_sql(h, 'accept', null, t.ver2(a))) = '55000' AND t.owner(a) = t.u('S2'), 'H5 cancelled cannot be accepted');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS H4/H5: الرفض بسبب ولا يغيّر الملكية؛ الإلغاء لصاحب الطلب أو المشرف فقط؛ الملغى لا يُقبل';
END $$;

-- H6: الإسناد المباشر والإغلاق يلغيان المعلّق
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); g jsonb; h uuid;
BEGIN
  PERFORM t.ctx('admin');
  g := t.call(t.u('S2'), t.req_sql(a, t.u('S1'), 'H6', 'h6a'));
  h := (g -> 'handover' ->> 'id')::uuid;
  PERFORM t.call(t.u('EA'), format('public.continuity_assign(%L::uuid, %L::uuid, %L::uuid, %s)', a, t.u('S3'), t.u('T1'), t.ver2(a)));
  PERFORM t.ok((SELECT state || '/' || cancel_cause FROM public.continuity_handovers WHERE id = h) = 'cancelled/reassigned'
               AND t.owner(a) = t.u('S3'), 'H6 reassigned');
  g := t.call(t.u('S3'), t.req_sql(a, t.u('S1'), 'H6b', 'h6b'));
  h := (g -> 'handover' ->> 'id')::uuid;
  PERFORM t.tr(t.u('S3'), a, 'resolved', '{"resolution_note":"تم"}');
  PERFORM t.ok((SELECT state || '/' || cancel_cause FROM public.continuity_handovers WHERE id = h) = 'cancelled/record_closed', 'H6 closed');
  PERFORM t.ok(t.errfull(t.u('S3'), t.req_sql(a, t.u('S1'), 'مقفول', 'h6c')) LIKE '55000%', 'H6 closed: no request');
  PERFORM t.tr(t.u('S3'), a, 'open', jsonb_build_object('reason', 'رجع', 'due', t.tomorrow(10)));
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS H6: الإسناد المباشر أو إغلاق السجل يلغي الطلب المعلّق في نفس المعاملة بسبب مسجّل';
END $$;

-- H7: صاحب الطلب فقد صلاحيته
DO $$
DECLARE u uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RU'); g jsonb; h uuid;
BEGIN
  PERFORM t.ctx('admin');
  g := t.call(t.u('EA'), t.req_sql(u, t.u('S2'), 'من المشرف', 'h7'));
  h := (g -> 'handover' ->> 'id')::uuid;
  PERFORM t.act(NULL);   -- سحب السلطة من خارج أي جلسة مستخدم (كما يفعل الترحيل/المالك)
  DELETE FROM public.platform_authority WHERE user_id = t.u('EA');
  PERFORM t.ctx('admin');
  g := t.call(t.u('S2'), t.decide_sql(h, 'accept', null, t.ver2(u)));
  PERFORM t.ok(NOT (g ->> 'accepted')::boolean AND g -> 'handover' ->> 'cancel_cause' = 'requester_lost_authority'
               AND t.owner(u) IS NULL, 'H7 lost authority: cancelled, not transferred');
  PERFORM t.act(NULL);
  INSERT INTO public.platform_authority (user_id, level) VALUES (t.u('EA'), 'elevated_admin');
  RAISE NOTICE 'PASS H7: لو صاحب الطلب لم يعد المالك أو مشرفًا أو صاحب إسناد، القبول يلغي الطلب ولا ينقل الملكية';
END $$;

-- H8a: تزامن — قبول (جلسة 1) مقابل إلغاء (جلسة 2) ⇒ نتيجة واحدة
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); g jsonb;
BEGIN
  PERFORM t.ctx('admin');
  g := t.call(t.u('S3'), t.req_sql(a, t.u('S1'), 'H8a', 'h8a'));
  INSERT INTO t.saved VALUES ('H8A', g -> 'handover' ->> 'id'), ('H8A_VER', t.ver2(a)::text);
  PERFORM t.act(NULL);
END $$;
CREATE FUNCTION t.conn(p_name text, p_user uuid, p_local boolean) RETURNS void LANGUAGE plpgsql AS $$
begin
  perform t.dblink_connect(p_name, format('dbname=%s port=%s host=%s user=postgres', current_database(),
            current_setting('port'), split_part(current_setting('unix_socket_directories'), ',', 1)));
  if p_local then perform t.dblink_exec(p_name, 'begin'); end if;
  perform t.dblink_exec(p_name, format('set %s request.jwt.claim.sub = %L', case when p_local then 'local' else '' end, p_user));
  perform t.dblink_exec(p_name, format('set %s request.jwt.claims = %L', case when p_local then 'local' else '' end,
                                       jsonb_build_object('sub', p_user, 'role', 'authenticated')::text));
  perform t.dblink_exec(p_name, format('set %s role authenticated', case when p_local then 'local' else '' end));
end $$;
SELECT t.conn('one', t.u('S1'), true);
SELECT x FROM t.dblink('one', 'select (' || t.decide_sql((SELECT v::uuid FROM t.saved WHERE k = 'H8A'), 'accept', null,
                                                         (SELECT v::int FROM t.saved WHERE k = 'H8A_VER')) || ')->''handover''->>''state''') AS r(x text);
SELECT t.conn('two', t.u('S3'), false);
SELECT t.dblink_send_query('two', format($q$do $b$ begin perform %s; raise notice 'two-ok'; exception when others then raise notice 'two-%%', sqlstate; end $b$;$q$,
       t.cancel_sql((SELECT v::uuid FROM t.saved WHERE k = 'H8A'))));
SELECT pg_sleep(0.5);
SELECT t.dblink_exec('one', 'commit');
SELECT pg_sleep(0.3);
SELECT t.dblink_get_result('two') IS NOT NULL;
SELECT t.dblink_get_result('two') IS NULL;
SELECT t.dblink_disconnect('one');
SELECT t.dblink_disconnect('two');
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); h uuid := (SELECT v::uuid FROM t.saved WHERE k = 'H8A');
BEGIN
  PERFORM t.ok((SELECT state FROM public.continuity_handovers WHERE id = h) = 'accepted' AND t.owner(a) = t.u('S1')
               AND (SELECT count(*) FROM public.continuity_events WHERE record_id = a AND payload ->> 'handover_id' = h::text
                      AND kind IN ('handover_accepted', 'handover_cancelled')) = 1, 'H8a exactly one outcome');
  RAISE NOTICE 'PASS H8a: قبول وإلغاء متزامنان ⇒ نتيجة واحدة (القبول)، حدث واحد';
END $$;

-- H8b: تزامن — إسناد مباشر (جلسة 1) مقابل قبول (جلسة 2) ⇒ الإسناد يلغي والقبول يُرفض
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); g jsonb;
BEGIN
  PERFORM t.ctx('admin');
  g := t.call(t.u('S1'), t.req_sql(a, t.u('S2'), 'H8b', 'h8b'));
  INSERT INTO t.saved VALUES ('H8B', g -> 'handover' ->> 'id'), ('H8B_VER', t.ver2(a)::text);
  PERFORM t.act(NULL);
END $$;
SELECT t.conn('one', t.u('EA'), true);
SELECT x FROM t.dblink('one', format('select (public.continuity_assign(%L::uuid, %L::uuid, %L::uuid, %s))->''record''->>''id''',
       (SELECT v FROM t.saved WHERE k = 'RA'), t.u('S3'), t.u('T1'), (SELECT v FROM t.saved WHERE k = 'H8B_VER'))) AS r(x text);
SELECT t.conn('two', t.u('S2'), false);
SELECT t.dblink_send_query('two', format($q$do $b$ begin perform %s; raise notice 'two-ok'; exception when others then raise notice 'two-%%', sqlstate; end $b$;$q$,
       t.decide_sql((SELECT v::uuid FROM t.saved WHERE k = 'H8B'), 'accept', null, (SELECT v::int FROM t.saved WHERE k = 'H8B_VER'))));
SELECT pg_sleep(0.5);
SELECT t.dblink_exec('one', 'commit');
SELECT pg_sleep(0.3);
SELECT t.dblink_get_result('two') IS NOT NULL;
SELECT t.dblink_get_result('two') IS NULL;
SELECT t.dblink_disconnect('one');
SELECT t.dblink_disconnect('two');
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); h uuid := (SELECT v::uuid FROM t.saved WHERE k = 'H8B');
BEGIN
  PERFORM t.ok((SELECT state || '/' || cancel_cause FROM public.continuity_handovers WHERE id = h) = 'cancelled/reassigned'
               AND t.owner(a) = t.u('S3')
               AND NOT EXISTS (SELECT 1 FROM public.continuity_events WHERE kind = 'handover_accepted' AND payload ->> 'handover_id' = h::text),
               'H8b reassignment wins, acceptance refused');
  RAISE NOTICE 'PASS H8b: إسناد مباشر وقبول متزامنان ⇒ الإسناد يلغي الطلب والقبول يُرفض؛ لا انتقال مزدوج';
END $$;

-- H9: الإسناد المباشر بلا تغيير
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA');
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.ok(pg_get_functiondef('public.continuity_assign(uuid,uuid,uuid,integer)'::regprocedure) = (SELECT v FROM t.saved WHERE k = 'assign_080')
               AND pg_get_functiondef('public.continuity_transition(uuid,text,jsonb,integer)'::regprocedure) = (SELECT v FROM t.saved WHERE k = 'transition_080')
               AND pg_get_functiondef('public._continuity_full(uuid,boolean)'::regprocedure) = (SELECT v FROM t.saved WHERE k = 'full_080'),
               'H9 assign/transition/full unchanged');
  PERFORM t.ok(t.err(t.u('S3'), format('public.continuity_assign(%L::uuid, %L::uuid, %L::uuid, %s)', a, t.u('S2'), t.u('T1'), t.ver2(a))) = '42501',
               'H9 an ordinary owner still cannot reassign to someone else');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS H9: continuity_assign و continuity_transition و _continuity_full بلا تغيير؛ المالك العادي ما زال لا يسند لغيره';
END $$;

-- H10: الثبات، وحذف حساب المستلم
INSERT INTO auth.users (id, email) VALUES ('00000000-0000-4000-8000-0000000000d9', 'x9@t.io');
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at)
VALUES ('00000000-0000-4000-8000-0000000000d9', 'x9@t.io', 'دعم سيُحذف', 'support', '01000000079', '2026-09-01');
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); h uuid := (SELECT v::uuid FROM t.saved WHERE k = 'H8A'); g jsonb; p uuid;
BEGIN
  BEGIN UPDATE public.continuity_handovers SET state = 'declined', decision_note = 'تزوير' WHERE id = h; RAISE EXCEPTION 'FAIL H10 redecide';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN UPDATE public.continuity_handovers SET reason = 'تزوير' WHERE id = h; RAISE EXCEPTION 'FAIL H10 reason';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN DELETE FROM public.continuity_handovers WHERE id = h; RAISE EXCEPTION 'FAIL H10 delete';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN TRUNCATE public.continuity_handovers; RAISE EXCEPTION 'FAIL H10 truncate';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM t.ok(t.err_stmt(t.u('S1'), 'select 1 from public.continuity_handovers') = '42501', 'H10 no table access');
  -- حذف حساب مستلم طلب معلّق: الطلب يبقى بفاعل فارغ ولا يُقبل
  PERFORM t.ctx('admin');
  g := t.call(t.u('S3'), t.req_sql(a, '00000000-0000-4000-8000-0000000000d9', 'لمن سيُحذف', 'h10'));
  p := (g -> 'handover' ->> 'id')::uuid;
  PERFORM t.act(NULL);
  DELETE FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000d9';
  PERFORM t.ok((SELECT to_owner IS NULL AND state = 'pending' FROM public.continuity_handovers WHERE id = p), 'H10 target deleted: kept, actor null');
  PERFORM t.ctx('admin');
  PERFORM t.call(t.u('S3'), t.cancel_sql(p));
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS H10: القرار مرة واحدة، والنصوص ثابتة، لا حذف ولا تفريغ حتى للمالك الخارق؛ حذف حساب المستلم ينجح والطلب يبقى';
END $$;

-- H11: مفتاح الإيقاف
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); g jsonb; h uuid;
BEGIN
  PERFORM t.ctx('admin');
  g := t.call(t.u('S3'), t.req_sql(a, t.u('S1'), 'H11', 'h11'));
  h := (g -> 'handover' ->> 'id')::uuid;
  PERFORM t.pol('{"handovers_enabled": false}');
  PERFORM t.ok(t.err(t.u('S1'), t.decide_sql(h, 'accept', null, t.ver2(a))) = '0A000'
               AND t.err(t.u('S1'), format('public.continuity_handover_get(%L::uuid)', h)) = '0A000'
               AND t.err(t.u('S3'), t.req_sql(a, t.u('S2'), 'x', 'h11b')) = '0A000', 'H11 off: no decide/get/request');
  PERFORM t.ok(t.owner(a) = t.u('S3'), 'H11 owner unchanged');
  g := t.call(t.u('S3'), t.cancel_sql(h));
  PERFORM t.ok(g -> 'handover' ->> 'state' = 'cancelled', 'H11 cancel still works for cleanup');
  PERFORM t.pol('{"handovers_enabled": true}');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS H11: الإيقاف يمنع الطلب والقرار والقراءة فورًا ولا يغيّر الملكية؛ الإلغاء يظل متاحًا';
END $$;

-- H12: تاريخ السجل، ولا مساس بالشات
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); g jsonb;
BEGIN
  PERFORM t.ctx('admin');
  g := t.call(t.u('S3'), format('public.continuity_handovers_for_record(%L::uuid)', a));
  PERFORM t.ok(jsonb_array_length(g) >= 8 AND g -> 0 ->> 'state' = 'cancelled', 'H12 history newest first: ' || jsonb_array_length(g));
  PERFORM t.ok(t.chat_digest() = (SELECT v FROM t.saved WHERE k = 'chat_before'), 'H12 chat untouched');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS H12: تاريخ التسليم لمن يرى السجل، الأحدث أولًا؛ جداول الشات والصندوق لم تُمس';
END $$;

-- RERUN
INSERT INTO t.saved SELECT 'ho_digest', (SELECT md5(string_agg(md5(to_jsonb(h)::text), ',' ORDER BY h.id)) FROM public.continuity_handovers h);
\i migrations/081_continuity_handovers.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok((SELECT md5(string_agg(md5(to_jsonb(h)::text), ',' ORDER BY h.id)) FROM public.continuity_handovers h) = (SELECT v FROM t.saved WHERE k = 'ho_digest')
               AND (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_continuity_handover_on_record') = 1, 'RERUN no change');
  RAISE NOTICE 'PASS RERUN: إعادة تشغيل 081 لا تغيّر شيئًا';
END $$;

-- RB
\set rb080_sql `cat migrations/_rollback/080_continuity_attachments.down.sql`
\set rb081_sql `cat migrations/_rollback/081_continuity_handovers.down.sql`
SELECT set_config('t.rb080_sql', 'set continuity.rollback_discard_data = ''on''; ' || :'rb080_sql', false) IS NOT NULL;
SELECT set_config('t.rb081_sql', :'rb081_sql', false) IS NOT NULL;
CREATE FUNCTION t.try(p_name text, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
declare c text;
begin
  perform t.dblink_connect(p_name, format('dbname=%s port=%s host=%s user=postgres', current_database(),
            current_setting('port'), split_part(current_setting('unix_socket_directories'), ',', 1)));
  begin perform t.dblink_exec(p_name, p_sql); c := 'ok'; exception when others then c := sqlerrm; end;
  perform t.dblink_disconnect(p_name);
  return c;
end $$;
DO $$
DECLARE c text;
BEGIN
  c := t.try('rb80', current_setting('t.rb080_sql'));
  PERFORM t.ok(c LIKE '%081+%', 'RB-080 refused while 081 installed: ' || c);
  c := t.try('rb81', current_setting('t.rb081_sql'));
  PERFORM t.ok(c LIKE '%rollback_discard_data%' AND to_regclass('public.continuity_handovers') IS NOT NULL, 'RB-a refused with history: ' || c);
  RAISE NOTICE 'PASS RB-a: تراجع 080 يرفض و081 مطبق؛ تراجع 081 يرفض وفيه تاريخ تسليم';
END $$;
INSERT INTO t.saved SELECT 'owners_before_rb', (SELECT string_agg(id::text || ':' || coalesce(owner_id::text, '-'), ',' ORDER BY id) FROM public.continuity_records);
SET continuity.rollback_discard_data = 'on';
\i migrations/_rollback/081_continuity_handovers.down.sql
RESET continuity.rollback_discard_data;
DO $$
BEGIN
  PERFORM t.ok(to_regclass('public.continuity_handovers') IS NULL
               AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_continuity_handover_on_record')
               AND NOT public._continuity_capability_installed('handovers'), 'RB objects gone');
  PERFORM t.ok((SELECT string_agg(id::text || ':' || coalesce(owner_id::text, '-'), ',' ORDER BY id) FROM public.continuity_records)
               = (SELECT v FROM t.saved WHERE k = 'owners_before_rb'), 'RB ownership untouched');
  PERFORM t.ok(pg_get_functiondef('public.continuity_assign(uuid,uuid,uuid,integer)'::regprocedure) = (SELECT v FROM t.saved WHERE k = 'assign_080'), 'RB assign identical');
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.err(t.u('EA'), format('public.continuity_assign(%L::uuid, %L::uuid, %L::uuid, %s)', (SELECT v FROM t.saved WHERE k = 'RA'),
               t.u('S1'), t.u('T1'), t.ver2((SELECT v::uuid FROM t.saved WHERE k = 'RA')))) = 'ok', 'RB assign still works');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS RB-b: بعد التراجع لا جدول ولا محفّز ولا دالة؛ الملكية كما هي؛ الإسناد يعمل';
END $$;
\i migrations/081_continuity_handovers.sql
SET search_path = public, extensions;
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); g jsonb;
BEGIN
  PERFORM t.ctx('admin');
  g := t.call(t.u('S1'), t.req_sql(a, t.u('S2'), 'بعد التراجع', 'rbc'));
  PERFORM t.ok(g -> 'handover' ->> 'state' = 'pending', 'RB-c works again');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS RB-c: إعادة تطبيق 081 بعد التراجع تعمل';
END $$;

\echo 'ALL continuity-handovers tests passed'
