-- ============================================================================
-- 090_ihub_worker_schedule.sql
--   مركز التكاملات — جدولة العامل الخلفي (integrations-worker).
--
-- لماذا
--   088 لا يجدول العامل: يحتاج سرًا. العامل يعيد محاولة أحداث المزوّدين الفاشلة (بلا حمولة:
--   يجلب السجل من المزوّد من جديد) ويجدّد رموز سلة قبل انتهائها. بلا جدولة يبقى الحدث الفاشل
--   'failed' حتى يُكنس.
--
-- ما يضيفه (نفس نمط 089: internal_service_secrets + net.http_post)
--   • سرّ عشوائي (36 بايت hex) يُولَّد داخل القاعدة في internal_service_secrets ('ihub_worker').
--     لا يمر بأي ملف أو سجل أو أداة. الدالة الطرفية تقرؤه من IHUB_WORKER_SECRET، فيُنسخ إليها
--     مرة واحدة من لوحة Supabase (docs/integrations/PROD_INSTALL.md §5).
--   • _ihub_worker_call(): تنادي integrations-worker بالسر في الترويسة x-ihub-worker-secret
--     (pg_net، غير متزامن). مغلقة على كل الأدوار؛ pg_cron فقط.
--   • مهمة pg_cron 'ihub-worker' كل 5 دقائق.
--
-- لا تكرار
--   ihub_svc_claim_due_events تحجز الأحداث بـ FOR UPDATE SKIP LOCKED وتؤجّلها 5 دقائق قبل
--   المعالجة، فنداءان متداخلان لا يعالجان الحدث نفسه. تجديد رموز سلة يتم في العامل وحده.
--
-- ما لا يفعله
--   • لا يفعّل أي مزوّد ولا يمنح integrations_hub لأي باقة.
--   • لا يمس integration_* (واتساب) ولا أي سر آخر.
--
-- يعتمد على 088. قابل لإعادة التشغيل (لا يغيّر سرًا موجودًا).
-- التراجع: migrations/_rollback/090_ihub_worker_schedule.down.sql
-- ============================================================================

do $$
begin
  if to_regprocedure('public.ihub_svc_claim_due_events(integer)') is null then
    raise exception '090: يتطلب 088_integrations_hub';
  end if;
  if to_regclass('public.internal_service_secrets') is null then
    raise exception '090: جدول internal_service_secrets غير موجود';
  end if;
  if to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') is null then
    raise exception '090: يتطلب pg_net (net.http_post)';
  end if;
end $$;

insert into public.internal_service_secrets (key, value)
values ('ihub_worker', encode(extensions.gen_random_bytes(36), 'hex'))
on conflict (key) do nothing;

create or replace function public._ihub_worker_call()
returns bigint language plpgsql security definer set search_path to 'public' as $$
declare v_secret text;
begin
  select value into v_secret from public.internal_service_secrets where key = 'ihub_worker';
  if v_secret is null then return null; end if;
  -- طلب غير متزامن (pg_net). الرد في net._http_response.
  return net.http_post(
    url := 'https://srnelrdpqkcntbgudyto.supabase.co/functions/v1/integrations-worker',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-ihub-worker-secret', v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000);
end $$;

revoke all on function public._ihub_worker_call() from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public._ihub_worker_call() from service_role;
  end if;
end $$;

comment on function public._ihub_worker_call() is
  '090: تنادي integrations-worker بالسر الداخلي (pg_cron فقط).';

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'ihub-worker';
    perform cron.schedule('ihub-worker', '*/5 * * * *', 'select public._ihub_worker_call()');
  end if;
end $$;

-- التحقق
do $$
begin
  if (select count(*) from public.internal_service_secrets where key = 'ihub_worker' and value ~ '^[0-9a-f]{72}$') <> 1 then
    raise exception '090: السر غير موجود';
  end if;
  if has_table_privilege('anon', 'public.internal_service_secrets', 'SELECT')
     or has_table_privilege('authenticated', 'public.internal_service_secrets', 'SELECT') then
    raise exception '090: جدول الأسرار مقروء لغير الخدمة';
  end if;
  if has_function_privilege('authenticated', 'public._ihub_worker_call()', 'EXECUTE')
     or has_function_privilege('anon', 'public._ihub_worker_call()', 'EXECUTE') then
    raise exception '090: دالة النداء مكشوفة';
  end if;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if (select count(*) from cron.job where jobname = 'ihub-worker' and schedule = '*/5 * * * *' and active) <> 1 then
      raise exception '090: الجدولة غير مسجّلة';
    end if;
  end if;
  raise notice '090: عامل مركز التكاملات مجدول كل 5 دقائق';
end $$;
