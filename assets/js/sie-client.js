/**
 * sie-client.js
 * ------------------------------------------------------------
 * Mad3oom Core's ONLY point of contact with the Support Intelligence
 * Engine (SIE). SIE is now a fully independent product hosted at
 * https://sie.mad3oom.com — it is no longer embedded in this
 * repository (the old local `/sie` and `/sie-integration` folders have
 * been removed).
 *
 * Per the platform's architecture rules, Mad3oom must never import SIE
 * source code, and every interaction with SIE must go through public
 * HTTP APIs. This file is that boundary: every exported function here
 * is a thin, resilient wrapper around a `fetch()` call to
 * SIE_API_BASE_URL. Nothing else in this codebase should talk to SIE
 * directly — always go through this module, the same way every other
 * external integration in this project goes through its own thin
 * client (see api-config.js's supabaseRestFetch for the same pattern).
 *
 * Every function fails CLOSED and never throws: if SIE is unreachable,
 * slow, misconfigured, or returns something unexpected, callers get a
 * safe default (false/null/an error object) instead of an exception —
 * so the rest of the platform (chat, tickets, dashboard, admin, auth...)
 * keeps working exactly as before, with zero impact on customers who
 * aren't using SIE. A short request timeout (see `withTimeout`) is what
 * prevents a slow/down SIE from ever hanging the UI in a permanent
 * loading state.
 *
 * The function names and parameter/return shapes intentionally mirror
 * the old local module's public API (isCurrentUserSieAdmin,
 * getSieAccessStatus, adminSetAccess, adminResetUsage, getSieReply) so
 * every existing caller (chatbot-mode-service.js, admin/users.js,
 * chat-logic.js, chat-widget.js) needed only an import-path change, not
 * a rewrite — this keeps the decoupling a pure refactor with zero
 * functional regressions.
 */

/** Base URL of the independent SIE service. The single place this ever changes. */
export const SIE_API_BASE_URL = 'https://sie.mad3oom.com';

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Wraps fetch() with an abort-based timeout so a slow/unreachable SIE
 * can never leave the caller (and therefore the UI) hanging forever.
 */
async function withTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

/** Current Supabase access token, if any — forwarded to SIE so it can identify the caller. */
async function getAccessToken(supabase) {
    try {
        const { data } = await supabase.auth.getSession();
        return data?.session?.access_token || null;
    } catch (err) {
        console.warn('[sie-client] تعذّر جلب جلسة المستخدم الحالية:', err?.message || err);
        return null;
    }
}

async function sieFetch(supabase, path, { method = 'GET', body, timeoutMs } = {}) {
    const token = await getAccessToken(supabase);
    const headers = { ...(body ? { 'Content-Type': 'application/json' } : {}) };
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await withTimeout(
        `${SIE_API_BASE_URL}${path}`,
        { method, headers, body: body ? JSON.stringify(body) : undefined },
        timeoutMs
    );

    let payload = null;
    try {
        payload = await response.json();
    } catch {
        payload = null;
    }

    if (!response.ok) {
        const message = payload?.error || payload?.message || `SIE request failed (${response.status})`;
        throw new Error(message);
    }

    return payload;
}

// ===================== Entitlement / Admin API =====================

/**
 * هل المستخدم الحالي (حسب الـ token المُرسَل) أدمن معتمَد لدى SIE؟ يحل محل
 * الاستدعاء المحلي القديم لـ is_sie_admin() RPC. Fail closed: أي خطأ
 * (شبكة، SIE غير متاح، غير مصرّح) يرجّع false بدل ما يكسر صفحة المستخدمين.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<boolean>}
 */
export async function isCurrentUserSieAdmin(supabase) {
    try {
        const data = await sieFetch(supabase, '/api/v1/admin/is-admin', { timeoutMs: 6000 });
        return data?.isAdmin === true;
    } catch (err) {
        console.warn('[sie-client] تعذّر التحقق من صلاحية أدمن SIE:', err?.message || err);
        return false;
    }
}

/**
 * يجيب حالة وصول عميل معيّن لمحرك SIE (مفعّل؟ نوع الحد؟ الاستخدام؟...).
 * يحل محل القراءة المباشرة القديمة لجدول customer_sie_access. يرجّع null
 * عند أي فشل أو عدم وجود صف، بنفس سلوك النسخة المحلية القديمة.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<Object|null>}
 */
export async function getSieAccessStatus(supabase, userId) {
    if (!userId) return null;
    try {
        const data = await sieFetch(supabase, `/api/v1/access/${encodeURIComponent(userId)}`, { timeoutMs: 6000 });
        return data?.access ?? data ?? null;
    } catch (err) {
        console.warn('[sie-client] تعذّر جلب حالة وصول SIE:', err?.message || err);
        return null;
    }
}

/**
 * إعداد/تحديث وصول عميل لمحرك SIE (أدمن فقط). يحل محل sie_admin_set_access() RPC.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{userId: string, isEnabled: boolean, accessMode: string, messageQuota: number|null, expiresAt: string|null, notes: string|null}} params
 * @returns {Promise<{error: Error|null}>}
 */
export async function adminSetAccess(supabase, { userId, isEnabled, accessMode, messageQuota, expiresAt, notes }) {
    try {
        await sieFetch(supabase, '/api/v1/admin/access', {
            method: 'POST',
            body: {
                userId,
                isEnabled,
                accessMode,
                messageQuota,
                expiresAt,
                notes
            },
            timeoutMs: 10000
        });
        return { error: null };
    } catch (err) {
        return { error: err instanceof Error ? err : new Error(String(err)) };
    }
}

/**
 * تصفير عداد الاستخدام لعميل معيّن (أدمن فقط). يحل محل sie_admin_reset_usage() RPC.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<{error: Error|null}>}
 */
export async function adminResetUsage(supabase, userId) {
    try {
        await sieFetch(supabase, '/api/v1/admin/access/reset-usage', {
            method: 'POST',
            body: { userId },
            timeoutMs: 10000
        });
        return { error: null };
    } catch (err) {
        return { error: err instanceof Error ? err : new Error(String(err)) };
    }
}

// ===================== Chat reply API =====================

/**
 * يطلب رد محادثة من محرك SIE الخارجي لرسالة عميل واحدة. يحل محل الـ
 * pipeline المحلي القديم (Language -> Diagnostics -> Ranking -> Decision
 * -> Knowledge -> Dialogue -> Action) اللي كان جوه هذا المشروع.
 *
 * ملحوظة معمارية مهمة: بما إن SIE بقى خدمة مستقلة تمامًا ومالوش وصول
 * مباشر لقاعدة بيانات مدعوم، الرد بتاعه بيرجع كبيانات فقط (نص + خيارات +
 * bot_state جديدة) - الكتابة الفعلية في chat_messages/chat_sessions
 * لسه مسؤولية الطبقة اللي بتنده الدالة دي (chat-logic.js / chat-widget.js)،
 * بالظبط زي ما بيحصل مع getBotReply() المحلي التقليدي. مفيش أي كتابة على
 * قاعدة بيانات مدعوم بتحصل من جوه هذا الملف.
 *
 * @param {Object} params
 * @param {string} params.text
 * @param {import('@supabase/supabase-js').SupabaseClient} params.supabase
 * @param {string} params.sessionId
 * @param {string} params.userId
 * @param {*} params.botState - آخر bot_state معروفة لهذه الجلسة
 * @returns {Promise<{reply: string, options: Array<{label:string,value:string}>, botState: *}|null>}
 *   null يعني تعذّر الحصول على رد (شبكة/SIE غير متاح/خطأ) — الـ caller بيتعامل
 *   معاها كـ"مشكلة مؤقتة" ولا يفترض نجاح صامت.
 */
export async function getSieReply({ text, supabase, sessionId, userId, botState }) {
    if (!text || !supabase || !sessionId || !userId) return null;
    try {
        const data = await sieFetch(supabase, '/api/v1/chat/reply', {
            method: 'POST',
            body: { text, sessionId, userId, botState: botState || {} },
            timeoutMs: 15000
        });

        if (!data || typeof data.reply !== 'string') return null;
        return {
            reply: data.reply,
            options: Array.isArray(data.options) ? data.options : [],
            botState: data.botState ?? botState ?? {}
        };
    } catch (err) {
        console.warn('[sie-client] تعذّر الحصول على رد من محرك SIE الخارجي:', err?.message || err);
        return null;
    }
}
