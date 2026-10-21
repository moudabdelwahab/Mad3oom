-- ============================================================================
-- 111: فواتير المحاسبة وطلبات الاشتراك لا تعبر إلى تذكرة شركة (I1، I2)
-- على نسخة مطابقة للإنتاج حتى 110 (الدوال الست قبل 111 تطابق الإنتاج: md5 لـ prosrc).
--   ⓪ قبل 111: عميل أ يربط شراءه بتذكرة شركته؛ مالك ب يربط ترقيته بتذكرة عميل أ؛ ومع العزل يقرأ الأدمن
--      فاتورة تذكرة الشركة ويُرفق فيها ردًا علنيًا (I1 و I2 مُثبتتان)
--   ① بعد 111 (مرتين): الربطان مرفوضان (42501)، وتذكرة الشركة «بلا فاتورة» للأدمن، وصف الفاتورة محجوب
--   ② ما بقي: submit_subscription_request لعميل شركة ولحساب فرد ينجح، وفواتير تذاكر مدعوم كما هي للطاقم،
--      وصاحب الفاتورة يرى فاتورته، والعزل مطفأ يعيد السلوك القديم
--   ③ التراجع: مرفوض والعزل مفعّل؛ والعزل مطفأ يعيد الدوال الست حرفيًا ويحذف السياسة، ثم يُعاد 111
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
SET search_path = public, extensions;

CREATE FUNCTION t.digest6() RETURNS text LANGUAGE sql AS $$
  select string_agg(p.proname || ':' || md5(p.prosrc), ',' order by p.proname)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('request_subscription_purchase', 'request_subscription_upgrade',
         'ticket_invoice_status', 'ticket_invoice_document', 'attach_accounting_invoice', 'attach_accounting_invoice_pdf') $$;
CREATE FUNCTION t.saved_v(p text) RETURNS text LANGUAGE sql AS $$ select v from t.saved where k = p $$;
CREATE FUNCTION t.subs_on(p_ticket text) RETURNS int LANGUAGE sql AS $$
  select count(*)::int from public.whatsapp_subscriptions where ticket_id = t.k(p_ticket) $$;
CREATE FUNCTION t.replies_on(p_ticket text) RETURNS int LANGUAGE sql AS $$
  select count(*)::int from public.ticket_replies where ticket_id = t.k(p_ticket) $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;
-- فاتورتان اصطناعيتان: على تذكرة الشركة TA1 (لا يُفترض وجودها) وعلى تذكرة الفوترة الشخصية TA1S (مدعوم)
INSERT INTO public.accounting_invoices (external_invoice_id, invoice_number, ticket_id, user_id, total)
VALUES (gen_random_uuid(), 'FX-A1', t.k('TA1'), t.u('A1'), 10), (gen_random_uuid(), 'FX-A1S', t.k('TA1S'), t.u('A1'), 10);
INSERT INTO t.saved (k, v) VALUES ('d0', t.digest6());

-- ⓪ قبل 111 ─────────────────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM t.ok(t.saved_v('d0') = 'attach_accounting_invoice:9891a85c991a69e375c3bc9a943f6c32,attach_accounting_invoice_pdf:cf00201400106ff2a659704ce5d56a66,request_subscription_purchase:efb930e8184400ce6f74955852913957,request_subscription_upgrade:de80bd709a915b961529818e30e773ec,ticket_invoice_document:21646b696d041bf591692047e8069073,ticket_invoice_status:2963c6820abfe8798040cc9f178c1c45',
               '⓪ الدوال الست قبل 111 تطابق الإنتاج');
  PERFORM t.ok(t.err(t.u('A1'), format('public.request_subscription_purchase(''support'', ''monthly'', %L, false, null, null)', t.k('TA1'))) = 'ok', '⓪ I2: عميل أ يربط شراءه بتذكرة شركته');
  PERFORM t.ok(t.err(t.u('OB'), format('public.request_subscription_upgrade(''ultimate'', %L, null, null)', t.k('TA1'))) = 'ok', '⓪ I2: مالك ب يربط ترقيته بتذكرة عميل أ');
  PERFORM t.ok(t.subs_on('TA1') = 2, '⓪ I2: اشتراكان على تذكرة الشركة');
  UPDATE public.platform_feature_switches SET enabled = true WHERE key = 'company_isolation_enforced';
  PERFORM t.ok(t.call(t.u('AD'), format('public.ticket_invoice_status(%L)', t.k('TA1'))) ->> 'state' = 'ready', '⓪ I1: الأدمن يرى فاتورة تذكرة الشركة مع العزل');
  PERFORM t.ok(t.call(t.u('AD'), format('public.ticket_invoice_document(%L)', t.k('TA1'))) ->> 'ticket_number' IS NOT NULL, '⓪ I1: الأدمن يقرأ مستند فاتورة تذكرة الشركة');
  PERFORM t.ok(t.rows(t.u('AD'), format('public.accounting_invoices where ticket_id = %L', t.k('TA1'))) = 1, '⓪ I1: صف الفاتورة ظاهر للأدمن');
  PERFORM t.ok(t.err(t.u('AD'), format('public.attach_accounting_invoice(%L)', t.k('TA1'))) = 'ok' AND t.replies_on('TA1') = 3, '⓪ I1: الأدمن يُرفق ردًا داخل تذكرة الشركة');
  UPDATE public.platform_feature_switches SET enabled = false WHERE key = 'company_isolation_enforced';
  RAISE NOTICE 'PASS ⓪ قبل 111: I1 و I2 مُثبتتان (ربط الاشتراك بتذكرة شركة، وفاتورتها وردها للأدمن رغم العزل)';
END $$;
-- إعادة المعطيات إلى ما قبل ⓪
DELETE FROM public.whatsapp_subscriptions WHERE ticket_id = t.k('TA1');
UPDATE public.accounting_invoices SET reply_id = null, attachment_id = null WHERE ticket_id = t.k('TA1');
DELETE FROM public.ticket_attachments WHERE ticket_id = t.k('TA1') AND reply_id IN
  (SELECT id FROM public.ticket_replies WHERE ticket_id = t.k('TA1') AND id NOT IN (t.k('RPUB'), t.k('RINT')));
DELETE FROM public.ticket_replies WHERE ticket_id = t.k('TA1') AND id NOT IN (t.k('RPUB'), t.k('RINT'));

-- ① 111 مرتين ───────────────────────────────────────────────────────────────
\i migrations/111_billing_ticket_isolation.sql
\i migrations/111_billing_ticket_isolation.sql
SET search_path = public, extensions;

DO $$
BEGIN
  PERFORM t.ok(t.err(t.u('A1'), format('public.request_subscription_purchase(''support'', ''monthly'', %L, false, null, null)', t.k('TA1'))) = '42501', '① شراء مربوط بتذكرة شركة مرفوض');
  PERFORM t.ok(t.err(t.u('OB'), format('public.request_subscription_upgrade(''ultimate'', %L, null, null)', t.k('TA1'))) = '42501', '① ترقية مربوطة بتذكرة حساب آخر مرفوضة');
  PERFORM t.ok(t.err(t.u('OB'), format('public.request_subscription_upgrade(''ultimate'', %L, null, null)', t.k('TB1'))) = '42501', '① ترقية مربوطة بتذكرة شركة مرفوضة');
  PERFORM t.ok(t.err(t.u('OB'), format('public.request_subscription_purchase(''support'', ''monthly'', %L, false, null, null)', t.k('TB1'))) = '42501', '① مالك ب لا يربط شراءه بتذكرة شركته أيضًا');
  PERFORM t.ok(t.subs_on('TA1') = 0 AND t.subs_on('TB1') = 0, '① لا اشتراك على تذكرة شركة');
  -- لا كاشف: رسالة الرفض لتذكرة شركة أخرى = رسالة تذكرة غير موجودة، بالحرف
  PERFORM t.ok(t.errfull(t.u('OB'), format('public.request_subscription_upgrade(''ultimate'', %L, null, null)', t.k('TA1')))
             = t.errfull(t.u('OB'), 'public.request_subscription_upgrade(''ultimate'', ''00000000-0000-4000-8000-0000000000ff'', null, null)'), '① الترقية: نفس رد الغياب');
  PERFORM t.ok(t.errfull(t.u('B1'), format('public.request_subscription_purchase(''support'', ''monthly'', %L, false, null, null)', t.k('TA1')))
             = t.errfull(t.u('B1'), 'public.request_subscription_purchase(''support'', ''monthly'', ''00000000-0000-4000-8000-0000000000ff'', false, null, null)'), '① الشراء: نفس رد الغياب');
  UPDATE public.platform_feature_switches SET enabled = true WHERE key = 'company_isolation_enforced';
  PERFORM t.ok(t.call(t.u('AD'), format('public.ticket_invoice_status(%L)', t.k('TA1'))) = '{"state": "none", "has_pdf": false}'::jsonb, '① الحالة كغياب الفاتورة');
  PERFORM t.ok(t.err(t.u('AD'), format('public.ticket_invoice_document(%L)', t.k('TA1'))) = 'P0002', '① المستند: نفس رد الغياب');
  PERFORM t.ok(t.err(t.u('AD'), format('public.attach_accounting_invoice(%L)', t.k('TA1'))) = 'P0002' AND t.replies_on('TA1') = 2, '① الإرفاق مرفوض ولا رد جديد');
  PERFORM t.ok(t.err(t.u('AD'), format('public.attach_accounting_invoice_pdf(%L, %L, %L)', t.k('TA1'), t.k('TA1')::text || '/invoice-fx.pdf',
               'https://x.test/storage/v1/object/public/tickets/' || t.k('TA1')::text || '/invoice-fx.pdf')) = 'P0002', '① إرفاق PDF مرفوض');
  PERFORM t.ok(t.rows(t.u('AD'), format('public.accounting_invoices where ticket_id = %L', t.k('TA1'))) = 0, '① صف الفاتورة محجوب عن الأدمن');
  PERFORM t.ok(t.rows(t.u('SUP'), format('public.accounting_invoices where ticket_id = %L', t.k('TA1'))) = 0, '① ومحجوب عن الدعم');
  RAISE NOTICE 'PASS ① بعد 111: الربطان مرفوضان، وتذكرة الشركة «بلا فاتورة» للطاقم مع العزل، وصفها محجوب';
END $$;

-- ② ما بقي ─────────────────────────────────────────────────────────────────
DO $$
DECLARE r jsonb;
BEGIN
  -- المسار الفعلي: تذكرة فوترة تُنشأ بالطلب نفسه (category = subscription ⇒ مدعوم)
  r := t.call(t.u('A1'), 'public.submit_subscription_request(''support'', ''monthly'', ''طلب اشتراك اصطناعي'', ''وصف اصطناعي'', false, null, null)');
  PERFORM t.ok(r -> 'ticket' ->> 'scope' = 'mad3oom_support', '② طلب اشتراك عميل الشركة بتذكرة مدعوم');
  PERFORM t.ok((SELECT count(*) FROM public.whatsapp_subscriptions WHERE ticket_id = (r -> 'ticket' ->> 'id')::uuid) = 1, '② الاشتراك مربوط بتذكرته');
  r := t.call(t.u('PU'), 'public.submit_subscription_request(''support'', ''monthly'', ''طلب اشتراك فرد اصطناعي'', ''وصف اصطناعي'', false, null, null)');
  PERFORM t.ok(r -> 'ticket' ->> 'scope' = 'mad3oom_support', '② طلب اشتراك الحساب الفرد');
  -- ربط صريح بتذكرة مدعوم يملكها المنادي ما زال مقبولًا
  PERFORM t.ok(t.err(t.u('A1'), format('public.request_subscription_purchase(''whatsapp'', ''monthly'', %L, false, null, null)', t.k('TA1S'))) = 'ok', '② ربط بتذكرة فوترة شخصية مقبول');
  -- فواتير تذاكر مدعوم كما هي للطاقم، وصاحب الفاتورة يراها
  PERFORM t.ok(t.call(t.u('AD'), format('public.ticket_invoice_status(%L)', t.k('TA1S'))) ->> 'state' = 'ready', '② فاتورة تذكرة مدعوم للطاقم');
  PERFORM t.ok(t.call(t.u('AD'), format('public.ticket_invoice_document(%L)', t.k('TA1S'))) ->> 'ticket_number' IS NOT NULL, '② مستند فاتورة مدعوم');
  PERFORM t.ok(t.rows(t.u('A1'), 'public.accounting_invoices') = 2, '② صاحب الفواتير يرى الاثنتين');
  PERFORM t.ok(t.rows(t.u('B1'), 'public.accounting_invoices') = 0, '② عميل ب لا يرى فواتير أ');
  -- مسار المزامنة بمفتاح الخدمة (accounting-sync ⇐ record_accounting_invoice) والعزل مفعّل: لا يتأثر بالسياسة
  SET LOCAL ROLE service_role;
  r := public.record_accounting_invoice(jsonb_build_object('external_invoice_id', gen_random_uuid(), 'invoice_number', 'FX-SVC',
         'ticket_id', t.k('TOA'), 'user_id', t.u('OA'), 'total', 5));
  PERFORM t.ok((SELECT count(*) FROM public.accounting_invoices WHERE invoice_number = 'FX-SVC') = 1, '② مفتاح الخدمة يسجّل الفاتورة ويقرؤها والعزل مفعّل');
  RESET ROLE;
  PERFORM t.ok(t.call(t.u('AD'), format('public.ticket_invoice_status(%L)', t.k('TOA'))) ->> 'state' = 'ready', '② فاتورة المزامنة على تذكرة مدعوم ظاهرة للطاقم');
  -- العزل مطفأ: السلوك قبل 097 (طاقم المنصة يرى فاتورة تذكرة الشركة)
  UPDATE public.platform_feature_switches SET enabled = false WHERE key = 'company_isolation_enforced';
  PERFORM t.ok(t.call(t.u('AD'), format('public.ticket_invoice_status(%L)', t.k('TA1'))) ->> 'state' = 'ready', '② العزل مطفأ: كما قبل');
  PERFORM t.ok(t.rows(t.u('AD'), format('public.accounting_invoices where ticket_id = %L', t.k('TA1'))) = 1, '② العزل مطفأ: الصف ظاهر');
  RAISE NOTICE 'PASS ② مسار الاشتراك الفعلي وفواتير مدعوم ورؤية صاحب الفاتورة كما هي؛ والعزل مطفأ لا تغيير';
END $$;

-- ③ التراجع ───────────────────────────────────────────────────────────────
UPDATE public.platform_feature_switches SET enabled = true WHERE key = 'company_isolation_enforced';
\set ON_ERROR_STOP off
BEGIN;
\i migrations/_rollback/111_billing_ticket_isolation.down.sql
ROLLBACK;
\set ON_ERROR_STOP on
DO $$ BEGIN
  PERFORM t.ok(t.digest6() <> t.saved_v('d0'), '③ التراجع مرفوض والعزل مفعّل');
  RAISE NOTICE 'PASS ③ التراجع مرفوض ما دام company_isolation_enforced مفعّلًا';
END $$;
UPDATE public.platform_feature_switches SET enabled = false WHERE key = 'company_isolation_enforced';
\i migrations/_rollback/111_billing_ticket_isolation.down.sql
DO $$ BEGIN
  PERFORM t.ok(t.digest6() = t.saved_v('d0'), '③ التراجع يعيد الدوال الست حرفيًا');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.accounting_invoices'::regclass AND polname = 'tenant_isolation'), '③ والسياسة محذوفة');
  RAISE NOTICE 'PASS ③ التراجع يعيد الدوال الست كما في الإنتاج ويحذف السياسة';
END $$;
\i migrations/111_billing_ticket_isolation.sql
SET search_path = public, extensions;
DO $$ BEGIN
  PERFORM t.ok(t.err(t.u('OB'), format('public.request_subscription_upgrade(''ultimate'', %L, null, null)', t.k('TA1'))) = '42501', '③ إعادة 111 بعد التراجع تعمل');
  RAISE NOTICE 'PASS ③ إعادة تطبيق 111 بعد التراجع';
  RAISE NOTICE 'ALL billing-ticket-isolation: PASS';
END $$;
