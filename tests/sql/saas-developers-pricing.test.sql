-- ============================================================================
-- 141_saas_developers_pricing على نسخة مطابقة للإنتاج + chain-to-093
--
--   ⓪ الترحيل مرتين: قابل لإعادة التشغيل.
--   ① Webhooks: إنشاء/قائمة/تعديل/حذف/تدوير بسرّ يعود مرة واحدة فقط،
--      وعزل كامل بين شركتين، ورفض الرابط غير https والأحداث غير المعروفة،
--      ولا قراءة مباشرة للجدول (RLS بلا سياسات)، وسجل تسليم فارغ حتى
--      تحدث محاولة فعلية عبر enqueue من service_role وحده.
--   ② بيئة المفتاح: الافتراضي live، وقيد live/test، وقيمة غير صالحة تُرفَض.
--   ③ الفائقة: مفاتيح واتساب الأربعة، والأسعار بلا أي تغيير
--      (الفائقة 1999/19999، واتساب 1299/12999، الشاملة 2099/22999)،
--      وخطتا واتساب المستقلتان تبقيان مفعّلتين (مخفيتان من البيع في
--      الواجهة فقط)، وعرض الترقية إلى الفائقة مؤهل لمالك الدعم وحده
--      وتشمل مزاياه المضافة مفاتيح واتساب الأربعة (قبل 141 كان المضاف
--      unlimited_tickets وحده)، ولمالك دعم+واتساب معًا مؤهل أيضًا
--      (الفائقة توحّد اشتراكيه).
--   ④ حدّ موثّق: مالك الشاملة → الفائقة يبقى redundant — مجموعتا
--      المزايا متطابقتان حرفيًا بعد 141 (10 = 10)، والفائقة أرخص أصلًا
--      (1999 < 2099) فليست ترقية بحال. التغيير لا يقلب أي مسار من
--      redundant إلى مؤهل في بيانات الإنتاج؛ أثره الحقيقي أن عرض
--      الترقية صار يسمّي واتساب ضمن المزايا المضافة بدل إخفائه.
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
SET client_min_messages = warning;

\i tests/fixtures/prod-shape/load.sql
\i tests/fixtures/prod-shape/chain-to-093.sql
\i tests/fixtures/tenancy/harness.sql

-- نداء بدور service_role (للدوال الطرفية)
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
CREATE OR REPLACE FUNCTION t.svcerr(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
begin
  perform t.svc(p_sql);
  return 'ok';
exception when others then
  return sqlstate;
end $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role, anon;

-- ── ⓪ إعادة التطبيق ───────────────────────────────────────────────────
\i migrations/141_saas_developers_pricing.sql
\i migrations/141_saas_developers_pricing.sql
SET search_path = public, extensions;

-- مالكا الشركتين A وB مديرا شركتيهما (الرتبة + العلاقة)
UPDATE public.profiles SET role = 'company_admin' WHERE id IN (t.u('OA'), t.u('OB'));
DO $$
BEGIN
  PERFORM t.ok(public.is_company_admin() IS DISTINCT FROM true, 'HARNESS OA ليس مديرًا قبل الهوية');
  PERFORM t.ok(t.call(t.u('OA'), 'public.is_company_admin()')::boolean, 'HARNESS OA مدير شركة A');
  PERFORM t.ok(t.call(t.u('OB'), 'public.is_company_admin()')::boolean, 'HARNESS OB مدير شركة B');
  PERFORM t.ok(t.call(t.u('OA'), 'public.company_of()') #>> '{}' = t.u('CA')::text, 'HARNESS شركة OA هي CA');
END $$;

-- ══ ① Webhooks ════════════════════════════════════════════════════════
DO $$
DECLARE
  v jsonb; v_id uuid; v_secret text; v_secret2 text; v_list jsonb;
BEGIN
  -- سجل التسليم فارغ قبل أي محاولة — بلا صفوف وهمية
  PERFORM t.ok(t.call(t.u('OA'), 'public.company_webhook_list(' || quote_literal(t.u('CA')) || ')') = '[]'::jsonb, '① القائمة فارغة أولًا');

  -- إنشاء: السرّ يعود مرة واحدة
  v := t.call(t.u('OA'), format('public.company_webhook_create(%L, %L, %L, %L)',
    t.u('CA'), 'نظام المبيعات', 'https://example.com/mad3oom-hook', array['ticket.created', 'ticket.closed']));
  PERFORM t.ok(v->>'id' IS NOT NULL, '① الإنشاء يعيد id');
  PERFORM t.ok(v->>'secret' IS NOT NULL AND char_length(v->>'secret') = 64, '① السرّ 64 خانة hex');
  PERFORM t.ok(v->>'url' = 'https://example.com/mad3oom-hook', '① الرابط محفوظ');
  PERFORM t.ok(v->'events' @> '["ticket.created"]'::jsonb, '① الأحداث محفوظة');
  v_id := (v->>'id')::uuid; v_secret := v->>'secret';
  INSERT INTO t.saved VALUES ('wh_a', v_id::text), ('wh_secret', v_secret);

  -- القائمة لا تعيد السرّ أبدًا
  v_list := t.call(t.u('OA'), format('public.company_webhook_list(%L)', t.u('CA')));
  PERFORM t.ok(jsonb_array_length(v_list) = 1, '① القائمة فيها صف واحد');
  PERFORM t.ok(NOT (v_list->0 ? 'secret'), '① القائمة بلا سرّ');

  -- عزل: مدير شركة أخرى لا يرى ولا يعدّل
  PERFORM t.ok(t.err(t.u('OB'), format('public.company_webhook_list(%L)', t.u('CA'))) = '42501', '① OB لا يسرد webhooks شركة A');
  PERFORM t.ok(t.err(t.u('OB'), format('public.company_webhook_update(%L, %L)', v_id, 'سرقة')) = '42501', '① OB لا يعدّل webhook شركة A');
  PERFORM t.ok(t.err(t.u('OB'), format('public.company_webhook_delete(%L)', v_id)) = '42501', '① OB لا يحذف webhook شركة A');
  PERFORM t.ok(t.err(t.u('OB'), format('public.company_webhook_rotate_secret(%L)', v_id)) = '42501', '① OB لا يدوّر سرّ شركة A');
  PERFORM t.ok(t.err(t.u('OB'), format('public.company_webhook_deliveries(%L)', v_id)) = '42501', '① OB لا يرى سجل تسليم شركة A');

  -- رفض المدخلات غير الصالحة
  PERFORM t.ok(t.err(t.u('OA'), format('public.company_webhook_create(%L, %L, %L, %L)',
    t.u('CA'), 'x', 'http://example.com/hook', array['ticket.created'])) = '22023', '① رابط http مرفوض');
  PERFORM t.ok(t.err(t.u('OA'), format('public.company_webhook_create(%L, %L, %L, %L)',
    t.u('CA'), 'x', 'https://example.com/hook', array['ticket.deleted'])) = '22023', '① حدث غير معروف مرفوض');
  PERFORM t.ok(t.err(t.u('OA'), format('public.company_webhook_create(%L, %L, %L, %L)',
    t.u('CA'), 'x', 'https://example.com/hook', array[]::text[])) = '22023', '① بلا أحداث مرفوض');

  -- تعديل: الاسم والأحداث؛ السرّ لا يتغير
  v := t.call(t.u('OA'), format('public.company_webhook_update(%L, %L, NULL, %L)',
    v_id, 'نظام المبيعات v2', array['ticket.created', 'ticket.replied', 'customer.created']));
  PERFORM t.ok(v->>'name' = 'نظام المبيعات v2', '① التعديل غيّر الاسم');
  PERFORM t.ok(v->'events' @> '["customer.created"]'::jsonb, '① التعديل غيّر الأحداث');
  PERFORM t.ok(NOT (v ? 'secret'), '① التعديل لا يعيد سرًّا');
  PERFORM t.ok(t.err(t.u('OA'), format('public.company_webhook_update(%L, NULL, %L, NULL)',
    v_id, 'http://example.com/x')) = '22023', '① تعديل الرابط إلى http مرفوض');

  -- تدوير: سرّ جديد مختلف، يعود مرة واحدة
  v := t.call(t.u('OA'), format('public.company_webhook_rotate_secret(%L)', v_id));
  v_secret2 := v->>'secret';
  PERFORM t.ok(v_secret2 IS NOT NULL AND v_secret2 <> v_secret, '① التدوير يعيد سرًا جديدًا مختلفًا');

  -- سجل التسليم فارغ حتى تحدث محاولة فعلية
  PERFORM t.ok(t.call(t.u('OA'), format('public.company_webhook_deliveries(%L)', v_id)) = '[]'::jsonb,
    '① سجل التسليم فارغ بلا محاولات');

  -- enqueue من service_role وحده: حدث مشترك فيه يُصفّ، وغير المشترك لا
  v := t.svc(format('public.company_webhook_enqueue(%L, %L, %L)',
    t.u('CA'), 'ticket.created', '{"ticket_id": 7}'::jsonb));
  PERFORM t.ok((v->>'enqueued')::int = 1, '① enqueue صفّ محاولة واحدة للحدث المشترك فيه');
  v := t.svc(format('public.company_webhook_enqueue(%L, %L, %L)',
    t.u('CA'), 'subscription.renewed', '{}'::jsonb));
  PERFORM t.ok((v->>'enqueued')::int = 0, '① enqueue لا يصفّ لحدث غير مشترك فيه');
  PERFORM t.ok(t.err(t.u('OA'), format('public.company_webhook_enqueue(%L, %L)',
    t.u('CA'), 'ticket.created')) = '42501', '① enqueue مرفوض من مدير الشركة (service_role وحده)');
  PERFORM t.ok(t.svcerr(format('public.company_webhook_enqueue(%L, %L)',
    t.u('CA'), 'ticket.deleted')) = '22023', '① enqueue لحدث غير معروف مرفوض');

  -- السجل الآن فيه محاولة فعلية واحدة معلّقة
  v_list := t.call(t.u('OA'), format('public.company_webhook_deliveries(%L)', v_id));
  PERFORM t.ok(jsonb_array_length(v_list) = 1, '① سجل التسليم فيه محاولة واحدة فعلية');
  PERFORM t.ok(v_list->0->>'event' = 'ticket.created', '① المحاولة للحدث الصحيح');
  PERFORM t.ok(v_list->0->>'status' = 'pending', '① المحاولة معلّقة');

  -- لا قراءة مباشرة للجدول إطلاقًا: المنح مسحوبة من authenticated
  -- (ليس RLS فقط)، فالقراءة المباشرة تُرفَض 42501 لا تعيد صفرًا.
  PERFORM t.ok(t.err(t.u('OA'), 'select count(*) from public.company_webhooks') = '42501',
    '① مدير الشركة لا يقرأ جدول Webhooks مباشرةً');
  PERFORM t.ok(t.err(t.u('OA'), 'select count(*) from public.company_webhook_deliveries') = '42501',
    '① سجل التسليم لا يُقرأ مباشرةً');

  -- حذف: مدير الشركة نفسها يحذف، ومعه سجل تسليمه
  PERFORM t.ok((t.call(t.u('OA'), format('public.company_webhook_delete(%L)', v_id))->>'deleted')::boolean,
    '① الحذف ناجح');
  PERFORM t.ok(t.call(t.u('OA'), format('public.company_webhook_list(%L)', t.u('CA'))) = '[]'::jsonb, '① القائمة فارغة بعد الحذف');
  PERFORM t.ok((SELECT count(*) FROM public.company_webhook_deliveries WHERE webhook_id = v_id) = 0,
    '① سجل التسليم حُذف مع الـWebhook');
END $$;

-- ══ ② بيئة المفتاح ═════════════════════════════════════════════════════
DO $$
DECLARE v_env text;
BEGIN
  -- صف بلا بيئة صريحة يأخذ الافتراضي live
  INSERT INTO public.api_tokens (user_id, name, api_key, secret_hash, secret_last_four)
  VALUES (t.u('OA'), 'مفتاح قائم', 'mad3oom_pk_live1', 'hash-live', 'live');
  SELECT environment INTO v_env FROM public.api_tokens WHERE api_key = 'mad3oom_pk_live1';
  PERFORM t.ok(v_env = 'live', '② الافتراضي live');

  INSERT INTO public.api_tokens (user_id, name, api_key, secret_hash, secret_last_four, environment)
  VALUES (t.u('OA'), 'مفتاح اختبار', 'mad3oom_pk_test_abc', 'hash-test', 'test', 'test');
  SELECT environment INTO v_env FROM public.api_tokens WHERE api_key = 'mad3oom_pk_test_abc';
  PERFORM t.ok(v_env = 'test', '② مفتاح اختبار يُخزَّن ببيئته');

  BEGIN
    INSERT INTO public.api_tokens (user_id, name, api_key, secret_hash, secret_last_four, environment)
    VALUES (t.u('OA'), 'مفتاح فاسد', 'mad3oom_pk_x', 'hash-x', 'xxxx', 'staging');
    RAISE EXCEPTION 'FAIL ②: قُبلت بيئة غير صالحة';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS ②: بيئة غير live/test مرفوضة بالقيد';
  END;
END $$;

-- ══ ③ الفائقة تشمل واتساب — بلا أي تغيير سعر ═══════════════════════════
DO $$
DECLARE
  v_count integer; q jsonb; r jsonb;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.plan_features pf JOIN public.subscription_plans sp ON sp.id = pf.plan_id
   WHERE sp.key = 'ultimate' AND pf.enabled
     AND pf.feature_key IN ('whatsapp_sender', 'whatsapp_autoreply', 'whatsapp_campaigns', 'whatsapp_wallet');
  PERFORM t.ok(v_count = 4, '③ الفائقة تحمل مفاتيح واتساب الأربعة');

  PERFORM t.ok((SELECT price_monthly FROM public.subscription_plans WHERE key = 'ultimate') = 1999, '③ سعر الفائقة الشهري 1999');
  PERFORM t.ok((SELECT price_yearly FROM public.subscription_plans WHERE key = 'ultimate') = 19999, '③ سعر الفائقة السنوي 19999');
  PERFORM t.ok((SELECT price_monthly FROM public.subscription_plans WHERE key = 'whatsapp') = 1299, '③ سعر واتساب 1299');
  PERFORM t.ok((SELECT price_yearly FROM public.subscription_plans WHERE key = 'whatsapp') = 12999, '③ سعر واتساب السنوي 12999');
  PERFORM t.ok((SELECT price_monthly FROM public.subscription_plans WHERE key = 'bundle') = 2099, '③ سعر الشاملة 2099');
  PERFORM t.ok((SELECT price_yearly FROM public.subscription_plans WHERE key = 'bundle') = 22999, '③ سعر الشاملة السنوي 22999');
  PERFORM t.ok((SELECT is_active FROM public.subscription_plans WHERE key = 'whatsapp'), '③ واتساب تبقى مفعّلة (مخفية من البيع في الواجهة فقط)');
  PERFORM t.ok((SELECT is_active FROM public.subscription_plans WHERE key = 'bundle'), '③ الشاملة تبقى مفعّلة');

  -- مالك دعم فني + واتساب: اشتراك واتساب إضافي لـOA (الدعم ينتهي بعده فيبقى هو الجاري).
  -- العرض مؤهل، والمضاف إليه unlimited_tickets فقط — واتساب يملكه أصلًا،
  -- فالفائقة هنا توحّد اشتراكيه لا تضيف واتساب من جديد.
  INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, company_id)
  VALUES (t.u('OA'), 'whatsapp', 'active', 'monthly', now() - interval '5 days', now() + interval '20 days', 30, t.u('CA'));

  q := t.call(t.u('OA'), 'public.subscription_upgrade_quote(''ultimate'')');
  PERFORM t.ok((q->>'eligible')::boolean, '③ ترقية دعم+واتساب ← الفائقة مؤهلة');
  PERFORM t.ok(q->'added_features' @> '["unlimited_tickets"]'::jsonb, '③ العرض يسمّي unlimited_tickets ضمن المضاف');

  -- مالك الدعم وحده (OB): هنا تظهر الدلتا — قبل 141 كان المضاف
  -- unlimited_tickets وحده، وبعدها تنضم مفاتيح واتساب الأربعة.
  q := t.call(t.u('OB'), 'public.subscription_upgrade_quote(''ultimate'')');
  PERFORM t.ok((q->>'eligible')::boolean, '③ ترقية دعم وحده ← الفائقة مؤهلة');
  PERFORM t.ok(q->'added_features' @> '["whatsapp_sender"]'::jsonb, '③ العرض يسمّي whatsapp_sender ضمن المضاف');
  PERFORM t.ok(q->'added_features' @> '["whatsapp_autoreply"]'::jsonb, '③ العرض يسمّي whatsapp_autoreply ضمن المضاف');
  PERFORM t.ok(q->'added_features' @> '["whatsapp_campaigns"]'::jsonb, '③ العرض يسمّي whatsapp_campaigns ضمن المضاف');
  PERFORM t.ok(q->'added_features' @> '["whatsapp_wallet"]'::jsonb, '③ العرض يسمّي whatsapp_wallet ضمن المضاف');
  PERFORM t.ok(q->'added_features' @> '["unlimited_tickets"]'::jsonb, '③ العرض يسمّي unlimited_tickets ضمن المضاف');

  r := t.call(t.u('OB'), 'public.subscription_purchase_check(''ultimate'', false)');
  PERFORM t.ok((r->>'allowed')::boolean, '③ شراء الفائقة لمالك دعم مسموح');
  PERFORM t.ok(r->'new_features' @> '["whatsapp_sender"]'::jsonb, '③ فحص الشراء يسمّي واتساب ضمن الجديد');

  -- ══ ④ الحدّ الموثّق ═════════════════════════════════════════════════
  -- مالك الشاملة: مجموعتا المزايا متطابقتان (10 = 10) والفائقة أرخص،
  -- فالترقية إليها تبقى redundant — وهذا سلوك صحيح لا انحدار.
  INSERT INTO public.whatsapp_subscriptions (user_id, plan, status, billing_cycle, start_date, end_date, duration_days, company_id)
  VALUES (t.u('OB'), 'bundle', 'active', 'monthly', now() - interval '5 days', now() + interval '25 days', 30, t.u('CB'));
  q := t.call(t.u('OB'), 'public.subscription_upgrade_quote(''ultimate'')');
  PERFORM t.ok(q->>'code' = 'redundant', '④ الشاملة ← الفائقة تبقى redundant (مجموعتا المزايا متطابقتان)');
END $$;

-- ══ التراجع يعيد الحالة ════════════════════════════════════════════════
\i migrations/_rollback/141_saas_developers_pricing.down.sql
DO $$
BEGIN
  PERFORM t.ok(to_regprocedure('public.company_webhook_create(uuid,text,text,text[])') IS NULL, '⓪ التراجع حذف دوال Webhooks');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'api_tokens' AND column_name = 'environment'), '⓪ التراجع حذف عمود environment');
  PERFORM t.ok((SELECT count(*) FROM public.plan_features pf JOIN public.subscription_plans sp ON sp.id = pf.plan_id
    WHERE sp.key = 'ultimate' AND pf.feature_key LIKE 'whatsapp%') = 0, '⓪ التراجع حذف واتساب من الفائقة');
END $$;
\i migrations/141_saas_developers_pricing.sql
DO $$
BEGIN
  PERFORM t.ok(to_regprocedure('public.company_webhook_create(uuid,text,text,text[])') IS NOT NULL, '⓪ إعادة التطبيق تنجح بعد التراجع');
END $$;

SELECT 'ALL 141 PASS';
