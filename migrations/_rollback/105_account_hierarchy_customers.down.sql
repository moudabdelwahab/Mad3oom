-- ============================================================================
-- التراجع عن 105_account_hierarchy_customers — يحذف العلاقة المباشرة ومدير الحساب ودليل العملاء وطلبات
-- الحسابات، ويعيد قيدَي القدرات ومصدر العضوية، ويعيد حارس العزل كما كتبه 101 حرفيًا.
--
-- يُشغَّل في معاملة واحدة:
--   psql --single-transaction -v ON_ERROR_STOP=1 -f migrations/_rollback/105_account_hierarchy_customers.down.sql
-- يرفض (قبل أي تغيير) إن كان مفتاح التنفيذ مفعّلًا، أو وُجد أي سجل لا يُعاد بناؤه: طلب حساب، إسناد مدير حساب،
-- عضوية نشأت من طلب، تفويض customers.assign_manager، أو علاقة مباشرة منتهية. التاريخ لا يُحذف بتراجع.
-- العلاقات المباشرة النشطة مشتقة (ملء أولي + تسجيل) وتُحذف مع جدولها.
-- ============================================================================
do $$
begin
  -- أقفال أولًا: لا طلب ولا إسناد يُكتب بين الفحص والحذف (تبقى حتى نهاية المعاملة مع --single-transaction)
  lock table public.account_requests, public.customer_account_managers, public.platform_direct_customers,
             public.company_memberships, public.platform_capability_grants in exclusive mode;
  if exists (select 1 from public.platform_feature_switches where key = 'account_request_execution_enabled' and enabled) then
    raise exception 'التراجع عن 105 مرفوض: account_request_execution_enabled مفعّل — أطفئه أولًا';
  end if;
  if exists (select 1 from public.account_requests) then
    raise exception 'التراجع عن 105 مرفوض: توجد طلبات حسابات (سجل لا يُحذف)';
  end if;
  if exists (select 1 from public.customer_account_managers) then
    raise exception 'التراجع عن 105 مرفوض: يوجد سجل مديري حسابات';
  end if;
  if exists (select 1 from public.company_memberships where joined_via = 'account_request') then
    raise exception 'التراجع عن 105 مرفوض: عضويات نشأت من طلبات حسابات';
  end if;
  if exists (select 1 from public.platform_capability_grants where capability = 'customers.assign_manager') then
    raise exception 'التراجع عن 105 مرفوض: تفويض customers.assign_manager قائم — اسحبه أولًا';
  end if;
  if exists (select 1 from public.platform_direct_customers where ended_at is not null) then
    raise exception 'التراجع عن 105 مرفوض: علاقات مباشرة منتهية (سجل)';
  end if;
end $$;

-- حارس العزل كما في 101 حرفيًا
create or replace function public._guard_isolation_after_transfers()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if old.key in ('company_isolation_enforced', 'company_permissions_enabled') and old.enabled
     and (tg_op = 'DELETE' or not new.enabled or new.key is distinct from old.key)
     and (exists (select 1 from public.customer_transfers where status = 'completed')
          or exists (select 1 from public.ticket_carry_items)) then
    raise exception 'لا يُطفأ % بعد نقل عملاء أو نسخ تذاكر: المسار القديم يكشف بيانات شركة لأخرى', old.key
      using errcode = '55000', detail = '{"code":"transfers_exist"}';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

drop trigger if exists trg_direct_customer_on_signup on public.profiles;
drop trigger if exists trg_customer_relationships_on_profile on public.profiles;
drop trigger if exists trg_account_requests_company_deleted on public.companies;

drop function if exists public.account_requests_overview();
drop function if exists public.owner_decide_account_request(uuid, boolean, text);
drop function if exists public.owner_account_request_details(uuid);
drop function if exists public.owner_account_requests(jsonb);
drop function if exists public.my_account_requests(text);
drop function if exists public._account_request_row(public.account_requests);
drop function if exists public.account_request_cancel(uuid, text);
drop function if exists public.account_request_submit(text, uuid, text, text, uuid, text, uuid);
drop function if exists public._account_request_notify_owners();
drop function if exists public._account_request_execution(text, uuid);
drop function if exists public._account_request_first_failure(jsonb);
drop function if exists public._account_request_checks(text, uuid, text, text, uuid, uuid, uuid);
drop function if exists public._email_norm(text);
drop function if exists public.customer_manager_assign(uuid, uuid, text);
drop function if exists public.admin_customer_details(uuid);
drop function if exists public.admin_customer_filter_options();
drop function if exists public.admin_customer_directory(jsonb);
drop function if exists public._account_request_requester_ok();
drop function if exists public._profile_name(uuid);
drop function if exists public._can_assign_managers();
drop function if exists public._account_manager_eligible(uuid);
drop function if exists public._customer_directory_require();
drop function if exists public._customer_accounts(uuid);
drop function if exists public._account_requests_on_company_deleted();
drop function if exists public._customer_relationships_on_profile();
drop function if exists public._direct_customer_on_signup();

drop table if exists public.account_requests;
drop table if exists public.customer_account_managers;
drop table if exists public.platform_direct_customers;
drop function if exists public._customer_history_guard();

alter table public.company_memberships drop constraint if exists company_memberships_joined_via_check;
alter table public.company_memberships add constraint company_memberships_joined_via_check
  check (joined_via in ('backfill', 'legacy', 'invitation', 'transfer'));
alter table public.platform_capability_grants drop constraint if exists platform_capability_grants_capability_check;
alter table public.platform_capability_grants add constraint platform_capability_grants_capability_check
  check (capability = 'staff.support');

delete from public.platform_feature_switches where key = 'account_request_execution_enabled';
