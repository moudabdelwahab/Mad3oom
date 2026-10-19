-- ============================================================================
-- التراجع عن 108_phase1_readiness_fixes — يعيد الدالتين كما في الإنتاج قبل 108 حرفيًا
-- (md5 لـ pg_get_functiondef في الإنتاج 2026-10-20: _access_grant_active a880cdbb7ece02faa4b4e951b0181683،
--  evaluate_customer_badges bccaee8736d471842f18108804775280). لا بيانات تتغير.
--   psql --single-transaction -v ON_ERROR_STOP=1 -f migrations/_rollback/108_phase1_readiness_fixes.down.sql
-- ============================================================================
create or replace function public._access_grant_active(p_grant uuid)
returns public.data_access_grants
language sql
stable
security definer
set search_path to 'public'
as $$
  select g.* from public.data_access_grants g
   where g.id = p_grant and g.grantee_id = auth.uid() and g.revoked_at is null
     and now() >= g.starts_at and now() < g.expires_at
     and public._feature_on('data_access_grants_enabled')
     and coalesce(public.account_is_active(), false);
$$;

CREATE OR REPLACE FUNCTION public.evaluate_customer_badges(p_user_id uuid)
 RETURNS TABLE(badge_key text, newly_earned boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_badge record;
  v_qualifies boolean;
  v_ticket_count int;
  v_account_age_days int;
  v_points int;
  v_has_subdomain boolean;
  v_has_whatsapp boolean;
  v_has_forum boolean;
  v_has_rating boolean;
  v_has_fast_reply boolean;
begin
  if p_user_id is null then
    return;
  end if;

  select count(*) into v_ticket_count from public.tickets where user_id = p_user_id;

  select coalesce(extract(day from now() - created_at)::int, 0), coalesce(points, 0)
    into v_account_age_days, v_points
  from public.profiles where id = p_user_id;

  if v_account_age_days is null then
    v_account_age_days := 0;
  end if;
  if v_points is null then
    v_points := 0;
  end if;

  select exists(
    select 1 from public.subdomain_requests
    where user_id = p_user_id and status = 'success'
  ) into v_has_subdomain;

  select exists(
    select 1 from public.whatsapp_subscriptions
    where user_id = p_user_id and status = 'active'
  ) into v_has_whatsapp;

  select exists(
    select 1 from public.forum_threads where author_id = p_user_id
    union all
    select 1 from public.forum_replies where author_id = p_user_id
  ) into v_has_forum;

  select exists(
    select 1 from public.ticket_ratings where user_id = p_user_id
  ) into v_has_rating;

  select exists (
    select 1
    from public.ticket_replies tr
    join public.tickets t on t.id = tr.ticket_id
    join public.profiles p on p.id = tr.user_id
    where t.user_id = p_user_id
      and tr.is_internal = false
      and coalesce(p.role, 'user') not in ('admin','support','super_user')
      and exists (
        select 1 from public.ticket_replies staff_r
        join public.profiles sp on sp.id = staff_r.user_id
        where staff_r.ticket_id = tr.ticket_id
          and coalesce(sp.role,'user') in ('admin','support','super_user')
          and staff_r.created_at < tr.created_at
          and tr.created_at - staff_r.created_at <= interval '10 minutes'
      )
  ) into v_has_fast_reply;

  for v_badge in
    select * from public.badge_definitions where is_active = true and criteria_type <> 'manual'
  loop
    v_qualifies := false;

    if v_badge.criteria_type = 'ticket_count' then
      v_qualifies := v_ticket_count >= coalesce((v_badge.criteria_value->>'count')::int, 1);
    elsif v_badge.criteria_type = 'fast_reply' then
      v_qualifies := v_has_fast_reply;
    elsif v_badge.criteria_type = 'account_age_days' then
      v_qualifies := v_account_age_days >= coalesce((v_badge.criteria_value->>'days')::int, 30);
    elsif v_badge.criteria_type = 'points_threshold' then
      v_qualifies := v_points >= coalesce((v_badge.criteria_value->>'points')::int, 100);
    elsif v_badge.criteria_type = 'subdomain_created' then
      v_qualifies := v_has_subdomain;
    elsif v_badge.criteria_type = 'whatsapp_subscriber' then
      v_qualifies := v_has_whatsapp;
    elsif v_badge.criteria_type = 'forum_post' then
      v_qualifies := v_has_forum;
    elsif v_badge.criteria_type = 'ticket_rating' then
      v_qualifies := v_has_rating;
    end if;

    if v_qualifies then
      insert into public.customer_badges (user_id, badge_id)
      values (p_user_id, v_badge.id)
      on conflict (user_id, badge_id) do nothing;

      if FOUND then
        insert into public.notifications (user_id, title, message, type, link)
        values (
          p_user_id,
          v_badge.icon || ' شارة جديدة: ' || v_badge.name,
          'مبروك! حصلت على شارة "' || v_badge.name || '" - ' || v_badge.description,
          'success',
          '/customer-dashboard.html'
        );

        badge_key := v_badge.key;
        newly_earned := true;
        return next;
      end if;
    end if;
  end loop;

  return;
end;
$function$;
