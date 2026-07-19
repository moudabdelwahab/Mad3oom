import { supabase } from '/api-config.js';
import { checkAdminAuth, updateAdminUI } from './auth.js';
import { initSidebar } from './sidebar.js';
import { impersonateUser } from './admin-utils.js';

let user = null;

async function init() {
    initSidebar();
    user = await checkAdminAuth();
    if (!user) return;

    updateAdminUI(user);
    renderBannedUsers();
}

async function renderBannedUsers() {
    const body = document.getElementById('bannedBody');
    if (!body) return;

    const { data: users } = await supabase
        .from('profiles')
        .select('*')
        .eq('status', 'banned')
        .order('created_at', { ascending: false });

    body.innerHTML = users?.map(u => `
        <tr>
            <td>${u.full_name || 'بدون اسم'}</td>
            <td>${u.email}</td>
            <td><span class="status-badge status-danger">محظور</span></td>
            <td>${new Date(u.created_at).toLocaleDateString('ar-EG')}</td>
            <td>
                <button class="btn btn-primary btn-sm impersonate-btn" data-user-id="${u.id}">عرض</button>
                <button class="btn btn-success btn-sm unban-btn" data-user-id="${u.id}">إلغاء الحظر</button>
            </td>
        </tr>
    `).join('') || '<tr><td colspan="5" style="text-align: center; padding: 2rem;">لا يوجد مستخدمين محظورين</td></tr>';

    document.querySelectorAll('.impersonate-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const userId = btn.getAttribute('data-user-id');
            await impersonateUser(userId);
        });
    });

    document.querySelectorAll('.unban-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const userId = btn.getAttribute('data-user-id');
            if (confirm('هل أنت متأكد من إلغاء حظر هذا المستخدم؟')) {
                await supabase.from('profiles').update({ status: 'active' }).eq('id', userId);
                renderBannedUsers();
            }
        });
    });
}

init();
