-- ============================================================================
-- 086_company_staff.sql
--   موظفو الشركة — عضوية صريحة منفصلة عن عملاء الشركة.
--   Mad3oom Continuity، الزيادة 1 (docs/relay/CONTINUITY_MULTITENANT_ARCHITECTURE_REPORT.md §5.2)
--
-- لماذا
--   «عضو الشركة» و«عميل الشركة» علاقة واحدة اليوم: profiles.super_user_id =
--   مالك الشركة. company_members() تسمّيهم أعضاء، و033 تسمّي تذاكرهم «تذاكر
--   عملائي». فلا شيء في القاعدة يميّز الموظف من العميل، وأي صندوق محادثات أو
--   سجل استمرارية يُبنى على is_company_member() كان سيعطي عملاء الشركة رؤية
--   محادثات عملائها الآخرين.
--
-- القرار D2 (المالك 2026-10-12): التابعون الحاليون **عملاء** افتراضيًا. مدير
--   الشركة يضيف الموظفين صراحةً. لا ترقية تلقائية لأحد.
--
-- النموذج
--   admin       = مالك الشركة (companies.user_id). مشتق من الملكية، لا يُخزَّن،
--                 فلا ينحرف عنها. للمنادي يُشترط is_company_admin() أيضًا (الرتبة
--                 + العلاقة + سياق المالك في 040) كما في باقي لوحة الشركة.
--   supervisor  صف نشط في company_staff.
--   agent       صف نشط في company_staff.
--   (لا شيء)    عميل الشركة — كما هو اليوم تمامًا.
--
--   صف الموظف لا يُحتسب إلا والحساب **ما زال** تابعًا لنفس الشركة
--   (super_user_id = مالكها) وبرتبة company_user. وترك الشركة يُلغي الصف
--   بمحفّز (left_company)، فالعودة لاحقًا لا تعيد الصلاحية بصمت.
--
-- العزل
--   • كل الدوال بلا مُعامل شركة: الشركة تُشتق من auth.uid() عبر current_company_id().
--   • الهدف يجب أن يكون تابعًا لشركة المنادي؛ الحساب الغريب والحساب غير الموجود
--     يعطيان نفس الخطأ (P0002)، فلا يُستنتج وجود حساب في شركة أخرى.
--   • طاقم المنصة وسياق المالك لا يمنحان شيئًا هنا (القاعدة R1 في التقرير):
--     لا فرع is_platform_staff() ولا has_elevated_authority() في أي دالة.
--   • معاينة عضو الشركة (041) لا دور لها هنا (fail closed) ولا تكتب.
--   • الجداول بلا سياسة سماح وبلا صلاحيات لأي دور، ومنها service_role: القراءة
--     والكتابة عبر الدوال فقط، فمفاتيح API والدوال الطرفية لا تصل إليها.
--
-- ما لا يفعله
--   • لا يمنح الدور أي وصول بعد: لا دالة أخرى تقرأ company_staff. صندوق الشركة
--     (الزيادة 3) والاستمرارية (الزيادة 4) هما من سيستعملانه.
--   • لا يغيّر company_members() ولا remove_company_member() ولا أي سياسة قائمة.
--   • لا يغيّر chat_* ولا inbox_* ولا relay_* ولا tickets.
--   • لا إشعارات.
--
-- الاستحقاق: إدارة الفريق تستعمل can_manage_company_members() نفسها (مدير
--   الشركة + امتياز sub_users) — لا مفتاح امتياز جديد قبل القرار D5.
--
-- الترقيم (2026-10-12): كُتب أولًا باسم 077، ثم 081، ثم نُقل إلى 086 دون تغيير محتوى:
--   077–081 لسلسلة continuity (#116 → #117 → #118 → #119 → #121 → #124؛ 080 المرفقات و081
--   التسليم) و082–084 محجوزة لها، و085 لإصلاح خصوصية company_members (#120). سجل الإنتاج
--   ينتهي بـ 076_relay_trash_owner. 086 لا يعتمد على أي منها ولا هي عليه: كائناته
--   company_staff* فقط، ولا يلمس relay_*/continuity_* ولا company_members.
--
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/086_company_staff.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.current_company_id()', 'public.is_company_admin()', 'public.is_company_member()',
    'public.can_manage_company_members()', 'public.account_is_active()', 'public.preview_mode()',
    'public._inbox_account_active(uuid)', 'public.guard_preview_read_only()'] loop
    if to_regprocedure(f) is null then
      raise exception '086 يتطلب %', f;
    end if;
  end loop;
  if to_regclass('public.companies') is null or to_regclass('public.profiles') is null then
    raise exception '086 يتطلب جدولَي companies و profiles';
  end if;
end $$;


-- ============================================================================
-- 1) الجداول
-- ============================================================================
create table if not exists public.company_staff (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  role          text not null check (role in ('supervisor', 'agent')),
  granted_by    uuid,
  granted_at    timestamptz not null default now(),
  updated_by    uuid,
  updated_at    timestamptz not null default now(),
  revoked_at    timestamptz,
  revoked_by    uuid,
  revoke_cause  text check (revoke_cause in ('admin', 'left_company')),
  constraint company_staff_revoked_iff check ((revoked_at is null) = (revoke_cause is null))
);

comment on table public.company_staff is
  '086: موظفو الشركة (مشرف/موظف دعم). المالك مدير بالملكية ولا يُخزَّن. التابع بلا صف نشط = عميل. '
  'الصف يُحتسب فقط والحساب ما زال تابعًا لنفس الشركة. لا وصول مباشر — عبر company_staff_* فقط.';

-- صف نشط واحد لكل (شركة، حساب). الصفوف الملغاة تبقى سجلًا.
create unique index if not exists company_staff_one_active
  on public.company_staff (company_id, user_id) where revoked_at is null;
create index if not exists company_staff_user_active
  on public.company_staff (user_id) where revoked_at is null;

create table if not exists public.company_staff_events (
  id          bigint generated always as identity primary key,
  company_id  uuid not null,
  actor_id    uuid,
  target_id   uuid not null,
  action      text not null check (action in ('granted', 'role_changed', 'revoked')),
  role_from   text check (role_from in ('supervisor', 'agent')),
  role_to     text check (role_to in ('supervisor', 'agent')),
  cause       text check (cause in ('admin', 'left_company')),
  created_at  timestamptz not null default now()
);

comment on table public.company_staff_events is
  '086: سجل إلحاقي لتغييرات فريق الشركة (منح/تغيير دور/إلغاء). بلا مفاتيح خارجية عمدًا: '
  'السجل يبقى بعد حذف الحساب. لا تعديل ولا حذف ولا TRUNCATE.';

create index if not exists company_staff_events_company
  on public.company_staff_events (company_id, created_at desc);


-- ============================================================================
-- 2) حرّاس الجداول
-- ============================================================================

-- ثوابت الصف: الهوية والشركة والحساب لا تتغير، والصف الملغى لا يعود. والإدراج
-- يعيد فحص العلاقة نفسها (R4 في التقرير: المساواة بين المستأجرين بمحفّز لا
-- بالدوال وحدها)، فلا يمكن ربط حساب بشركة لا يتبعها مهما كان المسار.
create or replace function public._company_staff_guard_row()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if tg_op = 'INSERT' then
    if new.revoked_at is not null then
      raise exception 'لا يُدرَج صف موظف ملغى' using errcode = '23514';
    end if;
    if not exists (select 1 from public.companies c
                     join public.profiles p on p.super_user_id = c.user_id
                    where c.id = new.company_id and p.id = new.user_id and p.id <> c.user_id) then
      raise exception 'الحساب ليس تابعًا لهذه الشركة' using errcode = '23514';
    end if;
    return new;
  end if;

  -- UPDATE
  if old.revoked_at is not null then
    raise exception 'صف الموظف الملغى سجل ثابت' using errcode = '23514';
  end if;
  if new.id <> old.id or new.company_id <> old.company_id or new.user_id <> old.user_id
     or new.granted_at <> old.granted_at or new.granted_by is distinct from old.granted_by then
    raise exception 'هوية صف الموظف لا تتغير' using errcode = '23514';
  end if;
  return new;
end $$;

create or replace function public._company_staff_guard_append_only()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  raise exception 'سجل فريق الشركة إلحاقي فقط' using errcode = '23514';
end $$;

-- TRUNCATE ممنوع على الجدولين. DELETE مسموح على company_staff وحده لأن
-- الحذف المتتالي من profiles/companies يمرّ به (لا صلاحية مباشرة لأي دور).
create or replace function public._company_staff_guard_truncate()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  raise exception 'TRUNCATE ممنوع على جداول فريق الشركة' using errcode = '23514';
end $$;

drop trigger if exists trg_company_staff_guard_row on public.company_staff;
create trigger trg_company_staff_guard_row
  before insert or update on public.company_staff
  for each row execute function public._company_staff_guard_row();

drop trigger if exists trg_company_staff_no_truncate on public.company_staff;
create trigger trg_company_staff_no_truncate
  before truncate on public.company_staff
  for each statement execute function public._company_staff_guard_truncate();

drop trigger if exists trg_company_staff_events_append_only on public.company_staff_events;
create trigger trg_company_staff_events_append_only
  before update or delete on public.company_staff_events
  for each row execute function public._company_staff_guard_append_only();

drop trigger if exists trg_company_staff_events_no_truncate on public.company_staff_events;
create trigger trg_company_staff_events_no_truncate
  before truncate on public.company_staff_events
  for each statement execute function public._company_staff_guard_truncate();


-- ============================================================================
-- 3) RLS والاتفاقيات (041/042) — بلا أي سياسة سماح وبلا صلاحيات
-- ============================================================================
do $$
declare
  t text;
  tables text[] := array['company_staff', 'company_staff_events'];
begin
  foreach t in array tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);

    execute format('drop policy if exists gate_account_active on public.%I', t);
    execute format($f$
      create policy gate_account_active on public.%I
        as restrictive for all to authenticated
        using (public.account_is_active()) with check (public.account_is_active())
    $f$, t);

    execute format('drop trigger if exists trg_preview_read_only on public.%I', t);
    execute format(
      'create trigger trg_preview_read_only
         before insert or update or delete on public.%I
         for each statement execute function public.guard_preview_read_only()', t);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach t in array tables loop
      execute format('revoke all on table public.%I from service_role', t);
    end loop;
    revoke all on sequence public.company_staff_events_id_seq from service_role;
  end if;
end $$;
revoke all on sequence public.company_staff_events_id_seq from public, anon, authenticated;


-- ============================================================================
-- 4) المُسنَدات
-- ============================================================================

-- دور حساب في شركة بعينها — جانب المستلم (لتحديد من يجوز إسناد محادثة إليه
-- لاحقًا). لا يقرأ سياق المالك: السياق خاصية جلسة لا خاصية حساب مستهدف.
-- داخلية: غير ممنوحة لأي دور.
create or replace function public._company_staff_role_of(p_company uuid, p_user uuid)
returns text
language sql
stable
security definer
set search_path to 'public'
as $$
  select case
    when p_company is null or p_user is null then null
    when exists (select 1 from public.companies c where c.id = p_company and c.user_id = p_user) then 'admin'
    else (select s.role
            from public.company_staff s
            join public.companies c on c.id = s.company_id
            join public.profiles p on p.id = s.user_id
           where s.company_id = p_company
             and s.user_id = p_user
             and s.revoked_at is null
             and p.super_user_id = c.user_id
             and p.role = 'company_user')
  end;
$$;

-- موظف نشط في الشركة يجوز أن يُسند إليه عمل (غير محظور، حساب مفعّل).
create or replace function public._company_is_eligible_agent(p_company uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public._company_staff_role_of(p_company, p_user) is not null
     and coalesce(public._inbox_account_active(p_user), false);
$$;

-- دور المنادي داخل شركته: admin | supervisor | agent | null (عميل أو لا شركة).
create or replace function public.company_staff_role()
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
begin
  if auth.uid() is null
     or not coalesce(public.account_is_active(), false)
     or coalesce(public.preview_mode(), true) then
    return null;
  end if;

  v_company := public.current_company_id();
  if v_company is null then
    return null;
  end if;

  if exists (select 1 from public.companies c where c.id = v_company and c.user_id = auth.uid()) then
    -- المالك مدير فقط حين تقرّ is_company_admin() بذلك (الرتبة + سياق المالك).
    return case when coalesce(public.is_company_admin(), false) then 'admin' end;
  end if;

  if not coalesce(public.is_company_member(), false) then
    return null;
  end if;
  return public._company_staff_role_of(v_company, auth.uid());
end $$;

comment on function public.company_staff_role() is
  '086: دور المنادي في فريق شركته (admin/supervisor/agent) أو null لعميل الشركة. لا مُعاملات.';

-- بوابة الإدارة: مدير الشركة + امتياز sub_users، حساب مفعّل، خارج المعاينة.
create or replace function public._company_staff_require_manager()
returns uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
begin
  if auth.uid() is null then
    raise exception 'يجب تسجيل الدخول أولًا' using errcode = '42501';
  end if;
  if not coalesce(public.account_is_active(), false) then
    raise exception 'الحساب غير مفعّل' using errcode = '42501';
  end if;
  if coalesce(public.preview_mode(), true) then
    raise exception 'معاينة عضو الشركة للقراءة فقط — اخرج من السياق للتعديل' using errcode = '42501';
  end if;
  if not coalesce(public.is_company_admin(), false)
     or not coalesce(public.can_manage_company_members(), false) then
    raise exception 'إدارة فريق الشركة متاحة لمدير الشركة ضمن اشتراك يشمل المستخدمين الفرعيين'
      using errcode = '42501';
  end if;
  v_company := public.current_company_id();
  if v_company is null
     or not exists (select 1 from public.companies c where c.id = v_company and c.user_id = auth.uid()) then
    raise exception 'إدارة فريق الشركة لمالكها فقط' using errcode = '42501';
  end if;
  return v_company;
end $$;

create or replace function public._company_staff_json(r public.company_staff)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'user_id',    r.user_id,
    'role',       r.role,
    'granted_at', r.granted_at,
    'updated_at', r.updated_at,
    'revoked_at', r.revoked_at);
$$;


-- ============================================================================
-- 5) الـRPC العامة
-- ============================================================================

-- فريق شركة المنادي. للموظفين والمدير فقط: عميل الشركة يأخذ null، فلا يعدّد
-- موظفي الشركة. بلا بريد ولا هاتف — الاسم والدور فقط.
create or replace function public.company_staff_list()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_role    text;
  v_company uuid;
  v_owner   uuid;
  v_staff   jsonb;
begin
  v_role := public.company_staff_role();
  if v_role is null then
    return null;
  end if;
  v_company := public.current_company_id();
  select c.user_id into v_owner from public.companies c where c.id = v_company;

  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id',    x.user_id,
           'name',       coalesce(p.full_name, p.username, 'عضو'),
           'role',       x.role,
           'is_owner',   x.is_owner,
           'is_me',      (x.user_id = auth.uid()),
           'is_active',  coalesce(public._inbox_account_active(x.user_id), false),
           'granted_at', x.granted_at
         ) order by x.is_owner desc, x.role, x.granted_at), '[]'::jsonb)
    into v_staff
    from (
      select v_owner as user_id, 'admin'::text as role, true as is_owner, null::timestamptz as granted_at
      union all
      select s.user_id, s.role, false, s.granted_at
        from public.company_staff s
        join public.profiles sp on sp.id = s.user_id
       where s.company_id = v_company
         and s.revoked_at is null
         and sp.super_user_id = v_owner
         and sp.role = 'company_user'
    ) x
    join public.profiles p on p.id = x.user_id;

  return jsonb_build_object(
    'company_id', v_company,
    'my_role',    v_role,
    'can_manage', v_role = 'admin' and coalesce(public.can_manage_company_members(), false),
    'staff',      v_staff);
end $$;

comment on function public.company_staff_list() is
  '086: فريق شركة المنادي (المدير + المشرفون + موظفو الدعم). null لعميل الشركة ولمن لا شركة له.';

-- منح دور موظف لتابع في شركة المنادي، أو تغيير دوره. متكرر النتيجة: نفس الدور
-- مرتين = changed:false بلا حدث.
create or replace function public.company_staff_set(p_user uuid, p_role text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_owner   uuid;
  r         public.company_staff;
  v_prev    text;
begin
  v_company := public._company_staff_require_manager();
  select c.user_id into v_owner from public.companies c where c.id = v_company;

  if p_role is null or p_role not in ('supervisor', 'agent') then
    raise exception 'الدور يجب أن يكون مشرفًا أو موظف دعم' using errcode = '22023',
      detail = '{"code":"validation_failed","reason":"invalid_role"}';
  end if;
  if p_user is null then
    raise exception 'الحساب مطلوب' using errcode = '22023',
      detail = '{"code":"validation_failed","reason":"missing_user"}';
  end if;
  if p_user = v_owner then
    raise exception 'مالك الشركة مدير الفريق بالفعل' using errcode = '22023',
      detail = '{"code":"validation_failed","reason":"owner_is_admin"}';
  end if;

  -- قفل صف الحساب: إزالته من الشركة في نفس اللحظة تنتظر هذه المعاملة، ثم
  -- يلغي محفّز الإزالة الصف الجديد. فلا يبقى موظف لشركة تركها.
  perform 1 from public.profiles p
   where p.id = p_user and p.super_user_id = v_owner and p.role = 'company_user'
   for share;
  if not found then
    -- نفس الخطأ للحساب الغريب وغير الموجود: لا استنتاج لوجود حساب في شركة أخرى.
    raise exception 'هذا الحساب ليس عضوًا في شركتك' using errcode = 'P0002',
      detail = '{"code":"not_found"}';
  end if;
  if not coalesce(public._inbox_account_active(p_user), false) then
    raise exception 'لا يمكن إضافة حساب غير مفعّل أو محظور إلى فريق الشركة' using errcode = '22023',
      detail = '{"code":"validation_failed","reason":"target_inactive"}';
  end if;

  select * into r from public.company_staff s
   where s.company_id = v_company and s.user_id = p_user and s.revoked_at is null
   for update;

  if found then
    if r.role = p_role then
      return jsonb_build_object('changed', false, 'staff', public._company_staff_json(r));
    end if;
    v_prev := r.role;
    update public.company_staff
       set role = p_role, updated_by = auth.uid(), updated_at = now()
     where id = r.id
     returning * into r;
    insert into public.company_staff_events (company_id, actor_id, target_id, action, role_from, role_to, cause)
    values (v_company, auth.uid(), p_user, 'role_changed', v_prev, p_role, 'admin');
  else
    begin
      insert into public.company_staff (company_id, user_id, role, granted_by, updated_by)
      values (v_company, p_user, p_role, auth.uid(), auth.uid())
      returning * into r;
    exception when unique_violation then
      raise exception 'تغيّرت عضوية هذا الحساب للتو — أعد المحاولة' using errcode = '40001',
        detail = '{"code":"conflict"}';
    end;
    insert into public.company_staff_events (company_id, actor_id, target_id, action, role_to, cause)
    values (v_company, auth.uid(), p_user, 'granted', p_role, 'admin');
  end if;

  return jsonb_build_object('changed', true, 'staff', public._company_staff_json(r));
end $$;

comment on function public.company_staff_set(uuid, text) is
  '086: منح/تغيير دور موظف (supervisor|agent) لتابع في شركة المنادي. مدير الشركة + sub_users فقط.';

-- إلغاء عضوية موظف: يعود عميلًا للشركة كما كان. الحساب وعلاقته بالشركة باقيان.
create or replace function public.company_staff_revoke(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  r         public.company_staff;
begin
  v_company := public._company_staff_require_manager();

  update public.company_staff
     set revoked_at = now(), revoked_by = auth.uid(), revoke_cause = 'admin',
         updated_by = auth.uid(), updated_at = now()
   where company_id = v_company and user_id = p_user and revoked_at is null
  returning * into r;
  if not found then
    raise exception 'هذا الحساب ليس موظفًا في شركتك' using errcode = 'P0002',
      detail = '{"code":"not_found"}';
  end if;

  insert into public.company_staff_events (company_id, actor_id, target_id, action, role_from, cause)
  values (v_company, auth.uid(), p_user, 'revoked', r.role, 'admin');

  return jsonb_build_object('revoked', true, 'staff', public._company_staff_json(r));
end $$;

comment on function public.company_staff_revoke(uuid) is
  '086: إلغاء دور موظف في شركة المنادي؛ الحساب يبقى تابعًا (عميلًا). مدير الشركة + sub_users فقط.';


-- ============================================================================
-- 6) ترك الشركة يُلغي العضوية
-- ============================================================================
-- أي تغيير في super_user_id (remove_company_member، أداة إدارة، أي مسار) يلغي
-- صفوف الحساب النشطة في الشركات التي لم يعد تابعًا لها. فلو أُعيد الحساب
-- للشركة لاحقًا يعود عميلًا، ولا يستعيد دوره القديم بصمت.
create or replace function public._company_staff_on_profile_unlink()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if old.super_user_id is not distinct from new.super_user_id then
    return null;
  end if;

  with revoked as (
    update public.company_staff s
       set revoked_at = now(), revoked_by = auth.uid(), revoke_cause = 'left_company',
           updated_by = auth.uid(), updated_at = now()
      from public.companies c
     where s.user_id = new.id
       and s.revoked_at is null
       and c.id = s.company_id
       and c.user_id is distinct from new.super_user_id
    returning s.company_id, s.role
  )
  insert into public.company_staff_events (company_id, actor_id, target_id, action, role_from, cause)
  select company_id, auth.uid(), new.id, 'revoked', role, 'left_company' from revoked;

  return null;
end $$;

drop trigger if exists trg_company_staff_unlink on public.profiles;
create trigger trg_company_staff_unlink
  after update of super_user_id on public.profiles
  for each row execute function public._company_staff_on_profile_unlink();


-- ============================================================================
-- 7) الصلاحيات
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public._company_staff_guard_row()', 'public._company_staff_guard_append_only()',
    'public._company_staff_guard_truncate()', 'public._company_staff_on_profile_unlink()',
    'public._company_staff_role_of(uuid,uuid)', 'public._company_is_eligible_agent(uuid,uuid)',
    'public._company_staff_require_manager()', 'public._company_staff_json(public.company_staff)',
    'public.company_staff_role()', 'public.company_staff_list()',
    'public.company_staff_set(uuid,text)', 'public.company_staff_revoke(uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
end $$;

grant execute on function public.company_staff_role()            to authenticated;
grant execute on function public.company_staff_list()            to authenticated;
grant execute on function public.company_staff_set(uuid, text)   to authenticated;
grant execute on function public.company_staff_revoke(uuid)      to authenticated;


-- ============================================================================
-- 8) تحقق
-- ============================================================================
do $$
declare
  t text;
  f text;
begin
  foreach t in array array['company_staff', 'company_staff_events'] loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and permissive = 'PERMISSIVE') then
      raise exception '086: سياسة سماح على %', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'SELECT')
       or has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || t, 'DELETE')
       or has_table_privilege('anon', 'public.' || t, 'SELECT')
       or (exists (select 1 from pg_roles where rolname = 'service_role')
           and has_table_privilege('service_role', 'public.' || t, 'SELECT')) then
      raise exception '086: صلاحية مباشرة على %', t;
    end if;
    if not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'trg_preview_read_only')
       or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
                       and policyname = 'gate_account_active' and permissive = 'RESTRICTIVE') then
      raise exception '086: % بلا اتفاقيات 041/042', t;
    end if;
  end loop;

  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and (p.proname like 'company\_staff\_%' or p.proname like '\_company\_staff\_%'
                   or p.proname = '_company_is_eligible_agent') loop
    if has_function_privilege('anon', f, 'EXECUTE')
       or (exists (select 1 from pg_roles where rolname = 'service_role')
           and has_function_privilege('service_role', f, 'EXECUTE'))
       or (has_function_privilege('authenticated', f, 'EXECUTE')
           and f not in ('company_staff_role()', 'company_staff_list()',
                         'company_staff_set(uuid,text)', 'company_staff_revoke(uuid)')) then
      raise exception '086: دالة مكشوفة لدور غير مقصود: %', f;
    end if;
  end loop;

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public'
                and (p.proname like 'company\_staff\_%' or p.proname like '\_company\_staff\_%'
                     or p.proname = '_company_is_eligible_agent')
                and p.prosecdef and not coalesce(p.proconfig::text like '%search_path=public%', false)) then
    raise exception '086: دالة SECURITY DEFINER بلا search_path ثابت';
  end if;

  if not exists (select 1 from pg_trigger where tgrelid = 'public.profiles'::regclass
                  and tgname = 'trg_company_staff_unlink') then
    raise exception '086: محفّز ترك الشركة غير مسجّل';
  end if;

  raise notice '086: فريق الشركة جاهز (لا يمنح وصولًا بعد — لا دالة أخرى تقرأه)';
end $$;
