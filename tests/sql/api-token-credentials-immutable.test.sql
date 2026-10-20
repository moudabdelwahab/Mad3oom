-- ============================================================================
-- 110: أعمدة الاعتماد في api_tokens لا يكتبها أي JWT، والأدمن منه (F7)
-- على نسخة مطابقة للإنتاج حتى 109 (الحارس قبل 110 يطابق الإنتاج: md5 6b6b4b14…).
--   ⓪ قبل 110: الأدمن يكتب secret_hash و bearer_token_hash و user_id لمفتاح مالك المنصة (F7 مُثبتة)
--   ① بعد 110 (مرتين): الأدمن والأدمن المرتفع ومالك المنصة يُرفضون على كل أعمدة الاعتماد بـ 42501
--   ② ما بقي: الأدمن يعطّل ويفعّل ويغيّر scopes و expires_at؛ صاحب المفتاح يعطّل ويُرفض على scopes والاعتماد؛
--      مفتاح الخدمة يكتب الاعتماد (create-api-token و regenerate-api-token-secret)
--   ③ التراجع: مرفوض والعزل مفعّل؛ والعزل مطفأ يعيد تعريف الإنتاج حرفيًا (md5) ثم يُعاد 110
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
SET search_path = public, extensions;

-- مفتاح لمالك المنصة (مالك الشركة W) ومفتاح لمالك الشركة A
INSERT INTO public.api_tokens (id, user_id, name, api_key, secret_hash, secret_last_four, is_active)
VALUES ('a0000000-0000-4000-8000-0000000000f1', t.u('OW'), 'مفتاح OW', 'mk_ow_public', 'hash-ow', 'owow', true),
       ('a0000000-0000-4000-8000-0000000000f2', t.u('OA'), 'مفتاح OA', 'mk_oa_public', 'hash-oa', 'oaoa', true);

CREATE FUNCTION t.upd(p text, p_set text, p_tok text DEFAULT 'f1') RETURNS text LANGUAGE sql AS $$
  select t.exec(t.u(p), format('update public.api_tokens set %s where id = %L', p_set,
                               'a0000000-0000-4000-8000-0000000000' || p_tok)) $$;
CREATE FUNCTION t.n(p text, p_set text, p_tok text DEFAULT 'f1') RETURNS int LANGUAGE sql AS $$
  select t.affected(t.u(p), format('update public.api_tokens set %s where id = %L', p_set,
                                   'a0000000-0000-4000-8000-0000000000' || p_tok)) $$;

-- ⓪ قبل 110 ─────────────────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM t.ok(md5(pg_get_functiondef('public.guard_api_token_protected_columns()'::regprocedure)) = '6b6b4b14e7f1b312f362cfb5fe9612c6',
               '⓪ الحارس قبل 110 يطابق الإنتاج');
  PERFORM t.ok(t.n('AD', 'secret_hash = ''attacker-hash'', is_active = true, revoked_at = null') = 1, '⓪ F7: الأدمن يكتب secret_hash لمفتاح مالك المنصة');
  PERFORM t.ok(t.n('AD', 'bearer_token_hash = ''attacker-bearer''') = 1, '⓪ F7: الأدمن يكتب bearer_token_hash');
  PERFORM t.ok(t.n('AD', format('user_id = %L', t.u('AD')), 'f2') = 1, '⓪ F7: الأدمن ينقل مفتاح مالك الشركة إلى نفسه');
  RAISE NOTICE 'PASS ⓪ قبل 110: F7 مُثبتة (secret_hash و bearer_token_hash و user_id)';
END $$;
UPDATE public.api_tokens SET secret_hash = 'hash-ow', bearer_token_hash = null WHERE id = 'a0000000-0000-4000-8000-0000000000f1';
UPDATE public.api_tokens SET user_id = t.u('OA') WHERE id = 'a0000000-0000-4000-8000-0000000000f2';

-- ① 110 مرتين ───────────────────────────────────────────────────────────────
\i migrations/110_api_token_credentials_immutable.sql
\i migrations/110_api_token_credentials_immutable.sql
SET search_path = public, extensions;

DO $$
DECLARE who text; col text;
BEGIN
  FOREACH who IN ARRAY array['AD', 'EA', 'OW'] LOOP
    FOREACH col IN ARRAY array['secret_hash = ''x''', 'bearer_token_hash = ''x''', 'api_key = ''mk_x''', 'secret_last_four = ''xxxx''',
                               'bearer_last_four = ''xxxx''', 'credential_type = ''bearer''', 'created_at = now()',
                               format('user_id = %L', t.u('PU'))] LOOP
      PERFORM t.ok(t.upd(who, col) = '42501', format('① %s: %s مرفوض', who, col));
      -- مالك المنصة خارج سياق المالك ليس is_admin(): RLS لا تُظهر له مفتاح A أصلًا (0 صف) — رفض أيضًا
      PERFORM t.ok(t.upd(who, col, 'f2') = '42501' or t.n(who, col, 'f2') = 0, format('① %s: %s على مفتاح شركة A مرفوض', who, col));
    END LOOP;
  END LOOP;
  PERFORM t.ok((select secret_hash = 'hash-ow' and bearer_token_hash is null and user_id = t.u('OW')
                  from public.api_tokens where id = 'a0000000-0000-4000-8000-0000000000f1'), '① مفتاح OW لم يتغير');
  PERFORM t.ok((select user_id = t.u('OA') and secret_hash = 'hash-oa' from public.api_tokens
                  where id = 'a0000000-0000-4000-8000-0000000000f2'), '① مفتاح OA لم يتغير');
  RAISE NOTICE 'PASS ① بعد 110: الأدمن والأدمن المرتفع ومالك المنصة مرفوضون على كل أعمدة الاعتماد (42501)';
END $$;

-- ② ما بقي ─────────────────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM t.ok(t.n('AD', 'is_active = false, revoked_at = now()') = 1, '② الأدمن يعطّل مفتاح غيره');
  PERFORM t.ok(t.n('AD', 'is_active = true, revoked_at = null') = 1, '② الأدمن يفعّله');
  PERFORM t.ok(t.n('AD', 'scopes = ''["tickets:read"]''::jsonb, expires_at = now() + interval ''30 days''') = 1, '② الأدمن يغيّر scopes و expires_at');
  PERFORM t.ok(t.n('AD', 'name = ''اسم'', description = ''وصف''') = 1, '② الأدمن يغيّر الاسم والوصف');
  PERFORM t.ok(t.n('OA', 'is_active = false, revoked_at = now()', 'f2') = 1, '② صاحب المفتاح يعطّله');
  PERFORM t.ok(t.upd('OA', 'scopes = ''["admin:full"]''::jsonb', 'f2') = '42501', '② صاحب المفتاح لا يرفع scopes');
  PERFORM t.ok(t.upd('OA', 'secret_hash = ''x''', 'f2') = '42501', '② صاحب المفتاح لا يكتب secret_hash');
  PERFORM t.ok(t.n('A1', 'is_active = true', 'f2') = 0, '② غير المالك لا يصل لمفتاح غيره (RLS)');
  RAISE NOTICE 'PASS ② التعطيل والتفعيل وscopes وexpires_at للأدمن باقية؛ صاحب المفتاح كما في 043';
END $$;
-- مفتاح الخدمة (auth.uid() فارغ): create-api-token و regenerate-api-token-secret
SET ROLE service_role;
UPDATE public.api_tokens SET secret_hash = 'rotated', secret_last_four = 'rot1', bearer_token_hash = 'b', bearer_last_four = 'bbbb',
       revoked_at = null, is_active = true WHERE id = 'a0000000-0000-4000-8000-0000000000f1';
RESET ROLE;
DO $$ BEGIN
  PERFORM t.ok((select secret_hash = 'rotated' and bearer_last_four = 'bbbb' from public.api_tokens
                  where id = 'a0000000-0000-4000-8000-0000000000f1'), '② مفتاح الخدمة يجدّد الاعتماد');
  RAISE NOTICE 'PASS ② مفتاح الخدمة يكتب الاعتماد (مسار دوال الحافة)';
END $$;

-- ③ التراجع ───────────────────────────────────────────────────────────────
UPDATE public.platform_feature_switches SET enabled = true WHERE key = 'company_isolation_enforced';
\set ON_ERROR_STOP off
BEGIN;
\i migrations/_rollback/110_api_token_credentials_immutable.down.sql
ROLLBACK;
\set ON_ERROR_STOP on
DO $$ BEGIN
  PERFORM t.ok(position('ولو كان أدمن' in pg_get_functiondef('public.guard_api_token_protected_columns()'::regprocedure)) > 0,
               '③ التراجع مرفوض والعزل مفعّل: الحارس لم يتغير');
  RAISE NOTICE 'PASS ③ التراجع مرفوض ما دام company_isolation_enforced مفعّلًا';
END $$;
UPDATE public.platform_feature_switches SET enabled = false WHERE key = 'company_isolation_enforced';
\i migrations/_rollback/110_api_token_credentials_immutable.down.sql
DO $$ BEGIN
  PERFORM t.ok(md5(pg_get_functiondef('public.guard_api_token_protected_columns()'::regprocedure)) = '6b6b4b14e7f1b312f362cfb5fe9612c6',
               '③ التراجع يعيد تعريف الإنتاج حرفيًا');
  PERFORM t.ok(not has_function_privilege('authenticated', 'public.guard_api_token_protected_columns()', 'execute'), '③ الصلاحيات كما هي');
  RAISE NOTICE 'PASS ③ التراجع يعيد الحارس كما في الإنتاج (md5 6b6b4b14…)';
END $$;
\i migrations/110_api_token_credentials_immutable.sql
SET search_path = public, extensions;
DO $$ BEGIN
  PERFORM t.ok(t.upd('AD', 'secret_hash = ''x''') = '42501', '③ إعادة 110 بعد التراجع تعمل');
  RAISE NOTICE 'PASS ③ إعادة تطبيق 110 بعد التراجع';
  RAISE NOTICE 'ALL api-token-credentials-immutable: PASS';
END $$;
