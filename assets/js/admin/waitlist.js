import { supabase } from '/api-config.js';
import { checkAdminAuth, updateAdminUI } from './auth.js';
import { initSidebar } from './sidebar.js';
import { escapeHtml, debounce } from './admin-utils.js';
import { logActivity } from '/activity-service.js';

let user = null;
let allEntries = [];
let activeEntryId = null;

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

async function init() {
    initSidebar();
    user = await checkAdminAuth();
    if (!user) return;

    updateAdminUI(user);
    await loadEntries();
    setupEventListeners();
}

async function loadEntries() {
    const body = document.getElementById('waitlistBody');

    const { data, error } = await supabase
        .from('waitlist_entries')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) {
        console.error('Error loading waitlist entries:', error);
        body.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 2rem;">تعذر تحميل قائمة الانتظار</td></tr>';
        return;
    }

    allEntries = data || [];
    renderEntries();
}

function renderEntries() {
    const body = document.getElementById('waitlistBody');
    const search = document.getElementById('waitlistSearch').value.trim().toLowerCase();
    const statusFilter = document.getElementById('waitlistStatusFilter').value;

    const filtered = allEntries.filter((entry) => {
        if (statusFilter && entry.status !== statusFilter) return false;
        if (!search) return true;
        return (
            (entry.name || '').toLowerCase().includes(search) ||
            (entry.email || '').toLowerCase().includes(search) ||
            (entry.phone || '').toLowerCase().includes(search)
        );
    });

    if (filtered.length === 0) {
        body.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 2rem;">لا توجد طلبات مطابقة</td></tr>';
        return;
    }

    body.innerHTML = filtered.map((entry) => `
        <tr>
            <td>${escapeHtml(entry.name)}</td>
            <td>${escapeHtml(entry.email)}</td>
            <td>${escapeHtml(entry.phone || '—')}</td>
            <td><span class="status-badge ${STATUS_CLASSES[entry.status] || 'status-pending'}">${STATUS_LABELS[entry.status] || entry.status}</span></td>
            <td>${new Date(entry.created_at).toLocaleDateString('ar-EG')}</td>
            <td><button class="btn btn-secondary btn-sm view-entry-btn" data-entry-id="${entry.id}">عرض</button></td>
        </tr>
    `).join('');

    document.querySelectorAll('.view-entry-btn').forEach((btn) => {
        btn.addEventListener('click', () => openDetailModal(btn.dataset.entryId));
    });
}

function openDetailModal(entryId) {
    const entry = allEntries.find((e) => e.id === entryId);
    if (!entry) return;

    activeEntryId = entry.id;

    document.getElementById('detailName').textContent = entry.name;
    document.getElementById('detailEmail').textContent = entry.email;
    document.getElementById('detailPhone').textContent = entry.phone || '—';
    document.getElementById('detailStatus').textContent = STATUS_LABELS[entry.status] || entry.status;
    document.getElementById('detailCreatedAt').textContent = new Date(entry.created_at).toLocaleString('ar-EG');

    const reviewedRow = document.getElementById('detailReviewedRow');
    if (entry.reviewed_at) {
        reviewedRow.style.display = 'flex';
        document.getElementById('detailReviewedAt').textContent = new Date(entry.reviewed_at).toLocaleString('ar-EG');
    } else {
        reviewedRow.style.display = 'none';
    }

    document.getElementById('detailApproveBtn').style.display = entry.status === 'approved' ? 'none' : 'inline-flex';
    document.getElementById('detailRejectBtn').style.display = entry.status === 'rejected' ? 'none' : 'inline-flex';

    document.getElementById('waitlistDetailModal').style.display = 'block';
}

function closeDetailModal() {
    document.getElementById('waitlistDetailModal').style.display = 'none';
    activeEntryId = null;
}

async function updateEntryStatus(newStatus) {
    if (!activeEntryId) return;

    const { error } = await supabase
        .from('waitlist_entries')
        .update({
            status: newStatus,
            reviewed_at: new Date().toISOString(),
            reviewed_by: user.id
        })
        .eq('id', activeEntryId);

    if (error) {
        showToast(error.message || 'حدث خطأ أثناء تحديث الحالة', 'error');
        return;
    }

    logActivity('waitlist_review', `${newStatus === 'approved' ? 'Approved' : 'Rejected'} waitlist entry ${activeEntryId}`);
    showToast(newStatus === 'approved' ? 'تمت الموافقة على الطلب' : 'تم رفض الطلب', 'success');
    closeDetailModal();
    await loadEntries();
}

function setupEventListeners() {
    document.getElementById('waitlistSearch').addEventListener('input', debounce(renderEntries, 250));
    document.getElementById('waitlistStatusFilter').addEventListener('change', renderEntries);

    document.getElementById('detailCloseBtn').addEventListener('click', closeDetailModal);
    document.getElementById('detailApproveBtn').addEventListener('click', () => updateEntryStatus('approved'));
    document.getElementById('detailRejectBtn').addEventListener('click', () => updateEntryStatus('rejected'));

    document.getElementById('waitlistDetailModal').addEventListener('click', (e) => {
        if (e.target.id === 'waitlistDetailModal') closeDetailModal();
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
