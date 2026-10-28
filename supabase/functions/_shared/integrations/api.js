// ============================================================================
// api.js — ihub-api: عمليات لوحة الشركة (verify_jwt = true).
//
// التفويض كله في القاعدة: كل عملية تبدأ بدالة authenticated (بجلسة المستخدم)
// تقرر الشركة والدور والاستحقاق والمزوّد المقفل، ولا يُمرَّر معرّف شركة من
// المتصفح. بعدها فقط تُقرأ الأسرار وتُكتب عبر دوال service_role.
//
// deps = { env, fetch, now, userRpc(name, args), svcRpc(name, args), logger }
// ============================================================================

import { connectorFor, loadConnection, storeCredentials, FETCH_OPERATION, rpcFailure, CONNECTORS } from './registry.js';
import { invoke, supports } from './contract.js';
import { ConnectorError, errorCode } from './errors.js';
import { randomToken, sha256Hex, decryptJson, oauthPendingAad } from './crypto.js';
import { authorizeUrl } from './salla.js';
import { pairingCode } from './wordpress.js';
import { WEBHOOK_TOPICS } from './woocommerce.js';
import * as Shopify from './shopify.js';
import { contextFor } from './shopify-session.js';
import { safeLog } from './redact.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(['connect', 'test', 'rotate_secret', 'oauth_start', 'oauth_complete', 'link_record',
                         'shopify_start', 'shopify_search', 'shopify_get', 'shopify_config']);
const LOOKUP_KINDS = new Set(['order', 'customer', 'product']);
const CONNECTORS_SHOPIFY = CONNECTORS.shopify;

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
    // Shopify: + نوع الحساب والامتياز (ihub_shopify_authorize)
    if (auth.provider === 'shopify') await call(deps.userRpc, 'ihub_shopify_authorize', { p_connection: auth.connection_id, p_action: 'test' });
    const connector = connectorFor(auth.provider);
    if (!supports(connector, 'verifyConnection')) return ok({ ok: null, reason: 'not_applicable' });
    const conn = await loadConnection(deps, auth.connection_id);
    if (!conn?.credentials) return fail('not_configured', 409);
    try {
        await invoke(connector, 'verifyConnection', contextFor(deps, conn));
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
    // state يذهب لسلة ويعود؛ binding يبقى في تبويب المدير (sessionStorage) ولا يغادره.
    // الرجوع من سلة لا يفعّل شيئًا: الإكمال يحتاج نفس المدير + نفس binding (RFC 6749 §10.12).
    const state = randomToken(32);
    const binding = randomToken(32);
    await call(deps.userRpc, 'ihub_oauth_begin', {
        p_connection: auth.connection_id, p_state_hash: await sha256Hex(state), p_binding_hash: await sha256Hex(binding)
    });
    return ok({ authorize_url: authorizeUrl({ clientId: env.SALLA_CLIENT_ID, redirectUri: env.SALLA_REDIRECT_URI, state }), binding });
}

async function actionOauthComplete(deps, body) {
    const auth = await call(deps.userRpc, 'ihub_authorize', { p_connection: body.connection_id, p_action: 'oauth_start' });
    if (auth.provider === 'shopify') return actionShopifyComplete(deps, body);
    if (auth.provider !== 'salla') return fail('unsupported', 400);
    const token = /^[A-Za-z0-9_-]{20,128}$/;
    if (!token.test(String(body.binding || '')) || !token.test(String(body.completion || ''))) return fail('state_invalid', 409);
    const cipher = await call(deps.svcRpc, 'ihub_svc_take_oauth_result', {
        p_connection: auth.connection_id, p_binding_hash: await sha256Hex(body.binding),
        p_completion_hash: await sha256Hex(body.completion), p_user: auth.actor_id
    });
    if (!cipher) return fail('state_invalid', 409);
    let pending;
    try {
        pending = await decryptJson(deps.env.IHUB_ENC_KEY, cipher, oauthPendingAad(auth.connection_id));
    } catch {
        return fail('not_configured', 503);
    }
    const connection = await call(deps.svcRpc, 'ihub_svc_activate', {
        p_connection: auth.connection_id, p_external_account_id: pending.merchant.externalAccountId,
        p_label: pending.merchant.label, p_base_url: null, p_actor: auth.actor_id
    });
    await storeCredentials(deps, auth.connection_id, 'salla', pending.tokens, pending.tokens.expires_at);
    safeLog(deps.logger, 'connected', { provider: 'salla', connection_id: auth.connection_id });
    return ok({ connection });
}

async function actionLinkRecord(deps, body) {
    if (!UUID_RE.test(String(body.ticket_id || ''))) return fail('invalid_input', 400);
    const auth = await call(deps.userRpc, 'ihub_authorize_ticket_link', { p_ticket: body.ticket_id, p_connection: body.connection_id });
    const connector = connectorFor(auth.provider);
    const op = FETCH_OPERATION[body.record_type];
    if (!op || !connector.linkTypes.includes(body.record_type) || !supports(connector, op)) return fail('unsupported', 400);

    // Shopify: + صلاحية store.orders والامتياز وسجل الوصول (ihub_authorize_lookup)
    if (auth.provider === 'shopify') {
        await call(deps.userRpc, 'ihub_authorize_lookup', { p_connection: auth.connection_id, p_kind: body.record_type, p_mode: 'record' });
    }
    const conn = await loadConnection(deps, auth.connection_id);
    if (!conn?.credentials) return fail('not_configured', 409);
    let record;
    try {
        record = await invoke(connector, op, contextFor(deps, conn), body.reference);
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

/* ── Shopify ───────────────────────────────────────────────────────────── */

function shopifyConfigured(env) {
    return !!(env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET && /^https:\/\//.test(String(env.SHOPIFY_REDIRECT_URI || '')));
}

const publicRecord = (r) => ({
    record_type: r.record_type, external_id: r.external_id, display_ref: r.display_ref, summary: r.summary,
    external_url: r.external_url, source_updated_at: r.source_updated_at
});

// state يذهب لـ Shopify ويعود موقَّعًا؛ binding يبقى في تبويب المدير. القاعدة تربط state بالمتجر المقصود.
async function actionShopifyStart(deps, body) {
    const shop = Shopify.normalizeShopDomain(body.shop);
    if (!shopifyConfigured(deps.env)) return fail('not_configured', 503);
    const state = randomToken(32);
    const binding = randomToken(32);
    await call(deps.userRpc, 'ihub_shopify_begin', {
        p_connection: body.connection_id, p_state_hash: await sha256Hex(state), p_binding_hash: await sha256Hex(binding), p_shop: shop
    });
    return ok({
        authorize_url: Shopify.authorizeUrl({ clientId: deps.env.SHOPIFY_CLIENT_ID, redirectUri: deps.env.SHOPIFY_REDIRECT_URI, state, shop }),
        binding, shop, scopes: Shopify.SHOPIFY_SCOPES
    });
}

async function actionShopifyComplete(deps, body) {
    const auth = await call(deps.userRpc, 'ihub_shopify_authorize', { p_connection: body.connection_id, p_action: 'oauth_complete' });
    const token = /^[A-Za-z0-9_-]{20,128}$/;
    if (!token.test(String(body.binding || '')) || !token.test(String(body.completion || ''))) return fail('state_invalid', 409);
    const cipher = await call(deps.svcRpc, 'ihub_svc_take_oauth_result', {
        p_connection: auth.connection_id, p_binding_hash: await sha256Hex(body.binding),
        p_completion_hash: await sha256Hex(body.completion), p_user: auth.actor_id
    });
    if (!cipher) return fail('state_invalid', 409);
    let pending;
    try {
        pending = await decryptJson(deps.env.IHUB_ENC_KEY, cipher, oauthPendingAad(auth.connection_id));
    } catch {
        return fail('not_configured', 503);
    }
    const connection = await call(deps.svcRpc, 'ihub_svc_activate', {
        p_connection: auth.connection_id, p_external_account_id: pending.shop.domain,
        p_label: pending.shop.name, p_base_url: `https://${pending.shop.domain}`, p_actor: auth.actor_id
    });
    await storeCredentials(deps, auth.connection_id, 'shopify', pending.tokens, pending.tokens.expires_at);
    const details = await call(deps.svcRpc, 'ihub_svc_set_shop_details', {
        p_connection: auth.connection_id, p_scopes: Shopify.parseScopes(pending.tokens.scope), p_gid: pending.shop.gid
    });
    await call(deps.svcRpc, 'ihub_svc_enqueue_sync', { p_connection: auth.connection_id, p_kind: 'initial', p_actor: auth.actor_id });
    safeLog(deps.logger, 'connected', { provider: 'shopify', connection_id: auth.connection_id });
    return ok({ connection: { ...connection, ...details }, sync: 'queued' });
}

async function lookupContext(deps, body, mode) {
    if (!LOOKUP_KINDS.has(body.kind)) return { error: fail('invalid_input', 400) };
    const auth = await call(deps.userRpc, 'ihub_authorize_lookup', { p_connection: body.connection_id, p_kind: body.kind, p_mode: mode });
    const conn = await loadConnection(deps, auth.connection_id);
    if (!conn?.credentials) return { error: fail('not_configured', 409) };
    return { auth, conn, ctx: contextFor(deps, conn) };
}

async function shopifyCall(deps, connectionId, fn) {
    try {
        const out = await fn();
        await health(deps, connectionId, true);
        return out;
    } catch (err) {
        const code = errorCode(err);
        if (!['invalid_input', 'not_found', 'rate_limited'].includes(code)) await health(deps, connectionId, false, code);
        throw err;
    }
}

async function actionShopifySearch(deps, body) {
    const l = await lookupContext(deps, body, 'search');
    if (l.error) return l.error;
    const res = await shopifyCall(deps, l.auth.connection_id,
        () => invoke(CONNECTORS_SHOPIFY, 'search', l.ctx, body.kind, body.query, body.after || null));
    return ok({ items: res.items.map(publicRecord), page: res.page, restricted: !!res.restricted });
}

async function actionShopifyGet(deps, body) {
    const l = await lookupContext(deps, body, 'record');
    if (l.error) return l.error;
    const id = String(body.id ?? '').trim();
    const out = await shopifyCall(deps, l.auth.connection_id, async () => {
        if (body.kind === 'customer') {
            const p = await Shopify.customerProfile(l.ctx, id);
            return { record: p.record, contact: p.contact, orders: p.orders.map(publicRecord), restricted: p.restricted };
        }
        return { record: await invoke(CONNECTORS_SHOPIFY, FETCH_OPERATION[body.kind], l.ctx, id) };
    });
    // نسخة مخزّنة قائمة (مربوطة أو مزامَنة) تُحدَّث بما رآه الموظف للتو؛ لا يُنشأ شيء جديد
    const r = out.record;
    try {
        await deps.svcRpc('ihub_svc_apply_record', {
            p_connection: l.auth.connection_id, p_record_type: r.record_type, p_external_id: r.external_id,
            p_display_ref: r.display_ref, p_summary: r.summary, p_external_url: r.external_url,
            p_source_updated_at: r.source_updated_at, p_event_id: null, p_create: false
        });
    } catch { /* التحديث المخزّن لا يُسقط العرض */ }
    return ok({ ...out, record: publicRecord(r) });
}

// تشخيص المالك: هل الإعداد موجود؟ (قيم منطقية فقط، وعناوين عامة) — لا قيمة سر تخرج.
async function actionShopifyConfig(deps) {
    await call(deps.userRpc, 'owner_store_diagnostics_authorize', {});
    const env = deps.env;
    const base = String(env.IHUB_PUBLIC_BASE || '').replace(/\/+$/, '');
    return ok({
        api_version: Shopify.apiVersion(env), scopes: Shopify.SHOPIFY_SCOPES, topics: Shopify.SUBSCRIBED_TOPICS,
        configured: {
            SHOPIFY_CLIENT_ID: !!env.SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET: !!env.SHOPIFY_CLIENT_SECRET,
            SHOPIFY_REDIRECT_URI: /^https:\/\//.test(String(env.SHOPIFY_REDIRECT_URI || '')),
            IHUB_ENC_KEY: String(env.IHUB_ENC_KEY || '').length >= 32, IHUB_PUBLIC_BASE: /^https:\/\//.test(base),
            IHUB_DASHBOARD_URL: /^https:\/\//.test(String(env.IHUB_DASHBOARD_URL || '')),
            IHUB_WORKER_SECRET: String(env.IHUB_WORKER_SECRET || '').length >= 32
        },
        urls: /^https:\/\//.test(base) ? {
            callback: `${base}/integrations-inbound/shopify/callback`,
            install: `${base}/integrations-inbound/shopify/install`,
            webhooks: `${base}/integrations-inbound/shopify/webhooks`
        } : null,
        redirect_matches_callback: /^https:\/\//.test(base) && env.SHOPIFY_REDIRECT_URI === `${base}/integrations-inbound/shopify/callback`
    });
}

export async function handleApi(deps, body) {
    try {
        if (!body || typeof body !== 'object' || !ACTIONS.has(body.action)) return fail('invalid_input', 400);
        if (body.action === 'shopify_config') return await actionShopifyConfig(deps);
        if (!UUID_RE.test(String(body.connection_id || ''))) return fail('invalid_input', 400);
        switch (body.action) {
            case 'shopify_start': return await actionShopifyStart(deps, body);
            case 'shopify_search': return await actionShopifySearch(deps, body);
            case 'shopify_get': return await actionShopifyGet(deps, body);
            case 'connect': return await actionConnect(deps, body);
            case 'test': return await actionTest(deps, body);
            case 'rotate_secret': return await actionRotate(deps, body);
            case 'oauth_start': return await actionOauthStart(deps, body);
            case 'oauth_complete': return await actionOauthComplete(deps, body);
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
