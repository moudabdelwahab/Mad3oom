-- ============================================================================
-- 112 — بريد دعوات عملاء الشركة، وحالة إرساله، ورابط قبول آمن
--
-- السبب (2026-10-21): «إرسال دعوة» من لوحة الشركة لم يكن يرسل بريدًا قط. company_invite_customer
-- (096) يُدرج صفًا، ويضيف إشعارًا داخل المنصة فقط إن كان للبريد حساب قائم؛ ولا مسار في أي دالة
-- يرسل بريد دعوة. فالدعوة لبريد بلا حساب تبقى «معلّقة» بلا إشعار ولا بريد، ولا يربطها شيء بحساب
-- يُنشأ لاحقًا. والواجهة كانت تكتب «أُرسلت» لصف محفوظ فقط.
--
-- ما يضيفه هذا الترحيل (الإرسال نفسه في دالة Edge: company-invite-customer):
--   1) حالة البريد على الدعوة: not_sent | sending | sent | failed، وعدد المحاولات ووقتها ومعرّف الرسالة
--      لدى المزوّد ورمز خطأ داخلي قصير. «معلّقة» وحدها لم تعد تعني «وصل بريد».
--   2) رمز قبول: يُولَّد في القاعدة، ويُخزَّن **تجزئته** وحدها (sha256)، ويُسلَّم نصّه مرة واحدة لدالة
--      الخادم لتضعه في الرابط. كل إعادة إرسال تولّد رمزًا جديدًا وتُبطل السابق.
--   3) _company_invitation_prepare_email / _company_invitation_email_result: لمفتاح الخدمة وحده.
--      تمنع التكرار: لا إرسال ثانٍ لدعوة أُرسلت إلا بطلب صريح، ولا إرسالين متزامنين، ومهلة 60 ثانية
--      بين المحاولات، و5 محاولات للدعوة، و100 بريد للشركة في 24 ساعة.
--   4) company_invite_customer يعيد معرّف الدعوة (الجديدة أو المعلّقة نفسها للبريد نفسه) — لا صف ثانٍ.
--   5) company_invitation_claim(p_token): يربط الدعوة بحساب المستخدم الحالي إن كان **بريده المؤكَّد**
--      هو البريد المدعو نفسه. رابط مُعاد توجيهه لا يضيف حسابًا آخر. أي اختلاف = «غير موجودة أو انتهت»
--      (لا كاشف). القبول نفسه يبقى company_invitation_respond (096) بفحوصه كما هي.
--   6) company_invitations_list يعرض حالة البريد للشركة.
--
-- نصوص الدوال المعدّلة من الإنتاج (2026-10-21) حرفيًا مع الإضافات. لا تغيير في الصلاحيات ولا العضوية
-- ولا العزل: الدعوة تمنح عضوية عميل في شركتها وحدها، بعد قبول صاحب الحساب، كما في 096.
-- التراجع: migrations/_rollback/112_company_invitation_email.down.sql
-- ============================================================================

-- ── 1) أعمدة حالة البريد والرمز ─────────────────────────────────────────────
alter table public.company_membership_invitations
  add column if not exists token_hash            text,
  add column if not exists email_status          text not null default 'not_sent',
  add column if not exists email_attempts        integer not null default 0,
  add column if not exists email_last_attempt_at timestamptz,
  add column if not exists email_sent_at         timestamptz,
  add column if not exists email_message_id      text,
  add column if not exists email_error           text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'company_membership_invitations_email_status') then
    alter table public.company_membership_invitations
      add constraint company_membership_invitations_email_status
      check (email_status in ('not_sent', 'sending', 'sent', 'failed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'company_membership_invitations_email_error') then
    alter table public.company_membership_invitations
      add constraint company_membership_invitations_email_error
      check (email_error is null or email_error ~ '^[a-z_]{1,40}$');
  end if;
end $$;

create unique index if not exists company_membership_invitations_token
  on public.company_membership_invitations (token_hash) where token_hash is not null;

comment on column public.company_membership_invitations.token_hash is
  '112: sha256 لرمز رابط القبول. النص لا يُخزَّن؛ يُسلَّم مرة لدالة الإرسال. إعادة الإرسال تستبدله.';
comment on column public.company_membership_invitations.email_status is
  '112: حالة بريد الدعوة لدى المزوّد. sent = قَبِل المزوّد الرسالة للإرسال (ليس تأكيد وصول).';

-- ── 2) الدعوة: تعيد معرّفها ─────────────────────────────────────────────────
create or replace function public.company_invite_customer(p_email text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_company uuid;
  v_email   text := lower(btrim(coalesce(p_email, '')));
  v_invitee uuid;
  v_inv     uuid;
  v_name    text;
begin
  perform public._membership_require_multi();
  v_company := public._company_staff_require_manager();
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or char_length(v_email) > 320 then
    raise exception 'بريد إلكتروني غير صالح' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  if (select count(*) from public.company_membership_invitations
       where company_id = v_company and status = 'pending') >= 200 then
    raise exception 'دعوات معلّقة كثيرة — ألغِ بعضها أولًا' using errcode = '54000';
  end if;
  -- 112: الدعوة المعلّقة نفسها للبريد نفسه (لا صف ثانٍ؛ إعادة الإرسال تمر بها)
  select id into v_inv from public.company_membership_invitations
   where company_id = v_company and lower(invited_email) = v_email and status = 'pending'
     and expires_at > now();
  if v_inv is not null then
    return jsonb_build_object('status', 'pending', 'invitation_id', v_inv, 'existing', true);
  end if;
  -- معلّقة منتهية: تُغلق فتُفسح للفهرس الفريد دعوة جديدة
  update public.company_membership_invitations set status = 'expired', responded_at = now()
   where company_id = v_company and lower(invited_email) = v_email and status = 'pending' and expires_at <= now();

  select p.id into v_invitee from public.profiles p
   where lower(p.email) = v_email
     and coalesce(p.role, '') not in ('platform_owner', 'admin', 'support')
     and not public.owns_a_company(p.id)
     and not public._company_member_active(v_company, p.id)
   limit 1;

  insert into public.company_membership_invitations (company_id, invited_email, invitee_user_id, invited_by)
  values (v_company, v_email, v_invitee, auth.uid())
  returning id into v_inv;

  if v_invitee is not null then
    select company_name into v_name from public.companies where id = v_company;
    perform public._membership_event(v_company, v_invitee, 'invited', jsonb_build_object('invitation_id', v_inv));
    insert into public.notifications (user_id, title, message, type, link, category)
    values (v_invitee, 'دعوة للانضمام إلى شركة',
            'دعتك شركة «' || coalesce(v_name, '') || '» لتكون من عملائها. راجع الدعوة في بوابة العملاء.',
            'info', '/portal/#invitations', 'account');
  end if;
  return jsonb_build_object('status', 'pending', 'invitation_id', v_inv, 'existing', false);
end
$function$;

-- ── 3) تحضير البريد (مفتاح الخدمة وحده) ─────────────────────────────────────
-- p_resend: إعادة إرسال صريحة من الشركة لدعوة أُرسل بريدها. بلاه: دعوة أُرسلت لا تُرسل ثانية.
create or replace function public._company_invitation_prepare_email(p_invitation uuid, p_resend boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  i       public.company_membership_invitations;
  v_token text;
  v_sent  integer;
begin
  select * into i from public.company_membership_invitations where id = p_invitation for update;
  if not found or i.status <> 'pending' or i.expires_at <= now() then
    return jsonb_build_object('send', false, 'reason', 'not_pending');
  end if;
  if i.email_status = 'sent' and not coalesce(p_resend, false) then
    return jsonb_build_object('send', false, 'reason', 'already_sent');
  end if;
  if i.email_status = 'sending' and i.email_last_attempt_at > now() - interval '2 minutes' then
    return jsonb_build_object('send', false, 'reason', 'in_flight');
  end if;
  if i.email_last_attempt_at > now() - interval '60 seconds' then
    return jsonb_build_object('send', false, 'reason', 'cooldown');
  end if;
  if i.email_attempts >= 5 then
    return jsonb_build_object('send', false, 'reason', 'too_many_attempts');
  end if;
  select count(*) into v_sent from public.company_membership_invitations
   where company_id = i.company_id and email_last_attempt_at > now() - interval '24 hours';
  if v_sent >= 100 then
    return jsonb_build_object('send', false, 'reason', 'company_daily_cap');
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  update public.company_membership_invitations
     set token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex'),
         email_status = 'sending',
         email_attempts = email_attempts + 1,
         email_last_attempt_at = now(),
         email_error = null
   where id = i.id;
  return jsonb_build_object(
    'send', true,
    'token', v_token,
    'email', i.invited_email,
    'company_name', (select company_name from public.companies where id = i.company_id),
    'expires_at', i.expires_at,
    'attempt', i.email_attempts + 1);
end
$function$;

create or replace function public._company_invitation_email_result(p_invitation uuid, p_ok boolean,
                                                                   p_message_id text default null,
                                                                   p_error text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_error text := case when p_error ~ '^[a-z_]{1,40}$' then p_error else 'provider_error' end;
begin
  update public.company_membership_invitations
     set email_status     = case when p_ok then 'sent' else 'failed' end,
         email_sent_at    = case when p_ok then now() else email_sent_at end,
         email_message_id = case when p_ok then left(p_message_id, 200) else email_message_id end,
         email_error      = case when p_ok then null else v_error end
   where id = p_invitation and email_status = 'sending';
  return jsonb_build_object('recorded', found);
end
$function$;

-- ── 4) ربط الدعوة بالحساب عبر الرابط ────────────────────────────────────────
create or replace function public.company_invitation_claim(p_token text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid   uuid := auth.uid();
  v_email text;
  i       public.company_membership_invitations;
begin
  perform public._membership_require_multi();
  if v_uid is null or coalesce(public.preview_mode(), true) then
    raise exception 'غير مسموح' using errcode = '42501';
  end if;
  -- البريد المؤكَّد للحساب نفسه — لا بريد يرسله المتصفح
  select lower(u.email) into v_email from auth.users u
   where u.id = v_uid and u.email_confirmed_at is not null;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' or v_email is null then
    raise exception 'الدعوة غير موجودة أو انتهت' using errcode = 'P0002';
  end if;
  select * into i from public.company_membership_invitations
   where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex') for update;
  if not found or i.status <> 'pending' or i.expires_at <= now()
     or lower(i.invited_email) <> v_email
     or (i.invitee_user_id is not null and i.invitee_user_id <> v_uid) then
    raise exception 'الدعوة غير موجودة أو انتهت' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.profiles p where p.id = v_uid and p.role in ('platform_owner', 'admin', 'support'))
     or public.owns_a_company(v_uid) then
    raise exception 'هذا الحساب لا ينضم لشركات كعميل' using errcode = '42501';
  end if;
  if public._company_member_active(i.company_id, v_uid) then
    return jsonb_build_object('already_member', true,
                              'company_name', (select company_name from public.companies where id = i.company_id));
  end if;
  if i.invitee_user_id is null then
    update public.company_membership_invitations set invitee_user_id = v_uid where id = i.id;
    perform public._membership_event(i.company_id, v_uid, 'invited',
                                     jsonb_build_object('invitation_id', i.id, 'via', 'email_link'));
  end if;
  return jsonb_build_object(
    'invitation_id', i.id,
    'company_name', (select company_name from public.companies where id = i.company_id),
    'expires_at', i.expires_at,
    'account_active', coalesce(public.account_is_active(), false));
end
$function$;

-- ── 5) قائمة الشركة: حالة البريد ────────────────────────────────────────────
create or replace function public.company_invitations_list()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_company uuid;
begin
  if public.company_staff_role() is distinct from 'admin' then
    return null;
  end if;
  v_company := public.current_company_id();
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'id', i.id, 'email', i.invited_email,
            'status', case when i.status = 'pending' and i.expires_at <= now() then 'expired' else i.status end,
            'email_status', i.email_status, 'email_sent_at', i.email_sent_at,
            'created_at', i.created_at, 'expires_at', i.expires_at, 'responded_at', i.responded_at)
            order by i.created_at desc), '[]'::jsonb)
            from (select * from public.company_membership_invitations
                   where company_id = v_company order by created_at desc limit 200) i);
end
$function$;

-- ── 6) الصلاحيات ────────────────────────────────────────────────────────────
revoke all on function public._company_invitation_prepare_email(uuid, boolean) from public, anon, authenticated;
revoke all on function public._company_invitation_email_result(uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function public._company_invitation_prepare_email(uuid, boolean) to service_role;
grant execute on function public._company_invitation_email_result(uuid, boolean, text, text) to service_role;
revoke all on function public.company_invitation_claim(text) from public, anon;
grant execute on function public.company_invitation_claim(text) to authenticated;
revoke all on function public.company_invite_customer(text) from public, anon;
grant execute on function public.company_invite_customer(text) to authenticated;
revoke all on function public.company_invitations_list() from public, anon;
grant execute on function public.company_invitations_list() to authenticated;

-- ── 7) فحص ذاتي ─────────────────────────────────────────────────────────────
do $$
begin
  if has_function_privilege('authenticated', 'public._company_invitation_prepare_email(uuid, boolean)', 'execute')
     or has_function_privilege('anon', 'public._company_invitation_prepare_email(uuid, boolean)', 'execute')
     or has_function_privilege('authenticated', 'public._company_invitation_email_result(uuid, boolean, text, text)', 'execute')
     or has_function_privilege('anon', 'public.company_invitation_claim(text)', 'execute') then
    raise exception '112: صلاحيات دوال البريد أوسع من المقصود';
  end if;
  if not has_function_privilege('service_role', 'public._company_invitation_prepare_email(uuid, boolean)', 'execute') then
    raise exception '112: مفتاح الخدمة لا ينفّذ تحضير البريد';
  end if;
  if exists (select 1 from information_schema.role_table_grants
              where table_schema = 'public' and table_name = 'company_membership_invitations'
                and grantee in ('anon', 'authenticated')) then
    raise exception '112: جدول الدعوات صار مقروءًا مباشرة';
  end if;
end $$;
