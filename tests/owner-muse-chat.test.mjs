/**
 * اختبارات صفحة شات Muse في لوحة المالك (owner/muse-chat.html).
 *
 * ما تحرسه هذه الاختبارات:
 *
 *  • الجلسة: الصفحة تجد جلسة Muse النشطة الأقدم للمالك الحالي بموديل muse،
 *    ولا تنشئ جلسة إلا عند غيابها — وبنفس عنوان الجلسة التجريبية وتوجيهها
 *    وترحيبها حرفيًا، حتى لا تنشأ جلسة بسلوك مختلف.
 *  • الإرسال: insert واحد في ai_session_messages فقط (role=user)، ولا يلمس
 *    أي جدول آخر؛ والرسالة تُعرض من نتيجة الـ insert لا من الاستطلاع.
 *  • الاستطلاع: آخر 50 رسالة تُدمج بالمعرّف كل 5 ثوانٍ، فلا تفوت رسالة
 *    تشارك أخرى نفس الطابع الزمني، ولا يتكرر عرض رسالة.
 *  • لا مزايا مخترعة: لا Realtime، ولا مؤشر كتابة، ولا حالة «متصل»، ولا نداء
 *    لـ ai-session / ai-gateway (مسار SIE) — الصفحة تقرأ الجدولين مباشرة.
 *  • كل id يقرأه الـ JS موجود فعلًا في الـ HTML.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    MUSE_MODEL_ID, MUSE_SESSION_TITLE, MUSE_SYSTEM_PROMPT, MUSE_GREETING,
    POLL_MS, MESSAGES_LIMIT, mergeMessages,
} from '../assets/js/owner/muse-chat-state.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const chatHtml = () => read('owner/muse-chat.html');
const chatJs = () => read('assets/js/owner/pages/muse-chat.js');
const chatCss = () => read('assets/css/owner-muse-chat.css');
const sidebarHtml = () => read('assets/components/owner-sidebar.html');

/* ─────────────────── دمج الرسائل ─────────────────── */

const msg = (id, created_at, role = 'assistant') => ({ id, role, content: 'x', created_at });

test('دمج الرسائل يزيل المكرر بالمعرّف ويرتب زمنيًا', () => {
    const a = msg('1', '2026-11-22T13:12:00Z');
    const b = msg('2', '2026-11-22T13:11:00Z');
    const merged = mergeMessages([a], [b, { ...a, content: 'y' }]);
    assert.deepEqual(merged.map((m) => m.id), ['2', '1']);
    assert.equal(merged.find((m) => m.id === '1').content, 'y');
});

test('دمج الرسائل يقصّ الأقدم عند تجاوز الحد ويحتفظ بالأحدث', () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
        msg(String(i + 1), `2026-11-22T13:1${i}:00Z`));
    const merged = mergeMessages([], rows, 3);
    assert.deepEqual(merged.map((m) => m.id), ['3', '4', '5']);
});

test('دمج الرسائل لا يعدّل المدخلات ويحتمل الفراغ', () => {
    const existing = [msg('1', '2026-11-22T13:12:00Z')];
    const merged = mergeMessages(existing, null);
    assert.equal(existing.length, 1);
    assert.equal(merged.length, 1);
    assert.deepEqual(mergeMessages(null, null), []);
});

test('ثوابت الجلسة مطابقة للجلسة التجريبية الحالية', () => {
    assert.equal(MUSE_MODEL_ID, 'muse');
    assert.equal(MUSE_SESSION_TITLE, 'Muse — وكيل داخلي');
    assert.equal(POLL_MS, 5000);
    assert.equal(MESSAGES_LIMIT, 200);
    assert.match(MUSE_SYSTEM_PROMPT, /لا تلمس SIE/);
    assert.match(MUSE_SYSTEM_PROMPT, /mahmoud@mad3oom\.com/);
    assert.match(MUSE_GREETING, /وكيلك الداخلي/);
    assert.match(MUSE_GREETING, /كل دقيقة/);
});

/* ─────────────────── الصفحة تلمس الجدولين فقط ─────────────────── */

function fromTables(js) {
    return [...js.matchAll(/\.from\('([^']+)'\)/g)].map((m) => m[1]);
}

test('الصفحة تقرأ وتكتب ai_sessions و ai_session_messages فقط', () => {
    const tables = [...new Set(fromTables(chatJs()))];
    assert.deepEqual(tables.sort(), ['ai_session_messages', 'ai_sessions']);
});

test('الصفحة لا تنادي أي Edge Function ولا مسار SIE', () => {
    const js = chatJs();
    assert.doesNotMatch(js, /functions\.invoke/);
    assert.doesNotMatch(js, /ai-session/);
    assert.doesNotMatch(js, /ai-gateway/);
    assert.doesNotMatch(js, /chat_sessions|chat_messages/);
});

test('البحث عن الجلسة مقيّد بالمالك والموديل والحالة النشطة', () => {
    const js = chatJs();
    assert.match(js, /\.eq\('owner_id',/);
    assert.match(js, /\.eq\('model_id', MUSE_MODEL_ID\)/);
    assert.match(js, /\.eq\('status', 'active'\)/);
    assert.match(js, /\.maybeSingle\(\)/);
});

test('الإرسال insert واحد بدور user وموديل muse', () => {
    const js = chatJs();
    assert.match(js, /role: 'user'/);
    assert.match(js, /model_id: MUSE_MODEL_ID/);
    assert.match(js, /\.select\(MESSAGE_COLUMNS\)\s*\.single\(\)/);
});

test('الاستطلاع كل 5 ثوانٍ ويدمج آخر 50 رسالة بالمعرّف', () => {
    const js = chatJs();
    assert.match(js, /setInterval\(pollMessages, POLL_MS\)/);
    assert.match(js, /\.order\('created_at', \{ ascending: false \}\)/);
    assert.match(js, /\.limit\(50\)/);
    assert.match(js, /mergeMessages\(messages,/);
});

test('لا حالة اتصال مزيفة ولا مؤشر كتابة', () => {
    for (const src of [chatHtml(), chatJs()]) {
        assert.doesNotMatch(src, /متصل/);
        assert.doesNotMatch(src, /online/i);
        assert.doesNotMatch(src, /يكتب الآن|جارٍ الكتابة/);
    }
    assert.match(chatHtml(), /حوالي دقيقة/);
});

/* ─────────────────── الربط بين HTML و JS ─────────────────── */

test('كل id يقرأه الـ JS موجود في الـ HTML', () => {
    const js = chatJs();
    const html = chatHtml();
    const ids = [...new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];
    assert.ok(ids.length > 0, 'لم يُعثر على أي id في الـ JS');
    const missing = ids.filter((id) => !html.includes(`id="${id}"`));
    assert.deepEqual(missing, []);
});

test('الصفحة بنفس قشرة لوحة المالك وتربط أصولها الموجودة', () => {
    const html = chatHtml();
    assert.match(html, /data-owner-page="muse-chat"/);
    assert.match(html, /<script type="module" src="\/assets\/js\/owner\/pages\/muse-chat\.js"><\/script>/);
    assert.match(html, /owner-muse-chat\.css/);
    assert.match(html, /id="sidebar-container"/);
    assert.match(html, /id="ownerGate"/);
    assert.match(html, /id="ownerContent"/);
    assert.ok(fs.existsSync(path.join(ROOT, 'assets/js/owner/pages/muse-chat.js')));
    assert.ok(fs.existsSync(path.join(ROOT, 'assets/css/owner-muse-chat.css')));
});

test('القائمة الجانبية فيها رابط الصفحة بعلامة data-page مطابقة لاسم الملف', () => {
    const sidebar = sidebarHtml();
    assert.match(sidebar, /href="\/owner\/muse-chat\.html" class="sidebar-item" data-page="muse-chat"/);
    assert.match(sidebar, /Muse — الوكيل الداخلي/);
});

test('التنسيق يعرف فقاعات الرسائل وحالة الخطأ', () => {
    const css = chatCss();
    assert.match(css, /\.muse-chat-messages/);
    assert.match(css, /\.muse-msg--user/);
    assert.match(css, /\.muse-msg--assistant/);
    assert.match(css, /\.muse-chat-error/);
});

test('قاعدة [hidden] عامة حتى لا يهزم display:flex شريط الخطأ المخفي', () => {
    // درس شريط التسجيل: display:flex على عنصر hidden يظهره فارغًا عند التحميل.
    assert.match(chatCss(), /\[hidden\]\s*\{\s*display:\s*none !important;\s*\}/);
});
