-- ============================================================================
-- طلبات حساب الشركة (068) — على نسخة مطابقة لشكل الإنتاج
--
-- قاعدة الإنتاج كاملة (tests/fixtures/prod-shape): محفّزات profiles كلها (حارس
-- الرتب، اشتقاق دور الشركة، التدقيق، بوابة الحساب، قائمة الانتظار)، وسياسات
-- companies وصلاحياتها كما هي — ثم 068 كما هو، ثم التراجع وإعادة التطبيق.
--
-- الجزء ⓪ (الإنتاج قبل 068): الخلل مثبت بسلوكه الفعلي —
--   • العميل يحفظ «بيانات الشركة» ⇒ الحارس يرفض ترقية نفسه، فالمسار معطوب.
--   • الأدمن نفسه لا يقدر يُنشئ شركة لعميل ⇒ لا مسار موافقة ممكن.
-- الجزء ① (بعد 068): الطلب، المراجعة، العزل، الحرّاس، والتراجع.
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

\i tests/fixtures/prod-shape/load.sql
SET search_path = public, extensions;

-- ── مساعدات (نفس أسلوب conversation-core-gate) ─────────────────────────────
DROP SCHEMA IF EXISTS t CASCADE;
CREATE SCHEMA t;
GRANT USAGE ON SCHEMA t TO authenticated, service_role, anon;

CREATE FUNCTION t.act(p uuid) RETURNS void LANGUAGE sql AS $$
  select set_config('request.jwt.claim.sub', coalesce(p::text, ''), false),
         set_config('request.jwt.claim.role', case when p is null then '' else 'authenticated' end, false); $$;
-- يرجّع sqlstate لو فشل، أو 'ok' (والأثر بيترجع في الحالتين).
CREATE FUNCTION t.try(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  execute p_sql;
  raise exception using errcode = 'TT000';
exception when others then
  return case when sqlstate = 'TT000' then 'ok' else sqlstate end;
end $$;
-- رسالة الخطأ نفسها (لما الرسالة هي العقد مع الواجهة)
CREATE FUNCTION t.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlerrm;
end $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ── الفاعلون ───────────────────────────────────────────────────────────────
--   U1, U2, U3  عملاء معتمدون (قبل البوابة + هاتف)
--   UW          عميل في قائمة الانتظار
--   CO          مالك شركة قائمة      CM عضو تابع لها
--   AD          أدمن
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-8000-0000000000a1', 'u1@t.io'), ('00000000-0000-4000-8000-0000000000a2', 'u2@t.io'),
  ('00000000-0000-4000-8000-0000000000a3', 'u3@t.io'), ('00000000-0000-4000-8000-0000000000aa', 'uw@t.io'),
  ('00000000-0000-4000-8000-0000000000c0', 'co@t.io'), ('00000000-0000-4000-8000-0000000000c9', 'cm@t.io'),
  ('00000000-0000-4000-8000-0000000000ad', 'ad@t.io');
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at) VALUES
  ('00000000-0000-4000-8000-0000000000a1', 'u1@t.io', 'عميل واحد', 'user', '01000000011', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000a2', 'u2@t.io', 'عميل اتنين', 'user', '01000000012', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000a3', 'u3@t.io', 'عميل تلاتة', 'user', '01000000013', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000aa', 'uw@t.io', 'منتظر', 'user', '01000000014', now()),
  ('00000000-0000-4000-8000-0000000000c0', 'co@t.io', 'مالك شركة', 'user', '01000000015', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000ad', 'ad@t.io', 'أدمن', 'admin', '01000000017', '2026-09-01');
-- الشركة القائمة تتكوّن بلا جلسة (المسار القديم كان كده في الإنتاج)
INSERT INTO public.companies (user_id, company_name, commercial_registration_number, commercial_registration_expiry)
VALUES ('00000000-0000-4000-8000-0000000000c0', 'شركة قائمة', 'CR-EXIST-1', '2030-01-01');
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at, super_user_id) VALUES
  ('00000000-0000-4000-8000-0000000000c9', 'cm@t.io', 'عضو شركة', 'user', '01000000016', '2026-09-01',
   '00000000-0000-4000-8000-0000000000c0');

DO $$
BEGIN
  IF NOT public.account_is_whitelisted('00000000-0000-4000-8000-0000000000a1')
     OR NOT public.account_verification_ok('00000000-0000-4000-8000-0000000000a1') THEN
    RAISE EXCEPTION 'SETUP: U1 مش معتمد في بوابة الإنتاج';
  END IF;
  IF public.account_is_whitelisted('00000000-0000-4000-8000-0000000000aa') THEN
    RAISE EXCEPTION 'SETUP: UW المفروض في قائمة الانتظار';
  END IF;
  IF (SELECT role FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000c0') <> 'company_admin'
     OR (SELECT role FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000c9') <> 'company_user' THEN
    RAISE EXCEPTION 'SETUP: أدوار الشركة القائمة مااتشتقتش';
  END IF;
  RAISE NOTICE 'PASS SETUP: نسخة الإنتاج + عملاء معتمدين/منتظر + شركة قائمة بمالك وعضو + أدمن';
END $$;

-- ============================================================================
-- ⓪ الإنتاج قبل 068
-- ============================================================================
DO $$
DECLARE e text;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  SET LOCAL ROLE authenticated;
  e := t.err($s$select public.upsert_my_company('شركة العميل', 'CR-U1-0', '2030-01-01')$s$);
  RESET ROLE;
  IF e IS DISTINCT FROM 'لا يمكنك تغيير صلاحية حسابك بنفسك' THEN
    RAISE EXCEPTION 'FAIL ⓪a: كان المتوقع رفض الحارس، والناتج: %', e;
  END IF;
  IF EXISTS (SELECT 1 FROM public.companies WHERE user_id = '00000000-0000-4000-8000-0000000000a1') THEN
    RAISE EXCEPTION 'FAIL ⓪a: الشركة اتكتبت رغم الخطأ';
  END IF;
  RAISE NOTICE 'PROVEN GAP ⓪a (قبل 068): حفظ «بيانات الشركة» من العميل بيترفض بـ«%» — المسار معطوب في الإنتاج', e;

  -- جلسة أدمن بلا RLS — بالظبط ما تعمله أي دالة SECURITY DEFINER للموافقة
  -- (عبر PostgREST مباشرةً الإدراج بيقف أبكر، عند سياسة RLS نفسها).
  PERFORM t.act('00000000-0000-4000-8000-0000000000ad');
  e := t.err($s$insert into public.companies (user_id, company_name, commercial_registration_number)
                values ('00000000-0000-4000-8000-0000000000a1', 'شركة', 'CR-U1-0')$s$);
  IF e IS DISTINCT FROM 'أدوار الشركة تُشتق من العلاقة بالشركة ولا تُمنَح يدويًا' THEN
    RAISE EXCEPTION 'FAIL ⓪b: كان المتوقع رفض الحارس للاشتقاق، والناتج: %', e;
  END IF;
  RAISE NOTICE 'PROVEN GAP ⓪b (قبل 068): حتى دالة موافقة بجلسة أدمن تُرفض («%») — مفيش مسار موافقة ممكن', e;
  PERFORM t.act(NULL);
END $$;

-- ============================================================================
-- ① بعد 068
-- ============================================================================
\i migrations/068_company_account_requests.sql
SET search_path = public, extensions;

-- ── R1: العميل يرسل طلبه — لا شركة، لا دور، والإدارة مُخطَرة ────────────────
DO $$
DECLARE r jsonb; admin_notes_before int; admin_notes_after int;
BEGIN
  admin_notes_before := (SELECT count(*) FROM public.notifications WHERE user_id = '00000000-0000-4000-8000-0000000000ad');

  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  SET LOCAL ROLE authenticated;
  r := public.submit_company_account_request('  شركة العميل الأول  ', 'CR-U1-1', '2030-06-30',
                                             'info@u1.co', '0222', 'support', 'yearly');
  RESET ROLE;

  IF r->>'status' <> 'pending' THEN RAISE EXCEPTION 'FAIL R1: الحالة %', r; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.company_account_requests
                  WHERE id = (r->>'id')::uuid AND company_name = 'شركة العميل الأول'
                    AND requested_plan = 'support' AND requested_billing_cycle = 'yearly') THEN
    RAISE EXCEPTION 'FAIL R1: الطلب مااتسجّلش بالبيانات المنظّفة';
  END IF;
  IF EXISTS (SELECT 1 FROM public.companies WHERE user_id = '00000000-0000-4000-8000-0000000000a1')
     OR (SELECT role FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000a1') <> 'user' THEN
    RAISE EXCEPTION 'FAIL R1: الحساب اتحوّل لشركة قبل الموافقة';
  END IF;
  admin_notes_after := (SELECT count(*) FROM public.notifications
                         WHERE user_id = '00000000-0000-4000-8000-0000000000ad'
                           AND link = '/admin/company-requests.html' AND reference_id = (r->>'id')::uuid);
  IF admin_notes_after <> 1 THEN RAISE EXCEPTION 'FAIL R1: الأدمن مااتخطرش'; END IF;
  RAISE NOTICE 'PASS R1: الطلب اتسجّل pending بالباقة المطلوبة، الحساب لسه فرد، والأدمن اتخطر';
END $$;

-- ── R2: تكرار الطلب، السجل المحجوز، والسجل المسجّل ──────────────────────────
DO $$
DECLARE e text;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  SET LOCAL ROLE authenticated;
  e := t.err($s$select public.submit_company_account_request('شركة تانية', 'CR-U1-2', '2030-01-01')$s$);
  RESET ROLE;
  IF e IS DISTINCT FROM 'لديك طلب حساب شركة قيد المراجعة بالفعل' THEN RAISE EXCEPTION 'FAIL R2a: %', e; END IF;

  PERFORM t.act('00000000-0000-4000-8000-0000000000a2');
  SET LOCAL ROLE authenticated;
  e := t.err($s$select public.submit_company_account_request('شركة', 'CR-U1-1', '2030-01-01')$s$);
  IF e IS DISTINCT FROM 'رقم السجل التجاري مرتبط بطلب آخر قيد المراجعة' THEN RESET ROLE; RAISE EXCEPTION 'FAIL R2b: %', e; END IF;
  e := t.err($s$select public.submit_company_account_request('شركة', 'CR-EXIST-1', '2030-01-01')$s$);
  IF e IS DISTINCT FROM 'رقم السجل التجاري مسجل بالفعل' THEN RESET ROLE; RAISE EXCEPTION 'FAIL R2c: %', e; END IF;
  -- مدخلات غلط
  IF t.err($s$select public.submit_company_account_request('ش', 'CR-X', '2030-01-01')$s$) <> 'اسم الشركة مطلوب'
     OR t.err($s$select public.submit_company_account_request('شركة', 'C', '2030-01-01')$s$) <> 'رقم السجل التجاري مطلوب'
     OR t.err($s$select public.submit_company_account_request('شركة', 'CR-X', null)$s$) <> 'تاريخ انتهاء السجل التجاري مطلوب'
     OR t.err($s$select public.submit_company_account_request('شركة', 'CR-X', '2030-01-01', 'ليس بريدًا')$s$) <> 'بريد إلكتروني غير صالح'
     OR t.err($s$select public.submit_company_account_request('شركة', 'CR-X', '2030-01-01', null, null, 'باقة_وهمية')$s$) NOT LIKE 'باقة غير معروفة%'
     OR t.err($s$select public.submit_company_account_request('شركة', 'CR-X', '2030-01-01', null, null, 'support', 'weekly')$s$) NOT LIKE 'دورة فوترة غير معروفة%' THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL R2d: مدخل غلط عدّى';
  END IF;
  RESET ROLE;
  IF (SELECT count(*) FROM public.company_account_requests WHERE user_id = '00000000-0000-4000-8000-0000000000a2') <> 0 THEN
    RAISE EXCEPTION 'FAIL R2: الرفض ساب صفوف';
  END IF;
  -- الفهرس نفسه (لا الفحص في الدالة) هو الضمان مع الضغطتين المتزامنتين
  IF t.try($s$insert into public.company_account_requests (user_id, company_name, commercial_registration_number, commercial_registration_expiry)
              values ('00000000-0000-4000-8000-0000000000a1', 'شركة', 'CR-DUP', '2030-01-01')$s$) <> '23505' THEN
    RAISE EXCEPTION 'FAIL R2e: الفهرس الجزئي مش مانع طلبين pending';
  END IF;
  RAISE NOTICE 'PASS R2: طلب pending واحد للحساب (بالفهرس)، السجل المحجوز/المسجّل مرفوض، والمدخلات الغلط مرفوضة بلا أثر';
END $$;

-- ── R3: العزل — لا كتابة مباشرة، ولا قراءة طلبات الغير ─────────────────────
DO $$
DECLARE n int; s text;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  SET LOCAL ROLE authenticated;
  IF t.try($s$update public.company_account_requests set status = 'approved'$s$) <> '42501'
     OR t.try($s$insert into public.company_account_requests (user_id, company_name, commercial_registration_number, commercial_registration_expiry, status)
                values ('00000000-0000-4000-8000-0000000000a1', 'شركة', 'CR-SELF', '2030-01-01', 'approved')$s$) <> '42501'
     OR t.try($s$delete from public.company_account_requests$s$) <> '42501' THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL R3a: العميل قدر يكتب في الجدول مباشرة';
  END IF;
  SELECT count(*) INTO n FROM public.company_account_requests;
  s := public.my_company_account_request()->>'status';
  RESET ROLE;
  IF n <> 1 OR s <> 'pending' THEN RAISE EXCEPTION 'FAIL R3b: U1 شايف % طلب، حالته %', n, s; END IF;

  PERFORM t.act('00000000-0000-4000-8000-0000000000a2');
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM public.company_account_requests;
  IF n <> 0 OR public.my_company_account_request() IS NOT NULL THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL R3c: U2 شايف طلب غيره';
  END IF;
  IF t.try($s$select public.admin_list_company_account_requests()$s$) <> '42501'
     OR t.try(format($f$select public.admin_review_company_account_request(%L, 'approve')$f$,
                     (SELECT id FROM public.company_account_requests LIMIT 1))) <> '42501' THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL R3d: عميل نادى دوال الإدارة';
  END IF;
  RESET ROLE;
  SET LOCAL ROLE anon;
  IF t.try($s$select * from public.company_account_requests$s$) <> '42501'
     OR t.try($s$select public.submit_company_account_request('شركة', 'CR-ANON', '2030-01-01')$s$) <> '42501' THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL R3e: anon وصل للجدول أو الدالة';
  END IF;
  RESET ROLE;
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS R3: لا كتابة مباشرة (42501)، كل حساب يقرأ طلبه بس، دوال الإدارة مقفولة على العميل، و anon برا';
END $$;

-- ── R4: الإنشاء الذاتي مقفول من كل باب ────────────────────────────────────
DO $$
DECLARE e text;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000a2');
  SET LOCAL ROLE authenticated;
  e := t.err($s$select public.upsert_my_company('شركة', 'CR-U2-1', '2030-01-01')$s$);
  IF e IS DISTINCT FROM 'إنشاء حساب شركة يتم بطلب يراجعه فريق الإدارة' THEN RESET ROLE; RAISE EXCEPTION 'FAIL R4a: %', e; END IF;
  IF t.try($s$insert into public.companies (user_id, company_name, commercial_registration_number)
              values ('00000000-0000-4000-8000-0000000000a2', 'شركة', 'CR-U2-1')$s$) <> '42501' THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL R4b: الإدراج المباشر في companies لسه مفتوح';
  END IF;
  RESET ROLE;

  -- العضو والمنتظر ومالك الشركة: لا طلبات
  PERFORM t.act('00000000-0000-4000-8000-0000000000c9');
  SET LOCAL ROLE authenticated;
  e := t.err($s$select public.submit_company_account_request('شركة', 'CR-CM', '2030-01-01')$s$);
  IF e IS DISTINCT FROM 'حسابك عضو في شركة قائمة بالفعل' THEN RESET ROLE; RAISE EXCEPTION 'FAIL R4c: %', e; END IF;
  RESET ROLE;
  PERFORM t.act('00000000-0000-4000-8000-0000000000c0');
  SET LOCAL ROLE authenticated;
  e := t.err($s$select public.submit_company_account_request('شركة', 'CR-CO', '2030-01-01')$s$);
  IF e IS DISTINCT FROM 'حسابك حساب شركة بالفعل' THEN RESET ROLE; RAISE EXCEPTION 'FAIL R4d: %', e; END IF;
  -- مالك الشركة القائمة لسه بيعدّل بياناتها من لوحته (مسار التحديث كما هو)
  PERFORM public.upsert_my_company('شركة قائمة معدّلة', 'CR-EXIST-1', '2031-01-01', 'new@co.io');
  RESET ROLE;
  IF NOT EXISTS (SELECT 1 FROM public.companies WHERE user_id = '00000000-0000-4000-8000-0000000000c0'
                  AND company_name = 'شركة قائمة معدّلة' AND company_email = 'new@co.io') THEN
    RAISE EXCEPTION 'FAIL R4e: مالك الشركة ماقدرش يحدّث بياناتها';
  END IF;
  PERFORM t.act('00000000-0000-4000-8000-0000000000aa');
  SET LOCAL ROLE authenticated;
  IF t.try($s$select public.submit_company_account_request('شركة', 'CR-UW', '2030-01-01')$s$) <> '42501' THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL R4f: حساب في قائمة الانتظار بعت طلب';
  END IF;
  RESET ROLE;
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS R4: upsert_my_company والإدراج المباشر مايُنشئوش شركة؛ العضو/المالك/المنتظر مرفوضين؛ تحديث المالك لشركته شغال';
END $$;

-- ── R5: الأدمن يوافق ⇒ الحساب يصير حساب شركة بالاشتقاق ─────────────────────
DO $$
DECLARE req uuid; r jsonb; cid uuid; list jsonb;
BEGIN
  SELECT id INTO req FROM public.company_account_requests WHERE user_id = '00000000-0000-4000-8000-0000000000a1';

  PERFORM t.act('00000000-0000-4000-8000-0000000000ad');
  SET LOCAL ROLE authenticated;
  list := public.admin_list_company_account_requests();
  IF jsonb_array_length(list) <> 1 OR list->0->>'customer_email' <> 'u1@t.io'
     OR list->0->>'requested_plan_name_ar' IS NULL THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL R5a: قائمة الإدارة %', list;
  END IF;
  r := public.admin_review_company_account_request(req, 'approve');
  RESET ROLE;

  cid := (r->>'company_id')::uuid;
  IF r->>'status' <> 'approved' OR cid IS NULL THEN RAISE EXCEPTION 'FAIL R5b: %', r; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = cid AND user_id = '00000000-0000-4000-8000-0000000000a1'
                  AND company_name = 'شركة العميل الأول' AND commercial_registration_number = 'CR-U1-1'
                  AND commercial_registration_expiry = '2030-06-30' AND company_email = 'info@u1.co') THEN
    RAISE EXCEPTION 'FAIL R5c: الشركة مااتكوّنتش ببيانات الطلب';
  END IF;
  IF (SELECT role FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000a1') <> 'company_admin'
     OR (SELECT user_type FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000a1') <> 'company' THEN
    RAISE EXCEPTION 'FAIL R5d: الحساب مااتحوّلش لحساب شركة';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.company_account_requests WHERE id = req AND status = 'approved'
                  AND company_id = cid AND reviewed_by = '00000000-0000-4000-8000-0000000000ad' AND reviewed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL R5e: الطلب ماتقفلش بالمراجِع والشركة';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.notifications WHERE user_id = '00000000-0000-4000-8000-0000000000a1'
                  AND reference_id = req AND link = '/subscriptions.html' AND message LIKE '%أكمل الآن الاشتراك%') THEN
    RAISE EXCEPTION 'FAIL R5f: العميل مااتخطرش يكمل الاشتراك';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.privileged_audit WHERE action = 'role.change'
                  AND target_user_id = '00000000-0000-4000-8000-0000000000a1'
                  AND actor_id = '00000000-0000-4000-8000-0000000000ad') THEN
    RAISE EXCEPTION 'FAIL R5g: تغيير الدور مااتسجّلش في التدقيق باسم الأدمن';
  END IF;

  -- من جلسة العميل نفسه: دوال الشركة القائمة شايفاه مدير شركته
  PERFORM t.act('00000000-0000-4000-8000-0000000000a1');
  SET LOCAL ROLE authenticated;
  IF public.current_company_id() IS DISTINCT FROM cid OR NOT public.is_company_admin()
     OR public.company_role() <> 'company_admin' OR NOT public.account_is_active()
     OR public.my_company_account_request()->>'status' <> 'approved' THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL R5h: دوال الشركة مش شايفة الحساب كمدير شركة';
  END IF;
  -- والطلب الجديد بعد الموافقة مرفوض
  IF t.err($s$select public.submit_company_account_request('شركة', 'CR-U1-9', '2030-01-01')$s$) <> 'حسابك حساب شركة بالفعل' THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL R5i: حساب الشركة قدر يبعت طلب تاني';
  END IF;
  RESET ROLE;

  -- مراجعة مكررة
  PERFORM t.act('00000000-0000-4000-8000-0000000000ad');
  SET LOCAL ROLE authenticated;
  IF t.err(format($f$select public.admin_review_company_account_request(%L, 'reject', 'x')$f$, req))
       <> 'تمت مراجعة هذا الطلب بالفعل' THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL R5j: الطلب اتراجع مرتين';
  END IF;
  RESET ROLE;
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS R5: الموافقة ⇒ شركة ببيانات الطلب، company_admin بالاشتقاق (ومسجّل في التدقيق باسم الأدمن)، user_type=company، إخطار بإكمال الاشتراك، ولا مراجعة تانية';
END $$;

-- ── R6: الرفض يحتاج سببًا، يُخطر العميل، ويسمح بطلب جديد ───────────────────
DO $$
DECLARE req uuid; r jsonb;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000a2');
  SET LOCAL ROLE authenticated;
  r := public.submit_company_account_request('شركة العميل التاني', 'CR-U2-1', '2030-01-01');
  RESET ROLE;
  req := (r->>'id')::uuid;

  PERFORM t.act('00000000-0000-4000-8000-0000000000ad');
  SET LOCAL ROLE authenticated;
  IF t.err(format($f$select public.admin_review_company_account_request(%L, 'reject', '   ')$f$, req))
       <> 'سبب الرفض مطلوب ليظهر للعميل'
     OR t.err(format($f$select public.admin_review_company_account_request(%L, 'maybe')$f$, req)) NOT LIKE 'قرار غير معروف%'
     OR t.err(format($f$select public.admin_review_company_account_request(%L, 'approve')$f$, gen_random_uuid())) <> 'الطلب غير موجود' THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL R6a: مراجعة ناقصة عدّت';
  END IF;
  r := public.admin_review_company_account_request(req, 'reject', 'صورة السجل غير واضحة');
  RESET ROLE;

  IF r->>'status' <> 'rejected'
     OR EXISTS (SELECT 1 FROM public.companies WHERE user_id = '00000000-0000-4000-8000-0000000000a2')
     OR (SELECT role FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000a2') <> 'user' THEN
    RAISE EXCEPTION 'FAIL R6b: الرفض غيّر الحساب';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.notifications WHERE user_id = '00000000-0000-4000-8000-0000000000a2'
                  AND reference_id = req AND message LIKE '%صورة السجل غير واضحة%') THEN
    RAISE EXCEPTION 'FAIL R6c: سبب الرفض ماوصلش للعميل';
  END IF;

  PERFORM t.act('00000000-0000-4000-8000-0000000000a2');
  SET LOCAL ROLE authenticated;
  IF public.my_company_account_request()->>'review_note' <> 'صورة السجل غير واضحة' THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL R6d: العميل مش شايف سبب الرفض';
  END IF;
  -- نفس السجل بعد الرفض مسموح (الحجز كان للطلب pending بس)
  r := public.submit_company_account_request('شركة العميل التاني', 'CR-U2-1', '2030-01-01');
  IF public.my_company_account_request()->>'status' <> 'pending' THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL R6e: الطلب الجديد مش هو اللي ظاهر';
  END IF;
  RESET ROLE;
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS R6: الرفض بسبب إلزامي، الحساب ماتغيّرش، السبب وصل للعميل، وقدر يبعت طلب جديد';
END $$;

-- ── R7: الموافقة تعيد فحص الحال وقتها ─────────────────────────────────────
DO $$
DECLARE req uuid; e text;
BEGIN
  -- U3 يطلب، وبعدين نفس السجل يتسجّل لشركة تانية قبل المراجعة
  PERFORM t.act('00000000-0000-4000-8000-0000000000a3');
  SET LOCAL ROLE authenticated;
  req := (public.submit_company_account_request('شركة تلاتة', 'CR-U3-1', '2030-01-01')->>'id')::uuid;
  RESET ROLE;
  PERFORM t.act(NULL);
  UPDATE public.companies SET commercial_registration_number = 'CR-U3-1'
   WHERE user_id = '00000000-0000-4000-8000-0000000000c0';

  PERFORM t.act('00000000-0000-4000-8000-0000000000ad');
  SET LOCAL ROLE authenticated;
  e := t.err(format($f$select public.admin_review_company_account_request(%L, 'approve')$f$, req));
  RESET ROLE;
  IF e IS DISTINCT FROM 'رقم السجل التجاري مسجل لشركة أخرى' THEN RAISE EXCEPTION 'FAIL R7: %', e; END IF;
  IF (SELECT status FROM public.company_account_requests WHERE id = req) <> 'pending'
     OR (SELECT role FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000a3') <> 'user' THEN
    RAISE EXCEPTION 'FAIL R7: الموافقة الفاشلة سابت أثر';
  END IF;
  PERFORM t.act(NULL);
  UPDATE public.companies SET commercial_registration_number = 'CR-EXIST-1'
   WHERE user_id = '00000000-0000-4000-8000-0000000000c0';
  RAISE NOTICE 'PASS R7: الموافقة بتفحص السجل وقتها — مسجّل لشركة تانية ⇒ رفض صريح والطلب يفضل pending';
END $$;

-- ── R8: الحارس — منح دور الشركة يدويًا لسه مرفوض حتى للأدمن ────────────────
DO $$
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000ad');
  SET LOCAL ROLE authenticated;
  -- U3 بلا شركة
  IF t.try($s$update public.profiles set role = 'company_admin' where id = '00000000-0000-4000-8000-0000000000a3'$s$) <> '42501'
     OR t.try($s$update public.profiles set role = 'company_user' where id = '00000000-0000-4000-8000-0000000000a3'$s$) <> '42501' THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL R8a: الأدمن منح دور شركة لحساب بلا شركة';
  END IF;
  -- العضو يترقّى لمدير يدويًا (بيملك علاقة، بس مش ملكية) — مرفوض
  IF t.try($s$update public.profiles set role = 'company_admin' where id = '00000000-0000-4000-8000-0000000000c9'$s$) <> '42501' THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL R8b: عضو اترقّى لمدير يدويًا';
  END IF;
  RESET ROLE;
  -- العميل يرقّي نفسه
  PERFORM t.act('00000000-0000-4000-8000-0000000000a3');
  SET LOCAL ROLE authenticated;
  IF t.try($s$update public.profiles set role = 'company_admin' where id = '00000000-0000-4000-8000-0000000000a3'$s$) <> '42501' THEN
    RESET ROLE; RAISE EXCEPTION 'FAIL R8c: العميل رقّى نفسه';
  END IF;
  RESET ROLE;
  PERFORM t.act(NULL);
  RAISE NOTICE 'PASS R8: المنح اليدوي لأدوار الشركة (من الأدمن أو من العميل لنفسه) لسه مرفوض — الاستثناء للمحفّز المطابق للعلاقة بس';
END $$;

-- ============================================================================
-- ② التراجع وإعادة التطبيق
-- ============================================================================
\i migrations/_rollback/068_company_account_requests.down.sql
DO $$
DECLARE e text;
BEGIN
  IF to_regclass('public.company_account_requests') IS NOT NULL
     OR to_regprocedure('public.submit_company_account_request(text,text,date,text,text,text,text)') IS NOT NULL
     OR to_regprocedure('public.admin_review_company_account_request(uuid,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL RB1: التراجع ساب كائنات 068';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.companies'::regclass
                  AND polname = 'Users can insert their own company') THEN
    RAISE EXCEPTION 'FAIL RB1: سياسة الإدراج مارجعتش';
  END IF;
  -- السلوك رجع لنص الإنتاج: العميل يحاول ينشئ فيترفض بالحارس، مش برسالة 068
  PERFORM t.act('00000000-0000-4000-8000-0000000000a3');
  SET LOCAL ROLE authenticated;
  e := t.err($s$select public.upsert_my_company('شركة', 'CR-RB', '2030-01-01')$s$);
  RESET ROLE;
  PERFORM t.act(NULL);
  IF e IS DISTINCT FROM 'لا يمكنك تغيير صلاحية حسابك بنفسك' THEN RAISE EXCEPTION 'FAIL RB1: %', e; END IF;
  -- الشركات اللي اتوافق عليها باقية (مفيش حذف بيانات)
  IF (SELECT role FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000a1') <> 'company_admin' THEN
    RAISE EXCEPTION 'FAIL RB1: التراجع شال شركة متوافق عليها';
  END IF;
  RAISE NOTICE 'PASS RB1: التراجع بيرجّع نصوص الإنتاج والسياسة، ويشيل الجدول والدوال، والشركات المعتمدة باقية';
END $$;

\i migrations/068_company_account_requests.sql
SET search_path = public, extensions;
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.act('00000000-0000-4000-8000-0000000000a3');
  SET LOCAL ROLE authenticated;
  r := public.submit_company_account_request('شركة تلاتة', 'CR-U3-2', '2030-01-01');
  RESET ROLE;
  PERFORM t.act('00000000-0000-4000-8000-0000000000ad');
  SET LOCAL ROLE authenticated;
  r := public.admin_review_company_account_request((r->>'id')::uuid, 'approve', 'تم التحقق');
  RESET ROLE;
  PERFORM t.act(NULL);
  IF (SELECT role FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000a3') <> 'company_admin'
     OR NOT EXISTS (SELECT 1 FROM public.notifications WHERE user_id = '00000000-0000-4000-8000-0000000000a3'
                     AND link = '/company-dashboard/') THEN
    RAISE EXCEPTION 'FAIL RB2: إعادة التطبيق مش شغالة';
  END IF;
  RAISE NOTICE 'PASS RB2: إعادة التطبيق idempotent والمسار كامل (طلب بلا باقة ⇒ الإخطار يودّي للوحة الشركة)';
END $$;

SELECT 'ALL COMPANY ACCOUNT REQUEST TESTS PASSED';
