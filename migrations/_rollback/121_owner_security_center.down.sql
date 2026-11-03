-- ============================================================================
-- التراجع عن 121_owner_security_center
--   يرفض إن وُجد سجل أمان (security_events) أو سجل تغييرات — حذفهما يمحو تدقيقًا حقيقيًا. لتجاوز ذلك بعد
--   تصديرهما:  set local mad3oom.rollback_discard_security_log = 'on';  في المعاملة نفسها.
--   يعيد log_privileged وowner_step_up وowner_security_status إلى تعريفات الإنتاج حرفيًا (نص 053) (نافذة 10 دقائق ثابتة).
-- ============================================================================
do $$
begin
  if coalesce(current_setting('mad3oom.rollback_discard_security_log', true), '') <> 'on'
     and ((to_regclass('public.security_events') is not null and exists (select 1 from public.security_events))
       or (to_regclass('public.settings_change_history') is not null and exists (select 1 from public.settings_change_history))) then
    raise exception 'التراجع عن 121 مرفوض: سجل الأمان أو سجل التغييرات غير فارغ (صدّرهما أولًا)';
  end if;
end $$;

drop trigger if exists trg_security_session_created on auth.sessions;
drop trigger if exists trg_security_session_ended on auth.sessions;
drop trigger if exists trg_guard_owner_account_change on auth.users;
drop trigger if exists trg_enforce_staff_profile_permissions on public.profiles;

do $$
declare t text; c text;
begin
  foreach t in array array['advanced_settings', 'working_hours', 'ticket_distribution_config', 'rules_engine',
                           'custom_roles', 'services', 'incidents', 'knowledge_base', 'blog_posts', 'blog_categories'] loop
    foreach c in array array['insert', 'update', 'delete'] loop
      execute format('drop policy if exists %I on public.%I', 'perm_' || c, t);
    end loop;
  end loop;
  foreach t in array array['advanced_settings', 'working_hours', 'ticket_distribution_config', 'rules_engine',
                           'custom_roles', 'owner_security_policy', 'role_permission_rules'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists trg_record_settings_change on public.%I', t);
    end if;
  end loop;
end $$;
drop policy if exists perm_reply on public.ticket_replies;
drop policy if exists perm_update on public.tickets;
drop policy if exists perm_delete on public.tickets;

drop table if exists public.owner_account_change_requests;
drop table if exists public.ip_geo_cache;
drop table if exists public.settings_change_history;
drop table if exists public.role_permission_rules;
drop table if exists public.permission_catalog;
drop table if exists public.owner_step_up_sessions;

drop function if exists public.owner_account_change_list(int);
drop function if exists public.owner_reject_account_change(uuid, text);
drop function if exists public.owner_approve_account_change(uuid, text);
drop function if exists public._token_hash(text);
drop function if exists public._account_change_set_tokens(uuid, text, text);
drop function if exists public.guard_owner_account_change();
drop function if exists public.owner_global_logout(uuid);
drop function if exists public.owner_revoke_session(uuid);
drop function if exists public.owner_list_sessions(uuid);
drop function if exists public.owner_security_overview(int);
drop function if exists public.owner_ip_correlation(int, int, int);
drop function if exists public.owner_security_log(text, text, text, timestamptz, timestamptz, text, int, int);
drop function if exists public.owner_geo_pending(int);
drop function if exists public.on_auth_session_ended();
drop function if exists public.on_auth_session_created();
drop function if exists public._security_alert_dispatch(text, jsonb);
drop function if exists public.owner_set_security_policy(jsonb);
drop function if exists public.owner_change_history(text, int, int);
drop function if exists public.owner_rollback_change(bigint);
drop function if exists public.record_settings_change();
drop function if exists public.guard_settings_history();
drop function if exists public.enforce_staff_profile_permissions();
drop function if exists public.owner_set_role_permission(text, text, text, boolean);
drop function if exists public.owner_permission_matrix();
drop function if exists public.my_permission_status(text);
drop function if exists public.staff_write_ok(text);
drop function if exists public.owner_step_up_history(int);
drop function if exists public.owner_end_step_up();
drop function if exists public.owner_verify_security_log();
drop function if exists public._deny(text, text);


-- تعريفات الإنتاج حرفيًا (pg_get_functiondef — tests/fixtures/prod-shape/51_functions_b.sql)، أي نص 053
CREATE OR REPLACE FUNCTION public.log_privileged(p_action text, p_target uuid, p_old jsonb, p_new jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.owner_step_up(p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.owner_security_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

revoke all on function public.log_privileged(text, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.owner_step_up(text) from public, anon;
grant execute on function public.owner_step_up(text) to authenticated;
revoke all on function public.owner_security_status() from public, anon;
grant execute on function public.owner_security_status() to authenticated;

drop function if exists public._security_event(text, text, uuid, jsonb, inet, text, text);
drop function if exists public._security_event_hash(public.security_events);
drop table if exists public.security_events;
drop function if exists public.guard_security_events();
drop function if exists public._security_policy();
drop table if exists public.owner_security_policy;
drop function if exists public._platform_owner_id();
drop function if exists public.request_ip();

alter table public.privileged_audit drop column if exists step_up_session;
alter table public.privileged_step_ups drop column if exists session_ref;
alter table public.privileged_step_ups drop column if exists method;

delete from public.internal_service_secrets where key = 'security_alert_internal';
