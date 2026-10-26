-- ============================================================================
-- تراجع 113 — يحذف دوال إدارة الأعضاء وجداولها ويعيد قيود السجل كما كانت قبل 113.
-- يُرفض بعد الاستعمال: إيقاف أو إعادة تفعيل أو حدث إدارة عضو في السجل الإلحاقي أو طلب نقل أو تعديل حساب
-- (سجلات لا تُحذف بتراجع، وعضوية موقوفة بلا جدولها تصير إزالة بلا رجعة).
-- دالة Edge «company-member-admin» يجب إيقافها واسترجاع الواجهة قبل تطبيق هذا.
-- معاملة واحدة: الرفض يُبطل الملف كله حتى لو تابع المنفّذ بعد الخطأ.
-- ============================================================================
begin;

do $$
begin
  if exists (select 1 from public.company_memberships where end_cause = 'suspended' or joined_via = 'reactivated')
     or exists (select 1 from public.company_membership_events where action like 'member\_%')
     or exists (select 1 from public.company_member_transfer_requests)
     or exists (select 1 from public.company_member_account_changes)
     or exists (select 1 from public.company_member_suspensions) then
    raise exception 'التراجع عن 113 مرفوض: استُعملت إدارة الأعضاء (إيقاف أو نقل أو تعديل حساب في السجل) — سجل لا يُحذف بتراجع';
  end if;
end $$;

drop function if exists public.owner_decide_member_transfer(uuid, boolean, text, text);
drop function if exists public.owner_member_transfer_requests(text);
drop function if exists public.company_member_transfer_requests();
drop function if exists public.company_member_transfer_cancel(uuid);
drop function if exists public.company_member_transfer_request(uuid, text, text, uuid);
drop function if exists public.company_member_suspensions_list();
drop function if exists public.company_member_reactivate(uuid);
drop function if exists public.company_member_suspend(uuid, text);
drop function if exists public.company_member_password_reset_check(uuid);
drop function if exists public._company_member_account_apply(uuid, boolean, text);
drop function if exists public.company_member_account_check(uuid, text, text, text);
drop function if exists public.company_member_details(uuid);
drop function if exists public.company_member_profile_save(uuid, text, text, text, text);
drop function if exists public._member_transfer_expire();
drop function if exists public._member_mgmt_notify_owners();
drop function if exists public._company_resolve_ref(text);
drop function if exists public._company_member_account_scope(uuid, uuid);
drop function if exists public._company_member_require(uuid, boolean);
drop function if exists public._company_member_state(uuid, uuid);

drop table if exists public.company_member_transfer_requests;
drop table if exists public.company_member_account_changes;
drop table if exists public.company_member_suspensions;
drop table if exists public.company_member_profiles;
drop function if exists public._member_mgmt_no_delete();

alter table public.company_memberships drop constraint if exists company_memberships_joined_via_check;
alter table public.company_memberships add constraint company_memberships_joined_via_check
  check (joined_via in ('backfill', 'legacy', 'invitation', 'transfer', 'account_request'));

alter table public.company_memberships drop constraint if exists company_memberships_end_cause_check;
alter table public.company_memberships add constraint company_memberships_end_cause_check
  check (end_cause in ('left', 'removed', 'transferred', 'company_closed'));

alter table public.company_membership_events drop constraint if exists company_membership_events_action_check;
alter table public.company_membership_events add constraint company_membership_events_action_check
  check (action in ('joined', 'ended', 'primary_set', 'primary_unset',
                    'invited', 'invitation_accepted', 'invitation_declined',
                    'invitation_cancelled', 'context_set',
                    'transfer_requested', 'transferred_out', 'transferred_in'));

commit;
