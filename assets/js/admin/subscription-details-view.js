/**
 * subscription-details-view.js — عرض وإدارة اشتراك واحد.
 *
 * وحدة واحدة تُستخدم في مكانين بلا تكرار:
 *   • نافذة منبثقة داخل admin/subscriptions.html (المسار الأساسي)
 *   • صفحة مستقلة admin/subscription-details.html (للروابط المباشرة)
 *
 * النافذة تحمل صنفَي modal-overlay و open عمدًا، لأن
 * assets/js/admin/modal-a11y.js يراقبهما ويمنحها تلقائيًا: حبس التركيز داخل
 * الحوار، قفل تمرير الخلفية، وإعادة التركيز إلى الزر الذي فتحها. تغيير هذين
 * الاسمين يُسقط كل ذلك بصمت وبلا خطأ في الكونسول.
 * تلك الوحدة تعترض Tab فقط ولا تعرف Escape، فالإغلاق بـEscape مُنفَّذ هنا.
 *
 * كل إجراء هنا يمر على دالة RPC تتحقق من is_admin() في القاعدة وتسجّل
 * التدقيق وتعيد حساب الامتيازات — الواجهة لا تقرر صلاحية شيء.
 */

import * as modalA11y from '/assets/js/admin/modal-a11y.js';

/**
 * نسخة محلية بدل الاستيراد من admin-utils.js عمدًا: ذلك الملف يستورد
 * /api-config.js فينشئ عميل Supabase ثانيًا، وصفحة الاشتراكات تنشئ عميلها
 * بنفسها من سكربت CDN كلاسيكي. الاستيراد كان سيعطينا جلستين ومستمعي مصادقة
 * مضاعفين مقابل دالة من سبعة أسطر.
 */
function escapeHtml(value) {
    return (value ?? '').toString()
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export const PLAN_LABELS = { support: 'الدعم الفني', whatsapp: 'واتساب', bundle: 'دعم فني + واتساب' };
export const STATUS_LABELS = {
    active: 'فعّال', pending: 'قيد المراجعة', expired: 'منتهٍ',
    rejected: 'مرفوض', superseded: 'مُستبدَل بترقية'
};
const ACTION_LABELS = {
    update: 'تعديل', deactivate: 'تعطيل', reactivate: 'إعادة تفعيل',
    reject: 'رفض', upgrade: 'ترقية ودمج'
};
const FIELD_LABELS = { plan: 'الباقة', status: 'الحالة', start_date: 'البداية', end_date: 'الانتهاء' };

const icon = (paths) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

function fmtDateTime(value) {
    if (!value) return '—';
    return new Date(value).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' });
}
function toDateInput(value) {
    if (!value) return '';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/* =========================================================
   جلب البيانات
   ========================================================= */

/**
 * تفاصيل اشتراك + سجل تغييراته.
 * القائمة تُقرأ من نفس دالة صفحة الاشتراكات، فالشاشتان لا يمكن أن تختلفا في
 * الحالة أو الامتيازات.
 */
export async function fetchSubscriptionDetails(client, subscriptionId) {
    const [listResult, auditResult] = await Promise.all([
        client.rpc('admin_list_subscriptions'),
        client.rpc('admin_subscription_audit', { p_subscription_id: subscriptionId })
    ]);

    if (listResult.error) throw listResult.error;

    const record = (listResult.data || []).find(r => r.id === subscriptionId) || null;
    return { record, audit: auditResult.error ? [] : (auditResult.data || []) };
}

/* =========================================================
   الرسم
   ========================================================= */

function statusPills(record) {
    const pills = [];
    const label = STATUS_LABELS[record.status] || record.status;
    const tone = record.is_active ? 'ok' : (record.status === 'pending' ? 'warn' : 'danger');
    pills.push(`<span class="subd-pill subd-pill--${tone}">${escapeHtml(label)}</span>`);

    if (record.status === 'active' && record.is_active !== true) {
        pills.push('<span class="subd-pill subd-pill--danger">منتهٍ فعليًا</span>');
    }
    if (record.company_name) {
        pills.push(`<span class="subd-pill subd-pill--muted">${escapeHtml(record.company_name)}</span>`);
    }
    if (record.billing_cycle) {
        pills.push(`<span class="subd-pill subd-pill--muted">${record.billing_cycle === 'yearly' ? 'سنوي' : 'شهري'}</span>`);
    }
    return pills.join('');
}

function statsBlock(record) {
    const features = Array.isArray(record.effective_features) ? record.effective_features : [];
    const daysTone = !record.is_active ? 'danger' : (record.days_remaining <= 7 ? 'warning' : 'success');
    const cards = [
        { label: 'الأيام المتبقية', value: record.is_active ? `${record.days_remaining}` : '—', tone: daysTone },
        { label: 'الخدمات الفعّالة', value: String(features.length), tone: features.length ? 'success' : 'danger' },
        { label: 'تاريخ البداية', value: record.start_date ? toDateInput(record.start_date) : '—', tone: '' },
        { label: 'تاريخ الانتهاء', value: record.end_date ? toDateInput(record.end_date) : '—', tone: '' }
    ];
    return cards.map(c => `
        <div class="subd-stat ${c.tone ? 'subd-stat--' + c.tone : ''}">
            <p class="subd-stat-label">${escapeHtml(c.label)}</p>
            <p class="subd-stat-value">${escapeHtml(c.value)}</p>
        </div>`).join('');
}

function describeChange(entry) {
    const oldV = entry.old_values || {}, newV = entry.new_values || {};
    const parts = [];
    for (const key of Object.keys(newV)) {
        if (String(oldV[key]) !== String(newV[key])) {
            parts.push(`${FIELD_LABELS[key] || key}: ${oldV[key] ?? '—'} ← ${newV[key] ?? '—'}`);
        }
    }
    return parts.join('، ') || 'بدون تغيير مسجّل';
}

/**
 * يبني محتوى التفاصيل داخل أي عنصر. لا يعرف شيئًا عن النافذة، فالصفحة
 * المستقلة تستخدمه كما هو.
 */
export function renderSubscriptionDetails(container, { record, audit = [] }) {
    const features = Array.isArray(record.effective_features) ? record.effective_features : [];
    const contradictory = record.status === 'active' && record.is_active !== true;

    container.innerHTML = `
    ${contradictory ? `<div class="subd-notice subd-notice--warn">
        الحالة المسجّلة <strong>فعّال</strong> لكن تاريخ الانتهاء فات، فالمنصة تتعامل معه كمنتهٍ.
        عدّل التاريخ أو الحالة ليتطابق السجل مع الواقع.
    </div>` : ''}

    <section class="subd-section">
        <div class="subd-pills">${statusPills(record)}</div>
        <div class="subd-stats">${statsBlock(record)}</div>
    </section>

    <section class="subd-section">
        <h3>${icon('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>')} العميل والاشتراك</h3>
        <dl class="subd-facts">
            ${[
                ['العميل', record.customer_name],
                ['البريد الإلكتروني', record.customer_email],
                ['الهاتف', record.customer_phone],
                ['الشركة', record.company_name],
                ['الباقة', record.plan_name_ar || record.plan],
                ['وسيلة الدفع', record.payment_method],
                ['التذكرة', record.ticket_number ? '#' + record.ticket_number : null],
                ['تاريخ الإنشاء', record.created_at ? fmtDateTime(record.created_at) : null]
            ].map(([label, value]) => `
                <div class="subd-fact">
                    <dt>${escapeHtml(label)}</dt>
                    <dd>${value ? escapeHtml(String(value)) : '<span class="is-empty">غير مسجّل</span>'}</dd>
                </div>`).join('')}
        </dl>
    </section>

    <section class="subd-section">
        <h3>${icon('<polyline points="20 6 9 17 4 12"/>')} الخدمات الفعلية للعميل الآن</h3>
        <p class="subd-impact">محسوبة من كل اشتراكاته الفعّالة، لا من اسم هذه الباقة وحدها.</p>
        <div class="subd-chips">
            ${features.length
                ? features.map(f => `<span class="subd-chip">${escapeHtml(f)}</span>`).join('')
                : '<span class="subd-chip subd-chip--none">لا توجد خدمات فعّالة</span>'}
        </div>
    </section>

    <section class="subd-section">
        <h3>${icon('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>')} تعديل الاشتراك</h3>
        <p class="subd-impact">
            العميل والتذكرة وبيانات الدفع غير قابلة للتعديل عمدًا: سجل تاريخي لما حدث فعلًا.
        </p>
        <div class="subd-form">
            <div class="subd-field">
                <label for="subdPlan">الباقة</label>
                <select id="subdPlan">
                    ${Object.entries(PLAN_LABELS).map(([k, v]) =>
                        `<option value="${k}"${k === record.plan ? ' selected' : ''}>${escapeHtml(v)}</option>`).join('')}
                </select>
            </div>
            <div class="subd-field">
                <label for="subdStatus">الحالة</label>
                <select id="subdStatus">
                    ${['active', 'pending', 'expired', 'rejected'].map(k =>
                        `<option value="${k}"${k === record.status ? ' selected' : ''}>${escapeHtml(STATUS_LABELS[k])}</option>`).join('')}
                </select>
            </div>
            <div class="subd-field">
                <label for="subdStart">تاريخ البداية</label>
                <input type="date" id="subdStart" value="${toDateInput(record.start_date)}">
            </div>
            <div class="subd-field">
                <label for="subdEnd">تاريخ الانتهاء</label>
                <input type="date" id="subdEnd" value="${toDateInput(record.end_date)}">
            </div>
            <div class="subd-field is-full">
                <label for="subdReason">سبب التغيير (يُحفظ في سجل التدقيق)</label>
                <input type="text" id="subdReason" placeholder="مثال: تسوية بعد شكوى العميل">
            </div>
            <p class="subd-impact" id="subdImpact"></p>
        </div>
    </section>

    <section class="subd-section">
        <h3>${icon('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>')} سجل التغييرات</h3>
        ${audit.length ? `<ul class="subd-audit">${audit.map(entry => `
            <li>
                <div class="who">${escapeHtml(entry.actor_email || 'غير معروف')} — ${escapeHtml(ACTION_LABELS[entry.action] || entry.action)}</div>
                <div>${escapeHtml(describeChange(entry))}</div>
                ${entry.reason ? `<div>السبب: ${escapeHtml(entry.reason)}</div>` : ''}
                <div class="when">${escapeHtml(fmtDateTime(entry.created_at))}</div>
            </li>`).join('')}</ul>`
            : '<p class="subd-impact">لا توجد تغييرات مسجّلة على هذا الاشتراك بعد.</p>'}
    </section>`;
}

/**
 * أزرار الإجراءات — منفصلة عن الجسم لتوضع في تذييل النافذة.
 * closeLabel يختلف بحسب الصدفة: "إغلاق" في النافذة، "رجوع" في الصفحة المستقلة
 * حيث لا يوجد شيء يُغلق.
 */
export function renderSubscriptionActions(footer, record, { closeLabel = 'إغلاق' } = {}) {
    footer.innerHTML = `
        <button type="button" class="subd-btn subd-btn--primary" id="subdSave">حفظ التعديل</button>
        ${record.status === 'active'
            ? '<button type="button" class="subd-btn subd-btn--danger" id="subdDeactivate">تعطيل الاشتراك</button>' : ''}
        ${record.status === 'expired'
            ? '<button type="button" class="subd-btn subd-btn--primary" id="subdReactivate">إعادة تفعيل</button>' : ''}
        <span class="spacer"></span>
        <span class="subd-status" id="subdStatusMsg" role="status" aria-live="polite"></span>
        <button type="button" class="subd-btn subd-btn--ghost" id="subdCancel">${escapeHtml(closeLabel)}</button>`;
}

/* =========================================================
   السلوك
   ========================================================= */

function setMessage(root, text, tone) {
    const el = root.querySelector('#subdStatusMsg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'subd-status' + (tone ? ` subd-status--${tone}` : '');
}

/** تأكيد داخل الحوار بدل نافذة المتصفح، حتى لا ينكسر سياق الشاشة. */
function askConfirm(footer, message, confirmLabel) {
    return new Promise((resolve) => {
        const box = document.createElement('div');
        box.className = 'subd-confirm';
        box.innerHTML = `
            <span class="msg">${escapeHtml(message)}</span>
            <button type="button" class="subd-btn subd-btn--danger" data-yes>${escapeHtml(confirmLabel)}</button>
            <button type="button" class="subd-btn subd-btn--ghost" data-no>تراجع</button>`;
        footer.appendChild(box);
        box.querySelector('[data-yes]').focus();
        const done = (v) => { box.remove(); resolve(v); };
        box.querySelector('[data-yes]').addEventListener('click', () => done(true));
        box.querySelector('[data-no]').addEventListener('click', () => done(false));
    });
}

/**
 * يربط النموذج والأزرار بدوال القاعدة.
 * @param {HTMLElement} root عنصر يحوي الجسم والتذييل معًا
 */
export function wireSubscriptionActions(root, { record, client, onChanged, onClose }) {
    const footer = root.querySelector('[data-subd-footer]') || root;
    const $ = (id) => root.querySelector('#' + id);

    /* أثر تغيير الباقة على الخدمات — يُعرض قبل الحفظ لا بعده */
    async function showPlanImpact() {
        const el = $('subdImpact');
        const nextPlan = $('subdPlan').value;
        if (!el) return;
        if (nextPlan === record.plan) { el.innerHTML = ''; return; }

        const { data, error } = await client.rpc('plan_feature_keys', { p_plan_key: nextPlan });
        if (error) { el.innerHTML = ''; return; }

        const next = new Set(data || []);
        const current = new Set(Array.isArray(record.effective_features) ? record.effective_features : []);
        const lost = [...current].filter(f => !next.has(f));
        const gained = [...next].filter(f => !current.has(f));

        el.innerHTML = `تغيير الباقة سيعيد حساب الخدمات:
            ${gained.length ? `<strong>يُضاف:</strong> ${escapeHtml(gained.join('، '))}. ` : ''}
            ${lost.length ? `<strong>يُسحب:</strong> ${escapeHtml(lost.join('، '))}.` : ''}
            ${!gained.length && !lost.length ? 'لا تغيير في الخدمات.' : ''}`;
    }

    $('subdPlan')?.addEventListener('change', showPlanImpact);
    showPlanImpact();

    async function call(rpc, args, okMessage, button) {
        if (button) button.disabled = true;
        setMessage(root, 'جارٍ التنفيذ…', '');
        const { error } = await client.rpc(rpc, args);
        if (button) button.disabled = false;

        if (error) { setMessage(root, error.message, 'error'); return false; }
        setMessage(root, okMessage, 'ok');
        await onChanged?.();
        // onChanged يعيد جلب الصف ورسم التذييل، فالرسالة تُمحى معه. نعيدها بعده
        // لأن الأدمن يحتاج تأكيدًا مرئيًا لما نُفِّذ، لا شاشة تُومض ثم تصمت.
        setMessage(root, okMessage, 'ok');
        return true;
    }

    $('subdSave')?.addEventListener('click', async (event) => {
        const plan = $('subdPlan').value;
        const start = $('subdStart').value;
        const end = $('subdEnd').value;
        const reason = $('subdReason').value;

        if (plan !== record.plan) {
            const ok = await askConfirm(footer,
                `تغيير الباقة من "${PLAN_LABELS[record.plan] || record.plan}" إلى "${PLAN_LABELS[plan] || plan}" سيعيد حساب خدمات العميل.`,
                'نعم، غيّر الباقة');
            if (!ok) return;
        }

        await call('admin_update_subscription', {
            p_subscription_id: record.id,
            p_plan: plan,
            p_status: $('subdStatus').value,
            p_start_date: start ? new Date(start).toISOString() : null,
            p_end_date: end ? new Date(end).toISOString() : null,
            p_reason: reason || null
        }, 'تم حفظ التعديل وإعادة حساب الخدمات', event.currentTarget);
    });

    $('subdDeactivate')?.addEventListener('click', async (event) => {
        const count = (record.effective_features || []).length;
        const ok = await askConfirm(footer,
            `تعطيل اشتراك "${record.customer_name}" سيوقف خدماته فورًا (${count} خدمة فعّالة).`,
            'نعم، عطّل الاشتراك');
        if (!ok) return;

        await call('admin_set_subscription_status', {
            p_subscription_id: record.id, p_status: 'expired',
            p_reason: $('subdReason').value || null
        }, 'تم تعطيل الاشتراك وإيقاف خدماته', event.currentTarget);
    });

    $('subdReactivate')?.addEventListener('click', async (event) => {
        const end = $('subdEnd').value;
        if (!end || new Date(end) <= new Date()) {
            setMessage(root, 'حدّد تاريخ انتهاء في المستقبل قبل إعادة التفعيل', 'error');
            $('subdEnd').focus();
            return;
        }
        await call('admin_set_subscription_status', {
            p_subscription_id: record.id, p_status: 'active',
            p_reason: $('subdReason').value || null,
            p_end_date: new Date(end).toISOString()
        }, 'تم إعادة تفعيل الاشتراك', event.currentTarget);
    });

    $('subdCancel')?.addEventListener('click', () => onClose?.());
}

/* =========================================================
   الأصداف: نافذة منبثقة أو صفحة مستقلة
   ========================================================= */

const SKELETON = `<div class="subd-skeleton" aria-hidden="true">
    <span></span><span></span><span></span></div>`;

const CLOSE_ICON = icon('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>');
const OPEN_PAGE_ICON = icon('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>');

function subtitleOf(record) {
    if (!record) return '';
    const parts = [record.customer_name, record.plan_name_ar || PLAN_LABELS[record.plan] || record.plan];
    if (record.company_name) parts.push(record.company_name);
    return parts.filter(Boolean).join(' • ');
}

/**
 * يعرض تفاصيل اشتراك داخل عنصر جاهز (جسم + تذييل)، ويعيد الرسم بعد كل إجراء.
 * تُستخدم من النافذة ومن الصفحة المستقلة، فمنطق الإدارة مكتوب مرة واحدة.
 *
 * @returns {{ready: Promise<void>, reload: () => Promise<void>, getRecord: () => object|null}}
 */
export function mountSubscriptionDetails({ client, subscriptionId, body, footer, root, onChanged, onClose, onRecord, closeLabel }) {
    const scope = root || body.parentElement || body;
    let record = null;

    async function draw(fetched) {
        record = fetched.record;
        if (!record) {
            body.innerHTML = '<div class="subd-notice subd-notice--error">لا يوجد اشتراك بهذا المعرّف، أو لا تملك صلاحية عرضه.</div>';
            if (footer) footer.innerHTML = '<span class="spacer"></span><button type="button" class="subd-btn subd-btn--ghost" id="subdCancel">إغلاق</button>';
            scope.querySelector('#subdCancel')?.addEventListener('click', () => onClose?.());
            onRecord?.(null);
            return;
        }

        renderSubscriptionDetails(body, { record, audit: fetched.audit });
        if (footer) renderSubscriptionActions(footer, record, { closeLabel });
        wireSubscriptionActions(scope, { record, client, onClose, onChanged: reload });
        onRecord?.(record);
    }

    /** إعادة الجلب بعد كل إجراء: الشاشة تعرض ما في القاعدة فعلًا، لا ما أرسلناه. */
    async function reload() {
        await onChanged?.(record);
        await draw(await fetchSubscriptionDetails(client, subscriptionId));
    }

    async function start() {
        body.innerHTML = SKELETON;
        try {
            await draw(await fetchSubscriptionDetails(client, subscriptionId));
        } catch (err) {
            body.innerHTML = `<div class="subd-notice subd-notice--error">تعذر تحميل الاشتراك: ${escapeHtml(err.message || String(err))}</div>`;
            onRecord?.(null);
        }
    }

    return { ready: start(), reload, getRecord: () => record };
}

/**
 * يفتح تفاصيل الاشتراك في نافذة منبثقة فوق صفحة الاشتراكات.
 *
 * الفتح يتم بإضافة الصنف open **بعد** إدراج العنصر في الصفحة، لأن
 * modal-a11y.js يعتمد على MutationObserver لتغيّر الصنف: عنصر يُدرَج وهو
 * مفتوح أصلًا لا يولّد أي سجل تغيير، فيفقد حبس التركيز وقفل التمرير بصمت.
 *
 * @returns {{ close: () => void, ready: Promise<void> }}
 */
export function openSubscriptionModal({ client, subscriptionId, onChanged }) {
    modalA11y.init();

    // نافذة سابقة عالقة: نُغلقها بنفس المسار (إزالة open ثم الحذف) لا بحذف
    // مباشر، وإلا بقي قفل تمرير الصفحة الذي وضعه modal-a11y بلا فكّ.
    const stale = document.querySelector('.subd-overlay');
    if (stale) { stale.classList.remove('open'); stale.remove(); }

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay subd-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-labelledby', 'subdTitle');
    overlay.innerHTML = `
        <div class="subd-dialog">
            <header class="subd-head">
                <div>
                    <h2 class="subd-title" id="subdTitle">تفاصيل الاشتراك</h2>
                    <p class="subd-sub" data-subd-subtitle>جارٍ التحميل…</p>
                </div>
                <div class="subd-head-actions">
                    <a class="subd-openpage" href="/admin/subscription-details.html?id=${encodeURIComponent(subscriptionId)}"
                       title="فتح في صفحة مستقلة" aria-label="فتح في صفحة مستقلة">${OPEN_PAGE_ICON}</a>
                    <!-- data-modal-initial-focus: النافذة تبدأ بملخّص ثم نموذج، والتركيز
                         التلقائي على أول حقل كان يفتحها ممرَّرة لأسفل وقد تجاوزت الملخّص
                         (واضح على الجوال). زر الإغلاق في الأعلى فلا يحرّك التمرير. -->
                    <button type="button" class="subd-close" data-subd-close
                            data-modal-initial-focus aria-label="إغلاق النافذة">${CLOSE_ICON}</button>
                </div>
            </header>
            <div class="subd-body" data-subd-body></div>
            <footer class="subd-foot" data-subd-footer></footer>
        </div>`;

    document.body.appendChild(overlay);

    let closed = false;
    function close() {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onEscape);
        // إزالة open أولًا حتى يلتقط modal-a11y الإغلاق فيفكّ قفل التمرير
        // ويعيد التركيز إلى الزر؛ الحذف المباشر كان سيترك الصفحة مقفولة.
        overlay.classList.remove('open');
        overlay.remove();
    }
    function onEscape(e) {
        if (e.key !== 'Escape') return;
        // النافذة الأعلى فقط: تأكيد داخلي مفتوح يُغلق نفسه لا الشاشة كلها
        if (overlay.querySelector('.subd-confirm')) { overlay.querySelector('.subd-confirm [data-no]')?.click(); return; }
        close();
    }

    overlay.querySelector('[data-subd-close]').addEventListener('click', close);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onEscape);

    const mounted = mountSubscriptionDetails({
        client, subscriptionId,
        body: overlay.querySelector('[data-subd-body]'),
        footer: overlay.querySelector('[data-subd-footer]'),
        root: overlay,
        onChanged, onClose: close,
        onRecord: (record) => {
            const sub = overlay.querySelector('[data-subd-subtitle]');
            if (sub) sub.textContent = record ? subtitleOf(record) : 'غير متاح';
        }
    });

    // الصنف open بعد الإدراج — انظر التعليق أعلى الدالة
    overlay.classList.add('open');

    return { close, ready: mounted.ready };
}
