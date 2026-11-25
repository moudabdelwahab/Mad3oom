/**
 * company-webhooks.js — إدارة Webhooks من لوحة الشركة (الترحيل 141).
 *
 * لا يوجد أي Webhook صادر للشركة قبل 141: ihub_webhook_events (088) أحداث
 * واردة من مزودي التكاملات، لا وجهات تصدرها الشركة. فكل شيء هنا يمرّ عبر
 * دوال 141 (company_webhook_*): الإنشاء يعيد السرّ مرة واحدة فقط، والقوائم
 * لا تعيده أبدًا، وسجل التسليم محاولات فعلية فقط — بلا محاولات يظهر
 * «لا توجد عمليات تسليم بعد» لا سجلًا مختلقًا.
 *
 * قبل تطبيق 141 على القاعدة الدوال غير موجودة: نعرض تنبيهًا بذلك ونخفي
 * النماذج، ولا ينكسر تبويب API — الواجهة والقاعدة تُنشران بأي ترتيب.
 */

import { supabase } from '/api-config.js';
import { escapeHtml, formatDate, timeAgo, renderState } from '/assets/js/customer/portal-ui.js';
import { ui } from '/ui-service.js';
import {
    WEBHOOK_EVENTS, validateWebhookForm, toWebhookCreatePayload,
    deliveryStatus, webhookHealth, isFunctionMissingError
} from '/assets/js/company/developers-model.js';

let container = null;
let companyId = null;
let webhooks = [];
let notDeployed = false;

/** نداء RPC لا يرمي أبدًا — الفشل يعود كـ error كأي رفض من القاعدة. */
async function callRpc(name, args) {
    try {
        return await supabase.rpc(name, args);
    } catch (err) {
        return { data: null, error: err };
    }
}

export function initCompanyWebhooks(el, { companyId: id } = {}) {
    container = el || null;
    companyId = id || null;
    if (!container) return;
    loadCompanyWebhooks();
}

async function loadCompanyWebhooks() {
    if (!container) return;
    if (!companyId) {
        renderState(container, {
            variant: 'empty',
            title: 'Webhooks غير متاحة',
            text: 'تعذّر تحديد شركتك. أعد تحميل اللوحة.'
        });
        return;
    }

    let data, error;
    ({ data, error } = await callRpc('company_webhook_list', { p_company_id: companyId }));
    if (error) {
        if (isFunctionMissingError(error)) {
            notDeployed = true;
            renderState(container, {
                variant: 'empty',
                title: 'Webhooks ستُتاح بعد تطبيق الترحيل 141',
                text: 'إدارة Webhooks من اللوحة تتطلب الترحيل 141 على قاعدة البيانات، ولم يُطبَّق بعد. لا تُنشأ وجهات ولا يُسجَّل تسليم حتى ذلك الحين.'
            });
            return;
        }
        console.error('[CompanyWebhooks] list:', error?.message || error);
        renderState(container, {
            variant: 'error',
            title: 'تعذّر تحميل Webhooks',
            text: 'تحقق من اتصالك ثم أعد المحاولة.',
            action: { label: 'إعادة المحاولة', retry: 'webhooks', variant: 'btn-primary' }
        });
        return;
    }

    webhooks = Array.isArray(data) ? data : [];
    renderWebhooks();
}

function renderWebhooks() {
    if (!container) return;
    container.innerHTML = `
        <section class="panel" aria-labelledby="companyWebhooksHeading">
            <div class="panel-header">
                <div>
                    <h2 class="panel-title" id="companyWebhooksHeading">Webhooks</h2>
                    <p class="panel-subtitle">
                        أرسل أحداث شركتك (تذاكر، عملاء، اشتراكات) إلى نظامك فور وقوعها.
                        السرّ يظهر مرة واحدة عند الإنشاء أو التدوير ثم لا يُعرض أبدًا.
                    </p>
                </div>
                <button type="button" class="btn btn-primary btn-sm" id="companyWebhookNew">إنشاء Webhook</button>
            </div>
            <p class="company-notice">
                التسليم الفعلي عبر HTTP خطوة لاحقة منفصلة عن الترحيل 141:
                سجل التسليم أدناه يعرض المحاولات الفعلية فقط، وبلا محاولات
                يبقى فارغًا — لا سجل وهمي.
            </p>
            <div id="companyWebhookFormSlot"></div>
            <div id="companyWebhookSecretSlot"></div>
            <div id="companyWebhooksList"></div>
        </section>`;

    document.getElementById('companyWebhookNew')?.addEventListener('click', () => renderForm(null));
    renderList();
}

function renderList() {
    const box = document.getElementById('companyWebhooksList');
    if (!box) return;

    if (!webhooks.length) {
        renderState(box, {
            variant: 'empty',
            title: 'لا توجد Webhooks بعد',
            text: 'أنشئ وجهة https واختر الأحداث التي تريد إرسالها إليها.'
        });
        return;
    }

    box.innerHTML = `
        <ul class="company-sub-list">
            ${webhooks.map(w => {
                const health = webhookHealth(w);
                return `
                <li class="company-sub">
                    <div class="company-sub-main">
                        <p class="company-sub-plan">${escapeHtml(w.name || 'Webhook')}</p>
                        <p class="company-sub-dates">
                            <code dir="ltr">${escapeHtml(w.url || '')}</code>
                            · أُنشئ ${escapeHtml(formatDate(w.created_at))}
                            · ${escapeHtml(String(w.deliveries_count || 0))} محاولة تسليم
                        </p>
                        <p class="scope-chips">${(w.events || []).map(e => `<code>${escapeHtml(e)}</code>`).join('')}</p>
                        <p class="company-sub-dates">الحالة: ${escapeHtml(health.label)}</p>
                        <div id="companyWebhookDeliveries-${escapeHtml(w.id)}"></div>
                    </div>
                    <div class="company-sub-side">
                        <span class="pill status-tone-${escapeHtml(health.tone)}">${escapeHtml(health.label)}</span>
                        <button type="button" class="panel-link" data-webhook-deliveries="${escapeHtml(w.id)}">سجل التسليم</button>
                        <button type="button" class="panel-link" data-webhook-edit="${escapeHtml(w.id)}">تعديل</button>
                        <button type="button" class="panel-link" data-webhook-rotate="${escapeHtml(w.id)}">تدوير السرّ</button>
                        <button type="button" class="panel-link" data-webhook-toggle="${escapeHtml(w.id)}">
                            ${w.is_active === false ? 'تفعيل' : 'إيقاف'}
                        </button>
                        <button type="button" class="panel-link" data-webhook-delete="${escapeHtml(w.id)}">حذف</button>
                    </div>
                </li>`;
            }).join('')}
        </ul>`;

    box.querySelectorAll('[data-webhook-deliveries]').forEach(btn =>
        btn.addEventListener('click', () => toggleDeliveries(btn.getAttribute('data-webhook-deliveries'))));
    box.querySelectorAll('[data-webhook-edit]').forEach(btn =>
        btn.addEventListener('click', () => renderForm(webhooks.find(w => w.id === btn.getAttribute('data-webhook-edit')))));
    box.querySelectorAll('[data-webhook-rotate]').forEach(btn =>
        btn.addEventListener('click', () => rotateSecret(btn.getAttribute('data-webhook-rotate'))));
    box.querySelectorAll('[data-webhook-toggle]').forEach(btn =>
        btn.addEventListener('click', () => toggleWebhook(btn.getAttribute('data-webhook-toggle'))));
    box.querySelectorAll('[data-webhook-delete]').forEach(btn =>
        btn.addEventListener('click', () => deleteWebhook(btn.getAttribute('data-webhook-delete'))));
}

function renderForm(webhook) {
    const slot = document.getElementById('companyWebhookFormSlot');
    if (!slot) return;
    const editing = Boolean(webhook);
    const selected = new Set(webhook?.events || []);

    slot.innerHTML = `
        <form id="companyWebhookForm" class="company-form" novalidate>
            <h3>${editing ? 'تعديل Webhook' : 'Webhook جديد'}</h3>
            <div class="form-field is-full">
                <label for="fWebhookName">الاسم <span aria-hidden="true">*</span></label>
                <input type="text" id="fWebhookName" class="form-control" maxlength="80"
                       value="${escapeHtml(webhook?.name || '')}" placeholder="مثال: نظام المبيعات">
                <p class="field-error" data-webhook-error-for="name" hidden></p>
            </div>
            <div class="form-field is-full">
                <label for="fWebhookUrl">رابط الوجهة <span aria-hidden="true">*</span></label>
                <input type="url" id="fWebhookUrl" class="form-control" dir="ltr"
                       value="${escapeHtml(webhook?.url || '')}" placeholder="https://example.com/mad3oom-webhook">
                <p class="field-hint">https فقط — رابط http يُرفَض من الخادم.</p>
                <p class="field-error" data-webhook-error-for="url" hidden></p>
            </div>
            <fieldset class="form-fieldset">
                <legend>الأحداث <span aria-hidden="true">*</span></legend>
                <div class="scope-list">
                    ${WEBHOOK_EVENTS.map(e => `
                        <label class="scope-item">
                            <input type="checkbox" name="webhookEvents" value="${escapeHtml(e.key)}"
                                ${selected.has(e.key) ? 'checked' : ''}>
                            <span class="scope-label">${escapeHtml(e.label)}</span>
                            <code class="scope-key">${escapeHtml(e.key)}</code>
                        </label>`).join('')}
                </div>
                <p class="field-error" data-webhook-error-for="events" hidden></p>
            </fieldset>
            <p class="field-error" id="companyWebhookFormError" role="alert" hidden></p>
            <div class="company-form-actions">
                <button type="submit" class="btn btn-primary">${editing ? 'حفظ التعديلات' : 'إنشاء الـWebhook'}</button>
                <button type="button" class="btn btn-secondary" id="cancelWebhookBtn">إلغاء</button>
            </div>
        </form>`;

    document.getElementById('cancelWebhookBtn')?.addEventListener('click', () => { slot.innerHTML = ''; });
    document.getElementById('companyWebhookForm')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        await submitForm(webhook);
    });
    document.getElementById('fWebhookName')?.focus();
}

async function submitForm(webhook) {
    const values = {
        name: document.getElementById('fWebhookName')?.value || '',
        url: document.getElementById('fWebhookUrl')?.value || '',
        events: [...document.querySelectorAll('#companyWebhookForm input[name="webhookEvents"]:checked')].map(i => i.value)
    };
    const validation = validateWebhookForm(values);
    document.querySelectorAll('#companyWebhookForm [data-webhook-error-for]').forEach(el => {
        el.hidden = true; el.textContent = '';
    });
    if (!validation.isValid) {
        for (const [field, message] of Object.entries(validation.errors)) {
            const el = document.querySelector(`#companyWebhookForm [data-webhook-error-for="${field}"]`);
            if (el) { el.textContent = message; el.hidden = false; }
        }
        return;
    }

    const payload = toWebhookCreatePayload(values);
    let result;
    if (webhook) {
        result = await callRpc('company_webhook_update', {
            p_webhook_id: webhook.id, p_name: payload.name, p_url: payload.url, p_events: payload.events
        });
    } else {
        result = await callRpc('company_webhook_create', {
            p_company_id: companyId, p_name: payload.name, p_url: payload.url, p_events: payload.events
        });
    }
    if (result.error) {
        const box = document.getElementById('companyWebhookFormError');
        if (box) { box.textContent = result.error.message || 'تعذّر حفظ الـWebhook. حاول مرة أخرى.'; box.hidden = false; }
        return;
    }

    // السرّ يعود مرة واحدة عند الإنشاء فقط — نعرضه فورًا ثم لا يُسترجع.
    if (!webhook && result.data?.secret) revealSecret(result.data.secret);
    ui?.showToast?.(webhook ? 'تم حفظ التعديلات' : 'تم إنشاء الـWebhook', 'success');
    await loadCompanyWebhooks();
}

function revealSecret(secret) {
    const slot = document.getElementById('companyWebhookSecretSlot');
    if (!slot) return;
    slot.innerHTML = `
        <div class="company-notice company-notice--warning" role="alert">
            <strong>سرّ التوقيع — يظهر مرة واحدة فقط.</strong>
            انسخه الآن: المنصة لا تعرضه مرة أخرى، وستحتاجه للتحقق من توقيع
            الحمولات الواصلة إلى وجهتك.
            <div class="secret-row">
                <input type="text" class="form-control secret-input" id="webhookSecretValue"
                       value="${escapeHtml(secret)}" readonly spellcheck="false" dir="ltr">
                <button type="button" class="btn btn-secondary secret-copy" id="webhookSecretCopy">نسخ</button>
            </div>
        </div>`;
    document.getElementById('webhookSecretCopy')?.addEventListener('click', async (event) => {
        const input = document.getElementById('webhookSecretValue');
        try { await navigator.clipboard.writeText(input.value); event.target.textContent = 'تم النسخ'; }
        catch { input.select(); ui?.showToast?.('انسخ القيمة المحدَّدة يدويًا (Ctrl+C)', 'info'); }
    });
}

async function rotateSecret(webhookId) {
    const ok = await ui.showConfirm('تدوير سرّ التوقيع؟',
        'السرّ الحالي يتوقف فورًا عن التوقيع. حدّث وجهتك بالسرّ الجديد قبل أن تعتمد عليه.',
        { confirmLabel: 'تدوير', cancelLabel: 'تراجع', danger: true });
    if (!ok) return;
    const { data, error } = await callRpc('company_webhook_rotate_secret', { p_webhook_id: webhookId });
    if (error || !data) {
        ui?.showToast?.(error?.message || 'تعذّر تدوير السرّ', 'error');
        return;
    }
    if (data.secret) revealSecret(data.secret);
    ui?.showToast?.('تم تدوير السرّ — انسخ الجديد الآن', 'success');
    await loadCompanyWebhooks();
}

async function toggleWebhook(webhookId) {
    const webhook = webhooks.find(w => w.id === webhookId);
    if (!webhook) return;
    const disabling = webhook.is_active !== false;
    const ok = await ui.showConfirm(disabling ? 'إيقاف الـWebhook؟' : 'تفعيل الـWebhook؟',
        disabling ? 'لن تُرسَل أحداث جديدة إلى هذه الوجهة حتى تعيد تفعيلها.' : 'ستُرسَل الأحداث إلى هذه الوجهة مرة أخرى.',
        { confirmLabel: disabling ? 'إيقاف' : 'تفعيل', cancelLabel: 'تراجع', danger: disabling });
    if (!ok) return;
    const { error } = await callRpc('company_webhook_update', {
        p_webhook_id: webhookId, p_is_active: !disabling
    });
    if (error) { ui?.showToast?.(error.message || 'تعذّر تنفيذ الإجراء', 'error'); return; }
    ui?.showToast?.(disabling ? 'تم إيقاف الـWebhook' : 'تم تفعيل الـWebhook', 'success');
    await loadCompanyWebhooks();
}

async function deleteWebhook(webhookId) {
    const webhook = webhooks.find(w => w.id === webhookId);
    const ok = await ui.showConfirm('حذف الـWebhook؟',
        `سيُحذف «${webhook?.name || 'Webhook'}» وسجل تسليمه نهائيًا.`,
        { confirmLabel: 'حذف', cancelLabel: 'تراجع', danger: true });
    if (!ok) return;
    const { error } = await callRpc('company_webhook_delete', { p_webhook_id: webhookId });
    if (error) { ui?.showToast?.(error.message || 'تعذّر الحذف', 'error'); return; }
    ui?.showToast?.('تم حذف الـWebhook', 'success');
    await loadCompanyWebhooks();
}

async function toggleDeliveries(webhookId) {
    const box = document.getElementById(`companyWebhookDeliveries-${CSS.escape(webhookId)}`);
    if (!box) return;
    if (box.dataset.loaded === '1') { box.innerHTML = ''; delete box.dataset.loaded; return; }

    const { data, error } = await callRpc('company_webhook_deliveries', {
        p_webhook_id: webhookId, p_limit: 20
    });
    box.dataset.loaded = '1';
    if (error) {
        box.innerHTML = `<p class="field-error" role="alert">تعذّر تحميل سجل التسليم.</p>`;
        return;
    }
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) {
        box.innerHTML = `<p class="company-sub-dates">لا توجد عمليات تسليم بعد — تظهر هنا المحاولات الفعلية فقط فور حدوثها.</p>`;
        return;
    }
    box.innerHTML = `
        <div class="activity-timeline">
            ${rows.map(row => {
                const state = deliveryStatus(row);
                return `
                <div class="activity-item">
                    <div>
                        <div class="activity-text">
                            <code>${escapeHtml(row.event || '')}</code>
                            — <span class="pill status-tone-${escapeHtml(state.tone)}">${escapeHtml(state.label)}</span>
                            ${row.response_status != null ? ` · HTTP ${escapeHtml(String(row.response_status))}` : ''}
                            · ${escapeHtml(String(row.attempts || 0))} محاولة
                        </div>
                        <div class="activity-time">${escapeHtml(timeAgo(row.created_at))}</div>
                    </div>
                </div>`;
            }).join('')}
        </div>`;
}
