-- ============================================================================
-- 106_account_request_execution على نسخة مطابقة للإنتاج حتى 093 + 094 … 105 (ترتيب الإنتاج)
--
--   ① 106: الكائنات؛ ①ب التراجع حرفيًا (بصمة المخطط) ثم إعادة التطبيق مرتين
--   ② الإضافة إلى شركة: عضوية أساسية، العلاقة المباشرة باقية، لا موظف، لا هوية مكررة، الشركة ترى العميل
--      ولا ترى تاريخه، والعميل يرى شركته
--   ③ النقل: نفس الهوية، العلاقة المباشرة تُنهى، مدير الحساب يُنهى، الحصة على الشركة، التاريخ خاص (تذاكر
--      وردود ومرفقات)، الإشعارات والرموز والاشتراكات المنتهية في مكانها، والسجل كامل
--   ④ اشتراك شخصي نشط يمنع التنفيذ (لا كسر صامت) · ⑤ المفاتيح المطفأة: فشل مسجَّل قابل للاستئناف
--   ⑥ غير المالك، بلا تحقق، طلبك أنت · ⑦ شركة موقوفة عند القرار، بريد غير مطابق، حساب غير مؤهل
--   ⑧ فشل مُحقَن أثناء النقل: لا أثر، المحاولة مسجَّلة، ثم إعادة ناجحة · ⑨ إعادة القرار مرفوضة
--   ⑩ موافقتان متزامنتان بجلستين: تنفيذ واحد · ⑪ «طلباتي» تعرض الفشل والنجاح · ⑫ التراجع مرفوض مع السجل
-- ============================================================================
--   ⑧ الحذف يُنهي ما كان نشطًا · ⑨ الإشعارات عامة · ⑩ التراجع مرفوض مع السجل — بلا أي تغيير
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
SET search_path = public, extensions;

CREATE FUNCTION t.own(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN PERFORM t.ctx('owner'); PERFORM t.stepup(t.u('OW')); RETURN t.call(t.u('OW'), p_sql); END $$;
CREATE FUNCTION t.own_err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN PERFORM t.ctx('owner'); PERFORM t.stepup(t.u('OW')); RETURN t.err(t.u('OW'), p_sql); END $$;
CREATE FUNCTION t.own_errfull(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN PERFORM t.ctx('owner'); PERFORM t.stepup(t.u('OW')); RETURN t.errfull(t.u('OW'), p_sql); END $$;
-- رمز الخطأ داخل detail (مثل {"code":"self_approval"})
CREATE FUNCTION t.jd(d text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN RETURN d::jsonb; EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('raw', d); END $$;
CREATE FUNCTION t.code(p uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE d text;
BEGIN PERFORM t.call(p, p_sql); RETURN 'ok';
EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL;
  RETURN sqlstate || ':' || coalesce(t.jd(d) ->> 'code', '') || coalesce('/' || (t.jd(d) ->> 'check'), ''); END $$;
CREATE FUNCTION t.own_code(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN PERFORM t.ctx('owner'); PERFORM t.stepup(t.u('OW')); RETURN t.code(t.u('OW'), p_sql); END $$;
CREATE FUNCTION t.x(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  select (case p when 'NS' then '0e000000-0000-4000-8000-0000000000c1' when 'SU' then '0e000000-0000-4000-8000-0000000000c2'
                 when 'K1' then '1e000000-0000-4000-8000-000000000001' when 'K2' then '1e000000-0000-4000-8000-000000000002'
                 when 'K3' then '1e000000-0000-4000-8000-000000000003' when 'K4' then '1e000000-0000-4000-8000-000000000004'
                 when 'K5' then '1e000000-0000-4000-8000-000000000005' when 'K6' then '1e000000-0000-4000-8000-000000000006'
                 when 'K7' then '1e000000-0000-4000-8000-000000000007' when 'K8' then '1e000000-0000-4000-8000-000000000008'
                 when 'K9' then '1e000000-0000-4000-8000-000000000009'
                 when 'S1' then '0e000000-0000-4000-8000-0000000000c4' when 'S2' then '0e000000-0000-4000-8000-0000000000c5'
                 when 'S3' then '0e000000-0000-4000-8000-0000000000c6' when 'RC' then '0e000000-0000-4000-8000-0000000000c3'
                 when 'RE' then '0e000000-0000-4000-8000-0000000000c7' end)::uuid $$;
CREATE FUNCTION t.sv(p text) RETURNS uuid LANGUAGE sql AS $$ select v::uuid from t.saved where k = p $$;
CREATE FUNCTION t.dir(p uuid, p_filters jsonb) RETURNS jsonb LANGUAGE sql AS $$
  select t.call(p, format('public.admin_customer_directory(%L::jsonb)', p_filters)) $$;
CREATE FUNCTION t.ids(p_page jsonb) RETURNS uuid[] LANGUAGE sql IMMUTABLE AS $$
  select coalesce(array_agg((e ->> 'id')::uuid order by o), '{}') from jsonb_array_elements(p_page -> 'rows') with ordinality x(e, o) $$;
CREATE FUNCTION t.submit(p uuid, p_type text, p_customer uuid, p_email text, p_company uuid, p_key uuid, p_target text DEFAULT NULL)
RETURNS text LANGUAGE sql AS $$
  select t.code(p, format('public.account_request_submit(%L, %L::uuid, %L, %L, %L::uuid, %L, %L::uuid)',
                          p_type, p_customer, p_email, p_target, p_company, 'سبب الطلب: إدارة الحساب حسب الاتفاق', p_key)) $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

CREATE FUNCTION t.conn(p_name text, p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
begin
  perform t.dblink_connect(p_name, format('dbname=%s port=%s host=%s user=postgres', current_database(),
          current_setting('port'), split_part(current_setting('unix_socket_directories'), ',', 1)));
  perform t.dblink_exec(p_name, s) from (values
    ('set search_path = public, extensions'),
    (format('set request.jwt.claim.sub = %L', p_user)), ($s$set request.jwt.claim.role = 'authenticated'$s$),
    (format('set request.jwt.claims = %L', jsonb_build_object('sub', p_user, 'role', 'authenticated', 'session_id', 'sess-' || p_user)::text)),
    ('set role authenticated'), ($s$set lock_timeout = '10s'$s$)) q(s);
end $$;
CREATE FUNCTION t.wait_blocked(p_conn text) RETURNS boolean LANGUAGE plpgsql AS $$
declare i int := 0;
begin
  loop
    perform pg_stat_clear_snapshot();
    if exists (select 1 from pg_stat_activity a where a.wait_event_type = 'Lock'
                and a.pid <> pg_backend_pid() and a.backend_type = 'client backend' and a.state = 'active') then
      return true;
    end if;
    if t.dblink_is_busy(p_conn) = 0 then return false; end if;
    i := i + 1;
    if i > 250 then return false; end if;
    perform pg_sleep(0.02);
  end loop;
end $$;
CREATE FUNCTION t.req(p_customer uuid) RETURNS uuid LANGUAGE sql AS $$
  select id from public.account_requests where customer_id = p_customer order by requested_at desc limit 1 $$;
CREATE FUNCTION t.decide(p_req uuid, p_approve boolean, p_reason text DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  select t.own(format('public.owner_decide_account_request(%L::uuid, %L, %L)', p_req, p_approve, p_reason)) $$;
CREATE FUNCTION t.kind(p uuid) RETURNS text LANGUAGE sql AS $$ select a.account_type from public._customer_accounts(p) a $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

INSERT INTO t.saved VALUES ('schema105', t.schema_digest());

-- ══ ① 106 ════════════════════════════════════════════════════════════════
\i migrations/106_account_request_execution.sql
SET search_path = public, extensions;
DO $$ BEGIN
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.platform_feature_switches WHERE enabled), 'OBJ switches off');
  PERFORM t.ok(NOT has_function_privilege('authenticated', 'public._json_or_null(text)', 'execute')
           AND NOT has_function_privilege('anon', 'public.owner_decide_account_request(uuid,boolean,text)', 'execute'), 'OBJ privileges');
  -- لا مسار في دوال 106 يمسّ الرموز أو التكاملات أو التذاكر أو المحادثات أو الاشتراكات (لا نقل تلقائي لبيانات)
  PERFORM t.ok(pg_get_functiondef('public.owner_decide_account_request(uuid,boolean,text)'::regprocedure)
               !~ '(update|delete from|insert into) public\.(tickets|ticket_|chat_|company_conversation|whatsapp_subscriptions|api_tokens|ihub_|notifications_)',
               'OBJ execution touches no customer data tables');
  RAISE NOTICE 'PASS ① 106: المفاتيح مطفأة، الدوال الداخلية مغلقة، والتنفيذ لا يكتب في جداول بيانات العميل';
END $$;
\i migrations/_rollback/106_account_request_execution.down.sql
DO $$ BEGIN
  PERFORM t.ok(t.schema_digest() = (SELECT v FROM t.saved WHERE k = 'schema105'), 'RB schema byte-for-byte');
  RAISE NOTICE 'PASS ①ب التراجع: دوال 105 والقيود والأعمدة حرفيًا كما قبل 106';
END $$;
\i migrations/106_account_request_execution.sql
\i migrations/106_account_request_execution.sql
SET search_path = public, extensions;

-- إعداد: كل المتطلبات مفعّلة في هذه النسخة وحدها (الإنتاج: مطفأة)
DO $$ BEGIN
  PERFORM t.sw('company_isolation_enforced', true);
  PERFORM t.sw('company_permissions_enabled', true);
  PERFORM t.sw('account_request_execution_enabled', true);
END $$;

-- ══ ② الإضافة إلى شركة ═════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_req uuid;
BEGIN
  PERFORM t.ok(t.kind(t.u('PU')) = 'direct' AND t.sees('OA', 'TPU') = false, 'ADD before: direct, OA blind');
  PERFORM t.ok(t.submit(t.u('AD'), 'add_to_company', t.u('PU'), 'pu@tenancy.test', t.u('CA'), t.x('K1')) = 'ok', 'ADD submit');
  v_req := t.req(t.u('PU'));
  -- الطلب وحده لا يغيّر شيئًا
  PERFORM t.ok(t.kind(t.u('PU')) = 'direct' AND NOT EXISTS (SELECT 1 FROM public.company_memberships WHERE user_id = t.u('PU')), 'ADD request changes nothing');
  r := t.own(format('public.owner_account_request_details(%L::uuid)', v_req));
  PERFORM t.ok(r -> 'impact' ->> 'membership' = 'primary' AND r -> 'impact' ->> 'direct_relationship' = 'kept'
           AND r -> 'impact' ->> 'historical_tickets' = 'stay_private' AND (r -> 'execution' ->> 'available')::boolean, 'ADD impact + available');
  r := t.decide(v_req, true, 'العقد موقّع');
  PERFORM t.ok(r ->> 'status' = 'approved' AND (r ->> 'primary')::boolean AND NOT (r ->> 'direct_relationship_ended')::boolean, 'ADD approved ' || r::text);
  PERFORM t.ok(t.kind(t.u('PU')) = 'direct_and_company'
           AND (SELECT super_user_id FROM public.profiles WHERE id = t.u('PU')) = t.u('OA')
           AND EXISTS (SELECT 1 FROM public.platform_direct_customers WHERE user_id = t.u('PU') AND ended_at IS NULL), 'ADD state');
  -- عميل لا موظف
  PERFORM t.ok(t.call(t.u('PU'), 'public.company_staff_role()') IS NULL
           AND public._company_staff_role_of(t.u('CA'), t.u('PU')) IS NULL
           AND NOT EXISTS (SELECT 1 FROM public.company_staff WHERE user_id = t.u('PU')), 'ADD not an employee');
  -- لا هوية مكررة
  PERFORM t.ok((SELECT count(*) FROM auth.users WHERE lower(email) = 'pu@tenancy.test') = 1
           AND (SELECT count(*) FROM public.profiles WHERE lower(email) = 'pu@tenancy.test') = 1, 'ADD single identity');
  -- الشركة ترى العميل، ولا ترى تاريخه؛ والعميل يرى شركته وتاريخه
  PERFORM t.ok((t.call(t.u('OA'), 'public.company_customers_list()') -> 'customers') @> jsonb_build_array(jsonb_build_object('id', t.u('PU'))), 'ADD company sees customer');
  PERFORM t.ok(NOT t.sees('OA', 'TPU') AND NOT t.sees('AS', 'TPU') AND t.sees('PU', 'TPU'), 'ADD history private');
  PERFORM t.ok(t.rows(t.u('OA'), format('public.ticket_replies where ticket_id = %L', t.k('TPU'))) = 0, 'ADD replies private');
  PERFORM t.ok(t.call(t.u('PU'), 'public.my_company_memberships()') @> jsonb_build_array(jsonb_build_object('company_id', t.u('CA'), 'is_primary', true)), 'ADD customer sees company');
  -- شركة أخرى لا ترى شيئًا
  PERFORM t.ok(NOT ((t.call(t.u('OB'), 'public.company_customers_list()') -> 'customers') @> jsonb_build_array(jsonb_build_object('id', t.u('PU')))), 'ADD other company blind');
  RAISE NOTICE 'PASS ② الإضافة: عضوية أساسية ذرية، العلاقة المباشرة باقية، عميل لا موظف، هوية واحدة، الشركة ترى العميل لا تاريخه';
END $$;

-- ══ ③ النقل ═══════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_req uuid; v_tk uuid := '7e000000-0000-4000-8000-0000000000d1'; n0 int;
BEGIN
  -- تاريخ قبل النقل: تذكرة ورد، ومدير حساب على المنصة
  INSERT INTO public.tickets (id, user_id, title, description, status, priority, category)
  VALUES (v_tk, t.u('DG'), 'تذكرة قديمة', 'محتوى خاص بالعميل', 'open', 'medium', 'other');
  INSERT INTO public.ticket_replies (ticket_id, user_id, message) VALUES (v_tk, t.u('DG'), 'رد خاص');
  PERFORM t.own(format('public.customer_manager_assign(%L::uuid, %L::uuid, %L)', t.u('DG'), t.u('AD'), 'متابعة قبل النقل'));
  n0 := (SELECT count(*) FROM public.notifications WHERE user_id = t.u('DG'));
  PERFORM t.ok((SELECT scope FROM public.tickets WHERE id = v_tk) = 'mad3oom_support', 'TR old ticket is platform-scope');

  PERFORM t.ok(t.submit(t.u('AD'), 'transfer_direct_to_company', t.u('DG'), 'dg@tenancy.test', t.u('CB'), t.x('K2')) = 'ok', 'TR submit');
  v_req := t.req(t.u('DG'));
  r := t.own(format('public.owner_account_request_details(%L::uuid)', v_req));
  PERFORM t.ok(r -> 'impact' ->> 'direct_relationship' = 'ended' AND r -> 'impact' ->> 'platform_account_manager' = 'ended'
           AND r -> 'impact' ->> 'ticket_quota_owner' = 'company' AND r -> 'impact' ->> 'subscriptions' = 'stay_with_customer'
           AND (r -> 'customer_now' -> 'platform_manager' ->> 'id')::uuid = t.u('AD'), 'TR impact');
  r := t.decide(v_req, true, null);
  PERFORM t.ok(r ->> 'status' = 'approved' AND (r ->> 'direct_relationship_ended')::boolean AND (r ->> 'platform_manager_ended')::boolean, 'TR approved ' || r::text);
  -- العلاقة المباشرة منتهية بسجل، والعميل عميل شركة
  PERFORM t.ok(t.kind(t.u('DG')) = 'company_customer'
           AND (SELECT end_cause FROM public.platform_direct_customers WHERE user_id = t.u('DG')) = 'transferred'
           AND (SELECT ended_by FROM public.platform_direct_customers WHERE user_id = t.u('DG')) = t.u('OW'), 'TR direct ended');
  PERFORM t.ok((SELECT end_cause FROM public.customer_account_managers WHERE customer_id = t.u('DG')) = 'transferred'
           AND NOT EXISTS (SELECT 1 FROM public.customer_account_managers WHERE customer_id = t.u('DG') AND ended_at IS NULL), 'TR manager ended');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.company_memberships WHERE user_id = t.u('DG') AND company_id = t.u('CB') AND is_primary AND status = 'active')
           AND (SELECT super_user_id FROM public.profiles WHERE id = t.u('DG')) = t.u('OB')
           AND EXISTS (SELECT 1 FROM public.company_membership_events WHERE user_id = t.u('DG') AND action = 'transferred_in'
                        AND detail ->> 'request_id' = v_req::text), 'TR membership + event');
  -- نفس الهوية
  PERFORM t.ok((SELECT count(*) FROM auth.users WHERE lower(email) = 'dg@tenancy.test') = 1
           AND (SELECT count(*) FROM public.profiles WHERE lower(email) = 'dg@tenancy.test') = 1, 'TR single identity');
  PERFORM t.ok(t.call(t.u('DG'), 'public.company_staff_role()') IS NULL, 'TR not an employee');
  -- التاريخ يبقى خاصًا: الشركة الجديدة لا ترى التذكرة ولا الرد ولا المرفقات؛ العميل يراها
  PERFORM t.ok(t.rows(t.u('OB'), format('public.tickets where id = %L', v_tk)) = 0
           AND t.rows(t.u('BS'), format('public.tickets where id = %L', v_tk)) = 0
           AND t.rows(t.u('OB'), format('public.ticket_replies where ticket_id = %L', v_tk)) = 0
           AND t.rows(t.u('OB'), format('public.ticket_attachments where ticket_id = %L', v_tk)) = 0, 'TR history private');
  PERFORM t.ok(t.rows(t.u('DG'), format('public.tickets where id = %L', v_tk)) = 1, 'TR customer keeps own history');
  -- طاقم المنصة يواصل متابعة التذكرة القديمة (نطاقها mad3oom_support لا يتغير)
  PERFORM t.ok((SELECT scope FROM public.tickets WHERE id = v_tk) = 'mad3oom_support'
           AND t.rows(t.u('AD'), format('public.tickets where id = %L', v_tk)) = 1, 'TR platform keeps old ticket');
  -- الحصة: خطة الشركة تحكم من الآن
  PERFORM t.ok((public.ticket_quota_status(t.u('DG')) ->> 'account_owner')::uuid = t.u('OB'), 'TR quota owner company');
  -- الإشعارات في مكانها (+ إشعار النقل وحده)
  PERFORM t.ok((SELECT count(*) FROM public.notifications WHERE user_id = t.u('DG')) = n0 + 1, 'TR notifications kept');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.privileged_audit WHERE action = 'account_request.transferred' AND target_user_id = t.u('DG')), 'TR audited');
  PERFORM t.ok((SELECT outcome ->> 'previous_platform_manager' FROM public.account_requests WHERE id = v_req)::uuid = t.u('AD'), 'TR outcome');
  -- الشركة ترى العميل الآن؛ وشركة أخرى لا
  PERFORM t.ok((t.call(t.u('OB'), 'public.company_customers_list()') -> 'customers') @> jsonb_build_array(jsonb_build_object('id', t.u('DG')))
           AND NOT ((t.call(t.u('OA'), 'public.company_customers_list()') -> 'customers') @> jsonb_build_array(jsonb_build_object('id', t.u('DG')))), 'TR company visibility');
  -- تذكرة جديدة بعد النقل تتبع الشركة
  INSERT INTO public.tickets (id, user_id, title, description, status, priority, category)
  VALUES ('7e000000-0000-4000-8000-0000000000d2', t.u('DG'), 'تذكرة جديدة', 'بعد النقل', 'open', 'medium', 'other');
  PERFORM t.ok((SELECT scope || ':' || company_id FROM public.tickets WHERE id = '7e000000-0000-4000-8000-0000000000d2') = 'company:' || t.u('CB'), 'TR new ticket → company');
  RAISE NOTICE 'PASS ③ النقل: نفس الهوية، العلاقة المباشرة ومدير الحساب يُنهيان بسجل، عميل شركة لا موظف، التاريخ خاص، الحصة للشركة، الجديد للشركة';
END $$;

-- ══ ④ اشتراك شخصي نشط ═══════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_req uuid;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (t.x('NS'), 'ns@tenancy.test');
  INSERT INTO public.profiles (id, email, full_name, role) VALUES (t.x('NS'), 'ns@tenancy.test', 'عميل باشتراك', 'user');
  INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days)
  VALUES (t.x('NS'), 'support', 'active', 'monthly', now() - interval '1 day', now() + interval '29 days', 30);
  -- عند الإرسال: يُرفض مبكرًا
  PERFORM t.ok(t.submit(t.u('AD'), 'transfer_direct_to_company', t.x('NS'), 'ns@tenancy.test', t.u('CA'), t.x('K3')) = '22023:no_active_personal_subscription', 'SUB refused at submit');
  -- اشتراك يبدأ بين الإرسال والقرار: يُكتشف عند القرار
  UPDATE public.whatsapp_subscriptions SET status = 'expired', end_date = now() - interval '1 minute' WHERE user_id = t.x('NS');
  PERFORM t.ok(t.submit(t.u('AD'), 'transfer_direct_to_company', t.x('NS'), 'ns@tenancy.test', t.u('CA'), t.x('K3')) = 'ok', 'SUB submit after expiry');
  INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days)
  VALUES (t.x('NS'), 'support', 'pending', 'monthly', now(), now() + interval '30 days', 30);
  v_req := t.req(t.x('NS'));
  r := t.decide(v_req, true, null);
  PERFORM t.ok(r ->> 'outcome' = 'failed' AND r ->> 'check' = 'no_active_personal_subscription' AND (r ->> 'recoverable')::boolean, 'SUB blocked ' || r::text);
  PERFORM t.ok((SELECT status || ':' || attempts FROM public.account_requests WHERE id = v_req) = 'pending:1'
           AND t.kind(t.x('NS')) = 'direct' AND NOT EXISTS (SELECT 1 FROM public.company_memberships WHERE user_id = t.x('NS'))
           AND (SELECT count(*) FROM public.whatsapp_subscriptions WHERE user_id = t.x('NS') AND status = 'pending') = 1, 'SUB nothing changed');
  INSERT INTO t.saved VALUES ('req_ns', v_req);
  RAISE NOTICE 'PASS ④ اشتراك شخصي نشط يمنع التنفيذ صراحةً: لا كسر صامت، الطلب قيد القرار والفشل مسجَّل';
END $$;

-- ══ ⑤ المفاتيح المطفأة ═══════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_req uuid;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (t.x('S1'), 's1@tenancy.test');
  INSERT INTO public.profiles (id, email, full_name, role) VALUES (t.x('S1'), 's1@tenancy.test', 'عميل ج', 'user');
  PERFORM t.ok(t.submit(t.u('AD'), 'transfer_direct_to_company', t.x('S1'), 's1@tenancy.test', t.u('CA'), t.x('K4')) = 'ok', 'SW submit');
  v_req := t.req(t.x('S1'));
  INSERT INTO t.saved VALUES ('req_s1', v_req);
  PERFORM t.sw('account_request_execution_enabled', false);
  r := t.decide(v_req, true, null);
  PERFORM t.ok(r ->> 'outcome' = 'failed' AND r ->> 'code' = 'prerequisite_not_enabled'
           AND (r -> 'missing') ? 'account_request_execution_enabled', 'SW blocked ' || r::text);
  PERFORM t.ok((SELECT status FROM public.account_requests WHERE id = v_req) = 'pending' AND t.kind(t.x('S1')) = 'direct', 'SW nothing changed');
  PERFORM t.sw('account_request_execution_enabled', true);
  RAISE NOTICE 'PASS ⑤ المفاتيح المطفأة: فشل مسجَّل قابل للاستئناف، لا تغيير';
END $$;

-- ══ ⑥ غير المالك / بلا تحقق / طلبك أنت ════════════════════════════════════
DO $$
DECLARE v_req uuid := t.sv('req_s1'); v_self uuid;
BEGIN
  PERFORM t.ok(t.code(t.u('AD'), format('public.owner_decide_account_request(%L::uuid, true, null)', v_req)) = '42501:step_up_required', 'AUTH requester');
  PERFORM t.ok(t.code(t.u('EA'), format('public.owner_decide_account_request(%L::uuid, true, null)', v_req)) = '42501:step_up_required', 'AUTH elevated admin');
  PERFORM t.ok(t.code(t.u('OA'), format('public.owner_decide_account_request(%L::uuid, true, null)', v_req)) = '42501:step_up_required', 'AUTH company owner');
  PERFORM t.ctx('owner');
  DELETE FROM public.privileged_step_ups WHERE user_id = t.u('OW');
  PERFORM t.ok(t.code(t.u('OW'), format('public.owner_decide_account_request(%L::uuid, true, null)', v_req)) = '42501:step_up_required', 'AUTH no step-up');
  INSERT INTO public.account_requests (request_type, customer_id, customer_email, company_id, reason, requested_by, idempotency_key)
  VALUES ('add_to_company', t.u('B1'), 'b1@tenancy.test', t.u('CA'), 'طلب مُدرج باسم المالك', t.u('OW'), gen_random_uuid()) RETURNING id INTO v_self;
  PERFORM t.ok(t.own_code(format('public.owner_decide_account_request(%L::uuid, true, null)', v_self)) = '42501:self_approval', 'AUTH self-approval');
  UPDATE public.account_requests SET status = 'cancelled', decided_at = now(), decision_reason = 'تنظيف الاختبار' WHERE id = v_self;
  PERFORM t.ok((SELECT attempts FROM public.account_requests WHERE id = v_req) = 1, 'AUTH refusals record nothing');
  RAISE NOTICE 'PASS ⑥ القرار للمالك وحده بخطوتين، ولا قرار على طلبك — والرفض لا يُسجَّل كمحاولة';
END $$;

-- ══ ⑦ شركة موقوفة عند القرار / بريد غير مطابق / حساب غير مؤهل ═════════════
DO $$
DECLARE r jsonb; v_req uuid := t.sv('req_s1');
BEGIN
  UPDATE public.companies SET status = 'suspended' WHERE id = t.u('CA');
  r := t.decide(v_req, true, null);
  PERFORM t.ok(r ->> 'outcome' = 'failed' AND r ->> 'code' = 'revalidation_failed' AND r ->> 'check' = 'company_active', 'VAL suspended ' || r::text);
  UPDATE public.companies SET status = 'active' WHERE id = t.u('CA');
  PERFORM t.ok(t.submit(t.u('AD'), 'transfer_direct_to_company', t.u('DH'), 'wrong@tenancy.test', t.u('CA'), t.x('K5')) = '22023:email_matches', 'VAL email mismatch');
  -- DH مباشر + عميل شركة (مسار قديم): ليس «مباشرًا خالصًا» ⇒ لا نقل من هنا (101 للشركة ← شركة)
  PERFORM t.ok(t.submit(t.u('AD'), 'transfer_direct_to_company', t.u('B1'), 'b1@tenancy.test', t.u('CA'), t.x('K5')) = '22023:customer_is_direct', 'VAL company customer not direct');
  PERFORM t.ok(t.submit(t.u('AD'), 'transfer_direct_to_company', t.u('AS'), 'as@tenancy.test', t.u('CB'), t.x('K5')) = '22023:customer_is_customer', 'VAL staff ineligible');
  UPDATE public.companies SET status = 'suspended' WHERE id = t.u('CB');
  PERFORM t.ok(t.submit(t.u('AD'), 'add_to_company', t.u('DH'), 'dh@tenancy.test', t.u('CB'), t.x('K5')) LIKE '22023:%', 'VAL suspended destination at submit');
  UPDATE public.companies SET status = 'active' WHERE id = t.u('CB');
  RAISE NOTICE 'PASS ⑦ الشركة الموقوفة تُرفض عند الإرسال وعند القرار، والبريد غير المطابق والحساب غير المؤهل يوقفان';
END $$;

-- ══ ⑧ فشل مُحقَن أثناء النقل ثم إعادة ناجحة ════════════════════════════════
DO $$
DECLARE r jsonb; v_req uuid := t.sv('req_s1');
BEGIN
  CREATE FUNCTION t.boom() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'boom' USING errcode = 'XX001'; END $f$;
  CREATE TRIGGER t_boom BEFORE UPDATE ON public.platform_direct_customers FOR EACH ROW EXECUTE FUNCTION t.boom();
  r := t.decide(v_req, true, null);
  PERFORM t.ok(r ->> 'outcome' = 'failed' AND r ->> 'code' = 'execution_failed' AND (r ->> 'recoverable')::boolean, 'FAIL injected ' || r::text);
  -- لا أثر: العضوية والمرآة والحدث لم تحدث
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.company_memberships WHERE user_id = t.x('S1'))
           AND (SELECT super_user_id FROM public.profiles WHERE id = t.x('S1')) IS NULL
           AND NOT EXISTS (SELECT 1 FROM public.company_membership_events WHERE user_id = t.x('S1'))
           AND t.kind(t.x('S1')) = 'direct'
           AND (SELECT status FROM public.account_requests WHERE id = v_req) = 'pending'
           AND (SELECT last_failure ->> 'sqlstate' FROM public.account_requests WHERE id = v_req) = 'XX001', 'FAIL nothing changed');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.privileged_audit WHERE action = 'account_request.execution_failed' AND target_user_id = t.x('S1'))
           AND NOT EXISTS (SELECT 1 FROM public.privileged_audit WHERE action = 'account_request.transferred' AND target_user_id = t.x('S1')), 'FAIL audited as failure only');
  DROP TRIGGER t_boom ON public.platform_direct_customers;
  -- قابل للاستئناف: نفس الطلب ينجح الآن
  r := t.decide(v_req, true, 'إعادة بعد إصلاح');
  PERFORM t.ok(r ->> 'status' = 'approved' AND t.kind(t.x('S1')) = 'company_customer', 'FAIL then retry succeeds');
  PERFORM t.ok((SELECT attempts FROM public.account_requests WHERE id = v_req) = 3, 'FAIL attempts kept');
  RAISE NOTICE 'PASS ⑧ فشل مُحقَن: لا أثر، الطلب قيد القرار بسجل الفشل، ثم إعادة المحاولة تنجح';
END $$;

-- ══ ⑨ إعادة القرار ═══════════════════════════════════════════════════════
DO $$ BEGIN
  PERFORM t.ok(t.own_code(format('public.owner_decide_account_request(%L::uuid, true, null)', t.sv('req_s1'))) = '55000:request_final', 'REPLAY approve');
  PERFORM t.ok(t.own_code(format('public.owner_decide_account_request(%L::uuid, false, %L)', t.sv('req_s1'), 'رفض بعد التنفيذ')) = '55000:request_final', 'REPLAY reject');
  PERFORM t.ok((SELECT count(*) FROM public.company_memberships WHERE user_id = t.x('S1')) = 1, 'REPLAY single membership');
  RAISE NOTICE 'PASS ⑨ إعادة القرار مرفوضة: لا تنفيذ ثانٍ';
END $$;

-- ══ ⑩ موافقتان متزامنتان ═════════════════════════════════════════════════
DO $$ BEGIN
  INSERT INTO auth.users (id, email) VALUES (t.x('S2'), 's2@tenancy.test');
  INSERT INTO public.profiles (id, email, full_name, role) VALUES (t.x('S2'), 's2@tenancy.test', 'عميل د', 'user');
  PERFORM t.ok(t.submit(t.u('AD'), 'transfer_direct_to_company', t.x('S2'), 's2@tenancy.test', t.u('CB'), t.x('K6')) = 'ok', 'RACE submit');
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
END $$;
SELECT t.conn('s1', t.u('OW')), t.conn('s2', t.u('OW'));
DO $$
DECLARE v_req uuid := t.req(t.x('S2')); r1 text; r2 text; blocked boolean;
BEGIN
  PERFORM t.dblink_exec('s1', 'begin');
  r1 := (SELECT x FROM t.dblink('s1', format('select (public.owner_decide_account_request(%L::uuid, true, null))::text', v_req)) AS r(x text));
  PERFORM t.dblink_send_query('s2', format('select (public.owner_decide_account_request(%L::uuid, true, null))::text', v_req));
  blocked := t.wait_blocked('s2');
  PERFORM t.dblink_exec('s1', 'commit');
  BEGIN
    r2 := (SELECT x FROM t.dblink_get_result('s2') AS r(x text));
  EXCEPTION WHEN others THEN
    r2 := sqlstate || ':' || sqlerrm;
  END;
  PERFORM t.dblink_get_result('s2', false);
  PERFORM t.ok(blocked, 'RACE second waited');
  PERFORM t.ok(r1 LIKE '%"approved"%' AND r2 LIKE '%الطلب نهائي%', 'RACE ' || r1 || ' / ' || coalesce(r2, 'null'));
  PERFORM t.ok((SELECT count(*) FROM public.company_memberships WHERE user_id = t.x('S2')) = 1
           AND (SELECT count(*) FROM public.platform_direct_customers WHERE user_id = t.x('S2') AND end_cause = 'transferred') = 1
           AND (SELECT count(*) FROM public.privileged_audit WHERE action = 'account_request.transferred' AND target_user_id = t.x('S2')) = 1, 'RACE executed once');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ⑩ موافقتان متزامنتان: الثانية تنتظر ثم تجد الطلب نهائيًا — نقل واحد بلا تكرار';
END $$;
SELECT t.dblink_disconnect('s1'), t.dblink_disconnect('s2');

-- ══ ⑪ «طلباتي» ═══════════════════════════════════════════════════════════
DO $$
DECLARE m jsonb := t.call(t.u('AD'), 'public.my_account_requests()');
BEGIN
  PERFORM t.ok(EXISTS (SELECT 1 FROM jsonb_array_elements(m) e WHERE (e ->> 'id')::uuid = t.sv('req_ns')
                        AND e ->> 'status' = 'pending' AND e -> 'last_failure' ->> 'check' = 'no_active_personal_subscription'
                        AND (e ->> 'attempts')::int = 1), 'MINE failed recoverable visible');
  PERFORM t.ok(EXISTS (SELECT 1 FROM jsonb_array_elements(m) e WHERE (e ->> 'id')::uuid = t.sv('req_s1')
                        AND e ->> 'status' = 'approved' AND (e -> 'outcome' ->> 'direct_relationship_ended')::boolean), 'MINE approved outcome visible');
  -- الإشعارات عامة
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.notifications n WHERE n.category = 'account' AND n.created_at >= now() - interval '1 hour'
                            AND (n.title || ' | ' || n.message) ~* '(@|tenancy|حساب فرد|عميل باشتراك)'), 'MINE notifications generic');
  RAISE NOTICE 'PASS ⑪ مقدّم الطلب يرى «فشل قابل للاستئناف» والنتيجة الفعلية بعد التنفيذ، والإشعارات عامة';
END $$;

-- ══ ⑫ التراجع مرفوض مع السجل ══════════════════════════════════════════════
\set rb106 `cat migrations/_rollback/106_account_request_execution.down.sql`
SELECT set_config('t.rb106', :'rb106', false) IS NOT NULL;
DO $$
DECLARE s text;
BEGIN
  s := t.schema_digest();
  BEGIN
    EXECUTE current_setting('t.rb106');
    RAISE EXCEPTION 'FAIL RB106 allowed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%التراجع عن 106 مرفوض%' THEN RAISE; END IF;
  END;
  PERFORM t.ok(t.schema_digest() = s, 'RB refused, nothing changed');
  RAISE NOTICE 'PASS ⑫ التراجع مرفوض مع محاولات ونقل منفَّذ — بلا أي تغيير';
  RAISE NOTICE 'ALL 106 account request execution tests passed';
END $$;
