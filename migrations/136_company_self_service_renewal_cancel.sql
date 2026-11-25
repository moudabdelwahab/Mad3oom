-- ============================================================================
-- 136_company_self_service_renewal_cancel.sql
--   إدارة الاشتراك ذاتيًا من داخل لوحة الشركة: تجديد وترقية وتخفيض وإلغاء.
--
-- ما الذي كان موجودًا (مُثبَت بالفحص قبل كتابة أي سطر)
--   * التجديد: طلب عبر request_subscription_purchase(is_renewal=true) مع
--     تذكرته الذرّية submit_subscription_request (069)، لكن الواجهة الوحيدة
--     له كانت صفحة الاشتراكات الخارجية (/subscriptions.html) — لوحة الشركة
--     كانت تعرض رابطًا فقط.
--   * الترقية: عرض السعر subscription_upgrade_quote وطلبها
--     request_subscription_upgrade / submit_subscription_upgrade (019/069).
--   * التخفيض: لا مسار له إطلاقًا — subscription_upgrade_quote يرفض أي باقة
--     ليست أغلى (not_an_upgrade)، ولا دالة تخفيض في القاعدة.
--   * الإلغاء: cancel_my_subscription_request (023) يحذف طلبًا pending فقط —
--     لا يلغي اشتراكًا فعّالًا، ولا يوجد أي مسار إلغاء للاشتراك الفعّال.
--   * الفوترة: المحاسبة والفواتير في مشروع Supabase منفصل مربوط بجسر
--     (accounting-sync + record_accounting_invoice، 005/051). لا يُبنى هنا
--     نظام فوترة محلي ولا جدول فواتير جديد — هذا الترحيل لا يمسّ الفواتير.
--   * حمولة اللوحة get_my_company_dashboard: آخر تعريف لها في 108 (لا 021):
--     فحص الفريق company_staff_role (095) + حقل viewer_role + منطق الإيقاف
--     (108). أي نسخة مبنية على 021 ترجعها — فيرى غير الفريق الحمولة كاملة
--     وتضيع حالة الإيقاف. فالبند 7 نسخة 108 حرفيًا + حقل الإلغاء فقط.
--
-- ما الذي يضيفه هذا الترحيل
--   1) إلغاء في نهاية المدة: علما cancel_at_period_end / cancelled_at /
--      cancel_reason على whatsapp_subscriptions + دالتا
--      cancel_my_active_subscription / resume_my_subscription (مالك الشركة
--      أو صاحب الاشتراك وحدهما). الخدمة تبقى حتى end_date، والوظيفة الدورية
--      expire_stale_subscriptions تقلب الحالة إلى expired كالمعتاد — مع
--      رسالة إشعار مختلفة للملغى بطلب صاحبه. ويرفض الإلغاء ما دام طلب
--      (تجديد/ترقية/تخفيض) معلّقًا على الاشتراك نفسه — تأكيده لاحقًا كان
--      سيبطل الإلغاء، فألغِ الطلب أولًا.
--   2) تخفيض بسعر نهاية المدة: subscription_downgrade_quote (مرآة عرض
--      الترقية للباقات الأرخص، ساري من end_date الحالي) +
--      request_subscription_downgrade + submit_subscription_downgrade
--      (تذكرته الذرّية، مثل submit_subscription_request). الصف pending
--      وis_renewal=true فيبدأ عند التأكيد من previous_end_date — وهو نفس
--      ما يفعله مسار تأكيد الأدمن العام (confirmPurchaseTicket) للتجديد،
--      فلا مسار تأكيد جديد ولا كود أدمن جديد.
--   3) منع التعارض بين الطلبات المعلّقة في حارس الإنشاء الواحد
--      enforce_subscription_purchase_rules (023): طلب تخفيض معلّق يمنع
--      تجديدًا أو ترقية من نفس المصدر، والعكس — وإلا صار اشتراكان فعّالان
--      مستقبليان بخطتين مختلفتين فيمنحان اتحاد الامتيازين معًا.
--   4) حمولة اللوحة get_my_company_dashboard (108) ترجع cancel_at_period_end
--      مع كل اشتراك، فتعرض الواجهة «سيُلغى عند الانتهاء» بدل تخمينها.
--
-- ما الذي لم يتغيّر عمدًا
--   * لا بوابة دفع جديدة ولا سعر جديد: التجديد والترقية والتخفيض تمرّ على
--     مسارات الدفع اليدوي القائمة (تذكرة + إثبات تحويل + مراجعة أدمن).
--   * request_subscription_purchase و request_subscription_upgrade كما هما
--     حرفيًا — الحارس هو نقطة المنع الواحدة، لا نسخ معدّلة منهما.
--   * الإلغاء لا يحذف صفًا ولا يغيّر status ولا يمسّ الامتيازات قبل الانتهاء.
--   * لا SIE إطلاقًا.
-- ============================================================================

-- ── 1) أعمدة الإلغاء في نهاية المدة والتخفيض ─────────────────────────────────
alter table public.whatsapp_subscriptions
  add column if not exists cancel_at_period_end boolean not null default false,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancel_reason text,
  add column if not exists downgraded_from_subscription_id uuid
      references public.whatsapp_subscriptions(id) on delete set null;

comment on column public.whatsapp_subscriptions.cancel_at_period_end is
  'ألغى صاحبه الاشتراك في نهاية مدته: الخدمة تبقى حتى end_date ثم تنتهي كالمعتاد. لا يغيّر status ولا الامتيازات قبل ذلك.';
comment on column public.whatsapp_subscriptions.cancel_reason is
  'سبب الإلغاء كما كتبه صاحبه (اختياري، 500 حرف كحد أقصى).';
comment on column public.whatsapp_subscriptions.downgraded_from_subscription_id is
  'الاشتراك الذي تم التخفيض منه. يربط الطرفين ويمنع تخفيض نفس المصدر مرتين — مرآة upgraded_from_subscription_id (019).';

-- لا يمكن أن يوجد أكثر من طلب تخفيض واحد من نفس المصدر (مرآة فهرس الترقية)
create unique index if not exists whatsapp_subscriptions_one_downgrade_per_source
  on public.whatsapp_subscriptions(downgraded_from_subscription_id)
  where downgraded_from_subscription_id is not null
    and status in ('pending', 'active');


-- ── 2) عرض التخفيض ──────────────────────────────────────────────────────────
-- مرآة subscription_upgrade_quote (019) للاتجاه المعاكس: الباقة الجديدة
-- أرخص، فلا مبلغ يُدفع الآن، ويسري التخفيض من نهاية الدورة الحالية
-- (effective_date = end_date الحالي) ويدفع العميل عند التجديد التالي السعر
-- الكامل للباقة الجديدة. نفس الأرقام تُخزَّن في price_snapshot عند الطلب.
create or replace function public.subscription_downgrade_quote(p_plan text)
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
  v_removed    text[];
  v_old_price  numeric;
  v_new_price  numeric;
  v_remaining  int;
  v_cycle      int;
  v_currency   text;
begin
  if v_uid is null then
    return jsonb_build_object('eligible', false, 'code', 'not_authenticated');
  end if;

  if not exists (select 1 from public.subscription_plans where key = p_plan and is_active) then
    return jsonb_build_object('eligible', false, 'code', 'unknown_plan');
  end if;

  -- الاشتراك الجاري فعلًا الآن (لا تجديد مستقبلي ولا منتهٍ) — نفس اختيار
  -- عرض الترقية حرفيًا.
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

  v_old_price := public.plan_price(v_cur.plan, v_cur.billing_cycle);
  v_new_price := public.plan_price(p_plan,     v_cur.billing_cycle);

  if v_old_price is null or v_new_price is null then
    return jsonb_build_object('eligible', false, 'code', 'price_missing');
  end if;

  -- تخفيض = الباقة الجديدة أرخص في دورة الفوترة نفسها. غير ذلك ترقية أو
  -- سعر مماثل، ولكلٍّ مساره.
  if v_new_price >= v_old_price then
    return jsonb_build_object('eligible', false, 'code', 'not_a_downgrade');
  end if;

  v_owned   := public.owned_feature_keys(v_uid);
  v_offered := public.plan_feature_keys(p_plan);
  select coalesce(array_agg(f), '{}'::text[]) into v_removed
    from unnest(v_owned) f where not (f = any(v_offered));

  v_remaining := greatest(0, ceil (extract(epoch from (v_cur.end_date - now()))            / 86400))::int;
  v_cycle     := greatest(1, round(extract(epoch from (v_cur.end_date - v_cur.start_date)) / 86400))::int;

  select currency into v_currency from public.subscription_plans where key = p_plan;

  return jsonb_build_object(
    'eligible', true,
    'code', 'downgrade',
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
    'amount_due',          0,
    'effective_date',      v_cur.end_date,
    'next_renewal_price',  v_new_price,
    'removed_features',    to_jsonb(v_removed)
  );
end;
$function$;

comment on function public.subscription_downgrade_quote(text) is
  'عرض تخفيض كامل للعميل: الباقتان والدورة والأيام المتبقية وتاريخ السريان (نهاية الدورة الحالية) وسعر التجديد القادم. لا مبلغ يُدفع الآن.';

revoke all on function public.subscription_downgrade_quote(text) from public, anon;
grant execute on function public.subscription_downgrade_quote(text) to authenticated;


-- ── 3) إنشاء طلب التخفيض ────────────────────────────────────────────────────
-- الصف pending فقط: لا امتياز يتغيّر قبل تأكيد الدفع. يبدأ من نهاية الدورة
-- الحالية (start_date = end_date المصدر) وis_renewal=true فيحسب مسار تأكيد
-- الأدمن العام تواريخه من previous_end_date — فالتخفيض يسري عند الانتهاء
-- لا قبله، ولو تأكّد بعد الانتهاء بدأ من لحظة التأكيد كأي تجديد.
create or replace function public.request_subscription_downgrade(
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
  v_days   int;
  v_new    public.whatsapp_subscriptions%rowtype;
  v_cur    public.whatsapp_subscriptions%rowtype;
begin
  if v_uid is null then
    raise exception 'يجب تسجيل الدخول أولًا' using errcode = '42501';
  end if;

  if p_payment_method is not null
     and p_payment_method not in ('bank_transfer', 'cash_wallet', 'instapay', 'gateway') then
    raise exception 'وسيلة دفع غير صالحة' using errcode = '22023';
  end if;

  -- التذكرة لا تُقبل إلا إذا كانت تخص المنادي وهي تذكرة لفريق مدعوم
  -- (111: نفس فحص request_subscription_purchase/upgrade — وإلا علّق عميلٌ
  -- طلبه على تذكرة شركة أو تذكرة دعم عادية).
  if p_ticket_id is not null and not exists (
       select 1 from public.tickets where id = p_ticket_id and user_id = v_uid and scope = 'mad3oom_support') then
    raise exception 'التذكرة غير موجودة أو لا تخص حسابك' using errcode = '42501';
  end if;

  v_quote := public.subscription_downgrade_quote(p_plan);

  if (v_quote->>'eligible')::boolean is not true then
    raise exception 'لا يمكن تخفيض اشتراكك إلى هذه الباقة (%).', coalesce(v_quote->>'code', 'unknown');
  end if;

  v_cur_id := (v_quote->'current'->>'subscription_id')::uuid;

  -- قفل الاشتراك المصدر: يمنع سباق طلبين متزامنين على نفس الاشتراك
  select * into v_cur from public.whatsapp_subscriptions
   where id = v_cur_id for update;

  if v_cur.status <> 'active' or v_cur.end_date <= now() then
    raise exception 'الاشتراك الحالي لم يعد صالحًا للتخفيض';
  end if;

  -- طلب معلّق لنفس الباقة المستهدفة: رسالة عربية قبل خطأ قاعدة البيانات.
  if exists (
       select 1 from public.whatsapp_subscriptions
        where user_id = v_uid and plan = p_plan and status = 'pending') then
    raise exception 'لديك بالفعل طلب في هذه الباقة قيد المراجعة. انتظر رد فريق الدعم قبل إرسال طلب جديد.'
      using errcode = '42501';
  end if;

  -- طلب معلّق من نفس المصدر (ترقية أو تخفيض أو تجديد): التعارض يُمنع هنا
  -- برسالة واضحة، والحارس (البند 6) خط دفاع ثانٍ.
  if exists (
       select 1 from public.whatsapp_subscriptions
        where user_id = v_uid and status = 'pending'
          and (upgraded_from_subscription_id = v_cur.id
               or downgraded_from_subscription_id = v_cur.id
               or (is_renewal and plan = v_cur.plan))) then
    raise exception 'لديك بالفعل طلب قيد المراجعة على هذا الاشتراك. ألغِه أولًا قبل إرسال طلب تخفيض جديد.'
      using errcode = '42501';
  end if;

  v_days := case when v_cur.billing_cycle = 'yearly' then 365 else 30 end;

  insert into public.whatsapp_subscriptions (
    user_id, ticket_id, plan, status, billing_cycle,
    start_date, end_date, duration_days, previous_end_date, is_renewal,
    payment_method, payment_reference,
    downgraded_from_subscription_id, price_snapshot, company_id
  ) values (
    v_uid, p_ticket_id, p_plan, 'pending', v_cur.billing_cycle,
    v_cur.end_date, v_cur.end_date + make_interval(days => v_days), v_days,
    v_cur.end_date, true,
    nullif(btrim(coalesce(p_payment_method, '')), ''),
    nullif(btrim(coalesce(p_payment_reference, '')), ''),
    v_cur.id,
    jsonb_build_object(
      'quoted_at',          now(),
      'from_plan',          v_quote->'current'->>'plan',
      'from_price',         (v_quote->'current'->>'price')::numeric,
      'to_plan',            p_plan,
      'to_price',           (v_quote->'target'->>'price')::numeric,
      'billing_cycle',      v_cur.billing_cycle,
      'remaining_days',     (v_quote->>'remaining_days')::int,
      'cycle_days',         (v_quote->>'cycle_days')::int,
      'price_difference',   (v_quote->>'price_difference')::numeric,
      'amount_due',         0,
      'effective_date',     v_cur.end_date,
      'next_renewal_price', (v_quote->>'next_renewal_price')::numeric,
      'currency',           v_quote->>'currency'
    ),
    v_cur.company_id
  )
  returning * into v_new;

  return jsonb_build_object(
    'subscription_id', v_new.id,
    'effective_date',  v_new.start_date,
    'currency',        v_quote->>'currency',
    'quote',           v_quote
  );
end;
$function$;

comment on function public.request_subscription_downgrade(text, uuid, text, text) is
  'ينشئ طلب تخفيض pending يبدأ من نهاية الدورة الحالية (لا مبلغ الآن). لا يغيّر أي صلاحية قبل تأكيد الدفع.';

revoke all on function public.request_subscription_downgrade(text, uuid, text, text) from public, anon;
grant execute on function public.request_subscription_downgrade(text, uuid, text, text) to authenticated;


-- ── 4) طلب التخفيض بتذكرته (ذرّي، مرآة submit_subscription_request 069) ────
create or replace function public.submit_subscription_downgrade(
  p_plan               text,
  p_ticket_title       text,
  p_ticket_description text,
  p_payment_method     text default null,
  p_payment_reference  text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  v_ticket public.tickets%rowtype;
  v_result jsonb;
begin
  v_ticket := public._open_billing_request_ticket(p_ticket_title, p_ticket_description, p_payment_method);

  v_result := public.request_subscription_downgrade(
    p_plan, v_ticket.id, p_payment_method, p_payment_reference);

  return v_result || jsonb_build_object('ticket', to_jsonb(v_ticket));
end;
$function$;

comment on function public.submit_subscription_downgrade(text, text, text, text, text) is
  'طلب تخفيض بتذكرته في معاملة واحدة. تذكرته وحدها معفاة من رصيد التذاكر (069).';

revoke all on function public.submit_subscription_downgrade(text, text, text, text, text) from public, anon;
grant execute on function public.submit_subscription_downgrade(text, text, text, text, text) to authenticated;


-- ── 5) إلغاء اشتراك فعّال في نهاية المدة (+ التراجع عنه) ────────────────────
-- لا حذف ولا تغيير حالة: علَم فقط، والخدمة تبقى حتى end_date. التدقيق في
-- subscription_audit_log (018) والرسائل كلها بالعربي. المالك هنا هو مالك
-- الشركة (companies.user_id) أو صاحب الاشتراك الفردي نفسه — عضو الشركة
-- غير المالك لا يلغي ولا يتراجع.
create or replace function public.cancel_my_active_subscription(
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
  v_uid    uuid := auth.uid();
  v_sub    public.whatsapp_subscriptions%rowtype;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 500);
begin
  if v_uid is null then
    raise exception 'يجب تسجيل الدخول أولًا' using errcode = '42501';
  end if;

  select * into v_sub from public.whatsapp_subscriptions
   where id = p_subscription_id for update;

  if v_sub.id is null then
    raise exception 'الاشتراك غير موجود' using errcode = 'P0002';
  end if;

  -- الملكية: صاحب الاشتراك نفسه، أو مالك الشركة التي يتبعها الاشتراك.
  if v_sub.user_id is distinct from v_uid
     and not exists (select 1 from public.companies c
                      where c.id = v_sub.company_id and c.user_id = v_uid) then
    raise exception 'هذا الاشتراك لا يخص حسابك' using errcode = '42501';
  end if;

  if v_sub.status <> 'active' or v_sub.end_date <= now() then
    raise exception 'لا يمكن إلغاء اشتراك غير فعّال. الاشتراكات المنتهية أو قيد المراجعة لها مسارها الخاص.'
      using errcode = '42501';
  end if;

  -- إعادة الإلغاء: لا تدقيق مكرر ولا تغيير — نفس النتيجة السابقة.
  if v_sub.cancel_at_period_end then
    return jsonb_build_object(
      'subscription_id',      v_sub.id,
      'status',               'already_cancelled',
      'end_date',             v_sub.end_date,
      'cancel_at_period_end', true
    );
  end if;

  -- طلب معلّق على هذا الاشتراك (تجديد/ترقية/تخفيض): تأكيده لاحقًا سيمدّد
  -- الاشتراك أو يغيّر باقته فيبطل الإلغاء — فألغِ الطلب أولًا ثم ألغِ.
  if exists (
       select 1 from public.whatsapp_subscriptions s
        where s.user_id = v_sub.user_id and s.status = 'pending'
          and (s.upgraded_from_subscription_id = v_sub.id
               or s.downgraded_from_subscription_id = v_sub.id
               or (s.is_renewal and s.plan = v_sub.plan))) then
    raise exception 'لديك طلب قيد المراجعة على هذا الاشتراك. ألغِه أولًا قبل إلغاء الاشتراك.'
      using errcode = '42501';
  end if;

  update public.whatsapp_subscriptions
     set cancel_at_period_end = true,
         cancelled_at = now(),
         cancel_reason = v_reason,
         updated_at = now()
   where id = v_sub.id;

  insert into public.subscription_audit_log (
    subscription_id, target_user_id, actor_user_id, actor_email,
    action, old_values, new_values, reason
  ) values (
    v_sub.id, v_sub.user_id, v_uid,
    (select email from public.profiles where id = v_uid),
    'cancel_at_period_end',
    jsonb_build_object('cancel_at_period_end', false, 'status', 'active'),
    jsonb_build_object('cancel_at_period_end', true, 'status', 'active',
                       'end_date', v_sub.end_date),
    coalesce(v_reason, 'إلغاء في نهاية المدة بطلب صاحب الاشتراك')
  );

  return jsonb_build_object(
    'subscription_id',      v_sub.id,
    'status',               'cancel_at_period_end',
    'end_date',             v_sub.end_date,
    'cancel_at_period_end', true
  );
end;
$function$;

comment on function public.cancel_my_active_subscription(uuid, text) is
  'إلغاء اشتراك فعّال في نهاية مدته: الخدمة تبقى حتى end_date، والتدقيق في سجل الاشتراكات. مالك الشركة أو صاحب الاشتراك وحدهما.';

revoke all on function public.cancel_my_active_subscription(uuid, text) from public, anon;
grant execute on function public.cancel_my_active_subscription(uuid, text) to authenticated;


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

  insert into public.subscription_audit_log (
    subscription_id, target_user_id, actor_user_id, actor_email,
    action, old_values, new_values, reason
  ) values (
    v_sub.id, v_sub.user_id, v_uid,
    (select email from public.profiles where id = v_uid),
    'cancel_revoked',
    jsonb_build_object('cancel_at_period_end', true, 'status', 'active'),
    jsonb_build_object('cancel_at_period_end', false, 'status', 'active',
                       'end_date', v_sub.end_date),
    'تراجع صاحب الاشتراك عن الإلغاء قبل نهاية المدة'
  );

  return jsonb_build_object(
    'subscription_id',      v_sub.id,
    'status',               'active',
    'end_date',             v_sub.end_date,
    'cancel_at_period_end', false
  );
end;
$function$;

comment on function public.resume_my_subscription(uuid) is
  'التراجع عن إلغاء نهاية المدة قبل انتهائها: يمسح العلَم والسبب. مالك الشركة أو صاحب الاشتراك وحدهما.';

revoke all on function public.resume_my_subscription(uuid) from public, anon;
grant execute on function public.resume_my_subscription(uuid) to authenticated;


-- ── 6) حارس الإنشاء: إعفاء التخفيض من فحص الشراء + منع تعارض المعلّقة ───────
-- النسخة القائمة (023) ترفض أي صف pending يفشل subscription_purchase_check.
-- صف التخفيض يفشل ذلك الفحص حتمًا (باقته لا تضيف امتيازًا) — فهو مستثنى
-- هنا، لكن بفحص تعارضه هو بدلًا منه. وطلب معلّق واحد لكل مصدر هو القاعدة:
-- تجديد/ترقية/تخفيض من نفس الاشتراك لا يجتمع اثنان منها معلّقين، وإلا
-- صار اشتراكان فعّالان مستقبليان بخطتين مختلفتين. الكتابة المباشرة مغلقة
-- أصلًا أمام المستخدمين (023)، فالحارس خط دفاع ثانٍ خلف دوال الطلب.
create or replace function public.enforce_subscription_purchase_rules()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_check jsonb;
  v_src_id uuid;
begin
  -- مفتاح الخدمة والوظائف الخلفية: لا مستخدم في السياق، فلا شيء نحميه منه.
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;

  -- خط الدفاع من 023: مستخدم عادي لا ينشئ صفًّا فعّالًا مهما كان مصدر النداء.
  if new.status is distinct from 'pending' then
    raise exception 'لا يمكن إنشاء اشتراك بهذه الحالة. الطلبات تبدأ قيد المراجعة ويعتمدها فريق الدعم.'
      using errcode = '42501';
  end if;

  -- (أ) صف تخفيض: فحص الشراء لا ينطبق عليه (باقته أرخص فلا تضيف امتيازًا).
  -- يُستبدل بفحص التعارض: لا ترقية ولا تجديد ولا تخفيض آخر معلّق من المصدر.
  if new.downgraded_from_subscription_id is not null then
    if not exists (
         select 1 from public.whatsapp_subscriptions s
          where s.id = new.downgraded_from_subscription_id
            and s.user_id = new.user_id) then
      raise exception 'طلب التخفيض لا يشير إلى اشتراك يخص حسابك' using errcode = '42501';
    end if;
    if exists (
         select 1 from public.whatsapp_subscriptions s
          where s.user_id = new.user_id and s.status = 'pending'
            and (s.upgraded_from_subscription_id = new.downgraded_from_subscription_id
                 or s.downgraded_from_subscription_id = new.downgraded_from_subscription_id
                 or (s.is_renewal and s.plan = (select plan from public.whatsapp_subscriptions
                                                  where id = new.downgraded_from_subscription_id)))) then
      raise exception 'لديك بالفعل طلب قيد المراجعة على هذا الاشتراك. ألغِه أولًا قبل إرسال طلب جديد.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- (ب) صف ترقية: لا تخفيض ولا تجديد ولا ترقية أخرى معلّقة من المصدر نفسه.
  -- (كان يفحص التخفيض وحده، فمرّت ترقيةٌ مع تجديد معلّق، وترقيةٌ ثانية،
  -- من المصدر نفسه — ومسارا الطلب لا يسدّانها: 019 بلا فحص معلّق أصلًا،
  -- و 023 يفحص الباقة نفسها فقط.)
  if new.upgraded_from_subscription_id is not null then
    if exists (
         select 1 from public.whatsapp_subscriptions s
          where s.user_id = new.user_id and s.status = 'pending'
            and s.downgraded_from_subscription_id = new.upgraded_from_subscription_id) then
      raise exception 'لديك طلب تخفيض قيد المراجعة على هذا الاشتراك. ألغِه أولًا قبل إرسال طلب ترقية.'
        using errcode = '42501';
    end if;
    if exists (
         select 1 from public.whatsapp_subscriptions s
          where s.user_id = new.user_id and s.status = 'pending'
            and (s.upgraded_from_subscription_id = new.upgraded_from_subscription_id
                 or (s.is_renewal and s.plan = (select plan from public.whatsapp_subscriptions
                                                  where id = new.upgraded_from_subscription_id)))) then
      raise exception 'لديك بالفعل طلب قيد المراجعة على هذا الاشتراك. ألغِه أولًا قبل إرسال طلب ترقية.'
        using errcode = '42501';
    end if;
  end if;

  -- (ج) صف تجديد: لا تخفيض ولا ترقية ولا تجديد آخر معلّق من المصدر نفسه.
  -- (كان يفحص التخفيض وحده، فمرّ تجديدٌ ثانٍ وترقيةٌ معلّقة من المصدر نفسه.)
  if coalesce(new.is_renewal, false) and new.upgraded_from_subscription_id is null then
    select s.id into v_src_id
      from public.whatsapp_subscriptions s
     where s.user_id = new.user_id and s.plan = new.plan
       and s.status = 'active' and s.end_date > now()
     order by s.end_date desc
     limit 1;
    if v_src_id is not null and exists (
         select 1 from public.whatsapp_subscriptions s
          where s.user_id = new.user_id and s.status = 'pending'
            and s.downgraded_from_subscription_id = v_src_id) then
      raise exception 'لديك طلب تخفيض قيد المراجعة على هذا الاشتراك. ألغِه أولًا قبل إرسال طلب تجديد.'
        using errcode = '42501';
    end if;
    if v_src_id is not null and exists (
         select 1 from public.whatsapp_subscriptions s
          where s.user_id = new.user_id and s.status = 'pending'
            and (s.upgraded_from_subscription_id = v_src_id
                 or (s.is_renewal and s.plan = new.plan))) then
      raise exception 'لديك بالفعل طلب قيد المراجعة على هذا الاشتراك. ألغِه أولًا قبل إرسال طلب تجديد.'
        using errcode = '42501';
    end if;
  end if;

  v_check := public.subscription_purchase_check(new.plan, new.is_renewal, new.user_id);
  if not (v_check->>'allowed')::boolean then
    raise exception '%', v_check->>'reason' using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_subscription_purchase_rules() from public, anon, authenticated;


-- ── 7) حمولة اللوحة: علَم الإلغاء مع كل اشتراك ───────────────────────────────
-- نسخة 108 حرفيًا (آخر تعريف: فحص الفريق 095 + حقل viewer_role + منطق
-- الإيقاف) + حقل cancel_at_period_end في صفوف الاشتراكات التي يراها الأدمن
-- فقط. أي نسخة مبنية على 021 تُرجع 095/108 — فلا تُبنى هنا نسخة مختصرة.
create or replace function public.get_my_company_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company_id uuid; v_company public.companies%rowtype;
  v_active_plans text[]; v_subs jsonb; v_features jsonb;
  v_viewer text;
  v_suspended boolean;
begin
  if auth.uid() is null then return null; end if;
  -- 095: الفريق فقط. company_staff_role() = admin | supervisor | agent | null.
  v_viewer := public.company_staff_role();
  if v_viewer is null then return null; end if;
  v_company_id := public.current_company_id();
  if v_company_id is null then return null; end if;
  select * into v_company from public.companies where id = v_company_id;

  select coalesce(array_agg(distinct s.plan), '{}'::text[]) into v_active_plans
    from public.whatsapp_subscriptions s
   where (s.company_id = v_company_id or s.user_id = v_company.user_id)
     and s.status = 'active' and s.start_date <= now() and s.end_date > now();

  select coalesce(jsonb_agg(jsonb_build_object(
      'feature_key', f.feature_key,
      'name_ar', coalesce(ff.name_ar, ff.name, f.feature_key),
      'description', coalesce(ff.description, ''),
      'limits', f.limits, 'granted_by', f.plan_keys
    ) order by f.feature_key), '[]'::jsonb) into v_features
    from (
      select pf.feature_key, jsonb_agg(distinct sp.key) as plan_keys, (array_agg(pf.limits))[1] as limits
        from public.subscription_plans sp
        join public.plan_features pf on pf.plan_id = sp.id and pf.enabled = true
       where sp.key = any(v_active_plans) group by pf.feature_key
    ) f
    left join public.feature_flags ff on ff.key = f.feature_key;

  -- 108: نفس تعريف company_has_feature (021: لا تعريفان للاستحقاق في النظام). مع company_suspension_enforced
  -- لا تعرض لوحة شركة موقوفة امتيازات ترفضها دوال الامتيازات نفسها.
  v_suspended := public._feature_on('company_suspension_enforced') and v_company.status = 'suspended';
  if v_suspended then
    v_features := '[]'::jsonb;
  end if;

  if v_viewer <> 'admin' then
    return jsonb_build_object(
      'viewer_role', v_viewer,
      'company', jsonb_build_object('id', v_company.id, 'name', v_company.company_name, 'is_owner', false),
      'registration', null,
      'subscriptions', '[]'::jsonb,
      'entitlements', (select coalesce(jsonb_agg(e - 'granted_by' - 'limits'), '[]'::jsonb)
                         from jsonb_array_elements(v_features) e),
      'access', jsonb_build_object('active_plans', '[]'::jsonb,
        'has_active_subscription', (array_length(v_active_plans, 1) is not null), 'suspended', v_suspended));
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id, 'plan', s.plan,
      'plan_name_ar', coalesce(sp.name_ar, sp.name, s.plan),
      'status', s.status, 'billing_cycle', s.billing_cycle,
      'start_date', s.start_date, 'end_date', s.end_date,
      'is_active', (s.status = 'active' and s.start_date <= now() and s.end_date > now()),
      'days_remaining', greatest(0, ceil(extract(epoch from (s.end_date - now())) / 86400))::int,
      'cancel_at_period_end', coalesce(s.cancel_at_period_end, false)
    ) order by s.end_date desc), '[]'::jsonb) into v_subs
    from public.whatsapp_subscriptions s
    left join public.subscription_plans sp on sp.key = s.plan
   where (s.company_id = v_company_id or s.user_id = v_company.user_id);

  return jsonb_build_object(
    'viewer_role', v_viewer,
    'company', jsonb_build_object(
      'id', v_company.id, 'name', v_company.company_name,
      'cr_number', v_company.commercial_registration_number,
      'cr_expiry', v_company.commercial_registration_expiry,
      'email', v_company.company_email, 'phone', v_company.company_phone,
      'address', v_company.address, 'city', v_company.city, 'country', v_company.country,
      'website', v_company.website, 'industry', v_company.industry, 'tax_id', v_company.tax_id,
      'created_at', v_company.created_at, 'is_owner', (v_company.user_id = auth.uid())),
    'registration', jsonb_build_object(
      'expiry_date', v_company.commercial_registration_expiry,
      'is_expired', (v_company.commercial_registration_expiry is not null
                      and v_company.commercial_registration_expiry < current_date),
      'days_to_expiry', case when v_company.commercial_registration_expiry is null then null
                             else (v_company.commercial_registration_expiry - current_date) end),
    'subscriptions', v_subs, 'entitlements', v_features,
    'access', jsonb_build_object('active_plans', to_jsonb(v_active_plans),
      'has_active_subscription', (array_length(v_active_plans, 1) is not null), 'suspended', v_suspended));
end;
$$;

revoke all on function public.get_my_company_dashboard() from public, anon;
grant execute on function public.get_my_company_dashboard() to authenticated;


-- ── 8) الوظيفة الدورية: إشعار مختلف للملغى بطلب صاحبه ───────────────────────
-- نسخة 035 حرفيًا + رسالة الإلغاء: من ألغى اشتراكه بنفسه لا يُقال له
-- «انتهت صلاحية اشتراكك» بصيغة المفاجأة، بل يُذكَّر بأنه انتهى في الموعد
-- الذي حدده هو.
create or replace function public.expire_stale_subscriptions()
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare expired_row record;
begin
  for expired_row in
    select id, user_id, plan, cancel_at_period_end
      from public.whatsapp_subscriptions
     where status = 'active' and end_date < now()
  loop
    update public.whatsapp_subscriptions
       set status = 'expired', updated_at = now()
     where id = expired_row.id;

    insert into public.notifications (user_id, title, message, type, link)
    values (expired_row.user_id, 'انتهى اشتراكك',
            case when coalesce(expired_row.cancel_at_period_end, false)
                 then 'انتهى اشتراكك في الموعد الذي حددته عند إلغائه. يمكنك الاشتراك مجددًا من صفحة الاشتراكات.'
                 else 'انتهت صلاحية اشتراكك. يمكنك التجديد من صفحة الاشتراكات.'
            end,
            'warning', '/customer-subscriptions.html');
  end loop;

  -- الخدمات تُسحب، والرتبة لا تُمسّ.
  update public.profiles p
     set whatsapp_enabled = false
   where p.whatsapp_enabled = true
     and not exists (
       select 1 from public.whatsapp_subscriptions s
        where s.user_id = p.id
          and s.status = 'active'
          and s.plan in ('whatsapp', 'bundle')
          and s.start_date <= now()
          and s.end_date   >  now());
end;
$$;

revoke all on function public.expire_stale_subscriptions() from public, anon, authenticated;


-- ── 9) تحقّق بَعدي ───────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'whatsapp_subscriptions'
                    and column_name = 'cancel_at_period_end') then
    raise exception '136: عمود cancel_at_period_end غير موجود';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'whatsapp_subscriptions'
                    and column_name = 'downgraded_from_subscription_id') then
    raise exception '136: عمود downgraded_from_subscription_id غير موجود';
  end if;
  if has_function_privilege('anon', 'public.cancel_my_active_subscription(uuid, text)', 'execute') then
    raise exception '136: إلغاء الاشتراك الفعّال متاح لـ anon';
  end if;
  if has_function_privilege('anon', 'public.submit_subscription_downgrade(text, text, text, text, text)', 'execute') then
    raise exception '136: طلب التخفيض متاح لـ anon';
  end if;
  if not has_function_privilege('authenticated', 'public.subscription_downgrade_quote(text)', 'execute') then
    raise exception '136: عرض التخفيض غير متاح لـ authenticated';
  end if;
  -- 111: طلب التخفيض لا يقبل تذكرة خارج مدعوم، كالشراء والترقية.
  if position('scope = ''mad3oom_support''' in pg_get_functiondef('public.request_subscription_downgrade(text,uuid,text,text)'::regprocedure)) = 0 then
    raise exception '136: طلب التخفيض يقبل تذكرة خارج مدعوم';
  end if;
  -- 095/108: حمولة اللوحة ما زالت تفحص الفريق وتحمل حالة الإيقاف —
  -- النسخة هنا مبنية على 108 لا على 021، فلا تراجع.
  if position('company_staff_role()' in pg_get_functiondef('public.get_my_company_dashboard()'::regprocedure)) = 0 then
    raise exception '136: حمولة اللوحة فقدت فحص الفريق (095)';
  end if;
  if position('company_suspension_enforced' in pg_get_functiondef('public.get_my_company_dashboard()'::regprocedure)) = 0 then
    raise exception '136: حمولة اللوحة فقدت منطق الإيقاف (108)';
  end if;
  if position('cancel_at_period_end' in pg_get_functiondef('public.get_my_company_dashboard()'::regprocedure)) = 0 then
    raise exception '136: حمولة اللوحة بلا علَم الإلغاء';
  end if;
  raise notice '136: إلغاء نهاية المدة + تخفيض + حارس تعارض المعلّقة + علَم الإلغاء في حمولة اللوحة';
end $$;
