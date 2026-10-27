/**
 * index.remote.ts — the variant actually deployed to Supabase
 * ------------------------------------------------------------
 * نفس منطق index.ts، بس بيستورد الكود من CDN بدل ما يكون متجمّع جوه
 * الدالة. ده اللي منشور فعلاً دلوقتي.
 *
 * ------------------------------------------------------------
 * WHY TWO ENTRYPOINTS
 *
 * `index.ts` imports the engine with relative paths — the right shape for
 * `supabase functions deploy` from a checkout, where the CLI walks the
 * graph off local disk.
 *
 * It is NOT deployable through the management API, which takes files as
 * literal arguments: the graph is 65 modules and ~1 MB, dominated by the
 * engine's 580 KB of scenario and glossary data.
 *
 * ------------------------------------------------------------
 * STATIC REMOTE IMPORTS, NOT DYNAMIC
 *
 * Supabase resolves the module graph at DEPLOY time (eszip), which makes
 * the import FORM decisive. Verified against this project, not assumed:
 *
 *   dynamic  await import(`${base}/x.js`)   -> WORKER_ERROR on boot. The
 *                                             URL is only known at runtime,
 *                                             so it was never bundled.
 *   static   import { x } from 'https://…'  -> fetched and inlined at
 *                                             deploy. Works.
 *
 * Two consequences, which are why this works at all:
 *
 *   1. eszip preserves the specifier, so `import.meta.url` inside every
 *      engine module stays an https URL — and the data loaders, which do
 *      `fetch(new URL('./data/x.json', import.meta.url))`, resolve to the
 *      CDN at runtime. Confirmed live: catalog_size 383.
 *   2. Deno caches a remote graph per isolate, so the ~1 MB is fetched on
 *      cold start only.
 *
 * Pinned to a COMMIT, not a branch: a branch would mean every push
 * silently redeploys the engine underneath a running function. Upgrading
 * is deliberate — change the SHA, deploy again. It cannot come from an
 * environment variable for the same reason a dynamic import cannot: the
 * value has to exist at deploy time.
 *
 * ------------------------------------------------------------
 * KEEPING THE TWO IN STEP
 *
 * Everything below the imports is identical to index.ts and must stay so.
 * A difference between them is a bug that only appears in production.
 *
 * ENVIRONMENT
 *   TELEGRAM_BOT_TOKEN        the bot's API token
 *   TELEGRAM_WEBHOOK_SECRET   optional; falls back to channel_secrets
 *   SUPABASE_URL              injected by the platform
 *   SUPABASE_SERVICE_ROLE_KEY injected by the platform
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { callerHas } from '../_shared/caller-authority.js';

import { handleInbound } from 'https://cdn.jsdelivr.net/gh/moudabdelwahab/sie@8252e5774529196b323d72932df8b43c09f9cdbe/channels/core/channel-adapter.js';
import { createTelegramAdapter } from 'https://cdn.jsdelivr.net/gh/moudabdelwahab/sie@8252e5774529196b323d72932df8b43c09f9cdbe/channels/telegram/telegram-adapter.js';
import { createInProcessSieClient } from 'https://cdn.jsdelivr.net/gh/moudabdelwahab/sie@8252e5774529196b323d72932df8b43c09f9cdbe/channels/core/sie-client.js';
import { createSessionStore } from 'https://cdn.jsdelivr.net/gh/moudabdelwahab/sie@8252e5774529196b323d72932df8b43c09f9cdbe/channels/core/channel-session.js';
import { createIdentityResolver } from 'https://cdn.jsdelivr.net/gh/moudabdelwahab/sie@8252e5774529196b323d72932df8b43c09f9cdbe/channels/core/channel-identity.js';
import { createEntitlementExplainer } from 'https://cdn.jsdelivr.net/gh/moudabdelwahab/sie@8252e5774529196b323d72932df8b43c09f9cdbe/channels/core/channel-entitlement.js';
import { createMemoryDeduplicator } from 'https://cdn.jsdelivr.net/gh/moudabdelwahab/sie@8252e5774529196b323d72932df8b43c09f9cdbe/channels/core/delivery.js';
import { createLogger } from 'https://cdn.jsdelivr.net/gh/moudabdelwahab/sie@8252e5774529196b323d72932df8b43c09f9cdbe/channels/core/logger.js';
import { getSieReply, getSieAccessStatus, evaluateSieAccessRow, listActiveScenarios } from 'https://cdn.jsdelivr.net/gh/moudabdelwahab/sie@8252e5774529196b323d72932df8b43c09f9cdbe/sie-integration/sie-runtime.js';

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/sie-channel-telegram`;

const logger = createLogger('telegram');

/**
 * The service-role client. Correct here and nowhere else in SIE: there is
 * no user session to forward, because the person is on Telegram. Trust
 * comes from the webhook secret plus an active channel_identities row, and
 * every write passes an explicit user_id resolved from that row rather
 * than relying on auth.uid().
 */
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
});

async function readSecret(key: string): Promise<string> {
    const { data, error } = await supabase
        .from('channel_secrets').select('value').eq('key', key).maybeSingle();
    if (error) {
        logger.error('could not read a channel secret', { key, error: error.message });
        return '';
    }
    return data?.value ?? '';
}

/**
 * The environment variable wins when set — it is the better home for a
 * shared secret. The table exists so the channel can be brought up without
 * CLI access, not to replace it.
 *
 * Resolved once at boot: a per-request read would put a database round trip
 * in front of every customer message for a value that changes never.
 */
const WEBHOOK_SECRET = Deno.env.get('TELEGRAM_WEBHOOK_SECRET')
    || await readSecret('telegram_webhook_secret');

// Built once per instance, not per request: the deduplicator's whole
// purpose is remembering across the requests of one warm instance.
const adapter = createTelegramAdapter({
    botToken: BOT_TOKEN,
    secretToken: WEBHOOK_SECRET,
    logger
});

const sessions = createSessionStore({ supabase, logger });

const deps = {
    logger,
    sieClient: createInProcessSieClient({ supabase, sessions, getSieReply, logger }),
    identity: createIdentityResolver({ supabase, logger }),
    entitlement: createEntitlementExplainer({ supabase, getSieAccessStatus, evaluateSieAccessRow, logger }),
    dedupe: createMemoryDeduplicator()
};

/**
 * Is this caller a signed-in platform admin?
 *
 * The self-check below reports operational state — bot username, the live
 * webhook URL, Telegram's last delivery error, and how many customer chats
 * are linked — and it can re-point the bot's webhook. None of that may be
 * readable or triggerable anonymously, so GET now carries the same bar the
 * rest of the admin surface uses: a real session the database considers an
 * admin — is_admin(), which also covers the platform owner inside the
 * owner/admin context (115). No new role was introduced.
 */
async function isAdminCaller(req: Request): Promise<boolean> {
    const authHeader = req.headers.get('authorization') ?? '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '');
    if (!jwt) return false;

    try {
        const { data, error } = await supabase.auth.getUser(jwt);
        if (error || !data?.user) return false;

        // is_admin() بجلسة المنادي: الأدمن، أو مالك المنصة في سياق owner/admin (115)
        return await callerHas('is_admin', authHeader);
    } catch (err) {
        logger.error('admin check failed', { error: err instanceof Error ? err.message : String(err) });
        return false;
    }
}

/**
 * Registers this function as the bot's webhook, once.
 *
 * Gated on a database flag rather than running on every cold start, so a
 * restart can never silently repoint a webhook someone configured by hand.
 * The flag is cleared on success, which makes this genuinely one-time.
 *
 * Only ever reached from an authenticated admin GET — before, any anonymous
 * request could trigger it during the window where the flag was 'true'.
 */
async function autoRegisterWebhook(stages: Record<string, unknown>): Promise<void> {
    const flag = await readSecret('telegram_autoregister');
    if (flag !== 'true') return;
    if (!BOT_TOKEN || !WEBHOOK_SECRET) {
        stages.autoregister = 'skipped: bot token or webhook secret missing';
        return;
    }

    try {
        const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: FUNCTION_URL,
                secret_token: WEBHOOK_SECRET,
                // Only what this channel handles, so Telegram does not wake
                // the function for reactions and member changes.
                allowed_updates: ['message', 'edited_message'],
                // Anything queued while no webhook was set is stale; replying
                // would answer questions asked hours ago.
                drop_pending_updates: true
            })
        });
        const body = await response.json();
        stages.autoregister = body?.ok ? 'registered' : `failed: ${body?.description ?? response.status}`;

        if (body?.ok) {
            await supabase.from('channel_secrets')
                .update({ value: 'false', updated_at: new Date().toISOString() })
                .eq('key', 'telegram_autoregister');
        }
    } catch (err) {
        logger.error('autoregister threw', { error: err instanceof Error ? err.message : String(err) });
        stages.autoregister = 'failed: see function logs';
    }
}

/**
 * GET / — فحص ذاتي لكل مرحلة في المسار. للأدمن فقط.
 *
 * Every stage between "Telegram called us" and "the customer got a reply"
 * can fail silently, and from outside they all look identical: no reply.
 * This runs each one, so a single URL answers "where does it stop".
 *
 * Reports only whether each secret is PRESENT, never a value — and never an
 * exception message either. CodeQL flagged the self-check response as
 * "information exposure through a stack trace": caught errors were being
 * interpolated straight into the JSON body. The stage still reports WHICH step
 * failed, which is the whole diagnostic value; the detail goes to the logs.
 */
async function selfCheck(): Promise<Record<string, unknown>> {
    const stages: Record<string, unknown> = {
        env_bot_token: Boolean(BOT_TOKEN),
        webhook_secret_resolved: Boolean(WEBHOOK_SECRET),
        webhook_secret_source: Deno.env.get('TELEGRAM_WEBHOOK_SECRET') ? 'env' : 'database',
        env_supabase_url: Boolean(SUPABASE_URL),
        env_service_role_key: Boolean(SERVICE_ROLE_KEY)
    };

    await autoRegisterWebhook(stages);

    // Does the engine's data load in this runtime? The single most likely
    // deployment failure, and invisible from outside.
    try {
        const scenarios = await listActiveScenarios();
        stages.engine_loaded = true;
        stages.catalog_size = scenarios.length;
        stages.catalog_ok = scenarios.length > 0;
    } catch (err) {
        stages.engine_loaded = false;
        logger.error('engine load threw', { error: err instanceof Error ? err.message : String(err) });
        stages.engine_error = 'see function logs';
    }

    // Can we read the linking table? Without it every chat looks unlinked.
    try {
        const { count, error } = await supabase
            .from('channel_identities')
            .select('*', { count: 'exact', head: true })
            .eq('channel', 'telegram');
        stages.identity_table = !error;
        stages.linked_telegram_chats = error ? null : count;
        if (error) {
            logger.error('identity table read failed', { error: error.message });
            stages.identity_error = 'see function logs';
        }
    } catch (err) {
        stages.identity_table = false;
        logger.error('identity table threw', { error: err instanceof Error ? err.message : String(err) });
        stages.identity_error = 'see function logs';
    }

    // Is the webhook registered, and did Telegram's last call succeed?
    // Telegram remembers exactly why it last failed, which is usually the
    // whole answer.
    if (BOT_TOKEN) {
        try {
            const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
            const body = await response.json();
            stages.webhook_registered = Boolean(body?.result?.url);
            stages.webhook_url = body?.result?.url ?? null;
            stages.webhook_points_here = body?.result?.url === FUNCTION_URL;
            stages.webhook_pending = body?.result?.pending_update_count ?? 0;
            stages.webhook_last_error = body?.result?.last_error_message ?? null;

            const me = await (await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`)).json();
            stages.bot_username = me?.result?.username ?? null;
        } catch (err) {
            stages.webhook_registered = null;
            logger.error('getWebhookInfo threw', { error: err instanceof Error ? err.message : String(err) });
            stages.webhook_error = 'see function logs';
        }
    }

    return stages;
}

Deno.serve(async (req: Request) => {
    // The self-check is a GET so it can be opened in a browser; the webhook
    // is always a POST, so the two cannot be confused.
    //
    // GET is admin-only. It reports operational state and can re-register the
    // webhook, so an anonymous caller must learn nothing and change nothing —
    // including whether this deployment exists in a useful state.
    if (req.method === 'GET') {
        if (!await isAdminCaller(req)) {
            return new Response(JSON.stringify({ error: 'unauthorized' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        const stages = await selfCheck();
        return new Response(JSON.stringify({ ok: true, stages }, null, 2), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    if (req.method !== 'POST') {
        return new Response('method not allowed', { status: 405 });
    }

    // A missing secret means the deployment is misconfigured. Fail loudly
    // and closed rather than accepting unauthenticated updates.
    if (!BOT_TOKEN || !WEBHOOK_SECRET) {
        logger.error('the function has no bot token or no webhook secret');
        return new Response('misconfigured', { status: 500 });
    }

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        // Not JSON: not Telegram, and no retry will change that.
        return new Response('ok', { status: 200 });
    }

    try {
        const result = await handleInbound({
            adapter,
            request: { headers: req.headers, body, url: req.url },
            deps
        });

        if (result.status === 'unverified') {
            // The one case worth a non-200: this is not Telegram, so there
            // is no redelivery to worry about.
            return new Response('unauthorized', { status: 401 });
        }

        return new Response('ok', { status: 200 });
    } catch (err) {
        // Telegram retries any non-2xx for up to 24 hours, and a retry of a
        // message we already answered charges the customer twice. So
        // failures are reported in logs, not in the status code.
        logger.error('the webhook threw', { error: err instanceof Error ? err.message : String(err) });
        return new Response('ok', { status: 200 });
    }
});
