-- ============================================================================
-- التراجع عن 103_platform_rate_limiting
--   • يعيد sie_rl_spend إلى جسمها في الإنتاج قبل 103 حرفيًا (sie 0009).
--   • يوقف الكنس ويحذف دوال المنصة وجدولي السياسات والسجل والفلفل.
--   • يحذف دلاء 'rl:' وحدها. دلاء SIE ('user:' / 'ip:' / 'integration:') لا تُمس.
--   لا بيانات مستخدمين ولا فوترة ولا حصص تتأثر.
--
--   ⚠ انشر نسخ الدوال السابقة قبل تشغيل هذا: الدوال الجديدة تنادي
--   rate_limit_hit؛ إن بقيت منشورة بعد التراجع ستفشل نداءاتها، والدوال
--   المغلقة عند الفشل (auth-exchange, oauth-*, landing-contact,
--   generate-ai-chat-reply, ai-session) ستردّ 503.
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'rate-limit-bucket-sweep';
  end if;
end $$;

create or replace function public.sie_rl_spend(p_key text, p_limit integer, p_burst integer)
 returns table(tokens double precision, allowed boolean)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
    v_capacity double precision := p_limit::double precision + greatest(p_burst, 0)::double precision;
    v_refill   double precision := p_limit::double precision / 60.0;
begin
    return query
    with hit as (
        insert into public.sie_rate_limit_buckets as b (
            bucket_key, tokens, updated_at, window_started_at,
            window_requests, window_rejected, total_requests, total_rejected,
            last_request_at, last_allowed
        )
        values (p_key, v_capacity - 1, now(), now(), 1, 0, 1, 0, now(), true)
        on conflict (bucket_key) do update set
            tokens = case
                when public.sie_rl_available(b.tokens, b.updated_at, v_capacity, v_refill) >= 1
                then public.sie_rl_available(b.tokens, b.updated_at, v_capacity, v_refill) - 1
                else public.sie_rl_available(b.tokens, b.updated_at, v_capacity, v_refill)
            end,
            last_allowed = public.sie_rl_available(b.tokens, b.updated_at, v_capacity, v_refill) >= 1,
            updated_at = now(),
            last_request_at = now(),
            window_started_at = case
                when now() - b.window_started_at >= interval '1 minute' then now()
                else b.window_started_at end,
            window_requests = case
                when now() - b.window_started_at >= interval '1 minute' then 1
                else b.window_requests + 1 end,
            window_rejected = case
                when now() - b.window_started_at >= interval '1 minute'
                    then case when public.sie_rl_available(b.tokens, b.updated_at, v_capacity, v_refill) >= 1 then 0 else 1 end
                else b.window_rejected
                    + case when public.sie_rl_available(b.tokens, b.updated_at, v_capacity, v_refill) >= 1 then 0 else 1 end
            end,
            total_requests = b.total_requests + 1,
            total_rejected = b.total_rejected
                + case when public.sie_rl_available(b.tokens, b.updated_at, v_capacity, v_refill) >= 1 then 0 else 1 end
        returning b.tokens, b.last_allowed
    )
    select hit.tokens, hit.last_allowed from hit;
end;
$function$;

revoke all on function public.sie_rl_spend(text, integer, integer) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.sie_rl_spend(text, integer, integer) to service_role;
  end if;
end $$;

drop function if exists public.rate_limit_sweep(integer);
drop function if exists public.rate_limit_admin_changes(integer);
drop function if exists public.rate_limit_admin_reset(text, text);
drop function if exists public.rate_limit_admin_set_policy(text, integer, integer, text, text);
drop function if exists public.rate_limit_admin_policies();
drop function if exists public.rate_limit_hit(text, text);
drop function if exists public._rl_bucket_key(text, text);
drop function if exists public.rl_spend(text, double precision, double precision);

delete from public.sie_rate_limit_buckets where bucket_key like 'rl:%';
drop table if exists public.rate_limit_policy_changes;
drop table if exists public.rate_limit_policies;
delete from public.internal_service_secrets where key = 'rate_limit_subject_pepper';
