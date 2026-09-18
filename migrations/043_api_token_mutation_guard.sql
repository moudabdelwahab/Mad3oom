-- ============================================================================
-- 043_api_token_mutation_guard.sql
--   سقف صلاحيات المفتاح يُفرَض بعد الإصدار، لا عنده فقط.
--
-- ════════════════════════════════════════════════════════════════════════════
-- الثغرة (C-03 في FULL_PROJECT_AUDIT.md)
-- ════════════════════════════════════════════════════════════════════════════
-- الترحيل 036 بنى سقف صلاحيات على الخادم (api_token_scope_ceiling) ويفرضه
-- create-api-token عند **الإصدار**. لكن لا شيء كان يفرضه بعد ذلك:
--
--   • سياسة UPDATE اسمها «Users can toggle active state of their own tokens»
--     لكن مُسنَدها `auth.uid() = user_id` وحده — وRLS **لا تقيّد الأعمدة**.
--   • المنح على مستوى الجدول يشمل UPDATE على كل عمود، ومنه `scopes`.
--   • لا محفّز BEFORE UPDATE على مستوى الصف يحرس أي عمود.
--
-- فنداء واحد يكفي:
--   PATCH /rest/v1/api_tokens?id=eq.<own>
--   {"scopes":["admin:full","settings:manage","oauth:manage"],
--    "is_active":true,"revoked_at":null,"expires_at":null}
--
-- أُثبت على الإنتاج داخل معاملة انتهت بـROLLBACK: النطاقات تغيّرت فعلًا،
-- والإبطال أُلغي، وتاريخ الانتهاء أُزيل.
--
-- ولاحظ الأثر المزدوج: نفس النداء **يُحيي مفتاحًا مبطَلًا**، أي أن إبطال مفتاح
-- مسرَّب من لوحة الإدارة كان قابلًا للتراجع من قِبَل صاحبه.
--
-- ════════════════════════════════════════════════════════════════════════════
-- الشكل
-- ════════════════════════════════════════════════════════════════════════════
-- نفس نمط guard_profile_protected_columns في 027 حرفيًا، للاتساق:
--   ① المسار الشائع أولًا (لا عمود حسّاس تغيّر) — أرخص فرع ولا ينادي شيئًا
--   ② auth.uid() IS NULL  → مفتاح خدمة أو مهمة خلفية
--   ③ is_admin()          → إدارة المنصة، وسقفها كامل في 036 على أي حال
--   ④ غير ذلك             → رفض مع تسمية الأعمدة المرفوضة
--
-- ما يبقى مسموحًا للمستخدم العادي على مفتاحه: is_active و revoked_at (زرّا
-- الإيقاف/التفعيل في assets/js/admin/api-integrations.js و
-- assets/js/company/company-api.js) والاسم والوصف وعدّادات الاستخدام.
--
-- ما لا يبقى مسموحًا: scopes · user_id · api_key · secret_hash ·
-- bearer_token_hash · *_last_four · credential_type · credential_group_id ·
-- expires_at · created_at · created_by_role.
--
-- ════════════════════════════════════════════════════════════════════════════
-- مسارات مشروعة فُحصت قبل الكتابة — كلها تمرّ
-- ════════════════════════════════════════════════════════════════════════════
--   • increment_api_token_usage()          service_role ⇒ auth.uid() IS NULL
--   • verifyApiToken() في دوال الحافة       service_role ⇒ auth.uid() IS NULL
--   • regenerate-api-token-secret           service_role ⇒ auth.uid() IS NULL
--   • toggleApiToken() في لوحة الإدارة      is_active + revoked_at ⇒ مسموحان
--   • toggle في لوحة الشركة                 is_active ⇒ مسموح
--
-- ROLLBACK
--   drop trigger if exists guard_api_token_protected_columns on public.api_tokens;
--   drop function if exists public.guard_api_token_protected_columns();
-- ============================================================================

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

  -- ② مفتاح الخدمة أو مهمة خلفية: لا مستخدم في السياق.
  --    هذا هو المخرج الذي تستعمله regenerate-api-token-secret ودوال الحافة.
  if auth.uid() is null then
    return new;
  end if;

  -- ③ إدارة المنصة: سقفها في 036 هو القائمة الكاملة أصلًا، فلا شيء يُلتف عليه.
  if public.is_admin() then
    return new;
  end if;

  -- ④ أي أحد آخر — ومنه صاحب المفتاح نفسه.
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
end $$;

revoke all on function public.guard_api_token_protected_columns() from public, anon, authenticated;

drop trigger if exists guard_api_token_protected_columns on public.api_tokens;
create trigger guard_api_token_protected_columns
  before update on public.api_tokens
  for each row execute function public.guard_api_token_protected_columns();

-- ============================================================================
-- تحقق ذاتي
-- ============================================================================
do $$
begin
  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where c.relname = 'api_tokens' and t.tgname = 'guard_api_token_protected_columns'
  ) then
    raise exception 'محفّز حراسة مفاتيح API لم يُركَّب';
  end if;

  raise notice '043: سقف صلاحيات المفتاح مفروض بعد الإصدار لا عنده فقط';
end $$;
