-- ============================================================================
-- طلب حساب شركة مستقل من خارج مسار الشراء (138) — على نسخة مطابقة للإنتاج
--
--   ⓪ قبل 138: بصمات 118 للدوال التي يعيد 138 تعريفها
--   ① 138 مرتين: الكائنات والقيود، ومسار الشراء بلا تغيير
--   ② مسار الشراء القديم كما هو (صف purchase، نوع company، بلا إثبات)
--   ③ شركة مستقلة: بلا مستند مرفوضة، وبالمستند تمر ولا شركة قبل الموافقة
--   ④ متجر/منصة: بلا رابط مرفوضة، وبرابط غير صالح مرفوضة، وبرابط تمر
--   ⑤ أخرى: بلا شيء تمر، وبأي إثبات مرفوضة؛ وخلط الإثبات مرفوض
--   ⑥ قيد الجدول نفسه يرد التجاوز المباشر (بلا دالة)
--   ⑦ الإدارة ترى النوع والرابط والمستند، وتنزيل المستند للإدارة وحدها
--   ⑧ الموافقة القائمة تنشئ شركة company (لا متجرًا)؛ والرفض يحرر المتقدم
--   ⑨ التراجع يعيد تعريف 118، ثم إعادة التطبيق
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
SET client_min_messages = warning;

\i tests/fixtures/ecommerce/chain.sql

CREATE FUNCTION t.fn_md5(p regprocedure) RETURNS text LANGUAGE sql AS $$ select md5(pg_get_functiondef(p)) $$;
CREATE FUNCTION t.s(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  select (case p when 'ST' then '5a000000-0000-4000-8000-000000000001' when 'SX' then '5b000000-0000-4000-8000-000000000001'
                 when 'NC' then '5c000000-0000-4000-8000-000000000001' end)::uuid $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

INSERT INTO auth.users (id, email, email_confirmed_at)
SELECT t.s(n), lower(n) || '@store.test', now() - interval '30 days' FROM unnest(array['ST','SX','NC']) n;
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at) VALUES
  (t.s('ST'), 'st@store.test', 'تاجر', 'user', '01200000001', '2026-09-01'),
  (t.s('SX'), 'sx@store.test', 'تاجر آخر', 'user', '01200000002', '2026-09-01'),
  (t.s('NC'), 'nc@store.test', 'شركة جديدة', 'user', '01200000003', '2026-09-01');

-- ══ ⓪ بصمات 118 ═══════════════════════════════════════════════════════════
DO $$
BEGIN
  PERFORM t.ok(t.fn_md5('public.my_company_account_request()') = '91666c394648d9e09fb823f7f0dd3d76', '⓪ my_company_account_request = 118');
  PERFORM t.ok(t.fn_md5('public.admin_list_company_account_requests()') = '4ae5f2572f0b05f3a16ce79ba781c2bb', '⓪ admin_list = 118');
  PERFORM t.ok(t.fn_md5('public.submit_company_account_request(text,text,date,text,text,text,text)') = '7d4e444c1b07a17d3467ea9328ce68ec', '⓪ submit القديمة = الإنتاج');
  RAISE NOTICE 'PASS ⓪ النسخة مطابقة لـ 118 في الدوال التي يمسّها 138';
END $$;

-- ══ ① 138 مرتين ═══════════════════════════════════════════════════════════
\i migrations/118_ecommerce_store_accounts.sql
\i migrations/138_standalone_company_account_request.sql
\i migrations/138_standalone_company_account_request.sql
SET search_path = public, extensions;

DO $$
BEGIN
  PERFORM t.ok(t.fn_md5('public.my_company_account_request()') <> '91666c394648d9e09fb823f7f0dd3d76', '① my_company_account_request أُعيد تعريفها');
  PERFORM t.ok(t.fn_md5('public.admin_list_company_account_requests()') <> '4ae5f2572f0b05f3a16ce79ba781c2bb', '① admin_list أُعيد تعريفها');
  PERFORM t.ok(t.fn_md5('public.submit_company_account_request(text,text,date,text,text,text,text)') = '7d4e444c1b07a17d3467ea9328ce68ec', '① دالة الشراء لم تُلمس');
  PERFORM t.ok(to_regprocedure('public.submit_standalone_company_account_request(text,text,date,text,text,text,text,uuid)') is not null, '① الدالة المستقلة موجودة');
  PERFORM t.ok(to_regprocedure('public.company_account_request_proof_begin(uuid,text,integer,text,uuid)') is not null, '① begin موجودة');
  PERFORM t.ok(to_regprocedure('public.company_account_request_proof_commit_server(uuid,uuid,text)') is not null, '① commit موجودة');
  PERFORM t.ok(to_regprocedure('public.admin_company_account_request_proof_download(uuid)') is not null, '① download موجودة');
  PERFORM t.ok(exists (select 1 from pg_constraint where conname = 'company_account_requests_standalone_proof_check'), '① قيد الإثبات المشروط موجود');
  PERFORM t.ok(not has_function_privilege('authenticated', 'public.company_account_request_proof_commit_server(uuid,uuid,text)', 'execute'), '① التأكيد بمفتاح الخدمة وحده');
  RAISE NOTICE 'PASS ① 138 مطبق مرتين بلا تغيير في مسار الشراء';
END $$;

-- ══ ② مسار الشراء القديم كما هو ═══════════════════════════════════════════
DO $$
DECLARE r jsonb; v_req uuid;
BEGIN
  r := t.call(t.s('NC'), 'public.submit_company_account_request(''شركة جديدة'', ''CR-NC-138'', ''2030-01-01'', null, null, null, null)');
  v_req := (r->>'id')::uuid;
  PERFORM t.ok((select request_source = 'purchase' and applicant_type = 'company'
                  and website_url is null and proof_document_path is null
                  from public.company_account_requests where id = v_req), '② صف الشراء: purchase/company بلا إثبات');
  -- الرفض يحرر NC لاختبارات لاحقة (الموافقة كانت ستحوله شركة)
  r := t.call(t.u('AD'), format('public.admin_review_company_account_request(%L, ''reject'', %L)', v_req, 'رفض اختباري لتحرير الحساب'));
  PERFORM t.ok(r->>'status' = 'rejected', '② الرفض يحرر المتقدم');
  RAISE NOTICE 'PASS ② مسار الشراء القديم كما هو';
END $$;

-- ══ ③ شركة مستقلة: المستند شرط ═══════════════════════════════════════════
DO $$
DECLARE
  r jsonb;
  v_req uuid;
  v_token uuid := '11111111-2222-4333-8444-555555555501';
  v_key uuid := '11111111-2222-4333-8444-555555555502';
  v_sha text := repeat('a', 64);
BEGIN
  -- بلا مستند: مرفوضة برسالة عربية، ولا صف يُترك
  PERFORM t.ok(t.errfull(t.s('ST'), 'public.submit_standalone_company_account_request(''شركتي'', ''CR-ST-138'', ''2030-01-01'', null, null, ''company'', null, null)') like '%مستند الإثبات مطلوب%',
               '③ شركة بلا مستند مرفوضة');
  PERFORM t.ok(not exists (select 1 from public.company_account_requests where user_id = t.s('ST')), '③ الرفض لا يترك طلبًا');

  -- رفع الإثبات: begin بهوية المتقدم، ثم commit بمفتاح الخدمة
  r := t.call(t.s('ST'), format('public.company_account_request_proof_begin(%L, ''application/pdf'', 1024, ''سجل.pdf'', %L)', v_token, v_key));
  PERFORM t.ok((r->'upload'->>'bucket') = 'company-documents' and (r->'upload'->>'path') like 'request-proofs/%', '③ begin يولّد مسارًا في المستودع الخاص');
  PERFORM t.ok((r->>'status') = 'uploading', '③ حالة الرفع uploading');
  SET LOCAL ROLE service_role;
  r := public.company_account_request_proof_commit_server(v_token, t.s('ST'), v_sha);
  RESET ROLE;
  PERFORM t.ok((r->>'status') = 'uploaded' and (r->>'sha256') = v_sha, '③ commit يسجّل البصمة');

  -- الإرسال بالرمز: يمر، بلا شركة، وبلا باقة
  r := t.call(t.s('ST'), format('public.submit_standalone_company_account_request(''شركتي'', ''CR-ST-138'', ''2030-01-01'', null, null, ''company'', null, %L)', v_token));
  v_req := (r->>'id')::uuid;
  PERFORM t.ok((r->>'applicant_type') = 'company', '③ الرد يذكر النوع');
  PERFORM t.ok((select request_source = 'standalone' and applicant_type = 'company'
                  and proof_document_path like 'request-proofs/%'
                  and proof_document_mime = 'application/pdf' and proof_document_size = 1024
                  and proof_document_sha256 = v_sha and website_url is null and requested_plan is null
                  from public.company_account_requests where id = v_req), '③ الصف مستقل بمستنده وبلا باقة');
  PERFORM t.ok(not exists (select 1 from public.companies where user_id = t.s('ST')), '③ لا شركة قبل الموافقة');
  PERFORM t.ok((select status from public.company_account_request_proof_uploads where proof_token = v_token) = 'attached', '③ الرفع المرحلي ارتبط بالطلب');
  -- الرمز المستعمل لا يُعاد: طلب ثانٍ به مرفوض (طلب معلّق أصلًا)
  PERFORM t.ok(t.err(t.s('ST'), format('public.submit_standalone_company_account_request(''شركة2'', ''CR-ST2-138'', ''2030-01-01'', null, null, ''company'', null, %L)', v_token)) <> 'ok', '③ طلب ثانٍ معلّق مرفوض');
  INSERT INTO t.saved VALUES ('st_req', v_req::text);
  RAISE NOTICE 'PASS ③ شركة مستقلة بالمستند: تمر بلا تفعيل قبل الموافقة';
END $$;

-- ══ ④ متجر/منصة: الرابط شرط ══════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_req uuid;
BEGIN
  PERFORM t.ok(t.errfull(t.s('SX'), 'public.submit_standalone_company_account_request(''متجري'', ''CR-SX-138'', ''2030-01-01'', null, null, ''store'', null, null)') like '%رابط الموقع أو المتجر مطلوب%',
               '④ متجر بلا رابط مرفوض');
  PERFORM t.ok(t.errfull(t.s('SX'), 'public.submit_standalone_company_account_request(''متجري'', ''CR-SX-138'', ''2030-01-01'', null, null, ''store'', ''not a url'', null)') like '%رابط غير صالح%',
               '④ رابط غير صالح مرفوض');
  PERFORM t.ok(t.errfull(t.s('SX'), 'public.submit_standalone_company_account_request(''متجري'', ''CR-SX-138'', ''2030-01-01'', null, null, ''platform'', ''ftp://x.com'', null)') like '%رابط غير صالح%',
               '④ مخطط غير http(s) مرفوض');

  r := t.call(t.s('SX'), 'public.submit_standalone_company_account_request(''متجري'', ''CR-SX-138'', ''2030-01-01'', null, null, ''store'', ''https://my-store.com'', null)');
  v_req := (r->>'id')::uuid;
  PERFORM t.ok((select request_source = 'standalone' and applicant_type = 'store'
                  and website_url = 'https://my-store.com' and proof_document_path is null
                  from public.company_account_requests where id = v_req), '④ صف المتجر برابطه وبلا مستند');
  -- آخر طلب للمنادي يحمل الحقول الجديدة
  PERFORM t.ok((t.call(t.s('SX'), 'public.my_company_account_request()')->>'website_url') = 'https://my-store.com', '④ my_ يرجع الرابط');
  PERFORM t.ok((t.call(t.s('SX'), 'public.my_company_account_request()')->>'applicant_type') = 'store', '④ my_ يرجع النوع');
  -- والإدارة تراه في القائمة
  PERFORM t.ok((select (x->>'applicant_type') = 'store' and (x->>'website_url') = 'https://my-store.com'
                  and (x->>'request_source') = 'standalone'
                  from jsonb_array_elements(t.call(t.u('AD'), 'public.admin_list_company_account_requests()')) x
                 where (x->>'id')::uuid = v_req), '④ الإدارة ترى النوع والرابط والمصدر');
  INSERT INTO t.saved VALUES ('sx_req', v_req::text);
  RAISE NOTICE 'PASS ④ متجر برابط صالح: يمر ويظهر في قائمة الإدارة';
END $$;

-- ══ ⑤ أخرى + خلط الإثبات ═════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_req uuid;
BEGIN
  -- NC (تحرر في ②) يرسل «أخرى» بلا شيء: يمر
  r := t.call(t.s('NC'), 'public.submit_standalone_company_account_request(''مبادرة'', ''CR-NC2-138'', ''2030-01-01'', null, null, ''other'', null, null)');
  v_req := (r->>'id')::uuid;
  PERFORM t.ok((select applicant_type = 'other' and website_url is null and proof_document_path is null
                  from public.company_account_requests where id = v_req), '⑤ أخرى بلا إثبات تمر');
  -- «أخرى» برابط مرفوضة — لكن NC معلّق الآن، فالرفض المتوقع من قاعدة
  -- الإثبات لا من قاعدة التكرار: نتحقق بالرسالة لا بالرمز وحده
  PERFORM t.ok(t.errfull(t.s('NC'), 'public.submit_standalone_company_account_request(''مبادرة2'', ''CR-NC3-138'', ''2030-01-01'', null, null, ''other'', ''https://x.com'', null)') like '%لا يحتاج مستندًا ولا رابطًا%',
               '⑤ أخرى برابط مرفوضة قبل فحص التكرار');
  -- نوع مجهول مرفوض
  PERFORM t.ok(t.errfull(t.s('SX'), 'public.submit_standalone_company_account_request(''متجر'', ''CR-SX2-138'', ''2030-01-01'', null, null, ''???'', null, null)') like '%نوع متقدم غير معروف%',
               '⑤ نوع مجهول مرفوض');
  -- شركة برابط (بلا مستند) مرفوضة برسالة الإثبات لا التكرار
  PERFORM t.ok(t.errfull(t.s('SX'), 'public.submit_standalone_company_account_request(''شركة'', ''CR-SX3-138'', ''2030-01-01'', null, null, ''company'', ''https://x.com'', null)') like '%يُثبَت بمستند، لا برابط%',
               '⑤ شركة برابط مرفوضة');
  INSERT INTO t.saved VALUES ('nc_req', v_req::text);
  RAISE NOTICE 'PASS ⑤ أخرى وخلط الإثبات مرفوضان بالرسائل العربية';
END $$;

-- ══ ⑥ قيد الجدول يرد التجاوز المباشر ═════════════════════════════════════
DO $$
DECLARE v_ok boolean;
BEGIN
  -- إدراج مباشر بدور الخدمة لطلب مستقل شركة بلا مستند ⇒ قيد 23514
  BEGIN
    SET LOCAL ROLE service_role;
    insert into public.company_account_requests
      (user_id, company_name, commercial_registration_number, commercial_registration_expiry,
       request_source, applicant_type)
    values (t.u('NOPE'), 'تجاوز', 'CR-DIRECT-1', '2030-01-01', 'standalone', 'company');
    RESET ROLE;
    v_ok := false;
  EXCEPTION WHEN check_violation THEN
    RESET ROLE;
    v_ok := true;
  END;
  PERFORM t.ok(v_ok, '⑥ إدراج مستقل شركة بلا مستند يصطدم بالقيد');

  BEGIN
    SET LOCAL ROLE service_role;
    insert into public.company_account_requests
      (user_id, company_name, commercial_registration_number, commercial_registration_expiry,
       request_source, applicant_type)
    values (t.u('NOPE'), 'تجاوز', 'CR-DIRECT-2', '2030-01-01', 'standalone', 'store');
    RESET ROLE;
    v_ok := false;
  EXCEPTION WHEN check_violation THEN
    RESET ROLE;
    v_ok := true;
  END;
  PERFORM t.ok(v_ok, '⑥ إدراج مستقل متجر بلا رابط يصطدم بالقيد');

  BEGIN
    SET LOCAL ROLE service_role;
    insert into public.company_account_requests
      (user_id, company_name, commercial_registration_number, commercial_registration_expiry,
       request_source, applicant_type, website_url)
    values (t.u('NOPE'), 'تجاوز', 'CR-DIRECT-3', '2030-01-01', 'standalone', 'other', 'https://x.com');
    RESET ROLE;
    v_ok := false;
  EXCEPTION WHEN check_violation THEN
    RESET ROLE;
    v_ok := true;
  END;
  PERFORM t.ok(v_ok, '⑥ إدراج مستقل أخرى برابط يصطدم بالقيد');
  PERFORM t.ok(not exists (select 1 from public.company_account_requests where user_id = t.u('NOPE')), '⑥ لا صفوف تجاوز باقية');
  RAISE NOTICE 'PASS ⑥ قيد الجدول يفرض الإثبات المشروط بلا دالة';
END $$;

-- ══ ⑦ تنزيل المستند للإدارة وحدها ════════════════════════════════════════
DO $$
DECLARE r jsonb; v_req uuid := (select v::uuid from t.saved where k = 'st_req');
BEGIN
  PERFORM t.ok(t.err(t.s('ST'), format('public.admin_company_account_request_proof_download(%L)', v_req)) = '42501', '⑦ صاحب الطلب لا ينزّل إثباته');
  r := t.call(t.u('AD'), format('public.admin_company_account_request_proof_download(%L)', v_req));
  PERFORM t.ok((r->>'bucket') = 'company-documents' and (r->>'path') like 'request-proofs/%', '⑦ الإدارة تأخذ المسار');
  PERFORM t.ok((r->>'file_name') = 'سجل.pdf', '⑦ الإدارة تأخذ اسم الملف');
  PERFORM t.ok(t.err(t.u('AD'), format('public.admin_company_account_request_proof_download(%L)', '00000000-0000-4000-8000-000000000099')) = 'P0002', '⑦ طلب غير موجود');
  -- طلب بلا مستند (متجر SX) بلا تنزيل
  PERFORM t.ok(t.err(t.u('AD'), format('public.admin_company_account_request_proof_download(%L)', (select v::uuid from t.saved where k = 'sx_req'))) = 'P0002', '⑦ طلب بلا مستند بلا تنزيل');
  RAISE NOTICE 'PASS ⑦ تنزيل الإثبات للإدارة وحدها';
END $$;

-- ══ ⑧ الموافقة القائمة تنشئ شركة company؛ والرفض يحرر ═══════════════════
DO $$
DECLARE
  r jsonb;
  v_req uuid := (select v::uuid from t.saved where k = 'st_req');
  v_company uuid;
  v_sx uuid := (select v::uuid from t.saved where k = 'sx_req');
BEGIN
  -- الموافقة على طلب ST (شركة مستقلة) تنشئ شركة بنوع المنظمة الافتراضي
  r := t.call(t.u('AD'), format('public.admin_review_company_account_request(%L, ''approve'')', v_req));
  v_company := (r->>'company_id')::uuid;
  PERFORM t.ok((select account_kind from public.companies where id = v_company) = 'company', '⑧ موافقة المستقل تنشئ company');
  PERFORM t.ok((select status from public.company_account_requests where id = v_req) = 'approved', '⑧ الطلب approved');
  PERFORM t.ok((select proof_document_path from public.company_account_requests where id = v_req) like 'request-proofs/%', '⑧ المستند باقٍ على الصف بعد الموافقة');
  -- رفض طلب SX (متجر) يحرره لطلب جديد
  r := t.call(t.u('AD'), format('public.admin_review_company_account_request(%L, ''reject'', %L)', v_sx, 'نحتاج توضيحًا'));
  PERFORM t.ok(r->>'status' = 'rejected', '⑧ الرفض يسجَّل');
  r := t.call(t.s('SX'), 'public.submit_standalone_company_account_request(''منصتي'', ''CR-SX4-138'', ''2030-01-01'', null, null, ''platform'', ''https://my-platform.io'', null)');
  PERFORM t.ok((r->>'applicant_type') = 'platform', '⑧ بعد الرفض يقدر يرسل طلبًا جديدًا (منصة)');
  RAISE NOTICE 'PASS ⑧ الموافقة تنشئ company والرفض يحرر المتقدم';
END $$;

-- ══ ⑨ التراجع يعيد تعريف 118، ثم إعادة التطبيق ═══════════════════════════
-- ملاحظة: بصمتا 118 هنا هما بصمتا تعريفي ملف 118 نفسه (لا بصمتي ما قبل 118
-- في ⓪ — تعريفا الملف يختلفان عن نسخة الإنتاج في التنسيق فقط).
\i migrations/_rollback/138_standalone_company_account_request.down.sql
SET search_path = public, extensions;

DO $$
BEGIN
  PERFORM t.ok(to_regprocedure('public.submit_standalone_company_account_request(text,text,date,text,text,text,text,uuid)') is null, '⑨ الدالة المستقلة زالت');
  PERFORM t.ok(to_regprocedure('public.company_account_request_proof_begin(uuid,text,integer,text,uuid)') is null, '⑨ begin زالت');
  PERFORM t.ok(not exists (select 1 from information_schema.columns
                            where table_schema = 'public' and table_name = 'company_account_requests'
                              and column_name = 'applicant_type'), '⑨ الأعمدة زالت');
  PERFORM t.ok(t.fn_md5('public.my_company_account_request()') = 'e5571e4398c8c18ad2c255925aab56e2', '⑨ my_ عاد لـ 118');
  PERFORM t.ok(t.fn_md5('public.admin_list_company_account_requests()') = '6212bb1079fb1a596f4e37deee62d903', '⑨ admin_list عاد لـ 118');
  RAISE NOTICE 'PASS ⑨ التراجع يعيد تعريف 118';
END $$;

\i migrations/138_standalone_company_account_request.sql
SET search_path = public, extensions;

DO $$
BEGIN
  PERFORM t.ok(to_regprocedure('public.submit_standalone_company_account_request(text,text,date,text,text,text,text,uuid)') is not null, '⑨ إعادة التطبيق تعيد الدالة');
  -- SX (تحرر وله طلب منصة معلّق من ⑧) — نرفضه أولًا ثم طلب «أخرى» يمر
  PERFORM t.ok((t.call(t.u('AD'), format('public.admin_review_company_account_request(%L, ''reject'', %L)',
    (select id from public.company_account_requests where user_id = t.s('SX') and status = 'pending'), 'رفض اختباري'))->>'status') = 'rejected', '⑨ رفض طلب المنصة المعلّق');
  PERFORM t.ok((t.call(t.s('SX'), 'public.submit_standalone_company_account_request(''مبادرة'', ''CR-SX5-138'', ''2030-01-01'', null, null, ''other'', null, null)')->>'applicant_type') = 'other', '⑨ بعد إعادة التطبيق: أخرى تمر');
  RAISE NOTICE 'PASS ⑨ التراجع وإعادة التطبيق';
  RAISE NOTICE 'ALL PASS: المدخل المستقل لطلب حساب شركة (138)';
END $$;
