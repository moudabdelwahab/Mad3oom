/**
 * observability-read-port.supabase.js
 * ------------------------------------------------------------
 * Real, thin implementation of the observability read port, reading a
 * stored conversation's customer messages back out of chat_messages
 * (the same table the Action Layer writes bot messages into — this is
 * the one module allowed to READ it back for historical replay; see
 * observability-read-port.js for why this lives here and not in
 * action/).
 *
 * NEVER INVOKED BY ANY TEST in this project — only
 * tests/helpers/fake-read-port.js is exercised. This file exists so the
 * real wiring is written and reviewable now; connecting it to live
 * traffic is a separate, explicit future integration step.
 */
import { createObservabilityReadPort } from './observability-read-port.js';

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
 * @returns {import('./observability-read-port.js')}
 */
export function createObservabilityReadSupabasePort(supabaseClient) {
    return createObservabilityReadPort(async (sessionId) => {
        const { data, error } = await supabaseClient
            .from('chat_messages')
            .select('turn, text')
            .eq('session_id', sessionId)
            .eq('sender', 'customer')
            .order('turn', { ascending: true });

        if (error) {
            throw new Error(`Failed to load conversation from Supabase: ${error.message}`);
        }
        if (!data || data.length === 0) return null;

        return {
            sessionId,
            turns: data.map((row) => ({ turn: row.turn, rawText: row.text }))
        };
    });
}
