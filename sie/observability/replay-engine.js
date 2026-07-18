/**
 * replay-engine.js
 * ------------------------------------------------------------
 * Given a stored conversation (a real transcript, already sitting in
 * chat_messages — read via observability-read-port.js, no new storage
 * needed) and a pipeline configuration (which providers to use), replays
 * it turn by turn through all seven engine modules UNCHANGED — Language
 * -> Scenario -> Diagnostic -> Ranking -> Decision -> Knowledge ->
 * Dialogue — capturing the complete reasoning trace at every step via
 * Module 9a's buildTraceEvent().
 *
 * "Before" = the currently-published Scenario/Knowledge catalogs
 * (this file's own defaults, the real .local.js singletons). "After" =
 * an admin's proposed edit, loaded as an alternate provider — this
 * reuses the provider-injection pattern already built into every
 * module (scenarioProvider, staticKnowledgeProvider, etc. are just
 * function parameters everywhere), so NO ENGINE CODE CHANGES were
 * needed anywhere in Modules 1-7 to support replay. This file is pure
 * orchestration; it contains no diagnostic/ranking/decision logic of
 * its own.
 */
import { normalize } from '../language/normalizer.js';
import { technicalGlossaryProvider as defaultGlossaryProvider } from '../language/technical-glossary.local.js';
import { arabiziMapProvider as defaultArabiziProvider } from '../language/arabizi-map.local.js';
import { scenarioCatalogProvider as defaultScenarioProvider } from '../scenarios/scenario-catalog.local.js';
import { processTurn } from '../diagnostics/diagnostic-engine.js';
import { rankHypotheses } from '../ranking/ranking-engine.js';
import { decide } from '../decision/decision-engine.js';
import { createEmptyDecisionState } from '../decision/decision-types.js';
import { composeAnswerDecision } from '../knowledge/answer-composer.js';
import { staticKnowledgeProvider as defaultStaticKnowledgeProvider } from '../knowledge/static-knowledge.local.js';
import { liveKnowledgeProviderStub as defaultLiveKnowledgeProvider } from '../knowledge/live-knowledge.stub.js';
import { renderDecision } from '../dialogue/dialogue-renderer.js';
import { buildTraceEvent } from './trace-logger.js';

/**
 * @typedef {Object} ReplayConfig
 * @property {{glossaryProvider: *, arabiziProvider: *}} [language]
 * @property {*} [scenarioProvider] - defaults to the real, currently-published catalog
 * @property {*} [staticKnowledgeProvider] - defaults to the real, currently-published content
 * @property {*} [liveKnowledgeProvider] - defaults to the no-op stub (same as production today)
 * @property {{userId: string}} [liveKnowledgeContext]
 * @property {() => string} [clock]
 * @property {string} [previousLanguage='ar']
 *
 * @typedef {Object} ReplayResult
 * @property {string} sessionId
 * @property {import('./trace-types.js').TraceEvent[]} traceEvents
 */

/**
 * @param {Object} params
 * @param {string} params.sessionId
 * @param {import('./observability-read-port.js').StoredTurn[]} params.turns - ordered ascending by turn
 * @param {ReplayConfig} [params.config]
 * @returns {Promise<ReplayResult>}
 */
export async function replayConversation({ sessionId, turns, config = {} }) {
    const glossaryProvider = config.language?.glossaryProvider ?? defaultGlossaryProvider;
    const arabiziProvider = config.language?.arabiziProvider ?? defaultArabiziProvider;
    const scenarioProvider = config.scenarioProvider ?? defaultScenarioProvider;
    const staticKnowledgeProvider = config.staticKnowledgeProvider ?? defaultStaticKnowledgeProvider;
    const liveKnowledgeProvider = config.liveKnowledgeProvider ?? defaultLiveKnowledgeProvider;
    const previousLanguage = config.previousLanguage ?? 'ar';

    const orderedTurns = [...(Array.isArray(turns) ? turns : [])].sort((a, b) => a.turn - b.turn);
    const scenarios = await scenarioProvider.getAllScenarios();

    const traceEvents = [];
    let diagnosticState;
    let decisionState = createEmptyDecisionState();
    let responseLanguage = previousLanguage;
    let priorEntryCount = 0;

    for (const { turn, rawText } of orderedTurns) {
        const normalized = await normalize(rawText || '', { previousLanguage: responseLanguage, glossaryProvider, arabiziProvider });
        responseLanguage = normalized.responseLanguage;

        diagnosticState = await processTurn({
            normalizedTokens: normalized.normalizedTokens,
            turn,
            previousState: diagnosticState,
            scenarioProvider
        });

        const newEvidenceAddedThisTurn = diagnosticState.accumulator.entries.length - priorEntryCount;
        priorEntryCount = diagnosticState.accumulator.entries.length;

        const ranking = rankHypotheses(diagnosticState.hypotheses, scenarios);

        const { decision, decisionState: nextDecisionState } = decide({
            ranking,
            turn,
            previousDecisionState: decisionState,
            newEvidenceAddedThisTurn,
            clock: config.clock
        });
        decisionState = nextDecisionState;

        const composedDecision = await composeAnswerDecision({
            decision,
            liveKnowledgeContext: config.liveKnowledgeContext,
            staticKnowledgeProvider,
            liveKnowledgeProvider,
            turn
        });

        const rendered = renderDecision(composedDecision, responseLanguage);

        traceEvents.push(
            buildTraceEvent({
                sessionId,
                turn,
                rawText: rawText || '',
                normalizedTokens: normalized.normalizedTokens,
                diagnosticState,
                ranking,
                decision: composedDecision,
                responseText: rendered.text,
                timestamp: typeof config.clock === 'function' ? config.clock() : undefined
            })
        );
    }

    return { sessionId, traceEvents };
}
