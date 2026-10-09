/**
 * Relay — طبقة البيانات (المرحلة C). نداءات RPC فقط (لا وصول مباشر للجداول:
 * 073/074 بلا أي صلاحية SELECT/INSERT). كل خطأ يُترجم بـ mapRelayError ولا يُعرض
 * نص الخادم كما هو.
 */
import { supabase } from '/api-config.js';
import { mapRelayError } from './relay-contract.js';

export class RelayError extends Error {
    constructor(mapped) {
        super(mapped.message);
        Object.assign(this, mapped);
    }
}

async function call(name, args) {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw new RelayError(mapRelayError(error));
    return data;
}

const NO_ACCESS = Object.freeze({ member: false, enabled: false, supervisor: false, can_assign: false, owner: false, trash: false });

/**
 * استشاري للواجهة: أي فشل (أو قاعدة قبل 074) = لا شيء ظاهر.
 * trash: القاعدة فيها 076 (relay_my_access بيرجّع owner). قبلها الصفحة تشتغل بقواعد 074.
 */
export async function loadRelayAccess() {
    try {
        const data = await call('relay_my_access');
        return data && typeof data === 'object'
            ? { ...NO_ACCESS, ...data, trash: Object.prototype.hasOwnProperty.call(data, 'owner') } : NO_ACCESS;
    } catch {
        return NO_ACCESS;
    }
}

export const createRecord = (request) => call('relay_create', { p_request: request });
export const getRecord = (id) => call('relay_get', { p_record: id });
export const listRecords = (filters = {}) => call('relay_list', { p_filters: filters });
export const updateRecord = (id, patch, version) =>
    call('relay_update', { p_record: id, p_patch: patch, p_expected_version: version });
export const assignRecord = (id, ownerId, teamId, version) =>
    call('relay_assign', { p_record: id, p_owner: ownerId || null, p_team: teamId || null, p_expected_version: version });
export const transitionRecord = (id, to, details, version) =>
    call('relay_transition', { p_record: id, p_to: to, p_details: details || {}, p_expected_version: version });
export const attachSources = (id, messageIds, version, sensitiveAck = false) => call('relay_attach_sources', {
    p_record: id,
    p_sources: [...new Set(messageIds)].map((mid) => ({
        type: 'mad3oom_message', provider: 'mad3oom', adapter: 'mad3oom-inbox', adapter_version: '1',
        internal: { chat_message_id: mid },
    })),
    p_expected_version: version,
    p_sensitive_ack: Boolean(sensitiveAck),
});
/** 076: الإزالة للمحذوفات والاسترجاع لمن يرى السجل؛ المسح النهائي لمالك المنصة فقط. */
export const removeSource = (sourceId, version) =>
    call('relay_remove_source', { p_source: sourceId, p_expected_version: version });
export const restoreSource = (sourceId, version) =>
    call('relay_restore_source', { p_source: sourceId, p_expected_version: version });
export const listRemoved = () => call('relay_list_removed', { p_limit: 100 });
export const purgeSource = (sourceId) => call('relay_redact_source', { p_source: sourceId, p_reason: 'manual' });
export const purgeRemoved = (recordId = null) => call('relay_purge_removed', { p_record: recordId });
export const loadEvents = (id) => call('relay_events_for', { p_record: id, p_before: null, p_limit: 50 });
export const listAssigners = () => call('relay_list_assigners');
export const grantAssigner = (userId) => call('relay_grant_assigner', { p_user: userId });
export const revokeAssigner = (userId) => call('relay_revoke_assigner', { p_user: userId });

/** نفس قائمة الطاقم المؤهل في الصندوق (inbox_list_agents، 055). */
export async function loadAgents() {
    const { data, error } = await supabase.rpc('inbox_list_agents');
    if (error) return [];
    return data || [];
}

export async function loadTeams() {
    const { data, error } = await supabase.from('inbox_teams').select('id, name, archived_at').is('archived_at', null).order('name');
    if (error) return [];
    return data || [];
}
