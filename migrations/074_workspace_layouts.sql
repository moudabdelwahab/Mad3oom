-- ============================================================================
-- 074_workspace_layouts.sql
--   ترتيب «مساحة العمل» لكل موظف (admin/workspace.html) — تفضيل واجهة فقط
--
-- ما يُحفظ: بنية التقسيمات والتبويبات وأنواع اللوحات ومعرّفات السجلات (UUID).
--   لا أسماء ولا نصوص رسائل ولا رموز جلسة: العميل يبني الحمولة بـ
--   serializeLayout() (assets/js/admin/workspace/dock-model.js)، ويعامل ما
--   يرجع من هنا كمُدخل غير موثوق (parseLayout) ثم يتحقق من وصول الموظف لكل
--   سجل عبر RLS قبل عرضه. الخادم هنا لا يفسّر الترتيب ولا يمنح به أي وصول.
--
-- الجمهور: inbox_is_agent() — نفس جمهور صندوق الرسائل (طاقم المنصة النشط
--   والمشرفون). كل موظف يرى ويكتب صفه هو فقط (auth.uid())، ولا مسار لغيره.
--
-- التعارض: آخر من يكتب يكسب (نافذتان لنفس الموظف). p_base_revision اختياري؛
--   لو لا يطابق النسخة الحالية يُكتب الترتيب أيضًا لكن يرجع conflict = true
--   فيعرف العميل أن نافذة أخرى غيّرته.
--
-- الاتفاقيات: RLS بلا أي سياسة سماح، gate_account_active (042)،
--   trg_preview_read_only (041)، بلا صلاحيات مباشرة لأي دور — الوصول عبر
--   الدالتين فقط (نفس نمط 073).
--
-- اختياري للواجهة: بدونه تحفظ مساحة العمل محليًا (localStorage) وتعمل كاملة.
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/074_workspace_layouts.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array['public.inbox_is_agent()', 'public.account_is_active()',
                           'public.preview_mode()', 'public.guard_preview_read_only()'] loop
    if to_regprocedure(f) is null then
      raise exception '074 يتطلب %', f;
    end if;
  end loop;
  if to_regclass('public.profiles') is null then
    raise exception '074 يتطلب public.profiles';
  end if;
end $$;


-- ============================================================================
-- 1) الجدول
-- ============================================================================
create table if not exists public.workspace_layouts (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  layout     jsonb not null,
  revision   bigint not null default 1,
  updated_at timestamptz not null default now(),
  constraint workspace_layouts_layout_object check (jsonb_typeof(layout) = 'object'),
  constraint workspace_layouts_layout_version check (
    jsonb_typeof(layout -> 'version') = 'number' and (layout ->> 'version') ~ '^[0-9]{1,3}$'),
  constraint workspace_layouts_layout_size check (octet_length(layout::text) <= 65536)
);

comment on table public.workspace_layouts is
  'ترتيب مساحة العمل لكل موظف (تفضيل واجهة). بنية ومعرّفات فقط — لا محتوى. '
  'الوصول عبر workspace_get_layout / workspace_save_layout فقط (074).';


-- ============================================================================
-- 2) الدوال
-- ============================================================================

-- ترتيب الموظف المحفوظ، أو لا صف.
create or replace function public.workspace_get_layout()
returns table (layout jsonb, revision bigint, updated_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.inbox_is_agent() then
    raise exception 'workspace: غير مصرح' using errcode = '42501';
  end if;
  return query
    select w.layout, w.revision, w.updated_at
      from public.workspace_layouts w
     where w.user_id = auth.uid();
end $$;

-- يحفظ ترتيب الموظف (إدراج أو استبدال). يرجع النسخة الجديدة، وconflict لو
-- كانت p_base_revision قديمة.
create or replace function public.workspace_save_layout(p_layout jsonb, p_base_revision bigint default null)
returns table (revision bigint, updated_at timestamptz, conflict boolean)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_current bigint;
begin
  if v_uid is null or not public.inbox_is_agent() then
    raise exception 'workspace: غير مصرح' using errcode = '42501';
  end if;
  if public.preview_mode() then
    raise exception 'workspace: المعاينة للقراءة فقط' using errcode = '42501';
  end if;
  if p_layout is null or jsonb_typeof(p_layout) <> 'object'
     or jsonb_typeof(p_layout -> 'version') is distinct from 'number'
     or (p_layout ->> 'version') !~ '^[0-9]{1,3}$' then
    raise exception 'workspace: ترتيب غير صالح' using errcode = '22023';
  end if;
  if octet_length(p_layout::text) > 65536 then
    raise exception 'workspace: الترتيب أكبر من المسموح' using errcode = '22023';
  end if;

  select w.revision into v_current from public.workspace_layouts w where w.user_id = v_uid for update;

  if v_current is null then
    insert into public.workspace_layouts (user_id, layout)
    values (v_uid, p_layout)
    on conflict (user_id) do update
      set layout = excluded.layout,
          revision = public.workspace_layouts.revision + 1,
          updated_at = now();
  else
    update public.workspace_layouts w
       set layout = p_layout, revision = w.revision + 1, updated_at = now()
     where w.user_id = v_uid;
  end if;

  return query
    select w.revision, w.updated_at,
           (p_base_revision is not null and v_current is not null and p_base_revision <> v_current)
      from public.workspace_layouts w
     where w.user_id = v_uid;
end $$;

comment on function public.workspace_save_layout(jsonb, bigint) is
  'يحفظ ترتيب مساحة العمل للمنادي فقط. آخر من يكتب يكسب؛ conflict = true لو النسخة المرجعية قديمة.';


-- ============================================================================
-- 3) RLS والاتفاقيات (041/042) — بلا أي سياسة سماح وبلا صلاحيات مباشرة
-- ============================================================================
alter table public.workspace_layouts enable row level security;
revoke all on table public.workspace_layouts from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table public.workspace_layouts from service_role;
  end if;
end $$;

drop policy if exists gate_account_active on public.workspace_layouts;
create policy gate_account_active on public.workspace_layouts
  as restrictive for all to authenticated
  using (public.account_is_active()) with check (public.account_is_active());

drop trigger if exists trg_preview_read_only on public.workspace_layouts;
create trigger trg_preview_read_only
  before insert or update or delete on public.workspace_layouts
  for each statement execute function public.guard_preview_read_only();

revoke all on function public.workspace_get_layout() from public, anon;
revoke all on function public.workspace_save_layout(jsonb, bigint) from public, anon;
grant execute on function public.workspace_get_layout() to authenticated;
grant execute on function public.workspace_save_layout(jsonb, bigint) to authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public.workspace_get_layout() from service_role;
    revoke all on function public.workspace_save_layout(jsonb, bigint) from service_role;
  end if;
end $$;


-- ============================================================================
-- 4) تحقق
-- ============================================================================
do $$
declare f text;
begin
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'workspace_layouts'
                and permissive = 'PERMISSIVE') then
    raise exception '074: سياسة سماح على workspace_layouts';
  end if;
  if has_table_privilege('authenticated', 'public.workspace_layouts', 'SELECT')
     or has_table_privilege('authenticated', 'public.workspace_layouts', 'INSERT')
     or has_table_privilege('authenticated', 'public.workspace_layouts', 'UPDATE')
     or has_table_privilege('authenticated', 'public.workspace_layouts', 'DELETE')
     or has_table_privilege('anon', 'public.workspace_layouts', 'SELECT') then
    raise exception '074: صلاحية مباشرة على workspace_layouts';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.workspace_layouts'::regclass
                    and tgname = 'trg_preview_read_only')
     or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'workspace_layouts'
                       and policyname = 'gate_account_active' and permissive = 'RESTRICTIVE') then
    raise exception '074: workspace_layouts بلا اتفاقيات 041/042';
  end if;
  foreach f in array array['public.workspace_get_layout()', 'public.workspace_save_layout(jsonb,bigint)'] loop
    if has_function_privilege('anon', f, 'EXECUTE') then
      raise exception '074: % مكشوفة لـ anon', f;
    end if;
    if not has_function_privilege('authenticated', f, 'EXECUTE') then
      raise exception '074: % غير متاحة لـ authenticated', f;
    end if;
  end loop;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname in ('workspace_get_layout', 'workspace_save_layout')
                and (not p.prosecdef or not coalesce(p.proconfig::text like '%search_path=public%', false))) then
    raise exception '074: دالة بلا SECURITY DEFINER أو بلا search_path ثابت';
  end if;
  raise notice '074: ترتيب مساحة العمل جاهز';
end $$;
