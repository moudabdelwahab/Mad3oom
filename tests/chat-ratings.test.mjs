/**
 * فحوص ساكنة على تقييمات المحادثة (chat_ratings): نجوم صفحة العميل تُحفَظ
 * فعلًا في قاعدة البيانات مع الجلسة، نجمة واحدة لكل جلسة، بلا إعادة
 * إرسال عند التحديث.
 *
 * منطق الواجهة يُفحص من المصدر (النهج الساكن المعتاد)؛ وسلوك الجدول
 * والسياسات يُفحص تنفيذًا في tests/sql/chat-ratings.test.sql.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MIGRATION = read('migrations/124_chat_ratings.sql');
const LOGIC = read('assets/js/chat-logic.js');
const PAGE = read('chat-customer.html');

/** جسم الكود بلا تعليقات — الفحوص يجب أن تنظر إلى الكود لا إلى شرحه. */
function codeOnly(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
}

/* ── الترحيل: الجدول والقواعد ───────────────────────────────────────────── */

test('الترحيل ينشئ chat_ratings: جلسة + نجوم 1..5 + تقييم واحد لكل جلسة', () => {
    assert.match(MIGRATION, /create table if not exists public\.chat_ratings \(/,
        'الجدول غير منشأ');
    assert.match(MIGRATION, /session_id uuid not null references public\.chat_sessions\(id\) on delete cascade/,
        'لا مرجع للجلسة مع حذف متتابع');
    assert.match(MIGRATION, /rating smallint not null check \(rating between 1 and 5\)/,
        'لا قيد 1..5 على النجوم');
    assert.match(MIGRATION, /constraint chat_ratings_one_per_session unique \(session_id\)/,
        'لا قيد فريد يمنع تقييم الجلسة مرتين');
    assert.match(MIGRATION, /alter table public\.chat_ratings enable row level security/,
        'RLS غير مفعّلة');
});

test('الترحيل يطابق سياسات chat_messages: مالك الجلسة أو صلاحية مرتفعة', () => {
    assert.match(MIGRATION, /create policy chat_ratings_insert_own_or_admin/,
        'سياسة الإدراج مفقودة');
    assert.match(MIGRATION, /create policy chat_ratings_select_own_or_admin/,
        'سياسة القراءة مفقودة');
    assert.match(MIGRATION, /create policy gate_account_active/,
        'بوابة الحساب النشط مفقودة');
    assert.match(MIGRATION, /has_elevated_authority\(\)/, 'لا فحص صلاحية مرتفعة');
    assert.match(MIGRATION, /s\.user_id = auth\.uid\(\)/, 'لا ربط بجلسات المالك');
    assert.doesNotMatch(MIGRATION, /for update|for delete/, 'التقييم قابل للتعديل/الحذف — يجب أن يكون سجلًا');
});

/* ── الواجهة: الحفظ مرة واحدة ───────────────────────────────────────────── */

test('زر الإرسال يحفظ التقييم في chat_ratings مع الجلسة', () => {
    const CODE = codeOnly(LOGIC);
    assert.match(CODE, /\.from\('chat_ratings'\)\.insert\(\{/,
        'لا إدراج في chat_ratings');
    assert.match(CODE, /session_id: currentSessionId/, 'التقييم بلا جلسة');
    assert.match(CODE, /rating: selectedRating/, 'النجوم المختارة لا تُحفظ');
    assert.match(CODE, /comment,/, 'التعليق لا يُحفظ');
    assert.doesNotMatch(CODE, /submitRatingBtn\.onclick = \(\) => \{\s*const ratingModal/,
        'زر الإرسال ما زال يغلق النافذة فقط بلا حفظ');
});

test('لا إعادة إرسال: زر معطَّل أثناء الحفظ + قيد فريد + علامة محلية', () => {
    const CODE = codeOnly(LOGIC);
    assert.match(CODE, /submitRatingBtn\.disabled = true;/, 'الزر لا يُعطَّل أثناء الحفظ');
    assert.match(CODE, /error\.code !== '23505'/, 'لا معالجة لخطأ القيد الفريد');
    assert.match(CODE, /localStorage\.setItem\(`mad3oom-rated-\$\{currentSessionId\}`/,
        'لا علامة محلية تمنع إعادة الإرسال');
    assert.match(CODE, /loadExistingRating\(currentSessionId\)/,
        'التقييم السابق لا يُقرأ عند فتح النافذة');
    assert.match(CODE, /showRatingThanks\(selectedRating\)/, 'لا حالة شكر بعد الحفظ');
});

test('النجوم تُخزَّن قيمتها عند الاختيار وتُعرض بعد الحفظ', () => {
    const CODE = codeOnly(LOGIC);
    assert.match(CODE, /selectedRating = Number\(star\.dataset\.value\) \|\| 0;/,
        'قيمة النجمة لا تُخزَّن');
    assert.match(CODE, /function showRatingThanks\(value\)/, 'دالة الشكر مفقودة');
    assert.match(CODE, /function showRatingForm\(\)/, 'دالة إعادة النموذج مفقودة');
});

/* ── الصفحة: عنصر الشكر والتنسيق ─────────────────────────────────────────── */

test('صفحة العميل فيها عنصر شكر مخفي وتنسيقه', () => {
    assert.match(PAGE, /<p id="ratingThanks" class="rating-thanks" hidden><\/p>/,
        'عنصر الشكر مفقود من النافذة');
    assert.match(PAGE, /\.rating-thanks \{/, 'تنسيق الشكر مفقود');
    assert.match(PAGE, /\.submit-rating-btn:disabled \{/, 'تنسيق الزر المعطَّل مفقود');
    assert.match(PAGE, /id="submitRatingBtn"/, 'زر الإرسال مفقود');
});
