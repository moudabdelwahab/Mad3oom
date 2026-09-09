-- اختبار تنفيذي لـ 025 — نزع الرتبة القديمة من سياسات الطاقم.
--
-- الثغرة (N6): الرتبة super_user كانت في مصفوفة الطاقم داخل 22 سياسة RLS، فمالك
-- الشركة — وهو ليس أدمن — يقرأ نشاط تذاكر كل العملاء ومرفقاتهم وفواتيرهم،
-- ويملك CRUD كاملًا على الملاحظات الداخلية عنهم. مُثبَت على الإنتاج قراءةً.
--
-- الاختبار يبدأ بإثبات التسريب على الحالة القديمة (ضابط سلبي مدمج).
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
END $$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, email text, role text NOT NULL DEFAULT 'user', super_user_id uuid
);
CREATE TABLE public.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE, company_name text NOT NULL
);
CREATE TABLE public.ticket_activity (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ticket_id uuid, note text);
CREATE TABLE public.ticket_attachments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ticket_id uuid, path text);
CREATE TABLE public.ticket_ratings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), score int);
CREATE TABLE public.ticket_tags (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
CREATE TABLE public.ticket_tag_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tag_id uuid);
CREATE TABLE public.canned_responses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), body text);
CREATE TABLE public.customer_notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, note text);
CREATE TABLE public.accounting_invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, total numeric);
CREATE TABLE public.webhooks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), url text);
CREATE TABLE public.webhook_deliveries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), webhook_id uuid);
CREATE TABLE public.badge_definitions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, is_active boolean DEFAULT true);
CREATE TABLE public.customer_badges (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
-- يقرأها تقرير ما قبل التنفيذ في 026 (هل للحساب اشتراك فعّال؟)
CREATE TABLE public.whatsapp_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  status text DEFAULT 'active', plan text NOT NULL DEFAULT 'bundle',
  start_date timestamptz DEFAULT now(), end_date timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN RETURN EXISTS (SELECT 1 FROM public.profiles WHERE id=auth.uid() AND role='admin'); END; $$;
CREATE OR REPLACE FUNCTION public.is_main_admin() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN RETURN COALESCE((SELECT email FROM public.profiles WHERE id=auth.uid())
  IN ('support@mad3oom.online','info@mad3oom.online'), false); END; $$;

-- نسخة 024 من تعريف الطاقم (هذا الاختبار يفحص 025 و 026 وحدهما)
CREATE OR REPLACE FUNCTION public.is_platform_staff() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles
    WHERE id=auth.uid()
      AND (role IN ('admin','support')
           OR email IN ('support@mad3oom.online','info@mad3oom.online')));
$$;

-- ==== السياسات كما هي في الإنتاج قبل 025 ====
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ticket_activity','ticket_attachments','ticket_ratings','ticket_tags',
                           'ticket_tag_links','canned_responses','customer_notes','accounting_invoices',
                           'webhooks','webhook_deliveries','badge_definitions','customer_badges','profiles']
  LOOP EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t); END LOOP;
END $$;

CREATE POLICY "Staff can view activity" ON public.ticket_activity FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id=auth.uid()
    AND profiles.role = ANY (ARRAY['admin','support','super_user'])));
CREATE POLICY "Staff can insert activity" ON public.ticket_activity FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE profiles.id=auth.uid()
    AND profiles.role = ANY (ARRAY['admin','support','super_user'])));
CREATE POLICY "Staff can view all attachments" ON public.ticket_attachments FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id=auth.uid()
    AND profiles.role = ANY (ARRAY['admin','support','super_user'])));
CREATE POLICY "Staff can upload attachments" ON public.ticket_attachments FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE profiles.id=auth.uid()
    AND profiles.role = ANY (ARRAY['admin','support','super_user'])));
CREATE POLICY "Staff can delete attachments" ON public.ticket_attachments FOR DELETE
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id=auth.uid()
    AND profiles.role = ANY (ARRAY['admin','support','super_user'])));
CREATE POLICY "Staff can view all ratings" ON public.ticket_ratings FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id=auth.uid()
    AND profiles.role = ANY (ARRAY['admin','support','super_user'])));
CREATE POLICY "Staff can view tags" ON public.ticket_tags FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id=auth.uid()
    AND profiles.role = ANY (ARRAY['admin','support','super_user'])));
CREATE POLICY "Staff can view tag links" ON public.ticket_tag_links FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id=auth.uid()
    AND profiles.role = ANY (ARRAY['admin','support','super_user'])));
CREATE POLICY "Staff can manage tag links" ON public.ticket_tag_links FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id=auth.uid()
    AND profiles.role = ANY (ARRAY['admin','support','super_user'])));
CREATE POLICY "Staff can view canned responses" ON public.canned_responses FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id=auth.uid()
    AND profiles.role = ANY (ARRAY['admin','support','super_user'])));
CREATE POLICY "Admins can view customer notes" ON public.customer_notes FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id=auth.uid()
    AND profiles.role = ANY (ARRAY['admin','support','super_user'])));
CREATE POLICY "Admins can insert customer notes" ON public.customer_notes FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE profiles.id=auth.uid()
    AND profiles.role = ANY (ARRAY['admin','support','super_user'])));
CREATE POLICY "Admins can update their own notes" ON public.customer_notes FOR UPDATE
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id=auth.uid()
    AND profiles.role = ANY (ARRAY['admin','support','super_user'])));
CREATE POLICY "Admins can delete customer notes" ON public.customer_notes FOR DELETE
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id=auth.uid()
    AND profiles.role = ANY (ARRAY['admin','support','super_user'])));
CREATE POLICY "own_invoices_select" ON public.accounting_invoices FOR SELECT
  USING ((user_id=auth.uid()) OR EXISTS (SELECT 1 FROM profiles p WHERE p.id=auth.uid()
    AND p.role = ANY (ARRAY['admin','super_user'])));
CREATE POLICY "Admins can manage webhooks" ON public.webhooks FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id=auth.uid()
    AND profiles.role = ANY (ARRAY['admin','super_user'])));
CREATE POLICY "Admins can view webhook deliveries" ON public.webhook_deliveries FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id=auth.uid()
    AND profiles.role = ANY (ARRAY['admin','super_user'])));
CREATE POLICY "badge_definitions_admin_write" ON public.badge_definitions FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id=auth.uid()
    AND p.role = ANY (ARRAY['admin','support','super_user'])));
CREATE POLICY "badge_definitions_select_active" ON public.badge_definitions FOR SELECT
  USING ((is_active=true) OR EXISTS (SELECT 1 FROM profiles p WHERE p.id=auth.uid()
    AND p.role = ANY (ARRAY['admin','support','super_user'])));
CREATE POLICY "customer_badges_select_own" ON public.customer_badges FOR SELECT
  USING ((user_id=auth.uid()) OR EXISTS (SELECT 1 FROM profiles p WHERE p.id=auth.uid()
    AND p.role = ANY (ARRAY['admin','support','super_user'])));
CREATE POLICY profiles_select_policy ON public.profiles FOR SELECT
  USING ((auth.uid()=id) OR public.is_main_admin() OR (super_user_id=auth.uid()));
CREATE POLICY profiles_delete_policy ON public.profiles FOR DELETE
  USING (public.is_main_admin() OR ((super_user_id=auth.uid()) AND (role <> 'super_user')));

GRANT USAGE ON SCHEMA public TO authenticated, anon;
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;

INSERT INTO public.profiles (id,email,role,super_user_id) VALUES
  ('a0000000-0000-4000-8000-000000000001','owner@test.local','super_user',NULL),
  ('a0000000-0000-4000-8000-000000000002','member@test.local','user','a0000000-0000-4000-8000-000000000001'),
  ('90000000-0000-4000-8000-000000000001','admin@test.local','admin',NULL),
  ('e0000000-0000-4000-8000-000000000001','solo@test.local','user',NULL);
INSERT INTO public.companies (id,user_id,company_name)
  VALUES ('c1c1c1c1-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','شركة أ');

INSERT INTO public.ticket_activity (note) SELECT 'نشاط '||g FROM generate_series(1,5) g;
INSERT INTO public.ticket_attachments (path) SELECT 'proof-'||g||'.png' FROM generate_series(1,3) g;
INSERT INTO public.customer_notes (user_id,note)
  VALUES ('e0000000-0000-4000-8000-000000000001','ملاحظة داخلية عن العميل');
INSERT INTO public.accounting_invoices (user_id,total)
  VALUES ('e0000000-0000-4000-8000-000000000001', 250);
INSERT INTO public.canned_responses (body) VALUES ('رد جاهز');

\echo ''
\echo '=== 0) ضابط سلبي: التسريب يعمل فعلًا قبل 025 ==='
SET ROLE authenticated;
SET request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000001';
DO $$
DECLARE v_act int; v_att int; v_notes int; v_inv int;
BEGIN
  SELECT count(*) INTO v_act   FROM public.ticket_activity;
  SELECT count(*) INTO v_att   FROM public.ticket_attachments;
  SELECT count(*) INTO v_notes FROM public.customer_notes;
  SELECT count(*) INTO v_inv   FROM public.accounting_invoices;
  IF v_act = 0 OR v_att = 0 OR v_notes = 0 OR v_inv = 0 THEN
    RAISE EXCEPTION 'FAIL 0: التسريب لم يتحقق — الاختبار بعده لا يثبت شيئًا'; END IF;
  RAISE NOTICE 'PASS 0: مالك الشركة يقرأ % نشاطًا و% مرفقًا و% ملاحظة داخلية و% فاتورة',
    v_act, v_att, v_notes, v_inv;
END $$;
RESET ROLE;
RESET request.jwt.claim.sub;

\echo ''
\echo '--- applying migrations/025 ---'
\i migrations/025_purge_super_user_from_staff_policies.sql
\echo '--- migration applied ---'
\echo ''

\echo '=== A) مالك الشركة لم يعد يرى شيئًا من بيانات الطاقم ==='
SET ROLE authenticated;
SET request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000001';
DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM public.ticket_activity;
  IF v <> 0 THEN RAISE EXCEPTION 'FAIL A1: ما زال يرى % نشاطًا', v; END IF;
  SELECT count(*) INTO v FROM public.ticket_attachments;
  IF v <> 0 THEN RAISE EXCEPTION 'FAIL A2: ما زال يرى % مرفقًا', v; END IF;
  SELECT count(*) INTO v FROM public.customer_notes;
  IF v <> 0 THEN RAISE EXCEPTION 'FAIL A3: ما زال يرى % ملاحظة داخلية', v; END IF;
  SELECT count(*) INTO v FROM public.accounting_invoices;
  IF v <> 0 THEN RAISE EXCEPTION 'FAIL A4: ما زال يرى % فاتورة', v; END IF;
  SELECT count(*) INTO v FROM public.canned_responses;
  IF v <> 0 THEN RAISE EXCEPTION 'FAIL A5: ما زال يرى الردود الجاهزة'; END IF;
  RAISE NOTICE 'PASS A: كل بيانات الطاقم صارت صفرًا لمالك الشركة';

  BEGIN
    INSERT INTO public.customer_notes (user_id,note)
    VALUES ('e0000000-0000-4000-8000-000000000001','ملاحظة من غير طاقم');
    RAISE EXCEPTION 'FAIL A6: كتب ملاحظة داخلية عن عميل';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'FAIL A6%' THEN RAISE; END IF; END;
  RAISE NOTICE 'PASS A6: الكتابة على الملاحظات الداخلية مرفوضة';
END $$;

\echo ''
\echo '=== B) الطاقم الحقيقي ما زال يعمل (لم يُكسر المسار الإداري) ==='
SET request.jwt.claim.sub = '90000000-0000-4000-8000-000000000001';
DO $$
DECLARE v_act int; v_notes int;
BEGIN
  SELECT count(*) INTO v_act FROM public.ticket_activity;
  IF v_act = 0 THEN RAISE EXCEPTION 'FAIL B1: الأدمن فقد رؤية نشاط التذاكر'; END IF;
  INSERT INTO public.customer_notes (user_id,note)
  VALUES ('e0000000-0000-4000-8000-000000000001','ملاحظة إدارية');
  SELECT count(*) INTO v_notes FROM public.customer_notes;
  IF v_notes < 2 THEN RAISE EXCEPTION 'FAIL B2: الأدمن لم يستطع الكتابة'; END IF;
  RAISE NOTICE 'PASS B: الأدمن يقرأ % نشاطًا ويكتب الملاحظات الداخلية', v_act;
END $$;

\echo ''
\echo '=== C) العميل الفرد يرى فاتورته وحدها ==='
SET request.jwt.claim.sub = 'e0000000-0000-4000-8000-000000000001';
DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM public.accounting_invoices;
  IF v <> 1 THEN RAISE EXCEPTION 'FAIL C: العميل يرى % فاتورة بدل فاتورته', v; END IF;
  RAISE NOTICE 'PASS C: العميل يرى فاتورته فقط (السياسة لم تُوسَّع ولم تُضيَّق)';
END $$;

\echo ''
\echo '=== D) مالك الشركة لم يعد يحذف بروفايل عضوه ==='
SET request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000001';
DO $$
DECLARE v int;
BEGIN
  DELETE FROM public.profiles WHERE id='a0000000-0000-4000-8000-000000000002';
  SELECT count(*) INTO v FROM public.profiles WHERE id='a0000000-0000-4000-8000-000000000002';
  IF v = 0 THEN RAISE EXCEPTION 'FAIL D: حُذف بروفايل العضو فبقي حساب auth بلا بروفايل'; END IF;
  RAISE NOTICE 'PASS D: حذف بروفايل العضو مرفوض (الإزالة تكون بقطع العلاقة)';
END $$;
RESET ROLE;
RESET request.jwt.claim.sub;

\echo ''
\echo '=== E) إعادة تطبيق 025 آمنة ==='
\i migrations/025_purge_super_user_from_staff_policies.sql
DO $$ BEGIN RAISE NOTICE 'PASS G: إعادة التطبيق لم تفشل'; END $$;

\echo ''
\echo 'ALL STAFF POLICY PURGE TESTS PASSED'
