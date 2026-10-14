-- ============================================================================
-- 098_company_permissions_usage_ledger على نسخة مطابقة للإنتاج حتى 093 + 095 + 096 + 097
--
--   ⓪ قبل 098: رؤية كل فاعل وقائمة العملاء لكل فاعل
--   ① 098: الكائنات، المفتاح مطفأ، الكتالوج، سجل الظل يغطي كل التذاكر ويطابق العدّ الحي
--   ①ب التراجع حرفيًا ثم إعادة التطبيق
--   ② المفتاح مطفأ = نفس الرؤية ونفس قائمة العملاء لكل فاعل
--   ③ المفتاح مفعّل: المشرف يرى تذاكر شركته فقط، الموظف المسند إليه فقط؛ الرد والملاحظة الداخلية
--      والمرفقات والملفات؛ الحالة والإسناد عبر الدالتين؛ لا شركة أخرى؛ ملاحظات طاقم المنصة لا تظهر
--      للفريق؛ ومع العزل المفعّل كذلك
--   ④ إدارة الصلاحيات: المدير وحده، الدور ثم الحساب، الحدود (لا عميل، لا شركة أخرى، كتالوج ثابت)، والسجل إلحاقي
--   ⑤ سجل الاستهلاك: منع التكرار، ربط الاشتراك، الحذف، النقل لا يغيّر المسجَّل، الإسقاط على الإصدار 2،
--      والمطابقة لمالك المنصة وحده
--   ⑥ رفض التراجع مع صلاحيات مضبوطة
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
\i migrations/096_company_memberships.sql
SET search_path = public, extensions;
SET check_function_bodies = off;
\i tests/fixtures/tenancy/tickets.sql
\i migrations/097_ticket_scope_isolation.sql
SET search_path = public, extensions;

CREATE FUNCTION t.cust(p text) RETURNS text LANGUAGE sql AS $$
  select coalesce(jsonb_array_length(t.call(t.u(p), 'public.company_customers_list()') -> 'customers')::text, 'null') $$;
CREATE FUNCTION t.allcust() RETURNS text LANGUAGE sql AS $$
  select string_agg(n || '=' || t.cust(n), ';' order by n) from unnest(array['OA','AS','AG','A1','OB','BS','AD']) n $$;
CREATE FUNCTION t.reply(p text, p_ticket text, p_msg text, p_internal boolean) RETURNS text LANGUAGE sql AS $$
  select t.exec(t.u(p), format('insert into public.ticket_replies (ticket_id, user_id, message, is_internal) values (%L, %L, %L, %L)',
                               t.k(p_ticket), t.u(p), p_msg, p_internal)) $$;
CREATE FUNCTION t.on_perm(p_on boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  update public.platform_feature_switches set enabled = p_on where key = 'company_permissions_enabled'; END $$;
CREATE FUNCTION t.recon() RETURNS jsonb LANGUAGE sql AS $$ select public.usage_reconciliation() $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ══ ⓪ قبل 098 ═══════════════════════════════════════════════════════════
INSERT INTO t.saved VALUES ('vis0', t.allvis()), ('cust0', t.allcust()), ('schema0', t.schema_digest());
DO $$ BEGIN
  PERFORM t.ok(t.vis('AS') = 't1,r0,a0,v1,g0,l0,o0' AND t.vis('AG') = 't0,r0,a0,v0,g0,l0,o0', 'BASE staff have no ticket access');
  RAISE NOTICE 'PASS ⓪ قبل 098: الموظفون بلا وصول للتذاكر (المشرف يرى تذكرته مع مدعوم فقط)';
END $$;

-- ══ ① 098 ════════════════════════════════════════════════════════════════
\i migrations/098_company_permissions_usage_ledger.sql
SET search_path = public, extensions;
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.platform_feature_switches WHERE enabled), 'OBJ switches off');
  PERFORM t.ok((SELECT count(*) FROM public.company_permission_catalog) = 7, 'OBJ catalog');
  PERFORM t.ok((SELECT count(*) FROM public.usage_ledger WHERE event = 'ticket_created' AND source = 'backfill')
             = (SELECT count(*) FROM public.tickets), 'OBJ ledger backfill');
  r := t.recon();
  PERFORM t.ok(jsonb_array_length(r -> 'mismatches') = 0 AND (r ->> 'accounts')::int = 3 AND (r ->> 'matching')::int = 3, 'OBJ reconciliation ' || r::text);
  PERFORM t.ok(NOT has_table_privilege('authenticated', 'public.usage_ledger', 'select')
           AND NOT has_table_privilege('service_role', 'public.usage_ledger', 'select')
           AND NOT has_table_privilege('authenticated', 'public.company_role_permissions', 'select')
           AND NOT has_function_privilege('authenticated', 'public._company_perm(uuid,uuid,text)', 'execute')
           AND NOT has_function_privilege('anon', 'public.company_ticket_set_status(uuid,text)', 'execute'), 'OBJ grants');
  RAISE NOTICE 'PASS ① 098: المفتاح مطفأ، الكتالوج ثابت (7)، السجل يغطي كل التذاكر ويطابق العدّ الحي لكل حساب، والجداول مغلقة';
END $$;

-- ══ ①ب التراجع وإعادة التطبيق ══════════════════════════════════════════
\i migrations/_rollback/098_company_permissions_usage_ledger.down.sql
DO $$ BEGIN
  PERFORM t.ok(t.schema_digest() = (SELECT v FROM t.saved WHERE k = 'schema0'), 'RB schema byte-for-byte');
  RAISE NOTICE 'PASS ①ب التراجع: الدوال والسياسات والمحفّزات والأعمدة والصلاحيات والمفاتيح حرفيًا كما قبل 098';
END $$;
\i migrations/098_company_permissions_usage_ledger.sql
\i migrations/098_company_permissions_usage_ledger.sql
SET search_path = public, extensions;
DO $$ BEGIN
  PERFORM t.ok((SELECT count(*) FROM public.usage_ledger) = (SELECT count(*) FROM public.tickets), 'RE ledger not duplicated');
  RAISE NOTICE 'PASS ①ب إعادة التطبيق مرتين: لا أسطر مكررة في السجل';
END $$;

-- ══ ② المفتاح مطفأ ═══════════════════════════════════════════════════════
DO $$ BEGIN
  PERFORM t.ok(t.allvis() = (SELECT v FROM t.saved WHERE k = 'vis0'), 'SAME visibility');
  PERFORM t.ok(t.allcust() = (SELECT v FROM t.saved WHERE k = 'cust0'), 'SAME customers list ' || t.allcust());
  PERFORM t.ok(t.reply('AS', 'TA1', 'رد مشرف', false) = '42501', 'OFF supervisor cannot reply');
  PERFORM t.ok(t.err(t.u('AS'), format('public.company_ticket_set_status(%L::uuid, ''resolved'')', t.k('TA1'))) = 'P0002', 'OFF no status');
  PERFORM t.ok(t.err(t.u('OA'), 'public.company_set_role_permission(''agent'', ''tickets.view'', true)') = '0A000', 'OFF no settings');
  RAISE NOTICE 'PASS ② المفتاح مطفأ: الرؤية وقائمة العملاء مطابقتان لما قبل 098 لكل فاعل، ولا رد ولا حالة ولا إعداد';
END $$;

-- ══ ③ المفتاح مفعّل ══════════════════════════════════════════════════════
DO $$
DECLARE n int;
BEGIN
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  PERFORM t.call(t.u('OW'), 'public.owner_set_feature_switch(''company_permissions_enabled'', true, ''اختبار صلاحيات الفريق'')');
  PERFORM t.ctx(null);
  -- المشرف: تذاكر شركته (TA1 TA2) وتذكرته مع مدعوم؛ الرد العلني لا ملاحظة طاقم المنصة؛ المرفق العلني وملفه
  PERFORM t.ok(t.sees('AS', 'TA1') AND t.sees('AS', 'TA2') AND t.sees('AS', 'TAS')
           AND NOT t.sees('AS', 'TB1') AND NOT t.sees('AS', 'TA1S') AND NOT t.sees('AS', 'TOA'), 'ON supervisor tickets');
  PERFORM t.ok(t.rows(t.u('AS'), format('public.ticket_replies where ticket_id = %L', t.k('TA1'))) = 1
           AND t.rows(t.u('AS'), format('public.ticket_replies where id = %L', t.k('RINT'))) = 0, 'ON platform internal note hidden');
  PERFORM t.ok(t.rows(t.u('AS'), format('public.ticket_attachments where ticket_id = %L', t.k('TA1'))) = 1
           AND t.rows(t.u('AS'), format('storage.objects where name = %L', t.path('A1', 'TA1', 'public.png'))) = 1
           AND t.rows(t.u('AS'), format('storage.objects where name = %L', t.path('A1', 'TA1', 'internal.png'))) = 0, 'ON files');
  -- الموظف: لا شيء حتى يُسند إليه
  PERFORM t.ok(NOT t.sees('AG', 'TA1') AND NOT t.sees('AG', 'TA2'), 'ON agent nothing unassigned');
  PERFORM t.ok(t.call(t.u('AS'), format('public.company_ticket_assign(%L::uuid, %L::uuid)', t.k('TA2'), t.u('AG'))) ->> 'assigned_to' = t.u('AG')::text, 'ASSIGN by supervisor');
  PERFORM t.ok(t.sees('AG', 'TA2') AND NOT t.sees('AG', 'TA1'), 'ON agent sees assigned only');
  PERFORM t.ok(jsonb_array_length(t.call(t.u('AG'), 'public.company_tickets_list()')) = 1
           AND t.call(t.u('AG'), 'public.company_tickets_list()') -> 0 ->> 'id' = t.k('TA2')::text, 'LIST agent assigned');
  PERFORM t.ok(jsonb_array_length(t.call(t.u('AS'), 'public.company_tickets_list()')) = 2
           AND t.call(t.u('AS'), 'public.company_tickets_list()') -> 0 -> 'profiles' ? 'full_name', 'LIST supervisor company');
  PERFORM t.ok(t.call(t.u('A1'), 'public.company_tickets_list()') IS NULL
           AND NOT (t.call(t.u('BS'), 'public.company_tickets_list()')::text LIKE '%' || t.k('TA1')::text || '%'), 'LIST not customer, not other company');
  PERFORM t.ok(t.err(t.u('AS'), format('public.company_ticket_assign(%L::uuid, %L::uuid)', t.k('TA1'), t.u('BS'))) = '22023', 'ASSIGN other company staff');
  PERFORM t.ok(t.err(t.u('AS'), format('public.company_ticket_assign(%L::uuid, %L::uuid)', t.k('TA1'), t.u('A1'))) = '22023', 'ASSIGN customer');
  PERFORM t.ok(t.err(t.u('AG'), format('public.company_ticket_assign(%L::uuid, %L::uuid)', t.k('TA2'), t.u('AS'))) = 'P0002', 'ASSIGN agent no perm');
  PERFORM t.ok(t.err(t.u('BS'), format('public.company_ticket_assign(%L::uuid, null)', t.k('TA1'))) = 'P0002', 'ASSIGN other company');
  -- الرد والملاحظة الداخلية
  PERFORM t.ok(t.reply('AS', 'TA1', 'رد المشرف', false) = 'ok', 'REPLY supervisor');
  PERFORM t.ok(t.reply('AG', 'TA1', 'رد بلا إسناد', false) = '42501', 'REPLY agent unassigned');
  PERFORM t.ok(t.reply('AG', 'TA2', 'رد الموظف', false) = 'ok', 'REPLY agent assigned');
  PERFORM t.ok(t.reply('BS', 'TA1', 'رد غريب', false) = '42501', 'REPLY other company');
  PERFORM t.ok(t.reply('AS', 'TA1', 'ملاحظة الفريق', true) = 'ok', 'NOTE supervisor');
  PERFORM t.ok(t.rows(t.u('OA'), 'public.ticket_replies where message = ''ملاحظة الفريق''') = 1
           AND t.rows(t.u('A1'), 'public.ticket_replies where message = ''ملاحظة الفريق''') = 0
           AND t.rows(t.u('OB'), 'public.ticket_replies where message = ''ملاحظة الفريق''') = 0, 'NOTE visible to team only');
  PERFORM t.ok(t.rows(t.u('OA'), format('public.ticket_replies where id = %L', t.k('RINT'))) = 0, 'NOTE platform note still hidden from owner');
  -- مرفق ملاحظة الفريق: للفريق لا للعميل
  INSERT INTO public.ticket_attachments (ticket_id, reply_id, file_url, file_name, file_size, mime_type, uploaded_by, file_path)
  SELECT t.k('TA1'), id, 'x', 'team.png', 10, 'image/png', t.u('AS'), t.path('AS', 'TA1', 'team.png')
    FROM public.ticket_replies WHERE message = 'ملاحظة الفريق';
  INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('tickets', t.path('AS', 'TA1', 'team.png'), t.u('AS'));
  PERFORM t.ok(t.rows(t.u('OA'), 'public.ticket_attachments where file_name = ''team.png''') = 1
           AND t.rows(t.u('OA'), format('storage.objects where name = %L', t.path('AS', 'TA1', 'team.png'))) = 1, 'NOTE attachment team');
  PERFORM t.ok(t.rows(t.u('A1'), 'public.ticket_attachments where file_name = ''team.png''') = 0
           AND t.rows(t.u('A1'), format('storage.objects where name = %L', t.path('AS', 'TA1', 'team.png'))) = 0, 'NOTE attachment not customer');
  -- رفع ملف: المشرف في مجلده لتذكرة شركته، لا لتذكرة شركة أخرى
  PERFORM t.ok(t.exec(t.u('AS'), format('insert into storage.objects (bucket_id, name, owner) values (''tickets'', %L, %L)',
                                         t.path('AS', 'TA2', 'up.png'), t.u('AS'))) = 'ok', 'UPLOAD own company');
  -- الحالة
  PERFORM t.ok(t.call(t.u('AS'), format('public.company_ticket_set_status(%L::uuid, ''in-progress'')', t.k('TA1'))) ->> 'changed' = 'true', 'STATUS supervisor');
  PERFORM t.ok(t.err(t.u('AS'), format('public.company_ticket_set_status(%L::uuid, ''closed'')', t.k('TA1'))) = '22023', 'STATUS not allowed value');
  PERFORM t.ok(t.err(t.u('AG'), format('public.company_ticket_set_status(%L::uuid, ''resolved'')', t.k('TA1'))) = 'P0002', 'STATUS agent unassigned');
  PERFORM t.ok(t.call(t.u('AG'), format('public.company_ticket_set_status(%L::uuid, ''resolved'')', t.k('TA2'))) ->> 'status' = 'resolved', 'STATUS agent assigned');
  PERFORM t.ok(t.err(t.u('BS'), format('public.company_ticket_set_status(%L::uuid, ''resolved'')', t.k('TA1'))) = 'P0002', 'STATUS other company');
  PERFORM t.ok(t.affected(t.u('AS'), format('update public.tickets set priority = ''high'' where id = %L', t.k('TA1'))) = 0, 'STATUS no direct update');
  -- العميل يرى رد الفريق لا ملاحظته
  PERFORM t.ok(t.rows(t.u('A1'), 'public.ticket_replies where message = ''رد المشرف''') = 1, 'CUSTOMER sees team reply');
  -- شركة ب معزولة عن كل ذلك
  PERFORM t.ok(t.sees('BS', 'TB1') AND NOT t.sees('BS', 'TA1'), 'B isolated');
  -- مع العزل المفعّل: الفريق كما هو، وطاقم المنصة لا يرى تذاكر الشركة
  PERFORM t.sw('company_isolation_enforced', true);
  PERFORM t.ok(t.sees('AS', 'TA1') AND NOT t.sees('AD', 'TA1') AND t.rows(t.u('AD'), 'public.ticket_replies where message = ''ملاحظة الفريق''') = 0, 'ISO + team');
  -- مسار ملف بمعرّف تذكرة شركة أخرى في مجلده: قاعدة «مجلدي» القائمة (قبل 097) تسمح به والعزل مطفأ؛ العزل يمنعه
  PERFORM t.ok(t.exec(t.u('AS'), format('insert into storage.objects (bucket_id, name, owner) values (''tickets'', %L, %L)',
                                         t.u('AS')::text || '/' || t.k('TB1')::text || '/x.png', t.u('AS'))) = '42501', 'ISO upload other company');
  PERFORM t.sw('company_isolation_enforced', false);
  RAISE NOTICE 'PASS ③ المفتاح مفعّل: المشرف يرى تذاكر شركته وحدها، الموظف ما أُسند إليه؛ الرد والملاحظة الداخلية للفريق وحده (لا ملاحظات طاقم المنصة)؛ الحالة والإسناد عبر الدالتين ولعضو فريق الشركة فقط؛ ب معزولة؛ والعزل يحجب طاقم المنصة';
END $$;

-- ══ ④ إدارة الصلاحيات ═══════════════════════════════════════════════════
DO $$
DECLARE m jsonb;
BEGIN
  PERFORM t.ok(t.err(t.u('AS'), 'public.company_set_role_permission(''agent'', ''tickets.view'', true)') = '42501', 'SET supervisor no');
  PERFORM t.ok(t.err(t.u('OA'), 'public.company_set_role_permission(''agent'', ''billing.view'', true)') = '22023', 'SET unknown key');
  PERFORM t.ok(t.err(t.u('OA'), 'public.company_set_role_permission(''admin'', ''tickets.view'', false)') = '22023', 'SET admin role not configurable');
  PERFORM t.call(t.u('OA'), 'public.company_set_role_permission(''agent'', ''tickets.view'', true)');
  PERFORM t.ok(t.sees('AG', 'TA1'), 'SET agent role view all');
  -- تجاوز الحساب يعلو الدور، والحذف يعيده
  PERFORM t.call(t.u('OA'), format('public.company_set_user_permission(%L::uuid, ''tickets.reply'', false)', t.u('AS')));
  PERFORM t.ok(t.reply('AS', 'TA1', 'بعد المنع', false) = '42501', 'USER override deny');
  PERFORM t.call(t.u('OA'), format('public.company_set_user_permission(%L::uuid, ''tickets.reply'', null)', t.u('AS')));
  PERFORM t.ok(t.reply('AS', 'TA1', 'بعد الإعادة', false) = 'ok', 'USER override cleared');
  PERFORM t.ok(t.err(t.u('OA'), format('public.company_set_user_permission(%L::uuid, ''tickets.reply'', true)', t.u('A1'))) = 'P0002', 'USER not customer');
  PERFORM t.ok(t.err(t.u('OA'), format('public.company_set_user_permission(%L::uuid, ''tickets.reply'', true)', t.u('BS'))) = 'P0002', 'USER not other company');
  PERFORM t.ok(t.err(t.u('OB'), format('public.company_set_user_permission(%L::uuid, ''tickets.reply'', true)', t.u('AS'))) = 'P0002', 'USER other owner');
  -- قائمة العملاء بالصلاحية
  PERFORM t.ok(t.cust('AS') = t.cust('OA') AND t.cust('AS') <> 'null' AND t.cust('AG') = 'null', 'CUST by permission ' || t.cust('AS') || '/' || t.cust('AG'));
  PERFORM t.call(t.u('OA'), format('public.company_set_user_permission(%L::uuid, ''customers.view'', false)', t.u('AS')));
  PERFORM t.ok(t.cust('AS') = 'null' AND t.cust('OA') <> 'null', 'CUST revoked');
  -- القراءة
  m := t.call(t.u('AG'), 'public.my_company_permissions()');
  PERFORM t.ok((m #>> '{permissions,tickets.view}')::boolean AND NOT (m #>> '{permissions,tickets.assign}')::boolean
           AND m ->> 'role' = 'agent', 'READ my permissions');
  PERFORM t.ok(m -> 'assignees' = '[]'::jsonb, 'READ agent gets no assignee list');
  m := t.call(t.u('AS'), 'public.my_company_permissions()');
  PERFORM t.ok(jsonb_array_length(m -> 'assignees') = 3
           AND NOT (m -> 'assignees')::text LIKE '%' || t.u('A1')::text || '%'
           AND NOT (m -> 'assignees')::text LIKE '%' || t.u('BS')::text || '%', 'READ supervisor assignees = team of A ' || (m -> 'assignees')::text);
  PERFORM t.ok(t.call(t.u('A1'), 'public.my_company_permissions()') IS NULL AND t.call(t.u('AS'), 'public.company_permissions_matrix()') IS NULL, 'READ matrix admin only');
  PERFORM t.ok(jsonb_array_length(t.call(t.u('OA'), 'public.company_permissions_matrix()') -> 'overrides') = 1, 'READ matrix overrides');
  PERFORM t.ok((SELECT count(*) FROM public.company_permission_events WHERE company_id = t.u('CA')) = 4, 'AUDIT events');
  PERFORM t.ok(t.err_super_ok('delete from public.company_permission_events') = '23514', 'AUDIT append-only');
  RAISE NOTICE 'PASS ④ إدارة الصلاحيات: مدير الشركة وحده، كتالوج ثابت، تجاوز الحساب يعلو الدور ويُلغى، لا عميل ولا موظف شركة أخرى، والسجل إلحاقي';
END $$;

-- ══ ⑤ سجل الاستهلاك ══════════════════════════════════════════════════════
DO $$
DECLARE tn uuid; n int; r jsonb; p jsonb;
BEGIN
  -- تذكرة جديدة = سطر واحد، والتكرار لا يضيف
  PERFORM t.exec(t.u('A1'), format('insert into public.tickets (user_id, title, description) values (%L, ''استهلاك أ1'', ''وصف'')', t.u('A1')));
  tn := (SELECT id FROM public.tickets WHERE title = 'استهلاك أ1');
  PERFORM t.ok((SELECT account_id = t.u('OA') AND ticket_scope = 'company' AND counter = 'used' AND units = 1
                  FROM public.usage_ledger WHERE ticket_id = tn), 'LEDGER new ticket');
  PERFORM public._usage_record_ticket((SELECT x FROM public.tickets x WHERE id = tn), 'trigger');
  PERFORM t.ok((SELECT count(*) FROM public.usage_ledger WHERE ticket_id = tn) = 1, 'LEDGER idempotent');
  -- ربط اشتراك = تحويل للعدّاد billing مرة واحدة
  INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, ticket_id)
  VALUES (t.u('A1'), 'support', 'pending', 'monthly', now(), now() + interval '30 days', 30, tn);
  UPDATE public.whatsapp_subscriptions SET ticket_id = tn WHERE ticket_id = tn;
  PERFORM public._usage_record_billing_link(tn, 'trigger');
  PERFORM t.ok((SELECT sum(units) FILTER (WHERE counter = 'used') = 0 AND sum(units) FILTER (WHERE counter = 'billing') = 1
                  AND count(*) = 3 FROM public.usage_ledger WHERE ticket_id = tn), 'LEDGER billing link once');
  r := t.recon();
  PERFORM t.ok(jsonb_array_length(r -> 'mismatches') = 0, 'RECON after link ' || r::text);
  -- حذف تذكرة: عكس الصافي، والمطابقة باقية
  PERFORM t.exec(t.u('PU'), format('insert into public.tickets (user_id, title, description) values (%L, ''ستُحذف'', ''وصف'')', t.u('PU')));
  DELETE FROM public.tickets WHERE title = 'ستُحذف';
  PERFORM t.ok((SELECT sum(units) FROM public.usage_ledger WHERE ticket_user_id = t.u('PU') AND detail = '{}'
                  AND ticket_id NOT IN (SELECT id FROM public.tickets)) = 0, 'LEDGER delete reversed');
  PERFORM t.ok(jsonb_array_length(t.recon() -> 'mismatches') = 0, 'RECON after delete');
  -- نقل عميل بين الشركات: المسجَّل لا يتغير، والفرق مُفسَّر
  n := (SELECT count(*) FROM public.usage_ledger WHERE account_id = t.u('OA'));
  PERFORM t.act(t.u('EA'));
  UPDATE public.profiles SET super_user_id = t.u('OB') WHERE id = t.u('A2');
  PERFORM t.act(null);
  PERFORM t.ok((SELECT count(*) FROM public.usage_ledger WHERE account_id = t.u('OA')) = n
           AND (SELECT account_id FROM public.usage_ledger WHERE ticket_id = t.k('TA2')) = t.u('OA'), 'MOVE ledger unchanged');
  r := t.recon();
  PERFORM t.ok(jsonb_array_length(r -> 'mismatches') = 2
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'mismatches') e WHERE e ->> 'reason' <> 'membership_changed'), 'MOVE explained ' || r::text);
  -- الإسقاط على الإصدار 2: تذكرة فوترة أ1 الشخصية (TA1S) على أ1 نفسه لا على شركته
  p := public.usage_projection(2);
  PERFORM t.ok(EXISTS (SELECT 1 FROM jsonb_array_elements(p) e WHERE e ->> 'account_id' = t.u('A1')::text), 'PROJ v2 personal');
  PERFORM t.ok((SELECT sum((e ->> 'used')::int + (e ->> 'billing')::int) FROM jsonb_array_elements(p) e)
             = (SELECT sum((e ->> 'used')::int + (e ->> 'billing')::int) FROM jsonb_array_elements(public.usage_projection(1)) e), 'PROJ same total');
  -- الحراسة
  PERFORM t.ok(t.err_super_ok('update public.usage_ledger set units = 0') = '23514'
           AND t.err_super_ok('truncate public.usage_ledger') = '23514', 'LEDGER append-only');
  PERFORM t.ok(t.err(t.u('EA'), 'public.usage_reconciliation()') = '42501' AND t.err(t.u('OA'), 'public.usage_projection(2)') = '42501', 'RECON owner only');
  PERFORM t.ctx('owner');
  PERFORM t.ok(t.err(t.u('OW'), 'public.usage_reconciliation()') = 'ok', 'RECON owner ok');
  PERFORM t.ctx(null);
  PERFORM t.ok(t.exec(t.u('OA'), 'select * from public.usage_ledger') = '42501', 'LEDGER no direct read');
  RAISE NOTICE 'PASS ⑤ سجل الاستهلاك: سطر واحد لكل حدث بمفتاح فريد، ربط الاشتراك مرة واحدة، الحذف يُعكس، نقل العميل لا يغيّر المسجَّل والفرق مُفسَّر، الإسقاط على الإصدار 2 يحفظ المجموع، والمطابقة لمالك المنصة وحده';
END $$;

-- ══ ⑥ رفض التراجع ═══════════════════════════════════════════════════════
\set rbsql `cat migrations/_rollback/098_company_permissions_usage_ledger.down.sql`
SELECT set_config('t.rbsql', :'rbsql', false) IS NOT NULL;
DO $$
BEGIN
  UPDATE public.platform_feature_switches SET enabled = false;
  BEGIN
    EXECUTE current_setting('t.rbsql');
    RAISE EXCEPTION 'FAIL RB allowed with settings';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%مرفوض%' THEN RAISE; END IF;
  END;
  PERFORM t.ok(to_regclass('public.company_permission_events') IS NOT NULL, 'RB kept');
  RAISE NOTICE 'PASS ⑥ التراجع مرفوض مع صلاحيات مضبوطة أو سجل تغييرها';
END $$;

SELECT 'ALL company-permissions-ledger tests passed';
