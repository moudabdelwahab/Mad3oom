/**
 * inbox-model.js — منطق صندوق الرسائل من غير أي وصول لقاعدة البيانات
 * ------------------------------------------------------------
 * كل دالة هنا بتاخد بيانات وترجّع بيانات. مفيش Supabase ولا DOM، عشان
 * القواعد اللي بتحدد «مين قال إيه» و«المحادثة دي محتاجة رد ولا لأ» و«مين
 * ماسكها» تتختبر لوحدها (assets/js/admin/tests/).
 *
 * ------------------------------------------------------------
 * مصدر البيانات
 *
 *   chat_sessions / chat_messages      المحادثة نفسها — نفس صفوف الويدجت
 *                                      وصفحة العميل و SIE
 *   inbox_conversations                المسؤول، الفريق، الأرشفة
 *   inbox_conversation_tags → ticket_tags   الوسوم
 *   inbox_notes                        ملاحظات داخلية (العميل مايشوفهاش)
 *   inbox_events                       سجل كل إجراء
 *   inbox_teams / inbox_team_members   الفرق
 *
 * migrations/054_inbox_helpdesk_core.sql فيها الجداول والصلاحيات. شكل
 * الجلسة هنا بعد ما inbox-data.js يجمّعها:
 *
 *   { ...chat_sessions, customer, messages[], meta: {assignee_id, team_id,
 *     archived_at, archived_by} | null, tagIds[] }
 */

export const STATUS_LABELS = { active: 'نشطة', closed: 'مقفولة' };

/**
 * الأدوار اللي لو فتحت محادثة من حسابها كعميل، الفريق لازم ياخد باله إنها
 * مش عميل عادي. منقولة من صفحة الأدمن القديمة (chat-admin) زي ما هي.
 */
export const STAFF_ROLES_AS_CUSTOMER = ['admin', 'support'];

/**
 * مين كتب الرسالة.
 *
 * رد الدعم بيتعلّم is_admin_reply، والبوت (المحلي أو SIE) بيتعلّم
 * is_bot_reply. رسالة من غير مُرسِل ومن غير أي علامة بتتحسب بوت — العميل
 * دايمًا بيكتب بـ sender_id بتاعه.
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

function lastCustomerMessageAt(session) {
    const list = session?.messages || [];
    for (let i = list.length - 1; i >= 0; i--) {
        if (senderKind(list[i]) === 'customer') return list[i].created_at;
    }
    return null;
}

/**
 * مؤرشفة فعلاً؟ الأرشفة بتتلغي من نفسها لو العميل كتب بعدها — المحادثة رجعت
 * حية. بيتحسب هنا بدل محفّز على chat_messages (الجدول اللي SIE بيكتب فيه).
 */
export function isArchived(session) {
    const at = session?.meta?.archived_at;
    if (!at) return false;
    const lastCustomer = lastCustomerMessageAt(session);
    return !(lastCustomer && new Date(lastCustomer) > new Date(at));
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

export const VIEWS = ['all', 'awaiting', 'mine', 'team', 'unassigned', 'open', 'manual', 'bot', 'closed', 'archived'];

/**
 * @param {object} ctx { meId, myTeamIds: string[] }
 * المؤرشفة بتختفي من كل المشاهد غير «الأرشيف» — ده معنى الأرشفة أصلاً.
 */
export function matchesView(session, view, ctx = {}) {
    const archived = isArchived(session);
    if (view === 'archived') return archived;
    if (archived) return false;

    const meta = session.meta || {};
    switch (view) {
        case 'awaiting': return isAwaitingReply(session);
        case 'mine': return !!ctx.meId && meta.assignee_id === ctx.meId;
        case 'team': return !!meta.team_id && (ctx.myTeamIds || []).includes(meta.team_id);
        case 'unassigned': return !meta.assignee_id && !meta.team_id && session.status === 'active';
        case 'open': return session.status === 'active';
        case 'manual': return session.status === 'active' && !!session.is_manual_mode;
        case 'bot': return session.status === 'active' && !session.is_manual_mode;
        case 'closed': return session.status === 'closed';
        default: return true;
    }
}

/**
 * البحث بيدوّر في الاسم والإيميل ونص الرسايل وأسماء الوسوم — الناس
 * بتفتكر اللي اتقال أكتر ما بتفتكر مع مين.
 */
export function matchesQuery(session, query, tagNames = {}) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    const hay = [
        displayName(session), session.customer?.email || '',
        ...(session.tagIds || []).map((id) => tagNames[id] || ''),
        ...(session.messages || []).map((m) => m.message_text || '')
    ].join(' ').toLowerCase();
    return hay.includes(q);
}

/**
 * محادثات الفريق فوق دايمًا (زي ما كانت في chat-admin) عشان ماتتوهش وسط
 * العملاء، وبعدين الأحدث نشاطًا. ده ترتيب عرض بس، مش صلاحيات.
 */
export function compareSessions(a, b) {
    const staff = Number(isStaffOriginated(b)) - Number(isStaffOriginated(a));
    if (staff) return staff;
    return new Date(lastActivityOf(b) || 0) - new Date(lastActivityOf(a) || 0);
}

export function filterSessions(sessions, { view = 'all', query = '', ctx = {}, tagNames = {}, tagId = null } = {}) {
    return (sessions || [])
        .filter((s) => matchesView(s, view, ctx))
        .filter((s) => !tagId || (s.tagIds || []).includes(tagId))
        .filter((s) => matchesQuery(s, query, tagNames))
        .sort(compareSessions);
}

export function viewCounts(sessions, ctx = {}) {
    return Object.fromEntries(VIEWS.map((v) => [v, (sessions || []).filter((s) => matchesView(s, v, ctx)).length]));
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
 * الخط الزمني للمحادثة: رسايل العميل والبوت والدعم، والملاحظات الداخلية،
 * وأحداث السجل — كلهم بترتيب حصولهم. الملاحظة والحدث بيتعرضوا بشكل مختلف
 * تمامًا عن الرسالة، عشان يبان بنص نظرة إن العميل مش شايفهم.
 *
 * @returns {Array<{type:'message'|'note'|'event', at:string, item:object}>}
 */
export function buildTimeline(messages, notes = [], events = []) {
    // أحداث ليها أثر ظاهر بالفعل في الخط الزمني مابتتكررش كسطر.
    const hidden = new Set(['note_added', 'note_edited', 'note_deleted', 'forwarded_as_note']);
    return [
        ...(messages || []).map((m) => ({ type: 'message', at: m.created_at, item: m })),
        ...(notes || []).map((n) => ({ type: 'note', at: n.created_at, item: n })),
        ...(events || []).filter((e) => !hidden.has(e.kind)).map((e) => ({ type: 'event', at: e.created_at, item: e }))
    ].sort((a, b) => new Date(a.at) - new Date(b.at));
}

/**
 * سطر الحدث بالعربي.
 * @param {object} names { agent(id)→string, team(id)→string, actor(id)→string }
 */
export function describeEvent(event, names = {}) {
    const p = event?.payload || {};
    const actor = names.actor?.(event.actor_id) || 'حد من الفريق';
    const agent = (id) => names.agent?.(id) || 'موظف';
    const team = (id) => names.team?.(id) || 'فريق';
    const target = (user, teamId) => [user ? agent(user) : null, teamId ? `فريق ${team(teamId)}` : null]
        .filter(Boolean).join(' — ');

    switch (event?.kind) {
        case 'assigned': return `${actor} أسند المحادثة لـ ${target(p.to_user, p.to_team)}`;
        case 'unassigned': return `${actor} شال المسؤول عن المحادثة`;
        case 'transferred': return `${actor} حوّل المحادثة لـ ${target(p.to_user, p.to_team)}${p.reason ? ` — ${p.reason}` : ''}`;
        case 'tagged': return `${actor} ضاف وسم «${p.name || ''}»`;
        case 'untagged': return `${actor} شال وسم «${p.name || ''}»`;
        case 'archived': return `${actor} أرشف المحادثة`;
        case 'unarchived': return p.reason === 'reply' ? 'المحادثة رجعت من الأرشيف بالرد' : `${actor} رجّع المحادثة من الأرشيف`;
        case 'closed': return `${actor} قفل المحادثة`;
        default: return `${actor}: ${event?.kind || 'إجراء'}`;
    }
}

/**
 * المنشن: «@الاسم الكامل» لموظف من القايمة. المطابقة على الاسم الكامل عشان
 * «@أحمد» مايمنشنش كل الأحمدات.
 */
export function extractMentions(body, agents = []) {
    let text = String(body || '');
    const found = [];
    // الأطول الأول، والاسم لازم يخلص عند مسافة أو علامة ترقيم — وإلا «@أحمد»
    // بتلقط جوه «@أحمد علي» وتمنشن اتنين.
    const byLength = (agents || []).filter((a) => a.full_name).sort((a, b) => b.full_name.length - a.full_name.length);
    for (const agent of byLength) {
        const escaped = agent.full_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`@${escaped}(?=$|[\\s.,،!?؟:؛)])`, 'g');
        if (pattern.test(text)) {
            found.push(agent.id);
            text = text.replace(pattern, ' ');
        }
    }
    return found;
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
