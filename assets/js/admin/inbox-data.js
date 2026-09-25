/**
 * inbox-data.js — طبقة البيانات لصندوق الرسائل (بيانات حقيقية)
 * ------------------------------------------------------------
 * القراءة: جداول الشات (نفس صفوف ويدجت العميل وصفحة العميل و SIE) + جداول
 * الـ helpdesk (migrations/054_inbox_helpdesk_core.sql).
 *
 * الكتابة: **كلها** عبر RPC. مفيش ولا سياسة INSERT/UPDATE على جداول inbox_*،
 * وجدولا الشات مابيتكتبوش من هنا مباشرة. كل RPC بيتحقق من الوصول ويسجّل
 * في inbox_events.
 *
 * الصلاحيات (D1=C): صاحب السلطة المرتفعة بيشوف الكل؛ طاقم المنصة بيشوف
 * المسندة له أو لفريقه. القرار في inbox_can_access() بالقاعدة — الواجهة
 * بتعرض اللي RLS بترجّعه وبس.
 *
 * ------------------------------------------------------------
 * العقد مع ويدجت العميل — ماتغيّرهوش من ناحية واحدة
 *
 * رد الدعم (inbox_send_reply) = chat_sessions.is_manual_mode = true ثم صف في
 * chat_messages بـ is_admin_reply = true — في معاملة واحدة. الويدجت بيسمع
 * الاتنين عن طريق Realtime («فريق الدعم انضم» + الرسالة). الإقفال
 * (status = 'closed') بيعرض «فريق الدعم غادر المحادثة». الملاحظات والوسوم
 * والإسناد في جداول منفصلة ماحدش من ناحية العميل يقدر يقراها.
 */
import { supabase } from '/api-config.js';
import { signedUrls } from '/storage-urls.js';
import { fetchCannedResponses, fetchTags, createTag } from '/tickets-service.js';
import { sortMessages } from './inbox-model.js';

export const CHAT_ATTACHMENTS_BUCKET = 'chat-attachments';

const MESSAGE_LITE = 'id, session_id, sender_id, message_text, image_url, is_admin_reply, is_bot_reply, created_at';
const SESSION_COLS = `id, user_id, guest_id, status, is_manual_mode, created_at, updated_at, chat_messages (${MESSAGE_LITE})`;
const META_COLS = 'session_id, assignee_id, team_id, archived_at, archived_by, updated_at';

async function rpc(name, args) {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw error;
    return data;
}

/** الـ RPC بيرجّع صف مركّب؛ بعض الإصدارات بترجّعه جوه مصفوفة. */
const one = (data) => (Array.isArray(data) ? data[0] ?? null : data ?? null);

function assemble(rows, metas, tagLinks, customers) {
    const metaBy = new Map((metas || []).map((m) => [m.session_id, m]));
    const custBy = new Map((customers || []).map((c) => [c.session_id, c]));
    const tagsBy = new Map();
    for (const link of tagLinks || []) {
        if (!tagsBy.has(link.session_id)) tagsBy.set(link.session_id, []);
        tagsBy.get(link.session_id).push(link.tag_id);
    }
    return (rows || []).map(({ chat_messages, ...session }) => ({
        ...session,
        customer: custBy.get(session.id) || null,
        messages: sortMessages(chat_messages),
        meta: metaBy.get(session.id) || null,
        tagIds: tagsBy.get(session.id) || []
    }));
}

/**
 * كل الجلسات اللي RLS بترجّعها، مع حالة الـ helpdesk ووسومها وعملائها.
 * اسم العميل من inbox_customer_profiles (مش embed على profiles): الأدمن غير
 * المرتفع مالوش SELECT على ملفات الآخرين.
 */
export async function loadSessions() {
    const [sessions, metas, tagLinks] = await Promise.all([
        supabase.from('chat_sessions').select(SESSION_COLS).order('updated_at', { ascending: false }),
        supabase.from('inbox_conversations').select(META_COLS),
        supabase.from('inbox_conversation_tags').select('session_id, tag_id')
    ]);
    for (const r of [sessions, metas, tagLinks]) if (r.error) throw r.error;

    const ids = (sessions.data || []).map((s) => s.id);
    const customers = ids.length ? await rpc('inbox_customer_profiles', { p_sessions: ids }) : [];
    return assemble(sessions.data, metas.data, tagLinks.data, customers);
}

export async function loadSession(sessionId) {
    const [session, meta, tagLinks] = await Promise.all([
        supabase.from('chat_sessions').select(SESSION_COLS).eq('id', sessionId).maybeSingle(),
        supabase.from('inbox_conversations').select(META_COLS).eq('session_id', sessionId).maybeSingle(),
        supabase.from('inbox_conversation_tags').select('session_id, tag_id').eq('session_id', sessionId)
    ]);
    for (const r of [session, meta, tagLinks]) if (r.error) throw r.error;
    if (!session.data) return null;
    const customers = await rpc('inbox_customer_profiles', { p_sessions: [sessionId] });
    return assemble([session.data], meta.data ? [meta.data] : [], tagLinks.data, customers)[0];
}

/** الملاحظات والسجل للمحادثة المفتوحة. */
export async function loadThreadExtras(sessionId) {
    const [notes, events] = await Promise.all([
        supabase.from('inbox_notes').select('*').eq('session_id', sessionId).order('created_at', { ascending: true }),
        supabase.from('inbox_events').select('*').eq('session_id', sessionId).order('created_at', { ascending: true })
    ]);
    for (const r of [notes, events]) if (r.error) throw r.error;
    return { notes: notes.data || [], events: events.data || [] };
}

/** الموظفون المتاحون للإسناد والمنشن، ومين منهم مرتفع، وفرقهم. */
export const loadAgents = () => rpc('inbox_list_agents').then((d) => d || []);

export async function loadTeams() {
    const [teams, members] = await Promise.all([
        supabase.from('inbox_teams').select('*').is('archived_at', null).order('name', { ascending: true }),
        supabase.from('inbox_team_members').select('team_id, user_id, role')
    ]);
    for (const r of [teams, members]) if (r.error) throw r.error;
    return (teams.data || []).map((t) => ({
        ...t, members: (members.data || []).filter((m) => m.team_id === t.id)
    }));
}

/** الوسوم نفسها بتاعة التذاكر (ticket_tags) — مفردات واحدة يديرها الأدمن. */
export const loadTags = () => fetchTags().catch(() => []);
export const createSharedTag = (name, color) => createTag(name, color);

/**
 * سياق العميل من جداول موجودة: ملاحظاته (customer_notes) وتذاكره. الاتنين
 * بيتداروا من أماكنهم (سجل العميل / التذاكر)، والصندوق بيعرضهم بس.
 */
export async function loadCustomerContext(userId) {
    if (!userId) return { notes: [], tickets: [] };
    const [notes, tickets] = await Promise.all([
        supabase.from('customer_notes').select('id, note, created_at').eq('customer_id', userId)
            .order('created_at', { ascending: false }).limit(3),
        supabase.from('tickets').select('id, ticket_number, title, status, created_at').eq('user_id', userId)
            .order('created_at', { ascending: false }).limit(5)
    ]);
    return { notes: notes.error ? [] : notes.data || [], tickets: tickets.error ? [] : tickets.data || [] };
}

// ── الكتابة — كلها RPC ───────────────────────────────────────────────────

export const sendReply = (sessionId, text) =>
    rpc('inbox_send_reply', { p_session: sessionId, p_body: text }).then(one);

export const closeSessions = (ids) => rpc('inbox_close', { p_sessions: ids });

export const assign = (sessionId, assigneeId, teamId) =>
    rpc('inbox_assign', { p_session: sessionId, p_assignee: assigneeId || null, p_team: teamId || null }).then(one);

export const transfer = (sessionId, toUser, toTeam, reason) =>
    rpc('inbox_transfer', { p_session: sessionId, p_to_user: toUser || null, p_to_team: toTeam || null, p_reason: reason }).then(one);

export const addTag = (sessionId, tagId) => rpc('inbox_add_tag', { p_session: sessionId, p_tag: tagId });
export const removeTag = (sessionId, tagId) => rpc('inbox_remove_tag', { p_session: sessionId, p_tag: tagId });

export const addNote = (sessionId, body, mentions) =>
    rpc('inbox_add_note', { p_session: sessionId, p_body: body, p_mentions: mentions || [] }).then(one);
export const editNote = (noteId, body) => rpc('inbox_edit_note', { p_note: noteId, p_body: body }).then(one);
export const deleteNote = (noteId) => rpc('inbox_delete_note', { p_note: noteId });
export const forwardAsNote = (messageId, toSessionId) =>
    rpc('inbox_forward_as_note', { p_message: messageId, p_to_session: toSessionId }).then(one);

export const setArchived = (sessionId, archived) =>
    rpc('inbox_set_archived', { p_session: sessionId, p_archived: archived }).then(one);

export const saveTeam = (id, name, description) =>
    rpc('inbox_save_team', { p_id: id || null, p_name: name, p_description: description || null }).then(one);
export const archiveTeam = (id) => rpc('inbox_archive_team', { p_id: id });
export const setTeamMember = (teamId, userId, role) =>
    rpc('inbox_set_team_member', { p_team: teamId, p_user: userId, p_role: role || null });

/** الردود الجاهزة من جدول canned_responses — نفس اللي بتستخدمه صفحة التذاكر. */
export async function loadCannedReplies() {
    try {
        return await fetchCannedResponses();
    } catch (err) {
        console.warn('[inbox] الردود الجاهزة ماتحمّلتش:', err?.message || err);
        return [];
    }
}

/** توقيع صور المحادثة (المستودع خاص) — نفس مسار صفحة العميل. */
export async function signImagePaths(paths) {
    if (!paths?.length) return [];
    return signedUrls(CHAT_ATTACHMENTS_BUCKET, paths);
}

/**
 * Realtime. RLS بتحدد اللي يوصل: الموظف بيستقبل أحداث المحادثات اللي
 * يوصلها بس (054 ضافت الجداول دي للـ publication).
 * @returns {() => void} إلغاء الاشتراك
 */
export function subscribeInbox(handlers) {
    const on = (table, event, fn) => ch.on('postgres_changes', { event, schema: 'public', table },
        (payload) => fn?.(payload.eventType, payload.new, payload.old));
    const ch = supabase.channel('admin-inbox');
    on('chat_messages', 'INSERT', (_t, row) => handlers.onMessage?.(row));
    on('chat_sessions', '*', handlers.onSession);
    on('inbox_conversations', '*', handlers.onMeta);
    on('inbox_conversation_tags', '*', handlers.onTag);
    on('inbox_notes', '*', handlers.onNote);
    on('inbox_events', 'INSERT', (_t, row) => handlers.onEvent?.(row));
    ch.subscribe();
    return () => supabase.removeChannel(ch);
}
