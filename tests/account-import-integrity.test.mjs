// PS-01 and PS-15 had the same root cause: a page imported a name its module
// never exported (resetPasswordEmail, generateSecret, getQRCodeUrl). In an ES
// module that is a link error — the whole script dies and every button on the
// page silently does nothing. This checks every named import, in every page
// and module touched by the Profile & Security work, against the real file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const FILES = [
    'forgot-password.html', 'reset-password.html', 'login.html', 'telegram-otp.html',
    'admin-security-settings.html', 'customer-security-settings.html', 'customer-dashboard.html',
    'customer-dashboard.js', 'customer-settings-modal.js',
    'assets/js/account/account-settings.js', 'assets/js/account/account-service.js',
    'assets/js/company/company-account.js', 'assets/js/admin/settings.js'
];

function moduleSources(file) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (!file.endsWith('.html')) return [src];
    return [...src.matchAll(/<script type="module"[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
}

function exportsOf(file) {
    const src = fs.readFileSync(file, 'utf8');
    const names = new Set();
    for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
    for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
        for (const part of m[1].split(',')) {
            const name = part.trim().split(/\s+as\s+/).pop().trim();
            if (name) names.add(name);
        }
    }
    return names;
}

function resolve(fromFile, spec) {
    if (/^https?:/.test(spec)) return null;
    const base = spec.startsWith('/') ? ROOT : path.dirname(path.join(ROOT, fromFile));
    return path.join(base, spec.replace(/^\//, ''));
}

test('every named import in the account pages exists in its module', () => {
    let checked = 0;
    for (const file of FILES) {
        for (const src of moduleSources(file)) {
            for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
                const target = resolve(file, m[2]);
                if (!target) continue;
                assert.ok(fs.existsSync(target), `${file}: imports missing file ${m[2]}`);
                const exported = exportsOf(target);
                for (const part of m[1].split(',')) {
                    const name = part.trim().split(/\s+as\s+/)[0].trim();
                    if (!name) continue;
                    assert.ok(exported.has(name), `${file}: '${name}' is not exported by ${m[2]}`);
                    checked++;
                }
            }
        }
    }
    assert.ok(checked > 30, `sanity: only ${checked} imports checked`);
});

test('the checker would have caught the original PS-01 / PS-15 defects', () => {
    const authExports = exportsOf(path.join(ROOT, 'auth-client.js'));
    assert.ok(authExports.has('resetPasswordEmail'), 'forgot-password.html needs it');
    const tfa = exportsOf(path.join(ROOT, '2fa-service.js'));
    assert.ok(!tfa.has('generateSecret') && !tfa.has('getQRCodeUrl'),
        'negative control: the names admin-security-settings.html used to import really do not exist');
});

test('no page sends the 2FA seed to a third-party QR service (PS-05)', () => {
    for (const file of FILES.concat(['2fa-service.js'])) {
        assert.doesNotMatch(fs.readFileSync(path.join(ROOT, file), 'utf8'), /api\.qrserver\.com/, file);
    }
});

test('login no longer reads the TOTP secret into the browser', () => {
    const login = fs.readFileSync(path.join(ROOT, 'login.html'), 'utf8');
    assert.doesNotMatch(login, /two_factor_secret/);
    assert.doesNotMatch(login, /tempSecret/);
    // After 049 the column is always NULL: gating on it would skip 2FA for everyone.
    assert.match(login, /if \(profile\?\.two_factor_enabled\) \{/);
});
