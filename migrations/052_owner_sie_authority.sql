-- ============================================================================
-- 052_owner_sie_authority.sql
--   سلطة مالك المنصة المطلقة على SIE، ونقل «مدير SIE» من البريد إلى البيانات.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ما وُجد على الإنتاج قبل هذا الترحيل
-- ════════════════════════════════════════════════════════════════════════════
--
-- كل سطح إداري في SIE يمرّ بمُسنَدين اثنين لا ثالث لهما:
--
--   is_chat_engine_staff()  ← RLS على sie_settings (تشغيل/إيقاف المحرك وكل
--                              الإعدادات) و chat_engine_* و sie_customer_memory…
--   is_sie_admin()          ← RLS على customer_sie_access و sie_rate_limit_*
--                              و sie_api_keys، وكل RPC من sie_admin_* و sie_api_key_*
--
-- وكان الأول = is_platform_staff() — أي أن المالك لا يملكه إلا داخل سياق
-- owner/admin (040). والثاني كان **مكتوبًا بالبريد**:
--
--     return (select email from auth.users where id = auth.uid()) = 'support@mad3oom.online';
--
-- فمالك المنصة لم يكن مدير SIE إطلاقًا، في أي سياق. وهذه هي الحالة الوحيدة
-- الباقية في طبقة التفويض التي تقرأ بريدًا — بالضبط ما أزاله 040 من غيرها.
--
-- ════════════════════════════════════════════════════════════════════════════
-- التصميم — امتداد لـ038 لا معمار موازٍ
-- ════════════════════════════════════════════════════════════════════════════
--
--   ① sie_owner_authority() = is_platform_owner() ∧ ¬preview_mode()
--      is_platform_owner() هو نفس المصدر الوحيد لملكية المنصة (صف owner في
--      platform_authority **و** رتبة platform_owner) — لا بريد، ولا يُكتب من
--      جلسة. فلا طريق جديد للملكية.
--
--      لماذا لا يُرشَّح بالسياق كبقية سلطة المالك؟ لأن المطلوب صراحةً سلطة
--      **مطلقة** على SIE تتجاوز قيوده العادية. لوحة إدارة SIE تطبيق مستقل على
--      أصل آخر، وليست من «واجهات» 038 — فربطها بسياق لوحة المنصة كان سيجعل
--      المالك يفقد التحكم في المحرك كلما انتهت صلاحية سياقه (12 ساعة) أو
--      دخل واجهة العميل ليراجع تجربة عملائه.
--
--      الاستثناء الوحيد: معاينة عضو الشركة. عقيدة 041 أن المعاينة ⊆ صلاحيات
--      العضو الحقيقي، والعضو لا يملك شيئًا من SIE — فلا نكسرها.
--
--   ② sie_admin_grants — مدير SIE كبيانات، لا كبريد. زُرع فيه support@ (صاحب
--      الصلاحية اليوم) فلا يفقد أحد شيئًا. والمنح مشروط أيضًا برتبة فريق
--      المنصة (admin/support)، بنفس الاشتراط المزدوج في 035/038: من زوّر
--      الرتبة يفتقد المنح، ومن حصل على المنح بلا رتبة لا يملك شيئًا.
--
--   ③ المنح والسحب عبر RPC لا يناديه إلا المالك، وكل منح/سحب يُسجَّل في
--      سجل غير قابل للتعديل. لا سياسة كتابة على الجدولين إطلاقًا.
--
--   ④ platform_authority كانت تُقرأ صفًّا صفًّا لصاحبه فقط — فقسم «السلطة
--      والمنح» في لوحة المالك لم يعرض إلا المالك نفسه، ولم يُظهر الحسابات
--      المرتفعة. أُضيفت سياسة قراءة للمالك داخل سياق «مالك المنصة» وحده
--      (نفس شرط سجل السياق)؛ الكتابة ما زالت للترحيلات وحدها.
--
-- ما لا يفعله هذا الترحيل
--   • لا يعطّل RLS ولا يوسّع صلاحية أي حساب غير المالك
--   • لا يمسّ is_platform_staff() ولا سياق أي لوحة أخرى
--   • لا يسمح لأي جلسة بأن تصير مالكًا أو تكتب platform_authority
-- ============================================================================

do $$
begin
  if to_regprocedure('public.is_platform_owner()') is null
     or to_regprocedure('public.preview_mode()') is null
     or to_regprocedure('public.owner_capability(text)') is null
     or to_regprocedure('public.is_platform_staff()') is null
     or to_regclass('public.platform_authority') is null then
    raise exception 'يجب تطبيق migrations/038 → 041 أولًا';
  end if;
end $$;


-- ============================================================================
-- 1) سلطة المالك على SIE — مصدرها سلطة المنصة نفسها
-- ============================================================================

create or replace function public.sie_owner_authority()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  -- coalesce لنفس سبب 040: أي NULL هنا كان سيُسقط حارسًا بصمت.
  select coalesce(public.is_platform_owner() and not public.preview_mode(), false);
$$;

comment on function public.sie_owner_authority() is
  'سلطة مالك المنصة المطلقة على SIE: is_platform_owner() خارج معاينة عضو الشركة. '
  'لا تقرأ بريدًا ولا سياق لوحة — لوحة SIE ليست من واجهات 038.';

revoke all on function public.sie_owner_authority() from public, anon;
grant execute on function public.sie_owner_authority() to authenticated;


-- ============================================================================
-- 2) مديرو SIE كبيانات — بدل البريد المكتوب في جسم الدالة
-- ============================================================================

create table if not exists public.sie_admin_grants (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  granted_by  uuid references auth.users(id) on delete set null,
  granted_at  timestamptz not null default now(),
  note        text
);

comment on table public.sie_admin_grants is
  'من يملك إدارة وصول العملاء إلى SIE غير المالك. يُكتب عبر owner_grant_sie_admin / '
  'owner_revoke_sie_admin وحدهما، ولا يسري إلا مع رتبة admin/support.';

alter table public.sie_admin_grants enable row level security;

drop policy if exists sie_admin_grants_select on public.sie_admin_grants;
create policy sie_admin_grants_select on public.sie_admin_grants
  for select to authenticated
  using (user_id = auth.uid() or public.sie_owner_authority());

-- لا سياسة كتابة ⇒ الكتابة المباشرة مرفوضة لكل جلسة.
revoke all on table public.sie_admin_grants from public, anon, authenticated;
grant select on table public.sie_admin_grants to authenticated;

-- حزام ثانٍ: حتى لو مُنحت صلاحية كتابة يومًا بالخطأ، لا يكتب إلا المالك
-- (عبر الـRPC) أو ترحيل/مفتاح خدمة بلا auth.uid().
create or replace function public.guard_sie_admin_grants_write()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is not null and not public.sie_owner_authority() then
    raise exception 'sie_admin_grants تُكتب من مالك المنصة وحده' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function public.guard_sie_admin_grants_write() from public, anon, authenticated;

drop trigger if exists trg_guard_sie_admin_grants on public.sie_admin_grants;
create trigger trg_guard_sie_admin_grants
  before insert or update or delete on public.sie_admin_grants
  for each row execute function public.guard_sie_admin_grants_write();


-- سجل المنح والسحب — append-only، بنفس نمط owner_context_audit
create table if not exists public.sie_authority_audit (
  id              bigint generated always as identity primary key,
  actor_id        uuid,
  action          text not null check (action in ('grant', 'revoke')),
  target_user_id  uuid not null,
  at              timestamptz not null default now(),
  note            text
);

create index if not exists sie_authority_audit_at on public.sie_authority_audit (at desc);

alter table public.sie_authority_audit enable row level security;

drop policy if exists sie_authority_audit_select on public.sie_authority_audit;
create policy sie_authority_audit_select on public.sie_authority_audit
  for select to authenticated
  using (public.sie_owner_authority());

revoke all on table public.sie_authority_audit from public, anon, authenticated;
grant select on table public.sie_authority_audit to authenticated;

create or replace function public.guard_sie_authority_audit_immutable()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  raise exception 'sie_authority_audit لا يُعدَّل ولا يُحذف' using errcode = '42501';
end;
$$;

revoke all on function public.guard_sie_authority_audit_immutable() from public, anon, authenticated;

drop trigger if exists trg_sie_authority_audit_immutable on public.sie_authority_audit;
create trigger trg_sie_authority_audit_immutable
  before update or delete on public.sie_authority_audit
  for each row execute function public.guard_sie_authority_audit_immutable();


-- زرع صاحب الصلاحية الحالي — حتى لا يفقد أحد شيئًا بإزالة البريد من الدالة.
-- البريد هنا **بيانات ترحيل** تُقرأ مرة واحدة (كما في 039)، لا منطق تفويض.
insert into public.sie_admin_grants (user_id, note)
select u.id, 'منقول من is_sie_admin() المبنية على البريد — 052'
  from auth.users u
 where lower(u.email) = 'support@mad3oom.online'
on conflict (user_id) do nothing;


-- ============================================================================
-- 3) المُسنَدان — بلا بريد، والمالك فوق القيود العادية
-- ============================================================================

create or replace function public.is_sie_admin()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.sie_owner_authority()
      or exists (
           select 1
             from public.sie_admin_grants g
             join public.profiles p on p.id = g.user_id
            where g.user_id = auth.uid()
              and p.role in ('admin', 'support')
         );
$$;

comment on function public.is_sie_admin() is
  'إدارة وصول العملاء إلى SIE: مالك المنصة (sie_owner_authority) أو منح صريح في '
  'sie_admin_grants مع رتبة فريق المنصة. لا يقرأ بريدًا.';

-- الصلاحيات على الدالة تبقى كما هي (create or replace يحفظها): سياسات RLS على
-- {public} تستدعيها حتى لجلسات anon، وسحبها كان سيحوّل «لا صفوف» إلى خطأ.


create or replace function public.is_chat_engine_staff()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.is_platform_staff() or public.sie_owner_authority();
$$;

comment on function public.is_chat_engine_staff() is
  'طاقم محرك المحادثة (الإعدادات، تشغيل/إيقاف المحرك، الكتالوج): فريق المنصة، '
  'ومالك المنصة في أي سياق عدا معاينة العضو.';

-- الصلاحيات على الدالة تبقى كما هي (create or replace يحفظها): سياسات RLS على
-- {public} تستدعيها حتى لجلسات anon، وسحبها كان سيحوّل «لا صفوف» إلى خطأ.


-- ============================================================================
-- 4) إدارة مديري SIE — المالك وحده
-- ============================================================================

create or replace function public.owner_grant_sie_admin(p_user_id uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_role text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not public.sie_owner_authority() then
    raise exception 'منح إدارة SIE لمالك المنصة وحده' using errcode = '42501';
  end if;

  select p.role into v_role from public.profiles p where p.id = p_user_id;
  if v_role is null then
    raise exception 'الحساب غير موجود' using errcode = '22023';
  end if;
  -- منح لا يسري لا يُكتب: is_sie_admin() تشترط رتبة فريق المنصة.
  if v_role not in ('admin', 'support') then
    raise exception 'إدارة SIE تُمنح لأعضاء فريق المنصة فقط (admin أو support)'
      using errcode = '22023';
  end if;

  insert into public.sie_admin_grants (user_id, granted_by, note)
  values (p_user_id, auth.uid(), v_note)
  on conflict (user_id) do update
    set granted_by = excluded.granted_by,
        granted_at = now(),
        note       = excluded.note;

  insert into public.sie_authority_audit (actor_id, action, target_user_id, note)
  values (auth.uid(), 'grant', p_user_id, v_note);
end;
$$;

revoke all on function public.owner_grant_sie_admin(uuid, text) from public, anon;
grant execute on function public.owner_grant_sie_admin(uuid, text) to authenticated;


create or replace function public.owner_revoke_sie_admin(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_deleted int;
begin
  if not public.sie_owner_authority() then
    raise exception 'سحب إدارة SIE لمالك المنصة وحده' using errcode = '42501';
  end if;

  delete from public.sie_admin_grants where user_id = p_user_id;
  get diagnostics v_deleted = row_count;

  if v_deleted > 0 then
    insert into public.sie_authority_audit (actor_id, action, target_user_id)
    values (auth.uid(), 'revoke', p_user_id);
  end if;
  return v_deleted > 0;
end;
$$;

revoke all on function public.owner_revoke_sie_admin(uuid) from public, anon;
grant execute on function public.owner_revoke_sie_admin(uuid) to authenticated;


-- ============================================================================
-- 5) «السلطة والمنح» — المالك يرى كل صفوف السلطة داخل سياقه
-- ============================================================================
-- سياسة إضافية (PERMISSIVE تُجمع بـOR مع قراءة الصف الذاتي). owner_only لا
-- تتحقق إلا في سياق «مالك المنصة» — نفس شرط قراءة owner_context_audit.

drop policy if exists platform_authority_select_owner on public.platform_authority;
create policy platform_authority_select_owner on public.platform_authority
  for select to authenticated
  using (public.owner_capability('owner_only'));


-- ============================================================================
-- 6) تحقق
-- ============================================================================
do $$
begin
  if pg_get_functiondef('public.is_sie_admin()'::regprocedure) ~* '(email|@mad3oom)' then
    raise exception 'is_sie_admin ما زالت تقرأ بريدًا';
  end if;
  if pg_get_functiondef('public.is_sie_admin()'::regprocedure) !~ 'sie_owner_authority' then
    raise exception 'is_sie_admin لا تعترف بسلطة المالك';
  end if;
  if pg_get_functiondef('public.is_chat_engine_staff()'::regprocedure) !~ 'sie_owner_authority' then
    raise exception 'is_chat_engine_staff لا تعترف بسلطة المالك';
  end if;
  if exists (select 1 from pg_policies
              where schemaname = 'public'
                and tablename in ('sie_admin_grants', 'sie_authority_audit', 'platform_authority')
                and cmd <> 'SELECT') then
    raise exception 'سياسة كتابة على جدول سلطة';
  end if;
  raise notice '052: المالك يملك SIE بسلطة المنصة، ومدير SIE بيانات لا بريد';
end $$;
