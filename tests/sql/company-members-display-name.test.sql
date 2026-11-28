-- اختبار تنفيذي لـ migrations/152_company_members_display_name.sql
-- اسم العضو في القائمة يفضّل «اسم العرض» المحلي للشركة على اسم الحساب.
--   ① عرض: عضو له ملف شركة (display_name) يظهر باسمه المعروض لا باسم حسابه
--   ② سقوط: عضو بلا ملف شركة يظهر باسمه في الحساب كما قبل
--   ③ عزل: نفس العضو له اسم عرض مختلف في شركة ثانية — قائمة الأولى لا تتأثر
--   ④ غير المدير: يرى نفسه باسمه المعروض ومديره باسمه في الحساب
--   ⑤ التراجع: يعيد نسخة 096 حرفيًا (الاسم من الحساب فقط) ثم إعادة التطبيق
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
  id uuid PRIMARY KEY, email text, full_name text, username text,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE,
  company_name varchar NOT NULL, commercial_registration_number varchar NOT NULL UNIQUE
);
CREATE TABLE public.company_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
  user_id uuid NOT NULL, status text NOT NULL DEFAULT 'active',
  joined_at timestamptz DEFAULT now()
);
CREATE TABLE public.company_member_profiles (
  company_id uuid NOT NULL, user_id uuid NOT NULL,
  display_name text, phone text, job_title text, notes text,
  updated_by uuid, updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (company_id, user_id)
);

-- حارسات مصغّرة بنفس توقيعات الإنتاج لما تحتاجه company_members() وحدها.
CREATE OR REPLACE FUNCTION public.current_company_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT coalesce((select id from public.companies where user_id = auth.uid()),
                  (select company_id from public.company_memberships
                    where user_id = auth.uid() and status = 'active' limit 1));
$$;
CREATE OR REPLACE FUNCTION public.is_company_admin() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT exists(select 1 from public.companies where user_id = auth.uid());
$$;
CREATE OR REPLACE FUNCTION public.account_is_active() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true; $$;
CREATE OR REPLACE FUNCTION public.preview_mode() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false; $$;
CREATE OR REPLACE FUNCTION public.company_role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT case when public.is_company_admin() then 'company_admin' else 'company_user' end;
$$;
CREATE OR REPLACE FUNCTION public.can_manage_company_members() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT public.is_company_admin();
$$;

-- ── البيانات ─────────────────────────────────────────────────────────────
INSERT INTO public.profiles (id, email, full_name, username) VALUES
  ('11111111-1111-1111-1111-111111111111', 'owner@example.com', 'مالك الشركة', 'owner'),
  ('22222222-2222-2222-2222-222222222222', 'member1@example.com', 'الاسم القديم', 'member1'),
  ('33333333-3333-3333-3333-333333333333', 'member2@example.com', 'عضو بلا ملف', 'member2'),
  ('44444444-4444-4444-4444-444444444444', 'owner2@example.com', 'مالك الثانية', 'owner2');
INSERT INTO public.companies (id, user_id, company_name, commercial_registration_number) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'الشركة الأولى', 'CR-1'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '44444444-4444-4444-4444-444444444444', 'الشركة الثانية', 'CR-2');
INSERT INTO public.company_memberships (company_id, user_id, status) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'active'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'active'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'active');
-- ملف الشركة للعضو الأول في الأولى، واسم عرض مختلف له في الثانية (فخ العزل).
INSERT INTO public.company_member_profiles (company_id, user_id, display_name, job_title) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'موظف الموارد البشرية', 'موظف الموارد البشرية'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'اسم الشركة الثانية', 'أخرى');

\i migrations/152_company_members_display_name.sql

DO $$
declare
  v jsonb; v_name text;
begin
  -- ① المدير: العضو الأول باسمه المعروض
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
  v := public.company_members();
  select x ->> 'name' into v_name from jsonb_array_elements(v -> 'members') x where x ->> 'id' = '22222222-2222-2222-2222-222222222222';
  if v_name is distinct from 'موظف الموارد البشرية' then raise exception 'FAIL 1 display name: got %', v_name; end if;
  raise notice 'PASS 1 display name wins over account name';
  -- ② السقوط: العضو الثاني بلا ملف يظهر باسمه في الحساب
  select x ->> 'name' into v_name from jsonb_array_elements(v -> 'members') x where x ->> 'id' = '33333333-3333-3333-3333-333333333333';
  if v_name is distinct from 'عضو بلا ملف' then raise exception 'FAIL 2 fallback: got %', v_name; end if;
  raise notice 'PASS 2 fallback to account name';
  -- ③ العزل: اسم الشركة الثانية لم يتسرب (① يثبته: الاسم من الأولى لا الثانية)
  -- ④ غير المدير (العضو الأول): يرى نفسه باسمه المعروض ومديره باسمه في الحساب
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
  v := public.company_members();
  select x ->> 'name' into v_name from jsonb_array_elements(v -> 'members') x where x ->> 'id' = '22222222-2222-2222-2222-222222222222';
  if v_name is distinct from 'موظف الموارد البشرية' then raise exception 'FAIL 4a self display name: got %', v_name; end if;
  select x ->> 'name' into v_name from jsonb_array_elements(v -> 'members') x where x ->> 'id' = '11111111-1111-1111-1111-111111111111';
  if v_name is distinct from 'مالك الشركة' then raise exception 'FAIL 4b owner name: got %', v_name; end if;
  raise notice 'PASS 4 non-admin sees self display name and owner account name';
  perform set_config('request.jwt.claim.sub', '', false);
end $$;

-- ⑤ التراجع ثم إعادة التطبيق
\i migrations/_rollback/152_company_members_display_name.down.sql
DO $$
declare
  v jsonb; v_name text;
begin
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
  v := public.company_members();
  select x ->> 'name' into v_name from jsonb_array_elements(v -> 'members') x where x ->> 'id' = '22222222-2222-2222-2222-222222222222';
  if v_name is distinct from 'الاسم القديم' then raise exception 'FAIL 5 rollback: got %', v_name; end if;
  raise notice 'PASS 5 rollback restores 096 (account name only)';
  perform set_config('request.jwt.claim.sub', '', false);
end $$;
\i migrations/152_company_members_display_name.sql
DO $$
declare
  v jsonb; v_name text;
begin
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
  v := public.company_members();
  select x ->> 'name' into v_name from jsonb_array_elements(v -> 'members') x where x ->> 'id' = '22222222-2222-2222-2222-222222222222';
  if v_name is distinct from 'موظف الموارد البشرية' then raise exception 'FAIL 5b reapply: got %', v_name; end if;
  raise notice 'PASS 5b reapply restores display name';
  perform set_config('request.jwt.claim.sub', '', false);
end $$;

SELECT 'ALL company-members-display-name tests passed';
