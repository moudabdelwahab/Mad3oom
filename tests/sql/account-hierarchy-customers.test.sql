-- ============================================================================
-- 105_account_hierarchy_customers على نسخة مطابقة للإنتاج حتى 093 + 094 … 104 (ترتيب الإنتاج)
--
--   ① 105: الكائنات، المفتاح الجديد مطفأ، ملء العلاقة المباشرة؛ ①ب التراجع حرفيًا ثم إعادة التطبيق مرتين
--   ② التصنيف من العلاقات الصريحة، ومسارات super_user_id القديمة كما هي (create-sub-user، الإدارة العليا)
--   ③ دليل العملاء: من يقرأ، الفلاتر والترتيب والصفحات على الخادم، لا أسرار، لا وصول مباشر للجداول
--   ④ مدير الحساب: من يسند، لا إسناد للنفس، الأهلية، السجل الثابت، ولا يمنح أي اطلاع
--   ⑤ إرسال الطلب: لا يغيّر شيئًا، البريد للتحقق، الالتباس يوقف، التكرار والتعارض، من يرسل
--   ⑥ صندوق المالك: المالك وحده، الفلاتر، التفاصيل وملخص الأثر
--   ⑦ القرار: المالك بخطوتين، لا قرار على طلبك، الرفض بسبب، لا إعادة، لا موافقة بلا تنفيذ،
--      إعادة التحقق، الفشل لا يترك موافقة، الطلب النهائي ثابت، العزل لا يُطفأ بعدها
--   ⑦ب موافقتان متزامنتان بجلستين حقيقيتين (dblink): تنفيذ واحد
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
                 when 'K9' then '1e000000-0000-4000-8000-000000000009' end)::uuid $$;
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

INSERT INTO t.saved VALUES ('schema0', t.schema_digest());
INSERT INTO t.saved VALUES ('notif0', (SELECT count(*) FROM public.notifications)::text);

-- ══ ① 105 ════════════════════════════════════════════════════════════════
\i migrations/105_account_hierarchy_customers.sql
SET search_path = public, extensions;
DO $$ BEGIN
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.platform_feature_switches WHERE enabled), 'OBJ switches off');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.platform_feature_switches WHERE key = 'account_request_execution_enabled' AND NOT enabled), 'OBJ new switch off');
  -- الملء الأولي: الحسابات الفردية وحدها (PU وDG وDH)، لا تابعو الشركات ولا ملّاكها ولا الطاقم
  PERFORM t.ok((SELECT array_agg(user_id ORDER BY user_id) FROM public.platform_direct_customers)
               = (SELECT array_agg(x ORDER BY x) FROM unnest(array[t.u('PU'), t.u('DG'), t.u('DH')]) x), 'OBJ backfill = individual accounts');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_constraint WHERE contype = 'f' AND conrelid IN
                 ('public.platform_direct_customers'::regclass, 'public.customer_account_managers'::regclass, 'public.account_requests'::regclass)),
               'OBJ no FKs');
  PERFORM t.ok(NOT has_function_privilege('authenticated', 'public._customer_accounts(uuid)', 'execute')
           AND NOT has_function_privilege('service_role', 'public._account_request_checks(text,uuid,text,text,uuid,uuid)', 'execute')
           AND NOT has_function_privilege('anon', 'public.admin_customer_directory(jsonb)', 'execute')
           AND NOT has_function_privilege('anon', 'public.owner_decide_account_request(uuid,boolean,text)', 'execute')
           AND has_function_privilege('authenticated', 'public.admin_customer_directory(jsonb)', 'execute'), 'OBJ privileges');
  RAISE NOTICE 'PASS ① 105: المفتاح الجديد مطفأ، العلاقة المباشرة صريحة للحسابات الفردية وحدها، بلا مفاتيح خارجية، والدوال الداخلية مغلقة';
END $$;
\i migrations/_rollback/105_account_hierarchy_customers.down.sql
DO $$ BEGIN
  PERFORM t.ok(t.schema_digest() = (SELECT v FROM t.saved WHERE k = 'schema0'), 'RB schema byte-for-byte');
  RAISE NOTICE 'PASS ①ب التراجع: الدوال والمحفّزات والقيود والصلاحيات والمفاتيح حرفيًا كما قبل 105';
END $$;
\i migrations/105_account_hierarchy_customers.sql
\i migrations/105_account_hierarchy_customers.sql
SET search_path = public, extensions;

-- ══ ② التصنيف ومسارات super_user_id ═════════════════════════════════════
DO $$
DECLARE k text;
BEGIN
  SELECT string_agg(n || '=' || (SELECT a.account_type FROM public._customer_accounts(t.u(n)) a), ',' ORDER BY n) INTO k
    FROM unnest(array['OW','AD','SUP','PU','OA','A1','AS','AG','AX','B1']) n;
  PERFORM t.ok(k = 'A1=company_customer,AD=platform_staff,AG=company_staff,AS=company_staff,AX=company_customer,'
                   'B1=company_customer,OA=company_owner,OW=platform_staff,PU=direct,SUP=platform_staff', 'KIND ' || k);
  -- عميل الشركة يحمل رتبة company_user (035) — الرتبة وحدها لا تفرّق الموظف من العميل؛ العلاقات تفرّقهما
  PERFORM t.ok((SELECT role FROM public.profiles WHERE id = t.u('A1')) = 'company_user'
           AND (SELECT role FROM public.profiles WHERE id = t.u('AS')) = 'company_user', 'KIND same role, different kinds');

  -- تسجيل جديد بلا شركة ⇒ عميل مباشر (signup)
  INSERT INTO auth.users (id, email) VALUES (t.x('NS'), 'ns@tenancy.test'), (t.x('SU'), 'su@tenancy.test');
  INSERT INTO public.profiles (id, email, full_name, role) VALUES (t.x('NS'), 'ns@tenancy.test', 'تسجيل جديد', 'user');
  PERFORM t.ok((SELECT source FROM public.platform_direct_customers WHERE user_id = t.x('NS') AND ended_at IS NULL) = 'signup', 'SIGNUP direct');
  -- create-sub-user: حساب يُنشأ بـ super_user_id لمالك شركة ⇒ عضوية legacy، وليس عميلًا مباشرًا
  INSERT INTO public.profiles (id, email, full_name, role, super_user_id) VALUES (t.x('SU'), 'su@tenancy.test', 'تابع جديد', 'user', t.u('OA'));
  PERFORM t.ok((SELECT a.account_type FROM public._customer_accounts(t.x('SU')) a) = 'company_customer'
           AND NOT EXISTS (SELECT 1 FROM public.platform_direct_customers WHERE user_id = t.x('SU'))
           AND EXISTS (SELECT 1 FROM public.company_memberships WHERE user_id = t.x('SU') AND company_id = t.u('CA') AND is_primary AND joined_via = 'legacy'),
           'SUBUSER legacy path unchanged');
  -- المسار القديم للإدارة العليا (تغيير super_user_id) ما زال كما هو: عضوية legacy، والعلاقة المباشرة لا تُمسّ
  PERFORM t.ok(t.exec(t.u('EA'), format('update public.profiles set super_user_id = %L where id = %L', t.u('OB'), t.u('DH'))) = 'ok', 'LEGACY main admin write');
  PERFORM t.ok((SELECT a.account_type FROM public._customer_accounts(t.u('DH')) a) = 'direct_and_company', 'LEGACY direct + company');
  -- الإدارة العادية لا تكتب super_user_id (check_super_user_creation كما كان)
  PERFORM t.ok(t.exec(t.u('AD'), format('update public.profiles set super_user_id = %L where id = %L', t.u('OA'), t.x('NS'))) = '42501', 'LEGACY admin refused');
  RAISE NOTICE 'PASS ② التصنيف من العلاقات الصريحة (لا من الرتبة ولا super_user_id وحده)؛ التسجيل الجديد عميل مباشر؛ create-sub-user ومسار الإدارة العليا كما هما';
END $$;

-- ══ ③ دليل العملاء ════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; e text;
BEGIN
  -- من يقرأ: نفس من يقرأ كل الحسابات اليوم
  PERFORM t.ok(t.code(t.u('AD'), 'public.admin_customer_directory()') = 'ok', 'DIR admin');
  PERFORM t.ctx('owner');
  PERFORM t.ok(t.code(t.u('OW'), 'public.admin_customer_directory()') = 'ok', 'DIR owner (owner context)');
  PERFORM t.ctx(null);
  PERFORM t.ok(t.code(t.u('OW'), 'public.admin_customer_directory()') = '42501:not_authorized', 'DIR owner without context');
  FOREACH e IN ARRAY array['SUP', 'OA', 'AS', 'AG', 'A1', 'PU'] LOOP
    PERFORM t.ok(t.code(t.u(e), 'public.admin_customer_directory()') = '42501:not_authorized', 'DIR denied ' || e);
    PERFORM t.ok(t.code(t.u(e), format('public.admin_customer_details(%L::uuid)', t.u('A1'))) = '42501:not_authorized', 'DET denied ' || e);
  END LOOP;
  PERFORM t.ok(t.err(null, 'public.admin_customer_directory()') = '42501', 'DIR anon');
  -- لا وصول مباشر للجداول الجديدة، حتى للإدارة
  PERFORM t.ok(t.exec(t.u('AD'), 'select 1 from public.account_requests') = '42501'
           AND t.exec(t.u('AD'), 'select 1 from public.customer_account_managers') = '42501'
           AND t.exec(t.u('AD'), 'select 1 from public.platform_direct_customers') = '42501', 'DIR no direct table access');

  r := t.dir(t.u('AD'), '{}');
  -- الطاقم خارج الدليل؛ المجموع كل غيرهم
  PERFORM t.ok(NOT (t.ids(r) && array[t.u('OW'), t.u('AD'), t.u('EA'), t.u('SUP')]), 'DIR no platform staff');
  PERFORM t.ok((r ->> 'total')::int = (SELECT count(*) FROM public._customer_accounts(null) a WHERE a.account_type <> 'platform_staff'), 'DIR total');
  -- أعمدة مسمّاة فقط: لا أسرار
  PERFORM t.ok(NOT (r::text ~ '(two_factor|recovery_codes|telegram|password|points)'), 'DIR no secrets');
  PERFORM t.ok((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(r -> 'rows' -> 0) k)
               = array['account_type','companies_count','company','created_at','email','full_name','id','manager','pending_request',
                       'pending_transfer','phone','status','whatsapp_phone'], 'DIR row shape');
  -- الفلاتر على الخادم
  r := t.dir(t.u('AD'), '{"view":"direct"}');
  PERFORM t.ok((SELECT array_agg(x ORDER BY x) FROM unnest(t.ids(r)) x)
               = (SELECT array_agg(x ORDER BY x) FROM unnest(array[t.u('PU'), t.u('DG'), t.u('DH'), t.x('NS')]) x), 'DIR view direct');
  r := t.dir(t.u('AD'), '{"view":"company"}');
  PERFORM t.ok(t.ids(r) @> array[t.u('A1'), t.u('B1'), t.u('DH'), t.x('SU')] AND NOT (t.ids(r) && array[t.u('PU'), t.u('OA'), t.u('AS')]), 'DIR view company');
  r := t.dir(t.u('AD'), format('{"company_id":"%s","account_type":"company_customer"}', t.u('CB'))::jsonb);
  PERFORM t.ok(t.ids(r) = array[t.u('B1')], 'DIR company + type');
  r := t.dir(t.u('AD'), '{"view":"suspended"}');
  PERFORM t.ok(t.ids(r) = array[t.u('AX')], 'DIR view suspended');
  r := t.dir(t.u('AD'), '{"q":"PU@TENANCY"}');
  PERFORM t.ok(t.ids(r) = array[t.u('PU')], 'DIR search email (case-insensitive)');
  r := t.dir(t.u('AD'), '{"q":"01100000021"}');
  PERFORM t.ok(t.ids(r) = array[t.u('B1')], 'DIR search phone');
  r := t.dir(t.u('AD'), format('{"q":"%s"}', t.u('A2'))::jsonb);
  PERFORM t.ok(t.ids(r) = array[t.u('A2')], 'DIR search id');
  r := t.dir(t.u('AD'), '{"q":"%"}');
  PERFORM t.ok((r ->> 'total')::int = 0, 'DIR wildcard escaped');
  -- الصفحات والترتيب
  r := t.dir(t.u('AD'), '{"sort":"email","dir":"asc","limit":3}');
  PERFORM t.ok(jsonb_array_length(r -> 'rows') = 3 AND (r -> 'rows' -> 0 ->> 'email') = 'a1@tenancy.test'
           AND (r ->> 'total')::int > 3, 'DIR page 1 sorted');
  PERFORM t.ok((t.ids(t.dir(t.u('AD'), '{"sort":"email","dir":"asc","limit":3,"offset":3}')))[1]
               <> ALL (t.ids(r)), 'DIR page 2 distinct');
  PERFORM t.ok((t.dir(t.u('AD'), '{"offset":500}') -> 'rows') = '[]'::jsonb
           AND (t.dir(t.u('AD'), '{"offset":500}') ->> 'total')::int > 0, 'DIR total beyond last page');
  FOREACH e IN ARRAY array['{"view":"x"}', '{"limit":101}', '{"limit":"abc"}', '{"company_id":"nope"}', '{"sort":"password"}',
                           '{"view":"by_manager"}', '{"account_type":"platform_staff"}'] LOOP
    PERFORM t.ok(t.code(t.u('AD'), format('public.admin_customer_directory(%L::jsonb)', e)) LIKE '22023:%', 'DIR invalid ' || e);
  END LOOP;
  -- التفاصيل: الطاقم ليس في الدليل
  PERFORM t.ok(t.code(t.u('AD'), format('public.admin_customer_details(%L::uuid)', t.u('EA'))) = 'P0002:not_found', 'DET staff hidden');
  r := t.call(t.u('AD'), format('public.admin_customer_details(%L::uuid)', t.u('A1')));
  PERFORM t.ok(r ->> 'account_type' = 'company_customer' AND jsonb_array_length(r -> 'memberships') = 1
           AND NOT (r::text ~ '(two_factor|recovery_codes)') AND r -> 'manager' = 'null'::jsonb, 'DET shape');
  RAISE NOTICE 'PASS ③ الدليل: للإدارة ومالك المنصة في سياقه وحدهما، فلاتر وبحث وترتيب وصفحات على الخادم، بلا أسرار ولا طاقم، والجداول مغلقة';
END $$;

-- ══ ④ مدير الحساب ═════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; n int;
BEGIN
  INSERT INTO t.saved VALUES ('sup_b1_before', t.rows(t.u('SUP'), format('public.profiles where id = %L', t.u('B1')))::text);
  -- إداري بلا تفويض: مرفوض
  PERFORM t.ok(t.code(t.u('AD'), format('public.customer_manager_assign(%L::uuid, %L::uuid, %L)', t.u('B1'), t.u('SUP'), 'متابعة العميل شهريًا'))
               = '42501:not_authorized', 'AM admin without capability');
  -- المالك يسند
  r := t.own(format('public.customer_manager_assign(%L::uuid, %L::uuid, %L)', t.u('B1'), t.u('SUP'), 'متابعة العميل شهريًا'));
  PERFORM t.ok((r ->> 'changed')::boolean, 'AM owner assigns');
  PERFORM t.ok((t.dir(t.u('AD'), format('{"view":"by_manager","manager_id":"%s"}', t.u('SUP'))::jsonb) -> 'rows' -> 0 ->> 'id')::uuid = t.u('B1'), 'AM view by manager');
  PERFORM t.ok(NOT (t.ids(t.dir(t.u('AD'), '{"view":"by_manager","manager_id":"none"}')) && array[t.u('B1')]), 'AM view unassigned');
  -- مدير الحساب لا يكسب أي اطلاع: SUP يرى من ملف B1 ما كان يراه قبل الإسناد (لا شيء) ولا تذاكره
  PERFORM t.ok(t.rows(t.u('SUP'), format('public.profiles where id = %L', t.u('B1'))) = (SELECT v::int FROM t.saved WHERE k = 'sup_b1_before')
           AND (SELECT v::int FROM t.saved WHERE k = 'sup_b1_before') = 0, 'AM no profile access');
  PERFORM t.ok(t.code(t.u('SUP'), 'public.admin_customer_directory()') = '42501:not_authorized', 'AM manager gains no directory');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_policies WHERE coalesce(qual, '') || coalesce(with_check, '') ~ 'customer_account_managers'), 'AM no policy');
  -- تفويض القدرة (053، بخطوتين) ثم الإسناد المفوَّض
  PERFORM t.own(format('public.owner_set_capability(%L::uuid, %L, true, null)', t.u('EA'), 'customers.assign_manager'));
  PERFORM t.ok(t.code(t.u('EA'), format('public.customer_manager_assign(%L::uuid, %L::uuid, %L)', t.u('A1'), t.u('AD'), 'عميل جديد للإداري')) = 'ok', 'AM delegate assigns');
  PERFORM t.ok(t.code(t.u('EA'), format('public.customer_manager_assign(%L::uuid, %L::uuid, %L)', t.u('A2'), t.u('EA'), 'أسند نفسي لهذا العميل')) = '42501:self_assignment', 'AM no self-assignment');
  PERFORM t.ok(t.code(t.u('EA'), format('public.customer_manager_assign(%L::uuid, %L::uuid, %L)', t.u('EA'), t.u('AD'), 'مدير لحسابي أنا')) = '42501:self_account', 'AM not for own account');
  PERFORM t.ok(t.code(t.u('EA'), format('public.customer_manager_assign(%L::uuid, %L::uuid, %L)', t.u('A2'), t.u('A1'), 'عميل يدير عميلًا')) = '22023:manager_not_eligible', 'AM manager must be staff');
  PERFORM t.ok(t.code(t.u('EA'), format('public.customer_manager_assign(%L::uuid, %L::uuid, %L)', t.u('AS'), t.u('AD'), 'موظف شركة كعميل')) = '22023:not_a_customer', 'AM staff is not a customer');
  PERFORM t.ok(t.code(t.u('EA'), format('public.customer_manager_assign(%L::uuid, %L::uuid, %L)', t.u('A2'), t.u('AD'), 'قصير')) = '22023:', 'AM reason required');
  -- إعادة الإسناد والإلغاء: السطر السابق يُنهى ويبقى
  PERFORM t.ok(t.code(t.u('EA'), format('public.customer_manager_assign(%L::uuid, %L::uuid, %L)', t.u('A1'), t.u('SUP'), 'نقل المتابعة للدعم')) = 'ok', 'AM reassign');
  PERFORM t.ok((SELECT string_agg(coalesce(end_cause, 'active'), ',' ORDER BY assigned_at) FROM public.customer_account_managers WHERE customer_id = t.u('A1')) = 'reassigned,active', 'AM history kept');
  r := t.call(t.u('AD'), format('public.admin_customer_details(%L::uuid)', t.u('A1')));
  PERFORM t.ok(jsonb_array_length(r -> 'manager_history') = 2 AND (r -> 'manager' ->> 'id')::uuid = t.u('SUP'), 'AM details history');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.privileged_audit WHERE action = 'customer.account_manager.set' AND target_user_id = t.u('A1')), 'AM audited');
  -- سجل الامتيازات للمالك وحده (privileged_audit_select_owner): التفاصيل لا توسّعه للإدارة
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'history') e WHERE e ->> 'source' = 'privileged'), 'AM privileged history hidden from admins');
  PERFORM t.ctx('owner');
  PERFORM t.ok(EXISTS (SELECT 1 FROM jsonb_array_elements(t.call(t.u('OW'), format('public.admin_customer_details(%L::uuid)', t.u('A1'))) -> 'history') e
                        WHERE e ->> 'source' = 'privileged' AND e ->> 'action' = 'customer.account_manager.set'), 'AM privileged history for owner');
  PERFORM t.ok(NOT ((t.call(t.u('AD'), format('public.admin_customer_details(%L::uuid)', t.u('OA'))) -> 'owned_company') ? 'contact_email'), 'DET no company contact for admins');
  PERFORM t.ctx(null);
  -- سحب التفويض ⇒ لا إسناد
  PERFORM t.own(format('public.owner_set_capability(%L::uuid, %L, false, null)', t.u('EA'), 'customers.assign_manager'));
  PERFORM t.ok(t.code(t.u('EA'), format('public.customer_manager_assign(%L::uuid, null, %L)', t.u('A1'), 'إلغاء المتابعة')) = '42501:not_authorized', 'AM revoked capability');
  -- السجل ثابت
  PERFORM t.ok(t.err_super_ok(format('update public.customer_account_managers set reason = %L where customer_id = %L', 'تعديل السبب لاحقًا', t.u('B1'))) = '55000'
           AND t.err_super_ok(format('delete from public.customer_account_managers where customer_id = %L', t.u('B1'))) = '55000', 'AM immutable');
  -- فقد الأهلية (حظر المدير) يُنهي إسناداته
  UPDATE public.profiles SET ban_status = 'banned' WHERE id = t.u('SUP');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.customer_account_managers WHERE manager_id = t.u('SUP') AND ended_at IS NULL)
           AND (SELECT count(*) FROM public.customer_account_managers WHERE manager_id = t.u('SUP') AND end_cause = 'manager_ineligible') = 2, 'AM ineligible ends');
  UPDATE public.profiles SET ban_status = 'none' WHERE id = t.u('SUP');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.customer_account_managers WHERE manager_id = t.u('SUP') AND ended_at IS NULL), 'AM not revived on unban');
  RAISE NOTICE 'PASS ④ مدير الحساب: المالك أو مفوَّض بالقدرة، لا إسناد للنفس ولا لحسابك، المدير من الطاقم، سجل ثابت، فقد الأهلية يُنهي، ولا يمنح أي اطلاع';
END $$;

-- ══ ⑤ إرسال الطلب ═════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_req uuid; n0 int;
BEGIN
  n0 := (SELECT count(*) FROM public.notifications WHERE user_id = t.u('OW'));
  -- من يرسل: إداري المنصة وحده
  PERFORM t.ok(t.submit(t.u('SUP'), 'add_to_company', t.u('PU'), 'pu@tenancy.test', t.u('CA'), t.x('K1')) = '42501:not_authorized', 'REQ support refused');
  PERFORM t.ok(t.submit(t.u('OA'), 'add_to_company', t.u('PU'), 'pu@tenancy.test', t.u('CA'), t.x('K1')) = '42501:not_authorized', 'REQ company owner refused');
  PERFORM t.ok(t.submit(t.u('AS'), 'add_to_company', t.u('PU'), 'pu@tenancy.test', t.u('CA'), t.x('K1')) = '42501:not_authorized', 'REQ company staff refused');
  PERFORM t.ok(t.submit(t.u('PU'), 'add_to_company', t.u('PU'), 'pu@tenancy.test', t.u('CA'), t.x('K1')) = '42501:not_authorized', 'REQ customer refused');
  PERFORM t.ctx('owner');
  PERFORM t.ok(t.submit(t.u('OW'), 'add_to_company', t.u('PU'), 'pu@tenancy.test', t.u('CA'), t.x('K1')) = '42501:not_authorized', 'REQ owner does not submit');
  PERFORM t.ctx(null);
  -- البريد للتحقق وحده: عدم التطابق يوقف
  PERFORM t.ok(t.submit(t.u('AD'), 'add_to_company', t.u('PU'), 'other@tenancy.test', t.u('CA'), t.x('K1')) = '22023:email_matches', 'REQ email mismatch');
  PERFORM t.ok(t.submit(t.u('AD'), 'add_to_company', t.u('PU'), '', t.u('CA'), t.x('K1')) = '22023:email_matches', 'REQ email missing');
  -- بريد مختلف يخص حسابًا آخر ⇒ التباس
  PERFORM t.ok(t.submit(t.u('AD'), 'add_to_company', t.u('PU'), 'pu@tenancy.test', t.u('CA'), t.x('K1'), 'a2@tenancy.test') = '22023:target_email_unclaimed', 'REQ target email belongs to another account');
  PERFORM t.ok(t.submit(t.u('AD'), 'add_to_company', t.u('PU'), 'pu@tenancy.test', t.u('CA'), t.x('K1'), 'not-an-email') = '22023:target_email_valid', 'REQ target email invalid');
  -- بريد الملف يختلف عن بريد الدخول ⇒ التباس يوقف
  UPDATE auth.users SET email = 'changed@tenancy.test' WHERE id = t.u('DG');
  PERFORM t.ok(t.submit(t.u('AD'), 'add_to_company', t.u('DG'), 'dg@tenancy.test', t.u('CA'), t.x('K1')) = '22023:email_unambiguous', 'REQ auth/profile email differ');
  UPDATE auth.users SET email = 'dg@tenancy.test' WHERE id = t.u('DG');
  -- العميل والشركة
  PERFORM t.ok(t.submit(t.u('AD'), 'add_to_company', t.u('NOPE'), 'x@tenancy.test', t.u('CA'), t.x('K1')) = 'P0002:customer_exists', 'REQ unknown customer');
  PERFORM t.ok(t.submit(t.u('AD'), 'add_to_company', t.u('AS'), 'as@tenancy.test', t.u('CB'), t.x('K1')) = '22023:customer_is_customer', 'REQ staff not a customer');
  PERFORM t.ok(t.submit(t.u('AD'), 'add_to_company', t.u('OB'), 'ob@tenancy.test', t.u('CA'), t.x('K1')) = '22023:customer_is_customer', 'REQ company owner not a customer');
  PERFORM t.ok(t.submit(t.u('AD'), 'add_to_company', t.u('AX'), 'ax@tenancy.test', t.u('CB'), t.x('K1')) = '22023:customer_active', 'REQ suspended customer');
  PERFORM t.ok(t.submit(t.u('AD'), 'add_to_company', t.u('PU'), 'pu@tenancy.test', t.u('NOPE'), t.x('K1')) = 'P0002:company_exists', 'REQ unknown company');
  PERFORM t.ok(t.submit(t.u('AD'), 'add_to_company', t.u('A1'), 'a1@tenancy.test', t.u('CA'), t.x('K1')) = '22023:not_already_member', 'REQ already member');
  PERFORM t.ok(t.submit(t.u('AD'), 'transfer_direct_to_company', t.u('A1'), 'a1@tenancy.test', t.u('CB'), t.x('K1')) = '22023:customer_is_direct', 'REQ transfer needs a direct customer');
  PERFORM t.ok(t.submit(t.u('AD'), 'bogus', t.u('PU'), 'pu@tenancy.test', t.u('CA'), t.x('K1')) = '22023:invalid_type', 'REQ type');
  PERFORM t.ok(t.code(t.u('AD'), format('public.account_request_submit(%L, %L::uuid, %L, null, %L::uuid, %L, %L::uuid)',
               'add_to_company', t.u('PU'), 'pu@tenancy.test', t.u('CA'), 'قصير', t.x('K1'))) = '22023:', 'REQ reason');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.account_requests), 'REQ nothing stored on refusal');

  -- طلب صحيح (البريد بحالة أحرف مختلفة، وبريد تواصل مختلف للعلم)
  PERFORM t.ok(t.submit(t.u('AD'), 'add_to_company', t.u('PU'), ' PU@Tenancy.TEST ', t.u('CA'), t.x('K1'), 'pu.work@example.test') = 'ok', 'REQ submitted');
  SELECT id INTO v_req FROM public.account_requests WHERE customer_id = t.u('PU');
  INSERT INTO t.saved VALUES ('req_pu', v_req);
  -- الطلب لا يغيّر شيئًا في العميل
  PERFORM t.ok((SELECT super_user_id FROM public.profiles WHERE id = t.u('PU')) IS NULL
           AND NOT EXISTS (SELECT 1 FROM public.company_memberships WHERE user_id = t.u('PU'))
           AND (SELECT email FROM public.profiles WHERE id = t.u('PU')) = 'pu@tenancy.test'
           AND (SELECT email FROM auth.users WHERE id = t.u('PU')) = 'pu@tenancy.test'
           AND (SELECT a.account_type FROM public._customer_accounts(t.u('PU')) a) = 'direct', 'REQ changes nothing');
  PERFORM t.ok((SELECT customer_email || '|' || target_email || '|' || status FROM public.account_requests WHERE id = v_req)
               = 'pu@tenancy.test|pu.work@example.test|pending', 'REQ stored normalized');
  -- إعادة الإرسال بنفس المفتاح: نفس الطلب؛ ببيانات مختلفة: رفض
  r := t.call(t.u('AD'), format('public.account_request_submit(%L, %L::uuid, %L, %L, %L::uuid, %L, %L::uuid)',
              'add_to_company', t.u('PU'), 'pu@tenancy.test', 'pu.work@example.test', t.u('CA'), 'سبب الطلب: إدارة الحساب حسب الاتفاق', t.x('K1')));
  PERFORM t.ok((r ->> 'replayed')::boolean AND (r ->> 'request_id')::uuid = v_req, 'REQ idempotent replay');
  PERFORM t.ok(t.submit(t.u('AD'), 'add_to_company', t.u('PU'), 'pu@tenancy.test', t.u('CB'), t.x('K1')) = '22023:idempotency_conflict', 'REQ key reused differently');
  -- طلب متعارض لنفس العميل (من إداري آخر)
  PERFORM t.ok(t.submit(t.u('EA'), 'add_to_company', t.u('PU'), 'pu@tenancy.test', t.u('CB'), t.x('K2')) = '23505:no_conflicting_request', 'REQ conflicting request');
  PERFORM t.ok(t.err_super_ok(format($i$insert into public.account_requests (request_type, customer_id, customer_email, company_id, reason, requested_by, idempotency_key)
               values ('add_to_company', %L, 'pu@tenancy.test', %L, 'سباق متزامن مباشر', %L, gen_random_uuid())$i$, t.u('PU'), t.u('CB'), t.u('EA'))) = '23505', 'REQ unique pending index');
  -- طلبات أخرى للاختبارات التالية
  PERFORM t.ok(t.submit(t.u('EA'), 'transfer_direct_to_company', t.u('DG'), 'dg@tenancy.test', t.u('CB'), t.x('K3')) = 'ok', 'REQ transfer submitted');
  PERFORM t.ok(t.submit(t.u('AD'), 'add_to_company', t.x('NS'), 'ns@tenancy.test', t.u('CB'), t.x('K4')) = 'ok', 'REQ NS submitted');
  PERFORM t.ok(t.submit(t.u('AD'), 'add_to_company', t.u('A1'), 'a1@tenancy.test', t.u('CB'), t.x('K5')) = 'ok', 'REQ secondary submitted');
  -- طلباتي: المرسل يرى طلباته وحده
  PERFORM t.ok(jsonb_array_length(t.call(t.u('AD'), 'public.my_account_requests()')) = 3
           AND jsonb_array_length(t.call(t.u('EA'), 'public.my_account_requests()')) = 1, 'REQ mine only');
  PERFORM t.ok(t.code(t.u('A1'), 'public.my_account_requests()') = '42501:not_authorized'
           AND t.code(t.u('SUP'), 'public.my_account_requests()') = '42501:not_authorized', 'REQ mine denied to others');
  -- إشعار المالك: واحد لكل طلب، بنص عام
  PERFORM t.ok((SELECT count(*) FROM public.notifications WHERE user_id = t.u('OW')) = n0 + 4, 'REQ owner notified');
  PERFORM t.ok(t.code(t.u('AD'), format('public.account_request_cancel(%L::uuid, %L)', v_req, 'تم الاتفاق مع العميل على تأجيل')) = 'ok', 'REQ requester cancels');
  PERFORM t.ok(t.code(t.u('AD'), format('public.account_request_cancel(%L::uuid, %L)', v_req, 'محاولة ثانية للإلغاء')) = '55000:request_final', 'REQ cancel final');
  PERFORM t.ok(t.submit(t.u('AD'), 'add_to_company', t.u('PU'), 'pu@tenancy.test', t.u('CA'), t.x('K6')) = 'ok', 'REQ new request after cancel');
  UPDATE t.saved SET v = (SELECT id FROM public.account_requests WHERE customer_id = t.u('PU') AND status = 'pending')::text WHERE k = 'req_pu';
  PERFORM t.ok(t.code(t.u('EA'), format('public.account_request_cancel(%L::uuid, %L)', t.sv('req_pu'), 'إلغاء طلب زميل آخر')) = 'P0002:not_found', 'REQ cannot cancel others');
  RAISE NOTICE 'PASS ⑤ الإرسال: إداري المنصة وحده، الطلب لا يغيّر شيئًا، البريد للتحقق والالتباس يوقف، لا تكرار ولا طلبين متعارضين، والمالك يُخطَر';
END $$;

-- ══ ⑥ صندوق المالك ═══════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ok(t.code(t.u('AD'), 'public.owner_account_requests()') = '42501:not_authorized'
           AND t.code(t.u('EA'), format('public.owner_account_request_details(%L::uuid)', t.sv('req_pu'))) = '42501:not_authorized', 'BOX admins denied');
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.code(t.u('OW'), 'public.owner_account_requests()') = '42501:not_authorized', 'BOX owner outside owner context');
  r := t.own('public.owner_account_requests()');
  PERFORM t.ok((r ->> 'total')::int = 5 AND (r ->> 'pending_count')::int = 4, 'BOX all');
  PERFORM t.ok((t.own('public.owner_account_requests(''{"status":"pending","request_type":"transfer_direct_to_company"}'')') ->> 'total')::int = 1, 'BOX type filter');
  PERFORM t.ok((t.own(format('public.owner_account_requests(%L::jsonb)', jsonb_build_object('requested_by', t.u('EA')))) ->> 'total')::int = 1, 'BOX requester filter');
  PERFORM t.ok((t.own('public.owner_account_requests(''{"customer_email":"PU@"}'')') ->> 'total')::int = 2, 'BOX email filter');
  PERFORM t.ok((t.own(format('public.owner_account_requests(%L::jsonb)', jsonb_build_object('company_id', t.u('CB')))) ->> 'total')::int = 3, 'BOX company filter');
  PERFORM t.ok((t.own(format('public.owner_account_requests(%L::jsonb)', jsonb_build_object('from', now() + interval '1 day'))) ->> 'total')::int = 0, 'BOX date filter');
  PERFORM t.ok(t.own_code('public.owner_account_requests(''{"from":"yesterday-ish"}'')') = '22023:invalid_filter', 'BOX invalid date');
  r := t.own(format('public.owner_account_request_details(%L::uuid)', t.sv('req_pu')));
  PERFORM t.ok(r -> 'company' ->> 'contact_email' = 'a@company.test' AND r ->> 'customer_email' = 'pu@tenancy.test', 'DET contact email separate');
  PERFORM t.ok((r -> 'execution' ->> 'available')::boolean = false AND r -> 'execution' ->> 'code' = 'prerequisite_not_enabled'
           AND (r -> 'execution' -> 'missing') ? 'account_request_execution_enabled', 'DET execution unavailable');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'checks') c WHERE NOT (c ->> 'ok')::boolean), 'DET checks pass');
  PERFORM t.ok((r -> 'customer_now' ->> 'open_tickets')::int = 1 AND (r ->> 'can_decide')::boolean, 'DET impact');
  r := t.own(format('public.owner_account_request_details(%L::uuid)', (SELECT id FROM public.account_requests WHERE customer_id = t.u('DG'))));
  PERFORM t.ok(r -> 'execution' ->> 'code' = 'operation_not_available', 'DET transfer not available');
  RAISE NOTICE 'PASS ⑥ الصندوق: المالك في سياقه وحده، فلاتر النوع والمرسل والبريد والشركة والتاريخ، وملخص الأثر وبريد الشركة منفصل';
END $$;

-- ══ ⑦ القرار ══════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_req uuid := t.sv('req_pu'); v_dg uuid; v_ns uuid; v_a1 uuid; v_self uuid;
BEGIN
  SELECT id INTO v_dg FROM public.account_requests WHERE customer_id = t.u('DG');
  SELECT id INTO v_ns FROM public.account_requests WHERE customer_id = t.x('NS');
  SELECT id INTO v_a1 FROM public.account_requests WHERE customer_id = t.u('A1');
  -- غير المالك، أو المالك بلا تحقق خطوتين
  PERFORM t.ok(t.code(t.u('EA'), format('public.owner_decide_account_request(%L::uuid, true, null)', v_req)) = '42501:step_up_required', 'DEC elevated admin refused');
  PERFORM t.ok(t.code(t.u('AD'), format('public.owner_decide_account_request(%L::uuid, false, %L)', v_req, 'رفض من الإداري نفسه')) = '42501:step_up_required', 'DEC requester refused');
  PERFORM t.ctx('owner');
  DELETE FROM public.privileged_step_ups WHERE user_id = t.u('OW');
  PERFORM t.ok(t.code(t.u('OW'), format('public.owner_decide_account_request(%L::uuid, true, null)', v_req)) = '42501:step_up_required', 'DEC owner without step-up');
  -- لا قرار على طلبك (طلب باسم المالك، أُدرج مباشرة لأن المالك لا يرسل عبر الواجهة)
  INSERT INTO public.account_requests (request_type, customer_id, customer_email, company_id, reason, requested_by, idempotency_key)
  VALUES ('add_to_company', t.u('B1'), 'b1@tenancy.test', t.u('CA'), 'طلب مُدرج باسم المالك', t.u('OW'), gen_random_uuid()) RETURNING id INTO v_self;
  PERFORM t.ok(t.own_code(format('public.owner_decide_account_request(%L::uuid, false, %L)', v_self, 'رفض طلبي أنا شخصيًا')) = '42501:self_approval', 'DEC self-approval refused');
  PERFORM t.ok(t.err_super_ok(format('update public.account_requests set status = %L, decided_by = requested_by, decided_at = now() where id = %L', 'approved', v_self)) = '23514', 'DEC self-decision constraint');
  -- لا موافقة بلا تنفيذ: المفاتيح مطفأة ⇒ رفض، والطلب يبقى معلّقًا، ولا شيء يتغير
  PERFORM t.ok(t.own_code(format('public.owner_decide_account_request(%L::uuid, true, null)', v_req)) = '0A000:prerequisite_not_enabled', 'DEC approval blocked while off');
  PERFORM t.ok((SELECT status FROM public.account_requests WHERE id = v_req) = 'pending'
           AND NOT EXISTS (SELECT 1 FROM public.company_memberships WHERE user_id = t.u('PU')), 'DEC still pending, nothing changed');
  -- الرفض: بسبب، ثم نهائي (لا إعادة)
  PERFORM t.ok(t.own_code(format('public.owner_decide_account_request(%L::uuid, false, null)', v_ns)) = '22023:', 'DEC reject needs reason');
  r := t.own(format('public.owner_decide_account_request(%L::uuid, false, %L)', v_ns, 'لا علاقة تعاقدية مع الشركة'));
  PERFORM t.ok(r ->> 'status' = 'rejected', 'DEC rejected');
  PERFORM t.ok(t.own_code(format('public.owner_decide_account_request(%L::uuid, true, null)', v_ns)) = '55000:request_final'
           AND t.own_code(format('public.owner_decide_account_request(%L::uuid, false, %L)', v_ns, 'رفض مكرر للطلب نفسه')) = '55000:request_final', 'DEC no replay');
  PERFORM t.ok(t.err_super_ok(format('update public.account_requests set decision_reason = %L where id = %L', 'تعديل لاحق', v_ns)) = '55000'
           AND t.err_super_ok(format('delete from public.account_requests where id = %L', v_ns)) = '55000', 'DEC final is immutable');
  PERFORM t.ok(t.err_super_ok(format('update public.account_requests set company_id = %L where id = %L', t.u('CW'), v_req)) = '55000', 'DEC pending material fields immutable');
  -- النقل الكامل غير متاح حتى مع كل المفاتيح
  PERFORM t.sw('company_isolation_enforced', true);
  PERFORM t.sw('company_permissions_enabled', true);
  PERFORM t.sw('account_request_execution_enabled', true);
  PERFORM t.sw('multi_company_memberships_enabled', true);
  PERFORM t.ok(t.own_code(format('public.owner_decide_account_request(%L::uuid, true, null)', v_dg)) = '0A000:operation_not_available'
           AND (SELECT status FROM public.account_requests WHERE id = v_dg) = 'pending', 'DEC transfer not available');
  PERFORM t.sw('multi_company_memberships_enabled', false);
  -- عضوية إضافية (A1 له شركة أساسية) تتطلب تعدد الشركات
  PERFORM t.ok(t.own_code(format('public.owner_decide_account_request(%L::uuid, true, null)', v_a1)) = '0A000:prerequisite_not_enabled', 'DEC secondary needs multi');

  -- إعادة التحقق: تغيّر بريد العميل منذ الطلب ⇒ لا شيء يُنفَّذ
  UPDATE public.profiles SET email = 'pu.new@tenancy.test' WHERE id = t.u('PU');
  UPDATE auth.users SET email = 'pu.new@tenancy.test' WHERE id = t.u('PU');
  PERFORM t.ok(t.own_code(format('public.owner_decide_account_request(%L::uuid, true, null)', v_req)) = '55000:revalidation_failed/email_matches', 'DEC email changed');
  UPDATE public.profiles SET email = 'pu@tenancy.test' WHERE id = t.u('PU');
  UPDATE auth.users SET email = 'pu@tenancy.test' WHERE id = t.u('PU');
  -- الشركة أُوقفت منذ الطلب
  UPDATE public.companies SET status = 'suspended' WHERE id = t.u('CA');
  PERFORM t.ok(t.own_code(format('public.owner_decide_account_request(%L::uuid, true, null)', v_req)) = '55000:revalidation_failed/company_active', 'DEC company suspended');
  UPDATE public.companies SET status = 'active' WHERE id = t.u('CA');
  -- فشل أثناء التنفيذ ⇒ المعاملة كلها تُلغى: لا عضوية ولا موافقة
  CREATE FUNCTION t.boom() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'boom' USING errcode = 'XX001'; END $f$;
  CREATE TRIGGER t_boom AFTER INSERT ON public.company_memberships FOR EACH ROW EXECUTE FUNCTION t.boom();
  PERFORM t.ok(t.own_code(format('public.owner_decide_account_request(%L::uuid, true, null)', v_req)) = 'XX001:', 'DEC execution failure');
  DROP TRIGGER t_boom ON public.company_memberships;
  PERFORM t.ok((SELECT status FROM public.account_requests WHERE id = v_req) = 'pending'
           AND NOT EXISTS (SELECT 1 FROM public.company_memberships WHERE user_id = t.u('PU'))
           AND NOT EXISTS (SELECT 1 FROM public.privileged_audit WHERE action = 'account_request.approved'), 'DEC failure left nothing');

  -- الموافقة الناجحة: تنفيذ ذري عبر 096
  INSERT INTO t.saved VALUES ('oa_sees_tpu_before', t.sees('OA', 'TPU')::text);
  r := t.own(format('public.owner_decide_account_request(%L::uuid, true, %L)', v_req, 'تمت مراجعة العقد'));
  PERFORM t.ok(r ->> 'status' = 'approved' AND (r ->> 'primary')::boolean, 'DEC approved');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.company_memberships WHERE user_id = t.u('PU') AND company_id = t.u('CA') AND is_primary
                        AND status = 'active' AND joined_via = 'account_request')
           AND (SELECT super_user_id FROM public.profiles WHERE id = t.u('PU')) = t.u('OA')
           AND (SELECT a.account_type FROM public._customer_accounts(t.u('PU')) a) = 'direct_and_company'
           AND (SELECT email FROM auth.users WHERE id = t.u('PU')) = 'pu@tenancy.test', 'DEC membership + mirror, email untouched');
  -- تذاكر العميل السابقة لا تنكشف لمالك الشركة (العزل مفعّل)
  PERFORM t.ok(NOT t.sees('OA', 'TPU') AND t.sees('PU', 'TPU'), 'DEC history stays private');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.company_membership_events WHERE user_id = t.u('PU') AND detail ->> 'via' = 'account_request'), 'DEC membership event');
  PERFORM t.ok(t.own_code(format('public.owner_decide_account_request(%L::uuid, true, null)', v_req)) = '55000:request_final', 'DEC repeated approval');
  -- العزل و098 لا يُطفآن بعد إضافة عميل بطلب
  PERFORM t.ok(t.err_super_ok('update public.platform_feature_switches set enabled = false where key = ''company_isolation_enforced''') = '55000'
           AND t.err_super_ok('update public.platform_feature_switches set enabled = false where key = ''company_permissions_enabled''') = '55000', 'DEC isolation held');
  -- العضوية الإضافية مع تعدد الشركات: super_user_id لا يتغير
  PERFORM t.sw('multi_company_memberships_enabled', true);
  r := t.own(format('public.owner_decide_account_request(%L::uuid, true, null)', v_a1));
  PERFORM t.ok(r ->> 'status' = 'approved' AND NOT (r ->> 'primary')::boolean
           AND (SELECT super_user_id FROM public.profiles WHERE id = t.u('A1')) = t.u('OA'), 'DEC secondary keeps primary');
  PERFORM t.sw('multi_company_memberships_enabled', false);
  PERFORM t.sw('account_request_execution_enabled', false);
  RAISE NOTICE 'PASS ⑦ القرار: المالك بخطوتين وحده، لا قرار على طلبك، الرفض بسبب ونهائي، لا موافقة بلا تنفيذ، إعادة التحقق والفشل لا يتركان شيئًا، والتاريخ لا ينكشف';
END $$;

-- ══ ⑦ب موافقتان متزامنتان بجلستين حقيقيتين ══════════════════════════════
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
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;
DO $$ BEGIN
  PERFORM t.sw('account_request_execution_enabled', true);
  PERFORM t.ok(t.submit(t.u('AD'), 'add_to_company', t.x('NS'), 'ns@tenancy.test', t.u('CA'), t.x('K8')) = 'ok', 'RACE request');
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
END $$;
SELECT t.conn('s1', t.u('OW')), t.conn('s2', t.u('OW'));
DO $$
DECLARE v_req uuid; r1 text; r2 text; blocked boolean;
BEGIN
  SELECT id INTO v_req FROM public.account_requests WHERE customer_id = t.x('NS') AND status = 'pending';
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
  PERFORM t.ok(blocked, 'RACE second session waited');
  PERFORM t.ok(r1 LIKE '%"approved"%' AND r2 LIKE '%الطلب نهائي%', 'RACE ' || r1 || ' / ' || coalesce(r2, 'null'));
  PERFORM t.ok((SELECT count(*) FROM public.company_memberships WHERE user_id = t.x('NS') AND company_id = t.u('CA')) = 1
           AND (SELECT count(*) FROM public.privileged_audit WHERE action = 'account_request.approved' AND target_user_id = t.x('NS')) = 1, 'RACE executed once');
  PERFORM t.sw('account_request_execution_enabled', false);
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ⑦ب موافقتان متزامنتان من جلستين: الثانية تنتظر القفل ثم تجد الطلب نهائيًا — تنفيذ واحد بلا تكرار';
END $$;
SELECT t.dblink_disconnect('s1'), t.dblink_disconnect('s2');

-- ══ ⑧ الحذف ═══════════════════════════════════════════════════════════════
DO $$
DECLARE v_dg uuid;
BEGIN
  SELECT id INTO v_dg FROM public.account_requests WHERE customer_id = t.u('DG');
  -- حذف حساب له طلب معلّق وإسناد وعلاقة مباشرة: ينجح، والسجل يبقى منتهيًا
  PERFORM t.own(format('public.customer_manager_assign(%L::uuid, %L::uuid, %L)', t.u('DG'), t.u('AD'), 'متابعة قبل الحذف'));
  PERFORM t.ok(t.err_super_ok(format('delete from auth.users where id = %L', t.u('DG'))) = 'ok', 'DEL account deleted');
  PERFORM t.ok((SELECT status || ':' || decision_reason FROM public.account_requests WHERE id = v_dg) = 'cancelled:account_deleted'
           AND (SELECT end_cause FROM public.customer_account_managers WHERE customer_id = t.u('DG')) = 'customer_deleted'
           AND (SELECT end_cause FROM public.platform_direct_customers WHERE user_id = t.u('DG')) = 'account_deleted', 'DEL history ended');
  -- حذف شركة لها طلب معلّق
  PERFORM t.ok(t.submit(t.u('AD'), 'add_to_company', t.u('B1'), 'b1@tenancy.test', t.u('CW'), t.x('K7')) = '23505:no_conflicting_request', 'DEL B1 has owner row pending');
  UPDATE public.account_requests SET status = 'cancelled', decided_at = now(), decision_reason = 'test cleanup' WHERE customer_id = t.u('B1') AND status = 'pending';
  PERFORM t.ok(t.submit(t.u('AD'), 'add_to_company', t.u('B1'), 'b1@tenancy.test', t.u('CW'), t.x('K7')) = 'ok', 'DEL B1 request');
  PERFORM t.ok(t.err_super_ok(format('delete from public.companies where id = %L', t.u('CW'))) = 'ok', 'DEL company deleted');
  PERFORM t.ok((SELECT decision_reason FROM public.account_requests WHERE customer_id = t.u('B1') AND company_id = t.u('CW')) = 'company_deleted', 'DEL company request cancelled');
  RAISE NOTICE 'PASS ⑧ الحذف: الحساب والشركة يُحذفان، والطلب المعلّق يُلغى، والإسناد والعلاقة المباشرة تنتهي وتبقى سجلًا';
END $$;

-- ══ ⑨ الإشعارات عامة ═══════════════════════════════════════════════════════
DO $$ BEGIN
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.notifications n
                            WHERE n.created_at >= now() - interval '1 hour'
                              AND n.category = 'account'
                              AND (n.title || ' | ' || n.message) ~* '(@|tenancy|عميل أ1|حساب فرد|تسجيل جديد|pu\.work|(شركة أ|شركة ب)($|[[:space:][:punct:]]))'),
               'NTF no customer data');
  PERFORM t.ok((SELECT count(*) FROM public.notifications WHERE user_id = t.u('AD') AND title = 'صدر قرار في طلب حساب') >= 2, 'NTF requester notified');
  RAISE NOTICE 'PASS ⑨ الإشعارات: للمالك عند الإرسال وللمرسل عند القرار، بنص عام بلا بريد ولا اسم عميل ولا شركة';
END $$;

-- ══ ⑩ التراجع مرفوض مع السجل ══════════════════════════════════════════════
\set rb105 `cat migrations/_rollback/105_account_hierarchy_customers.down.sql`
SELECT set_config('t.rb105', :'rb105', false) IS NOT NULL;
DO $$
DECLARE s text;
BEGIN
  s := t.schema_digest();
  BEGIN
    EXECUTE current_setting('t.rb105');
    RAISE EXCEPTION 'FAIL RB105 allowed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%طلبات حسابات%' THEN RAISE; END IF;
  END;
  PERFORM t.ok(t.schema_digest() = s AND to_regclass('public.account_requests') IS NOT NULL, 'RB refused, nothing changed');
  RAISE NOTICE 'PASS ⑩ التراجع مرفوض مع وجود طلبات وإسنادات وعضويات من طلبات — بلا أي تغيير';
  RAISE NOTICE 'ALL 105 account hierarchy tests passed';
END $$;
