-- ============================================================================
-- 107_isolation_readiness على نسخة مطابقة للإنتاج حتى 104 + 105 + 106
--   ⓪ قبل 107: الثغرة مُثبتة (العزل مفعّل والدالتان تتجاوزانه)
--   ① الكائنات؛ ①ب التراجع حرفيًا ثم إعادة التطبيق مرتين
--   ② العزل مطفأ: السلوك القديم كما هو حرفيًا
--   ③ العزل مفعّل: مالك الشركة لا يغلق ولا يعيد فتح تذكرة شخصية لعميله مع مدعوم (TA1S)، ولا يعرف وجودها؛
--      يواصل على تذاكر شركته (TA1)؛ العميل يغلق تذكرته؛ طاقم المنصة لا يصل لتذاكر الشركة عبر can_access_ticket
--   ④ التراجع مرفوض مع العزل مفعّلًا
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
SET search_path = public, extensions;
CREATE FUNCTION t.b(p text, p_sql text) RETURNS boolean LANGUAGE sql AS $$ select (t.call(t.u(p), p_sql) #>> '{}')::boolean $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;
INSERT INTO t.saved VALUES ('schema106', t.schema_digest());

-- ══ ⓪ قبل 107: الثغرة كما في الإنتاج اليوم ════════════════════════════════
DO $$ BEGIN
  PERFORM t.sw('company_permissions_enabled', true);
  PERFORM t.sw('company_isolation_enforced', true);
  PERFORM t.ok(NOT t.sees('OA', 'TA1S'), 'PRE RLS hides TA1S');
  PERFORM t.ok(t.b('OA', format('public.ticket_in_my_scope(%L::uuid)', t.k('TA1S')))
           AND t.b('OA', format('public.can_access_ticket(%L::uuid)', t.k('TA1S'))), 'PRE definer RPCs bypass isolation');
  PERFORM t.ok(t.err(t.u('OA'), format('public.reopen_ticket_in_my_scope(%L::uuid)', t.k('TA1S'))) = '22023', 'PRE status oracle (not closed ⇒ 22023, not 42501)');
  PERFORM t.sw('company_isolation_enforced', false);
  PERFORM t.sw('company_permissions_enabled', false);
  RAISE NOTICE 'PASS ⓪ قبل 107: مع العزل مفعّلًا تبقى ticket_in_my_scope و can_access_ticket تقبلان تذكرة شخصية لتابع، واختلاف الخطأ يكشف حالتها';
END $$;

-- ══ ① 107 ════════════════════════════════════════════════════════════════
\i migrations/107_isolation_readiness.sql
\i migrations/_rollback/107_isolation_readiness.down.sql
DO $$ BEGIN
  PERFORM t.ok(t.schema_digest() = (SELECT v FROM t.saved WHERE k = 'schema106'), 'RB schema byte-for-byte');
  RAISE NOTICE 'PASS ①ب التراجع: الدالتان حرفيًا كما في الإنتاج قبل 107';
END $$;
\i migrations/107_isolation_readiness.sql
\i migrations/107_isolation_readiness.sql
SET search_path = public, extensions;

-- ══ ② العزل مطفأ: لا تغيير ═══════════════════════════════════════════════
DO $$ BEGIN
  PERFORM t.ok(NOT public._isolation_on(), 'OFF isolation off');
  PERFORM t.ok(t.b('OA', format('public.ticket_in_my_scope(%L::uuid)', t.k('TA1S')))
           AND t.b('OA', format('public.can_access_ticket(%L::uuid)', t.k('TA1S')))
           AND t.b('AD', format('public.can_access_ticket(%L::uuid)', t.k('TA1'))), 'OFF legacy behaviour unchanged');
  RAISE NOTICE 'PASS ② العزل مطفأ: ticket_in_my_scope و can_access_ticket كما كانتا حرفيًا';
END $$;

-- ══ ③ العزل مفعّل ════════════════════════════════════════════════════════
DO $$ BEGIN
  PERFORM t.sw('company_permissions_enabled', true);
  PERFORM t.sw('company_isolation_enforced', true);
  -- التذكرة الشخصية لعميل الشركة مع مدعوم: لا يراها مالك الشركة ولا يغلقها ولا يعيد فتحها
  PERFORM t.ok(NOT t.sees('OA', 'TA1S'), 'ON OA cannot read TA1S (RLS, 097)');
  PERFORM t.ok(NOT t.b('OA', format('public.ticket_in_my_scope(%L::uuid)', t.k('TA1S')))
           AND NOT t.b('OA', format('public.can_access_ticket(%L::uuid)', t.k('TA1S'))), 'ON scope + access refused');
  PERFORM t.ok(t.err(t.u('OA'), format('public.close_ticket_in_my_scope(%L::uuid)', t.k('TA1S'))) = '42501'
           AND t.err(t.u('OA'), format('public.reopen_ticket_in_my_scope(%L::uuid)', t.k('TA1S'))) = '42501', 'ON close/reopen refused');
  PERFORM t.ok((SELECT status FROM public.tickets WHERE id = t.k('TA1S')) = 'open', 'ON status untouched');
  -- لا كاشف وجود: نفس الخطأ لتذكرة غير موجودة
  PERFORM t.ok(t.err(t.u('OA'), format('public.close_ticket_in_my_scope(%L::uuid)', gen_random_uuid())) = '42501', 'ON same error for missing');
  -- تذاكر الشركة نفسها: المالك يواصل
  PERFORM t.ok(t.b('OA', format('public.ticket_in_my_scope(%L::uuid)', t.k('TA1'))), 'ON company ticket in scope');
  -- العميل يغلق تذكرته الشخصية
  PERFORM t.ok(t.b('A1', format('public.ticket_in_my_scope(%L::uuid)', t.k('TA1S')))
           AND t.call(t.u('A1'), format('public.close_ticket_in_my_scope(%L::uuid)', t.k('TA1S'))) ->> 'status' = 'resolved', 'ON customer closes own');
  -- طاقم المنصة: تذاكر مدعوم نعم، تذاكر الشركة لا (نفس قاعدة 097)
  PERFORM t.ok(t.b('AD', format('public.can_access_ticket(%L::uuid)', t.k('TPU')))
           AND NOT t.b('AD', format('public.can_access_ticket(%L::uuid)', t.k('TA1'))), 'ON platform staff per 097');
  -- شركة أخرى لا شيء
  PERFORM t.ok(NOT t.b('OB', format('public.ticket_in_my_scope(%L::uuid)', t.k('TA1')))
           AND NOT t.b('OB', format('public.can_access_ticket(%L::uuid)', t.k('TA1'))), 'ON other company refused');
  RAISE NOTICE 'PASS ③ العزل مفعّل: لا إغلاق ولا إعادة فتح ولا كاشف وجود لتذكرة شخصية عبر super_user_id؛ تذاكر الشركة كما هي';
END $$;

-- ══ ④ التراجع مرفوض مع العزل مفعّلًا ═══════════════════════════════════════
\set rb107 `cat migrations/_rollback/107_isolation_readiness.down.sql`
SELECT set_config('t.rb107', :'rb107', false) IS NOT NULL;
DO $$
DECLARE s text;
BEGIN
  s := t.schema_digest();
  BEGIN
    EXECUTE current_setting('t.rb107');
    RAISE EXCEPTION 'FAIL RB107 allowed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%التراجع عن 107 مرفوض%' THEN RAISE; END IF;
  END;
  PERFORM t.ok(t.schema_digest() = s, 'RB refused, nothing changed');
  RAISE NOTICE 'PASS ④ التراجع مرفوض ما دام العزل مفعّلًا';
  RAISE NOTICE 'ALL 107 isolation readiness tests passed';
END $$;
