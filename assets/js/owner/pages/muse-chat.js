/**
 * owner/muse-chat.html — شات Muse الوكيل الداخلي في لوحة المالك.
 *
 * التصميم: مربع واحد في المنتصف — ترويسة فيها أفاتار Muse المتحرك
 * وحالته وأزرار التحكم فيه، ومنطقة رسائل، وإدخال — وبجانبه قائمة
 * المحادثات واختيار الوكيل.
 *
 * الجلسات: كل جلسات المالك النشطة بموديلات الوكلاء (Muse الرئيسي والوكيل
 * المساعد العام muse-assistant) تظهر في قائمة واحدة بعلامة تميّز جلسات
 * المساعد. «محادثة جديدة» تنشئ جلسة للوكيل المختار حاليًا؛ اختيار وكيل
 * يفتح أحدث جلساته أو ينشئ واحدة بتوجيهه العام إن لم توجد. التبديل بين
 * الجلسات يبدّل الرسائل والعدّاد معها، فتوقيت الرد يتبع آخر رسالة بلا رد
 * في الجلسة النشطة.
 *
 * العناوين: عنوان أول رسالة للمستخدم (مقصوصًا) يصبح عنوان الجلسة عند
 * إرسالها، إلا إن أعاد المستخدم تسميتها يدويًا — فتُحفظ معرّفات الجلسات
 * المُعاد تسميتها في localStorage ولا تكتب التسمية التلقائية فوقها أبدًا.
 * الحذف يطلب تأكيدًا، ويحذف رسائل الجلسة صراحةً ثم الجلسة نفسها (وإن كان
 * المفتاح الخارجي ON DELETE CASCADE يحذفها تلقائيًا أيضًا).
 *
 * الإرسال: insert واحد في ai_session_messages فقط (role=user، وموديل
 * الجلسة النشطة)، وتظهر الرسالة فورًا من نتيجة الـ insert. الرد يصل عبر
 * الجسر الذي يفحص الجلسة كل دقيقة؛ الصفحة تستطلع الرسائل الجديدة كل 5
 * ثوانٍ فتظهر بلا تحديث يدوي. لا Realtime، ولا مؤشر كتابة، ولا حالة
 * حضور — لا شيء منها حقيقي هنا.
 *
 * قائمة سياق الرسالة: كليك يمين (أو ضغطة طويلة على اللمس) على أي فقاعة
 * يفتح قائمة فيها تفاعلات وردّ ونسخ. التفاعل يُحفظ في reactions (jsonb،
 * قائمة إيموجي) والرد يُحفظ في reply_to (معرّف الرسالة الأصلية) — عمودان
 * إضافيان في ai_session_messages لا يقرأهما الجسر ولا يكتب فيهما،
 * فيبقى الرد عبر الجسر كما هو.
 *
 * الأفاتار: حالاته مرتبطة بأحداث حقيقية — خمول أثناء الانتظار، تفكير من
 * لحظة الإرسال حتى وصول الرد، كلام لحظة وصول الرد، انتباه عند تركيز
 * الإدخال. عدّاد الانتظار يعرض ثوانٍ حقيقية منصرمة منذ الإرسال، وعند
 * وصول الرد يعرض كم ثانية استغرق — من طابعي الإرسال والرد أنفسهما.
 *
 * لا تلمس هذه الصفحة أي جدول غير ai_sessions (إنشاء الجلسة عند غيابها
 * فقط، وتحديث عنوانها وآخر نشاط، وحذفها؛ وقراءة extensions لعرض الكوتة)
 * و ai_session_messages (قراءة وإرسال وحذف عند حذف الجلسة). لا SIE، ولا
 * شات عملاء، ولا تفعيل حسابات أخرى — التجربة على حساب المالك الحالي فقط.
 *
 * الكوتة: ترويسة المربع تعرض «المتبقي من الكوتة: …» (مع الخطة والتجديد
 * عند وجودهما) فقط عندما تحمل الجلسة النشطة extensions.quota بقيمة
 * remaining؛ وتُخفى تمامًا عند غيابها. لا رقم من أي مصدر آخر، ولا رقم
 * مخترع — والجسر هو من يحدّث quota في extensions.
 */
import {
    supabase, bootOwnerPage, announce, esc, when, friendlyError, errorBlock, loadingBlock,
} from '/assets/js/owner/owner-page.js';
import {
    MUSE_MODEL_ID,
    POLL_MS, MESSAGES_LIMIT, mergeMessages,
    formatWaitSeconds, formatReplyTook, secondsBetween, waitingSince,
    agentForModelId, agentModelIds, sortSessions, pickActiveSession,
    deriveTitle, isRenamed, withRenamed, withoutRenamed, shouldAutoTitle,
    hasUserMessage, formatQuota, RENAMED_SESSIONS_KEY, ACTIVE_SESSION_KEY,
    REACTION_EMOJIS, toggleReaction, reactionsOf, clampMenuPosition, quotePreview,
} from '/assets/js/owner/muse-chat-state.js';
import { createMuseAvatar, museAvatarSvg } from '/assets/js/owner/muse-avatar.js';

const $ = (id) => document.getElementById(id);
const MESSAGE_COLUMNS = 'id, role, content, created_at, reactions, reply_to';
const SESSION_COLUMNS = 'id, title, model_id, status, extensions, last_active_at, created_at';
const RENAME_MAX = 80;
const LONG_PRESS_MS = 600;

let ownerId = null;
let sessionId = null;
let activeModelId = MUSE_MODEL_ID;
let sessions = [];
let messages = [];
const renderedIds = new Set();
let sending = false;
let pollTimer = null;
let pollFailures = 0;
let switchToken = 0;
let renamedIds = new Set();
let pendingDeleteId = null;

/* قائمة سياق الرسالة: معرّف الرسالة المستهدفة، وشريط الرد المعلّق عليها. */
let menuMessageId = null;
let replyTargetId = null;
let longPressTimer = null;

/* توقيت الرد: طابع إرسال آخر رسالة بلا رد، ومؤقت العدّاد الحي. */
let avatar = null;
let waitTimer = null;
let waitingSinceAt = null;

const say = (text, tone = 'info') => announce($('pageStatus'), text, tone);

/** هل المستخدم قريب من أسفل القائمة؟ يُحفظ التمرير ولا يُقفز به أثناء القراءة. */
function nearBottom(box) {
    return box.scrollHeight - box.scrollTop - box.clientHeight < 140;
}

/** الاقتباس فوق نص الرسالة: نص الرسالة الأصلية إن وُجدت، وإلا «رسالة سابقة». */
function quoteHtml(m) {
    if (!m.reply_to) return '';
    const original = messages.find((x) => x && x.id === m.reply_to);
    const text = original ? quotePreview(original.content) : 'رسالة سابقة';
    return `<blockquote class="muse-msg-quote">رد على: ${esc(text)}</blockquote>`;
}

/**
 * شارة التفاعلات تحت نص الرسالة: تعرض فقط التفاعلات المحفوظة فعلًا في
 * reactions — بلا عدد ولا تفاعل مخترع. الضغط على إيموجي يبدّل تفاعله.
 */
function reactionsHtml(m) {
    const list = reactionsOf(m);
    if (!list.length) return '';
    const chips = list.map((e) =>
        `<button type="button" class="muse-msg-reaction" data-emoji="${esc(e)}"
            title="اضغط لإزالة التفاعل" aria-label="إزالة التفاعل ${esc(e)}">${esc(e)}</button>`).join('');
    return `<div class="muse-msg-reactions" role="group" aria-label="تفاعلات الرسالة">${chips}</div>`;
}

function messageNode(m) {
    const el = document.createElement('article');
    el.className = `muse-msg muse-msg--${m.role === 'user' ? 'user' : 'assistant'}`;
    el.dataset.messageId = m.id;
    el.dataset.reactions = JSON.stringify(reactionsOf(m));
    el.dataset.replyTo = m.reply_to || '';
    const body = `
        <div class="muse-msg-body">
            ${quoteHtml(m)}
            <p class="muse-msg-text">${esc(m.content)}</p>
            ${reactionsHtml(m)}
            <time class="muse-msg-time" datetime="${esc(m.created_at || '')}">${esc(when(m.created_at))}</time>
        </div>`;
    // رسائل المساعد تحمل علامة الأفاتار الصغيرة الثابتة — نفس الـ SVG بلا حركة.
    el.innerHTML = m.role === 'user'
        ? body
        : `<span class="muse-msg-avatar" aria-hidden="true">${museAvatarSvg()}</span>${body}`;
    el.querySelectorAll('.muse-msg-reaction').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleMessageReaction(m.id, btn.dataset.emoji);
        });
    });
    return el;
}

/**
 * تحديث اقتباس رسالة معروضة وشارتها دون إعادة رسم القائمة كلها: يُستدعى
 * من الاستطلاع عند تغيّر reactions أو reply_to لرسالة معروضة فعلًا.
 */
function refreshMessageExtras(box, m) {
    const el = box.querySelector(`[data-message-id="${CSS.escape(m.id)}"]`);
    if (!el) return;
    const reactionsJson = JSON.stringify(reactionsOf(m));
    if (el.dataset.reactions === reactionsJson && el.dataset.replyTo === (m.reply_to || '')) return;
    el.dataset.reactions = reactionsJson;
    el.dataset.replyTo = m.reply_to || '';
    const body = el.querySelector('.muse-msg-body');
    if (!body) return;
    const oldQuote = body.querySelector('.muse-msg-quote');
    if (oldQuote) oldQuote.remove();
    const oldReactions = body.querySelector('.muse-msg-reactions');
    if (oldReactions) oldReactions.remove();
    const textEl = body.querySelector('.muse-msg-text');
    if (quoteHtml(m)) textEl.insertAdjacentHTML('beforebegin', quoteHtml(m));
    if (reactionsHtml(m)) {
        textEl.insertAdjacentHTML('afterend', reactionsHtml(m));
        body.querySelectorAll('.muse-msg-reaction').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleMessageReaction(m.id, btn.dataset.emoji);
            });
        });
    }
}

function appendNew(box, incoming) {
    const stick = nearBottom(box);
    let added = 0;
    for (const m of incoming) {
        if (renderedIds.has(m.id)) {
            refreshMessageExtras(box, m);
            continue;
        }
        renderedIds.add(m.id);
        box.appendChild(messageNode(m));
        added++;
    }
    if (added && stick) box.scrollTop = box.scrollHeight;
    return added;
}

function renderMessages(box) {
    box.innerHTML = '';
    renderedIds.clear();
    if (!messages.length) {
        box.innerHTML = `<div class="state-block state-block--compact">
            <p class="state-text">لا رسائل بعد — اكتب أول رسالة لـ ${esc(agentForModelId(activeModelId).shortLabel)} بالأسفل.</p></div>`;
        return;
    }
    appendNew(box, messages);
    box.scrollTop = box.scrollHeight;
}

/* ─────────────────── قائمة سياق الرسالة: تفاعل وردّ ونسخ ─────────────────── */

/** بناء صف الإيموجي في القائمة من المجموعة الثابتة — مصدر واحد للتفاعلات. */
function buildMenuReactions() {
    const row = $('museMsgMenuReactions');
    row.innerHTML = '';
    for (const emoji of REACTION_EMOJIS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'muse-msg-menu-emoji';
        btn.textContent = emoji;
        btn.setAttribute('role', 'menuitem');
        btn.setAttribute('aria-label', `تفاعل بـ ${emoji}`);
        btn.addEventListener('click', () => { toggleMessageReaction(menuMessageId, emoji); });
        row.appendChild(btn);
    }
}

function menuMessage() {
    return messages.find((m) => m && m.id === menuMessageId) || null;
}

function closeMsgMenu() {
    if (!$('museMsgMenu').hidden) $('museMsgMenu').hidden = true;
    menuMessageId = null;
}

/**
 * فتح قائمة السياق عند المؤشر: كليك يمين على فقاعة رسالة (مستخدم أو
 * مساعد) يمنع قائمة المتصفح ويفتح قائمتنا مقصوصة داخل النافذة.
 */
function openMsgMenu(messageId, x, y) {
    const target = messages.find((m) => m && m.id === messageId);
    if (!target) return;
    menuMessageId = messageId;
    const menu = $('museMsgMenu');
    menu.hidden = false;
    const { left, top } = clampMenuPosition(
        x, y, menu.offsetWidth, menu.offsetHeight,
        window.innerWidth, window.innerHeight);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.querySelector('.muse-msg-menu-emoji')?.focus();
}

function wireMsgMenu() {
    const box = $('museChatMessages');
    const menu = $('museMsgMenu');

    buildMenuReactions();

    box.addEventListener('contextmenu', (e) => {
        const bubble = e.target.closest('.muse-msg');
        if (!bubble?.dataset.messageId) return;
        e.preventDefault();
        openMsgMenu(bubble.dataset.messageId, e.clientX, e.clientY);
    });

    // ضغطة طويلة على اللمس تفتح القائمة نفسها؛ أي حركة أو رفع يلغيها.
    box.addEventListener('touchstart', (e) => {
        const bubble = e.target.closest('.muse-msg');
        if (!bubble?.dataset.messageId || e.touches.length !== 1) return;
        const touch = e.touches[0];
        clearTimeout(longPressTimer);
        longPressTimer = setTimeout(() => {
            openMsgMenu(bubble.dataset.messageId, touch.clientX, touch.clientY);
        }, LONG_PRESS_MS);
    }, { passive: true });
    box.addEventListener('touchmove', () => clearTimeout(longPressTimer), { passive: true });
    box.addEventListener('touchend', () => clearTimeout(longPressTimer), { passive: true });
    box.addEventListener('touchcancel', () => clearTimeout(longPressTimer), { passive: true });

    // الإغلاق: نقرة خارج القائمة، أو Escape، أو تمرير قائمة الرسائل.
    document.addEventListener('click', (e) => {
        if (!menu.hidden && !menu.contains(e.target)) closeMsgMenu();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !menu.hidden) closeMsgMenu();
    });
    box.addEventListener('scroll', () => closeMsgMenu(), { passive: true, capture: true });

    $('museMsgMenuReply').addEventListener('click', () => {
        const target = menuMessage();
        closeMsgMenu();
        if (target) startReply(target);
    });
    $('museMsgMenuCopy').addEventListener('click', async () => {
        const target = menuMessage();
        closeMsgMenu();
        if (!target) return;
        const ok = await copyMessageText(target.content || '');
        say(ok ? 'تم النسخ.' : 'تعذّر النسخ — انسخ النص يدويًا.', ok ? 'info' : 'error');
    });
}

/**
 * نسخ نص الرسالة: Clipboard API أولًا، وبديل textarea + execCommand عند
 * غيابها (سياق غير آمن أو متصفح قديم) — فالنسخ لا يفشل بصمت.
 */
async function copyMessageText(text) {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (err) {
        /* سقط الـ API بعد فحصه — جرّب البديل بدل الفشل. */
    }
    try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
    } catch (err) {
        console.error('[MuseChat] copy failed:', err?.message || err);
        return false;
    }
}

/** تبديل تفاعل على رسالة: تحديث متفائل في الواجهة، ثم حفظه في القاعدة. */
async function toggleMessageReaction(messageId, emoji) {
    const target = messages.find((m) => m && m.id === messageId);
    if (!target || !REACTION_EMOJIS.includes(emoji)) return;
    closeMsgMenu();
    const next = toggleReaction(reactionsOf(target), emoji);
    const previous = reactionsOf(target);
    target.reactions = next;
    refreshMessageExtras($('museChatMessages'), target);
    try {
        const { error } = await supabase.from('ai_session_messages')
            .update({ reactions: next })
            .eq('id', messageId)
            .eq('session_id', sessionId);
        if (error) throw error;
    } catch (err) {
        target.reactions = previous;
        refreshMessageExtras($('museChatMessages'), target);
        say(`تعذّر حفظ التفاعل: ${friendlyError(err)}`, 'error');
        console.error('[MuseChat] reaction failed:', err?.message || err);
    }
}

/* ─────────────────── الرد على رسالة ─────────────────── */

/** إظهار شريط الرد فوق الإدخال مع اقتباس الرسالة الأصلية. */
function startReply(target) {
    replyTargetId = target.id;
    $('museReplyQuote').textContent = `رد على: ${quotePreview(target.content) || 'رسالة'}`;
    $('museReplyBar').hidden = false;
    $('museChatInput').focus();
}

function cancelReply() {
    replyTargetId = null;
    $('museReplyBar').hidden = true;
    $('museReplyQuote').textContent = '';
}

/* ─────────────────── حالة التسمية والجلسة النشطة المحفوظة ─────────────────── */

function loadRenamedIds() {
    try {
        const raw = localStorage.getItem(RENAMED_SESSIONS_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        renamedIds = new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []);
    } catch (err) {
        renamedIds = new Set();
    }
}

function saveRenamedIds() {
    try {
        localStorage.setItem(RENAMED_SESSIONS_KEY, JSON.stringify([...renamedIds]));
    } catch (err) {
        console.error('[MuseChat] save renamed failed:', err?.message || err);
    }
}

function readStoredActiveSession() {
    try {
        return localStorage.getItem(ACTIVE_SESSION_KEY) || null;
    } catch (err) {
        return null;
    }
}

function storeActiveSession(id) {
    try {
        if (id) localStorage.setItem(ACTIVE_SESSION_KEY, id);
        else localStorage.removeItem(ACTIVE_SESSION_KEY);
    } catch (err) {
        /* التخزين المحلي قد يكون معطلًا — الجلسة النشطة تبقى في الذاكرة فقط. */
    }
}

/* ─────────────────── الجلسات: تحميل وإنشاء وتبديل ─────────────────── */

/** كل جلسات المالك النشطة لوكلاء الشات، الأحدث نشاطًا أولًا. */
async function loadSessionsList() {
    const { data, error } = await supabase.from('ai_sessions')
        .select(SESSION_COLUMNS)
        .eq('owner_id', ownerId)
        .in('model_id', agentModelIds())
        .eq('status', 'active')
        .order('last_active_at', { ascending: false });
    if (error) throw error;
    sessions = sortSessions(data || []);
    renderSessionList();
}

/** إنشاء جلسة جديدة للوكيل — بتوجيهه المتخصص وعنوانه وترحيبه. */
async function createSession(modelId) {
    const agent = agentForModelId(modelId);
    const { data, error } = await supabase.from('ai_sessions')
        .insert({
            owner_id: ownerId,
            title: agent.label,
            mode: 'chat',
            model_id: agent.modelId,
            status: 'active',
            system_prompt: agent.systemPrompt,
        })
        .select(SESSION_COLUMNS)
        .single();
    if (error) throw error;

    // الترحيب محاولة لطيفة لا توقف الصفحة لو فشلت؛ الحالة الفارغة تغطي غيابه.
    try {
        await supabase.from('ai_session_messages').insert({
            session_id: data.id, role: 'assistant', content: agent.greeting, model_id: agent.modelId,
        });
    } catch (err) {
        console.error('[MuseChat] greeting insert failed:', err?.message || err);
    }
    sessions = sortSessions([data, ...sessions]);
    renderSessionList();
    return data;
}

/** أحدث جلسة نشطة للوكيل، أو إنشاء واحدة بتوجيهه إن لم توجد. */
async function findOrCreateAgentSession(modelId) {
    const existing = sessions.find((s) => s.model_id === modelId);
    if (existing) return existing;
    return createSession(modelId);
}

async function loadMessages() {
    const { data, error } = await supabase.from('ai_session_messages')
        .select(MESSAGE_COLUMNS)
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true })
        .limit(MESSAGES_LIMIT);
    if (error) throw error;
    messages = mergeMessages([], data || []);
    renderMessages($('museChatMessages'));
}

/** التبديل لجلسة: الرسائل والعدّاد والترويسة والقائمة تتبع الجلسة الجديدة. */
async function switchSession(id) {
    const target = sessions.find((s) => s.id === id);
    if (!target) return;
    const token = ++switchToken;
    stopWaitTimer();
    waitingSinceAt = null;
    closeMsgMenu();
    cancelReply();
    sessionId = target.id;
    activeModelId = target.model_id;
    storeActiveSession(sessionId);
    updateSquareHeader();
    renderAgentPicker();
    renderSessionList();
    try {
        await loadMessages();
        if (token !== switchToken) return;
        // رسالة بلا رد في هذه الجلسة؟ استأنف العدّاد من طابع إرسالها الحقيقي.
        const pending = waitingSince(messages);
        if (pending) startWaiting(pending);
        else setStatusReady();
    } catch (err) {
        if (token !== switchToken) return;
        $('museChatMessages').innerHTML = errorBlock(friendlyError(err));
        $('museChatLoadRetry').hidden = false;
    }
}

/** اختيار وكيل: يفتح أحدث جلساته أو ينشئ واحدة — وقائمة الجلسات تبقى شاملة. */
async function openAgent(modelId) {
    if (!agentModelIds().includes(modelId)) return;
    activeModelId = modelId;
    renderAgentPicker();
    try {
        const session = await findOrCreateAgentSession(modelId);
        await switchSession(session.id);
    } catch (err) {
        say(`تعذّر فتح محادثة ${agentForModelId(modelId).label}: ${friendlyError(err)}`, 'error');
        console.error('[MuseChat] open agent failed:', err?.message || err);
    }
}

async function newChat() {
    try {
        const session = await createSession(activeModelId);
        await switchSession(session.id);
        $('museChatInput').focus();
        say(`محادثة جديدة مع ${agentForModelId(activeModelId).label}.`, 'info');
    } catch (err) {
        say(`تعذّر إنشاء محادثة جديدة: ${friendlyError(err)}`, 'error');
        console.error('[MuseChat] new chat failed:', err?.message || err);
    }
}

/* ─────────────────── قائمة الجلسات واختيار الوكيل ─────────────────── */

function updateSquareHeader() {
    const agent = agentForModelId(activeModelId);
    $('museChatHeading').textContent = agent.label;
    $('museChatInput').placeholder = `اكتب رسالتك لـ ${agent.shortLabel}…`;
    updateQuotaDisplay(sessions.find((s) => s.id === sessionId) || null);
}

/** عرض الكوتة من الجلسة النشطة فقط — تُخفى تمامًا عند غياب quota. */
function updateQuotaDisplay(session) {
    const el = $('museQuota');
    if (!el) return;
    const text = formatQuota(session?.extensions?.quota);
    if (text) {
        el.textContent = text;
        el.hidden = false;
    } else {
        el.textContent = '';
        el.hidden = true;
    }
}

/** إعادة قراءة extensions للجلسة النشطة — الجسر يحدّث quota فيها. */
async function refreshQuota() {
    if (!sessionId) return;
    try {
        const { data, error } = await supabase.from('ai_sessions')
            .select('extensions')
            .eq('id', sessionId)
            .maybeSingle();
        if (error || !data) return;
        const session = sessions.find((s) => s.id === sessionId);
        if (session) session.extensions = data.extensions;
        updateQuotaDisplay(session || { extensions: data.extensions });
    } catch (err) {
        console.error('[MuseChat] quota refresh failed:', err?.message || err);
    }
}

function renderAgentPicker() {
    document.querySelectorAll('.muse-agent-chip').forEach((chip) => {
        const isActive = chip.dataset.modelId === activeModelId;
        chip.classList.toggle('is-active', isActive);
        chip.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
}

function sessionItemNode(session) {
    const agent = agentForModelId(session.model_id);
    const li = document.createElement('li');
    li.className = 'muse-session-item';
    if (session.id === sessionId) li.classList.add('is-active');
    li.dataset.sessionId = session.id;

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'muse-session-open';
    openBtn.setAttribute('aria-current', session.id === sessionId ? 'true' : 'false');
    const badge = agent.specialty
        ? `<span class="muse-session-badge">${esc(agent.specialty)}</span>` : '';
    openBtn.innerHTML = `
        <span class="muse-session-title">${esc(session.title || 'جلسة جديدة')}</span>
        ${badge}
        <span class="muse-session-time">${esc(when(session.last_active_at || session.created_at))}</span>`;
    openBtn.addEventListener('click', () => { switchSession(session.id); });

    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'muse-session-icon-btn';
    renameBtn.textContent = '✎';
    renameBtn.setAttribute('aria-label', `إعادة تسمية «${session.title || 'جلسة جديدة'}»`);
    renameBtn.title = 'إعادة تسمية';
    renameBtn.addEventListener('click', (e) => { e.stopPropagation(); startRename(li, session); });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'muse-session-icon-btn muse-session-icon-btn--danger';
    deleteBtn.textContent = '✕';
    deleteBtn.setAttribute('aria-label', `حذف «${session.title || 'جلسة جديدة'}»`);
    deleteBtn.title = 'حذف المحادثة';
    deleteBtn.addEventListener('click', (e) => { e.stopPropagation(); askDeleteSession(session); });

    const actions = document.createElement('span');
    actions.className = 'muse-session-actions';
    actions.append(renameBtn, deleteBtn);

    li.append(openBtn, actions);
    return li;
}

function renderSessionList() {
    const list = $('museSessionList');
    list.innerHTML = '';
    for (const session of sessions) list.appendChild(sessionItemNode(session));
    $('museSessionsEmpty').hidden = sessions.length > 0;
}

/* ─────────────────── إعادة التسمية والحذف ─────────────────── */

/** تحويل عنوان الجلسة في القائمة لحقل تحرير: Enter يحفظ، Esc يلغي. */
function startRename(li, session) {
    const titleEl = li.querySelector('.muse-session-title');
    if (!titleEl || li.querySelector('.muse-session-rename-input')) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'muse-session-rename-input';
    input.value = session.title || '';
    input.maxLength = RENAME_MAX;
    input.setAttribute('aria-label', 'اسم جديد للمحادثة');
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
        if (done) return;
        done = true;
        const next = input.value.trim();
        if (save && next && next !== session.title) renameSession(session.id, next);
        else renderSessionList();
    };
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
}

async function renameSession(id, nextTitle) {
    const title = nextTitle.trim().slice(0, RENAME_MAX);
    if (!title) return;
    try {
        const { error } = await supabase.from('ai_sessions')
            .update({ title })
            .eq('id', id)
            .eq('owner_id', ownerId);
        if (error) throw error;
        sessions = sessions.map((s) => (s.id === id ? { ...s, title } : s));
        renamedIds = withRenamed(renamedIds, id);
        saveRenamedIds();
        renderSessionList();
        say(`تمت إعادة تسمية المحادثة إلى «${title}».`, 'info');
    } catch (err) {
        renderSessionList();
        say(`تعذّر إعادة التسمية: ${friendlyError(err)}`, 'error');
        console.error('[MuseChat] rename failed:', err?.message || err);
    }
}

function askDeleteSession(session) {
    pendingDeleteId = session.id;
    $('museDeleteConfirmName').textContent = session.title || 'جلسة جديدة';
    $('museDeleteConfirm').hidden = false;
    $('museDeleteConfirmBtn').focus();
}

function closeDeleteConfirm() {
    pendingDeleteId = null;
    $('museDeleteConfirm').hidden = true;
}

async function deleteSession() {
    const id = pendingDeleteId;
    if (!id) return;
    const target = sessions.find((s) => s.id === id);
    const btn = $('museDeleteConfirmBtn');
    btn.disabled = true;
    btn.textContent = 'جارٍ الحذف…';
    try {
        // حذف الرسائل صراحةً أولًا؛ المفتاح الخارجي ON DELETE CASCADE يحذفها
        // تلقائيًا أيضًا، فالحذف الصريح ضمان إضافي لا يعتمد على القيد وحده.
        const { error: msgError } = await supabase.from('ai_session_messages')
            .delete()
            .eq('session_id', id);
        if (msgError) throw msgError;
        const { error } = await supabase.from('ai_sessions')
            .delete()
            .eq('id', id)
            .eq('owner_id', ownerId);
        if (error) throw error;
        const wasActive = id === sessionId;
        sessions = sessions.filter((s) => s.id !== id);
        renamedIds = withoutRenamed(renamedIds, id);
        saveRenamedIds();
        if (wasActive) {
            storeActiveSession(null);
            sessionId = null;
            stopWaitTimer();
            waitingSinceAt = null;
        }
        closeDeleteConfirm();
        renderSessionList();
        say(`تم حذف المحادثة «${target?.title || 'جلسة جديدة'}» ورسائلها.`, 'info');
        if (wasActive) {
            const next = pickActiveSession(sessions, null);
            if (next) await switchSession(next.id);
            else {
                const created = await createSession(activeModelId);
                await switchSession(created.id);
            }
        }
    } catch (err) {
        closeDeleteConfirm();
        say(`تعذّر حذف المحادثة: ${friendlyError(err)}`, 'error');
        console.error('[MuseChat] delete failed:', err?.message || err);
    } finally {
        btn.disabled = false;
        btn.textContent = 'حذف نهائيًا';
    }
}

/* ─────────────────── الاستطلاع وتوقيت الرد ─────────────────── */

/** آخر 50 رسالة تُدمج بالمعرّف — فلا تفوت رسالة تشارك أخرى نفس الطابع الزمني. */
async function pollMessages() {
    if (!sessionId || sending || document.hidden) return;
    try {
        const { data, error } = await supabase.from('ai_session_messages')
            .select(MESSAGE_COLUMNS)
            .eq('session_id', sessionId)
            .order('created_at', { ascending: false })
            .limit(50);
        if (error) throw error;
        pollFailures = 0;
        const merged = mergeMessages(messages, [...(data || [])].reverse());
        if (merged.length !== messages.length) {
            messages = merged;
            appendNew($('museChatMessages'), messages);
            // رسائل جديدة تعني نشاطًا للجسر — قد يكون حدّث الكوتة معها.
            refreshQuota();
        }
        checkReplyArrived();
    } catch (err) {
        pollFailures++;
        if (pollFailures === 2) {
            say('تعذّر تحديث الرسائل — ستُعاد المحاولة تلقائيًا.', 'error');
        }
        console.error('[MuseChat] poll failed:', err?.message || err);
    }
}

function setReplyStatus(text, waiting) {
    const el = $('museReplyStatus');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('is-waiting', !!waiting);
}

/** من لحظة الإرسال: الأفاتار يفكّر، والعدّاد يحسب ثوانٍ حقيقية كل ثانية. */
function startWaiting(sentAt) {
    stopWaitTimer();
    waitingSinceAt = sentAt || new Date().toISOString();
    if (avatar) avatar.setState('thinking');
    setReplyStatus(formatWaitSeconds(0), true);
    waitTimer = setInterval(() => {
        if (!waitingSinceAt) return;
        setReplyStatus(
            formatWaitSeconds(secondsBetween(waitingSinceAt, new Date().toISOString())), true);
    }, 1000);
}

function stopWaitTimer() {
    if (waitTimer) clearInterval(waitTimer);
    waitTimer = null;
}

/** وصل رد مساعد بعد طابع الإرسال: أوقف العدّاد واعرض كم ثانية استغرق. */
function checkReplyArrived() {
    if (!waitingSinceAt) return;
    const since = new Date(waitingSinceAt);
    const reply = [...messages]
        .filter((m) => m.role === 'assistant' && new Date(m.created_at || 0) > since)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];
    if (!reply) return;
    const took = secondsBetween(waitingSinceAt, reply.created_at);
    waitingSinceAt = null;
    stopWaitTimer();
    setReplyStatus(formatReplyTook(took), false);
    if (avatar) {
        // مدة الكلام من طول الرد الحقيقي — 45 مللي ثانية لكل حرف تقريبًا.
        avatar.setState('speaking', 1500 + 45 * (reply.content || '').length);
    }
}

function setStatusReady() {
    setReplyStatus('جاهز — اكتب رسالتك بالأسفل.', false);
}

function showSendError(message) {
    $('museChatErrorText').textContent = message;
    $('museChatError').hidden = false;
}

function hideSendError() {
    $('museChatError').hidden = true;
    $('museChatErrorText').textContent = '';
}

function setSending(on) {
    sending = on;
    $('museChatInput').disabled = on;
    $('museChatSend').disabled = on;
    $('museChatSend').textContent = on ? 'جارٍ الإرسال…' : 'إرسال';
}

async function sendMessage() {
    const input = $('museChatInput');
    const text = input.value.trim();
    if (!text || sending || !sessionId) return;
    hideSendError();
    setSending(true);
    const isFirstUserMessage = !hasUserMessage(messages);
    const activeSession = sessions.find((s) => s.id === sessionId);
    try {
        const { data, error } = await supabase.from('ai_session_messages')
            .insert({
                session_id: sessionId, role: 'user', content: text,
                model_id: activeModelId, reply_to: replyTargetId || null,
            })
            .select(MESSAGE_COLUMNS)
            .single();
        if (error) throw error;
        messages = mergeMessages(messages, [data]);
        appendNew($('museChatMessages'), messages);
        input.value = '';
        cancelReply();
        input.focus();
        // أول رسالة في الجلسة تسمّيها — إلا إن أعاد المستخدم تسميتها يدويًا.
        // تحديث آخر نشاط أيضًا حتى تبقى الجلسة في أعلى القائمة.
        try {
            const patch = { last_active_at: new Date().toISOString() };
            const title = isFirstUserMessage && shouldAutoTitle(activeSession, renamedIds)
                ? deriveTitle(text) : '';
            if (title) patch.title = title;
            const { error: patchError } = await supabase.from('ai_sessions')
                .update(patch)
                .eq('id', sessionId)
                .eq('owner_id', ownerId);
            if (patchError) throw patchError;
            if (title) {
                sessions = sessions.map((s) => (s.id === sessionId
                    ? { ...s, title, last_active_at: patch.last_active_at } : s));
                renderSessionList();
            }
        } catch (err) {
            console.error('[MuseChat] auto-title failed:', err?.message || err);
        }
        startWaiting(data.created_at || new Date().toISOString());
    } catch (err) {
        showSendError(`تعذّر إرسال الرسالة: ${friendlyError(err)} — مسودتك محفوظة، جرّب إعادة المحاولة.`);
        input.focus();
    } finally {
        setSending(false);
    }
}

async function loadChat(userId) {
    ownerId = userId;
    const box = $('museChatMessages');
    try {
        await loadSessionsList();
        let session = pickActiveSession(sessions, readStoredActiveSession());
        if (!session) session = await createSession(MUSE_MODEL_ID);
        activeModelId = session.model_id;
        await switchSession(session.id);
        $('museChatLoadRetry').hidden = true;
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(pollMessages, POLL_MS);
    } catch (err) {
        box.innerHTML = errorBlock(friendlyError(err));
        $('museChatLoadRetry').hidden = false;
    }
}

async function init() {
    loadRenamedIds();
    const booted = await bootOwnerPage();
    if (!booted) return;
    $('museChatMessages').innerHTML = loadingBlock();

    avatar = createMuseAvatar($('museAvatar'), {
        animBtn: $('museAvatarAnimBtn'),
        paceBtn: $('museAvatarPaceBtn'),
    });

    $('museChatForm').addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
    $('museChatInput').addEventListener('focus', () => { if (avatar) avatar.setState('attention'); });
    $('museChatRetryBtn').addEventListener('click', () => { hideSendError(); sendMessage(); });
    $('museReplyCancel').addEventListener('click', () => { cancelReply(); $('museChatInput').focus(); });
    wireMsgMenu();
    $('museChatLoadRetry').addEventListener('click', () => {
        $('museChatLoadRetry').hidden = true;
        $('museChatMessages').innerHTML = loadingBlock();
        loadChat(booted.session.user.id);
    });
    $('museNewChatBtn').addEventListener('click', () => { newChat(); });
    document.querySelectorAll('.muse-agent-chip').forEach((chip) => {
        chip.addEventListener('click', () => { openAgent(chip.dataset.modelId); });
    });
    $('museDeleteConfirmBtn').addEventListener('click', () => { deleteSession(); });
    $('museDeleteCancelBtn').addEventListener('click', () => { closeDeleteConfirm(); });
    $('museDeleteConfirm').addEventListener('click', (e) => {
        if (e.target === $('museDeleteConfirm')) closeDeleteConfirm();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !$('museDeleteConfirm').hidden) closeDeleteConfirm();
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pollMessages(); });

    await loadChat(booted.session.user.id);
}

init().catch((err) => {
    const box = $('museChatMessages');
    if (box) box.innerHTML = errorBlock(friendlyError(err));
    console.error('[MuseChat] init failed:', err?.message || err);
});

// إيقاف الاستطلاع والعدّاد والأفاتار عند مغادرة الصفحة حتى لا يبقى مؤقت معلّق.
window.addEventListener('pagehide', () => {
    if (pollTimer) clearInterval(pollTimer);
    stopWaitTimer();
    if (avatar) avatar.destroy();
});
