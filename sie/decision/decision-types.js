/**
 * decision-types.js
 * ------------------------------------------------------------
 * Shapes for the Decision Engine's inputs/outputs: the fixed set of
 * possible Actions, the Decision object itself (what the Dialogue
 * Engine will later render, with zero presentation logic inside it),
 * and DecisionState (the engine's own memory of what it has already
 * decided, separate from Module 3's evidence memory).
 *
 * @typedef {'ANSWER'|'ASK_CLARIFYING_QUESTION'|'ASK_FOR_SCREENSHOT'|
 *   'ASK_FOR_ATTACHMENT'|'ASK_FOR_LOGS'|'VERIFY_INFORMATION'|
 *   'REQUEST_ACCOUNT_DETAILS'|'CREATE_TICKET'|'ESCALATE_TO_HUMAN'|
 *   'WAIT_FOR_USER'|'COMPLETE'|'FALLBACK'} DecisionAction
 *
 * @typedef {Object} TicketDraft
 * @property {string} scenarioId
 * @property {string} category
 * @property {Array<{scenarioId: string, confidence: number, status: string}>} diagnosticTrail -
 *   summary of what was considered, for a human agent's context
 *
 * @typedef {Object} EvaluatedRule
 * @property {string} rule - identifier of the rule checked, e.g. "R1_TURN_BUDGET"
 * @property {boolean} matched - whether this rule's condition was met
 * @property {string} detail - short note on why it matched or didn't
 *
 * @typedef {Object} Decision
 * @property {DecisionAction} action
 * @property {string|null} scenarioId - which scenario this decision concerns, if any
 * @property {{ar: string, en: string}|null} scenarioLabel - the concerned scenario's bilingual
 *   label, forwarded from Module 2/4's scenario data (not derived or decided here) purely so
 *   the Dialogue Engine can reference "which scenario" in its phrasing without reaching back
 *   into Ranking/Scenario data itself.
 * @property {number|null} confidence - the scenario's confidence at decision time, if any
 * @property {string} explanation - engineering/audit explanation citing the actual diagnostic
 *   state and ranking numbers that led here. NOT customer-facing text.
 * @property {EvaluatedRule[]} evaluatedRules - ordered trace of every rule checked this turn,
 *   up to and including the one that matched, for full auditability of why this Decision
 *   (and not another) was reached.
 * @property {string} timestamp - ISO-8601 timestamp of when the decision was made
 * @property {import('../scenarios/scenario-types.js').DiscriminatingQuestion|null} targetQuestion -
 *   set only for a targeted ASK_CLARIFYING_QUESTION
 * @property {import('../scenarios/scenario-types.js').ScenarioResolution|null} resolution -
 *   set only for ANSWER
 * @property {TicketDraft|null} ticketDraft - set only for CREATE_TICKET / ESCALATE_TO_HUMAN
 * @property {number} turn
 *
 * @typedef {Object} DecisionState
 * @property {string[]} askedQuestionIds
 * @property {number} questionsAskedCount
 * @property {boolean} supplementaryEvidenceRequested
 * @property {boolean} accountDetailsRequested
 * @property {boolean} verificationDone
 * @property {number} consecutiveNoNewEvidenceTurns
 * @property {DecisionAction|null} lastAction
 * @property {string|null} lastScenarioId
 * @property {Array<{turn: number, action: DecisionAction, scenarioId: string|null, confidence: number|null, explanation: string}>} history
 */

export const ACTIONS = Object.freeze({
    ANSWER: 'ANSWER',
    ASK_CLARIFYING_QUESTION: 'ASK_CLARIFYING_QUESTION',
    ASK_FOR_SCREENSHOT: 'ASK_FOR_SCREENSHOT',
    ASK_FOR_ATTACHMENT: 'ASK_FOR_ATTACHMENT',
    ASK_FOR_LOGS: 'ASK_FOR_LOGS',
    VERIFY_INFORMATION: 'VERIFY_INFORMATION',
    REQUEST_ACCOUNT_DETAILS: 'REQUEST_ACCOUNT_DETAILS',
    CREATE_TICKET: 'CREATE_TICKET',
    ESCALATE_TO_HUMAN: 'ESCALATE_TO_HUMAN',
    WAIT_FOR_USER: 'WAIT_FOR_USER',
    COMPLETE: 'COMPLETE',
    FALLBACK: 'FALLBACK'
});

const VALID_ACTIONS = new Set(Object.values(ACTIONS));

/**
 * Lightweight sanity check for a Decision object. Like Module 3's
 * evidence guards, this is for catching programming mistakes in this
 * internally-produced data, not for policing external input.
 * @param {*} decision
 * @returns {string[]} problems (empty = valid)
 */
export function checkDecisionShape(decision) {
    const problems = [];
    if (!decision || typeof decision !== 'object') return ['decision is not an object'];
    if (!VALID_ACTIONS.has(decision.action)) problems.push(`action must be one of: ${[...VALID_ACTIONS].join(', ')}`);
    if (decision.confidence !== null && typeof decision.confidence !== 'number') {
        problems.push('confidence must be a number or null');
    }
    if (decision.scenarioLabel != null && typeof decision.scenarioLabel.ar !== 'string') {
        problems.push('scenarioLabel must be null/undefined or a { ar, en } object');
    }
    if (typeof decision.explanation !== 'string' || decision.explanation.trim() === '') {
        problems.push('explanation must be a non-empty string');
    }
    if (!Array.isArray(decision.evaluatedRules) || decision.evaluatedRules.length === 0) {
        problems.push('evaluatedRules must be a non-empty array');
    } else {
        decision.evaluatedRules.forEach((r, i) => {
            if (!r || typeof r.rule !== 'string' || r.rule.trim() === '') {
                problems.push(`evaluatedRules[${i}].rule must be a non-empty string`);
            }
            if (typeof r?.matched !== 'boolean') problems.push(`evaluatedRules[${i}].matched must be a boolean`);
        });
    }
    if (typeof decision.timestamp !== 'string' || decision.timestamp.trim() === '') {
        problems.push('timestamp must be a non-empty string');
    }
    if (typeof decision.turn !== 'number') problems.push('turn must be a number');
    return problems;
}

/**
 * Creates a fresh, empty DecisionState for a brand-new session.
 * @returns {DecisionState}
 */
export function createEmptyDecisionState() {
    return {
        askedQuestionIds: [],
        questionsAskedCount: 0,
        supplementaryEvidenceRequested: false,
        accountDetailsRequested: false,
        verificationDone: false,
        consecutiveNoNewEvidenceTurns: 0,
        lastAction: null,
        lastScenarioId: null,
        history: []
    };
}
