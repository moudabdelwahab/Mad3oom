-- اختبار تنفيذي لـ migrations/013 (مركز المساعدة) و014 (حالة النظام
-- وبلاغات العملاء) و015 (إجراءات الإشعارات).
--
-- الحاجات اللي لازم تتّختبر على Postgres حقيقي مش في المتصفح:
--   013: العميل يقرأ المنشور غير الداخلي فقط، والمسودّة والداخلي محجوبان،
--        والبحث بيرتّب بالصلة ومحكوم بـRLS، والتصويت المكرر ممنوع.
--   014: مفتاح النوبة بيتحسب على السيرفر، والبلاغ المكرر مرفوض، والبلاغ
--        الجديد بعد نوبة جديدة مسموح، وإشعار الإدارة مرة واحدة لكل نوبة.
--   015: الإجراء بيتشتق من التصنيف والرابط، وreference_id بيتملأ من الرابط.
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE auth.users (id uuid PRIMARY KEY);

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

CREATE TABLE public.profiles (
  id    uuid PRIMARY KEY,
  email text,
  full_name text,
  role  text NOT NULL DEFAULT 'user'
);

CREATE TABLE public.notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  title        text NOT NULL,
  message      text NOT NULL,
  type         text DEFAULT 'info',
  is_read      boolean DEFAULT false,
  link         text,
  created_at   timestamptz DEFAULT now(),
  reference_id uuid,
  category     text
);

-- 011 مطلوب لأن 015 بيستدعي derive_notification_category
CREATE TABLE public.suggested_questions (
  id         bigserial PRIMARY KEY,
  question   text,
  answer     text,
  category   varchar(100),
  is_active  boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.suggested_questions ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.services (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          varchar(255) NOT NULL,
  description   text,
  status        varchar(50) DEFAULT 'operational'
                CHECK (status IN ('operational', 'degraded', 'down')),
  response_time integer,
  last_checked  timestamp DEFAULT now(),
  created_at    timestamp DEFAULT now(),
  updated_at    timestamp DEFAULT now()
);

CREATE TABLE public.service_status_history (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES public.services(id) ON DELETE CASCADE,
  status     varchar(50) NOT NULL
             CHECK (status IN ('operational', 'degraded', 'down')),
  response_time integer,
  created_at timestamp DEFAULT now()
);

CREATE TABLE public.incidents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title             varchar(255) NOT NULL,
  description       text,
  status            varchar(50) DEFAULT 'investigating',
  affected_services text[] DEFAULT '{}',
  created_at        timestamp DEFAULT now(),
  updated_at        timestamp DEFAULT now(),
  resolved_at       timestamp
);

ALTER TABLE public.services               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incidents              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_status_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read access to services"
  ON public.services FOR SELECT USING (true);
CREATE POLICY "Allow public read access to incidents"
  ON public.incidents FOR SELECT USING (true);
CREATE POLICY "Allow public read access to service history"
  ON public.service_status_history FOR SELECT USING (true);

-- ── بيانات ────────────────────────────────────────────────────────────────
\set customer '11111111-1111-1111-1111-111111111111'
\set other    '22222222-2222-2222-2222-222222222222'
\set admin    '33333333-3333-3333-3333-333333333333'

INSERT INTO auth.users (id) VALUES
  (:'customer'::uuid), (:'other'::uuid), (:'admin'::uuid);

INSERT INTO public.profiles (id, email, full_name, role) VALUES
  (:'customer'::uuid, 'c@example.com', 'عميل تجريبي', 'user'),
  (:'other'::uuid,    'o@example.com', 'عميل آخر',    'user'),
  (:'admin'::uuid,    'a@example.com', 'مدير',        'admin');

-- 011 لازم يتطبّق قبل 015
\echo '--- applying migrations/011 ---'
\i migrations/011_notification_categories.sql

\echo '--- applying migrations/013 ---'
\i migrations/013_help_center.sql

\echo '--- applying migrations/014 ---'
\i migrations/014_service_status_and_customer_reports.sql

\echo '--- applying migrations/015 ---'
\i migrations/015_notification_actions.sql

-- الأدوار بتقلّد الجلسة الفعلية: العميل مسجَّل عبر authenticated
-- الأدوار على مستوى العنقود مش قاعدة البيانات، فبتفضل موجودة بين الملفات
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- ── مقالات للاختبار ───────────────────────────────────────────────────────
INSERT INTO public.knowledge_base (id, title, category, excerpt, content, status, is_internal)
VALUES
  ('aaaa1111-1111-4111-8111-aaaaaaaaaaaa', 'شحن رصيد الواتساب', 'واتساب',
   'خطوات الشحن', 'افتح المحفظة ثم اضغط شحن', 'published', false),
  ('bbbb2222-2222-4222-8222-bbbbbbbbbbbb', 'مسودّة قيد الكتابة', 'واتساب',
   NULL, 'محتوى غير جاهز', 'draft', false),
  ('cccc3333-3333-4333-8333-cccccccccccc', 'ملاحظات داخلية للفريق', 'الدعم',
   NULL, 'سياسة التصعيد الداخلية', 'published', true);

INSERT INTO public.services (id, name, service_key, status)
VALUES ('dddd4444-4444-4444-8444-dddddddddddd', 'خدمة الإشعارات', 'notifications', 'down');

-- ============================================================================
-- A) مركز المساعدة: من يرى ماذا
-- ============================================================================
DO $$
DECLARE v_count integer;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);

  SELECT count(*) INTO v_count FROM public.knowledge_base;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL A1: العميل يرى % مقال بدل 1', v_count;
  END IF;
  RAISE NOTICE 'PASS A1: العميل يرى المنشور غير الداخلي فقط';

  SELECT count(*) INTO v_count FROM public.knowledge_base
   WHERE id = 'bbbb2222-2222-4222-8222-bbbbbbbbbbbb';
  IF v_count <> 0 THEN RAISE EXCEPTION 'FAIL A2: المسودّة ظهرت للعميل'; END IF;
  RAISE NOTICE 'PASS A2: المسودّة محجوبة';

  SELECT count(*) INTO v_count FROM public.knowledge_base
   WHERE id = 'cccc3333-3333-4333-8333-cccccccccccc';
  IF v_count <> 0 THEN RAISE EXCEPTION 'FAIL A3: المقال الداخلي ظهر للعميل'; END IF;
  RAISE NOTICE 'PASS A3: المقال الداخلي محجوب';

  RESET ROLE;
END $$;

DO $$
DECLARE v_count integer;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);

  SELECT count(*) INTO v_count FROM public.knowledge_base;
  IF v_count <> 3 THEN RAISE EXCEPTION 'FAIL A4: الأدمن يرى % بدل 3', v_count; END IF;
  RAISE NOTICE 'PASS A4: الأدمن يرى المسودّات والداخلي';

  RESET ROLE;
END $$;

-- البحث محكوم بنفس السياسات (security invoker)
DO $$
DECLARE v_count integer; v_title text;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);

  SELECT count(*) INTO v_count FROM public.search_help_articles('مسودّة', NULL, 20, 0);
  IF v_count <> 0 THEN RAISE EXCEPTION 'FAIL B1: البحث كشف مسودّة'; END IF;
  RAISE NOTICE 'PASS B1: البحث لا يكشف المسودّات';

  SELECT title INTO v_title FROM public.search_help_articles('الواتساب', NULL, 20, 0) LIMIT 1;
  IF v_title IS DISTINCT FROM 'شحن رصيد الواتساب' THEN
    RAISE EXCEPTION 'FAIL B2: البحث لم يجد المقال المنشور (%)', v_title;
  END IF;
  RAISE NOTICE 'PASS B2: البحث يجد المنشور';

  -- المطابقة في المتن وحده كافية (relevance = 1)
  SELECT count(*) INTO v_count FROM public.search_help_articles('اضغط شحن', NULL, 20, 0);
  IF v_count <> 1 THEN RAISE EXCEPTION 'FAIL B3: البحث في المتن لم يعمل'; END IF;
  RAISE NOTICE 'PASS B3: البحث يشمل المتن';

  RESET ROLE;
END $$;

-- عدّاد القراءة يمرّ عبر الدالة، والعميل لا يملك UPDATE مباشرًا
DO $$
DECLARE v_views integer; v_blocked boolean := false;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);

  PERFORM public.increment_article_view('aaaa1111-1111-4111-8111-aaaaaaaaaaaa');
  RESET ROLE;

  SELECT view_count INTO v_views FROM public.knowledge_base
   WHERE id = 'aaaa1111-1111-4111-8111-aaaaaaaaaaaa';
  IF v_views <> 1 THEN RAISE EXCEPTION 'FAIL C1: العدّاد = % بدل 1', v_views; END IF;
  RAISE NOTICE 'PASS C1: عدّاد القراءة يزيد عبر الدالة';

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  BEGIN
    UPDATE public.knowledge_base SET title = 'عنوان مخترق'
     WHERE id = 'aaaa1111-1111-4111-8111-aaaaaaaaaaaa';
    -- RLS بترجّع 0 صفوف بدل ما ترمي؛ الاتنين مقبولين طالما ما اتغيّرش شيء
  EXCEPTION WHEN insufficient_privilege THEN v_blocked := true;
  END;
  RESET ROLE;

  SELECT count(*) INTO v_views FROM public.knowledge_base WHERE title = 'عنوان مخترق';
  IF v_views <> 0 THEN RAISE EXCEPTION 'FAIL C2: العميل عدّل مقالًا'; END IF;
  RAISE NOTICE 'PASS C2: العميل لا يعدّل المقالات';
END $$;

-- التصويت المكرر ممنوع بقيد فريد
DO $$
DECLARE v_count integer;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);

  INSERT INTO public.kb_article_feedback (article_id, user_id, is_helpful)
  VALUES ('aaaa1111-1111-4111-8111-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', false);

  INSERT INTO public.kb_article_feedback (article_id, user_id, is_helpful)
  VALUES ('aaaa1111-1111-4111-8111-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', true)
  ON CONFLICT (article_id, user_id) DO UPDATE SET is_helpful = excluded.is_helpful;

  RESET ROLE;

  SELECT count(*) INTO v_count FROM public.kb_article_feedback
   WHERE article_id = 'aaaa1111-1111-4111-8111-aaaaaaaaaaaa';
  IF v_count <> 1 THEN RAISE EXCEPTION 'FAIL D1: تكرّر التصويت (% صفوف)', v_count; END IF;
  RAISE NOTICE 'PASS D1: التصويت المكرر يحدّث الرأي ولا يضاعفه';
END $$;

-- الأسئلة الشائعة: النشط فقط
DO $$
DECLARE v_count integer;
BEGIN
  INSERT INTO public.suggested_questions (question, answer, category, is_active)
  VALUES ('سؤال نشط', 'إجابة', 'الدعم', true), ('سؤال معطّل', 'إجابة', 'الدعم', false);

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  SELECT count(*) INTO v_count FROM public.suggested_questions;
  RESET ROLE;

  IF v_count <> 1 THEN RAISE EXCEPTION 'FAIL D2: العميل يرى % سؤال بدل 1', v_count; END IF;
  RAISE NOTICE 'PASS D2: الأسئلة النشطة فقط تصل العميل (كانت محجوبة كلها)';
END $$;

-- ============================================================================
-- E) حالة النظام: الحالات الجديدة ووقت بداية المشكلة
-- ============================================================================
DO $$
DECLARE v_changed_before timestamptz; v_changed_after timestamptz;
BEGIN
  SELECT status_changed_at INTO v_changed_before FROM public.services
   WHERE id = 'dddd4444-4444-4444-8444-dddddddddddd';
  IF v_changed_before IS NULL THEN RAISE EXCEPTION 'FAIL E1: status_changed_at فارغ'; END IF;
  RAISE NOTICE 'PASS E1: لحظة بداية الحالة مسجّلة';

  UPDATE public.services SET status = 'maintenance'
   WHERE id = 'dddd4444-4444-4444-8444-dddddddddddd';

  SELECT status_changed_at INTO v_changed_after FROM public.services
   WHERE id = 'dddd4444-4444-4444-8444-dddddddddddd';
  IF v_changed_after <= v_changed_before THEN
    RAISE EXCEPTION 'FAIL E2: تغيّر الحالة لم يحدّث وقت البداية';
  END IF;
  RAISE NOTICE 'PASS E2: حالة الصيانة مقبولة ووقت البداية تحدّث';

  -- آخر فحص لا يعني تغيّر حالة
  UPDATE public.services SET last_checked = now()
   WHERE id = 'dddd4444-4444-4444-8444-dddddddddddd';
  IF (SELECT status_changed_at FROM public.services
       WHERE id = 'dddd4444-4444-4444-8444-dddddddddddd') <> v_changed_after THEN
    RAISE EXCEPTION 'FAIL E3: فحص بلا تغيير حالة حرّك وقت البداية';
  END IF;
  RAISE NOTICE 'PASS E3: الفحص وحده لا يغيّر وقت بداية المشكلة';

  UPDATE public.services SET status = 'down'
   WHERE id = 'dddd4444-4444-4444-8444-dddddddddddd';
END $$;

-- ============================================================================
-- F) بلاغات العملاء: مفتاح النوبة ومنع التكرار وإشعار الإدارة
-- ============================================================================
DO $$
DECLARE v_key text; v_expected text; v_changed timestamptz;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);

  INSERT INTO public.customer_service_reports (user_id, service_id, episode_key)
  VALUES ('11111111-1111-1111-1111-111111111111',
          'dddd4444-4444-4444-8444-dddddddddddd',
          'مفتاح-مزوّر-من-العميل');
  RESET ROLE;

  SELECT r.episode_key INTO v_key FROM public.customer_service_reports r
   WHERE r.user_id = '11111111-1111-1111-1111-111111111111';

  SELECT s.status_changed_at INTO v_changed FROM public.services s
   WHERE s.id = 'dddd4444-4444-4444-8444-dddddddddddd';
  v_expected := 'service:dddd4444-4444-4444-8444-dddddddddddd:'
             || extract(epoch from v_changed)::bigint::text;

  IF v_key <> v_expected THEN
    RAISE EXCEPTION 'FAIL F1: المفتاح % بدل % — العميل قدر يفرض مفتاحه', v_key, v_expected;
  END IF;
  RAISE NOTICE 'PASS F1: مفتاح النوبة يُحسب على السيرفر ويتجاهل ما يرسله العميل';
END $$;

DO $$
DECLARE v_failed boolean := false; v_count integer;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  BEGIN
    INSERT INTO public.customer_service_reports (user_id, service_id)
    VALUES ('11111111-1111-1111-1111-111111111111', 'dddd4444-4444-4444-8444-dddddddddddd');
  EXCEPTION WHEN unique_violation THEN v_failed := true;
  END;
  RESET ROLE;

  IF NOT v_failed THEN RAISE EXCEPTION 'FAIL F2: قُبل بلاغ مكرر لنفس النوبة'; END IF;
  RAISE NOTICE 'PASS F2: البلاغ المكرر لنفس النوبة مرفوض';

  SELECT count(*) INTO v_count FROM public.customer_service_reports;
  IF v_count <> 1 THEN RAISE EXCEPTION 'FAIL F2b: عدد البلاغات %', v_count; END IF;
END $$;

-- إشعار الإدارة: مرة واحدة لكل نوبة مهما بلّغ عدد من العملاء
DO $$
DECLARE v_notifications integer;
BEGIN
  SELECT count(*) INTO v_notifications FROM public.notifications
   WHERE user_id = '33333333-3333-3333-3333-333333333333'
     AND title = 'عميل أبلغ عن مشكلة';
  IF v_notifications <> 1 THEN
    RAISE EXCEPTION 'FAIL G1: إشعارات الإدارة = % بدل 1', v_notifications;
  END IF;
  RAISE NOTICE 'PASS G1: الإدارة تُشعَر عند أول بلاغ';

  -- عميل تانٍ على نفس النوبة: بلاغ جديد، بلا إشعار جديد
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  INSERT INTO public.customer_service_reports (user_id, service_id)
  VALUES ('22222222-2222-2222-2222-222222222222', 'dddd4444-4444-4444-8444-dddddddddddd');
  RESET ROLE;

  SELECT count(*) INTO v_notifications FROM public.notifications
   WHERE user_id = '33333333-3333-3333-3333-333333333333'
     AND title = 'عميل أبلغ عن مشكلة';
  IF v_notifications <> 1 THEN
    RAISE EXCEPTION 'FAIL G2: تكرّر إشعار الإدارة لنفس النوبة (%)', v_notifications;
  END IF;
  RAISE NOTICE 'PASS G2: لا ضجيج — إشعار واحد لكل نوبة مهما زاد عدد المبلّغين';
END $$;

-- عزل البلاغات بين العملاء
DO $$
DECLARE v_count integer;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  SELECT count(*) INTO v_count FROM public.customer_service_reports;
  RESET ROLE;

  IF v_count <> 1 THEN RAISE EXCEPTION 'FAIL H1: العميل يرى % بلاغ بدل بلاغه هو', v_count; END IF;
  RAISE NOTICE 'PASS H1: كل عميل يرى بلاغاته هو فقط';
END $$;

-- نوبة جديدة بعد تعافي الخدمة تسمح ببلاغ جديد.
--
-- التعافي والانتكاسة لازم يكونوا في معاملتين مختلفتين وبينهم ثانية على
-- الأقل: now() بترجّع وقت بداية المعاملة، ومفتاح النوبة بيقرّب للثانية.
-- لو الاتنين في نفس المعاملة (أو نفس الثانية) المفتاح ما بيتغيّرش —
-- وده سلوك مقصود، مش خلل: نوبتا عطل داخل ثانية واحدة نوبة واحدة عمليًا.
UPDATE public.services SET status = 'operational'
 WHERE id = 'dddd4444-4444-4444-8444-dddddddddddd';

SELECT pg_sleep(1.2);

UPDATE public.services SET status = 'down'
 WHERE id = 'dddd4444-4444-4444-8444-dddddddddddd';

DO $$
DECLARE v_count integer;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  INSERT INTO public.customer_service_reports (user_id, service_id)
  VALUES ('11111111-1111-1111-1111-111111111111', 'dddd4444-4444-4444-8444-dddddddddddd');
  SELECT count(*) INTO v_count FROM public.customer_service_reports;
  RESET ROLE;

  IF v_count <> 2 THEN RAISE EXCEPTION 'FAIL H2: لم يُقبل بلاغ لنوبة جديدة (% بلاغ)', v_count; END IF;
  RAISE NOTICE 'PASS H2: نوبة عطل جديدة تسمح ببلاغ جديد';
END $$;

-- ملخّص الإدارة محصور في الأدمن/الدعم
DO $$
DECLARE v_denied boolean := false; v_rows integer;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  BEGIN
    PERFORM * FROM public.get_service_report_summary();
  EXCEPTION WHEN others THEN v_denied := true;
  END;
  RESET ROLE;

  IF NOT v_denied THEN RAISE EXCEPTION 'FAIL I1: العميل قرأ ملخّص بلاغات كل العملاء'; END IF;
  RAISE NOTICE 'PASS I1: ملخّص البلاغات محجوب عن العميل';

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  SELECT count(*) INTO v_rows FROM public.get_service_report_summary();
  RESET ROLE;

  IF v_rows < 1 THEN RAISE EXCEPTION 'FAIL I2: الأدمن لم يرَ أي بلاغ'; END IF;
  RAISE NOTICE 'PASS I2: الأدمن يرى الملخّص مجمّعاً';
END $$;

-- ============================================================================
-- J) إجراءات الإشعارات (015)
-- ============================================================================
DO $$
DECLARE r record;
BEGIN
  INSERT INTO public.notifications (user_id, title, message, type, link)
  VALUES ('11111111-1111-1111-1111-111111111111', 'رد جديد على تذكرتك', 'رد', 'info',
          'customer-dashboard.html?ticket=aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa');

  SELECT * INTO r FROM public.notifications
   WHERE title = 'رد جديد على تذكرتك' LIMIT 1;

  IF r.action <> 'open_ticket' THEN RAISE EXCEPTION 'FAIL J1: الإجراء % بدل open_ticket', r.action; END IF;
  IF r.action_target <> 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa' THEN
    RAISE EXCEPTION 'FAIL J1b: الوجهة %', r.action_target;
  END IF;
  IF r.reference_id::text <> 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa' THEN
    RAISE EXCEPTION 'FAIL J1c: reference_id لم يُملأ من الرابط';
  END IF;
  RAISE NOTICE 'PASS J1: إشعار التذكرة يحمل إجراءه ومعرّفه (كان الرابط يُتجاهل)';
END $$;

DO $$
DECLARE r record;
BEGIN
  INSERT INTO public.notifications (user_id, title, message, type, link)
  VALUES ('11111111-1111-1111-1111-111111111111', 'رصيد الواتساب منخفض', 'الرصيد 12', 'warning', NULL);

  SELECT * INTO r FROM public.notifications WHERE title = 'رصيد الواتساب منخفض' LIMIT 1;
  IF r.category <> 'billing' THEN RAISE EXCEPTION 'FAIL J2: التصنيف %', r.category; END IF;
  IF r.action <> 'open_section' OR r.action_target <> 'usage' THEN
    RAISE EXCEPTION 'FAIL J2b: الإجراء %/%', r.action, r.action_target;
  END IF;
  RAISE NOTICE 'PASS J2: الإجراء يُشتق من التصنيف لا من نص العنوان';
END $$;

DO $$
DECLARE r record;
BEGIN
  -- إشعار محادثة يخص لوحة الإدارة: ما ينفعش يودّي العميل لصفحة إدارية
  INSERT INTO public.notifications (user_id, title, message, type, link)
  VALUES ('11111111-1111-1111-1111-111111111111', 'رسالة محادثة', 'رسالة', 'chat',
          '/chat-admin.html?session=aaaa1111-1111-4111-8111-aaaaaaaaaaaa');

  SELECT * INTO r FROM public.notifications WHERE title = 'رسالة محادثة' LIMIT 1;
  IF r.action <> 'none' THEN
    RAISE EXCEPTION 'FAIL J3: إشعار إداري حصل على إجراء % للعميل', r.action;
  END IF;
  RAISE NOTICE 'PASS J3: الإشعارات الإدارية لا تُنتج وجهة للعميل';
END $$;

DO $$
DECLARE r record;
BEGIN
  -- التصنيف الصريح والإجراء الصريح لهما الأولوية على الاشتقاق
  INSERT INTO public.notifications (user_id, title, message, type, link, action, action_target, action_label)
  VALUES ('11111111-1111-1111-1111-111111111111', 'عنوان محايد', 'نص', 'info', NULL,
          'open_section', 'security', 'الانتقال إلى الأمان');

  SELECT * INTO r FROM public.notifications WHERE title = 'عنوان محايد' LIMIT 1;
  IF r.action_target <> 'security' OR r.action_label <> 'الانتقال إلى الأمان' THEN
    RAISE EXCEPTION 'FAIL J4: الاشتقاق داس على قيمة صريحة';
  END IF;
  RAISE NOTICE 'PASS J4: المُرسِل يستطيع تحديد الإجراء صراحةً';
END $$;

\echo 'ALL HELP CENTER AND REPORTS MIGRATION TESTS PASSED'
