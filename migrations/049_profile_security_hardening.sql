-- ============================================================================
-- 049 — تقوية الملف الشخصي والأمان (Profile & Security Audit)
--
-- كل قسم هنا يغلق مشكلة مؤكَّدة في تقرير التدقيق، ولا شيء غيرها. لا يُعاد
-- تعريف أي محفّز أو سياسة قائمة سليمة: guard_profile_role_change و
-- guard_profile_protected_columns و enforce_2fa_change_requires_challenge و
-- سياسات trusted_devices تبقى كما هي حرفيًا. كل ما يلي **يُضاف** بجوارها.
--
-- PS-02  سرّ TOTP ورموز الاستعادة كانت نصًّا صريحًا في profiles، وسياستا
--        SELECT (Support can view all profiles / supervises) تكشفانها لكل
--        أدمن ولصاحب الشركة على أعضائه. الحل: جدول خاص user_mfa_secrets لا
--        يقرؤه إلا service_role، ومحفّز يحوّل أي كتابة للعمودين إليه ويُبقي
--        العمودين في profiles NULL دائمًا. رموز الاستعادة تُخزَّن SHA-256.
--        مسار التسجيل الحالي في المتصفح (UPDATE profiles SET two_factor_*)
--        يبقى يعمل بلا تغيير — المحفّز يلتقط القيم.
--
-- PS-07  سياسة "Support can update whatsapp_enabled" و supervises() تسمحان
--        بتعديل أي عمود غير محروس في ملف مستخدم آخر (الهاتف، اسم المستخدم،
--        تيليجرام، أعمدة 2FA وهي معطّلة). الحل: محفّز يمنع تعديل أعمدة
--        الأمان إلا من صاحب الحساب نفسه أو service_role. لا تُلمس السياسات،
--        فعمليات الإدارة المشروعة (الرتبة، النقاط، الحظر، whatsapp_enabled،
--        الاسم) تبقى تعمل.
--
-- PS-13  profiles.email كان يعدّله الأدمن بلا أن يتغيّر auth.users.email،
--        وحساب واحد في الإنتاج غير متطابق اليوم. الحل: البريد في profiles
--        مرآة لـ auth.users وحده — مزامنة بمحفّز على auth.users، ومنع أي
--        كتابة مباشرة من جلسة (حتى الأدمن). ومزامنة لمرة واحدة للصفوف الحالية.
--
-- PS-20  last_password_change لم يكن يُكتب أبدًا. يُحدَّث الآن من نفس محفّز
--        auth.users عند تغيّر كلمة المرور. القيم القديمة لا تُلمس.
--
-- PS-09  صاحب الشركة الموقوفة كان يرفع الإيقاف بـ PATCH status='active'.
--        الحل: محفّز على companies.status للإدارة و service_role وحدهما.
--
-- PS-14  get_email_by_phone كان يقارن النص الخام برقم مخزَّن موحّد الصيغة
--        (+2010…) فيفشل الدخول بصيغة 010…. نفس الدالة الحيّة حرفيًا مع
--        توحيد الطرفين. حد المعدّل لم يتغيّر.
--
-- ترتيب النشر (مهم): دوال verify-2fa و disable-2fa الجديدة تقرأ من
-- user_mfa_secrets وترجع إلى أعمدة profiles إن لم تجد صفًّا، فتُنشر **قبل**
-- هذا الترحيل بأمان. نشر الترحيل قبلها يكسر دخول الحسابات المفعّل عليها 2FA.
-- انظر docs/DEPLOYMENT-ORDER.md.
--
-- ROLLBACK (بالترتيب):
--   drop trigger trg_divert_mfa_secrets on public.profiles;
--   drop trigger guard_profile_security_columns on public.profiles;
--   drop trigger trg_sync_profile_from_auth on auth.users;
--   drop trigger guard_company_status on public.companies;
--   -- ثم إعادة السرّ إلى profiles من user_mfa_secrets يدويًا قبل حذف الجدول
--   -- (رموز الاستعادة لا تعود — هي hashes؛ على المستخدم إعادة التسجيل).
--   -- وإعادة get_email_by_phone إلى تعريفها السابق (مذكور في التقرير).
-- ============================================================================

begin;

-- ── PS-02 ── جدول الأسرار الخاص ─────────────────────────────────────────────

create table if not exists public.user_mfa_secrets (
  user_id             uuid primary key references public.profiles(id) on delete cascade,
  totp_secret         text not null,
  recovery_code_hashes text[] not null default '{}',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.user_mfa_secrets is
  'سرّ TOTP وhashes رموز الاستعادة. لا سياسة RLS عليه عمدًا: service_role وحده يقرأ ويكتب (verify-2fa / disable-2fa). يُملأ من محفّز trg_divert_mfa_secrets على profiles.';

alter table public.user_mfa_secrets enable row level security;
revoke all on table public.user_mfa_secrets from public, anon, authenticated;

-- hash رمز استعادة: نفس التطبيع في دوال الحافة (trim + upper) ثم SHA-256 hex.
create or replace function public.hash_recovery_code(p_code text)
returns text
language sql
immutable
set search_path to ''
as $$
  select encode(extensions.digest(upper(btrim(p_code)), 'sha256'), 'hex');
$$;
revoke all on function public.hash_recovery_code(text) from public, anon, authenticated;

create or replace function public.divert_mfa_secrets()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  -- 2FA غير مفعّل ⇒ لا سرّ محفوظ. يغطي التعطيل عبر disable-2fa وأي تعطيل
  -- آخر من service_role، ويمنع بقاء سرّ قديم يعامله verify-2fa كتسجيل قائم.
  if coalesce(new.two_factor_enabled, false) = false then
    if tg_op = 'UPDATE' then
      delete from public.user_mfa_secrets where user_id = new.id;
    end if;
    new.two_factor_secret := null;
    new.recovery_codes    := null;
    return new;
  end if;

  if new.two_factor_secret is not null and btrim(new.two_factor_secret) <> '' then
    insert into public.user_mfa_secrets as s (user_id, totp_secret, recovery_code_hashes)
    values (new.id, new.two_factor_secret,
            coalesce((select array_agg(public.hash_recovery_code(c))
                        from unnest(new.recovery_codes) c
                       where c is not null and btrim(c) <> ''), '{}'))
    on conflict (user_id) do update
      set totp_secret          = excluded.totp_secret,
          recovery_code_hashes = excluded.recovery_code_hashes,
          updated_at           = now();
  elsif new.recovery_codes is not null then
    update public.user_mfa_secrets
       set recovery_code_hashes = coalesce((select array_agg(public.hash_recovery_code(c))
                                              from unnest(new.recovery_codes) c
                                             where c is not null and btrim(c) <> ''), '{}'),
           updated_at = now()
     where user_id = new.id;
  end if;

  new.two_factor_secret := null;
  new.recovery_codes    := null;
  return new;
end;
$$;
revoke all on function public.divert_mfa_secrets() from public, anon, authenticated;

-- الاسم يبدأ بـ trg_ عمدًا: محفّزات BEFORE تُنفَّذ أبجديًا، فيرى
-- enforce_2fa_change_requires_challenge و guard_profile_security_columns
-- القيم الأصلية أولًا ويرفضان ما يجب رفضه قبل أي تحويل.
drop trigger if exists trg_divert_mfa_secrets on public.profiles;
create trigger trg_divert_mfa_secrets
  before insert or update on public.profiles
  for each row execute function public.divert_mfa_secrets();

-- نقل البيانات الحالية. لا auth.uid() هنا، فلا يرفض أي محفّز.
insert into public.user_mfa_secrets (user_id, totp_secret, recovery_code_hashes)
select p.id, p.two_factor_secret,
       coalesce((select array_agg(public.hash_recovery_code(c))
                   from unnest(p.recovery_codes) c
                  where c is not null and btrim(c) <> ''), '{}')
  from public.profiles p
 where p.two_factor_enabled
   and p.two_factor_secret is not null and btrim(p.two_factor_secret) <> ''
on conflict (user_id) do nothing;

-- تفعيل المحفّز يكفي لتفريغ الأعمدة: أي UPDATE يمرّ به.
update public.profiles
   set two_factor_secret = two_factor_secret
 where two_factor_secret is not null or recovery_codes is not null;

-- ── PS-07 / PS-13 ── أعمدة الأمان لصاحب الحساب وحده ─────────────────────────

create or replace function public.guard_profile_security_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_changed text[] := '{}';
begin
  -- service_role / pg_cron / محفّز auth.users: لا auth.uid().
  if auth.uid() is null then
    return new;
  end if;

  -- البريد مرآة لـ auth.users. لا يُكتب من أي جلسة، ولا من الأدمن.
  if new.email is distinct from old.email then
    raise exception 'البريد الإلكتروني يُغيَّر من إعدادات الحساب عبر نظام الدخول، لا مباشرة'
      using errcode = '42501';
  end if;

  if auth.uid() = new.id then
    return new;
  end if;

  if new.phone                is distinct from old.phone                then v_changed := v_changed || 'phone'::text; end if;
  if new.whatsapp_phone       is distinct from old.whatsapp_phone       then v_changed := v_changed || 'whatsapp_phone'::text; end if;
  if new.username             is distinct from old.username             then v_changed := v_changed || 'username'::text; end if;
  if new.two_factor_enabled   is distinct from old.two_factor_enabled   then v_changed := v_changed || 'two_factor_enabled'::text; end if;
  if new.two_factor_secret    is distinct from old.two_factor_secret    then v_changed := v_changed || 'two_factor_secret'::text; end if;
  if new.recovery_codes       is distinct from old.recovery_codes       then v_changed := v_changed || 'recovery_codes'::text; end if;
  if new.mfa_enabled          is distinct from old.mfa_enabled          then v_changed := v_changed || 'mfa_enabled'::text; end if;
  if new.telegram_chat_id     is distinct from old.telegram_chat_id     then v_changed := v_changed || 'telegram_chat_id'::text; end if;
  if new.telegram_username    is distinct from old.telegram_username    then v_changed := v_changed || 'telegram_username'::text; end if;
  if new.telegram_otp_enabled is distinct from old.telegram_otp_enabled then v_changed := v_changed || 'telegram_otp_enabled'::text; end if;
  if new.last_password_change is distinct from old.last_password_change then v_changed := v_changed || 'last_password_change'::text; end if;

  if array_length(v_changed, 1) is null then
    return new;
  end if;

  raise exception 'بيانات الأمان لا يعدّلها إلا صاحب الحساب: %', array_to_string(v_changed, ', ')
    using errcode = '42501';
end;
$$;
revoke all on function public.guard_profile_security_columns() from public, anon, authenticated;

drop trigger if exists guard_profile_security_columns on public.profiles;
create trigger guard_profile_security_columns
  before update on public.profiles
  for each row execute function public.guard_profile_security_columns();

-- ── PS-13 / PS-20 ── مزامنة من auth.users ───────────────────────────────────

create or replace function public.sync_profile_from_auth()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.email is distinct from old.email then
    begin
      update public.profiles set email = new.email where id = new.id;
    exception when unique_violation then
      -- ملف آخر يحمل هذا البريد نسخةً قديمة. لا نُفشل تغيير بريد الدخول
      -- بسببه؛ نُسجّل ونترك الإصلاح للإدارة.
      raise warning 'sync_profile_from_auth: email for % not mirrored (unique conflict)', new.id;
    end;
  end if;

  if new.encrypted_password is distinct from old.encrypted_password then
    update public.profiles set last_password_change = now() where id = new.id;
  end if;

  return new;
end;
$$;
revoke all on function public.sync_profile_from_auth() from public, anon, authenticated;

drop trigger if exists trg_sync_profile_from_auth on auth.users;
create trigger trg_sync_profile_from_auth
  after update of email, encrypted_password on auth.users
  for each row execute function public.sync_profile_from_auth();

-- مزامنة لمرة واحدة. تتخطّى أي صف يتعارض مع بريد ملف آخر بدل أن تُفشل.
update public.profiles p
   set email = u.email
  from auth.users u
 where u.id = p.id
   and u.email is not null
   and p.email is distinct from u.email
   and not exists (select 1 from public.profiles o where o.id <> p.id and o.email = u.email);

-- ── PS-09 ── حالة الشركة للإدارة وحدها ──────────────────────────────────────

create or replace function public.guard_company_status()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;
  raise exception 'حالة الشركة تُغيَّر من الإدارة فقط' using errcode = '42501';
end;
$$;
revoke all on function public.guard_company_status() from public, anon, authenticated;

drop trigger if exists guard_company_status on public.companies;
create trigger guard_company_status
  before update of status on public.companies
  for each row execute function public.guard_company_status();

-- ── PS-14 ── الدخول بالهاتف بأي صيغة ────────────────────────────────────────
-- التعريف الحيّ حرفيًا، والتغيير الوحيد سطر المقارنة.
create or replace function public.get_email_by_phone(p_phone text)
returns table(email text)
language plpgsql
security definer
set search_path to 'public'
as $function$
BEGIN
  IF NOT public._check_email_lookup_rate_limit('phone:' || lower(coalesce(p_phone, '')), 5, 600) THEN
    RAISE EXCEPTION 'محاولات كثيرة جدًا، حاول لاحقًا' USING ERRCODE = '42901';
  END IF;
  IF NOT public._check_email_lookup_rate_limit('global', 60, 300) THEN
    RAISE EXCEPTION 'محاولات كثيرة جدًا، حاول لاحقًا' USING ERRCODE = '42901';
  END IF;

  RETURN QUERY SELECT profiles.email FROM profiles
   WHERE public.normalize_phone(p_phone) IS NOT NULL
     AND public.normalize_phone(profiles.phone) = public.normalize_phone(p_phone);
END;
$function$;

commit;
