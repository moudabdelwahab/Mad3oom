/**
 * عزل الشركات عبر HTTP حقيقي: PostgREST 12 أمام قاعدة مؤقتة بنفس سلسلة مصفوفة العزل
 * (tests/fixtures/tenancy/http-stack.sql)، وطلبات بـ JWT موقَّعة لكل شخصية اصطناعية — كما يفعل
 * supabase-js من الموقع. ما تضيفه فوق tests/sql/tenant-isolation-matrix.test.sql: أن الهوية تصل من
 * JWT عبر request.jwt.claims (لا set_config يدوي)، وأن رموز HTTP ونصوص الرفض كما يراها العميل.
 *
 * ما لا يغطيه (موثَّق في docs/tenancy/ISOLATION_ROLLOUT_PROCEDURE.md): Supabase Storage API نفسه
 * (storage.objects هنا عبر PostgREST بنفس الدور والسياسات)، GoTrue، وتشغيل دوال Edge في Deno.
 *
 * يتخطّى بإعلان صريح إن غاب خادم Postgres أو ملف PostgREST (POSTGREST_BIN) — وCI يفشل إن تخطّى.
 * لا شيء هنا يلمس الإنتاج: كل المعطيات اصطناعية في قاعدة تُحذف في النهاية.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
// منطق دوال Edge نفسه (وحدات خالصة بلا Deno): حارس wf-executor وقرار رؤية MCP
const { assertWorkflowTicketAllowed, TICKET_NOT_FOUND } = await import(path.join(ROOT, 'supabase/functions/wf-executor/ticket-guard.js'));
const { tenancyFromRpc, ticketVisibleUnderIsolation } = await import(path.join(ROOT, 'supabase/functions/mcp/_shared/ticket-isolation.js'));

const PGBIN = (() => {
    try { return fs.readdirSync('/usr/lib/postgresql').sort().map(v => `/usr/lib/postgresql/${v}/bin`).filter(d => fs.existsSync(`${d}/initdb`)).pop() || null; }
    catch { return null; }
})();
const POSTGREST = (() => {
    const c = [process.env.POSTGREST_BIN, spawnSync('sh', ['-c', 'command -v postgrest']).stdout?.toString().trim()].filter(Boolean);
    return c.find(p => fs.existsSync(p)) || null;
})();
const RUNAS = spawnSync('id', ['-u', 'postgres']).status === 0 ? 'postgres' : null;
const SKIP = !PGBIN ? 'no local PostgreSQL server' : !POSTGREST ? 'no PostgREST binary (set POSTGREST_BIN)' : !RUNAS ? 'no postgres user' : null;
if (SKIP) console.log(`SKIP: tenant-isolation-http NOT executed — ${SKIP}`);

// معرّفات المعطيات الاصطناعية (tests/fixtures/tenancy/harness.sql وtickets.sql)
const U = {
    OW: '0e000000-0000-4000-8000-000000000001', EA: '0e000000-0000-4000-8000-000000000002',
    AD: '0e000000-0000-4000-8000-000000000003', SUP: '0e000000-0000-4000-8000-000000000004',
    PU: '0e000000-0000-4000-8000-000000000005',
    OA: '0a000000-0000-4000-8000-000000000001', A1: '0a000000-0000-4000-8000-000000000011',
    A2: '0a000000-0000-4000-8000-000000000012', AS: '0a000000-0000-4000-8000-000000000021',
    AG: '0a000000-0000-4000-8000-000000000022',
    OB: '0b000000-0000-4000-8000-000000000001', B1: '0b000000-0000-4000-8000-000000000011',
    BS: '0b000000-0000-4000-8000-000000000021'
};
const K = {
    TA1: '7a000000-0000-4000-8000-000000000a11', TA1S: '7a000000-0000-4000-8000-000000000a15',
    TA2: '7a000000-0000-4000-8000-000000000a12', TB1: '7b000000-0000-4000-8000-000000000b11',
    TOA: '7a000000-0000-4000-8000-000000000a00', TAS: '7a000000-0000-4000-8000-000000000a21',
    TPU: '7e000000-0000-4000-8000-000000000005'
};
const NAME_OF = Object.fromEntries(Object.entries(K).map(([n, id]) => [id, n]));
const PERSONAS = ['EA', 'AD', 'SUP', 'PU', 'OA', 'A1', 'A2', 'AS', 'AG', 'OB', 'B1', 'BS'];
const STAFF = ['EA', 'AD', 'SUP'];
const COMPANY_TICKETS = ['TA1', 'TA2', 'TB1'];

const SECRET = crypto.randomBytes(32).toString('hex');
const b64u = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
function jwt(claims) {
    const head = b64u({ alg: 'HS256', typ: 'JWT' });
    const body = b64u({ aal: 'aal1', exp: Math.floor(Date.now() / 1000) + 3600, ...claims });
    const sig = crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
    return `${head}.${body}.${sig}`;
}
const tokenOf = (p) => p === 'anon' ? null
    : p === 'service' ? jwt({ role: 'service_role' })
    : jwt({ sub: U[p], role: 'authenticated', session_id: `sess-${p}` });

let tmp, sock, base, pgrst;
const asPg = (cmd) => execFileSync('su', [RUNAS, '-s', '/bin/bash', '-c', cmd], { stdio: 'pipe' });
const psql = (sql) => execFileSync('psql', ['-h', sock, '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qtA', '-c', sql, 'postgres'],
    { cwd: ROOT, encoding: 'utf8' }).trim();

async function freePort() {
    return new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

async function http(persona, method, url, { body, profile, prefer } = {}) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    const tok = tokenOf(persona);
    if (tok) headers.Authorization = `Bearer ${tok}`;
    if (profile) { headers['Accept-Profile'] = profile; headers['Content-Profile'] = profile; }
    if (prefer) headers.Prefer = prefer;
    const res = await fetch(`${base}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
}
const ids = Object.values(K).join(',');
async function visibleTickets(p) {
    const r = await http(p, 'GET', `/tickets?select=id&id=in.(${ids})`);
    assert.equal(r.status, 200, `${p} tickets → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.map(x => NAME_OF[x.id]).sort();
}
const rows = async (p, url, opts) => {
    const r = await http(p, 'GET', url, opts);
    return r.status === 200 ? r.body.length : `http:${r.status}`;
};

// عميل بواجهة supabase-js الدنيا التي يستعملها الحارس (rpc، from().select().eq().maybeSingle()) فوق HTTP الحقيقي
function restClient(persona) {
    return {
        async rpc(name, args = {}) {
            const r = await http(persona, 'POST', `/rpc/${name}`, { body: args });
            return r.status === 200 ? { data: r.body, error: null } : { data: null, error: r.body || { status: r.status } };
        },
        from(table) {
            const q = { cols: '*', filters: [] };
            const api = {
                select(cols) { q.cols = cols; return api; },
                eq(col, v) { q.filters.push(`${col}=eq.${encodeURIComponent(v)}`); return api; },
                async maybeSingle() {
                    const r = await http(persona, 'GET', `/${table}?select=${q.cols}&${q.filters.join('&')}`);
                    if (r.status !== 200) return { data: null, error: r.body };
                    if (r.body.length > 1) return { data: null, error: { message: 'multiple rows' } };
                    return { data: r.body[0] ?? null, error: null };
                }
            };
            return api;
        }
    };
}
const guard = async (id) => {
    try { await assertWorkflowTicketAllowed(restClient('service'), id); return 'allowed'; }
    catch (e) { return e.message === TICKET_NOT_FOUND ? 'not_found' : `error:${e.message}`; }
};

test.before(async () => {
    if (SKIP) return;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pgrst-iso-'));
    sock = path.join(tmp, 'sock');
    fs.mkdirSync(path.join(tmp, 'data')); fs.mkdirSync(sock);
    execFileSync('chown', ['-R', RUNAS, tmp]);
    asPg(`${PGBIN}/initdb -D ${tmp}/data -A trust -U postgres -E UTF8 --locale=C.UTF-8 > ${tmp}/initdb.log 2>&1`);
    asPg(`${PGBIN}/pg_ctl -D ${tmp}/data -o '-k ${sock} -c listen_addresses=' -l ${tmp}/pg.log -w start > /dev/null`);
    const out = execFileSync('psql', ['-h', sock, '-U', 'postgres', '-q', '-f', 'tests/fixtures/tenancy/http-stack.sql', 'postgres'],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    assert.match(out, /HTTP STACK READY/, 'setup did not finish');

    const port = await freePort();
    const admin = await freePort();
    pgrst = spawn(POSTGREST, [], {
        env: {
            ...process.env,
            PGRST_DB_URI: `postgres://authenticator@/postgres?host=${sock}`,
            PGRST_DB_SCHEMAS: 'public,storage',
            PGRST_DB_EXTRA_SEARCH_PATH: 'public,extensions',
            PGRST_DB_ANON_ROLE: 'anon',
            PGRST_JWT_SECRET: SECRET,
            PGRST_SERVER_HOST: '127.0.0.1',
            PGRST_SERVER_PORT: String(port),
            PGRST_ADMIN_SERVER_PORT: String(admin),
            PGRST_DB_POOL: '4',
            PGRST_LOG_LEVEL: 'error'
        },
        stdio: ['ignore', 'ignore', 'pipe']
    });
    let errLog = '';
    pgrst.stderr.on('data', d => { errLog += d; });
    base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
        try { if ((await fetch(`http://127.0.0.1:${admin}/ready`)).status === 200) return; } catch { /* starting */ }
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`PostgREST did not become ready: ${errLog}`);
});

test.after(() => {
    if (SKIP) return;
    pgrst?.kill('SIGTERM');
    try { asPg(`${PGBIN}/pg_ctl -D ${tmp}/data -m immediate stop > /dev/null 2>&1`); } catch { /* stopped */ }
    fs.rmSync(tmp, { recursive: true, force: true });
});

// كل الاختبارات متتابعة على نفس القاعدة: OFF أولًا، ثم التفعيل بمسار المالك، ثم ON.
const opts = { skip: SKIP || false };

test('OFF (الإنتاج اليوم): طاقم المنصة يرى تذاكر الشركات وردودها وملفاتها — الضابط الإيجابي للرفض لاحقًا', opts, async () => {
    for (const p of STAFF) {
        const seen = await visibleTickets(p);
        for (const t of COMPANY_TICKETS) assert.ok(seen.includes(t), `${p} لا يرى ${t} والعزل مطفأ: ${seen}`);
    }
    assert.equal(await rows('AD', `/ticket_replies?select=id&ticket_id=eq.${K.TA1}`), 2);
    assert.equal(await rows('AD', `/objects?select=name&bucket_id=eq.tickets&name=like.*${K.TA1}*`, { profile: 'storage' }), 2);
    assert.equal(await rows('AD', `/accounting_invoices?select=id&ticket_id=eq.${K.TA1}`), 1);
    const inv = await http('AD', 'POST', '/rpc/ticket_invoice_status', { body: { p_ticket_id: K.TA1 } });
    assert.equal(inv.status, 200);
    assert.notEqual(inv.body.state, 'none', 'فاتورة TA1 غير ظاهرة والعزل مطفأ');
});

test('HTTP يطابق SQL لكل شخصية والعزل مطفأ (الهوية تصل من JWT لا من set_config)', opts, async () => {
    for (const p of PERSONAS) {
        assert.deepEqual((await visibleTickets(p)).join(','), psql(`select t.sql_visible('${p}')`), p);
    }
});

test('OFF: حارس wf-executor بمفتاح الخدمة عبر HTTP يسمح بكل التذاكر (لا تغيير قبل العزل)', opts, async () => {
    for (const t of ['TA1', 'TB1', 'TPU', 'TA1S']) assert.equal(await guard(K[t]), 'allowed', t);
});

test('التفعيل بمسار المالك: الصلاحيات ← الإيقاف ← العزل؛ منح الوصول تبقى مطفأة', opts, async () => {
    for (const k of ['company_permissions_enabled', 'company_suspension_enforced', 'company_isolation_enforced']) {
        assert.equal(psql(`select t.owner_sw('${k}', true) ->> 'enabled'`), 'true', k);
    }
    assert.equal(psql(`select public._isolation_on() and not public._feature_on('data_access_grants_enabled')`), 't');
    assert.equal(psql(`select count(*) from public.privileged_audit where action like 'feature_switch.%'`), '3', 'تدقيق التغييرات');
});

test('ON: HTTP يطابق SQL لكل شخصية، وطاقم المنصة لا يرى تذاكر الشركات وتبقى له تذاكر مدعوم', opts, async () => {
    const seen = {};
    for (const p of PERSONAS) {
        seen[p] = await visibleTickets(p);
        assert.deepEqual(seen[p].join(','), psql(`select t.sql_visible('${p}')`), p);
    }
    for (const p of STAFF) {
        for (const t of COMPANY_TICKETS) assert.ok(!seen[p].includes(t), `${p} يرى ${t} مع العزل`);
        for (const t of ['TA1S', 'TPU']) assert.ok(seen[p].includes(t), `${p} فقد تذكرة مدعوم ${t}`);
    }
    // الشركة أ مقابل الشركة ب، ولكلٍّ ضابطه
    assert.ok(seen.A1.includes('TA1') && !seen.A1.includes('TB1'), `A1: ${seen.A1}`);
    assert.ok(seen.B1.includes('TB1') && !seen.B1.includes('TA1') && !seen.B1.includes('TA2'), `B1: ${seen.B1}`);
    assert.ok(seen.OA.includes('TA1') && seen.OA.includes('TA2') && !seen.OA.includes('TB1'), `OA: ${seen.OA}`);
    assert.ok(!seen.OB.includes('TA1') && !seen.OB.includes('TA2') && !seen.BS.includes('TA1'), `OB/BS: ${seen.OB} ${seen.BS}`);
    assert.deepEqual(seen.PU, ['TPU']);
});

test('ON: الردود والمرفقات وملفات التخزين — رفض عبر الشركات وللطاقم، مع ضوابط إيجابية', opts, async () => {
    const q = {
        replies: (t) => `/ticket_replies?select=id&ticket_id=eq.${K[t]}`,
        attachments: (t) => `/ticket_attachments?select=id&ticket_id=eq.${K[t]}`
    };
    const files = (t) => [`/objects?select=name&bucket_id=eq.tickets&name=like.*${K[t]}*`, { profile: 'storage' }];
    for (const p of [...STAFF, 'OB', 'B1', 'BS']) {
        assert.equal(await rows(p, q.replies('TA1')), 0, `${p} replies TA1`);
        assert.equal(await rows(p, q.attachments('TA1')), 0, `${p} attachments TA1`);
        assert.equal(await rows(p, ...files('TA1')), 0, `${p} files TA1`);
    }
    for (const p of [...STAFF, 'OA', 'A1', 'AS']) {
        assert.equal(await rows(p, q.replies('TB1')), 0, `${p} replies TB1`);
        assert.equal(await rows(p, ...files('TB1')), 0, `${p} files TB1`);
    }
    // ضوابط: الشركة ترى تذكرتها، والطاقم يرى تذاكر مدعوم
    assert.ok(await rows('OA', q.replies('TA1')) >= 1, 'OA replies TA1');
    assert.ok(await rows('OA', ...files('TA1')) >= 1, 'OA files TA1');
    assert.ok(await rows('B1', q.replies('TB1')) >= 1, 'B1 replies TB1');
    assert.equal(await rows('B1', ...files('TB1')), 1, 'B1 files TB1');
    assert.ok(await rows('SUP', q.replies('TPU')) >= 1, 'SUP replies TPU');
    assert.equal(await rows('SUP', q.attachments('TPU')), 1, 'SUP attachments TPU');
    assert.equal(await rows('SUP', ...files('TPU')), 1, 'SUP files TPU');
});

test('ON: الكتابة — رد الطاقم على تذكرة شركة وتعديل تذكرة شركة أخرى مرفوضان، ورد الطاقم على مدعوم يمر', opts, async () => {
    const before = psql(`select count(*) from public.ticket_replies where ticket_id = '${K.TA1}'`);
    const w = await http('SUP', 'POST', '/ticket_replies',
        { body: { ticket_id: K.TA1, user_id: U.SUP, message: 'رد اصطناعي عبر HTTP', is_internal: true } });
    assert.ok([401, 403].includes(w.status), `SUP reply TA1 → ${w.status} ${JSON.stringify(w.body)}`);
    assert.equal(psql(`select count(*) from public.ticket_replies where ticket_id = '${K.TA1}'`), before);

    const cross = await http('OB', 'PATCH', `/tickets?id=eq.${K.TA1}`, { body: { title: 'عبث اصطناعي' }, prefer: 'return=representation' });
    assert.ok(cross.status === 200 ? cross.body.length === 0 : [401, 403].includes(cross.status), `OB patch TA1 → ${cross.status}`);
    const staff = await http('AD', 'PATCH', `/tickets?id=eq.${K.TB1}`, { body: { title: 'عبث اصطناعي' }, prefer: 'return=representation' });
    assert.ok(staff.status === 200 ? staff.body.length === 0 : [401, 403].includes(staff.status), `AD patch TB1 → ${staff.status}`);
    assert.equal(psql(`select count(*) from public.tickets where title = 'عبث اصطناعي'`), '0');

    const ok = await http('SUP', 'POST', '/ticket_replies',
        { body: { ticket_id: K.TPU, user_id: U.SUP, message: 'رد اصطناعي على مدعوم', is_internal: false }, prefer: 'return=minimal' });
    assert.equal(ok.status, 201, `SUP reply TPU → ${ok.status} ${JSON.stringify(ok.body)}`);
});

test('ON: الفواتير وربط طلبات الاشتراك بعد 111 — بلا كشف وجود، مع ضوابط', opts, async () => {
    assert.equal(await rows('AD', `/accounting_invoices?select=id&ticket_id=eq.${K.TA1}`), 0);
    assert.equal(await rows('AD', `/accounting_invoices?select=id&ticket_id=eq.${K.TA1S}`), 1, 'فاتورة مدعوم (ضابط)');
    assert.equal(await rows('A1', `/accounting_invoices?select=id&ticket_id=eq.${K.TA1}`), 1, 'فاتورة العميل نفسه (ضابط)');

    const st = await http('AD', 'POST', '/rpc/ticket_invoice_status', { body: { p_ticket_id: K.TA1 } });
    assert.deepEqual([st.status, st.body.state], [200, 'none']);
    const stS = await http('AD', 'POST', '/rpc/ticket_invoice_status', { body: { p_ticket_id: K.TA1S } });
    assert.deepEqual([stS.status, stS.body.state], [200, 'ready']);
    const doc = await http('AD', 'POST', '/rpc/ticket_invoice_document', { body: { p_ticket_id: K.TA1 } });
    const docMissing = await http('AD', 'POST', '/rpc/ticket_invoice_document', { body: { p_ticket_id: crypto.randomUUID() } });
    assert.equal(doc.status, docMissing.status, 'وثيقة فاتورة تذكرة شركة تختلف عن تذكرة غير موجودة');
    assert.equal(doc.body?.message, docMissing.body?.message);

    // ترقية بتذكرة شركة أخرى = نفس رد التذكرة غير الموجودة
    const up = await http('OB', 'POST', '/rpc/request_subscription_upgrade', { body: { p_plan: 'ultimate', p_ticket_id: K.TA1 } });
    const upMissing = await http('OB', 'POST', '/rpc/request_subscription_upgrade', { body: { p_plan: 'ultimate', p_ticket_id: crypto.randomUUID() } });
    assert.equal(up.status, 403, JSON.stringify(up.body));
    assert.deepEqual([up.status, up.body?.code, up.body?.message], [upMissing.status, upMissing.body?.code, upMissing.body?.message]);
    // شراء مربوط بتذكرة الشركة (لا فوترة مدعوم) مرفوض حتى لصاحبها
    const buy = await http('A1', 'POST', '/rpc/request_subscription_purchase', { body: { p_plan: 'support', p_billing_cycle: 'monthly', p_ticket_id: K.TA1 } });
    assert.equal(buy.status, 403, JSON.stringify(buy.body));
    assert.equal(psql(`select count(*) from public.whatsapp_subscriptions where ticket_id = '${K.TA1}'`), '0');
});

test('ON: المجهول ومفتاح الخدمة — المجهول لا يرى شيئًا، ومفتاح الخدمة يتجاوز RLS فتحرسه دوال الخادم', opts, async () => {
    const anon = await http('anon', 'GET', `/tickets?select=id&id=in.(${ids})`);
    assert.ok(anon.status === 200 ? anon.body.length === 0 : [401, 403].includes(anon.status), `anon → ${anon.status}`);
    const anonRpc = await http('anon', 'POST', '/rpc/ticket_invoice_status', { body: { p_ticket_id: K.TA1 } });
    assert.ok([401, 403].includes(anonRpc.status) || anonRpc.body?.state === 'none', `anon rpc → ${anonRpc.status}`);
    // مفتاح الخدمة (دوال Edge) يرى كل شيء: الحماية هنا في mcp_ticket_tenancy وحراس سير العمل، لا في RLS
    assert.equal(await rows('service', `/tickets?select=id&id=eq.${K.TA1}`), 1);
    const ten = await http('service', 'POST', '/rpc/mcp_ticket_tenancy', { body: { p_actor: U.AD } });
    assert.equal(ten.status, 200, JSON.stringify(ten.body));
    assert.equal(ten.body.isolation_on, true);
    assert.deepEqual(ten.body.team_company_ids, []);
    const tenAS = await http('service', 'POST', '/rpc/mcp_ticket_tenancy', { body: { p_actor: U.AS } });
    assert.deepEqual(tenAS.body.team_company_ids, ['ca000000-0000-4000-8000-00000000000a']);
    // ولا يناديها مستخدم بـ JWT
    const tenUser = await http('AD', 'POST', '/rpc/mcp_ticket_tenancy', { body: { p_actor: U.AD } });
    assert.ok([401, 403].includes(tenUser.status), `AD mcp_ticket_tenancy → ${tenUser.status}`);
});

test('ON: حارس wf-executor بمفتاح الخدمة عبر HTTP — تذكرة الشركة «غير موجودة» كالمعرّف العشوائي، وتذاكر مدعوم تمر', opts, async () => {
    for (const t of COMPANY_TICKETS) assert.equal(await guard(K[t]), 'not_found', t);
    assert.equal(await guard(crypto.randomUUID()), 'not_found', 'random');
    for (const t of ['TPU', 'TA1S']) assert.equal(await guard(K[t]), 'allowed', t);
});

test('ON: قرار رؤية MCP على ردود HTTP الحقيقية لا يمنح أبدًا أكثر من القاعدة (_ticket_row_visible)، ويطابقها لتذاكر الشركات', opts, async () => {
    const roles = Object.fromEntries((await http('service', 'GET', `/profiles?select=id,role&id=in.(${PERSONAS.map(p => U[p]).join(',')})`)).body.map(r => [r.id, r.role]));
    const tickets = Object.fromEntries((await http('service', 'GET', `/tickets?select=id,user_id,scope,company_id&id=in.(${ids})`)).body.map(r => [r.id, r]));
    assert.equal(Object.keys(tickets).length, 7);
    const stricter = [];
    for (const p of PERSONAS) {
        const ten = await http('service', 'POST', '/rpc/mcp_ticket_tenancy', { body: { p_actor: U[p] } });
        const ctx = tenancyFromRpc(ten.status === 200 ? ten.body : null, ten.status === 200 ? null : ten.body);
        assert.equal(ctx.isolationOn, true, p);
        const actor = { id: U[p], isAdmin: roles[U[p]] === 'admin', isMainAdmin: false };
        for (const [name, id] of Object.entries(K)) {
            const row = tickets[id];
            const mcp = ticketVisibleUnderIsolation(actor, row, ctx);
            const db = await http(p, 'POST', '/rpc/_ticket_row_visible', { body: { p_user: row.user_id, p_scope: row.scope, p_company: row.company_id } });
            assert.equal(db.status, 200, `${p} ${name}`);
            if (mcp) assert.equal(db.body, true, `MCP يمنح ${p} تذكرة ${name} والقاعدة تمنعها`);
            if (row.scope === 'company') assert.equal(mcp, db.body, `${p} ${name} (شركة)`);
            else if (mcp !== db.body) stricter.push(`${p}:${name}`);
        }
    }
    // MCP يقصر تذاكر مدعوم على role = admin، والقاعدة تسمح لطاقم المنصة كله (الدعم): أضيق لا أوسع
    assert.ok(stricter.every(x => x.startsWith('SUP:')), `اختلافات غير متوقعة: ${stricter}`);
});
