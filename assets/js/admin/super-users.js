import { supabase } from '/api-config.js';
import { checkAdminAuth, updateAdminUI } from './auth.js';
import { initSidebar } from './sidebar.js';

let currentUser = null;

async function init() {
    initSidebar();
    currentUser = await checkAdminAuth();
    if (!currentUser) return;

    // التحقق من أن المستخدم هو الأدمن الرئيسي support@mad3oom.online
    const isMainAdmin = currentUser.email === 'support@mad3oom.online';
    if (!isMainAdmin) {
        alert('عذراً، هذه الصفحة مخصصة للأدمن الرئيسي فقط.');
        window.location.href = '/admin-dashboard.html';
        return;
    }

    updateAdminUI(currentUser);
    renderHierarchy();
    setupEventListeners();
}

async function renderHierarchy() {
    const body = document.getElementById('hierarchyBody');
    if (!body) return;

    // جلب كل الـ Super Users (المستخدمين الذين لديهم role = 'super_user')
    const { data: superUsers, error: superError } = await supabase
        .from('profiles')
        .select('*')
        .eq('role', 'super_user')
        .order('created_at', { ascending: false });

    if (superError) {
        body.innerHTML = `<tr><td colspan="5">خطأ في جلب البيانات: ${superError.message}</td></tr>`;
        return;
    }

    if (!superUsers || superUsers.length === 0) {
        body.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:2rem;">لا يوجد Super Users حالياً</td></tr>';
        return;
    }

    // جلب كل المستخدمين التابعين لهؤلاء الـ Super Users
    const superUserIds = superUsers.map(u => u.id);
    const { data: subUsers, error: subError } = await supabase
        .from('profiles')
        .select('*')
        .in('super_user_id', superUserIds);

    const subUsersMap = {};
    subUsers?.forEach(u => {
        if (!subUsersMap[u.super_user_id]) subUsersMap[u.super_user_id] = [];
        subUsersMap[u.super_user_id].push(u);
    });

    let html = '';
    superUsers.forEach(su => {
        // صف الـ Super User
        html += `
            <tr class="hierarchy-row">
                <td><strong>⭐ ${su.full_name || su.username || 'Super User'}</strong></td>
                <td>${su.email}</td>
                <td><span class="status-badge badge-super">Super User</span></td>
                <td>${new Date(su.created_at).toLocaleDateString('ar-EG')}</td>
                <td>
                    <button class="btn btn-danger btn-sm demote-btn" data-id="${su.id}">إلغاء الترقية</button>
                </td>
            </tr>
        `;

        // صفوف المستخدمين التابعين
        const mySubs = subUsersMap[su.id] || [];
        if (mySubs.length > 0) {
            mySubs.forEach(sub => {
                html += `
                    <tr>
                        <td class="sub-user-row">└─ ${sub.full_name || sub.username || 'مستخدم تابع'}</td>
                        <td>${sub.email}</td>
                        <td><span class="status-badge status-customer">مستخدم تابع</span></td>
                        <td>${new Date(sub.created_at).toLocaleDateString('ar-EG')}</td>
                        <td>
                            <button class="btn btn-secondary btn-sm remove-sub-btn" data-id="${sub.id}">فك الارتباط</button>
                        </td>
                    </tr>
                `;
            });
        } else {
            html += `
                <tr>
                    <td colspan="5" class="sub-user-row" style="color:var(--color-text-secondary); font-style:italic;">لا يوجد مستخدمين تابعين حالياً</td>
                </tr>
            `;
        }
    });

    body.innerHTML = html;
    bindActionButtons();
}

function setupEventListeners() {
    const modal = document.getElementById('superUserModal');
    const addBtn = document.getElementById('addSuperUserBtn');
    const cancelBtn = document.getElementById('cancelBtn');
    const confirmBtn = document.getElementById('confirmSuperUserBtn');

    addBtn.addEventListener('click', () => modal.style.display = 'flex');
    cancelBtn.addEventListener('click', () => modal.style.display = 'none');
    
    confirmBtn.addEventListener('click', async () => {
        const email = document.getElementById('superUserEmail').value.trim();
        if (!email) return alert('يرجى إدخال البريد الإلكتروني');

        const { data: targetUser, error: findError } = await supabase
            .from('profiles')
            .select('id')
            .eq('email', email)
            .single();

        if (findError || !targetUser) return alert('المستخدم غير موجود');

        const { error: updateError } = await supabase
            .from('profiles')
            .update({ role: 'super_user' })
            .eq('id', targetUser.id);

        if (updateError) alert('خطأ في الترقية: ' + updateError.message);
        else {
            alert('تمت ترقية المستخدم إلى Super User بنجاح');
            modal.style.display = 'none';
            renderHierarchy();
        }
    });
}

function bindActionButtons() {
    document.querySelectorAll('.demote-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            if (confirm('هل أنت متأكد من إلغاء ترقية هذا الـ Super User؟ سيفقد التحكم في مستخدميه.')) {
                const { error } = await supabase.from('profiles').update({ role: 'customer' }).eq('id', id);
                if (error) alert(error.message);
                else renderHierarchy();
            }
        });
    });

    document.querySelectorAll('.remove-sub-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            if (confirm('هل أنت متأكد من فك ارتباط هذا المستخدم بالـ Super User؟')) {
                const { error } = await supabase.from('profiles').update({ super_user_id: null }).eq('id', id);
                if (error) alert(error.message);
                else renderHierarchy();
            }
        });
    });
}

init();
