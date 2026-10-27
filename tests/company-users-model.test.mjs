/**
 * «المستخدمون» في لوحة الشركة (assets/js/company/company-users-model.js).
 *
 * الأهم: القائمة الموحّدة لا تُظهر إجراءً لم يكن ظاهرًا في صفحتي «أعضاء الفريق»
 * و«عملاء الشركة» — نفس شروط memberActions/staffActions/invitationEmailInfo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCompanyDirectory, filterCompanyDirectory, companyUserActions } from '../assets/js/company/company-users-model.js';

const OWNER = { id: 'o', name: 'المالك', email: 'owner@c.test', role: 'company_admin', is_owner: true, is_me: true, created_at: '2026-01-01T00:00:00Z' };
const CUST = { id: 'm1', name: 'عضو عميل', email: 'm1@c.test', role: 'company_user', is_owner: false, is_me: false };
const AGENT = { id: 'm2', name: 'موظفة', email: 'm2@c.test', phone: '0500', role: 'company_user', is_owner: false, is_me: false };
const STAFF = { can_manage: true, staff: [{ user_id: 'o', role: 'admin' }, { user_id: 'm2', role: 'agent' }] };

const rows = buildCompanyDirectory({
    members: [OWNER, CUST, AGENT],
    staff: STAFF,
    customers: [{ id: 'k1', name: 'عميلة', email: 'k1@client.test', phone: '0555' }],
    invitations: [
        { id: 'i1', email: 'new@client.test', status: 'pending', email_status: 'failed' },
        { id: 'i2', email: 'sent@client.test', status: 'pending', email_status: 'sent' },
        { id: 'i3', email: 'old@client.test', status: 'accepted' }
    ]
});
const row = (key) => rows.find(r => r.key === key);
const ids = (r, ctx) => companyUserActions(r, ctx).filter(a => a.id).map(a => a.id);

test('القائمة تجمع الأعضاء والعملاء والدعوات المعلّقة وحدها', () => {
    assert.deepEqual(rows.map(r => r.key),
        ['member:o', 'member:m1', 'member:m2', 'customer:k1', 'invitation:i1', 'invitation:i2']);
    assert.equal(row('member:o').statusLabel, 'أنت');
    assert.equal(row('member:m2').staffLabel, 'موظف دعم');
    assert.equal(row('member:o').staffLabel, '', 'المالك لا تُعرض له شارة دور موظف');
    assert.equal(row('invitation:i1').statusLabel, 'تعذّر إرسال البريد');
});

test('البحث والفلاتر', () => {
    const keys = (f) => filterCompanyDirectory(rows, f).map(r => r.key);
    assert.deepEqual(keys({ q: 'CLIENT' }), ['customer:k1', 'invitation:i1', 'invitation:i2']);
    assert.deepEqual(keys({ q: '0500' }), ['member:m2']);
    assert.deepEqual(keys({ kind: 'invitation' }), ['invitation:i1', 'invitation:i2']);
    assert.deepEqual(keys({ staff: 'staff' }), ['member:o', 'member:m2']);
    assert.deepEqual(keys({ staff: 'customer' }), ['member:m1']);
});

test('عضو تابع لمدير يدير الفريق: التفاصيل، الدور، التواصل، الإزالة', () => {
    assert.deepEqual(ids(row('member:m2'), { canManage: true, staff: STAFF }),
        ['details', 'staff:customer', 'staff:agent', 'staff:supervisor', 'copyEmail', 'copyPhone', 'remove']);
    const current = companyUserActions(row('member:m2'), { canManage: true, staff: STAFF }).find(a => a.current);
    assert.equal(current.id, 'staff:agent');
});

test('بلا إدارة: لا تفاصيل ولا دور ولا إزالة — كما في صفحة الأعضاء', () => {
    assert.deepEqual(ids(row('member:m1'), { canManage: false, staff: { ...STAFF, can_manage: false } }), ['copyEmail']);
    assert.deepEqual(ids(row('member:m1'), { canManage: false, staff: null }), ['copyEmail']);
});

test('المالك ونفسك: لا إدارة ولا إزالة ولا تغيير دور؛ «ملفي الشخصي» لنفسك', () => {
    assert.deepEqual(ids(row('member:o'), { canManage: true, staff: STAFF }), ['myProfile', 'copyEmail']);
});

test('الدعوات: إعادة المحاولة للفاشلة، إعادة الإرسال للمرسلة، والإلغاء للمعلّقة', () => {
    assert.deepEqual(ids(row('invitation:i1'), { canManage: true }), ['invite:retry', 'copyEmail', 'cancelInvite']);
    assert.deepEqual(ids(row('invitation:i2'), { canManage: true }), ['invite:resend', 'copyEmail', 'cancelInvite']);
});

test('عميل الشركة: نسخ البريد والجوال فقط (القائمة القديمة بلا إجراءات)', () => {
    assert.deepEqual(ids(row('customer:k1'), { canManage: true, staff: STAFF }), ['copyEmail', 'copyPhone']);
});
