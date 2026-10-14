-- ============================================================================
-- 096_company_memberships على نسخة مطابقة للإنتاج حتى 093 + 095
--
--   ⓪ قبل 096: بصمات + نتائج current_company_id/my_account_kind/my_company_portal/company_members لكل فاعل
--   ① 096: الكائنات، الصلاحيات، المفاتيح مطفأة، الملء الأولي، المرآة مطابقة
--   ② المفتاح مطفأ = نفس السلوك حرفيًا لكل فاعل
--   ③ المسارات القديمة تُترجم إلى عضويات (الإزالة، نقل الإدارة المرتفعة، create-sub-user، الموظف)
--   ④ التراجع ثم إعادة التطبيق (بلا بيانات إضافية)
--   ⑤ المفتاح مطفأ يغلق كل عملية جديدة؛ تفعيله لمالك المنصة وحده بتحقق خطوتين
--   ⑥ الدعوات: لا كشف لوجود الحساب، القبول لصاحبها وحده، أساسية أو إضافية
--   ⑦ العزل بين الشركات والسياق الذي يتحقق منه الخادم
--   ⑧ المغادرة وتعيين الأساسية
--   ⑨ حرّاس الجداول ورفض التراجع مع وجود بيانات
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

\i tests/fixtures/prod-shape/load.sql
\i tests/fixtures/prod-shape/chain-to-093.sql
-- 094 (PR #133، مدموج في main) يسبق 095 في الإنتاج
\i migrations/094_continuity_reminders.sql
SET search_path = public, extensions;
\i tests/fixtures/tenancy/harness.sql
\i migrations/095_account_boundaries.sql
SET search_path = public, extensions;
SET check_function_bodies = off;  -- المساعدات تشير إلى كائنات 096 قبل إنشائها

CREATE FUNCTION t.cc(p text) RETURNS text LANGUAGE sql AS $$ select t.call(t.u(p), 'public.current_company_id()') #>> '{}' $$;
CREATE FUNCTION t.kind(p text) RETURNS text LANGUAGE sql AS $$ select t.call(t.u(p), 'public.my_account_kind()') #>> '{}' $$;
CREATE FUNCTION t.sw(p_on boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  update public.platform_feature_switches set enabled = p_on where key = 'multi_company_memberships_enabled'; END $$;
CREATE FUNCTION t.mem(p_user text, p_company text) RETURNS text LANGUAGE sql AS $$
  select coalesce((select case when is_primary then 'primary' else 'secondary' end || ':' || status
                     from public.company_memberships where user_id = t.u(p_user) and company_id = t.u(p_company)
                     order by joined_at desc, id desc limit 1), 'none') $$;
CREATE FUNCTION t.sup(p_user text) RETURNS uuid LANGUAGE sql AS $$ select super_user_id from public.profiles where id = t.u(p_user) $$;
CREATE FUNCTION t.prole(p_user text) RETURNS text LANGUAGE sql AS $$ select role from public.profiles where id = t.u(p_user) $$;
-- تنفيذ بصلاحية المشرف العام (للحرّاس التي تعمل حتى لمن يتجاوز RLS): 'ok' أو SQLSTATE
CREATE FUNCTION t.err_super_ok(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE; END $$;
CREATE FUNCTION t.drift() RETURNS int LANGUAGE sql AS $$ select jsonb_array_length(public.membership_mirror_drift()) $$;
CREATE FUNCTION t.snapshot() RETURNS text LANGUAGE sql AS $$
  select string_agg(n || '=' || coalesce(t.cc(n), '-') || '/' || coalesce(t.kind(n), '-') || '/'
                    || coalesce(t.call(t.u(n), 'public.my_company_portal()') #>> '{company,name}', '-'), ',' order by n)
    from unnest(array['OW','EA','AD','SUP','PU','DG','OA','A1','A2','AS','AG','AX','OB','B1','BS']) n $$;
CREATE FUNCTION t.fn_digest() RETURNS text LANGUAGE sql AS $$
  select md5(string_agg(pg_get_functiondef(f::regprocedure), '#' order by f))
    from unnest(array['public.current_company_id()', 'public.my_account_kind()', 'public.my_company_portal()',
                      'public.company_members()', 'public.remove_company_member(uuid)', 'public.check_super_user_creation()',
                      'public._ihub_guard_customer_link()', 'public.ihub_customer_link(uuid,uuid,text)',
                      'public.ihub_intake_convert(uuid,uuid)']) f $$;
CREATE FUNCTION t.keep_digest() RETURNS text LANGUAGE sql AS $$
  select md5(string_agg(pg_get_functiondef(f::regprocedure), '#' order by f))
    from unnest(array['public.company_staff_role()', 'public._company_staff_role_of(uuid,uuid)', 'public.supervises(uuid)',
                      'public.company_of(uuid)', 'public.belongs_to_a_company(uuid)', 'public.sync_company_role()',
                      'public.get_my_company_dashboard()', 'public.ticket_in_my_scope(uuid)']) f $$;
CREATE FUNCTION t.policy_digest() RETURNS text LANGUAGE sql AS $$
  select md5(string_agg(concat_ws('|', tablename, policyname, permissive, cmd, qual, with_check), '#' order by tablename, policyname))
    from pg_policies where schemaname in ('public', 'storage')
     and tablename not in ('company_memberships', 'company_membership_invitations', 'customer_company_context',
                           'company_membership_events', 'platform_feature_switches') $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- مزوّد woocommerce مزروع في 088؛ نتأكد فقط
DO $$ BEGIN PERFORM t.ok(EXISTS (SELECT 1 FROM public.ihub_providers WHERE key = 'woocommerce'), 'SETUP provider'); END $$;

-- ══ ⓪ قبل 096 ═══════════════════════════════════════════════════════════
INSERT INTO t.saved VALUES ('snap', t.snapshot()), ('fn', t.fn_digest()), ('keep', t.keep_digest()), ('pol', t.policy_digest()),
  ('members_oa', (t.call(t.u('OA'), 'public.company_members()'))::text),
  ('members_a1', (t.call(t.u('A1'), 'public.company_members()'))::text),
  ('members_ob', (t.call(t.u('OB'), 'public.company_members()'))::text);
DO $$ BEGIN RAISE NOTICE 'PASS ⓪ قبل 096: لقطة لكل فاعل (الشركة، النوع، البوابة) وبصمات'; END $$;

-- ══ ① 096 ════════════════════════════════════════════════════════════════
\i migrations/096_company_memberships.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok((SELECT count(*) FROM public.platform_feature_switches) = 1
           AND NOT (SELECT enabled FROM public.platform_feature_switches WHERE key = 'multi_company_memberships_enabled'),
               'OBJ المفتاح موجود ومطفأ');
  PERFORM t.ok((SELECT count(*) FROM public.company_memberships WHERE status = 'active' AND is_primary) = 7
           AND (SELECT count(*) FROM public.company_memberships WHERE joined_via = 'backfill') = 7, 'OBJ ملء أولي: 7 تابعين');
  PERFORM t.ok(t.drift() = 0, 'OBJ المرآة مطابقة');
  PERFORM t.ok(NOT has_table_privilege('authenticated', 'public.company_memberships', 'select')
           AND NOT has_table_privilege('service_role', 'public.company_memberships', 'select')
           AND NOT has_table_privilege('authenticated', 'public.platform_feature_switches', 'select')
           AND NOT has_table_privilege('authenticated', 'public.company_membership_invitations', 'select'), 'OBJ لا صلاحيات مباشرة');
  PERFORM t.ok(NOT has_function_privilege('authenticated', 'public._membership_apply_mirror(uuid)', 'execute')
           AND NOT has_function_privilege('authenticated', 'public._feature_on(text)', 'execute')
           AND NOT has_function_privilege('authenticated', 'public._membership_end(uuid,text)', 'execute')
           AND NOT has_function_privilege('anon', 'public.company_invite_customer(text)', 'execute')
           AND has_function_privilege('authenticated', 'public.company_invite_customer(text)', 'execute'), 'OBJ دوال داخلية مغلقة');
  PERFORM t.ok(t.keep_digest() = (SELECT v FROM t.saved WHERE k = 'keep') AND t.policy_digest() = (SELECT v FROM t.saved WHERE k = 'pol'),
               'OBJ لا تغيير في 8 دوال قائمة ولا في أي سياسة قائمة');
  RAISE NOTICE 'PASS ① 096: جداول مغلقة، مفتاح مطفأ، 7 عضويات أساسية من المرآة، والمرآة مطابقة';
END $$;

-- ══ ② المفتاح مطفأ = نفس السلوك ═══════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ok(t.snapshot() = (SELECT v FROM t.saved WHERE k = 'snap'), 'SAME شركة ونوع وبوابة كل فاعل');
  PERFORM t.ok((t.call(t.u('OA'), 'public.company_members()'))::text = (SELECT v FROM t.saved WHERE k = 'members_oa'), 'SAME members OA');
  PERFORM t.ok((t.call(t.u('A1'), 'public.company_members()'))::text = (SELECT v FROM t.saved WHERE k = 'members_a1'), 'SAME members A1');
  PERFORM t.ok((t.call(t.u('OB'), 'public.company_members()'))::text = (SELECT v FROM t.saved WHERE k = 'members_ob'), 'SAME members OB');
  RAISE NOTICE 'PASS ② المفتاح مطفأ: الشركة الحالية ونوع الحساب والبوابة وقائمة الأعضاء مطابقة حرفيًا لما قبل 096 لكل الفاعلين';
END $$;

-- ══ ③ المسارات القديمة ═══════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE c uuid;
BEGIN
  -- ربط تكامل لعميل A1 لنرى فكّه
  INSERT INTO public.ihub_connections (id, company_id, provider, account_label, status, created_by)
  VALUES ('1c000000-0000-4000-8000-0000000000a1', t.u('CA'), 'woocommerce', 'متجر أ', 'active', t.u('OA'));
  INSERT INTO public.ihub_customer_links (company_id, connection_id, customer_id, external_customer_id, linked_by)
  VALUES (t.u('CA'), '1c000000-0000-4000-8000-0000000000a1', t.u('A1'), 'woo-1', t.u('OA'));
  -- (أ) إزالة عضو بالدالة الرسمية
  PERFORM t.call(t.u('OA'), format('public.remove_company_member(%L::uuid)', t.u('A2')));
  PERFORM t.ok(t.mem('A2', 'CA') = 'primary:ended' AND t.sup('A2') IS NULL AND t.prole('A2') = 'user', 'LEG remove');
  PERFORM t.ok((SELECT end_cause FROM public.company_memberships WHERE user_id = t.u('A2')) = 'removed', 'LEG remove cause');
  PERFORM t.ok(t.errfull(t.u('OA'), format('public.remove_company_member(%L::uuid)', t.u('A2'))) LIKE '42501|هذا الحساب ليس عضوًا في شركتك%',
               'LEG remove again same message');
  PERFORM t.ok(t.errfull(t.u('OA'), format('public.remove_company_member(%L::uuid)', t.u('B1'))) LIKE '42501|هذا الحساب ليس عضوًا في شركتك%',
               'LEG remove foreign same message');
  -- (ب) الإدارة المرتفعة تنقل A1 من A إلى B مباشرة
  PERFORM t.act(t.u('EA'));
  UPDATE public.profiles SET super_user_id = t.u('OB') WHERE id = t.u('A1');
  PERFORM t.act(null);
  PERFORM t.ok(t.mem('A1', 'CA') = 'primary:ended' AND t.mem('A1', 'CB') = 'primary:active' AND t.sup('A1') = t.u('OB'), 'LEG elevated move');
  PERFORM t.ok((SELECT end_cause FROM public.company_memberships WHERE user_id = t.u('A1') AND company_id = t.u('CA')) = 'transferred', 'LEG move cause');
  PERFORM t.ok((SELECT unlinked_at IS NOT NULL FROM public.ihub_customer_links WHERE customer_id = t.u('A1')), 'LEG ihub link unlinked');
  PERFORM t.ok(t.cc('A1') = t.u('CB')::text, 'LEG A1 company now B');
  -- (ج) create-sub-user: مفتاح الخدمة يكتب super_user_id لحساب جديد
  INSERT INTO auth.users (id, email) VALUES ('0a000000-0000-4000-8000-0000000000c1', 'new@tenancy.test');
  INSERT INTO public.profiles (id, email, full_name, role, phone, created_at)
  VALUES ('0a000000-0000-4000-8000-0000000000c1', 'new@tenancy.test', 'جديد', 'customer', '01100000099', '2026-09-01');
  UPDATE public.profiles SET super_user_id = t.u('OA') WHERE id = '0a000000-0000-4000-8000-0000000000c1';
  PERFORM t.ok((SELECT joined_via || ':' || is_primary FROM public.company_memberships
                 WHERE user_id = '0a000000-0000-4000-8000-0000000000c1') = 'legacy:true'
           AND (SELECT role FROM public.profiles WHERE id = '0a000000-0000-4000-8000-0000000000c1') = 'company_user', 'LEG create-sub-user');
  -- (د) الموظف ينتقل: دوره يُلغى (086) وعضويته تنتهي
  PERFORM t.act(t.u('EA'));
  UPDATE public.profiles SET super_user_id = t.u('OB') WHERE id = t.u('AG');
  PERFORM t.act(null);
  PERFORM t.ok((SELECT count(*) FROM public.company_staff WHERE user_id = t.u('AG') AND revoked_at IS NULL) = 0
           AND t.mem('AG', 'CA') = 'primary:ended' AND t.kind('AG') = 'company_customer', 'LEG staff moved');
  -- (هـ) غير المرتفع لا يغيّر التبعية مباشرة (كما كان)
  PERFORM t.act(t.u('AD'));
  BEGIN
    UPDATE public.profiles SET super_user_id = t.u('OA') WHERE id = t.u('B1');
    RAISE EXCEPTION 'FAIL LEG admin raw move';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM t.act(null);
  PERFORM t.ok(t.drift() = 0, 'LEG drift 0');
  PERFORM t.ok((SELECT count(*) FROM public.company_membership_events) >= 6, 'LEG events');
  RAISE NOTICE 'PASS ③ المسارات القديمة: الإزالة، نقل الإدارة المرتفعة، create-sub-user، نقل موظف — كلها عضويات، والمرآة مطابقة، وروابط التكامل تُفك';
END $$;
ROLLBACK;

-- ══ ④ التراجع ثم إعادة التطبيق ════════════════════════════════════════════
\i migrations/_rollback/096_company_memberships.down.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok(t.fn_digest() = (SELECT v FROM t.saved WHERE k = 'fn'), 'RB النصوص كما كانت حرفيًا (CRLF)');
  PERFORM t.ok(to_regclass('public.company_memberships') IS NULL AND to_regclass('public.platform_feature_switches') IS NULL
           AND to_regprocedure('public.company_invite_customer(text)') IS NULL, 'RB objects dropped');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_membership_mirror'), 'RB trigger dropped');
  PERFORM t.ok(t.snapshot() = (SELECT v FROM t.saved WHERE k = 'snap'), 'RB behaviour');
  RAISE NOTICE 'PASS ④ التراجع يعيد 9 دوال حرفيًا ويحذف كائنات 096';
END $$;
\i migrations/096_company_memberships.sql
SET search_path = public, extensions;
\i migrations/096_company_memberships.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok((SELECT count(*) FROM public.company_memberships WHERE status = 'active') = 7 AND t.drift() = 0, 'RE reapply + rerun');
  PERFORM t.ok(t.snapshot() = (SELECT v FROM t.saved WHERE k = 'snap'), 'RE same');
  RAISE NOTICE 'PASS ④ب إعادة التطبيق وإعادة التشغيل: نفس العضويات ونفس السلوك';
END $$;

-- ══ ⑤ المفتاح مطفأ يغلق، والتفعيل لمالك المنصة وحده ═══════════════════════
DO $$
BEGIN
  PERFORM t.ok(t.errfull(t.u('OB'), 'public.company_invite_customer(''a1@tenancy.test'')') LIKE '0A000|%feature_not_enabled%', 'OFF invite');
  PERFORM t.ok(t.err(t.u('A1'), format('public.enter_customer_company(%L::uuid)', t.u('CA'))) = '0A000', 'OFF enter');
  PERFORM t.ok(t.err(t.u('A1'), format('public.leave_company(%L::uuid)', t.u('CA'))) = '0A000', 'OFF leave');
  PERFORM t.ok(t.err(t.u('A1'), format('public.set_primary_company(%L::uuid)', t.u('CA'))) = '0A000', 'OFF set_primary');
  PERFORM t.ok(t.call(t.u('A1'), 'public.my_company_invitations()') = '[]'::jsonb, 'OFF my invitations empty');
  -- التفعيل: لا الأدمن المرتفع، ولا المالك بلا سياق، ولا المالك بلا تحقق خطوتين
  PERFORM t.ok(t.err(t.u('EA'), 'public.owner_set_feature_switch(''multi_company_memberships_enabled'', true, ''سبب كافٍ للتجربة'')') = '42501', 'SW elevated');
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_set_feature_switch(''multi_company_memberships_enabled'', true, ''سبب كافٍ للتجربة'')') = '42501', 'SW owner no ctx');
  PERFORM t.ctx('owner');
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_set_feature_switch(''multi_company_memberships_enabled'', true, ''سبب كافٍ للتجربة'')') = '42501', 'SW owner no stepup');
  PERFORM t.stepup(t.u('OW'));
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_set_feature_switch(''multi_company_memberships_enabled'', true, ''قصير'')') = '22023', 'SW reason');
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_set_feature_switch(''no_such_switch'', true, ''سبب كافٍ للتجربة'')') = 'P0002', 'SW unknown');
  PERFORM t.ok(t.call(t.u('OW'), 'public.owner_set_feature_switch(''multi_company_memberships_enabled'', true, ''تجربة العضويات المتعددة'')') ->> 'enabled' = 'true', 'SW owner on');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.privileged_audit WHERE action = 'feature_switch.multi_company_memberships_enabled'
                         AND actor_id = t.u('OW') AND new_value ->> 'reason' = 'تجربة العضويات المتعددة'), 'SW audited');
  PERFORM t.ok(jsonb_array_length(t.call(t.u('OW'), 'public.owner_feature_switches()')) = 1
           AND t.err(t.u('EA'), 'public.owner_feature_switches()') = '42501', 'SW listing owner only');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ⑤ المفتاح مطفأ يغلق الدعوة والسياق والمغادرة والأساسية؛ تفعيله لمالك المنصة وحده بسياق وتحقق خطوتين وسبب، ومسجَّل';
END $$;

-- ══ ⑥ الدعوات ═══════════════════════════════════════════════════════════
DO $$
DECLARE r1 jsonb; r2 jsonb; r3 jsonb; r4 jsonb; inv uuid;
BEGIN
  -- نفس الرد لحساب موجود مؤهل، وغير موجود، وطاقم منصة، ومالك شركة
  r1 := t.call(t.u('OB'), 'public.company_invite_customer(''A1@Tenancy.test'')');
  r2 := t.call(t.u('OB'), 'public.company_invite_customer(''nobody@nowhere.test'')');
  r3 := t.call(t.u('OB'), 'public.company_invite_customer(''ad@tenancy.test'')');
  r4 := t.call(t.u('OB'), 'public.company_invite_customer(''oa@tenancy.test'')');
  PERFORM t.ok(r1 = r2 AND r2 = r3 AND r3 = r4 AND r1 = '{"status":"pending"}'::jsonb, 'INV same response');
  PERFORM t.ok((SELECT invitee_user_id FROM public.company_membership_invitations WHERE invited_email = 'nobody@nowhere.test') IS NULL
           AND (SELECT invitee_user_id FROM public.company_membership_invitations WHERE invited_email = 'ad@tenancy.test') IS NULL
           AND (SELECT invitee_user_id FROM public.company_membership_invitations WHERE invited_email = 'oa@tenancy.test') IS NULL
           AND (SELECT invitee_user_id FROM public.company_membership_invitations WHERE invited_email = 'a1@tenancy.test') = t.u('A1'),
               'INV invitee resolved for eligible only');
  -- القائمة: البريد والحالة فقط، بلا معرّف حساب
  PERFORM t.ok(NOT (t.call(t.u('OB'), 'public.company_invitations_list()')::text LIKE '%' || t.u('A1')::text || '%')
           AND jsonb_array_length(t.call(t.u('OB'), 'public.company_invitations_list()')) = 4, 'INV list no ids');
  PERFORM t.ok(t.call(t.u('BS'), 'public.company_invitations_list()') IS NULL, 'INV list admin only');
  PERFORM t.ok(t.err(t.u('BS'), 'public.company_invite_customer(''pu@tenancy.test'')') = '42501', 'INV supervisor cannot invite');
  PERFORM t.ok(t.err(t.u('B1'), 'public.company_invite_customer(''pu@tenancy.test'')') = '42501', 'INV customer cannot invite');
  -- المدعو يرى اسم الشركة، وإشعارًا بلا تفاصيل أخرى
  PERFORM t.ok(t.call(t.u('A1'), 'public.my_company_invitations()') -> 0 ->> 'company_name' = 'شركة ب', 'INV invitee sees');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.notifications WHERE user_id = t.u('A1') AND link = '/portal/#invitations'), 'INV notified');
  PERFORM t.ok(t.call(t.u('A2'), 'public.my_company_invitations()') = '[]'::jsonb, 'INV others see none');
  inv := (SELECT id FROM public.company_membership_invitations WHERE invited_email = 'a1@tenancy.test');
  -- غير صاحبها لا يقبل
  PERFORM t.ok(t.err(t.u('A2'), format('public.company_invitation_respond(%L::uuid, true)', inv)) = 'P0002', 'INV not yours');
  PERFORM t.ok(t.err(t.u('OB'), format('public.company_invitation_respond(%L::uuid, true)', inv)) = 'P0002', 'INV inviter cannot accept');
  -- A1 يقبل: له أساسية في A، فالعضوية في B إضافية، والمرآة لا تتغير
  PERFORM t.ok(t.call(t.u('A1'), format('public.company_invitation_respond(%L::uuid, true)', inv)) ->> 'accepted' = 'true', 'INV accept');
  PERFORM t.ok(t.mem('A1', 'CB') = 'secondary:active' AND t.mem('A1', 'CA') = 'primary:active' AND t.sup('A1') = t.u('OA'), 'INV secondary');
  PERFORM t.ok(t.err(t.u('A1'), format('public.company_invitation_respond(%L::uuid, true)', inv)) = 'P0002', 'INV twice');
  -- PU بلا شركة: دعوة من A ثم القبول = أساسية
  PERFORM t.call(t.u('OA'), 'public.company_invite_customer(''pu@tenancy.test'')');
  inv := (SELECT id FROM public.company_membership_invitations WHERE invited_email = 'pu@tenancy.test' AND company_id = t.u('CA'));
  PERFORM t.call(t.u('PU'), format('public.company_invitation_respond(%L::uuid, true)', inv));
  PERFORM t.ok(t.mem('PU', 'CA') = 'primary:active' AND t.sup('PU') = t.u('OA') AND t.prole('PU') = 'company_user'
           AND t.kind('PU') = 'company_customer', 'INV PU primary');
  -- الرفض والإلغاء والانتهاء
  PERFORM t.call(t.u('OB'), 'public.company_invite_customer(''dg@tenancy.test'')');
  inv := (SELECT id FROM public.company_membership_invitations WHERE invited_email = 'dg@tenancy.test');
  PERFORM t.ok(t.call(t.u('DG'), format('public.company_invitation_respond(%L::uuid, false)', inv)) ->> 'accepted' = 'false'
           AND t.mem('DG', 'CB') = 'none', 'INV decline');
  PERFORM t.call(t.u('OB'), 'public.company_invite_customer(''dh@tenancy.test'')');
  inv := (SELECT id FROM public.company_membership_invitations WHERE invited_email = 'dh@tenancy.test');
  PERFORM t.ok(t.err(t.u('OA'), format('public.company_invitation_cancel(%L::uuid)', inv)) = 'P0002', 'INV cancel foreign');
  PERFORM t.ok(t.call(t.u('OB'), format('public.company_invitation_cancel(%L::uuid)', inv)) ->> 'cancelled' = 'true', 'INV cancel');
  PERFORM t.ok(t.err(t.u('DH'), format('public.company_invitation_respond(%L::uuid, true)', inv)) = 'P0002', 'INV cancelled');
  PERFORM t.call(t.u('OB'), 'public.company_invite_customer(''dh@tenancy.test'')');
  UPDATE public.company_membership_invitations SET created_at = now() - interval '9 days', expires_at = now() - interval '1 day'
   WHERE invited_email = 'dh@tenancy.test' AND status = 'pending';
  inv := (SELECT id FROM public.company_membership_invitations WHERE invited_email = 'dh@tenancy.test' AND status = 'pending');
  PERFORM t.ok(t.err(t.u('DH'), format('public.company_invitation_respond(%L::uuid, true)', inv)) = 'P0002'
           AND t.call(t.u('OB'), 'public.company_invitations_list()')::text LIKE '%expired%', 'INV expired');
  PERFORM t.ok(t.drift() = 0, 'INV drift 0');
  RAISE NOTICE 'PASS ⑥ الدعوات: رد واحد لكل بريد (لا كشف)، المدير وحده يدعو، صاحب الحساب وحده يقبل، أساسية أو إضافية، رفض وإلغاء وانتهاء';
END $$;

-- ══ ⑦ العزل والسياق ══════════════════════════════════════════════════════
DO $$
DECLARE l jsonb; p jsonb;
BEGIN
  -- B ترى A1 عميلًا لها بلا أي أثر لعضويته في A
  l := t.call(t.u('OB'), 'public.company_customers_list()');
  PERFORM t.ok(l -> 'customers' @> jsonb_build_array(jsonb_build_object('id', t.u('A1'))), 'ISO B lists A1');
  PERFORM t.ok(NOT (l::text LIKE '%' || t.u('CA')::text || '%') AND NOT (l::text LIKE '%شركة أ%')
           AND NOT (l::text LIKE '%is_primary%'), 'ISO B لا يعرف عن A');
  PERFORM t.ok(NOT ((t.call(t.u('OB'), 'public.company_members()'))::text LIKE '%' || t.u('CA')::text || '%')
           AND (SELECT e ->> 'role' FROM jsonb_array_elements(t.call(t.u('OB'), 'public.company_members()') -> 'members') e
                 WHERE e ->> 'id' = t.u('A1')::text) = 'company_user', 'ISO members role relative');
  -- قائمة العملاء: المدير والمشرف، لا الموظف ولا العميل؛ وبلا الموظفين
  PERFORM t.ok(t.call(t.u('BS'), 'public.company_customers_list()') IS NOT NULL
           AND t.call(t.u('AG'), 'public.company_customers_list()') IS NULL
           AND t.call(t.u('A1'), 'public.company_customers_list()') IS NULL, 'ISO list roles');
  PERFORM t.ok(NOT (t.call(t.u('OA'), 'public.company_customers_list()')::text LIKE '%' || t.u('AS')::text || '%'), 'ISO list no staff');
  PERFORM t.ok((t.call(t.u('BS'), 'public.company_customers_list()') ->> 'can_manage')::boolean = false
           AND (t.call(t.u('OB'), 'public.company_customers_list()') ->> 'can_manage')::boolean, 'ISO manage admin only');
  PERFORM t.ok((t.call(t.u('OB'), 'public.company_customers_list()') ->> 'invitations_enabled')::boolean, 'ISO invitations flag on');
  -- السياق: الافتراضي الأساسية؛ يختار B فتصير شركته الحالية؛ غير العضو مرفوض
  PERFORM t.ok(t.cc('A1') = t.u('CA')::text, 'CTX default primary');
  PERFORM t.ok(t.call(t.u('A1'), format('public.enter_customer_company(%L::uuid)', t.u('CB'))) ->> 'company_id' = t.u('CB')::text, 'CTX enter B');
  PERFORM t.ok(t.cc('A1') = t.u('CB')::text, 'CTX current B');
  p := t.call(t.u('A1'), 'public.my_company_portal()');
  PERFORM t.ok(p #>> '{company,name}' = 'شركة ب' AND jsonb_array_length(p -> 'memberships') = 2, 'CTX portal B + switcher');
  PERFORM t.ok(t.errfull(t.u('A1'), format('public.enter_customer_company(%L::uuid)', t.u('CW'))) LIKE 'P0002|%', 'CTX foreign');
  PERFORM t.ok(t.errfull(t.u('A1'), format('public.enter_customer_company(%L::uuid)', t.u('NOPE'))) LIKE 'P0002|%', 'CTX missing same');
  -- إطفاء المفتاح يلغي السياق فورًا (يعود للأساسية)
  PERFORM t.sw(false);
  PERFORM t.ok(t.cc('A1') = t.u('CA')::text, 'CTX switch off → primary');
  PERFORM t.ok(NOT (t.call(t.u('OB'), 'public.company_customers_list()') ->> 'invitations_enabled')::boolean, 'ISO invitations flag off');
  PERFORM t.sw(true);
  PERFORM t.ok(t.cc('A1') = t.u('CB')::text, 'CTX switch on → context');
  PERFORM t.call(t.u('A1'), 'public.enter_customer_company(null)');
  PERFORM t.ok(t.cc('A1') = t.u('CA')::text, 'CTX cleared');
  -- المشرف AS (موظف في A) يقبل عضوية عميل في B، ويدخل سياقها: لا صلاحيات موظف في B
  PERFORM t.call(t.u('OB'), 'public.company_invite_customer(''as@tenancy.test'')');
  PERFORM t.call(t.u('AS'), format('public.company_invitation_respond(%L::uuid, true)',
                 (SELECT id FROM public.company_membership_invitations WHERE invited_email = 'as@tenancy.test')));
  PERFORM t.call(t.u('AS'), format('public.enter_customer_company(%L::uuid)', t.u('CB')));
  PERFORM t.ok(t.call(t.u('AS'), 'public.company_staff_role()') IS NULL
           AND t.call(t.u('AS'), 'public.get_my_company_dashboard()') IS NULL
           AND t.call(t.u('AS'), 'public.company_customers_list()') IS NULL, 'CTX staff in B = customer only');
  PERFORM t.ok(t.call(t.u('AS'), 'public.my_company_portal()') #>> '{company,name}' = 'شركة ب', 'CTX staff portal B');
  PERFORM t.call(t.u('AS'), 'public.enter_customer_company(null)');
  PERFORM t.ok(t.call(t.u('AS'), 'public.company_staff_role()') #>> '{}' = 'supervisor', 'CTX back to A supervisor');
  -- الموظف ليس عميلًا لشركته: قائمة عملاء A لا تحويه، وبوابة A لا تُفتح له
  PERFORM t.ok(t.call(t.u('AS'), 'public.my_company_portal()') IS NULL, 'CTX staff no portal in own company');
  RAISE NOTICE 'PASS ⑦ العزل: B لا ترى شيئًا عن عضوية A؛ السياق يتحقق منه الخادم، ويسقط بإطفاء المفتاح؛ الموظف في سياق عميل لا يحمل صلاحياته';
END $$;

-- ══ ⑧ المغادرة وتعيين الأساسية ═══════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ok(t.err(t.u('A1'), format('public.set_primary_company(%L::uuid)', t.u('CB'))) = '42501', 'PRI has primary');
  PERFORM t.ok(t.err(t.u('A1'), format('public.leave_company(%L::uuid)', t.u('CW'))) = 'P0002', 'LEAVE foreign');
  PERFORM t.ok(t.call(t.u('A1'), format('public.leave_company(%L::uuid)', t.u('CA'))) ->> 'left' = 'true', 'LEAVE primary');
  PERFORM t.ok(t.mem('A1', 'CA') = 'primary:ended' AND t.sup('A1') IS NULL AND t.prole('A1') = 'user', 'LEAVE mirror cleared');
  PERFORM t.ok(t.kind('A1') = 'company_customer' AND t.cc('A1') = t.u('CB')::text, 'LEAVE secondary-only customer of B');
  PERFORM t.ok(t.call(t.u('A1'), format('public.set_primary_company(%L::uuid)', t.u('CB'))) ->> 'primary' = t.u('CB')::text, 'PRI set');
  PERFORM t.ok(t.mem('A1', 'CB') = 'primary:active' AND t.sup('A1') = t.u('OB') AND t.prole('A1') = 'company_user', 'PRI mirror');
  -- A لم تعد ترى A1 في قوائمها
  PERFORM t.ok(NOT (t.call(t.u('OA'), 'public.company_customers_list()')::text LIKE '%' || t.u('A1')::text || '%')
           AND NOT ((t.call(t.u('OA'), 'public.company_members()'))::text LIKE '%' || t.u('A1')::text || '%'), 'LEAVE A no longer lists');
  -- مدير B يزيل عضوية إضافية (AS في B) دون أن يمس أساسيته في A
  PERFORM t.call(t.u('OB'), format('public.remove_company_member(%L::uuid)', t.u('AS')));
  PERFORM t.ok(t.mem('AS', 'CB') = 'secondary:ended' AND t.mem('AS', 'CA') = 'primary:active' AND t.sup('AS') = t.u('OA')
           AND t.call(t.u('AS'), 'public.company_staff_role()') #>> '{}' = 'supervisor', 'REM secondary keeps primary');
  PERFORM t.ok(t.drift() = 0, 'END drift 0');
  RAISE NOTICE 'PASS ⑧ المغادرة تُفرّغ الأساسية بلا ترقية تلقائية، والعميل يختار أساسية جديدة، وإزالة الإضافية لا تمس الأساسية';
END $$;

-- ══ ⑨ الحرّاس ورفض التراجع ═══════════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ok(t.exec(t.u('OA'), 'select * from public.company_memberships') = '42501', 'G direct select');
  PERFORM t.ok(t.exec(t.u('OA'), format('insert into public.company_memberships (company_id, user_id, joined_via) values (%L, %L, ''legacy'')',
                                         t.u('CA'), t.u('DG'))) = '42501', 'G direct insert');
  PERFORM t.ok(t.err_super_ok(format('insert into public.company_memberships (company_id, user_id, joined_via) values (%L, %L, ''legacy'')',
                                     t.u('CA'), t.u('OA'))) = '23514', 'G owner not member');
  PERFORM t.ok(t.err_super_ok(format('insert into public.company_memberships (company_id, user_id, joined_via) values (%L, %L, ''legacy'')',
                                     t.u('CA'), t.u('AD'))) = '23514', 'G staff not member');
  PERFORM t.ok(t.err_super_ok(format('insert into public.company_memberships (company_id, user_id, is_primary, joined_via) values (%L, %L, true, ''legacy'')',
                                     t.u('CW'), t.u('B1'))) = '23505', 'G one primary');
  PERFORM t.ok(t.err_super_ok(format('update public.company_memberships set is_primary = true where user_id = %L and company_id = %L',
                                     t.u('A1'), t.u('CA'))) = '23514', 'G ended immutable');
  PERFORM t.ok(t.err_super_ok('update public.company_membership_events set action = ''joined''') = '23514', 'G events append-only');
  PERFORM t.ok(t.err_super_ok('delete from public.company_membership_events') = '23514', 'G events no delete');
  PERFORM t.ok(t.err_super_ok('truncate public.company_membership_events') = '23514', 'G events no truncate');
  RAISE NOTICE 'PASS ⑨ الحرّاس: لا وصول مباشر، المالك والطاقم ليسوا أعضاء، أساسية واحدة، المنتهية ثابتة، السجل إلحاقي';
END $$;
\set rbsql `cat migrations/_rollback/096_company_memberships.down.sql`
SELECT set_config('t.rbsql', :'rbsql', false) IS NOT NULL;
DO $$
BEGIN
  BEGIN
    EXECUTE current_setting('t.rbsql');
    RAISE EXCEPTION 'FAIL RB allowed with data';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%مرفوض%' THEN RAISE; END IF;
  END;
  PERFORM t.ok(to_regclass('public.company_memberships') IS NOT NULL, 'RB data kept');
  RAISE NOTICE 'PASS ⑨ب التراجع مرفوض مع وجود عضويات إضافية أو دعوات (لا تضيع علاقات قائمة)';
END $$;

SELECT 'ALL company-memberships tests passed';
