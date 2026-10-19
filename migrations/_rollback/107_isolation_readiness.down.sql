-- ============================================================================
-- التراجع عن 107_isolation_readiness — يعيد الدالتين كما في الإنتاج قبل 107 حرفيًا.
-- يرفض إن كان العزل مفعّلًا (التراجع يعيد الثغرة).
--   psql --single-transaction -v ON_ERROR_STOP=1 -f migrations/_rollback/107_isolation_readiness.down.sql
-- ============================================================================
do $$
begin
  if public._feature_on('company_isolation_enforced') then
    raise exception 'التراجع عن 107 مرفوض: company_isolation_enforced مفعّل — التراجع يعيد تجاوز العزل';
  end if;
end $$;

create or replace function public.ticket_in_my_scope(p_ticket_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select auth.uid() is not null
     and exists (
           select 1
             from public.tickets t
            where t.id = p_ticket_id
              and (t.user_id = auth.uid() or public.supervises(t.user_id))
         );
$function$;

create or replace function public.can_access_ticket(p_ticket_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select p_ticket_id is not null and exists (
    select 1 from public.tickets t
     where t.id = p_ticket_id
       and (
            t.user_id = auth.uid()
         or public.is_platform_staff()
         or t.user_id in (select p.id from public.profiles p where p.super_user_id = auth.uid())
       )
  );
$function$;
