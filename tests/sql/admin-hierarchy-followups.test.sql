-- ============================================================================
-- 103_admin_hierarchy_followups على نسخة مطابقة للإنتاج حتى 093 + 094 … 102 (ترتيب الإنتاج)
--
--   ⓪ قبل 103: حذف حساب له سجل هيكل يفشل (23514) — المشكلة M1 كما هي في الإنتاج اليوم
--   ① 103: الكائنات، المفاتيح مطفأة؛ ①ب التراجع حرفيًا ثم إعادة التطبيق مرتين
--   ② M1: حذف عضو بتفويض منتهٍ وحذف مالك شركة مسندة ينجحان، والتاريخ باقٍ ومُنهى؛ لا مفاتيح خارجية
--   ③ M2: الخفض ثم إعادة الترقية، والحظر ثم رفعه، وملكية شركة — لا يعود تفويض قديم
--   ④ M3: المفوَّض يحتاج aal2، ويوقف ولا يعيد التفعيل؛ المالك يعيد التفعيل؛ إدارة الأعضاء بـ aal2
--   ⑤ L1 القرار المطبَّق نهائي · ⑥ L2 مانع التحويل لتذاكر مدعوم وحدها · ⑦ L3 التفويض المنتهي غير نشط
--   ⑧ ترتيب التراجع: 099 مرفوض مع 100/103، و103 مرفوض مع سجل لحساب محذوف — بلا أي تغيير
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
SET search_path = public, extensions;

CREATE FUNCTION t.own(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN PERFORM t.ctx('owner'); PERFORM t.stepup(t.u('OW')); RETURN t.call(t.u('OW'), p_sql); END $$;
CREATE FUNCTION t.own_err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN PERFORM t.ctx('owner'); PERFORM t.stepup(t.u('OW')); RETURN t.err(t.u('OW'), p_sql); END $$;
-- جلسة aal2 (ادعاء aal في الـ JWT كما تضعه Supabase Auth بعد MFA)
CREATE FUNCTION t.aal_call(p uuid, p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.aal', 'aal2', false);
  v := t.call(p, p_sql);
  PERFORM set_config('request.jwt.claim.aal', '', false);
  RETURN v;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('request.jwt.claim.aal', '', false);
  RAISE;
END $$;
CREATE FUNCTION t.aal_err(p uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN PERFORM t.aal_call(p, p_sql); RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE; END $$;
CREATE FUNCTION t.aal_errfull(p uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE m text; d text;
BEGIN PERFORM t.aal_call(p, p_sql); RETURN 'ok';
EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS m = MESSAGE_TEXT, d = PG_EXCEPTION_DETAIL; RETURN SQLSTATE || '|' || m || '|' || coalesce(d, ''); END $$;
-- فاعلون إضافيون لهذا الملف
CREATE FUNCTION t.x(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  select (case p when 'X0' then '0e000000-0000-4000-8000-0000000000b0' when 'X1' then '0e000000-0000-4000-8000-0000000000b1'
                 when 'ZO' then '0e000000-0000-4000-8000-0000000000b2' when 'CZ' then 'cd000000-0000-4000-8000-00000000000d'
                 when 'CE' then 'ce000000-0000-4000-8000-00000000000e' end)::uuid $$;
CREATE FUNCTION t.sv(p text) RETURNS uuid LANGUAGE sql AS $$ select v::uuid from t.saved where k = p $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

INSERT INTO auth.users (id, email) VALUES
  (t.x('X0'), 'x0@tenancy.test'), (t.x('X1'), 'x1@tenancy.test'), (t.x('ZO'), 'zo@tenancy.test');
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at) VALUES
  (t.x('X0'), 'x0@tenancy.test', 'دعم صفر', 'support', '01100000090', '2026-09-01'),
  (t.x('X1'), 'x1@tenancy.test', 'دعم واحد', 'support', '01100000091', '2026-09-01'),
  (t.x('ZO'), 'zo@tenancy.test', 'مالك ز', 'user', '01100000092', '2026-09-01');
INSERT INTO public.companies (id, user_id, company_name, commercial_registration_number, tax_id, company_email) VALUES
  (t.x('CZ'), t.x('ZO'), 'شركة ز', 'CR-Z-103', 'TAX-Z', 'z@company.test');

-- ══ ⓪ قبل 103 ═══════════════════════════════════════════════════════════
DO $$
DECLARE u uuid;
BEGIN
  u := (t.own('public.owner_unit_create(''وحدة قبل 103'')') ->> 'unit_id')::uuid;
  INSERT INTO t.saved VALUES ('u0', u);
  PERFORM t.own(format('public.unit_member_set(%L::uuid, %L::uuid)', u, t.x('X0')));
  PERFORM t.ctx(null);
  PERFORM t.ok(t.err_super_ok(format('delete from auth.users where id = %L', t.x('X0'))) = '23514', 'PRE delete blocked by 099 history');
  RAISE NOTICE 'PASS ⓪ قبل 103: حذف حساب له عضوية في الهيكل يفشل (23514) — M1 كما في الإنتاج';
END $$;
INSERT INTO t.saved VALUES ('schema0', t.schema_digest());

-- ══ ① 103 ════════════════════════════════════════════════════════════════
\i migrations/103_admin_hierarchy_followups.sql
SET search_path = public, extensions;
DO $$ BEGIN
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.platform_feature_switches WHERE enabled), 'OBJ switches off');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_constraint WHERE contype = 'f'
                 AND conrelid IN ('public.admin_unit_members'::regclass, 'public.platform_delegations'::regclass, 'public.admin_unit_companies'::regclass)
                 AND confrelid IN ('public.profiles'::regclass, 'public.companies'::regclass)), 'OBJ no FK to accounts/companies');
  PERFORM t.ok(NOT has_function_privilege('authenticated', 'public._hierarchy_release_user(uuid,text)', 'execute')
           AND NOT has_function_privilege('service_role', 'public._session_aal2()', 'execute')
           AND NOT has_function_privilege('anon', 'public._delegations_close_expired(uuid,uuid)', 'execute'), 'OBJ internal closed');
  RAISE NOTICE 'PASS ① 103: المفاتيح مطفأة، لا مفاتيح خارجية من سجل الهيكل، والدوال الداخلية مغلقة';
END $$;
\i migrations/_rollback/103_admin_hierarchy_followups.down.sql
DO $$ BEGIN
  PERFORM t.ok(t.schema_digest() = (SELECT v FROM t.saved WHERE k = 'schema0'), 'RB schema byte-for-byte');
  RAISE NOTICE 'PASS ①ب التراجع: الدوال والمحفّزات والقيود والصلاحيات حرفيًا كما قبل 103';
END $$;
\i migrations/103_admin_hierarchy_followups.sql
\i migrations/103_admin_hierarchy_followups.sql
SET search_path = public, extensions;

-- ══ ② M1 الحذف ═══════════════════════════════════════════════════════════
DO $$
DECLARE u uuid := t.sv('u0'); r jsonb;
BEGIN
  -- عضو بتفويض منتهٍ
  PERFORM t.own(format('public.unit_member_set(%L::uuid, %L::uuid)', u, t.x('X1')));
  PERFORM t.own(format('public.owner_grant_delegation(%L::uuid, %L::uuid, array[''companies.view_registry''], ''تفويض سينتهي ثم يُحذف صاحبه'')', t.x('X1'), u));
  UPDATE public.platform_delegations SET expires_at = granted_at + interval '1 millisecond' WHERE delegate_id = t.x('X1');
  PERFORM t.own(format('public.owner_assign_company_unit(%L::uuid, %L::uuid, ''إسناد شركة ز للوحدة'')', t.x('CZ'), u));
  PERFORM t.ctx(null);
  PERFORM t.ok(t.err_super_ok(format('delete from auth.users where id = %L', t.x('X1'))) = 'ok', 'DEL member with expired delegation');
  PERFORM t.ok(t.err_super_ok(format('delete from auth.users where id = %L', t.x('X0'))) = 'ok', 'DEL pre-103 member');
  PERFORM t.ok((SELECT count(*) FROM public.admin_unit_members WHERE user_id = t.x('X1') AND ended_at IS NOT NULL
                  AND end_reason = 'eligibility_lost:account_deleted') = 1, 'DEL membership kept, ended');
  PERFORM t.ok((SELECT count(*) FROM public.platform_delegations WHERE delegate_id = t.x('X1') AND revoked_at IS NOT NULL) = 1, 'DEL delegation kept, revoked');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.hierarchy_events WHERE action = 'eligibility.lost' AND user_id = t.x('X1')
                         AND detail ->> 'cause' = 'account_deleted'), 'DEL event');
  -- مالك شركة مسندة
  PERFORM t.ok(t.err_super_ok(format('delete from auth.users where id = %L', t.x('ZO'))) = 'ok', 'DEL company owner');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.companies WHERE id = t.x('CZ'))
           AND (SELECT count(*) FROM public.admin_unit_companies WHERE company_id = t.x('CZ') AND ended_at IS NOT NULL
                  AND end_reason = 'company_deleted') = 1, 'DEL company assignment kept, ended');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.hierarchy_events WHERE action = 'company.deleted' AND company_id = t.x('CZ')), 'DEL company event');
  r := t.own('public.owner_hierarchy()');
  PERFORM t.ctx(null);
  PERFORM t.ok(NOT (r::text LIKE '%' || t.x('X1')::text || '%') AND NOT (r::text LIKE '%' || t.x('CZ')::text || '%'), 'DEL console clean');
  RAISE NOTICE 'PASS ② M1: حذف عضو بتفويض منتهٍ ومالك شركة مسندة ينجح؛ العضوية والتفويض والإسناد باقية تاريخًا ومُنهاة بسببها؛ اللوحة نظيفة';
END $$;

-- ══ ③ M2 فقد الأهلية ════════════════════════════════════════════════════
DO $$
DECLARE u uuid := t.sv('u0');
BEGIN
  PERFORM t.sw('delegation_enabled', true);
  PERFORM t.own(format('public.owner_assign_company_unit(%L::uuid, %L::uuid, ''إسناد شركة أ للوحدة'')', t.u('CA'), u));
  PERFORM t.own(format('public.owner_grant_delegation(%L::uuid, %L::uuid, array[''companies.view_registry''], ''سجل شركات الوحدة'')', t.u('AD'), u));
  PERFORM t.ctx(null);
  PERFORM t.ok(jsonb_array_length(t.call(t.u('AD'), 'public.delegate_companies()')) = 1, 'M2 delegation works');
  -- الخفض ثم إعادة الترقية
  PERFORM t.own(format('public.owner_set_staff_role(%L::uuid, ''user'')', t.u('AD')));
  PERFORM t.own(format('public.owner_set_staff_role(%L::uuid, ''admin'')', t.u('AD')));
  PERFORM t.ctx(null);
  PERFORM t.ok(t.call(t.u('AD'), 'public.delegate_companies()') = '[]'::jsonb, 'M2 demote+repromote: no revival');
  PERFORM t.ok((SELECT revoke_reason FROM public.platform_delegations WHERE delegate_id = t.u('AD')) = 'eligibility_lost:role_change', 'M2 revoked role_change');
  -- الحظر ثم رفعه
  PERFORM t.own(format('public.owner_grant_delegation(%L::uuid, %L::uuid, array[''units.manage_members''], ''أعضاء الوحدة للدعم'')', t.u('SUP'), u));
  PERFORM t.own(format('public.unit_member_set(%L::uuid, %L::uuid)', u, t.u('SUP')));
  PERFORM t.ctx(null);
  UPDATE public.profiles SET ban_status = 'banned' WHERE id = t.u('SUP');
  UPDATE public.profiles SET ban_status = 'none' WHERE id = t.u('SUP');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.platform_delegations WHERE delegate_id = t.u('SUP') AND revoked_at IS NULL)
           AND NOT EXISTS (SELECT 1 FROM public.admin_unit_members WHERE user_id = t.u('SUP') AND ended_at IS NULL), 'M2 ban+unban: revoked and ended');
  PERFORM t.ok(t.aal_err(t.u('SUP'), format('public.unit_member_set(%L::uuid, %L::uuid)', u, t.u('EA'))) = '42501', 'M2 ban+unban: no revival');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.hierarchy_events WHERE action = 'eligibility.lost' AND user_id = t.u('SUP') AND detail ->> 'cause' = 'ban'), 'M2 ban event');
  -- ملكية شركة (الفصل)
  PERFORM t.own(format('public.unit_member_set(%L::uuid, %L::uuid)', u, t.u('EA')));
  PERFORM t.ctx(null);
  INSERT INTO public.companies (id, user_id, company_name, commercial_registration_number, tax_id, company_email)
  VALUES (t.x('CE'), t.u('EA'), 'شركة الأدمن', 'CR-E-103', 'TAX-E', 'e@company.test');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.admin_unit_members WHERE user_id = t.u('EA') AND ended_at IS NULL)
           AND (SELECT end_reason FROM public.admin_unit_members WHERE user_id = t.u('EA')) = 'eligibility_lost:company_tie', 'M2 company tie ends membership');
  -- رتبة لا تُفقد الأهلية: لا أثر
  PERFORM t.own(format('public.owner_grant_delegation(%L::uuid, %L::uuid, array[''companies.view_registry'', ''companies.suspend'', ''units.manage_members''], ''سجل وإيقاف وأعضاء الوحدة'')', t.u('AD'), u));
  PERFORM t.own(format('public.owner_set_staff_role(%L::uuid, ''support'')', t.u('AD')));
  PERFORM t.ctx(null);
  PERFORM t.ok(jsonb_array_length(t.call(t.u('AD'), 'public.delegate_companies()')) = 1, 'M2 admin→support keeps eligibility');
  RAISE NOTICE 'PASS ③ M2: الخفض ثم الترقية، والحظر ثم رفعه، وملكية شركة — تُسحب التفويضات وتُنهى العضويات فورًا ولا تعود؛ التغيير بين رتب الطاقم لا يمسّها';
END $$;

-- ══ ④ M3 المفوَّض ═══════════════════════════════════════════════════════
DO $$
DECLARE u uuid := t.sv('u0');
BEGIN
  PERFORM t.ok(t.errfull(t.u('AD'), format('public.delegate_set_company_status(%L::uuid, ''suspended'', ''إيقاف بسبب مخالفة'')', t.u('CA'))) LIKE '42501|%aal2_required%', 'M3 suspend needs aal2');
  PERFORM t.ok((SELECT status FROM public.companies WHERE id = t.u('CA')) <> 'suspended', 'M3 nothing changed without aal2');
  PERFORM t.ok(t.aal_call(t.u('AD'), format('public.delegate_set_company_status(%L::uuid, ''suspended'', ''إيقاف بسبب مخالفة'')', t.u('CA'))) ->> 'changed' = 'true', 'M3 suspend with aal2');
  PERFORM t.ok(t.aal_errfull(t.u('AD'), format('public.delegate_set_company_status(%L::uuid, ''active'', ''إعادة التفعيل من المفوَّض'')', t.u('CA'))) LIKE '42501|%owner_only_reactivation%', 'M3 delegate cannot reactivate');
  PERFORM t.ok((SELECT status FROM public.companies WHERE id = t.u('CA')) = 'suspended', 'M3 still suspended');
  PERFORM t.ok(t.own(format('public.delegate_set_company_status(%L::uuid, ''active'', ''إعادة التفعيل بعد المراجعة'')', t.u('CA'))) ->> 'changed' = 'true', 'M3 owner reactivates');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.hierarchy_events WHERE action = 'company.suspended' AND detail ->> 'as' = 'delegate')
           AND EXISTS (SELECT 1 FROM public.hierarchy_events WHERE action = 'company.reactivated' AND detail ->> 'as' = 'owner'), 'M3 events');
  -- إدارة الأعضاء
  PERFORM t.ok(t.errfull(t.u('AD'), format('public.unit_member_set(%L::uuid, %L::uuid)', u, t.u('SUP'))) LIKE '42501|%aal2_required%', 'M3 member set needs aal2');
  PERFORM t.ok(t.aal_err(t.u('AD'), format('public.unit_member_set(%L::uuid, %L::uuid)', u, t.u('SUP'))) = 'ok', 'M3 member set with aal2');
  PERFORM t.ok(t.err(t.u('AD'), format('public.unit_member_end(%L::uuid, %L::uuid, ''إنهاء عضوية الدعم'')', u, t.u('SUP'))) = '42501', 'M3 member end needs aal2');
  PERFORM t.ok(t.aal_err(t.u('AD'), format('public.unit_member_end(%L::uuid, %L::uuid, ''إنهاء عضوية الدعم'')', u, t.u('SUP'))) = 'ok', 'M3 member end with aal2');
  -- aal1 صريح لا يكفي
  PERFORM set_config('request.jwt.claim.aal', 'aal1', false);
  PERFORM t.ok(t.err(t.u('AD'), format('public.delegate_set_company_status(%L::uuid, ''suspended'', ''إيقاف بجلسة aal1'')', t.u('CA'))) = '42501', 'M3 aal1 refused');
  PERFORM set_config('request.jwt.claim.aal', '', false);
  RAISE NOTICE 'PASS ④ M3: كل فعل كتابة للمفوَّض يحتاج جلسة aal2؛ المفوَّض يوقف ولا يعيد التفعيل؛ إعادة التفعيل للمالك؛ الأحداث تذكر الصفة';
END $$;

-- ══ ⑤ L1 القرار المطبَّق نهائي ══════════════════════════════════════════
DO $$ BEGIN
  PERFORM t.own(format('public.owner_decide_admin_review(%L::uuid, ''keep'', ''يبقى ضمن فريق الدعم'')', t.u('SUP')));
  PERFORM t.own(format('public.owner_apply_admin_review(%L::uuid)', t.u('SUP')));
  PERFORM t.ok(t.own_err(format('public.owner_decide_admin_review(%L::uuid, ''convert_user'', ''تغيير بعد التطبيق'')', t.u('SUP'))) = '55000', 'L1 applied is final');
  PERFORM t.ok((SELECT decision = 'keep' AND applied_at IS NOT NULL FROM public.admin_account_reviews WHERE user_id = t.u('SUP')), 'L1 unchanged');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ⑤ L1: القرار بعد تطبيقه نهائي (55000) ولا يُعاد فتحه';
END $$;

-- ══ ⑥ L2 مانع التحويل ═══════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ok((SELECT scope FROM public.tickets WHERE id = t.k('TA1')) IS DISTINCT FROM 'mad3oom_support'
           AND (SELECT scope FROM public.tickets WHERE id = t.k('TPU')) = 'mad3oom_support', 'L2 precondition scopes');
  PERFORM set_config('app.bypass_ticket_restrictions', 'on', true);
  UPDATE public.tickets SET assigned_to = t.u('EA') WHERE id IN (t.k('TA1'), t.k('TPU'));
  PERFORM set_config('app.bypass_ticket_restrictions', 'off', true);
  PERFORM t.own(format('public.owner_decide_admin_review(%L::uuid, ''convert_support'', ''تحويل إلى فريق الدعم'')', t.u('EA')));
  r := (SELECT e FROM jsonb_array_elements(t.own('public.owner_admin_reviews()')) e WHERE e ->> 'user_id' = t.u('EA')::text);
  PERFORM t.ok((r #>> '{now,open_assigned_tickets}')::int = 1 AND (r #>> '{now,open_company_tickets}')::int = 1
           AND (r ->> 'ready_to_apply')::boolean = false, 'L2 support ticket blocks ' || r::text);
  PERFORM t.ok((t.own(format('public.owner_reassign_admin_tickets(%L::uuid, %L::uuid, ''تسليم قبل التحويل'')', t.u('EA'), t.u('AD'))) ->> 'tickets')::int = 1, 'L2 handover moves support only');
  r := (SELECT e FROM jsonb_array_elements(t.own('public.owner_admin_reviews()')) e WHERE e ->> 'user_id' = t.u('EA')::text);
  PERFORM t.ok((r ->> 'ready_to_apply')::boolean AND (r #>> '{now,open_company_tickets}')::int = 1, 'L2 company ticket informational only');
  PERFORM t.ok(t.own_err(format('public.owner_apply_admin_review(%L::uuid)', t.u('EA'))) = 'ok', 'L2 apply after handover');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ⑥ L2: يمنع التحويل ما تنقله دالة التسليم (تذاكر مدعوم) وحده؛ تذاكر الشركات معروضة للعلم ولا تعلّق التحويل';
END $$;

-- ══ ⑦ L3 التفويض المنتهي ════════════════════════════════════════════════
-- now() ثابت داخل المعاملة: الانتهاء يُفحص في معاملة لاحقة
DO $$
DECLARE u uuid := t.sv('u0'); u2 uuid; r jsonb; d uuid;
BEGIN
  PERFORM t.ok(t.own_err(format('public.owner_grant_delegation(%L::uuid, %L::uuid, array[''companies.view_registry''], ''مدة أطول من 90 يومًا'', now() + interval ''100 days'')', t.u('AD'), u)) = '22023', 'L3 max 90 days');
  PERFORM t.ok(t.own_err(format('public.owner_grant_delegation(%L::uuid, %L::uuid, array[''companies.view_registry''], ''تاريخ انتهاء ماضٍ'', now() - interval ''1 day'')', t.u('AD'), u)) = '22023', 'L3 no past expiry');
  u2 := (t.own('public.owner_unit_create(''وحدة مؤقتة'')') ->> 'unit_id')::uuid;
  r := t.own(format('public.owner_grant_delegation(%L::uuid, %L::uuid, array[''companies.view_registry''], ''منح بالمدة الافتراضية'')', t.u('AD'), u2));
  d := (r ->> 'delegation_id')::uuid;
  PERFORM t.ok((SELECT expires_at BETWEEN now() + interval '7 days' - interval '1 minute' AND now() + interval '7 days' + interval '1 minute'
                  FROM public.platform_delegations WHERE id = d), 'L3 default 7 days');
  UPDATE public.platform_delegations SET expires_at = granted_at + interval '1 microsecond' WHERE id = d;
  PERFORM t.ctx(null);
  INSERT INTO t.saved VALUES ('u2', u2), ('d_exp', d);
END $$;
SELECT pg_sleep(0.05);
DO $$
DECLARE u2 uuid := t.sv('u2'); d uuid := t.sv('d_exp'); r jsonb;
BEGIN
  r := t.own('public.owner_hierarchy()');
  PERFORM t.ok(NOT (r::text LIKE '%' || d::text || '%'), 'L3 console hides expired');
  -- منح جديد لنفس المفوَّض والوحدة: المنتهي يُغلق بدل أن يمنع
  PERFORM t.ok(t.own_err(format('public.owner_grant_delegation(%L::uuid, %L::uuid, array[''companies.view_registry''], ''منح جديد بعد الانتهاء'')', t.u('AD'), u2)) = 'ok', 'L3 regrant after expiry');
  PERFORM t.ok((SELECT revoke_reason FROM public.platform_delegations WHERE id = d) = 'expired', 'L3 expired closed');
  UPDATE public.platform_delegations SET expires_at = granted_at + interval '1 microsecond' WHERE unit_id = u2 AND revoked_at IS NULL;
  PERFORM t.ctx(null);
END $$;
SELECT pg_sleep(0.05);
DO $$ BEGIN
  -- الأرشفة لا يمنعها تفويض منتهٍ
  PERFORM t.ok(t.own_err(format('public.owner_unit_archive(%L::uuid, ''الوحدة المؤقتة لم تعد لازمة'')', t.sv('u2'))) = 'ok', 'L3 archive ignores expired');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ⑦ L3: المدة الافتراضية 7 أيام وأقصاها 90؛ المنتهي لا يظهر في اللوحة ولا يمنع منحًا جديدًا ولا أرشفة، ويُغلق بسبب expired';
END $$;

-- ══ ⑧ ترتيب التراجع ═════════════════════════════════════════════════════
\set rb099 `cat migrations/_rollback/099_admin_hierarchy.down.sql`
\set rb103 `cat migrations/_rollback/103_admin_hierarchy_followups.down.sql`
SELECT set_config('t.rb099', :'rb099', false) IS NOT NULL, set_config('t.rb103', :'rb103', false) IS NOT NULL;
DO $$
DECLARE s text;
BEGIN
  PERFORM t.sw('delegation_enabled', false);
  s := t.schema_digest();
  BEGIN
    EXECUTE current_setting('t.rb099');
    RAISE EXCEPTION 'FAIL RB099 allowed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%100 مطبَّق%' THEN RAISE; END IF;
  END;
  BEGIN
    EXECUTE current_setting('t.rb103');
    RAISE EXCEPTION 'FAIL RB103 allowed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%محذوفة%' THEN RAISE; END IF;
  END;
  PERFORM t.ok(t.schema_digest() = s AND to_regclass('public.admin_units') IS NOT NULL, 'RB nothing changed');
  RAISE NOTICE 'PASS ⑧ التراجع: 099 مرفوض قبل أي تغيير ما دام 100 مطبَّقًا، و103 مرفوض مع سجل لحساب أو شركة محذوفة';
END $$;

SELECT 'ALL admin-hierarchy-followups tests passed';
