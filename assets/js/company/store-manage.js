/**
 * store-manage.js — صفحة «إدارة المتجر» (120): المنتجات والمجموعات والطلبات والمسودات والعملاء
 * والمخزون والخصومات والتنفيذ والإرجاع في Shopify من لوحة الشركة.
 * (139): تنبيهات مخزون (حد أدنى لكل متجر/متغير + فحص من بيانات Shopify الحية + إشعار
 * لمالك الشركة)، وقسما «طلبات مهملة» و«الشحن» بحالة صادقة — لا عملية لهما في كتالوج 120.
 * (152): جدول المنتجات بأعمدة لوحة Shopify (التصنيف، القنوات، النوع، المورّد) وبطاقات
 * تحليلات المنتجات فوقه (معدل البيع، أيام المخزون المتبقية، ABC) من product.analytics.
 *
 * لا قرار هنا: الأزرار من ihub_shopify_manage_status (صلاحية المستخدم ونطاقات Shopify الممنوحة)،
 * والخادم يتحقق من كل حقل، والقاعدة تفرض الصلاحية والتأكيد والحد وتسجّل كل عملية.
 * العملية المؤثرة بخطوتين: النموذج ← نافذة تأكيد تعرض حالة Shopify الآن ← التنفيذ.
 * لا مبالغ تُحصَّل ولا تُسترد من هنا، ولا رسائل للعميل إلا باختيار صريح.
 */

import { fetchStoreOverview, fetchManageStatus, fetchOpsLog, shopifyAdmin,
    fetchThresholds, saveThreshold, deleteThreshold, fetchOpenAlerts, reportInventoryAlerts } from '/assets/js/company/store-data.js';
import {
    MANAGE_SECTIONS, OP_LABELS, CONSEQUENCES, FORMS, formErrors, formFieldFor, paymentLabel, fulfillmentLabel, productStatusLabel,
    DISCOUNT_STATUS, RETURN_STATUS_LABELS, OP_STATUS, INVENTORY_REASON_LABELS, opAvailability, sectionVisible, MANAGE_REASONS,
    manageErrorText, previewView, isDestructive,
    ABANDONED_CHECKOUTS_UNAVAILABLE, SHIPPING_UNAVAILABLE, ALERT_STATUS_LABELS,
    validateThreshold, resolveThreshold, availableOf, evaluateInventoryAlerts, buildAlertReportItems,
    storeThresholdReportItem,
    computeProductAnalytics, analyticsCoverageNote
} from '/assets/js/company/store-manage-model.js';
import { escapeHtml as esc, formatDateTime, renderState, renderSkeletonLines } from '/assets/js/customer/portal-ui.js';
import { ui } from '/ui-service.js';

const $ = (id) => document.getElementById(id);
const toast = (text, tone = 'info') => ui?.showToast?.(text, tone);
const facts = (rows) => `<dl class="ihub-facts">${rows.filter(Boolean).map((r) => `<div><dt>${esc(r.label)}</dt><dd>${esc(r.value ?? '—')}</dd></div>`).join('')}</dl>`;
const pill = (tone, text) => `<span class="pill status-tone-${esc(tone)}">${esc(text)}</span>`;
const money = (m) => (m && m.amount ? `${m.amount} ${m.currency || ''}`.trim() : '—');
const when = (v) => (v ? formatDateTime(v) : '—');
const table = (head, rows) => (rows.length ? `<div class="table-container"><table class="admin-table"><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<p class="panel-subtitle">لا عناصر.</p>');

let state = { conn: null, status: null, role: 'agent', section: 'products', locations: null, thresholds: null };
const actions = new Map();
let seq = 0;

/* ── تحميل الصفحة ──────────────────────────────────────────────────────── */

export async function loadStoreManage() {
    const c = $('storeManageBody');
    if (!c) return;
    renderSkeletonLines(c, 4);
    const ov = await fetchStoreOverview();
    if (!ov.ok) { renderState(c, { variant: 'error', title: 'تعذّر التحميل', text: manageErrorText({ error: ov.code }) }); return; }
    const conn = ov.data?.connection;
    state.role = ov.data?.my_role || 'agent';
    if (!conn || !['active', 'error'].includes(conn.status)) {
        renderState(c, { variant: 'empty', title: 'لا متجر Shopify متصل', text: 'يربط مدير المتجر Shopify من صفحة «Shopify» أولًا.' });
        return;
    }
    const st = await fetchManageStatus(conn.id);
    if (!st.ok) {
        renderState(c, st.missing ? { variant: 'empty', title: 'إدارة المتجر غير متاحة بعد', text: 'لم تُفعَّل على المنصة.' }
                                  : { variant: 'error', title: 'تعذّر التحميل', text: manageErrorText({ error: st.code }) });
        return;
    }
    state = { ...state, conn, status: st.data, locations: null, thresholds: null };
    if (!st.data.enabled) {
        renderState(c, { variant: 'empty', title: 'إدارة المتجر غير مفعّلة', text: MANAGE_REASONS[st.data.reason] || '' });
        return;
    }
    const sections = MANAGE_SECTIONS.filter((s) => sectionVisible(st.data, s, state.role));
    if (!sections.length) { renderState(c, { variant: 'empty', title: 'لا صلاحيات إدارة لك', text: 'يمنحها مدير المتجر من «الأدوار والصلاحيات».' }); return; }
    if (!sections.some((s) => s.key === state.section)) state.section = sections[0].key;
    const missing = (st.data.ops || []).filter((o) => o.permitted && (o.missing_scopes || []).length);
    c.innerHTML = `
        <p class="field-hint">كل عملية تُسجَّل باسمك. العمليات المؤثرة (الحذف، الإلغاء، المخزون، الأسعار، الشحن، الخصومات) تعرض حالة Shopify الآن وتحتاج تأكيدك.
            لا يُحصَّل أي مبلغ ولا يُسترد من هنا.</p>
        ${missing.length ? `<div class="state-block state-block--compact" role="note"><p class="state-title">بعض العمليات تحتاج إعادة تفويض التطبيق في Shopify</p>
            <p class="state-text">صلاحيات Shopify الحالية لا تشمل: ${esc([...new Set(missing.flatMap((o) => o.missing_scopes))].join('، '))}. أعد التفويض من صفحة «Shopify».</p></div>` : ''}
        <div class="toolbar sm-nav" role="toolbar" aria-label="أقسام إدارة المتجر">${sections.map((s) => `
            <button type="button" class="btn btn-sm ${s.key === state.section ? 'btn-primary' : 'btn-secondary'}" data-section="${esc(s.key)}"
                    aria-pressed="${s.key === state.section}">${esc(s.label)}</button>`).join('')}</div>
        <div id="smSection" aria-live="polite"></div>
        <div id="smDetail" aria-live="polite"></div>`;
    c.querySelectorAll('[data-section]').forEach((b) => b.addEventListener('click', () => {
        state.section = b.dataset.section;
        c.querySelectorAll('[data-section]').forEach((x) => {
            const on = x === b;
            x.classList.toggle('btn-primary', on); x.classList.toggle('btn-secondary', !on); x.setAttribute('aria-pressed', String(on));
        });
        renderSection();
    }));
    renderSection();
}

const RENDER = {
    shop: renderShop, products: renderProducts, collections: renderCollections, orders: renderOrders, abandoned: renderAbandoned,
    drafts: renderDrafts, customers: renderCustomers, inventory: renderInventory, alerts: renderAlerts, discounts: renderDiscounts,
    shipping: renderShipping, log: renderLog
};
function renderSection() {
    actions.clear();
    $('smDetail').innerHTML = '';
    RENDER[state.section]?.($('smSection'));
}

/* ── نداءات ────────────────────────────────────────────────────────────── */

async function read(op, input, box) {
    if (box) renderSkeletonLines(box, 3);
    const r = await shopifyAdmin(state.conn.id, op, input);
    if (!r.ok) {
        if (box) renderState(box, { variant: 'error', title: 'تعذّر التحميل من Shopify', text: manageErrorText(r.detail) });
        return null;
    }
    return r.data.result;
}

/** قراءة صامتة (لخلايا الجداول): فشلها يعني «غير معروف» لا صفحة خطأ. */
async function readQuiet(op, input) {
    const r = await shopifyAdmin(state.conn.id, op, input);
    return r.ok ? r.data.result : null;
}

/** حدود المخزون المحفوظة (139)، مخزّنة في الجلسة. */
async function ensureThresholds() {
    if (!state.thresholds) {
        const r = await fetchThresholds(state.conn.id);
        state.thresholds = r.ok && Array.isArray(r.data) ? r.data : [];
    }
    return state.thresholds;
}
/** مستويات Shopify الحية لحدود المتغيرات: {inventory_item_id: levels[]}. */
async function loadAlertLevels(thresholds) {
    const byItem = {};
    await Promise.all((thresholds || []).filter((t) => t?.scope === 'variant').map(async (t) => {
        const r = await readQuiet('inventory.levels', { variant_id: t.variant_id });
        if (r) byItem[t.inventory_item_id] = r.levels || [];
    }));
    return byItem;
}

/** زر عملية كتابة: يظهر حسب الخادم؛ معطّل مع السبب إن نقص نطاق Shopify. */
function actionButton(op, ctx, { label, extra = null, record = null, onDone = null, tone = 'secondary' } = {}) {
    const a = opAvailability(state.status, op);
    if (!a.visible) return '';
    const id = `a${++seq}`;
    actions.set(id, { op, ctx, extra, record, onDone });
    const danger = a.risk === 'destructive';
    return `<button type="button" class="btn btn-sm ${danger ? 'btn-danger' : `btn-${tone}`}" data-act="${id}" ${a.enabled ? '' : 'disabled'}
        ${a.enabled ? '' : `title="${esc('أعد التفويض في Shopify: ' + (a.scopes || []).join('، '))}"`}>${esc(label || OP_LABELS[op] || op)}</button>`;
}
function wireActions(root) {
    root.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
        const a = actions.get(b.dataset.act);
        if (a) openOpDialog(a);
    }));
}
const bar = (...buttons) => {
    const html = buttons.filter(Boolean).join('');
    return html ? `<div class="company-form-actions sm-actions">${html}</div>` : '';
};

/* ── نافذة العملية: النموذج ← التأكيد ← التنفيذ ─────────────────────────── */

function fieldHtml(f, value, extra) {
    const id = `smf_${f.name}`;
    const hint = f.hint ? `<p class="field-hint">${esc(f.hint)}</p>` : '';
    const err = `<p class="field-error" data-error-for="${esc(f.name)}" role="alert" hidden></p>`;
    const req = f.required ? ' <span aria-hidden="true">*</span>' : '';
    if (f.type === 'checkbox') {
        return `<div class="form-field is-full"><label><input type="checkbox" id="${id}" name="${esc(f.name)}" ${value ? 'checked' : ''}> ${esc(f.label)}</label>${hint}${err}</div>`;
    }
    if (f.type === 'select') {
        const options = f.from === 'locations' ? (extra?.locations || []).map((l) => [l.id, l.name]) : f.options;
        return `<div class="form-field"><label for="${id}">${esc(f.label)}${req}</label><select id="${id}" name="${esc(f.name)}" class="form-control">
            ${options.map(([v, l]) => `<option value="${esc(v)}" ${String(value ?? '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>${hint}${err}</div>`;
    }
    if (f.type === 'choices') {
        const options = extra?.[f.from] || [];
        return `<fieldset class="form-field is-full"><legend>${esc(f.label)}${req}</legend>${options.length ? options.map((o, i) => `
            <label><input type="checkbox" name="${esc(f.name)}" value="${esc(o.id)}" id="${id}_${i}"> ${esc(o.title || o.id)}${o.published === true ? ' (منشور الآن)' : ''}</label>`).join('')
            : '<p class="field-hint">لا قنوات بيع.</p>'}${err}</fieldset>`;
    }
    if (f.type === 'quantities') {
        const lines = extra?.[f.from] || [];
        return `<fieldset class="form-field is-full"><legend>${esc(f.label)}</legend>${lines.map((l, i) => `
            <div class="form-field"><label for="${id}_${i}">${esc(l.title || '—')} <span class="field-hint">(المتاح ${esc(l.max ?? '—')})</span></label>
            <input type="number" min="0" ${Number.isInteger(l.max) ? `max="${l.max}"` : ''} step="1" class="form-control" id="${id}_${i}" data-qty-for="${esc(l.id)}" value="${esc(l.max ?? '')}"></div>`).join('')}${err}</fieldset>`;
    }
    const type = f.type === 'datetime' ? 'datetime-local' : f.type === 'int' ? 'number' : 'text';
    const mode = f.type === 'money' ? ' inputmode="decimal"' : f.type === 'int' ? ' step="1"' : '';
    if (f.type === 'textarea') {
        return `<div class="form-field is-full"><label for="${id}">${esc(f.label)}${req}</label><textarea id="${id}" name="${esc(f.name)}" class="form-control" rows="3">${esc(value ?? '')}</textarea>${hint}${err}</div>`;
    }
    return `<div class="form-field"><label for="${id}">${esc(f.label)}${req}</label><input type="${type}" id="${id}" name="${esc(f.name)}" class="form-control"${mode}
        ${f.maxlength ? `maxlength="${f.maxlength}"` : ''} value="${esc(value ?? '')}" autocomplete="off">${hint}${err}</div>`;
}
function readValues(form, fields) {
    const v = {};
    for (const f of fields) {
        if (f.type === 'checkbox') v[f.name] = form.querySelector(`[name="${f.name}"]`)?.checked || false;
        else if (f.type === 'choices') v[f.name] = [...form.querySelectorAll(`[name="${f.name}"]:checked`)].map((x) => x.value);
        else if (f.type === 'quantities') v[f.name] = Object.fromEntries([...form.querySelectorAll('[data-qty-for]')].map((x) => [x.dataset.qtyFor, x.value]));
        else v[f.name] = form.querySelector(`[name="${f.name}"]`)?.value ?? '';
    }
    return v;
}

function openOpDialog({ op, ctx, extra, record, onDone }) {
    const def = FORMS[op];
    if (!def) return;
    const opener = document.activeElement;
    const wrap = document.createElement('div');
    wrap.className = 'modal active';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', 'smDlgTitle');
    wrap.dataset.op = op;
    const pre = def.prefill && record ? def.prefill(record) : {};
    const destructive = isDestructive(state.status, op);
    wrap.innerHTML = `<div class="modal-content modal-sm">
        <div class="modal-head"><div><h2 id="smDlgTitle">${esc(OP_LABELS[op] || op)}</h2>
            ${def.note ? `<p class="panel-subtitle">${esc(def.note)}</p>` : ''}</div>
            <button type="button" class="modal-close" data-close aria-label="إغلاق">&times;</button></div>
        <form class="company-form" id="smForm" novalidate>
            <div class="form-grid">${def.fields.map((f) => fieldHtml(f, pre[f.name] ?? (f.type === 'select' && f.options ? f.options[0]?.[0] : ''), extra)).join('')}</div>
            ${def.fields.length ? '' : `<p class="panel-subtitle">${esc(CONSEQUENCES[op] || '')}</p>`}
            <p class="field-error" id="smFormError" role="alert" hidden></p>
            <div class="company-form-actions"><button type="submit" class="btn ${destructive ? 'btn-danger' : 'btn-primary'}" id="smSubmit">${opAvailability(state.status, op).confirm ? 'متابعة' : 'حفظ'}</button>
                <button type="button" class="btn btn-ghost" data-close>إلغاء</button></div>
        </form>
        <div id="smConfirm" hidden></div></div>`;
    document.body.appendChild(wrap);
    const form = wrap.querySelector('#smForm');
    const close = () => { wrap.remove(); opener?.focus?.(); };
    wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    (form.querySelector('input,select,textarea,button[type="submit"]'))?.focus();
    const labelOf = (f) => def.fields.find((x) => x.name === formFieldFor(op, f))?.label || f;
    const showError = (body) => {
        form.querySelectorAll('[data-error-for]').forEach((e) => { e.hidden = true; e.textContent = ''; });
        const field = body?.field ? formFieldFor(op, body.field) : null;
        const target = field && form.querySelector(`[data-error-for="${field}"]`);
        const text = manageErrorText(body, labelOf);
        if (target) { target.textContent = text; target.hidden = false; form.querySelector(`[name="${field}"]`)?.focus?.(); }
        const box = wrap.querySelector('#smFormError');
        box.textContent = target ? '' : text;
        box.hidden = !!target;
    };
    const busy = (btn, on, text) => { btn.disabled = on; btn.setAttribute('aria-busy', String(on)); if (text) btn.textContent = text; };

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const values = readValues(form, def.fields);
        const errs = formErrors(op, values);
        form.querySelectorAll('[data-error-for]').forEach((x) => { x.hidden = !errs[x.dataset.errorFor]; x.textContent = errs[x.dataset.errorFor] || ''; });
        if (Object.keys(errs).length) return;
        const input = def.build(values, ctx || {});
        const btn = wrap.querySelector('#smSubmit');
        const label = btn.textContent;
        busy(btn, true, 'جارٍ…');
        const r = await shopifyAdmin(state.conn.id, op, input);
        busy(btn, false, label);
        if (!r.ok) { showError(r.detail); return; }
        if (r.data.confirmation_required) { showConfirm(wrap, op, input, r.data, { close, onDone, destructive }); return; }
        done(op, r.data, close, onDone);
    });
}

function showConfirm(wrap, op, input, data, { close, onDone, destructive }) {
    const view = previewView(op, data.preview);
    const box = wrap.querySelector('#smConfirm');
    wrap.querySelector('#smForm').hidden = true;
    box.hidden = false;
    box.innerHTML = `<div class="state-block state-block--compact" role="note"><p class="state-title">تأكيد: ${esc(OP_LABELS[op] || op)}</p>
            <p class="state-text">${esc(CONSEQUENCES[op] || '')}</p></div>
        <p class="panel-subtitle">كما يراه Shopify الآن:</p>
        ${view.rows.length ? facts(view.rows) : ''}
        ${view.tables.map((t) => `${table(t.head, t.rows.map((r) => r.map(esc)))}${t.warn ? `<p class="field-error" role="alert">${esc(t.warn)}</p>` : ''}`).join('')}
        ${destructive ? `<label class="form-field is-full"><input type="checkbox" id="smAck"> أفهم أن هذه العملية لا يمكن التراجع عنها</label>` : ''}
        <p class="field-hint">التأكيد صالح ${esc(Math.round((data.expires_in || 300) / 60))} دقائق لهذه البيانات بالضبط.</p>
        <p class="field-error" id="smConfirmError" role="alert" hidden></p>
        <div class="company-form-actions"><button type="button" class="btn ${destructive ? 'btn-danger' : 'btn-primary'}" id="smConfirmBtn" ${destructive ? 'disabled' : ''}>تأكيد التنفيذ</button>
            <button type="button" class="btn btn-ghost" id="smBack">رجوع</button></div>`;
    const btn = box.querySelector('#smConfirmBtn');
    box.querySelector('#smAck')?.addEventListener('change', (e) => { btn.disabled = !e.target.checked; });
    box.querySelector('#smBack').addEventListener('click', () => { box.hidden = true; wrap.querySelector('#smForm').hidden = false; });
    btn.focus();
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
        btn.textContent = 'جارٍ التنفيذ…';
        const r = await shopifyAdmin(state.conn.id, op, input, data.confirmation_token);
        if (!r.ok) {
            const err = box.querySelector('#smConfirmError');
            err.textContent = manageErrorText(r.detail);
            err.hidden = false;
            btn.textContent = 'تأكيد التنفيذ';
            btn.setAttribute('aria-busy', 'false');
            // التأكيد استُهلك أو انتهى: يعود المستخدم للنموذج ليؤكد من جديد
            if (['confirmation_invalid', 'confirmation_required', 'not_eligible'].includes(r.code) || r.detail?.op_id) btn.disabled = true;
            else btn.disabled = false;
            return;
        }
        done(op, r.data, close, onDone);
    });
}

function done(op, data, close, onDone) {
    close();
    toast(data.status === 'submitted' ? `${OP_LABELS[op] || op}: أُرسلت إلى Shopify — تتحدّث الحالة حين يؤكدها Shopify.` : `${OP_LABELS[op] || op}: تمّت في Shopify.`, 'success');
    onDone?.(data);
}

/* ── الأقسام ────────────────────────────────────────────────────────────── */

async function renderShop(box) {
    const [shop, locs] = await Promise.all([read('shop.info', {}, box), opAvailability(state.status, 'location.list').enabled ? read('location.list', { include_inactive: true }) : null]);
    if (!shop) return;
    box.innerHTML = `<section class="panel"><h3 class="panel-title">${esc(shop.name || shop.domain)}</h3>
        ${facts([{ label: 'النطاق', value: shop.domain }, { label: 'العملة', value: shop.currency }, { label: 'المنطقة الزمنية', value: shop.timezone },
                 { label: 'الخطة', value: shop.plan }, { label: 'متجر تطوير', value: shop.development_store ? 'نعم' : 'لا' }])}
        ${locs ? `<h3 class="panel-title">المواقع</h3>${table(['الموقع', 'الحالة', 'الطلبات الإلكترونية', 'المدينة'],
            locs.items.map((l) => [esc(l.name), l.active ? pill('success', 'نشط') : pill('warning', 'غير نشط'), l.online_orders ? 'نعم' : 'لا', esc(l.city || '—')]))}` : ''}</section>`;
}

function searchForm(id, { placeholder, filters = '' }) {
    return `<form class="toolbar owner-filters" id="${id}" role="search" novalidate>
        <label class="visually-hidden" for="${id}Q">بحث</label>
        <input type="search" id="${id}Q" class="form-control" maxlength="80" autocomplete="off" placeholder="${esc(placeholder)}">${filters}
        <button type="submit" class="btn btn-primary btn-sm">بحث</button></form>`;
}
const listBox = '<div id="smList" aria-live="polite"></div>';

function renderProducts(box) {
    box.innerHTML = `${bar(actionButton('product.create', {}, { tone: 'primary', onDone: () => runProducts() }))}
        ${searchForm('smProdSearch', { placeholder: 'اسم المنتج', filters: `<label class="visually-hidden" for="smProdStatus">الحالة</label>
            <select id="smProdStatus" class="form-control"><option value="">كل الحالات</option><option value="ACTIVE">نشط</option><option value="DRAFT">مسودة</option><option value="ARCHIVED">مؤرشف</option></select>` })}
        <div id="smAnalytics" aria-live="polite"></div>
        ${listBox}`;
    wireActions(box);
    $('smProdSearch').addEventListener('submit', (e) => { e.preventDefault(); runProducts(); });
    loadProductAnalytics();
    runProducts();
}
/** بطاقات تحليلات المنتجات فوق الجدول (152) — من product.analytics، بلا أرقام مخترعة:
 *  بلا مبيعات ⇒ معدل بيع 0% (إن وُجد مخزون) و«لا توجد بيانات» لأيام المخزون وEGP 0.00 لـABC. */
async function loadProductAnalytics() {
    const host = $('smAnalytics');
    if (!host) return;
    const avail = opAvailability(state.status, 'product.analytics');
    if (!avail.visible) return;
    if (!avail.enabled) {
        host.innerHTML = `<p class="field-hint">تحليلات المنتجات غير متاحة الآن${avail.reason === 'missing_scope'
            ? ' — صلاحية قراءة الطلبات غير ممنوحة؛ أعد التفويض من صفحة «Shopify».' : '.'}</p>`;
        return;
    }
    const res = await readQuiet('product.analytics', {});
    const a = res ? computeProductAnalytics(res) : null;
    if (!a) {
        host.innerHTML = '<p class="field-hint">تعذّرت قراءة تحليلات المنتجات من Shopify — جدول المنتجات أدناه يعمل كالمعتاد.</p>';
        return;
    }
    const st = a.sell_through;
    const sellValue = st.has_data ? `${Math.round(st.rate * 100)}%` : 'لا توجد بيانات';
    const sellHint = st.has_data ? `${st.units_sold} وحدة مباعة من أصل ${st.units_sold + st.on_hand} (مباع + مخزون)` : 'لا منتجات ولا مبيعات في الفترة';
    const dr = a.days_remaining;
    const daysValue = dr.has_data ? `${dr.buckets.lt7.count + dr.buckets.d7_30.count + dr.buckets.gt30.count} منتجًا بمبيعات` : 'لا توجد بيانات';
    const daysHint = dr.has_data
        ? `أقل من 7 أيام: ${dr.buckets.lt7.count} · 7–30 يومًا: ${dr.buckets.d7_30.count} · أكثر من 30 يومًا: ${dr.buckets.gt30.count} · بلا مبيعات: ${dr.buckets.no_sales.count}`
        : 'لا توجد مبيعات في آخر ' + a.window_days + ' يومًا تُحسب عليها الأيام المتبقية';
    const abc = a.abc;
    const abcHint = abc.has_data
        ? `A: ${abc.classes.A.count} · B: ${abc.classes.B.count} · C: ${abc.classes.C.count} — من إيراد المنتجات المباعة`
        : 'لا توجد مبيعات في آخر ' + a.window_days + ' يومًا';
    const note = analyticsCoverageNote(a);
    host.innerHTML = `<div class="kpi-grid" role="group" aria-label="تحليلات المنتجات — آخر ${a.window_days} يومًا">
        <div class="kpi"><span class="kpi-label">متوسط معدل البيع — آخر ${a.window_days} يومًا</span>
            <span class="kpi-value">${esc(sellValue)}</span><span class="kpi-hint">${esc(sellHint)}</span></div>
        <div class="kpi"><span class="kpi-label">المنتجات حسب أيام المخزون المتبقية</span>
            <span class="kpi-value">${esc(daysValue)}</span><span class="kpi-hint">${esc(daysHint)}</span></div>
        <div class="kpi"><span class="kpi-label">تحليل ABC حسب الإيراد — آخر ${a.window_days} يومًا</span>
            <span class="kpi-value" dir="ltr">${esc(abc.total)}</span><span class="kpi-hint">${esc(abcHint)}</span></div>
    </div>${note ? `<p class="field-hint">${esc(note)}</p>` : ''}`;
}
async function runProducts(after = null) {
    const input = { query: $('smProdSearchQ')?.value.trim() || undefined, status: $('smProdStatus')?.value || undefined, after: after || undefined };
    const r = await read('product.list', input, $('smList'));
    if (!r) return;
    $('smList').innerHTML = `${table(['المنتج', 'الحالة', 'المخزون', 'التصنيف', 'القنوات', 'النوع', 'المورّد', ''], r.items.map((p) => [esc(p.title), esc(productStatusLabel(p.status)),
        esc(p.total_inventory ?? '—'), esc(p.category || '—'), esc(p.channels ?? '—'), esc(p.product_type || '—'), esc(p.vendor || '—'),
        `<button type="button" class="btn btn-ghost btn-sm" data-open-product="${esc(p.id)}">فتح</button>`]))}
        ${r.page?.has_next ? '<button type="button" class="btn btn-secondary btn-sm" id="smMore">المزيد</button>' : ''}`;
    $('smList').querySelectorAll('[data-open-product]').forEach((b) => b.addEventListener('click', () => openProduct(b.dataset.openProduct)));
    $('smMore')?.addEventListener('click', () => runProducts(r.page.cursor));
}
async function openProduct(id) {
    const box = $('smDetail');
    const p = await read('product.get', { id }, box);
    if (!p) return;
    const reopen = () => openProduct(id);
    let pubs = null;
    if (opAvailability(state.status, 'product.publish').enabled) pubs = (await read('publication.list', { product_id: id }))?.items || null;
    box.innerHTML = `<section class="panel ihub-record" aria-labelledby="smProdTitle"><div class="panel-header"><div>
            <h2 class="panel-title" id="smProdTitle">${esc(p.title)}</h2><p class="panel-subtitle">${esc(productStatusLabel(p.status))} · بيانات حية من Shopify</p></div>
            ${p.admin_url ? `<a class="btn btn-secondary btn-sm" href="${esc(p.admin_url)}" target="_blank" rel="noopener noreferrer">فتح في Shopify</a>` : ''}</div>
        ${facts([{ label: 'المورّد', value: p.vendor }, { label: 'النوع', value: p.product_type }, { label: 'التصنيف', value: p.category },
                 { label: 'قنوات البيع المنشور فيها', value: p.channels === null || p.channels === undefined ? null : String(p.channels) },
                 { label: 'الوسوم', value: (p.tags || []).join('، ') || '—' },
                 { label: 'المخزون الكلي', value: p.total_inventory }, { label: 'المجموعات', value: (p.collections || []).map((c) => c.title).join('، ') || '—' }])}
        ${bar(actionButton('product.update', { id }, { record: p, onDone: reopen }),
              actionButton('product.set_status', { id }, { label: p.status === 'ACTIVE' ? 'تحويل إلى مسودة' : 'تفعيل', onDone: reopen }),
              pubs ? actionButton('product.publish', { id }, { extra: { publications: pubs }, onDone: reopen }) : '',
              pubs ? actionButton('product.unpublish', { id }, { extra: { publications: pubs }, onDone: reopen }) : '',
              actionButton('product.set_collections', { id }, { onDone: reopen }), actionButton('variant.create', { product_id: id }, { onDone: reopen }),
              actionButton('metafield.set', { owner_id: id }, { onDone: reopen }),
              p.status !== 'ARCHIVED' ? actionButton('product.archive', { id }, { onDone: reopen }) : '',
              actionButton('product.delete', { id }, { onDone: () => { $('smDetail').innerHTML = ''; runProducts(); } }))}
        ${pubs ? `<p class="field-hint">القنوات: ${esc(pubs.map((x) => `${x.title}${x.published ? ' ✓' : ''}`).join('، ') || '—')}</p>` : ''}
        <h3 class="panel-title">المتغيرات</h3>
        ${table(['المتغير', 'SKU', 'السعر', 'قبل الخصم', 'المخزون', ''], (p.variants || []).map((v) => [esc(v.title), `<span dir="ltr">${esc(v.sku || '—')}</span>`,
            esc(v.price ?? '—'), esc(v.compare_at_price ?? '—'), esc(v.inventory_quantity ?? '—'),
            [actionButton('variant.update', { product_id: id, variant_id: v.id }, { label: 'تعديل', record: v, onDone: reopen }),
             opAvailability(state.status, 'inventory.levels').visible ? `<button type="button" class="btn btn-ghost btn-sm" data-levels="${esc(v.id)}">المخزون</button>` : '',
             actionButton('variant.delete', { product_id: id, variant_id: v.id }, { label: 'حذف', onDone: reopen })].join(' ')]))}
        ${(p.metafields || []).length ? `<h3 class="panel-title">الحقول المخصصة</h3>${table(['المفتاح', 'النوع', 'القيمة'], p.metafields.map((m) => [
            `<span dir="ltr">${esc(m.namespace)}.${esc(m.key)}</span>`, esc(m.type), esc(String(m.value ?? '').slice(0, 120))]))}` : ''}
        <div id="smLevels" aria-live="polite"></div></section>`;
    wireActions(box);
    box.querySelectorAll('[data-levels]').forEach((b) => b.addEventListener('click', () => showLevels(b.dataset.levels, $('smLevels'))));
}

async function ensureLocations() {
    if (!state.locations && opAvailability(state.status, 'location.list').enabled) state.locations = (await read('location.list', { include_inactive: false }))?.items || [];
    return state.locations || [];
}
async function showLevels(variantId, box) {
    const r = await read('inventory.levels', { variant_id: variantId }, box);
    if (!r) return;
    const again = () => showLevels(variantId, box);
    const locs = await ensureLocations();
    const stocked = new Set(r.levels.map((l) => l.location_id));
    // (139) الحد الفعّال لهذا المتغير: حدّه أولًا، ثم حد المتجر.
    const ths = await ensureThresholds();
    const eff = r.inventory_item_id ? resolveThreshold(ths, r.inventory_item_id) : { threshold: null, min_quantity: null, scope: null };
    const avail = availableOf(r.levels);
    const below = eff.min_quantity !== null && avail !== null && avail < eff.min_quantity;
    // (139) حد المتجر بلا مسح كامل للمنتجات: يُبلَّغ عنه من هنا عند عرض مخزون
    // متغير يسري عليه — تحت الحد يفتح تنبيهًا ويُشعَر المالك مرة واحدة، وفوقه
    // يحلّ التنبيه المفتوح. حد المتغير لا يُبلَّغ من هنا (مساره «فحص الآن»).
    // الإبلاغ صامت: التحذير ظاهر في الصفحة أصلًا، والخادم يمنع تكرار الإشعار.
    const storeItem = storeThresholdReportItem(eff, r.inventory_item_id,
        `${r.product_title || ''} — ${r.title || ''}`.trim() || null, avail);
    if (storeItem) void reportInventoryAlerts(state.conn.id, [storeItem]);
    box.innerHTML = `<h3 class="panel-title">المخزون: ${esc(r.product_title || '')} — ${esc(r.title || '')}</h3>
        ${eff.min_quantity !== null ? `<p class="panel-subtitle">الحد الأدنى للتنبيه: ${esc(eff.min_quantity)} (${esc(eff.scope === 'variant' ? 'حد هذا المتغير' : 'حد المتجر كله')})${avail !== null ? ` · المتاح الآن ${esc(avail)}` : ''}</p>
        ${below ? `<p class="field-error" role="alert">${eff.scope === 'store'
            ? 'وصل المخزون للحد الأدنى لحد المتجر — يُسجَّل تنبيه واحد لحد المتجر ويُرسل إشعار لمالك الشركة.'
            : 'وصل المخزون للحد الأدنى — يظهر في «تنبيهات المخزون» ويُرسل إشعار لمالك الشركة عند الفحص.'}</p>` : ''}` : ''}
        ${r.inventory_item_id ? bar(`<button type="button" class="btn btn-secondary btn-sm" id="smSetThreshold">تعيين حد أدنى للتنبيه</button>`) : ''}
        ${r.tracked ? '' : '<p class="field-hint">المخزون غير مُتتبَّع لهذا المتغير في Shopify.</p>'}
        ${table(['الموقع', 'المتاح', 'في المخزن', 'محجوز للطلبات', 'وارد', ''], r.levels.map((l) => {
            const ctx = { inventory_item_id: r.inventory_item_id, location_id: l.location_id };
            const rec = { available: l.quantities.available };
            return [esc(l.location_name), esc(l.quantities.available ?? '—'), esc(l.quantities.on_hand ?? '—'), esc(l.quantities.committed ?? '—'), esc(l.quantities.incoming ?? '—'),
                    [actionButton('inventory.adjust', ctx, { label: '+/−', record: rec, onDone: again }), actionButton('inventory.set', ctx, { label: 'ضبط', record: rec, onDone: again })].join(' ')];
        }))}
        ${bar(actionButton('inventory.activate', { inventory_item_id: r.inventory_item_id }, { extra: { locations: locs.filter((l) => !stocked.has(l.id)).map((l) => ({ id: l.id, name: l.name })) }, onDone: again }))}`;
    wireActions(box);
    box.querySelector('#smSetThreshold')?.addEventListener('click', () => openThresholdDialog({
        scope: 'variant', inventory_item_id: r.inventory_item_id, variant_id: r.variant_id,
        product_title: `${r.product_title || ''} — ${r.title || ''}`.trim(), min_quantity: eff.min_quantity ?? ''
    }, again));
}

/** نافذة حد مخزون (139): ليست عملية Shopify، فلا تأكيد ولا معاينة — حفظ مباشر في مدعوم. */
function openThresholdDialog(prefill, onDone) {
    const opener = document.activeElement;
    const wrap = document.createElement('div');
    wrap.className = 'modal active';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', 'smThTitle');
    wrap.innerHTML = `<div class="modal-content modal-sm">
        <div class="modal-head"><div><h2 id="smThTitle">حد أدنى للتنبيه</h2>
            <p class="panel-subtitle">${esc(prefill.product_title || '')}</p></div>
            <button type="button" class="modal-close" data-close aria-label="إغلاق">&times;</button></div>
        <form class="company-form" id="smThForm" novalidate>
            <div class="form-grid"><div class="form-field"><label for="smThMin">الحد الأدنى (المتاح)</label>
                <input type="number" min="0" max="999999" step="1" id="smThMin" name="min_quantity" class="form-control" value="${esc(prefill.min_quantity ?? '')}" autocomplete="off">
                <p class="field-hint">الحد 0 يعني «نبّه عند النفاد». يُفحص من بيانات Shopify الحية.</p>
                <p class="field-error" id="smThError" role="alert" hidden></p></div></div>
            <div class="company-form-actions"><button type="submit" class="btn btn-primary" id="smThSave">حفظ الحد</button>
                <button type="button" class="btn btn-ghost" data-close>إلغاء</button></div>
        </form></div>`;
    document.body.appendChild(wrap);
    const close = () => { wrap.remove(); opener?.focus?.(); };
    wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    wrap.querySelector('#smThMin')?.focus();
    wrap.querySelector('#smThForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const values = { scope: prefill.scope, inventory_item_id: prefill.inventory_item_id, variant_id: prefill.variant_id,
                         product_title: prefill.product_title, min_quantity: wrap.querySelector('#smThMin').value };
        const errs = validateThreshold(values);
        const errBox = wrap.querySelector('#smThError');
        if (errs.min_quantity) { errBox.textContent = errs.min_quantity; errBox.hidden = false; return; }
        const btn = wrap.querySelector('#smThSave');
        btn.disabled = true; btn.textContent = 'جارٍ الحفظ…';
        const r = await saveThreshold(state.conn.id, {
            scope: prefill.scope, inventoryItemId: prefill.inventory_item_id || null, variantId: prefill.variant_id || null,
            productTitle: prefill.product_title || null, minQuantity: Number(values.min_quantity)
        });
        btn.disabled = false; btn.textContent = 'حفظ الحد';
        if (!r.ok) {
            errBox.textContent = r.missing ? 'تنبيهات المخزون غير متاحة بعد — لم تُطبَّق على قاعدة البيانات.'
                                           : manageErrorText({ error: r.code });
            errBox.hidden = false;
            return;
        }
        state.thresholds = null;
        close();
        toast('حُفظ الحد الأدنى للتنبيه.', 'success');
        onDone?.();
    });
}

function renderInventory(box) {
    box.innerHTML = `<form class="toolbar owner-filters" id="smInvForm" novalidate><label for="smInvVariant">معرّف المتغير</label>
        <input id="smInvVariant" class="form-control" inputmode="numeric" maxlength="60" autocomplete="off" placeholder="مثل 201 أو من صفحة المنتج">
        <button type="submit" class="btn btn-primary btn-sm">عرض المخزون</button></form>
        <p class="field-hint">كل تعديل يُرسل بالكمية التي رأيتَها؛ إن تغيّرت في Shopify قبل التنفيذ يُرفض ولا يُطبَّق. الأسباب: ${esc(Object.values(INVENTORY_REASON_LABELS).join('، '))}.</p>
        <div id="smLevelsBox" aria-live="polite"></div><div id="smLocs"></div>`;
    $('smInvForm').addEventListener('submit', (e) => { e.preventDefault(); const v = $('smInvVariant').value.trim(); if (v) showLevels(v, $('smLevelsBox')); });
    ensureLocations().then((locs) => {
        if ($('smLocs')) $('smLocs').innerHTML = locs.length ? `<h3 class="panel-title">المواقع النشطة</h3><ul class="company-list">${locs.map((l) => `<li>${esc(l.name)}</li>`).join('')}</ul>` : '';
    });
}

function renderCollections(box) {
    box.innerHTML = `${bar(actionButton('collection.create', {}, { tone: 'primary', onDone: () => runCollections() }))}${searchForm('smColSearch', { placeholder: 'اسم المجموعة' })}${listBox}`;
    wireActions(box);
    $('smColSearch').addEventListener('submit', (e) => { e.preventDefault(); runCollections(); });
    runCollections();
}
async function runCollections() {
    const r = await read('collection.list', { query: $('smColSearchQ')?.value.trim() || undefined }, $('smList'));
    if (!r) return;
    $('smList').innerHTML = table(['المجموعة', 'المنتجات', 'آخر تحديث', ''], r.items.map((c) => [esc(c.title), esc(c.products_count ?? '—'), esc(when(c.updated_at)),
        `<button type="button" class="btn btn-ghost btn-sm" data-open-col="${esc(c.id)}">فتح</button>`]));
    $('smList').querySelectorAll('[data-open-col]').forEach((b) => b.addEventListener('click', () => openCollection(b.dataset.openCol)));
}
async function openCollection(id) {
    const box = $('smDetail');
    const c = await read('collection.get', { id }, box);
    if (!c) return;
    box.innerHTML = `<section class="panel"><h2 class="panel-title">${esc(c.title)}</h2>
        ${bar(actionButton('collection.update', { id }, { record: c, onDone: () => openCollection(id) }),
              actionButton('collection.delete', { id }, { onDone: () => { box.innerHTML = ''; runCollections(); } }))}
        ${table(['المنتج', 'الحالة'], (c.products || []).map((p) => [esc(p.title), esc(productStatusLabel(p.status))]))}</section>`;
    wireActions(box);
}

const FIN_FILTERS = [['', 'كل حالات الدفع'], ['pending', 'بانتظار الدفع'], ['authorized', 'مفوَّض'], ['paid', 'مدفوع'], ['partially_paid', 'مدفوع جزئيًا'],
                     ['refunded', 'مسترد'], ['voided', 'ملغى الدفع']];
function renderOrders(box) {
    const sel = (id, opts) => `<label class="visually-hidden" for="${id}">${esc(opts[0][1])}</label><select id="${id}" class="form-control">${opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>`;
    box.innerHTML = `${bar(actionButton('order.create', {}, { tone: 'primary', onDone: (d) => d?.result?.id && openOrder(d.result.id) }))}
        ${searchForm('smOrdSearch', { placeholder: 'رقم الطلب أو البريد', filters: sel('smOrdFin', FIN_FILTERS) +
            sel('smOrdStatus', [['', 'كل الطلبات'], ['open', 'مفتوحة'], ['closed', 'مغلقة'], ['cancelled', 'ملغاة']]) })}
        <p class="field-hint">حالة الدفع كما يقولها Shopify؛ لا يظهر «مدفوع» إلا إن أكّده Shopify.</p>${listBox}`;
    wireActions(box);
    $('smOrdSearch').addEventListener('submit', (e) => { e.preventDefault(); runOrders(); });
    runOrders();
}
const orderRow = (o) => [esc(o.name), pill(o.fully_paid && o.financial_status === 'PAID' ? 'success' : 'warning', paymentLabel({ financial_status: o.financial_status, paid_confirmed: o.financial_status === 'PAID' && o.fully_paid }).text),
                         esc(fulfillmentLabel(o.fulfillment_status)), esc(money(o.total)), esc(o.customer_name || '—'),
                         `<button type="button" class="btn btn-ghost btn-sm" data-open-order="${esc(o.id)}">فتح</button>`];
async function runOrders(after = null) {
    const q = $('smOrdSearchQ')?.value.trim();
    const r = await read('order.list', { query: q || undefined, financial_status: $('smOrdFin')?.value || undefined, status: $('smOrdStatus')?.value || undefined,
                                         after: after || undefined }, $('smList'));
    if (!r) return;
    $('smList').innerHTML = `${table(['الطلب', 'الدفع', 'التنفيذ', 'الإجمالي', 'العميل', ''], r.items.map(orderRow))}
        ${r.page?.has_next ? '<button type="button" class="btn btn-secondary btn-sm" id="smMore">المزيد</button>' : ''}
        ${r.restricted ? '<p class="field-hint">بعض بيانات العملاء محجوبة حتى يعتمد Shopify وصول التطبيق للبيانات المحمية.</p>' : ''}`;
    $('smList').querySelectorAll('[data-open-order]').forEach((b) => b.addEventListener('click', () => openOrder(b.dataset.openOrder)));
    $('smMore')?.addEventListener('click', () => runOrders(r.page.cursor));
}
async function openOrder(id) {
    const box = $('smDetail');
    const o = await read('order.get', { id }, box);
    if (!o) return;
    const reopen = () => openOrder(id);
    const pay = paymentLabel(o.payment);
    const a = o.shipping_address;
    box.innerHTML = `<section class="panel ihub-record" aria-labelledby="smOrdTitle"><div class="panel-header"><div>
            <h2 class="panel-title" id="smOrdTitle">${esc(o.name)}</h2><p class="panel-subtitle">${o.test ? 'طلب تجريبي · ' : ''}بيانات حية من Shopify</p></div>
            ${o.admin_url ? `<a class="btn btn-secondary btn-sm" href="${esc(o.admin_url)}" target="_blank" rel="noopener noreferrer">فتح في Shopify</a>` : ''}</div>
        <p>${pill(pay.tone, pay.text)} ${o.cancelled_at ? pill('danger', 'ملغى') : ''}</p>
        ${facts([{ label: 'التنفيذ', value: fulfillmentLabel(o.fulfillment_status) }, { label: 'الإجمالي', value: money(o.total) },
                 { label: 'المستلم', value: money(o.payment?.received) }, { label: 'المتبقي', value: money(o.payment?.outstanding) },
                 { label: 'المسترد', value: money(o.payment?.refunded) }, { label: 'العميل', value: o.customer_name || '—' },
                 { label: 'الشحن إلى', value: a ? [a.city, a.country_code].filter(Boolean).join('، ') : '—' }, { label: 'ملاحظة', value: o.note || '—' }])}
        ${o.restricted ? '<p class="field-hint">بعض الحقول محجوبة: Shopify لم يعتمد بعد وصول التطبيق لبيانات العملاء المحمية.</p>' : ''}
        ${bar(actionButton('order.update_notes', { id }, { record: o, onDone: reopen }), actionButton('order.update_contact', { id }, { record: o, onDone: reopen }),
              !o.cancelled_at ? actionButton('order.cancel', { id }, { onDone: reopen }) : '')}
        ${table(['المنتج', 'SKU', 'الكمية', 'سعر الوحدة'], (o.lines || []).map((l) => [`${esc(l.title)}${l.variant_title ? ` — ${esc(l.variant_title)}` : ''}`,
            `<span dir="ltr">${esc(l.sku || '—')}</span>`, esc(l.current_quantity ?? l.quantity ?? '—'), esc(l.unit_price ?? '—')]))}
        <p class="field-hint">الاسترداد والتحصيل لا يتمان من مدعوم — من لوحة Shopify.</p>
        <div id="smFulfil" aria-live="polite"></div><div id="smReturns" aria-live="polite"></div></section>`;
    wireActions(box);
    if (opAvailability(state.status, 'fulfillment_order.list').enabled) showFulfillment(id);
    if (opAvailability(state.status, 'return.list').enabled) showReturns(id);
}
async function showFulfillment(orderId) {
    const box = $('smFulfil');
    const r = await read('fulfillment_order.list', { order_id: orderId }, box);
    if (!r || !box) return;
    const again = () => showFulfillment(orderId);
    box.innerHTML = `<h3 class="panel-title">التنفيذ والشحن</h3>
        ${table(['الموقع', 'الحالة', 'المتبقي', ''], r.fulfillment_orders.map((fo) => [esc(fo.location_name || '—'), esc(fulfillmentLabel(fo.status)),
            esc(fo.lines.reduce((n, l) => n + (l.remaining || 0), 0)),
            fo.can_fulfill ? actionButton('fulfillment.create', { order_id: orderId, fulfillment_order_id: fo.id },
                { label: 'شحن', extra: { fo_lines: fo.lines.filter((l) => l.remaining > 0).map((l) => ({ id: l.id, title: `${l.title}${l.variant_title ? ` — ${l.variant_title}` : ''}`, max: l.remaining })) }, onDone: again }) : '']))}
        ${r.fulfillments.length ? table(['الشحنة', 'التتبّع', ''], r.fulfillments.map((f) => [esc(fulfillmentLabel(f.status)),
            f.tracking.map((t) => `${esc(t.company || '')} <span dir="ltr">${esc(t.number || '')}</span>${t.url ? ` <a href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">تتبّع</a>` : ''}`).join('<br>') || '—',
            actionButton('fulfillment.tracking_update', { fulfillment_id: f.id }, { label: 'تحديث التتبّع', onDone: again })])) : ''}`;
    wireActions(box);
}
async function showReturns(orderId) {
    const box = $('smReturns');
    const r = await read('return.list', { order_id: orderId }, box);
    if (!r || !box) return;
    const again = () => showReturns(orderId);
    let returnable = null;
    if (opAvailability(state.status, 'returnable.list').enabled && opAvailability(state.status, 'return.create').enabled) {
        returnable = (await read('returnable.list', { order_id: orderId }))?.items || [];
    }
    box.innerHTML = `<h3 class="panel-title">المرتجعات</h3>
        ${returnable && returnable.length ? bar(actionButton('return.create', { order_id: orderId }, { extra: { returnable: returnable.map((l) => ({ id: l.fulfillment_line_item_id, title: l.title, max: l.quantity })) }, onDone: again })) : ''}
        ${table(['المرتجع', 'الحالة', 'الكمية', ''], r.items.map((x) => [esc(x.name), esc(RETURN_STATUS_LABELS[x.status] || x.status || '—'), esc(x.quantity ?? '—'),
            [x.status === 'REQUESTED' ? actionButton('return.approve', { id: x.id }, { label: 'قبول', onDone: again }) : '',
             x.status === 'REQUESTED' ? actionButton('return.decline', { id: x.id }, { label: 'رفض', onDone: again }) : '',
             x.status === 'OPEN' ? actionButton('return.close', { id: x.id }, { label: 'إغلاق', onDone: again }) : '',
             ['OPEN', 'REQUESTED'].includes(x.status) ? actionButton('return.cancel', { id: x.id }, { label: 'إلغاء', onDone: again }) : ''].join(' ')]))}
        <p class="field-hint">المرتجع لا يرد مالًا؛ الاسترداد من لوحة Shopify.</p>`;
    wireActions(box);
}

function renderAbandoned(box) {
    const u = ABANDONED_CHECKOUTS_UNAVAILABLE;
    box.innerHTML = `<section class="panel"><h3 class="panel-title">${esc(u.title)}</h3>
        <p class="panel-subtitle">${esc(u.text)}</p>
        <p class="field-hint">العمليات غير الموجودة في الكتالوج: <span dir="ltr">${esc(u.missingOps.join('، '))}</span>.</p>
        ${bar(`<button type="button" class="btn btn-secondary btn-sm" id="smGoDrafts">مسودات الطلبات</button>`)}
        <p class="field-hint">المسودات طلبات بدأها فريقك يدويًا — ليست طلبات مهملة من العملاء.</p></section>`;
    $('smGoDrafts').addEventListener('click', () => document.querySelector('[data-section="drafts"]')?.click());
}

async function renderShipping(box) {
    const u = SHIPPING_UNAVAILABLE;
    const shop = await read('shop.info', {}, box);
    if (!shop) return;
    const adminUrl = shop.domain ? `https://${shop.domain}/admin/settings/shipping` : null;
    box.innerHTML = `<section class="panel"><h3 class="panel-title">${esc(u.title)}</h3>
        <p class="panel-subtitle">${esc(u.text)}</p>
        <p class="field-hint">العمليات غير الموجودة في الكتالوج: <span dir="ltr">${esc(u.missingOps.join('، '))}</span>.</p>
        ${adminUrl ? `<a class="btn btn-primary btn-sm" href="${esc(adminUrl)}" target="_blank" rel="noopener noreferrer">فتح إعدادات الشحن في Shopify</a>` : '<p class="field-hint">تعذّر بناء رابط لوحة Shopify.</p>'}
        <p class="field-hint">شحن طلب بعينه وتحديث تتبّعه من قسم «الطلبات».</p></section>`;
}

async function renderAlerts(box) {
    renderSkeletonLines(box, 3);
    const [th, open] = await Promise.all([fetchThresholds(state.conn.id), fetchOpenAlerts(state.conn.id)]);
    if (!th.ok) {
        renderState(box, th.missing ? { variant: 'empty', title: 'تنبيهات المخزون غير متاحة بعد', text: 'لم تُطبَّق بعد على قاعدة البيانات.' }
                                    : { variant: 'error', title: 'تعذّر تحميل الحدود', text: manageErrorText({ error: th.code }) });
        return;
    }
    state.thresholds = Array.isArray(th.data) ? th.data : [];
    const openAlerts = open.ok && Array.isArray(open.data) ? open.data : [];
    const storeTh = state.thresholds.find((t) => t.scope === 'store');
    const variants = state.thresholds.filter((t) => t.scope === 'variant');
    box.innerHTML = `<section class="panel"><h3 class="panel-title">تنبيهات المخزون</h3>
        <p class="panel-subtitle">حد أدنى لكل متجر ولكل متغير. الفحص يقرأ المخزون الحي من Shopify (inventory.levels)؛
            عند أول وصول للحد يُسجَّل تنبيه ويُرسل إشعار واحد لمالك الشركة، ويُحلّ التنبيه حين يعود المخزون فوق الحد.</p>
        <div id="smAlertSummary" aria-live="polite"></div>
        <form class="toolbar owner-filters" id="smStoreThForm" novalidate>
            <label for="smStoreThMin">حد المتجر كله (المتاح)</label>
            <input type="number" id="smStoreThMin" class="form-control" min="0" max="999999" step="1" value="${esc(storeTh?.min_quantity ?? '')}" autocomplete="off">
            <button type="submit" class="btn btn-primary btn-sm">حفظ حد المتجر</button></form>
        <p class="field-hint">حد المتجر يسري على أي متغير بلا حد خاص، ويُطبَّق عند عرض مخزون المتغير: فإذا وُجد تحت الحد سُجّل تنبيه واحد لحد المتجر وأُرسل إشعار لمالك الشركة، ويُحلّ حين يُعرض متغير فوق الحد. الحد 0 يعني «نبّه عند النفاد». حدود المتغيرات تُفحص من زر «فحص الآن» أدناه.</p>
        <div class="company-form-actions sm-actions"><button type="button" class="btn btn-primary btn-sm" id="smCheckNow">فحص الآن</button></div>
        <h3 class="panel-title">حدود المتغيرات</h3>
        <div id="smThRows" aria-live="polite"></div>
        <form class="toolbar owner-filters" id="smAddThForm" novalidate>
            <label for="smAddVariant">معرّف المتغير</label>
            <input id="smAddVariant" class="form-control" inputmode="numeric" maxlength="60" autocomplete="off" placeholder="مثل 201 أو من صفحة المنتج">
            <label for="smAddMin">الحد الأدنى</label>
            <input type="number" id="smAddMin" class="form-control" min="0" max="999999" step="1" autocomplete="off">
            <button type="submit" class="btn btn-secondary btn-sm">إضافة حد</button></form>
        <p class="field-error" id="smThFormError" role="alert" hidden></p>
        <h3 class="panel-title">تنبيهات مفتوحة</h3>
        ${openAlerts.length ? table(['المنتج', 'المتاح', 'الحد الأدنى', 'منذ'], openAlerts.map((a) => [esc(a.product_title || '—'),
            esc(a.available ?? '—'), esc(a.min_quantity ?? '—'), esc(when(a.notified_at || a.created_at))])) : '<p class="panel-subtitle">لا تنبيهات مفتوحة.</p>'}
        <p class="field-hint">التنبيه يُحلّ تلقائيًا حين يعود المخزون فوق الحد عند الفحص التالي.</p></section>`;
    $('smStoreThForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const min = $('smStoreThMin').value;
        const errs = validateThreshold({ scope: 'store', min_quantity: min });
        if (errs.min_quantity) { toast(errs.min_quantity, 'error'); return; }
        const r = await saveThreshold(state.conn.id, { scope: 'store', minQuantity: Number(min) });
        if (!r.ok) { toast(r.missing ? 'تنبيهات المخزون غير متاحة بعد.' : manageErrorText({ error: r.code }), 'error'); return; }
        state.thresholds = null;
        toast('حُفظ حد المتجر.', 'success');
        renderAlerts(box);
    });
    $('smAddThForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = $('smThFormError');
        const variantId = $('smAddVariant').value.trim();
        const min = $('smAddMin').value;
        if (!variantId) { errBox.textContent = 'معرّف المتغير مطلوب.'; errBox.hidden = false; return; }
        errBox.hidden = true;
        const levels = await readQuiet('inventory.levels', { variant_id: variantId });
        if (!levels || !levels.inventory_item_id) { errBox.textContent = 'تعذّرت قراءة هذا المتغير من Shopify.'; errBox.hidden = false; return; }
        const errs = validateThreshold({ scope: 'variant', inventory_item_id: levels.inventory_item_id, variant_id: levels.variant_id, min_quantity: min });
        if (Object.keys(errs).length) { errBox.textContent = Object.values(errs).join(' — '); errBox.hidden = false; return; }
        const title = `${levels.product_title || ''} — ${levels.title || ''}`.trim();
        const r = await saveThreshold(state.conn.id, {
            scope: 'variant', inventoryItemId: levels.inventory_item_id, variantId: levels.variant_id,
            productTitle: title || null, minQuantity: Number(min)
        });
        if (!r.ok) { errBox.textContent = r.missing ? 'تنبيهات المخزون غير متاحة بعد.' : manageErrorText({ error: r.code }); errBox.hidden = false; return; }
        state.thresholds = null;
        toast('حُفظ حد المتغير.', 'success');
        renderAlerts(box);
    });
    $('smCheckNow').addEventListener('click', () => runAlertCheck(box));
    renderAlertRows();
}

function renderAlertRows(evaluated = null) {
    const host = $('smThRows');
    if (!host) return;
    const variants = (state.thresholds || []).filter((t) => t.scope === 'variant');
    if (!variants.length) { host.innerHTML = '<p class="panel-subtitle">لا حدود لمتغيرات بعد — أضف حدًا من هنا أو من زر «تعيين حد أدنى» في صفحة مخزون المتغير.</p>'; return; }
    const byId = new Map((evaluated || []).map((e) => [e.threshold.id, e]));
    host.innerHTML = table(['المنتج', 'الحد الأدنى', 'المتاح الآن', 'الحالة', ''], variants.map((t) => {
        const ev = byId.get(t.id);
        const avail = ev ? (ev.available === null ? 'تعذّرت القراءة' : String(ev.available)) : '…';
        const status = ev ? pill(ev.status === 'below' ? 'danger' : ev.status === 'ok' ? 'success' : 'warning', ALERT_STATUS_LABELS[ev.status]) : '—';
        return [esc(t.product_title || t.variant_id), esc(t.min_quantity),
            `<span data-avail-for="${esc(t.id)}">${esc(avail)}</span>`, `<span data-status-for="${esc(t.id)}">${status}</span>`,
            `<button type="button" class="btn btn-ghost btn-sm" data-th-edit="${esc(t.id)}">تعديل</button>
             <button type="button" class="btn btn-ghost btn-sm" data-th-del="${esc(t.id)}">حذف</button>`];
    }));
    host.querySelectorAll('[data-th-del]').forEach((b) => b.addEventListener('click', async () => {
        if (b.dataset.armed) {
            const r = await deleteThreshold(state.conn.id, b.dataset.thDel);
            if (!r.ok) { toast(manageErrorText({ error: r.code }), 'error'); return; }
            state.thresholds = null;
            toast('حُذف الحد.', 'success');
            renderAlerts($('smSection'));
            return;
        }
        b.dataset.armed = '1';
        b.textContent = 'تأكيد الحذف؟';
    }));
    host.querySelectorAll('[data-th-edit]').forEach((b) => b.addEventListener('click', () => {
        const t = (state.thresholds || []).find((x) => x.id === b.dataset.thEdit);
        if (t) openThresholdDialog({ scope: 'variant', inventory_item_id: t.inventory_item_id, variant_id: t.variant_id,
                                     product_title: t.product_title, min_quantity: t.min_quantity }, () => renderAlerts($('smSection')));
    }));
    if (!evaluated) refreshAlertLevels();
}

/** قراءة المتاح الحالي لكل حد متغير وتحديث خلايا الجدول (بلا تسجيل ولا إشعار). */
async function refreshAlertLevels() {
    const variants = (state.thresholds || []).filter((t) => t.scope === 'variant');
    if (!variants.length) return;
    const byItem = await loadAlertLevels(variants);
    const evaluated = evaluateInventoryAlerts(state.thresholds, byItem);
    for (const ev of evaluated) {
        const a = document.querySelector(`[data-avail-for="${CSS.escape(ev.threshold.id)}"]`);
        if (a) a.textContent = ev.available === null ? 'تعذّرت القراءة' : String(ev.available);
        const s = document.querySelector(`[data-status-for="${CSS.escape(ev.threshold.id)}"]`);
        if (s) s.innerHTML = pill(ev.status === 'below' ? 'danger' : ev.status === 'ok' ? 'success' : 'warning', ALERT_STATUS_LABELS[ev.status]);
    }
}

/** «فحص الآن»: تقييم من Shopify الحي + تسجيل + إشعار مالك الشركة عن الجديد فقط. */
async function runAlertCheck(box) {
    const btn = $('smCheckNow');
    if (btn) { btn.disabled = true; btn.textContent = 'جارٍ الفحص…'; }
    const byItem = await loadAlertLevels(state.thresholds);
    const evaluated = evaluateInventoryAlerts(state.thresholds, byItem);
    renderAlertRows(evaluated);
    const items = buildAlertReportItems(evaluated);
    const summary = $('smAlertSummary');
    if (!items.length) {
        if (summary) summary.innerHTML = '<p class="field-hint">لا حدود قابلة للفحص الآن (تعذّرت قراءة المخزون).</p>';
        if (btn) { btn.disabled = false; btn.textContent = 'فحص الآن'; }
        return;
    }
    const r = await reportInventoryAlerts(state.conn.id, items);
    const below = evaluated.filter((e) => e.status === 'below').length;
    if (summary) {
        summary.innerHTML = r.ok
            ? `<div class="state-block state-block--compact" role="status"><p class="state-title">نتيجة الفحص</p>
               <p class="state-text">فُحص ${esc(items.length)} حدًا: ${esc(below)} تحت الحد. ${r.data.notified ? `أُرسل إشعار لمالك الشركة عن ${esc(r.data.notified)} منتجًا وصل للحد لأول مرة.` : 'لا إشعارات جديدة.'}${r.data.resolved ? ` وحُلّ ${esc(r.data.resolved)} تنبيهًا بعد عودة المخزون فوق الحد.` : ''}</p></div>`
            : `<p class="field-error" role="alert">${esc(r.missing ? 'تنبيهات المخزون غير متاحة بعد.' : manageErrorText({ error: r.code }))}</p>`;
    }
    if (btn) { btn.disabled = false; btn.textContent = 'فحص الآن'; }
}

function renderDrafts(box) {
    box.innerHTML = `${bar(actionButton('draft_order.create', {}, { tone: 'primary', onDone: () => runDrafts() }))}
        <p class="field-hint">إكمال المسودة يعلّم الطلب مدفوعًا، فلا يتم من مدعوم — أكملها من لوحة Shopify.</p>${listBox}`;
    wireActions(box);
    runDrafts();
}
async function runDrafts() {
    const r = await read('draft_order.list', {}, $('smList'));
    if (!r) return;
    $('smList').innerHTML = table(['المسودة', 'الحالة', 'الإجمالي', 'العميل', ''], r.items.map((d) => [esc(d.name), esc(d.status || '—'), esc(money(d.total)), esc(d.customer_name || '—'),
        `<button type="button" class="btn btn-ghost btn-sm" data-open-draft="${esc(d.id)}">فتح</button>`]));
    $('smList').querySelectorAll('[data-open-draft]').forEach((b) => b.addEventListener('click', () => openDraft(b.dataset.openDraft)));
}
async function openDraft(id) {
    const box = $('smDetail');
    const d = await read('draft_order.get', { id }, box);
    if (!d) return;
    box.innerHTML = `<section class="panel"><h2 class="panel-title">${esc(d.name)}</h2>
        ${facts([{ label: 'الحالة', value: d.status }, { label: 'العميل', value: d.customer_name || '—' }, { label: 'المجموع', value: money(d.subtotal) },
                 { label: 'الإجمالي', value: money(d.total) }, { label: 'الخصم', value: d.discount ? `${d.discount.value}${d.discount.type === 'PERCENTAGE' ? '%' : ''} ${d.discount.title || ''}` : '—' }])}
        ${d.status !== 'COMPLETED' ? bar(actionButton('draft_order.update', { id }, { record: d, onDone: () => openDraft(id) }),
                                         actionButton('draft_order.delete', { id }, { onDone: () => { box.innerHTML = ''; runDrafts(); } })) : ''}
        ${table(['المنتج', 'الكمية', 'سعر الوحدة'], (d.lines || []).map((l) => [esc(l.title), esc(l.quantity ?? '—'), esc(l.unit_price ?? '—')]))}</section>`;
    wireActions(box);
}

function renderCustomers(box) {
    box.innerHTML = `${bar(actionButton('customer.create', {}, { tone: 'primary', onDone: (r) => r?.result?.id && openCustomer(r.result.id) }))}
        ${searchForm('smCusSearch', { placeholder: 'الاسم أو البريد' })}${listBox}`;
    wireActions(box);
    $('smCusSearch').addEventListener('submit', (e) => { e.preventDefault(); runCustomers(); });
    runCustomers();
}
async function runCustomers() {
    const r = await read('customer.list', { query: $('smCusSearchQ')?.value.trim() || undefined }, $('smList'));
    if (!r) return;
    $('smList').innerHTML = table(['العميل', 'البريد', 'الطلبات', ''], r.items.map((c) => [esc(c.name || '—'), `<span dir="ltr">${esc(c.email_masked || '—')}</span>`, esc(c.orders_count ?? '—'),
        `<button type="button" class="btn btn-ghost btn-sm" data-open-cus="${esc(c.id)}">فتح</button>`]));
    $('smList').querySelectorAll('[data-open-cus]').forEach((b) => b.addEventListener('click', () => openCustomer(b.dataset.openCus)));
}
async function openCustomer(id) {
    const box = $('smDetail');
    const c = await read('customer.get', { id }, box);
    if (!c) return;
    const orders = opAvailability(state.status, 'customer.orders').enabled ? await read('customer.orders', { id }) : null;
    box.innerHTML = `<section class="panel"><h2 class="panel-title">${esc(c.name || '—')}</h2>
        ${facts([{ label: 'البريد', value: c.email || '—' }, { label: 'الهاتف', value: c.phone || '—' }, { label: 'الطلبات', value: c.orders_count },
                 { label: 'إجمالي المشتريات', value: c.amount_spent ? `${c.amount_spent} ${c.currency || ''}` : '—' }, { label: 'ملاحظة', value: c.note || '—' }])}
        ${c.restricted ? '<p class="field-hint">بعض الحقول محجوبة: Shopify لم يعتمد بعد وصول التطبيق لبيانات العملاء المحمية.</p>' : ''}
        ${bar(actionButton('customer.update', { id }, { record: c, onDone: () => openCustomer(id) }))}
        ${orders ? `<h3 class="panel-title">طلبات العميل</h3>${table(['الطلب', 'الدفع', 'التنفيذ', 'الإجمالي', 'العميل', ''], orders.items.map(orderRow))}` : ''}</section>`;
    wireActions(box);
    box.querySelectorAll('[data-open-order]').forEach((b) => b.addEventListener('click', () => { state.section = 'orders'; openOrder(b.dataset.openOrder); }));
}

function renderDiscounts(box) {
    box.innerHTML = `${bar(actionButton('discount.code_create', {}, { tone: 'primary', onDone: () => runDiscounts() }),
                          actionButton('discount.automatic_create', {}, { tone: 'primary', onDone: () => runDiscounts() }))}
        ${searchForm('smDisSearch', { placeholder: 'عنوان الخصم', filters: `<label class="visually-hidden" for="smDisType">النوع</label>
            <select id="smDisType" class="form-control"><option value="code">خصومات الأكواد</option><option value="automatic">الخصومات التلقائية</option></select>` })}${listBox}`;
    wireActions(box);
    $('smDisSearch').addEventListener('submit', (e) => { e.preventDefault(); runDiscounts(); });
    runDiscounts();
}
async function runDiscounts() {
    const type = $('smDisType')?.value || 'code';
    const r = await read('discount.list', { type, query: $('smDisSearchQ')?.value.trim() || undefined }, $('smList'));
    if (!r) return;
    $('smList').innerHTML = table(['الخصم', 'الكود', 'الحالة', 'الفترة', 'الاستخدام', ''], r.items.map((d) => [esc(d.title), `<span dir="ltr">${esc(d.code || '—')}</span>`,
        esc(DISCOUNT_STATUS[d.status] || d.status || '—'), esc(`${when(d.starts_at)} ← ${d.ends_at ? when(d.ends_at) : 'مفتوح'}`),
        esc(d.usage_limit ? `${d.used ?? 0}/${d.usage_limit}` : (d.used ?? '—')), `<button type="button" class="btn btn-ghost btn-sm" data-open-dis="${esc(d.id)}">فتح</button>`]));
    $('smList').querySelectorAll('[data-open-dis]').forEach((b) => b.addEventListener('click', () => openDiscount(type, b.dataset.openDis)));
}
async function openDiscount(type, id) {
    const box = $('smDetail');
    const d = await read('discount.get', { type, id }, box);
    if (!d) return;
    const again = () => openDiscount(type, id);
    const ctx = { type, id };
    box.innerHTML = `<section class="panel"><h2 class="panel-title">${esc(d.title)}</h2>
        ${facts([{ label: 'الحالة', value: DISCOUNT_STATUS[d.status] || d.status }, { label: 'الملخص', value: d.summary }, { label: 'الكود', value: d.code || '—' },
                 { label: 'يبدأ', value: when(d.starts_at) }, { label: 'ينتهي', value: d.ends_at ? when(d.ends_at) : 'مفتوح' }])}
        ${bar(actionButton(type === 'code' ? 'discount.code_update' : 'discount.automatic_update', { id }, { onDone: again }),
              d.status === 'ACTIVE' || d.status === 'SCHEDULED' ? actionButton('discount.deactivate', ctx, { onDone: again }) : actionButton('discount.activate', ctx, { onDone: again }),
              actionButton('discount.delete', ctx, { onDone: () => { box.innerHTML = ''; runDiscounts(); } }))}</section>`;
    wireActions(box);
}

async function renderLog(box) {
    renderSkeletonLines(box, 3);
    const r = await fetchOpsLog(state.conn.id, 100);
    if (!r.ok) { renderState(box, { variant: 'error', title: 'تعذّر تحميل السجل', text: manageErrorText({ error: r.code }) }); return; }
    const items = Array.isArray(r.data) ? r.data : [];
    const tone = { succeeded: 'success', submitted: 'accent', failed: 'danger', requested: 'warning', unknown: 'warning' };
    box.innerHTML = `<p class="field-hint">كل عملية كتابة على Shopify من مدعوم: من نفّذها، ومتى، ونتيجتها كما سجّلها الخادم. «نتيجة غير معروفة» = انقطع التنفيذ؛ تحقّق في Shopify.</p>
        ${table(['الوقت', 'العملية', 'المنفّذ', 'النتيجة', 'التفاصيل'], items.map((x) => [esc(when(x.created_at)), esc(OP_LABELS[x.op] || x.op), esc(x.actor_name || '—'),
            pill(tone[x.status] || 'accent', OP_STATUS[x.status] || x.status) + (x.error_code ? ` <span class="field-hint">${esc(x.error_code)}</span>` : ''),
            `<span dir="ltr">${esc(x.resource_ref || '')}</span> ${x.detail?.reason ? esc(INVENTORY_REASON_LABELS[x.detail.reason] || x.detail.reason) : ''}
             ${Array.isArray(x.detail?.changes) ? esc(x.detail.changes.map((c) => (c.delta !== undefined ? `${c.delta > 0 ? '+' : ''}${c.delta}` : `= ${c.set}`)).join('، ')) : ''}`]))}`;
}

export const _internal = { actions };
