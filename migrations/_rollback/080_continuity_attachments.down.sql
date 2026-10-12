-- ============================================================================
-- تراجع 080_continuity_attachments
--
-- يعيد _continuity_full لنصها في 079 حرفيًا، ويحذف سياسة القراءة على storage.objects،
-- ودوال المرفقات، والجدول continuity_attachments، ومهمة الكنس.
--
-- حماية: يرفض لو 081 أو ما بعده مطبق. ويرفض لو فيه أي مرفق غير نهائي (pending/active/removed) أو ملف لم يُحذف فعليًا
-- من المستودع، إلا لو الجلسة ضبطت
--   set continuity.rollback_discard_data = 'on';
-- المستودع continuity-attachments نفسه **لا يُحذف هنا**: Storage يمنع حذف صفوفه بـ SQL،
-- والملفات تُحذف بـ Storage API فقط. بعد التراجع لا توجد سياسة تسمح بقراءته أو الكتابة
-- فيه (خاص، ولا سياسة)، فيظل مغلقًا. حذفه يدويًا من لوحة Supabase بعد تفريغه.
-- ============================================================================

begin;

-- ترتيب التراجع: 081 (التسليم) وما بعده أولًا.
do $$
begin
  if to_regclass('public.continuity_handovers') is not null then
    raise exception 'تراجع 080: هجرة continuity لاحقة مطبقة (081+) — تراجع عنها أولًا';
  end if;
end $$;

do $$
begin
  if coalesce(current_setting('continuity.rollback_discard_data', true), '') <> 'on'
     and to_regclass('public.continuity_attachments') is not null
     and (exists (select 1 from public.continuity_attachments where status in ('pending', 'active', 'removed'))
          or exists (select 1 from storage.objects where bucket_id = 'continuity-attachments')) then
    raise exception 'تراجع 080: فيه مرفقات أو ملفات ستضيع — اضبط continuity.rollback_discard_data=on لو المقصود حذفها';
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'continuity-attachment-sweep';
  end if;
end $$;

drop policy if exists continuity_attachments_read on storage.objects;

-- ── نص 079 حرفيًا ───────────────────────────────────────────────────────────
create or replace function public._continuity_full(p_record uuid, p_replayed boolean default false)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'record', public._continuity_record_json(p_record),
    'sources', coalesce((select jsonb_agg(public._continuity_source_view(s.id) order by s.position)
                           from public.continuity_sources s
                          where s.record_id = p_record and s.removed_at is null), '[]'::jsonb),
    'removed', coalesce((select jsonb_agg(public._continuity_source_view(s.id)
                                          || jsonb_build_object('removed_at', s.removed_at, 'removed_by', s.removed_by)
                                          order by s.removed_at desc, s.position)
                           from public.continuity_sources s
                          where s.record_id = p_record and s.removed_at is not null and s.purged_at is null), '[]'::jsonb),
    'closures', coalesce((select jsonb_agg(jsonb_build_object(
                             'seq', c.seq, 'closed_status', c.closed_status, 'closed_at', c.closed_at, 'closed_by', c.closed_by,
                             'resolution_note', c.resolution_note, 'cancel_reason', c.cancel_reason,
                             'reopened_at', c.reopened_at, 'reopened_by', c.reopened_by, 'reopen_reason', c.reopen_reason,
                             'backfilled', c.backfilled) order by c.seq desc)
                            from public.continuity_closures c where c.record_id = p_record), '[]'::jsonb),
    'replayed', p_replayed);
$$;

drop function if exists public.continuity_attachment_begin(uuid, text, text, bigint, text, uuid);
drop function if exists public.continuity_attachment_commit(uuid, text);
drop function if exists public.continuity_attachment_remove(uuid, integer);
drop function if exists public.continuity_attachment_restore(uuid, integer);
drop function if exists public.continuity_attachment_purge(uuid, integer);
drop function if exists public.continuity_attachment_sweep(integer);
drop function if exists public.continuity_attachment_deletion_queue(integer);
drop function if exists public._continuity_attachment_for_write(uuid, integer);
drop function if exists public._continuity_require_attachments();
drop function if exists public._continuity_attachment_readable(text);
drop function if exists public._continuity_attachments_on();
drop function if exists public._continuity_capability_attachments();
drop function if exists public._continuity_attachment_json(public.continuity_attachments);
drop table if exists public.continuity_attachments;
drop function if exists public._continuity_guard_attachment();
drop function if exists public._continuity_attachment_name(text);
drop function if exists public._continuity_attachment_mime_ok(text, text);
drop function if exists public._continuity_attachment_max(text);

do $$
begin
  if to_regclass('public.continuity_attachments') is not null
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname like '%continuity%attachment%')
     or exists (select 1 from pg_policies where schemaname = 'storage' and policyname = 'continuity_attachments_read')
     or pg_get_functiondef('public._continuity_full(uuid,boolean)'::regprocedure) like '%attachment%' then
    raise exception 'تراجع 080: بقايا لم تُحذف';
  end if;
end $$;

commit;
