-- ============================================================================
-- 142_trial_request_notification على نسخة مطابقة للإنتاج + 118 + 119
--   + 133 + 135 + 137
--
--   الفحص المسبق (موثّق): 137 بلا إشعار أصلًا — request_saas_trial يُدرج
--   في saas_trial_requests وحده، و owner/trials.html بلا جرس/شارة، وجرس
--   المالك يقرأ notifications ولا صف يُنشأ لطلب تجربة. 142 يسدّها على
--   القناة القائمة نفسها (notifications + جرس لوحة المالك).
--
--   ⓪ 142 مرتين: قابل لإعادة التشغيل، ودالة الإشعار موجودة وداخلية،
--      والطلب يناديها، وضمانات 137 باقية في النسخة المستبدَلة
--   ① الطلب يُشعر مالك المنصة: صف واحد له وحده، بالشركة والباقة العربية
--      وتاريخ الطلب ورابط صفحة الموافقة ومرجع الطلب — ويقرأه هو نفسه
--      عبر RLS كما يقرأه جرس لوحته (user_id = هو)
--   ② الطلب الفاشل (مكرر معلّق / غير مالك الشركة) لا يُشعر أحدًا
--   ③ الإلغاء لا يُشعر المالك؛ وإعادة الطلب بعد الإلغاء تُشعر مرة جديدة
--   ④ التراجع يعيد الطلب بلا إشعار ويعمل؛ وإعادة التطبيق تعيد الإشعار
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
SET client_min_messages = warning;

\i tests/fixtures/ecommerce/chain.sql

CREATE OR REPLACE FUNCTION t.sv(p_k text) RETURNS text LANGUAGE sql AS $$ select v from t.saved where k = p_k $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

\i migrations/118_ecommerce_store_accounts.sql
\i migrations/119_shopify_store_integration.sql
\i migrations/133_owner_store_price_and_sync_actions.sql
\i migrations/135_owner_store_plan_deactivate_pause_sync.sql
\i migrations/137_saas_trial_3_days.sql
\i migrations/142_trial_request_notification.sql
\i migrations/142_trial_request_notification.sql
SET search_path = public, extensions;

-- ══ ⓪ إعادة التطبيق والدوال والصلاحيات ═════════════════════════════════
DO $$
DECLARE v_def text;
BEGIN
  PERFORM t.ok(to_regprocedure('public._trial_request_notify_owners(uuid)') is not null, '⓪ دالة الإشعار الداخلية');
  PERFORM t.ok(to_regprocedure('public.request_saas_trial(text)') is not null, '⓪ request_saas_trial بعد 142');
  v_def := pg_get_functiondef('public.request_saas_trial(text)'::regprocedure);
  PERFORM t.ok(v_def like '%_trial_request_notify_owners%', '⓪ الطلب ينادي دالة الإشعار');
  PERFORM t.ok(v_def like '%current_company_id%' and v_def like '%user_id <> auth.uid()%', '⓪ بوابات 137 باقية في الطلب');
  PERFORM t.ok(v_def not like '%insert into public.whatsapp_subscriptions%', '⓪ الطلب ما زال بلا إنشاء اشتراك');
  v_def := pg_get_functiondef('public._trial_request_notify_owners(uuid)'::regprocedure);
  PERFORM t.ok(v_def like '%insert into public.notifications%', '⓪ الإشعار في جدول notifications القائم');
  PERFORM t.ok(v_def like '%platform_authority%' and v_def like '%''owner''%' and v_def like '%platform_owner%', '⓪ الإشعار لمالك المنصة');
  PERFORM t.ok(v_def like '%/owner/trials.html%', '⓪ رابط صفحة الموافقة');
  PERFORM t.ok(v_def like '%''subscription''%', '⓪ تصنيف subscription');
  PERFORM t.ok(v_def like '%reference_id%', '⓪ مرجع الطلب');
  PERFORM t.ok(v_def like '%company_name%' and v_def like '%name_ar%', '⓪ الشركة والباقة العربية في النص');
  PERFORM t.ok(has_function_privilege('authenticated', 'public.request_saas_trial(text)', 'EXECUTE'), '⓪ الطلب لـ authenticated');
  PERFORM t.ok(not has_function_privilege('anon', 'public.request_saas_trial(text)', 'EXECUTE'), '⓪ الطلب ليس لـ anon');
  PERFORM t.ok(not has_function_privilege('authenticated', 'public._trial_request_notify_owners(uuid)', 'EXECUTE'), '⓪ دالة الإشعار داخلية — ليست لـ authenticated');
  PERFORM t.ok(not has_function_privilege('anon', 'public._trial_request_notify_owners(uuid)', 'EXECUTE'), '⓪ دالة الإشعار داخلية — ليست لـ anon');
  PERFORM t.ok((select count(*) from public.notifications where title = 'طلب تجربة مجانية جديد') = 0, '⓪ بلا إشعار تجربة قبل أي طلب');
  RAISE NOTICE 'PASS ⓪ 142 قابل لإعادة التشغيل؛ الإشعار داخلي على القناة القائمة، وضمانات 137 باقية';
END $$;

-- ══ ① الطلب يُشعر مالك المنصة ═════════════════════════════════════════
DO $$
DECLARE
  r jsonb;
  v_req uuid;
  v_n int;
  v_msg text;
  v_expected_ts text;
BEGIN
  r := t.call(t.u('OA'), 'public.request_saas_trial(''ultimate'')');
  PERFORM t.ok((r->>'status') = 'pending' and (r->>'plan_key') = 'ultimate', '① طلب ultimate معلّق من OA');
  v_req := (r->>'id')::uuid;
  INSERT INTO t.saved VALUES ('req142_OA_ult', v_req::text);
  -- صف واحد لمالك المنصة وحده، بكل الحقول المتعاقد عليها
  SELECT count(*) INTO v_n FROM public.notifications
   WHERE user_id = t.u('OW') AND title = 'طلب تجربة مجانية جديد' AND reference_id = v_req;
  PERFORM t.ok(v_n = 1, '① إشعار واحد لمالك المنصة عن الطلب');
  SELECT message INTO v_msg FROM public.notifications
   WHERE user_id = t.u('OW') AND reference_id = v_req;
  PERFORM t.ok(v_msg like '%شركة أ%', '① نص الإشعار يحمل اسم الشركة');
  PERFORM t.ok(v_msg like '%الخطة الفائقة%', '① نص الإشعار يحمل الباقة العربية');
  SELECT to_char(requested_at at time zone 'Africa/Cairo', 'YYYY-MM-DD HH24:MI')
    INTO v_expected_ts FROM public.saas_trial_requests WHERE id = v_req;
  PERFORM t.ok(v_msg like '%' || v_expected_ts || '%', '① نص الإشعار يحمل تاريخ الطلب');
  PERFORM t.ok(exists (select 1 from public.notifications
                       where user_id = t.u('OW') and reference_id = v_req
                         and link = '/owner/trials.html' and category = 'subscription'
                         and type = 'info' and is_read = false),
               '① الرابط والتصنيف والنوع وغير المقروء كما تعاقدنا');
  -- صاحب الطلب نفسه لا يصله إشعار عن طلبه
  SELECT count(*) INTO v_n FROM public.notifications
   WHERE user_id = t.u('OA') AND reference_id = v_req;
  PERFORM t.ok(v_n = 0, '① صاحب الشركة لا يُشعر عن طلبه هو');
  -- المالك يقرأ الإشعار بهويته هو عبر RLS — كما يقرأه جرس لوحته
  -- (notifications-service.js: eq user_id = المستخدم الحالي)
  r := t.call(t.u('OW'), format('select count(*) from public.notifications where user_id = %L and reference_id = %L', t.u('OW'), v_req));
  PERFORM t.ok((r::text)::int = 1, '① المالك يرى الإشعار بهويته عبر RLS (مسار الجرس نفسه)');
  -- عضو شركة أخرى لا يرى إشعار المالك
  r := t.call(t.u('OB'), format('select count(*) from public.notifications where user_id = %L and reference_id = %L', t.u('OW'), v_req));
  PERFORM t.ok((r::text)::int = 0, '① مالك شركة أخرى لا يرى إشعار المالك');
  RAISE NOTICE 'PASS ① طلب التجربة يُشعر مالك المنصة وحده، بالشركة والباقة والتاريخ ورابط الموافقة';
END $$;

-- ══ ② الطلب الفاشل لا يُشعر أحدًا ═════════════════════════════════════
DO $$
DECLARE v_n int;
BEGIN
  PERFORM t.ok(t.err(t.u('OA'), 'public.request_saas_trial(''ultimate'')') = '22023', '② طلب معلّق مكرر مرفوض');
  PERFORM t.ok(t.err(t.u('A1'), 'public.request_saas_trial(''ultimate'')') = '42501', '② عضو شركة ليس مالكها مرفوض');
  PERFORM t.ok(t.err(t.u('OA'), 'public.request_saas_trial(''whatsapp'')') = '22023', '② باقة ليست من باقات التجربة مرفوضة');
  SELECT count(*) INTO v_n FROM public.notifications WHERE title = 'طلب تجربة مجانية جديد';
  PERFORM t.ok(v_n = 1, '② الطلبات الفاشلة لم تنشئ أي إشعار جديد');
  RAISE NOTICE 'PASS ② الفشل قبل الإدراج = بلا إشعار';
END $$;

-- ══ ③ الإلغاء بلا إشعار؛ وإعادة الطلب تُشعر من جديد ═══════════════════
DO $$
DECLARE
  r jsonb;
  v_req uuid;
  v_n int;
BEGIN
  r := t.call(t.u('OA'), format('public.cancel_saas_trial(%L)', t.sv('req142_OA_ult')));
  PERFORM t.ok((r->>'status') = 'cancelled', '③ إلغاء الطلب المعلق من صاحبه');
  SELECT count(*) INTO v_n FROM public.notifications WHERE title = 'طلب تجربة مجانية جديد';
  PERFORM t.ok(v_n = 1, '③ الإلغاء لم يُشعر المالك');
  r := t.call(t.u('OA'), 'public.request_saas_trial(''ultimate'')');
  PERFORM t.ok((r->>'status') = 'pending', '③ طلب جديد بعد الإلغاء');
  v_req := (r->>'id')::uuid;
  INSERT INTO t.saved VALUES ('req142_OA_ult2', v_req::text);
  SELECT count(*) INTO v_n FROM public.notifications
   WHERE user_id = t.u('OW') AND title = 'طلب تجربة مجانية جديد' AND reference_id = v_req;
  PERFORM t.ok(v_n = 1, '③ إعادة الطلب أشعرت المالك مرة جديدة عن الطلب الجديد');
  SELECT count(*) INTO v_n FROM public.notifications WHERE title = 'طلب تجربة مجانية جديد';
  PERFORM t.ok(v_n = 2, '③ إشعاران إجمالًا: الطلب الأول وإعادة الطلب — بلا تكرار');
  RAISE NOTICE 'PASS ③ الإلغاء صامت؛ وإعادة الطلب تُشعر عن الطلب الجديد وحده';
END $$;

-- ══ ④ التراجع وإعادة التطبيق ═════════════════════════════════════════
\i migrations/_rollback/142_trial_request_notification.down.sql
SET search_path = public, extensions;
DO $$
DECLARE
  r jsonb;
  v_req uuid;
  v_n int;
  v_def text;
BEGIN
  PERFORM t.ok(to_regprocedure('public._trial_request_notify_owners(uuid)') is null, '④ دالة الإشعار حُذفت بالتراجع');
  PERFORM t.ok(to_regprocedure('public.request_saas_trial(text)') is not null, '④ دالة الطلب باقية بعد التراجع');
  v_def := pg_get_functiondef('public.request_saas_trial(text)'::regprocedure);
  PERFORM t.ok(v_def not like '%_trial_request_notify_owners%', '④ نسخة الطلب بعد التراجع بلا نداء إشعار');
  PERFORM t.ok(v_def like '%current_company_id%' and v_def not like '%insert into public.whatsapp_subscriptions%', '④ نسخة 137 سليمة بعد التراجع');
  -- الطلب يعمل بلا إشعار (OB لم يطلب ultimate بعد في هذا الملف)
  r := t.call(t.u('OB'), 'public.request_saas_trial(''ultimate'')');
  PERFORM t.ok((r->>'status') = 'pending', '④ الطلب يعمل بعد التراجع');
  v_req := (r->>'id')::uuid;
  INSERT INTO t.saved VALUES ('req142_OB_ult', v_req::text);
  SELECT count(*) INTO v_n FROM public.notifications WHERE title = 'طلب تجربة مجانية جديد';
  PERFORM t.ok(v_n = 2, '④ بعد التراجع: طلب جديد بلا إشعار — عدّاد الإشعارات ثابت');
  PERFORM t.ok((select count(*) from public.saas_trial_requests where id = v_req) = 1, '④ طلب التراجع نفسه محفوظ');
END $$;
\i migrations/142_trial_request_notification.sql
SET search_path = public, extensions;
DO $$
DECLARE
  r jsonb;
  v_req uuid;
  v_n int;
BEGIN
  PERFORM t.ok(to_regprocedure('public._trial_request_notify_owners(uuid)') is not null, '④ دالة الإشعار عادت');
  PERFORM t.ok(pg_get_functiondef('public.request_saas_trial(text)'::regprocedure) like '%_trial_request_notify_owners%', '④ الطلب ينادي الإشعار مجددًا');
  r := t.call(t.u('OB'), format('public.cancel_saas_trial(%L)', t.sv('req142_OB_ult')));
  PERFORM t.ok((r->>'status') = 'cancelled', '④ إلغاء طلب التراجع');
  r := t.call(t.u('OB'), 'public.request_saas_trial(''ultimate'')');
  PERFORM t.ok((r->>'status') = 'pending', '④ طلب جديد بعد إعادة التطبيق');
  v_req := (r->>'id')::uuid;
  SELECT count(*) INTO v_n FROM public.notifications
   WHERE user_id = t.u('OW') AND title = 'طلب تجربة مجانية جديد' AND reference_id = v_req;
  PERFORM t.ok(v_n = 1, '④ إعادة التطبيق: الإشعار يصل للمالك مجددًا');
  SELECT count(*) INTO v_n FROM public.notifications WHERE title = 'طلب تجربة مجانية جديد';
  PERFORM t.ok(v_n = 3, '④ ثلاثة إشعارات إجمالًا — واحد لكل طلب ناجح');
  RAISE NOTICE 'PASS ④ التراجع يعيد الطلب بلا إشعار، وإعادة التطبيق تعيد الإشعار';
  RAISE NOTICE 'ALL 142 TRIAL REQUEST NOTIFICATION TESTS PASSED';
END $$;
