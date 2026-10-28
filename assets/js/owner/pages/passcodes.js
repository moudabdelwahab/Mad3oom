/**
 * owner/passcodes.html — أكواد المرور، ميزة لمالك المنصة وحده.
 *
 * كانت تعيش في /admin/passcodes.html وحدها بقشرة الإدارة، رغم أن كل نداءاتها owner-only:
 *   access_passcodes_owner_all ← is_platform_owner() · owner_set_passcode / owner_set_passcode_active
 *   · passcode_redemptions_select ← is_platform_owner().
 * فمكانها الطبيعي لوحة المالك. صفحة الإدارة باقية كما هي لمن اعتاد رابطها.
 */
import {
    supabase, bootOwnerPage, announce, esc, day, num, table, errorBlock, loadingBlock, friendlyError
} from '/assets/js/owner/owner-page.js';

const $ = (id) => document.getElementById(id);
const say = (text, tone = 'info') => announce($('pageStatus'), text, tone);

const PASSCODE_MIN = 6;

async function load() {
    const box = $('passcodesTable');
    box.innerHTML = loadingBlock();
    const { data, error } = await supabase.from('access_passcodes')
        .select('id, label, is_active, created_at, revoked_at, passcode_redemptions(user_id)')
        .order('created_at', { ascending: false });
    if (error) { box.innerHTML = errorBlock(friendlyError(error)); return; }
    box.innerHTML = table(['الوصف', 'الحالة', 'مرات الاستخدام', 'أُنشئ', 'عُطّل', ''], data || [], c => `<tr>
        <td>${esc(c.label || '—')}</td>
        <td>${c.is_active ? '<span class="pill status-resolved">فعّال</span>' : '<span class="pill status-rejected">معطّل</span>'}</td>
        <td>${esc(num(c.passcode_redemptions?.length || 0))}</td>
        <td>${esc(day(c.created_at))}</td>
        <td>${esc(day(c.revoked_at))}</td>
        <td><button type="button" class="btn btn-sm ${c.is_active ? 'btn-outline' : 'btn-primary'}" data-code="${esc(c.id)}" data-active="${c.is_active ? 'false' : 'true'}">${c.is_active ? 'تعطيل' : 'تفعيل'}</button></td>
    </tr>`, { empty: 'لا توجد أكواد بعد.' });
    box.querySelectorAll('[data-code]').forEach(b => b.addEventListener('click', () => toggle(b)));
}

async function toggle(btn) {
    const makeActive = btn.dataset.active === 'true';
    if (!makeActive && !window.confirm('تعطيل الكود يسحب الإعفاء فورًا من كل من استخدمه. متابعة؟')) return;
    btn.disabled = true;
    const { error } = await supabase.rpc('owner_set_passcode_active', { p_id: btn.dataset.code, p_active: makeActive });
    if (error) { btn.disabled = false; say(friendlyError(error), 'error'); return; }
    say(makeActive ? 'تم تفعيل الكود.' : 'تم تعطيل الكود.', 'success');
    load();
}

async function create(e) {
    e.preventDefault();
    const code = $('passcodeCode').value.trim();
    const label = $('passcodeLabel').value.trim();
    if (code.length < PASSCODE_MIN) { say(`كود المرور ${PASSCODE_MIN} خانات على الأقل.`, 'error'); $('passcodeCode').focus(); return; }
    const btn = $('passcodeCreate');
    btn.disabled = true;
    say('جارٍ الإنشاء…');
    const { data, error } = await supabase.rpc('owner_set_passcode', { p_code: code, p_label: label });
    btn.disabled = false;
    if (error || !data?.ok) { say(error ? friendlyError(error) : (data?.message || 'تعذّر إنشاء الكود.'), 'error'); return; }
    $('passcodeForm').reset();
    say('تم إنشاء الكود. احفظه الآن — لا يمكن عرضه مرة أخرى.', 'success');
    load();
}

(async function init() {
    if (!await bootOwnerPage()) return;
    $('passcodeForm').addEventListener('submit', create);
    $('passcodesRefresh').addEventListener('click', load);
    load();
})();
