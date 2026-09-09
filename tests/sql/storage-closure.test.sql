-- اختبار تنفيذي لـ 028 — حدّ الملف = حدّ التذكرة، واختبارات عبور المستأجرين.
--
-- كل تأكيد هنا محاولة فعلية بدور authenticated بهوية محدَّدة، ونتيجتها
-- ALLOWED/DENIED — لا «السياسة موجودة».
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
END $$;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text UNIQUE);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid; $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.role', true), ''); $$;
GRANT USAGE ON SCHEMA auth, storage, public TO authenticated, anon;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO authenticated, anon;
GRANT SELECT ON auth.users TO authenticated, anon;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, email text UNIQUE, role text NOT NULL DEFAULT 'user', super_user_id uuid);
CREATE TABLE public.tickets (id uuid PRIMARY KEY, user_id uuid, title text);
CREATE TABLE public.ticket_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ticket_id uuid, file_url text, file_name text, uploaded_by uuid);
CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid);
CREATE TABLE storage.buckets (id text PRIMARY KEY, public boolean DEFAULT true);
CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE AS $sf$
DECLARE _parts text[];
BEGIN
  -- منسوخة حرفيًا من الإنتاج (pg_get_functiondef). الفرق الذي كان في النسخة
  -- المبسّطة: اسم بلا شرطة مائلة يعيد مصفوفة فارغة هنا، فـ[1] تساوي NULL —
  -- بينما النسخة المبسّطة كانت تعيد الاسم كله. سياسة تعتمد على ذلك كانت
  -- ستمرّ في الاختبار وتفشل على الإنتاج.
  SELECT string_to_array(name, '/') INTO _parts;
  RETURN _parts[1 : array_length(_parts,1) - 1];
END $sf$;
GRANT EXECUTE ON FUNCTION storage.foldername(text) TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects, storage.buckets TO authenticated, anon;

CREATE OR REPLACE FUNCTION public.is_main_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE((SELECT email FROM auth.users WHERE id=auth.uid())
    IN ('support@mad3oom.online','info@mad3oom.online'), false); $$;
CREATE OR REPLACE FUNCTION public.is_platform_staff() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id=auth.uid() AND role IN ('admin','support'))
      OR public.is_main_admin(); $$;
GRANT EXECUTE ON FUNCTION public.is_main_admin(), public.is_platform_staff() TO authenticated, anon;

-- سياسات الإنتاج كما هي
ALTER TABLE public.ticket_attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owner can view own ticket attachments" ON public.ticket_attachments FOR SELECT
  USING (EXISTS (SELECT 1 FROM tickets t WHERE t.id=ticket_attachments.ticket_id AND t.user_id=auth.uid()));
CREATE POLICY "Owner can upload attachments to own ticket" ON public.ticket_attachments FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM tickets t WHERE t.id=ticket_attachments.ticket_id AND t.user_id=auth.uid()));
ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;
CREATE POLICY tickets_select_policy ON public.tickets FOR SELECT USING (
  (user_id=auth.uid()) OR is_main_admin()
  OR ((SELECT profiles.role FROM profiles WHERE profiles.id=auth.uid())='admin')
  OR (user_id IN (SELECT profiles.id FROM profiles WHERE profiles.super_user_id=auth.uid())));
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;   -- وبلا أي سياسة SELECT، كالإنتاج

INSERT INTO storage.buckets(id,public) VALUES ('tickets',true),('chat-attachments',true),('avatars',true);
INSERT INTO auth.users(id,email) VALUES
  ('11111111-1111-4111-8111-111111111111','support@mad3oom.online'),
  ('a0000000-0000-4000-8000-00000000000a','custA@test'),
  ('b0000000-0000-4000-8000-00000000000b','custB@test'),
  ('c0000000-0000-4000-8000-00000000000c','ownerA@test'),
  ('d0000000-0000-4000-8000-00000000000d','ownerB@test'),
  ('e0000000-0000-4000-8000-00000000000e','memberA@test'),
  ('f0000000-0000-4000-8000-00000000000f','memberB@test');
INSERT INTO public.profiles(id,email,role,super_user_id) VALUES
  ('11111111-1111-4111-8111-111111111111','support@mad3oom.online','admin',null),
  ('a0000000-0000-4000-8000-00000000000a','custA@test','user',null),
  ('b0000000-0000-4000-8000-00000000000b','custB@test','user',null),
  ('c0000000-0000-4000-8000-00000000000c','ownerA@test','user',null),
  ('d0000000-0000-4000-8000-00000000000d','ownerB@test','user',null),
  ('e0000000-0000-4000-8000-00000000000e','memberA@test','user','c0000000-0000-4000-8000-00000000000c'),
  ('f0000000-0000-4000-8000-00000000000f','memberB@test','user','d0000000-0000-4000-8000-00000000000d');

-- تذاكر: لكل طرف تذكرة، وملفّها بالعرفين معًا
INSERT INTO public.tickets(id,user_id,title) VALUES
  ('aaaa0000-0000-4000-8000-00000000aaaa','a0000000-0000-4000-8000-00000000000a','تذكرة العميل أ'),
  ('bbbb0000-0000-4000-8000-00000000bbbb','b0000000-0000-4000-8000-00000000000b','تذكرة العميل ب'),
  ('eeee0000-0000-4000-8000-00000000eeee','e0000000-0000-4000-8000-00000000000e','تذكرة عضو الشركة أ'),
  ('ffff0000-0000-4000-8000-00000000ffff','f0000000-0000-4000-8000-00000000000f','تذكرة عضو الشركة ب');
INSERT INTO public.ticket_attachments(ticket_id,file_url,file_name,uploaded_by) VALUES
  ('aaaa0000-0000-4000-8000-00000000aaaa','https://x/object/public/tickets/aaaa0000-0000-4000-8000-00000000aaaa/proofA.png','proofA','a0000000-0000-4000-8000-00000000000a'),
  ('bbbb0000-0000-4000-8000-00000000bbbb','https://x/object/public/tickets/bbbb0000-0000-4000-8000-00000000bbbb/proofB.png','proofB','b0000000-0000-4000-8000-00000000000b'),
  ('eeee0000-0000-4000-8000-00000000eeee','https://x/object/public/tickets/e0000000-0000-4000-8000-00000000000e/eeee0000-0000-4000-8000-00000000eeee/proofE.png','proofE','e0000000-0000-4000-8000-00000000000e'),
  ('ffff0000-0000-4000-8000-00000000ffff','https://x/object/public/tickets/ffff0000-0000-4000-8000-00000000ffff/proofF.png','proofF','f0000000-0000-4000-8000-00000000000f');
INSERT INTO storage.objects(bucket_id,name,owner) VALUES
  ('tickets','aaaa0000-0000-4000-8000-00000000aaaa/proofA.png','a0000000-0000-4000-8000-00000000000a'),
  ('tickets','bbbb0000-0000-4000-8000-00000000bbbb/proofB.png','b0000000-0000-4000-8000-00000000000b'),
  ('tickets','e0000000-0000-4000-8000-00000000000e/eeee0000-0000-4000-8000-00000000eeee/proofE.png','e0000000-0000-4000-8000-00000000000e'),
  ('tickets','ffff0000-0000-4000-8000-00000000ffff/proofF.png','f0000000-0000-4000-8000-00000000000f'),
  ('chat-attachments','a0000000-0000-4000-8000-00000000000a/s1.jpg','a0000000-0000-4000-8000-00000000000a'),
  ('chat-attachments','b0000000-0000-4000-8000-00000000000b/s1.jpg','b0000000-0000-4000-8000-00000000000b'),
  ('avatars','a0000000-0000-4000-8000-00000000000a/pic.png','a0000000-0000-4000-8000-00000000000a');

CREATE OR REPLACE FUNCTION public.reads(p_sql text) RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int; BEGIN EXECUTE 'SELECT count(*) FROM ('||p_sql||') z' INTO n; RETURN n;
EXCEPTION WHEN others THEN RETURN -1; END $$;
GRANT EXECUTE ON FUNCTION public.reads(text) TO authenticated, anon;
CREATE TABLE public.results(phase text, id text, outcome text);
GRANT INSERT, SELECT ON public.results TO authenticated, anon;

CREATE OR REPLACE FUNCTION public.note(p_phase text, p_id text, p_sql text, p_expect_rows boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE n int; BEGIN
  n := public.reads(p_sql);
  INSERT INTO public.results VALUES (p_phase, p_id, CASE WHEN n > 0 THEN 'ALLOWED' ELSE 'DENIED' END);
END $$;
GRANT EXECUTE ON FUNCTION public.note(text,text,text,boolean) TO authenticated, anon;

-- ============================================================================
-- أ) الحالة قبل الترحيل
-- ============================================================================
SET request.jwt.claim.role='authenticated';
SET request.jwt.claim.sub='c0000000-0000-4000-8000-00000000000c';  -- مالك الشركة أ
SET ROLE authenticated;
SELECT public.note('before','B1 owner reads member ticket',      $q$SELECT 1 FROM public.tickets WHERE id='eeee0000-0000-4000-8000-00000000eeee'$q$);
SELECT public.note('before','B2 owner reads member ATTACHMENT',  $q$SELECT 1 FROM public.ticket_attachments WHERE ticket_id='eeee0000-0000-4000-8000-00000000eeee'$q$);
RESET ROLE; SET request.jwt.claim.sub='';
SET request.jwt.claim.sub='a0000000-0000-4000-8000-00000000000a';
SET ROLE authenticated;
SELECT public.note('before','B3 customer signs OWN file (authenticated read)', $q$SELECT 1 FROM storage.objects WHERE bucket_id='tickets' AND name LIKE 'aaaa%'$q$);
RESET ROLE; SET request.jwt.claim.sub='';

DO $$
DECLARE v text;
BEGIN
  SELECT outcome INTO v FROM public.results WHERE phase='before' AND id='B1 owner reads member ticket';
  IF v <> 'ALLOWED' THEN RAISE EXCEPTION 'FAIL setup: مالك الشركة لا يقرأ تذكرة عضوه — البيانات غير مطابقة للإنتاج'; END IF;
  SELECT outcome INTO v FROM public.results WHERE phase='before' AND id='B2 owner reads member ATTACHMENT';
  IF v <> 'DENIED' THEN RAISE EXCEPTION 'FAIL: التعارض المفترض غير موجود'; END IF;
  SELECT outcome INTO v FROM public.results WHERE phase='before' AND id='B3 customer signs OWN file (authenticated read)';
  IF v <> 'DENIED' THEN RAISE EXCEPTION 'FAIL: كان يُفترض ألا توجد سياسة SELECT على storage.objects'; END IF;
  RAISE NOTICE 'PASS A: التعارض مُثبت — التذكرة مقروءة والمرفق لا، ولا قراءة تخزين مصادَقة أصلًا';
END $$;

-- ============================================================================
-- ب) الترحيل
-- ============================================================================
\i migrations/028_storage_closure.sql

-- ============================================================================
-- ج) مصفوفة عبور المستأجرين — كل خانة محاولة فعلية
-- ============================================================================
SET request.jwt.claim.sub='a0000000-0000-4000-8000-00000000000a';   -- العميل أ
SET ROLE authenticated;
SELECT public.note('after','C1  A → own attachment row',   $q$SELECT 1 FROM public.ticket_attachments WHERE ticket_id='aaaa0000-0000-4000-8000-00000000aaaa'$q$);
SELECT public.note('after','C2  A → B attachment row',     $q$SELECT 1 FROM public.ticket_attachments WHERE ticket_id='bbbb0000-0000-4000-8000-00000000bbbb'$q$);
SELECT public.note('after','C3  A → own FILE',             $q$SELECT 1 FROM storage.objects WHERE bucket_id='tickets' AND name='aaaa0000-0000-4000-8000-00000000aaaa/proofA.png'$q$);
SELECT public.note('after','C4  A → B FILE',               $q$SELECT 1 FROM storage.objects WHERE bucket_id='tickets' AND name='bbbb0000-0000-4000-8000-00000000bbbb/proofB.png'$q$);
SELECT public.note('after','C5  A → own chat file',        $q$SELECT 1 FROM storage.objects WHERE bucket_id='chat-attachments' AND name LIKE 'a0000000%'$q$);
SELECT public.note('after','C6  A → B chat file',          $q$SELECT 1 FROM storage.objects WHERE bucket_id='chat-attachments' AND name LIKE 'b0000000%'$q$);
SELECT public.note('after','C7  A → ALL ticket files',     $q$SELECT 1 FROM storage.objects WHERE bucket_id='tickets'$q$);
RESET ROLE; SET request.jwt.claim.sub='';

SET request.jwt.claim.sub='c0000000-0000-4000-8000-00000000000c';   -- مالك الشركة أ
SET ROLE authenticated;
SELECT public.note('after','C8  companyA owner → own member attachment row', $q$SELECT 1 FROM public.ticket_attachments WHERE ticket_id='eeee0000-0000-4000-8000-00000000eeee'$q$);
SELECT public.note('after','C9  companyA owner → own member FILE',           $q$SELECT 1 FROM storage.objects WHERE bucket_id='tickets' AND name LIKE '%eeee0000%'$q$);
SELECT public.note('after','C10 companyA owner → companyB member row',       $q$SELECT 1 FROM public.ticket_attachments WHERE ticket_id='ffff0000-0000-4000-8000-00000000ffff'$q$);
SELECT public.note('after','C11 companyA owner → companyB member FILE',      $q$SELECT 1 FROM storage.objects WHERE bucket_id='tickets' AND name LIKE 'ffff0000%'$q$);
SELECT public.note('after','C12 companyA owner → unrelated customer FILE',   $q$SELECT 1 FROM storage.objects WHERE bucket_id='tickets' AND name LIKE 'bbbb0000%'$q$);
RESET ROLE; SET request.jwt.claim.sub='';

SET request.jwt.claim.sub='e0000000-0000-4000-8000-00000000000e';   -- عضو الشركة أ
SET ROLE authenticated;
SELECT public.note('after','C13 member → own FILE',                 $q$SELECT 1 FROM storage.objects WHERE bucket_id='tickets' AND name LIKE '%eeee0000%'$q$);
SELECT public.note('after','C14 member → company OWNER''s other member file', $q$SELECT 1 FROM storage.objects WHERE bucket_id='tickets' AND name LIKE 'ffff0000%'$q$);
SELECT public.note('after','C15 member → unrelated customer FILE',  $q$SELECT 1 FROM storage.objects WHERE bucket_id='tickets' AND name LIKE 'bbbb0000%'$q$);
RESET ROLE; SET request.jwt.claim.sub='';

SET request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';   -- الإدارة
SET ROLE authenticated;
SELECT public.note('after','C16 staff → any ticket file', $q$SELECT 1 FROM storage.objects WHERE bucket_id='tickets'$q$);
SELECT public.note('after','C17 staff → any attachment row', $q$SELECT 1 FROM public.ticket_attachments$q$);
RESET ROLE; SET request.jwt.claim.sub='';

SET request.jwt.claim.role='anon'; SET ROLE anon;
SELECT public.note('after','C18 anonymous → any ticket file', $q$SELECT 1 FROM storage.objects WHERE bucket_id='tickets'$q$);
SELECT public.note('after','C19 anonymous → avatars (public by design)', $q$SELECT 1 FROM storage.objects WHERE bucket_id='avatars'$q$);
RESET ROLE; SET request.jwt.claim.role='authenticated';

DO $$
DECLARE r record; bad text := '';
  expected constant jsonb := '{
    "C1  A → own attachment row":"ALLOWED",
    "C2  A → B attachment row":"DENIED",
    "C3  A → own FILE":"ALLOWED",
    "C4  A → B FILE":"DENIED",
    "C5  A → own chat file":"ALLOWED",
    "C6  A → B chat file":"DENIED",
    "C7  A → ALL ticket files":"ALLOWED",
    "C8  companyA owner → own member attachment row":"ALLOWED",
    "C9  companyA owner → own member FILE":"ALLOWED",
    "C10 companyA owner → companyB member row":"DENIED",
    "C11 companyA owner → companyB member FILE":"DENIED",
    "C12 companyA owner → unrelated customer FILE":"DENIED",
    "C13 member → own FILE":"ALLOWED",
    "C14 member → company OWNER''s other member file":"DENIED",
    "C15 member → unrelated customer FILE":"DENIED",
    "C16 staff → any ticket file":"ALLOWED",
    "C17 staff → any attachment row":"ALLOWED",
    "C18 anonymous → any ticket file":"DENIED",
    "C19 anonymous → avatars (public by design)":"ALLOWED"
  }'::jsonb;
BEGIN
  FOR r IN SELECT id, outcome FROM public.results WHERE phase='after' ORDER BY id LOOP
    IF expected->>r.id IS NULL THEN
      RAISE EXCEPTION 'FAIL: خانة بلا توقع مسجَّل: %', r.id;
    END IF;
    IF expected->>r.id <> r.outcome THEN
      bad := bad || format('%s (توقع %s فجاء %s); ', r.id, expected->>r.id, r.outcome);
    END IF;
  END LOOP;
  IF bad <> '' THEN RAISE EXCEPTION 'FAIL مصفوفة العبور: %', bad; END IF;
  RAISE NOTICE 'PASS C1..C19 مصفوفة عبور المستأجرين مطابقة بالكامل';
END $$;

-- C7 كان ALLOWED عمدًا: العميل أ يقرأ «كل ملفات التذاكر» — لكن الصف الوحيد
-- الذي يعود هو ملفه هو. نُثبت العدد لا مجرد وجود صف.
SET request.jwt.claim.sub='a0000000-0000-4000-8000-00000000000a';
SET ROLE authenticated;
DO $$
DECLARE n int;
BEGIN
  n := public.reads($q$SELECT 1 FROM storage.objects WHERE bucket_id='tickets'$q$);
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL D1: العميل أ يرى % ملفًا في مستودع التذاكر بدل ملفه وحده', n;
  END IF;
  n := public.reads($q$SELECT 1 FROM public.ticket_attachments$q$);
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL D2: العميل أ يرى % صف مرفقات بدل صفّه وحده', n; END IF;
  RAISE NOTICE 'PASS D1..D2 المدى مقصور على صف واحد فعلًا، لا مجرد «غير فارغ»';
END $$;
RESET ROLE; SET request.jwt.claim.sub='';

-- مالك الشركة يرى ملفه وملف عضوه فقط (2)، لا الأربعة
SET request.jwt.claim.sub='c0000000-0000-4000-8000-00000000000c';
SET ROLE authenticated;
DO $$
DECLARE n int;
BEGIN
  n := public.reads($q$SELECT 1 FROM storage.objects WHERE bucket_id='tickets'$q$);
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL D3: مالك الشركة أ يرى % ملفًا بدل ملف عضوه وحده', n; END IF;
  RAISE NOTICE 'PASS D3 مالك الشركة محصور في أعضائه';
END $$;
RESET ROLE; SET request.jwt.claim.sub='';

-- الترحيل قابل لإعادة التطبيق
\i migrations/028_storage_closure.sql
DO $$ BEGIN RAISE NOTICE 'PASS E1 إعادة تطبيق 028 لم تفشل'; END $$;

-- ============================================================================
-- و) 030 — الخصخصة وقيود الكتابة
-- ============================================================================
-- الضابط السلبي أولًا: على سياسات الإنتاج، الكتابة في مسار الغير تمرّ.
CREATE TABLE public.storage_probe(phase text, id text, outcome text);
GRANT INSERT, SELECT ON public.storage_probe TO authenticated, anon;
CREATE OR REPLACE FUNCTION public.wattempt(p_phase text, p_id text, p_sql text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE n int; BEGIN
  EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO public.storage_probe VALUES (p_phase, p_id, CASE WHEN n=0 THEN 'DENIED' ELSE 'ALLOWED' END);
EXCEPTION WHEN others THEN
  INSERT INTO public.storage_probe VALUES (p_phase, p_id, 'DENIED');
END $$;
GRANT EXECUTE ON FUNCTION public.wattempt(text,text,text) TO authenticated, anon;

-- سياسات الكتابة كما هي على الإنتاج قبل 030
DROP POLICY IF EXISTS "Allow authenticated uploads" ON storage.objects;
CREATE POLICY "Allow authenticated uploads" ON storage.objects FOR INSERT
  WITH CHECK ((bucket_id='tickets') AND (auth.role()='authenticated'));
DROP POLICY IF EXISTS "Allow Authenticated Insert" ON storage.objects;
CREATE POLICY "Allow Authenticated Insert" ON storage.objects FOR INSERT
  WITH CHECK ((bucket_id='avatars') AND (auth.role()='authenticated'));
DROP POLICY IF EXISTS "Allow authenticated users to upload" ON storage.objects;
CREATE POLICY "Allow authenticated users to upload" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id='chat-attachments');

SET request.jwt.claim.role='authenticated';
SET request.jwt.claim.sub='a0000000-0000-4000-8000-00000000000a';
SET ROLE authenticated;
SELECT public.wattempt('before','W1 upload into ANOTHER user avatar dir',
  $q$INSERT INTO storage.objects(bucket_id,name,owner) VALUES ('avatars','b0000000-0000-4000-8000-00000000000b/evil.png','a0000000-0000-4000-8000-00000000000a')$q$);
SELECT public.wattempt('before','W2 upload into ANOTHER user ticket dir',
  $q$INSERT INTO storage.objects(bucket_id,name,owner) VALUES ('tickets','bbbb0000-0000-4000-8000-00000000bbbb/evil.png','a0000000-0000-4000-8000-00000000000a')$q$);
RESET ROLE; SET request.jwt.claim.sub='';
SET request.jwt.claim.role='anon'; SET ROLE anon;
SELECT public.wattempt('before','W3 ANONYMOUS upload to chat-attachments',
  $q$INSERT INTO storage.objects(bucket_id,name,owner) VALUES ('chat-attachments','chat-media/anon.txt',NULL)$q$);
RESET ROLE; SET request.jwt.claim.role='authenticated';

DO $$
DECLARE r record; bad text := '';
BEGIN
  FOR r IN SELECT id,outcome FROM public.storage_probe WHERE phase='before' LOOP
    IF r.outcome <> 'ALLOWED' THEN bad := bad || r.id || ' '; END IF;
  END LOOP;
  IF bad <> '' THEN RAISE EXCEPTION 'FAIL الضابط السلبي لـ030 لم يثبت: %', bad; END IF;
  RAISE NOTICE 'PASS F0 الضابط السلبي: الكتابة في مسار الغير والرفع المجهول يمرّان قبل 030';
END $$;
DELETE FROM storage.objects WHERE name LIKE '%evil%' OR name='chat-media/anon.txt';

\i migrations/030_storage_privatisation.sql

SET request.jwt.claim.sub='a0000000-0000-4000-8000-00000000000a';
SET ROLE authenticated;
SELECT public.wattempt('after','W1 upload into ANOTHER user avatar dir',
  $q$INSERT INTO storage.objects(bucket_id,name,owner) VALUES ('avatars','b0000000-0000-4000-8000-00000000000b/evil.png','a0000000-0000-4000-8000-00000000000a')$q$);
SELECT public.wattempt('after','W2 upload into ANOTHER user ticket dir',
  $q$INSERT INTO storage.objects(bucket_id,name,owner) VALUES ('tickets','bbbb0000-0000-4000-8000-00000000bbbb/evil.png','a0000000-0000-4000-8000-00000000000a')$q$);
SELECT public.wattempt('after','W4 upload into OWN avatar dir (must still work)',
  $q$INSERT INTO storage.objects(bucket_id,name,owner) VALUES ('avatars','a0000000-0000-4000-8000-00000000000a/ok.png','a0000000-0000-4000-8000-00000000000a')$q$);
SELECT public.wattempt('after','W5 upload to OWN ticket (must still work)',
  $q$INSERT INTO storage.objects(bucket_id,name,owner) VALUES ('tickets','aaaa0000-0000-4000-8000-00000000aaaa/ok.png','a0000000-0000-4000-8000-00000000000a')$q$);
SELECT public.wattempt('after','W6 upload own chat path (must still work)',
  $q$INSERT INTO storage.objects(bucket_id,name,owner) VALUES ('chat-attachments','a0000000-0000-4000-8000-00000000000a/s9.jpg','a0000000-0000-4000-8000-00000000000a')$q$);
SELECT public.wattempt('after','W7 UPDATE another user ticket object',
  $q$UPDATE storage.objects SET name=name||'.x' WHERE bucket_id='tickets' AND name LIKE 'bbbb%'$q$);
SELECT public.wattempt('after','W8 DELETE another user ticket object',
  $q$DELETE FROM storage.objects WHERE bucket_id='tickets' AND name LIKE 'bbbb%'$q$);
SELECT public.wattempt('after','W9 DELETE own ticket object (deny-by-default)',
  $q$DELETE FROM storage.objects WHERE bucket_id='tickets' AND name LIKE 'aaaa%'$q$);
SELECT public.wattempt('after','W10 UPDATE another user avatar',
  $q$UPDATE storage.objects SET name='a0000000-0000-4000-8000-00000000000a/stolen.png' WHERE bucket_id='avatars' AND name LIKE 'b0000000%'$q$);
RESET ROLE; SET request.jwt.claim.sub='';
SET request.jwt.claim.role='anon'; SET ROLE anon;
SELECT public.wattempt('after','W3 ANONYMOUS upload to chat-attachments',
  $q$INSERT INTO storage.objects(bucket_id,name,owner) VALUES ('chat-attachments','chat-media/anon.txt',NULL)$q$);
RESET ROLE; SET request.jwt.claim.role='authenticated';

DO $$
DECLARE r record; bad text := '';
  expected constant jsonb := '{
    "W1 upload into ANOTHER user avatar dir":"DENIED",
    "W2 upload into ANOTHER user ticket dir":"DENIED",
    "W3 ANONYMOUS upload to chat-attachments":"DENIED",
    "W4 upload into OWN avatar dir (must still work)":"ALLOWED",
    "W5 upload to OWN ticket (must still work)":"ALLOWED",
    "W6 upload own chat path (must still work)":"ALLOWED",
    "W7 UPDATE another user ticket object":"DENIED",
    "W8 DELETE another user ticket object":"DENIED",
    "W9 DELETE own ticket object (deny-by-default)":"DENIED",
    "W10 UPDATE another user avatar":"DENIED"
  }'::jsonb;
BEGIN
  FOR r IN SELECT id,outcome FROM public.storage_probe WHERE phase='after' LOOP
    IF expected->>r.id IS NULL THEN RAISE EXCEPTION 'FAIL: خانة بلا توقع: %', r.id; END IF;
    IF expected->>r.id <> r.outcome THEN
      bad := bad || format('%s (توقع %s فجاء %s); ', r.id, expected->>r.id, r.outcome);
    END IF;
  END LOOP;
  IF bad <> '' THEN RAISE EXCEPTION 'FAIL مصفوفة الكتابة: %', bad; END IF;
  RAISE NOTICE 'PASS W1..W10 الكتابة والتعديل والحذف مقيدة، والمسارات المشروعة تعمل';
END $$;

-- المستودعان صارا خاصين والصور الرمزية بقيت عامة
DO $$
DECLARE v_t boolean; v_c boolean; v_a boolean; v_path text;
BEGIN
  SELECT public INTO v_t FROM storage.buckets WHERE id='tickets';
  SELECT public INTO v_c FROM storage.buckets WHERE id='chat-attachments';
  SELECT public INTO v_a FROM storage.buckets WHERE id='avatars';
  IF v_t OR v_c THEN RAISE EXCEPTION 'FAIL G1: مستودع حسّاس ما زال عامًّا'; END IF;
  IF NOT v_a THEN RAISE EXCEPTION 'FAIL G2: avatars صار خاصًّا فينكسر المنتدى'; END IF;

  SELECT file_path INTO v_path FROM public.ticket_attachments
   WHERE ticket_id='aaaa0000-0000-4000-8000-00000000aaaa';
  IF v_path <> 'aaaa0000-0000-4000-8000-00000000aaaa/proofA.png' THEN
    RAISE EXCEPTION 'FAIL G3: الترحيل لم يستخرج المسار الصحيح (%)', coalesce(v_path,'null');
  END IF;
  RAISE NOTICE 'PASS G1..G3 الخصخصة تمّت، والصور الرمزية عامة، والمسارات مُرحَّلة';
END $$;

\i migrations/030_storage_privatisation.sql
DO $$ BEGIN RAISE NOTICE 'PASS H1 إعادة تطبيق 030 لم تفشل'; END $$;

SELECT 'ALL 028+030 STORAGE TESTS PASSED' AS result;
