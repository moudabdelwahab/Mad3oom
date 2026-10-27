-- ============================================================================
-- صفحات لوحة المالك المستقلة (/owner/*.html): ما تفعله كل صفحة تقرّره القاعدة لا الواجهة.
-- على نسخة مطابقة للإنتاج حتى 114، بلا أي ترحيل جديد — الصفحات لم تغيّر صلاحية واحدة.
--
--   ① المالك في سياق «مالك المنصة» يقرأ ما تعرضه الصفحات: الحسابات، التذاكر (نطاق مدعوم)، النشاط،
--      مفاتيح API، الاشتراكات (admin_list_subscriptions)، الشركات (admin_customer_filter_options)
--   ② ويكتب ما تكتبه: حظر عميل ورفعه، تغيير حالة التذكرة ومسؤولها، حالة الاشتراك عبر الدالة،
--      إيقاف مفتاح API، تحرير المدوّنة
--   ③ وما يبقى للإدارة يُرفض من القاعدة نفسها لا بإخفاء زر: advanced_settings وworking_hours ومحافظ
--      user_wallets (الرتبة الحرفية admin)، وأعمدة اعتماد api_tokens، وحظر الطاقم بلا تحقق بخطوتين،
--      وحساب المالك من غيره
--   ④ السياق مُرشِّح: المالك في «العميل» أو بلا سياق لا يقرأ ولا يكتب شيئًا من ذلك
--   ⑤ الإدارة كما هي: الأدمن يكتب advanced_settings ويقرأ الاشتراكات
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

INSERT INTO public.api_tokens (id, user_id, name, api_key, secret_hash, secret_last_four, is_active)
VALUES ('a0000000-0000-4000-8000-0000000000e1', t.u('OA'), 'مفتاح OA', 'mk_oa_owner_pages', 'hash-oa', 'oaoa', true);
INSERT INTO public.advanced_settings (key, value) VALUES ('owner_pages_probe', '"x"'::jsonb);
INSERT INTO public.user_wallets (user_id, total_points, available_points) VALUES (t.u('PU'), 10, 10);
INSERT INTO public.activity_logs (user_id, user_role, action, details) VALUES (t.u('PU'), 'user', 'login', '{}');
-- إداري مقفول بعد محاولات فاشلة: فكّ قفله تغيير حقيقي (لا تحديث بلا أثر)
UPDATE public.profiles SET is_locked = true, failed_login_attempts = 5 WHERE id = t.u('AD');

CREATE FUNCTION t.n(p text, p_sql text) RETURNS int LANGUAGE sql AS $$ select t.affected(t.u(p), p_sql) $$;
CREATE FUNCTION t.sub(p text) RETURNS uuid LANGUAGE sql AS $$
  select id from public.whatsapp_subscriptions where user_id = t.u(p) order by created_at limit 1 $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ══ ① القراءة في سياق المالك ═══════════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ctx('owner');
  PERFORM t.ok(t.rows(t.u('OW'), 'public.profiles') = (select count(*) from public.profiles), '① المالك يرى كل الحسابات');
  PERFORM t.ok(t.rows(t.u('OW'), format('public.tickets where id = %L', t.k('TPU'))) = 1, '① المالك يرى تذكرة دعم مدعوم');
  PERFORM t.ok(t.rows(t.u('OW'), format('public.activity_logs where user_id = %L', t.u('PU'))) = 1, '① المالك يقرأ نشاط غيره');
  PERFORM t.ok(t.rows(t.u('OW'), 'public.api_tokens where id = ''a0000000-0000-4000-8000-0000000000e1''') = 1, '① المالك يرى مفتاح غيره');
  PERFORM t.ok(jsonb_array_length(t.call(t.u('OW'), 'public.admin_list_subscriptions()')) >= 3, '① admin_list_subscriptions للمالك');
  PERFORM t.ok(jsonb_array_length(t.call(t.u('OW'), 'public.admin_customer_filter_options()') -> 'companies') = 3, '① كل الشركات من دليل العملاء');
  -- companies نفسها: سياسة المالك صاحب شركته وحدها — سبب قراءة العدد من الدليل
  PERFORM t.ok(t.rows(t.u('OW'), 'public.companies') = 1, '① companies مباشرةً = شركة المالك وحدها');
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_feature_switches()') = 'ok', '① مفاتيح التفعيل للقراءة');
  RAISE NOTICE 'PASS ① سياق المالك: الحسابات والتذاكر والنشاط والمفاتيح والاشتراكات والشركات مقروءة';
END $$;

-- ══ ② الكتابة في سياق المالك ═══════════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ctx('owner');
  PERFORM t.ok(t.n('OW', format('update public.profiles set ban_status = ''temporary'', ban_until = now() + interval ''3 days'', ban_reason = ''إساءة'' where id = %L', t.u('PU'))) = 1,
               '② المالك يحظر عميلًا مؤقتًا');
  PERFORM t.ok((select public.is_banned(t.u('PU'))), '② الحظر نافذ (is_banned)');
  PERFORM t.ok(t.n('OW', format('update public.profiles set ban_status = ''none'', ban_until = null, ban_reason = null where id = %L', t.u('PU'))) = 1,
               '② المالك يرفع الحظر');
  PERFORM t.ok(NOT (select public.is_banned(t.u('PU'))), '② رُفع الحظر');
  PERFORM t.ok(t.n('OW', format('update public.tickets set status = ''in-progress'', assigned_to = %L, last_updated_by = %L where id = %L',
                                t.u('SUP'), t.u('OW'), t.k('TPU'))) = 1, '② المالك يغيّر حالة التذكرة ومسؤولها');
  PERFORM t.ok(t.err(t.u('OW'), format('public.admin_set_subscription_status(%L::uuid, ''expired'', ''اختبار المالك'')', t.sub('OA'))) = 'ok',
               '② المالك يعطّل اشتراكًا عبر الدالة');
  PERFORM t.ok((select status from public.whatsapp_subscriptions where id = t.sub('OA')) = 'expired', '② الحالة تغيّرت');
  PERFORM t.ok((select count(*) from public.subscription_audit_log where subscription_id = t.sub('OA') and reason = 'اختبار المالك') = 1,
               '② السبب في سجل الاشتراك');
  PERFORM t.ok(t.err(t.u('OW'), format('public.admin_set_subscription_status(%L::uuid, ''rejected'', ''انتقال ممنوع'')', t.sub('OA'))) <> 'ok',
               '② الانتقال غير المسموح (expired→rejected) مرفوض من الدالة');
  PERFORM t.ok(t.n('OW', 'update public.api_tokens set is_active = false, revoked_at = now() where id = ''a0000000-0000-4000-8000-0000000000e1''') = 1,
               '② المالك يوقف مفتاح API');
  PERFORM t.ok(t.exec(t.u('OW'), 'insert into public.blog_posts (slug, title, content) values (''owner-post'', ''مقال المالك'', ''متن'')') = 'ok',
               '② المالك يكتب في المدوّنة');
  PERFORM t.ok(t.exec(t.u('OW'), format('insert into public.activity_logs (user_id, user_role, action, details) values (%L, ''platform_owner'', ''ban_user'', ''{}'')', t.u('OW'))) = 'ok',
               '② أثر المالك في سجل النشاط');
  RAISE NOTICE 'PASS ② سياق المالك: الحظر ورفعه، التذكرة، حالة الاشتراك بالسبب، إيقاف المفتاح، المدوّنة، سجل النشاط';
END $$;

-- ══ ③ ما يبقى للإدارة ═════════════════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ctx('owner');
  PERFORM t.ok(t.n('OW', 'update public.advanced_settings set value = ''"owner"'' where key = ''owner_pages_probe''') = 0, '③ advanced_settings: صفر صفوف للمالك');
  PERFORM t.ok(t.exec(t.u('OW'), 'insert into public.advanced_settings (key, value) values (''owner_try'', ''1'')') = '42501', '③ advanced_settings: إدراج المالك مرفوض');
  PERFORM t.ok(t.rows(t.u('OW'), 'public.advanced_settings where key = ''owner_pages_probe''') = 0, '③ advanced_settings: لا قراءة لغير registration_mode');
  PERFORM t.ok(t.exec(t.u('OW'), 'insert into public.working_hours (day_of_week) values (1)') = '42501', '③ working_hours: مرفوض للمالك');
  PERFORM t.ok(t.rows(t.u('OW'), format('public.user_wallets where user_id = %L', t.u('PU'))) = 0, '③ user_wallets: محفظة غيره غير مرئية');
  PERFORM t.ok(t.n('OW', format('update public.user_wallets set total_points = 999 where user_id = %L', t.u('PU'))) = 0, '③ user_wallets: لا تعديل نقاط');
  PERFORM t.ok(t.exec(t.u('OW'), 'update public.api_tokens set secret_hash = ''x'' where id = ''a0000000-0000-4000-8000-0000000000e1''') = '42501',
               '③ api_tokens: أعمدة الاعتماد مرفوضة للمالك');
  -- حظر الطاقم: بلا تحقق بخطوتين مرفوض، ومعه مسموح (guard_privileged_accounts)
  DELETE FROM public.privileged_step_ups WHERE user_id = t.u('OW');
  PERFORM t.ok(t.exec(t.u('OW'), format('update public.profiles set ban_status = ''permanent'', ban_reason = ''x'' where id = %L', t.u('SUP'))) = '42501',
               '③ حظر فريق الدعم بلا تحقق بخطوتين مرفوض');
  PERFORM t.ok(t.exec(t.u('OW'), format('update public.profiles set is_locked = false, failed_login_attempts = 0 where id = %L', t.u('AD'))) = '42501',
               '③ فكّ قفل إداري بلا تحقق بخطوتين مرفوض');
  PERFORM t.stepup(t.u('OW'));
  PERFORM t.ok(t.n('OW', format('update public.profiles set ban_status = ''permanent'', ban_reason = ''x'' where id = %L', t.u('SUP'))) = 1,
               '③ ومعه مسموح');
  PERFORM t.ok(t.n('OW', format('update public.profiles set ban_status = ''none'', ban_reason = null where id = %L', t.u('SUP'))) = 1, '③ ورفعه');
  PERFORM t.ok(t.n('OW', format('update public.profiles set is_locked = false, failed_login_attempts = 0 where id = %L', t.u('AD'))) = 1,
               '③ وفكّ قفل الإداري بعد التحقق');
  -- حساب المالك من غيره: ممنوع حتى على الإداري المرتفع (guard_privileged_accounts، فرع owner)
  PERFORM t.ok(t.exec(t.u('EA'), format('update public.profiles set ban_status = ''permanent'' where id = %L', t.u('OW'))) IN ('42501')
               OR t.n('EA', format('update public.profiles set ban_status = ''permanent'' where id = %L', t.u('OW'))) = 0,
               '③ لا أحد غير المالك يقيّد حساب المالك');
  -- الأدمن لا يحظر الطاقم أصلًا (ليس المالك)
  PERFORM t.ok(t.exec(t.u('AD'), format('update public.profiles set ban_status = ''permanent'' where id = %L', t.u('SUP'))) IN ('42501')
               OR t.n('AD', format('update public.profiles set ban_status = ''permanent'' where id = %L', t.u('SUP'))) = 0,
               '③ الأدمن لا يحظر فريق الدعم');
  RAISE NOTICE 'PASS ③ advanced_settings وworking_hours والمحافظ وأعمدة الاعتماد للإدارة/الخدمة وحدها؛ الطاقم بتحقق بخطوتين؛ حساب المالك محمي من غيره';
END $$;

-- ══ ④ السياق مُرشِّح ═══════════════════════════════════════════════════════
DO $$
DECLARE ctx text;
BEGIN
  FOREACH ctx IN ARRAY array['customer', 'company_admin', ''] LOOP
    PERFORM t.ctx(nullif(ctx, ''));
    PERFORM t.ok(t.rows(t.u('OW'), format('public.profiles where id = %L', t.u('PU'))) = 0, format('④ %s: لا حسابات غيره', ctx));
    PERFORM t.ok(t.rows(t.u('OW'), format('public.activity_logs where user_id = %L', t.u('PU'))) = 0, format('④ %s: لا نشاط غيره', ctx));
    PERFORM t.ok(t.err(t.u('OW'), 'public.admin_list_subscriptions()') = '42501', format('④ %s: الاشتراكات مرفوضة', ctx));
    PERFORM t.ok(t.n('OW', format('update public.tickets set priority = ''low'' where id = %L', t.k('TPU'))) = 0, format('④ %s: لا تعديل تذاكر', ctx));
    PERFORM t.ok(t.n('OW', 'update public.api_tokens set is_active = true where id = ''a0000000-0000-4000-8000-0000000000e1''') = 0, format('④ %s: لا مفاتيح', ctx));
    PERFORM t.ok(t.exec(t.u('OW'), 'insert into public.blog_posts (slug, title, content) values (''ctx-' || coalesce(nullif(ctx, ''), 'none') || ''', ''x'', ''x'')') = '42501',
                 format('④ %s: لا مدوّنة', ctx));
  END LOOP;
  RAISE NOTICE 'PASS ④ خارج سياق المالك (العميل، الشركة، بلا سياق): لا قراءة ولا كتابة';
END $$;

-- ══ ⑤ الإدارة كما هي ═════════════════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ok(t.n('AD', 'update public.advanced_settings set value = ''"admin"'' where key = ''owner_pages_probe''') = 1, '⑤ الأدمن يكتب advanced_settings');
  PERFORM t.ok(jsonb_array_length(t.call(t.u('AD'), 'public.admin_list_subscriptions()')) >= 3, '⑤ الأدمن يقرأ الاشتراكات');
  PERFORM t.ok(t.rows(t.u('AD'), format('public.user_wallets where user_id = %L', t.u('PU'))) = 1, '⑤ الأدمن يرى المحفظة');
  RAISE NOTICE 'PASS ⑤ صلاحيات الإدارة لم تتغير';
END $$;

SELECT 'ALL owner-pages-authority tests passed';
