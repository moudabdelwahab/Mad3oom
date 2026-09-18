-- اختبار تنفيذي لـmigrations/043_blog.sql على Postgres حقيقي.
--
-- الادعاءات التي لا يثبتها إلا محرّك فعلي:
--   • الزائر المجهول يرى المنشور وحده — لا مسودّة ولا مؤرشف ولا مقالًا مجدولًا
--   • الطاقم (لوحة الإدارة / لوحة المالك) يرى الكل ويكتب
--   • العميل ومالك الشركة لا يكتبان سطرًا، والمالك **خارج واجهته** كذلك
--   • المحفّز يحسب زمن القراءة ويوحّد الوسوم ويثبّت تاريخ أول نشر
--   • قيد الـslug يرفض ما يكسر المسار، ويقبل العربي
--   • البحث والمقالات ذات الصلة محكومة بـRLS لا بمنطق مكتوب مرتين
--   • عدّاد المشاهدات لا يتحرك لمقال غير منشور
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE auth.users (id uuid PRIMARY KEY);

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

CREATE TABLE public.profiles (
  id        uuid PRIMARY KEY REFERENCES auth.users(id),
  email     text,
  full_name text,
  role      text NOT NULL DEFAULT 'user'
);

-- ════════════════════════════════════════════════════════════════════════════
-- مرايا سلطة المنصة (038/040) بالقدر الذي يحتاجه هذا الترحيل.
--
-- ليست إعادة كتابة للسلطة بل **نسخ مطابق** لتعريفاتها المنشورة، لأن سَحب
-- سلسلة الترحيلات 024→035→038→040 كاملةً إلى هذا الملف كان سيجعل فشل أيٍّ
-- منها يظهر كفشل في المدوّنة. الغرض هنا اختبار 043 وحده مقابل عقد
-- is_platform_staff كما هو، لا اختبار السلطة نفسها — لها ملفاتها.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE public.platform_authority (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id),
  level   text NOT NULL CHECK (level IN ('owner', 'elevated_admin'))
);

CREATE TABLE public.owner_context_state (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id),
  context    text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION public.is_platform_owner()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.platform_authority a
      JOIN public.profiles p ON p.id = a.user_id
     WHERE a.user_id = auth.uid() AND a.level = 'owner' AND p.role = 'platform_owner');
$$;

CREATE OR REPLACE FUNCTION public.active_context()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT s.context FROM public.owner_context_state s
   WHERE s.user_id = auth.uid() AND s.expires_at > now();
$$;

CREATE OR REPLACE FUNCTION public.context_allows(p_context text, p_capability text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(CASE p_capability
    WHEN 'owner_only' THEN p_context = 'owner'
    WHEN 'admin'      THEN p_context IN ('owner', 'admin')
    WHEN 'staff'      THEN p_context IN ('owner', 'admin')
    WHEN 'customer'   THEN p_context IN ('owner', 'customer')
    ELSE false
  END, false);
$$;

CREATE OR REPLACE FUNCTION public.owner_capability(p_capability text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT coalesce(public.is_platform_owner()
                  AND public.context_allows(public.active_context(), p_capability), false);
$$;

CREATE OR REPLACE FUNCTION public.is_platform_staff()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p
                  WHERE p.id = auth.uid() AND p.role IN ('admin', 'support'))
      OR public.owner_capability('staff');
$$;

-- ── الحسابات ──────────────────────────────────────────────────────────────
\set owner_id    'aaaaaaaa-0000-4000-8000-000000000001'
\set admin_id    'aaaaaaaa-0000-4000-8000-000000000002'
\set support_id  'aaaaaaaa-0000-4000-8000-000000000003'
\set customer_id 'aaaaaaaa-0000-4000-8000-000000000004'
\set company_id  'aaaaaaaa-0000-4000-8000-000000000005'

INSERT INTO auth.users (id) VALUES
  (:'owner_id'::uuid), (:'admin_id'::uuid), (:'support_id'::uuid),
  (:'customer_id'::uuid), (:'company_id'::uuid);

INSERT INTO public.profiles (id, email, full_name, role) VALUES
  (:'owner_id'::uuid,    'owner@mad3oom.com', 'مالك المنصة', 'platform_owner'),
  (:'admin_id'::uuid,    'admin@mad3oom.com', 'مدير',        'admin'),
  (:'support_id'::uuid,  'sup@mad3oom.com',   'دعم',         'support'),
  (:'customer_id'::uuid, 'c@example.com',     'عميل',        'user'),
  (:'company_id'::uuid,  'co@example.com',    'مالك شركة',   'company_admin');

INSERT INTO public.platform_authority (user_id, level) VALUES (:'owner_id'::uuid, 'owner');

-- الأدوار على مستوى العنقود فتبقى موجودة بين ملفات الاختبار
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO authenticated, anon;
GRANT SELECT ON public.profiles TO authenticated;

-- ── الترحيل تحت الاختبار ──────────────────────────────────────────────────
\echo '--- applying migrations/043 ---'
\i migrations/043_blog.sql

-- ── مقالات الاختبار ───────────────────────────────────────────────────────
\set cat_wa 'whatsapp-api'

INSERT INTO public.blog_posts
  (slug, title, subtitle, excerpt, content, status, tags, category_id, author_id, author_name)
VALUES
  ('دليل-قوالب-واتساب', 'دليل قوالب واتساب', 'من الإنشاء إلى الاعتماد',
   'كل ما تحتاجه لاعتماد قالب من أول مرة.',
   repeat('كلمة ', 400),
   'published', ARRAY['واتساب', ' واتساب ', 'قوالب'],
   (SELECT id FROM public.blog_categories WHERE slug = :'cat_wa'),
   :'admin_id'::uuid, 'فريق مدعوم'),

  ('مسودة-قيد-الكتابة', 'مسودّة قيد الكتابة', NULL, NULL,
   'محتوى غير جاهز للنشر بعد.', 'draft', ARRAY['واتساب'],
   (SELECT id FROM public.blog_categories WHERE slug = :'cat_wa'),
   :'admin_id'::uuid, 'فريق مدعوم'),

  ('مقال-مؤرشف', 'مقال مؤرشف', NULL, NULL,
   'محتوى قديم أُخرج من الفهرس.', 'archived', '{}',
   NULL, :'admin_id'::uuid, 'فريق مدعوم');

-- مقال مجدول: منشور، لكن موعده لم يحن
INSERT INTO public.blog_posts (slug, title, content, status, published_at, author_name)
VALUES ('اعلان-قادم', 'إعلان قادم', 'نعلن قريبًا عن تحديث كبير.', 'published',
        now() + interval '7 days', 'فريق مدعوم');

-- مقال ثانٍ في نفس التصنيف — لاختبار «ذات صلة»
INSERT INTO public.blog_posts (slug, title, excerpt, content, status, tags, category_id, author_name)
VALUES ('جودة-الرقم-في-واتساب', 'جودة الرقم في واتساب', 'كيف تحافظ على تقييم أخضر.',
        'التقييم يتأثر بالبلاغات وبمعدل الحظر.', 'published', ARRAY['واتساب', 'جودة'],
        (SELECT id FROM public.blog_categories WHERE slug = :'cat_wa'), 'فريق مدعوم');


-- ============================================================================
-- A) من يقرأ ماذا
-- ============================================================================
DO $$
DECLARE v_count integer;
BEGIN
  SET LOCAL ROLE anon;

  SELECT count(*) INTO v_count FROM public.blog_posts;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'FAIL A1: الزائر يرى % مقالًا بدل 2 (المنشوران الحاليان)', v_count;
  END IF;
  RAISE NOTICE 'PASS A1: الزائر المجهول يرى المنشور الحالي وحده';

  SELECT count(*) INTO v_count FROM public.blog_posts WHERE slug = 'مسودة-قيد-الكتابة';
  IF v_count <> 0 THEN RAISE EXCEPTION 'FAIL A2: المسودّة ظهرت للزائر'; END IF;
  RAISE NOTICE 'PASS A2: المسودّة محجوبة عن الزائر';

  SELECT count(*) INTO v_count FROM public.blog_posts WHERE slug = 'مقال-مؤرشف';
  IF v_count <> 0 THEN RAISE EXCEPTION 'FAIL A3: المؤرشف ظهر للزائر'; END IF;
  RAISE NOTICE 'PASS A3: المؤرشف محجوب عن الزائر';

  SELECT count(*) INTO v_count FROM public.blog_posts WHERE slug = 'اعلان-قادم';
  IF v_count <> 0 THEN RAISE EXCEPTION 'FAIL A4: المقال المجدول ظهر قبل موعده'; END IF;
  RAISE NOTICE 'PASS A4: الجدولة تعمل — المقال المستقبلي محجوب حتى موعده';

  RESET ROLE;
END $$;

DO $$
DECLARE v_count integer;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000002', true);

  SELECT count(*) INTO v_count FROM public.blog_posts;
  IF v_count <> 5 THEN RAISE EXCEPTION 'FAIL A5: الأدمن يرى % بدل 5', v_count; END IF;
  RAISE NOTICE 'PASS A5: الأدمن يرى المسودّات والمؤرشف والمجدول';

  RESET ROLE;
END $$;

-- المالك داخل واجهته يرى كما يرى الأدمن؛ وخارجها لا يرى إلا ما يراه الزائر.
DO $$
DECLARE v_count integer;
BEGIN
  INSERT INTO public.owner_context_state (user_id, context, expires_at)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 'owner', now() + interval '1 hour');

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000001', true);

  SELECT count(*) INTO v_count FROM public.blog_posts;
  IF v_count <> 5 THEN RAISE EXCEPTION 'FAIL A6: المالك في واجهته يرى % بدل 5', v_count; END IF;
  RAISE NOTICE 'PASS A6: المالك داخل واجهته يرى كل المقالات';

  RESET ROLE;
END $$;

DO $$
DECLARE v_count integer;
BEGIN
  UPDATE public.owner_context_state SET context = 'customer'
   WHERE user_id = 'aaaaaaaa-0000-4000-8000-000000000001';

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000001', true);

  SELECT count(*) INTO v_count FROM public.blog_posts;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'FAIL A7: المالك في واجهة العميل يرى % بدل 2', v_count;
  END IF;
  RAISE NOTICE 'PASS A7: السياق مُرشِّح — المالك خارج واجهته يرى ما يراه الزائر';

  RESET ROLE;
END $$;


-- ============================================================================
-- B) من يكتب — «لوحة الإدارة أو لوحة المالك فقط»
-- ============================================================================
DO $$
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000004', true);

  BEGIN
    INSERT INTO public.blog_posts (slug, title, content) VALUES ('عميل-يكتب', 'عميل', 'نص');
    RAISE EXCEPTION 'FAIL B1: العميل كتب مقالًا في المدوّنة';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS B1: العميل مرفوض بـRLS';
  END;

  RESET ROLE;
END $$;

DO $$
DECLARE v_rows integer;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000005', true);

  BEGIN
    INSERT INTO public.blog_posts (slug, title, content) VALUES ('شركة-تكتب', 'شركة', 'نص');
    RAISE EXCEPTION 'FAIL B2: مالك شركة كتب مقالًا في مدوّنة المنصة';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS B2: دور الشركة لا يمنح الكتابة';
  END;

  -- والتعديل كذلك: صفر صفوف متأثّرة لأن USING لا تطابق شيئًا
  UPDATE public.blog_posts SET title = 'اختطاف' WHERE slug = 'دليل-قوالب-واتساب';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN RAISE EXCEPTION 'FAIL B3: مالك شركة عدّل مقالًا'; END IF;
  RAISE NOTICE 'PASS B3: التعديل من خارج الطاقم لا يطال صفًّا';

  RESET ROLE;
END $$;

-- المالك في واجهة العميل: يقرأ كزائر، ولا يكتب البتة
DO $$
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000001', true);

  BEGIN
    INSERT INTO public.blog_posts (slug, title, content) VALUES ('مالك-خارج-واجهته', 'مالك', 'نص');
    RAISE EXCEPTION 'FAIL B4: المالك كتب من واجهة العميل';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS B4: المالك خارج واجهته لا يكتب — السياق مُرشِّح لا مصدر';
  END;

  RESET ROLE;
END $$;

DO $$
DECLARE v_rows integer;
BEGIN
  -- عودة المالك إلى واجهته
  UPDATE public.owner_context_state SET context = 'owner'
   WHERE user_id = 'aaaaaaaa-0000-4000-8000-000000000001';

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000001', true);

  INSERT INTO public.blog_posts (slug, title, content, status)
  VALUES ('مقال-المالك', 'مقال من لوحة المالك', 'نص كافٍ للنشر.', 'published');
  RAISE NOTICE 'PASS B5: المالك يكتب من لوحة المالك';

  RESET ROLE;

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000003', true);
  UPDATE public.blog_posts SET subtitle = 'راجعه الدعم' WHERE slug = 'مقال-المالك';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'FAIL B6: الدعم لم يعدّل من لوحة الإدارة'; END IF;
  RAISE NOTICE 'PASS B6: الدعم يحرّر من لوحة الإدارة';

  DELETE FROM public.blog_posts WHERE slug = 'مقال-المالك';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'FAIL B7: الحذف من الطاقم لم ينفَّذ'; END IF;
  RAISE NOTICE 'PASS B7: الطاقم يحذف';

  RESET ROLE;
END $$;


-- ============================================================================
-- C) المحفّز — ما لا يُترك للواجهة
-- ============================================================================
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.blog_posts WHERE slug = 'دليل-قوالب-واتساب';

  -- 400 كلمة ÷ 200 = دقيقتان
  IF r.reading_minutes <> 2 THEN
    RAISE EXCEPTION 'FAIL C1: زمن القراءة % بدل 2 (عدد الكلمات %)', r.reading_minutes, r.word_count;
  END IF;
  RAISE NOTICE 'PASS C1: زمن القراءة محسوب في القاعدة';

  IF r.tags <> ARRAY['قوالب', 'واتساب'] THEN
    RAISE EXCEPTION 'FAIL C2: الوسوم لم تُوحَّد: %', r.tags;
  END IF;
  RAISE NOTICE 'PASS C2: الوسوم مُنظَّفة ومُزال تكرارها ومرتَّبة';

  IF r.published_at IS NULL THEN RAISE EXCEPTION 'FAIL C3: تاريخ النشر لم يُضبط'; END IF;
  RAISE NOTICE 'PASS C3: تاريخ النشر يُضبط عند أول نشر';
END $$;

DO $$
DECLARE v_first timestamptz; v_after timestamptz; v_min integer;
BEGIN
  SELECT published_at INTO v_first FROM public.blog_posts WHERE slug = 'دليل-قوالب-واتساب';

  -- أرشفة ثم إعادة نشر: التاريخ لا يتحرك، والمقال لا يقفز لأعلى الفهرس
  UPDATE public.blog_posts SET status = 'archived' WHERE slug = 'دليل-قوالب-واتساب';
  UPDATE public.blog_posts SET status = 'published' WHERE slug = 'دليل-قوالب-واتساب';

  SELECT published_at INTO v_after FROM public.blog_posts WHERE slug = 'دليل-قوالب-واتساب';
  IF v_after IS DISTINCT FROM v_first THEN
    RAISE EXCEPTION 'FAIL C4: إعادة النشر غيّرت تاريخ المقال (% → %)', v_first, v_after;
  END IF;
  RAISE NOTICE 'PASS C4: تاريخ أول نشر ثابت بعده';

  -- تعديل المتن يعيد حساب زمن القراءة
  UPDATE public.blog_posts SET content = repeat('كلمة ', 1000) WHERE slug = 'دليل-قوالب-واتساب';
  SELECT reading_minutes INTO v_min FROM public.blog_posts WHERE slug = 'دليل-قوالب-واتساب';
  IF v_min <> 5 THEN RAISE EXCEPTION 'FAIL C5: زمن القراءة بعد التعديل % بدل 5', v_min; END IF;
  RAISE NOTICE 'PASS C5: التعديل يعيد الحساب';
END $$;

-- قيد الـslug: يقبل العربي، ويرفض ما يكسر المسار
DO $$
BEGIN
  BEGIN
    INSERT INTO public.blog_posts (slug, title, content) VALUES ('فيه فراغ', 'x', 'y');
    RAISE EXCEPTION 'FAIL C6: slug بفراغ قُبِل';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS C6: الفراغ مرفوض في الـslug';
  END;

  BEGIN
    INSERT INTO public.blog_posts (slug, title, content) VALUES ('a/b', 'x', 'y');
    RAISE EXCEPTION 'FAIL C7: slug بشرطة مائلة قُبِل';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS C7: الشرطة المائلة مرفوضة';
  END;

  BEGIN
    INSERT INTO public.blog_posts (slug, title, content) VALUES ('Upper-Case', 'x', 'y');
    RAISE EXCEPTION 'FAIL C8: slug بأحرف كبيرة قُبِل';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS C8: الـslug يُحفظ بحالة واحدة';
  END;

  BEGIN
    INSERT INTO public.blog_posts (slug, title, content) VALUES ('دليل-قوالب-واتساب', 'x', 'y');
    RAISE EXCEPTION 'FAIL C9: slug مكرر قُبِل';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS C9: الـslug فريد';
  END;
END $$;


-- ============================================================================
-- D) البحث والفهرس — محكومان بـRLS لا بمنطق ثانٍ
-- ============================================================================
DO $$
DECLARE v_count integer; v_slug text; v_total bigint;
BEGIN
  SET LOCAL ROLE anon;

  SELECT count(*) INTO v_count FROM public.blog_feed('مسودّة', NULL, NULL, NULL, 20, 0);
  IF v_count <> 0 THEN RAISE EXCEPTION 'FAIL D1: البحث كشف مسودّة للزائر'; END IF;
  RAISE NOTICE 'PASS D1: البحث لا يكشف المسودّات';

  SELECT f.slug INTO v_slug FROM public.blog_feed('قوالب', NULL, NULL, NULL, 20, 0) f LIMIT 1;
  IF v_slug IS DISTINCT FROM 'دليل-قوالب-واتساب' THEN
    RAISE EXCEPTION 'FAIL D2: ترتيب الصلة خاطئ — جاء %', v_slug;
  END IF;
  RAISE NOTICE 'PASS D2: العنوان أقوى من المتن في ترتيب الصلة';

  SELECT count(*) INTO v_count FROM public.blog_feed(NULL, 'whatsapp-api', NULL, NULL, 20, 0);
  IF v_count <> 2 THEN RAISE EXCEPTION 'FAIL D3: تصفية التصنيف رجّعت %', v_count; END IF;
  RAISE NOTICE 'PASS D3: التصفية بالتصنيف تعمل';

  SELECT count(*) INTO v_count FROM public.blog_feed(NULL, NULL, 'جودة', NULL, 20, 0);
  IF v_count <> 1 THEN RAISE EXCEPTION 'FAIL D4: تصفية الوسم رجّعت %', v_count; END IF;
  RAISE NOTICE 'PASS D4: التصفية بالوسم تعمل';

  -- العدّ الكلي يأتي مع الصفحة الأولى، فلا رحلة شبكة ثانية للترقيم
  SELECT f.total_count INTO v_total FROM public.blog_feed(NULL, NULL, NULL, NULL, 1, 0) f;
  IF v_total <> 2 THEN RAISE EXCEPTION 'FAIL D5: total_count = % بدل 2', v_total; END IF;
  RAISE NOTICE 'PASS D5: العدّ الكلي يُحسب مع الصفحة نفسها';

  RESET ROLE;
END $$;

DO $$
DECLARE v_count integer;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000002', true);

  SELECT count(*) INTO v_count FROM public.blog_feed('مسودّة', NULL, NULL, NULL, 20, 0);
  IF v_count <> 1 THEN RAISE EXCEPTION 'FAIL D6: الأدمن لم يجد مسودّته في البحث'; END IF;
  RAISE NOTICE 'PASS D6: نفس الدالة تخدم اللوحة — الفارق RLS لا كود ثانٍ';

  RESET ROLE;
END $$;

-- عدّاد التصنيفات يتبع ما يراه المنادي
DO $$
DECLARE v_public bigint; v_staff bigint;
BEGIN
  SET LOCAL ROLE anon;
  SELECT c.post_count INTO v_public
    FROM public.blog_categories_with_counts() c WHERE c.slug = 'whatsapp-api';
  RESET ROLE;

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000002', true);
  SELECT c.post_count INTO v_staff
    FROM public.blog_categories_with_counts() c WHERE c.slug = 'whatsapp-api';
  RESET ROLE;

  IF v_public <> 2 OR v_staff <> 3 THEN
    RAISE EXCEPTION 'FAIL D7: عدّاد التصنيف عام=% طاقم=% (المتوقع 2 و3)', v_public, v_staff;
  END IF;
  RAISE NOTICE 'PASS D7: العدّاد صادق لكل قارئ من مصدر واحد';
END $$;

-- المقالات ذات الصلة: نفس التصنيف، بلا المقال نفسه، وبلا مسودّة
DO $$
DECLARE v_count integer; v_slug text; v_self integer;
BEGIN
  SET LOCAL ROLE anon;

  SELECT count(*) INTO v_count FROM public.blog_related('دليل-قوالب-واتساب', 5);
  IF v_count <> 1 THEN RAISE EXCEPTION 'FAIL D8: ذات الصلة رجّعت % بدل 1', v_count; END IF;

  SELECT r.slug INTO v_slug FROM public.blog_related('دليل-قوالب-واتساب', 5) r LIMIT 1;
  IF v_slug <> 'جودة-الرقم-في-واتساب' THEN
    RAISE EXCEPTION 'FAIL D9: ذات الصلة اقترحت %', v_slug;
  END IF;

  SELECT count(*) INTO v_self FROM public.blog_related('دليل-قوالب-واتساب', 5) r
   WHERE r.slug = 'دليل-قوالب-واتساب';
  IF v_self <> 0 THEN RAISE EXCEPTION 'FAIL D10: المقال اقترح نفسه'; END IF;

  RAISE NOTICE 'PASS D8-D10: ذات الصلة بلا مسودّات وبلا المقال نفسه';

  RESET ROLE;
END $$;


-- ============================================================================
-- E) عدّاد المشاهدات — محصور في عمود واحد وفي المنشور وحده
-- ============================================================================
DO $$
DECLARE v_before integer; v_after integer;
BEGIN
  SELECT view_count INTO v_before FROM public.blog_posts WHERE slug = 'دليل-قوالب-واتساب';

  SET LOCAL ROLE anon;
  PERFORM public.increment_blog_view('دليل-قوالب-واتساب');
  RESET ROLE;

  SELECT view_count INTO v_after FROM public.blog_posts WHERE slug = 'دليل-قوالب-واتساب';
  IF v_after <> v_before + 1 THEN
    RAISE EXCEPTION 'FAIL E1: العدّاد % → % (المتوقع +1)', v_before, v_after;
  END IF;
  RAISE NOTICE 'PASS E1: الزائر المجهول يزيد عدّاد المقال المنشور';

  SELECT view_count INTO v_before FROM public.blog_posts WHERE slug = 'مسودة-قيد-الكتابة';
  SET LOCAL ROLE anon;
  PERFORM public.increment_blog_view('مسودة-قيد-الكتابة');
  PERFORM public.increment_blog_view('اعلان-قادم');
  RESET ROLE;

  SELECT view_count INTO v_after FROM public.blog_posts WHERE slug = 'مسودة-قيد-الكتابة';
  IF v_after <> v_before THEN RAISE EXCEPTION 'FAIL E2: عدّاد المسودّة تحرّك'; END IF;

  SELECT view_count INTO v_after FROM public.blog_posts WHERE slug = 'اعلان-قادم';
  IF v_after <> 0 THEN RAISE EXCEPTION 'FAIL E3: عدّاد المقال المجدول تحرّك'; END IF;
  RAISE NOTICE 'PASS E2-E3: العدّاد لا يتحرك لغير المنشور الحالي';
END $$;

-- الكتابة المباشرة على العمود تبقى ممنوعة على غير الطاقم
DO $$
DECLARE v_rows integer;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000004', true);
  UPDATE public.blog_posts SET view_count = 999999 WHERE slug = 'دليل-قوالب-واتساب';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN RAISE EXCEPTION 'FAIL E4: العميل كتب في عدّاد المشاهدات'; END IF;
  RAISE NOTICE 'PASS E4: الدالة هي المسار الوحيد للعدّاد';
  RESET ROLE;
END $$;


-- ============================================================================
-- F) التصنيفات — بذرة حاضرة، والقراءة العامة على النشط وحده
-- ============================================================================
DO $$
DECLARE v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.blog_categories;
  IF v_count < 6 THEN RAISE EXCEPTION 'FAIL F1: البذرة زرعت % تصنيفًا', v_count; END IF;
  RAISE NOTICE 'PASS F1: التصنيفات مزروعة';

  UPDATE public.blog_categories SET is_active = false WHERE slug = 'growth-playbooks';

  SET LOCAL ROLE anon;
  SELECT count(*) INTO v_count FROM public.blog_categories WHERE slug = 'growth-playbooks';
  IF v_count <> 0 THEN RAISE EXCEPTION 'FAIL F2: تصنيف معطَّل ظهر للزائر'; END IF;
  RESET ROLE;
  RAISE NOTICE 'PASS F2: التصنيف المعطَّل محجوب عن الزائر';

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000004', true);
  BEGIN
    INSERT INTO public.blog_categories (slug, name) VALUES ('عميل-تصنيف', 'تصنيف');
    RAISE EXCEPTION 'FAIL F3: العميل أنشأ تصنيفًا';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS F3: التصنيفات كذلك للطاقم وحده';
  END;
  RESET ROLE;
END $$;

\echo 'ALL BLOG MIGRATION TESTS PASSED'
