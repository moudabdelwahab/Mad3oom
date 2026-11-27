/**
 * اختبارات إجراء `metrics` في agent-manager
 * (supabase/functions/agent-manager/index.ts) + ترحيل 148.
 *
 * نفس نمط agent-manager-hermes.test.mjs: الدالة Edge تحتاج Deno وSupabase
 * حيًّا فلا تُشغَّل هنا، فالعقد يُثبَت من المصدر نفسه — فحصان ساكنان على
 * المصدر (الإجراء، المسارات، العزل، التوكن لا يظهر في أي استجابة) +
 * اختبارات وحدة حقيقية للدوال النقية المستخرَجة من المصدر نفسه
 * (normalizeHermesMetrics وnormalizeNorthflankMetrics ومساعداتهما):
 * تُستخرج الدوال من index.ts وتُنفَّذ بعد تجريد تعليقات TypeScript
 * البسيطة فيها. أي تغيير في توقيع دالة يُفشل التجريد بصوت عالٍ بدل
 * اختبار نسخة قديمة بصمت.
 *
 * بلا أي نداء حيّ: لا مفاتيح ولا توكنات — كل مدخلات Hermes/Northflank
 * هنا fixtures تمثّل ما يعيده الـ fetch، لا fetch حقيقي.
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

/* ── أجسام اختبار: ما يعيده fetch من Hermes وNorthflank ─────────────── */

const HEALTH_FULL = {
    status: 'ok',
    version: '0.23.4',
    gateway_state: 'running',
    active_agents: 2,
    api_server: { active_runs: 3, stored_runs: 12 },
    metrics_today: { requests: 120, messages: 340, tokens: 5600, latency_p95_ms: 850 },
};

const JOBS_ARRAY = [{ id: 'job-1' }, { id: 'job-2' }];
// جلسات: واحدة بلا tool_call_count، وواحدة بلا message_count، وواحدة فارغة.
const SESSIONS_ARRAY = [
    { message_count: 10, tool_call_count: 2 },
    { message_count: 5 },
    { tool_call_count: 3 },
    {},
];

const NF_SERIES = (value) => ({ metricUnit: 'pct', values: [{ data: [{ value }] }] });
const NF_METRICS_OBJ = { cpu: NF_SERIES(50), memory: NF_SERIES(50) };
// حاويتان: TASK_KILLED أقدم، وTASK_RUNNING أحدث — مدة التشغيل من الجارية فقط.
const NF_CONTAINERS = [
    { state: 'TASK_KILLED', createdAt: '2026-11-27T00:00:00.000Z' },
    { state: 'TASK_RUNNING', createdAt: '2026-11-27T02:00:00.000Z' },
];
const NF_NOW = Math.floor(new Date('2026-11-27T03:00:00.000Z').getTime() / 1000); // بعد الجارية بساعة
const NF_SERVICE = { name: 'hermes-agent', status: 'running' };

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

// حدّا Northflank يُقرآن من المصدر نفسه ويُحقنان في نطاق الاختبار —
// فاختبار الرياضيات يتحقق من المعادلة، والفحص الساكن يتحقق من القيمتين.
const MEM_LIMIT = Number((SRC.match(/const NORTHFLANK_MEMORY_LIMIT_MB = (\d+(?:\.\d+)?)/) || [])[1]);
const CPU_LIMIT = Number((SRC.match(/const NORTHFLANK_CPU_LIMIT_VCPU = ([0-9.]+)/) || [])[1]);
assert.ok(Number.isFinite(MEM_LIMIT) && MEM_LIMIT > 0, 'ثابت حد الذاكرة غير موجود في المصدر');
assert.ok(Number.isFinite(CPU_LIMIT) && CPU_LIMIT > 0, 'ثابت حد المعالج غير موجود في المصدر');

const HELPERS = new Function(`const NORTHFLANK_MEMORY_LIMIT_MB = ${MEM_LIMIT}; const NORTHFLANK_CPU_LIMIT_VCPU = ${CPU_LIMIT}; ${[
    stripFn('plainObj', [
        ['(v: unknown): Record<string, unknown>', '(v)'],
        ['(v as Record<string, unknown>)', 'v'],
    ]),
    stripFn('hermesListItems', [
        ['(data: unknown): unknown[]', '(data)'],
    ]),
    stripFn('hermesSessionTotals', [
        ['(sessions: unknown): { count: number; messages: number; tool_calls: number }', '(sessions)'],
    ]),
    stripFn('normalizeHermesMetrics', [
        ['(health: unknown, jobs: unknown, sessions: unknown): Record<string, unknown>', '(health, jobs, sessions)'],
        ['const num = (v: unknown, fallback: number | null): number | null =>', 'const num = (v, fallback) =>'],
    ]),
    stripFn('northflankDerivedMetrics', [
        ['(cpuPct: unknown, memPct: unknown): Record<string, unknown>', '(cpuPct, memPct)'],
        ['const num = (v: unknown): number | null =>', 'const num = (v) =>'],
    ]),
    stripFn('northflankMetricValue', [
        ['(series: unknown): number | null', '(series)'],
    ]),
    stripFn('northflankMetricsValues', [
        ['(payload: unknown): { cpu: number | null; memory: number | null }', '(payload)'],
        ['const out: { cpu: number | null; memory: number | null } = { cpu: null, memory: null };', 'const out = { cpu: null, memory: null };'],
    ]),
    stripFn('northflankUptimeSeconds', [
        ['(containers: unknown, nowSeconds: number): number | null', '(containers, nowSeconds)'],
        ['let oldest: number | null = null;', 'let oldest = null;'],
    ]),
    stripFn('northflankServiceStatus', [
        ['(service: unknown): Record<string, unknown>', '(service)'],
    ]),
    stripFn('normalizeNorthflankMetrics', [
        ['(metrics: unknown, containers: unknown, service: unknown, nowSeconds: number): Record<string, unknown>', '(metrics, containers, service, nowSeconds)'],
    ]),
    stripFn('northflankPlaceholder', [
        ['(): Record<string, unknown>', '()'],
    ]),
    stripFn('northflankError', [
        ['(): Record<string, unknown>', '()'],
    ]),
    stripFn('unavailableMetricsPayload', [
        ['(reason: string): Record<string, unknown>', '(reason)'],
    ]),
].join('\n')}; return { plainObj, hermesListItems, hermesSessionTotals, normalizeHermesMetrics, northflankDerivedMetrics, northflankMetricValue, northflankMetricsValues, northflankUptimeSeconds, northflankServiceStatus, normalizeNorthflankMetrics, northflankPlaceholder, northflankError, unavailableMetricsPayload };`)();

const {
    hermesListItems, hermesSessionTotals, normalizeHermesMetrics,
    northflankDerivedMetrics, northflankMetricValue, northflankMetricsValues,
    northflankUptimeSeconds, northflankServiceStatus, normalizeNorthflankMetrics,
    northflankPlaceholder, northflankError, unavailableMetricsPayload,
} = HELPERS;

// كتلة إجراء metrics وحدها (من `if (action === "metrics")` إلى كتلة chat).
function metricsBlock() {
    const start = CODE.indexOf('if (action === "metrics") {');
    const end = CODE.indexOf('if (action === "chat" || action === "run_create"');
    assert.ok(start !== -1 && end !== -1 && start < end, 'كتلة إجراء metrics غير موجودة');
    return CODE.slice(start, end);
}

/* ── VALID_ACTIONS والتسجيل ───────────────────────────────────────────── */

test('إجراء metrics في VALID_ACTIONS مع بقاء الإجراءات القديمة', () => {
    const m = CODE.match(/const VALID_ACTIONS = \[([^\]]*)\]/);
    assert.ok(m, 'VALID_ACTIONS غير موجودة');
    assert.ok(m[1].includes('"metrics"'), 'إجراء metrics مفقود من VALID_ACTIONS');
    for (const action of ['list', 'get', 'create', 'update', 'delete', 'start', 'stop', 'restart', 'status', 'logs', 'test_connection', 'chat', 'run_create', 'run_get', 'run_events', 'run_stop']) {
        assert.ok(m[1].includes(`"${action}"`), `إجراء قديم مفقود: ${action}`);
    }
});

/* ── أسلاك الإجراء: المسارات والتوازي والعزل ─────────────────────────── */

test('إجراء metrics ينادي مسارات Hermes الثلاثة بالتوازي مع allSettled', () => {
    const block = metricsBlock();
    assert.match(block, /Promise\.allSettled\(/);
    // المسارات الثلاثة في مصفوفة واحدة تُنادى بالتوازي عبر map.
    assert.match(block, /const hermesPaths = \["\/health\/detailed", "\/api\/jobs", "\/api\/sessions"\];/);
    assert.match(block, /hermesPaths\.map\(\(p\) => safeCall\(\(\) => hermesFetchJson\(agent, `\$\{base\}\$\{p\}`, "GET"\)\)\)/);
    // كل نداء عبر مساعد آمن بذاته (try/catch داخلي) لا fetch مباشر.
    assert.match(block, /safeCall\(/);
    assert.doesNotMatch(block, /await fetch\(/);
});

test('إجراء metrics ينادي Northflank الثلاثة: metrics (cpu+memory فقط) وcontainers والخدمة', () => {
    const block = metricsBlock();
    assert.match(block, /northflankBase\(agent\)/);
    assert.match(block, /`\$\{nfBase\}\/metrics\?queryType=single&metricTypes=cpu&metricTypes=memory`/);
    assert.match(block, /`\$\{nfBase\}\/containers`/);
    // لا metricTypes غير cpu وmemory في نداء /metrics.
    const metricsUrl = block.match(/\/metrics\?[^`]*`/)[0];
    assert.ok(!/metricTypes=(?!cpu|memory)/.test(metricsUrl), `نداء /metrics يسأل عن نوع غير cpu/memory: ${metricsUrl}`);
    // Northflank تُنادى فقط لو توكن مخزَّن.
    assert.match(block, /if \(nfToken\)/);
});

test('فشل Northflank معزول: بلوك error وبيانات Hermes تبقى في نفس الاستجابة', () => {
    const block = metricsBlock();
    assert.match(block, /northflankError\(\)/);
    assert.match(block, /return jsonResponse\(\{ ok: true, agent_id: id, hermes, northflank \}\)/);
    // والفشل الكلي للمصدرين معًا يرجع fetch_failed لا رميًا — مبني صراحةً
    // (لا عبر unavailableMetricsPayload) حتى يحمل بلوك northflank الفعلي
    // (placeholder بلا توكن، أو error عند فشل قراءته).
    assert.match(block, /reason: "fetch_failed", hermes: null, northflank/);
    // فشل Hermes وحده لا يمسّ Northflank: التطبيع يجري على ما عاد من كل مصدر.
    assert.match(block, /normalizeHermesMetrics\(settledData\(healthRes\), settledData\(jobsRes\), settledData\(sessionsRes\)\)/);
});

test('أسباب عدم التوفر: not_hermes لغير Hermes بلا endpoint، وno_key بلا مفتاح', () => {
    const block = metricsBlock();
    assert.match(block, /unavailableMetricsPayload\("not_hermes"\)/);
    assert.match(block, /unavailableMetricsPayload\("no_key"\)/);
    assert.match(block, /agent\.type !== "hermes" && !base/);
    assert.match(block, /if \(!apiKey\) return jsonResponse\(unavailableMetricsPayload\("no_key"\)\)/);
});

/* ── Northflank: القاعدة والمصادقة والحدود ───────────────────────────── */

test('قاعدة Northflank من slug الوكيل (افتراض موثَّق) وBearer على كل نداء', () => {
    assert.match(SRC, /https:\/\/api\.northflank\.com\/v1\/projects\/default\/services\/\$\{encodeURIComponent\(slug\)\}/);
    assert.match(SRC, /slug الوكيل هو اسم الخدمة على Northflank/);
    assert.match(SRC, /Authorization: `Bearer \$\{token\}`/);
    // لا توكن افتراضي ولا قراءة من متغير بيئة — التوكن من عمود القاعدة فقط.
    assert.doesNotMatch(SRC, /NORTHFLANK_TOKEN/);
    assert.doesNotMatch(SRC, /Deno\.env\.get\("NORTHFLANK/);
    assert.doesNotMatch(SRC, /northflank_token\s*=\s*["'`]/);
});

test('حدّا خدمة Hermes: 512MB و0.2 vCPU في ثابتين مسمّيين مع تعليق', () => {
    assert.equal(MEM_LIMIT, 512, 'حد الذاكرة ليس 512MB');
    assert.equal(CPU_LIMIT, 0.2, 'حد المعالج ليس 0.2 vCPU');
    assert.match(SRC, /NORTHFLANK_MEMORY_LIMIT_MB = 512/);
    assert.match(SRC, /NORTHFLANK_CPU_LIMIT_VCPU = 0\.2/);
    assert.match(SRC, /512MB ذاكرة و0\.2 vCPU/);
});

/* ── التوكن لا يظهر في أي استجابة ─────────────────────────────────────── */

test('التوكن المشفَّر خارج PUBLIC_COLUMNS، وlast4 وحده مسموح', () => {
    const m = SRC.match(/const PUBLIC_COLUMNS = `([\s\S]*?)`;/);
    assert.ok(m, 'PUBLIC_COLUMNS غير موجودة');
    assert.ok(m[1].includes('northflank_token_last4'), 'last4 التوكن ليس في PUBLIC_COLUMNS');
    assert.ok(!m[1].includes('northflank_token_encrypted'), 'التوكن المشفَّر تسرّب إلى PUBLIC_COLUMNS');
});

test('كتلة metrics لا تذكر التوكن إطلاقًا — لا مشفَّرًا ولا صريحًا', () => {
    const block = metricsBlock();
    assert.doesNotMatch(block, /northflank_token/);
    assert.doesNotMatch(block, /decryptText/);
    // الاستجابة الناجحة تحمل الحقول الأربعة فقط، بلا أي سر.
    assert.match(block, /return jsonResponse\(\{ ok: true, agent_id: id, hermes, northflank \}\)/);
});

test('إنشاء/تعديل الوكيل يشفّران northflank_token مثل api_key تمامًا', () => {
    assert.match(CODE, /if \(body\.northflank_token\) \{\s*insertRow\.northflank_token_encrypted = await encryptText\(body\.northflank_token\);/);
    assert.match(CODE, /insertRow\.northflank_token_last4 = String\(body\.northflank_token\)\.slice\(-4\);/);
    assert.match(CODE, /if \(body\.northflank_token\) \{\s*updateRow\.northflank_token_encrypted = await encryptText\(body\.northflank_token\);/);
    assert.match(CODE, /updateRow\.northflank_token_last4 = String\(body\.northflank_token\)\.slice\(-4\);/);
});

/* ── القوائم والمجاميع: أشكال Hermes ─────────────────────────────────── */

test('hermesListItems: مصفوفة مباشرة أو غلاف {items|jobs|sessions|data}، وغيره []', () => {
    assert.deepEqual(hermesListItems([{ a: 1 }]), [{ a: 1 }]);
    assert.deepEqual(hermesListItems({ items: [1, 2] }), [1, 2]);
    assert.deepEqual(hermesListItems({ jobs: [1] }), [1]);
    assert.deepEqual(hermesListItems({ sessions: [1] }), [1]);
    assert.deepEqual(hermesListItems({ containers: [1] }), [1]);
    assert.deepEqual(hermesListItems({ data: [1] }), [1]);
    assert.deepEqual(hermesListItems(null), []);
    assert.deepEqual(hermesListItems(undefined), []);
    assert.deepEqual(hermesListItems({}), []);
    assert.deepEqual(hermesListItems('nope'), []);
    assert.deepEqual(hermesListItems({ items: 'not-an-array' }), []);
});

test('hermesSessionTotals: العدد + مجموع message_count/tool_call_count مع ?? 0', () => {
    assert.deepEqual(hermesSessionTotals(SESSIONS_ARRAY), { count: 4, messages: 15, tool_calls: 5 });
    assert.deepEqual(hermesSessionTotals({ sessions: SESSIONS_ARRAY }), { count: 4, messages: 15, tool_calls: 5 });
    assert.deepEqual(hermesSessionTotals([]), { count: 0, messages: 0, tool_calls: 0 });
    assert.deepEqual(hermesSessionTotals(null), { count: 0, messages: 0, tool_calls: 0 });
});

/* ── تطبيع Hermes: المسار السعيد والفشل الجزئي ───────────────────────── */

test('المسار السعيد: كل حقول health/jobs/sessions تُطبَّع كما في العقد', () => {
    assert.deepEqual(normalizeHermesMetrics(HEALTH_FULL, JOBS_ARRAY, SESSIONS_ARRAY), {
        available: true,
        status: 'ok',
        version: '0.23.4',
        gateway_state: 'running',
        active_agents: 2,
        active_runs: 3,
        stored_runs: 12,
        jobs_count: 2,
        sessions_count: 4,
        sessions_messages: 15,
        sessions_tool_calls: 5,
        requests_today: 120,
        messages_today: 340,
        tokens_today: 5600,
        latency_p95_ms: 850,
    });
});

test('فشل /health/detailed وحده: available=false والوظائف والجلسات ما زالت تُعرض', () => {
    const out = normalizeHermesMetrics(null, JOBS_ARRAY, SESSIONS_ARRAY);
    assert.equal(out.available, false);
    assert.equal(out.status, null);
    assert.equal(out.jobs_count, 2);
    assert.equal(out.sessions_count, 4);
    assert.equal(out.sessions_messages, 15);
});

test('فشل /api/jobs وحدها: jobs_count=0 وباقي الحقول سليمة', () => {
    const out = normalizeHermesMetrics(HEALTH_FULL, null, SESSIONS_ARRAY);
    assert.equal(out.available, true);
    assert.equal(out.jobs_count, 0);
    assert.equal(out.sessions_count, 4);
    assert.equal(out.active_runs, 3);
});

test('فشل /api/sessions وحدها: عدّادات الجلسات صفر وباقي الحقول سليمة', () => {
    const out = normalizeHermesMetrics(HEALTH_FULL, JOBS_ARRAY, null);
    assert.equal(out.sessions_count, 0);
    assert.equal(out.sessions_messages, 0);
    assert.equal(out.sessions_tool_calls, 0);
    assert.equal(out.requests_today, 120);
});

test('health بلا metrics_today وapi_server: عدّادات اليوم 0 والباقي null — بلا رمي', () => {
    const out = normalizeHermesMetrics({ status: 'ok' }, [], []);
    assert.equal(out.available, true);
    assert.equal(out.requests_today, 0);
    assert.equal(out.messages_today, 0);
    assert.equal(out.tokens_today, 0);
    assert.equal(out.active_runs, null);
    assert.equal(out.latency_p95_ms, null);
});

test('قيم غير رقمية في health تُعامَل كمفقودة (لا NaN ولا سلاسل في الحمولة)', () => {
    const out = normalizeHermesMetrics({
        active_agents: 'two',
        api_server: { active_runs: '3', stored_runs: null },
        metrics_today: { requests: '120', tokens: Number.NaN, latency_p95_ms: '850' },
    }, [], []);
    assert.equal(out.active_agents, null);
    assert.equal(out.active_runs, null);
    assert.equal(out.stored_runs, null);
    assert.equal(out.requests_today, 0);
    assert.equal(out.tokens_today, 0);
    assert.equal(out.latency_p95_ms, null);
});

/* ── حمولة "غير متاح" ─────────────────────────────────────────────────── */

test('unavailableMetricsPayload: نفس الشكل لكل الأسباب الثلاثة', () => {
    for (const reason of ['no_key', 'not_hermes', 'fetch_failed']) {
        assert.deepEqual(unavailableMetricsPayload(reason), {
            ok: false,
            available: false,
            reason,
            hermes: null,
            northflank: {
                configured: false,
                cpu_percent: null,
                memory_percent: null,
                memory_mb: null,
                cpu_vcpu: null,
                uptime_seconds: null,
                service_status: null,
            },
        });
    }
});

test('northflankPlaceholder: غير مهيأ وكل القيم null؛ وnorthflankError: مهيأ مع رسالة فقط', () => {
    const ph = northflankPlaceholder();
    assert.equal(ph.configured, false);
    assert.equal(ph.cpu_percent, null);
    assert.equal(ph.service_status, null);
    assert.ok(!('error' in ph), 'الـ placeholder لا يحمل error');
    const err = northflankError();
    assert.equal(err.configured, true);
    assert.equal(err.error, 'تعذر قراءة مقاييس Northflank');
    assert.equal(err.cpu_percent, null);
    assert.equal(err.memory_mb, null);
    assert.equal(err.uptime_seconds, null);
    assert.equal(err.service_status, null);
});

/* ── Northflank: رياضيات النسب ───────────────────────────────────────── */

test('50% ذاكرة → 256MB و50% معالج → 0.1 vCPU (حدا 512MB و0.2 vCPU)', () => {
    assert.deepEqual(northflankDerivedMetrics(50, 50), {
        cpu_percent: 50,
        memory_percent: 50,
        memory_mb: 256,
        cpu_vcpu: 0.1,
    });
});

test('25% ذاكرة → 128MB و10% معالج → 0.02 vCPU؛ والنسب غير الرقمية → null', () => {
    const out = northflankDerivedMetrics(10, 25);
    assert.equal(out.memory_mb, 128);
    assert.equal(out.cpu_vcpu, 0.02);
    assert.deepEqual(northflankDerivedMetrics(null, undefined), {
        cpu_percent: null,
        memory_percent: null,
        memory_mb: null,
        cpu_vcpu: null,
    });
    assert.deepEqual(northflankDerivedMetrics('50', '50'), {
        cpu_percent: null,
        memory_percent: null,
        memory_mb: null,
        cpu_vcpu: null,
    });
});

test('northflankMetricValue: يقرأ values[0].data[0].value، وأي شكل مكسور → null', () => {
    assert.equal(northflankMetricValue(NF_SERIES(42.5)), 42.5);
    assert.equal(northflankMetricValue({ values: [] }), null);
    assert.equal(northflankMetricValue({ values: [{ data: [] }] }), null);
    assert.equal(northflankMetricValue({ values: [{ data: [{ value: 'x' }] }] }), null);
    assert.equal(northflankMetricValue(null), null);
    assert.equal(northflankMetricValue({}), null);
});

test('northflankMetricsValues: كائن {cpu,memory} ومصفوفة series وغلاف metrics', () => {
    assert.deepEqual(northflankMetricsValues(NF_METRICS_OBJ), { cpu: 50, memory: 50 });
    assert.deepEqual(northflankMetricsValues([
        { type: 'cpu', ...NF_SERIES(10) },
        { type: 'memory', ...NF_SERIES(20) },
    ]), { cpu: 10, memory: 20 });
    assert.deepEqual(northflankMetricsValues({
        metrics: [
            { metricType: 'cpu', ...NF_SERIES(30) },
            { name: 'memory', ...NF_SERIES(40) },
        ],
    }), { cpu: 30, memory: 40 });
    assert.deepEqual(northflankMetricsValues(null), { cpu: null, memory: null });
    assert.deepEqual(northflankMetricsValues({ cpu: NF_SERIES(50) }), { cpu: 50, memory: null });
});

/* ── Northflank: مدة التشغيل والحالة ─────────────────────────────────── */

test('uptime من أقدم TASK_RUNNING — TASK_KILLED الأقدم تُتجاهل', () => {
    assert.equal(northflankUptimeSeconds(NF_CONTAINERS, NF_NOW), 3600);
    // الغلاف {containers:[...]} يعمل أيضًا.
    assert.equal(northflankUptimeSeconds({ containers: NF_CONTAINERS }, NF_NOW), 3600);
});

test('بلا حاوية جارية: uptime_seconds = null', () => {
    assert.equal(northflankUptimeSeconds([{ state: 'TASK_KILLED', createdAt: '2026-11-27T00:00:00.000Z' }], NF_NOW), null);
    assert.equal(northflankUptimeSeconds([], NF_NOW), null);
    assert.equal(northflankUptimeSeconds(null, NF_NOW), null);
});

test('createdAt يقبل epoch بالثواني وبالمللي ثانية', () => {
    const running = [{ state: 'TASK_RUNNING', createdAt: NF_NOW - 600 }];
    assert.equal(northflankUptimeSeconds(running, NF_NOW), 600);
    const runningMs = [{ state: 'TASK_RUNNING', createdAt: (NF_NOW - 600) * 1000 }];
    assert.equal(northflankUptimeSeconds(runningMs, NF_NOW), 600);
});

test('northflankServiceStatus: subset صغير — الاسم والحالة فقط', () => {
    assert.deepEqual(northflankServiceStatus(NF_SERVICE), { name: 'hermes-agent', status: 'running' });
    assert.deepEqual(northflankServiceStatus({}), { name: null, status: null });
    assert.deepEqual(northflankServiceStatus(null), { name: null, status: null });
    // حقول إضافية في الاستجابة لا تتسرّب إلى الحمولة.
    assert.deepEqual(northflankServiceStatus({ name: 'x', status: 'y', secret: 'zzz', token: 'ttt' }), { name: 'x', status: 'y' });
});

/* ── تطبيع Northflank الكامل ─────────────────────────────────────────── */

test('المسار السعيد: بلوك northflank كامل بالقيم المشتقة', () => {
    assert.deepEqual(
        normalizeNorthflankMetrics(NF_METRICS_OBJ, NF_CONTAINERS, NF_SERVICE, NF_NOW),
        {
            configured: true,
            cpu_percent: 50,
            memory_percent: 50,
            memory_mb: 256,
            cpu_vcpu: 0.1,
            uptime_seconds: 3600,
            service_status: { name: 'hermes-agent', status: 'running' },
        }
    );
});

test('فشل مصدر Northflank واحد: حقوله null وباقي المصادر سليمة (تطبيعًا)', () => {
    const out = normalizeNorthflankMetrics(null, NF_CONTAINERS, NF_SERVICE, NF_NOW);
    assert.equal(out.cpu_percent, null);
    assert.equal(out.memory_mb, null);
    assert.equal(out.uptime_seconds, 3600);
    assert.deepEqual(out.service_status, { name: 'hermes-agent', status: 'running' });
    const out2 = normalizeNorthflankMetrics(NF_METRICS_OBJ, null, null, NF_NOW);
    assert.equal(out2.memory_mb, 256);
    assert.equal(out2.uptime_seconds, null);
    assert.deepEqual(out2.service_status, { name: null, status: null });
});

/* ── ترحيل 148: الملف نفسه (نمط قراءة ملفات الترحيل في اختبارات Node) ── */

test('ترحيل 148 موجود مرة واحدة ويضيف العمودين nullable بلا غيرهما', () => {
    const dir = fs.readdirSync(path.join(ROOT, 'migrations')).filter((f) => /^148_.*\.sql$/.test(f));
    assert.deepEqual(dir, ['148_agent_northflank_token.sql'], 'توقعنا ملف ترحيل 148 واحدًا فقط في هذا الفرع');
    const sql = fs.readFileSync(path.join(ROOT, 'migrations/148_agent_northflank_token.sql'), 'utf8');
    assert.match(sql, /alter table public\.ai_agents/i);
    assert.match(sql, /add column if not exists northflank_token_encrypted text/i);
    assert.match(sql, /add column if not exists northflank_token_last4 text/i);
    // nullable: لا NOT NULL على سطري العمودين.
    for (const line of sql.split('\n')) {
        if (/northflank_token_(encrypted|last4)/i.test(line)) {
            assert.doesNotMatch(line, /NOT NULL/i, `عمود التوكن ليس nullable: ${line}`);
        }
    }
    // التراجع يسقط العمودين.
    const down = fs.readFileSync(path.join(ROOT, 'migrations/_rollback/148_agent_northflank_token.down.sql'), 'utf8');
    assert.match(down, /drop column if exists northflank_token_encrypted/i);
    assert.match(down, /drop column if exists northflank_token_last4/i);
    // والترحيل لا يمسّ أي جدول أو عمود آخر.
    assert.doesNotMatch(sql, /drop column|drop table/i);
});
