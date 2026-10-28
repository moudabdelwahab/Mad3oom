-- ============================================================================
-- 118_ecommerce_store_accounts.sql
--   نوع حساب ثالث: «متجر إلكتروني» — امتداد لنموذج الشركة القائم، لا كيان جديد.
--   التصميم والتدقيق: docs/ecommerce/AUDIT_2026-10-28.md
--
-- النموذج
--   • فرد            = حساب بلا شركة (كما هو اليوم).
--   • شركة           = companies.account_kind = 'company' (الافتراضي — كل صف قائم).
--   • متجر إلكتروني  = companies.account_kind = 'ecommerce_store' — نفس المالك ونفس
--     الفريق (086) ونفس العضويات (096) ونفس العزل (097). لا نموذج ملكية ثانٍ.
--   نوع الحساب منفصل عن حالة الاشتراك: الحالة تبقى في whatsapp_subscriptions.status.
--
-- كيف يصير الحساب متجرًا
--   نفس طلب حساب الشركة (068) بـ account_kind = 'ecommerce_store' عبر
--   submit_store_account_request. موافقة الإدارة القائمة (admin_review_company_account_request،
--   لم تُلمس) تنشئ الشركة، ومحفّز على الطلب المعتمد ينسخ نوعه إلى الشركة التي أنشأها.
--   تغيير النوع بعد ذلك: owner_set_company_account_kind (مالك المنصة + تحقق حديث + تدقيق).
--
-- الباقة
--   subscription_plans.audience ('company' | 'ecommerce_store'). باقة 'store' تُزرع **غير
--   مفعّلة وبلا سعر**: لا سعر مخترع. قيد يمنع تفعيل باقة متاجر بلا سعرين موجبين، ومحفّز
--   يمنع طلب باقة المتاجر لغير مالك متجر (حتى بنداء API مباشر).
--   مزايا الباقة المزروعة اقتراح (support_tickets, sub_users, integrations_hub,
--   shopify_integration, store_support) — قرار المالك قبل التفعيل.
--
-- ما لا يفعله
--   • لا يغيّر أي باقة قائمة ولا سعرها ولا مزاياها، ولا company_has_feature.
--   • لا يغيّر مسار شراء الفرد والشركة: المحفّز الجديد لا يرى إلا باقات audience = متاجر.
--   • لا يحوّل أي شركة قائمة.
--
-- يعتمد على 068 و 086 و 088 و 092 و 053 (كلها مطبقة على الإنتاج). قابل لإعادة التشغيل.
-- التراجع: migrations/_rollback/118_ecommerce_store_accounts.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.current_company_id()', 'public.company_staff_role()', 'public.is_admin()',
    'public.owns_a_company(uuid)', 'public.submit_company_account_request(text,text,date,text,text,text,text)',
    'public.owner_capability(text)', 'public.owner_critical_ok()',
    'public.log_privileged(text,uuid,jsonb,jsonb)', 'public.guard_preview_read_only()'] loop
    if to_regprocedure(f) is null then
      raise exception '118 يتطلب %', f;
    end if;
  end loop;
  if to_regclass('public.company_account_requests') is null or to_regclass('public.company_feature_overrides') is null
     or to_regclass('public.ihub_connections') is null then
    raise exception '118 يتطلب 068 و 088 و 092';
  end if;
end $$;


-- ============================================================================
-- 1) نوع المنظمة
-- ============================================================================
alter table public.companies
  add column if not exists account_kind text not null default 'company';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'companies_account_kind_check') then
    alter table public.companies add constraint companies_account_kind_check
      check (account_kind in ('company', 'ecommerce_store'));
  end if;
end $$;
comment on column public.companies.account_kind is
  '118: نوع المنظمة. company (الافتراضي) أو ecommerce_store. لا يكتبه مالك الشركة: يُنسخ من طلب '
  'الحساب المعتمد، أو يغيّره مالك المنصة بـ owner_set_company_account_kind.';
create index if not exists companies_account_kind on public.companies (account_kind)
  where account_kind <> 'company';

-- سياسة «Users can update their own company» تسمح للمالك بتحديث صفه. النوع ليس بياناته:
-- يُكتب فقط من مسار موثوق يرفع العلم app.account_kind_write داخل المعاملة نفسها.
create or replace function public._guard_company_account_kind()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if coalesce(current_setting('app.account_kind_write', true), '') = 'on' or auth.uid() is null then
    return new;
  end if;
  if tg_op = 'INSERT' and new.account_kind is distinct from 'company' then
    raise exception 'نوع الحساب يُحدَّد بطلب الحساب المعتمد فقط' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.account_kind is distinct from old.account_kind then
    raise exception 'نوع الحساب لا يتغير من هنا' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_company_account_kind on public.companies;
create trigger trg_guard_company_account_kind
  before insert or update of account_kind on public.companies
  for each row execute function public._guard_company_account_kind();


-- ============================================================================
-- 2) طلب حساب المتجر = طلب حساب شركة بنوع مختلف
-- ============================================================================
alter table public.company_account_requests
  add column if not exists account_kind      text not null default 'company',
  add column if not exists store_platform    text,
  add column if not exists store_domain_hint text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'company_account_requests_kind_check') then
    alter table public.company_account_requests add constraint company_account_requests_kind_check
      check (account_kind in ('company', 'ecommerce_store'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'company_account_requests_store_check') then
    alter table public.company_account_requests add constraint company_account_requests_store_check
      check ((account_kind = 'ecommerce_store') = (store_platform is not null)
             and (store_platform is null or store_platform in ('shopify'))
             and (store_domain_hint is null or store_domain_hint ~ '^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$'));
  end if;
end $$;
comment on column public.company_account_requests.store_domain_hint is
  '118: نطاق myshopify الذي ذكره التاجر — للعرض والمراجعة فقط. لا يربط أي متجر: الربط بتفويض Shopify '
  'الموقَّع وحده (119).';

-- الطلب المعتمد ينقل نوعه للشركة التي أنشأها. admin_review_company_account_request لم تُلمس:
-- هي تنشئ الشركة بالنوع الافتراضي ثم تحدّث الطلب إلى approved مع company_id — وهنا نلتقط ذلك.
create or replace function public._account_request_apply_kind()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.status = 'approved' and old.status is distinct from 'approved'
     and new.account_kind = 'ecommerce_store' and new.company_id is not null then
    perform set_config('app.account_kind_write', 'on', true);
    update public.companies set account_kind = new.account_kind where id = new.company_id;
    perform set_config('app.account_kind_write', 'off', true);
  end if;
  return new;
end $$;

drop trigger if exists trg_account_request_apply_kind on public.company_account_requests;
create trigger trg_account_request_apply_kind
  after update of status on public.company_account_requests
  for each row execute function public._account_request_apply_kind();

-- نفس دالة طلب الشركة بكل تحققاتها (بوابة الحساب، التكرار، السجل التجاري، الإخطار)،
-- ثم وسم الطلب متجرًا. فشل أي تحقق يُسقط الاثنين معًا.
create or replace function public.submit_store_account_request(
  p_store_name text, p_commercial_registration_number text, p_commercial_registration_expiry date,
  p_company_email text default null, p_company_phone text default null,
  p_requested_plan text default null, p_requested_billing_cycle text default null,
  p_store_domain text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_res    jsonb;
  v_domain text := lower(btrim(coalesce(p_store_domain, '')));
begin
  if v_domain = '' then
    v_domain := null;
  elsif v_domain !~ '\.myshopify\.com$' then
    v_domain := v_domain || '.myshopify.com';
  end if;
  if v_domain is not null and v_domain !~ '^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$' then
    raise exception 'نطاق المتجر غير صالح — اكتب اسم متجرك في Shopify مثل my-store.myshopify.com'
      using errcode = '22023';
  end if;
  if p_requested_plan is not null and not exists (
       select 1 from public.subscription_plans where key = p_requested_plan and audience = 'ecommerce_store') then
    raise exception 'هذه الباقة ليست باقة متاجر' using errcode = '22023';
  end if;

  v_res := public.submit_company_account_request(
    p_store_name, p_commercial_registration_number, p_commercial_registration_expiry,
    p_company_email, p_company_phone, p_requested_plan, p_requested_billing_cycle);

  update public.company_account_requests
     set account_kind = 'ecommerce_store', store_platform = 'shopify', store_domain_hint = v_domain
   where id = (v_res->>'id')::uuid and user_id = auth.uid();

  return v_res || jsonb_build_object('account_kind', 'ecommerce_store');
end $$;

-- نفس تعريف الإنتاج حرفيًا + account_kind (للنافذة: «طلب متجرك قيد المراجعة»).
create or replace function public.my_company_account_request()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  select jsonb_build_object(
           'id',             r.id,
           'status',         r.status,
           'company_name',   r.company_name,
           'requested_plan', r.requested_plan,
           'review_note',    r.review_note,
           'created_at',     r.created_at,
           'reviewed_at',    r.reviewed_at,
           'account_kind',   r.account_kind
         )
    from public.company_account_requests r
   where auth.uid() is not null
     and r.user_id = auth.uid()
   order by (r.status = 'pending') desc, r.created_at desc
   limit 1;
$function$;

-- نفس تعريف الإنتاج حرفيًا + النوع والمنصة والنطاق المذكور، لتراها الإدارة قبل القرار.
create or replace function public.admin_list_company_account_requests()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare v_rows jsonb;
begin
  if not public.is_admin() then
    raise exception 'هذه العملية متاحة للإدارة فقط' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(q.item order by q.r_created desc), '[]'::jsonb)
    into v_rows
    from (
      select r.created_at as r_created,
             jsonb_build_object(
               'id',                             r.id,
               'user_id',                        r.user_id,
               'customer_name',                  coalesce(nullif(btrim(p.full_name), ''), p.email),
               'customer_email',                 p.email,
               'customer_phone',                 p.phone,
               'company_name',                   r.company_name,
               'commercial_registration_number', r.commercial_registration_number,
               'commercial_registration_expiry', r.commercial_registration_expiry,
               'company_email',                  r.company_email,
               'company_phone',                  r.company_phone,
               'requested_plan',                 r.requested_plan,
               'requested_plan_name_ar',         coalesce(sp.name_ar, sp.name, r.requested_plan),
               'requested_billing_cycle',        r.requested_billing_cycle,
               'status',                         r.status,
               'review_note',                    r.review_note,
               'reviewed_at',                    r.reviewed_at,
               'reviewer_name',                  coalesce(nullif(btrim(rv.full_name), ''), rv.email),
               'company_id',                     r.company_id,
               'created_at',                     r.created_at,
               'account_kind',                   r.account_kind,
               'store_platform',                 r.store_platform,
               'store_domain_hint',              r.store_domain_hint
             ) as item
        from public.company_account_requests r
        left join public.profiles p  on p.id  = r.user_id
        left join public.profiles rv on rv.id = r.reviewed_by
        left join public.subscription_plans sp on sp.key = r.requested_plan
    ) q;

  return v_rows;
end;
$function$;


-- ============================================================================
-- 3) جمهور الباقة، وباقة المتاجر بلا سعر
-- ============================================================================
alter table public.subscription_plans
  add column if not exists audience text not null default 'company';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'subscription_plans_audience_check') then
    alter table public.subscription_plans add constraint subscription_plans_audience_check
      check (audience in ('company', 'ecommerce_store'));
  end if;
  -- باقة متاجر مفعّلة = لها سعران موجبان. لا تُباع باقة بلا سعر حدده المالك.
  if not exists (select 1 from pg_constraint where conname = 'subscription_plans_store_priced') then
    alter table public.subscription_plans add constraint subscription_plans_store_priced
      check (audience <> 'ecommerce_store' or not is_active
             or (coalesce(price_monthly, 0) > 0 and coalesce(price_yearly, 0) > 0));
  end if;
end $$;
comment on column public.subscription_plans.audience is
  '118: لمن تُباع الباقة. company: أي منظمة (السلوك القائم). ecommerce_store: مالك متجر فقط '
  '(محفّز enforce_plan_audience).';

insert into public.feature_flags (key, name, name_ar, description) values
  ('shopify_integration', 'Shopify integration', 'تكامل Shopify',
   'ربط متجر Shopify بحساب المتجر وعرض الطلبات والعملاء والمنتجات داخل الدعم (قراءة فقط)'),
  ('store_support', 'Store support workflows', 'أدوات دعم المتاجر',
   'تصنيفات دعم المتجر، وتسجيل طلبات الإرجاع والاستبدال والإلغاء واستفسارات الاسترداد ومتابعتها، وتقارير المتجر')
on conflict (key) do nothing;

-- غير مفعّلة وبلا سعر — لا تظهر للشراء حتى يحدد المالك السعر ويفعّلها.
insert into public.subscription_plans (key, name, name_ar, is_active, sort_order, requires_company,
                                       price_monthly, price_yearly, currency, audience)
values ('store', 'E-commerce Store', 'باقة المتاجر الإلكترونية', false, 40, true, null, null, 'EGP', 'ecommerce_store')
on conflict (key) do nothing;

insert into public.plan_features (plan_id, feature_key, enabled)
select sp.id, f, true
  from public.subscription_plans sp,
       unnest(array['support_tickets', 'sub_users', 'integrations_hub', 'shopify_integration', 'store_support']) f
 where sp.key = 'store'
   and exists (select 1 from public.feature_flags ff where ff.key = f)
on conflict do nothing;

-- قيد مفاتيح الباقات في الاشتراكات يُوسَّع بالمفتاح الجديد فقط.
do $$
declare v_def text;
begin
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid = 'public.whatsapp_subscriptions'::regclass and conname = 'whatsapp_subscriptions_plan_check';
  if v_def is not null and position('''store''' in v_def) = 0 then
    alter table public.whatsapp_subscriptions drop constraint whatsapp_subscriptions_plan_check;
    alter table public.whatsapp_subscriptions add constraint whatsapp_subscriptions_plan_check
      check (plan = any (array['support'::text, 'ultimate'::text, 'whatsapp'::text, 'bundle'::text, 'store'::text]));
  end if;
end $$;

-- استثناءات الامتياز (092): تُوسَّع لمزايا المتجر حتى يختبرها المالك على متجره التجريبي فقط.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'company_feature_overrides_pilot_only') then
    alter table public.company_feature_overrides drop constraint company_feature_overrides_pilot_only;
  end if;
  alter table public.company_feature_overrides add constraint company_feature_overrides_pilot_only
    check (feature_key in ('integrations_hub', 'shopify_integration', 'store_support'));
end $$;

-- باقة المتاجر لمالك متجر فقط. المستخدم العادي وحده يُفحص (نفس استثناء enforce_subscription_purchase_rules:
-- مفتاح الخدمة والإدارة يمرّان). باقات audience = company لا تُفحص هنا إطلاقًا.
create or replace function public.enforce_plan_audience()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;
  if exists (select 1 from public.subscription_plans sp where sp.key = new.plan and sp.audience = 'ecommerce_store')
     and not exists (select 1 from public.companies c
                      where c.user_id = new.user_id and c.account_kind = 'ecommerce_store') then
    raise exception 'باقة المتاجر متاحة لحسابات المتاجر الإلكترونية فقط. اطلب حساب متجر أولًا.'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists trg_enforce_plan_audience on public.whatsapp_subscriptions;
create trigger trg_enforce_plan_audience
  before insert or update of plan on public.whatsapp_subscriptions
  for each row execute function public.enforce_plan_audience();


-- ============================================================================
-- 4) نوع حساب المنادي (للواجهة — لا مصدر صلاحية)
-- ============================================================================
create or replace function public.my_account_type()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_kind    text;
  v_name    text;
  v_role    text;
begin
  if auth.uid() is null then
    return null;
  end if;
  v_company := public.current_company_id();
  v_role := public.company_staff_role();
  if v_company is not null then
    select c.account_kind, c.company_name into v_kind, v_name from public.companies c where c.id = v_company;
  end if;
  return jsonb_build_object(
    'account_type', case when v_company is null then 'individual'
                         when v_role is null then 'individual'   -- عميل يتبع منظمة: حسابه فردي
                         else v_kind end,
    'organization_kind', v_kind,
    'organization_id', case when v_role is null then null else v_company end,
    'organization_name', case when v_role is null then null else v_name end,
    'relation', case when v_company is null then 'none'
                     when v_role = 'admin' then 'owner'
                     when v_role is not null then 'staff'
                     else 'customer' end);
end $$;


-- ============================================================================
-- 5) مالك المنصة: تغيير نوع منظمة (تحويل شركة قائمة لمتجر، أو متجر المالك التجريبي)
-- ============================================================================
create or replace function public.owner_set_company_account_kind(p_company uuid, p_kind text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_old    text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not public.owner_critical_ok() then
    raise exception 'تغيير نوع الحساب لمالك المنصة في سياقه وبتحقق حديث' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('company', 'ecommerce_store') then
    raise exception 'نوع غير صالح' using errcode = '22023';
  end if;
  if v_reason is null or char_length(v_reason) < 10 then
    raise exception 'السبب مطلوب (10 أحرف على الأقل)' using errcode = '22023';
  end if;
  select account_kind into v_old from public.companies where id = p_company for update;
  if not found then
    raise exception 'المنظمة غير موجودة' using errcode = 'P0002';
  end if;
  if v_old = p_kind then
    return jsonb_build_object('changed', false, 'account_kind', v_old);
  end if;
  -- متجر له ربط Shopify حي لا يُحوَّل شركة: يُفصل أولًا (لا ربط يتيم بلا امتياز)
  if v_old = 'ecommerce_store' and to_regclass('public.ihub_connections') is not null and exists (
       select 1 from public.ihub_connections where company_id = p_company and provider = 'shopify'
          and status <> 'disconnected') then
    raise exception 'افصل ربط Shopify أولًا' using errcode = '22023';
  end if;
  perform set_config('app.account_kind_write', 'on', true);
  update public.companies set account_kind = p_kind where id = p_company;
  perform set_config('app.account_kind_write', 'off', true);
  perform public.log_privileged('company.account_kind', null,
    jsonb_build_object('company_id', p_company, 'account_kind', v_old),
    jsonb_build_object('company_id', p_company, 'account_kind', p_kind, 'reason', left(v_reason, 300)));
  return jsonb_build_object('changed', true, 'account_kind', p_kind);
end $$;


-- ============================================================================
-- 6) الصلاحيات
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public._guard_company_account_kind()', 'public._account_request_apply_kind()', 'public.enforce_plan_audience()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'public.submit_store_account_request(text,text,date,text,text,text,text,text)',
    'public.my_company_account_request()', 'public.admin_list_company_account_requests()',
    'public.my_account_type()', 'public.owner_set_company_account_kind(uuid,text,text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;


-- ============================================================================
-- 7) تحقق
-- ============================================================================
do $$
begin
  if exists (select 1 from public.companies where account_kind <> 'company')
     and not exists (select 1 from public.company_account_requests where account_kind = 'ecommerce_store') then
    raise notice '118: توجد منظمات متاجر بلا طلب (تحويل من المالك)';
  end if;
  if exists (select 1 from public.subscription_plans where audience = 'ecommerce_store' and is_active
              and (coalesce(price_monthly, 0) <= 0 or coalesce(price_yearly, 0) <= 0)) then
    raise exception '118: باقة متاجر مفعّلة بلا سعر';
  end if;
  if exists (select 1 from public.subscription_plans where key in ('support', 'ultimate', 'whatsapp', 'bundle')
              and audience <> 'company') then
    raise exception '118: تغيّر جمهور باقة قائمة';
  end if;
  if has_function_privilege('anon', 'public.my_account_type()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.enforce_plan_audience()', 'EXECUTE') then
    raise exception '118: صلاحيات غير متوقعة';
  end if;
  raise notice '118: حسابات المتاجر جاهزة — باقة store غير مفعّلة وبلا سعر حتى يقرر المالك';
end $$;
