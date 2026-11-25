-- ============================================================================
-- 133_owner_store_price_and_sync_actions.sql
--   أولويات صفحة المتاجر (owner/stores.html): سعر باقة المتاجر من الواجهة،
--   وإجراءات تشغيل للمالك على روابط Shopify، وحالة امتياز متجر الاختبار.
--
--   • owner_set_store_plan_price: سعر باقة 'store' فقط (بلا معامل مفتاح، فلا
--     خطة أخرى تُمس)، بسعرين موجبين وعملة EGP ثابتة، وتفعيل اختياري. يتطلب
--     owner_critical_ok() ويُسجَّل في log_privileged. قيد 118
--     (subscription_plans_store_priced) يحمي التفعيل بلا سعرين أيضًا.
--   • owner_ihub_sync_request / owner_ihub_events_retry: بديل المالك عن
--     ihub_sync_request / ihub_events_retry في 119 — لا يمران عبر
--     _ihub_shopify_admin (الذي يتطلب سياق مدير المتجر نفسه، فيرفض المالك)،
--     بل عبر _owner_require() فقط، مع نفس حد الدقيقتين ونفس منطق إعادة
--     الأحداث الميتة (آخر 7 أيام)، وتدقيق في _ihub_audit بفاعل 'user'.
--   • owner_store_test_status: قراءة حالة امتياز متجر الاختبار — شركة المالك
--     مباشرة من companies حيث user_id=auth.uid() (بلا بحث نصي)، مع
--     الامتيازات الثلاث والأيام المتبقية.
--
-- يعتمد على 118 و 119 و 121 (كلها على main). قابل لإعادة التشغيل.
-- التراجع: migrations/_rollback/133_owner_store_price_and_sync_actions.down.sql
--   (يحذف الدوال الأربع فقط؛ الأسعار المحدَّدة بيانات لا يسترجعها التراجع).
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public._owner_require()', 'public.owner_critical_ok()',
    'public.log_privileged(text,uuid,jsonb,jsonb)',
    'public._ihub_enqueue_sync(uuid,text,uuid)', 'public._ihub_audit(uuid,uuid,text,text,jsonb)'] loop
    if to_regprocedure(f) is null then
      raise exception '133 يتطلب %', f;
    end if;
  end loop;
  if to_regclass('public.subscription_plans') is null or to_regclass('public.ihub_connections') is null
     or to_regclass('public.ihub_providers') is null or to_regclass('public.ihub_webhook_events') is null
     or to_regclass('public.ihub_sync_jobs') is null or to_regclass('public.companies') is null
     or to_regclass('public.company_feature_overrides') is null then
    raise exception '133 يتطلب جداول 088 و 092 و 118 و 119';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'subscription_plans_store_priced') then
    raise exception '133 يتطلب قيد 118 (subscription_plans_store_priced)';
  end if;
end $$;


-- ============================================================================
-- 1) سعر باقة المتاجر — المالك وحده، بتحقق حديث، للباقة 'store' فقط
-- ============================================================================
create or replace function public.owner_set_store_plan_price(p_monthly numeric, p_yearly numeric,
                                                            p_activate boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_old       jsonb;
  v_new       jsonb;
  v_activated boolean := false;
begin
  if not public.owner_critical_ok() then
    raise exception 'سعر باقة المتاجر لمالك المنصة في سياقه وبتحقق حديث' using errcode = '42501';
  end if;
  if p_monthly is null or p_yearly is null or p_monthly <= 0 or p_yearly <= 0 then
    raise exception 'السعران الشهري والسنوي موجبان (بالجنيه)' using errcode = '22023';
  end if;
  select jsonb_build_object('key', key, 'is_active', is_active, 'price_monthly', price_monthly,
                            'price_yearly', price_yearly, 'currency', currency)
    into v_old from public.subscription_plans where key = 'store';
  if v_old is null then
    raise exception 'باقة المتاجر غير موجودة (118 غير مطبّق)' using errcode = 'P0002';
  end if;
  v_activated := coalesce(p_activate, false) and not (v_old->>'is_active')::boolean;
  update public.subscription_plans
     set price_monthly = p_monthly, price_yearly = p_yearly, currency = 'EGP',
         is_active = case when coalesce(p_activate, false) then true else is_active end
   where key = 'store'
   returning jsonb_build_object('key', key, 'is_active', is_active, 'price_monthly', price_monthly,
                                'price_yearly', price_yearly, 'currency', currency)
    into v_new;
  perform public.log_privileged('store.plan_price', null, v_old,
    v_new || jsonb_build_object('activated', v_activated));
  return v_new || jsonb_build_object('activated', v_activated);
end $$;
comment on function public.owner_set_store_plan_price(numeric, numeric, boolean) is
  '133: سعر باقة المتاجر (store) فقط — لا معامل مفتاح، فلا خطة أخرى تُمس. التفعيل مع السعرين فقط.';


-- ============================================================================
-- 2) مزامنة يدوية لرابط Shopify — المالك، بلا سياق مدير المتجر
--    نفس حد الدقيقتين في ihub_sync_request (119)، ونفس _ihub_enqueue_sync.
-- ============================================================================
create or replace function public.owner_ihub_sync_request(p_connection uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r     public.ihub_connections;
  v_job jsonb;
begin
  perform public._owner_require();
  select * into r from public.ihub_connections where id = p_connection and provider = 'shopify';
  if not found then
    raise exception 'الربط غير موجود' using errcode = 'P0002';
  end if;
  if r.status not in ('active', 'error') then
    raise exception 'الربط يحتاج إعادة تفويض أولًا' using errcode = '22023', detail = '{"code":"reauth_required"}';
  end if;
  if not exists (select 1 from public.ihub_providers p where p.key = 'shopify' and p.enabled) then
    raise exception 'هذا المزوّد غير متاح حاليًا' using errcode = '22023', detail = '{"code":"provider_disabled"}';
  end if;
  if exists (select 1 from public.ihub_sync_jobs j where j.connection_id = r.id
                and j.status in ('succeeded', 'dead', 'cancelled') and j.finished_at > now() - interval '2 minutes')
     and not exists (select 1 from public.ihub_sync_jobs j where j.connection_id = r.id
                       and j.status in ('queued', 'running', 'failed')) then
    raise exception 'انتظر دقيقتين بين كل مزامنة وأخرى' using errcode = 'P0001', detail = '{"code":"rate_limited"}';
  end if;
  v_job := public._ihub_enqueue_sync(r.id, 'manual', auth.uid());
  perform public._ihub_audit(r.company_id, r.id, 'user', 'sync.requested',
    jsonb_build_object('job_id', v_job->'job_id', 'via', 'owner'));
  return v_job;
end $$;
comment on function public.owner_ihub_sync_request(uuid) is
  '133: مزامنة يدوية لربط Shopify من لوحة المالك — إجراء تشغيلي مُدقَّق، لا قرار مالي.';


-- ============================================================================
-- 3) إعادة الأحداث الميتة (آخر 7 أيام) إلى الطابور — المالك
--    نفس منطق ihub_events_retry (119): dead فقط، وexternal_type غير null.
-- ============================================================================
create or replace function public.owner_ihub_events_retry(p_connection uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r   public.ihub_connections;
  v_n int;
begin
  perform public._owner_require();
  select * into r from public.ihub_connections where id = p_connection and provider = 'shopify';
  if not found then
    raise exception 'الربط غير موجود' using errcode = 'P0002';
  end if;
  if r.status = 'disconnected' then
    raise exception 'الربط مفصول' using errcode = '22023';
  end if;
  update public.ihub_webhook_events
     set status = 'queued', attempts = 0, next_attempt_at = now(), last_error_code = null
   where connection_id = r.id and status = 'dead' and received_at > now() - interval '7 days'
     and external_type is not null;
  get diagnostics v_n = row_count;
  perform public._ihub_audit(r.company_id, r.id, 'user', 'events.retried',
    jsonb_build_object('count', v_n, 'via', 'owner'));
  return jsonb_build_object('requeued', v_n);
end $$;
comment on function public.owner_ihub_events_retry(uuid) is
  '133: إعادة الأحداث الميتة (آخر 7 أيام) إلى الطابور من لوحة المالك.';


-- ============================================================================
-- 4) حالة امتياز متجر الاختبار — قراءة للمالك، بلا بحث نصي
--    شركة المالك مباشرة من companies حيث user_id=auth.uid().
-- ============================================================================
create or replace function public.owner_store_test_status()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_name    text;
  v_kind    text;
begin
  perform public._owner_require();
  select c.id, c.company_name, c.account_kind into v_company, v_name, v_kind
    from public.companies c where c.user_id = auth.uid() order by c.created_at asc limit 1;
  return jsonb_build_object(
    'company_id', v_company, 'company_name', v_name, 'account_kind', v_kind,
    'has_company', v_company is not null,
    'is_test_store', coalesce(v_kind = 'ecommerce_store', false),
    'entitlements', (select coalesce(jsonb_agg(jsonb_build_object(
        'feature_key', f.feature_key,
        'granted', o.company_id is not null,
        'active', o.company_id is not null and (o.expires_at is null or o.expires_at > now()),
        'granted_at', o.granted_at, 'expires_at', o.expires_at,
        'days_remaining', case when o.expires_at is null then null
                               when o.expires_at <= now() then 0
                               else ceil(extract(epoch from (o.expires_at - now())) / 86400)::int end)
        order by f.feature_key), '[]'::jsonb)
      from unnest(array['integrations_hub', 'shopify_integration', 'store_support']) f(feature_key)
      left join public.company_feature_overrides o
        on o.company_id = v_company and o.feature_key = f.feature_key));
end $$;
comment on function public.owner_store_test_status() is
  '133: حالة امتيازات متجر الاختبار لشركة المالك — قراءة وصفية، بلا رموز.';


-- ============================================================================
-- 5) الصلاحيات — على نمط 119 فقرة 12: authenticated وحده، بلا anon
-- ============================================================================
do $$
declare
  f text;
  v_owner text[] := array[
    'public.owner_set_store_plan_price(numeric,numeric,boolean)',
    'public.owner_ihub_sync_request(uuid)',
    'public.owner_ihub_events_retry(uuid)',
    'public.owner_store_test_status()'];
begin
  foreach f in array v_owner loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
  foreach f in array v_owner loop
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;


-- ============================================================================
-- 6) تحقق ذاتي — على نمط 130: الحارس في النص، والصلاحيات كما أُعلنت
-- ============================================================================
do $$
declare
  v_def text;
  f text;
  v_owner text[] := array[
    'public.owner_set_store_plan_price(numeric,numeric,boolean)',
    'public.owner_ihub_sync_request(uuid)',
    'public.owner_ihub_events_retry(uuid)',
    'public.owner_store_test_status()'];
begin
  v_def := pg_get_functiondef('public.owner_set_store_plan_price(numeric,numeric,boolean)'::regprocedure);
  if v_def not like '%owner_critical_ok%' then
    raise exception '133: owner_critical_ok() غائب من owner_set_store_plan_price()';
  end if;
  if v_def not like '%key = ''store''%' then
    raise exception '133: نطاق key = ''store'' غائب من owner_set_store_plan_price()';
  end if;
  v_def := pg_get_functiondef('public.owner_ihub_sync_request(uuid)'::regprocedure);
  if v_def not like '%_owner_require%' or v_def not like '%_ihub_enqueue_sync%' then
    raise exception '133: owner_ihub_sync_request() بلا حارس المالك أو بلا _ihub_enqueue_sync';
  end if;
  if v_def like '%_ihub_shopify_admin%' then
    raise exception '133: owner_ihub_sync_request() يجب ألا يمر عبر _ihub_shopify_admin';
  end if;
  v_def := pg_get_functiondef('public.owner_ihub_events_retry(uuid)'::regprocedure);
  if v_def not like '%_owner_require%' then
    raise exception '133: _owner_require() غائب من owner_ihub_events_retry()';
  end if;
  if v_def like '%_ihub_shopify_admin%' then
    raise exception '133: owner_ihub_events_retry() يجب ألا يمر عبر _ihub_shopify_admin';
  end if;
  v_def := pg_get_functiondef('public.owner_store_test_status()'::regprocedure);
  if v_def not like '%_owner_require%' or v_def not like '%user_id = auth.uid()%' then
    raise exception '133: owner_store_test_status() بلا حارس المالك أو بلا user_id = auth.uid()';
  end if;
  foreach f in array v_owner loop
    if has_function_privilege('anon', f::regprocedure, 'EXECUTE') then
      raise exception '133: دالة مكشوفة لـ anon: %', f;
    end if;
    if not has_function_privilege('authenticated', f::regprocedure, 'EXECUTE') then
      raise exception '133: دالة غير ممنوحة لـ authenticated: %', f;
    end if;
  end loop;
  raise notice '133: سعر باقة المتاجر وإجراءات مزامنة المالك وحالة متجر الاختبار جاهزة';
end $$;


-- ============================================================================
-- 7) إضافة: إدارة اشتراك متجر عميل كاستثناء من المالك + الستة المقترحات
--    (قرارات محمود — نفس الفرع، بلا دمج ولا تطبيق حي)
--
--   قواعد موثّقة هنا لأنها قرارات تصميم لا نصوص قاعدة قديمة:
--   • duration_days دائمًا سقف (end_date − start_date) بالأيام، ويُعاد حسابه
--     مع كل تعديل للانتهاء — فيتغيّر مع تحويل الدورة والاستئناف.
--   • المنح كاستثناء يُرفض إن كان للشركة اشتراك متجر فعّال أو متوقف لم ينتهِ
--     بعد: المتوقف يُستأنف، لا يُمنح فوقه اشتراك ثانٍ.
--   • تحويل الدورة أثناء الإيقاف يحفظ الدورة الجديدة فقط (بلا تغيير للانتهاء
--     المجمّد)؛ وعند الاستئناف تبدأ الدورة الجديدة كاملة من لحظة الاستئناف
--     (end_date = now() + الدورة الجديدة)، وتُمسح العلامة.
--   • الأسعار تُقرأ من subscription_plans (مصدر الحقيقة الوحيد) لا من أرقام
--     مكتوبة هنا؛ null تعني «لم تُحدد بعد» فيُرفض المنح/التحويل.
--   • حالة 'paused' جديدة: قيد 019 كان يقبل active/expired/pending/rejected/
--     superseded فقط، فوُسّع هنا ووثّق. المتوقف ليس فعّالًا في أي مكان لأن
--     الصلاحية الفعّالة تُحسب بـ status='active' و end_date>now.
-- ============================================================================


-- ============================================================================
-- 7أ) مخطط الإيقاف المؤقت
-- ============================================================================
alter table public.whatsapp_subscriptions add column if not exists paused_at timestamptz;
comment on column public.whatsapp_subscriptions.paused_at is
  '133: لحظة إيقاف الاشتراك مؤقتًا. الاستئناف يمدّد end_date بمقدار التوقف.';
do $$
begin
  alter table public.whatsapp_subscriptions drop constraint if exists whatsapp_subscriptions_status_check;
  alter table public.whatsapp_subscriptions
    add constraint whatsapp_subscriptions_status_check
    check (status = any (array['active','expired','pending','rejected','superseded','paused']));
end $$;


-- ============================================================================
-- 7ب) المتطلبات الإضافية
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.recompute_user_access(uuid)',
    'public.admin_review_company_account_request(uuid,text,text)'] loop
    if to_regprocedure(f) is null then
      raise exception '133 يتطلب %', f;
    end if;
  end loop;
  if to_regclass('public.subscription_audit_log') is null or to_regclass('public.plan_ticket_quotas') is null
     or to_regclass('public.plan_features') is null or to_regclass('public.ihub_providers') is null
     or to_regclass('public.company_account_requests') is null or to_regclass('public.privileged_audit') is null
     or to_regclass('public.ihub_audit_events') is null then
    raise exception '133 يتطلب جداول 018 و 065 و 068 و 088 و 092 و 119';
  end if;
end $$;


-- ============================================================================
-- 7ج) مسنَدات داخلية (بلا منح — تُستدعى من دوال المالك فقط)
-- ============================================================================
create or replace function public._store_reason(p_reason text)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare v text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v is null or char_length(v) < 10 then
    raise exception 'السبب مطلوب (10 أحرف على الأقل)' using errcode = '22023';
  end if;
  return v;
end $$;

create or replace function public._store_audit(p_subscription uuid, p_action text, p_old jsonb, p_new jsonb, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_user uuid;
begin
  select user_id into v_user from public.whatsapp_subscriptions where id = p_subscription;
  insert into public.subscription_audit_log
    (subscription_id, target_user_id, actor_user_id, actor_email, action, old_values, new_values, reason)
  values (p_subscription, v_user, auth.uid(), (select email from public.profiles where id = auth.uid()),
          p_action, p_old, p_new, nullif(btrim(coalesce(p_reason, '')), ''));
end $$;

create or replace function public._store_subscription_json(p_subscription uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'id', s.id, 'user_id', s.user_id, 'company_id', s.company_id, 'plan', s.plan,
    'billing_cycle', s.billing_cycle, 'status', s.status, 'start_date', s.start_date,
    'end_date', s.end_date, 'duration_days', s.duration_days, 'payment_method', s.payment_method,
    'price_snapshot', coalesce(s.price_snapshot, '{}'::jsonb), 'paused_at', s.paused_at,
    'effective', s.status = 'active' and s.end_date > now(),
    'days_remaining', case when s.status = 'paused' and s.paused_at is not null
                           then greatest(0, ceil(extract(epoch from (s.end_date - s.paused_at)) / 86400)::int)
                           when s.end_date > now() then ceil(extract(epoch from (s.end_date - now())) / 86400)::int
                           else 0 end)
    from public.whatsapp_subscriptions s where s.id = p_subscription;
$$;


-- ============================================================================
-- 8) منح باقة المتاجر لعميل بدون شراء (استثناء من المالك)
--    الأسعار من subscription_plans (500/5000 بعد إدخالها من النموذج)؛
--    المبلغ 0 وعلامة exception=true في price_snapshot.
-- ============================================================================
create or replace function public.owner_store_grant_exception(p_company uuid, p_billing_cycle text,
                                                             p_end_date timestamptz, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_co     public.companies%rowtype;
  v_reason text;
  v_m      numeric;
  v_y      numeric;
  v_price  numeric;
  v_days   int;
  v_sub    public.whatsapp_subscriptions%rowtype;
begin
  if not public.owner_critical_ok() then
    raise exception 'منح باقة المتاجر لمالك المنصة في سياقه وبتحقق حديث' using errcode = '42501';
  end if;
  v_reason := public._store_reason(p_reason);
  if p_billing_cycle is null or p_billing_cycle not in ('monthly', 'yearly') then
    raise exception 'دورة فوترة غير صالحة' using errcode = '22023';
  end if;
  if p_end_date is null or p_end_date <= now() or p_end_date > now() + interval '1 year' then
    raise exception 'تاريخ الانتهاء في المستقبل وبحد أقصى سنة من الآن' using errcode = '22023';
  end if;
  select * into v_co from public.companies where id = p_company;
  if not found then
    raise exception 'الشركة غير موجودة' using errcode = 'P0002';
  end if;
  if v_co.account_kind <> 'ecommerce_store' then
    raise exception 'المنح كاستثناء لمتجر إلكتروني فقط' using errcode = '22023';
  end if;
  if exists (select 1 from public.whatsapp_subscriptions s where s.company_id = p_company and s.plan = 'store'
              and s.status in ('active', 'paused') and s.end_date > now()) then
    raise exception 'للشركة اشتراك متجر قائم (فعّال أو متوقف) — استأنف المتوقف أو عدّل القائم' using errcode = '22023';
  end if;
  select price_monthly, price_yearly into v_m, v_y from public.subscription_plans where key = 'store';
  if v_m is null or v_y is null then
    raise exception 'حدّد سعر باقة المتاجر أولًا (owner_set_store_plan_price)' using errcode = '22023';
  end if;
  v_price := case when p_billing_cycle = 'yearly' then v_y else v_m end;
  v_days := greatest(1, ceil(extract(epoch from (p_end_date - now())) / 86400)::int);
  insert into public.whatsapp_subscriptions
    (user_id, company_id, plan, billing_cycle, status, start_date, end_date, duration_days,
     payment_method, payment_reference, price_snapshot, reviewed_by, reviewed_at)
  values (v_co.user_id, v_co.id, 'store', p_billing_cycle, 'active', now(), p_end_date, v_days,
          'owner_exception', left(v_reason, 300),
          jsonb_build_object('plan_price_monthly', v_m, 'plan_price_yearly', v_y, 'cycle_price', v_price,
                             'amount', 0, 'currency', 'EGP', 'exception', true, 'billing_cycle', p_billing_cycle),
          auth.uid(), now())
  returning * into v_sub;
  perform public.recompute_user_access(v_co.user_id);
  perform public._store_audit(v_sub.id, 'grant_exception', null,
    jsonb_build_object('status', 'active', 'billing_cycle', p_billing_cycle, 'end_date', p_end_date, 'price', v_price), v_reason);
  perform public.log_privileged('store.grant_exception', null, null,
    jsonb_build_object('company_id', v_co.id, 'subscription_id', v_sub.id, 'billing_cycle', p_billing_cycle,
                       'end_date', p_end_date, 'reason', left(v_reason, 300)));
  return public._store_subscription_json(v_sub.id);
end $$;
comment on function public.owner_store_grant_exception(uuid, text, timestamptz, text) is
  '133: منح باقة المتاجر لمتجر عميل بدون شراء — استثناء مالك بتحقق حديث وسبب، مبلغ 0.';


-- ============================================================================
-- 9) قراءة اشتراك المتجر الأحدث لشركة (للواجهة — لا مصدر صلاحية)
-- ============================================================================
create or replace function public.owner_store_subscription(p_company uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v_id uuid;
begin
  perform public._owner_require();
  select s.id into v_id from public.whatsapp_subscriptions s
   where s.company_id = p_company and s.plan = 'store'
   order by s.created_at desc limit 1;
  if v_id is null then return null; end if;
  return public._store_subscription_json(v_id);
end $$;


-- ============================================================================
-- 10) تعديل تاريخ انتهاء اشتراك متجر
-- ============================================================================
create or replace function public.owner_store_set_end_date(p_subscription uuid, p_end_date timestamptz, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_sub    public.whatsapp_subscriptions%rowtype;
  v_reason text;
  v_days   int;
begin
  if not public.owner_critical_ok() then
    raise exception 'تعديل اشتراك المتجر لمالك المنصة في سياقه وبتحقق حديث' using errcode = '42501';
  end if;
  v_reason := public._store_reason(p_reason);
  select * into v_sub from public.whatsapp_subscriptions where id = p_subscription;
  if not found then
    raise exception 'الاشتراك غير موجود' using errcode = 'P0002';
  end if;
  if v_sub.plan <> 'store' then
    raise exception 'هذه الدالة لاشتراكات المتاجر فقط' using errcode = '22023';
  end if;
  if p_end_date is null or p_end_date <= now() or p_end_date <= v_sub.start_date then
    raise exception 'تاريخ الانتهاء الجديد في المستقبل وبعد البداية' using errcode = '22023';
  end if;
  v_days := greatest(1, ceil(extract(epoch from (p_end_date - v_sub.start_date)) / 86400)::int);
  update public.whatsapp_subscriptions
     set end_date = p_end_date, duration_days = v_days, updated_at = now()
   where id = p_subscription;
  perform public.recompute_user_access(v_sub.user_id);
  perform public._store_audit(p_subscription, 'set_end_date',
    jsonb_build_object('end_date', v_sub.end_date, 'duration_days', v_sub.duration_days),
    jsonb_build_object('end_date', p_end_date, 'duration_days', v_days), v_reason);
  perform public.log_privileged('store.subscription_end_date', null,
    jsonb_build_object('subscription_id', p_subscription, 'end_date', v_sub.end_date),
    jsonb_build_object('subscription_id', p_subscription, 'end_date', p_end_date, 'reason', left(v_reason, 300)));
  return public._store_subscription_json(p_subscription);
end $$;


-- ============================================================================
-- 11) إيقاف اشتراك المتجر مؤقتًا ثم استئنافه
--     الإيقاف من active فقط؛ الاستئناف من paused فقط ويمدّد end_date بمقدار
--     التوقف — إلا إن حُوّلت الدورة أثناء الإيقاف، فتبدأ الدورة الجديدة كاملة
--     من لحظة الاستئناف (انظر owner_store_change_cycle).
-- ============================================================================
create or replace function public.owner_store_pause(p_subscription uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_sub    public.whatsapp_subscriptions%rowtype;
  v_reason text;
begin
  if not public.owner_critical_ok() then
    raise exception 'إيقاف اشتراك المتجر لمالك المنصة في سياقه وبتحقق حديث' using errcode = '42501';
  end if;
  v_reason := public._store_reason(p_reason);
  select * into v_sub from public.whatsapp_subscriptions where id = p_subscription;
  if not found then
    raise exception 'الاشتراك غير موجود' using errcode = 'P0002';
  end if;
  if v_sub.plan <> 'store' then
    raise exception 'هذه الدالة لاشتراكات المتاجر فقط' using errcode = '22023';
  end if;
  if v_sub.status <> 'active' then
    raise exception 'الإيقاف من اشتراك فعّال فقط' using errcode = '22023';
  end if;
  update public.whatsapp_subscriptions
     set status = 'paused', paused_at = now(), updated_at = now()
   where id = p_subscription;
  perform public.recompute_user_access(v_sub.user_id);
  perform public._store_audit(p_subscription, 'pause',
    jsonb_build_object('status', 'active'), jsonb_build_object('status', 'paused'), v_reason);
  perform public.log_privileged('store.subscription_pause', null,
    jsonb_build_object('subscription_id', p_subscription, 'status', 'active'),
    jsonb_build_object('subscription_id', p_subscription, 'status', 'paused', 'reason', left(v_reason, 300)));
  return public._store_subscription_json(p_subscription);
end $$;

create or replace function public.owner_store_resume(p_subscription uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_sub    public.whatsapp_subscriptions%rowtype;
  v_reason text;
  v_new_end timestamptz;
  v_days   int;
  v_snap   jsonb;
begin
  if not public.owner_critical_ok() then
    raise exception 'استئناف اشتراك المتجر لمالك المنصة في سياقه وبتحقق حديث' using errcode = '42501';
  end if;
  v_reason := public._store_reason(p_reason);
  select * into v_sub from public.whatsapp_subscriptions where id = p_subscription;
  if not found then
    raise exception 'الاشتراك غير موجود' using errcode = 'P0002';
  end if;
  if v_sub.plan <> 'store' then
    raise exception 'هذه الدالة لاشتراكات المتاجر فقط' using errcode = '22023';
  end if;
  if v_sub.status <> 'paused' or v_sub.paused_at is null then
    raise exception 'الاستئناف من اشتراك متوقف فقط' using errcode = '22023';
  end if;
  v_snap := coalesce(v_sub.price_snapshot, '{}'::jsonb);
  if coalesce((v_snap->>'cycle_changed_while_paused')::boolean, false) then
    v_days := case when v_sub.billing_cycle = 'yearly' then 365 else 30 end;
    v_new_end := now() + make_interval(days => v_days);
    v_snap := v_snap - 'cycle_changed_while_paused';
  else
    v_new_end := v_sub.end_date + (now() - v_sub.paused_at);
  end if;
  v_days := greatest(1, ceil(extract(epoch from (v_new_end - v_sub.start_date)) / 86400)::int);
  update public.whatsapp_subscriptions
     set status = 'active', paused_at = null, end_date = v_new_end, duration_days = v_days,
         price_snapshot = v_snap, updated_at = now()
   where id = p_subscription;
  perform public.recompute_user_access(v_sub.user_id);
  perform public._store_audit(p_subscription, 'resume',
    jsonb_build_object('status', 'paused', 'end_date', v_sub.end_date),
    jsonb_build_object('status', 'active', 'end_date', v_new_end), v_reason);
  perform public.log_privileged('store.subscription_resume', null,
    jsonb_build_object('subscription_id', p_subscription, 'status', 'paused', 'end_date', v_sub.end_date),
    jsonb_build_object('subscription_id', p_subscription, 'status', 'active', 'end_date', v_new_end,
                       'reason', left(v_reason, 300)));
  return public._store_subscription_json(p_subscription);
end $$;


-- ============================================================================
-- 12) تحويل دورة اشتراك المتجر شهري ⇄ سنوي — التحويل من اليوم
--     الفعّال: end_date = now() + الدورة الجديدة. المتوقف: تُحفظ الدورة الجديدة
--     فقط (الانتهاء مجمّد)، ويُحسب الانتهاء عند الاستئناف (انظر owner_store_resume).
-- ============================================================================
create or replace function public.owner_store_change_cycle(p_subscription uuid, p_billing_cycle text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_sub    public.whatsapp_subscriptions%rowtype;
  v_reason text;
  v_m      numeric;
  v_y      numeric;
  v_price  numeric;
  v_days   int;
  v_new_end timestamptz;
  v_snap   jsonb;
  v_amount numeric;
begin
  if not public.owner_critical_ok() then
    raise exception 'تحويل دورة اشتراك المتجر لمالك المنصة في سياقه وبتحقق حديث' using errcode = '42501';
  end if;
  v_reason := public._store_reason(p_reason);
  select * into v_sub from public.whatsapp_subscriptions where id = p_subscription;
  if not found then
    raise exception 'الاشتراك غير موجود' using errcode = 'P0002';
  end if;
  if v_sub.plan <> 'store' then
    raise exception 'هذه الدالة لاشتراكات المتاجر فقط' using errcode = '22023';
  end if;
  if p_billing_cycle is null or p_billing_cycle not in ('monthly', 'yearly') then
    raise exception 'دورة فوترة غير صالحة' using errcode = '22023';
  end if;
  if p_billing_cycle = v_sub.billing_cycle then
    raise exception 'الاشتراك على هذه الدورة بالفعل' using errcode = '22023';
  end if;
  if v_sub.status not in ('active', 'paused') then
    raise exception 'تحويل الدورة للاشتراك الفعّال أو المتوقف فقط' using errcode = '22023';
  end if;
  select price_monthly, price_yearly into v_m, v_y from public.subscription_plans where key = 'store';
  if v_m is null or v_y is null then
    raise exception 'حدّد سعر باقة المتاجر أولًا (owner_set_store_plan_price)' using errcode = '22023';
  end if;
  v_price := case when p_billing_cycle = 'yearly' then v_y else v_m end;
  v_snap := coalesce(v_sub.price_snapshot, '{}'::jsonb);
  v_amount := case when coalesce((v_snap->>'exception')::boolean, false) then 0 else v_price end;
  v_snap := v_snap || jsonb_build_object('plan_price_monthly', v_m, 'plan_price_yearly', v_y,
                                         'cycle_price', v_price, 'amount', v_amount, 'billing_cycle', p_billing_cycle);
  if v_sub.status = 'active' then
    v_days := case when p_billing_cycle = 'yearly' then 365 else 30 end;
    v_new_end := now() + make_interval(days => v_days);
    v_days := greatest(1, ceil(extract(epoch from (v_new_end - v_sub.start_date)) / 86400)::int);
    update public.whatsapp_subscriptions
       set billing_cycle = p_billing_cycle, end_date = v_new_end, duration_days = v_days,
           price_snapshot = v_snap, updated_at = now()
     where id = p_subscription;
  else
    v_snap := v_snap || jsonb_build_object('cycle_changed_while_paused', true);
    update public.whatsapp_subscriptions
       set billing_cycle = p_billing_cycle, price_snapshot = v_snap, updated_at = now()
     where id = p_subscription;
    v_new_end := v_sub.end_date;
  end if;
  perform public.recompute_user_access(v_sub.user_id);
  perform public._store_audit(p_subscription, 'change_cycle',
    jsonb_build_object('billing_cycle', v_sub.billing_cycle, 'end_date', v_sub.end_date),
    jsonb_build_object('billing_cycle', p_billing_cycle, 'end_date', v_new_end), v_reason);
  perform public.log_privileged('store.subscription_cycle', null,
    jsonb_build_object('subscription_id', p_subscription, 'billing_cycle', v_sub.billing_cycle),
    jsonb_build_object('subscription_id', p_subscription, 'billing_cycle', p_billing_cycle,
                       'end_date', v_new_end, 'reason', left(v_reason, 300)));
  return public._store_subscription_json(p_subscription);
end $$;

-- ============================================================================
-- 13) تنبيهات المتاجر القابلة للتنفيذ — قراءة من البيانات الموجودة فقط
--     لا إشعار فوري هنا: لا آلية إرسال لتنبيه جديد في القاعدة (notifications
--     تُكتب من مسارات محددة فقط)؛ التنبيهات داخل صفحة المتاجر، ودالة واحدة
--     يقرؤها التقرير الصباحي لاحقًا. بلا أسرار ولا بيانات عملاء.
-- ============================================================================
create or replace function public.owner_store_alerts()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v_alerts jsonb;
begin
  perform public._owner_require();
  select coalesce(jsonb_agg(a order by a.sev, a.title), '[]'::jsonb) into v_alerts from (
    select 1 sev, 'connection_error' kind, 'critical' severity, 'ربط Shopify بخطأ' title,
           co.company_name || ' — ' || c.external_account_id || ' (' || coalesce(c.last_error_code, 'بلا رمز') || ')' detail,
           '#conn-' || c.id::text target, c.company_id, c.id connection_id
      from public.ihub_connections c join public.companies co on co.id = c.company_id
     where c.provider = 'shopify' and c.status = 'error'
    union all
    select 1, 'reauth_required', 'warning', 'ربط يحتاج إعادة تفويض', co.company_name || ' — ' || c.external_account_id,
           '#conn-' || c.id::text, c.company_id, c.id
      from public.ihub_connections c join public.companies co on co.id = c.company_id
     where c.provider = 'shopify' and c.status = 'reauth_required'
    union all
    select 2, 'sync_failed', 'warning', 'آخر مزامنة فاشلة', co.company_name || ' — ' || c.external_account_id,
           '#conn-' || c.id::text, c.company_id, c.id
      from public.ihub_connections c join public.companies co on co.id = c.company_id
     where c.provider = 'shopify' and c.status in ('active', 'error') and c.last_sync_status = 'failed'
    union all
    select 2, 'dead_events', 'warning', 'أحداث ميتة (7 أيام)', co.company_name || ' — ' || n::text || ' حدث',
           '#conn-' || c.id::text, c.company_id, c.id
      from (select e.connection_id, count(*) n from public.ihub_webhook_events e
             where e.status = 'dead' and e.received_at > now() - interval '7 days' group by 1) d
      join public.ihub_connections c on c.id = d.connection_id and c.provider = 'shopify'
      join public.companies co on co.id = c.company_id
    union all
    select 2, 'compliance_pending', 'warning', 'طلبات خصوصية معلّقة', co.company_name || ' — ' || n::text || ' طلب',
           '#storeIntegrations', c.company_id, c.id
      from (select q.connection_id, count(*) n from public.ihub_compliance_requests q
             where q.status = 'received' group by 1) d
      join public.ihub_connections c on c.id = d.connection_id and c.provider = 'shopify'
      join public.companies co on co.id = c.company_id
    union all
    select 3, 'no_entitlement', 'warning', 'ربط حي بلا امتياز شوبيفاي', co.company_name,
           '#storeDiagnostics', co.id, c.id
      from public.ihub_connections c join public.companies co on co.id = c.company_id
     where c.provider = 'shopify' and c.status in ('active', 'error')
       and not exists (select 1 from public.whatsapp_subscriptions s
                        join public.subscription_plans sp on sp.key = s.plan
                        join public.plan_features pf on pf.plan_id = sp.id and pf.enabled
                       where (s.company_id = co.id or s.user_id = co.user_id) and s.status = 'active'
                         and s.start_date <= now() and s.end_date > now() and pf.feature_key = 'shopify_integration')
       and not exists (select 1 from public.company_feature_overrides o where o.company_id = co.id
                        and o.feature_key = 'shopify_integration' and (o.expires_at is null or o.expires_at > now()))
  ) a;
  return jsonb_build_object('alerts', v_alerts, 'count', jsonb_array_length(v_alerts),
    'critical', (select count(*) from jsonb_array_elements(v_alerts) x where x->>'severity' = 'critical'));
end $$;


-- ============================================================================
-- 14) طلبات المتاجر المعلّقة — قراءة + قرار عبر المراجعة القائمة (068)
--     الاعتماد لا يتجاوز صلاحية التنفيذ القائمة: admin_review_company_account_request
--     هي التي تنشئ الشركة (ومحفّز 118 ينقل نوع المتجر إليها)؛ هنا بوابة المالك
--     فقط: سياق مالك + تحقق حديث + سبب ≥10 + تدقيق.
-- ============================================================================
create or replace function public.owner_store_requests()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  perform public._owner_require();
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'user_id', r.user_id, 'customer_name', coalesce(nullif(btrim(p.full_name), ''), p.email),
      'customer_email', p.email, 'company_name', r.company_name, 'requested_plan', r.requested_plan,
      'requested_billing_cycle', r.requested_billing_cycle, 'store_domain_hint', r.store_domain_hint,
      'created_at', r.created_at) order by r.created_at desc), '[]'::jsonb)
    from public.company_account_requests r left join public.profiles p on p.id = r.user_id
   where r.status = 'pending' and r.account_kind = 'ecommerce_store');
end $$;

create or replace function public.owner_store_request_decide(p_request uuid, p_decision text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_req    public.company_account_requests%rowtype;
  v_reason text;
  v_result jsonb;
begin
  if not public.owner_critical_ok() then
    raise exception 'قرار طلب متجر لمالك المنصة في سياقه وبتحقق حديث' using errcode = '42501';
  end if;
  v_reason := public._store_reason(p_reason);
  if p_decision is null or p_decision not in ('approve', 'reject') then
    raise exception 'قرار غير معروف' using errcode = '22023';
  end if;
  select * into v_req from public.company_account_requests where id = p_request for update;
  if not found then
    raise exception 'الطلب غير موجود' using errcode = 'P0002';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'تمت مراجعة هذا الطلب بالفعل' using errcode = '22023';
  end if;
  if v_req.account_kind <> 'ecommerce_store' then
    raise exception 'هذه الصفحة لطلبات المتاجر الإلكترونية فقط' using errcode = '22023';
  end if;
  v_result := public.admin_review_company_account_request(p_request, p_decision, v_reason);
  perform public.log_privileged('store.request_decided', null,
    jsonb_build_object('request_id', p_request, 'company_name', v_req.company_name),
    jsonb_build_object('request_id', p_request, 'decision', p_decision,
                       'company_id', v_result->>'company_id', 'reason', left(v_reason, 300)));
  return v_result || jsonb_build_object('decision', p_decision);
end $$;


-- ============================================================================
-- 15) إعداد باقة المتاجر: حد التذاكر والمزايا
--     monthly_tickets null = بلا حد (065). المزايا: المجموعة الكاملة المرغوبة
--     للباقة — ما ليس في القائمة يُوقف. لا حد افتراضي هنا إطلاقًا.
-- ============================================================================
create or replace function public.owner_store_plan_config()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  perform public._owner_require();
  return jsonb_build_object(
    'ticket_quota', (select monthly_tickets from public.plan_ticket_quotas where plan_key = 'store'),
    'quota_defined', exists (select 1 from public.plan_ticket_quotas where plan_key = 'store'),
    'features', (select coalesce(jsonb_agg(jsonb_build_object('feature_key', pf.feature_key, 'enabled', pf.enabled)
                                           order by pf.feature_key), '[]'::jsonb)
                  from public.plan_features pf join public.subscription_plans sp on sp.id = pf.plan_id
                 where sp.key = 'store'));
end $$;

create or replace function public.owner_set_store_plan_quota_features(p_monthly_quota integer, p_features text[], p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_reason text;
  v_old    jsonb;
  v_plan   uuid;
begin
  if not public.owner_critical_ok() then
    raise exception 'إعداد باقة المتاجر لمالك المنصة في سياقه وبتحقق حديث' using errcode = '42501';
  end if;
  v_reason := public._store_reason(p_reason);
  if p_monthly_quota is not null and p_monthly_quota <= 0 then
    raise exception 'حد التذاكر رقم موجب أو فارغ (بلا حد)' using errcode = '22023';
  end if;
  select id into v_plan from public.subscription_plans where key = 'store';
  if v_plan is null then
    raise exception 'باقة المتاجر غير موجودة (118 غير مطبّق)' using errcode = 'P0002';
  end if;
  if exists (select 1 from unnest(coalesce(p_features, '{}')) f
              where f not in (select feature_key from public.plan_features where plan_id = v_plan)) then
    raise exception 'ميزة غير معروفة لباقة المتاجر' using errcode = '22023';
  end if;
  v_old := public.owner_store_plan_config();
  insert into public.plan_ticket_quotas (plan_key, monthly_tickets) values ('store', p_monthly_quota)
  on conflict (plan_key) do update set monthly_tickets = excluded.monthly_tickets, updated_at = now();
  update public.plan_features set enabled = (feature_key = any (coalesce(p_features, '{}')))
   where plan_id = v_plan;
  perform public.log_privileged('store.plan_quota_features', null, v_old,
    public.owner_store_plan_config() || jsonb_build_object('reason', left(v_reason, 300)));
  return public.owner_store_plan_config();
end $$;


-- ============================================================================
-- 16) سجل عمليات المتاجر — اتحاد سجلات التدقيق الثلاثة، بلا أسرار
-- ============================================================================
create or replace function public.owner_store_operations_log(p_limit int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v_n int := least(greatest(coalesce(p_limit, 30), 1), 100);
begin
  perform public._owner_require();
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'at', x.at, 'source', x.source, 'action', x.action, 'actor_email', x.actor_email, 'summary', x.summary)
      order by x.at desc), '[]'::jsonb)
    from (select * from (
      select a.at, 'privileged' source, a.action,
             (select email from public.profiles where id = a.actor_id) actor_email,
             case a.action
               when 'store.plan_price' then 'سعر باقة المتاجر: شهري ' || (a.new_value->>'price_monthly')
                 || ' / سنوي ' || (a.new_value->>'price_yearly')
                 || case when coalesce((a.new_value->>'activated')::boolean, false) then ' — فُعّلت' else '' end
               when 'store.grant_exception' then 'منح باقة المتاجر كاستثناء — دورة ' || (a.new_value->>'billing_cycle')
               when 'store.subscription_end_date' then 'تعديل انتهاء اشتراك المتجر إلى ' || to_char((a.new_value->>'end_date')::timestamptz, 'YYYY-MM-DD')
               when 'store.subscription_pause' then 'إيقاف اشتراك المتجر مؤقتًا'
               when 'store.subscription_resume' then 'استئناف اشتراك المتجر'
               when 'store.subscription_cycle' then 'تحويل دورة اشتراك المتجر إلى ' || (a.new_value->>'billing_cycle')
               when 'store.request_decided' then 'قرار طلب متجر: ' || (a.new_value->>'decision') || ' — ' || (a.new_value->>'company_name')
               when 'store.plan_quota_features' then 'حد تذاكر باقة المتاجر ومزاياها'
               when 'store.provider_enabled' then 'مزوّد Shopify: ' || case when coalesce((a.new_value->>'enabled')::boolean, false) then 'تشغيل' else 'إيقاف' end
               when 'store.test_entitlements.granted' then 'منح امتيازات متجر الاختبار'
               when 'store.test_entitlements.revoked' then 'سحب امتيازات متجر الاختبار'
               when 'company.account_kind' then 'تغيير نوع شركة إلى ' || (a.new_value->>'account_kind')
               else a.action end summary
        from public.privileged_audit a
       where a.action like 'store.%'
          or (a.action = 'company.account_kind'
              and (a.new_value->>'account_kind' = 'ecommerce_store' or a.old_value->>'account_kind' = 'ecommerce_store'))
      union all
      select l.created_at, 'subscription', l.action, l.actor_email,
             case l.action
               when 'grant_exception' then 'منح باقة المتاجر كاستثناء'
               when 'set_end_date' then 'تعديل انتهاء اشتراك المتجر إلى ' || to_char((l.new_values->>'end_date')::timestamptz, 'YYYY-MM-DD')
               when 'pause' then 'إيقاف اشتراك المتجر مؤقتًا'
               when 'resume' then 'استئناف اشتراك المتجر'
               when 'change_cycle' then 'تحويل دورة اشتراك المتجر إلى ' || (l.new_values->>'billing_cycle')
               else l.action end
        from public.subscription_audit_log l
       where l.action in ('grant_exception', 'set_end_date', 'pause', 'resume', 'change_cycle')
      union all
      select e.created_at, 'ihub', e.action,
             (select email from public.profiles where id = e.actor_id),
             case e.action
               when 'sync.requested' then 'مزامنة يدوية من المالك'
               when 'events.retried' then 'إعادة محاولة أحداث ميتة (' || (e.detail->>'count') || ')'
               else e.action end
        from public.ihub_audit_events e
       where e.action in ('sync.requested', 'events.retried') and e.detail->>'via' = 'owner'
    ) u order by u.at desc limit v_n) x);
end $$;


-- ============================================================================
-- 17) إيقاف/تشغيل مزوّد Shopify — لمزوّد shopify فقط
--     الإيقاف يمنع مزامنة وربطًا جديدًا، ولا يفصل الربوط القائمة.
-- ============================================================================
create or replace function public.owner_set_shopify_provider_enabled(p_enabled boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_reason text;
  v_old    boolean;
  v_new    boolean;
begin
  if not public.owner_critical_ok() then
    raise exception 'تبديل مزوّد Shopify لمالك المنصة في سياقه وبتحقق حديث' using errcode = '42501';
  end if;
  v_reason := public._store_reason(p_reason);
  if p_enabled is null then
    raise exception 'حدّد تشغيلًا أو إيقافًا' using errcode = '22023';
  end if;
  select enabled into v_old from public.ihub_providers where key = 'shopify';
  if v_old is null then
    raise exception 'مزوّد Shopify غير موجود (119 غير مطبّق)' using errcode = 'P0002';
  end if;
  update public.ihub_providers set enabled = p_enabled, updated_at = now() where key = 'shopify'
  returning enabled into v_new;
  perform public.log_privileged('store.provider_enabled', null,
    jsonb_build_object('key', 'shopify', 'enabled', v_old),
    jsonb_build_object('key', 'shopify', 'enabled', v_new, 'reason', left(v_reason, 300)));
  return jsonb_build_object('key', 'shopify', 'enabled', v_new);
end $$;


-- ============================================================================
-- 18) الصلاحيات — الدوال الجديدة على نمط 119 فقرة 12
-- ============================================================================
do $$
declare
  f text;
  v_owner text[] := array[
    'public.owner_store_grant_exception(uuid,text,timestamptz,text)',
    'public.owner_store_subscription(uuid)',
    'public.owner_store_set_end_date(uuid,timestamptz,text)',
    'public.owner_store_pause(uuid,text)',
    'public.owner_store_resume(uuid,text)',
    'public.owner_store_change_cycle(uuid,text,text)',
    'public.owner_store_alerts()',
    'public.owner_store_requests()',
    'public.owner_store_request_decide(uuid,text,text)',
    'public.owner_store_plan_config()',
    'public.owner_set_store_plan_quota_features(integer,text[],text)',
    'public.owner_store_operations_log(integer)',
    'public.owner_set_shopify_provider_enabled(boolean,text)'];
  v_internal text[] := array[
    'public._store_reason(text)',
    'public._store_audit(uuid,text,jsonb,jsonb,text)',
    'public._store_subscription_json(uuid)'];
begin
  foreach f in array v_owner loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
  foreach f in array v_owner loop
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array v_internal loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
end $$;


-- ============================================================================
-- 19) تحقق ذاتي — امتداد فقرة 6: الحراس، وحالة paused، والصلاحيات
-- ============================================================================
do $$
declare
  v_def text;
  f text;
  v_owner text[] := array[
    'public.owner_store_grant_exception(uuid,text,timestamptz,text)',
    'public.owner_store_subscription(uuid)',
    'public.owner_store_set_end_date(uuid,timestamptz,text)',
    'public.owner_store_pause(uuid,text)',
    'public.owner_store_resume(uuid,text)',
    'public.owner_store_change_cycle(uuid,text,text)',
    'public.owner_store_alerts()',
    'public.owner_store_requests()',
    'public.owner_store_request_decide(uuid,text,text)',
    'public.owner_store_plan_config()',
    'public.owner_set_store_plan_quota_features(integer,text[],text)',
    'public.owner_store_operations_log(integer)',
    'public.owner_set_shopify_provider_enabled(boolean,text)'];
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'whatsapp_subscriptions' and column_name = 'paused_at') then
    raise exception '133: عمود paused_at غائب من whatsapp_subscriptions';
  end if;
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid = 'public.whatsapp_subscriptions'::regclass and conname = 'whatsapp_subscriptions_status_check';
  if v_def is null or v_def not like '%paused%' then
    raise exception '133: قيد الحالة لا يقبل paused';
  end if;
  v_def := pg_get_functiondef('public.owner_store_grant_exception(uuid,text,timestamptz,text)'::regprocedure);
  if v_def not like '%owner_critical_ok%' or v_def not like '%ecommerce_store%' then
    raise exception '133: owner_store_grant_exception() بلا تحقق حديث أو بلا قيد المتجر';
  end if;
  v_def := pg_get_functiondef('public.owner_store_request_decide(uuid,text,text)'::regprocedure);
  if v_def not like '%owner_critical_ok%' or v_def not like '%admin_review_company_account_request%' then
    raise exception '133: owner_store_request_decide() بلا تحقق حديث أو بلا تفويض للمراجعة القائمة';
  end if;
  v_def := pg_get_functiondef('public.owner_store_subscription(uuid)'::regprocedure);
  if v_def not like '%_owner_require%' then
    raise exception '133: _owner_require() غائب من owner_store_subscription()';
  end if;
  v_def := pg_get_functiondef('public.owner_store_alerts()'::regprocedure);
  if v_def not like '%_owner_require%' then
    raise exception '133: _owner_require() غائب من owner_store_alerts()';
  end if;
  v_def := pg_get_functiondef('public.owner_set_shopify_provider_enabled(boolean,text)'::regprocedure);
  if v_def not like '%owner_critical_ok%' or v_def not like '%key = ''shopify''%' then
    raise exception '133: owner_set_shopify_provider_enabled() بلا تحقق حديث أو بلا نطاق shopify';
  end if;
  foreach f in array v_owner loop
    if has_function_privilege('anon', f::regprocedure, 'EXECUTE') then
      raise exception '133: دالة مكشوفة لـ anon: %', f;
    end if;
    if not has_function_privilege('authenticated', f::regprocedure, 'EXECUTE') then
      raise exception '133: دالة غير ممنوحة لـ authenticated: %', f;
    end if;
  end loop;
  foreach f in array array['public._store_reason(text)', 'public._store_audit(uuid,text,jsonb,jsonb,text)',
                           'public._store_subscription_json(uuid)'] loop
    if has_function_privilege('authenticated', f::regprocedure, 'EXECUTE') then
      raise exception '133: مسنَد داخلي ممنوح لـ authenticated: %', f;
    end if;
  end loop;
  raise notice '133: إدارة اشتراك المتجر والتنبيهات والطلبات والسجل ومبدّل المزوّد جاهزة';
end $$;

-- ============================================================================
-- 20) owner_accounts_overview — معاملات تصفية جديدة (الصفحة: حالة الاشتراك /
--     حالة شوبيفاي / الإيقاف، والبحث بدومين المتجر)
--     إعادة تعريف لدالة 119 بنفس الاسم: المعاملات الجديدة اختيارية في النهاية،
--     فنداءات 119 القديمة (4 معاملات) تعمل كما هي، وشكل الخرج لم يتغيّر.
--     • p_sub_status: active = له اشتراك فعّال؛ expired = له اشتراك غير فعّال؛
--       none = بلا اشتراك إطلاقًا. • p_shopify_status: active/error/
--       reauth_required أو none = بلا ربط. • p_suspended: true = الموقوفة فقط.
--     تنبيه: توقيع مختلف = دالة ثانية في Postgres، فيُحذف توقيع 119 أولًا
--     وإلا صار النداء بمعامل واحد غامضًا بين الدالتين.
-- ============================================================================
drop function if exists public.owner_accounts_overview(text, text, integer, integer);
create or replace function public.owner_accounts_overview(p_type text default null, p_search text default null,
                                                          p_limit int default 50, p_offset int default 0,
                                                          p_sub_status text default null, p_shopify_status text default null,
                                                          p_suspended boolean default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v_term text := nullif(btrim(coalesce(p_search, '')), '');
begin
  perform public._owner_require();
  if p_type is not null and p_type not in ('individual', 'company', 'ecommerce_store') then
    raise exception 'نوع غير صالح' using errcode = '22023';
  end if;
  if p_sub_status is not null and p_sub_status not in ('active', 'expired', 'none') then
    raise exception 'حالة اشتراك غير صالحة' using errcode = '22023';
  end if;
  if p_shopify_status is not null and p_shopify_status not in ('active', 'error', 'reauth_required', 'none') then
    raise exception 'حالة شوبيفاي غير صالحة' using errcode = '22023';
  end if;
  return (
    with acc as (
      select p.id user_id, coalesce(nullif(btrim(p.full_name), ''), p.email) name, p.email, p.created_at,
             co.id company_id, co.company_name, co.status company_status,
             case when co.id is null then 'individual' else co.account_kind end account_type,
             (select s.status from public.whatsapp_subscriptions s
               where s.user_id = p.id or (co.id is not null and s.company_id = co.id)
               order by (s.status = 'active') desc, s.created_at desc limit 1) sub_status,
             (select c.status from public.ihub_connections c
               where c.company_id = co.id and c.provider = 'shopify' and c.status <> 'disconnected'
               order by c.created_at desc limit 1) shop_status
        from public.profiles p
        left join public.companies co on co.user_id = p.id
       where (co.id is not null or (p.super_user_id is null and coalesce(p.role, 'user') in ('user', 'customer')))
    ), f as (
      select * from acc
       where (p_type is null or acc.account_type = p_type)
         and (v_term is null or acc.name ilike '%' || v_term || '%' or acc.email ilike '%' || v_term || '%'
              or acc.company_name ilike '%' || v_term || '%'
              or exists (select 1 from public.ihub_connections c
                          where c.company_id = acc.company_id
                            and c.external_account_id ilike '%' || v_term || '%'))
         and (p_sub_status is null
              or (p_sub_status = 'active' and acc.sub_status = 'active')
              or (p_sub_status = 'expired' and acc.sub_status is not null and acc.sub_status <> 'active')
              or (p_sub_status = 'none' and acc.sub_status is null))
         and (p_shopify_status is null
              or (p_shopify_status = 'none' and acc.shop_status is null)
              or acc.shop_status = p_shopify_status)
         and (p_suspended is null
              or (p_suspended and acc.company_status = 'suspended')
              or (not p_suspended and acc.company_status is distinct from 'suspended'))
    )
    select jsonb_build_object(
      'counts', (select jsonb_object_agg(x.account_type, x.n) from (select account_type, count(*) n from acc group by 1) x),
      'total', (select count(*) from f),
      'items', (select coalesce(jsonb_agg(jsonb_build_object(
                  'user_id', f.user_id, 'name', f.name, 'email', f.email, 'created_at', f.created_at,
                  'account_type', f.account_type, 'company_id', f.company_id, 'company_name', f.company_name,
                  'company_status', f.company_status,
                  'subscription', (select jsonb_build_object('plan', s.plan, 'plan_name', coalesce(sp.name_ar, sp.name),
                                      'audience', sp.audience, 'status', s.status, 'end_date', s.end_date,
                                      'effective', s.status = 'active' and s.start_date <= now() and s.end_date > now())
                                     from public.whatsapp_subscriptions s
                                     left join public.subscription_plans sp on sp.key = s.plan
                                    where s.user_id = f.user_id or (f.company_id is not null and s.company_id = f.company_id)
                                    order by (s.status = 'active') desc, s.created_at desc limit 1),
                  'shopify', (select jsonb_build_object('status', c.status, 'shop', c.external_account_id,
                                 'last_sync_status', c.last_sync_status, 'last_error_code', c.last_error_code)
                                from public.ihub_connections c
                               where c.company_id = f.company_id and c.provider = 'shopify' and c.status <> 'disconnected'
                               order by c.created_at desc limit 1))
                  order by f.created_at desc), '[]'::jsonb)
                  from (select * from f order by created_at desc
                         limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) f)));
end $$;
comment on function public.owner_accounts_overview(text, text, integer, integer, text, text, boolean) is
  '133: فلاتر حالة الاشتراك/شوبيفاي/الإيقاف + بحث بدومين المتجر — معاملات اختيارية، خرج 119 كما هو.';
-- حذف توقيع 119 أسقط منحه؛ يُمنح التوقيع الجديد كما كان.
do $$
begin
  execute 'revoke all on function public.owner_accounts_overview(text,text,integer,integer,text,text,boolean) from public, anon, authenticated';
  execute 'grant execute on function public.owner_accounts_overview(text,text,integer,integer,text,text,boolean) to authenticated';
end $$;

-- تحقق ذاتي لفقرة 20: المعاملات الجديدة في النص، والنداء القديم ما زال صالحًا.
do $$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.owner_accounts_overview(text,text,integer,integer,text,text,boolean)'::regprocedure);
  if v_def not like '%p_sub_status%' or v_def not like '%p_shopify_status%' or v_def not like '%p_suspended%' then
    raise exception '133: معاملات التصفية غائبة من owner_accounts_overview()';
  end if;
  if to_regprocedure('public.owner_accounts_overview(text,text,integer,integer)') is not null then
    raise exception '133: توقيع 119 القديم ما زال موجودًا — النداء غامض';
  end if;
  if not has_function_privilege('authenticated', 'public.owner_accounts_overview(text,text,integer,integer,text,text,boolean)', 'EXECUTE') then
    raise exception '133: owner_accounts_overview() الجديد غير ممنوح لـ authenticated';
  end if;
  raise notice '133: فلاتر الحسابات جاهزة';
end $$;
