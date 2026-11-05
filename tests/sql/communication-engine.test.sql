-- ============================================================================
-- 123_communication_engine على نسخة مطابقة للإنتاج (ecommerce/chain: حتى 116 + مفاتيح الإنتاج) + 117…120
--
--   ① الكائنات: المفاتيح مطفأة، لا منح ولا سياسة مسموحة ولا Realtime، لا قراءة مباشرة، الداخليات مغلقة
--   ①ب التراجع حرفيًا ثم إعادة التطبيق
--   ② المفاتيح مطفأة: الإجراءات 0A000، والنظرة العامة فارغة لنطاقات comm_*
--   ③ customer_company عبر المحرّك (سيناريو 1 و2): رسالة عميل A تصل فريق A وحده؛ عميل A لا يصل لمحادثة B
--   ④ company_platform (سيناريو 3 و4): الشركة ترسل وتظهر للإدارة؛ الشركة الأخرى لا ترى؛ الموظفون والعملاء لا يبدؤون
--   ⑤ admin_owner (سيناريو 5 و6): الطاقم يرسل ويصل المالك في سياقه؛ زميله لا يرى؛ الشركات والأدمن المرتفع لا يصلون
--   ⑥ المرفقات (سيناريو 7): حجز، رفع بالسياسة، ربط، قراءة بحدود الرسالة؛ الداخلي داخلي؛ الإشعارات بلا محتوى
--   ⑦ التحويل إلى تذكرة، الإسناد، الإغلاق، البحث، الثوابت، والحدود
--   ⑧ عدم الانحدار (سيناريو 8): دوال 102 كما هي حرفيًا، وتعمل مباشرة كما قبل
--   ⑨ رفض التراجع مع وجود بيانات
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

\i tests/fixtures/ecommerce/chain.sql
\i migrations/117_owner_admin_parity.sql
\i migrations/118_ecommerce_store_accounts.sql
\i migrations/119_shopify_store_integration.sql
\i migrations/120_shopify_store_management.sql
SET search_path = public, extensions;

CREATE TABLE t.th (k text PRIMARY KEY, scope text, id uuid);
CREATE FUNCTION t.th(p text) RETURNS uuid LANGUAGE sql AS $$ select id from t.th where k = p $$;
CREATE FUNCTION t.start(p_user text, p_key text, p_scope text, p_cat text, p_subject text, p_body text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
  v := (t.call(t.u(p_user), format('public.comm_thread_start(%L, %L, %L, %L, gen_random_uuid())', p_scope, p_cat, p_subject, p_body))
        ->> 'thread_id')::uuid;
  INSERT INTO t.th VALUES (p_key, p_scope, v);
  RETURN v;
END $$;
CREATE FUNCTION t.thread(p_user text, p_key text) RETURNS jsonb LANGUAGE sql AS $$
  select t.call(t.u(p_user), format('public.comm_thread(%L, %L::uuid)', (select scope from t.th where k = p_key), t.th(p_key))) $$;
CREATE FUNCTION t.thread_err(p_user text, p_key text) RETURNS text LANGUAGE sql AS $$
  select t.err(t.u(p_user), format('public.comm_thread(%L, %L::uuid)', (select scope from t.th where k = p_key), t.th(p_key))) $$;
CREATE FUNCTION t.post(p_user text, p_key text, p_body text, p_internal boolean default false) RETURNS text LANGUAGE sql AS $$
  select t.err(t.u(p_user), format('public.comm_post(%L, %L::uuid, %L, %L)', (select scope from t.th where k = p_key), t.th(p_key), p_body, p_internal)) $$;
CREATE FUNCTION t.list(p_user text, p_scope text, p_filter text default 'all', p_q text default null) RETURNS text LANGUAGE sql AS $$
  select coalesce((select string_agg(k.k, ',' order by k.k)
                     from jsonb_array_elements(coalesce(t.call(t.u(p_user), format('public.comm_threads_list(%L, %L, %L)', p_scope, p_filter, p_q)) -> 'threads', '[]'::jsonb)) e
                     join t.th k on k.id = (e ->> 'id')::uuid), '') $$;
CREATE FUNCTION t.side(p_user text, p_scope text) RETURNS text LANGUAGE sql AS $$
  select t.call(t.u(p_user), 'public.comm_overview()') -> 'scopes' -> p_scope ->> 'side' $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;
GRANT SELECT, INSERT ON t.th TO authenticated;

INSERT INTO t.saved VALUES ('schema0', t.schema_digest());
INSERT INTO t.saved SELECT 'fn102', md5(string_agg(pg_get_functiondef(p.oid), '#' order by p.oid::regprocedure::text))
  FROM pg_proc p WHERE p.proname LIKE 'company_conversation%' OR p.proname LIKE '_inbox_%' OR p.proname LIKE 'company_inbox_%'
                    OR p.proname = 'my_company_conversations';

-- ══ ① 123 ════════════════════════════════════════════════════════════════
\i migrations/123_communication_engine.sql
SET search_path = public, extensions;
DO $$
DECLARE who text;
BEGIN
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.platform_feature_switches WHERE key LIKE 'comm\_%' AND enabled), 'OBJ comm switches off');
  PERFORM t.ok((SELECT count(*) FROM public.platform_feature_switches WHERE key LIKE 'comm\_%') = 3, 'OBJ three switches');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public'
                            AND table_name LIKE 'comm\_%' AND grantee IN ('anon', 'authenticated', 'service_role', 'PUBLIC')), 'OBJ no grants');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename LIKE 'comm\_%' AND permissive = 'PERMISSIVE'), 'OBJ no permissive policy');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE tablename LIKE 'comm\_%'), 'OBJ not in realtime');
  PERFORM t.ok(EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'comm-attachments' AND NOT public), 'OBJ private bucket');
  FOREACH who IN ARRAY array['OW', 'EA', 'AD', 'SUP', 'OA', 'AS', 'A1', 'B1'] LOOP
    PERFORM t.ok(t.exec(t.u(who), 'select * from public.comm_threads') = '42501'
             AND t.exec(t.u(who), 'select * from public.comm_messages') = '42501'
             AND t.exec(t.u(who), 'select * from public.comm_attachments') = '42501', 'OBJ no direct read ' || who);
  END LOOP;
  PERFORM t.ok(t.err(t.u('AD'), 'public._comm_scope_side(''admin_owner'')') = '42501'
           AND t.err(t.u('AD'), 'public._comm_bind_attachments(''admin_owner'', gen_random_uuid(), gen_random_uuid(), null)') = '42501',
           'OBJ internals closed');
  PERFORM t.ok(NOT has_function_privilege('service_role', 'public.comm_post(text,uuid,text,boolean,uuid[])', 'execute')
           AND NOT has_function_privilege('anon', 'public.comm_overview()', 'execute'), 'OBJ closed to anon/service_role');
  RAISE NOTICE 'PASS ① 123: المفاتيح مطفأة، مستودع خاص، لا منح ولا سياسة مسموحة ولا Realtime، ولا قراءة مباشرة لأي دور';
END $$;

-- ══ ①ب التراجع ثم إعادة التطبيق ═══════════════════════════════════════════
\i migrations/_rollback/123_communication_engine.down.sql
SET search_path = public, extensions;
DO $$ BEGIN
  PERFORM t.ok(t.schema_digest() = (SELECT s.v FROM t.saved s WHERE s.k = 'schema0'), 'RB schema byte-for-byte');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'comm-attachments'), 'RB bucket removed');
  RAISE NOTICE 'PASS ①ب التراجع: حرفيًا كما قبل 123';
END $$;
\i migrations/123_communication_engine.sql
\i migrations/123_communication_engine.sql
SET search_path = public, extensions;

-- ══ ② المفاتيح مطفأة ═══════════════════════════════════════════════════════
DO $$ BEGIN
  PERFORM t.ok(t.err(t.u('OA'), 'public.comm_thread_start(''company_platform'', ''technical'', ''مشكلة تقنية'', ''نص'', gen_random_uuid())') = '0A000', 'OFF start company_platform');
  PERFORM t.ok(t.err(t.u('AD'), 'public.comm_thread_start(''admin_owner'', ''report'', ''تقرير أسبوعي'', ''نص'', gen_random_uuid())') = '0A000', 'OFF start admin_owner');
  PERFORM t.ok(t.err(t.u('AD'), 'public.comm_threads_list(''company_platform'')') = '0A000', 'OFF list');
  PERFORM t.ok(t.err(t.u('AD'), 'public.comm_thread_start(''nope'', ''x'', ''xxx'', ''x'', gen_random_uuid())') = '22023', 'OFF unknown scope');
  PERFORM t.ok(t.side('OA', 'company_platform') IS NULL AND t.side('AD', 'admin_owner') IS NULL, 'OFF overview empty');
  PERFORM t.ok((t.call(t.u('OA'), 'public.comm_overview()') ->> 'attachments')::boolean = false, 'OFF attachments flag');
  RAISE NOTICE 'PASS ② المفاتيح مطفأة: الإجراءات 0A000 والنظرة العامة بلا نطاقات comm_*';
END $$;

-- ══ ③ customer_company عبر المحرّك (102 هو الحارس) ═══════════════════════════
DO $$
DECLARE r jsonb; who text;
BEGIN
  -- company_inbox_enabled مفعّل كما في الإنتاج
  PERFORM t.ok(t.side('A1', 'customer_company') = 'requester' AND t.side('OA', 'customer_company') = 'responder', 'CC sides');
  PERFORM t.ok(t.side('OB', 'customer_company') = 'responder' AND t.side('AD', 'customer_company') IS NULL
           AND t.side('OW', 'customer_company') IS NULL, 'CC platform staff has no side');
  PERFORM t.start('A1', 'CC1', 'customer_company', null, 'طلبي لم يصل', 'رقم الطلب 4455');
  PERFORM t.start('B1', 'CCB', 'customer_company', null, 'استفسار عن فاتورة', 'فاتورة رقم 99');
  PERFORM t.ok((SELECT company_id FROM public.company_conversations WHERE id = t.th('CC1')) = t.u('CA')
           AND (SELECT company_id FROM public.company_conversations WHERE id = t.th('CCB')) = t.u('CB'), 'CC stamped with server context');
  -- سيناريو 1: تظهر لدى فريق A وحده
  PERFORM t.ok(t.list('OA', 'customer_company') = 'CC1', 'S1 company A team sees it');
  PERFORM t.ok(t.list('OB', 'customer_company') = 'CCB', 'S1 company B team sees only its own');
  r := t.thread('OA', 'CC1');
  PERFORM t.ok(r ->> 'side' = 'responder' AND r ->> 'scope' = 'customer_company'
           AND r -> 'messages' -> 0 ->> 'side' = 'requester' AND r -> 'messages' -> 0 -> 'attachments' = '[]'::jsonb, 'S1 normalised thread');
  PERFORM t.ok(t.post('OA', 'CC1', 'وصلنا طلبك') = 'ok' AND t.post('A1', 'CC1', 'شكرًا') = 'ok', 'S1 both sides post');
  -- سيناريو 2: عميل A لا يصل لمحادثة B، ولا أحد من خارج الشركة
  FOREACH who IN ARRAY array['A1', 'A2', 'OA', 'AD', 'SUP', 'EA', 'OW'] LOOP
    PERFORM t.ok(t.thread_err(who, 'CCB') = 'P0002' AND t.post(who, 'CCB', 'تدخّل') = 'P0002', 'S2 no access to B ' || who);
  END LOOP;
  FOREACH who IN ARRAY array['B1', 'OB', 'BS', 'AD', 'OW'] LOOP
    PERFORM t.ok(t.thread_err(who, 'CC1') = 'P0002', 'S2 no access to A ' || who);
  END LOOP;
  PERFORM t.ok(t.list('A1', 'customer_company') = 'CC1' AND t.list('A2', 'customer_company') = '', 'S2 customers list only their own');
  RAISE NOTICE 'PASS ③ customer_company عبر المحرّك: رسالة عميل A تصل فريق A وحده، ولا وصول عبر الشركات أو من طاقم المنصة';
END $$;

-- ══ ④ company_platform ═══════════════════════════════════════════════════
DO $$
DECLARE r jsonb; who text;
BEGIN
  PERFORM t.sw('comm_company_platform_enabled', true);
  PERFORM t.ok(t.side('OA', 'company_platform') = 'requester' AND t.side('OB', 'company_platform') = 'requester', 'CP company owners request');
  PERFORM t.ok(t.side('AD', 'company_platform') = 'responder' AND t.side('SUP', 'company_platform') = 'responder', 'CP staff respond');
  FOREACH who IN ARRAY array['A1', 'B1', 'AS', 'AG', 'PU', 'AX'] LOOP
    PERFORM t.ok(t.side(who, 'company_platform') IS NULL, 'CP no side ' || who);
    PERFORM t.ok(t.err(t.u(who), 'public.comm_thread_start(''company_platform'', ''technical'', ''مشكلة تقنية'', ''نص'', gen_random_uuid())') = '42501', 'CP cannot start ' || who);
  END LOOP;
  PERFORM t.ok(t.side('OW', 'company_platform') IS NULL, 'CP owner without context: nothing');
  PERFORM t.ok(t.err(t.u('OA'), 'public.comm_thread_start(''company_platform'', ''decision'', ''مشكلة تقنية'', ''نص'', gen_random_uuid())') = '22023', 'CP category scoped');
  -- سيناريو 3: الشركة ترسل وتظهر داخل لوحة الإدارة
  PERFORM t.start('OA', 'PA', 'company_platform', 'technical', 'الواتساب لا يرسل', 'منذ الصباح الرسائل متوقفة');
  PERFORM t.start('OB', 'PB', 'company_platform', 'billing', 'فاتورة مكررة', 'خصم مرتين');
  PERFORM t.ok((SELECT company_id FROM public.comm_threads WHERE id = t.th('PA')) = t.u('CA'), 'S3 company stamped by server');
  PERFORM t.ok(t.list('AD', 'company_platform') = 'PA,PB' AND t.list('SUP', 'company_platform') = 'PA,PB', 'S3 admin dashboard sees both');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.notifications WHERE user_id = t.u('AD') AND link = '/admin-dashboard.html?comm=company_platform'), 'S3 admins notified');
  r := t.thread('AD', 'PA');
  PERFORM t.ok(r ->> 'side' = 'responder' AND r ->> 'company_name' = 'شركة أ' AND r ->> 'counterpart_name' = 'مالك أ'
           AND (r ->> 'can_internal')::boolean AND (r ->> 'can_assign')::boolean, 'S3 admin thread');
  PERFORM t.ok(t.post('AD', 'PA', 'نراجع الربط الآن') = 'ok', 'S3 admin replies');
  PERFORM t.ok(t.post('AD', 'PA', 'ملاحظة داخلية: مشكلة في الرمز', true) = 'ok', 'S3 internal note');
  r := t.thread('OA', 'PA');
  PERFORM t.ok(r ->> 'side' = 'requester' AND jsonb_array_length(r -> 'messages') = 2
           AND r -> 'messages' -> 1 ->> 'sender_name' IS NULL AND r ->> 'counterpart_name' IS NULL
           AND NOT (r ->> 'can_internal')::boolean AND NOT (r ->> 'can_assign')::boolean, 'S3 company sees reply, not internal, not staff names');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.notifications WHERE user_id = t.u('OA') AND link = '/company-dashboard/?comm=company_platform'), 'S3 company notified');
  PERFORM t.ok(t.post('OA', 'PA', 'سري', true) = '42501', 'S3 company cannot write internal');
  -- سيناريو 4: الشركة لا ترى محادثات شركات أخرى مع الإدارة
  PERFORM t.ok(t.list('OA', 'company_platform') = 'PA' AND t.list('OB', 'company_platform') = 'PB', 'S4 each company its own');
  FOREACH who IN ARRAY array['OB', 'BS', 'B1', 'A1', 'AS', 'AG', 'PU'] LOOP
    PERFORM t.ok(t.thread_err(who, 'PA') = 'P0002' AND t.post(who, 'PA', 'تدخّل') = 'P0002', 'S4 no access to PA ' || who);
  END LOOP;
  -- مالك المنصة: في سياق owner/admin يجيب، وفي سياق company_admin يتكلم باسم شركته فقط
  PERFORM t.ctx('owner');
  PERFORM t.ok(t.side('OW', 'company_platform') = 'responder' AND t.list('OW', 'company_platform') = 'PA,PB', 'CP owner context responds');
  PERFORM t.ctx('company_admin');
  PERFORM t.ok(t.side('OW', 'company_platform') = 'requester' AND t.list('OW', 'company_platform') = '', 'CP owner as company: own company only');
  PERFORM t.ok(t.thread_err('OW', 'PA') = 'P0002', 'CP owner as company: no access to others');
  PERFORM t.ctx(null);
  -- الإيقاف لا يقطع الشركة عن المنصة
  PERFORM set_config('app.company_status_write', 'on', true);
  UPDATE public.companies SET status = 'suspended' WHERE id = t.u('CA');
  PERFORM t.sw('company_suspension_enforced', true);
  PERFORM t.ok(t.post('OA', 'PA', 'شركتنا موقوفة، نحتاج المساعدة') = 'ok', 'CP suspended company can still reach platform');
  UPDATE public.companies SET status = 'active' WHERE id = t.u('CA');
  PERFORM t.sw('company_suspension_enforced', false);
  PERFORM set_config('app.company_status_write', 'off', true);
  RAISE NOTICE 'PASS ④ company_platform: الشركة ترسل وتظهر للإدارة، الردود تصلها بصوت واحد، الداخلي لا يصلها، ولا ترى شركة محادثات غيرها';
END $$;

-- ══ ⑤ admin_owner ═════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; who text;
BEGIN
  PERFORM t.sw('comm_admin_owner_enabled', true);
  PERFORM t.ok(t.side('AD', 'admin_owner') = 'requester' AND t.side('SUP', 'admin_owner') = 'requester'
           AND t.side('EA', 'admin_owner') = 'requester', 'AO staff request');
  PERFORM t.ok(t.side('OW', 'admin_owner') IS NULL, 'AO owner without context: nothing');
  FOREACH who IN ARRAY array['OA', 'OB', 'A1', 'AS', 'PU'] LOOP
    PERFORM t.ok(t.side(who, 'admin_owner') IS NULL, 'AO no side ' || who);
    PERFORM t.ok(t.err(t.u(who), 'public.comm_thread_start(''admin_owner'', ''report'', ''تقرير'', ''نص'', gen_random_uuid())') = '42501', 'AO cannot start ' || who);
  END LOOP;
  -- سيناريو 5: موظف الإدارة يرسل للمالك وتظهر في لوحة المالك
  PERFORM t.start('AD', 'O1', 'admin_owner', 'approval', 'طلب موافقة على استرداد', 'عميل يطلب استرداد 500');
  PERFORM t.start('SUP', 'O2', 'admin_owner', 'incident', 'تعطل مزود البريد', 'منذ ساعة');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.notifications WHERE user_id = t.u('OW') AND link = '/owner-dashboard.html?comm=admin_owner'), 'S5 owner notified');
  PERFORM t.ctx('owner');
  PERFORM t.ok(t.side('OW', 'admin_owner') = 'responder' AND t.list('OW', 'admin_owner') = 'O1,O2', 'S5 owner dashboard lists both');
  r := t.thread('OW', 'O1');
  PERFORM t.ok(r ->> 'side' = 'responder' AND r ->> 'counterpart_name' = 'أدمن' AND NOT (r ->> 'can_internal')::boolean, 'S5 owner thread');
  PERFORM t.ok(t.post('OW', 'O1', 'موافق، نفّذ الاسترداد') = 'ok', 'S5 owner replies');
  PERFORM t.ok(t.post('OW', 'O1', 'داخلي', true) = '42501', 'S5 no internal notes in admin_owner');
  PERFORM t.ctx('admin');
  PERFORM t.ok(t.side('OW', 'admin_owner') IS NULL AND t.thread_err('OW', 'O1') = 'P0002', 'S5 owner only in owner context');
  PERFORM t.ctx(null);
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.notifications WHERE user_id = t.u('AD') AND link = '/admin-dashboard.html?comm=admin_owner'), 'S5 requester notified');
  r := t.thread('AD', 'O1');
  PERFORM t.ok(jsonb_array_length(r -> 'messages') = 2 AND r -> 'messages' -> 1 ->> 'side' = 'responder', 'S5 admin sees owner reply');
  -- موظف الإدارة لا يحصل على صلاحيات المالك: زميله والأدمن المرتفع لا يرون محادثته
  PERFORM t.ok(t.list('AD', 'admin_owner') = 'O1' AND t.list('SUP', 'admin_owner') = 'O2' AND t.list('EA', 'admin_owner') = '', 'S5 staff see only their own');
  PERFORM t.ok(t.thread_err('SUP', 'O1') = 'P0002' AND t.thread_err('EA', 'O1') = 'P0002' AND t.post('EA', 'O1', 'x') = 'P0002', 'S5 colleagues and elevated admins: nothing');
  -- سيناريو 6: الشركة لا تصل للتواصل الداخلي بأي مسار
  FOREACH who IN ARRAY array['OA', 'OB', 'AS', 'A1', 'B1'] LOOP
    PERFORM t.ok(t.thread_err(who, 'O1') = 'P0002' AND t.post(who, 'O1', 'x') = 'P0002'
             AND t.err(t.u(who), format('public.comm_thread_set_status(''admin_owner'', %L::uuid, ''closed'')', t.th('O1'))) = 'P0002'
             AND t.err(t.u(who), 'public.comm_threads_list(''admin_owner'')') = 'ok'
             AND t.call(t.u(who), 'public.comm_threads_list(''admin_owner'')') IS NULL, 'S6 no internal access ' || who);
    -- ولا عبر نطاق خاطئ: معرّف محادثة داخلية مع نطاق الشركة
    PERFORM t.ok(t.err(t.u(who), format('public.comm_thread(''company_platform'', %L::uuid)', t.th('O1'))) = 'P0002', 'S6 scope confusion ' || who);
  END LOOP;
  PERFORM t.ctx('company_admin');
  PERFORM t.ok(t.thread_err('OW', 'O1') = 'P0002', 'S6 owner as company: no internal');
  PERFORM t.ctx(null);
  -- طاقم محظور يفقد جانبه
  UPDATE public.profiles SET ban_status = 'banned' WHERE id = t.u('SUP');
  PERFORM t.ok(t.side('SUP', 'admin_owner') IS NULL AND t.thread_err('SUP', 'O2') = 'P0002', 'AO banned staff loses access');
  UPDATE public.profiles SET ban_status = 'none' WHERE id = t.u('SUP');
  RAISE NOTICE 'PASS ⑤ admin_owner: الطاقم يرفع للمالك ويصله في سياق owner وحده، لا يرى زميل محادثة زميله، ولا تصل إليه الشركات وعملاؤها';
END $$;

-- ══ ⑥ المرفقات ═══════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_path text; v_att uuid; v_int uuid; v_cc uuid; who text; v_msg uuid;
BEGIN
  PERFORM t.ok(t.err(t.u('OA'), format('public.comm_attachment_begin(''company_platform'', %L::uuid, ''log.txt'', ''text/plain'', 10)', t.th('PA'))) = '0A000', 'ATT off');
  PERFORM t.sw('comm_attachments_enabled', true);
  PERFORM t.ok(t.err(t.u('OA'), format('public.comm_attachment_begin(''company_platform'', %L::uuid, ''x.exe'', ''application/x-msdownload'', 10)', t.th('PA'))) = '22023', 'ATT mime');
  PERFORM t.ok(t.err(t.u('OA'), format('public.comm_attachment_begin(''company_platform'', %L::uuid, ''big.pdf'', ''application/pdf'', 20000000)', t.th('PA'))) = '22023', 'ATT size');
  PERFORM t.ok(t.err(t.u('OB'), format('public.comm_attachment_begin(''company_platform'', %L::uuid, ''log.txt'', ''text/plain'', 10)', t.th('PA'))) = 'P0002', 'ATT other company cannot reserve');
  r := t.call(t.u('OA'), format('public.comm_attachment_begin(''company_platform'', %L::uuid, ''../../log.txt'', ''text/plain'', 10)', t.th('PA')));
  v_path := r ->> 'path'; v_att := (r ->> 'attachment_id')::uuid;
  PERFORM t.ok(v_path = 'company_platform/' || t.th('PA') || '/' || v_att AND position('/' in (SELECT file_name FROM public.comm_attachments WHERE id = v_att)) = 0, 'ATT path server-chosen, name sanitised');
  -- الرفع: المسار المحجوز لي وحدي
  PERFORM t.ok(t.exec(t.u('OB'), format('insert into storage.objects (bucket_id, name, owner) values (''comm-attachments'', %L, %L)', v_path, t.u('OB'))) = '42501', 'ATT upload by other refused');
  PERFORM t.ok(t.exec(t.u('OA'), format('insert into storage.objects (bucket_id, name, owner) values (''comm-attachments'', %L, %L)', 'company_platform/' || t.th('PA') || '/' || gen_random_uuid(), t.u('OA'))) = '42501', 'ATT unreserved path refused');
  -- الربط قبل الرفع مرفوض
  PERFORM t.ok(t.err(t.u('OA'), format('public.comm_post(''company_platform'', %L::uuid, ''مرفق السجل'', false, array[%L::uuid])', t.th('PA'), v_att)) = '22023', 'ATT bind before upload refused');
  PERFORM t.ok(t.exec(t.u('OA'), format('insert into storage.objects (bucket_id, name, owner) values (''comm-attachments'', %L, %L)', v_path, t.u('OA'))) = 'ok', 'ATT upload own reservation');
  PERFORM t.ok(t.rows(t.u('OA'), format('storage.objects where name = %L', v_path)) = 1
           AND t.rows(t.u('AD'), format('storage.objects where name = %L', v_path)) = 0, 'ATT pending visible to uploader only');
  -- ربط بحجز شخص آخر مرفوض
  PERFORM t.ok(t.err(t.u('AD'), format('public.comm_post(''company_platform'', %L::uuid, ''x'', false, array[%L::uuid])', t.th('PA'), v_att)) = '22023', 'ATT cannot bind others reservation');
  PERFORM t.ok(t.err(t.u('OA'), format('public.comm_post(''company_platform'', %L::uuid, '''', false, array[%L::uuid])', t.th('PA'), v_att)) = 'ok', 'ATT bound (attachment-only message)');
  PERFORM t.ok(t.err(t.u('OA'), format('public.comm_post(''company_platform'', %L::uuid, ''مرة أخرى'', false, array[%L::uuid])', t.th('PA'), v_att)) = '22023', 'ATT single use');
  r := t.thread('AD', 'PA');
  PERFORM t.ok(EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'messages') m WHERE m ->> 'body' LIKE '📎%'
                        AND m -> 'attachments' -> 0 ->> 'path' = v_path), 'ATT listed on message');
  -- سيناريو 7: القراءة بحدود الرسالة
  PERFORM t.ok(t.rows(t.u('AD'), format('storage.objects where name = %L', v_path)) = 1
           AND t.rows(t.u('SUP'), format('storage.objects where name = %L', v_path)) = 1, 'S7 platform staff can read');
  FOREACH who IN ARRAY array['OB', 'BS', 'B1', 'A1', 'AS', 'PU'] LOOP
    PERFORM t.ok(t.rows(t.u(who), format('storage.objects where name = %L', v_path)) = 0, 'S7 not readable by ' || who);
  END LOOP;
  -- مرفق ملاحظة داخلية: لا يصل للشركة
  r := t.call(t.u('AD'), format('public.comm_attachment_begin(''company_platform'', %L::uuid, ''internal.png'', ''image/png'', 100)', t.th('PA')));
  v_int := (r ->> 'attachment_id')::uuid;
  INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('comm-attachments', r ->> 'path', t.u('AD'));
  PERFORM t.ok(t.err(t.u('AD'), format('public.comm_post(''company_platform'', %L::uuid, ''لقطة داخلية'', true, array[%L::uuid])', t.th('PA'), v_int)) = 'ok', 'S7 internal attachment');
  PERFORM t.ok(t.rows(t.u('OA'), format('storage.objects where name = %L', r ->> 'path')) = 0
           AND t.rows(t.u('SUP'), format('storage.objects where name = %L', r ->> 'path')) = 1, 'S7 internal attachment stays internal');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t.thread('OA', 'PA') -> 'messages') m
                            WHERE m -> 'attachments' @> jsonb_build_array(jsonb_build_object('id', v_int))), 'S7 internal attachment not listed for company');
  -- admin_owner: مرفق تقرير يصل المالك وحده
  r := t.call(t.u('AD'), format('public.comm_attachment_begin(''admin_owner'', %L::uuid, ''report.pdf'', ''application/pdf'', 1000)', t.th('O1')));
  INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('comm-attachments', r ->> 'path', t.u('AD'));
  PERFORM t.ok(t.err(t.u('AD'), format('public.comm_post(''admin_owner'', %L::uuid, ''التقرير مرفق'', false, array[%L::uuid])', t.th('O1'), (r ->> 'attachment_id'))) = 'ok', 'S7 report attached');
  PERFORM t.ctx('owner');
  PERFORM t.ok(t.rows(t.u('OW'), format('storage.objects where name = %L', r ->> 'path')) = 1, 'S7 owner reads report');
  PERFORM t.ctx(null);
  FOREACH who IN ARRAY array['SUP', 'EA', 'OA', 'A1', 'OW'] LOOP
    PERFORM t.ok(t.rows(t.u(who), format('storage.objects where name = %L', r ->> 'path')) = 0, 'S7 report not readable by ' || who);
  END LOOP;
  -- customer_company: مرفق من العميل يصل فريق شركته وحده
  r := t.call(t.u('A1'), format('public.comm_attachment_begin(''customer_company'', %L::uuid, ''receipt.jpg'', ''image/jpeg'', 2048)', t.th('CC1')));
  INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('comm-attachments', r ->> 'path', t.u('A1'));
  PERFORM t.ok(t.err(t.u('A1'), format('public.comm_post(''customer_company'', %L::uuid, ''صورة الإيصال'', false, array[%L::uuid])', t.th('CC1'), (r ->> 'attachment_id'))) = 'ok', 'S7 customer attachment');
  PERFORM t.ok(t.rows(t.u('OA'), format('storage.objects where name = %L', r ->> 'path')) = 1
           AND t.rows(t.u('A1'), format('storage.objects where name = %L', r ->> 'path')) = 1, 'S7 customer + own company read');
  FOREACH who IN ARRAY array['A2', 'OB', 'B1', 'AD', 'SUP', 'OW'] LOOP
    PERFORM t.ok(t.rows(t.u(who), format('storage.objects where name = %L', r ->> 'path')) = 0, 'S7 customer file not readable by ' || who);
  END LOOP;
  PERFORM t.ok(t.err(t.u('B1'), format('public.comm_attachment_begin(''customer_company'', %L::uuid, ''x.png'', ''image/png'', 10)', t.th('CC1'))) = 'P0002', 'S7 other customer cannot reserve');
  -- الإشعارات بلا عنوان ولا نص
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.notifications n, public.comm_threads c
                            WHERE n.link LIKE '%?comm=%' AND position(c.subject in n.title || ' ' || n.message) > 0)
           AND NOT EXISTS (SELECT 1 FROM public.notifications n, public.comm_messages m
                            WHERE n.link LIKE '%?comm=%' AND position(m.body in n.message) > 0), 'S7 notifications carry no content');
  -- المرفق المرسَل لا يُحذف ولا يُعدَّل
  PERFORM t.ok(t.err_super_ok(format('delete from public.comm_attachments where id = %L', v_att)) = '23514'
           AND t.err_super_ok(format('update public.comm_attachments set thread_id = %L where id = %L', t.th('PB'), v_att)) = '23514', 'ATT immutable once sent');
  RAISE NOTICE 'PASS ⑥ المرفقات: حجز بمسار يختاره الخادم، رفع على الحجز وحده، ربط مرة واحدة، والقراءة بحدود الرسالة والنطاق — الداخلي داخلي';
END $$;

-- ══ ⑦ التذكرة، الإسناد، الإغلاق، البحث، الثوابت ═════════════════════════════
DO $$
DECLARE r jsonb; v_ticket uuid := gen_random_uuid(); v_other uuid := gen_random_uuid(); v_cc_ticket uuid := gen_random_uuid(); v_billing uuid := gen_random_uuid(); i int;
BEGIN
  -- التحويل إلى تذكرة: تذكرة الطالب نفسه، حديثة، مرة واحدة
  INSERT INTO public.tickets (id, user_id, title, description) VALUES (v_ticket, t.u('OA'), 'الواتساب لا يرسل', 'منقولة من المحادثة');
  INSERT INTO public.tickets (id, user_id, title, description) VALUES (v_other, t.u('OB'), 'تذكرة أخرى', 'x');
  PERFORM t.ok(t.err(t.u('AD'), format('public.comm_link_ticket(''company_platform'', %L::uuid, %L::uuid)', t.th('PA'), v_ticket)) = 'P0002', 'TKT responder cannot link');
  PERFORM t.ok(t.err(t.u('OA'), format('public.comm_link_ticket(''company_platform'', %L::uuid, %L::uuid)', t.th('PA'), v_other)) = 'P0002', 'TKT someone else''s ticket');
  PERFORM t.ok(t.err(t.u('AD'), format('public.comm_link_ticket(''admin_owner'', %L::uuid, %L::uuid)', t.th('O1'), v_ticket)) = '22023', 'TKT internal never a ticket');
  PERFORM t.ok(t.err(t.u('OA'), format('public.comm_link_ticket(''company_platform'', %L::uuid, %L::uuid)', t.th('PA'), v_ticket)) = 'ok', 'TKT linked');
  PERFORM t.ok(t.err(t.u('OA'), format('public.comm_link_ticket(''company_platform'', %L::uuid, %L::uuid)', t.th('PA'), v_ticket)) = '23505', 'TKT once');
  PERFORM t.ok(t.thread('AD', 'PA') -> 'ticket' ->> 'id' = v_ticket::text AND NOT (t.thread('OA', 'PA') ->> 'can_link_ticket')::boolean, 'TKT visible on thread');
  -- customer_company: تذكرة العميل لشركة المحادثة نفسها وحدها (ختم 097)
  INSERT INTO public.tickets (id, user_id, title, description) VALUES (v_cc_ticket, t.u('A1'), 'طلبي لم يصل', 'منقولة');
  INSERT INTO public.tickets (id, user_id, title, description, category) VALUES (v_billing, t.u('A1'), 'فاتورتي الشخصية', 'x', 'subscription');
  PERFORM t.ok((SELECT scope = 'company' AND company_id = t.u('CA') FROM public.tickets WHERE id = v_cc_ticket)
           AND (SELECT scope FROM public.tickets WHERE id = v_billing) = 'mad3oom_support', 'TKT stamped by 097');
  PERFORM t.ok(t.err(t.u('A1'), format('public.comm_link_ticket(''customer_company'', %L::uuid, %L::uuid)', t.th('CC1'), v_billing)) = 'P0002', 'TKT scope must match conversation');
  PERFORM t.ok(t.err(t.u('OA'), format('public.comm_link_ticket(''customer_company'', %L::uuid, %L::uuid)', t.th('CC1'), v_cc_ticket)) = 'P0002', 'TKT staff cannot link customer conversation');
  PERFORM t.ok(t.err(t.u('A1'), format('public.comm_link_ticket(''customer_company'', %L::uuid, %L::uuid)', t.th('CC1'), v_cc_ticket)) = 'ok'
           AND t.thread('OA', 'CC1') -> 'ticket' ->> 'id' = v_cc_ticket::text, 'TKT customer conversation linked, team sees it');
  -- الإسناد: طاقم المنصة لطاقم المنصة
  PERFORM t.ok(t.err(t.u('OA'), format('public.comm_thread_assign(''company_platform'', %L::uuid, %L::uuid)', t.th('PA'), t.u('AD'))) = '42501', 'ASSIGN company cannot');
  PERFORM t.ok(t.err(t.u('AD'), format('public.comm_thread_assign(''company_platform'', %L::uuid, %L::uuid)', t.th('PA'), t.u('OA'))) = '22023', 'ASSIGN only platform staff');
  PERFORM t.ok(t.err(t.u('AD'), format('public.comm_thread_assign(''company_platform'', %L::uuid, %L::uuid)', t.th('PA'), t.u('SUP'))) = 'ok', 'ASSIGN to support');
  PERFORM t.ok(t.list('SUP', 'company_platform', 'mine') = 'PA' AND t.list('AD', 'company_platform', 'unassigned') = 'PB', 'ASSIGN filters');
  PERFORM t.ok(t.thread('OA', 'PA') ->> 'assigned_to' IS NULL, 'ASSIGN hidden from company');
  PERFORM t.ok(jsonb_array_length(t.call(t.u('AD'), 'public.comm_staff_directory()')) >= 3
           AND t.call(t.u('OA'), 'public.comm_staff_directory()') = '[]'::jsonb, 'ASSIGN directory for responders only');
  -- رسالة الشركة تذهب للمسند إليه وحده
  DELETE FROM public.notifications WHERE link = '/admin-dashboard.html?comm=company_platform';
  PERFORM t.post('OA', 'PA', 'أي تحديث؟');
  PERFORM t.ok((SELECT array_agg(user_id) FROM public.notifications WHERE link = '/admin-dashboard.html?comm=company_platform') = array[t.u('SUP')], 'ASSIGN notification to assignee');
  -- الإغلاق: الطرفان؛ رد المجيب على المغلقة مرفوض، ورد الطالب يعيد الفتح
  PERFORM t.ok(t.err(t.u('AD'), format('public.comm_thread_set_status(''company_platform'', %L::uuid, ''closed'')', t.th('PB'))) = 'ok', 'STATUS close');
  PERFORM t.ok(t.post('AD', 'PB', 'بعد الإغلاق') = '55000', 'STATUS responder blocked on closed');
  PERFORM t.ok(NOT (t.thread('AD', 'PB') ->> 'can_reply')::boolean, 'STATUS can_reply false for responder');
  PERFORM t.ok(t.post('OB', 'PB', 'المشكلة عادت') = 'ok' AND t.thread('OB', 'PB') ->> 'status' = 'open', 'STATUS requester reply reopens');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.comm_events WHERE thread_id = t.th('PB') AND action = 'reopened'), 'STATUS reopen logged');
  PERFORM t.ok(t.list('AD', 'company_platform', 'closed') = '', 'STATUS closed filter');
  -- غير المقروء
  PERFORM t.ok((t.call(t.u('AD'), 'public.comm_overview()') -> 'scopes' -> 'company_platform' ->> 'unread')::int >= 1, 'UNREAD admin');
  PERFORM t.thread('AD', 'PA'); PERFORM t.thread('AD', 'PB');
  PERFORM t.ok((t.call(t.u('AD'), 'public.comm_overview()') -> 'scopes' -> 'company_platform' ->> 'unread')::int = 0, 'UNREAD cleared by reading');
  -- البحث (مع حروف LIKE مُهرَّبة)
  PERFORM t.ok(t.list('AD', 'company_platform', 'all', 'فاتورة') = 'PB' AND t.list('AD', 'company_platform', 'all', 'شركة أ') = 'PA', 'SEARCH subject and company');
  PERFORM t.ok(t.list('AD', 'company_platform', 'all', '%') = '' AND t.list('OB', 'company_platform', 'all', 'شركة أ') = '', 'SEARCH escaped and scoped');
  PERFORM t.ok(t.list('OA', 'customer_company', 'all', 'طلبي') = 'CC1', 'SEARCH customer_company');
  -- الثوابت
  PERFORM t.ok(t.err_super_ok(format('update public.comm_messages set body = ''مزوّر'' where thread_id = %L', t.th('PA'))) = '23514', 'INV no edit');
  PERFORM t.ok(t.err_super_ok(format('delete from public.comm_messages where thread_id = %L', t.th('PA'))) = '23514', 'INV no direct delete');
  PERFORM t.ok(t.err_super_ok('delete from public.comm_events') = '23514', 'INV events append-only');
  PERFORM t.ok(t.err_super_ok(format('update public.comm_threads set company_id = %L where id = %L', t.u('CB'), t.th('PA'))) = '23514'
           AND t.err_super_ok(format('update public.comm_threads set scope = ''admin_owner'', company_id = null where id = %L', t.th('PA'))) = '23514', 'INV scope and company fixed');
  PERFORM t.ok(t.err_super_ok(format('insert into public.comm_threads (scope, company_id, requester_id, category, subject, idempotency_key) values (''admin_owner'', %L, %L, ''report'', ''xxx'', gen_random_uuid())', t.u('CA'), t.u('AD'))) = '23514', 'INV internal thread cannot carry a company');
  -- منع التكرار
  r := t.call(t.u('AD'), format('public.comm_thread_start(''admin_owner'', ''report'', ''تقرير'', ''نص'', %L::uuid)', '11111111-1111-4111-8111-111111111111'));
  PERFORM t.ok((t.call(t.u('AD'), format('public.comm_thread_start(''admin_owner'', ''report'', ''تقرير'', ''نص'', %L::uuid)', '11111111-1111-4111-8111-111111111111')) ->> 'replayed')::boolean
           AND (SELECT count(*) FROM public.comm_threads WHERE requester_id = t.u('AD') AND idempotency_key = '11111111-1111-4111-8111-111111111111') = 1, 'IDEM replay');
  -- الحد: 5 محادثات في الساعة
  FOR i IN 1..3 LOOP PERFORM t.start('AD', 'L' || i, 'admin_owner', 'report', 'تقرير رقم ' || i, 'نص'); END LOOP;
  PERFORM t.ok(t.err(t.u('AD'), 'public.comm_thread_start(''admin_owner'', ''report'', ''تقرير سادس'', ''نص'', gen_random_uuid())') = '54000', 'LIMIT threads per hour');
  -- حذف حساب الطالب: السجل يبقى، والمحادثة الداخلية تبقى للمالك بلا صاحب
  UPDATE public.profiles SET role = 'support' WHERE id = t.u('DH');
  PERFORM t.start('DH', 'O3', 'admin_owner', 'operational', 'ضغط في طابور التذاكر', 'نحتاج موظفًا إضافيًا');
  PERFORM t.ok(t.post('DH', 'PA', 'تابعت مع فريق التكامل') = 'ok', 'INV DH posts as platform staff');
  PERFORM t.ok(t.err_super_ok(format('delete from auth.users where id = %L', t.u('DH'))) = 'ok', 'INV account deletion not blocked');
  PERFORM t.ok((SELECT requester_id FROM public.comm_threads WHERE id = t.th('O3')) IS NULL
           AND EXISTS (SELECT 1 FROM public.comm_messages WHERE thread_id = t.th('PA') AND sender_id IS NULL
                         AND body = 'تابعت مع فريق التكامل'), 'INV sender cleared, text kept');
  PERFORM t.ctx('owner');
  PERFORM t.ok(t.list('OW', 'admin_owner') LIKE '%O3%' AND t.thread('OW', 'O3') ->> 'counterpart_name' = 'حساب محذوف', 'INV owner keeps orphaned internal thread');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ⑦ التحويل إلى تذكرة للطالب وحده، الإسناد لطاقم المنصة، الإغلاق وإعادة الفتح، غير المقروء، البحث المهرَّب، والثوابت';
END $$;

-- ══ ⑧ عدم الانحدار ═══════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ok((SELECT md5(string_agg(pg_get_functiondef(p.oid), '#' order by p.oid::regprocedure::text))
                  FROM pg_proc p WHERE p.proname LIKE 'company_conversation%' OR p.proname LIKE '_inbox_%' OR p.proname LIKE 'company_inbox_%'
                                    OR p.proname = 'my_company_conversations') = (SELECT v FROM t.saved WHERE k = 'fn102'), 'S8 102 functions unchanged');
  -- مسار 102 المباشر (صفحة صندوق الشركة وبوابة العميل الحالية) يعمل كما كان ويرى رسائل المحرّك
  r := t.call(t.u('A1'), 'public.my_company_conversations()');
  PERFORM t.ok(jsonb_array_length(r -> 'conversations') = 1, 'S8 portal list via 102');
  r := t.call(t.u('OA'), format('public.company_conversation_thread(%L::uuid)', t.th('CC1')));
  PERFORM t.ok(jsonb_array_length(r -> 'messages') = 4, 'S8 inbox thread via 102 sees engine messages');
  PERFORM t.ok(t.err(t.u('OA'), format('public.company_conversation_post(%L::uuid, ''رد مباشر'', false)', t.th('CC1'))) = 'ok', 'S8 direct 102 post');
  -- لا تغيير على التذاكر: الطالب يرى تذكرته كما هي
  PERFORM t.ok(t.rows(t.u('OA'), 'public.tickets where title = ''الواتساب لا يرسل''') = 1, 'S8 tickets untouched');
  RAISE NOTICE 'PASS ⑧ عدم الانحدار: دوال 102 حرفيًا كما هي، والصندوق والبوابة يعملان مباشرة ويرون رسائل المحرّك';
END $$;

-- ══ ⑨ رفض التراجع ══════════════════════════════════════════════════════════
\set rbsql `cat migrations/_rollback/123_communication_engine.down.sql`
SELECT set_config('t.rbsql', :'rbsql', false) IS NOT NULL;
DO $$
BEGIN
  BEGIN
    EXECUTE current_setting('t.rbsql');
    RAISE EXCEPTION 'FAIL RB allowed with switch on';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%مرفوض%' THEN RAISE; END IF;
  END;
  UPDATE public.platform_feature_switches SET enabled = false WHERE key LIKE 'comm\_%';
  BEGIN
    EXECUTE current_setting('t.rbsql');
    RAISE EXCEPTION 'FAIL RB allowed with data';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%مرفوض%' THEN RAISE; END IF;
  END;
  PERFORM t.ok(to_regclass('public.comm_threads') IS NOT NULL, 'RB nothing dropped');
  RAISE NOTICE 'PASS ⑨ التراجع مرفوض مع مفتاح مفعّل أو بيانات';
END $$;

SELECT 'ALL communication-engine tests passed';
