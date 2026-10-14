-- ============================================================================
-- 097_ticket_scope_isolation على نسخة مطابقة للإنتاج حتى 093 + 095 + 096
--
--   ⓪ قبل 097: ما يراه كل فاعل من التذاكر وردودها ومرفقاتها ونشاطها وتقييماتها ووسومها وملفاتها،
--      وإثبات الثغرة: مرفق الرد الداخلي ظاهر لصاحب التذكرة (الجدول والملف)
--   ① 097: الكائنات، المفاتيح مطفأة، الملء الأولي للنطاق، الصلاحيات
--   ② المفتاح مطفأ = نفس الرؤية لكل فاعل، عدا إصلاح المرفق الداخلي
--   ③ الختم عند الإنشاء: عميل ← شركته، الفوترة والمالك والموظف والفرد ← مدعوم، الصريح، الثبات،
--      سياق العضوية الإضافية، وتحويل طلب مركز التكاملات بشركة صريحة
--   ④ التراجع يعيد كل شيء حرفيًا، ثم إعادة التطبيق
--   ⑤ العزل مفعّل: طاقم المنصة لا يرى تذاكر الشركات ولا ملفاتها ولا يكتب فيها؛ الشركة لا ترى
--      تذاكر عملائها مع مدعوم؛ والإطفاء يعيد الحال
--   ⑥ القنوات الجانبية: إشعارات الطاقم، التوزيع الآلي، webhooks، سير العمل، MCP، SLA
--   ⑦ طلبات الوصول: القواعد، المالك وحده بتحقق خطوتين، لا موافقة ذاتية، مدة محدودة، كل قراءة
--      مسجَّلة، الشركة ترى السجل، الإلغاء والانتهاء، والسجل إلحاقي
--   ⑧ رفض التراجع مع وجود سجل وصول أو مفتاح مفعّل
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

-- ══ ⓪ قبل 097 ═══════════════════════════════════════════════════════════
INSERT INTO t.saved VALUES ('vis0', t.allvis()), ('schema0', t.schema_digest()),
  ('notif0', (SELECT count(*) FROM public.notifications)::text), ('act0', (SELECT count(*) FROM public.ticket_activity)::text);
DO $$
BEGIN
  -- الثغرة: صاحب التذكرة يرى مرفق الملاحظة الداخلية وملفها
  PERFORM t.ok(t.rows(t.u('A1'), format('public.ticket_attachments where reply_id = %L', t.k('RINT'))) = 1, 'LEAK0 row');
  PERFORM t.ok(t.rows(t.u('A1'), format('storage.objects where name = %L', t.path('A1', 'TA1', 'internal.png'))) = 1, 'LEAK0 file');
  -- الطاقم يرى تذاكر الشركات، والشركة ترى تذكرة عميلها مع مدعوم (فوترة شخصية)
  PERFORM t.ok(t.sees('AD', 'TA1') AND t.sees('SUP', 'TB1') AND t.sees('OA', 'TA1S'), 'LEAK0 visibility');
  RAISE NOTICE 'PASS ⓪ قبل 097: رؤية كل فاعل محفوظة؛ مرفق الملاحظة الداخلية ظاهر لصاحب التذكرة (ثغرة)';
END $$;

-- ══ ① 097 ════════════════════════════════════════════════════════════════
\i migrations/097_ticket_scope_isolation.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.platform_feature_switches WHERE enabled)
           AND (SELECT count(*) FROM public.platform_feature_switches
                 WHERE key IN ('company_isolation_enforced', 'data_access_grants_enabled')) = 2, 'OBJ switches off');
  PERFORM t.ok((SELECT string_agg(k || ':' || scope || ':' || coalesce(company_id::text, '-'), ',' ORDER BY k)
                  FROM (SELECT n k, x.scope, x.company_id FROM unnest(array['TA1','TA1S','TA2','TB1','TOA','TAS','TPU']) n
                          JOIN public.tickets x ON x.id = t.k(n)) s)
             = format('TA1:company:%s,TA1S:mad3oom_support:-,TA2:company:%s,TAS:mad3oom_support:-,TB1:company:%s,TOA:mad3oom_support:-,TPU:mad3oom_support:-',
                      t.u('CA'), t.u('CA'), t.u('CB')), 'OBJ backfill');
  -- الملء الأولي لم يُنتج نشاطًا ولا إشعارًا
  PERFORM t.ok((SELECT count(*) FROM public.ticket_activity)::text = (SELECT v FROM t.saved WHERE k = 'act0'), 'OBJ backfill no activity');
  PERFORM t.ok((SELECT count(*) FROM public.notifications)::text = (SELECT v FROM t.saved WHERE k = 'notif0'), 'OBJ backfill no notifications');
  PERFORM t.ok(NOT has_table_privilege('authenticated', 'public.data_access_grants', 'select')
           AND NOT has_table_privilege('authenticated', 'public.company_access_audit', 'select')
           AND NOT has_table_privilege('service_role', 'public.data_access_requests', 'select')
           AND NOT has_table_privilege('authenticated', 'public.access_requester_rules', 'select'), 'OBJ no direct access');
  PERFORM t.ok(NOT has_function_privilege('authenticated', 'public._access_grant_active(uuid)', 'execute')
           AND NOT has_function_privilege('authenticated', 'public._ticket_scope_stamp()', 'execute')
           AND NOT has_function_privilege('authenticated', 'public.mcp_ticket_tenancy(uuid)', 'execute')
           AND has_function_privilege('service_role', 'public.mcp_ticket_tenancy(uuid)', 'execute')
           AND NOT has_function_privilege('anon', 'public.request_data_access(uuid,uuid,text,integer)', 'execute'), 'OBJ grants');
  RAISE NOTICE 'PASS ① 097: المفاتيح مطفأة، النطاق مختوم (عملاء الشركات ← شركتهم؛ الفوترة والمالك والموظف والفرد ← مدعوم) بلا نشاط ولا إشعار، والجداول مغلقة';
END $$;

-- ══ ② المفتاح مطفأ ═══════════════════════════════════════════════════════
DO $$
DECLARE v0 text := (SELECT v FROM t.saved WHERE k = 'vis0'); v1 text := t.allvis();
BEGIN
  -- الفرق الوحيد: المرفق الداخلي وملفه اختفيا لغير الطاقم (A1 وOA وA2 لا يرونه الآن)
  PERFORM t.ok(t.rows(t.u('A1'), format('public.ticket_attachments where reply_id = %L', t.k('RINT'))) = 0, 'FIX row hidden');
  PERFORM t.ok(t.rows(t.u('A1'), format('storage.objects where name = %L', t.path('A1', 'TA1', 'internal.png'))) = 0, 'FIX file hidden');
  PERFORM t.ok(t.rows(t.u('OA'), format('public.ticket_attachments where reply_id = %L', t.k('RINT'))) = 0, 'FIX owner hidden');
  PERFORM t.ok(t.rows(t.u('SUP'), format('public.ticket_attachments where reply_id = %L', t.k('RINT'))) = 1
           AND t.rows(t.u('AD'), format('storage.objects where name = %L', t.path('A1', 'TA1', 'internal.png'))) = 1, 'FIX staff still');
  PERFORM t.ok(t.rows(t.u('A1'), format('public.ticket_attachments where reply_id = %L', t.k('RPUB'))) = 1, 'FIX public reply attachment kept');
  -- كل ما عدا ذلك مطابق: نطرح أثر المرفق الداخلي من لقطة ما قبل 097 لمن تغيّر لهم فقط
  PERFORM t.ok(replace(replace(v0, 'A1=t2,r1,a2,v2,g1,l0,o2', 'A1=t2,r1,a1,v2,g1,l0,o1'),
                       'OA=t5,r1,a2,v5,g1,l0,o2', 'OA=t5,r1,a1,v5,g1,l0,o1') = v1 AND v0 <> v1,
               'SAME visibility except the fix: ' || v0 || ' → ' || v1);
  RAISE NOTICE 'PASS ② المفتاح مطفأ: رؤية كل فاعل لكل الجداول والملفات مطابقة لما قبل 097، عدا إخفاء مرفق الملاحظة الداخلية عن غير الطاقم';
END $$;

-- ══ ③ الختم ══════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ok(t.exec(t.u('A1'), format('insert into public.tickets (user_id, title, description) values (%L, ''ختم أ1'', ''وصف كافٍ'')', t.u('A1'))) = 'ok', 'STAMP insert ok');
  PERFORM t.ok((SELECT scope || ':' || company_id FROM public.tickets WHERE title = 'ختم أ1') = 'company:' || t.u('CA'), 'STAMP customer → company');
  PERFORM t.ok(t.exec(t.u('A1'), format('insert into public.tickets (user_id, title, description, category) values (%L, ''فوترة أ1'', ''وصف'', ''subscription'')', t.u('A1'))) = 'ok', 'STAMP insert ok');
  PERFORM t.ok((SELECT scope FROM public.tickets WHERE title = 'فوترة أ1') = 'mad3oom_support', 'STAMP billing → mad3oom');
  PERFORM t.ok(t.exec(t.u('A1'), format('insert into public.tickets (user_id, title, description, scope) values (%L, ''أ1 لمدعوم'', ''وصف'', ''mad3oom_support'')', t.u('A1'))) = 'ok', 'STAMP insert ok');
  PERFORM t.ok((SELECT company_id FROM public.tickets WHERE title = 'أ1 لمدعوم') IS NULL, 'STAMP explicit mad3oom');
  PERFORM t.ok(t.exec(t.u('A1'), format('insert into public.tickets (user_id, title, description, company_id) values (%L, ''غريبة'', ''وصف'', %L)', t.u('A1'), t.u('CB'))) = '42501', 'STAMP foreign company');
  PERFORM t.ok(t.exec(t.u('A1'), format('insert into public.tickets (user_id, title, description, scope, company_id) values (%L, ''متناقضة'', ''وصف'', ''mad3oom_support'', %L)', t.u('A1'), t.u('CA'))) = '22023', 'STAMP contradictory');
  PERFORM t.ok(t.exec(t.u('A1'), format('insert into public.tickets (user_id, title, description, scope, category) values (%L, ''فوترة للشركة'', ''وصف'', ''company'', ''subscription'')', t.u('A1'))) = '22023', 'STAMP billing never company');
  PERFORM t.ok(t.exec(t.u('PU'), format('insert into public.tickets (user_id, title, description, scope) values (%L, ''فرد يدّعي شركة'', ''وصف'', ''company'')', t.u('PU'))) = '42501', 'STAMP independent cannot claim');
  PERFORM t.ok(t.exec(t.u('OA'), format('insert into public.tickets (user_id, title, description) values (%L, ''مالك أ جديد'', ''وصف'')', t.u('OA'))) = 'ok', 'STAMP insert ok');
  PERFORM t.ok((SELECT scope FROM public.tickets WHERE title = 'مالك أ جديد') = 'mad3oom_support', 'STAMP owner → mad3oom');
  PERFORM t.ok(t.exec(t.u('AS'), format('insert into public.tickets (user_id, title, description) values (%L, ''مشرف أ جديد'', ''وصف'')', t.u('AS'))) = 'ok', 'STAMP insert ok');
  PERFORM t.ok((SELECT scope FROM public.tickets WHERE title = 'مشرف أ جديد') = 'mad3oom_support', 'STAMP staff → mad3oom');
  -- الثبات: حتى الأدمن لا يغيّر النطاق أو الشركة
  PERFORM t.ok(t.exec(t.u('AD'), format('update public.tickets set scope = ''mad3oom_support'', company_id = null where id = %L', t.k('TA1'))) = '42501', 'STAMP immutable admin');
  PERFORM t.ok(t.err_super_ok(format('update public.tickets set company_id = %L where id = %L', t.u('CB'), t.k('TA1'))) = '42501', 'STAMP immutable superuser');
  -- عضوية إضافية: العميل في سياق ب يكتب لشركة ب
  PERFORM t.sw('multi_company_memberships_enabled', true);
  PERFORM t.call(t.u('OB'), 'public.company_invite_customer(''a1@tenancy.test'')');
  PERFORM t.call(t.u('A1'), format('public.company_invitation_respond(%L::uuid, true)',
                 (SELECT id FROM public.company_membership_invitations WHERE invited_email = 'a1@tenancy.test')));
  PERFORM t.call(t.u('A1'), format('public.enter_customer_company(%L::uuid)', t.u('CB')));
  PERFORM t.ok(t.exec(t.u('A1'), format('insert into public.tickets (user_id, title, description) values (%L, ''أ1 في سياق ب'', ''وصف'')', t.u('A1'))) = 'ok', 'STAMP insert ok');
  PERFORM t.ok((SELECT company_id FROM public.tickets WHERE title = 'أ1 في سياق ب') = t.u('CB'), 'STAMP context B');
  PERFORM t.call(t.u('A1'), 'public.enter_customer_company(null)');
  -- مركز التكاملات: تحويل طلب لعميل إضافي = تذكرة لشركة الطلب صراحة لا لأساسيته
  INSERT INTO public.company_feature_overrides (company_id, feature_key, reason) VALUES (t.u('CB'), 'integrations_hub', 'اختبار 097');
  INSERT INTO public.ihub_intake_requests (id, company_id, requester_name, requester_email, subject, message)
  VALUES ('1e000000-0000-4000-8000-000000000001', t.u('CB'), 'أ1', 'a1@tenancy.test', 'طلب من موقع ب', 'رسالة من الموقع');
  r := t.call(t.u('OB'), format('public.ihub_intake_convert(%L::uuid, %L::uuid)', '1e000000-0000-4000-8000-000000000001', t.u('A1')));
  PERFORM t.ok((SELECT scope || ':' || company_id FROM public.tickets WHERE id = (r ->> 'ticket_id')::uuid) = 'company:' || t.u('CB'), 'STAMP ihub explicit');
  PERFORM t.ok(public._ihub_ticket_company((r ->> 'ticket_id')::uuid) = t.u('CB') AND public._ihub_ticket_company(t.k('TA1S')) IS NULL,
               'STAMP ihub company from stamp');
  RAISE NOTICE 'PASS ③ الختم: العميل ← شركته (أو سياقه)، الفوترة والمالك والموظف ← مدعوم، لا شركة غريبة ولا تناقض، ولا تغيير بعد الإنشاء حتى للمشرف العام';
END $$;
-- إعادة الحال لما قبل ③ (للتراجع): تذاكر ③ وعضوية A1 في ب
BEGIN;
SET LOCAL session_replication_role = replica;
DELETE FROM public.ticket_activity WHERE ticket_id IN (SELECT id FROM public.tickets WHERE NOT (id = any(t.fxt())));
DELETE FROM public.ihub_intake_requests;
DELETE FROM public.tickets WHERE NOT (id = any(t.fxt()));
DELETE FROM public.company_feature_overrides WHERE reason = 'اختبار 097';
DELETE FROM public.notifications WHERE title IN ('دعوة للانضمام إلى شركة', 'تذكرة جديدة');
DELETE FROM public.company_membership_events WHERE action <> 'joined' OR detail ->> 'via' = 'invitation';
DELETE FROM public.company_membership_invitations;
DELETE FROM public.company_memberships WHERE user_id = t.u('A1') AND company_id = t.u('CB');
UPDATE public.platform_feature_switches SET enabled = false;
COMMIT;

-- ══ ④ التراجع وإعادة التطبيق ═════════════════════════════════════════════
\i migrations/_rollback/097_ticket_scope_isolation.down.sql
DO $$
BEGIN
  PERFORM t.ok(t.schema_digest() = (SELECT v FROM t.saved WHERE k = 'schema0'), 'RB schema byte-for-byte');
  PERFORM t.ok(t.allvis() = (SELECT v FROM t.saved WHERE k = 'vis0'), 'RB visibility back (leak returns)');
  RAISE NOTICE 'PASS ④ التراجع: الدوال والمحفّزات والسياسات والأعمدة والصلاحيات والمفاتيح حرفيًا كما قبل 097 (والثغرة تعود)';
END $$;
\i migrations/097_ticket_scope_isolation.sql
\i migrations/097_ticket_scope_isolation.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok((SELECT count(*) FROM public.tickets WHERE id = any(t.fxt()) AND scope = 'company') = 3, 'RE backfill again');
  PERFORM t.ok(t.rows(t.u('A1'), format('public.ticket_attachments where reply_id = %L', t.k('RINT'))) = 0, 'RE fix again');
  RAISE NOTICE 'PASS ④ب إعادة التطبيق مرتين: نفس النطاق ونفس الإصلاح';
END $$;
INSERT INTO t.saved VALUES ('vis1', t.allvis());

-- ══ ⑤ العزل مفعّل ═══════════════════════════════════════════════════════
DO $$
BEGIN
  -- التفعيل لمالك المنصة وحده بسياق وتحقق خطوتين
  PERFORM t.ok(t.err(t.u('EA'), 'public.owner_set_feature_switch(''company_isolation_enforced'', true, ''اختبار العزل الكامل'')') = '42501', 'SW elevated');
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  PERFORM t.ok(t.call(t.u('OW'), 'public.owner_set_feature_switch(''company_isolation_enforced'', true, ''اختبار العزل الكامل'')') ->> 'enabled' = 'true', 'SW on');
  PERFORM t.ctx(null);

  -- طاقم المنصة: تذاكر مدعوم فقط (TA1S TOA TAS TPU) وما يتبعها
  PERFORM t.ok(t.vis('AD') = 't4,r1,a1,v4,g1,l1,o1', 'ISO AD ' || t.vis('AD'));
  PERFORM t.ok(t.vis('SUP') = 't4,r1,a1,v4,g1,l1,o1', 'ISO SUP ' || t.vis('SUP'));
  PERFORM t.ok(t.vis('EA') = 't4,r1,a1,v4,g1,l1,o1', 'ISO EA ' || t.vis('EA'));
  PERFORM t.ok(NOT t.sees('AD', 'TA1') AND NOT t.sees('SUP', 'TB1') AND t.sees('AD', 'TOA') AND t.sees('SUP', 'TA1S'), 'ISO staff tickets');
  -- مالك الشركة: تذاكر شركته (TA1 TA2) وتذكرته مع مدعوم، لا تذاكر عملائه مع مدعوم (TA1S) ولا موظفه (TAS)
  PERFORM t.ok(t.sees('OA', 'TA1') AND t.sees('OA', 'TA2') AND t.sees('OA', 'TOA')
           AND NOT t.sees('OA', 'TA1S') AND NOT t.sees('OA', 'TAS') AND NOT t.sees('OA', 'TB1'), 'ISO company owner');
  PERFORM t.ok(t.rows(t.u('OA'), format('storage.objects where name = %L', t.path('A1', 'TA1', 'public.png'))) = 1
           AND t.rows(t.u('OB'), format('storage.objects where name = %L', t.path('A1', 'TA1', 'public.png'))) = 0, 'ISO owner files');
  -- العميل: تذاكره كلها (النطاقان)
  PERFORM t.ok(t.sees('A1', 'TA1') AND t.sees('A1', 'TA1S') AND NOT t.sees('A1', 'TA2'), 'ISO customer own');
  PERFORM t.ok(t.vis('B1') = (SELECT split_part(split_part(v, 'B1=', 2), ';', 1) FROM t.saved WHERE k = 'vis1'), 'ISO B1 unchanged');
  PERFORM t.ok(t.vis('PU') = (SELECT split_part(split_part(v, 'PU=', 2), ';', 1) FROM t.saved WHERE k = 'vis1'), 'ISO PU unchanged');
  -- الطاقم لا يكتب في تذكرة شركة: لا تعديل ولا حذف ولا رد ولا ملف
  PERFORM t.ok(t.affected(t.u('AD'), format('update public.tickets set priority = ''high'' where id = %L', t.k('TA1'))) = 0, 'ISO admin update 0');
  PERFORM t.ok(t.affected(t.u('AD'), format('delete from public.tickets where id = %L', t.k('TA1'))) = 0, 'ISO admin delete 0');
  PERFORM t.ok(t.exec(t.u('SUP'), format('insert into public.ticket_replies (ticket_id, user_id, message) values (%L, %L, ''رد'')', t.k('TA1'), t.u('SUP'))) = '42501', 'ISO support reply');
  PERFORM t.ok(t.exec(t.u('AD'), format('insert into storage.objects (bucket_id, name, owner) values (''tickets'', %L, %L)',
                                         t.path('AD', 'TA1', 'x.png'), t.u('AD'))) = '42501', 'ISO admin upload');
  PERFORM t.ok(t.exec(t.u('AD'), format('insert into storage.objects (bucket_id, name, owner) values (''tickets'', %L, %L)',
                                         t.path('AD', 'TPU', 'y.png'), t.u('AD'))) = 'ok', 'ISO admin upload support ok');
  -- الإطفاء يعيد الحال فورًا
  PERFORM t.sw('company_isolation_enforced', false);
  PERFORM t.ok(t.sees('AD', 'TA1') AND t.sees('OA', 'TA1S'), 'ISO off again');
  PERFORM t.sw('company_isolation_enforced', true);
  RAISE NOTICE 'PASS ⑤ العزل: طاقم المنصة يرى تذاكر مدعوم فقط ولا يكتب في تذاكر الشركات ولا ملفاتها؛ الشركة ترى تذاكرها لا تذاكر عملائها مع مدعوم؛ العميل يرى تذاكره؛ والإطفاء يعيد الحال';
END $$;

-- ══ ⑥ القنوات الجانبية ═══════════════════════════════════════════════════
DO $$
DECLARE n0 int; tc uuid; ts uuid;
BEGIN
  INSERT INTO public.ticket_distribution_config (method, is_active, settings)
  VALUES ('round_robin', true, jsonb_build_object('agent_ids', jsonb_build_array(t.u('SUP'))));
  INSERT INTO public.webhooks (name, url, events, secret, is_active)
  VALUES ('اختبار', 'https://hooks.test/x', array['ticket_created'], 'secret', true);
  n0 := (SELECT count(*) FROM public.notifications WHERE user_id IN (t.u('AD'), t.u('EA')));
  -- تذكرة شركة جديدة: لا إشعار للطاقم، لا إسناد آلي لموظف منصة، لا webhook
  PERFORM t.exec(t.u('A2'), format('insert into public.tickets (user_id, title, description) values (%L, ''جانبية شركة'', ''وصف'')', t.u('A2')));
  tc := (SELECT id FROM public.tickets WHERE title = 'جانبية شركة');
  PERFORM t.ok(tc IS NOT NULL AND (SELECT scope FROM public.tickets WHERE id = tc) = 'company', 'SIDE company ticket created');
  PERFORM t.ok((SELECT count(*) FROM public.notifications WHERE user_id IN (t.u('AD'), t.u('EA'))) = n0, 'SIDE no staff notification');
  PERFORM t.ok((SELECT assigned_to FROM public.tickets WHERE id = tc) IS NULL, 'SIDE no round robin');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.webhook_deliveries WHERE payload ->> 'ticket_id' = tc::text), 'SIDE no webhook');
  -- تذكرة مدعوم: كل القنوات كما كانت (لا حجب زائد)
  PERFORM t.exec(t.u('PU'), format('insert into public.tickets (user_id, title, description) values (%L, ''جانبية مدعوم'', ''وصف'')', t.u('PU')));
  ts := (SELECT id FROM public.tickets WHERE title = 'جانبية مدعوم');
  PERFORM t.ok((SELECT count(*) FROM public.notifications WHERE user_id IN (t.u('AD'), t.u('EA'))) > n0, 'SIDE support notifies');
  PERFORM t.ok((SELECT assigned_to FROM public.tickets WHERE id = ts) = t.u('SUP'), 'SIDE support round robin');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.webhook_deliveries WHERE payload ->> 'ticket_id' = ts::text), 'SIDE support webhook');
  -- سير العمل وأداة MCP
  PERFORM t.ok(t.err_super_ok(format('select public.wf_assign_ticket(%L, %L, null)', tc, t.u('SUP'))) = '42501', 'SIDE wf assign company');
  PERFORM t.ok(t.err_super_ok(format('select public.wf_update_ticket_status(%L, ''resolved'', null)', tc)) = '42501', 'SIDE wf status company');
  PERFORM t.ok(t.err_super_ok(format('select public.wf_update_ticket_status(%L, ''in-progress'', null)', ts)) = 'ok', 'SIDE wf support ok');
  -- الدالة ممنوحة لمفتاح الخدمة وحده؛ نناديها بهوية الأدمن كما يمررها MCP
  PERFORM t.act(t.u('AD'));
  PERFORM t.ok(t.err_super_ok(format('select public.mcp_admin_update_ticket(%L, %L, ''{"priority":"high"}'')', tc, t.u('AD'))) = 'P0002', 'SIDE mcp company = not found');
  PERFORM t.ok(t.err_super_ok(format('select public.mcp_admin_update_ticket(%L, %L, ''{"priority":"high"}'')', ts, t.u('AD'))) = 'ok', 'SIDE mcp support ok');
  PERFORM t.act(null);
  PERFORM t.ok(public.mcp_ticket_tenancy(t.u('OA')) = jsonb_build_object('isolation_on', true, 'team_company_ids', jsonb_build_array(t.u('CA')))
           AND public.mcp_ticket_tenancy(t.u('AD')) -> 'team_company_ids' = '[]'::jsonb, 'SIDE mcp context');
  -- SLA: تذكرة الشركة المتأخرة لا تُبلَّغ للطاقم، وتذكرة مدعوم تُبلَّغ
  INSERT INTO public.advanced_settings (key, value) VALUES ('sla_config', '{"enabled": true, "medium_hours": 1, "low_hours": 1}')
  ON CONFLICT (key) DO UPDATE SET value = excluded.value;
  PERFORM public.check_sla_breaches();
  PERFORM t.ok(NOT (SELECT sla_alert_sent FROM public.tickets WHERE id = t.k('TA2'))
           AND (SELECT sla_alert_sent FROM public.tickets WHERE id = t.k('TPU')), 'SIDE sla');
  RAISE NOTICE 'PASS ⑥ القنوات الجانبية: تذكرة الشركة لا تُنتج إشعار طاقم ولا إسنادًا آليًا ولا webhook، وسير العمل وأداة MCP لا يكتبان فيها، وSLA يتخطاها؛ تذاكر مدعوم كما كانت';
END $$;

-- ══ ⑦ طلبات الوصول ══════════════════════════════════════════════════════
DO $$
DECLARE req uuid; req2 uuid; g uuid; r jsonb; n int;
BEGIN
  -- المفتاح مطفأ
  PERFORM t.ok(t.errfull(t.u('SUP'), format('public.request_data_access(%L::uuid, null, ''مراجعة شكوى عميل بخصوص الفاتورة'', 24)', t.u('CA'))) LIKE '0A000|%', 'REQ off');
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  PERFORM t.call(t.u('OW'), 'public.owner_set_feature_switch(''data_access_grants_enabled'', true, ''اختبار طلبات الوصول'')');
  PERFORM t.ctx(null);
  -- من يطلب
  PERFORM t.ok(t.err(t.u('OA'), format('public.request_data_access(%L::uuid, null, ''مالك شركة يطلب بيانات شركة أخرى'', 24)', t.u('CB'))) = '42501', 'REQ company owner no');
  PERFORM t.ok(t.err(t.u('OW'), format('public.request_data_access(%L::uuid, null, ''مالك المنصة لا يطلب من نفسه'', 24)', t.u('CA'))) = '42501', 'REQ platform owner no');
  PERFORM t.ok(t.err(t.u('PU'), format('public.request_data_access(%L::uuid, null, ''حساب عادي يطلب بيانات شركة'', 24)', t.u('CA'))) = '42501', 'REQ user no');
  PERFORM t.ok(t.err(t.u('SUP'), format('public.request_data_access(%L::uuid, null, ''قصير'', 24)', t.u('CA'))) = '22023', 'REQ reason');
  PERFORM t.ok(t.err(t.u('SUP'), format('public.request_data_access(%L::uuid, null, ''مراجعة شكوى عميل بخصوص الفاتورة'', 25)', t.u('CA'))) = '22023', 'REQ support max 24h');
  PERFORM t.ok(t.err(t.u('SUP'), format('public.request_data_access(%L::uuid, %L::uuid, ''مراجعة شكوى عميل بخصوص الفاتورة'', 24)', t.u('CA'), t.k('TB1'))) = 'P0002', 'REQ ticket of other company');
  PERFORM t.ok(t.err(t.u('SUP'), format('public.request_data_access(%L::uuid, %L::uuid, ''مراجعة شكوى عميل بخصوص الفاتورة'', 24)', t.u('CA'), t.k('TA1S'))) = 'P0002', 'REQ support-scope ticket is not company data');
  r := t.call(t.u('SUP'), format('public.request_data_access(%L::uuid, %L::uuid, ''مراجعة شكوى عميل بخصوص الفاتورة'', 24)', t.u('CA'), t.k('TA1')));
  req := (r ->> 'request_id')::uuid;
  PERFORM t.ok(r ->> 'status' = 'pending', 'REQ created');
  PERFORM t.ok(t.err(t.u('SUP'), format('public.request_data_access(%L::uuid, %L::uuid, ''مراجعة شكوى عميل بخصوص الفاتورة'', 24)', t.u('CA'), t.k('TA1'))) = '23505', 'REQ duplicate pending');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.notifications WHERE user_id = t.u('OW') AND title = 'طلب وصول إلى بيانات شركة'), 'REQ owner notified');
  -- لا قراءة قبل الموافقة
  PERFORM t.ok(NOT t.sees('SUP', 'TA1'), 'REQ pending no access');
  -- القرار: المالك وحده، بسياق وتحقق خطوتين
  PERFORM t.ok(t.err(t.u('EA'), format('public.owner_decide_access_request(%L::uuid, true)', req)) = '42501', 'DEC elevated no');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_decide_access_request(%L::uuid, true)', req)) = '42501', 'DEC owner no ctx');
  PERFORM t.ctx('owner');
  DELETE FROM public.privileged_step_ups WHERE user_id = t.u('OW');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_decide_access_request(%L::uuid, true)', req)) = '42501', 'DEC owner no stepup');
  PERFORM t.stepup(t.u('OW'));
  r := t.call(t.u('OW'), format('public.owner_decide_access_request(%L::uuid, true, ''موافق لمراجعة الشكوى'', 48)', req));
  g := (r ->> 'grant_id')::uuid;
  PERFORM t.ok(r ->> 'status' = 'approved' AND (r ->> 'hours')::int = 24, 'DEC approved, hours capped at requested');
  PERFORM t.ok((SELECT expires_at - starts_at FROM public.data_access_grants WHERE id = g) = interval '24 hours', 'DEC window 24h');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.privileged_audit WHERE action = 'data_access.approved' AND actor_id = t.u('OW')), 'DEC privileged audit');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_decide_access_request(%L::uuid, true)', req)) = 'P0002', 'DEC twice');
  -- لا موافقة ذاتية: طلب باسم المالك (مزروع مباشرة) يُرفض قراره
  INSERT INTO public.data_access_requests (id, requester_id, requester_kind, company_id, reason)
  VALUES ('da000000-0000-4000-8000-000000000001', t.u('OW'), 'admin', t.u('CB'), 'طلب مزروع باسم المالك نفسه');
  PERFORM t.ok(t.err(t.u('OW'), 'public.owner_decide_access_request(''da000000-0000-4000-8000-000000000001''::uuid, true)') = '42501', 'DEC no self');
  PERFORM t.ctx(null);
  -- القراءة عبر المنحة: RLS لم يتغير (لا قراءة مباشرة)، والدوال تسجّل كل نداء
  PERFORM t.ok(NOT t.sees('SUP', 'TA1'), 'GR rls unchanged');
  r := t.call(t.u('SUP'), format('public.granted_company_tickets(%L::uuid)', g));
  PERFORM t.ok(jsonb_array_length(r) = 1 AND r -> 0 ->> 'id' = t.k('TA1')::text, 'GR list only the granted ticket');
  r := t.call(t.u('SUP'), format('public.granted_ticket_view(%L::uuid, %L::uuid)', g, t.k('TA1')));
  PERFORM t.ok(r #>> '{ticket,title}' = 'طلبي لم يصل' AND jsonb_array_length(r -> 'replies') = 1
           AND jsonb_array_length(r -> 'attachments') = 1 AND NOT (r::text LIKE '%file_path%'), 'GR view without internal, no paths');
  PERFORM t.ok(t.err(t.u('SUP'), format('public.granted_ticket_view(%L::uuid, %L::uuid)', g, t.k('TA2'))) = 'P0002', 'GR outside ticket');
  PERFORM t.ok(t.err(t.u('AD'), format('public.granted_company_tickets(%L::uuid)', g)) = '42501', 'GR other staff');
  PERFORM t.ok((SELECT count(*) FROM public.company_access_audit WHERE grant_id = g AND action IN ('list_tickets', 'view_ticket')) = 2, 'GR audited per call');
  -- شفافية الشركة: أ ترى المنحة وعدد القراءات بلا سبب الطلب؛ ب لا ترى شيئًا
  r := t.call(t.u('OA'), 'public.company_access_log()');
  PERFORM t.ok(jsonb_array_length(r) = 1 AND (r -> 0 ->> 'reads')::int = 2 AND r -> 0 ->> 'requester_kind' = 'support'
           AND NOT (r::text LIKE '%الفاتورة%'), 'LOG company A');
  PERFORM t.ok(t.call(t.u('OB'), 'public.company_access_log()') = '[]'::jsonb AND t.call(t.u('AS'), 'public.company_access_log()') IS NULL, 'LOG others');
  -- الإلغاء من صاحب المنحة
  PERFORM t.ok(t.call(t.u('SUP'), format('public.revoke_data_access_grant(%L::uuid, ''انتهيت'')', g)) ->> 'revoked' = 'true', 'REV grantee');
  PERFORM t.ok(t.err(t.u('SUP'), format('public.granted_company_tickets(%L::uuid)', g)) = '42501', 'REV no access');
  -- الانتهاء: منحة ثانية لكل الشركة بمدة الأدمن (72) ثم تقصيرها (يُسمح) ثم انتهاؤها
  r := t.call(t.u('AD'), format('public.request_data_access(%L::uuid, null, ''تدقيق تذاكر الشركة بطلب قانوني'', 72)', t.u('CA')));
  req2 := (r ->> 'request_id')::uuid;
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  g := (t.call(t.u('OW'), format('public.owner_decide_access_request(%L::uuid, true)', req2)) ->> 'grant_id')::uuid;
  PERFORM t.ctx(null);
  PERFORM t.ok(jsonb_array_length(t.call(t.u('AD'), format('public.granted_company_tickets(%L::uuid)', g))) >= 2, 'EXP company-wide list');
  PERFORM t.ok(t.err_super_ok(format('update public.data_access_grants set expires_at = expires_at + interval ''1 hour'' where id = %L', g)) = '23514', 'EXP no extend');
  UPDATE public.data_access_grants SET expires_at = starts_at + interval '1 millisecond' WHERE id = g;
END $$;
DO $$
DECLARE g uuid := (SELECT id FROM public.data_access_grants WHERE grantee_id = t.u('AD'));
BEGIN
  PERFORM t.ok(t.err(t.u('AD'), format('public.granted_company_tickets(%L::uuid)', g)) = '42501', 'EXP expired');
  -- القواعد: المالك يوقف طلبات الدعم، فيُرفض الطلب الجديد
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  PERFORM t.ok(t.err(t.u('EA'), 'public.owner_set_access_requester_rule(''support'', false, 24, ''إيقاف مؤقت للطلبات'')') = '42501', 'RULE elevated no');
  PERFORM t.call(t.u('OW'), 'public.owner_set_access_requester_rule(''support'', false, 24, ''إيقاف مؤقت للطلبات'')');
  PERFORM t.ctx(null);
  PERFORM t.ok(t.err(t.u('SUP'), format('public.request_data_access(%L::uuid, null, ''مراجعة شكوى عميل بخصوص الفاتورة'', 24)', t.u('CB'))) = '42501', 'RULE support off');
  -- السجل إلحاقي، والجداول مغلقة
  PERFORM t.ok(t.err_super_ok('update public.company_access_audit set action = ''requested''') = '23514', 'AUD no update');
  PERFORM t.ok(t.err_super_ok('delete from public.company_access_audit') = '23514', 'AUD no delete');
  PERFORM t.ok(t.err_super_ok('truncate public.company_access_audit') = '23514', 'AUD no truncate');
  PERFORM t.ok(t.err_super_ok('delete from public.data_access_grants') = '23514', 'AUD grants kept');
  PERFORM t.ok(t.exec(t.u('OA'), 'select * from public.company_access_audit') = '42501', 'AUD no direct read');
  -- لوحة المالك
  PERFORM t.ctx('owner');
  PERFORM t.ok(jsonb_array_length(t.call(t.u('OW'), 'public.owner_access_requests()') -> 'requests') = 3, 'OWN listing');
  PERFORM t.ctx(null);
  PERFORM t.ok(t.err(t.u('EA'), 'public.owner_access_requests()') = '42501', 'OWN listing owner only');
  RAISE NOTICE 'PASS ⑦ طلبات الوصول: الطاقم المسموح له فقط وبحد مدته، المالك وحده يقرر بسياق وتحقق خطوتين ولا موافقة ذاتية، القراءة عبر دوال تسجّل كل نداء وتستثني الداخلي، الشركة ترى السجل، الإلغاء والانتهاء فوريان، ولا تمديد، والسجل إلحاقي';
END $$;

-- ══ ⑧ رفض التراجع ═══════════════════════════════════════════════════════
\set rbsql `cat migrations/_rollback/097_ticket_scope_isolation.down.sql`
SELECT set_config('t.rbsql', :'rbsql', false) IS NOT NULL;
DO $$
BEGIN
  BEGIN
    EXECUTE current_setting('t.rbsql');
    RAISE EXCEPTION 'FAIL RB allowed with switches on and audit';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%مرفوض%' THEN RAISE; END IF;
  END;
  UPDATE public.platform_feature_switches SET enabled = false;
  BEGIN
    EXECUTE current_setting('t.rbsql');
    RAISE EXCEPTION 'FAIL RB allowed with audit';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%سجل إلحاقي%' THEN RAISE; END IF;
  END;
  PERFORM t.ok(to_regclass('public.company_access_audit') IS NOT NULL, 'RB kept');
  RAISE NOTICE 'PASS ⑧ التراجع مرفوض مع مفتاح مفعّل أو سجل وصول (السجل لا يُحذف بتراجع)';
END $$;

SELECT 'ALL ticket-isolation tests passed';
