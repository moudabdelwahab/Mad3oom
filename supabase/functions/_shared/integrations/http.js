// ============================================================================
// http.js — نداءات خارجية آمنة لمركز التكاملات.
//
// كل عنوان يكتبه مستخدم (رابط متجر ووكومرس، موقع ووردبريس) يمر بـ
// validateExternalUrl قبل أي نداء، وكل نداء يمر بـ safeFetch:
//   • https فقط، بلا بيانات اعتماد في الرابط، وبالمنفذ الافتراضي 443 فقط.
//   • لا عناوين IP حرفية، ولا localhost ولا أسماء داخلية (.local .internal
//     .localhost .lan .home .corp) ولا أسماء بلا نقطة.
//   • لا تتبع لإعادة التوجيه (redirect: 'manual'): 3xx = redirect_refused.
//   • مهلة زمنية وحد لحجم الرد يُقرأ تدريجيًا (لا نحمّل ردًا ضخمًا في الذاكرة).
//
// القيد المتبقي (موثّق في SECURITY_REVIEW.md): لا نتحقق من عنوان IP الذي يُحلّ
// إليه الاسم (DNS rebinding) — بيئة الدوال الطرفية لا تتيح ربط الحلّ بالاتصال.
// ============================================================================

import { ConnectorError } from './errors.js';

const INTERNAL_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home', '.corp', '.intranet',
                           '.localdomain', '.home.arpa', '.svc', '.cluster.local'];
const INTERNAL_HOSTS = new Set(['localhost', 'metadata.google.internal', 'metadata', 'instance-data']);

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 512 * 1024;

// IPv6، أو IPv4 بأي صيغة (127.1 ، 2130706433 ، 0x7f.1): كل مقطع رقمي.
function isIpLiteral(host) {
    if (host.startsWith('[') || host.includes(':')) return true;
    return host.split('.').every((label) => /^(0x[0-9a-f]*|[0-9]+)$/i.test(label));
}

/**
 * يتحقق من رابط خارجي ويرجعه مطبَّعًا: https://host[/path] بلا / في آخره.
 * allowedHostSuffixes (اختياري): يقصر المضيف على نطاقات بعينها.
 */
export function validateExternalUrl(input, { allowPath = true, allowedHostSuffixes = null } = {}) {
    let u;
    try {
        u = new URL(String(input || '').trim());
    } catch {
        throw new ConnectorError('invalid_url', 'unparseable');
    }
    if (u.protocol !== 'https:') throw new ConnectorError('invalid_url', 'https_required');
    if (u.username || u.password) throw new ConnectorError('invalid_url', 'credentials_in_url');
    if (u.port && u.port !== '443') throw new ConnectorError('invalid_url', 'port_not_allowed');
    if (u.search || u.hash) throw new ConnectorError('invalid_url', 'query_not_allowed');

    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (!host || host.length > 253) throw new ConnectorError('invalid_url', 'bad_host');
    if (isIpLiteral(host)) throw new ConnectorError('invalid_url', 'ip_literal');
    if (!host.includes('.')) throw new ConnectorError('invalid_url', 'single_label');
    if (INTERNAL_HOSTS.has(host) || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) {
        throw new ConnectorError('invalid_url', 'internal_host');
    }
    if (!/^[a-z0-9.-]+$/.test(host) || host.split('.').some((l) => !l || l.length > 63 || l.startsWith('-') || l.endsWith('-'))) {
        throw new ConnectorError('invalid_url', 'bad_host');
    }
    if (allowedHostSuffixes && !allowedHostSuffixes.some((s) => host === s.replace(/^\./, '') || host.endsWith(s.startsWith('.') ? s : `.${s}`))) {
        throw new ConnectorError('invalid_url', 'host_not_allowed');
    }

    let path = allowPath ? u.pathname.replace(/\/+$/, '') : '';
    if (path.includes('..') || /[^A-Za-z0-9\-._~/%]/.test(path) || path.length > 200) {
        throw new ConnectorError('invalid_url', 'bad_path');
    }
    return `https://${host}${path}`;
}

async function readCapped(response, maxBytes) {
    const declared = Number(response.headers.get('content-length') || '0');
    if (declared > maxBytes) throw new ConnectorError('response_too_large');
    if (!response.body || typeof response.body.getReader !== 'function') {
        const text = await response.text();
        if (new TextEncoder().encode(text).length > maxBytes) throw new ConnectorError('response_too_large');
        return text;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            try { await reader.cancel(); } catch { /* ignore */ }
            throw new ConnectorError('response_too_large');
        }
        chunks.push(value);
    }
    const all = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.byteLength; }
    return new TextDecoder().decode(all);
}

/**
 * نداء خارجي بحدود. يرجع { status, json, text } ولا يرمي على 4xx/5xx — المتصل
 * يقرر الرمز. يرمي ConnectorError على المهلة وإعادة التوجيه والحجم وفشل الشبكة.
 */
export async function safeFetch(fetchImpl, url, {
    method = 'GET', headers = {}, body = undefined, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES
} = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
        response = await fetchImpl(url, { method, headers, body, redirect: 'manual', signal: controller.signal });
    } catch (err) {
        clearTimeout(timer);
        if (err?.name === 'AbortError' || controller.signal.aborted) throw new ConnectorError('timeout');
        throw new ConnectorError('provider_unavailable', 'network');
    }
    try {
        if (response.status >= 300 && response.status < 400 || response.type === 'opaqueredirect') {
            throw new ConnectorError('redirect_refused');
        }
        const text = await readCapped(response, maxBytes);
        let json = null;
        if (text) {
            try { json = JSON.parse(text); } catch { json = null; }
        }
        return { status: response.status, json, text, headers: response.headers };
    } catch (err) {
        if (err instanceof ConnectorError) throw err;
        if (err?.name === 'AbortError' || controller.signal.aborted) throw new ConnectorError('timeout');
        throw new ConnectorError('provider_unavailable', 'read');
    } finally {
        clearTimeout(timer);
    }
}
