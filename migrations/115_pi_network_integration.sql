-- ============================================================================
-- 115 — تكامل Pi Network: إعدادات المالك، أسعار الخطط بالـPi، وسجل المدفوعات
--
-- ثلاثة جداول جديدة، ولا تعديل على أي جدول قائم:
--   pi_settings     صف واحد: تفعيل الدفع بـPi، والشبكة (testnet / mainnet).
--   pi_plan_prices  سعر كل خطة بالـPi (شهري / سنوي). يقرؤه كل مسجّل، ويكتبه المالك.
--   pi_payments     سجل مدفوعات U2A. تكتبه دالة pi-payments بدور الخدمة وحدها.
--
-- مفتاح Pi API **لا يُخزَّن في القاعدة**: سرّ Edge Function باسم PI_API_KEY.
-- الصلاحيات مفروضة بـRLS عبر is_platform_owner()، لا بالواجهة.
-- التراجع: migrations/_rollback/115_pi_network_integration.down.sql
-- ============================================================================

create table if not exists public.pi_settings (
  id boolean primary key default true check (id),
  payments_enabled boolean not null default false,
  network text not null default 'testnet' check (network in ('testnet','mainnet')),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
insert into public.pi_settings (id) values (true) on conflict do nothing;

create table if not exists public.pi_plan_prices (
  plan_id uuid primary key references public.subscription_plans(id) on delete cascade,
  price_monthly_pi numeric(18,7) check (price_monthly_pi is null or price_monthly_pi > 0),
  price_yearly_pi  numeric(18,7) check (price_yearly_pi  is null or price_yearly_pi  > 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

create table if not exists public.pi_payments (
  id uuid primary key default gen_random_uuid(),
  pi_payment_id text not null unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  pi_uid text,
  plan_id uuid references public.subscription_plans(id),
  billing_cycle text check (billing_cycle in ('monthly','yearly')),
  amount numeric(18,7) not null,
  memo text,
  network text not null check (network in ('testnet','mainnet')),
  status text not null default 'approved'
    check (status in ('approved','completed','cancelled','failed')),
  txid text,
  error text,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists pi_payments_user_idx on public.pi_payments(user_id);
create index if not exists pi_payments_created_idx on public.pi_payments(created_at desc);

-- الفاعل والوقت يكتبهما الخادم، لا العميل
create or replace function public.pi_stamp_updated()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  if tg_table_name in ('pi_settings','pi_plan_prices') then
    new.updated_by := auth.uid();
  end if;
  return new;
end $$;

drop trigger if exists pi_settings_stamp on public.pi_settings;
create trigger pi_settings_stamp before update on public.pi_settings
  for each row execute function public.pi_stamp_updated();
drop trigger if exists pi_plan_prices_stamp on public.pi_plan_prices;
create trigger pi_plan_prices_stamp before insert or update on public.pi_plan_prices
  for each row execute function public.pi_stamp_updated();
drop trigger if exists pi_payments_stamp on public.pi_payments;
create trigger pi_payments_stamp before update on public.pi_payments
  for each row execute function public.pi_stamp_updated();

alter table public.pi_settings    enable row level security;
alter table public.pi_plan_prices enable row level security;
alter table public.pi_payments    enable row level security;

-- الإعدادات: المالك وحده يقرأ ويعدّل الصف الوحيد
create policy pi_settings_owner_select on public.pi_settings
  for select to authenticated using (public.is_platform_owner());
create policy pi_settings_owner_update on public.pi_settings
  for update to authenticated using (public.is_platform_owner()) with check (public.is_platform_owner());

-- الأسعار: قراءة لكل مسجّل (صفحة الدفع لاحقًا)، وكتابة للمالك
create policy pi_plan_prices_read on public.pi_plan_prices
  for select to authenticated using (true);
create policy pi_plan_prices_owner_insert on public.pi_plan_prices
  for insert to authenticated with check (public.is_platform_owner());
create policy pi_plan_prices_owner_update on public.pi_plan_prices
  for update to authenticated using (public.is_platform_owner()) with check (public.is_platform_owner());
create policy pi_plan_prices_owner_delete on public.pi_plan_prices
  for delete to authenticated using (public.is_platform_owner());

-- المدفوعات: المالك يرى الكل، والمستخدم يرى مدفوعاته. الكتابة لدور الخدمة وحده.
create policy pi_payments_owner_select on public.pi_payments
  for select to authenticated using (public.is_platform_owner());
create policy pi_payments_own_select on public.pi_payments
  for select to authenticated using (user_id = auth.uid());

revoke insert, update, delete on public.pi_payments from anon, authenticated;
revoke insert, delete on public.pi_settings from anon, authenticated;
revoke all on public.pi_settings, public.pi_plan_prices, public.pi_payments from anon;
revoke execute on function public.pi_stamp_updated() from public, anon, authenticated;
