-- ============================================================================
-- 091_company_feature_overrides.sql
--   استثناء امتياز لشركة بعينها، دون تعديل أي باقة أو اشتراك.
--
-- لماذا
--   company_has_feature() تقرر الامتياز من الباقة وحدها (whatsapp_subscriptions →
--   subscription_plans → plan_features). تجربة مركز التكاملات على شركة واحدة (طلب صاحب المنصة
--   2026-10-13: «فعّل Integrations Hub لشركتي فقط … دون تعديل الخطط العامة») تحتاج منحًا
--   لشركة واحدة، ومنح الباقة يفتحه لكل مشتركيها.
--
-- ما يضيفه
--   • public.company_feature_overrides (company_id, feature_key, reason, granted_by, granted_at,
--     expires_at): منح لشركة واحدة، اختياريًا بتاريخ انتهاء. مقيَّد الآن بـ integrations_hub
--     وحده (قيد CHECK) — توسيعه قرار لاحق بترحيل.
--   • company_has_feature(): نفس شرط الباقة حرفيًا **أو** استثناء ساري لشركة المنادي. إضافة
--     فقط: لا شركة تفقد امتيازًا كان لها، ولا تتغير الصلاحيات (authenticated, service_role).
--
-- من يكتب الاستثناء
--   لا أحد عبر الواجهة: الجدول بلا سياسة سماح وبلا صلاحية لأي دور (ومنها service_role).
--   يُضاف صف من محرر SQL للمالك فقط، ويُسجَّل في ihub_audit_events.
--
-- يعتمد على 088 (مفتاح integrations_hub في feature_flags). قابل لإعادة التشغيل.
-- التراجع: migrations/_rollback/091_company_feature_overrides.down.sql (يعيد الدالة حرفيًا)
-- ============================================================================

do $$
begin
  if to_regprocedure('public.company_has_feature(text)') is null
     or to_regprocedure('public.current_company_id()') is null then
    raise exception '091: يتطلب company_has_feature و current_company_id';
  end if;
  if not exists (select 1 from public.feature_flags where key = 'integrations_hub') then
    raise exception '091: يتطلب 088 (feature_flags integrations_hub)';
  end if;
end $$;

create table if not exists public.company_feature_overrides (
  company_id   uuid not null references public.companies(id) on delete cascade,
  feature_key  text not null references public.feature_flags(key) on delete cascade,
  reason       text not null check (char_length(reason) between 3 and 300),
  granted_by   uuid,
  granted_at   timestamptz not null default now(),
  expires_at   timestamptz,
  primary key (company_id, feature_key),
  constraint company_feature_overrides_pilot_only check (feature_key in ('integrations_hub'))
);
comment on table public.company_feature_overrides is
  '091: منح امتياز لشركة واحدة بلا تعديل باقة. مقيَّد بـ integrations_hub. يكتبه المالك من محرر SQL فقط.';

alter table public.company_feature_overrides enable row level security;
revoke all on table public.company_feature_overrides from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table public.company_feature_overrides from service_role;
  end if;
end $$;
drop policy if exists gate_account_active on public.company_feature_overrides;
create policy gate_account_active on public.company_feature_overrides
  as restrictive for all to authenticated
  using (public.account_is_active()) with check (public.account_is_active());
drop trigger if exists trg_preview_read_only on public.company_feature_overrides;
create trigger trg_preview_read_only
  before insert or update or delete on public.company_feature_overrides
  for each statement execute function public.guard_preview_read_only();

-- شرط الباقة كما هو حرفيًا (021)، ثم الاستثناء.
create or replace function public.company_has_feature(p_feature_key text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1
      from public.companies c
      join public.whatsapp_subscriptions s on (s.company_id = c.id or s.user_id = c.user_id)
      join public.subscription_plans sp on sp.key = s.plan
      join public.plan_features pf on pf.plan_id = sp.id and pf.enabled = true
     where c.id = public.current_company_id()
       and s.status = 'active'
       and s.start_date <= now()
       and s.end_date   >  now()
       and pf.feature_key = p_feature_key)
  or exists (
    select 1
      from public.company_feature_overrides o
     where o.company_id = public.current_company_id()
       and o.feature_key = p_feature_key
       and (o.expires_at is null or o.expires_at > now()));
$function$;

comment on function public.company_has_feature(text) is
  'هل تملك شركة المستخدم الحالي هذا الامتياز عبر اشتراك فعّال، أو عبر استثناء ساري في company_feature_overrides (091)؟ لا تأخذ معرّف شركة كمُعامل عمدًا — لا يوجد ما يُلاعَب به.';

-- التحقق
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.company_feature_overrides'::regclass) then
    raise exception '091: RLS غير مفعّل';
  end if;
  if exists (select 1 from pg_policy where polrelid = 'public.company_feature_overrides'::regclass and polpermissive) then
    raise exception '091: سياسة سماح على جدول الاستثناءات';
  end if;
  if has_table_privilege('authenticated', 'public.company_feature_overrides', 'SELECT')
     or has_table_privilege('authenticated', 'public.company_feature_overrides', 'INSERT')
     or has_table_privilege('anon', 'public.company_feature_overrides', 'SELECT') then
    raise exception '091: جدول الاستثناءات مكشوف';
  end if;
  if not has_function_privilege('authenticated', 'public.company_has_feature(text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.company_has_feature(text)', 'EXECUTE') then
    raise exception '091: صلاحيات company_has_feature تغيّرت';
  end if;
  raise notice '091: استثناءات الامتياز لكل شركة جاهزة (integrations_hub فقط)';
end $$;
