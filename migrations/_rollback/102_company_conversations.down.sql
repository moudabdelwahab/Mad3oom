-- ============================================================================
-- التراجع عن 102_company_conversations — 102 لا يغيّر دالة أو سياسة قائمة؛ التراجع يحذف كائناته
-- ويعيد كتالوج الصلاحيات كما كان بعد 098.
--
-- حماية البيانات: يرفض التراجع إن كان المفتاح مفعّلًا، أو وُجدت محادثة أو سجل محادثة (رسائل العملاء
-- لا تُحذف بتراجع)، أو ضبطت شركة صلاحية من صلاحيات المحادثات.
-- ============================================================================
do $$
begin
  if exists (select 1 from public.platform_feature_switches where key = 'company_inbox_enabled' and enabled) then
    raise exception 'التراجع عن 102 مرفوض: company_inbox_enabled مفعّل — أطفئه أولًا';
  end if;
  if to_regclass('public.company_conversations') is not null and (
       exists (select 1 from public.company_conversations) or exists (select 1 from public.company_conversation_events)) then
    raise exception 'التراجع عن 102 مرفوض: توجد محادثات أو سجلها — رسائل العملاء لا تُحذف بتراجع';
  end if;
  if exists (select 1 from public.company_role_permissions where permission_key like 'conversations.%')
     or exists (select 1 from public.company_user_permissions where permission_key like 'conversations.%') then
    raise exception 'التراجع عن 102 مرفوض: شركة ضبطت صلاحيات المحادثات';
  end if;
end $$;

drop function if exists public.company_conversation_start(text, text, uuid);
drop function if exists public.my_company_conversations();
drop function if exists public.company_conversation_thread(uuid);
drop function if exists public.company_conversation_post(uuid, text, boolean);
drop function if exists public.company_inbox_summary();
drop function if exists public.company_inbox_list(text);
drop function if exists public.company_conversation_assign(uuid, uuid);
drop function if exists public.company_conversation_set_status(uuid, text);
drop function if exists public._inbox_row(public.company_conversations, uuid);
drop function if exists public._inbox_event(uuid, uuid, text, jsonb);
drop function if exists public._inbox_viewer_scope(uuid);
drop function if exists public._inbox_user_can_view(uuid, uuid);
drop function if exists public._inbox_staff_access(uuid, uuid, text);
drop function if exists public._inbox_customer_can_write(uuid);
drop function if exists public._inbox_company_ok(uuid);
drop function if exists public._inbox_require_enabled();
drop table if exists public.company_conversation_reads;
drop table if exists public.company_conversation_events;
drop table if exists public.company_conversation_messages;
drop table if exists public.company_conversations;
drop function if exists public._company_conversation_immutable();
drop function if exists public._company_conversation_guard();
delete from public.company_permission_catalog where key like 'conversations.%';
delete from public.platform_feature_switches where key = 'company_inbox_enabled';
