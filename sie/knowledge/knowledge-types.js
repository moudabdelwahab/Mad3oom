/**
 * knowledge-types.js
 * ------------------------------------------------------------
 * Shapes for the Knowledge Layer (Module 7): the two kinds of "real
 * data" that can complete an ANSWER whose resolution declares a
 * `knowledgeSource` (Module 2's scenario-types.js field):
 *
 *   - StaticKnowledgeEntry — genuinely static content (pricing,
 *     platform info) that's still content-managed rather than
 *     hardcoded inline, so it can be edited without touching the
 *     Scenario catalog or any code. Same "human-edited, forgiving
 *     validate-and-skip" posture as Module 2's scenario-types.js.
 *   - LiveKnowledgeResult — per-customer data (ticket status,
 *     subscription status) that cannot be static because it differs
 *     per customer and changes over time. Same "produced internally,
 *     lightweight sanity guard" posture as Module 3's evidence-types.js.
 *
 * @typedef {Object} LocalizedText
 * @property {string} ar
 * @property {string} en
 *
 * @typedef {Object} StaticKnowledgeEntry
 * @property {string} key - matches a Scenario's `resolution.knowledgeSource`
 *   (e.g. "platform_info", "pricing")
 * @property {LocalizedText} text
 *
 * @typedef {Object} LiveKnowledgeContext
 * @property {string} source - the knowledgeSource key being resolved (e.g. "ticket_status")
 * @property {string} userId
 * @property {number} turn
 *
 * @typedef {Object} LiveKnowledgeResult
 * @property {boolean} available - whether real data was found for this customer/source
 * @property {*} data - shape depends on `source`; see the Dialogue Engine's
 *   knowledge-formatters.js for the two currently-consumed shapes:
 *   "ticket_status" -> { tickets: [{ticketNumber, title, status}] },
 *   "subscription_status" -> { plan, status, billingCycle, daysLeft }
 */

const REQUIRED_ENTRY_FIELDS = ['key', 'text'];

function isLocalizedText(value) {
    return (
        value &&
        typeof value === 'object' &&
        typeof value.ar === 'string' &&
        typeof value.en === 'string' &&
        value.ar.length > 0 &&
        value.en.length > 0
    );
}

/**
 * Validates a single static knowledge entry. Does not throw — returns a
 * result the caller decides what to do with, so one bad entry can be
 * skipped without taking down the whole content set (same contract as
 * Module 2's validateScenario).
 *
 * @param {*} entry
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateStaticKnowledgeEntry(entry) {
    const errors = [];

    if (!entry || typeof entry !== 'object') {
        return { valid: false, errors: ['entry is not an object'] };
    }

    for (const field of REQUIRED_ENTRY_FIELDS) {
        if (!(field in entry)) errors.push(`missing required field: ${field}`);
    }
    if (errors.length) return { valid: false, errors };

    if (typeof entry.key !== 'string' || entry.key.trim() === '') {
        errors.push('key must be a non-empty string');
    }
    if (!isLocalizedText(entry.text)) {
        errors.push('text must be a { ar, en } object with non-empty strings');
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Validates a whole list of static knowledge entries, additionally
 * checking for duplicate keys (same contract as Module 2's
 * validateCatalog).
 *
 * @param {*[]} entries
 * @returns {{ valid: StaticKnowledgeEntry[], invalid: Array<{ entry: *, errors: string[] }> }}
 */
export function validateStaticKnowledgeEntries(entries) {
    const valid = [];
    const invalid = [];
    const seenKeys = new Map();

    const list = Array.isArray(entries) ? entries : [];

    for (const entry of list) {
        const { valid: isValid, errors } = validateStaticKnowledgeEntry(entry);
        if (!isValid) {
            invalid.push({ entry, errors });
            continue;
        }
        if (seenKeys.has(entry.key)) {
            invalid.push({ entry, errors: [`duplicate key: "${entry.key}"`] });
            continue;
        }
        seenKeys.set(entry.key, true);
        valid.push(entry);
    }

    return { valid, invalid };
}

/**
 * Lightweight sanity check for a LiveKnowledgeResult. Like Module 3's
 * checkEvidenceShape, this catches programming mistakes in this
 * internally-produced data (e.g. a future real provider returning
 * something malformed), not authoring errors.
 * @param {*} result
 * @returns {string[]} problems (empty = valid)
 */
export function checkLiveKnowledgeResultShape(result) {
    const problems = [];
    if (!result || typeof result !== 'object') return ['result is not an object'];
    if (typeof result.available !== 'boolean') problems.push('available must be a boolean');
    if (result.available && result.data === undefined) problems.push('data should be present when available is true');
    return problems;
}
