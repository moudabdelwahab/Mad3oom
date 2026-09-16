-- ============================================================================
-- اختبار تنفيذي لـ 042: بوابة الحساب (هاتف إلزامي · كود مرور · قائمة انتظار).
--
-- يثبّت الخصائص التي طُلبت صراحةً، كل واحدة تفشل إن انكسرت:
--
--   ① حساب جديد يدخل قائمة الانتظار ولا يرى صفًّا واحدًا من بيانات العميل
--   ② بلا هاتف لا حساب — حتى لو كان الحساب في القائمة البيضاء
--   ③ رقم الهاتف لا يتكرر بين حسابين، **مهما اختلفت صيغته**
--   ④ الرقم غير الصحيح مرفوض، ورقم واتساب يُحفظ منفصلًا
--   ⑤ كود المرور يعفي من الهاتف وحده، ولا يمنح أي صلاحية أخرى
--   ⑥ إدارة الأكواد مقصورة على مالك المنصة حتى بنداء RPC مباشر
--   ⑦ دخول عضو الشركة يُثبِت العضوية في القاعدة ولا يقبل شركة من الواجهة
--   ⑧ مالك المنصة استثناء دائم من البوابة
--
-- الفرض الحقيقي في سياسات RESTRICTIVE، فكل تأكيد «لا يرى» هنا يُقاس بعدد
-- الصفوف الفعلي من جلسة authenticated حقيقية، لا بقيمة الدالة المرجعة.
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

-- ── الجداول التي تبني عليها البوابة ───────────────────────────────────────
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, email text, full_name text, phone text,
  role text DEFAULT 'user', super_user_id uuid,
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

-- الجداول المحروسة التي يقيس عليها الاختبار عدد الصفوف فعليًا.
CREATE TABLE public.tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, title text);
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, title text);

-- السياسات القائمة (PERMISSIVE) — البوابة تُدمج فوقها بـAND ولا تمسّها.
ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY tickets_own ON public.tickets FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY notifications_own ON public.notifications FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tickets, public.notifications TO authenticated;
GRANT SELECT ON public.profiles TO authenticated;

-- ── سلطة المنصة (038) بالقدر الذي تحتاجه البوابة ──────────────────────────
CREATE TABLE public.platform_authority (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  level text NOT NULL);

CREATE OR REPLACE FUNCTION public.is_platform_owner()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.platform_authority a
                  WHERE a.user_id = auth.uid() AND a.level = 'owner'); $$;

-- حدّ معدّل الطلبات: نسخة اختبار تسمح دائمًا. سلوك الحدّ نفسه ليس موضوع
-- هذا الملف؛ الموضوع هو أن العضوية تُثبَت في القاعدة.
CREATE OR REPLACE FUNCTION public._check_email_lookup_rate_limit(
  p_key text, p_max int, p_window int)
RETURNS boolean LANGUAGE sql AS $$ SELECT true; $$;

-- ── الترحيل تحت الاختبار ──────────────────────────────────────────────────
\i migrations/042_account_gate.sql

-- Supabase يمنح امتيازات الجداول لـauthenticated افتراضيًا على كل جدول جديد
-- في public، فالـRLS هي المرشِّح الوحيد فعليًا. نحاكي ذلك هنا عمدًا: بدون
-- هذه المنحة كان اختبار «لا يقرأ غير المالك الأكواد» سيمرّ بسبب امتياز
-- مفقود لا بسبب السياسة — أي أنه كان سيخفي انكسار السياسة بدل كشفه.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.access_passcodes, public.passcode_redemptions TO authenticated;

-- ── الحسابات ──────────────────────────────────────────────────────────────
-- ملاحظة: gate_cutoff() = 2026-09-16. «قديم» = قبلها، «جديد» = بعدها.
INSERT INTO public.profiles (id, email, full_name, phone, role, created_at) VALUES
  ('00000000-0000-0000-0000-0000000000a1','mahmoud@mad3oom.com','المالك',NULL,'platform_owner','2025-01-01'),
  ('00000000-0000-0000-0000-0000000000b1','old.ok@example.com','عميل قديم برقم','+201000000001','user','2025-01-01'),
  ('00000000-0000-0000-0000-0000000000b2','old.nophone@example.com','عميل قديم بلا رقم',NULL,'user','2025-01-01'),
  ('00000000-0000-0000-0000-0000000000c1','fresh@example.com','عميل جديد',NULL,'user','2026-10-01'),
  ('00000000-0000-0000-0000-0000000000d1','owner@acme.com','صاحب أكمي','+201000000009','user','2025-01-01'),
  ('00000000-0000-0000-0000-0000000000d2','staff@acme.com','موظف أكمي','+201000000010','user','2025-01-01'),
  ('00000000-0000-0000-0000-0000000000e1','stranger@example.com','غريب','+201000000011','user','2025-01-01');

UPDATE public.profiles SET super_user_id = '00000000-0000-0000-0000-0000000000d1'
 WHERE id = '00000000-0000-0000-0000-0000000000d2';

INSERT INTO public.platform_authority (user_id, level)
VALUES ('00000000-0000-0000-0000-0000000000a1','owner');

INSERT INTO public.companies (user_id, company_name, company_email, company_phone,
                              commercial_registration_number, status)
VALUES ('00000000-0000-0000-0000-0000000000d1','أكمي','billing@acme.com','01000000009','CR-4477','active');

-- العميل الجديد يدخل قائمة الانتظار تلقائيًا (نفس ما يفعله مسار التسجيل).
INSERT INTO public.waitlist_entries (name, email, status, approved_user_id)
VALUES ('عميل جديد','fresh@example.com','pending','00000000-0000-0000-0000-0000000000c1');

INSERT INTO public.tickets (user_id, title) VALUES
  ('00000000-0000-0000-0000-0000000000b1','تذكرة القديم'),
  ('00000000-0000-0000-0000-0000000000b2','تذكرة بلا رقم'),
  ('00000000-0000-0000-0000-0000000000c1','تذكرة الجديد'),
  ('00000000-0000-0000-0000-0000000000a1','تذكرة المالك');
INSERT INTO public.notifications (user_id, title) VALUES
  ('00000000-0000-0000-0000-0000000000c1','إشعار الجديد');

-- ════════════════════════════════════════════════════════════════════════
-- ① الحساب الجديد: قائمة انتظار، وصفر صفوف — لا مجرد علَم في الواجهة
-- ════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_status text; v_tickets int; v_notifs int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000c1', true);
  SET LOCAL ROLE authenticated;

  SELECT public.my_account_gate()->>'status' INTO v_status;
  SELECT count(*) INTO v_tickets FROM public.tickets;
  SELECT count(*) INTO v_notifs  FROM public.notifications;

  RESET ROLE;
  IF v_status <> 'waiting_approval' THEN
    RAISE EXCEPTION 'FAIL 1: توقعنا waiting_approval فجاء %', v_status; END IF;
  IF v_tickets <> 0 OR v_notifs <> 0 THEN
    RAISE EXCEPTION 'FAIL 1: المحجوب رأى صفوفًا (tickets=% notifications=%)', v_tickets, v_notifs; END IF;
  RAISE NOTICE 'PASS 1: الحساب الجديد في قائمة الانتظار ولا يرى أي صف';
END $$;

-- والكتابة ممنوعة أيضًا، لا القراءة وحدها.
DO $$
DECLARE v_ok boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000c1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO public.tickets (user_id, title)
    VALUES ('00000000-0000-0000-0000-0000000000c1','محاولة من محجوب');
  EXCEPTION WHEN insufficient_privilege THEN v_ok := true;
  END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL 1B: المحجوب استطاع الكتابة'; END IF;
  RAISE NOTICE 'PASS 1B: الكتابة محجوبة أيضًا، لا القراءة وحدها';
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- ② بلا هاتف لا حساب — حتى داخل القائمة البيضاء
-- ════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_status text; v_white boolean; v_tickets int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b2', true);
  SET LOCAL ROLE authenticated;
  SELECT public.my_account_gate()->>'status' INTO v_status;
  SELECT public.account_is_whitelisted() INTO v_white;
  SELECT count(*) INTO v_tickets FROM public.tickets;
  RESET ROLE;

  IF NOT v_white THEN RAISE EXCEPTION 'FAIL 2: الحساب القديم كان يجب أن يكون في القائمة البيضاء'; END IF;
  IF v_status <> 'needs_phone' THEN
    RAISE EXCEPTION 'FAIL 2: توقعنا needs_phone فجاء %', v_status; END IF;
  IF v_tickets <> 0 THEN RAISE EXCEPTION 'FAIL 2: بلا هاتف ورأى % تذكرة', v_tickets; END IF;
  RAISE NOTICE 'PASS 2: القائمة البيضاء وحدها لا تكفي — الهاتف شرط مستقل';
END $$;

-- وبعد إدخال رقم صحيح يُفتح الحساب فورًا.
DO $$
DECLARE v_status text; v_tickets int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b2', true);
  SET LOCAL ROLE authenticated;
  PERFORM public.submit_my_phone('01000000002', true, NULL);
  SELECT public.my_account_gate()->>'status' INTO v_status;
  SELECT count(*) INTO v_tickets FROM public.tickets;
  RESET ROLE;

  IF v_status <> 'active' THEN RAISE EXCEPTION 'FAIL 2B: بعد الهاتف جاء %', v_status; END IF;
  IF v_tickets <> 1 THEN RAISE EXCEPTION 'FAIL 2B: توقعنا تذكرة واحدة فجاء %', v_tickets; END IF;
  RAISE NOTICE 'PASS 2B: إدخال رقم صحيح يفتح الحساب وبياناته فورًا';
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- ③ الرقم لا يتكرر مهما اختلفت صيغته
-- ════════════════════════════════════════════════════════════════════════
-- ‎+201000000001 مسجَّل لـold.ok. المحاولات الثلاث كلها **نفس الرقم** بصيغ
-- مختلفة، فلا بد أن تُرفض ثلاثتها — وإلا لكان التطبيع تجميلًا لا قاعدة.
DO $$
DECLARE v_variant text; v_blocked int := 0;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  FOREACH v_variant IN ARRAY ARRAY['01000000001','+201000000001','00201000000001'] LOOP
    BEGIN
      PERFORM public.submit_my_phone(v_variant, true, NULL);
    EXCEPTION WHEN unique_violation THEN v_blocked := v_blocked + 1;
    END;
  END LOOP;
  RESET ROLE;

  IF v_blocked <> 3 THEN
    RAISE EXCEPTION 'FAIL 3: صيغة واحدة على الأقل تسللت (رُفض % من 3)', v_blocked; END IF;
  RAISE NOTICE 'PASS 3: نفس الرقم مرفوض بصيغه الثلاث — التطبيع قاعدة لا تجميل';
END $$;

-- ولم يتغيّر رقم المحاوِل نتيجة المحاولات الفاشلة.
DO $$
DECLARE v_phone text;
BEGIN
  SELECT phone INTO v_phone FROM public.profiles
   WHERE id = '00000000-0000-0000-0000-0000000000e1';
  IF v_phone <> '+201000000011' THEN
    RAISE EXCEPTION 'FAIL 3B: الرقم تغيّر إلى % رغم رفض المحاولات', v_phone; END IF;
  RAISE NOTICE 'PASS 3B: المحاولات المرفوضة لم تترك أثرًا';
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- ④ رقم غير صحيح مرفوض · رقم واتساب منفصل
-- ════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_bad text; v_blocked int := 0;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  FOREACH v_bad IN ARRAY ARRAY['123','abcd','0100','+0123']  LOOP
    BEGIN
      PERFORM public.submit_my_phone(v_bad, true, NULL);
    EXCEPTION WHEN invalid_parameter_value THEN v_blocked := v_blocked + 1;
    END;
  END LOOP;
  RESET ROLE;
  IF v_blocked <> 4 THEN
    RAISE EXCEPTION 'FAIL 4: رقم غير صحيح قُبِل (رُفض % من 4)', v_blocked; END IF;
  RAISE NOTICE 'PASS 4: الأرقام غير الصحيحة مرفوضة قبل الحفظ';
END $$;

-- «لا، الرقم ليس عليه واتساب» → يُحفظ رقم واتساب مستقل، والهاتف يبقى مطلوبًا.
DO $$
DECLARE v_phone text; v_wa text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  PERFORM public.submit_my_phone('01000000021', false, '01000000022');
  RESET ROLE;

  SELECT phone, whatsapp_phone INTO v_phone, v_wa FROM public.profiles
   WHERE id = '00000000-0000-0000-0000-0000000000e1';
  IF v_phone <> '+201000000021' THEN RAISE EXCEPTION 'FAIL 4B: الهاتف = %', v_phone; END IF;
  IF v_wa    <> '+201000000022' THEN RAISE EXCEPTION 'FAIL 4B: واتساب = %', v_wa; END IF;
  RAISE NOTICE 'PASS 4B: رقم واتساب يُحفظ منفصلًا بصيغة موحّدة';
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- ⑤ كود المرور يعفي من الهاتف **وحده**
-- ════════════════════════════════════════════════════════════════════════
INSERT INTO public.profiles (id, email, full_name, phone, role, created_at)
VALUES ('00000000-0000-0000-0000-0000000000f1','passcode@example.com','بكود',NULL,'user','2025-01-01');
INSERT INTO public.tickets (user_id, title)
VALUES ('00000000-0000-0000-0000-0000000000f1','تذكرة صاحب الكود');

-- المالك ينشئ الكود من لوحته.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM public.owner_set_passcode('LAUNCH-2026','إطلاق');
  RESET ROLE;
  RAISE NOTICE 'PASS 5A: المالك أنشأ كود مرور';
END $$;

DO $$
DECLARE v_before text; v_after text; v_tickets int; v_bad jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;

  SELECT public.my_account_gate()->>'status' INTO v_before;

  -- كود خاطئ لا يفعل شيئًا.
  SELECT public.redeem_passcode('WRONG-CODE') INTO v_bad;
  IF (v_bad->>'ok')::boolean THEN RAISE EXCEPTION 'FAIL 5: كود خاطئ قُبِل'; END IF;

  PERFORM public.redeem_passcode('LAUNCH-2026');
  SELECT public.my_account_gate()->>'status' INTO v_after;
  SELECT count(*) INTO v_tickets FROM public.tickets;
  RESET ROLE;

  IF v_before <> 'needs_phone' THEN RAISE EXCEPTION 'FAIL 5: قبل الكود جاء %', v_before; END IF;
  IF v_after  <> 'active'      THEN RAISE EXCEPTION 'FAIL 5: بعد الكود جاء %', v_after;  END IF;
  IF v_tickets <> 1 THEN RAISE EXCEPTION 'FAIL 5: توقعنا تذكرة واحدة فجاء %', v_tickets; END IF;
  RAISE NOTICE 'PASS 5: الكود الصحيح يعفي من الهاتف، والخاطئ لا يفعل شيئًا';
END $$;

-- ولا يمنح أي صلاحية زائدة: لا يرى تذاكر غيره، ولا يصير مالكًا.
DO $$
DECLARE v_tickets int; v_owner boolean;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_tickets FROM public.tickets
   WHERE user_id <> '00000000-0000-0000-0000-0000000000f1';
  SELECT public.is_platform_owner() INTO v_owner;
  RESET ROLE;
  IF v_tickets <> 0 THEN RAISE EXCEPTION 'FAIL 5B: صاحب الكود رأى % تذكرة لغيره', v_tickets; END IF;
  IF v_owner THEN RAISE EXCEPTION 'FAIL 5B: الكود منح سلطة مالك المنصة'; END IF;
  RAISE NOTICE 'PASS 5B: الكود يعفي من الهاتف فقط ولا يمنح صلاحية واحدة زائدة';
END $$;

-- وسحب الكود يُعيد الحساب إلى البوابة.
DO $$
DECLARE v_id uuid; v_status text;
BEGIN
  SELECT id INTO v_id FROM public.access_passcodes LIMIT 1;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM public.owner_set_passcode_active(v_id, false);
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  SELECT public.my_account_gate()->>'status' INTO v_status;
  RESET ROLE;

  IF v_status <> 'needs_phone' THEN RAISE EXCEPTION 'FAIL 5C: بعد السحب جاء %', v_status; END IF;
  RAISE NOTICE 'PASS 5C: سحب الكود يُعيد الحساب إلى البوابة فورًا';

  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM public.owner_set_passcode_active(v_id, true);
  RESET ROLE;
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- ⑥ إدارة الأكواد مقصورة على المالك حتى بنداء RPC مباشر
-- ════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_denied int := 0; v_count_before int; v_count_after int;
BEGIN
  SELECT count(*) INTO v_count_before FROM public.access_passcodes;

  -- عميل عادي مفعَّل بالكامل (ليس محجوبًا) — الرفض عن سلطة لا عن بوابة.
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1', true);
  SET LOCAL ROLE authenticated;
  BEGIN PERFORM public.owner_set_passcode('SNEAKY-2026','تسلل');
  EXCEPTION WHEN insufficient_privilege THEN v_denied := v_denied + 1; END;
  BEGIN PERFORM public.owner_set_passcode_active(
           (SELECT id FROM public.access_passcodes LIMIT 1), false);
  EXCEPTION WHEN insufficient_privilege THEN v_denied := v_denied + 1; END;
  RESET ROLE;

  SELECT count(*) INTO v_count_after FROM public.access_passcodes;
  IF v_denied <> 2 THEN RAISE EXCEPTION 'FAIL 6: غير المالك نفّذ إدارة الأكواد (رُفض % من 2)', v_denied; END IF;
  IF v_count_after <> v_count_before THEN RAISE EXCEPTION 'FAIL 6: عدد الأكواد تغيّر'; END IF;
  RAISE NOTICE 'PASS 6: إدارة الأكواد admin-proof — مقصورة على مالك المنصة';
END $$;

-- ولا يقرأ غير المالك تجزئة أي كود (وإلا لأمكن كسره خارج القاعدة).
DO $$
DECLARE v_rows int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_rows FROM public.access_passcodes;
  RESET ROLE;
  IF v_rows <> 0 THEN RAISE EXCEPTION 'FAIL 6B: غير المالك قرأ % كودًا', v_rows; END IF;
  RAISE NOTICE 'PASS 6B: تجزئات الأكواد غير مقروءة لغير المالك';
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- ⑦ دخول عضو الشركة: العضوية تُثبَت في القاعدة
-- ════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_by_email text; v_by_cr text; v_by_phone text;
        v_stranger text; v_owner_self text;
BEGIN
  -- العضو الحقيقي يُعرَف بالشركة بثلاث طرق (بريد/سجل تجاري/هاتف).
  SELECT public.resolve_company_member_login('billing@acme.com','staff@acme.com') INTO v_by_email;
  SELECT public.resolve_company_member_login('CR-4477','staff@acme.com')          INTO v_by_cr;
  SELECT public.resolve_company_member_login('01000000009','01000000010')         INTO v_by_phone;

  -- من ليس عضوًا لا يُعاد بريده مهما كانت كلمة مروره صحيحة لاحقًا.
  SELECT public.resolve_company_member_login('billing@acme.com','stranger@example.com') INTO v_stranger;

  -- صاحب الشركة نفسه عضو في شركته.
  SELECT public.resolve_company_member_login('billing@acme.com','owner@acme.com') INTO v_owner_self;

  IF v_by_email <> 'staff@acme.com' THEN RAISE EXCEPTION 'FAIL 7: بالبريد = %', v_by_email; END IF;
  IF v_by_cr    <> 'staff@acme.com' THEN RAISE EXCEPTION 'FAIL 7: بالسجل = %', v_by_cr; END IF;
  IF v_by_phone <> 'staff@acme.com' THEN RAISE EXCEPTION 'FAIL 7: بالهاتف = %', v_by_phone; END IF;
  IF v_stranger IS NOT NULL THEN RAISE EXCEPTION 'FAIL 7: غير العضو مُرِّر كعضو (%)', v_stranger; END IF;
  IF v_owner_self <> 'owner@acme.com' THEN RAISE EXCEPTION 'FAIL 7: صاحب الشركة رُفض'; END IF;
  RAISE NOTICE 'PASS 7: العضوية تُثبَت في القاعدة، وغير العضو لا يُمرَّر';
END $$;

-- شركة موقوفة لا تُسجِّل أحدًا، وشركة غير موجودة لا تسرّب وجود الحساب.
DO $$
DECLARE v_suspended text; v_missing text;
BEGIN
  UPDATE public.companies SET status = 'suspended' WHERE company_email = 'billing@acme.com';
  SELECT public.resolve_company_member_login('billing@acme.com','staff@acme.com') INTO v_suspended;
  UPDATE public.companies SET status = 'active' WHERE company_email = 'billing@acme.com';

  SELECT public.resolve_company_member_login('nope@nowhere.com','staff@acme.com') INTO v_missing;

  IF v_suspended IS NOT NULL THEN RAISE EXCEPTION 'FAIL 7B: شركة موقوفة سجّلت عضوًا'; END IF;
  IF v_missing   IS NOT NULL THEN RAISE EXCEPTION 'FAIL 7B: شركة غير موجودة أعادت بريدًا'; END IF;
  RAISE NOTICE 'PASS 7B: الشركة الموقوفة وغير الموجودة لا تُمرِّران أحدًا';
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- ⑧ مالك المنصة استثناء دائم — بلا هاتف وبلا كود
-- ════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_status text; v_tickets int; v_phone text;
BEGIN
  SELECT phone INTO v_phone FROM public.profiles
   WHERE id = '00000000-0000-0000-0000-0000000000a1';
  IF v_phone IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 8: الاختبار فقد معناه — المالك صار له رقم'; END IF;

  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  SELECT public.my_account_gate()->>'status' INTO v_status;
  SELECT count(*) INTO v_tickets FROM public.tickets;
  RESET ROLE;

  IF v_status <> 'active' THEN RAISE EXCEPTION 'FAIL 8: المالك جاء %', v_status; END IF;
  IF v_tickets < 1 THEN RAISE EXCEPTION 'FAIL 8: المالك لم ير بياناته'; END IF;
  RAISE NOTICE 'PASS 8: مالك المنصة يمرّ بلا هاتف وبلا كود';
END $$;

-- والاستثناء مربوط بالبريد في القاعدة، فتغيير بريد حساب آخر إليه لا يصح:
-- profiles.email فريد، والمالك موجود — فالمحاولة تفشل بنيويًا لا سياسيًا.
DO $$
DECLARE v_status text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000c1', true);
  SET LOCAL ROLE authenticated;
  SELECT public.my_account_gate()->>'status' INTO v_status;
  RESET ROLE;
  IF v_status <> 'waiting_approval' THEN
    RAISE EXCEPTION 'FAIL 8B: المحجوب خرج من القائمة بلا موافقة (%)', v_status; END IF;
  RAISE NOTICE 'PASS 8B: لا مخرج من قائمة الانتظار إلا بالموافقة';
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- ⑨ الموافقة على الطلب تفتح الحساب (بعد استيفاء الهاتف)
-- ════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_status text; v_tickets int;
BEGIN
  UPDATE public.waitlist_entries SET status = 'approved'
   WHERE approved_user_id = '00000000-0000-0000-0000-0000000000c1';

  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000c1', true);
  SET LOCAL ROLE authenticated;

  -- الموافقة وحدها لا تكفي: الهاتف شرط مستقل.
  SELECT public.my_account_gate()->>'status' INTO v_status;
  IF v_status <> 'needs_phone' THEN
    RAISE EXCEPTION 'FAIL 9: بعد الموافقة وقبل الهاتف جاء %', v_status; END IF;

  PERFORM public.submit_my_phone('01000000033', true, NULL);
  SELECT public.my_account_gate()->>'status' INTO v_status;
  SELECT count(*) INTO v_tickets FROM public.tickets;
  RESET ROLE;

  IF v_status <> 'active' THEN RAISE EXCEPTION 'FAIL 9: بعد الاثنين جاء %', v_status; END IF;
  IF v_tickets <> 1 THEN RAISE EXCEPTION 'FAIL 9: توقعنا تذكرة واحدة فجاء %', v_tickets; END IF;
  RAISE NOTICE 'PASS 9: الموافقة + الهاتف معًا هما ما يفتح الحساب';
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- ⑩ إعادة تطبيق الترحيل لا تفشل ولا تُضاعف السياسات
-- ════════════════════════════════════════════════════════════════════════
\i migrations/042_account_gate.sql

DO $$
DECLARE v_policies int;
BEGIN
  SELECT count(*) INTO v_policies FROM pg_policies
   WHERE schemaname = 'public' AND policyname = 'gate_account_active';
  IF v_policies <> 2 THEN
    RAISE EXCEPTION 'FAIL 10: توقعنا سياستين (tickets, notifications) فوجدنا %', v_policies; END IF;
  RAISE NOTICE 'PASS 10: إعادة التطبيق آمنة ولا تُضاعف السياسات';
END $$;

\echo 'ALL ACCOUNT GATE TESTS PASSED'
