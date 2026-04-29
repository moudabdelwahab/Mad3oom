import { supabase } from '/api-config.js';
import { checkAdminAuth, updateAdminUI } from './auth.js';
import { initSidebar } from './sidebar.js';
import { adminImpersonateUser } from '/auth-client.js';

let currentUser = null;

async function init() {
    initSidebar();
    currentUser = await checkAdminAuth();
    if (!currentUser) return;

    updateAdminUI(currentUser);
    renderSubUsers();
    setupEventListeners();
}

async function renderSubUsers() {
    const body = document.getElementById('subUsersBody');
    if (!body) return;

    // التحقق من وجود admin_id في الرابط (للفلترة عند القدوم من صفحة إدارة المسؤولين)
    const urlParams = new URLSearchParams(window.location.search);
    const filterAdminId = urlParams.get('admin_id');

    // جلب المستخدمين التابعين
    let query = supabase.from('profiles').select('*');
    
    if (filterAdminId) {
        // إذا كان هناك فلتر، نجلب المستخدمين التابعين لهذا المسؤول المحدد
        query = query.eq('super_user_id', filterAdminId);
        
        // تحديث عنوان الصفحة الفرعي ليوضح الفلتر
        const { data: adminProfile } = await supabase.from('profiles').select('full_name').eq('id', filterAdminId).single();
        if (adminProfile) {
            const headerP = document.querySelector('.page-header p');
            if (headerP) headerP.textContent = `عرض المستخدمين التابعين للمسؤول: ${adminProfile.full_name}`;
        }
    } else if (currentUser.profile.role !== 'admin') {
        // إذا لم يكن هناك فلتر وكان المستخدم الحالي ليس أدمن رئيسي، يرى مستخدميه فقط
        query = query.eq('super_user_id', currentUser.id);
    }

    const { data: users, error } = await query.order('created_at', { ascending: false });

    if (error) {
        body.innerHTML = `<tr><td colspan="4">خطأ: ${error.message}</td></tr>`;
        return;
    }

    body.innerHTML = users?.map(u => `
        <tr>
            <td>${u.full_name || u.username || 'بدون اسم'}</td>
            <td>${u.email}</td>
            <td>${new Date(u.created_at).toLocaleDateString('ar-EG')}</td>
            <td>
                <div style="display: flex; gap: 5px;">
                    <button class="btn btn-primary btn-sm view-btn" data-id="${u.id}">عرض</button>
                    <button class="btn btn-danger btn-sm delete-btn" data-id="${u.id}">حذف</button>
                </div>
            </td>
        </tr>
    `).join('') || '<tr><td colspan="4">لا يوجد مستخدمين تابعين حالياً</td></tr>';

    bindActionButtons();
}

function setupEventListeners() {
    const modal = document.getElementById('subUserModal');
    const addBtn = document.getElementById('addSubUserBtn');
    const cancelBtn = document.getElementById('cancelSubBtn');
    const confirmBtn = document.getElementById('confirmAddSubBtn');

    if (addBtn) addBtn.addEventListener('click', () => modal.style.display = 'flex');
    if (cancelBtn) cancelBtn.addEventListener('click', () => modal.style.display = 'none');

    if (confirmBtn) {
        confirmBtn.addEventListener('click', async () => {
            const fullName = document.getElementById('subFullName').value.trim();
            const email = document.getElementById('subEmail').value.trim();
            const password = document.getElementById('subPassword').value.trim();

            if (!fullName || !email || !password) return alert('يرجى ملء جميع الحقول');

            const originalText = confirmBtn.textContent;
            confirmBtn.disabled = true;
            confirmBtn.textContent = 'جاري الإنشاء...';

            try {
                const { data: { session } } = await supabase.auth.getSession();
                if (!session) {
                    alert('جلسة منتهية، يرجى تسجيل الدخول مجدداً');
                    confirmBtn.disabled = false;
                    confirmBtn.textContent = originalText;
                    return;
                }

                const response = await fetch(
                    `${supabase.supabaseUrl}/functions/v1/create-sub-user`,
                    {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${session.access_token}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            email,
                            password,
                            full_name: fullName
                        })
                    }
                );

                const result = await response.json();

                if (!response.ok) {
                    alert('خطأ في إنشاء الحساب: ' + (result.error || 'خطأ غير معروف'));
                } else {
                    alert('تم إنشاء حساب المستخدم بنجاح');
                    document.getElementById('subFullName').value = '';
                    document.getElementById('subEmail').value = '';
                    document.getElementById('subPassword').value = '';
                    modal.style.display = 'none';
                    renderSubUsers();
                }
            } catch (error) {
                console.error('Error:', error);
                alert('خطأ: ' + error.message);
            } finally {
                confirmBtn.disabled = false;
                confirmBtn.textContent = originalText;
            }
        });
    }
}

function bindActionButtons() {
    document.querySelectorAll('.view-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            await adminImpersonateUser(btn.dataset.id);
            location.href = '/customer-dashboard.html';
        });
    });

    document.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (confirm('هل أنت متأكد من حذف هذا المستخدم؟ لا يمكن التراجع عن هذا الإجراء.')) {
                const { error } = await supabase.from('profiles').delete().eq('id', btn.dataset.id);
                if (error) alert('خطأ في الحذف: ' + error.message);
                else renderSubUsers();
            }
        });
    });
}

init();
