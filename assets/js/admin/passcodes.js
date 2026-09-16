import { supabase } from '/api-config.js';
import { checkAdminAuth, updateAdminUI } from './auth.js';
import { initSidebar } from './sidebar.js';
import { escapeHtml } from './admin-utils.js';

let user = null;

async function init() {
    initSidebar();
    user = await checkAdminAuth();
    if (!user) return;

    updateAdminUI(user);

    // الفرض الحقيقي في قاعدة البيانات: سياسات access_passcodes ودوال
    // owner_set_passcode تتحقق من is_platform_owner(). هذا الفحص لإخفاء
    // الواجهة فقط عمّن لا يملك الصلاحية.
    const { data: status } = await supabase.rpc('owner_context_status');
    if (!status?.is_platform_owner) {
        document.getElementById('deniedBox').style.display = 'block';
        return;
    }

    document.getElementById('mainBox').style.display = 'block';
    setupEvents();
    await loadPasscodes();
}

async function loadPasscodes() {
    const body = document.getElementById('passcodesBody');

    const { data, error } = await supabase
        .from('access_passcodes')
        .select('id, label, is_active, created_at, passcode_redemptions(user_id)')
        .order('created_at', { ascending: false });

    if (error) {
        console.error('Error loading passcodes:', error);
        body.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:2rem;">تعذر تحميل الأكواد</td></tr>';
        return;
    }

    if (!data || data.length === 0) {
        body.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:2rem;">لا توجد أكواد بعد</td></tr>';
        return;
    }

    body.innerHTML = data.map((c) => `
        <tr>
            <td>${escapeHtml(c.label) || '—'}</td>
            <td><span class="status-badge ${c.is_active ? 'status-resolved' : 'status-danger'}">${c.is_active ? 'فعّال' : 'معطّل'}</span></td>
            <td>${c.passcode_redemptions?.length || 0}</td>
            <td>${new Date(c.created_at).toLocaleDateString('ar-EG')}</td>
            <td>
                <button class="btn ${c.is_active ? 'btn-danger' : 'btn-success'} btn-sm toggle-btn"
                        data-id="${c.id}" data-active="${c.is_active}">
                    ${c.is_active ? 'تعطيل' : 'تفعيل'}
                </button>
            </td>
        </tr>
    `).join('');

    document.querySelectorAll('.toggle-btn').forEach((btn) => {
        btn.addEventListener('click', () => toggle(btn.dataset.id, btn.dataset.active !== 'true'));
    });
}

async function toggle(id, makeActive) {
    if (!makeActive && !confirm('تعطيل الكود يسحب الإعفاء فورًا من كل من استخدمه. متابعة؟')) return;

    const { error } = await supabase.rpc('owner_set_passcode_active', {
        p_id: id,
        p_active: makeActive
    });

    if (error) {
        showToast(error.message || 'تعذر تغيير حالة الكود', 'error');
        return;
    }

    showToast(makeActive ? 'تم تفعيل الكود' : 'تم تعطيل الكود', 'success');
    await loadPasscodes();
}

function setupEvents() {
    document.getElementById('createBtn').addEventListener('click', async () => {
        const btn = document.getElementById('createBtn');
        const code = document.getElementById('codeInput').value.trim();
        const label = document.getElementById('labelInput').value.trim();

        if (code.length < 6) {
            showToast('كود المرور يجب أن يكون 6 خانات على الأقل', 'error');
            return;
        }

        btn.disabled = true;
        btn.textContent = 'جاري الإنشاء...';

        try {
            const { data, error } = await supabase.rpc('owner_set_passcode', {
                p_code: code,
                p_label: label
            });

            if (error || !data?.ok) {
                showToast(error?.message || 'تعذر إنشاء الكود', 'error');
                return;
            }

            document.getElementById('codeInput').value = '';
            document.getElementById('labelInput').value = '';
            showToast('تم إنشاء الكود بنجاح', 'success');
            await loadPasscodes();
        } finally {
            btn.disabled = false;
            btn.textContent = 'إنشاء الكود';
        }
    });
}

function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.style.background = type === 'success' ? 'var(--color-success)' : 'var(--color-danger)';
    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

init();
