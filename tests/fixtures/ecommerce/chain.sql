-- ============================================================================
-- نسخة مطابقة للإنتاج كما قُرئت 2026-10-28 (list_migrations على srnelrdpqkcntbgudyto):
-- حتى 114 + Pi (115/116)، وبلا 112 و 113 و 117 (غير مطبقة على الإنتاج).
-- ثم عُدّة تعدد الشركات (فاعلون ثابتون في شركتين + طاقم المنصة).
--
-- الاستعمال (من جذر المستودع):  \i tests/fixtures/ecommerce/chain.sql
-- ============================================================================
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
\i migrations/114_ticket_email_payload.sql
\i migrations/115_pi_network_integration.sql
\i migrations/116_pi_auto_settlement.sql
SET search_path = public, extensions;

UPDATE auth.users SET email_confirmed_at = now() - interval '30 days';

-- مفاتيح المنصة كما في الإنتاج 2026-10-28 (platform_feature_switches)
UPDATE public.platform_feature_switches SET enabled = (key in (
  'company_permissions_enabled', 'multi_company_memberships_enabled', 'delegation_enabled',
  'company_isolation_enforced', 'customer_transfers_enabled', 'ticket_carry_enabled',
  'account_request_execution_enabled', 'company_inbox_enabled', 'company_documents_enabled'));
