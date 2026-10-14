-- ============================================================================
-- 095_account_boundaries على نسخة مطابقة للإنتاج حتى 093
--
--   ⓪ قبل 095: كل ثغرة يغلقها 095 موجودة فعلًا (إثبات لا افتراض) + بصمات ما لا يتغيّر
--   ① 095: الكائنات والصلاحيات
--   ② نوع الحساب لكل فاعل
--   ③ لوحة الشركة: المدير كاملة، الموظف مختصرة، العميل لا شيء، المعاينة لا شيء
--   ④ صف الشركة عبر REST
--   ⑤ ربط الاشتراك بالشركة (الدالة والمحفّز)
--   ⑥ رموز API وسجلات استخدامها
--   ⑦ التكاملات الشخصية ونماذجها
--   ⑧ سجل النشاط (IP والجهاز)
--   ⑨ ملف العميل ونقاط المكافآت
--   ⑩ بوابة العميل ووجهة منظور العضو
--   ⑪ عدم المساس + إعادة التشغيل + التراجع (تعود الثغرات = الاختبار يكشفها) + إعادة التطبيق
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

\i tests/fixtures/prod-shape/load.sql
\i tests/fixtures/prod-shape/chain-to-093.sql
\i tests/fixtures/tenancy/harness.sql

INSERT INTO public.ai_provider_catalog (id, label) VALUES ('openai', 'OpenAI') ON CONFLICT DO NOTHING;
-- بيانات حسّاسة لعميل الشركة A1: رمز API، سجل استخدام، تكامل شخصي، نشاط، اشتراك شخصي
INSERT INTO public.api_tokens (id, user_id, name, api_key, secret_hash, secret_last_four, is_active)
VALUES ('a0000000-0000-4000-8000-0000000000a1', t.u('A1'), 'مفتاح A1', 'mk_a1_public', 'hash-a1', 'a1a1', true),
       ('a0000000-0000-4000-8000-0000000000a2', t.u('OA'), 'مفتاح OA', 'mk_oa_public', 'hash-oa', 'oaoa', true);
INSERT INTO public.api_token_usage_logs (token_id, user_id, endpoint, method, status_code, ip_address, user_agent)
VALUES ('a0000000-0000-4000-8000-0000000000a1', t.u('A1'), '/tickets', 'GET', 200, '10.0.0.11', 'UA-A1');
INSERT INTO public.external_integrations (id, owner_id, owner_scope, provider, display_name, credentials_encrypted, is_active)
VALUES ('e0000000-0000-4000-8000-0000000000a1', t.u('A1'), 'user', 'openai', 'تكامل A1', 'enc-secret-a1', true),
       ('e0000000-0000-4000-8000-0000000000f1', null, 'platform', 'openai', 'تكامل المنصة', 'enc-secret-platform', true);
INSERT INTO public.external_integration_models (integration_id, model_id, display_name)
VALUES ('e0000000-0000-4000-8000-0000000000a1', 'gpt-a1', 'نموذج A1');
INSERT INTO public.activity_logs (user_id, action, ip_address, user_agent, device_info, location_info)
VALUES (t.u('A1'), 'login', '10.0.0.11', 'UA-A1', '{"device":"phone"}', '{"city":"cairo"}');
INSERT INTO public.whatsapp_subscriptions (id, user_id, plan, status, billing_cycle, start_date, end_date, duration_days)
VALUES ('5b000000-0000-4000-8000-0000000000a1', t.u('A1'), 'support', 'active', 'monthly',
        now() - interval '1 day', now() + interval '29 days', 30);

-- بصمات ما لا يجوز أن يغيّره 095
CREATE FUNCTION t.fn_digest() RETURNS text LANGUAGE sql AS $$
  select md5(string_agg(pg_get_functiondef(f::regprocedure), '#' order by f))
    from unnest(array['public.current_company_id()', 'public.company_members()', 'public.company_staff_role()',
                      'public.company_staff_list()', 'public.supervises(uuid)', 'public.ticket_in_my_scope(uuid)',
                      'public.can_access_ticket(uuid)', 'public.is_company_admin()', 'public.is_company_member()',
                      'public.company_has_feature(text)', 'public.remove_company_member(uuid)']) f $$;
CREATE FUNCTION t.policy_digest() RETURNS text LANGUAGE sql AS $$
  select md5(string_agg(concat_ws('|', tablename, policyname, permissive, cmd, qual, with_check), '#'
                        order by tablename, policyname))
    from pg_policies where schemaname in ('public', 'storage')
     and not (tablename = 'companies' and policyname = 'Company members can view their company')
     and not (tablename in ('external_integrations', 'external_integration_models'))
     and not (tablename = 'activity_logs' and policyname = 'activity_logs_select_policy')
     and not (tablename = 'profiles' and policyname = 'profiles_update_policy') $$;
CREATE FUNCTION t.data_digest() RETURNS text LANGUAGE sql AS $$
  select md5(concat_ws('#',
    (select string_agg(md5(x::text), ',' order by x.id) from public.companies x),
    (select string_agg(md5(x::text), ',' order by x.id) from public.whatsapp_subscriptions x),
    (select string_agg(md5(x::text), ',' order by x.id) from public.api_tokens x),
    (select string_agg(md5(x::text), ',' order by x.id) from public.external_integrations x))) $$;
-- البصمات الكاملة للكائنات التي يغيّرها 095 (للتأكد من أن التراجع يعيدها حرفيًا)
CREATE FUNCTION t.changed_digest() RETURNS text LANGUAGE sql AS $$
  select md5(concat_ws('#',
    (select string_agg(pg_get_functiondef(f::regprocedure), '#' order by f)
       from unnest(array['public.get_my_company_dashboard()', 'public.link_subscription_to_my_company(uuid)',
                         'public.enforce_subscription_company_owner()', 'public.is_owner_or_super_of(uuid)',
                         'public.guard_profile_points_change()', 'public.context_destination(text)']) f),
    (select string_agg(concat_ws('|', tablename, policyname, permissive, cmd, qual, with_check), '#'
                       order by tablename, policyname)
       from pg_policies where schemaname = 'public'
        and ((tablename = 'companies' and policyname = 'Company members can view their company')
             or tablename in ('external_integrations', 'external_integration_models')
             or (tablename = 'activity_logs' and policyname = 'activity_logs_select_policy')
             or (tablename = 'profiles' and policyname = 'profiles_update_policy'))))) $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ══ ⓪ قبل 095: الثغرات موجودة فعلًا ═══════════════════════════════════════
DO $$
DECLARE d jsonb;
BEGIN
  d := t.call(t.u('A1'), 'public.get_my_company_dashboard()');
  PERFORM t.ok(d #>> '{company,tax_id}' = 'TAX-A' AND jsonb_array_length(d -> 'subscriptions') >= 1,
               'BEFORE عميل الشركة يقرأ الرقم الضريبي واشتراكات الشركة');
  PERFORM t.ok(t.rows(t.u('A1'), 'public.companies') = 1, 'BEFORE عميل الشركة يقرأ صف الشركة');
  PERFORM t.ok(t.rows(t.u('OA'), format('public.api_tokens where user_id = %L', t.u('A1'))) = 1,
               'BEFORE مالك الشركة يرى رمز API لعميله');
  PERFORM t.ok(t.rows(t.u('OA'), format('public.api_token_usage_logs where user_id = %L', t.u('A1'))) = 1,
               'BEFORE مالك الشركة يرى IP استعمال رمز عميله');
  PERFORM t.ok(t.rows(t.u('OA'), 'public.external_integrations where owner_scope = ''user''') = 1,
               'BEFORE مالك الشركة يرى تكامل عميله الشخصي');
  PERFORM t.ok(t.rows(t.u('AD'), 'public.external_integrations where owner_scope = ''user''') = 1,
               'BEFORE الأدمن يرى التكامل الشخصي');
  PERFORM t.ok(t.rows(t.u('OA'), format('public.activity_logs where user_id = %L', t.u('A1'))) = 1,
               'BEFORE مالك الشركة يرى IP وجهاز عميله');
  PERFORM t.ok(t.affected(t.u('OA'), format('update public.profiles set full_name = full_name where id = %L', t.u('A1'))) = 1,
               'BEFORE مالك الشركة يعدّل ملف عميله');
  PERFORM t.ok(t.call(t.u('OA'), format('public.is_owner_or_super_of(%L::uuid)', t.u('A1')))::boolean,
               'BEFORE is_owner_or_super_of = أنا أو تابعي');
  RAISE NOTICE 'PASS ⓪ قبل 095: لوحة الشركة والصف للعميل، رموز العميل وتكاملاته وIP جهازه للمالك (9 ثغرات مُثبتة)';
END $$;
-- الربط يغيّر بيانات: نثبته داخل معاملة ثم نتراجع
BEGIN;
DO $$
BEGIN
  PERFORM t.ok(t.call(t.u('A1'), format('public.link_subscription_to_my_company(%L::uuid)',
                      '5b000000-0000-4000-8000-0000000000a1'))::boolean,
               'BEFORE عميل الشركة يربط اشتراكه الشخصي بالشركة');
  RAISE NOTICE 'PASS ⓪ب قبل 095: عميل الشركة يربط اشتراكه الشخصي بها';
END $$;
ROLLBACK;
INSERT INTO t.saved VALUES ('fn', t.fn_digest()), ('pol', t.policy_digest()), ('data', t.data_digest()),
                           ('changed', t.changed_digest());

-- ══ ① 095 ════════════════════════════════════════════════════════════════
\i migrations/095_account_boundaries.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok(to_regprocedure('public.my_account_kind()') IS NOT NULL
           AND to_regprocedure('public.my_company_portal()') IS NOT NULL, 'OBJ functions');
  PERFORM t.ok(NOT has_function_privilege('anon', 'public.my_account_kind()', 'execute')
           AND NOT has_function_privilege('anon', 'public.my_company_portal()', 'execute')
           AND has_function_privilege('authenticated', 'public.my_account_kind()', 'execute'), 'OBJ grants');
  PERFORM t.ok(t.data_digest() = (SELECT v FROM t.saved WHERE k = 'data'), 'OBJ لا يغيّر أي صف');
  RAISE NOTICE 'PASS ① 095: دالتان جديدتان لـ authenticated فقط، ولا صف تغيّر';
END $$;

-- ══ ② نوع الحساب ═════════════════════════════════════════════════════════
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('OW','platform_owner'), ('EA','platform_staff'), ('AD','platform_staff'), ('SUP','platform_staff'),
      ('OA','company_admin'), ('OB','company_admin'), ('AS','company_employee'), ('AG','company_employee'),
      ('BS','company_employee'), ('A1','company_customer'), ('B1','company_customer'), ('AX','company_customer'),
      ('PU','independent'), ('DG','independent')) v(who, kind) LOOP
    PERFORM t.ok(t.call(t.u(r.who), 'public.my_account_kind()') #>> '{}' = r.kind, 'KIND ' || r.who);
  END LOOP;
  PERFORM t.act(null);
  PERFORM t.ok(public.my_account_kind() = 'anonymous', 'KIND anonymous');
  -- الموظف الذي أُلغي دوره يعود عميلًا فورًا
  PERFORM t.call(t.u('OA'), format('public.company_staff_revoke(%L::uuid)', t.u('AG')));
  PERFORM t.ok(t.call(t.u('AG'), 'public.my_account_kind()') #>> '{}' = 'company_customer', 'KIND revoked agent → customer');
  PERFORM t.call(t.u('OA'), format('public.company_staff_set(%L::uuid, %L)', t.u('AG'), 'agent'));
  PERFORM t.ok(t.call(t.u('AG'), 'public.my_account_kind()') #>> '{}' = 'company_employee', 'KIND re-granted');
  RAISE NOTICE 'PASS ② نوع الحساب: مالك المنصة، الطاقم، مدير الشركة، موظفوها، عملاؤها، الفرد، المجهول — والإلغاء يُحتسب فورًا';
END $$;

-- ══ ③ لوحة الشركة ════════════════════════════════════════════════════════
DO $$
DECLARE d jsonb;
BEGIN
  -- العميل والمحظور والفرد: لا شيء
  PERFORM t.ok(t.call(t.u('A1'), 'public.get_my_company_dashboard()') IS NULL, 'DASH A1 null');
  PERFORM t.ok(t.call(t.u('B1'), 'public.get_my_company_dashboard()') IS NULL, 'DASH B1 null');
  PERFORM t.ok(t.call(t.u('AX'), 'public.get_my_company_dashboard()') IS NULL, 'DASH banned null');
  PERFORM t.ok(t.call(t.u('PU'), 'public.get_my_company_dashboard()') IS NULL, 'DASH PU null');
  PERFORM t.ok(t.call(t.u('AD'), 'public.get_my_company_dashboard()') IS NULL, 'DASH platform admin null');
  -- الموظف: مختصرة، بلا سجل تجاري ولا ضريبة ولا تواصل ولا اشتراكات ولا خطط
  d := t.call(t.u('AG'), 'public.get_my_company_dashboard()');
  PERFORM t.ok(d ->> 'viewer_role' = 'agent' AND d #>> '{company,name}' = 'شركة أ', 'DASH agent company A');
  PERFORM t.ok(NOT (d::text LIKE '%TAX-A%') AND NOT (d::text LIKE '%CR-A-095%') AND NOT (d::text LIKE '%a@company.test%'),
               'DASH agent بلا ضريبة ولا سجل ولا بريد');
  PERFORM t.ok(d -> 'subscriptions' = '[]'::jsonb AND d #> '{access,active_plans}' = '[]'::jsonb
           AND d -> 'registration' = 'null'::jsonb, 'DASH agent بلا اشتراكات ولا خطط ولا تسجيل');
  PERFORM t.ok(NOT (d::text LIKE '%granted_by%') AND jsonb_array_length(d -> 'entitlements') > 0,
               'DASH agent يرى أسماء الامتيازات بلا الخطط المانحة');
  d := t.call(t.u('AS'), 'public.get_my_company_dashboard()');
  PERFORM t.ok(d ->> 'viewer_role' = 'supervisor' AND NOT (d::text LIKE '%TAX-A%'), 'DASH supervisor مختصرة');
  d := t.call(t.u('BS'), 'public.get_my_company_dashboard()');
  PERFORM t.ok(d #>> '{company,name}' = 'شركة ب' AND NOT (d::text LIKE '%شركة أ%'), 'DASH BS شركته فقط');
  -- المدير: كما كانت + viewer_role
  d := t.call(t.u('OA'), 'public.get_my_company_dashboard()');
  PERFORM t.ok(d ->> 'viewer_role' = 'admin' AND d #>> '{company,tax_id}' = 'TAX-A'
           AND jsonb_array_length(d -> 'subscriptions') = 1, 'DASH OA كاملة');
  -- مالك المنصة: كامل في سياق الشركة، لا شيء في منظور العضو
  PERFORM t.ctx('company_admin');
  d := t.call(t.u('OW'), 'public.get_my_company_dashboard()');
  PERFORM t.ok(d ->> 'viewer_role' = 'admin' AND d #>> '{company,name}' = 'شركة المالك', 'DASH OW company_admin');
  PERFORM t.ctx('company_user_preview');
  PERFORM t.ok(t.call(t.u('OW'), 'public.get_my_company_dashboard()') IS NULL, 'DASH OW preview null');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ③ لوحة الشركة: المدير كاملة، المشرف والموظف مختصرة بلا ضريبة/سجل/اشتراكات، العميل والطاقم والمعاينة null';
END $$;

-- ══ ④ صف الشركة عبر REST ═════════════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ok(t.rows(t.u('A1'), 'public.companies') = 0, 'ROW A1 لا يرى صف شركته');
  PERFORM t.ok(t.rows(t.u('B1'), 'public.companies') = 0, 'ROW B1');
  PERFORM t.ok(t.rows(t.u('AX'), 'public.companies') = 0, 'ROW banned');
  PERFORM t.ok(t.rows(t.u('AS'), 'public.companies') = 1
           AND t.rows(t.u('AS'), format('public.companies where id = %L', t.u('CA'))) = 1, 'ROW AS شركته فقط');
  PERFORM t.ok(t.rows(t.u('AS'), format('public.companies where id = %L', t.u('CB'))) = 0, 'ROW AS لا يرى B');
  PERFORM t.ok(t.rows(t.u('OA'), 'public.companies') = 1, 'ROW OA شركته');
  PERFORM t.ok(t.rows(t.u('PU'), 'public.companies') = 0, 'ROW PU');
  RAISE NOTICE 'PASS ④ صف companies: الفريق يرى شركته فقط، العملاء والفرد لا شيء';
END $$;

-- ══ ⑤ ربط الاشتراك بالشركة ═══════════════════════════════════════════════
BEGIN;
DO $$
DECLARE v_sub uuid := '5b000000-0000-4000-8000-0000000000a1';
BEGIN
  PERFORM t.ok(NOT t.call(t.u('A1'), format('public.link_subscription_to_my_company(%L::uuid)', v_sub))::boolean,
               'LINK A1 مرفوض');
  PERFORM t.ok((SELECT company_id FROM public.whatsapp_subscriptions WHERE id = v_sub) IS NULL, 'LINK A1 بلا أثر');
  -- المحفّز يحرس كل مسار: كتابة مباشرة بهوية العميل (كما تفعل دالة SECURITY DEFINER تنفّذ باسمه)
  PERFORM t.act(t.u('A1'));
  BEGIN
    UPDATE public.whatsapp_subscriptions SET company_id = t.u('CA') WHERE id = v_sub;
    RAISE EXCEPTION 'FAIL LINK trigger allowed customer';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- والموظف كذلك
  PERFORM t.act(t.u('AG'));
  BEGIN
    INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, company_id)
    VALUES (t.u('AG'), 'support', 'pending', 'monthly', now(), now() + interval '30 days', 30, t.u('CA'));
    RAISE EXCEPTION 'FAIL LINK trigger allowed agent';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- عبر شركة أخرى: الرسالة القائمة كما هي
  PERFORM t.act(t.u('OA'));
  BEGIN
    UPDATE public.whatsapp_subscriptions SET company_id = t.u('CB') WHERE id = v_sub;
    RAISE EXCEPTION 'FAIL LINK cross-company';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  PERFORM t.act(null);
  RAISE NOTICE 'PASS ⑤ ربط الاشتراك: العميل والموظف مرفوضان بالدالة وبالمحفّز، وعبر الشركات مرفوض';
END $$;
ROLLBACK;
BEGIN;
DO $$
DECLARE v_sub uuid;
BEGIN
  INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days)
  VALUES (t.u('OA'), 'whatsapp', 'active', 'monthly', now(), now() + interval '30 days', 30) RETURNING id INTO v_sub;
  PERFORM t.ok(t.call(t.u('OA'), format('public.link_subscription_to_my_company(%L::uuid)', v_sub))::boolean, 'LINK OA ok');
  PERFORM t.ok((SELECT company_id FROM public.whatsapp_subscriptions WHERE id = v_sub) = t.u('CA'), 'LINK OA linked');
  RAISE NOTICE 'PASS ⑤ب مدير الشركة يربط اشتراكه بشركته كما كان';
END $$;
ROLLBACK;

-- ══ ⑥ رموز API وسجلات استخدامها ══════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ok(t.rows(t.u('OA'), format('public.api_tokens where user_id = %L', t.u('A1'))) = 0, 'TOK OA لا يرى رمز عميله');
  PERFORM t.ok(t.rows(t.u('A1'), 'public.api_tokens') = 1, 'TOK A1 يرى رمزه فقط');
  PERFORM t.ok(t.rows(t.u('AS'), format('public.api_tokens where user_id = %L', t.u('A1'))) = 0, 'TOK supervisor');
  PERFORM t.ok(t.rows(t.u('A1'), format('public.api_tokens where user_id = %L', t.u('OA'))) = 0, 'TOK العميل لا يرى رموز الشركة');
  PERFORM t.ok(t.affected(t.u('OA'), format('update public.api_tokens set is_active = false where user_id = %L', t.u('A1'))) = 0,
               'TOK OA لا يوقف رمز عميله');
  PERFORM t.ok(t.affected(t.u('OA'), format('delete from public.api_tokens where user_id = %L', t.u('A1'))) = 0,
               'TOK OA لا يحذف رمز عميله');
  PERFORM t.ok(t.rows(t.u('OA'), format('public.api_token_usage_logs where user_id = %L', t.u('A1'))) = 0, 'TOK OA لا يرى IP عميله');
  PERFORM t.ok(t.rows(t.u('A1'), 'public.api_token_usage_logs') = 1, 'TOK A1 يرى سجله');
  PERFORM t.ok(t.rows(t.u('AD'), 'public.api_tokens') = 2, 'TOK أمن المنصة (is_admin) كما كان');
  PERFORM t.ok(NOT t.call(t.u('OA'), format('public.is_owner_or_super_of(%L::uuid)', t.u('A1')))::boolean
           AND t.call(t.u('A1'), format('public.is_owner_or_super_of(%L::uuid)', t.u('A1')))::boolean
           AND NOT t.call(t.u('A1'), 'public.is_owner_or_super_of(null)')::boolean, 'TOK is_owner_or_super_of = صاحب الصف');
  -- لا عمود سرّ خام: الجدول يحمل البصمة وآخر أربع خانات فقط
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                             AND table_name = 'api_tokens' AND column_name IN ('secret', 'api_secret', 'bearer_token')),
               'TOK لا عمود سرّ خام');
  RAISE NOTICE 'PASS ⑥ رموز API وسجلاتها لأصحابها: المالك والمشرف لا يرون ولا يوقفون ولا يحذفون رموز العملاء';
END $$;

-- ══ ⑦ التكاملات الشخصية ══════════════════════════════════════════════════
BEGIN;
DO $$
BEGIN
  PERFORM t.ok(t.rows(t.u('OA'), 'public.external_integrations where owner_scope = ''user''') = 0, 'INT OA');
  PERFORM t.ok(t.rows(t.u('AD'), 'public.external_integrations where owner_scope = ''user''') = 0, 'INT admin لا يرى الشخصي');
  PERFORM t.ok(t.rows(t.u('EA'), 'public.external_integrations where owner_scope = ''user''') = 0, 'INT elevated لا يرى الشخصي');
  PERFORM t.ok(t.rows(t.u('A1'), 'public.external_integrations') = 2, 'INT A1 يرى تكامله + تكامل المنصة');
  PERFORM t.ok(t.rows(t.u('OA'), 'public.external_integrations where owner_scope = ''platform''') = 1, 'INT المنصة للجميع قراءةً');
  PERFORM t.ok(t.rows(t.u('OA'), 'public.external_integration_models') = 0, 'INT OA لا يرى نماذج تكامل عميله');
  PERFORM t.ok(t.affected(t.u('OA'), 'update public.external_integrations set display_name = ''x'' where owner_scope = ''user''') = 0,
               'INT OA لا يعدّل');
  PERFORM t.ok(t.affected(t.u('AD'), 'update public.external_integrations set display_name = ''x'' where owner_scope = ''user''') = 0,
               'INT admin لا يعدّل الشخصي');
  PERFORM t.ok(t.affected(t.u('AD'), 'update public.external_integrations set display_name = ''منصة'' where owner_scope = ''platform''') = 1,
               'INT admin يدير تكامل المنصة');
  PERFORM t.ok(t.affected(t.u('A1'), 'update public.external_integrations set display_name = ''x'' where owner_scope = ''platform''') = 0,
               'INT العميل لا يعدّل تكامل المنصة');
  PERFORM t.ok(t.affected(t.u('A1'), 'update public.external_integrations set display_name = ''لي'' where owner_scope = ''user''') = 1,
               'INT A1 يعدّل تكامله');
  -- إنشاء تكامل باسم شخص آخر مرفوض، وباسمه مقبول
  PERFORM t.ok(t.exec(t.u('OA'), format($q$insert into public.external_integrations (owner_id, owner_scope, provider, display_name)
                                           values (%L, 'user', 'openai', 'باسم العميل')$q$, t.u('A1'))) = '42501', 'INT OA لا ينشئ باسم عميله');
  PERFORM t.ok(t.exec(t.u('A1'), format($q$insert into public.external_integrations (owner_id, owner_scope, provider, display_name)
                                           values (%L, 'user', 'openai', 'جديد')$q$, t.u('A1'))) = 'ok', 'INT A1 ينشئ لنفسه');
  PERFORM t.ok(t.exec(t.u('A1'), $q$insert into public.external_integrations (owner_id, owner_scope, provider, display_name)
                                    values (null, 'platform', 'openai', 'منصة مزيفة')$q$) = '42501', 'INT العميل لا ينشئ تكامل منصة');
  PERFORM t.ok(t.exec(t.u('OA'), format($q$insert into public.external_integration_models (integration_id, model_id, display_name)
                                           values (%L, 'evil', 'x')$q$, 'e0000000-0000-4000-8000-0000000000a1')) = '42501',
               'INT OA لا يضيف نموذجًا لتكامل عميله');
  RAISE NOTICE 'PASS ⑦ التكامل الشخصي وأسراره لصاحبه وحده (لا مالك الشركة ولا الإداري)، والإداري يدير تكاملات المنصة';
END $$;
ROLLBACK;

-- ══ ⑧ سجل النشاط ════════════════════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ok(t.rows(t.u('OA'), format('public.activity_logs where user_id = %L', t.u('A1'))) = 0, 'ACT OA');
  PERFORM t.ok(t.rows(t.u('AS'), format('public.activity_logs where user_id = %L', t.u('A1'))) = 0, 'ACT supervisor');
  PERFORM t.ok(t.rows(t.u('A1'), 'public.activity_logs') = 1, 'ACT A1 يرى نشاطه');
  PERFORM t.ok(t.rows(t.u('EA'), format('public.activity_logs where user_id = %L', t.u('A1'))) = 1, 'ACT أمن المنصة');
  RAISE NOTICE 'PASS ⑧ IP والجهاز والموقع: لصاحبها ولأمن المنصة، لا لمالك الشركة ولا لموظفيها';
END $$;

-- ══ ⑨ ملف العميل ونقاط المكافآت ══════════════════════════════════════════
BEGIN;
DO $$
BEGIN
  PERFORM t.ok(t.affected(t.u('OA'), format('update public.profiles set full_name = ''مغيَّر'' where id = %L', t.u('A1'))) = 0,
               'PROF OA لا يعدّل ملف عميله');
  PERFORM t.ok(t.affected(t.u('OA'), format('update public.profiles set points = 999999 where id = %L', t.u('A1'))) = 0,
               'PROF OA لا يعدّل نقاط عميله عبر REST');
  -- الحارس نفسه (طبقة ثانية): كتابة بهوية مالك الشركة بلا RLS
  PERFORM t.act(t.u('OA'));
  BEGIN
    UPDATE public.profiles SET points = 999999 WHERE id = t.u('A1');
    RAISE EXCEPTION 'FAIL PROF points guard';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM t.act(t.u('A1'));
  BEGIN
    UPDATE public.profiles SET points = 999999 WHERE id = t.u('A1');
    RAISE EXCEPTION 'FAIL PROF self points';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM t.act(null);
  PERFORM t.ok(t.affected(t.u('EA'), format('update public.profiles set points = 5 where id = %L', t.u('A1'))) = 1,
               'PROF الإدارة المرتفعة تعدّل النقاط كما كانت');
  PERFORM t.ok(t.affected(t.u('A1'), format('update public.profiles set full_name = ''اسمي'' where id = %L', t.u('A1'))) = 1,
               'PROF العميل يعدّل ملفه');
  -- فك الارتباط يبقى عبر الدالة الرسمية
  PERFORM t.ok(t.call(t.u('OA'), format('public.remove_company_member(%L::uuid)', t.u('A2'))) ->> 'removed' = 'true',
               'PROF remove_company_member كما كان');
  RAISE NOTICE 'PASS ⑨ ملف العميل ونقاطه: لا يعدّلهما مالك الشركة (RLS + الحارس)، والإزالة عبر الدالة الرسمية';
END $$;
ROLLBACK;

-- ══ ⑩ بوابة العميل ═══════════════════════════════════════════════════════
DO $$
DECLARE p jsonb;
BEGIN
  p := t.call(t.u('A1'), 'public.my_company_portal()');
  PERFORM t.ok(p #>> '{company,name}' = 'شركة أ' AND (p ->> 'preview')::boolean = false, 'PORTAL A1');
  PERFORM t.ok(NOT (p::text LIKE '%TAX%') AND NOT (p::text LIKE '%CR-%') AND NOT (p::text LIKE '%@company.test%'),
               'PORTAL الاسم فقط');
  PERFORM t.ok(t.call(t.u('B1'), 'public.my_company_portal()') #>> '{company,name}' = 'شركة ب', 'PORTAL B1');
  PERFORM t.ok(t.call(t.u('OA'), 'public.my_company_portal()') IS NULL, 'PORTAL OA null');
  PERFORM t.ok(t.call(t.u('AG'), 'public.my_company_portal()') IS NULL, 'PORTAL agent null');
  PERFORM t.ok(t.call(t.u('PU'), 'public.my_company_portal()') IS NULL, 'PORTAL PU null');
  PERFORM t.ok(t.call(t.u('OW'), 'public.my_company_portal()') IS NULL, 'PORTAL OW بلا معاينة null');
  PERFORM t.ctx('company_user_preview');
  p := t.call(t.u('OW'), 'public.my_company_portal()');
  PERFORM t.ok(p #>> '{company,name}' = 'شركة المالك' AND (p ->> 'preview')::boolean, 'PORTAL OW preview');
  PERFORM t.ctx(null);
  PERFORM t.ok(public.context_destination('company_user_preview') = '/portal/'
           AND public.context_destination('company_admin') = '/company-dashboard/', 'PORTAL destination');
  RAISE NOTICE 'PASS ⑩ بوابة العميل: اسم الشركة فقط لعميلها، ومنظور العضو لمالك المنصة يفتح البوابة';
END $$;

-- ══ ⑪ عدم المساس، إعادة التشغيل، التراجع، إعادة التطبيق ═════════════════════
DO $$
BEGIN
  PERFORM t.ok(t.fn_digest() = (SELECT v FROM t.saved WHERE k = 'fn'), 'KEEP functions');
  PERFORM t.ok(t.policy_digest() = (SELECT v FROM t.saved WHERE k = 'pol'), 'KEEP other policies');
  PERFORM t.ok(t.data_digest() = (SELECT v FROM t.saved WHERE k = 'data'), 'KEEP data');
  INSERT INTO t.saved VALUES ('after', t.changed_digest());
  RAISE NOTICE 'PASS ⑪ لا تغيير في 11 دالة قائمة ولا في أي سياسة أخرى ولا في أي صف';
END $$;
\i migrations/095_account_boundaries.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok(t.changed_digest() = (SELECT v FROM t.saved WHERE k = 'after'), 'RERUN identical');
  RAISE NOTICE 'PASS ⑪ب إعادة التشغيل لا تغيّر شيئًا';
END $$;
\i migrations/_rollback/095_account_boundaries.down.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok(t.changed_digest() = (SELECT v FROM t.saved WHERE k = 'changed'), 'ROLLBACK يعيد النصوص حرفيًا');
  PERFORM t.ok(to_regprocedure('public.my_account_kind()') IS NULL, 'ROLLBACK drops');
  -- والثغرات تعود — أي أن الاختبارات أعلاه تكشف غياب 095
  PERFORM t.ok(t.call(t.u('A1'), 'public.get_my_company_dashboard()') #>> '{company,tax_id}' = 'TAX-A', 'ROLLBACK leak back: dashboard');
  PERFORM t.ok(t.rows(t.u('OA'), format('public.api_tokens where user_id = %L', t.u('A1'))) = 1, 'ROLLBACK leak back: tokens');
  RAISE NOTICE 'PASS ⑪ج التراجع يعيد النصوص والسياسات حرفيًا (والثغرات تعود، فالاختبار يكشفها)';
END $$;
\i migrations/095_account_boundaries.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok(t.changed_digest() = (SELECT v FROM t.saved WHERE k = 'after'), 'REAPPLY identical');
  PERFORM t.ok(t.call(t.u('A1'), 'public.get_my_company_dashboard()') IS NULL, 'REAPPLY closed again');
  RAISE NOTICE 'PASS ⑪د إعادة التطبيق بعد التراجع تعيد نفس الحالة';
END $$;

SELECT 'ALL account-boundaries tests passed';
