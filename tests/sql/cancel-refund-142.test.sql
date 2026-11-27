-- ============================================================================
-- 142_cancel_refund على نسخة مطابقة للإنتاج + 118 + 119 + 133
-- + 135 + 136
--
--   ⓪ 142 مرتين: قابل لإعادة التشغيل، وجدول بلا سياسة UPDATE/DELETE،
--      و RLS مفعّلة، وقيد المعادلة المشروط بالنوع وفهرس الطلب المفتوح
--      الواحد وعمود الهدية ومسنَدا أيام العمل
--   ① العرض: المثالان الرقميان بالضبط (1999×10/30 = 666.33؛
--      19999×100/365 = 5479.18)، والتعويض الكامل (جديد + 7 أيام +
--      تذاكر ≤ 10%)، وأكواد عدم الأهلية، والعرض قراءة فقط
--   ② الطلب: طلب تعويض + إلغاء نهاية مدة في معاملة واحدة، الاشتراك يبقى
--      فعّالًا، وتدقيق، وإشعار المالك، ومهلة الرد 48 ساعة عمل، وطلب مكرر
--      مرفوض، وغير المالك مرفوض
--   ③ قرار المالك: القائمة للمالك وحده؛ الرفض بسبب مسجَّل بلا دفع وبلا
--      إعادة اشتراك؛ والقرار من غير معلّق مرفوض
--   ④ التدفق الكامل: موافقة → تذكرة قبل بيانات التحويل مرفوضة → فتح
--      تذكرة التعويض (مدعوم، بلا شركة، فئة subscription) → بيانات
--      التحويل تُحفظ على الطلب وتُشعر المالك → تسجيل الدفع بملاحظة
--   ⑥ الكامل والاستخدام والمهل والرسوم: مسنَدا أيام العمل بتواريخ
--      ثابتة، والكامل لدعم جديد، والمتناسب لواتساب فوق حد الـ10%،
--      والتجديد والترقية المزيفة بلا كامل، والمتجر مرفوض، ومهلة الدفع
--      14 يوم عمل للبنك والإنستاباي، والرسوم والصافي عند الدفع
--   ⑦ التراجع: إغلاق طلب التعويض المفتوح تلقائيًا، والسنوي +14 يومًا
--      هدية مرة واحدة لكل مدة، والمدفوع يبقى paid عند التراجع
--   ⑧ التراجع يعيد التطبيق؛ وإلغاء نهاية المدة يبقى (موثّق)
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
SET client_min_messages = warning;

\i tests/fixtures/ecommerce/chain.sql

CREATE OR REPLACE FUNCTION t.sv(p_k text) RETURNS text LANGUAGE sql AS $$ select v from t.saved where k = p_k $$;
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
\i migrations/136_company_self_service_renewal_cancel.sql
\i migrations/142_cancel_refund.sql
\i migrations/142_cancel_refund.sql
SET search_path = public, extensions;

-- ── اشتراكات الاختبار ───────────────────────────────────────────────────
-- OA شهري فائقة: بدأ قبل 20 يومًا وينتهي بعد 10 أيام، مدفوع 1999 في اللقطة.
-- OB سنوي فائقة: بدأ قبل 265 يومًا وينتهي بعد 100 يوم، بلا لقطة مبلغ (يسقط
-- على سعر الباقة الحالي 19999). واشتراك تجربة ultimate ثالث للرفض.
-- والجديدة: دعم جديد (كامل)، واتساب جديد (فوق حد الـ10%)، وشاملة مجدَّدة
-- (بلا كامل)، ومتجر (مرفوض)، ودعم تجديد مزيف (بلا كامل)، ودعم سنوي (هدية)،
-- ودعم شهري ثانٍ (مدفوع ثم تراجع).
INSERT INTO public.whatsapp_subscriptions
  (user_id, company_id, plan, billing_cycle, status, start_date, end_date, duration_days,
   payment_method, price_snapshot)
VALUES
  (t.u('OA'), t.u('CA'), 'ultimate', 'monthly', 'active',
   now() - interval '20 days', now() + interval '10 days', 30,
   'bank_transfer', '{"amount": 1999, "currency": "EGP"}'::jsonb),
  (t.u('OB'), t.u('CB'), 'ultimate', 'yearly', 'active',
   now() - interval '265 days', now() + interval '100 days', 365,
   'bank_transfer', null),
  (t.u('OB'), t.u('CB'), 'ultimate', 'monthly', 'active',
   now() - interval '1 day', now() + interval '2 days', 3,
   null, '{"trial": true, "amount": 0, "currency": "EGP"}'::jsonb);
INSERT INTO t.saved VALUES ('sub_OA_ult_m', (select id::text from public.whatsapp_subscriptions where user_id = t.u('OA') and plan = 'ultimate' and billing_cycle = 'monthly' and duration_days = 30));
INSERT INTO t.saved VALUES ('sub_OB_ult_y', (select id::text from public.whatsapp_subscriptions where user_id = t.u('OB') and plan = 'ultimate' and billing_cycle = 'yearly'));
INSERT INTO t.saved VALUES ('sub_OB_ult_trial', (select id::text from public.whatsapp_subscriptions where user_id = t.u('OB') and plan = 'ultimate' and (price_snapshot->>'trial')::boolean));

DO $$
DECLARE v_id uuid;
BEGIN
  -- اشتراك الدعم الجاهز في الحاضنة (بدأ قبل 5 أيام — للعرض الكامل في ①).
  select id into v_id from public.whatsapp_subscriptions
   where user_id = t.u('OA') and plan = 'support' and status = 'active'
     and start_date < now() - interval '4 days' limit 1;
  INSERT INTO t.saved VALUES ('sub_OA_sup_harness', v_id::text);

  insert into public.whatsapp_subscriptions
    (user_id, company_id, plan, billing_cycle, status, start_date, end_date, duration_days,
     payment_method, price_snapshot)
  values (t.u('OA'), t.u('CA'), 'support', 'monthly', 'active',
          now() - interval '2 days', now() + interval '28 days', 30,
          'bank_transfer', '{"amount": 999, "currency": "EGP"}'::jsonb)
  returning id into v_id;
  INSERT INTO t.saved VALUES ('sub_OA_sup_m', v_id::text);

  insert into public.whatsapp_subscriptions
    (user_id, company_id, plan, billing_cycle, status, start_date, end_date, duration_days,
     payment_method, price_snapshot)
  values (t.u('OB'), t.u('CB'), 'whatsapp', 'monthly', 'active',
          now() - interval '2 days', now() + interval '28 days', 30,
          'bank_transfer', null)
  returning id into v_id;
  INSERT INTO t.saved VALUES ('sub_OB_wa_m', v_id::text);

  insert into public.whatsapp_subscriptions
    (user_id, company_id, plan, billing_cycle, status, start_date, end_date, duration_days,
     payment_method, price_snapshot, is_renewal, previous_end_date)
  values (t.u('OB'), t.u('CB'), 'bundle', 'yearly', 'active',
          now() - interval '2 days', now() + interval '363 days', 365,
          'bank_transfer', null, true, now() - interval '2 days')
  returning id into v_id;
  INSERT INTO t.saved VALUES ('sub_OB_bun_y_ren', v_id::text);

  insert into public.whatsapp_subscriptions
    (user_id, company_id, plan, billing_cycle, status, start_date, end_date, duration_days,
     payment_method, price_snapshot)
  values (t.u('OA'), t.u('CA'), 'store', 'monthly', 'active',
          now() - interval '2 days', now() + interval '28 days', 30,
          'bank_transfer', null)
  returning id into v_id;
  INSERT INTO t.saved VALUES ('sub_OA_store_m', v_id::text);

  insert into public.whatsapp_subscriptions
    (user_id, company_id, plan, billing_cycle, status, start_date, end_date, duration_days,
     payment_method, price_snapshot, is_renewal)
  values (t.u('OA'), t.u('CA'), 'support', 'monthly', 'active',
          now() - interval '2 days', now() + interval '28 days', 30,
          'bank_transfer', '{"amount": 999, "currency": "EGP"}'::jsonb, true)
  returning id into v_id;
  INSERT INTO t.saved VALUES ('sub_OA_sup_m_renfake', v_id::text);

  insert into public.whatsapp_subscriptions
    (user_id, company_id, plan, billing_cycle, status, start_date, end_date, duration_days,
     payment_method, price_snapshot)
  values (t.u('OA'), t.u('CA'), 'support', 'yearly', 'active',
          now() - interval '2 days', now() + interval '363 days', 365,
          'bank_transfer', '{"amount": 9999, "currency": "EGP"}'::jsonb)
  returning id into v_id;
  INSERT INTO t.saved VALUES ('sub_OA_sup_y', v_id::text);

  insert into public.whatsapp_subscriptions
    (user_id, company_id, plan, billing_cycle, status, start_date, end_date, duration_days,
     payment_method, price_snapshot)
  values (t.u('OA'), t.u('CA'), 'support', 'monthly', 'active',
          now() - interval '1 day', now() + interval '29 days', 30,
          'bank_transfer', '{"amount": 999, "currency": "EGP"}'::jsonb)
  returning id into v_id;
  INSERT INTO t.saved VALUES ('sub_OA_sup_m2', v_id::text);
END $$;

-- ══ ⓪ إعادة التطبيق والجدول والصلاحيات ═════════════════════════════════
DO $$
DECLARE
  v_rpc text[] := array[
    'public.refund_quote(uuid)',
    'public.request_cancel_refund(uuid,text)',
    'public.my_refund_requests()',
    'public.submit_refund_transfer_details(uuid,text,text)',
    'public.owner_list_refund_requests(text)',
    'public.owner_decide_refund(uuid,text,text)',
    'public.owner_open_refund_ticket(uuid)',
    'public.owner_mark_refund_paid(uuid,text,numeric)'];
  f text;
BEGIN
  FOREACH f IN ARRAY v_rpc LOOP
    PERFORM t.ok(to_regprocedure(f) is not null, '⓪ دالة موجودة: ' || f);
    PERFORM t.ok(has_function_privilege('authenticated', f::regprocedure, 'EXECUTE'), '⓪ لـ authenticated: ' || f);
    PERFORM t.ok(not has_function_privilege('anon', f::regprocedure, 'EXECUTE'), '⓪ ليست لـ anon: ' || f);
  END LOOP;
  PERFORM t.ok((select relrowsecurity from pg_class where relname = 'refund_requests'), '⓪ RLS مفعّلة');
  PERFORM t.ok(exists (select 1 from pg_constraint where conname = 'refund_requests_formula_check'), '⓪ قيد المعادلة المشروط بالنوع');
  PERFORM t.ok(exists (select 1 from pg_constraint where conname = 'refund_requests_plan_check'), '⓪ قيد الباقات المدفوعة');
  PERFORM t.ok(exists (select 1 from pg_indexes where indexname = 'refund_requests_one_open'), '⓪ فهرس الطلب المفتوح الواحد');
  PERFORM t.ok(not exists (select 1 from pg_policies
    where schemaname = 'public' and tablename = 'refund_requests' and cmd in ('UPDATE', 'DELETE')),
    '⓪ بلا سياسة UPDATE/DELETE — التعديل عبر RPC فقط');
  PERFORM t.ok((select count(*) from public.whatsapp_subscriptions
                 where user_id in (t.u('OA'), t.u('OB')) and plan = 'ultimate' and status = 'active') = 3,
               '⓪ ثلاثة اشتراكات فائقة فعّالة للاختبار');
  PERFORM t.ok(exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'whatsapp_subscriptions'
      and column_name = 'refund_gift_granted_for_start'), '⓪ عمود علامة هدية الـ14 يومًا');
  PERFORM t.ok(to_regprocedure('public._refund_add_business_days(timestamptz,int)') is not null, '⓪ مسنَد أيام العمل');
  PERFORM t.ok(to_regprocedure('public._refund_add_business_hours(timestamptz,int)') is not null, '⓪ مسنَد ساعات العمل');
  PERFORM t.ok(to_regprocedure('public._refund_sie_usage(uuid,timestamptz)') is not null, '⓪ ركيزة SIE المؤجلة');
  RAISE NOTICE 'PASS ⓪ 142 قابل لإعادة التشغيل؛ الجدول والصلاحيات والقيود';
END $$;

-- ══ ① العرض: المثالان الرقميان والكامل وأكواد عدم الأهلية ═══════════════
DO $$
DECLARE q jsonb;
BEGIN
  -- شهري OA: 1999 × 10 / 30 = 666.33 (تناسبي — بدأ قبل 20 يومًا)
  q := t.call(t.u('OA'), format('public.refund_quote(%L)', t.sv('sub_OA_ult_m')));
  PERFORM t.ok((q->>'eligible')::boolean, '① عرض شهري مؤهل');
  PERFORM t.ok((q->>'remaining_days')::int = 10, '① شهري: 10 أيام متبقية');
  PERFORM t.ok((q->>'cycle_days')::int = 30, '① شهري: مدة 30 يومًا');
  PERFORM t.ok((q->>'amount_paid')::numeric = 1999, '① شهري: مدفوع 1999');
  PERFORM t.ok((q->>'refund_kind') = 'prorated', '① شهري: تناسبي (خارج نافذة الـ7 أيام)');
  PERFORM t.ok((q->>'refund_amount')::numeric = 666.33, '① شهري: تعويض 666.33 جنيه');
  PERFORM t.ok((q->>'currency') = 'EGP', '① شهري: العملة جنيه مصري');
  -- سنوي OB: 19999 × 100 / 365 = 5479.18 (بلا لقطة مبلغ — سعر الباقة)
  q := t.call(t.u('OB'), format('public.refund_quote(%L)', t.sv('sub_OB_ult_y')));
  PERFORM t.ok((q->>'eligible')::boolean, '① عرض سنوي مؤهل');
  PERFORM t.ok((q->>'remaining_days')::int = 100, '① سنوي: 100 يوم متبقٍ');
  PERFORM t.ok((q->>'cycle_days')::int = 365, '① سنوي: مدة 365 يومًا');
  PERFORM t.ok((q->>'amount_paid')::numeric = 19999, '① سنوي: مدفوع 19999 من سعر الباقة');
  PERFORM t.ok((q->>'refund_kind') = 'prorated', '① سنوي: تناسبي');
  PERFORM t.ok((q->>'refund_amount')::numeric = 5479.18, '① سنوي: تعويض 5479.18 جنيه');
  -- دعم الحاضنة OA: جديد + 5 أيام + 5 تذاكر ≤ 30 → كامل 999
  q := t.call(t.u('OA'), format('public.refund_quote(%L)', t.sv('sub_OA_sup_harness')));
  PERFORM t.ok((q->>'eligible')::boolean, '① عرض دعم الحاضنة مؤهل');
  PERFORM t.ok((q->>'refund_kind') = 'full', '① دعم الحاضنة: كامل');
  PERFORM t.ok((q->>'refund_amount')::numeric = 999, '① دعم الحاضنة: تعويض كامل 999 جنيه');
  PERFORM t.ok((q->>'tickets_used')::int = 5, '① دعم الحاضنة: 5 تذاكر منذ البداية');
  PERFORM t.ok((q->>'ticket_limit')::int = 30, '① دعم الحاضنة: حد الـ10% هو 30');
  PERFORM t.ok((q->>'ticket_allowance')::int = 300, '① دعم الحاضنة: الحد الشهري 300');
  PERFORM t.ok((q->>'is_new_subscription')::boolean, '① دعم الحاضنة: اشتراك جديد');
  PERFORM t.ok((q->>'within_full_refund_window')::boolean, '① دعم الحاضنة: داخل أول 7 أيام');
  PERFORM t.ok((q->'sie_usage'->>'pending')::boolean, '① ركيزة SIE معلّقة ولا تُسقط الكامل');
  -- الأكواد: غير المالك، وباقة متجر ليست مدفوعة، وتجربة بلا مدفوع
  q := t.call(t.u('OA'), format('public.refund_quote(%L)', t.sv('sub_OB_ult_y')));
  PERFORM t.ok((q->>'eligible')::boolean is false and (q->>'code') = 'not_yours', '① عرض اشتراك شركة أخرى: not_yours');
  q := t.call(t.u('OA'), format('public.refund_quote(%L)', t.sv('sub_OA_store_m')));
  PERFORM t.ok((q->>'eligible')::boolean is false and (q->>'code') = 'not_refundable_plan', '① عرض باقة متجر: not_refundable_plan');
  q := t.call(t.u('OB'), format('public.refund_quote(%L)', t.sv('sub_OB_ult_trial')));
  PERFORM t.ok((q->>'eligible')::boolean is false and (q->>'code') = 'trial_no_refund', '① عرض تجربة: trial_no_refund');
  q := t.call(t.u('OA'), format('public.refund_quote(%L)', '00000000-0000-0000-0000-000000000000'));
  PERFORM t.ok((q->>'eligible')::boolean is false and (q->>'code') = 'not_found', '① عرض اشتراك غير موجود: not_found');
  -- العرض قراءة فقط: لا طلب ولا علَم إلغاء بعده
  PERFORM t.ok((select count(*) from public.refund_requests) = 0, '① العرض لم ينشئ أي طلب');
  PERFORM t.ok((select coalesce(cancel_at_period_end, false) from public.whatsapp_subscriptions
                 where id = t.sv('sub_OA_ult_m')::uuid) = false, '① العرض لم يلغِ الاشتراك');
  RAISE NOTICE 'PASS ① العرض: 666.33 و 5479.18 بالضبط، والكامل 999، والأكواد، وقراءة فقط';
END $$;

-- ══ ② الطلب: إلغاء نهاية مدة + طلب تعويض في معاملة واحدة ═══════════════
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ok(t.err(t.u('OB'), format('public.request_cancel_refund(%L)', t.sv('sub_OA_ult_m'))) = '42501',
               '② طلب تعويض على اشتراك شركة أخرى مرفوض');
  r := t.call(t.u('OA'), format('public.request_cancel_refund(%L, %L)',
                                t.sv('sub_OA_ult_m'), 'لن نحتاج الخدمة بعد هذا الشهر'));
  PERFORM t.ok((r->>'status') = 'pending', '② طلب OA معلّق');
  PERFORM t.ok((r->>'refund_amount')::numeric = 666.33, '② طلب OA بمبلغ 666.33');
  PERFORM t.ok((r->>'refund_kind') = 'prorated', '② طلب OA تناسبي');
  PERFORM t.ok((r->>'remaining_days')::int = 10 and (r->>'cycle_days')::int = 30, '② طلب OA بالأيام الصحيحة');
  PERFORM t.ok((r->>'cancel_reason') = 'لن نحتاج الخدمة بعد هذا الشهر', '② سبب الإلغاء محفوظ');
  PERFORM t.ok((r->>'reply_due_at') is not null
               and (r->>'reply_due_at')::timestamptz > now()
               and (r->>'reply_due_at')::timestamptz <= now() + interval '4 days'
               and extract(dow from (r->>'reply_due_at')::timestamptz) not in (5, 6),
               '② مهلة رد المالك +48 ساعة عمل (يوم عمل لا جمعة/سبت)');
  INSERT INTO t.saved VALUES ('req_OA', r->>'id');
  -- الاشتراك ما زال فعّالًا حتى نهايته، لكن علَم الإلغاء مضبوط
  PERFORM t.ok((select status from public.whatsapp_subscriptions where id = t.sv('sub_OA_ult_m')::uuid) = 'active',
               '② الاشتراك ما زال active — لا إلغاء فوري');
  PERFORM t.ok((select cancel_at_period_end from public.whatsapp_subscriptions where id = t.sv('sub_OA_ult_m')::uuid),
               '② علَم إلغاء نهاية المدة مضبوط');
  PERFORM t.ok((select end_date from public.whatsapp_subscriptions where id = t.sv('sub_OA_ult_m')::uuid) > now(),
               '② نهاية المدة ما زالت في المستقبل');
  PERFORM t.ok(exists (select 1 from public.subscription_audit_log
                       where subscription_id = t.sv('sub_OA_ult_m')::uuid
                         and action = 'cancel_refund_requested'),
               '② الطلب مدقَّق في سجل الاشتراكات');
  PERFORM t.ok(exists (select 1 from public.notifications where user_id = t.u('OW')
                       and category = 'refund' and link = '/owner/refunds.html'
                       and reference_id = t.sv('req_OA')::uuid
                       and title = 'طلب تعويض إلغاء جديد'),
               '② إشعار المالك وصل (notifications + رابط صفحة التعويض)');
  -- طلب مكرر على نفس الاشتراك مرفوض، والعرض نفسه يقول already_requested
  PERFORM t.ok(t.err(t.u('OA'), format('public.request_cancel_refund(%L)', t.sv('sub_OA_ult_m'))) = '42501',
               '② طلب مكرر على نفس الاشتراك مرفوض');
  r := t.call(t.u('OA'), format('public.refund_quote(%L)', t.sv('sub_OA_ult_m')));
  PERFORM t.ok((r->>'eligible')::boolean is false and (r->>'code') = 'already_requested'
               and (r->>'refund_request_id') = t.sv('req_OA'), '② العرض بعد الطلب: already_requested');
  -- قيد المعادلة يرفض رقمًا مخالفًا حتى من كتابة مباشرة (تناسبي)
  BEGIN
    INSERT INTO public.refund_requests
      (company_id, user_id, subscription_id, plan, cycle_days, remaining_days, amount_paid, refund_amount)
    VALUES (t.u('CB'), t.u('OB'), t.sv('sub_OB_ult_y')::uuid, 'ultimate', 365, 100, 19999, 1.00);
    PERFORM t.ok(false, '② قيد المعادلة لم يمنع رقمًا تناسبيًا مخالفًا');
  EXCEPTION WHEN check_violation THEN
    PERFORM t.ok(true, '② قيد المعادلة يرفض رقمًا تناسبيًا مخالفًا');
  END;
  -- وقيد المعادلة المشروط يرفض «كاملًا» بمبلغ ليس المدفوع كاملًا
  BEGIN
    INSERT INTO public.refund_requests
      (company_id, user_id, subscription_id, plan, cycle_days, remaining_days, amount_paid, refund_kind, refund_amount)
    VALUES (t.u('CB'), t.u('OB'), t.sv('sub_OB_ult_y')::uuid, 'ultimate', 365, 100, 19999, 'full', 100.00);
    PERFORM t.ok(false, '② قيد المعادلة لم يمنع كاملًا بمبلغ مخالف');
  EXCEPTION WHEN check_violation THEN
    PERFORM t.ok(true, '② قيد المعادلة يرفض كاملًا بمبلغ مخالف');
  END;
  -- و«كاملًا» بمبلغ المدفوع كاملًا يقبله القيد (يُحذف فورًا — إثبات فقط)
  INSERT INTO public.refund_requests
    (company_id, user_id, subscription_id, plan, cycle_days, remaining_days, amount_paid, refund_kind, refund_amount)
  VALUES (t.u('CA'), t.u('OA'), t.sv('sub_OA_sup_harness')::uuid, 'support', 30, 25, 999, 'full', 999);
  PERFORM t.ok((select count(*) from public.refund_requests
                 where subscription_id = t.sv('sub_OA_sup_harness')::uuid and refund_kind = 'full') = 1,
               '② القيد يقبل كاملًا بمبلغ المدفوع كاملًا');
  DELETE FROM public.refund_requests where subscription_id = t.sv('sub_OA_sup_harness')::uuid;
  RAISE NOTICE 'PASS ② الطلب: إلغاء نهاية مدة + طلب 666.33 + إشعار مالك، بلا إلغاء فوري';
END $$;

-- ══ ③ قرار المالك: رفض بسبب، والقائمة للمالك وحده ═══════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  PERFORM t.ok(t.err(t.u('AD'), 'public.owner_list_refund_requests()') = '42501', '③ القائمة للمالك وحده');
  r := t.call(t.u('OW'), 'public.owner_list_refund_requests()');
  PERFORM t.ok(jsonb_array_length(r) = 1, '③ طلب واحد في قائمة المالك');
  PERFORM t.ok((r->0->>'status') = 'pending', '③ الطلب معلّق في القائمة');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_decide_refund(%L, ''maybe'', null)', t.sv('req_OA'))) = '22023',
               '③ قرار ليس موافقة/رفضًا');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_decide_refund(%L, ''rejected'', null)', t.sv('req_OA'))) = '22023',
               '③ رفض بلا سبب');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_decide_refund(%L, ''rejected'', ''قصير'')', t.sv('req_OA'))) = '22023',
               '③ رفض بسبب قصير');
  r := t.call(t.u('OW'), format('public.owner_decide_refund(%L, ''rejected'', ''رفض تعويض للاختبار فقط'')', t.sv('req_OA')));
  PERFORM t.ok((r->>'status') = 'rejected' and (r->>'decision_reason') = 'رفض تعويض للاختبار فقط', '③ رفض بسبب مسجَّل');
  PERFORM t.ok(exists (select 1 from public.privileged_audit where action = 'refund.rejected'
                       and (new_value->>'request_id')::uuid = t.sv('req_OA')::uuid), '③ الرفض مدقَّق');
  PERFORM t.ok(exists (select 1 from public.notifications where user_id = t.u('OA')
                       and category = 'refund' and title = 'رُفض طلب التعويض'), '③ إشعار الرفض وصل للعميل');
  -- الرفض يرفض التعويض وحده: الإلغاء في نهاية المدة يبقى كما طلبه صاحبه
  PERFORM t.ok((select cancel_at_period_end from public.whatsapp_subscriptions where id = t.sv('sub_OA_ult_m')::uuid),
               '③ بعد الرفض: الإلغاء في نهاية المدة باقٍ');
  PERFORM t.ok((select status from public.whatsapp_subscriptions where id = t.sv('sub_OA_ult_m')::uuid) = 'active',
               '③ بعد الرفض: الاشتراك ما زال فعّالًا حتى نهايته');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_decide_refund(%L, ''approved'', null)', t.sv('req_OA'))) = '22023',
               '③ قرار على غير معلّق');
  PERFORM t.ctx(null);
  -- بعد الرفض يسمح طلب جديد على الاشتراك نفسه (الفهرس الجزئي)
  r := t.call(t.u('OA'), format('public.request_cancel_refund(%L)', t.sv('sub_OA_ult_m')));
  PERFORM t.ok((r->>'status') = 'pending', '③ طلب جديد بعد الرفض مسموح');
  INSERT INTO t.saved VALUES ('req_OA2', r->>'id');
  RAISE NOTICE 'PASS ③ الرفض بسبب مسجَّل يرفض التعويض وحده؛ والقائمة للمالك';
END $$;

-- ══ ④ التدفق الكامل على طلب OB السنوي ═══════════════════════════════════
DO $$
DECLARE r jsonb; v_ticket uuid; v_num bigint;
BEGIN
  r := t.call(t.u('OB'), format('public.request_cancel_refund(%L, %L)',
                                t.sv('sub_OB_ult_y'), 'إغلاق النشاط مؤقتًا'));
  PERFORM t.ok((r->>'status') = 'pending' and (r->>'refund_amount')::numeric = 5479.18, '④ طلب OB السنوي 5479.18');
  INSERT INTO t.saved VALUES ('req_OB', r->>'id');
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  -- تذكرة قبل الموافقة مرفوضة، وبيانات تحويل قبل الموافقة مرفوضة
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_open_refund_ticket(%L)', t.sv('req_OB'))) = '22023',
               '④ تذكرة قبل الموافقة مرفوضة');
  PERFORM t.ok(t.err(t.u('OB'), format('public.submit_refund_transfer_details(%L, ''instapay'', ''01000000000'')', t.sv('req_OB'))) = '22023',
               '④ بيانات تحويل قبل الموافقة مرفوضة');
  -- الموافقة تشعر العميل، وبلا دفع وبلا تذكرة بعد
  r := t.call(t.u('OW'), format('public.owner_decide_refund(%L, ''approved'', ''موافقة تعويض للاختبار'')', t.sv('req_OB')));
  PERFORM t.ok((r->>'status') = 'approved' and (r->>'ticket_id') is null, '④ موافقة بلا دفع وبلا تذكرة');
  PERFORM t.ok(exists (select 1 from public.notifications where user_id = t.u('OB')
                       and category = 'refund' and title = 'وافق المالك على طلب التعويض'), '④ إشعار الموافقة وصل للعميل');
  PERFORM t.ok(exists (select 1 from public.privileged_audit where action = 'refund.approved'
                       and (new_value->>'request_id')::uuid = t.sv('req_OB')::uuid), '④ الموافقة مدقَّقة');
  -- تسجيل الدفع قبل بيانات التحويل مرفوض
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_mark_refund_paid(%L, ''حوّلت المبلغ اليوم'')', t.sv('req_OB'))) = '22023',
               '④ تسجيل دفع قبل بيانات التحويل مرفوض');
  -- فتح التذكرة: من حساب العميل، فئة subscription، نطاق مدعوم بلا شركة
  r := t.call(t.u('OW'), format('public.owner_open_refund_ticket(%L)', t.sv('req_OB')));
  PERFORM t.ok((r->>'ticket_id') is not null, '④ التذكرة مربوطة بالطلب');
  v_ticket := (r->>'ticket_id')::uuid;
  PERFORM t.ok((select user_id from public.tickets where id = v_ticket) = t.u('OB'), '④ التذكرة من حساب العميل');
  PERFORM t.ok((select category from public.tickets where id = v_ticket) = 'subscription', '④ التذكرة فئة subscription');
  PERFORM t.ok((select scope from public.tickets where id = v_ticket) = 'mad3oom_support', '④ التذكرة نطاق mad3oom_support');
  PERFORM t.ok((select company_id from public.tickets where id = v_ticket) is null, '④ تذكرة مدعوم بلا شركة (097)');
  PERFORM t.ok((select status from public.tickets where id = v_ticket) = 'open', '④ التذكرة مفتوحة');
  PERFORM t.ok((select ticket_number from public.tickets where id = v_ticket) is not null, '④ التذكرة برقم');
  INSERT INTO t.saved VALUES ('ticket_OB', v_ticket::text);
  PERFORM t.ok((select description from public.tickets where id = v_ticket) like '%بيانات التحويل%',
               '④ وصف التذكرة يطلب بيانات التحويل');
  PERFORM t.ok((select description from public.tickets where id = v_ticket) not like '%01000000000%',
               '④ وصف التذكرة بلا رقم تحويل (البيانات على الطلب وحده)');
  PERFORM t.ok(exists (select 1 from public.notifications where user_id = t.u('OB')
                       and category = 'refund' and title = 'تذكرة تعويض: بيانات التحويل مطلوبة'),
               '④ إشعار فتح التذكرة وصل للعميل');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_open_refund_ticket(%L)', t.sv('req_OB'))) = '22023',
               '④ تذكرة ثانية لنفس الطلب مرفوضة');
  PERFORM t.ctx(null);
  -- بيانات التحويل: وسيلة غير صالحة، وحساب قصير، ثم صحيحة
  PERFORM t.ok(t.err(t.u('OB'), format('public.submit_refund_transfer_details(%L, ''card'', ''01000000000'')', t.sv('req_OB'))) = '22023',
               '④ وسيلة تحويل غير صالحة');
  PERFORM t.ok(t.err(t.u('OB'), format('public.submit_refund_transfer_details(%L, ''instapay'', ''123'')', t.sv('req_OB'))) = '22023',
               '④ رقم تحويل قصير');
  PERFORM t.ok(t.err(t.u('OA'), format('public.submit_refund_transfer_details(%L, ''instapay'', ''01000000000'')', t.sv('req_OB'))) = '42501',
               '④ بيانات تحويل من شركة أخرى مرفوضة');
  r := t.call(t.u('OB'), format('public.submit_refund_transfer_details(%L, ''instapay'', ''01000000000'')', t.sv('req_OB')));
  PERFORM t.ok((r->>'transfer_method') = 'instapay' and (r->>'transfer_account') = '01000000000'
               and (r->>'transfer_details_submitted_at') is not null, '④ بيانات التحويل محفوظة على الطلب');
  PERFORM t.ok((r->>'payment_due_at') is not null
               and (r->>'payment_due_at')::timestamptz >= now() + interval '14 days'
               and (r->>'payment_due_at')::timestamptz <= now() + interval '21 days'
               and extract(dow from (r->>'payment_due_at')::timestamptz) not in (5, 6),
               '④ مهلة الدفع للإنستاباي +14 يوم عمل');
  PERFORM t.ok((select description from public.tickets where id = v_ticket) not like '%01000000000%',
               '④ رقم التحويل ليس في التذكرة');
  PERFORM t.ok(exists (select 1 from public.notifications where user_id = t.u('OW')
                       and category = 'refund' and title = 'وصلت بيانات تحويل تعويض'
                       and reference_id = t.sv('req_OB')::uuid), '④ إشعار المالك بوصول بيانات التحويل');
  PERFORM t.ok(t.err(t.u('OB'), format('public.submit_refund_transfer_details(%L, ''instapay'', ''01111111111'')', t.sv('req_OB'))) = '22023',
               '④ إرسال بيانات التحويل مرة ثانية مرفوض');
  -- تسجيل الدفع: بلا ملاحظة وملاحظة قصيرة مرفوضتان، ثم صحيح (بلا رسوم)
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_mark_refund_paid(%L, null)', t.sv('req_OB'))) = '22023',
               '④ تسجيل دفع بلا ملاحظة');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_mark_refund_paid(%L, ''تم'')', t.sv('req_OB'))) = '22023',
               '④ تسجيل دفع بملاحظة قصيرة');
  r := t.call(t.u('OW'), format('public.owner_mark_refund_paid(%L, ''حوّلت 5479.18 جنيه إنستاباي اليوم'')', t.sv('req_OB')));
  PERFORM t.ok((r->>'status') = 'paid' and (r->>'paid_at') is not null, '④ تسجيل الدفع: paid');
  PERFORM t.ok((r->>'transfer_fee')::numeric = 0 and (r->>'refund_net')::numeric = 5479.18,
               '④ بلا رسوم: الصافي = الإجمالي 5479.18');
  PERFORM t.ok(exists (select 1 from public.privileged_audit where action = 'refund.paid'
                       and (new_value->>'request_id')::uuid = t.sv('req_OB')::uuid), '④ الدفع مدقَّق');
  PERFORM t.ok(exists (select 1 from public.notifications where user_id = t.u('OB')
                       and category = 'refund' and title = 'تم تسجيل دفع التعويض'), '④ إشعار تسجيل الدفع وصل للعميل');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_mark_refund_paid(%L, ''حوّلت مرة أخرى'')', t.sv('req_OB'))) = '22023',
               '④ تسجيل دفع ثانٍ مرفوض');
  PERFORM t.ctx(null);
  -- حالة الشركة: طلبات OB ظاهرة، وطلب OA الثاني ما زال معلّقًا
  r := t.call(t.u('OB'), 'public.my_refund_requests()');
  PERFORM t.ok((r->>'has_company')::boolean and jsonb_array_length(r->'requests') = 1
               and (r->'requests'->0->>'status') = 'paid', '④ حالة شركة OB: طلب واحد paid');
  PERFORM t.ok((r->'requests'->0->>'transfer_account') = '01000000000', '④ مالك الشركة يرى رقم التحويل كاملًا');
  -- عضو الفريق يرى الطلب بلا رقم الحساب
  r := t.call(t.u('B1'), 'public.my_refund_requests()');
  PERFORM t.ok(jsonb_array_length(r->'requests') = 1, '④ عضو الفريق يرى طلب التعويض');
  PERFORM t.ok((r->'requests'->0->>'transfer_account') is null, '④ رقم التحويل محجوب عن عضو الفريق');
  PERFORM t.ok((r->'requests'->0->>'transfer_method') = 'instapay', '④ وسيلة التحويل ظاهرة لعضو الفريق');
  r := t.call(t.u('OA'), 'public.my_refund_requests()');
  PERFORM t.ok(jsonb_array_length(r->'requests') = 2, '④ حالة شركة OA: طلبان (مرفوض + معلّق)');
  RAISE NOTICE 'PASS ④ التدفق الكامل: موافقة → تذكرة → بيانات تحويل → تسجيل دفع';
END $$;

-- ══ ⑥ الكامل والاستخدام والمهل والرسوم ══════════════════════════════════
DO $$
DECLARE q jsonb; r jsonb;
BEGIN
  -- مسنَدا أيام العمل بتواريخ ثابتة (2026-11-26 خميس، 27 جمعة، 29 أحد)
  PERFORM t.ok(public._refund_add_business_days('2026-11-26 12:00', 3) = '2026-12-01 12:00'::timestamptz,
               '⑥ +3 أيام عمل من الخميس = الثلاثاء 1 ديسمبر');
  PERFORM t.ok(public._refund_add_business_days('2026-11-26 12:00', 14) = '2026-12-16 12:00'::timestamptz,
               '⑥ +14 يوم عمل من الخميس = الأربعاء 16 ديسمبر');
  PERFORM t.ok(public._refund_add_business_days('2026-11-27 12:00', 1) = '2026-11-29 12:00'::timestamptz,
               '⑥ +1 يوم عمل من الجمعة = الأحد 29 نوفمبر');
  PERFORM t.ok(public._refund_add_business_hours('2026-11-26 12:00', 48) = '2026-11-30 12:00'::timestamptz,
               '⑥ +48 ساعة عمل من الخميس = الاثنين 30 نوفمبر');
  PERFORM t.ok(public._refund_add_business_hours('2026-11-27 12:00', 48) = '2026-12-01 12:00'::timestamptz,
               '⑥ +48 ساعة عمل من الجمعة = الثلاثاء 1 ديسمبر');
  PERFORM t.ok(public._refund_add_business_hours('2026-11-29 12:00', 48) = '2026-12-01 12:00'::timestamptz,
               '⑥ +48 ساعة عمل من الأحد = الثلاثاء 1 ديسمبر');
  -- حدود الـ10% لكل باقة
  PERFORM t.ok(public._refund_ticket_allowance('support') = 300, '⑥ حد دعم الشهري 300');
  PERFORM t.ok(public._refund_ticket_allowance('whatsapp') = 20, '⑥ حد واتساب الشهري 20 (افتراضي)');
  PERFORM t.ok(public._refund_ticket_allowance('ultimate') = 300, '⑥ حد الفائقة 300 مرجعًا');
  PERFORM t.ok(public._refund_ticket_usage_limit('support') = 30, '⑥ حد 10% للدعم 30');
  PERFORM t.ok(public._refund_ticket_usage_limit('whatsapp') = 2, '⑥ حد 10% للواتساب 2');
  PERFORM t.ok(public._refund_ticket_usage_limit('bundle') = 30, '⑥ حد 10% للشاملة 30');

  -- دعم OA الجديد: 0 تذكرة ≤ 30 → كامل 999
  q := t.call(t.u('OA'), format('public.refund_quote(%L)', t.sv('sub_OA_sup_m')));
  PERFORM t.ok((q->>'refund_kind') = 'full' and (q->>'refund_amount')::numeric = 999, '⑥ دعم جديد: كامل 999');
  PERFORM t.ok((q->>'tickets_used')::int = 0 and (q->>'ticket_limit')::int = 30, '⑥ دعم جديد: 0 تذكرة من حد 30');
  PERFORM t.ok((q->>'remaining_days')::int = 28 and (q->>'cycle_days')::int = 30, '⑥ دعم جديد: 28 من 30 يومًا');

  -- واتساب OB: 3 تذاكر جديدة + تذكرة تعويض ④ = 4 > حد 2 → تناسبي
  INSERT INTO public.tickets (user_id, title, description, status, priority, category, created_at)
  SELECT t.u('OB'), 'سؤال ' || g, 'تفاصيل', 'open', 'medium', 'other', now() - interval '1 day'
    FROM generate_series(1, 3) g;
  q := t.call(t.u('OB'), format('public.refund_quote(%L)', t.sv('sub_OB_wa_m')));
  PERFORM t.ok((q->>'refund_kind') = 'prorated', '⑥ واتساب فوق حد الـ10%: تناسبي لا كامل');
  PERFORM t.ok((q->>'tickets_used')::int = 4, '⑥ واتساب: 4 تذاكر منذ البداية (3 + تذكرة تعويض ④)');
  PERFORM t.ok((q->>'ticket_limit')::int = 2 and (q->>'ticket_allowance')::int = 20, '⑥ واتساب: حد 2 من 20');
  PERFORM t.ok((q->>'refund_amount')::numeric = 1212.40, '⑥ واتساب: تناسبي 1299×28/30 = 1212.40');
  PERFORM t.ok((q->>'amount_paid')::numeric = 1299, '⑥ واتساب: مدفوع 1299 من سعر الباقة');

  -- شاملة مجدَّدة OB: داخل 7 أيام وبلا تذاكر، لكن تجديد → تناسبي
  q := t.call(t.u('OB'), format('public.refund_quote(%L)', t.sv('sub_OB_bun_y_ren')));
  PERFORM t.ok((q->>'refund_kind') = 'prorated', '⑥ شاملة مجدَّدة: تناسبي رغم أول 7 أيام');
  PERFORM t.ok((q->>'is_new_subscription')::boolean is false, '⑥ شاملة مجدَّدة: ليست اشتراكًا جديدًا');
  PERFORM t.ok((q->>'refund_amount')::numeric = 22872.98, '⑥ شاملة مجدَّدة: 22999×363/365 = 22872.98');

  -- تجديد مزيف OA (is_renewal=true بلا سابقة): ليس جديدًا → تناسبي
  q := t.call(t.u('OA'), format('public.refund_quote(%L)', t.sv('sub_OA_sup_m_renfake')));
  PERFORM t.ok((q->>'refund_kind') = 'prorated', '⑥ تجديد مزيف: تناسبي');
  PERFORM t.ok((q->>'is_new_subscription')::boolean is false, '⑥ تجديد مزيف: ليس جديدًا');
  PERFORM t.ok((q->>'refund_amount')::numeric = 932.40, '⑥ تجديد مزيف: 999×28/30 = 932.40');

  -- التدفق الكامل لدعم OA الجديد مع رسوم تحويل فعلية
  r := t.call(t.u('OA'), format('public.request_cancel_refund(%L, %L)',
                                t.sv('sub_OA_sup_m'), 'تجربة الخدمة لم تناسبنا'));
  PERFORM t.ok((r->>'status') = 'pending' and (r->>'refund_kind') = 'full'
               and (r->>'refund_amount')::numeric = 999, '⑥ طلب دعم OA الكامل 999');
  INSERT INTO t.saved VALUES ('req_OA_sup', r->>'id');
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  r := t.call(t.u('OW'), format('public.owner_decide_refund(%L, ''approved'', null)', t.sv('req_OA_sup')));
  PERFORM t.ok((r->>'status') = 'approved', '⑥ موافقة على طلب الدعم الكامل');
  r := t.call(t.u('OW'), format('public.owner_open_refund_ticket(%L)', t.sv('req_OA_sup')));
  PERFORM t.ok((r->>'ticket_id') is not null, '⑥ تذكرة طلب الدعم الكامل');
  PERFORM t.ctx(null);
  r := t.call(t.u('OA'), format('public.submit_refund_transfer_details(%L, ''bank_transfer'', ''EG1100000000000000000000001'')', t.sv('req_OA_sup')));
  PERFORM t.ok((r->>'transfer_method') = 'bank_transfer', '⑥ بيانات تحويل بنكية لطلب الدعم');
  PERFORM t.ok((r->>'payment_due_at') is not null
               and (r->>'payment_due_at')::timestamptz >= now() + interval '14 days'
               and (r->>'payment_due_at')::timestamptz <= now() + interval '21 days'
               and extract(dow from (r->>'payment_due_at')::timestamptz) not in (5, 6),
               '⑥ مهلة الدفع للبنك +14 يوم عمل');
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_mark_refund_paid(%L, ''حوّلت المبلغ اليوم'', 2000)', t.sv('req_OA_sup'))) = '22023',
               '⑥ رسوم أكبر من التعويض مرفوضة');
  PERFORM t.ok(t.err(t.u('OW'), format('public.owner_mark_refund_paid(%L, ''حوّلت المبلغ اليوم'', -5)', t.sv('req_OA_sup'))) = '22023',
               '⑥ رسوم سالبة مرفوضة');
  r := t.call(t.u('OW'), format('public.owner_mark_refund_paid(%L, ''حوّلت 999 جنيه بنكيًا اليوم'', 25.50)', t.sv('req_OA_sup')));
  PERFORM t.ok((r->>'status') = 'paid', '⑥ تسجيل الدفع برسوم: paid');
  PERFORM t.ok((r->>'transfer_fee')::numeric = 25.50, '⑥ الرسوم الفعلية 25.50 مسجَّلة');
  PERFORM t.ok((r->>'refund_net')::numeric = 973.50, '⑥ الصافي 999 − 25.50 = 973.50');
  PERFORM t.ctx(null);
  RAISE NOTICE 'PASS ⑥ الكامل والاستخدام والمهل والرسوم والصافي';
END $$;

-- ══ ⑦ التراجع: إغلاق تلقائي + هدية السنوي مرة واحدة + المدفوع يبقى ═══
DO $$
DECLARE q jsonb; r jsonb; v_end timestamptz; v_end2 timestamptz;
BEGIN
  -- السنوي OA: كامل 9999 (تذكرة تعويض ⑥ واحدة ≤ 30)
  q := t.call(t.u('OA'), format('public.refund_quote(%L)', t.sv('sub_OA_sup_y')));
  PERFORM t.ok((q->>'refund_kind') = 'full' and (q->>'refund_amount')::numeric = 9999, '⑦ سنوي OA: كامل 9999');
  PERFORM t.ok((q->>'tickets_used')::int = 1, '⑦ سنوي OA: تذكرة واحدة منذ البداية (تذكرة تعويض ⑥)');
  r := t.call(t.u('OA'), format('public.request_cancel_refund(%L, %L)',
                                t.sv('sub_OA_sup_y'), 'سنغلق مؤقتًا'));
  PERFORM t.ok((r->>'status') = 'pending' and (r->>'refund_amount')::numeric = 9999, '⑦ طلب سنوي OA معلّق 9999');
  INSERT INTO t.saved VALUES ('req_OA_y', r->>'id');
  select end_date into v_end from public.whatsapp_subscriptions where id = t.sv('sub_OA_sup_y')::uuid;
  -- التراجع الأول: إغلاق الطلب + هدية 14 يومًا
  r := t.call(t.u('OA'), format('public.resume_my_subscription(%L)', t.sv('sub_OA_sup_y')));
  PERFORM t.ok((r->>'cancel_at_period_end')::boolean is false, '⑦ التراجع الأول: العلَم ممسوح');
  PERFORM t.ok((r->>'gift_days_added')::int = 14, '⑦ التراجع الأول: هدية 14 يومًا');
  PERFORM t.ok((r->>'refund_requests_closed')::int = 1, '⑦ التراجع الأول: أُغلق طلب تعويض واحد');
  PERFORM t.ok((r->>'end_date')::timestamptz = v_end + interval '14 days', '⑦ التراجع الأول: نهاية المدة +14 يومًا');
  PERFORM t.ok((select status from public.refund_requests where id = t.sv('req_OA_y')::uuid) = 'closed',
               '⑦ الطلب السنوي مغلق بعد التراجع');
  PERFORM t.ok((select closed_at from public.refund_requests where id = t.sv('req_OA_y')::uuid) is not null,
               '⑦ إغلاق الطلب مؤرخ');
  PERFORM t.ok((select refund_gift_granted_for_start from public.whatsapp_subscriptions
                 where id = t.sv('sub_OA_sup_y')::uuid)
               = (select start_date from public.whatsapp_subscriptions where id = t.sv('sub_OA_sup_y')::uuid),
               '⑦ علامة الهدية = بداية المدة الحالية');
  -- طلب جديد بعد الإغلاق مسموح (الفهرس الجزئي) — والتراجع الثاني بلا هدية
  r := t.call(t.u('OA'), format('public.request_cancel_refund(%L, %L)',
                                t.sv('sub_OA_sup_y'), 'سنغلق مؤقتًا مرة أخرى'));
  PERFORM t.ok((r->>'status') = 'pending', '⑦ طلب سنوي ثانٍ بعد الإغلاق مسموح');
  INSERT INTO t.saved VALUES ('req_OA_y2', r->>'id');
  select end_date into v_end2 from public.whatsapp_subscriptions where id = t.sv('sub_OA_sup_y')::uuid;
  r := t.call(t.u('OA'), format('public.resume_my_subscription(%L)', t.sv('sub_OA_sup_y')));
  PERFORM t.ok((r->>'gift_days_added')::int = 0, '⑦ التراجع الثاني في المدة نفسها: بلا هدية');
  PERFORM t.ok((r->>'refund_requests_closed')::int = 1, '⑦ التراجع الثاني: أُغلق الطلب الثاني');
  PERFORM t.ok((r->>'end_date')::timestamptz = v_end2, '⑦ التراجع الثاني: نهاية المدة بلا تغيير');
  -- المدفوع يبقى paid عند التراجع (شهري OA الثاني — محفظة إلكترونية)
  q := t.call(t.u('OA'), format('public.refund_quote(%L)', t.sv('sub_OA_sup_m2')));
  PERFORM t.ok((q->>'refund_kind') = 'full' and (q->>'refund_amount')::numeric = 999, '⑦ شهري OA الثاني: كامل 999');
  PERFORM t.ok((q->>'tickets_used')::int = 1, '⑦ شهري OA الثاني: تذكرة واحدة منذ البداية');
  r := t.call(t.u('OA'), format('public.request_cancel_refund(%L, %L)',
                                t.sv('sub_OA_sup_m2'), 'إغلاق مؤقت'));
  INSERT INTO t.saved VALUES ('req_OA_m2', r->>'id');
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  r := t.call(t.u('OW'), format('public.owner_decide_refund(%L, ''approved'', null)', t.sv('req_OA_m2')));
  r := t.call(t.u('OW'), format('public.owner_open_refund_ticket(%L)', t.sv('req_OA_m2')));
  PERFORM t.ctx(null);
  r := t.call(t.u('OA'), format('public.submit_refund_transfer_details(%L, ''cash_wallet'', ''01000000000'')', t.sv('req_OA_m2')));
  PERFORM t.ok((r->>'payment_due_at') is not null
               and (r->>'payment_due_at')::timestamptz >= now() + interval '3 days'
               and (r->>'payment_due_at')::timestamptz <= now() + interval '5 days'
               and extract(dow from (r->>'payment_due_at')::timestamptz) not in (5, 6),
               '⑦ مهلة الدفع للمحفظة +3 أيام عمل');
  PERFORM t.ctx('owner');
  PERFORM t.stepup(t.u('OW'));
  r := t.call(t.u('OW'), format('public.owner_mark_refund_paid(%L, ''حوّلت 999 جنيه للمحفظة اليوم'')', t.sv('req_OA_m2')));
  PERFORM t.ok((r->>'status') = 'paid', '⑦ شهري OA الثاني: paid');
  PERFORM t.ctx(null);
  r := t.call(t.u('OA'), format('public.resume_my_subscription(%L)', t.sv('sub_OA_sup_m2')));
  PERFORM t.ok((r->>'gift_days_added')::int = 0, '⑦ شهري: التراجع بلا هدية (للسنوي وحده)');
  PERFORM t.ok((r->>'refund_requests_closed')::int = 0, '⑦ المدفوع لا يُغلق عند التراجع: 0');
  PERFORM t.ok((select status from public.refund_requests where id = t.sv('req_OA_m2')::uuid) = 'paid',
               '⑦ الطلب المدفوع يبقى paid بعد التراجع');
  PERFORM t.ok((select cancel_at_period_end from public.whatsapp_subscriptions
                 where id = t.sv('sub_OA_sup_m2')::uuid) = false,
               '⑦ الاشتراك الشهري عاد فعّالًا بلا إلغاء');
  RAISE NOTICE 'PASS ⑦ التراجع يغلق المفتوح، والهدية مرة واحدة لكل مدة، والمدفوع يبقى';
END $$;

-- ══ ⑧ التراجع وإعادة التطبيق ═══════════════════════════════════════════
\i migrations/_rollback/142_cancel_refund.down.sql
DO $$
BEGIN
  PERFORM t.ok(to_regprocedure('public.request_cancel_refund(uuid,text)') is null, '⑧ دوال 142 حُذفت');
  PERFORM t.ok(to_regclass('public.refund_requests') is null, '⑧ جدول الطلبات حُذف');
  PERFORM t.ok((select cancel_at_period_end from public.whatsapp_subscriptions where id = t.sv('sub_OB_ult_y')::uuid),
               '⑧ إلغاء نهاية المدة باقٍ بعد التراجع (موثّق)');
  PERFORM t.ok((select status from public.tickets where id = t.sv('ticket_OB')::uuid) = 'open',
               '⑧ تذكرة التعويض باقية مفتوحة بعد التراجع (موثّق)');
  PERFORM t.ok(not exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'whatsapp_subscriptions'
      and column_name = 'refund_gift_granted_for_start'), '⑧ علامة الهدية حُذفت');
  PERFORM t.ok(pg_get_functiondef('public.resume_my_subscription(uuid)'::regprocedure)
               not like '%refund_requests%', '⑧ التراجع عاد إلى نص 136 بلا إغلاق تعويض');
END $$;
\i migrations/142_cancel_refund.sql
SET search_path = public, extensions;
DO $$
BEGIN
  PERFORM t.ok(to_regprocedure('public.request_cancel_refund(uuid,text)') is not null, '⑧ إعادة التطبيق');
  PERFORM t.ok(to_regclass('public.refund_requests') is not null, '⑧ الجدول عاد');
  PERFORM t.ok(pg_get_functiondef('public.resume_my_subscription(uuid)'::regprocedure)
               like '%refund_gift_granted_for_start%', '⑧ التراجع عاد بإضافتي 142');
  RAISE NOTICE 'PASS ⑧ التراجع يحذف الدوال والجدول، وإعادة التطبيق تنجح';
  RAISE NOTICE 'ALL 142 CANCEL REFUND TESTS PASSED';
END $$;
