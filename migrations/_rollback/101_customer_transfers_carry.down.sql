-- ============================================================================
-- التراجع عن 101_customer_transfers_carry — يعيد 4 دوال (الحصة والسجل) كما كانت بعد 100 حرفيًا
-- ويحذف النقل والنسخ والوصول التاريخي.
--
-- حماية البيانات: يرفض التراجع إن كان مفتاح من مفاتيح 101 مفعّلًا، أو وُجد أي طلب نقل أو نسخ أو
-- طلب وصول تاريخي أو سجله — بعد التراجع ستُحسب التذاكر المنسوخة مرة ثانية، وتاريخ النقل يضيع.
-- ============================================================================
do $$
begin
  if exists (select 1 from public.platform_feature_switches
              where key in ('customer_transfers_enabled', 'ticket_carry_enabled', 'historical_access_enabled') and enabled) then
    raise exception 'التراجع عن 101 مرفوض: مفتاح النقل أو النسخ أو الوصول التاريخي مفعّل — أطفئه أولًا';
  end if;
  if to_regclass('public.customer_transfers') is not null and (
       exists (select 1 from public.customer_transfers) or exists (select 1 from public.ticket_carries)
       or exists (select 1 from public.historical_access_requests) or exists (select 1 from public.historical_access_audit)) then
    raise exception 'التراجع عن 101 مرفوض: توجد طلبات نقل أو نسخ أو وصول تاريخي — سجل لا يُحذف بتراجع';
  end if;
  if exists (select 1 from public.company_membership_events
              where action in ('transfer_requested', 'transferred_out', 'transferred_in')) then
    raise exception 'التراجع عن 101 مرفوض: سجل العضويات فيه أحداث نقل — سجل إلحاقي لا يُحذف بتراجع';
  end if;
end $$;

-- قيد أحداث العضوية كما كان بعد 096
alter table public.company_membership_events drop constraint if exists company_membership_events_action_check;
alter table public.company_membership_events add constraint company_membership_events_action_check
  check (action in ('joined', 'ended', 'primary_set', 'primary_unset',
                    'invited', 'invitation_accepted', 'invitation_declined',
                    'invitation_cancelled', 'context_set'));

drop trigger if exists trg_guard_raw_company_move on public.profiles;

-- الدوال كما كانت بعد 100 حرفيًا

-- public.ticket_quota_status(uuid)
CREATE OR REPLACE FUNCTION public.ticket_quota_status(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

-- public.enforce_ticket_quota()
CREATE OR REPLACE FUNCTION public.enforce_ticket_quota()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

-- public._usage_record_ticket(public.tickets,text)
CREATE OR REPLACE FUNCTION public._usage_record_ticket(p_ticket tickets, p_source text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_counter text := case when coalesce(p_ticket.category, '') = 'whatsapp_wallet_topup' then 'billing' else 'used' end;
begin
  insert into public.usage_ledger (idempotency_key, period, event, counter, units, account_id, rule_version,
                                   ticket_id, ticket_user_id, ticket_scope, company_id, source)
  values ('ticket:' || p_ticket.id || ':created', public._usage_period(p_ticket.created_at), 'ticket_created',
          v_counter, 1, public.ticket_account_owner(p_ticket.user_id),
          (select version from public.billing_rule_versions where status = 'active'),
          p_ticket.id, p_ticket.user_id, p_ticket.scope, p_ticket.company_id, p_source)
  on conflict (idempotency_key) do nothing;
end $function$;

-- public.usage_reconciliation(date)
CREATE OR REPLACE FUNCTION public.usage_reconciliation(p_period date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_period date := coalesce(p_period, public._usage_period(now()));
  v_start  timestamptz := (v_period::timestamp at time zone 'Africa/Cairo');
  v_end    timestamptz := ((v_period + interval '1 month')::timestamp at time zone 'Africa/Cairo');
begin
  if not public._usage_caller_ok() then
    raise exception 'لمالك المنصة وحده' using errcode = '42501';
  end if;
  return (
    with ledger as (
      select account_id,
             coalesce(sum(units) filter (where counter = 'used'), 0)::int as used,
             coalesce(sum(units) filter (where counter = 'billing'), 0)::int as billing
        from public.usage_ledger where period = v_period group by account_id),
    live as (
      select public.ticket_account_owner(t.user_id) as account_id,
             count(*) filter (where not b.is_billing)::int as used,
             count(*) filter (where b.is_billing)::int as billing
        from public.tickets t
        cross join lateral (
          select coalesce(t.category, '') = 'whatsapp_wallet_topup'
                 or exists (select 1 from public.whatsapp_subscriptions s where s.ticket_id = t.id) as is_billing) b
       where t.created_at >= v_start and t.created_at < v_end
       group by 1),
    joined as (
      select coalesce(l.account_id, v.account_id) as account_id,
             coalesce(l.used, 0) as ledger_used, coalesce(v.used, 0) as live_used,
             coalesce(l.billing, 0) as ledger_billing, coalesce(v.billing, 0) as live_billing
        from ledger l full join live v on v.account_id = l.account_id)
    select jsonb_build_object(
      'period', v_period,
      'accounts', (select count(*) from joined),
      'matching', (select count(*) from joined where ledger_used = live_used and ledger_billing = live_billing),
      'mismatches', coalesce((select jsonb_agg(jsonb_build_object(
          'account_id', j.account_id, 'ledger_used', j.ledger_used, 'live_used', j.live_used,
          'ledger_billing', j.ledger_billing, 'live_billing', j.live_billing,
          'reason', case when exists (select 1 from public.usage_ledger u
                                       where u.period = v_period and u.event = 'ticket_created'
                                         and public.ticket_account_owner(u.ticket_user_id) is distinct from u.account_id
                                         and (u.account_id = j.account_id
                                              or public.ticket_account_owner(u.ticket_user_id) = j.account_id))
                         then 'membership_changed' else 'unexplained' end) order by j.account_id)
          from joined j where j.ledger_used <> j.live_used or j.ledger_billing <> j.live_billing), '[]'::jsonb)));
end $function$;


drop function if exists public.transfer_request(uuid, boolean, uuid);
drop function if exists public.transfer_decide(uuid, boolean, boolean);
drop function if exists public.transfer_cancel(uuid);
drop function if exists public.owner_transfer_exceptional(uuid, uuid, text, boolean, uuid);
drop function if exists public.my_transfers();
drop function if exists public.company_transfer_requests();
drop function if exists public._transfer_execute(uuid);
drop function if exists public._transfers_require_enabled();
drop function if exists public._guard_raw_company_move();
drop function if exists public.carry_candidates(uuid);
drop function if exists public.carry_tickets(uuid, uuid, uuid[], uuid);
drop function if exists public.carry_copy_queue(integer);
drop function if exists public.carry_copy_complete(uuid, boolean, text, text);
drop function if exists public._carry_manifest(uuid, uuid);
drop function if exists public._carry_require_enabled();
drop function if exists public.historical_access_request(uuid, text);
drop function if exists public.my_historical_requests();
drop function if exists public.historical_access_consent(uuid, boolean, uuid[]);
drop function if exists public.owner_decide_historical_access(uuid, boolean, integer);
drop function if exists public.historical_ticket_view(uuid, uuid);
drop function if exists public.owner_historical_requests();
drop function if exists public.company_historical_requests();
drop function if exists public.h2_features();
drop function if exists public._historical_require_enabled();
drop table if exists public.historical_access_audit;
drop table if exists public.historical_access_requests;
drop table if exists public.ticket_carry_attachments;
drop table if exists public.ticket_carry_items;
drop table if exists public.ticket_carries;
drop table if exists public.customer_transfers;
drop function if exists public._h2_append_only();
delete from public.platform_feature_switches where key in ('customer_transfers_enabled', 'ticket_carry_enabled', 'historical_access_enabled');
