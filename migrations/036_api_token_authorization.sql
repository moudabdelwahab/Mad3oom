-- ============================================================================
-- 036_api_token_authorization.sql
--   بوابة صلاحية إنشاء مفاتيح API — في القاعدة، لا في الواجهة ولا في TypeScript.
--
-- المشكلة
--   الدالة المنشورة create-api-token تتحقق من الجلسة ثم **تُنشئ المفتاح لأي
--   حساب مسجّل**. لا فحص لرتبة، ولا لعلاقة بشركة، ولا لاستحقاق. وقائمة
--   الصلاحيات المسموحة تشمل admin:full و settings:manage و oauth:manage —
--   أي أن أي عميل يقدر بنداء مباشر أن يصدر لنفسه مفتاحًا يحمل صلاحيات
--   مشغّل المنصة. وإخفاء الخيارات في الواجهة لا يمنع ذلك إطلاقًا.
--
-- التصميم
--   دالتان تُجيبان عن السؤالين اللذين لا يجوز أن يُجابا في الواجهة:
--     can_create_api_token()      هل يحق لهذا المنادي إصدار مفتاح أصلًا؟
--     api_token_scope_ceiling()   وما أقصى ما يجوز أن يحمله مفتاحه؟
--
--   القرار ذرّي: الرتبة والعلاقة والاستحقاق في نداء واحد، فلا تنفصل الشروط
--   عن بعضها ولا تُعاد صياغتها في لغة ثانية قد تنحرف.
--
-- الفصل الصارم محفوظ كما في 035
--   طاقم المنصة وحده يبلغ سقف الصلاحيات الكامل. مدير الشركة يبلغ سقفًا
--   أضيق لا يشمل صلاحيات مشغّل المنصة — وهذا **حاجز خادم** لا تنظيم واجهة.
-- ============================================================================

-- ── سقف الصلاحيات لكل نطاق سلطة ───────────────────────────────────────────
--
-- القائمة الكاملة مطابقة لـALLOWED_SCOPES في الدالة المنشورة حرفيًا.
-- والفرق الوحيد بين السقفين هو الصلاحيات الثلاث التي تخصّ مشغّل المنصة.
create or replace function public.api_token_scope_ceiling()
returns text[]
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_platform_only constant text[] := array['admin:full', 'settings:manage', 'oauth:manage'];
  v_all constant text[] := array[
    'tickets:read', 'tickets:write', 'tickets:delete',
    'knowledge_base:read', 'knowledge_base:write',
    'customers:read', 'customers:write',
    'whatsapp:read', 'whatsapp:send',
    'analytics:read',
    'settings:manage', 'oauth:manage', 'mcp:connect', 'chatbot:read', 'admin:full',
    'subscriptions:read', 'subscriptions:write', 'subscriptions:renew',
    'subscriptions:cancel', 'subscriptions:plans',
    'notifications:read', 'notifications:send', 'notifications:manage'
  ];
begin
  if auth.uid() is null then
    return '{}'::text[];
  end if;

  -- طاقم المنصة: السقف الكامل.
  if public.is_platform_staff() then
    return v_all;
  end if;

  -- مدير الشركة: كل شيء عدا صلاحيات مشغّل المنصة.
  if public.is_company_admin() then
    return array(select unnest(v_all) except select unnest(v_platform_only));
  end if;

  -- أي أحد آخر: لا سقف، أي لا إصدار.
  return '{}'::text[];
end;
$$;

comment on function public.api_token_scope_ceiling() is
  'أقصى صلاحيات يجوز أن يحملها مفتاح يصدره المنادي. صلاحيات مشغّل المنصة '
  '(admin:full · settings:manage · oauth:manage) خارج سقف الشركة — حاجز خادم '
  'لا تنظيم واجهة.';

revoke all on function public.api_token_scope_ceiling() from public, anon;
grant execute on function public.api_token_scope_ceiling() to authenticated;


-- ── هل يحق للمنادي إصدار مفتاح؟ ───────────────────────────────────────────
--
-- الجواب واحد ذرّي يجمع الرتبة والعلاقة والاستحقاق. المنطق كله هنا، فلا
-- تُعاد صياغته في Edge Function ولا في المتصفح.
create or replace function public.can_create_api_token()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select auth.uid() is not null
     and (
       -- طاقم المنصة: مفاتيح تشغيلية، بلا اشتراط استحقاق شركة.
       public.is_platform_staff()
       -- مدير الشركة: الدور والعلاقة (is_company_admin) مع استحقاق فعّال.
       -- company_user مستثنى صراحةً: العضوية ليست ترقية.
       or (public.is_company_admin() and public.company_has_feature('api_tokens'))
     );
$$;

comment on function public.can_create_api_token() is
  'بوابة إصدار مفاتيح API: طاقم منصة، أو مدير شركة باستحقاق api_tokens فعّال. '
  'company_user لا يصدر مفاتيح.';

revoke all on function public.can_create_api_token() from public, anon;
grant execute on function public.can_create_api_token() to authenticated;


-- ── تحقّق شامل يجمع القرار وسببه ──────────────────────────────────────────
--
-- تُنادى مرة واحدة من Edge Function فتغنيها عن ثلاثة نداءات وعن إعادة بناء
-- أي شرط. الرسالة موحّدة عمدًا لكل أسباب الرفض: التمييز بين «لست مديرًا»
-- و«لا استحقاق» يكشف حالة حساب الشركة لمن لا يملكه.
create or replace function public.api_token_issue_context()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null then
    return jsonb_build_object('allowed', false, 'scope_ceiling', '[]'::jsonb,
                              'company_id', null, 'actor', 'anonymous');
  end if;

  return jsonb_build_object(
    'allowed',       public.can_create_api_token(),
    'scope_ceiling', to_jsonb(public.api_token_scope_ceiling()),
    'company_id',    public.company_of(auth.uid()),
    'actor',         case
                       when public.is_platform_staff() then 'platform_staff'
                       when public.is_company_admin()  then 'company_admin'
                       when public.is_company_member() then 'company_user'
                       else 'customer'
                     end
  );
end;
$$;

revoke all on function public.api_token_issue_context() from public, anon;
grant execute on function public.api_token_issue_context() to authenticated;


-- ── تحقّق ذاتي ────────────────────────────────────────────────────────────
do $$
begin
  if to_regprocedure('public.can_create_api_token()') is null
     or to_regprocedure('public.api_token_scope_ceiling()') is null
     or to_regprocedure('public.api_token_issue_context()') is null then
    raise exception 'دوال بوابة مفاتيح API لم تُنشأ';
  end if;

  -- الفصل الصارم: سقف الشركة لا يشمل صلاحيات مشغّل المنصة
  if pg_get_functiondef('public.api_token_scope_ceiling()'::regprocedure)
       !~ 'v_platform_only' then
    raise exception 'سقف الشركة لا يستثني صلاحيات مشغّل المنصة';
  end if;

  -- company_user ليس في بوابة الإصدار
  if pg_get_functiondef('public.can_create_api_token()'::regprocedure)
       ~ 'is_company_member' then
    raise exception 'company_user دخل بوابة إصدار المفاتيح';
  end if;

  raise notice 'OK 036: بوابة إصدار مفاتيح API في القاعدة، وسقف الشركة أضيق من سقف المنصة';
end $$;
