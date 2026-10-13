// ============================================================================
// api.js — integrations-api: عمليات لوحة الشركة (verify_jwt = true).
//
// التفويض كله في القاعدة: كل عملية تبدأ بدالة authenticated (بجلسة المستخدم)
// تقرر الشركة والدور والاستحقاق والمزوّد المقفل، ولا يُمرَّر معرّف شركة من
// المتصفح. بعدها فقط تُقرأ الأسرار وتُكتب عبر دوال service_role.
//
// deps = { env, fetch, now, userRpc(name, args), svcRpc(name, args), logger }
// ============================================================================

import { connectorFor, loadConnection, storeCredentials, connectorContext, FETCH_OPERATION, rpcFailure } from './registry.js';
import { invoke, supports } from './contract.js';
import { ConnectorError, errorCode } from './errors.js';
import { randomToken, sha256Hex } from './crypto.js';
import { authorizeUrl } from './salla.js';
import { pairingCode } from './wordpress.js';
import { WEBHOOK_TOPICS } from './woocommerce.js';
import { safeLog } from './redact.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(['connect', 'test', 'rotate_secret', 'oauth_start', 'link_record']);

class RpcError extends Error {
    constructor(err) { super('rpc'); this.rpc = err; }
}

function ok(body, status = 200) { return { status, body }; }
function fail(code, status) {
    const s = status || new ConnectorError(code).status;
    return { status: s, body: { error: code } };
}

async function call(rpc, name, args) {
    try {
        return await rpc(name, args);
    } catch (err) {
        throw new RpcError(err);
    }
}

function inboundBase(env) {
    const base = String(env.IHUB_PUBLIC_BASE || '').replace(/\/+$/, '');
    if (!/^https:\/\//.test(base)) throw new ConnectorError('not_configured', 'IHUB_PUBLIC_BASE');
    return `${base}/integrations-inbound`;
}

async function health(deps, connectionId, okFlag, code = null) {
    try {
        await deps.svcRpc('ihub_svc_record_health', { p_connection: connectionId, p_ok: okFlag, p_error_code: code });
    } catch { /* الصحة لا تُسقط الطلب */ }
}

async function actionConnect(deps, body) {
    const auth = await call(deps.userRpc, 'ihub_authorize', { p_connection: body.connection_id, p_action: 'connect' });
    if (auth.status !== 'pending') return fail('invalid_input', 409);
    const connector = connectorFor(auth.provider);
    if (auth.provider === 'salla') return fail('unsupported', 400);

    const n = connector.normalizeConnectInput(body);
    const ctx = { fetch: deps.fetch, env: deps.env, now: deps.now, baseUrl: n.baseUrl, credentials: n.credentials };
    try {
        await invoke(connector, 'connect', ctx);
    } catch (err) {
        await health(deps, auth.connection_id, false, errorCode(err));
        throw err;
    }

    // التفعيل أولًا: يفرض «حساب خارجي واحد لشركة واحدة» قبل تخزين أي سر
    const connection = await call(deps.svcRpc, 'ihub_svc_activate', {
        p_connection: auth.connection_id, p_external_account_id: n.externalAccountId,
        p_label: n.label, p_base_url: n.baseUrl, p_actor: auth.actor_id
    });
    await storeCredentials(deps, auth.connection_id, auth.provider, n.credentials);
    safeLog(deps.logger, 'connected', { provider: auth.provider, connection_id: auth.connection_id });

    if (auth.provider === 'woocommerce') {
        return ok({
            connection,
            webhook: {
                delivery_url: `${inboundBase(deps.env)}/woocommerce/${auth.connection_id}`,
                secret: n.credentials.webhook_secret,
                topics: WEBHOOK_TOPICS,
                shown_once: true
            }
        });
    }
    if (auth.provider === 'wordpress') {
        return ok({
            connection,
            pairing_code: pairingCode({ connectionId: auth.connection_id, secret: n.credentials.site_secret, endpoint: inboundBase(deps.env) }),
            shown_once: true
        });
    }
    return ok({ connection });
}

async function actionTest(deps, body) {
    const auth = await call(deps.userRpc, 'ihub_authorize', { p_connection: body.connection_id, p_action: 'test' });
    const connector = connectorFor(auth.provider);
    if (!supports(connector, 'verifyConnection')) return ok({ ok: null, reason: 'not_applicable' });
    const conn = await loadConnection(deps, auth.connection_id);
    if (!conn?.credentials) return fail('not_configured', 409);
    try {
        await invoke(connector, 'verifyConnection', connectorContext(deps, conn));
        await health(deps, auth.connection_id, true);
        return ok({ ok: true });
    } catch (err) {
        const code = errorCode(err);
        await health(deps, auth.connection_id, false, code);
        return ok({ ok: false, error: code });
    }
}

async function actionRotate(deps, body) {
    const auth = await call(deps.userRpc, 'ihub_authorize', { p_connection: body.connection_id, p_action: 'rotate_secret' });
    const field = { woocommerce: 'webhook_secret', wordpress: 'site_secret' }[auth.provider];
    if (!field) return fail('unsupported', 400);
    const conn = await loadConnection(deps, auth.connection_id);
    if (!conn?.credentials) return fail('not_configured', 409);
    const secret = randomToken(32);
    await storeCredentials(deps, auth.connection_id, auth.provider, { ...conn.credentials, [field]: secret });
    await deps.svcRpc('ihub_svc_audit', {
        p_connection: auth.connection_id, p_actor: auth.actor_id, p_actor_kind: 'user',
        p_action: 'secret.rotated', p_detail: { field }
    });
    if (auth.provider === 'wordpress') {
        return ok({ pairing_code: pairingCode({ connectionId: auth.connection_id, secret, endpoint: inboundBase(deps.env) }), shown_once: true });
    }
    return ok({ webhook: { delivery_url: `${inboundBase(deps.env)}/woocommerce/${auth.connection_id}`, secret, shown_once: true } });
}

async function actionOauthStart(deps, body) {
    const auth = await call(deps.userRpc, 'ihub_authorize', { p_connection: body.connection_id, p_action: 'oauth_start' });
    if (auth.provider !== 'salla') return fail('unsupported', 400);
    const env = deps.env;
    if (!env.SALLA_CLIENT_ID || !env.SALLA_CLIENT_SECRET || !env.SALLA_REDIRECT_URI) return fail('not_configured', 503);
    const state = randomToken(32);
    await call(deps.userRpc, 'ihub_oauth_begin', {
        p_connection: auth.connection_id, p_state_hash: await sha256Hex(state), p_verifier_cipher: null
    });
    return ok({ authorize_url: authorizeUrl({ clientId: env.SALLA_CLIENT_ID, redirectUri: env.SALLA_REDIRECT_URI, state }) });
}

async function actionLinkRecord(deps, body) {
    if (!UUID_RE.test(String(body.ticket_id || ''))) return fail('invalid_input', 400);
    const auth = await call(deps.userRpc, 'ihub_authorize_ticket_link', { p_ticket: body.ticket_id, p_connection: body.connection_id });
    const connector = connectorFor(auth.provider);
    const op = FETCH_OPERATION[body.record_type];
    if (!op || !connector.linkTypes.includes(body.record_type) || !supports(connector, op)) return fail('unsupported', 400);

    const conn = await loadConnection(deps, auth.connection_id);
    if (!conn?.credentials) return fail('not_configured', 409);
    let record;
    try {
        record = await invoke(connector, op, connectorContext(deps, conn), body.reference);
    } catch (err) {
        const code = errorCode(err);
        if (!['invalid_input', 'not_found'].includes(code)) await health(deps, auth.connection_id, false, code);
        throw err;
    }
    const applied = await call(deps.svcRpc, 'ihub_svc_apply_record', {
        p_connection: auth.connection_id, p_record_type: record.record_type, p_external_id: record.external_id,
        p_display_ref: record.display_ref, p_summary: record.summary, p_external_url: record.external_url,
        p_source_updated_at: record.source_updated_at, p_event_id: null, p_create: true
    });
    const link = await call(deps.svcRpc, 'ihub_svc_link_ticket', {
        p_ticket: auth.ticket_id, p_record: applied.record_id, p_actor: auth.actor_id
    });
    await health(deps, auth.connection_id, true);
    return ok({ link_id: link.link_id, created: link.created, record: { ...record, record_id: applied.record_id } });
}

export async function handleApi(deps, body) {
    try {
        if (!body || typeof body !== 'object' || !ACTIONS.has(body.action)) return fail('invalid_input', 400);
        if (!UUID_RE.test(String(body.connection_id || ''))) return fail('invalid_input', 400);
        switch (body.action) {
            case 'connect': return await actionConnect(deps, body);
            case 'test': return await actionTest(deps, body);
            case 'rotate_secret': return await actionRotate(deps, body);
            case 'oauth_start': return await actionOauthStart(deps, body);
            case 'link_record': return await actionLinkRecord(deps, body);
        }
        return fail('invalid_input', 400);
    } catch (err) {
        if (err instanceof RpcError) return rpcFailure(err.rpc);
        const code = errorCode(err);
        safeLog(deps.logger, 'api_error', { action: body?.action, code });
        return fail(code);
    }
}
