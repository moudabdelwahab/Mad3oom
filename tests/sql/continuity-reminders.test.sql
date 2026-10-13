-- ============================================================================
-- مدعوم — الاستمرارية: المجدول والتذكيرات والتصعيد (094) على نسخة مطابقة لشكل الإنتاج
-- (073 → 081 → 087 → 089 → 091 → 093 → 094):
--
--   M0  التثبيت: الجداول مغلقة، المنفّذ مغلق، القدرتان مثبتتان والمفتاحان مطفآن
--   M1  التخطيط: الأنواع والأوقات (D1/D3)، تغيير الموعد يستبدل، التكرار لا يضيف، المالك، الإغلاق وإعادة الفتح،
--       السجل بلا مالك (E3)، طلب التسليم (D4)
--   M2  المفتاح مطفأ لحظة التنفيذ ⇒ إلغاء بلا إشعار
--   M3  التذكير: إشعار واحد للمالك بنص ثابت ورابط السجل، ولا تكرار
--   M4  المتأخر بعد توقف ⇒ لا دفعة قديمة
--   M5  التصعيد (E1) للمشرفين (R4) عدا المالك؛ ساعات العمل (R3) تؤجل التصعيد لا تذكير المالك
--   M6  طلب التسليم: تذكير المستلم بلا رابط سجل، والقرار يلغي التصعيد
--   M7  مستلم غير مؤهل ⇒ لا إشعار
--   M8  فشل التسليم: إعادة بفاصل، ثم dead وحدث
--   M9  الخصوصية: لا نص من السجل أو المحادثة في أي إشعار أو حدث
--   M10 تزامن حقيقي: منفّذان معًا ⇒ إشعار واحد
--   M11 الاحتفاظ (R7): المنتهي بعد 180 يومًا فقط، والحذف المباشر مرفوض
--   M12 الثبات، وقراءة التذكيرات لمن يرى السجل فقط
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

-- ── أدوات 091 ─────────────────────────────────────────────────────────────
-- auth.sessions كما في الإنتاج (الأعمدة التي تقرؤها 091 فقط)
CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY, user_id uuid NOT NULL, not_after timestamptz);

ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS file_size_limit bigint, ADD COLUMN IF NOT EXISTS allowed_mime_types text[];
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated;
INSERT INTO storage.buckets (id, name, public) VALUES ('chat-attachments', 'chat-attachments', false), ('avatars', 'avatars', true);
CREATE POLICY "Allow authenticated users to upload" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'chat-attachments' AND (storage.foldername(name))[1] = (auth.uid())::text);
CREATE POLICY public_assets_read ON storage.objects FOR SELECT TO anon, authenticated USING (bucket_id = ANY (ARRAY['avatars']));

-- S2 يفتح محادثة SA عبر فريق T2 (لا يرى السجل RA؛ فريق السجل T1)
INSERT INTO public.inbox_teams (id, name) VALUES ('7ea70000-0000-4000-8000-000000000002', 'فريق المراجعة');
INSERT INTO public.inbox_team_members (team_id, user_id) VALUES
  ('7ea70000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000a6');
UPDATE public.inbox_conversations SET team_id = '7ea70000-0000-4000-8000-000000000002'
 WHERE session_id = '5e550000-0000-4000-8000-0000000000a1';

SET check_function_bodies = off;
-- نداء بجلسة دخول محددة (claims.session_id)
CREATE FUNCTION t.act_s(p uuid, p_sid uuid) RETURNS void LANGUAGE sql AS $$
  select set_config('request.jwt.claim.sub', p::text, false),
         set_config('request.jwt.claim.role', 'authenticated', false),
         set_config('request.jwt.claims', jsonb_build_object('sub', p, 'role', 'authenticated', 'session_id', p_sid)::text, false); $$;
CREATE FUNCTION t.call_s(p uuid, p_sid uuid, p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
declare v jsonb;
begin
  perform t.act_s(p, p_sid);
  v := t.call(null, p_sql);
  perform t.act(null);
  return v;
exception when others then
  perform t.act(null);
  raise;
end $$;
CREATE FUNCTION t.err_s(p uuid, p_sid uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  perform t.call_s(p, p_sid, p_sql);
  return 'ok';
exception when others then
  return sqlstate;
end $$;
CREATE FUNCTION t.hreq_sql(p_rec uuid, p_to uuid, p_mode text, p_scope jsonb, p_key text, p_reason text DEFAULT 'راجع آخر رسالتين') RETURNS text LANGUAGE sql AS $$
  select format('public.continuity_handover_request(%L::uuid, %L::uuid, %L, null, %s, %L::uuid, %L, %L::jsonb)',
                p_rec, p_to, p_reason, t.ver2(p_rec), md5('SH-' || p_key)::uuid, p_mode, p_scope) $$;
CREATE FUNCTION t.hreq(p uuid, p_rec uuid, p_to uuid, p_mode text, p_scope jsonb, p_key text) RETURNS uuid LANGUAGE sql AS $$
  select (t.call(p, t.hreq_sql(p_rec, p_to, p_mode, p_scope, p_key)) -> 'handover' ->> 'id')::uuid $$;
CREATE FUNCTION t.review(p uuid, p_h uuid) RETURNS jsonb LANGUAGE sql AS $$
  select t.call(p, format('public.continuity_handover_review(%L::uuid)', p_h)) $$;
CREATE FUNCTION t.decide2_sql(p_h uuid, p_decision text, p_note text, p_digest text) RETURNS text LANGUAGE sql AS $$
  select format('public.continuity_handover_decide(%L::uuid, %L, %L, %L::text)', p_h, p_decision, p_note, p_digest) $$;
-- مراجعة ثم قبول ببصمتها
CREATE FUNCTION t.accept(p uuid, p_h uuid) RETURNS jsonb LANGUAGE sql AS $$
  select t.call(p, t.decide2_sql(p_h, 'accept', null, t.review(p, p_h) ->> 'digest')) $$;
CREATE FUNCTION t.grant(p_from uuid, p_rec uuid, p_to uuid, p_scope jsonb, p_key text, p_mode text DEFAULT 'review') RETURNS uuid LANGUAGE plpgsql AS $$
declare h uuid;
begin
  h := t.hreq(p_from, p_rec, p_to, p_mode, p_scope, p_key);
  perform t.accept(p_to, h);
  return h;
end $$;
CREATE FUNCTION t.shared_sql(p_rec uuid) RETURNS text LANGUAGE sql AS $$ select format('public.continuity_shared_get(%L::uuid)', p_rec) $$;
CREATE FUNCTION t.shared(p uuid, p_rec uuid) RETURNS jsonb LANGUAGE sql AS $$ select t.call(p, t.shared_sql(p_rec)) $$;
CREATE FUNCTION t.check_sql(p_att uuid) RETURNS text LANGUAGE sql AS $$ select format('public.continuity_shared_attachment_check(%L::uuid)', p_att) $$;
CREATE FUNCTION t.excerpts(p_shared jsonb) RETURNS text LANGUAGE sql AS $$
  select string_agg(coalesce(x ->> 'excerpt', '∅'), '|' order by (x ->> 'position')::int) from jsonb_array_elements(p_shared -> 'sources') x $$;
CREATE FUNCTION t.positions(p_shared jsonb) RETURNS text LANGUAGE sql AS $$
  select string_agg(x ->> 'position', ',' order by (x ->> 'position')::int) from jsonb_array_elements(p_shared -> 'sources') x $$;
CREATE FUNCTION t.revoke_sql(p_h uuid) RETURNS text LANGUAGE sql AS $$ select format('public.continuity_handover_revoke(%L::uuid, null)', p_h) $$;
CREATE FUNCTION t.amend_sql(p_h uuid, p_scope jsonb) RETURNS text LANGUAGE sql AS $$
  select format('public.continuity_handover_amend_scope(%L::uuid, %L::jsonb)', p_h, p_scope) $$;
CREATE FUNCTION t.fp6() RETURNS text LANGUAGE sql AS $$
  select string_agg(p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid)), ',' order by p.oid::regprocedure::text)
    from pg_proc p where p.oid in ('public.continuity_handover_decide(uuid,text,text,integer)'::regprocedure,
      'public._continuity_guard_handover()'::regprocedure, 'public._continuity_handover_json(public.continuity_handovers)'::regprocedure,
      'public._continuity_handover_result(uuid)'::regprocedure, 'public.continuity_handovers_mine()'::regprocedure,
      'public.continuity_set_policies(jsonb,integer)'::regprocedure) $$;
-- بصمة كل كائنات 091 (للإعادة)
CREATE FUNCTION t.fp091() RETURNS text LANGUAGE sql AS $$
  select md5(concat_ws('#',
    (select string_agg(p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid)) || ':' || coalesce(p.proacl::text, ''), ','
                       order by p.oid::regprocedure::text)
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f' and (p.proname like '%continuity%')),
    (select string_agg(conname || ':' || pg_get_constraintdef(oid), ',' order by conname) from pg_constraint
      where conrelid in ('public.continuity_handovers'::regclass, 'public.continuity_handover_scopes'::regclass, 'public.continuity_policies'::regclass)),
    (select string_agg(tgname, ',' order by tgname) from pg_trigger where tgrelid in ('public.continuity_handovers'::regclass,
      'public.continuity_handover_scopes'::regclass, 'public.continuity_records'::regclass) and not tgisinternal))) $$;
-- مرفقات (نفس أدوات continuity-attachments)
CREATE FUNCTION t.key(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ select md5('ATT-' || p)::uuid $$;
CREATE FUNCTION t.att(p uuid, p_rec uuid, p_key text) RETURNS uuid LANGUAGE plpgsql AS $$
declare b jsonb;
begin
  b := t.call(p, format('public.continuity_attachment_begin(%L::uuid, %L, %L, %s, %L, %L::uuid)', p_rec, 'image', 'image/png', 1000,
                        'صورة ' || p_key || '.png', t.key(p_key)));
  insert into storage.objects (bucket_id, name, metadata)
  values ('continuity-attachments', b -> 'upload' ->> 'path', jsonb_build_object('size', 1000, 'mimetype', 'image/png'));
  perform t.call(p, format('public.continuity_attachment_commit(%L::uuid, %L)', b -> 'attachment' ->> 'id', repeat('a', 64)));
  return (b -> 'attachment' ->> 'id')::uuid;
end $$;
CREATE FUNCTION t.owner(p_rec uuid) RETURNS uuid LANGUAGE sql AS $$ select owner_id from public.continuity_records where id = p_rec $$;
CREATE FUNCTION t.evs(p_rec uuid, p_kind text) RETURNS int LANGUAGE sql AS $$
  select count(*)::int from public.continuity_events where record_id = p_rec and kind = p_kind $$;
-- جملة بصلاحية المالك الخارق (المحفّزات تسري عليه أيضًا)
CREATE FUNCTION t.err_su(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end $$;
CREATE FUNCTION t.path(p_id uuid) RETURNS text LANGUAGE sql AS $$ select storage_path from public.continuity_attachments where id = p_id $$;
CREATE FUNCTION t.sees(p uuid, p_path text) RETURNS int LANGUAGE sql AS $$
  select (t.call(p, format('(select count(*) from storage.objects where bucket_id = ''continuity-attachments'' and name = %L)', p_path)))::int $$;
RESET check_function_bodies;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ============================================================================
-- ⓪ 073 → 089، سجلات، وتفعيل التسليم والمرفقات (كالإنتاج)
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
\i migrations/087_continuity_edit_permissions.sql
SET search_path = public, extensions;
\i migrations/089_continuity_attachment_cleanup_schedule.sql
SET search_path = public, extensions;

-- RA: مالك S1، فريق T1، ثلاث رسائل من SA (07:24، 07:25، 07:27 UTC)
DO $$
DECLARE a uuid;
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.pol('{"handovers_enabled": true, "attachments_enabled": true}');
  a := (t.call(t.u('S1'), format('public.continuity_create(%L::jsonb)',
        t.req('RA', array['3e550000-0000-4000-8000-0000000000a1', '3e550000-0000-4000-8000-0000000000a2',
                          '3e550000-0000-4000-8000-0000000000a3']::uuid[],
              jsonb_build_object('owner_id', t.u('S1'))))) -> 'record' ->> 'id')::uuid;
  PERFORM t.call(t.u('EA'), format('public.continuity_assign(%L::uuid, %L::uuid, %L::uuid, %s)', a, t.u('S1'), t.u('T1'), t.ver2(a)));
  INSERT INTO t.saved VALUES ('RA', a::text);
  INSERT INTO t.saved SELECT 'fp6_before', t.fp6();
  INSERT INTO t.saved SELECT 'att1', t.att(t.u('S1'), a, 'one')::text;
  INSERT INTO t.saved SELECT 'att2', t.att(t.u('S1'), a, 'two')::text;
  PERFORM t.act(NULL);
END $$;

\i migrations/091_continuity_scoped_handover.sql
SET search_path = public, extensions;
CREATE FUNCTION t.h(p_h uuid) RETURNS public.continuity_handovers LANGUAGE sql AS $$ select * from public.continuity_handovers where id = p_h $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

\i migrations/093_continuity_collab_actions.sql
SET search_path = public, extensions;
-- السجل بلا مالك (E3) قبل 094: يخطَّط عند التثبيت
DO $$
DECLARE u uuid;
BEGIN
  PERFORM t.ctx('admin');
  u := t.mk2(t.u('S1'), 'MU', '{}'::jsonb);
  INSERT INTO t.saved VALUES ('MU', u::text);
  PERFORM t.act(NULL);
END $$;
\i migrations/094_continuity_reminders.sql
SET search_path = public, extensions;

SET check_function_bodies = off;
CREATE FUNCTION t.jobs(p_rec uuid, p_state text DEFAULT 'pending') RETURNS text LANGUAGE sql AS $$
  select coalesce(string_agg(kind, ',' order by kind), '') from public.continuity_jobs where record_id = p_rec and state = p_state $$;
CREATE FUNCTION t.job(p_rec uuid, p_kind text) RETURNS bigint LANGUAGE sql AS $$
  select id from public.continuity_jobs where record_id = p_rec and kind = p_kind and state = 'pending' order by id desc limit 1 $$;
CREATE FUNCTION t.due_now(p_job bigint) RETURNS void LANGUAGE sql AS $$
  update public.continuity_jobs set run_at = now() - interval '1 minute' where id = p_job $$;
CREATE FUNCTION t.due_in(p_min int) RETURNS jsonb LANGUAGE sql AS $$
  select jsonb_build_object('at', to_char((now() + make_interval(mins => p_min)) at time zone 'Africa/Cairo', 'YYYY-MM-DD"T"HH24:MI:SS'),
                            'tz', 'Africa/Cairo') $$;
CREATE FUNCTION t.notes(p_user uuid) RETURNS int LANGUAGE sql AS $$
  select count(*)::int from public.notifications where user_id = p_user and category = 'continuity' $$;
CREATE FUNCTION t.req_sql(p_rec uuid, p_to uuid, p_reason text, p_key text, p_note text DEFAULT NULL) RETURNS text LANGUAGE sql AS $$
  select format('public.continuity_handover_request(%L::uuid, %L::uuid, %L, %L, %s, %L::uuid)',
                p_rec, p_to, p_reason, p_note, t.ver2(p_rec), md5('HO-' || p_key)::uuid) $$;
CREATE FUNCTION t.tick() RETURNS jsonb LANGUAGE sql AS $$ select public.continuity_tick() $$;
CREATE FUNCTION t.fp094() RETURNS text LANGUAGE sql AS $$
  select md5(concat_ws('#',
    (select string_agg(p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid)) || ':' || coalesce(p.proacl::text, ''), ',' order by p.oid::regprocedure::text)
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' and p.proname like '%continuity%'),
    (select string_agg(conrelid::regclass::text || conname || ':' || pg_get_constraintdef(oid), ',' order by conrelid::regclass::text, conname)
       from pg_constraint where conrelid::regclass::text in ('continuity_jobs', 'continuity_deliveries')),
    (select string_agg(tgrelid::regclass::text || tgname, ',' order by tgrelid::regclass::text, tgname) from pg_trigger
      where tgname like 'trg_continuity_replan_%' or tgrelid::regclass::text in ('continuity_jobs', 'continuity_deliveries')))) $$;
RESET check_function_bodies;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ============================================================================
-- M0 التثبيت
-- ============================================================================
DO $$
BEGIN
  PERFORM t.ok(public._continuity_capability_installed('reminders') AND public._continuity_capability_installed('escalation'), 'M0 capabilities installed');
  PERFORM t.ok((SELECT NOT reminders_enabled AND NOT escalation_enabled FROM public._continuity_policy_row()), 'M0 switches off');
  PERFORM t.ok(t.err_stmt(t.u('S1'), 'select count(*) from public.continuity_jobs') = '42501', 'M0 jobs closed');
  PERFORM t.ok(t.err_stmt(t.u('S1'), 'select count(*) from public.continuity_deliveries') = '42501', 'M0 deliveries closed');
  PERFORM t.ok(NOT has_function_privilege('authenticated', 'public.continuity_tick()', 'EXECUTE'), 'M0 tick closed');
  PERFORM t.ok(NOT has_function_privilege('authenticated', 'public._continuity_replan(uuid)', 'EXECUTE'), 'M0 replan closed');
  PERFORM t.ok(NOT has_function_privilege('service_role', 'public.continuity_job_retention_sweep()', 'EXECUTE'), 'M0 sweep closed');
  PERFORM t.ok(t.err_anon('select public.continuity_reminders_for(gen_random_uuid())') = '42501', 'M0 anon refused');
  RAISE NOTICE 'PASS M0 install';
END $$;

-- ============================================================================
-- M1 التخطيط
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); u uuid := (SELECT v::uuid FROM t.saved WHERE k = 'MU');
        d timestamptz; n int; h uuid; j jsonb;
BEGIN
  PERFORM t.ctx('admin');
  -- التثبيت خطط للسجلات النشطة
  PERFORM t.ok(t.jobs(a) = 'due_reminder,escalation_overdue,overdue_alert', 'M1 planned at install: ' || t.jobs(a));
  PERFORM t.ok(t.jobs(u) = 'escalation_unassigned', 'M1 E3 for an unowned record: ' || t.jobs(u));
  d := (SELECT due_at FROM public.continuity_records WHERE id = a);
  PERFORM t.ok((SELECT run_at FROM public.continuity_jobs WHERE id = t.job(a, 'due_reminder')) = d - interval '60 minutes', 'M1 D1 60 min before');
  PERFORM t.ok((SELECT run_at FROM public.continuity_jobs WHERE id = t.job(a, 'overdue_alert')) = d, 'M1 D1 at due');
  PERFORM t.ok((SELECT run_at FROM public.continuity_jobs WHERE id = t.job(a, 'escalation_overdue')) = d + interval '240 minutes', 'M1 D3 240 after');
  -- تغيير الموعد يستبدل الثلاثة
  PERFORM t.call(t.u('S1'), t.upd_sql(a, jsonb_build_object('due', t.tomorrow(15))));
  PERFORM t.ok(t.jobs(a, 'superseded') = 'due_reminder,escalation_overdue,overdue_alert' AND t.jobs(a) = 'due_reminder,escalation_overdue,overdue_alert', 'M1 reschedule replaces');
  n := (SELECT count(*) FROM public.continuity_jobs WHERE record_id = a);
  -- تعديل لا يغيّر الأساس لا يضيف شيئًا
  PERFORM t.call(t.u('S1'), t.upd_sql(a, '{"priority": 2}'));
  PERFORM t.ok((SELECT count(*) FROM public.continuity_jobs WHERE record_id = a) = n, 'M1 unrelated edit adds nothing');
  -- تغيير المالك يعيد التخطيط
  PERFORM t.call(t.u('EA'), format('public.continuity_assign(%L::uuid, %L::uuid, %L::uuid, %s)', a, t.u('S3'), t.u('T1'), t.ver2(a)));
  PERFORM t.ok((SELECT (basis ->> 'owner_id')::uuid FROM public.continuity_jobs WHERE id = t.job(a, 'due_reminder')) = t.u('S3'), 'M1 owner in basis');
  PERFORM t.call(t.u('EA'), format('public.continuity_assign(%L::uuid, %L::uuid, %L::uuid, %s)', a, t.u('S1'), t.u('T1'), t.ver2(a)));
  -- الإغلاق يلغي، وإعادة الفتح تخطط من جديد بأساس جديد
  PERFORM t.tr(t.u('S1'), a, 'resolved', '{"resolution_note": "تم"}');
  PERFORM t.ok(t.jobs(a) = '' AND EXISTS (SELECT 1 FROM public.continuity_jobs WHERE record_id = a AND reason = 'record_closed'), 'M1 close cancels everything');
  PERFORM t.tr(t.u('S1'), a, 'open', jsonb_build_object('reason', 'رجع', 'due', t.tomorrow(16)));
  PERFORM t.ok(t.jobs(a) = 'due_reminder,escalation_overdue,overdue_alert'
               AND (SELECT (basis ->> 'closure_seq')::int FROM public.continuity_jobs WHERE id = t.job(a, 'due_reminder')) = 1, 'M1 reopen re-plans with closure_seq');
  -- طلب تسليم معلّق (D4)، والإلغاء يلغي مهامه
  j := t.call(t.u('S1'), t.req_sql(a, t.u('S3'), 'إجازة', 'M1'));
  h := (j -> 'handover' ->> 'id')::uuid;
  PERFORM t.ok((SELECT string_agg(kind, ',' order by kind) FROM public.continuity_jobs WHERE handover_id = h AND state = 'pending') = 'escalation_handover,handover_reminder', 'M1 D4 planned');
  PERFORM t.ok((SELECT run_at FROM public.continuity_jobs WHERE handover_id = h AND kind = 'handover_reminder' AND state = 'pending')
               = (SELECT created_at FROM public.continuity_handovers WHERE id = h) + interval '60 minutes', 'M1 D4 60 min');
  PERFORM t.call(t.u('S1'), format('public.continuity_handover_cancel(%L::uuid, null)', h));
  PERFORM t.ok((SELECT count(*) FROM public.continuity_jobs WHERE handover_id = h AND state = 'pending') = 0, 'M1 cancel supersedes handover jobs');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS M1 planning';
END $$;

-- M1b: لا تخطيط لما فات وقته بأكثر من 15 دقيقة (موعد بعد 30 دقيقة ⇒ تذكير الـ60 فات)
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA');
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.call(t.u('S1'), t.upd_sql(a, jsonb_build_object('due', t.due_in(30))));
  PERFORM t.ok(t.jobs(a) = 'escalation_overdue,overdue_alert', 'M1b missed reminder not planned: ' || t.jobs(a));
  PERFORM t.call(t.u('S1'), t.upd_sql(a, jsonb_build_object('due', t.tomorrow(17))));
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS M1b no backlog';
END $$;

-- ============================================================================
-- M2 المفتاح مطفأ لحظة التنفيذ
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); x bigint;
BEGIN
  x := t.job(a, 'due_reminder');
  PERFORM t.due_now(x);
  PERFORM t.tick();
  PERFORM t.ok((SELECT state || ':' || reason FROM public.continuity_jobs WHERE id = x) = 'cancelled:switch_off', 'M2 cancelled while off');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.continuity_deliveries) AND t.notes(t.u('S1')) = 0, 'M2 nothing sent');
  RAISE NOTICE 'PASS M2 switch off';
END $$;

-- ============================================================================
-- M3 التذكير
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); x bigint; nrow record;
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.pol('{"reminders_enabled": true}');
  -- موعد بعد ساعتين ⇒ تذكير بعد ساعة (يُستحق الآن للاختبار)
  PERFORM t.call(t.u('S1'), t.upd_sql(a, jsonb_build_object('due', t.due_in(120))));
  x := t.job(a, 'due_reminder');
  PERFORM t.due_now(x);
  PERFORM t.ok((t.tick() ->> 'sent')::int = 1, 'M3 one sent');
  PERFORM t.ok((SELECT state FROM public.continuity_jobs WHERE id = x) = 'done', 'M3 job done');
  SELECT * INTO nrow FROM public.notifications WHERE user_id = t.u('S1') AND category = 'continuity';
  PERFORM t.ok(nrow.title = 'تذكير: موعد قريب في الاستمرارية' AND nrow.type = 'info'
               AND nrow.link = '/admin/continuity.html?record=' || a::text, 'M3 fixed title and record link');
  PERFORM t.ok(nrow.message LIKE 'متابعة باسمك موعدها % (Africa/Cairo) · الأولوية: عالية', 'M3 fixed message: ' || nrow.message);
  PERFORM t.tick();
  PERFORM t.ok(t.notes(t.u('S1')) = 1, 'M3 no duplicate');
  PERFORM t.ok(t.evs(a, 'job_fired') = 1, 'M3 event');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS M3 reminder';
END $$;

-- ============================================================================
-- M4 لا دفعة قديمة
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); x bigint;
BEGIN
  x := t.job(a, 'overdue_alert');
  UPDATE public.continuity_jobs SET run_at = now() - interval '7 hours' WHERE id = x;
  PERFORM t.tick();
  PERFORM t.ok((SELECT state || ':' || reason FROM public.continuity_jobs WHERE id = x) = 'superseded:late', 'M4 stale reminder after downtime is dropped');
  PERFORM t.ok(t.notes(t.u('S1')) = 1, 'M4 nothing sent');
  RAISE NOTICE 'PASS M4 late';
END $$;

-- ============================================================================
-- M5 التصعيد وساعات العمل
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); x bigint; v_dow int;
BEGIN
  PERFORM t.ctx('admin');
  -- R3: بتوقيت القاهرة. الجمعة 18:00 ⇒ السبت 09:00؛ داخل الساعات ⇒ نفس اللحظة؛ بلا صفوف ⇒ نفس اللحظة
  PERFORM t.ok(public._continuity_next_working('2026-10-16 18:00+03') = '2026-10-16 18:00+03', 'M5 no working hours ⇒ no deferral');
  INSERT INTO public.working_hours (day_of_week, is_working_day, start_time, end_time)
  SELECT d, d <> 6, '09:00', '17:00' FROM generate_series(0, 6) d;
  PERFORM t.ok(public._continuity_next_working('2026-10-16 10:00+03') = '2026-10-16 10:00+03', 'M5 inside hours');
  PERFORM t.ok(public._continuity_next_working('2026-10-16 18:00+03') = '2026-10-18 09:00+03', 'M5 Friday evening ⇒ Sunday 09:00 (Saturday closed)');
  PERFORM t.ok(public._continuity_next_working('2026-10-15 05:00+03') = '2026-10-15 09:00+03', 'M5 early morning ⇒ same day 09:00');
  -- تأجيل حقيقي: ساعات العمل يوم غير اليوم
  DELETE FROM public.working_hours;
  v_dow := (extract(dow from now() at time zone 'Africa/Cairo')::int + 2) % 7;
  INSERT INTO public.working_hours (day_of_week, is_working_day, start_time, end_time) VALUES (v_dow, true, '09:00', '17:00');
  PERFORM t.pol('{"escalation_enabled": true}');
  x := t.job(a, 'escalation_overdue');
  PERFORM t.due_now(x);
  PERFORM t.tick();
  PERFORM t.ok((SELECT state = 'pending' AND reason = 'deferred_to_working_hours' AND run_at > now() FROM public.continuity_jobs WHERE id = x), 'M5 escalation deferred');
  PERFORM t.ok(t.evs(a, 'job_deferred') = 1 AND t.notes(t.u('EA')) = 0, 'M5 deferral logged, nothing sent');
  -- بلا احترام ساعات العمل ⇒ يصعَّد الآن للمشرفين (R4) عدا المالك
  PERFORM t.pol('{"respect_working_hours": false}');
  x := t.job(a, 'escalation_overdue');
  PERFORM t.due_now(x);
  PERFORM t.tick();
  PERFORM t.ok((SELECT string_agg(recipient_id::text, ',' ORDER BY recipient_id) FROM public.continuity_deliveries WHERE job_id = x)
               = (SELECT string_agg(u::text, ',' ORDER BY u) FROM unnest(array[t.u('EA'), t.u('OW')]) u), 'M5 R4 supervisors = elevated admin + owner');
  PERFORM t.ok(t.notes(t.u('EA')) = 1 AND t.notes(t.u('OW')) = 1 AND t.notes(t.u('AD')) = 0, 'M5 plain admin not a supervisor');
  -- R4: الحساب غير النشط لا يُصعَّد له
  PERFORM t.act(NULL);
  UPDATE public.profiles SET ban_status = 'banned' WHERE id = t.u('EA');
  PERFORM t.ok(NOT t.u('EA') IN (SELECT public._continuity_supervisor_recipients()), 'M5 banned elevated admin excluded');
  UPDATE public.profiles SET ban_status = NULL WHERE id = t.u('EA');
  PERFORM t.ctx('admin');
  PERFORM t.ok((SELECT type FROM public.notifications WHERE user_id = t.u('EA') AND category = 'continuity') = 'warning', 'M5 warning type');
  PERFORM t.ok(t.evs(a, 'escalated') = 1, 'M5 escalated event');
  -- المالك نفسه مشرف ⇒ لا يصله التصعيد عن سجله
  PERFORM t.call(t.u('EA'), format('public.continuity_assign(%L::uuid, %L::uuid, %L::uuid, %s)', a, t.u('EA'), t.u('T1'), t.ver2(a)));
  x := t.job(a, 'escalation_overdue');
  PERFORM t.due_now(x);
  PERFORM t.tick();
  PERFORM t.ok((SELECT count(*) FROM public.continuity_deliveries WHERE job_id = x AND recipient_id = t.u('EA')) = 0, 'M5 owner excluded');
  PERFORM t.call(t.u('EA'), format('public.continuity_assign(%L::uuid, %L::uuid, %L::uuid, %s)', a, t.u('S1'), t.u('T1'), t.ver2(a)));
  PERFORM t.pol('{"respect_working_hours": true}');
  DELETE FROM public.working_hours;
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS M5 escalation';
END $$;

-- ============================================================================
-- M6 طلب التسليم
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); h uuid; x bigint; nrow record;
BEGIN
  PERFORM t.ctx('admin');
  h := (t.call(t.u('S1'), t.req_sql(a, t.u('S3'), 'تغطية', 'M6')) -> 'handover' ->> 'id')::uuid;
  x := (SELECT id FROM public.continuity_jobs WHERE handover_id = h AND kind = 'handover_reminder' AND state = 'pending');
  PERFORM t.due_now(x);
  PERFORM t.tick();
  SELECT * INTO nrow FROM public.notifications WHERE user_id = t.u('S3') AND category = 'continuity';
  PERFORM t.ok(nrow.title = 'طلب بانتظار ردك في الاستمرارية' AND nrow.link = '/admin/continuity.html', 'M6 target reminded, no record link: ' || coalesce(nrow.link, '-'));
  PERFORM t.call(t.u('S3'), format('public.continuity_handover_decide(%L::uuid, ''decline'', ''مشغول'', %s)', h, t.ver2(a)));
  PERFORM t.ok((SELECT state || ':' || reason FROM public.continuity_jobs WHERE handover_id = h AND kind = 'escalation_handover') = 'superseded:replanned', 'M6 decision supersedes escalation');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS M6 handover';
END $$;

-- ============================================================================
-- M7 مستلم غير مؤهل
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); x bigint;
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.call(t.u('S1'), t.upd_sql(a, jsonb_build_object('due', t.due_in(180))));
  x := t.job(a, 'due_reminder');
  PERFORM t.due_now(x);
  PERFORM t.act(NULL);
  UPDATE public.profiles SET ban_status = 'banned' WHERE id = t.u('S1');
  PERFORM t.tick();
  PERFORM t.ok((SELECT state || ':' || reason FROM public.continuity_jobs WHERE id = x) = 'done:no_recipient', 'M7 no recipient');
  PERFORM t.ok(t.notes(t.u('S1')) = 1, 'M7 nothing sent to a banned owner');
  UPDATE public.profiles SET ban_status = NULL WHERE id = t.u('S1');
  RAISE NOTICE 'PASS M7 ineligible';
END $$;

-- ============================================================================
-- M8 فشل التسليم
-- ============================================================================
CREATE FUNCTION t.fail_notif() RETURNS trigger LANGUAGE plpgsql AS $$
begin
  if new.user_id = '00000000-0000-4000-8000-0000000000a7' and new.category = 'continuity' then raise exception 'boom' using errcode = 'XX001'; end if;
  return new;
end $$;
CREATE TRIGGER t_fail_notif BEFORE INSERT ON public.notifications FOR EACH ROW EXECUTE FUNCTION t.fail_notif();
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); h uuid; x bigint; dl record;
BEGIN
  PERFORM t.ctx('admin');
  h := (t.call(t.u('S1'), t.req_sql(a, t.u('S3'), 'تغطية', 'M8')) -> 'handover' ->> 'id')::uuid;
  x := (SELECT id FROM public.continuity_jobs WHERE handover_id = h AND kind = 'handover_reminder' AND state = 'pending');
  PERFORM t.due_now(x);
  PERFORM t.tick();
  SELECT * INTO dl FROM public.continuity_deliveries WHERE job_id = x;
  PERFORM t.ok(dl.state = 'failed' AND dl.attempts = 1 AND dl.last_error = 'XX001' AND dl.next_attempt_at > now(), 'M8 failed with backoff');
  UPDATE public.continuity_deliveries SET next_attempt_at = now() - interval '1 second' WHERE id = dl.id;
  PERFORM t.tick();
  UPDATE public.continuity_deliveries SET next_attempt_at = now() - interval '1 second' WHERE id = dl.id;
  PERFORM t.tick();
  PERFORM t.ok((SELECT state || ':' || attempts FROM public.continuity_deliveries WHERE id = dl.id) = 'dead:3', 'M8 dead after 3');
  PERFORM t.ok(t.evs(a, 'delivery_dead') = 1, 'M8 event');
  PERFORM t.call(t.u('S1'), format('public.continuity_handover_cancel(%L::uuid, null)', h));
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS M8 delivery failure';
END $$;
DROP TRIGGER t_fail_notif ON public.notifications;

-- ============================================================================
-- M9 الخصوصية
-- ============================================================================
DO $$
BEGIN
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.notifications WHERE category = 'continuity'
                            AND (title || message || coalesce(link, '')) ~ '(TITLEMARK|SUMMARYMARK|MARKER|اتصل بالعميل|عميل واحد|01000)'), 'M9 no record or customer text');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.continuity_events WHERE kind IN ('job_fired', 'escalated', 'job_deferred', 'delivery_dead', 'job_failed')
                            AND payload::text ~ '(TITLEMARK|SUMMARYMARK|MARKER|اتصل)'), 'M9 events identifiers only');
  RAISE NOTICE 'PASS M9 privacy';
END $$;

-- ============================================================================
-- M10 تزامن حقيقي: منفّذان معًا ⇒ إشعار واحد
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); x bigint;
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.call(t.u('S1'), t.upd_sql(a, jsonb_build_object('due', t.due_in(240))));
  x := t.job(a, 'due_reminder');
  PERFORM t.due_now(x);
  INSERT INTO t.saved VALUES ('M10', x::text);
  PERFORM t.act(NULL);
END $$;
CREATE FUNCTION t.tconn(p_name text) RETURNS void LANGUAGE plpgsql AS $$
begin
  perform t.dblink_connect(p_name, format('dbname=%s port=%s host=%s user=postgres', current_database(),
            current_setting('port'), split_part(current_setting('unix_socket_directories'), ',', 1)));
end $$;
SELECT t.tconn('k1');
SELECT t.tconn('k2');
SELECT t.dblink_send_query('k1', 'select public.continuity_tick()');
SELECT t.dblink_send_query('k2', 'select public.continuity_tick()');
SELECT pg_sleep(0.8);
SELECT count(*) >= 0 FROM t.dblink_get_result('k1') AS r(x jsonb);
SELECT count(*) >= 0 FROM t.dblink_get_result('k2') AS r(x jsonb);
SELECT t.dblink_disconnect('k1');
SELECT t.dblink_disconnect('k2');
DO $$
DECLARE x bigint := (SELECT v::bigint FROM t.saved WHERE k = 'M10');
BEGIN
  PERFORM t.ok((SELECT count(*) FROM public.continuity_deliveries WHERE job_id = x) = 1
               AND (SELECT count(*) FROM public.notifications n JOIN public.continuity_deliveries d ON d.notification_id = n.id WHERE d.job_id = x) = 1, 'M10 exactly one notification');
  RAISE NOTICE 'PASS M10 concurrency';
END $$;

-- ============================================================================
-- M11 الاحتفاظ (R7)
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); old_j bigint; new_j bigint; res jsonb; pend int;
BEGIN
  INSERT INTO public.continuity_jobs (record_id, workspace_id, kind, run_at, basis, dedupe_key, state, fired_at, created_at, updated_at)
  SELECT a, workspace_id, 'overdue_alert', now() - interval '200 days', '{}', 'old-test', 'done', now() - interval '200 days', now() - interval '200 days', now() - interval '200 days'
    FROM public.continuity_records WHERE id = a RETURNING id INTO old_j;
  INSERT INTO public.continuity_deliveries (job_id, record_id, recipient_id, template, state, sent_at, created_at, updated_at)
  VALUES (old_j, a, t.u('S1'), 'overdue', 'sent', now() - interval '200 days', now() - interval '200 days', now() - interval '200 days');
  INSERT INTO public.continuity_jobs (record_id, workspace_id, kind, run_at, basis, dedupe_key, state, created_at, updated_at)
  SELECT a, workspace_id, 'overdue_alert', now() - interval '100 days', '{}', 'recent-test', 'done', now() - interval '100 days', now() - interval '100 days'
    FROM public.continuity_records WHERE id = a RETURNING id INTO new_j;
  INSERT INTO public.continuity_deliveries (job_id, record_id, recipient_id, template, state, sent_at, created_at, updated_at)
  VALUES (new_j, a, t.u('S1'), 'overdue', 'sent', now() - interval '100 days', now() - interval '100 days', now() - interval '100 days');
  pend := (SELECT count(*) FROM public.continuity_jobs WHERE state = 'pending');
  PERFORM t.ok(t.err_su(format('delete from public.continuity_jobs where id = %s', new_j)) = '42501', 'M11 direct delete refused');
  res := public.continuity_job_retention_sweep();
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.continuity_jobs WHERE id = old_j) AND EXISTS (SELECT 1 FROM public.continuity_jobs WHERE id = new_j), 'M11 only > 180 days: ' || res::text);
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.continuity_deliveries WHERE job_id = new_j), 'M11 100-day delivery kept');
  PERFORM t.ok((SELECT count(*) FROM public.continuity_jobs WHERE state = 'pending') = pend, 'M11 pending kept');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.continuity_policy_history), 'M11 policy history kept');
  RAISE NOTICE 'PASS M11 retention';
END $$;

-- ============================================================================
-- M12 الثبات والقراءة
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); x bigint; j jsonb;
BEGIN
  x := (SELECT id FROM public.continuity_jobs WHERE record_id = a AND state = 'done' LIMIT 1);
  PERFORM t.ok(t.err_su(format('update public.continuity_jobs set state = ''pending'' where id = %s', x)) = '42501', 'M12 terminal immutable');
  PERFORM t.ok(t.err_su(format('update public.continuity_jobs set dedupe_key = ''x'' where id = %s', t.job(a, 'overdue_alert'))) = '42501', 'M12 identity fixed');
  PERFORM t.ok(t.err_su(format('update public.continuity_deliveries set recipient_id = %L where state = ''sent''', t.u('GR'))) = '42501', 'M12 delivery immutable');
  PERFORM t.ctx('admin');
  j := t.call(t.u('S3'), format('public.continuity_reminders_for(%L::uuid)', a));
  PERFORM t.ok((j ->> 'reminders')::boolean AND jsonb_array_length(j -> 'upcoming') >= 1 AND jsonb_array_length(j -> 'recent') >= 1, 'M12 a reader sees reminders');
  PERFORM t.ok(j::text !~ '(TITLEMARK|SUMMARYMARK|MARKER)', 'M12 no text');
  PERFORM t.ok(t.err(t.u('GR'), format('public.continuity_reminders_for(%L::uuid)', a)) = 'P0002', 'M12 stranger not_found');
  PERFORM t.ok(t.err(t.u('S1'), 'public.continuity_tick()') = '42501', 'M12 users cannot tick');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS M12 immutability and read';
END $$;

-- ============================================================================
-- RERUN
-- ============================================================================
CREATE TABLE t.fpm AS SELECT t.fp094() AS v, (SELECT count(*) FROM public.continuity_jobs) AS n;
\i migrations/094_continuity_reminders.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok((SELECT v FROM t.fpm) = t.fp094(), 'RERUN identical objects');
  PERFORM t.ok((SELECT n FROM t.fpm) = (SELECT count(*) FROM public.continuity_jobs), 'RERUN no new jobs');
  RAISE NOTICE 'PASS RERUN';
END $$;

-- ============================================================================
-- RB
-- ============================================================================
\set rb094_sql `cat migrations/_rollback/094_continuity_reminders.down.sql`
SELECT set_config('t.rb094_sql', :'rb094_sql', false) IS NOT NULL;
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
  c := t.try('rb94', current_setting('t.rb094_sql'));
  PERFORM t.ok(c LIKE '%rollback_discard_data%' AND to_regclass('public.continuity_jobs') IS NOT NULL, 'RB refused with deliveries: ' || c);
  RAISE NOTICE 'PASS RB refuses without consent';
END $$;
SET continuity.rollback_discard_data = 'on';
\i migrations/_rollback/094_continuity_reminders.down.sql
RESET continuity.rollback_discard_data;
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA');
BEGIN
  PERFORM t.ok((SELECT NOT reminders_enabled AND NOT escalation_enabled FROM public._continuity_policy_row()), 'RB switches off');
  PERFORM t.ok((SELECT changed FROM public.continuity_policy_history ORDER BY id DESC LIMIT 1) = array['escalation_enabled', 'reminders_enabled'], 'RB recorded');
  PERFORM t.ok(NOT public._continuity_capability_installed('reminders'), 'RB capability gone');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.notifications WHERE category = 'continuity'), 'RB sent notifications stay');
  PERFORM t.ctx('admin');
  PERFORM t.call(t.u('S1'), t.upd_sql(a, jsonb_build_object('due', t.due_in(300))));
  PERFORM t.ok((t.call(t.u('S1'), format('public.continuity_get(%L::uuid)', a)) -> 'record' ->> 'id')::uuid = a, 'RB records work without 094');
  PERFORM t.ok(t.err(t.u('OW'), format('public.continuity_set_policies(%L::jsonb, %s)', '{"reminders_enabled": true}',
               (SELECT version FROM public._continuity_policy_row()))) = '0A000', 'RB enabling refused again');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS RB rollback';
END $$;
\i migrations/094_continuity_reminders.sql
SET search_path = public, extensions;
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA');
BEGIN
  PERFORM t.ok(public._continuity_capability_installed('reminders') AND t.jobs(a) = 'due_reminder,escalation_overdue,overdue_alert', 'RB re-apply plans again');
  RAISE NOTICE 'PASS RB re-apply';
  RAISE NOTICE 'ALL 094 reminder tests passed';
END $$;
