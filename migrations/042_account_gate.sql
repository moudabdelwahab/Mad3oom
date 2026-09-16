-- ============================================================
-- بوابة الحساب: رقم هاتف إلزامي + كود مرور بديل + قائمة انتظار
-- ============================================================
-- طُبِّقت على المشروع في ثلاث هجرات:
--   account_gate_core
--   account_gate_data_and_phone_trigger
--   account_gate_restrictive_policies
--
-- مبدأ التنفيذ: الفرض الحقيقي في قاعدة البيانات عبر سياسات RESTRICTIVE
-- تُدمج بـ AND فوق السياسات القائمة — فلا تُعدَّل ولا تُحذف أي سياسة من
-- الـ 302 الموجودة، والتراجع = حذف سياسات gate_account_active وحدها.
-- الواجهة مسؤولة عن تجربة الاستخدام فقط، وليست نقطة منع.
-- ============================================================

-- ── 1) توحيد صيغة الهاتف (E.164) ──────────────────────────
create or replace function public.normalize_phone(p_phone text)
returns text language plpgsql immutable
set search_path to ''
as $$
declare v text;
begin
  if p_phone is null or btrim(p_phone) = '' then return null; end if;
  v := regexp_replace(p_phone, '[^0-9+]', '', 'g');
  if v ~ '^00[1-9][0-9]{7,14}$' then v := '+' || substring(v from 3); end if;
  if v ~ '^01[0-9]{9}$'         then v := '+2' || v; end if;   -- رقم مصري محلي
  if v ~ '^[1-9][0-9]{9,14}$'   then v := '+' || v; end if;    -- دولي بلا +
  if v ~ '^\+[1-9][0-9]{7,14}$' then return v; end if;
  return null;
end;
$$;

-- ── 2) رقم واتساب منفصل ───────────────────────────────────
-- لا نلمس profiles.whatsapp_enabled: هو علم صلاحية وحدة واتساب تضبطه
-- recompute_user_access، ولا علاقة له بكون الرقم مفعّلًا عليه واتساب.
alter table public.profiles add column if not exists whatsapp_phone text;

-- ── 3) جداول كود المرور ───────────────────────────────────
create table if not exists public.access_passcodes (
  id         uuid primary key default gen_random_uuid(),
  label      text not null default '',
  code_hash  text not null,
  is_active  boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists public.passcode_redemptions (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  passcode_id uuid not null references public.access_passcodes(id) on delete cascade,
  redeemed_at timestamptz not null default now()
);

create index if not exists passcode_redemptions_passcode_idx
  on public.passcode_redemptions (passcode_id);

alter table public.access_passcodes     enable row level security;
alter table public.passcode_redemptions enable row level security;

drop policy if exists access_passcodes_owner_all on public.access_passcodes;
create policy access_passcodes_owner_all on public.access_passcodes
  for all to authenticated
  using (public.is_platform_owner()) with check (public.is_platform_owner());

drop policy if exists passcode_redemptions_select on public.passcode_redemptions;
create policy passcode_redemptions_select on public.passcode_redemptions
  for select to authenticated
  using (user_id = auth.uid() or public.is_platform_owner());

-- ── 4) لحظة تفعيل البوابة ─────────────────────────────────
create or replace function public.gate_cutoff()
returns timestamptz language sql immutable
set search_path to ''
as $$
  select timestamptz '2026-09-16 00:00:00+00';
$$;

-- ── 5) الاستثناء الدائم: مالك المنصة ──────────────────────
create or replace function public.gate_is_exempt_account(p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path to 'public' as $$
  select p_user_id is not null
     and exists (select 1 from public.profiles p
                  where p.id = p_user_id and lower(p.email) = 'mahmoud@mad3oom.com');
$$;

-- ── 6) القائمة البيضاء ────────────────────────────────────
create or replace function public.account_is_whitelisted(p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path to 'public' as $$
  with me as (
    select p.id, lower(p.email) as email, p.role, p.created_at
      from public.profiles p where p.id = p_user_id
  )
  select p_user_id is not null and exists (select 1 from me) and (
    public.gate_is_exempt_account(p_user_id)
    or (select role from me) in
         ('admin','support','platform_owner','company_admin','company_user')
    or exists (select 1 from public.waitlist_entries w
                where w.status = 'approved'
                  and (w.approved_user_id = p_user_id
                       or lower(w.email) = (select email from me)))
    or ((select created_at from me) < public.gate_cutoff()
        and not exists (select 1 from public.waitlist_entries w
                         where w.status in ('pending','rejected')
                           and (w.approved_user_id = p_user_id
                                or lower(w.email) = (select email from me))))
  );
$$;

-- ── 7) التحقق: هاتف أو كود مرور فعّال ─────────────────────
create or replace function public.account_verification_ok(p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path to 'public' as $$
  select p_user_id is not null and (
       public.normalize_phone((select p.phone from public.profiles p where p.id = p_user_id)) is not null
    or exists (select 1 from public.passcode_redemptions r
                 join public.access_passcodes c on c.id = r.passcode_id
                where r.user_id = p_user_id and c.is_active));
$$;

-- ── 8) البوابة النهائية ───────────────────────────────────
create or replace function public.account_is_active()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(
    public.gate_is_exempt_account(auth.uid())
    or (public.account_is_whitelisted(auth.uid()) and public.account_verification_ok(auth.uid())),
    false);
$$;

-- ── 9) حالة البوابة للواجهة ───────────────────────────────
create or replace function public.my_account_gate()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select case
    when auth.uid() is null then jsonb_build_object('status','anonymous')
    else jsonb_build_object(
      'status', case
                  when public.account_is_active()          then 'active'
                  when not public.account_is_whitelisted() then 'waiting_approval'
                  else 'needs_phone' end,
      'has_phone',   public.normalize_phone((select p.phone from public.profiles p where p.id = auth.uid())) is not null,
      'whitelisted', public.account_is_whitelisted(),
      'role',        (select p.role from public.profiles p where p.id = auth.uid()),
      'launch_date', (select value->>'expected_launch_date' from public.advanced_settings where key='registration_mode'),
      'message',     (select value->>'waitlist_message'     from public.advanced_settings where key='registration_mode'))
  end;
$$;

-- ── 10) حفظ الهاتف من شاشة البوابة ────────────────────────
create or replace function public.submit_my_phone(
  p_phone text, p_has_whatsapp boolean default true, p_whatsapp_phone text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_phone text; v_wa text;
begin
  if auth.uid() is null then raise exception 'لا توجد جلسة' using errcode='42501'; end if;

  v_phone := public.normalize_phone(p_phone);
  if v_phone is null then raise exception 'رقم الهاتف غير صحيح' using errcode='22023'; end if;

  if exists (select 1 from public.profiles p
              where p.id <> auth.uid() and public.normalize_phone(p.phone) = v_phone) then
    raise exception 'رقم الهاتف مسجّل بحساب آخر بالفعل' using errcode='23505';
  end if;

  if p_has_whatsapp then
    v_wa := v_phone;
  else
    v_wa := public.normalize_phone(p_whatsapp_phone);
    if p_whatsapp_phone is not null and btrim(p_whatsapp_phone) <> '' and v_wa is null then
      raise exception 'رقم واتساب غير صحيح' using errcode='22023';
    end if;
    if v_wa is not null and exists (select 1 from public.profiles p
          where p.id <> auth.uid() and public.normalize_phone(p.whatsapp_phone) = v_wa) then
      raise exception 'رقم واتساب مسجّل بحساب آخر بالفعل' using errcode='23505';
    end if;
  end if;

  update public.profiles set phone = v_phone, whatsapp_phone = v_wa where id = auth.uid();
  return jsonb_build_object('ok', true, 'phone', v_phone, 'whatsapp_phone', v_wa);
end;
$$;

-- ── 11) استخدام كود المرور ────────────────────────────────
create or replace function public.redeem_passcode(p_code text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'لا توجد جلسة' using errcode='42501'; end if;
  if p_code is null or btrim(p_code) = '' then
    return jsonb_build_object('ok', false, 'reason', 'empty');
  end if;

  select c.id into v_id from public.access_passcodes c
   where c.is_active and c.code_hash = extensions.crypt(btrim(p_code), c.code_hash) limit 1;

  if v_id is null then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;

  insert into public.passcode_redemptions (user_id, passcode_id) values (auth.uid(), v_id)
  on conflict (user_id) do update set passcode_id = excluded.passcode_id, redeemed_at = now();

  return jsonb_build_object('ok', true);
end;
$$;

-- ── 12) إدارة الأكواد: مالك المنصة وحده ───────────────────
create or replace function public.owner_set_passcode(p_code text, p_label text default '')
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid;
begin
  if not public.is_platform_owner() then
    raise exception 'إدارة أكواد المرور مقصورة على مالك المنصة' using errcode='42501';
  end if;
  if p_code is null or length(btrim(p_code)) < 6 then
    raise exception 'كود المرور يجب أن يكون 6 خانات على الأقل' using errcode='22023';
  end if;
  insert into public.access_passcodes (label, code_hash, created_by)
  values (coalesce(p_label,''), extensions.crypt(btrim(p_code), extensions.gen_salt('bf',10)), auth.uid())
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

create or replace function public.owner_set_passcode_active(p_id uuid, p_active boolean)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.is_platform_owner() then
    raise exception 'إدارة أكواد المرور مقصورة على مالك المنصة' using errcode='42501';
  end if;
  update public.access_passcodes
     set is_active = p_active, revoked_at = case when p_active then null else now() end
   where id = p_id;
  return jsonb_build_object('ok', found);
end;
$$;

-- ── 13) تسجيل دخول عميل تابع لشركة ────────────────────────
-- العضوية تُثبَت داخل القاعدة عبر companies.user_id = profiles.super_user_id،
-- ولا يُقبل أي company_id قادم من الواجهة.
create or replace function public.resolve_company_member_login(p_company text, p_member text)
returns text language plpgsql stable security definer set search_path to 'public' as $$
declare v_company_id uuid; v_owner_id uuid; v_email text; v_member text;
begin
  if p_company is null or p_member is null then return null; end if;

  if not public._check_email_lookup_rate_limit('company:' || lower(btrim(p_company)), 5, 600) then
    raise exception 'محاولات كثيرة جدًا، حاول لاحقًا' using errcode='42901';
  end if;
  if not public._check_email_lookup_rate_limit('company_global', 60, 300) then
    raise exception 'محاولات كثيرة جدًا، حاول لاحقًا' using errcode='42901';
  end if;

  select c.id, c.user_id into v_company_id, v_owner_id
    from public.companies c
   where c.status = 'active'
     and (lower(c.company_email) = lower(btrim(p_company))
          or c.commercial_registration_number = btrim(p_company)
          or public.normalize_phone(c.company_phone) = public.normalize_phone(p_company))
   limit 1;
  if v_company_id is null then return null; end if;

  v_member := btrim(p_member);
  select p.email into v_email from public.profiles p
   where (p.super_user_id = v_owner_id or p.id = v_owner_id)
     and (lower(p.email) = lower(v_member)
          or public.normalize_phone(p.phone) = public.normalize_phone(v_member))
   limit 1;
  return v_email;
end;
$$;

-- ── 14) الصلاحيات ─────────────────────────────────────────
-- Postgres يمنح EXECUTE لـ PUBLIC افتراضيًا على كل دالة جديدة، و anon يرث
-- منها. الدوال التي تأخذ p_user_id كانت ستسمح لزائر غير مسجَّل بسؤال
-- القاعدة عن حالة أي حساب بمعرفته، فنسحب المنحة العامة أولًا.
revoke execute on function public.account_is_active()                      from public, anon;
revoke execute on function public.account_is_whitelisted(uuid)             from public, anon;
revoke execute on function public.account_verification_ok(uuid)            from public, anon;
revoke execute on function public.gate_is_exempt_account(uuid)             from public, anon;
revoke execute on function public.my_account_gate()                        from public, anon;
revoke execute on function public.submit_my_phone(text, boolean, text)     from public, anon;
revoke execute on function public.redeem_passcode(text)                    from public, anon;
revoke execute on function public.owner_set_passcode(text, text)           from public, anon;
revoke execute on function public.owner_set_passcode_active(uuid, boolean) from public, anon;

grant execute on function public.my_account_gate()                        to authenticated;
grant execute on function public.submit_my_phone(text, boolean, text)     to authenticated;
grant execute on function public.redeem_passcode(text)                    to authenticated;
grant execute on function public.owner_set_passcode(text, text)           to authenticated;
grant execute on function public.owner_set_passcode_active(uuid, boolean) to authenticated;
-- سياسات RLS تُقيَّم بصلاحيات المستخدم المستعلِم، فيحتاج authenticated
-- صلاحية تنفيذ account_is_active() المستخدَمة داخل السياسات.
grant execute on function public.account_is_active()                      to authenticated;
grant execute on function public.account_is_whitelisted(uuid)             to authenticated;
grant execute on function public.account_verification_ok(uuid)            to authenticated;
grant execute on function public.gate_is_exempt_account(uuid)             to authenticated;

-- resolve_company_member_login تبقى متاحة لـ anon عمدًا: تُستدعى من شاشة
-- تسجيل الدخول قبل وجود أي جلسة، محميّة بحد معدل الطلبات، ولا ترجع شيئًا
-- إلا بعد إثبات العضوية داخل القاعدة.
grant execute on function public.resolve_company_member_login(text, text) to anon, authenticated;
grant execute on function public.normalize_phone(text)                    to anon, authenticated;

-- ── 15) توحيد الأرقام القائمة + تريجر الصيغة ──────────────
update public.profiles p
   set phone = public.normalize_phone(p.phone)
 where p.phone is not null
   and public.normalize_phone(p.phone) is not null
   and public.normalize_phone(p.phone) <> p.phone;

create or replace function public.guard_profile_phone_format()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v text;
begin
  if new.phone is not null and btrim(new.phone) <> '' then
    v := public.normalize_phone(new.phone);
    if v is null then raise exception 'رقم الهاتف غير صحيح: %', new.phone using errcode='22023'; end if;
    new.phone := v;
  end if;
  if new.whatsapp_phone is not null and btrim(new.whatsapp_phone) <> '' then
    v := public.normalize_phone(new.whatsapp_phone);
    if v is null then raise exception 'رقم واتساب غير صحيح: %', new.whatsapp_phone using errcode='22023'; end if;
    new.whatsapp_phone := v;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_profile_phone_format on public.profiles;
create trigger guard_profile_phone_format
  before insert or update of phone, whatsapp_phone on public.profiles
  for each row execute function public.guard_profile_phone_format();

-- ── 16) إدراج آخر 3 عملاء في قائمة الانتظار ───────────────
insert into public.waitlist_entries (name, email, phone, status, approved_user_id, created_at)
select coalesce(nullif(btrim(p.full_name), ''), split_part(p.email, '@', 1)),
       p.email, p.phone, 'pending', p.id, now()
  from public.profiles p
 where p.id in ('494c025c-03ef-48eb-b17a-a9cb4ba349da',
                '70736a4a-1ccc-4935-857b-7898deba14da',
                '670a2e28-8dd6-4cd2-b124-c5e43ed7c933')
   and not exists (select 1 from public.waitlist_entries w where lower(w.email) = lower(p.email));

-- ── 17) البوابة على جداول بيانات العميل ───────────────────
-- سياسات RESTRICTIVE فقط: لا تُعدَّل أي سياسة قائمة.
-- مستثنى عمدًا: profiles و trusted_devices (تحتاجهما شاشة البوابة نفسها)،
-- والجداول المرجعية العامة، وكل ما هو خارج نطاق الطلب.
do $$
declare
  t text;
  gated text[] := array[
    'tickets','ticket_replies','ticket_activity','ticket_attachments',
    'ticket_ratings','saved_ticket_filters','notifications',
    'user_wallets','user_reports','reward_activity_logs','customer_badges',
    'whatsapp_subscriptions','whatsapp_wallet_topup_requests',
    'chat_sessions','chat_messages','messages','activity_logs'];
begin
  foreach t in array gated loop
    -- الجدول قد لا يوجد في بيئة أقدم أو في تركيب اختباري مصغَّر. نتخطّاه
    -- بدل أن يسقط الترحيل كله، فيبقى قابلًا لإعادة التطبيق في أي بيئة.
    continue when to_regclass('public.' || quote_ident(t)) is null;

    execute format('drop policy if exists gate_account_active on public.%I', t);
    execute format($f$
      create policy gate_account_active on public.%I
        as restrictive for all to authenticated
        using (public.account_is_active()) with check (public.account_is_active())
    $f$, t);
  end loop;
end $$;
