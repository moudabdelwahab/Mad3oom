/**
 * ticket-integrations.js — لوحة «السياق الخارجي» داخل تذكرة عميل الشركة.
 *
 * تظهر فقط حين ترجع ihub_ticket_context() شيئًا: القاعدة تقرر من يرى
 * (من يرى التذكرة نفسها + دور في فريق الشركة ≥ min_view_role لكل ربط). ما
 * عدا ذلك — عميل، طاقم منصة، تذكرة شركة أخرى، أو قبل 088 — لا لوحة إطلاقًا.
 *
 * الملخص المعروض قائمة سماح (summaryRows) من نسخة مختصرة مخزّنة؛ المزوّد يبقى
 * المرجع، والرابط الخارجي يُفتح في تبويب جديد بلا مُحيل.
 */

import { ticketContextView, errorMessage } from '/assets/js/company/integrations-model.js';
import { fetchTicketIntegrationContext, unlinkTicketRecord, invokeIntegrationsApi } from '/assets/js/company/integrations-data.js';
import { escapeHtml, formatDateTime } from '/assets/js/customer/portal-ui.js';
import { ui } from '/ui-service.js';

export async function renderTicketIntegrations(container, ticketId) {
    if (!container) return;
    const r = await fetchTicketIntegrationContext(ticketId);
    const view = ticketContextView(r.data);
    if (!view) {
        container.hidden = true;
        container.innerHTML = '';
        return;
    }
    const uid = `ihubT-${String(ticketId).replace(/[^A-Za-z0-9-]/g, '')}`;
    container.hidden = false;
    container.innerHTML = `
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
    </section>`;

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
