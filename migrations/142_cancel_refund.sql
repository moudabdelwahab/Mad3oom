-- ============================================================================
-- 142_cancel_refund.sql
--   إلغاء أي اشتراك مدفوع مع طلب تعويض (معمَّم من الفائقة وحدها — 142
--   الأصلية — إلى كل الباقات المدفوعة بقرارات صاحب المنتج 2026-11-27).
--
--   الباقات المشمولة: support (المتقدمة 999/9999) و ultimate (الفائقة
--   1999/19999) و whatsapp (1299/12999) و bundle (الشاملة 2099/22999) —
--   وهي بالضبط مجموعة قيد whatsapp_subscriptions_plan_check. باقة المتجر
--   store ليست منها: دُمجت في الفائقة بقرار صاحب المنتج، واشتراك store
--   نشط قديم يُرفض عرضه بكود not_refundable_plan (بلا مسار تعويض له).
--
--   ما الذي كان موجودًا
--   * الإلغاء في 136 هو إلغاء نهاية مدة بلا مقابل لأي باقة: علَم
--     cancel_at_period_end فقط، والخدمة تبقى حتى end_date، ولا أي مبلغ
--     يُحسب ولا طلب تعويض يُنشأ.
--   * لا جدول طلبات تعويض ولا دالة حساب تعويض ولا مسار تذكرة تعويض.
--
--   ما الذي يضيفه هذا الترحيل (لكل باقة مدفوعة)
--   1) جدول refund_requests: طلب تعويض واحد لكل اشتراك، بحالته
--      (pending/approved/rejected/paid/closed)، ونوعه (full/prorated)،
--      والأيام المتبقية وإجمالي أيام المدة والمبلغ المدفوع والتعويض
--      المحسوب والرسوم الفعلية والصافي وسبب الإلغاء والتذكرة المرتبطة
--      وبيانات التحويل ومهلتي الرد والدفع.
--   2) عرض التعويض refund_quote: قراءة فقط — الأيام المتبقية (ceil من
--      end_date بساعة القاعدة) وإجمالي أيام المدة والمبلغ المدفوع
--      والتعويض. تناسبيًا: round(المدفوع × المتبقي / إجمالي المدة، 2)؛
--      مثال: 30 يومًا مدفوع 1999 ومتبقٍ 10 → 666.33 جنيه؛ و365 يومًا
--      مدفوع 19999 ومتبقٍ 100 → 5479.18 جنيه. وكاملًا (refund_kind =
--      'full'): المبلغ المدفوع كاملًا، إن كان الاشتراك جديدًا (لا تجديد
--      ولا ترقية ولا تخفيض) وفي أول 7 أيام من start_date، وكان استهلاك
--      التذاكر منذ start_date ≤ 10% من الحد الشهري للباقة (راجع §2).
--   3) طلب الإلغاء مع التعويض request_cancel_refund: ينشئ طلب التعويض
--      ويلغي الاشتراك في نهاية مدته عبر cancel_my_active_subscription
--      (136) في معاملة واحدة — فشل أي خطوة يرجع الاثنين. الاشتراك يبقى
--      فعّالًا حتى نهاية المدة، ويُشعَر المالك بصف في notifications.
--   4) قوائم المالك وقراره: owner_list_refund_requests (المعلّقة أولًا)
--      و owner_decide_refund (موافقة/رفض، بتحقق حديث owner_critical_ok،
--      والرفض بسبب مسجَّل ≥10 أحرف).
--   5) تذكرة التعويض owner_open_refund_ticket: يفتحها المالك من حساب
--      العميل بعد الموافقة، على الآلية القائمة لا مسار جديد — صف tickets
--      مباشر (user_id = العميل، category = 'subscription'، scope =
--      'mad3oom_support' بلا شركة كما يفرض ختم النطاق 097، وعلم الفوترة
--      mad3oom.billing_request_ticket كما في 069 حتى لا تُحسب من رصيد
--      تذاكر العميل عند الإنشاء). وصف التذكرة يطلب من العميل بيانات
--      التحويل (وسيلة + رقم/حساب) من قسم التعويض في لوحة الشركة. لا ردّ
--      آلي ولا رسالة داخلية تُخترع هنا.
--   6) بيانات التحويل submit_refund_transfer_details: يرسلها مالك الشركة
--      بعد الموافقة (وطلب مفتوح التذكرة)، فتُحفظ على طلب التعويض ويُشعَر
--      المالك، وتُحسب مهلة الدفع payment_due_at: +14 يوم عمل للتحويل
--      البنكي والإنستاباي، و+3 أيام عمل للمحفظة الإلكترونية.
--   7) تسجيل الدفع owner_mark_refund_paid: يسجّل المالك أن التحويل تمّ
--      خارج النظام (بسبب مسجَّل) مع رسوم التحويل الفعلية (0 افتراضيًا)
--      — تسجيل فقط، لا صرف مال. الصافي = الإجمالي − الرسوم (عمود مولَّد).
--   8) التراجع عن الإلغاء resume_my_subscription — أُعيد تعريفه هنا
--      (ملف 136 نفسه بلا مساس): يغلق تلقائيًا طلبات التعويض المفتوحة
--      على الاشتراك (pending/approved → closed؛ والمدفوعة تبقى كما هي)،
--      ويمدّد السنوي 14 يومًا هدية مرة واحدة لكل مدة (علامة
--      refund_gift_granted_for_start على صف الاشتراك).
--
--   ── حدود صريحة (في الكود والواجهة معًا) ─────────────────────────────
--   • لا إلغاء فوري: الاشتراك يبقى فعّالًا حتى end_date، والخدمات لا
--     تُسحب قبلها. الإلغاء هنا هو إلغاء نهاية المدة نفسه من 136.
--   • لا صرف مال تلقائيًا: لا بوابة دفع ولا تحويل ولا خصم في أي دالة —
--     الطلب للمراجعة والقرار فقط، والدفع الفعلي خارج النظام ويسجَّله
--     المالك يدويًا بحالة paid.
--   • التعويض عن مدفوع حقيقي فقط: اشتراك تجربة (price_snapshot.trial)
--     أو مبلغ مدفوع صفر يُرفض — بلا مدفوع لا تعويض.
--   • التعويض الكامل بشروطه الثلاثة معًا: اشتراك جديد + أول 7 أيام +
--     استهلاك تذاكر ≤ 10% — وإلا فتناسبي.
--
--   المبلغ المدفوع: price_snapshot->>'amount' إن وجد على صف الاشتراك،
--   وإلا plan_price(plan, billing_cycle) من subscription_plans وقت
--   الطلب (999/9999 للمتقدمة، 1999/19999 للفائقة، 1299/12999 للواتساب،
--   2099/22999 للشاملة). تغيير السعر لاحقًا لا يغيّر طلبًا قائمًا لأن
--   المبلغ يُجمَّد في صف الطلب.
--
--   الإشعارات (القناة القائمة: صف في public.notifications، يقرأه جرس
--   لوحة المالك owner-notifications.js عبر notifications-service):
--   • عند وصول طلب تعويض: لكل مالك منصة في platform_authority
--     (level='owner')، رابط /owner/refunds.html، فئة refund.
--   • عند إرسال العميل بيانات التحويل: للمالك نفسه، بالرابط نفسه.
--   • عند قرار المالك وعند فتح التذكرة وعند تسجيل الدفع: إشعار للعميل
--     صاحب الطلب برابط لوحة الشركة (#subscriptions أو #tickets).
--   لا قناة إشعار جديدة هنا — نفس جدول notifications ونفس الجرس.
--
--   يعتمد على 019 (plan_price) و 023 (is_renewal و previous_end_date) و
--   053 (owner_critical_ok, log_privileged) و 065 (plan_ticket_quotas)
--   و 069 (ticket_account_owner وعلم تذكرة الفوترة) و 095/096
--   (current_company_id) و 097 (ختم نطاق التذاكر) و 133 (_store_reason)
--   و 136 (الإلغاء في نهاية المدة وسجل الاشتراكات والتراجع عنه).
--   قابل لإعادة التشغيل. بلا أي تحديث بيانات وبلا تفعيل باقة وبلا لمس
--   SIE. التراجع: migrations/_rollback/142_cancel_refund.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.plan_price(text,text)',
    'public.current_company_id()',
    'public._owner_require()', 'public.owner_critical_ok()',
    'public.log_privileged(text,uuid,jsonb,jsonb)',
    'public._store_reason(text)',
    'public.cancel_my_active_subscription(uuid,text)',
    'public.resume_my_subscription(uuid)',
    'public.ticket_account_owner(uuid)'] loop
    if to_regprocedure(f) is null then
      raise exception '142 يتطلب %', f;
    end if;
  end loop;
  if to_regclass('public.companies') is null or to_regclass('public.subscription_plans') is null
     or to_regclass('public.whatsapp_subscriptions') is null
     or to_regclass('public.subscription_audit_log') is null
     or to_regclass('public.privileged_audit') is null
     or to_regclass('public.notifications') is null
     or to_regclass('public.tickets') is null
     or to_regclass('public.platform_authority') is null
     or to_regclass('public.plan_ticket_quotas') is null then
    raise exception '142 يتطلب جداول الشركات والباقات والاشتراكات والإشعارات والتذاكر وسلطة المنصة وحصص التذاكر';
  end if;
  if (select count(distinct key) from public.subscription_plans
       where key in ('support', 'ultimate', 'whatsapp', 'bundle')) <> 4 then
    raise exception '142 يتطلب صفوف الباقات المدفوعة الأربع في subscription_plans';
  end if;
  -- أعمدة علامة التجديد/الترقية/التخفيض التي يبني عليها فحص «اشتراك جديد».
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'whatsapp_subscriptions'
         and column_name in ('is_renewal', 'previous_end_date',
                             'upgraded_from_subscription_id',
                             'downgraded_from_subscription_id')) <> 4 then
    raise exception '142 يتطلب أعمدة is_renewal و previous_end_date و upgraded_from_subscription_id و downgraded_from_subscription_id على whatsapp_subscriptions';
  end if;
end $$;


-- ============================================================================
-- 1) مسنَدا أيام وساعات العمل — قبل الجدول لأن مهلة الرد افتراضية عليه
--    أيام العمل: الأحد–الخميس (الجمعة والسبت خارجان). الساعات: ساعات
--    تقويمية تُحتسب في أيام العمل وحدها — يوم جمعة/سبت داخل النافذة لا
--    يُحتسب من المهلة، فتُضاف أيامه كاملةً؛ وطلب يصل في جمعة/سبت يبدأ
--    عدّاده من الأحد التالي في التوقيت نفسه. هذا التفسير حرفي لـ«48
--    ساعة — لا تُحتسب الجمعة والسبت» بلا افتراض ساعات دوام (لا نافذة
--    دوام معرّفة في المنصة)؛ إن أراد صاحب المنتج نافذة دوام (مثلًا
--    9–17) فهي تغيير سياسة لا تعديل كود صامت.
-- ============================================================================
-- اليوم الـ p_days من أيام العمل بعد p_from، بالتوقيت نفسه.
create or replace function public._refund_add_business_days(p_from timestamptz, p_days int)
returns timestamptz
language sql
immutable
security definer
set search_path to 'public'
as $$
  select p_from + ((d - p_from::date) * interval '1 day')
    from (select d::date as d
            from generate_series((p_from::date + 1), (p_from::date + p_days * 2 + 10), interval '1 day') d
           where extract(dow from d) not in (5, 6)
           order by d limit 1 offset greatest(p_days - 1, 0)) s;
$$;
comment on function public._refund_add_business_days(timestamptz, int) is
  '142: إضافة أيام عمل (الأحد–الخميس) من لحظة معينة، بالتوقيت نفسه — الجمعة والسبت يُتخطيان.';

-- إضافة ساعات عمل: الساعات تُحتسب في أيام العمل وحدها؛ الجمعة والسبت
-- داخل النافذة تُضاف أيامهما كاملةً، وطلب في جمعة/سبت يبدأ من الأحد
-- التالي في التوقيت نفسه. التكرار حتى تستقر النافذة (≤ 3 دورات لـ 48 س).
create or replace function public._refund_add_business_hours(p_from timestamptz, p_hours int)
returns timestamptz
language plpgsql
immutable
security definer
set search_path to 'public'
as $$
declare
  v_start timestamptz := p_from;
  v_due   timestamptz;
  v_target timestamptz;
  v_weekend int;
  v_iter  int := 0;
begin
  if extract(dow from v_start) in (5, 6) then
    -- الأحد التالي في التوقيت نفسه (الجمعة +2، السبت +1).
    v_start := v_start + ((7 - extract(dow from v_start))::int * interval '1 day');
  end if;
  v_due := v_start + make_interval(hours => p_hours);
  loop
    select count(*)::int into v_weekend
      from generate_series((v_start::date + 1), v_due::date, interval '1 day') d
     where extract(dow from d) in (5, 6);
    v_target := v_start + make_interval(hours => p_hours) + (v_weekend * interval '1 day');
    exit when v_target = v_due or v_iter >= 4;
    v_due := v_target;
    v_iter := v_iter + 1;
  end loop;
  return v_due;
end;
$$;
comment on function public._refund_add_business_hours(timestamptz, int) is
  '142: إضافة ساعات تُحتسب في أيام العمل وحدها (الأحد–الخميس) — الجمعة والسبت لا يُحتسبان من المهلة.';


-- ============================================================================
-- 2) جدول طلبات التعويض — بلا أي عمود دفع صادر (لا بطاقة ولا تحويل مال)
--    refund_kind: 'full' = المدفوع كاملًا (شروطه الثلاثة في العرض)،
--    و'prorated' = تناسبي. الصافي refund_net عمود مولَّد: الإجمالي −
--    الرسوم الفعلية (تُعرف عند تسجيل الدفع وحده، فالرسوم 0 عند الطلب).
--    reply_due_at افتراضيًا +48 ساعة عمل من الطلب؛ payment_due_at
--    تُحسب عند إرسال بيانات التحويل (+14 يوم عمل بنكي/إنستاباي،
--    و+3 أيام عمل للمحفظة الإلكترونية).
-- ============================================================================
create table if not exists public.refund_requests (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  user_id         uuid not null references public.profiles(id),
  subscription_id uuid not null references public.whatsapp_subscriptions(id) on delete cascade,
  plan            text not null,
  billing_cycle   text,
  cycle_days      int not null,
  remaining_days  int not null,
  amount_paid     numeric(14,2) not null,
  refund_kind     text not null default 'prorated',
  refund_amount   numeric(14,2) not null,
  transfer_fee    numeric(14,2) not null default 0,
  refund_net      numeric(14,2) generated always as (refund_amount - transfer_fee) stored,
  currency        text not null default 'EGP',
  tickets_used    int not null default 0,
  ticket_limit    int,
  ticket_allowance int,
  sie_usage       jsonb,
  cancel_reason   text,
  status          text not null default 'pending',
  ticket_id       uuid references public.tickets(id) on delete set null,
  transfer_method text,
  transfer_account text,
  transfer_details_submitted_at timestamptz,
  reply_due_at    timestamptz not null default public._refund_add_business_hours(now(), 48),
  payment_due_at  timestamptz,
  requested_at    timestamptz not null default now(),
  decided_at      timestamptz,
  decided_by      uuid references public.profiles(id),
  decision_reason text,
  paid_at         timestamptz,
  paid_by         uuid references public.profiles(id),
  paid_note       text,
  closed_at       timestamptz,
  closed_by       uuid references public.profiles(id),
  close_reason    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint refund_requests_plan_check
    check (plan in ('support', 'ultimate', 'whatsapp', 'bundle')),
  constraint refund_requests_kind_check
    check (refund_kind in ('full', 'prorated')),
  constraint refund_requests_status_check
    check (status in ('pending', 'approved', 'rejected', 'paid', 'closed')),
  constraint refund_requests_transfer_method_check
    check (transfer_method is null
           or transfer_method in ('bank_transfer', 'instapay', 'cash_wallet')),
  constraint refund_requests_days_check
    check (cycle_days > 0 and remaining_days >= 0 and remaining_days <= cycle_days),
  constraint refund_requests_amounts_check
    check (amount_paid > 0 and refund_amount >= 0 and refund_amount <= amount_paid
           and transfer_fee >= 0 and transfer_fee <= refund_amount),
  -- التعويض المحسوب بالضبط: كاملًا = المدفوع كاملًا، وتناسبيًا =
  -- المدفوع × المتبقي / إجمالي المدة مقربًا لقرشين. القيد يمنع أي رقم
  -- يُكتب يدويًا مخالفًا للمعادلة أو لنوع التعويض.
  constraint refund_requests_formula_check
    check (refund_amount = case when refund_kind = 'full' then amount_paid
                                else round(amount_paid * remaining_days / cycle_days, 2) end),
  -- قياس الـ10%: عدد صحيح غير سالب، والحد ≥1 والسماح الشهري >0 عند وجودهما.
  constraint refund_requests_tickets_check
    check (tickets_used >= 0
           and (ticket_limit is null or ticket_limit >= 1)
           and (ticket_allowance is null or ticket_allowance > 0)),
  -- بيانات التحويل لا تُقبل إلا بعد موافقة المالك، ولا تُسجَّل بلا وسيلة؛
  -- ومهلة الدفع لا تُضبط إلا مع بيانات التحويل. 'closed' مسموحة هنا لأن
  -- طلبًا موافَقًا عليه قد تُغلقه عودة العميل عن الإلغاء بعد إرسال بياناته.
  constraint refund_requests_transfer_check
    check ((transfer_account is null) = (transfer_method is null)
           and (transfer_details_submitted_at is null or transfer_method is not null)
           and (transfer_details_submitted_at is null or status in ('approved', 'paid', 'closed'))
           and (payment_due_at is null or transfer_details_submitted_at is not null)),
  -- معلّق ⟺ بلا قرار؛ والمغلق مستثنى (إغلاقه يُسجَّل في closed_* لا في القرار).
  constraint refund_requests_decision_check
    check ((status = 'pending') = (decided_at is null) or status = 'closed'),
  constraint refund_requests_paid_check
    check ((status = 'paid') = (paid_at is not null)),
  constraint refund_requests_closed_check
    check ((status = 'closed') = (closed_at is not null))
);
comment on table public.refund_requests is
  '142: طلبات تعويض إلغاء الاشتراكات المدفوعة — طلب للمراجعة والقرار فقط: لا إلغاء فوري للاشتراك ولا صرف مال تلقائيًا. التعويض تناسبي من الأيام المتبقية، أو كامل في أول 7 أيام لاشتراك جديد باستهلاك تذاكر ≤ 10%، والدفع الفعلي خارج النظام ويسجَّله المالك بحالة paid.';
comment on column public.refund_requests.refund_amount is
  '142: التعويض المحسوب — كاملًا = amount_paid، وتناسبيًا = round(amount_paid * remaining_days / cycle_days, 2) بالجنيه المصري — قيد refund_requests_formula_check يفرض المعادلة حسب النوع.';
comment on column public.refund_requests.refund_net is
  '142: الصافي المستحق = refund_amount − transfer_fee (عمود مولَّد) — الرسوم الفعلية وحدها تُخصم، وتُسجَّل عند الدفع.';
comment on column public.refund_requests.transfer_account is
  '142: رقم/حساب التحويل كما أرسله العميل — على الطلب وحده، ولا يُكتب في أي تذكرة أو ردّ.';
comment on column public.refund_requests.status is
  '142: pending بانتظار قرار المالك، approved وافق المالك (بلا دفع بعد)، rejected رفض، paid سجّل المالك أن التحويل تمّ خارج النظام، closed أُغلق تلقائيًا بتراجع العميل عن الإلغاء قبل نهاية المدة.';
comment on column public.refund_requests.reply_due_at is
  '142: مهلة رد المالك: +48 ساعة عمل (الأحد–الخميس) من الطلب — تُحسب افتراضيًا عند الإنشاء.';
comment on column public.refund_requests.payment_due_at is
  '142: مهلة التحويل: +14 يوم عمل للبنك والإنستاباي، و+3 أيام عمل للمحفظة الإلكترونية — تُحسب عند إرسال بيانات التحويل.';
comment on column public.refund_requests.tickets_used is
  '142: تذاكر غير الفوترة لحساب الاشتراك (المالك + تابعوه) منذ start_date حتى لحظة العرض — بسط اختبار الـ10% للتعويض الكامل.';
comment on column public.refund_requests.ticket_limit is
  '142: حد الـ10% للتذاكر (10% من الحد الشهري للباقة، بحد أدنى 1) — مقام اختبار التعويض الكامل.';
comment on column public.refund_requests.sie_usage is
  '142: مكوّن SIE في اختبار الـ10% — ركيزة مؤجلة: null حتى يُبنى الحد الشهري لـ SIE لكل باقة (راجع _refund_sie_usage).';

-- طلب واحد غير منتهٍ (معلّق أو موافَق عليه) لكل اشتراك — يمنع طلبين
-- متوازيين على نفس المدة، ويسمح بطلب جديد بعد رفض أو دفع أو إغلاق.
create unique index if not exists refund_requests_one_open
  on public.refund_requests (subscription_id) where status in ('pending', 'approved');
create index if not exists refund_requests_company_idx
  on public.refund_requests (company_id, requested_at desc);
create index if not exists refund_requests_status_idx
  on public.refund_requests (status, requested_at desc);

-- RLS على نمط saas_trial_requests (137): القراءة والإدراج لمالك الشركة
-- وحده، والتعديل عبر دوال RPC فقط (SECURITY DEFINER) — بلا سياسة
-- UPDATE/DELETE، فلا كتابة مباشرة من المتصفح على الطلب إطلاقًا.
alter table public.refund_requests enable row level security;
drop policy if exists refund_requests_select_own on public.refund_requests;
create policy refund_requests_select_own on public.refund_requests
  for select to authenticated
  using (exists (select 1 from public.companies c
                  where c.id = refund_requests.company_id and c.user_id = auth.uid()));
drop policy if exists refund_requests_insert_own on public.refund_requests;
create policy refund_requests_insert_own on public.refund_requests
  for insert to authenticated
  with check (exists (select 1 from public.companies c
                       where c.id = refund_requests.company_id and c.user_id = auth.uid()));

-- علامة هدية الـ14 يومًا: بداية المدة التي مُنحت عنها الهدية (مرة واحدة
-- لكل مدة). تُضبط عند أول تراجع عن إلغاء اشتراك سنوي في تلك المدة،
-- وتُقارن مع start_date الحالية عند كل تراجع لاحق.
alter table public.whatsapp_subscriptions
  add column if not exists refund_gift_granted_for_start timestamptz;
comment on column public.whatsapp_subscriptions.refund_gift_granted_for_start is
  '142: بداية مدة الاشتراك التي مُنحت عنها هدية الـ14 يومًا عند التراجع عن الإلغاء — تمنع منح الهدية مرتين في المدة نفسها.';


-- ============================================================================
-- 3) مسنَدات داخلية
-- ============================================================================
-- المبلغ المدفوع عن المدة الحالية: لقطة الاشتراك أولًا (amount ثم price)،
-- وإلا سعر الباقة الحالي لدورة الفوترة نفسها من subscription_plans.
create or replace function public._refund_amount_paid(p_sub public.whatsapp_subscriptions)
returns numeric
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(
    nullif((p_sub.price_snapshot->>'amount')::numeric, 0),
    nullif((p_sub.price_snapshot->>'price')::numeric, 0),
    public.plan_price(p_sub.plan, p_sub.billing_cycle))
$$;

-- هل هذا اشتراك جديد (لا تجديد ولا ترقية ولا تخفيض)؟ اقتران الأربعة
-- معًا — آمن الفشل: أي علامة تجديد/ترقية/تخفيض تُسقط «جديد» ولو كانت
-- العلامات الأخرى غائبة. ملاحظة: is_renewal يضبطه المتصل، فتجديد
-- مختوم is_renewal=true بلا سابقة يُعامل تجديدًا ويفقد ميزة الكامل
-- (يمنع المنفعة لا يمنحها) — والتشديد بربط renewed_from يُقترح لاحقًا.
create or replace function public._refund_is_new_subscription(p_sub public.whatsapp_subscriptions)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select not coalesce(p_sub.is_renewal, false)
     and p_sub.previous_end_date is null
     and p_sub.upgraded_from_subscription_id is null
     and p_sub.downgraded_from_subscription_id is null;
$$;
comment on function public._refund_is_new_subscription(public.whatsapp_subscriptions) is
  '142: اشتراك جديد = لا تجديد ولا ترقية ولا تخفيض — شرط التعويض الكامل الأول.';

-- الحد الشهري للتذاكر للباقة (مقام اختبار الـ10%): من plan_ticket_quotas؛
-- والغائب (whatsapp: بلا صف) يُعامل 20 كافتراضي الحصة (069)؛ وبلا حد
-- (ultimate/bundle: null) يُعامل بالمرجع 300 كما قرر صاحب المنتج.
create or replace function public._refund_ticket_allowance(p_plan text)
returns integer
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(
    (select monthly_tickets from public.plan_ticket_quotas where plan_key = p_plan),
    case when p_plan in ('ultimate', 'bundle') then 300 else 20 end);
$$;
comment on function public._refund_ticket_allowance(text) is
  '142: الحد الشهري للتذاكر للباقة — 300 للمتقدمة، و20 للواتساب (بلا صف، كافتراضي 069)، و300 مرجعًا للفائقة والشاملة (بلا حد).';

-- حد الـ10%: 10% من الحد الشهري، مقصورًا لأسفل، بحد أدنى 1 (دعم 30،
-- واتساب 2، فائقة/شاملة 30 بالمرجع).
create or replace function public._refund_ticket_usage_limit(p_plan text)
returns integer
language sql
stable
security definer
set search_path to 'public'
as $$
  select greatest(1, floor(public._refund_ticket_allowance(p_plan) * 0.1)::int);
$$;
comment on function public._refund_ticket_usage_limit(text) is
  '142: حد استهلاك التذاكر للتعويض الكامل — 10% من الحد الشهري للباقة (بحد أدنى 1).';

-- تذاكر غير الفوترة لحساب الاشتراك منذ لحظة معينة — نفس قاعدة
-- ticket_quota_status (069) حرفيًا: صاحب الحساب + تابعوه
-- (super_user_id)، والفوترة = فئة whatsapp_wallet_topup أو تذكرة
-- مرتبطة فعلًا بطلب اشتراك (whatsapp_subscriptions.ticket_id).
-- الفرق الوحيد: النافذة هنا منذ start_date لا الشهر التقويمي.
create or replace function public._refund_ticket_usage(p_user_id uuid, p_since timestamptz)
returns integer
language sql
stable
security definer
set search_path to 'public'
as $$
  select count(*)::int
    from public.tickets t
   where (t.user_id = public.ticket_account_owner(p_user_id)
          or t.user_id in (select p.id from public.profiles p
                            where p.super_user_id = public.ticket_account_owner(p_user_id)))
     and t.created_at >= p_since
     and not (coalesce(t.category, '') = 'whatsapp_wallet_topup'
              or exists (select 1 from public.whatsapp_subscriptions s where s.ticket_id = t.id));
$$;
comment on function public._refund_ticket_usage(uuid, timestamptz) is
  '142: عدد تذاكر الحساب غير الفوترة منذ لحظة معينة — بسط اختبار الـ10%، بنفس قاعدة الفوترة في ticket_quota_status (069).';

-- مكوّن SIE في اختبار الـ10% — ركيزة مؤجلة عمدًا: لا يوجد بعد حد شهري
-- لـ SIE لكل باقة، فلا يُحسب استهلاك SIE هنا (included=false). عند بناء
-- الحد (جدول حد SIE لكل باقة + عدّاد) تُستبدل هذه الدالة بعدّاد SIE
-- الرسمي customer_sie_access.messages_used (+1 لكل دور محادثة) وتُدمج
-- نتيجتها في شرط الـ10% في refund_quote. لا يُخترع جدول حد هنا.
create or replace function public._refund_sie_usage(p_user_id uuid, p_since timestamptz)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object('included', false, 'usage', null, 'limit', null, 'pending', true);
$$;
comment on function public._refund_sie_usage(uuid, timestamptz) is
  '142: ركيزة SIE في اختبار الـ10% — مؤجلة حتى يُبنى الحد الشهري لـ SIE لكل باقة؛ العدّاد الرسمي حينها customer_sie_access.messages_used. لا تُحسب SIE اليوم.';

-- رقم الحساب حساس: يُكشف كاملًا لمالك الشركة صاحبة الطلب وللمالك
-- وحدهما (p_show_transfer)؛ أي قارئ آخر (عضو فريق الشركة) يرى أن
-- البيانات وُصلت ووسيلتها فقط، بلا رقم.
create or replace function public._refund_request_json(p_request uuid, p_show_transfer boolean default false)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'id', r.id, 'company_id', r.company_id, 'company_name', c.company_name,
    'user_id', r.user_id,
    'customer_email', (select email from public.profiles where id = r.user_id),
    'subscription_id', r.subscription_id, 'plan', r.plan,
    'plan_name_ar', coalesce(sp.name_ar, sp.name, r.plan),
    'billing_cycle', r.billing_cycle,
    'cycle_days', r.cycle_days, 'remaining_days', r.remaining_days,
    'amount_paid', r.amount_paid, 'refund_kind', r.refund_kind,
    'refund_amount', r.refund_amount, 'transfer_fee', r.transfer_fee,
    'refund_net', r.refund_net,
    'currency', r.currency, 'cancel_reason', r.cancel_reason,
    'tickets_used', r.tickets_used, 'ticket_limit', r.ticket_limit,
    'ticket_allowance', r.ticket_allowance, 'sie_usage', r.sie_usage,
    'status', r.status, 'ticket_id', r.ticket_id,
    'ticket_number', (select ticket_number from public.tickets where id = r.ticket_id),
    'transfer_method', r.transfer_method,
    'transfer_account', case when p_show_transfer then r.transfer_account else null end,
    'transfer_details_submitted_at', r.transfer_details_submitted_at,
    'reply_due_at', r.reply_due_at, 'payment_due_at', r.payment_due_at,
    'requested_at', r.requested_at, 'decided_at', r.decided_at,
    'decided_by', r.decided_by, 'decision_reason', r.decision_reason,
    'paid_at', r.paid_at, 'paid_by', r.paid_by, 'paid_note', r.paid_note,
    'closed_at', r.closed_at, 'closed_by', r.closed_by, 'close_reason', r.close_reason,
    'is_pending', r.status = 'pending',
    'is_approved', r.status = 'approved',
    'is_closed', r.status = 'closed',
    'needs_transfer_details', r.status = 'approved' and r.ticket_id is not null
                              and r.transfer_details_submitted_at is null,
    'can_open_ticket', r.status = 'approved' and r.ticket_id is null,
    'can_mark_paid', r.status = 'approved' and r.transfer_details_submitted_at is not null)
    from public.refund_requests r
    join public.companies c on c.id = r.company_id
    left join public.subscription_plans sp on sp.key = r.plan
   where r.id = p_request;
$$;
comment on function public._refund_request_json(uuid, boolean) is
  '142: طلب تعويض واحد كـ JSON للواجهتين — بلا مصدر صلاحية.';

-- إشعار كل مالك منصة (platform_authority level=owner) — القناة القائمة
-- نفسها في 097 (طلبات الوصول): صف في notifications يقرأه جرس المالك.
create or replace function public._notify_platform_owners(
  p_title text, p_message text, p_type text, p_link text, p_reference uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  insert into public.notifications (user_id, title, message, type, link, category, reference_id)
  select a.user_id, p_title, p_message, p_type, p_link, 'refund', p_reference
    from public.platform_authority a
   where a.level = 'owner';
end;
$$;
comment on function public._notify_platform_owners(text, text, text, text, uuid) is
  '142: إشعار مالك المنصة عبر جدول notifications القائم (يقرأه جرس لوحة المالك) — بلا قناة جديدة.';


-- ============================================================================
-- 4) عرض التعويض — قراءة فقط، بلا إنشاء وبلا إلغاء وبلا دفع
--    التعويض الكامل بشروطه الثلاثة معًا: اشتراك جديد (لا تجديد ولا ترقية
--    ولا تخفيض) + أول 7 أيام من start_date + تذاكر منذ start_date ≤
--    10% من الحد الشهري للباقة. مكوّن SIE في الاختبار ركيزة مؤجلة
--    (pending=true) لا تُسقط الكامل اليوم — راجع _refund_sie_usage.
-- ============================================================================
create or replace function public.refund_quote(p_subscription_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_uid        uuid := auth.uid();
  v_sub        public.whatsapp_subscriptions%rowtype;
  v_remaining  int;
  v_cycle      int;
  v_paid       numeric;
  v_refund     numeric;
  v_kind       text := 'prorated';
  v_existing   uuid;
  v_is_new     boolean;
  v_within_7d  boolean;
  v_used       int;
  v_limit      int;
  v_allowance  int;
  v_sie        jsonb;
  v_sie_ok     boolean;
begin
  if v_uid is null then
    return jsonb_build_object('eligible', false, 'code', 'not_authenticated');
  end if;

  select * into v_sub from public.whatsapp_subscriptions
   where id = p_subscription_id;

  if v_sub.id is null then
    return jsonb_build_object('eligible', false, 'code', 'not_found');
  end if;

  -- الملكية: صاحب الاشتراك نفسه، أو مالك الشركة التي يتبعها — نفس فحص
  -- إلغاء نهاية المدة (136) حرفيًا.
  if v_sub.user_id is distinct from v_uid
     and not exists (select 1 from public.companies c
                      where c.id = v_sub.company_id and c.user_id = v_uid) then
    return jsonb_build_object('eligible', false, 'code', 'not_yours');
  end if;

  if v_sub.plan is null or v_sub.plan not in ('support', 'ultimate', 'whatsapp', 'bundle') then
    return jsonb_build_object('eligible', false, 'code', 'not_refundable_plan');
  end if;

  if v_sub.status <> 'active' or v_sub.end_date <= now() then
    return jsonb_build_object('eligible', false, 'code', 'no_active_subscription');
  end if;

  -- تجربة مجانية أو مبلغ صفر: بلا مدفوع لا تعويض.
  if coalesce((v_sub.price_snapshot->>'trial')::boolean, false) then
    return jsonb_build_object('eligible', false, 'code', 'trial_no_refund');
  end if;

  v_paid := public._refund_amount_paid(v_sub);
  if v_paid is null or v_paid <= 0 then
    return jsonb_build_object('eligible', false, 'code', 'amount_missing');
  end if;

  select id into v_existing from public.refund_requests
   where subscription_id = v_sub.id and status in ('pending', 'approved')
   order by requested_at desc limit 1;
  if v_existing is not null then
    return jsonb_build_object('eligible', false, 'code', 'already_requested',
                              'refund_request_id', v_existing);
  end if;

  v_remaining := greatest(0, ceil(extract(epoch from (v_sub.end_date - now())) / 86400))::int;
  v_cycle := greatest(1, round(extract(epoch from (v_sub.end_date - v_sub.start_date)) / 86400))::int;

  -- اختبار التعويض الكامل: جديد + أول 7 أيام + تذاكر ≤ 10% + مكوّن SIE.
  v_is_new := public._refund_is_new_subscription(v_sub);
  v_within_7d := v_sub.start_date <= now()
                 and now() <= v_sub.start_date + interval '7 days';
  v_used := public._refund_ticket_usage(v_sub.user_id, v_sub.start_date);
  v_allowance := public._refund_ticket_allowance(v_sub.plan);
  v_limit := public._refund_ticket_usage_limit(v_sub.plan);
  v_sie := public._refund_sie_usage(v_sub.user_id, v_sub.start_date);
  -- مكوّن SIE غير مشمول اليوم (pending) فلا يؤثر؛ وإن شُمل لاحقًا صار
  -- شرطه usage ≤ limit جزءًا من الاختبار — وأي قيمة مجهولة فيه تُسقط
  -- الكامل (آمن الفشل) بدل منحه. راجع _refund_sie_usage.
  v_sie_ok := not coalesce((v_sie->>'included')::boolean, false)
              or coalesce((v_sie->>'usage')::int, 999999)
                 <= coalesce((v_sie->>'limit')::int, -1);

  if v_is_new and v_within_7d and v_used <= v_limit and v_sie_ok then
    v_kind := 'full';
    v_refund := v_paid;
  else
    v_kind := 'prorated';
    v_refund := round(v_paid * v_remaining / v_cycle, 2);
  end if;

  return jsonb_build_object(
    'eligible', true,
    'code', 'refund_quote',
    'currency', 'EGP',
    'subscription_id', v_sub.id,
    'plan', v_sub.plan,
    'plan_name_ar', coalesce((select coalesce(name_ar, name, v_sub.plan) from public.subscription_plans where key = v_sub.plan), v_sub.plan),
    'billing_cycle', v_sub.billing_cycle,
    'start_date', v_sub.start_date,
    'end_date', v_sub.end_date,
    'remaining_days', v_remaining,
    'cycle_days', v_cycle,
    'amount_paid', v_paid,
    'refund_kind', v_kind,
    'refund_amount', v_refund,
    'is_new_subscription', v_is_new,
    'within_full_refund_window', v_within_7d,
    'tickets_used', v_used,
    'ticket_limit', v_limit,
    'ticket_allowance', v_allowance,
    'ticket_allowance_is_reference', v_sub.plan in ('ultimate', 'bundle'),
    'sie_usage', v_sie,
    'already_cancelled_at_period_end', coalesce(v_sub.cancel_at_period_end, false)
  );
end;
$function$;

comment on function public.refund_quote(uuid) is
  '142: عرض تعويض إلغاء اشتراك مدفوع: الأيام المتبقية وإجمالي أيام المدة والمبلغ المدفوع والتعويض — تناسبي round(المدفوع × المتبقي / الإجمالي، 2) أو كامل (المدفوع كاملًا) لاشتراك جديد في أول 7 أيام باستهلاك تذاكر ≤ 10% من الحد الشهري. قراءة فقط — لا يلغي ولا ينشئ طلبًا ولا يدفع.';

revoke all on function public.refund_quote(uuid) from public, anon;
grant execute on function public.refund_quote(uuid) to authenticated;


-- ============================================================================
-- 5) طلب الإلغاء مع التعويض — مالك الشركة أو صاحب الاشتراك
--    ينشئ طلب التعويض ويلغي الاشتراك في نهاية مدته (136) في معاملة واحدة.
--    الاشتراك يبقى فعّالًا حتى end_date: لا إلغاء فوري ولا صرف مال هنا.
-- ============================================================================
create or replace function public.request_cancel_refund(
  p_subscription_id uuid,
  p_reason          text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  v_uid      uuid := auth.uid();
  v_quote    jsonb;
  v_sub      public.whatsapp_subscriptions%rowtype;
  v_reason   text := left(nullif(btrim(coalesce(p_reason, '')), ''), 500);
  v_request  uuid;
  v_company  text;
  v_plan_ar  text;
  v_kind_ar  text;
begin
  if v_uid is null then
    raise exception 'يجب تسجيل الدخول أولًا' using errcode = '42501';
  end if;

  -- العرض هو الفحص الواحد: الملكية والباقة والفعّالية والمبلغ وغياب
  -- طلب مفتوح — فلا نسخة ثانية من الشروط هنا تنحرف عنه لاحقًا.
  v_quote := public.refund_quote(p_subscription_id);
  if (v_quote->>'eligible')::boolean is not true then
    raise exception 'لا يمكن طلب تعويض إلغاء لهذا الاشتراك (%).',
      coalesce(v_quote->>'code', 'unknown') using errcode = '42501';
  end if;

  select * into v_sub from public.whatsapp_subscriptions
   where id = p_subscription_id for update;

  if v_sub.status <> 'active' or v_sub.end_date <= now() then
    raise exception 'الاشتراك الحالي لم يعد صالحًا لطلب التعويض' using errcode = '42501';
  end if;

  -- الإلغاء في نهاية المدة أولًا (136): يرفض هو نفسه وجود طلب معلّق
  -- (تجديد/ترقية/تخفيض) على الاشتراك — فيرجع كل شيء معًا إن رفض.
  -- وإن كان ملغى أصلًا بلا تعويض يعيد نفس النتيجة بلا تدقيق مكرر.
  perform public.cancel_my_active_subscription(p_subscription_id, v_reason);

  insert into public.refund_requests (
    company_id, user_id, subscription_id, plan, billing_cycle,
    cycle_days, remaining_days, amount_paid, refund_kind, refund_amount,
    currency, tickets_used, ticket_limit, ticket_allowance, sie_usage,
    cancel_reason,
    reply_due_at
  ) values (
    v_sub.company_id, v_sub.user_id, v_sub.id, v_sub.plan, v_sub.billing_cycle,
    (v_quote->>'cycle_days')::int, (v_quote->>'remaining_days')::int,
    (v_quote->>'amount_paid')::numeric, (v_quote->>'refund_kind')::text,
    (v_quote->>'refund_amount')::numeric,
    'EGP',
    (v_quote->>'tickets_used')::int, (v_quote->>'ticket_limit')::int,
    (v_quote->>'ticket_allowance')::int, (v_quote->'sie_usage'),
    v_reason,
    public._refund_add_business_hours(now(), 48)
  )
  returning id into v_request;

  insert into public.subscription_audit_log (
    subscription_id, target_user_id, actor_user_id, actor_email,
    action, old_values, new_values, reason
  ) values (
    v_sub.id, v_sub.user_id, v_uid,
    (select email from public.profiles where id = v_uid),
    'cancel_refund_requested',
    jsonb_build_object('cancel_at_period_end', coalesce(v_sub.cancel_at_period_end, false), 'status', 'active'),
    jsonb_build_object('cancel_at_period_end', true, 'status', 'active',
                       'end_date', v_sub.end_date,
                       'refund_request_id', v_request,
                       'refund_kind', (v_quote->>'refund_kind')::text,
                       'refund_amount', (v_quote->>'refund_amount')::numeric,
                       'remaining_days', (v_quote->>'remaining_days')::int,
                       'tickets_used', (v_quote->>'tickets_used')::int,
                       'ticket_limit', (v_quote->>'ticket_limit')::int),
    coalesce(v_reason, 'طلب إلغاء اشتراك مدفوع مع تعويض')
  );

  -- إشعار المالك (القناة القائمة: notifications + جرس لوحة المالك).
  select company_name into v_company from public.companies where id = v_sub.company_id;
  select coalesce(name_ar, name, v_sub.plan) into v_plan_ar
    from public.subscription_plans where key = v_sub.plan;
  v_kind_ar := case when (v_quote->>'refund_kind') = 'full' then 'كامل' else 'تناسبي' end;
  perform public._notify_platform_owners(
    'طلب تعويض إلغاء جديد',
    format('طلبت شركة «%s» إلغاء %s مع تعويض %s %s جنيه عن %s %s متبقية من مدة %s %s. الطلب بانتظار قرارك — لا إلغاء فوري ولا صرف تلقائي.',
           coalesce(v_company, 'بلا اسم'),
           coalesce(v_plan_ar, v_sub.plan),
           v_kind_ar,
           (v_quote->>'refund_amount')::numeric,
           (v_quote->>'remaining_days')::int,
           case when (v_quote->>'remaining_days')::int = 1 then 'يوم' else 'أيام' end,
           (v_quote->>'cycle_days')::int,
           case when (v_quote->>'cycle_days')::int = 1 then 'يوم' else 'أيام' end),
    'warning', '/owner/refunds.html', v_request);

  return public._refund_request_json(v_request, true);
end;
$function$;

comment on function public.request_cancel_refund(uuid, text) is
  '142: طلب إلغاء اشتراك مدفوع مع تعويض (كامل أو تناسبي حسب العرض): ينشئ طلب التعويض ويلغي الاشتراك في نهاية مدته (136) في معاملة واحدة، ويُشعر المالك. الاشتراك يبقى فعّالًا حتى end_date — لا إلغاء فوري ولا صرف مال.';

revoke all on function public.request_cancel_refund(uuid, text) from public, anon;
grant execute on function public.request_cancel_refund(uuid, text) to authenticated;


-- ============================================================================
-- 6) طلبات التعويض لشركتي — قراءة فريق الشركة الحالية (بلا معامل)
-- ============================================================================
create or replace function public.my_refund_requests()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company_id uuid;
  v_co         public.companies%rowtype;
begin
  v_company_id := public.current_company_id();
  if v_company_id is null then
    return jsonb_build_object('has_company', false, 'requests', '[]'::jsonb, 'can_request', false);
  end if;
  select * into v_co from public.companies where id = v_company_id;
  return jsonb_build_object(
    'has_company', true, 'company_id', v_co.id, 'company_name', v_co.company_name,
    'can_request', v_co.user_id = auth.uid(),
    'requests', (
      -- رقم الحساب لمالك الشركة وحده؛ عضو الفريق يرى الطلب بلا رقم.
      select coalesce(jsonb_agg(public._refund_request_json(r.id, v_co.user_id = auth.uid())
                                order by r.requested_at desc), '[]'::jsonb)
        from public.refund_requests r where r.company_id = v_company_id));
end $$;
comment on function public.my_refund_requests() is
  '142: طلبات تعويض إلغاء الاشتراكات المدفوعة لشركة المستخدم الحالي، مع صلاحية الطلب (مالك الشركة وحده).';

revoke all on function public.my_refund_requests() from public, anon;
grant execute on function public.my_refund_requests() to authenticated;


-- ============================================================================
-- 7) إرسال بيانات التحويل — مالك الشركة صاحب الطلب، بعد الموافقة
--    تُحفظ على طلب التعويض وحده (لا في تذكرة ولا ردّ)، ويُشعَر المالك،
--    وتُحسب مهلة الدفع: +14 يوم عمل للتحويل البنكي والإنستاباي (يُعامل
--    الإنستاباي معاملة البنك بانتظار تأكيد صاحب المنتج)، و+3 أيام عمل
--    للمحفظة الإلكترونية.
-- ============================================================================
create or replace function public.submit_refund_transfer_details(
  p_request uuid,
  p_transfer_method text,
  p_transfer_account text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  v_req     public.refund_requests%rowtype;
  v_co      public.companies%rowtype;
  v_account text := nullif(btrim(coalesce(p_transfer_account, '')), '');
  v_company text;
  v_due     timestamptz;
begin
  if auth.uid() is null then
    raise exception 'يجب تسجيل الدخول أولًا' using errcode = '42501';
  end if;
  if p_transfer_method is null
     or p_transfer_method not in ('bank_transfer', 'instapay', 'cash_wallet') then
    raise exception 'وسيلة التحويل غير صالحة: تحويل بنكي أو إنستاباي أو محفظة إلكترونية' using errcode = '22023';
  end if;
  if v_account is null or char_length(v_account) < 6 or char_length(v_account) > 100 then
    raise exception 'رقم/حساب التحويل مطلوب (6 أحرف على الأقل، و100 كحد أقصى)' using errcode = '22023';
  end if;

  select * into v_req from public.refund_requests where id = p_request for update;
  if not found then
    raise exception 'طلب التعويض غير موجود' using errcode = 'P0002';
  end if;
  select * into v_co from public.companies where id = v_req.company_id;
  if v_co.user_id <> auth.uid() then
    raise exception 'إرسال بيانات التحويل لمالك الشركة صاحبة الطلب وحده' using errcode = '42501';
  end if;
  if v_req.status <> 'approved' then
    raise exception 'بيانات التحويل تُرسل بعد موافقة المالك على طلب التعويض فقط' using errcode = '22023';
  end if;
  if v_req.ticket_id is null then
    raise exception 'لم يفتح المالك تذكرة التعويض بعد — انتظر فتحها أولًا' using errcode = '22023';
  end if;
  if v_req.transfer_details_submitted_at is not null then
    raise exception 'أرسلت بيانات التحويل بالفعل لهذا الطلب' using errcode = '22023';
  end if;

  v_due := case when p_transfer_method = 'cash_wallet'
                then public._refund_add_business_days(now(), 3)
                else public._refund_add_business_days(now(), 14) end;

  update public.refund_requests
     set transfer_method = p_transfer_method,
         transfer_account = v_account,
         transfer_details_submitted_at = now(),
         payment_due_at = v_due,
         updated_at = now()
   where id = p_request;

  -- إشعار المالك (القناة القائمة): بيانات التحويل وصلت، والقرار التالي له.
  select company_name into v_company from public.companies where id = v_req.company_id;
  perform public._notify_platform_owners(
    'وصلت بيانات تحويل تعويض',
    format('أرسلت شركة «%s» بيانات التحويل لتعويض %s جنيه (تذكرة التعويض #%s). مهلة التحويل حتى %s. راجع الطلب وسجّل الدفع بعد التحويل — لا صرف تلقائي.',
           coalesce(v_company, 'بلا اسم'), v_req.refund_amount,
           coalesce((select ticket_number::text from public.tickets where id = v_req.ticket_id), '—'),
           to_char(v_due, 'YYYY-MM-DD')),
    'info', '/owner/refunds.html', p_request);

  return public._refund_request_json(p_request, true);
end;
$function$;

comment on function public.submit_refund_transfer_details(uuid, text, text) is
  '142: إرسال بيانات التحويل (وسيلة + رقم/حساب) من مالك الشركة بعد موافقة المالك وفتح تذكرة التعويض — تُحفظ على طلب التعويض وحده وتُشعر المالك، وتُحسب مهلة الدفع (+14 يوم عمل بنكي/إنستاباي، +3 أيام عمل محفظة). لا صرف مال هنا.';

revoke all on function public.submit_refund_transfer_details(uuid, text, text) from public, anon;
grant execute on function public.submit_refund_transfer_details(uuid, text, text) to authenticated;


-- ============================================================================
-- 8) قائمة طلبات التعويض للمالك — المعلّقة أولًا
-- ============================================================================
create or replace function public.owner_list_refund_requests(p_status text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  perform public._owner_require();
  if p_status is not null and p_status not in ('pending', 'approved', 'rejected', 'paid', 'closed') then
    raise exception 'حالة طلب غير صالحة' using errcode = '22023';
  end if;
  return (select coalesce(jsonb_agg(public._refund_request_json(r.id, true)
                    order by (r.status = 'pending') desc, r.requested_at desc), '[]'::jsonb)
            from public.refund_requests r
           where p_status is null or r.status = p_status);
end $$;
comment on function public.owner_list_refund_requests(text) is
  '142: قائمة طلبات تعويض إلغاء الاشتراكات المدفوعة للمالك — المعلّقة أولًا، مع الشركة والمبلغ والأيام والسبب والتذكرة وبيانات التحويل والمهل.';

revoke all on function public.owner_list_refund_requests(text) from public, anon;
grant execute on function public.owner_list_refund_requests(text) to authenticated;


-- ============================================================================
-- 9) قرار المالك: موافقة أو رفض — بتحقق حديث، والرفض بسبب مسجَّل.
--    الموافقة لا تلغي فورًا (الإلغاء تمّ في نهاية المدة عند الطلب) ولا
--    تدفع شيئًا — تفتح فقط باب تذكرة التعويض وبيانات التحويل.
-- ============================================================================
create or replace function public.owner_decide_refund(p_request uuid, p_decision text,
                                                      p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_req     public.refund_requests%rowtype;
  v_reason  text;
  v_plan_ar text;
begin
  if not public.owner_critical_ok() then
    raise exception 'قرار طلبات التعويض لمالك المنصة في سياقه وبتحقق حديث' using errcode = '42501';
  end if;
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    raise exception 'القرار موافقة أو رفض فقط' using errcode = '22023';
  end if;
  select * into v_req from public.refund_requests where id = p_request for update;
  if not found then
    raise exception 'طلب التعويض غير موجود' using errcode = 'P0002';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'القرار من طلب معلّق فقط' using errcode = '22023';
  end if;
  select coalesce(name_ar, name, v_req.plan) into v_plan_ar
    from public.subscription_plans where key = v_req.plan;

  if p_decision = 'rejected' then
    -- الرفض بسبب مسجَّل (10 أحرف على الأقل، على نمط منح المتاجر 133).
    -- والاشتراك يبقى ملغى في نهاية مدته كما طلبه صاحبه أصلًا: الرفض
    -- يرفض التعويض وحده، ولا يعيد الاشتراك — التراجع عنه من لوحة الشركة
    -- (resume_my_subscription، 136) إن أراد صاحبه.
    v_reason := public._store_reason(p_reason);
    update public.refund_requests
       set status = 'rejected', decided_at = now(), decided_by = auth.uid(),
           decision_reason = v_reason, updated_at = now()
     where id = p_request;
    perform public.log_privileged('refund.rejected', v_req.user_id,
      jsonb_build_object('request_id', p_request, 'company_id', v_req.company_id,
                         'refund_amount', v_req.refund_amount),
      jsonb_build_object('request_id', p_request, 'decision', 'rejected',
                         'reason', left(v_reason, 300)));
    insert into public.notifications (user_id, title, message, type, link, category, reference_id)
    values (v_req.user_id, 'رُفض طلب التعويض',
            format('راجع المالك طلب تعويض إلغاء %s (%s جنيه) ورفضه. السبب: %s. الاشتراك نفسه يبقى ملغى في نهاية مدته كما طلبت، ويمكنك التراجع عن الإلغاء من لوحة الشركة قبل انتهائها.',
                   coalesce(v_plan_ar, v_req.plan), v_req.refund_amount, v_reason),
            'warning', '/company-dashboard/index.html#subscriptions', 'refund', p_request);
    return public._refund_request_json(p_request, true);
  end if;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  update public.refund_requests
     set status = 'approved', decided_at = now(), decided_by = auth.uid(),
         decision_reason = v_reason, updated_at = now()
   where id = p_request;
  perform public.log_privileged('refund.approved', v_req.user_id,
    jsonb_build_object('request_id', p_request, 'company_id', v_req.company_id,
                       'refund_amount', v_req.refund_amount),
    jsonb_build_object('request_id', p_request, 'decision', 'approved',
                       'reason', left(coalesce(v_reason, ''), 300)));
  insert into public.notifications (user_id, title, message, type, link, category, reference_id)
  values (v_req.user_id, 'وافق المالك على طلب التعويض',
          format('وافق المالك على تعويض إلغاء %s بمبلغ %s جنيه. سيفتح تذكرة تعويض يطلب فيها بيانات التحويل — أرسلها من قسم التعويض في لوحة الشركة. لا صرف تلقائي: التحويل يتم بعد مراجعة بياناتك.',
                 coalesce(v_plan_ar, v_req.plan), v_req.refund_amount),
          'success', '/company-dashboard/index.html#subscriptions', 'refund', p_request);
  return public._refund_request_json(p_request, true);
end $$;
comment on function public.owner_decide_refund(uuid, text, text) is
  '142: قرار المالك على طلب تعويض: موافقة (تفتح باب التذكرة وبيانات التحويل، بلا دفع) أو رفض بسبب مسجَّل (يرفض التعويض وحده؛ الإلغاء في نهاية المدة يبقى كما طلبه صاحبه). بتحقق حديث ومدقَّقة.';

revoke all on function public.owner_decide_refund(uuid, text, text) from public, anon;
grant execute on function public.owner_decide_refund(uuid, text, text) to authenticated;


-- ============================================================================
-- 10) تذكرة التعويض — يفتحها المالك من حساب العميل بعد الموافقة
--     على الآلية القائمة (صف tickets مباشر): user_id = العميل،
--     category = 'subscription'، scope = 'mad3oom_support' بلا شركة كما
--     يفرض ختم النطاق (097)، وعلم الفوترة (069) حتى لا تُحسب من رصيد
--     تذاكر العميل عند الإنشاء. وصف التذكرة يطلب بيانات التحويل ويوجّه
--     العميل إلى قسم التعويض في لوحة الشركة — والبيانات نفسها تُرسل عبر
--     submit_refund_transfer_details فتُحفظ على الطلب لا في التذكرة.
-- ============================================================================
create or replace function public.owner_open_refund_ticket(p_request uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  v_req     public.refund_requests%rowtype;
  v_co      public.companies%rowtype;
  v_ticket  public.tickets%rowtype;
  v_title   text;
  v_desc    text;
  v_plan_ar text;
  v_kind_ar text;
begin
  if not public.owner_critical_ok() then
    raise exception 'فتح تذكرة التعويض لمالك المنصة في سياقه وبتحقق حديث' using errcode = '42501';
  end if;
  select * into v_req from public.refund_requests where id = p_request for update;
  if not found then
    raise exception 'طلب التعويض غير موجود' using errcode = 'P0002';
  end if;
  if v_req.status <> 'approved' then
    raise exception 'تذكرة التعويض تُفتح بعد موافقة المالك على الطلب فقط' using errcode = '22023';
  end if;
  if v_req.ticket_id is not null then
    raise exception 'لهذا الطلب تذكرة تعويض مفتوحة بالفعل' using errcode = '22023';
  end if;
  select * into v_co from public.companies where id = v_req.company_id;
  select coalesce(name_ar, name, v_req.plan) into v_plan_ar
    from public.subscription_plans where key = v_req.plan;
  v_kind_ar := case when v_req.refund_kind = 'full' then 'كامل' else 'تناسبي' end;

  v_title := 'طلب بيانات التحويل لتعويض إلغاء الاشتراك';
  v_desc := format(
    'وافق المالك على طلب تعويض إلغاء اشتراك %s لشركة «%s» بمبلغ %s جنيه (تعويض %s؛ %s %s متبقية من مدة %s %s، والمبلغ المدفوع %s جنيه).'
    || E'\n\nأرسل بيانات التحويل من قسم «طلبات التعويض» في لوحة الشركة: وسيلة التحويل (تحويل بنكي أو إنستاباي أو محفظة إلكترونية) + رقم/حساب التحويل.'
    || E'\n\nلا ترسل بيانات بطاقة ولا كلمة مرور — بيانات التحويل وحدها تكفي، وتُحفظ على طلب التعويض. بعد وصولها يراجع المالك الطلب ويسجّل الدفع؛ لا صرف تلقائي.',
    coalesce(v_plan_ar, v_req.plan), coalesce(v_co.company_name, 'بلا اسم'), v_req.refund_amount, v_kind_ar,
    v_req.remaining_days, case when v_req.remaining_days = 1 then 'يوم' else 'أيام' end,
    v_req.cycle_days, case when v_req.cycle_days = 1 then 'يوم' else 'أيام' end,
    v_req.amount_paid);

  -- علم الفوترة (069): التذكرة التي ينشئها النظام لا تُحسب من رصيد
  -- تذاكر العميل العشرين عند الإنشاء.
  perform set_config('mad3oom.billing_request_ticket', 'on', true);
  insert into public.tickets (user_id, title, description, status, priority, category, scope, company_id)
  values (v_req.user_id, v_title, v_desc, 'open', 'high', 'subscription', 'mad3oom_support', null)
  returning * into v_ticket;
  perform set_config('mad3oom.billing_request_ticket', 'off', true);

  update public.refund_requests
     set ticket_id = v_ticket.id, updated_at = now()
   where id = p_request;
  perform public.log_privileged('refund.ticket_opened', v_req.user_id,
    jsonb_build_object('request_id', p_request, 'company_id', v_req.company_id),
    jsonb_build_object('request_id', p_request, 'ticket_id', v_ticket.id,
                       'ticket_number', v_ticket.ticket_number));
  insert into public.notifications (user_id, title, message, type, link, category, reference_id)
  values (v_req.user_id, 'تذكرة تعويض: بيانات التحويل مطلوبة',
          format('فتح المالك تذكرة تعويض (#%s) لطلبك بمبلغ %s جنيه. أرسل وسيلة التحويل ورقم/حساب التحويل من قسم «طلبات التعويض» في لوحة الشركة.',
                 v_ticket.ticket_number, v_req.refund_amount),
          'info', '/company-dashboard/index.html#tickets', 'refund', p_request);

  return public._refund_request_json(p_request, true);
end;
$function$;

comment on function public.owner_open_refund_ticket(uuid) is
  '142: فتح تذكرة تعويض من حساب العميل بعد الموافقة (فئة subscription، نطاق mad3oom_support، معفاة من رصيد التذاكر بعلم الفوترة 069). التذكرة تطلب بيانات التحويل؛ والبيانات تُحفظ على الطلب لا فيها.';

revoke all on function public.owner_open_refund_ticket(uuid) from public, anon;
grant execute on function public.owner_open_refund_ticket(uuid) to authenticated;


-- ============================================================================
-- 11) تسجيل الدفع — المالك وحده، بعد وصول بيانات التحويل
--     تسجيل فقط: التحويل نفسه تمّ خارج النظام، ولا مال يتحرك في هذه الدالة.
--     رسوم التحويل الفعلية وحدها تُخصم (p_transfer_fee، 0 افتراضيًا،
--     ولا تتجاوز الإجمالي)؛ والصافي = الإجمالي − الرسوم (عمود مولَّد).
-- ============================================================================
create or replace function public.owner_mark_refund_paid(
  p_request uuid, p_note text, p_transfer_fee numeric default 0)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  v_req  public.refund_requests%rowtype;
  v_note text;
  v_fee  numeric(14,2);
begin
  if not public.owner_critical_ok() then
    raise exception 'تسجيل دفع التعويض لمالك المنصة في سياقه وبتحقق حديث' using errcode = '42501';
  end if;
  -- ملاحظة الدفع مسجَّلة (10 أحرف على الأقل، على نمط منح المتاجر 133):
  -- ما الذي حُوّل، وأين، ومتى — لأن الدفع نفسه خارج النظام.
  v_note := public._store_reason(p_note);
  select * into v_req from public.refund_requests where id = p_request for update;
  if not found then
    raise exception 'طلب التعويض غير موجود' using errcode = 'P0002';
  end if;
  if v_req.status <> 'approved' then
    raise exception 'تسجيل الدفع من طلب موافَق عليه فقط' using errcode = '22023';
  end if;
  if v_req.transfer_details_submitted_at is null then
    raise exception 'لا يُسجَّل الدفع قبل وصول بيانات التحويل من العميل' using errcode = '22023';
  end if;
  v_fee := coalesce(p_transfer_fee, 0);
  if v_fee < 0 or v_fee > v_req.refund_amount then
    raise exception 'رسوم التحويل غير صالحة: من 0 حتى مبلغ التعويض (%).' , v_req.refund_amount using errcode = '22023';
  end if;

  update public.refund_requests
     set status = 'paid', paid_at = now(), paid_by = auth.uid(),
         paid_note = v_note, transfer_fee = v_fee, updated_at = now()
   where id = p_request;
  perform public.log_privileged('refund.paid', v_req.user_id,
    jsonb_build_object('request_id', p_request, 'company_id', v_req.company_id,
                       'refund_amount', v_req.refund_amount,
                       'transfer_fee', v_fee, 'refund_net', v_req.refund_amount - v_fee,
                       'transfer_method', v_req.transfer_method),
    jsonb_build_object('request_id', p_request, 'decision', 'paid',
                       'note', left(v_note, 300)));
  insert into public.notifications (user_id, title, message, type, link, category, reference_id)
  values (v_req.user_id, 'تم تسجيل دفع التعويض',
          case when v_fee > 0 then
            format('سجّل المالك دفع تعويض إلغاء اشتراكك بمبلغ %s جنيه (الصافي %s جنيه بعد رسوم تحويل %s جنيه) على وسيلة التحويل التي أرسلتها. تحقق من وصول المبلغ إلى حسابك، وإن تأخر تواصل مع الدعم.',
                   v_req.refund_amount, v_req.refund_amount - v_fee, v_fee)
          else
            format('سجّل المالك دفع تعويض إلغاء اشتراكك بمبلغ %s جنيه على وسيلة التحويل التي أرسلتها. تحقق من وصول المبلغ إلى حسابك، وإن تأخر تواصل مع الدعم.',
                   v_req.refund_amount) end,
          'success', '/company-dashboard/index.html#subscriptions', 'refund', p_request);
  return public._refund_request_json(p_request, true);
end;
$function$;

comment on function public.owner_mark_refund_paid(uuid, text, numeric) is
  '142: تسجيل دفع التعويض بعد التحويل الفعلي خارج النظام — تسجيل فقط بملاحظة مسجَّلة ورسوم تحويل فعلية (0 افتراضيًا) تُخصم من الإجمالي؛ لا صرف مال ولا بوابة دفع في الدالة.';

revoke all on function public.owner_mark_refund_paid(uuid, text, numeric) from public, anon;
grant execute on function public.owner_mark_refund_paid(uuid, text, numeric) to authenticated;


-- ============================================================================
-- 12) التراجع عن الإلغاء — إعادة تعريف resume_my_subscription (136)
--     نص 136 حرفيًا (ملف 136 بلا مساس) + إضافتا 142:
--     (أ) إغلاق طلبات التعويض المفتوحة على الاشتراك نفسه (pending/
--     approved → closed مع سبب الإغلاق) — التراجع يلغي مبرر التعويض.
--     الطلب المدفوع يبقى paid: مال سُجّل دفعه لا يُسترجع بهذا المسار.
--     (ب) السنوي +14 يومًا هدية مرة واحدة لكل مدة: إن كانت الدورة سنوية
--     ولم تُمنح الهدية لهذه المدة بعد (العلامة
--     refund_gift_granted_for_start تخزّن بداية المدة التي مُنحت عنها)،
--     تُمدَّد end_date 14 يومًا وتُثبَّت العلامة على بداية المدة الحالية.
--     التراجع الثاني في المدة نفسها بلا هدية؛ والمدة الجديدة (صف تجديد)
--     لها هدية واحدة جديدة.
-- ============================================================================
create or replace function public.resume_my_subscription(p_subscription_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_sub public.whatsapp_subscriptions%rowtype;
  v_closed int := 0;
  v_gift   int := 0;
  v_end    timestamptz;
begin
  if v_uid is null then
    raise exception 'يجب تسجيل الدخول أولًا' using errcode = '42501';
  end if;

  select * into v_sub from public.whatsapp_subscriptions
   where id = p_subscription_id for update;

  if v_sub.id is null then
    raise exception 'الاشتراك غير موجود' using errcode = 'P0002';
  end if;

  if v_sub.user_id is distinct from v_uid
     and not exists (select 1 from public.companies c
                      where c.id = v_sub.company_id and c.user_id = v_uid) then
    raise exception 'هذا الاشتراك لا يخص حسابك' using errcode = '42501';
  end if;

  if not v_sub.cancel_at_period_end then
    raise exception 'هذا الاشتراك غير ملغى أصلًا' using errcode = '42501';
  end if;

  if v_sub.status <> 'active' or v_sub.end_date <= now() then
    raise exception 'انتهت مدة الاشتراك بالفعل فلا يمكن التراجع عن إلغائه.'
      using errcode = '42501';
  end if;

  update public.whatsapp_subscriptions
     set cancel_at_period_end = false,
         cancelled_at = null,
         cancel_reason = null,
         updated_at = now()
   where id = v_sub.id;

  -- 142 (أ): إغلاق طلبات التعويض المفتوحة على الاشتراك نفسه.
  update public.refund_requests
     set status = 'closed', closed_at = now(), closed_by = v_uid,
         close_reason = 'تراجع صاحب الاشتراك عن الإلغاء قبل نهاية المدة — أُغلق طلب التعويض تلقائيًا',
         updated_at = now()
   where subscription_id = v_sub.id and status in ('pending', 'approved');
  get diagnostics v_closed = row_count;

  -- 142 (ب): هدية الـ14 يومًا للسنوي — مرة واحدة لكل مدة.
  v_end := v_sub.end_date;
  if v_sub.billing_cycle = 'yearly'
     and v_sub.refund_gift_granted_for_start is distinct from v_sub.start_date then
    update public.whatsapp_subscriptions
       set end_date = v_sub.end_date + interval '14 days',
           refund_gift_granted_for_start = v_sub.start_date,
           updated_at = now()
     where id = v_sub.id;
    v_gift := 14;
    v_end := v_sub.end_date + interval '14 days';
  end if;

  insert into public.subscription_audit_log (
    subscription_id, target_user_id, actor_user_id, actor_email,
    action, old_values, new_values, reason
  ) values (
    v_sub.id, v_sub.user_id, v_uid,
    (select email from public.profiles where id = v_uid),
    'cancel_revoked',
    jsonb_build_object('cancel_at_period_end', true, 'status', 'active'),
    jsonb_build_object('cancel_at_period_end', false, 'status', 'active',
                       'end_date', v_end,
                       'gift_days_added', v_gift,
                       'refund_requests_closed', v_closed),
    'تراجع صاحب الاشتراك عن الإلغاء قبل نهاية المدة'
  );

  return jsonb_build_object(
    'subscription_id',      v_sub.id,
    'status',               'active',
    'end_date',             v_end,
    'cancel_at_period_end', false,
    'gift_days_added',      v_gift,
    'refund_requests_closed', v_closed
  );
end;
$function$;

comment on function public.resume_my_subscription(uuid) is
  'التراجع عن إلغاء نهاية المدة قبل انتهائها: يمسح العلَم والسبب. مالك الشركة أو صاحب الاشتراك وحدهما. (142: يغلق طلبات التعويض المفتوحة على الاشتراك، ويمدّد السنوي 14 يومًا هدية مرة واحدة لكل مدة.)';

revoke all on function public.resume_my_subscription(uuid) from public, anon;
grant execute on function public.resume_my_subscription(uuid) to authenticated;


-- ============================================================================
-- 13) تحقق ذاتي — على نمط 130/133/135/137
-- ============================================================================
do $$
declare
  v_def text;
  f text;
  v_rpc text[] := array[
    'public.refund_quote(uuid)',
    'public.request_cancel_refund(uuid,text)',
    'public.my_refund_requests()',
    'public.submit_refund_transfer_details(uuid,text,text)',
    'public.owner_list_refund_requests(text)',
    'public.owner_decide_refund(uuid,text,text)',
    'public.owner_open_refund_ticket(uuid)',
    'public.owner_mark_refund_paid(uuid,text,numeric)'];
begin
  -- العرض قراءة فقط: لا إلغاء ولا إنشاء طلب ولا دفع فيه.
  v_def := pg_get_functiondef('public.refund_quote(uuid)'::regprocedure);
  if v_def not like '%round(%' or v_def not like '%remaining_days%' then
    raise exception '142: معادلة التعويض التناسبي غائبة من refund_quote()';
  end if;
  if position('cancel_my_active_subscription' in v_def) > 0
     or position('insert into public.refund_requests' in v_def) > 0 then
    raise exception '142: العرض يلغي أو ينشئ طلبًا — يجب أن يبقى قراءة فقط';
  end if;
  -- العرض يرفض الباقات غير المدفوعة، ويحسب الكامل بشروطه الثلاثة.
  if v_def not like '%not_refundable_plan%' then
    raise exception '142: العرض لا يرفض الباقات غير القابلة للتعويض';
  end if;
  if v_def not like '%_refund_is_new_subscription%' or v_def not like '%_refund_ticket_usage%'
     or v_def not like '%_refund_sie_usage%' then
    raise exception '142: العرض بلا فحص اشتراك جديد أو استهلاك تذاكر أو ركيزة SIE';
  end if;
  -- الطلب يلغي في نهاية المدة عبر 136 ويُشعر المالك عبر سلطة المنصة.
  v_def := pg_get_functiondef('public.request_cancel_refund(uuid,text)'::regprocedure);
  if v_def not like '%cancel_my_active_subscription%' then
    raise exception '142: الطلب لا يلغي الاشتراك في نهاية مدته عبر 136';
  end if;
  if v_def not like '%_notify_platform_owners%' then
    raise exception '142: الطلب لا يُشعر المالك';
  end if;
  if v_def not like '%refund_quote%' then
    raise exception '142: الطلب لا يمر عبر العرض الواحد';
  end if;
  -- القرار والتذكرة والدفع بتحقق حديث ومدقَّقة.
  foreach f in array array[
    'public.owner_decide_refund(uuid,text,text)',
    'public.owner_open_refund_ticket(uuid)',
    'public.owner_mark_refund_paid(uuid,text,numeric)'] loop
    v_def := pg_get_functiondef(f::regprocedure);
    if v_def not like '%owner_critical_ok%' then
      raise exception '142: owner_critical_ok() غائب من %', f;
    end if;
    if v_def not like '%log_privileged%' then
      raise exception '142: log_privileged() غائب من %', f;
    end if;
  end loop;
  -- التذكرة على الآلية القائمة: نطاق مدعوم بلا شركة، وعلم الفوترة 069.
  v_def := pg_get_functiondef('public.owner_open_refund_ticket(uuid)'::regprocedure);
  if v_def not like '%mad3oom_support%' or v_def not like '%mad3oom.billing_request_ticket%' then
    raise exception '142: تذكرة التعويض بلا نطاق مدعوم أو بلا علم الفوترة';
  end if;
  if v_def not like '%''subscription''%' then
    raise exception '142: تذكرة التعويض بلا فئة subscription';
  end if;
  -- الدفع تسجيل فقط: بلا صرف ولا بوابة ولا تحويل مال في أي دالة.
  foreach f in array v_rpc loop
    v_def := pg_get_functiondef(f::regprocedure);
    if position('pg_net' in lower(v_def)) > 0 or position('http_post' in lower(v_def)) > 0
       or position('stripe' in lower(v_def)) > 0 or position('paymob' in lower(v_def)) > 0 then
      raise exception '142: مسار دفع خارجي في % — التعويض للمراجعة والتسجيل فقط', f;
    end if;
  end loop;
  -- الجدول: قيد المعادلة المشروط بالنوع، وفهرس الطلب المفتوح الواحد، و RLS، وبلا سياسة تعديل.
  if not exists (select 1 from pg_constraint where conname = 'refund_requests_formula_check') then
    raise exception '142: قيد معادلة التعويض غائب';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'refund_requests_plan_check') then
    raise exception '142: قيد الباقات المدفوعة غائب';
  end if;
  if not exists (select 1 from pg_indexes where indexname = 'refund_requests_one_open') then
    raise exception '142: فهرس الطلب المفتوح الواحد غائب';
  end if;
  if not (select relrowsecurity from pg_class where relname = 'refund_requests') then
    raise exception '142: RLS غير مفعّلة على refund_requests';
  end if;
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'refund_requests'
                and cmd in ('UPDATE', 'DELETE')) then
    raise exception '142: سياسة UPDATE/DELETE على refund_requests — التعديل عبر RPC فقط';
  end if;
  -- رقم الحساب لا يُكشف إلا لمالك الشركة صاحبة الطلب.
  v_def := pg_get_functiondef('public.my_refund_requests()'::regprocedure);
  if v_def not like '%_refund_request_json(r.id, v_co.user_id = auth.uid())%' then
    raise exception '142: حالة الشركة تكشف رقم التحويل لغير مالك الشركة';
  end if;
  -- التراجع (136 + 142): يغلق طلبات التعويض المفتوحة ويمدّد السنوي هدية.
  v_def := pg_get_functiondef('public.resume_my_subscription(uuid)'::regprocedure);
  if v_def not like '%refund_requests%' or v_def not like '%refund_gift_granted_for_start%' then
    raise exception '142: التراجع لا يغلق طلبات التعويض ولا يمنح هدية السنوي';
  end if;
  -- الصلاحيات كما أُعلنت: authenticated وحده، وبلا anon.
  foreach f in array v_rpc loop
    if has_function_privilege('anon', f::regprocedure, 'EXECUTE') then
      raise exception '142: دالة مكشوفة لـ anon: %', f;
    end if;
    if not has_function_privilege('authenticated', f::regprocedure, 'EXECUTE') then
      raise exception '142: دالة غير ممنوحة لـ authenticated: %', f;
    end if;
  end loop;
  raise notice '142: إلغاء أي اشتراك مدفوع مع تعويض (كامل أو تناسبي) جاهز — عرض ثم طلب (إلغاء نهاية مدة) ثم قرار مالك ثم تذكرة ثم بيانات تحويل ثم تسجيل دفع، بلا إلغاء فوري وبلا صرف تلقائي';
end $$;
