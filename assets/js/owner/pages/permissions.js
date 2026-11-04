/**
 * owner/permissions.html — مصفوفة الصلاحيات (121).
 *
 * owner_permission_matrix() تقرأ الكتالوج والقواعد، وowner_set_role_permission() تكتب خانة واحدة — بواجهة
 * «مالك المنصة» وجلسة تحرير سارية، وإلا تعود بـ step_up_required فتُفتح نافذة التحقق ثم يُعاد الطلب.
 * الفرض في القاعدة (staff_write_ok في سياسات RESTRICTIVE ومحفّز profiles)، لا هنا.
 */
import { supabase, bootOwnerPage, esc, when, errorBlock, loadingBlock, friendlyError } from '/assets/js/owner/owner-page.js';
import { announce } from '/assets/js/owner/owner-workspace.js';
import { groupPermissions, rpcOutcome } from '/assets/js/owner/security-model.js';

const $ = (id) => document.getElementById(id);
const toast = (text, tone = 'success') => announce($('pageToast'), text, tone);

const toggle = (p, role, field, checked, label) => `
    <label class="owner-perm-toggle">
        <input type="checkbox" role="switch" data-perm="${esc(p.key)}" data-role="${role}" data-field="${field}" ${checked ? 'checked' : ''}
               aria-label="${esc(`${label}: ${p.label}`)}">
        <span class="owner-perm-switch" aria-hidden="true"></span>
        <span class="owner-perm-state">${checked ? (field === 'require_step_up' ? 'يتطلب تحققًا' : 'مسموح') : (field === 'require_step_up' ? 'بلا تحقق' : 'ممنوع')}</span>
    </label>`;

async function load() {
    const box = $('permMatrix');
    box.innerHTML = loadingBlock();
    const res = await supabase.rpc('owner_permission_matrix');
    const out = rpcOutcome(res);
    if (!out.ok) { box.innerHTML = errorBlock(out.message || friendlyError(res.error)); return; }
    const groups = groupPermissions(out.data.permissions);
    box.innerHTML = groups.map(g => `
        <div class="owner-perm-group">
            <h3 class="owner-perm-group-title">${esc(g.label)}</h3>
            <div class="table-container"><table class="admin-table owner-perm-table">
                <thead><tr><th scope="col">الإجراء</th><th scope="col">الأدمن</th><th scope="col">فريق الدعم</th><th scope="col">أنت (المالك)</th></tr></thead>
                <tbody>${g.items.map(p => `<tr>
                    <th scope="row"><span class="owner-perm-label">${esc(p.label)}</span>
                        <span class="owner-cell-muted">${esc(p.description)}</span>
                        <span class="owner-cell-muted owner-mono" dir="ltr">${esc(p.enforced_on)}</span>
                        ${p.updated_at ? `<span class="owner-cell-muted">آخر تغيير ${esc(when(p.updated_at))}</span>` : ''}</th>
                    <td>${toggle(p, 'admin', 'allowed', p.admin, 'الأدمن')}</td>
                    <td>${toggle(p, 'support', 'allowed', p.support, 'فريق الدعم')}</td>
                    <td>${toggle(p, 'platform_owner', 'require_step_up', p.owner_step_up, 'جلسة تحرير للمالك')}</td>
                </tr>`).join('')}</tbody></table></div>
        </div>`).join('');
}

function bind() {
    $('permMatrix').addEventListener('change', async (e) => {
        const input = e.target.closest('input[data-perm]');
        if (!input) return;
        const want = input.checked;
        input.disabled = true;
        const res = await supabase.rpc('owner_set_role_permission', {
            p_role: input.dataset.role, p_permission: input.dataset.perm, p_field: input.dataset.field, p_value: want
        });
        const out = rpcOutcome(res);
        input.disabled = false;
        if (!out.ok) {
            input.checked = !want;   // الحالة الحقيقية كما في القاعدة
            toast(out.message, 'error');
            return;
        }
        toast('حُفظ. القاعدة تفرض القرار من الطلب التالي.', 'success');
        load();
    });
    $('permRefresh').addEventListener('click', load);
}

(async function init() {
    const ctx = await bootOwnerPage();
    if (!ctx) return;
    bind();
    load();
})();
