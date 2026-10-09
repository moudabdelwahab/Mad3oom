-- ============================================================================
-- تراجع 069_billing_ticket_quota
--
-- بيرجّع enforce_ticket_quota و ticket_quota_status لنص الإنتاج حرفيًا (منقول
-- آليًا من tests/fixtures/prod-shape) — الإعفاء يرجع بالتصنيف — وبيشيل دوال
-- الطلب على الخادم وفهرس ticket_id.
--
-- ⚠️ قبله: الواجهة لازم ترجع للنسخة اللي بتفتح تذكرة الطلب من المتصفح ثم
--    تنادي request_subscription_purchase/upgrade (الدالتان ما اتغيّرتش)، وإلا
--    طلبات الاشتراك هتفشل بـ «function not found».
-- مفيش حذف بيانات: التذاكر والطلبات اللي اتعملت تفضل.
-- ============================================================================

drop function if exists public.submit_subscription_upgrade(text, text, text, text, text);
drop function if exists public.submit_subscription_request(text, text, text, text, boolean, text, text);
drop function if exists public._open_billing_request_ticket(text, text, text);
drop index if exists public.idx_whatsapp_subscriptions_ticket_id;

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
$function$
;

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
$function$
;
