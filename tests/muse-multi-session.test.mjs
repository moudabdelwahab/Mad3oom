/**
 * اختبارات الجلسات المتعددة والوكيل المساعد والكوتة في شات Muse
 * (owner/muse-chat.html) — tests/muse-multi-session.test.mjs.
 *
 * ما تحرسه هذه الاختبارات:
 *
 *  • الوكلاء اثنان فقط: Muse الرئيسي + Muse Assistant العام (muse-assistant)
 *    — لا متخصصين ضيّقين (لا muse-tickets ولا muse-customers ولا
 *    muse-subscriptions)، والمساعد العام بتوجيه عام لا بتخصص.
 *  • الجلسات: ترتيب بالأحدث نشاطًا، واختيار المحفوظة عند التحميل، وعنوان
 *    تلقائي من أول رسالة لا يكتب فوق إعادة تسمية يدوية أبدًا.
 *  • الحذف: رسائل الجلسة تُحذف صراحةً قبل الجلسة نفسها، وبتأكيد في الصفحة.
 *  • الكوتة: تُعرض فقط من extensions.quota للجلسة النشطة عند وجود
 *    remaining، وتُخفى تمامًا عند غيابها — لا رقم من مصدر آخر ولا مخترع.
 *  • لا تفعيل حسابات أخرى ولا أي كتابة في ai_agents من هذه الصفحة.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    MUSE_MODEL_ID, MUSE_SYSTEM_PROMPT, MUSE_GREETING,
    MUSE_AGENTS, agentForModelId, agentModelIds,
    sortSessions, pickActiveSession, deriveTitle, AUTO_TITLE_MAX,
    isRenamed, withRenamed, withoutRenamed, shouldAutoTitle, hasUserMessage,
    formatQuota, parseQuota, parseQuotaPercent, parseQuotaReset,
    formatQuotaDate, normalizeQuotaPlan, QUOTA_LOW_THRESHOLD,
    RENAMED_SESSIONS_KEY, ACTIVE_SESSION_KEY,
} from '../assets/js/owner/muse-chat-state.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const chatHtml = () => read('owner/muse-chat.html');
const chatJs = () => read('assets/js/owner/pages/muse-chat.js');
const chatStateJs = () => read('assets/js/owner/muse-chat-state.js');
const chatCss = () => read('assets/css/owner-muse-chat.css');

/* ─────────────────── الوكلاء: اثنان فقط، والمساعد عام ─────────────────── */

test('الوكلاء اثنان فقط: Muse الرئيسي و Muse Assistant العام', () => {
    assert.equal(MUSE_AGENTS.length, 2);
    assert.deepEqual(agentModelIds(), ['muse', 'muse-assistant']);
    assert.equal(agentForModelId('muse').label, 'Muse — الوكيل الداخلي');
    assert.equal(agentForModelId('muse-assistant').label, 'Muse Assistant — مساعد عام');
    assert.equal(agentForModelId('muse').specialty, null);
    assert.equal(agentForModelId('muse-assistant').specialty, 'مساعد عام');
});

test('لا متخصصين ضيّقين في أي ملف من ملفات الشات', () => {
    for (const src of [chatStateJs(), chatJs(), chatHtml()]) {
        assert.doesNotMatch(src, /muse-tickets/);
        assert.doesNotMatch(src, /muse-customers/);
        assert.doesNotMatch(src, /muse-subscriptions/);
        assert.doesNotMatch(src, /وكيل التذاكر|وكيل العملاء|وكيل الاشتراكات/);
    }
});

test('توجيه المساعد العام عام بلا تخصص مقيّد وبنفس قواعد الحماية', () => {
    const assistant = agentForModelId('muse-assistant');
    assert.match(assistant.systemPrompt, /عام/);
    assert.match(assistant.systemPrompt, /mahmoud@mad3oom\.com/);
    assert.match(assistant.systemPrompt, /لا تلمس SIE/);
    assert.match(assistant.systemPrompt, /لا ترسل واتساب/);
    assert.doesNotMatch(assistant.systemPrompt, /متخصص في/);
    assert.match(assistant.greeting, /مساعدك العام/);
});

test('توجيه Muse الرئيسي حرفي من الجلسة التجريبية', () => {
    assert.match(MUSE_SYSTEM_PROMPT, /لا تلمس SIE/);
    assert.match(MUSE_SYSTEM_PROMPT, /mahmoud@mad3oom\.com/);
    assert.equal(agentForModelId('muse').systemPrompt, MUSE_SYSTEM_PROMPT);
    assert.equal(agentForModelId('muse').greeting, MUSE_GREETING);
});

test('موديل غير معروف يرجع للوكيل الرئيسي ولا ينهار', () => {
    assert.equal(agentForModelId('unknown-model').modelId, 'muse');
    assert.equal(agentForModelId(undefined).modelId, 'muse');
});

/* ─────────────────── ترتيب الجلسات واختيار النشطة ─────────────────── */

const sess = (id, last_active_at, created_at = '2026-11-22T13:00:00Z') =>
    ({ id, title: id, model_id: 'muse', last_active_at, created_at });

test('ترتيب الجلسات: الأحدث نشاطًا أولًا، وcreated_at بديلًا', () => {
    const rows = [
        sess('a', '2026-11-22T13:10:00Z'),
        sess('b', null, '2026-11-22T13:20:00Z'),
        sess('c', '2026-11-22T13:30:00Z'),
    ];
    assert.deepEqual(sortSessions(rows).map((s) => s.id), ['c', 'b', 'a']);
    assert.deepEqual(sortSessions(null), []);
});

test('اختيار الجلسة النشطة: المحفوظة أولًا، ثم الأحدث، ثم null', () => {
    const rows = [sess('a', '2026-11-22T13:10:00Z'), sess('c', '2026-11-22T13:30:00Z')];
    assert.equal(pickActiveSession(rows, 'a').id, 'a');
    assert.equal(pickActiveSession(rows, 'gone').id, 'c');
    assert.equal(pickActiveSession(rows, null).id, 'c');
    assert.equal(pickActiveSession([], null), null);
});

/* ─────────────────── العناوين التلقائية وإعادة التسمية ─────────────────── */

test('العنوان التلقائي: أول رسالة مقصوصة عند 40 حرفًا مع «…»', () => {
    assert.equal(AUTO_TITLE_MAX, 40);
    assert.equal(deriveTitle('  أهلا   بك  '), 'أهلا بك');
    assert.equal(deriveTitle('سؤال قصير'), 'سؤال قصير');
    const long = 'س'.repeat(60);
    assert.equal(deriveTitle(long), `${'س'.repeat(39)}…`);
    assert.equal(deriveTitle('   '), '');
    assert.equal(deriveTitle(null), '');
});

test('إعادة التسمية اليدوية تمنع التسمية التلقائية نهائيًا', () => {
    const session = { id: 's1' };
    assert.equal(shouldAutoTitle(session, new Set()), true);
    const renamed = withRenamed(new Set(), 's1');
    assert.equal(isRenamed(renamed, 's1'), true);
    assert.equal(isRenamed(renamed, 's2'), false);
    assert.equal(shouldAutoTitle(session, renamed), false);
    assert.equal(isRenamed(withoutRenamed(renamed, 's1'), 's1'), false);
    assert.equal(shouldAutoTitle(null, new Set()), false);
});

test('الجلسة بلا رسالة مستخدم تُسمّى مرة واحدة فقط', () => {
    assert.equal(hasUserMessage([]), false);
    assert.equal(hasUserMessage([{ role: 'assistant' }]), false);
    assert.equal(hasUserMessage([{ role: 'assistant' }, { role: 'user' }]), true);
});

test('مفاتيح التخزين المحلي للتسمية والجلسة النشطة ثابتة', () => {
    assert.equal(RENAMED_SESSIONS_KEY, 'muse-chat-renamed-sessions');
    assert.equal(ACTIVE_SESSION_KEY, 'muse-chat-active-session');
    assert.match(chatJs(), /RENAMED_SESSIONS_KEY/);
    assert.match(chatJs(), /ACTIVE_SESSION_KEY/);
});

/* ─────────────────── الكوتة: من extensions.quota فقط ─────────────────── */

test('تنسيق الكوتة: المتبقي فقط، ومع الخطة والتجديد عند وجودهما', () => {
    assert.equal(formatQuota(null), null);
    assert.equal(formatQuota(undefined), null);
    assert.equal(formatQuota({}), null);
    assert.equal(formatQuota({ plan: 'pro' }), null);
    assert.equal(formatQuota({ remaining: 120 }), 'المتبقي من الكوتة: 120');
    assert.equal(formatQuota({ remaining: 0 }), 'المتبقي من الكوتة: 0');
    assert.equal(
        formatQuota({ plan: 'pro', remaining: '50 رسالة', reset: '2026-12-01' }),
        'المتبقي من الكوتة: 50 رسالة — الخطة: pro — التجديد: 1 ديسمبر 2026');
    assert.equal(
        formatQuota({ plan: 'Free (weekly limit)', used: '49%', remaining: '51%', reset: '2026-11-26 23:15 EET', updated_at: '2026-11-22T21:05:10Z' }),
        'المتبقي من الكوتة: 51% — الخطة: المجانية (أسبوعية) — التجديد: 26 نوفمبر 2026 في 11:15 م');
    assert.equal(
        formatQuota({ plan: 'free', used: '33% of free weekly limit', remaining: '67% of free weekly limit', reset: 'Nov 26 at 11:15 PM EET', updated_at: '2026-11-22T15:21:08Z' }),
        'المتبقي من الكوتة: 67% — الخطة: المجانية — التجديد: 26 نوفمبر 2026 في 11:15 م');
    assert.equal(formatQuota('120'), null);
});

test('تحليل الكوتة: الصيغتان الحيّتان للقطة تعطيان نفس العرض النظيف', () => {
    const fresh = { plan: 'Free (weekly limit)', used: '49%', reset: '2026-11-26 23:15 EET', remaining: '51%', updated_at: '2026-11-22T21:05:10Z' };
    const stale = { plan: 'free', used: '33% of free weekly limit', reset: 'Nov 26 at 11:15 PM EET', remaining: '67% of free weekly limit', updated_at: '2026-11-22T15:21:08Z' };
    const pf = parseQuota(fresh);
    const ps = parseQuota(stale);
    assert.equal(pf.remainingLabel, '51%');
    assert.equal(pf.remainingPct, 51);
    assert.equal(pf.usedPct, 49);
    assert.equal(pf.pct, 51);
    assert.equal(pf.planLabel, 'المجانية (أسبوعية)');
    assert.equal(pf.resetLabel, '26 نوفمبر 2026 في 11:15 م');
    assert.equal(pf.low, false);
    assert.ok(pf.updatedAt instanceof Date);
    assert.equal(ps.remainingLabel, '67%');
    assert.equal(ps.remainingPct, 67);
    assert.equal(ps.usedPct, 33);
    assert.equal(ps.planLabel, 'المجانية');
    assert.equal(ps.resetLabel, '26 نوفمبر 2026 في 11:15 م');
    assert.equal(ps.low, false);
    // منخفضة: أقل من 20% تحذير؛ وبلا remaining مئوية تُشتق من used.
    assert.equal(parseQuota({ remaining: '15%', used: '85%' }).low, true);
    assert.equal(parseQuota({ remaining: '15%', used: '85%' }).pct, 15);
    assert.equal(parseQuota({ used: '80%' }), null);
    assert.equal(parseQuota({ remaining: '120 رسالة' }).pct, null);
    assert.equal(parseQuota({ remaining: '120 رسالة' }).remainingLabel, '120 رسالة');
    // أدوات التحليل وحدها.
    assert.equal(parseQuotaPercent('67% of free weekly limit'), 67);
    assert.equal(parseQuotaPercent('50 رسالة'), null);
    assert.equal(parseQuotaPercent(51), null); // عدد خام = عدد رسائل، لا نسبة
    assert.equal(normalizeQuotaPlan('Free (weekly limit)'), 'المجانية (أسبوعية)');
    assert.equal(normalizeQuotaPlan('free'), 'المجانية');
    assert.equal(normalizeQuotaPlan('pro'), 'pro');
    assert.equal(formatQuotaDate(new Date('2026-11-26T21:15:00Z')), '26 نوفمبر 2026 في 11:15 م');
    assert.equal(formatQuotaDate(new Date('2026-12-01T00:00:00Z'), false), '1 ديسمبر 2026');
    assert.equal(QUOTA_LOW_THRESHOLD, 20);
});

test('الصفحة تقرأ extensions من صف الجلسة وتحدّث الكوتة دوريًا', () => {
    const js = chatJs();
    assert.match(js, /extensions, last_active_at/);
    assert.match(js, /parseQuota\(session\?\.extensions\?\.quota\)/);
    assert.match(js, /QUOTA_REFRESH_MS/);
    assert.match(js, /Date\.now\(\) - lastQuotaRefreshAt > QUOTA_REFRESH_MS/);
    assert.match(js, /refreshQuota\(\)/);
    assert.match(js, /\.select\('extensions'\)/);
    assert.match(js, /\.eq\('id', sessionId\)/);
});

/* ─────────────────── الصفحة: القائمة والاختيار والحذف ─────────────────── */

test('الصفحة فيها اختيار وكيل بزرّين ومحادثة جديدة وقائمة جلسات', () => {
    const html = chatHtml();
    assert.match(html, /class="muse-agent-picker"/);
    assert.match(html, /data-model-id="muse"/);
    assert.match(html, /data-model-id="muse-assistant"/);
    assert.equal((html.match(/data-model-id="/g) || []).length, 2);
    assert.match(html, /id="museNewChatBtn"/);
    assert.match(html, /محادثة جديدة/);
    assert.match(html, /id="museSessionList"/);
    assert.match(html, /id="museSessionsEmpty"/);
});

test('عنصر الكوتة في الترويسة مخفي افتراضيًا ويظهر دائمًا — بطاقة أو تلميح', () => {
    const html = chatHtml();
    assert.match(html, /<div class="muse-quota" id="museQuota"[^>]*hidden/);
    assert.match(chatJs(), /el\.hidden = false/);
    assert.doesNotMatch(chatJs(), /el\.hidden = true/);
    assert.match(chatJs(), /muse-quota-bar/);
    assert.match(chatJs(), /muse-quota-empty/);
    assert.match(chatJs(), /muse-quota-low/);
    assert.match(chatJs(), /role="progressbar"/);
});

test('نصوص الصفحة تعكس الجسر الدائم: 15 ثانية لا دقيقة', () => {
    const html = chatHtml();
    assert.match(html, /كل 15 ثانية/);
    assert.doesNotMatch(html, /يفحص المحادثة كل دقيقة/);
    assert.match(chatStateJs(), /كل 15 ثانية/);
    assert.doesNotMatch(chatStateJs(), /كل دقيقة/);
    assert.match(MUSE_GREETING, /أقل من دقيقة/);
});

test('نافذة تأكيد الحذف موجودة بأزرارها ونصها العربي', () => {
    const html = chatHtml();
    assert.match(html, /id="museDeleteConfirm"/);
    assert.match(html, /id="museDeleteConfirmName"/);
    assert.match(html, /id="museDeleteConfirmBtn"/);
    assert.match(html, /id="museDeleteCancelBtn"/);
    assert.match(html, /حذف المحادثة؟/);
    assert.match(html, /حذف نهائيًا/);
    assert.match(html, /ولا يمكن التراجع/);
});

test('تحميل الجلسات مقيّد بالمالك وموديلات الوكلاء والحالة النشطة', () => {
    const js = chatJs();
    assert.match(js, /\.eq\('owner_id', ownerId\)/);
    assert.match(js, /\.in\('model_id', agentModelIds\(\)\)/);
    assert.match(js, /\.eq\('status', 'active'\)/);
    assert.match(js, /\.order\('last_active_at', \{ ascending: false \}\)/);
});

test('إنشاء جلسة الوكيل بتوجيهه وعنوانه وترحيبه، وإيجادها قبل الإنشاء', () => {
    const js = chatJs();
    assert.match(js, /title: agent\.label/);
    assert.match(js, /system_prompt: agent\.systemPrompt/);
    assert.match(js, /content: agent\.greeting/);
    assert.match(js, /findOrCreateAgentSession/);
    assert.match(js, /sessions\.find\(\(s\) => s\.model_id === modelId\)/);
});

test('الحذف يطلب تأكيدًا ويحذف الرسائل صراحةً قبل الجلسة', () => {
    const js = chatJs();
    assert.match(js, /askDeleteSession\(session\)/);
    assert.match(js, /pendingDeleteId/);
    const msgDelete = js.indexOf(".from('ai_session_messages')\n            .delete()");
    const sessDelete = js.indexOf(".from('ai_sessions')\n            .delete()");
    assert.ok(msgDelete > 0, 'حذف صريح للرسائل غير موجود');
    assert.ok(sessDelete > msgDelete, 'حذف الجلسة يجب أن يأتي بعد حذف رسائلها');
    assert.match(js, /ON DELETE CASCADE/);
    assert.match(js, /\.eq\('session_id', id\)/);
});

test('إعادة التسمية حقل تحرير داخل القائمة: Enter يحفظ و Esc يلغي', () => {
    const js = chatJs();
    assert.match(js, /startRename\(li, session\)/);
    assert.match(js, /muse-session-rename-input/);
    assert.match(js, /e\.key === 'Enter'/);
    assert.match(js, /e\.key === 'Escape'/);
    assert.match(js, /withRenamed\(renamedIds, id\)/);
    assert.match(js, /deriveSmartTitle\(text\)/);
    assert.match(js, /shouldAutoTitle\(activeSession, renamedIds\)/);
});

test('التبديل بين الجلسات يبدّل العدّاد معها ويحفظ النشطة', () => {
    const js = chatJs();
    assert.match(js, /switchSession\(session\.id\)/);
    assert.match(js, /storeActiveSession\(sessionId\)/);
    assert.match(js, /stopWaitTimer\(\);/);
    assert.match(js, /waitingSince\(messages\)/);
    assert.match(js, /switchToken/);
});

test('الإرسال بموديل الجلسة النشطة ويلمّس آخر نشاط وعنوانها تلقائيًا', () => {
    const js = chatJs();
    assert.match(js, /model_id: activeModelId/);
    assert.match(js, /last_active_at: new Date\(\)\.toISOString\(\)/);
    assert.match(js, /hasUserMessage\(messages\)/);
});

test('لا تفعيل حسابات أخرى ولا كتابة في ai_agents من هذه الصفحة', () => {
    const js = chatJs();
    assert.doesNotMatch(js, /from\('ai_agents'\)/);
    assert.doesNotMatch(js, /فعّل حساب|أضف حساب|بدّل الحساب|حساب آخر/);
    assert.doesNotMatch(js, /chat_sessions|chat_messages/);
    assert.doesNotMatch(js, /functions\.invoke/);
});

test('التنسيق يعرف التخطيط والقائمة والاختيار والكوتة ونافذة الحذف', () => {
    const css = chatCss();
    assert.match(css, /\.muse-chat-layout/);
    assert.match(css, /\.muse-sessions-panel/);
    assert.match(css, /\.muse-agent-chip\.is-active/);
    assert.match(css, /\.muse-session-list/);
    assert.match(css, /\.muse-session-item\.is-active/);
    assert.match(css, /\.muse-session-badge/);
    assert.match(css, /\.muse-quota/);
    assert.match(css, /\.muse-quota-bar/);
    assert.match(css, /\.muse-quota-bar-fill/);
    assert.match(css, /\.muse-quota\.is-low/);
    assert.match(css, /\.muse-confirm\s*\{/);
    assert.match(css, /z-index:\s*3000/);
});
