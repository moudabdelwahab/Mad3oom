/**
 * company-moves.js — مدير الشركة: قرارات نقل العملاء وطلبات الاطلاع التاريخي (migrations/101).
 *
 * القرار في القاعدة: company_transfer_requests() وcompany_historical_requests() لمدير الشركة وحده
 * (null لغيره)، وكل دالة تتحقق من مفتاحها. اللوحة تظهر فقط والمفتاح مفعّل. لا تُعرض هوية الشركة
 * الأخرى في طلب النقل، ولا يُعرض من التاريخ إلا ما اختاره العميل ووافقت عليه مدعوم ولمدة محدودة،
 * وكل عرض مسجَّل في القاعدة.
 */
import { supabase } from '/api-config.js';
import { escapeHtml, formatDate } from '/assets/js/customer/portal-ui.js';
import { ui } from '/ui-service.js';

const MISSING = new Set(['PGRST202', '42883', 'PGRST404']);
const OFF = Object.freeze({ transfers: false, historical: false });

async function rpc(name, args, fallback) {
    try {
        const { data, error } = await supabase.rpc(name, args);
        if (error) {
            if (MISSING.has(error.code)) return { ok: true, data: null, missing: true };
            return { ok: false, error: error.code === '0A000' ? 'هذه الميزة غير مفعّلة بعد.' : (error.message || fallback) };
        }
        return { ok: true, data };
    } catch (err) {
        console.error(`[CompanyMoves] ${name}:`, err?.message || err);
        return { ok: false, error: fallback };
    }
}

/** ما يظهر — خالصة، مُختبَرة في tests/company-moves.test.mjs. */
export function companyMovesView(features, transfers, historical) {
    const f = features || OFF;
    const showTransfers = f.transfers === true && Array.isArray(transfers);
    const showHistory = f.historical === true && Array.isArray(historical);
    return { show: showTransfers || showHistory, showTransfers, showHistory };
}

/** وصف طلب نقل لمدير الشركة — بلا اسم الشركة الأخرى. خالصة. */
export function transferRowInfo(t) {
    const incoming = t?.direction === 'incoming';
    const pendingMine = t?.status === 'pending' && !t?.my_decision;
    return {
        text: incoming ? 'يطلب أن تصبح شركتك شركته الأساسية' : 'يطلب نقل شركته الأساسية إلى شركة أخرى',
        canDecide: pendingMine,
        offerSecondary: pendingMine && !incoming && t?.customer_wants_secondary === true,
        status: { pending: pendingMine ? 'بانتظار قرارك' : 'بانتظار الشركة الأخرى', completed: 'اكتمل', rejected: 'رُفض',
                  cancelled: 'ألغاه العميل', expired: 'انتهت مهلته' }[t?.status] || '—'
    };
}

export function validatePurpose(raw) {
    const purpose = String(raw || '').trim();
    if (purpose.length < 20) return { ok: false, error: 'اكتب الغرض بوضوح (20 حرفًا على الأقل)' };
    if (purpose.length > 1000) return { ok: false, error: 'الغرض أطول من 1000 حرف' };
    return { ok: true, purpose };
}

const HISTORY_STATUS = {
    awaiting_customer: 'بانتظار موافقة العميل', awaiting_owner: 'وافق العميل — بانتظار مراجعة مدعوم',
    approved: 'مسموح', rejected: 'رفضته مدعوم', declined: 'رفضه العميل', expired: 'انتهى'
};

/** customers(): قائمة عملاء الشركة كما رسمتها اللوحة (096) لاختيار العميل في طلب الاطلاع. */
export async function initCompanyMoves({ customers = () => [] } = {}) {
    const panel = document.getElementById('companyMovesPanel');
    if (!panel) return;
    const feat = await rpc('h2_features', undefined, '');
    const features = feat.ok && feat.data ? { transfers: feat.data.transfers === true, historical: feat.data.historical === true } : OFF;
    if (!features.transfers && !features.historical) { panel.hidden = true; return; }
    const [tr, hr] = await Promise.all([
        features.transfers ? rpc('company_transfer_requests', undefined, 'تعذّر تحميل طلبات النقل.') : { ok: true, data: null },
        features.historical ? rpc('company_historical_requests', undefined, 'تعذّر تحميل طلبات الاطلاع.') : { ok: true, data: null }
    ]);
    const view = companyMovesView(features, tr.ok ? tr.data : null, hr.ok ? hr.data : null);
    panel.hidden = !view.show;
    if (!view.show) return;
    const reload = () => initCompanyMoves({ customers });
    document.getElementById('companyTransfersBox').hidden = !view.showTransfers;
    if (view.showTransfers) renderTransfers(tr.data, reload);
    document.getElementById('companyHistoryBox').hidden = !view.showHistory;
    if (view.showHistory) renderHistory(hr.data, customers(), reload);
}

function renderTransfers(rows, reload) {
    const box = document.getElementById('companyTransfers');
    box.innerHTML = rows.length ? `<ul class="company-sub-list">${rows.map(t => {
        const info = transferRowInfo(t);
        return `
        <li class="company-sub" data-transfer="${escapeHtml(t.id)}">
            <div class="company-sub-main">
                <p class="company-sub-plan">${escapeHtml(t.customer_name || '—')}</p>
                <p class="company-sub-dates">${escapeHtml(info.text)} · ${escapeHtml(formatDate(t.created_at))}</p>
            </div>
            <div class="company-sub-side">
                <span class="pill">${escapeHtml(info.status)}</span>
                ${info.offerSecondary ? `<label class="company-check"><input type="checkbox" data-allow-secondary>
                    السماح ببقائه عميلًا إضافيًا لدينا (طلبه العميل)</label>` : ''}
                ${info.canDecide ? `
                <button type="button" class="btn btn-primary" data-decide="true">موافقة</button>
                <button type="button" class="btn btn-secondary" data-decide="false">رفض</button>` : ''}
            </div>
        </li>`;
    }).join('')}</ul>` : '<p class="company-sub-dates">لا طلبات نقل.</p>';
    box.querySelectorAll('[data-transfer]').forEach(row => {
        row.querySelectorAll('[data-decide]').forEach(btn => btn.addEventListener('click', async () => {
            const approve = btn.getAttribute('data-decide') === 'true';
            row.querySelectorAll('button').forEach(b => { b.disabled = true; });
            const result = await rpc('transfer_decide', {
                p_transfer: row.getAttribute('data-transfer'), p_approve: approve,
                p_allow_secondary: approve && !!row.querySelector('[data-allow-secondary]')?.checked
            }, 'تعذّر حفظ القرار.');
            if (!result.ok) {
                ui?.showToast?.(result.error, 'error');
                row.querySelectorAll('button').forEach(b => { b.disabled = false; });
                return;
            }
            ui?.showToast?.(result.data?.status === 'completed' ? 'اكتمل النقل' : approve ? 'سُجّلت موافقتك' : 'رُفض الطلب', 'success');
            await reload();
        }));
    });
}

function renderHistory(rows, customers, reload) {
    const form = document.getElementById('companyHistoryForm');
    const select = document.getElementById('companyHistoryCustomer');
    select.innerHTML = '<option value="">اختر العميل</option>'
        + (customers || []).map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name || c.email || '—')}</option>`).join('');
    form.hidden = !(customers || []).length;
    if (!form.dataset.wired) {
        form.dataset.wired = '1';
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const errorBox = document.getElementById('companyHistoryError');
            errorBox.hidden = true;
            const check = validatePurpose(document.getElementById('companyHistoryPurpose').value);
            const customer = select.value;
            if (!customer || !check.ok) {
                errorBox.textContent = !customer ? 'اختر العميل' : check.error;
                errorBox.hidden = false;
                return;
            }
            const submit = document.getElementById('companyHistorySubmit');
            submit.disabled = true;
            const result = await rpc('historical_access_request', { p_customer: customer, p_purpose: check.purpose }, 'تعذّر إرسال الطلب.');
            submit.disabled = false;
            if (!result.ok) { errorBox.textContent = result.error; errorBox.hidden = false; return; }
            form.reset();
            ui?.showToast?.('أُرسل الطلب إلى العميل — لا شيء يُعرض دون موافقته ثم مراجعة مدعوم', 'success');
            await reload();
        });
    }

    const list = document.getElementById('companyHistoryRequests');
    list.innerHTML = rows.length ? `<ul class="company-sub-list">${rows.map(r => `
        <li class="company-sub" data-history="${escapeHtml(r.id)}">
            <div class="company-sub-main">
                <p class="company-sub-plan">${escapeHtml(r.customer_name || '—')}</p>
                <p class="company-sub-dates">${escapeHtml(r.purpose || '')}</p>
                ${r.expires_at && Array.isArray(r.ticket_ids) ? `<p class="company-sub-dates">ينتهي ${escapeHtml(formatDate(r.expires_at))}</p>` : ''}
            </div>
            <div class="company-sub-side">
                <span class="pill">${escapeHtml(HISTORY_STATUS[r.status] || '—')}</span>
                ${(Array.isArray(r.ticket_ids) ? r.ticket_ids : []).map((id, i) => `
                <button type="button" class="panel-link" data-history-ticket="${escapeHtml(id)}">عرض التذكرة ${i + 1}</button>`).join('')}
            </div>
        </li>`).join('')}</ul>` : '<p class="company-sub-dates">لا طلبات اطلاع.</p>';
    list.querySelectorAll('[data-history-ticket]').forEach(btn => btn.addEventListener('click', async () => {
        const request = btn.closest('[data-history]').getAttribute('data-history');
        const result = await rpc('historical_ticket_view', { p_request: request, p_ticket: btn.getAttribute('data-history-ticket') },
                                 'تعذّر عرض التذكرة.');
        if (!result.ok) { ui?.showToast?.(result.error, 'error'); return; }
        showHistoricalTicket(result.data);
    }));
}

function showHistoricalTicket(data) {
    const box = document.getElementById('companyHistoryView');
    const t = data?.ticket || {};
    box.innerHTML = `
        <h3 class="panel-title">${escapeHtml(t.title || '—')}</h3>
        <p class="company-sub-dates">رسائل العميل وحدها · عرضك مسجَّل · ينتهي الوصول ${escapeHtml(formatDate(data?.expires_at))}</p>
        <p class="company-history-text">${escapeHtml(t.description || '')}</p>
        ${(data?.customer_messages || []).map(m => `
        <p class="company-history-text"><small>${escapeHtml(formatDate(m.created_at))}</small><br>${escapeHtml(m.message || '')}</p>`).join('')}
        <button type="button" class="btn btn-secondary" data-close-history>إغلاق</button>`;
    box.hidden = false;
    box.querySelector('[data-close-history]').addEventListener('click', () => { box.hidden = true; box.innerHTML = ''; });
}
