/**
 * inbox-data.js — طبقة البيانات لصندوق الرسائل (بيانات حقيقية)
 * ------------------------------------------------------------
 * كل قراءة وكتابة الصندوق بيعملها بتعدي من هنا، على نفس جداول الشات
 * اللي بيستخدمها ويدجت العميل (chat-widget.js) وصفحة شات العميل
 * (chat-logic.js) ومحرك SIE:  chat_sessions / chat_messages.
 *
 * مفيش بيانات تجريبية. الصلاحيات في RLS (has_elevated_authority): الطاقم
 * بيشوف كل الجلسات، وأي حد تاني بيرجعله اللي يخصه بس. الواجهة مش حماية.
 *
 * ------------------------------------------------------------
 * العقد مع ويدجت العميل — ماتغيّرهوش من ناحية واحدة
 *
 * رد الدعم = صف في chat_messages بـ is_admin_reply = true و sender_id =
 * الموظف، **و** chat_sessions.is_manual_mode = true. الويدجت بيسمع
 * الاتنين عن طريق Realtime:
 *   - الرسالة بتظهر عند العميل باسم «فريق الدعم».
 *   - is_manual_mode بيوقّف البوت (المحلي و SIE) وبيعرض «فريق الدعم انضم».
 *   - status = 'closed' بيعرض «فريق الدعم غادر المحادثة».
 * ده نفس اللي كانت بتعمله chat-admin.html بالظبط.
 */
import { supabase } from '/api-config.js';
import { signedUrls } from '/storage-urls.js';
import { fetchCannedResponses } from '/tickets-service.js';
import { sortMessages } from './inbox-model.js';

export const CHAT_ATTACHMENTS_BUCKET = 'chat-attachments';

const MESSAGE_LITE = 'id, session_id, sender_id, message_text, image_url, is_admin_reply, is_bot_reply, created_at';

function normalizeSession(row) {
    const { profiles, chat_messages, ...session } = row;
    return { ...session, customer: profiles || null, messages: sortMessages(chat_messages) };
}

/**
 * كل الجلسات مع صاحبها ونص رسايلها (للمعاينة والبحث والعدّادات).
 * profiles:user_id بيرجع null للزائر.
 */
export async function loadSessions() {
    const { data, error } = await supabase
        .from('chat_sessions')
        .select(`id, user_id, guest_id, status, is_manual_mode, created_at, updated_at,
                 profiles:user_id (full_name, email, role, phone, created_at),
                 chat_messages (${MESSAGE_LITE})`)
        .order('updated_at', { ascending: false });
    if (error) throw error;
    return (data || []).map(normalizeSession);
}

export async function loadSession(sessionId) {
    const { data, error } = await supabase
        .from('chat_sessions')
        .select(`id, user_id, guest_id, status, is_manual_mode, created_at, updated_at,
                 profiles:user_id (full_name, email, role, phone, created_at),
                 chat_messages (${MESSAGE_LITE})`)
        .eq('id', sessionId)
        .maybeSingle();
    if (error) throw error;
    return data ? normalizeSession(data) : null;
}

/** أسماء الموظفين اللي ردّوا — عشان الفريق يعرف مين رد من غير ما يسأل. */
export async function loadStaffNames(ids) {
    const unique = [...new Set((ids || []).filter(Boolean))];
    if (!unique.length) return {};
    const { data, error } = await supabase.from('profiles').select('id, full_name, email').in('id', unique);
    if (error) return {};
    return Object.fromEntries((data || []).map((p) => [p.id, p.full_name || p.email || 'فريق الدعم']));
}

/**
 * رد الدعم. نفس خطوتين chat-admin.html وبنفس الترتيب: نوقّف البوت الأول
 * عشان مايردّش على نفس الرسالة، وبعدين نكتب الرد.
 *
 * @returns {Promise<object>} الصف المكتوب — بيتعرض فورًا ومش بيستنى Realtime.
 */
export async function sendReply({ session, senderId, text }) {
    const body = String(text || '').trim();
    if (!body) throw new Error('الرسالة فاضية.');
    if (session.status === 'closed') throw new Error('المحادثة مقفولة — العميل مش هيشوف الرد.');

    if (!session.is_manual_mode) {
        const { error } = await supabase.from('chat_sessions').update({ is_manual_mode: true }).eq('id', session.id);
        if (error) throw error;
    }

    const { data, error } = await supabase
        .from('chat_messages')
        .insert({ session_id: session.id, sender_id: senderId, message_text: body, is_admin_reply: true })
        .select(MESSAGE_LITE)
        .single();
    if (error) throw error;
    return data;
}

/** إقفال محادثة أو أكتر. الويدجت بيعرض «فريق الدعم غادر المحادثة». */
export async function closeSessions(ids) {
    if (!ids?.length) return;
    const { error } = await supabase.from('chat_sessions').update({ status: 'closed' }).in('id', ids);
    if (error) throw error;
}

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
 * Realtime على الجدولين. RLS بتحدد اللي يوصل، فالطاقم بيستقبل الكل.
 * @returns {() => void} إلغاء الاشتراك
 */
export function subscribeInbox({ onMessage, onSession }) {
    const channel = supabase
        .channel('admin-inbox')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' },
            (payload) => onMessage?.(payload.new))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_sessions' },
            (payload) => onSession?.(payload.eventType, payload.new))
        .subscribe();
    return () => supabase.removeChannel(channel);
}
