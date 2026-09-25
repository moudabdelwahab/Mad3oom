/**
 * inbox-model.js — منطق صندوق الرسائل من غير أي وصول لقاعدة البيانات
 * ------------------------------------------------------------
 * كل دالة هنا بتاخد بيانات وترجّع بيانات. مفيش Supabase ولا DOM، عشان
 * القواعد اللي بتحدد «مين قال إيه» و«المحادثة دي محتاجة رد ولا لأ»
 * تتختبر لوحدها (assets/js/admin/tests/).
 *
 * ------------------------------------------------------------
 * الجداول الحقيقية — ومفيش غيرها
 *
 *   chat_sessions  id, user_id, guest_id, status ('active'|'closed'),
 *                  is_manual_mode, bot_state, created_at, updated_at
 *   chat_messages  id, session_id, sender_id, message_text, image_url,
 *                  is_admin_reply, is_bot_reply, created_at
 *
 * ودي نفس الجداول اللي بيكتب فيها ويدجت الشات (chat-widget.js) وصفحة
 * شات العميل (chat-logic.js) ومحرك SIE. الصندوق **بيقرا** اللي هما
 * كتبوه، وبيكتب رد الدعم بنفس الشكل اللي هما مستنيينه — مفيش نظام شات
 * تاني ولا جداول جديدة.
 *
 * أي خاصية مالهاش عمود هنا (إسناد، وسوم، ملاحظات داخلية، أرشفة،
 * مجموعات…) مش موجودة في الصندوق، لأن عرضها كان هيبقى وعد كداب.
 */

export const STATUS_LABELS = { active: 'نشطة', closed: 'مقفولة' };

/**
 * الأدوار اللي لو فتحت محادثة من حسابها كعميل، الفريق لازم ياخد باله إنها
 * مش عميل عادي. منقولة من صفحة الأدمن القديمة (chat-admin.html) زي ما هي.
 */
export const STAFF_ROLES_AS_CUSTOMER = ['admin', 'support'];

/**
 * مين كتب الرسالة.
 *
 * الترتيب مهم: رد الدعم بيتعلّم is_admin_reply، والبوت (المحلي أو SIE)
 * بيتعلّم is_bot_reply. رسالة من غير مُرسِل ومن غير أي علامة بتتحسب بوت —
 * العميل دايمًا بيكتب بـ sender_id بتاعه.
 *
 * @returns {'agent'|'bot'|'customer'}
 */
export function senderKind(message) {
    if (message?.is_admin_reply) return 'agent';
    if (message?.is_bot_reply || !message?.sender_id) return 'bot';
    return 'customer';
}

export function displayName(session) {
    const c = session?.customer;
    if (c?.full_name) return c.full_name;
    if (c?.email) return c.email;
    if (!session?.user_id) return 'زائر';
    return 'عميل مجهول';
}

/** أول حرفين من الاسم — بديل الصورة الرمزية. */
export function initialsOf(name) {
    return String(name || '؟').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('') || '؟';
}

export function isStaffOriginated(session) {
    return STAFF_ROLES_AS_CUSTOMER.includes(session?.customer?.role);
}

function byCreatedAt(a, b) {
    return new Date(a.created_at) - new Date(b.created_at);
}

/** الرسايل بترتيبها الزمني — ترتيب الـ embed في PostgREST مش مضمون. */
export function sortMessages(messages) {
    return [...(messages || [])].sort(byCreatedAt);
}

export function lastMessageOf(session) {
    const list = session?.messages || [];
    return list.length ? list[list.length - 1] : null;
}

/** آخر نشاط: آخر رسالة، وإلا تحديث الجلسة، وإلا إنشاؤها. */
export function lastActivityOf(session) {
    return lastMessageOf(session)?.created_at || session?.updated_at || session?.created_at || null;
}

/**
 * العميل كتب وماحدش من الدعم رد بعده.
 *
 * البوت بيرد تلقائيًا على كل رسالة وهو شغال، فرد البوت مش بيقفل الحاجة
 * للرد إلا لو المحادثة مع البوت فعلاً. لما الدعم ماسك المحادثة
 * (is_manual_mode) البوت ساكت، فآخر رسالة من العميل = مستني الدعم.
 */
export function isAwaitingReply(session) {
    if (session?.status !== 'active') return false;
    const list = session.messages || [];
    for (let i = list.length - 1; i >= 0; i--) {
        const kind = senderKind(list[i]);
        if (kind === 'agent') return false;
        if (kind === 'customer') return session.is_manual_mode ? true : i === list.length - 1;
    }
    return false;
}

export const VIEWS = ['all', 'awaiting', 'open', 'manual', 'bot', 'closed'];

export function matchesView(session, view) {
    switch (view) {
        case 'awaiting': return isAwaitingReply(session);
        case 'open': return session.status === 'active';
        case 'manual': return session.status === 'active' && !!session.is_manual_mode;
        case 'bot': return session.status === 'active' && !session.is_manual_mode;
        case 'closed': return session.status === 'closed';
        default: return true;
    }
}

/**
 * البحث بيدوّر في الاسم والإيميل ونص الرسايل — الناس بتفتكر اللي اتقال
 * أكتر ما بتفتكر مع مين.
 */
export function matchesQuery(session, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    const hay = [
        displayName(session), session.customer?.email || '',
        ...(session.messages || []).map((m) => m.message_text || '')
    ].join(' ').toLowerCase();
    return hay.includes(q);
}

/**
 * محادثات الفريق فوق دايمًا (زي ما كانت في chat-admin.html) عشان
 * ماتتوهش وسط العملاء، وبعدين الأحدث نشاطًا. ده ترتيب عرض بس، مش صلاحيات.
 */
export function compareSessions(a, b) {
    const staff = Number(isStaffOriginated(b)) - Number(isStaffOriginated(a));
    if (staff) return staff;
    return new Date(lastActivityOf(b) || 0) - new Date(lastActivityOf(a) || 0);
}

export function filterSessions(sessions, { view = 'all', query = '' } = {}) {
    return (sessions || [])
        .filter((s) => matchesView(s, view))
        .filter((s) => matchesQuery(s, query))
        .sort(compareSessions);
}

export function viewCounts(sessions) {
    return Object.fromEntries(VIEWS.map((v) => [v, (sessions || []).filter((s) => matchesView(s, v)).length]));
}

export function messageStats(messages) {
    const stats = { customer: 0, bot: 0, agent: 0, images: 0 };
    for (const m of messages || []) {
        stats[senderKind(m)] += 1;
        if (m.image_url) stats.images += 1;
    }
    return stats;
}

/**
 * الرد الجاهز في جدول canned_responses بيتكتب مرة لكل العملاء، فبنبدّل
 * `{{الاسم}}` (أو `{{name}}`) باسم العميل وقت الإدراج.
 */
export function fillCannedReply(body, session) {
    const name = session?.customer?.full_name || '';
    return String(body || '').replace(/\{\{\s*(?:الاسم|name)\s*\}\}/gi, name);
}

/** قراءة رقم الجلسة من الرابط: `?session=` (إشعارات القاعدة) أو `?session_id=` (سجل العميل). */
export function sessionIdFromSearch(search) {
    const params = new URLSearchParams(search || '');
    return params.get('session') || params.get('session_id') || null;
}
