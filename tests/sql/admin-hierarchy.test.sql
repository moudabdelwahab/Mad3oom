-- ============================================================================
-- 099_admin_hierarchy على نسخة مطابقة للإنتاج حتى 093 + 095 … 098
--
--   ⓪ قبل 099: رؤية كل فاعل وامتيازات الشركة
--   ① 099: الكائنات، المفاتيح مطفأة، المراجعة مملوءة بالحسابات الإدارية فقط
--   ①ب التراجع حرفيًا ثم إعادة التطبيق
--   ② الهيكل: المالك وحده بتحقق خطوتين؛ شجرة بلا دورات وبعمق محدود؛ الفصل (لا مالك شركة ولا عضو
--      ولا موظف ولا حساب عادي)؛ إسناد الشركات بتاريخ؛ التفويض بقدرات من الكتالوج وسبب
--   ③ المفوَّض: لا شيء والمفتاح مطفأ؛ سجل الشركات في نطاقه فقط وبلا بيانات خاصة؛ الإيقاف بنطاق؛
--      التفويض لا يفتح تذاكر الشركات (مع العزل)؛ إدارة الأعضاء دون إضافة النفس؛ السحب والانتهاء
--   ④ إنفاذ الإيقاف خلف مفتاح، وحارس حالة الشركة باقٍ
--   ⑤ مراجعة الإداريين: القرار للمالك، والتطبيق بعد تسليم العمل، والتحويل بالمسار الرسمي
--   ⑥ الثوابت: لا سياسة وصول تعتمد على الهيكل، السجل إلحاقي، لا حذف، لا وصول مباشر
--   ⑦ رفض التراجع مع وجود هيكل
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

\i tests/fixtures/prod-shape/load.sql
\i tests/fixtures/prod-shape/chain-to-093.sql
\i tests/fixtures/tenancy/harness.sql
\i migrations/095_account_boundaries.sql
\i migrations/096_company_memberships.sql
SET search_path = public, extensions;
SET check_function_bodies = off;
\i tests/fixtures/tenancy/tickets.sql
\i migrations/097_ticket_scope_isolation.sql
\i migrations/098_company_permissions_usage_ledger.sql
SET search_path = public, extensions;

CREATE FUNCTION t.own(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN PERFORM t.ctx('owner'); PERFORM t.stepup(t.u('OW')); RETURN t.call(t.u('OW'), p_sql); END $$;
CREATE FUNCTION t.own_err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN PERFORM t.ctx('owner'); PERFORM t.stepup(t.u('OW')); RETURN t.err(t.u('OW'), p_sql); END $$;
CREATE FUNCTION t.prole(p_user text) RETURNS text LANGUAGE sql AS $$ select role from public.profiles where id = t.u(p_user) $$;
CREATE FUNCTION t.feat(p text, p_key text) RETURNS boolean LANGUAGE sql AS $$
  select (t.call(t.u(p), format('public.company_has_feature(%L)', p_key)) #>> '{}')::boolean $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ══ ⓪ قبل 099 ═══════════════════════════════════════════════════════════
INSERT INTO t.saved VALUES ('vis0', t.allvis()), ('schema0', t.schema_digest());
DO $$ BEGIN
  PERFORM t.ok(t.feat('OA', 'sub_users') AND t.feat('OB', 'sub_users'), 'BASE features');
  RAISE NOTICE 'PASS ⓪ قبل 099: الرؤية وامتيازات الشركتين محفوظة';
END $$;

-- ══ ① 099 ════════════════════════════════════════════════════════════════
\i migrations/099_admin_hierarchy.sql
SET search_path = public, extensions;
DO $$ BEGIN
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.platform_feature_switches WHERE enabled), 'OBJ switches off');
  PERFORM t.ok((SELECT string_agg(user_id::text, ',' ORDER BY user_id) FROM public.admin_account_reviews)
             = (SELECT string_agg(x::text, ',' ORDER BY x) FROM unnest(array[t.u('EA'), t.u('AD'), t.u('SUP')]) x), 'OBJ reviews seeded: EA AD SUP only');
  PERFORM t.ok((SELECT snapshot ->> 'authority' FROM public.admin_account_reviews WHERE user_id = t.u('EA')) = 'elevated_admin', 'OBJ snapshot');
  PERFORM t.ok(NOT has_table_privilege('authenticated', 'public.platform_delegations', 'select')
           AND NOT has_table_privilege('service_role', 'public.admin_units', 'select')
           AND NOT has_function_privilege('authenticated', 'public._delegate_can(text,uuid)', 'execute')
           AND NOT has_function_privilege('anon', 'public.delegate_companies()', 'execute'), 'OBJ grants');
  PERFORM t.ok(t.allvis() = (SELECT v FROM t.saved WHERE k = 'vis0') AND t.feat('OA', 'sub_users'), 'OBJ nothing else changed');
  RAISE NOTICE 'PASS ① 099: المفاتيح مطفأة، المراجعة مملوءة بالحسابات الإدارية الثلاثة فقط (لا المالك)، الجداول مغلقة، ولا تغيير في الرؤية';
END $$;

\i migrations/_rollback/099_admin_hierarchy.down.sql
DO $$ BEGIN
  PERFORM t.ok(t.schema_digest() = (SELECT v FROM t.saved WHERE k = 'schema0'), 'RB schema byte-for-byte');
  RAISE NOTICE 'PASS ①ب التراجع: كل شيء حرفيًا كما قبل 099';
END $$;
\i migrations/099_admin_hierarchy.sql
\i migrations/099_admin_hierarchy.sql
SET search_path = public, extensions;

-- ══ ② الهيكل ═════════════════════════════════════════════════════════════
DO $$
DECLARE root uuid; child uuid; leaf uuid; u uuid; i int;
BEGIN
  PERFORM t.ok(t.err(t.u('EA'), 'public.owner_unit_create(''وحدة'')') = '42501', 'UNIT elevated no');
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_unit_create(''وحدة'')') = '42501', 'UNIT owner without context');
  root  := (t.own('public.owner_unit_create(''الإدارة العامة'')') ->> 'unit_id')::uuid;
  child := (t.own(format('public.owner_unit_create(''الفرع الشمالي'', %L::uuid)', root)) ->> 'unit_id')::uuid;
  leaf  := (t.own(format('public.owner_unit_create(''فريق أ'', %L::uuid)', child)) ->> 'unit_id')::uuid;
  INSERT INTO t.saved VALUES ('root', root), ('child', child), ('leaf', leaf);
  -- لا دورات ولا عمق زائد
  PERFORM t.ok(t.err_super_ok(format('update public.admin_units set parent_id = %L where id = %L', leaf, root)) = '23514', 'TREE no cycle');
  u := leaf;
  FOR i IN 1..3 LOOP
    u := (t.own(format('public.owner_unit_create(''مستوى %s'', %L::uuid)', i + 3, u)) ->> 'unit_id')::uuid;
  END LOOP;
  PERFORM t.ok(t.own_err(format('public.owner_unit_create(''مستوى 7'', %L::uuid)', u)) = '23514', 'TREE depth 6');
  -- الفصل: طاقم المنصة وحده، بلا ملكية ولا عضوية ولا دور فريق في شركة
  PERFORM t.ok(t.own_err(format('public.unit_member_set(%L::uuid, %L::uuid)', child, t.u('SUP'))) = 'ok', 'MEM support ok');
  PERFORM t.ok(t.own_err(format('public.unit_member_set(%L::uuid, %L::uuid)', child, t.u('OA'))) = '23514', 'MEM company owner no');
  PERFORM t.ok(t.own_err(format('public.unit_member_set(%L::uuid, %L::uuid)', child, t.u('A1'))) = '23514', 'MEM customer no');
  PERFORM t.ok(t.own_err(format('public.unit_member_set(%L::uuid, %L::uuid)', child, t.u('AS'))) = '23514', 'MEM company staff no');
  PERFORM t.ok(t.own_err(format('public.unit_member_set(%L::uuid, %L::uuid)', child, t.u('PU'))) = '23514', 'MEM plain user no');
  PERFORM t.ok(t.own_err(format('public.unit_member_set(%L::uuid, %L::uuid)', child, t.u('SUP'))) = '23505', 'MEM once');
  -- إسناد الشركات بتاريخ
  PERFORM t.own(format('public.owner_assign_company_unit(%L::uuid, %L::uuid, ''توزيع أولي للشركات'')', t.u('CA'), child));
  PERFORM t.own(format('public.owner_assign_company_unit(%L::uuid, %L::uuid, ''توزيع أولي للشركات'')', t.u('CB'), root));
  PERFORM t.own(format('public.owner_assign_company_unit(%L::uuid, %L::uuid, ''نقل إلى فريق أ'')', t.u('CA'), leaf));
  PERFORM t.ok((SELECT count(*) FROM public.admin_unit_companies WHERE company_id = t.u('CA')) = 2
           AND (SELECT unit_id FROM public.admin_unit_companies WHERE company_id = t.u('CA') AND ended_at IS NULL) = leaf, 'CO history');
  PERFORM t.ok(t.own_err(format('public.owner_assign_company_unit(%L::uuid, %L::uuid, ''قصير'')', t.u('CB'), leaf)) = '22023', 'CO reason');
  -- التفويض
  PERFORM t.ok(t.own_err(format('public.owner_grant_delegation(%L::uuid, %L::uuid, array[''tickets.read''], ''قدرة غير موجودة للاختبار'')', t.u('AD'), root)) = '22023', 'DEL unknown capability');
  PERFORM t.ok(t.own_err(format('public.owner_grant_delegation(%L::uuid, %L::uuid, array[''companies.view_registry''], ''تفويض المالك لنفسه'')', t.u('OW'), root)) = '23514', 'DEL not to owner');
  PERFORM t.ok(t.own_err(format('public.owner_grant_delegation(%L::uuid, %L::uuid, array[''companies.view_registry''], ''تفويض لمالك شركة'')', t.u('OA'), root)) = '23514', 'DEL not to company owner');
  INSERT INTO t.saved VALUES ('del_ad', t.own(format('public.owner_grant_delegation(%L::uuid, %L::uuid, array[''companies.view_registry'', ''companies.suspend''], ''إدارة شركات الإدارة العامة'')', t.u('AD'), root)) ->> 'delegation_id');
  INSERT INTO t.saved VALUES ('del_sup', t.own(format('public.owner_grant_delegation(%L::uuid, %L::uuid, array[''units.manage_members''], ''إدارة أعضاء الفرع الشمالي'')', t.u('SUP'), child)) ->> 'delegation_id');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.privileged_audit WHERE action = 'delegation.granted' AND target_user_id = t.u('AD')), 'DEL audited');
  PERFORM t.ok(jsonb_array_length(t.own('public.owner_hierarchy()') -> 'units') = 6, 'CONSOLE tree');
  PERFORM t.ctx(null);
  PERFORM t.ok(t.err(t.u('EA'), 'public.owner_hierarchy()') = '42501', 'CONSOLE owner only');
  RAISE NOTICE 'PASS ② الهيكل: المالك وحده بسياق وتحقق خطوتين، شجرة بلا دورات وبعمق ≤ 6، الفصل إلزامي، إسناد الشركات بتاريخ، والتفويض بقدرات الكتالوج وسبب ومسجَّل';
END $$;

-- ══ ③ المفوَّض ═══════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; leaf uuid := (SELECT v FROM t.saved WHERE k = 'leaf')::uuid; child uuid := (SELECT v FROM t.saved WHERE k = 'child')::uuid;
BEGIN
  -- المفتاح مطفأ: لا شيء
  PERFORM t.ok(t.call(t.u('AD'), 'public.delegate_companies()') = '[]'::jsonb, 'OFF registry');
  PERFORM t.ok(t.err(t.u('AD'), format('public.delegate_set_company_status(%L::uuid, ''suspended'', ''إيقاف بسبب مخالفة'')', t.u('CA'))) = 'P0002', 'OFF suspend');
  PERFORM t.sw('delegation_enabled', true);
  -- سجل الشركات: النطاق (الجذر وما تحته = أ وب)، بيانات تشغيلية فقط
  r := t.call(t.u('AD'), 'public.delegate_companies()');
  PERFORM t.ok(jsonb_array_length(r) = 2, 'REG scope ' || r::text);
  PERFORM t.ok(NOT (r::text ~ '(title|description|email|phone|tax_id|commercial_registration|ticket)'), 'REG no private data');
  PERFORM t.ok(t.call(t.u('SUP'), 'public.delegate_companies()') = '[]'::jsonb AND t.call(t.u('EA'), 'public.delegate_companies()') = '[]'::jsonb, 'REG others none');
  -- الإيقاف بنطاق
  PERFORM t.ok(t.call(t.u('AD'), format('public.delegate_set_company_status(%L::uuid, ''suspended'', ''إيقاف بسبب مخالفة'')', t.u('CA'))) ->> 'changed' = 'true', 'SUSPEND in scope');
  PERFORM t.ok((SELECT status FROM public.companies WHERE id = t.u('CA')) = 'suspended', 'SUSPEND stored');
  PERFORM t.ok(t.err(t.u('AD'), format('public.delegate_set_company_status(%L::uuid, ''suspended'', ''إيقاف خارج النطاق'')', t.u('CW'))) = 'P0002', 'SUSPEND out of scope');
  PERFORM t.ok(t.err(t.u('SUP'), format('public.delegate_set_company_status(%L::uuid, ''suspended'', ''بلا قدرة الإيقاف'')', t.u('CA'))) = 'P0002', 'SUSPEND no capability');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.hierarchy_events WHERE action = 'company.suspended' AND company_id = t.u('CA') AND actor_id = t.u('AD')), 'SUSPEND event');
  -- التفويض لا يفتح تذاكر الشركات
  PERFORM t.sw('company_isolation_enforced', true);
  PERFORM t.ok(NOT t.sees('AD', 'TA1') AND NOT t.sees('AD', 'TB1') AND t.sees('AD', 'TPU'), 'NO DATA via delegation');
  PERFORM t.sw('company_isolation_enforced', false);
  -- إدارة الأعضاء: SUP على الفرع الشمالي وما تحته، لا نفسه، لا خارج النطاق
  PERFORM t.ok(t.err(t.u('SUP'), format('public.unit_member_set(%L::uuid, %L::uuid)', leaf, t.u('EA'))) = 'ok', 'MANAGE add in subtree');
  PERFORM t.ok(t.err(t.u('SUP'), format('public.unit_member_set(%L::uuid, %L::uuid)', leaf, t.u('SUP'))) = '42501', 'MANAGE not self');
  PERFORM t.ok(t.err(t.u('SUP'), format('public.unit_member_set(%L::uuid, %L::uuid)', (SELECT v FROM t.saved WHERE k = 'root')::uuid, t.u('EA'))) = '42501', 'MANAGE not above scope');
  PERFORM t.ok(t.err(t.u('SUP'), format('public.unit_member_set(%L::uuid, %L::uuid)', leaf, t.u('BS'))) = '23514', 'MANAGE separation');
  PERFORM t.ok(t.err(t.u('SUP'), format('public.owner_grant_delegation(%L::uuid, %L::uuid, array[''companies.suspend''], ''منح من غير المالك'')', t.u('EA'), leaf)) = '42501', 'MANAGE cannot delegate');
  -- السحب والانتهاء
  PERFORM t.own(format('public.owner_revoke_delegation(%L::uuid, ''انتهت الحاجة للتفويض'')', (SELECT v FROM t.saved WHERE k = 'del_ad')));
  PERFORM t.ctx(null);
  PERFORM t.ok(t.call(t.u('AD'), 'public.delegate_companies()') = '[]'::jsonb, 'REVOKE immediate');
  PERFORM t.ok(t.err_super_ok(format('update public.platform_delegations set capabilities = array[''companies.suspend''] where id = %L', (SELECT v FROM t.saved WHERE k = 'del_sup'))) = '23514', 'DEL immutable');
  UPDATE public.platform_delegations SET expires_at = granted_at + interval '1 millisecond' WHERE id = (SELECT v FROM t.saved WHERE k = 'del_sup')::uuid;
END $$;
DO $$ BEGIN
  PERFORM t.ok(t.err(t.u('SUP'), format('public.unit_member_set(%L::uuid, %L::uuid)', (SELECT v FROM t.saved WHERE k = 'child')::uuid, t.u('EA'))) = '42501', 'EXPIRED');
  RAISE NOTICE 'PASS ③ المفوَّض: لا شيء والمفتاح مطفأ؛ سجل شركات نطاقه بلا بيانات خاصة؛ الإيقاف بنطاق ومسجَّل؛ التفويض لا يفتح تذاكر الشركات؛ لا يضيف نفسه ولا يفوّض؛ السحب والانتهاء فوريان';
END $$;

-- ══ ④ إنفاذ الإيقاف ═════════════════════════════════════════════════════
DO $$ BEGIN
  PERFORM t.ok(t.feat('OA', 'sub_users'), 'ENF off: suspended still has features');
  PERFORM t.sw('company_suspension_enforced', true);
  PERFORM t.ok(NOT t.feat('OA', 'sub_users') AND t.feat('OB', 'sub_users'), 'ENF on: suspended loses features, others keep');
  PERFORM t.own(format('public.delegate_set_company_status(%L::uuid, ''active'', ''إعادة التفعيل بعد المراجعة'')', t.u('CA')));
  PERFORM t.ctx(null);
  PERFORM t.ok(t.feat('OA', 'sub_users'), 'ENF reactivated');
  PERFORM t.ok(t.exec(t.u('OA'), format('update public.companies set status = ''suspended'' where id = %L', t.u('CA'))) = '42501', 'GUARD owner cannot set status');
  PERFORM t.sw('company_suspension_enforced', false);
  RAISE NOTICE 'PASS ④ الإيقاف: بلا أثر والمفتاح مطفأ؛ مفعّلًا تفقد الشركة الموقوفة امتيازاتها وحدها؛ إعادة التفعيل تعيدها؛ ومالك الشركة لا يغيّر الحالة';
END $$;

-- ══ ⑤ مراجعة الإداريين ══════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ok(t.err(t.u('EA'), format('public.owner_decide_admin_review(%L::uuid, ''keep'', ''قرار من غير المالك'')', t.u('AD'))) = '42501', 'REV elevated cannot decide');
  r := t.own('public.owner_admin_reviews()');
  PERFORM t.ok(jsonb_array_length(r) = 3 AND NOT (r::text LIKE '%' || t.u('OW')::text || '%'), 'REV list');
  PERFORM t.ok((SELECT (e ->> 'mfa_ready')::boolean FROM jsonb_array_elements(r) e WHERE e ->> 'user_id' = t.u('AD')::text) = false, 'REV mfa readiness shown');
  -- سحب السلطة المرتفعة
  PERFORM t.own(format('public.owner_decide_admin_review(%L::uuid, ''revoke_authority'', ''لا حاجة لسلطة مرتفعة'')', t.u('EA')));
  PERFORM t.own(format('public.owner_apply_admin_review(%L::uuid)', t.u('EA')));
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.platform_authority WHERE user_id = t.u('EA')) AND t.prole('EA') = 'admin', 'APPLY revoke authority');
  -- تحويل SUP إلى حساب عادي: ممنوع ومعه تذكرة مسندة مفتوحة
  PERFORM set_config('app.bypass_ticket_restrictions', 'on', true);
  UPDATE public.tickets SET assigned_to = t.u('SUP') WHERE id = t.k('TPU');
  PERFORM set_config('app.bypass_ticket_restrictions', 'off', true);
  PERFORM t.own(format('public.owner_decide_admin_review(%L::uuid, ''convert_user'', ''لم يعد ضمن فريق الدعم'')', t.u('SUP')));
  PERFORM t.ok(t.own_err(format('public.owner_apply_admin_review(%L::uuid)', t.u('SUP'))) = '23514', 'APPLY blocked with work');
  PERFORM t.ok(t.prole('SUP') = 'support', 'APPLY nothing changed');
  -- التسليم ثم التطبيق
  PERFORM t.ok((t.own(format('public.owner_reassign_admin_tickets(%L::uuid, %L::uuid, ''تسليم قبل التحويل'')', t.u('SUP'), t.u('AD'))) ->> 'tickets')::int = 1, 'HANDOVER tickets');
  PERFORM t.ok((SELECT assigned_to FROM public.tickets WHERE id = t.k('TPU')) = t.u('AD'), 'HANDOVER done');
  PERFORM t.ok(t.own_err(format('public.owner_apply_admin_review(%L::uuid)', t.u('SUP'))) = 'ok', 'APPLY after handover');
  PERFORM t.ok(t.prole('SUP') = 'user'
           AND NOT EXISTS (SELECT 1 FROM public.admin_unit_members WHERE user_id = t.u('SUP') AND ended_at IS NULL), 'APPLY convert ends unit memberships');
  PERFORM t.ok(t.own_err(format('public.owner_apply_admin_review(%L::uuid)', t.u('SUP'))) = 'P0002', 'APPLY once');
  PERFORM t.ok(t.own_err(format('public.owner_reassign_admin_tickets(%L::uuid, %L::uuid, ''إلى حساب غير إداري'')', t.u('AD'), t.u('PU'))) = '22023', 'HANDOVER to staff only');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ⑤ المراجعة: القرار للمالك وحده بتحقق خطوتين؛ الجاهزية (ومنها التحقق بخطوتين) معروضة لا مفروضة؛ التحويل ممنوع قبل تسليم العمل؛ التسليم لطاقم المنصة فقط؛ والتطبيق بالمسار الرسمي مرة واحدة';
END $$;

-- ══ ⑥ الثوابت ═══════════════════════════════════════════════════════════
DO $$ BEGIN
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_policies WHERE coalesce(qual, '') || coalesce(with_check, '') ~ '(admin_unit|platform_delegations|_delegate_can|hierarchy)'), 'INV no policy on hierarchy');
  PERFORM t.ok(t.err_super_ok('update public.hierarchy_events set action = ''x''') = '23514'
           AND t.err_super_ok('truncate public.hierarchy_events') = '23514', 'INV events append-only');
  PERFORM t.ok(t.err_super_ok('delete from public.admin_units') = '23514' AND t.err_super_ok('delete from public.platform_delegations') = '23514', 'INV no delete');
  PERFORM t.ok(t.exec(t.u('AD'), 'select * from public.admin_units') = '42501', 'INV no direct read');
  RAISE NOTICE 'PASS ⑥ الثوابت: لا سياسة وصول على بيانات الشركات تعتمد على الهيكل، السجل إلحاقي، لا حذف، ولا قراءة مباشرة';
END $$;

-- ══ ⑦ رفض التراجع ═══════════════════════════════════════════════════════
\set rbsql `cat migrations/_rollback/099_admin_hierarchy.down.sql`
SELECT set_config('t.rbsql', :'rbsql', false) IS NOT NULL;
DO $$
BEGIN
  BEGIN
    EXECUTE current_setting('t.rbsql');
    RAISE EXCEPTION 'FAIL RB allowed with hierarchy';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%مرفوض%' THEN RAISE; END IF;
  END;
  PERFORM t.ok(to_regclass('public.admin_units') IS NOT NULL, 'RB kept');
  RAISE NOTICE 'PASS ⑦ التراجع مرفوض مع وجود هيكل أو تفويضات أو قرارات (سجل إداري لا يُحذف)';
END $$;

SELECT 'ALL admin-hierarchy tests passed';
