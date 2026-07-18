/**
 * action-types.js
 * ------------------------------------------------------------
 * Shapes for the Action Layer's output, plus one pure formatting
 * helper (formatTicketDescription) — the "no new DB columns" decision
 * from the architecture: a ticket's diagnostic trail (which scenarios
 * were considered, at what confidence, with what status) is folded
 * into the existing `tickets.description` text field rather than a new
 * `diagnostic_trail` jsonb column, so this is a pure string formatter,
 * not a schema concern.
 *
 * @typedef {Object} ActionStep
 * @property {string} name - the port method invoked, e.g. "persistBotTurn"
 * @property {boolean} success
 * @property {string|null} error
 * @property {number|string|null} [ticketNumber] - present on the step that created a ticket
 *
 * @typedef {Object} ActionResult
 * @property {boolean} success - true only if every step succeeded
 * @property {import('../decision/decision-types.js').DecisionAction|null} action
 * @property {ActionStep[]} steps
 * @property {boolean} atomicityGuaranteed - true iff exactly one step was needed and it
 *   succeeded-or-failed as a single unit (i.e. it went through one atomic Postgres RPC, not
 *   multiple independent writes this layer stitched together client-side)
 * @property {boolean} requiresFuturePostgresRPC - the inverse signal: true whenever more than
 *   one step was involved, meaning this action's writes are NOT currently atomic and a Postgres
 *   RPC folding them into one transaction is still needed. Every action currently maps to exactly
 *   one port call (see action-layer.js), so this is false in practice today — but it's computed
 *   from the actual step count, not hardcoded, so it would flip back to true honestly if a future
 *   action ever needed more than one independent write again.
 * @property {number|string|null} ticketNumber - set only when a ticket was created
 * @property {string|null} [reviewId] - set only when a conversation review was created
 * @property {number|null} [draftVersion] - set only when a Scenario/Knowledge draft was created
 * @property {string|null} [runId] - set only when a validation run was recorded
 */

/**
 * Builds a well-formed ActionResult from the steps actually executed.
 * The only place `success`/`atomicityGuaranteed`/`requiresFuturePostgresRPC`
 * are computed — never set ad hoc elsewhere, so these three fields can
 * never drift out of sync with what `steps` actually says happened.
 *
 * @param {Object} params
 * @param {string|null} params.action - a DecisionAction for decision-driven calls, or a
 *   descriptive label (e.g. "PUBLISH_SCENARIO") for the Observability write functions added in
 *   Module 9 — this field is a label for what was attempted, not restricted to DecisionAction
 * @param {ActionStep[]} params.steps
 * @param {number|string|null} [params.ticketNumber]
 * @param {string|null} [params.reviewId]
 * @param {number|null} [params.draftVersion]
 * @param {string|null} [params.runId]
 * @returns {ActionResult}
 */
export function buildActionResult({ action, steps, ticketNumber = null, reviewId = null, draftVersion = null, runId = null }) {
    const stepList = Array.isArray(steps) ? steps : [];
    return {
        success: stepList.length > 0 && stepList.every((s) => s.success === true),
        action: action ?? null,
        steps: stepList,
        atomicityGuaranteed: stepList.length === 1,
        requiresFuturePostgresRPC: stepList.length !== 1,
        ticketNumber,
        reviewId,
        draftVersion,
        runId
    };
}

/**
 * Lightweight sanity check for an ActionResult. Same "produced
 * internally, catches programming mistakes" posture as Module 3's
 * checkEvidenceShape / Module 5's checkDecisionShape.
 * @param {*} result
 * @returns {string[]} problems (empty = valid)
 */
export function checkActionResultShape(result) {
    const problems = [];
    if (!result || typeof result !== 'object') return ['result is not an object'];
    if (typeof result.success !== 'boolean') problems.push('success must be a boolean');
    if (!Array.isArray(result.steps)) problems.push('steps must be an array');
    if (typeof result.atomicityGuaranteed !== 'boolean') problems.push('atomicityGuaranteed must be a boolean');
    if (typeof result.requiresFuturePostgresRPC !== 'boolean') problems.push('requiresFuturePostgresRPC must be a boolean');
    return problems;
}

/**
 * Formats a Decision's ticketDraft + audit explanation into the plain
 * text that goes into `tickets.description`. Pure and synchronous — no
 * I/O, so it's trivially unit-testable in isolation from any port.
 *
 * @param {import('../decision/decision-types.js').Decision} decision
 * @returns {string}
 */
export function formatTicketDescription(decision) {
    const draft = decision?.ticketDraft;
    const lines = [];

    lines.push(`Scenario: ${draft?.scenarioId ?? 'unknown'} (category: ${draft?.category ?? 'unknown'})`);
    lines.push(`Reason: ${decision?.explanation ?? 'no explanation recorded'}`);
    lines.push('');
    lines.push('Diagnostic trail (for human agent context):');

    const trail = Array.isArray(draft?.diagnosticTrail) ? draft.diagnosticTrail : [];
    if (trail.length === 0) {
        lines.push('- (none recorded)');
    } else {
        for (const entry of trail) {
            const confidenceText = typeof entry.confidence === 'number' ? entry.confidence.toFixed(2) : 'n/a';
            lines.push(`- ${entry.scenarioId}: confidence=${confidenceText}, status=${entry.status}`);
        }
    }

    return lines.join('\n');
}
