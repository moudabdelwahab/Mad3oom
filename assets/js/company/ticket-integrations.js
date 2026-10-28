/**
 * ticket-integrations.js — لوحة «السياق الخارجي» داخل تذكرة عميل الشركة.
 *
 * تظهر فقط حين ترجع ihub_ticket_context() شيئًا: القاعدة تقرر من يرى
 * (من يرى التذكرة نفسها + دور في فريق الشركة ≥ min_view_role لكل ربط). ما
 * عدا ذلك — عميل، طاقم منصة، تذكرة شركة أخرى، أو قبل 088 — لا لوحة إطلاقًا.
 *
 * الملخص المعروض قائمة سماح (summaryRows) من نسخة مختصرة مخزّنة؛ المزوّد يبقى
 * المرجع، والرابط الخارجي يُفتح في تبويب جديد بلا مُحيل.
 *
 * 119 (حسابات المتاجر): كتلة «دعم المتجر» — تصنيف التذكرة وطلبات المتابعة المرتبطة بها.
 * تظهر فقط حين ترد store_ticket_meta_get() (متجر + رؤية التذكرة + امتياز store_support).
 */

import { ticketContextView, errorMessage } from '/assets/js/company/integrations-model.js';
import { fetchTicketIntegrationContext, unlinkTicketRecord, invokeIntegrationsApi } from '/assets/js/company/integrations-data.js';
import { escapeHtml, formatDateTime } from '/assets/js/customer/portal-ui.js';
import { ui } from '/ui-service.js';
import { fetchTicketStoreMeta, fetchCategories, setTicketCategory } from '/assets/js/company/store-data.js';
import { REQUEST_KINDS, REQUEST_STATUSES, NOT_EXECUTED_NOTE, storeErrorMessage } from '/assets/js/company/store-model.js';
import { openRequestDialog } from '/assets/js/company/company-store.js';

/** كتلة دعم المتجر داخل التذكرة. null = لا كتلة (ليس متجرًا، أو بلا رؤية/امتياز). */
async function storeBlock(ticketId, uid) {
    const [meta, cats] = await Promise.all([fetchTicketStoreMeta(ticketId), fetchCategories()]);
    if (!meta.ok || !meta.data) return null;
    const categories = cats.ok && Array.isArray(cats.data) ? cats.data : [];
    const current = meta.data.category_key || '';
    const requests = Array.isArray(meta.data.requests) ? meta.data.requests : [];
    return `<section class="ihub-ticket" aria-labelledby="${uid}-store">
        <h3 class="panel-title" id="${uid}-store">دعم المتجر</h3>
        <div class="form-field">
            <label for="${uid}-cat">تصنيف المشكلة</label>
            <select id="${uid}-cat" class="form-control" data-store-category>
                <option value="">بلا تصنيف</option>
                ${categories.filter((c) => c.is_active || c.key === current).map((c) =>
                    `<option value="${escapeHtml(c.key)}" ${c.key === current ? 'selected' : ''}>${escapeHtml(c.label_ar)}</option>`).join('')}
            </select>
        </div>
        ${requests.length ? `<ul class="company-list">${requests.map((q) => `<li>${escapeHtml(REQUEST_KINDS[q.kind] || q.kind)}
            ${q.order_ref ? escapeHtml(q.order_ref) : ''} — <span class="pill ${escapeHtml(REQUEST_STATUSES[q.status]?.pill || 'status-neutral')}">
            ${escapeHtml(REQUEST_STATUSES[q.status]?.label || q.status)}</span></li>`).join('')}</ul>` : ''}
        <div class="company-form-actions"><button type="button" class="btn btn-secondary btn-sm" data-store-request>تسجيل طلب متابعة</button></div>
        <p class="field-hint">${escapeHtml(NOT_EXECUTED_NOTE)}</p>
    </section>`;
}

export async function renderTicketIntegrations(container, ticketId) {
    if (!container) return;
    const uid = `ihubT-${String(ticketId).replace(/[^A-Za-z0-9-]/g, '')}`;
    const [r, store] = await Promise.all([fetchTicketIntegrationContext(ticketId), storeBlock(ticketId, uid)]);
    const view = ticketContextView(r.data);
    if (!view && !store) {
        container.hidden = true;
        container.innerHTML = '';
        return;
    }
    container.hidden = false;
    container.innerHTML = `${store || ''}${view ? `
    <section class="ihub-ticket" aria-labelledby="${uid}-title">
        <h3 class="panel-title" id="${uid}-title">السياق الخارجي</h3>
        ${view.customerRefs.length ? `<p class="panel-subtitle">العميل مربوط بـ: ${view.customerRefs.map((c) =>
            `${escapeHtml(c.provider)} #${escapeHtml(c.external_customer_id)}`).join('، ')}</p>` : ''}
        ${view.links.length ? view.links.map((l) => `
        <article class="ihub-record" data-link="${escapeHtml(l.id)}">
            <header>
                <strong>${escapeHtml(l.providerName)} · ${escapeHtml(l.typeLabel)} ${escapeHtml(l.ref || '')}</strong>
                ${l.stale ? '<span class="pill status-tone-warning">الربط يحتاج مراجعة — البيانات قد تكون قديمة</span>' : ''}
            </header>
            <dl class="ihub-facts">${l.rows.map((row) => `<div><dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd></div>`).join('')}</dl>
            ${l.items ? `<p class="panel-subtitle">المنتجات: ${escapeHtml(l.items)}</p>` : ''}
            ${l.tracking.length ? `<ul class="company-list">${l.tracking.map((t) => `<li>${escapeHtml(t.status || 'شحنة')}
                ${t.company ? escapeHtml(t.company) : ''} ${t.number ? `<span dir="ltr">${escapeHtml(t.number)}</span>` : ''}
                ${t.url ? `<a href="${escapeHtml(t.url)}" target="_blank" rel="noopener noreferrer">تتبّع الشحنة</a>` : ''}</li>`).join('')}</ul>` : ''}
            ${l.deletedInProvider ? '<p class="field-hint">حُذف هذا السجل لدى المزوّد؛ المعروض آخر نسخة محفوظة.</p>' : ''}
            ${l.restricted ? '<p class="field-hint">بعض بيانات العميل محجوبة: لم يعتمد Shopify وصول التطبيق إليها بعد.</p>' : ''}
            <p class="field-hint">آخر تحديث: ${escapeHtml(formatDateTime(l.fetchedAt))}${l.unverifiedMapping ? ' · عرض تجريبي لحقول هذا المزوّد' : ''}</p>
            <div class="company-form-actions">
                ${l.url ? `<a class="btn btn-secondary btn-sm" href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">فتح لدى ${escapeHtml(l.providerName)}</a>` : ''}
                ${l.connectionId ? `<button type="button" class="btn btn-secondary btn-sm" data-ihub-refresh="${escapeHtml(l.id)}">تحديث</button>` : ''}
                <button type="button" class="btn btn-ghost btn-sm" data-ihub-unlink="${escapeHtml(l.id)}">فك الربط</button>
            </div>
        </article>`).join('') : '<p class="panel-subtitle">لا سجلات مربوطة بهذه التذكرة.</p>'}
        ${view.linkOptions.length ? `
        <form class="company-form" id="${uid}-form" novalidate>
            <div class="form-grid">
                <div class="form-field">
                    <label for="${uid}-src">المصدر</label>
                    <select id="${uid}-src" class="form-control" name="source">
                        ${view.linkOptions.map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('')}
                    </select>
                </div>
                <div class="form-field">
                    <label for="${uid}-ref">الرقم</label>
                    <input id="${uid}-ref" name="reference" class="form-control" inputmode="numeric" dir="ltr" autocomplete="off"
                           pattern="#?[0-9]{1,20}" required placeholder="1007">
                </div>
            </div>
            <p class="field-error" id="${uid}-err" role="alert" hidden></p>
            <div class="company-form-actions">
                <button type="submit" class="btn btn-primary btn-sm">ربط بالتذكرة</button>
            </div>
        </form>` : ''}
    </section>` : ''}`;

    container.querySelector('[data-store-category]')?.addEventListener('change', async (e) => {
        const res = await setTicketCategory(ticketId, e.currentTarget.value || null);
        ui?.showToast?.(res.ok ? 'تم حفظ التصنيف.' : storeErrorMessage(res.code, res.error), res.ok ? 'success' : 'error');
    });
    container.querySelector('[data-store-request]')?.addEventListener('click', () => openRequestDialog({ ticketId }));
    const rerender = (e) => {
        if (e.detail?.ticketId !== ticketId) return;
        document.removeEventListener('store:request-created', rerender);
        renderTicketIntegrations(container, ticketId);
    };
    document.addEventListener('store:request-created', rerender);
    if (!view) return;

    const err = container.querySelector(`#${uid}-err`);
    const fail = (code) => {
        if (err) { err.textContent = errorMessage(code); err.hidden = false; } else ui?.showToast?.(errorMessage(code), 'error');
    };
    const link = async (connectionId, recordType, reference, button) => {
        if (button) button.disabled = true;
        try {
            const res = await invokeIntegrationsApi('link_record', { connection_id: connectionId, ticket_id: ticketId, record_type: recordType, reference });
            if (!res.ok) { fail(res.code); return; }
            await renderTicketIntegrations(container, ticketId);
        } finally {
            if (button) button.disabled = false;
        }
    };

    container.querySelector(`#${uid}-form`)?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const [connectionId, recordType] = String(form.source.value).split('|');
        const reference = String(form.reference.value || '').trim();
        if (!/^#?[0-9]{1,20}$/.test(reference)) { fail('invalid_input'); return; }
        await link(connectionId, recordType, reference, form.querySelector('button[type="submit"]'));
    });
    container.querySelectorAll('[data-ihub-refresh]').forEach((b) => b.addEventListener('click', async () => {
        const l = view.links.find((x) => x.id === b.getAttribute('data-ihub-refresh'));
        if (l?.connectionId) await link(l.connectionId, l.recordType, l.reference, b);
    }));
    container.querySelectorAll('[data-ihub-unlink]').forEach((b) => b.addEventListener('click', async () => {
        const okToGo = await ui.showConfirm('فك الربط', 'يُزال السجل الخارجي من هذه التذكرة. لا شيء يتغير لدى المزوّد.',
                                            { confirmLabel: 'فك الربط', cancelLabel: 'تراجع' });
        if (!okToGo) return;
        b.disabled = true;
        const res = await unlinkTicketRecord(b.getAttribute('data-ihub-unlink'));
        if (!res.ok) { fail(res.code || 'unknown_error'); b.disabled = false; return; }
        await renderTicketIntegrations(container, ticketId);
    }));
}
