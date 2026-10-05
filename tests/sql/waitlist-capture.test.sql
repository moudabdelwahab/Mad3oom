-- اختبار تنفيذي لـ migrations/066_waitlist_capture_all_signups.sql
-- كل حساب جديد غير معتمَد يدخل قائمة الانتظار مهما كانت طريقة تسجيله.
-- دوال البوابة هنا منسوخة كما هي في الإنتاج (042).
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true),'')::uuid; $$;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_app_meta_data jsonb DEFAULT '{}', raw_user_meta_data jsonb DEFAULT '{}');
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
END $$;
GRANT USAGE ON SCHEMA auth, public TO authenticated, anon;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, email text, full_name text, first_name text, last_name text, phone text,
  role text DEFAULT 'user', super_user_id uuid, created_at timestamptz DEFAULT now()
);
-- كما في 004 و009
CREATE TABLE public.waitlist_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(btrim(name)) > 0),
  email text NOT NULL CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
  phone text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz, reviewed_by uuid,
  approved_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX waitlist_entries_active_email_idx ON public.waitlist_entries (lower(email)) WHERE status <> 'rejected';
ALTER TABLE public.waitlist_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY waitlist_entries_admin_all ON public.waitlist_entries FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.waitlist_entries TO authenticated;
GRANT SELECT ON public.profiles TO authenticated;

CREATE FUNCTION public.gate_cutoff() RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$ SELECT timestamptz '2026-09-16 00:00:00+00'; $$;
CREATE FUNCTION public.gate_is_exempt_account(p_user_id uuid DEFAULT auth.uid()) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT p_user_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user_id AND lower(p.email) = 'mahmoud@mad3oom.com');
$$;
CREATE FUNCTION public.account_is_whitelisted(p_user_id uuid DEFAULT auth.uid()) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  with me as (select p.id, lower(p.email) as email, p.role, p.created_at from public.profiles p where p.id = p_user_id)
  select p_user_id is not null and exists (select 1 from me) and (
    public.gate_is_exempt_account(p_user_id)
    or (select role from me) in ('admin','support','platform_owner','company_admin','company_user')
    or exists (select 1 from public.waitlist_entries w where w.status = 'approved'
                 and (w.approved_user_id = p_user_id or lower(w.email) = (select email from me)))
    or ((select created_at from me) < public.gate_cutoff()
        and not exists (select 1 from public.waitlist_entries w where w.status in ('pending','rejected')
                          and (w.approved_user_id = p_user_id or lower(w.email) = (select email from me)))));
$$;
-- is_admin في الإنتاج: role = admin أو قدرة admin لمالك المنصة.
CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','platform_owner'));
$$;

-- مساعد: إنشاء حساب كما يفعل Supabase (auth.users ثم handle_new_user → profiles)
CREATE FUNCTION pg_temp.mk(p_email text, p_provider text, p_meta jsonb, p_created timestamptz DEFAULT now(), p_role text DEFAULT 'user')
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (v, p_email, jsonb_build_object('provider', p_provider), p_meta);
  INSERT INTO public.profiles (id, email, first_name, last_name, role, created_at)
  VALUES (v, p_email, p_meta->>'first_name', p_meta->>'last_name', p_role, p_created);
  RETURN v;
END $$;

-- ── بيانات قبل الترحيل (حالة الإنتاج) ──────────────────────────────────────
SELECT pg_temp.mk('g1@gmail.com', 'google', '{"full_name":"ام صلاح"}', '2026-10-01');
SELECT pg_temp.mk('aposuriye686@gmail.com', 'google', '{"name":"Apo"}', '2026-09-01');
SELECT pg_temp.mk('oldkeep@gmail.com', 'google', '{}', '2026-08-01');
SELECT pg_temp.mk('rej@gmail.com', 'google', '{}', '2026-09-20');
INSERT INTO public.waitlist_entries (name, email, status) VALUES ('مرفوض', 'rej@gmail.com', 'rejected');
INSERT INTO public.waitlist_entries (name, email) VALUES ('من النموذج', 'form1@gmail.com');
SELECT pg_temp.mk('form1@gmail.com', 'email', '{}', '2026-09-22');
SELECT pg_temp.mk('member@gmail.com', 'email', '{}', '2026-09-22', 'company_user');

DO $$ BEGIN
  ASSERT public.account_is_whitelisted((SELECT id FROM public.profiles WHERE email='aposuriye686@gmail.com')),
    'قبل الترحيل: الحساب القديم معفى';
  ASSERT (SELECT count(*) FROM public.waitlist_entries) = 2, 'قبل الترحيل: الحسابات الجديدة خارج القائمة (المشكلة)';
END $$;

\echo '--- applying migrations/066 ---'
\i migrations/066_waitlist_capture_all_signups.sql

-- ── A) الإدراج الرجعي ──────────────────────────────────────────────────────
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.waitlist_entries WHERE email = 'g1@gmail.com';
  ASSERT r.status = 'pending' AND r.source = 'google' AND r.name = 'ام صلاح'
     AND r.approved_user_id = (SELECT id FROM public.profiles WHERE email='g1@gmail.com')
     AND r.created_at = '2026-10-01'::timestamptz, 'حساب Google الناقص أُضيف بتاريخ تسجيله';
  RAISE NOTICE 'PASS A1: حساب Google الناقص صار في القائمة';

  ASSERT (SELECT name FROM public.waitlist_entries WHERE email='aposuriye686@gmail.com') = 'Apo', 'القديم المطلوب أُضيف';
  ASSERT NOT public.account_is_whitelisted((SELECT id FROM public.profiles WHERE email='aposuriye686@gmail.com')),
    'القديم المطلوب صار بانتظار الموافقة';
  ASSERT NOT EXISTS (SELECT 1 FROM public.waitlist_entries WHERE email='oldkeep@gmail.com'), 'القديم غير المطلوب لم يُلمس';
  ASSERT public.account_is_whitelisted((SELECT id FROM public.profiles WHERE email='oldkeep@gmail.com')), 'وبقي معفى';
  RAISE NOTICE 'PASS A2: الحسابات القديمة المطلوبة فقط دخلت القائمة';

  ASSERT (SELECT count(*) FROM public.waitlist_entries WHERE email='rej@gmail.com') = 1, 'المرفوض لا يُعاد إدراجه';
  ASSERT (SELECT approved_user_id FROM public.waitlist_entries WHERE email='form1@gmail.com')
       = (SELECT id FROM public.profiles WHERE email='form1@gmail.com'), 'طلب النموذج رُبط بحسابه';
  ASSERT (SELECT count(*) FROM public.waitlist_entries WHERE email='form1@gmail.com') = 1, 'بلا تكرار';
  ASSERT NOT EXISTS (SELECT 1 FROM public.waitlist_entries WHERE email='member@gmail.com'), 'عضو الشركة خارج القائمة';
  RAISE NOTICE 'PASS A3: لا مرفوض يُعاد، ولا تكرار، ولا أعضاء شركات';
END $$;

-- ── B) التسجيل الجديد عبر Google بعد الترحيل ───────────────────────────────
DO $$
DECLARE v uuid; r record;
BEGIN
  v := pg_temp.mk('NewG@Gmail.com', 'google', '{"full_name":"عميل جديد"}');
  SELECT * INTO r FROM public.waitlist_entries WHERE approved_user_id = v;
  ASSERT r.status = 'pending' AND r.source = 'google' AND r.email = 'newg@gmail.com' AND r.name = 'عميل جديد',
    'تسجيل Google يدخل القائمة تلقائيًا';
  ASSERT NOT public.account_is_whitelisted(v), 'ويبقى محجوبًا حتى الموافقة';
  RAISE NOTICE 'PASS B1: تسجيل Google الجديد يدخل القائمة تلقائيًا';

  v := pg_temp.mk('gh@users.dev', 'github', '{"name":"octo"}');
  ASSERT (SELECT source FROM public.waitlist_entries WHERE approved_user_id = v) = 'github', 'GitHub';
  v := pg_temp.mk('direct@x.com', 'email', '{"first_name":"أحمد","last_name":"علي"}');
  ASSERT (SELECT name || '|' || source FROM public.waitlist_entries WHERE approved_user_id = v) = 'أحمد علي|email',
    'signUp مباشر بالبريد';
  RAISE NOTICE 'PASS B2: GitHub والتسجيل المباشر كذلك';
END $$;

-- ── C) مسار الموافقة (approve-waitlist-entry) لا ينشئ طلبًا مكررًا ─────────
DO $$
DECLARE e uuid; v uuid;
BEGIN
  INSERT INTO public.waitlist_entries (name, email) VALUES ('زائر', 'visitor@gmail.com') RETURNING id INTO e;
  v := pg_temp.mk('visitor@gmail.com', 'email', '{"full_name":"زائر","source":"waitlist"}');
  ASSERT (SELECT count(*) FROM public.waitlist_entries WHERE lower(email)='visitor@gmail.com') = 1, 'بلا تكرار';
  ASSERT (SELECT approved_user_id FROM public.waitlist_entries WHERE id = e) = v, 'الطلب رُبط بالحساب الجديد';
  UPDATE public.waitlist_entries SET status = 'approved' WHERE id = e;
  ASSERT public.account_is_whitelisted(v), 'وبعد الموافقة يُفتح الحساب';
  RAISE NOTICE 'PASS C: الموافقة على طلب نموذج تربطه بالحساب بلا تكرار';
END $$;

-- ── D) الطاقم وأعضاء الشركات وبريد غير صالح ────────────────────────────────
DO $$
DECLARE v uuid;
BEGIN
  v := pg_temp.mk('agent@mad3oom.com', 'email', '{}', now(), 'support');
  ASSERT NOT EXISTS (SELECT 1 FROM public.waitlist_entries WHERE approved_user_id = v), 'الطاقم خارج القائمة';

  v := pg_temp.mk('later-staff@mad3oom.com', 'email', '{}');
  ASSERT EXISTS (SELECT 1 FROM public.waitlist_entries WHERE approved_user_id = v), 'أُنشئ كمستخدم أولًا';
  UPDATE public.profiles SET role = 'support' WHERE id = v;
  ASSERT NOT EXISTS (SELECT 1 FROM public.waitlist_entries WHERE approved_user_id = v), 'وطلبه التلقائي حُذف لما صار من الطاقم';

  v := gen_random_uuid();
  INSERT INTO auth.users (id, email) VALUES (v, NULL);
  INSERT INTO public.profiles (id, email) VALUES (v, NULL);
  ASSERT EXISTS (SELECT 1 FROM public.profiles WHERE id = v), 'حساب بلا بريد لا يسقط';
  RAISE NOTICE 'PASS D: الطاقم خارج القائمة، ولا يسقط أي تسجيل';
END $$;

-- ── E) خطأ داخل المحفّز لا يُسقط إنشاء الحساب ──────────────────────────────
ALTER TABLE public.waitlist_entries ADD CONSTRAINT tmp_block CHECK (name <> 'يسقط');
DO $$
DECLARE v uuid;
BEGIN
  v := pg_temp.mk('boom@gmail.com', 'google', '{"full_name":"يسقط"}');
  ASSERT EXISTS (SELECT 1 FROM public.profiles WHERE id = v), 'الحساب أُنشئ رغم فشل الإدراج';
  ASSERT NOT EXISTS (SELECT 1 FROM public.waitlist_entries WHERE approved_user_id = v), 'والإدراج الفاشل لم يترك أثرًا';
  RAISE NOTICE 'PASS E: فشل الإضافة للقائمة لا يمنع التسجيل';
END $$;
ALTER TABLE public.waitlist_entries DROP CONSTRAINT tmp_block;

-- ── F) مالك المنصة يرى القائمة ويديرها، والمستخدم العادي لا ────────────────
INSERT INTO public.profiles (id, email, role) VALUES ('00000000-0000-0000-0000-0000000000aa', 'owner@x.com', 'platform_owner');
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000aa', false);
SET ROLE authenticated;
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM public.waitlist_entries) > 5, 'المالك يرى الطلبات';
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', (SELECT id::text FROM public.profiles WHERE email='g1@gmail.com'), false);
SET ROLE authenticated;
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM public.waitlist_entries) = 0, 'المستخدم العادي لا يرى شيئًا';
  RAISE NOTICE 'PASS F: مالك المنصة يدير القائمة، والعميل لا يراها';
END $$;
RESET ROLE;

\echo ''
\echo 'ALL waitlist-capture tests passed'
