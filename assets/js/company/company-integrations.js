/**
 * company-integrations.js — قسم «التكاملات» في لوحة الشركة.
 *
 * بطاقة لكل مزوّد (ووردبريس، ووكومرس، سلة، دفترة): الحالة، الحساب المربوط،
 * القدرات المتاحة فعلًا، آخر نجاح، آخر خطأ (رمز ثابت مترجم)، وأزرار الربط
 * والاختبار والتدوير والفصل — كل زر يظهر فقط حين تسمح به حمولة القاعدة.
 *
 * الأسرار: حقول المفاتيح من نوع password ولا تُحفظ في الصفحة بعد الإرسال.
 * الأسرار المولّدة (سر الويب هوك، رمز اقتران الإضافة) تُعرض مرة واحدة ثم تُمسح.
 *
 * القرار كله في القاعدة (ihub_*) والدالة الطرفية integrations-api.
 */

import {
    buildProviderCards, validateConnectForm, errorMessage, isSallaAuthorizeUrl,
    oauthResultFrom, oauthBindingKey, VIEW_ROLE_OPTIONS
} from '/assets/js/company/integrations-model.js';
import {
    fetchIntegrationsOverview, prepareConnection, disconnectConnection, setConnectionViewRole,
    fetchIntakeRequests, dismissIntake, convertIntake, fetchIntegrationAudit, invokeIntegrationsApi
} from '/assets/js/company/integrations-data.js';
import { escapeHtml, formatDate, formatDateTime, renderState, renderSkeletonLines } from '/assets/js/customer/portal-ui.js';
import { ui } from '/ui-service.js';

const CONTAINER_ID = 'companyIntegrations';

let overview = null;
let cards = null;
let openForm = null;      // مزوّد نموذجه مفتوح
let revealed = null;      // { provider, kind, value, url } — يُعرض مرة واحدة
let intake = [];
let lastConversion = null; // { ticketNumber, ticketId, orderRef }
let getMembers = () => [];
let pendingCompletion = Promise.resolve();

/**
 * بصمة تدفق OAuth: تبقى في هذا التبويب (sessionStorage) ولا تُرسل إلا لإكمال
 * نفس الربط. بلا تبويب البداية لا إكمال — وهذا هو الحاجز ضد ربط متجر ضحية.
 */
function bindingStore() {
    try { return window.sessionStorage; } catch { return null; }
}

async function completeOauth(result) {
    const store = bindingStore();
    const key = oauthBindingKey(result.connectionId);
    const binding = store?.getItem(key);
    store?.removeItem(key);
    if (!binding) {
        ui?.showToast?.('اكتمل التفويض في متصفح أو تبويب آخر. ابدأ الربط من جديد من هذه الصفحة.', 'error');
        return;
    }
    const r = await invokeIntegrationsApi('oauth_complete', { connection_id: result.connectionId, binding, completion: result.completion });
    if (r.ok) ui?.showToast?.('تم ربط سلة بنجاح.', 'success');
    else ui?.showToast?.(errorMessage(r.code), 'error');
}

const el = (id) => document.getElementById(id);
const box = () => el(CONTAINER_ID);

export function initCompanyIntegrations({ members } = {}) {
    if (typeof members === 'function') getMembers = members;
    const result = oauthResultFrom(window.location.search);
    if (result) {
        const clean = new URL(window.location.href);
        // رمز الإكمال يُمسح من شريط العنوان فورًا (لا يبقى في السجل ولا يُشارَك بنسخ الرابط)
        ['ihub_result', 'ihub_code', 'ihub_provider', 'ihub_connection', 'ihub_completion'].forEach((k) => clean.searchParams.delete(k));
        history.replaceState(null, '', clean.pathname + clean.search + clean.hash);
        if (result.confirm) pendingCompletion = completeOauth(result);
        else ui?.showToast?.(result.message, result.ok ? 'success' : 'error');
    }
}

export async function loadCompanyIntegrations() {
    const c = box();
    if (!c) return;
    renderSkeletonLines(c, 4);
    await pendingCompletion;
    const r = await fetchIntegrationsOverview();
    if (!r.ok) {
        renderState(c, { variant: 'error', title: 'تعذّر تحميل التكاملات', text: r.error || '' });
        return;
    }
    overview = r.data;
    cards = buildProviderCards(overview);
    if (cards && overview?.entitled) {
        const ir = await fetchIntakeRequests('new');
        intake = ir.ok && Array.isArray(ir.data) ? ir.data : [];
    } else {
        intake = [];
    }
    render();
}

/* ── الرسم ─────────────────────────────────────────────────────────────── */

function render() {
    const c = box();
    if (!c) return;
    if (!cards) {
        renderState(c, {
            variant: 'empty',
            title: 'مركز التكاملات لمدير الشركة',
            text: 'ربط ووردبريس وووكومرس وسلة ودفترة يديره مدير الشركة. تواصل معه إن احتجت سياق الطلبات في تذاكرك.'
        });
        return;
    }
    c.innerHTML = `
        <section class="panel" aria-labelledby="ihubHeading">
            <div class="panel-header">
                <div>
                    <h2 class="panel-title" id="ihubHeading">التكاملات</h2>
                    <p class="panel-subtitle">اربط أنظمتك ليرى فريقك حالة الطلب أو الفاتورة داخل تذكرة العميل. الأنظمة الخارجية تبقى المرجع لبياناتها؛ نحفظ ملخصًا مختصرًا للسجلات المربوطة بتذاكر فقط.</p>
                </div>
            </div>
            ${overview.entitled ? '' : `
            <p class="company-notice company-notice--warning" role="status">اشتراك شركتك لا يشمل مركز التكاملات. البطاقات أدناه للاطلاع فقط.</p>`}
            ${revealed ? revealHtml(revealed) : ''}
            <div class="ihub-grid">${cards.map(cardHtml).join('')}</div>
        </section>
        ${intakeHtml()}
        <section class="panel" aria-labelledby="ihubAuditHeading">
            <details id="ihubAudit">
                <summary class="panel-title" id="ihubAuditHeading">سجل عمليات التكاملات</summary>
                <div id="ihubAuditBody"><p class="panel-subtitle">يُحمَّل عند الفتح.</p></div>
            </details>
        </section>`;
    wire();
}

function capsHtml(caps) {
    return `<ul class="ihub-caps" aria-label="القدرات">
        ${caps.map((cap) => `
        <li class="${cap.available ? 'is-on' : 'is-off'}" data-cap="${cap.key}">
            <span aria-hidden="true">${cap.available ? '✓' : '✕'}</span>
            <span>${escapeHtml(cap.name)}</span>
            <span class="ihub-cap-state">${escapeHtml(cap.state)}</span>
        </li>`).join('')}
    </ul>`;
}

function cardHtml(card) {
    const c = card.connection;
    const a = card.actions;
    const btn = (action, label, cls = 'btn-secondary') =>
        `<button type="button" class="btn ${cls} btn-sm" data-ihub-action="${action}" data-provider="${card.key}">${label}</button>`;
    return `
    <article class="panel ihub-card" data-provider="${card.key}" aria-labelledby="ihubCard-${card.key}">
        <div class="panel-header">
            <div>
                <h3 class="panel-title" id="ihubCard-${card.key}">${escapeHtml(card.name)}
                    ${card.beta ? '<span class="pill status-tone-accent" title="لم يُتحقق منه بعد على حساب حقيقي">تجريبي</span>' : ''}
                </h3>
                <p class="panel-subtitle">${escapeHtml(card.hint)}</p>
            </div>
            <span class="pill ${card.status.pill}"><span class="pill-dot"></span>${escapeHtml(card.status.label)}</span>
        </div>
        ${card.enabled ? '' : '<p class="company-notice" role="status">غير متاح حاليًا على المنصة.</p>'}
        <dl class="ihub-facts">
            ${card.accountLabel ? `<div><dt>الحساب</dt><dd>${escapeHtml(card.accountLabel)}</dd></div>` : ''}
            ${card.lastSuccessAt ? `<div><dt>آخر نجاح</dt><dd>${escapeHtml(formatDateTime(card.lastSuccessAt))}</dd></div>` : ''}
        </dl>
        ${card.lastError ? `<p class="field-error" role="status">${escapeHtml(card.lastError)}</p>` : ''}
        ${capsHtml(card.capabilities)}
        ${a.viewRole ? viewRoleHtml(card) : ''}
        <div class="company-form-actions">
            ${a.connect ? btn(card.key === 'salla' ? 'oauth' : 'open-form', card.key === 'salla' ? 'ربط عبر سلة' : 'ربط', 'btn-primary') : ''}
            ${a.reconnect ? btn('oauth', 'إعادة الربط', 'btn-primary') : ''}
            ${a.test ? btn('test', 'اختبار الاتصال') : ''}
            ${a.rotate ? btn('rotate', card.key === 'wordpress' ? 'رمز اقتران جديد' : 'سر ويب هوك جديد') : ''}
            ${a.disconnect ? btn('disconnect', 'فصل', 'btn-ghost') : ''}
        </div>
        <p class="field-error" id="ihubError-${card.key}" role="alert" hidden></p>
        ${openForm === card.key ? formHtml(card.key) : ''}
    </article>`;
}

function viewRoleHtml(card) {
    const id = `ihubRole-${card.key}`;
    return `
    <div class="form-field">
        <label for="${id}">من يرى بيانات ${escapeHtml(card.name)} في التذاكر</label>
        <select id="${id}" class="form-control" data-ihub-role="${card.connection.id}">
            ${VIEW_ROLE_OPTIONS.map((o) => `<option value="${o.value}" ${card.connection.min_view_role === o.value ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
        </select>
        <p class="field-hint">موظفو الفريق يرون السياق فقط في التذاكر التي يملكون رؤيتها أصلًا.</p>
    </div>`;
}

function field(id, name, label, { type = 'text', hint = '', placeholder = '' } = {}) {
    return `
    <div class="form-field">
        <label for="${id}">${label}</label>
        <input id="${id}" name="${name}" type="${type}" class="form-control" autocomplete="off" spellcheck="false"
               ${placeholder ? `placeholder="${placeholder}"` : ''} dir="ltr" required>
        ${hint ? `<p class="field-hint">${hint}</p>` : ''}
        <p class="field-error" data-field-error="${name}" hidden></p>
    </div>`;
}

function formHtml(provider) {
    const id = `ihubForm-${provider}`;
    let fields = '';
    let help = '';
    if (provider === 'woocommerce') {
        help = 'في ووكومرس: الإعدادات ← متقدم ← REST API ← إضافة مفتاح بصلاحية «قراءة» فقط. مدعوم لا يكتب في متجرك.';
        fields = field(`${id}-url`, 'store_url', 'رابط المتجر', { placeholder: 'https://shop.example.com' })
            + field(`${id}-ck`, 'consumer_key', 'Consumer key', { type: 'password', placeholder: 'ck_…' })
            + field(`${id}-cs`, 'consumer_secret', 'Consumer secret', { type: 'password', placeholder: 'cs_…' });
    } else if (provider === 'daftra') {
        help = 'في دفترة: الإعدادات ← مفاتيح API. يكفي مفتاح بصلاحية قراءة الفواتير والعملاء. مدعوم لا يصدر فواتير ولا يعدّل حساباتك.';
        fields = field(`${id}-sub`, 'subdomain', 'اسم حسابك في دفترة', { placeholder: 'acme', hint: 'الجزء الأول من acme.daftra.com' })
            + field(`${id}-key`, 'api_key', 'مفتاح API', { type: 'password' });
    } else if (provider === 'wordpress') {
        help = 'بعد الإنشاء يظهر رمز اقتران مرة واحدة؛ الصقه في إعدادات إضافة «مدعوم» على موقعك.';
        fields = field(`${id}-url`, 'site_url', 'رابط موقعك', { placeholder: 'https://example.com' });
    }
    return `
    <form class="company-form ihub-form" id="${id}" data-ihub-form="${provider}" novalidate>
        <p class="panel-subtitle">${escapeHtml(help)}</p>
        <div class="form-grid">${fields}</div>
        <div class="company-form-actions">
            <button type="submit" class="btn btn-primary">تحقق واربط</button>
            <button type="button" class="btn btn-secondary" data-ihub-action="close-form" data-provider="${provider}">إلغاء</button>
        </div>
    </form>`;
}

function revealHtml(r) {
    const title = r.kind === 'pairing' ? 'رمز اقتران إضافة ووردبريس' : 'إعداد ويب هوك ووكومرس';
    const body = r.kind === 'pairing'
        ? `<p>الصق هذا الرمز في: ووردبريس ← الإعدادات ← مدعوم ← رمز الاقتران.</p>
           <label class="visually-hidden" for="ihubRevealValue">رمز الاقتران</label>
           <textarea id="ihubRevealValue" class="form-control" rows="3" readonly dir="ltr">${escapeHtml(r.value)}</textarea>`
        : `<p>في ووكومرس: الإعدادات ← متقدم ← Webhooks ← إضافة ويب هوك لكل موضوع: ${escapeHtml((r.topics || []).join('، '))}، بإصدار API ‏v3.</p>
           <div class="form-field"><label for="ihubRevealUrl">رابط التسليم</label>
             <input id="ihubRevealUrl" class="form-control" readonly dir="ltr" value="${escapeHtml(r.url)}"></div>
           <div class="form-field"><label for="ihubRevealValue">السر</label>
             <input id="ihubRevealValue" class="form-control" readonly dir="ltr" value="${escapeHtml(r.value)}"></div>`;
    return `
    <div class="company-notice company-notice--warning ihub-reveal" role="alert" aria-labelledby="ihubRevealTitle">
        <h3 class="panel-title" id="ihubRevealTitle">${title}</h3>
        ${body}
        <p><strong>لن يُعرض هذا مرة أخرى.</strong> إن فقدته أنشئ واحدًا جديدًا من البطاقة.</p>
        <button type="button" class="btn btn-primary btn-sm" data-ihub-action="dismiss-reveal">نسخته — إخفاء</button>
    </div>`;
}

function intakeHtml() {
    const hasWp = (overview?.connections || []).some((c) => c.provider === 'wordpress');
    if (!hasWp && !intake.length) return '';
    const members = (getMembers() || []).filter((m) => !m.is_owner);
    const options = members.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name || 'عميل')}${m.email ? ` — ${escapeHtml(m.email)}` : ''}</option>`).join('');
    const conversion = lastConversion ? `
        <div class="company-notice" role="status">
            أُنشئت التذكرة #${escapeHtml(String(lastConversion.ticketNumber ?? ''))}.
            ${lastConversion.orderRef && lastConversion.wooId ? `
            <button type="button" class="btn btn-secondary btn-sm" data-ihub-action="link-intake-order">ربط الطلب #${escapeHtml(lastConversion.orderRef)} من ووكومرس بالتذكرة</button>` : ''}
        </div>` : '';
    return `
    <section class="panel" aria-labelledby="ihubIntakeHeading">
        <div class="panel-header">
            <div>
                <h2 class="panel-title" id="ihubIntakeHeading">طلبات الدعم من موقعك</h2>
                <p class="panel-subtitle">وصلت عبر إضافة ووردبريس. ليست تذاكر بعد: حوّل الطلب لتذكرة باسم عميل في شركتك تختاره أنت، أو ارفضه. لا مطابقة تلقائية بالبريد.</p>
            </div>
        </div>
        ${conversion}
        ${intake.length ? `<ul class="ihub-intake">${intake.map((i) => `
            <li class="ihub-intake-item" data-intake="${escapeHtml(i.id)}">
                <p><strong>${escapeHtml(i.subject)}</strong> — ${escapeHtml(i.requester_name)} &lt;<span dir="ltr">${escapeHtml(i.requester_email)}</span>&gt;
                   · ${escapeHtml(formatDate(i.created_at))}${i.external_order_ref ? ` · طلب #${escapeHtml(i.external_order_ref)}` : ''}</p>
                <p class="ihub-intake-message">${escapeHtml(String(i.message).slice(0, 600))}</p>
                <div class="company-form-actions">
                    <label class="visually-hidden" for="ihubIntakeCustomer-${escapeHtml(i.id)}">العميل</label>
                    <select id="ihubIntakeCustomer-${escapeHtml(i.id)}" class="form-control" data-intake-customer="${escapeHtml(i.id)}">
                        <option value="">اختر العميل في شركتك…</option>${options}
                    </select>
                    <button type="button" class="btn btn-primary btn-sm" data-ihub-action="convert" data-intake-id="${escapeHtml(i.id)}">تحويل لتذكرة</button>
                    <button type="button" class="btn btn-ghost btn-sm" data-ihub-action="dismiss" data-intake-id="${escapeHtml(i.id)}">رفض</button>
                </div>
            </li>`).join('')}</ul>`
            : '<p class="panel-subtitle">لا توجد طلبات جديدة.</p>'}
    </section>`;
}

/* ── الأحداث ───────────────────────────────────────────────────────────── */

function showError(provider, code) {
    const e = el(`ihubError-${provider}`);
    if (!e) { ui?.showToast?.(errorMessage(code), 'error'); return; }
    e.textContent = errorMessage(code);
    e.hidden = false;
}

async function busy(button, fn) {
    if (!button) return fn();
    const original = button.textContent;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = 'جارٍ التنفيذ…';
    try {
        return await fn();
    } finally {
        button.disabled = false;
        button.removeAttribute('aria-busy');
        button.textContent = original;
    }
}

function cardOf(provider) {
    return (cards || []).find((c) => c.key === provider);
}

async function ensureConnectionId(provider) {
    const existing = cardOf(provider)?.connection;
    if (existing) return { id: existing.id };
    const r = await prepareConnection(provider, null);
    if (!r.ok) return { error: r.code || 'unknown_error' };
    return { id: r.data?.id };
}

async function onSubmitForm(form) {
    const provider = form.getAttribute('data-ihub-form');
    const values = Object.fromEntries(new FormData(form).entries());
    form.querySelectorAll('[data-field-error]').forEach((p) => { p.hidden = true; });
    const v = validateConnectForm(provider, values);
    if (!v.ok) {
        for (const [name, msg] of Object.entries(v.errors)) {
            const p = form.querySelector(`[data-field-error="${name}"]`);
            if (p) { p.textContent = msg; p.hidden = false; }
        }
        form.querySelector('[data-field-error]:not([hidden])')?.previousElementSibling?.focus?.();
        return;
    }
    const submit = form.querySelector('button[type="submit"]');
    await busy(submit, async () => {
        const conn = await ensureConnectionId(provider);
        if (conn.error) { showError(provider, conn.error); return; }
        const r = await invokeIntegrationsApi('connect', { connection_id: conn.id, ...v.payload });
        // لا نبقي أي سر في الحقول بعد الإرسال، نجح أو فشل
        form.reset();
        if (!r.ok) { showError(provider, r.code); return; }
        if (r.data?.webhook) revealed = { provider, kind: 'webhook', value: r.data.webhook.secret, url: r.data.webhook.delivery_url, topics: r.data.webhook.topics };
        if (r.data?.pairing_code) revealed = { provider, kind: 'pairing', value: r.data.pairing_code };
        openForm = null;
        ui?.showToast?.('تم الربط بنجاح.', 'success');
        await loadCompanyIntegrations();
        el('ihubRevealTitle')?.focus?.();
    });
}

async function onAction(button) {
    const action = button.getAttribute('data-ihub-action');
    const provider = button.getAttribute('data-provider');
    const card = provider ? cardOf(provider) : null;

    if (action === 'open-form') { openForm = provider; render(); el(`ihubForm-${provider}`)?.querySelector('input')?.focus(); return; }
    if (action === 'close-form') { openForm = null; render(); return; }
    if (action === 'dismiss-reveal') { revealed = null; render(); return; }

    if (action === 'oauth') {
        await busy(button, async () => {
            const conn = await ensureConnectionId(provider);
            if (conn.error) { showError(provider, conn.error); return; }
            const r = await invokeIntegrationsApi('oauth_start', { connection_id: conn.id });
            if (!r.ok) { showError(provider, r.code); return; }
            if (!isSallaAuthorizeUrl(r.data?.authorize_url) || !/^[A-Za-z0-9_-]{20,128}$/.test(r.data?.binding || '')) {
                showError(provider, 'invalid_response');
                return;
            }
            const store = bindingStore();
            if (!store) { showError(provider, 'unknown_error'); return; }
            store.setItem(oauthBindingKey(conn.id), r.data.binding);
            window.location.assign(r.data.authorize_url);
        });
        return;
    }
    if (action === 'test' && card?.connection) {
        await busy(button, async () => {
            const r = await invokeIntegrationsApi('test', { connection_id: card.connection.id });
            if (!r.ok) { showError(provider, r.code); return; }
            if (r.data?.ok) ui?.showToast?.('الاتصال يعمل.', 'success');
            else showError(provider, r.data?.error || 'unknown_error');
            await loadCompanyIntegrations();
        });
        return;
    }
    if (action === 'rotate' && card?.connection) {
        const okToGo = await ui.showConfirm('إنشاء سر جديد',
            provider === 'wordpress'
                ? 'الرمز الحالي سيتوقف فورًا، وتحتاج لصق الرمز الجديد في إضافة ووردبريس.'
                : 'السر الحالي سيتوقف فورًا، وتحتاج تحديث السر في إعدادات ويب هوك ووكومرس.',
            { confirmLabel: 'إنشاء', cancelLabel: 'تراجع' });
        if (!okToGo) return;
        await busy(button, async () => {
            const r = await invokeIntegrationsApi('rotate_secret', { connection_id: card.connection.id });
            if (!r.ok) { showError(provider, r.code); return; }
            revealed = r.data?.pairing_code
                ? { provider, kind: 'pairing', value: r.data.pairing_code }
                : { provider, kind: 'webhook', value: r.data?.webhook?.secret, url: r.data?.webhook?.delivery_url, topics: ['order.created', 'order.updated'] };
            render();
        });
        return;
    }
    if (action === 'disconnect' && card?.connection) {
        const okToGo = await ui.showConfirm(`فصل ${card.name}`,
            'نحذف فورًا بيانات الاعتماد المخزّنة، وملخصات السجلات المربوطة بالتذاكر، وروابط العملاء لهذا الحساب. التذاكر نفسها لا تتأثر. '
            + (provider === 'woocommerce' ? 'ألغِ المفتاح أيضًا من ووكومرس (REST API) واحذف الويب هوك.'
              : provider === 'salla' ? 'أزل التطبيق أيضًا من لوحة سلة لإلغاء التفويض لديهم.'
              : provider === 'daftra' ? 'احذف مفتاح API أيضًا من إعدادات دفترة.'
              : 'الإضافة على موقعك ستتوقف عن الإرسال فورًا.'),
            { confirmLabel: 'فصل', cancelLabel: 'تراجع', danger: true });
        if (!okToGo) return;
        await busy(button, async () => {
            const r = await disconnectConnection(card.connection.id);
            if (!r.ok) { showError(provider, r.code || 'unknown_error'); return; }
            ui?.showToast?.('تم الفصل.', 'success');
            await loadCompanyIntegrations();
        });
        return;
    }
    if (action === 'dismiss') {
        const id = button.getAttribute('data-intake-id');
        await busy(button, async () => {
            const r = await dismissIntake(id);
            if (!r.ok) { ui?.showToast?.(r.error, 'error'); return; }
            intake = intake.filter((i) => i.id !== id);
            render();
        });
        return;
    }
    if (action === 'convert') {
        const id = button.getAttribute('data-intake-id');
        const customer = document.querySelector(`[data-intake-customer="${CSS.escape(id)}"]`)?.value;
        if (!customer) { ui?.showToast?.('اختر العميل أولًا.', 'error'); return; }
        await busy(button, async () => {
            const r = await convertIntake(id, customer);
            if (!r.ok) { ui?.showToast?.(r.error, 'error'); return; }
            const woo = (overview?.connections || []).find((c) => c.provider === 'woocommerce' && c.status === 'active');
            lastConversion = { ticketNumber: r.data?.ticket_number, ticketId: r.data?.ticket_id, orderRef: r.data?.external_order_ref || null, wooId: woo?.id || null };
            intake = intake.filter((i) => i.id !== id);
            render();
        });
        return;
    }
    if (action === 'link-intake-order' && lastConversion?.wooId) {
        await busy(button, async () => {
            const r = await invokeIntegrationsApi('link_record', {
                connection_id: lastConversion.wooId, ticket_id: lastConversion.ticketId, record_type: 'order', reference: lastConversion.orderRef
            });
            if (!r.ok) { ui?.showToast?.(errorMessage(r.code), 'error'); return; }
            ui?.showToast?.('رُبط الطلب بالتذكرة.', 'success');
            lastConversion = null;
            render();
        });
    }
}

async function loadAudit() {
    const body = el('ihubAuditBody');
    if (!body) return;
    const r = await fetchIntegrationAudit(30);
    const rows = r.ok && Array.isArray(r.data) ? r.data : [];
    body.innerHTML = rows.length
        ? `<ul class="ihub-audit">${rows.map((a) => `<li><span dir="ltr">${escapeHtml(a.action)}</span> · ${escapeHtml(formatDateTime(a.created_at))}</li>`).join('')}</ul>`
        : '<p class="panel-subtitle">لا عمليات بعد.</p>';
}

function wire() {
    const c = box();
    if (!c) return;
    c.querySelectorAll('[data-ihub-action]').forEach((b) => b.addEventListener('click', () => onAction(b)));
    c.querySelectorAll('[data-ihub-form]').forEach((f) => f.addEventListener('submit', (e) => { e.preventDefault(); onSubmitForm(f); }));
    c.querySelectorAll('[data-ihub-role]').forEach((s) => s.addEventListener('change', async () => {
        const r = await setConnectionViewRole(s.getAttribute('data-ihub-role'), s.value);
        if (!r.ok) ui?.showToast?.(r.error, 'error');
        else ui?.showToast?.('حُدّثت صلاحية العرض.', 'success');
    }));
    el('ihubAudit')?.addEventListener('toggle', (e) => { if (e.target.open) loadAudit(); }, { once: true });
}
