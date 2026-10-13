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

const NO_ACCESS = Object.freeze({ member: false, enabled: false, supervisor: false, can_assign: false, owner: false, trash: false,
    policies: false, capabilities: Object.freeze({}) });

/**
 * استشاري للواجهة: أي فشل (أو قاعدة قبل 074) = لا شيء ظاهر.
 * trash: القاعدة فيها 076 (continuity_my_access بيرجّع owner). قبلها الصفحة تشتغل بقواعد 074.
 * policies: القاعدة فيها 078 (بيرجّع capabilities). قبلها لوحة الإعدادات مخفية.
 */
export async function loadContinuityAccess() {
    try {
        const data = await callMyAccess();
        return data && typeof data === 'object'
            ? { ...NO_ACCESS, ...data,
                trash: Object.prototype.hasOwnProperty.call(data, 'owner'),
                policies: Object.prototype.hasOwnProperty.call(data, 'capabilities') } : NO_ACCESS;
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
export const loadEvents = (id, before = null) => call('continuity_events_for', { p_record: id, p_before: before, p_limit: 50 });
/** 078: السياسة (قراءة لكل عضو؛ التغيير لمالك المنصة فقط، بالنسخة). */
export const getPolicies = () => call('continuity_get_policies');
export const setPolicies = (patch, version) => call('continuity_set_policies', { p_patch: patch, p_expected_version: version });
export const listAssigners = () => call('continuity_list_assigners');
export const grantAssigner = (userId) => call('continuity_grant_assigner', { p_user: userId });
export const revokeAssigner = (userId) => call('continuity_revoke_assigner', { p_user: userId });

// ─────────────────────────────────────────────────────────────
// المرفقات (080). الرفع عبر دالة الرفع فقط (فحص التوقيع على الخادم)؛ لا كتابة مباشرة في
// المستودع. القراءة برابط موقّع قصير بهوية المستخدم، تحكمه سياسة المستودع.
// ─────────────────────────────────────────────────────────────
export const ATTACHMENTS_BUCKET = 'continuity-attachments';
export const SIGNED_URL_TTL = 300;

export const removeAttachment = (id, version) =>
    call('continuity_attachment_remove', { p_attachment: id, p_expected_version: version });
export const restoreAttachment = (id, version) =>
    call('continuity_attachment_restore', { p_attachment: id, p_expected_version: version });
export const purgeAttachment = (id, version) =>
    call('continuity_attachment_purge', { p_attachment: id, p_expected_version: version });

/** رابط موقّع (5 دقائق) أو null لو الخادم رفض (لا وصول، محذوف، منتهي الاحتفاظ، أو القدرة مطفأة). */
export async function signAttachment(path) {
    try {
        const { data, error } = await supabase.storage.from(ATTACHMENTS_BUCKET).createSignedUrl(path, SIGNED_URL_TTL);
        return error ? null : data?.signedUrl || null;
    } catch {
        return null;
    }
}

// ─────────────────────────────────────────────────────────────
// التسليم (081): الملكية تتغير فقط بقبول المستلم؛ المعلّق لا يمنح وصولًا
// ─────────────────────────────────────────────────────────────
export const requestHandover = ({ recordId, toOwner, reason, note, version, idempotencyKey }) =>
    call('continuity_handover_request', { p_record: recordId, p_to_owner: toOwner, p_reason: reason,
        p_context_note: note || null, p_expected_version: version, p_idempotency_key: idempotencyKey });
export const decideHandover = (id, decision, note, version) =>
    call('continuity_handover_decide', { p_handover: id, p_decision: decision, p_note: note || null, p_expected_version: version });
export const cancelHandover = (id, note = null) => call('continuity_handover_cancel', { p_handover: id, p_note: note });
export const myHandovers = () => call('continuity_handovers_mine');
export const handoversForRecord = (recordId) => call('continuity_handovers_for_record', { p_record: recordId });

// ─────────────────────────────────────────────────────────────
// 091: المشاركة المحدودة (مراجعة، عرض فقط). البوابة على الخادم في كل قراءة.
// ─────────────────────────────────────────────────────────────
export const requestShare = ({ recordId, toOwner, reason, note, version, idempotencyKey, mode = 'review', scope }) =>
    call('continuity_handover_request', { p_record: recordId, p_to_owner: toOwner, p_reason: reason,
        p_context_note: note || null, p_expected_version: version, p_idempotency_key: idempotencyKey,
        p_mode: mode, p_scope: scope });
export const reviewHandover = (id) => call('continuity_handover_review', { p_handover: id });
/** القرار ببصمة المراجعة (091). الرفض لا يحتاج بصمة. */
export const decideReviewed = (id, decision, note, digest) =>
    call('continuity_handover_decide', { p_handover: id, p_decision: decision, p_note: note || null, p_reviewed_digest: digest || null });
export const revokeShare = (id, note = null) => call('continuity_handover_revoke', { p_handover: id, p_note: note });
export const amendShare = (id, scope) => call('continuity_handover_amend_scope', { p_handover: id, p_scope: scope });
export const respondShare = (id, version, accept) =>
    call('continuity_handover_respond_scope', { p_handover: id, p_version: version, p_accept: Boolean(accept) });
export const sharedRecord = (recordId) => call('continuity_shared_get', { p_record: recordId });
export const shareScope = (id) => call('continuity_handover_scope', { p_handover: id });
export const previewRecipient = (recordId, recipient, sourceIds) =>
    call('continuity_handover_preview_recipient', { p_record: recordId, p_recipient: recipient, p_source_ids: sourceIds });

/**
 * المشاركات معي. installed = false على قاعدة قبل 091 (الدالة غير موجودة): الواجهة تخفي المشاركة كلها.
 * أي فشل آخر (المفتاح مطفأ مثلًا) = مثبتة وبلا عناصر.
 */
export async function sharedWithMe() {
    const { data, error } = await supabase.rpc('continuity_shared_with_me');
    if (isMissingRpc(error) || (!error && !data)) return { installed: false, active: [], proposals: [] };
    if (error) return { installed: true, active: [], proposals: [] };
    return { installed: true, active: data?.active || [], proposals: data?.proposals || [] };
}

/**
 * مرفق داخل مشاركة: المستلم لا يوقّع بنفسه (سياسة المستودع كما هي). دالة continuity-shared-attachment
 * تعيد البوابة بهويته وتوقّع رابطًا ≤ 60 ثانية. ⇒ { url, expires_in, mime, name } أو null.
 */
export const SHARED_ATTACHMENT_FUNCTION = 'continuity-shared-attachment';
export async function signSharedAttachment(id) {
    try {
        const { data, error } = await supabase.functions.invoke(SHARED_ATTACHMENT_FUNCTION, { body: { attachment_id: id } });
        return error || typeof data?.url !== 'string' ? null : data;
    } catch {
        return null;
    }
}

// ─────────────────────────────────────────────────────────────
// 093: إجراءات المشاركة التعاونية. البوابة والمفتاح (delegation_allow_collab) على الخادم في كل نداء.
// ─────────────────────────────────────────────────────────────
const messageSources = (messageIds) => [...new Set(messageIds)].map((mid) => ({
    type: 'mad3oom_message', provider: 'mad3oom', adapter: 'mad3oom-inbox', adapter_version: '1', internal: { chat_message_id: mid },
}));
/** handoverId = null ⇒ ملاحظة على السجل (لمن يعدّل السجل)؛ غير null ⇒ في خيط تلك المشاركة. */
export const addNote = (recordId, body, handoverId = null) =>
    call('continuity_note_add', { p_record: recordId, p_body: body, p_handover: handoverId });
export const notesFor = (recordId) => call('continuity_notes_for', { p_record: recordId });
export const proposeShared = (recordId, patch, note = null) =>
    call('continuity_shared_propose', { p_record: recordId, p_patch: patch, p_note: note || null });
export const proposalsFor = (recordId) => call('continuity_proposals_for', { p_record: recordId });
export const decideProposal = (id, decision, note, version) =>
    call('continuity_proposal_decide', { p_proposal: id, p_decision: decision, p_note: note || null, p_expected_version: version });
export const withdrawProposal = (id) => call('continuity_proposal_withdraw', { p_proposal: id });
export const updateShared = (recordId, patch, version) =>
    call('continuity_shared_update', { p_record: recordId, p_patch: patch, p_expected_version: version });
export const attachSharedSources = (recordId, messageIds, version, sensitiveAck = false) =>
    call('continuity_shared_attach_sources', { p_record: recordId, p_sources: messageSources(messageIds),
        p_expected_version: version, p_sensitive_ack: Boolean(sensitiveAck) });

/** إعدادات المشاركة للأعضاء؛ null على قاعدة قبل 093 (الخيارات التعاونية مخفية). */
export async function delegationSettings() {
    const { data, error } = await supabase.rpc('continuity_delegation_settings');
    return error || !data ? null : data;
}

// ─────────────────────────────────────────────────────────────
// 094: التذكيرات والتصعيد — أنواع وأوقات فقط لمن يرى السجل. null على قاعدة قبل 094.
// ─────────────────────────────────────────────────────────────
export async function remindersFor(recordId) {
    const { data, error } = await supabase.rpc('continuity_reminders_for', { p_record: recordId });
    return error || !data ? null : data;
}

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
