/**
 * scenario-types.js
 * ------------------------------------------------------------
 * Shape/schema for a Scenario — the Scenario Engine's unit of domain
 * knowledge — plus a validator used by the catalog provider to keep a
 * malformed entry (a typo, a missing field, a duplicate id) from
 * crashing the engine. Since this catalog is designed to be edited
 * as data over time, validation-with-graceful-skip is treated as a
 * first-class concern, not an afterthought.
 *
 * @typedef {Object} LocalizedText
 * @property {string} ar
 * @property {string} en
 *
 * @typedef {Object} EvidenceSignatureEntry
 * @property {string} token - Canonical evidence token this scenario cares
 *   about. Deliberately the SAME vocabulary space as Module 1's
 *   technical-glossary/Arabizi canonical tokens (e.g. "http_status_401",
 *   "entity_dns") plus dialect-derived tokens (e.g. "symptom_not_working"),
 *   so the Language Layer and Scenario Engine interlock without any
 *   translation step in between.
 * @property {number} weight - How strongly this evidence supports the
 *   scenario when present (used by the future Ranking Engine).
 * @property {'text'|'live'|'any'} [source] - Whether this evidence is
 *   expected to come from the customer's message text, from live account
 *   data (tickets/subscriptions/etc.), or either. Defaults to 'any'.
 *
 * @typedef {Object} DiscriminatingQuestionOption
 * @property {LocalizedText} label
 * @property {string} value
 * @property {string[]} [impliesEvidence] - Evidence tokens this answer would confirm
 *
 * @typedef {Object} DiscriminatingQuestion
 * @property {string} id
 * @property {LocalizedText} prompt
 * @property {string[]} resolvesEvidence - Evidence tokens this question helps confirm/deny
 * @property {DiscriminatingQuestionOption[]} [options]
 *
 * @typedef {Object} ScenarioResolution
 * @property {boolean} hasAutoResolution
 * @property {LocalizedText} [text]
 * @property {string} [knowledgeSource] - optional key identifying which Live Knowledge
 *   Provider entry (Module 7) can supply real, per-customer data to complete this answer
 *   (e.g. "ticket_status", "subscription_status"). When absent, `text` alone is the answer.
 *   When present, `text` still serves as the fallback if live knowledge is unavailable.
 *
 * @typedef {Object} Scenario
 * @property {string} id - Unique identifier
 * @property {LocalizedText} label
 * @property {EvidenceSignatureEntry[]} evidenceSignature
 * @property {DiscriminatingQuestion[]} discriminatingQuestions
 * @property {ScenarioResolution} resolution
 * @property {boolean} requiresTicketIfUnresolved
 * @property {string} category - Kept aligned with existing tickets.category values
 */

const REQUIRED_TOP_LEVEL_FIELDS = [
    'id',
    'label',
    'evidenceSignature',
    'discriminatingQuestions',
    'resolution',
    'requiresTicketIfUnresolved',
    'category'
];

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
 * Validates a single scenario object against the required shape.
 * Does not throw — returns a result the caller decides what to do with,
 * so one bad entry can be skipped without taking down the whole catalog.
 *
 * @param {*} scenario
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateScenario(scenario) {
    const errors = [];

    if (!scenario || typeof scenario !== 'object') {
        return { valid: false, errors: ['scenario is not an object'] };
    }

    for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
        if (!(field in scenario)) errors.push(`missing required field: ${field}`);
    }
    if (errors.length) return { valid: false, errors };

    if (typeof scenario.id !== 'string' || scenario.id.trim() === '') {
        errors.push('id must be a non-empty string');
    }
    if (!isLocalizedText(scenario.label)) {
        errors.push('label must be a { ar, en } object with non-empty strings');
    }
    if (!Array.isArray(scenario.evidenceSignature) || scenario.evidenceSignature.length === 0) {
        errors.push('evidenceSignature must be a non-empty array');
    } else {
        scenario.evidenceSignature.forEach((entry, i) => {
            if (!entry || typeof entry.token !== 'string' || entry.token.trim() === '') {
                errors.push(`evidenceSignature[${i}].token must be a non-empty string`);
            }
            if (typeof entry.weight !== 'number' || !Number.isFinite(entry.weight)) {
                errors.push(`evidenceSignature[${i}].weight must be a finite number`);
            }
            if (entry.source && !['text', 'live', 'any'].includes(entry.source)) {
                errors.push(`evidenceSignature[${i}].source must be one of text|live|any`);
            }
        });
    }
    if (!Array.isArray(scenario.discriminatingQuestions)) {
        errors.push('discriminatingQuestions must be an array (can be empty)');
    } else {
        scenario.discriminatingQuestions.forEach((q, i) => {
            if (!q || typeof q.id !== 'string' || q.id.trim() === '') {
                errors.push(`discriminatingQuestions[${i}].id must be a non-empty string`);
            }
            if (!isLocalizedText(q?.prompt)) {
                errors.push(`discriminatingQuestions[${i}].prompt must be a { ar, en } object`);
            }
            if (!Array.isArray(q?.resolvesEvidence)) {
                errors.push(`discriminatingQuestions[${i}].resolvesEvidence must be an array`);
            }
        });
    }
    if (!scenario.resolution || typeof scenario.resolution !== 'object') {
        errors.push('resolution must be an object');
    } else {
        if (typeof scenario.resolution.hasAutoResolution !== 'boolean') {
            errors.push('resolution.hasAutoResolution must be a boolean');
        }
        if (scenario.resolution.hasAutoResolution && !isLocalizedText(scenario.resolution.text)) {
            errors.push('resolution.text must be a { ar, en } object when hasAutoResolution is true');
        }
        if ('knowledgeSource' in scenario.resolution && scenario.resolution.knowledgeSource !== undefined) {
            if (typeof scenario.resolution.knowledgeSource !== 'string' || scenario.resolution.knowledgeSource.trim() === '') {
                errors.push('resolution.knowledgeSource, when present, must be a non-empty string');
            }
        }
    }
    if (typeof scenario.requiresTicketIfUnresolved !== 'boolean') {
        errors.push('requiresTicketIfUnresolved must be a boolean');
    }
    if (typeof scenario.category !== 'string' || scenario.category.trim() === '') {
        errors.push('category must be a non-empty string');
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Validates a whole list of scenarios, additionally checking for
 * duplicate ids across the set (a duplicate is reported against every
 * scenario sharing that id, since it's ambiguous which one is "wrong").
 *
 * @param {*[]} scenarios
 * @returns {{ valid: Scenario[], invalid: Array<{ scenario: *, errors: string[] }> }}
 */
export function validateCatalog(scenarios) {
    const valid = [];
    const invalid = [];
    const seenIds = new Map();

    const list = Array.isArray(scenarios) ? scenarios : [];

    for (const scenario of list) {
        const { valid: isValid, errors } = validateScenario(scenario);
        if (!isValid) {
            invalid.push({ scenario, errors });
            continue;
        }
        if (seenIds.has(scenario.id)) {
            invalid.push({ scenario, errors: [`duplicate id: "${scenario.id}"`] });
            continue;
        }
        seenIds.set(scenario.id, true);
        valid.push(scenario);
    }

    return { valid, invalid };
}
