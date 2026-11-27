/**
 * owner/requests.html — تبويب «الطلبات» المجمّع في لوحة المالك (الترحيل 142).
 *
 *   • owner_list_requests: قراءة المالك الوحيدة — UNION على الجداول
 *     القائمة وحدها (حساب شركة، تجربة، تعويض اشتراك مدفوع، حذف حساب،
 *     اقتراحات)، بلا جدول جديد وبلا كتابة. المعلّقة أولًا ثم الأحدث.
 *   • الصفحة عرض وترشيح وروابط عميقة فقط — لا قرار هنا إطلاقًا: كل صف
 *     يفتح التفاصيل/الإجراء في صفحته الأصلية (التجارب، التعويض، قائمة
 *     المتاجر، مراجعة حساب الشركة، شجرة الحسابات، الاقتراحات).
 *   • التعويض يظهر مرة واحدة كمصدر واحد (شركات)؛ وطلب المتجر الإلكتروني
 *     المعلّق هو الصف نفسه في طلبات حساب الشركة، وتشير شارته إلى وجوده
 *     في قائمة المتاجر — بلا أي صف مكرر.
 *   • التعويض يغطي كل الباقات المدفوعة (المتقدمة والفائقة والواتساب
 *     والشاملة)؛ وباقة المتجر ليست منها.
 */
import {
    supabase, bootOwnerPage, esc, when, num, table, kpis, errorBlock, loadingBlock,
    friendlyError
} from '/assets/js/owner/owner-page.js';
import {
    REQUEST_TYPE_LABELS, REQUEST_SOURCE_LABELS, REQUEST_STATUS_LABELS,
    requestSource, filterRequests, countPendingBySource, requestAmountText
} from '/assets/js/owner-requests-model.js';

const $ = (id) => document.getElementById(id);

let session = null;
let requests = [];

async function rpc(name, args) {
    // النداء نفسه قد يرمي (انقطاع شبكة) لا أن يعود بـ error: بلا التقاط كانت
    // القائمة تبقى هيكلًا عظميًا بلا تفسير.
    try {
        const { data, error } = await supabase.rpc(name, args);
        return { data, error };
    } catch (err) {
        return { data: null, error: err };
    }
}

function currentFilters() {
    return {
        type: $('requestsType').value || '',
        source: $('requestsSource').value || '',
        status: $('requestsStatus').value || ''
    };
}

function renderKpis() {
    const pending = countPendingBySource(requests);
    $('requestsKpis').innerHTML = kpis([
        ['طلبات معلّقة', num(pending.total), pending.total ? 'kpi--info' : ''],
        ['معلّقة — شركات', num(pending.companies), ''],
        ['معلّقة — إدارة', num(pending.management), ''],
        ['معلّقة — عملاء', num(pending.customers), '']
    ]);
}

async function loadRequests() {
    $('requestsTable').innerHTML = loadingBlock();
    const { data, error } = await rpc('owner_list_requests', { p_type: null, p_status: null });
    if (error) { $('requestsTable').innerHTML = errorBlock(friendlyError(error)); return; }
    requests = Array.isArray(data) ? data : [];
    renderRequests();
    renderKpis();
}

function renderRequests() {
    const rows = filterRequests(requests, currentFilters());
    $('requestsTable').innerHTML = table(
        ['النوع', 'الطلب', 'الشركة / الطالب', 'المصدر', 'الحالة', 'طُلب في', 'إجراء'],
        rows,
        (r) => {
            const source = requestSource(r);
            const statusLabel = REQUEST_STATUS_LABELS[r.status] || r.status || '—';
            const tone = r.status === 'pending' ? 'status-tone-warning'
                : (r.status === 'approved' || r.status === 'paid' || r.status === 'implemented') ? 'status-tone-success'
                : 'status-neutral';
            return `<tr>
        <td>${esc(REQUEST_TYPE_LABELS[r.type] || r.type || '—')}</td>
        <td><div class="owner-account"><span class="owner-account-name">${esc(r.title || '—')}</span>
            ${r.summary ? `<span class="owner-account-email">${esc(r.summary)}</span>` : ''}
            ${requestAmountText(r) ? `<span class="owner-account-email">تعويض ${esc(requestAmountText(r))}</span>` : ''}
            ${r.in_store_queue ? `<span class="owner-account-email"><a href="/owner/stores.html#storeRequestsHeading">في قائمة المتاجر المعلّقة</a></span>` : ''}</div></td>
        <td><div class="owner-account"><span class="owner-account-name">${esc(r.company_name || '—')}</span>
            <span class="owner-account-email">${esc(r.requester_name || '')}${r.requester_email ? ` · <span dir="ltr">${esc(r.requester_email)}</span>` : ''}</span></div></td>
        <td>${esc(REQUEST_SOURCE_LABELS[source] || source || '—')}</td>
        <td><span class="pill ${tone}">${esc(statusLabel)}</span></td>
        <td>${esc(when(r.requested_at))}</td>
        <td><a class="btn btn-outline btn-sm" href="${esc(r.detail_url || '#')}">فتح التفاصيل</a></td></tr>`;
        },
        { empty: 'لا طلبات مطابقة.' });
}

function refresh() {
    loadRequests();
}

(async function init() {
    const booted = await bootOwnerPage();
    if (!booted) return;
    session = booted.session;
    $('requestsFilters').addEventListener('submit', (e) => { e.preventDefault(); renderRequests(); });
    $('requestsType').addEventListener('change', renderRequests);
    $('requestsSource').addEventListener('change', renderRequests);
    $('requestsStatus').addEventListener('change', renderRequests);
    $('requestsRefresh').addEventListener('click', refresh);
    refresh();
})();
