/**
 * المساحة الداخلية «relay» صارت «continuity» (migrations/077_continuity_namespace.sql).
 *
 * حارس ثابت: لا ذكر لـ relay في كود التطبيق أو الواجهة أو الاختبارات الحالية، إلا
 * في الاستثناءات الموثقة أدناه (docs/continuity/NAMESPACE_RENAME.md §4). القاعدة
 * نفسها مقيسة في tests/sql/continuity-namespace.test.sql.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

// مجلدات تاريخية أو خارج النطاق، كلها موثقة كاستثناء.
const SKIP_DIRS = new Set([
    'node_modules', '.git',
    'migrations',            // 073/074/076 مطبقة ولا تُعدَّل؛ 077 نفسه يسمّي relay_* ليعيد تسميتها.
    'docs',                  // سجل تاريخي (قرارات ومذكرات تثبيت بأسماء ما طُبّق فعلًا).
    'mcp',                   // كلمة «relay» الإنجليزية العامة (notification relay)، لا علاقة لها.
]);
// ملفات بعينها: السبب لكل واحد.
const ALLOWED_FILES = new Map([
    ['vercel.json', 'تحويل /admin/relay.html → /admin/continuity.html للروابط القديمة'],
    ['tests/continuity-namespace.test.mjs', 'هذا الحارس'],
    ['tests/continuity-contract.test.mjs', 'يقرأ migrations/073_relay_core.sql كما كُتب'],
    ['tests/continuity-model.test.mjs', 'يقرأ migrations/074_relay_phase_c.sql كما كُتب'],
    ['tests/continuity-phase-c.render.test.mjs', 'يشير لملف SQL التاريخي tests/sql/relay-phase-c.test.sql'],
    ['tests/company-navigation.test.mjs', 'سجل الترحيلات بأسماء ملفاتها'],
    ['assets/js/continuity/continuity-contract.js', 'تعليق يشير لـ migrations/073_relay_core.sql'],
]);
// ملفات SQL الاختبارية للترحيلات التاريخية تطبّق 073/074/076 وتختبرها بأسمائها كما هي.
const ALLOWED_PREFIXES = ['tests/sql/'];

function* walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name)) yield* walk(path.join(dir, e.name));
        } else if (/\.(js|mjs|html|css|json|ts|sql)$/.test(e.name)) {
            yield path.join(dir, e.name);
        }
    }
}

test('لا ذكر لـ relay خارج الاستثناءات الموثقة', () => {
    const offenders = [];
    for (const file of walk(ROOT)) {
        const rel = path.relative(ROOT, file).split(path.sep).join('/');
        if (ALLOWED_FILES.has(rel) || ALLOWED_PREFIXES.some((p) => rel.startsWith(p))) continue;
        const text = fs.readFileSync(file, 'utf8');
        if (/relay/i.test(text)) offenders.push(rel);
    }
    assert.deepEqual(offenders, [], `relay ما زال مذكورًا في: ${offenders.join(', ')}`);
});

test('الاستثناءات في ملفات الواجهة والاختبار تشير لأسماء تاريخية فقط', () => {
    // أسماء ملفات الترحيلات واختبارات SQL التاريخية، والصفحة القديمة، ومعرّفات relay_* (أو أنماطها) في 073/074.
    const historical = /(\d{3}_relay_\w+\.sql|tests\/sql\/relay-[\w-]+\.test\.sql|\/admin\/relay\.html|_?relay_[\w*\\]*)/g;
    for (const rel of ALLOWED_FILES.keys()) {
        // الحارس نفسه، وسجل الترحيلات (تاريخ مكتوب: «073 — Relay المرحلة B…») مستثنيان بالكامل.
        if (rel === 'tests/continuity-namespace.test.mjs' || rel === 'tests/company-navigation.test.mjs') continue;
        const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        const stray = text.replace(historical, '').match(/relay/gi);
        assert.equal(stray, null, `${rel}: ذكر relay غير تاريخي`);
    }
});

test('الصفحة القديمة تتحول للجديدة مع الاستعلام، والملفات القديمة اختفت', () => {
    const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    const r = vercel.redirects.find((x) => x.source === '/admin/relay.html');
    assert.ok(r && r.destination === '/admin/continuity.html', 'تحويل /admin/relay.html مفقود');
    for (const gone of ['admin/relay.html', 'assets/css/relay.css', 'assets/js/relay']) {
        assert.ok(!fs.existsSync(path.join(ROOT, gone)), `${gone} ما زال موجودًا`);
    }
    for (const now of ['admin/continuity.html', 'assets/css/continuity.css', 'assets/js/continuity/continuity-data.js']) {
        assert.ok(fs.existsSync(path.join(ROOT, now)), `${now} مفقود`);
    }
});

test('الواجهة تنادي continuity_* فقط', () => {
    const data = fs.readFileSync(path.join(ROOT, 'assets/js/continuity/continuity-data.js'), 'utf8');
    const rpcs = [...data.matchAll(/(?:call|rpc)\('([a-z_]+)'/g)].map((m) => m[1]);
    assert.ok(rpcs.length >= 15, 'عدد النداءات');
    for (const name of rpcs) {
        assert.ok(name.startsWith('continuity_') || name.startsWith('inbox_'), `نداء غير متوقع: ${name}`);
    }
});
