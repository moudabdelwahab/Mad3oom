-- ============================================================================
-- 019_subscription_upgrade.sql
--   الأسعار كمصدر حقيقة واحد + ترقية/دمج الاشتراك بفرق السعر على المتبقي.
--
-- المشكلة الأساسية التي يعالجها هذا الترحيل
--   أسعار الباقات لم تكن موجودة في قاعدة البيانات إطلاقًا. كانت سمات HTML
--   (data-monthly / data-yearly) مكرّرة في صفحتين (customer-subscriptions.html
--   و subscriptions.html). فالقاعدة لم تكن تعرف سعر أي باقة، وبالتالي لا
--   يمكنها حساب أي مبلغ ترقية ولا التحقق من صحته.
--   => الأسعار تنتقل إلى subscription_plans، والواجهة تقرأ منها.
--
-- عيب ثانٍ اكتُشف من بيانات الإنتاج
--   owned_feature_keys كانت تفلتر (status='active' AND end_date > now()) وتتجاهل
--   start_date. في الإنتاج فعليًا صف تجديد مدفوع مسبقًا يبدأ 2026-09-16 وحالته
--   'active' — فكان يمنح امتيازاته من الآن. لا أثر ظاهر لأن الباقتين متطابقتان،
--   لكن تجديدًا مسبقًا لباقة أعلى كان سيمنح خدماتها مجانًا قبل موعدها.
--   => إضافة شرط start_date <= now().
--
-- قاعدة الترقية (Upgrade / Merge)
--   الترقية ليست شراءً جديدًا: لا تبدأ دورة فوترة جديدة ولا تمدّد الاشتراك.
--   الاشتراك الجديد يرث start_date و end_date الأصليين حرفيًا، والعميل يدفع
--   فرق السعر عن الفترة المتبقية فقط:
--
--     upgrade_amount = (سعر الجديدة − سعر الحالية) × الأيام المتبقية ÷ أيام الدورة
--
--   وأيام الدورة تُحسب من تواريخ الاشتراك الفعلية (end_date − start_date)، لا
--   بافتراض 30 يومًا للشهر أو 365 للسنة — لأن addBillingPeriod في الخدمة
--   يستخدم شهرًا/سنة تقويمية فعلًا، فالدورة قد تكون 28 أو 31 يومًا.
--
--   وبعد انتهاء الدورة يكون التجديد بالسعر الكامل للباقة الجديدة — وده بيشتغل
--   تلقائيًا من قواعد 017 بلا أي كود إضافي هنا.
--
-- الدفع يدوي (تذكرة + إثبات تحويل + مراجعة أدمن)، فمفيش إشارة "نجاح دفع"
-- آلية نربط بيها. لذلك: إنشاء طلب الترقية لا يغيّر أي صلاحية إطلاقًا؛ الصف
-- يفضل 'pending' لحد ما الأدمن يأكّد، وساعتها بس بيتنفّذ التبديل ذريًا.
-- ============================================================================

-- ── 1) الأسعار: مصدر حقيقة واحد ─────────────────────────────────────────────
alter table public.subscription_plans
  add column if not exists price_monthly numeric(14,2),
  add column if not exists price_yearly  numeric(14,2),
  add column if not exists currency      text not null default 'USD';

update public.subscription_plans set price_monthly = 20, price_yearly = 200
 where key = 'support'  and (price_monthly is distinct from 20 or price_yearly is distinct from 200);
update public.subscription_plans set price_monthly = 25, price_yearly = 250
 where key = 'whatsapp' and (price_monthly is distinct from 25 or price_yearly is distinct from 250);
update public.subscription_plans set price_monthly = 40, price_yearly = 440
 where key = 'bundle'   and (price_monthly is distinct from 40 or price_yearly is distinct from 440);

comment on column public.subscription_plans.price_monthly is
  'سعر الباقة شهريًا. مصدر الحقيقة الوحيد — صفحات الأسعار تقرأ منه ولا تحمل أسعارًا في HTML.';
comment on column public.subscription_plans.price_yearly is
  'سعر الباقة سنويًا. مصدر الحقيقة الوحيد.';

create or replace function public.plan_price(p_plan_key text, p_billing_cycle text)
returns numeric
language sql
stable
security definer
set search_path to 'public'
as $function$
  select case when p_billing_cycle = 'yearly' then sp.price_yearly else sp.price_monthly end
    from public.subscription_plans sp
   where sp.key = p_plan_key;
$function$;

revoke all on function public.plan_price(text, text) from public, anon;
grant execute on function public.plan_price(text, text) to authenticated;


-- ── 2) إصلاح احتساب الامتيازات قبل بداية الاشتراك ───────────────────────────
create or replace function public.owned_feature_keys(p_user_id uuid default auth.uid())
returns text[]
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(array_agg(distinct pf.feature_key), '{}'::text[])
    from public.whatsapp_subscriptions s
    join public.subscription_plans sp on sp.key = s.plan
    join public.plan_features pf on pf.plan_id = sp.id and pf.enabled = true
   where s.user_id = p_user_id
     and s.status = 'active'
     and s.start_date <= now()   -- تجديد مدفوع مسبقًا لا يمنح امتيازاته قبل موعده
     and s.end_date   >  now();
$function$;


-- ── 3) نمذجة الترقية على الاشتراك ───────────────────────────────────────────
-- 'superseded': الاشتراك القديم لم ينتهِ بل استُبدل بترقية. تمييزه عن 'expired'
-- يحفظ الحقيقة التاريخية ويمنع الخلط في التقارير.
alter table public.whatsapp_subscriptions
  add column if not exists upgraded_from_subscription_id uuid
      references public.whatsapp_subscriptions(id) on delete set null,
  add column if not exists upgrade_amount numeric(14,2),
  add column if not exists price_snapshot jsonb;

do $$
begin
  alter table public.whatsapp_subscriptions drop constraint if exists whatsapp_subscriptions_status_check;
  alter table public.whatsapp_subscriptions
    add constraint whatsapp_subscriptions_status_check
    check (status = any (array['active','expired','pending','rejected','superseded']));
end $$;

comment on column public.whatsapp_subscriptions.upgraded_from_subscription_id is
  'الاشتراك الذي تمت الترقية منه. يربط الطرفين ويمنع ترقية نفس المصدر مرتين.';
comment on column public.whatsapp_subscriptions.price_snapshot is
  'الأسعار والأيام المستخدمة وقت إنشاء طلب الترقية. المبلغ المعتمد عند التأكيد يؤخذ من هنا، فتغيير الأسعار لاحقًا لا يغيّر طلبًا قائمًا.';

-- لا يمكن أن يوجد أكثر من طلب/اشتراك ترقية واحد من نفس المصدر
create unique index if not exists whatsapp_subscriptions_one_upgrade_per_source
  on public.whatsapp_subscriptions(upgraded_from_subscription_id)
  where upgraded_from_subscription_id is not null
    and status in ('pending', 'active');


-- ── 4) عرض الترقية للعميل ───────────────────────────────────────────────────
-- بترجّع كل ما تحتاجه الواجهة لتشرح العملية قبل الدفع، ونفس الأرقام هي التي
-- تُخزَّن في price_snapshot عند إنشاء الطلب.
create or replace function public.subscription_upgrade_quote(p_plan text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_uid        uuid := auth.uid();
  v_cur        public.whatsapp_subscriptions%rowtype;
  v_owned      text[];
  v_offered    text[];
  v_added      text[];
  v_old_price  numeric;
  v_new_price  numeric;
  v_remaining  int;
  v_cycle      int;
  v_amount     numeric;
  v_currency   text;
begin
  if v_uid is null then
    return jsonb_build_object('eligible', false, 'code', 'not_authenticated');
  end if;

  if not exists (select 1 from public.subscription_plans where key = p_plan and is_active) then
    return jsonb_build_object('eligible', false, 'code', 'unknown_plan');
  end if;

  -- الاشتراك الجاري فعلًا الآن (لا تجديد مستقبلي ولا منتهٍ)
  select * into v_cur
    from public.whatsapp_subscriptions s
   where s.user_id = v_uid
     and s.status = 'active'
     and s.start_date <= now()
     and s.end_date   >  now()
   order by s.end_date desc
   limit 1;

  if v_cur.id is null then
    return jsonb_build_object('eligible', false, 'code', 'no_active_subscription');
  end if;

  if v_cur.plan = p_plan then
    return jsonb_build_object('eligible', false, 'code', 'duplicate_plan');
  end if;

  v_owned   := public.owned_feature_keys(v_uid);
  v_offered := public.plan_feature_keys(p_plan);
  select coalesce(array_agg(f), '{}'::text[]) into v_added
    from unnest(v_offered) f where not (f = any(v_owned));

  if array_length(v_added, 1) is null then
    return jsonb_build_object('eligible', false, 'code', 'redundant');
  end if;

  v_old_price := public.plan_price(v_cur.plan, v_cur.billing_cycle);
  v_new_price := public.plan_price(p_plan,     v_cur.billing_cycle);

  if v_old_price is null or v_new_price is null then
    return jsonb_build_object('eligible', false, 'code', 'price_missing');
  end if;

  -- ترقية = الباقة الجديدة أغلى. غير ذلك تخفيض، وله مسار مختلف خارج النطاق.
  if v_new_price <= v_old_price then
    return jsonb_build_object('eligible', false, 'code', 'not_an_upgrade');
  end if;

  -- بالتواريخ الفعلية للاشتراك، لا بافتراض 30/365
  v_remaining := greatest(0, ceil (extract(epoch from (v_cur.end_date - now()))            / 86400))::int;
  v_cycle     := greatest(1, round(extract(epoch from (v_cur.end_date - v_cur.start_date)) / 86400))::int;
  v_amount    := round((v_new_price - v_old_price) * v_remaining::numeric / v_cycle, 2);

  select currency into v_currency from public.subscription_plans where key = p_plan;

  return jsonb_build_object(
    'eligible', true,
    'code', 'upgrade',
    'currency', coalesce(v_currency, 'USD'),
    'current', jsonb_build_object(
      'subscription_id', v_cur.id,
      'plan',            v_cur.plan,
      'plan_name_ar',    (select coalesce(name_ar, name, v_cur.plan) from public.subscription_plans where key = v_cur.plan),
      'billing_cycle',   v_cur.billing_cycle,
      'start_date',      v_cur.start_date,
      'end_date',        v_cur.end_date,
      'price',           v_old_price
    ),
    'target', jsonb_build_object(
      'plan',         p_plan,
      'plan_name_ar', (select coalesce(name_ar, name, p_plan) from public.subscription_plans where key = p_plan),
      'price',        v_new_price
    ),
    'remaining_days',      v_remaining,
    'cycle_days',          v_cycle,
    'price_difference',    v_new_price - v_old_price,
    'amount_due',          v_amount,
    'next_renewal_price',  v_new_price,
    'added_features',      to_jsonb(v_added)
  );
end;
$function$;

comment on function public.subscription_upgrade_quote(text) is
  'عرض ترقية كامل للعميل: الباقتان والدورة والأيام المتبقية وفرق السعر والمبلغ المستحق الآن وسعر التجديد القادم.';

revoke all on function public.subscription_upgrade_quote(text) from public, anon;
grant execute on function public.subscription_upgrade_quote(text) to authenticated;


-- ── 5) إنشاء طلب الترقية ────────────────────────────────────────────────────
-- المبلغ يُحسب هنا في القاعدة ولا يُقبل من العميل إطلاقًا. الواجهة تعرض العرض
-- عبر subscription_upgrade_quote، لكن ما يُخزَّن هو ما تحسبه هذه الدالة.
-- الصف يُنشأ 'pending' فقط: مفيش أي امتياز بيتغير قبل تأكيد الدفع.
create or replace function public.request_subscription_upgrade(
  p_plan              text,
  p_ticket_id         uuid default null,
  p_payment_method    text default null,
  p_payment_reference text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  v_uid    uuid := auth.uid();
  v_quote  jsonb;
  v_cur_id uuid;
  v_new    public.whatsapp_subscriptions%rowtype;
  v_cur    public.whatsapp_subscriptions%rowtype;
begin
  if v_uid is null then
    raise exception 'يجب تسجيل الدخول أولًا' using errcode = '42501';
  end if;

  v_quote := public.subscription_upgrade_quote(p_plan);

  if (v_quote->>'eligible')::boolean is not true then
    raise exception 'لا يمكن ترقية اشتراكك إلى هذه الباقة (%).', coalesce(v_quote->>'code', 'unknown');
  end if;

  v_cur_id := (v_quote->'current'->>'subscription_id')::uuid;

  -- قفل الاشتراك المصدر: يمنع سباق طلبين متزامنين على نفس الاشتراك
  select * into v_cur from public.whatsapp_subscriptions
   where id = v_cur_id for update;

  if v_cur.status <> 'active' or v_cur.end_date <= now() then
    raise exception 'الاشتراك الحالي لم يعد صالحًا للترقية';
  end if;

  -- الاشتراك الجديد يرث الدورة كاملةً: لا تمديد ولا دورة فوترة جديدة
  insert into public.whatsapp_subscriptions (
    user_id, ticket_id, plan, status, billing_cycle,
    start_date, end_date, duration_days,
    payment_method, payment_reference,
    upgraded_from_subscription_id, upgrade_amount, price_snapshot, company_id
  ) values (
    v_uid, p_ticket_id, p_plan, 'pending', v_cur.billing_cycle,
    v_cur.start_date, v_cur.end_date, v_cur.duration_days,
    -- وسيلة الدفع تُكتب هنا: العميل لا يملك سياسة UPDATE على الجدول،
    -- فلا يمكنه تعديل الصف بعد إنشائه.
    nullif(btrim(coalesce(p_payment_method, '')), ''),
    nullif(btrim(coalesce(p_payment_reference, '')), ''),
    v_cur.id,
    (v_quote->>'amount_due')::numeric,
    jsonb_build_object(
      'quoted_at',         now(),
      'from_plan',         v_quote->'current'->>'plan',
      'from_price',        (v_quote->'current'->>'price')::numeric,
      'to_plan',           p_plan,
      'to_price',          (v_quote->'target'->>'price')::numeric,
      'billing_cycle',     v_cur.billing_cycle,
      'remaining_days',    (v_quote->>'remaining_days')::int,
      'cycle_days',        (v_quote->>'cycle_days')::int,
      'price_difference',  (v_quote->>'price_difference')::numeric,
      'amount_due',        (v_quote->>'amount_due')::numeric,
      'currency',          v_quote->>'currency'
    ),
    v_cur.company_id
  )
  returning * into v_new;

  return jsonb_build_object(
    'subscription_id', v_new.id,
    'amount_due',      v_new.upgrade_amount,
    'currency',        v_quote->>'currency',
    'quote',           v_quote
  );
end;
$function$;

comment on function public.request_subscription_upgrade(text, uuid, text, text) is
  'ينشئ طلب ترقية pending بمبلغ محسوب في القاعدة (لا يُقبل من العميل). لا يغيّر أي صلاحية قبل تأكيد الدفع.';

revoke all on function public.request_subscription_upgrade(text, uuid, text, text) from public, anon;
grant execute on function public.request_subscription_upgrade(text, uuid, text, text) to authenticated;


-- ── 6) تأكيد الترقية (ذرّي) ─────────────────────────────────────────────────
-- نقطة تأكيد الدفع الوحيدة في النظام هي مراجعة الأدمن للتحويل. هنا يتم كل شيء
-- في معاملة واحدة، فمفيش لحظة يكون فيها الاشتراكان فعّالين معًا.
create or replace function public.admin_confirm_subscription_upgrade(p_subscription_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  v_new    public.whatsapp_subscriptions%rowtype;
  v_src    public.whatsapp_subscriptions%rowtype;
  v_access jsonb;
begin
  if not public.is_admin() then
    raise exception 'هذه العملية متاحة للإدارة فقط' using errcode = '42501';
  end if;

  -- قفل صف الترقية: تأكيدان متزامنان لن ينفّذا العملية مرتين
  select * into v_new from public.whatsapp_subscriptions
   where id = p_subscription_id for update;

  if v_new.id is null then
    raise exception 'طلب الترقية غير موجود';
  end if;
  if v_new.upgraded_from_subscription_id is null then
    raise exception 'هذا ليس طلب ترقية';
  end if;
  -- الحارس ضد التأكيد المكرر: أي حالة غير pending تعني أن الطلب عولج بالفعل
  if v_new.status <> 'pending' then
    raise exception 'طلب الترقية حالته "%" وليست pending — لم يُنفَّذ أي تغيير', v_new.status;
  end if;

  select * into v_src from public.whatsapp_subscriptions
   where id = v_new.upgraded_from_subscription_id for update;

  if v_src.id is null then
    raise exception 'الاشتراك المصدر غير موجود';
  end if;

  -- انتهاء الاشتراك المصدر أثناء انتظار الدفع: لا تُنفَّذ الترقية، ولا يُمَس
  -- الاشتراك الأصلي، ولا تُمنح أي امتيازات. العميل يحتاج طلبًا جديدًا بالسعر
  -- الكامل — والرسالة تقول ذلك للأدمن صراحةً.
  if v_src.status <> 'active' or v_src.end_date <= now() then
    raise exception 'انتهى الاشتراك الأصلي قبل تأكيد الدفع، فلم تُنفَّذ الترقية. اطلب من العميل إنشاء اشتراك جديد بالسعر الكامل.';
  end if;

  -- التبديل الذرّي: الجديد يرث الدورة كما هي، والقديم يُعلَّم مُستبدَلًا
  update public.whatsapp_subscriptions
     set status     = 'active',
         start_date = v_src.start_date,
         end_date   = v_src.end_date,
         reviewed_by = auth.uid(),
         reviewed_at = now(),
         updated_at = now()
   where id = v_new.id;

  update public.whatsapp_subscriptions
     set status = 'superseded', updated_at = now()
   where id = v_src.id;

  v_access := public.recompute_user_access(v_new.user_id);

  insert into public.subscription_audit_log (
    subscription_id, target_user_id, actor_user_id, actor_email,
    action, old_values, new_values, reason
  ) values (
    v_new.id, v_new.user_id, auth.uid(),
    (select email from public.profiles where id = auth.uid()),
    'upgrade',
    jsonb_build_object('plan', v_src.plan, 'status', 'active', 'subscription_id', v_src.id),
    jsonb_build_object('plan', v_new.plan, 'status', 'active',
                       'amount_charged', v_new.upgrade_amount,
                       'price_snapshot', v_new.price_snapshot),
    'ترقية ودمج الباقة'
  );

  return jsonb_build_object(
    'upgraded_subscription_id',  v_new.id,
    'superseded_subscription_id', v_src.id,
    'amount_charged',            v_new.upgrade_amount,
    'access',                    v_access
  );
end;
$function$;

comment on function public.admin_confirm_subscription_upgrade(uuid) is
  'تأكيد ترقية: يفعّل الجديد بنفس دورة القديم ويعلّم القديم superseded ويعيد حساب الامتيازات ويسجّل التدقيق — كله في معاملة واحدة.';

revoke all on function public.admin_confirm_subscription_upgrade(uuid) from public, anon;
grant execute on function public.admin_confirm_subscription_upgrade(uuid) to authenticated;
