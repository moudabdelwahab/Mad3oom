/**
 * owner-no-redirect-f3.test.mjs — المجموعة الأمامية F3: المستخدمون المضمّنون،
 * وMCP المالك، وإجراءات المالك على مستخدم.
 *
 *   B9  — التبويبات المستضافة تُخفى في وضع التضمين، ولا رابط /admin/ في
 *         قائمة المالك ولا في قسم المستخدمين بلوحة المالك.
 *   B10 — قسم MCP المالك: قراءة عبر owner_list_mcp_servers()، وكتابة
 *         التعريف لمالكه وحده، والاعتماد/الاختبار/OAuth عبر دوال الحافة.
 *   B11 — إجراءات المالك على مستخدم: رتبة/حظر/نقاط عبر دوال 147، والتجميد
 *         عبر manage_user_points كما هي — بلا تقمّص وبلا تعديل باقة.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { visibleHubTabs, HUB_TABS } from '../assets/js/admin/users-hub-model.js';
import {
    OWNER_USER_ROLES, BAN_REASON_MIN, validateBanReason, validatePointsInput,
    ownerUserActionList, banPayload, unbanPayload, rolePayload, pointsPayload,
    freezePayload, rpcJsonResult, isBanned
} from '../assets/js/owner/owner-user-actions-model.js';
import {
    normalizeMcpServers, mcpStatusLabel, mcpStatusTone,
    canManageMcpServer, canTestMcpServer, credentialFields, validateServerForm
} from '../assets/js/owner/owner-mcp-model.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const ids = (access, opts) => visibleHubTabs(access, opts).map(t => t.id);
const SRC_TABS = HUB_TABS.filter(t => t.src).map(t => t.id);

/* ── B9: التبويبات المستضافة ─────────────────────────────────────────── */

test('B9: في وضع التضمين تُخفى التبويبات الست المستضافة، ويبقى «كل المستخدمين» و«المحظورون»', () => {
    assert.deepEqual(SRC_TABS, ['customers', 'superUsers', 'myUsers', 'accountRequests', 'companyRequests', 'waitlist']);
    assert.deepEqual(ids({ isAdmin: true, isMainAdmin: true }, { embedded: true }), ['all', 'banned']);
    assert.deepEqual(ids({ isAdmin: true }, { embedded: true }), ['all', 'banned']);
    assert.deepEqual(ids({ isSupport: true }, { embedded: true }), ['all', 'banned']);
    // بلا تضمين: القواعد القديمة كما هي
    assert.deepEqual(ids({ isAdmin: true, isMainAdmin: true }), ['all', 'customers', 'superUsers', 'myUsers', 'banned', 'accountRequests', 'companyRequests', 'waitlist']);
    assert.deepEqual(ids({ isSuperUser: true }, { embedded: true }), []);
});

test('B9: قائمة المالك بلا أي رابط /admin/ — «المستخدمون» قسم داخل اللوحة', () => {
    const html = read('assets/components/owner-sidebar.html');
    const items = [...html.matchAll(/<a href="([^"]+)" class="sidebar-item"([^>]*)>/g)].map(m => [m[1], m[2]]);
    assert.ok(!items.some(([href]) => href.startsWith('/admin/')), 'عنصر في قائمة المالك يقود إلى /admin/');
    assert.ok(items.some(([href, attrs]) => href === '/owner-dashboard.html#users' && attrs.includes('data-tab="users"')), 'users');
});

test('B9: قسم المستخدمين بلوحة المالك بلا رابط «فتح في صفحة مستقلة»، والإطار المضمّن باقٍ', () => {
    const html = read('owner-dashboard.html');
    assert.ok(!html.includes('href="/admin/users.html"') && !html.includes("href='/admin/users.html'"), 'قسم المستخدمين ما زال يربط /admin/users.html');
    assert.ok(html.includes("frame.src = '/admin/users.html?embed=1'"), 'الإطار المضمّن للصفحة الموحّدة');
    assert.ok(html.includes('id="ownerUserActions"'), 'لوحة إجراءات المالك على مستخدم');
});

test('B9: وصفا قسم المستخدمين لا يَعِدان بتبويبات مخفيّة في وضع التضمين', () => {
    const html = read('owner-dashboard.html');
    const card = /<a class="context-card" href="#users">[\s\S]*?<p class="context-card-desc">([^<]*)<\/p>/.exec(html)?.[1] || '';
    const subtitle = /id="usersHeading"[\s\S]*?<p class="panel-subtitle">([^<]*)<\/p>/.exec(html)?.[1] || '';
    assert.ok(card && subtitle, 'وصفا قسم المستخدمين');
    // التبويبات المستضافة (العملاء/المميزون/الطلبات) مخفيّة في التضمين — فالوصف
    // لا يذكرها كأنها داخل القسم.
    for (const text of [card, subtitle]) {
        assert.ok(!text.includes('العملاء') && !text.includes('الطلبات') && !text.includes('المميزون'),
            'الوصف يَعِد بتبويب مخفيّ في التضمين: ' + text);
    }
});

/* ── B11: نموذج إجراءات المالك على مستخدم ────────────────────────────── */

const bannedUser = { id: 'u1', role: 'user', ban_status: 'permanent', ban_until: null, points: 10 };
const activeUser = { id: 'u2', role: 'admin', ban_status: 'none', points: 5 };
const frozenCtx = { viewerId: 'me', canManageCentralWallet: true, frozen: true };

test('B11: سبب الحظر 5 أحرف على الأقل، والنقاط عدد صحيح لا سالب', () => {
    assert.equal(validateBanReason('abcd').ok, false);
    assert.equal(validateBanReason('إساءة متكررة').ok, true);
    assert.equal(BAN_REASON_MIN, 5);
    assert.deepEqual(validatePointsInput('12'), { ok: true, points: 12 });
    assert.equal(validatePointsInput('1.5').ok, false);
    assert.equal(validatePointsInput('-3').ok, false);
    assert.equal(validatePointsInput('abc').ok, false);
});

test('B11: قائمة الإجراءات — بلا تقمّص وبلا SIE، وحظر/إلغاء حظر حسب الحالة', () => {
    const mine = ownerUserActionList(activeUser, frozenCtx).map(a => a.id).filter(Boolean);
    assert.ok(!mine.includes('view') && !mine.includes('sie'), 'لا تقمّص ولا SIE في إجراءات المالك');
    assert.ok(mine.includes('role:user') && mine.includes('role:admin') && mine.includes('ban') && mine.includes('points') && mine.includes('freeze'));
    const banned = ownerUserActionList(bannedUser, frozenCtx).map(a => a.id).filter(Boolean);
    assert.ok(banned.includes('unban') && !banned.includes('ban'));
    const noWallet = ownerUserActionList(activeUser, { viewerId: 'me' }).map(a => a.id).filter(Boolean);
    assert.ok(!noWallet.includes('freeze'), 'التجميد لحامل المحفظة المركزية وحده');
    const self = ownerUserActionList({ ...activeUser, id: 'me' }, frozenCtx).map(a => a.id).filter(Boolean);
    assert.ok(!self.some(i => i.startsWith('role:')) && !self.includes('ban'), 'لا رتبة ولا حظر على الذات');
    assert.ok(self.includes('points') && self.includes('freeze'));
});

test('B11: حمولات دوال 147 والتجميد — بأسماء المعاملات المتفق عليها حرفيًا', () => {
    assert.deepEqual(rolePayload('u1', 'admin'), { p_user: 'u1', p_role: 'admin' });
    assert.deepEqual(pointsPayload('u1', 42), { p_user: 'u1', p_points: 42 });
    assert.deepEqual(banPayload('u1', 'إساءة', null), { p_user: 'u1', p_reason: 'إساءة', p_until: null });
    assert.equal(banPayload('u1', 'إساءة', '2026-12-01T10:00').p_until, new Date('2026-12-01T10:00').toISOString());
    const unban = unbanPayload('u1');
    assert.equal(unban.p_user, 'u1');
    assert.equal(unban.p_reason, 'إلغاء الحظر');
    assert.ok(unban.p_until && new Date(unban.p_until).getTime() <= Date.now(), 'إلغاء الحظر = حظر ينتهي الآن (ليس حظرًا عند is_banned)');
    assert.deepEqual(freezePayload('a@x.com', true), { target_user_email: 'a@x.com', amount_change: 0, action_type: 'unfreeze' });
    assert.deepEqual(freezePayload('a@x.com', false), { target_user_email: 'a@x.com', amount_change: 0, action_type: 'freeze' });
    assert.equal(isBanned(bannedUser), true);
    assert.equal(isBanned(activeUser), false);
    assert.deepEqual(rpcJsonResult({ success: false, message: 'مرفوض' }, null), { ok: false, message: 'مرفوض' });
    assert.deepEqual(rpcJsonResult({ success: true }, null), { ok: true, data: { success: true } });
    assert.equal(rpcJsonResult(null, { message: 'خطأ' }).ok, false);
    assert.deepEqual(OWNER_USER_ROLES.map(r => r.value), ['user', 'admin']);
});

test('B11: الروابط المعاد توجيهها تصل إلى قسم المستخدمين، وزر الإجراءات في تفاصيل الحساب', () => {
    assert.ok(!read('owner/permissions.html').includes('/admin/users.html'));
    assert.ok(read('owner/permissions.html').includes('href="/owner-dashboard.html#users"'));
    assert.ok(!read('owner/accounts.html').includes('/admin/users.html'));
    assert.ok(read('assets/js/owner/pages/accounts.js').includes('data-action="user-actions"'));
    const src = read('assets/js/owner/owner-user-actions.js');
    for (const rpc of ['owner_set_user_role', 'owner_ban_user', 'owner_set_user_points', 'manage_user_points']) {
        assert.ok(src.includes(rpc), rpc);
    }
    assert.ok(!src.includes('impersonate') && !src.includes('/admin/*.html'), 'بلا تقمّص وبلا روابط لصفحات /admin/');
});

/* ── B10: نموذج MCP المالك ───────────────────────────────────────────── */

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const mcpRows = [
    { id: 's1', name: 'GitHub', transport: 'streamable_http', url: 'https://api.github.com/mcp', owner_id: ME, created_at: '2026-01-02T00:00:00Z', connection_id: 'c1', connection_owner_id: ME, auth_type: 'oauth2', status: 'connected', tools: [{ name: 't1', enabled: true }, { name: 't2', enabled: false }], last_checked_at: '2026-01-03T00:00:00Z' },
    { id: 's1', name: 'GitHub', transport: 'streamable_http', url: 'https://api.github.com/mcp', owner_id: ME, created_at: '2026-01-02T00:00:00Z', connection_id: 'c9', connection_owner_id: OTHER, auth_type: 'api_key', status: 'error', tools: [], last_error: 'boom' },
    { id: 's2', name: 'Drive', transport: 'sse', url: 'https://drive.example/mcp', owner_id: OTHER, created_at: '2026-01-01T00:00:00Z', connection_id: 'c2', connection_owner_id: OTHER, auth_type: 'bearer', status: 'pending', tools: [] },
    { id: 's3', name: 'بلا اتصال', transport: 'stdio', command: 'npx x', owner_id: ME, created_at: '2026-01-04T00:00:00Z' }
];

test('B10: دمج صفوف owner_list_mcp_servers — خادم واحد، واتصالي أولًا للحالة', () => {
    const servers = normalizeMcpServers(mcpRows, ME);
    assert.deepEqual(servers.map(s => s.id), ['s3', 's1', 's2']);
    const s1 = servers.find(s => s.id === 's1');
    assert.equal(s1.status, 'connected', 'اتصالي أنا يقدَّم على اتصال غيري');
    assert.equal(s1.auth_type, 'oauth2');
    assert.equal(s1.mine, true);
    assert.equal(s1.tools.length, 2);
    const s2 = servers.find(s => s.id === 's2');
    assert.equal(s2.status, 'pending');
    assert.equal(s2.mine, false);
    assert.equal(servers.find(s => s.id === 's3').status, 'pending');
    assert.deepEqual(normalizeMcpServers([], ME), []);
    assert.deepEqual(normalizeMcpServers(null, ME), []);
});

test('B10: إدارة الخادم لمالكه وحده، والاختبار لاتصالي وحده', () => {
    const servers = normalizeMcpServers(mcpRows, ME);
    const s1 = servers.find(s => s.id === 's1');
    const s2 = servers.find(s => s.id === 's2');
    assert.equal(canManageMcpServer(s1, ME), true);
    assert.equal(canManageMcpServer(s2, ME), false);
    assert.equal(canManageMcpServer(s2, OTHER), true);
    assert.equal(canTestMcpServer(s1), true);
    assert.equal(canTestMcpServer(s2), false);
    assert.equal(mcpStatusLabel('connected'), 'متصل');
    assert.equal(mcpStatusTone('error'), 'status-rejected');
});

test('B10: حقول بيانات الاعتماد لكل نوع، وتحقق نموذج الخادم', () => {
    assert.deepEqual(credentialFields('none'), []);
    assert.deepEqual(credentialFields('api_key').map(f => f.key), ['api_key', 'api_secret']);
    assert.deepEqual(credentialFields('bearer').map(f => f.key), ['bearer_token']);
    assert.ok(credentialFields('oauth2').some(f => f.key === 'oauth_client_secret'));
    assert.deepEqual(credentialFields('custom').map(f => f.key), ['custom_config']);
    assert.equal(validateServerForm({ name: '', transport: 'streamable_http', url: 'https://x' }).ok, false);
    assert.equal(validateServerForm({ name: 'A', transport: 'streamable_http', url: '' }).ok, false);
    assert.equal(validateServerForm({ name: 'A', transport: 'stdio', url: '' }).ok, true);
    assert.equal(validateServerForm({ name: 'A', transport: 'sse', url: 'https://x' }).ok, true);
});

test('B10: صفحة التكاملات بلا أي رابط صفحة /admin/، وقسم MCP فيها', () => {
    const html = read('owner/integrations.html');
    // روابط الصفحات فقط — ملف الأنماط المشترك /assets/js/admin/admin-style.css أصل لا تنقّل.
    assert.ok(!html.includes('href="/admin/') && !html.includes("href='/admin/"), 'صفحة التكاملات ما زالت تربط صفحة /admin/');
    assert.ok(html.includes('id="mcp"'), 'قسم خوادم MCP');
    assert.ok(html.includes('id="mcpAdd"') && html.includes('id="mcpTable"'));
    assert.ok(html.includes('href="#mcp"'), 'رابط الرأس إلى قسم MCP داخل الصفحة');
    const src = read('assets/js/owner/pages/integrations.js');
    for (const fn of ['owner_list_mcp_servers', 'saveCredentials', 'startOAuth', 'testServer', 'createServer', 'updateServer', 'deleteServer']) {
        assert.ok(src.includes(fn), fn);
    }
    assert.ok(!src.includes('/admin/*.html'), 'بلا روابط لصفحات /admin/ في منطق الصفحة');
    assert.ok(src.includes("update({ is_active: active, revoked_at: active ? null : new Date().toISOString() })"), 'إصلاح patch غير المعرّف في إيقاف/تفعيل المفتاح');
});
