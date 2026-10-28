// ============================================================================
// shopify-session.js — رمز وصول صالح لكل نداء Shopify، بكاتب تجديد واحد.
//
// رموز Shopify offline المنتهية: وصول ~ ساعة، وتجديد 90 يومًا **يتبدّل** عند كل تجديد. نداءان
// يجدّدان بالرمز القديم معًا قد يتركان الربط برمز ميت، فالتجديد يمر بقفل في القاعدة
// (ihub_svc_claim_token_refresh): من يحصل عليه يعيد القراءة ثم يجدّد ثم يخزّن ثم يحرّر؛ ومن لا
// يحصل عليه ينتظر قليلًا ويعيد القراءة (الآخر جدّد).
//
// التجديد عند الحاجة فقط (قبل الانتهاء بدقيقتين). المطابقة الدورية كل 6 ساعات (119) تُبقي رمز
// التجديد حيًّا لمتجر بلا نشاط؛ لا تجديد كل دورة عامل.
// ============================================================================

import { CONNECTORS, loadConnection, storeCredentials, connectorContext } from './registry.js';
import { invoke } from './contract.js';
import { ConnectorError, errorCode } from './errors.js';

const SKEW_MS = 120_000;
const WAIT_MS = 400;
const WAIT_TRIES = 6;

const fresh = (creds, nowMs) => !!creds?.access_token && (!creds.expires_at || Date.parse(creds.expires_at) - SKEW_MS > nowMs);
const sleep = (deps, ms) => (deps.sleep ? deps.sleep(ms) : new Promise((r) => setTimeout(r, ms)));

export async function ensureAccessToken(deps, connectionId) {
    let conn = await loadConnection(deps, connectionId);
    if (!conn?.credentials?.access_token) throw new ConnectorError('token_expired');
    if (fresh(conn.credentials, deps.now())) return conn.credentials.access_token;

    const claimed = await deps.svcRpc('ihub_svc_claim_token_refresh', { p_connection: connectionId, p_seconds: 30 });
    if (!claimed) {
        for (let i = 0; i < WAIT_TRIES; i++) {
            await sleep(deps, WAIT_MS);
            conn = await loadConnection(deps, connectionId);
            if (fresh(conn?.credentials, deps.now())) return conn.credentials.access_token;
        }
        throw new ConnectorError('provider_unavailable', 'refresh_busy');
    }
    try {
        conn = await loadConnection(deps, connectionId);            // ربما جدّده غيرنا قبل القفل
        if (fresh(conn?.credentials, deps.now())) return conn.credentials.access_token;
        const tokens = await invoke(CONNECTORS.shopify, 'refreshCredentials', connectorContext(deps, conn));
        await storeCredentials(deps, connectionId, 'shopify', { ...conn.credentials, ...tokens }, tokens.expires_at);
        await deps.svcRpc('ihub_svc_audit', { p_connection: connectionId, p_actor: null, p_actor_kind: 'system',
                                              p_action: 'token.refreshed', p_detail: {} });
        return tokens.access_token;
    } catch (err) {
        const code = errorCode(err);
        if (['token_expired', 'auth_failed'].includes(code)) {
            await deps.svcRpc('ihub_svc_record_health', { p_connection: connectionId, p_ok: false, p_error_code: 'token_expired' });
        }
        throw err;
    } finally {
        try { await deps.svcRpc('ihub_svc_release_token_refresh', { p_connection: connectionId }); } catch { /* القفل ينتهي وحده */ }
    }
}

/** سياق موصل Shopify: نفس connectorContext + accessToken() يجدّد عند الحاجة. */
export function shopifyContext(deps, conn) {
    return { ...connectorContext(deps, conn), accessToken: () => ensureAccessToken(deps, conn.connection_id) };
}

/** السياق المناسب لأي مزوّد. */
export function contextFor(deps, conn) {
    return conn.provider === 'shopify' ? shopifyContext(deps, conn) : connectorContext(deps, conn);
}
