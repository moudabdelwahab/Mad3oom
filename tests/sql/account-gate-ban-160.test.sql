-- ============================================================================
-- اختبار تنفيذي لـ 160: فرع 'banned' في my_account_gate().
--
-- يثبّت الخصائص التي جاء 160 ليغلقها، كل واحدة تفشل إن انكسرت:
--
--   ① المحظور الموثَّق الهاتف في القائمة البيضاء يرى 'banned' (لا
--      'needs_phone' المضللة)، مع ban_reason وbanned_until في JSON.
--   ② غير المحظور بلا هاتف ما زال 'needs_phone'؛ وغير المدرج في القائمة
--      ما زال 'waiting_approval'؛ والنشط ما زال 'active'؛ والمجهول
--      'anonymous' — أي أن الفرع الجديد لم يزحزح أي حالة أخرى.
--   ③ حظر مؤقت منتهي → المنطق العادي ('active')؛ وحظر مؤقت سارٍ →
--      'banned' مع banned_until كما كُتبت.
--   ④ المالك المحظور افتراضًا يرى 'banned' أيضًا — اتساقًا مع 144 §6
--      (NOT is_banned فوق الإعفاء)، لا استثناءً صامتًا.
--   ⑤ رفع الحظر يعيد 'active' فورًا، ويمسح ban_reason/banned_until
--      من JSON.
--   ⑥ 144 و029 بلا مساس: تعريفا account_is_active() وis_banned() يحملان
--      علامتيهما؛ وإعادة تطبيق 160 آمنة؛ والتراجع يعيد جسم 042
--      ('needs_phone' ثانيةً)؛ وإعادة 160 بعده تعيد 'banned'.
--
-- يحمّل 042 ثم `is_banned()` (نص 029 حرفيًا) ثم 144 ثم 160 — أي أن
-- الاختبار يمرّ عبر ملفات الترحيل نفسها، لا عبر نسخ منسوخة من أجسامها.
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

-- ── الجداول التي تبني عليها البوابة (كما في account-gate-ban-144.test.sql)
-- مع عمود ban_reason الذي يعرضه 160 (الغائب عن بديل اختبار 144). ────────
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

-- ── الترحيلات تحت الاختبار ───────────────────────────────────────────────
\i migrations/042_account_gate.sql

-- ── is_banned() — نص 029 حرفيًا (029_entitlement_and_points_guard.sql) ──
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

\i migrations/144_wire_is_banned_into_account_gate.sql
\i migrations/160_my_account_gate_banned_branch.sql

-- ── الحسابات ──────────────────────────────────────────────────────────────
-- gate_cutoff() = 2026-09-16. «قديم» = قبلها: في القائمة البيضاء بلا إدخال
-- قائمة انتظار معلَّق/مرفوض، وبهاتف صالح → البوابة مفتوحة ما لم يُحظر.
-- «جديد» = بعدها بلا إدخال قائمة انتظار: خارج القائمة البيضاء.
INSERT INTO public.profiles (id, email, full_name, phone, role, ban_status, ban_until, ban_reason, created_at) VALUES
  ('00000000-0000-0000-0000-0000000000a1','mahmoud@mad3oom.com','المالك',NULL,'platform_owner','none',NULL,NULL,'2025-01-01'),
  ('00000000-0000-0000-0000-0000000000b1','old.ok@example.com','عميل قديم برقم','+201000000001','user','none',NULL,NULL,'2025-01-01'),
  ('00000000-0000-0000-0000-0000000000b2','old.nophone@example.com','عميل قديم بلا رقم',NULL,'user','none',NULL,NULL,'2025-01-01'),
  ('00000000-0000-0000-0000-0000000000b3','new.user@example.com','عميل جديد',NULL,'user','none',NULL,NULL,'2026-10-01');

INSERT INTO public.platform_authority (user_id, level)
VALUES ('00000000-0000-0000-0000-0000000000a1','owner');

-- ════════════════════════════════════════════════════════════════════════
-- ① المحظور يرى 'banned' مع السبب والنهاية — لا 'needs_phone'
-- ════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_gate jsonb; v_active boolean;
BEGIN
  UPDATE public.profiles
     SET ban_status = 'permanent', ban_until = NULL, ban_reason = 'إساءة متكررة'
   WHERE id = '00000000-0000-0000-0000-0000000000b1';

  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1', true);
  SET LOCAL ROLE authenticated;
  SELECT public.my_account_gate() INTO v_gate;
  SELECT public.account_is_active() INTO v_active;
  RESET ROLE;

  IF v_gate->>'status' <> 'banned' THEN
    RAISE EXCEPTION 'FAIL 1: المحظور رأى % لا banned', v_gate->>'status'; END IF;
  IF v_gate->>'ban_reason' <> 'إساءة متكررة' THEN
    RAISE EXCEPTION 'FAIL 1: ban_reason جاء %', v_gate->>'ban_reason'; END IF;
  IF v_gate->>'banned_until' IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 1: banned_until لحظر دائم جاء %', v_gate->>'banned_until'; END IF;
  IF v_active IS NOT false THEN
    RAISE EXCEPTION 'FAIL 1: البوابة الحقيقية (144) مرّرت المحظور active=%', v_active; END IF;
  RAISE NOTICE 'PASS 1: المحظور يرى banned مع السبب، والبوابة الحقيقية مغلقة';
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- ② الحالات الأخرى بلا زحزحة: needs_phone / waiting_approval / active
-- ════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_gate jsonb;
BEGIN
  -- بلا هاتف وغير محظور → needs_phone كما قبل 160.
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b2', true);
  SET LOCAL ROLE authenticated;
  SELECT public.my_account_gate() INTO v_gate;
  RESET ROLE;
  IF v_gate->>'status' <> 'needs_phone' THEN
    RAISE EXCEPTION 'FAIL 2: بلا هاتف رأى % لا needs_phone', v_gate->>'status'; END IF;
  IF v_gate->>'ban_reason' IS NOT NULL OR v_gate->>'banned_until' IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 2: حقول الحظر ظهرت لغير محظور: %', v_gate; END IF;

  -- جديد خارج القائمة البيضاء → waiting_approval كما قبل 160.
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b3', true);
  SET LOCAL ROLE authenticated;
  SELECT public.my_account_gate() INTO v_gate;
  RESET ROLE;
  IF v_gate->>'status' <> 'waiting_approval' THEN
    RAISE EXCEPTION 'FAIL 2: خارج القائمة رأى % لا waiting_approval', v_gate->>'status'; END IF;

  -- المالك غير المحظور → active كما قبل 160 (بلا هاتف وبلا كود).
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  SELECT public.my_account_gate() INTO v_gate;
  RESET ROLE;
  IF v_gate->>'status' <> 'active' THEN
    RAISE EXCEPTION 'FAIL 2: المالك رأى % لا active', v_gate->>'status'; END IF;

  RAISE NOTICE 'PASS 2: needs_phone/waiting_approval/active بلا زحزحة';
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- ③ المؤقت: المنتهي يعود للمنطق العادي، والساري banned مع النهاية
-- ════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_gate jsonb;
BEGIN
  UPDATE public.profiles
     SET ban_status = 'temporary', ban_until = now() - interval '1 day', ban_reason = 'قديم'
   WHERE id = '00000000-0000-0000-0000-0000000000b1';
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1', true);
  SET LOCAL ROLE authenticated;
  SELECT public.my_account_gate() INTO v_gate;
  RESET ROLE;
  IF v_gate->>'status' <> 'active' THEN
    RAISE EXCEPTION 'FAIL 3: حظر مؤقت منتهٍ رأى % لا active', v_gate->>'status'; END IF;

  UPDATE public.profiles
     SET ban_status = 'temporary', ban_until = now() + interval '2 days', ban_reason = 'مؤقت'
   WHERE id = '00000000-0000-0000-0000-0000000000b1';
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1', true);
  SET LOCAL ROLE authenticated;
  SELECT public.my_account_gate() INTO v_gate;
  RESET ROLE;
  IF v_gate->>'status' <> 'banned' THEN
    RAISE EXCEPTION 'FAIL 3: حظر مؤقت سارٍ رأى % لا banned', v_gate->>'status'; END IF;
  IF v_gate->>'ban_reason' <> 'مؤقت' THEN
    RAISE EXCEPTION 'FAIL 3: ban_reason للمؤقت جاء %', v_gate->>'ban_reason'; END IF;
  IF (v_gate->>'banned_until')::timestamptz <= now() THEN
    RAISE EXCEPTION 'FAIL 3: banned_until للمؤقت ليس في المستقبل: %', v_gate->>'banned_until'; END IF;
  RAISE NOTICE 'PASS 3: منتهٍ → active، وسارٍ → banned مع النهاية';
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- ④ المالك المحظور افتراضًا يرى 'banned' — اتساقًا مع 144 §6
-- ════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_gate jsonb;
BEGIN
  UPDATE public.profiles SET ban_status = 'permanent', ban_until = NULL, ban_reason = 'افتراضي'
   WHERE id = '00000000-0000-0000-0000-0000000000a1';
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  SELECT public.my_account_gate() INTO v_gate;
  RESET ROLE;
  IF v_gate->>'status' <> 'banned' THEN
    RAISE EXCEPTION 'FAIL 4: المالك المحظور رأى % لا banned', v_gate->>'status'; END IF;
  RAISE NOTICE 'PASS 4 (موثَّق): المالك المحظور افتراضًا يرى banned — بلا استثناء صامت';
  UPDATE public.profiles SET ban_status = 'none', ban_until = NULL, ban_reason = NULL
   WHERE id = '00000000-0000-0000-0000-0000000000a1';
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- ⑤ رفع الحظر يعيد 'active' ويمسح حقول الحظر من JSON
-- ════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_gate jsonb;
BEGIN
  UPDATE public.profiles SET ban_status = 'none', ban_until = NULL, ban_reason = NULL
   WHERE id = '00000000-0000-0000-0000-0000000000b1';
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1', true);
  SET LOCAL ROLE authenticated;
  SELECT public.my_account_gate() INTO v_gate;
  RESET ROLE;
  IF v_gate->>'status' <> 'active' THEN
    RAISE EXCEPTION 'FAIL 5: بعد رفع الحظر جاء % لا active', v_gate->>'status'; END IF;
  IF v_gate->>'ban_reason' IS NOT NULL OR v_gate->>'banned_until' IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 5: حقول الحظر بقيت بعد الرفع: %', v_gate; END IF;
  RAISE NOTICE 'PASS 5: رفع الحظر يعيد active ويمسح حقول الحظر';
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- ⑥ 144 و029 بلا مساس · إعادة 160 آمنة · التراجع يعيد 042 · وإعادة 160 تعيد banned
-- ════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_active_def text; v_banned_def text;
BEGIN
  SELECT pg_get_functiondef('public.account_is_active()'::regprocedure) INTO v_active_def;
  IF v_active_def !~ 'not public\.is_banned\(auth\.uid\(\)\)' OR v_active_def !~ 'gate_is_exempt_account' THEN
    RAISE EXCEPTION 'FAIL 6: تعريف account_is_active() انحرف عن 144/h04'; END IF;
  SELECT pg_get_functiondef('public.is_banned(uuid)'::regprocedure) INTO v_banned_def;
  IF v_banned_def !~ 'ban_status' OR v_banned_def !~ 'ban_until' THEN
    RAISE EXCEPTION 'FAIL 6: تعريف is_banned() انحرف عن 029'; END IF;
  RAISE NOTICE 'PASS 6: 144 و029 بلا مساس';
END $$;

\i migrations/160_my_account_gate_banned_branch.sql

DO $$
DECLARE v_gate jsonb;
BEGIN
  UPDATE public.profiles SET ban_status = 'permanent', ban_until = NULL, ban_reason = 'إعادة'
   WHERE id = '00000000-0000-0000-0000-0000000000b1';
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1', true);
  SET LOCAL ROLE authenticated;
  SELECT public.my_account_gate() INTO v_gate;
  RESET ROLE;
  IF v_gate->>'status' <> 'banned' THEN
    RAISE EXCEPTION 'FAIL 6B: إعادة 160 فقدت banned (جاء %)', v_gate->>'status'; END IF;
  RAISE NOTICE 'PASS 6B: إعادة تطبيق 160 آمنة';
END $$;

\i migrations/_rollback/160_my_account_gate_banned_branch.down.sql

DO $$
DECLARE v_gate jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1', true);
  SET LOCAL ROLE authenticated;
  SELECT public.my_account_gate() INTO v_gate;
  RESET ROLE;
  IF v_gate->>'status' <> 'needs_phone' THEN
    RAISE EXCEPTION 'FAIL 6C: التراجع لم يعد جسم 042 (جاء %)', v_gate->>'status'; END IF;
  RAISE NOTICE 'PASS 6C: التراجع يعيد جسم 042 (needs_phone ثانيةً)';
END $$;

\i migrations/160_my_account_gate_banned_branch.sql

DO $$
DECLARE v_gate jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1', true);
  SET LOCAL ROLE authenticated;
  SELECT public.my_account_gate() INTO v_gate;
  RESET ROLE;
  IF v_gate->>'status' <> 'banned' THEN
    RAISE EXCEPTION 'FAIL 6D: إعادة 160 بعد التراجع لم تعد banned (جاء %)', v_gate->>'status'; END IF;
  UPDATE public.profiles SET ban_status = 'none', ban_until = NULL, ban_reason = NULL
   WHERE id = '00000000-0000-0000-0000-0000000000b1';
  RAISE NOTICE 'PASS 6D: إعادة 160 بعد التراجع تعيد banned';
END $$;

-- مجهول بلا جلسة → 'anonymous' كما في 042.
DO $$
DECLARE v_gate jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','', true);
  SET LOCAL ROLE authenticated;
  SELECT public.my_account_gate() INTO v_gate;
  RESET ROLE;
  IF v_gate->>'status' <> 'anonymous' THEN
    RAISE EXCEPTION 'FAIL 7: بلا جلسة جاء % لا anonymous', v_gate->>'status'; END IF;
  RAISE NOTICE 'PASS 7: بلا جلسة → anonymous';
END $$;

\echo 'ALL ACCOUNT GATE BAN 160 TESTS PASSED'
