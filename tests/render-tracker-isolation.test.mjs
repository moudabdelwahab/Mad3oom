/**
 * error-tracker.js يرسل كل خطأ JS أو مورد فاشل مباشرةً إلى site_errors في قاعدة الإنتاج.
 * اختبارات العرض تفتح الصفحات الحقيقية على خادم محلي، فأي صفحة تحمل المتتبع بلا بديل
 * كانت تكتب صفوفًا في الإنتاج من كل تشغيل CI (http://127.0.0.1:*، صور موقّعة وهمية،
 * خطوط Google المحجوبة)، وتسبّب تذبذبًا حين يلحق خطأ CORS نهاية الاختبار.
 *
 * حارس ثابت: كل ملف *.render.test.mjs يفتح صفحة فيها error-tracker.js يستبدله ببديل فارغ.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TRACKER = /<script[^>]+src="\/error-tracker\.js"/;
const STUB = /\.route\('\*\*\/error-tracker\.js'/;

test('every render suite that opens a page with error-tracker.js stubs it (no test writes to production)', () => {
    const offenders = [];
    let checked = 0;
    for (const file of fs.readdirSync(path.join(ROOT, 'tests')).filter((f) => f.endsWith('.render.test.mjs'))) {
        const src = fs.readFileSync(path.join(ROOT, 'tests', file), 'utf8');
        const pages = [...new Set([...src.matchAll(/['"`](\/[\w/.-]+\.html)/g)].map((m) => m[1]))]
            .filter((p) => fs.existsSync(path.join(ROOT, p)) && TRACKER.test(fs.readFileSync(path.join(ROOT, p), 'utf8')));
        if (!pages.length) continue;
        checked++;
        if (!STUB.test(src)) offenders.push(`${file} (${pages.join(', ')})`);
    }
    assert.ok(checked >= 10, `only ${checked} suites open tracked pages — the page detection broke`);
    assert.deepEqual(offenders, [], `render suites that let error-tracker.js reach production: ${offenders.join('; ')}`);
});
