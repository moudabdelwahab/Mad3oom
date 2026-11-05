-- ============================================================================
-- التراجع عن 123_communication_engine — 123 لا يغيّر دالة أو سياسة قائمة؛ التراجع يحذف كائناته وحدها.
-- جداول 102 (customer_company) لا تُمس.
--
-- حماية البيانات: يرفض التراجع إن كان مفتاح من مفاتيحه مفعّلًا، أو وُجدت محادثة أو رسالة أو مرفق أو ربط
-- تذكرة أو سجل (مراسلات الشركات والطاقم لا تُحذف بتراجع).
-- ============================================================================
do $$
begin
  if exists (select 1 from public.platform_feature_switches
              where key in ('comm_company_platform_enabled', 'comm_admin_owner_enabled', 'comm_attachments_enabled') and enabled) then
    raise exception 'التراجع عن 123 مرفوض: مفتاح تواصل مفعّل — أطفئه أولًا';
  end if;
  if to_regclass('public.comm_threads') is not null and (
       exists (select 1 from public.comm_threads) or exists (select 1 from public.comm_events)
       or exists (select 1 from public.comm_attachments) or exists (select 1 from public.comm_ticket_links)) then
    raise exception 'التراجع عن 123 مرفوض: توجد مراسلات أو مرفقات أو سجلها — لا تُحذف بتراجع';
  end if;
end $$;

drop policy if exists comm_attachments_read on storage.objects;
drop policy if exists comm_attachments_upload on storage.objects;
delete from storage.buckets b where b.id = 'comm-attachments'
  and not exists (select 1 from storage.objects o where o.bucket_id = 'comm-attachments');

drop function if exists public.comm_overview();
drop function if exists public.comm_thread_start(text, text, text, text, uuid, text, uuid[]);
drop function if exists public.comm_threads_list(text, text, text);
drop function if exists public.comm_thread(text, uuid);
drop function if exists public.comm_post(text, uuid, text, boolean, uuid[]);
drop function if exists public.comm_thread_assign(text, uuid, uuid);
drop function if exists public.comm_thread_set_status(text, uuid, text);
drop function if exists public.comm_link_ticket(text, uuid, uuid);
drop function if exists public.comm_staff_directory();
drop function if exists public.comm_attachment_begin(text, uuid, text, text, bigint);
drop function if exists public._comm_bind_attachments(text, uuid, uuid, uuid[]);
drop function if exists public._comm_message_attachments(text, uuid);
drop function if exists public._comm_attachment_json(public.comm_attachments);
drop function if exists public._comm_attachment_uploadable(text);
drop function if exists public._comm_attachment_readable(text);
drop function if exists public._comm_can_view_message(text, uuid, uuid);
drop function if exists public._comm_can_post(text, uuid, boolean);
drop function if exists public._comm_attachment_mime_ok(text);
drop function if exists public._comm_row(public.comm_threads, text);
drop function if exists public._comm_notify_requester(public.comm_threads);
drop function if exists public._comm_notify_responders(public.comm_threads, text, text);
drop function if exists public._comm_event(text, uuid, uuid, text, jsonb);
drop function if exists public._comm_scope_side(text);
drop function if exists public._comm_side(public.comm_threads);
drop function if exists public._comm_is_admin_requester(uuid);
drop function if exists public._comm_company_of_caller();
drop function if exists public._comm_actor_ok();
drop function if exists public._comm_require(text);
drop function if exists public._comm_scope_on(text);

drop table if exists public.comm_ticket_links;
drop table if exists public.comm_attachments;
drop table if exists public.comm_events;
drop table if exists public.comm_reads;
drop table if exists public.comm_messages;
drop table if exists public.comm_threads;
drop function if exists public._comm_attachment_guard();
drop function if exists public._comm_thread_guard();
drop function if exists public._comm_immutable();

delete from public.platform_feature_switches
 where key in ('comm_company_platform_enabled', 'comm_admin_owner_enabled', 'comm_attachments_enabled');
