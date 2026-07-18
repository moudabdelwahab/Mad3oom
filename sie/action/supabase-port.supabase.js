/**
 * supabase-port.supabase.js
 * ------------------------------------------------------------
 * Real, thin implementation of the SupabasePort contract
 * (supabase-port.js), calling the atomic Postgres RPC functions added
 * by migrations/0001_add_chat_engine_atomic_write_functions.sql
 * (persist_bot_turn, create_ticket_with_message_and_session_update) and
 * observability/migrations/0001_add_chat_engine_observability_and_review_center.sql
 * (the 8 methods added during Module 9). Deliberately thin: no
 * branching, no retries, no client-side transaction logic — the whole
 * point of these RPCs is that Postgres, not this file, owns atomicity.
 *
 * NEVER INVOKED BY ANY TEST in this project — only
 * tests/helpers/mock-supabase-port.js is exercised. This file exists so
 * the real wiring is written and reviewable now; connecting it to live
 * traffic is a separate, explicit future integration step (see the
 * README's "Remaining work" section). Importing this file changes
 * nothing about chat-logic.js / chatbot-engine.js on its own.
 */
import { createSupabasePort } from './supabase-port.js';

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
 * @returns {import('./supabase-port.js').SupabasePort}
 */
export function createRealSupabasePort(supabaseClient) {
    async function persistBotTurn({ sessionId, turn, messageText, botState }) {
        const { error } = await supabaseClient.rpc('persist_bot_turn', {
            p_session_id: sessionId,
            p_turn: turn,
            p_message_text: messageText,
            p_bot_state: botState
        });
        return { success: !error, error: error?.message ?? null };
    }

    async function createTicketWithMessageAndSessionUpdate({ sessionId, turn, messageText, botState, ticket }) {
        const { data, error } = await supabaseClient.rpc('create_ticket_with_message_and_session_update', {
            p_session_id: sessionId,
            p_turn: turn,
            p_message_text: messageText,
            p_bot_state: botState,
            p_scenario_id: ticket.scenarioId,
            p_category: ticket.category,
            p_description: ticket.description
        });
        return {
            success: !error,
            error: error?.message ?? null,
            ticketNumber: error ? null : (data?.[0]?.ticket_number ?? null)
        };
    }

    // ---- Added during Module 9 (Observability / Review Center / Validation Lab) ----

    async function insertTraceEvent({ sessionId, turn, traceEvent }) {
        const { error } = await supabaseClient.from('chat_engine_trace_events').insert({
            session_id: sessionId,
            turn,
            trace: traceEvent
        });
        return { success: !error, error: error?.message ?? null };
    }

    async function createConversationReview({ sessionId, triggeredByTurn, reason }) {
        const { data, error } = await supabaseClient
            .from('chat_engine_conversation_reviews')
            .insert({ session_id: sessionId, triggered_by_turn: triggeredByTurn, reason, status: 'open' })
            .select('id')
            .single();
        return { success: !error, error: error?.message ?? null, reviewId: error ? null : (data?.id ?? null) };
    }

    async function updateConversationReview({ reviewId, status, correction = null }) {
        const { error } = await supabaseClient
            .from('chat_engine_conversation_reviews')
            .update({ status, correction, updated_at: new Date().toISOString() })
            .eq('id', reviewId);
        return { success: !error, error: error?.message ?? null };
    }

    async function createScenarioDraft({ key, definition, authorNote = null }) {
        const { data, error } = await supabaseClient.rpc('create_chat_engine_scenario_draft', {
            p_scenario_key: key,
            p_definition: definition,
            p_author_note: authorNote
        });
        return { success: !error, error: error?.message ?? null, draftVersion: error ? null : (data?.[0]?.version ?? null) };
    }

    async function createKnowledgeDraft({ key, definition, authorNote = null }) {
        const { data, error } = await supabaseClient.rpc('create_chat_engine_knowledge_draft', {
            p_knowledge_key: key,
            p_definition: definition,
            p_author_note: authorNote
        });
        return { success: !error, error: error?.message ?? null, draftVersion: error ? null : (data?.[0]?.version ?? null) };
    }

    async function insertValidationRun({ kind, targetType, targetKey, targetVersion, verdict, details }) {
        const { data, error } = await supabaseClient
            .from('chat_engine_validation_runs')
            .insert({
                kind,
                target_type: targetType,
                target_key: targetKey,
                target_version: targetVersion,
                verdict,
                details
            })
            .select('id')
            .single();
        return { success: !error, error: error?.message ?? null, runId: error ? null : (data?.id ?? null) };
    }

    async function publishScenario({ key, version, overrideReason = null }) {
        const { error } = await supabaseClient.rpc('publish_chat_engine_scenario', {
            p_scenario_key: key,
            p_version: version,
            p_override_reason: overrideReason
        });
        return { success: !error, error: error?.message ?? null };
    }

    async function publishKnowledge({ key, version, overrideReason = null }) {
        const { error } = await supabaseClient.rpc('publish_chat_engine_knowledge', {
            p_knowledge_key: key,
            p_version: version,
            p_override_reason: overrideReason
        });
        return { success: !error, error: error?.message ?? null };
    }

    return createSupabasePort({
        persistBotTurn,
        createTicketWithMessageAndSessionUpdate,
        insertTraceEvent,
        createConversationReview,
        updateConversationReview,
        createScenarioDraft,
        createKnowledgeDraft,
        insertValidationRun,
        publishScenario,
        publishKnowledge
    });
}
