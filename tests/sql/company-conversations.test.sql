-- ============================================================================
-- 102_company_conversations على نسخة مطابقة للإنتاج حتى 093 + 095 … 101
--
--   ① الكائنات: المفتاح مطفأ، الكتالوج، لا منح مباشرة ولا سياسة مسموحة ولا Realtime، لا قراءة مباشرة لأحد
--   ①ب التراجع حرفيًا ثم إعادة التطبيق
--   ② المفتاح مطفأ: القوائم null والإجراءات 0A000
--   ③ العميل يبدأ ويكتب؛ مدير شركته يرى؛ لا أحد غيره (الشركة الأخرى، طاقم المنصة، المالك، الموظف بلا 098)
--   ④ فريق الشركة بصلاحيات 098: المشرف كل المحادثات، الموظف المسندة، الإسناد، الملاحظات الداخلية لا تصل
--      العميل، هوية الفريق مخفية عن العميل، غير المقروء، الإغلاق وإعادة الفتح
--   ⑤ السياق: شركتان للعميل، المغادرة (قراءة بلا كتابة)، الإيقاف، مع العزل مفعّلًا
--   ⑥ الثوابت (لا تعديل، لا حذف مباشر، الشركة ثابتة، حذف الحساب)، والحدود، و⑦ رفض التراجع
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
\i migrations/099_admin_hierarchy.sql
\i migrations/100_company_documents.sql
\i migrations/101_customer_transfers_carry.sql
SET search_path = public, extensions;

CREATE FUNCTION t.join_b(p text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM t.call(t.u('OB'), format('public.company_invite_customer(%L)', lower(p) || '@tenancy.test'));
  PERFORM t.call(t.u(p), format('public.company_invitation_respond(%L::uuid, true)',
                 (SELECT id FROM public.company_membership_invitations WHERE invited_email = lower(p) || '@tenancy.test' AND status = 'pending')));
END $$;
-- معرّفات المحادثات بالاسم
CREATE TABLE t.conv (k text PRIMARY KEY, id uuid);
CREATE FUNCTION t.cv(p text) RETURNS uuid LANGUAGE sql AS $$ select id from t.conv where k = p $$;
CREATE FUNCTION t.start(p_user text, p_key text, p_subject text, p_body text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
  v := (t.call(t.u(p_user), format('public.company_conversation_start(%L, %L, gen_random_uuid())', p_subject, p_body)) ->> 'conversation_id')::uuid;
  INSERT INTO t.conv VALUES (p_key, v);
  RETURN v;
END $$;
CREATE FUNCTION t.thread(p_user text, p_conv text) RETURNS jsonb LANGUAGE sql AS $$
  select t.call(t.u(p_user), format('public.company_conversation_thread(%L::uuid)', t.cv(p_conv))) $$;
CREATE FUNCTION t.post(p_user text, p_conv text, p_body text, p_internal boolean default false) RETURNS text LANGUAGE sql AS $$
  select t.err(t.u(p_user), format('public.company_conversation_post(%L::uuid, %L, %L)', t.cv(p_conv), p_body, p_internal)) $$;
CREATE FUNCTION t.ids(p_list jsonb) RETURNS text LANGUAGE sql AS $$
  select coalesce(string_agg(k.k, ',' order by k.k), '')
    from jsonb_array_elements(coalesce(p_list -> 'conversations', '[]'::jsonb)) e join t.conv k on k.id = (e ->> 'id')::uuid $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;
GRANT SELECT, INSERT ON t.conv TO authenticated;

INSERT INTO t.saved VALUES ('schema0', t.schema_digest());

-- ══ ① 102 ════════════════════════════════════════════════════════════════
\i migrations/102_company_conversations.sql
SET search_path = public, extensions;
DO $$
DECLARE who text;
BEGIN
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.platform_feature_switches WHERE enabled), 'OBJ switches off');
  PERFORM t.ok((SELECT count(*) FROM public.company_permission_catalog WHERE key LIKE 'conversations.%') = 6, 'OBJ catalog keys');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public'
                            AND table_name LIKE 'company_conversation%' AND grantee IN ('anon', 'authenticated', 'service_role')), 'OBJ no grants');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename LIKE 'company_conversation%' AND permissive = 'PERMISSIVE'), 'OBJ no permissive policy');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE tablename LIKE 'company_conversation%'), 'OBJ not in realtime');
  FOREACH who IN ARRAY array['OW', 'EA', 'AD', 'SUP', 'OA', 'AS', 'A1'] LOOP
    PERFORM t.ok(t.exec(t.u(who), 'select * from public.company_conversations') = '42501'
             AND t.exec(t.u(who), 'select * from public.company_conversation_messages') = '42501', 'OBJ no direct read ' || who);
  END LOOP;
  PERFORM t.ok(t.err(t.u('A1'), 'public._inbox_staff_access(gen_random_uuid(), null, ''view'')') = '42501', 'OBJ internals closed');
  RAISE NOTICE 'PASS ① 102: المفتاح مطفأ، الكتالوج، لا منح ولا سياسة مسموحة ولا Realtime، ولا قراءة مباشرة لأي دور';
END $$;

-- ══ ①ب التراجع ثم إعادة التطبيق ═══════════════════════════════════════════
\i migrations/_rollback/102_company_conversations.down.sql
SET search_path = public, extensions;
DO $$ BEGIN
  PERFORM t.ok(t.schema_digest() = (SELECT s.v FROM t.saved s WHERE s.k = 'schema0'), 'RB schema byte-for-byte');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.company_permission_catalog WHERE key LIKE 'conversations.%'), 'RB catalog restored');
  RAISE NOTICE 'PASS ①ب التراجع: حرفيًا كما قبل 102، والكتالوج كما بعد 098';
END $$;
\i migrations/102_company_conversations.sql
\i migrations/102_company_conversations.sql
SET search_path = public, extensions;

-- ══ ② المفتاح مطفأ ═════════════════════════════════════════════════════════
DO $$ BEGIN
  PERFORM t.ok(t.call(t.u('A1'), 'public.my_company_conversations()') IS NULL, 'OFF customer list null');
  PERFORM t.ok(t.call(t.u('OA'), 'public.company_inbox_summary()') IS NULL AND t.call(t.u('OA'), 'public.company_inbox_list()') IS NULL, 'OFF inbox null');
  PERFORM t.ok(t.err(t.u('A1'), 'public.company_conversation_start(''سؤال عن طلبي'', ''مرحبًا'', gen_random_uuid())') = '0A000', 'OFF start');
  PERFORM t.ok(t.err(t.u('OA'), 'public.company_conversation_thread(gen_random_uuid())') = '0A000', 'OFF thread');
  RAISE NOTICE 'PASS ② المفتاح مطفأ: القوائم null والإجراءات 0A000';
END $$;

-- ══ ③ العميل ومدير شركته فقط ════════════════════════════════════════════════
DO $$
DECLARE r jsonb; k uuid := gen_random_uuid(); who text;
BEGIN
  PERFORM t.sw('company_inbox_enabled', true);
  PERFORM t.ok(t.err(t.u('A1'), 'public.company_conversation_start(''س'', ''مرحبًا'', gen_random_uuid())') = '22023', 'START subject');
  PERFORM t.ok(t.err(t.u('A1'), 'public.company_conversation_start(''سؤال'', ''مرحبًا'', null)') = '22023', 'START key required');
  r := t.call(t.u('A1'), format('public.company_conversation_start(''طلبي لم يصل بعد'', ''رقم الطلب 1234'', %L::uuid)', k));
  INSERT INTO t.conv VALUES ('C1', (r ->> 'conversation_id')::uuid);
  PERFORM t.ok(t.call(t.u('A1'), format('public.company_conversation_start(''طلبي لم يصل بعد'', ''رقم الطلب 1234'', %L::uuid)', k)) ->> 'replayed' = 'true'
           AND (SELECT count(*) FROM public.company_conversations WHERE customer_id = t.u('A1')) = 1, 'START idempotent');
  PERFORM t.ok((SELECT company_id FROM public.company_conversations WHERE id = t.cv('C1')) = t.u('CA'), 'START stamped with server context');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.notifications WHERE user_id = t.u('OA') AND link = '/company-dashboard/#inbox'
                        AND message NOT LIKE '%1234%'), 'START company notified without content');
  -- غير عملاء الشركة
  PERFORM t.ok(t.err(t.u('PU'), 'public.company_conversation_start(''سؤال عام'', ''مرحبًا'', gen_random_uuid())') = '42501', 'START not a customer');
  PERFORM t.ok(t.err(t.u('AS'), 'public.company_conversation_start(''سؤال عام'', ''مرحبًا'', gen_random_uuid())') = '42501', 'START staff is not a customer');
  PERFORM t.ok(t.err(t.u('AX'), 'public.company_conversation_start(''سؤال عام'', ''مرحبًا'', gen_random_uuid())') = '42501', 'START banned');
  -- العميل يرى محادثته ورسالته
  r := t.call(t.u('A1'), 'public.my_company_conversations()');
  PERFORM t.ok((r ->> 'can_write')::boolean AND t.ids(r) = 'C1', 'CUST list');
  r := t.thread('A1', 'C1');
  PERFORM t.ok(r ->> 'viewer' = 'customer' AND jsonb_array_length(r -> 'messages') = 1 AND (r ->> 'can_reply')::boolean
           AND NOT (r ->> 'can_internal')::boolean AND NOT (r ->> 'can_assign')::boolean, 'CUST thread');
  -- مدير الشركة: كل المحادثات
  r := t.call(t.u('OA'), 'public.company_inbox_summary()');
  PERFORM t.ok(r ->> 'scope' = 'all' AND (r ->> 'open')::int = 1 AND (r ->> 'unread')::int = 1, 'ADMIN summary');
  r := t.call(t.u('OA'), 'public.company_inbox_list()');
  PERFORM t.ok(t.ids(r) = 'C1' AND r -> 'conversations' -> 0 ->> 'customer_name' = 'عميل أ1'
           AND NOT (r -> 'conversations' -> 0 ? 'customer_email'), 'ADMIN list name only');
  r := t.thread('OA', 'C1');
  PERFORM t.ok(r ->> 'viewer' = 'staff' AND (r ->> 'can_reply')::boolean AND (r ->> 'can_internal')::boolean
           AND (r ->> 'can_assign')::boolean AND (r ->> 'can_close')::boolean, 'ADMIN thread');
  PERFORM t.ok((t.call(t.u('OA'), 'public.company_inbox_summary()') ->> 'unread')::int = 0, 'ADMIN read clears unread');
  -- لا أحد غيرهما: الشركة الأخرى وعميلها، وطاقم المنصة والمالك، وموظفو الشركة قبل تفعيل 098
  FOREACH who IN ARRAY array['OB', 'BS', 'B1', 'A2', 'OW', 'EA', 'AD', 'SUP', 'PU', 'AS', 'AG'] LOOP
    PERFORM t.ok(t.err(t.u(who), format('public.company_conversation_thread(%L::uuid)', t.cv('C1'))) = 'P0002'
             AND t.post(who, 'C1', 'تدخّل') = 'P0002'
             AND t.err(t.u(who), format('public.company_conversation_assign(%L::uuid, null)', t.cv('C1'))) = 'P0002'
             AND t.err(t.u(who), format('public.company_conversation_set_status(%L::uuid, ''closed'')', t.cv('C1'))) = 'P0002',
             'ISO no access ' || who);
    PERFORM t.ok(coalesce(t.ids(t.call(t.u(who), 'public.company_inbox_list(''all'')')), '') = '', 'ISO not listed ' || who);
  END LOOP;
  PERFORM t.ctx('owner'); PERFORM t.stepup(t.u('OW'));
  PERFORM t.ok(t.err(t.u('OW'), format('public.company_conversation_thread(%L::uuid)', t.cv('C1'))) = 'P0002', 'ISO owner context + step-up still nothing');
  PERFORM t.ctx(null);
  PERFORM t.ok(t.call(t.u('OB'), 'public.company_inbox_summary()') ->> 'open' = '0', 'ISO other company sees its own empty inbox');
  PERFORM t.ok(t.call(t.u('AS'), 'public.company_inbox_summary()') IS NULL, 'ISO staff without 098: no inbox');
  RAISE NOTICE 'PASS ③ العميل يبدأ بختم شركته من الخادم ويكتب؛ مديرها يرى ويرد؛ لا أحد غيرهما — لا الشركة الأخرى ولا طاقم المنصة ولا المالك بسياقه وتحققه، ولا الموظف قبل 098';
END $$;

-- ══ ④ فريق الشركة بصلاحيات 098 ═════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.sw('company_permissions_enabled', true);
  -- المشرف: كل المحادثات؛ الموظف: المسندة فقط
  PERFORM t.ok(t.call(t.u('AS'), 'public.company_inbox_summary()') ->> 'scope' = 'all' AND t.thread('AS', 'C1') ->> 'viewer' = 'staff', 'TEAM supervisor all');
  PERFORM t.ok(t.call(t.u('AG'), 'public.company_inbox_summary()') ->> 'scope' = 'assigned'
           AND t.ids(t.call(t.u('AG'), 'public.company_inbox_list(''all'')')) = ''
           AND t.err(t.u('AG'), format('public.company_conversation_thread(%L::uuid)', t.cv('C1'))) = 'P0002', 'TEAM agent nothing unassigned');
  PERFORM t.ok(t.call(t.u('BS'), 'public.company_inbox_summary()') ->> 'open' = '0'
           AND t.err(t.u('BS'), format('public.company_conversation_thread(%L::uuid)', t.cv('C1'))) = 'P0002', 'TEAM other company supervisor');
  -- الإسناد: أعضاء الفريق النشطون وحدهم
  PERFORM t.ok(t.err(t.u('OA'), format('public.company_conversation_assign(%L::uuid, %L::uuid)', t.cv('C1'), t.u('A2'))) = '22023', 'ASSIGN not to a customer');
  PERFORM t.ok(t.err(t.u('OA'), format('public.company_conversation_assign(%L::uuid, %L::uuid)', t.cv('C1'), t.u('BS'))) = '22023', 'ASSIGN not to other company');
  PERFORM t.ok(t.call(t.u('AS'), format('public.company_conversation_assign(%L::uuid, %L::uuid)', t.cv('C1'), t.u('AG'))) ->> 'changed' = 'true', 'ASSIGN supervisor');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.notifications WHERE user_id = t.u('AG') AND title = 'أُسندت إليك محادثة'), 'ASSIGN notified');
  PERFORM t.ok(t.ids(t.call(t.u('AG'), 'public.company_inbox_list(''mine'')')) = 'C1' AND t.thread('AG', 'C1') ->> 'viewer' = 'staff', 'TEAM agent sees assigned');
  PERFORM t.ok(t.err(t.u('AG'), format('public.company_conversation_assign(%L::uuid, null)', t.cv('C1'))) = '42501', 'ASSIGN agent cannot');
  -- رد الفريق: يصل العميل بلا هوية الموظف؛ الملاحظة الداخلية لا تصل أبدًا
  PERFORM t.ok(t.post('AG', 'C1', 'وصلنا طلبك وسنتابعه اليوم') = 'ok', 'REPLY agent');
  PERFORM t.ok(t.post('AG', 'C1', 'العميل اشتكى سابقًا — تحقق من الشحن', true) = 'ok', 'NOTE agent');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.notifications WHERE user_id = t.u('A1') AND link = '/portal/#messages'
                        AND message NOT LIKE '%وصلنا%'), 'REPLY customer notified without content');
  r := t.thread('A1', 'C1');
  PERFORM t.ok(jsonb_array_length(r -> 'messages') = 2 AND NOT (r::text LIKE '%الشحن%')
           AND r -> 'messages' -> 1 -> 'sender_name' = 'null'::jsonb AND NOT (r::text LIKE '%موظف أ%')
           AND r -> 'assigned_to' = 'null'::jsonb AND NOT (r::text LIKE '%' || t.u('AG') || '%'), 'CUST no internal, no staff identity');
  PERFORM t.ok(NOT (t.call(t.u('A1'), 'public.my_company_conversations()')::text LIKE '%' || t.u('AG') || '%'), 'CUST list hides assignee');
  PERFORM t.ok(r ->> 'unread' = 'false', 'CUST read clears unread');
  r := t.thread('AS', 'C1');
  PERFORM t.ok(jsonb_array_length(r -> 'messages') = 3 AND r::text LIKE '%الشحن%' AND r::text LIKE '%موظف أ%', 'TEAM sees note and author');
  PERFORM t.ok(t.post('A1', 'C1', 'ملاحظة مني', true) = '42501', 'CUST cannot write internal');
  -- إلغاء صلاحية الملاحظات الداخلية للموظف: لا يراها ولا يكتبها
  PERFORM t.call(t.u('OA'), format('public.company_set_user_permission(%L::uuid, ''conversations.internal_notes'', false)', t.u('AG')));
  r := t.thread('AG', 'C1');
  PERFORM t.ok(jsonb_array_length(r -> 'messages') = 2 AND NOT (r ->> 'can_internal')::boolean AND t.post('AG', 'C1', 'ملاحظة', true) = '42501', 'PERM internal revoked');
  -- الإغلاق: الموظف يغلق؛ الرد على مغلقة مرفوض للفريق؛ رد العميل يعيد الفتح
  PERFORM t.ok(t.call(t.u('AG'), format('public.company_conversation_set_status(%L::uuid, ''closed'')', t.cv('C1'))) ->> 'status' = 'closed', 'CLOSE agent');
  PERFORM t.ok(t.post('AG', 'C1', 'رد بعد الإغلاق') = '55000', 'CLOSE no staff reply');
  PERFORM t.ok(t.post('A1', 'C1', 'ما زلت أنتظر') = 'ok', 'CLOSE customer may reply');
  PERFORM t.ok((SELECT status FROM public.company_conversations WHERE id = t.cv('C1')) = 'open'
           AND EXISTS (SELECT 1 FROM public.company_conversation_events WHERE conversation_id = t.cv('C1') AND action = 'reopened'), 'CLOSE customer reply reopens');
  PERFORM t.ok((t.call(t.u('AG'), 'public.company_inbox_summary()') ->> 'unread')::int = 1, 'UNREAD for assignee');
  -- سحب صلاحية العرض المسند: لا شيء
  PERFORM t.call(t.u('OA'), format('public.company_set_user_permission(%L::uuid, ''conversations.view_assigned'', false)', t.u('AG')));
  PERFORM t.ok(t.call(t.u('AG'), 'public.company_inbox_summary()') IS NULL
           AND t.err(t.u('AG'), format('public.company_conversation_thread(%L::uuid)', t.cv('C1'))) = 'P0002', 'PERM view revoked');
  PERFORM t.call(t.u('OA'), format('public.company_set_user_permission(%L::uuid, ''conversations.view_assigned'', null)', t.u('AG')));
  PERFORM t.call(t.u('OA'), format('public.company_set_user_permission(%L::uuid, ''conversations.internal_notes'', null)', t.u('AG')));
  RAISE NOTICE 'PASS ④ الفريق بصلاحيات 098: المشرف الكل والموظف المسند، الإسناد لأعضاء الفريق، الملاحظات الداخلية وهوية الموظف لا تصل العميل، الصلاحيات تُسحب فورًا، والإغلاق وإعادة الفتح';
END $$;

-- ══ ⑤ السياق والمغادرة والإيقاف والعزل ══════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.sw('multi_company_memberships_enabled', true);
  PERFORM t.join_b('A1');
  PERFORM t.call(t.u('A1'), format('public.enter_customer_company(%L::uuid)', t.u('CB')));
  r := t.call(t.u('A1'), 'public.my_company_conversations()');
  PERFORM t.ok(t.ids(r) = '' AND (r ->> 'can_write')::boolean, 'CTX list follows current company');
  PERFORM t.start('A1', 'C2', 'سؤال لشركة ب', 'مرحبًا يا شركة ب');
  PERFORM t.ok((SELECT company_id FROM public.company_conversations WHERE id = t.cv('C2')) = t.u('CB'), 'CTX new conversation in B');
  PERFORM t.ok(t.ids(t.call(t.u('OB'), 'public.company_inbox_list()')) = 'C2' AND t.ids(t.call(t.u('OA'), 'public.company_inbox_list(''all'')')) = 'C1', 'CTX each company its own');
  -- محادثة أ ما زالت قابلة للكتابة (عميل نشط فيها) وإن كان السياق ب
  PERFORM t.ok(t.post('A1', 'C1', 'متابعة من سياق آخر') = 'ok', 'CTX write to active membership');
  PERFORM t.call(t.u('A1'), 'public.enter_customer_company(null)');
  -- المغادرة: قراءة بلا كتابة
  PERFORM t.start('A2', 'C3', 'استفسار قبل المغادرة', 'مرحبًا');
  PERFORM t.call(t.u('A2'), format('public.leave_company(%L::uuid)', t.u('CA')));
  r := t.thread('A2', 'C3');
  PERFORM t.ok(r ->> 'viewer' = 'customer' AND NOT (r ->> 'can_reply')::boolean AND t.post('A2', 'C3', 'هل من جديد؟') = '42501', 'LEFT read-only');
  PERFORM t.ok(t.thread('OA', 'C3') ->> 'viewer' = 'staff', 'LEFT company keeps record');
  -- العزل مفعّلًا لا يغيّر شيئًا هنا (المسار خاص من البداية)
  PERFORM t.sw('company_isolation_enforced', true);
  PERFORM t.ok(t.ids(t.call(t.u('OA'), 'public.company_inbox_list(''all'')')) = 'C1,C3'
           AND t.err(t.u('OB'), format('public.company_conversation_thread(%L::uuid)', t.cv('C1'))) = 'P0002', 'ISO with isolation on');
  PERFORM t.sw('company_isolation_enforced', false);
  -- الإيقاف المنفَّذ يوقف الصندوق للشركة وعملائها
  PERFORM set_config('app.company_status_write', 'on', true);
  UPDATE public.companies SET status = 'suspended' WHERE id = t.u('CA');
  PERFORM set_config('app.company_status_write', 'off', true);
  PERFORM t.ok(t.call(t.u('OA'), 'public.company_inbox_summary()') IS NOT NULL, 'SUSP not enforced: unchanged');
  PERFORM t.sw('company_suspension_enforced', true);
  PERFORM t.ok(t.call(t.u('OA'), 'public.company_inbox_summary()') IS NULL AND t.post('A1', 'C1', 'هل أنتم هنا؟') = '42501', 'SUSP enforced: inbox closed');
  PERFORM t.sw('company_suspension_enforced', false);
  PERFORM set_config('app.company_status_write', 'on', true);
  UPDATE public.companies SET status = 'active' WHERE id = t.u('CA');
  PERFORM set_config('app.company_status_write', 'off', true);
  RAISE NOTICE 'PASS ⑤ السياق: كل محادثة لشركتها، العميل يكتب حيث هو عميل نشط، المغادرة قراءة بلا كتابة والشركة تحتفظ بالسجل، العزل لا يغيّر شيئًا، والإيقاف المنفَّذ يغلق الصندوق';
END $$;

-- ══ ⑥ الثوابت والحدود ═════════════════════════════════════════════════════
DO $$
DECLARE i int;
BEGIN
  PERFORM t.ok(t.err_super_ok(format('update public.company_conversation_messages set body = ''مزوّر'' where conversation_id = %L', t.cv('C1'))) = '23514', 'INV no edit');
  PERFORM t.ok(t.err_super_ok(format('delete from public.company_conversation_messages where conversation_id = %L', t.cv('C1'))) = '23514', 'INV no direct delete');
  PERFORM t.ok(t.err_super_ok('delete from public.company_conversation_events') = '23514', 'INV events append-only');
  PERFORM t.ok(t.err_super_ok(format('update public.company_conversations set company_id = %L where id = %L', t.u('CB'), t.cv('C1'))) = '23514', 'INV company fixed');
  -- الحد: 5 محادثات جديدة في الساعة
  FOR i IN 1..3 LOOP PERFORM t.start('A1', 'R' || i, 'سؤال رقم ' || i, 'نص'); END LOOP;
  PERFORM t.ok(t.err(t.u('A1'), 'public.company_conversation_start(''سؤال سادس'', ''نص'', gen_random_uuid())') = '54000', 'LIMIT conversations per hour');
  -- حذف حساب العميل: محادثاته ورسائلها تُحذف تبعًا، والسجل يبقى
  PERFORM t.ok(t.err_super_ok(format('delete from auth.users where id = %L', t.u('A2'))) = 'ok', 'INV account deletion cascades');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.company_conversations WHERE id = t.cv('C3'))
           AND EXISTS (SELECT 1 FROM public.company_conversation_events WHERE conversation_id = t.cv('C3')), 'INV events survive');
  -- حذف حساب موظف أرسل رسائل: الرسائل تبقى بلا مرسل، ونصها كما هو
  PERFORM t.ok(t.err_super_ok(format('delete from auth.users where id = %L', t.u('AG'))) = 'ok', 'INV staff deletion not blocked');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.company_conversation_messages WHERE conversation_id = t.cv('C1') AND sender_kind = 'staff'
                        AND sender_id IS NULL AND body = 'وصلنا طلبك وسنتابعه اليوم'), 'INV staff message kept, sender cleared');
  PERFORM t.ok(t.err_super_ok(format('update public.company_conversation_messages set sender_id = null where conversation_id = %L', t.cv('C1'))) = '23514', 'INV direct sender change blocked');
  RAISE NOTICE 'PASS ⑥ الثوابت: لا تعديل ولا حذف مباشر للرسائل، السجل إلحاقي، الشركة ثابتة، حد المحادثات، وحذف حساب العميل يحذف محادثاته ويبقي السجل، وحذف حساب الموظف يبقي رسائله بلا مرسل';
END $$;

-- ══ ⑦ رفض التراجع ══════════════════════════════════════════════════════════
\set rbsql `cat migrations/_rollback/102_company_conversations.down.sql`
SELECT set_config('t.rbsql', :'rbsql', false) IS NOT NULL;
DO $$
BEGIN
  UPDATE public.platform_feature_switches SET enabled = false;
  BEGIN
    EXECUTE current_setting('t.rbsql');
    RAISE EXCEPTION 'FAIL RB allowed with data';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%مرفوض%' THEN RAISE; END IF;
  END;
  PERFORM t.ok(to_regclass('public.company_conversations') IS NOT NULL, 'RB nothing dropped');
  RAISE NOTICE 'PASS ⑦ التراجع مرفوض مع وجود محادثات';
END $$;

SELECT 'ALL company-conversations tests passed';
