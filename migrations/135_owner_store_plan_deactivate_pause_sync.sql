-- ============================================================================
-- 135_owner_store_plan_deactivate_pause_sync.sql
--   إصلاحات لوحة المتاجر (owner/stores.html) بعد 133 — بلا تفعيل حي وبلا
--   تغيير بيانات: هذا الترحيل يعيد تعريف دوال فقط، ولا يحدّث أي صف في
--   subscription_plans (لا سعر ولا is_active). التفعيل الحي للباقة يبقى
--   إجراءً يدويًا للمالك من نموذج السعر بعد موافقته الصريحة.
--
--   ① تفعيل الباقة: مسار الحفظ كما هو (السعران 500/5000 افتراضيًا في
--      النموذج) — موثَّق باختبار node (tests/store-plan-135.test.mjs:
--      storePlanPriceArgs) واختبار SQL (§1 أدناه)؛ لا شيء يُفعَّل هنا.
--   ② إلغاء التفعيل (جديد): owner_set_store_plan_price بتوقيع جديد
--      (p_monthly, p_yearly, p_activate, p_deactivate, p_reason) — التفعيل
--      في 133 كان أحادي الاتجاه (is_active لا يعود false أبدًا، سطر 81).
--      p_deactivate=true يوقف الباقة مع تأكيد صريح وسبب من الواجهة؛
--      السعران اختياريان عند الإلغاء (null = إبقاء الحالي) وموجبان عند
--      التفعيل أو الحفظ العادي. التفعيل والإلغاء معًا مرفوضان. حذف توقيع
--      133 ذي الثلاثة معاملات أولًا (وإلا صار النداء بثلاثة معاملات غامضًا
--      بين التوقيعين — نفس علة 133 فقرة 20). أثر الإلغاء الموثَّق: الشراء
--      والترقية يتحققان من is_active (017/019/023/024/068/111) فتتوقف
--      مبيعات جديدة، وتبقى اشتراكات المتاجر القائمة سارية حتى انتهائها
--      (صلاحيتها تُحسب بالحالة وتاريخ الانتهاء لا بتفعيل الباقة).
--   ③ تمديد الإيقاف المزدوج: التاريخ المحدَّد يدويًا أثناء الإيقاف هو
--      تاريخ الانتهاء النهائي — الاستئناف لا يضيف مدة التوقف فوقه.
--      القرار الحسابي: التفسير المجمّد (end_date − paused_at = المتبقي)
--      يجعل كود 133 صحيحًا رياضيًا (E' + (T1−T0) = T1 + (E'−T0))، لكن
--      الواجهة تعرض «تاريخ الانتهاء الجديد» كتاريخ نهائي يختاره المالك،
--      فكان الاستئناف يمدّده مرة أخرى بمدة التوقف. الحل: علامة
--      end_date_set_while_paused في price_snapshot يضعها
--      owner_store_set_end_date على المتوقف فقط؛ owner_store_resume
--      يستخدم التاريخ كما هو عند وجودها ويصفّرها. «آخر قرار صريح يفوز»:
--      التعديل اليدوي أثناء الإيقاف يُبطل علامة تحويل الدورة أثناء
--      الإيقاف، وتحويل الدورة أثناء الإيقاف يُبطل العلامة اليدوية —
--      فلا يجتمع مساران متناقضان للانتهاء عند الاستئناف.
--      _store_subscription_json يعرض العلامتين للواجهة.
--   ④ إلغاء كل المزايا: واجهة فقط (stores.js + storeQuotaDisableWarning
--      في owner-labels.js) — تحذير وتأكيد صريح قبل الحفظ إن كان
--      shopify_integration سيُعطَّل أو كانت القائمة المختارة فارغة؛
--      الدالة owner_set_store_plan_quota_features بلا تغيير (تتطلب
--      تحققًا حديثًا وسببًا وتُدقَّق، فالإلغاء عبرها ليس صامتًا أبدًا).
--   ⑤ التشخيص: owner_store_plan_config يعيد الآن is_active والسعرين
--      والعملة أيضًا، فيبني نموذج السعر بياناته منه لا من
--      owner_entitlement_diagnostics — وفشل التشخيص لا يُسقط النموذجين
--      (stores.js يرسم كل قسم بنتيجته وخطئه مستقلًا).
--   ⑥ حد الدقيقتين: بوابة 133/119 كانت معكوسة المنطق — «مهمة منتهية
--      حديثًا ولا مهمة قائمة» وحدها ترفع rate_limited، أما وجود مهمة
--      queued/running فكان يسقط البوابة ويسلّم الطلب إلى
--      _ihub_enqueue_sync ليعيد المهمة القائمة (طبقة ثانية: إزالة
--      التكرار + الفهرس الفريد الجزئي ihub_sync_jobs_one_active). هنا
--      البوابة صريحة في الدالتين: مهمة قائمة (queued/running/failed —
--      نفس مجموعة إزالة التكرار في _ihub_enqueue_sync) تُعاد كما هي
--      {job_id, existing:true} بلا إدراج وبلا صف تدقيق 'sync.requested'
--      جديد مضلِّل؛ ثم حد الدقيقتين على المنتهية وحدها. عدَّلت الدالتان:
--      owner_ihub_sync_request (133) و ihub_sync_request (119 المناظرة،
--      مسار مدير المتجر — نفس البوابة ونفس الثغرة). _ihub_enqueue_sync
--      لم تُلمس: إزالة التكرار فيها باقية طبقة ثانية لسباق الطلبين.
--
-- يعتمد على 118 و 119 و 133 (كلها على main). قابل لإعادة التشغيل.
-- تنبيه: إعادة تطبيق 133 بعد 135 تُعيد توقيع السعر ذا الثلاثة معاملات
-- جنبًا إلى جنب مع توقيع 135؛ أعد تطبيق 135 بعده لاستعادة التوقيع الواحد.
-- التراجع: migrations/_rollback/135_owner_store_plan_deactivate_pause_sync.down.sql
--   (يحذف توقيع السعر الجديد ويعيد توقيع 133؛ باقي الدوال تعود بإعادة
--   تطبيق 133 ثم 119 — موثّق في ملف التراجع).
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.owner_critical_ok()',
    'public.log_privileged(text,uuid,jsonb,jsonb)',
    'public._owner_require()',
    'public._ihub_enqueue_sync(uuid,text,uuid)', 'public._ihub_audit(uuid,uuid,text,text,jsonb)',
    'public._ihub_shopify_admin(uuid)',
    'public.owner_ihub_sync_request(uuid)',
    'public.ihub_sync_request(uuid)',
    'public.owner_store_set_end_date(uuid,timestamptz,text)',
    'public.owner_store_resume(uuid,text)',
    'public.owner_store_change_cycle(uuid,text,text)',
    'public.owner_store_plan_config()',
    'public.owner_store_operations_log(integer)',
    'public._store_subscription_json(uuid)',
    'public._store_reason(text)',
    'public._store_audit(uuid,text,jsonb,jsonb,text)',
    'public.recompute_user_access(uuid)'] loop
    if to_regprocedure(f) is null then
      raise exception '135 يتطلب %', f;
    end if;
  end loop;
  -- سعر الباقة: توقيع 133 (ثلاثة معاملات) أو توقيع 135 نفسه عند إعادة
  -- التطبيق — §1 يحذف توقيع 133، فاشتراطه وحده كان يكسر إعادة التطبيق.
  if to_regprocedure('public.owner_set_store_plan_price(numeric,numeric,boolean)') is null
     and to_regprocedure('public.owner_set_store_plan_price(numeric,numeric,boolean,boolean,text)') is null then
    raise exception '135 يتطلب owner_set_store_plan_price من 133 أو 135';
  end if;
  if to_regclass('public.subscription_plans') is null or to_regclass('public.ihub_sync_jobs') is null
     or to_regclass('public.whatsapp_subscriptions') is null or to_regclass('public.privileged_audit') is null then
    raise exception '135 يتطلب جداول 118 و 119 و 133';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'subscription_plans_store_priced') then
    raise exception '135 يتطلب قيد 118 (subscription_plans_store_priced)';
  end if;
end $$;


-- ============================================================================
-- 1) سعر باقة المتاجر + إلغاء تفعيلها — توقيع جديد (②)
--    بلا تحديث بيانات: لا سعر يُحدَّد ولا تفعيل هنا؛ الدالة وحدها تُعرَّف.
-- ============================================================================
drop function if exists public.owner_set_store_plan_price(numeric, numeric, boolean);
create or replace function public.owner_set_store_plan_price(p_monthly numeric, p_yearly numeric,
                                                            p_activate boolean default false,
                                                            p_deactivate boolean default false,
                                                            p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_old         jsonb;
  v_new         jsonb;
  v_activated   boolean := false;
  v_deactivated boolean := false;
  v_reason      text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not public.owner_critical_ok() then
    raise exception 'سعر باقة المتاجر لمالك المنصة في سياقه وبتحقق حديث' using errcode = '42501';
  end if;
  if coalesce(p_activate, false) and coalesce(p_deactivate, false) then
    raise exception 'لا يمكن تفعيل باقة المتاجر وإلغاء تفعيلها معًا' using errcode = '22023';
  end if;
  if coalesce(p_deactivate, false) then
    if (p_monthly is not null and p_monthly <= 0) or (p_yearly is not null and p_yearly <= 0) then
      raise exception 'السعران الشهري والسنوي موجبان (بالجنيه) إن أُرسلا' using errcode = '22023';
    end if;
  elsif p_monthly is null or p_yearly is null or p_monthly <= 0 or p_yearly <= 0 then
    raise exception 'السعران الشهري والسنوي موجبان (بالجنيه)' using errcode = '22023';
  end if;
  select jsonb_build_object('key', key, 'is_active', is_active, 'price_monthly', price_monthly,
                            'price_yearly', price_yearly, 'currency', currency)
    into v_old from public.subscription_plans where key = 'store';
  if v_old is null then
    raise exception 'باقة المتاجر غير موجودة (118 غير مطبّق)' using errcode = 'P0002';
  end if;
  v_activated := coalesce(p_activate, false) and not (v_old->>'is_active')::boolean;
  v_deactivated := coalesce(p_deactivate, false) and (v_old->>'is_active')::boolean;
  update public.subscription_plans
     set price_monthly = coalesce(p_monthly, price_monthly),
         price_yearly = coalesce(p_yearly, price_yearly), currency = 'EGP',
         is_active = case when coalesce(p_deactivate, false) then false
                          when coalesce(p_activate, false) then true
                          else is_active end
   where key = 'store'
   returning jsonb_build_object('key', key, 'is_active', is_active, 'price_monthly', price_monthly,
                                'price_yearly', price_yearly, 'currency', currency)
    into v_new;
  perform public.log_privileged('store.plan_price', null, v_old,
    v_new || jsonb_build_object('activated', v_activated, 'deactivated', v_deactivated,
                                'reason', left(v_reason, 300)));
  return v_new || jsonb_build_object('activated', v_activated, 'deactivated', v_deactivated);
end $$;
comment on function public.owner_set_store_plan_price(numeric, numeric, boolean, boolean, text) is
  '135: سعر باقة المتاجر (store) فقط + إلغاء تفعيلها (p_deactivate) بتأكيد وسبب. التفعيل مع السعرين فقط؛ الإلغاء يبقي السعرين.';


-- ============================================================================
-- 2) تعديل تاريخ الانتهاء — علامة التعديل اليدوي أثناء الإيقاف (③)
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
  v_snap   jsonb;
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
  v_snap := coalesce(v_sub.price_snapshot, '{}'::jsonb);
  if v_sub.status = 'paused' then
    v_snap := (v_snap - 'cycle_changed_while_paused')
              || jsonb_build_object('end_date_set_while_paused', true);
  end if;
  v_days := greatest(1, ceil(extract(epoch from (p_end_date - v_sub.start_date)) / 86400)::int);
  update public.whatsapp_subscriptions
     set end_date = p_end_date, duration_days = v_days, price_snapshot = v_snap, updated_at = now()
   where id = p_subscription;
  perform public.recompute_user_access(v_sub.user_id);
  perform public._store_audit(p_subscription, 'set_end_date',
    jsonb_build_object('end_date', v_sub.end_date, 'duration_days', v_sub.duration_days),
    jsonb_build_object('end_date', p_end_date, 'duration_days', v_days,
                       'end_date_set_while_paused',
                       coalesce((v_snap->>'end_date_set_while_paused')::boolean, false)), v_reason);
  perform public.log_privileged('store.subscription_end_date', null,
    jsonb_build_object('subscription_id', p_subscription, 'end_date', v_sub.end_date),
    jsonb_build_object('subscription_id', p_subscription, 'end_date', p_end_date, 'reason', left(v_reason, 300)));
  return public._store_subscription_json(p_subscription);
end $$;


-- ============================================================================
-- 3) الاستئناف — التاريخ اليدوي نهائي، بلا تمديد بمدة التوقف (③)
-- ============================================================================
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
  v_basis  text;
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
  if coalesce((v_snap->>'end_date_set_while_paused')::boolean, false) then
    v_new_end := v_sub.end_date;
    v_snap := v_snap - 'end_date_set_while_paused' - 'cycle_changed_while_paused';
    v_basis := 'manual_end_date';
  elsif coalesce((v_snap->>'cycle_changed_while_paused')::boolean, false) then
    v_days := case when v_sub.billing_cycle = 'yearly' then 365 else 30 end;
    v_new_end := now() + make_interval(days => v_days);
    v_snap := v_snap - 'cycle_changed_while_paused';
    v_basis := 'new_cycle';
  else
    v_new_end := v_sub.end_date + (now() - v_sub.paused_at);
    v_basis := 'pause_extension';
  end if;
  v_days := greatest(1, ceil(extract(epoch from (v_new_end - v_sub.start_date)) / 86400)::int);
  update public.whatsapp_subscriptions
     set status = 'active', paused_at = null, end_date = v_new_end, duration_days = v_days,
         price_snapshot = v_snap, updated_at = now()
   where id = p_subscription;
  perform public.recompute_user_access(v_sub.user_id);
  perform public._store_audit(p_subscription, 'resume',
    jsonb_build_object('status', 'paused', 'end_date', v_sub.end_date),
    jsonb_build_object('status', 'active', 'end_date', v_new_end, 'resume_basis', v_basis), v_reason);
  perform public.log_privileged('store.subscription_resume', null,
    jsonb_build_object('subscription_id', p_subscription, 'status', 'paused', 'end_date', v_sub.end_date),
    jsonb_build_object('subscription_id', p_subscription, 'status', 'active', 'end_date', v_new_end,
                       'resume_basis', v_basis, 'reason', left(v_reason, 300)));
  return public._store_subscription_json(p_subscription);
end $$;


-- ============================================================================
-- 4) تحويل الدورة أثناء الإيقاف يُبطل العلامة اليدوية — آخر قرار يفوز (③)
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
    v_snap := (v_snap - 'end_date_set_while_paused')
              || jsonb_build_object('cycle_changed_while_paused', true);
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
-- 5) قراءة الاشتراك — عرض علامتي الإيقاف للواجهة (③)
-- ============================================================================
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
    'end_date_set_while_paused', coalesce((s.price_snapshot->>'end_date_set_while_paused')::boolean, false),
    'cycle_changed_while_paused', coalesce((s.price_snapshot->>'cycle_changed_while_paused')::boolean, false),
    'effective', s.status = 'active' and s.end_date > now(),
    'days_remaining', case when s.status = 'paused' and s.paused_at is not null
                           then greatest(0, ceil(extract(epoch from (s.end_date - s.paused_at)) / 86400)::int)
                           when s.end_date > now() then ceil(extract(epoch from (s.end_date - now())) / 86400)::int
                           else 0 end)
    from public.whatsapp_subscriptions s where s.id = p_subscription;
$$;


-- ============================================================================
-- 6) إعداد باقة المتاجر — التفعيل والسعران أيضًا، لنموذج السعر (⑤)
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
    'is_active', (select is_active from public.subscription_plans where key = 'store'),
    'price_monthly', (select price_monthly from public.subscription_plans where key = 'store'),
    'price_yearly', (select price_yearly from public.subscription_plans where key = 'store'),
    'currency', (select currency from public.subscription_plans where key = 'store'),
    'features', (select coalesce(jsonb_agg(jsonb_build_object('feature_key', pf.feature_key, 'enabled', pf.enabled)
                                           order by pf.feature_key), '[]'::jsonb)
                  from public.plan_features pf join public.subscription_plans sp on sp.id = pf.plan_id
                 where sp.key = 'store'));
end $$;


-- ============================================================================
-- 7) سجل عمليات المتاجر — ملخص الإلغاء في سطر سعر الباقة (②)
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
                 || case when coalesce((a.new_value->>'deactivated')::boolean, false) then ' — أُلغي تفعيلها'
                         when coalesce((a.new_value->>'activated')::boolean, false) then ' — فُعّلت' else '' end
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
-- 8) مزامنة المالك — المهمة القائمة تُعاد، بلا مكرر وبلا تدقيق مضلِّل (⑥)
--    نص 133 فقرة 2 كما هو عدا البوابة.
-- ============================================================================
create or replace function public.owner_ihub_sync_request(p_connection uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r      public.ihub_connections;
  v_job  jsonb;
  v_live bigint;
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
  select j.id into v_live from public.ihub_sync_jobs j where j.connection_id = r.id
    and j.status in ('queued', 'running', 'failed') order by j.id desc limit 1;
  if v_live is not null then
    return jsonb_build_object('job_id', v_live, 'existing', true);
  end if;
  if exists (select 1 from public.ihub_sync_jobs j where j.connection_id = r.id
                and j.status in ('succeeded', 'dead', 'cancelled') and j.finished_at > now() - interval '2 minutes') then
    raise exception 'انتظر دقيقتين بين كل مزامنة وأخرى' using errcode = 'P0001', detail = '{"code":"rate_limited"}';
  end if;
  v_job := public._ihub_enqueue_sync(r.id, 'manual', auth.uid());
  perform public._ihub_audit(r.company_id, r.id, 'user', 'sync.requested',
    jsonb_build_object('job_id', v_job->'job_id', 'via', 'owner'));
  return v_job;
end $$;
comment on function public.owner_ihub_sync_request(uuid) is
  '135: مزامنة يدوية لربط Shopify من لوحة المالك — المهمة القائمة تُعاد بلا مكرر، وحد الدقيقتين على المنتهية وحدها.';


-- ============================================================================
-- 9) مزامنة مدير المتجر (119 المناظرة) — نفس البوابة (⑥)
--    نص 119 كما هو عدا البوابة: سياق مدير المتجر والقراءة فقط في المعاينة
--    محفوظان، وإعادة المهمة القائمة بلا تدقيق 'sync.requested' جديد.
-- ============================================================================
create or replace function public.ihub_sync_request(p_connection uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r      public.ihub_connections;
  v_job  jsonb;
  v_live bigint;
begin
  r := public._ihub_shopify_admin(p_connection);
  if coalesce(public.preview_mode(), true) then
    raise exception 'المعاينة للقراءة فقط' using errcode = '42501';
  end if;
  if r.status not in ('active', 'error') then
    raise exception 'الربط يحتاج إعادة تفويض أولًا' using errcode = '22023', detail = '{"code":"reauth_required"}';
  end if;
  select j.id into v_live from public.ihub_sync_jobs j where j.connection_id = r.id
    and j.status in ('queued', 'running', 'failed') order by j.id desc limit 1;
  if v_live is not null then
    return jsonb_build_object('job_id', v_live, 'existing', true);
  end if;
  if exists (select 1 from public.ihub_sync_jobs j where j.connection_id = r.id
                and j.status in ('succeeded', 'dead', 'cancelled') and j.finished_at > now() - interval '2 minutes') then
    raise exception 'انتظر دقيقتين بين كل مزامنة وأخرى' using errcode = 'P0001', detail = '{"code":"rate_limited"}';
  end if;
  v_job := public._ihub_enqueue_sync(r.id, 'manual', auth.uid());
  perform public._ihub_audit(r.company_id, r.id, 'user', 'sync.requested', jsonb_build_object('job_id', v_job->'job_id'));
  return v_job;
end $$;


-- ============================================================================
-- 10) الصلاحيات — التوقيع الجديد كما كان توقيع 133 (authenticated وحده)
--     CREATE OR REPLACE للدوال الأخرى يُبقي منحها؛ توقيع السعر حُذف
--     وأُعيد إنشاؤه فيُمنح من جديد.
-- ============================================================================
do $$
declare
  f text := 'public.owner_set_store_plan_price(numeric,numeric,boolean,boolean,text)';
begin
  execute format('revoke all on function %s from public, anon, authenticated', f);
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute format('revoke all on function %s from service_role', f);
  end if;
  execute format('grant execute on function %s to authenticated', f);
end $$;


-- ============================================================================
-- 11) تحقق ذاتي — على نمط 130/133: الحراس في النص، والتوقيع الواحد،
--     والبوابة الجديدة بلا الشرط المعكوس، والصلاحيات كما أُعلنت
-- ============================================================================
do $$
declare
  v_def text;
begin
  if to_regprocedure('public.owner_set_store_plan_price(numeric,numeric,boolean)') is not null then
    raise exception '135: توقيع 133 للسعر ما زال موجودًا — النداء غامض';
  end if;
  if to_regprocedure('public.owner_set_store_plan_price(numeric,numeric,boolean,boolean,text)') is null then
    raise exception '135: توقيع 135 للسعر غائب';
  end if;
  v_def := pg_get_functiondef('public.owner_set_store_plan_price(numeric,numeric,boolean,boolean,text)'::regprocedure);
  if v_def not like '%owner_critical_ok%' then
    raise exception '135: owner_critical_ok() غائب من owner_set_store_plan_price()';
  end if;
  if v_def not like '%key = ''store''%' or v_def not like '%p_deactivate%' then
    raise exception '135: نطاق store أو p_deactivate غائب من owner_set_store_plan_price()';
  end if;
  if not has_function_privilege('authenticated', 'public.owner_set_store_plan_price(numeric,numeric,boolean,boolean,text)', 'EXECUTE') then
    raise exception '135: توقيع السعر الجديد غير ممنوح لـ authenticated';
  end if;
  if has_function_privilege('anon', 'public.owner_set_store_plan_price(numeric,numeric,boolean,boolean,text)', 'EXECUTE') then
    raise exception '135: توقيع السعر الجديد مكشوف لـ anon';
  end if;
  v_def := pg_get_functiondef('public.owner_store_set_end_date(uuid,timestamptz,text)'::regprocedure);
  if v_def not like '%end_date_set_while_paused%' then
    raise exception '135: علامة التعديل اليدوي غائبة من owner_store_set_end_date()';
  end if;
  v_def := pg_get_functiondef('public.owner_store_resume(uuid,text)'::regprocedure);
  if v_def not like '%end_date_set_while_paused%' or v_def not like '%manual_end_date%' then
    raise exception '135: مسار التاريخ اليدوي غائب من owner_store_resume()';
  end if;
  v_def := pg_get_functiondef('public.owner_store_change_cycle(uuid,text,text)'::regprocedure);
  if v_def not like '%end_date_set_while_paused%' then
    raise exception '135: إبطال العلامة اليدوية غائب من owner_store_change_cycle()';
  end if;
  v_def := pg_get_functiondef('public._store_subscription_json(uuid)'::regprocedure);
  if v_def not like '%end_date_set_while_paused%' or v_def not like '%cycle_changed_while_paused%' then
    raise exception '135: علامتا الإيقاف غائبتان من _store_subscription_json()';
  end if;
  v_def := pg_get_functiondef('public.owner_store_plan_config()'::regprocedure);
  if v_def not like '%price_monthly%' or v_def not like '%is_active%' then
    raise exception '135: السعر والتفعيل غائبان من owner_store_plan_config()';
  end if;
  v_def := pg_get_functiondef('public.owner_store_operations_log(integer)'::regprocedure);
  if v_def not like '%deactivated%' then
    raise exception '135: ملخص الإلغاء غائب من owner_store_operations_log()';
  end if;
  v_def := pg_get_functiondef('public.owner_ihub_sync_request(uuid)'::regprocedure);
  if v_def not like '%_owner_require%' or v_def not like '%existing%' then
    raise exception '135: owner_ihub_sync_request() بلا حارس المالك أو بلا إعادة المهمة القائمة';
  end if;
  if v_def like '%and not exists (select 1 from public.ihub_sync_jobs%' then
    raise exception '135: الشرط المعكوس ما زال في owner_ihub_sync_request()';
  end if;
  v_def := pg_get_functiondef('public.ihub_sync_request(uuid)'::regprocedure);
  if v_def not like '%_ihub_shopify_admin%' or v_def not like '%existing%' then
    raise exception '135: ihub_sync_request() بلا سياق مدير المتجر أو بلا إعادة المهمة القائمة';
  end if;
  if v_def like '%and not exists (select 1 from public.ihub_sync_jobs%' then
    raise exception '135: الشرط المعكوس ما زال في ihub_sync_request()';
  end if;
  raise notice '135: إلغاء تفعيل باقة المتاجر، وإصلاح تمديد الإيقاف، ومزامنة بلا مكرر جاهزة';
end $$;
