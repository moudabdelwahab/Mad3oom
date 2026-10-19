-- ============================================================================
-- جاهزية المرحلة 1 (docs/tenancy/PHASE1_READINESS_2026-10-20.md) على نسخة مطابقة للإنتاج حتى 107، ثم 108.
-- المفاتيح الأربعة: company_permissions_enabled · company_isolation_enforced · data_access_grants_enabled ·
-- company_suspension_enforced — تُفعَّل كلها معًا بالمسار الحقيقي (owner_set_feature_switch بتحقق خطوتين).
--   ⓪ قبل 108: الخللان مُثبتان (منحة سارية بعد خفض الدور؛ evaluate_customer_badges لحساب آخر)
--   ① 108 والتراجع حرفيًا وإعادة التطبيق مرتين
--   ② التفعيل بالترتيب الآمن عبر المالك وحده، وكل تغيير مسجَّل
--   ③ مصفوفة عبر الشركات: تذاكر وردود ومرفقات وإشعارات واشتراكات وحسابات وعضويات وسياق MCP
--   ④ موظف أُزيل من الفريق، وعضو أُزيل من الشركة
--   ⑤ صلاحيات الفريق (098) مطفأة/مفعّلة مع العزل
--   ⑥ منح الوصول: الطلب والقرار والقراءة المسجَّلة والنطاق والانتهاء والإلغاء والخفض (108) والإطفاء
--   ⑦ الإيقاف: من يوقف، وما تفقده الشركة، والإطفاء يعيد الامتيازات، وإعادة التفعيل
--   ⑧ evaluate_customer_badges بعد 108
--   ⑨ الإطفاء بالمسار نفسه ممكن والسلوك يعود (لا نقل ولا نسخ ولا طلب حساب معتمد)
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
SET search_path = public, extensions;
CREATE FUNCTION t.j(p text, p_sql text) RETURNS jsonb LANGUAGE sql AS $$ select t.call(t.u(p), p_sql) $$;
CREATE FUNCTION t.b(p text, p_sql text) RETURNS boolean LANGUAGE sql AS $$ select (t.call(t.u(p), p_sql) #>> '{}')::boolean $$;
CREATE FUNCTION t.e(p text, p_sql text) RETURNS text LANGUAGE sql AS $$ select t.err(t.u(p), p_sql) $$;
-- تبديل مفتاح بالمسار الحقيقي: مالك المنصة بسياق المالك وتحقق خطوتين حديث
CREATE FUNCTION t.owner_sw(p_key text, p_on boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  r := t.call(t.u('OW'), format('public.owner_set_feature_switch(%L, %L, %L)', p_key, p_on, 'مراجعة جاهزية المرحلة 1'));
  PERFORM t.ctx(null);
  RETURN r;
END $$;
CREATE FUNCTION t.owner_call(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  r := t.call(t.u('OW'), p_sql);
  PERFORM t.ctx(null);
  RETURN r;
END $$;
-- صفر صفوف، أو الجدول مغلق أصلًا أمام الدور (42501): كلاهما «لا عبور»
CREATE FUNCTION t.none(p text, p_from_where text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  RETURN t.rows(t.u(p), p_from_where) = 0;
EXCEPTION WHEN insufficient_privilege THEN
  RETURN true;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- بيانات إضافية: إشعار شخصي لعميل أ1، واشتراك شخصي له، وشارة تُكتسب بتذكرة واحدة
INSERT INTO public.notifications (user_id, title, message, type) VALUES (t.u('A1'), 'إشعار أ1 الشخصي', 'خاص', 'info');
INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days)
VALUES (t.u('A1'), 'whatsapp', 'active', 'monthly', now() - interval '1 day', now() + interval '29 days', 30);
INSERT INTO public.badge_definitions (key, name, description, icon, criteria_type, criteria_value, is_active)
VALUES ('p1_first_ticket', 'أول تذكرة', 'فتحت أول تذكرة', '🎫', 'ticket_count', '{"count": 1}', true);
INSERT INTO t.saved VALUES ('schema107', t.schema_digest());

-- ══ ⓪ قبل 108 ═══════════════════════════════════════════════════════════════
DO $$
DECLARE g jsonb; n0 int;
BEGIN
  PERFORM t.sw('company_isolation_enforced', true);
  PERFORM t.sw('data_access_grants_enabled', true);
  PERFORM t.call(t.u('AD'), format('public.request_data_access(%L::uuid, null, %L, 2)', t.u('CA'), 'مراجعة شكوى عميل بطلب من المالك'));
  g := t.owner_call(format('public.owner_decide_access_request(%L::uuid, true, null, null)',
                           (SELECT id FROM public.data_access_requests WHERE requester_id = t.u('AD') ORDER BY created_at DESC LIMIT 1)));
  UPDATE public.profiles SET role = 'user' WHERE id = t.u('AD');
  PERFORM t.ok(t.e('AD', format('public.granted_company_tickets(%L::uuid)', g ->> 'grant_id')) = 'ok', 'PRE demoted ex-admin still reads via grant');
  UPDATE public.profiles SET role = 'admin' WHERE id = t.u('AD');
  PERFORM t.call(t.u('AD'), format('public.revoke_data_access_grant(%L::uuid, null)', g ->> 'grant_id'));
  -- الشارات: مالك أ يقيّم عميله أ1 فيمنحه شارة ويرسل له إشعارًا ويعرف النتيجة
  n0 := (SELECT count(*) FROM public.notifications WHERE user_id = t.u('A1'));
  PERFORM t.ok(t.j('OA', format('(select coalesce(jsonb_agg(badge_key), ''[]'') from public.evaluate_customer_badges(%L::uuid))', t.u('A1')))
               ? 'p1_first_ticket', 'PRE OA learns A1 badge');
  PERFORM t.ok((SELECT count(*) FROM public.notifications WHERE user_id = t.u('A1')) = n0 + 1, 'PRE notification sent to A1 by OA');
  DELETE FROM public.customer_badges WHERE user_id = t.u('A1');
  DELETE FROM public.notifications WHERE user_id = t.u('A1') AND title LIKE '%شارة جديدة%';
  PERFORM t.sw('data_access_grants_enabled', false);
  PERFORM t.sw('company_isolation_enforced', false);
  RAISE NOTICE 'PASS ⓪ قبل 108: منحة الوصول تُقرأ بعد خفض دور صاحبها، و evaluate_customer_badges لحساب آخر تمنح وتُشعر وتكشف';
END $$;
-- سجلات التدقيق إلحاقية (لا حذف): نعدّ من هنا
INSERT INTO t.saved VALUES ('audit0', (SELECT count(*) FROM public.privileged_audit WHERE action LIKE 'feature_switch.%')::text);
INSERT INTO t.saved VALUES ('schema107b', t.schema_digest());

-- ══ ① 108 ══════════════════════════════════════════════════════════════════
\i migrations/108_phase1_readiness_fixes.sql
\i migrations/_rollback/108_phase1_readiness_fixes.down.sql
DO $$ BEGIN
  PERFORM t.ok(t.schema_digest() = (SELECT v FROM t.saved WHERE k = 'schema107b'), 'RB schema byte-for-byte');
  RAISE NOTICE 'PASS ① التراجع عن 108: الدالتان حرفيًا كما في الإنتاج';
END $$;
\i migrations/108_phase1_readiness_fixes.sql
\i migrations/108_phase1_readiness_fixes.sql
SET search_path = public, extensions;

-- ══ ② التفعيل ══════════════════════════════════════════════════════════════
DO $$
DECLARE sw text;
BEGIN
  PERFORM t.ok(t.e('EA', 'public.owner_set_feature_switch(''company_permissions_enabled'', true, ''أدمن مرتفع يحاول'')') = '42501', 'SW elevated refused');
  UPDATE public.privileged_step_ups SET expires_at = now() - interval '1 second';
  PERFORM t.ctx('owner');
  PERFORM t.ok(t.e('OW', 'public.owner_set_feature_switch(''company_permissions_enabled'', true, ''بلا تحقق خطوتين'')') = '42501', 'SW owner without step-up refused');
  PERFORM t.ctx(null);
  FOREACH sw IN ARRAY array['company_permissions_enabled', 'company_isolation_enforced', 'data_access_grants_enabled', 'company_suspension_enforced'] LOOP
    PERFORM t.ok(t.owner_sw(sw, true) ->> 'enabled' = 'true', 'SW on ' || sw);
  END LOOP;
  PERFORM t.ok((SELECT count(*) FROM public.platform_feature_switches WHERE enabled) = 4, 'SW exactly four on');
  PERFORM t.ok((SELECT count(*) FROM public.privileged_audit WHERE action LIKE 'feature_switch.%')
               = (SELECT s.v::int FROM t.saved s WHERE s.k = 'audit0') + 4, 'SW four audit rows');
  PERFORM t.ok(public._isolation_on(), 'SW isolation on');
  RAISE NOTICE 'PASS ② التفعيل لمالك المنصة وحده بتحقق خطوتين، بالترتيب: الصلاحيات ← العزل ← منح الوصول ← الإيقاف؛ أربعة صفوف تدقيق';
END $$;

-- ══ ③ مصفوفة عبر الشركات (المفاتيح الأربعة مفعّلة) ═══════════════════════════
-- الرمز: t تذاكر، r ردود، a مرفقات، v نشاط، g تقييمات، l وسوم، o ملفات (t.vis)
DO $$
DECLARE missing uuid := '00000000-0000-4000-8000-0000000000ff';
BEGIN
  -- طاقم المنصة: تذاكر مدعوم فقط (TA1S TOA TAS TPU)، لا تذاكر شركة
  PERFORM t.ok(t.vis('AD') = 't4,r1,a1,v4,g1,l1,o1' AND t.vis('SUP') = 't4,r1,a1,v4,g1,l1,o1' AND t.vis('EA') = 't4,r1,a1,v4,g1,l1,o1', 'M staff support-only');
  PERFORM t.ok(NOT t.sees('AD', 'TA1') AND NOT t.sees('AD', 'TA2') AND NOT t.sees('SUP', 'TB1')
           AND t.sees('AD', 'TA1S') AND t.sees('AD', 'TOA') AND t.sees('AD', 'TAS') AND t.sees('AD', 'TPU'), 'M staff tickets');
  -- مالك الشركة أ: تذاكر شركته وتذكرته مع مدعوم فقط
  PERFORM t.ok(t.vis('OA') = 't3,r1,a1,v3,g1,l0,o1', 'M OA ' || t.vis('OA'));
  PERFORM t.ok(t.sees('OA', 'TA1') AND t.sees('OA', 'TA2') AND t.sees('OA', 'TOA')
           AND NOT t.sees('OA', 'TA1S') AND NOT t.sees('OA', 'TAS') AND NOT t.sees('OA', 'TB1') AND NOT t.sees('OA', 'TPU'), 'M OA tickets');
  -- مشرف أ (صلاحيات مفعّلة): تذاكر الشركة وتذكرته؛ موظف دعم أ: لا شيء غير مُسنَد
  PERFORM t.ok(t.sees('AS', 'TA1') AND t.sees('AS', 'TA2') AND t.sees('AS', 'TAS') AND NOT t.sees('AS', 'TA1S') AND NOT t.sees('AS', 'TB1'), 'M AS');
  PERFORM t.ok(t.vis('AG') = 't0,r0,a0,v0,g0,l0,o0', 'M AG nothing unassigned');
  -- الشركة ب كلها: TB1 وحدها
  PERFORM t.ok(t.vis('OB') = 't1,r1,a1,v1,g0,l0,o1' AND t.sees('OB', 'TB1') AND NOT t.sees('OB', 'TA1') AND NOT t.sees('OB', 'TA1S'), 'M OB');
  PERFORM t.ok(t.sees('BS', 'TB1') AND NOT t.sees('BS', 'TA1') AND NOT t.sees('BS', 'TA2'), 'M BS');
  -- العملاء: تذاكرهم وحدها (بالنطاقين)
  PERFORM t.ok(t.sees('A1', 'TA1') AND t.sees('A1', 'TA1S') AND NOT t.sees('A1', 'TA2') AND NOT t.sees('A1', 'TB1'), 'M A1');
  PERFORM t.ok(t.vis('A2') = 't1,r0,a0,v1,g0,l0,o0' AND t.sees('A2', 'TA2'), 'M A2');
  PERFORM t.ok(t.sees('B1', 'TB1') AND NOT t.sees('B1', 'TA1'), 'M B1');
  PERFORM t.ok(t.vis('PU') = 't1,r1,a1,v1,g1,l0,o1' AND t.sees('PU', 'TPU'), 'M PU');
  PERFORM t.ok(t.vis('AX') = 't0,r0,a0,v0,g0,l0,o0', 'M banned member nothing');
  -- الردود الداخلية لطاقم المنصة على TA1 (شركة) لا تظهر للشركة، ولا لطاقم المنصة (العزل)
  PERFORM t.ok(t.rows(t.u('OA'), format('public.ticket_replies where id = %L', t.k('RINT'))) = 0
           AND t.rows(t.u('AD'), format('public.ticket_replies where id = %L', t.k('RINT'))) = 0, 'M internal note hidden');
  -- دوال الامتياز (107): لا إغلاق ولا إعادة فتح ولا كاشف وجود عبر الشركات
  PERFORM t.ok(NOT t.b('OB', format('public.ticket_in_my_scope(%L::uuid)', t.k('TA1')))
           AND NOT t.b('OB', format('public.can_access_ticket(%L::uuid)', t.k('TA1')))
           AND NOT t.b('OA', format('public.ticket_in_my_scope(%L::uuid)', t.k('TA1S')))
           AND NOT t.b('OA', format('public.can_access_ticket(%L::uuid)', t.k('TB1')))
           AND NOT t.b('AS', format('public.ticket_in_my_scope(%L::uuid)', t.k('TB1')))
           AND NOT t.b('AD', format('public.can_access_ticket(%L::uuid)', t.k('TA1'))), 'M definer RPCs deny cross-tenant');
  PERFORM t.ok(t.e('OB', format('public.close_ticket_in_my_scope(%L::uuid)', t.k('TA1'))) = '42501'
           AND t.e('OB', format('public.close_ticket_in_my_scope(%L::uuid)', missing)) = '42501'
           AND t.e('OA', format('public.reopen_ticket_in_my_scope(%L::uuid)', t.k('TA1S'))) = '42501'
           AND t.e('OA', format('public.reopen_ticket_in_my_scope(%L::uuid)', missing)) = '42501', 'M no existence oracle');
  -- الكتابة عبر الشركات: صفر صفوف
  PERFORM t.ok(t.affected(t.u('OB'), format('update public.tickets set priority = ''low'' where id = %L', t.k('TA1'))) = 0
           AND t.affected(t.u('OA'), format('update public.tickets set priority = ''low'' where id = %L', t.k('TA1S'))) = 0, 'M no cross-tenant update');
  PERFORM t.ok(t.exec(t.u('OB'), format('insert into public.ticket_replies (ticket_id, user_id, message) values (%L, %L, ''رد'')', t.k('TA1'), t.u('OB'))) <> 'ok', 'M no cross-tenant reply');
  -- الإشعارات: لصاحبها وحده
  PERFORM t.ok(t.rows(t.u('A1'), format('public.notifications where user_id = %L', t.u('A1'))) >= 1
           AND t.rows(t.u('OA'), format('public.notifications where user_id = %L', t.u('A1'))) = 0
           AND t.rows(t.u('OB'), format('public.notifications where user_id = %L', t.u('A1'))) = 0
           AND t.rows(t.u('AS'), format('public.notifications where user_id = %L', t.u('A1'))) = 0, 'M notifications own only');
  -- الاشتراكات: صاحبها والإدارة؛ لا مالك الشركة لاشتراك عميله الشخصي، ولا شركة لأخرى
  PERFORM t.ok(t.rows(t.u('A1'), format('public.whatsapp_subscriptions where user_id = %L', t.u('A1'))) = 1
           AND t.rows(t.u('OA'), format('public.whatsapp_subscriptions where user_id = %L', t.u('A1'))) = 0
           AND t.rows(t.u('OB'), format('public.whatsapp_subscriptions where user_id = %L', t.u('OA'))) = 0
           AND t.rows(t.u('AS'), format('public.whatsapp_subscriptions where user_id = %L', t.u('OA'))) = 0, 'M subscriptions');
  -- الحسابات والعضويات والشركات: لا شيء من الشركة الأخرى
  PERFORM t.ok(t.rows(t.u('OB'), format('public.profiles where id in (%L, %L, %L)', t.u('A1'), t.u('AS'), t.u('OA'))) = 0
           AND t.rows(t.u('B1'), format('public.profiles where id = %L', t.u('A1'))) = 0
           AND t.rows(t.u('A1'), format('public.profiles where id = %L', t.u('B1'))) = 0, 'M profiles');
  PERFORM t.ok(t.none('OB', format('public.company_memberships where company_id = %L', t.u('CA')))
           AND t.none('A1', format('public.company_memberships where company_id = %L', t.u('CB')))
           AND t.none('AS', format('public.company_memberships where company_id = %L', t.u('CB')))
           AND t.none('OB', format('public.companies where id = %L', t.u('CA'))), 'M memberships/companies');
  -- سياق MCP (مفتاح الخدمة): الدالة لمفتاح الخدمة وحده، والفرق كما يجب
  PERFORM t.ok(t.e('OA', format('public.mcp_ticket_tenancy(%L::uuid)', t.u('OA'))) = '42501', 'M mcp tenancy not for users');
  PERFORM t.ok(public.mcp_ticket_tenancy(t.u('OA')) = jsonb_build_object('isolation_on', true, 'team_company_ids', jsonb_build_array(t.u('CA')))
           AND public.mcp_ticket_tenancy(t.u('AS')) -> 'team_company_ids' = jsonb_build_array(t.u('CA'))
           AND public.mcp_ticket_tenancy(t.u('OB')) -> 'team_company_ids' = jsonb_build_array(t.u('CB'))
           AND public.mcp_ticket_tenancy(t.u('A1')) -> 'team_company_ids' = '[]'::jsonb
           AND public.mcp_ticket_tenancy(t.u('AD')) -> 'team_company_ids' = '[]'::jsonb, 'M mcp tenancy context');
  RAISE NOTICE 'PASS ③ عبر الشركات: التذاكر والردود والمرفقات والملفات بالنطاق؛ الدوال بامتياز المالك ترفض بلا كاشف؛ لا كتابة عبر الشركات؛ الإشعارات والاشتراكات والحسابات والعضويات لا تعبر؛ سياق MCP صحيح';
END $$;

-- ══ ④ الإزالة ═══════════════════════════════════════════════════════════════
DO $$
BEGIN
  -- موظف أُزيل من فريق الشركة: يفقد تذاكر الشركة فورًا ويبقى له ما يملكه، وسياق MCP بلا شركة
  PERFORM t.ok(t.e('OA', format('public.company_staff_revoke(%L::uuid)', t.u('AS'))) = 'ok', 'RM revoke staff');
  PERFORM t.ok(NOT t.sees('AS', 'TA1') AND NOT t.sees('AS', 'TA2') AND t.sees('AS', 'TAS') AND t.vis('AS') = 't1,r0,a0,v1,g0,l0,o0', 'RM ex-staff loses company tickets');
  PERFORM t.ok(NOT t.b('AS', format('public.ticket_in_my_scope(%L::uuid)', t.k('TA1'))), 'RM ex-staff no scope');
  PERFORM t.ok(public.mcp_ticket_tenancy(t.u('AS')) -> 'team_company_ids' = '[]'::jsonb, 'RM ex-staff mcp context empty');
  -- عضو أُزيل من الشركة: يبقى له تذكرته، ولا يرى غيرها؛ وتذكرة الشركة المختومة تبقى للشركة (الختم ثابت، 097)
  PERFORM t.ok(t.e('OA', format('public.remove_company_member(%L::uuid)', t.u('A2'))) = 'ok', 'RM remove member');
  PERFORM t.ok(t.sees('A2', 'TA2') AND NOT t.sees('A2', 'TA1') AND t.sees('OA', 'TA2'), 'RM removed member keeps own; company keeps stamped');
  PERFORM t.ok(t.none('A2', format('public.notifications where user_id = %L', t.u('A1'))), 'RM removed member no cross data');
  RAISE NOTICE 'PASS ④ الإزالة: الموظف المُزال يفقد تذاكر الشركة وسياقها فورًا؛ العضو المُزال يبقى له تذكرته وحدها، وتذكرة الشركة المختومة تبقى للشركة';
END $$;

-- ══ ⑤ صلاحيات الفريق (098) مع العزل ═════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ok(t.sees('BS', 'TB1'), 'PERM on: supervisor B sees company ticket');
  PERFORM t.ok(t.owner_sw('company_permissions_enabled', false) ->> 'enabled' = 'false', 'PERM off via owner');
  PERFORM t.ok(NOT t.sees('BS', 'TB1') AND t.sees('OB', 'TB1') AND t.sees('B1', 'TB1'), 'PERM off: staff lose access, owner and customer keep');
  PERFORM t.ok(t.e('OB', format('public.company_set_role_permission(%L, %L, true)', 'agent', 'tickets.view_all')) = '0A000', 'PERM off: matrix writes refused');
  PERFORM t.ok(t.owner_sw('company_permissions_enabled', true) ->> 'enabled' = 'true', 'PERM on again');
  PERFORM t.ok(t.sees('BS', 'TB1') AND NOT t.sees('BS', 'TA1'), 'PERM on: back, still own company only');
  PERFORM t.ok(t.e('BS', format('public.company_ticket_set_status(%L::uuid, %L)', t.k('TA1'), 'resolved')) = 'P0002'
           AND t.e('OB', format('public.company_ticket_assign(%L::uuid, %L::uuid)', t.k('TA1'), t.u('BS'))) = 'P0002', 'PERM cross-company status/assign refused');
  RAISE NOTICE 'PASS ⑤ الصلاحيات: إطفاؤها يسحب وصول الموظفين فورًا ويبقي المالك والعميل، وإعادتها تعيده لشركتهم وحدها؛ لا تعديل ولا إسناد عبر الشركات';
END $$;

-- ══ ⑥ منح الوصول (بعد 108) ═══════════════════════════════════════════════════
DO $$
DECLARE g1 jsonb; g2 jsonb; req uuid; a0 int;
BEGIN
  -- من يطلب: الطاقم وحده
  PERFORM t.ok(t.e('OA', format('public.request_data_access(%L::uuid, null, %L, 2)', t.u('CB'), 'مالك شركة يحاول الوصول لشركة أخرى')) = '42501'
           AND t.e('PU', format('public.request_data_access(%L::uuid, null, %L, 2)', t.u('CA'), 'حساب فرد يحاول الوصول لبيانات شركة')) = '42501'
           AND t.e('BS', format('public.request_data_access(%L::uuid, null, %L, 2)', t.u('CA'), 'موظف شركة يحاول الوصول لشركة أخرى')) = '42501', 'GR non-staff cannot request');
  PERFORM t.call(t.u('AD'), format('public.request_data_access(%L::uuid, null, %L, 2)', t.u('CA'), 'مراجعة شكوى عميل بطلب من المالك'));
  req := (SELECT id FROM public.data_access_requests WHERE requester_id = t.u('AD') AND status = 'pending');
  -- لا وصول قبل القرار؛ القرار للمالك بتحقق خطوتين وحده
  PERFORM t.ok(NOT t.sees('AD', 'TA1'), 'GR pending no access');
  UPDATE public.privileged_step_ups SET expires_at = now() - interval '1 second';
  PERFORM t.ctx('owner');
  PERFORM t.ok(t.e('OW', format('public.owner_decide_access_request(%L::uuid, true, null, null)', req)) = '42501', 'GR decide without step-up refused');
  PERFORM t.ctx(null);
  PERFORM t.ok(t.e('EA', format('public.owner_decide_access_request(%L::uuid, true, null, null)', req)) = '42501', 'GR elevated cannot decide');
  g1 := t.owner_call(format('public.owner_decide_access_request(%L::uuid, true, null, null)', req));
  PERFORM t.ok(g1 ->> 'status' = 'approved' AND (g1 ->> 'hours')::int = 2, 'GR approved 2h');
  -- القراءة عبر المنحة وحدها، ضمن الشركة، ومسجَّلة؛ RLS لا تتغير
  a0 := (SELECT count(*) FROM public.company_access_audit WHERE grant_id = (g1 ->> 'grant_id')::uuid);
  PERFORM t.ok((SELECT array_agg(x ->> 'id' ORDER BY x ->> 'id') FROM jsonb_array_elements(t.j('AD', format('public.granted_company_tickets(%L::uuid)', g1 ->> 'grant_id'))) x)
               = (SELECT array_agg(id::text ORDER BY id::text) FROM public.tickets WHERE scope = 'company' AND company_id = t.u('CA')), 'GR lists company A tickets only');
  PERFORM t.ok(t.e('AD', format('public.granted_ticket_view(%L::uuid, %L::uuid)', g1 ->> 'grant_id', t.k('TB1'))) = 'P0002'
           AND t.e('AD', format('public.granted_ticket_view(%L::uuid, %L::uuid)', g1 ->> 'grant_id', t.k('TA1S'))) = 'P0002', 'GR other company / support ticket out of grant');
  PERFORM t.ok(NOT (t.j('AD', format('public.granted_ticket_view(%L::uuid, %L::uuid)', g1 ->> 'grant_id', t.k('TA1'))) -> 'replies')::text LIKE '%ملاحظة داخلية%', 'GR no internal notes');
  PERFORM t.ok((SELECT count(*) FROM public.company_access_audit WHERE grant_id = (g1 ->> 'grant_id')::uuid) = a0 + 2, 'GR each read audited');
  PERFORM t.ok(NOT t.sees('AD', 'TA1'), 'GR rls unchanged');
  PERFORM t.ok(t.e('SUP', format('public.granted_company_tickets(%L::uuid)', g1 ->> 'grant_id')) = '42501', 'GR other staff cannot use grant');
  -- الشفافية: الشركة أ ترى السجل، والشركة ب لا ترى شيئًا من أ
  PERFORM t.ok(jsonb_array_length(t.j('OA', 'public.company_access_log()')) >= 1 AND t.j('OB', 'public.company_access_log()') = '[]'::jsonb, 'GR company access log');
  -- 108: خفض الدور، ثم إيقاف حق النوع، يوقفان القراءة فورًا؛ والإعادة تعيدها ما دامت المنحة سارية
  UPDATE public.profiles SET role = 'user' WHERE id = t.u('AD');
  PERFORM t.ok(t.e('AD', format('public.granted_company_tickets(%L::uuid)', g1 ->> 'grant_id')) = '42501', 'GR demoted grantee refused (108)');
  UPDATE public.profiles SET role = 'admin' WHERE id = t.u('AD');
  UPDATE public.access_requester_rules SET may_request = false WHERE requester_kind = 'admin';
  PERFORM t.ok(t.e('AD', format('public.granted_company_tickets(%L::uuid)', g1 ->> 'grant_id')) = '42501', 'GR kind disabled refused (108)');
  UPDATE public.access_requester_rules SET may_request = true WHERE requester_kind = 'admin';
  PERFORM t.ok(t.e('AD', format('public.granted_company_tickets(%L::uuid)', g1 ->> 'grant_id')) = 'ok', 'GR eligible again');
  -- إطفاء المفتاح يوقف القراءة والطلبات؛ والمنحة تبقى غير ملغاة وتعود إن أُعيد المفتاح قبل انتهائها
  PERFORM t.owner_sw('data_access_grants_enabled', false);
  PERFORM t.ok(t.e('AD', format('public.granted_company_tickets(%L::uuid)', g1 ->> 'grant_id')) = '42501'
           AND t.e('SUP', format('public.request_data_access(%L::uuid, null, %L, 2)', t.u('CB'), 'مراجعة شكوى عميل بطلب من المالك')) = '0A000', 'GR switch off stops reads and requests');
  PERFORM t.owner_sw('data_access_grants_enabled', true);
  PERFORM t.ok(t.e('AD', format('public.granted_company_tickets(%L::uuid)', g1 ->> 'grant_id')) = 'ok', 'GR unrevoked grant usable again after re-enable');
  -- الانتهاء والإلغاء
  PERFORM t.call(t.u('AD'), format('public.revoke_data_access_grant(%L::uuid, null)', g1 ->> 'grant_id'));
  PERFORM t.ok(t.e('AD', format('public.granted_company_tickets(%L::uuid)', g1 ->> 'grant_id')) = '42501', 'GR revoked');
  PERFORM t.call(t.u('SUP'), format('public.request_data_access(%L::uuid, %L::uuid, %L, 1)', t.u('CB'), t.k('TB1'), 'متابعة شكوى ب1 بطلب من مالك المنصة'));
  g2 := t.owner_call(format('public.owner_decide_access_request(%L::uuid, true, null, null)',
                            (SELECT id FROM public.data_access_requests WHERE requester_id = t.u('SUP') AND status = 'pending')));
  PERFORM t.ok(jsonb_array_length(t.j('SUP', format('public.granted_company_tickets(%L::uuid)', g2 ->> 'grant_id'))) = 1, 'GR single-ticket grant');
  ALTER TABLE public.data_access_grants DISABLE TRIGGER USER;
  UPDATE public.data_access_grants SET starts_at = now() - interval '2 hours', expires_at = now() - interval '1 second' WHERE id = (g2 ->> 'grant_id')::uuid;
  ALTER TABLE public.data_access_grants ENABLE TRIGGER USER;
  PERFORM t.ok(t.e('SUP', format('public.granted_company_tickets(%L::uuid)', g2 ->> 'grant_id')) = '42501', 'GR expired');
  RAISE NOTICE 'PASS ⑥ منح الوصول: الطاقم وحده يطلب، والمالك وحده يقرر بتحقق خطوتين؛ القراءة ضمن الشركة والمنحة ومسجَّلة كل مرة وبلا ملاحظات داخلية؛ خفض الدور أو إيقاف حق النوع أو إطفاء المفتاح يوقفها فورًا؛ الإلغاء والانتهاء نافذان';
END $$;

-- ══ ⑦ الإيقاف ═══════════════════════════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ok(t.b('OB', 'public.company_has_feature(''sub_users'')') AND t.b('OA', 'public.company_has_feature(''sub_users'')'), 'SUSP baseline features');
  -- من يوقف: المالك بتحقق خطوتين وحده (التفويض مطفأ)؛ مالك الشركة لا يغيّر حالته
  PERFORM t.ok(t.e('EA', format('public.delegate_set_company_status(%L::uuid, %L, %L)', t.u('CB'), 'suspended', 'أدمن مرتفع بلا تفويض يحاول')) = 'P0002', 'SUSP elevated without delegation refused');
  PERFORM t.ok(t.exec(t.u('OB'), format('update public.companies set status = ''active'' where id = %L', t.u('CB'))) = 'ok'
           AND t.exec(t.u('OB'), format('update public.companies set status = ''suspended'' where id = %L', t.u('CB'))) = '42501', 'SUSP owner cannot change own status');
  PERFORM t.ok(t.owner_call(format('public.delegate_set_company_status(%L::uuid, %L, %L)', t.u('CB'), 'suspended', 'اختبار إيقاف الشركة ب')) ->> 'changed' = 'true', 'SUSP owner suspends B');
  -- ما تفقده: امتيازات الباقة (هنا sub_users) لشركة ب وحدها
  PERFORM t.ok(NOT t.b('OB', 'public.company_has_feature(''sub_users'')') AND t.b('OA', 'public.company_has_feature(''sub_users'')'), 'SUSP B loses features, A unaffected');
  PERFORM t.ok(t.e('OB', format('public.company_set_role_permission(%L, %L, true)', 'agent', 'tickets.view_all')) = '42501', 'SUSP B cannot manage team');
  -- ما لا تفقده (حدّ موثّق): الوصول إلى تذاكرها
  PERFORM t.ok(t.sees('OB', 'TB1') AND t.sees('BS', 'TB1'), 'SUSP limitation: ticket access unchanged');
  -- إطفاء الإنفاذ يعيد الامتيازات فورًا والحالة باقية؛ إعادته تعيد الإيقاف
  PERFORM t.owner_sw('company_suspension_enforced', false);
  PERFORM t.ok(t.b('OB', 'public.company_has_feature(''sub_users'')') AND (SELECT status FROM public.companies WHERE id = t.u('CB')) = 'suspended', 'SUSP off restores, status kept');
  PERFORM t.owner_sw('company_suspension_enforced', true);
  PERFORM t.ok(NOT t.b('OB', 'public.company_has_feature(''sub_users'')'), 'SUSP on again');
  PERFORM t.ok(t.owner_call(format('public.delegate_set_company_status(%L::uuid, %L, %L)', t.u('CB'), 'active', 'إعادة تفعيل بعد الاختبار')) ->> 'changed' = 'true'
           AND t.b('OB', 'public.company_has_feature(''sub_users'')'), 'SUSP owner reactivates');
  RAISE NOTICE 'PASS ⑦ الإيقاف: المالك وحده بتحقق خطوتين؛ الشركة الموقوفة تفقد امتيازات باقتها وإدارة فريقها لا غيرها؛ تبقى تذاكرها (حد موثّق)؛ الإطفاء يعيد الامتيازات وإعادة التفعيل للمالك';
END $$;

-- ══ ⑧ الشارات بعد 108 ═══════════════════════════════════════════════════════
DO $$
DECLARE n0 int;
BEGIN
  n0 := (SELECT count(*) FROM public.notifications WHERE user_id = t.u('A1'));
  PERFORM t.ok(t.j('OA', format('(select coalesce(jsonb_agg(badge_key), ''[]'') from public.evaluate_customer_badges(%L::uuid))', t.u('A1'))) = '[]'::jsonb, 'BADGE other user: empty');
  PERFORM t.ok((SELECT count(*) FROM public.notifications WHERE user_id = t.u('A1')) = n0
           AND NOT EXISTS (SELECT 1 FROM public.customer_badges WHERE user_id = t.u('A1')), 'BADGE other user: nothing written');
  PERFORM t.ok(t.j('A1', format('(select coalesce(jsonb_agg(badge_key), ''[]'') from public.evaluate_customer_badges(%L::uuid))', t.u('A1'))) ? 'p1_first_ticket', 'BADGE self works');
  DELETE FROM public.customer_badges WHERE user_id = t.u('A1');
  PERFORM t.ok(t.j('SUP', format('(select coalesce(jsonb_agg(badge_key), ''[]'') from public.evaluate_customer_badges(%L::uuid))', t.u('A1'))) ? 'p1_first_ticket', 'BADGE staff works');
  -- مسار المحفّز كما كان: تذكرة جديدة لحساب فرد تمنحه الشارة
  DELETE FROM public.customer_badges WHERE user_id = t.u('PU');
  PERFORM t.ok(t.exec(t.u('PU'), format('insert into public.tickets (user_id, title, description) values (%L, ''شارة بالمحفّز'', ''وصف'')', t.u('PU'))) = 'ok', 'BADGE trigger insert ok');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.customer_badges WHERE user_id = t.u('PU')), 'BADGE trigger path still awards');
  RAISE NOTICE 'PASS ⑧ الشارات: نداء مباشر لحساب آخر لا يكتب ولا يكشف؛ لنفسه ولطاقم المنصة وللمحفّزات كما كان';
END $$;

-- ══ ⑨ الإطفاء ══════════════════════════════════════════════════════════════
DO $$
DECLARE sw text;
BEGIN
  FOREACH sw IN ARRAY array['company_suspension_enforced', 'data_access_grants_enabled', 'company_isolation_enforced', 'company_permissions_enabled'] LOOP
    PERFORM t.ok(t.owner_sw(sw, false) ->> 'enabled' = 'false', 'OFF ' || sw);
  END LOOP;
  PERFORM t.ok((SELECT count(*) FROM public.platform_feature_switches WHERE enabled) = 0 AND NOT public._isolation_on(), 'OFF all off');
  PERFORM t.ok(t.sees('AD', 'TA1') AND NOT t.sees('BS', 'TB1'), 'OFF legacy visibility back');
  RAISE NOTICE 'PASS ⑨ الإطفاء بالمسار نفسه ممكن (لا نقل ولا نسخ ولا طلب حساب معتمد)، والسلوك القديم يعود فورًا';
END $$;

DO $$ BEGIN RAISE NOTICE 'ALL phase1-readiness tests passed'; END $$;
