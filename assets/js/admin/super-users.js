import { supabase } from '/api-config.js';
import { checkAdminAuth, updateAdminUI } from './auth.js';
import { initSidebar } from './sidebar.js';

let currentUser = null;
let selectedUserId = null;
let selectedAdminId = null;

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
            document.getElementById('superUserEmail').value = '';
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

        const { error } = await supabase.from('profiles').update({ points: newPoints }).eq('id', selectedUserId);
        
        if (error) alert('خطأ في تحديث النقاط: ' + error.message);
        else {
            await supabase.from('user_wallets').update({ 
                total_points: newPoints, 
                available_points: newPoints 
            }).eq('user_id', selectedUserId);
            
            alert('تم تحديث النقاط بنجاح');
            document.getElementById('pointsModal').style.display = 'none';
            renderHierarchy();
        }
    });

    // إضافة مستخدم تابع
    document.getElementById('confirmAddSubUserBtn').addEventListener('click', async () => {
        const fullName = document.getElementById('subUserFullName').value.trim();
        const email = document.getElementById('subUserEmail').value.trim();
        const password = document.getElementById('subUserPassword').value.trim();

        if (!fullName || !email || !password) return alert('يرجى ملء جميع الحقول');

        const btn = document.getElementById('confirmAddSubUserBtn');
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'جاري الإنشاء...';

        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) {
                alert('جلسة منتهية، يرجى تسجيل الدخول مجدداً');
                btn.disabled = false;
                btn.textContent = originalText;
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
                        full_name: fullName,
                        super_user_id: selectedAdminId
                    })
                }
            );

            const result = await response.json();

            if (!response.ok) {
                alert('خطأ في إنشاء الحساب: ' + (result.error || 'خطأ غير معروف'));
            } else {
                alert('تم إنشاء حساب المستخدم بنجاح');
                document.getElementById('subUserFullName').value = '';
                document.getElementById('subUserEmail').value = '';
                document.getElementById('subUserPassword').value = '';
                document.getElementById('addSubUserModal').style.display = 'none';
                renderSubUsersInModal();
            }
        } catch (error) {
            console.error('Error:', error);
            alert('خطأ: ' + error.message);
        } finally {
            btn.disabled = false;
            btn.textContent = originalText;
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

    // فتح نافذة إضافة مستخدم تابع
    document.addEventListener('click', (e) => {
        if (e.target.id === 'addSubUserBtn') {
            document.getElementById('addSubUserModal').style.display = 'flex';
        }
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
        btn.addEventListener('click', async () => {
            selectedAdminId = btn.dataset.id;
            const { data: adminProfile } = await supabase.from('profiles').select('full_name').eq('id', selectedAdminId).single();
            
            // تحديث عنوان النافذة
            const modalTitle = document.querySelector('#usersModal .modal-title');
            if (modalTitle) modalTitle.textContent = `المستخدمين التابعين - ${adminProfile.full_name}`;
            
            document.getElementById('usersModal').style.display = 'flex';
            renderSubUsersInModal();
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

async function renderSubUsersInModal() {
    const body = document.getElementById('subUsersTableBody');
    if (!body) return;

    const { data: users, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('super_user_id', selectedAdminId)
        .order('created_at', { ascending: false });

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
                    <button class="btn btn-primary btn-xs sub-view-btn" data-id="${u.id}">عرض</button>
                    <button class="btn btn-warning btn-xs sub-points-btn" data-id="${u.id}">النقاط</button>
                    <button class="btn btn-danger btn-xs sub-delete-btn" data-id="${u.id}">حذف</button>
                </div>
            </td>
        </tr>
    `).join('') || '<tr><td colspan="4" style="text-align: center; padding: 2rem;">لا يوجد مستخدمين تابعين</td></tr>';

    bindSubUserActions();
}

function bindSubUserActions() {
    // عرض المستخدم
    document.querySelectorAll('.sub-view-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const userId = btn.dataset.id;
            const { adminImpersonateUser } = await import('/auth-client.js');
            await adminImpersonateUser(userId);
            window.location.href = '/customer-dashboard.html';
        });
    });

    // إدارة النقاط
    document.querySelectorAll('.sub-points-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            selectedUserId = btn.dataset.id;
            const { data: u } = await supabase.from('profiles').select('points, full_name').eq('id', selectedUserId).single();
            
            // فتح نافذة النقاط مع تحديث العنوان
            const modalTitle = document.querySelector('#pointsModal .modal-title');
            if (modalTitle) modalTitle.textContent = `إدارة النقاط - ${u.full_name}`;
            
            document.getElementById('currentPointsDisplay').textContent = `${u.points || 0} نقطة`;
            document.getElementById('pointsAmountInput').value = '';
            document.getElementById('pointsModal').style.display = 'flex';
        });
    });

    // حذف المستخدم
    document.querySelectorAll('.sub-delete-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (confirm('هل أنت متأكد من حذف هذا المستخدم؟ لا يمكن التراجع عن هذا الإجراء.')) {
                const { error } = await supabase.from('profiles').delete().eq('id', btn.dataset.id);
                if (error) alert('خطأ في الحذف: ' + error.message);
                else renderSubUsersInModal();
            }
        });
    });
}

init();
