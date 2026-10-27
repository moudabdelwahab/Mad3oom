/**
 * منطق صفحة «المستخدمين» الموحّدة (assets/js/admin/users-hub-model.js).
 *
 * أهم ما يُختبر هنا: أن التبويبات تتبع نفس قواعد الروابط القديمة في القائمة
 * الجانبية حرفيًا — جمع ثماني صفحات في صفحة واحدة لا يجوز أن يُظهر لأحد قائمة
 * لم يكن يراها.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleHubTabs, resolveHubTab, filterUsers, userActions, roleLabel, isBanned } from '../assets/js/admin/users-hub-model.js';

const ids = (access) => visibleHubTabs(access).map(t => t.id);

test('الأدمن الرئيسي يرى كل التبويبات', () => {
    assert.deepEqual(ids({ isAdmin: true, isMainAdmin: true }),
        ['all', 'customers', 'superUsers', 'myUsers', 'banned', 'accountRequests', 'companyRequests', 'waitlist']);
});

test('أدمن غير رئيسي: لا Super Users (كان superUserLink للأدمن الرئيسي وحده)', () => {
    assert.ok(!ids({ isAdmin: true }).includes('superUsers'));
    assert.ok(ids({ isAdmin: true }).includes('customers'));
});

test('الدعم الفني: كل المستخدمين والمحظورون فقط — لا عملاء ولا طلبات ولا قائمة انتظار', () => {
    assert.deepEqual(ids({ isSupport: true }), ['all', 'banned']);
});

test('Super User الصِّرف: «مستخدميني» وحده — لا قائمة المنصة ولا المحظورين', () => {
    assert.deepEqual(ids({ isSuperUser: true }), ['myUsers']);
});

test('Super User بسلطة مرتفعة يُعامل كما كان (لا يُخفى عنه شيء من قائمة الطاقم)', () => {
    const t = ids({ isSuperUser: true, isMainAdmin: true });
    assert.ok(t.includes('all') && t.includes('superUsers') && t.includes('myUsers'));
});

test('حساب بلا رتبة خاصة: نفس السلوك القديم، وتبويب غير متاح في الـhash يُستبدل', () => {
    assert.deepEqual(ids({}), ['all', 'banned']); // الرابطان القديمان لم يكونا يُخفيان إلا عن Super User
    assert.equal(resolveHubTab('#customers', visibleHubTabs({ isSuperUser: true })), 'myUsers');
});

test('الـhash يختار التبويب إن كان متاحًا، وإلا أول تبويب', () => {
    const tabs = visibleHubTabs({ isAdmin: true });
    assert.equal(resolveHubTab('#waitlist', tabs), 'waitlist');
    assert.equal(resolveHubTab('#superUsers', tabs), 'all');
    assert.equal(resolveHubTab('', tabs), 'all');
    assert.equal(resolveHubTab('#x', []), null);
});

const users = [
    { id: 'a', full_name: 'محمود', email: 'm@x.com', role: 'admin', ban_status: 'none', points: 10, created_at: '2026-01-02T00:00:00Z' },
    { id: 'b', full_name: 'تركي', email: 't@gmail.com', phone: '966555', role: 'user', ban_status: 'none', points: 50, created_at: '2026-03-02T00:00:00Z' },
    { id: 'c', full_name: 'Bank', email: 'b@gmail.com', role: 'super_user', points: 900, created_at: '2026-04-02T00:00:00Z' },
    { id: 'd', full_name: 'سارة', email: 's@x.com', role: 'user', ban_status: 'permanent', points: 0, created_at: '2026-05-10T00:00:00Z' }
];
const names = (rows) => rows.map(u => u.id);

test('البحث في الاسم والبريد والجوال، بلا حساسية لحالة الأحرف', () => {
    assert.deepEqual(names(filterUsers(users, { q: 'GMAIL' })), ['c', 'b']);
    assert.deepEqual(names(filterUsers(users, { q: '966555' })), ['b']);
    assert.deepEqual(names(filterUsers(users, { q: '  تركي ' })), ['b']);
});

test('فلتر الرتبة والحالة (المحظور بأعمدة is_banned، النشط بلا قيمة ban_status، الرصيد المجمّد)', () => {
    assert.deepEqual(names(filterUsers(users, { role: 'super_user' })), ['c']);
    assert.deepEqual(names(filterUsers(users, { status: 'banned' })), ['d']);
    assert.deepEqual(names(filterUsers(users, { status: 'active' })), ['c', 'b', 'a']);
    assert.deepEqual(names(filterUsers(users, { status: 'frozen' }, new Map([['b', true], ['c', false]]))), ['b']);
});

test('نطاق التاريخ شامل لطرفيه، والترتيب', () => {
    assert.deepEqual(names(filterUsers(users, { from: '2026-03-02', to: '2026-04-02' })), ['c', 'b']);
    assert.deepEqual(names(filterUsers(users, { sort: 'oldest' })), ['a', 'b', 'c', 'd']);
    assert.deepEqual(names(filterUsers(users, { sort: 'points' })), ['c', 'b', 'a', 'd']);
});

const actionIds = (target, ctx) => userActions(target, ctx).filter(a => a.id).map(a => a.id);

test('قائمة الخيارات تجمع كل الإجراءات القائمة', () => {
    assert.deepEqual(actionIds(users[1], { viewer: { id: 'a', role: 'admin', email: 'm@x.com' } }),
        ['view', 'points', 'role:user', 'role:admin', 'copyEmail', 'ban']);
    const current = userActions(users[1], { viewer: { id: 'a' } }).find(a => a.current);
    assert.equal(current.id, 'role:user');
});

test('المحظور: «إلغاء الحظر» بدل «حظر»', () => {
    const a = actionIds(users[3], { viewer: { id: 'a' } });
    assert.ok(a.includes('unban') && !a.includes('ban'));
});

test('Super User لا يرى تغيير الصلاحية على نفسه (كما كانت النافذة)', () => {
    const self = { id: 'c', role: 'super_user', email: 'b@gmail.com' };
    assert.ok(!actionIds(users[2], { viewer: self }).some(id => id.startsWith('role:')));
    assert.ok(actionIds(users[1], { viewer: self }).some(id => id.startsWith('role:')));
});

test('تجميد الرصيد لمن تسمح له can_manage_central_wallet وحده (لا البريد)، وSIE لمن is_sie_admin فقط', () => {
    assert.ok(!actionIds(users[1], { viewer: { id: 'a', email: 'm@x.com' } }).includes('freeze'));
    // البريد وحده لا يمنح شيئًا: القرار من القاعدة (117)
    assert.ok(!actionIds(users[1], { viewer: { id: 'z', email: 'support@mad3oom.online' } }).includes('freeze'));
    const support = { viewer: { id: 'z', email: 'support@mad3oom.online' }, canManageCentralWallet: true, frozen: true };
    assert.ok(actionIds(users[1], support).includes('freeze'));
    assert.equal(userActions(users[1], support).find(a => a.id === 'freeze').label, 'إلغاء تجميد الرصيد');
    assert.ok(!actionIds(users[1], { viewer: { id: 'a' } }).includes('sie'));
    assert.ok(actionIds(users[1], { viewer: { id: 'a' }, isSieAdmin: true }).includes('sie'));
});

test('أسماء الرتب', () => {
    assert.equal(roleLabel('support'), 'دعم فني');
    assert.equal(roleLabel(undefined), 'مستخدم');
});

test('المحظور = شرط is_banned(): الحظر المؤقت المنتهي ليس حظرًا، و«active» و«none» ليسا حظرًا', () => {
    const past = new Date(Date.now() - 864e5).toISOString();
    const future = new Date(Date.now() + 864e5).toISOString();
    assert.equal(isBanned({ ban_status: 'temporary', ban_until: future }), true);
    assert.equal(isBanned({ ban_status: 'temporary', ban_until: past }), false);
    assert.equal(isBanned({ ban_status: 'banned' }), true);
    assert.equal(isBanned({ ban_status: 'active' }), false);
    assert.equal(isBanned({ ban_status: 'none' }), false);
    assert.equal(isBanned({ status: 'banned' }), false, 'لا عمود status في profiles');
});
