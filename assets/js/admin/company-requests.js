/**
 * company-requests.js — مراجعة طلبات حسابات الشركات (migrations/068).
 *
 * العميل اللي يختار «شركة» عند الاشتراك بيبعت بيانات شركته كطلب. الصفحة دي
 * بتعرض الطلبات وبتوافق أو ترفض — والقرار نفسه في القاعدة:
 *   admin_list_company_account_requests()   القراءة (للإدارة فقط)
 *   admin_review_company_account_request()  الموافقة/الرفض (للإدارة فقط)
 * الموافقة بتُنشئ صف companies باسم العميل، فيتحوّل حسابه لحساب شركة
 * بالمحفّز القائم. الصفحة لا تكتب في أي جدول مباشرةً.
 */
import { supabase } from '/api-config.js';
import { checkAdminAuth, updateAdminUI } from './auth.js';
import { initSidebar } from './sidebar.js';
import { escapeHtml, debounce } from './admin-utils.js';
import { logActivity } from '/activity-service.js';

const STATUS_LABELS = {
    pending: 'قيد المراجعة',
    approved: 'تمت الموافقة',
    rejected: 'مرفوض'
};

const STATUS_CLASSES = {
    pending: 'status-pending',
    approved: 'status-resolved',
    rejected: 'status-danger'
};

const CYCLE_LABELS = { monthly: 'شهري', yearly: 'سنوي' };

let allRequests = [];
let activeRequestId = null;
let busy = false;

const formatDate = (value, withTime = false) => {
    if (!value) return '—';
    const d = new Date(value);
    return withTime ? d.toLocaleString('ar-EG') : d.toLocaleDateString('ar-EG');
};

function planLabel(req) {
    if (!req.requested_plan) return '—';
    const cycle = CYCLE_LABELS[req.requested_billing_cycle];
    return cycle ? `${req.requested_plan_name_ar} (${cycle})` : req.requested_plan_name_ar;
}

async function init() {
    initSidebar();
    const user = await checkAdminAuth();
    if (!user) return;

    updateAdminUI(user);
    setupEventListeners();
    await loadRequests();
}

async function loadRequests() {
    const body = document.getElementById('crBody');

    const { data, error } = await supabase.rpc('admin_list_company_account_requests');
    if (error) {
        console.error('Error loading company account requests:', error);
        body.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 2rem;">تعذر تحميل الطلبات: ${escapeHtml(error.message || '')}</td></tr>`;
        return;
    }

    allRequests = Array.isArray(data) ? data : [];
    renderRequests();
}

function renderRequests() {
    const body = document.getElementById('crBody');
    const search = document.getElementById('crSearch').value.trim().toLowerCase();
    const statusFilter = document.getElementById('crStatusFilter').value;

    const filtered = allRequests.filter((req) => {
        if (statusFilter && req.status !== statusFilter) return false;
        if (!search) return true;
        return [req.company_name, req.customer_name, req.customer_email, req.commercial_registration_number]
            .some(v => String(v || '').toLowerCase().includes(search));
    });

    if (filtered.length === 0) {
        body.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 2rem;">${
            statusFilter === 'pending' && !search ? 'لا توجد طلبات قيد المراجعة' : 'لا توجد طلبات مطابقة'}</td></tr>`;
        return;
    }

    body.innerHTML = filtered.map((req) => `
        <tr data-request-row="${escapeHtml(req.id)}">
            <td>${escapeHtml(req.company_name)}<div style="font-size: 0.75rem; color: var(--color-text-secondary);">سجل ${escapeHtml(req.commercial_registration_number)}</div></td>
            <td>${escapeHtml(req.customer_name || '—')}<div style="font-size: 0.75rem; color: var(--color-text-secondary);">${escapeHtml(req.customer_email || '')}</div></td>
            <td>${escapeHtml(planLabel(req))}</td>
            <td><span class="status-badge ${STATUS_CLASSES[req.status] || 'status-pending'}">${escapeHtml(STATUS_LABELS[req.status] || req.status)}</span></td>
            <td>${formatDate(req.created_at)}</td>
            <td><button class="btn btn-secondary btn-sm" data-view-request="${escapeHtml(req.id)}">${req.status === 'pending' ? 'مراجعة' : 'عرض'}</button></td>
        </tr>
    `).join('');

    body.querySelectorAll('[data-view-request]').forEach((btn) => {
        btn.addEventListener('click', () => openModal(btn.dataset.viewRequest));
    });
}

function setText(id, value) {
    document.getElementById(id).textContent = value === null || value === undefined || value === '' ? '—' : value;
}

function openModal(requestId) {
    const req = allRequests.find((r) => r.id === requestId);
    if (!req) return;
    activeRequestId = req.id;

    const isPending = req.status === 'pending';
    setText('crModalSub', isPending
        ? 'تحقّق من البيانات القانونية. الموافقة تُنشئ الشركة باسم العميل ويتحوّل حسابه إلى حساب شركة فورًا.'
        : `هذا الطلب ${STATUS_LABELS[req.status] || req.status}.`);

    setText('crCompanyName', req.company_name);
    setText('crCrNumber', req.commercial_registration_number);
    const expiryEl = document.getElementById('crCrExpiry');
    const expired = req.commercial_registration_expiry && new Date(req.commercial_registration_expiry) < new Date(new Date().toDateString());
    expiryEl.textContent = formatDate(req.commercial_registration_expiry) + (expired ? ' — منتهٍ' : '');
    expiryEl.classList.toggle('cr-expired', !!expired);
    setText('crCompanyEmail', req.company_email);
    setText('crCompanyPhone', req.company_phone);
    setText('crCustomerName', req.customer_name);
    setText('crCustomerEmail', req.customer_email);
    setText('crCustomerPhone', req.customer_phone);
    setText('crPlan', planLabel(req));

    document.getElementById('crReviewedBlock').style.display = isPending ? 'none' : 'block';
    if (!isPending) {
        setText('crStatus', STATUS_LABELS[req.status] || req.status);
        setText('crReviewer', req.reviewer_name);
        setText('crReviewedAt', formatDate(req.reviewed_at, true));
        setText('crReviewNote', req.review_note);
    }

    document.getElementById('crNoteField').style.display = isPending ? 'block' : 'none';
    document.getElementById('crApproveBtn').style.display = isPending ? 'inline-flex' : 'none';
    document.getElementById('crRejectBtn').style.display = isPending ? 'inline-flex' : 'none';
    document.getElementById('crNote').value = '';
    showError('');

    document.getElementById('crModal').style.display = 'block';
}

function closeModal() {
    if (busy) return;
    document.getElementById('crModal').style.display = 'none';
    activeRequestId = null;
}

function showError(message) {
    const el = document.getElementById('crError');
    el.textContent = message;
    el.style.display = message ? 'block' : 'none';
}

async function review(decision) {
    if (!activeRequestId || busy) return;
    const note = document.getElementById('crNote').value.trim();

    // القاعدة بترفض الرفض بلا سبب كمان؛ ده بس عشان الأدمن يعرف قبل النداء
    if (decision === 'reject' && !note) {
        showError('اكتب سبب الرفض — سيظهر للعميل في الإشعار.');
        document.getElementById('crNote').focus();
        return;
    }

    const req = allRequests.find((r) => r.id === activeRequestId);
    const button = document.getElementById(decision === 'approve' ? 'crApproveBtn' : 'crRejectBtn');
    const original = button.textContent;
    busy = true;
    button.disabled = true;
    button.textContent = 'جاري التنفيذ...';
    showError('');

    try {
        const { error } = await supabase.rpc('admin_review_company_account_request', {
            p_request_id: activeRequestId,
            p_decision: decision,
            p_note: note || null
        });
        if (error) {
            showError(error.message || 'تعذّر تنفيذ القرار. حاول مرة أخرى.');
            return;
        }

        logActivity('company_request_review',
            `${decision === 'approve' ? 'Approved' : 'Rejected'} company account request ${activeRequestId} (${req?.company_name || ''})`);
        busy = false;
        closeModal();
        showToast(decision === 'approve'
            ? 'تمت الموافقة — أصبح الحساب حساب شركة'
            : 'تم رفض الطلب وإخطار العميل بالسبب', 'success');
        await loadRequests();
    } finally {
        busy = false;
        button.disabled = false;
        button.textContent = original;
    }
}

function setupEventListeners() {
    document.getElementById('crSearch').addEventListener('input', debounce(renderRequests, 250));
    document.getElementById('crStatusFilter').addEventListener('change', renderRequests);

    document.getElementById('crCloseBtn').addEventListener('click', closeModal);
    document.getElementById('crApproveBtn').addEventListener('click', () => review('approve'));
    document.getElementById('crRejectBtn').addEventListener('click', () => review('reject'));
    document.getElementById('crModal').addEventListener('click', (e) => {
        if (e.target.id === 'crModal') closeModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && activeRequestId) closeModal();
    });
}

function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.style.background = type === 'success' ? 'var(--color-success)' : 'var(--color-danger)';
    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

init();
