import { supabase } from '/api-config.js';
import { checkAdminAuth, updateAdminUI } from './auth.js';
import { initSidebar } from './sidebar.js';
import { adminImpersonateUser } from '/auth-client.js';

let user = null;
let currentOptionsUserId = null;

function roleLabel(role) {
    if (role === 'admin') return 'مدير';
    if (role === 'super_user') return 'مستخدم مميز';
    return 'مستخدم';
}

async function init() {
    initSidebar();
    user = await checkAdminAuth();
    if (!user) return;

    updateAdminUI(user);
    injectOptionsPanel();
    renderUsers();

    // تفعيل التحديث اللحظي لجدول المستخدمين
    supabase
        .channel('public:profiles')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => {
            console.log('Profiles updated, re-rendering...');
            renderUsers();
        })
        .subscribe();
}

// إنشاء النافذة المنزلقة (Action Sheet) مرة واحدة في الصفحة
function injectOptionsPanel() {
    const overlay = document.createElement('div');
    overlay.className = 'options-overlay';
    overlay.id = 'optionsOverlay';

    const panel = document.createElement('div');
    panel.className = 'options-panel';
    panel.id = 'optionsPanel';
    panel.innerHTML = `
        <div class="options-panel-handle"></div>
        <div class="options-panel-header">
            <div class="opt-user-name" id="optUserName"></div>
            <div class="opt-user-email" id="optUserEmail"></div>
        </div>
        <div class="options-panel-body">
            <button class="option-row-btn danger" id="optBanBtn">
                <span>حظر المستخدم</span>
                <span class="opt-icon">🚫</span>
            </button>

            <div class="options-group-label">تغيير الصلاحية</div>
            <button class="option-row-btn" id="optRoleUser" data-role="user">
                <span>عضو</span>
                <span class="opt-icon">👤</span>
            </button>
            <button class="option-row-btn" id="optRoleSuper" data-role="super_user">
                <span>Super User</span>
                <span class="opt-icon">⭐</span>
            </button>
            <button class="option-row-btn" id="optRoleAdmin" data-role="admin">
                <span>Admin</span>
                <span class="opt-icon">👑</span>
            </button>
        </div>
    `;

    document.body.appendChild(overlay);
    document.body.appendChild(panel);

    overlay.addEventListener('click', closeOptionsPanel);

    // ملحوظة: تنفيذ الحظر/تغيير الصلاحية لمستخدم آخر مقصور على حساب
    // support@mad3oom.online فقط حسب سياسات RLS الحالية في Supabase.
    // أي حساب admin عادي هياخد خطأ صلاحية لو جرّب يستخدم الأزرار دي على مستخدم تحت إدارة حد تاني.

    document.getElementById('optBanBtn').addEventListener('click', async () => {
        if (!currentOptionsUserId) return;
        if (confirm('هل أنت متأكد من حظر هذا المستخدم؟')) {
            const { error } = await supabase.from('profiles').update({ status: 'banned' }).eq('id', currentOptionsUserId);
            if (error) alert('خطأ في الحظر: ' + error.message);
            else { closeOptionsPanel(); renderUsers(); }
        }
    });

    ['optRoleUser', 'optRoleSuper', 'optRoleAdmin'].forEach(id => {
        document.getElementById(id).addEventListener('click', async (e) => {
            const newRole = e.currentTarget.getAttribute('data-role');
            if (!currentOptionsUserId) return;
            const labels = { user: 'عضو', super_user: 'Super User', admin: 'Admin' };
            if (confirm(`هل أنت متأكد من تغيير صلاحية هذا المستخدم إلى "${labels[newRole]}"؟`)) {
                const { error } = await supabase.from('profiles').update({ role: newRole }).eq('id', currentOptionsUserId);
                if (error) alert('خطأ في تغيير الصلاحية: ' + error.message);
                else { closeOptionsPanel(); renderUsers(); }
            }
        });
    });
}

function openOptionsPanel(userId, name, email, currentRole) {
    currentOptionsUserId = userId;
    document.getElementById('optUserName').textContent = name || 'بدون اسم';
    document.getElementById('optUserEmail').textContent = email || '';

    document.querySelectorAll('#optionsPanel .option-row-btn[data-role]').forEach(btn => {
        btn.classList.toggle('role-active', btn.getAttribute('data-role') === currentRole);
    });

    document.getElementById('optionsOverlay').classList.add('active');
    document.getElementById('optionsPanel').classList.add('active');
}

function closeOptionsPanel() {
    currentOptionsUserId = null;
    document.getElementById('optionsOverlay').classList.remove('active');
    document.getElementById('optionsPanel').classList.remove('active');
}

async function renderUsers() {
    const body = document.getElementById('usersBody');
    if (!body) return;

    const { data: users } = await supabase
        .from('profiles')
        .select('*')
        .order('created_at', { ascending: false });

    // Fetch wallet status for freezing info
    const { data: wallets } = await supabase.from('user_wallets').select('user_id, is_frozen');
    const walletMap = new Map(wallets?.map(w => [w.user_id, w.is_frozen]) || []);

    body.innerHTML = users?.map(u => {
        const isFrozen = walletMap.get(u.id) || false;
        const isSupport = user?.email === 'support@mad3oom.online';
        const safeName = (u.full_name || u.email || '').replace(/"/g, '&quot;');

        return `
        <tr>
            <td>${u.full_name || 'بدون اسم'}</td>
            <td>${u.email}</td>
            <td><span class="status-badge status-${u.role}">${roleLabel(u.role)}</span></td>
            <td>${new Date(u.created_at).toLocaleDateString('ar-EG')}</td>
            <td>
                <div style="display: flex; gap: 5px;">
                    <button class="btn btn-secondary btn-sm options-btn" data-user-id="${u.id}" data-user-name="${safeName}" data-user-email="${u.email}" data-user-role="${u.role}">خيارات</button>
                    <button class="btn btn-warning btn-sm points-btn" data-user-id="${u.id}" data-user-name="${u.full_name || u.email}">النقاط</button>
                    ${isSupport ? `<button class="btn btn-sm freeze-btn ${isFrozen ? 'btn-info' : 'btn-secondary'}" data-user-id="${u.id}" data-user-email="${u.email}" data-frozen="${isFrozen}">${isFrozen ? 'إلغاء التجميد' : 'تجميد'}</button>` : ''}
                    <button class="btn btn-primary btn-sm impersonate-btn" data-user-id="${u.id}">عرض</button>
                </div>
            </td>
        </tr>
    `}).join('') || '<tr><td colspan="5">لا يوجد مستخدمين</td></tr>';

    // ربط زر خيارات (يفتح النافذة المنزلقة)
    document.querySelectorAll('.options-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            openOptionsPanel(
                btn.getAttribute('data-user-id'),
                btn.getAttribute('data-user-name'),
                btn.getAttribute('data-user-email'),
                btn.getAttribute('data-user-role')
            );
        });
    });

    // ربط أزرار العرض
    document.querySelectorAll('.impersonate-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const userId = btn.getAttribute('data-user-id');
            await impersonateUser(userId);
        });
    });

    // ربط أزرار النقاط
    document.querySelectorAll('.points-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const userId = btn.getAttribute('data-user-id');
            const userName = btn.getAttribute('data-user-name');
            const newPoints = prompt(`إدخال النقاط الجديدة للمستخدم: ${userName}`);
            if (newPoints !== null) {
                const points = parseInt(newPoints);
                if (isNaN(points)) {
                    alert('يرجى إدخال رقم صحيح');
                    return;
                }

                const { error } = await supabase.from('profiles').update({ points: points }).eq('id', userId);
                if (error) alert('خطأ في تحديث النقاط: ' + error.message);
                else {
                    // تحديث المحفظة أيضاً لضمان التزامن
                    await supabase.from('user_wallets').update({ total_points: points, available_points: points }).eq('user_id', userId);
                    alert('تم تحديث النقاط بنجاح');
                    renderUsers();
                }
            }
        });
    });

    // ربط أزرار التجميد
    document.querySelectorAll('.freeze-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const userId = btn.getAttribute('data-user-id');
            const userEmail = btn.getAttribute('data-user-email');
            const isFrozen = btn.getAttribute('data-frozen') === 'true';
            const action = isFrozen ? 'unfreeze' : 'freeze';
            const actionLabel = isFrozen ? 'إلغاء تجميد' : 'تجميد';

            if (confirm(`هل أنت متأكد من ${actionLabel} رصيد هذا المستخدم؟`)) {
                const { data, error } = await supabase.rpc('manage_user_points', {
                    target_user_email: userEmail,
                    amount_change: 0,
                    action_type: action
                });

                if (error) alert('خطأ: ' + error.message);
                else {
                    alert(data.message);
                    renderUsers();
                }
            }
        });
    });
}

async function impersonateUser(id) { 
    const { data: targetUser } = await supabase.from('profiles').select('email').eq('id', id).single();
    const activityModule = await import('/activity-service.js');
    activityModule.logActivity('impersonate', { target_user_id: id, target_email: targetUser?.email });
    await adminImpersonateUser(id);
    location.href = '/customer-dashboard.html';
}

init();
