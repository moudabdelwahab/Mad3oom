import { supabase } from '/api-config.js';
import { checkAdminAuth, updateAdminUI } from './auth.js';
import { initSidebar } from './sidebar.js';
import { impersonateUser } from './admin-utils.js';
import { isCurrentUserSieAdmin, getSieAccessStatus, adminSetAccess, adminResetUsage } from '/assets/js/sie-client.js';

let user = null;
let currentOptionsUserId = null;
let isSieAdmin = false; // من is_sie_admin() فقط — نفس القاعدة اللي هتتفرض في RLS/RPC، مفيش تكرار للشرط هنا
let currentSieAccess = null; // صف customer_sie_access الخاص بالمستخدم اللي فاتح له نافذة الخيارات دلوقتي

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
    isSieAdmin = await isCurrentUserSieAdmin(supabase);
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

// إنشاء النافذة المنزلقة (في نص الشاشة) مرة واحدة في الصفحة
function injectOptionsPanel() {
    const overlay = document.createElement('div');
    overlay.className = 'options-overlay';
    overlay.id = 'optionsOverlay';

    const panel = document.createElement('div');
    panel.className = 'options-panel';
    panel.id = 'optionsPanel';
    panel.innerHTML = `
        <div class="options-panel-header">
            <div class="opt-user-name" id="optUserName"></div>
            <div class="opt-user-email" id="optUserEmail"></div>
        </div>
        <div class="options-panel-body">
            <button class="option-row-btn danger" id="optBanBtn">
                <span>حظر المستخدم</span>
                <span class="opt-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.9" y1="4.9" x2="19.1" y2="19.1"/></svg>
                </span>
            </button>

            <div class="options-group-label">تغيير الصلاحية</div>
            <button class="option-row-btn" id="optRoleUser" data-role="user">
                <span>عضو</span>
                <span class="opt-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                </span>
            </button>
            <button class="option-row-btn" id="optRoleSuper" data-role="super_user">
                <span>Super User</span>
                <span class="opt-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                </span>
            </button>
            <button class="option-row-btn" id="optRoleAdmin" data-role="admin">
                <span>Admin</span>
                <span class="opt-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17h18l-1.5-9-4.5 5-3-7-3 7-4.5-5L3 17Z"/><path d="M5 21h14"/></svg>
                </span>
            </button>
        </div>

        <div class="options-group-label" id="sieSectionLabel" style="display:none;">محرك الدعم الذكي (SIE)</div>
        <div class="options-panel-body" id="sieSection" style="display:none;">
            <label class="sie-field">
                <span>تفعيل SIE لهذا العميل</span>
                <input type="checkbox" id="sieEnabledToggle">
            </label>

            <label class="sie-field">
                <span>نوع الحد</span>
                <select id="sieAccessMode">
                    <option value="unlimited">بدون حد (طالما مفعّل)</option>
                    <option value="quota">حد رسائل</option>
                    <option value="expiration">تاريخ انتهاء</option>
                </select>
            </label>

            <label class="sie-field" id="sieQuotaRow" style="display:none;">
                <span>حد الرسائل</span>
                <input type="number" id="sieMessageQuota" min="1" step="1">
            </label>

            <label class="sie-field" id="sieExpiryRow" style="display:none;">
                <span>تاريخ الانتهاء</span>
                <input type="datetime-local" id="sieExpiresAt">
            </label>

            <label class="sie-field">
                <span>ملاحظة (اختياري)</span>
                <input type="text" id="sieNotes" placeholder="سبب التفعيل مثلاً">
            </label>

            <div class="sie-usage" id="sieUsageDisplay">—</div>

            <div style="display:flex; gap:6px;">
                <button class="btn btn-primary btn-sm" id="sieSaveBtn">حفظ إعدادات SIE</button>
                <button class="btn btn-secondary btn-sm" id="sieResetUsageBtn">تصفير الاستخدام</button>
            </div>
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

            // حماية إضافية: Super User لا يقدر يغيّر رتبته الخاصة حتى لو فُتح الزر بأي طريقة
            const isSelf = !!user && currentOptionsUserId === user.id;
            if (isSelf && user?.profile?.role === 'super_user') return;

            const labels = { user: 'عضو', super_user: 'Super User', admin: 'Admin' };
            if (confirm(`هل أنت متأكد من تغيير صلاحية هذا المستخدم إلى "${labels[newRole]}"؟`)) {
                const { error } = await supabase.from('profiles').update({ role: newRole }).eq('id', currentOptionsUserId);
                if (error) alert('خطأ في تغيير الصلاحية: ' + error.message);
                else { closeOptionsPanel(); renderUsers(); }
            }
        });
    });

    // ===== قسم محرك الدعم الذكي (SIE) — الأزرار دي أصلاً مخفية عن أي حد
    // غير support@mad3oom.online (شوف openOptionsPanel)، لكن is_sie_admin()
    // في الـ RPC/RLS هي اللي بتمنع فعليًا، مش الإخفاء ده.
    document.getElementById('sieAccessMode').addEventListener('change', (e) => {
        const mode = e.target.value;
        document.getElementById('sieQuotaRow').style.display = mode === 'quota' ? '' : 'none';
        document.getElementById('sieExpiryRow').style.display = mode === 'expiration' ? '' : 'none';
    });

    document.getElementById('sieSaveBtn').addEventListener('click', async () => {
        if (!currentOptionsUserId) return;
        const isEnabled = document.getElementById('sieEnabledToggle').checked;
        const accessMode = document.getElementById('sieAccessMode').value;
        const quotaRaw = document.getElementById('sieMessageQuota').value;
        const expiryRaw = document.getElementById('sieExpiresAt').value;
        const notes = document.getElementById('sieNotes').value.trim() || null;

        const messageQuota = accessMode === 'quota' && quotaRaw ? parseInt(quotaRaw, 10) : null;
        const expiresAt = accessMode === 'expiration' && expiryRaw ? new Date(expiryRaw).toISOString() : null;

        if (accessMode === 'quota' && (!messageQuota || messageQuota < 1)) {
            alert('من فضلك أدخل حد رسائل صحيح (رقم أكبر من صفر)');
            return;
        }
        if (accessMode === 'expiration' && !expiresAt) {
            alert('من فضلك اختر تاريخ انتهاء');
            return;
        }

        const { error } = await adminSetAccess(supabase, {
            userId: currentOptionsUserId,
            isEnabled,
            accessMode,
            messageQuota,
            expiresAt,
            notes
        });

        if (error) alert('خطأ في حفظ إعدادات SIE: ' + error.message);
        else {
            alert('تم حفظ إعدادات SIE');
            await loadSieAccessIntoPanel(currentOptionsUserId);
        }
    });

    document.getElementById('sieResetUsageBtn').addEventListener('click', async () => {
        if (!currentOptionsUserId) return;
        if (!confirm('تصفير عداد الاستخدام لهذا العميل؟')) return;
        const { error } = await adminResetUsage(supabase, currentOptionsUserId);
        if (error) alert('خطأ في تصفير الاستخدام: ' + error.message);
        else await loadSieAccessIntoPanel(currentOptionsUserId);
    });
}

/**
 * يجيب صف customer_sie_access الحالي للعميل ده ويملأ بيه قسم SIE في النافذة.
 * بيتنادى أول ما النافذة تتفتح، وتاني كل مرة الأدمن يحفظ/يصفّر عشان القيم المعروضة تفضل حقيقية.
 */
async function loadSieAccessIntoPanel(userId) {
    currentSieAccess = await getSieAccessStatus(supabase, userId);

    const enabled = currentSieAccess?.is_enabled || false;
    const mode = currentSieAccess?.access_mode || 'unlimited';

    document.getElementById('sieEnabledToggle').checked = enabled;
    document.getElementById('sieAccessMode').value = mode;
    document.getElementById('sieMessageQuota').value = currentSieAccess?.message_quota ?? '';
    document.getElementById('sieExpiresAt').value = currentSieAccess?.expires_at
        ? new Date(currentSieAccess.expires_at).toISOString().slice(0, 16)
        : '';
    document.getElementById('sieNotes').value = currentSieAccess?.notes || '';
    document.getElementById('sieQuotaRow').style.display = mode === 'quota' ? '' : 'none';
    document.getElementById('sieExpiryRow').style.display = mode === 'expiration' ? '' : 'none';

    const usageEl = document.getElementById('sieUsageDisplay');
    if (!currentSieAccess) {
        usageEl.textContent = 'لسه معملوش تفعيل لهذا العميل';
    } else if (mode === 'quota') {
        usageEl.textContent = `الاستخدام: ${currentSieAccess.messages_used} / ${currentSieAccess.message_quota}`;
    } else if (mode === 'expiration') {
        usageEl.textContent = `رسايل مُرسَلة: ${currentSieAccess.messages_used} — ينتهي في ${new Date(currentSieAccess.expires_at).toLocaleString('ar-EG')}`;
    } else {
        usageEl.textContent = `رسايل مُرسَلة: ${currentSieAccess.messages_used}`;
    }
}

async function openOptionsPanel(userId, name, email, currentRole) {
    currentOptionsUserId = userId;
    document.getElementById('optUserName').textContent = name || 'بدون اسم';
    document.getElementById('optUserEmail').textContent = email || '';

    // قسم SIE بيتعرض بس للأدمن اللي is_sie_admin() بترجعله true — أي حد تاني
    // مش هيشوف القسم أصلاً، وحتى لو حاول ينده الـ RPCs مباشرة هترفضه هي نفسها.
    document.getElementById('sieSectionLabel').style.display = isSieAdmin ? '' : 'none';
    document.getElementById('sieSection').style.display = isSieAdmin ? '' : 'none';
    if (isSieAdmin) await loadSieAccessIntoPanel(userId);

    document.querySelectorAll('#optionsPanel .option-row-btn[data-role]').forEach(btn => {
        btn.classList.toggle('role-active', btn.getAttribute('data-role') === currentRole);
    });

    // منع الـ Super User من تغيير رتبته الخاصة: نخفي قسم "تغيير الصلاحية" بالكامل
    // عندما يفتح المستخدم الحالي نافذة خياراته هو نفسه.
    const isViewingSelf = !!user && userId === user.id;
    const isSuperUserSelf = isViewingSelf && user?.profile?.role === 'super_user';
    const roleGroupLabel = document.querySelector('#optionsPanel .options-group-label');
    if (roleGroupLabel) roleGroupLabel.style.display = isSuperUserSelf ? 'none' : '';
    document.querySelectorAll('#optionsPanel .option-row-btn[data-role]').forEach(btn => {
        btn.style.display = isSuperUserSelf ? 'none' : '';
    });

    document.getElementById('optionsOverlay').classList.add('active');
    document.getElementById('optionsPanel').classList.add('active');
}

function closeOptionsPanel() {
    currentOptionsUserId = null;
    currentSieAccess = null;
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

init();
