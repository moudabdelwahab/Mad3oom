-- ============================================================================
-- اختبار تنفيذي لـ 144: تثبيت ربط الحظر ببوابة الحساب (h04).
--
-- يثبّت الخصائص التي جاء 144 ليوثّقها، كل واحدة تفشل إن انكسرت:
--
--   ① قبل 144 (042 وحده): مستخدم موثَّق الهاتف في القائمة البيضاء لكن
--      `ban_status='permanent'` يمرّ من البوابة — هذه هي فجوة الملفات التي
--      يغلقها 144 (الحي كان مربوطًا منذ h04، والملفات لم تكن).
--   ② بعد 144: المحظور دائمًا → `account_is_active()` = false، ولا يرى
--      صفًا واحدًا في `tickets` من جلسة authenticated حقيقية.
--   ③ رفع الحظر يعيد `true` فورًا؛ وحظر مؤقت منتهي (`ban_until` في الماضي)
--      → `true` (المنطق العادي).
--   ④ `ban_status` بقيم `'none'` و`'active'` وNULL → غير محظور (`true`)؛
--      وحظر مؤقت سارٍ (`ban_until` في المستقبل) → `false`.
--   ⑤ مالك المنصة المعفى غير المحظور ما زال `true` بلا هاتف وبلا كود.
--   ⑥ حالة المالك المحظور افتراضًا (موثَّقة لا خطأ): `NOT is_banned` فوق
--      الإعفاء في الصيغة الحية، فالمالك المحظور → `false` — وهذا هو النمط
--      القائم نفسه في `_inbox_account_active` (058) و`conv_account_active`
--      (067)، وحظر المالك محمي من المنبع بمحفِّز 053.
--   ⑦ إعادة تطبيق 144 آمنة ولا تُضاعف السياسات؛ وملف التراجع يعيد جسم
--      042 (المحظور يمرّ ثانيةً)، وإعادة تطبيق 144 بعده تعيد المنع.
--   ⑧ `my_account_gate()` — ألغاه الترحيل 152 (فرع 'banned'): القسم
--      هنا يثبّت أن المحظور يرى `'banned'` لا `'needs_phone'`، والمصفوفة
--      الكاملة في `tests/sql/account-gate-ban-152.test.sql`.
--
-- يحمّل 042 ثم `is_banned()` (نص 029 حرفيًا) ثم 144 — أي أن الاختبار يمرّ
-- عبر ملف الترحيل نفسه، لا عبر نسخة منسوخة من جسمه.
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true),'')::uuid; $$;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
END $$;
GRANT USAGE ON SCHEMA auth, public, extensions TO authenticated, anon;

-- ── الجداول التي تبني عليها البوابة (كما في account-gate.test.sql) ───────
-- مع عمودي الحظر اللذين تقرأهما is_banned() (029) — وهما الغائبان عن بديل
-- account-gate.test.sql، ولهذا كان فيه صفر ذكر لـ is_banned.
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, email text, full_name text, phone text,
  role text DEFAULT 'user', super_user_id uuid,
  ban_status text, ban_until timestamptz, ban_reason text,
  created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX profiles_phone_unique ON public.profiles (phone) WHERE phone IS NOT NULL;

CREATE TABLE public.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE,
  company_name varchar NOT NULL, company_email text, company_phone text,
  commercial_registration_number text, status text DEFAULT 'active'
);
CREATE TABLE public.waitlist_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, email text NOT NULL,
  phone text, status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(), approved_user_id uuid
);
CREATE TABLE public.advanced_settings (key text PRIMARY KEY, value jsonb);

CREATE TABLE public.tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, title text);
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, title text);

ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY tickets_own ON public.tickets FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY notifications_own ON public.notifications FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tickets, public.notifications TO authenticated;
GRANT SELECT ON public.profiles TO authenticated;

CREATE TABLE public.platform_authority (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  level text NOT NULL);

CREATE OR REPLACE FUNCTION public.is_platform_owner()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.platform_authority a
                  WHERE a.user_id = auth.uid() AND a.level = 'owner'); $$;

CREATE TABLE public.email_lookup_attempts (
  key text, attempted_at timestamptz DEFAULT now());

CREATE OR REPLACE FUNCTION public._check_email_lookup_rate_limit(
  p_key text, p_max int, p_window int)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  INSERT INTO public.email_lookup_attempts (key) VALUES (p_key);
  RETURN true;
END; $$;

-- ── الترحيل تحت الاختبار: 042 أولًا (النسخة القديمة بلا حظر) ─────────────
\i migrations/042_account_gate.sql

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.access_passcodes, public.passcode_redemptions TO authenticated;

-- ── الحسابات ──────────────────────────────────────────────────────────────
-- gate_cutoff() = 2026-09-16. «قديم» = قبلها: في القائمة البيضاء بلا إدخال
-- قائمة انتظار معلَّق/مرفوض، وبهاتف صالح → البوابة مفتوحة ما لم يُحظر.
INSERT INTO public.profiles (id, email, full_name, phone, role, ban_status, ban_until, created_at) VALUES
  ('00000000-0000-0000-0000-0000000000a1','mahmoud@mad3oom.com','المالك',NULL,'platform_owner','none',NULL,'2025-01-01'),
  ('00000000-0000-0000-0000-0000000000b1','old.ok@example.com','عميل قديم برقم','+201000000001','user','none',NULL,'2025-01-01'),
  ('00000000-0000-0000-0000-0000000000b2','old.nophone@example.com','عميل قديم بلا رقم',NULL,'user','none',NULL,'2025-01-01');

INSERT INTO public.platform_authority (user_id, level)
VALUES ('00000000-0000-0000-0000-0000000000a1','owner');

INSERT INTO public.tickets (user_id, title) VALUES
  ('00000000-0000-0000-0000-0000000000b1','تذكرة القديم'),
  ('00000000-0000-0000-0000-0000000000a1','تذكرة المالك');

-- ════════════════════════════════════════════════════════════════════════
-- ① قبل 144: المحظور يمرّ من نسخة 042 — فجوة الملفات المثبتة
-- ════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_active boolean; v_tickets int;
BEGIN
  UPDATE public.profiles SET ban_status = 'permanent', ban_until = NULL
   WHERE id = '00000000-0000-0000-0000-0000000000b1';

  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1', true);
  SET LOCAL ROLE authenticated;
  SELECT public.account_is_active() INTO v_active;
  SELECT count(*) INTO v_tickets FROM public.tickets;
  RESET ROLE;

  IF v_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 1: توقعنا أن 042 وحده يمرّر المحظور، فجاء active=%', v_active;
  END IF;
  RAISE NOTICE 'PASS 1: أُثبتت الفجوة — 042 وحده يمرّر المحظور (active=%, tickets=%)', v_active, v_tickets;
  IF v_tickets <> 1 THEN
    RAISE EXCEPTION 'FAIL 1: المحظور رأى % تذكرة قبل 144 (توقعنا 1)', v_tickets;
  END IF;
END $$;

-- ── is_banned() — نص 029 حرفيًا (029_entitlement_and_points_guard.sql) ──
-- 144 يشترط وجودها قبل التعديل؛ و042 وحده لا يعرّفها، فتُحمَّل هنا كما
-- يعرّفها 029 في بيئة كاملة (الحي: مطابقة حرفيًا).
create or replace function public.is_banned(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce((
    select p.ban_status is not null
       and p.ban_status not in ('none','active')
       and (p.ban_until is null or p.ban_until > now())
      from public.profiles p where p.id = p_user_id
  ), false);
$$;

revoke all on function public.is_banned(uuid) from public, anon;
grant execute on function public.is_banned(uuid) to authenticated;

-- ── الترحيل تحت الاختبار: 144 ─────────────────────────────────────────────
\i migrations/144_wire_is_banned_into_account_gate.sql

-- ════════════════════════════════════════════════════════════════════════
-- ② بعد 144: المحظور دائمًا مغلق — الدالة والصفوف معًا
-- ════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_active boolean; v_tickets int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1', true);
  SET LOCAL ROLE authenticated;
  SELECT public.account_is_active() INTO v_active;
  SELECT count(*) INTO v_tickets FROM public.tickets;
  RESET ROLE;

  IF v_active IS NOT false THEN
    RAISE EXCEPTION 'FAIL 2: المحظور دائمًا ما زال active=% بعد 144', v_active; END IF;
  IF v_tickets <> 0 THEN
    RAISE EXCEPTION 'FAIL 2: المحظور رأى % تذكرة بعد 144', v_tickets; END IF;
  RAISE NOTICE 'PASS 2: المحظور دائمًا مغلق — الدالة false ولا صفوف';
END $$;

-- والكتابة ممنوعة أيضًا، لا القراءة وحدها.
DO $$
DECLARE v_ok boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO public.tickets (user_id, title)
    VALUES ('00000000-0000-0000-0000-0000000000b1','محاولة من محظور');
  EXCEPTION WHEN insufficient_privilege THEN v_ok := true;
  END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL 2B: المحظور استطاع الكتابة بعد 144'; END IF;
  RAISE NOTICE 'PASS 2B: الكتابة محجوبة أيضًا بعد 144';
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- ③ رفع الحظر يعيد true · وحظر مؤقت منتهي يعود للمنطق العادي
-- ════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_active boolean; v_tickets int;
BEGIN
  UPDATE public.profiles SET ban_status = 'none', ban_until = NULL
   WHERE id = '00000000-0000-0000-0000-0000000000b1';

  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1', true);
  SET LOCAL ROLE authenticated;
  SELECT public.account_is_active() INTO v_active;
  SELECT count(*) INTO v_tickets FROM public.tickets;
  RESET ROLE;

  IF v_active IS NOT true THEN
    RAISE EXCEPTION 'FAIL 3: بعد رفع الحظر جاء active=%', v_active; END IF;
  IF v_tickets <> 1 THEN
    RAISE EXCEPTION 'FAIL 3: بعد رفع الحظر رأى % تذكرة (توقعنا 1)', v_tickets; END IF;
  RAISE NOTICE 'PASS 3: رفع الحظر يعيد الحساب فورًا';
END $$;

DO $$
DECLARE v_active boolean;
BEGIN
  UPDATE public.profiles SET ban_status = 'temporary', ban_until = now() - interval '1 day'
   WHERE id = '00000000-0000-0000-0000-0000000000b1';

  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1', true);
  SET LOCAL ROLE authenticated;
  SELECT public.account_is_active() INTO v_active;
  RESET ROLE;

  IF v_active IS NOT true THEN
    RAISE EXCEPTION 'FAIL 3B: الحظر المؤقت المنتهي ما زال يغلق (active=%)', v_active; END IF;
  RAISE NOTICE 'PASS 3B: حظر مؤقت منتهي → المنطق العادي (نشط)';
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- ④ قيم ban_status غير الحاظرة: 'none' و'active' وNULL · والمؤقت الساري
-- ════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_active boolean; v_case text;
BEGIN
  -- التحديثات بدور المالك (الدور الافتراضي)، والفحص بدور authenticated؛
  -- الخلط بينهما كان يفشل بـ permission denied على profiles.
  FOREACH v_case IN ARRAY ARRAY['none','active'] LOOP
    UPDATE public.profiles SET ban_status = v_case, ban_until = NULL
     WHERE id = '00000000-0000-0000-0000-0000000000b1';
    PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1', true);
    SET LOCAL ROLE authenticated;
    SELECT public.account_is_active() INTO v_active;
    RESET ROLE;
    IF v_active IS NOT true THEN
      RAISE EXCEPTION 'FAIL 4: ban_status=% أغلق الحساب (active=%)', v_case, v_active; END IF;
  END LOOP;

  -- NULL: is_banned() تعيده غير محظور (شرط is not null).
  UPDATE public.profiles SET ban_status = NULL, ban_until = NULL
   WHERE id = '00000000-0000-0000-0000-0000000000b1';
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1', true);
  SET LOCAL ROLE authenticated;
  SELECT public.account_is_active() INTO v_active;
  RESET ROLE;
  IF v_active IS NOT true THEN
    RAISE EXCEPTION 'FAIL 4: ban_status=NULL أغلق الحساب (active=%)', v_active; END IF;

  -- مؤقت سارٍ: ban_until في المستقبل → محظور.
  UPDATE public.profiles SET ban_status = 'temporary', ban_until = now() + interval '1 day'
   WHERE id = '00000000-0000-0000-0000-0000000000b1';
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1', true);
  SET LOCAL ROLE authenticated;
  SELECT public.account_is_active() INTO v_active;
  RESET ROLE;
  IF v_active IS NOT false THEN
    RAISE EXCEPTION 'FAIL 4: الحظر المؤقت الساري لم يغلق (active=%)', v_active; END IF;

  RAISE NOTICE 'PASS 4: none/active/NULL غير حاظرة، والمؤقت الساري حاظر';
END $$;

-- إعادة الحالة النظيفة للحساب قبل بقية الاختبارات.
UPDATE public.profiles SET ban_status = 'none', ban_until = NULL
 WHERE id = '00000000-0000-0000-0000-0000000000b1';

-- ════════════════════════════════════════════════════════════════════════
-- ⑤ مالك المنصة المعفى غير المحظور ما زال نشطًا بلا هاتف وبلا كود
-- ════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_active boolean; v_tickets int; v_phone text;
BEGIN
  SELECT phone INTO v_phone FROM public.profiles
   WHERE id = '00000000-0000-0000-0000-0000000000a1';
  IF v_phone IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 5: الاختبار فقد معناه — المالك صار له رقم'; END IF;

  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  SELECT public.account_is_active() INTO v_active;
  SELECT count(*) INTO v_tickets FROM public.tickets;
  RESET ROLE;

  IF v_active IS NOT true THEN
    RAISE EXCEPTION 'FAIL 5: المالك المعفى جاء active=% بعد 144', v_active; END IF;
  IF v_tickets < 1 THEN
    RAISE EXCEPTION 'FAIL 5: المالك المعفى لم ير بياناته بعد 144'; END IF;
  RAISE NOTICE 'PASS 5: إعفاء المالك محفوظ — نشط بلا هاتف وبلا كود';
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- ⑥ حالة المالك المحظور افتراضًا — موثَّقة لا خطأ
--    الصيغة الحية (h04): NOT is_banned فوق الإعفاء، فالمالك المحظور يُمنع
--    من المسارات المبوَّبة — النمط القائم نفسه في 058/067. وحظر المالك
--    محمي من المنبع بمحفِّز guard_privileged_accounts (053).
-- ════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_active boolean;
BEGIN
  UPDATE public.profiles SET ban_status = 'permanent', ban_until = NULL
   WHERE id = '00000000-0000-0000-0000-0000000000a1';

  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  SELECT public.account_is_active() INTO v_active;
  RESET ROLE;

  -- توثيق السلوك الحي لا تأكيد فشل: أي قيمة غير false هنا تعني أن
  -- الصيغة انحرفت عن h04.
  IF v_active IS NOT false THEN
    RAISE EXCEPTION 'FAIL 6: المالك المحظور مرّ (active=%) — الصيغة انحرفت عن h04', v_active; END IF;
  RAISE NOTICE 'PASS 6 (موثَّق): المالك المحظور افتراضًا غير نشط — الحظر فوق الإعفاء كما في h04';

  UPDATE public.profiles SET ban_status = 'none', ban_until = NULL
   WHERE id = '00000000-0000-0000-0000-0000000000a1';
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- ⑦ إعادة تطبيق 144 آمنة · والتراجع يعيد جسم 042 · وإعادة 144 تعيد المنع
-- ════════════════════════════════════════════════════════════════════════
\i migrations/144_wire_is_banned_into_account_gate.sql

DO $$
DECLARE v_policies int; v_def text;
BEGIN
  SELECT count(*) INTO v_policies FROM pg_policies
   WHERE schemaname = 'public' AND policyname = 'gate_account_active';
  IF v_policies <> 2 THEN
    RAISE EXCEPTION 'FAIL 7: توقعنا سياستين (tickets, notifications) فوجدنا %', v_policies; END IF;
  SELECT pg_get_functiondef('public.account_is_active()'::regprocedure) INTO v_def;
  IF v_def !~ 'is_banned' THEN
    RAISE EXCEPTION 'FAIL 7: التعريف فقد is_banned بعد إعادة التطبيق'; END IF;
  RAISE NOTICE 'PASS 7: إعادة تطبيق 144 آمنة ولا تُضاعف السياسات';
END $$;

\i migrations/_rollback/144_wire_is_banned_into_account_gate.down.sql

DO $$
DECLARE v_active boolean;
BEGIN
  UPDATE public.profiles SET ban_status = 'permanent', ban_until = NULL
   WHERE id = '00000000-0000-0000-0000-0000000000b1';
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1', true);
  SET LOCAL ROLE authenticated;
  SELECT public.account_is_active() INTO v_active;
  RESET ROLE;
  IF v_active IS NOT true THEN
    RAISE EXCEPTION 'FAIL 7B: التراجع لم يعد جسم 042 (active=%)', v_active; END IF;
  RAISE NOTICE 'PASS 7B: ملف التراجع يعيد جسم 042 فعلًا (المحظور يمرّ ثانيةً)';
END $$;

\i migrations/144_wire_is_banned_into_account_gate.sql

DO $$
DECLARE v_active boolean;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1', true);
  SET LOCAL ROLE authenticated;
  SELECT public.account_is_active() INTO v_active;
  RESET ROLE;
  IF v_active IS NOT false THEN
    RAISE EXCEPTION 'FAIL 7C: إعادة 144 بعد التراجع لم تعد المنع (active=%)', v_active; END IF;
  UPDATE public.profiles SET ban_status = 'none', ban_until = NULL
   WHERE id = '00000000-0000-0000-0000-0000000000b1';
  RAISE NOTICE 'PASS 7C: إعادة تطبيق 144 بعد التراجع تعيد المنع';
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- ⑧ my_account_gate() — ألغاه 152: الفرع 'banned' (المصفوفة الكاملة في
--    account-gate-ban-152.test.sql). هذا القسم هنا يثبّت أن المحظور لم
--    يعد يرى 'needs_phone' المضللة بعد 152.
-- ════════════════════════════════════════════════════════════════════════
\i migrations/152_my_account_gate_banned_branch.sql

DO $$
DECLARE v_status text;
BEGIN
  UPDATE public.profiles SET ban_status = 'permanent', ban_until = NULL
   WHERE id = '00000000-0000-0000-0000-0000000000b1';
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1', true);
  SET LOCAL ROLE authenticated;
  SELECT public.my_account_gate()->>'status' INTO v_status;
  RESET ROLE;
  -- بعد 152: المحظور في القائمة البيضاء وبهاتف يرى 'banned'، لا 'needs_phone'.
  IF v_status <> 'banned' THEN
    RAISE EXCEPTION 'FAIL 8: حالة البوابة للمحظور جاءت % لا banned (152)', v_status; END IF;
  RAISE NOTICE 'PASS 8: my_account_gate() بفرع banned منذ 152 (كان needs_phone قبلها)';
  UPDATE public.profiles SET ban_status = 'none', ban_until = NULL
   WHERE id = '00000000-0000-0000-0000-0000000000b1';
END $$;

\echo 'ALL ACCOUNT GATE BAN 144 TESTS PASSED'
