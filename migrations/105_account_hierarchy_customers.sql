-- ============================================================================
-- 105_account_hierarchy_customers.sql
--   هيكل الحسابات وملكية العملاء: العلاقة المباشرة بالمنصة، مدير الحساب، دليل العملاء للإدارة،
--   وطلبات الحسابات بموافقة مالك المنصة.
--   المرجع: docs/tenancy/ACCOUNT_HIERARCHY_105.md (التدقيق والتصميم ومصفوفة الصلاحيات).
--
--   1) platform_direct_customers — «عميل مباشر للمنصة» علاقة صريحة، لا استنتاج من غياب اسم شركة أو
--      من super_user_id. تُملأ من الحسابات الفردية القائمة، ومن كل تسجيل جديد بلا شركة.
--      العلاقة مستقلة عن عضويات الشركات (096): عميل مباشر قد يكون عميلًا لشركة أيضًا.
--   2) customer_account_managers — «مدير الحساب» مسؤولية عمل لا صلاحية: لا تقرؤها أي سياسة وصول، ولا
--      تمنح مديرها أي اطلاع على بيانات العميل أو محادثاته أو بيانات شركة. إسناد بسجل كامل (لا حذف، لا
--      تعديل إلا إنهاء)، يمنحه المالك أو من فوّضه المالك بالقدرة customers.assign_manager.
--   3) admin_customer_directory / admin_customer_details — قراءة على الخادم بترقيم صفحات وفلاتر، لنفس من
--      يقرأ كل الحسابات اليوم (is_support_user: رتبة admin أو المالك في سياق الطاقم). لا وصول جديد.
--   4) account_requests — طلب «إضافة عميل قائم إلى شركة» أو «نقل عميل مباشر إلى شركة» يرسله إداري،
--      ويقرره مالك المنصة وحده بعد التحقق بخطوتين، ولا يوافق أحد على طلبه هو. الطلب لا يغيّر شيئًا؛ الموافقة
--      تعيد التحقق من كل شرط وتنفّذ ذريًا، أو تفشل كلها فيبقى الطلب معلّقًا. الطلب المُنهى ثابت.
--      • الإضافة إلى شركة: تنفيذ حقيقي عبر عضويات 096، لكنه مقفل خلف المفتاح الجديد
--        account_request_execution_enabled (مطفأ) **و** عزل الشركات وصلاحيات 098 — بدونهما يرى مالك الشركة
--        تذاكر العميل القديمة عبر super_user_id (نفس سبب اشتراط 101).
--      • النقل الكامل: **غير متاح بعد** (operation_not_available) — مسار الطلب والمراجعة فقط. انظر
--        docs/tenancy/CUSTOMER_TRANSFER_DESIGN.md.
--
-- لا مفتاح قائم يُفعَّل. المفتاح الجديد يبدأ مطفأً ويرفض الترحيل إن كان مفعّلًا. بلا مفاتيح خارجية إلى
-- الحسابات أو الشركات (اتفاقية 086/096/101/103): السجل يبقى بعد الحذف، والمحفّزات تُنهي ما كان نشطًا.
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/105_account_hierarchy_customers.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public._feature_on(text)', 'public.owner_capability(text)', 'public.owner_critical_ok()', 'public.has_capability(text)',
    'public.is_support_user()', 'public.is_platform_owner()', 'public.account_is_active()', 'public.preview_mode()',
    'public.is_banned(uuid)', 'public.log_privileged(text,uuid,jsonb,jsonb)', 'public._reason_check(text)',
    'public._membership_event(uuid,uuid,text,jsonb)', 'public._membership_apply_mirror(uuid)',
    'public._company_customer_active(uuid,uuid)', 'public._guard_isolation_after_transfers()'] loop
    if to_regprocedure(f) is null then
      raise exception '105 يتطلب % (104 وما قبله)', f;
    end if;
  end loop;
  if to_regclass('public.customer_transfers') is null or to_regclass('public.company_memberships') is null then
    raise exception '105 يتطلب 096 و101';
  end if;
  if exists (select 1 from public.platform_feature_switches where key = 'account_request_execution_enabled' and enabled) then
    raise exception '105: account_request_execution_enabled مفعّل — أطفئه قبل الترحيل';
  end if;
end $$;

insert into public.platform_feature_switches (key, enabled, description) values
  ('account_request_execution_enabled', false,
   'تنفيذ طلبات «إضافة عميل إلى شركة» بعد موافقة المالك (105). يتطلب أيضًا عزل الشركات وصلاحيات 098.')
on conflict (key) do nothing;

-- القدرة المفوَّضة الوحيدة الجديدة: إسناد مدير الحساب (لا تمس السلطة ولا الملكية ولا البيانات)
alter table public.platform_capability_grants drop constraint if exists platform_capability_grants_capability_check;
alter table public.platform_capability_grants add constraint platform_capability_grants_capability_check
  check (capability in ('staff.support', 'customers.assign_manager'));

-- مصدر عضوية جديد: موافقة المالك على طلب حساب. القيد يتسع ولا يضيق.
alter table public.company_memberships drop constraint if exists company_memberships_joined_via_check;
alter table public.company_memberships add constraint company_memberships_joined_via_check
  check (joined_via in ('backfill', 'legacy', 'invitation', 'transfer', 'account_request'));


-- ============================================================================
-- 1) الجداول
-- ============================================================================
create table if not exists public.platform_direct_customers (
  id        uuid primary key default gen_random_uuid(),
  -- بلا مفتاح خارجي عمدًا: السجل يبقى بعد حذف الحساب (المحفّز يُنهيه)
  user_id   uuid not null,
  since     timestamptz not null default now(),
  source    text not null check (source in ('backfill', 'signup')),
  ended_at  timestamptz,
  ended_by  uuid,
  end_cause text check (end_cause in ('account_deleted', 'transferred', 'company_created')),
  constraint platform_direct_customers_ended_iff check ((ended_at is null) = (end_cause is null))
);
comment on table public.platform_direct_customers is
  '105: علاقة «عميل مباشر للمنصة» صريحة. نشطة = ended_at فارغ. مستقلة عن عضويات الشركات. لا وصول مباشر.';
create unique index if not exists platform_direct_customers_one_active
  on public.platform_direct_customers (user_id) where ended_at is null;

create table if not exists public.customer_account_managers (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null,
  manager_id  uuid not null,
  -- 'company' محجوز لمدير حساب داخل شركة (لاحقًا): القيد يتسع حينها مع شرط company_id
  scope       text not null default 'platform' check (scope in ('platform')),
  company_id  uuid,
  assigned_by uuid not null,
  assigned_at timestamptz not null default now(),
  reason      text not null check (char_length(reason) between 10 and 500),
  ended_at    timestamptz,
  ended_by    uuid,
  end_cause   text check (end_cause in ('reassigned', 'unassigned', 'manager_ineligible', 'customer_deleted', 'manager_deleted')),
  constraint customer_account_managers_scope_company check ((scope = 'platform') = (company_id is null)),
  constraint customer_account_managers_not_self check (customer_id <> manager_id),
  constraint customer_account_managers_ended_iff check ((ended_at is null) = (end_cause is null))
);
comment on table public.customer_account_managers is
  '105: مدير الحساب — مسؤولية عمل لا صلاحية. لا سياسة وصول تقرؤه. سجل إلحاقي: الإسناد لا يُحذف ولا يُعدَّل إلا بإنهائه.';
create unique index if not exists customer_account_managers_one_active
  on public.customer_account_managers (customer_id, scope, coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where ended_at is null;
create index if not exists customer_account_managers_manager_active
  on public.customer_account_managers (manager_id) where ended_at is null;
create index if not exists customer_account_managers_customer
  on public.customer_account_managers (customer_id, assigned_at desc);

create table if not exists public.account_requests (
  id               uuid primary key default gen_random_uuid(),
  request_type     text not null check (request_type in ('add_to_company', 'transfer_direct_to_company')),
  -- هوية العميل الثابتة؛ البريد للتحقق فقط (لا يُبحث به ولا يُغيَّر)
  customer_id      uuid not null,
  customer_email   text not null check (char_length(customer_email) between 3 and 320),
  -- بريد مختلف يذكره مقدّم الطلب للعلم فقط — لا يُطبَّق على حساب الدخول أبدًا
  target_email     text check (target_email is null or char_length(target_email) between 3 and 320),
  company_id       uuid not null,
  reason           text not null check (char_length(reason) between 10 and 500),
  requested_by     uuid not null,
  requested_at     timestamptz not null default now(),
  idempotency_key  uuid not null,
  -- حال العميل والشركة وقت الإرسال (للمقارنة عند القرار)؛ لا يمنح شيئًا
  snapshot         jsonb not null default '{}'::jsonb,
  status           text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by       uuid,
  decided_at       timestamptz,
  decision_reason  text check (decision_reason is null or char_length(decision_reason) <= 500),
  outcome          jsonb,
  constraint account_requests_decided_iff check ((status = 'pending') = (decided_at is null)),
  -- لا موافقة ولا رفض من مقدّم الطلب نفسه، ولا قرار بلا صاحب
  constraint account_requests_no_self_decision check (
    status not in ('approved', 'rejected') or (decided_by is not null and decided_by <> requested_by)),
  constraint account_requests_reject_reason check (status not in ('rejected', 'cancelled') or decision_reason is not null),
  unique (requested_by, idempotency_key)
);
comment on table public.account_requests is
  '105: طلبات الحسابات (إضافة عميل إلى شركة / نقل عميل مباشر). القرار لمالك المنصة وحده. الطلب المُنهى ثابت. لا وصول مباشر.';
-- طلب معلّق واحد لكل عميل: يمنع طلبين متعارضين حتى مع ضغطتين متزامنتين
create unique index if not exists account_requests_one_pending
  on public.account_requests (customer_id) where status = 'pending';
create index if not exists account_requests_status_created on public.account_requests (status, requested_at desc);
create index if not exists account_requests_requester on public.account_requests (requested_by, requested_at desc);

do $$
declare t text;
begin
  foreach t in array array['platform_direct_customers', 'customer_account_managers', 'account_requests'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('drop policy if exists gate_account_active on public.%I', t);
    execute format('create policy gate_account_active on public.%I as restrictive for all to authenticated '
                   'using (public.account_is_active()) with check (public.account_is_active())', t);
  end loop;
end $$;


-- ============================================================================
-- 2) حرّاس السجل: لا حذف، ولا تعديل إلا إنهاء ما كان نشطًا (أو قرار طلب معلّق)
-- ============================================================================
create or replace function public._customer_history_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'سجل ثابت: لا يُحذف' using errcode = '55000', detail = '{"code":"history_immutable"}';
  end if;
  if tg_table_name = 'platform_direct_customers' then
    if old.ended_at is not null or new.id <> old.id or new.user_id <> old.user_id or new.since <> old.since
       or new.source <> old.source then
      raise exception 'العلاقة المباشرة لا تتغير إلا بإنهائها' using errcode = '55000', detail = '{"code":"history_immutable"}';
    end if;
  elsif tg_table_name = 'customer_account_managers' then
    if old.ended_at is not null or new.id <> old.id or new.customer_id <> old.customer_id
       or new.manager_id <> old.manager_id or new.scope <> old.scope
       or new.company_id is distinct from old.company_id or new.assigned_by <> old.assigned_by
       or new.assigned_at <> old.assigned_at or new.reason <> old.reason then
      raise exception 'إسناد مدير الحساب لا يتغير إلا بإنهائه' using errcode = '55000', detail = '{"code":"history_immutable"}';
    end if;
  else
    if old.status <> 'pending' then
      raise exception 'الطلب نهائي — أي تغيير يحتاج طلبًا جديدًا' using errcode = '55000', detail = '{"code":"request_final"}';
    end if;
    if (new.id, new.request_type, new.customer_id, new.customer_email, new.target_email, new.company_id, new.reason,
        new.requested_by, new.requested_at, new.idempotency_key, new.snapshot)
       is distinct from
       (old.id, old.request_type, old.customer_id, old.customer_email, old.target_email, old.company_id, old.reason,
        old.requested_by, old.requested_at, old.idempotency_key, old.snapshot) then
      raise exception 'بيانات الطلب لا تتغير — أي تغيير جوهري يحتاج طلبًا جديدًا' using errcode = '55000',
        detail = '{"code":"request_immutable"}';
    end if;
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['platform_direct_customers', 'customer_account_managers', 'account_requests'] loop
    execute format('drop trigger if exists trg_customer_history_guard on public.%I', t);
    execute format('create trigger trg_customer_history_guard before update or delete on public.%I '
                   'for each row execute function public._customer_history_guard()', t);
  end loop;
end $$;


-- ============================================================================
-- 3) العلاقة المباشرة: ملء أولي + كل تسجيل جديد بلا شركة
-- ============================================================================
-- الحساب الفردي القائم: رتبة user (أو customer: حساب مستقل أنشأه الطاقم، 035)، لا يتبع مالك شركة، ولا عضوية
-- نشطة له. (الإنتاج 2026-10-19: 33)
insert into public.platform_direct_customers (user_id, since, source)
select p.id, coalesce(p.created_at, now()), 'backfill'
  from public.profiles p
 where coalesce(p.role, 'user') in ('user', 'customer')
   and p.super_user_id is null
   and not exists (select 1 from public.company_memberships m where m.user_id = p.id and m.status = 'active')
   and not exists (select 1 from public.companies c where c.user_id = p.id)
   and not exists (select 1 from public.platform_direct_customers d where d.user_id = p.id and d.ended_at is null);

create or replace function public._direct_customer_on_signup()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  -- حساب أنشأته شركة أو برتبة طاقم: ليس عميلًا مباشرًا. create-sub-user يُنشئ الحساب أولًا (handle_new_user:
  -- رتبة user بلا super_user_id) ثم يربطه بالشركة؛ فيعلّمه بـ app_metadata.company_created (لا يكتبها إلا
  -- مفتاح الخدمة). وللنسخ المنشورة قبل هذه العلامة: الربط بالخدمة بعد الإنشاء مباشرة يُنهي العلاقة (القسم 9).
  if new.super_user_id is null and coalesce(new.role, 'user') in ('user', 'customer')
     and coalesce((select u.raw_app_meta_data ->> 'company_created' from auth.users u where u.id = new.id), '') <> 'true' then
    insert into public.platform_direct_customers (user_id, since, source)
    values (new.id, coalesce(new.created_at, now()), 'signup')
    on conflict do nothing;
  end if;
  return null;
end $$;
drop trigger if exists trg_direct_customer_on_signup on public.profiles;
create trigger trg_direct_customer_on_signup after insert on public.profiles
  for each row execute function public._direct_customer_on_signup();


-- ============================================================================
-- 4) تصنيف الحسابات (داخلي) — من العلاقات الصريحة وحدها
-- ============================================================================
--   platform_staff      رتبة platform_owner / admin / support
--   company_owner       يملك صف companies
--   company_staff       صف company_staff نشط بالشروط نفسها في _company_staff_role_of (086)
--   company_customer    عضوية نشطة (096) في شركة ليس مالكها ولا موظفًا فيها
--   direct              علاقة مباشرة نشطة
--   direct_and_company  الاثنان معًا
--   unclassified        لا علاقة صريحة (مثلًا: غادر شركته) — يُعرض كما هو ولا يُخمَّن
create or replace function public._customer_accounts(p_user uuid default null)
returns table (
  id uuid, full_name text, email text, phone text, whatsapp_phone text, created_at timestamptz, role text,
  banned boolean, is_direct boolean, direct_since timestamptz, direct_source text,
  owned_company_id uuid, staff_company_id uuid, staff_role text,
  primary_company_id uuid, member_company_ids uuid[], manager_id uuid, account_type text)
language sql
stable
security definer
set search_path to 'public'
as $$
  select p.id, p.full_name, p.email, p.phone, p.whatsapp_phone, p.created_at, p.role,
         public.is_banned(p.id),
         d.since is not null, d.since, d.source,
         oc.id, st.company_id, st.role,
         mem.primary_company_id, coalesce(mem.company_ids, '{}'::uuid[]), am.manager_id,
         case
           when p.role in ('platform_owner', 'admin', 'support') then 'platform_staff'
           when oc.id is not null then 'company_owner'
           when st.company_id is not null then 'company_staff'
           when d.since is not null and mem.company_ids is not null then 'direct_and_company'
           when mem.company_ids is not null then 'company_customer'
           when d.since is not null then 'direct'
           else 'unclassified'
         end
    from public.profiles p
    left join public.platform_direct_customers d on d.user_id = p.id and d.ended_at is null
    left join lateral (select c.id from public.companies c where c.user_id = p.id order by c.created_at, c.id limit 1) oc on true
    left join lateral (select s.company_id, s.role
                         from public.company_staff s join public.companies c on c.id = s.company_id
                        where s.user_id = p.id and s.revoked_at is null
                          and p.role = 'company_user' and p.super_user_id = c.user_id
                        limit 1) st on true
    left join lateral (select array_agg(m.company_id order by m.is_primary desc, m.joined_at) as company_ids,
                              (array_agg(m.company_id) filter (where m.is_primary))[1] as primary_company_id
                         from public.company_memberships m
                        where m.user_id = p.id and m.status = 'active'
                          and not exists (select 1 from public.companies c where c.id = m.company_id and c.user_id = p.id)
                          and not exists (select 1 from public.company_staff s
                                           where s.company_id = m.company_id and s.user_id = p.id and s.revoked_at is null)
                      ) mem on true
    left join public.customer_account_managers am
           on am.customer_id = p.id and am.scope = 'platform' and am.ended_at is null
   where p_user is null or p.id = p_user;
$$;

-- قارئ الدليل: نفس من يقرأ كل الحسابات اليوم (سياسة "Support can view all profiles")، بحساب نشط.
create or replace function public._customer_directory_require()
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null or not coalesce(public.account_is_active(), false) or not coalesce(public.is_support_user(), false) then
    raise exception 'دليل العملاء لفريق إدارة المنصة وحده' using errcode = '42501', detail = '{"code":"not_authorized"}';
  end if;
end $$;

-- مدير حساب مؤهَّل: من طاقم المنصة، غير محظور
create or replace function public._account_manager_eligible(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_user is not null and exists (
    select 1 from public.profiles p
     where p.id = p_user and p.role in ('admin', 'support', 'platform_owner') and not public.is_banned(p.id));
$$;

-- من يسند مدير الحساب: المالك (سياق المالك)، أو إداري فوّضه المالك بالقدرة customers.assign_manager
create or replace function public._can_assign_managers()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select auth.uid() is not null
     and coalesce(public.account_is_active(), false)
     and not coalesce(public.preview_mode(), true)
     and (coalesce(public.owner_capability('owner_only'), false)
          or coalesce(public.has_capability('customers.assign_manager'), false));
$$;

create or replace function public._profile_name(p_user uuid)
returns text
language sql
stable
security definer
set search_path to 'public'
as $$
  select case when p_user is null then null
              else coalesce((select coalesce(nullif(btrim(p.full_name), ''), p.email) from public.profiles p where p.id = p_user),
                            'حساب محذوف') end;
$$;


-- ============================================================================
-- 5) دليل العملاء (الخادم يفلتر ويرتّب ويقسّم الصفحات)
-- ============================================================================
create or replace function public.admin_customer_directory(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  f          jsonb := coalesce(p_filters, '{}'::jsonb);
  v_view     text := coalesce(nullif(f ->> 'view', ''), 'all');
  v_q        text := left(nullif(btrim(coalesce(f ->> 'q', '')), ''), 100);
  v_type     text := nullif(f ->> 'account_type', '');
  v_status   text := nullif(f ->> 'status', '');
  v_sort     text := coalesce(nullif(f ->> 'sort', ''), 'created_at');
  v_dir      text := coalesce(nullif(f ->> 'dir', ''), 'desc');
  v_company  uuid;
  v_manager  uuid;
  v_unassigned boolean := coalesce(f ->> 'manager_id', '') = 'none';
  v_limit    integer;
  v_offset   integer;
  v_like     text;
  v_qid      uuid;
  v_total    bigint;
  v_rows     jsonb;
begin
  perform public._customer_directory_require();
  if v_view not in ('all', 'direct', 'company', 'by_manager', 'pending_transfer', 'suspended')
     or (v_type is not null and v_type not in ('direct', 'company_customer', 'direct_and_company', 'company_owner',
                                               'company_staff', 'unclassified'))
     or (v_status is not null and v_status not in ('active', 'suspended'))
     or v_sort not in ('created_at', 'full_name', 'email') or v_dir not in ('asc', 'desc') then
    raise exception 'فلتر غير صالح' using errcode = '22023', detail = '{"code":"invalid_filter"}';
  end if;
  begin
    v_limit  := coalesce(nullif(f ->> 'limit', '')::integer, 25);
    v_offset := coalesce(nullif(f ->> 'offset', '')::integer, 0);
    v_company := nullif(f ->> 'company_id', '')::uuid;
    if not v_unassigned then
      v_manager := nullif(f ->> 'manager_id', '')::uuid;
    end if;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'فلتر غير صالح' using errcode = '22023', detail = '{"code":"invalid_filter"}';
  end;
  if v_limit < 1 or v_limit > 100 or v_offset < 0 or v_offset > 100000 then
    raise exception 'حجم الصفحة بين 1 و100' using errcode = '22023', detail = '{"code":"invalid_page"}';
  end if;
  if v_view = 'by_manager' and v_manager is null and not v_unassigned then
    raise exception 'اختر مدير الحساب (أو «بلا مدير»)' using errcode = '22023', detail = '{"code":"manager_required"}';
  end if;
  if v_q is not null then
    v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    if v_q ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_qid := v_q::uuid;
    end if;
  end if;

  with filtered as (
    select a.*
      from public._customer_accounts(null) a
     where a.account_type <> 'platform_staff'
       and (v_view <> 'direct' or a.account_type in ('direct', 'direct_and_company'))
       and (v_view <> 'company' or a.account_type in ('company_customer', 'direct_and_company'))
       and (v_view <> 'suspended' or a.banned)
       and (v_view <> 'pending_transfer'
            or exists (select 1 from public.customer_transfers x where x.customer_id = a.id and x.status = 'pending')
            or exists (select 1 from public.account_requests r where r.customer_id = a.id and r.status = 'pending'))
       and (v_type is null or a.account_type = v_type)
       and (v_status is null or (v_status = 'suspended') = a.banned)
       and (v_company is null or v_company = any (a.member_company_ids)
            or a.owned_company_id = v_company or a.staff_company_id = v_company)
       and (v_manager is null or a.manager_id = v_manager)
       and (not v_unassigned or a.manager_id is null)
       and (v_q is null or a.id = v_qid
            or a.email ilike v_like escape '\' or a.full_name ilike v_like escape '\'
            or a.phone ilike v_like escape '\' or a.whatsapp_phone ilike v_like escape '\')
  ),
  page as (
    select a.*, row_number() over (
             order by case when v_sort = 'created_at' and v_dir = 'asc'  then a.created_at end asc nulls last,
                      case when v_sort = 'created_at' and v_dir = 'desc' then a.created_at end desc nulls last,
                      case when v_sort = 'full_name'  and v_dir = 'asc'  then lower(a.full_name) end asc nulls last,
                      case when v_sort = 'full_name'  and v_dir = 'desc' then lower(a.full_name) end desc nulls last,
                      case when v_sort = 'email'      and v_dir = 'asc'  then lower(a.email) end asc nulls last,
                      case when v_sort = 'email'      and v_dir = 'desc' then lower(a.email) end desc nulls last,
                      a.id) as rn
      from filtered a
     order by rn
     limit v_limit offset v_offset
  )
  select (select count(*) from filtered),
         coalesce((select jsonb_agg(jsonb_build_object(
             'id', g.id,
             'full_name', g.full_name,
             'email', g.email,
             'phone', g.phone,
             -- رقم واتساب يُعرض فقط إن كان مخزّنًا فعلًا
             'whatsapp_phone', g.whatsapp_phone,
             'account_type', g.account_type,
             'company', (select jsonb_build_object('id', c.id, 'name', c.company_name)
                           from public.companies c
                          where c.id = coalesce(g.owned_company_id, g.staff_company_id, g.primary_company_id,
                                                g.member_company_ids[1])),
             'companies_count', cardinality(g.member_company_ids),
             'manager', case when g.manager_id is null then null
                             else jsonb_build_object('id', g.manager_id, 'name', public._profile_name(g.manager_id)) end,
             'status', case when g.banned then 'suspended' else 'active' end,
             'pending_transfer', exists (select 1 from public.customer_transfers x where x.customer_id = g.id and x.status = 'pending'),
             'pending_request', exists (select 1 from public.account_requests r where r.customer_id = g.id and r.status = 'pending'),
             'created_at', g.created_at) order by g.rn) from page g), '[]'::jsonb)
    into v_total, v_rows;

  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_offset, 'rows', v_rows);
end $$;

-- خيارات الفلاتر وقدرات المنادي (للواجهة وحدها — كل دالة تتحقق بنفسها)
create or replace function public.admin_customer_filter_options()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  perform public._customer_directory_require();
  return jsonb_build_object(
    'companies', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.company_name, 'status', c.status)
                                            order by c.company_name, c.id) from public.companies c), '[]'::jsonb),
    'managers', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', public._profile_name(p.id), 'role', p.role)
                                           order by lower(coalesce(p.full_name, p.email)), p.id)
                            from public.profiles p where public._account_manager_eligible(p.id)), '[]'::jsonb),
    'can_assign_manager', public._can_assign_managers(),
    'can_submit_request', public._account_request_requester_ok(),
    'is_owner', coalesce(public.owner_capability('owner_only'), false));
end $$;


-- ============================================================================
-- 6) تفاصيل العميل — من السجلات الفعلية وحدها (لا سجل مخترع من الحال الحالي)
-- ============================================================================
create or replace function public.admin_customer_details(p_customer uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  a record;
  p public.profiles;
begin
  perform public._customer_directory_require();
  if p_customer is null then
    raise exception 'الحساب غير موجود في دليل العملاء' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  select * into a from public._customer_accounts(p_customer);
  if a.id is null or a.account_type = 'platform_staff' then
    raise exception 'الحساب غير موجود في دليل العملاء' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  select * into p from public.profiles where id = p_customer;

  return jsonb_build_object(
    -- أعمدة مسمّاة فقط: لا أسرار تحقق ولا رموز استرداد ولا بيانات دخول
    'profile', jsonb_build_object(
      'id', p.id, 'full_name', p.full_name, 'email', p.email, 'phone', p.phone,
      'whatsapp_phone', p.whatsapp_phone, 'whatsapp_enabled', p.whatsapp_enabled,
      'is_verified', p.is_verified, 'created_at', p.created_at, 'updated_at', p.updated_at,
      'status', case when a.banned then 'suspended' else 'active' end, 'ban_until', case when a.banned then p.ban_until end),
    'account_type', a.account_type,
    'direct', case when a.is_direct then jsonb_build_object('since', a.direct_since, 'source', a.direct_source) end,
    -- اسم الشركة وحالتها فقط: بيانات تواصل الشركة تُعرض للمالك في تفاصيل الطلب، لا هنا
    'owned_company', (select jsonb_build_object('id', c.id, 'name', c.company_name, 'status', c.status)
                        from public.companies c where c.id = a.owned_company_id),
    'staff', case when a.staff_company_id is null then null
                  else jsonb_build_object('company_id', a.staff_company_id, 'role', a.staff_role,
                         'company_name', (select c.company_name from public.companies c where c.id = a.staff_company_id)) end,
    'memberships', coalesce((select jsonb_agg(jsonb_build_object(
                       'company_id', m.company_id, 'company_name', coalesce(c.company_name, 'شركة محذوفة'),
                       'is_primary', m.is_primary, 'status', m.status, 'joined_at', m.joined_at, 'joined_via', m.joined_via,
                       'ended_at', m.ended_at, 'end_cause', m.end_cause) order by m.joined_at desc)
                     from public.company_memberships m left join public.companies c on c.id = m.company_id
                    where m.user_id = p_customer), '[]'::jsonb),
    'manager', case when a.manager_id is null then null
                    else jsonb_build_object('id', a.manager_id, 'name', public._profile_name(a.manager_id)) end,
    'manager_history', coalesce((select jsonb_agg(jsonb_build_object(
                           'manager_id', h.manager_id, 'manager_name', public._profile_name(h.manager_id),
                           'assigned_by_name', public._profile_name(h.assigned_by), 'assigned_at', h.assigned_at,
                           'reason', h.reason, 'ended_at', h.ended_at, 'end_cause', h.end_cause) order by h.assigned_at desc)
                         from public.customer_account_managers h where h.customer_id = p_customer), '[]'::jsonb),
    'subscriptions', coalesce((select jsonb_agg(jsonb_build_object(
                         'plan', s.plan, 'status', s.status, 'billing_cycle', s.billing_cycle, 'start_date', s.start_date,
                         'end_date', s.end_date, 'company_name', c.company_name) order by s.start_date desc nulls last)
                       from public.whatsapp_subscriptions s left join public.companies c on c.id = s.company_id
                      where s.user_id = p_customer), '[]'::jsonb),
    'pending_transfers', (select count(*) from public.customer_transfers x where x.customer_id = p_customer and x.status = 'pending'),
    'requests', coalesce((select jsonb_agg(jsonb_build_object(
                    'id', r.id, 'request_type', r.request_type, 'status', r.status, 'requested_at', r.requested_at,
                    'company_name', coalesce(c.company_name, 'شركة محذوفة')) order by r.requested_at desc)
                  from public.account_requests r left join public.companies c on c.id = r.company_id
                 where r.customer_id = p_customer), '[]'::jsonb),
    -- السجل: أحداث العضويات (096) وسجل الامتيازات (053) كما هي — الفعل والفاعل والوقت، بلا القيم القديمة
    'history', coalesce((select jsonb_agg(e.item order by e.at desc) from (
                   select ev.created_at as at, jsonb_build_object('source', 'membership', 'action', ev.action,
                            'company_name', coalesce(c.company_name, 'شركة محذوفة'), 'actor_name', public._profile_name(ev.actor_id),
                            'at', ev.created_at) as item
                     from public.company_membership_events ev left join public.companies c on c.id = ev.company_id
                    where ev.user_id = p_customer
                   union all
                   select pa.at, jsonb_build_object('source', 'privileged', 'action', pa.action,
                            'actor_name', public._profile_name(pa.actor_id), 'at', pa.at)
                     from public.privileged_audit pa
                    -- سجل الامتيازات يقرؤه المالك وحده (privileged_audit_select_owner): لا يتسع هنا
                    where pa.target_user_id = p_customer and coalesce(public.owner_capability('owner_only'), false)
                    order by 1 desc limit 100) e), '[]'::jsonb),
    'history_note', case when coalesce(public.owner_capability('owner_only'), false)
                         then 'السجل يبدأ من تفعيل كل نظام: العضويات منذ 096، والامتيازات منذ 053، ومديرو الحساب منذ 105.'
                         else 'السجل يبدأ من تفعيل كل نظام: العضويات منذ 096، ومديرو الحساب منذ 105. سجل الامتيازات لمالك المنصة وحده.' end,
    'can_assign_manager', public._can_assign_managers(),
    'can_submit_request', public._account_request_requester_ok());
end $$;


-- ============================================================================
-- 7) إسناد مدير الحساب
-- ============================================================================
create or replace function public.customer_manager_assign(p_customer uuid, p_manager uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid    uuid := auth.uid();
  v_owner  boolean;
  v_reason text;
  v_kind   text;
  v_cur    public.customer_account_managers;
  v_new    uuid;
begin
  if v_uid is null or not public._can_assign_managers() then
    raise exception 'إسناد مدير الحساب للمالك أو لمن فوّضه' using errcode = '42501', detail = '{"code":"not_authorized"}';
  end if;
  v_owner := coalesce(public.owner_capability('owner_only'), false);
  v_reason := public._reason_check(p_reason);
  if p_customer is null then
    raise exception 'العميل مطلوب' using errcode = '22023', detail = '{"code":"customer_required"}';
  end if;
  if p_customer = v_uid then
    raise exception 'لا تُسند مديرًا لحسابك أنت' using errcode = '42501', detail = '{"code":"self_account"}';
  end if;
  -- القفل على حساب العميل يرتّب أي إسنادين متزامنين
  perform 1 from public.profiles where id = p_customer for update;
  if not found then
    raise exception 'العميل غير موجود' using errcode = 'P0002', detail = '{"code":"customer_not_found"}';
  end if;
  select a.account_type into v_kind from public._customer_accounts(p_customer) a;
  if v_kind in ('platform_staff', 'company_staff') then
    raise exception 'الحساب ليس حساب عميل' using errcode = '22023', detail = '{"code":"not_a_customer"}';
  end if;
  if p_manager is not null then
    if not public._account_manager_eligible(p_manager) then
      raise exception 'مدير الحساب يجب أن يكون من فريق المنصة وغير محظور' using errcode = '22023',
        detail = '{"code":"manager_not_eligible"}';
    end if;
    if p_manager = v_uid and not v_owner then
      raise exception 'لا تُسند نفسك مديرًا لحساب — يُسندك المالك أو مفوَّض آخر' using errcode = '42501',
        detail = '{"code":"self_assignment"}';
    end if;
  end if;

  select * into v_cur from public.customer_account_managers
   where customer_id = p_customer and scope = 'platform' and ended_at is null for update;
  if v_cur.manager_id is not distinct from p_manager then
    return jsonb_build_object('changed', false, 'manager_id', p_manager);
  end if;
  if v_cur.id is not null then
    update public.customer_account_managers
       set ended_at = now(), ended_by = v_uid, end_cause = case when p_manager is null then 'unassigned' else 'reassigned' end
     where id = v_cur.id;
  end if;
  if p_manager is not null then
    insert into public.customer_account_managers (customer_id, manager_id, assigned_by, reason)
    values (p_customer, p_manager, v_uid, v_reason)
    returning id into v_new;
    if p_manager <> v_uid then
      -- نص عام: لا اسم عميل ولا بريد (الإشعارات تقرؤها السلطة المرتفعة أيضًا)
      insert into public.notifications (user_id, title, message, type, link, category)
      values (p_manager, 'أُسند إليك عميل', 'أصبحت مدير حساب لعميل جديد. راجع «إدارة العملاء».', 'info',
              '/admin/customers.html', 'account');
    end if;
  end if;
  perform public.log_privileged('customer.account_manager.set', p_customer,
                                jsonb_build_object('manager_id', v_cur.manager_id),
                                jsonb_build_object('manager_id', p_manager, 'reason', v_reason));
  return jsonb_build_object('changed', true, 'manager_id', p_manager, 'assignment_id', v_new);
end $$;


-- ============================================================================
-- 8) طلبات الحسابات
-- ============================================================================
-- مقدّم الطلب: إداري منصة (رتبة admin) بحساب نشط، خارج المعاينة. المالك لا يقدّم (هو من يقرر وحده).
create or replace function public._account_request_requester_ok()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select auth.uid() is not null
     and coalesce(public.account_is_active(), false)
     and not coalesce(public.preview_mode(), true)
     and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
     and not coalesce(public.is_platform_owner(), false);
$$;

create or replace function public._email_norm(p text)
returns text
language sql
immutable
as $$ select nullif(lower(btrim(coalesce(p, ''))), '') $$;

-- كل شروط الطلب، تُحسب الآن (عند الإرسال وعند القرار ولعرض المالك). البريد للتحقق وحده.
create or replace function public._account_request_checks(p_type text, p_customer uuid, p_customer_email text,
                                                          p_target_email text, p_company uuid, p_exclude uuid default null,
                                                          p_requester uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  a        record;
  v_email  text := public._email_norm(p_customer_email);
  v_target text := public._email_norm(p_target_email);
  v_auth   text;
  v_prof   text;
  c        public.companies;
  r        jsonb := '[]'::jsonb;
begin
  select * into a from public._customer_accounts(p_customer);
  r := r || jsonb_build_object('code', 'customer_exists', 'ok', a.id is not null);
  if a.id is null then
    return r;
  end if;
  v_prof := public._email_norm(a.email);
  select public._email_norm(u.email) into v_auth from auth.users u where u.id = p_customer;
  -- بريد الملف وبريد الدخول يختلفان ⇒ التباس: يُوقف ولا يُخمَّن أيهما الصحيح
  r := r || jsonb_build_object('code', 'email_unambiguous', 'ok', v_prof is not null and (v_auth is null or v_auth = v_prof));
  r := r || jsonb_build_object('code', 'email_matches', 'ok', v_email is not null and v_email = v_prof);
  r := r || jsonb_build_object('code', 'target_email_valid', 'ok',
              v_target is null or v_target ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');
  -- بريد مختلف يخص حسابًا آخر ⇒ التباس في هوية العميل: يُوقف
  r := r || jsonb_build_object('code', 'target_email_unclaimed', 'ok',
              v_target is null or v_target = v_prof
              or not (exists (select 1 from public.profiles p where public._email_norm(p.email) = v_target and p.id <> p_customer)
                      or exists (select 1 from auth.users u where public._email_norm(u.email) = v_target and u.id <> p_customer)));
  r := r || jsonb_build_object('code', 'customer_is_customer', 'ok',
              a.account_type not in ('platform_staff', 'company_owner', 'company_staff'));
  r := r || jsonb_build_object('code', 'customer_active', 'ok', not a.banned);
  if p_type = 'transfer_direct_to_company' then
    r := r || jsonb_build_object('code', 'customer_is_direct', 'ok', a.account_type in ('direct', 'direct_and_company'));
  end if;
  select * into c from public.companies where id = p_company;
  r := r || jsonb_build_object('code', 'company_exists', 'ok', c.id is not null);
  r := r || jsonb_build_object('code', 'company_active', 'ok', c.id is not null and coalesce(c.status, 'active') = 'active');
  r := r || jsonb_build_object('code', 'not_company_owner', 'ok', c.id is null or c.user_id <> p_customer);
  r := r || jsonb_build_object('code', 'not_already_member', 'ok',
              not exists (select 1 from public.company_memberships m
                           where m.user_id = p_customer and m.company_id = p_company and m.status = 'active'));
  r := r || jsonb_build_object('code', 'no_pending_transfer', 'ok',
              not exists (select 1 from public.customer_transfers x where x.customer_id = p_customer and x.status = 'pending'));
  r := r || jsonb_build_object('code', 'no_conflicting_request', 'ok',
              not exists (select 1 from public.account_requests q
                           where q.customer_id = p_customer and q.status = 'pending' and q.id is distinct from p_exclude));
  -- عند القرار: مقدّم الطلب ما زال إداريًا غير محظور (طلب من أُقيل أو حُظر لا يُنفَّذ)
  if p_requester is not null then
    r := r || jsonb_build_object('code', 'requester_eligible', 'ok',
                exists (select 1 from public.profiles p where p.id = p_requester and p.role = 'admin' and not public.is_banned(p.id)));
  end if;
  return r;
end $$;

create or replace function public._account_request_first_failure(p_checks jsonb)
returns text
language sql
immutable
as $$
  select c ->> 'code' from jsonb_array_elements(p_checks) with ordinality as e(c, i)
   where not (c ->> 'ok')::boolean order by i limit 1;
$$;

-- هل يمكن تنفيذ الطلب الآن؟ (لا يمنح شيئًا: القرار يتحقق بنفسه)
create or replace function public._account_request_execution(p_type text, p_customer uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_missing text[] := '{}';
begin
  if p_type = 'transfer_direct_to_company' then
    return jsonb_build_object('available', false, 'code', 'operation_not_available', 'missing', '[]'::jsonb);
  end if;
  if not public._feature_on('account_request_execution_enabled') then
    v_missing := array_append(v_missing, 'account_request_execution_enabled');
  end if;
  -- بلا العزل وصلاحيات 098 يرى مالك الشركة تذاكر العميل القديمة عبر super_user_id (كما في 101)
  if not public._feature_on('company_isolation_enforced') then
    v_missing := array_append(v_missing, 'company_isolation_enforced');
  end if;
  if not public._feature_on('company_permissions_enabled') then
    v_missing := array_append(v_missing, 'company_permissions_enabled');
  end if;
  -- عضوية إضافية (للعميل شركة أساسية) لا معنى لها قبل تعدد الشركات
  if p_customer is not null
     and exists (select 1 from public.company_memberships m where m.user_id = p_customer and m.status = 'active' and m.is_primary)
     and not public._feature_on('multi_company_memberships_enabled') then
    v_missing := array_append(v_missing, 'multi_company_memberships_enabled');
  end if;
  return jsonb_build_object('available', cardinality(v_missing) = 0,
                            'code', case when cardinality(v_missing) = 0 then null else 'prerequisite_not_enabled' end,
                            'missing', to_jsonb(v_missing));
end $$;

create or replace function public._account_request_notify_owners()
returns void
language sql
security definer
set search_path to 'public'
as $$
  -- نص عام: لا اسم عميل ولا بريد ولا شركة
  insert into public.notifications (user_id, title, message, type, link, category)
  select a.user_id, 'طلب حساب جديد', 'طلب من فريق المنصة بانتظار قرارك في «طلبات الحسابات».', 'info',
         '/admin/account-requests.html', 'account'
    from public.platform_authority a join public.profiles p on p.id = a.user_id
   where a.level = 'owner' and p.role = 'platform_owner';
$$;

create or replace function public.account_request_submit(p_type text, p_customer uuid, p_customer_email text,
                                                         p_target_email text, p_company uuid, p_reason text,
                                                         p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid    uuid := auth.uid();
  v_reason text;
  v_target text := public._email_norm(p_target_email);
  v_checks jsonb;
  v_fail   text;
  x        public.account_requests;
  a        record;
begin
  if not public._account_request_requester_ok() then
    raise exception 'طلبات الحسابات يرسلها فريق إدارة المنصة' using errcode = '42501', detail = '{"code":"not_authorized"}';
  end if;
  if p_type is null or p_type not in ('add_to_company', 'transfer_direct_to_company') then
    raise exception 'نوع الطلب غير معروف' using errcode = '22023', detail = '{"code":"invalid_type"}';
  end if;
  if p_idempotency_key is null or p_customer is null or p_company is null then
    raise exception 'العميل والشركة ومفتاح منع التكرار مطلوبة' using errcode = '22023', detail = '{"code":"missing_field"}';
  end if;
  v_reason := public._reason_check(p_reason);

  -- إعادة الإرسال بنفس المفتاح: نفس الطلب، أو رفض إن اختلفت بياناته
  select * into x from public.account_requests where requested_by = v_uid and idempotency_key = p_idempotency_key;
  if x.id is not null then
    if x.request_type = p_type and x.customer_id = p_customer and x.company_id = p_company
       and x.customer_email = public._email_norm(p_customer_email) and x.target_email is not distinct from v_target then
      return jsonb_build_object('request_id', x.id, 'status', x.status, 'replayed', true);
    end if;
    raise exception 'مفتاح منع التكرار استُخدم لطلب مختلف' using errcode = '22023', detail = '{"code":"idempotency_conflict"}';
  end if;

  perform 1 from public.profiles where id = p_customer for update;
  v_checks := public._account_request_checks(p_type, p_customer, p_customer_email, p_target_email, p_company);
  v_fail := public._account_request_first_failure(v_checks);
  if v_fail is not null then
    raise exception 'تعذّر إرسال الطلب: %', v_fail
      using errcode = case when v_fail in ('customer_exists', 'company_exists') then 'P0002'
                           when v_fail in ('no_conflicting_request', 'no_pending_transfer') then '23505'
                           else '22023' end,
            detail = jsonb_build_object('code', v_fail)::text;
  end if;

  select * into a from public._customer_accounts(p_customer);
  begin
    insert into public.account_requests (request_type, customer_id, customer_email, target_email, company_id, reason,
                                         requested_by, idempotency_key, snapshot)
    values (p_type, p_customer, public._email_norm(p_customer_email),
            case when v_target = public._email_norm(a.email) then null else v_target end,
            p_company, v_reason, v_uid, p_idempotency_key,
            jsonb_build_object('account_type', a.account_type, 'is_direct', a.is_direct,
                               'primary_company_id', a.primary_company_id, 'member_company_ids', to_jsonb(a.member_company_ids)))
    returning * into x;
  exception when unique_violation then
    -- ضغطتان متزامنتان بنفس المفتاح: الثانية تعيد الطلب نفسه
    select * into x from public.account_requests where requested_by = v_uid and idempotency_key = p_idempotency_key;
    if x.id is not null then
      return jsonb_build_object('request_id', x.id, 'status', x.status, 'replayed', true);
    end if;
    raise exception 'تعذّر إرسال الطلب: no_conflicting_request' using errcode = '23505',
      detail = '{"code":"no_conflicting_request"}';
  end;
  perform public.log_privileged('account_request.submitted', p_customer, null,
                                jsonb_build_object('request_id', x.id, 'type', p_type, 'company_id', p_company));
  perform public._account_request_notify_owners();
  return jsonb_build_object('request_id', x.id, 'status', 'pending', 'replayed', false);
end $$;

create or replace function public.account_request_cancel(p_request uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  x public.account_requests;
  v_reason text;
begin
  if not public._account_request_requester_ok() then
    raise exception 'غير مصرّح' using errcode = '42501', detail = '{"code":"not_authorized"}';
  end if;
  v_reason := public._reason_check(p_reason);
  select * into x from public.account_requests where id = p_request and requested_by = auth.uid() for update;
  if x.id is null then
    raise exception 'الطلب غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  if x.status <> 'pending' then
    raise exception 'الطلب نهائي' using errcode = '55000', detail = '{"code":"request_final"}';
  end if;
  update public.account_requests
     set status = 'cancelled', decided_by = auth.uid(), decided_at = now(), decision_reason = v_reason
   where id = x.id;
  perform public.log_privileged('account_request.cancelled', x.customer_id, null, jsonb_build_object('request_id', x.id));
  return jsonb_build_object('request_id', x.id, 'status', 'cancelled');
end $$;

create or replace function public._account_request_row(r public.account_requests)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'id', r.id, 'request_type', r.request_type, 'status', r.status,
    'customer_id', r.customer_id, 'customer_name', public._profile_name(r.customer_id), 'customer_email', r.customer_email,
    'target_email', r.target_email,
    'company_id', r.company_id, 'company_name', coalesce((select c.company_name from public.companies c where c.id = r.company_id), 'شركة محذوفة'),
    'reason', r.reason, 'requested_by', r.requested_by, 'requester_name', public._profile_name(r.requested_by),
    'requested_at', r.requested_at, 'decided_by_name', public._profile_name(r.decided_by), 'decided_at', r.decided_at,
    'decision_reason', r.decision_reason, 'outcome', r.outcome);
$$;

-- طلباتي (مقدّم الطلب، ما دام إداريًا)
create or replace function public.my_account_requests(p_status text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public._account_request_requester_ok() then
    raise exception 'غير مصرّح' using errcode = '42501', detail = '{"code":"not_authorized"}';
  end if;
  if p_status is not null and p_status not in ('pending', 'approved', 'rejected', 'cancelled') then
    raise exception 'حالة غير صالحة' using errcode = '22023', detail = '{"code":"invalid_filter"}';
  end if;
  return coalesce((select jsonb_agg(public._account_request_row(r) order by r.requested_at desc)
                     from (select * from public.account_requests r
                            where r.requested_by = auth.uid() and (p_status is null or r.status = p_status)
                            order by r.requested_at desc limit 200) r), '[]'::jsonb);
end $$;

-- صندوق المالك
create or replace function public.owner_account_requests(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  f         jsonb := coalesce(p_filters, '{}'::jsonb);
  v_status  text := nullif(f ->> 'status', '');
  v_type    text := nullif(f ->> 'request_type', '');
  v_email   text := public._email_norm(f ->> 'customer_email');
  v_req     uuid;
  v_company uuid;
  v_from    timestamptz;
  v_to      timestamptz;
  v_limit   integer;
  v_offset  integer;
  v_like    text;
  v_total   bigint;
  v_rows    jsonb;
begin
  if auth.uid() is null or not coalesce(public.account_is_active(), false)
     or not coalesce(public.owner_capability('owner_only'), false) then
    raise exception 'صندوق طلبات الحسابات لمالك المنصة وحده' using errcode = '42501', detail = '{"code":"not_authorized"}';
  end if;
  if (v_status is not null and v_status not in ('pending', 'approved', 'rejected', 'cancelled'))
     or (v_type is not null and v_type not in ('add_to_company', 'transfer_direct_to_company')) then
    raise exception 'فلتر غير صالح' using errcode = '22023', detail = '{"code":"invalid_filter"}';
  end if;
  begin
    v_req     := nullif(f ->> 'requested_by', '')::uuid;
    v_company := nullif(f ->> 'company_id', '')::uuid;
    v_from    := nullif(f ->> 'from', '')::timestamptz;
    v_to      := nullif(f ->> 'to', '')::timestamptz;
    v_limit   := coalesce(nullif(f ->> 'limit', '')::integer, 25);
    v_offset  := coalesce(nullif(f ->> 'offset', '')::integer, 0);
  exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow
                 or numeric_value_out_of_range then
    raise exception 'فلتر غير صالح' using errcode = '22023', detail = '{"code":"invalid_filter"}';
  end;
  if v_limit < 1 or v_limit > 100 or v_offset < 0 or v_offset > 100000 then
    raise exception 'حجم الصفحة بين 1 و100' using errcode = '22023', detail = '{"code":"invalid_page"}';
  end if;
  if v_email is not null then
    v_like := '%' || replace(replace(replace(left(v_email, 100), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  with filtered as (
    select r.* from public.account_requests r
     where (v_status is null or r.status = v_status)
       and (v_type is null or r.request_type = v_type)
       and (v_req is null or r.requested_by = v_req)
       and (v_company is null or r.company_id = v_company)
       and (v_like is null or r.customer_email like v_like escape '\')
       and (v_from is null or r.requested_at >= v_from)
       and (v_to is null or r.requested_at < v_to)
  ), page as (
    select * from filtered order by requested_at desc, id limit v_limit offset v_offset
  )
  select (select count(*) from filtered),
         coalesce((select jsonb_agg(public._account_request_row(g) order by g.requested_at desc, g.id) from page g), '[]'::jsonb)
    into v_total, v_rows;

  return jsonb_build_object(
    'total', v_total, 'limit', v_limit, 'offset', v_offset, 'rows', v_rows,
    'pending_count', (select count(*) from public.account_requests where status = 'pending'),
    'requesters', coalesce((select jsonb_agg(jsonb_build_object('id', q.requested_by, 'name', public._profile_name(q.requested_by)))
                              from (select distinct requested_by from public.account_requests) q), '[]'::jsonb));
end $$;

-- تفاصيل الطلب للمالك: البيانات + ملخص الأثر + نتيجة إعادة التحقق الآن + إمكان التنفيذ
create or replace function public.owner_account_request_details(p_request uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  r public.account_requests;
  a record;
  c public.companies;
begin
  if auth.uid() is null or not coalesce(public.account_is_active(), false)
     or not coalesce(public.owner_capability('owner_only'), false) then
    raise exception 'صندوق طلبات الحسابات لمالك المنصة وحده' using errcode = '42501', detail = '{"code":"not_authorized"}';
  end if;
  select * into r from public.account_requests where id = p_request;
  if r.id is null then
    raise exception 'الطلب غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  select * into a from public._customer_accounts(r.customer_id);
  select * into c from public.companies where id = r.company_id;
  return public._account_request_row(r) || jsonb_build_object(
    'snapshot', r.snapshot,
    'customer_now', case when a.id is null then null else jsonb_build_object(
        'account_type', a.account_type, 'email', a.email, 'status', case when a.banned then 'suspended' else 'active' end,
        'is_direct', a.is_direct,
        'companies', coalesce((select jsonb_agg(jsonb_build_object('id', m.company_id, 'name', co.company_name, 'is_primary', m.is_primary)
                                                order by m.is_primary desc)
                                 from public.company_memberships m join public.companies co on co.id = m.company_id
                                where m.user_id = r.customer_id and m.status = 'active' and m.company_id = any (a.member_company_ids)), '[]'::jsonb),
        'open_tickets', (select count(*) from public.tickets t where t.user_id = r.customer_id and t.status in ('open', 'in-progress')),
        'active_subscriptions', (select count(*) from public.whatsapp_subscriptions s where s.user_id = r.customer_id and s.status = 'active'),
        'has_primary_company', a.primary_company_id is not null) end,
    -- بريد التواصل الخاص بالشركة يُعرض منفصلًا عن بريد العميل
    'company', case when c.id is null then null else jsonb_build_object(
        'id', c.id, 'name', c.company_name, 'contact_email', c.company_email, 'status', c.status,
        'owner_name', public._profile_name(c.user_id)) end,
    'checks', case when r.status = 'pending'
                   then public._account_request_checks(r.request_type, r.customer_id, r.customer_email, r.target_email,
                                                       r.company_id, r.id, r.requested_by) end,
    'execution', case when r.status = 'pending' then public._account_request_execution(r.request_type, r.customer_id) end,
    'self_requested', r.requested_by = auth.uid(),
    'can_decide', r.status = 'pending' and r.requested_by <> auth.uid() and coalesce(public.owner_critical_ok(), false));
end $$;

create or replace function public.owner_decide_account_request(p_request uuid, p_approve boolean, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid     uuid := auth.uid();
  r         public.account_requests;
  v_reason  text;
  v_exec    jsonb;
  v_fail    text;
  v_primary boolean;
  v_mid     uuid;
  v_owner   uuid;
  v_ids     record;
begin
  if v_uid is null or not coalesce(public.account_is_active(), false) or coalesce(public.preview_mode(), true) then
    raise exception 'غير مصرّح' using errcode = '42501', detail = '{"code":"not_authorized"}';
  end if;
  if not coalesce(public.owner_critical_ok(), false) then
    raise exception 'القرار لمالك المنصة وحده بعد التحقق بخطوتين' using errcode = '42501', detail = '{"code":"step_up_required"}';
  end if;
  if p_approve is null then
    raise exception 'القرار مطلوب' using errcode = '22023', detail = '{"code":"decision_required"}';
  end if;
  -- ترتيب الأقفال ثابت: الشركة ← حساب العميل ← الطلب — نفس ترتيب حذف الشركة أو الحساب (يقفلان صفّهما ثم
  -- يلغيان الطلب المعلّق بمحفّز)، فلا قفل متبادل. الشركة بقفل مشترك: لا إيقاف ولا حذف أثناء القرار.
  select customer_id, company_id into v_ids from public.account_requests where id = p_request;
  perform 1 from public.companies where id = v_ids.company_id for share;
  perform 1 from public.profiles where id = v_ids.customer_id for update;
  -- القفل يرتّب قرارين متزامنين؛ الثاني يجد الطلب نهائيًا
  select * into r from public.account_requests where id = p_request for update;
  if r.id is null then
    raise exception 'الطلب غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  if r.status <> 'pending' then
    raise exception 'الطلب نهائي' using errcode = '55000', detail = '{"code":"request_final"}';
  end if;
  if r.requested_by = v_uid then
    raise exception 'لا قرار على طلبك أنت' using errcode = '42501', detail = '{"code":"self_approval"}';
  end if;

  if not p_approve then
    v_reason := public._reason_check(p_reason);
    update public.account_requests
       set status = 'rejected', decided_by = v_uid, decided_at = now(), decision_reason = v_reason
     where id = r.id;
    perform public.log_privileged('account_request.rejected', r.customer_id, null,
                                  jsonb_build_object('request_id', r.id, 'reason', v_reason));
    insert into public.notifications (user_id, title, message, type, link, category)
    values (r.requested_by, 'صدر قرار في طلب حساب', 'قرّر مالك المنصة أحد طلباتك. راجع «طلباتي» لمعرفة القرار.', 'info',
            '/admin/account-requests.html', 'account');
    return jsonb_build_object('request_id', r.id, 'status', 'rejected');
  end if;

  -- الموافقة = التنفيذ. ما لا يمكن تنفيذه لا يُوافَق عليه: يبقى الطلب معلّقًا.
  -- قفل مشترك على مفاتيح التنفيذ: إطفاء العزل في اللحظة نفسها ينتظر هذه المعاملة ثم يرى الموافقة فيرفضه الحارس
  perform 1 from public.platform_feature_switches
   where key in ('account_request_execution_enabled', 'company_isolation_enforced', 'company_permissions_enabled',
                 'multi_company_memberships_enabled')
   for share;
  v_exec := public._account_request_execution(r.request_type, r.customer_id);
  if not coalesce((v_exec ->> 'available')::boolean, false) then
    raise exception 'لا يمكن تنفيذ هذا الطلب بعد (%) — يبقى معلّقًا', v_exec ->> 'code'
      using errcode = '0A000', detail = jsonb_build_object('code', v_exec ->> 'code', 'missing', v_exec -> 'missing')::text;
  end if;

  v_fail := public._account_request_first_failure(
              public._account_request_checks(r.request_type, r.customer_id, r.customer_email, r.target_email, r.company_id, r.id,
                                             r.requested_by));
  if v_fail is not null then
    raise exception 'تغيّر حال العميل أو الشركة منذ الطلب (%) — لم يُنفَّذ شيء', v_fail
      using errcode = '55000', detail = jsonb_build_object('code', 'revalidation_failed', 'check', v_fail)::text;
  end if;

  -- التنفيذ (add_to_company): عضوية عميل عبر 096. الأساسية إن لم تكن له شركة أساسية، وإلا إضافية.
  v_primary := not exists (select 1 from public.company_memberships m
                            where m.user_id = r.customer_id and m.status = 'active' and m.is_primary);
  insert into public.company_memberships (company_id, user_id, is_primary, joined_via)
  values (r.company_id, r.customer_id, v_primary, 'account_request')
  returning id into v_mid;
  perform public._membership_event(r.company_id, r.customer_id, 'joined',
                                   jsonb_build_object('via', 'account_request', 'request_id', r.id, 'primary', v_primary));
  if v_primary then
    perform public._membership_apply_mirror(r.customer_id);
  end if;
  -- تحقق النتيجة قبل وسم الطلب: أي انحراف يُلغي المعاملة كلها
  select user_id into v_owner from public.companies where id = r.company_id;
  if not public._company_customer_active(r.company_id, r.customer_id)
     or (v_primary and (select p.super_user_id from public.profiles p where p.id = r.customer_id) is distinct from v_owner) then
    raise exception 'تعذّر التنفيذ — لم يُنفَّذ شيء' using errcode = '55000', detail = '{"code":"execution_failed"}';
  end if;

  v_reason := nullif(left(btrim(coalesce(p_reason, '')), 500), '');
  update public.account_requests
     set status = 'approved', decided_by = v_uid, decided_at = now(), decision_reason = v_reason,
         outcome = jsonb_build_object('membership_id', v_mid, 'primary', v_primary)
   where id = r.id;
  perform public.log_privileged('account_request.approved', r.customer_id, null,
                                jsonb_build_object('request_id', r.id, 'company_id', r.company_id, 'membership_id', v_mid,
                                                   'primary', v_primary));
  insert into public.notifications (user_id, title, message, type, link, category)
  values (r.requested_by, 'صدر قرار في طلب حساب', 'قرّر مالك المنصة أحد طلباتك. راجع «طلباتي» لمعرفة القرار.', 'info',
          '/admin/account-requests.html', 'account'),
         (r.customer_id, 'أُضيف حسابك إلى شركة', 'أصبح حسابك عضوًا في شركة على مدعوم. تذاكرك السابقة تبقى خاصة بك.', 'info',
          null, 'account');
  return jsonb_build_object('request_id', r.id, 'status', 'approved', 'membership_id', v_mid, 'primary', v_primary);
end $$;

-- حال طلبات الحسابات للواجهة (لا يمنح شيئًا)
create or replace function public.account_requests_overview()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select case when auth.uid() is null
                   or not (coalesce(public.is_support_user(), false) or coalesce(public.owner_capability('owner_only'), false))
              then null
              else jsonb_build_object(
                'can_submit', public._account_request_requester_ok(),
                'is_owner', coalesce(public.owner_capability('owner_only'), false),
                'owner_step_up', coalesce(public.owner_critical_ok(), false),
                'execution', jsonb_build_object(
                  'add_to_company', public._account_request_execution('add_to_company', null),
                  'transfer_direct_to_company', public._account_request_execution('transfer_direct_to_company', null))) end;
$$;


-- ============================================================================
-- 9) الحذف وفقد الأهلية: ينهي ما كان نشطًا ويبقى السجل
-- ============================================================================
create or replace function public._customer_relationships_on_profile()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if tg_op = 'DELETE' then
    update public.platform_direct_customers set ended_at = now(), ended_by = auth.uid(), end_cause = 'account_deleted'
     where user_id = old.id and ended_at is null;
    update public.customer_account_managers set ended_at = now(), ended_by = auth.uid(), end_cause = 'customer_deleted'
     where customer_id = old.id and ended_at is null;
    update public.customer_account_managers set ended_at = now(), ended_by = auth.uid(), end_cause = 'manager_deleted'
     where manager_id = old.id and ended_at is null;
    update public.account_requests set status = 'cancelled', decided_at = now(), decision_reason = 'account_deleted'
     where status = 'pending' and (customer_id = old.id or requested_by = old.id);
    return old;
  end if;
  if not public._account_manager_eligible(new.id) then
    update public.customer_account_managers set ended_at = now(), ended_by = auth.uid(), end_cause = 'manager_ineligible'
     where manager_id = new.id and ended_at is null;
  end if;
  -- مقدّم طلب لم يعد إداريًا أو حُظر: طلباته المعلّقة تُلغى (لا تُنفَّذ باسمه ولا تبقى بلا من يلغيها)
  if new.role is distinct from 'admin' or public.is_banned(new.id) then
    update public.account_requests set status = 'cancelled', decided_at = now(), decision_reason = 'requester_ineligible'
     where status = 'pending' and requested_by = new.id;
  end if;
  -- create-sub-user قبل علامة company_created: الخدمة (بلا مستخدم) تربط الحساب بشركة بعد إنشائه مباشرة ⇒ لم يكن
  -- عميلًا مباشرًا قط. مسار الإدارة العليا (بمستخدم) ومرآة 096 لا يمرّان من هنا.
  if old.super_user_id is null and new.super_user_id is not null and auth.uid() is null
     and coalesce(current_setting('app.membership_sync', true), '') <> 'on' then
    update public.platform_direct_customers set ended_at = now(), end_cause = 'company_created'
     where user_id = new.id and ended_at is null and source = 'signup' and since > now() - interval '15 minutes';
  end if;
  return new;
end $$;
drop trigger if exists trg_customer_relationships_on_profile on public.profiles;
create trigger trg_customer_relationships_on_profile
  after update of role, ban_status, ban_until, super_user_id or delete on public.profiles
  for each row execute function public._customer_relationships_on_profile();

create or replace function public._account_requests_on_company_deleted()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update public.account_requests set status = 'cancelled', decided_at = now(), decision_reason = 'company_deleted'
   where status = 'pending' and company_id = old.id;
  return old;
end $$;
drop trigger if exists trg_account_requests_company_deleted on public.companies;
create trigger trg_account_requests_company_deleted after delete on public.companies
  for each row execute function public._account_requests_on_company_deleted();


-- ============================================================================
-- 10) بعد إضافة عميل بطلب صار super_user_id يشير إلى الشركة: العزل و098 لا يُطفآن بعدها (امتداد لـ 101)
-- ============================================================================
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
          or exists (select 1 from public.ticket_carry_items)
          or exists (select 1 from public.account_requests where status = 'approved')) then
    raise exception 'لا يُطفأ % بعد نقل عملاء أو نسخ تذاكر: المسار القديم يكشف بيانات شركة لأخرى', old.key
      using errcode = '55000', detail = '{"code":"transfers_exist"}';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;


-- ============================================================================
-- 11) الامتيازات
-- ============================================================================
do $$
declare f text;
begin
  -- داخلية: لا ينادِيها أحد مباشرة
  foreach f in array array[
    'public._customer_history_guard()', 'public._direct_customer_on_signup()', 'public._customer_accounts(uuid)',
    'public._customer_directory_require()', 'public._account_manager_eligible(uuid)', 'public._can_assign_managers()',
    'public._profile_name(uuid)', 'public._account_request_requester_ok()', 'public._email_norm(text)',
    'public._account_request_checks(text,uuid,text,text,uuid,uuid,uuid)', 'public._account_request_first_failure(jsonb)',
    'public._account_request_execution(text,uuid)', 'public._account_request_notify_owners()',
    'public._account_request_row(public.account_requests)', 'public._customer_relationships_on_profile()',
    'public._account_requests_on_company_deleted()'] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
  -- واجهات: لمستخدم مسجَّل، وكل دالة تتحقق من المنادي بنفسها
  foreach f in array array[
    'public.admin_customer_directory(jsonb)', 'public.admin_customer_filter_options()', 'public.admin_customer_details(uuid)',
    'public.customer_manager_assign(uuid,uuid,text)',
    'public.account_request_submit(text,uuid,text,text,uuid,text,uuid)', 'public.account_request_cancel(uuid,text)',
    'public.my_account_requests(text)', 'public.owner_account_requests(jsonb)', 'public.owner_account_request_details(uuid)',
    'public.owner_decide_account_request(uuid,boolean,text)', 'public.account_requests_overview()'] loop
    execute format('revoke all on function %s from public, anon, service_role', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;


-- ============================================================================
-- 12) تحقق ذاتي
-- ============================================================================
do $$
begin
  if exists (select 1 from public.platform_feature_switches where key = 'account_request_execution_enabled' and enabled) then
    raise exception '105: account_request_execution_enabled مفعّل';
  end if;
  -- مدير الحساب ليس صلاحية: لا سياسة وصول تقرأ الجداول الجديدة
  if exists (select 1 from pg_policies
              where coalesce(qual, '') || coalesce(with_check, '') ~ '\m(customer_account_managers|platform_direct_customers|account_requests)\M') then
    raise exception '105: سياسة وصول تعتمد على مدير الحساب أو طلبات الحسابات';
  end if;
  if exists (select 1 from pg_constraint
              where contype = 'f'
                and conrelid in ('public.platform_direct_customers'::regclass, 'public.customer_account_managers'::regclass,
                                 'public.account_requests'::regclass)) then
    raise exception '105: مفتاح خارجي من سجل 105';
  end if;
  if has_table_privilege('authenticated', 'public.account_requests', 'select')
     or has_table_privilege('authenticated', 'public.customer_account_managers', 'select')
     or has_table_privilege('authenticated', 'public.platform_direct_customers', 'select')
     or has_table_privilege('anon', 'public.account_requests', 'select') then
    raise exception '105: جدول مفتوح للقراءة المباشرة';
  end if;
  if has_function_privilege('authenticated', 'public._customer_accounts(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public._account_request_checks(text,uuid,text,text,uuid,uuid,uuid)', 'execute')
     or has_function_privilege('anon', 'public.admin_customer_directory(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.owner_decide_account_request(uuid,boolean,text)', 'execute') then
    raise exception '105: دالة داخلية أو واجهة مفتوحة لغير المسجَّل';
  end if;
  if (select count(*) from pg_trigger where not tgisinternal and tgname in
        ('trg_customer_history_guard', 'trg_direct_customer_on_signup', 'trg_customer_relationships_on_profile',
         'trg_account_requests_company_deleted')) <> 6 then
    raise exception '105: محفّزات السجل غير مكتملة';
  end if;
end $$;
