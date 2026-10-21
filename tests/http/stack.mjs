/**
 * stack.mjs — قاعدة اختبار مؤقتة (tests/fixtures/tenancy/http-stack.sql) وPostgREST 12 أمامها، مشتركة بين
 * اختبارات tests/http/*.test.mjs. كل ملف يبني نسخته ويحذفها. لا شيء يلمس الإنتاج.
 *
 * يتخطّى بإعلان صريح («SKIP: <name> NOT executed») إن غاب خادم Postgres أو ملف PostgREST (POSTGREST_BIN)؛
 * خطوة CI تفشل إن ظهر هذا الإعلان.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '../..');

const PGBIN = (() => {
    try { return fs.readdirSync('/usr/lib/postgresql').sort().map(v => `/usr/lib/postgresql/${v}/bin`).filter(d => fs.existsSync(`${d}/initdb`)).pop() || null; }
    catch { return null; }
})();
const POSTGREST = (() => {
    const c = [process.env.POSTGREST_BIN, spawnSync('sh', ['-c', 'command -v postgrest']).stdout?.toString().trim()].filter(Boolean);
    return c.find(p => fs.existsSync(p)) || null;
})();
const RUNAS = spawnSync('id', ['-u', 'postgres']).status === 0 ? 'postgres' : null;
const SKIP_REASON = !PGBIN ? 'no local PostgreSQL server' : !POSTGREST ? 'no PostgREST binary (set POSTGREST_BIN)' : !RUNAS ? 'no postgres user' : null;

/** سبب التخطي (ويطبع الإعلان)، أو null. */
export function skipReason(name) {
    if (SKIP_REASON) console.log(`SKIP: ${name} NOT executed — ${SKIP_REASON}`);
    return SKIP_REASON;
}

// معرّفات المعطيات الاصطناعية (tests/fixtures/tenancy/harness.sql وtickets.sql)
export const U = Object.freeze({
    OW: '0e000000-0000-4000-8000-000000000001', EA: '0e000000-0000-4000-8000-000000000002',
    AD: '0e000000-0000-4000-8000-000000000003', SUP: '0e000000-0000-4000-8000-000000000004',
    PU: '0e000000-0000-4000-8000-000000000005', DG: '0e000000-0000-4000-8000-000000000006',
    OA: '0a000000-0000-4000-8000-000000000001', A1: '0a000000-0000-4000-8000-000000000011',
    A2: '0a000000-0000-4000-8000-000000000012', AS: '0a000000-0000-4000-8000-000000000021',
    AG: '0a000000-0000-4000-8000-000000000022',
    OB: '0b000000-0000-4000-8000-000000000001', B1: '0b000000-0000-4000-8000-000000000011',
    BS: '0b000000-0000-4000-8000-000000000021',
    CA: 'ca000000-0000-4000-8000-00000000000a', CB: 'cb000000-0000-4000-8000-00000000000b'
});
export const K = Object.freeze({
    TA1: '7a000000-0000-4000-8000-000000000a11', TA1S: '7a000000-0000-4000-8000-000000000a15',
    TA2: '7a000000-0000-4000-8000-000000000a12', TB1: '7b000000-0000-4000-8000-000000000b11',
    TOA: '7a000000-0000-4000-8000-000000000a00', TAS: '7a000000-0000-4000-8000-000000000a21',
    TPU: '7e000000-0000-4000-8000-000000000005'
});

async function freePort() {
    return new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

export function createStack() {
    const secret = crypto.randomBytes(32).toString('hex');
    const b64u = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
    let tmp, sock, base, pgrst;
    const asPg = (cmd) => execFileSync('su', [RUNAS, '-s', '/bin/bash', '-c', cmd], { stdio: 'pipe' });

    const stack = {
        /** JWT موقَّع بسر PostgREST (HS256) كما تصدره GoTrue. */
        jwt(claims) {
            const head = b64u({ alg: 'HS256', typ: 'JWT' });
            const body = b64u({ aal: 'aal1', exp: Math.floor(Date.now() / 1000) + 3600, ...claims });
            const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
            return `${head}.${body}.${sig}`;
        },
        /** 'anon' ⇒ بلا رمز، 'service' ⇒ service_role، وإلا شخصية من U أو معرّف مستخدم. */
        tokenOf(p) {
            if (p === 'anon') return null;
            if (p === 'service') return stack.jwt({ role: 'service_role' });
            const sub = U[p] || p;
            return stack.jwt({ sub, role: 'authenticated', session_id: `sess-${sub}` });
        },
        psql(sql) {
            return execFileSync('psql', ['-h', sock, '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qtA', '-c', sql, 'postgres'],
                { cwd: ROOT, encoding: 'utf8' }).trim();
        },
        async http(persona, method, url, { body, profile, prefer } = {}) {
            const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
            const tok = stack.tokenOf(persona);
            if (tok) headers.Authorization = `Bearer ${tok}`;
            if (profile) { headers['Accept-Profile'] = profile; headers['Content-Profile'] = profile; }
            if (prefer) headers.Prefer = prefer;
            const res = await fetch(`${base}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
            const text = await res.text();
            let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
            return { status: res.status, body: json };
        },
        /** واجهة supabase-js الدنيا (rpc، from().select().eq().maybeSingle()) فوق HTTP الحقيقي. */
        restClient(persona) {
            return {
                async rpc(name, args = {}) {
                    const r = await stack.http(persona, 'POST', `/rpc/${name}`, { body: args });
                    return r.status === 200 ? { data: r.body, error: null } : { data: null, error: r.body || { status: r.status } };
                },
                from(table) {
                    const q = { cols: '*', filters: [] };
                    const api = {
                        select(cols) { q.cols = cols; return api; },
                        eq(col, v) { q.filters.push(`${col}=eq.${encodeURIComponent(v)}`); return api; },
                        async maybeSingle() {
                            const r = await stack.http(persona, 'GET', `/${table}?select=${q.cols}&${q.filters.join('&')}`);
                            if (r.status !== 200) return { data: null, error: r.body };
                            if (r.body.length > 1) return { data: null, error: { message: 'multiple rows' } };
                            return { data: r.body[0] ?? null, error: null };
                        }
                    };
                    return api;
                }
            };
        },
        async start() {
            tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pgrst-stack-'));
            sock = path.join(tmp, 'sock');
            fs.mkdirSync(path.join(tmp, 'data')); fs.mkdirSync(sock);
            execFileSync('chown', ['-R', RUNAS, tmp]);
            asPg(`${PGBIN}/initdb -D ${tmp}/data -A trust -U postgres -E UTF8 --locale=C.UTF-8 > ${tmp}/initdb.log 2>&1`);
            asPg(`${PGBIN}/pg_ctl -D ${tmp}/data -o '-k ${sock} -c listen_addresses=' -l ${tmp}/pg.log -w start > /dev/null`);
            const out = execFileSync('psql', ['-h', sock, '-U', 'postgres', '-q', '-f', 'tests/fixtures/tenancy/http-stack.sql', 'postgres'],
                { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
            if (!/HTTP STACK READY/.test(out)) throw new Error('http-stack.sql did not finish');

            const port = await freePort();
            const admin = await freePort();
            pgrst = spawn(POSTGREST, [], {
                env: {
                    ...process.env,
                    PGRST_DB_URI: `postgres://authenticator@/postgres?host=${sock}`,
                    PGRST_DB_SCHEMAS: 'public,storage',
                    PGRST_DB_EXTRA_SEARCH_PATH: 'public,extensions',
                    PGRST_DB_ANON_ROLE: 'anon',
                    PGRST_JWT_SECRET: secret,
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
        },
        stop() {
            pgrst?.kill('SIGTERM');
            try { asPg(`${PGBIN}/pg_ctl -D ${tmp}/data -m immediate stop > /dev/null 2>&1`); } catch { /* stopped */ }
            if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
        }
    };
    return stack;
}
