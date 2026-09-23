-- ============================================================================
-- اختبار تنفيذي لـ 053: الملكية ليست «أدمن بصلاحيات أكثر».
--
-- كل خاصية تفشل إن انكسرت، وكل محاولة تصعيد تُجرى بجلسة حقيقية عبر RLS:
--
--   ① لا أحد غير المالك يحظره أو يقفله أو يغيّر هويته أو يحذف ملفه —
--      والأعمدة التشغيلية (اشتراكه، نقاطه) تبقى تعمل كأي عميل
--   ② إدارة الإداريين للمالك وحده: مدير المنصة لا يمنح admin ولا يخفّض زميلًا
--      ولا يحظره ولا يحذفه
--   ③ التحقق بخطوتين: بلا 2FA رفض، رمز خاطئ يُحسب ويُسجَّل، الرمز لا يُعاد،
--      النافذة مربوطة بالجلسة وتنتهي
--   ④ حتى المالك: لا عملية حرجة بلا سياق «مالك المنصة» وتحقق حديث
--   ⑤ التفويض staff.support يدير رتبة support وحدها — لا يصنع admin
--   ⑥ سجل الامتيازات يلتقط التغييرات، للمالك وحده، ولا يُعدَّل
--   ⑦ إعفاء بوابة الحساب بصف الملكية لا بالبريد
--   ⑧ حسابات العملاء: صلاحيات الإدارة الحالية بلا تغيير
--
-- التمهيد منسوخ من platform-owner-context.test.sql و owner-sie-authority.test.sql.
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
-- جداول SIE وسياساتها كما هي على الإنتاج قبل 052
-- ============================================================================
CREATE TABLE public.sie_settings (
  key text PRIMARY KEY, value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid);
CREATE TABLE public.customer_sie_access (
  user_id uuid PRIMARY KEY, is_enabled boolean NOT NULL DEFAULT false,
  access_mode text DEFAULT 'quota', message_quota int, messages_used int DEFAULT 0);

-- قبل 052: البريد وحده، وطاقم المحرك = فريق المنصة
CREATE OR REPLACE FUNCTION public.is_sie_admin() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
begin
  return coalesce((select email from auth.users where id = auth.uid()) = 'support@mad3oom.online', false);
end; $$;
CREATE OR REPLACE FUNCTION public.is_chat_engine_staff() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$ select public.is_platform_staff(); $$;

ALTER TABLE public.sie_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY sie_settings_read ON public.sie_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY sie_settings_write ON public.sie_settings FOR ALL TO authenticated
  USING (public.is_chat_engine_staff()) WITH CHECK (public.is_chat_engine_staff());
ALTER TABLE public.customer_sie_access ENABLE ROW LEVEL SECURITY;
CREATE POLICY sie_access_write ON public.customer_sie_access FOR ALL
  USING (public.is_sie_admin()) WITH CHECK (public.is_sie_admin());
CREATE POLICY sie_access_select ON public.customer_sie_access FOR SELECT
  USING (public.is_sie_admin() OR user_id = auth.uid());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sie_settings, public.customer_sie_access TO authenticated;

INSERT INTO public.sie_settings (key, value) VALUES ('engine_enabled', 'true'::jsonb);

-- خط الأساس: قبل 052 المالك ليس مدير SIE — هذا هو العيب المُصلَح
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$ BEGIN
  IF public.is_sie_admin() THEN RAISE EXCEPTION 'خط الأساس خاطئ: المالك مدير SIE قبل 052'; END IF;
  IF public.is_chat_engine_staff() THEN RAISE EXCEPTION 'خط الأساس خاطئ: المالك طاقم بلا سياق قبل 052'; END IF;
END $$;
RESET request.jwt.claim.sub;

\i migrations/052_owner_sie_authority.sql

-- ============================================================================
-- مسبقات 053 كما هي على الإنتاج: 049 (أسرار 2FA)، أعمدة profiles، pgcrypto،
-- وسياسة "Support can update whatsapp_enabled" التي توصل الأدمن العادي لأي صف
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

ALTER TABLE public.profiles
  ADD COLUMN ban_status text DEFAULT 'none', ADD COLUMN ban_until timestamptz,
  ADD COLUMN ban_reason text, ADD COLUMN is_locked boolean DEFAULT false,
  ADD COLUMN failed_login_attempts int DEFAULT 0, ADD COLUMN custom_role_id uuid,
  ADD COLUMN aqar_enabled boolean DEFAULT false, ADD COLUMN forum_posts_count int DEFAULT 0,
  ADD COLUMN updated_at timestamptz DEFAULT now(), ADD COLUMN phone text;

CREATE TABLE public.user_mfa_secrets (
  user_id uuid PRIMARY KEY, totp_secret text NOT NULL, recovery_code_hashes text[] DEFAULT '{}');
REVOKE ALL ON public.user_mfa_secrets FROM authenticated;
CREATE TABLE public.twofa_rate_limits (
  user_id uuid PRIMARY KEY, failed_attempts int, window_start timestamptz, locked_until timestamptz);
REVOKE ALL ON public.twofa_rate_limits FROM authenticated;

CREATE POLICY "Support can view all profiles" ON public.profiles FOR SELECT
  USING (public.is_support_user() OR auth.uid() = id);
CREATE POLICY "Support can update whatsapp_enabled" ON public.profiles FOR UPDATE
  USING (public.is_support_user()) WITH CHECK (public.is_support_user());

INSERT INTO auth.users (id, email) VALUES ('88888888-8888-4888-8888-888888888888', 'newhire@example.com');
INSERT INTO public.profiles (id, email, role) VALUES ('88888888-8888-4888-8888-888888888888', 'newhire@example.com', 'user');

\i migrations/053_owner_authority.sql

-- أدوات الاختبار: جلسة + رمز TOTP الحالي (كما يولّده تطبيق المصادقة)
CREATE OR REPLACE FUNCTION pg_temp.as_user(p_uid text, p_session text DEFAULT 'sess-A') RETURNS void
LANGUAGE sql AS $$
  select set_config('request.jwt.claim.sub', p_uid, false),
         set_config('request.jwt.claims', json_build_object('sub', p_uid, 'session_id', p_session)::text, false);
$$;
CREATE OR REPLACE FUNCTION pg_temp.totp_now(p_secret text, p_offset int DEFAULT 0) RETURNS text
LANGUAGE sql AS $$
  select public._totp_code(public._base32_decode(p_secret), floor(extract(epoch from now()) / 30)::bigint + p_offset);
$$;
GRANT EXECUTE ON FUNCTION pg_temp.as_user(text, text) TO authenticated;

-- ============================================================================
-- ١) حماية المالك — من أدمن عادي ومن مدير منصة
-- ============================================================================
SELECT pg_temp.as_user('44444444-4444-4444-8444-444444444444');   -- أدمن عادي
SET ROLE authenticated;
DO $$
DECLARE n int;
BEGIN
  BEGIN
    UPDATE public.profiles SET ban_status = 'permanent' WHERE id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'FAIL: أدمن حظر المالك';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.profiles SET is_locked = true WHERE id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'FAIL: أدمن قفل المالك';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.profiles SET full_name = 'منتحل' WHERE id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'FAIL: أدمن غيّر اسم المالك';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.profiles SET email = 'x@x.com' WHERE id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'FAIL: أدمن غيّر بريد المالك';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  -- الأعمدة التشغيلية: اعتماد اشتراك المالك ونقاطه تبقى تعمل
  UPDATE public.profiles SET whatsapp_enabled = true, points = points + 5
   WHERE id = '11111111-1111-4111-8111-111111111111';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'الأعمدة التشغيلية للمالك انكسرت'; END IF;
  RAISE NOTICE 'PASS 1a: أدمن عادي لا يحظر المالك ولا يقفله ولا يغيّر هويته، والتشغيل يعمل';
END $$;
RESET ROLE;

SELECT pg_temp.as_user('22222222-2222-4222-8222-222222222222');   -- مدير منصة (support@)
SET ROLE authenticated;
DO $$
BEGIN
  IF NOT public.has_elevated_authority() THEN RAISE EXCEPTION 'التمهيد خاطئ: support@ ليس مرتفعًا'; END IF;
  BEGIN
    DELETE FROM public.profiles WHERE id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'FAIL: مدير منصة حذف ملف المالك';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.profiles SET ban_status = 'temporary', ban_until = now() + interval '1 day'
     WHERE id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'FAIL: مدير منصة حظر المالك';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'PASS 1b: مدير المنصة لا يحذف المالك ولا يحظره';
END $$;

-- ============================================================================
-- ٢) إدارة الإداريين ليست لمدير المنصة
-- ============================================================================
DO $$
BEGIN
  BEGIN
    UPDATE public.profiles SET role = 'admin' WHERE id = '66666666-6666-4666-8666-666666666666';
    RAISE EXCEPTION 'FAIL: مدير منصة منح admin';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.profiles SET role = 'user' WHERE id = '44444444-4444-4444-8444-444444444444';
    RAISE EXCEPTION 'FAIL: مدير منصة خفّض أدمن';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.profiles SET role = 'user' WHERE id = '33333333-3333-4333-8333-333333333333';
    RAISE EXCEPTION 'FAIL: مدير منصة خفّض زميله المرتفع';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.profiles SET ban_status = 'permanent' WHERE id = '44444444-4444-4444-8444-444444444444';
    RAISE EXCEPTION 'FAIL: مدير منصة حظر أدمن';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    DELETE FROM public.profiles WHERE id = '44444444-4444-4444-8444-444444444444';
    RAISE EXCEPTION 'FAIL: مدير منصة حذف أدمن';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.profiles SET role = 'platform_owner' WHERE id = '22222222-2222-4222-8222-222222222222';
    RAISE EXCEPTION 'FAIL: رتبة المالك مُنحت';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.owner_set_staff_role('66666666-6666-4666-8666-666666666666', 'admin');
    RAISE EXCEPTION 'FAIL: مدير منصة نادى RPC المالك';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.owner_step_up('000000');
    RAISE EXCEPTION 'FAIL: غير المالك بدأ تحققًا بخطوتين للمالك';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO public.platform_capability_grants (user_id, capability) VALUES ('22222222-2222-4222-8222-222222222222', 'staff.support');
    RAISE EXCEPTION 'FAIL: مدير منصة فوّض نفسه';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'PASS 2: مدير المنصة لا يمنح ولا يخفّض ولا يحظر ولا يحذف إداريًا، ولا يفوّض نفسه';
END $$;
RESET ROLE;

-- أدمن عادي: لا يمنح support بلا تفويض، ولا يرفع حظرًا عن نفسه
SELECT pg_temp.as_user('44444444-4444-4444-8444-444444444444');
SET ROLE authenticated;
DO $$
BEGIN
  BEGIN
    UPDATE public.profiles SET role = 'support' WHERE id = '88888888-8888-4888-8888-888888888888';
    RAISE EXCEPTION 'FAIL: أدمن بلا تفويض منح support';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'PASS 2b: بلا تفويض لا إدارة لفريق الدعم';
END $$;
RESET ROLE;

-- ============================================================================
-- ٣) التحقق بخطوتين
-- ============================================================================
SELECT pg_temp.as_user('11111111-1111-4111-8111-111111111111');
SET ROLE authenticated;
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM public.enter_context('owner');
  r := public.owner_step_up('123456');
  IF r->>'error' <> 'mfa_not_enrolled' THEN RAISE EXCEPTION 'بلا 2FA: %', r; END IF;
  IF public.owner_critical_ok() THEN RAISE EXCEPTION 'عملية حرجة بلا 2FA'; END IF;
  BEGIN
    PERFORM public.owner_set_staff_role('66666666-6666-4666-8666-666666666666', 'admin');
    RAISE EXCEPTION 'FAIL: المالك منح admin بلا تحقق';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.profiles SET role = 'admin' WHERE id = '66666666-6666-4666-8666-666666666666';
    RAISE EXCEPTION 'FAIL: المالك منح admin مباشرة بلا تحقق';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'PASS 3a: بلا 2FA مفعّل لا عملية حرجة — حتى للمالك';
END $$;
RESET ROLE;

-- تسجيل 2FA للمالك (ما يفعله divert_mfa_secrets في 049 عند التفعيل)
INSERT INTO public.user_mfa_secrets (user_id, totp_secret)
VALUES ('11111111-1111-4111-8111-111111111111', 'JBSWY3DPEHPK3PXP');
CREATE TEMP TABLE _codes AS
  SELECT pg_temp.totp_now('JBSWY3DPEHPK3PXP') AS good,
         CASE WHEN pg_temp.totp_now('JBSWY3DPEHPK3PXP') = '000000' THEN '111111' ELSE '000000' END AS bad;
GRANT SELECT ON _codes TO authenticated;

SET ROLE authenticated;
DO $$
DECLARE r jsonb;
BEGIN
  r := public.owner_step_up((SELECT bad FROM _codes));
  IF (r->>'verified')::boolean OR r->>'error' <> 'invalid_code' THEN RAISE EXCEPTION 'رمز خاطئ قُبل: %', r; END IF;
  IF public.step_up_fresh() THEN RAISE EXCEPTION 'نافذة بعد رمز خاطئ'; END IF;
  r := public.owner_step_up((SELECT good FROM _codes));
  IF NOT (r->>'verified')::boolean THEN RAISE EXCEPTION 'الرمز الصحيح رُفض: %', r; END IF;
  IF NOT public.owner_critical_ok() THEN RAISE EXCEPTION 'لا نافذة بعد تحقق صحيح'; END IF;
  r := public.owner_step_up((SELECT good FROM _codes));
  IF (r->>'verified')::boolean THEN RAISE EXCEPTION 'الرمز نفسه أُعيد استعماله'; END IF;
  RAISE NOTICE 'PASS 3b: رمز خاطئ يُرفض، الصحيح يفتح نافذة، ولا إعادة لرمز مستعمل';
END $$;
RESET ROLE;

DO $$
BEGIN
  -- النجاح صفّر العدّاد، ثم محاولة إعادة الرمز المستعمل حُسبت فشلًا واحدًا
  IF (SELECT failed_attempts FROM public.twofa_rate_limits WHERE user_id = '11111111-1111-4111-8111-111111111111') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'العدّاد لا يعكس: نجاح يصفّر ثم إعادة رمز تُحسب فشلًا';
  END IF;
  IF (SELECT count(*) FROM public.privileged_audit WHERE action = 'step_up.failed') < 2 THEN
    RAISE EXCEPTION 'محاولات التحقق الفاشلة لم تُسجَّل';
  END IF;
  RAISE NOTICE 'PASS 3c: الفشل محفوظ في العدّاد والسجل رغم عدم رفع استثناء';
END $$;

-- النافذة مربوطة بجلسة الدخول
SELECT pg_temp.as_user('11111111-1111-4111-8111-111111111111', 'sess-STOLEN');
SET ROLE authenticated;
DO $$ BEGIN
  IF public.step_up_fresh() THEN RAISE EXCEPTION 'نافذة التحقق عبرت إلى جلسة أخرى'; END IF;
  RAISE NOTICE 'PASS 3d: التحقق لا ينتقل لجلسة أخرى';
END $$;
RESET ROLE;
SELECT pg_temp.as_user('11111111-1111-4111-8111-111111111111');

-- ============================================================================
-- ٤) المالك: سياق «مالك المنصة» شرط، ثم الإدارة تعمل
-- ============================================================================
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM public.enter_context('admin');
  IF public.owner_critical_ok() THEN RAISE EXCEPTION 'عملية حرجة خارج سياق المالك'; END IF;
  BEGIN
    PERFORM public.owner_set_staff_role('66666666-6666-4666-8666-666666666666', 'admin');
    RAISE EXCEPTION 'FAIL: عملية حرجة من سياق الإدارة';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM public.enter_context('owner');

  PERFORM public.owner_set_staff_role('66666666-6666-4666-8666-666666666666', 'admin');
  IF (SELECT role FROM public.profiles WHERE id = '66666666-6666-4666-8666-666666666666') <> 'admin' THEN
    RAISE EXCEPTION 'المالك لم يمنح admin';
  END IF;
  PERFORM public.owner_set_platform_admin('66666666-6666-4666-8666-666666666666', true, 'اختبار');
  IF (SELECT count(*) FROM public.platform_authority WHERE user_id = '66666666-6666-4666-8666-666666666666') <> 1 THEN
    RAISE EXCEPTION 'المالك لم يعيّن مدير منصة';
  END IF;
  -- التخفيض يُسقط السلطة والتفويض معه
  PERFORM public.owner_set_staff_role('66666666-6666-4666-8666-666666666666', 'user');
  IF EXISTS (SELECT 1 FROM public.platform_authority WHERE user_id = '66666666-6666-4666-8666-666666666666') THEN
    RAISE EXCEPTION 'بقي صف سلطة معلّق بعد التخفيض';
  END IF;
  BEGIN
    PERFORM public.owner_set_platform_admin('11111111-1111-4111-8111-111111111111', false, null);
    RAISE EXCEPTION 'FAIL: المالك عبث بصفّه';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  PERFORM public.owner_set_capability('44444444-4444-4444-8444-444444444444', 'staff.support', true, 'مشرف الدعم');
  BEGIN
    PERFORM public.owner_set_capability('44444444-4444-4444-8444-444444444444', 'owner.everything', true, null);
    RAISE EXCEPTION 'FAIL: قدرة خارج القائمة المغلقة';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'PASS 4: المالك يدير الإداريين والتفويض من سياقه بعد التحقق فقط';
END $$;
RESET ROLE;

-- ============================================================================
-- ٥) التفويض staff.support
-- ============================================================================
SELECT pg_temp.as_user('44444444-4444-4444-8444-444444444444');
SET ROLE authenticated;
DO $$
BEGIN
  UPDATE public.profiles SET role = 'support' WHERE id = '88888888-8888-4888-8888-888888888888';
  UPDATE public.profiles SET ban_status = 'temporary', ban_until = now() + interval '1 day'
   WHERE id = '88888888-8888-4888-8888-888888888888';
  UPDATE public.profiles SET ban_status = 'none', ban_until = null
   WHERE id = '88888888-8888-4888-8888-888888888888';
  BEGIN
    UPDATE public.profiles SET role = 'admin' WHERE id = '88888888-8888-4888-8888-888888888888';
    RAISE EXCEPTION 'FAIL: المفوَّض صنع admin';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.profiles SET ban_status = 'permanent' WHERE id = '22222222-2222-4222-8222-222222222222';
    RAISE EXCEPTION 'FAIL: المفوَّض حظر مدير منصة';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.profiles SET ban_status = 'permanent' WHERE id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'FAIL: المفوَّض حظر المالك';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'PASS 5: staff.support يدير الدعم وحده — لا admin ولا مدير منصة ولا مالك';
END $$;
RESET ROLE;

-- ============================================================================
-- ٦) سجل الامتيازات
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.privileged_audit
                  WHERE action = 'role.change' AND target_user_id = '66666666-6666-4666-8666-666666666666'
                    AND actor_tier = 'owner' AND step_up AND context = 'owner') THEN
    RAISE EXCEPTION 'تغيير الرتبة من المالك لم يُسجَّل بسياقه وتحققه';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.privileged_audit
                  WHERE action = 'role.change' AND target_user_id = '88888888-8888-4888-8888-888888888888'
                    AND actor_tier = 'admin') THEN
    RAISE EXCEPTION 'تغيير الرتبة المفوَّض لم يُسجَّل';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.privileged_audit WHERE action LIKE 'platform_authority.%')
     OR NOT EXISTS (SELECT 1 FROM public.privileged_audit WHERE action LIKE 'platform_capability_grants.%')
     OR NOT EXISTS (SELECT 1 FROM public.privileged_audit WHERE action = 'account.restriction') THEN
    RAISE EXCEPTION 'السلطة أو التفويض أو الحظر لم يُسجَّل';
  END IF;
  BEGIN
    DELETE FROM public.privileged_audit;
    RAISE EXCEPTION 'FAIL: حُذف سجل الامتيازات';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'PASS 6a: كل تغيير امتياز مُسجَّل بفاعله وطبقته وسياقه، والسجل لا يُحذف';
END $$;

SELECT pg_temp.as_user('22222222-2222-4222-8222-222222222222');
SET ROLE authenticated;
DO $$ BEGIN
  IF (SELECT count(*) FROM public.privileged_audit) <> 0 THEN RAISE EXCEPTION 'مدير منصة يقرأ سجل الامتيازات'; END IF;
  RAISE NOTICE 'PASS 6b: السجل للمالك وحده';
END $$;
RESET ROLE;

-- ============================================================================
-- ٧) إعفاء البوابة بالملكية لا بالبريد
-- ============================================================================
UPDATE public.profiles SET email = 'mahmoud@mad3oom.com' WHERE id = '66666666-6666-4666-8666-666666666666';
DO $$ BEGIN
  IF public.gate_is_exempt_account('66666666-6666-4666-8666-666666666666') THEN RAISE EXCEPTION 'البريد أعفى حسابًا'; END IF;
  IF NOT public.gate_is_exempt_account('11111111-1111-4111-8111-111111111111') THEN RAISE EXCEPTION 'المالك فقد إعفاءه'; END IF;
  RAISE NOTICE 'PASS 7: إعفاء البوابة بصف الملكية وحده';
END $$;

-- ============================================================================
-- ٨) حسابات العملاء: الإدارة الحالية بلا تغيير — و SIE يتطلب التحقق
-- ============================================================================
SELECT pg_temp.as_user('44444444-4444-4444-8444-444444444444');
SET ROLE authenticated;
DO $$
DECLARE n int;
BEGIN
  UPDATE public.profiles SET ban_status = 'temporary', whatsapp_enabled = true
   WHERE id = '66666666-6666-4666-8666-666666666666';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'الأدمن فقد إدارة العملاء'; END IF;
  RAISE NOTICE 'PASS 8a: إدارة العملاء كما هي';
END $$;
RESET ROLE;

-- انتهاء النافذة يُسقط العمليات الحرجة، ومنح SIE صار منها
UPDATE public.privileged_step_ups SET expires_at = now() - interval '1 second'
 WHERE user_id = '11111111-1111-4111-8111-111111111111';
SELECT pg_temp.as_user('11111111-1111-4111-8111-111111111111');
SET ROLE authenticated;
DO $$ BEGIN
  IF public.step_up_fresh() THEN RAISE EXCEPTION 'نافذة منتهية ما زالت سارية'; END IF;
  BEGIN
    PERFORM public.owner_grant_sie_admin('44444444-4444-4444-8444-444444444444', null);
    RAISE EXCEPTION 'FAIL: منح SIE بلا تحقق';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'PASS 8b: النافذة تنتهي، ومنح SIE يتطلب التحقق';
END $$;
RESET ROLE;

SELECT 'ALL OWNER AUTHORITY TESTS PASSED';
