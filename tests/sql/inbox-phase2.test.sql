-- ============================================================================
-- اختبار تنفيذي لـ 056: مرفقات الدعم، التفاعلات الداخلية، تعديل/حذف ردود الدعم.
--
-- يثبّت:
--   ① رد الدعم بمرفق يمرّ من محفّز 054 (مجلد المرسل + ملف موجود)، ومرفق من
--      مجلد عميل أو ملف غير موجود يُرفض
--   ② العميل يقرأ ملف رد الدعم في جلسته هو فقط، ويفقده بعد الحذف
--   ③ النداء بمعاملين (الواجهة الحالية) يصل للتوقيع الجديد
--   ④ التعديل للكاتب فقط وعلى ردود الدعم فقط، وله أثر ونسخة
--   ⑤ الحذف (الكاتب أو المرتفع) يمحو النص والمرفق من الصف، والنسخة للطاقم فقط
--   ⑥ التفاعلات داخلية: تبديل، قائمة مغلقة، وصول، وتُمحى مع الرسالة
--   ⑦ إدراج SIE والعميل كما كانا بعد العمودين الجديدين
--   ⑧ التراجع الموثّق
--
-- التمهيد منسوخ من inbox-helpdesk-core.test.sql (نفس حالة الإنتاج بعد 054/055).
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
CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
-- storage.foldername كما في Supabase: أجزاء المسار ما عدا اسم الملف.
CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]; $$;
GRANT USAGE ON SCHEMA storage TO authenticated;
GRANT SELECT ON storage.objects TO authenticated;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
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
DROP PUBLICATION IF EXISTS supabase_realtime;
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

-- سياسة القراءة القائمة في الإنتاج على المستودع (منسوخة حرفيًا)
CREATE POLICY chat_attachments_read_own_or_staff ON storage.objects FOR SELECT TO authenticated
  USING ((bucket_id = 'chat-attachments'::text) AND (public.is_platform_staff() OR ((storage.foldername(name))[1] = (auth.uid())::text)));

\i migrations/055_inbox_helpdesk_core.sql
\i migrations/056_inbox_attachments_reactions_edits.sql

-- ── مساعدات الاختبار ─────────────────────────────────────────────────────
DROP SCHEMA IF EXISTS t CASCADE;
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

-- ── تجهيز: A1 مسند له S1، وملفات في المستودع ─────────────────────────────
-- ملف الدعم في مجلد A1، وملف في مجلد العميل C1، وملف في مجلد C2.
INSERT INTO storage.objects (bucket_id, name) VALUES
  ('chat-attachments', '00000000-0000-4000-8000-0000000000a1/5e550000-0000-4000-8000-000000000001-1.pdf'),
  ('chat-attachments', '00000000-0000-4000-8000-0000000000a1/5e550000-0000-4000-8000-000000000001-2.png'),
  ('chat-attachments', '00000000-0000-4000-8000-0000000000c1/own.png'),
  ('chat-attachments', '00000000-0000-4000-8000-0000000000c2/other.png');

SET ROLE authenticated;
SELECT t.act('00000000-0000-4000-8000-0000000000e1');
SELECT public.inbox_assign('5e550000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1');

-- ① + ③ مرفق الدعم ─────────────────────────────────────────────────────────
DO $$
DECLARE m public.chat_messages;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  m := public.inbox_send_reply('5e550000-0000-4000-8000-000000000001', 'الفاتورة',
         '{"kind":"file","path":"00000000-0000-4000-8000-0000000000a1/5e550000-0000-4000-8000-000000000001-1.pdf","name":"فاتورة.pdf","size":2048}');
  IF m.attachment->>'kind' <> 'file' OR m.image_url IS NOT NULL OR NOT m.is_admin_reply THEN
    RAISE EXCEPTION 'FAIL 1a: رد بمرفق ملف %', row_to_json(m);
  END IF;
  m := public.inbox_send_reply('5e550000-0000-4000-8000-000000000001', 'صورة مرفقة',
         '{"kind":"image","path":"00000000-0000-4000-8000-0000000000a1/5e550000-0000-4000-8000-000000000001-2.png","name":"s.png"}');
  IF m.image_url <> '00000000-0000-4000-8000-0000000000a1/5e550000-0000-4000-8000-000000000001-2.png' THEN
    RAISE EXCEPTION 'FAIL 1b: الصورة لم تُكرَّر في image_url';
  END IF;
  -- مسار في مجلد العميل (مش مجلد المرسل) — محفّز 054 يرفض
  IF NOT t.fails($q$select public.inbox_send_reply('5e550000-0000-4000-8000-000000000001', 'x',
        '{"kind":"image","path":"00000000-0000-4000-8000-0000000000c1/own.png"}')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 1c: مرفق من مجلد العميل مرّ';
  END IF;
  IF NOT t.fails($q$select public.inbox_send_reply('5e550000-0000-4000-8000-000000000001', 'x',
        '{"kind":"file","path":"00000000-0000-4000-8000-0000000000a1/ghost.pdf"}')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 1d: مرفق لملف غير موجود مرّ';
  END IF;
  IF NOT t.fails($q$select public.inbox_send_reply('5e550000-0000-4000-8000-000000000001', 'x', '{"kind":"file"}')$q$, '22023') THEN
    RAISE EXCEPTION 'FAIL 1e: مرفق ناقص مرّ';
  END IF;
  -- ③ النداء بمعاملين مسمّيين كما ترسله الواجهة الحالية
  m := public.inbox_send_reply(p_session => '5e550000-0000-4000-8000-000000000001', p_body => 'نص بس');
  IF m.attachment IS NOT NULL THEN RAISE EXCEPTION 'FAIL 3a'; END IF;
  RAISE NOTICE 'PASS 1+3: مرفق الدعم يمرّ من حارس 054، والمسارات الغريبة تُرفض، والنداء القديم يعمل';
END $$;

-- ② قراءة العميل للملف ─────────────────────────────────────────────────────
DO $$
DECLARE n int;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000c1');
  SELECT count(*) INTO n FROM storage.objects WHERE name LIKE '00000000-0000-4000-8000-0000000000a1/%';
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL 2a: العميل يرى % من ملفات رد الدعم (المتوقع 2)', n; END IF;
  SELECT count(*) INTO n FROM storage.objects WHERE name LIKE '00000000-0000-4000-8000-0000000000c2/%';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 2b: العميل يرى ملف عميل آخر'; END IF;

  PERFORM t.act('00000000-0000-4000-8000-0000000000c2');
  SELECT count(*) INTO n FROM storage.objects WHERE name LIKE '00000000-0000-4000-8000-0000000000a1/%';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 2c: عميل آخر يرى ملف رد في جلسة غيره'; END IF;
  RAISE NOTICE 'PASS 2: العميل يقرأ مرفقات ردود الدعم في جلسته فقط';
END $$;

-- ④ التعديل ──────────────────────────────────────────────────────────────────
DO $$
DECLARE m public.chat_messages; n int; mid uuid;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  SELECT id INTO mid FROM public.chat_messages WHERE message_text = 'نص بس';
  m := public.inbox_edit_message(mid, 'نص بعد التعديل');
  IF m.edited_at IS NULL OR m.message_text <> 'نص بعد التعديل' THEN RAISE EXCEPTION 'FAIL 4a: %', row_to_json(m); END IF;
  SELECT count(*) INTO n FROM public.chat_message_revisions WHERE message_id = mid AND action = 'edit' AND previous_text = 'نص بس';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 4b: لا نسخة سابقة'; END IF;
  -- رسالة العميل ورسالة البوت لا تُعدَّلان
  IF NOT t.fails($q$select public.inbox_edit_message('3e550000-0000-4000-8000-000000000002', 'تزوير')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 4c: عدّل رسالة العميل';
  END IF;
  IF NOT t.fails($q$select public.inbox_edit_message('3e550000-0000-4000-8000-000000000001', 'تزوير')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 4d: عدّل رسالة البوت';
  END IF;

  -- المرتفع يرى الرسالة لكن لا يعدّل رد غيره
  PERFORM t.act('00000000-0000-4000-8000-0000000000e1');
  IF NOT t.fails(format($q$select public.inbox_edit_message(%L, 'تزوير')$q$, mid), '42501') THEN
    RAISE EXCEPTION 'FAIL 4e: المرتفع عدّل رد غيره';
  END IF;
  -- أدمن غير مسند لا يصل أصلًا
  PERFORM t.act('00000000-0000-4000-8000-0000000000a2');
  IF NOT t.fails(format($q$select public.inbox_edit_message(%L, 'x')$q$, mid), '42501') THEN
    RAISE EXCEPTION 'FAIL 4f: أدمن غير مسند وصل للرسالة';
  END IF;
  RAISE NOTICE 'PASS 4: التعديل للكاتب وعلى ردود الدعم فقط، وله أثر ونسخة';
END $$;

-- ⑥ التفاعلات ───────────────────────────────────────────────────────────────
DO $$
DECLARE on_ boolean; n int; fid uuid;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  on_ := public.inbox_toggle_reaction('3e550000-0000-4000-8000-000000000002', null, '👀');
  IF NOT on_ THEN RAISE EXCEPTION 'FAIL 6a'; END IF;
  on_ := public.inbox_toggle_reaction('3e550000-0000-4000-8000-000000000002', null, '👀');
  IF on_ THEN RAISE EXCEPTION 'FAIL 6b: التبديل لم يشل التفاعل'; END IF;
  IF NOT t.fails($q$select public.inbox_toggle_reaction('3e550000-0000-4000-8000-000000000002', null, '💩')$q$, '22023') THEN
    RAISE EXCEPTION 'FAIL 6c: رمز خارج القائمة';
  END IF;
  IF NOT t.fails($q$select public.inbox_toggle_reaction('3e550000-0000-4000-8000-000000000003', null, '👍')$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL 6d: تفاعل على محادثة غير مسندة';
  END IF;
  SELECT id INTO fid FROM public.chat_messages WHERE message_text = 'الفاتورة';
  PERFORM public.inbox_toggle_reaction(fid, null, '✅');
  PERFORM public.inbox_toggle_reaction('3e550000-0000-4000-8000-000000000002', null, '👍');

  PERFORM t.act('00000000-0000-4000-8000-0000000000c1');
  SELECT count(*) INTO n FROM public.inbox_reactions;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 6e: العميل يرى تفاعلات الطاقم'; END IF;
  RAISE NOTICE 'PASS 6: التفاعلات داخلية، بقائمة مغلقة، ولمن يصل للمحادثة فقط';
END $$;

-- ⑤ الحذف ────────────────────────────────────────────────────────────────────
DO $$
DECLARE m public.chat_messages; n int; fid uuid; rev public.chat_message_revisions;
BEGIN
  SELECT id INTO fid FROM public.chat_messages WHERE message_text = 'الفاتورة';

  -- أدمن مسند آخر؟ لا يوجد؛ A2 لا يصل. المرتفع يحذف رد A1.
  PERFORM t.act('00000000-0000-4000-8000-0000000000e1');
  m := public.inbox_delete_message(fid);
  IF m.deleted_at IS NULL OR m.message_text <> '' OR m.attachment IS NOT NULL OR m.image_url IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 5a: الحذف لم يمح الصف %', row_to_json(m);
  END IF;
  SELECT * INTO rev FROM public.chat_message_revisions WHERE message_id = fid AND action = 'delete';
  IF rev.previous_text <> 'الفاتورة' OR rev.previous_attachment->>'kind' <> 'file' THEN
    RAISE EXCEPTION 'FAIL 5b: النسخة %', row_to_json(rev);
  END IF;
  SELECT count(*) INTO n FROM public.inbox_reactions WHERE message_id = fid;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 5c: تفاعلات بقيت على رسالة محذوفة'; END IF;
  IF NOT t.fails(format($q$select public.inbox_edit_message(%L, 'رجّعها')$q$, fid), '42501') THEN
    RAISE EXCEPTION 'FAIL 5d: تعديل رسالة محذوفة';
  END IF;
  IF NOT t.fails(format($q$select public.inbox_toggle_reaction(%L, null, '👍')$q$, fid), '22023') THEN
    RAISE EXCEPTION 'FAIL 5e: تفاعل على رسالة محذوفة';
  END IF;

  PERFORM t.act('00000000-0000-4000-8000-0000000000c1');
  SELECT count(*) INTO n FROM public.chat_messages WHERE id = fid AND message_text = '' AND deleted_at IS NOT NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 5f: العميل لا يرى أثر الحذف'; END IF;
  SELECT count(*) INTO n FROM public.chat_message_revisions;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 5g: العميل يرى النسخ السابقة'; END IF;
  SELECT count(*) INTO n FROM storage.objects WHERE name LIKE '%-1.pdf';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 5h: العميل ما زال يقرأ ملف رد محذوف'; END IF;
  SELECT count(*) INTO n FROM storage.objects WHERE name LIKE '%-2.png';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 5i: فقد ملف رد غير محذوف'; END IF;
  RAISE NOTICE 'PASS 5: الحذف يمحو النص والمرفق، والنسخة والتفاعلات للطاقم، والعميل يفقد الملف';
END $$;

-- لا كتابة مباشرة ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000e1');
  IF NOT t.fails($q$insert into public.inbox_reactions (session_id, message_id, user_id, emoji)
      values ('5e550000-0000-4000-8000-000000000001', '3e550000-0000-4000-8000-000000000002', auth.uid(), '👍')$q$, '42501')
     OR NOT t.fails($q$delete from public.chat_message_revisions$q$, '42501') THEN
    RAISE EXCEPTION 'FAIL W: كتابة مباشرة';
  END IF;
  -- chat_messages بلا سياسة UPDATE: RLS تصفّي التعديل المباشر لصفر صفوف
  -- (مش خطأ)، فبنتأكد إن ولا صف اتغيّر — حتى من المرتفع.
  UPDATE public.chat_messages SET message_text = 'تزوير' WHERE is_admin_reply;
  IF EXISTS (SELECT 1 FROM public.chat_messages WHERE message_text = 'تزوير') THEN
    RAISE EXCEPTION 'FAIL W2: تعديل مباشر على رد دعم مرّ';
  END IF;
  RAISE NOTICE 'PASS W: الكتابة عبر الـRPC فقط';
END $$;
RESET ROLE;

-- ⑦ SIE والعميل ────────────────────────────────────────────────────────────
INSERT INTO public.chat_messages (session_id, sender_id, message_text, is_bot_reply)
VALUES ('5e550000-0000-4000-8000-000000000002', null, 'رد SIE بعد 056', true);
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000c2');
  INSERT INTO public.chat_messages (session_id, sender_id, message_text)
  VALUES ('5e550000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000c2', 'عميل بعد 056');
  RAISE NOTICE 'PASS 7: إدراج SIE والعميل كما كانا';
END $$;
RESET ROLE;

-- ⑧ التراجع ─────────────────────────────────────────────────────────────────
-- نفس نص التراجع الموثّق في آخر 056 حرفيًا.
drop policy if exists chat_attachments_read_support_reply on storage.objects;
alter publication supabase_realtime drop table public.inbox_reactions;
drop function if exists public.inbox_toggle_reaction(uuid, uuid, text),
  public.inbox_delete_message(uuid), public.inbox_edit_message(uuid, text),
  public._inbox_own_reply(uuid, boolean), public.inbox_send_reply(uuid, text, jsonb);
drop table if exists public.inbox_reactions, public.chat_message_revisions;
alter table public.chat_messages drop column if exists deleted_at, drop column if exists edited_at;
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_name = 'chat_messages' AND column_name IN ('edited_at', 'deleted_at');
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 8a'; END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE tablename = 'objects' AND policyname = 'chat_attachments_read_support_reply';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 8b'; END IF;
  IF to_regclass('public.inbox_notes') IS NULL THEN RAISE EXCEPTION 'FAIL 8c: التراجع لمس 055'; END IF;
  RAISE NOTICE 'PASS 8: التراجع الموثّق ينظّف 056 ولا يلمس 055';
END $$;

\echo 'ALL inbox-phase2 tests passed'
