-- 023_subscription_purchase_rpc.sql
-- إصلاح C1: العميل كان يستطيع منح نفسه اشتراكًا فعّالًا مجانًا.
-- ============================================================================
--
-- ما كان يحدث
--   سياسة INSERT على whatsapp_subscriptions كانت تتحقق من auth.uid() = user_id
--   فقط. لا قيد على status ولا end_date ولا start_date. والحارس
--   enforce_subscription_purchase_rules يسأل سؤالًا واحدًا: «هل تضيف هذه الباقة
--   خدمات جديدة؟» — ومن لا يملك شيئًا تضيف له كل باقة كل شيء، فيمر.
--
--   فأي مستخدم مسجَّل يستطيع بنداء REST واحد أن يكتب لنفسه صفًّا بحالة
--   'active' وتاريخ انتهاء بعد عشر سنوات، ويحصل فورًا على كل الخدمات المدفوعة.
--   (مُثبَت على الإنتاج داخل معاملة انتهت بـROLLBACK قبل كتابة هذا الترحيل.)
--
-- القاعدة المعتمدة بعد هذا الترحيل
--   العميل لا ينشئ اشتراكًا. العميل ينشئ **طلبًا** حالته 'pending' دائمًا،
--   والأدمن وحده هو من يحوّله إلى 'active'. كل الحقول التي تحدد القيمة —
--   الحالة، التواريخ، المراجِع، الشركة، حقول الترقية — تُحسب في الخادم ولا
--   تُقرأ من العميل إطلاقًا.
--
-- كيف فُرضت
--   1) حُذفت سياسة INSERT الخاصة بالمستخدمين. لم يعد هناك أي مسار كتابة مباشر
--      على الجدول لغير الأدمن — لا من الواجهة ولا من REST ولا من أي عميل آخر.
--   2) الإنشاء صار عبر request_subscription_purchase() وهي SECURITY DEFINER،
--      فتتجاوز RLS بحكم ملكيتها للجدول، وتفرض القيم بنفسها.
--   3) الحارس enforce_subscription_purchase_rules يبقى كما هو خط دفاع ثانٍ،
--      ويُشدَّد ليرفض أي محاولة إنشاء بحالة 'active' من مستخدم غير أدمن —
--      حتى لو أُعيدت سياسة INSERT يومًا ما بالخطأ.
--
-- ما لم يتغيّر
--   • سياسة الأدمن (FOR ALL) كما هي: التأكيد اليدوي والتسويات تعمل بلا تغيير.
--   • request_subscription_upgrade و admin_confirm_subscription_upgrade كما هما
--     (SECURITY DEFINER، تتجاوزان RLS، وتحسبان المبلغ في الخادم).
--   • قاعدة التداخل subscription_purchase_check لم تُمس.

-- ============================================================================
-- 1) إغلاق مسار الكتابة المباشر
-- ============================================================================

drop policy if exists "Users can create their own subscriptions"
  on public.whatsapp_subscriptions;

comment on table public.whatsapp_subscriptions is
  'اشتراكات المنصة. لا يوجد مسار INSERT للمستخدم العادي عمدًا (C1): الإنشاء عبر
   public.request_subscription_purchase() فقط، وهي تفرض status=pending وتحسب كل
   التواريخ في الخادم. الأدمن ينشئ ويعدّل عبر سياسته الخاصة ودوال admin_*.';

-- ============================================================================
-- 2) تشديد الحارس: العميل لا يكتب حالة فعّالة أبدًا
-- ============================================================================

create or replace function public.enforce_subscription_purchase_rules()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_check jsonb;
begin
  -- مفتاح الخدمة والوظائف الخلفية: لا مستخدم في السياق، فلا شيء نحميه منه.
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;

  -- خط الدفاع الجديد: مستخدم عادي لا ينشئ صفًّا فعّالًا مهما كان مصدر النداء.
  -- الدالة request_subscription_purchase تكتب 'pending' دائمًا، فهذا الشرط لا
  -- يُفعَّل في المسار الشرعي إطلاقًا — وجوده ليمنع أي مسار غير شرعي مستقبلًا.
  if new.status is distinct from 'pending' then
    raise exception 'لا يمكن إنشاء اشتراك بهذه الحالة. الطلبات تبدأ قيد المراجعة ويعتمدها فريق الدعم.'
      using errcode = '42501';
  end if;

  v_check := public.subscription_purchase_check(new.plan, new.is_renewal, new.user_id);
  if not (v_check->>'allowed')::boolean then
    raise exception '%', v_check->>'reason' using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_subscription_purchase_rules() from public, anon, authenticated;

-- ============================================================================
-- 3) المسار الشرعي الوحيد لإنشاء طلب اشتراك
-- ============================================================================

-- ملاحظة على التوقيع: لا يوجد معامل user_id ولا status ولا تواريخ. هذا مقصود —
-- ما لا يُمرَّر لا يمكن تزويره. الهوية من auth.uid()، والحالة ثابتة، والتواريخ
-- محسوبة هنا.
create or replace function public.request_subscription_purchase(
  p_plan              text,
  p_billing_cycle     text,
  p_ticket_id         uuid    default null,
  p_is_renewal        boolean default false,
  p_payment_method    text    default null,
  p_payment_reference text    default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid        uuid := auth.uid();
  v_check      jsonb;
  v_days       int;
  v_prev_end   timestamptz := null;
  v_start      timestamptz := now();
  v_row        public.whatsapp_subscriptions%rowtype;
begin
  if v_uid is null then
    raise exception 'يجب تسجيل الدخول أولًا' using errcode = '42501';
  end if;

  if p_plan is null or not exists (
       select 1 from public.subscription_plans where key = p_plan and is_active) then
    raise exception 'باقة غير معروفة أو غير مفعّلة' using errcode = '22023';
  end if;

  if p_billing_cycle is null or p_billing_cycle not in ('monthly', 'yearly') then
    raise exception 'دورة فوترة غير صالحة' using errcode = '22023';
  end if;

  if p_payment_method is not null
     and p_payment_method not in ('bank_transfer', 'cash_wallet', 'instapay', 'gateway') then
    raise exception 'وسيلة دفع غير صالحة' using errcode = '22023';
  end if;

  -- التذكرة لا تُقبل إلا إذا كانت تخص المنادي. بدون هذا الفحص يستطيع العميل
  -- تعليق طلبه على تذكرة عميل آخر فيراها ذلك العميل في سجلّه.
  if p_ticket_id is not null and not exists (
       select 1 from public.tickets where id = p_ticket_id and user_id = v_uid) then
    raise exception 'التذكرة غير موجودة أو لا تخص حسابك' using errcode = '42501';
  end if;

  -- طلب معلّق لنفس الباقة: نمنعه هنا برسالة عربية واضحة قبل أن يصطدم العميل
  -- بخطأ قاعدة بيانات خام.
  if exists (
       select 1 from public.whatsapp_subscriptions
        where user_id = v_uid and plan = p_plan and status = 'pending') then
    raise exception 'لديك بالفعل طلب في هذه الباقة قيد المراجعة. انتظر رد فريق الدعم قبل إرسال طلب جديد.'
      using errcode = '42501';
  end if;

  -- نفس قاعدة التداخل التي يفرضها الحارس — تُنادى هنا لتعيد السبب بالعربي.
  v_check := public.subscription_purchase_check(p_plan, p_is_renewal, v_uid);
  if not (v_check->>'allowed')::boolean then
    raise exception '%', v_check->>'reason' using errcode = '42501';
  end if;

  v_days := case when p_billing_cycle = 'yearly' then 365 else 30 end;

  -- التجديد يمدّد من نهاية الاشتراك القائم لا من اليوم. القيمة تُقرأ من القاعدة
  -- ولا تُقبل من العميل، وإلا لمنح نفسه تاريخ بداية بعيدًا في المستقبل.
  if p_is_renewal then
    select max(end_date) into v_prev_end
      from public.whatsapp_subscriptions
     where user_id = v_uid and plan = p_plan
       and status = 'active' and end_date > now();
  end if;

  -- start_date/end_date هنا قيمتان مبدئيتان فقط لأن end_date عمود NOT NULL.
  -- التواريخ الحقيقية تُحسب عند التأكيد، فلا يكسب العميل يومًا واحدًا وهو
  -- pending. ومع ذلك نكتبهما بقيم محسوبة في الخادم لا مُرسَلة من العميل.
  insert into public.whatsapp_subscriptions (
    user_id, ticket_id, plan, billing_cycle,
    start_date, end_date, status, is_renewal,
    duration_days, previous_end_date, payment_method, payment_reference
  ) values (
    v_uid, p_ticket_id, p_plan, p_billing_cycle,
    v_start, v_start + make_interval(days => v_days), 'pending', coalesce(p_is_renewal, false),
    v_days, v_prev_end, p_payment_method,
    nullif(btrim(coalesce(p_payment_reference, '')), '')
  )
  returning * into v_row;

  return jsonb_build_object(
    'subscription_id', v_row.id,
    'status',          v_row.status,
    'plan',            v_row.plan,
    'billing_cycle',   v_row.billing_cycle,
    'is_renewal',      v_row.is_renewal,
    'previous_end_date', v_row.previous_end_date
  );
end;
$$;

revoke all on function public.request_subscription_purchase(text, text, uuid, boolean, text, text)
  from public, anon;
grant execute on function public.request_subscription_purchase(text, text, uuid, boolean, text, text)
  to authenticated;

-- ============================================================================
-- 4) التراجع عن طلب معلّق
-- ============================================================================

-- لماذا هذه الدالة موجودة أصلًا: مسار رفع إثبات التحويل في الواجهة كان يحاول
-- التراجع بـ‎delete()‎ على الاشتراك والتذكرة عند فشل الرفع — ولا سياسة DELETE
-- لأي منهما للمستخدم العادي، فالحذف كان **ينجح صامتًا بصفر صفوف** ويترك طلبًا
-- معلّقًا بلا إثبات. (Finding جديد اكتُشف أثناء الإصلاح — N1 في التقرير.)
create or replace function public.cancel_my_subscription_request(p_subscription_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid    uuid := auth.uid();
  v_ticket uuid;
begin
  if v_uid is null then
    return false;
  end if;

  -- pending فقط: لا يلغي العميل اشتراكًا فعّالًا بهذا المسار.
  delete from public.whatsapp_subscriptions
   where id = p_subscription_id and user_id = v_uid and status = 'pending'
   returning ticket_id into v_ticket;

  if not found then
    return false;
  end if;

  -- التذكرة تُحذف فقط إن كانت تخص نفس العميل وما زالت مفتوحة — حتى لا يمحو
  -- عميلٌ تذكرةً ردّ عليها الدعم بالفعل.
  if v_ticket is not null then
    delete from public.tickets
     where id = v_ticket and user_id = v_uid and status = 'open';
  end if;

  return true;
end;
$$;

revoke all on function public.cancel_my_subscription_request(uuid) from public, anon;
grant execute on function public.cancel_my_subscription_request(uuid) to authenticated;
