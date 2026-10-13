-- ============================================================================
-- مدعوم — الاستمرارية: التسليم المحدود والوصول المفوَّض (091) على نسخة مطابقة لشكل
-- الإنتاج (073 → 081 → 087 → 089 → 091):
--
--   G0  التثبيت: الترقيعات الست على نص الإنتاج، الجداول مغلقة، الدوال الداخلية مغلقة، anon مرفوض
--   G1  الطلب: من يطلب (المالك/المشرف)، لمن، بأي نطاق؛ الإجراءات غير المفعّلة والمستمر مرفوضة
--   G2  المعلّق لا يمنح شيئًا: لا قراءة مشتركة، والحزمة أعداد بلا محتوى
--   G3  القرار: القديم يرفض غير transfer؛ لا قبول بلا مراجعة؛ التعديل العادي لا يمنع ويُذكر؛
--       التغيير الجوهري يمنع حتى مراجعة جديدة؛ الملكية لا تتغير؛ الوقت يبدأ عند القبول
--   G4  القراءة المشتركة: النطاق فقط، ترقيم جديد، C3 (المقتطف لمن يفتح المحادثة فقط)، ولا توسيع
--       للقراءة العادية أو التعديل
--   G5  النطاق الزمني [من، إلى) بحدوده
--   G6  المرفقات: فحص الدالة الطرفية داخل النطاق فقط، مدة ≤ 60ث وبحدود الوقت المتبقي، المستودع كما هو
--   G7  الجلسة المربوطة: القبول يحتاج جلسة، جلسة أخرى مرفوضة، الخروج يوقف فورًا، الكنس يجسّد
--   G8  الانتهاء بالوقت: يتوقف عند الموعد بلا انتظار الكنس
--   G9  دورة الحياة: السحب (المالك، المانح، المشرف)، الإسناد والإغلاق يسحبان، إعادة الفتح لا تعيد
--   G10 تعديل النطاق: التضييق فوري، التوسيع مقترح والقديم يحكم حتى قبول المستلم، والرفض
--   G11 مفتاح الإيقاف، وأهلية المستلم، وسلطة المانح
--   G12 الثبات، وعدم التسرب (نفس «غير موجود»)، ومسار relay-api
--   G13 التسليم الكامل كما هو (081) والسياسة الجديدة
--   RERUN، RB (التراجع يعيد البصمات الست، ويرفض بلا موافقة لو فيه بيانات)
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

-- ============================================================================
-- G0 التثبيت
-- ============================================================================
DO $$
BEGIN
  PERFORM t.ok((SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.prokind = 'f'
                   AND strpos(pg_get_functiondef(p.oid), '091_continuity_scoped_handover') > 0) = 6, 'G0 six patches');
  PERFORM t.ok(public._continuity_capability_scoped_handover(), 'G0 marker');
  PERFORM t.ok(t.err_stmt(t.u('S1'), 'select count(*) from public.continuity_handover_scopes') = '42501', 'G0 scopes closed');
  PERFORM t.ok(t.err_stmt(t.u('S1'), 'select count(*) from public.continuity_handovers') = '42501', 'G0 handovers closed');
  PERFORM t.ok(NOT has_function_privilege('authenticated', 'public._continuity_active_grant(uuid,text)', 'EXECUTE'), 'G0 gate closed');
  PERFORM t.ok(NOT has_function_privilege('authenticated', 'public.continuity_grant_sweep()', 'EXECUTE'), 'G0 sweep closed');
  PERFORM t.ok(NOT has_function_privilege('service_role', 'public.continuity_shared_get(uuid)', 'EXECUTE'), 'G0 shared not service');
  PERFORM t.ok(t.err_anon('select public.continuity_shared_with_me()') = '42501', 'G0 anon refused');
  -- السياسة الافتراضية (S-2)
  PERFORM t.ok((SELECT row(delegation_default_minutes, delegation_max_minutes, delegation_session_max_minutes, delegation_allow_ongoing)::text
                  FROM public._continuity_policy_row()) = '(240,10080,720,f)', 'G0 policy defaults');
  RAISE NOTICE 'PASS G0 install';
END $$;

-- ============================================================================
-- G1 الطلب
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); s1 uuid; s2 uuid; j jsonb; h uuid;
BEGIN
  PERFORM t.ctx('admin');
  s1 := t.src(a, 1); s2 := t.src(a, 2);
  -- عضو الفريق يقرأ ولا يمنح؛ من لا يرى السجل: غير موجود
  PERFORM t.ok((t.errj(t.u('S3'), t.hreq_sql(a, t.u('S2'), 'review', jsonb_build_object('sources', jsonb_build_array(s1)), 'g1a'))) ->> 'state' = '42501', 'G1 team cannot grant');
  PERFORM t.ok((t.errj(t.u('S2'), t.hreq_sql(a, t.u('GR'), 'review', jsonb_build_object('sources', jsonb_build_array(s1)), 'g1b'))) ->> 'state' = 'P0002', 'G1 non-reader not_found');
  -- وضع غير معروف، مستلم غير مؤهل، المالك نفسه
  PERFORM t.ok((t.errj(t.u('S1'), t.hreq_sql(a, t.u('S2'), 'peek', '{}'::jsonb, 'g1c'))) ->> 'field' = 'mode', 'G1 bad mode');
  PERFORM t.ok((t.errj(t.u('S1'), t.hreq_sql(a, t.u('C1'), 'review', '{}'::jsonb, 'g1d'))) ->> 'reason' = 'not_eligible', 'G1 customer not eligible');
  PERFORM t.ok((t.errj(t.u('S1'), t.hreq_sql(a, t.u('BN'), 'review', '{}'::jsonb, 'g1e'))) ->> 'reason' = 'not_eligible', 'G1 banned not eligible');
  -- النطاق: عناصر من سجل آخر، فارغ، إجراءات، مستمر، مدة
  PERFORM t.ok((t.errj(t.u('S1'), t.hreq_sql(a, t.u('S2'), 'review', jsonb_build_object('sources', jsonb_build_array(gen_random_uuid())), 'g1f'))) ->> 'state' = 'P0002', 'G1 foreign source');
  PERFORM t.ok((t.errj(t.u('S1'), t.hreq_sql(a, t.u('S2'), 'review', '{"sources": []}'::jsonb, 'g1g'))) ->> 'reason' = 'empty', 'G1 empty scope');
  PERFORM t.ok((t.errj(t.u('S1'), t.hreq_sql(a, t.u('S2'), 'review', '{"actions": ["view", "note"]}'::jsonb, 'g1h'))) ->> 'reason' = 'review_is_view_only', 'G1 review view only');
  j := t.errj(t.u('S1'), t.hreq_sql(a, t.u('S2'), 'collab', '{"actions": ["view", "edit_fields"]}'::jsonb, 'g1i'));
  PERFORM t.ok(j ->> 'state' = '0A000' AND j ->> 'code' = 'feature_not_enabled', 'G1 collab actions not enabled (082b)');
  j := t.errj(t.u('S1'), t.hreq_sql(a, t.u('S2'), 'review', '{"expiry": {"kind": "ongoing"}}'::jsonb, 'g1j'));
  PERFORM t.ok(j ->> 'state' = '0A000' AND j ->> 'field' = 'scope.expiry', 'G1 ongoing off by default');
  PERFORM t.ok((t.errj(t.u('S1'), t.hreq_sql(a, t.u('S2'), 'review', '{"expiry": {"kind": "duration", "minutes": 10081}}'::jsonb, 'g1k'))) ->> 'reason' = 'range', 'G1 > 7 days');
  PERFORM t.ok((t.errj(t.u('S1'), t.hreq_sql(a, t.u('S2'), 'review', '{"expiry": {"kind": "session", "minutes": 721}}'::jsonb, 'g1l'))) ->> 'reason' = 'range', 'G1 session > 12h');
  PERFORM t.ok((t.errj(t.u('S1'), t.hreq_sql(a, t.u('S2'), 'review', '{"range": {"from": "2026-10-07T07:30:00", "to": "2026-10-07T07:20:00", "tz": "UTC"}}'::jsonb, 'g1m'))) ->> 'reason' = 'order', 'G1 range order');
  PERFORM t.ok((t.errj(t.u('S1'), t.hreq_sql(a, t.u('S2'), 'review', '{"attachments": ["x"]}'::jsonb, 'g1n'))) ->> 'field' = 'scope.attachments', 'G1 bad attachment id');
  -- طلب صحيح: رسالتان، افتراضي 4 ساعات
  j := t.call(t.u('S1'), t.hreq_sql(a, t.u('S2'), 'review', jsonb_build_object('sources', jsonb_build_array(s1, s2)), 'G-main'));
  h := (j -> 'handover' ->> 'id')::uuid;
  PERFORM t.ok(j -> 'handover' ->> 'mode' = 'review' AND j -> 'handover' ->> 'state' = 'pending' AND (j -> 'handover' ->> 'expires_at') IS NULL, 'G1 pending review, no expiry yet');
  PERFORM t.ok((SELECT row(version, status, cardinality(source_ids), expiry_kind, duration_minutes)::text FROM public.continuity_handover_scopes
                  WHERE handover_id = h) = '(1,approved,2,duration,240)', 'G1 scope v1 resolved: default 240');
  -- إعادة بنفس المفتاح: نفس الطلب؛ بمعطيات مختلفة: تعارض
  PERFORM t.ok((t.call(t.u('S1'), t.hreq_sql(a, t.u('S2'), 'review', jsonb_build_object('sources', jsonb_build_array(s1, s2)), 'G-main')) ->> 'replayed')::boolean, 'G1 idempotent replay');
  PERFORM t.ok((t.errj(t.u('S1'), t.hreq_sql(a, t.u('S2'), 'collab', jsonb_build_object('sources', jsonb_build_array(s1)), 'G-main'))) ->> 'code' = 'idempotency_conflict', 'G1 idempotency conflict');
  -- طلب ثانٍ معلّق لنفس السجل
  PERFORM t.ok((t.errj(t.u('EA'), t.hreq_sql(a, t.u('GR'), 'review', jsonb_build_object('sources', jsonb_build_array(s1)), 'g1o'))) ->> 'reason' = 'handover_pending', 'G1 one pending');
  -- الحدث بلا محتوى
  PERFORM t.ok((SELECT payload::text FROM public.continuity_events WHERE record_id = a AND kind = 'handover_requested' ORDER BY id DESC LIMIT 1) NOT LIKE '%راجع%', 'G1 event hashes reason');
  INSERT INTO t.saved VALUES ('H1', h::text);
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS G1 request';
END $$;

-- ============================================================================
-- G2 المعلّق لا يمنح شيئًا
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); h uuid := (SELECT v::uuid FROM t.saved WHERE k = 'H1'); j jsonb;
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.err(t.u('S2'), t.shared_sql(a)) = 'P0002', 'G2 no shared read while pending');
  PERFORM t.ok(t.err(t.u('S2'), format('public.continuity_get(%L::uuid)', a)) = 'P0002', 'G2 no normal read');
  j := t.call(t.u('S2'), 'public.continuity_handovers_mine()');
  PERFORM t.ok(jsonb_array_length(j -> 'incoming') = 1, 'G2 incoming listed');
  PERFORM t.ok((j -> 'incoming' -> 0 -> 'package' -> 'scope' -> 'counts' ->> 'sources')::int = 2, 'G2 package counts');
  PERFORM t.ok(j::text NOT LIKE '%MARKERA%' AND j::text NOT LIKE '%SUMMARYMARK%' AND j::text NOT LIKE '%storage%', 'G2 package has no content');
  PERFORM t.ok((j -> 'incoming' -> 0 -> 'package' -> 'scope' -> 'counts' ->> 'not_readable')::int = 0, 'G2 S2 can read SA');
  PERFORM t.ok(jsonb_array_length(t.call(t.u('S2'), 'public.continuity_shared_with_me()') -> 'active') = 0, 'G2 nothing active');
  -- المستلم ليس من يراجع غيره
  PERFORM t.ok(t.err(t.u('GR'), format('public.continuity_handover_review(%L::uuid)', h)) = 'P0002', 'G2 other cannot review');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS G2 pending grants nothing';
END $$;

-- ============================================================================
-- G3 القرار
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); h uuid := (SELECT v::uuid FROM t.saved WHERE k = 'H1');
        rv jsonb; j jsonb; e jsonb;
BEGIN
  PERFORM t.ctx('admin');
  -- القرار القديم (بالنسخة) لا يقبل طلب مراجعة أبدًا
  e := t.errj(t.u('S2'), format('public.continuity_handover_decide(%L::uuid, ''accept'', null, %s)', h, t.ver2(a)));
  PERFORM t.ok(e ->> 'state' = '0A000' AND e ->> 'field' = 'decision', 'G3 old decide refuses review');
  -- بلا مراجعة
  PERFORM t.ok((t.errj(t.u('S2'), t.decide2_sql(h, 'accept', null, 'x'))) ->> 'reason' = 'review_required', 'G3 review required');
  rv := t.review(t.u('S2'), h);
  PERFORM t.ok(rv ->> 'digest' IS NOT NULL AND rv::text NOT LIKE '%MARKERA%', 'G3 review digest, no content');
  -- تغيير جوهري بعد المراجعة: الموعد ⇒ رفض باسم النوع
  PERFORM t.call(t.u('S1'), t.upd_sql(a, jsonb_build_object('due', t.tomorrow(15))));
  e := t.errj(t.u('S2'), t.decide2_sql(h, 'accept', null, rv ->> 'digest'));
  PERFORM t.ok(e ->> 'reason' = 'material_change' AND e -> 'kinds' = '["due"]'::jsonb, 'G3 material change blocks: ' || e::text);
  PERFORM t.ok((t.h(h)).state = 'pending', 'G3 still pending');
  -- مراجعة جديدة، ثم تعديل عادي ⇒ القبول يمر ويذكر الحقل
  rv := t.review(t.u('S2'), h);
  PERFORM t.call(t.u('S1'), t.upd_sql(a, '{"next_action": "انتظر رد العميل"}'));
  -- بصمة مزوّرة
  PERFORM t.ok((t.errj(t.u('S2'), t.decide2_sql(h, 'accept', null, md5('x')))) ->> 'reason' = 'material_change', 'G3 wrong digest');
  j := t.call(t.u('S2'), t.decide2_sql(h, 'accept', null, rv ->> 'digest'));
  PERFORM t.ok((j ->> 'accepted')::boolean AND j -> 'changed_since_review' = '["next_action"]'::jsonb, 'G3 accepted, told about next_action: ' || (j -> 'changed_since_review')::text);
  PERFORM t.ok(t.owner(a) = t.u('S1'), 'G3 ownership unchanged');
  PERFORM t.ok((t.h(h)).expires_at BETWEEN now() + interval '239 minutes' AND now() + interval '241 minutes', 'G3 time starts at acceptance (4h)');
  PERFORM t.ok((t.h(h)).bound_session_id IS NULL, 'G3 not session bound');
  -- قبول مكرر: نفس النتيجة
  PERFORM t.ok((t.call(t.u('S2'), t.decide2_sql(h, 'accept', null, rv ->> 'digest')) ->> 'replayed')::boolean, 'G3 replay');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS G3 decide';
END $$;

-- ============================================================================
-- G4 القراءة المشتركة
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); j jsonb; w jsonb;
BEGIN
  PERFORM t.ctx('admin');
  j := t.shared(t.u('S2'), a);
  PERFORM t.ok(t.positions(j) = '1,2', 'G4 renumbered 1..n');
  PERFORM t.ok(t.excerpts(j) LIKE 'MARKERA1%|MARKERA2%' AND j::text NOT LIKE '%MARKERA3%', 'G4 only scoped messages: ' || t.excerpts(j));
  PERFORM t.ok(jsonb_array_length(j -> 'attachments') = 0, 'G4 no attachments in scope');
  PERFORM t.ok(j -> 'grant' ->> 'mode' = 'review' AND j -> 'grant' -> 'actions' = '["view"]'::jsonb, 'G4 grant info');
  PERFORM t.ok(NOT (j -> 'record') ? 'owner_id' AND NOT (j -> 'record') ? 'team_id', 'G4 no owner/team in shared record');
  -- لا توسيع للقراءة العادية ولا للتعديل
  PERFORM t.ok(t.err(t.u('S2'), format('public.continuity_get(%L::uuid)', a)) = 'P0002', 'G4 normal read still refused');
  PERFORM t.ok(t.err(t.u('S2'), t.upd_sql(a, '{"priority": 1}')) = 'P0002', 'G4 no edit');
  PERFORM t.ok(NOT (t.call(t.u('S2'), 'public.continuity_list(''{}''::jsonb)')::text LIKE '%' || a::text || '%'), 'G4 not in list');
  PERFORM t.ok(t.err(t.u('S2'), format('public.continuity_events_for(%L::uuid, null, 50)', a)) = 'P0002', 'G4 no events');
  w := t.call(t.u('S2'), 'public.continuity_shared_with_me()');
  PERFORM t.ok(jsonb_array_length(w -> 'active') = 1 AND w -> 'active' -> 0 ->> 'record_id' = a::text, 'G4 shared with me');
  -- C3: لو S2 فقد وصوله للمحادثة ⇒ المقتطف يختفي فورًا (والمنحة كما هي)
  DELETE FROM public.inbox_team_members WHERE team_id = '7ea70000-0000-4000-8000-000000000002';
  j := t.shared(t.u('S2'), a);
  PERFORM t.ok(t.excerpts(j) = '∅|∅' AND j -> 'sources' -> 0 ->> 'excerpt_hidden' = 'no_conversation_access', 'G4 C3 hides excerpts');
  INSERT INTO public.inbox_team_members (team_id, user_id) VALUES ('7ea70000-0000-4000-8000-000000000002', t.u('S2'));
  -- مصدر أُزيل من السجل يختفي من النطاق
  PERFORM t.call(t.u('S1'), format('public.continuity_remove_source(%L::uuid, %s)', t.src(a, 2), t.ver2(a)));
  PERFORM t.ok(t.positions(t.shared(t.u('S2'), a)) = '1', 'G4 removed source leaves scope');
  PERFORM t.call(t.u('S1'), format('public.continuity_restore_source(%L::uuid, %s)', t.src(a, 2), t.ver2(a)));
  PERFORM t.ok(t.positions(t.shared(t.u('S2'), a)) = '1,2', 'G4 restored source returns (still in fixed list)');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS G4 shared read';
END $$;

-- ============================================================================
-- G9 دورة الحياة (السحب) — قبل G5 لإفراغ السجل من المنح
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); h uuid := (SELECT v::uuid FROM t.saved WHERE k = 'H1'); j jsonb;
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.err(t.u('S3'), t.revoke_sql(h)) = '42501', 'G9 team member cannot revoke');
  PERFORM t.ok(t.err(t.u('GR'), t.revoke_sql(h)) = 'P0002', 'G9 stranger not_found');
  PERFORM t.ok(t.err(t.u('S2'), t.revoke_sql(h)) = 'P0002', 'G9 recipient cannot revoke (use decline/expiry)');
  j := t.call(t.u('S1'), t.revoke_sql(h));
  PERFORM t.ok((t.h(h)).state = 'revoked' AND (t.h(h)).revoke_cause = 'grantor', 'G9 revoked by grantor');
  PERFORM t.ok(t.err(t.u('S2'), t.shared_sql(a)) = 'P0002', 'G9 revoked ⇒ no read');
  PERFORM t.ok((t.call(t.u('S1'), t.revoke_sql(h)) ->> 'replayed')::boolean, 'G9 revoke idempotent');
  PERFORM t.ok(t.evs(a, 'handover_revoked') = 1, 'G9 event');
  -- المشرف يسحب منحة غيره
  h := t.grant(t.u('S1'), a, t.u('S2'), jsonb_build_object('sources', jsonb_build_array(t.src(a, 1))), 'G9-sup');
  PERFORM t.call(t.u('EA'), t.revoke_sql(h));
  PERFORM t.ok((t.h(h)).revoke_cause = 'supervisor', 'G9 supervisor revoke');
  -- الإسناد يسحب (S-4)
  h := t.grant(t.u('S1'), a, t.u('S2'), jsonb_build_object('sources', jsonb_build_array(t.src(a, 1))), 'G9-asg');
  PERFORM t.call(t.u('EA'), format('public.continuity_assign(%L::uuid, %L::uuid, %L::uuid, %s)', a, t.u('S3'), t.u('T1'), t.ver2(a)));
  PERFORM t.ok((t.h(h)).state = 'revoked' AND (t.h(h)).revoke_cause = 'reassigned', 'G9 reassign revokes');
  PERFORM t.ok(t.err(t.u('S2'), t.shared_sql(a)) = 'P0002', 'G9 reassigned ⇒ no read');
  PERFORM t.call(t.u('EA'), format('public.continuity_assign(%L::uuid, %L::uuid, %L::uuid, %s)', a, t.u('S1'), t.u('T1'), t.ver2(a)));
  -- الإغلاق يسحب، وإعادة الفتح لا تعيد
  h := t.grant(t.u('S1'), a, t.u('S2'), jsonb_build_object('sources', jsonb_build_array(t.src(a, 1))), 'G9-close');
  PERFORM t.tr(t.u('S1'), a, 'resolved', '{"resolution_note": "تم"}');
  PERFORM t.ok((t.h(h)).state = 'revoked' AND (t.h(h)).revoke_cause = 'record_closed', 'G9 close revokes');
  PERFORM t.tr(t.u('S1'), a, 'open', '{"reason": "رجع العميل"}');
  PERFORM t.ok((t.h(h)).state = 'revoked' AND t.err(t.u('S2'), t.shared_sql(a)) = 'P0002', 'G9 reopen does not restore');
  -- لا رجوع من المسحوب
  PERFORM t.ok(t.err_su(format('update public.continuity_handovers set state = ''accepted'', revoked_at = null, revoke_cause = null where id = %L', h)) = '42501', 'G9 no un-revoke');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS G9 lifecycle';
END $$;

-- ============================================================================
-- G5 النطاق الزمني [من، إلى)
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); h uuid; j jsonb;
BEGIN
  PERFORM t.ctx('admin');
  h := t.grant(t.u('S1'), a, t.u('S2'), '{"sources": "all", "range": {"from": "2026-10-07T07:25:00", "to": "2026-10-07T07:27:00", "tz": "UTC"}}', 'G5a');
  j := t.shared(t.u('S2'), a);
  PERFORM t.ok(t.positions(j) = '1' AND t.excerpts(j) LIKE 'MARKERA2%', 'G5 [07:25, 07:27) = A2 only: ' || t.excerpts(j));
  PERFORM t.ok(j -> 'grant' -> 'range' ->> 'tz' = 'UTC', 'G5 range shown');
  PERFORM t.call(t.u('S1'), t.revoke_sql(h));
  -- نفس الحدود بتوقيت القاهرة (UTC+3 في أكتوبر 2026)
  h := t.grant(t.u('S1'), a, t.u('S2'), '{"sources": "all", "range": {"from": "2026-10-07T10:24:00", "to": "2026-10-07T10:25:00", "tz": "Africa/Cairo"}}', 'G5b');
  j := t.shared(t.u('S2'), a);
  PERFORM t.ok(t.excerpts(j) LIKE 'MARKERA1%' AND t.positions(j) = '1', 'G5 Cairo [10:24, 10:25) = A1 only: ' || coalesce(t.excerpts(j), '-'));
  PERFORM t.call(t.u('S1'), t.revoke_sql(h));
  PERFORM t.ok((t.errj(t.u('S1'), t.hreq_sql(a, t.u('S2'), 'review', '{"range": {"from": "2026-10-07T07:25:00", "to": "2026-10-07T07:27:00", "tz": "Mars/Base"}}', 'G5c'))) ->> 'field' = 'scope.range', 'G5 unknown tz');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS G5 time range';
END $$;

-- ============================================================================
-- G6 المرفقات
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); a1 uuid := (SELECT v::uuid FROM t.saved WHERE k = 'att1');
        a2 uuid := (SELECT v::uuid FROM t.saved WHERE k = 'att2'); h uuid; j jsonb;
BEGIN
  PERFORM t.ctx('admin');
  h := t.grant(t.u('S1'), a, t.u('S2'), jsonb_build_object('sources', jsonb_build_array(t.src(a, 1)), 'attachments', jsonb_build_array(a1),
               'expiry', jsonb_build_object('kind', 'until', 'tz', 'UTC',
                                            'at', to_char((now() at time zone 'UTC') + interval '40 seconds', 'YYYY-MM-DD"T"HH24:MI:SS'))), 'G6a');
  j := t.shared(t.u('S2'), a);
  PERFORM t.ok(jsonb_array_length(j -> 'attachments') = 1 AND j -> 'attachments' -> 0 ->> 'id' = a1::text, 'G6 only scoped attachment listed');
  PERFORM t.ok(j::text NOT LIKE '%' || t.path(a1) || '%' AND j::text NOT LIKE '%path%', 'G6 no storage path in shared view');
  j := t.call(t.u('S2'), t.check_sql(a1));
  PERFORM t.ok(j ->> 'path' = t.path(a1), 'G6 check gives path to the edge function');
  PERFORM t.ok((j ->> 'ttl')::int BETWEEN 1 AND 40, 'G6 ttl bounded by remaining grant time: ' || (j ->> 'ttl'));
  PERFORM t.ok(t.err(t.u('S2'), t.check_sql(a2)) = 'P0002', 'G6 out-of-scope attachment refused');
  PERFORM t.ok(t.err(t.u('GR'), t.check_sql(a1)) = 'P0002', 'G6 stranger refused');
  PERFORM t.ok(t.err(t.u('S2'), t.check_sql(gen_random_uuid())) = 'P0002', 'G6 unknown id same answer');
  -- المستودع كما هو: المستلم لا يرى الملف ولا يوقّعه بنفسه
  PERFORM t.ok(t.sees(t.u('S2'), t.path(a1)) = 0, 'G6 storage policy unchanged for recipient');
  PERFORM t.ok(t.sees(t.u('S1'), t.path(a1)) = 1, 'G6 owner still sees');
  PERFORM t.call(t.u('S1'), t.revoke_sql(h));
  PERFORM t.ok(t.err(t.u('S2'), t.check_sql(a1)) = 'P0002', 'G6 revoked ⇒ refused');
  -- منحة 4 ساعات: المدة 60 ثانية بالضبط
  h := t.grant(t.u('S1'), a, t.u('S2'), jsonb_build_object('attachments', jsonb_build_array(a1), 'sources', '[]'::jsonb), 'G6b');
  PERFORM t.ok((t.call(t.u('S2'), t.check_sql(a1)) ->> 'ttl')::int = 60, 'G6 ttl max 60');
  -- المرفق أُزيل ⇒ يختفي؛ المرفقات أُطفئت ⇒ يختفي
  PERFORM t.call(t.u('S1'), format('public.continuity_attachment_remove(%L::uuid, %s)', a1, t.ver2(a)));
  PERFORM t.ok(t.err(t.u('S2'), t.check_sql(a1)) = 'P0002', 'G6 removed attachment refused');
  PERFORM t.call(t.u('S1'), format('public.continuity_attachment_restore(%L::uuid, %s)', a1, t.ver2(a)));
  PERFORM t.ok(t.err(t.u('S2'), t.check_sql(a1)) = 'ok', 'G6 restored');
  PERFORM t.pol('{"attachments_enabled": false}');
  PERFORM t.ok(t.err(t.u('S2'), t.check_sql(a1)) = 'P0002', 'G6 attachments off ⇒ refused');
  PERFORM t.pol('{"attachments_enabled": true}');
  PERFORM t.call(t.u('S1'), t.revoke_sql(h));
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS G6 attachments';
END $$;

-- ============================================================================
-- G7 الجلسة المربوطة
-- ============================================================================
INSERT INTO auth.sessions (id, user_id, not_after) VALUES
  ('5e5510e0-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a6', NULL),
  ('5e5510e0-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000a6', NULL),
  ('5e5510e0-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000a7', NULL);
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); h uuid; rv jsonb; j jsonb;
        s1 uuid := '5e5510e0-0000-4000-8000-000000000001'; s2 uuid := '5e5510e0-0000-4000-8000-000000000002';
        s3 uuid := '5e5510e0-0000-4000-8000-000000000003';
BEGIN
  PERFORM t.ctx('admin');
  h := t.hreq(t.u('S1'), a, t.u('S2'), 'review', jsonb_build_object('sources', jsonb_build_array(t.src(a, 1)), 'expiry', '{"kind": "session", "minutes": 30}'::jsonb), 'G7');
  rv := t.review(t.u('S2'), h);
  PERFORM t.ok((t.errj(t.u('S2'), t.decide2_sql(h, 'accept', null, rv ->> 'digest'))) ->> 'field' = 'session', 'G7 accept needs a session');
  PERFORM t.ok(t.err_s(t.u('S2'), s3, t.decide2_sql(h, 'accept', null, rv ->> 'digest')) = '22023', 'G7 someone else''s session refused');
  j := t.call_s(t.u('S2'), s1, t.decide2_sql(h, 'accept', null, rv ->> 'digest'));
  PERFORM t.ok((t.h(h)).bound_session_id = s1::text AND (t.h(h)).expires_at BETWEEN now() + interval '29 minutes' AND now() + interval '31 minutes', 'G7 bound, 30 min');
  PERFORM t.ok(t.err_s(t.u('S2'), s1, t.shared_sql(a)) = 'ok', 'G7 same session reads');
  PERFORM t.ok(t.err_s(t.u('S2'), s2, t.shared_sql(a)) = 'P0002', 'G7 other session refused');
  PERFORM t.ok(t.err(t.u('S2'), t.shared_sql(a)) = 'P0002', 'G7 no session refused');
  PERFORM t.ok(jsonb_array_length(t.call_s(t.u('S2'), s2, 'public.continuity_shared_with_me()') -> 'active') = 0, 'G7 not listed in other session');
  -- تسجيل الخروج
  DELETE FROM auth.sessions WHERE id = s1;
  PERFORM t.ok(t.err_s(t.u('S2'), s1, t.shared_sql(a)) = 'P0002', 'G7 sign-out stops access at once');
  PERFORM t.ok(public._continuity_grant_state(t.h(h), false) = 'session', 'G7 state session');
  PERFORM t.ok(public.continuity_grant_sweep() >= 1 AND (t.h(h)).state = 'expired' AND (t.h(h)).cancel_cause = 'session', 'G7 sweep materializes');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS G7 session-bound';
END $$;

-- ============================================================================
-- G8 الانتهاء بالوقت (بلا انتظار الكنس)
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); h uuid;
BEGIN
  PERFORM t.ctx('admin');
  h := t.grant(t.u('S1'), a, t.u('S2'), jsonb_build_object('sources', jsonb_build_array(t.src(a, 1)),
               'expiry', jsonb_build_object('kind', 'until', 'tz', 'UTC',
                                            'at', to_char((now() at time zone 'UTC') + interval '2 seconds', 'YYYY-MM-DD"T"HH24:MI:SS.US'))), 'G8');
  PERFORM t.ok(t.err(t.u('S2'), t.shared_sql(a)) = 'ok', 'G8 readable before expiry');
  INSERT INTO t.saved VALUES ('H8', h::text);
  PERFORM t.act(NULL);
END $$;
SELECT pg_sleep(3);
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); h uuid := (SELECT v::uuid FROM t.saved WHERE k = 'H8');
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.ok((t.h(h)).state = 'accepted', 'G8 not yet swept');
  PERFORM t.ok(t.err(t.u('S2'), t.shared_sql(a)) = 'P0002', 'G8 refused at expiry, before sweep');
  PERFORM public.continuity_grant_sweep();
  PERFORM t.ok((t.h(h)).state = 'expired' AND (t.h(h)).cancel_cause = 'time', 'G8 sweep: expired/time');
  PERFORM t.ok(t.evs(a, 'handover_expired') = 2, 'G8 events');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS G8 time expiry';
END $$;

-- ============================================================================
-- G10 تعديل النطاق
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); h uuid; j jsonb; e jsonb; exp0 timestamptz;
        x1 uuid; x2 uuid; x3 uuid; v int;
BEGIN
  PERFORM t.ctx('admin');
  x1 := t.src(a, 1); x2 := t.src(a, 2); x3 := t.src(a, 3);
  h := t.grant(t.u('S1'), a, t.u('S2'), jsonb_build_object('sources', jsonb_build_array(x1, x2, x3), 'expiry', '{"kind": "duration", "minutes": 120}'::jsonb), 'G10');
  INSERT INTO t.saved VALUES ('H10', h::text);
  exp0 := (t.h(h)).expires_at;
  -- التضييق فوري
  j := t.call(t.u('S1'), t.amend_sql(h, jsonb_build_object('sources', jsonb_build_array(x1), 'expiry', '{"kind": "duration", "minutes": 60}'::jsonb)));
  PERFORM t.ok(j ->> 'scope_change' = 'narrowed' AND (t.h(h)).scope_version = 2 AND (t.h(h)).expires_at < exp0, 'G10 narrowed immediately');
  PERFORM t.ok(t.positions(t.shared(t.u('S2'), a)) = '1' AND t.excerpts(t.shared(t.u('S2'), a)) LIKE 'MARKERA1%', 'G10 narrowed read');
  -- التوسيع: مقترح، والقديم يحكم
  j := t.call(t.u('S1'), t.amend_sql(h, jsonb_build_object('sources', jsonb_build_array(x1, x2), 'expiry', '{"kind": "duration", "minutes": 60}'::jsonb)));
  PERFORM t.ok(j ->> 'scope_change' = 'proposed' AND (t.h(h)).scope_version = 2, 'G10 expansion proposed only');
  PERFORM t.ok(t.positions(t.shared(t.u('S2'), a)) = '1', 'G10 old scope governs');
  j := t.call(t.u('S2'), 'public.continuity_shared_with_me()');
  PERFORM t.ok(jsonb_array_length(j -> 'proposals') = 1 AND (j -> 'proposals' -> 0 -> 'proposed' -> 'counts' ->> 'sources')::int = 2
               AND (j -> 'proposals' -> 0 -> 'current' -> 'counts' ->> 'sources')::int = 1, 'G10 proposal visible to recipient');
  v := (j -> 'proposals' -> 0 -> 'proposed' ->> 'version')::int;
  -- المالك لا يقبل بالنيابة؛ المستلم يقبل
  PERFORM t.ok(t.err(t.u('S1'), format('public.continuity_handover_respond_scope(%L::uuid, %s, true)', h, v)) = 'P0002', 'G10 only recipient responds');
  PERFORM t.call(t.u('S2'), format('public.continuity_handover_respond_scope(%L::uuid, %s, true)', h, v));
  PERFORM t.ok(t.positions(t.shared(t.u('S2'), a)) = '1,2' AND (t.h(h)).scope_version = v, 'G10 accepted expansion applies');
  -- خليط: التقاطع فورًا، والكامل مقترح؛ ثم الرفض
  j := t.call(t.u('S1'), t.amend_sql(h, jsonb_build_object('sources', jsonb_build_array(x2, x3), 'expiry', '{"kind": "duration", "minutes": 30}'::jsonb)));
  PERFORM t.ok(j ->> 'scope_change' = 'proposed', 'G10 mixed ⇒ proposed');
  PERFORM t.ok(t.excerpts(t.shared(t.u('S2'), a)) LIKE 'MARKERA2%' AND t.positions(t.shared(t.u('S2'), a)) = '1', 'G10 intersection applied at once');
  v := (SELECT version FROM public.continuity_handover_scopes WHERE handover_id = h AND status = 'proposed');
  PERFORM t.call(t.u('S2'), format('public.continuity_handover_respond_scope(%L::uuid, %s, false)', h, v));
  PERFORM t.ok((SELECT status FROM public.continuity_handover_scopes WHERE handover_id = h AND version = v) = 'rejected'
               AND t.positions(t.shared(t.u('S2'), a)) = '1', 'G10 rejected proposal changes nothing');
  -- من لا يدير: المستلم غير موجود، عضو الفريق ممنوع؛ المستمر مرفوض
  PERFORM t.ok(t.err(t.u('S2'), t.amend_sql(h, '{"sources": "all"}')) = 'P0002', 'G10 recipient cannot amend');
  PERFORM t.ok(t.err(t.u('S3'), t.amend_sql(h, '{"sources": "all"}')) = '42501', 'G10 team cannot amend');
  PERFORM t.ok((t.errj(t.u('S1'), t.amend_sql(h, '{"sources": "all", "expiry": {"kind": "ongoing"}}'))) ->> 'state' = '0A000', 'G10 ongoing refused');
  -- التاريخ للمدير
  j := t.call(t.u('S1'), format('public.continuity_handover_scope(%L::uuid)', h));
  PERFORM t.ok(jsonb_array_length(j -> 'scopes') >= 4 AND (j ->> 'can_manage')::boolean AND j ->> 'state' = 'active', 'G10 scope history');
  PERFORM t.ok(t.evs(a, 'handover_scope_narrowed') = 2 AND t.evs(a, 'handover_scope_proposed') = 2 AND t.evs(a, 'handover_scope_accepted') = 1, 'G10 events');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS G10 amend';
END $$;

-- ============================================================================
-- G11 مفتاح الإيقاف، أهلية المستلم، سلطة المانح
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); h uuid := (SELECT v::uuid FROM t.saved WHERE k = 'H10'); g uuid;
BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.pol('{"handovers_enabled": false}');
  PERFORM t.ok(t.err(t.u('S2'), t.shared_sql(a)) = 'P0002', 'G11 off ⇒ no shared read');
  PERFORM t.ok(t.err(t.u('S2'), 'public.continuity_shared_with_me()') = '0A000', 'G11 off ⇒ list refused');
  PERFORM t.ok(t.err(t.u('S1'), t.hreq_sql(a, t.u('GR'), 'review', '{}', 'G11x')) = '0A000', 'G11 off ⇒ no request');
  PERFORM t.pol('{"handovers_enabled": true}');
  PERFORM t.ok(t.err(t.u('S2'), t.shared_sql(a)) = 'ok' AND (t.h(h)).state = 'accepted', 'G11 on again ⇒ nothing lost');
  -- المستلم لم يعد مؤهلًا
  PERFORM t.act(NULL);
  UPDATE public.profiles SET ban_status = 'banned' WHERE id = t.u('S2');
  PERFORM t.ok(t.err(t.u('S2'), t.shared_sql(a)) IN ('P0002', '42501'), 'G11 banned recipient refused');
  PERFORM t.ok(public._continuity_grant_state(t.h(h), false) = 'recipient_ineligible', 'G11 state recipient_ineligible');
  PERFORM t.act(NULL);
  UPDATE public.profiles SET ban_status = NULL WHERE id = t.u('S2');
  PERFORM t.ok(t.err(t.u('S2'), t.shared_sql(a)) = 'ok', 'G11 unbanned before sweep ⇒ back');
  PERFORM t.call(t.u('S1'), t.revoke_sql(h));
  -- المانح (مشرف) فقد سلطته
  g := t.grant(t.u('EA'), a, t.u('S2'), jsonb_build_object('sources', jsonb_build_array(t.src(a, 1))), 'G11g');
  PERFORM t.ok(t.err(t.u('S2'), t.shared_sql(a)) = 'ok', 'G11 supervisor grant works');
  PERFORM t.act(NULL);
  UPDATE public.profiles SET ban_status = 'banned' WHERE id = t.u('EA');
  PERFORM t.ok(t.err(t.u('S2'), t.shared_sql(a)) = 'P0002', 'G11 grantor lost authority ⇒ refused');
  PERFORM public.continuity_grant_sweep();
  PERFORM t.ok((t.h(g)).state = 'revoked' AND (t.h(g)).revoke_cause = 'grantor_lost_authority', 'G11 sweep revokes');
  PERFORM t.act(NULL);
  UPDATE public.profiles SET ban_status = NULL WHERE id = t.u('EA');
  PERFORM t.ok(t.err(t.u('S2'), t.shared_sql(a)) = 'P0002', 'G11 no return after revoke');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS G11 kill switch, eligibility, authority';
END $$;

-- ============================================================================
-- G12 الثبات، وعدم التسرب، ومسار relay-api
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); h uuid; sc uuid; x text; y text;
BEGIN
  PERFORM t.ctx('admin');
  h := t.grant(t.u('S1'), a, t.u('S2'), jsonb_build_object('sources', jsonb_build_array(t.src(a, 1))), 'G12');
  sc := (SELECT id FROM public.continuity_handover_scopes WHERE handover_id = h AND status = 'approved');
  PERFORM t.ok(t.err_su(format('delete from public.continuity_handover_scopes where id = %L', sc)) = '42501', 'G12 scope no delete');
  PERFORM t.ok(t.err_su(format('update public.continuity_handover_scopes set source_ids = ''{}'' where id = %L', sc)) = '42501', 'G12 scope immutable');
  PERFORM t.ok(t.err_su(format('update public.continuity_handover_scopes set status = ''proposed'' where id = %L', sc)) = '42501', 'G12 scope status one way');
  PERFORM t.ok(t.err_su(format('update public.continuity_handovers set mode = ''transfer'', scope_version = null where id = %L', h)) = '42501', 'G12 mode fixed');
  PERFORM t.ok(t.err_su(format('update public.continuity_handovers set to_owner = %L where id = %L', t.u('GR'), h)) = '42501', 'G12 recipient fixed');
  PERFORM t.ok(t.err_su(format('update public.continuity_handovers set expires_at = now() + interval ''30 days'' where id = %L', h)) = '42501', 'G12 expiry capped by policy max');
  PERFORM t.ok(t.err_su(format('delete from public.continuity_handovers where id = %L', h)) = '42501', 'G12 handover no delete');
  PERFORM t.ok(t.err_su(format('insert into public.continuity_handover_scopes (handover_id, record_id, workspace_id, version, status, source_ids, expiry_kind, duration_minutes, reason) '
                               || 'select %L, %L, workspace_id, 99, ''approved'', array[gen_random_uuid()], ''duration'', 5, ''x'' from public.continuity_records where id = %L', h, a, a)) IN ('23514', '23505'), 'G12 foreign item refused');
  -- نفس «غير موجود» لمعرّف غير موجود ولسجل بلا منحة
  x := t.errfull(t.u('GR'), t.shared_sql(a));
  y := t.errfull(t.u('GR'), t.shared_sql(gen_random_uuid()));
  PERFORM t.ok(x = y AND x LIKE 'P0002|%', 'G12 same not_found: ' || x);
  PERFORM t.ok(t.errfull(t.u('GR'), t.check_sql(t.src(a, 1))) = y, 'G12 attachment check same not_found');
  -- relay-api (continuity_client) لا يقرأ المشترك
  BEGIN
    PERFORM t.call_api(t.u('S2'), t.shared_sql(a));
    x := 'ok';
  EXCEPTION WHEN others THEN
    x := sqlstate;
  END;
  PERFORM t.ok(x = 'P0002', 'G12 api client refused: ' || x);
  PERFORM t.ok(t.err(t.u('S2'), t.shared_sql(a)) = 'ok', 'G12 native client reads');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS G12 immutability, no leak, api path';
END $$;
DO $$
BEGIN
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename LIKE 'continuity%'), 'G12 no realtime');
  -- رفع الانتهاء يدويًا لا يتخطى السياسة: المدة المعتمدة لم تتغير (البوابة تقرأ expires_at فقط؛ نوثق ذلك)
END $$;

-- ============================================================================
-- G13 التسليم الكامل كما هو، والسياسة
-- ============================================================================
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA'); h uuid; j jsonb;
BEGIN
  PERFORM t.ctx('admin');
  -- 8 معاملات بوضع transfer = دالة 081 بالضبط (والقرار القديم بالنسخة)
  j := t.call(t.u('S1'), t.hreq_sql(a, t.u('S3'), 'transfer', NULL, 'G13'));
  h := (j -> 'handover' ->> 'id')::uuid;
  PERFORM t.ok((t.h(h)).mode = 'transfer' AND (t.h(h)).scope_version IS NULL, 'G13 transfer row');
  PERFORM t.ok((t.call(t.u('S3'), 'public.continuity_handovers_mine()') -> 'incoming' -> 0 -> 'package' ->> 'source_count')::int = 3, 'G13 transfer package as 081');
  PERFORM t.call(t.u('S3'), format('public.continuity_handover_decide(%L::uuid, ''accept'', null, %s)', h, t.ver2(a)));
  PERFORM t.ok(t.owner(a) = t.u('S3') AND (t.h(h)).state = 'accepted', 'G13 transfer moves ownership');
  -- المنحة القائمة (G12) سُحبت بتغيير المالك
  PERFORM t.ok((SELECT count(*) FROM public.continuity_handovers WHERE record_id = a AND state = 'accepted' AND mode <> 'transfer') = 0, 'G13 transfer revokes grants');
  PERFORM t.call(t.u('EA'), format('public.continuity_assign(%L::uuid, %L::uuid, %L::uuid, %s)', a, t.u('S1'), t.u('T1'), t.ver2(a)));
  -- السياسة: المدد قابلة للتعديل بحدودها، والمستمر يُفعَّل صراحة
  PERFORM t.pol('{"delegation_default_minutes": 60, "delegation_max_minutes": 1440}');
  PERFORM t.ok((SELECT delegation_default_minutes FROM public._continuity_policy_row()) = 60, 'G13 policy updated');
  PERFORM t.ok(t.err(t.u('OW'), format('public.continuity_set_policies(%L::jsonb, %s)', '{"delegation_max_minutes": 20000}',
               (SELECT version FROM public._continuity_policy_row()))) <> 'ok', 'G13 > 7 days refused');
  PERFORM t.ok((t.errj(t.u('S1'), t.hreq_sql(a, t.u('S2'), 'review', '{"expiry": {"kind": "duration", "minutes": 1441}}', 'G13b'))) ->> 'reason' = 'range', 'G13 new max applies');
  h := t.hreq(t.u('S1'), a, t.u('S2'), 'review', '{"sources": "all"}', 'G13c');
  PERFORM t.ok((SELECT duration_minutes FROM public.continuity_handover_scopes WHERE handover_id = h) = 60, 'G13 new default applies');
  PERFORM t.call(t.u('S1'), format('public.continuity_handover_cancel(%L::uuid, null)', h));
  PERFORM t.pol('{"delegation_allow_ongoing": true}');
  h := t.grant(t.u('S1'), a, t.u('S2'), '{"sources": "all", "expiry": {"kind": "ongoing"}}', 'G13d');
  PERFORM t.ok((t.h(h)).expires_at IS NULL AND t.err(t.u('S2'), t.shared_sql(a)) = 'ok', 'G13 ongoing when allowed');
  PERFORM t.pol('{"delegation_allow_ongoing": false}');
  PERFORM t.ok(t.err(t.u('S2'), t.shared_sql(a)) = 'P0002', 'G13 ongoing stops when policy turned off');
  PERFORM t.call(t.u('S1'), t.revoke_sql(h));
  PERFORM t.pol('{"delegation_default_minutes": 240, "delegation_max_minutes": 10080}');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS G13 transfer unchanged, policy';
END $$;

-- ============================================================================
-- RERUN
-- ============================================================================
CREATE TABLE t.fp AS SELECT t.fp091() AS v;
\i migrations/091_continuity_scoped_handover.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok((SELECT v FROM t.fp) = t.fp091(), 'RERUN identical');
  RAISE NOTICE 'PASS RERUN';
END $$;

-- ============================================================================
-- RB
-- ============================================================================
\set rb091_sql `cat migrations/_rollback/091_continuity_scoped_handover.down.sql`
SELECT set_config('t.rb091_sql', :'rb091_sql', false) IS NOT NULL;
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
  c := t.try('rb90', current_setting('t.rb091_sql'));
  PERFORM t.ok(c LIKE '%rollback_discard_data%' AND to_regclass('public.continuity_handover_scopes') IS NOT NULL, 'RB refused with review history: ' || c);
  RAISE NOTICE 'PASS RB refuses without consent';
END $$;
SET continuity.rollback_discard_data = 'on';
\i migrations/_rollback/091_continuity_scoped_handover.down.sql
RESET continuity.rollback_discard_data;
DO $$
DECLARE a uuid := (SELECT v::uuid FROM t.saved WHERE k = 'RA');
BEGIN
  PERFORM t.ok(t.fp6() = (SELECT v FROM t.saved WHERE k = 'fp6_before'), 'RB six functions back to production text');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.continuity_handovers WHERE state = 'revoked'), 'RB only transfer rows kept');
  PERFORM t.ok((SELECT count(*) FROM public.continuity_handovers) = 1, 'RB transfer history kept (G13)');
  PERFORM t.ok(t.owner(a) = t.u('S1'), 'RB ownership unchanged');
  PERFORM t.ctx('admin');
  -- 081 يعمل كما كان
  PERFORM t.ok(jsonb_typeof(t.call(t.u('S1'), format('public.continuity_handovers_for_record(%L::uuid)', a))) = 'array', 'RB 081 read works');
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS RB rollback';
END $$;
\i migrations/091_continuity_scoped_handover.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok((SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.prokind = 'f'
                   AND strpos(pg_get_functiondef(p.oid), '091_continuity_scoped_handover') > 0) = 6, 'RB re-apply');
  RAISE NOTICE 'PASS RB re-apply';
  RAISE NOTICE 'ALL 091 scoped handover tests passed';
END $$;
