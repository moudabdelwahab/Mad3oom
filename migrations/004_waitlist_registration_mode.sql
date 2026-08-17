-- ============================================================
-- Pre-launch Waitlist: registration mode + waitlist_entries table
-- ============================================================
-- Adds a "Registration Mode" toggle (Open Registration / Waitlist),
-- stored under the existing `advanced_settings` key/value system
-- (key = 'registration_mode'), and a dedicated `waitlist_entries`
-- table to collect visitor sign-ups while the platform is in
-- pre-launch mode. Does not touch auth.users, profiles, or any
-- existing signup/login flow.
-- ============================================================

-- 1) Waitlist entries table --------------------------------------------
create table if not exists public.waitlist_entries (
    id uuid primary key default gen_random_uuid(),
    name text not null check (char_length(btrim(name)) > 0),
    email text not null check (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
    phone text,
    status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
    created_at timestamptz not null default now(),
    reviewed_at timestamptz,
    reviewed_by uuid references public.profiles(id) on delete set null
);

comment on table public.waitlist_entries is 'تسجيلات قائمة الانتظار في مرحلة ما قبل إطلاق المنصة (Registration Mode = Waitlist).';

-- Only one active (pending/approved) entry per email; a rejected entry
-- does not block re-registration with the same email.
create unique index if not exists waitlist_entries_active_email_idx
    on public.waitlist_entries (lower(email))
    where status <> 'rejected';

create index if not exists waitlist_entries_status_idx on public.waitlist_entries (status);
create index if not exists waitlist_entries_created_at_idx on public.waitlist_entries (created_at desc);

alter table public.waitlist_entries enable row level security;

-- Anonymous visitors may only INSERT a new pending entry with their own
-- data - never read, update, or delete, and never self-approve.
create policy "waitlist_entries_anon_insert"
    on public.waitlist_entries
    for insert
    to anon
    with check (
        status = 'pending'
        and reviewed_at is null
        and reviewed_by is null
    );

-- Admins (same predicate already used by the "advanced_settings" policy)
-- have full control: view, search, approve, reject.
create policy "waitlist_entries_admin_all"
    on public.waitlist_entries
    for all
    to authenticated
    using (
        exists (
            select 1 from public.profiles
            where profiles.id = auth.uid() and profiles.role = 'admin'
        )
    )
    with check (
        exists (
            select 1 from public.profiles
            where profiles.id = auth.uid() and profiles.role = 'admin'
        )
    );

-- 2) Registration mode setting ------------------------------------------
-- Reuses the existing advanced_settings key/value table instead of a new
-- settings table. The value is public-facing (mode + message + launch
-- date shown to anonymous visitors on the registration page), so it gets
-- a narrow, key-scoped read policy - not a blanket anon read on the whole
-- advanced_settings table.
create policy "advanced_settings_public_read_registration_mode"
    on public.advanced_settings
    for select
    to anon, authenticated
    using (key = 'registration_mode');

insert into public.advanced_settings (key, value)
values (
    'registration_mode',
    jsonb_build_object(
        'mode', 'open',
        'waitlist_message',
            'شكرًا لتسجيلك في مدعوم.' || E'\n\n' ||
            'نستعد حاليًا للإطلاق الرسمي للمنصة، وحرصًا منا على تقديم أفضل تجربة وجودة خدمة منذ اليوم الأول، سيتم إضافة بياناتك إلى قائمة الانتظار في الوقت الحالي.' || E'\n\n' ||
            'عند الإطلاق، سنرسل إليك رابط تفعيل حسابك مباشرة.' || E'\n\n' ||
            'موعد الإطلاق المتوقع: {{launch_date}}' || E'\n\n' ||
            'نشكرك على اهتمامك بمدعوم، ونتطلع لانضمامك إلينا.',
        'expected_launch_date', 'أكتوبر 2026'
    )
)
on conflict (key) do nothing;
