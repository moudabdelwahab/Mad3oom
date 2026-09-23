-- ============================================================================
-- 053_owner_authority.sql
--   الملكية ليست «أدمن بصلاحيات أكثر»: حماية المالك، فصل إدارة الإداريين،
--   تفويض محدود، سجل امتيازات، وتحقق بخطوتين لعمليات المالك الحرجة.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ما أثبته التدقيق على الإنتاج (جلسات حقيقية داخل معاملات مُلغاة)
-- ════════════════════════════════════════════════════════════════════════════
--
--   ① أدمن عادي (بلا صف سلطة) حظر المالك: UPDATE profiles SET ban_status=
--      'permanent' مرّ على صف واحد. is_banned() موصولة بـ account_is_active()
--      في سياسات RESTRICTIVE على 17 جدولًا — أي إقفال المالك خارج منصته.
--   ② أدمن عادي خفّض حسابًا مرتفع السلطة إلى user: guard_profile_role_change
--      كانت تحرس **منح** admin/support فقط، لا سحبهما.
--   ③ صاحب السلطة المرتفعة يُنشئ أدمنز ويخفّض زملاءه — إدارة الإداريين لم تكن
--      للمالك وحده.
--   ④ حذف ملف المالك من صاحب سلطة مرتفعة أوقفه مفتاح أجنبي بالصدفة لا قاعدة،
--      و is_platform_owner() تنضمّ إلى profiles.
--   ⑤ gate_is_exempt_account() تعفي المالك من بوابة الحساب **ببريده في
--      profiles** — سلطة بالبريد في الموضع الذي يقرّر إقفاله.
--   ⑥ لا سجل لتغيير الرتب ولا لإعدادات SIE.
--
-- ════════════════════════════════════════════════════════════════════════════
-- التصميم — امتداد لـ038/052، لا نظام موازٍ
-- ════════════════════════════════════════════════════════════════════════════
--
--   المستويات (كلها من علاقات قائمة):
--     مالك المنصة        platform_authority.owner + رتبة platform_owner (بلا تغيير)
--     مدير منصة          platform_authority.elevated_admin + رتبة admin
--     إداري              رتبة admin بلا صف سلطة
--     فريق الدعم         رتبة support
--     عميل / شركة        user / company_admin / company_user (035، بلا تغيير)
--
--   القواعد:
--     • حساب المالك لا يُحذف من أي جلسة، ولا يعدّله أحد غيره.
--     • حسابات فريق المنصة (admin/support/صاحب صف سلطة): رتبتها وحظرها
--       وقفلها وحذفها للمالك وحده بعد تحقق بخطوتين حديث — عدا ما فوّضه:
--       قدرة staff.support تتيح لإداري إدارة رتبة support وحدها.
--     • لا تفويض يصنع مالكًا: القدرات قائمة مغلقة (CHECK) لا تحوي شيئًا من
--       صلاحيات المالك، وصف owner في platform_authority للترحيل وحده.
--     • حسابات العملاء: بلا أي تغيير في صلاحيات الإدارة الحالية.
--
--   التحقق بخطوتين (step-up):
--     owner_step_up(code) يتحقق من رمز TOTP **داخل القاعدة** مقابل السرّ في
--     user_mfa_secrets (049 — service_role وحده يقرؤه) بنفس خوارزمية
--     verify-2fa ونفس حدّ المحاولات (twofa_rate_limits)، فيسجّل نافذة 10
--     دقائق مربوطة بجلسة الدخول نفسها (session_id). السرّ لا يغادر القاعدة،
--     والرمز المستعمل لا يُعاد (آخر عدّاد محفوظ). بلا 2FA مفعّل: الرفض قاطع.
--
--   المتطلّب: 049 مطبَّق (user_mfa_secrets)، وإلا فسرّ TOTP مقروء لكل أدمن
--   ويكون التحقق بخطوتين بلا معنى. الفحص أدناه يرفض التطبيق قبله.
--
-- ما لا يفعله هذا الترحيل
--   • لا يعطّل RLS، ولا يلمس سياسة قائمة واحدة
--   • لا يغيّر صلاحيات الإدارة على حسابات العملاء
--   • لا يسمح لأي جلسة بكتابة صف owner أو رتبة platform_owner
--
-- التراجع (بالترتيب): انظر آخر الملف.
-- ============================================================================

do $$
begin
  if to_regclass('public.user_mfa_secrets') is null then
    raise exception '053 يتطلب 049 (user_mfa_secrets) — بدونه سرّ TOTP مقروء للأدمنز';
  end if;
  if to_regprocedure('public.sie_owner_authority()') is null then
    raise exception '053 يتطلب 052';
  end if;
  if to_regclass('public.twofa_rate_limits') is null
     or to_regprocedure('public.owner_capability(text)') is null
     or to_regprocedure('public.request_user_agent()') is null then
    raise exception '053 يتطلب 038 → 041 وجدول twofa_rate_limits';
  end if;
end $$;


-- ============================================================================
-- 1) التحقق بخطوتين داخل القاعدة
-- ============================================================================

create table if not exists public.privileged_step_ups (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  session_id    text,
  verified_at   timestamptz not null default now(),
  expires_at    timestamptz not null,
  last_counter  bigint not null default 0
);

comment on table public.privileged_step_ups is
  'نافذة التحقق بخطوتين الحديثة لعمليات المالك الحرجة. تُكتب من owner_step_up() وحدها.';

alter table public.privileged_step_ups enable row level security;
drop policy if exists privileged_step_ups_select_self on public.privileged_step_ups;
create policy privileged_step_ups_select_self on public.privileged_step_ups
  for select to authenticated using (user_id = auth.uid());
revoke all on table public.privileged_step_ups from public, anon, authenticated;
grant select on table public.privileged_step_ups to authenticated;


create or replace function public._base32_decode(p_text text)
returns bytea
language plpgsql
immutable
set search_path to ''
as $$
declare
  v_alpha constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  v_s     text := upper(regexp_replace(coalesce(p_text, ''), '[[:space:]=]', '', 'g'));
  v_bits  text := '';
  v_out   bytea := ''::bytea;
  v_val   int;
  i       int;
begin
  for i in 1 .. length(v_s) loop
    v_val := strpos(v_alpha, substr(v_s, i, 1)) - 1;
    if v_val >= 0 then
      v_bits := v_bits || v_val::bit(5)::text;
    end if;
  end loop;
  i := 1;
  while i + 7 <= length(v_bits) loop
    v_out := v_out || decode(lpad(to_hex(substr(v_bits, i, 8)::bit(8)::int), 2, '0'), 'hex');
    i := i + 8;
  end loop;
  return v_out;
end;
$$;

revoke all on function public._base32_decode(text) from public, anon, authenticated;


-- نفس generateTOTP في verify-2fa: HMAC-SHA1، 6 أرقام، خطوة 30 ثانية.
create or replace function public._totp_code(p_key bytea, p_counter bigint)
returns text
language plpgsql
immutable
set search_path to ''
as $$
declare
  v_h   bytea := extensions.hmac(int8send(p_counter), p_key, 'sha1');
  v_o   int   := get_byte(v_h, 19) & 15;
  v_bin bigint;
begin
  v_bin := ((get_byte(v_h, v_o) & 127)::bigint << 24)
         | (get_byte(v_h, v_o + 1)::bigint << 16)
         | (get_byte(v_h, v_o + 2)::bigint << 8)
         |  get_byte(v_h, v_o + 3)::bigint;
  return lpad((v_bin % 1000000)::text, 6, '0');
end;
$$;

revoke all on function public._totp_code(bytea, bigint) from public, anon, authenticated;


create or replace function public._jwt_session_id()
returns text
language sql
stable
set search_path to ''
as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id';
$$;

revoke all on function public._jwt_session_id() from public, anon, authenticated;


-- تحقق حديث لنفس المالك في نفس جلسة الدخول. أي شيء آخر = false قاطعة.
create or replace function public.step_up_fresh()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce((
    select s.expires_at > now()
       and s.session_id is not distinct from public._jwt_session_id()
      from public.privileged_step_ups s
     where s.user_id = auth.uid()
  ), false)
  and public.is_platform_owner();
$$;

revoke all on function public.step_up_fresh() from public, anon;
grant execute on function public.step_up_fresh() to authenticated;


-- العمليات الحرجة للمالك: الملكية + سياق «مالك المنصة» + تحقق حديث.
create or replace function public.owner_critical_ok()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(public.owner_capability('owner_only') and public.step_up_fresh(), false);
$$;

revoke all on function public.owner_critical_ok() from public, anon;
grant execute on function public.owner_critical_ok() to authenticated;


-- ============================================================================
-- 2) سجل الامتيازات — append-only
-- ============================================================================

create table if not exists public.privileged_audit (
  id              bigint generated always as identity primary key,
  at              timestamptz not null default now(),
  actor_id        uuid,
  actor_tier      text,
  action          text not null,
  target_user_id  uuid,
  old_value       jsonb,
  new_value       jsonb,
  context         text,
  step_up         boolean,
  source          text not null check (source in ('session', 'system')),
  user_agent      text
);

create index if not exists privileged_audit_at on public.privileged_audit (at desc);
create index if not exists privileged_audit_target on public.privileged_audit (target_user_id, at desc);

comment on table public.privileged_audit is
  'كل تغيير في السلطة والرتب والحظر وإعدادات SIE. لا يُعدَّل ولا يُحذف. source=system = ترحيل أو service_role.';

alter table public.privileged_audit enable row level security;
drop policy if exists privileged_audit_select_owner on public.privileged_audit;
create policy privileged_audit_select_owner on public.privileged_audit
  for select to authenticated using (public.owner_capability('owner_only'));
revoke all on table public.privileged_audit from public, anon, authenticated;
grant select on table public.privileged_audit to authenticated;

create or replace function public.guard_privileged_audit_immutable()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  raise exception 'privileged_audit لا يُعدَّل ولا يُحذف' using errcode = '42501';
end;
$$;
revoke all on function public.guard_privileged_audit_immutable() from public, anon, authenticated;

drop trigger if exists trg_privileged_audit_immutable on public.privileged_audit;
create trigger trg_privileged_audit_immutable
  before update or delete on public.privileged_audit
  for each row execute function public.guard_privileged_audit_immutable();


create or replace function public.account_tier(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path to 'public'
as $$
  select case
    when p_user_id is null then 'system'
    when exists (select 1 from public.platform_authority a where a.user_id = p_user_id and a.level = 'owner')
      then 'owner'
    when exists (select 1 from public.platform_authority a where a.user_id = p_user_id and a.level = 'elevated_admin')
      then 'platform_admin'
    else coalesce((select case p.role when 'admin' then 'admin' when 'support' then 'support' else 'customer' end
                     from public.profiles p where p.id = p_user_id), 'unknown')
  end;
$$;

-- داخلية: لا تُكشف للجلسات حتى لا تُعدِّد حسابات فريق المنصة بمعرّفاتها
revoke all on function public.account_tier(uuid) from public, anon, authenticated;


create or replace function public.log_privileged(
  p_action text, p_target uuid, p_old jsonb, p_new jsonb
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  insert into public.privileged_audit
    (actor_id, actor_tier, action, target_user_id, old_value, new_value, context, step_up, source, user_agent)
  values
    (auth.uid(),
     public.account_tier(auth.uid()),
     p_action, p_target, p_old, p_new,
     public.active_context(),
     case when auth.uid() is null then null else public.step_up_fresh() end,
     case when auth.uid() is null then 'system' else 'session' end,
     public.request_user_agent());
end;
$$;

revoke all on function public.log_privileged(text, uuid, jsonb, jsonb) from public, anon, authenticated;


-- ============================================================================
-- 3) التفويض — قدرات مغلقة لا تحوي شيئًا من الملكية
-- ============================================================================

create table if not exists public.platform_capability_grants (
  user_id     uuid not null references auth.users(id) on delete cascade,
  capability  text not null check (capability in ('staff.support')),
  granted_by  uuid references auth.users(id) on delete set null,
  granted_at  timestamptz not null default now(),
  note        text,
  primary key (user_id, capability)
);

comment on table public.platform_capability_grants is
  'تفويض المالك لإداري بقدرة محددة. القائمة مغلقة بـCHECK؛ لا قدرة فيها تمسّ السلطة أو الملكية. '
  'staff.support = إدارة رتبة support وحدها.';

alter table public.platform_capability_grants enable row level security;
drop policy if exists platform_capability_grants_select on public.platform_capability_grants;
create policy platform_capability_grants_select on public.platform_capability_grants
  for select to authenticated
  using (user_id = auth.uid() or public.owner_capability('owner_only'));
revoke all on table public.platform_capability_grants from public, anon, authenticated;
grant select on table public.platform_capability_grants to authenticated;

create or replace function public.guard_capability_grants_write()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is not null and not public.owner_critical_ok() then
    raise exception 'التفويض يمنحه مالك المنصة وحده بعد التحقق بخطوتين' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;
revoke all on function public.guard_capability_grants_write() from public, anon, authenticated;

drop trigger if exists trg_guard_capability_grants on public.platform_capability_grants;
create trigger trg_guard_capability_grants
  before insert or update or delete on public.platform_capability_grants
  for each row execute function public.guard_capability_grants_write();


-- قدرة مفوّضة: منح صريح + رتبة admin (الاشتراط المزدوج نفسه في 035/038/052)
create or replace function public.has_capability(p_capability text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1
      from public.platform_capability_grants g
      join public.profiles p on p.id = g.user_id
     where g.user_id = auth.uid()
       and g.capability = p_capability
       and p.role = 'admin'
  );
$$;

revoke all on function public.has_capability(text) from public, anon;
grant execute on function public.has_capability(text) to authenticated;


-- ============================================================================
-- 4) حماية المالك وفريق المنصة على profiles
-- ============================================================================

create or replace function public.guard_privileged_accounts()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_actor uuid := auth.uid();
  v_tier  text;
  v_ban_changed boolean;
begin
  -- ترحيل / service_role / مهمة خلفية
  if v_actor is null then
    return coalesce(new, old);
  end if;

  v_tier := public.account_tier(old.id);

  -- ── المالك: لا يُحذف، وهويته وأمانه لا يعدّلهما غيره ────────────────────
  -- رفض افتراضي لكل عمود، عدا قائمة تشغيلية تكتبها دوال الإدارة كأثر جانبي
  -- مشروع على حساب المالك كأي عميل: recompute_user_access (whatsapp_enabled
  -- عند اعتماد اشتراكه)، aqar_set_enabled، approve_reward_report (points)،
  -- increment_user_post_count. الرتبة والبريد والاسم والهاتف والحظر والقفل
  -- وأعمدة 2FA كلها خارجها — فلا «هوية» للمالك تتغيّر من جلسة غيره.
  if v_tier = 'owner' then
    if tg_op = 'DELETE' then
      raise exception 'ملف مالك المنصة لا يُحذف من أي جلسة' using errcode = '42501';
    end if;
    if v_actor <> old.id
       and (to_jsonb(new) - array['whatsapp_enabled', 'aqar_enabled', 'points',
                                  'forum_posts_count', 'updated_at'])
           is distinct from
           (to_jsonb(old) - array['whatsapp_enabled', 'aqar_enabled', 'points',
                                  'forum_posts_count', 'updated_at']) then
      raise exception 'هوية مالك المنصة وأمان حسابه لا يعدّلهما إلا المالك نفسه'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- ── حسابات العملاء: بلا تغيير في صلاحيات الإدارة ──────────────────────
  if v_tier not in ('platform_admin', 'admin', 'support') then
    return coalesce(new, old);
  end if;

  -- ── فريق المنصة ─────────────────────────────────────────────────────────
  if tg_op = 'DELETE' then
    if public.owner_critical_ok() then return old; end if;
    if v_tier = 'support' and public.has_capability('staff.support') then return old; end if;
    raise exception 'حذف حسابات فريق المنصة لمالك المنصة وحده بعد التحقق بخطوتين'
      using errcode = '42501';
  end if;

  v_ban_changed := new.ban_status            is distinct from old.ban_status
                or new.ban_until             is distinct from old.ban_until
                or new.ban_reason            is distinct from old.ban_reason
                or new.is_locked             is distinct from old.is_locked
                or new.failed_login_attempts is distinct from old.failed_login_attempts
                or new.custom_role_id        is distinct from old.custom_role_id;

  -- الرتبة تحرسها guard_profile_role_change؛ هنا الحظر والقفل وحدهما
  if not v_ban_changed then
    return new;
  end if;

  if v_actor = old.id then
    raise exception 'لا يمكنك رفع الحظر أو القفل عن حسابك بنفسك' using errcode = '42501';
  end if;
  if public.owner_critical_ok() then
    return new;
  end if;
  if v_tier = 'support' and public.has_capability('staff.support') then
    return new;
  end if;
  raise exception 'حظر حسابات فريق المنصة وقفلها لمالك المنصة وحده بعد التحقق بخطوتين'
    using errcode = '42501';
end;
$$;

revoke all on function public.guard_privileged_accounts() from public, anon, authenticated;

drop trigger if exists guard_privileged_accounts on public.profiles;
create trigger guard_privileged_accounts
  before update or delete on public.profiles
  for each row execute function public.guard_privileged_accounts();


-- الرتب: إدارة الإداريين للمالك وحده، و support للمالك أو المفوَّض
create or replace function public.guard_profile_role_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.role is not distinct from old.role then
    return new;
  end if;

  if auth.uid() is null then
    return new;
  end if;

  if exists (select 1 from public.platform_authority a
              where a.user_id = new.id and a.level = 'owner') then
    raise exception 'رتبة مالك المنصة ثابتة ولا تُغيَّر من جلسة'
      using errcode = '42501';
  end if;

  if auth.uid() = new.id then
    raise exception 'لا يمكنك تغيير صلاحية حسابك بنفسك' using errcode = '42501';
  end if;

  -- الملكية لا تُمنح من جلسة إطلاقًا — صف owner للترحيل وحده
  if new.role = 'platform_owner' then
    raise exception 'رتبة مالك المنصة لا تُمنح من أي جلسة' using errcode = '42501';
  end if;

  if new.role in ('company_admin', 'company_user') then
    raise exception 'أدوار الشركة تُشتق من العلاقة بالشركة ولا تُمنَح يدويًا'
      using errcode = '42501';
  end if;

  -- منح الإدارة أو سحبها — أو المساس بحساب يحمل صف سلطة
  if new.role = 'admin' or old.role = 'admin'
     or exists (select 1 from public.platform_authority a where a.user_id = new.id) then
    if public.owner_critical_ok() then return new; end if;
    raise exception 'منح رتبة الإدارة أو سحبها لمالك المنصة وحده بعد التحقق بخطوتين'
      using errcode = '42501';
  end if;

  if new.role = 'support' or old.role = 'support' then
    if public.owner_critical_ok() or public.has_capability('staff.support') then
      return new;
    end if;
    raise exception 'إدارة فريق الدعم تتطلب تفويضًا من مالك المنصة' using errcode = '42501';
  end if;

  if not public.is_admin() then
    raise exception 'تغيير الرتب متاح للإدارة فقط' using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.guard_profile_role_change() from public, anon, authenticated;


-- صف owner للترحيل وحده؛ elevated_admin للمالك بعد التحقق، وعبر RPC
create or replace function public.guard_platform_authority_write()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null then
    return coalesce(new, old);
  end if;
  if (tg_op <> 'DELETE' and new.level = 'owner')
     or (tg_op <> 'INSERT' and old.level = 'owner') then
    raise exception 'صف مالك المنصة لا يُكتب من جلسة — الترحيل وحده' using errcode = '42501';
  end if;
  if public.owner_critical_ok() then
    return coalesce(new, old);
  end if;
  raise exception 'platform_authority تُكتب من الترحيل أو من مالك المنصة بعد التحقق بخطوتين'
    using errcode = '42501';
end;
$$;

revoke all on function public.guard_platform_authority_write() from public, anon, authenticated;


-- إعفاء بوابة الحساب: بصف الملكية، لا ببريد profiles
create or replace function public.gate_is_exempt_account(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_user_id is not null
     and exists (select 1 from public.platform_authority a
                  where a.user_id = p_user_id and a.level = 'owner');
$$;


-- ============================================================================
-- 5) محفّزات السجل
-- ============================================================================

create or replace function public.audit_profile_privileged_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if tg_op = 'DELETE' then
    if old.role in ('admin', 'support', 'platform_owner') then
      perform public.log_privileged('profile.delete', old.id,
        jsonb_build_object('role', old.role, 'email', old.email), null);
    end if;
    return old;
  end if;

  if new.role is distinct from old.role then
    perform public.log_privileged('role.change', new.id,
      jsonb_build_object('role', old.role), jsonb_build_object('role', new.role));
  end if;
  if new.ban_status is distinct from old.ban_status
     or new.ban_until is distinct from old.ban_until
     or new.is_locked is distinct from old.is_locked then
    perform public.log_privileged('account.restriction', new.id,
      jsonb_build_object('ban_status', old.ban_status, 'ban_until', old.ban_until, 'is_locked', old.is_locked),
      jsonb_build_object('ban_status', new.ban_status, 'ban_until', new.ban_until, 'is_locked', new.is_locked,
                         'ban_reason', new.ban_reason));
  end if;
  return new;
end;
$$;
revoke all on function public.audit_profile_privileged_change() from public, anon, authenticated;

drop trigger if exists trg_audit_profile_privileged on public.profiles;
create trigger trg_audit_profile_privileged
  after update or delete on public.profiles
  for each row execute function public.audit_profile_privileged_change();


create or replace function public.audit_authority_tables()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_target uuid;
begin
  if tg_table_name = 'sie_settings' then
    perform public.log_privileged('sie.setting.' || lower(tg_op), null,
      case when tg_op = 'INSERT' then null else jsonb_build_object(old.key, old.value) end,
      case when tg_op = 'DELETE' then null else jsonb_build_object(new.key, new.value) end);
    return coalesce(new, old);
  end if;

  v_target := coalesce((to_jsonb(new) ->> 'user_id')::uuid, (to_jsonb(old) ->> 'user_id')::uuid);
  perform public.log_privileged(
    tg_table_name || '.' || lower(tg_op), v_target,
    case when tg_op = 'INSERT' then null else to_jsonb(old) - 'user_id' end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) - 'user_id' end);
  return coalesce(new, old);
end;
$$;
revoke all on function public.audit_authority_tables() from public, anon, authenticated;

drop trigger if exists trg_audit_platform_authority on public.platform_authority;
create trigger trg_audit_platform_authority
  after insert or update or delete on public.platform_authority
  for each row execute function public.audit_authority_tables();

drop trigger if exists trg_audit_capability_grants on public.platform_capability_grants;
create trigger trg_audit_capability_grants
  after insert or update or delete on public.platform_capability_grants
  for each row execute function public.audit_authority_tables();

drop trigger if exists trg_audit_sie_admin_grants on public.sie_admin_grants;
create trigger trg_audit_sie_admin_grants
  after insert or update or delete on public.sie_admin_grants
  for each row execute function public.audit_authority_tables();

drop trigger if exists trg_audit_sie_settings on public.sie_settings;
create trigger trg_audit_sie_settings
  after insert or update or delete on public.sie_settings
  for each row execute function public.audit_authority_tables();


-- ============================================================================
-- 6) نداءات المالك
-- ============================================================================

-- التحقق بخطوتين. لا يرفع استثناءً عند رمز خاطئ: الفشل يجب أن يُحفَظ
-- (عدّاد المحاولات والسجل)، والاستثناء كان سيُلغيه مع المعاملة.
create or replace function public.owner_step_up(p_code text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid     uuid := auth.uid();
  v_secret  text;
  v_key     bytea;
  v_rl      public.twofa_rate_limits%rowtype;
  v_now     timestamptz := now();
  v_counter bigint := floor(extract(epoch from now()) / 30)::bigint;
  v_last    bigint;
  v_match   bigint;
  v_fails   int;
  v_code    text := regexp_replace(coalesce(p_code, ''), '\s', '', 'g');
  w         int;
begin
  if v_uid is null or not public.is_platform_owner() then
    raise exception 'التحقق بخطوتين لعمليات المالك متاح لمالك المنصة وحده' using errcode = '42501';
  end if;

  select s.totp_secret into v_secret from public.user_mfa_secrets s where s.user_id = v_uid;
  if v_secret is null or btrim(v_secret) = '' then
    return jsonb_build_object('verified', false, 'error', 'mfa_not_enrolled');
  end if;

  select * into v_rl from public.twofa_rate_limits r where r.user_id = v_uid;
  if v_rl.locked_until is not null and v_rl.locked_until > v_now then
    return jsonb_build_object('verified', false, 'error', 'too_many_attempts',
      'retry_after_seconds', ceil(extract(epoch from v_rl.locked_until - v_now)));
  end if;

  if v_code ~ '^[0-9]{6}$' then
    v_key := public._base32_decode(v_secret);
    select s.last_counter into v_last from public.privileged_step_ups s where s.user_id = v_uid;
    for w in -1 .. 1 loop
      if public._totp_code(v_key, v_counter + w) = v_code
         and v_counter + w > coalesce(v_last, 0) then
        v_match := v_counter + w;
        exit;
      end if;
    end loop;
  end if;

  if v_match is null then
    v_fails := case when v_rl.window_start is not null and v_now - v_rl.window_start <= interval '10 minutes'
                    then coalesce(v_rl.failed_attempts, 0) else 0 end + 1;
    insert into public.twofa_rate_limits as r (user_id, failed_attempts, window_start, locked_until)
    values (v_uid, v_fails, v_now,
            case when v_fails >= 5 then v_now + interval '15 minutes' end)
    on conflict (user_id) do update
      set failed_attempts = excluded.failed_attempts,
          window_start    = case when r.window_start is not null and v_now - r.window_start <= interval '10 minutes'
                                 then r.window_start else v_now end,
          locked_until    = excluded.locked_until;
    perform public.log_privileged('step_up.failed', v_uid, null, jsonb_build_object('attempts', v_fails));
    return jsonb_build_object('verified', false, 'error', 'invalid_code');
  end if;

  insert into public.twofa_rate_limits as r (user_id, failed_attempts, window_start, locked_until)
  values (v_uid, 0, v_now, null)
  on conflict (user_id) do update set failed_attempts = 0, window_start = v_now, locked_until = null;

  insert into public.privileged_step_ups as s (user_id, session_id, verified_at, expires_at, last_counter)
  values (v_uid, public._jwt_session_id(), v_now, v_now + interval '10 minutes', v_match)
  on conflict (user_id) do update
    set session_id = excluded.session_id, verified_at = excluded.verified_at,
        expires_at = excluded.expires_at, last_counter = excluded.last_counter;

  perform public.log_privileged('step_up.verified', v_uid, null,
    jsonb_build_object('expires_at', v_now + interval '10 minutes'));
  return jsonb_build_object('verified', true, 'expires_at', v_now + interval '10 minutes');
end;
$$;

revoke all on function public.owner_step_up(text) from public, anon;
grant execute on function public.owner_step_up(text) to authenticated;


-- حالة المالك الأمنية للواجهة: هل 2FA مفعّل؟ ومتى تنتهي نافذة التحقق؟
create or replace function public.owner_security_status()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public.is_platform_owner() then
    raise exception 'لمالك المنصة وحده' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'mfa_enrolled', exists (select 1 from public.user_mfa_secrets s where s.user_id = auth.uid()),
    'step_up_fresh', public.step_up_fresh(),
    'step_up_expires_at', (select s.expires_at from public.privileged_step_ups s
                            where s.user_id = auth.uid() and public.step_up_fresh()),
    'in_owner_context', public.owner_capability('owner_only')
  );
end;
$$;

revoke all on function public.owner_security_status() from public, anon;
grant execute on function public.owner_security_status() to authenticated;


-- رتبة فريق المنصة: admin / support / user — تمرّ بنفس المحفّزات أعلاه
create or replace function public.owner_set_staff_role(p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not public.owner_critical_ok() then
    raise exception 'إدارة الإداريين لمالك المنصة وحده، داخل واجهته، بعد التحقق بخطوتين'
      using errcode = '42501';
  end if;
  if p_role not in ('admin', 'support', 'user') then
    raise exception 'رتبة غير مسموحة: %', p_role using errcode = '22023';
  end if;
  if public.account_tier(p_user_id) = 'owner' then
    raise exception 'رتبة مالك المنصة ثابتة' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'الحساب غير موجود' using errcode = '22023';
  end if;

  -- مدير منصة يُخفَّض: صف السلطة والتفويض يسقطان معه، لا يبقيان معلّقَين
  if p_role <> 'admin' then
    delete from public.platform_authority where user_id = p_user_id and level = 'elevated_admin';
    delete from public.platform_capability_grants where user_id = p_user_id;
  end if;

  update public.profiles set role = p_role where id = p_user_id and role is distinct from p_role;
end;
$$;

revoke all on function public.owner_set_staff_role(uuid, text) from public, anon;
grant execute on function public.owner_set_staff_role(uuid, text) to authenticated;


create or replace function public.owner_set_platform_admin(p_user_id uuid, p_enabled boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not public.owner_critical_ok() then
    raise exception 'تعيين مديري المنصة لمالك المنصة وحده، داخل واجهته، بعد التحقق بخطوتين'
      using errcode = '42501';
  end if;
  if public.account_tier(p_user_id) = 'owner' then
    raise exception 'مالك المنصة ليس مديرًا' using errcode = '22023';
  end if;

  if p_enabled then
    if not exists (select 1 from public.profiles where id = p_user_id and role = 'admin') then
      raise exception 'مدير المنصة يجب أن يحمل رتبة admin أولًا' using errcode = '22023';
    end if;
    insert into public.platform_authority (user_id, level, note)
    values (p_user_id, 'elevated_admin', nullif(btrim(coalesce(p_note, '')), ''))
    on conflict (user_id) do nothing;
  else
    delete from public.platform_authority where user_id = p_user_id and level = 'elevated_admin';
  end if;
end;
$$;

revoke all on function public.owner_set_platform_admin(uuid, boolean, text) from public, anon;
grant execute on function public.owner_set_platform_admin(uuid, boolean, text) to authenticated;


create or replace function public.owner_set_capability(
  p_user_id uuid, p_capability text, p_enabled boolean, p_note text default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not public.owner_critical_ok() then
    raise exception 'التفويض يمنحه مالك المنصة وحده، داخل واجهته، بعد التحقق بخطوتين'
      using errcode = '42501';
  end if;
  if p_enabled then
    if not exists (select 1 from public.profiles where id = p_user_id and role = 'admin') then
      raise exception 'التفويض يُمنح لحساب برتبة admin فقط' using errcode = '22023';
    end if;
    insert into public.platform_capability_grants (user_id, capability, granted_by, note)
    values (p_user_id, p_capability, auth.uid(), nullif(btrim(coalesce(p_note, '')), ''))
    on conflict (user_id, capability) do update
      set granted_by = excluded.granted_by, granted_at = now(), note = excluded.note;
  else
    delete from public.platform_capability_grants where user_id = p_user_id and capability = p_capability;
  end if;
end;
$$;

revoke all on function public.owner_set_capability(uuid, text, boolean, text) from public, anon;
grant execute on function public.owner_set_capability(uuid, text, boolean, text) to authenticated;


-- 052: منح/سحب مدير SIE صارا عمليتين حرجتين — تحقق بخطوتين حديث
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
  if not public.step_up_fresh() then
    raise exception 'منح إدارة SIE يتطلب التحقق بخطوتين' using errcode = '42501';
  end if;

  select p.role into v_role from public.profiles p where p.id = p_user_id;
  if v_role is null then
    raise exception 'الحساب غير موجود' using errcode = '22023';
  end if;
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
  if not public.step_up_fresh() then
    raise exception 'سحب إدارة SIE يتطلب التحقق بخطوتين' using errcode = '42501';
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


-- ============================================================================
-- 7) تحقق
-- ============================================================================
do $$
begin
  if pg_get_functiondef('public.gate_is_exempt_account(uuid)'::regprocedure) ~* '(email|@mad3oom)' then
    raise exception 'إعفاء البوابة ما زال بالبريد';
  end if;
  if pg_get_functiondef('public.guard_profile_role_change()'::regprocedure) ~ 'has_elevated_authority' then
    raise exception 'السلطة المرتفعة ما زالت تمنح الرتب';
  end if;
  if exists (select 1 from pg_policies
              where schemaname = 'public'
                and tablename in ('privileged_audit', 'privileged_step_ups', 'platform_capability_grants')
                and cmd <> 'SELECT') then
    raise exception 'سياسة كتابة على جدول سلطة';
  end if;
  if public._totp_code(public._base32_decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), 1) <> '287082' then
    raise exception 'TOTP لا يطابق متجه RFC 6238';
  end if;
  raise notice '053: الملكية محمية، وإدارة الإداريين للمالك وحده بتحقق بخطوتين';
end $$;

-- ============================================================================
-- التراجع (بالترتيب، من ترحيل):
--   drop trigger guard_privileged_accounts on public.profiles;
--   drop trigger trg_audit_profile_privileged on public.profiles;
--   drop trigger trg_audit_platform_authority on public.platform_authority;
--   drop trigger trg_audit_capability_grants on public.platform_capability_grants;
--   drop trigger trg_audit_sie_admin_grants on public.sie_admin_grants;
--   drop trigger trg_audit_sie_settings on public.sie_settings;
--   -- وإعادة guard_profile_role_change و guard_platform_authority_write و
--   -- gate_is_exempt_account و owner_*_sie_admin إلى تعريفاتها في 040/038/042/052.
--   -- الجداول الجديدة تبقى (سجل) أو تُحذف: privileged_audit, privileged_step_ups,
--   -- platform_capability_grants.
-- ============================================================================
