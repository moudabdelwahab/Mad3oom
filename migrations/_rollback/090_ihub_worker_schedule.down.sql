-- ============================================================================
-- التراجع عن 090_ihub_worker_schedule
--   يوقف الجدولة ويحذف دالة النداء والسر. الأحداث الفاشلة تبقى 'failed' حتى يكنسها
--   ihub_retention_sweep. لا بيانات ربط تتأثر. احذف IHUB_WORKER_SECRET من الدالة الطرفية أيضًا.
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'ihub-worker';
  end if;
end $$;
drop function if exists public._ihub_worker_call();
delete from public.internal_service_secrets where key = 'ihub_worker';
