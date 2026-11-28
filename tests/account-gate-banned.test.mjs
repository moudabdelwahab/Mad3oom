// Static tests for the 'banned' gate branch (migration 160) and its UI.
//
// The behaviour itself is proven in SQL (tests/sql/account-gate-ban-160
// .test.sql); these tests pin the wiring that SQL cannot see: the gate page
// shows a banned step instead of the phone step, and the admin users page
// bans through the ban-user Edge Function instead of a direct PostgREST
// update that never revoked anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const gateHtml = readFileSync(path.join(ROOT, 'account-gate.html'), 'utf8');
const usersJs = readFileSync(path.join(ROOT, 'assets/js/admin/users.js'), 'utf8');
const migration = readFileSync(path.join(ROOT, 'migrations/160_my_account_gate_banned_branch.sql'), 'utf8');

test('شاشة البوابة تعرض خطوة محظور (سبب + نهاية + خروج) بدل شاشة الهاتف', () => {
  assert.ok(gateHtml.includes('id="step-banned"'), 'missing step-banned section');
  assert.ok(gateHtml.includes('id="banned-reason"'), 'missing banned reason element');
  assert.ok(gateHtml.includes('id="banned-until"'), 'missing banned until element');
  assert.ok(gateHtml.includes('id="banned-logout"'), 'missing banned logout button');
  assert.ok(gateHtml.includes("$('banned-logout').addEventListener('click', signOutAndLeave)"),
    'banned logout must sign out like the other steps');
  assert.ok(gateHtml.includes("if (status === 'banned')"), 'evaluate() must branch on banned');
  // الفرع قبل الوقوع في شاشة الهاتف: ترتيب الظهور في الملف.
  assert.ok(
    gateHtml.indexOf("if (status === 'banned')") < gateHtml.indexOf("showStep('step-phone')"),
    'banned branch must come before the phone-step fallthrough',
  );
  assert.ok(gateHtml.includes('data?.ban_reason'), 'banned step must read ban_reason from the gate');
  assert.ok(gateHtml.includes('data?.banned_until'), 'banned step must read banned_until from the gate');
});

test('لوحة الأدمن تحظر/ترفع عبر Edge Function لا بتحديث PostgREST مباشر', () => {
  assert.ok(usersJs.includes("supabase.functions.invoke('ban-user'"), 'ban must go through ban-user');
  assert.ok(usersJs.includes("action: 'ban'"), 'ban action must be passed');
  assert.ok(usersJs.includes("action: 'unban'"), 'unban action must be passed');
  assert.ok(!usersJs.includes('.update({ ban_status'), 'no direct profiles ban_status update may remain');
  assert.ok(usersJs.includes('auth_ban_applied'), 'UI must surface an Auth-ban failure instead of hiding it');
  assert.ok(usersJs.includes('sessions.revoked'), 'UI must surface the no-admin-signout note');
});

test('كل مسارات الكتابة على الحظر تمر عبر ban-user: صفحة المحظورين ولوحة المالك أيضًا', () => {
  // البند (ب) يخص كل حظر، لا زر users.js وحده: حظر من لوحة المالك أو
  // رفع من صفحة المحظورين كان يكتب profiles وحدها بلا مرآة Auth.
  const bannedJs = readFileSync(path.join(ROOT, 'assets/js/admin/banned.js'), 'utf8');
  assert.ok(bannedJs.includes("supabase.functions.invoke('ban-user'"), 'banned page unban must go through ban-user');
  assert.ok(!bannedJs.includes('.update({ ban_status'), 'no direct profiles ban_status update may remain in banned.js');
  const ownerActionsJs = readFileSync(path.join(ROOT, 'assets/js/owner/owner-user-actions.js'), 'utf8');
  assert.ok(ownerActionsJs.includes("functions.invoke('ban-user'"), 'owner ban/unban must go through ban-user');
  assert.ok(!ownerActionsJs.includes("rpc('owner_ban_user'"), 'owner UI must not call owner_ban_user anymore');
  const ownerModel = readFileSync(path.join(ROOT, 'assets/js/owner/owner-user-actions-model.js'), 'utf8');
  assert.ok(ownerModel.includes('banUserBody') && ownerModel.includes('unbanUserBody'), 'owner model must build ban-user bodies');
  assert.ok(ownerModel.includes('banUserResult'), 'owner model must map ban-user results');
});

test('الترحيل 160: فرع banned أولًا في my_account_gate() مع الحقلين، والتراجع موجود', () => {
  assert.ok(migration.includes("when public.is_banned()"), 'gate must check is_banned()');
  assert.ok(migration.includes("then 'banned'"), 'gate must return the banned status');
  assert.ok(
    migration.indexOf("then 'banned'") < migration.indexOf("then 'active'"),
    'banned branch must precede the active branch',
  );
  assert.ok(migration.includes("'banned_until'"), 'gate must expose banned_until');
  assert.ok(migration.includes("'ban_reason'"), 'gate must expose ban_reason');
  assert.ok(migration.includes('account_is_active()'), 'gate must keep the 144 wiring');
  assert.ok(
    existsSync(path.join(ROOT, 'migrations/_rollback/160_my_account_gate_banned_branch.down.sql')),
    'rollback file must exist',
  );
});
