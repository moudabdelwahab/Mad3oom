-- اختبار تنفيذي لـ migrations/034_explicit_ticket_reopen_and_close.sql
--
-- درس من الجولة السابقة: اختبار السياسات وحدها لا يكفي. الخلل الذي أوقف ردّ
-- الشركة على الإنتاج جاء من **محفّز** لا من سياسة (track_first_response يحدّث
-- التذكرة بلا بوابة التجاوز فيصطدم بالحارس). لذلك يعيد هذا الملف بناء سلسلة
-- المحفّزات كما هي على الإنتاج — الحارسان والمحفّزات الثلاثة على الردود —
-- ثم يطبّق 033 و034 فوقها ويقيس السلوك الفعلي.
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true),'')::uuid; $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  -- الترحيلان يسحبان الصلاحية من anon صراحةً، فلازم يكون الدور موجودًا
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
END $$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, email text, full_name text,
  role text NOT NULL DEFAULT 'user', super_user_id uuid, created_at timestamptz DEFAULT now()
);

CREATE TABLE public.tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id),
  title text NOT NULL, description text NOT NULL,
  status text DEFAULT 'open', ticket_number bigserial,
  priority text DEFAULT 'medium', category text, image_url text,
  ticket_type text NOT NULL DEFAULT 'problem', contact_info text,
  assigned_to uuid, subdomain_id uuid,
  first_response_at timestamptz, sla_alert_sent boolean DEFAULT false,
  archived_by_customer boolean NOT NULL DEFAULT false, archived_at timestamptz,
  reopen_count integer NOT NULL DEFAULT 0, last_reopened_at timestamptz,
  resolved_at timestamptz, last_updated_by uuid, last_updated_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE public.ticket_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id),
  message text NOT NULL, is_internal boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.is_main_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select exists (select 1 from public.profiles where id = auth.uid() and email = 'support@mad3oom.online');
$$;

-- ── الحارسان على tickets، منسوخان من الإنتاج ───────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_customer_ticket_update_restrictions()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE is_admin boolean;
BEGIN
  IF current_setting('app.bypass_ticket_restrictions', true) = 'on' THEN RETURN NEW; END IF;
  SELECT (public.is_main_admin() OR EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')) INTO is_admin;
  IF COALESCE(is_admin, false) THEN RETURN NEW; END IF;
  IF NEW.title IS DISTINCT FROM OLD.title
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.first_response_at IS DISTINCT FROM OLD.first_response_at
     OR NEW.assigned_to IS DISTINCT FROM OLD.assigned_to
  THEN RAISE EXCEPTION 'غير مسموح للعميل بتعديل هذا الحقل في التذكرة'; END IF;
  RETURN NEW;
END; $function$;

CREATE TRIGGER trg_enforce_customer_ticket_update BEFORE UPDATE ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION public.enforce_customer_ticket_update_restrictions();

-- ── المحفّزات على الردود، منسوخة من الإنتاج ────────────────────────────────
CREATE OR REPLACE FUNCTION public.track_first_response()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_role text;
BEGIN
  IF NEW.is_internal = true THEN RETURN NEW; END IF;
  SELECT role INTO v_role FROM public.profiles WHERE id = NEW.user_id;
  IF v_role IN ('admin','super_user') THEN
    UPDATE public.tickets SET first_response_at = now()
      WHERE id = NEW.ticket_id AND first_response_at IS NULL;
  END IF;
  RETURN NEW;
END; $function$;
CREATE TRIGGER trg_track_first_response AFTER INSERT ON public.ticket_replies
  FOR EACH ROW EXECUTE FUNCTION public.track_first_response();

CREATE OR REPLACE FUNCTION public.reopen_ticket_on_owner_reply()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_owner uuid; v_status text;
BEGIN
  IF NEW.is_internal IS TRUE THEN RETURN NEW; END IF;
  SELECT t.user_id, t.status INTO v_owner, v_status FROM public.tickets t WHERE t.id = NEW.ticket_id;
  IF v_owner IS NOT NULL AND NEW.user_id = v_owner AND v_status = 'resolved' THEN
    PERFORM set_config('app.bypass_ticket_restrictions','on',true);
    UPDATE public.tickets SET status='open' WHERE id = NEW.ticket_id AND status='resolved';
    PERFORM set_config('app.bypass_ticket_restrictions','off',true);
  END IF;
  RETURN NEW;
END; $function$;
CREATE TRIGGER trg_reopen_ticket_on_owner_reply AFTER INSERT ON public.ticket_replies
  FOR EACH ROW EXECUTE FUNCTION public.reopen_ticket_on_owner_reply();

-- ── السياسات ───────────────────────────────────────────────────────────────
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_replies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles_select_policy" ON public.profiles FOR SELECT
  USING ((auth.uid() = id) OR public.is_main_admin() OR (super_user_id = auth.uid()));
CREATE POLICY "tickets_select_policy" ON public.tickets FOR SELECT
  USING ((user_id = auth.uid()) OR public.is_main_admin()
         OR ((select p.role from public.profiles p where p.id = auth.uid()) = 'admin')
         OR (user_id IN (select p.id from public.profiles p where p.super_user_id = auth.uid())));
CREATE POLICY "Users can create tickets" ON public.tickets FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Customer can archive own ticket" ON public.tickets FOR UPDATE
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "ticket_replies_select_policy" ON public.ticket_replies FOR SELECT USING (NOT is_internal);
CREATE POLICY "Users can add replies to their tickets" ON public.ticket_replies FOR INSERT
  WITH CHECK (EXISTS (select 1 from public.tickets t where t.id = ticket_id and t.user_id = auth.uid()));

GRANT USAGE ON SCHEMA public, auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

INSERT INTO public.profiles (id,email,full_name,role,super_user_id) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','owner@t.local','مالك الشركة','super_user',NULL),
  ('a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1','cust@t.local','عميل الشركة','customer','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','rival@t.local','شركة أخرى','super_user',NULL);

INSERT INTO public.tickets (id,user_id,title,description,status) VALUES
  ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','شركة ← مدعوم','م','resolved'),
  ('22222222-2222-4222-8222-222222222222','a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1','عميل ← شركة','م','open'),
  ('33333333-3333-4333-8333-333333333333','a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1','عميل ← شركة (محلولة)','م','resolved'),
  ('44444444-4444-4444-8444-444444444444','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','شركة أخرى','م','open');

\echo ''
\echo '=== 0) إعادة إنتاج الخللين قبل الترحيلين ==='
SET ROLE authenticated;
SET request.jwt.claim.sub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
DO $$
DECLARE v_blocked boolean := false; BEGIN
  -- (أ) ردّ المالك على تذكرة عميله يرتدّ من محفّز track_first_response
  BEGIN
    INSERT INTO public.ticket_replies (ticket_id,user_id,message)
    VALUES ('22222222-2222-4222-8222-222222222222', auth.uid(), 'ردّ');
  EXCEPTION WHEN others THEN v_blocked := true;
  END;
  IF NOT v_blocked THEN RAISE EXCEPTION 'FAIL 0A: الخلل لم يُعَد إنتاجه'; END IF;
  RAISE NOTICE 'PASS 0A: قبل الإصلاح — ردّ الشركة على عميلها مرفوض من المحفّز';
END $$;

SET request.jwt.claim.sub = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
DO $$
DECLARE v_status text; BEGIN
  -- (ب) ردّ صاحب التذكرة على تذكرته المحلولة يعيد فتحها تلقائيًا
  INSERT INTO public.ticket_replies (ticket_id,user_id,message)
  VALUES ('33333333-3333-4333-8333-333333333333', auth.uid(), 'ردّ على محلولة');
  SELECT status INTO v_status FROM public.tickets WHERE id='33333333-3333-4333-8333-333333333333';
  IF v_status <> 'open' THEN RAISE EXCEPTION 'FAIL 0B: السلوك القديم لم يُعَد إنتاجه'; END IF;
  RAISE NOTICE 'PASS 0B: قبل الإصلاح — الردّ يعيد الفتح تلقائيًا';
END $$;
RESET ROLE; RESET request.jwt.claim.sub;

-- إعادة التهيئة تمرّ بنفس بوابة التجاوز التي تستعملها المسارات الموثوقة:
-- الحارس يطبَّق على أي UPDATE مهما كان الدور، فحتى المهيّئ يحتاجها.
SELECT set_config('app.bypass_ticket_restrictions','on',false);
UPDATE public.tickets SET status='resolved' WHERE id='33333333-3333-4333-8333-333333333333';
SELECT set_config('app.bypass_ticket_restrictions','off',false);

\echo ''
\echo '=== تطبيق 033 ثم 034 ==='
\i migrations/033_company_customer_ticket_separation.sql
\i migrations/034_explicit_ticket_reopen_and_close.sql

\echo ''
\echo '=== 1) ردّ الشركة على تذكرة عميلها يمرّ الآن ==='
SET ROLE authenticated;
SET request.jwt.claim.sub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
DO $$
DECLARE v_fr timestamptz; BEGIN
  INSERT INTO public.ticket_replies (ticket_id,user_id,message)
  VALUES ('22222222-2222-4222-8222-222222222222', auth.uid(), 'ردّ الشركة على عميلها');

  SELECT first_response_at INTO v_fr FROM public.tickets WHERE id='22222222-2222-4222-8222-222222222222';
  IF v_fr IS NULL THEN RAISE EXCEPTION 'FAIL 1B: أول استجابة لم تُسجَّل'; END IF;
  RAISE NOTICE 'PASS 1: ردّ الشركة نجح، وأول استجابة سُجِّلت';
END $$;

\echo ''
\echo '=== 2) الردّ على تذكرة مغلقة لا يعيد فتحها ==='
DO $$
DECLARE v_status text; BEGIN
  INSERT INTO public.ticket_replies (ticket_id,user_id,message)
  VALUES ('33333333-3333-4333-8333-333333333333', auth.uid(), 'ردّ على تذكرة محلولة');
  SELECT status INTO v_status FROM public.tickets WHERE id='33333333-3333-4333-8333-333333333333';
  IF v_status <> 'resolved' THEN
    RAISE EXCEPTION 'FAIL 2: الردّ أعاد الفتح تلقائيًا (الحالة %)', v_status;
  END IF;
  RAISE NOTICE 'PASS 2: الردّ حُفِظ والتذكرة بقيت مغلقة';
END $$;

\echo ''
\echo '=== 3) زر «إعادة الفتح» وحده يفتحها ==='
DO $$
DECLARE v_status text; v_count int; BEGIN
  PERFORM public.reopen_ticket_in_my_scope('33333333-3333-4333-8333-333333333333');
  SELECT status, reopen_count INTO v_status, v_count
    FROM public.tickets WHERE id='33333333-3333-4333-8333-333333333333';
  IF v_status <> 'open' THEN RAISE EXCEPTION 'FAIL 3A: لم تُفتح (%)', v_status; END IF;
  IF v_count <> 1 THEN RAISE EXCEPTION 'FAIL 3B: عدّاد إعادة الفتح %', v_count; END IF;
  RAISE NOTICE 'PASS 3: إعادة الفتح الصريحة تعمل وتُحصى';
END $$;

\echo ''
\echo '=== 4) الإغلاق الصريح ==='
DO $$
DECLARE v_status text; BEGIN
  PERFORM public.close_ticket_in_my_scope('33333333-3333-4333-8333-333333333333');
  SELECT status INTO v_status FROM public.tickets WHERE id='33333333-3333-4333-8333-333333333333';
  IF v_status <> 'resolved' THEN RAISE EXCEPTION 'FAIL 4: لم تُغلق (%)', v_status; END IF;
  RAISE NOTICE 'PASS 4: الإغلاق الصريح يعمل';
END $$;

\echo ''
\echo '=== 5) الحالة وحدها تُكتب — الملكية لا تُمَس ==='
DO $$
DECLARE v_owner uuid; BEGIN
  SELECT user_id INTO v_owner FROM public.tickets WHERE id='33333333-3333-4333-8333-333333333333';
  IF v_owner <> 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1' THEN
    RAISE EXCEPTION 'FAIL 5: تغيّرت ملكية التذكرة بعد إجراءات الحالة';
  END IF;
  RAISE NOTICE 'PASS 5: user_id لم يتغيّر — المسار لم يتحوّل';
END $$;

\echo ''
\echo '=== 6) لا إعادة فتح ولا إغلاق خارج النطاق (IDOR) ==='
DO $$
DECLARE v_blocked boolean := false; BEGIN
  BEGIN PERFORM public.reopen_ticket_in_my_scope('44444444-4444-4444-8444-444444444444');
  EXCEPTION WHEN others THEN v_blocked := true; END;
  IF NOT v_blocked THEN RAISE EXCEPTION 'FAIL 6A: أعاد فتح تذكرة شركة أخرى'; END IF;

  v_blocked := false;
  BEGIN PERFORM public.close_ticket_in_my_scope('44444444-4444-4444-8444-444444444444');
  EXCEPTION WHEN others THEN v_blocked := true; END;
  IF NOT v_blocked THEN RAISE EXCEPTION 'FAIL 6B: أغلق تذكرة شركة أخرى'; END IF;
  RAISE NOTICE 'PASS 6: الإجراءان محصوران في النطاق';
END $$;

\echo ''
\echo '=== 7) العميل يعيد فتح تذكرته هو، ولا يمسّ تذكرة شركته ==='
SET request.jwt.claim.sub = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
DO $$
DECLARE v_status text; v_blocked boolean := false; BEGIN
  PERFORM public.reopen_ticket_in_my_scope('33333333-3333-4333-8333-333333333333');
  SELECT status INTO v_status FROM public.tickets WHERE id='33333333-3333-4333-8333-333333333333';
  IF v_status <> 'open' THEN RAISE EXCEPTION 'FAIL 7A: العميل لم يستطع إعادة فتح تذكرته'; END IF;

  BEGIN PERFORM public.reopen_ticket_in_my_scope('11111111-1111-4111-8111-111111111111');
  EXCEPTION WHEN others THEN v_blocked := true; END;
  IF NOT v_blocked THEN RAISE EXCEPTION 'FAIL 7B: العميل مسّ تذكرة شركته مع مدعوم'; END IF;
  RAISE NOTICE 'PASS 7: العميل يتصرّف في تذكرته وحدها';
END $$;

\echo ''
\echo '=== 8) لا إعادة فتح لتذكرة confirmed/rejected ==='
RESET ROLE;
SELECT set_config('app.bypass_ticket_restrictions','on',false);
UPDATE public.tickets SET status='rejected' WHERE id='33333333-3333-4333-8333-333333333333';
SELECT set_config('app.bypass_ticket_restrictions','off',false);
SET ROLE authenticated;
DO $$
DECLARE v_blocked boolean := false; BEGIN
  BEGIN PERFORM public.reopen_ticket_in_my_scope('33333333-3333-4333-8333-333333333333');
  EXCEPTION WHEN others THEN v_blocked := true; END;
  IF NOT v_blocked THEN RAISE EXCEPTION 'FAIL 8: أُعيد فتح تذكرة مرفوضة'; END IF;
  RAISE NOTICE 'PASS 8: قرارات confirmed/rejected لا تُنقَض بضغطة';
END $$;

RESET ROLE; RESET request.jwt.claim.sub;
\echo ''
\echo 'ALL TICKET REOPEN/CLOSE TESTS PASSED'
