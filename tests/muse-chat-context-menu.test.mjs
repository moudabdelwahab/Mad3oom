/**
 * اختبارات قائمة سياق الرسالة في شات Muse (owner/muse-chat.html)
 * — tests/muse-chat-context-menu.test.mjs.
 *
 * ما تحرسه هذه الاختبارات:
 *
 *  • قائمة السياق: كليك يمين على أي فقاعة (مستخدم أو مساعد) يفتح قائمة
 *    مخصصة عند المؤشر مقصوصة داخل النافذة، وتمنع قائمة المتصفح؛ وتُغلق
 *    بنقرة خارجها أو Escape أو تمرير قائمة الرسائل.
 *  • التفاعل: مجموعة ثابتة من 6 إيموجي؛ الضغط يبدّل التفاعل على الرسالة،
 *    والشارة تعرض فقط التفاعلات المحفوظة فعلًا في reactions — بلا عدد
 *    ولا تفاعل مخترع. الحفظ update في ai_session_messages مقيّد بالجلسة.
 *  • الرد: زر «رد على الرسالة» يفتح شريط رد فوق الإدخال باقتباس الأصل
 *    وزر إلغاء؛ والإرسال يحفظ reply_to بمعرّف الرسالة الأصلية، والرسالة
 *    المعروضة تُظهر الاقتباس فوق نصها.
 *  • النسخ: Clipboard API أولًا مع بديل textarea + execCommand، وتأكيد
 *    عربي «تم النسخ» — بلا عمود جديد في القاعدة.
 *  • ضغطة طويلة على اللمس تفتح القائمة نفسها (مكمل، لا يؤخر سطح المكتب).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    REACTION_EMOJIS, toggleReaction, reactionsOf,
    clampMenuPosition, quotePreview, QUOTE_MAX,
} from '../assets/js/owner/muse-chat-state.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const chatHtml = () => read('owner/muse-chat.html');
const chatJs = () => read('assets/js/owner/pages/muse-chat.js');
const chatStateJs = () => read('assets/js/owner/muse-chat-state.js');
const chatCss = () => read('assets/css/owner-muse-chat.css');

/* ─────────────────── التفاعلات: مجموعة ثابتة وتبديل نقي ─────────────────── */

test('مجموعة التفاعلات ثابتة: 6 إيموجي فقط', () => {
    assert.deepEqual(REACTION_EMOJIS, ['❤️', '👍', '😂', '😮', '😢', '🔥']);
    assert.match(chatStateJs(), /REACTION_EMOJIS/);
    assert.match(chatJs(), /REACTION_EMOJIS/);
});

test('تبديل التفاعل: إضافة للغائب وإزالة للموجود، بلا تعديل للمدخلة', () => {
    assert.deepEqual(toggleReaction([], '❤️'), ['❤️']);
    assert.deepEqual(toggleReaction(['❤️'], '👍'), ['❤️', '👍']);
    assert.deepEqual(toggleReaction(['❤️', '👍'], '❤️'), ['👍']);
    assert.deepEqual(toggleReaction(['❤️', '👍'], '👍'), ['❤️']);
    const input = ['❤️'];
    const next = toggleReaction(input, '👍');
    assert.deepEqual(input, ['❤️']);
    assert.deepEqual(next, ['❤️', '👍']);
});

test('تبديل إيموجي خارج المجموعة الثابتة يُتجاهل ولا يُحفظ', () => {
    assert.deepEqual(toggleReaction([], '🚀'), []);
    assert.deepEqual(toggleReaction(['❤️'], '🚀'), ['❤️']);
});

test('تفاعلات رسالة: مصفوفة كما حُفظت، أو [] عند غيابها أو فسادها', () => {
    assert.deepEqual(reactionsOf({ reactions: ['❤️', '👍'] }), ['❤️', '👍']);
    assert.deepEqual(reactionsOf({ reactions: [] }), []);
    assert.deepEqual(reactionsOf({ reactions: null }), []);
    assert.deepEqual(reactionsOf({}), []);
    assert.deepEqual(reactionsOf(null), []);
    assert.deepEqual(reactionsOf({ reactions: '❤️' }), []);
    assert.deepEqual(reactionsOf({ reactions: ['❤️', 42, null] }), ['❤️']);
});

/* ─────────────────── الاقتباس وموضع القائمة ─────────────────── */

test('معاينة الاقتباس: تطبيع مسافات وقصّ عند 120 حرفًا مع «…»', () => {
    assert.equal(QUOTE_MAX, 120);
    assert.equal(quotePreview('  أهلا   بك  '), 'أهلا بك');
    assert.equal(quotePreview('نص قصير'), 'نص قصير');
    const long = 'س'.repeat(200);
    assert.equal(quotePreview(long), `${'س'.repeat(119)}…`);
    assert.equal(quotePreview('   '), '');
    assert.equal(quotePreview(null), '');
});

test('موضع القائمة: عند المؤشر داخل النافذة، ومقصوص عند الحواف', () => {
    assert.deepEqual(
        clampMenuPosition(100, 100, 200, 150, 800, 600), { left: 100, top: 100 });
    assert.deepEqual(
        clampMenuPosition(700, 500, 200, 150, 800, 600), { left: 600, top: 450 });
    assert.deepEqual(
        clampMenuPosition(790, 590, 200, 150, 800, 600), { left: 600, top: 450 });
    assert.deepEqual(
        clampMenuPosition(0, 0, 900, 700, 800, 600), { left: 0, top: 0 });
});

/* ─────────────────── الصفحة: القائمة وشريط الرد ─────────────────── */

test('الـ HTML فيه قائمة السياق وشريط الرد بكل معرّفاتهما ونصوصهما العربية', () => {
    const html = chatHtml();
    for (const id of ['museMsgMenu', 'museMsgMenuReactions', 'museMsgMenuReply',
        'museMsgMenuCopy', 'museReplyBar', 'museReplyQuote', 'museReplyCancel']) {
        assert.ok(html.includes(`id="${id}"`), `المعرّف ${id} غائب من الـ HTML`);
    }
    assert.match(html, /خيارات الرسالة/);
    assert.match(html, /رد على الرسالة/);
    assert.match(html, /نسخ النص/);
    assert.match(html, /إلغاء الرد/);
    assert.match(html, /id="museReplyBar" hidden/);
    assert.match(html, /id="museMsgMenu" hidden/);
});

test('الصفحة تقرأ reactions و reply_to مع الرسائل', () => {
    const js = chatJs();
    assert.match(js, /MESSAGE_COLUMNS = 'id, role, content, created_at, reactions, reply_to'/);
});

test('كليك يمين على فقاعة يمنع قائمة المتصفح ويفتح قائمتنا عند المؤشر', () => {
    const js = chatJs();
    assert.match(js, /addEventListener\('contextmenu'/);
    assert.match(js, /closest\('\.muse-msg'\)/);
    assert.match(js, /e\.preventDefault\(\)/);
    assert.match(js, /openMsgMenu\(bubble\.dataset\.messageId, e\.clientX, e\.clientY\)/);
    assert.match(js, /clampMenuPosition\(/);
    assert.match(js, /menu\.style\.left/);
    assert.match(js, /menu\.style\.top/);
});

test('القائمة تُغلق بنقرة خارجها أو Escape أو تمرير قائمة الرسائل', () => {
    const js = chatJs();
    assert.match(js, /!menu\.contains\(e\.target\)/);
    assert.match(js, /e\.key === 'Escape' && !menu\.hidden/);
    assert.match(js, /addEventListener\('scroll', \(\) => closeMsgMenu\(\)/);
    assert.match(js, /function closeMsgMenu\(\)/);
});

test('ضغطة طويلة على اللمس (600 مللي ثانية) تفتح القائمة نفسها', () => {
    const js = chatJs();
    assert.match(js, /LONG_PRESS_MS = 600/);
    assert.match(js, /addEventListener\('touchstart'/);
    assert.match(js, /setTimeout\(\(\) => \{\s*openMsgMenu\(bubble\.dataset\.messageId/);
    assert.match(js, /addEventListener\('touchmove', \(\) => clearTimeout\(longPressTimer\)/);
    assert.match(js, /addEventListener\('touchend', \(\) => clearTimeout\(longPressTimer\)/);
});

/* ─────────────────── التفاعل: حفظ وتفاؤل وشارة ─────────────────── */

test('تبديل التفاعل update في ai_session_messages مقيّد بالرسالة والجلسة', () => {
    const js = chatJs();
    assert.match(js, /toggleMessageReaction\(messageId, emoji\)/);
    assert.match(js, /\.update\(\{ reactions: next \}\)/);
    assert.match(js, /\.eq\('id', messageId\)/);
    assert.match(js, /\.eq\('session_id', sessionId\)/);
});

test('التفاعل تحديث متفائل في الواجهة مع تراجع عند فشل الحفظ', () => {
    const js = chatJs();
    assert.match(js, /target\.reactions = next/);
    assert.match(js, /refreshMessageExtras\(\$\('museChatMessages'\), target\)/);
    assert.match(js, /target\.reactions = previous/);
    assert.match(js, /تعذّر حفظ التفاعل/);
});

test('شارة التفاعلات تعرض المحفوظ فقط، والضغط عليها يبدّلها', () => {
    const js = chatJs();
    assert.match(js, /reactionsHtml\(m\)/);
    assert.match(js, /reactionsOf\(m\)/);
    assert.match(js, /muse-msg-reaction/);
    assert.match(js, /اضغط لإزالة التفاعل/);
    assert.match(js, /toggleMessageReaction\(m\.id, btn\.dataset\.emoji\)/);
});

test('الاستطلاع يحدّث اقتباس الرسالة المعروضة وشارتها عند تغيّرهما', () => {
    const js = chatJs();
    assert.match(js, /refreshMessageExtras\(box, m\)/);
    assert.match(js, /el\.dataset\.reactions/);
    assert.match(js, /el\.dataset\.replyTo/);
});

/* ─────────────────── الرد: شريط وإرسال وعرض ─────────────────── */

test('زر الرد يفتح شريط الرد باقتباس الأصل، و✕ تلغيه', () => {
    const js = chatJs();
    assert.match(js, /startReply\(target\)/);
    assert.match(js, /replyTargetId = target\.id/);
    assert.match(js, /\$\('museReplyBar'\)\.hidden = false/);
    assert.match(js, /رد على: \$\{quotePreview\(target\.content\)/);
    assert.match(js, /function cancelReply\(\)/);
    assert.match(js, /replyTargetId = null/);
    assert.match(js, /\$\('museReplyCancel'\)\.addEventListener\('click'/);
});

test('الإرسال يحفظ reply_to مع الرسالة ويمسح شريط الرد عند النجاح', () => {
    const js = chatJs();
    assert.match(js, /reply_to: replyTargetId \|\| null/);
    assert.match(js, /cancelReply\(\);\s*input\.focus\(\)/);
});

test('الرسالة المعروضة تُظهر اقتباس الأصل فوق نصها، أو «رسالة سابقة» عند غيابه', () => {
    const js = chatJs();
    assert.match(js, /quoteHtml\(m\)/);
    assert.match(js, /muse-msg-quote/);
    assert.match(js, /رد على: \$\{esc\(text\)\}/);
    assert.match(js, /رسالة سابقة/);
});

test('تبديل الجلسة يغلق القائمة ويلغي الرد المعلّق', () => {
    const js = chatJs();
    const idx = js.indexOf('async function switchSession');
    assert.ok(idx > 0);
    const body = js.slice(idx, idx + 800);
    assert.match(body, /closeMsgMenu\(\)/);
    assert.match(body, /cancelReply\(\)/);
});

/* ─────────────────── النسخ: API أولًا ثم بديل ─────────────────── */

test('النسخ Clipboard API أولًا مع بديل textarea و execCommand وتأكيد عربي', () => {
    const js = chatJs();
    assert.match(js, /navigator\.clipboard\?\.writeText/);
    assert.match(js, /document\.execCommand\('copy'\)/);
    assert.match(js, /createElement\('textarea'\)/);
    assert.match(js, /تم النسخ/);
    assert.match(js, /تعذّر النسخ/);
    assert.match(js, /async function copyMessageText\(text\)/);
});

/* ─────────────────── التنسيق: القائمة والشارة والاقتباس والشريط ─────────────────── */

test('التنسيق يعرف القائمة والشارة والاقتباس وشريط الرد', () => {
    const css = chatCss();
    assert.match(css, /\.muse-msg-menu\s*\{/);
    assert.match(css, /position:\s*fixed/);
    assert.match(css, /z-index:\s*3000/);
    assert.match(css, /\.muse-msg-menu-reactions/);
    assert.match(css, /\.muse-msg-menu-emoji/);
    assert.match(css, /\.muse-msg-menu-item/);
    assert.match(css, /\.muse-msg-reactions/);
    assert.match(css, /\.muse-msg-reaction/);
    assert.match(css, /\.muse-msg-quote/);
    assert.match(css, /\.muse-reply-bar/);
    assert.match(css, /\.muse-reply-cancel/);
});
