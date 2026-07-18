/**
 * sie-entitlement.js
 * ------------------------------------------------------------
 * The single client-side entry point for "is this customer allowed to use
 * the frozen SIE right now?" — used by both sie-chat-bridge.js (to gate a
 * turn) and the admin panel (to display current status). Neither caller
 * re-implements the enable/quota/expiration logic; it all lives in the
 * `customer_sie_access` table + the `sie_*` RPCs on the Supabase side
 * (see the DB design doc). This file is a thin wrapper, not a second copy
 * of that logic.
 *
 * Authorization for the admin-only calls (`adminSetAccess`,
 * `adminResetUsage`) is NOT re-checked here — it is enforced entirely by
 * `is_sie_admin()` inside the RPCs themselves (and by RLS on direct
 * reads). This file never hardcodes the support@mad3oom.online address;
 * `isCurrentUserSieAdmin()` asks the database, which is the one place
 * that check is defined.
 */

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<boolean>}
 */
export async function isCurrentUserSieAdmin(supabase) {
    try {
        const { data, error } = await supabase.rpc('is_sie_admin');
        if (error) {
            console.warn('is_sie_admin() RPC failed:', error.message);
            return false;
        }
        return data === true;
    } catch (err) {
        console.warn('is_sie_admin() RPC threw:', err?.message || err);
        return false;
    }
}

/**
 * Attempts to consume one SIE turn for a customer. This is the ONLY place
 * that increments usage — it's atomic on the database side (row locked,
 * checked, and incremented in one statement) so concurrent tabs/messages
 * can't double-spend the same quota unit.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<{allowed: boolean, reason: string|null, remaining: number|null}>}
 */
export async function tryConsumeSieMessage(supabase, userId) {
    if (!userId) return { allowed: false, reason: 'no_user', remaining: null };
    try {
        const { data, error } = await supabase.rpc('sie_consume_message', { p_user_id: userId });
        if (error) {
            console.warn('sie_consume_message() RPC failed:', error.message);
            return { allowed: false, reason: 'rpc_error', remaining: null };
        }
        const row = Array.isArray(data) ? data[0] : data;
        return {
            allowed: row?.allowed === true,
            reason: row?.reason ?? null,
            remaining: row?.remaining ?? null
        };
    } catch (err) {
        console.warn('sie_consume_message() RPC threw:', err?.message || err);
        return { allowed: false, reason: 'rpc_exception', remaining: null };
    }
}

/**
 * Read-only status for display (admin panel "usage" column, or a future
 * "you're using the smart engine, N messages left" hint in the widget).
 * Relies on the SELECT RLS policy (admin sees any row, customer sees only
 * their own) rather than a bespoke RPC.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
export async function getSieAccessStatus(supabase, userId) {
    const { data, error } = await supabase
        .from('customer_sie_access')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();
    if (error) {
        console.warn('customer_sie_access read failed:', error.message);
        return null;
    }
    return data;
}

/**
 * Admin-only: create/update a customer's SIE access. Authorization is
 * enforced inside sie_admin_set_access() via is_sie_admin() — this call
 * will simply fail with an authorization error for anyone else, exactly
 * as the profiles-table admin actions already behave elsewhere in this
 * codebase.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{userId: string, isEnabled: boolean, accessMode: 'unlimited'|'quota'|'expiration', messageQuota: number|null, expiresAt: string|null, notes: string|null}} params
 */
export async function adminSetAccess(supabase, { userId, isEnabled, accessMode, messageQuota, expiresAt, notes }) {
    return supabase.rpc('sie_admin_set_access', {
        p_user_id: userId,
        p_is_enabled: isEnabled,
        p_access_mode: accessMode,
        p_message_quota: messageQuota,
        p_expires_at: expiresAt,
        p_notes: notes
    });
}

/** Admin-only: zero out messages_used for a customer (e.g. new billing period). */
export async function adminResetUsage(supabase, userId) {
    return supabase.rpc('sie_admin_reset_usage', { p_user_id: userId });
}
