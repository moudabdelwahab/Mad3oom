/**
 * portal-data.js — بيانات بوابة عملاء الشركة (D8، الترحيل 095؛ العضويات المتعددة 096).
 *
 * البوابة لا تقرأ شيئًا من الشركة غير اسمها: my_company_portal() تعيده لعميل الشركة
 * وحده (ولمالك المنصة في منظور العضو)، و null لغيرهما. الشركة الحالية تُشتق من
 * الجلسة في القاعدة؛ معرّف الشركة الذي يُرسل من هنا (التبديل، المغادرة) تتحقق القاعدة
 * من أن للمنادي عضوية نشطة فيه، وترد بنفس الرسالة لشركة غريبة أو غير موجودة.
 */
import { supabase } from '/api-config.js';

const MISSING_RPC = new Set(['PGRST202', '42883', 'PGRST404']);

/**
 * @returns {Promise<{ ok: boolean, data: null | { company: { id: string, name: string }, preview: boolean },
 *                     unavailable?: boolean, error?: string }>}
 */
export async function fetchPortalContext() {
    try {
        const { data, error } = await supabase.rpc('my_company_portal');
        if (error && (MISSING_RPC.has(error.code) || error.status === 404)) {
            return { ok: true, data: null, unavailable: true };
        }
        if (error) throw error;
        return { ok: true, data: data || null };
    } catch (err) {
        console.error('[Portal] context:', err?.message || err);
        return { ok: false, data: null, error: 'تعذّر تحميل البوابة. حاول مرة أخرى.' };
    }
}

/** حالة العرض من رد الخادم — خالصة، مُختبَرة في tests/portal-model.test.mjs. */
export function portalState(result) {
    if (!result || result.ok !== true) return { kind: 'error' };
    if (result.unavailable) return { kind: 'unavailable' };
    const company = result.data?.company;
    if (!company || !company.name) return { kind: 'not-customer' };
    return { kind: 'ready', companyName: String(company.name), preview: result.data.preview === true };
}

/** تحقق نموذج التذكرة قبل الإرسال (القاعدة تتحقق مرة أخرى). */
export function validateTicketForm({ title, description }) {
    const errors = {};
    const t = String(title || '').trim();
    const d = String(description || '').trim();
    if (t.length < 3) errors.title = 'اكتب عنوانًا من 3 أحرف على الأقل';
    if (t.length > 200) errors.title = 'العنوان أطول من 200 حرف';
    if (d.length < 10) errors.description = 'صف المشكلة في 10 أحرف على الأقل';
    if (d.length > 5000) errors.description = 'الوصف أطول من 5000 حرف';
    return { ok: Object.keys(errors).length === 0, errors, values: { title: t, description: d } };
}

/**
 * 097: تذاكر البوابة = تذاكر العميل مع الشركة الحالية فقط. تذاكره مع مدعوم (الفوترة الشخصية)
 * ومع شركاته الأخرى لا تظهر هنا. قبل 097 الصفوف بلا scope: تظهر كلها كما كانت.
 */
export function portalTicketFilter(companyId) {
    return (ticket) => !!ticket && (!('scope' in ticket)
        || (ticket.scope === 'company' && String(ticket.company_id) === String(companyId)));
}

/* ── العضويات المتعددة (096) ───────────────────────────────────────────── */

/**
 * محوّل الشركات من رد my_company_portal() — خالص، مُختبَر في tests/portal-model.test.mjs.
 * يظهر المحوّل حين تكون الميزة مفعّلة وللعميل أكثر من شركة. بلا أساسية (غادرها) يقترح
 * تعيين الحالية أساسيةً — تغيير أساسية قائمة نقلٌ بموافقات، لا زر هنا.
 */
export function membershipView(data) {
    const multi = data?.multi_company === true && data?.preview !== true;
    const list = multi && Array.isArray(data.memberships) ? data.memberships : [];
    const options = list
        .filter(m => m && m.company_id && m.name)
        .map(m => ({ id: String(m.company_id), name: String(m.name),
                     isPrimary: m.is_primary === true, isCurrent: m.is_current === true }));
    const current = options.find(o => o.isCurrent) || null;
    const hasPrimary = options.some(o => o.isPrimary);
    return {
        multi,
        showSwitcher: options.length > 1,
        options,
        current,
        canLeave: multi && !!current,
        canSetPrimary: multi && !!current && !hasPrimary
    };
}

/** نص رسالة خطأ الخادم كما هو (نص، لا HTML)، مع بديل عام. */
function rpcError(error, fallback) {
    if (error?.code === '0A000') return 'هذه الميزة غير مفعّلة بعد.';
    return error?.message || fallback;
}

async function call(name, args, fallback) {
    try {
        const { data, error } = await supabase.rpc(name, args);
        if (error) return { ok: false, error: rpcError(error, fallback) };
        return { ok: true, data };
    } catch (err) {
        console.error(`[Portal] ${name}:`, err?.message || err);
        return { ok: false, error: fallback };
    }
}

/** دعوات الحساب المعلّقة: اسم الشركة وتاريخ الانتهاء فقط ([] والميزة مطفأة). */
export async function fetchMyInvitations() {
    try {
        const { data, error } = await supabase.rpc('my_company_invitations');
        // قبل 096 لا دالة: لا دعوات، لا خطأ يظهر للعميل
        if (error && (MISSING_RPC.has(error.code) || error.status === 404)) return { ok: true, data: [] };
        if (error) throw error;
        return { ok: true, data: Array.isArray(data) ? data : [] };
    } catch (err) {
        console.error('[Portal] invitations:', err?.message || err);
        return { ok: false, data: [], error: 'تعذّر تحميل الدعوات.' };
    }
}

export function respondToInvitation(invitationId, accept) {
    return call('company_invitation_respond', { p_invitation: invitationId, p_accept: accept === true },
                'تعذّر حفظ ردك على الدعوة.');
}

/** null = العودة إلى الشركة الافتراضية (الأساسية). */
export function switchCompany(companyId) {
    return call('enter_customer_company', { p_company: companyId || null }, 'تعذّر التبديل إلى الشركة.');
}

export function leaveCompany(companyId) {
    return call('leave_company', { p_company: companyId }, 'تعذّرت مغادرة الشركة.');
}

export function setPrimaryCompany(companyId) {
    return call('set_primary_company', { p_company: companyId }, 'تعذّر تعيين الشركة الأساسية.');
}

/* ── النقل والنسخ والوصول التاريخي (101) ─────────────────────────────────── */

const H2_OFF = Object.freeze({ transfers: false, carry: false, historical: false });

/** حالة مفاتيح 101 للعرض وحده (كل دالة تتحقق من مفتاحها في القاعدة). قبل 101: كلها مطفأة. */
export async function fetchH2Features() {
    try {
        const { data, error } = await supabase.rpc('h2_features');
        if (error || !data) return H2_OFF;
        return { transfers: data.transfers === true, carry: data.carry === true, historical: data.historical === true };
    } catch {
        return H2_OFF;
    }
}

/**
 * ما يظهر من أدوات 101 — خالص، مُختبَر في tests/portal-model.test.mjs.
 * النقل: الشركة الحالية ليست الأساسية ولدى العميل أساسية (بلا أساسية يكفي تعيينها، 096).
 * النسخ: من شركاته الأخرى إلى الحالية. الوصول التاريخي: قائمة الطلبات متى كان المفتاح مفعّلًا.
 */
export function movesView(features, view) {
    const f = features || H2_OFF;
    const current = view?.multi ? view.current : null;
    const canTransfer = f.transfers === true && !!current && !current.isPrimary && view.canSetPrimary !== true;
    const carrySources = f.carry === true && current ? view.options.filter(o => !o.isCurrent) : [];
    return {
        canTransfer,
        showTransfers: f.transfers === true && !!current,
        carrySources,
        showHistory: f.historical === true
    };
}

/** وصف ما سيُنسخ من تذكرة (من _carry_manifest) — نص للعميل قبل التأكيد. */
export function carrySummary(manifest) {
    const n = (k) => Math.max(0, Number(manifest?.[k]) || 0);
    const parts = ['وصفك'];
    if (n('replies_included')) parts.push(`${n('replies_included')} من رسائلك`);
    if (n('attachments_included')) parts.push(`${n('attachments_included')} من مرفقاتك`);
    const left = n('replies_excluded_staff') + n('replies_excluded_internal') + n('attachments_excluded');
    return `يُنسخ: ${parts.join(' و')}.` + (left ? ` لا تُنسخ ردود فريق الشركة وملاحظاته ومرفقاته (${left}).` : '');
}

const TRANSFER_STATUS = {
    pending: 'بانتظار موافقة الشركتين', completed: 'اكتمل النقل', rejected: 'رُفض — لم يتغير شيء',
    cancelled: 'ألغيته', expired: 'انتهت مهلته'
};
export const transferStatusLabel = (status) => TRANSFER_STATUS[status] || '—';

const HISTORY_STATUS = {
    awaiting_customer: 'بانتظار قرارك', awaiting_owner: 'وافقت — بانتظار مراجعة مدعوم', approved: 'مسموح لمدة محدودة',
    rejected: 'رفضته مدعوم', declined: 'رفضته', expired: 'انتهى'
};
export const historyStatusLabel = (status) => HISTORY_STATUS[status] || '—';

async function list(name, args) {
    const result = await call(name, args, 'تعذّر التحميل.');
    return result.ok ? { ok: true, data: Array.isArray(result.data) ? result.data : [] } : { ok: false, data: [], error: result.error };
}

export const fetchMyTransfers = () => list('my_transfers');
export const fetchCarryCandidates = (sourceCompany) => list('carry_candidates', { p_source_company: sourceCompany });
export const fetchMyHistoricalRequests = () => list('my_historical_requests');

/** idempotencyKey: نفس المفتاح عند إعادة المحاولة يعيد نفس الطلب ولا يكرره. */
export function requestTransfer(toCompany, keepSourceSecondary, idempotencyKey) {
    return call('transfer_request', { p_to_company: toCompany, p_keep_source_secondary: keepSourceSecondary === true,
                                      p_idempotency_key: idempotencyKey }, 'تعذّر إرسال طلب النقل.');
}

export function cancelTransfer(transferId) {
    return call('transfer_cancel', { p_transfer: transferId }, 'تعذّر إلغاء الطلب.');
}

export function carryTickets(sourceCompany, destCompany, ticketIds, idempotencyKey) {
    return call('carry_tickets', { p_source_company: sourceCompany, p_dest_company: destCompany,
                                   p_ticket_ids: ticketIds, p_idempotency_key: idempotencyKey }, 'تعذّر نسخ التذاكر.');
}

export function respondHistoricalRequest(requestId, approve, ticketIds) {
    return call('historical_access_consent', { p_request: requestId, p_approve: approve === true,
                                               p_ticket_ids: approve === true ? ticketIds : null }, 'تعذّر حفظ قرارك.');
}

/* ── رسائل العميل مع شركته (102) ─────────────────────────────────────────── */

/** محادثات العميل مع الشركة الحالية. null = الميزة مطفأة أو قبل 102 (لا قسم). */
export async function fetchMyConversations() {
    try {
        const { data, error } = await supabase.rpc('my_company_conversations');
        if (error && (MISSING_RPC.has(error.code) || error.status === 404)) return { ok: true, data: null };
        if (error) throw error;
        return { ok: true, data: data || null };
    } catch (err) {
        console.error('[Portal] conversations:', err?.message || err);
        return { ok: false, data: null, error: 'تعذّر تحميل الرسائل.' };
    }
}

/** تحقق رسالة جديدة قبل الإرسال (القاعدة تتحقق مرة أخرى). خالصة. */
export function validateConversation({ subject, body }) {
    const errors = {};
    const s = String(subject || '').trim();
    const b = String(body || '').trim();
    if (s.length < 3) errors.subject = 'اكتب موضوعًا من 3 أحرف على الأقل';
    if (s.length > 200) errors.subject = 'الموضوع أطول من 200 حرف';
    if (!b) errors.body = 'اكتب رسالتك';
    if (b.length > 5000) errors.body = 'الرسالة أطول من 5000 حرف';
    return { ok: Object.keys(errors).length === 0, errors, values: { subject: s, body: b } };
}

export function startConversation(subject, body, idempotencyKey) {
    return call('company_conversation_start', { p_subject: subject, p_body: body, p_idempotency_key: idempotencyKey },
                'تعذّر إرسال الرسالة.');
}

export function fetchConversationThread(conversationId) {
    return call('company_conversation_thread', { p_conversation: conversationId }, 'تعذّر فتح المحادثة.');
}

export function replyToConversation(conversationId, body) {
    return call('company_conversation_post', { p_conversation: conversationId, p_body: body, p_internal: false },
                'تعذّر إرسال الرد.');
}
