-- ============================================================================
-- 113 — إدارة أعضاء الشركة (الفريق والعملاء)
--
-- طلب مالك الشركة (2026-10-26): تحكم أكبر في أعضاء شركته. ما يضيفه هذا الترحيل:
--   1) ملف العضو لدى الشركة: اسم عرض وجوال ومسمى ونوت داخلية تخص هذه الشركة وحدها. لا يلمس حساب
--      العضو ولا يراه غيرها.
--   2) تفاصيل العضو: الحساب، وملف الشركة، والعضوية، ودور الفريق، والإيقاف، وتذاكره مع هذه الشركة
--      وحدها، وسجله فيها، وطلب نقله المعلّق.
--   3) تعديل حساب العضو (الاسم والجوال والبريد): لحساب **أنشأته هذه الشركة** ومرتبط بها وحدها منذ
--      إنشائه فقط. التحقق هنا تحت جلسة المدير؛ التنفيذ في دالة Edge (company-member-admin) بمفتاح
--      الخدمة، لأن البريد في نظام الدخول وحرّاس profiles تمنع أي جلسة من تغيير بريد أو جوال غيرها.
--      لا تُضعَف تلك الحرّاس.
--   4) رابط إعادة كلمة المرور: فحص وحد معدّل هنا، والرابط يُرسل لبريد العضو نفسه من دالة Edge. الشركة
--      لا ترى الرابط ولا كلمة المرور.
--   5) الإيقاف المؤقت: ينهي العضوية بسبب «suspended» (نفس مسار الإزالة، فكل فحوص الوصول القائمة
--      تعمل بلا تعديل) ويحفظ ما يلزم لإعادتها: الأساسية ودور الفريق. إعادة التفعيل تعيدهما إن بقي
--      الحساب مؤهلًا. الإيقاف لا يحظر الحساب على المنصة؛ الحظر للمنصة وحدها.
--   6) طلب نقل العضو لشركة أخرى: تطلبه الشركة، ويقرره مالك المنصة بعد التحقق بخطوتين، وينفَّذ بمحرك
--      النقل القائم (owner_transfer_exceptional، 101) بكل فحوصه. الوجهة تُحل في الخادم برقم السجل
--      التجاري أو بريد الشركة، والرد واحد وُجدت أم لا.
--
-- لا تغيير في RLS ولا في دوال الوصول ولا في المفاتيح. الجداول الجديدة بلا منح مباشرة؛ كل وصول عبر
-- الدوال. التراجع: migrations/_rollback/113_company_member_management.down.sql
-- ============================================================================

-- ── 0) توسيع قيود السجل (إلحاقي: القيد يتسع ولا يضيق) ─────────────────────────
alter table public.company_membership_events drop constraint if exists company_membership_events_action_check;
alter table public.company_membership_events add constraint company_membership_events_action_check
  check (action in ('joined', 'ended', 'primary_set', 'primary_unset',
                    'invited', 'invitation_accepted', 'invitation_declined',
                    'invitation_cancelled', 'context_set',
                    'transfer_requested', 'transferred_out', 'transferred_in',
                    -- 113
                    'member_profile_updated', 'member_account_updated', 'member_password_reset',
                    'member_suspended', 'member_reactivated',
                    'member_transfer_requested', 'member_transfer_cancelled',
                    'member_transfer_approved', 'member_transfer_rejected'));

alter table public.company_memberships drop constraint if exists company_memberships_end_cause_check;
alter table public.company_memberships add constraint company_memberships_end_cause_check
  check (end_cause in ('left', 'removed', 'transferred', 'company_closed', 'suspended'));

alter table public.company_memberships drop constraint if exists company_memberships_joined_via_check;
alter table public.company_memberships add constraint company_memberships_joined_via_check
  check (joined_via in ('backfill', 'legacy', 'invitation', 'transfer', 'account_request', 'reactivated'));


-- ── 1) الجداول ──────────────────────────────────────────────────────────────
create table if not exists public.company_member_profiles (
  company_id    uuid not null references public.companies(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  display_name  text check (display_name is null or char_length(display_name) between 1 and 120),
  phone         text check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  job_title     text check (job_title is null or char_length(job_title) between 1 and 80),
  notes         text check (notes is null or char_length(notes) <= 2000),
  updated_by    uuid,
  updated_at    timestamptz not null default now(),
  primary key (company_id, user_id)
);
comment on table public.company_member_profiles is
  '113: بيانات العضو كما تحفظها شركته (اسم عرض، جوال، مسمى، نوت). لا تغيّر حساب العضو ولا تراها شركة أخرى.';

create table if not exists public.company_member_suspensions (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null references public.companies(id) on delete cascade,
  user_id                   uuid not null references public.profiles(id) on delete cascade,
  membership_id             uuid,
  was_primary               boolean not null,
  staff_role                text check (staff_role in ('supervisor', 'agent')),
  reason                    text not null check (char_length(reason) between 10 and 500),
  suspended_by              uuid not null,
  suspended_at              timestamptz not null default now(),
  status                    text not null default 'suspended'
                              check (status in ('suspended', 'reactivated', 'superseded')),
  closed_at                 timestamptz,
  closed_by                 uuid,
  reactivated_membership_id uuid,
  constraint company_member_suspensions_closed_iff check ((status = 'suspended') = (closed_at is null))
);
comment on table public.company_member_suspensions is
  '113: إيقاف مؤقت لعضو: العضوية تنتهي بسبب suspended، وهذا الصف يحفظ ما يعاد عند التفعيل.';
create unique index if not exists company_member_suspensions_one_open
  on public.company_member_suspensions (company_id, user_id) where status = 'suspended';

create table if not exists public.company_member_account_changes (
  id            uuid primary key default gen_random_uuid(),
  -- بلا مفاتيح خارجية عمدًا (سجل): يبقى بعد حذف الحساب أو الشركة
  company_id    uuid not null,
  user_id       uuid not null,
  requested_by  uuid not null,
  requested_at  timestamptz not null default now(),
  old_values    jsonb not null,
  new_values    jsonb not null,
  status        text not null default 'pending' check (status in ('pending', 'applied', 'failed', 'expired')),
  error         text check (error is null or error ~ '^[a-z_]{1,40}$'),
  completed_at  timestamptz
);
comment on table public.company_member_account_changes is
  '113: طلبات تعديل حساب عضو أنشأته الشركة. يُنشئها فحص تحت جلسة المدير، وتنفذها دالة Edge بمفتاح الخدمة.';
create index if not exists company_member_account_changes_company
  on public.company_member_account_changes (company_id, requested_at desc);

create table if not exists public.company_member_transfer_requests (
  id               uuid primary key default gen_random_uuid(),
  -- بلا مفاتيح خارجية عمدًا (كـ customer_transfers): السجل يبقى بمعرّفات فقط
  company_id       uuid not null,
  user_id          uuid not null,
  requested_by     uuid not null,
  idempotency_key  uuid not null,
  dest_ref         text not null check (char_length(dest_ref) between 1 and 320),
  to_company       uuid,
  reason           text not null check (char_length(reason) between 10 and 500),
  status           text not null default 'pending'
                     check (status in ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default now() + interval '14 days',
  decided_by       uuid,
  decided_at       timestamptz,
  decision_reason  text,
  transfer_id      uuid,
  unique (company_id, idempotency_key)
);
comment on table public.company_member_transfer_requests is
  '113: طلب شركة نقل عضو منها لشركة أخرى. يقرره مالك المنصة؛ التنفيذ owner_transfer_exceptional (101).';
create unique index if not exists company_member_transfer_requests_one_pending
  on public.company_member_transfer_requests (user_id) where status = 'pending';
create index if not exists company_member_transfer_requests_status
  on public.company_member_transfer_requests (status, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['company_member_profiles', 'company_member_suspensions',
                           'company_member_account_changes', 'company_member_transfer_requests'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('drop policy if exists gate_account_active on public.%I', t);
    execute format('create policy gate_account_active on public.%I as restrictive for all to authenticated '
                   'using (public.account_is_active()) with check (public.account_is_active())', t);
    execute format('drop trigger if exists trg_preview_read_only on public.%I', t);
    execute format('create trigger trg_preview_read_only before insert or update or delete on public.%I '
                   'for each statement execute function public.guard_preview_read_only()', t);
  end loop;
end $$;

-- السجلات لا تُحذف (حذف الحساب أو الشركة يمر بالمفاتيح الخارجية حيث وُجدت)
create or replace function public._member_mgmt_no_delete()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  raise exception 'سجل ثابت: لا يُحذف' using errcode = '55000';
end $$;
do $$
declare t text;
begin
  foreach t in array array['company_member_account_changes', 'company_member_transfer_requests'] loop
    execute format('drop trigger if exists trg_member_mgmt_no_delete on public.%I', t);
    execute format('create trigger trg_member_mgmt_no_delete before delete on public.%I '
                   'for each row execute function public._member_mgmt_no_delete()', t);
  end loop;
end $$;


-- ── 2) مساعدات داخلية ───────────────────────────────────────────────────────
-- حالة الحساب في الشركة: active (عضوية نشطة) | suspended (إيقاف مفتوح) | null. null = لا علاقة له بها.
create or replace function public._company_member_state(p_company uuid, p_user uuid)
returns text
language sql
stable
security definer
set search_path to 'public'
as $$
  select case
    when public._company_member_active(p_company, p_user) then 'active'
    when exists (select 1 from public.company_member_suspensions s
                  where s.company_id = p_company and s.user_id = p_user and s.status = 'suspended') then 'suspended'
  end;
$$;

-- مدير الشركة + الحساب عضو فيها (أو موقوف فيها إن سُمح). نفس الخطأ لكل حساب آخر: لا كشف.
create or replace function public._company_member_require(p_user uuid, p_allow_suspended boolean)
returns uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid := public._company_staff_require_manager();
  v_state   text := public._company_member_state(v_company, p_user);
begin
  if p_user is null or v_state is null or (v_state = 'suspended' and not p_allow_suspended) then
    raise exception 'هذا الحساب ليس عضوًا في شركتك' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  return v_company;
end $$;

-- هل تعدّل الشركة حساب العضو نفسه؟ null = نعم، وإلا رمز السبب.
--   أنشأته الشركة (app_metadata.company_created، لا يكتبها إلا مفتاح الخدمة) + أساسيته فيها منذ الإنشاء
--   (legacy/backfill، لا دعوة ولا نقل) + لا عضوية نشطة أخرى + ليس مالك شركة ولا من طاقم المنصة.
--   الرمز لا يفرّق بين الأسباب التي تخص علاقات الحساب خارج الشركة (not_exclusive): لا كشف.
create or replace function public._company_member_account_scope(p_company uuid, p_user uuid)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_owner uuid;
begin
  if public._company_member_state(p_company, p_user) = 'suspended' then
    return 'suspended';
  end if;
  if coalesce((select u.raw_app_meta_data ->> 'company_created' from auth.users u where u.id = p_user), '') <> 'true' then
    return 'not_company_created';
  end if;
  select c.user_id into v_owner from public.companies c where c.id = p_company;
  if not exists (select 1 from public.profiles p
                  where p.id = p_user and p.super_user_id = v_owner
                    and coalesce(p.role, 'user') not in ('platform_owner', 'admin', 'support', 'company_admin'))
     or exists (select 1 from public.companies c where c.user_id = p_user)
     or not exists (select 1 from public.company_memberships m
                     where m.company_id = p_company and m.user_id = p_user and m.status = 'active'
                       and m.is_primary and m.joined_via in ('legacy', 'backfill'))
     or exists (select 1 from public.company_memberships m
                 where m.user_id = p_user and m.status = 'active' and m.company_id <> p_company) then
    return 'not_exclusive';
  end if;
  return null;
end $$;

-- الوجهة من رقم السجل التجاري أو بريد الشركة، مطابقة تامة وواحدة فقط
create or replace function public._company_resolve_ref(p_ref text)
returns uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_ref text := btrim(coalesce(p_ref, ''));
  v_ids uuid[];
begin
  if v_ref = '' then
    return null;
  end if;
  select array_agg(c.id) into v_ids from public.companies c
   where c.commercial_registration_number = v_ref
      or (position('@' in v_ref) > 0 and lower(c.company_email) = lower(v_ref));
  return case when cardinality(v_ids) = 1 then v_ids[1] end;
end $$;

create or replace function public._member_mgmt_notify_owners()
returns void
language sql
security definer
set search_path to 'public'
as $$
  -- نص عام: لا اسم عضو ولا بريد ولا شركة
  insert into public.notifications (user_id, title, message, type, link, category)
  select a.user_id, 'طلب نقل عضو', 'شركة طلبت نقل أحد أعضائها لشركة أخرى؛ القرار في «حوكمة الشركات».', 'info',
         '/owner-dashboard.html#governance', 'account'
    from public.platform_authority a join public.profiles p on p.id = a.user_id
   where a.level = 'owner' and p.role = 'platform_owner';
$$;

-- انتهاء الطلبات المعلّقة القديمة (يُنادى عند كل قراءة أو قرار)
create or replace function public._member_transfer_expire()
returns void
language sql
security definer
set search_path to 'public'
as $$
  update public.company_member_transfer_requests
     set status = 'expired', decided_at = now()
   where status = 'pending' and expires_at <= now();
$$;


-- ── 3) ملف العضو لدى الشركة ─────────────────────────────────────────────────
create or replace function public.company_member_profile_save(p_user uuid, p_display_name text, p_phone text,
                                                               p_job_title text, p_notes text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid := public._company_member_require(p_user, true);
  v_name    text := nullif(btrim(coalesce(p_display_name, '')), '');
  v_phone   text := nullif(btrim(coalesce(p_phone, '')), '');
  v_title   text := nullif(btrim(coalesce(p_job_title, '')), '');
  v_notes   text := nullif(btrim(coalesce(p_notes, '')), '');
  v_old     public.company_member_profiles;
  v_changed text[] := '{}';
begin
  if char_length(coalesce(v_name, '')) > 120 or char_length(coalesce(v_title, '')) > 80
     or char_length(coalesce(v_notes, '')) > 2000 then
    raise exception 'نص أطول من المسموح' using errcode = '22023', detail = '{"code":"validation_failed","reason":"too_long"}';
  end if;
  if v_phone is not null then
    v_phone := public.normalize_phone(v_phone);
    if v_phone is null then
      raise exception 'رقم الجوال غير صالح' using errcode = '22023', detail = '{"code":"validation_failed","reason":"phone"}';
    end if;
  end if;
  select * into v_old from public.company_member_profiles where company_id = v_company and user_id = p_user for update;
  if v_old.display_name is distinct from v_name then v_changed := v_changed || 'display_name'::text; end if;
  if v_old.phone        is distinct from v_phone then v_changed := v_changed || 'phone'::text; end if;
  if v_old.job_title    is distinct from v_title then v_changed := v_changed || 'job_title'::text; end if;
  if v_old.notes        is distinct from v_notes then v_changed := v_changed || 'notes'::text; end if;
  if cardinality(v_changed) = 0 then
    return jsonb_build_object('changed', false);
  end if;
  insert into public.company_member_profiles (company_id, user_id, display_name, phone, job_title, notes, updated_by, updated_at)
  values (v_company, p_user, v_name, v_phone, v_title, v_notes, auth.uid(), now())
  on conflict (company_id, user_id) do update
     set display_name = excluded.display_name, phone = excluded.phone, job_title = excluded.job_title,
         notes = excluded.notes, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  -- أسماء الحقول وحدها في السجل، لا القيم
  perform public._membership_event(v_company, p_user, 'member_profile_updated', jsonb_build_object('fields', to_jsonb(v_changed)));
  return jsonb_build_object('changed', true, 'fields', to_jsonb(v_changed));
end $$;


-- ── 4) تفاصيل العضو ─────────────────────────────────────────────────────────
create or replace function public.company_member_details(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid := public._company_member_require(p_user, true);
  v_state   text := public._company_member_state(v_company, p_user);
  v_scope   text := public._company_member_account_scope(v_company, p_user);
  v_staff   text := public._company_staff_role_of(v_company, p_user);
  v_m       public.company_memberships;
  v_s       public.company_member_suspensions;
  v_x       public.company_member_transfer_requests;
  v_xfer    text;
  p         public.profiles;
  cp        public.company_member_profiles;
begin
  select * into p from public.profiles where id = p_user;
  select * into cp from public.company_member_profiles where company_id = v_company and user_id = p_user;
  select * into v_m from public.company_memberships
   where company_id = v_company and user_id = p_user and status = 'active';
  select * into v_s from public.company_member_suspensions
   where company_id = v_company and user_id = p_user and status = 'suspended';
  select * into v_x from public.company_member_transfer_requests
   where company_id = v_company and user_id = p_user and status = 'pending' and expires_at > now();

  -- هل يمكن طلب نقله؟ الأسباب التي تخص علاقاته خارج الشركة رمز واحد (not_available)
  v_xfer := case
    when v_state <> 'active' then 'suspended'
    when v_x.id is not null then 'pending'
    when v_staff is not null then 'staff'
    when not (public._feature_on('customer_transfers_enabled') and public._feature_on('company_isolation_enforced')
              and public._feature_on('company_permissions_enabled')) then 'feature_off'
    when not coalesce(v_m.is_primary, false) then 'not_available'
  end;

  return jsonb_build_object(
    'user_id', p_user,
    'state', v_state,
    'account', jsonb_build_object(
      'name', coalesce(p.full_name, p.username, p.email),
      'full_name', p.full_name,
      'email', p.email,
      'phone', p.phone,
      'created_at', p.created_at,
      'created_by_company', coalesce((select u.raw_app_meta_data ->> 'company_created' from auth.users u
                                       where u.id = p_user), '') = 'true',
      'editable', v_scope is null,
      'not_editable_reason', v_scope),
    'company_profile', case when cp.user_id is null then null else jsonb_build_object(
      'display_name', cp.display_name, 'phone', cp.phone, 'job_title', cp.job_title, 'notes', cp.notes,
      'updated_at', cp.updated_at) end,
    'membership', case when v_m.id is null then null else jsonb_build_object(
      'joined_at', v_m.joined_at, 'joined_via', v_m.joined_via) end,
    'staff_role', v_staff,
    'suspension', case when v_s.id is null then null else jsonb_build_object(
      'id', v_s.id, 'suspended_at', v_s.suspended_at, 'reason', v_s.reason, 'was_staff', v_s.staff_role is not null) end,
    'transfer', jsonb_build_object(
      'can_request', v_xfer is null,
      'blocked_reason', v_xfer,
      'pending', case when v_x.id is null then null else jsonb_build_object(
        'id', v_x.id, 'dest_ref', v_x.dest_ref, 'reason', v_x.reason, 'created_at', v_x.created_at,
        'expires_at', v_x.expires_at) end),
    -- تذاكر العضو مع هذه الشركة وحدها (scope = company)؛ لا شيء من شركاته الأخرى ولا من دعم مدعوم
    'tickets', jsonb_build_object(
      'total', (select count(*) from public.tickets t
                 where t.user_id = p_user and t.scope = 'company' and t.company_id = v_company),
      'open', (select count(*) from public.tickets t
                where t.user_id = p_user and t.scope = 'company' and t.company_id = v_company
                  and t.status in ('open', 'in-progress')),
      'assigned_open', case when v_staff is null then null else
                (select count(*) from public.tickets t
                  where t.assigned_to = p_user and t.scope = 'company' and t.company_id = v_company
                    and t.status in ('open', 'in-progress')) end,
      'recent', coalesce((select jsonb_agg(q.r order by q.at desc) from (
                  select jsonb_build_object('id', t.id, 'ticket_number', t.ticket_number, 'title', t.title,
                                            'status', t.status, 'created_at', t.created_at) as r, t.created_at as at
                    from public.tickets t
                   where t.user_id = p_user and t.scope = 'company' and t.company_id = v_company
                   order by t.created_at desc limit 5) q), '[]'::jsonb),
      'last_activity_at', (select max(greatest(t.created_at, coalesce(t.last_updated_at, t.created_at)))
                             from public.tickets t
                            where (t.user_id = p_user or t.assigned_to = p_user)
                              and t.scope = 'company' and t.company_id = v_company)),
    -- سجل العضو في هذه الشركة: النوع والوقت والسبب، بلا تفاصيل عن شركات أخرى
    'history', coalesce((select jsonb_agg(q.h order by q.at desc) from (
        select jsonb_build_object('kind', 'membership', 'action', e.action, 'at', e.created_at,
                                  'cause', e.detail ->> 'cause', 'by_company', e.actor_id = c.user_id) as h,
               e.created_at as at
          from public.company_membership_events e join public.companies c on c.id = e.company_id
         where e.company_id = v_company and e.user_id = p_user
        union all
        select jsonb_build_object('kind', 'staff', 'action', se.action, 'at', se.created_at,
                                  'role_from', se.role_from, 'role_to', se.role_to, 'cause', se.cause,
                                  'by_company', se.actor_id = c.user_id),
               se.created_at
          from public.company_staff_events se join public.companies c on c.id = se.company_id
         where se.company_id = v_company and se.target_id = p_user
        order by 2 desc limit 40) q), '[]'::jsonb));
end $$;


-- ── 5) تعديل حساب أنشأته الشركة (الاسم والجوال والبريد) ───────────────────────
-- تحت جلسة المدير: يتحقق ويسجّل طلبًا معلّقًا. دالة Edge (مفتاح الخدمة) تحدّث نظام الدخول ثم تنادي
-- _company_member_account_apply. لا تنفيذ بلا طلب معلّق حديث من مدير الشركة نفسها.
create or replace function public.company_member_account_check(p_user uuid, p_full_name text, p_phone text, p_email text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid := public._company_member_require(p_user, false);
  v_scope   text := public._company_member_account_scope(v_company, p_user);
  v_name    text := btrim(coalesce(p_full_name, ''));
  v_phone   text := nullif(btrim(coalesce(p_phone, '')), '');
  v_email   text := lower(btrim(coalesce(p_email, '')));
  v_auth_email text;
  p         public.profiles;
  v_id      uuid;
begin
  if v_scope is not null then
    raise exception 'بيانات دخول هذا العضو يعدّلها بنفسه: الحساب ليس من إنشاء شركتك أو مرتبط بجهات أخرى'
      using errcode = '42501', detail = jsonb_build_object('code', 'not_editable', 'reason', v_scope)::text;
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'الاسم مطلوب (2 إلى 120 حرفًا)' using errcode = '22023', detail = '{"code":"validation_failed","reason":"name"}';
  end if;
  if v_phone is not null then
    v_phone := public.normalize_phone(v_phone);
    if v_phone is null then
      raise exception 'رقم الجوال غير صالح' using errcode = '22023', detail = '{"code":"validation_failed","reason":"phone"}';
    end if;
  end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or char_length(v_email) > 320 then
    raise exception 'بريد إلكتروني غير صالح' using errcode = '22023', detail = '{"code":"validation_failed","reason":"email"}';
  end if;

  select * into p from public.profiles where id = p_user;
  select lower(u.email) into v_auth_email from auth.users u where u.id = p_user;
  -- الجوال يُعدَّل ولا يُحذف: بوابة الحساب (account_verification_ok) تعدّه توثيقًا، فحذفه يوقف الحساب
  if v_phone is null and p.phone is not null then
    raise exception 'رقم الجوال لا يُحذف (يوثّق الحساب)؛ أدخل الرقم الجديد بدلًا منه' using errcode = '22023',
      detail = '{"code":"validation_failed","reason":"phone_required"}';
  end if;
  if p.full_name is not distinct from v_name and p.phone is not distinct from v_phone
     and v_auth_email is not distinct from v_email then
    return jsonb_build_object('changed', false);
  end if;
  -- البريد والجوال فريدان على المنصة. الرسالة نفسها للحالتين ولا تذكر صاحب القيمة.
  if v_email is distinct from v_auth_email
     and (exists (select 1 from auth.users u where lower(u.email) = v_email and u.id <> p_user)
          or exists (select 1 from public.profiles x where lower(x.email) = v_email and x.id <> p_user)) then
    raise exception 'لا يمكن استخدام هذا البريد لهذا الحساب' using errcode = '23505', detail = '{"code":"email_unavailable"}';
  end if;
  if v_phone is distinct from p.phone and v_phone is not null
     and exists (select 1 from public.profiles x where x.phone = v_phone and x.id <> p_user) then
    raise exception 'لا يمكن استخدام هذا الرقم لهذا الحساب' using errcode = '23505', detail = '{"code":"phone_unavailable"}';
  end if;
  -- حد معدّل: 20 تعديلًا للشركة في 24 ساعة، وطلب واحد قيد التنفيذ للعضو
  if (select count(*) from public.company_member_account_changes
       where company_id = v_company and requested_at > now() - interval '24 hours') >= 20 then
    raise exception 'تجاوزت حد تعديلات الحسابات اليومي، حاول لاحقًا' using errcode = '54000', detail = '{"code":"rate_limited"}';
  end if;
  update public.company_member_account_changes set status = 'expired', completed_at = now()
   where user_id = p_user and status = 'pending';

  insert into public.company_member_account_changes (company_id, user_id, requested_by, old_values, new_values)
  values (v_company, p_user, auth.uid(),
          jsonb_build_object('full_name', p.full_name, 'phone', p.phone, 'email', v_auth_email),
          jsonb_build_object('full_name', v_name, 'phone', v_phone, 'email', v_email))
  returning id into v_id;
  return jsonb_build_object('changed', true, 'change_id', v_id, 'user_id', p_user,
                            'full_name', v_name, 'phone', v_phone, 'email', v_email,
                            'old_email', v_auth_email, 'old_full_name', p.full_name,
                            'email_changed', v_email is distinct from v_auth_email,
                            'name_changed', p.full_name is distinct from v_name);
end $$;

-- مفتاح الخدمة وحده (دالة Edge بعد تحديث نظام الدخول). يعيد الفحص ثم يكتب الملف ويُشعر العضو.
create or replace function public._company_member_account_apply(p_change uuid, p_ok boolean, p_error text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  x       public.company_member_account_changes;
  v_owner uuid;
  v_err   text := case when coalesce(p_error, '') ~ '^[a-z_]{1,40}$' then p_error else 'auth_update_failed' end;
  v_company_name text;
  v_fields text[] := '{}';
begin
  select * into x from public.company_member_account_changes where id = p_change for update;
  if x.id is null or x.status <> 'pending' then
    raise exception 'طلب التعديل غير موجود أو انتهى' using errcode = 'P0002';
  end if;
  if x.requested_at < now() - interval '10 minutes' then
    update public.company_member_account_changes set status = 'expired', completed_at = now() where id = x.id;
    return jsonb_build_object('status', 'expired');
  end if;
  if not coalesce(p_ok, false) then
    update public.company_member_account_changes set status = 'failed', error = v_err, completed_at = now() where id = x.id;
    return jsonb_build_object('status', 'failed', 'error', v_err);
  end if;
  select c.user_id, c.company_name into v_owner, v_company_name from public.companies c where c.id = x.company_id;
  if v_owner is distinct from x.requested_by or public._company_member_account_scope(x.company_id, x.user_id) is not null then
    update public.company_member_account_changes set status = 'failed', error = 'scope_changed', completed_at = now() where id = x.id;
    return jsonb_build_object('status', 'failed', 'error', 'scope_changed');
  end if;

  if (x.old_values ->> 'full_name') is distinct from (x.new_values ->> 'full_name') then v_fields := v_fields || 'full_name'::text; end if;
  if (x.old_values ->> 'phone') is distinct from (x.new_values ->> 'phone') then v_fields := v_fields || 'phone'::text; end if;
  if (x.old_values ->> 'email') is distinct from (x.new_values ->> 'email') then v_fields := v_fields || 'email'::text; end if;
  begin
    update public.profiles
       set full_name = x.new_values ->> 'full_name',
           phone = x.new_values ->> 'phone',
           email = x.new_values ->> 'email'
     where id = x.user_id;
  exception when unique_violation then
    update public.company_member_account_changes set status = 'failed', error = 'unique_conflict', completed_at = now() where id = x.id;
    return jsonb_build_object('status', 'failed', 'error', 'unique_conflict');
  end;
  update public.company_member_account_changes set status = 'applied', completed_at = now() where id = x.id;
  insert into public.company_membership_events (company_id, user_id, actor_id, action, detail)
  values (x.company_id, x.user_id, x.requested_by, 'member_account_updated',
          jsonb_build_object('fields', to_jsonb(v_fields), 'change_id', x.id));
  insert into public.notifications (user_id, title, message, type, category)
  values (x.user_id, 'تحديث بيانات حسابك',
          format('حدّثت %s بيانات حسابك (%s). إن لم تتوقع ذلك فتواصل مع شركتك.', coalesce(v_company_name, 'شركتك'),
                 array_to_string(array(select case f when 'full_name' then 'الاسم' when 'phone' then 'الجوال' else 'البريد' end
                                         from unnest(v_fields) f), '، ')),
          'warning', 'account');
  return jsonb_build_object('status', 'applied', 'fields', to_jsonb(v_fields), 'company_name', v_company_name);
end $$;


-- ── 6) رابط إعادة كلمة المرور ───────────────────────────────────────────────
-- تحت جلسة المدير: يتحقق ويحد المعدّل ويسجّل، ويعيد بريد الدخول لدالة Edge لترسل الرابط إليه.
create or replace function public.company_member_password_reset_check(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid := public._company_member_require(p_user, false);
  v_email   text;
  v_name    text;
begin
  -- المحظور على المنصة وحده يُرفض؛ حساب ينقصه توثيق (جوال) يحتاج الدخول ليكمله
  if public.is_banned(p_user) then
    raise exception 'الحساب محظور على المنصة' using errcode = '22023',
      detail = '{"code":"validation_failed","reason":"target_inactive"}';
  end if;
  if exists (select 1 from public.company_membership_events
              where company_id = v_company and user_id = p_user and action = 'member_password_reset'
                and created_at > now() - interval '10 minutes') then
    raise exception 'أُرسل رابط لهذا العضو قبل قليل؛ انتظر 10 دقائق' using errcode = '54000', detail = '{"code":"cooldown"}';
  end if;
  if (select count(*) from public.company_membership_events
       where company_id = v_company and action = 'member_password_reset'
         and created_at > now() - interval '24 hours') >= 20 then
    raise exception 'تجاوزت حد روابط إعادة كلمة المرور اليومي' using errcode = '54000', detail = '{"code":"rate_limited"}';
  end if;
  select lower(u.email) into v_email from auth.users u where u.id = p_user;
  if v_email is null then
    raise exception 'هذا الحساب ليس عضوًا في شركتك' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  select c.company_name into v_name from public.companies c where c.id = v_company;
  perform public._membership_event(v_company, p_user, 'member_password_reset', '{}'::jsonb);
  return jsonb_build_object('user_id', p_user, 'email', v_email, 'company_name', v_name);
end $$;


-- ── 7) الإيقاف المؤقت وإعادة التفعيل ────────────────────────────────────────
create or replace function public.company_member_suspend(p_user uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid := public._company_member_require(p_user, false);
  v_reason  text := public._reason_check(p_reason);
  m         public.company_memberships;
  v_staff   public.company_staff;
  v_id      uuid;
  v_name    text;
begin
  -- قفل الحساب: لا قبول دعوة ولا نقل ولا مغادرة متزامنة
  perform 1 from public.profiles where id = p_user for update;
  select * into m from public.company_memberships
   where company_id = v_company and user_id = p_user and status = 'active' for update;
  if m.id is null then
    raise exception 'هذا الحساب ليس عضوًا في شركتك' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;

  update public.company_staff
     set revoked_at = now(), revoked_by = auth.uid(), revoke_cause = 'admin', updated_by = auth.uid(), updated_at = now()
   where company_id = v_company and user_id = p_user and revoked_at is null
  returning * into v_staff;
  if v_staff.id is not null then
    insert into public.company_staff_events (company_id, actor_id, target_id, action, role_from, cause)
    values (v_company, auth.uid(), p_user, 'revoked', v_staff.role, 'admin');
  end if;

  update public.company_member_transfer_requests
     set status = 'cancelled', decided_at = now(), decided_by = auth.uid(), decision_reason = 'member_suspended'
   where company_id = v_company and user_id = p_user and status = 'pending';

  insert into public.company_member_suspensions (company_id, user_id, membership_id, was_primary, staff_role, reason, suspended_by)
  values (v_company, p_user, m.id, m.is_primary, v_staff.role, v_reason, auth.uid())
  returning id into v_id;
  perform public._membership_end(m.id, 'suspended');
  perform public._membership_event(v_company, p_user, 'member_suspended',
                                   jsonb_build_object('suspension_id', v_id, 'was_staff', v_staff.id is not null));

  select c.company_name into v_name from public.companies c where c.id = v_company;
  insert into public.notifications (user_id, title, message, type, category)
  values (p_user, 'إيقاف عضويتك مؤقتًا',
          format('أوقفت %s عضويتك مؤقتًا. تواصل معها لإعادة التفعيل.', coalesce(v_name, 'شركتك')), 'warning', 'account');
  return jsonb_build_object('suspended', true, 'suspension_id', v_id, 'staff_revoked', v_staff.id is not null);
end $$;

create or replace function public.company_member_reactivate(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid := public._company_member_require(p_user, true);
  v_owner   uuid;
  s         public.company_member_suspensions;
  v_m       uuid;
  v_primary boolean;
  v_staff   boolean := false;
  v_name    text;
begin
  perform 1 from public.profiles where id = p_user for update;
  select * into s from public.company_member_suspensions
   where company_id = v_company and user_id = p_user and status = 'suspended' for update;
  if s.id is null then
    raise exception 'هذا العضو ليس موقوفًا' using errcode = 'P0002', detail = '{"code":"not_suspended"}';
  end if;
  select c.user_id, c.company_name into v_owner, v_name from public.companies c where c.id = v_company;

  -- عاد بدعوة أثناء الإيقاف: الإيقاف انتهى بلا إعادة
  if public._company_member_active(v_company, p_user) then
    update public.company_member_suspensions set status = 'superseded', closed_at = now(), closed_by = auth.uid()
     where id = s.id;
    return jsonb_build_object('reactivated', false, 'reason', 'already_member');
  end if;
  -- الحساب لم يعد مؤهلًا (صار مالك شركة أو من طاقم المنصة أو محظورًا)، أو له عضوية في غيرها والعضويات
  -- المتعددة مطفأة. رسالة واحدة: لا كشف لعلاقاته خارج الشركة.
  if exists (select 1 from public.companies c where c.user_id = p_user)
     or exists (select 1 from public.profiles p where p.id = p_user and p.role in ('platform_owner', 'admin', 'support'))
     or public.is_banned(p_user)
     or (not public._feature_on('multi_company_memberships_enabled')
         and exists (select 1 from public.company_memberships m where m.user_id = p_user and m.status = 'active')) then
    raise exception 'تعذّرت إعادة التفعيل: تغيّرت حالة هذا الحساب. يمكنك دعوته من جديد' using errcode = '55000',
      detail = '{"code":"not_eligible"}';
  end if;

  v_primary := s.was_primary
               and not exists (select 1 from public.company_memberships m
                                where m.user_id = p_user and m.status = 'active' and m.is_primary);
  insert into public.company_memberships (company_id, user_id, is_primary, joined_via)
  values (v_company, p_user, v_primary, 'reactivated')
  returning id into v_m;
  perform public._membership_event(v_company, p_user, 'joined', jsonb_build_object('via', 'reactivated', 'primary', v_primary));
  if v_primary then
    perform public._membership_apply_mirror(p_user);
  end if;

  -- دور الفريق يعود إن بقي الحساب تابعًا للشركة بنفس شروط company_staff_set
  if s.staff_role is not null
     and exists (select 1 from public.profiles p where p.id = p_user and p.super_user_id = v_owner and p.role = 'company_user')
     and coalesce(public._inbox_account_active(p_user), false) then
    insert into public.company_staff (company_id, user_id, role, granted_by, updated_by)
    values (v_company, p_user, s.staff_role, auth.uid(), auth.uid());
    insert into public.company_staff_events (company_id, actor_id, target_id, action, role_to, cause)
    values (v_company, auth.uid(), p_user, 'granted', s.staff_role, 'admin');
    v_staff := true;
  end if;

  update public.company_member_suspensions
     set status = 'reactivated', closed_at = now(), closed_by = auth.uid(), reactivated_membership_id = v_m
   where id = s.id;
  perform public._membership_event(v_company, p_user, 'member_reactivated',
                                   jsonb_build_object('suspension_id', s.id, 'primary', v_primary, 'staff_restored', v_staff));
  insert into public.notifications (user_id, title, message, type, category)
  values (p_user, 'إعادة تفعيل عضويتك', format('أعادت %s تفعيل عضويتك.', coalesce(v_name, 'شركتك')), 'success', 'account');
  return jsonb_build_object('reactivated', true, 'primary', v_primary, 'staff_restored', v_staff,
                            'staff_role', case when v_staff then s.staff_role end);
end $$;

create or replace function public.company_member_suspensions_list()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid := public._company_staff_require_manager();
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
            'user_id', s.user_id,
            'name', coalesce(cp.display_name, p.full_name, p.username, p.email),
            'email', p.email,
            'suspended_at', s.suspended_at,
            'reason', s.reason,
            'was_staff', s.staff_role is not null) order by s.suspended_at desc)
     from public.company_member_suspensions s
     join public.profiles p on p.id = s.user_id
     left join public.company_member_profiles cp on cp.company_id = s.company_id and cp.user_id = s.user_id
    where s.company_id = v_company and s.status = 'suspended'), '[]'::jsonb);
end $$;


-- ── 8) طلب نقل العضو لشركة أخرى ─────────────────────────────────────────────
create or replace function public.company_member_transfer_request(p_user uuid, p_dest_ref text, p_reason text,
                                                                   p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid := public._company_member_require(p_user, false);
  v_reason  text := public._reason_check(p_reason);
  v_ref     text := btrim(coalesce(p_dest_ref, ''));
  v_dest    uuid;
  x         public.company_member_transfer_requests;
begin
  perform public._transfers_require_enabled();
  if p_idempotency_key is null then
    raise exception 'مفتاح منع التكرار مطلوب' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  select * into x from public.company_member_transfer_requests where company_id = v_company and idempotency_key = p_idempotency_key;
  if x.id is not null then
    return jsonb_build_object('request_id', x.id, 'status', x.status, 'replayed', true);
  end if;
  if char_length(v_ref) < 2 or char_length(v_ref) > 320 then
    raise exception 'أدخل رقم السجل التجاري أو بريد الشركة الوجهة' using errcode = '22023',
      detail = '{"code":"validation_failed","reason":"dest_ref"}';
  end if;
  if public._company_staff_role_of(v_company, p_user) is not null then
    raise exception 'أزل دور الفريق عن هذا العضو أولًا؛ النقل للعملاء وحدهم' using errcode = '22023',
      detail = '{"code":"validation_failed","reason":"staff"}';
  end if;
  if not exists (select 1 from public.company_memberships m
                  where m.company_id = v_company and m.user_id = p_user and m.status = 'active' and m.is_primary) then
    raise exception 'لا يمكن طلب نقل هذا العضو من شركتك' using errcode = '22023',
      detail = '{"code":"validation_failed","reason":"not_available"}';
  end if;
  perform public._member_transfer_expire();
  if exists (select 1 from public.company_member_transfer_requests where user_id = p_user and status = 'pending') then
    raise exception 'يوجد طلب نقل معلّق لهذا العضو' using errcode = '23505', detail = '{"code":"pending_exists"}';
  end if;
  if (select count(*) from public.company_member_transfer_requests
       where company_id = v_company and created_at > now() - interval '24 hours') >= 20 then
    raise exception 'تجاوزت حد طلبات النقل اليومي' using errcode = '54000', detail = '{"code":"rate_limited"}';
  end if;
  -- الوجهة تُحل هنا وتُحفظ للمالك؛ الرد لا يقول هل وُجدت (لا كشف لوجود شركة)
  v_dest := public._company_resolve_ref(v_ref);
  if v_dest = v_company then
    v_dest := null;
  end if;
  insert into public.company_member_transfer_requests (company_id, user_id, requested_by, idempotency_key, dest_ref, to_company, reason)
  values (v_company, p_user, auth.uid(), p_idempotency_key, v_ref, v_dest, v_reason)
  returning * into x;
  perform public._membership_event(v_company, p_user, 'member_transfer_requested', jsonb_build_object('request_id', x.id));
  perform public._member_mgmt_notify_owners();
  return jsonb_build_object('request_id', x.id, 'status', x.status, 'expires_at', x.expires_at);
end $$;

create or replace function public.company_member_transfer_cancel(p_request uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid := public._company_staff_require_manager();
  x         public.company_member_transfer_requests;
begin
  update public.company_member_transfer_requests
     set status = 'cancelled', decided_at = now(), decided_by = auth.uid(), decision_reason = 'company_cancelled'
   where id = p_request and company_id = v_company and status = 'pending'
  returning * into x;
  if x.id is null then
    raise exception 'طلب النقل غير موجود أو انتهى' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  perform public._membership_event(v_company, x.user_id, 'member_transfer_cancelled', jsonb_build_object('request_id', x.id));
  return jsonb_build_object('request_id', x.id, 'status', 'cancelled');
end $$;

create or replace function public.company_member_transfer_requests()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid := public._company_staff_require_manager();
begin
  perform public._member_transfer_expire();
  -- الوجهة كما كتبتها الشركة؛ اسم الشركة الوجهة لا يُعرض لها (قد لا تعرفها)
  return coalesce((select jsonb_agg(jsonb_build_object(
            'id', x.id, 'user_id', x.user_id,
            'name', coalesce(cp.display_name, p.full_name, p.username, p.email, 'حساب محذوف'),
            'dest_ref', x.dest_ref, 'reason', x.reason, 'status', x.status,
            'created_at', x.created_at, 'expires_at', x.expires_at, 'decided_at', x.decided_at,
            'decision_reason', case when x.status = 'rejected' then x.decision_reason end)
            order by x.created_at desc)
     from (select * from public.company_member_transfer_requests
            where company_id = v_company order by created_at desc limit 50) x
     left join public.profiles p on p.id = x.user_id
     left join public.company_member_profiles cp on cp.company_id = x.company_id and cp.user_id = x.user_id), '[]'::jsonb);
end $$;

-- مالك المنصة: القائمة بأسماء الطرفين
create or replace function public.owner_member_transfer_requests(p_status text default 'pending')
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not coalesce(public.owner_capability('owner_only'), false) then
    raise exception 'لمالك المنصة وحده' using errcode = '42501';
  end if;
  perform public._member_transfer_expire();
  return coalesce((select jsonb_agg(jsonb_build_object(
            'id', x.id, 'status', x.status, 'reason', x.reason, 'created_at', x.created_at, 'expires_at', x.expires_at,
            'member_id', x.user_id, 'member_name', coalesce(p.full_name, p.username, 'حساب محذوف'), 'member_email', p.email,
            'from_company_id', x.company_id, 'from_company', coalesce(f.company_name, 'شركة محذوفة'),
            'dest_ref', x.dest_ref, 'to_company_id', x.to_company, 'to_company', t.company_name,
            'decided_at', x.decided_at, 'decision_reason', x.decision_reason, 'transfer_id', x.transfer_id)
            order by x.created_at desc)
     from (select * from public.company_member_transfer_requests
            where p_status is null or status = p_status order by created_at desc limit 100) x
     left join public.profiles p on p.id = x.user_id
     left join public.companies f on f.id = x.company_id
     left join public.companies t on t.id = x.to_company), '[]'::jsonb);
end $$;

-- القرار: الموافقة بعد التحقق بخطوتين وتنفَّذ بمحرك النقل نفسه (كل شيء أو لا شيء)؛ الرفض بسبب.
-- p_dest_ref يصحح الوجهة إن كانت مكتوبة خطأ في الطلب.
create or replace function public.owner_decide_member_transfer(p_request uuid, p_approve boolean, p_reason text,
                                                               p_dest_ref text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  x       public.company_member_transfer_requests;
  v_dest  uuid;
  v_owner uuid;
  r       jsonb;
begin
  if not coalesce(public.owner_capability('owner_only'), false) then
    raise exception 'لمالك المنصة وحده' using errcode = '42501';
  end if;
  perform public._member_transfer_expire();
  select * into x from public.company_member_transfer_requests where id = p_request for update;
  if x.id is null or x.status <> 'pending' then
    raise exception 'الطلب غير موجود أو لم يعد معلّقًا' using errcode = 'P0002';
  end if;
  select c.user_id into v_owner from public.companies c where c.id = x.company_id;

  if not coalesce(p_approve, false) then
    update public.company_member_transfer_requests
       set status = 'rejected', decided_at = now(), decided_by = auth.uid(), decision_reason = public._reason_check(p_reason)
     where id = x.id;
    insert into public.company_membership_events (company_id, user_id, actor_id, action, detail)
    values (x.company_id, x.user_id, auth.uid(), 'member_transfer_rejected', jsonb_build_object('request_id', x.id));
    if v_owner is not null then
      insert into public.notifications (user_id, title, message, type, link, category)
      values (v_owner, 'رُفض طلب نقل عضو', 'رفضت إدارة المنصة طلب نقل أحد أعضائك. السبب في «الأعضاء».', 'info',
              '/company-dashboard/#members', 'account');
    end if;
    perform public.log_privileged('company.member_transfer.rejected', x.user_id, null,
                                  jsonb_build_object('request_id', x.id, 'company_id', x.company_id));
    return jsonb_build_object('request_id', x.id, 'status', 'rejected');
  end if;

  if not coalesce(public.owner_critical_ok(), false) then
    raise exception 'الموافقة على النقل لمالك المنصة بعد التحقق بخطوتين' using errcode = '42501';
  end if;
  v_dest := case when nullif(btrim(coalesce(p_dest_ref, '')), '') is null then x.to_company
                 else public._company_resolve_ref(p_dest_ref) end;
  if v_dest is null or v_dest = x.company_id then
    raise exception 'شركة الوجهة غير موجودة؛ صحّح رقم السجل التجاري أو بريد الشركة' using errcode = 'P0002';
  end if;
  -- النقل نفسه: 101 بكل فحوصه (المفاتيح، العضو عميل أساسي في المصدر، الوجهة صالحة، سبب 20 حرفًا)
  r := public.owner_transfer_exceptional(x.user_id, v_dest, p_reason, false, x.id);
  update public.company_member_transfer_requests
     set status = 'approved', decided_at = now(), decided_by = auth.uid(), decision_reason = btrim(p_reason),
         to_company = v_dest, transfer_id = (r ->> 'transfer_id')::uuid
   where id = x.id;
  insert into public.company_membership_events (company_id, user_id, actor_id, action, detail)
  values (x.company_id, x.user_id, auth.uid(), 'member_transfer_approved',
          jsonb_build_object('request_id', x.id, 'transfer_id', r ->> 'transfer_id'));
  if v_owner is not null then
    insert into public.notifications (user_id, title, message, type, link, category)
    values (v_owner, 'اكتمل نقل عضو', 'وافقت إدارة المنصة على طلب نقل أحد أعضائك وتم النقل.', 'success',
            '/company-dashboard/#members', 'account');
  end if;
  return jsonb_build_object('request_id', x.id, 'status', 'approved', 'transfer_id', r ->> 'transfer_id');
end $$;


-- ── 9) الصلاحيات ────────────────────────────────────────────────────────────
do $$
declare f text;
begin
  foreach f in array array[
    'public._member_mgmt_no_delete()', 'public._company_member_state(uuid,uuid)',
    'public._company_member_require(uuid,boolean)', 'public._company_member_account_scope(uuid,uuid)',
    'public._company_resolve_ref(text)', 'public._member_mgmt_notify_owners()', 'public._member_transfer_expire()',
    'public._company_member_account_apply(uuid,boolean,text)',
    'public.company_member_profile_save(uuid,text,text,text,text)', 'public.company_member_details(uuid)',
    'public.company_member_account_check(uuid,text,text,text)', 'public.company_member_password_reset_check(uuid)',
    'public.company_member_suspend(uuid,text)', 'public.company_member_reactivate(uuid)',
    'public.company_member_suspensions_list()',
    'public.company_member_transfer_request(uuid,text,text,uuid)', 'public.company_member_transfer_cancel(uuid)',
    'public.company_member_transfer_requests()',
    'public.owner_member_transfer_requests(text)', 'public.owner_decide_member_transfer(uuid,boolean,text,text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
end $$;

grant execute on function public.company_member_profile_save(uuid, text, text, text, text)       to authenticated;
grant execute on function public.company_member_details(uuid)                                    to authenticated;
grant execute on function public.company_member_account_check(uuid, text, text, text)            to authenticated;
grant execute on function public.company_member_password_reset_check(uuid)                       to authenticated;
grant execute on function public.company_member_suspend(uuid, text)                              to authenticated;
grant execute on function public.company_member_reactivate(uuid)                                 to authenticated;
grant execute on function public.company_member_suspensions_list()                               to authenticated;
grant execute on function public.company_member_transfer_request(uuid, text, text, uuid)         to authenticated;
grant execute on function public.company_member_transfer_cancel(uuid)                            to authenticated;
grant execute on function public.company_member_transfer_requests()                              to authenticated;
grant execute on function public.owner_member_transfer_requests(text)                            to authenticated;
grant execute on function public.owner_decide_member_transfer(uuid, boolean, text, text)         to authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public._company_member_account_apply(uuid, boolean, text) to service_role;
  end if;
end $$;


-- ── 10) تحقق ────────────────────────────────────────────────────────────────
do $$
declare
  t text;
  f text;
  v_new text[] := array['_member_mgmt_no_delete', '_company_member_state', '_company_member_require',
                        '_company_member_account_scope', '_company_resolve_ref', '_member_mgmt_notify_owners',
                        '_member_transfer_expire', '_company_member_account_apply', 'company_member_profile_save',
                        'company_member_details', 'company_member_account_check', 'company_member_password_reset_check',
                        'company_member_suspend', 'company_member_reactivate', 'company_member_suspensions_list',
                        'company_member_transfer_request', 'company_member_transfer_cancel',
                        'company_member_transfer_requests', 'owner_member_transfer_requests', 'owner_decide_member_transfer'];
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = any (v_new)) <> cardinality(v_new) then
    raise exception '113: دالة ناقصة';
  end if;
  foreach t in array array['company_member_profiles', 'company_member_suspensions',
                           'company_member_account_changes', 'company_member_transfer_requests'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception '113: % بلا RLS', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and permissive = 'PERMISSIVE') then
      raise exception '113: سياسة سماح على %', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'SELECT')
       or has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
       or has_table_privilege('anon', 'public.' || t, 'SELECT')
       or (exists (select 1 from pg_roles where rolname = 'service_role')
           and has_table_privilege('service_role', 'public.' || t, 'SELECT')) then
      raise exception '113: صلاحية مباشرة على %', t;
    end if;
  end loop;

  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = any (v_new) loop
    if has_function_privilege('anon', f, 'EXECUTE') then
      raise exception '113: دالة مكشوفة لـ anon: %', f;
    end if;
    if has_function_privilege('authenticated', f, 'EXECUTE') and f like '\_%' then
      raise exception '113: دالة داخلية مكشوفة: %', f;
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role')
       and has_function_privilege('service_role', f, 'EXECUTE')
       and f <> '_company_member_account_apply(uuid,boolean,text)' then
      raise exception '113: دالة مكشوفة لمفتاح الخدمة: %', f;
    end if;
  end loop;

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = any (v_new)
                and p.prosecdef and not coalesce(p.proconfig::text like '%search_path=public%', false)) then
    raise exception '113: دالة SECURITY DEFINER بلا search_path ثابت';
  end if;

  raise notice '113: إدارة أعضاء الشركة جاهزة';
end $$;
