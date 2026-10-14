-- ============================================================================
-- 104_company_documents_followups على نسخة مطابقة للإنتاج حتى 093 + 094 … 103 (ترتيب الإنتاج)
--
--   ⓪ قبل 104: حذف مالك شركة لها مستند يفشل (23514)، وحذف مراجع مسند يفشل (23503) — M1 كما في الإنتاج
--   ① 104: الكائنات، المفتاح مطفأ؛ ①ب التراجع حرفيًا ثم إعادة التطبيق مرتين
--   ② M2: سياسة تخزين غير مقيّدة بالمستودع توقف الترحيل
--   ③ L3: التأكيد بهوية المستخدم مرفوض؛ التأكيد لمفتاح الخدمة بالرافع نفسه وبصمة الخادم
--   ④ L4/L5: النتيجة بلا nonce مرفوضة؛ nonce مرة واحدة؛ scan_error يعود للطابور حتى 3 محاولات ثم يبقى معزولًا
--   ⑤ L1/L2: تنزيل المالك بتحقق خطوتين؛ المراجع (aal2) للإصدار الحالي وحده
--   ⑥ L7: التجربة الجافة تستثني الإصدار الحالي حتى المرفوض
--   ⑦ L6: حد الرفع المعلّق لكل مستند، وحد الساعة لكل رافع؛ إعادة الإرسال لا تُحسب
--   ⑧ M1: حذف المراجع يرفع إسناده بسطر في السجل؛ حذف مالك الشركة ينجح والمستندات والحجوز باقية
--   ⑨ ترتيب التراجع: 100 و103 مرفوضان مع 104؛ 104 مرفوض مع مستندات شركة محذوفة — بلا أي تغيير
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
SET search_path = public, extensions;

CREATE FUNCTION t.own(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN PERFORM t.ctx('owner'); PERFORM t.stepup(t.u('OW')); RETURN t.call(t.u('OW'), p_sql); END $$;
CREATE FUNCTION t.own_err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN PERFORM t.ctx('owner'); PERFORM t.stepup(t.u('OW')); RETURN t.err(t.u('OW'), p_sql); END $$;
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
CREATE FUNCTION t.aal_errfull(p uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE m text; d text;
BEGIN PERFORM t.aal_call(p, p_sql); RETURN 'ok';
EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS m = MESSAGE_TEXT, d = PG_EXCEPTION_DETAIL; RETURN SQLSTATE || '|' || m || '|' || coalesce(d, ''); END $$;
CREATE FUNCTION t.x(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  select (case p when 'ZO' then '0e000000-0000-4000-8000-0000000000c2' when 'RV' then '0e000000-0000-4000-8000-0000000000c3'
                 when 'CZ' then 'cd000000-0000-4000-8000-0000000000cd' end)::uuid $$;
CREATE FUNCTION t.sv(p text) RETURNS uuid LANGUAGE sql AS $$ select v::uuid from t.saved where k = p $$;
CREATE FUNCTION t.sha(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;
CREATE FUNCTION t.nonce() RETURNS text LANGUAGE sql VOLATILE AS $$ select encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex') $$;
-- «الدالة الطرفية رفعت الملف وأكّدته»: begin بهوية مدير الشركة، صف في المستودع، ثم التأكيد بمفتاح الخدمة
CREATE FUNCTION t.mkver(p_type text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r jsonb; v uuid;
BEGIN
  r := t.call(t.u('OA'), format('public.document_upload_begin(%L, ''application/pdf'', 1000, ''ملف.pdf'', gen_random_uuid())', p_type));
  v := (r #>> '{version,id}')::uuid;
  INSERT INTO storage.objects (bucket_id, name, owner, metadata)
  VALUES ('company-documents', r #>> '{upload,path}', null, jsonb_build_object('size', 1000));
  PERFORM public.document_upload_commit_server(v, t.u('OA'), t.sha(v::text));
  RETURN v;
END $$;
CREATE FUNCTION t.scan(p_v uuid, p_res text) RETURNS jsonb LANGUAGE sql AS $$
  select public.document_scan_result(p_v, p_res, 'clamav-test', '{}'::jsonb, t.nonce()) $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

INSERT INTO auth.users (id, email) VALUES (t.x('ZO'), 'zo104@tenancy.test'), (t.x('RV'), 'rv104@tenancy.test');
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at) VALUES
  (t.x('ZO'), 'zo104@tenancy.test', 'مالك ز', 'user', '01100000093', '2026-09-01'),
  (t.x('RV'), 'rv104@tenancy.test', 'مراجع', 'admin', '01100000094', '2026-09-01');
INSERT INTO public.companies (id, user_id, company_name, commercial_registration_number, tax_id, company_email) VALUES
  (t.x('CZ'), t.x('ZO'), 'شركة ز', 'CR-Z-104', 'TAX-Z4', 'z104@company.test');

-- ══ ⓪ قبل 104 ═══════════════════════════════════════════════════════════
DO $$
DECLARE d uuid;
BEGIN
  INSERT INTO public.company_documents (company_id, doc_type) VALUES (t.x('CZ'), 'tax_card') RETURNING id INTO d;
  INSERT INTO t.saved VALUES ('dz', d);
  PERFORM t.ok(t.err_super_ok(format('delete from auth.users where id = %L', t.x('ZO'))) = '23514', 'PRE company deletion blocked by documents');
  UPDATE public.company_documents SET assigned_reviewer = t.x('RV') WHERE id = d;
  PERFORM t.ok(t.err_super_ok(format('delete from auth.users where id = %L', t.x('RV'))) = '23503', 'PRE reviewer deletion blocked');
  RAISE NOTICE 'PASS ⓪ قبل 104: حذف مالك شركة لها مستند يفشل (23514)، وحذف مراجع مسند يفشل (23503) — M1 كما في الإنتاج';
END $$;
INSERT INTO t.saved VALUES ('schema0', t.schema_digest());

-- ══ ① 104 ════════════════════════════════════════════════════════════════
\i migrations/104_company_documents_followups.sql
SET search_path = public, extensions;
DO $$ BEGIN
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.platform_feature_switches WHERE enabled), 'OBJ switches off');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_constraint WHERE contype = 'f' AND confrelid = 'public.companies'::regclass
                 AND conrelid IN ('public.company_documents'::regclass, 'public.legal_holds'::regclass)), 'OBJ no FK to companies');
  PERFORM t.ok((SELECT confdeltype FROM pg_constraint WHERE conname = 'company_documents_assigned_reviewer_fkey') = 'n', 'OBJ reviewer SET NULL');
  PERFORM t.ok(NOT has_function_privilege('authenticated', 'public.document_upload_commit_server(uuid,uuid,text)', 'execute')
           AND has_function_privilege('service_role', 'public.document_upload_commit_server(uuid,uuid,text)', 'execute')
           AND NOT has_function_privilege('authenticated', 'public.document_scan_result(uuid,text,text,jsonb,text)', 'execute')
           AND has_function_privilege('service_role', 'public.document_scan_result(uuid,text,text,jsonb,text)', 'execute')
           AND NOT has_table_privilege('service_role', 'public.document_scan_nonces', 'select')
           AND NOT has_function_privilege('authenticated', 'public._storage_unscoped_policies()', 'execute'), 'OBJ grants');
  RAISE NOTICE 'PASS ① 104: المفتاح مطفأ، لا مفاتيح خارجية إلى الشركات، حذف المراجع يرفع الإسناد، ودوال الخدمة لمفتاح الخدمة وحده';
END $$;
\i migrations/_rollback/104_company_documents_followups.down.sql
DO $$ BEGIN
  PERFORM t.ok(t.schema_digest() = (SELECT v FROM t.saved WHERE k = 'schema0'), 'RB schema byte-for-byte');
  RAISE NOTICE 'PASS ①ب التراجع: الدوال والمحفّزات والقيود والأعمدة والصلاحيات حرفيًا كما قبل 104';
END $$;
\i migrations/104_company_documents_followups.sql
\i migrations/104_company_documents_followups.sql
SET search_path = public, extensions;

-- ══ ② M2 ═════════════════════════════════════════════════════════════════
\set m104 `cat migrations/104_company_documents_followups.sql`
SELECT set_config('t.m104', :'m104', false) IS NOT NULL;
DO $$ BEGIN
  PERFORM t.ok(cardinality(public._storage_unscoped_policies()) = 0, 'M2 none in prod shape');
  CREATE POLICY t_open_all ON storage.objects FOR SELECT USING (true);
  PERFORM t.ok(public._storage_unscoped_policies() = array['t_open_all'], 'M2 detects');
  BEGIN
    EXECUTE current_setting('t.m104');
    RAISE EXCEPTION 'FAIL M2 migration accepted an unscoped policy';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%غير مقيّدة%' THEN RAISE; END IF;
  END;
  DROP POLICY t_open_all ON storage.objects;
  RAISE NOTICE 'PASS ② M2: أي سياسة سماح على storage.objects لا تذكر bucket_id توقف الترحيل';
END $$;

-- ══ ③ L3 التأكيد ═════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v uuid; p text;
BEGIN
  PERFORM t.sw('company_documents_enabled', true);
  r := t.call(t.u('OA'), 'public.document_upload_begin(''commercial_registration'', ''application/pdf'', 1000, ''سجل.pdf'', gen_random_uuid())');
  v := (r #>> '{version,id}')::uuid; p := r #>> '{upload,path}';
  INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES ('company-documents', p, null, jsonb_build_object('size', 1000));
  PERFORM t.ok(t.errfull(t.u('OA'), format('public.document_upload_commit(%L::uuid, %L)', v, t.sha('x'))) LIKE '42501|%server_commit_only%', 'L3 user commit refused');
  PERFORM t.ok(t.err(t.u('OA'), format('public.document_upload_commit_server(%L::uuid, %L::uuid, %L)', v, t.u('OA'), t.sha('x'))) = '42501', 'L3 server commit not for users');
  PERFORM t.ok(t.err_super_ok(format('select public.document_upload_commit_server(%L, %L, %L)', v, t.u('OB'), t.sha('x'))) = 'P0002', 'L3 other actor');
  PERFORM t.ok(t.err_super_ok(format('select public.document_upload_commit_server(%L, %L, ''nothex'')', v, t.u('OA'))) = '22023', 'L3 sha format');
  PERFORM t.ok(public.document_upload_commit_server(v, t.u('OA'), t.sha('cr')) ->> 'status' = 'pending_scan', 'L3 server commit');
  PERFORM t.ok(public.document_upload_commit_server(v, t.u('OA'), null) ->> 'status' = 'pending_scan', 'L3 resend returns state');
  PERFORM t.ok((SELECT sha256 FROM public.company_document_versions WHERE id = v) = t.sha('cr'), 'L3 sha kept');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.company_document_events WHERE version_id = v AND action = 'uploaded'
                         AND actor_id = t.u('OA') AND detail ->> 'sha256_by' = 'server'), 'L3 event');
  INSERT INTO t.saved VALUES ('v_cr', v);
  RAISE NOTICE 'PASS ③ L3: التأكيد بهوية المستخدم مرفوض (server_commit_only)؛ التأكيد لمفتاح الخدمة بالرافع نفسه وبصمة يحسبها الخادم';
END $$;

-- ══ ④ L4/L5 الفحص ═══════════════════════════════════════════════════════
DO $$
DECLARE v uuid := t.sv('v_cr'); n text := t.nonce();
BEGIN
  PERFORM t.ok(t.err_super_ok(format('select public.document_scan_result(%L::uuid, ''clean'', ''clamav'')', v)) = '42501', 'L5 no-nonce form refused');
  PERFORM t.ok(t.err_super_ok(format('select public.document_scan_result(%L::uuid, ''clean'', ''clamav'', ''{}''::jsonb, ''short'')', v)) = '22023', 'L5 nonce format');
  PERFORM t.ok(t.err(t.u('OA'), format('public.document_scan_result(%L::uuid, ''clean'', ''clamav'', ''{}''::jsonb, %L)', v, t.nonce())) = '42501', 'L5 not for users');
  PERFORM t.ok(public.document_scan_result(v, 'error', 'clamav-test', '{}'::jsonb, n) ->> 'status' = 'scan_error', 'L4 error 1');
  PERFORM t.ok(t.err_super_ok(format('select public.document_scan_result(%L::uuid, ''error'', ''clamav-test'', ''{}''::jsonb, %L)', v, n)) = '23505', 'L5 replay refused');
  PERFORM t.ok(EXISTS (SELECT 1 FROM jsonb_array_elements(public.document_scan_queue()) e WHERE e ->> 'version_id' = v::text AND (e ->> 'attempt')::int = 2), 'L4 requeued');
  PERFORM t.scan(v, 'error');
  PERFORM t.scan(v, 'error');
  PERFORM t.ok((SELECT scan_attempts FROM public.company_document_versions WHERE id = v) = 3
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.document_scan_queue()) e WHERE e ->> 'version_id' = v::text), 'L4 gave up after 3');
  PERFORM t.ok(t.err_super_ok(format('select t.scan(%L::uuid, ''clean'')', v)) = '55000', 'L4 exhausted refused');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.company_document_events WHERE version_id = v AND action = 'scan_gave_up'), 'L4 event');
  PERFORM t.ok(t.errfull(t.u('OA'), format('public.document_download_authorize(%L::uuid)', v)) LIKE '55000|%scan_error%', 'L4 stays quarantined');
  RAISE NOTICE 'PASS ④ L4/L5: النتيجة تحتاج nonce يُقبل مرة واحدة؛ scan_error يعود للطابور حتى 3 محاولات ثم يبقى معزولًا بسطر في السجل';
END $$;

-- ══ ⑤ L1/L2 التنزيل ═════════════════════════════════════════════════════
DO $$
DECLARE v1 uuid; v2 uuid; d uuid; u uuid;
BEGIN
  v1 := t.mkver('tax_card');
  PERFORM t.scan(v1, 'clean');
  v2 := t.mkver('tax_card');
  PERFORM t.scan(v2, 'clean');
  d := (SELECT document_id FROM public.company_document_versions WHERE id = v2);
  INSERT INTO t.saved VALUES ('v1', v1), ('v2', v2), ('d_tax', d);
  -- L1: المالك
  DELETE FROM public.privileged_step_ups WHERE user_id = t.u('OW');
  PERFORM t.ctx('owner');
  PERFORM t.ok(t.errfull(t.u('OW'), format('public.document_download_authorize(%L::uuid)', v2)) LIKE '42501|%step_up_required%', 'L1 owner without step-up');
  PERFORM t.ok(t.own(format('public.document_download_authorize(%L::uuid)', v2)) ->> 'bucket' = 'company-documents', 'L1 owner with step-up');
  PERFORM t.ctx(null);
  PERFORM t.ok(t.call(t.u('OA'), format('public.document_download_authorize(%L::uuid)', v1)) ->> 'bucket' = 'company-documents', 'L2 company admin any version');
  -- L2: المراجع المسند (تفويض documents.review، جلسة aal2)
  PERFORM t.sw('delegation_enabled', true);
  u := (t.own('public.owner_unit_create(''مراجعة المستندات'')') ->> 'unit_id')::uuid;
  PERFORM t.own(format('public.owner_assign_company_unit(%L::uuid, %L::uuid, ''وحدة مراجعة مستندات أ'')', t.u('CA'), u));
  PERFORM t.own(format('public.owner_grant_delegation(%L::uuid, %L::uuid, array[''documents.review''], ''مراجعة مستندات الوحدة'')', t.u('AD'), u));
  PERFORM t.own(format('public.owner_assign_document_reviewer(%L::uuid, %L::uuid, null, ''إسناد مراجعة البطاقة'')', d, t.u('AD')));
  PERFORM t.ctx(null);
  PERFORM t.ok(t.err(t.u('AD'), format('public.document_download_authorize(%L::uuid)', v2)) = 'P0002', 'L2 reviewer needs aal2');
  PERFORM t.ok(t.call(t.u('AD'), 'public.reviewer_documents()') = '[]'::jsonb, 'L2 reviewer list needs aal2');
  PERFORM t.ok(t.aal_call(t.u('AD'), format('public.document_download_authorize(%L::uuid)', v2)) ->> 'bucket' = 'company-documents', 'L2 reviewer current');
  PERFORM t.ok(t.aal_errfull(t.u('AD'), format('public.document_download_authorize(%L::uuid)', v1)) LIKE '55000|%not_current%', 'L2 reviewer superseded refused');
  PERFORM t.ok(jsonb_array_length(t.aal_call(t.u('AD'), 'public.reviewer_documents()')) = 1, 'L2 reviewer list with aal2');
  RAISE NOTICE 'PASS ⑤ L1/L2: تنزيل المالك يحتاج تحقق خطوتين حديثًا؛ المراجع بجلسة aal2 وللإصدار الحالي وحده؛ مدير الشركة لكل إصداراته';
END $$;

-- ══ ⑥ L7 الاحتفاظ ═══════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.own(format('public.document_review(%L::uuid, false, ''الصورة غير واضحة، ارفع نسخة أوضح'')', t.sv('v2')));
  r := t.own(format('public.owner_retention_dry_run(%L::date)', current_date + 4000));
  PERFORM t.ctx(null);
  PERFORM t.ok(EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'would_delete') x WHERE x ->> 'version_id' = t.sv('v1')::text), 'L7 superseded is a candidate');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'would_delete') x
                            WHERE x ->> 'version_id' IN (t.sv('v2')::text, t.sv('v_cr')::text)), 'L7 current never a candidate ' || r::text);
  RAISE NOTICE 'PASS ⑥ L7: التجربة الجافة تستثني الإصدار الحالي دائمًا (حتى المرفوض أو المعزول)، وتُبقي المستبدل مرشحًا';
END $$;

-- ══ ⑦ L6 حدود الرفع ═════════════════════════════════════════════════════
DO $$
DECLARE k1 uuid := gen_random_uuid(); i int; d uuid;
BEGIN
  PERFORM t.call(t.u('OA'), format('public.document_upload_begin(''authorization_letter'', ''application/pdf'', 1000, null, %L::uuid)', k1));
  PERFORM t.call(t.u('OA'), 'public.document_upload_begin(''authorization_letter'', ''application/pdf'', 1000, null, gen_random_uuid())');
  PERFORM t.call(t.u('OA'), 'public.document_upload_begin(''authorization_letter'', ''application/pdf'', 1000, null, gen_random_uuid())');
  PERFORM t.ok(t.errfull(t.u('OA'), 'public.document_upload_begin(''authorization_letter'', ''application/pdf'', 1000, null, gen_random_uuid())') LIKE '54000|%too_many_pending%', 'L6 pending per document');
  PERFORM t.ok(t.err(t.u('OA'), format('public.document_upload_begin(''authorization_letter'', ''application/pdf'', 1000, null, %L::uuid)', k1)) = 'ok', 'L6 resend not counted');
  -- حد الساعة: سجلات رفع سابقة لنفس الرافع
  d := t.sv('d_tax');
  FOR i IN 1..20 LOOP
    INSERT INTO public.company_document_versions (document_id, version_no, idempotency_key, status, storage_path, mime_type, size_bytes, uploaded_by)
    VALUES (d, 100 + i, gen_random_uuid(), 'pending_scan', 'fill/' || i, 'application/pdf', 10, t.u('OA'));
  END LOOP;
  PERFORM t.ok((SELECT count(*) FROM public.company_document_versions WHERE uploaded_by = t.u('OA') AND created_at > now() - interval '1 hour') >= 20, 'L6 setup');
  PERFORM t.ok(t.errfull(t.u('OA'), 'public.document_upload_begin(''contract_proof'', ''application/pdf'', 1000, null, gen_random_uuid())') LIKE '54000|%hourly_limit%', 'L6 hourly per uploader');
  PERFORM t.ok(t.err(t.u('OB'), 'public.document_upload_begin(''contract_proof'', ''application/pdf'', 1000, null, gen_random_uuid())') = 'ok', 'L6 other uploader unaffected');
  RAISE NOTICE 'PASS ⑦ L6: 3 رفعات معلقة لكل مستند و20 في الساعة لكل رافع (54000 ⇒ 429)؛ إعادة الإرسال بنفس المفتاح لا تُحسب';
END $$;

-- ══ ⑧ M1 الحذف ═══════════════════════════════════════════════════════════
DO $$
DECLARE dz uuid := t.sv('dz'); r jsonb;
BEGIN
  PERFORM t.ok(t.err_super_ok(format('delete from auth.users where id = %L', t.x('RV'))) = 'ok', 'M1 reviewer deletion');
  PERFORM t.ok((SELECT assigned_reviewer FROM public.company_documents WHERE id = dz) IS NULL, 'M1 assignment cleared');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.company_document_events WHERE document_id = dz AND action = 'reviewer_removed'
                         AND detail ->> 'reviewer' = t.x('RV')::text), 'M1 reviewer event');
  PERFORM t.own(format('public.owner_legal_hold_set(%L::uuid, %L::uuid, ''حجز قانوني لمستند الشركة'')', t.x('CZ'), dz));
  PERFORM t.ctx(null);
  PERFORM t.ok(t.err_super_ok(format('delete from auth.users where id = %L', t.x('ZO'))) = 'ok', 'M1 company owner deletion');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.companies WHERE id = t.x('CZ'))
           AND EXISTS (SELECT 1 FROM public.company_documents WHERE id = dz)
           AND EXISTS (SELECT 1 FROM public.legal_holds WHERE company_id = t.x('CZ') AND released_at IS NULL), 'M1 documents and holds kept');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.company_document_events WHERE company_id = t.x('CZ') AND action = 'company_deleted'
                         AND (detail ->> 'open_holds')::int = 1), 'M1 company event');
  r := (SELECT e FROM jsonb_array_elements(t.own('public.owner_documents_queue()')) e WHERE e ->> 'id' = dz::text);
  PERFORM t.ok(r ->> 'company_name' = 'شركة محذوفة' AND (r ->> 'company_deleted')::boolean, 'M1 owner queue');
  PERFORM t.ok(t.own_err(format('public.owner_legal_hold_set(%L::uuid, null, ''حجز إضافي بعد حذف الشركة'')', t.x('CZ'))) = 'ok', 'M1 hold on deleted company');
  PERFORM t.ok(t.own_err(format('public.owner_legal_hold_set(%L::uuid, null, ''شركة لم توجد أبدًا هنا'')', t.u('NOPE'))) = 'P0002', 'M1 unknown company');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ⑧ M1 (القرار A): حذف المراجع يرفع إسناده بسطر في السجل؛ حذف مالك الشركة ينجح والمستندات والحجوز باقية؛ المالك يراها باسم «شركة محذوفة» ويحجز عليها';
END $$;

-- ══ ⑨ ترتيب التراجع ═════════════════════════════════════════════════════
\set rb100 `cat migrations/_rollback/100_company_documents.down.sql`
\set rb103 `cat migrations/_rollback/103_admin_hierarchy_followups.down.sql`
\set rb104 `cat migrations/_rollback/104_company_documents_followups.down.sql`
SELECT set_config('t.rb100', :'rb100', false) IS NOT NULL, set_config('t.rb103', :'rb103', false) IS NOT NULL,
       set_config('t.rb104', :'rb104', false) IS NOT NULL;
DO $$
DECLARE s text; k text; want text;
BEGIN
  PERFORM t.sw('company_documents_enabled', false);
  PERFORM t.sw('delegation_enabled', false);
  s := t.schema_digest();
  FOR k, want IN VALUES ('t.rb100', '%104 مطبَّق%'), ('t.rb103', '%104 مطبَّق%'), ('t.rb104', '%شركة محذوفة%') LOOP
    BEGIN
      EXECUTE current_setting(k);
      RAISE EXCEPTION 'FAIL % allowed', k;
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM NOT LIKE want THEN RAISE; END IF;
    END;
  END LOOP;
  PERFORM t.ok(t.schema_digest() = s, 'RB nothing changed');
  RAISE NOTICE 'PASS ⑨ التراجع: 100 و103 مرفوضان قبل أي تغيير ما دام 104 مطبَّقًا، و104 مرفوض مع مستندات شركة محذوفة';
END $$;

SELECT 'ALL company-documents-followups tests passed';
