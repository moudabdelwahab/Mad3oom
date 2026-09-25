-- ============================================================================
-- اختبار تنفيذي لـ 055: صندوق الرسائل كـ helpdesk (المرحلة 1).
--
-- يثبّت، كل خاصية تفشل إن انكسرت:
--   ① D1=C: الأدمن غير المرتفع لا يرى محادثة لم تُسند له، ويراها بعد الإسناد
--   ② العميل لا يرى شيئًا من inbox_* — ولا ملاحظات جلسته هو
--   ③ رد الدعم عبر RPC = نفس عقد الويدجت (is_manual_mode ثم is_admin_reply)
--   ④ التحويل لفريق ينقل الوصول، والسبب إجباري ومحفوظ ملاحظةً وحدثًا
--   ⑤ المنشن لموظف لا يصل للمحادثة يُسقط
--   ⑥ الإقفال الجماعي كله أو لا شيء، ولا رد على محادثة مقفولة
--   ⑦ الوسوم والأرشفة والرجوع من الأرشيف بالرد، وكلها في السجل
--   ⑧ لا كتابة مباشرة على أي جدول inbox_*، والسجل لا يُعدَّل
--   ⑨ المعاينة (041) والحساب الموقوف (042) مرفوضان
--   ⑩ إدراج بشكل SIE وإدراج العميل في chat_messages يعملان كما كانا
--   ⑪ التراجع الموثّق في آخر الترحيل ينظّف كل شيء ويُبقي سياسات الشات القائمة
--
-- has_elevated_authority و is_platform_staff و guard_preview_read_only
-- منسوخة حرفيًا من الإنتاج؛ owner_capability و preview_mode والحظر بدائل
-- يتحكم فيها الاختبار.
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true),'')::uuid; $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
END $$;
GRANT USAGE ON SCHEMA auth, public TO authenticated, anon;

-- ── الجداول بشكل الإنتاج ─────────────────────────────────────────────────
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, email text, full_name text, role text DEFAULT 'user',
  phone text, ban_status text, created_at timestamptz DEFAULT now());
CREATE TABLE public.platform_authority (
  user_id uuid PRIMARY KEY, level text NOT NULL, granted_at timestamptz DEFAULT now(), note text);
CREATE TABLE public.chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status text DEFAULT 'active',
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), guest_id text,
  is_manual_mode boolean DEFAULT false, bot_state jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid REFERENCES public.chat_sessions(id),
  sender_id uuid, message_text text NOT NULL, is_bot_reply boolean DEFAULT false,
  created_at timestamptz DEFAULT now(), is_admin_reply boolean DEFAULT false,
  image_url text, audio_url text, attachment jsonb);

-- 054_chat_composer_attachments (مطبَّق على الإنتاج قبل 055): حارس المرفقات
-- على chat_messages منسوخ حرفيًا، حتى يمرّ رد الدعم عبر inbox_send_reply من
-- نفس المحفّز الذي يمرّ منه في الإنتاج.
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE storage.objects (bucket_id text, name text);
CREATE OR REPLACE FUNCTION public.chat_attachment_path_ok(p_path text, p_sender uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT p_sender IS NOT NULL
     AND p_path !~ '^[a-zA-Z][a-zA-Z0-9+.-]*:'
     AND p_path !~ '(^|/)\.\.?(/|$)'
     AND left(p_path, 1) <> '/'
     AND split_part(p_path, '/', 1) = p_sender::text
     AND EXISTS (SELECT 1 FROM storage.objects o
                  WHERE o.bucket_id = 'chat-attachments' AND o.name = p_path); $$;
CREATE OR REPLACE FUNCTION public.guard_chat_message_attachment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_path text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.image_url IS NOT DISTINCT FROM OLD.image_url
     AND NEW.audio_url IS NOT DISTINCT FROM OLD.audio_url
     AND NEW.attachment IS NOT DISTINCT FROM OLD.attachment THEN
    RETURN NEW;
  END IF;
  FOREACH v_path IN ARRAY ARRAY[NEW.image_url, NEW.audio_url, NEW.attachment->>'path'] LOOP
    IF v_path IS NOT NULL AND NOT public.chat_attachment_path_ok(v_path, NEW.sender_id) THEN
      RAISE EXCEPTION 'مرفق غير صالح: يجب أن يكون ملفًا مرفوعًا في مجلد المرسل نفسه' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_guard_chat_message_attachment
  BEFORE INSERT OR UPDATE ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.guard_chat_message_attachment();
CREATE TABLE public.ticket_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  color text NOT NULL DEFAULT '#4DA3FF', created_by uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, title text NOT NULL, message text NOT NULL,
  type text DEFAULT 'info', is_read boolean DEFAULT false, link text, created_at timestamptz DEFAULT now());
CREATE PUBLICATION supabase_realtime;
ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_sessions, public.chat_messages;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;

-- ── بدائل يتحكم فيها الاختبار ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.owner_capability(p_capability text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select coalesce(current_setting('test.owner_context', true), '') = 'on'
     and exists (select 1 from public.platform_authority a where a.user_id = auth.uid() and a.level = 'owner'); $$;
CREATE OR REPLACE FUNCTION public.preview_mode() RETURNS boolean
LANGUAGE sql STABLE AS $$ select coalesce(current_setting('test.preview', true), '') = 'on'; $$;
CREATE OR REPLACE FUNCTION public.is_banned(p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select exists (select 1 from public.profiles p where p.id = p_user_id and p.ban_status = 'permanent'); $$;
CREATE OR REPLACE FUNCTION public.account_is_active() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select auth.uid() is null or not public.is_banned(auth.uid()); $$;

-- ── منسوخة من الإنتاج حرفيًا ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.has_elevated_authority() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select exists (
           select 1
             from public.platform_authority a
             join public.profiles p on p.id = a.user_id
            where a.user_id = auth.uid()
              and a.level   = 'elevated_admin'
              and p.role    = 'admin'
         )
      or public.owner_capability('owner_only'); $$;
CREATE OR REPLACE FUNCTION public.is_platform_staff() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select exists (
           select 1 from public.profiles p
            where p.id = auth.uid() and p.role in ('admin', 'support')
         )
      or public.owner_capability('staff'); $$;
CREATE OR REPLACE FUNCTION public.guard_preview_read_only() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
begin
  if public.preview_mode() then
    raise exception 'معاينة عضو الشركة للقراءة فقط — اخرج من السياق للكتابة'
      using errcode = '42501';
  end if;
  return null;
end; $$;

-- ── سياسات الشات القائمة في الإنتاج ──────────────────────────────────────
ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_sessions_select_own_or_admin ON public.chat_sessions
  FOR SELECT USING (user_id = auth.uid() OR public.has_elevated_authority());
CREATE POLICY chat_sessions_insert_own ON public.chat_sessions
  FOR INSERT WITH CHECK (user_id = auth.uid() OR public.has_elevated_authority());
CREATE POLICY chat_sessions_update_own_or_admin ON public.chat_sessions
  FOR UPDATE USING (user_id = auth.uid() OR public.has_elevated_authority());
CREATE POLICY chat_messages_select_own_or_admin ON public.chat_messages
  FOR SELECT USING (public.has_elevated_authority() OR sender_id = auth.uid()
    OR session_id IN (SELECT s.id FROM public.chat_sessions s WHERE s.user_id = auth.uid()));
CREATE POLICY chat_messages_insert_own_or_admin ON public.chat_messages
  FOR INSERT WITH CHECK (public.has_elevated_authority() OR (
    session_id IN (SELECT s.id FROM public.chat_sessions s WHERE s.user_id = auth.uid())
    AND (sender_id = auth.uid() OR sender_id IS NULL)));
CREATE POLICY gate_account_active ON public.chat_sessions AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.account_is_active()) WITH CHECK (public.account_is_active());
CREATE POLICY gate_account_active ON public.chat_messages AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.account_is_active()) WITH CHECK (public.account_is_active());

-- ── الفاعلون والبيانات ────────────────────────────────────────────────────
--   O  مالك المنصة        E  أدمن مرتفع          A1/A2 أدمن عادي
--   S1 دعم                B  أدمن محظور          C1/C2 عملاء
INSERT INTO public.profiles (id, email, full_name, role, ban_status) VALUES
  ('00000000-0000-4000-8000-00000000000f', 'owner@t', 'المالك', 'platform_owner', null),
  ('00000000-0000-4000-8000-0000000000e1', 'e@t', 'أدمن مرتفع', 'admin', null),
  ('00000000-0000-4000-8000-0000000000a1', 'a1@t', 'أدمن واحد', 'admin', null),
  ('00000000-0000-4000-8000-0000000000a2', 'a2@t', 'أدمن اتنين', 'admin', null),
  ('00000000-0000-4000-8000-0000000000b1', 'b@t', 'أدمن محظور', 'admin', 'permanent'),
  ('00000000-0000-4000-8000-00000000005a', 's1@t', 'دعم واحد', 'support', null),
  ('00000000-0000-4000-8000-0000000000c1', 'c1@t', 'عميل واحد', 'user', null),
  ('00000000-0000-4000-8000-0000000000c2', 'c2@t', 'عميل اتنين', 'user', null);
INSERT INTO public.platform_authority (user_id, level) VALUES
  ('00000000-0000-4000-8000-00000000000f', 'owner'),
  ('00000000-0000-4000-8000-0000000000e1', 'elevated_admin');
INSERT INTO public.chat_sessions (id, user_id) VALUES
  ('5e550000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1'),
  ('5e550000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000c2');
INSERT INTO public.chat_messages (id, session_id, sender_id, message_text, is_bot_reply) VALUES
  ('3e550000-0000-4000-8000-000000000001', '5e550000-0000-4000-8000-000000000001', null, 'أهلاً', true),
  ('3e550000-0000-4000-8000-000000000002', '5e550000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1', 'عندي مشكلة', false),
  ('3e550000-0000-4000-8000-000000000003', '5e550000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000c2', 'سؤال من عميل تاني', false);
INSERT INTO public.ticket_tags (id, name) VALUES ('7a900000-0000-4000-8000-000000000001', 'فوترة');

\i migrations/055_inbox_helpdesk_core.sql

-- ── مساعدات الاختبار ─────────────────────────────────────────────────────
CREATE SCHEMA t;
GRANT USAGE ON SCHEMA t TO authenticated;
CREATE OR REPLACE FUNCTION t.act(p uuid) RETURNS void LANGUAGE sql AS $$
  select set_config('request.jwt.claim.sub', p::text, false); $$;
CREATE OR REPLACE FUNCTION t.fails(p_sql text, p_code text) RETURNS boolean LANGUAGE plpgsql AS $$
begin
  execute p_sql;
  return false;
exception when others then
  if p_code is not null and sqlstate <> p_code then
    raise notice '   (رمز غير متوقع % : %)', sqlstate, sqlerrm;
    return false;
  end if;
  return true;
end $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated;

SET ROLE authenticated;

-- ① D1=C ─────────────────────────────────────────────────────────────────
DO $$
DECLARE n int;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  SELECT count(*) INTO n FROM public.chat_sessions;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 1a: أدمن غير مرتفع يرى % جلسة قبل الإسناد', n; END IF;
  SELECT count(*) INTO n FROM public.chat_messages;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 1b: يرى % رسالة قبل الإسناد', n; END IF;
  IF NOT t.fails($q$select public.inbox_send_reply('5e550000-0000-4000-8000-000000000001', 'x')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 1c: رد على محادثة غير مسندة';
  END IF;
  IF NOT t.fails($q$select public.inbox_assign('5e550000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 1d: أسند لنفسه محادثة لا يراها';
  END IF;

  PERFORM t.act('00000000-0000-4000-8000-0000000000e1');
  SELECT count(*) INTO n FROM public.chat_sessions;
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL 1e: المرتفع يرى % جلسة', n; END IF;
  PERFORM public.inbox_assign('5e550000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1');
  IF NOT t.fails($q$select public.inbox_assign('5e550000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c2')$q$, '22023') THEN
    RAISE EXCEPTION 'FAIL 1f: إسناد لعميل';
  END IF;
  IF NOT t.fails($q$select public.inbox_assign('5e550000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000b1')$q$, '22023') THEN
    RAISE EXCEPTION 'FAIL 1g: إسناد لمحظور';
  END IF;

  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  SELECT count(*) INTO n FROM public.chat_sessions;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 1h: بعد الإسناد يرى % جلسة (المتوقع 1)', n; END IF;
  SELECT count(*) INTO n FROM public.chat_messages;
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL 1i: بعد الإسناد يرى % رسالة (المتوقع 2)', n; END IF;
  SELECT count(*) INTO n FROM public.inbox_customer_profiles(array['5e550000-0000-4000-8000-000000000001','5e550000-0000-4000-8000-000000000002']::uuid[]);
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 1j: بيانات عملاء % (المتوقع 1)', n; END IF;
  SELECT count(*) INTO n FROM public.inbox_list_agents() a WHERE a.id = '00000000-0000-4000-8000-0000000000b1';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 1k: المحظور في قائمة الموظفين'; END IF;

  PERFORM t.act('00000000-0000-4000-8000-0000000000a2');
  SELECT count(*) INTO n FROM public.chat_sessions;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 1l: أدمن تاني يرى محادثة مسندة لغيره'; END IF;
  RAISE NOTICE 'PASS 1: المرتفع يرى الكل، والأدمن العادي يرى المسند له فقط';
END $$;

-- ③ الرد = عقد الويدجت ────────────────────────────────────────────────────
DO $$
DECLARE m public.chat_messages; manual boolean; n int;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  m := public.inbox_send_reply('5e550000-0000-4000-8000-000000000001', '  أهلاً، معاك الدعم  ');
  IF NOT m.is_admin_reply OR m.sender_id <> '00000000-0000-4000-8000-0000000000a1' OR m.message_text <> 'أهلاً، معاك الدعم' THEN
    RAISE EXCEPTION 'FAIL 3a: شكل الرد %', row_to_json(m);
  END IF;
  SELECT is_manual_mode INTO manual FROM public.chat_sessions WHERE id = '5e550000-0000-4000-8000-000000000001';
  IF NOT manual THEN RAISE EXCEPTION 'FAIL 3b: البوت لم يتوقف'; END IF;
  IF NOT t.fails($q$select public.inbox_send_reply('5e550000-0000-4000-8000-000000000001', '   ')$q$, '22023') THEN
    RAISE EXCEPTION 'FAIL 3c: رد فاضي';
  END IF;

  PERFORM t.act('00000000-0000-4000-8000-0000000000c1');
  SELECT count(*) INTO n FROM public.chat_messages WHERE is_admin_reply;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 3d: العميل لا يرى رد الدعم'; END IF;
  RAISE NOTICE 'PASS 3: رد الدعم يوقف البوت ويُكتب كرد أدمن ويصل للعميل';
END $$;

-- ② العميل معزول عن inbox_* ───────────────────────────────────────────────
DO $$
DECLARE n int;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000e1');
  PERFORM public.inbox_add_note('5e550000-0000-4000-8000-000000000001', 'العميل ده عليه تذكرتين', '{}');

  PERFORM t.act('00000000-0000-4000-8000-0000000000c1');
  SELECT (SELECT count(*) FROM public.inbox_notes) + (SELECT count(*) FROM public.inbox_conversations)
       + (SELECT count(*) FROM public.inbox_events) + (SELECT count(*) FROM public.inbox_teams) INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 2a: العميل يرى % صف من inbox_*', n; END IF;
  IF NOT t.fails($q$select public.inbox_add_note('5e550000-0000-4000-8000-000000000001', 'x', '{}')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 2b: العميل كتب ملاحظة';
  END IF;
  IF NOT t.fails($q$select public.inbox_list_agents()$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 2c: العميل قرأ قائمة الموظفين';
  END IF;
  RAISE NOTICE 'PASS 2: العميل لا يرى ولا يكتب شيئًا من الصندوق، ولا ملاحظات جلسته';
END $$;

-- ⑤ المنشن ─────────────────────────────────────────────────────────────────
DO $$
DECLARE note public.inbox_notes; n int;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  note := public.inbox_add_note('5e550000-0000-4000-8000-000000000001', 'بصّوا على ده',
    array['00000000-0000-4000-8000-00000000005a', '00000000-0000-4000-8000-0000000000e1',
          '00000000-0000-4000-8000-0000000000c1']::uuid[]);
  IF note.mentions <> array['00000000-0000-4000-8000-0000000000e1']::uuid[] THEN
    RAISE EXCEPTION 'FAIL 5a: المنشن الفعلي %', note.mentions;
  END IF;
  SELECT count(*) INTO n FROM public.notifications
   WHERE user_id = '00000000-0000-4000-8000-0000000000e1' AND link = '/admin/inbox.html?session=5e550000-0000-4000-8000-000000000001';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 5b: إشعارات المنشن %', n; END IF;
  SELECT count(*) INTO n FROM public.notifications WHERE user_id = '00000000-0000-4000-8000-00000000005a';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 5c: موظف بلا وصول أُشعر'; END IF;
  SELECT count(*) INTO n FROM public.notifications
   WHERE user_id = '00000000-0000-4000-8000-0000000000a1' AND title = 'اتسندت لك محادثة';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 5d: إشعار الإسناد %', n; END IF;
  RAISE NOTICE 'PASS 5: المنشن لموظف يصل للمحادثة فقط، والإسناد والمنشن يُشعران';
END $$;

-- ④ الفرق والتحويل ────────────────────────────────────────────────────────
DO $$
DECLARE team public.inbox_teams; n int; ev public.inbox_events;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  IF NOT t.fails($q$select public.inbox_save_team(null, 'فريق')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 4a: أدمن عادي أنشأ فريقًا';
  END IF;

  PERFORM t.act('00000000-0000-4000-8000-0000000000e1');
  team := public.inbox_save_team(null, 'الدعم الفني', 'الوردية الصباحية');
  IF NOT t.fails(format($q$select public.inbox_save_team(null, ' الدعم الفني ')$q$), '23505') THEN
    RAISE EXCEPTION 'FAIL 4b: فريقان بنفس الاسم';
  END IF;
  PERFORM public.inbox_set_team_member(team.id, '00000000-0000-4000-8000-00000000005a', 'member');
  IF NOT t.fails(format($q$select public.inbox_set_team_member(%L, '00000000-0000-4000-8000-0000000000c1', 'member')$q$, team.id), '22023') THEN
    RAISE EXCEPTION 'FAIL 4c: عميل عضو في فريق';
  END IF;

  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  IF NOT t.fails(format($q$select public.inbox_transfer('5e550000-0000-4000-8000-000000000001', null, %L, ' ')$q$, team.id), '22023') THEN
    RAISE EXCEPTION 'FAIL 4d: تحويل بلا سبب';
  END IF;
  PERFORM public.inbox_transfer('5e550000-0000-4000-8000-000000000001', null, team.id, 'محتاجة حد تقني');

  SELECT count(*) INTO n FROM public.chat_sessions;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 4e: المحوِّل ما زال يرى المحادثة بعد تحويلها لفريق ليس فيه'; END IF;

  PERFORM t.act('00000000-0000-4000-8000-00000000005a');
  SELECT count(*) INTO n FROM public.chat_sessions;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 4f: عضو الفريق لا يرى المحادثة المحوّلة'; END IF;
  SELECT count(*) INTO n FROM public.inbox_notes WHERE body = 'تحويل: محتاجة حد تقني';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 4g: سبب التحويل ليس ملاحظة'; END IF;
  SELECT * INTO ev FROM public.inbox_events WHERE kind = 'transferred';
  IF ev.payload->>'to_team' <> team.id::text OR ev.payload->>'reason' <> 'محتاجة حد تقني'
     OR ev.payload->>'from_user' <> '00000000-0000-4000-8000-0000000000a1' THEN
    RAISE EXCEPTION 'FAIL 4h: حدث التحويل %', ev.payload;
  END IF;

  -- أرشفة الفريق تسحب وصول أعضائه
  PERFORM t.act('00000000-0000-4000-8000-0000000000e1');
  PERFORM public.inbox_archive_team(team.id);
  PERFORM t.act('00000000-0000-4000-8000-00000000005a');
  SELECT count(*) INTO n FROM public.chat_sessions;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 4i: عضو فريق مؤرشف ما زال يرى المحادثة'; END IF;

  -- نعيد فريقًا نشطًا للاختبارات التالية
  PERFORM t.act('00000000-0000-4000-8000-0000000000e1');
  team := public.inbox_save_team(null, 'الدعم الفني', null);
  PERFORM public.inbox_set_team_member(team.id, '00000000-0000-4000-8000-00000000005a', 'lead');
  PERFORM public.inbox_assign('5e550000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000005a', team.id);
  IF NOT t.fails(format($q$select public.inbox_assign('5e550000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a2', %L)$q$, team.id), '22023') THEN
    RAISE EXCEPTION 'FAIL 4j: إسناد لمسؤول ليس عضوًا في الفريق';
  END IF;
  RAISE NOTICE 'PASS 4: التحويل لفريق ينقل الوصول، وسببه ملاحظة وحدث، وأرشفة الفريق تسحب الوصول';
END $$;

-- ⑦ الوسوم والأرشفة ───────────────────────────────────────────────────────
DO $$
DECLARE n int; c public.inbox_conversations;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-00000000005a');
  PERFORM public.inbox_add_tag('5e550000-0000-4000-8000-000000000001', '7a900000-0000-4000-8000-000000000001');
  PERFORM public.inbox_add_tag('5e550000-0000-4000-8000-000000000001', '7a900000-0000-4000-8000-000000000001');
  SELECT count(*) INTO n FROM public.inbox_events WHERE kind = 'tagged';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 7a: وسم مكرر سجّل % حدث', n; END IF;
  IF NOT t.fails($q$select public.inbox_add_tag('5e550000-0000-4000-8000-000000000002', '7a900000-0000-4000-8000-000000000001')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 7b: وسم محادثة غير مسندة';
  END IF;

  c := public.inbox_set_archived('5e550000-0000-4000-8000-000000000001', true);
  IF c.archived_at IS NULL OR c.archived_by <> '00000000-0000-4000-8000-00000000005a' THEN
    RAISE EXCEPTION 'FAIL 7c: الأرشفة %', row_to_json(c);
  END IF;
  PERFORM public.inbox_send_reply('5e550000-0000-4000-8000-000000000001', 'رجعتلك');
  SELECT * INTO c FROM public.inbox_conversations WHERE session_id = '5e550000-0000-4000-8000-000000000001';
  IF c.archived_at IS NOT NULL THEN RAISE EXCEPTION 'FAIL 7d: الرد لم يُخرجها من الأرشيف'; END IF;
  SELECT count(*) INTO n FROM public.inbox_events WHERE kind = 'unarchived' AND payload->>'reason' = 'reply';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 7e: حدث الرجوع من الأرشيف'; END IF;
  PERFORM public.inbox_remove_tag('5e550000-0000-4000-8000-000000000001', '7a900000-0000-4000-8000-000000000001');
  SELECT count(*) INTO n FROM public.inbox_conversation_tags;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 7f: الوسم لم يُشل'; END IF;
  RAISE NOTICE 'PASS 7: الوسوم والأرشفة تعمل وتُسجَّل، والرد يُخرج من الأرشيف';
END $$;

-- ملاحظات: التعديل والسحب وتحويل الرسالة كملاحظة ──────────────────────────
DO $$
DECLARE e_note public.inbox_notes; s_note public.inbox_notes; fwd public.inbox_notes; n int;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000e1');
  e_note := public.inbox_add_note('5e550000-0000-4000-8000-000000000001', 'ملاحظة المرتفع', '{}');
  PERFORM t.act('00000000-0000-4000-8000-00000000005a');
  s_note := public.inbox_add_note('5e550000-0000-4000-8000-000000000001', 'ملاحظة الدعم', '{}');
  IF NOT t.fails(format($q$select public.inbox_edit_note(%L, 'تعديل')$q$, e_note.id), '42501') THEN
    RAISE EXCEPTION 'FAIL N1: عدّل ملاحظة غيره';
  END IF;
  IF NOT t.fails(format($q$select public.inbox_delete_note(%L)$q$, e_note.id), '42501') THEN
    RAISE EXCEPTION 'FAIL N2: سحب ملاحظة غيره';
  END IF;
  s_note := public.inbox_edit_note(s_note.id, 'ملاحظة الدعم بعد التعديل');
  IF s_note.edited_at IS NULL THEN RAISE EXCEPTION 'FAIL N3: لا أثر للتعديل'; END IF;
  -- عضو الفريق لا يصل لمحادثة C2، فلا يحوّل منها
  IF NOT t.fails($q$select public.inbox_forward_as_note('3e550000-0000-4000-8000-000000000003', '5e550000-0000-4000-8000-000000000001')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL N4: حوّل من محادثة لا يصلها';
  END IF;

  PERFORM t.act('00000000-0000-4000-8000-0000000000e1');
  PERFORM public.inbox_delete_note(s_note.id);
  SELECT * INTO s_note FROM public.inbox_notes WHERE id = s_note.id;
  IF s_note.deleted_at IS NULL OR s_note.body <> '' THEN RAISE EXCEPTION 'FAIL N5: السحب لم يمح النص'; END IF;
  fwd := public.inbox_forward_as_note('3e550000-0000-4000-8000-000000000003', '5e550000-0000-4000-8000-000000000001');
  IF fwd.source_message_id <> '3e550000-0000-4000-8000-000000000003' OR fwd.body NOT LIKE '%سؤال من عميل تاني%' THEN
    RAISE EXCEPTION 'FAIL N6: الملاحظة المحوّلة %', row_to_json(fwd);
  END IF;

  -- لم تُنشأ أي رسالة للعميل من التحويل
  PERFORM t.act('00000000-0000-4000-8000-0000000000c1');
  SELECT count(*) INTO n FROM public.chat_messages WHERE message_text LIKE '%سؤال من عميل تاني%';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL N7: رسالة عميل آخر وصلت للعميل'; END IF;
  RAISE NOTICE 'PASS N: التعديل والسحب للكاتب (والمرتفع يسحب)، والتحويل ملاحظة داخلية لا تصل لعميل';
END $$;

-- ⑥ الإقفال ────────────────────────────────────────────────────────────────
DO $$
DECLARE st text; n int;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-00000000005a');
  IF NOT t.fails($q$select public.inbox_close(array['5e550000-0000-4000-8000-000000000001','5e550000-0000-4000-8000-000000000002']::uuid[])$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 6a: أقفل محادثة لا يصلها';
  END IF;
  SELECT status INTO st FROM public.chat_sessions WHERE id = '5e550000-0000-4000-8000-000000000001';
  IF st <> 'active' THEN RAISE EXCEPTION 'FAIL 6b: الإقفال الجماعي ليس كل أو لا شيء'; END IF;
  n := public.inbox_close(array['5e550000-0000-4000-8000-000000000001']::uuid[]);
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 6c: عدد المقفول %', n; END IF;
  IF NOT t.fails($q$select public.inbox_send_reply('5e550000-0000-4000-8000-000000000001', 'x')$q$, '22023') THEN
    RAISE EXCEPTION 'FAIL 6d: رد على محادثة مقفولة';
  END IF;
  RAISE NOTICE 'PASS 6: الإقفال كل أو لا شيء، ولا رد على المقفولة';
END $$;

-- ⑧ لا كتابة مباشرة ────────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000e1');
  IF NOT t.fails($q$insert into public.inbox_notes (session_id, body) values ('5e550000-0000-4000-8000-000000000001', 'x')$q$, '42501')
     OR NOT t.fails($q$update public.inbox_conversations set assignee_id = null$q$, '42501')
     OR NOT t.fails($q$delete from public.inbox_events$q$, '42501')
     OR NOT t.fails($q$insert into public.inbox_teams (name) values ('x')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 8a: كتابة مباشرة على جدول inbox';
  END IF;
  IF NOT t.fails($q$select public._inbox_log('5e550000-0000-4000-8000-000000000001', 'closed')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 8b: دالة داخلية مكشوفة';
  END IF;
  RAISE NOTICE 'PASS 8: الكتابة عبر الـRPC فقط';
END $$;
RESET ROLE;
DO $$
BEGIN
  IF NOT t.fails($q$update public.inbox_events set kind = 'closed'$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 8c: السجل قابل للتعديل حتى من المالك';
  END IF;
  RAISE NOTICE 'PASS 8c: السجل إلحاق فقط';
END $$;
SET ROLE authenticated;

-- ⑨ المعاينة والحظر ────────────────────────────────────────────────────────
-- المحظور: حتى لو صفّه مسند
RESET ROLE;
INSERT INTO public.inbox_conversations (session_id, assignee_id)
VALUES ('5e550000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000b1');
SET ROLE authenticated;
DO $$
DECLARE n int;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000e1');
  PERFORM set_config('test.preview', 'on', false);
  IF NOT t.fails($q$select public.inbox_add_note('5e550000-0000-4000-8000-000000000002', 'x', '{}')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 9a: كتابة في المعاينة';
  END IF;
  PERFORM set_config('test.preview', 'off', false);

  PERFORM t.act('00000000-0000-4000-8000-0000000000b1');
  SELECT count(*) INTO n FROM public.chat_messages;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 9b: المحظور يقرأ رسائل'; END IF;
  IF NOT t.fails($q$select public.inbox_send_reply('5e550000-0000-4000-8000-000000000002', 'x')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 9c: المحظور يرد';
  END IF;
  RAISE NOTICE 'PASS 9: المعاينة لا تكتب، والمحظور مرفوض';
END $$;

-- ⑩ SIE والعميل كما كانا ──────────────────────────────────────────────────
RESET ROLE;
INSERT INTO public.chat_messages (session_id, sender_id, message_text, is_bot_reply)
VALUES ('5e550000-0000-4000-8000-000000000002', null, 'رد SIE', true);
SET ROLE authenticated;
DO $$
DECLARE n int;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000c2');
  INSERT INTO public.chat_messages (session_id, sender_id, message_text)
  VALUES ('5e550000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000c2', 'رسالة عميل بعد الترحيل');
  SELECT count(*) INTO n FROM public.chat_messages;
  IF n <> 3 THEN RAISE EXCEPTION 'FAIL 10a: العميل يرى % رسالة في جلسته (المتوقع 3)', n; END IF;
  UPDATE public.chat_sessions SET bot_state = '{"flow":"x"}' WHERE id = '5e550000-0000-4000-8000-000000000002';
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL 10b: العميل فقد تحديث جلسته'; END IF;
  RAISE NOTICE 'PASS 10: إدراج SIE والعميل وتحديث bot_state كما كانت';
END $$;
RESET ROLE;

-- ⑪ التراجع ────────────────────────────────────────────────────────────────
-- نفس نص التراجع الموثّق في آخر 055 حرفيًا.
drop policy if exists inbox_assigned_select on public.chat_messages;
drop policy if exists inbox_assigned_select on public.chat_sessions;
alter publication supabase_realtime drop table public.inbox_conversations,
  public.inbox_conversation_tags, public.inbox_notes, public.inbox_events;
drop function if exists public.inbox_set_team_member(uuid, uuid, text),
  public.inbox_archive_team(uuid), public.inbox_save_team(uuid, text, text),
  public._inbox_require_manager(), public.inbox_set_archived(uuid, boolean),
  public.inbox_forward_as_note(uuid, uuid), public.inbox_delete_note(uuid),
  public.inbox_edit_note(uuid, text), public.inbox_add_note(uuid, text, uuid[]),
  public.inbox_remove_tag(uuid, uuid), public.inbox_add_tag(uuid, uuid),
  public.inbox_transfer(uuid, uuid, uuid, text), public.inbox_assign(uuid, uuid, uuid),
  public._inbox_set_assignment(uuid, uuid, uuid, text, text), public.inbox_close(uuid[]),
  public.inbox_send_reply(uuid, text), public.inbox_customer_profiles(uuid[]),
  public._inbox_touch(uuid),
  public.inbox_list_agents();
drop table if exists public.inbox_events, public.inbox_notes,
  public.inbox_conversation_tags, public.inbox_conversations,
  public.inbox_team_members, public.inbox_teams;
drop function if exists public._inbox_customer_name(uuid),
  public._inbox_notify(uuid, text, text, uuid), public._inbox_log(uuid, text, jsonb),
  public._inbox_require(uuid), public.inbox_can_access(uuid), public.inbox_is_agent(),
  public._inbox_user_can_access(uuid, uuid), public._inbox_is_assigned(uuid, uuid),
  public._inbox_is_eligible_agent(uuid), public.guard_inbox_events_immutable();
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relname LIKE 'inbox%';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 11a: بقي % كائن inbox بعد التراجع', n; END IF;
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname LIKE '%inbox%';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 11b: بقيت % دالة inbox بعد التراجع', n; END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE tablename IN ('chat_sessions', 'chat_messages');
  IF n <> 7 THEN RAISE EXCEPTION 'FAIL 11c: سياسات الشات بعد التراجع % (المتوقع 7 كما قبل الترحيل)', n; END IF;
  RAISE NOTICE 'PASS 11: التراجع الموثّق ينظّف كل شيء ويُبقي سياسات الشات القائمة';
END $$;

\echo 'ALL inbox-helpdesk-core tests passed'
