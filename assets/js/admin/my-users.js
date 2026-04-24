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

    // جلب المستخدمين التابعين لهذا الـ Super User (أو كل المستخدمين إذا كان أدمن رئيسي)
    let query = supabase.from('profiles').select('*');
    
    if (currentUser.profile.role !== 'admin') {
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

    addBtn.addEventListener('click', () => modal.style.display = 'flex');
    cancelBtn.addEventListener('click', () => modal.style.display = 'none');

    confirmBtn.addEventListener('click', async () => {
        const fullName = document.getElementById('subFullName').value.trim();
        const email = document.getElementById('subEmail').value.trim();
        const password = document.getElementById('subPassword').value.trim();

        if (!fullName || !email || !password) return alert('يرجى ملء جميع الحقول');

        // إنشاء الحساب عبر Supabase Auth
        // ملاحظة: في بيئة الإنتاج، يفضل استخدام Edge Function لإنشاء المستخدمين لتجنب تسجيل خروج الأدمن الحالي
        // لكن هنا سنستخدم signUp مع metadata
        const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: {
                data: {
                    full_name: fullName,
                    super_user_id: currentUser.id,
                    role: 'customer'
                }
            }
        });

        if (error) alert('خطأ في إنشاء الحساب: ' + error.message);
        else {
            // تحديث البروفايل لربطه بالـ Super User يدوياً لضمان الدقة
            await supabase.from('profiles').update({ 
                full_name: fullName,
                super_user_id: currentUser.id 
            }).eq('id', data.user.id);

            alert('تم إنشاء حساب المستخدم بنجاح');
            modal.style.display = 'none';
            renderSubUsers();
        }
    });
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
                // في Supabase، حذف المستخدم من Auth يتطلب Admin API
                // هنا سنقوم فقط بتعطيله أو حذفه من جدول profiles إذا سمحت الـ RLS
                const { error } = await supabase.from('profiles').delete().eq('id', btn.dataset.id);
                if (error) alert('خطأ في الحذف: ' + error.message);
                else renderSubUsers();
            }
        });
    });
}

init();
