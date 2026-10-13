/**
 * إضافة «مدعوم» لووردبريس (integrations/wordpress/mad3oom-support).
 *
 *   • php -l لكل ملف PHP.
 *   • tests/wordpress/plugin-tests.php على بدائل ووردبريس (ليست ووردبريس حقيقيًا).
 *   • توقيع PHP يساوي توقيع الدالة الطرفية (wordpress.js) لنفس المدخلات —
 *     الطرفان يجب أن يتفقا حرفيًا وإلا رفض الخادم كل طلب.
 *   • ملف ZIP المرفق يطابق المصدر بايتًا ببايت (لا انحراف بين المصدر والحزمة).
 *
 * يتخطّى بصوت عالٍ إن لم يوجد php — ولا يدّعي النجاح.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as WP from '../supabase/functions/_shared/integrations/wordpress.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLUGIN = path.join(ROOT, 'integrations/wordpress/mad3oom-support');
const ZIP = path.join(ROOT, 'integrations/wordpress/mad3oom-support-0.1.0.zip');
const php = spawnSync('php', ['-v'], { encoding: 'utf8' }).status === 0;
if (!php) console.error('SKIP: php not found; WordPress plugin tests NOT executed');

function phpFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? phpFiles(path.join(dir, e.name)) : e.name.endsWith('.php') ? [path.join(dir, e.name)] : []);
}

test('every plugin PHP file passes php -l', { skip: !php && 'no php' }, () => {
    for (const f of phpFiles(PLUGIN)) {
        const r = spawnSync('php', ['-l', f], { encoding: 'utf8' });
        assert.equal(r.status, 0, `${f}: ${r.stdout}${r.stderr}`);
    }
});

test('plugin behaviour on WordPress stubs, and the PHP signature equals the Edge Function signature', { skip: !php && 'no php' }, async () => {
    const valid = WP.pairingCode({ connectionId: '44444444-4444-4444-8444-444444444444', secret: 'p'.repeat(43),
                                   endpoint: 'https://proj.supabase.co/functions/v1/integrations-inbound' });
    const evil = WP.pairingCode({ connectionId: '44444444-4444-4444-8444-444444444444', secret: 'p'.repeat(43),
                                  endpoint: 'https://attacker.example/collect' });
    const r = spawnSync('php', [path.join(ROOT, 'tests/wordpress/plugin-tests.php'), valid, evil], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /ALL WORDPRESS PLUGIN TESTS PASSED/);
    const passes = r.stdout.split('\n').filter((l) => l.startsWith('PASS '));
    assert.equal(passes.length, 8, r.stdout);

    const phpSig = r.stdout.match(/^SIGVECTOR (.+)$/m)[1];
    const jsSig = await WP.signRequest('vector-secret-0123456789abcdef', {
        timestamp: '1760263200', nonce: 'n'.repeat(24), method: 'post', path: '/wordpress/v1/intake',
        rawBody: new TextEncoder().encode('{"name":"سارة"}')
    });
    assert.equal(phpSig, jsSig, 'PHP and the Edge Function must sign identically');
});

test('the shipped ZIP matches the plugin source byte for byte', () => {
    assert.ok(fs.existsSync(ZIP), 'run integrations/wordpress/tools/build-zip.sh');
    const list = spawnSync('unzip', ['-Z1', ZIP], { encoding: 'utf8' });
    if (list.status !== 0) { console.error('SKIP: unzip not available'); return; }
    const entries = list.stdout.split('\n').filter((l) => l && !l.endsWith('/')).sort();
    const source = [];
    const walk = (d, rel) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.isDirectory()) walk(path.join(d, e.name), `${rel}${e.name}/`);
            else source.push(`mad3oom-support/${rel}${e.name}`);
        }
    };
    walk(PLUGIN, '');
    assert.deepEqual(entries, source.sort());
    for (const entry of entries) {
        const inZip = spawnSync('unzip', ['-p', ZIP, entry]).stdout;
        const onDisk = fs.readFileSync(path.join(PLUGIN, entry.replace(/^mad3oom-support\//, '')));
        assert.ok(Buffer.compare(inZip, onDisk) === 0, `${entry} differs from the source`);
    }
});

test('static: the plugin ships no JavaScript and never echoes the stored secret', () => {
    const all = phpFiles(PLUGIN).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    assert.ok(!fs.readdirSync(PLUGIN, { recursive: true }).some((f) => String(f).endsWith('.js')));
    assert.doesNotMatch(all, /echo[^;]*secret\(\)/);
    assert.doesNotMatch(all, /wp_remote_(get|post|request)\(/, 'only wp_safe_remote_post is used');
    assert.doesNotMatch(all, /error_log\(|var_dump\(|print_r\(/);
    assert.match(all, /'sslverify'\s*=>\s*true/);
    assert.match(all, /'redirection'\s*=>\s*0/);
});
