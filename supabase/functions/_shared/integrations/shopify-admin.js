// ============================================================================
// shopify-admin.js — عمليات إدارة متجر Shopify (Admin GraphQL 2026-10). 120.
//
// كل عملية هنا: validate(input) خالصة وصارمة (مفاتيح معروفة فقط، أنواع وحدود) ← بصمة المدخلات ←
// تفويض القاعدة (ihub_shopify_op_authorize: الشركة، الدور، الصلاحية، النطاق، الحد، التأكيد) ←
// check(ctx, v) يقرأ حالة Shopify الحالية ويتحقق من الأهلية (لا ثقة بأسعار أو كميات أو معرّفات من
// المتصفح) ← run(ctx, v) يرسل الطلب ← نتيجة بلا نص من المزوّد.
//
// المعتمد من shopify.dev (2026-10-28) وغير المنفّذ على متجر بعد: docs/ecommerce/SHOPIFY_MANAGEMENT_MATRIX.md
//   • inventoryAdjustQuantities / inventorySetQuantities: @idempotent(key:) إلزامي منذ 2026-04،
//     changeFromQuantity إلزامي (نرسله دائمًا = قيمة رآها المستخدم؛ CHANGE_FROM_QUANTITY_STALE عند التغيّر).
//   • draftOrderComplete يعلّم الطلب مدفوعًا ⇒ عملية مالية ⇒ غير منفّذة. لا استرداد ولا تحصيل.
//   • orderCancel مهمة غير متزامنة (job): النتيجة «أُرسل»، لا «أُلغي»؛ نلغي غير المدفوع وحده.
//   • fulfillmentCreate بنطاق write_merchant_managed_fulfillment_orders (لا write_fulfillments).
//   • collectionAddProducts/RemoveProducts مهملة ⇒ productUpdate.collectionsToJoin/Leave.
//
// لا نص من Shopify يخرج (errors.js): userErrors ← { field, code } فقط.
// ============================================================================

import { ConnectorError } from './errors.js';
import { graphql, shopHandle } from './shopify.js';
import { shortText, amountText, isoUtc } from './contract.js';
import { sha256Hex } from './crypto.js';
import { maskEmail } from './redact.js';

/* ── أخطاء المدخلات: اسم حقلنا نحن (لا قيمة) ─────────────────────────── */

export class InputError extends ConnectorError {
    constructor(field) {
        super('invalid_input', field);
        this.field = String(field).slice(0, 80);
    }
}
const bad = (f) => { throw new InputError(f); };
const present = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined && o[k] !== null && o[k] !== '';

function obj(v, f) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) bad(f);
    return v;
}
/** مفاتيح معروفة فقط: company_id أو price من المتصفح في عملية لا تقبله = رفض، لا تجاهل. */
function only(o, allowed, f = 'input') {
    obj(o, f);
    for (const k of Object.keys(o)) if (!allowed.includes(k)) bad(f === 'input' ? k : `${f}.${k}`);
    return o;
}
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
function text(v, f, { min = 1, max = 255, re = null } = {}) {
    if (typeof v !== 'string') bad(f);
    const t = v.normalize('NFC').trim();
    if (t.length < min || t.length > max || CTRL.test(t) || (re && !re.test(t))) bad(f);
    return t;
}
function integer(v, f, min, max) {
    const n = typeof v === 'string' && /^-?[0-9]{1,9}$/.test(v.trim()) ? Number(v) : v;
    if (!Number.isInteger(n) || n < min || n > max) bad(f);
    return n;
}
/** مبلغ عشري نصي (Money/Decimal): ≥ 0، ≤ 4 خانات عشرية، حد أعلى. */
function money(v, f, { max = 1_000_000_000, positive = false } = {}) {
    const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v.trim() : '';
    if (!/^[0-9]{1,10}(\.[0-9]{1,4})?$/.test(s)) bad(f);
    const n = Number(s);
    if (n > max || (positive && n <= 0)) bad(f);
    return s;
}
function bool(v, f) {
    if (typeof v !== 'boolean') bad(f);
    return v;
}
function oneOf(v, f, list) {
    if (!list.includes(v)) bad(f);
    return v;
}
function isoDate(v, f) {
    if (typeof v !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,3})?)?(Z|[+-][0-9]{2}:[0-9]{2})?)?$/.test(v.trim())) bad(f);
    const t = Date.parse(v.trim());
    if (!Number.isFinite(t)) bad(f);
    return new Date(t).toISOString();
}
function list(v, f, { min = 1, max }, each) {
    if (!Array.isArray(v) || v.length < min || v.length > max) bad(f);
    return v.map((x, i) => each(x, `${f}.${i}`));
}
function uniq(arr, f) {
    if (new Set(arr).size !== arr.length) bad(f);
    return arr;
}
const GID_RE = /^gid:\/\/shopify\/([A-Za-z]{2,40})\/([0-9]{1,20})$/;
/** معرّف نوع محدد: «123» أو gid من النوع نفسه. نوع آخر = رفض. */
export function gidOf(type, v, f) {
    const s = String(v ?? '').trim();
    const m = s.match(GID_RE);
    if (m) {
        if (m[1] !== type) bad(f);
        return s;
    }
    if (/^[0-9]{1,20}$/.test(s)) return `gid://shopify/${type}/${s}`;
    return bad(f);
}
const ids = (type, v, f, max) => uniq(list(v, f, { max }, (x, g) => gidOf(type, x, g)), f);
const numId = (gid) => String(gid || '').match(GID_RE)?.[2] || null;
const refOf = (gid) => {
    const m = String(gid || '').match(GID_RE);
    return m ? `${m[1]}/${m[2]}` : null;
};
function tags(v, f) {
    return uniq(list(v, f, { min: 0, max: 50 }, (x, g) => text(x, g, { max: 40, re: /^[^,<>]+$/ })), f);
}
// محتوى HTML من فريق المتجر يُعرض في واجهة المتجر: لا سكربت ولا معالجات أحداث ولا إطارات.
const UNSAFE_HTML = /<\s*\/?\s*(script|iframe|object|embed|style|link|meta|form|input|button|base|svg|math)\b|\bon[a-z]+\s*=|javascript\s*:|vbscript\s*:|data\s*:\s*text\/html/i;
// 10 آلاف حرف: نص عربي بهذا الطول ≈ 20 KB، داخل حد جسم ihub-api (32 KB)
function html(v, f) {
    const t = text(v, f, { min: 0, max: 10000 });
    if (UNSAFE_HTML.test(t)) bad(f);
    return t;
}
const email = (v, f) => text(v, f, { max: 254, re: /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/ }).toLowerCase();
const phone = (v, f) => text(v, f, { max: 16, re: /^\+[1-9][0-9]{6,14}$/ });
const SAFE_LINE = /^[^<>]*$/;
function address(v, f) {
    only(v, ['first_name', 'last_name', 'company', 'address1', 'address2', 'city', 'province_code', 'zip', 'country_code', 'phone'], f);
    const out = {
        address1: text(v.address1, `${f}.address1`, { max: 255, re: SAFE_LINE }),
        city: text(v.city, `${f}.city`, { max: 120, re: SAFE_LINE }),
        countryCode: text(v.country_code, `${f}.country_code`, { min: 2, max: 2, re: /^[A-Z]{2}$/ })
    };
    if (present(v, 'first_name')) out.firstName = text(v.first_name, `${f}.first_name`, { max: 120, re: SAFE_LINE });
    if (present(v, 'last_name')) out.lastName = text(v.last_name, `${f}.last_name`, { max: 120, re: SAFE_LINE });
    if (present(v, 'company')) out.company = text(v.company, `${f}.company`, { max: 255, re: SAFE_LINE });
    if (present(v, 'address2')) out.address2 = text(v.address2, `${f}.address2`, { max: 255, re: SAFE_LINE });
    if (present(v, 'province_code')) out.provinceCode = text(v.province_code, `${f}.province_code`, { max: 10, re: /^[A-Z0-9-]{1,10}$/ });
    if (present(v, 'zip')) out.zip = text(v.zip, `${f}.zip`, { max: 20, re: /^[A-Za-z0-9 -]{1,20}$/ });
    if (present(v, 'phone')) out.phone = phone(v.phone, `${f}.phone`);
    return out;
}
function cursor(v) {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || !/^[A-Za-z0-9+/=_-]{1,500}$/.test(v)) bad('after');
    return v;
}
/** نص بحث: محارف محدودة داخل علامات تنصيص؛ لا مشغّلات من المستخدم. */
function searchTerm(v) {
    if (v === undefined || v === null || v === '') return null;
    const t = text(v, 'query', { max: 80, re: /^[\p{L}\p{N} #@._+'-]+$/u });
    return JSON.stringify(t.replace(/'/g, ''));
}
const atLeastOne = (o, keys) => keys.some((k) => o[k] !== undefined) || bad('input');

/* ── البصمة ────────────────────────────────────────────────────────────── */

export function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort()
            .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}
/** بصمة المدخلات بعد التحقق: التأكيد مربوط بها في القاعدة. */
export const inputHash = (op, v) => sha256Hex(`shopify-admin:v1:${op}:${canonical(v)}`);

/* ── GraphQL ───────────────────────────────────────────────────────────── */

function rejected(errors) {
    const err = new ConnectorError('provider_rejected');
    err.userErrors = errors.slice(0, 10).map((e) => ({
        field: Array.isArray(e?.field) ? (e.field.map(String).filter((x) => /^[A-Za-z0-9_]{1,60}$/.test(x)).slice(0, 6).join('.') || null) : null,
        code: /^[A-Z_]{1,60}$/.test(String(e?.code || '')) ? e.code : null
    }));
    return err;
}

/**
 * طفرة واحدة. حمولة موجودة = نُفّذت (ACCESS_DENIED حينها لحقول محمية في الرد، لا رفض).
 * حمولة null مع ACCESS_DENIED = نطاق ناقص. userErrors غير فارغة = رفض Shopify.
 */
async function mutate(ctx, doc, vars, root, ueKey = 'userErrors') {
    const r = await graphql(ctx, doc, vars);
    const p = r.data?.[root];
    if (!p || typeof p !== 'object') {
        if (r.errorCodes.includes('ACCESS_DENIED')) throw new ConnectorError('forbidden_scope');
        throw new ConnectorError('invalid_response', root);
    }
    const ue = Array.isArray(p[ueKey]) ? p[ueKey] : [];
    if (ue.length) throw rejected(ue);
    return p;
}
async function read(ctx, doc, vars) {
    const r = await graphql(ctx, doc, vars);
    return { data: r.data, restricted: r.restricted };
}

const MONEY = 'shopMoney { amount currencyCode }';
const UE = 'userErrors { field }';
const UEC = 'userErrors { field code }';
const PAGE = 'pageInfo { hasNextPage endCursor }';

function moneyOf(set) {
    const m = set?.shopMoney;
    return { amount: amountText(m?.amount), currency: /^[A-Z]{3}$/.test(String(m?.currencyCode || '')) ? m.currencyCode : null };
}
const enumOf = (v) => (typeof v === 'string' && /^[A-Z_]{1,40}$/.test(v) ? v : null);
const intOf = (v) => (Number.isInteger(v) ? v : null);
const page = (c) => ({ has_next: !!c?.pageInfo?.hasNextPage, cursor: c?.pageInfo?.endCursor || null });
const nodes = (c) => (Array.isArray(c?.nodes) ? c.nodes : []);
const adminUrl = (ctx, path) => `https://admin.shopify.com/store/${shopHandle(ctx.externalAccountId)}/${path}`;

/* ── المخرجات (قوائم سماح) ─────────────────────────────────────────────── */

function mapVariant(v) {
    return {
        id: v?.id, legacy_id: numId(v?.id), title: shortText(v?.title, 80), sku: shortText(v?.sku, 60),
        price: amountText(v?.price), compare_at_price: amountText(v?.compareAtPrice),
        inventory_policy: enumOf(v?.inventoryPolicy), inventory_quantity: intOf(v?.inventoryQuantity),
        taxable: typeof v?.taxable === 'boolean' ? v.taxable : null,
        inventory_item_id: v?.inventoryItem?.id || null, tracked: typeof v?.inventoryItem?.tracked === 'boolean' ? v.inventoryItem.tracked : null,
        options: (Array.isArray(v?.selectedOptions) ? v.selectedOptions : []).slice(0, 3)
            .map((o) => ({ name: shortText(o?.name, 40), value: shortText(o?.value, 60) }))
    };
}
function mapProductRow(p) {
    return {
        id: p?.id, legacy_id: numId(p?.id), title: shortText(p?.title, 120), status: enumOf(p?.status),
        vendor: shortText(p?.vendor, 80), product_type: shortText(p?.productType, 80),
        total_inventory: intOf(p?.totalInventory), variants_count: intOf(p?.variantsCount?.count),
        updated_at: isoUtc(p?.updatedAt, { assumeUtc: false })
    };
}
function mapOrderRow(o) {
    return {
        id: o?.id, legacy_id: numId(o?.id), name: shortText(o?.name, 40),
        created_at: isoUtc(o?.createdAt, { assumeUtc: false }), cancelled_at: isoUtc(o?.cancelledAt, { assumeUtc: false }),
        closed: o?.closed === true, test: o?.test === true,
        financial_status: enumOf(o?.displayFinancialStatus), fulfillment_status: enumOf(o?.displayFulfillmentStatus),
        fully_paid: o?.fullyPaid === true, total: moneyOf(o?.totalPriceSet),
        customer_name: shortText(o?.customer?.displayName, 80)
    };
}
/**
 * الدفع كما يقوله Shopify حرفيًا. paid_confirmed صحيح فقط إن قال Shopify PAID و fullyPaid معًا —
 * الواجهة لا تكتب «مدفوع» بغير ذلك.
 */
export function paymentState(o) {
    const status = enumOf(o?.displayFinancialStatus);
    return {
        financial_status: status,
        fully_paid: o?.fullyPaid === true,
        paid_confirmed: status === 'PAID' && o?.fullyPaid === true,
        received: moneyOf(o?.totalReceivedSet), outstanding: moneyOf(o?.totalOutstandingSet),
        refunded: moneyOf(o?.totalRefundedSet), capturable: o?.capturable === true
    };
}
function mapCustomerRow(c) {
    return {
        id: c?.id, legacy_id: numId(c?.id), name: shortText(c?.displayName, 80),
        email_masked: maskEmail(c?.defaultEmailAddress?.emailAddress),
        orders_count: /^[0-9]{1,12}$/.test(String(c?.numberOfOrders ?? '')) ? Number(c.numberOfOrders) : null,
        updated_at: isoUtc(c?.updatedAt, { assumeUtc: false })
    };
}
function mapDiscount(type, node) {
    const d = (type === 'code' ? node?.codeDiscount : node?.automaticDiscount) || {};
    return {
        id: node?.id, type, kind: shortText(d.__typename, 40), title: shortText(d.title, 255), status: enumOf(d.status),
        starts_at: isoUtc(d.startsAt, { assumeUtc: false }), ends_at: isoUtc(d.endsAt, { assumeUtc: false }),
        summary: shortText(d.summary, 300), usage_limit: intOf(d.usageLimit), used: intOf(d.asyncUsageCount),
        once_per_customer: typeof d.appliesOncePerCustomer === 'boolean' ? d.appliesOncePerCustomer : null,
        code: shortText(d.codes?.nodes?.[0]?.code, 60)
    };
}

/* ── وثائق الاستعلام ───────────────────────────────────────────────────── */

const D = Object.freeze({
    shop: `query { shop { id name myshopifyDomain currencyCode ianaTimezone weightUnit
      plan { partnerDevelopment shopifyPlus publicDisplayName } primaryDomain { url } } }`,
    locations: `query ($inactive: Boolean) { locations(first: 50, includeInactive: $inactive) {
      nodes { id name isActive fulfillsOnlineOrders address { city countryCode } } } }`,
    products: `query ($first: Int!, $after: String, $query: String) {
      products(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) { ${PAGE}
        nodes { id title status vendor productType totalInventory updatedAt variantsCount { count } } } }`,
    product: `query ($id: ID!) { shop { currencyCode } product(id: $id) {
      id title handle status vendor productType tags descriptionHtml updatedAt onlineStoreUrl totalInventory
      options { id name optionValues { id name } }
      variants(first: 100) { nodes { id title sku price compareAtPrice inventoryPolicy inventoryQuantity taxable
        selectedOptions { name value } inventoryItem { id tracked } } }
      collections(first: 20) { nodes { id title } }
      metafields(first: 20) { nodes { id namespace key type value } } } }`,
    collections: `query ($first: Int!, $after: String, $query: String) {
      collections(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) { ${PAGE}
        nodes { id title handle sortOrder updatedAt productsCount { count } } } }`,
    collection: `query ($id: ID!) { collection(id: $id) { id title handle descriptionHtml sortOrder updatedAt
      productsCount { count } products(first: 50) { nodes { id title status } } } }`,
    publications: `query { publications(first: 20) { nodes { id catalog { title } } } }`,
    productPublished: `query ($id: ID!) { product(id: $id) { id resourcePublicationsV2(first: 20) { nodes { isPublished publication { id } } } } }`,
    orders: `query ($first: Int!, $after: String, $query: String) {
      orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) { ${PAGE}
        nodes { id name createdAt cancelledAt closed test displayFinancialStatus displayFulfillmentStatus fullyPaid
          totalPriceSet { ${MONEY} } customer { displayName } } } }`,
    order: `query ($id: ID!) { order(id: $id) {
      id name createdAt updatedAt processedAt cancelledAt cancelReason closed test confirmed
      displayFinancialStatus displayFulfillmentStatus returnStatus fullyPaid unpaid capturable
      totalPriceSet { ${MONEY} } totalReceivedSet { ${MONEY} } totalOutstandingSet { ${MONEY} } totalRefundedSet { ${MONEY} }
      note tags email phone customer { id displayName }
      shippingAddress { firstName lastName company address1 address2 city provinceCode zip countryCodeV2 phone }
      lineItems(first: 50) { nodes { id title variantTitle sku quantity currentQuantity variant { id }
        originalUnitPriceSet { ${MONEY} } } } } }`,
    customers: `query ($first: Int!, $after: String, $query: String) {
      customers(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) { ${PAGE}
        nodes { id displayName updatedAt numberOfOrders defaultEmailAddress { emailAddress } } } }`,
    customer: `query ($id: ID!) { customer(id: $id) { id displayName firstName lastName note tags createdAt updatedAt
      numberOfOrders amountSpent { amount currencyCode }
      defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } } }`,
    draftOrders: `query ($first: Int!, $after: String, $query: String) {
      draftOrders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) { ${PAGE}
        nodes { id name status createdAt updatedAt totalPriceSet { ${MONEY} } customer { displayName } } } }`,
    draftOrder: `query ($id: ID!) { draftOrder(id: $id) { id name status createdAt updatedAt note2 email tags
      customer { id displayName } appliedDiscount { title value valueType }
      totalPriceSet { ${MONEY} } subtotalPriceSet { ${MONEY} } order { id name }
      lineItems(first: 50) { nodes { id title variantTitle sku quantity variant { id } originalUnitPriceSet { ${MONEY} } } } } }`,
    variantInventory: `query ($id: ID!) { productVariant(id: $id) { id title sku product { id title }
      inventoryItem { id tracked inventoryLevels(first: 50) { nodes { id location { id name isActive }
        quantities(names: ["available", "on_hand", "committed", "incoming"]) { name quantity } } } } } }`,
    inventoryItems: `query ($ids: [ID!]!) { nodes(ids: $ids) { ... on InventoryItem { id tracked
      inventoryLevels(first: 50) { nodes { location { id name isActive } quantities(names: ["available", "on_hand"]) { name quantity } } } } } }`,
    location: `query ($id: ID!) { location(id: $id) { id name isActive } }`,
    codeDiscounts: `query ($first: Int!, $after: String, $query: String) {
      codeDiscountNodes(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) { ${PAGE}
        nodes { id codeDiscount { __typename ... on DiscountCodeBasic { title status startsAt endsAt summary usageLimit
          asyncUsageCount appliesOncePerCustomer codes(first: 1) { nodes { code } } } } } } }`,
    automaticDiscounts: `query ($first: Int!, $after: String, $query: String) {
      automaticDiscountNodes(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) { ${PAGE}
        nodes { id automaticDiscount { __typename ... on DiscountAutomaticBasic { title status startsAt endsAt summary } } } } }`,
    codeDiscount: `query ($id: ID!) { codeDiscountNode(id: $id) { id codeDiscount { __typename ... on DiscountCodeBasic {
      title status startsAt endsAt summary usageLimit asyncUsageCount appliesOncePerCustomer codes(first: 1) { nodes { code } } } } } }`,
    automaticDiscount: `query ($id: ID!) { automaticDiscountNode(id: $id) { id automaticDiscount { __typename ... on DiscountAutomaticBasic {
      title status startsAt endsAt summary } } } }`,
    fulfillmentOrders: `query ($id: ID!) { order(id: $id) { id name displayFulfillmentStatus cancelledAt
      fulfillmentOrders(first: 20) { nodes { id status requestStatus
        assignedLocation { name location { id } } supportedActions { action }
        lineItems(first: 50) { nodes { id totalQuantity remainingQuantity productTitle variantTitle sku } } } }
      fulfillments(first: 10) { id status displayStatus createdAt trackingInfo(first: 3) { company number url } } } }`,
    fulfillment: `query ($id: ID!) { fulfillment(id: $id) { id status order { id } } }`,
    returns: `query ($id: ID!) { order(id: $id) { id name returnStatus
      returns(first: 20) { nodes { id name status totalQuantity createdAt closedAt } } } }`,
    returnOne: `query ($id: ID!) { return(id: $id) { id name status order { id } } }`,
    returnable: `query ($id: ID!) { returnableFulfillments(orderId: $id, first: 10) { nodes { id fulfillment { id }
      returnableFulfillmentLineItems(first: 50) { nodes { quantity fulfillmentLineItem { id lineItem { title sku } } } } } } }`,
    variantsForOrder: `query ($ids: [ID!]!) { shop { currencyCode } nodes(ids: $ids) { ... on ProductVariant { id title sku price
      availableForSale product { id title status } } } }`,
    variantsOfProduct: `query ($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id title price compareAtPrice product { id } } } }`,
    orderForCancel: `query ($id: ID!) { order(id: $id) { id name cancelledAt closed displayFinancialStatus displayFulfillmentStatus
      fullyPaid capturable totalReceivedSet { ${MONEY} } totalPriceSet { ${MONEY} } } }`
});

/* ── مساعدات القراءة للتحقق على الخادم ─────────────────────────────────── */

async function shopifyNode(ctx, doc, id, root) {
    const r = await read(ctx, doc, { id });
    const n = r.data?.[root];
    if (!n) throw new ConnectorError('not_found');
    return n;
}
function notEligible(reason) {
    const err = new ConnectorError('not_eligible');
    err.reason = reason;
    return err;
}
async function publicationIds(ctx) {
    const r = await read(ctx, D.publications, {});
    return nodes(r.data?.publications).map((p) => ({ id: p?.id, title: shortText(p?.catalog?.title, 80) })).filter((p) => GID_RE.test(String(p.id)));
}
/** مستويات المخزون الحالية لكل (صنف، موقع) — يرفض موقعًا غير مربوط بالصنف أو غير نشط. */
async function currentLevels(ctx, pairs, name) {
    const itemIds = [...new Set(pairs.map((p) => p.inventoryItemId))];
    const r = await read(ctx, D.inventoryItems, { ids: itemIds });
    const byItem = new Map(nodes({ nodes: r.data?.nodes }).filter(Boolean).map((n) => [n.id, n]));
    return pairs.map((p, i) => {
        const item = byItem.get(p.inventoryItemId);
        if (!item) throw notEligible(`changes.${i}.inventory_item_id`);
        const level = nodes(item.inventoryLevels).find((l) => l?.location?.id === p.locationId);
        if (!level) throw notEligible(`changes.${i}.location_id`);
        if (level.location.isActive === false) throw notEligible(`changes.${i}.location_inactive`);
        const q = (Array.isArray(level.quantities) ? level.quantities : []).find((x) => x?.name === name);
        return { ...p, location_name: shortText(level.location.name, 80), current: intOf(q?.quantity), tracked: item.tracked !== false };
    });
}

/* ── خصومات ────────────────────────────────────────────────────────────── */

function discountValue(v, f) {
    only(v, ['type', 'amount', 'each_item'], f);
    const type = oneOf(v.type, `${f}.type`, ['percentage', 'fixed_amount']);
    if (type === 'percentage') {
        const p = Number(money(v.amount, `${f}.amount`, { max: 100, positive: true }));
        if (present(v, 'each_item')) bad(`${f}.each_item`);
        return { percentage: Math.round(p * 100) / 10000 };       // 0..1 كما يطلب Shopify
    }
    return { discountAmount: { amount: money(v.amount, `${f}.amount`, { max: 10_000_000, positive: true }),
                               appliesOnEachItem: present(v, 'each_item') ? bool(v.each_item, `${f}.each_item`) : false } };
}
function discountItems(v, f, { update = false } = {}) {
    only(v, ['all', 'product_ids', 'collection_ids'], f);
    const keys = ['all', 'product_ids', 'collection_ids'].filter((k) => present(v, k));
    if (keys.length !== 1) bad(f);
    if (keys[0] === 'all') {
        if (v.all !== true) bad(`${f}.all`);
        return { all: true };
    }
    // تعديل نطاق المنتجات/المجموعات يحتاج إضافة وحذفًا مقارنًا بالحالي — غير مدعوم في التعديل (أنشئ خصمًا جديدًا)
    if (update) bad(f);
    if (keys[0] === 'product_ids') return { products: { productsToAdd: ids('Product', v.product_ids, `${f}.product_ids`, 100) } };
    return { collections: { add: ids('Collection', v.collection_ids, `${f}.collection_ids`, 100) } };
}
function discountMinimum(v, f) {
    only(v, ['subtotal', 'quantity'], f);
    const keys = ['subtotal', 'quantity'].filter((k) => present(v, k));
    if (keys.length !== 1) bad(f);
    if (keys[0] === 'subtotal') return { subtotal: { greaterThanOrEqualToSubtotal: money(v.subtotal, `${f}.subtotal`, { max: 10_000_000, positive: true }) } };
    return { quantity: { greaterThanOrEqualToQuantity: String(integer(v.quantity, `${f}.quantity`, 1, 1_000_000)) } };
}
function combines(v, f) {
    only(v, ['order', 'product', 'shipping'], f);
    const out = {};
    if (present(v, 'order')) out.orderDiscounts = bool(v.order, `${f}.order`);
    if (present(v, 'product')) out.productDiscounts = bool(v.product, `${f}.product`);
    if (present(v, 'shipping')) out.shippingDiscounts = bool(v.shipping, `${f}.shipping`);
    return out;
}
const DISCOUNT_COMMON = ['title', 'starts_at', 'ends_at', 'value', 'items', 'minimum', 'combines_with'];
/** نافذة الخصم: البداية ليست قبل سنة، النهاية بعد البداية وفي المستقبل ولا تتجاوز 5 سنوات. */
function discountWindow(o, v, nowMs, { update }) {
    if (present(v, 'starts_at')) {
        o.startsAt = isoDate(v.starts_at, 'starts_at');
        if (Date.parse(o.startsAt) < nowMs - 366 * 864e5) bad('starts_at');
    } else if (!update) bad('starts_at');
    if (present(v, 'ends_at')) {
        o.endsAt = isoDate(v.ends_at, 'ends_at');
        if (Date.parse(o.endsAt) <= nowMs || Date.parse(o.endsAt) > nowMs + 5 * 366 * 864e5) bad('ends_at');
        if (o.startsAt && Date.parse(o.endsAt) <= Date.parse(o.startsAt)) bad('ends_at');
    }
}
function discountInput(v, kind, nowMs, { update }) {
    const allowed = [...DISCOUNT_COMMON, ...(kind === 'code' ? ['code', 'usage_limit', 'once_per_customer'] : []), ...(update ? ['id'] : [])];
    only(v, allowed);
    const o = {};
    if (present(v, 'title') || !update) o.title = text(v.title, 'title', { max: 255, re: SAFE_LINE });
    discountWindow(o, v, nowMs, { update });
    if (kind === 'code') {
        if (present(v, 'code') || !update) o.code = text(v.code, 'code', { min: 3, max: 40, re: /^[A-Za-z0-9_-]+$/ }).toUpperCase();
        if (present(v, 'usage_limit')) o.usageLimit = integer(v.usage_limit, 'usage_limit', 1, 10_000_000);
        if (present(v, 'once_per_customer')) o.appliesOncePerCustomer = bool(v.once_per_customer, 'once_per_customer');
    }
    if (present(v, 'value') || present(v, 'items') || !update) {
        // customerGets كاملًا: القيمة والعناصر معًا
        o.customerGets = { value: discountValue(obj(v.value, 'value'), 'value'), items: discountItems(obj(v.items, 'items'), 'items', { update }) };
    }
    if (present(v, 'minimum')) o.minimumRequirement = discountMinimum(v.minimum, 'minimum');
    if (present(v, 'combines_with')) o.combinesWith = combines(v.combines_with, 'combines_with');
    if (!update) o.context = { all: 'ALL' };                     // كل المشترين؛ شرائح العملاء غير مدعومة بعد
    if (update && Object.keys(o).length === 0) bad('input');
    return o;
}
const DISCOUNT_REF = (v) => {
    only(v, ['type', 'id']);
    const type = oneOf(v.type, 'type', ['code', 'automatic']);
    return { type, id: gidOf(type === 'code' ? 'DiscountCodeNode' : 'DiscountAutomaticNode', v.id, 'id') };
};

/* ── المتغيرات ─────────────────────────────────────────────────────────── */

function variantFields(v, f, { create }) {
    const allowed = ['price', 'compare_at_price', 'sku', 'tracked', 'inventory_policy', 'taxable', ...(create ? ['options'] : ['id'])];
    only(v, allowed, f);
    const out = {};
    if (create) {
        out.optionValues = list(v.options, `${f}.options`, { max: 3 }, (o, g) => {
            only(o, ['name', 'value'], g);
            return { optionName: text(o.name, `${g}.name`, { max: 255, re: SAFE_LINE }), name: text(o.value, `${g}.value`, { max: 255, re: SAFE_LINE }) };
        });
        uniq(out.optionValues.map((o) => o.optionName.toLowerCase()), `${f}.options`);
        out.price = money(v.price, `${f}.price`);
    } else {
        out.id = gidOf('ProductVariant', v.id, `${f}.id`);
        if (present(v, 'price')) out.price = money(v.price, `${f}.price`);
    }
    if (Object.prototype.hasOwnProperty.call(v, 'compare_at_price')) {
        out.compareAtPrice = v.compare_at_price === null ? null : money(v.compare_at_price, `${f}.compare_at_price`);
        if (out.compareAtPrice !== null && out.price !== undefined && Number(out.compareAtPrice) <= Number(out.price)) bad(`${f}.compare_at_price`);
    }
    if (present(v, 'inventory_policy')) out.inventoryPolicy = oneOf(v.inventory_policy, `${f}.inventory_policy`, ['DENY', 'CONTINUE']);
    if (present(v, 'taxable')) out.taxable = bool(v.taxable, `${f}.taxable`);
    const item = {};
    if (present(v, 'sku')) item.sku = text(v.sku, `${f}.sku`, { max: 100, re: /^[^\s<>][^<>]*$/ });
    if (present(v, 'tracked')) item.tracked = bool(v.tracked, `${f}.tracked`);
    if (Object.keys(item).length) out.inventoryItem = item;
    if (!create && Object.keys(out).length === 1) bad(`${f}`);
    return out;
}

const METAFIELD_TYPES = Object.freeze({
    single_line_text_field: (s) => s.length <= 255 && !/[\r\n]/.test(s),
    multi_line_text_field: (s) => s.length <= 5000,
    number_integer: (s) => /^-?[0-9]{1,15}$/.test(s),
    number_decimal: (s) => /^-?[0-9]{1,15}(\.[0-9]{1,9})?$/.test(s),
    boolean: (s) => s === 'true' || s === 'false',
    url: (s) => /^https:\/\/[^\s<>"]{3,2000}$/.test(s),
    date: (s) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s) && Number.isFinite(Date.parse(s))
});

/* ── الطلبات والمسودات ─────────────────────────────────────────────────── */

function orderLines(v, f) {
    const out = list(v, f, { max: 50 }, (l, g) => {
        only(l, ['variant_id', 'quantity'], g);
        return { variantId: gidOf('ProductVariant', l.variant_id, `${g}.variant_id`), quantity: integer(l.quantity, `${g}.quantity`, 1, 10_000) };
    });
    uniq(out.map((l) => l.variantId), f);
    return out;
}
/** خصم المسودة: نسبة 0–100 فقط (مبلغ ثابت يحتاج مجموعًا من Shopify؛ لاحقًا). */
function draftDiscount(v, f) {
    only(v, ['percent', 'title'], f);
    return { valueType: 'PERCENTAGE', value: Number(money(v.percent, `${f}.percent`, { max: 100, positive: true })),
             title: present(v, 'title') ? text(v.title, `${f}.title`, { max: 255, re: SAFE_LINE }) : 'Discount' };
}
function draftInput(v, { update }) {
    only(v, [...(update ? ['id'] : []), 'lines', 'customer_id', 'email', 'note', 'tags', 'shipping_address', 'discount']);
    const o = {};
    if (present(v, 'lines') || !update) o.lineItems = orderLines(v.lines, 'lines');
    if (present(v, 'customer_id')) o.purchasingEntity = { customerId: gidOf('Customer', v.customer_id, 'customer_id') };
    if (present(v, 'email')) o.email = email(v.email, 'email');
    if (present(v, 'note')) o.note = text(v.note, 'note', { min: 0, max: 5000 });
    if (present(v, 'tags')) o.tags = tags(v.tags, 'tags');
    if (present(v, 'shipping_address')) o.shippingAddress = address(v.shipping_address, 'shipping_address');
    if (present(v, 'discount')) o.appliedDiscount = draftDiscount(v.discount, 'discount');
    if (update && Object.keys(o).length === 0) bad('input');
    return o;
}

/* ── كتالوج العمليات ───────────────────────────────────────────────────────
 * risk/confirm/perm/scopes نسخة من _ihub_shopify_op_catalog() في 120 (القاعدة هي الحَكَم؛ اختبار يطابقهما).
 * check(ctx, v): قراءة Shopify قبل التأكيد وقبل التنفيذ — ترجع ملخصًا للتأكيد أو ترمي not_eligible.
 * run(ctx, v, meta): يرجع { result, resource?, status?, detail? }.
 * ========================================================================= */

const R = (perm, scopes) => ({ risk: 'read', confirm: false, perm, scopes });
const W = (perm, scopes, confirm = false) => ({ risk: 'write', confirm, perm, scopes });
const X = (perm, scopes) => ({ risk: 'destructive', confirm: true, perm, scopes });

export const OPERATIONS = Object.freeze({
    /* ── قراءة ── */
    'shop.info': {
        ...R('store.orders', []),
        validate: (v) => (only(v, []), {}),
        async run(ctx) {
            const s = (await read(ctx, D.shop, {})).data?.shop || {};
            return { result: {
                name: shortText(s.name, 120), domain: shortText(s.myshopifyDomain, 120),
                currency: /^[A-Z]{3}$/.test(String(s.currencyCode || '')) ? s.currencyCode : null,
                timezone: shortText(s.ianaTimezone, 60), weight_unit: enumOf(s.weightUnit),
                development_store: s.plan?.partnerDevelopment === true, plus: s.plan?.shopifyPlus === true,
                plan: shortText(s.plan?.publicDisplayName, 60),
                primary_domain: /^https:\/\/[^\s"<>]{3,200}$/.test(String(s.primaryDomain?.url || '')) ? s.primaryDomain.url : null
            } };
        }
    },
    'location.list': {
        ...R('store.inventory', ['read_locations']),
        validate: (v) => (only(v, ['include_inactive']), { include_inactive: present(v, 'include_inactive') ? bool(v.include_inactive, 'include_inactive') : false }),
        async run(ctx, v) {
            const r = await read(ctx, D.locations, { inactive: v.include_inactive });
            return { result: { items: nodes(r.data?.locations).map((l) => ({
                id: l?.id, name: shortText(l?.name, 80), active: l?.isActive === true, online_orders: l?.fulfillsOnlineOrders === true,
                city: shortText(l?.address?.city, 60), country: /^[A-Z]{2}$/.test(String(l?.address?.countryCode || '')) ? l.address.countryCode : null
            })) } };
        }
    },
    'product.list': {
        ...R('store.catalog', ['read_products']),
        validate(v) {
            only(v, ['query', 'status', 'after']);
            return { query: searchTerm(v.query), status: present(v, 'status') ? oneOf(v.status, 'status', ['ACTIVE', 'DRAFT', 'ARCHIVED']) : null, after: cursor(v.after) };
        },
        async run(ctx, v) {
            const q = [v.query && `title:${v.query}`, v.status && `status:${v.status.toLowerCase()}`].filter(Boolean).join(' AND ') || null;
            const r = await read(ctx, D.products, { first: 20, after: v.after, query: q });
            return { result: { items: nodes(r.data?.products).map(mapProductRow), page: page(r.data?.products) } };
        }
    },
    'product.get': {
        ...R('store.catalog', ['read_products']),
        validate: (v) => (only(v, ['id']), { id: gidOf('Product', v.id, 'id') }),
        async run(ctx, v) {
            const r = await read(ctx, D.product, { id: v.id });
            const p = r.data?.product;
            if (!p) throw new ConnectorError('not_found');
            return { result: {
                ...mapProductRow(p), handle: shortText(p.handle, 255), tags: (Array.isArray(p.tags) ? p.tags : []).slice(0, 50).map((t) => shortText(t, 40)),
                description_html: typeof p.descriptionHtml === 'string' ? p.descriptionHtml.slice(0, 20000) : null,
                currency: /^[A-Z]{3}$/.test(String(r.data?.shop?.currencyCode || '')) ? r.data.shop.currencyCode : null,
                options: (Array.isArray(p.options) ? p.options : []).slice(0, 3).map((o) => ({
                    id: o?.id, name: shortText(o?.name, 255), values: (Array.isArray(o?.optionValues) ? o.optionValues : []).slice(0, 100).map((x) => shortText(x?.name, 255))
                })),
                variants: nodes(p.variants).map(mapVariant),
                collections: nodes(p.collections).map((c) => ({ id: c?.id, title: shortText(c?.title, 255) })),
                metafields: nodes(p.metafields).map((m) => ({
                    id: m?.id, namespace: shortText(m?.namespace, 255), key: shortText(m?.key, 64), type: shortText(m?.type, 60),
                    value: typeof m?.value === 'string' ? m.value.slice(0, 2000) : null
                })),
                admin_url: adminUrl(ctx, `products/${numId(p.id)}`)
            } };
        }
    },
    'collection.list': {
        ...R('store.catalog', ['read_products']),
        validate: (v) => (only(v, ['query', 'after']), { query: searchTerm(v.query), after: cursor(v.after) }),
        async run(ctx, v) {
            const r = await read(ctx, D.collections, { first: 20, after: v.after, query: v.query ? `title:${v.query}` : null });
            return { result: { items: nodes(r.data?.collections).map((c) => ({
                id: c?.id, title: shortText(c?.title, 255), handle: shortText(c?.handle, 255), sort_order: enumOf(c?.sortOrder),
                products_count: intOf(c?.productsCount?.count), updated_at: isoUtc(c?.updatedAt, { assumeUtc: false })
            })), page: page(r.data?.collections) } };
        }
    },
    'collection.get': {
        ...R('store.catalog', ['read_products']),
        validate: (v) => (only(v, ['id']), { id: gidOf('Collection', v.id, 'id') }),
        async run(ctx, v) {
            const c = await shopifyNode(ctx, D.collection, v.id, 'collection');
            return { result: {
                id: c.id, title: shortText(c.title, 255), handle: shortText(c.handle, 255), sort_order: enumOf(c.sortOrder),
                description_html: typeof c.descriptionHtml === 'string' ? c.descriptionHtml.slice(0, 20000) : null,
                products_count: intOf(c.productsCount?.count),
                products: nodes(c.products).map((p) => ({ id: p?.id, title: shortText(p?.title, 120), status: enumOf(p?.status) }))
            } };
        }
    },
    'publication.list': {
        ...R('store.catalog', ['read_publications']),
        validate: (v) => (only(v, ['product_id']), { product_id: present(v, 'product_id') ? gidOf('Product', v.product_id, 'product_id') : null }),
        async run(ctx, v) {
            const pubs = await publicationIds(ctx);
            let published = null;
            if (v.product_id) {
                const p = await shopifyNode(ctx, D.productPublished, v.product_id, 'product');
                published = new Set(nodes(p.resourcePublicationsV2).filter((x) => x?.isPublished).map((x) => x?.publication?.id));
            }
            return { result: { items: pubs.map((p) => ({ ...p, published: published ? published.has(p.id) : null })) } };
        }
    },
    'order.list': {
        ...R('store.orders', ['read_orders']),
        validate(v) {
            only(v, ['query', 'financial_status', 'fulfillment_status', 'status', 'after']);
            return {
                query: searchTerm(v.query),
                financial_status: present(v, 'financial_status') ? oneOf(v.financial_status, 'financial_status',
                    ['authorized', 'pending', 'paid', 'partially_paid', 'refunded', 'partially_refunded', 'voided', 'expired']) : null,
                fulfillment_status: present(v, 'fulfillment_status') ? oneOf(v.fulfillment_status, 'fulfillment_status',
                    ['unshipped', 'shipped', 'partial', 'unfulfilled', 'fulfilled']) : null,
                status: present(v, 'status') ? oneOf(v.status, 'status', ['open', 'closed', 'cancelled']) : null,
                after: cursor(v.after)
            };
        },
        async run(ctx, v) {
            const term = v.query && (/@/.test(v.query) ? `email:${v.query}` : `name:${v.query}`);
            const q = [term, v.financial_status && `financial_status:${v.financial_status}`,
                       v.fulfillment_status && `fulfillment_status:${v.fulfillment_status}`, v.status && `status:${v.status}`].filter(Boolean).join(' AND ') || null;
            const r = await read(ctx, D.orders, { first: 20, after: v.after, query: q });
            return { result: { items: nodes(r.data?.orders).map(mapOrderRow), page: page(r.data?.orders), restricted: r.restricted } };
        }
    },
    'order.get': {
        ...R('store.orders', ['read_orders']),
        validate: (v) => (only(v, ['id']), { id: gidOf('Order', v.id, 'id') }),
        async run(ctx, v) {
            const r = await read(ctx, D.order, { id: v.id });
            const o = r.data?.order;
            if (!o) throw new ConnectorError('not_found');
            const a = o.shippingAddress;
            return { result: {
                ...mapOrderRow(o), payment: paymentState(o), cancel_reason: enumOf(o.cancelReason), return_status: enumOf(o.returnStatus),
                note: typeof o.note === 'string' ? o.note.slice(0, 5000) : null, tags: (Array.isArray(o.tags) ? o.tags : []).slice(0, 50).map((t) => shortText(t, 40)),
                email: shortText(o.email, 254), phone: shortText(o.phone, 20),
                customer_id: o.customer?.id || null,
                shipping_address: a ? {
                    first_name: shortText(a.firstName, 120), last_name: shortText(a.lastName, 120), company: shortText(a.company, 255),
                    address1: shortText(a.address1, 255), address2: shortText(a.address2, 255), city: shortText(a.city, 120),
                    province_code: shortText(a.provinceCode, 10), zip: shortText(a.zip, 20),
                    country_code: /^[A-Z]{2}$/.test(String(a.countryCodeV2 || '')) ? a.countryCodeV2 : null, phone: shortText(a.phone, 20)
                } : null,
                lines: nodes(o.lineItems).map((l) => ({
                    id: l?.id, title: shortText(l?.title, 120), variant_title: shortText(l?.variantTitle, 80), sku: shortText(l?.sku, 60),
                    quantity: intOf(l?.quantity), current_quantity: intOf(l?.currentQuantity), variant_id: l?.variant?.id || null,
                    unit_price: moneyOf(l?.originalUnitPriceSet).amount
                })),
                restricted: r.restricted, admin_url: adminUrl(ctx, `orders/${numId(o.id)}`)
            } };
        }
    },
    'customer.list': {
        ...R('store.orders', ['read_customers']),
        validate: (v) => (only(v, ['query', 'after']), { query: searchTerm(v.query), after: cursor(v.after) }),
        async run(ctx, v) {
            const q = v.query ? (/@/.test(v.query) ? `email:${v.query}` : v.query) : null;
            const r = await read(ctx, D.customers, { first: 20, after: v.after, query: q });
            return { result: { items: nodes(r.data?.customers).map(mapCustomerRow), page: page(r.data?.customers), restricted: r.restricted } };
        }
    },
    'customer.get': {
        ...R('store.orders', ['read_customers']),
        validate: (v) => (only(v, ['id']), { id: gidOf('Customer', v.id, 'id') }),
        async run(ctx, v) {
            const r = await read(ctx, D.customer, { id: v.id });
            const c = r.data?.customer;
            if (!c) throw new ConnectorError('not_found');
            return { result: {
                ...mapCustomerRow(c), first_name: shortText(c.firstName, 120), last_name: shortText(c.lastName, 120),
                email: shortText(c.defaultEmailAddress?.emailAddress, 254), phone: shortText(c.defaultPhoneNumber?.phoneNumber, 20),
                note: typeof c.note === 'string' ? c.note.slice(0, 5000) : null,
                tags: (Array.isArray(c.tags) ? c.tags : []).slice(0, 50).map((t) => shortText(t, 40)),
                amount_spent: amountText(c.amountSpent?.amount), currency: /^[A-Z]{3}$/.test(String(c.amountSpent?.currencyCode || '')) ? c.amountSpent.currencyCode : null,
                created_at: isoUtc(c.createdAt, { assumeUtc: false }), restricted: r.restricted,
                admin_url: adminUrl(ctx, `customers/${numId(c.id)}`)
            } };
        }
    },
    'customer.orders': {
        ...R('store.orders', ['read_orders']),
        validate: (v) => (only(v, ['id', 'after']), { id: gidOf('Customer', v.id, 'id'), after: cursor(v.after) }),
        async run(ctx, v) {
            const r = await read(ctx, D.orders, { first: 20, after: v.after, query: `customer_id:${numId(v.id)}` });
            return { result: { items: nodes(r.data?.orders).map(mapOrderRow), page: page(r.data?.orders), restricted: r.restricted } };
        }
    },
    'draft_order.list': {
        ...R('store.orders_manage', ['read_draft_orders']),
        validate(v) {
            only(v, ['query', 'status', 'after']);
            return { query: searchTerm(v.query), status: present(v, 'status') ? oneOf(v.status, 'status', ['open', 'invoice_sent', 'completed']) : null, after: cursor(v.after) };
        },
        async run(ctx, v) {
            const q = [v.query && `name:${v.query}`, v.status && `status:${v.status}`].filter(Boolean).join(' AND ') || null;
            const r = await read(ctx, D.draftOrders, { first: 20, after: v.after, query: q });
            return { result: { items: nodes(r.data?.draftOrders).map((d) => ({
                id: d?.id, name: shortText(d?.name, 40), status: enumOf(d?.status), total: moneyOf(d?.totalPriceSet),
                customer_name: shortText(d?.customer?.displayName, 80), updated_at: isoUtc(d?.updatedAt, { assumeUtc: false })
            })), page: page(r.data?.draftOrders), restricted: r.restricted } };
        }
    },
    'draft_order.get': {
        ...R('store.orders_manage', ['read_draft_orders']),
        validate: (v) => (only(v, ['id']), { id: gidOf('DraftOrder', v.id, 'id') }),
        async run(ctx, v) {
            const r = await read(ctx, D.draftOrder, { id: v.id });
            const d = r.data?.draftOrder;
            if (!d) throw new ConnectorError('not_found');
            return { result: {
                id: d.id, name: shortText(d.name, 40), status: enumOf(d.status), note: typeof d.note2 === 'string' ? d.note2.slice(0, 5000) : null,
                email: shortText(d.email, 254), tags: (Array.isArray(d.tags) ? d.tags : []).slice(0, 50).map((t) => shortText(t, 40)),
                customer_id: d.customer?.id || null, customer_name: shortText(d.customer?.displayName, 80),
                discount: d.appliedDiscount ? { title: shortText(d.appliedDiscount.title, 255), value: Number(d.appliedDiscount.value) || null, type: enumOf(d.appliedDiscount.valueType) } : null,
                subtotal: moneyOf(d.subtotalPriceSet), total: moneyOf(d.totalPriceSet),
                order: d.order ? { id: d.order.id, name: shortText(d.order.name, 40) } : null,
                lines: nodes(d.lineItems).map((l) => ({
                    id: l?.id, title: shortText(l?.title, 120), variant_title: shortText(l?.variantTitle, 80), sku: shortText(l?.sku, 60),
                    quantity: intOf(l?.quantity), variant_id: l?.variant?.id || null, unit_price: moneyOf(l?.originalUnitPriceSet).amount
                })),
                restricted: r.restricted
            } };
        }
    },
    'inventory.levels': {
        ...R('store.inventory', ['read_inventory', 'read_locations']),
        validate: (v) => (only(v, ['variant_id']), { variant_id: gidOf('ProductVariant', v.variant_id, 'variant_id') }),
        async run(ctx, v) {
            const pv = await shopifyNode(ctx, D.variantInventory, v.variant_id, 'productVariant');
            return { result: {
                variant_id: pv.id, title: shortText(pv.title, 80), sku: shortText(pv.sku, 60), product_title: shortText(pv.product?.title, 120),
                inventory_item_id: pv.inventoryItem?.id || null, tracked: pv.inventoryItem?.tracked === true,
                levels: nodes(pv.inventoryItem?.inventoryLevels).map((l) => ({
                    location_id: l?.location?.id, location_name: shortText(l?.location?.name, 80), active: l?.location?.isActive === true,
                    quantities: Object.fromEntries((Array.isArray(l?.quantities) ? l.quantities : [])
                        .filter((q) => ['available', 'on_hand', 'committed', 'incoming'].includes(q?.name) && Number.isInteger(q?.quantity))
                        .map((q) => [q.name, q.quantity]))
                }))
            } };
        }
    },
    'discount.list': {
        ...R('store.discounts', ['read_discounts']),
        validate(v) {
            only(v, ['type', 'query', 'after']);
            return { type: oneOf(v.type, 'type', ['code', 'automatic']), query: searchTerm(v.query), after: cursor(v.after) };
        },
        async run(ctx, v) {
            const doc = v.type === 'code' ? D.codeDiscounts : D.automaticDiscounts;
            const root = v.type === 'code' ? 'codeDiscountNodes' : 'automaticDiscountNodes';
            const r = await read(ctx, doc, { first: 20, after: v.after, query: v.query ? `title:${v.query}` : null });
            return { result: { items: nodes(r.data?.[root]).map((n) => mapDiscount(v.type, n)), page: page(r.data?.[root]) } };
        }
    },
    'discount.get': {
        ...R('store.discounts', ['read_discounts']),
        validate: DISCOUNT_REF,
        async run(ctx, v) {
            const n = v.type === 'code' ? await shopifyNode(ctx, D.codeDiscount, v.id, 'codeDiscountNode')
                                        : await shopifyNode(ctx, D.automaticDiscount, v.id, 'automaticDiscountNode');
            return { result: mapDiscount(v.type, n) };
        }
    },
    'fulfillment_order.list': {
        ...R('store.fulfillment', ['read_merchant_managed_fulfillment_orders']),
        validate: (v) => (only(v, ['order_id']), { order_id: gidOf('Order', v.order_id, 'order_id') }),
        async run(ctx, v) {
            const o = await shopifyNode(ctx, D.fulfillmentOrders, v.order_id, 'order');
            return { result: {
                order_id: o.id, name: shortText(o.name, 40), fulfillment_status: enumOf(o.displayFulfillmentStatus), cancelled: !!o.cancelledAt,
                fulfillment_orders: nodes(o.fulfillmentOrders).map((fo) => ({
                    id: fo?.id, status: enumOf(fo?.status), request_status: enumOf(fo?.requestStatus),
                    location_name: shortText(fo?.assignedLocation?.name, 80), location_id: fo?.assignedLocation?.location?.id || null,
                    can_fulfill: (Array.isArray(fo?.supportedActions) ? fo.supportedActions : []).some((a) => a?.action === 'CREATE_FULFILLMENT'),
                    lines: nodes(fo?.lineItems).map((l) => ({
                        id: l?.id, title: shortText(l?.productTitle, 120), variant_title: shortText(l?.variantTitle, 80), sku: shortText(l?.sku, 60),
                        total: intOf(l?.totalQuantity), remaining: intOf(l?.remainingQuantity)
                    }))
                })),
                fulfillments: (Array.isArray(o.fulfillments) ? o.fulfillments : []).map((f) => ({
                    id: f?.id, status: enumOf(f?.displayStatus || f?.status), created_at: isoUtc(f?.createdAt, { assumeUtc: false }),
                    tracking: (Array.isArray(f?.trackingInfo) ? f.trackingInfo : []).map((t) => ({
                        company: shortText(t?.company, 60), number: shortText(t?.number, 60),
                        url: /^https:\/\/[^\s"<>]{3,400}$/.test(String(t?.url || '')) ? t.url : null
                    }))
                }))
            } };
        }
    },
    'return.list': {
        ...R('store.returns', ['read_returns']),
        validate: (v) => (only(v, ['order_id']), { order_id: gidOf('Order', v.order_id, 'order_id') }),
        async run(ctx, v) {
            const o = await shopifyNode(ctx, D.returns, v.order_id, 'order');
            return { result: { order_id: o.id, name: shortText(o.name, 40), return_status: enumOf(o.returnStatus),
                items: nodes(o.returns).map((x) => ({
                    id: x?.id, name: shortText(x?.name, 40), status: enumOf(x?.status), quantity: intOf(x?.totalQuantity),
                    created_at: isoUtc(x?.createdAt, { assumeUtc: false }), closed_at: isoUtc(x?.closedAt, { assumeUtc: false })
                })) } };
        }
    },
    'returnable.list': {
        ...R('store.returns', ['read_returns']),
        validate: (v) => (only(v, ['order_id']), { order_id: gidOf('Order', v.order_id, 'order_id') }),
        async run(ctx, v) {
            const r = await read(ctx, D.returnable, { id: v.order_id });
            return { result: { items: nodes(r.data?.returnableFulfillments).flatMap((rf) => nodes(rf?.returnableFulfillmentLineItems).map((l) => ({
                fulfillment_line_item_id: l?.fulfillmentLineItem?.id || null, quantity: intOf(l?.quantity),
                title: shortText(l?.fulfillmentLineItem?.lineItem?.title, 120), sku: shortText(l?.fulfillmentLineItem?.lineItem?.sku, 60)
            }))) } };
        }
    },

    /* ── المنتجات والمتغيرات ── */
    'product.create': {
        ...W('store.catalog', ['write_products']),
        validate(v) {
            only(v, ['title', 'description_html', 'vendor', 'product_type', 'tags', 'options']);
            const o = { title: text(v.title, 'title', { max: 255, re: SAFE_LINE }), status: 'DRAFT' };   // مسودة دائمًا؛ التفعيل بتأكيد
            if (present(v, 'description_html')) o.descriptionHtml = html(v.description_html, 'description_html');
            if (present(v, 'vendor')) o.vendor = text(v.vendor, 'vendor', { max: 255, re: SAFE_LINE });
            if (present(v, 'product_type')) o.productType = text(v.product_type, 'product_type', { max: 255, re: SAFE_LINE });
            if (present(v, 'tags')) o.tags = tags(v.tags, 'tags');
            if (present(v, 'options')) {
                o.productOptions = list(v.options, 'options', { max: 3 }, (x, g) => {
                    only(x, ['name', 'values'], g);
                    return { name: text(x.name, `${g}.name`, { max: 255, re: SAFE_LINE }),
                             values: uniq(list(x.values, `${g}.values`, { max: 100 }, (y, h) => text(y, h, { max: 255, re: SAFE_LINE })), `${g}.values`).map((name) => ({ name })) };
                });
                uniq(o.productOptions.map((x) => x.name.toLowerCase()), 'options');
            }
            return o;
        },
        async run(ctx, v) {
            const p = await mutate(ctx, `mutation ($product: ProductCreateInput!) { productCreate(product: $product) {
                product { id title status } ${UE} } }`, { product: v }, 'productCreate');
            return { result: { id: p.product?.id, title: shortText(p.product?.title, 255), status: enumOf(p.product?.status) }, resource: refOf(p.product?.id) };
        }
    },
    'product.update': {
        ...W('store.catalog', ['write_products']),
        validate(v) {
            only(v, ['id', 'title', 'description_html', 'vendor', 'product_type', 'tags']);
            const o = { id: gidOf('Product', v.id, 'id') };
            if (present(v, 'title')) o.title = text(v.title, 'title', { max: 255, re: SAFE_LINE });
            if (Object.prototype.hasOwnProperty.call(v, 'description_html')) o.descriptionHtml = html(v.description_html ?? '', 'description_html');
            if (Object.prototype.hasOwnProperty.call(v, 'vendor')) o.vendor = v.vendor === '' || v.vendor === null ? '' : text(v.vendor, 'vendor', { max: 255, re: SAFE_LINE });
            if (Object.prototype.hasOwnProperty.call(v, 'product_type')) o.productType = v.product_type === '' || v.product_type === null ? '' : text(v.product_type, 'product_type', { max: 255, re: SAFE_LINE });
            if (present(v, 'tags')) o.tags = tags(v.tags, 'tags');
            if (Object.keys(o).length === 1) bad('input');
            return o;
        },
        async run(ctx, v) {
            const p = await mutate(ctx, `mutation ($product: ProductUpdateInput!) { productUpdate(product: $product) {
                product { id title status } ${UE} } }`, { product: v }, 'productUpdate');
            return { result: { id: p.product?.id, title: shortText(p.product?.title, 255), status: enumOf(p.product?.status) }, resource: refOf(p.product?.id),
                     detail: { fields: Object.keys(v).filter((k) => k !== 'id') } };
        }
    },
    'product.set_status': {
        ...W('store.catalog', ['write_products'], true),
        validate: (v) => (only(v, ['id', 'status']), { id: gidOf('Product', v.id, 'id'), status: oneOf(v.status, 'status', ['ACTIVE', 'DRAFT']) }),
        async check(ctx, v) {
            const p = (await read(ctx, D.product, { id: v.id })).data?.product;
            if (!p) throw new ConnectorError('not_found');
            if (p.status === v.status) throw notEligible('status_unchanged');
            return { title: shortText(p.title, 255), from: enumOf(p.status), to: v.status };
        },
        async run(ctx, v) {
            const p = await mutate(ctx, `mutation ($product: ProductUpdateInput!) { productUpdate(product: $product) {
                product { id status } ${UE} } }`, { product: v }, 'productUpdate');
            return { result: { id: p.product?.id, status: enumOf(p.product?.status) }, resource: refOf(v.id), detail: { status: v.status } };
        }
    },
    'product.archive': {
        ...X('store.catalog', ['write_products']),
        validate: (v) => (only(v, ['id']), { id: gidOf('Product', v.id, 'id') }),
        async check(ctx, v) {
            const p = (await read(ctx, D.product, { id: v.id })).data?.product;
            if (!p) throw new ConnectorError('not_found');
            if (p.status === 'ARCHIVED') throw notEligible('already_archived');
            return { title: shortText(p.title, 255), from: enumOf(p.status) };
        },
        async run(ctx, v) {
            const p = await mutate(ctx, `mutation ($product: ProductUpdateInput!) { productUpdate(product: $product) {
                product { id status } ${UE} } }`, { product: { id: v.id, status: 'ARCHIVED' } }, 'productUpdate');
            return { result: { id: p.product?.id, status: enumOf(p.product?.status) }, resource: refOf(v.id) };
        }
    },
    'product.delete': {
        ...X('store.catalog', ['write_products']),
        validate: (v) => (only(v, ['id']), { id: gidOf('Product', v.id, 'id') }),
        async check(ctx, v) {
            const p = (await read(ctx, D.product, { id: v.id })).data?.product;
            if (!p) throw new ConnectorError('not_found');
            return { title: shortText(p.title, 255), status: enumOf(p.status), variants: nodes(p.variants).length };
        },
        async run(ctx, v) {
            const p = await mutate(ctx, `mutation ($input: ProductDeleteInput!) { productDelete(input: $input, synchronous: true) {
                deletedProductId ${UE} } }`, { input: { id: v.id } }, 'productDelete');
            if (p.deletedProductId !== v.id) throw new ConnectorError('invalid_response', 'deletedProductId');
            return { result: { deleted_id: p.deletedProductId }, resource: refOf(v.id) };
        }
    },
    'product.publish': publishOp('publishablePublish'),
    'product.unpublish': publishOp('publishableUnpublish'),
    'product.set_collections': {
        ...W('store.catalog', ['write_products']),
        validate(v) {
            only(v, ['id', 'join', 'leave']);
            const o = { id: gidOf('Product', v.id, 'id') };
            if (present(v, 'join')) o.collectionsToJoin = ids('Collection', v.join, 'join', 20);
            if (present(v, 'leave')) o.collectionsToLeave = ids('Collection', v.leave, 'leave', 20);
            if (!o.collectionsToJoin && !o.collectionsToLeave) bad('input');
            if ((o.collectionsToJoin || []).some((c) => (o.collectionsToLeave || []).includes(c))) bad('leave');
            return o;
        },
        async run(ctx, v) {
            const p = await mutate(ctx, `mutation ($product: ProductUpdateInput!) { productUpdate(product: $product) {
                product { id collections(first: 50) { nodes { id title } } } ${UE} } }`, { product: v }, 'productUpdate');
            return { result: { id: p.product?.id, collections: nodes(p.product?.collections).map((c) => ({ id: c?.id, title: shortText(c?.title, 255) })) },
                     resource: refOf(v.id), detail: { joined: (v.collectionsToJoin || []).map(refOf), left: (v.collectionsToLeave || []).map(refOf) } };
        }
    },
    'variant.create': {
        ...W('store.catalog', ['write_products']),
        validate(v) {
            only(v, ['product_id', 'variants', 'remove_default']);
            return {
                product_id: gidOf('Product', v.product_id, 'product_id'),
                variants: list(v.variants, 'variants', { max: 20 }, (x, g) => variantFields(x, g, { create: true })),
                strategy: present(v, 'remove_default') && bool(v.remove_default, 'remove_default') ? 'REMOVE_STANDALONE_VARIANT' : 'DEFAULT'
            };
        },
        async run(ctx, v) {
            const p = await mutate(ctx, `mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $strategy: ProductVariantsBulkCreateStrategy) {
                productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) {
                  productVariants { id title price } ${UEC} } }`, { productId: v.product_id, variants: v.variants, strategy: v.strategy }, 'productVariantsBulkCreate');
            return { result: { items: (Array.isArray(p.productVariants) ? p.productVariants : []).map((x) => ({ id: x?.id, title: shortText(x?.title, 80), price: amountText(x?.price) })) },
                     resource: refOf(v.product_id), detail: { count: v.variants.length } };
        }
    },
    'variant.update': {
        ...W('store.catalog', ['write_products'], true),
        validate(v) {
            only(v, ['product_id', 'variants']);
            const variants = list(v.variants, 'variants', { max: 20 }, (x, g) => variantFields(x, g, { create: false }));
            uniq(variants.map((x) => x.id), 'variants');
            return { product_id: gidOf('Product', v.product_id, 'product_id'), variants };
        },
        // الأسعار الحالية من Shopify (لا من المتصفح) والمتغيرات للمنتج نفسه
        async check(ctx, v) {
            const r = await read(ctx, D.variantsOfProduct, { ids: v.variants.map((x) => x.id) });
            const found = new Map((Array.isArray(r.data?.nodes) ? r.data.nodes : []).filter(Boolean).map((n) => [n.id, n]));
            return { changes: v.variants.map((x, i) => {
                const cur = found.get(x.id);
                if (!cur || cur.product?.id !== v.product_id) throw notEligible(`variants.${i}.id`);
                const effectiveCompare = x.compareAtPrice !== undefined ? x.compareAtPrice : cur.compareAtPrice;
                const effectivePrice = x.price !== undefined ? x.price : cur.price;
                if (effectiveCompare !== null && effectiveCompare !== undefined && Number(effectiveCompare) <= Number(effectivePrice)) {
                    throw notEligible(`variants.${i}.compare_at_price`);
                }
                return { id: x.id, title: shortText(cur.title, 80), price_from: amountText(cur.price), price_to: x.price !== undefined ? x.price : null,
                         compare_from: amountText(cur.compareAtPrice), compare_to: x.compareAtPrice !== undefined ? x.compareAtPrice : undefined,
                         fields: Object.keys(x).filter((k) => k !== 'id') };
            }) };
        },
        async run(ctx, v) {
            const p = await mutate(ctx, `mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
                productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id price compareAtPrice } ${UEC} } }`,
            { productId: v.product_id, variants: v.variants }, 'productVariantsBulkUpdate');
            return { result: { items: (Array.isArray(p.productVariants) ? p.productVariants : []).map((x) => ({ id: x?.id, price: amountText(x?.price), compare_at_price: amountText(x?.compareAtPrice) })) },
                     resource: refOf(v.product_id), detail: { variants: v.variants.map((x) => ({ id: refOf(x.id), fields: Object.keys(x).filter((k) => k !== 'id') })) } };
        }
    },
    'variant.delete': {
        ...X('store.catalog', ['write_products']),
        validate: (v) => (only(v, ['product_id', 'variant_ids']), { product_id: gidOf('Product', v.product_id, 'product_id'), variant_ids: ids('ProductVariant', v.variant_ids, 'variant_ids', 50) }),
        async check(ctx, v) {
            const r = await read(ctx, D.variantsOfProduct, { ids: v.variant_ids });
            const found = (Array.isArray(r.data?.nodes) ? r.data.nodes : []).filter(Boolean);
            v.variant_ids.forEach((id, i) => {
                if (!found.some((n) => n.id === id && n.product?.id === v.product_id)) throw notEligible(`variant_ids.${i}`);
            });
            return { variants: found.map((n) => ({ id: n.id, title: shortText(n.title, 80) })) };
        },
        async run(ctx, v) {
            await mutate(ctx, `mutation ($productId: ID!, $variantsIds: [ID!]!) { productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
                product { id } ${UEC} } }`, { productId: v.product_id, variantsIds: v.variant_ids }, 'productVariantsBulkDelete');
            return { result: { deleted: v.variant_ids }, resource: refOf(v.product_id), detail: { variants: v.variant_ids.map(refOf) } };
        }
    },
    'metafield.set': {
        ...W('store.catalog', ['write_products']),
        validate(v) {
            only(v, ['owner_id', 'namespace', 'key', 'type', 'value']);
            const owner = String(v.owner_id ?? '');
            const ownerId = /\/ProductVariant\//.test(owner) ? gidOf('ProductVariant', owner, 'owner_id') : gidOf('Product', owner, 'owner_id');
            const type = oneOf(v.type, 'type', Object.keys(METAFIELD_TYPES));
            const value = typeof v.value === 'string' ? v.value : bad('value');
            if (CTRL.test(value.replace(/[\r\n\t]/g, '')) || !METAFIELD_TYPES[type](value)) bad('value');
            return {
                ownerId, type, value,
                namespace: text(v.namespace, 'namespace', { min: 3, max: 255, re: /^[a-zA-Z0-9_-]+$/ }),
                key: text(v.key, 'key', { min: 2, max: 64, re: /^[a-zA-Z0-9_-]+$/ })
            };
        },
        async run(ctx, v) {
            const p = await mutate(ctx, `mutation ($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) {
                metafields { id namespace key } ${UEC} } }`, { metafields: [v] }, 'metafieldsSet');
            return { result: { id: p.metafields?.[0]?.id || null }, resource: refOf(v.ownerId), detail: { namespace: v.namespace, key: v.key, type: v.type } };
        }
    },

    /* ── المجموعات ── */
    'collection.create': {
        ...W('store.catalog', ['write_products']),
        validate(v) {
            only(v, ['title', 'description_html', 'sort_order']);
            const o = { title: text(v.title, 'title', { max: 255, re: SAFE_LINE }) };
            if (present(v, 'description_html')) o.descriptionHtml = html(v.description_html, 'description_html');
            if (present(v, 'sort_order')) o.sortOrder = oneOf(v.sort_order, 'sort_order', COLLECTION_SORT);
            return o;
        },
        async run(ctx, v) {
            const p = await mutate(ctx, `mutation ($collection: CollectionCreateInput!) { collectionCreate(collection: $collection) {
                collection { id title } ${UE} } }`, { collection: v }, 'collectionCreate');
            return { result: { id: p.collection?.id, title: shortText(p.collection?.title, 255) }, resource: refOf(p.collection?.id) };
        }
    },
    'collection.update': {
        ...W('store.catalog', ['write_products']),
        validate(v) {
            only(v, ['id', 'title', 'description_html', 'sort_order']);
            const o = { id: gidOf('Collection', v.id, 'id') };
            if (present(v, 'title')) o.title = text(v.title, 'title', { max: 255, re: SAFE_LINE });
            if (Object.prototype.hasOwnProperty.call(v, 'description_html')) o.descriptionHtml = html(v.description_html ?? '', 'description_html');
            if (present(v, 'sort_order')) o.sortOrder = oneOf(v.sort_order, 'sort_order', COLLECTION_SORT);
            if (Object.keys(o).length === 1) bad('input');
            return o;
        },
        async run(ctx, v) {
            const p = await mutate(ctx, `mutation ($collection: CollectionUpdateInput!) { collectionUpdate(collection: $collection) {
                collection { id title } ${UE} } }`, { collection: v }, 'collectionUpdate');
            return { result: { id: p.collection?.id, title: shortText(p.collection?.title, 255) }, resource: refOf(v.id), detail: { fields: Object.keys(v).filter((k) => k !== 'id') } };
        }
    },
    'collection.delete': {
        ...X('store.catalog', ['write_products']),
        validate: (v) => (only(v, ['id']), { id: gidOf('Collection', v.id, 'id') }),
        async check(ctx, v) {
            const c = await shopifyNode(ctx, D.collection, v.id, 'collection');
            return { title: shortText(c.title, 255), products_count: intOf(c.productsCount?.count) };
        },
        async run(ctx, v) {
            const p = await mutate(ctx, `mutation ($input: CollectionDeleteInput!) { collectionDelete(input: $input) { deletedCollectionId ${UE} } }`,
                { input: { id: v.id } }, 'collectionDelete');
            if (p.deletedCollectionId !== v.id) throw new ConnectorError('invalid_response', 'deletedCollectionId');
            return { result: { deleted_id: p.deletedCollectionId }, resource: refOf(v.id) };
        }
    },

    /* ── الطلبات ── */
    'order.update_notes': {
        ...W('store.orders_manage', ['write_orders']),
        validate(v) {
            only(v, ['id', 'note', 'tags']);
            const o = { id: gidOf('Order', v.id, 'id') };
            if (Object.prototype.hasOwnProperty.call(v, 'note')) o.note = v.note === null ? '' : text(v.note, 'note', { min: 0, max: 5000 });
            if (present(v, 'tags')) o.tags = tags(v.tags, 'tags');
            if (Object.keys(o).length === 1) bad('input');
            return o;
        },
        async run(ctx, v) {
            const p = await mutate(ctx, `mutation ($input: OrderInput!) { orderUpdate(input: $input) { order { id } ${UE} } }`, { input: v }, 'orderUpdate');
            return { result: { id: p.order?.id }, resource: refOf(v.id), detail: { fields: Object.keys(v).filter((k) => k !== 'id') } };
        }
    },
    'order.update_contact': {
        ...W('store.orders_manage', ['write_orders'], true),
        validate(v) {
            only(v, ['id', 'email', 'phone', 'shipping_address']);
            const o = { id: gidOf('Order', v.id, 'id') };
            if (present(v, 'email')) o.email = email(v.email, 'email');
            if (present(v, 'phone')) o.phone = phone(v.phone, 'phone');
            if (present(v, 'shipping_address')) o.shippingAddress = address(v.shipping_address, 'shipping_address');
            if (Object.keys(o).length === 1) bad('input');
            return o;
        },
        async check(ctx, v) {
            const o = (await read(ctx, D.orderForCancel, { id: v.id })).data?.order;
            if (!o) throw new ConnectorError('not_found');
            if (o.cancelledAt) throw notEligible('order_cancelled');
            return { name: shortText(o.name, 40), fields: Object.keys(v).filter((k) => k !== 'id'), fulfillment_status: enumOf(o.displayFulfillmentStatus) };
        },
        async run(ctx, v) {
            const p = await mutate(ctx, `mutation ($input: OrderInput!) { orderUpdate(input: $input) { order { id } ${UE} } }`, { input: v }, 'orderUpdate');
            return { result: { id: p.order?.id }, resource: refOf(v.id), detail: { fields: Object.keys(v).filter((k) => k !== 'id') } };
        }
    },
    'order.create': {
        ...W('store.orders_manage', ['write_orders', 'read_products'], true),
        validate(v) {
            only(v, ['lines', 'customer_id', 'email', 'shipping_address', 'note', 'tags', 'test', 'send_receipt', 'inventory']);
            const o = { lines: orderLines(v.lines, 'lines') };
            if (present(v, 'customer_id')) o.customer_id = gidOf('Customer', v.customer_id, 'customer_id');
            if (present(v, 'email')) o.email = email(v.email, 'email');
            if (present(v, 'shipping_address')) o.shipping_address = address(v.shipping_address, 'shipping_address');
            if (present(v, 'note')) o.note = text(v.note, 'note', { min: 0, max: 5000 });
            if (present(v, 'tags')) o.tags = tags(v.tags, 'tags');
            o.test = present(v, 'test') ? bool(v.test, 'test') : false;
            o.send_receipt = present(v, 'send_receipt') ? bool(v.send_receipt, 'send_receipt') : false;   // لا رسالة للعميل إلا بطلب صريح
            o.inventory = present(v, 'inventory') ? oneOf(v.inventory, 'inventory', ['DECREMENT_OBEYING_POLICY', 'BYPASS']) : 'DECREMENT_OBEYING_POLICY';
            return o;
        },
        // الأسعار والعملة من Shopify وحده؛ المنتج نشط والمتغير متاح للبيع
        async check(ctx, v) {
            const r = await read(ctx, D.variantsForOrder, { ids: v.lines.map((l) => l.variantId) });
            const currency = r.data?.shop?.currencyCode;
            if (!/^[A-Z]{3}$/.test(String(currency || ''))) throw new ConnectorError('invalid_response', 'currency');
            const found = new Map((Array.isArray(r.data?.nodes) ? r.data.nodes : []).filter(Boolean).map((n) => [n.id, n]));
            const lines = v.lines.map((l, i) => {
                const n = found.get(l.variantId);
                if (!n) throw notEligible(`lines.${i}.variant_id`);
                if (n.product?.status !== 'ACTIVE') throw notEligible(`lines.${i}.product_not_active`);
                if (n.availableForSale !== true) throw notEligible(`lines.${i}.not_available`);
                const price = amountText(n.price);
                if (price === null) throw new ConnectorError('invalid_response', 'price');
                return { variant_id: l.variantId, quantity: l.quantity, title: shortText(n.product?.title, 120), variant_title: shortText(n.title, 80), unit_price: price };
            });
            const subtotal = lines.reduce((s, l) => s + Math.round(Number(l.unit_price) * 10000) * l.quantity, 0) / 10000;
            return { currency, lines, subtotal_before_tax_shipping: amountText(subtotal), financial_status: 'PENDING', receipt: v.send_receipt, test: v.test };
        },
        async run(ctx, v, meta) {
            const c = meta.check;                                     // أُعيد حسابه للتو من Shopify (api.js)
            const order = {
                currency: c.currency, financialStatus: 'PENDING', test: v.test,
                lineItems: c.lines.map((l) => ({ variantId: l.variant_id, quantity: l.quantity, priceSet: { shopMoney: { amount: l.unit_price, currencyCode: c.currency } } }))
            };
            if (v.customer_id) order.customer = { toAssociate: { id: v.customer_id } };
            if (v.email) order.email = v.email;
            if (v.shipping_address) order.shippingAddress = v.shipping_address;
            if (v.note) order.note = v.note;
            if (v.tags) order.tags = v.tags;
            const p = await mutate(ctx, `mutation ($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) { orderCreate(order: $order, options: $options) {
                order { id name displayFinancialStatus } ${UEC} } }`,
            { order, options: { inventoryBehaviour: v.inventory, sendReceipt: v.send_receipt, sendFulfillmentReceipt: false } }, 'orderCreate');
            return { result: { id: p.order?.id, name: shortText(p.order?.name, 40), financial_status: enumOf(p.order?.displayFinancialStatus) },
                     resource: refOf(p.order?.id), detail: { lines: c.lines.length, test: v.test, receipt: v.send_receipt } };
        }
    },
    'order.cancel': {
        ...X('store.orders_manage', ['write_orders']),
        validate(v) {
            only(v, ['id', 'reason', 'restock', 'notify_customer', 'staff_note']);
            return {
                id: gidOf('Order', v.id, 'id'), reason: oneOf(v.reason, 'reason', ['CUSTOMER', 'DECLINED', 'FRAUD', 'INVENTORY', 'OTHER', 'STAFF']),
                restock: bool(v.restock, 'restock'), notify_customer: present(v, 'notify_customer') ? bool(v.notify_customer, 'notify_customer') : false,
                staff_note: present(v, 'staff_note') ? text(v.staff_note, 'staff_note', { max: 255 }) : null
            };
        },
        // لا مال مقبوض ولا تفويض قائم ولا تنفيذ: غير ذلك قرار استرداد مالي ⇒ من لوحة Shopify
        async check(ctx, v) {
            const o = (await read(ctx, D.orderForCancel, { id: v.id })).data?.order;
            if (!o) throw new ConnectorError('not_found');
            if (o.cancelledAt) throw notEligible('already_cancelled');
            const received = Number(moneyOf(o.totalReceivedSet).amount ?? NaN);
            if (!['PENDING', 'EXPIRED', 'VOIDED'].includes(o.displayFinancialStatus) || o.capturable === true || o.fullyPaid === true
                || !Number.isFinite(received) || received !== 0) throw notEligible('cancel_requires_refund_review');
            if (o.displayFulfillmentStatus !== 'UNFULFILLED') throw notEligible('order_fulfilled');
            return { name: shortText(o.name, 40), financial_status: enumOf(o.displayFinancialStatus), total: moneyOf(o.totalPriceSet),
                     restock: v.restock, notify_customer: v.notify_customer, refund: false };
        },
        async run(ctx, v) {
            const p = await mutate(ctx, `mutation ($orderId: ID!, $reason: OrderCancelReason!, $restock: Boolean!, $notifyCustomer: Boolean, $staffNote: String, $refundMethod: OrderCancelRefundMethodInput) {
                orderCancel(orderId: $orderId, reason: $reason, restock: $restock, notifyCustomer: $notifyCustomer, staffNote: $staffNote, refundMethod: $refundMethod) {
                  job { id done } orderCancelUserErrors { field code } } }`,
            { orderId: v.id, reason: v.reason, restock: v.restock, notifyCustomer: v.notify_customer, staffNote: v.staff_note,
              refundMethod: { originalPaymentMethodsRefund: false } }, 'orderCancel', 'orderCancelUserErrors');
            // مهمة غير متزامنة: «أُرسل»، والحالة الفعلية من Shopify لاحقًا (orders/cancelled)
            return { result: { job_id: p.job?.id || null, done: p.job?.done === true }, status: p.job?.done === true ? 'succeeded' : 'submitted',
                     resource: refOf(v.id), detail: { reason: v.reason, restock: v.restock, notify: v.notify_customer } };
        }
    },

    /* ── المسودات ── */
    'draft_order.create': {
        ...W('store.orders_manage', ['write_draft_orders']),
        validate: (v) => draftInput(v, { update: false }),
        async run(ctx, v) {
            const p = await mutate(ctx, `mutation ($input: DraftOrderInput!) { draftOrderCreate(input: $input) {
                draftOrder { id name status totalPriceSet { ${MONEY} } } ${UE} } }`, { input: v }, 'draftOrderCreate');
            return { result: { id: p.draftOrder?.id, name: shortText(p.draftOrder?.name, 40), status: enumOf(p.draftOrder?.status), total: moneyOf(p.draftOrder?.totalPriceSet) },
                     resource: refOf(p.draftOrder?.id), detail: { lines: v.lineItems.length } };
        }
    },
    'draft_order.update': {
        ...W('store.orders_manage', ['write_draft_orders']),
        validate(v) {
            const o = draftInput(v, { update: true });
            return { id: gidOf('DraftOrder', v.id, 'id'), input: o };
        },
        async run(ctx, v) {
            const p = await mutate(ctx, `mutation ($id: ID!, $input: DraftOrderInput!) { draftOrderUpdate(id: $id, input: $input) {
                draftOrder { id name status totalPriceSet { ${MONEY} } } ${UE} } }`, v, 'draftOrderUpdate');
            return { result: { id: p.draftOrder?.id, name: shortText(p.draftOrder?.name, 40), status: enumOf(p.draftOrder?.status), total: moneyOf(p.draftOrder?.totalPriceSet) },
                     resource: refOf(v.id), detail: { fields: Object.keys(v.input) } };
        }
    },
    'draft_order.delete': {
        ...X('store.orders_manage', ['write_draft_orders']),
        validate: (v) => (only(v, ['id']), { id: gidOf('DraftOrder', v.id, 'id') }),
        async check(ctx, v) {
            const d = (await read(ctx, D.draftOrder, { id: v.id })).data?.draftOrder;
            if (!d) throw new ConnectorError('not_found');
            if (d.status === 'COMPLETED') throw notEligible('draft_completed');
            return { name: shortText(d.name, 40), status: enumOf(d.status), total: moneyOf(d.totalPriceSet) };
        },
        async run(ctx, v) {
            const p = await mutate(ctx, `mutation ($input: DraftOrderDeleteInput!) { draftOrderDelete(input: $input) { deletedId ${UE} } }`, { input: { id: v.id } }, 'draftOrderDelete');
            if (p.deletedId !== v.id) throw new ConnectorError('invalid_response', 'deletedId');
            return { result: { deleted_id: p.deletedId }, resource: refOf(v.id) };
        }
    },

    /* ── العملاء ── */
    'customer.create': {
        ...W('store.customers_manage', ['write_customers']),
        validate: (v) => customerInput(v, { update: false }),
        async run(ctx, v) {
            // الرد بلا حقول محمية: المعرّف فقط
            const p = await mutate(ctx, `mutation ($input: CustomerInput!) { customerCreate(input: $input) { customer { id } ${UE} } }`, { input: v }, 'customerCreate');
            return { result: { id: p.customer?.id }, resource: refOf(p.customer?.id), detail: { fields: Object.keys(v) } };
        }
    },
    'customer.update': {
        ...W('store.customers_manage', ['write_customers']),
        validate: (v) => customerInput(v, { update: true }),
        async run(ctx, v) {
            const p = await mutate(ctx, `mutation ($input: CustomerInput!) { customerUpdate(input: $input) { customer { id } ${UE} } }`, { input: v }, 'customerUpdate');
            return { result: { id: p.customer?.id }, resource: refOf(v.id), detail: { fields: Object.keys(v).filter((k) => k !== 'id') } };
        }
    },

    /* ── المخزون ── */
    'inventory.adjust': {
        ...W('store.inventory', ['write_inventory', 'read_locations'], true),
        validate(v) {
            only(v, ['name', 'reason', 'changes']);
            const changes = list(v.changes, 'changes', { max: 20 }, (c, g) => {
                only(c, ['inventory_item_id', 'location_id', 'delta', 'expected_quantity'], g);
                const delta = integer(c.delta, `${g}.delta`, -100_000, 100_000);
                if (delta === 0) bad(`${g}.delta`);
                return { inventoryItemId: gidOf('InventoryItem', c.inventory_item_id, `${g}.inventory_item_id`),
                         locationId: gidOf('Location', c.location_id, `${g}.location_id`), delta,
                         changeFromQuantity: integer(c.expected_quantity, `${g}.expected_quantity`, -1_000_000, 1_000_000) };
            });
            uniq(changes.map((c) => `${c.inventoryItemId}|${c.locationId}`), 'changes');
            return { name: oneOf(v.name, 'name', ['available', 'on_hand']), reason: oneOf(v.reason, 'reason', INVENTORY_REASONS), changes };
        },
        async check(ctx, v) {
            const levels = await currentLevels(ctx, v.changes, v.name);
            return { name: v.name, reason: v.reason, changes: levels.map((l) => ({
                inventory_item_id: l.inventoryItemId, location_id: l.locationId, location_name: l.location_name,
                current: l.current, expected: l.changeFromQuantity, stale: l.current !== l.changeFromQuantity,
                delta: l.delta, after: l.current === null ? null : l.current + l.delta, tracked: l.tracked
            })) };
        },
        async run(ctx, v, meta) {
            const p = await mutate(ctx, `mutation ($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
                inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
                  inventoryAdjustmentGroup { createdAt reason changes { name delta quantityAfterChange item { id } location { id } } } ${UEC} } }`,
            { input: { name: v.name, reason: v.reason, referenceDocumentUri: `gid://mad3oom/StoreOperation/${meta.opId}`, changes: v.changes }, idempotencyKey: meta.opId },
            'inventoryAdjustQuantities');
            const changes = inventoryChanges(p.inventoryAdjustmentGroup);
            return { result: { changes }, resource: refOf(v.changes[0].inventoryItemId),
                     detail: { name: v.name, reason: v.reason, changes: v.changes.map((c) => ({
                         item: refOf(c.inventoryItemId), location: refOf(c.locationId), delta: c.delta, from: c.changeFromQuantity,
                         after: changes.find((x) => x.inventory_item_id === c.inventoryItemId && x.location_id === c.locationId && x.name === v.name)?.quantity_after ?? null
                     })) } };
        }
    },
    'inventory.set': {
        ...W('store.inventory', ['write_inventory', 'read_locations'], true),
        validate(v) {
            only(v, ['name', 'reason', 'quantities']);
            const quantities = list(v.quantities, 'quantities', { max: 20 }, (c, g) => {
                only(c, ['inventory_item_id', 'location_id', 'quantity', 'expected_quantity'], g);
                return { inventoryItemId: gidOf('InventoryItem', c.inventory_item_id, `${g}.inventory_item_id`),
                         locationId: gidOf('Location', c.location_id, `${g}.location_id`),
                         quantity: integer(c.quantity, `${g}.quantity`, 0, 1_000_000),
                         changeFromQuantity: integer(c.expected_quantity, `${g}.expected_quantity`, -1_000_000, 1_000_000) };
            });
            uniq(quantities.map((c) => `${c.inventoryItemId}|${c.locationId}`), 'quantities');
            return { name: oneOf(v.name, 'name', ['available', 'on_hand']), reason: oneOf(v.reason, 'reason', INVENTORY_REASONS), quantities };
        },
        async check(ctx, v) {
            const levels = await currentLevels(ctx, v.quantities, v.name);
            return { name: v.name, reason: v.reason, changes: levels.map((l) => ({
                inventory_item_id: l.inventoryItemId, location_id: l.locationId, location_name: l.location_name,
                current: l.current, expected: l.changeFromQuantity, stale: l.current !== l.changeFromQuantity, after: l.quantity, tracked: l.tracked
            })) };
        },
        async run(ctx, v, meta) {
            const p = await mutate(ctx, `mutation ($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
                inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
                  inventoryAdjustmentGroup { createdAt reason changes { name delta quantityAfterChange item { id } location { id } } } ${UEC} } }`,
            { input: { name: v.name, reason: v.reason, referenceDocumentUri: `gid://mad3oom/StoreOperation/${meta.opId}`, quantities: v.quantities }, idempotencyKey: meta.opId },
            'inventorySetQuantities');
            const changes = inventoryChanges(p.inventoryAdjustmentGroup);
            return { result: { changes }, resource: refOf(v.quantities[0].inventoryItemId),
                     detail: { name: v.name, reason: v.reason, changes: v.quantities.map((c) => ({
                         item: refOf(c.inventoryItemId), location: refOf(c.locationId), set: c.quantity, from: c.changeFromQuantity
                     })) } };
        }
    },
    'inventory.activate': {
        ...W('store.inventory', ['write_inventory', 'read_locations'], true),
        validate(v) {
            only(v, ['inventory_item_id', 'location_id', 'available']);
            return { inventory_item_id: gidOf('InventoryItem', v.inventory_item_id, 'inventory_item_id'), location_id: gidOf('Location', v.location_id, 'location_id'),
                     available: present(v, 'available') ? integer(v.available, 'available', 0, 1_000_000) : null };
        },
        async check(ctx, v) {
            const loc = await shopifyNode(ctx, D.location, v.location_id, 'location');
            if (loc.isActive === false) throw notEligible('location_inactive');
            const r = await read(ctx, D.inventoryItems, { ids: [v.inventory_item_id] });
            const item = (Array.isArray(r.data?.nodes) ? r.data.nodes : []).find((n) => n?.id === v.inventory_item_id);
            if (!item) throw new ConnectorError('not_found');
            if (nodes(item.inventoryLevels).some((l) => l?.location?.id === v.location_id)) throw notEligible('already_stocked');
            return { location_name: shortText(loc.name, 80), available: v.available };
        },
        async run(ctx, v) {
            const p = await mutate(ctx, `mutation ($inventoryItemId: ID!, $locationId: ID!, $available: Int) {
                inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, available: $available) { inventoryLevel { id } ${UE} } }`,
            { inventoryItemId: v.inventory_item_id, locationId: v.location_id, available: v.available }, 'inventoryActivate');
            return { result: { level_id: p.inventoryLevel?.id || null }, resource: refOf(v.inventory_item_id),
                     detail: { item: refOf(v.inventory_item_id), location: refOf(v.location_id), available: v.available } };
        }
    },

    /* ── الخصومات ── */
    'discount.code_create': discountWrite('code', false),
    'discount.code_update': discountWrite('code', true),
    'discount.automatic_create': discountWrite('automatic', false),
    'discount.automatic_update': discountWrite('automatic', true),
    'discount.activate': discountToggle(true),
    'discount.deactivate': discountToggle(false),
    'discount.delete': {
        ...X('store.discounts', ['write_discounts']),
        validate: DISCOUNT_REF,
        async check(ctx, v) {
            return discountSummary(ctx, v);
        },
        async run(ctx, v) {
            const isCode = v.type === 'code';
            const root = isCode ? 'discountCodeDelete' : 'discountAutomaticDelete';
            const field = isCode ? 'deletedCodeDiscountId' : 'deletedAutomaticDiscountId';
            const p = await mutate(ctx, `mutation ($id: ID!) { ${root}(id: $id) { ${field} ${UEC} } }`, { id: v.id }, root);
            if (p[field] !== v.id) throw new ConnectorError('invalid_response', field);
            return { result: { deleted_id: p[field] }, resource: refOf(v.id) };
        }
    },

    /* ── التنفيذ ── */
    'fulfillment.create': {
        ...W('store.fulfillment', ['write_merchant_managed_fulfillment_orders'], true),
        validate(v) {
            only(v, ['order_id', 'fulfillment_orders', 'tracking', 'notify_customer']);
            const fos = list(v.fulfillment_orders, 'fulfillment_orders', { max: 10 }, (fo, g) => {
                only(fo, ['id', 'lines'], g);
                const out = { fulfillmentOrderId: gidOf('FulfillmentOrder', fo.id, `${g}.id`) };
                if (present(fo, 'lines')) {
                    out.fulfillmentOrderLineItems = list(fo.lines, `${g}.lines`, { max: 100 }, (l, h) => {
                        only(l, ['id', 'quantity'], h);
                        return { id: gidOf('FulfillmentOrderLineItem', l.id, `${h}.id`), quantity: integer(l.quantity, `${h}.quantity`, 1, 100_000) };
                    });
                    uniq(out.fulfillmentOrderLineItems.map((l) => l.id), `${g}.lines`);
                }
                return out;
            });
            uniq(fos.map((f) => f.fulfillmentOrderId), 'fulfillment_orders');
            const o = { order_id: gidOf('Order', v.order_id, 'order_id'), lineItemsByFulfillmentOrder: fos,
                        notifyCustomer: present(v, 'notify_customer') ? bool(v.notify_customer, 'notify_customer') : false };
            if (present(v, 'tracking')) o.trackingInfo = tracking(v.tracking, 'tracking');
            return o;
        },
        // أوامر التنفيذ تخص هذا الطلب، مفتوحة وتقبل التنفيذ، والكميات ضمن المتبقي
        async check(ctx, v) {
            const o = await shopifyNode(ctx, D.fulfillmentOrders, v.order_id, 'order');
            if (o.cancelledAt) throw notEligible('order_cancelled');
            const fos = new Map(nodes(o.fulfillmentOrders).map((fo) => [fo?.id, fo]));
            return { name: shortText(o.name, 40), notify_customer: v.notifyCustomer, tracking: v.trackingInfo || null,
                     fulfillment_orders: v.lineItemsByFulfillmentOrder.map((req, i) => {
                         const fo = fos.get(req.fulfillmentOrderId);
                         if (!fo) throw notEligible(`fulfillment_orders.${i}.id`);
                         if (!['OPEN', 'IN_PROGRESS'].includes(fo.status)
                             || !(Array.isArray(fo.supportedActions) ? fo.supportedActions : []).some((a) => a?.action === 'CREATE_FULFILLMENT')) {
                             throw notEligible(`fulfillment_orders.${i}.not_fulfillable`);
                         }
                         const lines = new Map(nodes(fo.lineItems).map((l) => [l?.id, l]));
                         const chosen = req.fulfillmentOrderLineItems || nodes(fo.lineItems).filter((l) => (l?.remainingQuantity || 0) > 0).map((l) => ({ id: l.id, quantity: l.remainingQuantity }));
                         if (!chosen.length) throw notEligible(`fulfillment_orders.${i}.nothing_remaining`);
                         return { id: fo.id, location_name: shortText(fo.assignedLocation?.name, 80), lines: chosen.map((c, j) => {
                             const l = lines.get(c.id);
                             if (!l) throw notEligible(`fulfillment_orders.${i}.lines.${j}.id`);
                             if (!Number.isInteger(l.remainingQuantity) || c.quantity > l.remainingQuantity) throw notEligible(`fulfillment_orders.${i}.lines.${j}.quantity`);
                             return { id: c.id, title: shortText(l.productTitle, 120), quantity: c.quantity, remaining: l.remainingQuantity };
                         }) };
                     }) };
        },
        async run(ctx, v) {
            const fulfillment = { lineItemsByFulfillmentOrder: v.lineItemsByFulfillmentOrder, notifyCustomer: v.notifyCustomer };
            if (v.trackingInfo) fulfillment.trackingInfo = v.trackingInfo;
            const p = await mutate(ctx, `mutation ($fulfillment: FulfillmentInput!) { fulfillmentCreate(fulfillment: $fulfillment) {
                fulfillment { id status } ${UE} } }`, { fulfillment }, 'fulfillmentCreate');
            return { result: { id: p.fulfillment?.id, status: enumOf(p.fulfillment?.status) }, resource: refOf(p.fulfillment?.id),
                     detail: { order: refOf(v.order_id), fulfillment_orders: v.lineItemsByFulfillmentOrder.length, notify: v.notifyCustomer, tracking: !!v.trackingInfo } };
        }
    },
    'fulfillment.tracking_update': {
        ...W('store.fulfillment', ['write_merchant_managed_fulfillment_orders'], true),
        validate(v) {
            only(v, ['fulfillment_id', 'tracking', 'notify_customer']);
            return { fulfillment_id: gidOf('Fulfillment', v.fulfillment_id, 'fulfillment_id'), tracking: tracking(obj(v.tracking, 'tracking'), 'tracking'),
                     notify_customer: present(v, 'notify_customer') ? bool(v.notify_customer, 'notify_customer') : false };
        },
        async check(ctx, v) {
            const f = await shopifyNode(ctx, D.fulfillment, v.fulfillment_id, 'fulfillment');
            if (['CANCELLED', 'ERROR', 'FAILURE'].includes(f.status)) throw notEligible('fulfillment_inactive');
            return { status: enumOf(f.status), order_id: f.order?.id || null, tracking: v.tracking, notify_customer: v.notify_customer };
        },
        async run(ctx, v) {
            const p = await mutate(ctx, `mutation ($fulfillmentId: ID!, $trackingInfoInput: FulfillmentTrackingInput!, $notifyCustomer: Boolean) {
                fulfillmentTrackingInfoUpdate(fulfillmentId: $fulfillmentId, trackingInfoInput: $trackingInfoInput, notifyCustomer: $notifyCustomer) {
                  fulfillment { id status } ${UE} } }`, { fulfillmentId: v.fulfillment_id, trackingInfoInput: v.tracking, notifyCustomer: v.notify_customer }, 'fulfillmentTrackingInfoUpdate');
            return { result: { id: p.fulfillment?.id, status: enumOf(p.fulfillment?.status) }, resource: refOf(v.fulfillment_id), detail: { notify: v.notify_customer } };
        }
    },

    /* ── المرتجعات (بلا استرداد) ── */
    'return.create': {
        ...W('store.returns', ['write_returns'], true),
        validate(v) {
            only(v, ['order_id', 'lines']);
            const lines = list(v.lines, 'lines', { max: 50 }, (l, g) => {
                only(l, ['fulfillment_line_item_id', 'quantity', 'note'], g);
                const out = { fulfillmentLineItemId: gidOf('FulfillmentLineItem', l.fulfillment_line_item_id, `${g}.fulfillment_line_item_id`),
                              quantity: integer(l.quantity, `${g}.quantity`, 1, 10_000) };
                if (present(l, 'note')) out.returnReasonNote = text(l.note, `${g}.note`, { max: 255 });
                return out;
            });
            uniq(lines.map((l) => l.fulfillmentLineItemId), 'lines');
            return { orderId: gidOf('Order', v.order_id, 'order_id'), returnLineItems: lines };
        },
        async check(ctx, v) {
            const r = await read(ctx, D.returnable, { id: v.orderId });
            const returnable = new Map(nodes(r.data?.returnableFulfillments).flatMap((rf) => nodes(rf?.returnableFulfillmentLineItems))
                .map((l) => [l?.fulfillmentLineItem?.id, l]));
            return { lines: v.returnLineItems.map((l, i) => {
                const x = returnable.get(l.fulfillmentLineItemId);
                if (!x) throw notEligible(`lines.${i}.fulfillment_line_item_id`);
                if (!Number.isInteger(x.quantity) || l.quantity > x.quantity) throw notEligible(`lines.${i}.quantity`);
                return { id: l.fulfillmentLineItemId, title: shortText(x.fulfillmentLineItem?.lineItem?.title, 120), quantity: l.quantity, returnable: x.quantity };
            }), refund: false };
        },
        async run(ctx, v) {
            const p = await mutate(ctx, `mutation ($returnInput: ReturnInput!) { returnCreate(returnInput: $returnInput) { return { id name status } ${UEC} } }`,
                { returnInput: v }, 'returnCreate');
            return { result: { id: p.return?.id, name: shortText(p.return?.name, 40), status: enumOf(p.return?.status) }, resource: refOf(p.return?.id),
                     detail: { order: refOf(v.orderId), lines: v.returnLineItems.length } };
        }
    },
    'return.approve': returnTransition('returnApproveRequest', ['REQUESTED'], (v) => ({ input: { id: v.id, notifyCustomer: v.notify_customer } }), ['notify_customer']),
    'return.decline': returnTransition('returnDeclineRequest', ['REQUESTED'],
        (v) => ({ input: { id: v.id, declineReason: v.reason, declineNote: v.note, notifyCustomer: v.notify_customer } }), ['notify_customer', 'reason', 'note']),
    'return.cancel': { ...returnTransition('returnCancel', ['OPEN', 'REQUESTED'], (v) => ({ id: v.id }), []), risk: 'destructive' },
    'return.close': returnTransition('returnClose', ['OPEN'], (v) => ({ id: v.id }), [])
});

const COLLECTION_SORT = ['ALPHA_ASC', 'ALPHA_DESC', 'BEST_SELLING', 'CREATED', 'CREATED_DESC', 'MANUAL', 'PRICE_ASC', 'PRICE_DESC'];
// أسباب تعديل الكمية يدويًا (shopify.dev quantities-states). أسباب النقل والحجز ليست لهذا النموذج.
export const INVENTORY_REASONS = Object.freeze(['correction', 'cycle_count_available', 'damaged', 'other', 'promotion',
                                                 'quality_control', 'received', 'restock', 'safety_stock', 'shrinkage']);

function tracking(v, f) {
    only(v, ['company', 'number', 'url'], f);
    const o = { number: text(v.number, `${f}.number`, { max: 100, re: /^[A-Za-z0-9 ._/-]+$/ }) };
    if (present(v, 'company')) o.company = text(v.company, `${f}.company`, { max: 100, re: SAFE_LINE });
    if (present(v, 'url')) o.url = text(v.url, `${f}.url`, { max: 500, re: /^https:\/\/[^\s<>"]+$/ });
    return o;
}
function customerInput(v, { update }) {
    only(v, [...(update ? ['id'] : []), 'first_name', 'last_name', 'email', 'phone', 'note', 'tags']);
    const o = update ? { id: gidOf('Customer', v.id, 'id') } : {};
    if (present(v, 'first_name')) o.firstName = text(v.first_name, 'first_name', { max: 120, re: SAFE_LINE });
    if (present(v, 'last_name')) o.lastName = text(v.last_name, 'last_name', { max: 120, re: SAFE_LINE });
    if (present(v, 'email')) o.email = email(v.email, 'email');
    if (present(v, 'phone')) o.phone = phone(v.phone, 'phone');
    if (Object.prototype.hasOwnProperty.call(v, 'note')) o.note = v.note === null ? '' : text(v.note, 'note', { min: 0, max: 5000 });
    if (present(v, 'tags')) o.tags = tags(v.tags, 'tags');
    // Shopify يطلب اسمًا أو بريدًا أو هاتفًا؛ لا موافقات تسويق من هنا
    if (!update && !(o.firstName || o.lastName || o.email || o.phone)) bad('input');
    if (update && Object.keys(o).length === 1) bad('input');
    return o;
}
function inventoryChanges(group) {
    return (Array.isArray(group?.changes) ? group.changes : []).slice(0, 60).map((c) => ({
        name: shortText(c?.name, 30), delta: intOf(c?.delta), quantity_after: intOf(c?.quantityAfterChange),
        inventory_item_id: c?.item?.id || null, location_id: c?.location?.id || null
    }));
}
function publishOp(root) {
    return {
        ...W('store.catalog', ['write_publications'], true),
        validate: (v) => (only(v, ['id', 'publication_ids']), { id: gidOf('Product', v.id, 'id'), publication_ids: ids('Publication', v.publication_ids, 'publication_ids', 10) }),
        // القنوات من Shopify: معرّف قناة لا يملكها المتجر = رفض قبل الإرسال
        async check(ctx, v) {
            const pubs = await publicationIds(ctx);
            const p = await shopifyNode(ctx, D.productPublished, v.id, 'product');
            const published = new Set(nodes(p.resourcePublicationsV2).filter((x) => x?.isPublished).map((x) => x?.publication?.id));
            return { publications: v.publication_ids.map((id, i) => {
                const pub = pubs.find((x) => x.id === id);
                if (!pub) throw notEligible(`publication_ids.${i}`);
                return { id, title: pub.title, published: published.has(id) };
            }) };
        },
        async run(ctx, v) {
            await mutate(ctx, `mutation ($id: ID!, $input: [PublicationInput!]!) { ${root}(id: $id, input: $input) { ${UE} } }`,
                { id: v.id, input: v.publication_ids.map((publicationId) => ({ publicationId })) }, root);
            return { result: { id: v.id, publications: v.publication_ids }, resource: refOf(v.id), detail: { publications: v.publication_ids.map(refOf) } };
        }
    };
}
async function discountSummary(ctx, v) {
    const n = v.type === 'code' ? await shopifyNode(ctx, D.codeDiscount, v.id, 'codeDiscountNode')
                                : await shopifyNode(ctx, D.automaticDiscount, v.id, 'automaticDiscountNode');
    const d = mapDiscount(v.type, n);
    return { title: d.title, status: d.status, code: d.code, summary: d.summary, starts_at: d.starts_at, ends_at: d.ends_at };
}
function discountWrite(kind, update) {
    const create = kind === 'code' ? 'discountCodeBasicCreate' : 'discountAutomaticBasicCreate';
    const upd = kind === 'code' ? 'discountCodeBasicUpdate' : 'discountAutomaticBasicUpdate';
    const arg = kind === 'code' ? 'basicCodeDiscount' : 'automaticBasicDiscount';
    const inputType = kind === 'code' ? 'DiscountCodeBasicInput' : 'DiscountAutomaticBasicInput';
    const node = kind === 'code' ? 'codeDiscountNode' : 'automaticDiscountNode';
    const idType = kind === 'code' ? 'DiscountCodeNode' : 'DiscountAutomaticNode';
    return {
        ...W('store.discounts', ['write_discounts'], true),
        validate(v, { nowMs = Date.now() } = {}) {
            const input = discountInput(obj(v, 'input'), kind, nowMs, { update });
            return update ? { id: gidOf(idType, v.id, 'id'), input } : { input };
        },
        async check(ctx, v) {
            const current = update ? await discountSummary(ctx, { type: kind, id: v.id }) : null;
            // تعديل النهاية وحدها: يجب أن تبقى بعد البداية الحالية في Shopify
            if (current && v.input.endsAt && !v.input.startsAt && current.starts_at && Date.parse(v.input.endsAt) <= Date.parse(current.starts_at)) {
                throw notEligible('ends_at');
            }
            const value = v.input.customerGets?.value;
            return { current, title: v.input.title, code: v.input.code, starts_at: v.input.startsAt, ends_at: v.input.endsAt,
                     value: value ? (value.percentage !== undefined ? { percentage: Math.round(value.percentage * 10000) / 100 } : { amount: value.discountAmount.amount }) : null,
                     items: v.input.customerGets?.items ? Object.keys(v.input.customerGets.items)[0] : null,
                     usage_limit: v.input.usageLimit, once_per_customer: v.input.appliesOncePerCustomer };
        },
        async run(ctx, v) {
            const p = update
                ? await mutate(ctx, `mutation ($id: ID!, $input: ${inputType}!) { ${upd}(id: $id, ${arg}: $input) { ${node} { id } ${UEC} } }`, { id: v.id, input: v.input }, upd)
                : await mutate(ctx, `mutation ($input: ${inputType}!) { ${create}(${arg}: $input) { ${node} { id } ${UEC} } }`, { input: v.input }, create);
            const id = p[node]?.id || null;
            return { result: { id }, resource: refOf(id || v.id), detail: { fields: Object.keys(v.input) } };
        }
    };
}
function discountToggle(activate) {
    return {
        ...W('store.discounts', ['write_discounts'], true),
        validate: DISCOUNT_REF,
        async check(ctx, v) {
            const s = await discountSummary(ctx, v);
            if (activate ? s.status === 'ACTIVE' : s.status !== 'ACTIVE' && s.status !== 'SCHEDULED') throw notEligible(activate ? 'already_active' : 'not_active');
            return s;
        },
        async run(ctx, v) {
            const isCode = v.type === 'code';
            const root = `discount${isCode ? 'Code' : 'Automatic'}${activate ? 'Activate' : 'Deactivate'}`;
            const node = isCode ? 'codeDiscountNode' : 'automaticDiscountNode';
            await mutate(ctx, `mutation ($id: ID!) { ${root}(id: $id) { ${node} { id } ${UEC} } }`, { id: v.id }, root);
            return { result: { id: v.id, active: activate }, resource: refOf(v.id) };
        }
    };
}
function returnTransition(root, fromStatuses, args, extra) {
    return {
        ...W('store.returns', ['write_returns'], true),
        validate(v) {
            only(v, ['id', ...extra]);
            const o = { id: gidOf('Return', v.id, 'id') };
            if (extra.includes('notify_customer')) o.notify_customer = present(v, 'notify_customer') ? bool(v.notify_customer, 'notify_customer') : false;
            if (extra.includes('reason')) o.reason = oneOf(v.reason, 'reason', ['FINAL_SALE', 'OTHER', 'RETURN_PERIOD_ENDED']);
            if (extra.includes('note')) o.note = present(v, 'note') ? text(v.note, 'note', { max: 500 }) : null;
            return o;
        },
        async check(ctx, v) {
            const r = await shopifyNode(ctx, D.returnOne, v.id, 'return');
            if (!fromStatuses.includes(r.status)) throw notEligible('return_status');
            return { name: shortText(r.name, 40), status: enumOf(r.status), refund: false, notify_customer: v.notify_customer ?? false };
        },
        async run(ctx, v) {
            const vars = args(v);
            const sig = Object.prototype.hasOwnProperty.call(vars, 'input')
                ? `($input: ${root === 'returnApproveRequest' ? 'ReturnApproveRequestInput' : 'ReturnDeclineRequestInput'}!) { ${root}(input: $input)`
                : `($id: ID!) { ${root}(id: $id)`;
            const p = await mutate(ctx, `mutation ${sig} { return { id status } ${UEC} } }`, vars, root);
            return { result: { id: p.return?.id, status: enumOf(p.return?.status) }, resource: refOf(v.id), detail: v.reason ? { reason: v.reason } : {} };
        }
    };
}

export const OPERATION_KEYS = Object.freeze(Object.keys(OPERATIONS).sort());
/** وثائق الاستعلام — للاختبارات (التحقق من المخطط). */
export const _DOCS = D;

/** التحقق من المدخلات (خالص). nowMs للاختبارات فقط (نوافذ الخصومات). */
export function validateOperation(op, input, { nowMs } = {}) {
    const def = OPERATIONS[op];
    if (!def) throw new ConnectorError('unsupported', 'op');
    return def.validate(input ?? {}, { nowMs });
}
