-- ============================================================================
-- 065_support_plans_egp_ticket_quota.sql
--   خطط الدعم الجديدة بالجنيه المصري، ورصيد تذاكر شهري مفروض من القاعدة.
--
-- ما الذي تغيّر في المنتج
--   • المعروض للبيع: الخطة المجانية، الخطة المتقدمة، الخطة الفائقة.
--     «المتقدمة» هي مفتاح 'support' نفسه (اسم جديد وسعر جديد) — فالمشترك
--     الحالي في الدعم الفني يصير على المتقدمة بلا ترحيل صفوف.
--     «الفائقة» مفتاح جديد 'ultimate'.
--   • واتساب والباقة الشاملة **مخفيتان من صفحات البيع فقط**. تبقيان مفعّلتين
--     هنا عمدًا: مشتركوهما الحاليون يجددون، ووحدة الواتساب تعمل كما هي.
--   • كل الأسعار بالجنيه (سعر صرف 52.50 يوم 2026-10-05). العملة واحدة لكل
--     الخطط لأن subscription_upgrade_quote يقارن السعرين رقميًا — خطة بالدولار
--     وأخرى بالجنيه كانت ستجعل كل ترقية «ليست ترقية».
--
-- رصيد التذاكر
--   الحد شهري بالتقويم المصري (Africa/Cairo) ويُحسب على **الحساب**: صاحب
--   الحساب ومن يتبعه (profiles.super_user_id) — الشركة وأعضاؤها وعملاؤها رصيد
--   واحد. المجانية 20، المتقدمة 300، الفائقة والشاملة بلا حد.
--   تذاكر الفوترة (طلب اشتراك/ترقية/تجديد وشحن محفظة الواتساب) خارج الحد
--   وخارج العدّ: عميل استهلك رصيده لازم يقدر يطلب الترقية. لكن التصنيف
--   'subscription' متاح في نموذج التذكرة العادي، فلها سقف مستقل (5 شهريًا)
--   حتى لا تصير بابًا خلفيًا لتجاوز الحد.
--   الطاقم (أدمن/دعم/مالك المنصة) خارج الحد.
--
-- لماذا في القاعدة وليس في الواجهة
--   أي قيد في المتصفح يتخطاه نداء REST مباشر أو مفتاح API. الحارس هنا محفّز
--   BEFORE INSERT على tickets، فيطال كل مسار إدراج: الواجهة، والـ API، و SIE.
--   والتزامن محكوم بقفل استشاري على الحساب فلا يتجاوز طلبان متزامنان الحد.
--
-- النطاق الفرعي
--   صفحة الأسعار تقول إنه للخطط المدفوعة، لكن لم يكن هناك أي فحص. صار امتيازًا
--   ('subdomain') يُفحص عند طلب نطاق جديد.
--
-- التطبيق في الإنتاج (2026-10-05)
--   طُبِّق بنفس المحتوى على خمس دفعات (065a..065e في سجل الترحيلات)، لأن أداة
--   التطبيق كانت تنتظر تأكيد أوامر DROP. ولأن المحفّزات والسياسات لم تكن
--   موجودة، طُبِّقت بلا «drop … if exists». الرقمان 063 و064 مأخوذان في فرعَي
--   keen-rubin-ogkj72.
-- ============================================================================

begin;

-- ── 1) الامتيازات الجديدة ───────────────────────────────────────────────────
insert into public.feature_flags (key, name, name_ar, description) values
  ('unlimited_tickets', 'Unlimited tickets', 'تذاكر غير محدودة', 'لا حد شهري لعدد التذاكر'),
  ('subdomain', 'Subdomain', 'نطاق فرعي', 'نطاق فرعي باسم الشركة على mad3oom.com')
on conflict (key) do nothing;

-- ── 2) الخطة الفائقة مسموحة في الاشتراكات ──────────────────────────────────
alter table public.whatsapp_subscriptions drop constraint if exists whatsapp_subscriptions_plan_check;
alter table public.whatsapp_subscriptions add constraint whatsapp_subscriptions_plan_check
  check (plan = any (array['support'::text, 'ultimate'::text, 'whatsapp'::text, 'bundle'::text]));

-- ── 3) الخطط والأسعار بالجنيه ───────────────────────────────────────────────
update public.subscription_plans
   set name = 'Advanced', name_ar = 'الخطة المتقدمة',
       price_monthly = 999, price_yearly = 9999, currency = 'EGP', sort_order = 10, updated_at = now()
 where key = 'support';

insert into public.subscription_plans (key, name, name_ar, is_active, sort_order, requires_company, price_monthly, price_yearly, currency)
values ('ultimate', 'Ultimate', 'الخطة الفائقة', true, 15, true, 1999, 19999, 'EGP')
on conflict (key) do update
  set name = excluded.name, name_ar = excluded.name_ar, is_active = true, sort_order = excluded.sort_order,
      requires_company = excluded.requires_company, price_monthly = excluded.price_monthly,
      price_yearly = excluded.price_yearly, currency = excluded.currency, updated_at = now();

-- مخفيتان من البيع، محوّلتان بنفس السعر حتى يبقى تجديد مشتركيهما الحاليين منطقيًا.
update public.subscription_plans
   set price_monthly = 1299, price_yearly = 12999, currency = 'EGP', updated_at = now()
 where key = 'whatsapp';
update public.subscription_plans
   set price_monthly = 2099, price_yearly = 22999, currency = 'EGP', updated_at = now()
 where key = 'bundle';

-- ── 4) مزايا الخطط ─────────────────────────────────────────────────────────
-- الفائقة = كل مزايا الدعم + تذاكر بلا حد. الامتياز الإضافي ضروري أيضًا لأن
-- subscription_upgrade_quote يرفض ترقية لا تضيف امتيازًا («redundant»).
insert into public.plan_features (plan_id, feature_key, enabled, limits)
select sp.id, f.key, true, '{}'::jsonb
  from public.subscription_plans sp
  cross join (values ('support_tickets'), ('priority_support'), ('sub_users'), ('api_tokens'),
                     ('unlimited_tickets'), ('subdomain')) as f(key)
 where sp.key = 'ultimate'
on conflict (plan_id, feature_key) do update set enabled = true;

insert into public.plan_features (plan_id, feature_key, enabled, limits)
select sp.id, 'subdomain', true, '{}'::jsonb from public.subscription_plans sp where sp.key in ('support', 'bundle')
on conflict (plan_id, feature_key) do update set enabled = true;

-- الشاملة كانت «تذاكر يومية غير محدودة» — يحتفظ مشتركوها بذلك.
insert into public.plan_features (plan_id, feature_key, enabled, limits)
select sp.id, 'unlimited_tickets', true, '{}'::jsonb from public.subscription_plans sp where sp.key = 'bundle'
on conflict (plan_id, feature_key) do update set enabled = true;

-- ── 5) حدود التذاكر الشهرية ─────────────────────────────────────────────────
-- 'free' ليست صفًّا في subscription_plans: المجانية هي غياب الاشتراك، ولا
-- تُشترى. monthly_tickets = null يعني بلا حد.
create table if not exists public.plan_ticket_quotas (
  plan_key        text primary key,
  monthly_tickets integer check (monthly_tickets is null or monthly_tickets > 0),
  updated_at      timestamptz not null default now()
);
comment on table public.plan_ticket_quotas is
  'الحد الشهري للتذاكر لكل خطة (null = بلا حد). free = الحساب بلا اشتراك دعم فعّال.';

insert into public.plan_ticket_quotas (plan_key, monthly_tickets) values
  ('free', 20), ('support', 300), ('ultimate', null), ('bundle', null)
on conflict (plan_key) do update set monthly_tickets = excluded.monthly_tickets, updated_at = now();

alter table public.plan_ticket_quotas enable row level security;
drop policy if exists "Anyone can read ticket quotas" on public.plan_ticket_quotas;
create policy "Anyone can read ticket quotas" on public.plan_ticket_quotas for select using (true);
drop policy if exists "Admins manage ticket quotas" on public.plan_ticket_quotas;
create policy "Admins manage ticket quotas" on public.plan_ticket_quotas for all
  using (public.is_admin()) with check (public.is_admin());
grant select on public.plan_ticket_quotas to anon, authenticated;

-- ── 6) الحساب صاحب الرصيد ──────────────────────────────────────────────────
-- مستخدم يتبع حسابًا (عضو شركة أو عميلها) يستهلك من رصيد صاحب الحساب.
create or replace function public.ticket_account_owner(p_user_id uuid)
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce((select p.super_user_id from public.profiles p where p.id = p_user_id), p_user_id);
$function$;
revoke all on function public.ticket_account_owner(uuid) from public, anon, authenticated;

-- ── 7) حالة الرصيد ─────────────────────────────────────────────────────────
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

  -- أفضل اشتراك دعم فعّال الآن: بلا حد أولًا، ثم الحد الأعلى، ثم الأبعد انتهاءً.
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

  select count(*) into v_used
    from public.tickets t
   where (t.user_id = v_owner or t.user_id in (select p.id from public.profiles p where p.super_user_id = v_owner))
     and t.created_at >= v_period_start
     and coalesce(t.category, '') not in ('subscription', 'whatsapp_wallet_topup');

  select count(*) into v_billing
    from public.tickets t
   where (t.user_id = v_owner or t.user_id in (select p.id from public.profiles p where p.super_user_id = v_owner))
     and t.created_at >= v_period_start
     and t.category in ('subscription', 'whatsapp_wallet_topup');

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
revoke all on function public.ticket_quota_status(uuid) from public, anon, authenticated;

-- محفظة التذاكر للمستخدم الحالي (أيقونة المحفظة وصفحة «اشتراكي»).
create or replace function public.my_ticket_wallet()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  select public.ticket_quota_status(auth.uid());
$function$;
revoke all on function public.my_ticket_wallet() from public, anon;
grant execute on function public.my_ticket_wallet() to authenticated;

-- ── 8) الحارس: لا تذكرة بعد نفاد الرصيد ─────────────────────────────────────
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

  -- طلبان متزامنان على نفس الحساب يُسلسلان، فلا يتجاوزان الحد معًا.
  perform pg_advisory_xact_lock(hashtextextended('ticket_quota:' || public.ticket_account_owner(new.user_id)::text, 0));

  v_status := public.ticket_quota_status(new.user_id);

  -- تذاكر الفوترة: خارج الرصيد العادي، بسقف مستقل.
  if coalesce(new.category, '') in ('subscription', 'whatsapp_wallet_topup') then
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

-- الاسم يبدأ بـ tickets_ ليسبق tr_set_ticket_number أبجديًا: الرفض قبل حجز رقم التذكرة.
drop trigger if exists tickets_enforce_quota on public.tickets;
create trigger tickets_enforce_quota
  before insert on public.tickets
  for each row execute function public.enforce_ticket_quota();

-- ── 9) النطاق الفرعي للخطط المدفوعة ─────────────────────────────────────────
create or replace function public.enforce_subdomain_entitlement()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;
  if not public.has_feature_access('subdomain', coalesce(new.user_id, auth.uid())) then
    raise exception 'النطاق الفرعي متاح في الخطة المتقدمة والخطة الفائقة. رقّي خطتك من صفحة الاشتراكات.'
      using errcode = '42501', hint = 'subdomain_requires_plan';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_enforce_subdomain_entitlement on public.subdomain_requests;
create trigger trg_enforce_subdomain_entitlement
  before insert on public.subdomain_requests
  for each row execute function public.enforce_subdomain_entitlement();

-- ── 10) أسماء الخطط في إشعار الإدارة ───────────────────────────────────────
create or replace function public.notify_admin_on_new_subscription()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_admin_id uuid;
    v_customer_name text;
    v_plan_label text;
begin
    select id into v_admin_id from profiles where email = 'support@mad3oom.online' limit 1;
    if v_admin_id is null then
        return new;
    end if;

    select coalesce(full_name, email, 'عميل') into v_customer_name from profiles where id = new.user_id;
    v_plan_label := coalesce((select coalesce(name_ar, name) from subscription_plans where key = new.plan), new.plan);

    insert into notifications (user_id, title, message, type, link)
    values (v_admin_id, 'اشتراك جديد',
            format('قام العميل "%s" بطلب اشتراك في %s.', v_customer_name, v_plan_label),
            'success', '/admin/subscriptions.html');
    return new;
end;
$function$;

commit;
