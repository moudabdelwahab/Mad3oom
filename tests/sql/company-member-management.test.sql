-- ============================================================================
-- 113_company_member_management — إدارة أعضاء الشركة
--
-- على نسخة مطابقة للإنتاج (لقطة المخطط + 094→112 بترتيب الإنتاج) ثم 113. بيانات اصطناعية فقط.
--   ① الكائنات والصلاحيات، والتراجع حرفيًا قبل الاستعمال ثم إعادة التطبيق
--   ② ملف العضو لدى الشركة وتفاصيله: للمدير وحده، تذاكر هذه الشركة وحدها، ولا كاشف لشركة أخرى
--   ③ تعديل الحساب: لحساب أنشأته الشركة ومرتبط بها وحدها؛ الفحص تحت الجلسة والتنفيذ لمفتاح الخدمة
--   ④ رابط إعادة كلمة المرور: الفحص والحد والسجل
--   ⑤ الإيقاف المؤقت وإعادة التفعيل: الوصول يسقط ويعود، ودور الفريق يعود
--   ⑥ طلب النقل وقرار مالك المنصة: بمحرك 101، بخطوتين، بلا كاشف للوجهة
--   ⑦ رفض التراجع بعد الاستعمال
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
SET search_path = public, extensions;

UPDATE auth.users SET email_confirmed_at = now() - interval '30 days';

-- نداء بمفتاح الخدمة كما تفعل دالة Edge (دور service_role، بلا مستخدم)
CREATE FUNCTION t.svcj(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'set local role service_role';
  EXECUTE 'select to_jsonb((' || p_sql || '))' INTO v;
  EXECUTE 'reset role';
  RETURN v;
EXCEPTION WHEN OTHERS THEN
  EXECUTE 'reset role';
  RAISE;
END $$;
CREATE FUNCTION t.svc_err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN PERFORM t.svcj(p_sql); RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN sqlstate; END $$;
CREATE FUNCTION t.own(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN PERFORM t.ctx('owner'); PERFORM t.stepup(t.u('OW')); RETURN t.call(t.u('OW'), p_sql); END $$;
CREATE FUNCTION t.own_err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN PERFORM t.ctx('owner'); PERFORM t.stepup(t.u('OW')); RETURN t.err(t.u('OW'), p_sql); END $$;
CREATE FUNCTION t.mem(p_user text, p_company text) RETURNS text LANGUAGE sql AS $$
  select coalesce((select case when is_primary then 'primary' else 'secondary' end || ':' || status
                     from public.company_memberships where user_id = t.u(p_user) and company_id = t.u(p_company)
                     order by joined_at desc, id desc limit 1), 'none') $$;
CREATE FUNCTION t.cc(p text) RETURNS text LANGUAGE sql AS $$ select t.call(t.u(p), 'public.current_company_id()') #>> '{}' $$;
CREATE FUNCTION t.member_ids(p text) RETURNS text LANGUAGE sql AS $$
  select string_agg(x ->> 'id', ',' order by x ->> 'id') from jsonb_array_elements(t.call(t.u(p), 'public.company_members()') -> 'members') x $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

INSERT INTO t.saved VALUES ('schema0', t.schema_digest());

-- ══ ① الكائنات والصلاحيات والتراجع ═══════════════════════════════════════
\i migrations/113_company_member_management.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok(NOT has_table_privilege('authenticated', 'public.company_member_profiles', 'select')
           AND NOT has_table_privilege('authenticated', 'public.company_member_suspensions', 'select')
           AND NOT has_table_privilege('authenticated', 'public.company_member_account_changes', 'select')
           AND NOT has_table_privilege('authenticated', 'public.company_member_transfer_requests', 'select')
           AND NOT has_table_privilege('service_role', 'public.company_member_account_changes', 'select'), '① tables closed');
  PERFORM t.ok(NOT has_function_privilege('authenticated', 'public._company_member_account_apply(uuid,boolean,text)', 'execute')
           AND has_function_privilege('service_role', 'public._company_member_account_apply(uuid,boolean,text)', 'execute')
           AND NOT has_function_privilege('anon', 'public.company_member_details(uuid)', 'execute')
           AND NOT has_function_privilege('service_role', 'public.company_member_details(uuid)', 'execute')
           AND has_function_privilege('authenticated', 'public.company_member_details(uuid)', 'execute'), '① function grants');
  PERFORM t.ok(t.err(t.u('OA'), format('public._company_member_account_apply(%L::uuid, true, null)', gen_random_uuid())) = '42501',
               '① manager cannot apply');
  RAISE NOTICE 'PASS ① الجداول مغلقة، والدوال للجلسة إلا التنفيذ فلمفتاح الخدمة وحده';
END $$;
\i migrations/_rollback/113_company_member_management.down.sql
DO $$ BEGIN
  PERFORM t.ok(t.schema_digest() = (SELECT s.v FROM t.saved s WHERE s.k = 'schema0'), '①ب rollback byte-for-byte');
  RAISE NOTICE 'PASS ①ب التراجع قبل الاستعمال: المخطط حرفيًا كما قبل 113';
END $$;
\i migrations/113_company_member_management.sql
\i migrations/113_company_member_management.sql
SET search_path = public, extensions;

-- ══ ② ملف العضو وتفاصيله ════════════════════════════════════════════════
DO $$
DECLARE r jsonb; d jsonb;
BEGIN
  r := t.call(t.u('OA'), format('public.company_member_profile_save(%L::uuid, %L, %L, %L, %L)',
              t.u('A1'), ' أبو أحمد ', '0100 123 4567', 'مدير مشتريات', 'عميل منذ 2020'));
  PERFORM t.ok(r ->> 'changed' = 'true' AND r -> 'fields' = '["display_name","phone","job_title","notes"]', '② profile saved');
  PERFORM t.ok((SELECT display_name = 'أبو أحمد' AND phone = '+201001234567' FROM public.company_member_profiles
                 WHERE company_id = t.u('CA') AND user_id = t.u('A1')), '② trimmed + phone normalized');
  PERFORM t.ok((SELECT phone FROM public.profiles WHERE id = t.u('A1')) = '+201100000011', '② account phone untouched');
  PERFORM t.ok(t.call(t.u('OA'), format('public.company_member_profile_save(%L::uuid, %L, %L, %L, %L)',
              t.u('A1'), 'أبو أحمد', '+201001234567', 'مدير مشتريات', 'عميل منذ 2020')) ->> 'changed' = 'false', '② no-op');
  PERFORM t.ok((SELECT detail FROM public.company_membership_events WHERE action = 'member_profile_updated' AND user_id = t.u('A1'))
               = '{"fields":["display_name","phone","job_title","notes"]}', '② event has field names only');
  PERFORM t.ok(t.err(t.u('OA'), format('public.company_member_profile_save(%L::uuid, null, %L, null, null)', t.u('A1'), 'abc')) = '22023', '② bad phone');
  PERFORM t.ok(t.err(t.u('OA'), format('public.company_member_profile_save(%L::uuid, %L, null, null, null)', t.u('A1'), repeat('x', 121))) = '22023', '② too long');
  -- غير المدير والشركة الأخرى: نفس الخطأ للعضو الغريب وغير الموجود
  PERFORM t.ok(t.err(t.u('A1'), format('public.company_member_details(%L::uuid)', t.u('A2'))) = '42501', '② customer no');
  PERFORM t.ok(t.err(t.u('AS'), format('public.company_member_details(%L::uuid)', t.u('A2'))) = '42501', '② supervisor no');
  PERFORM t.ok(t.err(t.u('AD'), format('public.company_member_details(%L::uuid)', t.u('A2'))) = '42501', '② platform staff no');
  PERFORM t.ok(t.errfull(t.u('OB'), format('public.company_member_details(%L::uuid)', t.u('A1')))
               = t.errfull(t.u('OB'), format('public.company_member_details(%L::uuid)', t.u('NOPE'))), '② other company = unknown');
  PERFORM t.ok(t.err(t.u('OB'), format('public.company_member_details(%L::uuid)', t.u('A1'))) = 'P0002', '② other company P0002');
  PERFORM t.ok(t.err(t.u('OB'), format('public.company_member_profile_save(%L::uuid, %L, null, null, null)', t.u('A1'), 'x')) = 'P0002', '② other company save');
  PERFORM t.ok(t.err(t.u('OA'), format('public.company_member_details(%L::uuid)', t.u('OA'))) = 'P0002', '② owner is not a member');

  d := t.call(t.u('OA'), format('public.company_member_details(%L::uuid)', t.u('A1')));
  PERFORM t.ok(d ->> 'state' = 'active' AND d #>> '{account,email}' = 'a1@tenancy.test'
           AND d #>> '{company_profile,display_name}' = 'أبو أحمد' AND d ->> 'staff_role' IS NULL
           AND d #>> '{membership,joined_via}' = 'backfill' AND NOT (d -> 'membership' ? 'is_primary'), '② details');
  -- تذاكر هذه الشركة وحدها: TA1 (شركة أ) نعم، TA1S (فوترة أ1 مع مدعوم) لا
  PERFORM t.ok((d #>> '{tickets,total}')::int = 1 AND d #>> '{tickets,recent,0,id}' = t.k('TA1')::text, '② tickets: this company only');
  PERFORM t.ok(d #>> '{account,editable}' = 'false' AND d #>> '{account,not_editable_reason}' = 'not_company_created', '② not company created');
  PERFORM t.ok(jsonb_array_length(d -> 'history') >= 1 AND d #>> '{history,0,action}' = 'member_profile_updated', '② history newest first');
  d := t.call(t.u('OA'), format('public.company_member_details(%L::uuid)', t.u('AS')));
  PERFORM t.ok(d ->> 'staff_role' = 'supervisor' AND d #>> '{transfer,blocked_reason}' = 'staff'
           AND (d #>> '{tickets,assigned_open}') IS NOT NULL, '② staff details');
  RAISE NOTICE 'PASS ② ملف الشركة للعضو لا يلمس حسابه، والتفاصيل للمدير وحده بتذاكر شركته وحدها، والشركة الأخرى = حساب غير موجود';
END $$;

-- ══ ③ تعديل حساب أنشأته الشركة ══════════════════════════════════════════
DO $$
DECLARE r jsonb; a jsonb; v_change uuid;
BEGIN
  PERFORM t.ok(t.errfull(t.u('OA'), format('public.company_member_account_check(%L::uuid, %L, null, %L)', t.u('A1'), 'اسم', 'a1@tenancy.test'))
               LIKE '42501|%|{"code": "not_editable", "reason": "not_company_created"}', '③ not company created');
  -- create-sub-user يضع العلامة (مفتاح الخدمة وحده)
  UPDATE auth.users SET raw_app_meta_data = '{"company_created": true}' WHERE id IN (t.u('A1'), t.u('A2'), t.u('AS'));
  PERFORM t.ok(t.call(t.u('OA'), format('public.company_member_account_check(%L::uuid, %L, %L, %L)',
               t.u('A1'), 'عميل أ1', '01100000011', 'a1@tenancy.test')) ->> 'changed' = 'false', '③ unchanged');
  PERFORM t.ok(t.errfull(t.u('OA'), format('public.company_member_account_check(%L::uuid, %L, %L, %L)', t.u('A1'), 'اسم جديد', '01100000011', 'A2@tenancy.test'))
               LIKE '23505|%email_unavailable%', '③ email taken');
  PERFORM t.ok(t.errfull(t.u('OA'), format('public.company_member_account_check(%L::uuid, %L, %L, %L)', t.u('A1'), 'اسم جديد', '01100000012', 'a1@tenancy.test'))
               LIKE '23505|%phone_unavailable%', '③ phone taken');
  PERFORM t.ok(t.err(t.u('OA'), format('public.company_member_account_check(%L::uuid, %L, null, %L)', t.u('A1'), 'x', 'a1@tenancy.test')) = '22023', '③ short name');
  PERFORM t.ok(t.err(t.u('OA'), format('public.company_member_account_check(%L::uuid, %L, null, %L)', t.u('A1'), 'اسم جديد', 'bad')) = '22023', '③ bad email');
  PERFORM t.ok(t.err(t.u('OB'), format('public.company_member_account_check(%L::uuid, %L, null, %L)', t.u('A1'), 'اسم جديد', 'z@x.test')) = 'P0002', '③ other company');
  PERFORM t.ok(t.err(t.u('AS'), format('public.company_member_account_check(%L::uuid, %L, null, %L)', t.u('A1'), 'اسم جديد', 'z@x.test')) = '42501', '③ supervisor');

  r := t.call(t.u('OA'), format('public.company_member_account_check(%L::uuid, %L, %L, %L)',
              t.u('A1'), 'عميل أ1 الجديد', '0100 999 8888', 'New.A1@Tenancy.test'));
  v_change := (r ->> 'change_id')::uuid;
  PERFORM t.ok(r ->> 'email' = 'new.a1@tenancy.test' AND r ->> 'old_email' = 'a1@tenancy.test' AND r ->> 'phone' = '+201009998888'
           AND r ->> 'email_changed' = 'true' AND r ->> 'name_changed' = 'true', '③ check result');
  PERFORM t.ok((SELECT status FROM public.company_member_account_changes WHERE id = v_change) = 'pending'
           AND (SELECT full_name FROM public.profiles WHERE id = t.u('A1')) = 'عميل أ1', '③ nothing changed yet');
  -- الجلسة لا تنفذ؛ مفتاح الخدمة وحده
  PERFORM t.ok(t.err(t.u('OA'), format('public._company_member_account_apply(%L::uuid, true, null)', v_change)) = '42501', '③ session cannot apply');
  -- ما تفعله دالة Edge: نظام الدخول أولًا (GoTrue يحدّث auth.users)، ثم التنفيذ
  UPDATE auth.users SET email = 'new.a1@tenancy.test', raw_user_meta_data = '{"full_name":"عميل أ1 الجديد"}' WHERE id = t.u('A1');
  a := t.svcj(format('public._company_member_account_apply(%L::uuid, true, null)', v_change));
  PERFORM t.ok(a ->> 'status' = 'applied' AND a -> 'fields' = '["full_name","phone","email"]', '③ applied');
  PERFORM t.ok((SELECT full_name = 'عميل أ1 الجديد' AND phone = '+201009998888' AND email = 'new.a1@tenancy.test'
                  FROM public.profiles WHERE id = t.u('A1')), '③ profile updated');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.notifications WHERE user_id = t.u('A1') AND title = 'تحديث بيانات حسابك'), '③ member notified');
  PERFORM t.ok((SELECT actor_id FROM public.company_membership_events WHERE action = 'member_account_updated' AND user_id = t.u('A1')) = t.u('OA'),
               '③ event actor = manager');
  PERFORM t.ok(t.svc_err(format('public._company_member_account_apply(%L::uuid, true, null)', v_change)) = 'P0002', '③ applied once');
  -- الجوال يوثّق الحساب في البوابة (account_verification_ok): يُعدَّل ولا يُحذف
  PERFORM t.ok(t.errfull(t.u('OA'), format('public.company_member_account_check(%L::uuid, %L, null, %L)', t.u('A1'), 'عميل أ1 الجديد', 'new.a1@tenancy.test'))
               LIKE '22023|%phone_required%', '③ phone cannot be cleared');
  -- فشل نظام الدخول يُسجَّل برمز، والطلب القديم ينتهي
  r := t.call(t.u('OA'), format('public.company_member_account_check(%L::uuid, %L, %L, %L)', t.u('A1'), 'اسم ثالث', '+201009998888', 'new.a1@tenancy.test'));
  PERFORM t.ok(t.svcj(format('public._company_member_account_apply(%L::uuid, false, %L)', r ->> 'change_id', 'Some Error!')) ->> 'error'
               = 'auth_update_failed', '③ failure code sanitized');
  r := t.call(t.u('OA'), format('public.company_member_account_check(%L::uuid, %L, %L, %L)', t.u('A1'), 'اسم ثالث', '+201009998888', 'new.a1@tenancy.test'));
  UPDATE public.company_member_account_changes SET requested_at = now() - interval '11 minutes' WHERE id = (r ->> 'change_id')::uuid;
  PERFORM t.ok(t.svcj(format('public._company_member_account_apply(%L::uuid, true, null)', r ->> 'change_id')) ->> 'status' = 'expired', '③ stale');

  -- مرتبط بجهة أخرى: A2 عضو في ب أيضًا (دعوة) ⇒ ليس حصريًا للشركة أ، وب لا تعدّله لأنه لم يُنشأ فيها
  UPDATE public.platform_feature_switches SET enabled = true WHERE key = 'multi_company_memberships_enabled';
  PERFORM t.call(t.u('OB'), 'public.company_invite_customer(''a2@tenancy.test'')');
  PERFORM t.call(t.u('A2'), format('public.company_invitation_respond(%L::uuid, true)',
                 (SELECT id FROM public.company_membership_invitations WHERE invited_email = 'a2@tenancy.test' AND status = 'pending')));
  PERFORM t.ok(t.mem('A2', 'CB') = 'secondary:active', '③ A2 joined B');
  PERFORM t.ok(t.call(t.u('OA'), format('public.company_member_details(%L::uuid)', t.u('A2'))) #>> '{account,not_editable_reason}' = 'not_exclusive', '③ A not exclusive');
  PERFORM t.ok(t.call(t.u('OB'), format('public.company_member_details(%L::uuid)', t.u('A2'))) #>> '{account,not_editable_reason}' = 'not_exclusive', '③ B not owner of account');
  PERFORM t.ok(t.err(t.u('OB'), format('public.company_member_account_check(%L::uuid, %L, null, %L)', t.u('A2'), 'اسم', 'a2@tenancy.test')) = '42501', '③ B cannot edit');
  -- ب ترى تذاكر A2 معها وحدها (لا شيء)
  PERFORM t.ok((t.call(t.u('OB'), format('public.company_member_details(%L::uuid)', t.u('A2'))) #>> '{tickets,total}')::int = 0, '③ B sees no A tickets');
  RAISE NOTICE 'PASS ③ تعديل الحساب لحساب أنشأته الشركة وحدها: فحص تحت الجلسة، تنفيذ لمفتاح الخدمة مرة واحدة، إشعار العضو، ولا كاشف';
END $$;

-- ══ ④ رابط إعادة كلمة المرور ════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  r := t.call(t.u('OA'), format('public.company_member_password_reset_check(%L::uuid)', t.u('A1')));
  PERFORM t.ok(r ->> 'email' = 'new.a1@tenancy.test' AND r ->> 'company_name' = 'شركة أ', '④ email for the link');
  PERFORM t.ok(t.errfull(t.u('OA'), format('public.company_member_password_reset_check(%L::uuid)', t.u('A1'))) LIKE '54000|%cooldown%', '④ cooldown');
  PERFORM t.ok(t.err(t.u('OB'), format('public.company_member_password_reset_check(%L::uuid)', t.u('A1'))) = 'P0002', '④ other company');
  PERFORM t.ok(t.err(t.u('A2'), format('public.company_member_password_reset_check(%L::uuid)', t.u('A1'))) = '42501', '④ customer');
  PERFORM t.ok(t.err(t.u('OA'), format('public.company_member_password_reset_check(%L::uuid)', t.u('AX'))) = '22023', '④ banned');
  PERFORM t.ok((SELECT count(*) FROM public.company_membership_events WHERE action = 'member_password_reset') = 1, '④ logged once');
  RAISE NOTICE 'PASS ④ رابط إعادة كلمة المرور: للمدير، لبريد العضو نفسه، بمهلة وحد، ومسجَّل';
END $$;

-- ══ ⑤ الإيقاف المؤقت وإعادة التفعيل ═════════════════════════════════════
DO $$
DECLARE r jsonb; d jsonb;
BEGIN
  PERFORM t.ok(t.cc('AS') = t.u('CA')::text AND t.call(t.u('AS'), 'public.company_staff_role()') #>> '{}' = 'supervisor', '⑤ before: supervisor of A');
  PERFORM t.ok(t.err(t.u('OA'), format('public.company_member_suspend(%L::uuid, %L)', t.u('AS'), 'قصير')) = '22023', '⑤ reason');
  PERFORM t.ok(t.err(t.u('OB'), format('public.company_member_suspend(%L::uuid, %L)', t.u('AS'), 'سبب الإيقاف المؤقت')) = 'P0002', '⑤ other company');
  PERFORM t.ok(t.err(t.u('AG'), format('public.company_member_suspend(%L::uuid, %L)', t.u('AS'), 'سبب الإيقاف المؤقت')) = '42501', '⑤ agent');
  r := t.call(t.u('OA'), format('public.company_member_suspend(%L::uuid, %L)', t.u('AS'), 'إجازة طويلة حتى نهاية الشهر'));
  PERFORM t.ok(r ->> 'suspended' = 'true' AND r ->> 'staff_revoked' = 'true', '⑤ suspended');
  PERFORM t.ok((SELECT end_cause FROM public.company_memberships WHERE user_id = t.u('AS') AND company_id = t.u('CA')) = 'suspended', '⑤ membership ended: suspended');
  PERFORM t.ok((SELECT super_user_id IS NULL AND role = 'user' FROM public.profiles WHERE id = t.u('AS')), '⑤ mirror cleared');
  PERFORM t.ok(t.call(t.u('AS'), 'public.company_staff_role()') IS NULL AND t.cc('AS') IS NULL, '⑤ access gone');
  PERFORM t.ok(position(t.u('AS')::text in t.member_ids('OA')) = 0, '⑤ not in members list');
  PERFORM t.ok(t.call(t.u('OA'), 'public.company_member_suspensions_list()') #>> '{0,user_id}' = t.u('AS')::text, '⑤ suspensions list');
  PERFORM t.ok(jsonb_array_length(t.call(t.u('OB'), 'public.company_member_suspensions_list()')) = 0, '⑤ B list empty');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.notifications WHERE user_id = t.u('AS') AND title = 'إيقاف عضويتك مؤقتًا'), '⑤ notified');
  -- موقوف: التفاصيل والملف نعم، تعديل الحساب والرابط والإيقاف الثاني لا
  d := t.call(t.u('OA'), format('public.company_member_details(%L::uuid)', t.u('AS')));
  PERFORM t.ok(d ->> 'state' = 'suspended' AND d #>> '{suspension,was_staff}' = 'true' AND d -> 'membership' = 'null'
           AND d #>> '{account,not_editable_reason}' = 'suspended', '⑤ details while suspended');
  PERFORM t.ok(t.err(t.u('OA'), format('public.company_member_profile_save(%L::uuid, %L, null, null, null)', t.u('AS'), 'مشرف')) = 'ok', '⑤ profile while suspended');
  PERFORM t.ok(t.err(t.u('OA'), format('public.company_member_password_reset_check(%L::uuid)', t.u('AS'))) = 'P0002', '⑤ no reset');
  PERFORM t.ok(t.err(t.u('OA'), format('public.company_member_suspend(%L::uuid, %L)', t.u('AS'), 'سبب الإيقاف المؤقت')) = 'P0002', '⑤ twice');
  PERFORM t.ok(t.err(t.u('OB'), format('public.company_member_reactivate(%L::uuid)', t.u('AS'))) = 'P0002', '⑤ B cannot reactivate');

  r := t.call(t.u('OA'), format('public.company_member_reactivate(%L::uuid)', t.u('AS')));
  PERFORM t.ok(r ->> 'reactivated' = 'true' AND r ->> 'primary' = 'true' AND r ->> 'staff_role' = 'supervisor', '⑤ reactivated');
  PERFORM t.ok(t.mem('AS', 'CA') = 'primary:active'
           AND (SELECT joined_via FROM public.company_memberships WHERE user_id = t.u('AS') AND status = 'active') = 'reactivated', '⑤ membership back');
  PERFORM t.ok((SELECT super_user_id = t.u('OA') AND role = 'company_user' FROM public.profiles WHERE id = t.u('AS')), '⑤ mirror back');
  PERFORM t.ok(t.cc('AS') = t.u('CA')::text AND t.call(t.u('AS'), 'public.company_staff_role()') #>> '{}' = 'supervisor', '⑤ access back');
  PERFORM t.ok(t.err(t.u('OA'), format('public.company_member_reactivate(%L::uuid)', t.u('AS'))) = 'P0002', '⑤ reactivate twice');
  PERFORM t.ok((SELECT status FROM public.company_member_suspensions WHERE user_id = t.u('AS')) = 'reactivated', '⑤ closed');

  -- عضوية إضافية (A2 في ب): الإيقاف لا يمس أساسيته في أ
  PERFORM t.call(t.u('OB'), format('public.company_member_suspend(%L::uuid, %L)', t.u('A2'), 'مراجعة حساب العميل'));
  PERFORM t.ok(t.mem('A2', 'CB') = 'secondary:ended' AND t.mem('A2', 'CA') = 'primary:active', '⑤ secondary only');
  -- عاد بدعوة أثناء الإيقاف: الإيقاف يُغلق بلا عضوية ثانية
  PERFORM t.call(t.u('OB'), 'public.company_invite_customer(''a2@tenancy.test'')');
  PERFORM t.call(t.u('A2'), format('public.company_invitation_respond(%L::uuid, true)',
                 (SELECT id FROM public.company_membership_invitations WHERE invited_email = 'a2@tenancy.test' AND status = 'pending')));
  PERFORM t.ok(t.call(t.u('OB'), format('public.company_member_reactivate(%L::uuid)', t.u('A2'))) ->> 'reason' = 'already_member', '⑤ superseded');
  PERFORM t.ok((SELECT count(*) FROM public.company_memberships WHERE user_id = t.u('A2') AND company_id = t.u('CB') AND status = 'active') = 1, '⑤ one membership');
  -- الحساب صار غير مؤهل أثناء الإيقاف
  PERFORM t.call(t.u('OA'), format('public.company_member_suspend(%L::uuid, %L)', t.u('AG'), 'إيقاف موظف الدعم مؤقتًا'));
  UPDATE public.profiles SET ban_status = 'banned' WHERE id = t.u('AG');
  PERFORM t.ok(t.errfull(t.u('OA'), format('public.company_member_reactivate(%L::uuid)', t.u('AG'))) LIKE '55000|%not_eligible%', '⑤ ineligible');
  UPDATE public.profiles SET ban_status = 'none' WHERE id = t.u('AG');
  r := t.call(t.u('OA'), format('public.company_member_reactivate(%L::uuid)', t.u('AG')));
  PERFORM t.ok(r ->> 'staff_role' = 'agent', '⑤ agent restored');
  RAISE NOTICE 'PASS ⑤ الإيقاف ينهي الوصول والدور ويحفظهما، وإعادة التفعيل تعيدهما؛ الإضافية وحدها تُمس؛ لا عضوية مكررة';
END $$;

-- ══ ⑥ طلب النقل وقرار مالك المنصة ═══════════════════════════════════════
DO $$
DECLARE r jsonb; k uuid := gen_random_uuid(); v_req uuid; v_req2 uuid; l jsonb;
BEGIN
  PERFORM t.ok(t.err(t.u('OA'), format('public.company_member_transfer_request(%L::uuid, %L, %L, gen_random_uuid())',
               t.u('A1'), 'CR-B-095', 'العميل انتقل لفرع الشركة ب')) = '0A000', '⑥ switches off');
  UPDATE public.platform_feature_switches SET enabled = true
   WHERE key IN ('customer_transfers_enabled', 'company_isolation_enforced', 'company_permissions_enabled');
  PERFORM t.ok(t.errfull(t.u('OA'), format('public.company_member_transfer_request(%L::uuid, %L, %L, gen_random_uuid())',
               t.u('AS'), 'CR-B-095', 'المشرف ينتقل للشركة ب')) LIKE '22023|%"staff"%', '⑥ staff first');
  PERFORM t.ok(t.err(t.u('OB'), format('public.company_member_transfer_request(%L::uuid, %L, %L, gen_random_uuid())',
               t.u('A1'), 'CR-A-095', 'نقل عميل ليس لنا أصلًا')) = 'P0002', '⑥ other company member');
  -- عضوية إضافية: لا نقل منها (رمز عام)
  PERFORM t.ok(t.errfull(t.u('OB'), format('public.company_member_transfer_request(%L::uuid, %L, %L, gen_random_uuid())',
               t.u('A2'), 'CR-W-095', 'نقل عميل لشركة أخرى')) LIKE '22023|%not_available%', '⑥ secondary');
  -- وجهة موجودة وغير موجودة: نفس الرد
  r := t.call(t.u('OA'), format('public.company_member_transfer_request(%L::uuid, %L, %L, %L::uuid)',
              t.u('A1'), 'CR-B-095', 'العميل انتقل لفرع الشركة ب', k));
  v_req := (r ->> 'request_id')::uuid;
  PERFORM t.ok(r ->> 'status' = 'pending' AND NOT (r ? 'to_company'), '⑥ requested');
  PERFORM t.ok((SELECT to_company FROM public.company_member_transfer_requests WHERE id = v_req) = t.u('CB'), '⑥ dest resolved server-side');
  PERFORM t.ok(t.call(t.u('OA'), format('public.company_member_transfer_request(%L::uuid, %L, %L, %L::uuid)',
               t.u('A1'), 'CR-B-095', 'العميل انتقل لفرع الشركة ب', k)) ->> 'replayed' = 'true', '⑥ idempotent');
  PERFORM t.ok(t.errfull(t.u('OA'), format('public.company_member_transfer_request(%L::uuid, %L, %L, gen_random_uuid())',
               t.u('A1'), 'CR-B-095', 'طلب ثانٍ لنفس العميل')) LIKE '23505|%pending_exists%', '⑥ one pending');
  r := t.call(t.u('OA'), format('public.company_member_transfer_request(%L::uuid, %L, %L, gen_random_uuid())',
              t.u('A2'), 'no-such-company', 'العميل يريد شركة غير موجودة'));
  v_req2 := (r ->> 'request_id')::uuid;
  PERFORM t.ok(r ->> 'status' = 'pending'
           AND (SELECT to_company FROM public.company_member_transfer_requests WHERE id = v_req2) IS NULL, '⑥ unknown dest same reply');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.notifications WHERE user_id = t.u('OW') AND title = 'طلب نقل عضو'
                          AND message NOT LIKE '%أ1%'), '⑥ owner notified generically');
  PERFORM t.ok(t.call(t.u('OA'), format('public.company_member_details(%L::uuid)', t.u('A1'))) #>> '{transfer,blocked_reason}' = 'pending', '⑥ details pending');
  -- الشركة ترى طلباتها وحدها، والوجهة كما كتبتها
  l := t.call(t.u('OA'), 'public.company_member_transfer_requests()');
  PERFORM t.ok(jsonb_array_length(l) = 2 AND NOT (l -> 0 ? 'to_company'), '⑥ company list');
  PERFORM t.ok(jsonb_array_length(t.call(t.u('OB'), 'public.company_member_transfer_requests()')) = 0, '⑥ B list empty');
  PERFORM t.ok(t.err(t.u('OB'), format('public.company_member_transfer_cancel(%L::uuid)', v_req)) = 'P0002', '⑥ B cannot cancel');

  -- مالك المنصة
  PERFORM t.ok(t.err(t.u('OA'), 'public.owner_member_transfer_requests(''pending'')') = '42501', '⑥ manager not owner');
  PERFORM t.ok(t.err(t.u('EA'), 'public.owner_member_transfer_requests(''pending'')') = '42501', '⑥ elevated admin no');
  PERFORM t.ctx('owner');
  l := t.call(t.u('OW'), 'public.owner_member_transfer_requests(''pending'')');
  PERFORM t.ok(jsonb_array_length(l) = 2 AND (SELECT x ->> 'to_company' FROM jsonb_array_elements(l) x WHERE x ->> 'id' = v_req::text) = 'شركة ب',
               '⑥ owner list');
  -- الموافقة بلا خطوتين مرفوضة، والرفض بسبب قصير مرفوض
  DELETE FROM public.privileged_step_ups WHERE user_id = t.u('OW');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_decide_member_transfer(%L::uuid, true, %L)', v_req, 'موافقة على نقل العميل بعد التحقق')) = '42501', '⑥ step-up');
  PERFORM t.ok(t.own_err(format('public.owner_decide_member_transfer(%L::uuid, false, %L)', v_req, 'لا')) = '22023', '⑥ reject reason');
  -- سبب الموافقة 20 حرفًا (101)
  PERFORM t.ok(t.own_err(format('public.owner_decide_member_transfer(%L::uuid, true, %L)', v_req, 'موافقة قصيرة')) = '22023', '⑥ approve reason');
  PERFORM t.ok(t.mem('A1', 'CA') = 'primary:active', '⑥ nothing moved on failure');
  r := t.own(format('public.owner_decide_member_transfer(%L::uuid, true, %L)', v_req, 'موافقة على نقل العميل بعد التحقق من الطلب'));
  PERFORM t.ok(r ->> 'status' = 'approved' AND r ->> 'transfer_id' IS NOT NULL, '⑥ approved');
  PERFORM t.ok(t.mem('A1', 'CA') = 'primary:ended' AND t.mem('A1', 'CB') = 'primary:active'
           AND (SELECT super_user_id FROM public.profiles WHERE id = t.u('A1')) = t.u('OB'), '⑥ moved');
  PERFORM t.ok((SELECT status FROM public.customer_transfers WHERE id = (r ->> 'transfer_id')::uuid) = 'completed', '⑥ via 101 engine');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.notifications WHERE user_id = t.u('OA') AND title = 'اكتمل نقل عضو'), '⑥ company notified');
  PERFORM t.ok(t.err(t.u('OA'), format('public.company_member_details(%L::uuid)', t.u('A1'))) = 'P0002', '⑥ A lost the member');
  PERFORM t.ok(t.own_err(format('public.owner_decide_member_transfer(%L::uuid, true, %L)', v_req, 'موافقة مكررة على نفس الطلب تمامًا')) = 'P0002', '⑥ once');
  -- الوجهة غير المحلولة: لا موافقة بلا تصحيح، والتصحيح ببريد الشركة
  PERFORM t.ok(t.own_err(format('public.owner_decide_member_transfer(%L::uuid, true, %L)', v_req2, 'موافقة على نقل العميل بعد التحقق من الطلب')) = 'P0002', '⑥ unresolved');
  PERFORM t.ok(t.own_err(format('public.owner_decide_member_transfer(%L::uuid, true, %L, %L)', v_req2, 'موافقة على نقل العميل بعد التحقق من الطلب', 'A@Company.test')) = 'P0002', '⑥ same company');
  r := t.own(format('public.owner_decide_member_transfer(%L::uuid, false, %L)', v_req2, 'الشركة الوجهة غير معروفة'));
  PERFORM t.ok(r ->> 'status' = 'rejected'
           AND t.call(t.u('OA'), 'public.company_member_transfer_requests()') @> jsonb_build_array(jsonb_build_object('id', v_req2, 'status', 'rejected', 'decision_reason', 'الشركة الوجهة غير معروفة')),
               '⑥ rejected visible to company');
  -- الشركة تلغي طلبها
  r := t.call(t.u('OB'), format('public.company_member_transfer_request(%L::uuid, %L, %L, gen_random_uuid())',
              t.u('B1'), 'w@company.test', 'العميل يفضّل شركة المالك'));
  PERFORM t.ok(t.call(t.u('OB'), format('public.company_member_transfer_cancel(%L::uuid)', r ->> 'request_id')) ->> 'status' = 'cancelled', '⑥ cancel');
  PERFORM t.ok(t.own_err(format('public.owner_decide_member_transfer(%L::uuid, true, %L)', r ->> 'request_id', 'موافقة على نقل العميل بعد التحقق من الطلب')) = 'P0002', '⑥ cancelled not decidable');
  -- الإيقاف يلغي طلب النقل المعلّق
  r := t.call(t.u('OB'), format('public.company_member_transfer_request(%L::uuid, %L, %L, gen_random_uuid())',
              t.u('B1'), 'w@company.test', 'العميل يفضّل شركة المالك'));
  PERFORM t.call(t.u('OB'), format('public.company_member_suspend(%L::uuid, %L)', t.u('B1'), 'مراجعة قبل النقل'));
  PERFORM t.ok((SELECT status FROM public.company_member_transfer_requests WHERE id = (r ->> 'request_id')::uuid) = 'cancelled', '⑥ suspend cancels');
  -- انتهاء المدة
  PERFORM t.call(t.u('OB'), format('public.company_member_reactivate(%L::uuid)', t.u('B1')));
  r := t.call(t.u('OB'), format('public.company_member_transfer_request(%L::uuid, %L, %L, gen_random_uuid())',
              t.u('B1'), 'w@company.test', 'العميل يفضّل شركة المالك'));
  UPDATE public.company_member_transfer_requests SET expires_at = now() - interval '1 minute' WHERE id = (r ->> 'request_id')::uuid;
  PERFORM t.ok(t.own_err(format('public.owner_decide_member_transfer(%L::uuid, true, %L)', r ->> 'request_id', 'موافقة على نقل العميل بعد التحقق من الطلب')) = 'P0002', '⑥ expired');
  -- القرار المرفوض يتراجع بكامله؛ أي قراءة تالية تسجّل الانتهاء
  PERFORM t.call(t.u('OB'), 'public.company_member_transfer_requests()');
  PERFORM t.ok((SELECT status FROM public.company_member_transfer_requests WHERE id = (r ->> 'request_id')::uuid) = 'expired', '⑥ expired status');
  PERFORM t.ok(t.err_super_ok('delete from public.company_member_transfer_requests') = '55000', '⑥ history immutable');
  RAISE NOTICE 'PASS ⑥ النقل: تطلبه الشركة، يقرره المالك بخطوتين وبسبب، ينفذه محرك 101، والوجهة لا تُكشف للشركة';
END $$;

-- ══ ⑦ رفض التراجع بعد الاستعمال ═════════════════════════════════════════
\set rbsql `cat migrations/_rollback/113_company_member_management.down.sql`
SELECT set_config('t.rbsql', :'rbsql', false) IS NOT NULL;
DO $$
BEGIN
  BEGIN
    -- الملف معاملة واحدة؛ هنا يُنفَّذ داخل كتلة فرعية بلا begin/commit
    EXECUTE regexp_replace(current_setting('t.rbsql'), '^(begin|commit);$', '', 'gn');
    RAISE EXCEPTION 'FAIL ⑦ rollback allowed after use';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%مرفوض%' THEN RAISE; END IF;
  END;
  PERFORM t.ok(to_regprocedure('public.company_member_details(uuid)') IS NOT NULL
           AND to_regclass('public.company_member_suspensions') IS NOT NULL, '⑦ objects kept');
  RAISE NOTICE 'PASS ⑦ التراجع بعد الاستعمال مرفوض: الدوال والجداول والسجل باقية';
END $$;

SELECT 'ALL company-member-management tests passed';
