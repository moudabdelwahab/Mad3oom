/**
 * حالة «قيد المعالجة» في القاعدة هي 'in-progress' بشرطة (migrations/034،
 * constants.js). أي 'in_progress' في الواجهة كان بيصفّر عداد لوحة التحكم،
 * ويعرض الحالة كنص خام، وكان معالج الأتمتة بيكتب قيمة ماتعرفهاش باقي اللوحات.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
// assets/js/relay: حالات سجلات Relay مجال منفصل عن التذاكر، قيمها مثبّتة بقيد
// CHECK في migrations/073 ومطابقتها مقيسة في tests/relay-contract.test.mjs.
const SKIP = new Set(['node_modules', 'tests', 'migrations', 'supabase', '.git', 'docs', 'mcp', 'relay']);

function* walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) { if (!SKIP.has(entry.name)) yield* walk(path.join(dir, entry.name)); }
        else if (/\.(js|mjs|html)$/.test(entry.name)) yield path.join(dir, entry.name);
    }
}

test('مفيش in_progress كحالة تذكرة في الواجهة', () => {
    const offenders = [];
    for (const file of walk(ROOT)) {
        const text = fs.readFileSync(file, 'utf8');
        if (/\bin_progress\b/.test(text)) offenders.push(path.relative(ROOT, file));
    }
    assert.deepEqual(offenders, []);
});

test('عداد «قيد المعالجة» في لوحة التحكم بيعد القيمة المخزّنة', () => {
    const src = fs.readFileSync(path.join(ROOT, 'assets/js/admin/dashboard-logic.js'), 'utf8');
    assert.match(src, /t\.status === 'in-progress'/);
});
