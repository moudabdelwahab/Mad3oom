-- ============================================================================
-- 100_company_documents على نسخة مطابقة للإنتاج حتى 093 + 095 … 099
--
--   ① الكائنات: المفتاح مطفأ، المستودع خاص وبلا سياسة، لا وصول مباشر
--   ①ب التراجع حرفيًا ثم إعادة التطبيق
--   ② المفتاح مطفأ: لا رفع
--   ③ الرفع: مدير الشركة وحده، النوع والحجم، منع التكرار، الملف المخزَّن نفسه، البصمة
--   ④ العزل حتى الفحص: لا تنزيل ولا مراجعة قبل نتيجة نظيفة؛ النتيجة لمفتاح الخدمة وحده ونهائية
--   ⑤ التنزيل والمراجعة: مدير الشركة ومالك المنصة؛ لا شركة أخرى ولا إداري غير مسند؛ لا مراجعة ذاتية؛
--      تاريخ الانتهاء؛ المحتوى ثابت؛ الإصدار البديل، والمصاب يُرفض آليًا
--   ⑥ المراجع المسند: بتفويض documents.review على وحدة الشركة، يرى ما أُسند إليه وحده
--   ⑦ البيانات الإدارية بسجل قبل/بعد، الانتهاء والتنبيه مرة واحدة، الحجز القانوني والاحتفاظ (تجربة جافة)
--   ⑧ رفض التراجع مع وجود مستندات
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
\i migrations/098_company_permissions_usage_ledger.sql
\i migrations/099_admin_hierarchy.sql
SET search_path = public, extensions;

CREATE FUNCTION t.own(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN PERFORM t.ctx('owner'); PERFORM t.stepup(t.u('OW')); RETURN t.call(t.u('OW'), p_sql); END $$;
CREATE FUNCTION t.own_err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN PERFORM t.ctx('owner'); PERFORM t.stepup(t.u('OW')); RETURN t.err(t.u('OW'), p_sql); END $$;
CREATE FUNCTION t.begin_doc(p text, p_type text, p_mime text, p_size int, p_key uuid) RETURNS jsonb LANGUAGE sql AS $$
  select t.call(t.u(p), format('public.document_upload_begin(%L, %L, %s, ''ملف.pdf'', %L::uuid)', p_type, p_mime, p_size, p_key)) $$;
-- «الدالة الطرفية رفعت الملف»: صف في storage.objects بالحجم الفعلي
CREATE FUNCTION t.put_object(p_path text, p_size int) RETURNS void LANGUAGE sql AS $$
  insert into storage.objects (bucket_id, name, owner, metadata) values ('company-documents', p_path, null, jsonb_build_object('size', p_size)) $$;
CREATE FUNCTION t.sha(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

INSERT INTO t.saved VALUES ('schema0', t.schema_digest());

-- ══ ① 100 ════════════════════════════════════════════════════════════════
\i migrations/100_company_documents.sql
SET search_path = public, extensions;
DO $$ BEGIN
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM public.platform_feature_switches WHERE enabled), 'OBJ switches off');
  PERFORM t.ok((SELECT NOT public AND file_size_limit = 10485760 FROM storage.buckets WHERE id = 'company-documents'), 'OBJ private bucket 10MB');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%company-documents%'), 'OBJ no storage policy');
  PERFORM t.ok(NOT has_table_privilege('authenticated', 'public.company_document_versions', 'select')
           AND NOT has_function_privilege('authenticated', 'public.document_scan_result(uuid,text,text,jsonb)', 'execute')
           AND has_function_privilege('service_role', 'public.document_scan_result(uuid,text,text,jsonb)', 'execute'), 'OBJ grants');
  PERFORM t.ok((SELECT count(*) FROM public.document_types) = 4 AND (SELECT count(*) FROM public.company_kinds) = 1, 'OBJ catalogs');
  RAISE NOTICE 'PASS ① 100: المفتاح مطفأ، المستودع خاص (10MB) وبلا سياسة تخزين، نتيجة الفحص لمفتاح الخدمة وحده، والكتالوج 4 أنواع ونوع شركة واحد';
END $$;
\i migrations/_rollback/100_company_documents.down.sql
DO $$ BEGIN
  PERFORM t.ok(t.schema_digest() = (SELECT s.v FROM t.saved s WHERE s.k = 'schema0')
           AND NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'company-documents'), 'RB schema + bucket');
  RAISE NOTICE 'PASS ①ب التراجع: حرفيًا كما قبل 100 (والمستودع محذوف)';
END $$;
\i migrations/100_company_documents.sql
\i migrations/100_company_documents.sql
SET search_path = public, extensions;

-- ══ ② المفتاح مطفأ ═══════════════════════════════════════════════════════
DO $$ BEGIN
  PERFORM t.ok(t.err(t.u('OA'), 'public.document_upload_begin(''tax_card'', ''application/pdf'', 1000, null, gen_random_uuid())') = '0A000', 'OFF begin');
  PERFORM t.ok((t.call(t.u('OA'), 'public.company_documents_mine()') ->> 'enabled')::boolean = false, 'OFF listing says disabled');
  RAISE NOTICE 'PASS ② المفتاح مطفأ: لا رفع';
END $$;

-- ══ ③ الرفع ══════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; r2 jsonb; k uuid := gen_random_uuid(); v uuid; p text;
BEGIN
  PERFORM t.sw('company_documents_enabled', true);
  PERFORM t.ok(t.err(t.u('AS'), 'public.document_upload_begin(''tax_card'', ''application/pdf'', 1000, null, gen_random_uuid())') = '42501', 'UP supervisor no');
  PERFORM t.ok(t.err(t.u('A1'), 'public.document_upload_begin(''tax_card'', ''application/pdf'', 1000, null, gen_random_uuid())') = '42501', 'UP customer no');
  PERFORM t.ok(t.err(t.u('OA'), 'public.document_upload_begin(''passport'', ''application/pdf'', 1000, null, gen_random_uuid())') = '22023', 'UP unknown type');
  PERFORM t.ok(t.err(t.u('OA'), 'public.document_upload_begin(''tax_card'', ''application/zip'', 1000, null, gen_random_uuid())') = '22023', 'UP mime');
  PERFORM t.ok(t.err(t.u('OA'), 'public.document_upload_begin(''tax_card'', ''application/pdf'', 10485761, null, gen_random_uuid())') = '22023', 'UP > 10MB');
  r := t.begin_doc('OA', 'commercial_registration', 'application/pdf', 1000, k);
  v := (r #>> '{version,id}')::uuid; p := r #>> '{upload,path}';
  PERFORM t.ok(r #>> '{upload,bucket}' = 'company-documents' AND p LIKE t.u('CA')::text || '/%' AND r #>> '{version,status}' = 'uploading', 'UP begin server path');
  r2 := t.begin_doc('OA', 'commercial_registration', 'application/pdf', 1000, k);
  PERFORM t.ok(r2 #>> '{version,id}' = v::text, 'UP idempotent');
  PERFORM t.ok(t.err(t.u('OA'), format('public.document_upload_begin(''commercial_registration'', ''application/pdf'', 999, null, %L::uuid)', k)) = '23505', 'UP same key other file');
  -- التأكيد: الملف المخزَّن نفسه
  PERFORM t.ok(t.errfull(t.u('OA'), format('public.document_upload_commit(%L::uuid, %L)', v, t.sha('cr-v1'))) LIKE '55000|%object_missing%', 'COMMIT object missing');
  PERFORM t.put_object(p, 1001);
  PERFORM t.ok(t.err(t.u('OA'), format('public.document_upload_commit(%L::uuid, %L)', v, t.sha('cr-v1'))) = '22023', 'COMMIT size mismatch');
  DELETE FROM storage.objects WHERE name = p;
  PERFORM t.put_object(p, 1000);
  PERFORM t.ok(t.err(t.u('OA'), format('public.document_upload_commit(%L::uuid, ''nothex'')', v)) = '22023', 'COMMIT sha required');
  PERFORM t.ok(t.err(t.u('OB'), format('public.document_upload_commit(%L::uuid, %L)', v, t.sha('cr-v1'))) = 'P0002', 'COMMIT not uploader');
  PERFORM t.ok(t.call(t.u('OA'), format('public.document_upload_commit(%L::uuid, %L)', v, t.sha('cr-v1'))) ->> 'status' = 'pending_scan', 'COMMIT ok');
  PERFORM t.ok(t.call(t.u('OA'), format('public.document_upload_commit(%L::uuid, %L)', v, t.sha('cr-v1'))) ->> 'status' = 'pending_scan', 'COMMIT idempotent');
  INSERT INTO t.saved VALUES ('cr_v1', v), ('cr_doc', (SELECT document_id FROM public.company_document_versions WHERE id = v));
  RAISE NOTICE 'PASS ③ الرفع: مدير الشركة وحده، النوع والحجم (≤ 10MB)، مسار يولّده الخادم، منع التكرار، والتأكيد يفحص الملف المخزَّن وبصمته';
END $$;

-- ══ ④ العزل حتى الفحص ═══════════════════════════════════════════════════
DO $$
DECLARE v uuid := (SELECT s.v FROM t.saved s WHERE s.k = 'cr_v1')::uuid;
BEGIN
  PERFORM t.ok(t.errfull(t.u('OA'), format('public.document_download_authorize(%L::uuid)', v)) LIKE '55000|%', 'Q download company admin');
  PERFORM t.ok(t.own_err(format('public.document_download_authorize(%L::uuid)', v)) = '55000', 'Q download owner');
  PERFORM t.ok(t.own_err(format('public.document_review(%L::uuid, true, null, ''2030-01-01'')', v)) = '55000', 'Q review owner');
  PERFORM t.ctx(null);
  PERFORM t.ok(t.err(t.u('OA'), format('public.document_scan_result(%L::uuid, ''clean'', ''clamav'')', v)) = '42501', 'Q scan result not for users');
  PERFORM t.ok(t.err(t.u('OA'), 'public.document_scan_queue()') = '42501', 'Q queue not for users');
  PERFORM t.ok(public.document_scan_queue() -> 0 ->> 'version_id' = v::text, 'Q queue lists pending');
  PERFORM t.ok(public.document_scan_result(v, 'clean', 'clamav-test') ->> 'status' = 'clean', 'Q scan clean (service)');
  PERFORM t.ok(public.document_scan_result(v, 'clean', 'clamav-test') ->> 'changed' = 'false', 'Q scan idempotent');
  PERFORM t.ok(t.err_super_ok(format('select public.document_scan_result(%L, ''infected'', ''clamav-test'')', v)) = '55000', 'Q scan final');
  PERFORM t.ok((SELECT status FROM public.company_documents WHERE id = (SELECT s.v FROM t.saved s WHERE s.k = 'cr_doc')::uuid) = 'pending_review', 'Q doc pending review');
  RAISE NOTICE 'PASS ④ العزل: لا تنزيل ولا مراجعة قبل نتيجة نظيفة (حتى لمالك المنصة)؛ النتيجة لمفتاح الخدمة وحده، متكررة بلا أثر، ونهائية';
END $$;

-- ══ ⑤ التنزيل والمراجعة ═════════════════════════════════════════════════
DO $$
DECLARE v uuid := (SELECT s.v FROM t.saved s WHERE s.k = 'cr_v1')::uuid; d uuid := (SELECT s.v FROM t.saved s WHERE s.k = 'cr_doc')::uuid;
        r jsonb; k uuid := gen_random_uuid(); v2 uuid;
BEGIN
  r := t.call(t.u('OA'), format('public.document_download_authorize(%L::uuid)', v));
  PERFORM t.ok(r ->> 'bucket' = 'company-documents' AND (r ->> 'expires_in')::int = 60, 'DL company admin, 60s');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.company_document_events WHERE version_id = v AND action = 'download_authorized' AND actor_id = t.u('OA')), 'DL audited');
  PERFORM t.ok(t.err(t.u('OB'), format('public.document_download_authorize(%L::uuid)', v)) = 'P0002', 'DL other company');
  PERFORM t.ok(t.err(t.u('AD'), format('public.document_download_authorize(%L::uuid)', v)) = 'P0002', 'DL admin not assigned');
  PERFORM t.ok(t.err(t.u('AS'), format('public.document_download_authorize(%L::uuid)', v)) = 'P0002', 'DL company staff');
  PERFORM t.ok(t.own_err(format('public.document_review(%L::uuid, true, null)', v)) = '22023', 'REV expiry required');
  PERFORM t.ok(t.err(t.u('OA'), format('public.document_review(%L::uuid, true, null, ''2030-01-01'')', v)) = 'P0002', 'REV company admin cannot review');
  PERFORM t.ok(t.own(format('public.document_review(%L::uuid, true, null, ''2030-01-01'')', v)) ->> 'status' = 'approved', 'REV owner approves');
  PERFORM t.ctx(null);
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.notifications WHERE user_id = t.u('OA') AND title = 'تم اعتماد مستند'), 'REV notified');
  PERFORM t.ok(t.err_super_ok(format('update public.company_document_versions set sha256 = %L where id = %L', t.sha('x'), v)) = '23514', 'IMM content');
  PERFORM t.ok(t.err_super_ok(format('update public.company_document_versions set review_status = ''rejected'' where id = %L', v)) = '55000', 'IMM decision');
  -- إصدار بديل مصاب: يُرفض آليًا ويبقى معزولًا
  r := t.begin_doc('OA', 'commercial_registration', 'application/pdf', 2000, k);
  v2 := (r #>> '{version,id}')::uuid;
  PERFORM t.ok((r #>> '{version,version_no}')::int = 2, 'VER 2');
  PERFORM t.put_object(r #>> '{upload,path}', 2000);
  PERFORM t.call(t.u('OA'), format('public.document_upload_commit(%L::uuid, %L)', v2, t.sha('cr-v2')));
  PERFORM public.document_scan_result(v2, 'infected', 'clamav-test', '{"signature":"Eicar-Test"}');
  PERFORM t.ok((SELECT review_status FROM public.company_document_versions WHERE id = v2) = 'rejected'
           AND (SELECT status FROM public.company_documents WHERE id = d) = 'rejected', 'VER infected rejected');
  PERFORM t.ok(t.err(t.u('OA'), format('public.document_download_authorize(%L::uuid)', v2)) = '55000', 'VER infected not downloadable');
  -- مراجعة ذاتية ممنوعة: مالك المنصة يرفع لشركته ولا يراجع ملفه
  PERFORM t.ctx('company_admin');
  r := t.call(t.u('OW'), format('public.document_upload_begin(''tax_card'', ''image/png'', 500, null, %L::uuid)', gen_random_uuid()));
  PERFORM t.ctx(null);
  PERFORM t.ok(r IS NOT NULL, 'SELF owner uploads for own company');
  PERFORM t.put_object(r #>> '{upload,path}', 500);
  PERFORM t.ctx('company_admin');
  PERFORM t.call(t.u('OW'), format('public.document_upload_commit(%L::uuid, %L)', r #>> '{version,id}', t.sha('w-tax')));
  PERFORM public.document_scan_result((r #>> '{version,id}')::uuid, 'clean', 'clamav-test');
  PERFORM t.ok(t.own_err(format('public.document_review(%L::uuid, true, null, ''2030-01-01'')', r #>> '{version,id}')) = '42501', 'REV no self review');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ⑤ التنزيل والمراجعة: مدير الشركة ومالك المنصة فقط، 60 ثانية ومسجَّل؛ لا شركة أخرى ولا إداري غير مسند ولا موظف؛ تاريخ الانتهاء إلزامي؛ المحتوى والقرار ثابتان؛ الإصدار المصاب مرفوض ومعزول؛ لا مراجعة ذاتية';
END $$;

-- ══ ⑥ المراجع المسند ═════════════════════════════════════════════════════
DO $$
DECLARE unit uuid; r jsonb; k uuid := gen_random_uuid(); v uuid; dtax uuid;
BEGIN
  -- مستند ثانٍ لشركة أ: البطاقة الضريبية (نظيف، بانتظار المراجعة)
  r := t.begin_doc('OA', 'tax_card', 'image/jpeg', 700, k);
  v := (r #>> '{version,id}')::uuid;
  PERFORM t.put_object(r #>> '{upload,path}', 700);
  PERFORM t.call(t.u('OA'), format('public.document_upload_commit(%L::uuid, %L)', v, t.sha('a-tax')));
  PERFORM public.document_scan_result(v, 'clean', 'clamav-test');
  dtax := (SELECT document_id FROM public.company_document_versions WHERE id = v);
  -- الهيكل: وحدة تضم أ، وتفويض مراجعة لـ AD
  unit := (t.own('public.owner_unit_create(''مراجعة المستندات'')') ->> 'unit_id')::uuid;
  PERFORM t.own(format('public.owner_assign_company_unit(%L::uuid, %L::uuid, ''إسناد لوحدة المراجعة'')', t.u('CA'), unit));
  PERFORM t.ok(t.own_err(format('public.owner_assign_document_reviewer(%L::uuid, %L::uuid, null, ''إسناد بلا تفويض'')', dtax, t.u('AD'))) = '22023', 'ASSIGN needs delegation');
  PERFORM t.own(format('public.owner_grant_delegation(%L::uuid, %L::uuid, array[''documents.review''], ''مراجعة مستندات الوحدة'')', t.u('AD'), unit));
  PERFORM t.own(format('public.owner_assign_document_reviewer(%L::uuid, %L::uuid, null, ''إسناد المراجعة لـ AD'')', dtax, t.u('AD')));
  PERFORM t.ctx(null);
  -- المفتاح delegation_enabled مطفأ: لا شيء
  PERFORM t.ok(t.call(t.u('AD'), 'public.reviewer_documents()') = '[]'::jsonb, 'RV delegation switch off');
  PERFORM t.sw('delegation_enabled', true);
  r := t.call(t.u('AD'), 'public.reviewer_documents()');
  PERFORM t.ok(jsonb_array_length(r) = 1 AND r -> 0 ->> 'id' = dtax::text AND jsonb_array_length(r -> 0 -> 'versions') = 1, 'RV only assigned, current version');
  PERFORM t.ok(t.err(t.u('AD'), format('public.document_download_authorize(%L::uuid)', v)) = 'ok', 'RV download assigned');
  PERFORM t.ok(t.err(t.u('AD'), format('public.document_download_authorize(%L::uuid)', (SELECT s.v FROM t.saved s WHERE s.k = 'cr_v1'))) = 'P0002', 'RV not other doc');
  PERFORM t.ok(t.call(t.u('SUP'), 'public.reviewer_documents()') = '[]'::jsonb, 'RV others none');
  PERFORM t.ok(t.call(t.u('AD'), format('public.document_review(%L::uuid, false, ''الصورة غير واضحة، ارفع نسخة أوضح'')', v)) ->> 'status' = 'rejected', 'RV reviewer rejects with reason');
  PERFORM t.ok(t.err(t.u('AD'), format('public.document_review(%L::uuid, true, null, ''2031-01-01'')', v)) = '55000', 'RV decision final');
  -- سحب التفويض = لا وصول فورًا
  PERFORM t.own(format('public.owner_revoke_delegation(%L::uuid, ''انتهت المراجعة'')',
                       (SELECT id FROM public.platform_delegations WHERE delegate_id = t.u('AD') AND revoked_at IS NULL)));
  PERFORM t.ctx(null);
  PERFORM t.ok(t.call(t.u('AD'), 'public.reviewer_documents()') = '[]'::jsonb, 'RV revoked');
  RAISE NOTICE 'PASS ⑥ المراجع: بتفويض documents.review على وحدة الشركة والمفتاحين، يرى المسند إليه وإصداره الحالي وحده، يرفض بسبب، القرار نهائي، والسحب فوري';
END $$;

-- ══ ⑦ البيانات الإدارية، الانتهاء، الحجز والاحتفاظ ═══════════════════════
DO $$
DECLARE d uuid := (SELECT s.v FROM t.saved s WHERE s.k = 'cr_doc')::uuid; r jsonb; n int; hold uuid; nv int;
BEGIN
  PERFORM t.ok(t.own_err(format('public.owner_document_metadata(%L::uuid, ''{"owner_phone":"x"}'', ''تعديل غير مسموح'')', d)) = '22023', 'META keys');
  r := t.own(format('public.owner_document_metadata(%L::uuid, ''{"number":"CR-7788","expires_on":"2026-10-01"}'', ''تصحيح رقم السجل وتاريخه'')', d));
  PERFORM t.ok(r #>> '{metadata,number}' = 'CR-7788', 'META merged');
  PERFORM t.ok(EXISTS (SELECT 1 FROM public.company_document_events WHERE document_id = d AND action = 'metadata_changed'
                         AND detail #>> '{new,number}' = 'CR-7788' AND detail -> 'old' = '{}'::jsonb), 'META history');
  PERFORM t.ctx(null);
  -- الانتهاء: المستند معتمد بتاريخ مضى ← expired + إشعار؛ التشغيل الثاني بلا تكرار
  UPDATE public.company_documents SET status = 'approved' WHERE id = d;
  n := (SELECT count(*) FROM public.notifications WHERE user_id = t.u('OA') AND title = 'انتهى مستند');
  PERFORM t.ok((public.document_expiry_scan('2026-10-14') ->> 'expired')::int = 1, 'EXP expired');
  PERFORM t.ok((SELECT status FROM public.company_documents WHERE id = d) = 'expired'
           AND (SELECT count(*) FROM public.notifications WHERE user_id = t.u('OA') AND title = 'انتهى مستند') = n + 1, 'EXP notified');
  PERFORM t.ok((public.document_expiry_scan('2026-10-14') ->> 'expired')::int = 0, 'EXP once');
  PERFORM t.ok(t.err(t.u('OA'), 'public.document_expiry_scan()') = '42501', 'EXP not for company');
  -- الاحتفاظ: v1 مستبدل قديم، v2 مصاب قديم ← مرشحان؛ الحجز القانوني يستثنيهما؛ لا حذف إطلاقًا
  UPDATE public.company_document_versions SET reviewed_at = now() - interval '6 years' WHERE id = (SELECT s.v FROM t.saved s WHERE s.k = 'cr_v1')::uuid;
  UPDATE public.company_document_versions SET scanned_at = now() - interval '40 days', reviewed_at = now() - interval '40 days'
   WHERE document_id = d AND version_no = 2;
  nv := (SELECT count(*) FROM public.company_document_versions);
  r := t.own('public.owner_retention_dry_run()');
  PERFORM t.ok(r ->> 'dry_run' = 'true' AND jsonb_array_length(r -> 'would_delete') = 2 AND (r ->> 'held')::int = 0, 'RET candidates ' || r::text);
  hold := (t.own(format('public.owner_legal_hold_set(%L::uuid, null, ''نزاع قائم مع الشركة'')', t.u('CA'))) ->> 'hold_id')::uuid;
  r := t.own('public.owner_retention_dry_run()');
  PERFORM t.ok(jsonb_array_length(r -> 'would_delete') = 0 AND (r ->> 'held')::int = 2, 'RET hold excludes');
  PERFORM t.own(format('public.owner_legal_hold_release(%L::uuid, ''انتهى النزاع بالتسوية'')', hold));
  PERFORM t.ctx(null);
  PERFORM t.ok((SELECT count(*) FROM public.company_document_versions) = nv AND (SELECT count(*) FROM public.retention_runs) = 2, 'RET nothing deleted, runs logged');
  PERFORM t.ok(t.err(t.u('EA'), 'public.owner_retention_dry_run()') = '42501', 'RET owner only');
  PERFORM t.ok(t.err_super_ok('delete from public.company_document_events') = '23514'
           AND t.err_super_ok('delete from public.company_document_versions') = '23514'
           AND t.err_super_ok('update public.retention_runs set candidates = 0') = '23514', 'INV append-only, no delete');
  RAISE NOTICE 'PASS ⑦ بيانات المالك بسجل قبل/بعد ومفاتيح محددة؛ الانتهاء يُعلَّم ويُبلَّغ مرة واحدة؛ الاحتفاظ تجربة جافة تستثني الحجز القانوني ولا تحذف شيئًا؛ السجلات إلحاقية';
END $$;

-- ══ ⑧ رفض التراجع ═══════════════════════════════════════════════════════
\set rbsql `cat migrations/_rollback/100_company_documents.down.sql`
SELECT set_config('t.rbsql', :'rbsql', false) IS NOT NULL;
DO $$
BEGIN
  UPDATE public.platform_feature_switches SET enabled = false;
  BEGIN
    EXECUTE current_setting('t.rbsql');
    RAISE EXCEPTION 'FAIL RB allowed with documents';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%مرفوض%' THEN RAISE; END IF;
  END;
  PERFORM t.ok(to_regclass('public.company_documents') IS NOT NULL, 'RB kept');
  RAISE NOTICE 'PASS ⑧ التراجع مرفوض مع وجود مستندات أو سجلها';
END $$;

SELECT 'ALL company-documents tests passed';
