-- ============================================================================
-- 137_saas_trial_3_days على نسخة مطابقة للإنتاج + 118 + 119 + 133 + 135
--
--   ⓪ 137 مرتين: قابل لإعادة التشغيل، وبلا عمود دفع/بطاقة، و RLS مفعّلة
--   ① الطلب: مالك الشركة وحده، وباقة صالحة ومفعّلة، وبلا مكرر معلّق،
--      وبلا اشتراك مدفوع قائم، وstore للمتاجر فقط — ولا اشتراك يُنشأ هنا
--   ② قرار المالك: الرفض بسبب مسجَّل بلا اشتراك؛ الموافقة تبدأ 3 أيام
--      بالضبط على الحساب الحي (بلا دفع وبلا دورة فوترة وبلا تجديد)
--   ③ الانتهاء: الامتياز يتوقف عند end_date، و expire_saas_trials يقلب
--      الطلب والاشتراك إلى expired، ولا تجربة ثانية ولا اشتراك مدفوع
--   ④ تجربة المتجر: باقة store بعد تفعيلها، على متجر إلكتروني فقط
--   ⑤ التراجع يعيد التطبيق؛ واشتراك التجربة يبقى حتى انتهائه (موثّق)
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
SET client_min_messages = warning;

\i tests/fixtures/ecommerce/chain.sql

CREATE OR REPLACE FUNCTION t.s(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  select (case p
    when 'S7' then '5e000000-0000-4000-8000-000000000007'
  end)::uuid $$;
CREATE OR REPLACE FUNCTION t.h(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;
CREATE OR REPLACE FUNCTION t.sv(p_k text) RETURNS text LANGUAGE sql AS $$ select v from t.saved where k = p_k $$;
-- نداء بدور service_role (للوظيفة المجدولة)
CREATE OR REPLACE FUNCTION t.svc(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
declare v jsonb;
begin
  perform t.act(null);
  execute 'set local role service_role';
  execute 'select to_jsonb((' || p_sql || '))' into v;
  execute 'reset role';
  return coalesce(v, 'null'::jsonb);
exception when others then
  execute 'reset role';
  raise;
end $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

\i migrations/118_ecommerce_store_accounts.sql
\i migrations/119_shopify_store_integration.sql
\i migrations/133_owner_store_price_and_sync_actions.sql
\i migrations/135_owner_store_plan_deactivate_pause_sync.sql
\i migrations/137_saas_trial_3_days.sql
\i migrations/137_saas_trial_3_days.sql
SET search_path = public, extensions;

-- ── متجر تاجر جديد (S7) بلا اشتراك ───────────────────────────────────────
INSERT INTO auth.users (id, email, email_confirmed_at)
VALUES (t.s('S7'), 's7@store.test', now() - interval '30 days');
INSERT INTO public.profiles (id, email, full_name, role, phone, created_at) VALUES
  (t.s('S7'), 's7@store.test', 'تاجر ز', 'user', '01200000007', '2026-09-01');
DO $$
DECLARE r jsonb;
BEGIN
  r := t.call(t.s('S7'), format('public.submit_store_account_request(%L, %L, ''2030-01-01'')', 'متجر S7', 'CR-S7-137'));
  r := t.call(t.u('AD'), format('public.admin_review_company_account_request(%L, ''approve'')', r->>'id'));
  INSERT INTO t.saved VALUES ('co_S7', r->>'company_id');
  PERFORM t.ok((select account_kind from public.companies where id = (r->>'company_id')::uuid) = 'ecommerce_store', 'HARNESS شركة S7 متجر إلكتروني');
END $$;

-- ══ ⓪ إعادة التطبيق والجدول والصلاحيات ═════════════════════════════════
DO $$
BEGIN
  PERFORM t.ok(to_regprocedure('public.request_saas_trial(text)') is not null, '⓪ request_saas_trial');
  PERFORM t.ok(to_regprocedure('public.cancel_saas_trial(uuid)') is not null, '⓪ cancel_saas_trial');
  PERFORM t.ok(to_regprocedure('public.my_saas_trial_status()') is not null, '⓪ my_saas_trial_status');
  PERFORM t.ok(to_regprocedure('public.owner_list_saas_trial_requests(text)') is not null, '⓪ owner_list_saas_trial_requests');
  PERFORM t.ok(to_regprocedure('public.owner_decide_saas_trial(uuid,text,text)') is not null, '⓪ owner_decide_saas_trial');
  PERFORM t.ok(to_regprocedure('public.expire_saas_trials()') is not null, '⓪ expire_saas_trials');
  PERFORM t.ok((select relrowsecurity from pg_class where relname = 'saas_trial_requests'), '⓪ RLS مفعّلة');
  PERFORM t.ok((select count(*) from information_schema.columns
                 where table_schema = 'public' and table_name = 'saas_trial_requests'
                   and (column_name like '%card%' or column_name like '%payment%'
                        or column_name like '%sandbox%')) = 0, '⓪ بلا عمود دفع/بطاقة في الجدول');
  PERFORM t.ok(exists (select 1 from pg_constraint where conname = 'saas_trial_requests_three_days_check'), '⓪ قيد 3 أيام');
  PERFORM t.ok(exists (select 1 from pg_indexes where indexname = 'saas_trial_requests_one_pending'), '⓪ فهرس المعلّق الواحد');
  PERFORM t.ok(has_function_privilege('authenticated', 'public.request_saas_trial(text)', 'EXECUTE'), '⓪ الطلب لـ authenticated');
  PERFORM t.ok(not has_function_privilege('anon', 'public.request_saas_trial(text)', 'EXECUTE'), '⓪ الطلب ليس لـ anon');
  PERFORM t.ok(not has_function_privilege('authenticated', 'public.expire_saas_trials()', 'EXECUTE'), '⓪ الانتهاء ليس لـ authenticated');
  PERFORM t.ok(has_function_privilege('service_role', 'public.expire_saas_trials()', 'EXECUTE'), '⓪ الانتهاء لـ service_role');
  RAISE NOTICE 'PASS ⓪ 137 قابل لإعادة التشغيل؛ الجدول بلا دفع و RLS مفعّلة';
END $$;

-- ══ ① الطلب: البوابات والرفض قبل الإنشاء ═══════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  -- فرد بلا شركة، وعضو شركة ليس مالكها، ومالك شركة بباقة غير صالحة
  PERFORM t.ok(t.err(t.u('PU'), 'public.request_saas_trial(''ultimate'')') = '42501', '① فرد بلا شركة');
  PERFORM t.ok(t.err(t.u('A1'), 'public.request_saas_trial(''ultimate'')') = '42501', '① عضو شركة ليس مالكها');
  PERFORM t.ok(t.err(t.u('OA'), 'public.request_saas_trial(''whatsapp'')') = '22023', '① باقة ليست من باقات التجربة');
  -- OA لديه support مدفوع فعّال: تجربة support مرفوضة، و ultimate مقبولة
  PERFORM t.ok(t.err(t.u('OA'), 'public.request_saas_trial(''support'')') = '22023', '① اشتراك مدفوع قائم يمنع التجربة');
  PERFORM t.ok(t.err(t.u('OA'), 'public.request_saas_trial(''store'')') = '22023', '① باقة المتاجر ليست لشركة عادية');
  r := t.call(t.u('OA'), 'public.request_saas_trial(''ultimate'')');
  PERFORM t.ok((r->>'status') = 'pending' and (r->>'plan_key') = 'ultimate'
               and (r->>'company_name') = 'شركة أ' and (r->>'trial_starts_at') is null
               and (r->>'subscription_id') is null, '① طلب ultimate معلّق بلا بداية وبلا اشتراك');
  INSERT INTO t.saved VALUES ('req_OA_ult', r->>'id');
  PERFORM t.ok(t.err(t.u('OA'), 'public.request_saas_trial(''ultimate'')') = '22023', '① طلب معلّق مكرر مرفوض');
  PERFORM t.ok((select count(*) from public.whatsapp_subscriptions
                 where company_id = t.u('CA') and plan = 'ultimate') = 0, '① الطلب لم ينشئ أي اشتراك');
  -- متجر S7: باقة store غير مفعّلة بعد (118 يزرعها غير مفعّلة بلا سعرين)
  PERFORM t.ok(t.err(t.s('S7'), 'public.request_saas_trial(''store'')') = '22023', '① باقة غير مفعّلة لا تُطلب');
  -- المالك يفعّل باقة المتاجر 500/5000 من مسار 135 (إجراء يدوي — ليس من 137)
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  r := t.call(t.u('OW'), 'public.owner_set_store_plan_price(500, 5000, true)');
  PERFORM t.ok((r->>'is_active')::boolean, '① تفعيل باقة المتاجر 500/5000 للاختبار');
  PERFORM t.ctx(null);
  r := t.call(t.s('S7'), 'public.request_saas_trial(''store'')');
  PERFORM t.ok((r->>'status') = 'pending' and (r->>'plan_key') = 'store', '① طلب store معلّق من المتجر');
  INSERT INTO t.saved VALUES ('req_S7_store', r->>'id');
  -- OB يطلب ultimate ثم يلغيه، ثم يطلبه مجددًا (الإلغاء لا يحرق التجربة)
  r := t.call(t.u('OB'), 'public.request_saas_trial(''ultimate'')');
  INSERT INTO t.saved VALUES ('req_OB_ult', r->>'id');
  r := t.call(t.u('OB'), format('public.cancel_saas_trial(%L)', r->>'id'));
  PERFORM t.ok((r->>'status') = 'cancelled', '① إلغاء الطلب المعلق من صاحبه');
  PERFORM t.ok(t.err(t.u('OB'), format('public.cancel_saas_trial(%L)', t.sv('req_OB_ult'))) = '22023', '① إلغاء الملغي مرفوض');
  PERFORM t.ok(t.err(t.u('OA'), format('public.cancel_saas_trial(%L)', t.sv('req_OB_ult'))) = '42501', '① إلغاء طلب شركة أخرى مرفوض');
  r := t.call(t.u('OB'), 'public.request_saas_trial(''ultimate'')');
  PERFORM t.ok((r->>'status') = 'pending', '① طلب جديد بعد الإلغاء');
  INSERT INTO t.saved VALUES ('req_OB_ult2', r->>'id');
  RAISE NOTICE 'PASS ① بوابات الطلب: المالك وحده، وباقة مفعّلة، وبلا مكرر، وبلا اشتراك من الطلب';
END $$;

-- ══ ② قرار المالك: رفض بسبب، وموافقة تبدأ 3 أيام ═══════════════════════
DO $$
DECLARE r jsonb; v_sub uuid; v_req uuid := t.sv('req_OA_ult')::uuid;
BEGIN
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  PERFORM t.ok(t.err(t.u('AD'), 'public.owner_list_saas_trial_requests()') = '42501', '② القائمة للمالك وحده');
  r := t.call(t.u('OW'), 'public.owner_list_saas_trial_requests()');
  PERFORM t.ok(jsonb_array_length(r) = 4, '② أربعة طلبات في القائمة (3 معلّقة + ملغاة)');
  PERFORM t.ok((select count(*) from jsonb_array_elements(r) e where e->>'status' = 'pending') = 3, '② ثلاثة طلبات معلّقة في القائمة');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_decide_saas_trial(%L, ''maybe'', null)', v_req)) = '22023', '② قرار ليس موافقة/رفضًا');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_decide_saas_trial(%L, ''rejected'', ''قصير'')', t.sv('req_OB_ult2'))) = '22023', '② رفض بسبب قصير');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_decide_saas_trial(%L, ''rejected'', null)', t.sv('req_OB_ult2'))) = '22023', '② رفض بلا سبب');
  r := t.call(t.u('OW'), format('public.owner_decide_saas_trial(%L, ''rejected'', ''رفض تجربة للاختبار فقط'')', t.sv('req_OB_ult2')));
  PERFORM t.ok((r->>'status') = 'rejected' and (r->>'subscription_id') is null
               and (r->>'decision_reason') = 'رفض تجربة للاختبار فقط', '② رفض بسبب مسجَّل وبلا اشتراك');
  PERFORM t.ok((select count(*) from public.whatsapp_subscriptions
                 where company_id = t.u('CB') and plan = 'ultimate') = 0, '② الرفض لم ينشئ اشتراكًا');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_decide_saas_trial(%L, ''approved'', null)', t.sv('req_OB_ult2'))) = '22023', '② قرار على غير معلّق');
  -- الموافقة على طلب OA: تبدأ الآن وتنتهي بعد 3 أيام بالضبط
  r := t.call(t.u('OW'), format('public.owner_decide_saas_trial(%L, ''approved'', ''موافقة تجربة للاختبار'')', v_req));
  PERFORM t.ok((r->>'status') = 'approved' and (r->>'subscription_id') is not null
               and (r->>'is_trial_active')::boolean and (r->>'days_remaining')::int = 3, '② موافقة: تجربة جارية 3 أيام');
  PERFORM t.ok((r->>'trial_ends_at')::timestamptz - (r->>'trial_starts_at')::timestamptz = interval '3 days', '② النهاية = البداية + 3 أيام بالضبط');
  v_sub := (r->>'subscription_id')::uuid;
  INSERT INTO t.saved VALUES ('sub_OA_ult', v_sub::text);
  PERFORM t.ok((select plan from public.whatsapp_subscriptions where id = v_sub) = 'ultimate', '② اشتراك التجربة على الباقة المطلوبة');
  PERFORM t.ok((select status from public.whatsapp_subscriptions where id = v_sub) = 'active', '② اشتراك التجربة فعّال');
  PERFORM t.ok((select duration_days from public.whatsapp_subscriptions where id = v_sub) = 3, '② مدة الاشتراك 3 أيام');
  PERFORM t.ok((select payment_method from public.whatsapp_subscriptions where id = v_sub) is null, '② بلا طريقة دفع محفوظة');
  PERFORM t.ok((select billing_cycle from public.whatsapp_subscriptions where id = v_sub) is null, '② بلا دورة فوترة');
  PERFORM t.ok((select price_snapshot->>'trial' from public.whatsapp_subscriptions where id = v_sub) = 'true', '② علامة trial في اللقطة');
  PERFORM t.ok((select (price_snapshot->>'amount')::numeric from public.whatsapp_subscriptions where id = v_sub) = 0, '② مبلغ التجربة 0');
  PERFORM t.ok((select (price_snapshot->>'no_auto_renew')::boolean from public.whatsapp_subscriptions where id = v_sub), '② بلا تجديد تلقائي');
  PERFORM t.ok((select (price_snapshot->>'no_payment_method')::boolean from public.whatsapp_subscriptions where id = v_sub), '② بلا طريقة دفع في اللقطة');
  PERFORM t.ok((select end_date - start_date from public.whatsapp_subscriptions where id = v_sub) = interval '3 days', '② صف الاشتراك 3 أيام بالضبط');
  PERFORM t.ok(exists (select 1 from public.subscription_audit_log
                       where subscription_id = v_sub and action = 'trial_started'), '② بدء التجربة مدقَّق');
  PERFORM t.ok(exists (select 1 from public.privileged_audit where action = 'trial.approved'
                       and (new_value->>'subscription_id')::uuid = v_sub), '② الموافقة مدقَّقة');
  PERFORM t.ok(exists (select 1 from public.privileged_audit where action = 'trial.rejected'), '② الرفض مدقَّق');
  -- حالة الشركة بعد الموافقة: تجربة جارية، ولا باقة مؤهلة جديدة
  r := t.call(t.u('OA'), 'public.my_saas_trial_status()');
  PERFORM t.ok((r->>'can_request')::boolean, '② حالة الشركة: مالكها يستطيع الطلب');
  PERFORM t.ok((r->'active_trial'->>'plan_key') = 'ultimate', '② حالة الشركة: التجربة الجارية ultimate');
  PERFORM t.ok((select count(*) from jsonb_array_elements(r->'eligible_plans') e
                 where (e->>'eligible')::boolean) = 0, '② لا باقة مؤهلة بعد الموافقة (support مدفوعة، ultimate مستخدمة، store ليست لشركة)');
  PERFORM t.ok(t.err(t.u('OA'), 'public.request_saas_trial(''ultimate'')') = '22023', '② طلب ثانٍ لنفس الباقة مرفوض');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ② الرفض بسبب بلا اشتراك؛ والموافقة تبدأ 3 أيام على الحساب الحي بلا دفع';
END $$;

-- ══ ③ الانتهاء: يتوقف الامتياز، ويُقلب الطلب والاشتراك، ولا تجربة ثانية ═
DO $$
DECLARE r jsonb; v_sub uuid := t.sv('sub_OA_ult')::uuid; v_req uuid := t.sv('req_OA_ult')::uuid;
BEGIN
  -- الامتياز قبل الانتهاء: unlimited_tickets ميزة ultimate وحدها لدى OA
  -- (support لا تمنحها) — والقاعدة تحسبها من الصف الفعّال نفسه.
  PERFORM t.ok('unlimited_tickets' = any(public.owned_feature_keys(t.u('OA'))), '③ قبل الانتهاء: امتياز الباقة ممنوح');
  -- تمرير الزمن: بداية التجربة قبل 3 أيام وساعة، ونهايتها قبل ساعة
  UPDATE public.whatsapp_subscriptions
     SET start_date = now() - interval '3 days 1 hour', end_date = now() - interval '1 hour'
   WHERE id = v_sub;
  UPDATE public.saas_trial_requests
     SET trial_starts_at = now() - interval '3 days 1 hour', trial_ends_at = now() - interval '1 hour'
   WHERE id = v_req;
  -- الامتياز توقف لحظة الانتهاء حتى قبل قلب الحالة (end_date > now شرطه)
  PERFORM t.ok(not ('unlimited_tickets' = any(public.owned_feature_keys(t.u('OA')))), '③ بعد الانتهاء: الامتياز مسحوب قبل قلب الحالة');
  PERFORM t.ok((select status from public.whatsapp_subscriptions where id = v_sub) = 'active'
               and (select end_date from public.whatsapp_subscriptions where id = v_sub) < now(), '③ الصف ما زال active لكن مدته انقضت');
  r := t.call(t.u('OA'), 'public.my_saas_trial_status()');
  PERFORM t.ok((r->>'active_trial') is null, '③ بعد الانتهاء: لا تجربة جارية في الحالة');
  -- الوظيفة المجدولة (service_role): تقلب الاشتراك والطلب
  r := t.svc('public.expire_saas_trials()');
  PERFORM t.ok((r->>'expired_requests')::int = 1, '③ وظيفة الانتهاء قلبت طلبًا واحدًا');
  PERFORM t.ok((select status from public.saas_trial_requests where id = v_req) = 'expired', '③ الطلب expired');
  PERFORM t.ok((select status from public.whatsapp_subscriptions where id = v_sub) = 'expired', '③ الاشتراك expired');
  PERFORM t.ok(exists (select 1 from public.notifications where user_id = t.u('OA')
                       and title = 'انتهى اشتراكك'), '③ إشعار الانتهاء وصل لصاحب الشركة');
  -- لا اشتراك مدفوع تولّد من الانتهاء، ولا تجربة ثانية
  PERFORM t.ok((select count(*) from public.whatsapp_subscriptions
                 where company_id = t.u('CA') and plan = 'ultimate') = 1, '③ اشتراك ultimate واحد فقط — بلا تحويل لمدفوع');
  PERFORM t.ok(t.err(t.u('OA'), 'public.request_saas_trial(''ultimate'')') = '22023', '③ تجربة ثانية لنفس الباقة مرفوضة بعد الانتهاء');
  r := t.svc('public.expire_saas_trials()');
  PERFORM t.ok((r->>'expired_requests')::int = 0, '③ إعادة الانتهاء بلا أثر (idempotent)');
  RAISE NOTICE 'PASS ③ الانتهاء يوقف الامتياز ويقلب الطلب والاشتراك، بلا تجديد وبلا تجربة ثانية';
END $$;

-- ══ ④ تجربة المتجر ═════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_sub uuid;
BEGIN
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  r := t.call(t.u('OW'), format('public.owner_decide_saas_trial(%L, ''approved'', null)', t.sv('req_S7_store')));
  PERFORM t.ok((r->>'status') = 'approved' and (r->>'plan_key') = 'store'
               and (r->>'trial_ends_at')::timestamptz - (r->>'trial_starts_at')::timestamptz = interval '3 days', '④ موافقة تجربة المتجر 3 أيام');
  v_sub := (r->>'subscription_id')::uuid;
  PERFORM t.ok((select company_id from public.whatsapp_subscriptions where id = v_sub) = t.sv('co_S7')::uuid, '④ اشتراك التجربة على شركة المتجر');
  PERFORM t.ok((select (price_snapshot->>'trial')::boolean from public.whatsapp_subscriptions where id = v_sub), '④ علامة trial على اشتراك المتجر');
  PERFORM t.ok((select payment_method from public.whatsapp_subscriptions where id = v_sub) is null, '④ تجربة المتجر بلا طريقة دفع');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ④ تجربة باقة المتاجر على المتجر الإلكتروني بعد تفعيلها';
END $$;

-- ══ ⑤ التراجع وإعادة التطبيق ═══════════════════════════════════════════
\i migrations/_rollback/137_saas_trial_3_days.down.sql
DO $$
BEGIN
  PERFORM t.ok(to_regprocedure('public.request_saas_trial(text)') is null, '⑤ دوال 137 حُذفت');
  PERFORM t.ok(to_regclass('public.saas_trial_requests') is null, '⑤ جدول الطلبات حُذف');
  PERFORM t.ok((select count(*) from public.whatsapp_subscriptions
                 where (price_snapshot->>'trial')::boolean) = 2, '⑤ اشتراكا التجربة باقيان حتى انتهائهما (موثّق)');
END $$;
\i migrations/137_saas_trial_3_days.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok(to_regprocedure('public.request_saas_trial(text)') is not null, '⑤ إعادة التطبيق');
  PERFORM t.ok(to_regclass('public.saas_trial_requests') is not null, '⑤ الجدول عاد');
  RAISE NOTICE 'PASS ⑤ التراجع يحذف الدوال والجدول، وإعادة التطبيق تنجح';
  RAISE NOTICE 'ALL 137 SAAS TRIAL 3 DAYS TESTS PASSED';
END $$;
