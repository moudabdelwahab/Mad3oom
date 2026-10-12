-- ============================================================================
-- فريق الشركة (086_company_staff) على نسخة مطابقة لشكل الإنتاج
--
-- قرار المالك D2 (2026-10-12): التابعون الحاليون عملاء افتراضيًا، ومدير الشركة
-- يضيف الموظفين صراحةً. القاعدة R1: طاقم المنصة وسياق المالك لا يمنحان شيئًا
-- في نطاق شركة أخرى.
--
--   ⓪ قبل 086: بصمات ما لا يجوز أن يتغيّر
--   ① 086: الكائنات والصلاحيات
--   ② الأدوار: المالك مدير، التابع عميل، الطاقم والمالك المنصّي لا شيء
--   ③ المنح والتغيير والتكرار، والرفض (عبر الشركات، المالك، الدور، غير المفعّل)
--   ④ القائمة: للفريق فقط، بلا بريد، بلا تسرّب بين الشركات
--   ⑤ أهلية المستلم
--   ⑥ الإلغاء وإعادة المنح
--   ⑦ ترك الشركة يلغي الدور، والعودة لا تعيده
--   ⑧ حرّاس الجداول
--   ⑨ التزامن بجلستين حقيقيتين (dblink)
--   ⑩ عدم المساس، إعادة التشغيل، التراجع، إعادة التطبيق
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

\i tests/fixtures/prod-shape/load.sql
SET search_path = public, extensions;

DROP SCHEMA IF EXISTS t CASCADE;
CREATE SCHEMA t;
CREATE EXTENSION IF NOT EXISTS dblink SCHEMA t;
GRANT USAGE ON SCHEMA t TO authenticated, service_role, anon;

-- ── أدوات ─────────────────────────────────────────────────────────────────
CREATE FUNCTION t.act(p uuid) RETURNS void LANGUAGE sql AS $$
  select set_config('request.jwt.claim.sub', coalesce(p::text, ''), false),
         set_config('request.jwt.claim.role', case when p is null then '' else 'authenticated' end, false),
         set_config('request.jwt.claims', case when p is null then ''
                      else jsonb_build_object('sub', p, 'role', 'authenticated')::text end, false); $$;
CREATE FUNCTION t.call(p uuid, p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
declare v jsonb;
begin
  perform t.act(p);
  execute 'set local role authenticated';
  execute 'select to_jsonb((' || p_sql || '))' into v;
  execute 'reset role';
  perform t.act(null);
  return v;
exception when others then
  perform t.act(null);
  raise;
end $$;
CREATE FUNCTION t.err(p uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  perform t.call(p, p_sql);
  return 'ok';
exception when others then
  return sqlstate;
end $$;
CREATE FUNCTION t.errfull(p uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
declare m text; d text;
begin
  perform t.call(p, p_sql);
  return 'ok';
exception when others then
  get stacked diagnostics m = message_text, d = pg_exception_detail;
  return sqlstate || '|' || m || '|' || coalesce(d, '');
end $$;
CREATE FUNCTION t.err_stmt(p uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  perform t.act(p);
  execute 'set local role authenticated';
  execute p_sql;
  execute 'reset role';
  perform t.act(null);
  return 'ok';
exception when others then
  perform t.act(null);
  return sqlstate;
end $$;
CREATE FUNCTION t.err_anon(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  perform t.act(null);
  execute 'set local role anon';
  execute p_sql;
  execute 'reset role';
  return 'ok';
exception when others then
  return sqlstate;
end $$;
-- جملة كمالك القاعدة (لاختبار الحرّاس نفسها، لا الصلاحيات)
CREATE FUNCTION t.err_super(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end $$;
CREATE FUNCTION t.ok(p_cond boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
begin
  if p_cond is distinct from true then raise exception 'FAIL %', p_label; end if;
end $$;
CREATE FUNCTION t.u(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  select (case p
    when 'OA'  then '00000000-0000-4000-8000-000000000101' when 'OB'  then '00000000-0000-4000-8000-000000000102'
    when 'OC'  then '00000000-0000-4000-8000-000000000103' when 'OW'  then '00000000-0000-4000-8000-0000000001f0'
    when 'A1'  then '00000000-0000-4000-8000-000000000111' when 'A2'  then '00000000-0000-4000-8000-000000000112'
    when 'A3'  then '00000000-0000-4000-8000-000000000113' when 'A4'  then '00000000-0000-4000-8000-000000000114'
    when 'B1'  then '00000000-0000-4000-8000-000000000121' when 'PU'  then '00000000-0000-4000-8000-000000000131'
    when 'SUP' then '00000000-0000-4000-8000-000000000141' when 'AD'  then '00000000-0000-4000-8000-000000000142'
    when 'EA'  then '00000000-0000-4000-8000-000000000143' when 'NOPE' then '00000000-0000-4000-8000-0000000001ee'
    when 'CA'  then 'c0000000-0000-4000-8000-00000000000a' when 'CB'  then 'c0000000-0000-4000-8000-00000000000b'
    when 'CC'  then 'c0000000-0000-4000-8000-00000000000c' when 'CW'  then 'c0000000-0000-4000-8000-00000000000f'
  end)::uuid $$;
CREATE FUNCTION t.ctx(p_context text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
begin
  perform set_config('app.owner_context_write', 'on', true);
  insert into public.owner_context_state (user_id, context, entered_at, expires_at)
  values (t.u('OW'), p_context, now(), now() + interval '12 hours')
  on conflict (user_id) do update set context = excluded.context, entered_at = excluded.entered_at,
                                      expires_at = excluded.expires_at;
  perform set_config('app.owner_context_write', 'off', true);
end $$;
CREATE FUNCTION t.role(p text) RETURNS text LANGUAGE sql AS $$
  select t.call(t.u(p), 'public.company_staff_role()') #>> '{}' $$;
CREATE FUNCTION t.set_sql(p_user text, p_role text) RETURNS text LANGUAGE sql AS $$
  select format('public.company_staff_set(%L::uuid, %L)', t.u(p_user), p_role) $$;
CREATE FUNCTION t.rv_sql(p_user text) RETURNS text LANGUAGE sql AS $$
  select format('public.company_staff_revoke(%L::uuid)', t.u(p_user)) $$;
-- بصمة الجداول التي لا يجوز أن يغيّرها 086
CREATE FUNCTION t.untouched_digest() RETURNS text LANGUAGE sql AS $$
  select md5(concat_ws('#',
    (select string_agg(md5(x::text), ',' order by x.id) from public.companies x),
    (select string_agg(md5(x::text), ',' order by x.id) from public.chat_sessions x),
    (select string_agg(md5(x::text), ',' order by x.id) from public.chat_messages x),
    (select string_agg(md5(x::text), ',' order by x.session_id) from public.inbox_conversations x),
    (select string_agg(md5(x::text), ',' order by x.id) from public.notifications x),
    (select string_agg(md5(x::text), ',' order by x.id) from public.tickets x))) $$;
CREATE FUNCTION t.fn_digest() RETURNS text LANGUAGE sql AS $$
  select md5(string_agg(pg_get_functiondef(f::regprocedure), '#' order by f))
    from unnest(array['public.company_members()', 'public.remove_company_member(uuid)',
                      'public.can_manage_company_members()', 'public.current_company_id()',
                      'public.is_company_admin()', 'public.is_company_member()',
                      'public.sync_company_role()', 'public.inbox_can_access(uuid)']) f $$;
CREATE FUNCTION t.policy_digest() RETURNS text LANGUAGE sql AS $$
  select md5(string_agg(concat_ws('|', tablename, policyname, permissive, cmd, qual, with_check), '#'
                        order by tablename, policyname))
    from pg_policies where schemaname in ('public', 'storage')
     and tablename not in ('company_staff', 'company_staff_events') $$;
CREATE TABLE t.saved (k text PRIMARY KEY, v text);
SET check_function_bodies = off;
CREATE FUNCTION t.active_rows(p_user text) RETURNS int LANGUAGE sql AS $$
  select count(*)::int from public.company_staff where user_id = t.u(p_user) and revoked_at is null $$;
CREATE FUNCTION t.events(p_user text) RETURNS text LANGUAGE sql AS $$
  select coalesce(string_agg(action || ':' || coalesce(role_from, '-') || '>' || coalesce(role_to, '-')
                             || ':' || coalesce(cause, '-'), ',' order by id), '')
    from public.company_staff_events where target_id = t.u(p_user) $$;
RESET check_function_bodies;
CREATE FUNCTION t.conn(p_name text, p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
begin
  perform t.dblink_connect(p_name, format('dbname=%s port=%s host=%s user=postgres', current_database(),
          current_setting('port'), split_part(current_setting('unix_socket_directories'), ',', 1)));
  perform t.dblink_exec(p_name, s) from (values
    ('set search_path = public, extensions'),
    (format('set request.jwt.claim.sub = %L', p_user)), ($s$set request.jwt.claim.role = 'authenticated'$s$),
    (format('set request.jwt.claims = %L', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text)),
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

-- ── الفاعلون ──────────────────────────────────────────────────────────────
--  OA مالك الشركة أ (اشتراك يشمل sub_users) · OB مالك ب (نفس الاشتراك)
--  OC مالك ج (اشتراك واتساب فقط: لا sub_users) · OW مالك المنصة، ويملك شركة W
--  A1..A4 تابعو أ (A4 محظور) · B1 تابع ب · PU مستخدم عادي
--  SUP دعم · AD أدمن · EA أدمن مرتفع
INSERT INTO auth.users (id, email)
SELECT t.u(n), lower(n) || '@t.io'
  FROM unnest(array['OA','OB','OC','OW','A1','A2','A3','A4','B1','PU','SUP','AD','EA']) n;
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at) VALUES
  (t.u('OA'),  'oa@t.io',  'مالك أ',      'user',           '01000000101', '2026-09-01'),
  (t.u('OB'),  'ob@t.io',  'مالك ب',      'user',           '01000000102', '2026-09-01'),
  (t.u('OC'),  'oc@t.io',  'مالك ج',      'user',           '01000000103', '2026-09-01'),
  (t.u('OW'),  'ow@t.io',  'مالك المنصة', 'platform_owner', '01000000104', '2026-09-01'),
  (t.u('PU'),  'pu@t.io',  'مستخدم',      'user',           '01000000131', '2026-09-01'),
  (t.u('SUP'), 'sup@t.io', 'دعم',         'support',        '01000000141', '2026-09-01'),
  (t.u('AD'),  'ad@t.io',  'أدمن',        'admin',          '01000000142', '2026-09-01'),
  (t.u('EA'),  'ea@t.io',  'أدمن مرتفع',  'admin',          '01000000143', '2026-09-01');
INSERT INTO public.platform_authority (user_id, level) VALUES (t.u('OW'), 'owner'), (t.u('EA'), 'elevated_admin');
INSERT INTO public.companies (id, user_id, company_name, commercial_registration_number) VALUES
  (t.u('CA'), t.u('OA'), 'شركة أ', 'CR-A'), (t.u('CB'), t.u('OB'), 'شركة ب', 'CR-B'),
  (t.u('CC'), t.u('OC'), 'شركة ج', 'CR-C'), (t.u('CW'), t.u('OW'), 'شركة المالك', 'CR-W');
INSERT INTO public.profiles (id, email, full_name, role, phone, super_user_id, created_at) VALUES
  (t.u('A1'), 'a1@t.io', 'تابع أ1', 'user', '01000000111', t.u('OA'), '2026-09-01'),
  (t.u('A2'), 'a2@t.io', 'تابع أ2', 'user', '01000000112', t.u('OA'), '2026-09-01'),
  (t.u('A3'), 'a3@t.io', 'تابع أ3', 'user', '01000000113', t.u('OA'), '2026-09-01'),
  (t.u('A4'), 'a4@t.io', 'تابع أ4', 'user', '01000000114', t.u('OA'), '2026-09-01'),
  (t.u('B1'), 'b1@t.io', 'تابع ب1', 'user', '01000000121', t.u('OB'), '2026-09-01');
UPDATE public.profiles SET ban_status = 'banned' WHERE id = t.u('A4');
INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, company_id) VALUES
  (t.u('OA'), 'support',  'active', 'monthly', now() - interval '5 days', now() + interval '25 days', 30, t.u('CA')),
  (t.u('OB'), 'support',  'active', 'monthly', now() - interval '5 days', now() + interval '25 days', 30, t.u('CB')),
  (t.u('OC'), 'whatsapp', 'active', 'monthly', now() - interval '5 days', now() + interval '25 days', 30, t.u('CC')),
  (t.u('OW'), 'support',  'active', 'monthly', now() - interval '5 days', now() + interval '25 days', 30, t.u('CW'));

-- ══ ⓪ قبل 086 ════════════════════════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ok((SELECT role FROM public.profiles WHERE id = t.u('OA')) = 'company_admin', 'SETUP OA company_admin');
  PERFORM t.ok((SELECT role FROM public.profiles WHERE id = t.u('A1')) = 'company_user', 'SETUP A1 company_user');
  PERFORM t.ok((SELECT role FROM public.profiles WHERE id = t.u('B1')) = 'company_user', 'SETUP B1 company_user');
  PERFORM t.act(t.u('OA'));
  PERFORM t.ok(public.account_is_active() AND public.is_company_admin() AND public.can_manage_company_members(), 'SETUP OA manages');
  PERFORM t.act(t.u('OC'));
  PERFORM t.ok(public.is_company_admin() AND NOT public.can_manage_company_members(), 'SETUP OC no sub_users');
  PERFORM t.act(t.u('A1'));
  PERFORM t.ok(public.account_is_active() AND public.is_company_member(), 'SETUP A1 member');
  PERFORM t.act(t.u('A4'));
  PERFORM t.ok(NOT public.account_is_active(), 'SETUP A4 banned');
  PERFORM t.act(null);
  -- قبل 086: التابع والعميل واحد — هذا ما تصلحه الزيادة 1
  PERFORM t.ok(t.call(t.u('A1'), 'public.company_members()') -> 'members' @> jsonb_build_array(jsonb_build_object('id', t.u('A2'))),
               'SETUP A1 يرى بقية التابعين عبر company_members (سلوك قائم)');
  RAISE NOTICE 'PASS ⓪ الإعداد: ثلاث شركات + شركة لمالك المنصة + تابعون + طاقم منصة';
END $$;
INSERT INTO t.saved VALUES ('untouched', t.untouched_digest()), ('fn', t.fn_digest()), ('pol', t.policy_digest()),
  ('members_oa', (t.call(t.u('OA'), 'public.company_members()'))::text);

-- ══ ① 086 ════════════════════════════════════════════════════════════════
\i migrations/086_company_staff.sql

DO $$
BEGIN
  PERFORM t.ok(to_regclass('public.company_staff') IS NOT NULL AND to_regclass('public.company_staff_events') IS NOT NULL, '① الجداول');
  PERFORM t.ok((SELECT count(*) FROM public.company_staff) = 0, '① لا ترقية تلقائية لأي تابع (D2)');
  PERFORM t.ok(NOT has_function_privilege('anon', 'public.company_staff_list()', 'EXECUTE')
               AND NOT has_function_privilege('service_role', 'public.company_staff_set(uuid,text)', 'EXECUTE')
               AND NOT has_function_privilege('service_role', 'public.company_staff_list()', 'EXECUTE')
               AND NOT has_function_privilege('authenticated', 'public._company_staff_role_of(uuid,uuid)', 'EXECUTE')
               AND NOT has_function_privilege('authenticated', 'public._company_is_eligible_agent(uuid,uuid)', 'EXECUTE')
               AND has_function_privilege('authenticated', 'public.company_staff_set(uuid,text)', 'EXECUTE'),
               '① صلاحيات الدوال');
  PERFORM t.ok(NOT has_table_privilege('service_role', 'public.company_staff', 'SELECT')
               AND NOT has_table_privilege('service_role', 'public.company_staff_events', 'INSERT'),
               '① service_role بلا جداول');
  RAISE NOTICE 'PASS ① 086 مطبّق: جدولان بلا سياسة سماح، 4 دوال لـauthenticated، لا شيء لـanon/service_role';
END $$;

SELECT 'PASS ① anon: ' || t.err_anon('select public.company_staff_list()') || ' / ' || t.err_anon('select public.company_staff_role()')
 WHERE t.err_anon('select public.company_staff_list()') = '42501' AND t.err_anon('select public.company_staff_role()') = '42501';
DO $$
BEGIN
  PERFORM t.ok(t.err_stmt(t.u('OA'), 'select * from public.company_staff') = '42501', '① SELECT مباشر');
  PERFORM t.ok(t.err_stmt(t.u('OA'), format('insert into public.company_staff (company_id, user_id, role) values (%L, %L, ''agent'')', t.u('CA'), t.u('A1'))) = '42501', '① INSERT مباشر');
  PERFORM t.ok(t.err_stmt(t.u('OA'), 'select * from public.company_staff_events') = '42501', '① SELECT الأحداث');
  PERFORM t.ok(t.err_stmt(t.u('OA'), 'delete from public.company_staff_events') = '42501', '① DELETE الأحداث');
  RAISE NOTICE 'PASS ① لا وصول مباشر للجدولين حتى لمدير الشركة (42501)';
END $$;

-- ══ ② الأدوار ════════════════════════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ok(t.role('OA') = 'admin', '② OA admin');
  PERFORM t.ok(t.role('OB') = 'admin', '② OB admin');
  PERFORM t.ok(t.role('OC') = 'admin', '② OC admin (بلا sub_users يظل المدير)');
  PERFORM t.ok(t.role('A1') IS NULL AND t.role('A2') IS NULL AND t.role('B1') IS NULL, '② التابعون عملاء');
  PERFORM t.ok(t.role('A4') IS NULL, '② المحظور لا شيء');
  PERFORM t.ok(t.role('PU') IS NULL, '② مستخدم بلا شركة');
  PERFORM t.ok(t.role('SUP') IS NULL AND t.role('AD') IS NULL AND t.role('EA') IS NULL, '② طاقم المنصة لا شيء');
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.role('OW') IS NULL, '② مالك المنصة في سياق admin: لا دور في شركته');
  PERFORM t.ctx('company_admin');
  PERFORM t.ok(t.role('OW') = 'admin', '② مالك المنصة في سياق company_admin: مدير شركته هو');
  PERFORM t.ctx('company_user_preview');
  PERFORM t.ok(t.role('OW') IS NULL, '② المعاينة: لا دور');
  PERFORM t.ctx('admin');
  RAISE NOTICE 'PASS ② المالك مدير، التابع عميل، طاقم المنصة لا شيء، مالك المنصة مدير شركته فقط وفي سياقها';
END $$;

-- ══ ③ المنح والتغيير ═════════════════════════════════════════════════════
DO $$
DECLARE v jsonb; e_foreign text; e_missing text;
BEGIN
  v := t.call(t.u('OA'), t.set_sql('A1', 'agent'));
  PERFORM t.ok((v ->> 'changed')::boolean AND v #>> '{staff,role}' = 'agent', '③ منح A1 agent');
  PERFORM t.ok(t.role('A1') = 'agent', '③ A1 صار agent');
  v := t.call(t.u('OA'), t.set_sql('A1', 'agent'));
  PERFORM t.ok(NOT (v ->> 'changed')::boolean, '③ نفس الدور مرتين = بلا تغيير');
  PERFORM t.ok(t.events('A1') = 'granted:->agent:admin', '③ حدث واحد فقط: ' || t.events('A1'));
  v := t.call(t.u('OA'), t.set_sql('A1', 'supervisor'));
  PERFORM t.ok((v ->> 'changed')::boolean AND t.role('A1') = 'supervisor', '③ ترقية A1 supervisor');
  PERFORM t.ok(t.events('A1') = 'granted:->agent:admin,role_changed:agent>supervisor:admin', '③ سجل التغيير: ' || t.events('A1'));
  PERFORM t.ok(t.active_rows('A1') = 1, '③ صف نشط واحد');
  PERFORM t.call(t.u('OA'), t.set_sql('A2', 'agent'));
  PERFORM t.ok(t.role('A2') = 'agent', '③ A2 agent');
  PERFORM t.ok((SELECT actor_id FROM public.company_staff_events WHERE target_id = t.u('A2')) = t.u('OA'), '③ الفاعل مسجّل');

  -- عبر الشركات: تابع شركة أخرى وحساب غير موجود = نفس الخطأ حرفيًا
  e_foreign := t.errfull(t.u('OA'), t.set_sql('B1', 'agent'));
  e_missing := t.errfull(t.u('OA'), t.set_sql('NOPE', 'agent'));
  PERFORM t.ok(e_foreign LIKE 'P0002|%' AND e_foreign = e_missing, '③ تابع شركة أخرى = غير موجود: ' || e_foreign || ' / ' || e_missing);
  PERFORM t.ok(t.err(t.u('OA'), t.set_sql('PU', 'agent')) = 'P0002', '③ مستخدم بلا شركة');
  PERFORM t.ok(t.err(t.u('OA'), t.set_sql('SUP', 'agent')) = 'P0002', '③ طاقم المنصة ليس تابعًا');
  PERFORM t.ok(t.err(t.u('OB'), t.set_sql('A1', 'agent')) = 'P0002', '③ OB لا يصل لتابع أ');
  PERFORM t.ok(t.err(t.u('OB'), t.rv_sql('A1')) = 'P0002', '③ OB لا يلغي موظف أ');
  PERFORM t.ok(t.role('A1') = 'supervisor', '③ A1 لم يتأثر بمحاولات OB');

  -- المدخلات
  PERFORM t.ok(t.errfull(t.u('OA'), t.set_sql('OA', 'agent')) LIKE '22023|%owner_is_admin%', '③ المالك لا يُخزَّن');
  PERFORM t.ok(t.errfull(t.u('OA'), t.set_sql('A3', 'admin')) LIKE '22023|%invalid_role%', '③ admin ليس دورًا قابلًا للمنح');
  PERFORM t.ok(t.errfull(t.u('OA'), t.set_sql('A3', NULL)) LIKE '22023|%invalid_role%', '③ دور فارغ');
  PERFORM t.ok(t.errfull(t.u('OA'), 'public.company_staff_set(null, ''agent'')') LIKE '22023|%missing_user%', '③ حساب فارغ');
  PERFORM t.ok(t.errfull(t.u('OA'), t.set_sql('A4', 'agent')) LIKE '22023|%target_inactive%', '③ المحظور يُرفض بسبب واضح');

  -- من لا يدير
  PERFORM t.ok(t.err(t.u('A1'), t.set_sql('A3', 'agent')) = '42501', '③ المشرف لا يدير الفريق');
  PERFORM t.ok(t.err(t.u('A2'), t.rv_sql('A1')) = '42501', '③ الموظف لا يلغي');
  PERFORM t.ok(t.err(t.u('A3'), t.set_sql('A3', 'supervisor')) = '42501', '③ العميل لا يرقّي نفسه');
  PERFORM t.ok(t.err(t.u('OC'), t.set_sql('A3', 'agent')) = '42501', '③ مدير بلا sub_users');
  PERFORM t.ok(t.err(t.u('PU'), t.set_sql('A3', 'agent')) = '42501', '③ مستخدم بلا شركة');
  PERFORM t.ok(t.err(t.u('SUP'), t.set_sql('A3', 'agent')) = '42501'
               AND t.err(t.u('AD'), t.set_sql('A3', 'agent')) = '42501'
               AND t.err(t.u('EA'), t.set_sql('A3', 'agent')) = '42501'
               AND t.err(t.u('EA'), t.rv_sql('A1')) = '42501', '③ طاقم المنصة (حتى المرتفع) لا يدير فريق شركة');
  PERFORM t.ok(t.err(t.u('A4'), 'public.company_staff_list()') = 'ok', '③ المحظور يقرأ null بلا خطأ');

  -- مالك المنصة: شركته فقط، وفي سياقها، وخارج المعاينة
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.err(t.u('OW'), t.set_sql('A3', 'agent')) = '42501', '③ OW في سياق admin');
  PERFORM t.ctx('owner');
  PERFORM t.ok(t.err(t.u('OW'), t.set_sql('A3', 'agent')) = 'P0002', '③ OW في سياق owner: تابع أ ليس في شركته');
  PERFORM t.ok(t.err(t.u('OW'), t.rv_sql('A1')) = 'P0002', '③ OW لا يلغي موظف أ');
  PERFORM t.ctx('company_user_preview');
  PERFORM t.ok(t.err(t.u('OW'), t.set_sql('A3', 'agent')) = '42501', '③ المعاينة لا تكتب');
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.role('A3') IS NULL AND t.role('A1') = 'supervisor', '③ لا أثر لمحاولات المنصة');
  RAISE NOTICE 'PASS ③ المنح/التغيير متكرر النتيجة ومسجّل؛ كل عبور بين الشركات = P0002 بلا تمييز؛ المنصة لا تدير';
END $$;

-- ══ ④ القائمة ════════════════════════════════════════════════════════════
DO $$
DECLARE v jsonb;
BEGIN
  v := t.call(t.u('OA'), 'public.company_staff_list()');
  PERFORM t.ok(v ->> 'my_role' = 'admin' AND (v ->> 'can_manage')::boolean AND (v ->> 'company_id')::uuid = t.u('CA'), '④ OA');
  PERFORM t.ok(jsonb_array_length(v -> 'staff') = 3, '④ المدير + المشرف + الموظف: ' || (v -> 'staff')::text);
  PERFORM t.ok(v -> 'staff' -> 0 ->> 'role' = 'admin' AND (v -> 'staff' -> 0 ->> 'is_owner')::boolean, '④ المالك أولًا');
  PERFORM t.ok(NOT (v::text LIKE '%@t.io%') AND NOT (v::text LIKE '%0100000%'), '④ بلا بريد ولا هاتف');
  PERFORM t.ok(NOT (v::text LIKE '%' || t.u('A3') || '%'), '④ العميل ليس في الفريق');

  v := t.call(t.u('A1'), 'public.company_staff_list()');
  PERFORM t.ok(v ->> 'my_role' = 'supervisor' AND NOT (v ->> 'can_manage')::boolean AND jsonb_array_length(v -> 'staff') = 3, '④ المشرف يرى الفريق ولا يدير');
  v := t.call(t.u('A2'), 'public.company_staff_list()');
  PERFORM t.ok(v ->> 'my_role' = 'agent' AND NOT (v ->> 'can_manage')::boolean, '④ الموظف');

  PERFORM t.ok(t.call(t.u('A3'), 'public.company_staff_list()') IS NULL, '④ العميل: null (لا تعداد للموظفين)');
  PERFORM t.ok(t.call(t.u('PU'), 'public.company_staff_list()') IS NULL, '④ بلا شركة: null');
  PERFORM t.ok(t.call(t.u('EA'), 'public.company_staff_list()') IS NULL, '④ الأدمن المرتفع: null');

  v := t.call(t.u('OB'), 'public.company_staff_list()');
  PERFORM t.ok(jsonb_array_length(v -> 'staff') = 1 AND NOT (v::text LIKE '%' || t.u('A1') || '%'), '④ OB يرى فريقه فقط');
  v := t.call(t.u('OC'), 'public.company_staff_list()');
  PERFORM t.ok(v ->> 'my_role' = 'admin' AND NOT (v ->> 'can_manage')::boolean, '④ OC: مدير بلا إدارة');
  RAISE NOTICE 'PASS ④ القائمة للفريق وحده، بلا بيانات اتصال، ولا تعبر الشركات';
END $$;

-- ══ ⑤ أهلية المستلم (للزيادات اللاحقة) ══════════════════════════════════
DO $$
BEGIN
  PERFORM t.ok(public._company_is_eligible_agent(t.u('CA'), t.u('A1')), '⑤ A1 في أ');
  PERFORM t.ok(public._company_is_eligible_agent(t.u('CA'), t.u('OA')), '⑤ المالك في أ');
  PERFORM t.ok(NOT public._company_is_eligible_agent(t.u('CB'), t.u('A1')), '⑤ A1 ليس في ب');
  PERFORM t.ok(NOT public._company_is_eligible_agent(t.u('CA'), t.u('B1')), '⑤ B1 ليس في أ');
  PERFORM t.ok(NOT public._company_is_eligible_agent(t.u('CA'), t.u('A3')), '⑤ العميل ليس مستلمًا');
  PERFORM t.ok(NOT public._company_is_eligible_agent(t.u('CA'), t.u('SUP')), '⑤ طاقم المنصة ليس مستلمًا');
  PERFORM t.ok(NOT public._company_is_eligible_agent(t.u('CA'), NULL) AND NOT public._company_is_eligible_agent(NULL, t.u('A1')), '⑤ NULL');
  -- حظر موظف قائم: يفقد الأهلية والدور فورًا
  UPDATE public.profiles SET ban_status = 'banned' WHERE id = t.u('A2');
  PERFORM t.ok(NOT public._company_is_eligible_agent(t.u('CA'), t.u('A2')) AND t.role('A2') IS NULL, '⑤ الحظر يسقط الأهلية');
  UPDATE public.profiles SET ban_status = 'none' WHERE id = t.u('A2');
  PERFORM t.ok(public._company_is_eligible_agent(t.u('CA'), t.u('A2')) AND t.role('A2') = 'agent', '⑤ رفع الحظر يعيدها (الصف باقٍ)');
  RAISE NOTICE 'PASS ⑤ أهلية المستلم محصورة في شركته وفي الفريق النشط';
END $$;

-- ══ ⑥ الإلغاء وإعادة المنح ═══════════════════════════════════════════════
DO $$
DECLARE v jsonb;
BEGIN
  v := t.call(t.u('OA'), t.rv_sql('A2'));
  PERFORM t.ok((v ->> 'revoked')::boolean AND t.role('A2') IS NULL AND t.active_rows('A2') = 0, '⑥ إلغاء A2');
  PERFORM t.ok(t.err(t.u('OA'), t.rv_sql('A2')) = 'P0002', '⑥ إلغاء مرتين');
  PERFORM t.ok(t.err(t.u('OA'), t.rv_sql('A3')) = 'P0002', '⑥ إلغاء عميل');
  PERFORM t.ok((SELECT super_user_id FROM public.profiles WHERE id = t.u('A2')) = t.u('OA'), '⑥ A2 ما زال تابعًا (عميلًا)');
  PERFORM t.call(t.u('OA'), t.set_sql('A2', 'supervisor'));
  PERFORM t.ok(t.role('A2') = 'supervisor' AND t.active_rows('A2') = 1
               AND (SELECT count(*) FROM public.company_staff WHERE user_id = t.u('A2')) = 2, '⑥ إعادة المنح صف جديد والقديم سجل');
  PERFORM t.ok(t.events('A2') = 'granted:->agent:admin,revoked:agent>-:admin,granted:->supervisor:admin', '⑥ السجل: ' || t.events('A2'));
  RAISE NOTICE 'PASS ⑥ الإلغاء يعيد الحساب عميلًا، وإعادة المنح صف جديد';
END $$;

-- ══ ⑦ ترك الشركة ═════════════════════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.call(t.u('OA'), format('public.remove_company_member(%L::uuid)', t.u('A2')));
  PERFORM t.ok(t.active_rows('A2') = 0 AND t.role('A2') IS NULL, '⑦ إزالة A2 من الشركة تلغي دوره');
  PERFORM t.ok(t.events('A2') LIKE '%,revoked:supervisor>-:left_company', '⑦ السبب left_company: ' || t.events('A2'));
  PERFORM t.ok((SELECT revoked_by FROM public.company_staff WHERE user_id = t.u('A2') AND revoke_cause = 'left_company') = t.u('OA'), '⑦ الفاعل');
  -- عودة الحساب للشركة (مسار إداري) لا تعيد الدور
  UPDATE public.profiles SET super_user_id = t.u('OA') WHERE id = t.u('A2');
  PERFORM t.ok((SELECT role FROM public.profiles WHERE id = t.u('A2')) = 'company_user' AND t.role('A2') IS NULL, '⑦ العودة: عميل لا موظف');
  -- انتقال تابع موظف إلى شركة أخرى: لا يحمل دوره معه ولا يبقى في القديمة
  PERFORM t.call(t.u('OA'), t.set_sql('A3', 'agent'));
  UPDATE public.profiles SET super_user_id = t.u('OB') WHERE id = t.u('A3');
  PERFORM t.ok(t.role('A3') IS NULL AND t.active_rows('A3') = 0
               AND NOT public._company_is_eligible_agent(t.u('CA'), t.u('A3'))
               AND NOT public._company_is_eligible_agent(t.u('CB'), t.u('A3')), '⑦ الانتقال لشركة أخرى');
  UPDATE public.profiles SET super_user_id = t.u('OA') WHERE id = t.u('A3');
  RAISE NOTICE 'PASS ⑦ ترك الشركة يلغي الدور بمحفّز، والعودة لا تعيده بصمت';
END $$;

-- الطبقة الثانية: حتى لو لم يعمل المحفّز (مسار يتخطاه)، الصف لا يُحتسب لحساب
-- لم يعد تابعًا — المُسنَدات تعيد فحص العلاقة في كل قراءة.
ALTER TABLE public.profiles DISABLE TRIGGER trg_company_staff_unlink;
DO $$
BEGIN
  PERFORM t.ok(t.role('A1') = 'supervisor', '⑦ب بداية');
  UPDATE public.profiles SET super_user_id = t.u('OB') WHERE id = t.u('A1');
  PERFORM t.ok(t.active_rows('A1') = 1, '⑦ب الصف ما زال نشطًا (المحفّز معطّل)');
  PERFORM t.ok(public._company_staff_role_of(t.u('CA'), t.u('A1')) IS NULL
               AND NOT public._company_is_eligible_agent(t.u('CA'), t.u('A1'))
               AND t.role('A1') IS NULL, '⑦ب لا دور ولا أهلية في أ');
  PERFORM t.ok(NOT (t.call(t.u('OA'), 'public.company_staff_list()')::text LIKE '%' || t.u('A1') || '%'), '⑦ب ليس في قائمة أ');
  UPDATE public.profiles SET super_user_id = t.u('OA') WHERE id = t.u('A1');
  RAISE NOTICE 'PASS ⑦ب المُسنَدات تعيد فحص العلاقة في كل قراءة (طبقة ثانية خلف المحفّز)';
END $$;
ALTER TABLE public.profiles ENABLE TRIGGER trg_company_staff_unlink;

-- ══ ⑧ حرّاس الجداول ══════════════════════════════════════════════════════
DO $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM public.company_staff WHERE user_id = t.u('A1') AND revoked_at IS NULL;
  PERFORM t.ok(t.err_super(format('insert into public.company_staff (company_id, user_id, role) values (%L, %L, ''agent'')', t.u('CA'), t.u('B1'))) = '23514', '⑧ تابع ب في أ (حتى كمالك القاعدة)');
  PERFORM t.ok(t.err_super(format('insert into public.company_staff (company_id, user_id, role) values (%L, %L, ''agent'')', t.u('CA'), t.u('OA'))) = '23514', '⑧ المالك صفًا');
  PERFORM t.ok(t.err_super(format('update public.company_staff set user_id = %L where id = %L', t.u('A3'), v_id)) = '23514', '⑧ تغيير الحساب');
  PERFORM t.ok(t.err_super(format('update public.company_staff set company_id = %L where id = %L', t.u('CB'), v_id)) = '23514', '⑧ تغيير الشركة');
  PERFORM t.ok(t.err_super(format('update public.company_staff set role = ''owner'' where id = %L', v_id)) = '23514', '⑧ دور خارج القائمة');
  PERFORM t.ok(t.err_super('update public.company_staff set revoked_at = null, revoke_cause = null where revoked_at is not null') = '23514', '⑧ إحياء صف ملغى');
  PERFORM t.ok(t.err_super(format('update public.company_staff set revoked_at = now() where id = %L', v_id)) = '23514', '⑧ إلغاء بلا سبب');
  PERFORM t.ok(t.err_super('update public.company_staff_events set action = ''granted''') = '23514', '⑧ تعديل السجل');
  PERFORM t.ok(t.err_super('delete from public.company_staff_events') = '23514', '⑧ حذف السجل');
  PERFORM t.ok(t.err_super('truncate public.company_staff_events') = '23514', '⑧ TRUNCATE السجل');
  PERFORM t.ok(t.err_super('truncate public.company_staff') = '23514', '⑧ TRUNCATE الفريق');
  RAISE NOTICE 'PASS ⑧ الثوابت مفروضة بمحفّزات حتى على مالك القاعدة: نفس الشركة، الهوية ثابتة، السجل إلحاقي';
END $$;

-- ══ ⑨ التزامن بجلستين حقيقيتين ═══════════════════════════════════════════
-- (أ) منحان متزامنان لنفس الحساب: واحد يكسب، والتاني 40001 بلا أثر
SELECT t.conn('s1', t.u('OA')), t.conn('s2', t.u('OA'));
DO $$
DECLARE r1 text; r2 text; blocked boolean;
BEGIN
  PERFORM t.dblink_exec('s1', 'begin');
  r1 := (SELECT x FROM t.dblink('s1', format('select (public.company_staff_set(%L::uuid, ''agent''))::text', t.u('A3'))) AS r(x text));
  PERFORM t.dblink_send_query('s2', format('select (public.company_staff_set(%L::uuid, ''supervisor''))::text', t.u('A3')));
  blocked := t.wait_blocked('s2');
  PERFORM t.dblink_exec('s1', 'commit');
  BEGIN
    r2 := (SELECT x FROM t.dblink_get_result('s2') AS r(x text));
  EXCEPTION WHEN others THEN
    r2 := sqlstate || ':' || sqlerrm;
  END;
  PERFORM t.dblink_get_result('s2', false);
  PERFORM t.ok(blocked, '⑨أ الجلسة الثانية انتظرت');
  PERFORM t.ok(r1 LIKE '%"changed": true%' AND r2 LIKE '%40001%', '⑨أ: ' || r1 || ' / ' || coalesce(r2, 'null'));
  PERFORM t.ok(t.active_rows('A3') = 1 AND t.role('A3') = 'agent'
               AND (SELECT count(*) FROM public.company_staff_events WHERE target_id = t.u('A3') AND created_at > now() - interval '1 minute' AND action = 'granted' AND role_to = 'agent') >= 1,
               '⑨أ صف واحد نشط');
  RAISE NOTICE 'PASS ⑨أ منحان متزامنان: واحد يكسب، والآخر 40001 بلا أثر';
END $$;
SELECT t.dblink_disconnect('s1'), t.dblink_disconnect('s2');

-- (ب) منح يتسابق مع إزالة الحساب من الشركة: لا يبقى موظف لشركة تركها
SELECT t.conn('s1', t.u('OA')), t.conn('s2', t.u('OA'));
DO $$
DECLARE blocked boolean; r2 text;
BEGIN
  PERFORM t.ok(t.role('A2') IS NULL AND t.active_rows('A2') = 0, '⑨ب بداية');
  PERFORM t.dblink_exec('s1', 'begin');
  PERFORM x FROM t.dblink('s1', format('select (public.company_staff_set(%L::uuid, ''agent''))::text', t.u('A2'))) AS r(x text);
  PERFORM t.dblink_send_query('s2', format('select (public.remove_company_member(%L::uuid))::text', t.u('A2')));
  blocked := t.wait_blocked('s2');
  PERFORM t.dblink_exec('s1', 'commit');
  r2 := (SELECT x FROM t.dblink_get_result('s2') AS r(x text));
  PERFORM t.dblink_get_result('s2', false);
  PERFORM t.ok(blocked, '⑨ب الإزالة انتظرت قفل المنح');
  PERFORM t.ok(r2 LIKE '%"removed": true%', '⑨ب الإزالة نجحت: ' || coalesce(r2, 'null'));
  PERFORM t.ok(t.active_rows('A2') = 0 AND t.role('A2') IS NULL
               AND NOT public._company_is_eligible_agent(t.u('CA'), t.u('A2')), '⑨ب لا موظف لشركة تركها');
  PERFORM t.ok(t.events('A2') LIKE '%,granted:->agent:admin,revoked:agent>-:left_company', '⑨ب السجل: ' || t.events('A2'));
  RAISE NOTICE 'PASS ⑨ب منح يتسابق مع الإزالة: الإزالة تنتظر ثم تلغي الصف الجديد';
END $$;
SELECT t.dblink_disconnect('s1'), t.dblink_disconnect('s2');
UPDATE public.profiles SET super_user_id = t.u('OA') WHERE id = t.u('A2');

-- ══ ⑩ عدم المساس، إعادة التشغيل، التراجع، إعادة التطبيق ══════════════════
DO $$
BEGIN
  PERFORM t.ok(t.untouched_digest() = (SELECT v FROM t.saved WHERE k = 'untouched'), '⑩ الشركات والمحادثات والصندوق والإشعارات والتذاكر لم تتغير');
  PERFORM t.ok(t.fn_digest() = (SELECT v FROM t.saved WHERE k = 'fn'), '⑩ دوال الشركة والصندوق القائمة حرفيًا كما هي');
  PERFORM t.ok(t.policy_digest() = (SELECT v FROM t.saved WHERE k = 'pol'), '⑩ لا سياسة قائمة تغيّرت');
  PERFORM t.ok((t.call(t.u('OA'), 'public.company_members()'))::text <> '' , '⑩ company_members تعمل');
  RAISE NOTICE 'PASS ⑩ لا مساس بأي جدول أو دالة أو سياسة قائمة';
END $$;
INSERT INTO t.saved VALUES ('rows', (SELECT count(*) FROM public.company_staff)::text || '/' || (SELECT count(*) FROM public.company_staff_events)::text);

\i migrations/086_company_staff.sql
DO $$
BEGIN
  PERFORM t.ok((SELECT count(*) FROM public.company_staff)::text || '/' || (SELECT count(*) FROM public.company_staff_events)::text
               = (SELECT v FROM t.saved WHERE k = 'rows'), '⑩ إعادة التشغيل لا تمس البيانات');
  PERFORM t.ok(t.role('A1') = 'supervisor', '⑩ الدور باقٍ بعد إعادة التشغيل');
  RAISE NOTICE 'PASS ⑩ إعادة تشغيل 086 آمنة';
END $$;

-- التراجع يرفض مع وجود بيانات (في جلسة منفصلة، فالخطأ المقصود لا يوقف الملف)
\set rollback_sql `cat migrations/_rollback/086_company_staff.down.sql`
SELECT set_config('t.rollback_sql', :'rollback_sql', false) IS NOT NULL;
DO $$
DECLARE c text;
BEGIN
  PERFORM t.dblink_connect('rb', format('dbname=%s port=%s host=%s user=postgres', current_database(),
            current_setting('port'), split_part(current_setting('unix_socket_directories'), ',', 1)));
  BEGIN
    PERFORM t.dblink_exec('rb', current_setting('t.rollback_sql'));
    c := 'ok';
  EXCEPTION WHEN others THEN c := sqlerrm;
  END;
  PERFORM t.dblink_disconnect('rb');
  PERFORM t.ok(c LIKE '%rollback_discard_data%', '⑩ رفض التراجع: ' || c);
  PERFORM t.ok(to_regclass('public.company_staff') IS NOT NULL AND t.role('A1') = 'supervisor', '⑩ التراجع رفض ولم يمس شيئًا');
  RAISE NOTICE 'PASS ⑩ التراجع يرفض مع وجود عضويات';
END $$;

SET company_staff.rollback_discard_data = 'on';
\i migrations/_rollback/086_company_staff.down.sql
RESET company_staff.rollback_discard_data;
DO $$
BEGIN
  PERFORM t.ok(to_regclass('public.company_staff') IS NULL AND to_regprocedure('public.company_staff_role()') IS NULL, '⑩ التراجع حذف الكائنات');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_company_staff_unlink'), '⑩ محفّز profiles حُذف');
  PERFORM t.ok(t.fn_digest() = (SELECT v FROM t.saved WHERE k = 'fn') AND t.policy_digest() = (SELECT v FROM t.saved WHERE k = 'pol'), '⑩ الدوال والسياسات القائمة كما كانت');
  -- profiles يعمل بعد التراجع
  UPDATE public.profiles SET super_user_id = NULL WHERE id = t.u('A3');
  UPDATE public.profiles SET super_user_id = t.u('OA') WHERE id = t.u('A3');
  RAISE NOTICE 'PASS ⑩ التراجع بإذن صريح يحذف 086 كاملًا ويترك الباقي كما كان';
END $$;

\i migrations/086_company_staff.sql
DO $$
BEGIN
  PERFORM t.ok((SELECT count(*) FROM public.company_staff) = 0 AND t.role('A1') IS NULL AND t.role('OA') = 'admin', '⑩ إعادة التطبيق: بداية نظيفة');
  PERFORM t.call(t.u('OA'), t.set_sql('A1', 'agent'));
  PERFORM t.ok(t.role('A1') = 'agent', '⑩ إعادة التطبيق تعمل');
  RAISE NOTICE 'PASS ⑩ إعادة التطبيق بعد التراجع';
END $$;

SELECT 'ALL company-staff checks PASSED';
