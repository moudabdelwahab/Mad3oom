-- ============================================================================
-- التراجع عن 110_api_token_credentials_immutable — يعيد guard_api_token_protected_columns كما في 043 والإنتاج حرفيًا
-- (md5 لـ pg_get_functiondef في الإنتاج 2026-10-20 قبل 110: 6b6b4b14e7f1b312f362cfb5fe9612c6). لا بيانات تتغير.
--   psql --single-transaction -v ON_ERROR_STOP=1 -f migrations/_rollback/110_api_token_credentials_immutable.down.sql
--
-- التراجع يعيد F7: الأدمن يكتب secret_hash و bearer_token_hash و user_id لمفتاح غيره مباشرة ثم يصادق بهويته.
-- لا يُشغَّل ما دام company_isolation_enforced مفعّلًا إلا بقرار صريح: العزل لا يصمد أمام انتحال مالك الشركة.
-- ============================================================================
do $$ begin
  if to_regprocedure('public._feature_on(text)') is not null and public._feature_on('company_isolation_enforced') then
    raise exception 'التراجع عن 110 مرفوض: company_isolation_enforced مفعّل، والتراجع يعيد انتحال مالك الشركة عبر مفتاح API (F7)';
  end if;
end $$;

-- تعريف الإنتاج حرفيًا (مخرَج pg_get_functiondef، tests/fixtures/prod-shape/50_functions_a.sql). الصلاحيات لا تتغير.
CREATE OR REPLACE FUNCTION public.guard_api_token_protected_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_changed text[] := '{}';
begin
  if  new.user_id             is not distinct from old.user_id
  and new.scopes              is not distinct from old.scopes
  and new.api_key             is not distinct from old.api_key
  and new.secret_hash         is not distinct from old.secret_hash
  and new.bearer_token_hash   is not distinct from old.bearer_token_hash
  and new.secret_last_four    is not distinct from old.secret_last_four
  and new.bearer_last_four    is not distinct from old.bearer_last_four
  and new.credential_type     is not distinct from old.credential_type
  and new.credential_group_id is not distinct from old.credential_group_id
  and new.expires_at          is not distinct from old.expires_at
  and new.created_at          is not distinct from old.created_at
  and new.created_by_role     is not distinct from old.created_by_role
  then
    return new;
  end if;

  if auth.uid() is null then
    return new;
  end if;

  if public.is_admin() then
    return new;
  end if;

  if new.user_id             is distinct from old.user_id             then v_changed := v_changed || 'user_id'::text; end if;
  if new.scopes              is distinct from old.scopes              then v_changed := v_changed || 'scopes'::text; end if;
  if new.api_key             is distinct from old.api_key             then v_changed := v_changed || 'api_key'::text; end if;
  if new.secret_hash         is distinct from old.secret_hash         then v_changed := v_changed || 'secret_hash'::text; end if;
  if new.bearer_token_hash   is distinct from old.bearer_token_hash   then v_changed := v_changed || 'bearer_token_hash'::text; end if;
  if new.secret_last_four    is distinct from old.secret_last_four    then v_changed := v_changed || 'secret_last_four'::text; end if;
  if new.bearer_last_four    is distinct from old.bearer_last_four    then v_changed := v_changed || 'bearer_last_four'::text; end if;
  if new.credential_type     is distinct from old.credential_type     then v_changed := v_changed || 'credential_type'::text; end if;
  if new.credential_group_id is distinct from old.credential_group_id then v_changed := v_changed || 'credential_group_id'::text; end if;
  if new.expires_at          is distinct from old.expires_at          then v_changed := v_changed || 'expires_at'::text; end if;
  if new.created_at          is distinct from old.created_at          then v_changed := v_changed || 'created_at'::text; end if;
  if new.created_by_role     is distinct from old.created_by_role     then v_changed := v_changed || 'created_by_role'::text; end if;

  raise exception 'هذه الحقول لا تُعدَّل من حساب المستخدم: %. الصلاحيات تُحدَّد عند الإصدار وحده.',
    array_to_string(v_changed, ', ')
    using errcode = '42501';
end $function$;
