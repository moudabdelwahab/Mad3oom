-- ============================================================================
-- 110_api_token_credentials_immutable.sql — أعمدة الاعتماد في api_tokens لا يكتبها أي JWT، والأدمن منه (F7)
--
-- الثغرة (F7، docs/tenancy/PHASE1_READINESS_2026-10-20.md §4.2): سياسة UPDATE «Admin can update any api token»
--   تسمح للأدمن بكل صف، والمحفّز guard_api_token_protected_columns (043) يستثني is_admin() من كل الأعمدة.
--   فنداء واحد يكفي:
--     PATCH /rest/v1/api_tokens?id=eq.<مفتاح غيره>  {"secret_hash":"<sha256 لسر يختاره>","is_active":true,"revoked_at":null}
--   ثم يصادق الأدمن بذلك السر، فيعيد mcp/_shared/api-auth.ts هوية صاحب المفتاح (مالك المنصة أو مالك شركة)،
--   ومنها بيانات شركته رغم العزل. ومثله bearer_token_hash، أو نقل المفتاح لحساب آخر بتغيير user_id.
--
-- الإصلاح: أعمدة الهوية والاعتماد (user_id، api_key، secret_hash، bearer_token_hash، secret_last_four،
--   bearer_last_four، credential_type، credential_group_id، created_at، created_by_role) تُرفض لكل نداء بهوية
--   مستخدم، الأدمن ومالك المنصة منه. كل كتابة مشروعة لها بمفتاح الخدمة (auth.uid() فارغ): create-api-token
--   و regenerate-api-token-secret و oauth-token. استثناء الأدمن يبقى لـ scopes و expires_at وحدهما: سقفه في 036
--   كامل، وتعديلهما لا يعطيه سرًا. التفعيل والإيقاف والاسم والوصف والعدّادات بلا تغيير لأحد.
--
-- لا مفتاح تفعيل ولا تغيير بيانات. الصلاحيات كما هي (create or replace). قابل لإعادة التشغيل.
-- التراجع: migrations/_rollback/110_api_token_credentials_immutable.down.sql
-- ============================================================================
do $$
begin
  if to_regprocedure('public.guard_api_token_protected_columns()') is null or to_regprocedure('public.is_admin()') is null
     or not exists (select 1 from pg_trigger where tgrelid = 'public.api_tokens'::regclass
                     and tgname = 'guard_api_token_protected_columns' and not tgisinternal) then
    raise exception '110 يتطلب 043 (guard_api_token_protected_columns ومحفّزه على api_tokens)';
  end if;
end $$;

create or replace function public.guard_api_token_protected_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_changed text[] := '{}';
begin
  -- ① المسار الشائع: لا عمود حسّاس تغيّر (تفعيل/إيقاف، تحديث عدّاد استخدام)
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

  -- ② مفتاح الخدمة أو مهمة خلفية: لا مستخدم في السياق. المخرج الوحيد لكتابة الاعتماد.
  if auth.uid() is null then
    return new;
  end if;

  -- ③ الهوية والاعتماد: مرفوضة لكل مستخدم، الأدمن منه (110، F7)
  if new.user_id             is distinct from old.user_id             then v_changed := v_changed || 'user_id'::text; end if;
  if new.api_key             is distinct from old.api_key             then v_changed := v_changed || 'api_key'::text; end if;
  if new.secret_hash         is distinct from old.secret_hash         then v_changed := v_changed || 'secret_hash'::text; end if;
  if new.bearer_token_hash   is distinct from old.bearer_token_hash   then v_changed := v_changed || 'bearer_token_hash'::text; end if;
  if new.secret_last_four    is distinct from old.secret_last_four    then v_changed := v_changed || 'secret_last_four'::text; end if;
  if new.bearer_last_four    is distinct from old.bearer_last_four    then v_changed := v_changed || 'bearer_last_four'::text; end if;
  if new.credential_type     is distinct from old.credential_type     then v_changed := v_changed || 'credential_type'::text; end if;
  if new.credential_group_id is distinct from old.credential_group_id then v_changed := v_changed || 'credential_group_id'::text; end if;
  if new.created_at          is distinct from old.created_at          then v_changed := v_changed || 'created_at'::text; end if;
  if new.created_by_role     is distinct from old.created_by_role     then v_changed := v_changed || 'created_by_role'::text; end if;
  if cardinality(v_changed) > 0 then
    raise exception 'هذه الحقول لا تُعدَّل من حساب مستخدم ولو كان أدمن: %. الاعتماد يُصدَر ويُجدَّد عبر دوال الحافة وحدها.',
      array_to_string(v_changed, ', ')
      using errcode = '42501';
  end if;

  -- ④ إدارة المنصة: scopes و expires_at (سقفها في 036 هو القائمة الكاملة أصلًا)
  if public.is_admin() then
    return new;
  end if;

  -- ⑤ أي أحد آخر — ومنه صاحب المفتاح نفسه.
  if new.scopes              is distinct from old.scopes              then v_changed := v_changed || 'scopes'::text; end if;
  if new.expires_at          is distinct from old.expires_at          then v_changed := v_changed || 'expires_at'::text; end if;

  raise exception 'هذه الحقول لا تُعدَّل من حساب المستخدم: %. الصلاحيات تُحدَّد عند الإصدار وحده.',
    array_to_string(v_changed, ', ')
    using errcode = '42501';
end $$;

revoke all on function public.guard_api_token_protected_columns() from public, anon, authenticated;

-- التحقق
do $$
declare d text := pg_get_functiondef('public.guard_api_token_protected_columns()'::regprocedure);
begin
  if position('ولو كان أدمن' in d) = 0 or position('if cardinality(v_changed) > 0' in d) = 0
     or position('if cardinality(v_changed) > 0' in d) > position('if public.is_admin()' in d) then
    raise exception '110: الحارس غير مركّب';
  end if;
  if has_function_privilege('authenticated', 'public.guard_api_token_protected_columns()', 'execute')
     or has_function_privilege('anon', 'public.guard_api_token_protected_columns()', 'execute') then
    raise exception '110: الحارس قابل للتنفيذ من authenticated أو anon';
  end if;
end $$;
