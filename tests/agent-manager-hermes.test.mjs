/**
 * اختبارات تكييف Hermes في agent-manager (supabase/functions/agent-manager/index.ts).
 *
 * الدالة Edge تحتاج Deno وSupabase حيًّا فلا تُشغَّل هنا، لكن عقد Hermes
 * قابل للإثبات من المصدر نفسه — أي انحراف عنه يعيد كسر التكامل مع الخادم
 * الحي (https://p01--hermes-agent--myj7pmxktb75.code.run)، والاختبار يفشل
 * قبل أن يصل الكود إلى مراجعة بشرية.
 *
 * نوعان من الفحوص:
 *  • فحوص ساكنة على المصدر (نفس نمط api-token-function-static.test.mjs):
 *    الإجراءات الجديدة، ومسارات Hermes، وإسقاط Authorization عن /health،
 *    وبدء/إيقاف Hermes بلا /control، وlogs غير المدعومة، وافتراضيات
 *    model/provider قبل النشر (لا model بلا provider أبدًا)، وحفظ سلوك
 *    غير-Hermes حرفيًا.
 *  • اختبارات وحدة حقيقية للدوال النقية المستخرَجة من المصدر نفسه
 *    (parseSseDataPayloads وapplyHermesModelDefaults ومساعدات المسارات
 *    وتمرير الجسم): تُستخرج الدوال
 *    من index.ts وتُنفَّذ بعد تجريد تعليقات TypeScript البسيطة فيها، لأن
 *    ملف Deno لا يُستورَد مباشرة في Node بسبب استيرادات jsr:. أي تغيير
 *    في توقيع دالة يُفشل التجريد بصوت عالٍ بدل اختبار نسخة قديمة بصمت.
 *
 * بلا أي نداء حيّ: لا مفاتيح، لا chat/runs فعلية — المحادثة مؤكدة حيًا
 * من Mahmoud (2026-11-27) بالزوج العامل nvidia فقط؛ النموذج الافتراضي
 * للخادم لم يُضبط بعد، فإرسال "hermes-agent" وحدها يفشل.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'supabase/functions/agent-manager/index.ts'), 'utf8');

/** جسم الدالة بلا تعليقات — الفحوص يجب أن تنظر إلى الكود لا إلى شرحه. */
function codeOnly(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter(line => !line.trim().startsWith('//'))
        .join('\n');
}

const CODE = codeOnly(SRC);

/* ── أجسام اختبار: الزوج الافتراضي العامل (nvidia) ───────────────────── */
// الزوج العامل الافتراضي، مؤكد حيًا 2026-11-27: المحادثة تعمل فقط
// بـ model + provider معًا. "hermes-agent" تسمية فقط من GET /v1/models
// وليست قيمة نموذج عاملة — إرسالها وحدها يفشل.
const DEFAULT_CHAT_BODY = {
    model: 'nvidia/nemotron-3-ultra-550b-a55b',
    provider: 'nvidia',
    messages: [{ role: 'user', content: 'مرحبًا' }],
    stream: false,
};

// تجاوز نموذج محدد يتطلب model + provider معًا — لا model وحده.
const OVERRIDE_CHAT_BODY = {
    model: 'nvidia/nemotron-3-ultra-550b-a55b',
    provider: 'nvidia',
    model_options: { reasoning_effort: 'high', service_tier: 'flex' },
    messages: [{ role: 'user', content: 'مرحبًا' }],
    stream: true,
};

/* ── استخراج الدوال النقية من المصدر وتنفيذها ─────────────────────────── */

function stripFn(name, replacements) {
    const m = SRC.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
    assert.ok(m, `الدالة ${name} غير موجودة في index.ts`);
    let js = m[0];
    for (const [from, to] of replacements) {
        assert.ok(js.includes(from), `تجريد ${name}: لم نجد «${from}» — تغيّر توقيع الدالة؟`);
        js = js.split(from).join(to);
    }
    for (const leftover of [': string', ': number', ': boolean', ': unknown', ' as ', 'Record<', '| null', '| undefined']) {
        assert.ok(!js.includes(leftover), `تجريد ${name}: بقي أثر TypeScript «${leftover}» في:\n${js}`);
    }
    return js;
}

// كل الدوال النقية في نطاق واحد حتى تحلّ hermesChatPath/hermesRunsPath
// اعتمادها على hermesSettingPath.
const HELPERS = new Function(`${[
    stripFn('hermesBase', [
        ['(agent: Record<string, unknown>): string', '(agent)'],
        ['((agent.endpoint as string) || "")', '((agent.endpoint || ""))'],
    ]),
    stripFn('hermesSettingPath', [
        ['(agent: Record<string, unknown>, key: string, fallback: string): string', '(agent, key, fallback)'],
        ['agent.settings as Record<string, unknown> | null | undefined', 'agent.settings'],
        ['(settings[key] as string)', '(settings[key])'],
    ]),
    stripFn('hermesChatPath', [
        ['(agent: Record<string, unknown>): string', '(agent)'],
    ]),
    stripFn('hermesRunsPath', [
        ['(agent: Record<string, unknown>): string', '(agent)'],
    ]),
    stripFn('hermesPassthroughBody', [
        ['(body: Record<string, any>): Record<string, unknown> | null', '(body)'],
        ['return nested as Record<string, unknown>;', 'return nested;'],
        ['const rest: Record<string, unknown> = { ...body };', 'const rest = { ...body };'],
    ]),
    stripFn('applyHermesModelDefaults', [
        ['(body: Record<string, unknown>): Record<string, unknown>', '(body)'],
        ['const out: Record<string, unknown> = { ...body };', 'const out = { ...body };'],
    ]),
    stripFn('hermesRunId', [
        ['(body: Record<string, any>): string', '(body)'],
    ]),
    stripFn('hermesCollectMs', [
        ['(body: Record<string, any>): number', '(body)'],
    ]),
    stripFn('parseSseDataPayloads', [
        ['(sseText: string)', '(sseText)'],
        [': unknown[]', ''],
    ]),
].join('\n')}; return { hermesBase, hermesSettingPath, hermesChatPath, hermesRunsPath, hermesPassthroughBody, applyHermesModelDefaults, hermesRunId, hermesCollectMs, parseSseDataPayloads };`)();

const { hermesBase, hermesChatPath, hermesRunsPath, hermesPassthroughBody, applyHermesModelDefaults, hermesRunId, hermesCollectMs, parseSseDataPayloads } = HELPERS;

/* ── VALID_ACTIONS ─────────────────────────────────────────────────────── */

test('الإجراءات الخمسة الجديدة في VALID_ACTIONS مع بقاء الأحد عشر القديمة', () => {
    const m = CODE.match(/const VALID_ACTIONS = \[([^\]]*)\]/);
    assert.ok(m, 'VALID_ACTIONS غير موجودة');
    const list = m[1];
    for (const action of ['chat', 'run_create', 'run_get', 'run_events', 'run_stop']) {
        assert.ok(list.includes(`"${action}"`), `إجراء جديد مفقود: ${action}`);
    }
    for (const action of ['list', 'get', 'create', 'update', 'delete', 'start', 'stop', 'restart', 'status', 'logs', 'test_connection']) {
        assert.ok(list.includes(`"${action}"`), `إجراء قديم مفقود: ${action}`);
    }
});

/* ── تعليق الرأس: عقد Hermes والنموذج ─────────────────────────────────── */

test('تعليق الرأس يوثّق عقد Hermes والنموذج الافتراضي والتجاوز', () => {
    assert.match(SRC, /run_create \/ run_get \/ run_events \/ run_stop/);
    assert.match(SRC, /\/v1\/chat\/completions/);
    assert.match(SRC, /\/v1\/runs/);
    assert.match(SRC, /بلا Authorization/);
    assert.match(SRC, /POST \/control/);
    assert.match(SRC, /POST \/logs/);
    // النموذج: التسمية الافتراضية "hermes-agent"، والتجاوز model + provider معًا.
    assert.match(SRC, /"hermes-agent"/);
    assert.match(SRC, /"model" و"provider" معًا/);
    assert.match(SRC, /nvidia\/nemotron-3-ultra-550b-a55b/);
    // مسار معروف بلا عميل بعد — موثَّق فقط، لا كود له.
    assert.match(SRC, /\/api\/sessions\/\{id\}\/chat/);
    assert.doesNotMatch(SRC, /sessions.*chat.*fetch|fetch.*sessions/i);
});

/* ── callAgent: إسقاط المصادقة عن /health في Hermes فقط ───────────────── */

test('callAgent يملك علامة noAuth ويُسقط Authorization عن صحة Hermes فقط', () => {
    assert.match(CODE, /opts\?: \{ noAuth\?: boolean \}/, 'لا علامة noAuth في callAgent');
    assert.match(CODE, /path === "status" && agent\.type === "hermes"/, 'لا استدلال من النوع على نداء الصحة');
    assert.match(CODE, /const omitAuth = opts\?\.noAuth \?\? \(path === "status" && agent\.type === "hermes"\)/);
    assert.match(CODE, /\.\.\.\(apiKey && !omitAuth \? \{ Authorization: `Bearer \$\{apiKey\}` \} : \{\}\)/,
        'رأس Authorization لا يتوقف على omitAuth');
    // والعلامة الصريحة تتقدم على الاستدلال — تمرير noAuth صراحةً ممكن.
    assert.match(CODE, /opts\?\.noAuth \?\?/);
});

test('لا عنوان حيّ ولا مفتاح في المصدر — الاختبارات Mock فقط', () => {
    assert.doesNotMatch(SRC, /p01--hermes-agent/);
    assert.doesNotMatch(SRC, /code\.run/);
    assert.doesNotMatch(SRC, /Bearer [A-Za-z0-9]{10,}/);
});

/* ── المسارات: افتراضيات وتجاوزات (اختبارات وحدة حقيقية) ─────────────── */

test('قاعدة endpoint تُجرَّد من "/" الأخيرة', () => {
    assert.equal(hermesBase({ endpoint: 'https://p01--hermes-agent--x.code.run/' }), 'https://p01--hermes-agent--x.code.run');
    assert.equal(hermesBase({ endpoint: 'https://h.example///' }), 'https://h.example');
    assert.equal(hermesBase({ endpoint: 'https://h.example' }), 'https://h.example');
    assert.equal(hermesBase({}), '');
    assert.equal(hermesBase({ endpoint: '' }), '');
});

test('مسارا المحادثة والتشغيل: الافتراضيان /v1/chat/completions و /v1/runs', () => {
    assert.equal(hermesChatPath({ endpoint: 'https://h.example' }), '/v1/chat/completions');
    assert.equal(hermesRunsPath({ endpoint: 'https://h.example' }), '/v1/runs');
    assert.equal(hermesChatPath({}), '/v1/chat/completions');
    assert.equal(hermesRunsPath({ settings: null }), '/v1/runs');
});

test('تجاوز المسارات من settings، و"/" تُضاف لو غابت، والفارغ يعود للافتراضي', () => {
    const agent = { settings: { chat_completions_path: '/custom/chat', runs_path: 'custom/runs' } };
    assert.equal(hermesChatPath(agent), '/custom/chat');
    assert.equal(hermesRunsPath(agent), '/custom/runs');
    assert.equal(hermesChatPath({ settings: { chat_completions_path: '  ' } }), '/v1/chat/completions');
    assert.equal(hermesRunsPath({ settings: { runs_path: '' } }), '/v1/runs');
    assert.equal(hermesChatPath({ settings: { chat_completions_path: 42 } }), '/v1/chat/completions');
});

/* ── تمرير الجسم: بلا أي تعديل (اختبارات وحدة حقيقية) ────────────────── */

test('جسم المحادثة الافتراضي يستخدم الزوج العامل nvidia (model + provider معًا)', () => {
    assert.equal(DEFAULT_CHAT_BODY.model, 'nvidia/nemotron-3-ultra-550b-a55b');
    assert.equal(DEFAULT_CHAT_BODY.provider, 'nvidia');
    assert.equal(DEFAULT_CHAT_BODY.stream, false);
});

test('الشكل المُدمج {id, body} يُمرَّر كما هو — نفس المرجع بلا نسخ ولا تعديل', () => {
    const nested = { ...OVERRIDE_CHAT_BODY };
    const out = hermesPassthroughBody({ action: 'chat', id: 'agent-1', body: nested });
    assert.equal(out, nested, 'الجسم المُدمج يجب أن يُمرَّر نفسه لا نسخة منه');
    assert.deepEqual(out, OVERRIDE_CHAT_BODY);
});

test('الشكل المنشور {id, ...fields} يمرَّر كما هو بعد حذف غلاف action/id فقط', () => {
    const out = hermesPassthroughBody({ action: 'chat', id: 'agent-1', ...OVERRIDE_CHAT_BODY });
    assert.deepEqual(out, OVERRIDE_CHAT_BODY);
    assert.ok(!('action' in out) && !('id' in out), 'الغلاف تسرّب إلى الجسم المُمرَّر');
});

test('جسم فيه model + provider + model_options + stream يمرّ untouched بالشكلين', () => {
    for (const req of [
        { action: 'chat', id: 'agent-1', body: OVERRIDE_CHAT_BODY },
        { action: 'run_create', id: 'agent-1', ...OVERRIDE_CHAT_BODY },
    ]) {
        const out = hermesPassthroughBody(req);
        assert.equal(out.model, 'nvidia/nemotron-3-ultra-550b-a55b');
        assert.equal(out.provider, 'nvidia');
        assert.deepEqual(out.model_options, { reasoning_effort: 'high', service_tier: 'flex' });
        assert.equal(out.stream, true);
        assert.deepEqual(out.messages, [{ role: 'user', content: 'مرحبًا' }]);
    }
});

test('الافتراضيات فقط عبر applyHermesModelDefaults — لا كتابة مباشرة ولا مساس بـ model_options/stream', () => {
    // لا كتابة مباشرة لحقول الجسم ولا حذف لها في معالجي chat/run_create.
    for (const field of ['model', 'provider', 'model_options', 'stream']) {
        // `=(?!=)` حتى لا يلتقط `===` في قراءة مثل chatBody.stream === true.
        assert.doesNotMatch(CODE, new RegExp(`(chatBody|runBody)\\.${field}\\s*=(?!=)`), `الكود يعيد كتابة ${field} مباشرة`);
        assert.doesNotMatch(CODE, new RegExp(`delete (chatBody|runBody)\\.${field}`), `الكود يحذف ${field}`);
    }
    // الافتراضيات تُطبَّق على الجسم المُمرَّر في مساري الإنشاء فقط — وبعد
    // فحص الجسم الفارغ في chat، وقبل أي نشر للخادم.
    assert.match(CODE, /chatBody = applyHermesModelDefaults\(chatBody\)/);
    assert.match(CODE, /runBody = applyHermesModelDefaults\(runBody\)/);
    assert.equal((CODE.match(/= applyHermesModelDefaults\(/g) || []).length, 2,
        'الافتراضيات تُطبَّق في مساري الإنشاء فقط (chat و run_create) — لا run_get/run_events/run_stop');
    // المساعد نفسه لا يمسّ إلا model وprovider.
    const helperMatch = SRC.match(/export function applyHermesModelDefaults\([\s\S]*?\n\}/);
    assert.ok(helperMatch, 'الدالة applyHermesModelDefaults غير موجودة في index.ts');
    for (const field of ['model_options', 'stream', 'messages']) {
        assert.ok(!helperMatch[0].includes(field), `المساعد يمسّ ${field}`);
    }
    assert.match(helperMatch[0], /"hermes-agent"/, 'المساعد لا يعالج تسمية hermes-agent');
    assert.match(helperMatch[0], /nvidia\/nemotron-3-ultra-550b-a55b/);
    // ولا حقن للتسمية كقيمة نموذج في أي مكان — "hermes-agent" ليست قيمة عاملة.
    assert.doesNotMatch(CODE, /model:\s*"hermes-agent"/);
    assert.doesNotMatch(CODE, /out\.model = "hermes-agent"/);
    // والمحادثة والتشغيل يمرّران الجسم المُعدَّل مباشرةً لنداء Hermes.
    assert.match(CODE, /hermesFetchJson\(agent, url, "POST", chatBody\)/);
    assert.match(CODE, /hermesFetchSse\(agent, url, timeoutMs, "POST", chatBody\)/);
    assert.match(CODE, /hermesFetchJson\(agent, `\$\{base\}\$\{hermesRunsPath\(agent\)\}`, "POST", runBody\)/);
});

/* ── افتراضيات model/provider (اختبارات وحدة حقيقية) ─────────────────── */

test('لا model ولا provider → الزوج الافتراضي العامل كاملًا', () => {
    const out = applyHermesModelDefaults({ messages: [{ role: 'user', content: 'مرحبًا' }] });
    assert.equal(out.model, 'nvidia/nemotron-3-ultra-550b-a55b');
    assert.equal(out.provider, 'nvidia');
    assert.deepEqual(out.messages, [{ role: 'user', content: 'مرحبًا' }]);
});

test('model وحده (نموذج حقيقي) → provider يُكمَّل بـ "nvidia"', () => {
    const out = applyHermesModelDefaults({ model: 'nvidia/nemotron-3-ultra-550b-a55b', messages: [] });
    assert.equal(out.model, 'nvidia/nemotron-3-ultra-550b-a55b');
    assert.equal(out.provider, 'nvidia');
});

test('provider وحده → model يُكمَّل بالنموذج الافتراضي', () => {
    const out = applyHermesModelDefaults({ provider: 'nvidia', messages: [] });
    assert.equal(out.model, 'nvidia/nemotron-3-ultra-550b-a55b');
    assert.equal(out.provider, 'nvidia');
});

test('model + provider معًا → يُمرَّران بلا أي مساس (تجاوز كامل)', () => {
    const body = { model: 'other/model-x', provider: 'other', messages: [] };
    assert.deepEqual(applyHermesModelDefaults(body), body);
});

test('model "hermes-agent" وحده → يُستبدل بالزوج الافتراضي ولا يُرسَل أبدًا', () => {
    const out = applyHermesModelDefaults({ model: 'hermes-agent', messages: [] });
    assert.equal(out.model, 'nvidia/nemotron-3-ultra-550b-a55b');
    assert.equal(out.provider, 'nvidia');
});

test('"hermes-agent" مع provider مُرسَل → النموذج يُستبدل والـ provider يبقى', () => {
    const out = applyHermesModelDefaults({ model: 'hermes-agent', provider: 'nvidia', messages: [] });
    assert.equal(out.model, 'nvidia/nemotron-3-ultra-550b-a55b');
    assert.equal(out.provider, 'nvidia');
});

test('القيم الفارغة تُعامَل كمفقودة، وباقي الحقول بلا مساس، والدخل لا يُعدَّل', () => {
    const body = {
        model: '',
        provider: '   ',
        model_options: { reasoning_effort: 'high', service_tier: 'flex' },
        stream: true,
        messages: [{ role: 'user', content: 'مرحبًا' }],
    };
    const out = applyHermesModelDefaults(body);
    assert.equal(out.model, 'nvidia/nemotron-3-ultra-550b-a55b');
    assert.equal(out.provider, 'nvidia');
    assert.deepEqual(out.model_options, { reasoning_effort: 'high', service_tier: 'flex' });
    assert.equal(out.stream, true);
    assert.deepEqual(out.messages, [{ role: 'user', content: 'مرحبًا' }]);
    // الدخل نفسه لم يُمسّ — المساعد يعيد نسخة جديدة.
    assert.equal(body.model, '');
    assert.equal(body.provider, '   ');
    assert.notEqual(out, body);
});

/* ── run_id و collect_ms (اختبارات وحدة حقيقية) ───────────────────────── */

test('معرّف التشغيل يقبل run_id وrunId ويُقلَّم', () => {
    assert.equal(hermesRunId({ run_id: 'run-1' }), 'run-1');
    assert.equal(hermesRunId({ runId: 'run-2' }), 'run-2');
    assert.equal(hermesRunId({ run_id: 'run-1', runId: 'run-2' }), 'run-1');
    assert.equal(hermesRunId({ runId: '  run-3  ' }), 'run-3');
    assert.equal(hermesRunId({}), '');
});

test('مهلة جمع الأحداث: افتراضي 5000، وتقبل collect_ms وcollectMs، والباطل يعود للافتراضي', () => {
    assert.equal(hermesCollectMs({}), 5000);
    assert.equal(hermesCollectMs({ collect_ms: 2000 }), 2000);
    assert.equal(hermesCollectMs({ collectMs: 3000 }), 3000);
    assert.equal(hermesCollectMs({ collect_ms: 0 }), 5000);
    assert.equal(hermesCollectMs({ collect_ms: -1 }), 5000);
    assert.equal(hermesCollectMs({ collect_ms: Number.NaN }), 5000);
    assert.equal(hermesCollectMs({ collect_ms: '2000' }), 5000);
});

/* ── دورة حياة Hermes: بلا /control ───────────────────────────────────── */

test('بدء/إعادة تشغيل Hermes فحص /health فقط — بلا أي نداء /control', () => {
    const start = CODE.indexOf('if (action === "start" || action === "stop" || action === "restart") {');
    const generic = CODE.indexOf('await adminClient.from("ai_agents").update({ status: action === "stop" ? "stopping"');
    assert.ok(start !== -1 && generic !== -1 && start < generic, 'كتلة دورة حياة Hermes غير موجودة قبل المسار العام');
    const block = CODE.slice(start, generic);
    assert.match(block, /agent\.type === "hermes"/, 'الكتلة غير مقيّدة بنوع hermes');
    assert.match(block, /callAgent\(agent, "status"\)/, 'البدء لا يفحص /health');
    assert.match(block, /status: "running"/, 'النجاح لا يضبط running');
    assert.match(block, /last_heartbeat: new Date\(\)\.toISOString\(\)/, 'النجاح لا يحدّث last_heartbeat');
    assert.match(block, /last_error: null/, 'النجاح لا يمسح last_error');
    assert.match(block, /status: "error"/, 'الفشل لا يضبط error');
    assert.doesNotMatch(block, /"control"/, 'كتلة Hermes تستدعي /control');
    assert.doesNotMatch(block, /fetch\(/, 'كتلة Hermes فيها fetch مباشر');
});

test('إيقاف Hermes تحديث قاعدة بيانات فقط إلى stopped — بلا HTTP', () => {
    const start = CODE.indexOf('if (action === "start" || action === "stop" || action === "restart") {');
    const generic = CODE.indexOf('await adminClient.from("ai_agents").update({ status: action === "stop" ? "stopping"');
    const block = CODE.slice(start, generic);
    const stopAt = block.indexOf('if (action === "stop") {');
    assert.ok(stopAt !== -1, 'لا فرع إيقاف داخل كتلة Hermes');
    const stopBranch = block.slice(stopAt, block.indexOf('await adminClient.from("ai_agents").update({ status: action === "restart"'));
    assert.match(stopBranch, /update\(\{ status: "stopped"/, 'الإيقاف لا يحدّث الحالة إلى stopped');
    assert.match(stopBranch, /return jsonResponse\(\{ ok: true, data: \{ status: "stopped" \} \}\)/, 'الإيقاف لا يرجع فورًا بعد التحديث');
    assert.doesNotMatch(stopBranch, /callAgent\(/, 'الإيقاف ينادي الوكيل');
});

/* ── سجلات Hermes: غير مدعومة ─────────────────────────────────────────── */

test('سجلات Hermes تُرجع unsupported قبل أي نداء /logs', () => {
    const start = CODE.indexOf('if (action === "logs") {');
    const end = CODE.indexOf('if (action === "chat" || action === "run_create"');
    assert.ok(start !== -1 && end !== -1 && start < end, 'كتلة logs غير موجودة');
    const block = CODE.slice(start, end);
    assert.match(block, /agent\.type === "hermes"/);
    assert.match(block, /unsupported: true/);
    assert.match(block, /logs: \[\]/);
    assert.match(block, /Hermes لا يوفّر مسار \/logs — السجلات غير متاحة من مدعوم/);
    const hermesAt = block.indexOf('agent.type === "hermes"');
    const callAt = block.indexOf('callAgent(agent, "logs"');
    assert.ok(hermesAt !== -1 && callAt !== -1 && hermesAt < callAt, 'فحص Hermes يأتي بعد نداء /logs');
});

/* ── chat و run_*: المسارات والاستجابات ──────────────────────────────── */

test('chat تنشر على مسار المحادثة، والمتدفقة تعيد raw مع streamed:true', () => {
    const start = CODE.indexOf('if (action === "chat" || action === "run_create"');
    const end = CODE.indexOf('if (action === "start" || action === "stop" || action === "restart") {');
    const block = CODE.slice(start, end);
    assert.match(block, /const url = `\$\{base\}\$\{hermesChatPath\(agent\)\}`/);
    assert.match(block, /if \(chatBody\.stream === true\)/);
    assert.match(block, /return jsonResponse\(\{ ok: true, data: \{ streamed: true, raw: streamed\.raw \} \}\)/);
    assert.match(block, /if \(!chatBody \|\| Object\.keys\(chatBody\)\.length === 0\)/);
});

test('run_create تنشر على مسار التشغيل، وrun_get/run_stop يبنيان المسار بـ run_id', () => {
    const start = CODE.indexOf('if (action === "chat" || action === "run_create"');
    const end = CODE.indexOf('if (action === "start" || action === "stop" || action === "restart") {');
    const block = CODE.slice(start, end);
    assert.match(block, /hermesRunsPath\(agent\)\}`, "POST", runBody\)/);
    assert.match(block, /`\$\{base\}\$\{hermesRunsPath\(agent\)\}\/\$\{encodeURIComponent\(runId\)\}`, "GET"\)/);
    assert.match(block, /`\$\{base\}\$\{hermesRunsPath\(agent\)\}\/\$\{encodeURIComponent\(runId\)\}\/stop`, "POST", \{\}\)/);
    assert.match(block, /if \(!runId\) return jsonResponse\(\{ error: "run_id مطلوب" \}, 400\)/);
});

test('run_events تجمع SSE لمدة collect_ms ثم تعيد النص الخام والحمولات', () => {
    const start = CODE.indexOf('if (action === "chat" || action === "run_create"');
    const end = CODE.indexOf('if (action === "start" || action === "stop" || action === "restart") {');
    const block = CODE.slice(start, end);
    assert.match(block, /\/events`,\s*hermesCollectMs\(body\),\s*"GET"/);
    assert.match(block, /return jsonResponse\(\{ ok: true, data: \{ events_text: streamed\.raw, events: parseSseDataPayloads\(streamed\.raw\) \} \}\)/);
});

test('قراءة SSE: قارئ دفق + إجهاض بمؤقت + قصّ collect_ms عند timeout_ms', () => {
    assert.match(CODE, /getReader\(\)/);
    assert.match(CODE, /name === "AbortError"/, 'الإجهاض أثناء القراءة لا يُميَّز عن الخطأ');
    assert.match(CODE, /const timer = setTimeout\(\(\) => controller\.abort\(\), cappedMs\)/);
    assert.match(CODE, /Math\.max\(0, Math\.min\(Number\.isFinite\(collectMs\) \? collectMs : timeoutMs, timeoutMs\)\)/,
        'لا قصّ لـ collect_ms عند timeout_ms');
    assert.match(CODE, /Accept: "text\/event-stream"/);
    // خطأ غير-2xx موحّد مع data في callAgent الأصلية ومساعدي Hermes.
    assert.equal((CODE.match(/الوكيل رد بخطأ \(\$\{res\.status\}\)/g) || []).length, 3,
        'توقعنا رسالة الخطأ الموحدة في callAgent و hermesFetchJson و hermesFetchSse');
});

/* ── parseSseDataPayloads: اختبارات وحدة حقيقية ───────────────────────── */

test('SSE: فارغ أو بلا data يعطي []', () => {
    assert.deepEqual(parseSseDataPayloads(''), []);
    assert.deepEqual(parseSseDataPayloads('\n\n'), []);
    assert.deepEqual(parseSseDataPayloads('event: ping\n: keep-alive\n\n'), []);
});

test('SSE: أسطر data JSON تُفسَّر بالترتيب، و[DONE] والأسطر غير-data تُتخطّى', () => {
    const sse = [
        'event: message',
        'data: {"type":"start","run_id":"run-1"}',
        '',
        'data:{"type":"delta","text":"مرحبًا"}',
        'data: [DONE]',
        ': comment',
        'data: {"type":"end"}',
        '',
    ].join('\n');
    assert.deepEqual(parseSseDataPayloads(sse), [
        { type: 'start', run_id: 'run-1' },
        { type: 'delta', text: 'مرحبًا' },
        { type: 'end' },
    ]);
});

test('SSE: دفق محادثة OpenAI — دلتا المحتوى تُفسَّر وتُحفظ بالترتيب', () => {
    const sse = [
        'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"مرح"}}]}',
        'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"بًا"}}]}',
        'data: [DONE]',
        '',
    ].join('\n');
    assert.deepEqual(parseSseDataPayloads(sse), [
        { id: 'chatcmpl-1', choices: [{ delta: { content: 'مرح' } }] },
        { id: 'chatcmpl-1', choices: [{ delta: { content: 'بًا' } }] },
    ]);
});

test('SSE: حمولة ليست JSON تبقى نصًا خامًا بدل أن تُسقَط أو تُفشل', () => {
    assert.deepEqual(parseSseDataPayloads('data: plain-heartbeat\n\ndata: {"ok":true}\n'), ['plain-heartbeat', { ok: true }]);
});

test('SSE: نهايات أسطر CRLF ومسافات بعد "data:" لا تكسر التفسير', () => {
    assert.deepEqual(parseSseDataPayloads('data:{"a":1}\r\ndata:   {"b":2}  \r\n'), [{ a: 1 }, { b: 2 }]);
});

/* ── سلوك غير-Hermes محفوظ حرفيًا ─────────────────────────────────────── */

test('المسار العام (غير Hermes) ما زال POST /control و POST /logs كما كان', () => {
    assert.match(CODE, /callAgent\(agent, "control", \{ command: action \}\)/);
    assert.match(CODE, /callAgent\(agent, "logs", \{ limit: body\.limit \?\? 200, level: body\.level, search: body\.search \}\)/);
    // فروع Hermes الثلاثة مقيّدة بالنوع — لا تسريب لمسار عام.
    assert.ok((CODE.match(/agent\.type === "hermes"/g) || []).length >= 3,
        'توقعنا 3 فحوص نوع hermes على الأقل (callAgent وlogs ودورة الحياة)');
});

test('بوابة الأدمن والتشفير والقناع وCORS لم تُمسّ', () => {
    assert.match(CODE, /rpc\("is_admin"\)/);
    assert.match(CODE, /AI_AGENTS_ENC_KEY/);
    assert.match(CODE, /SECRET_MASK/);
    assert.match(CODE, /"Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"/);
    assert.match(CODE, /if \(req\.method === "OPTIONS"\) return new Response\("ok", \{ headers: CORS_HEADERS \}\)/);
});
