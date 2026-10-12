-- ============================================================================
-- مدعوم — الاستمرارية: مرفقات السجل (080) على نسخة مطابقة لشكل الإنتاج
-- (073 + 074 + 076 + 077 + 078 + 079، وسياسات storage كما في الإنتاج)
--
--   A0  قبل 080: تفعيل المرفقات مرفوض (غير مثبتة)
--   A1  التثبيت: مستودع خاص بحدوده، علامة التثبيت، القدرة مطفأة ⇒ لا رفع ولا عرض
--   A2  begin: الأنواع والحدود (3/16/8 MiB بالبايت)، الاسم والمسار من الخادم
--   A3  الصلاحيات: سجل لا تراه، عميل، محظور، anon، مسار الـAPI، سجل مقفول
--   A4  التكرار: نفس المفتاح ⇒ نفس الصف؛ طلب مختلف ⇒ تعارض
--   A5  commit: الملف نفسه (موجود، حجمه، نوعه) لا كلام العميل؛ حدث بلا اسم
--   A6  الحد الأقصى 20، وتزامن حقيقي عند الحد
--   A7  القراءة (سياسة المستودع) والكتابة المباشرة
--   A8  المحذوفات (T1) والنسخة
--   A9  المسح النهائي (T2: مالك المنصة فقط)
--   A10 الثبات حتى للمالك الخارق، وحذف حساب الموظف
--   A11 الكنس: المعلّق، الاحتفاظ (C5/S5)، اختفاء الملف؛ قائمة الحذف لـ service_role فقط
--   A12 مفتاح الإيقاف
--   A13 لا مساس بالشات والصندوق
--   RERUN، V (سياسة كتابة بلا تقييد تُرفض)، RB (ترتيب التراجع، الرفض، النص قبل 080 حرفيًا، إعادة التطبيق)
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

-- ── شكل storage في الإنتاج (أعمدة المستودع، صلاحيات الجدول، وسياسات مقيدة بالمستودع) ──
ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS file_size_limit bigint, ADD COLUMN IF NOT EXISTS allowed_mime_types text[];
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated;
INSERT INTO storage.buckets (id, name, public) VALUES ('chat-attachments', 'chat-attachments', false), ('avatars', 'avatars', true);
CREATE POLICY "Allow authenticated users to upload" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'chat-attachments' AND (storage.foldername(name))[1] = (auth.uid())::text);
CREATE POLICY "Allow Owner Update" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'avatars' AND owner = auth.uid()) WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (auth.uid())::text);
CREATE POLICY public_assets_read ON storage.objects FOR SELECT TO anon, authenticated USING (bucket_id = ANY (ARRAY['avatars']));

SET check_function_bodies = off;
CREATE FUNCTION t.key(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ select md5('ATT-' || p)::uuid $$;
CREATE FUNCTION t.begin_sql(p_rec uuid, p_kind text, p_mime text, p_size bigint, p_name text, p_key text) RETURNS text LANGUAGE sql AS $$
  select format('public.continuity_attachment_begin(%L::uuid, %L, %L, %s, %L, %L::uuid)', p_rec, p_kind, p_mime, p_size, p_name, t.key(p_key)) $$;
CREATE FUNCTION t.att_begin(p uuid, p_rec uuid, p_kind text, p_mime text, p_size bigint, p_name text, p_key text) RETURNS jsonb LANGUAGE sql AS $$
  select t.call(p, t.begin_sql(p_rec, p_kind, p_mime, p_size, p_name, p_key)) $$;
-- «الرفع»: ما تفعله دالة الرفع بمفتاح الخدمة (صف storage.objects ببيانات Storage)
CREATE FUNCTION t.upload(p_path text, p_size bigint, p_mime text, p_age interval DEFAULT '0') RETURNS void LANGUAGE sql AS $$
  insert into storage.objects (bucket_id, name, metadata, created_at)
  values ('continuity-attachments', p_path, jsonb_build_object('size', p_size, 'mimetype', p_mime), now() - p_age) $$;
CREATE FUNCTION t.commit_sql(p_id text, p_sha text DEFAULT repeat('a', 64)) RETURNS text LANGUAGE sql AS $$
  select format('public.continuity_attachment_commit(%L::uuid, %L)', p_id, p_sha) $$;
-- رفع كامل لمرفق صغير: begin ← upload ← commit ⇒ معرّف المرفق
CREATE FUNCTION t.att(p uuid, p_rec uuid, p_key text, p_kind text DEFAULT 'image', p_mime text DEFAULT 'image/png',
                      p_size bigint DEFAULT 1000, p_name text DEFAULT 'صورة.png') RETURNS uuid LANGUAGE plpgsql AS $$
declare b jsonb;
begin
  b := t.att_begin(p, p_rec, p_kind, p_mime, p_size, p_name, p_key);
  perform t.upload(b -> 'upload' ->> 'path', p_size, p_mime);
  perform t.call(p, t.commit_sql(b -> 'attachment' ->> 'id'));
  return (b -> 'attachment' ->> 'id')::uuid;
end $$;
CREATE FUNCTION t.path(p_id uuid) RETURNS text LANGUAGE sql AS $$ select storage_path from public.continuity_attachments where id = p_id $$;
CREATE FUNCTION t.status(p_id uuid) RETURNS text LANGUAGE sql AS $$ select status from public.continuity_attachments where id = p_id $$;
-- ما يراه المستخدم في المستودع (ما يحكم توقيع الرابط في Storage)
CREATE FUNCTION t.sees(p uuid, p_path text) RETURNS int LANGUAGE sql AS $$
  select (t.call(p, format('(select count(*) from storage.objects where bucket_id = ''continuity-attachments'' and name = %L)', p_path)))::int $$;
CREATE FUNCTION t.pol(p_patch jsonb) RETURNS jsonb LANGUAGE sql AS $$
  select t.call(t.u('OW'), format('public.continuity_set_policies(%L::jsonb, %s)', p_patch,
                                  (select version from public.continuity_policies p join public.continuity_workspaces w on w.id = p.workspace_id and w.kind = 'platform'))) $$;
CREATE FUNCTION t.remove_sql(p_id uuid, p_rec uuid) RETURNS text LANGUAGE sql AS $$
  select format('public.continuity_attachment_remove(%L::uuid, %s)', p_id, t.ver2(p_rec)) $$;
CREATE FUNCTION t.restore_sql(p_id uuid, p_rec uuid) RETURNS text LANGUAGE sql AS $$
  select format('public.continuity_attachment_restore(%L::uuid, %s)', p_id, t.ver2(p_rec)) $$;
CREATE FUNCTION t.purge_sql(p_id uuid, p_rec uuid) RETURNS text LANGUAGE sql AS $$
  select format('public.continuity_attachment_purge(%L::uuid, %s)', p_id, t.ver2(p_rec)) $$;
RESET check_function_bodies;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ============================================================================
-- ⓪ 073 → 079 وسجلات
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

-- RA: سجل S1 نشط · RX: سجل S2 (S1 لا يراه) · RC: سجل S1 سيُقفل
DO $$
DECLARE a uuid; x uuid; c uuid;
BEGIN
  PERFORM t.ctx('admin');
  a := t.mk2(t.u('S1'), 'RA', jsonb_build_object('owner_id', t.u('S1')));
  x := (t.call(t.u('S2'), format('public.continuity_create(%L::jsonb)',
          t.req('RX', array['3e550000-0000-4000-8000-0000000000b1']::uuid[], jsonb_build_object('owner_id', t.u('S2')))))
        -> 'record' ->> 'id')::uuid;
  c := t.mk2(t.u('S1'), 'RC', jsonb_build_object('owner_id', t.u('S1')));
  INSERT INTO t.saved VALUES ('RA', a::text), ('RX', x::text), ('RC', c::text);
  PERFORM t.act(NULL);
END $$;
INSERT INTO t.saved SELECT 'chat_before', t.chat_digest();
INSERT INTO t.saved SELECT 'full_079', pg_get_functiondef('public._continuity_full(uuid,boolean)'::regprocedure);

-- A0: قبل 080 لا تُفعَّل المرفقات
DO $$
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.err(t.u('OW'), format('public.continuity_set_policies(%L::jsonb, 1)', '{"attachments_enabled": true}')) = '0A000', 'A0 not installed');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS A0: قبل 080 تفعيل المرفقات مرفوض (القدرة غير مثبتة)';
END $$;

-- ============================================================================
-- ① تطبيق 080
-- ============================================================================
\i migrations/080_continuity_attachments.sql
SET search_path = public, extensions;

-- A1: التثبيت، والقدرة مطفأة
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); g jsonb;
BEGIN
  PERFORM t.ok((SELECT NOT public AND file_size_limit = 16777216
                       AND allowed_mime_types @> array['image/png', 'video/mp4', 'audio/webm', 'audio/x-wav']
                       AND NOT allowed_mime_types && array['image/svg+xml', 'application/pdf', 'text/html']
                  FROM storage.buckets WHERE id = 'continuity-attachments'), 'A1 bucket private with limits');
  PERFORM t.ctx('admin');
  g := t.call(t.u('S1'), 'public.continuity_my_access()');
  PERFORM t.ok((g -> 'capabilities' ->> 'attachments')::boolean = false, 'A1 capability off: ' || (g -> 'capabilities')::text);
  g := t.call(t.u('OW'), 'public.continuity_get_policies()');
  PERFORM t.ok((g -> 'capabilities_installed' ->> 'attachments')::boolean, 'A1 installed');
  PERFORM t.ok(t.err(t.u('S1'), t.begin_sql(a, 'image', 'image/png', 10, 'x.png', 'off')) = '0A000', 'A1 begin refused while off');
  g := t.get(t.u('S1'), a);
  PERFORM t.ok(g -> 'attachments' = '[]'::jsonb AND g -> 'removed_attachments' = '[]'::jsonb, 'A1 full has empty lists');
  -- التفعيل (للاختبار فقط؛ في الإنتاج قرار منفصل)
  PERFORM t.pol('{"attachments_enabled": true}');
  g := t.call(t.u('S1'), 'public.continuity_my_access()');
  PERFORM t.ok((g -> 'capabilities' ->> 'attachments')::boolean, 'A1 enabled now');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS A1: مستودع خاص (16 MiB، قائمة مغلقة بلا SVG/PDF/HTML)، القدرة مثبتة ومطفأة: لا رفع ولا قوائم حتى التفعيل';
END $$;

-- A2: begin — الأنواع والحدود والاسم والمسار
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); b jsonb; ws uuid;
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.err(t.u('S1'), t.begin_sql(a, 'pdf', 'application/pdf', 10, 'x.pdf', 'k1')) = '22023', 'A2 kind');
  PERFORM t.ok(t.errfull(t.u('S1'), t.begin_sql(a, 'image', 'image/svg+xml', 10, 'x.svg', 'k2')) LIKE '%"field": "mime"%', 'A2 svg');
  PERFORM t.ok(t.err(t.u('S1'), t.begin_sql(a, 'image', 'video/mp4', 10, 'x', 'k3')) = '22023', 'A2 mime of other kind');
  PERFORM t.ok(t.err(t.u('S1'), t.begin_sql(a, 'audio', 'text/html', 10, 'x', 'k4')) = '22023', 'A2 html');
  PERFORM t.ok(t.err(t.u('S1'), t.begin_sql(a, 'image', 'image/png', 0, 'x', 'k5')) = '22023', 'A2 size 0');
  PERFORM t.ok(t.errfull(t.u('S1'), t.begin_sql(a, 'image', 'image/png', 3145729, 'x', 'k6')) LIKE '%too_large%', 'A2 image 3 MiB + 1');
  PERFORM t.ok(t.errfull(t.u('S1'), t.begin_sql(a, 'audio', 'audio/webm', 8388609, 'x', 'k7')) LIKE '%too_large%', 'A2 audio 8 MiB + 1');
  PERFORM t.ok(t.errfull(t.u('S1'), t.begin_sql(a, 'video', 'video/mp4', 16777217, 'x', 'k8')) LIKE '%too_large%', 'A2 video 16 MiB + 1');
  b := t.att_begin(t.u('S1'), a, 'image', 'image/png', 3145728, E'../../etc/\u202egnp.exe', 'max-img');
  ws := (SELECT workspace_id FROM public.continuity_records WHERE id = a);
  PERFORM t.ok(b -> 'upload' ->> 'path' = ws::text || '/' || a::text || '/' || (b -> 'attachment' ->> 'id')
               AND (b -> 'upload' ->> 'max_bytes')::bigint = 3145728 AND b -> 'upload' ->> 'bucket' = 'continuity-attachments'
               AND NOT (b -> 'replayed')::boolean, 'A2 server path: ' || b::text);
  PERFORM t.ok(b -> 'attachment' ->> 'name' = 'gnp.exe' AND b -> 'attachment' ->> 'status' = 'pending', 'A2 name cleaned: ' || (b -> 'attachment' ->> 'name'));
  b := t.att_begin(t.u('S1'), a, 'audio', 'Audio/WebM;codecs=opus', 8388608, '', 'max-aud');
  PERFORM t.ok(b -> 'attachment' ->> 'mime' = 'audio/webm' AND b -> 'attachment' -> 'name' = 'null'::jsonb, 'A2 mime normalized, empty name null');
  b := t.att_begin(t.u('S1'), a, 'video', 'video/quicktime', 16777216, 'v.mov', 'max-vid');
  PERFORM t.ok(b -> 'attachment' ->> 'kind' = 'video', 'A2 video 16 MiB exactly');
  INSERT INTO t.saved VALUES ('MAXVID', b -> 'attachment' ->> 'id');
  -- لا حدث قبل الاكتمال
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.continuity_events WHERE kind LIKE 'attachment%'), 'A2 no event on begin');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS A2: الأنواع والحدود بالبايت (3/8/16 MiB مقبولة، +1 مرفوض)، لا SVG/PDF/HTML، الاسم ينظف والمسار يولّده الخادم';
END $$;

-- A3: الصلاحيات
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); x uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RX');
  c uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RC');
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.err(t.u('S1'), t.begin_sql(x, 'image', 'image/png', 10, 'x', 'p1')) = 'P0002', 'A3 record not visible');
  PERFORM t.ok(t.err(t.u('C1'), t.begin_sql(a, 'image', 'image/png', 10, 'x', 'p2')) = '42501', 'A3 customer');
  PERFORM t.ok(t.err(t.u('BN'), t.begin_sql(a, 'image', 'image/png', 10, 'x', 'p3')) = '42501', 'A3 banned');
  PERFORM t.ok(t.err_anon('select ' || t.begin_sql(a, 'image', 'image/png', 10, 'x', 'p4')) = '42501', 'A3 anon');
  BEGIN
    PERFORM t.call_api(t.u('S1'), t.begin_sql(a, 'image', 'image/png', 10, 'x', 'p5'));
    RAISE EXCEPTION 'FAIL A3 api';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM t.tr(t.u('S1'), c, 'resolved', '{"resolution_note":"تم"}');
  PERFORM t.ok(t.err(t.u('S1'), t.begin_sql(c, 'image', 'image/png', 10, 'x', 'p6')) = '55000', 'A3 closed record');
  PERFORM t.tr(t.u('S1'), c, 'open', jsonb_build_object('reason', 'رجع', 'due', t.tomorrow(10)));
  -- لا جدول ولا دالة داخلية للمستخدمين
  PERFORM t.ok(t.err_stmt(t.u('S1'), 'select 1 from public.continuity_attachments') = '42501', 'A3 no table read');
  PERFORM t.ok(t.err(t.u('S1'), 'public.continuity_attachment_sweep()') = '42501', 'A3 no sweep');
  PERFORM t.ok(t.err(t.u('S1'), '(select count(*) from public.continuity_attachment_deletion_queue(10))') = '42501', 'A3 no queue');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS A3: سجل لا تراه ⇒ P0002؛ العميل والمحظور وanon ومسار الـAPI ⇒ 42501؛ السجل المقفول ⇒ 55000؛ لا وصول للجدول أو الكنس أو قائمة الحذف';
END $$;

-- A4: التكرار
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); b1 jsonb; b2 jsonb;
BEGIN
  PERFORM t.ctx('admin');
  b1 := t.att_begin(t.u('S1'), a, 'image', 'image/jpeg', 2000, 'a.jpg', 'idem');
  b2 := t.att_begin(t.u('S1'), a, 'image', 'image/jpeg', 2000, 'a.jpg', 'idem');
  PERFORM t.ok(b1 -> 'attachment' ->> 'id' = b2 -> 'attachment' ->> 'id' AND (b2 -> 'replayed')::boolean
               AND b2 -> 'upload' ->> 'path' = b1 -> 'upload' ->> 'path', 'A4 same row');
  PERFORM t.ok(t.err(t.u('S1'), t.begin_sql(a, 'image', 'image/jpeg', 2001, 'a.jpg', 'idem')) = '23505', 'A4 different request');
  PERFORM t.ok(t.err(t.u('S1'), format('public.continuity_attachment_begin(%L::uuid, ''image'', ''image/png'', 10, ''x'', null)', a)) = '22023', 'A4 key required');
  PERFORM t.ok((SELECT count(*) FROM public.continuity_attachments WHERE idempotency_key = t.key('idem')) = 1, 'A4 one row');
  INSERT INTO t.saved VALUES ('IDEM', b1 -> 'attachment' ->> 'id');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS A4: نفس المفتاح ⇒ نفس الصف ونفس المسار؛ طلب مختلف بنفس المفتاح ⇒ 23505؛ المفتاح إلزامي';
END $$;

-- A5: commit
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); aid uuid := (SELECT v::uuid FROM t.saved WHERE k = 'IDEM');
  p text; v0 int; g jsonb; e jsonb;
BEGIN
  PERFORM t.ctx('admin');
  p := t.path(aid);
  PERFORM t.ok(t.errfull(t.u('S1'), t.commit_sql(aid::text)) LIKE '%missing%', 'A5 no object');
  PERFORM t.upload(p, 1999, 'image/jpeg');
  PERFORM t.ok(t.errfull(t.u('S1'), t.commit_sql(aid::text)) LIKE '%size_mismatch%', 'A5 size mismatch');
  DELETE FROM storage.objects WHERE name = p;
  PERFORM t.upload(p, 2000, 'text/html');
  PERFORM t.ok(t.errfull(t.u('S1'), t.commit_sql(aid::text)) LIKE '%mime_mismatch%', 'A5 mime mismatch');
  DELETE FROM storage.objects WHERE name = p;
  PERFORM t.upload(p, 2000, 'image/jpeg');
  PERFORM t.ok(t.err(t.u('S1'), t.commit_sql(aid::text, 'XYZ')) = '22023', 'A5 sha format');
  PERFORM t.ok(t.err(t.u('EA'), t.commit_sql(aid::text)) = 'P0002', 'A5 someone else cannot commit');
  v0 := t.ver2(a);
  g := t.call(t.u('S1'), t.commit_sql(aid::text, repeat('b', 64)));
  PERFORM t.ok(jsonb_array_length(g -> 'attachments') = 1 AND g -> 'attachments' -> 0 ->> 'id' = aid::text
               AND g -> 'attachments' -> 0 ->> 'name' = 'a.jpg' AND (g -> 'attachments' -> 0 ->> 'size')::bigint = 2000
               AND t.ver2(a) = v0 + 1 AND t.status(aid) = 'active', 'A5 active: ' || (g -> 'attachments')::text);
  e := (SELECT payload FROM public.continuity_events WHERE record_id = a AND kind = 'attachment_added');
  PERFORM t.ok(e ->> 'attachment_id' = aid::text AND e ->> 'sha256' = repeat('b', 64) AND (e ->> 'size')::int = 2000
               AND e::text NOT LIKE '%a.jpg%' AND NOT e ? 'name', 'A5 event without name: ' || e::text);
  -- إعادة الإرسال: بلا حدث جديد ولا نسخة جديدة
  g := t.call(t.u('S1'), t.commit_sql(aid::text, repeat('b', 64)));
  PERFORM t.ok((g -> 'replayed')::boolean AND t.ver2(a) = v0 + 1
               AND (SELECT count(*) FROM public.continuity_events WHERE record_id = a AND kind = 'attachment_added') = 1, 'A5 replay no-op');
  -- مقبول: 3 MiB بالضبط
  PERFORM t.upload(t.path((SELECT id FROM public.continuity_attachments WHERE idempotency_key = t.key('max-img'))), 3145728, 'image/png');
  PERFORM t.call(t.u('S1'), t.commit_sql((SELECT id FROM public.continuity_attachments WHERE idempotency_key = t.key('max-img'))::text));
  PERFORM t.ok(t.status((SELECT id FROM public.continuity_attachments WHERE idempotency_key = t.key('max-img'))) = 'active', 'A5 3 MiB committed');
  INSERT INTO t.saved VALUES ('IMG', aid::text);
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS A5: commit يفحص الملف المخزَّن (موجود، الحجم بالضبط، النوع) لا كلام العميل؛ المنشئ فقط؛ حدث بالبصمة بلا اسم؛ إعادة الإرسال بلا أثر';
END $$;

-- A6: الحد الأقصى 20 (معلّق + نشط)
DO $$
DECLARE c uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RC'); i int;
BEGIN
  PERFORM t.ctx('admin');
  FOR i IN 1..18 LOOP PERFORM t.att_begin(t.u('S1'), c, 'image', 'image/png', 10, 'c' || i, 'cap' || i); END LOOP;
  PERFORM t.att(t.u('S1'), c, 'cap19');
  INSERT INTO t.saved VALUES ('CAP_VER', t.ver2(c)::text);
  PERFORM t.act(NULL);
  RAISE NOTICE 'setup A6: 19 مرفقًا على RC';
END $$;
-- تزامن حقيقي عند الحد: جلستان تبدآن المرفق رقم 20 ⇒ واحدة فقط
SELECT t.dblink_connect('one', format('dbname=%s port=%s host=%s user=postgres', current_database(),
         current_setting('port'), split_part(current_setting('unix_socket_directories'), ',', 1)));
SELECT t.dblink_connect('two', format('dbname=%s port=%s host=%s user=postgres', current_database(),
         current_setting('port'), split_part(current_setting('unix_socket_directories'), ',', 1)));
SELECT t.dblink_exec('one', 'begin');
SELECT t.dblink_exec('one', $q$set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a5'$q$);
SELECT t.dblink_exec('one', $q$set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000a5","role":"authenticated"}'$q$);
SELECT t.dblink_exec('one', 'set local role authenticated');
SELECT x FROM t.dblink('one', 'select (' || t.begin_sql((SELECT v::uuid FROM t.saved WHERE k = 'RC'), 'image', 'image/png', 10, 'one', 'race1') || ')->''attachment''->>''status''') AS r(x text);
SELECT t.dblink_exec('two', $q$set request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a5'$q$);
SELECT t.dblink_exec('two', $q$set request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000a5","role":"authenticated"}'$q$);
SELECT t.dblink_exec('two', 'set role authenticated');
SELECT t.dblink_send_query('two', format($q$do $b$ begin perform %s; raise notice 'two-ok'; exception when others then raise notice 'two-%%', sqlstate; end $b$;$q$,
       t.begin_sql((SELECT v::uuid FROM t.saved WHERE k = 'RC'), 'image', 'image/png', 10, 'two', 'race2')));
SELECT pg_sleep(0.5);
SELECT t.dblink_exec('one', 'commit');
SELECT pg_sleep(0.3);
SELECT t.dblink_get_result('two') IS NOT NULL;
SELECT t.dblink_get_result('two') IS NULL;
SELECT t.dblink_disconnect('one');
SELECT t.dblink_disconnect('two');
DO $$
DECLARE c uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RC');
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.ok((SELECT count(*) FROM public.continuity_attachments WHERE record_id = c AND status IN ('pending', 'active')) = 20
               AND (SELECT count(*) FROM public.continuity_attachments WHERE idempotency_key IN (t.key('race1'), t.key('race2'))) = 1,
               'A6 exactly one of two concurrent begins at the cap');
  PERFORM t.ok(t.errfull(t.u('S1'), t.begin_sql(c, 'image', 'image/png', 10, 'x', 'cap21')) LIKE '%too_many_attachments%', 'A6 21st refused');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS A6: الحد 20 (معلّق + نشط)؛ جلستان متزامنتان عند الحد ⇒ واحدة فقط تنجح';
END $$;

-- A7: القراءة والكتابة المباشرة في المستودع
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); aid uuid := (SELECT v::uuid FROM t.saved WHERE k = 'IMG');
  p text; pend text;
BEGIN
  PERFORM t.ctx('admin');
  p := t.path(aid);
  PERFORM t.ok(t.sees(t.u('S1'), p) = 1, 'A7 owner reads');
  PERFORM t.ok(t.sees(t.u('EA'), p) = 1, 'A7 supervisor reads');
  PERFORM t.ok(t.sees(t.u('S2'), p) = 0, 'A7 other support cannot');
  PERFORM t.ok(t.sees(t.u('C1'), p) = 0, 'A7 customer cannot');
  PERFORM t.ok(t.sees(t.u('BN'), p) = 0, 'A7 banned cannot');
  PERFORM t.ok((SELECT roles::text FROM pg_policies WHERE schemaname = 'storage' AND policyname = 'continuity_attachments_read') = '{authenticated}',
               'A7 read policy is for authenticated only (anon has none)');
  -- معلّق: الملف موجود لكن غير مقروء
  pend := t.path((SELECT id FROM public.continuity_attachments WHERE idempotency_key = t.key('max-aud')));
  PERFORM t.upload(pend, 8388608, 'audio/webm');
  PERFORM t.ok(t.sees(t.u('S1'), pend) = 0, 'A7 pending unreadable');
  -- كتابة مباشرة: لا إدراج ولا تعديل ولا حذف
  PERFORM t.ok(t.err_stmt(t.u('S1'), format('insert into storage.objects (bucket_id, name, metadata) values (''continuity-attachments'', %L, ''{}'')',
                 (SELECT workspace_id FROM public.continuity_records WHERE id = a)::text || '/' || a::text || '/' || gen_random_uuid()::text)) = '42501', 'A7 no direct insert');
  PERFORM t.err_stmt(t.u('S1'), format('update storage.objects set metadata = ''{"size": 1}'' where name = %L', p));
  PERFORM t.err_stmt(t.u('S1'), format('delete from storage.objects where name = %L', p));
  PERFORM t.ok((SELECT (metadata ->> 'size')::int FROM storage.objects WHERE name = p) = 2000, 'A7 no direct update/delete');
  -- الروابط في العرض لكل من يرى السجل فقط
  PERFORM t.ok(t.err(t.u('S2'), format('public.continuity_get(%L::uuid)', a)) = 'P0002', 'A7 no list for non-viewer');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS A7: يقرأ الملف من يرى السجل الآن فقط (المالك، المشرف)؛ لا غيرهم ولا المحظور؛ المعلّق غير مقروء؛ لا إدراج أو تعديل أو حذف مباشر';
END $$;

-- A8: المحذوفات والنسخة
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); aid uuid := (SELECT v::uuid FROM t.saved WHERE k = 'IMG'); g jsonb; v int;
BEGIN
  PERFORM t.ctx('admin');
  v := t.ver2(a);
  PERFORM t.ok(t.err(t.u('S1'), format('public.continuity_attachment_remove(%L::uuid, %s)', aid, v - 1)) = '40001', 'A8 stale version');
  PERFORM t.ok(t.err(t.u('S2'), t.remove_sql(aid, a)) = 'P0002', 'A8 non-viewer');
  g := t.call(t.u('S1'), t.remove_sql(aid, a));
  PERFORM t.ok(NOT (g -> 'attachments') @> jsonb_build_array(jsonb_build_object('id', aid))
               AND g -> 'removed_attachments' -> 0 ->> 'id' = aid::text AND (g -> 'removed_attachments' -> 0 ->> 'removed_by')::uuid = t.u('S1'),
               'A8 removed');
  PERFORM t.ok(t.sees(t.u('S1'), t.path(aid)) = 0, 'A8 removed unreadable');
  g := t.call(t.u('S1'), t.remove_sql(aid, a));
  PERFORM t.ok((SELECT count(*) FROM public.continuity_events WHERE record_id = a AND kind = 'attachment_removed') = 1, 'A8 remove idempotent');
  g := t.call(t.u('S1'), t.restore_sql(aid, a));
  PERFORM t.ok(t.status(aid) = 'active' AND t.sees(t.u('S1'), t.path(aid)) = 1 AND g -> 'removed_attachments' = '[]'::jsonb, 'A8 restored');
  -- سجل مقفول: لا إزالة ولا استرجاع
  PERFORM t.tr(t.u('S1'), a, 'resolved', '{"resolution_note":"تم"}');
  PERFORM t.ok(t.err(t.u('S1'), t.remove_sql(aid, a)) = '55000', 'A8 closed: no remove');
  PERFORM t.ok(t.sees(t.u('S1'), t.path(aid)) = 1 AND jsonb_array_length(t.get(t.u('S1'), a) -> 'attachments') >= 1, 'A8 closed: still viewable');
  PERFORM t.tr(t.u('S1'), a, 'open', '{"reason":"رجع"}');
  PERFORM t.ok(t.status(aid) = 'active', 'A8 reopen keeps attachment');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS A8: إزالة واسترجاع لمن يرى السجل بالنسخة (40001 للنسخة القديمة)؛ المحذوف غير مقروء؛ السجل المقفول يُعرض ولا يُعدَّل';
END $$;

-- A9: المسح النهائي
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); aid uuid := (SELECT v::uuid FROM t.saved WHERE k = 'IMG'); r record; e jsonb;
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.err(t.u('S1'), t.purge_sql(aid, a)) = '42501', 'A9 owner of record is not platform owner');
  PERFORM t.ok(t.err(t.u('EA'), t.purge_sql(aid, a)) = '42501', 'A9 supervisor');
  PERFORM t.call(t.u('OW'), t.purge_sql(aid, a));
  SELECT * INTO r FROM public.continuity_attachments WHERE id = (SELECT v::uuid FROM t.saved WHERE k = 'IMG');
  PERFORM t.ok(r.status = 'purged' AND r.display_name IS NULL AND r.delete_requested_at IS NOT NULL AND r.purged_by = t.u('OW'), 'A9 purged');
  e := (SELECT payload FROM public.continuity_events WHERE record_id = a AND kind = 'attachment_purged');
  PERFORM t.ok(e ->> 'attachment_id' = aid::text AND e::text NOT LIKE '%a.jpg%', 'A9 event');
  PERFORM t.ok(t.sees(t.u('S1'), r.storage_path) = 0 AND t.sees(t.u('OW'), r.storage_path) = 0, 'A9 unreadable');
  PERFORM t.ok(t.err(t.u('OW'), t.purge_sql(aid, a)) = 'P0002' AND t.err(t.u('S1'), t.restore_sql(aid, a)) = 'P0002', 'A9 final');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS A9: المسح النهائي لمالك المنصة فقط؛ الصف purged بلا اسم ومجدول للحذف الفعلي؛ لا رجوع';
END $$;

-- A10: الثبات حتى للمالك الخارق، وحذف حساب الموظف
DO $$
DECLARE aid uuid := (SELECT v::uuid FROM t.saved WHERE k = 'IMG');
BEGIN
  BEGIN DELETE FROM public.continuity_attachments WHERE id = (SELECT v::uuid FROM t.saved WHERE k = 'IMG'); RAISE EXCEPTION 'FAIL A10 delete';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN TRUNCATE public.continuity_attachments; RAISE EXCEPTION 'FAIL A10 truncate';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN UPDATE public.continuity_attachments SET storage_path = storage_path || 'x' WHERE id = (SELECT v::uuid FROM t.saved WHERE k = 'IMG'); RAISE EXCEPTION 'FAIL A10 path';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN UPDATE public.continuity_attachments SET status = 'active' WHERE id = (SELECT v::uuid FROM t.saved WHERE k = 'IMG'); RAISE EXCEPTION 'FAIL A10 unpurge';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN UPDATE public.continuity_attachments SET sha256 = repeat('c', 64) WHERE status = 'active'; RAISE EXCEPTION 'FAIL A10 sha';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN UPDATE public.continuity_attachments SET display_name = 'تزوير' WHERE status = 'active'; RAISE EXCEPTION 'FAIL A10 rename';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'PASS A10: لا حذف ولا تفريغ، والمسار والبصمة والاسم والحالة النهائية ثابتة حتى للمالك الخارق';
END $$;
INSERT INTO auth.users (id, email) VALUES ('00000000-0000-4000-8000-0000000000d8', 'x8@t.io');
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at)
VALUES ('00000000-0000-4000-8000-0000000000d8', 'x8@t.io', 'دعم سيُحذف', 'support', '01000000078', '2026-09-01');
DO $$
DECLARE x uuid := '00000000-0000-4000-8000-0000000000d8'; d uuid; aid uuid;
BEGIN
  PERFORM t.ctx('admin');
  d := (t.call(x, format('public.continuity_create(%L::jsonb)', t.req('X8', array[]::uuid[], jsonb_build_object('owner_id', x)))) -> 'record' ->> 'id')::uuid;
  aid := t.att(x, d, 'x8');
  PERFORM t.call(x, t.remove_sql(aid, d));
  PERFORM t.act(NULL);
  DELETE FROM public.profiles WHERE id = x;
  PERFORM t.ok((SELECT created_by IS NULL AND removed_by IS NULL AND status = 'removed' AND sha256 IS NOT NULL
                  FROM public.continuity_attachments WHERE id = aid), 'A10b profile deleted, attachment kept');
  RAISE NOTICE 'PASS A10b: حذف حساب موظف رفع مرفقًا ينجح والمرفق باقٍ بفاعل فارغ';
END $$;

-- A11: الكنس وقائمة الحذف
DO $$
DECLARE c uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RC'); a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA');
  j jsonb; old_pend uuid; act_c uuid; q jsonb; orphan text;
BEGIN
  -- معلّق عمره ساعتان (تعطيل الحارس لمحاكاة الزمن فقط)
  old_pend := (SELECT id FROM public.continuity_attachments WHERE idempotency_key = t.key('cap1'));
  ALTER TABLE public.continuity_attachments DISABLE TRIGGER trg_continuity_attachment_guard;
  UPDATE public.continuity_attachments SET created_at = now() - interval '2 hours' WHERE id = old_pend;
  ALTER TABLE public.continuity_attachments ENABLE TRIGGER trg_continuity_attachment_guard;
  PERFORM t.upload(t.path(old_pend), 10, 'image/png');
  -- يتيم في المستودع بلا صف، عمره ساعتان؛ وآخر حديث لا يُمس
  orphan := (SELECT workspace_id FROM public.continuity_records WHERE id = a)::text || '/' || a::text || '/' || gen_random_uuid()::text;
  PERFORM t.upload(orphan, 5, 'image/png', interval '2 hours');
  PERFORM t.upload(orphan || 'new', 5, 'image/png');
  -- انتهاء الاحتفاظ على RC: نقفله ونرجع إغلاقه 366 يومًا
  PERFORM t.ctx('admin');
  act_c := (SELECT id FROM public.continuity_attachments WHERE idempotency_key = t.key('cap19'));
  PERFORM t.tr(t.u('S1'), c, 'resolved', '{"resolution_note":"قديم"}');
  PERFORM t.act(NULL);
  UPDATE public.continuity_records SET closed_at = now() - interval '366 days' WHERE id = c;
  -- قبل الكنس: القراءة مرفوضة فورًا (قاعدة القراءة)، والعرض فارغ
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.sees(t.u('S1'), t.path(act_c)) = 0 AND t.get(t.u('S1'), c) -> 'attachments' = '[]'::jsonb, 'A11 expired unreadable before sweep');
  PERFORM t.act(NULL);
  j := public.continuity_attachment_sweep();
  PERFORM t.ok((j ->> 'abandoned')::int >= 1 AND (j ->> 'redacted')::int = 1, 'A11 sweep: ' || j::text);
  PERFORM t.ok(t.status(old_pend) = 'abandoned' AND (SELECT delete_requested_at IS NOT NULL FROM public.continuity_attachments WHERE id = old_pend), 'A11 abandoned');
  PERFORM t.ok((SELECT status = 'redacted' AND display_name IS NULL AND delete_requested_at IS NOT NULL FROM public.continuity_attachments WHERE id = act_c), 'A11 redacted');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.continuity_events WHERE kind = 'attachment_redacted' AND client = 'cron' AND actor_id IS NULL
                         AND payload ->> 'attachment_id' = act_c::text), 'A11 cron event');
  -- قائمة الحذف: لـ service_role فقط، مسارات فقط
  SET LOCAL ROLE service_role;
  q := (SELECT jsonb_agg(jsonb_build_object('path', path, 'reason', reason)) FROM public.continuity_attachment_deletion_queue(100));
  RESET ROLE;
  PERFORM t.ok(q @> jsonb_build_array(jsonb_build_object('path', t.path(old_pend), 'reason', 'abandoned'))
               AND q @> jsonb_build_array(jsonb_build_object('path', t.path(act_c), 'reason', 'redacted'))
               AND q @> jsonb_build_array(jsonb_build_object('path', t.path((SELECT v::uuid FROM t.saved WHERE k = 'IMG')), 'reason', 'purged'))
               AND q @> jsonb_build_array(jsonb_build_object('path', orphan, 'reason', 'orphan'))
               AND NOT q @> jsonb_build_array(jsonb_build_object('path', orphan || 'new', 'reason', 'orphan')), 'A11 queue: ' || q::text);
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(q) x WHERE x::text LIKE '%.png%' OR x::text LIKE '%.jpg%'), 'A11 no names');
  -- دالة التنظيف تحذف (Storage API) ⇒ الكنس يسجّل اختفاء الملفات
  DELETE FROM storage.objects WHERE name IN (SELECT x ->> 'path' FROM jsonb_array_elements(q) x);
  j := public.continuity_attachment_sweep();
  PERFORM t.ok((j ->> 'objects_gone')::int >= 3
               AND (SELECT object_deleted_at IS NOT NULL FROM public.continuity_attachments WHERE id = act_c), 'A11 gone recorded: ' || j::text);
  SET LOCAL ROLE service_role;
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.continuity_attachment_deletion_queue(100)), 'A11 queue empty');
  RESET ROLE;
  RAISE NOTICE 'PASS A11: الكنس: معلّق > ساعة ⇒ abandoned، انتهاء الاحتفاظ ⇒ redacted بحدث cron بلا محتوى، والقراءة ممنوعة قبل الكنس؛ قائمة الحذف (مسارات فقط) تشمل اليتيم القديم فقط؛ الحذف الفعلي يُسجَّل';
END $$;

-- A12: مفتاح الإيقاف
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); aid uuid;
BEGIN
  PERFORM t.ctx('admin');
  aid := t.att(t.u('S1'), a, 'ks');
  PERFORM t.ok(t.sees(t.u('S1'), t.path(aid)) = 1, 'A12 readable while on');
  PERFORM t.pol('{"attachments_enabled": false}');
  PERFORM t.ok(t.sees(t.u('S1'), t.path(aid)) = 0 AND t.get(t.u('S1'), a) -> 'attachments' = '[]'::jsonb, 'A12 off: unreadable and hidden');
  PERFORM t.ok(t.err(t.u('S1'), t.begin_sql(a, 'image', 'image/png', 10, 'x', 'ks2')) = '0A000'
               AND t.err(t.u('S1'), t.remove_sql(aid, a)) = '0A000', 'A12 off: no upload or remove');
  PERFORM t.call(t.u('OW'), t.purge_sql(aid, a));
  PERFORM t.ok(t.status(aid) = 'purged', 'A12 owner can still erase while off');
  PERFORM t.pol('{"attachments_enabled": true}');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS A12: الإيقاف يمنع الرفع والإزالة والقراءة والعرض فورًا، ويبقى المسح النهائي للمالك';
END $$;

-- A13: لا مساس بالشات والصندوق، والأغلفة القديمة ترى المرفقات
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA');
BEGIN
  PERFORM t.ok(t.chat_digest() = (SELECT v FROM t.saved WHERE k = 'chat_before'), 'A13 chat untouched');
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.call(t.u('S1'), format('public.relay_get(%L::uuid)', a)) ? 'attachments', 'A13 wrapper');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS A13: جداول الشات والصندوق لم تُمس؛ الغلاف relay_get يرجع المرفقات';
END $$;

-- RERUN
INSERT INTO t.saved SELECT 'att_digest', (SELECT md5(string_agg(md5(to_jsonb(a)::text), ',' ORDER BY a.id)) FROM public.continuity_attachments a);
\i migrations/080_continuity_attachments.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok((SELECT md5(string_agg(md5(to_jsonb(a)::text), ',' ORDER BY a.id)) FROM public.continuity_attachments a) = (SELECT v FROM t.saved WHERE k = 'att_digest')
               AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND policyname = 'continuity_attachments_read') = 1
               AND (SELECT count(*) FROM storage.buckets WHERE id = 'continuity-attachments') = 1
               AND (SELECT attachments_enabled FROM public.continuity_policies), 'RERUN no change (and does not switch the capability)');
  RAISE NOTICE 'PASS RERUN: إعادة تشغيل 080 لا تغيّر شيئًا';
END $$;

-- V: التحقق يرفض سياسة كتابة على storage.objects بلا تقييد بالمستودع (كانت ستفتح المستودع الجديد)
\set m080_sql `cat migrations/080_continuity_attachments.sql`
SELECT set_config('t.m080_sql', :'m080_sql', false) IS NOT NULL;
CREATE FUNCTION t.run080(p_prefix text) RETURNS text LANGUAGE plpgsql AS $$
declare c text;
begin
  perform t.dblink_connect('v', format('dbname=%s port=%s host=%s user=postgres', current_database(),
            current_setting('port'), split_part(current_setting('unix_socket_directories'), ',', 1)));
  begin
    perform t.dblink_exec('v', 'begin; set search_path = public, extensions; ' || p_prefix || current_setting('t.m080_sql') || '; rollback;');
    c := 'ok';
  exception when others then c := sqlerrm;
  end;
  perform t.dblink_disconnect('v');
  return c;
end $$;
DO $$
DECLARE c text;
BEGIN
  c := t.run080('create policy wide_open on storage.objects for insert to authenticated with check (true); ');
  PERFORM t.ok(c LIKE '%بلا تقييد بالمستودع%', 'V unscoped write policy refused: ' || c);
  c := t.run080('create policy extra_read on storage.objects for select to authenticated using (bucket_id = ''continuity-attachments''); ');
  PERFORM t.ok(c LIKE '%سياسة أخرى على مستودع المرفقات%', 'V second policy on the bucket refused: ' || c);
  c := t.run080('grant execute on function public.continuity_attachment_sweep(integer) to authenticated; ');
  PERFORM t.ok(c = 'ok', 'V the file re-revokes what it owns: ' || c);
  c := t.run080('');
  PERFORM t.ok(c = 'ok', 'V clean re-run inside a transaction: ' || c);
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname IN ('wide_open', 'extra_read')), 'V nothing leaked');
  RAISE NOTICE 'PASS V: التحقق يرفض سياسة كتابة بلا تقييد بالمستودع وأي سياسة ثانية على مستودع المرفقات';
END $$;

-- RB: ترتيب التراجع، الرفض مع بيانات، النص قبل 080 حرفيًا، إعادة التطبيق
\set rb079_sql `cat migrations/_rollback/079_continuity_reopen_lifecycle.down.sql`
\set rb080_sql `cat migrations/_rollback/080_continuity_attachments.down.sql`
SELECT set_config('t.rb079_sql', 'set continuity.rollback_discard_data = ''on''; ' || :'rb079_sql', false) IS NOT NULL;
SELECT set_config('t.rb080_sql', :'rb080_sql', false) IS NOT NULL;
CREATE FUNCTION t.try(p_name text, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
declare c text;
begin
  perform t.dblink_connect(p_name, format('dbname=%s port=%s host=%s user=postgres', current_database(),
            current_setting('port'), split_part(current_setting('unix_socket_directories'), ',', 1)));
  begin
    perform t.dblink_exec(p_name, p_sql);
    c := 'ok';
  exception when others then c := sqlerrm;
  end;
  perform t.dblink_disconnect(p_name);
  return c;
end $$;
DO $$
DECLARE c text;
BEGIN
  c := t.try('rb79', current_setting('t.rb079_sql'));
  PERFORM t.ok(c LIKE '%080+%' AND to_regclass('public.continuity_closures') IS NOT NULL, 'RB-079 refused while 080 installed: ' || c);
  c := t.try('rb80', current_setting('t.rb080_sql'));
  PERFORM t.ok(c LIKE '%rollback_discard_data%' AND to_regclass('public.continuity_attachments') IS NOT NULL, 'RB-a refused with data: ' || c);
  RAISE NOTICE 'PASS RB-a: تراجع 079 يرفض و080 مطبق؛ تراجع 080 يرفض ومرفقات أو ملفات ستضيع';
END $$;
SET continuity.rollback_discard_data = 'on';
\i migrations/_rollback/080_continuity_attachments.down.sql
RESET continuity.rollback_discard_data;
DO $$
BEGIN
  PERFORM t.ok(pg_get_functiondef('public._continuity_full(uuid,boolean)'::regprocedure) = (SELECT v FROM t.saved WHERE k = 'full_079'), 'RB full identical to 079');
  PERFORM t.ok(to_regclass('public.continuity_attachments') IS NULL
               AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname LIKE '%continuity%attachment%')
               AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND policyname = 'continuity_attachments_read'), 'RB objects gone');
  PERFORM t.ok(NOT public._continuity_capability_installed('attachments')
               AND NOT (public._continuity_effective_capabilities() ->> 'attachments')::boolean, 'RB capability uninstalled');
  -- المستودع يبقى (Storage) بلا أي سياسة: لا قراءة ولا كتابة
  PERFORM t.ok(EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'continuity-attachments' AND NOT public)
               AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage'
                                 AND (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%continuity-attachments%'), 'RB bucket closed');
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.err(t.u('S1'), format('public.continuity_get(%L::uuid)', (SELECT v FROM t.saved WHERE k = 'RA'))) = 'ok', 'RB still works');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS RB-b: بعد التراجع _continuity_full مطابقة لنص 079 حرفيًا، ولا جدول ولا دالة ولا سياسة؛ المستودع يبقى مغلقًا';
END $$;
-- 078 كان قد فعّل attachments_enabled؛ إعادة التطبيق لا تتأثر
\i migrations/080_continuity_attachments.sql
SET search_path = public, extensions;
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); aid uuid;
BEGIN
  PERFORM t.ctx('admin');
  aid := t.att(t.u('S1'), a, 'after-rb');
  PERFORM t.ok(t.status(aid) = 'active' AND t.sees(t.u('S1'), t.path(aid)) = 1, 'RB-c works again');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS RB-c: إعادة تطبيق 080 بعد التراجع تعمل (والمستودع الموجود يُعاد ضبطه)';
END $$;

\echo 'ALL continuity-attachments tests passed'
