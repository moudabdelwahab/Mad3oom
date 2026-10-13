// ============================================================================
// worker.js — integrations-worker (verify_jwt = false + سر داخلي).
//
// يُستدعى دوريًا (pg_cron + pg_net، خطوة نشر موثقة — لا يجدوله 087):
//   1) الأحداث الفاشلة المستحقة: يجلب السجل من المزوّد (لا حمولة مخزنة) ويطبّقه،
//      أو يسجّل الفشل بمهلة متزايدة حتى dead.
//   2) رموز سلة التي تنتهي خلال يومين: يجدّدها. العامل هو **الكاتب الوحيد**
//      لتجديد الرموز، فلا يتسابق تجديدان على refresh token لمرة واحدة.
//
// المصادقة: ترويسة x-ihub-worker-secret مقارنةً ثابتة الزمن بـ IHUB_WORKER_SECRET.
// غياب السر في البيئة = 503 (يفشل مغلقًا).
// ============================================================================

import { CONNECTORS, loadConnection, storeCredentials, connectorContext, FETCH_OPERATION } from './registry.js';
import { invoke, supports } from './contract.js';
import { errorCode, ConnectorError } from './errors.js';
import { timingSafeEqual } from './crypto.js';
import { safeLog } from './redact.js';

export async function retryDueEvents(deps, limit = 20) {
    const due = (await deps.svcRpc('ihub_svc_claim_due_events', { p_limit: limit })) || [];
    let processed = 0;
    let failed = 0;
    for (const e of due) {
        try {
            const connector = CONNECTORS[e.provider];
            const op = FETCH_OPERATION[e.external_type];
            if (!connector || !op || !supports(connector, op)) throw new ConnectorError('unsupported');
            const conn = await loadConnection(deps, e.connection_id);
            if (!conn?.credentials || !conn.provider_enabled) throw new ConnectorError('not_configured');
            const record = await invoke(connector, op, connectorContext(deps, conn), e.external_id);
            await deps.svcRpc('ihub_svc_apply_record', {
                p_connection: e.connection_id, p_record_type: record.record_type, p_external_id: record.external_id,
                p_display_ref: record.display_ref, p_summary: record.summary, p_external_url: record.external_url,
                p_source_updated_at: record.source_updated_at, p_event_id: e.id, p_create: false
            });
            processed++;
        } catch (err) {
            const code = errorCode(err);
            const retry = !['unsupported', 'invalid_input', 'not_found', 'auth_failed', 'forbidden_scope', 'token_expired'].includes(code);
            await deps.svcRpc('ihub_svc_event_failed', { p_event: e.id, p_error_code: code, p_retry: retry });
            if (['auth_failed', 'token_expired', 'forbidden_scope'].includes(code)) {
                await deps.svcRpc('ihub_svc_record_health', { p_connection: e.connection_id, p_ok: false, p_error_code: code });
            }
            failed++;
        }
    }
    return { claimed: due.length, processed, failed };
}

export async function refreshDueTokens(deps) {
    const due = (await deps.svcRpc('ihub_svc_tokens_due', { p_within_seconds: 2 * 24 * 3600 })) || [];
    let refreshed = 0;
    let failed = 0;
    for (const d of due) {
        const connector = CONNECTORS[d.provider];
        if (!connector || !supports(connector, 'refreshCredentials')) continue;
        try {
            const conn = await loadConnection(deps, d.connection_id);
            if (!conn?.credentials) continue;
            const tokens = await invoke(connector, 'refreshCredentials', connectorContext(deps, conn));
            await storeCredentials(deps, d.connection_id, d.provider, tokens, tokens.expires_at);
            await deps.svcRpc('ihub_svc_audit', { p_connection: d.connection_id, p_actor: null, p_actor_kind: 'system',
                                                  p_action: 'token.refreshed', p_detail: {} });
            refreshed++;
        } catch (err) {
            const code = errorCode(err);
            await deps.svcRpc('ihub_svc_record_health', { p_connection: d.connection_id, p_ok: false, p_error_code: code });
            failed++;
        }
    }
    return { due: due.length, refreshed, failed };
}

export async function handleWorker(deps, headers) {
    const expected = deps.env.IHUB_WORKER_SECRET;
    if (!expected || String(expected).length < 32) return { status: 503, body: { error: 'not_configured' } };
    if (!timingSafeEqual(headers.get('x-ihub-worker-secret') || '', expected)) return { status: 401, body: { error: 'unauthorized' } };
    try {
        const events = await retryDueEvents(deps);
        const tokens = await refreshDueTokens(deps);
        safeLog(deps.logger, 'worker', { count: events.claimed + tokens.due });
        return { status: 200, body: { ok: true, events, tokens } };
    } catch (err) {
        safeLog(deps.logger, 'worker_error', { code: errorCode(err) });
        return { status: 500, body: { error: 'internal_error' } };
    }
}
