/**
 * Continuity — طبقة البيانات (المرحلة C). نداءات RPC فقط (لا وصول مباشر للجداول:
 * 073/074 بلا أي صلاحية SELECT/INSERT). كل خطأ يُترجم بـ mapContinuityError ولا يُعرض
 * نص الخادم كما هو.
 */
import { supabase } from '/api-config.js';
import { mapContinuityError } from './continuity-contract.js';

export class ContinuityError extends Error {
    constructor(mapped) {
        super(mapped.message);
        Object.assign(this, mapped);
    }
}

/**
 * قاعدة قبل 077 (الإنتاج على 076 حتى يُطبَّق 077): نفس الدوال موجودة باسمها القديم relay_*.
 * لو continuity_my_access غير موجودة و relay_my_access موجودة، يتحول كل نداء من هذه الأسماء
 * (أغلفة 077 الـ19) لاسمه القديم، فتشتغل الواجهة على قاعدة 076 بنفس سلوكها قبل إعادة التسمية.
 * أي دالة أحدث (078+) لا تُحوَّل أبدًا: على قاعدة قديمة تفشل، وقدرتها مخفية أصلًا.
 */
export const LEGACY_RPCS = Object.freeze([
    'assign', 'attach_sources', 'create', 'events_for', 'find_by_source', 'get', 'grant_assigner', 'list',
    'list_assigners', 'list_removed', 'my_access', 'purge_removed', 'redact_for_subject', 'redact_source',
    'remove_source', 'restore_source', 'revoke_assigner', 'transition', 'update',
]);
const MISSING_RPC = new Set(['PGRST202', '42883', 'PGRST404']);
export const isMissingRpc = (error) => Boolean(error) && MISSING_RPC.has(error.code);
let legacyNames = false;
export function rpcName(name) {
    const bare = name.startsWith('continuity_') ? name.slice('continuity_'.length) : null;
    return legacyNames && bare !== null && LEGACY_RPCS.includes(bare) ? `relay_${bare}` : name;
}

async function call(name, args) {
    const { data, error } = await supabase.rpc(rpcName(name), args);
    if (error) throw new ContinuityError(mapContinuityError(error));
    return data;
}

/** continuity_my_access، أو relay_my_access على قاعدة قبل 077 (ويتحول باقي النداءات معه). */
async function callMyAccess() {
    legacyNames = false;
    const first = await supabase.rpc('continuity_my_access');
    if (!isMissingRpc(first.error)) {
        if (first.error) throw new ContinuityError(mapContinuityError(first.error));
        return first.data;
    }
    const legacy = await supabase.rpc('relay_my_access');
    if (legacy.error) throw new ContinuityError(mapContinuityError(legacy.error));
    legacyNames = true;
    return legacy.data;
}

const NO_ACCESS = Object.freeze({ member: false, enabled: false, supervisor: false, can_assign: false, owner: false, trash: false });

/**
 * استشاري للواجهة: أي فشل (أو قاعدة قبل 074) = لا شيء ظاهر.
 * trash: القاعدة فيها 076 (continuity_my_access بيرجّع owner). قبلها الصفحة تشتغل بقواعد 074.
 */
export async function loadContinuityAccess() {
    try {
        const data = await callMyAccess();
        return data && typeof data === 'object'
            ? { ...NO_ACCESS, ...data, trash: Object.prototype.hasOwnProperty.call(data, 'owner') } : NO_ACCESS;
    } catch {
        return NO_ACCESS;
    }
}

export const createRecord = (request) => call('continuity_create', { p_request: request });
export const getRecord = (id) => call('continuity_get', { p_record: id });
export const listRecords = (filters = {}) => call('continuity_list', { p_filters: filters });
export const updateRecord = (id, patch, version) =>
    call('continuity_update', { p_record: id, p_patch: patch, p_expected_version: version });
export const assignRecord = (id, ownerId, teamId, version) =>
    call('continuity_assign', { p_record: id, p_owner: ownerId || null, p_team: teamId || null, p_expected_version: version });
export const transitionRecord = (id, to, details, version) =>
    call('continuity_transition', { p_record: id, p_to: to, p_details: details || {}, p_expected_version: version });
export const attachSources = (id, messageIds, version, sensitiveAck = false) => call('continuity_attach_sources', {
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
    call('continuity_remove_source', { p_source: sourceId, p_expected_version: version });
export const restoreSource = (sourceId, version) =>
    call('continuity_restore_source', { p_source: sourceId, p_expected_version: version });
export const listRemoved = () => call('continuity_list_removed', { p_limit: 100 });
export const purgeSource = (sourceId) => call('continuity_redact_source', { p_source: sourceId, p_reason: 'manual' });
export const purgeRemoved = (recordId = null) => call('continuity_purge_removed', { p_record: recordId });
export const loadEvents = (id) => call('continuity_events_for', { p_record: id, p_before: null, p_limit: 50 });
export const listAssigners = () => call('continuity_list_assigners');
export const grantAssigner = (userId) => call('continuity_grant_assigner', { p_user: userId });
export const revokeAssigner = (userId) => call('continuity_revoke_assigner', { p_user: userId });

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
