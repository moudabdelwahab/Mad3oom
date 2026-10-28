-- ============================================================================
-- 120_shopify_store_management — إدارة متجر Shopify من مدعوم (فوق 119، إضافي فقط)
--
-- ما يضيفه:
--   • امتياز shopify_management — لا تمنحه أي باقة. استثناء تجريبي لمتجر المالك وحده
--     (owner_store_test_management) حتى يُتحقق على متجر تطوير ويقرر المالك.
--   • صلاحيات فريق المتجر (مطفأة افتراضيًا للمشرف والموظف؛ مدير المتجر يملكها):
--       store.catalog · store.inventory · store.orders_manage · store.customers_manage
--       store.discounts · store.fulfillment · store.returns
--   • _ihub_shopify_op_catalog(): كتالوج العمليات على الخادم — الصلاحية، الخطورة، التأكيد،
--     نطاقات Shopify المطلوبة. الدالة الطرفية لا تقرر شيئًا من هذا (اختبار يطابق الكتالوجين).
--   • تأكيد على الخادم لكل عملية مؤثرة: رمز لمرة واحدة (بصمته فقط) مربوط بالمستخدم والربط
--     والعملية وبصمة المدخلات، 5 دقائق. تغيير المدخلات بعد التأكيد = رفض.
--   • سجل العمليات ihub_shopify_ops: من، ماذا، بصمة المدخلات، الحالة، رمز الخطأ، وتفاصيل بلا
--     بيانات شخصية (معرّفات، فروق المخزون وسببها، الكميات الناتجة). + ihub_audit_events.
--   • حدود: القراءة تشارك حد البحث (60/دقيقة/مستخدم)؛ الكتابة 20/دقيقة/مستخدم و100/دقيقة/شركة؛
--     الحذف والإلغاء 5/دقيقة/مستخدم؛ إصدار التأكيد 30/دقيقة/مستخدم.
--
-- ما لا يفعله: لا يفعّل المزوّد، لا يمس دوال 119 ولا 088، لا يمنح الامتياز لأي باقة، لا عمليات مالية.
-- التراجع: migrations/_rollback/120_shopify_store_management.down.sql
-- ============================================================================

-- ============================================================================
-- 1) الامتياز والاستثناء التجريبي
-- ============================================================================
insert into public.feature_flags (key, name, name_ar, description) values
  ('shopify_management', 'Shopify store management', 'إدارة متجر Shopify',
   'تعديل المنتجات والمخزون والطلبات والعملاء والخصومات والتنفيذ والإرجاع في Shopify من مدعوم (بلا عمليات مالية)')
on conflict (key) do nothing;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'company_feature_overrides_pilot_only') then
    alter table public.company_feature_overrides drop constraint company_feature_overrides_pilot_only;
  end if;
  alter table public.company_feature_overrides add constraint company_feature_overrides_pilot_only
    check (feature_key in ('integrations_hub', 'shopify_integration', 'store_support', 'shopify_management'));
end $$;


-- ============================================================================
-- 2) الصلاحيات (كتالوج 098)
-- ============================================================================
insert into public.company_permission_catalog (key, label_ar, description_ar, default_supervisor, default_agent, sort) values
  ('store.catalog',          'إدارة المنتجات والمجموعات', 'إنشاء المنتجات والمتغيرات والمجموعات في Shopify وتعديلها ونشرها وأرشفتها وحذفها.', false, false, 62),
  ('store.inventory',        'تعديل المخزون',             'عرض المخزون في المواقع وتعديل الكميات (كل تعديل مسجَّل).',                          false, false, 63),
  ('store.orders_manage',    'إدارة الطلبات والمسودات',   'تعديل الطلبات وإنشاؤها وإلغاء غير المدفوع منها، وإدارة مسودات الطلبات.',           false, false, 64),
  ('store.customers_manage', 'إدارة عملاء المتجر',        'إنشاء عملاء المتجر في Shopify وتعديل بياناتهم.',                                    false, false, 65),
  ('store.discounts',        'إدارة الخصومات',            'إنشاء خصومات الأكواد والخصومات التلقائية وتعديلها وإيقافها وحذفها.',                false, false, 66),
  ('store.fulfillment',      'تنفيذ الطلبات والشحن',      'إنشاء التنفيذ وتحديث بيانات التتبع.',                                               false, false, 67),
  ('store.returns',          'إدارة المرتجعات',           'إنشاء المرتجعات وقبولها ورفضها وإغلاقها وإلغاؤها (بلا استرداد مالي).',             false, false, 68)
on conflict (key) do nothing;


-- ============================================================================
-- 3) الجداول (عبر الدوال فقط)
-- ============================================================================
create table if not exists public.ihub_shopify_confirmations (
  token_hash     text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  company_id     uuid not null,
  connection_id  uuid not null,
  user_id        uuid not null,
  op             text not null check (op ~ '^[a-z_]{2,30}\.[a-z_]{2,30}$'),
  input_hash     text not null check (input_hash ~ '^[0-9a-f]{64}$' and input_hash <> token_hash),
  expires_at     timestamptz not null,
  created_at     timestamptz not null default now()
);
comment on table public.ihub_shopify_confirmations is
  '120: تأكيدات معلّقة لعمليات Shopify المؤثرة. بصمة الرمز فقط؛ الرمز نفسه عند المتصفح. لمرة واحدة، 5 دقائق.';
create unique index if not exists ihub_shopify_confirmations_one_pending
  on public.ihub_shopify_confirmations (user_id, connection_id, op);
create index if not exists ihub_shopify_confirmations_expiry on public.ihub_shopify_confirmations (expires_at);

create table if not exists public.ihub_shopify_ops (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null,
  connection_id  uuid not null,
  actor_id       uuid,
  op             text not null check (op ~ '^[a-z_]{2,30}\.[a-z_]{2,30}$'),
  risk           text not null check (risk in ('write', 'destructive')),
  confirmed      boolean not null default false,
  input_hash     text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  status         text not null default 'requested' check (status in ('requested', 'succeeded', 'submitted', 'failed')),
  error_code     text check (error_code is null or error_code ~ '^[a-z_]{1,48}$'),
  resource_ref   text check (resource_ref is null or resource_ref ~ '^[A-Za-z]{2,40}/[0-9]{1,20}$'),
  detail         jsonb not null default '{}'::jsonb
                   check (jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 4000),
  created_at     timestamptz not null default now(),
  finished_at    timestamptz
);
comment on table public.ihub_shopify_ops is
  '120: سجل عمليات الكتابة على Shopify. بلا أسرار ولا بيانات عملاء: معرّفات وفروق وأسباب ورموز أخطاء. '
  'بلا مفاتيح خارجية عمدًا (سجل تدقيق يبقى بعد الفصل).';
create index if not exists ihub_shopify_ops_actor on public.ihub_shopify_ops (actor_id, created_at desc);
create index if not exists ihub_shopify_ops_company on public.ihub_shopify_ops (company_id, created_at desc);
create index if not exists ihub_shopify_ops_connection on public.ihub_shopify_ops (connection_id, created_at desc);

alter table public.ihub_shopify_confirmations enable row level security;
alter table public.ihub_shopify_ops enable row level security;
revoke all on public.ihub_shopify_confirmations from public, anon, authenticated;
revoke all on public.ihub_shopify_ops from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on public.ihub_shopify_confirmations from service_role;
    revoke all on public.ihub_shopify_ops from service_role;
  end if;
end $$;


-- ============================================================================
-- 4) كتالوج العمليات — مصدر الحقيقة على الخادم
--    risk: read | write | destructive (destructive ⇒ confirm). scopes: كلها مطلوبة (write_x يغطي read_x).
--    supabase/functions/_shared/integrations/shopify-admin.js يطابقه (tests/shopify-management.test.mjs).
-- ============================================================================
create or replace function public._ihub_shopify_op_catalog()
returns table (key text, perm text, risk text, confirm boolean, scopes text[])
language sql
immutable
set search_path to 'public'
as $$
  values
    ('shop.info',                   'store.orders',           'read',        false, array[]::text[]),
    ('location.list',               'store.inventory',        'read',        false, array['read_locations']),
    ('product.list',                'store.catalog',          'read',        false, array['read_products']),
    ('product.get',                 'store.catalog',          'read',        false, array['read_products']),
    ('collection.list',             'store.catalog',          'read',        false, array['read_products']),
    ('collection.get',              'store.catalog',          'read',        false, array['read_products']),
    ('publication.list',            'store.catalog',          'read',        false, array['read_publications']),
    ('order.list',                  'store.orders',           'read',        false, array['read_orders']),
    ('order.get',                   'store.orders',           'read',        false, array['read_orders']),
    ('customer.list',               'store.orders',           'read',        false, array['read_customers']),
    ('customer.get',                'store.orders',           'read',        false, array['read_customers']),
    ('customer.orders',             'store.orders',           'read',        false, array['read_orders']),
    ('draft_order.list',            'store.orders_manage',    'read',        false, array['read_draft_orders']),
    ('draft_order.get',             'store.orders_manage',    'read',        false, array['read_draft_orders']),
    ('inventory.levels',            'store.inventory',        'read',        false, array['read_inventory', 'read_locations']),
    ('discount.list',               'store.discounts',        'read',        false, array['read_discounts']),
    ('discount.get',                'store.discounts',        'read',        false, array['read_discounts']),
    ('fulfillment_order.list',      'store.fulfillment',      'read',        false, array['read_merchant_managed_fulfillment_orders']),
    ('return.list',                 'store.returns',          'read',        false, array['read_returns']),
    ('returnable.list',             'store.returns',          'read',        false, array['read_returns']),
    ('product.create',              'store.catalog',          'write',       false, array['write_products']),
    ('product.update',              'store.catalog',          'write',       false, array['write_products']),
    ('product.set_status',          'store.catalog',          'write',       true,  array['write_products']),
    ('product.archive',             'store.catalog',          'destructive', true,  array['write_products']),
    ('product.delete',              'store.catalog',          'destructive', true,  array['write_products']),
    ('product.publish',             'store.catalog',          'write',       true,  array['write_publications']),
    ('product.unpublish',           'store.catalog',          'write',       true,  array['write_publications']),
    ('product.set_collections',     'store.catalog',          'write',       false, array['write_products']),
    ('variant.create',              'store.catalog',          'write',       false, array['write_products']),
    ('variant.update',              'store.catalog',          'write',       true,  array['write_products']),
    ('variant.delete',              'store.catalog',          'destructive', true,  array['write_products']),
    ('metafield.set',               'store.catalog',          'write',       false, array['write_products']),
    ('collection.create',           'store.catalog',          'write',       false, array['write_products']),
    ('collection.update',           'store.catalog',          'write',       false, array['write_products']),
    ('collection.delete',           'store.catalog',          'destructive', true,  array['write_products']),
    ('order.update_notes',          'store.orders_manage',    'write',       false, array['write_orders']),
    ('order.update_contact',        'store.orders_manage',    'write',       true,  array['write_orders']),
    ('order.create',                'store.orders_manage',    'write',       true,  array['write_orders', 'read_products']),
    ('order.cancel',                'store.orders_manage',    'destructive', true,  array['write_orders']),
    ('draft_order.create',          'store.orders_manage',    'write',       false, array['write_draft_orders']),
    ('draft_order.update',          'store.orders_manage',    'write',       false, array['write_draft_orders']),
    ('draft_order.delete',          'store.orders_manage',    'destructive', true,  array['write_draft_orders']),
    ('customer.create',             'store.customers_manage', 'write',       false, array['write_customers']),
    ('customer.update',             'store.customers_manage', 'write',       false, array['write_customers']),
    ('inventory.adjust',            'store.inventory',        'write',       true,  array['write_inventory', 'read_locations']),
    ('inventory.set',               'store.inventory',        'write',       true,  array['write_inventory', 'read_locations']),
    ('inventory.activate',          'store.inventory',        'write',       true,  array['write_inventory', 'read_locations']),
    ('discount.code_create',        'store.discounts',        'write',       true,  array['write_discounts']),
    ('discount.code_update',        'store.discounts',        'write',       true,  array['write_discounts']),
    ('discount.automatic_create',   'store.discounts',        'write',       true,  array['write_discounts']),
    ('discount.automatic_update',   'store.discounts',        'write',       true,  array['write_discounts']),
    ('discount.activate',           'store.discounts',        'write',       true,  array['write_discounts']),
    ('discount.deactivate',         'store.discounts',        'write',       true,  array['write_discounts']),
    ('discount.delete',             'store.discounts',        'destructive', true,  array['write_discounts']),
    ('fulfillment.create',          'store.fulfillment',      'write',       true,  array['write_merchant_managed_fulfillment_orders']),
    ('fulfillment.tracking_update', 'store.fulfillment',      'write',       true,  array['write_merchant_managed_fulfillment_orders']),
    ('return.create',               'store.returns',          'write',       true,  array['write_returns']),
    ('return.approve',              'store.returns',          'write',       true,  array['write_returns']),
    ('return.decline',              'store.returns',          'write',       true,  array['write_returns']),
    ('return.cancel',               'store.returns',          'destructive', true,  array['write_returns']),
    ('return.close',                'store.returns',          'write',       true,  array['write_returns'])
$$;

-- النطاقات الناقصة: write_x يغطي read_x (shopify.dev).
create or replace function public._ihub_scopes_missing(p_granted text[], p_need text[])
returns text[]
language sql
immutable
set search_path to 'public'
as $$
  select coalesce(array_agg(n order by n), array[]::text[])
    from unnest(coalesce(p_need, array[]::text[])) n
   where not (n = any (coalesce(p_granted, array[]::text[])))
     and not (n like 'read\_%' and ('write_' || substr(n, 6)) = any (coalesce(p_granted, array[]::text[])));
$$;

-- البوابة المشتركة: متجر + خارج المعاينة + الامتيازات + الربط للشركة وفي الدور + الصلاحية + النطاقات.
-- لا تكتب شيئًا. ترجع ما تحتاجه الدوال العامة.
create or replace function public._ihub_shopify_op_gate(p_connection uuid, p_op text,
  out company_id uuid, out role text, out connection_id uuid, out external_account_id text,
  out perm text, out risk text, out confirm boolean)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  o         record;
  r         public.ihub_connections;
  v_missing text[];
begin
  select * into o from public._ihub_shopify_op_catalog() c where c.key = p_op;
  if not found then
    raise exception 'عملية غير معروفة' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  select * into company_id, role from public._store_ctx(false);
  if coalesce(public.preview_mode(), true) then
    raise exception 'إدارة Shopify غير متاحة داخل المعاينة' using errcode = '42501', detail = '{"code":"preview_read_only"}';
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
   where c.id = p_connection and c.company_id = _ihub_shopify_op_gate.company_id and c.provider = 'shopify'
     and c.status in ('active', 'error')
     and public._ihub_role_rank(c.min_view_role) <= public._ihub_role_rank(_ihub_shopify_op_gate.role)
     and exists (select 1 from public.ihub_providers p where p.key = 'shopify' and p.enabled);
  if not found then
    raise exception 'الربط غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  if not public._store_perm(_ihub_shopify_op_gate.company_id, o.perm) then
    raise exception 'لا تملك صلاحية هذه العملية' using errcode = '42501', detail = '{"code":"forbidden"}';
  end if;
  v_missing := public._ihub_scopes_missing(r.granted_scopes, o.scopes);
  if cardinality(v_missing) > 0 then
    raise exception 'صلاحية Shopify ناقصة: % — أعد تفويض التطبيق من صفحة Shopify', array_to_string(v_missing, ', ')
      using errcode = '42501', detail = '{"code":"missing_scope"}';
  end if;
  connection_id := r.id;
  external_account_id := r.external_account_id;
  perm := o.perm;
  risk := o.risk;
  confirm := o.confirm;
end $$;


-- ============================================================================
-- 5) دوال الواجهة (authenticated)
-- ============================================================================

-- إصدار تأكيد لعملية مؤثرة. الدالة الطرفية تولّد الرمز وترسل بصمته؛ الرمز يعود للمتصفح وحده.
create or replace function public.ihub_shopify_op_confirm_begin(p_connection uuid, p_op text, p_input_hash text, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare g record;
begin
  select * into g from public._ihub_shopify_op_gate(p_connection, p_op);
  if not g.confirm then
    raise exception 'هذه العملية لا تحتاج تأكيدًا' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  if p_input_hash is null or p_input_hash !~ '^[0-9a-f]{64}$'
     or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or p_token_hash = p_input_hash then
    raise exception 'طلب غير صالح' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  if (select count(*) from public.ihub_audit_events a
       where a.company_id = g.company_id and a.actor_id = auth.uid() and a.action = 'shopify.confirm.issued'
         and a.created_at > now() - interval '1 minute') >= 30 then
    raise exception 'طلبات كثيرة — انتظر دقيقة' using errcode = 'P0001', detail = '{"code":"rate_limited"}';
  end if;
  delete from public.ihub_shopify_confirmations c
   where c.expires_at < now()
      or (c.user_id = auth.uid() and c.connection_id = g.connection_id and c.op = p_op);
  insert into public.ihub_shopify_confirmations (token_hash, company_id, connection_id, user_id, op, input_hash, expires_at)
  values (p_token_hash, g.company_id, g.connection_id, auth.uid(), p_op, p_input_hash, now() + interval '5 minutes');
  perform public._ihub_audit(g.company_id, g.connection_id, 'user', 'shopify.confirm.issued', jsonb_build_object('op', p_op));
  return jsonb_build_object('op', p_op, 'expires_in', 300, 'risk', g.risk);
end $$;

-- تفويض عملية (قراءة أو كتابة). الكتابة المؤثرة تستهلك تأكيدًا مطابقًا للمستخدم والعملية والمدخلات.
create or replace function public.ihub_shopify_op_authorize(p_connection uuid, p_op text, p_input_hash text,
                                                            p_token_hash text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  g      record;
  v_id   uuid;
  v_conf boolean := false;
begin
  select * into g from public._ihub_shopify_op_gate(p_connection, p_op);
  if g.risk = 'read' then
    if (select count(*) from public.ihub_audit_events a
         where a.company_id = g.company_id and a.actor_id = auth.uid() and a.action = 'data.viewed'
           and a.created_at > now() - interval '1 minute') >= 60 then
      raise exception 'طلبات كثيرة — انتظر دقيقة' using errcode = 'P0001', detail = '{"code":"rate_limited"}';
    end if;
    perform public._ihub_audit(g.company_id, g.connection_id, 'user', 'data.viewed',
                               jsonb_build_object('kind', 'manage', 'mode', p_op));
    return jsonb_build_object('connection_id', g.connection_id, 'company_id', g.company_id,
                              'external_account_id', g.external_account_id, 'actor_id', auth.uid(),
                              'role', g.role, 'op', p_op, 'risk', g.risk);
  end if;

  if p_input_hash is null or p_input_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'طلب غير صالح' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  if (select count(*) from public.ihub_shopify_ops o where o.actor_id = auth.uid() and o.created_at > now() - interval '1 minute') >= 20
     or (select count(*) from public.ihub_shopify_ops o where o.company_id = g.company_id and o.created_at > now() - interval '1 minute') >= 100
     or (g.risk = 'destructive' and (select count(*) from public.ihub_shopify_ops o
                                      where o.actor_id = auth.uid() and o.risk = 'destructive'
                                        and o.created_at > now() - interval '1 minute') >= 5) then
    raise exception 'عمليات كثيرة — انتظر دقيقة' using errcode = 'P0001', detail = '{"code":"rate_limited"}';
  end if;
  if g.confirm then
    if p_token_hash is null then
      raise exception 'هذه العملية تحتاج تأكيدًا' using errcode = '22023', detail = '{"code":"confirmation_required"}';
    end if;
    delete from public.ihub_shopify_confirmations c
     where c.token_hash = p_token_hash and c.user_id = auth.uid() and c.connection_id = g.connection_id
       and c.op = p_op and c.input_hash = p_input_hash and c.expires_at > now();
    if not found then
      raise exception 'التأكيد غير صالح أو انتهى أو تغيّرت البيانات — أكّد من جديد' using errcode = '22023',
        detail = '{"code":"confirmation_invalid"}';
    end if;
    v_conf := true;
  end if;
  insert into public.ihub_shopify_ops (company_id, connection_id, actor_id, op, risk, confirmed, input_hash)
  values (g.company_id, g.connection_id, auth.uid(), p_op, g.risk, v_conf, p_input_hash)
  returning id into v_id;
  perform public._ihub_audit(g.company_id, g.connection_id, 'user', 'shopify.write.requested',
                             jsonb_build_object('op', p_op, 'op_id', v_id, 'confirmed', v_conf));
  return jsonb_build_object('op_id', v_id, 'connection_id', g.connection_id, 'company_id', g.company_id,
                            'external_account_id', g.external_account_id, 'actor_id', auth.uid(),
                            'role', g.role, 'op', p_op, 'risk', g.risk, 'confirmed', v_conf);
end $$;

-- ما يستطيعه المنادي على هذا الربط: الامتياز والمزوّد ثم لكل عملية الصلاحية والنطاقات الناقصة.
-- بيانات وصفية فقط — لا يمس Shopify ولا يُسجَّل وصولًا.
create or replace function public.ihub_shopify_manage_status(p_connection uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_role    text;
  r         public.ihub_connections;
  v_reason  text;
begin
  select * into v_company, v_role from public._store_ctx(false);
  select * into r from public.ihub_connections c
   where c.id = p_connection and c.company_id = v_company and c.provider = 'shopify'
     and public._ihub_role_rank(c.min_view_role) <= public._ihub_role_rank(v_role);
  if not found then
    raise exception 'الربط غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  v_reason := case
    when coalesce(public.preview_mode(), true) then 'preview_read_only'
    when not exists (select 1 from public.ihub_providers p where p.key = 'shopify' and p.enabled) then 'provider_disabled'
    when not (coalesce(public.company_has_feature('integrations_hub'), false)
              and coalesce(public.company_has_feature('shopify_integration'), false)) then 'not_entitled'
    when not coalesce(public.company_has_feature('shopify_management'), false) then 'management_not_enabled'
    when r.status not in ('active', 'error') then 'connection_inactive'
  end;
  return jsonb_build_object(
    'enabled', v_reason is null, 'reason', v_reason, 'role', v_role,
    -- مستحق بصرف النظر عن حالة الربط: يقرر طلب نطاقات الإدارة عند بدء OAuth (api.js shopify_start)
    'entitled', coalesce(v_reason, '') in ('', 'connection_inactive'),
    'connection_id', r.id, 'status', r.status, 'granted_scopes', to_jsonb(coalesce(r.granted_scopes, array[]::text[])),
    'ops', (select jsonb_agg(jsonb_build_object(
                     'key', c.key, 'risk', c.risk, 'confirm', c.confirm, 'perm', c.perm,
                     'permitted', public._store_perm(v_company, c.perm),
                     'missing_scopes', to_jsonb(public._ihub_scopes_missing(r.granted_scopes, c.scopes))) order by c.key)
              from public._ihub_shopify_op_catalog() c));
end $$;

-- سجل العمليات لمدير المتجر. «requested» أقدم من 10 دقائق = نتيجة غير معروفة (انقطع التنفيذ).
create or replace function public.ihub_shopify_ops_list(p_connection uuid, p_limit int default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_role    text;
begin
  select * into v_company, v_role from public._store_ctx(false);
  if v_role <> 'admin' then
    raise exception 'سجل العمليات لمدير المتجر' using errcode = '42501', detail = '{"code":"forbidden"}';
  end if;
  if not exists (select 1 from public.ihub_connections c where c.id = p_connection and c.company_id = v_company and c.provider = 'shopify') then
    raise exception 'الربط غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  return coalesce((
    select jsonb_agg(s.x order by s.ts desc) from (
      select o.created_at as ts, jsonb_build_object(
        'id', o.id, 'op', o.op, 'risk', o.risk, 'confirmed', o.confirmed,
        'status', case when o.status = 'requested' and o.created_at < now() - interval '10 minutes' then 'unknown' else o.status end,
        'error_code', o.error_code, 'resource_ref', o.resource_ref, 'detail', o.detail,
        'actor_name', (select coalesce(nullif(btrim(p.full_name), ''), p.username, 'عضو') from public.profiles p where p.id = o.actor_id),
        'created_at', o.created_at, 'finished_at', o.finished_at) x
        from public.ihub_shopify_ops o
       where o.company_id = v_company and o.connection_id = p_connection
       order by o.created_at desc
       limit least(greatest(coalesce(p_limit, 50), 1), 200)) s), '[]'::jsonb);
end $$;

-- المالك: امتياز الإدارة لمتجره التجريبي وحده (مثل owner_store_test_entitlements في 119).
create or replace function public.owner_store_test_management(p_enable boolean, p_days int default 7, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_days    int := least(greatest(coalesce(p_days, 7), 1), 30);
begin
  if not public.owner_critical_ok() then
    raise exception 'لمالك المنصة في سياقه وبتحقق حديث' using errcode = '42501';
  end if;
  select c.id into v_company from public.companies c where c.user_id = auth.uid() and c.account_kind = 'ecommerce_store';
  if v_company is null then
    raise exception 'حوّل شركتك التجريبية إلى متجر أولًا (owner_set_company_account_kind)' using errcode = '22023';
  end if;
  if p_enable and (v_reason is null or char_length(v_reason) < 10) then
    raise exception 'السبب مطلوب (10 أحرف على الأقل)' using errcode = '22023';
  end if;
  if p_enable then
    insert into public.company_feature_overrides (company_id, feature_key, reason, granted_by, expires_at)
    values (v_company, 'shopify_management', left(v_reason, 300), auth.uid(), now() + make_interval(days => v_days))
    on conflict (company_id, feature_key) do update
      set reason = excluded.reason, granted_by = excluded.granted_by, granted_at = now(), expires_at = excluded.expires_at;
  else
    delete from public.company_feature_overrides where company_id = v_company and feature_key = 'shopify_management';
  end if;
  perform public.log_privileged(case when p_enable then 'store.test_management.granted' else 'store.test_management.revoked' end,
    null, null, jsonb_build_object('company_id', v_company, 'days', case when p_enable then v_days end, 'reason', left(v_reason, 300)));
  return jsonb_build_object('company_id', v_company, 'enabled', p_enable,
                            'expires_at', case when p_enable then now() + make_interval(days => v_days) end);
end $$;


-- ============================================================================
-- 6) دالة الخادم (service_role): نتيجة العملية
-- ============================================================================
create or replace function public.ihub_svc_shopify_op_result(p_op_id uuid, p_status text, p_error_code text default null,
                                                             p_resource text default null, p_detail jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare o public.ihub_shopify_ops;
begin
  if p_status is null or p_status not in ('succeeded', 'submitted', 'failed')
     or (p_error_code is not null and p_error_code !~ '^[a-z_]{1,48}$')
     or (p_status = 'failed') <> (p_error_code is not null)
     or (p_resource is not null and p_resource !~ '^[A-Za-z]{2,40}/[0-9]{1,20}$')
     or jsonb_typeof(coalesce(p_detail, '{}'::jsonb)) <> 'object'
     or octet_length(coalesce(p_detail, '{}'::jsonb)::text) > 4000 then
    raise exception 'نتيجة غير صالحة' using errcode = '22023';
  end if;
  update public.ihub_shopify_ops
     set status = p_status, error_code = p_error_code, resource_ref = p_resource,
         detail = coalesce(p_detail, '{}'::jsonb), finished_at = now()
   where id = p_op_id and status = 'requested'
  returning * into o;
  if not found then
    raise exception 'العملية غير موجودة أو مسجّلة' using errcode = 'P0002';
  end if;
  insert into public.ihub_audit_events (company_id, connection_id, actor_id, actor_kind, action, detail)
  values (o.company_id, o.connection_id, o.actor_id, 'system', 'shopify.write.' || p_status,
          jsonb_strip_nulls(jsonb_build_object('op', o.op, 'op_id', o.id, 'error_code', p_error_code, 'resource', p_resource)));
  return jsonb_build_object('op_id', o.id, 'status', o.status);
end $$;


-- ============================================================================
-- 7) بيانات المزوّد الوصفية (المزوّد يبقى مقفلًا)
-- ============================================================================
update public.ihub_providers
   set capabilities = capabilities || jsonb_build_object(
         'write_operations', 'implemented_unverified', 'manage_products', 'implemented_unverified',
         'manage_inventory', 'implemented_unverified', 'manage_orders', 'implemented_unverified',
         'manage_customers', 'implemented_unverified', 'manage_discounts', 'implemented_unverified',
         'manage_fulfillment', 'implemented_unverified', 'manage_returns', 'implemented_unverified',
         'financial_operations', 'not_implemented')
 where key = 'shopify';


-- ============================================================================
-- 8) الصلاحيات
-- ============================================================================
do $$
declare
  f text;
  v_internal text[] := array[
    'public._ihub_shopify_op_catalog()', 'public._ihub_scopes_missing(text[],text[])',
    'public._ihub_shopify_op_gate(uuid,text)'];
  v_user text[] := array[
    'public.ihub_shopify_op_confirm_begin(uuid,text,text,text)', 'public.ihub_shopify_op_authorize(uuid,text,text,text)',
    'public.ihub_shopify_manage_status(uuid)', 'public.ihub_shopify_ops_list(uuid,integer)',
    'public.owner_store_test_management(boolean,integer,text)'];
  v_svc text[] := array['public.ihub_svc_shopify_op_result(uuid,text,text,text,jsonb)'];
begin
  foreach f in array v_internal || v_user || v_svc loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
  foreach f in array v_user loop
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach f in array v_svc loop
      execute format('grant execute on function %s to service_role', f);
    end loop;
  end if;
end $$;


-- ============================================================================
-- 9) تحقق
-- ============================================================================
do $$
declare t text; fn record;
begin
  foreach t in array array['ihub_shopify_confirmations', 'ihub_shopify_ops'] loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then
      raise exception '120: سياسة على %', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'SELECT') or has_table_privilege('anon', 'public.' || t, 'SELECT')
       or has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       or (exists (select 1 from pg_roles where rolname = 'service_role')
           and has_table_privilege('service_role', 'public.' || t, 'SELECT')) then
      raise exception '120: صلاحية مباشرة على %', t;
    end if;
  end loop;
  if exists (select 1 from public._ihub_shopify_op_catalog() c
              where (c.risk = 'destructive' and not c.confirm) or (c.risk = 'read' and c.confirm)
                 or not exists (select 1 from public.company_permission_catalog p where p.key = c.perm)) then
    raise exception '120: كتالوج العمليات غير متسق';
  end if;
  if exists (select 1 from public.plan_features pf where pf.feature_key = 'shopify_management' and pf.enabled) then
    raise exception '120: shopify_management ممنوح لباقة — قرار المالك وحده';
  end if;
  for fn in select p.oid, p.oid::regprocedure::text sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and (p.proname like 'ihub\_shopify\_%' or p.proname like '\_ihub\_shopify\_%'
                                             or p.proname = 'ihub_svc_shopify_op_result' or p.proname = '_ihub_scopes_missing') loop
    if has_function_privilege('anon', fn.oid, 'EXECUTE') then
      raise exception '120: دالة مكشوفة لـanon: %', fn.sig;
    end if;
    if (fn.proname like 'ihub\_svc\_%' or fn.proname like '\_%') and has_function_privilege('authenticated', fn.oid, 'EXECUTE') then
      raise exception '120: دالة داخلية مكشوفة لـauthenticated: %', fn.sig;
    end if;
  end loop;
  raise notice '120: إدارة Shopify جاهزة — الامتياز غير ممنوح لأي باقة، والمزوّد كما هو';
end $$;
