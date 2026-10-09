-- ============================================================================
-- 069_billing_ticket_quota.sql
--   تذكرة «اشتراك» يفتحها العميل بنفسه تُحسب من رصيد التذاكر؛ الإعفاء لطلبات
--   الاشتراك والتجديد والترقية التي يُنشئها النظام فقط
--
-- المطلوب (من صاحب المنصة): «أخلي التذاكر اللي العميل بيفتحها بنفسه بتصنيف
-- «اشتراك» تتحسب من الـ 20، والإعفاء يفضل بس لطلبات الاشتراك والتجديد
-- والترقية اللي النظام بيعملها» ← «اعمل كدا».
--
-- ما كان قائمًا (065، نص الإنتاج في tests/fixtures/prod-shape)
--   • الإعفاء مبني على **التصنيف**: أي تذكرة category = 'subscription' خارج
--     الـ 20 (لها سقف مستقل 5 شهريًا). والتصنيف متاح في نموذج التذكرة العادي
--     («الاشتراكات والفواتير»)، فتذكرة دعم عادية عن مشكلة اشتراك لا تُحسب.
--     مُثبَت على الإنتاج: التذكرة #1120 (يدوية، تصنيف subscription) ⇒ used=0.
--   • وطلب الاشتراك نفسه كان يُنشئ تذكرته من **المتصفح** بنفس التصنيف ثم
--     ينادي request_subscription_purchase — فالقاعدة لا تملك ما تفرّق به بين
--     الاثنين وقت الإدراج.
--
-- ما يغيّره هذا الترحيل
--   1) submit_subscription_request / submit_subscription_upgrade: تذكرة الطلب
--      وطلب الاشتراك في **معاملة واحدة على الخادم**. التذكرة تُفتح بعلم معاملة
--      (mad3oom.billing_request_ticket) لا يضعه إلا هذا المسار، ثم تُمرَّر
--      للدالتين القائمتين كما هما (كل تحققات الشراء/الترقية في مكانها). فشل
--      أي خطوة يُرجع الاثنين — لا تذكرة يتيمة.
--   2) enforce_ticket_quota: تذكرة 'subscription' تُعفى من الـ 20 (وتخضع لسقف
--      الفوترة 5) **فقط** تحت هذا العلم. غير ذلك تُفحص كأي تذكرة.
--   3) ticket_quota_status: تذكرة الفوترة = مرتبطة فعلًا بطلب اشتراك
--      (whatsapp_subscriptions.ticket_id) أو شحن محفظة واتساب. كل ما عداها —
--      ومنه «اشتراك» اليدوية — من الـ 20.
--
-- ما لم يتغيّر (متعمّد)
--   • request_subscription_purchase / request_subscription_upgrade كما هما:
--     الواجهة المنشورة حاليًا (قبل دمج الواجهة الجديدة) تظل تعمل. تذكرتها
--     تُفحص من الـ 20 وقت الإدراج، ثم تُحسب فوترة بمجرد ارتباطها بالطلب.
--   • whatsapp_wallet_topup كما هو (خارج نطاق الطلب).
--   • الحدود نفسها: 20 / 300 / بلا حد، و 5 للفوترة.
--
-- لا حذف بيانات، وقابل لإعادة التشغيل.
-- التراجع: migrations/_rollback/069_billing_ticket_quota.down.sql
-- ============================================================================


-- ============================================================================
-- 1) الحارس وقت الإدراج
-- ============================================================================
create or replace function public.enforce_ticket_quota()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_status jsonb;
begin
  if new.user_id is null
     or public.is_admin()
     or exists (select 1 from public.profiles p
                 where p.id = new.user_id and p.role in ('admin', 'support', 'platform_owner')) then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('ticket_quota:' || public.ticket_account_owner(new.user_id)::text, 0));

  v_status := public.ticket_quota_status(new.user_id);

  -- 069: تذكرة الفوترة المعفاة = طلب يُنشئه النظام (العلم يضعه
  -- submit_subscription_request/upgrade وحدهما)، أو شحن محفظة واتساب.
  -- تذكرة 'subscription' بلا علم = تذكرة دعم عادية تُفحص من الرصيد.
  if coalesce(new.category, '') = 'whatsapp_wallet_topup'
     or (new.category = 'subscription'
         and coalesce(current_setting('mad3oom.billing_request_ticket', true), '') = 'on') then
    if (v_status->>'billing_used')::int >= (v_status->>'billing_limit')::int then
      raise exception 'وصلت للحد الأقصى من طلبات الاشتراك والفوترة هذا الشهر (% طلبات). لو محتاج مساعدة تواصل مع الدعم عبر المحادثة.',
        v_status->>'billing_limit'
        using errcode = 'P0001', hint = 'billing_quota_exceeded';
    end if;
    return new;
  end if;

  if (v_status->>'unlimited')::boolean is not true
     and (v_status->>'used')::int >= (v_status->>'monthly_limit')::int then
    raise exception 'وصلت للحد الأقصى من التذاكر في %: % تذكرة شهريًا. رقّي خطتك من صفحة الاشتراكات، أو انتظر تجدّد الرصيد أول الشهر.',
      v_status->>'plan_name_ar', v_status->>'monthly_limit'
      using errcode = 'P0001', hint = 'ticket_quota_exceeded';
  end if;
  return new;
end;
$function$;


-- ============================================================================
-- 2) العدّ: الفوترة = مرتبطة بطلب فعلي، لا تصنيف
-- ============================================================================
create or replace function public.ticket_quota_status(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_owner        uuid := public.ticket_account_owner(p_user_id);
  v_period_start timestamptz := date_trunc('month', now() at time zone 'Africa/Cairo') at time zone 'Africa/Cairo';
  v_period_end   timestamptz := (date_trunc('month', now() at time zone 'Africa/Cairo') + interval '1 month') at time zone 'Africa/Cairo';
  v_plan         text;
  v_sub          public.whatsapp_subscriptions%rowtype;
  v_unlimited    boolean;
  v_limit        integer;
  v_used         integer;
  v_billing      integer;
begin
  if p_user_id is null then
    return null;
  end if;

  select s.* into v_sub
    from public.whatsapp_subscriptions s
    join public.plan_ticket_quotas q on q.plan_key = s.plan
   where s.user_id = v_owner and s.status = 'active'
     and s.start_date <= now() and s.end_date > now()
   order by (q.monthly_tickets is null) desc, q.monthly_tickets desc nulls first, s.end_date desc
   limit 1;

  v_plan := coalesce(v_sub.plan, 'free');
  select q.monthly_tickets is null, q.monthly_tickets into v_unlimited, v_limit
    from public.plan_ticket_quotas q where q.plan_key = v_plan;
  if not found then
    v_unlimited := false; v_limit := 20;
  end if;

  -- تذكرة واحدة تُحسب مرة واحدة في واحد من العدّادين بالضبط
  select count(*) filter (where not b.is_billing),
         count(*) filter (where b.is_billing)
    into v_used, v_billing
    from public.tickets t
    cross join lateral (
      select coalesce(t.category, '') = 'whatsapp_wallet_topup'
             or exists (select 1 from public.whatsapp_subscriptions s where s.ticket_id = t.id) as is_billing
    ) b
   where (t.user_id = v_owner or t.user_id in (select p.id from public.profiles p where p.super_user_id = v_owner))
     and t.created_at >= v_period_start;

  return jsonb_build_object(
    'plan_key',          v_plan,
    'plan_name_ar',      coalesce((select coalesce(sp.name_ar, sp.name) from public.subscription_plans sp where sp.key = v_plan), 'الخطة المجانية'),
    'is_free',           v_sub.id is null,
    'subscription_id',   v_sub.id,
    'subscription_end',  v_sub.end_date,
    'billing_cycle',     v_sub.billing_cycle,
    'account_owner',     v_owner,
    'shared_account',    v_owner is distinct from p_user_id,
    'unlimited',         coalesce(v_unlimited, false),
    'monthly_limit',     case when v_unlimited then null else v_limit end,
    'used',              v_used,
    'remaining',         case when v_unlimited then null else greatest(0, v_limit - v_used) end,
    'billing_used',      v_billing,
    'billing_limit',     5,
    'period_start',      v_period_start,
    'resets_at',         v_period_end);
end;
$function$;

create index if not exists idx_whatsapp_subscriptions_ticket_id
  on public.whatsapp_subscriptions (ticket_id) where ticket_id is not null;


-- ============================================================================
-- 3) تذكرة الطلب على الخادم — المسار الوحيد للإعفاء
-- ============================================================================
--
-- العنوان والوصف من الواجهة (نص عرض بالعربي يذكر الباقة ووسيلة الدفع)؛ كل
-- ما يحدد المعاملة يفرضه الخادم: صاحب التذكرة، التصنيف، الأولوية، الحالة،
-- ومهلة الساعة للتحويل الخارجي. الدالة SECURITY DEFINER فتتخطى RLS، لذلك
-- تفحص بوابة الحساب (gate_account_active) بنفسها.
create or replace function public._open_billing_request_ticket(
  p_title          text,
  p_description    text,
  p_payment_method text
)
returns public.tickets
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  v_uid    uuid := auth.uid();
  v_title  text := nullif(btrim(coalesce(p_title, '')), '');
  v_desc   text := nullif(btrim(coalesce(p_description, '')), '');
  v_ticket public.tickets%rowtype;
begin
  if v_uid is null then
    raise exception 'يجب تسجيل الدخول أولًا' using errcode = '42501';
  end if;
  if not public.account_is_active() then
    raise exception 'حسابك غير مفعّل بعد' using errcode = '42501';
  end if;
  if v_title is null or char_length(v_title) > 200 then
    raise exception 'عنوان التذكرة غير صالح' using errcode = '22023';
  end if;
  if v_desc is null or char_length(v_desc) > 4000 then
    raise exception 'وصف التذكرة غير صالح' using errcode = '22023';
  end if;

  perform set_config('mad3oom.billing_request_ticket', 'on', true);
  insert into public.tickets (user_id, title, description, status, priority, category, sla_response_due_at)
  values (v_uid, v_title, v_desc, 'open', 'high', 'subscription',
          -- التحويل الخارجي يُراجَع خلال ساعة (نفس قيمة الواجهة سابقًا)؛ غيره
          -- يترك المهلة لـ set_ticket_sla.
          case when coalesce(p_payment_method, '') in ('bank_transfer', 'cash_wallet', 'instapay')
               then now() + interval '1 hour' end)
  returning * into v_ticket;
  -- العلم لا يتسرّب لأي إدراج لاحق في نفس المعاملة
  perform set_config('mad3oom.billing_request_ticket', 'off', true);

  return v_ticket;
end;
$function$;

revoke all on function public._open_billing_request_ticket(text, text, text) from public, anon, authenticated;


create or replace function public.submit_subscription_request(
  p_plan              text,
  p_billing_cycle     text,
  p_ticket_title      text,
  p_ticket_description text,
  p_is_renewal        boolean default false,
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
  v_ticket public.tickets%rowtype;
  v_result jsonb;
begin
  v_ticket := public._open_billing_request_ticket(p_ticket_title, p_ticket_description, p_payment_method);

  -- نفس دالة الشراء القائمة بكل تحققاتها؛ لو رفضت، التذكرة ترجع معها
  v_result := public.request_subscription_purchase(
    p_plan, p_billing_cycle, v_ticket.id, coalesce(p_is_renewal, false),
    p_payment_method, p_payment_reference);

  return v_result || jsonb_build_object('ticket', to_jsonb(v_ticket));
end;
$function$;

comment on function public.submit_subscription_request(text, text, text, text, boolean, text, text) is
  'طلب اشتراك/تجديد بتذكرته في معاملة واحدة. تذكرته وحدها معفاة من رصيد التذاكر (069).';

revoke all on function public.submit_subscription_request(text, text, text, text, boolean, text, text) from public, anon;
grant execute on function public.submit_subscription_request(text, text, text, text, boolean, text, text) to authenticated;


create or replace function public.submit_subscription_upgrade(
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

  v_result := public.request_subscription_upgrade(
    p_plan, v_ticket.id, p_payment_method, p_payment_reference);

  return v_result || jsonb_build_object('ticket', to_jsonb(v_ticket));
end;
$function$;

comment on function public.submit_subscription_upgrade(text, text, text, text, text) is
  'طلب ترقية بتذكرته في معاملة واحدة. تذكرته وحدها معفاة من رصيد التذاكر (069).';

revoke all on function public.submit_subscription_upgrade(text, text, text, text, text) from public, anon;
grant execute on function public.submit_subscription_upgrade(text, text, text, text, text) to authenticated;


-- ============================================================================
-- 4) تحقّق بَعدي
-- ============================================================================
do $$
begin
  if has_function_privilege('authenticated', 'public._open_billing_request_ticket(text, text, text)', 'execute')
     or has_function_privilege('anon', 'public._open_billing_request_ticket(text, text, text)', 'execute') then
    raise exception '069: فتح تذكرة فوترة معفاة متاح لعميل مباشرةً';
  end if;
  if has_function_privilege('anon', 'public.submit_subscription_request(text, text, text, text, boolean, text, text)', 'execute') then
    raise exception '069: submit_subscription_request متاحة لـ anon';
  end if;
  raise notice '069: «اشتراك» اليدوية من الرصيد، والإعفاء لطلبات النظام وحدها';
end $$;
