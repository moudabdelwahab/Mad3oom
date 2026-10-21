-- ============================================================================
-- تراجع 112 — يعيد company_invite_customer وcompany_invitations_list بنصّي الإنتاج قبل 112
-- (2026-10-21) حرفيًا، ويحذف دوال البريد والرابط وأعمدة حالة البريد.
-- أثره: الدعوات المرسلة تبقى صفوفًا معلّقة؛ روابط القبول في البريد تتوقف (لا claim).
-- دالة Edge «company-invite-customer» يجب إيقافها/استرجاع الواجهة قبل تطبيق هذا.
-- ============================================================================
drop function if exists public.company_invitation_claim(text);
drop function if exists public._company_invitation_email_result(uuid, boolean, text, text);
drop function if exists public._company_invitation_prepare_email(uuid, boolean);

CREATE OR REPLACE FUNCTION public.company_invitations_list()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
            'created_at', i.created_at, 'expires_at', i.expires_at, 'responded_at', i.responded_at)
            order by i.created_at desc), '[]'::jsonb)
            from (select * from public.company_membership_invitations
                   where company_id = v_company order by created_at desc limit 200) i);
end $function$
;

CREATE OR REPLACE FUNCTION public.company_invite_customer(p_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if exists (select 1 from public.company_membership_invitations
              where company_id = v_company and lower(invited_email) = v_email and status = 'pending') then
    return jsonb_build_object('status', 'pending');
  end if;

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
  return jsonb_build_object('status', 'pending');
end $function$
;

drop index if exists public.company_membership_invitations_token;
alter table public.company_membership_invitations
  drop constraint if exists company_membership_invitations_email_status,
  drop constraint if exists company_membership_invitations_email_error,
  drop column if exists token_hash,
  drop column if exists email_status,
  drop column if exists email_attempts,
  drop column if exists email_last_attempt_at,
  drop column if exists email_sent_at,
  drop column if exists email_message_id,
  drop column if exists email_error;
