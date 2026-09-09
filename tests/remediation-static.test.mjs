// Structural regression tests for the remediation pass.
//
// check-dns-status, sie-channel-telegram and the OAuth functions import from
// jsr:/npm:/https: specifiers that Node cannot resolve, so they are asserted
// against their source rather than executed. Each test pins one property the
// audit asked for, so a future edit that reintroduces the defect fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

// Strip `//` line comments and the env-var default, so the ".online must be
// gone" assertions look at executable code and not at the explanatory notes
// (which necessarily name both domains).
const codeOnly = (src) =>
  src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n')
    .replace(/\?\?\s*"https:\/\/mad3oom\.online"/g, '')
    .replace(/\?\?\s*"mad3oom\.online"/g, '');

function grepRepo(pattern) {
  try {
    return execFileSync('grep', [
      '-rIl', pattern, '.',
      '--exclude-dir=.git', '--exclude-dir=node_modules', '--exclude-dir=tests',
      '--exclude-dir=docs', '--exclude-dir=migrations',
      '--exclude=_AUDIT_NOTES.md', '--exclude=DOMAIN-MIGRATION.md',
    ], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch {
    return []; // grep exits 1 on no match
  }
}

// ── Phase A: gemini-proxy removal ───────────────────────────────────────────

test('gemini-proxy source is gone', () => {
  assert.equal(existsSync(path.join(ROOT, 'supabase/functions/gemini-proxy')), false);
});

test('nothing in the repository references gemini-proxy', () => {
  assert.deepEqual(grepRepo('gemini-proxy'), [],
    'a caller reappeared — it must be removed or repointed before deploying the deletion');
});

// ── Phase D: check-dns-status authorization ─────────────────────────────────

const dns = read('supabase/functions/check-dns-status/index.ts');

test('check-dns-status requires an authenticated caller', () => {
  assert.match(dns, /supabase\.auth\.getUser\(jwt\)/);
  assert.match(dns, /غير مصرح/);
});

test('check-dns-status authorizes against the specific record (admin or owner)', () => {
  assert.match(dns, /const isAdmin = callerProfile\?\.role === "admin"/);
  assert.match(dns, /const isOwner = row\.user_id === callerId/);
  assert.match(dns, /if \(!isAdmin && !isOwner\)/);
});

test('check-dns-status introduces no new role', () => {
  const roles = [...dns.matchAll(/role\s*===\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(roles)], ['admin']);
});

test('check-dns-status still performs the real HTTPS verification', () => {
  assert.match(dns, /method: "HEAD"/);
  assert.match(dns, /isDomainResponding/);
});

test('check-dns-status guards the transition so polling cannot double-notify', () => {
  assert.match(dns, /\.eq\("status", "propagating"\)/,
    'the UPDATE must be conditional on the prior status');
  assert.match(dns, /updated && updated\.length > 0/,
    'the notification must depend on this request being the one that transitioned the row');
});

test('both check-dns-status callers send an Authorization header', () => {
  for (const page of ['subdomains/create-subdomain.html', 'subdomains/manage-subdomains.html']) {
    const src = read(page);
    const call = src.slice(src.indexOf('fetch(CHECK_DNS_FN_URL'));
    const block = call.slice(0, call.indexOf('});') + 3);
    assert.match(block, /Authorization/, `${page} must authenticate its check-dns-status call`);
  }
});

test('check-dns-status and its callers form one atomic deployment unit', () => {
  // The function requires a session; the callers must send one. If either side
  // ships alone, DNS propagation polling breaks. This test fails if they drift.
  const fnRequiresAuth = /supabase\.auth\.getUser\(jwt\)/.test(dns) && /غير مصرح/.test(dns);
  assert.ok(fnRequiresAuth, 'the function requires authentication');

  for (const page of ['subdomains/create-subdomain.html', 'subdomains/manage-subdomains.html']) {
    const src = read(page);
    const idx = src.indexOf('fetch(CHECK_DNS_FN_URL');
    assert.ok(idx !== -1, `${page} still calls check-dns-status`);
    const block = src.slice(idx, src.indexOf('});', idx) + 3);
    assert.match(block, /Authorization.*Bearer/s, `${page} must send a bearer token`);
    // …and the token must come from a real session, not a hard-coded value.
    const before = src.slice(Math.max(0, idx - 400), idx);
    assert.match(before, /await getAccessToken\(\)/, `${page} must take the token from the session`);
  }
});

test('every page that calls check-dns-status can actually obtain a session', () => {
  for (const page of ['subdomains/create-subdomain.html', 'subdomains/manage-subdomains.html']) {
    const src = read(page);
    const key = /SUPABASE_ANON_KEY\s*=\s*"([^"]+)"/.exec(src);
    assert.ok(key, `${page} defines a Supabase key`);
    assert.doesNotMatch(key[1], /^REPLACE_WITH/,
      `${page} ships a placeholder key, so getSession() can never work`);
    const [, payload] = key[1].split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    assert.equal(claims.role, 'anon', `${page} must use the public anon key, never a privileged one`);
  }
});

test('no page anywhere still ships a placeholder Supabase key', () => {
  assert.deepEqual(grepRepo('REPLACE_WITH_YOUR_SUPABASE_ANON_KEY'), []);
});

// ── Phase E: sie-channel-telegram GET authorization ─────────────────────────

const SIE_DIR = 'supabase/functions/sie-channel-telegram';
const sie = read(`${SIE_DIR}/index.ts`);

test('sie-channel-telegram has exactly one entrypoint, named as deployed', () => {
  const files = readdirSync(path.join(ROOT, SIE_DIR)).filter((f) => f.endsWith('.ts'));
  assert.deepEqual(files, ['index.ts'],
    'the deployed function entrypoint is index.ts; a stray index.remote.ts would not deploy');
});

test('sie-channel-telegram GET is admin-gated', () => {
  assert.match(sie, /if \(req\.method === 'GET'\) \{\s*\n\s*if \(!await isAdminCaller\(req\)\)/,
    'the admin check must be the first thing the GET branch does');
  assert.match(sie, /status: 401/);
});

test('sie-channel-telegram admin check reads a real session and the admin role', () => {
  assert.match(sie, /supabase\.auth\.getUser\(jwt\)/);
  assert.match(sie, /profile\?\.role === 'admin'/);
});

test('autoRegisterWebhook is only reachable from the gated self-check', () => {
  const calls = [...sie.matchAll(/await autoRegisterWebhook\(/g)];
  assert.equal(calls.length, 1, 'exactly one call site');
  const idx = sie.indexOf('await autoRegisterWebhook(');
  const fnStart = sie.lastIndexOf('async function selfCheck', 0 + idx);
  assert.ok(fnStart !== -1 && fnStart < idx, 'its only call site is inside selfCheck()');
});

test('the Telegram POST webhook path is unchanged', () => {
  assert.match(sie, /if \(!BOT_TOKEN \|\| !WEBHOOK_SECRET\) \{/);
  assert.match(sie, /return new Response\('misconfigured', \{ status: 500 \}\)/);
  assert.match(sie, /await handleInbound\(\{/);
  assert.match(sie, /result\.status === 'unverified'/);
  // Telegram must still get a 200 on internal failure so it does not retry.
  assert.match(sie, /logger\.error\('the webhook threw'[\s\S]*?return new Response\('ok', \{ status: 200 \}\)/);
});

// ── Phase C: verify-2fa (structure; behaviour is covered by verify-2fa.test.mjs)

const twofa = read('supabase/functions/verify-2fa/index.ts');

test('verify-2fa never decodes the TOTP from the request body directly', () => {
  assert.match(twofa, /base32Decode\(secretToVerify\)/);
  assert.doesNotMatch(twofa, /base32Decode\(tempSecret\)/);
});

test('verify-2fa resolves identity through GoTrue, not an unverified claim', () => {
  assert.match(twofa, /auth\/v1\/user/);
  assert.doesNotMatch(twofa, /getUserIdFromJWT/, 'the unverified decoder should be gone');
});

test('verify-2fa scopes the secret lookup to the authenticated user', () => {
  assert.match(twofa, /profiles\?id=eq\.\$\{userId\}/);
});

// ── Phase B: the legacy plaintext WhatsApp path is now CLOSED ───────────────
//
// هذا الاختبار كان يثبّت الحالة القديمة عمدًا («Phase B ما زالت موقوفة»). نُفِّذت
// المرحلة الآن، فقُلب التأكيد ليثبّت الحالة الجديدة: لا مسار نصّي، ولا حتى
// قراءة للعمود. الشرط الذي علّقه TODO تحقّق وقيس على الإنتاج قبل الإزالة:
// كل صفوف integrations لمزوّد whatsapp لديها encrypted_access_token، وصفر صف
// نصّي فقط. وmigrations/032 يفرّغ العمود بعدها.

test('whatsapp-graph-request is mirrored so this assertion can actually run', () => {
  assert.ok(existsSync(path.join(ROOT, 'supabase/functions/whatsapp-graph-request/index.ts')),
    'a missing file must fail this test, not silently skip it');
});

test('the legacy plaintext token fallback is gone (Phase B executed)', () => {
  const src = read('supabase/functions/whatsapp-graph-request/index.ts');
  // السلوك، لا التعليق: لا إسناد من العمود النصّي، ولا علَم، ولا سجل له.
  assert.doesNotMatch(src, /accessToken = integration\.access_token;/,
    'the plaintext fallback assignment is still there');
  assert.doesNotMatch(src, /usedLegacyPlaintextToken/,
    'the legacy flag is still there');
  assert.doesNotMatch(src, /legacy_plaintext_token_used/,
    'the legacy warning log is still there');
  // ولا يُقرأ العمود أصلًا: اعتماد نرفض استعماله لا داعي لتحميله في الذاكرة.
  assert.doesNotMatch(src, /select\("encrypted_access_token, access_token/,
    'the plaintext column is still being selected');
  assert.match(src, /select\("encrypted_access_token, metadata"\)/);
  // والمشفَّر صار شرطًا لا تفضيلًا.
  assert.match(src, /if \(!integration \|\| !integration\.encrypted_access_token\)/);
});

test('pi-auth issues a one-time token and never a derived password', () => {
  const src = read('supabase/functions/pi-auth/index.ts');
  assert.match(src, /generateLink/, 'session must be issued via a one-time token');
  // شكل النداء لا الكلمة: التعليق في المصدر يذكر المسار المغلق بالاسم عمدًا.
  assert.doesNotMatch(src, /signInWithPassword\s*\(/, 'the derived-credential login path is back');
  assert.match(src, /crypto\.randomUUID\(\)/, 'passwords must be random, not derived');
  // لا اشتقاق من المعرّف في أي موضع
  assert.doesNotMatch(src, /Pi_\$\{piUid\}/, 'password is derived from the Pi identifier');
  assert.match(src, /updateUserById/, 'each exchange must invalidate the old credential');
});

// ── Phase F: domain migration readiness ─────────────────────────────────────

const ORIGIN_FILES = [
  'supabase/functions/oauth-discovery/index.ts',
  'supabase/functions/oauth-protected-resource/index.ts',
  'supabase/functions/oauth-authorize/index.ts',
  'supabase/functions/mcp-oauth-callback/index.ts',
];

test('every OAuth origin is read from one variable', () => {
  for (const f of ORIGIN_FILES) {
    assert.match(read(f), /Deno\.env\.get\("PUBLIC_SITE_ORIGIN"\)/, `${f} must read PUBLIC_SITE_ORIGIN`);
  }
});

test('the default keeps today behaviour exactly, so deploying is a no-op', () => {
  for (const f of ORIGIN_FILES) {
    assert.match(read(f), /\?\?\s*"https:\/\/mad3oom\.online"/, `${f} must default to the current origin`);
  }
});

test('no OAuth function still hard-codes a .online URL', () => {
  for (const f of ORIGIN_FILES) {
    assert.doesNotMatch(codeOnly(read(f)), /mad3oom\.online/,
      `${f} has a .online literal in code outside the env default`);
  }
});

test('the OAuth issuer and the metadata endpoints move together', () => {
  const disc = read('supabase/functions/oauth-discovery/index.ts');
  assert.match(disc, /const issuer = PUBLIC_SITE_ORIGIN;/);
  for (const ep of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
    assert.match(disc, new RegExp(`${ep}: \\\`\\$\\{issuer\\}`), `${ep} must derive from the issuer`);
  }
  assert.match(disc, /service_documentation: issuer/);
});

test('the subdomain root domain is env-driven and defaults to today value', () => {
  for (const f of ['supabase/functions/create-subdomain/index.ts',
                   'supabase/functions/request-subdomain/index.ts']) {
    const src = read(f);
    assert.match(src, /Deno\.env\.get\("SUBDOMAIN_ROOT_DOMAIN"\) \?\? "mad3oom\.online"/, f);
    assert.doesNotMatch(codeOnly(src), /mad3oom\.online/,
      `${f} still has a hard-coded .online literal in code`);
  }
});

test('the operational migration checklist is committed alongside the code', () => {
  const doc = read('docs/DOMAIN-MIGRATION.md');
  for (const marker of ['PUBLIC_SITE_ORIGIN', 'SUBDOMAIN_ROOT_DOMAIN', 'Cloudflare', 'Vercel',
                        'teha.mad3oom.online', 'admins.mad3oom.online']) {
    assert.ok(doc.includes(marker), `checklist must cover ${marker}`);
  }
});

// ── Deferred items must remain untouched ────────────────────────────────────

// The branch point. Everything this work added sits between BASE and HEAD, so
// diffing that range is what actually proves a deferred file was left alone.
// `git diff HEAD` compares the worktree to the last commit and is empty the
// moment anything is committed — it proves nothing, which is what the previous
// version of this test did.
const BASE = (() => {
  for (const ref of ['origin/main', 'main']) {
    try {
      return execFileSync('git', ['merge-base', 'HEAD', ref], { cwd: ROOT, encoding: 'utf8' }).trim();
    } catch { /* try the next ref */ }
  }
  throw new Error('cannot resolve the branch base; the deferred-files test cannot run');
})();

function changedSince(base, head = 'HEAD') {
  return execFileSync('git', ['diff', '--name-only', `${base}..${head}`], { cwd: ROOT, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
}

const DEFERRED = [
  'supabase/functions/check-subdomain-status/index.ts',
  'supabase/functions/send-ticket-email/index.ts',
  'supabase/functions/landing-contact/index.ts',
];

// The deferred files were ADDED by the audit commit as verbatim mirrors of what
// production runs. The invariant to protect is therefore "unchanged since the
// commit that mirrored it" — a range diff from the branch base would flag the
// original addition and prove nothing about later edits.
function addedIn(file) {
  const commits = execFileSync('git', ['log', '--diff-filter=A', '--format=%H', '--', file],
    { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  assert.ok(commits.length > 0, `${file} has an add commit`);
  return commits[0]; // most recent add
}

test('the deferred files are byte-unchanged since they were mirrored', () => {
  assert.ok(changedSince(BASE).length > 0, 'sanity: the branch must actually contain changes');
  for (const f of DEFERRED) {
    const changed = changedSince(addedIn(f));
    assert.ok(!changed.includes(f),
      `${f} is on the deferred list and has been edited since it was mirrored`);
  }
});

test('that check would actually catch a modification to a deferred file', () => {
  // Negative control. Pick a commit range that DOES touch a deferred file and
  // confirm the same predicate rejects it, so a green result means something.
  const anyDeferredEverTouched = execFileSync(
    'git', ['log', '--format=%H', '--follow', '--', DEFERRED[0]],
    { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  assert.ok(anyDeferredEverTouched.length > 0, 'the deferred file exists in history');
  const introducing = anyDeferredEverTouched[anyDeferredEverTouched.length - 1];
  const changed = changedSince(`${introducing}^`, introducing);
  assert.ok(changed.includes(DEFERRED[0]),
    'the predicate flags a range that really does touch the deferred file');
});

test('admin-fix-webhook-subscription is still not mirrored (its token stays out of git)', () => {
  assert.equal(existsSync(path.join(ROOT, 'supabase/functions/admin-fix-webhook-subscription')), false);
  assert.deepEqual(grepRepo('mad3oom-wa-fix'), []);
});


// ── 2FA bypass closure (behaviour proven by tests/sql/2fa-trigger.test.sql
//    and tests/disable-2fa.test.mjs; these pin the wiring) ──────────────────

test('the 2FA trigger migration exists and is scoped to the three columns', () => {
  const sql = read('migrations/006_2fa_change_requires_challenge.sql');
  assert.match(sql, /IF auth\.uid\(\) IS NULL THEN\s*\n\s*RETURN NEW;/,
    'service_role and pg_cron must stay exempt');
  assert.match(sql, /COALESCE\(OLD\.two_factor_enabled, false\) = false/,
    'enrollment must stay unguarded');
  for (const col of ['two_factor_enabled', 'two_factor_secret', 'recovery_codes']) {
    assert.match(sql, new RegExp(`NEW\\.${col}\\s+IS DISTINCT FROM OLD\\.${col}`), col);
  }
  assert.match(sql, /BEFORE UPDATE ON public\.profiles/);
});

test('no browser code writes the 2FA columns directly any more', () => {
  for (const f of ['2fa-service.js', 'customer-settings-modal.js',
                   'customer-security-settings.html', 'admin-security-settings.html']) {
    const src = read(f);
    assert.doesNotMatch(src, /two_factor_enabled:\s*false/, `${f} still disables 2FA directly`);
    assert.doesNotMatch(src, /two_factor_secret:\s*null/, `${f} still clears the secret directly`);
  }
});

test('every disable path goes through the disable-2fa function with proof', () => {
  assert.match(read('2fa-service.js'), /functions\.invoke\('disable-2fa'/);
  assert.match(read('customer-settings-modal.js'), /functions\.invoke\('disable-2fa'/);
  for (const page of ['customer-security-settings.html', 'admin-security-settings.html']) {
    assert.match(read(page), /disable2FA\(currentUser\.id, proof\)/, `${page} must pass proof`);
  }
});

test('disable-2fa refuses to act without a code and writes as the service role', () => {
  const src = read('supabase/functions/disable-2fa/index.ts');
  assert.match(src, /if \(!code && !recoveryCode\)/);
  assert.match(src, /auth\/v1\/user/, 'identity must come from GoTrue');
  assert.match(src, /Authorization: `Bearer \$\{SERVICE_ROLE_KEY\}`/);
  assert.match(src, /two_factor_enabled: false, two_factor_secret: null, recovery_codes: null/);
});
