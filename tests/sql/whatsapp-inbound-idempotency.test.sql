-- ============================================================================
-- اختبار تنفيذي لـ 063: رسالة واتساب الواردة بتتخزّن مرة واحدة (W1).
--
-- كل خاصية ليها قسم بيفشل لو اتكسرت:
--   Ⓐ الثغرة موجودة قبل 063: نفس الرسالة من جلستين حقيقيتين (dblink) = صفين
--   Ⓑ التعبئة على بيانات بشكل الإنتاج (مجموعتين مكررتين زي الإنتاج بالظبط:
--      واحدة بمستأجر وواحدة user_id NULL): الأصل = أول صف (created_at, id)
--      وياخد wa_message_id، النسخة تاخد duplicate_of_id، ومفيش صف اتحذف
--      ولا محتوى اتغيّر، والصادر والوارد من غير معرّف زي ما هم
--   Ⓒ wa_insert_inbound_message: أول مرة id، تاني مرة NULL وصف واحد بس
--   Ⓓ تزامن حقيقي: جلستين بنفس المعرّف في نفس اللحظة — التانية بتستنى على
--      القيد وبترجع NULL بعد commit الأولى، وبتكسب لو الأولى عملت rollback
--   Ⓔ الصلاحيات: service_role بس
--   Ⓕ إعادة التشغيل مابتغيّرش حاجة
--   Ⓖ التراجع: بيشيل السلوك ومابيحذفش بيانات، والمسار القديم يشتغل، وإعادة
--      التطبيق بعد التراجع بتعلّم أي تكرار حصل في الفترة دي
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
SET client_min_messages = notice;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS t;
CREATE EXTENSION IF NOT EXISTS dblink SCHEMA t;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
-- زي Supabase: أي دالة جديدة في public بتاخد EXECUTE لـ anon و authenticated
-- تلقائيًا. من غير السطر ده، نسيان الـrevoke في 063 كان هيعدّي الاختبار.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- ── الجدول بشكل الإنتاج (information_schema، 2026-09-29) ────────────────
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE TABLE public.messages (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id),
  from_number text, to_number text, message_text text,
  message_type text DEFAULT 'text'::text, direction text DEFAULT 'inbound'::text,
  status text DEFAULT 'received'::text, waba_id text,
  "timestamp" timestamptz DEFAULT now(), raw_data jsonb, created_at timestamptz DEFAULT now(),
  read_at timestamptz, client_id uuid, delivery_status text DEFAULT 'sent'::text,
  is_read boolean DEFAULT false, sender_type text DEFAULT 'user'::text,
  updated_at timestamptz DEFAULT now(), file_name text, file_url text, file_size bigint,
  mime_type text, attachment_type text, wa_message_id text,
  uuid_id uuid DEFAULT gen_random_uuid(), contact_bsuid text);
CREATE INDEX messages_user_id_wa_message_id_idx ON public.messages (user_id, wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE INDEX messages_user_id_timestamp_idx ON public.messages (user_id, "timestamp" DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.messages TO authenticated, service_role;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own messages" ON public.messages FOR SELECT USING (false);
-- حارس المعاينة كما في الإنتاج (preview_mode() = false خارج سياق المعاينة).
CREATE FUNCTION public.preview_mode() RETURNS boolean LANGUAGE sql STABLE AS $$ select false $$;
CREATE FUNCTION public.guard_preview_read_only() RETURNS trigger LANGUAGE plpgsql AS $$
begin
  if public.preview_mode() then
    raise exception 'معاينة عضو الشركة للقراءة فقط — اخرج من السياق للكتابة' using errcode = '42501';
  end if;
  return null;
end; $$;
CREATE TRIGGER trg_preview_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.messages
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_preview_read_only();

INSERT INTO auth.users VALUES ('00000000-0000-4000-8000-00000000000a'), ('00000000-0000-4000-8000-00000000000b');

CREATE FUNCTION t.conn(p text) RETURNS text LANGUAGE sql AS $$
  select t.dblink_connect(p, format('dbname=%s port=%s host=%s user=postgres', current_database(),
         current_setting('port'), split_part(current_setting('unix_socket_directories'), ',', 1))); $$;

-- إدراج v66 بالظبط (index.ts قبل W1): من غير wa_message_id.
CREATE FUNCTION t.v66_insert(p_user uuid, p_wamid text) RETURNS text LANGUAGE sql AS $$
  select format($q$insert into public.messages (user_id, from_number, to_number, contact_bsuid, message_text, message_type,
           direction, status, waba_id, "timestamp", raw_data)
           values (%L, '201000000001', '111000111', null, 'مرحبا', 'text', 'inbound', 'received', '111000111', now(),
                   jsonb_build_object('id', %L, 'type', 'text'))$q$, p_user, p_wamid); $$;
-- نداء W1 بالظبط.
CREATE FUNCTION t.w1_call(p_user uuid, p_wamid text) RETURNS text LANGUAGE sql AS $$
  select format($q$select coalesce(public.wa_insert_inbound_message(%L, %L, '201000000001', '111000111', null, 'مرحبا', 'text',
           '111000111', now(), jsonb_build_object('id', %L, 'type', 'text'))::text, 'DUPLICATE')$q$, p_user, p_wamid, p_wamid); $$;

-- ══ Ⓐ قبل 063: الثغرة حقيقية ═══════════════════════════════════════════════
DO $$
declare n int;
begin
  perform t.conn('a1'); perform t.conn('a2');
  perform t.dblink_exec('a1', 'begin');
  perform t.dblink_exec('a1', t.v66_insert('00000000-0000-4000-8000-00000000000a', 'wamid.RACE0'));
  perform t.dblink_exec('a2', t.v66_insert('00000000-0000-4000-8000-00000000000a', 'wamid.RACE0'));
  perform t.dblink_exec('a1', 'commit');
  perform t.dblink_disconnect('a1'); perform t.dblink_disconnect('a2');
  select count(*) into n from public.messages where raw_data->>'id' = 'wamid.RACE0';
  if n <> 2 then raise exception 'FAIL A: قبل 063 كان متوقع صفين، لقينا %', n; end if;
  delete from public.messages;
  RAISE NOTICE 'PASS A: قبل 063 نفس الرسالة من جلستين = صفين (الثغرة حقيقية)';
end $$;

-- ══ Ⓑ بيانات بشكل الإنتاج ثم 063 ══════════════════════════════════════════
INSERT INTO public.messages (id, user_id, direction, message_type, message_text, raw_data, created_at, wa_message_id, status) VALUES
  -- مجموعة 1 (زي الإنتاج): نفس المستأجر، نص الثانية فرق 0.5 ثانية، raw مختلف شوية
  ('0c1a20c8-f999-4076-99dc-a5d99a97162f', '00000000-0000-4000-8000-00000000000a', 'inbound', 'unsupported', '[unsupported]',
   '{"id":"wamid.DUP1","type":"unsupported"}', '2026-08-09 16:02:53.292065+00', null, 'received'),
  ('0759ea2d-204d-46f3-8961-ce49ba021d3a', '00000000-0000-4000-8000-00000000000a', 'inbound', 'unsupported', '[unsupported]',
   '{"id":"wamid.DUP1","type":"unsupported","errors":[1]}', '2026-08-09 16:02:53.854579+00', null, 'received'),
  -- مجموعة 2 (زي الإنتاج): user_id NULL، شهر بين النسختين
  ('25af861d-3bbc-47b0-b750-2fbedfb1901b', null, 'inbound', 'text', 'x', '{"id":"wamid.DUP2","type":"text"}',
   '2026-05-09 03:26:28.663171+00', null, 'received'),
  ('2e00f04b-5b07-4bb6-8556-213c9f1dc60a', null, 'inbound', 'text', 'x', '{"id":"wamid.DUP2","type":"text"}',
   '2026-06-11 18:40:58.565179+00', null, 'received'),
  -- رسالة واردة عادية
  ('11111111-1111-4111-8111-111111111111', '00000000-0000-4000-8000-00000000000a', 'inbound', 'text', 'عادي',
   '{"id":"wamid.OK1","type":"text"}', '2026-09-01 10:00:00+00', null, 'received'),
  -- نفس المعرّف عند مستأجر تاني (مش تكرار)
  ('22222222-2222-4222-8222-222222222222', '00000000-0000-4000-8000-00000000000b', 'inbound', 'text', 'تاني',
   '{"id":"wamid.OK1","type":"text"}', '2026-09-01 10:00:01+00', null, 'received'),
  -- واردة من غير معرّف (3 في الإنتاج)
  ('33333333-3333-4333-8333-333333333333', '00000000-0000-4000-8000-00000000000a', 'inbound', 'text', 'بدون', '{}',
   '2026-09-01 10:00:02+00', null, 'received'),
  -- صادرة بمعرّفها (ماتتلمسش)
  ('44444444-4444-4444-8444-444444444444', '00000000-0000-4000-8000-00000000000a', 'outbound', 'text', 'رد',
   '{"messages":[{"id":"wamid.OUT1"}]}', '2026-09-01 10:00:03+00', 'wamid.OUT1', 'sent'),
  -- صادرة مكررة المعرّف (مسار الإرسال مالوش قيد، ولازم يفضل كده)
  ('55555555-5555-4555-8555-555555555555', '00000000-0000-4000-8000-00000000000a', 'outbound', 'text', 'رد2', '{}',
   '2026-09-01 10:00:04+00', 'wamid.OUT2', 'sent'),
  ('66666666-6666-4666-8666-666666666666', '00000000-0000-4000-8000-00000000000a', 'outbound', 'text', 'رد2', '{}',
   '2026-09-01 10:00:05+00', 'wamid.OUT2', 'sent');

CREATE TABLE t.before AS
  SELECT id, md5(row(user_id, from_number, to_number, message_text, message_type, direction, status, waba_id,
                     "timestamp", raw_data, created_at, read_at, client_id, delivery_status, is_read, sender_type,
                     updated_at, file_name, file_url, file_size, mime_type, attachment_type, uuid_id, contact_bsuid)::text) h,
         wa_message_id
    FROM public.messages;

\i migrations/063_whatsapp_inbound_idempotency.sql

DO $$
declare r record; n int;
begin
  -- مفيش صف اتحذف ولا اتضاف
  if (select count(*) from public.messages) <> (select count(*) from t.before) then
    raise exception 'FAIL B: عدد الصفوف اتغيّر';
  end if;
  -- ولا محتوى اتغيّر (كل الأعمدة ما عدا wa_message_id و duplicate_of_id)
  select count(*) into n from public.messages m join t.before b using (id)
   where md5(row(m.user_id, m.from_number, m.to_number, m.message_text, m.message_type, m.direction, m.status, m.waba_id,
                 m."timestamp", m.raw_data, m.created_at, m.read_at, m.client_id, m.delivery_status, m.is_read, m.sender_type,
                 m.updated_at, m.file_name, m.file_url, m.file_size, m.mime_type, m.attachment_type, m.uuid_id, m.contact_bsuid)::text) <> b.h;
  if n <> 0 then raise exception 'FAIL B: % صف اتغيّر محتواه', n; end if;

  -- مجموعة 1: الأصل الأقدم ياخد المعرّف، النسخة بتشاور عليه
  select wa_message_id, duplicate_of_id into r from public.messages where id = '0c1a20c8-f999-4076-99dc-a5d99a97162f';
  if r.wa_message_id is distinct from 'wamid.DUP1' or r.duplicate_of_id is not null then raise exception 'FAIL B: أصل مجموعة 1 %', r; end if;
  select wa_message_id, duplicate_of_id into r from public.messages where id = '0759ea2d-204d-46f3-8961-ce49ba021d3a';
  if r.wa_message_id is not null or r.duplicate_of_id is distinct from '0c1a20c8-f999-4076-99dc-a5d99a97162f' then
    raise exception 'FAIL B: نسخة مجموعة 1 %', r; end if;
  -- مجموعة 2 (user_id NULL)
  select wa_message_id, duplicate_of_id into r from public.messages where id = '25af861d-3bbc-47b0-b750-2fbedfb1901b';
  if r.wa_message_id is distinct from 'wamid.DUP2' or r.duplicate_of_id is not null then raise exception 'FAIL B: أصل مجموعة 2 %', r; end if;
  select wa_message_id, duplicate_of_id into r from public.messages where id = '2e00f04b-5b07-4bb6-8556-213c9f1dc60a';
  if r.wa_message_id is not null or r.duplicate_of_id is distinct from '25af861d-3bbc-47b0-b750-2fbedfb1901b' then
    raise exception 'FAIL B: نسخة مجموعة 2 %', r; end if;
  -- نفس المعرّف عند مستأجرين = مش تكرار، الاتنين ياخدوه
  if (select count(*) from public.messages where wa_message_id = 'wamid.OK1' and duplicate_of_id is null) <> 2 then
    raise exception 'FAIL B: نفس المعرّف عند مستأجرين اتعامل كتكرار'; end if;
  -- الوارد من غير معرّف والصادر زي ما هم
  if exists (select 1 from public.messages m join t.before b using (id)
              where m.id in ('33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444',
                             '55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666')
                and (m.wa_message_id is distinct from b.wa_message_id or m.duplicate_of_id is not null)) then
    raise exception 'FAIL B: صف مالوش علاقة اتلمس'; end if;
  RAISE NOTICE 'PASS B: الأصل الأقدم أخد wa_message_id والنسخ اتعلّمت، ومفيش حذف ولا تغيير محتوى، والصادر مالمسش';
end $$;

-- ══ Ⓒ الإدراج الذري ═══════════════════════════════════════════════════════
DO $$
declare v1 uuid; v2 uuid; v3 uuid; v4 uuid; v5 uuid;
begin
  set local role service_role;
  v1 := public.wa_insert_inbound_message('00000000-0000-4000-8000-00000000000a', 'wamid.NEW1', '2010', '111', null, 'a', 'text', '111', now(), '{"id":"wamid.NEW1"}');
  v2 := public.wa_insert_inbound_message('00000000-0000-4000-8000-00000000000a', 'wamid.NEW1', '2010', '111', null, 'a', 'text', '111', now(), '{"id":"wamid.NEW1"}');
  v3 := public.wa_insert_inbound_message('00000000-0000-4000-8000-00000000000b', 'wamid.NEW1', '2010', '222', null, 'a', 'text', '222', now(), '{"id":"wamid.NEW1"}');
  -- المعرّف الموجود قبل 063 (أصل مجموعة 1) = إعادة إرسال متأخرة
  v4 := public.wa_insert_inbound_message('00000000-0000-4000-8000-00000000000a', 'wamid.DUP1', '2010', '111', null, 'a', 'unsupported', '111', now(), '{"id":"wamid.DUP1"}');
  -- من غير معرّف (أو فاضي): بيتدرج دايمًا
  v5 := public.wa_insert_inbound_message('00000000-0000-4000-8000-00000000000a', '  ', '2010', '111', null, 'a', 'text', '111', now(), '{}');
  reset role;
  if v1 is null then raise exception 'FAIL C: أول مرة لازم ترجع id'; end if;
  if v2 is not null then raise exception 'FAIL C: المرة التانية لازم ترجع NULL'; end if;
  if v3 is null then raise exception 'FAIL C: مستأجر تاني بنفس المعرّف لازم يتدرج'; end if;
  if v4 is not null then raise exception 'FAIL C: إعادة إرسال لرسالة قبل 063 اتدرجت'; end if;
  if v5 is null then raise exception 'FAIL C: رسالة من غير معرّف ماتدرجتش'; end if;
  if (select count(*) from public.messages where user_id = '00000000-0000-4000-8000-00000000000a' and wa_message_id = 'wamid.NEW1') <> 1 then
    raise exception 'FAIL C: مش صف واحد'; end if;
  if (select wa_message_id from public.messages where id = v5) is not null then raise exception 'FAIL C: المعرّف الفاضي اتخزّن'; end if;
  if (select direction || '/' || status from public.messages where id = v1) <> 'inbound/received' then raise exception 'FAIL C: شكل الصف'; end if;
  RAISE NOTICE 'PASS C: أول مرة id، التكرار NULL وصف واحد، مستأجر تاني منفصل، ومن غير معرّف بيتدرج';
end $$;

-- ══ Ⓓ تزامن حقيقي (نفس الـwebhook من اتصالين) ═════════════════════════════
DO $$
declare r1 text; r2 text; busy int; n int;
begin
  perform t.conn('d1'); perform t.conn('d2');
  -- ① الأولى تدرج ولسه ماعملتش commit — التانية لازم تستنى على القيد
  perform t.dblink_exec('d1', 'begin');
  select x into r1 from t.dblink('d1', t.w1_call('00000000-0000-4000-8000-00000000000a', 'wamid.RACE1')) as (x text);
  perform t.dblink_send_query('d2', t.w1_call('00000000-0000-4000-8000-00000000000a', 'wamid.RACE1'));
  perform pg_sleep(0.3);
  busy := t.dblink_is_busy('d2');
  if busy <> 1 then raise exception 'FAIL D: الجلسة التانية ماستنتش على القيد (busy=%)', busy; end if;
  perform t.dblink_exec('d1', 'commit');
  select x into r2 from t.dblink_get_result('d2') as (x text);
  perform t.dblink_get_result('d2');
  if r1 = 'DUPLICATE' or r2 <> 'DUPLICATE' then raise exception 'FAIL D: r1=% r2=%', r1, r2; end if;
  select count(*) into n from public.messages where wa_message_id = 'wamid.RACE1';
  if n <> 1 then raise exception 'FAIL D: % صف بدل 1', n; end if;

  -- ② الأولى عملت rollback (الـwebhook وقع قبل commit) — التانية تكسب
  perform t.dblink_exec('d1', 'begin');
  select x into r1 from t.dblink('d1', t.w1_call('00000000-0000-4000-8000-00000000000a', 'wamid.RACE2')) as (x text);
  perform t.dblink_send_query('d2', t.w1_call('00000000-0000-4000-8000-00000000000a', 'wamid.RACE2'));
  perform pg_sleep(0.3);
  perform t.dblink_exec('d1', 'rollback');
  select x into r2 from t.dblink_get_result('d2') as (x text);
  perform t.dblink_get_result('d2');
  if r2 = 'DUPLICATE' then raise exception 'FAIL D: بعد rollback الأولى، التانية لازم تكسب'; end if;
  select count(*) into n from public.messages where wa_message_id = 'wamid.RACE2';
  if n <> 1 then raise exception 'FAIL D: % صف بعد rollback بدل 1', n; end if;
  perform t.dblink_disconnect('d1'); perform t.dblink_disconnect('d2');
  RAISE NOTICE 'PASS D: من اتصالين في نفس اللحظة: فائز واحد، والتاني بيستنى القيد ويرجع DUPLICATE (ويكسب لو الأول وقع)';
end $$;

-- ══ Ⓔ الصلاحيات ══════════════════════════════════════════════════════════
DO $$
declare f constant text := 'public.wa_insert_inbound_message(uuid, text, text, text, text, text, text, text, timestamptz, jsonb)';
begin
  if has_function_privilege('anon', f, 'EXECUTE') or has_function_privilege('authenticated', f, 'EXECUTE')
     or has_function_privilege('public', f, 'EXECUTE') then
    raise exception 'FAIL E: متاحة لعميل'; end if;
  if not has_function_privilege('service_role', f, 'EXECUTE') then raise exception 'FAIL E: service_role مايقدرش'; end if;
  begin
    set local role authenticated;
    perform public.wa_insert_inbound_message('00000000-0000-4000-8000-00000000000a', 'wamid.X', null, null, null, null, 'text', null, now(), '{}');
    raise exception 'FAIL E: authenticated نادى الدالة';
  exception when insufficient_privilege then null;
  end;
  reset role;
  RAISE NOTICE 'PASS E: الإدراج الذري لـ service_role بس';
end $$;

-- ══ Ⓕ إعادة التشغيل ═══════════════════════════════════════════════════════
CREATE TABLE t.snap AS SELECT id, wa_message_id, duplicate_of_id FROM public.messages;
\i migrations/063_whatsapp_inbound_idempotency.sql
DO $$
begin
  if exists (select 1 from public.messages m full join t.snap s using (id)
              where m.id is null or s.id is null
                 or m.wa_message_id is distinct from s.wa_message_id or m.duplicate_of_id is distinct from s.duplicate_of_id) then
    raise exception 'FAIL F: إعادة التشغيل غيّرت بيانات'; end if;
  RAISE NOTICE 'PASS F: 063 قابل لإعادة التشغيل ومابيغيّرش حاجة';
end $$;

-- ══ Ⓖ التراجع ═════════════════════════════════════════════════════════════
DROP TABLE t.snap;
CREATE TABLE t.snap AS SELECT id, wa_message_id, duplicate_of_id FROM public.messages;
\i migrations/_rollback/063_whatsapp_inbound_idempotency.down.sql
DO $$
declare n int;
begin
  if to_regprocedure('public.wa_insert_inbound_message(uuid, text, text, text, text, text, text, text, timestamptz, jsonb)') is not null then
    raise exception 'FAIL G: الدالة لسه موجودة'; end if;
  if exists (select 1 from pg_indexes where indexname = 'messages_inbound_wa_message_id_key') then
    raise exception 'FAIL G: الفهرس لسه موجود'; end if;
  -- مابيحذفش ولا بيعدّل بيانات
  if exists (select 1 from public.messages m full join t.snap s using (id)
              where m.id is null or s.id is null
                 or m.wa_message_id is distinct from s.wa_message_id or m.duplicate_of_id is distinct from s.duplicate_of_id) then
    raise exception 'FAIL G: التراجع غيّر بيانات'; end if;
  -- مسار v66 القديم شغال (من غير قيد): نفس المعرّف مرتين = صفين
  execute t.v66_insert('00000000-0000-4000-8000-00000000000a', 'wamid.AFTER_RB');
  execute t.v66_insert('00000000-0000-4000-8000-00000000000a', 'wamid.AFTER_RB');
  select count(*) into n from public.messages where raw_data->>'id' = 'wamid.AFTER_RB';
  if n <> 2 then raise exception 'FAIL G: المسار القديم مااشتغلش'; end if;
  RAISE NOTICE 'PASS G1: التراجع شال الدالة والقيد بس، والبيانات زي ما هي، والمسار القديم شغال';
end $$;
-- إعادة التطبيق بعد التراجع: التكرار اللي حصل في الفترة دي بيتعلّم، والقيد بيتبني
\i migrations/063_whatsapp_inbound_idempotency.sql
DO $$
declare n_marked int; n_canon int;
begin
  select count(*) filter (where duplicate_of_id is not null), count(*) filter (where wa_message_id = 'wamid.AFTER_RB')
    into n_marked, n_canon from public.messages where raw_data->>'id' = 'wamid.AFTER_RB';
  if n_marked <> 1 or n_canon <> 1 then raise exception 'FAIL G2: marked=% canon=%', n_marked, n_canon; end if;
  RAISE NOTICE 'PASS G2: إعادة التطبيق بعد التراجع علّمت التكرار الجديد وبنت القيد';
end $$;

DO $$ BEGIN RAISE NOTICE 'ALL whatsapp-inbound-idempotency: PASS'; END $$;
