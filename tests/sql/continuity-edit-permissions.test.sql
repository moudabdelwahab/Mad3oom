-- ============================================================================
-- مدعوم — الاستمرارية: صلاحية التعديل منفصلة عن القراءة (087) على نسخة مطابقة
-- لشكل الإنتاج (073 → 081 → 087):
--
--   E0  التثبيت: نص الإنتاج قبل 087 بالضبط، البوابة في الدوال التسع، ولا صلاحيات جديدة
--   E1  الحقول: المالك والمشرف يعدّلون؛ عضو الفريق والمنشئ يقرؤون ولا يعدّلون (42501 + السبب)
--   E2  السجل بلا مالك: لا أحد يعدّله إلا المشرف؛ من يراه يأخذه لنفسه ثم يعدّل
--   E3  المصادر: إرفاق/إزالة/استرجاع بنفس القاعدة
--   E4  المرفقات: بدء/إتمام/إزالة/استرجاع بنفس القاعدة؛ المسح النهائي لمالك المنصة كما هو
--   E5  permissions في القراءة الكاملة لكل فاعل (مالك، فريق، منشئ، مشرف، سجل مقفول)
--   E6  من لا يرى السجل: نفس «غير موجود» كما قبل 087 — لا يعرف أن السجل موجود
--   E7  أغلفة relay_* تأخذ نفس القاعدة؛ anon والعميل مرفوضون
--   E8  ما لم يتغيّر: الإسناد والانتقال والقراءة والقائمة بنفس النتيجة
--   RERUN، RB (التراجع يرجّع البصمات حرفيًا وP1 يعود)
-- ============================================================================
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
CREATE FUNCTION t.upd_sql(p_rec uuid, p_patch jsonb) RETURNS text LANGUAGE sql AS $$
  select format('public.continuity_update(%L::uuid, %L::jsonb, %s)', p_rec, p_patch, t.ver2(p_rec)) $$;
CREATE FUNCTION t.errj(p uuid, p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
declare d text;
begin
  perform t.call(p, p_sql);
  return '{"ok":true}'::jsonb;
exception when others then
  get stacked diagnostics d = pg_exception_detail;
  return jsonb_build_object('state', sqlstate) || coalesce(case when d like '{%' then d::jsonb end, '{}'::jsonb);
end $$;
CREATE FUNCTION t.src(p_rec uuid, p_pos int) RETURNS uuid LANGUAGE sql AS $$
  select id from public.continuity_sources where record_id = p_rec and position = p_pos $$;
CREATE FUNCTION t.perm(p uuid, p_rec uuid) RETURNS jsonb LANGUAGE sql AS $$
  select t.get2(p, p_rec) -> 'permissions' $$;
CREATE FUNCTION t.get2(p uuid, p_rec uuid) RETURNS jsonb LANGUAGE sql AS $$
  select t.call(p, format('public.continuity_get(%L::uuid)', p_rec)) $$;
CREATE FUNCTION t.fdigest() RETURNS text LANGUAGE sql AS $$
  select string_agg(p.proname || ':' || md5(pg_get_functiondef(p.oid)), ',' order by p.oid::regprocedure::text)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('continuity_update', 'continuity_attach_sources', 'continuity_remove_source',
         'continuity_restore_source', 'continuity_attachment_begin', 'continuity_attachment_commit', 'continuity_attachment_remove',
         'continuity_attachment_restore', '_continuity_full') $$;
RESET check_function_bodies;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ============================================================================
-- ⓪ 073 → 081 وسجلات
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
\i migrations/081_continuity_handovers.sql
SET search_path = public, extensions;

-- RA: S1 مالك، فريق T1 (فيه S3)، مصدران من محادثة S1 · RU: بلا مالك (منشئه S1)
DO $$
DECLARE a uuid; u uuid;
BEGIN
  PERFORM t.ctx('admin');
  a := (t.call(t.u('S1'), format('public.continuity_create(%L::jsonb)',
        t.req('RA', array['3e550000-0000-4000-8000-0000000000a1', '3e550000-0000-4000-8000-0000000000a2']::uuid[],
              jsonb_build_object('owner_id', t.u('S1'))))) -> 'record' ->> 'id')::uuid;
  PERFORM t.call(t.u('EA'), format('public.continuity_assign(%L::uuid, %L::uuid, %L::uuid, %s)', a, t.u('S1'), t.u('T1'), t.ver2(a)));
  u := t.mk2(t.u('S1'), 'RU', '{}'::jsonb);
  INSERT INTO t.saved VALUES ('RA', a::text), ('RU', u::text);
  INSERT INTO t.saved SELECT 'fdigest_081', t.fdigest();
  INSERT INTO t.saved SELECT 'get_081_EA', (t.get2(t.u('EA'), a))::text;
  INSERT INTO t.saved SELECT 'list_081_S3', (t.call(t.u('S3'), 'public.continuity_list(''{}''::jsonb)'))::text;
  PERFORM t.act(NULL);
END $$;
-- قبل 087: عضو الفريق يعدّل (P1) — نثبت السلوك القديم لنثبت أن التراجع يعيده
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA');
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.err(t.u('S3'), t.upd_sql(a, '{"priority": 2}')) = 'ok', 'P1 before 087');
  PERFORM t.act(NULL);
END $$;

\i migrations/087_continuity_edit_permissions.sql
SET search_path = public, extensions;

-- E0
DO $$
DECLARE f text;
BEGIN
  PERFORM t.ok((SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.prokind = 'f' AND strpos(pg_get_functiondef(p.oid), '087_continuity_edit_gate') > 0) = 9, 'E0 nine gated');
  FOREACH f IN ARRAY array['_continuity_can_edit(uuid)', '_continuity_require_edit(uuid)', '_continuity_permissions(uuid)'] LOOP
    PERFORM t.ok(NOT has_function_privilege('authenticated', 'public.' || f, 'EXECUTE')
                 AND NOT has_function_privilege('anon', 'public.' || f, 'EXECUTE')
                 AND NOT has_function_privilege('service_role', 'public.' || f, 'EXECUTE'), 'E0 internal ' || f);
  END LOOP;
  RAISE NOTICE 'PASS E0: البوابة في الدوال التسع على نص الإنتاج؛ الداخلية مغلقة';
END $$;

-- E1: الحقول
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); e jsonb;
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.err(t.u('S1'), t.upd_sql(a, '{"title": "عنوان المالك"}')) = 'ok', 'E1 owner edits');
  PERFORM t.ok(t.err(t.u('EA'), t.upd_sql(a, '{"next_action": "المشرف عدّل"}')) = 'ok', 'E1 supervisor edits');
  PERFORM t.ok(t.err(t.u('OW'), t.upd_sql(a, '{"priority": 1}')) = 'ok', 'E1 platform owner edits');
  -- عضو الفريق يرى ولا يعدّل
  PERFORM t.ok((t.get2(t.u('S3'), a) -> 'record' ->> 'id')::uuid = a, 'E1 team member reads');
  e := t.errj(t.u('S3'), t.upd_sql(a, '{"title": "محاولة"}'));
  PERFORM t.ok(e ->> 'state' = '42501' AND e ->> 'code' = 'forbidden' AND e ->> 'field' = 'record' AND e ->> 'reason' = 'not_owner', 'E1 team member refused: ' || e::text);
  PERFORM t.ok((SELECT title FROM public.continuity_records WHERE id = a) = 'عنوان المالك', 'E1 nothing changed');
  -- المنشئ بعد نقل الملكية: يرى ولا يعدّل
  PERFORM t.call(t.u('EA'), format('public.continuity_assign(%L::uuid, %L::uuid, %L::uuid, %s)', a, t.u('S2'), t.u('T1'), t.ver2(a)));
  PERFORM t.ok((t.get2(t.u('S1'), a) -> 'record' ->> 'id')::uuid = a, 'E1 creator still reads');
  e := t.errj(t.u('S1'), t.upd_sql(a, '{"title": "المنشئ"}'));
  PERFORM t.ok(e ->> 'state' = '42501' AND e ->> 'reason' = 'not_owner', 'E1 creator refused: ' || e::text);
  PERFORM t.ok(t.err(t.u('S2'), t.upd_sql(a, '{"title": "المالك الجديد"}')) = 'ok', 'E1 new owner edits');
  -- إرجاع الملكية لـ S1
  PERFORM t.call(t.u('EA'), format('public.continuity_assign(%L::uuid, %L::uuid, %L::uuid, %s)', a, t.u('S1'), t.u('T1'), t.ver2(a)));
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS E1: المالك والمشرف يعدّلون؛ الفريق والمنشئ يقرؤون فقط (42501 مع السبب)';
END $$;

-- E2: بلا مالك
DO $$
DECLARE u uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RU'); e jsonb;
BEGIN
  PERFORM t.ctx('admin');
  e := t.errj(t.u('S1'), t.upd_sql(u, '{"title": "قبل الأخذ"}'));
  PERFORM t.ok(e ->> 'state' = '42501' AND e ->> 'reason' = 'unassigned', 'E2 creator of unassigned refused: ' || e::text);
  PERFORM t.ok((t.perm(t.u('S1'), u) ->> 'claim')::boolean AND NOT (t.perm(t.u('S1'), u) ->> 'edit')::boolean, 'E2 claim offered');
  PERFORM t.ok(t.err(t.u('S1'), format('public.continuity_assign(%L::uuid, %L::uuid, null, %s)', u, t.u('S1'), t.ver2(u))) = 'ok', 'E2 claim');
  PERFORM t.ok(t.err(t.u('S1'), t.upd_sql(u, '{"title": "بعد الأخذ"}')) = 'ok', 'E2 edit after claim');
  PERFORM t.ok(t.err(t.u('S1'), format('public.continuity_assign(%L::uuid, null, null, %s)', u, t.ver2(u))) = 'ok', 'E2 release');
  PERFORM t.ok(t.err(t.u('EA'), t.upd_sql(u, '{"next_action": "مشرف على سجل بلا مالك"}')) = 'ok', 'E2 supervisor edits unassigned');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS E2: السجل بلا مالك يُؤخذ أولًا ثم يُعدَّل؛ المشرف يعدّله مباشرة';
END $$;

-- E3: المصادر
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); s uuid; e jsonb;
BEGIN
  PERFORM t.ctx('admin');
  s := t.src(a, 1);
  e := t.errj(t.u('S3'), format('public.continuity_remove_source(%L::uuid, %s)', s, t.ver2(a)));
  PERFORM t.ok(e ->> 'state' = '42501' AND e ->> 'reason' = 'not_owner', 'E3 team member cannot remove: ' || e::text);
  PERFORM t.ok(t.err(t.u('S1'), format('public.continuity_remove_source(%L::uuid, %s)', s, t.ver2(a))) = 'ok', 'E3 owner removes');
  e := t.errj(t.u('S3'), format('public.continuity_restore_source(%L::uuid, %s)', s, t.ver2(a)));
  PERFORM t.ok(e ->> 'state' = '42501', 'E3 team member cannot restore');
  PERFORM t.ok(t.err(t.u('EA'), format('public.continuity_restore_source(%L::uuid, %s)', s, t.ver2(a))) = 'ok', 'E3 supervisor restores');
  -- إرفاق: S3 عضو فريق المحادثة C (لها وصول للمحادثة) لكنه ليس مالك السجل
  e := t.errj(t.u('S3'), format('public.continuity_attach_sources(%L::uuid, %L::jsonb, %s, false)', a,
         '[{"type":"mad3oom_message","provider":"mad3oom","internal":{"chat_message_id":"3e550000-0000-4000-8000-0000000000c1"}}]', t.ver2(a)));
  PERFORM t.ok(e ->> 'state' = '42501', 'E3 team member cannot attach: ' || e::text);
  PERFORM t.ok((SELECT count(*) FROM public.continuity_sources WHERE record_id = a) = 2, 'E3 nothing attached');
  PERFORM t.ok(t.err(t.u('S1'), format('public.continuity_attach_sources(%L::uuid, %L::jsonb, %s, false)', a,
         '[{"type":"mad3oom_message","provider":"mad3oom","internal":{"chat_message_id":"3e550000-0000-4000-8000-0000000000a3"}}]', t.ver2(a))) = 'ok', 'E3 owner attaches');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS E3: إرفاق/إزالة/استرجاع المصادر لمالك السجل والمشرف فقط';
END $$;

-- E4: المرفقات
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); e jsonb; g jsonb; att uuid;
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.pol('{"attachments_enabled": true}');
  e := t.errj(t.u('S3'), format('public.continuity_attachment_begin(%L::uuid, ''image'', ''image/png'', 10, ''x.png'', %L::uuid)', a, md5('att-s3')::uuid));
  PERFORM t.ok(e ->> 'state' = '42501', 'E4 team member cannot begin: ' || e::text);
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.continuity_attachments WHERE record_id = a), 'E4 no row');
  g := t.call(t.u('S1'), format('public.continuity_attachment_begin(%L::uuid, ''image'', ''image/png'', 10, ''x.png'', %L::uuid)', a, md5('att-s1')::uuid));
  att := (g -> 'attachment' ->> 'id')::uuid;
  INSERT INTO storage.objects (bucket_id, name, metadata) VALUES ('continuity-attachments', g -> 'upload' ->> 'path',
    jsonb_build_object('size', 10, 'mimetype', 'image/png'));
  -- المالك يفقد الملكية قبل الإتمام ⇒ الإتمام يُرفض
  PERFORM t.call(t.u('EA'), format('public.continuity_assign(%L::uuid, %L::uuid, %L::uuid, %s)', a, t.u('S2'), t.u('T1'), t.ver2(a)));
  e := t.errj(t.u('S1'), format('public.continuity_attachment_commit(%L::uuid, %L)', att, repeat('a', 64)));
  PERFORM t.ok(e ->> 'state' = '42501', 'E4 commit after losing ownership refused: ' || e::text);
  PERFORM t.call(t.u('EA'), format('public.continuity_assign(%L::uuid, %L::uuid, %L::uuid, %s)', a, t.u('S1'), t.u('T1'), t.ver2(a)));
  PERFORM t.ok(t.err(t.u('S1'), format('public.continuity_attachment_commit(%L::uuid, %L)', att, repeat('a', 64))) = 'ok', 'E4 owner commits');
  e := t.errj(t.u('S3'), format('public.continuity_attachment_remove(%L::uuid, %s)', att, t.ver2(a)));
  PERFORM t.ok(e ->> 'state' = '42501', 'E4 team member cannot remove');
  PERFORM t.ok(t.err(t.u('S1'), format('public.continuity_attachment_remove(%L::uuid, %s)', att, t.ver2(a))) = 'ok', 'E4 owner removes');
  e := t.errj(t.u('S3'), format('public.continuity_attachment_restore(%L::uuid, %s)', att, t.ver2(a)));
  PERFORM t.ok(e ->> 'state' = '42501', 'E4 team member cannot restore');
  PERFORM t.ok(t.err(t.u('EA'), format('public.continuity_attachment_restore(%L::uuid, %s)', att, t.ver2(a))) = 'ok', 'E4 supervisor restores');
  -- المسح النهائي كما هو: مالك المنصة فقط (المشرف المرتفع لا)
  PERFORM t.ok(t.err(t.u('EA'), format('public.continuity_attachment_purge(%L::uuid, %s)', att, t.ver2(a))) = '42501', 'E4 purge still owner-only');
  PERFORM t.pol('{"attachments_enabled": false}');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS E4: المرفقات (بدء/إتمام/إزالة/استرجاع) لمالك السجل والمشرف؛ فقدان الملكية يوقف الإتمام';
END $$;

-- E5: permissions
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); p jsonb; c uuid;
BEGIN
  PERFORM t.ctx('admin');
  p := t.perm(t.u('S1'), a);
  PERFORM t.ok(p @> '{"edit":true,"sources":true,"transition":true,"release":true,"claim":false,"assign":false,"purge":false}'
               AND p -> 'reason' = 'null'::jsonb AND p ->> 'attachments' = 'false', 'E5 owner: ' || p::text);
  p := t.perm(t.u('S3'), a);
  PERFORM t.ok(p @> '{"edit":false,"sources":false,"transition":false,"release":false,"claim":false,"reason":"not_owner"}', 'E5 team member: ' || p::text);
  p := t.perm(t.u('EA'), a);
  PERFORM t.ok(p @> '{"edit":true,"transition":true,"assign":true}', 'E5 supervisor: ' || p::text);
  PERFORM t.ok((t.perm(t.u('OW'), a) ->> 'purge')::boolean, 'E5 platform owner purge');
  c := t.mk2(t.u('S1'), 'RC', jsonb_build_object('owner_id', t.u('S1')));
  PERFORM t.tr(t.u('S1'), c, 'resolved', '{"resolution_note": "تم"}');
  p := t.perm(t.u('S1'), c);
  PERFORM t.ok(p @> '{"edit":false,"sources":false,"transition":true,"reason":"closed"}', 'E5 closed: ' || p::text);
  PERFORM t.ok(t.errj(t.u('S1'), t.upd_sql(c, '{"title": "x"}')) ->> 'state' = '55000', 'E5 closed still 55000 for owner');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS E5: permissions تعكس القاعدة لكل فاعل وللسجل المقفول';
END $$;

-- E6: من لا يرى السجل
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); e jsonb;
BEGIN
  PERFORM t.ctx('admin');
  e := t.errj(t.u('S2'), t.upd_sql(a, '{"title": "غريب"}'));
  PERFORM t.ok(e ->> 'state' = 'P0002' AND e ->> 'code' = 'not_found' AND NOT e ? 'reason', 'E6 stranger update: ' || e::text);
  e := t.errj(t.u('S2'), format('public.continuity_remove_source(%L::uuid, %s)', t.src(a, 1), t.ver2(a)));
  PERFORM t.ok(e ->> 'state' = 'P0002', 'E6 stranger remove source');
  e := t.errj(t.u('S2'), format('public.continuity_update(%L::uuid, ''{"title":"x"}''::jsonb, %s)', gen_random_uuid(), 1));
  PERFORM t.ok(e ->> 'state' = 'P0002', 'E6 nonexistent same answer');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS E6: من لا يرى السجل يأخذ «غير موجود» بلا سبب — كما لو لم يكن';
END $$;

-- E7: الأغلفة، anon، العميل
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA');
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.err(t.u('S3'), format('public.relay_update(%L::uuid, ''{"title":"غلاف"}''::jsonb, %s)', a, t.ver2(a))) = '42501', 'E7 relay wrapper gated');
  PERFORM t.ok(t.err(t.u('S1'), format('public.relay_update(%L::uuid, ''{"title":"غلاف المالك"}''::jsonb, %s)', a, t.ver2(a))) = 'ok', 'E7 relay wrapper owner ok');
  PERFORM t.ok(t.err_anon(format('select public.continuity_update(%L::uuid, ''{"title":"x"}''::jsonb, 1)', a)) = '42501', 'E7 anon');
  PERFORM t.ok(t.err(t.u('C1'), t.upd_sql(a, '{"title": "عميل"}')) IN ('42501', 'P0002'), 'E7 customer');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS E7: relay_update بنفس القاعدة؛ anon والعميل مرفوضون';
END $$;

-- E8: ما لم يتغيّر
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); u uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RU');
BEGIN
  PERFORM t.ctx('admin');
  -- القائمة لعضو الفريق كما هي (نفس السجلات)
  PERFORM t.ok((SELECT jsonb_agg(x ->> 'id' ORDER BY x ->> 'id') FROM jsonb_array_elements(t.call(t.u('S3'), 'public.continuity_list(''{}''::jsonb)')) x)
               = (SELECT jsonb_agg(x ->> 'id' ORDER BY x ->> 'id') FROM jsonb_array_elements((SELECT v::jsonb FROM t.saved WHERE k = 'list_081_S3')) x), 'E8 list unchanged');
  -- الإسناد: P4 كما هو (عضو الفريق لا ينقل لغيره)
  PERFORM t.ok(t.err(t.u('S3'), format('public.continuity_assign(%L::uuid, %L::uuid, %L::uuid, %s)', a, t.u('S3'), t.u('T1'), t.ver2(a))) = '42501', 'E8 assign rule unchanged');
  -- الانتقال: المالك فقط (079) كما هو
  PERFORM t.ok(t.tr_err(t.u('S3'), a, 'in_progress', '{}') = '42501', 'E8 transition rule unchanged');
  PERFORM t.ok(t.tr_err(t.u('S1'), a, 'in_progress', '{}') = 'ok', 'E8 owner transitions');
  -- القراءة: نفس المفاتيح + permissions فقط
  PERFORM t.ok((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(t.get2(t.u('EA'), a)) k)
               = (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys((SELECT v::jsonb FROM t.saved WHERE k = 'get_081_EA') || '{"permissions":null}') k), 'E8 get keys');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS E8: القائمة والإسناد والانتقال كما هي؛ القراءة تزيد permissions فقط';
END $$;

-- RERUN
INSERT INTO t.saved SELECT 'fdigest_087', t.fdigest();
\i migrations/087_continuity_edit_permissions.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok(t.fdigest() = (SELECT v FROM t.saved WHERE k = 'fdigest_087'), 'RERUN no change');
  RAISE NOTICE 'PASS RERUN: إعادة تشغيل 087 لا تغيّر شيئًا';
END $$;

-- RB
\i migrations/_rollback/087_continuity_edit_permissions.down.sql
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA');
BEGIN
  PERFORM t.ok(t.fdigest() = (SELECT v FROM t.saved WHERE k = 'fdigest_081'), 'RB digests identical to 081');
  PERFORM t.ok(to_regprocedure('public._continuity_can_edit(uuid)') IS NULL AND to_regprocedure('public._continuity_permissions(uuid)') IS NULL, 'RB helpers gone');
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.err(t.u('S3'), t.upd_sql(a, '{"priority": 3}')) = 'ok', 'RB P1 back');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS RB-a: التراجع يرجّع نصوص الدوال التسع حرفيًا ويعيد P1';
END $$;
\i migrations/087_continuity_edit_permissions.sql
SET search_path = public, extensions;
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA');
BEGIN
  PERFORM t.ok(t.fdigest() = (SELECT v FROM t.saved WHERE k = 'fdigest_087'), 'RB-b reapply identical');
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.err(t.u('S3'), t.upd_sql(a, '{"priority": 2}')) = '42501', 'RB-b gate back');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS RB-b: إعادة التطبيق بعد التراجع تعطي نفس النصوص';
END $$;

\echo 'ALL continuity-edit-permissions tests passed'
