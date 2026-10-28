/**
 * store-manage-model.js — نموذج صفحة «إدارة المتجر» (120). دوال خالصة، مُختبرة في node.
 *
 * النماذج هنا تجمع المدخلات وتبنيها بالشكل الذي تنتظره الدالة الطرفية؛ لا قرار هنا. الخادم يتحقق من
 * كل حقل بصرامة، والقاعدة تقرر الصلاحية والنطاق والتأكيد والحد (ihub_shopify_op_*). ما يظهر من
 * الأزرار يأتي من ihub_shopify_manage_status (صلاحية المستخدم ونطاقات Shopify الممنوحة فعلًا).
 */

import { FINANCIAL_STATUS, FULFILLMENT_STATUS, PRODUCT_STATUS, statusLabel } from './store-model.js';

export const MANAGE_SECTIONS = Object.freeze([
    { key: 'shop', label: 'المتجر والمواقع', read: 'shop.info' },
    { key: 'products', label: 'المنتجات', read: 'product.list' },
    { key: 'collections', label: 'المجموعات', read: 'collection.list' },
    { key: 'orders', label: 'الطلبات', read: 'order.list' },
    { key: 'drafts', label: 'مسودات الطلبات', read: 'draft_order.list' },
    { key: 'customers', label: 'العملاء', read: 'customer.list' },
    { key: 'inventory', label: 'المخزون', read: 'location.list' },
    { key: 'discounts', label: 'الخصومات', read: 'discount.list' },
    { key: 'log', label: 'سجل العمليات', read: null, adminOnly: true }
]);

export const OP_LABELS = Object.freeze({
    'product.create': 'منتج جديد', 'product.update': 'تعديل المنتج', 'product.set_status': 'تغيير حالة المنتج',
    'product.archive': 'أرشفة المنتج', 'product.delete': 'حذف المنتج', 'product.publish': 'نشر في قنوات البيع',
    'product.unpublish': 'إلغاء النشر', 'product.set_collections': 'مجموعات المنتج', 'variant.create': 'متغير جديد',
    'variant.update': 'تعديل المتغير', 'variant.delete': 'حذف المتغير', 'metafield.set': 'حقل مخصص',
    'collection.create': 'مجموعة جديدة', 'collection.update': 'تعديل المجموعة', 'collection.delete': 'حذف المجموعة',
    'order.update_notes': 'ملاحظات الطلب ووسومه', 'order.update_contact': 'بيانات التواصل والشحن', 'order.create': 'طلب جديد',
    'order.cancel': 'إلغاء الطلب', 'draft_order.create': 'مسودة طلب جديدة', 'draft_order.update': 'تعديل المسودة',
    'draft_order.delete': 'حذف المسودة', 'customer.create': 'عميل جديد', 'customer.update': 'تعديل العميل',
    'inventory.adjust': 'تعديل الكمية (+/−)', 'inventory.set': 'ضبط الكمية', 'inventory.activate': 'تخزين في موقع',
    'discount.code_create': 'خصم بكود', 'discount.code_update': 'تعديل خصم الكود', 'discount.automatic_create': 'خصم تلقائي',
    'discount.automatic_update': 'تعديل الخصم التلقائي', 'discount.activate': 'تفعيل الخصم', 'discount.deactivate': 'إيقاف الخصم',
    'discount.delete': 'حذف الخصم', 'fulfillment.create': 'تنفيذ وشحن', 'fulfillment.tracking_update': 'تحديث التتبّع',
    'return.create': 'إنشاء مرتجع', 'return.approve': 'قبول طلب الإرجاع', 'return.decline': 'رفض طلب الإرجاع',
    'return.cancel': 'إلغاء المرتجع', 'return.close': 'إغلاق المرتجع'
});

/** ما يحدث فعلًا — يظهر في نافذة التأكيد. */
export const CONSEQUENCES = Object.freeze({
    'product.set_status': 'يتغير ظهور المنتج: «نشط» يجعله متاحًا للبيع في القنوات المنشور فيها.',
    'product.archive': 'يُخفى المنتج من كل قنوات البيع. يمكن إعادته لاحقًا من Shopify.',
    'product.delete': 'يُحذف المنتج ومتغيراته من Shopify نهائيًا. لا يمكن التراجع.',
    'product.publish': 'يظهر المنتج للعملاء في القنوات المختارة.',
    'product.unpublish': 'يختفي المنتج من القنوات المختارة.',
    'variant.update': 'تتغير الأسعار أو بيانات المخزون في Shopify فورًا.',
    'variant.delete': 'تُحذف المتغيرات المختارة نهائيًا.',
    'collection.delete': 'تُحذف المجموعة من Shopify نهائيًا (المنتجات نفسها تبقى).',
    'order.update_contact': 'تتغير بيانات التواصل أو عنوان الشحن على الطلب في Shopify.',
    'order.create': 'يُنشأ طلب حقيقي في Shopify بحالة دفع «قيد الانتظار» — لا يُحصَّل أي مبلغ. الأسعار من Shopify.',
    'order.cancel': 'يُلغى الطلب في Shopify دون أي استرداد مالي. لا يمكن التراجع.',
    'draft_order.delete': 'تُحذف المسودة نهائيًا.',
    'inventory.adjust': 'تتغير الكمية في Shopify فورًا، ويُسجَّل التعديل وسببه.',
    'inventory.set': 'تُضبط الكمية في Shopify على الرقم المحدد، ويُسجَّل التعديل وسببه.',
    'inventory.activate': 'يبدأ تخزين المنتج في الموقع المختار.',
    'discount.code_create': 'يصبح الكود صالحًا للعملاء في الفترة المحددة.',
    'discount.code_update': 'تتغير شروط الخصم للعملاء.',
    'discount.automatic_create': 'يُطبَّق الخصم تلقائيًا على السلال المؤهلة في الفترة المحددة.',
    'discount.automatic_update': 'تتغير شروط الخصم التلقائي.',
    'discount.activate': 'يصبح الخصم فعّالًا للعملاء.',
    'discount.deactivate': 'يتوقف الخصم فورًا.',
    'discount.delete': 'يُحذف الخصم نهائيًا.',
    'fulfillment.create': 'تُسجَّل الكميات المختارة مشحونة في Shopify.',
    'fulfillment.tracking_update': 'تتغير بيانات التتبّع على الشحنة.',
    'return.create': 'يُنشأ مرتجع في Shopify — بلا أي استرداد مالي.',
    'return.approve': 'يُقبل طلب الإرجاع (بلا استرداد مالي من هنا).',
    'return.decline': 'يُرفض طلب الإرجاع.',
    'return.cancel': 'يُلغى المرتجع.',
    'return.close': 'يُغلق المرتجع.'
});

const ADDRESS_FIELDS = [
    { name: 'first_name', label: 'الاسم الأول', type: 'text', group: 'address' },
    { name: 'last_name', label: 'اسم العائلة', type: 'text', group: 'address' },
    { name: 'address1', label: 'العنوان', type: 'text', group: 'address' },
    { name: 'address2', label: 'العنوان (تكملة)', type: 'text', group: 'address' },
    { name: 'city', label: 'المدينة', type: 'text', group: 'address' },
    { name: 'zip', label: 'الرمز البريدي', type: 'text', group: 'address' },
    { name: 'country_code', label: 'رمز الدولة (مثل EG)', type: 'text', group: 'address', maxlength: 2 }
];
const INVENTORY_NAMES = [['available', 'متاح للبيع'], ['on_hand', 'في المخزن']];
export const INVENTORY_REASON_LABELS = Object.freeze({
    correction: 'تصحيح', cycle_count_available: 'جرد', damaged: 'تالف', other: 'سبب آخر', promotion: 'عرض أو هدية',
    quality_control: 'فحص الجودة', received: 'استلام بضاعة', restock: 'إعادة للمخزون', safety_stock: 'مخزون أمان', shrinkage: 'فقد أو سرقة'
});
const REASONS = Object.entries(INVENTORY_REASON_LABELS);
const CANCEL_REASONS = [['CUSTOMER', 'طلب العميل'], ['DECLINED', 'رُفض الدفع'], ['FRAUD', 'احتيال'], ['INVENTORY', 'نفاد المخزون'], ['STAFF', 'خطأ من الفريق'], ['OTHER', 'سبب آخر']];
const COLLECTION_SORT = [['MANUAL', 'يدوي'], ['BEST_SELLING', 'الأكثر مبيعًا'], ['ALPHA_ASC', 'أبجدي تصاعدي'], ['ALPHA_DESC', 'أبجدي تنازلي'],
                         ['PRICE_ASC', 'السعر تصاعدي'], ['PRICE_DESC', 'السعر تنازلي'], ['CREATED', 'الأقدم'], ['CREATED_DESC', 'الأحدث']];
const KEEP_YES_NO = [['', 'بلا تغيير'], ['yes', 'نعم'], ['no', 'لا']];

/* ── تحويل القيم ───────────────────────────────────────────────────────── */

const s = (v) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim());
const put = (o, k, v) => { if (v !== '' && v !== undefined && v !== null) o[k] = v; return o; };
const splitList = (v) => s(v).split(/[,\n،]/).map((x) => x.trim()).filter(Boolean);
const tri = (v) => (v === 'yes' ? true : v === 'no' ? false : undefined);
const intOrRaw = (v) => (/^-?[0-9]{1,9}$/.test(s(v)) ? Number(s(v)) : s(v));
const isoOrRaw = (v) => {
    const t = s(v);
    if (!t) return '';
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : t;
};
/** «201 × 2» أو «201 x 2» أو «201,2» لكل سطر. */
export function parseLines(text) {
    return s(text).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const m = l.match(/^(gid:\/\/shopify\/ProductVariant\/[0-9]+|[0-9]{1,20})\s*(?:[x×*,:]\s*([0-9]{1,6}))?$/i);
        return m ? { variant_id: m[1], quantity: m[2] ? Number(m[2]) : 1 } : { variant_id: l, quantity: 0 };
    });
}
/** «المقاس: S، M، L» لكل سطر. */
export function parseOptions(text) {
    return s(text).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const [name, rest = ''] = l.split(/[:：]/);
        return { name: s(name), values: splitList(rest) };
    });
}
function address(v) {
    const a = {};
    for (const f of ADDRESS_FIELDS) put(a, f.name, f.name === 'country_code' ? s(v[f.name]).toUpperCase() : s(v[f.name]));
    return Object.keys(a).length ? a : undefined;
}
function discountValue(v) {
    if (!s(v.amount)) return undefined;
    const out = { type: v.value_type === 'fixed_amount' ? 'fixed_amount' : 'percentage', amount: s(v.amount) };
    if (out.type === 'fixed_amount' && v.each_item) out.each_item = true;
    return out;
}
function discountItems(v) {
    if (v.items === 'products') return { product_ids: splitList(v.item_ids) };
    if (v.items === 'collections') return { collection_ids: splitList(v.item_ids) };
    return { all: true };
}
function discountMinimum(v) {
    if (v.minimum_type === 'subtotal' && s(v.minimum_value)) return { subtotal: s(v.minimum_value) };
    if (v.minimum_type === 'quantity' && s(v.minimum_value)) return { quantity: intOrRaw(v.minimum_value) };
    return undefined;
}
function discountCommon(v, { create }) {
    const o = {};
    put(o, 'title', s(v.title));
    put(o, 'starts_at', isoOrRaw(v.starts_at));
    put(o, 'ends_at', isoOrRaw(v.ends_at));
    const value = discountValue(v);
    if (value) { o.value = value; o.items = discountItems(v); }
    const min = discountMinimum(v);
    if (min) o.minimum = min;
    if (create) o.combines_with = { order: !!v.combine_order, product: !!v.combine_product, shipping: !!v.combine_shipping };
    return o;
}
const DISCOUNT_FIELDS = (kind, { create }) => [
    { name: 'title', label: 'العنوان', type: 'text', required: create },
    ...(kind === 'code' ? [{ name: 'code', label: 'الكود', type: 'text', required: create, hint: 'حروف إنجليزية وأرقام و - _ (3–40)', hide: !create }] : []),
    { name: 'value_type', label: 'نوع القيمة', type: 'select', options: [['percentage', 'نسبة مئوية'], ['fixed_amount', 'مبلغ ثابت']] },
    { name: 'amount', label: 'القيمة', type: 'money', required: create, hint: 'النسبة من 1 إلى 100، أو المبلغ بعملة المتجر' },
    { name: 'each_item', label: 'المبلغ لكل قطعة', type: 'checkbox' },
    { name: 'items', label: 'يسري على', type: 'select', options: create ? [['all', 'كل المنتجات'], ['products', 'منتجات محددة'], ['collections', 'مجموعات محددة']] : [['all', 'كل المنتجات']] },
    ...(create ? [{ name: 'item_ids', label: 'معرّفات المنتجات أو المجموعات', type: 'text', hint: 'مفصولة بفواصل' }] : []),
    { name: 'starts_at', label: 'يبدأ', type: 'datetime', required: create },
    { name: 'ends_at', label: 'ينتهي', type: 'datetime' },
    ...(kind === 'code' ? [{ name: 'usage_limit', label: 'حد الاستخدام الكلي', type: 'int' },
                           create ? { name: 'once_per_customer', label: 'مرة واحدة لكل عميل', type: 'checkbox' }
                                  : { name: 'once_per_customer', label: 'مرة واحدة لكل عميل', type: 'select', options: KEEP_YES_NO }] : []),
    { name: 'minimum_type', label: 'حد أدنى', type: 'select', options: [['none', 'بلا حد أدنى'], ['subtotal', 'مبلغ السلة'], ['quantity', 'عدد القطع']] },
    { name: 'minimum_value', label: 'قيمة الحد الأدنى', type: 'text' },
    ...(create ? [{ name: 'combine_order', label: 'يجتمع مع خصومات الطلب', type: 'checkbox' },
                  { name: 'combine_product', label: 'يجتمع مع خصومات المنتجات', type: 'checkbox' },
                  { name: 'combine_shipping', label: 'يجتمع مع خصومات الشحن', type: 'checkbox' }] : [])
].filter((f) => !f.hide);

/**
 * نماذج عمليات الكتابة: fields للعرض، build(values, ctx) يبني مدخل الدالة الطرفية.
 * ctx = معرّفات السجل المفتوح (من Shopify عبر الخادم) — لا يدخلها المستخدم.
 */
export const FORMS = Object.freeze({
    'product.create': {
        fields: [{ name: 'title', label: 'اسم المنتج', type: 'text', required: true, maxlength: 255 },
                 { name: 'description_html', label: 'الوصف', type: 'textarea', hint: 'حتى 10000 حرف، بلا سكربتات أو إطارات' },
                 { name: 'vendor', label: 'المورّد', type: 'text' }, { name: 'product_type', label: 'النوع', type: 'text' },
                 { name: 'tags', label: 'الوسوم', type: 'text', hint: 'مفصولة بفواصل' },
                 { name: 'options', label: 'الخيارات', type: 'textarea', hint: 'سطر لكل خيار: المقاس: S، M، L' }],
        note: 'يُنشأ المنتج «مسودة» دائمًا. فعّله بعد مراجعته.',
        build: (v) => {
            const o = put({}, 'title', s(v.title));
            put(o, 'description_html', s(v.description_html)); put(o, 'vendor', s(v.vendor)); put(o, 'product_type', s(v.product_type));
            if (splitList(v.tags).length) o.tags = splitList(v.tags);
            if (parseOptions(v.options).length) o.options = parseOptions(v.options);
            return o;
        }
    },
    'product.update': {
        fields: [{ name: 'title', label: 'اسم المنتج', type: 'text', maxlength: 255 }, { name: 'description_html', label: 'الوصف', type: 'textarea' },
                 { name: 'vendor', label: 'المورّد', type: 'text' }, { name: 'product_type', label: 'النوع', type: 'text' },
                 { name: 'tags', label: 'الوسوم (تستبدل الحالية)', type: 'text' }],
        prefill: (r) => ({ title: r.title, description_html: r.description_html, vendor: r.vendor, product_type: r.product_type, tags: (r.tags || []).join('، ') }),
        build: (v, c) => {
            const o = { id: c.id };
            put(o, 'title', s(v.title)); put(o, 'description_html', s(v.description_html)); put(o, 'vendor', s(v.vendor)); put(o, 'product_type', s(v.product_type));
            if (s(v.tags)) o.tags = splitList(v.tags);
            return o;
        }
    },
    'product.set_status': { fields: [{ name: 'status', label: 'الحالة', type: 'select', options: [['ACTIVE', 'نشط'], ['DRAFT', 'مسودة']] }],
                            build: (v, c) => ({ id: c.id, status: v.status }) },
    'product.archive': { fields: [], build: (v, c) => ({ id: c.id }) },
    'product.delete': { fields: [], build: (v, c) => ({ id: c.id }) },
    'product.publish': { fields: [{ name: 'publication_ids', label: 'القنوات', type: 'choices', from: 'publications' }],
                         build: (v, c) => ({ id: c.id, publication_ids: v.publication_ids || [] }) },
    'product.unpublish': { fields: [{ name: 'publication_ids', label: 'القنوات', type: 'choices', from: 'publications' }],
                           build: (v, c) => ({ id: c.id, publication_ids: v.publication_ids || [] }) },
    'product.set_collections': {
        fields: [{ name: 'join', label: 'إضافة إلى المجموعات (معرّفات)', type: 'text' }, { name: 'leave', label: 'إزالة من المجموعات (معرّفات)', type: 'text' }],
        build: (v, c) => {
            const o = { id: c.id };
            if (splitList(v.join).length) o.join = splitList(v.join);
            if (splitList(v.leave).length) o.leave = splitList(v.leave);
            return o;
        }
    },
    'variant.create': {
        fields: [{ name: 'option1_name', label: 'الخيار', type: 'text', required: true, hint: 'مثل: المقاس' }, { name: 'option1_value', label: 'القيمة', type: 'text', required: true },
                 { name: 'option2_name', label: 'خيار ثانٍ', type: 'text' }, { name: 'option2_value', label: 'قيمته', type: 'text' },
                 { name: 'price', label: 'السعر', type: 'money', required: true }, { name: 'compare_at_price', label: 'السعر قبل الخصم', type: 'money' },
                 { name: 'sku', label: 'SKU', type: 'text' }, { name: 'tracked', label: 'تتبّع المخزون', type: 'checkbox' }],
        build: (v, c) => {
            const options = [[v.option1_name, v.option1_value], [v.option2_name, v.option2_value]].filter(([n, x]) => s(n) || s(x)).map(([n, x]) => ({ name: s(n), value: s(x) }));
            const variant = put({ options }, 'price', s(v.price));
            put(variant, 'compare_at_price', s(v.compare_at_price)); put(variant, 'sku', s(v.sku));
            if (v.tracked) variant.tracked = true;
            return { product_id: c.product_id, variants: [variant] };
        }
    },
    'variant.update': {
        fields: [{ name: 'price', label: 'السعر', type: 'money' }, { name: 'compare_at_price', label: 'السعر قبل الخصم', type: 'money' },
                 { name: 'clear_compare', label: 'إزالة السعر قبل الخصم', type: 'checkbox' }, { name: 'sku', label: 'SKU', type: 'text' },
                 { name: 'tracked', label: 'تتبّع المخزون', type: 'select', options: KEEP_YES_NO },
                 { name: 'inventory_policy', label: 'عند نفاد المخزون', type: 'select', options: [['', 'بلا تغيير'], ['DENY', 'إيقاف البيع'], ['CONTINUE', 'متابعة البيع']] }],
        prefill: (r) => ({ price: r.price, sku: r.sku }),
        build: (v, c) => {
            const x = { id: c.variant_id };
            put(x, 'price', s(v.price)); put(x, 'sku', s(v.sku)); put(x, 'inventory_policy', s(v.inventory_policy));
            if (v.clear_compare) x.compare_at_price = null; else put(x, 'compare_at_price', s(v.compare_at_price));
            if (tri(v.tracked) !== undefined) x.tracked = tri(v.tracked);
            return { product_id: c.product_id, variants: [x] };
        }
    },
    'variant.delete': { fields: [], build: (v, c) => ({ product_id: c.product_id, variant_ids: [c.variant_id] }) },
    'metafield.set': {
        fields: [{ name: 'namespace', label: 'النطاق', type: 'text', required: true, hint: 'مثل custom' }, { name: 'key', label: 'المفتاح', type: 'text', required: true },
                 { name: 'type', label: 'النوع', type: 'select', options: [['single_line_text_field', 'نص قصير'], ['multi_line_text_field', 'نص طويل'],
                                                                         ['number_integer', 'عدد صحيح'], ['number_decimal', 'عدد عشري'], ['boolean', 'نعم/لا (true/false)'],
                                                                         ['url', 'رابط https'], ['date', 'تاريخ YYYY-MM-DD']] },
                 { name: 'value', label: 'القيمة', type: 'textarea', required: true }],
        build: (v, c) => ({ owner_id: c.owner_id, namespace: s(v.namespace), key: s(v.key), type: v.type, value: typeof v.value === 'string' ? v.value : '' })
    },
    'collection.create': {
        fields: [{ name: 'title', label: 'اسم المجموعة', type: 'text', required: true }, { name: 'description_html', label: 'الوصف', type: 'textarea' },
                 { name: 'sort_order', label: 'ترتيب المنتجات', type: 'select', options: COLLECTION_SORT }],
        note: 'مجموعة يدوية؛ أضف المنتجات من صفحة كل منتج.',
        build: (v) => put(put(put({}, 'title', s(v.title)), 'description_html', s(v.description_html)), 'sort_order', s(v.sort_order))
    },
    'collection.update': {
        fields: [{ name: 'title', label: 'اسم المجموعة', type: 'text' }, { name: 'description_html', label: 'الوصف', type: 'textarea' },
                 { name: 'sort_order', label: 'ترتيب المنتجات', type: 'select', options: [['', 'بلا تغيير'], ...COLLECTION_SORT] }],
        prefill: (r) => ({ title: r.title, description_html: r.description_html }),
        build: (v, c) => put(put(put({ id: c.id }, 'title', s(v.title)), 'description_html', s(v.description_html)), 'sort_order', s(v.sort_order))
    },
    'collection.delete': { fields: [], build: (v, c) => ({ id: c.id }) },
    'order.update_notes': {
        fields: [{ name: 'note', label: 'ملاحظة', type: 'textarea' }, { name: 'tags', label: 'الوسوم (تستبدل الحالية)', type: 'text' }],
        prefill: (r) => ({ note: r.note, tags: (r.tags || []).join('، ') }),
        build: (v, c) => {
            const o = { id: c.id, note: s(v.note) };
            if (s(v.tags)) o.tags = splitList(v.tags);
            return o;
        }
    },
    'order.update_contact': {
        fields: [{ name: 'email', label: 'البريد', type: 'text' }, { name: 'phone', label: 'الهاتف (+201…)', type: 'text' }, ...ADDRESS_FIELDS],
        build: (v, c) => {
            const o = { id: c.id };
            put(o, 'email', s(v.email)); put(o, 'phone', s(v.phone));
            const a = address(v);
            if (a) o.shipping_address = a;
            return o;
        }
    },
    'order.create': {
        fields: [{ name: 'lines', label: 'المنتجات', type: 'textarea', required: true, hint: 'سطر لكل متغير: معرّف المتغير × الكمية (مثل 201 × 2)' },
                 { name: 'customer_id', label: 'معرّف العميل', type: 'text' }, { name: 'email', label: 'البريد', type: 'text' },
                 ...ADDRESS_FIELDS, { name: 'note', label: 'ملاحظة', type: 'textarea' }, { name: 'tags', label: 'الوسوم', type: 'text' },
                 { name: 'inventory', label: 'المخزون', type: 'select', options: [['DECREMENT_OBEYING_POLICY', 'خصم من المخزون حسب سياسة المنتج'], ['BYPASS', 'بلا خصم من المخزون']] },
                 { name: 'test', label: 'طلب تجريبي', type: 'checkbox' },
                 { name: 'send_receipt', label: 'أرسل إيصالًا للعميل', type: 'checkbox', hint: 'رسالة من Shopify للعميل — لا تُرسل إلا باختيارك' }],
        note: 'الأسعار تؤخذ من Shopify وقت الإنشاء. الطلب يُنشأ «قيد انتظار الدفع» ولا يُحصَّل أي مبلغ.',
        build: (v) => {
            const o = { lines: parseLines(v.lines) };
            put(o, 'customer_id', s(v.customer_id)); put(o, 'email', s(v.email)); put(o, 'note', s(v.note)); put(o, 'inventory', s(v.inventory));
            if (splitList(v.tags).length) o.tags = splitList(v.tags);
            const a = address(v);
            if (a) o.shipping_address = a;
            if (v.test) o.test = true;
            if (v.send_receipt) o.send_receipt = true;
            return o;
        }
    },
    'order.cancel': {
        fields: [{ name: 'reason', label: 'السبب', type: 'select', options: CANCEL_REASONS, required: true },
                 { name: 'restock', label: 'إعادة الكميات للمخزون', type: 'checkbox' },
                 { name: 'notify_customer', label: 'إخطار العميل من Shopify', type: 'checkbox' }, { name: 'staff_note', label: 'ملاحظة للفريق', type: 'text' }],
        note: 'يُلغى من هنا الطلب غير المدفوع وغير المنفَّذ فقط، ودون أي استرداد. الطلب المدفوع يُلغى من لوحة Shopify.',
        build: (v, c) => put({ id: c.id, reason: v.reason, restock: !!v.restock, notify_customer: !!v.notify_customer }, 'staff_note', s(v.staff_note))
    },
    'draft_order.create': {
        fields: [{ name: 'lines', label: 'المنتجات', type: 'textarea', required: true, hint: 'سطر لكل متغير: معرّف المتغير × الكمية' },
                 { name: 'customer_id', label: 'معرّف العميل', type: 'text' }, { name: 'email', label: 'البريد', type: 'text' },
                 { name: 'note', label: 'ملاحظة', type: 'textarea' }, { name: 'tags', label: 'الوسوم', type: 'text' },
                 { name: 'discount_percent', label: 'خصم %', type: 'money' }, { name: 'discount_title', label: 'اسم الخصم', type: 'text' }],
        note: 'المسودة لا تُكمَل من مدعوم: إكمالها يعلّم الطلب مدفوعًا، فيتم من لوحة Shopify.',
        build: (v) => draftBuild(v, {})
    },
    'draft_order.update': {
        fields: [{ name: 'lines', label: 'المنتجات (تستبدل الحالية)', type: 'textarea' }, { name: 'email', label: 'البريد', type: 'text' },
                 { name: 'note', label: 'ملاحظة', type: 'textarea' }, { name: 'tags', label: 'الوسوم', type: 'text' },
                 { name: 'discount_percent', label: 'خصم %', type: 'money' }, { name: 'discount_title', label: 'اسم الخصم', type: 'text' }],
        prefill: (r) => ({ note: r.note, email: r.email, tags: (r.tags || []).join('، ') }),
        build: (v, c) => draftBuild(v, { id: c.id })
    },
    'draft_order.delete': { fields: [], build: (v, c) => ({ id: c.id }) },
    'customer.create': {
        fields: CUSTOMER_FIELDS(),
        note: 'لا تُسجَّل موافقات تسويق من هنا.',
        build: (v) => customerBuild(v, {})
    },
    'customer.update': {
        fields: CUSTOMER_FIELDS(),
        prefill: (r) => ({ first_name: r.first_name, last_name: r.last_name, email: r.email, phone: r.phone, note: r.note, tags: (r.tags || []).join('، ') }),
        build: (v, c) => customerBuild(v, { id: c.id })
    },
    'inventory.adjust': {
        fields: [{ name: 'name', label: 'الكمية', type: 'select', options: INVENTORY_NAMES }, { name: 'reason', label: 'السبب', type: 'select', options: REASONS, required: true },
                 { name: 'delta', label: 'الفرق (+ أو −)', type: 'int', required: true }, { name: 'expected_quantity', label: 'الكمية الحالية كما تراها', type: 'int', required: true,
                   hint: 'إن تغيّرت في Shopify قبل التنفيذ يُرفض التعديل' }],
        prefill: (r) => ({ expected_quantity: r.available ?? '' }),
        build: (v, c) => ({ name: v.name || 'available', reason: v.reason, changes: [{ inventory_item_id: c.inventory_item_id, location_id: c.location_id,
                                                                                       delta: intOrRaw(v.delta), expected_quantity: intOrRaw(v.expected_quantity) }] })
    },
    'inventory.set': {
        fields: [{ name: 'name', label: 'الكمية', type: 'select', options: INVENTORY_NAMES }, { name: 'reason', label: 'السبب', type: 'select', options: REASONS, required: true },
                 { name: 'quantity', label: 'الكمية الجديدة', type: 'int', required: true }, { name: 'expected_quantity', label: 'الكمية الحالية كما تراها', type: 'int', required: true }],
        prefill: (r) => ({ expected_quantity: r.available ?? '' }),
        build: (v, c) => ({ name: v.name || 'available', reason: v.reason, quantities: [{ inventory_item_id: c.inventory_item_id, location_id: c.location_id,
                                                                                         quantity: intOrRaw(v.quantity), expected_quantity: intOrRaw(v.expected_quantity) }] })
    },
    'inventory.activate': {
        fields: [{ name: 'location_id', label: 'الموقع', type: 'select', from: 'locations', required: true }, { name: 'available', label: 'الكمية المتاحة', type: 'int' }],
        build: (v, c) => put({ inventory_item_id: c.inventory_item_id, location_id: v.location_id }, 'available', s(v.available) === '' ? '' : intOrRaw(v.available))
    },
    'discount.code_create': { fields: DISCOUNT_FIELDS('code', { create: true }), build: (v) => {
        const o = discountCommon(v, { create: true });
        put(o, 'code', s(v.code)); put(o, 'usage_limit', s(v.usage_limit) === '' ? '' : intOrRaw(v.usage_limit));
        if (v.once_per_customer) o.once_per_customer = true;
        return o;
    } },
    'discount.code_update': { fields: DISCOUNT_FIELDS('code', { create: false }), build: (v, c) => {
        const o = { id: c.id, ...discountCommon(v, { create: false }) };
        put(o, 'usage_limit', s(v.usage_limit) === '' ? '' : intOrRaw(v.usage_limit));
        if (tri(v.once_per_customer) !== undefined) o.once_per_customer = tri(v.once_per_customer);
        return o;
    } },
    'discount.automatic_create': { fields: DISCOUNT_FIELDS('automatic', { create: true }), build: (v) => discountCommon(v, { create: true }) },
    'discount.automatic_update': { fields: DISCOUNT_FIELDS('automatic', { create: false }), build: (v, c) => ({ id: c.id, ...discountCommon(v, { create: false }) }) },
    'discount.activate': { fields: [], build: (v, c) => ({ type: c.type, id: c.id }) },
    'discount.deactivate': { fields: [], build: (v, c) => ({ type: c.type, id: c.id }) },
    'discount.delete': { fields: [], build: (v, c) => ({ type: c.type, id: c.id }) },
    'fulfillment.create': {
        fields: [{ name: 'quantities', label: 'الكميات المشحونة', type: 'quantities', from: 'fo_lines' },
                 { name: 'company', label: 'شركة الشحن', type: 'text' }, { name: 'number', label: 'رقم التتبّع', type: 'text' },
                 { name: 'url', label: 'رابط التتبّع (https)', type: 'text' }, { name: 'notify_customer', label: 'إخطار العميل من Shopify', type: 'checkbox' }],
        build: (v, c) => {
            const lines = Object.entries(v.quantities || {}).filter(([, q]) => s(q) !== '' && Number(q) > 0).map(([id, q]) => ({ id, quantity: intOrRaw(q) }));
            const o = { order_id: c.order_id, fulfillment_orders: [lines.length ? { id: c.fulfillment_order_id, lines } : { id: c.fulfillment_order_id }],
                        notify_customer: !!v.notify_customer };
            if (s(v.number)) o.tracking = put(put({ number: s(v.number) }, 'company', s(v.company)), 'url', s(v.url));
            return o;
        }
    },
    'fulfillment.tracking_update': {
        fields: [{ name: 'company', label: 'شركة الشحن', type: 'text' }, { name: 'number', label: 'رقم التتبّع', type: 'text', required: true },
                 { name: 'url', label: 'رابط التتبّع (https)', type: 'text' }, { name: 'notify_customer', label: 'إخطار العميل من Shopify', type: 'checkbox' }],
        build: (v, c) => ({ fulfillment_id: c.fulfillment_id, tracking: put(put({ number: s(v.number) }, 'company', s(v.company)), 'url', s(v.url)), notify_customer: !!v.notify_customer })
    },
    'return.create': {
        fields: [{ name: 'quantities', label: 'الكميات المرتجعة', type: 'quantities', from: 'returnable' }, { name: 'note', label: 'سبب الإرجاع', type: 'text' }],
        note: 'المرتجع لا يرد مالًا. الاسترداد يتم من لوحة Shopify.',
        build: (v, c) => ({ order_id: c.order_id, lines: Object.entries(v.quantities || {}).filter(([, q]) => s(q) !== '' && Number(q) > 0)
            .map(([id, q]) => put({ fulfillment_line_item_id: id, quantity: intOrRaw(q) }, 'note', s(v.note))) })
    },
    'return.approve': { fields: [{ name: 'notify_customer', label: 'إخطار العميل من Shopify', type: 'checkbox' }],
                        build: (v, c) => ({ id: c.id, notify_customer: !!v.notify_customer }) },
    'return.decline': { fields: [{ name: 'reason', label: 'السبب', type: 'select', required: true, options: [['FINAL_SALE', 'بيع نهائي'], ['RETURN_PERIOD_ENDED', 'انتهت مدة الإرجاع'], ['OTHER', 'سبب آخر']] },
                                 { name: 'note', label: 'ملاحظة', type: 'text' }, { name: 'notify_customer', label: 'إخطار العميل من Shopify', type: 'checkbox' }],
                        build: (v, c) => put({ id: c.id, reason: v.reason, notify_customer: !!v.notify_customer }, 'note', s(v.note)) },
    'return.cancel': { fields: [], build: (v, c) => ({ id: c.id }) },
    'return.close': { fields: [], build: (v, c) => ({ id: c.id }) }
});

function CUSTOMER_FIELDS() {
    return [{ name: 'first_name', label: 'الاسم الأول', type: 'text' }, { name: 'last_name', label: 'اسم العائلة', type: 'text' },
            { name: 'email', label: 'البريد', type: 'text' }, { name: 'phone', label: 'الهاتف (+201…)', type: 'text' },
            { name: 'note', label: 'ملاحظة', type: 'textarea' }, { name: 'tags', label: 'الوسوم', type: 'text' }];
}
function customerBuild(v, base) {
    const o = { ...base };
    for (const k of ['first_name', 'last_name', 'email', 'phone', 'note']) put(o, k, s(v[k]));
    if (splitList(v.tags).length) o.tags = splitList(v.tags);
    return o;
}
function draftBuild(v, base) {
    const o = { ...base };
    if (s(v.lines)) o.lines = parseLines(v.lines);
    put(o, 'customer_id', s(v.customer_id)); put(o, 'email', s(v.email)); put(o, 'note', s(v.note));
    if (splitList(v.tags).length) o.tags = splitList(v.tags);
    if (s(v.discount_percent)) o.discount = put({ percent: s(v.discount_percent) }, 'title', s(v.discount_title));
    return o;
}

/** تحقق خفيف قبل الإرسال (الحقول المطلوبة والأشكال الواضحة) — الخادم هو الحَكَم. */
export function formErrors(op, values) {
    const errors = {};
    for (const f of FORMS[op]?.fields || []) {
        const v = values[f.name];
        if (f.required && (f.type === 'checkbox' ? !v : f.type === 'choices' ? !(v || []).length : !s(v))) errors[f.name] = 'مطلوب';
        else if (f.type === 'money' && s(v) && !/^[0-9]{1,10}(\.[0-9]{1,4})?$/.test(s(v))) errors[f.name] = 'رقم موجب بحد أقصى 4 خانات عشرية';
        else if (f.type === 'int' && s(v) && !/^-?[0-9]{1,9}$/.test(s(v))) errors[f.name] = 'عدد صحيح';
    }
    if (op === 'order.create' || op === 'draft_order.create') {
        if (s(values.lines) && parseLines(values.lines).some((l) => !l.quantity)) errors.lines = 'كل سطر: معرّف المتغير × الكمية';
    }
    if ((op === 'product.publish' || op === 'product.unpublish') && !(values.publication_ids || []).length) errors.publication_ids = 'اختر قناة واحدة على الأقل';
    return errors;
}

/** حقل الخادم (مثل variants.0.price أو shipping_address.city) ← اسم حقل النموذج. */
export function formFieldFor(op, serverField) {
    const names = new Set((FORMS[op]?.fields || []).map((f) => f.name));
    const parts = String(serverField || '').split('.').filter((p) => !/^[0-9]+$/.test(p));
    const map = { compare_at_price: 'compare_at_price', expected_quantity: 'expected_quantity', inventory_item_id: null, location_id: 'location_id',
                  amount: 'amount', publication_ids: 'publication_ids', fulfillment_line_item_id: 'quantities', options: 'option1_name', lines: 'lines',
                  variant_id: 'lines', subtotal: 'minimum_value' };
    for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (names.has(p)) return p;
        if (map[p] && names.has(map[p])) return map[p];
    }
    return null;
}

/* ── عرض الحالة والدفع ─────────────────────────────────────────────────── */

/**
 * حالة الدفع كما يقولها Shopify. «مدفوع» فقط إن أكّد Shopify PAID و fullyPaid معًا.
 */
export function paymentLabel(payment) {
    const p = payment || {};
    if (p.paid_confirmed === true) return { text: 'مدفوع (أكّده Shopify)', tone: 'success' };
    if (p.financial_status === 'PAID') return { text: 'Shopify يعرض «مدفوع» دون تأكيد اكتمال الدفع — راجع الطلب في Shopify', tone: 'warning' };
    const label = statusLabel(FINANCIAL_STATUS, p.financial_status ? String(p.financial_status).toLowerCase() : null);
    return { text: label ? `${label} (حسب Shopify)` : 'حالة الدفع غير معروفة من Shopify', tone: 'warning' };
}
export const fulfillmentLabel = (v) => statusLabel(FULFILLMENT_STATUS, v ? String(v).toLowerCase() : null) || '—';
export const productStatusLabel = (v) => statusLabel(PRODUCT_STATUS, v ? String(v).toLowerCase() : null) || '—';
export const DISCOUNT_STATUS = Object.freeze({ ACTIVE: 'فعّال', SCHEDULED: 'مجدول', EXPIRED: 'منتهٍ' });
export const RETURN_STATUS_LABELS = Object.freeze({ REQUESTED: 'طلب إرجاع', OPEN: 'مفتوح', CLOSED: 'مغلق', DECLINED: 'مرفوض', CANCELED: 'ملغى' });
export const OP_STATUS = Object.freeze({ succeeded: 'نُفّذت', submitted: 'أُرسلت لـShopify', failed: 'فشلت', requested: 'قيد التنفيذ', unknown: 'نتيجة غير معروفة' });

/** المسموح لهذا المستخدم: من حالة الإدارة (الخادم). */
export function opAvailability(status, op) {
    const o = (status?.ops || []).find((x) => x.key === op);
    if (!status?.enabled || !o) return { visible: false, enabled: false, reason: null };
    if (!o.permitted) return { visible: false, enabled: false, reason: 'forbidden' };
    if ((o.missing_scopes || []).length) return { visible: true, enabled: false, reason: 'missing_scope', scopes: o.missing_scopes };
    return { visible: true, enabled: true, reason: null, confirm: o.confirm, risk: o.risk };
}
export function sectionVisible(status, section, role) {
    if (section.adminOnly) return role === 'admin';
    return opAvailability(status, section.read).visible;
}

export const MANAGE_REASONS = Object.freeze({
    preview_read_only: 'إدارة Shopify غير متاحة داخل المعاينة.',
    provider_disabled: 'تكامل Shopify غير مفعّل على المنصة بعد.',
    not_entitled: 'اشتراك المتجر لا يشمل تكامل Shopify.',
    management_not_enabled: 'إدارة المتجر من مدعوم غير مفعّلة لهذا الحساب بعد. تعمل الآن القراءة والدعم فقط.',
    connection_inactive: 'ربط Shopify غير نشط — أعد الربط من صفحة Shopify.'
});

const ELIGIBILITY = Object.freeze({
    cancel_requires_refund_review: 'الطلب مدفوع أو عليه تفويض دفع — الإلغاء من هنا لا يرد المال. ألغِه من لوحة Shopify حيث تظهر خيارات الاسترداد.',
    order_fulfilled: 'لا يُلغى طلب نُفّذ كله أو بعضه من هنا.',
    already_cancelled: 'الطلب ملغى بالفعل.', order_cancelled: 'الطلب ملغى.',
    status_unchanged: 'المنتج بهذه الحالة بالفعل.', already_archived: 'المنتج مؤرشف بالفعل.',
    already_stocked: 'المنتج مخزّن في هذا الموقع بالفعل.', location_inactive: 'الموقع غير نشط.',
    already_active: 'الخصم فعّال بالفعل.', not_active: 'الخصم غير فعّال.', draft_completed: 'المسودة أُكملت ولا تُحذف.',
    return_status: 'حالة المرتجع لا تسمح بهذه العملية.', fulfillment_inactive: 'الشحنة ملغاة أو فاشلة.', ends_at: 'النهاية يجب أن تكون بعد البداية.'
});
export function eligibilityText(reason) {
    const r = String(reason || '');
    if (ELIGIBILITY[r]) return ELIGIBILITY[r];
    if (/location_id$/.test(r)) return 'المنتج غير مخزّن في هذا الموقع.';
    if (/inventory_item_id$/.test(r)) return 'صنف المخزون غير موجود.';
    if (/quantity$/.test(r)) return 'الكمية أكبر من المتاح لهذه العملية.';
    if (/not_available$/.test(r)) return 'المتغير غير متاح للبيع.';
    if (/product_not_active$/.test(r)) return 'المنتج غير نشط.';
    if (/not_fulfillable$/.test(r)) return 'أمر التنفيذ لا يقبل الشحن الآن.';
    if (/nothing_remaining$/.test(r)) return 'لا كميات متبقية للشحن.';
    if (/compare_at_price$/.test(r)) return 'السعر قبل الخصم يجب أن يكون أعلى من السعر.';
    if (/publication_ids/.test(r)) return 'قناة البيع غير موجودة في متجرك.';
    if (/\.id$|variant_ids|variant_id$/.test(r)) return 'العنصر لا يخص هذا الطلب أو المنتج.';
    return 'لا تسمح حالة السجل في Shopify بهذه العملية الآن.';
}

/** نص الخطأ من جسم رد الدالة الطرفية أو القاعدة. */
export function manageErrorText(body, fieldLabel = (f) => f) {
    const b = body || {};
    const code = b.error || b.code;
    if (b.outcome === 'unknown') return 'لم يصل رد Shopify — قد تكون العملية نُفّذت. تحقّق في Shopify قبل الإعادة.';
    switch (code) {
        case 'invalid_input': return b.field ? `قيمة غير صالحة: ${fieldLabel(b.field)}` : 'قيمة غير صالحة.';
        case 'not_eligible': return eligibilityText(b.reason);
        case 'provider_rejected': {
            const fields = (b.user_errors || []).map((e) => e.field).filter(Boolean);
            return `رفض Shopify العملية${fields.length ? ` — راجع: ${fields.map(fieldLabel).join('، ')}` : ''}.`;
        }
        case 'rate_limited': return `طلبات كثيرة — حاول بعد ${Number.isFinite(b.retry_after) ? b.retry_after : 60} ثانية.`;
        case 'confirmation_required': case 'confirmation_invalid': return 'انتهى التأكيد أو تغيّرت البيانات — أكّد من جديد.';
        case 'missing_scope': return 'التطبيق لا يملك صلاحية Shopify لهذه العملية — أعد التفويض من صفحة Shopify.';
        case 'forbidden_scope': return 'رفض Shopify الصلاحية — أعد التفويض من صفحة Shopify.';
        case 'forbidden': return 'لا تملك صلاحية هذه العملية في فريق المتجر.';
        case 'token_expired': case 'auth_failed': return 'انتهى ربط Shopify — أعد الربط من صفحة Shopify.';
        case 'not_found': return 'غير موجود في Shopify أو في متجرك.';
        case 'unsupported': return 'عملية غير مدعومة.';
        default: return MANAGE_REASONS[code] || 'تعذّر تنفيذ العملية. حاول لاحقًا.';
    }
}

const PREVIEW_LABELS = Object.freeze({
    title: 'العنوان', name: 'الاسم', status: 'الحالة', from: 'من', to: 'إلى', total: 'الإجمالي', financial_status: 'حالة الدفع في Shopify',
    restock: 'إعادة للمخزون', notify_customer: 'إخطار العميل', refund: 'استرداد مالي', currency: 'العملة', subtotal_before_tax_shipping: 'المجموع قبل الضريبة والشحن',
    receipt: 'إيصال للعميل', test: 'تجريبي', reason: 'السبب', code: 'الكود', summary: 'الملخص', starts_at: 'يبدأ', ends_at: 'ينتهي', usage_limit: 'حد الاستخدام',
    location_name: 'الموقع', available: 'المتاح', variants: 'المتغيرات', products_count: 'عدد المنتجات', fulfillment_status: 'التنفيذ',
    fields: 'الحقول', value: 'القيمة', items: 'يسري على', once_per_customer: 'مرة لكل عميل'
});
const fmt = (v) => {
    if (v === true) return 'نعم';
    if (v === false) return 'لا';
    if (v === null || v === undefined || v === '') return '—';
    if (typeof v === 'object' && 'amount' in v) return `${v.amount ?? '—'} ${v.currency || ''}`.trim();
    if (typeof v === 'object' && 'percentage' in v) return `${v.percentage}%`;
    if (Array.isArray(v)) return v.join('، ');
    return String(v);
};
/** ما يعرضه Shopify الآن قبل التنفيذ: صفوف بسيطة + جداول للتغييرات. */
export function previewView(op, preview) {
    const p = preview || {};
    const rows = Object.entries(p).filter(([k, v]) => PREVIEW_LABELS[k] && !(Array.isArray(v) && v.length && typeof v[0] === 'object') && (typeof v !== 'object' || v === null || 'amount' in v || 'percentage' in v || Array.isArray(v)))
        .map(([k, v]) => ({ label: PREVIEW_LABELS[k], value: k === 'reason' ? (INVENTORY_REASON_LABELS[v] || v) : fmt(v) }));
    const tables = [];
    if (Array.isArray(p.changes) && p.changes.length && 'location_name' in p.changes[0]) {
        tables.push({ head: ['الموقع', 'الحالي في Shopify', 'رأيتَه', 'بعد التعديل'], rows: p.changes.map((c) => [c.location_name || '—', fmt(c.current),
            c.stale ? `${fmt(c.expected)} ⚠ تغيّر` : fmt(c.expected), fmt(c.after)]), warn: p.changes.some((c) => c.stale) ? 'تغيّرت الكمية في Shopify بعد ما رأيتَه — سيرفض Shopify التعديل. حدّث الكمية الحالية.' : null });
    }
    if (Array.isArray(p.changes) && p.changes.length && 'price_from' in p.changes[0]) {
        tables.push({ head: ['المتغير', 'السعر الحالي', 'السعر الجديد'], rows: p.changes.map((c) => [c.title || '—', fmt(c.price_from), c.price_to === null ? 'بلا تغيير' : fmt(c.price_to)]) });
    }
    if (Array.isArray(p.lines) && p.lines.length && 'unit_price' in p.lines[0]) {
        tables.push({ head: ['المنتج', 'الكمية', 'سعر الوحدة من Shopify'], rows: p.lines.map((l) => [`${l.title || ''}${l.variant_title ? ` — ${l.variant_title}` : ''}`, fmt(l.quantity), fmt(l.unit_price)]) });
    }
    if (Array.isArray(p.lines) && p.lines.length && 'returnable' in p.lines[0]) {
        tables.push({ head: ['المنتج', 'الكمية', 'القابل للإرجاع'], rows: p.lines.map((l) => [l.title || '—', fmt(l.quantity), fmt(l.returnable)]) });
    }
    if (Array.isArray(p.fulfillment_orders)) {
        tables.push({ head: ['المنتج', 'يُشحن', 'المتبقي'], rows: p.fulfillment_orders.flatMap((fo) => (fo.lines || []).map((l) => [l.title || '—', fmt(l.quantity), fmt(l.remaining)])) });
    }
    if (Array.isArray(p.publications)) tables.push({ head: ['القناة', 'منشور الآن'], rows: p.publications.map((x) => [x.title || '—', fmt(x.published)]) });
    if (p.current && typeof p.current === 'object') rows.unshift({ label: 'الحالي', value: [p.current.title, p.current.summary].filter(Boolean).join(' — ') || '—' });
    return { rows, tables };
}

export const isDestructive = (status, op) => (status?.ops || []).find((x) => x.key === op)?.risk === 'destructive';
