-- ============================================================================
-- 109_registration_mode_public_read على نسخة مطابقة للإنتاج حتى 107
--   ⓪ قبل 109: العطل كما في الإنتاج — قراءة الزائر لـ registration_mode تفشل بـ 42501
--   ① الكائنات؛ ①ب التراجع حرفيًا ثم إعادة التطبيق مرتين
--   ② الزائر: يقرأ صف registration_mode وحده، والدالة العامة تعيد ثلاثة حقول فقط
--   ③ الزائر: لا يكتب، لا يرى profiles، لا ينفّذ دوال الإدارة، ولا يعتمد نفسه في الانتظار
--   ④ مستخدم مسجَّل عادي: يقرأ الإعداد العام فقط ولا يعدّل أي إعداد
--   ⑤ الأدمن: يرى ويدير كل الإعدادات كما قبل
--   ⑥ قيم mode غير الصالحة أو الصف الغائب ⇒ null (الواجهة لا تفتح التسجيل)
--   ⑦ بوابة الحساب بعد الدخول بلا تغيير، وتقرأ الموعد والرسالة نفسهما
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

-- ── أدوات الزائر (anon بلا هوية، كما يرسل PostgREST طلب الزائر) ─────────────
CREATE FUNCTION t.anon_call(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
declare v jsonb;
begin
  perform t.act(null);
  execute 'set local role anon';
  execute 'select to_jsonb((' || p_sql || '))' into v;
  execute 'reset role';
  return v;
exception when others then
  raise;
end $$;
CREATE FUNCTION t.anon_err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  perform t.anon_call(p_sql);
  return 'ok';
exception when others then
  return sqlstate;
end $$;
CREATE FUNCTION t.anon_rows(p_from_where text) RETURNS int LANGUAGE plpgsql AS $$
declare n int;
begin
  perform t.act(null);
  execute 'set local role anon';
  execute 'select count(*)::int from ' || p_from_where into n;
  execute 'reset role';
  return n;
end $$;
CREATE FUNCTION t.anon_rows_or_err(p_from_where text) RETURNS text LANGUAGE plpgsql AS $$
begin
  return t.anon_rows(p_from_where)::text;
exception when others then
  return sqlstate;
end $$;
CREATE FUNCTION t.anon_exec(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  perform t.act(null);
  execute 'set local role anon';
  execute p_sql;
  execute 'reset role';
  return 'ok';
exception when others then
  return sqlstate;
end $$;
CREATE FUNCTION t.policy_roles(p_name text) RETURNS text LANGUAGE sql AS $$
  select roles::text from pg_policies where schemaname = 'public' and tablename = 'advanced_settings' and policyname = p_name $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ── البيانات: الإعداد العام كما في الإنتاج اليوم + إعداد خاص لا يجوز أن يراه الزائر ──
INSERT INTO public.advanced_settings (key, value) VALUES
  ('registration_mode', jsonb_build_object(
      'mode', 'waitlist',
      'waitlist_message', 'شكرًا لتسجيلك في مدعوم.' || E'\n\n' || 'موعد الإطلاق المتوقع: {{launch_date}}',
      'expected_launch_date', 'يناير 2027')),
  ('t_private_setting', jsonb_build_object('secret', 'should-never-reach-anon'))
ON CONFLICT (key) DO UPDATE SET value = excluded.value;

-- حساب جديد بعد تفعيل البوابة، غير معتمَد (لاختبار ⑦)
INSERT INTO auth.users (id, email) VALUES ('0f000000-0000-4000-8000-0000000000f1', 'fresh@tenancy.test');
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at)
VALUES ('0f000000-0000-4000-8000-0000000000f1', 'fresh@tenancy.test', 'حساب جديد', 'user', '01100000091', now());

INSERT INTO t.saved VALUES ('schema107', t.schema_digest());

-- ══ ⓪ قبل 109: العطل كما في الإنتاج ════════════════════════════════════════
DO $$ BEGIN
  PERFORM t.ok(t.policy_roles('Admins can manage advanced_settings') = '{public}', 'PRE admin policy applies to public');
  PERFORM t.ok(t.anon_rows_or_err($q$public.advanced_settings where key = 'registration_mode'$q$) = '42501',
               'PRE anon read of registration_mode fails with 42501');
  PERFORM t.ok(NOT has_function_privilege('anon', 'public.has_elevated_authority()', 'execute'),
               'PRE has_elevated_authority not executable by anon (correct, stays so)');
  RAISE NOTICE 'PASS ⓪ قبل 109: قراءة الزائر لوضع التسجيل تفشل بـ 42501 (has_elevated_authority عبر سياسة الإدارة)';
END $$;

-- ══ ① 109، التراجع، وإعادة التطبيق ═════════════════════════════════════════
\i migrations/109_registration_mode_public_read.sql
DO $$ BEGIN
  PERFORM t.ok(t.policy_roles('Admins can manage advanced_settings') = '{authenticated}', 'OBJ admin policy authenticated only');
  PERFORM t.ok(t.policy_roles('advanced_settings_public_read_registration_mode') = '{anon,authenticated}', 'OBJ public read policy unchanged');
  PERFORM t.ok((SELECT qual FROM pg_policies WHERE tablename = 'advanced_settings' AND policyname = 'Admins can manage advanced_settings')
               LIKE '%profiles.role = ''admin''%', 'OBJ admin policy predicate unchanged');
  PERFORM t.ok(has_function_privilege('anon', 'public.get_public_registration_settings()', 'execute'), 'OBJ rpc anon exec');
  PERFORM t.ok(has_function_privilege('authenticated', 'public.get_public_registration_settings()', 'execute'), 'OBJ rpc auth exec');
  PERFORM t.ok((SELECT prosecdef FROM pg_proc WHERE oid = 'public.get_public_registration_settings()'::regprocedure), 'OBJ rpc security definer');
  PERFORM t.ok(NOT has_table_privilege('anon', 'public.advanced_settings', 'INSERT')
           AND NOT has_table_privilege('anon', 'public.advanced_settings', 'UPDATE')
           AND NOT has_table_privilege('anon', 'public.advanced_settings', 'DELETE')
           AND NOT has_table_privilege('anon', 'public.advanced_settings', 'TRUNCATE')
           AND has_table_privilege('anon', 'public.advanced_settings', 'SELECT'), 'OBJ anon grants: select only');
  PERFORM t.ok(has_table_privilege('authenticated', 'public.advanced_settings', 'UPDATE'), 'OBJ authenticated grants untouched');
  PERFORM t.ok(NOT has_function_privilege('anon', 'public.has_elevated_authority()', 'execute'), 'OBJ no new anon grant on privileged function');
  RAISE NOTICE 'PASS ① الكائنات: سياسة الإدارة لـ authenticated بنفس الشرط، دالة عامة ضيقة، والزائر SELECT فقط';
END $$;

\i migrations/_rollback/109_registration_mode_public_read.down.sql
DO $$ BEGIN
  PERFORM t.ok(t.schema_digest() = (SELECT v FROM t.saved WHERE k = 'schema107'), 'RB schema digest');
  PERFORM t.ok(t.policy_roles('Admins can manage advanced_settings') = '{public}', 'RB policy roles restored');
  PERFORM t.ok(to_regprocedure('public.get_public_registration_settings()') IS NULL, 'RB rpc dropped');
  PERFORM t.ok(has_table_privilege('anon', 'public.advanced_settings', 'TRUNCATE')
           AND has_table_privilege('anon', 'public.advanced_settings', 'INSERT'), 'RB anon grants restored');
  PERFORM t.ok(t.anon_rows_or_err($q$public.advanced_settings where key = 'registration_mode'$q$) = '42501', 'RB defect back');
  RAISE NOTICE 'PASS ①ب التراجع: الشكل كما قبل 109 حرفيًا (والعطل يعود، ما يثبت أن الاختبار يقيسه)';
END $$;
\i migrations/109_registration_mode_public_read.sql
\i migrations/109_registration_mode_public_read.sql
DO $$ BEGIN
  PERFORM t.ok(t.policy_roles('Admins can manage advanced_settings') = '{authenticated}', 'RE idempotent');
  RAISE NOTICE 'PASS ①ج إعادة التطبيق مرتين بلا خطأ';
END $$;

-- ══ ② الزائر يقرأ الإعداد العام وحده ═══════════════════════════════════════
DO $$
DECLARE v jsonb;
BEGIN
  PERFORM t.ok(t.anon_rows($q$public.advanced_settings where key = 'registration_mode'$q$) = 1, 'ANON reads registration_mode row');
  PERFORM t.ok(t.anon_rows('public.advanced_settings') = 1, 'ANON sees exactly one settings row');
  PERFORM t.ok(t.anon_rows($q$public.advanced_settings where key = 't_private_setting'$q$) = 0, 'ANON cannot see private setting');
  v := t.anon_call('public.get_public_registration_settings()');
  PERFORM t.ok((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v) k) = array['expected_launch_date','mode','waitlist_message'],
               'ANON rpc returns exactly three keys');
  PERFORM t.ok(v->>'mode' = 'waitlist' AND v->>'expected_launch_date' = 'يناير 2027'
               AND v->>'waitlist_message' LIKE 'شكرًا لتسجيلك في مدعوم.%', 'ANON rpc values');
  PERFORM t.ok(position('should-never-reach-anon' in v::text) = 0, 'ANON rpc never leaks other settings');
  RAISE NOTICE 'PASS ② الزائر: صف registration_mode وحده، والدالة العامة ثلاثة حقول فقط';
END $$;

-- ══ ③ الزائر لا يكتب ولا يرى profiles ولا ينفّذ دوال الإدارة ══════════════════
DO $$ BEGIN
  PERFORM t.ok(t.anon_exec($q$update public.advanced_settings set value = '{"mode":"open"}' where key = 'registration_mode'$q$) = '42501', 'ANON update denied');
  PERFORM t.ok(t.anon_exec($q$insert into public.advanced_settings (key, value) values ('x', '{}')$q$) = '42501', 'ANON insert denied');
  PERFORM t.ok(t.anon_exec($q$delete from public.advanced_settings$q$) = '42501', 'ANON delete denied');
  PERFORM t.ok(t.anon_exec($q$truncate public.advanced_settings$q$) = '42501', 'ANON truncate denied');
  PERFORM t.ok((SELECT value->>'mode' FROM public.advanced_settings WHERE key = 'registration_mode') = 'waitlist', 'ANON writes left value intact');
  PERFORM t.ok(t.anon_rows_or_err('public.profiles') IN ('0', '42501'), 'ANON reads no profile rows');
  PERFORM t.ok(t.anon_err('public.has_elevated_authority()') = '42501', 'ANON cannot run has_elevated_authority');
  PERFORM t.ok(t.anon_err('public.is_admin()') = '42501', 'ANON cannot run is_admin');
  PERFORM t.ok(t.anon_err('public.my_account_gate()') = '42501', 'ANON cannot run my_account_gate');
  PERFORM t.ok(t.anon_exec($q$insert into public.waitlist_entries (name, email, phone, status) values ('x', 'self-approve@t.test', '01100000092', 'approved')$q$) = '42501',
               'ANON cannot self-approve on waitlist');
  PERFORM t.ok(t.anon_exec($q$insert into public.waitlist_entries (name, email, phone) values ('زائر', 'visitor@t.test', '01100000093')$q$) = 'ok',
               'ANON can still submit a pending waitlist entry (the waitlist form keeps working)');
  PERFORM t.ok(t.anon_rows_or_err('public.waitlist_entries') IN ('0', '42501'), 'ANON cannot read waitlist entries back');
  RAISE NOTICE 'PASS ③ الزائر: لا كتابة على الإعدادات، لا صفوف profiles، لا دوال إدارة، لا اعتماد ذاتي، ونموذج الانتظار يعمل';
END $$;

-- ══ ④ مستخدم مسجَّل عادي ═══════════════════════════════════════════════════
DO $$ BEGIN
  PERFORM t.ok(t.rows(t.u('PU'), $q$public.advanced_settings where key = 'registration_mode'$q$) = 1, 'USER reads public setting');
  PERFORM t.ok(t.rows(t.u('PU'), $q$public.advanced_settings where key = 't_private_setting'$q$) = 0, 'USER cannot read private setting');
  PERFORM t.ok(t.affected(t.u('PU'), $q$update public.advanced_settings set value = '{"mode":"open"}' where key = 'registration_mode'$q$) = 0, 'USER update affects 0 rows');
  PERFORM t.ok(t.exec(t.u('PU'), $q$insert into public.advanced_settings (key, value) values ('t_user_insert', '{}')$q$) = '42501', 'USER insert denied');
  PERFORM t.ok(t.affected(t.u('PU'), $q$delete from public.advanced_settings where key = 'registration_mode'$q$) = 0, 'USER delete affects 0 rows');
  PERFORM t.ok((SELECT value->>'mode' FROM public.advanced_settings WHERE key = 'registration_mode') = 'waitlist', 'USER left value intact');
  PERFORM t.ok(t.call(t.u('PU'), 'public.get_public_registration_settings()')->>'mode' = 'waitlist', 'USER rpc works');
  RAISE NOTICE 'PASS ④ المستخدم العادي: يقرأ الإعداد العام فقط ولا يعدّل شيئًا';
END $$;

-- ══ ⑤ الأدمن يدير الإعدادات كما قبل ════════════════════════════════════════
DO $$ BEGIN
  PERFORM t.ok(t.rows(t.u('AD'), 'public.advanced_settings') >= 2, 'ADMIN sees all settings');
  PERFORM t.ok(t.affected(t.u('AD'), $q$update public.advanced_settings set value = jsonb_set(value, '{expected_launch_date}', '"t-admin-edit"') where key = 'registration_mode'$q$) = 1,
               'ADMIN updates registration_mode');
  PERFORM t.ok((SELECT value->>'expected_launch_date' FROM public.advanced_settings WHERE key = 'registration_mode') = 't-admin-edit', 'ADMIN edit persisted');
  PERFORM t.ok(t.exec(t.u('AD'), $q$insert into public.advanced_settings (key, value) values ('t_admin_insert', '{}')$q$) = 'ok', 'ADMIN inserts');
  PERFORM t.ok(t.affected(t.u('AD'), $q$delete from public.advanced_settings where key = 't_admin_insert'$q$) = 1, 'ADMIN deletes');
  PERFORM t.ok(t.affected(t.u('AD'), $q$update public.advanced_settings set value = jsonb_set(value, '{expected_launch_date}', '"يناير 2027"') where key = 'registration_mode'$q$) = 1, 'ADMIN restores');
  RAISE NOTICE 'PASS ⑤ الأدمن: يرى ويضيف ويعدّل ويحذف الإعدادات كما قبل 109';
END $$;

-- ══ ⑥ قيم غير صالحة أو صف غائب ⇒ null ═══════════════════════════════════════
DO $$ BEGIN
  UPDATE public.advanced_settings SET value = jsonb_set(value, '{mode}', '"open"') WHERE key = 'registration_mode';
  PERFORM t.ok(t.anon_call('public.get_public_registration_settings()')->>'mode' = 'open', 'MODE open');
  UPDATE public.advanced_settings SET value = jsonb_set(value, '{mode}', '"closed"') WHERE key = 'registration_mode';
  PERFORM t.ok(t.anon_call('public.get_public_registration_settings()')->'mode' = 'null'::jsonb, 'MODE invalid -> null');
  UPDATE public.advanced_settings SET value = value - 'mode' WHERE key = 'registration_mode';
  PERFORM t.ok(t.anon_call('public.get_public_registration_settings()')->'mode' = 'null'::jsonb, 'MODE missing -> null');
  UPDATE public.advanced_settings SET value = jsonb_set(value, '{mode}', '"waitlist"') WHERE key = 'registration_mode';
  RAISE NOTICE 'PASS ⑥ mode غير صالح أو مفقود ⇒ null، والصالح يُعاد كما هو';
END $$;
DO $$
DECLARE v jsonb;
BEGIN
  CREATE TEMP TABLE t_saved_reg AS SELECT value FROM public.advanced_settings WHERE key = 'registration_mode';
  DELETE FROM public.advanced_settings WHERE key = 'registration_mode';
  v := t.anon_call('public.get_public_registration_settings()');
  PERFORM t.ok(v IS NULL OR v = 'null'::jsonb, 'ROW missing -> null');
  INSERT INTO public.advanced_settings (key, value) SELECT 'registration_mode', value FROM t_saved_reg;
  RAISE NOTICE 'PASS ⑥ب الصف الغائب ⇒ null';
END $$;

-- ══ ⑦ بوابة الحساب بعد الدخول ══════════════════════════════════════════════
DO $$
DECLARE g jsonb;
BEGIN
  g := t.call('0f000000-0000-4000-8000-0000000000f1'::uuid, 'public.my_account_gate()');
  PERFORM t.ok(g->>'status' = 'waiting_approval', 'GATE new account waits: ' || coalesce(g->>'status', 'null'));
  PERFORM t.ok(g->>'launch_date' = 'يناير 2027', 'GATE launch date from setting');
  PERFORM t.ok(g->>'message' LIKE 'شكرًا لتسجيلك في مدعوم.%', 'GATE message from setting');
  g := t.call(t.u('AD'), 'public.my_account_gate()');
  PERFORM t.ok(g->>'status' = 'active', 'GATE admin active: ' || coalesce(g->>'status', 'null'));
  RAISE NOTICE 'PASS ⑦ البوابة: الحساب الجديد في الانتظار بالموعد والرسالة نفسهما، والأدمن نشط';
END $$;

\echo ALL 109 TESTS PASSED
