// ============================================================================
// inbound.js — integrations-inbound (verify_jwt = false): كل ما يأتي من خارج
// مدعوم. لكل مسار مصادقته الخاصة، وتسبق أي كتابة في القاعدة:
//
//   POST /woocommerce/<connection_id>   توقيع HMAC بسر الربط
//   POST /salla                         توقيع HMAC بسر تطبيق سلة، ثم الربط من merchant
//   GET  /salla/callback?code&state     state لمرة واحدة (sha256 مخزّن)
//   POST /wordpress/v1/ping|intake      طلب موقَّع من الإضافة + nonce لمرة واحدة
//   GET  /shopify/install?shop&hmac…    hmac بسر التطبيق + طابع حديث ⇒ تحويل للوحة فقط (لا رموز)
//   GET  /shopify/callback?code&hmac&shop&state   hmac + state لمرة واحدة مربوط بالمتجر ⇒ حجز النتيجة
//   POST /shopify/webhooks              X-Shopify-Hmac-Sha256 بسر التطبيق، ثم الربط من النطاق
//
// قواعد الردود:
//   • توقيع خاطئ = 401 بلا أي أثر.
//   • حدث موثَّق لكن متجاهل/مكرر/لربط مقفل = 200 (ووكومرس يعطّل الويب هوك بعد
//     أكثر من 5 إخفاقات، والفشل هنا ليس فشل المرسل).
//   • فشل معالجة حدث موثَّق مخزَّن = 200 والحدث يُعاد بالعامل (لا حمولة مخزّنة:
//     العامل يجلب السجل من المزوّد).
//   • لا حمولة ولا بيانات عميل في أي سجل أو رد.
// ============================================================================

import { CONNECTORS, loadConnection, connectorContext } from './registry.js';
import { invoke } from './contract.js';
import { ConnectorError, errorCode } from './errors.js';
import { sha256Hex, encryptJson, oauthPendingAad, randomToken } from './crypto.js';
import { verifySallaWebhook, exchangeCode, fetchMerchant } from './salla.js';
import { readSignedHeaders, verifySignedRequest, validateIntake, siteMatches } from './wordpress.js';
import * as Shopify from './shopify.js';
import { safeLog } from './redact.js';

export const MAX_INBOUND_BYTES = 1024 * 1024;  // طلب Shopify كبير يُقرأ كله للتحقق من التوقيع
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

function dashboardRedirect(env, params, page = 'integrations') {
    const base = /^https:\/\//.test(String(env.IHUB_DASHBOARD_URL || '')) ? env.IHUB_DASHBOARD_URL : 'https://mad3oom.com/company-dashboard/';
    const u = new URL(base);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.hash = page;
    return { status: 302, redirect: u.toString(), body: null };
}
// Shopify لحسابات المتاجر: صفحة #shopify (إكمال OAuth يعمل من أي صفحة — company-integrations.js)
const shopifyRedirect = (env, params) => dashboardRedirect(env, params, 'shopify');

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
        // لا تفعيل هنا. النتيجة تُحجز مشفّرة، ورمز إكمال لمرة واحدة يذهب لهذا
        // المتصفح وحده (المتصفح الذي وافق في سلة). الإكمال (oauth_complete) يحتاج
        // معه جلسة المدير الذي بدأ وبصمة تبويبه — فمتجر ضحية وصلها رابط تفويض
        // من مدير شركة أخرى لا يُربط: هي بلا جلسته، وهو بلا رمز الإكمال.
        const cipher = await encryptJson(deps.env.IHUB_ENC_KEY, { tokens, merchant }, oauthPendingAad(st.connection_id));
        const completion = randomToken(32);
        const held = await deps.svcRpc('ihub_svc_hold_oauth_result', {
            p_state_hash: await sha256Hex(state), p_pending_cipher: cipher, p_completion_hash: await sha256Hex(completion)
        });
        if (!held) return dashboardRedirect(deps.env, { ihub_result: 'error', ihub_code: 'state_invalid' });
        return dashboardRedirect(deps.env, {
            ihub_result: 'confirm', ihub_provider: 'salla', ihub_connection: st.connection_id, ihub_completion: completion
        });
    } catch (err) {
        const c = errorCode(err);
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

    let body;
    try { body = JSON.parse(new TextDecoder().decode(req.rawBody)); } catch { throw new ConnectorError('invalid_payload', 'json'); }
    // رمز اقتران منسوخ إلى موقع آخر لا يعمل: الموقع جزء من الطلب الموقَّع
    if (!siteMatches(conn.base_url, body?.site)) {
        await deps.svcRpc('ihub_svc_record_health', { p_connection: h.connectionId, p_ok: false, p_error_code: 'site_mismatch' });
        return json(403, { error: 'site_mismatch' });
    }
    if (action === 'ping') {
        await deps.svcRpc('ihub_svc_record_health', { p_connection: h.connectionId, p_ok: true, p_error_code: null });
        return json(200, { ok: true, server_time: Math.floor(deps.now() / 1000) });
    }
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

/* ── Shopify ───────────────────────────────────────────────────────────── */

// التثبيت من Shopify (رابط التطبيق): لا شيء يُربط هنا. المتجر يصل اللوحة ويبدأ الربط بجلسة مدير
// المتجر في مدعوم (state مربوط بالتبويب). hmac يمنع رابطًا مزيّفًا يحمل نطاقًا آخر.
async function shopifyInstall(deps, req) {
    if (!deps.env.SHOPIFY_CLIENT_SECRET) return shopifyRedirect(deps.env, { ihub_result: 'error', ihub_code: 'not_configured' });
    const shop = String(req.query.get('shop') || '').toLowerCase();
    if (!Shopify.SHOP_RE.test(shop) || !Shopify.freshTimestamp(req.query.get('timestamp'), deps.now())
        || !(await Shopify.verifyQueryHmac(deps.env.SHOPIFY_CLIENT_SECRET, req.query))) {
        return shopifyRedirect(deps.env, { ihub_result: 'error', ihub_code: 'signature_invalid' });
    }
    return shopifyRedirect(deps.env, { ihub_result: 'install', ihub_provider: 'shopify', ihub_shop: shop });
}

async function shopifyCallback(deps, req) {
    const env = deps.env;
    if (!env.SHOPIFY_CLIENT_SECRET || !env.SHOPIFY_CLIENT_ID) return shopifyRedirect(env, { ihub_result: 'error', ihub_code: 'not_configured' });
    const state = req.query.get('state');
    const shop = String(req.query.get('shop') || '').toLowerCase();
    if (!state || !/^[A-Za-z0-9_-]{20,128}$/.test(state)) return shopifyRedirect(env, { ihub_result: 'error', ihub_code: 'state_invalid' });
    // التوقيع قبل أي كتابة؛ والمتجر مثبّت الطرفين قبل أي نداء له (لا رمز يذهب لمضيف آخر)
    if (!Shopify.SHOP_RE.test(shop) || !(await Shopify.verifyQueryHmac(env.SHOPIFY_CLIENT_SECRET, req.query))) {
        return shopifyRedirect(env, { ihub_result: 'error', ihub_code: 'signature_invalid' });
    }
    const st = await deps.svcRpc('ihub_svc_consume_shop_oauth_state', { p_state_hash: await sha256Hex(state), p_shop: shop });
    if (!st || st.mismatch) return shopifyRedirect(env, { ihub_result: 'error', ihub_code: 'state_invalid' });
    const code = req.query.get('code');
    if (!code || req.query.get('error')) return shopifyRedirect(env, { ihub_result: 'error', ihub_code: 'denied' });
    try {
        const tokens = await Shopify.exchangeCode({ fetch: deps.fetch, env, now: deps.now }, shop, code);
        const missing = Shopify.missingScopes(Shopify.parseScopes(tokens.scope));
        if (missing.length) {
            await deps.svcRpc('ihub_svc_record_health', { p_connection: st.connection_id, p_ok: false, p_error_code: 'forbidden_scope' });
            return shopifyRedirect(env, { ihub_result: 'error', ihub_code: 'forbidden_scope' });
        }
        const info = await Shopify.fetchShop({ fetch: deps.fetch, env, now: deps.now, externalAccountId: shop, credentials: tokens });
        if (info.domain !== shop) throw new ConnectorError('auth_failed', 'shop_changed');
        // لا تفعيل هنا (نفس تصميم سلة): النتيجة محجوزة مشفّرة، ورمز إكمال لهذا المتصفح وحده.
        const cipher = await encryptJson(env.IHUB_ENC_KEY, { tokens, shop: info }, oauthPendingAad(st.connection_id));
        const completion = randomToken(32);
        const held = await deps.svcRpc('ihub_svc_hold_oauth_result', {
            p_state_hash: await sha256Hex(state), p_pending_cipher: cipher, p_completion_hash: await sha256Hex(completion)
        });
        if (!held) return shopifyRedirect(env, { ihub_result: 'error', ihub_code: 'state_invalid' });
        return shopifyRedirect(env, {
            ihub_result: 'confirm', ihub_provider: 'shopify', ihub_connection: st.connection_id, ihub_completion: completion
        });
    } catch (err) {
        const c = errorCode(err);
        try {
            await deps.svcRpc('ihub_svc_record_health', { p_connection: st.connection_id, p_ok: false, p_error_code: c });
        } catch { /* ignore */ }
        return shopifyRedirect(env, { ihub_result: 'error', ihub_code: c });
    }
}

const REQUIRED_SCOPES_MISSING = (scopes) => Shopify.missingScopes(scopes).length > 0;

async function shopifyWebhook(deps, req) {
    const envelope = await Shopify.verifyShopifyWebhook({ env: deps.env }, { headers: req.headers, rawBody: req.rawBody });
    const evt = await invoke(CONNECTORS.shopify, 'handleWebhook', {}, envelope);
    // الامتثال إلزامي حتى لمتجر غير مربوط أو مزوّد مقفل: يُسجَّل ويُنفَّذ في القاعدة
    if (evt.compliance) {
        const c = evt.compliance;
        const r = await deps.svcRpc('ihub_svc_compliance', {
            p_topic: c.topic, p_shop: envelope.shop, p_customer_id: c.customerId, p_order_ids: c.orderIds, p_request_ref: c.requestRef
        });
        safeLog(deps.logger, 'compliance', { provider: 'shopify', topic: c.topic, status: r?.status || null });
        return json(200, { ok: true });
    }
    const found = await deps.svcRpc('ihub_svc_find_connection', { p_provider: 'shopify', p_external_account_id: envelope.shop });
    if (!found) return json(200, { ok: true, ignored: 'unknown_shop' });
    const conn = await loadConnection(deps, found.connection_id);
    if (evt.revoke) {
        await deps.svcRpc('ihub_svc_revoked_by_provider', { p_connection: found.connection_id, p_reason: 'app.uninstalled' });
        return json(200, { ok: true, revoked: true });
    }
    if (!conn?.provider_enabled) return json(200, { ok: true, ignored: 'disabled' });
    if (evt.scopes) {
        await deps.svcRpc('ihub_svc_set_shop_details', { p_connection: found.connection_id, p_scopes: evt.scopes, p_gid: null });
        if (REQUIRED_SCOPES_MISSING(evt.scopes)) {
            await deps.svcRpc('ihub_svc_record_health', { p_connection: found.connection_id, p_ok: false, p_error_code: 'forbidden_scope' });
        }
        return json(200, { ok: true });
    }
    if (evt.forget) {
        await deps.svcRpc('ihub_svc_forget_record', {
            p_connection: found.connection_id, p_record_type: evt.forget.type, p_external_id: evt.forget.id,
            p_reason: evt.topic.replace(/[^a-z_]/g, '_')
        });
        return json(200, { ok: true });
    }
    if (evt.ignored) return json(200, { ok: true, ignored: 'topic' });
    const q = await deps.svcRpc('ihub_svc_enqueue_event', {
        p_connection: found.connection_id, p_topic: evt.topic, p_dedupe_key: evt.dedupeKey,
        p_external_type: evt.externalType, p_external_id: evt.externalId, p_source_updated_at: evt.sourceUpdatedAt
    });
    safeLog(deps.logger, 'event', { provider: 'shopify', connection_id: found.connection_id, topic: evt.topic, duplicate: !!q?.duplicate });
    return json(200, { ok: true, queued: !q?.duplicate, duplicate: !!q?.duplicate });
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
        if (req.method === 'GET' && parts[0] === 'shopify' && parts.length === 2 && parts[1] === 'callback') {
            return await shopifyCallback(deps, req);
        }
        if (req.method === 'GET' && parts[0] === 'shopify' && parts.length === 2 && parts[1] === 'install') {
            return await shopifyInstall(deps, req);
        }
        if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
        if (parts[0] === 'woocommerce' && parts.length === 2) return await woocommerceWebhook(deps, parts[1], req);
        if (parts[0] === 'salla' && parts.length === 1) return await sallaWebhook(deps, req);
        if (parts[0] === 'shopify' && parts[1] === 'webhooks' && parts.length === 2) return await shopifyWebhook(deps, req);
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
