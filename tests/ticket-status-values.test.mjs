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
// assets/js/continuity: حالات سجلات الاستمرارية مجال منفصل عن التذاكر، قيمها مثبّتة
// بقيد CHECK في migrations/073 ومطابقتها مقيسة في tests/continuity-contract.test.mjs.
const SKIP = new Set(['node_modules', 'tests', 'migrations', 'supabase', '.git', 'docs', 'mcp', 'continuity']);
// 146: نفس المجال في لوحة الشركة — company-continuity-model.js يحمل حالات سجلات
// الاستمرارية ('in_progress' حالة سجل، لا حالة تذكرة) كما يفرضها عقد
// company_continuity_* في migrations/146؛ لا يحمل أي حالة تذكرة.
const FILE_SKIP = new Set(['assets/js/company/company-continuity-model.js']);

function* walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) { if (!SKIP.has(entry.name)) yield* walk(path.join(dir, entry.name)); }
        else if (/\.(js|mjs|html)$/.test(entry.name)) yield path.join(dir, entry.name);
    }
}

test('مفيش in_progress كحالة تذكرة في الواجهة', () => {
    const offenders = [];
    for (const file of walk(ROOT)) {
        const rel = path.relative(ROOT, file);
        if (FILE_SKIP.has(rel)) continue;
        const text = fs.readFileSync(file, 'utf8');
        if (/\bin_progress\b/.test(text)) offenders.push(rel);
    }
    assert.deepEqual(offenders, []);
});

test('عداد «قيد المعالجة» في لوحة التحكم بيعد القيمة المخزّنة', () => {
    const src = fs.readFileSync(path.join(ROOT, 'assets/js/admin/dashboard-logic.js'), 'utf8');
    // منذ 134: العدّاد عدّاد خادم (count دقيق) لا تصفية صفوف — والقيمة
    // المُعدّة هي المخزّنة نفسها 'in-progress' بشرطة، لا 'in_progress'.
    assert.match(src, /countStatus\('in-progress'\)/);
});
