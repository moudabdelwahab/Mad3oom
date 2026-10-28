// ============================================================================
// مدخلات صالحة لكل عملية إدارة Shopify + Shopify مزيّف يجيب عن كل استعلام وطفرة.
// يستعملها tests/shopify-management.test.mjs و integrations/shopify/schema-check.mjs
// (التحقق من الوثائق والمتغيرات على مخطط 2026-10 الحقيقي).
//
// تنبيه صدق: الردود هنا من صنعنا على شكل المخطط؛ لا تثبت سلوك Shopify الفعلي.
// ============================================================================

export const SHOP = 'shop-a.myshopify.com';
export const G = Object.freeze({
    product: 'gid://shopify/Product/101', variant: 'gid://shopify/ProductVariant/201', variant2: 'gid://shopify/ProductVariant/202',
    item: 'gid://shopify/InventoryItem/301', location: 'gid://shopify/Location/401', location2: 'gid://shopify/Location/402',
    order: 'gid://shopify/Order/1001', customer: 'gid://shopify/Customer/555', collection: 'gid://shopify/Collection/601',
    publication: 'gid://shopify/Publication/701', draft: 'gid://shopify/DraftOrder/801',
    codeDiscount: 'gid://shopify/DiscountCodeNode/901', autoDiscount: 'gid://shopify/DiscountAutomaticNode/902',
    fo: 'gid://shopify/FulfillmentOrder/1101', foLine: 'gid://shopify/FulfillmentOrderLineItem/1201',
    fulfillment: 'gid://shopify/Fulfillment/1301', fli: 'gid://shopify/FulfillmentLineItem/1401', ret: 'gid://shopify/Return/1501'
});

const ADDRESS = { first_name: 'Sara', last_name: 'Ali', address1: '1 Nile St', city: 'Cairo', country_code: 'EG', zip: '11511' };
const DISCOUNT = {
    title: 'Winter 10', starts_at: '2026-11-01T00:00:00Z', ends_at: '2026-12-01T00:00:00Z',
    value: { type: 'percentage', amount: '10' }, items: { all: true }, minimum: { subtotal: '200' },
    combines_with: { order: false, product: true, shipping: true }
};

/** مدخل صالح لكل عملية (ما يرسله المتصفح). */
export const VALID_INPUTS = Object.freeze({
    'shop.info': {},
    'location.list': { include_inactive: true },
    'product.list': { query: 'shirt', status: 'ACTIVE' },
    'product.get': { id: '101' },
    'collection.list': { query: 'summer' },
    'collection.get': { id: G.collection },
    'publication.list': { product_id: G.product },
    'order.list': { query: '#1001', financial_status: 'pending', status: 'open' },
    'order.get': { id: '1001' },
    'customer.list': { query: 'sara@example.com' },
    'customer.get': { id: '555' },
    'customer.orders': { id: '555' },
    'draft_order.list': { status: 'open' },
    'draft_order.get': { id: G.draft },
    'inventory.levels': { variant_id: G.variant },
    'discount.list': { type: 'code', query: 'winter' },
    'discount.get': { type: 'code', id: G.codeDiscount },
    'fulfillment_order.list': { order_id: G.order },
    'return.list': { order_id: G.order },
    'returnable.list': { order_id: G.order },
    'product.create': { title: 'Linen shirt', description_html: '<p>Soft <strong>linen</strong></p>', vendor: 'Mad3oom', product_type: 'Shirts',
                        tags: ['summer', 'linen'], options: [{ name: 'Size', values: ['S', 'M'] }] },
    'product.update': { id: G.product, title: 'Linen shirt v2', tags: ['summer'] },
    'product.set_status': { id: G.product, status: 'ACTIVE' },
    'product.archive': { id: G.product },
    'product.delete': { id: G.product },
    'product.publish': { id: G.product, publication_ids: [G.publication] },
    'product.unpublish': { id: G.product, publication_ids: [G.publication] },
    'product.set_collections': { id: G.product, join: [G.collection] },
    'variant.create': { product_id: G.product, variants: [{ options: [{ name: 'Size', value: 'L' }], price: '120.00', compare_at_price: '150.00', sku: 'SH-L', tracked: true }] },
    'variant.update': { product_id: G.product, variants: [{ id: G.variant, price: '110.00', compare_at_price: null, sku: 'SH-M2' }] },
    'variant.delete': { product_id: G.product, variant_ids: [G.variant] },
    'metafield.set': { owner_id: G.product, namespace: 'custom', key: 'care', type: 'single_line_text_field', value: 'Hand wash' },
    'collection.create': { title: 'Summer', description_html: '<p>Hot</p>', sort_order: 'BEST_SELLING' },
    'collection.update': { id: G.collection, title: 'Summer 26' },
    'collection.delete': { id: G.collection },
    'order.update_notes': { id: G.order, note: 'Call before delivery', tags: ['vip'] },
    'order.update_contact': { id: G.order, email: 'Sara@Example.com', shipping_address: ADDRESS },
    'order.create': { lines: [{ variant_id: G.variant, quantity: 2 }], customer_id: G.customer, shipping_address: ADDRESS, note: 'Phone order', test: true },
    'order.cancel': { id: G.order, reason: 'CUSTOMER', restock: true },
    'draft_order.create': { lines: [{ variant_id: G.variant, quantity: 1 }], customer_id: G.customer, discount: { percent: '5', title: 'Loyal' } },
    'draft_order.update': { id: G.draft, note: 'Updated', lines: [{ variant_id: G.variant, quantity: 3 }] },
    'draft_order.delete': { id: G.draft },
    'customer.create': { first_name: 'Sara', last_name: 'Ali', email: 'sara@example.com', phone: '+201001234567', tags: ['vip'] },
    'customer.update': { id: G.customer, note: 'Prefers WhatsApp' },
    'inventory.adjust': { name: 'available', reason: 'damaged', changes: [{ inventory_item_id: G.item, location_id: G.location, delta: -2, expected_quantity: 10 }] },
    'inventory.set': { name: 'on_hand', reason: 'cycle_count_available', quantities: [{ inventory_item_id: G.item, location_id: G.location, quantity: 12, expected_quantity: 11 }] },
    'inventory.activate': { inventory_item_id: G.item, location_id: G.location2, available: 5 },
    'discount.code_create': { ...DISCOUNT, code: 'winter10', usage_limit: 100, once_per_customer: true },
    'discount.code_update': { id: G.codeDiscount, usage_limit: 200, ends_at: '2026-12-15T00:00:00Z' },
    'discount.automatic_create': { ...DISCOUNT, value: { type: 'fixed_amount', amount: '25', each_item: false } },
    'discount.automatic_update': { id: G.autoDiscount, title: 'Auto 25' },
    'discount.activate': { type: 'code', id: G.codeDiscount },
    'discount.deactivate': { type: 'automatic', id: G.autoDiscount },
    'discount.delete': { type: 'code', id: G.codeDiscount },
    'fulfillment.create': { order_id: G.order, fulfillment_orders: [{ id: G.fo, lines: [{ id: G.foLine, quantity: 2 }] }],
                            tracking: { company: 'Aramex', number: 'TRK123', url: 'https://track.example/TRK123' } },
    'fulfillment.tracking_update': { fulfillment_id: G.fulfillment, tracking: { company: 'DHL', number: 'DHL999' } },
    'return.create': { order_id: G.order, lines: [{ fulfillment_line_item_id: G.fli, quantity: 1, note: 'Too small' }] },
    'return.approve': { id: G.ret },
    'return.decline': { id: G.ret, reason: 'FINAL_SALE', note: 'Final sale item' },
    'return.cancel': { id: G.ret },
    'return.close': { id: G.ret }
});

const money = (amount) => ({ shopMoney: { amount, currencyCode: 'EGP' } });
const UE = [];

/** حالة Shopify المزيّف — الاختبارات تعدّلها. */
export function shopState(over = {}) {
    return {
        productStatus: 'DRAFT', financial: 'PENDING', fulfillment: 'UNFULFILLED', received: '0.0', capturable: false, fullyPaid: false,
        cancelledAt: null, returnStatus: 'REQUESTED', discountStatus: 'SCHEDULED', available: 10, onHand: 11,
        foStatus: 'OPEN', foRemaining: 2, returnable: 1, variantPrice: '100.00', availableForSale: true,
        userErrors: null, accessDenied: false, throttled: false, protectedField: false,
        ...over
    };
}

function productNode(st) {
    return {
        id: G.product, title: 'Linen shirt', handle: 'linen-shirt', status: st.productStatus, vendor: 'Mad3oom', productType: 'Shirts',
        tags: ['summer'], descriptionHtml: '<p>Soft</p>', updatedAt: '2026-10-27T10:00:00Z', onlineStoreUrl: null, totalInventory: 10,
        variantsCount: { count: 1 },
        options: [{ id: 'gid://shopify/ProductOption/1', name: 'Size', optionValues: [{ id: 'gid://shopify/ProductOptionValue/1', name: 'M' }] }],
        variants: { nodes: [{ id: G.variant, title: 'M', sku: 'SH-M', price: st.variantPrice, compareAtPrice: null, inventoryPolicy: 'DENY',
                              inventoryQuantity: st.available, taxable: true, selectedOptions: [{ name: 'Size', value: 'M' }],
                              inventoryItem: { id: G.item, tracked: true } }] },
        collections: { nodes: [{ id: G.collection, title: 'Summer' }] },
        metafields: { nodes: [{ id: 'gid://shopify/Metafield/1', namespace: 'custom', key: 'care', type: 'single_line_text_field', value: 'Hand wash' }] },
        resourcePublicationsV2: { nodes: [{ isPublished: false, publication: { id: G.publication } }] }
    };
}
function orderNode(st) {
    return {
        id: G.order, name: '#1001', createdAt: '2026-10-20T09:00:00Z', updatedAt: '2026-10-21T09:00:00Z', processedAt: '2026-10-20T09:00:00Z',
        cancelledAt: st.cancelledAt, cancelReason: null, closed: false, test: false, confirmed: true,
        displayFinancialStatus: st.financial, displayFulfillmentStatus: st.fulfillment, returnStatus: 'NO_RETURN',
        fullyPaid: st.fullyPaid, unpaid: !st.fullyPaid, capturable: st.capturable,
        totalPriceSet: money('200.00'), totalReceivedSet: money(st.received), totalOutstandingSet: money('200.00'), totalRefundedSet: money('0.0'),
        note: 'n', tags: ['vip'], email: 'sara@example.com', phone: '+201001234567', customer: { id: G.customer, displayName: 'Sara Ali' },
        shippingAddress: { firstName: 'Sara', lastName: 'Ali', company: null, address1: '1 Nile St', address2: null, city: 'Cairo',
                           provinceCode: 'C', zip: '11511', countryCodeV2: 'EG', phone: null },
        lineItems: { nodes: [{ id: 'gid://shopify/LineItem/1', title: 'Linen shirt', variantTitle: 'M', sku: 'SH-M', quantity: 2, currentQuantity: 2,
                               variant: { id: G.variant }, originalUnitPriceSet: money('100.00') }] },
        fulfillmentOrders: { nodes: [{ id: G.fo, status: st.foStatus, requestStatus: 'UNSUBMITTED',
            assignedLocation: { name: 'Main', location: { id: G.location } }, supportedActions: [{ action: 'CREATE_FULFILLMENT' }],
            lineItems: { nodes: [{ id: G.foLine, totalQuantity: 2, remainingQuantity: st.foRemaining, productTitle: 'Linen shirt', variantTitle: 'M', sku: 'SH-M' }] } }] },
        fulfillments: [{ id: G.fulfillment, status: 'SUCCESS', displayStatus: 'IN_TRANSIT', createdAt: '2026-10-22T09:00:00Z',
                         trackingInfo: [{ company: 'Aramex', number: 'TRK1', url: 'https://track.example/TRK1' }] }],
        returns: { nodes: [{ id: G.ret, name: '#1001-R1', status: st.returnStatus, totalQuantity: 1, createdAt: '2026-10-23T09:00:00Z', closedAt: null }] }
    };
}
function discountNode(type, st) {
    return type === 'code'
        ? { id: G.codeDiscount, codeDiscount: { __typename: 'DiscountCodeBasic', title: 'Winter 10', status: st.discountStatus, startsAt: '2026-11-01T00:00:00Z',
                                                endsAt: '2026-12-01T00:00:00Z', summary: '10% off', usageLimit: 100, asyncUsageCount: 3, appliesOncePerCustomer: true,
                                                codes: { nodes: [{ code: 'WINTER10' }] } } }
        : { id: G.autoDiscount, automaticDiscount: { __typename: 'DiscountAutomaticBasic', title: 'Auto', status: st.discountStatus,
                                                     startsAt: '2026-11-01T00:00:00Z', endsAt: null, summary: '25 off' } };
}
const page = { hasNextPage: false, endCursor: null };

/** يجيب عن وثيقة واحدة. يرجع { data, errors? } أو { throttled: true }. */
export function answer(query, vars, st) {
    const q = query.replace(/\s+/g, ' ');
    const has = (re) => re.test(q);
    if (st.throttled) return { throttled: true };
    const errors = [];
    if (/^\s*mutation/.test(q)) {
        const root = q.match(/\{\s*([A-Za-z]+)\s*\(/)[1];
        if (st.accessDenied) return { data: { [root]: null }, errors: [{ message: 'Access denied for ' + root, extensions: { code: 'ACCESS_DENIED' } }] };
        const userErrors = st.userErrors || UE;
        const ueKey = root === 'orderCancel' ? 'orderCancelUserErrors' : 'userErrors';
        const out = {
            productCreate: { product: { id: G.product, title: vars.product?.title, status: 'DRAFT' } },
            productUpdate: { product: { id: vars.product?.id, title: 'Linen shirt', status: vars.product?.status || 'DRAFT', collections: { nodes: [{ id: G.collection, title: 'Summer' }] } } },
            productDelete: { deletedProductId: vars.input?.id },
            publishablePublish: {}, publishableUnpublish: {},
            productVariantsBulkCreate: { productVariants: [{ id: G.variant2, title: 'L', price: '120.00' }] },
            productVariantsBulkUpdate: { productVariants: [{ id: G.variant, price: '110.00', compareAtPrice: null }] },
            productVariantsBulkDelete: { product: { id: G.product } },
            metafieldsSet: { metafields: [{ id: 'gid://shopify/Metafield/1', namespace: 'custom', key: 'care' }] },
            collectionCreate: { collection: { id: G.collection, title: vars.collection?.title } },
            collectionUpdate: { collection: { id: G.collection, title: vars.collection?.title || 'Summer' } },
            collectionDelete: { deletedCollectionId: vars.input?.id },
            orderUpdate: { order: { id: vars.input?.id } },
            orderCreate: { order: { id: 'gid://shopify/Order/2001', name: '#2001', displayFinancialStatus: 'PENDING' } },
            orderCancel: { job: { id: 'gid://shopify/Job/1', done: false } },
            draftOrderCreate: { draftOrder: { id: G.draft, name: '#D1', status: 'OPEN', totalPriceSet: money('95.00') } },
            draftOrderUpdate: { draftOrder: { id: G.draft, name: '#D1', status: 'OPEN', totalPriceSet: money('300.00') } },
            draftOrderDelete: { deletedId: vars.input?.id },
            customerCreate: { customer: st.protectedField ? null : { id: G.customer } },
            customerUpdate: { customer: { id: G.customer } },
            inventoryAdjustQuantities: { inventoryAdjustmentGroup: { createdAt: '2026-10-28T10:00:00Z', reason: vars.input?.reason,
                changes: [{ name: vars.input?.name, delta: -2, quantityAfterChange: 8, item: { id: G.item }, location: { id: G.location } }] } },
            inventorySetQuantities: { inventoryAdjustmentGroup: { createdAt: '2026-10-28T10:00:00Z', reason: vars.input?.reason,
                changes: [{ name: vars.input?.name, delta: 1, quantityAfterChange: 12, item: { id: G.item }, location: { id: G.location } }] } },
            inventoryActivate: { inventoryLevel: { id: 'gid://shopify/InventoryLevel/9' } },
            discountCodeBasicCreate: { codeDiscountNode: { id: G.codeDiscount } }, discountCodeBasicUpdate: { codeDiscountNode: { id: G.codeDiscount } },
            discountAutomaticBasicCreate: { automaticDiscountNode: { id: G.autoDiscount } }, discountAutomaticBasicUpdate: { automaticDiscountNode: { id: G.autoDiscount } },
            discountCodeActivate: { codeDiscountNode: { id: G.codeDiscount } }, discountCodeDeactivate: { codeDiscountNode: { id: G.codeDiscount } },
            discountAutomaticActivate: { automaticDiscountNode: { id: G.autoDiscount } }, discountAutomaticDeactivate: { automaticDiscountNode: { id: G.autoDiscount } },
            discountCodeDelete: { deletedCodeDiscountId: vars.id }, discountAutomaticDelete: { deletedAutomaticDiscountId: vars.id },
            fulfillmentCreate: { fulfillment: { id: G.fulfillment, status: 'SUCCESS' } },
            fulfillmentTrackingInfoUpdate: { fulfillment: { id: G.fulfillment, status: 'SUCCESS' } },
            returnCreate: { return: { id: G.ret, name: '#1001-R1', status: 'OPEN' } },
            returnApproveRequest: { return: { id: G.ret, status: 'OPEN' } }, returnDeclineRequest: { return: { id: G.ret, status: 'DECLINED' } },
            returnCancel: { return: { id: G.ret, status: 'CANCELED' } }, returnClose: { return: { id: G.ret, status: 'CLOSED' } }
        }[root];
        if (!out) throw new Error('fake shopify: unknown mutation ' + root);
        if (st.protectedField) errors.push({ message: 'This app is not approved to access the Customer object', extensions: { code: 'ACCESS_DENIED' } });
        return { data: { [root]: { ...out, [ueKey]: userErrors } }, errors };
    }
    const data = {};
    if (has(/\bshop\s*\{/)) data.shop = { id: 'gid://shopify/Shop/1', name: 'Shop A', myshopifyDomain: SHOP, currencyCode: 'EGP', ianaTimezone: 'Africa/Cairo',
                                          weightUnit: 'KILOGRAMS', plan: { partnerDevelopment: true, shopifyPlus: false, publicDisplayName: 'Development' },
                                          primaryDomain: { url: 'https://shop-a.myshopify.com' } };
    if (has(/\blocations\(/)) data.locations = { nodes: [{ id: G.location, name: 'Main', isActive: true, fulfillsOnlineOrders: true, address: { city: 'Cairo', countryCode: 'EG' } }] };
    if (has(/\bproducts\(/)) data.products = { pageInfo: page, nodes: [productNode(st)] };
    if (has(/\bproduct\(id/)) data.product = productNode(st);
    if (has(/\bcollections\(/)) data.collections = { pageInfo: page, nodes: [{ id: G.collection, title: 'Summer', handle: 'summer', sortOrder: 'MANUAL', updatedAt: '2026-10-27T10:00:00Z', productsCount: { count: 3 } }] };
    if (has(/\bcollection\(id/)) data.collection = { id: G.collection, title: 'Summer', handle: 'summer', descriptionHtml: '<p>x</p>', sortOrder: 'MANUAL',
                                                     updatedAt: '2026-10-27T10:00:00Z', productsCount: { count: 1 }, products: { nodes: [{ id: G.product, title: 'Linen shirt', status: 'ACTIVE' }] } };
    if (has(/\bpublications\(/)) data.publications = { nodes: [{ id: G.publication, catalog: { title: 'Online Store' } }] };
    if (has(/\borders\(/)) data.orders = { pageInfo: page, nodes: [orderNode(st)] };
    if (has(/\border\(id/)) data.order = orderNode(st);
    if (has(/\bcustomers\(/)) data.customers = { pageInfo: page, nodes: [{ id: G.customer, displayName: 'Sara Ali', updatedAt: '2026-10-27T10:00:00Z', numberOfOrders: '3',
                                                                          defaultEmailAddress: { emailAddress: 'sara@example.com' } }] };
    if (has(/\bcustomer\(id/)) data.customer = { id: G.customer, displayName: 'Sara Ali', firstName: 'Sara', lastName: 'Ali', note: null, tags: [],
                                                 createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-10-27T10:00:00Z', numberOfOrders: '3',
                                                 amountSpent: { amount: '600.00', currencyCode: 'EGP' },
                                                 defaultEmailAddress: { emailAddress: 'sara@example.com' }, defaultPhoneNumber: { phoneNumber: '+201001234567' } };
    if (has(/\bdraftOrders\(/)) data.draftOrders = { pageInfo: page, nodes: [{ id: G.draft, name: '#D1', status: 'OPEN', createdAt: '2026-10-27T10:00:00Z',
                                                                              updatedAt: '2026-10-27T10:00:00Z', totalPriceSet: money('95.00'), customer: { displayName: 'Sara Ali' } }] };
    if (has(/\bdraftOrder\(id/)) data.draftOrder = { id: G.draft, name: '#D1', status: 'OPEN', createdAt: '2026-10-27T10:00:00Z', updatedAt: '2026-10-27T10:00:00Z',
                                                     note2: 'n', email: null, tags: [], customer: { id: G.customer, displayName: 'Sara Ali' },
                                                     appliedDiscount: { title: 'Loyal', value: 5, valueType: 'PERCENTAGE' }, totalPriceSet: money('95.00'),
                                                     subtotalPriceSet: money('100.00'), order: null,
                                                     lineItems: { nodes: [{ id: 'gid://shopify/DraftOrderLineItem/1', title: 'Linen shirt', variantTitle: 'M', sku: 'SH-M',
                                                                            quantity: 1, variant: { id: G.variant }, originalUnitPriceSet: money('100.00') }] } };
    if (has(/\bproductVariant\(id/)) data.productVariant = { id: G.variant, title: 'M', sku: 'SH-M', product: { id: G.product, title: 'Linen shirt' },
        inventoryItem: { id: G.item, tracked: true, inventoryLevels: { nodes: [{ id: 'gid://shopify/InventoryLevel/1', location: { id: G.location, name: 'Main', isActive: true },
            quantities: [{ name: 'available', quantity: st.available }, { name: 'on_hand', quantity: st.onHand }, { name: 'committed', quantity: 1 }, { name: 'incoming', quantity: 0 }] }] } } };
    if (has(/\bnodes\(ids/)) {
        const ids = vars.ids || [];
        if (has(/on InventoryItem/)) {
            data.nodes = ids.map((id) => (id === G.item ? { id: G.item, tracked: true, inventoryLevels: { nodes: [{ location: { id: G.location, name: 'Main', isActive: true },
                quantities: [{ name: 'available', quantity: st.available }, { name: 'on_hand', quantity: st.onHand }] }] } } : null));
        } else {
            data.nodes = ids.map((id) => ([G.variant, G.variant2].includes(id) ? { id, title: 'M', sku: 'SH-M', price: st.variantPrice, compareAtPrice: null,
                availableForSale: st.availableForSale, product: { id: G.product, title: 'Linen shirt', status: 'ACTIVE' } } : null));
        }
    }
    if (has(/\blocation\(id/)) data.location = { id: vars.id, name: 'Warehouse', isActive: true };
    if (has(/\bcodeDiscountNodes\(/)) data.codeDiscountNodes = { pageInfo: page, nodes: [discountNode('code', st)] };
    if (has(/\bautomaticDiscountNodes\(/)) data.automaticDiscountNodes = { pageInfo: page, nodes: [discountNode('automatic', st)] };
    if (has(/\bcodeDiscountNode\(id/)) data.codeDiscountNode = discountNode('code', st);
    if (has(/\bautomaticDiscountNode\(id/)) data.automaticDiscountNode = discountNode('automatic', st);
    if (has(/\bfulfillment\(id/)) data.fulfillment = { id: G.fulfillment, status: 'SUCCESS', order: { id: G.order } };
    if (has(/\breturn\(id/)) data.return = { id: G.ret, name: '#1001-R1', status: st.returnStatus, order: { id: G.order } };
    if (has(/\breturnableFulfillments\(/)) data.returnableFulfillments = { nodes: [{ id: 'gid://shopify/ReturnableFulfillment/1', fulfillment: { id: G.fulfillment },
        returnableFulfillmentLineItems: { nodes: [{ quantity: st.returnable, fulfillmentLineItem: { id: G.fli, lineItem: { title: 'Linen shirt', sku: 'SH-M' } } }] } }] };
    if (!Object.keys(data).length) throw new Error('fake shopify: unknown query ' + q.slice(0, 120));
    return { data };
}
