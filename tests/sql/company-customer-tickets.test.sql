-- اختبار تنفيذي لـ migrations/033_company_customer_ticket_separation.sql
--
-- يثبّت الفصل بين مساري التذاكر في لوحة الشركة، ويغلق باب التسرّب الذي
-- ثبت على الإنتاج (كل ردّ غير داخلي كان مقروءًا لأي حساب مسجَّل).
--
-- ملاحظة على البنية: جدولا tickets و ticket_replies أقدم من مجلد migrations
-- (أُنشئا من واجهة Supabase)، فنعيد بناء الحد الأدنى منهما هنا بنفس الأعمدة
-- والسياسات كما هي على الإنتاج قبل الترحيل، ثم نطبّق الترحيل فوقها. كده
-- الاختبار بيقيس الفرق الذي أحدثه الترحيل فعلاً، لا مجرد الحالة النهائية.
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true),'')::uuid; $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
END $$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, email text, full_name text,
  role text NOT NULL DEFAULT 'user', super_user_id uuid,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE public.tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id),
  title text NOT NULL, description text NOT NULL,
  status text DEFAULT 'open', ticket_number bigserial,
  archived_by_customer boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE public.ticket_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id),
  message text NOT NULL,
  is_internal boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.is_main_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select exists (select 1 from public.profiles where id = auth.uid() and email = 'support@mad3oom.online');
$$;

-- ── سياسات ما قبل الترحيل، منسوخة كما هي من الإنتاج ────────────────────────
ALTER TABLE public.profiles       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tickets        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_replies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles_select_policy" ON public.profiles FOR SELECT
  USING ((auth.uid() = id) OR public.is_main_admin() OR (super_user_id = auth.uid()));

CREATE POLICY "tickets_select_policy" ON public.tickets FOR SELECT
  USING (
    (user_id = auth.uid())
    OR public.is_main_admin()
    OR ((select p.role from public.profiles p where p.id = auth.uid()) = 'admin')
    OR (user_id IN (select p.id from public.profiles p where p.super_user_id = auth.uid()))
  );

CREATE POLICY "Users can create tickets" ON public.tickets FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- ★ السياسة المكسورة: NOT is_internal بديلاً عن الملكية، لا شرطًا فوقها
CREATE POLICY "ticket_replies_select_policy" ON public.ticket_replies FOR SELECT
  USING (
    (NOT is_internal)
    OR public.is_main_admin()
    OR ((select p.role from public.profiles p where p.id = auth.uid()) = 'admin')
    OR (user_id = auth.uid())
    OR EXISTS (select 1 from public.tickets t join public.profiles p on t.user_id = p.id
                where t.id = ticket_replies.ticket_id
                  and (t.user_id = auth.uid() or p.super_user_id = auth.uid()))
  );

-- ★ الإدراج بلا شرط user_id، وبلا فرع لصاحب الشركة
CREATE POLICY "Users can add replies to their tickets" ON public.ticket_replies FOR INSERT
  WITH CHECK (
    EXISTS (select 1 from public.tickets t
             where t.id = ticket_replies.ticket_id
               and (t.user_id = auth.uid()
                    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')))
  );

CREATE POLICY "Support can add replies" ON public.ticket_replies FOR INSERT
  WITH CHECK (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'support'));

GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- ── البيانات: شركتان، لكلٍّ مالك وعميل، وحساب طرف ثالث ─────────────────────
INSERT INTO public.profiles (id,email,full_name,role,super_user_id) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','owner-a@t.local','مالك أ','super_user',NULL),
  ('a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1','cust-a1@t.local','عميل أ-1','customer','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2','cust-a2@t.local','عميل أ-2','customer','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','owner-b@t.local','مالك ب','super_user',NULL),
  ('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1','cust-b1@t.local','عميل ب-1','customer','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','loner@t.local','حساب مستقل','user',NULL);

INSERT INTO public.tickets (id,user_id,title,description) VALUES
  ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','شركة أ ← مدعوم','مسار ①'),
  ('22222222-2222-4222-8222-222222222222','a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1','عميل أ-1 ← شركة أ','مسار ②'),
  ('33333333-3333-4333-8333-333333333333','a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2','عميل أ-2 ← شركة أ','مسار ②'),
  ('44444444-4444-4444-8444-444444444444','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','شركة ب ← مدعوم','مسار ① لشركة أخرى'),
  ('55555555-5555-4555-8555-555555555555','b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1','عميل ب-1 ← شركة ب','مسار ② لشركة أخرى');

INSERT INTO public.ticket_replies (ticket_id,user_id,message,is_internal) VALUES
  ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ردّ شركة أ',false),
  ('22222222-2222-4222-8222-222222222222','a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1','ردّ عميل أ-1',false),
  ('44444444-4444-4444-8444-444444444444','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','ردّ شركة ب — سرّي تجاريًا',false),
  ('55555555-5555-4555-8555-555555555555','b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1','ردّ عميل ب-1',false),
  ('11111111-1111-4111-8111-111111111111','cccccccc-cccc-4ccc-8ccc-cccccccccccc','ملاحظة داخلية',true);

\echo ''
\echo '=== 0) إثبات الخلل قبل الترحيل (لولا هذا لما كان للإصلاح معنى) ==='
SET ROLE authenticated;
SET request.jwt.claim.sub = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
DO $$
DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM public.ticket_replies;
  IF n < 4 THEN
    RAISE EXCEPTION 'FAIL 0: الحالة الأولية لا تعيد إنتاج التسرّب (رأى % ردًّا)', n;
  END IF;
  RAISE NOTICE 'PASS 0: قبل الترحيل، حساب لا يملك أي تذكرة يقرأ % ردًّا عامًا', n;
END $$;
RESET ROLE;
RESET request.jwt.claim.sub;

\echo ''
\echo '=== تطبيق الترحيل 033 ==='
\i migrations/033_company_customer_ticket_separation.sql

\echo ''
\echo '=== 1) الشركة تفتح تذكرة إلى مدعوم وتراها ==='
SET ROLE authenticated;
SET request.jwt.claim.sub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
DO $$
DECLARE v_id uuid; BEGIN
  INSERT INTO public.tickets (user_id,title,description)
  VALUES (auth.uid(),'تذكرة جديدة إلى مدعوم','من لوحة الشركة') RETURNING id INTO v_id;

  IF NOT EXISTS (SELECT 1 FROM public.tickets WHERE id = v_id AND user_id = auth.uid()) THEN
    RAISE EXCEPTION 'FAIL 1: الشركة لا ترى التذكرة التي فتحتها';
  END IF;

  INSERT INTO public.ticket_replies (ticket_id,user_id,message)
  VALUES (v_id, auth.uid(), 'متابعة من الشركة');

  RAISE NOTICE 'PASS 1: الشركة تفتح تذكرة إلى مدعوم وتتابعها وتردّ عليها';
END $$;

\echo ''
\echo '=== 2) الشركة ترى تذاكر عملائها وتردّ عليها ==='
DO $$
DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM public.tickets
   WHERE user_id IN ('a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1','a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2');
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL 2A: رأت % من تذاكر عملائها بدل 2', n; END IF;

  -- الردّ على العميل — كان مرفوضًا قبل الترحيل
  INSERT INTO public.ticket_replies (ticket_id,user_id,message)
  VALUES ('22222222-2222-4222-8222-222222222222', auth.uid(), 'ردّ الشركة على عميلها');

  IF NOT EXISTS (SELECT 1 FROM public.ticket_replies
                  WHERE ticket_id='22222222-2222-4222-8222-222222222222' AND user_id=auth.uid()) THEN
    RAISE EXCEPTION 'FAIL 2B: الردّ لم يُحفظ';
  END IF;
  RAISE NOTICE 'PASS 2: الشركة تتابع تذاكر عملائها وتردّ عليهم';
END $$;

\echo ''
\echo '=== 3) الشركة لا ترى تذاكر شركة أخرى ولا عملاءها ==='
DO $$
DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM public.tickets
   WHERE user_id IN ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1');
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 3A: تسرّبت % تذكرة من شركة أخرى', n; END IF;

  SELECT count(*) INTO n FROM public.ticket_replies r
   WHERE r.ticket_id IN ('44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555');
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 3B: تسرّب % ردًّا من شركة أخرى', n; END IF;

  RAISE NOTICE 'PASS 3: عزل كامل بين الشركتين — لا تذاكر ولا ردود';
END $$;

\echo ''
\echo '=== 5) تذكرة الشركة ↔ مدعوم لا تظهر لعملاء الشركة ==='
SET request.jwt.claim.sub = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
DO $$
DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM public.tickets
   WHERE id = '11111111-1111-4111-8111-111111111111';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 5A: العميل يرى تذكرة شركته مع مدعوم'; END IF;

  SELECT count(*) INTO n FROM public.ticket_replies
   WHERE ticket_id = '11111111-1111-4111-8111-111111111111';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 5B: العميل يقرأ ردود تذكرة شركته مع مدعوم'; END IF;

  RAISE NOTICE 'PASS 5: مسار الشركة مع مدعوم محجوب عن عملائها';
END $$;

\echo ''
\echo '=== 4) العميل لا يرى تذاكر عميل آخر — ولو في نفس الشركة ==='
DO $$
DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM public.tickets
   WHERE id = '33333333-3333-4333-8333-333333333333';   -- عميل أ-2، نفس الشركة
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 4A: العميل يرى تذكرة عميل آخر في شركته'; END IF;

  SELECT count(*) INTO n FROM public.tickets
   WHERE id = '55555555-5555-4555-8555-555555555555';   -- عميل شركة أخرى
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 4B: العميل يرى تذكرة عميل شركة أخرى'; END IF;

  SELECT count(*) INTO n FROM public.tickets;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 4C: العميل يرى % تذكرة بدل تذكرته وحدها', n; END IF;

  RAISE NOTICE 'PASS 4: العميل يرى تذكرته وحدها';
END $$;

\echo ''
\echo '=== 6) ردّ الشركة لا يحوّل تذكرة العميل إلى تذكرة الشركة ==='
SET request.jwt.claim.sub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
DO $$
DECLARE v_owner uuid; v_denied boolean := false; BEGIN
  SELECT user_id INTO v_owner FROM public.tickets WHERE id='22222222-2222-4222-8222-222222222222';
  IF v_owner <> 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1' THEN
    RAISE EXCEPTION 'FAIL 6A: مالك التذكرة تغيّر بعد ردّ الشركة';
  END IF;

  -- ولا تملك الشركة أصلًا تعديل التذكرة: لا UPDATE ممنوح لها عمدًا
  BEGIN
    UPDATE public.tickets SET user_id = auth.uid()
     WHERE id = '22222222-2222-4222-8222-222222222222';
    IF NOT FOUND THEN v_denied := true; END IF;
  EXCEPTION WHEN insufficient_privilege OR others THEN v_denied := true;
  END;

  IF NOT v_denied THEN
    RAISE EXCEPTION 'FAIL 6B: الشركة استطاعت تحويل تذكرة عميلها إلى تذكرتها';
  END IF;

  RAISE NOTICE 'PASS 6: مسار «العميل ↔ الشركة» لا يتحوّل إلى «الشركة ↔ مدعوم»';
END $$;

\echo ''
\echo '=== 7) لا IDOR ولا تجاوز صلاحيات ==='
SET request.jwt.claim.sub = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
DO $$
DECLARE n int; v_blocked boolean := false; BEGIN
  -- (أ) التسرّب الذي أثبتناه في الخطوة 0 صار مغلقًا
  SELECT count(*) INTO n FROM public.ticket_replies;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL 7A: حساب بلا تذاكر ما زال يقرأ % ردًّا', n;
  END IF;

  SELECT count(*) INTO n FROM public.tickets;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 7B: حساب بلا تذاكر يرى % تذكرة', n; END IF;

  -- (ب) لا ردّ على تذكرة ليست في نطاقه، حتى بمعرفة معرّفها كاملًا
  BEGIN
    INSERT INTO public.ticket_replies (ticket_id,user_id,message)
    VALUES ('44444444-4444-4444-8444-444444444444', auth.uid(), 'اقتحام');
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN v_blocked := true;
  END;
  IF NOT v_blocked THEN RAISE EXCEPTION 'FAIL 7C: أدرج ردًّا على تذكرة خارج نطاقه'; END IF;

  RAISE NOTICE 'PASS 7: لا قراءة ولا كتابة خارج النطاق (IDOR مغلق)';
END $$;

\echo ''
\echo '=== 7-د) لا انتحال تأليف الردّ ==='
SET request.jwt.claim.sub = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
DO $$
DECLARE v_blocked boolean := false; BEGIN
  BEGIN
    -- تذكرته هو، لكن الردّ منسوب لمالك الشركة
    INSERT INTO public.ticket_replies (ticket_id,user_id,message)
    VALUES ('22222222-2222-4222-8222-222222222222',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ردّ منتحَل');
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN v_blocked := true;
  END;
  IF NOT v_blocked THEN RAISE EXCEPTION 'FAIL 7D: انتحل تأليف ردّ باسم حساب آخر'; END IF;
  RAISE NOTICE 'PASS 7-د: الردّ يُنسَب لمن كتبه فقط';
END $$;

\echo ''
\echo '=== 8) الطاقم يظل يرى كل شيء بما فيه الردود الداخلية ==='
RESET ROLE;
UPDATE public.profiles SET role='admin' WHERE id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
SET ROLE authenticated;
SET request.jwt.claim.sub = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
DO $$
DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM public.ticket_replies WHERE is_internal;
  IF n < 1 THEN RAISE EXCEPTION 'FAIL 8: الأدمن لا يرى الردود الداخلية'; END IF;
  RAISE NOTICE 'PASS 8: الطاقم لم يفقد شيئًا';
END $$;

RESET ROLE;
RESET request.jwt.claim.sub;

\echo ''
\echo 'ALL COMPANY/CUSTOMER TICKET SEPARATION TESTS PASSED'
