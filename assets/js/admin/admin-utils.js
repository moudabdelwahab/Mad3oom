/**
 * Shared Admin Utilities
 * Common functions used across admin pages to reduce code duplication
 */

import { supabase } from '/api-config.js';
import { adminImpersonateUser } from '/auth-client.js';
import { logActivity } from '/activity-service.js';
import { fetchTicketReplies } from '/tickets-service.js';
import { getTicketStatusLabel } from '/constants.js';

/**
 * Impersonate a user (admin feature) - يفتح حساب مستخدم آخر ("الدخول كعضو")
 * مقصور على admin/super_user فقط (والأدمن الرئيسي بإيميله)؛ التنفيذ الفعلي
 * والملزم لهذا القيد في requireAuth() (auth-client.js) - الفحص هنا تحسين
 * لتجربة الاستخدام (رسالة خطأ واضحة فورًا) مش الحماية نفسها.
 * @param {string} userId - User ID to impersonate
 * @param {string} redirectPath - Path to redirect after impersonation (default: customer dashboard)
 */
export async function impersonateUser(userId, redirectPath = '/customer-dashboard.html') {
    if (!userId) {
        alert('لا يمكن الدخول لحساب ضيف');
        return;
    }

    try {
        const { data: { user: currentAuthUser } } = await supabase.auth.getUser();
        if (!currentAuthUser) {
            alert('يجب تسجيل الدخول أولاً');
            return;
        }

        const { data: currentProfile } = await supabase
            .from('profiles')
            .select('role')
            .eq('id', currentAuthUser.id)
            .maybeSingle();

        const isMainAdminEmail = currentAuthUser.email === 'support@mad3oom.online';
        const canImpersonate = isMainAdminEmail || currentProfile?.role === 'admin' || currentProfile?.role === 'super_user';

        if (!canImpersonate) {
            alert('هذه الميزة متاحة فقط للأدمن والمستخدم المميز (super_user).');
            return;
        }

        // Fetch target user info for logging
        const { data: targetUser } = await supabase
            .from('profiles')
            .select('email')
            .eq('id', userId)
            .single();

        // Log the impersonation activity
        await logActivity('impersonate', {
            target_user_id: userId,
            target_email: targetUser?.email
        });

        // Perform impersonation + navigation (نداء واحد مسؤول عن التنقل، بدل
        // ما يحصل تنقّل مزدوج كان بيمسح ?impersonate= أحيانًا)
        await adminImpersonateUser(userId, redirectPath);
    } catch (error) {
        console.error('Error impersonating user:', error);
        alert('حدث خطأ أثناء محاولة الدخول كمستخدم');
    }
}

/**
 * Load and render ticket replies in a container
 * @param {string} ticketId - Ticket ID
 * @param {HTMLElement} container - Container element to render replies in
 * @returns {Promise<void>}
 */
export async function loadTicketReplies(ticketId, container) {
    if (!container) {
        console.error('Container element not found');
        return;
    }

    container.innerHTML = '<div style="text-align:center; padding:1rem; color:#999;">جاري تحميل الردود...</div>';

    try {
        const replies = await fetchTicketReplies(ticketId);

        if (!replies || replies.length === 0) {
            container.innerHTML = '<div style="text-align:center; padding:1rem; color:#999; font-size:0.8rem;">لا توجد ردود بعد.</div>';
            return;
        }

        container.innerHTML = replies.map(r => {
            const isAdmin = r.profiles?.role === 'admin';
            const typeClass = r.is_internal ? 'reply-internal' : (isAdmin ? 'reply-admin' : 'reply-user');
            const typeLabel = r.is_internal ? '<span class="internal-tag">ملاحظة داخلية</span>' : '';

            return `
                <div class="reply-item ${typeClass}">
                    <div class="reply-header">
                        <span style="font-weight:700;">${r.profiles?.full_name || 'مستخدم'} ${typeLabel}</span>
                        <span>${new Date(r.created_at).toLocaleString('ar-EG', {
                            hour: '2-digit',
                            minute: '2-digit',
                            day: 'numeric',
                            month: 'short'
                        })}</span>
                    </div>
                    <div class="reply-content">${escapeHtml(r.message)}</div>
                </div>
            `;
        }).join('');

        // Auto-scroll to bottom
        container.scrollTop = container.scrollHeight;
    } catch (err) {
        console.error('Error loading replies:', err);
        container.innerHTML = '<div style="color:red; text-align:center;">فشل تحميل الردود</div>';
    }
}

/**
 * Populate ticket modal with ticket data
 * @param {object} ticket - Ticket object from database
 * @param {object} elements - Object containing modal element IDs
 */
export function populateTicketModal(ticket, elements = {}) {
    const {
        titleId = 'modalTicketTitle',
        descId = 'modalTicketDesc',
        numberId = 'modalTicketNumber',
        userId = 'modalTicketUser',
        emailId = 'modalTicketEmail',
        dateId = 'modalTicketDate',
        statusId = 'modalTicketStatus',
        imageContainerId = 'modalTicketImageContainer',
        imageId = 'modalTicketImage',
        imageLinkId = 'modalTicketImageLink'
    } = elements;

    // Set text content
    const titleEl = document.getElementById(titleId);
    const descEl = document.getElementById(descId);
    const numberEl = document.getElementById(numberId);
    const userEl = document.getElementById(userId);
    const emailEl = document.getElementById(emailId);
    const dateEl = document.getElementById(dateId);
    const statusEl = document.getElementById(statusId);

    if (titleEl) titleEl.innerText = ticket.title;
    if (descEl) descEl.innerText = ticket.description;
    if (numberEl) numberEl.innerText = `#${ticket.ticket_number}`;
    if (userEl) userEl.innerText = ticket.profiles?.full_name || 'مستخدم';
    if (emailEl) emailEl.innerText = ticket.profiles?.email || '';
    if (dateEl) dateEl.innerText = new Date(ticket.created_at).toLocaleString('ar-EG');

    // Set status with proper styling
    if (statusEl) {
        statusEl.innerText = getTicketStatusLabel(ticket.status);
        statusEl.className = `detail-value status-badge status-${ticket.status}`;
    }

    // Handle image
    const imgContainer = document.getElementById(imageContainerId);
    if (imgContainer) {
        if (ticket.image_url) {
            imgContainer.style.display = 'block';
            const imgEl = document.getElementById(imageId);
            const imgLinkEl = document.getElementById(imageLinkId);
            if (imgEl) imgEl.src = ticket.image_url;
            if (imgLinkEl) imgLinkEl.href = ticket.image_url;
        } else {
            imgContainer.style.display = 'none';
        }
    }
}

/**
 * Show a toast notification
 * @param {string} message - Message to display
 * @param {string} type - Type of toast (success, error, info, warning)
 * @param {number} duration - Duration in milliseconds
 */
export function showToast(message, type = 'info', duration = 3000) {
    const toast = document.getElementById('toast');
    if (!toast) {
        console.warn('Toast element not found');
        return;
    }

    // Set message and styling based on type
    toast.innerText = message;
    toast.className = `toast toast-${type}`;
    toast.style.display = 'block';

    // Auto-hide after duration
    setTimeout(() => {
        toast.style.display = 'none';
    }, duration);
}

/**
 * Escape HTML to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
export function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Format file size in human-readable format
 * @param {number} bytes - File size in bytes
 * @returns {string} Formatted size
 */
export function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Debounce function to limit rate of function calls
 * @param {Function} func - Function to debounce
 * @param {number} wait - Wait time in milliseconds
 * @returns {Function} Debounced function
 */
export function debounce(func, wait = 300) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * Setup modal close handlers
 * @param {string} modalId - Modal element ID
 * @param {string} closeBtnId - Close button element ID
 * @param {Function} onClose - Optional callback when modal closes
 */
export function setupModalCloseHandlers(modalId, closeBtnId, onClose = null) {
    const modal = document.getElementById(modalId);
    const closeBtn = document.getElementById(closeBtnId);

    if (!modal) {
        console.warn(`Modal ${modalId} not found`);
        return;
    }

    // Close button handler
    if (closeBtn) {
        closeBtn.onclick = () => {
            modal.style.display = 'none';
            if (onClose) onClose();
        };
    }

    // Click outside to close
    window.addEventListener('click', (event) => {
        if (event.target === modal) {
            modal.style.display = 'none';
            if (onClose) onClose();
        }
    });
}

/**
 * Confirm action with user
 * @param {string} message - Confirmation message
 * @returns {Promise<boolean>} True if confirmed
 */
export async function confirmAction(message) {
    return confirm(message);
}

/**
 * Get user initials from name or email
 * @param {string} name - User name
 * @param {string} email - User email (fallback)
 * @returns {string} User initials
 */
export function getUserInitials(name, email) {
    if (name && name.length > 0) {
        return name[0].toUpperCase();
    }
    if (email && email.length > 0) {
        return email[0].toUpperCase();
    }
    return 'U';
}

/**
 * Export data as JSON file
 * @param {object} data - Data to export
 * @param {string} filename - Filename for download
 */
export function exportAsJSON(data, filename = 'export.json') {
    const dataStr = JSON.stringify(data, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}

/**
 * Copy text to clipboard
 * @param {string} text - Text to copy
 * @returns {Promise<boolean>} True if successful
 */
export async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (err) {
        console.error('Failed to copy to clipboard:', err);
        return false;
    }
}

// Export all utilities as default object for convenience
export default {
    impersonateUser,
    loadTicketReplies,
    populateTicketModal,
    showToast,
    escapeHtml,
    formatFileSize,
    debounce,
    setupModalCloseHandlers,
    confirmAction,
    getUserInitials,
    exportAsJSON,
    copyToClipboard
};
