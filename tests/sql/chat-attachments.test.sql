-- ============================================================================
-- اختبار تنفيذي لـ 054: مرفقات الشات مفروضة في القاعدة.
--
--   ① العميل يرفق ملفًا رفعه في مجلده: يُقبل (صورة، ملف، صوت)
--   ② مسار في مجلد عميل آخر: مرفوض — حتى لو الملف موجود
--   ③ مسار لملف غير موجود، رابط، «..»، مسار مطلق: مرفوض
--   ④ رسالة بوت (بلا مرسل) لا تحمل مرفقًا
--   ⑤ شكل العمود مقيّد: نوع غير معروف أو بلا مسار مرفوض
--   ⑥ image_url / audio_url يطابقان مسار المرفق
--   ⑦ حدود المستودع على الخادم: 10 ميجا وقائمة أنواع مغلقة
--   ⑧ الافتراضي لوضع الرد 'sie'، والصفوف القديمة لم تُلمس
--   ⑨ تطبيق الملف مرتين لا يغيّر شيئًا
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
END $$;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid; $$;
GRANT USAGE ON SCHEMA auth, storage, public TO authenticated, anon;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;

CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text DEFAULT 'user', chatbot_mode text DEFAULT 'traditional');
CREATE TABLE public.chat_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status text DEFAULT 'active');
CREATE TABLE public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid, sender_id uuid,
  message_text text, image_url text, audio_url text,
  is_admin_reply boolean DEFAULT false, is_bot_reply boolean DEFAULT false, created_at timestamptz DEFAULT now());
CREATE TABLE storage.buckets (id text PRIMARY KEY, public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid);
CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE AS $sf$
DECLARE _parts text[];
BEGIN
  SELECT string_to_array(name, '/') INTO _parts;
  RETURN _parts[1 : array_length(_parts,1) - 1];
END $sf$;
GRANT EXECUTE ON FUNCTION storage.foldername(text) TO authenticated, anon;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE POLICY objects_read_own ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'chat-attachments' AND (storage.foldername(name))[1] = (auth.uid())::text);
GRANT SELECT, DELETE ON storage.objects TO authenticated;

-- سياسة الإدراج كما في الإنتاج (مبسّطة للعميل): جلسته، ومرسل هو نفسه أو لا أحد
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_messages_insert_own ON public.chat_messages FOR INSERT
  WITH CHECK (session_id IN (SELECT s.id FROM chat_sessions s WHERE s.user_id = auth.uid())
              AND (sender_id = auth.uid() OR sender_id IS NULL));
CREATE POLICY chat_messages_select_own ON public.chat_messages FOR SELECT
  USING (session_id IN (SELECT s.id FROM chat_sessions s WHERE s.user_id = auth.uid()));
GRANT SELECT, INSERT, UPDATE ON public.chat_messages TO authenticated;
GRANT SELECT ON public.chat_sessions TO authenticated;

INSERT INTO storage.buckets (id) VALUES ('chat-attachments'), ('avatars');
INSERT INTO public.profiles (id, chatbot_mode) VALUES
  ('a0000000-0000-4000-8000-00000000000a', 'traditional'),
  ('b0000000-0000-4000-8000-00000000000b', 'sie');
INSERT INTO public.chat_sessions (id, user_id) VALUES
  ('5a000000-0000-4000-8000-00000000005a', 'a0000000-0000-4000-8000-00000000000a');
INSERT INTO storage.objects (bucket_id, name) VALUES
  ('chat-attachments', 'a0000000-0000-4000-8000-00000000000a/s-1-shot.png'),
  ('chat-attachments', 'a0000000-0000-4000-8000-00000000000a/s-1-report.pdf'),
  ('chat-attachments', 'a0000000-0000-4000-8000-00000000000a/s-1-voice.webm'),
  ('chat-attachments', 'b0000000-0000-4000-8000-00000000000b/secret.pdf'),
  ('avatars', 'a0000000-0000-4000-8000-00000000000a/me.png');

\ir ../../migrations/054_chat_composer_attachments.sql
\ir ../../migrations/054_chat_composer_attachments.sql

CREATE OR REPLACE FUNCTION pg_temp.as_a() RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-00000000000a', false); $$;

-- مساعد: إدراج يجب أن يُرفض
CREATE OR REPLACE FUNCTION pg_temp.must_fail(p_sql text, p_what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'PASS %', p_what;
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL % (accepted)', p_what;
END $$;

SET ROLE authenticated;
SELECT pg_temp.as_a();

-- ① ---------------------------------------------------------------------------
INSERT INTO public.chat_messages (session_id, sender_id, message_text, image_url, attachment) VALUES
  ('5a000000-0000-4000-8000-00000000005a', 'a0000000-0000-4000-8000-00000000000a', 'صورة',
   'a0000000-0000-4000-8000-00000000000a/s-1-shot.png',
   '{"kind":"image","path":"a0000000-0000-4000-8000-00000000000a/s-1-shot.png","name":"shot.png","mime":"image/png","size":2048}');
INSERT INTO public.chat_messages (session_id, sender_id, message_text, attachment) VALUES
  ('5a000000-0000-4000-8000-00000000005a', 'a0000000-0000-4000-8000-00000000000a', 'ملف',
   '{"kind":"file","path":"a0000000-0000-4000-8000-00000000000a/s-1-report.pdf","name":"report.pdf","mime":"application/pdf","size":90000}');
INSERT INTO public.chat_messages (session_id, sender_id, message_text, audio_url, attachment) VALUES
  ('5a000000-0000-4000-8000-00000000005a', 'a0000000-0000-4000-8000-00000000000a', 'رسالة صوتية',
   'a0000000-0000-4000-8000-00000000000a/s-1-voice.webm',
   '{"kind":"audio","path":"a0000000-0000-4000-8000-00000000000a/s-1-voice.webm","mime":"audio/webm","size":30000,"duration_ms":4200}');
DO $$ BEGIN
  IF (SELECT count(*) FROM public.chat_messages) <> 3 THEN RAISE EXCEPTION 'FAIL own image/file/audio were not all accepted'; END IF;
  RAISE NOTICE 'PASS own image, file and audio attachments are accepted';
END $$;
-- رسالة نصية عادية بلا مرفق لم تتأثر
INSERT INTO public.chat_messages (session_id, sender_id, message_text) VALUES
  ('5a000000-0000-4000-8000-00000000005a', 'a0000000-0000-4000-8000-00000000000a', 'نص فقط');
DO $$ BEGIN RAISE NOTICE 'PASS a plain text message is unaffected'; END $$;

-- ② ---------------------------------------------------------------------------
SELECT pg_temp.must_fail($q$INSERT INTO public.chat_messages (session_id, sender_id, attachment) VALUES
  ('5a000000-0000-4000-8000-00000000005a', 'a0000000-0000-4000-8000-00000000000a',
   '{"kind":"file","path":"b0000000-0000-4000-8000-00000000000b/secret.pdf"}')$q$,
  'another customer''s existing file is refused');
SELECT pg_temp.must_fail($q$INSERT INTO public.chat_messages (session_id, sender_id, image_url) VALUES
  ('5a000000-0000-4000-8000-00000000005a', 'a0000000-0000-4000-8000-00000000000a',
   'b0000000-0000-4000-8000-00000000000b/secret.pdf')$q$,
  'another customer''s file through image_url is refused');

-- ③ ---------------------------------------------------------------------------
SELECT pg_temp.must_fail($q$INSERT INTO public.chat_messages (session_id, sender_id, attachment) VALUES
  ('5a000000-0000-4000-8000-00000000005a', 'a0000000-0000-4000-8000-00000000000a',
   '{"kind":"file","path":"a0000000-0000-4000-8000-00000000000a/never-uploaded.pdf"}')$q$,
  'a file that was never uploaded is refused');
SELECT pg_temp.must_fail($q$INSERT INTO public.chat_messages (session_id, sender_id, image_url) VALUES
  ('5a000000-0000-4000-8000-00000000005a', 'a0000000-0000-4000-8000-00000000000a', 'https://evil.example/x.png')$q$,
  'an external URL is refused');
SELECT pg_temp.must_fail($q$INSERT INTO public.chat_messages (session_id, sender_id, audio_url) VALUES
  ('5a000000-0000-4000-8000-00000000005a', 'a0000000-0000-4000-8000-00000000000a',
   'a0000000-0000-4000-8000-00000000000a/../b0000000-0000-4000-8000-00000000000b/secret.pdf')$q$,
  'a path with .. is refused');
SELECT pg_temp.must_fail($q$INSERT INTO public.chat_messages (session_id, sender_id, image_url) VALUES
  ('5a000000-0000-4000-8000-00000000005a', 'a0000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-00000000000a/me.png')$q$,
  'a file in ANOTHER bucket (avatars) is refused');

-- ④ ---------------------------------------------------------------------------
SELECT pg_temp.must_fail($q$INSERT INTO public.chat_messages (session_id, sender_id, is_bot_reply, attachment) VALUES
  ('5a000000-0000-4000-8000-00000000005a', NULL, true,
   '{"kind":"image","path":"a0000000-0000-4000-8000-00000000000a/s-1-shot.png"}')$q$,
  'a bot message cannot carry an attachment');

-- ⑤ ---------------------------------------------------------------------------
SELECT pg_temp.must_fail($q$INSERT INTO public.chat_messages (session_id, sender_id, attachment) VALUES
  ('5a000000-0000-4000-8000-00000000005a', 'a0000000-0000-4000-8000-00000000000a',
   '{"kind":"script","path":"a0000000-0000-4000-8000-00000000000a/s-1-report.pdf"}')$q$,
  'an unknown attachment kind is refused');
SELECT pg_temp.must_fail($q$INSERT INTO public.chat_messages (session_id, sender_id, attachment) VALUES
  ('5a000000-0000-4000-8000-00000000005a', 'a0000000-0000-4000-8000-00000000000a', '{"kind":"file"}')$q$,
  'an attachment without a path is refused');

-- ⑥ ---------------------------------------------------------------------------
SELECT pg_temp.must_fail($q$INSERT INTO public.chat_messages (session_id, sender_id, image_url, attachment) VALUES
  ('5a000000-0000-4000-8000-00000000005a', 'a0000000-0000-4000-8000-00000000000a',
   'a0000000-0000-4000-8000-00000000000a/s-1-shot.png',
   '{"kind":"image","path":"a0000000-0000-4000-8000-00000000000a/s-1-report.pdf"}')$q$,
  'image_url and the attachment path must agree');
RESET ROLE;

-- تعديل لاحق يُحوّل المسار لملف غيره: مرفوض — حتى لكاتب يتخطى RLS (مالك
-- الجدول / service role)، لأن المُحفِّز لا RLS هو الفرض هنا. (العميل أصلًا
-- بلا سياسة UPDATE على chat_messages.)
SELECT pg_temp.must_fail($q$UPDATE public.chat_messages SET image_url = 'b0000000-0000-4000-8000-00000000000b/secret.pdf'
   WHERE message_text = 'نص فقط'$q$,
  'an UPDATE cannot point a message at someone else''s file (even bypassing RLS)');

-- ⑦ ---------------------------------------------------------------------------
DO $$ BEGIN
  IF (SELECT file_size_limit FROM storage.buckets WHERE id = 'chat-attachments') <> 10485760 THEN
    RAISE EXCEPTION 'FAIL bucket size limit not 10 MB';
  END IF;
  IF NOT (SELECT 'audio/webm' = ANY (allowed_mime_types) AND 'application/pdf' = ANY (allowed_mime_types)
             AND NOT ('text/html' = ANY (allowed_mime_types)) AND NOT ('image/svg+xml' = ANY (allowed_mime_types))
            FROM storage.buckets WHERE id = 'chat-attachments') THEN
    RAISE EXCEPTION 'FAIL bucket MIME list wrong (must allow audio/pdf, refuse html/svg)';
  END IF;
  IF (SELECT file_size_limit FROM storage.buckets WHERE id = 'avatars') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL another bucket was changed';
  END IF;
  RAISE NOTICE 'PASS the bucket enforces 10 MB and a closed type list (html/svg refused); other buckets untouched';
END $$;

-- ⑧ ---------------------------------------------------------------------------
DO $$ BEGIN
  INSERT INTO public.profiles (id) VALUES ('c0000000-0000-4000-8000-00000000000c');
  IF (SELECT chatbot_mode FROM public.profiles WHERE id = 'c0000000-0000-4000-8000-00000000000c') <> 'sie' THEN
    RAISE EXCEPTION 'FAIL new profiles do not default to sie';
  END IF;
  IF (SELECT chatbot_mode FROM public.profiles WHERE id = 'a0000000-0000-4000-8000-00000000000a') <> 'traditional' THEN
    RAISE EXCEPTION 'FAIL an existing legacy value was rewritten';
  END IF;
  RAISE NOTICE 'PASS new profiles default to sie; existing legacy values are left untouched';
END $$;

-- ⑩ «الوضع التقليدي» لا يُختار ولا بنداء مباشر --------------------------------
SELECT pg_temp.must_fail($q$UPDATE public.profiles SET chatbot_mode = 'traditional' WHERE id = 'b0000000-0000-4000-8000-00000000000b'$q$,
  'setting chatbot_mode to traditional is refused');
SELECT pg_temp.must_fail($q$UPDATE public.profiles SET chatbot_mode = 'ai_model' WHERE id = 'b0000000-0000-4000-8000-00000000000b'$q$,
  'setting chatbot_mode to ai_model is refused');
SELECT pg_temp.must_fail($q$INSERT INTO public.profiles (id, chatbot_mode) VALUES ('d0000000-0000-4000-8000-00000000000d', 'traditional')$q$,
  'a new profile cannot start on traditional');
DO $$ BEGIN
  UPDATE public.profiles SET role = 'user' WHERE id = 'a0000000-0000-4000-8000-00000000000a';   -- legacy row, other column
  UPDATE public.profiles SET chatbot_mode = 'sie' WHERE id = 'a0000000-0000-4000-8000-00000000000a';
  RAISE NOTICE 'PASS a legacy row can still be edited, and moved to sie';
END $$;

-- ⑪ حذف ملف مرفوع: ما دام غير مُرسل فقط ------------------------------------------
INSERT INTO storage.objects (bucket_id, name) VALUES
  ('chat-attachments', 'a0000000-0000-4000-8000-00000000000a/s-1-orphan.png');
SET ROLE authenticated;
SELECT pg_temp.as_a();
DELETE FROM storage.objects WHERE name = 'a0000000-0000-4000-8000-00000000000a/s-1-orphan.png';
DELETE FROM storage.objects WHERE name = 'a0000000-0000-4000-8000-00000000000a/s-1-shot.png';
DELETE FROM storage.objects WHERE name = 'b0000000-0000-4000-8000-00000000000b/secret.pdf';
RESET ROLE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM storage.objects WHERE name = 'a0000000-0000-4000-8000-00000000000a/s-1-orphan.png') THEN
    RAISE EXCEPTION 'FAIL the customer could not clean up an unsent upload';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE name = 'a0000000-0000-4000-8000-00000000000a/s-1-shot.png') THEN
    RAISE EXCEPTION 'FAIL a file already sent in a message was deleted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE name = 'b0000000-0000-4000-8000-00000000000b/secret.pdf') THEN
    RAISE EXCEPTION 'FAIL a customer deleted another customer''s file';
  END IF;
  RAISE NOTICE 'PASS an unsent upload can be cleaned up; a sent file or someone else''s cannot';
END $$;

-- ⑨ ---------------------------------------------------------------------------
DO $$ BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_guard_chat_message_attachment') <> 1 THEN
    RAISE EXCEPTION 'FAIL the guard trigger is not exactly one after applying twice';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conname = 'chat_messages_attachment_shape') <> 1 THEN
    RAISE EXCEPTION 'FAIL the shape constraint is not exactly one after applying twice';
  END IF;
  RAISE NOTICE 'PASS applying 054 twice changes nothing';
END $$;

DO $$ BEGIN RAISE NOTICE 'ALL CHAT ATTACHMENT CHECKS PASSED'; END $$;
