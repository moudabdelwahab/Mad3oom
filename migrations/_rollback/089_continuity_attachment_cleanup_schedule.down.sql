-- ============================================================================
-- التراجع عن 089_continuity_attachment_cleanup_schedule
--   يوقف الجدولة ويحذف دالة النداء والسر. الملفات الممسوحة تبقى في المستودع (غير مقروءة)
--   حتى تُحذف يدويًا أو يُعاد تطبيق 089. لا بيانات مرفقات تتأثر.
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'continuity-attachment-cleanup';
  end if;
end $$;
drop function if exists public._continuity_attachment_cleanup_call();
delete from public.internal_service_secrets where key = 'continuity_attachment_cleanup';
