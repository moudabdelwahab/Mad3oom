/**
 * عامل فحص مستندات الشركات — تنفيذ مرجعي (غير منشور، ولا بنية تحتية مُجهَّزة له).
 * التشغيل والمتطلبات: docs/tenancy/DOCUMENT_SCANNER_RUNBOOK.md.
 *
 * الدورة: document_scan_queue (مفتاح الخدمة) ← تنزيل الملف من المستودع الخاص ← clamd INSTREAM ←
 * نتيجة موقَّعة HMAC إلى document-scan-callback. لا يرسل أي ملف إلى طرف ثالث: clamd محلي على شبكة العامل.
 *
 * المتغيرات: SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY · DOCUMENT_SCAN_SECRET (نفس سر الدالة الطرفية)
 *            CLAMD_HOST (افتراضي 127.0.0.1) · CLAMD_PORT (3310) · SCAN_ENGINE (clamav)
 */
import net from 'node:net';
import crypto from 'node:crypto';
import { parseClamdReply } from '../../supabase/functions/_shared/company-documents.js';

/** إطار INSTREAM: zINSTREAM\0 ثم [طول 4 بايت big-endian + بيانات]… ثم 0000. */
export function instreamFrames(bytes, chunk = 64 * 1024) {
    const parts = [Buffer.from('zINSTREAM\0')];
    for (let off = 0; off < bytes.length; off += chunk) {
        const piece = bytes.subarray(off, Math.min(off + chunk, bytes.length));
        const len = Buffer.alloc(4);
        len.writeUInt32BE(piece.length);
        parts.push(len, Buffer.from(piece));
    }
    parts.push(Buffer.alloc(4));
    return Buffer.concat(parts);
}

export function signBody(secret, body, ts = Math.floor(Date.now() / 1000)) {
    const sig = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
    return { 'X-Scan-Timestamp': String(ts), 'X-Scan-Signature': `sha256=${sig}` };
}

function clamdScan(bytes, { host, port, timeoutMs = 60000 }) {
    return new Promise((resolve) => {
        const sock = net.createConnection({ host, port });
        let reply = '';
        const done = (v) => { sock.destroy(); resolve(v); };
        sock.setTimeout(timeoutMs, () => done({ result: 'error', message: 'timeout' }));
        sock.on('error', (e) => done({ result: 'error', message: e.code || 'connect_failed' }));
        sock.on('data', (d) => { reply += d.toString('utf8'); });
        sock.on('end', () => done(parseClamdReply(reply)));
        sock.on('connect', () => sock.end(instreamFrames(bytes)));
    });
}

async function main() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const secret = process.env.DOCUMENT_SCAN_SECRET;
    if (!url || !key || !secret || secret.length < 32) {
        console.error('scanner: missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / DOCUMENT_SCAN_SECRET (>= 32 chars)');
        process.exit(2);
    }
    const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    const engine = process.env.SCAN_ENGINE || 'clamav';
    const clamd = { host: process.env.CLAMD_HOST || '127.0.0.1', port: Number(process.env.CLAMD_PORT || 3310) };
    const queue = await (await fetch(`${url}/rest/v1/rpc/document_scan_queue`, { method: 'POST', headers, body: '{"p_limit":20}' })).json();
    for (const item of Array.isArray(queue) ? queue : []) {
        const file = await fetch(`${url}/storage/v1/object/${item.bucket}/${item.path}`, { headers });
        let outcome;
        if (!file.ok) {
            outcome = { result: 'error', message: `download_${file.status}` };
        } else {
            const bytes = Buffer.from(await file.arrayBuffer());
            const sha = crypto.createHash('sha256').update(bytes).digest('hex');
            outcome = sha !== item.sha256 ? { result: 'error', message: 'sha256_mismatch' } : await clamdScan(bytes, clamd);
        }
        const body = JSON.stringify({ version_id: item.version_id, result: outcome.result, engine,
                                      detail: { signature: outcome.signature || null, message: outcome.message || null } });
        const res = await fetch(`${url}/functions/v1/document-scan-callback`, { method: 'POST', body,
            headers: { 'Content-Type': 'application/json', ...signBody(secret, body) } });
        console.log(`scanner: ${item.version_id} → ${outcome.result} (${res.status})`);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
