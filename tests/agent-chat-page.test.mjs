/**
 * اختبارات صفحة شات الوكلاء (owner/agent-chat.html).
 *
 * نوعان من الفحوص (نفس نمط agent-manager-hermes.test.mjs و
 * agent-admin-page.test.mjs):
 *  • اختبارات وحدة حقيقية للمنطق الخالص في agent-chat.js (الجاهزية، جسم
 *    المحادثة، فكّ SSE، فكّ JSON، تصنيف خطأ المفتاح، سجل المحادثة):
 *    يُستخرَج القسم بين علامتَي «منطق خالص» ويُنفَّذ في Node — أي تغيير
 *    في توقيع دالة يُفشل التجريد بصوت عالٍ بدل اختبار نسخة قديمة بصمت.
 *  • فحوص ساكنة على المصدر والصفحة: الـ ids، النموذج الافتراضي، البث
 *    الافتراضي مفعّل، النقل عبر chatWithAgent فقط (لا Hermes مباشرًا من
 *    المتصفح)، تلميح المفتاح، زر المحادثة الجديدة، وقشرة المالك.
 *
 * بلا أي نداء حيّ: لا مفاتيح، لا chat فعلية.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const pageJs = () => read('assets/js/owner/pages/agent-chat.js');
const pageHtml = () => read('owner/agent-chat.html');

/* ── استخراج المنطق الخالص من agent-chat.js وتنفيذه ─────────────────── */

function extractPureBlock() {
    const src = pageJs();
    const startMarker = '/* ── منطق خالص:';
    const endMarker = '/* ── نهاية المنطق الخالص ── */';
    const start = src.indexOf(startMarker);
    const end = src.indexOf(endMarker);
    assert.ok(start !== -1, 'علامة بداية المنطق الخالص مفقودة من agent-chat.js');
    assert.ok(end !== -1 && end > start, 'علامة نهاية المنطق الخالص مفقودة من agent-chat.js');
    const commentClose = src.indexOf('*/', start);
    const block = src.slice(commentClose + 2, end);
    // القسم الخالص بلا أي اعتماد خارجي — لو تسلّل إليه DOM أو استيراد،
    // فالتجريد نفسه يكشف ذلك قبل أي اختبار.
    assert.doesNotMatch(block, /document|window|getElementById|fetchAgents|chatWithAgent/);
    return block.replace(/^export /gm, '');
}

const PURE = extractPureBlock();
const {
    DEFAULT_MODEL, MISSING_KEY_HINT, isAgentReady, partitionAgents, buildChatBody,
    extractStreamedTokens, extractStreamedText, extractReplyText, extractChatText,
    isMissingKeyError, createChatState,
} = new Function(`${PURE}; return { DEFAULT_MODEL, MISSING_KEY_HINT, isAgentReady, partitionAgents, buildChatBody, extractStreamedTokens, extractStreamedText, extractReplyText, extractChatText, isMissingKeyError, createChatState };`)();

/* ── منتقي الوكلاء: الجاهزية ─────────────────────────────────────────── */

test('الوكيل الجاهز = مفعّل + endpoint + آخر 4 خانات من المفتاح', () => {
    const ready = { id: 'a1', name: 'Hermes', enabled: true, endpoint: 'https://hermes.internal:8080', api_key_last4: 'abcd' };
    assert.equal(isAgentReady(ready), true);
    assert.equal(isAgentReady({ ...ready, enabled: false }), false);
    assert.equal(isAgentReady({ ...ready, enabled: undefined }), false);
    assert.equal(isAgentReady({ ...ready, endpoint: '' }), false);
    assert.equal(isAgentReady({ ...ready, endpoint: '   ' }), false);
    assert.equal(isAgentReady({ ...ready, endpoint: null }), false);
    assert.equal(isAgentReady({ ...ready, api_key_last4: '' }), false);
    assert.equal(isAgentReady({ ...ready, api_key_last4: null }), false);
    assert.equal(isAgentReady({ ...ready, api_key_last4: undefined }), false);
    assert.equal(isAgentReady(null), false);
    assert.equal(isAgentReady({}), false);
});

test('وكيل بلا مفتاح (مثل Hermes في بيانات اختبار الصفحات) غير جاهز', () => {
    // بيانات fixtures في owner-pages.render.test.mjs: Hermes فيه endpoint
    // بلا api_key_last4، وMuse بلا endpoint أصلًا — كلاهما غير جاهز هناك.
    const hermesFixture = { id: 'ag-hermes', name: 'Hermes', enabled: true, endpoint: 'https://hermes.internal:8080' };
    const museFixture = { id: 'ag-muse', name: 'Muse', enabled: true, endpoint: null };
    assert.equal(isAgentReady(hermesFixture), false);
    assert.equal(isAgentReady(museFixture), false);
    assert.deepEqual(partitionAgents([museFixture, hermesFixture]).ready, []);
    assert.equal(partitionAgents([museFixture, hermesFixture]).notReady.length, 2);
});

test('تقسيم القائمة يحافظ على الترتيب ويفصل الجاهز عن غير الجاهز', () => {
    const ready = { id: 'r1', enabled: true, endpoint: 'https://x:8080', api_key_last4: '1234' };
    const noKey = { id: 'n1', enabled: true, endpoint: 'https://x:8080', api_key_last4: '' };
    const noEndpoint = { id: 'n2', enabled: true, endpoint: null, api_key_last4: '1234' };
    const { ready: r, notReady: nr } = partitionAgents([noKey, ready, noEndpoint]);
    assert.deepEqual(r.map((a) => a.id), ['r1']);
    assert.deepEqual(nr.map((a) => a.id), ['n1', 'n2']);
    assert.deepEqual(partitionAgents(null), { ready: [], notReady: [] });
    assert.deepEqual(partitionAgents(undefined), { ready: [], notReady: [] });
});

/* ── جسم المحادثة: النموذج الافتراضي ─────────────────────────────────── */

test('النموذج الافتراضي hermes-agent ويُرسَل صريحًا', () => {
    assert.equal(DEFAULT_MODEL, 'hermes-agent');
    const body = buildChatBody({ model: 'hermes-agent', messages: [{ role: 'user', content: 'مرحبًا' }], stream: true });
    assert.equal(body.model, 'hermes-agent');
    assert.equal(body.stream, true);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'مرحبًا' }]);
});

test('حقل النموذج الفارغ = الافتراضي على الخادم (لا model في الجسم)', () => {
    assert.equal(buildChatBody({ model: '', messages: [], stream: false }).model, undefined);
    assert.equal(buildChatBody({ model: '   ', messages: [], stream: false }).model, undefined);
    assert.equal(buildChatBody({ messages: [], stream: false }).model, undefined);
    assert.equal('model' in buildChatBody({ model: '', messages: [], stream: false }), false);
});

test('تجاوز النموذج يمرّ كما هو بلا مساس', () => {
    const body = buildChatBody({ model: '  nvidia/nemotron-3-ultra-550b-a55b  ', messages: [], stream: false });
    assert.equal(body.model, 'nvidia/nemotron-3-ultra-550b-a55b');
    assert.equal(body.stream, false);
});

/* ── المسار المتدفق: فكّ SSE الخام ───────────────────────────────────── */

const SSE_RAW = [
    'event: message',
    'data: {"choices":[{"delta":{"content":"مرحبًا"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":" بك"}}]}',
    'data: [DONE]',
    'data: {"choices":[{"delta":{"content":"!"}}]}',
    'data: not-json',
    '',
].join('\n');

test('فكّ نص SSE الخام: توكنات delta فقط، ويُتخطى [DONE] وغير JSON', () => {
    assert.deepEqual(extractStreamedTokens(SSE_RAW), ['مرحبًا', ' بك', '!']);
    assert.equal(extractStreamedText(SSE_RAW), 'مرحبًا بك!');
    assert.deepEqual(extractStreamedTokens(''), []);
    assert.deepEqual(extractStreamedTokens(null), []);
    assert.deepEqual(extractStreamedTokens('data: [DONE]\n'), []);
});

test('المسار المتدفق يقرأ { streamed: true, raw } من agent-manager', () => {
    const result = { ok: true, data: { streamed: true, raw: SSE_RAW } };
    assert.equal(extractChatText(result, true), 'مرحبًا بك!');
    // رد JSON عادي رغم طلب البث (توافق): يُفسَّر كغير متدفق.
    assert.equal(extractChatText({ ok: true, data: { choices: [{ message: { content: 'رد عادي' } }] } }, true), 'رد عادي');
});

/* ── المسار غير المتدفق: فكّ JSON ─────────────────────────────────────── */

test('المسار غير المتدفق يقرأ choices[0].message.content بصيغة OpenAI', () => {
    const result = { ok: true, data: { choices: [{ message: { role: 'assistant', content: 'أهلًا بك' } }] } };
    assert.equal(extractChatText(result, false), 'أهلًا بك');
    assert.equal(extractReplyText({ choices: [{ message: { content: 'x' } }] }), 'x');
    assert.equal(extractReplyText({ content: 'بديل' }), 'بديل');
    assert.equal(extractReplyText({ text: 'نص' }), 'نص');
    assert.equal(extractReplyText('نص خام'), 'نص خام');
    assert.equal(extractReplyText(null), '');
    assert.equal(extractReplyText({}), '');
    assert.equal(extractReplyText({ choices: [] }), '');
});

/* ── المفتاح المفقود: فشل هادئ بتلميح لا عطل ─────────────────────────── */

test('خطأ المفتاح المفقود/غير الصالح يُصنَّف تلميحًا لا عطلًا عامًا', () => {
    // ما يرجعه الخادم فعليًا عند 401 من Hermes: «الوكيل رد بخطأ (401)».
    assert.equal(isMissingKeyError(new Error('الوكيل رد بخطأ (401)')), true);
    assert.equal(isMissingKeyError(new Error('الوكيل رد بخطأ (403)')), true);
    assert.equal(isMissingKeyError(new Error('Unauthorized')), true);
    assert.equal(isMissingKeyError(new Error('لا يوجد مفتاح API لهذا الوكيل')), true);
    assert.equal(isMissingKeyError(new Error('تعذّر إرسال الرسالة، حاول مجددًا')), false);
    assert.equal(isMissingKeyError(new Error('تعذّر الوصول إلى الوكيل: timeout')), false);
    assert.equal(isMissingKeyError(null), false);
    assert.equal(MISSING_KEY_HINT, 'أضف المفتاح أولًا');
});

test('مسار الإرسال يميّز خطأ المفتاح ويعرض التلميح بدل رسالة عامة', () => {
    const js = pageJs();
    assert.match(js, /if \(isMissingKeyError\(err\)\)/);
    assert.match(js, /appendMissingKeyHint\(\)/);
    assert.match(js, /تعذّر إرسال الرسالة، حاول مجددًا/);
    // فقاعة التلميح فيها رابط داخل اللوحة نفسها إلى صفحة الوكلاء.
    assert.match(js, /link\.href = '\/owner\/agents\.html'/);
    assert.match(js, /MISSING_KEY_HINT/);
});

/* ── المحادثة الجديدة: إفراغ السجل ───────────────────────────────────── */

test('clear يفرغ سجل المحادثة في الذاكرة', () => {
    const state = createChatState();
    state.add('user', 'مرحبًا');
    state.add('assistant', 'أهلًا');
    assert.equal(state.messages.length, 2);
    state.clear();
    assert.deepEqual(state.messages, []);
    state.add('user', 'جديدة');
    assert.equal(state.messages.length, 1);
});

test('زر «محادثة جديدة» موصول بمسح السجل وإعادة الحالة الفارغة', () => {
    const js = pageJs();
    const html = pageHtml();
    assert.match(html, /id="btnClearChat"/);
    assert.match(html, /محادثة جديدة/);
    assert.match(js, /\$\('btnClearChat'\)\.addEventListener\('click', clearChat\)/);
    assert.match(js, /function clearChat\(\)/);
    assert.match(js, /chatState\.clear\(\)/);
    // المسح يوقف البث التدريجي الجاري أيضًا.
    assert.match(js, /function clearChat\(\) \{[\s\S]*?stopReveal\(\)/);
});

/* ── البث الافتراضي مفعّل والنموذج الافتراضي في الصفحة ───────────────── */

test('مبدّل البث مفعّل افتراضيًا وحقل النموذج افتراضيه hermes-agent', () => {
    const html = pageHtml();
    assert.match(html, /id="streamToggle" checked/);
    assert.match(html, /id="modelInput" value="hermes-agent"/);
    assert.match(html, /بث مباشر/);
    const js = pageJs();
    assert.match(js, /\$\('streamToggle'\)\.checked/);
    assert.match(js, /\$\('modelInput'\)\.value/);
});

/* ── النقل: عبر chatWithAgent فقط — لا Hermes مباشرًا من المتصفح ─────── */

test('الإرسال عبر chatWithAgent من agent-service فقط', () => {
    const js = pageJs();
    assert.match(js, /import \{ fetchAgents, chatWithAgent \} from '\/agent-service\.js'/);
    assert.match(js, /await chatWithAgent\(selectedAgent\.id, body\)/);
    assert.match(js, /fetchAgents\(\)/);
    // لا fetch مباشر إطلاقًا في الصفحة — لا Edge Function ولا Hermes.
    assert.doesNotMatch(js, /fetch\(/);
    assert.doesNotMatch(js, /\/v1\/chat\/completions/);
    assert.doesNotMatch(js, /code\.run|hermes\.internal/);
    // لا مفتاح في المتصفح: الصفحة لا تقرأ حقل api_key إطلاقًا (فقط
    // api_key_last4 للعرض، واسم api_key داخل نمط تصنيف الخطأ لا قراءة حقل).
    assert.doesNotMatch(js, /\.api_key(?!_last4)/);
    assert.doesNotMatch(js, /agent\.api_key[^_]/);
});

/* ── قشرة المالك وبوابة الأدمن ───────────────────────────────────────── */

test('قشرة المالك: نفس بوابة agents.html لا تحقق إدارة', () => {
    const html = pageHtml();
    const js = pageJs();
    assert.match(html, /data-owner-page="agent-chat"/);
    assert.match(html, /id="sidebar-container"/);
    assert.match(html, /id="ownerGate"/);
    assert.match(html, /id="ownerContent"/);
    assert.match(html, /src="\/assets\/js\/owner\/pages\/agent-chat\.js"/);
    assert.match(html, /شات الوكلاء - لوحة المالك/);
    assert.doesNotMatch(html, /checkAdminAuth|initSidebar|assets\/js\/admin\/auth\.js/);
    assert.doesNotMatch(html, /href="\/admin\/[^"]*\.html"/);
    assert.doesNotMatch(html, /robot\.css/);
    assert.match(js, /bootOwnerPage/);
    assert.match(js, /platformAuthority/);
    assert.match(js, /هذه الصفحة متاحة للأدمن فقط/);
    assert.doesNotMatch(js, /import[^;]*checkAdminAuth|checkAdminAuth\(/);
});

/* ── كل id يقرأه الـ JS موجود فعلاً في الصفحة ────────────────────────── */

test('كل عنصر يطلبه agent-chat.js بالـ id موجود في agent-chat.html', () => {
    const html = pageHtml();
    const js = pageJs();
    const ids = [...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
    assert.ok(ids.length >= 10, `توقعنا 10 ids على الأقل، وجدنا ${ids.length}`);
    const missing = [...new Set(ids)].filter((id) => !html.includes(`id="${id}"`));
    assert.deepEqual(missing, [], `عناصر مفقودة من الصفحة: ${missing.join(', ')}`);
});

test('منتقي الوكلاء عنصر ثابت في الصفحة (جاهز حتى بلا وكلاء)', () => {
    const html = pageHtml();
    assert.match(html, /id="agentPicker"/);
    assert.match(html, /id="agentPickerList"/);
    assert.match(html, /id="agentPickerHint"/);
    assert.match(html, /id="chatMessages"/);
    assert.match(html, /id="chatInput"/);
    assert.match(html, /id="btnSendChat"/);
    // رسالة الخطأ المحايدة في مسار الإرسال بالـ JS.
    assert.match(pageJs(), /تعذّر إرسال الرسالة، حاول مجددًا/);
});
