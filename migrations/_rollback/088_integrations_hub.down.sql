-- ============================================================================
-- تراجع 088_integrations_hub
--
-- يحذف مركز التكاملات كاملًا: الجداول الأحد عشر، والدوال، ومهمة الاحتفاظ في
-- pg_cron. لا كائن قائم قبل 088 يعتمد عليه: tickets و profiles و companies و
-- company_staff (086) تبقى كما هي.
--
-- حماية: يرفض التنفيذ لو فيه أي ربط أو طلب دعم أو سجل تدقيق، إلا لو الجلسة
-- ضبطت صراحةً
--   set integrations_hub.rollback_discard_data = 'on';
-- لأن الحذف يفقد بيانات اعتماد الشركات (المشفّرة) وروابط التذاكر وطلبات الدعم
-- الواردة وسجل التدقيق نهائيًا. بعد التراجع على الشركات إعادة الربط من الصفر.
--
-- لا يلمس tickets: التذاكر المحوَّلة من طلبات الدعم تبقى تذاكر عادية.
-- ============================================================================

begin;

do $$
begin
  if coalesce(current_setting('integrations_hub.rollback_discard_data', true), '') <> 'on'
     and ((to_regclass('public.ihub_connections') is not null
           and exists (select 1 from public.ihub_connections))
          or (to_regclass('public.ihub_intake_requests') is not null
              and exists (select 1 from public.ihub_intake_requests))
          or (to_regclass('public.ihub_audit_events') is not null
              and exists (select 1 from public.ihub_audit_events))
          or exists (select 1 from public.plan_features where feature_key = 'integrations_hub')) then
    raise exception 'تراجع 088: فيه روابط أو طلبات دعم أو سجل تدقيق أو باقة تشمل integrations_hub — اضبط integrations_hub.rollback_discard_data=on لو المقصود حذفها';
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'ihub-retention-sweep';
  end if;
end $$;

-- الدوال أولًا (بعضها يعتمد على أنواع صفوف الجداول)
do $$
declare f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname like 'ihub\_%'
              and p.proname not like '\_ihub\_guard\_%' loop
    execute format('drop function if exists %s', f);
  end loop;
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like '\_ihub\_%'
              and p.proname not like '\_ihub\_guard\_%' loop
    execute format('drop function if exists %s', f);
  end loop;
end $$;

drop table if exists public.ihub_audit_events;
drop table if exists public.ihub_request_nonces;
drop table if exists public.ihub_intake_requests;
drop table if exists public.ihub_customer_links;
drop table if exists public.ihub_ticket_links;
drop table if exists public.ihub_external_records;
drop table if exists public.ihub_webhook_events;
drop table if exists public.ihub_oauth_states;
drop table if exists public.ihub_credentials;
drop table if exists public.ihub_connections;
drop table if exists public.ihub_providers;

-- يحذف منح الامتياز للباقات أيضًا (ON DELETE CASCADE على plan_features)
delete from public.feature_flags where key = 'integrations_hub';

drop function if exists public._ihub_guard_connection();
drop function if exists public._ihub_guard_company_of_connection();
drop function if exists public._ihub_guard_ticket_link();
drop function if exists public._ihub_guard_customer_link();
drop function if exists public._ihub_guard_append_only();
drop function if exists public._ihub_guard_truncate();

do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public'
                and (p.proname like 'ihub\_%' or p.proname like '\_ihub\_%'))
     or exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relname like 'ihub\_%' and c.relkind = 'r'
                   and c.relname in ('ihub_providers', 'ihub_connections', 'ihub_credentials',
                                     'ihub_oauth_states', 'ihub_webhook_events',
                                     'ihub_external_records', 'ihub_ticket_links',
                                     'ihub_customer_links', 'ihub_intake_requests',
                                     'ihub_request_nonces', 'ihub_audit_events')) then
    raise exception 'تراجع 088: بقيت كائنات';
  end if;
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    if exists (select 1 from cron.job where jobname = 'ihub-retention-sweep') then
      raise exception 'تراجع 088: مهمة الاحتفاظ ما زالت مجدولة';
    end if;
  end if;
end $$;

commit;
