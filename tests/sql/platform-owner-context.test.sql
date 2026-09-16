-- ============================================================================
-- اختبار تنفيذي لـ 038 → 041: مالك المنصة، والسياق كمُرشِّح على السلطة.
--
-- يثبّت ست خصائص، كل واحدة منها تفشل إن انكسرت:
--
--   ① مالك واحد لا غير، ولا يستطيع أحد أن يصير مالكًا من جلسة
--   ② تبديل السياق لا يمسّ profiles.role إطلاقًا
--   ③ السياق مُرشِّح لا مصدر — تزويره يُضيّق ولا يُصعِّد
--   ④ سياق الشركة لا يفتح شركة لا يملكها المنادي
--   ⑤ معاينة العضو ⊆ صلاحيات العضو الحقيقي (اختبار احتواء فعلي بالصفوف)
--   ⑥ نزع البريد لا يُسقط صلاحية أحد، وتغيير البريد لا يمنح شيئًا
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true),'')::uuid; $$;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
END $$;
GRANT USAGE ON SCHEMA auth, public TO authenticated, anon;

-- ── الجداول ───────────────────────────────────────────────────────────────
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, email text, full_name text,
  role text DEFAULT 'user', super_user_id uuid, points int DEFAULT 0,
  whatsapp_enabled boolean DEFAULT false, created_at timestamptz DEFAULT now()
);
CREATE TABLE public.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE,
  company_name varchar NOT NULL
);
CREATE TABLE public.subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text NOT NULL UNIQUE, name_ar text);
CREATE TABLE public.feature_flags (key text PRIMARY KEY, name_ar text);
CREATE TABLE public.plan_features (
  plan_id uuid NOT NULL REFERENCES public.subscription_plans(id) ON DELETE CASCADE,
  feature_key text NOT NULL REFERENCES public.feature_flags(key) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true, PRIMARY KEY (plan_id, feature_key));
CREATE TABLE public.whatsapp_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  status text DEFAULT 'active', start_date timestamptz DEFAULT now(),
  end_date timestamptz NOT NULL, plan text NOT NULL, company_id uuid,
  ticket_id uuid, updated_at timestamptz DEFAULT now());
CREATE TABLE public.tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  title text, status text DEFAULT 'open', created_at timestamptz DEFAULT now());
CREATE TABLE public.ticket_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ticket_id uuid NOT NULL,
  user_id uuid NOT NULL, body text, is_internal boolean DEFAULT false);
CREATE TABLE public.ticket_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ticket_id uuid NOT NULL, file_name text);
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, title text);
CREATE TABLE public.chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
CREATE TABLE public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid, sender_id uuid, body text);
CREATE TABLE public.activity_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, action text);
CREATE TABLE public.api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  name text, is_active boolean DEFAULT true);
CREATE TABLE public.customer_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, note text);
CREATE TABLE public.whatsapp_billing_admins (
  email text PRIMARY KEY, added_by uuid, created_at timestamptz DEFAULT now());

-- ── دوال 035 التي تبني عليها الترحيلات ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.owns_a_company(p_user_id uuid default auth.uid())
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select p_user_id is not null
     and exists (select 1 from public.companies c where c.user_id = p_user_id); $$;

CREATE OR REPLACE FUNCTION public.belongs_to_a_company(p_user_id uuid default auth.uid())
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select p_user_id is not null and exists (
    select 1 from public.profiles p join public.companies c on c.user_id = p.super_user_id
     where p.id = p_user_id); $$;

CREATE OR REPLACE FUNCTION public.company_of(p_user_id uuid default auth.uid())
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select c.id from public.companies c
   where p_user_id is not null
     and (c.user_id = p_user_id
          or c.user_id = (select p.super_user_id from public.profiles p where p.id = p_user_id))
   order by (c.user_id = p_user_id) desc limit 1; $$;

CREATE OR REPLACE FUNCTION public.current_company_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select public.company_of(auth.uid()); $$;

CREATE OR REPLACE FUNCTION public.is_company_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select exists (select 1 from public.profiles p where p.id=auth.uid() and p.role='company_admin')
     and public.owns_a_company(auth.uid()); $$;

CREATE OR REPLACE FUNCTION public.is_company_member() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select exists (select 1 from public.profiles p where p.id=auth.uid() and p.role='company_user')
     and public.belongs_to_a_company(auth.uid()); $$;

CREATE OR REPLACE FUNCTION public.company_has_feature(p_feature_key text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select exists (
    select 1 from public.companies c
      join public.whatsapp_subscriptions s on (s.company_id = c.id or s.user_id = c.user_id)
      join public.subscription_plans sp on sp.key = s.plan
      join public.plan_features pf on pf.plan_id = sp.id and pf.enabled
     where c.id = public.current_company_id()
       and s.status='active' and s.start_date <= now() and s.end_date > now()
       and pf.feature_key = p_feature_key); $$;

CREATE OR REPLACE FUNCTION public.can_manage_company_members() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select public.is_company_admin() and public.company_has_feature('sub_users'); $$;

CREATE OR REPLACE FUNCTION public.ticket_in_my_scope(p_ticket_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select auth.uid() is not null and exists (
    select 1 from public.tickets t where t.id = p_ticket_id
      and (t.user_id = auth.uid()
           or t.user_id in (select p.id from public.profiles p where p.super_user_id = auth.uid()))); $$;

CREATE OR REPLACE FUNCTION public.is_owner_or_super_of(target_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select target_id is not null and (auth.uid() = target_id
    or exists (select 1 from public.profiles where id=target_id and super_user_id=auth.uid())); $$;

-- ── دوال التفويض **قبل** الإصلاح: بالبريد، كما هي في الإنتاج اليوم ────────
CREATE OR REPLACE FUNCTION public.is_main_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','auth' AS $$
  SELECT COALESCE((SELECT email FROM auth.users WHERE id = auth.uid())
                  IN ('support@mad3oom.online','info@mad3oom.online'), false); $$;

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid()
    AND (role='admin' OR email IN ('support@mad3oom.online','info@mad3oom.online'))); $$;

CREATE OR REPLACE FUNCTION public.is_support_user() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid()
    AND (email='support@mad3oom.online' OR role='admin')); $$;

CREATE OR REPLACE FUNCTION public.is_admin_user(p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','auth' AS $$
  SELECT p_user_id IS NOT NULL AND (
    COALESCE((SELECT u.email IN ('support@mad3oom.online','info@mad3oom.online')
                FROM auth.users u WHERE u.id = p_user_id), false)
    OR COALESCE((SELECT p.role='admin' FROM public.profiles p WHERE p.id = p_user_id), false)); $$;

CREATE OR REPLACE FUNCTION public.is_platform_staff() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select exists (select 1 from public.profiles where id = auth.uid()
    and (role in ('platform_owner','admin','support')
         or email in ('support@mad3oom.online','info@mad3oom.online'))); $$;

CREATE OR REPLACE FUNCTION public.can_create_api_token() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select auth.uid() is not null and (
    public.is_platform_staff()
    or (public.is_company_admin() and public.company_has_feature('api_tokens'))); $$;

CREATE OR REPLACE FUNCTION public.is_whatsapp_billing_admin() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
begin
  return exists (select 1 from public.profiles p where p.id = auth.uid()
    and (p.role='admin' or p.email in (select email from public.whatsapp_billing_admins)));
end; $$;

CREATE OR REPLACE FUNCTION public.guard_profile_role_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
begin
  if new.role is not distinct from old.role then return new; end if;
  if auth.uid() is null then return new; end if;
  if auth.uid() = new.id then
    raise exception 'لا يمكنك تغيير صلاحية حسابك بنفسك' using errcode='42501'; end if;
  if not public.is_admin() then
    raise exception 'تغيير الرتب متاح للإدارة فقط' using errcode='42501'; end if;
  if new.role in ('platform_owner','admin','support') and not public.is_main_admin() then
    raise exception 'منح رتبة % يتطلب الإدارة العليا', new.role using errcode='42501'; end if;
  if new.role in ('company_admin','company_user') then
    raise exception 'أدوار الشركة تُشتق من العلاقة' using errcode='42501'; end if;
  return new;
end; $$;
CREATE TRIGGER trg_guard_profile_role_change BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_role_change();

CREATE OR REPLACE FUNCTION public.sync_company_role() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
declare v_target text;
begin
  if coalesce(new.role,'') in ('platform_owner','admin','support') then return new; end if;
  if public.owns_a_company(new.id) then v_target := 'company_admin';
  elsif new.super_user_id is not null
        and exists (select 1 from public.companies c where c.user_id = new.super_user_id)
    then v_target := 'company_user';
  elsif coalesce(new.role,'') in ('company_admin','company_user') then v_target := 'user';
  else return new; end if;
  new.role := v_target; return new;
end; $$;
CREATE TRIGGER trg_sync_company_role BEFORE INSERT OR UPDATE OF super_user_id, role
  ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.sync_company_role();

-- ── RLS كما هي في الإنتاج قبل الترحيل ─────────────────────────────────────
ALTER TABLE public.profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tickets       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_tokens    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companies     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY profiles_select_policy ON public.profiles FOR SELECT
  USING (auth.uid() = id OR public.is_main_admin() OR super_user_id = auth.uid());
CREATE POLICY profiles_update_policy ON public.profiles FOR UPDATE
  USING (auth.uid() = id OR public.is_main_admin() OR super_user_id = auth.uid());
CREATE POLICY profiles_delete_policy ON public.profiles FOR DELETE
  USING (public.is_main_admin());
CREATE POLICY user_insert_self ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);

CREATE POLICY tickets_select_policy ON public.tickets FOR SELECT
  USING (user_id = auth.uid() OR public.is_main_admin()
         OR (SELECT p.role FROM public.profiles p WHERE p.id = auth.uid()) = 'admin'
         OR user_id IN (SELECT p.id FROM public.profiles p WHERE p.super_user_id = auth.uid()));
CREATE POLICY "Users can create tickets" ON public.tickets FOR INSERT
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Customer can archive own ticket" ON public.tickets FOR UPDATE
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY ticket_replies_select_policy ON public.ticket_replies FOR SELECT
  USING (public.is_main_admin()
         OR (SELECT p.role FROM public.profiles p WHERE p.id = auth.uid()) = ANY (ARRAY['admin','support'])
         OR (COALESCE(is_internal,false) = false AND public.ticket_in_my_scope(ticket_id)));
CREATE POLICY "Users can add replies to their tickets" ON public.ticket_replies FOR INSERT
  WITH CHECK (user_id = auth.uid() AND (public.is_main_admin()
         OR (SELECT p.role FROM public.profiles p WHERE p.id = auth.uid()) = 'admin'
         OR public.ticket_in_my_scope(ticket_id)));

CREATE POLICY "Company scope can attach to scoped tickets" ON public.ticket_attachments
  FOR INSERT WITH CHECK (public.ticket_in_my_scope(ticket_id));
CREATE POLICY "Staff can view all attachments" ON public.ticket_attachments
  FOR SELECT USING (public.is_platform_staff());

CREATE POLICY "Admins can read notifications" ON public.notifications FOR SELECT
  USING (public.is_main_admin());

CREATE POLICY chat_sessions_select_own_or_admin ON public.chat_sessions FOR SELECT
  USING (user_id = auth.uid() OR public.is_main_admin());
CREATE POLICY chat_sessions_insert_own ON public.chat_sessions FOR INSERT
  WITH CHECK (user_id = auth.uid() OR public.is_main_admin());
CREATE POLICY chat_sessions_update_own_or_admin ON public.chat_sessions FOR UPDATE
  USING (user_id = auth.uid() OR public.is_main_admin());
CREATE POLICY chat_messages_select_own_or_admin ON public.chat_messages FOR SELECT
  USING (public.is_main_admin() OR sender_id = auth.uid()
         OR session_id IN (SELECT s.id FROM public.chat_sessions s WHERE s.user_id = auth.uid()));
CREATE POLICY chat_messages_insert_own_or_admin ON public.chat_messages FOR INSERT
  WITH CHECK (public.is_main_admin()
    OR (session_id IN (SELECT s.id FROM public.chat_sessions s WHERE s.user_id = auth.uid())
        AND (sender_id = auth.uid() OR sender_id IS NULL)));

CREATE POLICY activity_logs_select_policy ON public.activity_logs FOR SELECT
  USING (user_id = auth.uid() OR public.is_main_admin()
         OR (SELECT p.role FROM public.profiles p WHERE p.id = auth.uid()) = 'admin'
         OR user_id IN (SELECT p.id FROM public.profiles p WHERE p.super_user_id = auth.uid()));

CREATE POLICY "Admin can update any api token" ON public.api_tokens FOR UPDATE
  USING (public.is_admin() OR public.is_owner_or_super_of(user_id))
  WITH CHECK (public.is_admin() OR public.is_owner_or_super_of(user_id));
CREATE POLICY "Users can delete their own api tokens" ON public.api_tokens FOR DELETE
  USING (auth.uid() = user_id);
CREATE POLICY api_tokens_select ON public.api_tokens FOR SELECT
  USING (auth.uid() = user_id OR public.is_admin() OR public.is_owner_or_super_of(user_id));

CREATE POLICY "Company members can view their company" ON public.companies FOR SELECT
  USING (id = public.current_company_id());
CREATE POLICY "Users can update their own company" ON public.companies FOR UPDATE
  USING (user_id = auth.uid());
CREATE POLICY "Users can insert their own company" ON public.companies FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Admins can view customer notes" ON public.customer_notes FOR SELECT
  USING (public.is_platform_staff());
CREATE POLICY "Admins can insert customer notes" ON public.customer_notes FOR INSERT
  WITH CHECK (public.is_platform_staff());

CREATE POLICY subs_select ON public.whatsapp_subscriptions FOR SELECT
  USING (user_id = auth.uid() OR company_id = public.current_company_id() OR public.is_admin());
CREATE POLICY "Users can create their own subscriptions" ON public.whatsapp_subscriptions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- ── الفاعلون ──────────────────────────────────────────────────────────────
--   المالك · حسابان مرتفعان · أدمن عادي · عضو شركة حقيقي · عميل · مالك شركة أخرى
INSERT INTO auth.users (id, email) VALUES
  ('11111111-1111-4111-8111-111111111111','mahmoud@mad3oom.com'),
  ('22222222-2222-4222-8222-222222222222','support@mad3oom.online'),
  ('33333333-3333-4333-8333-333333333333','info@mad3oom.online'),
  ('44444444-4444-4444-8444-444444444444','plainadmin@example.com'),
  ('55555555-5555-4555-8555-555555555555','member@mad3oom.com'),
  ('66666666-6666-4666-8666-666666666666','customer@example.com'),
  ('77777777-7777-4777-8777-777777777777','rival@example.com');

INSERT INTO public.profiles (id, email, role) VALUES
  ('11111111-1111-4111-8111-111111111111','mahmoud@mad3oom.com','user'),
  ('22222222-2222-4222-8222-222222222222','support@mad3oom.online','admin'),
  ('33333333-3333-4333-8333-333333333333','info@mad3oom.online','admin'),
  ('44444444-4444-4444-8444-444444444444','plainadmin@example.com','admin'),
  ('55555555-5555-4555-8555-555555555555','member@mad3oom.com','user'),
  ('66666666-6666-4666-8666-666666666666','customer@example.com','user'),
  ('77777777-7777-4777-8777-777777777777','rival@example.com','user');

-- شركة المالك، وعضوها الحقيقي — كلاهما علاقة لا رتبة
INSERT INTO public.companies (id, user_id, company_name) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','مدعوم'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','77777777-7777-4777-8777-777777777777','شركة منافسة');
UPDATE public.profiles SET role='company_admin' WHERE id='11111111-1111-4111-8111-111111111111';
UPDATE public.profiles SET role='company_admin' WHERE id='77777777-7777-4777-8777-777777777777';
UPDATE public.profiles SET super_user_id='11111111-1111-4111-8111-111111111111'
  WHERE id='55555555-5555-4555-8555-555555555555';

INSERT INTO public.whatsapp_billing_admins (email) VALUES ('support@mad3oom.online');

-- بيانات يُقاس عليها الاحتواء
INSERT INTO public.tickets (id, user_id, title) VALUES
  ('c1111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','تذكرة المالك'),
  ('c2222222-2222-4222-8222-222222222222','55555555-5555-4555-8555-555555555555','تذكرة العضو'),
  ('c3333333-3333-4333-8333-333333333333','66666666-6666-4666-8666-666666666666','تذكرة عميل');
INSERT INTO public.api_tokens (id, user_id, name) VALUES
  ('d1111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','رمز المالك'),
  ('d2222222-2222-4222-8222-222222222222','55555555-5555-4555-8555-555555555555','رمز العضو');
INSERT INTO public.notifications (user_id, title) VALUES
  ('66666666-6666-4666-8666-666666666666','إشعار عميل');
INSERT INTO public.chat_sessions (id, user_id) VALUES
  ('e1111111-1111-4111-8111-111111111111','66666666-6666-4666-8666-666666666666');

-- اشتراك فعّال لشركة المالك مع استحقاق sub_users و api_tokens
INSERT INTO public.feature_flags (key) VALUES ('sub_users'), ('api_tokens');
INSERT INTO public.subscription_plans (id, key) VALUES
  ('f1111111-1111-4111-8111-111111111111','bundle');
INSERT INTO public.plan_features (plan_id, feature_key) VALUES
  ('f1111111-1111-4111-8111-111111111111','sub_users'),
  ('f1111111-1111-4111-8111-111111111111','api_tokens');
INSERT INTO public.whatsapp_subscriptions (user_id, company_id, plan, end_date) VALUES
  ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bundle', now() + interval '90 days');

-- ============================================================================
-- تطبيق الترحيلات الأربعة بالترتيب
-- ============================================================================
\i migrations/038_platform_authority.sql
\i migrations/039_authority_seed.sql
\i migrations/040_context_aware_authority.sql
\i migrations/041_preview_containment.sql

-- ============================================================================
-- ١) مالك واحد لا غير — مفروضًا من المحرّك لا من انضباط الكاتب
-- ============================================================================
DO $$
DECLARE v int; v_role text;
BEGIN
  SELECT count(*) INTO v FROM public.platform_authority WHERE level='owner';
  IF v <> 1 THEN RAISE EXCEPTION 'عدد المالكين % وليس 1', v; END IF;

  SELECT role INTO v_role FROM public.profiles WHERE id='11111111-1111-4111-8111-111111111111';
  IF v_role <> 'platform_owner' THEN RAISE EXCEPTION 'رتبة المالك % ', v_role; END IF;

  -- محاولة زرع مالك ثانٍ من ترحيل (بلا auth.uid) — الفهرس الفريد يردّها
  BEGIN
    INSERT INTO public.platform_authority (user_id, level)
    VALUES ('44444444-4444-4444-8444-444444444444','owner');
    RAISE EXCEPTION 'FAIL: قُبل مالك ثانٍ';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS 1: مالك واحد — الفهرس الفريد يمنع الثاني';
  END;
END $$;

-- ============================================================================
-- ٢) لا أحد يصير مالكًا من جلسة — لا بالرتبة ولا بالسلطة
-- ============================================================================
SET request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';  -- سلطة مرتفعة
SET ROLE authenticated;
DO $$
BEGIN
  -- ① كتابة صف سلطة: ممنوعة على كل دور
  BEGIN
    INSERT INTO public.platform_authority (user_id, level)
    VALUES ('44444444-4444-4444-8444-444444444444','owner');
    RAISE EXCEPTION 'FAIL: حامل السلطة المرتفعة كتب في platform_authority';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- ② منح رتبة platform_owner: للمالك وحده، وهي بلا صف سلطة عديمة الأثر
  BEGIN
    UPDATE public.profiles SET role='platform_owner'
     WHERE id='44444444-4444-4444-8444-444444444444';
    RAISE EXCEPTION 'FAIL: حامل السلطة المرتفعة منح رتبة platform_owner';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  RAISE NOTICE 'PASS 2: لا طريق إلى الملكية من أي جلسة — لا سلطةً ولا رتبة';
END $$;
RESET ROLE;

-- ============================================================================
-- ٣) fail-closed — المالك بلا سياق لا يملك شيئًا
-- ============================================================================
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$
DECLARE v text; r record;
BEGIN
  IF NOT public.is_platform_owner() THEN RAISE EXCEPTION 'المالك غير معترَف به'; END IF;
  IF public.active_context() IS NOT NULL THEN RAISE EXCEPTION 'سياق سارٍ بلا اختيار'; END IF;

  -- **false قاطعة، لا «ليس true».**
  --
  -- الصيغة السابقة كانت `IF public.is_admin() THEN RAISE` وهي تمرّ على NULL
  -- كما تمرّ على false — فأخفت عيبًا حقيقيًا: بلا سياق كان
  -- `NULL in ('owner','admin')` يعطي NULL، فيتسرّب عبر owner_capability إلى
  -- كل مُسنَد. وRLS تُعامل NULL كمنع فلا تنكشف بيانات، لكن الحرّاس تنكسر:
  --
  --     if not public.is_admin() then raise ...   -- not NULL = NULL ⇒ لا يرفع
  --
  -- أي أن guard_profile_role_change كان يسقط صامتًا. ولذلك يُقارَن هنا
  -- بـIS DISTINCT FROM FALSE: أي شيء غير false الصريحة يفشل الاختبار.
  FOR r IN
    SELECT 'is_admin' AS n, public.is_admin() AS v
    UNION ALL SELECT 'is_platform_staff', public.is_platform_staff()
    UNION ALL SELECT 'is_support_user', public.is_support_user()
    UNION ALL SELECT 'has_elevated_authority', public.has_elevated_authority()
    UNION ALL SELECT 'is_main_admin', public.is_main_admin()
    UNION ALL SELECT 'is_company_admin', public.is_company_admin()
    UNION ALL SELECT 'is_company_member', public.is_company_member()
    UNION ALL SELECT 'preview_mode', public.preview_mode()
    UNION ALL SELECT 'in_context(owner)', public.in_context('owner')
    UNION ALL SELECT 'owner_capability(admin)', public.owner_capability('admin')
    UNION ALL SELECT 'context_allows(NULL,admin)', public.context_allows(NULL, 'admin')
  LOOP
    IF r.v IS DISTINCT FROM FALSE THEN
      RAISE EXCEPTION 'بلا سياق، %() أعطت % والمتوقع false قاطعة', r.n, coalesce(r.v::text,'NULL');
    END IF;
  END LOOP;

  RAISE NOTICE 'PASS 3: بلا سياق كل مُسنَد = false قاطعة — لا NULL يتسرّب';
END $$;

-- ٣ب) والحارس يرفع فعلًا — وهو ما كان NULL يُسقطه صامتًا
DO $$
BEGIN
  BEGIN
    UPDATE public.profiles SET role = 'admin'
     WHERE id = '66666666-6666-4666-8666-666666666666';
    RAISE EXCEPTION 'FAIL: المالك بلا سياق منح رتبة admin — الحارس لم يرفع';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS 3ب: حارس الرتب يرفع للمالك بلا سياق';
  END;
END $$;

-- ============================================================================
-- ٤) السياقات الخمسة تُحسب في الخادم، والخمسة كلها مُستحَقّة للمالك
-- ============================================================================
DO $$
DECLARE v jsonb; v_granted int;
BEGIN
  v := public.available_contexts();
  IF jsonb_array_length(v) <> 5 THEN
    RAISE EXCEPTION 'عدد السياقات % وليس 5', jsonb_array_length(v); END IF;
  SELECT count(*) INTO v_granted FROM jsonb_array_elements(v) e WHERE (e->>'granted')::boolean;
  IF v_granted <> 5 THEN RAISE EXCEPTION 'المستحَق % من 5', v_granted; END IF;
  IF NOT (v @> '[{"key":"company_user_preview"}]'::jsonb) THEN
    RAISE EXCEPTION 'سياق المعاينة غائب'; END IF;
  RAISE NOTICE 'PASS 4: خمسة سياقات يحسبها الخادم، كلها مستحَقّة للمالك';
END $$;

-- ============================================================================
-- ٥) تبديل السياق لا يمسّ profiles.role — الخاصية المركزية كلها
-- ============================================================================
SET ROLE authenticated;
DO $$
DECLARE v_role text; c text;
BEGIN
  FOREACH c IN ARRAY ARRAY['owner','admin','company_admin','company_user_preview','customer'] LOOP
    PERFORM public.enter_context(c);
    IF public.active_context() <> c THEN
      RAISE EXCEPTION 'الدخول إلى % لم يُفعّله', c; END IF;
    SELECT role INTO v_role FROM public.profiles WHERE id='11111111-1111-4111-8111-111111111111';
    IF v_role <> 'platform_owner' THEN
      RAISE EXCEPTION 'الرتبة صارت % بعد سياق % — هذا تبديل رتبة لا سياق', v_role, c; END IF;
  END LOOP;
  RAISE NOTICE 'PASS 5: خمسة سياقات، والرتبة platform_owner في كل واحد منها';
END $$;
RESET ROLE;

-- ============================================================================
-- ٦) مصفوفة القدرات — كل سياق يفتح ما له ويغلق ما لغيره
-- ============================================================================
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
SET ROLE authenticated;
DO $$
DECLARE
  -- السياق · admin · staff · elevated · company_admin · company_member
  m text[][] := ARRAY[
    ['owner',                't','t','t','t','f'],
    ['admin',                't','t','f','f','f'],
    ['company_admin',        'f','f','f','t','f'],
    ['company_user_preview', 'f','f','f','f','t'],
    ['customer',             'f','f','f','f','f']];
  i int; ctx text;
  got boolean; want boolean;
  names text[] := ARRAY['is_admin','is_platform_staff','has_elevated_authority',
                        'is_company_admin','is_company_member'];
  j int;
BEGIN
  FOR i IN 1..array_length(m,1) LOOP
    ctx := m[i][1];
    PERFORM public.enter_context(ctx);
    FOR j IN 1..5 LOOP
      got := CASE j
               WHEN 1 THEN public.is_admin()
               WHEN 2 THEN public.is_platform_staff()
               WHEN 3 THEN public.has_elevated_authority()
               WHEN 4 THEN public.is_company_admin()
               WHEN 5 THEN public.is_company_member() END;
      want := (m[i][j+1] = 't');
      IF got <> want THEN
        RAISE EXCEPTION 'سياق % : %() أعطت % والمتوقع %', ctx, names[j], got, want;
      END IF;
    END LOOP;
  END LOOP;
  RAISE NOTICE 'PASS 6: مصفوفة القدرات مطابقة في السياقات الخمسة';
END $$;

-- ============================================================================
-- ٧) تزوير السياق — مستخدم عادي لا ينال شيئًا، لا بالنداء ولا بالكتابة
-- ============================================================================
RESET ROLE;
SET request.jwt.claim.sub = '66666666-6666-4666-8666-666666666666';  -- عميل عادي
SET ROLE authenticated;
DO $$
DECLARE c text;
BEGIN
  -- ① نداء enter_context لكل سياق: يُردّ كله، ولا صف سياق يُكتب
  FOREACH c IN ARRAY ARRAY['owner','admin','company_admin','company_user_preview','customer'] LOOP
    IF (public.enter_context(c) ->> 'allowed')::boolean THEN
      RAISE EXCEPTION 'FAIL: عميل عادي دخل سياق %', c;
    END IF;
    IF public.active_context() IS NOT NULL THEN
      RAISE EXCEPTION 'FAIL: سياق % فُعّل لعميل عادي', c;
    END IF;
  END LOOP;

  -- ② كتابة صف السياق مباشرةً: ممنوعة
  BEGIN
    INSERT INTO public.owner_context_state (user_id, context, expires_at)
    VALUES ('66666666-6666-4666-8666-666666666666','owner', now() + interval '1 day');
    RAISE EXCEPTION 'FAIL: عميل عادي كتب في owner_context_state';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- ③ وحتى لو وُجد الصف، المُسنَد لا يمنح: هذا هو التقاطع
  IF public.in_context('owner') OR public.is_admin() OR public.is_platform_staff()
     OR public.has_elevated_authority() OR public.is_company_admin() THEN
    RAISE EXCEPTION 'FAIL: عميل عادي نال قدرة';
  END IF;

  RAISE NOTICE 'PASS 7: تزوير السياق لا يمنح شيئًا — لا نداءً ولا كتابةً ولا أثرًا';
END $$;
RESET ROLE;

-- ============================================================================
-- ٧ب) حتى صف سياق مزروع قسرًا لا يمنح — القاعدة الحاكمة عاريةً
-- ============================================================================
-- نزرعه بصلاحية المالك (تجاوزًا للحرّاس) لنثبت أن **المُسنَد** هو الحاجز
-- الأخير، لا الحارس وحده. لو كان السياق مصدرًا لسلطة، لمرّ هذا.
DO $$
BEGIN
  PERFORM set_config('app.owner_context_write','on', true);
  INSERT INTO public.owner_context_state (user_id, context, expires_at)
  VALUES ('66666666-6666-4666-8666-666666666666','owner', now() + interval '1 day')
  ON CONFLICT (user_id) DO UPDATE SET context='owner';
END $$;

SET request.jwt.claim.sub = '66666666-6666-4666-8666-666666666666';
DO $$
BEGIN
  IF public.active_context() IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: صف مزروع فعّل سياقًا لغير مالك'; END IF;
  IF public.is_admin() OR public.has_elevated_authority() OR public.is_company_admin()
     OR public.is_company_member() OR public.is_platform_staff() THEN
    RAISE EXCEPTION 'FAIL: صف السياق المزروع منح قدرة'; END IF;
  RAISE NOTICE 'PASS 7ب: السياق مُرشِّح لا مصدر — صف مزروع بلا منح = صفر';
END $$;
-- التنظيف نفسه يمرّ من الحارس — وهو دليل إضافي على أنه يحرس الجميع.
DO $$ BEGIN
  PERFORM set_config('app.owner_context_write','on', true);
  DELETE FROM public.owner_context_state WHERE user_id='66666666-6666-4666-8666-666666666666';
END $$;

-- ============================================================================
-- ٨) سياق الشركة — شركته هو، ولا شركة سواها
-- ============================================================================
RESET ROLE;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
SET ROLE authenticated;
DO $$
DECLARE v_cid uuid; v_seen int;
BEGIN
  PERFORM public.enter_context('company_admin');

  IF NOT public.is_company_admin() THEN
    RAISE EXCEPTION 'المالك لم ينل سلطة مدير الشركة في سياقها'; END IF;

  v_cid := public.current_company_id();
  IF v_cid <> 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' THEN
    RAISE EXCEPTION 'الشركة النشطة % وليست شركته', v_cid; END IF;

  -- شركة المنافس غير مرئية ولا قابلة للتعديل
  SELECT count(*) INTO v_seen FROM public.companies
   WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  IF v_seen <> 0 THEN
    RAISE EXCEPTION 'سياق الشركة كشف شركة لا يملكها'; END IF;

  UPDATE public.companies SET company_name='اختُطفت'
   WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  IF FOUND THEN RAISE EXCEPTION 'سياق الشركة عدّل شركة لا يملكها'; END IF;

  RAISE NOTICE 'PASS 8: سياق الشركة مقصور على companies.user_id = auth.uid()';
END $$;

-- ============================================================================
-- ٨ب) الاشتراك يُحترم — الملكية لا تتجاوز باقة الشركة
-- ============================================================================
DO $$
BEGIN
  PERFORM public.enter_context('company_admin');
  IF NOT public.can_manage_company_members() THEN
    RAISE EXCEPTION 'المالك لم ينل إدارة الأعضاء رغم استحقاق sub_users'; END IF;
  RAISE NOTICE 'PASS 8ب-1: باستحقاق فعّال، سياق الشركة يفتح إدارة الأعضاء';
END $$;
RESET ROLE;

-- إنهاء الاشتراك يجري بصلاحية النظام لا من داخل الجلسة، وإلا ابتلعته RLS
-- صامتًا فمرّ الاختبار بلا أن يقيس شيئًا.
UPDATE public.whatsapp_subscriptions SET status='expired'
 WHERE company_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM public.whatsapp_subscriptions
   WHERE company_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND status='expired';
  IF v <> 1 THEN RAISE EXCEPTION 'الاشتراك لم يُنهَ فعلًا — الاختبار كان سيمرّ فارغًا'; END IF;
END $$;

SET ROLE authenticated;
DO $$
BEGIN
  IF public.active_context() <> 'company_admin' THEN
    RAISE EXCEPTION 'السياق تغيّر بين المرحلتين'; END IF;
  IF public.can_manage_company_members() THEN
    RAISE EXCEPTION 'المالك تجاوز اشتراك الشركة — السياق منح استحقاقًا'; END IF;
  IF NOT public.is_company_admin() THEN
    RAISE EXCEPTION 'انتهاء الاشتراك أسقط سلطة السياق — وهذا ليس المقصود'; END IF;
  RAISE NOTICE 'PASS 8ب-2: انتهاء الاشتراك يسقط الاستحقاق والسياق لا يعوّضه';
END $$;
RESET ROLE;
UPDATE public.whatsapp_subscriptions SET status='active'
 WHERE company_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

-- ============================================================================
-- ٩) الاحتواء — معاينة العضو ⊆ صلاحيات العضو الحقيقي، بالصفوف لا بالنيّة
-- ============================================================================
-- الخطر أن المالك يظل مالكًا **بحكم العلاقة** داخل المعاينة، فيرى تذاكر
-- أعضائه ورموزهم وملفاتهم — وهو ما لا يراه عضو قط.
--
-- والمقارنة الصحيحة ليست بين معرّفات الصفوف: كل حساب يرى صفوفه هو، فمقارنة
-- المعرّفات تعدّ «ملفي أنا» فرقًا وهو ليس فرقًا. الفرق الحقيقي هو ما يراه
-- الحساب **مما لا يخصّه**. ولذلك نصنّف كل صف بصاحبه ثم نقارن الفائض وحده.
--
-- ولولا إطفاء 041 لرأت المعاينة ثلاثة صفوف من صفوف العضو (ملفه، تذكرته،
-- رمزه) عبر supervises — فهذا الاختبار يمسك التصعيد فعلًا لا شكلًا.

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
SELECT public.enter_context('company_user_preview');

CREATE TEMP TABLE vis_preview AS
  SELECT 'tickets'  AS k, t.id::text AS id, t.user_id AS belongs_to FROM public.tickets t
  UNION ALL SELECT 'profiles',   p.id::text,  p.id      FROM public.profiles p
  UNION ALL SELECT 'api_tokens', a.id::text,  a.user_id FROM public.api_tokens a
  UNION ALL SELECT 'replies',    r.id::text,  r.user_id FROM public.ticket_replies r
  UNION ALL SELECT 'notifs',     n.id::text,  n.user_id FROM public.notifications n
  UNION ALL SELECT 'activity',   l.id::text,  l.user_id FROM public.activity_logs l;

SET request.jwt.claim.sub = '55555555-5555-4555-8555-555555555555';  -- العضو الحقيقي

CREATE TEMP TABLE vis_member AS
  SELECT 'tickets'  AS k, t.id::text AS id, t.user_id AS belongs_to FROM public.tickets t
  UNION ALL SELECT 'profiles',   p.id::text,  p.id      FROM public.profiles p
  UNION ALL SELECT 'api_tokens', a.id::text,  a.user_id FROM public.api_tokens a
  UNION ALL SELECT 'replies',    r.id::text,  r.user_id FROM public.ticket_replies r
  UNION ALL SELECT 'notifs',     n.id::text,  n.user_id FROM public.notifications n
  UNION ALL SELECT 'activity',   l.id::text,  l.user_id FROM public.activity_logs l;

DO $$
DECLARE
  v_owner uuid := '11111111-1111-4111-8111-111111111111';
  v_mem   uuid := '55555555-5555-4555-8555-555555555555';
  r record; v_msg text := ''; v_n int := 0; v_mem_foreign int;
BEGIN
  -- ① ما تراه المعاينة مما لا يخصّ المالك
  FOR r IN SELECT k, id, belongs_to FROM vis_preview
            WHERE belongs_to IS DISTINCT FROM v_owner LOOP
    v_n := v_n + 1;
    v_msg := v_msg || r.k || ':' || r.id || '(لـ' || coalesce(r.belongs_to::text,'?') || ') ';
  END LOOP;

  -- ② وما يراه العضو الحقيقي مما لا يخصّه — المرجع الذي نُقاس عليه
  SELECT count(*) INTO v_mem_foreign FROM vis_member
   WHERE belongs_to IS DISTINCT FROM v_mem;

  IF v_n > v_mem_foreign THEN
    RAISE EXCEPTION 'تصعيد: المعاينة ترى % صفًّا أجنبيًا والعضو يرى % — %',
      v_n, v_mem_foreign, v_msg;
  END IF;

  RAISE NOTICE 'PASS 9: الاحتواء مُثبَت — المعاينة % صف أجنبي · العضو % صف أجنبي',
    v_n, v_mem_foreign;
END $$;

-- ٩ب) وإثبات أن الاختبار ليس فارغًا: العضو والمالك يريان صفوفهما فعلًا
DO $$
DECLARE v_p int; v_m int;
BEGIN
  SELECT count(*) INTO v_p FROM vis_preview;
  SELECT count(*) INTO v_m FROM vis_member;
  IF v_p = 0 OR v_m = 0 THEN
    RAISE EXCEPTION 'إحدى المجموعتين فارغة — المقارنة بلا معنى (% / %)', v_p, v_m; END IF;
  RAISE NOTICE 'PASS 9ب: المجموعتان غير فارغتين (معاينة=% · عضو=%)', v_p, v_m;
END $$;

-- ٩ج) ضابط سلبي — إثبات أن التأكيد أعلاه حيّ لا زخرفة
-- نُعيد supervises إلى ما قبل 041 داخل معاملة تُلغى، ونتحقق أن الفائض يظهر.
-- لو لم يظهر، فالاختبار كان سيمرّ على تصعيد حقيقي.
RESET ROLE;
BEGIN;
CREATE OR REPLACE FUNCTION public.supervises(p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select p_user_id is not null
     and exists (select 1 from public.profiles p
                  where p.id = p_user_id and p.super_user_id = auth.uid()); $$;
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM (
    SELECT t.user_id AS b FROM public.tickets t
    UNION ALL SELECT p.id FROM public.profiles p
    UNION ALL SELECT a.user_id FROM public.api_tokens a
  ) x WHERE b IS DISTINCT FROM '11111111-1111-4111-8111-111111111111'::uuid;

  IF v = 0 THEN
    RAISE EXCEPTION 'الضابط السلبي لم يُظهر تصعيدًا — اختبار الاحتواء لا يقيس شيئًا';
  END IF;
  RAISE NOTICE 'PASS 9ج: بلا حارس 041 تظهر % صفوف أجنبية — التأكيد حيّ', v;
END $$;
RESET ROLE;
ROLLBACK;

-- ============================================================================
-- ١٠) المعاينة للقراءة فقط — والمحفّز يمسك ما تتجاوزه RLS
-- ============================================================================
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$
BEGIN
  PERFORM public.enter_context('company_user_preview');

  BEGIN
    INSERT INTO public.tickets (user_id, title)
    VALUES ('11111111-1111-4111-8111-111111111111','تذكرة من المعاينة');
    RAISE EXCEPTION 'FAIL: المعاينة أنشأت تذكرة';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE public.companies SET company_name='من المعاينة'
     WHERE id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    RAISE EXCEPTION 'FAIL: المعاينة عدّلت الشركة';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE public.profiles SET full_name='من المعاينة'
     WHERE id='11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'FAIL: المعاينة عدّلت ملفها';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  RAISE NOTICE 'PASS 10: المعاينة للقراءة فقط — إنشاءً وتعديلًا';
END $$;

-- ١٠ب) والخروج من السياق يعيد الكتابة — فالقيد سياقي لا دائم
DO $$
BEGIN
  PERFORM public.enter_context('company_admin');
  UPDATE public.companies SET company_name='مدعوم'
   WHERE id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  IF NOT FOUND THEN RAISE EXCEPTION 'سياق مدير الشركة لا يكتب — القيد تسرّب خارج المعاينة'; END IF;
  RAISE NOTICE 'PASS 10ب: القيد سياقي — يزول بالخروج من المعاينة';
END $$;
RESET ROLE;

-- ============================================================================
-- ١١) support@ و info@ يحتفظان بصلاحياتهما — بسلطة صريحة لا ببريد
-- ============================================================================
SET request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
DO $$
DECLARE v int;
BEGIN
  IF NOT public.has_elevated_authority() THEN
    RAISE EXCEPTION 'support@ فقد السلطة المرتفعة'; END IF;
  IF NOT public.is_main_admin() THEN
    RAISE EXCEPTION 'غلاف is_main_admin انقطع عن السلطة المرتفعة'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'support@ فقد is_admin'; END IF;
  IF NOT public.is_platform_staff() THEN RAISE EXCEPTION 'support@ فقد is_platform_staff'; END IF;
  IF NOT public.is_support_user() THEN RAISE EXCEPTION 'support@ فقد is_support_user'; END IF;
  IF NOT public.is_whatsapp_billing_admin() THEN
    RAISE EXCEPTION 'support@ فقد صلاحية الفوترة بنزع البريد'; END IF;

  SELECT count(*) INTO v FROM public.profiles;
  IF v < 7 THEN RAISE EXCEPTION 'support@ لم يعد يرى كل الحسابات (%)', v; END IF;

  RAISE NOTICE 'PASS 11: الحسابان المرتفعان بصلاحياتهما كاملةً من سلطة صريحة';
END $$;

SET request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';
DO $$
BEGIN
  IF NOT public.has_elevated_authority() THEN RAISE EXCEPTION 'info@ فقد السلطة'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'info@ فقد is_admin'; END IF;
  RAISE NOTICE 'PASS 11ب: info@ كذلك';
END $$;

-- ١١د) ومحاولة حامل السلطة المرتفعة دخول سياق المالك: تُردّ وتُسجَّل
SET ROLE authenticated;
DO $$
BEGIN
  IF (public.enter_context('owner') ->> 'allowed')::boolean THEN
    RAISE EXCEPTION 'FAIL: حامل السلطة المرتفعة دخل سياق المالك'; END IF;
  IF public.active_context() IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: سياق فُعّل لغير المالك'; END IF;
  RAISE NOTICE 'PASS 11د: السياقات آلية owner-only — السلطة المرتفعة لا تدخلها';
END $$;
RESET ROLE;

-- ١١ج) والأدمن العادي لا يرث السلطة المرتفعة — الفصل قائم
SET request.jwt.claim.sub = '44444444-4444-4444-8444-444444444444';
DO $$
DECLARE v int;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'الأدمن العادي فقد is_admin'; END IF;
  IF public.has_elevated_authority() THEN
    RAISE EXCEPTION 'الأدمن العادي ورث السلطة المرتفعة'; END IF;
  IF public.is_platform_owner() THEN RAISE EXCEPTION 'الأدمن العادي صار مالكًا'; END IF;

  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v FROM public.profiles;
  IF v <> 1 THEN
    RAISE EXCEPTION 'الأدمن العادي يرى % حسابًا والمتوقع حسابه وحده', v; END IF;
  RAISE NOTICE 'PASS 11ج: أدمن عادي ≠ سلطة مرتفعة ≠ مالك — ثلاث درجات منفصلة';
END $$;

-- ============================================================================
-- ١٢) تغيير profiles.email لا يمنح شيئًا — إغلاق الثغرة التي شخّصها 027
-- ============================================================================
-- الثغرة الأصلية: profiles.email قابل للكتابة من العميل، و13 موضعًا كان يقرأه
-- ليقرر السلطة. المانع الوحيد كان تعارض مفتاح فريد — حظّ لا حاجز.
-- الـfixture هنا **بلا قيد فريد عمدًا**، فالاختبار يثبت أن التفويض لا يتغير
-- حتى لو سقط ذلك الحظّ تمامًا.
RESET ROLE;
UPDATE public.profiles SET email='support@mad3oom.online'
 WHERE id='66666666-6666-4666-8666-666666666666';

SET request.jwt.claim.sub = '66666666-6666-4666-8666-666666666666';
DO $$
DECLARE v int;
BEGIN
  IF public.is_admin()                 THEN RAISE EXCEPTION 'انتحال البريد منح is_admin'; END IF;
  IF public.is_support_user()          THEN RAISE EXCEPTION 'انتحال البريد منح is_support_user'; END IF;
  IF public.is_platform_staff()        THEN RAISE EXCEPTION 'انتحال البريد منح is_platform_staff'; END IF;
  IF public.is_main_admin()            THEN RAISE EXCEPTION 'انتحال البريد منح is_main_admin'; END IF;
  IF public.has_elevated_authority()   THEN RAISE EXCEPTION 'انتحال البريد منح سلطة مرتفعة'; END IF;
  IF public.is_platform_owner()        THEN RAISE EXCEPTION 'انتحال البريد منح الملكية'; END IF;
  IF public.is_whatsapp_billing_admin() THEN RAISE EXCEPTION 'انتحال البريد منح صلاحية الفوترة'; END IF;
  IF public.is_admin_user('66666666-6666-4666-8666-666666666666') THEN
    RAISE EXCEPTION 'انتحال البريد منح is_admin_user'; END IF;

  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v FROM public.profiles;
  IF v <> 1 THEN RAISE EXCEPTION 'المنتحِل يرى % حسابًا', v; END IF;

  RAISE NOTICE 'PASS 12: انتحال البريد لا يمنح شيئًا — ولا حتى بلا قيد فريد';
END $$;

-- ١٢ب) وحذف البريد كذلك لا يُسقط صلاحية أحد
RESET ROLE;
UPDATE public.profiles SET email='' WHERE id='22222222-2222-4222-8222-222222222222';
SET request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
DO $$
BEGIN
  IF NOT public.has_elevated_authority() THEN
    RAISE EXCEPTION 'إفراغ البريد أسقط السلطة المرتفعة — التفويض ما زال بريديًا'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'إفراغ البريد أسقط is_admin'; END IF;
  IF NOT public.is_whatsapp_billing_admin() THEN
    RAISE EXCEPTION 'إفراغ البريد أسقط صلاحية الفوترة'; END IF;
  RAISE NOTICE 'PASS 12ب: إفراغ البريد لا يُسقط صلاحية — المصدر معرّف لا عنوان';
END $$;
RESET ROLE;
UPDATE public.profiles SET email='support@mad3oom.online' WHERE id='22222222-2222-4222-8222-222222222222';
UPDATE public.profiles SET email='customer@example.com' WHERE id='66666666-6666-4666-8666-666666666666';

-- ============================================================================
-- ١٣) فوترة واتساب — مفتاحها معرّف، والصف القديم ما زال يعمل
-- ============================================================================
DO $$
DECLARE v_uid uuid;
BEGIN
  SELECT user_id INTO v_uid FROM public.whatsapp_billing_admins
   WHERE email='support@mad3oom.online';
  IF v_uid IS DISTINCT FROM '22222222-2222-4222-8222-222222222222' THEN
    RAISE EXCEPTION 'ترحيل بيانات الفوترة لم يربط الصف بمعرّف (%)', v_uid; END IF;
  IF pg_get_functiondef('public.is_whatsapp_billing_admin()'::regprocedure) ~* 'p\.email|profiles\.email' THEN
    RAISE EXCEPTION 'is_whatsapp_billing_admin ما زالت تقرأ profiles.email'; END IF;
  RAISE NOTICE 'PASS 13: الفوترة بمعرّف لا ببريد، والصف القائم محفوظ';
END $$;

-- ============================================================================
-- ١٤) عدم المساس — سلوك كل من ليس مالكًا مطابق تمامًا لما كان
-- ============================================================================
SET ROLE authenticated;

SET request.jwt.claim.sub = '66666666-6666-4666-8666-666666666666';  -- عميل
DO $$
DECLARE v int;
BEGIN
  IF public.is_admin() OR public.is_platform_staff() OR public.is_company_admin()
     OR public.is_company_member() THEN RAISE EXCEPTION 'العميل نال قدرة'; END IF;
  SELECT count(*) INTO v FROM public.tickets;
  IF v <> 1 THEN RAISE EXCEPTION 'العميل يرى % تذكرة والمتوقع تذكرته', v; END IF;
  RAISE NOTICE 'PASS 14أ: العميل — تذكرته وحده، ولا قدرة';
END $$;

SET request.jwt.claim.sub = '55555555-5555-4555-8555-555555555555';  -- عضو شركة حقيقي
DO $$
DECLARE v_role text; v int;
BEGIN
  RESET ROLE;
  SELECT role INTO v_role FROM public.profiles WHERE id='55555555-5555-4555-8555-555555555555';
  SET LOCAL ROLE authenticated;
  IF v_role <> 'company_user' THEN RAISE EXCEPTION 'رتبة العضو % ', v_role; END IF;
  IF NOT public.is_company_member() THEN RAISE EXCEPTION 'العضو الحقيقي فقد عضويته'; END IF;
  IF public.is_company_admin() THEN RAISE EXCEPTION 'العضو ورث سلطة مدير الشركة'; END IF;
  IF public.is_platform_staff() THEN RAISE EXCEPTION 'العضو نال سلطة منصة'; END IF;
  SELECT count(*) INTO v FROM public.tickets;
  IF v <> 1 THEN RAISE EXCEPTION 'العضو يرى % تذكرة', v; END IF;
  RAISE NOTICE 'PASS 14ب: العضو الحقيقي كما كان — عضوية بلا سلطة';
END $$;

SET request.jwt.claim.sub = '77777777-7777-4777-8777-777777777777';  -- مالك شركة أخرى
DO $$
DECLARE v_cid uuid;
BEGIN
  IF NOT public.is_company_admin() THEN
    RAISE EXCEPTION 'مالك الشركة الأخرى فقد سلطته على شركته'; END IF;
  v_cid := public.current_company_id();
  IF v_cid <> 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' THEN
    RAISE EXCEPTION 'شركته النشطة % وليست شركته', v_cid; END IF;
  IF public.is_platform_staff() OR public.has_elevated_authority() THEN
    RAISE EXCEPTION 'مالك شركة نال سلطة منصة'; END IF;
  RAISE NOTICE 'PASS 14ج: مدير الشركة الأخرى كما كان — شركته وحدها';
END $$;
RESET ROLE;

-- ============================================================================
-- ١٥) سجل التدقيق — يُكتب، ولا يُعدَّل، ولا يُحذف
-- ============================================================================
DO $$
DECLARE v_enter int; v_denied int;
BEGIN
  SELECT count(*) INTO v_enter FROM public.owner_context_audit
   WHERE event='enter' AND actor_id='11111111-1111-4111-8111-111111111111';
  IF v_enter < 5 THEN
    RAISE EXCEPTION 'سجل الدخول ناقص (% صفًّا)', v_enter; END IF;

  SELECT count(*) INTO v_denied FROM public.owner_context_audit WHERE event='denied';
  IF v_denied < 1 THEN
    RAISE EXCEPTION 'المحاولات المرفوضة لم تُسجَّل — الخبر الأمني ضائع'; END IF;

  BEGIN
    UPDATE public.owner_context_audit SET to_context='مزوَّر' WHERE id = (
      SELECT min(id) FROM public.owner_context_audit);
    RAISE EXCEPTION 'FAIL: سجل التدقيق قابل للتعديل';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    DELETE FROM public.owner_context_audit;
    RAISE EXCEPTION 'FAIL: سجل التدقيق قابل للحذف';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  RAISE NOTICE 'PASS 15: السجل يكتب الدخول والرفض، ولا يُعدَّل ولا يُحذف';
END $$;

-- ============================================================================
-- ١٦) ضمانة دائمة — لا بريد في أي تعريف تفويض، ولا رتبة وحدها تمنح الملكية
-- ============================================================================
DO $$
DECLARE v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.is_admin()', 'public.is_support_user()', 'public.is_platform_staff()',
    'public.is_main_admin()', 'public.is_whatsapp_billing_admin()',
    'public.is_platform_owner()', 'public.has_elevated_authority()',
    'public.is_company_admin()', 'public.is_company_member()'
  ] LOOP
    IF pg_get_functiondef(v_fn::regprocedure) ~* '(profiles\.email|mad3oom\.online|mad3oom\.com)' THEN
      RAISE EXCEPTION 'البريد ما زال في %', v_fn;
    END IF;
  END LOOP;

  -- الملكية تشترط السلطة **والرتبة** — فرتبة مزروعة وحدها لا تمنح
  IF pg_get_functiondef('public.is_platform_owner()'::regprocedure) !~ 'platform_authority' THEN
    RAISE EXCEPTION 'is_platform_owner لا تقرأ جدول السلطة'; END IF;
  IF pg_get_functiondef('public.is_platform_owner()'::regprocedure) !~ 'platform_owner' THEN
    RAISE EXCEPTION 'is_platform_owner لا تشترط الرتبة'; END IF;

  -- وعقيدة 035 لم تُمَس
  IF pg_get_functiondef('public.is_platform_staff()'::regprocedure) ~ 'company_(admin|user)' THEN
    RAISE EXCEPTION 'is_platform_staff تشمل دور شركة — الفصل الأمني مكسور'; END IF;
  IF pg_get_functiondef('public.is_company_admin()'::regprocedure) !~ 'owns_a_company' THEN
    RAISE EXCEPTION 'is_company_admin لا تشترط العلاقة'; END IF;
  IF pg_get_functiondef('public.is_company_member()'::regprocedure) !~ 'belongs_to_a_company' THEN
    RAISE EXCEPTION 'is_company_member لا تشترط العلاقة'; END IF;

  RAISE NOTICE 'PASS 16: لا بريد في أي تفويض · الملكية سلطة ورتبة · عقيدة 035 سليمة';
END $$;

SELECT 'ALL PLATFORM OWNER CONTEXT TESTS PASSED';
