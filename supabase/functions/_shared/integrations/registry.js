// ============================================================================
// registry.js — الموصلات المعروفة، وخدمات مشتركة بين المعالجات.
// ============================================================================

import { woocommerce } from './woocommerce.js';
import { salla } from './salla.js';
import { daftra } from './daftra.js';
import { wordpress } from './wordpress.js';
import { decryptJson, encryptJson, credentialAad } from './crypto.js';
import { ConnectorError } from './errors.js';

export const CONNECTORS = Object.freeze({ woocommerce, salla, daftra, wordpress });

export const FETCH_OPERATION = Object.freeze({ order: 'fetchOrder', invoice: 'fetchInvoice', customer: 'fetchCustomer' });

export function connectorFor(provider) {
    const c = CONNECTORS[provider];
    if (!c) throw new ConnectorError('unsupported', 'provider');
    return c;
}

export function keyVersion(env) {
    const v = Number(env.IHUB_KEY_VERSION || 1);
    return Number.isInteger(v) && v > 0 ? v : 1;
}

/** يقرأ بيانات الربط وأسراره المفكوكة (service_role). null لربط مفصول/مجهول. */
export async function loadConnection(deps, connectionId) {
    const row = await deps.svcRpc('ihub_svc_get_credentials', { p_connection: connectionId });
    if (!row) return null;
    let credentials = null;
    if (row.ciphertext) {
        try {
            credentials = await decryptJson(deps.env.IHUB_ENC_KEY, row.ciphertext, credentialAad(row.connection_id, row.provider));
        } catch {
            throw new ConnectorError('not_configured', 'decrypt');
        }
    }
    return { ...row, ciphertext: undefined, credentials };
}

export async function storeCredentials(deps, connectionId, provider, credentials, tokenExpiresAt = null) {
    const ciphertext = await encryptJson(deps.env.IHUB_ENC_KEY, credentials, credentialAad(connectionId, provider));
    await deps.svcRpc('ihub_svc_store_credentials', {
        p_connection: connectionId, p_ciphertext: ciphertext,
        p_key_version: keyVersion(deps.env), p_token_expires_at: tokenExpiresAt
    });
}

export function connectorContext(deps, conn) {
    return {
        fetch: deps.fetch,
        env: deps.env,
        now: deps.now,
        baseUrl: conn.base_url,
        externalAccountId: conn.external_account_id,
        credentials: conn.credentials || {}
    };
}

/** رمز خطأ من RPC (PostgREST) → حالة HTTP ورمز ثابت. الرسالة من دوالنا عربية وآمنة. */
export function rpcFailure(err) {
    const code = err?.code;
    let detail = {};
    try { detail = typeof err?.details === 'string' ? JSON.parse(err.details) : (err?.details || {}); } catch { detail = {}; }
    const reason = typeof detail.code === 'string' && /^[a-z_]{1,48}$/.test(detail.code) ? detail.code : null;
    const map = { '42501': 403, P0002: 404, '22023': 400, '23505': 409, '40001': 409, P0001: 429, '23514': 400 };
    const status = map[code] || 500;
    const message = status === 500 ? null : (typeof err?.message === 'string' ? err.message.slice(0, 200) : null);
    return { status, body: { error: reason || (status === 404 ? 'not_found' : status === 403 ? 'forbidden' : 'request_failed'), message } };
}
