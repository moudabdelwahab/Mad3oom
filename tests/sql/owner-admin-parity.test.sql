-- ============================================================================
-- 115: مالك المنصة في لوحة الإدارة — السياسات والدوال القديمة تفحص الرتبة الحرفية 'admin'، فتردّه.
-- على نسخة مطابقة للإنتاج حتى 114.
--
--   ⓪ قبل 115: السياسات الخمسون والدوال الست تطابق الإنتاج (بصمة md5)، والمالك في سياق «الإدارة» —
--      وis_admin() له true — مرفوض في الإعدادات وقاعدة المعرفة والمحافظ ومراجعة المكافآت… (المشكلة مُثبتة)
--   ① بعد 115 (مرتين): المالك في سياق owner أو admin يقرأ ويكتب ما يكتبه الأدمن، وينادي دوال الإدارة
--   ② لا توسيع: الأدمن والمرتفع كما هما، الدعم يكسب جداول الطاقم وحدها، العميل ومالك الشركة لا شيء،
--      والمالك في العميل/الشركة/المعاينة/بلا سياق لا شيء
--   ③ المحفظة المركزية بمستوى السلطة المرتفعة: support@ (بريد JWT) والمالك في سياق owner — لا سياق admin
--      ولا info@ ولا أي أدمن آخر
--   ④ التراجع يعيد بصمة الإنتاج حرفيًا، ثم يُعاد 115
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
\i migrations/113_company_member_management.sql
\i migrations/114_ticket_email_payload.sql
SET search_path = public, extensions;

UPDATE auth.users SET email_confirmed_at = now() - interval '30 days';

-- ── بيانات ────────────────────────────────────────────────────────────────
INSERT INTO public.advanced_settings (key, value) VALUES ('parity_probe', '"x"'::jsonb);
INSERT INTO public.user_wallets (user_id, total_points, available_points) VALUES (t.u('PU'), 10, 10), (t.u('B1'), 3, 3);
INSERT INTO public.knowledge_base (title, category, content, status, is_internal) VALUES ('داخلي', 'general', 'متن', 'draft', true);
INSERT INTO public.central_wallet (balance) VALUES (1000);
INSERT INTO public.user_reports (id, user_id, problem_type, severity, title, description, estimated_points)
VALUES ('5e000000-0000-4000-8000-000000000001', t.u('PU'), 'bug', 'low', 'بلاغ', 'وصف', 5),
       ('5e000000-0000-4000-8000-000000000002', t.u('PU'), 'bug', 'low', 'بلاغ 2', 'وصف', 5),
       ('5e000000-0000-4000-8000-000000000003', t.u('PU'), 'bug', 'low', 'بلاغ 3', 'وصف', 5);

-- سياسات شعارات النطاقات الفرعية في Storage غائبة عن النسخة المطابقة (00_supabase_stubs لا يحمل سياسات
-- Storage)؛ تُنشأ هنا بتعريف الإنتاج حرفيًا (pg_policies على srnelrdpqkcntbgudyto) فتدخل بصمة ⓪.
CREATE POLICY "Admin delete subdomain logos" ON storage.objects AS PERMISSIVE FOR DELETE TO public
  USING (bucket_id = 'subdomain-logos' AND (SELECT profiles.role FROM profiles WHERE profiles.id = auth.uid()) = 'admin');
CREATE POLICY "Admin update subdomain logos" ON storage.objects AS PERMISSIVE FOR UPDATE TO public
  USING (bucket_id = 'subdomain-logos' AND (SELECT profiles.role FROM profiles WHERE profiles.id = auth.uid()) = 'admin');
CREATE POLICY "Admin upload subdomain logos" ON storage.objects AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (bucket_id = 'subdomain-logos' AND (SELECT profiles.role FROM profiles WHERE profiles.id = auth.uid()) = 'admin');

-- ── أدوات ─────────────────────────────────────────────────────────────────
-- بصمة السياسات الخمسين المستهدفة (نفس الاستعلام على الإنتاج قبل 115: 34b1a68e8a87e3d9797d0098ff3a500c)
CREATE FUNCTION t.policy_digest() RETURNS text LANGUAGE sql AS $$
  select md5(string_agg(schemaname||'.'||tablename||'|'||policyname||'|'||permissive||'|'||roles::text||'|'||cmd||'|'
                        ||coalesce(qual,'')||'|'||coalesce(with_check,''), E'\n' order by schemaname, tablename, policyname))
    from pg_policies
   where (schemaname, tablename, policyname) in (
     ('public','activity_logs','activity_logs_select_policy'),('public','advanced_settings','Admins can manage advanced_settings'),
     ('public','canned_responses','Admin can manage canned responses'),('public','chatbot_memory','Admins have full access to chatbot_memory'),
     ('public','custom_roles','Admins can manage custom_roles'),('public','forum_categories','Admins can manage categories'),
     ('public','forum_replies','Authors/Admins can update replies'),('public','forum_reports','Admins can view reports'),
     ('public','forum_subforums','Admins can manage subforums'),('public','forum_threads','Authors/Admins can update threads'),
     ('public','mailbox_emails','Admin can delete mailbox emails'),('public','mailbox_emails','Admin can select mailbox emails'),
     ('public','mailbox_emails','Admin can update mailbox emails'),('public','memory_firewall_rules','Admins can manage firewall rules'),
     ('public','reward_activity_logs','Admins can view all reward logs'),('public','rules_engine','Admins can manage rules_engine'),
     ('public','site_errors','Allow admins to update errors'),('public','site_errors','Allow admins to view errors'),
     ('public','subdomain_activity_log','Admins view activity log'),('public','subdomain_request_queue','Admins view all requests'),
     ('public','subdomain_requests','Admins view all subdomains'),('public','ticket_distribution_config','Admins can manage ticket_distribution_config'),
     ('public','ticket_tags','Admin can manage tags'),('public','user_reports','report_select_all'),('public','user_reports','report_update_all'),
     ('public','user_wallets','Admins can insert wallets'),('public','user_wallets','Admins can update wallets'),('public','user_wallets','wallet_select_all'),
     ('public','waitlist_entries','waitlist_entries_admin_all'),('public','working_hours','Admins can manage working_hours'),
     ('storage','objects','Admin delete subdomain logos'),('storage','objects','Admin update subdomain logos'),('storage','objects','Admin upload subdomain logos'),
     ('public','api_keys','Admins can view all api_keys'),('public','bot_api_keys','Admins can view all bot_api_keys'),
     ('public','bot_settings','Admins can view all bot_settings'),('public','integrations','Admins can view all integrations'),
     ('public','integrations','Support can view all integrations'),('public','customer_service_reports','Staff manage service reports'),
     ('public','incidents','Staff can write incidents'),('public','kb_article_feedback','Staff can read article feedback'),
     ('public','knowledge_base','Staff can read all articles'),('public','knowledge_base','Staff can write articles'),
     ('public','service_status_history','Staff can write service history'),('public','services','Staff can write services'),
     ('public','suggested_questions','Staff can manage suggested questions'),
     ('public','central_wallet','Only support email can update central wallet'),('public','central_wallet','Only support email can view central wallet'),
     ('public','central_wallet_transactions','Only support email can insert transactions'),('public','central_wallet_transactions','Only support email can view transactions')) $$;
CREATE FUNCTION t.fn_md5(p regprocedure) RETURNS text LANGUAGE sql AS $$ select md5(pg_get_functiondef(p)) $$;
CREATE FUNCTION t.n(p text, p_sql text) RETURNS int LANGUAGE sql AS $$ select t.affected(t.u(p), p_sql) $$;
-- نداء بهوية مستخدم مع بريد في JWT (المحفظة المركزية تفحص auth.jwt() ->> 'email')
CREATE FUNCTION t.call_mail(p uuid, p_email text, p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
declare v jsonb;
begin
  perform t.act(p);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p, 'role', 'authenticated', 'email', p_email,
                                                              'session_id', 'sess-' || p)::text, false);
  execute 'set local role authenticated';
  execute 'select to_jsonb((' || p_sql || '))' into v;
  execute 'reset role';
  perform t.act(null);
  return v;
end $$;
-- مجموعة عمليات الإدارة الممثِّلة: نتيجة كل واحدة 1 (نجحت) أو 0 (رُدّت)
CREATE FUNCTION t.admin_ops(p text) RETURNS text LANGUAGE plpgsql AS $$
declare r text[] := '{}';
begin
  r := r || (t.n(p, 'update public.advanced_settings set value = ''"y"'' where key = ''parity_probe''') > 0)::int::text;
  r := r || (t.exec(t.u(p), 'insert into public.working_hours (day_of_week) values (3)') = 'ok')::int::text;
  r := r || (t.rows(t.u(p), format('public.user_wallets where user_id = %L', t.u('B1'))) > 0)::int::text;  -- محفظة غيره
  r := r || (t.exec(t.u(p), 'insert into public.ticket_tags (name) values (''وسم ' || p || ' ' || gen_random_uuid() || ''')') = 'ok')::int::text;
  r := r || (t.exec(t.u(p), 'insert into public.canned_responses (title, content) values (''رد'', ''نص'')') = 'ok')::int::text;
  r := r || (t.rows(t.u(p), 'public.user_reports where user_id <> auth.uid()') > 0)::int::text;      -- بلاغات غيره
  r := r || coalesce((t.call(t.u(p), 'public.wf_is_admin()') #>> '{}')::boolean, false)::int::text;
  return array_to_string(r, '');
end $$;
CREATE FUNCTION t.staff_ops(p text) RETURNS text LANGUAGE plpgsql AS $$
declare r text[] := '{}';
begin
  r := r || (t.rows(t.u(p), 'public.knowledge_base where is_internal') > 0)::int::text;
  r := r || (t.exec(t.u(p), 'insert into public.services (name) values (''خدمة'')') = 'ok')::int::text;
  r := r || (t.exec(t.u(p), 'insert into public.incidents (title) values (''حادث'')') = 'ok')::int::text;
  r := r || (t.err(t.u(p), 'public.get_service_report_summary()') = 'ok')::int::text;
  return array_to_string(r, '');
end $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ══ ⓪ قبل 115 ════════════════════════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ok(t.policy_digest() = '34b1a68e8a87e3d9797d0098ff3a500c', '⓪ السياسات الخمسون تطابق الإنتاج: ' || t.policy_digest());
  PERFORM t.ok(t.fn_md5('public.approve_reward_report(uuid,integer)') = '8395992ecd9683d7ac0dee53b1d3d2e2', '⓪ approve_reward_report = الإنتاج');
  PERFORM t.ok(t.fn_md5('public.reject_reward_report(uuid,text)') = 'aeb25bb5ca037f7d346a9629a0b31f93', '⓪ reject_reward_report = الإنتاج');
  PERFORM t.ok(t.fn_md5('public.get_service_report_summary()') = '24751e720288d403e7133a21ed01df5f', '⓪ get_service_report_summary = الإنتاج');
  PERFORM t.ok(t.fn_md5('public.manage_user_points(text,bigint,text)') = '52300b74ccfa4320992319d8248b4ede', '⓪ manage_user_points = الإنتاج');
  PERFORM t.ok(t.fn_md5('public.transfer_points_from_central(text,bigint)') = '957959cb85b6ee8c81710a0968dd3293', '⓪ transfer_points_from_central = الإنتاج');
  PERFORM t.ok(t.fn_md5('public.wf_is_admin()') = '51f57b0fb3368c65e0cd0bd61d0dcec9', '⓪ wf_is_admin = الإنتاج');

  PERFORM t.ctx('admin');
  PERFORM t.ok((t.call(t.u('OW'), 'public.is_admin()') #>> '{}')::boolean, '⓪ is_admin() للمالك في سياق الإدارة');
  PERFORM t.ok(t.admin_ops('OW') = '0000000', '⓪ المشكلة: المالك مرفوض في عمليات الإدارة كلها: ' || t.admin_ops('OW'));
  PERFORM t.ok(t.staff_ops('OW') = '0000', '⓪ المشكلة: والطاقم: ' || t.staff_ops('OW'));
  PERFORM t.ok(t.err(t.u('OW'), 'public.approve_reward_report(''5e000000-0000-4000-8000-000000000001'', 5)') <> 'ok', '⓪ مراجعة المكافآت مرفوضة');
  PERFORM t.ok(t.admin_ops('AD') = '1111111', '⓪ الأدمن: ' || t.admin_ops('AD'));
  RAISE NOTICE 'PASS ⓪ قبل 115: مطابق للإنتاج، والمالك في سياق الإدارة مرفوض في عمليات الإدارة رغم is_admin()';
END $$;

-- ══ ① 115 مرتين ══════════════════════════════════════════════════════════
\i migrations/115_owner_admin_parity.sql
\i migrations/115_owner_admin_parity.sql
SET search_path = public, extensions;

DO $$
DECLARE ctx text;
BEGIN
  FOREACH ctx IN ARRAY array['admin', 'owner'] LOOP
    PERFORM t.ctx(ctx);
    PERFORM t.ok(t.admin_ops('OW') = '1111111', format('① %s: عمليات الإدارة للمالك: %s', ctx, t.admin_ops('OW')));
    PERFORM t.ok(t.staff_ops('OW') = '1111', format('① %s: عمليات الطاقم للمالك: %s', ctx, t.staff_ops('OW')));
  END LOOP;
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.err(t.u('OW'), 'public.approve_reward_report(''5e000000-0000-4000-8000-000000000001'', 5)') = 'ok', '① المالك يوافق على بلاغ');
  PERFORM t.ok((select available_points from public.user_wallets where user_id = t.u('PU')) = 15, '① والنقاط أُضيفت');
  PERFORM t.ok(t.err(t.u('OW'), 'public.reject_reward_report(''5e000000-0000-4000-8000-000000000002'', ''مكرر'')') = 'ok', '① المالك يرفض بلاغًا');
  PERFORM t.ok(t.n('OW', 'update public.knowledge_base set title = ''معدّل'' where is_internal') = 1, '① المالك يحرّر قاعدة المعرفة');
  RAISE NOTICE 'PASS ① بعد 115: المالك في سياق owner أو admin ينفّذ عمليات الإدارة والطاقم ومراجعة المكافآت';
END $$;

-- ══ ② لا توسيع ═══════════════════════════════════════════════════════════
DO $$
DECLARE ctx text;
BEGIN
  PERFORM t.ok(t.admin_ops('AD') = '1111111' AND t.staff_ops('AD') = '1111', '② الأدمن كما هو');
  PERFORM t.ok(t.admin_ops('EA') = '1111111', '② الأدمن المرتفع كما هو');
  PERFORM t.ok(t.admin_ops('SUP') = '0000000', '② الدعم لا يكسب عمليات الإدارة: ' || t.admin_ops('SUP'));
  PERFORM t.ok(t.staff_ops('SUP') = '1111', '② والدعم يحتفظ بجداول الطاقم: ' || t.staff_ops('SUP'));
  PERFORM t.ok(t.err(t.u('SUP'), 'public.approve_reward_report(''5e000000-0000-4000-8000-000000000003'', 5)') <> 'ok', '② الدعم لا يراجع المكافآت');
  FOREACH ctx IN ARRAY array['PU', 'OA', 'A1'] LOOP
    PERFORM t.ok(t.admin_ops(ctx) = '0000000' AND t.staff_ops(ctx) = '0000', format('② %s: لا شيء', ctx));
  END LOOP;
  FOREACH ctx IN ARRAY array['customer', 'company_admin', 'company_user_preview', ''] LOOP
    PERFORM t.ctx(nullif(ctx, ''));
    PERFORM t.ok(t.admin_ops('OW') = '0000000' AND t.staff_ops('OW') = '0000', format('② المالك في «%s»: لا شيء (%s/%s)', ctx, t.admin_ops('OW'), t.staff_ops('OW')));
  END LOOP;
  RAISE NOTICE 'PASS ② لا توسيع: الأدمن والمرتفع كما هما، الدعم للطاقم وحده، العميل ومالك الشركة لا شيء، والمالك خارج سياقيه لا شيء';
END $$;

-- auth.jwt() في النسخة المطابقة لا يقرأ بريد الجلسة؛ في Supabase يعيد request.jwt.claims كاملة (والبريد منها).
-- نضمّ المطالبات إلى تعريف النسخة نفسه، فلا يتغير شيء لما سبق ويقرأ can_manage_central_wallet البريد كالإنتاج.
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
  $f$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
             || jsonb_strip_nulls(jsonb_build_object('sub', auth.uid(), 'role', auth.role(),
                  'aal', NULLIF(current_setting('request.jwt.claim.aal', true), ''))) $f$;

-- ══ ③ المحفظة المركزية ═══════════════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ctx('owner');
  PERFORM t.ok((t.call_mail(t.u('OW'), 'ow@tenancy.test', 'public.can_manage_central_wallet()') #>> '{}')::boolean, '③ المالك في سياق owner');
  PERFORM t.ok((t.call_mail(t.u('OW'), 'ow@tenancy.test',
                format('public.manage_user_points(%L, 0, ''freeze'')', 'pu@tenancy.test')) ->> 'success')::boolean, '③ المالك يجمّد محفظة');
  PERFORM t.ok((select is_frozen from public.user_wallets where user_id = t.u('PU')), '③ مجمّدة');
  PERFORM t.ok((t.call_mail(t.u('OW'), 'ow@tenancy.test',
                format('public.transfer_points_from_central(%L, 5)', 'pu@tenancy.test')) ->> 'success')::boolean, '③ المالك يحوّل من المحفظة المركزية');
  PERFORM t.ctx('admin');
  PERFORM t.ok(NOT (t.call_mail(t.u('OW'), 'ow@tenancy.test', 'public.can_manage_central_wallet()') #>> '{}')::boolean, '③ لا في سياق admin');
  PERFORM t.ok(NOT (t.call_mail(t.u('OW'), 'ow@tenancy.test',
                format('public.manage_user_points(%L, 0, ''unfreeze'')', 'pu@tenancy.test')) ->> 'success')::boolean, '③ ولا ينفّذ');
  PERFORM t.ok(NOT (t.call_mail(t.u('EA'), 'info@mad3oom.online', 'public.can_manage_central_wallet()') #>> '{}')::boolean, '③ لا لمرتفع آخر');
  PERFORM t.ok(NOT (t.call_mail(t.u('AD'), 'ad@tenancy.test', 'public.can_manage_central_wallet()') #>> '{}')::boolean, '③ لا لأدمن');
  PERFORM t.ok((t.call_mail(t.u('EA'), 'support@mad3oom.online', 'public.can_manage_central_wallet()') #>> '{}')::boolean, '③ support@ كما كان');
  PERFORM t.ok((t.call_mail(t.u('EA'), 'support@mad3oom.online',
                format('public.manage_user_points(%L, 0, ''unfreeze'')', 'pu@tenancy.test')) ->> 'success')::boolean, '③ support@ ينفّذ كما كان');
  RAISE NOTICE 'PASS ③ المحفظة المركزية: support@ كما كان، والمالك في سياق owner وحده';
END $$;

-- ══ ④ التراجع ════════════════════════════════════════════════════════════
\i migrations/_rollback/115_owner_admin_parity.down.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok(t.policy_digest() = '34b1a68e8a87e3d9797d0098ff3a500c', '④ التراجع يعيد بصمة السياسات: ' || t.policy_digest());
  PERFORM t.ok(t.fn_md5('public.approve_reward_report(uuid,integer)') = '8395992ecd9683d7ac0dee53b1d3d2e2', '④ approve_reward_report');
  PERFORM t.ok(t.fn_md5('public.reject_reward_report(uuid,text)') = 'aeb25bb5ca037f7d346a9629a0b31f93', '④ reject_reward_report');
  PERFORM t.ok(t.fn_md5('public.get_service_report_summary()') = '24751e720288d403e7133a21ed01df5f', '④ get_service_report_summary');
  PERFORM t.ok(t.fn_md5('public.manage_user_points(text,bigint,text)') = '52300b74ccfa4320992319d8248b4ede', '④ manage_user_points');
  PERFORM t.ok(t.fn_md5('public.transfer_points_from_central(text,bigint)') = '957959cb85b6ee8c81710a0968dd3293', '④ transfer_points_from_central');
  PERFORM t.ok(t.fn_md5('public.wf_is_admin()') = '51f57b0fb3368c65e0cd0bd61d0dcec9', '④ wf_is_admin');
  PERFORM t.ok(to_regprocedure('public.can_manage_central_wallet()') IS NULL, '④ can_manage_central_wallet حُذفت');
  RAISE NOTICE 'PASS ④ التراجع يعيد تعريفات الإنتاج حرفيًا';
END $$;
\i migrations/115_owner_admin_parity.sql
SET search_path = public, extensions;
DO $$ BEGIN
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.admin_ops('OW') = '1111111', '④ إعادة 115 بعد التراجع');
END $$;

SELECT 'ALL owner-admin-parity tests passed';
