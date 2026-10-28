// ============================================================================
// worker.js — integrations-worker (verify_jwt = false + سر داخلي).
//
// يُستدعى دوريًا (pg_cron + pg_net، خطوة نشر موثقة — لا يجدوله 088):
//   1) الأحداث الفاشلة المستحقة: يجلب السجل من المزوّد (لا حمولة مخزنة) ويطبّقه،
//      أو يسجّل الفشل بمهلة متزايدة حتى dead.
//   2) رموز سلة التي تنتهي خلال يومين: يجدّدها. العامل هو **الكاتب الوحيد**
//      لتجديد الرموز، فلا يتسابق تجديدان على refresh token لمرة واحدة.
//      (Shopify: الرمز ساعة واحدة ويُجدَّد عند الحاجة بقفل في القاعدة — shopify-session.js.)
//   3) Shopify: المطابقة الدورية (مهمة تزايدية كل 6 ساعات) ثم مهام المزامنة المستحقة، بحد زمني
//      للدورة (pg_net ينتظر 30 ثانية) واحترام سطل التكلفة: ما لا يكتمل يعود للطابور بمؤشره.
//
// المصادقة: ترويسة x-ihub-worker-secret مقارنةً ثابتة الزمن بـ IHUB_WORKER_SECRET.
// غياب السر في البيئة = 503 (يفشل مغلقًا).
// ============================================================================

import { CONNECTORS, loadConnection, storeCredentials, connectorContext, FETCH_OPERATION } from './registry.js';
import { contextFor } from './shopify-session.js';
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
            const record = await invoke(connector, op, contextFor(deps, conn), e.external_id);
            await deps.svcRpc('ihub_svc_apply_record', {
                p_connection: e.connection_id, p_record_type: record.record_type, p_external_id: record.external_id,
                p_display_ref: record.display_ref, p_summary: record.summary, p_external_url: record.external_url,
                p_source_updated_at: record.source_updated_at, p_event_id: e.id,
                // Shopify: طلبات المتجر تُخزَّن من الحدث (نافذة 30 يومًا)؛ العميل والمنتج يُحدَّثان إن وُجدا فقط
                p_create: e.provider === 'shopify' && e.external_type === 'order'
            });
            processed++;
        } catch (err) {
            const code = errorCode(err);
            // Shopify: سجل لم يعد موجودًا (حُذف أو خارج نافذة 60 يومًا) ليس فشلًا يستحق الإعادة
            if (e.provider === 'shopify' && code === 'not_found') {
                await deps.svcRpc('ihub_svc_event_ignored', { p_event: e.id, p_code: code });
                continue;
            }
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
        // Shopify يُجدَّد عند الحاجة بقفل (shopify-session.js)، لا كل دورة: كل تجديد يبدّل رمز التجديد
        if (!connector || !supports(connector, 'refreshCredentials') || d.provider === 'shopify') continue;
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

const SYNC_BUDGET_MS = 20_000;
const SYNC_MAX_PAGES = 8;
const NON_RETRY = new Set(['unsupported', 'invalid_input', 'auth_failed', 'forbidden_scope', 'token_expired', 'not_configured',
                           'invalid_response']);

/** مهام مزامنة Shopify المستحقة: صفحات بحد زمني، والمتبقي يعود للطابور بمؤشره. */
export async function runSyncJobs(deps, { budgetMs = SYNC_BUDGET_MS } = {}) {
    const started = deps.now();
    const scheduled = Number(await deps.svcRpc('ihub_svc_schedule_reconciliation', { p_max_age_minutes: 360 })) || 0;
    const jobs = (await deps.svcRpc('ihub_svc_claim_sync_jobs', { p_limit: 3 })) || [];
    const out = { scheduled, claimed: jobs.length, pages: 0, records: 0, finished: 0, yielded: 0, failed: 0 };
    for (const job of jobs) {
        let cursor = job.cursor || null;
        try {
            const conn = await loadConnection(deps, job.connection_id);
            if (!conn?.credentials || !conn.provider_enabled) throw new ConnectorError('not_configured');
            const ctx = contextFor(deps, conn);
            let pages = 0;
            for (;;) {
                const page = await invoke(CONNECTORS.shopify, 'syncRecords', ctx, { since: job.since_at, cursor });
                for (const r of page.records) {
                    await deps.svcRpc('ihub_svc_apply_record', {
                        p_connection: job.connection_id, p_record_type: r.record_type, p_external_id: r.external_id,
                        p_display_ref: r.display_ref, p_summary: r.summary, p_external_url: r.external_url,
                        p_source_updated_at: r.source_updated_at, p_event_id: null, p_create: true
                    });
                }
                cursor = page.cursor;
                pages++;
                out.pages++;
                out.records += page.records.length;
                const alive = await deps.svcRpc('ihub_svc_sync_progress', {
                    p_job: job.id, p_cursor: page.hasNext ? cursor : null, p_records: page.records.length, p_high_water: page.highWater
                });
                if (!alive) break;                                             // أُلغيت (فصل الربط)
                if (!page.hasNext) {
                    await deps.svcRpc('ihub_svc_sync_finish', { p_job: job.id, p_outcome: 'succeeded' });
                    out.finished++;
                    break;
                }
                if (page.wait > 0 || pages >= SYNC_MAX_PAGES || deps.now() - started > budgetMs) {
                    await deps.svcRpc('ihub_svc_sync_finish', { p_job: job.id, p_outcome: 'yield', p_delay_seconds: Math.max(page.wait, 5) });
                    out.yielded++;
                    break;
                }
            }
        } catch (err) {
            const code = errorCode(err);
            if (code === 'rate_limited') {
                await deps.svcRpc('ihub_svc_sync_finish', { p_job: job.id, p_outcome: 'yield', p_delay_seconds: err.retryAfter || 30 });
                out.yielded++;
            } else {
                await deps.svcRpc('ihub_svc_sync_finish', { p_job: job.id, p_outcome: 'failed', p_error_code: code, p_retry: !NON_RETRY.has(code) });
                if (['auth_failed', 'token_expired', 'forbidden_scope'].includes(code)) {
                    await deps.svcRpc('ihub_svc_record_health', { p_connection: job.connection_id, p_ok: false, p_error_code: code });
                }
                out.failed++;
            }
        }
        if (deps.now() - started > budgetMs) break;
    }
    return out;
}

export async function handleWorker(deps, headers) {
    const expected = deps.env.IHUB_WORKER_SECRET;
    if (!expected || String(expected).length < 32) return { status: 503, body: { error: 'not_configured' } };
    if (!timingSafeEqual(headers.get('x-ihub-worker-secret') || '', expected)) return { status: 401, body: { error: 'unauthorized' } };
    try {
        const events = await retryDueEvents(deps);
        const tokens = await refreshDueTokens(deps);
        const sync = await runSyncJobs(deps);
        safeLog(deps.logger, 'worker', { count: events.claimed + tokens.due + sync.claimed });
        return { status: 200, body: { ok: true, events, tokens, sync } };
    } catch (err) {
        safeLog(deps.logger, 'worker_error', { code: errorCode(err) });
        return { status: 500, body: { error: 'internal_error' } };
    }
}
