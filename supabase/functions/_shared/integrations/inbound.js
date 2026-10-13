// ============================================================================
// inbound.js — integrations-inbound (verify_jwt = false): كل ما يأتي من خارج
// مدعوم. لكل مسار مصادقته الخاصة، وتسبق أي كتابة في القاعدة:
//
//   POST /woocommerce/<connection_id>   توقيع HMAC بسر الربط
//   POST /salla                         توقيع HMAC بسر تطبيق سلة، ثم الربط من merchant
//   GET  /salla/callback?code&state     state لمرة واحدة (sha256 مخزّن)
//   POST /wordpress/v1/ping|intake      طلب موقَّع من الإضافة + nonce لمرة واحدة
//
// قواعد الردود:
//   • توقيع خاطئ = 401 بلا أي أثر.
//   • حدث موثَّق لكن متجاهل/مكرر/لربط مقفل = 200 (ووكومرس يعطّل الويب هوك بعد
//     أكثر من 5 إخفاقات، والفشل هنا ليس فشل المرسل).
//   • فشل معالجة حدث موثَّق مخزَّن = 200 والحدث يُعاد بالعامل (لا حمولة مخزّنة:
//     العامل يجلب السجل من المزوّد).
//   • لا حمولة ولا بيانات عميل في أي سجل أو رد.
// ============================================================================

import { CONNECTORS, loadConnection, storeCredentials, connectorContext } from './registry.js';
import { invoke } from './contract.js';
import { ConnectorError, errorCode } from './errors.js';
import { sha256Hex } from './crypto.js';
import { verifySallaWebhook, exchangeCode, fetchMerchant } from './salla.js';
import { readSignedHeaders, verifySignedRequest, validateIntake } from './wordpress.js';
import { safeLog } from './redact.js';

export const MAX_INBOUND_BYTES = 256 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (status, body) => ({ status, body });

async function processEvent(deps, connectionId, provider, evt) {
    const ingested = await deps.svcRpc('ihub_svc_ingest_event', {
        p_connection: connectionId, p_topic: evt.topic, p_dedupe_key: evt.dedupeKey,
        p_external_type: evt.externalType, p_external_id: evt.externalId, p_source_updated_at: evt.sourceUpdatedAt
    });
    safeLog(deps.logger, 'event', { provider, connection_id: connectionId, topic: evt.topic,
                                    duplicate: !!ingested?.duplicate, linked: !!ingested?.linked });
    if (ingested?.duplicate) return json(200, { ok: true, duplicate: true });
    if (!ingested?.linked) return json(200, { ok: true, ignored: 'not_linked' });
    try {
        const r = evt.record;
        const applied = await deps.svcRpc('ihub_svc_apply_record', {
            p_connection: connectionId, p_record_type: r.record_type, p_external_id: r.external_id,
            p_display_ref: r.display_ref, p_summary: r.summary, p_external_url: r.external_url,
            p_source_updated_at: r.source_updated_at, p_event_id: ingested.event_id, p_create: false
        });
        return json(200, { ok: true, applied: !!applied?.applied });
    } catch (err) {
        try {
            await deps.svcRpc('ihub_svc_event_failed', { p_event: ingested.event_id, p_error_code: errorCode(err), p_retry: true });
        } catch { /* العامل سيجده بحالة received؛ لا نُسقط الرد */ }
        return json(200, { ok: true, queued: true });
    }
}

async function woocommerceWebhook(deps, connectionId, req) {
    if (!UUID_RE.test(connectionId)) return json(404, { error: 'not_found' });
    const conn = await loadConnection(deps, connectionId);
    if (!conn || conn.provider !== 'woocommerce' || !conn.credentials?.webhook_secret) return json(404, { error: 'not_found' });
    const evt = await invoke(CONNECTORS.woocommerce, 'handleWebhook', connectorContext(deps, conn),
                             { headers: req.headers, rawBody: req.rawBody });
    if (evt.ping) return json(200, { ok: true, ping: true });
    if (!conn.provider_enabled || !['active', 'error', 'reauth_required'].includes(conn.status)) {
        return json(200, { ok: true, ignored: 'disabled' });
    }
    if (evt.ignored) return json(200, { ok: true, ignored: 'topic' });
    return processEvent(deps, connectionId, 'woocommerce', evt);
}

async function sallaWebhook(deps, req) {
    const envelope = await verifySallaWebhook({ env: deps.env }, { headers: req.headers, rawBody: req.rawBody });
    const found = await deps.svcRpc('ihub_svc_find_connection', { p_provider: 'salla', p_external_account_id: envelope.merchant });
    // متجر ثبّت التطبيق ولم يربطه أحد بشركة: لا شيء يُخزَّن
    if (!found) return json(200, { ok: true, ignored: 'unknown_merchant' });
    const conn = await loadConnection(deps, found.connection_id);
    if (!conn?.provider_enabled) return json(200, { ok: true, ignored: 'disabled' });
    const evt = await invoke(CONNECTORS.salla, 'handleWebhook', connectorContext(deps, conn), envelope);
    if (evt.revoke) {
        await deps.svcRpc('ihub_svc_revoked_by_provider', { p_connection: found.connection_id, p_reason: evt.topic.replace(/[^a-z_.]/g, '') });
        return json(200, { ok: true, revoked: true });
    }
    if (evt.ignored) return json(200, { ok: true, ignored: 'topic' });
    return processEvent(deps, found.connection_id, 'salla', evt);
}

function dashboardRedirect(env, params) {
    const base = /^https:\/\//.test(String(env.IHUB_DASHBOARD_URL || '')) ? env.IHUB_DASHBOARD_URL : 'https://mad3oom.com/company-dashboard/';
    const u = new URL(base);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.hash = 'integrations';
    return { status: 302, redirect: u.toString(), body: null };
}

async function sallaCallback(deps, req) {
    const code = req.query.get('code');
    const state = req.query.get('state');
    if (!state || !/^[A-Za-z0-9_-]{20,128}$/.test(state)) return dashboardRedirect(deps.env, { ihub_result: 'error', ihub_code: 'state_invalid' });
    // state يُستهلك أولًا حتى لو رفض التاجر: لا إعادة استعمال
    const st = await deps.svcRpc('ihub_svc_consume_oauth_state', { p_state_hash: await sha256Hex(state) });
    if (!st || st.provider !== 'salla') return dashboardRedirect(deps.env, { ihub_result: 'error', ihub_code: 'state_invalid' });
    if (!code || req.query.get('error')) return dashboardRedirect(deps.env, { ihub_result: 'error', ihub_code: 'denied' });
    try {
        const tokens = await exchangeCode({ fetch: deps.fetch, env: deps.env, now: deps.now }, code);
        const merchant = await fetchMerchant({ fetch: deps.fetch }, tokens.access_token);
        await deps.svcRpc('ihub_svc_activate', {
            p_connection: st.connection_id, p_external_account_id: merchant.externalAccountId,
            p_label: merchant.label, p_base_url: null, p_actor: st.user_id
        });
        await storeCredentials(deps, st.connection_id, 'salla', tokens, tokens.expires_at);
        safeLog(deps.logger, 'connected', { provider: 'salla', connection_id: st.connection_id });
        return dashboardRedirect(deps.env, { ihub_result: 'connected', ihub_provider: 'salla' });
    } catch (err) {
        let c = errorCode(err);
        if (err?.code === '23505') c = 'account_in_use';
        try {
            await deps.svcRpc('ihub_svc_record_health', { p_connection: st.connection_id, p_ok: false, p_error_code: c });
        } catch { /* ignore */ }
        return dashboardRedirect(deps.env, { ihub_result: 'error', ihub_code: c });
    }
}

async function wordpressRequest(deps, action, req) {
    if (!['ping', 'intake'].includes(action)) return json(404, { error: 'not_found' });
    const h = readSignedHeaders(req.headers);
    const conn = await loadConnection(deps, h.connectionId);
    if (!conn || conn.provider !== 'wordpress' || !conn.credentials?.site_secret) throw new ConnectorError('signature_invalid', 'connection');
    await verifySignedRequest({ secret: conn.credentials.site_secret, nowMs: deps.now() },
                              { headers: req.headers, method: req.method, path: `/wordpress/v1/${action}`, rawBody: req.rawBody });
    const fresh = await deps.svcRpc('ihub_svc_use_nonce', { p_connection: h.connectionId, p_nonce: h.nonce, p_ttl_seconds: 600 });
    if (!fresh) throw new ConnectorError('signature_invalid', 'replay');
    if (!conn.provider_enabled || !['active', 'error'].includes(conn.status)) return json(403, { error: 'connection_inactive' });

    if (action === 'ping') {
        await deps.svcRpc('ihub_svc_record_health', { p_connection: h.connectionId, p_ok: true, p_error_code: null });
        return json(200, { ok: true, registered_site: conn.external_account_id, server_time: Math.floor(deps.now() / 1000) });
    }
    let body;
    try { body = JSON.parse(new TextDecoder().decode(req.rawBody)); } catch { throw new ConnectorError('invalid_payload', 'json'); }
    const v = validateIntake(body);
    try {
        const res = await deps.svcRpc('ihub_svc_wp_intake', {
            p_connection: h.connectionId, p_name: v.name, p_email: v.email, p_subject: v.subject,
            p_message: v.message, p_order_ref: v.orderRef, p_site_user_ref: v.siteUserRef
        });
        return json(201, { ok: true, intake_id: res.intake_id });
    } catch (err) {
        if (err?.code === 'P0001') return json(429, { error: 'rate_limited' });
        if (err?.code === 'P0002') return json(403, { error: 'connection_inactive' });
        throw err;
    }
}

/**
 * req = { method, path: '/woocommerce/<id>' (بعد اسم الدالة), headers, rawBody: Uint8Array, query: URLSearchParams }
 */
export async function handleInbound(deps, req) {
    const parts = String(req.path || '/').split('/').filter(Boolean);
    try {
        if (req.rawBody && req.rawBody.byteLength > MAX_INBOUND_BYTES) return json(413, { error: 'too_large' });
        if (req.method === 'GET' && parts[0] === 'salla' && parts[1] === 'callback' && parts.length === 2) {
            return await sallaCallback(deps, req);
        }
        if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
        if (parts[0] === 'woocommerce' && parts.length === 2) return await woocommerceWebhook(deps, parts[1], req);
        if (parts[0] === 'salla' && parts.length === 1) return await sallaWebhook(deps, req);
        if (parts[0] === 'wordpress' && parts[1] === 'v1' && parts.length === 3) return await wordpressRequest(deps, parts[2], req);
        return json(404, { error: 'not_found' });
    } catch (err) {
        const code = errorCode(err);
        safeLog(deps.logger, 'inbound_error', { route: parts[0] || '-', code });
        if (code === 'signature_invalid') return json(401, { error: 'unauthorized' });
        if (code === 'invalid_payload' || code === 'invalid_response') return json(400, { error: 'invalid_payload' });
        if (code === 'not_configured') return json(503, { error: 'not_configured' });
        return json(500, { error: 'internal_error' });
    }
}
