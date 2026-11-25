-- ============================================================================
-- 139_shopify_inventory_alerts — تنبيهات مخزون Shopify + غياب موثّق لعمليتين
--
-- ما يضيفه (فوق 120، إضافي فقط):
--   • حد أدنى للمخزون قابل للضبط لكل متجر (صف واحد لكل ربط) ولكل متغير
--     (صف لكل inventory_item_id)، عبر دوال القاعدة فقط.
--   • تقييم التنبيه في الواجهة من بيانات المخزون الحية عبر ihub-api
--     (inventory.levels)؛ والتسجيل والإشعار عبر
--     ihub_shopify_inventory_alerts_report: تنبيه مفتوح واحد لكل حد، وإشعار
--     واحد لمالك الشركة عند أول عبور للحد، وحلّ التنبيه عند عودة الكمية
--     فوق الحد. بلا خلفية ولا مهمة مجدولة — الفحص يتم حين يفتح المستخدم
--     قسم «تنبيهات المخزون» ويضغط «فحص الآن» (لحدود المتغيرات)، وحين يعرض
--     مخزون متغير يسري عليه حد المتجر (لحد المتجر وحده، إذ لا مسح كامل
--     للمنتجات؛ تنبيه واحد لكل ربط باسم أول متغير يُرى تحت الحد).
--   • لا عمليات Shopify جديدة: لا نداء checkout مهمل ولا مناطق/أسعار شحن
--     في كتالوج 120 ولا في shopify-admin.js، فلا تُخترع هنا. القسمان في
--     الواجهة يعرضان الغياب صراحة (انظر store-manage-model.js:
--     ABANDONED_CHECKOUTS_UNAVAILABLE و SHIPPING_UNAVAILABLE).
--
-- ما لا يفعله: لا يمس دوال 119 ولا 120 ولا الكتالوج، لا يفعّل المزوّد،
-- لا يمنح الامتياز لأي باقة، لا عمليات مالية، لا SIE.
-- التراجع: migrations/_rollback/139_shopify_inventory_alerts.down.sql
-- ============================================================================

-- ============================================================================
-- 1) الجداول (عبر الدوال فقط)
-- ============================================================================
create table if not exists public.ihub_shopify_inventory_thresholds (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null,
  connection_id     uuid not null,
  scope             text not null check (scope in ('store', 'variant')),
  inventory_item_id text check (inventory_item_id is null
                                or inventory_item_id ~ '^gid://shopify/InventoryItem/[0-9]{1,20}$'),
  variant_id        text check (variant_id is null
                                or variant_id ~ '^gid://shopify/ProductVariant/[0-9]{1,20}$'),
  product_title     text check (product_title is null or char_length(product_title) <= 120),
  min_quantity      int not null check (min_quantity between 0 and 999999),
  created_by        uuid,
  updated_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check ((scope = 'store' and inventory_item_id is null and variant_id is null)
      or (scope = 'variant' and inventory_item_id is not null and variant_id is not null))
);
comment on table public.ihub_shopify_inventory_thresholds is
  '139: الحد الأدنى للمخزون لكل متجر (scope=store، صف واحد لكل ربط) ولكل متغير في Shopify '
  '(scope=variant). التقييم في الواجهة من inventory.levels؛ هنا التخزين فقط.';
create unique index if not exists ihub_shopify_thresholds_store_one
  on public.ihub_shopify_inventory_thresholds (company_id, connection_id) where scope = 'store';
create unique index if not exists ihub_shopify_thresholds_variant_one
  on public.ihub_shopify_inventory_thresholds (company_id, connection_id, inventory_item_id) where scope = 'variant';
create index if not exists ihub_shopify_thresholds_connection
  on public.ihub_shopify_inventory_thresholds (connection_id, updated_at desc);

create table if not exists public.ihub_shopify_inventory_alerts (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null,
  connection_id     uuid not null,
  threshold_id      uuid not null,
  inventory_item_id text not null check (inventory_item_id ~ '^gid://shopify/InventoryItem/[0-9]{1,20}$'),
  product_title     text check (product_title is null or char_length(product_title) <= 120),
  available         int not null check (available >= 0),
  min_quantity      int not null check (min_quantity >= 0),
  status            text not null default 'open' check (status in ('open', 'resolved')),
  notified_at       timestamptz,
  created_at        timestamptz not null default now(),
  resolved_at       timestamptz,
  check ((status = 'open' and resolved_at is null) or (status = 'resolved' and resolved_at is not null))
);
comment on table public.ihub_shopify_inventory_alerts is
  '139: سجل تنبيهات المخزون. تنبيه مفتوح واحد لكل حد (يمنع تكرار الإشعار)؛ يُحلّ عند عودة '
  'الكمية فوق الحد. بلا مفاتيح خارجية عمدًا — السجل يبقى بعد حذف الحد أو فصل الربط.';
create unique index if not exists ihub_shopify_alerts_one_open
  on public.ihub_shopify_inventory_alerts (threshold_id) where status = 'open';
create index if not exists ihub_shopify_alerts_connection
  on public.ihub_shopify_inventory_alerts (connection_id, created_at desc);

alter table public.ihub_shopify_inventory_thresholds enable row level security;
alter table public.ihub_shopify_inventory_alerts enable row level security;
revoke all on public.ihub_shopify_inventory_thresholds from public, anon, authenticated;
revoke all on public.ihub_shopify_inventory_alerts from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on public.ihub_shopify_inventory_thresholds from service_role;
    revoke all on public.ihub_shopify_inventory_alerts from service_role;
  end if;
end $$;


-- ============================================================================
-- 2) البوابة المشتركة: متجر + خارج المعاينة + الامتيازات + الربط للشركة
--    وفي الدور + صلاحية store.inventory. لا تفحص نطاقات Shopify: الحدود
--    والإشعارات محلية في مدعوم، والقراءة الحية للمخزون تمر ببوابة 120.
-- ============================================================================
create or replace function public._ihub_shopify_threshold_gate(p_connection uuid,
  out company_id uuid, out role text, out connection_id uuid)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  r public.ihub_connections;
begin
  select * into company_id, role from public._store_ctx(false);
  if coalesce(public.preview_mode(), true) then
    raise exception 'تنبيهات المخزون غير متاحة داخل المعاينة' using errcode = '42501', detail = '{"code":"preview_read_only"}';
  end if;
  if not (coalesce(public.company_has_feature('integrations_hub'), false)
          and coalesce(public.company_has_feature('shopify_integration'), false)) then
    raise exception 'اشتراك المتجر لا يشمل تكامل Shopify' using errcode = '42501', detail = '{"code":"not_entitled"}';
  end if;
  if not coalesce(public.company_has_feature('shopify_management'), false) then
    raise exception 'إدارة المتجر من مدعوم غير مفعّلة لهذا الحساب' using errcode = '42501',
      detail = '{"code":"management_not_enabled"}';
  end if;
  select * into r from public.ihub_connections c
   where c.id = p_connection and c.company_id = _ihub_shopify_threshold_gate.company_id and c.provider = 'shopify'
     and c.status in ('active', 'error')
     and public._ihub_role_rank(c.min_view_role) <= public._ihub_role_rank(_ihub_shopify_threshold_gate.role)
     and exists (select 1 from public.ihub_providers p where p.key = 'shopify' and p.enabled);
  if not found then
    raise exception 'الربط غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  if not public._store_perm(_ihub_shopify_threshold_gate.company_id, 'store.inventory') then
    raise exception 'لا تملك صلاحية المخزون' using errcode = '42501', detail = '{"code":"forbidden"}';
  end if;
  connection_id := r.id;
end $$;


-- ============================================================================
-- 3) دوال الواجهة (authenticated)
-- ============================================================================

-- حدود الربط: حد المتجر أولًا ثم حدود المتغيرات حسب العنوان.
create or replace function public.ihub_shopify_thresholds_list(p_connection uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare g record;
begin
  select * into g from public._ihub_shopify_threshold_gate(p_connection);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', t.id, 'scope', t.scope, 'inventory_item_id', t.inventory_item_id, 'variant_id', t.variant_id,
      'product_title', t.product_title, 'min_quantity', t.min_quantity, 'updated_at', t.updated_at)
      order by (t.scope = 'store') desc, coalesce(t.product_title, ''), t.created_at)
      from public.ihub_shopify_inventory_thresholds t
     where t.company_id = g.company_id and t.connection_id = g.connection_id), '[]'::jsonb);
end $$;

-- إنشاء حد أو تحديثه (صف واحد لكل نطاق/متغير). الحد 0 يعني «نبّه عند النفاد».
create or replace function public.ihub_shopify_threshold_set(p_connection uuid, p_scope text,
  p_inventory_item_id text default null, p_variant_id text default null,
  p_product_title text default null, p_min_quantity int default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  g record;
  v_title text := nullif(btrim(coalesce(p_product_title, '')), '');
  v_row public.ihub_shopify_inventory_thresholds;
begin
  select * into g from public._ihub_shopify_threshold_gate(p_connection);
  if p_scope not in ('store', 'variant') then
    raise exception 'النطاق غير صالح' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  if p_min_quantity is null or p_min_quantity < 0 or p_min_quantity > 999999 then
    raise exception 'الحد الأدنى عدد صحيح بين 0 و 999999' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  if p_scope = 'store' and (p_inventory_item_id is not null or p_variant_id is not null) then
    raise exception 'حد المتجر بلا متغير' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  if p_scope = 'variant' and (p_inventory_item_id is null
      or p_inventory_item_id !~ '^gid://shopify/InventoryItem/[0-9]{1,20}$'
      or p_variant_id is null or p_variant_id !~ '^gid://shopify/ProductVariant/[0-9]{1,20}$') then
    raise exception 'معرّف المتغير غير صالح' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  if v_title is not null and char_length(v_title) > 120 then
    raise exception 'العنوان طويل' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  if p_scope = 'store' then
    insert into public.ihub_shopify_inventory_thresholds (company_id, connection_id, scope, min_quantity, created_by, updated_by)
    values (g.company_id, g.connection_id, 'store', p_min_quantity, auth.uid(), auth.uid())
    on conflict (company_id, connection_id) where scope = 'store'
    do update set min_quantity = excluded.min_quantity, updated_by = auth.uid(), updated_at = now()
    returning * into v_row;
  else
    insert into public.ihub_shopify_inventory_thresholds
      (company_id, connection_id, scope, inventory_item_id, variant_id, product_title, min_quantity, created_by, updated_by)
    values (g.company_id, g.connection_id, 'variant', p_inventory_item_id, p_variant_id, v_title, p_min_quantity, auth.uid(), auth.uid())
    on conflict (company_id, connection_id, inventory_item_id) where scope = 'variant'
    do update set variant_id = excluded.variant_id, product_title = excluded.product_title,
                  min_quantity = excluded.min_quantity, updated_by = auth.uid(), updated_at = now()
    returning * into v_row;
  end if;
  perform public._ihub_audit(g.company_id, g.connection_id, 'user', 'shopify.threshold.set',
                             jsonb_build_object('scope', p_scope, 'threshold_id', v_row.id, 'min_quantity', p_min_quantity));
  return jsonb_build_object('id', v_row.id, 'scope', v_row.scope, 'inventory_item_id', v_row.inventory_item_id,
                            'variant_id', v_row.variant_id, 'product_title', v_row.product_title,
                            'min_quantity', v_row.min_quantity, 'updated_at', v_row.updated_at);
end $$;

-- حذف حد؛ تنبيهاته المفتوحة تُحلّ (لا تُمحى).
create or replace function public.ihub_shopify_threshold_delete(p_connection uuid, p_threshold_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  g record;
  v_found boolean;
begin
  select * into g from public._ihub_shopify_threshold_gate(p_connection);
  if p_threshold_id is null then
    raise exception 'الحد غير صالح' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  update public.ihub_shopify_inventory_alerts
     set status = 'resolved', resolved_at = now()
   where threshold_id = p_threshold_id and company_id = g.company_id and connection_id = g.connection_id and status = 'open';
  delete from public.ihub_shopify_inventory_thresholds t
   where t.id = p_threshold_id and t.company_id = g.company_id and t.connection_id = g.connection_id
  returning true into v_found;
  if not coalesce(v_found, false) then
    raise exception 'الحد غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  perform public._ihub_audit(g.company_id, g.connection_id, 'user', 'shopify.threshold.deleted',
                             jsonb_build_object('threshold_id', p_threshold_id));
  return jsonb_build_object('deleted', true, 'threshold_id', p_threshold_id);
end $$;

-- التنبيهات المفتوحة للربط (للعرض في اللوحة).
create or replace function public.ihub_shopify_inventory_alerts_list(p_connection uuid, p_limit int default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare g record;
begin
  select * into g from public._ihub_shopify_threshold_gate(p_connection);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'threshold_id', a.threshold_id, 'inventory_item_id', a.inventory_item_id,
      'product_title', a.product_title, 'available', a.available, 'min_quantity', a.min_quantity,
      'notified_at', a.notified_at, 'created_at', a.created_at)
      order by a.created_at desc)
      from public.ihub_shopify_inventory_alerts a
     where a.company_id = g.company_id and a.connection_id = g.connection_id and a.status = 'open'
     order by a.created_at desc
     limit least(greatest(coalesce(p_limit, 50), 1), 200)), '[]'::jsonb);
end $$;

-- تسجيل نتيجة فحص أجرته الواجهة من بيانات Shopify الحية.
-- المدخل: عناصر قيّمتها الواجهة فعلًا [{threshold_id, inventory_item_id, product_title, available, min_quantity}].
--   • متاح < الحد ولا تنبيه مفتوح للحد: تنبيه جديد + إشعار واحد لمالك الشركة (لا تكرار ما دام مفتوحًا).
--   • متاح >= الحد وتنبيه مفتوح: يُحلّ.
--   • عنصر بلا حد مطابق في الشركة والربط يُتجاهل (لا يُنشئ حدًا ولا إشعارًا).
--   • الإشعار لمالك الشركة وحده (companies.user_id — المدير بالملكية)؛
--     الفاحص نفسه يرى النتيجة في اللوحة مباشرة.
create or replace function public.ihub_shopify_inventory_alerts_report(p_connection uuid, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  g record;
  v_owner uuid;
  v_item jsonb;
  v_threshold public.ihub_shopify_inventory_thresholds;
  v_open uuid;
  v_did boolean;
  v_notified int := 0;
  v_resolved int := 0;
  v_skipped int := 0;
begin
  select * into g from public._ihub_shopify_threshold_gate(p_connection);
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 100 then
    raise exception 'قائمة الفحص غير صالحة' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  select c.user_id into v_owner from public.companies c where c.id = g.company_id;
  for v_item in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object'
       or (v_item->>'threshold_id') is null or (v_item->>'threshold_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or (v_item->>'inventory_item_id') is null or (v_item->>'inventory_item_id') !~ '^gid://shopify/InventoryItem/[0-9]{1,20}$'
       or (v_item->>'available') is null or (v_item->>'available') !~ '^[0-9]{1,7}$'
       or (v_item->>'min_quantity') is null or (v_item->>'min_quantity') !~ '^[0-9]{1,7}$' then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    select * into v_threshold from public.ihub_shopify_inventory_thresholds t
     where t.id = (v_item->>'threshold_id')::uuid and t.company_id = g.company_id and t.connection_id = g.connection_id
       and (t.scope = 'store' or t.inventory_item_id = v_item->>'inventory_item_id');
    if not found then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    if (v_item->>'available')::int < (v_item->>'min_quantity')::int then
      select a.id into v_open from public.ihub_shopify_inventory_alerts a
       where a.threshold_id = v_threshold.id and a.status = 'open';
      if v_open is null then
        insert into public.ihub_shopify_inventory_alerts
          (company_id, connection_id, threshold_id, inventory_item_id, product_title, available, min_quantity, notified_at)
        values (g.company_id, g.connection_id, v_threshold.id, v_item->>'inventory_item_id',
                left(nullif(btrim(coalesce(v_item->>'product_title', v_threshold.product_title, '')), ''), 120),
                (v_item->>'available')::int, (v_item->>'min_quantity')::int, now());
        if v_owner is not null then
          insert into public.notifications (user_id, title, message, type, link, category, reference_id)
          values (v_owner,
                  'تنبيه مخزون: ' || left(coalesce(nullif(btrim(coalesce(v_item->>'product_title', v_threshold.product_title, '')), ''), 'منتج'), 100),
                  format('وصل مخزون «%s» إلى %s والحد الأدنى هو %s. راجع قسم «تنبيهات المخزون» في إدارة المتجر.',
                         coalesce(nullif(btrim(coalesce(v_item->>'product_title', v_threshold.product_title, '')), ''), 'منتج'),
                         (v_item->>'available')::int, (v_item->>'min_quantity')::int),
                  'warning', '/company-dashboard/index.html#storeManage', 'store', v_threshold.id);
        end if;
        v_notified := v_notified + 1;
      end if;
    else
      update public.ihub_shopify_inventory_alerts
         set status = 'resolved', resolved_at = now()
       where threshold_id = v_threshold.id and status = 'open'
      returning true into v_did;
      if coalesce(v_did, false) then v_resolved := v_resolved + 1; end if;
    end if;
  end loop;
  if v_notified > 0 or v_resolved > 0 then
    perform public._ihub_audit(g.company_id, g.connection_id, 'user', 'shopify.inventory_alerts.reported',
                               jsonb_build_object('notified', v_notified, 'resolved', v_resolved, 'skipped', v_skipped));
  end if;
  return jsonb_build_object('notified', v_notified, 'resolved', v_resolved, 'skipped', v_skipped,
                            'open', (select count(*) from public.ihub_shopify_inventory_alerts a
                                     where a.company_id = g.company_id and a.connection_id = g.connection_id and a.status = 'open'));
end $$;


-- ============================================================================
-- 4) الصلاحيات
-- ============================================================================
do $$
declare
  f text;
  v_internal text[] := array['public._ihub_shopify_threshold_gate(uuid)'];
  v_user text[] := array[
    'public.ihub_shopify_thresholds_list(uuid)',
    'public.ihub_shopify_threshold_set(uuid,text,text,text,text,integer)',
    'public.ihub_shopify_threshold_delete(uuid,uuid)',
    'public.ihub_shopify_inventory_alerts_list(uuid,integer)',
    'public.ihub_shopify_inventory_alerts_report(uuid,jsonb)'];
begin
  foreach f in array v_internal || v_user loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
  foreach f in array v_user loop
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;


-- ============================================================================
-- 5) تحقق
-- ============================================================================
do $$
declare t text; fn record;
begin
  foreach t in array array['ihub_shopify_inventory_thresholds', 'ihub_shopify_inventory_alerts'] loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then
      raise exception '139: سياسة على %', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'SELECT') or has_table_privilege('anon', 'public.' || t, 'SELECT')
       or has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       or (exists (select 1 from pg_roles where rolname = 'service_role')
           and has_table_privilege('service_role', 'public.' || t, 'SELECT')) then
      raise exception '139: صلاحية مباشرة على %', t;
    end if;
  end loop;
  if exists (select 1 from public._ihub_shopify_op_catalog() c
              where c.key in ('checkout.list', 'abandoned_checkout.list', 'shipping.list', 'shipping.update',
                              'delivery_profile.list', 'delivery_profile.update')) then
    raise exception '139: ظهرت عملية checkout أو شحن في الكتالوج — راجع الواجهة قبل التطبيق';
  end if;
  for fn in select p.oid, p.oid::regprocedure::text sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and (p.proname like 'ihub\_shopify\_threshold%' or p.proname like 'ihub\_shopify\_inventory\_alerts%'
                                             or p.proname = '_ihub_shopify_threshold_gate') loop
    if has_function_privilege('anon', fn.oid, 'EXECUTE') then
      raise exception '139: دالة مكشوفة لـanon: %', fn.sig;
    end if;
    if fn.proname like '\_%' and has_function_privilege('authenticated', fn.oid, 'EXECUTE') then
      raise exception '139: دالة داخلية مكشوفة لـauthenticated: %', fn.sig;
    end if;
  end loop;
  raise notice '139: تنبيهات مخزون Shopify جاهزة — بلا عمليات checkout أو شحن جديدة';
end $$;
