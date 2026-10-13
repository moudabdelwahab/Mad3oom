-- ============================================================================
-- 089_continuity_attachment_cleanup_schedule.sql
--   Mad3oom Continuity — جدولة الحذف الفعلي لملفات المرفقات (S3، 080).
--
-- لماذا
--   080 يضع المرفق الممسوح/المحجوب/المهجور في طابور الحذف (continuity_attachment_deletion_queue)،
--   والدالة الطرفية continuity-attachment-cleanup تحذف ملفاته عبر Storage API. لكن لا شيء
--   يناديها: CONTINUITY_CLEANUP_SECRET غير مضبوط ولا جدولة. فالملف الممسوح يبقى في المستودع
--   (غير مقروء — سياسة القراءة تشترط مرفقًا نشطًا — لكنه موجود). هذا شرط قبل تشغيل المرفقات.
--
-- ما يضيفه (نفس نمط المشروع: internal_service_secrets + net.http_post)
--   • سرّ عشوائي (32 بايت) يُولَّد داخل القاعدة في internal_service_secrets
--     ('continuity_attachment_cleanup'). لا يمر بأي ملف أو سجل أو أداة؛ الجدول بلا سياسة وبلا
--     صلاحية لغير service_role (RLS مفعّل).
--   • _continuity_attachment_cleanup_call(): تنادي الدالة الطرفية بالسر (pg_net، غير متزامن).
--     مغلقة على الجميع؛ pg_cron فقط.
--   • مهمة pg_cron 'continuity-attachment-cleanup' كل ساعة عند الدقيقة 41 (بعد الكنس عند 23).
--
-- ما لا يفعله
--   • لا يشغّل المرفقات (attachments_enabled كما هو).
--   • لا يمس بيانات المرفقات. الحذف الفعلي تقرره 080 (الطابور) وحدها.
--   • الدالة الطرفية تقبل السر من البيئة (CONTINUITY_CLEANUP_SECRET) أو من هذا الصف.
--
-- قابل لإعادة التشغيل (لا يغيّر سرًا موجودًا). التراجع: _rollback/089_continuity_attachment_cleanup_schedule.down.sql
-- ============================================================================

do $$
begin
  if to_regprocedure('public.continuity_attachment_deletion_queue(integer)') is null then
    raise exception '089: يتطلب 080';
  end if;
  if to_regclass('public.internal_service_secrets') is null then
    raise exception '089: جدول internal_service_secrets غير موجود';
  end if;
  if to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') is null then
    raise exception '089: يتطلب pg_net (net.http_post)';
  end if;
end $$;

insert into public.internal_service_secrets (key, value)
values ('continuity_attachment_cleanup', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (key) do nothing;

create or replace function public._continuity_attachment_cleanup_call()
returns bigint language plpgsql security definer set search_path to 'public' as $$
declare v_secret text;
begin
  select value into v_secret from public.internal_service_secrets where key = 'continuity_attachment_cleanup';
  if v_secret is null then return null; end if;
  -- طلب غير متزامن (pg_net). الرد في net._http_response؛ الكنس يسجّل اختفاء الملفات.
  return net.http_post(
    url := 'https://srnelrdpqkcntbgudyto.supabase.co/functions/v1/continuity-attachment-cleanup',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cleanup-Secret', v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000);
end $$;

revoke all on function public._continuity_attachment_cleanup_call() from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public._continuity_attachment_cleanup_call() from service_role;
  end if;
end $$;

comment on function public._continuity_attachment_cleanup_call() is
  '089: تنادي continuity-attachment-cleanup بالسر الداخلي (pg_cron فقط).';

-- pg_cron (كما في 080: يُجدول حيث يوجد pg_cron، أي في الإنتاج)
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'continuity-attachment-cleanup';
    perform cron.schedule('continuity-attachment-cleanup', '41 * * * *', 'select public._continuity_attachment_cleanup_call()');
  end if;
end $$;

-- التحقق
do $$
begin
  if (select count(*) from public.internal_service_secrets where key = 'continuity_attachment_cleanup' and length(value) = 64) <> 1 then
    raise exception '089: السر غير موجود';
  end if;
  if has_table_privilege('anon', 'public.internal_service_secrets', 'SELECT')
     or has_table_privilege('authenticated', 'public.internal_service_secrets', 'SELECT') then
    raise exception '089: جدول الأسرار مقروء لغير الخدمة';
  end if;
  if has_function_privilege('authenticated', 'public._continuity_attachment_cleanup_call()', 'EXECUTE')
     or has_function_privilege('anon', 'public._continuity_attachment_cleanup_call()', 'EXECUTE') then
    raise exception '089: دالة النداء مكشوفة';
  end if;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (select 1 from cron.job where jobname = 'continuity-attachment-cleanup' and schedule = '41 * * * *' and active) then
      raise exception '089: الجدولة غير مسجّلة';
    end if;
  end if;
  raise notice '089: الحذف الفعلي لملفات المرفقات مجدول كل ساعة (41)';
end $$;
