import { supabase } from '/api-config.js';
import { checkAdminAuth, updateAdminUI } from './auth.js';
import { initSidebar } from './sidebar.js';
import { fetchActivityLogs, formatActivityMessage } from '/activity-service.js';

let user = null;

async function init() {
    initSidebar();
    user = await checkAdminAuth();
    if (!user) return;

    updateAdminUI(user);
    renderActivityLog();
}

async function renderActivityLog() {
    const body = document.getElementById('activityBody');
    if (!body) return;

    try {
        const activities = await fetchActivityLogs({}, 100);

        if (!activities || activities.length === 0) {
            body.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 2rem;">لا توجد سجلات نشاط</td></tr>';
            return;
        }

        body.innerHTML = activities.map(a => {
            const userName = a.profiles?.full_name || 'مستخدم غير معروف';
            const userEmail = a.profiles?.email || '';
            const activityMsg = formatActivityMessage(a);
            const date = new Date(a.created_at).toLocaleString('ar-EG');
            
            // تحديد لون الشارة بناءً على نوع الإجراء
            let badgeClass = 'status-pending';
            if (a.action.includes('login')) badgeClass = 'status-active';
            if (a.action.includes('ban') || a.action.includes('delete')) badgeClass = 'status-banned';

            return `
                <tr>
                    <td>
                        <div style="font-weight: 600;">${userName}</div>
                        <div style="font-size: 0.8rem; color: var(--color-text-secondary);">${userEmail}</div>
                    </td>
                    <td><span class="status-badge ${badgeClass}">${a.action}</span></td>
                    <td>
                        <div style="font-size: 0.9rem; margin-bottom: 0.5rem;">${activityMsg}</div>
                        <details style="font-size: 0.75rem; color: var(--color-text-secondary);">
                            <summary style="cursor: pointer; color: var(--color-heading);">التفاصيل التقنية</summary>
                            <pre style="margin-top: 0.5rem; white-space: pre-wrap; word-break: break-all; background: #f8f9fa; padding: 0.5rem; border-radius: 4px;">${JSON.stringify(a.details, null, 2)}</pre>
                            <div style="margin-top: 0.5rem;">
                                <strong>الجهاز:</strong> ${a.device_info || 'غير معروف'}<br>
                                <strong>الموقع:</strong> ${a.location_info ? `${a.location_info.city || ''}, ${a.location_info.country || ''}` : 'غير معروف'}<br>
                                <strong>IP:</strong> ${a.ip_address || 'غير معروف'}
                            </div>
                        </details>
                    </td>
                    <td>${date}</td>
                </tr>
            `;
        }).join('');
    } catch (error) {
        console.error('Error rendering activity log:', error);
        body.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 2rem; color: red;">حدث خطأ أثناء تحميل البيانات. يرجى التأكد من صلاحيات الوصول.</td></tr>';
    }
}

init();
