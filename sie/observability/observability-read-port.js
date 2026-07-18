/**
 * observability-read-port.js
 * ------------------------------------------------------------
 * Provider INTERFACE for reading historical conversations — the one
 * new read path in the whole engine, and deliberately scoped narrowly:
 * this is different from the Action Layer (Module 8, write-only) and
 * from Module 3's live-evidence provider (per-customer LIVE lookups
 * during an in-progress conversation). This port reads ALREADY-
 * FINISHED turns of a stored conversation back out of chat_messages,
 * for Replay/Shadow Run purposes only. It lives inside observability/,
 * not action/, keeping "Action Layer is the only writer" intact while
 * being explicit that this is the only module with any Supabase read
 * access to historical data.
 *
 * Same "interface + stub (not wired to Supabase yet) + separate real
 * implementation (untested)" pattern as every other provider in this
 * project. observability-read-port.stub.js is what's actually wired up
 * right now; Replay Engine tests inject a fixture-backed fake instead
 * (tests/helpers/fake-read-port.js), the same way every other module's
 * tests inject an fs-based real provider instead of a fetch-based
 * .local.js default.
 */

/**
 * @typedef {Object} StoredTurn
 * @property {number} turn
 * @property {string} rawText - the customer's raw message text
 *
 * @typedef {Object} StoredConversation
 * @property {string} sessionId
 * @property {StoredTurn[]} turns - ordered ascending by turn
 */

/**
 * Creates an observability read port around a given async fetch
 * function. Resilient by design: a lookup failure degrades to "not
 * found" (null) rather than throwing, since Replay/Shadow Run should
 * skip a conversation it can't read rather than aborting an entire
 * batch over one bad session.
 *
 * @param {(sessionId: string) => Promise<StoredConversation|null>} fetchFn
 * @returns {{ getConversation: (sessionId: string) => Promise<StoredConversation|null> }}
 */
export function createObservabilityReadPort(fetchFn) {
    async function getConversation(sessionId) {
        try {
            const result = await fetchFn(sessionId);
            if (!result || !Array.isArray(result.turns)) return null;
            return result;
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[observability-read-port] lookup failed, treating as not found:', err?.message || err);
            return null;
        }
    }
    return { getConversation };
}
