/**
 * portal-moves.js — أدوات العميل في البوابة للترحيل 101 (السؤال 5–7):
 *   • طلب جعل الشركة الحالية أساسية (نقل بموافقة الشركتين؛ هذا الطلب نفسه تأكيد العميل)
 *   • نسخ تذاكر يختارها من شركة أخرى إلى الحالية (محتواه وحده؛ الأصل يبقى)
 *   • الرد على طلبات الاطلاع على تذاكره السابقة (يختار التذاكر أو يرفض؛ ثم مراجعة مدعوم)
 *
 * لا قرار هنا: كل زر يمر بدالة في القاعدة تتحقق من المفتاح والعضوية والملكية. المفاتيح الثلاثة
 * مطفأة افتراضيًا فلا يظهر من هذا شيء.
 */
import { escapeHtml } from '/assets/js/customer/portal-ui.js';
import { ui } from '/ui-service.js';
import {
    fetchH2Features, movesView, carrySummary, transferStatusLabel, historyStatusLabel,
    fetchMyTransfers, requestTransfer, cancelTransfer, fetchCarryCandidates, carryTickets,
    fetchMyHistoricalRequests, respondHistoricalRequest
} from '/assets/js/portal/portal-data.js';

const newKey = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)));

/** view: membershipView(my_company_portal()) من 096. */
export async function initPortalMoves(view) {
    const features = await fetchH2Features();
    const moves = movesView(features, view);
    if (moves.showTransfers || moves.carrySources.length) await renderMoves(view, moves);
    if (moves.showHistory) await renderHistory();
}

/* ── النقل والنسخ ─────────────────────────────────────────────────────────── */

async function renderMoves(view, moves) {
    const panel = document.getElementById('portalMoves');
    panel.hidden = false;
    const current = view.current;

    const transferBox = document.getElementById('portalTransferBox');
    transferBox.hidden = !moves.canTransfer;
    if (moves.canTransfer) {
        document.getElementById('portalTransferTarget').textContent = current.name;
        let key = newKey();  // نفس المفتاح لإعادة المحاولة بعد خطأ شبكة
        const button = document.getElementById('portalTransferBtn');
        button.addEventListener('click', async () => {
            const ok = await ui.showConfirm('طلب نقل شركتك الأساسية؟',
                `ستصبح «${current.name}» شركتك الأساسية بعد موافقة الشركتين. تذاكرك السابقة تبقى في شركتها، `
                + 'ويمكنك نسخ ما تختاره منها لاحقًا.', { confirmLabel: 'إرسال الطلب', cancelLabel: 'تراجع' });
            if (!ok) return;
            button.disabled = true;
            const result = await requestTransfer(current.id, document.getElementById('portalKeepSource').checked, key);
            if (!result.ok) { button.disabled = false; return showError('portalMovesError', result.error); }
            key = newKey();
            ui?.showToast?.('أُرسل طلب النقل إلى الشركتين', 'success');
            await renderTransfers();
        });
    }
    if (moves.showTransfers) await renderTransfers();

    const carryBox = document.getElementById('portalCarryBox');
    carryBox.hidden = moves.carrySources.length === 0;
    if (moves.carrySources.length) wireCarry(current, moves.carrySources);
}

async function renderTransfers() {
    const list = document.getElementById('portalTransferList');
    const result = await fetchMyTransfers();
    if (!result.ok) return showError('portalMovesError', result.error);
    list.innerHTML = result.data.map(t => `
        <li class="company-sub">
            <div class="company-sub-main">
                <p class="company-sub-plan">${escapeHtml(t.from || '—')} ← ${escapeHtml(t.to || '—')}</p>
                <p class="company-sub-dates">${escapeHtml(transferStatusLabel(t.status))}</p>
            </div>
            ${t.status === 'pending' ? `<button type="button" class="panel-link" data-cancel-transfer="${escapeHtml(t.id)}">إلغاء الطلب</button>` : ''}
        </li>`).join('');
    list.querySelectorAll('[data-cancel-transfer]').forEach(btn => btn.addEventListener('click', async () => {
        btn.disabled = true;
        const r = await cancelTransfer(btn.getAttribute('data-cancel-transfer'));
        if (!r.ok) { btn.disabled = false; return showError('portalMovesError', r.error); }
        await renderTransfers();
    }));
}

function wireCarry(current, sources) {
    const select = document.getElementById('portalCarrySource');
    const list = document.getElementById('portalCarryList');
    const button = document.getElementById('portalCarryBtn');
    document.getElementById('portalCarryTarget').textContent = current.name;
    select.innerHTML = '<option value="">اختر الشركة</option>'
        + sources.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');
    let key = newKey();

    const refreshButton = () => {
        button.disabled = !list.querySelector('input[type="checkbox"]:checked');
    };
    select.addEventListener('change', async () => {
        list.innerHTML = '';
        button.disabled = true;
        key = newKey();
        if (!select.value) return;
        const result = await fetchCarryCandidates(select.value);
        if (!result.ok) return showError('portalMovesError', result.error);
        list.innerHTML = result.data.length ? result.data.map(t => `
            <li class="company-sub">
                <label class="portal-carry-item">
                    <input type="checkbox" value="${escapeHtml(t.id)}">
                    <span>
                        <strong>#${escapeHtml(t.ticket_number ?? '')} ${escapeHtml(t.title || '')}</strong>
                        <small>${escapeHtml(carrySummary(t.manifest))}</small>
                    </span>
                </label>
            </li>`).join('') : '<li class="company-sub-dates">لا تذاكر لك في هذه الشركة.</li>';
        list.querySelectorAll('input[type="checkbox"]').forEach(c => c.addEventListener('change', refreshButton));
    });
    button.addEventListener('click', async () => {
        const ids = [...list.querySelectorAll('input[type="checkbox"]:checked')].map(c => c.value);
        if (!ids.length || !select.value) return;
        button.disabled = true;
        const result = await carryTickets(select.value, current.id, ids, key);
        if (!result.ok) { refreshButton(); return showError('portalMovesError', result.error); }
        key = newKey();
        ui?.showToast?.(`نُسخت ${ids.length} تذكرة إلى «${current.name}»`, 'success');
        window.location.reload();
    });
}

/* ── طلبات الاطلاع على التاريخ ────────────────────────────────────────────── */

async function renderHistory() {
    const panel = document.getElementById('history-requests');
    const list = document.getElementById('portalHistoryList');
    const result = await fetchMyHistoricalRequests();
    if (!result.ok) { panel.hidden = false; return showError('portalHistoryError', result.error); }
    panel.hidden = result.data.length === 0;
    list.innerHTML = result.data.map(r => `
        <li class="company-sub portal-history" data-history="${escapeHtml(r.id)}">
            <div class="company-sub-main">
                <p class="company-sub-plan">${escapeHtml(r.company_name || 'شركة')}</p>
                <p class="company-sub-dates">${escapeHtml(r.purpose || '')}</p>
                <p class="company-sub-dates">${escapeHtml(historyStatusLabel(r.status))}</p>
            </div>
            ${r.status === 'awaiting_customer' ? `
            <fieldset class="portal-history-pick">
                <legend>اختر ما تسمح بعرضه من تذاكرك (رسائلك فقط، لا ردود الشركات الأخرى)</legend>
                ${(r.eligible || []).map(t => `
                <label><input type="checkbox" value="${escapeHtml(t.id)}">
                    #${escapeHtml(t.ticket_number ?? '')} ${escapeHtml(t.title || '')} — ${escapeHtml(t.company_name || '')}</label>`).join('')
                    || '<p class="company-sub-dates">لا تذاكر لك في شركات أخرى.</p>'}
                <div class="portal-invitation-actions">
                    <button type="button" class="btn btn-primary" data-history-approve disabled>السماح بالمختار</button>
                    <button type="button" class="btn btn-secondary" data-history-decline>رفض</button>
                </div>
            </fieldset>` : ''}
        </li>`).join('');
    list.querySelectorAll('[data-history]').forEach(item => {
        const id = item.getAttribute('data-history');
        const approve = item.querySelector('[data-history-approve]');
        if (!approve) return;
        const picked = () => [...item.querySelectorAll('input[type="checkbox"]:checked')].map(c => c.value);
        item.querySelectorAll('input[type="checkbox"]').forEach(c => c.addEventListener('change', () => {
            approve.disabled = picked().length === 0;
        }));
        approve.addEventListener('click', () => respond(id, true, picked()));
        item.querySelector('[data-history-decline]').addEventListener('click', () => respond(id, false, null));
    });
    if (!panel.hidden && window.location.hash === '#history-requests') panel.scrollIntoView({ block: 'nearest' });
}

async function respond(id, approve, ids) {
    document.querySelectorAll('#portalHistoryList button').forEach(b => { b.disabled = true; });
    const result = await respondHistoricalRequest(id, approve, ids);
    if (!result.ok) {
        showError('portalHistoryError', result.error);
        document.querySelectorAll('#portalHistoryList [data-history]').forEach(item => {
            const decline = item.querySelector('[data-history-decline]');
            if (decline) decline.disabled = false;
            const approveBtn = item.querySelector('[data-history-approve]');
            if (approveBtn) approveBtn.disabled = !item.querySelector('input[type="checkbox"]:checked');
        });
        return;
    }
    ui?.showToast?.(approve ? 'أُرسلت موافقتك لمراجعة مدعوم' : 'تم رفض الطلب', 'success');
    await renderHistory();
}

function showError(id, message) {
    const box = document.getElementById(id);
    box.textContent = message;
    box.hidden = false;
}
