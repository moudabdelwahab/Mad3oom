/**
 * فريق الشركة (migrations/077_company_staff.sql) — الجزء الخالص في الواجهة
 * وضوابط ثابتة على نداءات البيانات.
 *
 * القرار كله في القاعدة (tests/sql/company-staff.test.sql). اللي هنا:
 *   1) الواجهة تعرض ما رجّعته القاعدة ولا تخمّن («لا نعرف» ≠ «عميل»).
 *   2) ترجمة اختيار المدير إلى نداء واحد صحيح أو لا نداء.
 *   3) نداءات الفريق لا تحمل معرّف شركة أبدًا.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const {
    STAFF_ROLE_LABELS, STAFF_ROLE_OPTIONS, staffRoleOf, staffRoleInfo, staffActions, staffChangeFor
} = await import('../assets/js/company/company-model.js');

const OWNER = { id: 'o', is_owner: true };
const AGENT = { id: 'a', is_owner: false };
const CUSTOMER = { id: 'c', is_owner: false };
const payload = (over = {}) => ({
    my_role: 'admin',
    can_manage: true,
    staff: [
        { user_id: 'o', role: 'admin', is_owner: true },
        { user_id: 'a', role: 'agent', is_owner: false },
        { user_id: 's', role: 'supervisor', is_owner: false }
    ],
    ...over
});

test('الدور يُقرأ من حمولة القاعدة: المالك مدير، الموظف بدوره، والتابع بلا صف عميل', () => {
    assert.equal(staffRoleOf(OWNER, payload()), 'admin');
    assert.equal(staffRoleOf(AGENT, payload()), 'agent');
    assert.equal(staffRoleOf({ id: 's' }, payload()), 'supervisor');
    assert.equal(staffRoleOf(CUSTOMER, payload()), 'customer');
});

test('بلا حمولة (عميل الشركة، أو قاعدة بلا 077) الدور غير معروف — لا يُخمَّن «عميل»', () => {
    for (const p of [null, undefined, {}, { staff: null }]) {
        assert.equal(staffRoleOf(CUSTOMER, p), null);
        assert.equal(staffActions(CUSTOMER, p).canEdit, false);
    }
    assert.equal(staffRoleOf(null, payload()), null);
});

test('دور غير معروف من القاعدة لا يُعرض كدور: يُعامل التابع كعميل', () => {
    const p = payload({ staff: [{ user_id: 'x', role: 'owner' }] });
    assert.equal(staffRoleOf({ id: 'x' }, p), 'customer');
});

test('المحدِّد للمدير وحده، ولغير المالك وحده', () => {
    assert.equal(staffActions(AGENT, payload()).canEdit, true);
    assert.equal(staffActions(CUSTOMER, payload()).canEdit, true);
    assert.equal(staffActions(OWNER, payload()).canEdit, false, 'المالك مدير بالملكية لا بالاختيار');
    assert.equal(staffActions(AGENT, payload({ can_manage: false })).canEdit, false);
    assert.equal(staffActions(AGENT, payload({ can_manage: 'true' })).canEdit, false, 'true النصية ليست true');
});

test('ترجمة الاختيار: منح، تغيير، إلغاء، أو لا شيء', () => {
    assert.deepEqual(staffChangeFor('customer', 'agent'), { kind: 'set', role: 'agent' });
    assert.deepEqual(staffChangeFor('agent', 'supervisor'), { kind: 'set', role: 'supervisor' });
    assert.deepEqual(staffChangeFor('supervisor', 'customer'), { kind: 'revoke' });
    assert.equal(staffChangeFor('agent', 'agent'), null);
    assert.equal(staffChangeFor('customer', 'customer'), null);
    assert.equal(staffChangeFor('customer', 'admin'), null, 'admin لا يُمنح من الواجهة');
    assert.equal(staffChangeFor('customer', ''), null);
    assert.equal(staffChangeFor('customer', undefined), null);
});

test('الخيارات ثلاثة بالضبط ولا تشمل admin، ولكل دور وصف', () => {
    assert.deepEqual(STAFF_ROLE_OPTIONS.map(o => o.value), ['customer', 'agent', 'supervisor']);
    for (const role of ['admin', 'supervisor', 'agent', 'customer']) {
        assert.ok(STAFF_ROLE_LABELS[role]?.label && STAFF_ROLE_LABELS[role]?.hint, role);
        assert.equal(staffRoleInfo(role), STAFF_ROLE_LABELS[role]);
    }
    assert.equal(staffRoleInfo('owner'), null);
    assert.ok(Object.isFrozen(STAFF_ROLE_OPTIONS));
});

test('نداءات الفريق لا تحمل معرّف شركة، وتتحمل غياب 077', () => {
    const src = read('assets/js/company/company-data.js');
    const start = src.indexOf('/* ── فريق الشركة (migrations/077_company_staff.sql)');
    assert.ok(start > 0, 'قسم الفريق في company-data.js');
    const block = src.slice(start, src.indexOf('export async function hasCompany'));
    assert.ok(block.includes("rpc('company_staff_list')"), 'company_staff_list بلا مُعاملات');
    assert.ok(/rpc\('company_staff_set', \{\s*p_user: userId,\s*p_role: role\s*\}\)/.test(block), 'set: الحساب والدور فقط');
    assert.ok(/rpc\('company_staff_revoke', \{\s*p_user: userId\s*\}\)/.test(block), 'revoke: الحساب فقط');
    assert.equal(/company_id|p_company/.test(block), false, 'معرّف شركة في نداء الفريق');
    assert.ok(block.includes("'PGRST202'") && block.includes('isMissingRpc(error)) return null'), 'غياب 077 = null لا خطأ');
});

test('الترحيل لا يمنح طاقم المنصة ولا سياق المالك فرعًا في دوال الفريق', () => {
    const sql = read('migrations/077_company_staff.sql');
    const body = sql.slice(sql.indexOf('-- 4) المُسنَدات'), sql.indexOf('-- 7) الصلاحيات'));
    assert.equal(/is_platform_staff\(|has_elevated_authority\(|is_admin\(|owner_capability\(/.test(body), false,
        'فرع منصة في دوال فريق الشركة');
    assert.equal(/p_company_id|p_company uuid\)[\s\S]*grant execute/.test(body), false);
    for (const fn of ['company_staff_role()', 'company_staff_list()', 'company_staff_set(uuid, text)', 'company_staff_revoke(uuid)']) {
        assert.ok(sql.includes(`grant execute on function public.${fn}`), fn);
    }
    assert.equal(/grant execute on function public\._company/.test(sql), false, 'دالة داخلية ممنوحة');
});
