-- ============================================================================
-- قاعدة اختبار عزل الشركات عبر HTTP (tests/http/tenant-isolation-http.test.mjs)
--
-- نفس سلسلة tests/sql/tenant-isolation-matrix.test.sql (لقطة مخطط الإنتاج + 094→111، ثم 112 و113، بترتيب
-- الإنتاج، 109 قبل 108) ونفس المعطيات الاصطناعية، ثم ما يحتاجه PostgREST حقيقي أمامها:
--   • auth.uid() / auth.role() / auth.jwt() بنصوص الإنتاج حرفيًا (2026-10-21): تقرأ request.jwt.claims
--     التي يضبطها PostgREST 12 من JWT الطلب — لا بدائل اللقطة التي تقرأ request.jwt.claim.* وحدها.
--   • دور authenticator (LOGIN NOINHERIT) عضو في anon وauthenticated وservice_role كما في الإنتاج.
-- لا شيء هنا يلمس الإنتاج.
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

\i tests/fixtures/prod-shape/load.sql
\i tests/fixtures/prod-shape/chain-to-093.sql
\i migrations/094_continuity_reminders.sql
SET search_path = public, extensions;
\i tests/fixtures/tenancy/harness.sql
\i migrations/095_account_boundaries.sql
\i migrations/096_company_memberships.sql
SET search_path = public, extensions;
SET check_function_bodies = off;
\i tests/fixtures/tenancy/tickets.sql
\i migrations/097_ticket_scope_isolation.sql
\i migrations/098_company_permissions_usage_ledger.sql
\i migrations/099_admin_hierarchy.sql
\i migrations/100_company_documents.sql
\i migrations/101_customer_transfers_carry.sql
\i migrations/102_company_conversations.sql
\i migrations/103_admin_hierarchy_followups.sql
\i migrations/104_company_documents_followups.sql
SET search_path = public, extensions;
SET check_function_bodies = on;
\i migrations/105_account_hierarchy_customers.sql
\i migrations/106_account_request_execution.sql
\i migrations/107_isolation_readiness.sql
\i migrations/109_registration_mode_public_read.sql
\i migrations/108_phase1_readiness_fixes.sql
\i migrations/110_api_token_credentials_immutable.sql
\i migrations/111_billing_ticket_isolation.sql
\i migrations/112_company_invitation_email.sql
\i migrations/113_company_member_management.sql
SET search_path = public, extensions;

-- ── هوية الطلب كما في الإنتاج ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  select
    coalesce(
        nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb
$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN NOINHERIT;
  END IF;
END $$;
GRANT anon, authenticated, service_role TO authenticator;

-- ── معطيات إضافية اصطناعية (كما في المصفوفة) ─────────────────────────────────
INSERT INTO public.accounting_invoices (external_invoice_id, invoice_number, ticket_id, user_id, total)
VALUES (gen_random_uuid(), 'FX-A1', t.k('TA1'), t.u('A1'), 10),
       (gen_random_uuid(), 'FX-A1S', t.k('TA1S'), t.u('A1'), 10);

-- تغيير مفتاح بمسار المالك الحقيقي (owner_set_feature_switch بعد خطوة تحقق حديثة)، لا تحديثًا خامًا
CREATE FUNCTION t.owner_sw(p_key text, p_on boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  r := t.call(t.u('OW'), format('public.owner_set_feature_switch(%L, %L, %L)', p_key, p_on, 'تحقق عزل الشركات عبر HTTP بمعطيات اصطناعية'));
  PERFORM t.ctx(null);
  RETURN r;
END $$;

-- ما يراه الفاعل من التذاكر الاصطناعية عبر SQL (للمقارنة بما يعيده HTTP)
CREATE FUNCTION t.sql_visible(p text) RETURNS text LANGUAGE sql AS $$
  select coalesce(string_agg(k, ',' order by k), '')
    from unnest(array['TA1','TA1S','TA2','TB1','TOA','TAS','TPU']) k
   where t.sees(p, k) $$;

DO $$ BEGIN
  PERFORM t.ok(NOT public._isolation_on(), 'HTTP-STACK isolation off at start');
  PERFORM t.ok((SELECT count(*) FROM public.platform_feature_switches WHERE enabled) = 0, 'HTTP-STACK all switches off');
END $$;
SELECT 'HTTP STACK READY';
