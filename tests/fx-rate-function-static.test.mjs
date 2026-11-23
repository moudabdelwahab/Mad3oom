/**
 * فحوص ساكنة على دالة fx-rate (سعر الصرف الحي: البنك المركزي المصري).
 *
 * الدالة تعيش في TypeScript على Deno وتضرب مصادر خارجية، فلا تُشغَّل
 * هنا؛ الخصائص التي تهمّ قابلة للإثبات من المصدر نفسه (نهج
 * api-token-function-static.test.mjs): أي انحراف عن ترتيب المصادر
 * يعيد رقمًا ثابتًا أو مصدرًا غير رسمي، والاختبار يفشل قبل أن يصل
 * الكود إلى مراجعة بشرية.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = read('supabase/functions/fx-rate/index.ts');
const MIGRATION_126 = read('migrations/126_fx_rates_cache.sql');

function read(p) {
    return fs.readFileSync(path.join(ROOT, p), 'utf8');
}

/** جسم الكود بلا تعليقات — الفحوص يجب أن تنظر إلى الكود لا إلى شرحه. */
function codeOnly(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
}

const CODE = codeOnly(SRC);

test('المصدر الأول: جدول البنك المركزي الرسمي (صف US Dollar شراء/بيع)', () => {
    assert.match(CODE, /https:\/\/www\.cbe\.org\.eg\/en\/economic-research\/statistics\/exchange-rates/,
        'رابط صفحة أسعار البنك المركزي مفقود');
    assert.ok(CODE.includes('U\\.?\\s*S\\.?\\s*Dollar'), 'محلل صف الدولار مفقود');
    assert.match(CODE, /\(cbe\.buy \+ cbe\.sell\) \/ 2/, 'السعر ليس متوسط الشراء والبيع');
    assert.match(CODE, /Average Market Rate in EGP/, 'تاريخ نشرة البنك لا يُقرأ من الصفحة');
});

test('المصدر الثاني: Frankfurter (مرجع ECB، JSON بلا مفتاح)', () => {
    assert.match(CODE, /https:\/\/api\.frankfurter\.dev\/v2\/rate\/usd\/egp/,
        'رابط Frankfurter مفقود');
    assert.match(CODE, /source: "frankfurter"/, 'نتائج Frankfurter لا تُعلَّم بمصدرها');
});

test('الترتيب: ذاكرة الساعة أولًا، ثم البنك، ثم Frankfurter، ثم ذاكرة قديمة، ثم 503', () => {
    assert.match(CODE, /CACHE_TTL_MS = 60 \* 60 \* 1000/, 'مهلة الذاكرة ليست ساعة');
    assert.match(CODE, /fetchCbe\(\)/, 'جلب البنك المركزي غير مستدعى');
    assert.match(CODE, /fetchFrankfurter\(\)/, 'جلب Frankfurter غير مستدعى');
    assert.match(CODE, /live sources failed, returning stale cached rate/,
        'لا سقوط لآخر سعر مخزَّن عند تعذّر المصدَرين');
    assert.match(CODE, /error: "fx_unavailable".*503|503/, 'لا 503 عند غياب أي سعر');
    // ترتيب الاستدعاء في جسم serve: الذاكرة قبل البنك قبل Frankfurter.
    // (التعليقات المرقّمة تُزال بـ codeOnly، فالمرساة هنا سطر الكود نفسه.)
    const body = CODE.slice(CODE.indexOf('const latest = await readLatest()'));
    assert.ok(body.indexOf('readLatest') < body.indexOf('fetchCbe'), 'الذاكرة لا تُفحص قبل البنك');
    assert.ok(body.indexOf('fetchCbe') < body.indexOf('fetchFrankfurter'), 'البنك لا يسبق Frankfurter');
});

test('كل سعر حي ناجح يُحفظ في fx_rates قبل إرجاعه', () => {
    assert.match(CODE, /\.from\("fx_rates"\)\.insert\(/, 'إدراج الذاكرة مفقود');
    assert.match(CODE, /source: row\.source/, 'المصدر لا يُحفظ مع السعر');
    assert.match(CODE, /rate_date: row\.rate_date/, 'تاريخ النشرة لا يُحفظ مع السعر');
});

test('لا رقم صرف مثبَّت في الدالة إطلاقًا', () => {
    assert.doesNotMatch(CODE, /54\.\d+/, 'قيمة صرف مثبَّتة في الدالة');
    assert.doesNotMatch(CODE, /53\.\d+/, 'قيمة صرف مثبَّتة في الدالة');
    assert.doesNotMatch(CODE, /USD_EGP_FX_RATE|LOCAL_SURCHARGE/, 'ثابت قديم في الدالة');
});

test('الرد يحمل السعر والمصدر والتاريخ وعلامة الذاكرة، مع CORS', () => {
    assert.match(CODE, /usd_egp: row\.rate/, 'الرد بلا حقل usd_egp');
    assert.match(CODE, /cached,/, 'الرد بلا علامة cached');
    assert.match(CODE, /Access-Control-Allow-Origin": "\*"/, 'CORS مفقود');
    assert.match(CODE, /"GET, POST, OPTIONS"/, 'الدالة لا تقبل GET وPOST معًا');
});

test('الترحيل 126 ينشئ ذاكرة fx_rates مع قيودها', () => {
    assert.match(MIGRATION_126, /create table if not exists public\.fx_rates \(/, 'الجدول غير منشأ');
    assert.match(MIGRATION_126, /rate numeric not null check \(rate > 0\)/, 'لا قيد إيجابية على السعر');
    assert.match(MIGRATION_126, /source text not null check \(source in \('cbe', 'frankfurter'\)\)/,
        'لا قيد مصدر على الذاكرة');
    assert.match(MIGRATION_126, /fx_rates_latest_idx/, 'فهرس أحدث سعر مفقود');
    assert.match(MIGRATION_126, /alter table public\.fx_rates enable row level security/,
        'RLS غير مفعّلة على الذاكرة');
});
