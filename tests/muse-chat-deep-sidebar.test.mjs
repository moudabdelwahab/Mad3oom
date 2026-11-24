/**
 * اختبارات التصميم العميق لقائمة محادثات Muse الجانبية (owner/muse-chat.html)
 * — tests/muse-chat-deep-sidebar.test.mjs.
 *
 * ما تحرسه هذه الاختبارات:
 *
 *  • العنوان الذكي: تحية وطلب مهذب يُحذفان، والجملة الأولى الوافية تصبح
 *    العنوان، والطويل يُقصّ — بلا كتابة فوق إعادة تسمية يدوية.
 *  • القائمة: معاينة آخر رسالة حقيقية، ووقت نسبي بتوقيت القاهرة وأرقام
 *    لاتينية، ونقطة حالة من آخر رسالة (بانتظار رد أم تم الرد) — لا عدد
 *    «غير مقروء» مخترع، فلا علامة قراءة في القاعدة أصلًا.
 *  • التجميع: اليوم وأمس وهذا الأسبوع وأقدم، والمجموعات الفارغة تُحذف.
 *  • البحث يصفّي العنوان والمعاينة؛ ووقت فقاعة الرسالة وفاصل التاريخ
 *    ومدة الرد كلها من طوابع حقيقية.
 *  • فقاعة الانتظار: ثلاث نقاط ومرحلة زمنية وعدّاد ثوانٍ — تظهر من طابع
 *    إرسال بلا رد وتختفي بوصوله، لا حالة حضور ولا ادعاء كتابة حرفًا حرفًا.
 *  • الأفاتار «بيفكر»: عينان مرفوعتان للأعلى تتنقلان يمينًا ويسارًا،
 *    ونقاط تفكير فوق رأسه تظهر في حالة التفكير فقط.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    deriveSmartTitle, SMART_TITLE_MAX,
    formatRelativeTime, formatMessageTime, formatMessageTimestamp,
    cairoDayKey, groupSessionsByDate, sessionDateGroup,
    previewOfLastMessage, sessionStatus, SESSION_STATUS_LABEL,
    dateSeparatorLabel, shouldShowDateSeparator,
    replyTookFor, formatReplyDuration, thinkingStage, THINKING_STAGES,
} from '../assets/js/owner/muse-chat-state.js';
import { thinkingEyeOffset } from '../assets/js/owner/muse-avatar-state.js';
import { museAvatarSvg } from '../assets/js/owner/muse-avatar.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const chatHtml = () => read('owner/muse-chat.html');
const chatJs = () => read('assets/js/owner/pages/muse-chat.js');
const chatCss = () => read('assets/css/owner-muse-chat.css');
const avatarJs = () => read('assets/js/owner/muse-avatar.js');

/** مرجع زمني ثابت للاختبارات: الثلاثاء 24 نوفمبر 2026، 12:00 ظهرًا بالقاهرة. */
const NOW = new Date('2026-11-24T10:00:00Z');

/* ─────────────────── العنوان الذكي ─────────────────── */

test('العنوان الذكي: تحية وطلب مهذب يُحذفان والجملة الأولى تصبح العنوان', () => {
    assert.equal(SMART_TITLE_MAX, 48);
    assert.equal(deriveSmartTitle('لو سمحت، ما هي حالة التذاكر الآن؟'), 'ما هي حالة التذاكر الآن');
    assert.equal(deriveSmartTitle('أهلا، عايز أعرف أسعار واتساب لمصر'), 'أعرف أسعار واتساب لمصر');
    assert.equal(deriveSmartTitle('ممكن تساعدني في مراجعة الاشتراكات؟'), 'مراجعة الاشتراكات');
    assert.equal(deriveSmartTitle('ما هي حالة التذاكر الآن؟ وأيها متأخر؟'), 'ما هي حالة التذاكر الآن');
});

test('العنوان الذكي: نص كله تحية يبقى كما هو، والطويل يُقصّ عند الحد', () => {
    assert.equal(deriveSmartTitle('مرحبا'), 'مرحبا');
    assert.equal(deriveSmartTitle('   '), '');
    assert.equal(deriveSmartTitle(null), '');
    assert.equal(
        deriveSmartTitle('سؤال عن الكوتة المجانية ومتى تتجدد بالظبط وكيف أتابعها من اللوحة'),
        'سؤال عن الكوتة المجانية ومتى تتجدد بالظبط وكيف…');
    assert.ok(deriveSmartTitle('س'.repeat(60)).endsWith('…'));
});

test('الصفحة تسمّي بالعنوان الذكي لا بالقصّ الخام', () => {
    assert.match(chatJs(), /deriveSmartTitle\(text\)/);
    assert.doesNotMatch(chatJs(), /deriveTitle\(text\)/);
});

/* ─────────────────── الوقت النسبي ─────────────────── */

test('الوقت النسبي: الآن ثم دقائق بجمعها العربي الصحيح', () => {
    assert.equal(formatRelativeTime('2026-11-24T09:59:30Z', NOW), 'الآن');
    assert.equal(formatRelativeTime('2026-11-24T09:59:00Z', NOW), 'منذ دقيقة');
    assert.equal(formatRelativeTime('2026-11-24T09:58:00Z', NOW), 'منذ دقيقتين');
    assert.equal(formatRelativeTime('2026-11-24T09:55:00Z', NOW), 'منذ 5 دقائق');
    assert.equal(formatRelativeTime('2026-11-24T09:49:00Z', NOW), 'منذ 11 دقيقة');
    assert.equal(formatRelativeTime('not-a-date', NOW), '—');
});

test('الوقت النسبي: اليوم وأمس واسم اليوم ثم التاريخ وحده', () => {
    assert.equal(formatRelativeTime('2026-11-24T08:15:00Z', NOW), 'اليوم 10:15 ص');
    assert.equal(formatRelativeTime('2026-11-23T18:32:00Z', NOW), 'أمس 8:32 م');
    assert.equal(formatRelativeTime('2026-11-22T08:04:00Z', NOW), 'الأحد 10:04 ص');
    assert.equal(formatRelativeTime('2026-11-10T08:04:00Z', NOW), '10 نوفمبر 2026');
});

test('وقت فقاعة الرسالة والطابع الكامل بالثواني', () => {
    assert.equal(formatMessageTime('2026-11-24T09:15:00Z', NOW), '11:15 ص');
    assert.equal(formatMessageTime('2026-11-23T18:32:00Z', NOW), 'أمس 8:32 م');
    assert.equal(formatMessageTime('2026-11-10T08:04:00Z', NOW), '10 نوفمبر 2026 في 10:04 ص');
    assert.equal(formatMessageTimestamp('2026-11-24T09:15:12Z'), '24 نوفمبر 2026 في 11:15:12 ص');
    assert.equal(cairoDayKey('2026-11-24T09:15:00Z'), '2026-11-24');
    assert.equal(cairoDayKey('garbage'), null);
});

/* ─────────────────── تجميع القائمة ومعاينتها وحالتها ─────────────────── */

const sess = (id, last_active_at, created_at = last_active_at) =>
    ({ id, title: id, model_id: 'muse', last_active_at, created_at });

test('تجميع الجلسات: اليوم وأمس وهذا الأسبوع وأقدم، والفارغ يُحذف', () => {
    assert.equal(sessionDateGroup(sess('a', '2026-11-24T09:00:00Z'), NOW), 'today');
    assert.equal(sessionDateGroup(sess('b', '2026-11-23T18:00:00Z'), NOW), 'yesterday');
    assert.equal(sessionDateGroup(sess('c', '2026-11-20T08:00:00Z'), NOW), 'week');
    assert.equal(sessionDateGroup(sess('d', '2026-11-01T08:00:00Z'), NOW), 'older');
    const groups = groupSessionsByDate([
        sess('a', '2026-11-24T09:00:00Z'),
        sess('b', '2026-11-23T18:00:00Z'),
        sess('c', '2026-11-20T08:00:00Z'),
        sess('d', '2026-11-01T08:00:00Z'),
    ], NOW);
    assert.deepEqual(groups.map((g) => g.key), ['today', 'yesterday', 'week', 'older']);
    assert.deepEqual(groups.map((g) => g.sessions.map((s) => s.id)), [['a'], ['b'], ['c'], ['d']]);
    assert.deepEqual(groupSessionsByDate([sess('a', '2026-11-24T09:00:00Z')], NOW)
        .map((g) => g.key), ['today']);
    assert.deepEqual(groupSessionsByDate([], NOW), []);
});

test('معاينة آخر رسالة مقصوصة، وبلا نص ترجع فراغًا', () => {
    assert.equal(previewOfLastMessage({ content: '  شكرا   لك  ' }), 'شكرا لك');
    assert.equal(previewOfLastMessage(null), '');
    assert.equal(previewOfLastMessage({ content: '   ' }), '');
    assert.ok(previewOfLastMessage({ content: 'س'.repeat(80) }).endsWith('…'));
});

test('حالة الجلسة من آخر رسالة حقيقية فقط — بلا عدد غير مقروء مخترع', () => {
    assert.equal(sessionStatus({ role: 'user' }), 'waiting');
    assert.equal(sessionStatus({ role: 'assistant' }), 'answered');
    assert.equal(sessionStatus(null), 'empty');
    assert.equal(SESSION_STATUS_LABEL.waiting, 'بانتظار رد');
    assert.equal(SESSION_STATUS_LABEL.answered, 'تم الرد');
    assert.equal(SESSION_STATUS_LABEL.empty, 'بلا رسائل');
    assert.doesNotMatch(chatJs(), /unread|غير مقروء/);
});

/* ─────────────────── فواصل التاريخ ومدة الرد ─────────────────── */

test('فاصل التاريخ: أول رسالة وتغيّر اليوم فقط', () => {
    assert.equal(dateSeparatorLabel('2026-11-24T09:15:00Z', NOW), 'اليوم — 24 نوفمبر 2026');
    assert.equal(dateSeparatorLabel('2026-11-23T18:32:00Z', NOW), 'أمس — 23 نوفمبر 2026');
    assert.equal(dateSeparatorLabel('2026-11-10T08:04:00Z', NOW), '10 نوفمبر 2026');
    assert.equal(shouldShowDateSeparator(null, { created_at: '2026-11-24T09:00:00Z' }), true);
    assert.equal(shouldShowDateSeparator(
        { created_at: '2026-11-24T09:00:00Z' }, { created_at: '2026-11-24T10:00:00Z' }), false);
    assert.equal(shouldShowDateSeparator(
        { created_at: '2026-11-23T09:00:00Z' }, { created_at: '2026-11-24T10:00:00Z' }), true);
    assert.equal(shouldShowDateSeparator({ created_at: '2026-11-24T09:00:00Z' }, null), false);
});

test('مدة الرد: من أحدث رسالة مستخدم قبل الرد، وnull بلا سابقة', () => {
    const user = { id: '1', role: 'user', created_at: '2026-11-22T14:10:42Z' };
    const reply = { id: '2', role: 'assistant', created_at: '2026-11-22T14:11:29Z' };
    assert.equal(replyTookFor([user, reply], reply), 47);
    assert.equal(replyTookFor([reply], reply), null);
    assert.equal(replyTookFor([user, reply], user), null);
    assert.equal(formatReplyDuration(47), 'تم الرد خلال 47 ثانية');
    assert.equal(formatReplyDuration(47.6), 'تم الرد خلال 48 ثانية');
});

/* ─────────────────── فقاعة الانتظار ─────────────────── */

test('مراحل الانتظار من الثواني المنصرمة فقط', () => {
    assert.equal(thinkingStage(0), 'يقرأ رسالتك…');
    assert.equal(thinkingStage(4), 'يقرأ رسالتك…');
    assert.equal(thinkingStage(5), 'يراجع التذاكر والبيانات…');
    assert.equal(thinkingStage(14), 'يراجع التذاكر والبيانات…');
    assert.equal(thinkingStage(15), 'يجهّز الرد…');
    assert.equal(thinkingStage(120), 'يجهّز الرد…');
    assert.equal(thinkingStage(-3), 'يقرأ رسالتك…');
    assert.equal(THINKING_STAGES.length, 3);
});

test('فقاعة الانتظار في الصفحة: تُبنى مرة وتُحدَّث نصًا وتختفي بوصول الرد', () => {
    const js = chatJs();
    assert.match(js, /showThinking\(\$\('museChatMessages'\)\)/);
    assert.match(js, /updateThinking\(seconds\)/);
    assert.match(js, /hideThinking\(\)/);
    assert.match(js, /thinkingStage\(seconds\)/);
    assert.match(js, /muse-thinking-dots/);
    assert.match(js, /muse-thinking-timer/);
    assert.match(js, /muse-thinking-stage/);
    assert.match(js, /startWaiting\(data\.created_at/);
    // الفقاعة لا تُبنى من الصفر مع كل نبضة عدّاد.
    assert.doesNotMatch(js, /setInterval\(\(\) => \{\s*if \(!waitingSinceAt\) return;\s*setReplyStatus\(\s*formatWaitSeconds/);
    assert.match(chatCss(), /\.muse-thinking\s*\{/);
    assert.match(chatCss(), /\.muse-thinking-dots i/);
    assert.match(chatCss(), /muse-thinking-bounce/);
    assert.match(chatCss(), /\.muse-date-separator/);
    assert.match(chatCss(), /\.muse-msg-took/);
});

/* ─────────────────── الأفاتار «بيفكر» ─────────────────── */

test('نظرة التفكير: عينان مرفوعتان للأعلى دائمًا وتتنقلان يمينًا ويسارًا', () => {
    const at0 = thinkingEyeOffset(0);
    const atQuarter = thinkingEyeOffset(0.25);
    assert.equal(at0.y, -2.5);
    assert.ok(at0.y < 0);
    assert.equal(atQuarter.y, -2.5);
    assert.ok(Math.abs(at0.x) < 1e-9);
    assert.ok(Math.abs(atQuarter.x - 3) < 1e-9);
    assert.ok(Math.abs(thinkingEyeOffset(0.75).x + 3) < 1e-9);
});

test('نقاط التفكير في الـ SVG وتظهر في حالة التفكير فقط، وتختفي مع إيقاف الحركة', () => {
    assert.match(museAvatarSvg(), /muse-avatar-thinking-dots/);
    assert.match(chatCss(), /\.muse-avatar--thinking \.muse-avatar-thinking-dots/);
    assert.match(chatCss(), /muse-avatar-think-dot/);
    assert.match(chatCss(), /\.muse-avatar--off \.muse-avatar-thinking-dots/);
    assert.match(avatarJs(), /thinkingEyeOffset\(floatPhase\)/);
    assert.match(avatarJs(), /rotate -= 2/);
});

/* ─────────────────── القائمة الجانبية في الصفحة ─────────────────── */

test('القائمة فيها بحث، وتُبنى بمجموعات تاريخ ومعاينة ووقت نسبي ونقطة حالة', () => {
    const html = chatHtml();
    assert.match(html, /id="museSessionSearch"/);
    assert.match(html, /ابحث في المحادثات/);
    const js = chatJs();
    assert.match(js, /\$\('museSessionSearch'\)\.addEventListener\('input'/);
    assert.match(js, /groupSessionsByDate\(visible\)/);
    assert.match(js, /muse-session-group/);
    assert.match(js, /previewOfLastMessage\(last\)/);
    assert.match(js, /formatRelativeTime\(session\.last_active_at/);
    assert.match(js, /muse-session-dot--\$\{status\}/);
    assert.match(js, /SESSION_STATUS_LABEL\[status\]/);
    assert.match(js, /loadSessionPreviews\(\)/);
    assert.match(js, /\.limit\(1\)/);
    assert.match(js, /maybeSingle\(\)/);
    assert.match(js, /لا نتائج مطابقة للبحث/);
    const css = chatCss();
    assert.match(css, /\.muse-session-search/);
    assert.match(css, /\.muse-session-group/);
    assert.match(css, /\.muse-session-preview/);
    assert.match(css, /\.muse-session-dot--waiting/);
    assert.match(css, /\.muse-session-dot--answered/);
    assert.match(css, /\.muse-session-foot/);
});

test('رسالة المساعد تعرض وقتها الكامل ومدة ردها من طوابع حقيقية', () => {
    const js = chatJs();
    assert.match(js, /messageNode\(m, replyTookFor\(messages, m\)\)/);
    assert.match(js, /formatMessageTime\(m\.created_at\)/);
    assert.match(js, /formatMessageTimestamp\(m\.created_at\)/);
    assert.match(js, /formatReplyDuration\(tookSeconds\)/);
    assert.match(js, /dateSeparatorLabel\(m\.created_at\)/);
    assert.match(js, /shouldShowDateSeparator\(prev, m\)/);
});

test('لا حالة حضور ولا ادعاء كتابة حرفًا حرفًا في الملفات المعدَّلة', () => {
    for (const src of [chatHtml(), chatJs(), avatarJs()]) {
        assert.doesNotMatch(src, /متصل/);
        assert.doesNotMatch(src, /online/i);
        assert.doesNotMatch(src, /يكتب الآن|جارٍ الكتابة/);
    }
});
