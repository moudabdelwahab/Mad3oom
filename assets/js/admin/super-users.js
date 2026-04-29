import { supabase } from '/api-config.js';
import { checkAdminAuth, updateAdminUI } from './auth.js';
import { initSidebar } from './sidebar.js';

let currentUser = null;
let selectedUserId = null;

async function init() {
    initSidebar();
    currentUser = await checkAdminAuth();
    if (!currentUser) return;

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

    // جلب المسؤولين (super_user و admin)
    const { data: admins, error: adminError } = await supabase
        .from('profiles')
        .select('*')
        .in('role', ['super_user', 'admin'])
        .order('created_at', { ascending: false });

    if (adminError) {
        body.innerHTML = `<tr><td colspan="5">خطأ في جلب البيانات: ${adminError.message}</td></tr>`;
        return;
    }

    // جلب المستخدمين التابعين
    const adminIds = admins.map(u => u.id);
    const { data: subUsers } = await supabase
        .from('profiles')
        .select('*')
        .in('super_user_id', adminIds);

    const subUsersMap = {};
    subUsers?.forEach(u => {
        if (!subUsersMap[u.super_user_id]) subUsersMap[u.super_user_id] = [];
        subUsersMap[u.super_user_id].push(u);
    });

    let html = '';
    admins.forEach(admin => {
        const roleBadge = admin.role === 'super_user' ? 'badge-super' : 'badge-admin';
        const roleText = admin.role === 'super_user' ? 'مسؤول' : 'إدارة';
        
        html += `
            <tr class="hierarchy-row">
                <td><strong>👤 ${admin.full_name || admin.username || 'مسؤول'}</strong></td>
                <td>${admin.email}</td>
                <td><span class="status-badge ${roleBadge}">${roleText}</span></td>
                <td>${new Date(admin.created_at).toLocaleDateString('ar-EG')}</td>
                <td>
                    <div class="btn-group">
                        <button class="btn btn-info btn-xs details-btn" data-id="${admin.id}">التفاصيل</button>
                        <button class="btn btn-primary btn-xs users-btn" data-id="${admin.id}">المستخدمين</button>
                        <button class="btn btn-warning btn-xs role-btn" data-id="${admin.id}" data-role="${admin.role}">الرتبة</button>
                        <button class="btn btn-success btn-xs points-btn" data-id="${admin.id}">النقاط</button>
                        <button class="btn btn-danger btn-xs demote-btn" data-id="${admin.id}">إلغاء</button>
                    </div>
                </td>
            </tr>
        `;

        const mySubs = subUsersMap[admin.id] || [];
        if (mySubs.length > 0) {
            mySubs.forEach(sub => {
                html += `
                    <tr>
                        <td class="sub-user-row">└─ ${sub.full_name || sub.username || 'مستخدم تابع'}</td>
                        <td>${sub.email}</td>
                        <td><span class="status-badge status-customer">مستخدم تابع</span></td>
                        <td>${new Date(sub.created_at).toLocaleDateString('ar-EG')}</td>
                        <td>
                            <button class="btn btn-secondary btn-xs remove-sub-btn" data-id="${sub.id}">فك الارتباط</button>
                        </td>
                    </tr>
                `;
            });
        }
    });

    body.innerHTML = html || '<tr><td colspan="5" style="text-align:center; padding:2rem;">لا يوجد مسؤولين حالياً</td></tr>';
    bindActionButtons();
}

function setupEventListeners() {
    // إضافة مسؤول
    document.getElementById('confirmSuperUserBtn').addEventListener('click', async () => {
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

        if (updateError) alert('خطأ: ' + updateError.message);
        else {
            alert('تمت الترقية بنجاح');
            document.getElementById('superUserModal').style.display = 'none';
            renderHierarchy();
        }
    });

    // حفظ الـ IP
    document.getElementById('saveIpBtn').addEventListener('click', async () => {
        const ip = document.getElementById('allowedIpInput').value.trim();
        const { error } = await supabase
            .from('profiles')
            .update({ allowed_ip: ip || null })
            .eq('id', selectedUserId);

        if (error) alert('خطأ في حفظ الـ IP: ' + error.message);
        else {
            alert('تم حفظ إعدادات الـ IP بنجاح');
            document.getElementById('detailsModal').style.display = 'none';
        }
    });

    // تحديث الرتبة
    document.getElementById('confirmRoleBtn').addEventListener('click', async () => {
        const newRole = document.getElementById('roleSelect').value;
        const { error } = await supabase
            .from('profiles')
            .update({ role: newRole })
            .eq('id', selectedUserId);

        if (error) alert('خطأ في تحديث الرتبة: ' + error.message);
        else {
            alert('تم تحديث الرتبة بنجاح');
            document.getElementById('roleModal').style.display = 'none';
            renderHierarchy();
        }
    });

    // إدارة النقاط
    document.getElementById('confirmPointsBtn').addEventListener('click', async () => {
        const amount = parseInt(document.getElementById('pointsAmountInput').value);
        const action = document.getElementById('pointsActionSelect').value;
        
        if (isNaN(amount)) return alert('يرجى إدخال رقم صحيح');

        const { data: profile } = await supabase.from('profiles').select('points, email').eq('id', selectedUserId).single();
        let newPoints = profile.points || 0;

        if (action === 'add') newPoints += amount;
        else if (action === 'deduct') newPoints = Math.max(0, newPoints - amount);
        else if (action === 'set') newPoints = amount;

        // محاولة استخدام RPC إذا كان متاحاً، وإلا التحديث المباشر
        const { error } = await supabase.from('profiles').update({ points: newPoints }).eq('id', selectedUserId);
        
        if (error) alert('خطأ في تحديث النقاط: ' + error.message);
        else {
            // تحديث المحفظة أيضاً
            await supabase.from('user_wallets').update({ 
                total_points: newPoints, 
                available_points: newPoints 
            }).eq('user_id', selectedUserId);
            
            alert('تم تحديث النقاط بنجاح');
            document.getElementById('pointsModal').style.display = 'none';
            renderHierarchy();
        }
    });

    // إغلاق المودال عند الضغط خارجها
    window.onclick = (event) => {
        if (event.target.classList.contains('modal')) {
            event.target.style.display = 'none';
        }
    };
    
    document.getElementById('addSuperUserBtn').addEventListener('click', () => {
        document.getElementById('superUserModal').style.display = 'flex';
    });
    
    document.getElementById('cancelBtn').addEventListener('click', () => {
        document.getElementById('superUserModal').style.display = 'none';
    });
}

function bindActionButtons() {
    // التفاصيل
    document.querySelectorAll('.details-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            selectedUserId = btn.dataset.id;
            const { data: u } = await supabase.from('profiles').select('*').eq('id', selectedUserId).single();
            
            const content = `
                <div class="info-grid">
                    <div class="info-item"><span class="info-label">الاسم</span><div class="info-value">${u.full_name || 'غير محدد'}</div></div>
                    <div class="info-item"><span class="info-label">اسم المستخدم</span><div class="info-value">${u.username || 'غير محدد'}</div></div>
                    <div class="info-item"><span class="info-label">تاريخ التسجيل</span><div class="info-value">${new Date(u.created_at).toLocaleDateString('ar-EG')}</div></div>
                    <div class="info-item"><span class="info-label">آخر ظهور</span><div class="info-value">${u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString('ar-EG') : 'غير متوفر'}</div></div>
                    <div class="info-item"><span class="info-label">عنوان IP الحالي</span><div class="info-value">${u.last_ip || 'غير مسجل'}</div></div>
                    <div class="info-item"><span class="info-label">الحالة</span><div class="info-value">${u.status === 'banned' ? 'محظور' : 'نشط'}</div></div>
                </div>
            `;
            document.getElementById('detailsContent').innerHTML = content;
            document.getElementById('allowedIpInput').value = u.allowed_ip || '';
            document.getElementById('detailsModal').style.display = 'flex';
        });
    });

    // المستخدمين التابعين
    document.querySelectorAll('.users-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            // التوجيه لصفحة المستخدمين مع فلتر للمسؤول
            window.location.href = `/admin/my-users.html?admin_id=${btn.dataset.id}`;
        });
    });

    // الرتبة
    document.querySelectorAll('.role-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            selectedUserId = btn.dataset.id;
            document.getElementById('roleSelect').value = btn.dataset.role;
            document.getElementById('roleModal').style.display = 'flex';
        });
    });

    // النقاط
    document.querySelectorAll('.points-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            selectedUserId = btn.dataset.id;
            const { data: u } = await supabase.from('profiles').select('points').eq('id', selectedUserId).single();
            document.getElementById('currentPointsDisplay').textContent = `${u.points || 0} نقطة`;
            document.getElementById('pointsAmountInput').value = '';
            document.getElementById('pointsModal').style.display = 'flex';
        });
    });

    // إلغاء الترقية
    document.querySelectorAll('.demote-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (confirm('هل أنت متأكد من إلغاء صلاحيات هذا المسؤول؟')) {
                const { error } = await supabase.from('profiles').update({ role: 'customer' }).eq('id', btn.dataset.id);
                if (error) alert(error.message);
                else renderHierarchy();
            }
        });
    });

    // فك الارتباط
    document.querySelectorAll('.remove-sub-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (confirm('هل أنت متأكد من فك ارتباط هذا المستخدم؟')) {
                const { error } = await supabase.from('profiles').update({ super_user_id: null }).eq('id', btn.dataset.id);
                if (error) alert(error.message);
                else renderHierarchy();
            }
        });
    });
}

init();
