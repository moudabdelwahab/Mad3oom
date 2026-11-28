-- ============================================================================
-- 152_shopify_product_analytics
--   • عملية قراءة جديدة product.analytics (كتالوج 120 + 1 = 62): بطاقات تحليلات المنتجات
--     في «إدارة المتجر» (معدل البيع، أيام المخزون المتبقية، ABC) من استعلام GraphQL واحد.
--     بلا كتابة، بلا تأكيد، بلا عمليات مالية. الصلاحية store.catalog، والنطاقان
--     read_products + read_orders (يغطيهما write_products/write_orders عند التفويض للإدارة).
--   • لا يمس دوال 118/119/120/139 ولا الجداول ولا الامتيازات ولا المزوّد.
--   • التراجع: migrations/_rollback/152_shopify_product_analytics.down.sql (يعيد كتالوج 120).
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
    ('product.analytics',           'store.catalog',          'read',        false, array['read_products', 'read_orders']),
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

-- تحقق: الكتالوج 62 عملية، وproduct.analytics قراءة بلا تأكيد وبالنطاقين.
do $$
begin
  if (select count(*) from public._ihub_shopify_op_catalog()) <> 62 then
    raise exception 'الترحيل 152: الكتالوج ليس 62 عملية';
  end if;
  if not exists (select 1 from public._ihub_shopify_op_catalog()
                 where key = 'product.analytics' and perm = 'store.catalog' and risk = 'read' and not confirm
                   and scopes = array['read_products', 'read_orders']) then
    raise exception 'الترحيل 152: product.analytics ليس كما هو معرّف';
  end if;
end $$;
