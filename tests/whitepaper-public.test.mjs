// Guards the public edition of the white paper (docs/whitepaper).
//
// The public sources (content_public/, diagrams_public.py) are published, so they must not carry the kind of
// internal-state language that belongs only in internal engineering records: audit and remediation wording,
// production-deployment state, migration numbers, database-privilege mechanics. The patterns here are
// deliberately generic. The detailed review of what must not be published lives in restricted internal records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'whitepaper');
const src = join(root, 'src');

const files = [
    ...readdirSync(join(src, 'content_public')).filter((f) => f.endsWith('.py')).map((f) => join(src, 'content_public', f)),
    join(src, 'diagrams_public.py'),
];

const FORBIDDEN = [
    [/\binternal (engineering )?(audit|review)s?\b/i, 'internal audit/review wording'],
    [/\bremediation\b/i, 'remediation wording'],
    [/\bwork packages?\b|\bWP\d\b/i, 'work-package wording'],
    [/\b(not )?applied to (the )?production\b|\binstalled in production\b|\bin production on\b/i, 'production-deployment state'],
    [/\bflags? (are |is )?closed\b|\bevery (feature )?flag\b/i, 'feature-flag state'],
    [/SECURITY\s+DEFINER|\bpg_cron\b|\bpg_net\b/i, 'database mechanics'],
    [/\b0(6[4-9]|7[0-9])\b/, 'migration number'],
    [/\bwritten and tested locally\b/i, 'local-only state'],
];

test('public white paper sources carry no internal-state wording', () => {
    for (const file of files) {
        const text = readFileSync(file, 'utf8');
        for (const [re, what] of FORBIDDEN) {
            assert.ok(!re.test(text), `${file.split('/whitepaper/')[1]}: ${what} (${re})`);
        }
    }
});

test('public edition keeps the compliance and assurance statements', () => {
    const ch9 = readFileSync(join(src, 'content_public', 'ch09.py'), 'utf8');
    for (const phrase of ['GDPR', 'ISO 27001', 'SOC 2', 'independent penetration test']) {
        assert.ok(ch9.includes(phrase), `chapter 9 must keep "${phrase}"`);
    }
});

test('public PDFs, when present, are named as specified and carry no attachments', () => {
    const dir = join(root, 'public');
    if (!existsSync(dir)) return;
    const names = readdirSync(dir).filter((f) => f.endsWith('.pdf')).sort();
    const allowed = ['Mad3oom_White_Paper_AR_Public.pdf', 'Mad3oom_White_Paper_EG.pdf', 'Mad3oom_White_Paper_EN_Public.pdf'];
    for (const n of names) assert.ok(allowed.includes(n), `unexpected file in public/: ${n}`);
    for (const n of names) {
        const raw = readFileSync(join(dir, n)).toString('latin1');
        assert.ok(raw.startsWith('%PDF-'), `${n} is not a PDF`);
        assert.ok(!/\/EmbeddedFile|\/Filespec|\/AF\s*\[|\/JavaScript|\/OCProperties/.test(raw), `${n} has attachments, scripts or layers`);
    }
});
