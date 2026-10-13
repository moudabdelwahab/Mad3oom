-- ============================================================================
-- مدعوم — الاستمرارية: إجراءات المشاركة التعاونية (093، 082b) على نسخة مطابقة لشكل الإنتاج
-- (073 → 081 → 087 → 089 → 091 → 093):
--
--   K0  التثبيت: الترقيعات الثماني على نص ما بعد 091، الجداول والدوال الداخلية مغلقة، المفتاح مطفأ
--   K1  المفتاح مطفأ: لا طلب تعاون بإجراءات؛ المراجعة كما هي. تشغيله من الإعدادات
--   K2  قواعد الطلب: الإجراءات والحقول المسموحة ومتى تُطلب
--   K3  الملاحظات: خيط المنحة (S-8)، ملاحظة السجل لمن يعدّل، من يرى السجل يرى الكل، الأحداث بلا نص
--   K4  الاقتراحات: الحقول المسموحة فقط وبنفس التحقق؛ المالك يطبّق عبر continuity_update (فحص النسخة) أو يرفض؛ السحب
--   K5  التعديل المباشر: الحقول المسموحة فقط، فحص النسخة، قاعدة المتابعة، لا قراءة ولا تعديل عادي
--   K6  إضافة رسائل: بوصول المستلم نفسه، تظهر لمنحته فقط، والمستبعد لا يعود
--   K7  رفع مرفق: لمنحته فقط، ونفس فحص الملف
--   K8  إطفاء المفتاح يوقف كل كتابة ويبقي العرض
--   K9  السحب والتضييق يوقفان الكتابة فورًا؛ الاقتراحات المعلقة تبقى للمالك
--   K10 الثبات وعدم الخلط بين السجلات
--   RERUN، RB (التراجع يرفض بلا موافقة، ويعيد البصمات الثماني، وسلوك 091 يعود)
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

-- ── أدوات 093 ─────────────────────────────────────────────────────────────
SET check_function_bodies = off;
CREATE FUNCTION t.fp8() RETURNS text LANGUAGE sql AS $$
  select string_agg(p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid)), ',' order by p.oid::regprocedure::text)
    from pg_proc p where p.oid in ('public._continuity_scope_resolve(public.continuity_records,jsonb,text)'::regprocedure,
      'public._continuity_scope_narrower(public.continuity_handover_scopes,public.continuity_handover_scopes,timestamp with time zone,timestamp with time zone)'::regprocedure,
      'public.continuity_handover_amend_scope(uuid,jsonb)'::regprocedure, 'public._continuity_scope_source_ids(public.continuity_handover_scopes)'::regprocedure,
      'public._continuity_scope_attachment_ids(public.continuity_handover_scopes)'::regprocedure, 'public.continuity_shared_get(uuid)'::regprocedure,
      'public.continuity_handover_scope(uuid)'::regprocedure, 'public.continuity_set_policies(jsonb,integer)'::regprocedure) $$;
CREATE FUNCTION t.fp093() RETURNS text LANGUAGE sql AS $$
  select md5(concat_ws('#',
    (select string_agg(p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid)) || ':' || coalesce(p.proacl::text, ''), ',' order by p.oid::regprocedure::text)
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' and p.proname like '%continuity%'),
    (select string_agg(conrelid::regclass::text || conname || ':' || pg_get_constraintdef(oid), ',' order by conrelid::regclass::text, conname) from pg_constraint
      where conrelid::regclass::text in ('continuity_notes', 'continuity_change_proposals', 'continuity_grant_items', 'continuity_policies')),
    (select string_agg(tgrelid::regclass::text || tgname, ',' order by tgrelid::regclass::text, tgname) from pg_trigger
      where tgrelid::regclass::text in ('continuity_notes', 'continuity_change_proposals', 'continuity_grant_items') and not tgisinternal))) $$;
CREATE FUNCTION t.collab(p_srcs uuid[], p_fields text[] DEFAULT array['next_action', 'priority'],
                         p_actions text[] DEFAULT array['view', 'note', 'propose', 'edit_fields', 'add_source']) RETURNS jsonb LANGUAGE sql AS $$
  select jsonb_build_object('sources', to_jsonb(p_srcs), 'actions', to_jsonb(p_actions), 'editable_fields', to_jsonb(p_fields)) $$;
CREATE FUNCTION t.note_sql(p_rec uuid, p_body text, p_h uuid) RETURNS text LANGUAGE sql AS $$
  select format('public.continuity_note_add(%L::uuid, %L, %L::uuid)', p_rec, p_body, p_h) $$;
CREATE FUNCTION t.propose_sql(p_rec uuid, p_patch jsonb) RETURNS text LANGUAGE sql AS $$
  select format('public.continuity_shared_propose(%L::uuid, %L::jsonb, null)', p_rec, p_patch) $$;
CREATE FUNCTION t.supd_sql(p_rec uuid, p_patch jsonb, p_ver int DEFAULT NULL) RETURNS text LANGUAGE sql AS $$
  select format('public.continuity_shared_update(%L::uuid, %L::jsonb, %s)', p_rec, p_patch, coalesce(p_ver, t.ver2(p_rec))) $$;
CREATE FUNCTION t.decide_p_sql(p_prop uuid, p_dec text, p_ver int DEFAULT NULL) RETURNS text LANGUAGE sql AS $$
  select format('public.continuity_proposal_decide(%L::uuid, %L, null, %s)', p_prop, p_dec,
                coalesce(p_ver, (select t.ver2(record_id) from public.continuity_change_proposals where id = p_prop))) $$;
CREATE FUNCTION t.sattach_sql(p_rec uuid, p_msgs uuid[]) RETURNS text LANGUAGE sql AS $$
  select format('public.continuity_shared_attach_sources(%L::uuid, %L::jsonb, %s, false)', p_rec,
                (select jsonb_agg(jsonb_build_object('type', 'mad3oom_message', 'provider', 'mad3oom', 'internal', jsonb_build_object('chat_message_id', m))) from unnest(p_msgs) m),
                t.ver2(p_rec)) $$;
CREATE FUNCTION t.src_of_msg(p_rec uuid, p_msg uuid) RETURNS uuid LANGUAGE sql AS $$
  select id from public.continuity_sources where record_id = p_rec and chat_message_id = p_msg $$;
RESET check_function_bodies;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- رسالة جديدة في SA (يقرؤها S2 عبر T2) ورسالة في SC (فريق T1، لا يقرؤها S2)
INSERT INTO public.chat_messages (id, session_id, sender_id, message_text, is_admin_reply, created_at) VALUES
  ('3e550000-0000-4000-8000-0000000000a4', '5e550000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1',
   'MARKERA4 رسالة جديدة بعد المشاركة', false, '2026-10-07 09:00+00');
INSERT INTO t.saved SELECT 'fp8_before', t.fp8();

\i migrations/093_continuity_collab_actions.sql
SET search_path = public, extensions;

-- ============================================================================
-- K0 التثبيت
-- ============================================================================
DO $$
BEGIN
  PERFORM t.ok((SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.prokind = 'f'
                   AND strpos(pg_get_functiondef(p.oid), '093_continuity_collab_actions') > 0) = 8, 'K0 eight patches');
  PERFORM t.ok(t.err_stmt(t.u('S1'), 'select count(*) from public.continuity_notes') = '42501', 'K0 notes closed');
  PERFORM t.ok(t.err_stmt(t.u('S1'), 'select count(*) from public.continuity_change_proposals') = '42501', 'K0 proposals closed');
  PERFORM t.ok(t.err_stmt(t.u('S1'), 'select count(*) from public.continuity_grant_items') = '42501', 'K0 grant items closed');
  PERFORM t.ok(NOT has_function_privilege('authenticated', 'public._continuity_collab_patch(public.continuity_records,jsonb,text[])', 'EXECUTE'), 'K0 internal closed');
  PERFORM t.ok(NOT has_function_privilege('service_role', 'public.continuity_shared_update(uuid,jsonb,integer)', 'EXECUTE'), 'K0 not service');
  PERFORM t.ok(t.err_anon('select public.continuity_delegation_settings()') = '42501', 'K0 anon refused');
  PERFORM t.ok((SELECT delegation_allow_collab FROM public._continuity_policy_row()) = false, 'K0 collab off by default');
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.call(t.u('S2'), 'public.continuity_delegation_settings()') = '{"collab": false, "max_minutes": 10080, "allow_ongoing": false, "default_minutes": 240, "session_max_minutes": 720}'::jsonb, 'K0 settings');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS K0 install';
END $$;

-- ============================================================================
-- K1 المفتاح مطفأ
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); j jsonb; h uuid;
BEGIN
  PERFORM t.ctx('admin');
  j := t.errj(t.u('S1'), t.hreq_sql(a, t.u('S2'), 'collab', t.collab(array[t.src(a, 1)]), 'K1a'));
  PERFORM t.ok(j ->> 'state' = '0A000' AND j ->> 'field' = 'collab', 'K1 collab actions refused while off: ' || j::text);
  -- collab بالعرض فقط والمراجعة كما في 091
  h := t.hreq(t.u('S1'), a, t.u('S2'), 'collab', jsonb_build_object('sources', jsonb_build_array(t.src(a, 1))), 'K1b');
  PERFORM t.ok((SELECT actions FROM public.continuity_handover_scopes WHERE handover_id = h) = array['view'], 'K1 view-only collab still works');
  PERFORM t.call(t.u('S1'), format('public.continuity_handover_cancel(%L::uuid, null)', h));
  PERFORM t.pol('{"delegation_allow_collab": true}');
  PERFORM t.ok((t.call(t.u('S2'), 'public.continuity_delegation_settings()') ->> 'collab')::boolean, 'K1 turned on from the policies');
  PERFORM t.ok((SELECT changed FROM public.continuity_policy_history ORDER BY id DESC LIMIT 1) = array['delegation_allow_collab'], 'K1 policy history');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS K1 switch';
END $$;

-- ============================================================================
-- K2 قواعد الطلب
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); h uuid; s1 uuid; s2 uuid;
BEGIN
  PERFORM t.ctx('admin');
  s1 := t.src(a, 1); s2 := t.src(a, 2);
  PERFORM t.ok((t.errj(t.u('S1'), t.hreq_sql(a, t.u('S2'), 'collab', jsonb_build_object('sources', jsonb_build_array(s1), 'actions', '["view","note"]'::jsonb, 'editable_fields', '["priority"]'::jsonb), 'K2a'))) ->> 'reason' = 'requires_action', 'K2 fields need propose/edit');
  PERFORM t.ok((t.errj(t.u('S1'), t.hreq_sql(a, t.u('S2'), 'collab', jsonb_build_object('sources', jsonb_build_array(s1), 'actions', '["view","edit_fields"]'::jsonb), 'K2b'))) ->> 'reason' = 'required', 'K2 edit needs fields');
  PERFORM t.ok((t.errj(t.u('S1'), t.hreq_sql(a, t.u('S2'), 'collab', t.collab(array[s1], array['title']), 'K2c'))) ->> 'field' = 'scope.editable_fields', 'K2 title not editable');
  PERFORM t.ok((t.errj(t.u('S1'), t.hreq_sql(a, t.u('S2'), 'collab', t.collab(array[s1], array['waiting_on']), 'K2d'))) ->> 'field' = 'scope.editable_fields', 'K2 waiting_on not editable');
  PERFORM t.ok((t.errj(t.u('S1'), t.hreq_sql(a, t.u('S2'), 'review', t.collab(array[s1]), 'K2e'))) ->> 'reason' = 'review_is_view_only', 'K2 review stays view only');
  h := t.grant(t.u('S1'), a, t.u('S2'), t.collab(array[s1, s2]), 'K2-main', 'collab');
  PERFORM t.ok((SELECT row(actions, editable_fields)::text FROM public.continuity_handover_scopes WHERE handover_id = h)
               = '("{view,note,propose,edit_fields,add_source}","{next_action,priority}")', 'K2 scope stored');
  PERFORM t.ok(t.shared(t.u('S2'), a) -> 'collab' = '{"enabled": true, "editable_fields": ["next_action", "priority"]}'::jsonb, 'K2 shared view tells the fields');
  INSERT INTO t.saved VALUES ('HK', h::text);
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS K2 request';
END $$;

-- ============================================================================
-- K3 الملاحظات
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); h uuid := (SELECT v::uuid FROM t.saved WHERE k = 'HK'); j jsonb;
BEGIN
  PERFORM t.ctx('admin');
  j := t.call(t.u('S2'), t.note_sql(a, '  NOTEMARK1 راجعت رقم الطلب  ', h));
  PERFORM t.ok(j ->> 'body' = 'NOTEMARK1 راجعت رقم الطلب' AND (j ->> 'handover_id')::uuid = h, 'K3 grantee note in the grant thread');
  PERFORM t.ok(t.err(t.u('S2'), t.note_sql(a, 'x', NULL)) = 'P0002', 'K3 grantee has no record-level note');
  PERFORM t.call(t.u('S1'), t.note_sql(a, 'REPLYMARK شكرًا', h));
  PERFORM t.call(t.u('S1'), t.note_sql(a, 'RECORDMARK ملاحظة داخلية', NULL));
  PERFORM t.ok(t.err(t.u('S3'), t.note_sql(a, 'x', NULL)) = '42501', 'K3 a reader who cannot edit cannot add notes');
  PERFORM t.ok(t.err(t.u('GR'), t.note_sql(a, 'x', NULL)) = 'P0002', 'K3 stranger not_found');
  PERFORM t.ok(t.err(t.u('S1'), t.note_sql(a, repeat('x', 2001), NULL)) = '22023', 'K3 length');
  PERFORM t.ok(t.err(t.u('S1'), t.note_sql(a, '   ', NULL)) = '22023', 'K3 empty');
  j := t.shared(t.u('S2'), a);
  PERFORM t.ok(jsonb_array_length(j -> 'notes') = 2 AND j::text LIKE '%REPLYMARK%' AND j::text NOT LIKE '%RECORDMARK%', 'K3 S-8: own thread only');
  PERFORM t.ok(jsonb_array_length(t.call(t.u('S3'), format('public.continuity_notes_for(%L::uuid)', a))) = 3, 'K3 readers see every note');
  PERFORM t.ok(t.err(t.u('S2'), format('public.continuity_notes_for(%L::uuid)', a)) = 'P0002', 'K3 grantee cannot list record notes');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.continuity_events WHERE record_id = a AND kind = 'note_added' AND payload::text LIKE '%MARK%'), 'K3 events hash only');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS K3 notes';
END $$;

-- ============================================================================
-- K4 الاقتراحات
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); h uuid := (SELECT v::uuid FROM t.saved WHERE k = 'HK'); p uuid; q uuid; j jsonb;
BEGIN
  PERFORM t.ctx('admin');
  j := t.call(t.u('S2'), t.propose_sql(a, '{"priority": 1}'));
  p := (j -> 'proposals' -> 0 ->> 'id')::uuid;
  PERFORM t.ok(j -> 'proposals' -> 0 ->> 'state' = 'pending', 'K4 proposed');
  PERFORM t.ok((t.errj(t.u('S2'), t.propose_sql(a, '{"summary": "x"}'))) ->> 'reason' = 'not_in_scope', 'K4 field outside scope');
  PERFORM t.ok((t.errj(t.u('S2'), t.propose_sql(a, '{"owner_id": "x"}'))) ->> 'reason' = 'not_in_scope', 'K4 owner never');
  PERFORM t.ok(t.err(t.u('S2'), t.propose_sql(a, '{"priority": 9}')) = '22023', 'K4 same validation as update');
  PERFORM t.ok(t.err(t.u('S2'), t.propose_sql(a, '{"next_action": ""}')) = '22023', 'K4 follow-up rule');
  PERFORM t.ok(jsonb_array_length(t.call(t.u('S3'), format('public.continuity_proposals_for(%L::uuid)', a))) = 1, 'K4 readers see proposals');
  PERFORM t.ok(t.err(t.u('S3'), t.decide_p_sql(p, 'apply')) = '42501', 'K4 a reader cannot apply');
  PERFORM t.ok(t.err(t.u('S3'), t.decide_p_sql(p, 'reject')) = '42501', 'K4 a reader cannot reject');
  PERFORM t.ok(t.err(t.u('S2'), t.decide_p_sql(p, 'apply')) = 'P0002', 'K4 the proposer cannot decide');
  PERFORM t.ok(t.err(t.u('S1'), t.decide_p_sql(p, 'apply', t.ver2(a) - 1)) = '40001', 'K4 stale version');
  PERFORM t.ok((SELECT state FROM public.continuity_change_proposals WHERE id = p) = 'pending', 'K4 still pending after conflict');
  j := t.call(t.u('S1'), t.decide_p_sql(p, 'apply'));
  PERFORM t.ok(j -> 'proposal' ->> 'state' = 'applied' AND (SELECT priority FROM public.continuity_records WHERE id = a) = 1, 'K4 applied through continuity_update');
  PERFORM t.ok(t.err(t.u('S1'), t.decide_p_sql(p, 'reject')) = '55000', 'K4 decided once');
  q := (t.call(t.u('S2'), t.propose_sql(a, '{"next_action": "اتصل بكرة"}')) -> 'proposals' -> 0 ->> 'id')::uuid;
  PERFORM t.call(t.u('S1'), t.decide_p_sql(q, 'reject'));
  PERFORM t.ok((SELECT state FROM public.continuity_change_proposals WHERE id = q) = 'rejected'
               AND (SELECT next_action FROM public.continuity_records WHERE id = a) <> 'اتصل بكرة', 'K4 rejected changes nothing');
  q := (t.call(t.u('S2'), t.propose_sql(a, '{"priority": 2}')) -> 'proposals' -> 0 ->> 'id')::uuid;
  PERFORM t.ok(t.err(t.u('S1'), format('public.continuity_proposal_withdraw(%L::uuid)', q)) = 'P0002', 'K4 only the proposer withdraws');
  PERFORM t.call(t.u('S2'), format('public.continuity_proposal_withdraw(%L::uuid)', q));
  PERFORM t.ok((SELECT state FROM public.continuity_change_proposals WHERE id = q) = 'withdrawn', 'K4 withdrawn');
  PERFORM t.ok(t.evs(a, 'change_proposed') = 3 AND t.evs(a, 'change_proposal_applied') = 1 AND t.evs(a, 'change_proposal_rejected') = 1, 'K4 events');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS K4 proposals';
END $$;

-- ============================================================================
-- K5 التعديل المباشر
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); h uuid := (SELECT v::uuid FROM t.saved WHERE k = 'HK'); j jsonb; v int;
BEGIN
  PERFORM t.ctx('admin');
  v := t.ver2(a);
  j := t.call(t.u('S2'), t.supd_sql(a, '{"next_action": "EDITMARK اتصل الساعة 3"}'));
  PERFORM t.ok(j -> 'record' ->> 'next_action' = 'EDITMARK اتصل الساعة 3' AND (j -> 'record' ->> 'version')::int = v + 1, 'K5 edited');
  PERFORM t.ok(t.owner(a) = t.u('S1'), 'K5 owner unchanged');
  PERFORM t.ok((SELECT payload ->> 'via_handover' FROM public.continuity_events WHERE record_id = a AND kind = 'updated' ORDER BY id DESC LIMIT 1) = h::text
               AND (SELECT actor_id FROM public.continuity_events WHERE record_id = a AND kind = 'updated' ORDER BY id DESC LIMIT 1) = t.u('S2'), 'K5 audited');
  PERFORM t.ok((t.errj(t.u('S2'), t.supd_sql(a, '{"summary": "x"}'))) ->> 'reason' = 'not_in_scope', 'K5 field outside scope');
  PERFORM t.ok((t.errj(t.u('S2'), t.supd_sql(a, '{"title": "x"}'))) ->> 'reason' = 'not_in_scope', 'K5 title never');
  PERFORM t.ok(t.err(t.u('S2'), t.supd_sql(a, '{"priority": 2}', v)) = '40001', 'K5 stale version');
  PERFORM t.ok(t.err(t.u('S2'), t.supd_sql(a, '{"next_action": " "}')) = '22023', 'K5 follow-up rule');
  PERFORM t.ok(t.err(t.u('S2'), t.upd_sql(a, '{"priority": 2}')) = 'P0002', 'K5 no normal update');
  PERFORM t.ok(t.err(t.u('S2'), format('public.continuity_get(%L::uuid)', a)) = 'P0002', 'K5 no normal read');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS K5 edit fields';
END $$;

-- ============================================================================
-- K6 إضافة رسائل
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); h uuid := (SELECT v::uuid FROM t.saved WHERE k = 'HK'); g uuid; j jsonb; x uuid;
BEGIN
  PERFORM t.ctx('admin');
  j := t.call(t.u('S2'), t.sattach_sql(a, array['3e550000-0000-4000-8000-0000000000a4']::uuid[]));
  x := t.src_of_msg(a, '3e550000-0000-4000-8000-0000000000a4');
  PERFORM t.ok(x IS NOT NULL AND t.excerpts(j) LIKE '%MARKERA4%' AND jsonb_array_length(j -> 'sources') = 3, 'K6 added and visible to this grant: ' || t.positions(j));
  PERFORM t.ok((SELECT captured_by FROM public.continuity_sources WHERE id = x) = t.u('S2'), 'K6 captured by the grantee');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.continuity_grant_items WHERE handover_id = h AND source_id = x), 'K6 grant item');
  -- رسالة موجودة في السجل ومستبعدة من النطاق (a3) لا تعود
  j := t.call(t.u('S2'), t.sattach_sql(a, array['3e550000-0000-4000-8000-0000000000a3']::uuid[]));
  PERFORM t.ok(j::text NOT LIKE '%MARKERA3%' AND jsonb_array_length(j -> 'sources') = 3, 'K6 excluded message stays excluded');
  -- محادثة لا يقرؤها المستلم
  PERFORM t.ok(t.err(t.u('S2'), t.sattach_sql(a, array['3e550000-0000-4000-8000-0000000000c1']::uuid[])) = 'P0002', 'K6 own conversation access only');
  -- منحة أخرى لا ترى ما أضافه S2 (GR مراجعة a1)
  g := t.grant(t.u('S1'), a, t.u('GR'), jsonb_build_object('sources', jsonb_build_array(t.src(a, 1))), 'K6g');
  PERFORM t.ok(jsonb_array_length(t.shared(t.u('GR'), a) -> 'sources') = 1, 'K6 never added to other grants');
  PERFORM t.ok(t.err(t.u('GR'), t.sattach_sql(a, array['3e550000-0000-4000-8000-0000000000a4']::uuid[])) = 'P0002', 'K6 review grant cannot add');
  PERFORM t.call(t.u('S1'), t.revoke_sql(g));
  -- المالك يرى المصدر في السجل
  PERFORM t.ok((SELECT count(*) FROM jsonb_array_elements(t.get2(t.u('S1'), a) -> 'sources') s WHERE s ->> 'id' = x::text) = 1, 'K6 owner sees it in the record');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS K6 add sources';
END $$;

-- ============================================================================
-- K7 رفع مرفق
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); h uuid := (SELECT v::uuid FROM t.saved WHERE k = 'HK'); b jsonb; att uuid; j jsonb;
BEGIN
  PERFORM t.ctx('admin');
  b := t.call(t.u('S2'), format('public.continuity_shared_attachment_begin(%L::uuid, ''image'', ''image/png'', 1000, ''صورة.png'', %L::uuid)', a, t.key('K7')));
  att := (b -> 'attachment' ->> 'id')::uuid;
  PERFORM t.ok(b -> 'upload' ->> 'path' LIKE '%/' || att::text, 'K7 begin gives the generated path');
  PERFORM t.ok((t.call(t.u('S2'), format('public.continuity_shared_attachment_begin(%L::uuid, ''image'', ''image/png'', 1000, ''صورة.png'', %L::uuid)', a, t.key('K7'))) ->> 'replayed')::boolean, 'K7 replay');
  PERFORM t.ok(t.err(t.u('S2'), format('public.continuity_shared_attachment_commit(%L::uuid, %L)', att, repeat('a', 64))) = '22023', 'K7 object missing');
  INSERT INTO storage.objects (bucket_id, name, metadata) VALUES ('continuity-attachments', b -> 'upload' ->> 'path', '{"size": 1000, "mimetype": "image/png"}');
  j := t.call(t.u('S2'), format('public.continuity_shared_attachment_commit(%L::uuid, %L)', att, repeat('a', 64)));
  PERFORM t.ok(EXISTS (SELECT 1 FROM jsonb_array_elements(j -> 'attachments') x WHERE x ->> 'id' = att::text), 'K7 visible to this grant');
  PERFORM t.ok(t.err(t.u('S2'), t.check_sql(att)) = 'ok', 'K7 edge check works for it');
  PERFORM t.ok(t.err(t.u('S2'), format('public.continuity_shared_attachment_begin(%L::uuid, ''image'', ''text/html'', 10, ''x'', %L::uuid)', a, t.key('K7b'))) = '22023', 'K7 same mime rules');
  PERFORM t.ok(t.err(t.u('S2'), format('public.continuity_attachment_begin(%L::uuid, ''image'', ''image/png'', 10, ''x'', %L::uuid)', a, t.key('K7c'))) = 'P0002', 'K7 the owner path stays closed');
  PERFORM t.ok(t.evs(a, 'attachment_added') >= 3, 'K7 event');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS K7 attachments';
END $$;

-- ============================================================================
-- K8 إطفاء المفتاح
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); h uuid := (SELECT v::uuid FROM t.saved WHERE k = 'HK');
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.pol('{"delegation_allow_collab": false}');
  PERFORM t.ok(t.err(t.u('S2'), t.note_sql(a, 'x', h)) = '0A000', 'K8 note off');
  PERFORM t.ok(t.err(t.u('S2'), t.propose_sql(a, '{"priority": 3}')) = '0A000', 'K8 propose off');
  PERFORM t.ok(t.err(t.u('S2'), t.supd_sql(a, '{"priority": 3}')) = '0A000', 'K8 edit off');
  PERFORM t.ok(t.err(t.u('S2'), t.sattach_sql(a, array['3e550000-0000-4000-8000-0000000000a2']::uuid[])) = '0A000', 'K8 attach off');
  PERFORM t.ok(t.err(t.u('S2'), t.shared_sql(a)) = 'ok' AND (t.shared(t.u('S2'), a) -> 'collab' ->> 'enabled')::boolean = false, 'K8 view stays');
  PERFORM t.pol('{"delegation_allow_collab": true}');
  PERFORM t.ok(t.err(t.u('S2'), t.note_sql(a, 'back', h)) = 'ok', 'K8 on again');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS K8 switch off';
END $$;

-- ============================================================================
-- K9 التضييق والسحب
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); h uuid := (SELECT v::uuid FROM t.saved WHERE k = 'HK'); p uuid; j jsonb;
BEGIN
  PERFORM t.ctx('admin');
  -- التضييق: إزالة edit_fields وحقل priority يسري فورًا
  j := t.call(t.u('S1'), t.amend_sql(h, t.collab(array[t.src(a, 1), t.src(a, 2)], array['next_action'], array['view', 'note', 'propose'])
                                        || '{"expiry": {"kind": "duration", "minutes": 60}}'::jsonb));
  PERFORM t.ok(j ->> 'scope_change' = 'narrowed', 'K9 narrowed');
  PERFORM t.ok(t.err(t.u('S2'), t.supd_sql(a, '{"next_action": "y"}')) = 'P0002', 'K9 edit gone at once');
  PERFORM t.ok((t.errj(t.u('S2'), t.propose_sql(a, '{"priority": 3}'))) ->> 'reason' = 'not_in_scope', 'K9 field gone at once');
  PERFORM t.ok(jsonb_array_length(t.shared(t.u('S2'), a) -> 'sources') = 3, 'K9 grantee-added message kept');
  -- التوسيع (إرجاع edit_fields) مقترح فقط
  j := t.call(t.u('S1'), t.amend_sql(h, t.collab(array[t.src(a, 1), t.src(a, 2)])));
  PERFORM t.ok(j ->> 'scope_change' = 'proposed' AND t.err(t.u('S2'), t.supd_sql(a, '{"next_action": "y"}')) = 'P0002', 'K9 expansion waits');
  -- اقتراح معلّق ثم سحب المنحة
  p := (t.call(t.u('S2'), t.propose_sql(a, '{"next_action": "قبل السحب"}')) -> 'proposals' -> 0 ->> 'id')::uuid;
  PERFORM t.call(t.u('S1'), t.revoke_sql(h));
  PERFORM t.ok(t.err(t.u('S2'), t.note_sql(a, 'x', h)) = 'P0002' AND t.err(t.u('S2'), t.propose_sql(a, '{"next_action": "z"}')) = 'P0002'
               AND t.err(t.u('S2'), t.sattach_sql(a, array['3e550000-0000-4000-8000-0000000000a2']::uuid[])) = 'P0002', 'K9 revoked ⇒ every write refused');
  PERFORM t.ok((SELECT state FROM public.continuity_change_proposals WHERE id = p) = 'pending', 'K9 pending proposal kept for the owner');
  PERFORM t.call(t.u('S1'), t.decide_p_sql(p, 'apply'));
  PERFORM t.ok((SELECT next_action FROM public.continuity_records WHERE id = a) = 'قبل السحب', 'K9 owner still applies it');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS K9 narrow and revoke';
END $$;

-- ============================================================================
-- K10 الثبات وعدم الخلط
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); n uuid; p uuid; gi uuid; other uuid;
BEGIN
  PERFORM t.ctx('admin');
  n := (SELECT id FROM public.continuity_notes LIMIT 1);
  p := (SELECT id FROM public.continuity_change_proposals WHERE state = 'applied' LIMIT 1);
  gi := (SELECT id FROM public.continuity_grant_items LIMIT 1);
  PERFORM t.ok(t.err_su(format('update public.continuity_notes set body = ''x'' where id = %L', n)) = '42501', 'K10 note immutable');
  PERFORM t.ok(t.err_su(format('delete from public.continuity_notes where id = %L', n)) = '42501', 'K10 note no delete');
  PERFORM t.ok(t.err_su(format('update public.continuity_change_proposals set patch = ''{}'' where id = %L', p)) = '42501', 'K10 proposal immutable');
  PERFORM t.ok(t.err_su(format('update public.continuity_change_proposals set state = ''pending'', decided_at = null where id = %L', p)) = '42501', 'K10 decided once');
  PERFORM t.ok(t.err_su(format('delete from public.continuity_grant_items where id = %L', gi)) = '42501', 'K10 grant item no delete');
  other := t.mk2(t.u('S1'), 'K10-other', '{}'::jsonb);
  PERFORM t.ok(t.err_su(format('insert into public.continuity_grant_items (handover_id, record_id, workspace_id, source_id) '
                               || 'select %L, %L, workspace_id, %L from public.continuity_records where id = %L',
                               (SELECT v FROM t.saved WHERE k = 'HK'), a, t.src(other, 1), a)) = '23514', 'K10 foreign source refused');
  PERFORM t.ok(t.err_su(format('insert into public.continuity_notes (record_id, workspace_id, handover_id, body) '
                               || 'select %L, workspace_id, %L, ''x'' from public.continuity_records where id = %L',
                               other, (SELECT v FROM t.saved WHERE k = 'HK'), other)) = '23514', 'K10 note on a grant of another record refused');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS K10 immutability';
END $$;

-- ============================================================================
-- K11 تزامن حقيقي: سحب (جلسة 1، قفل السجل) مقابل تعديل المستلم (جلسة 2) ⇒ التعديل يُرفض بعد القفل
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); h uuid;
BEGIN
  PERFORM t.ctx('admin');
  h := t.grant(t.u('S1'), a, t.u('S2'), t.collab(array[t.src(a, 1)]), 'K11', 'collab');
  INSERT INTO t.saved VALUES ('HK11', h::text);
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
SELECT x FROM t.dblink('one', 'select (' || t.revoke_sql((SELECT v::uuid FROM t.saved WHERE k = 'HK11')) || ')->''handover''->>''state''') AS r(x text);
SELECT t.conn('two', t.u('S2'), false);
SELECT t.dblink_send_query('two', format($q$do $b$ begin perform %s; end $b$;$q$,
       t.supd_sql((SELECT v::uuid FROM t.saved WHERE k = 'RA'), '{"next_action": "RACEMARK"}')));
SELECT pg_sleep(0.5);
SELECT t.dblink_exec('one', 'commit');
SELECT pg_sleep(0.3);
SELECT t.dblink_get_result('two', false) IS NOT NULL;
SELECT t.dblink_disconnect('one');
SELECT t.dblink_disconnect('two');
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA');
BEGIN
  PERFORM t.ok((SELECT next_action FROM public.continuity_records WHERE id = a) IS DISTINCT FROM 'RACEMARK', 'K11 revoked while waiting ⇒ no write');
  PERFORM t.ok((t.h((SELECT v::uuid FROM t.saved WHERE k = 'HK11'))).state = 'revoked', 'K11 revoked');
  RAISE NOTICE 'PASS K11 concurrency';
END $$;

-- ============================================================================
-- RERUN
-- ============================================================================
CREATE TABLE t.fpk AS SELECT t.fp093() AS v;
\i migrations/093_continuity_collab_actions.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok((SELECT v FROM t.fpk) = t.fp093(), 'RERUN identical');
  RAISE NOTICE 'PASS RERUN';
END $$;

-- ============================================================================
-- RB
-- ============================================================================
\set rb093_sql `cat migrations/_rollback/093_continuity_collab_actions.down.sql`
SELECT set_config('t.rb093_sql', :'rb093_sql', false) IS NOT NULL;
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
  c := t.try('rb93', current_setting('t.rb093_sql'));
  PERFORM t.ok(c LIKE '%rollback_discard_data%' AND to_regclass('public.continuity_notes') IS NOT NULL, 'RB refused with collab history: ' || c);
  RAISE NOTICE 'PASS RB refuses without consent';
END $$;
-- منحة تعاون قائمة قبل التراجع: تُسحب
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); h uuid;
BEGIN
  PERFORM t.ctx('admin');
  h := t.grant(t.u('S1'), a, t.u('S2'), t.collab(array[t.src(a, 1)]), 'RB-live', 'collab');
  INSERT INTO t.saved VALUES ('HRB', h::text);
  PERFORM t.act(NULL);
END $$;
SET continuity.rollback_discard_data = 'on';
\i migrations/_rollback/093_continuity_collab_actions.down.sql
RESET continuity.rollback_discard_data;
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); j jsonb;
BEGIN
  PERFORM t.ok(t.fp8() = (SELECT v FROM t.saved WHERE k = 'fp8_before'), 'RB eight functions back to the 091 text');
  PERFORM t.ok((t.h((SELECT v::uuid FROM t.saved WHERE k = 'HRB'))).state = 'revoked', 'RB live collab grant revoked');
  PERFORM t.ok(t.src_of_msg(a, '3e550000-0000-4000-8000-0000000000a4') IS NOT NULL, 'RB grantee-added source stays in the record');
  PERFORM t.ctx('admin');
  j := t.errj(t.u('S1'), t.hreq_sql(a, t.u('S2'), 'collab', t.collab(array[t.src(a, 1)]), 'RB-091'));
  PERFORM t.ok(j ->> 'state' = '0A000' AND j ->> 'field' = 'scope.actions', 'RB 091 behaviour back: ' || j::text);
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS RB rollback';
END $$;
\i migrations/093_continuity_collab_actions.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok((SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.prokind = 'f'
                   AND strpos(pg_get_functiondef(p.oid), '093_continuity_collab_actions') > 0) = 8, 'RB re-apply');
  RAISE NOTICE 'PASS RB re-apply';
  RAISE NOTICE 'ALL 093 collab action tests passed';
END $$;
