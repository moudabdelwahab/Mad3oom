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
 * العناوين: عنوان ذكي من أول رسالة للمستخدم — تُحذف التحية والطلب المهذب
 * ويُقصّ عند أول نهاية جملة — يصبح عنوان الجلسة عند إرسالها، إلا إن أعاد
 * المستخدم تسميتها يدويًا — فتُحفظ معرّفات الجلسات المُعاد تسميتها في
 * localStorage ولا تكتب التسمية التلقائية فوقها أبدًا. بطاقة الجلسة تعرض
 * أيضًا معاينة آخر رسالة حقيقية ووقتًا نسبيًا ونقطة حالة (بانتظار رد أم
 * تم الرد)، والمحادثات مجمّعة تحت عناوين اليوم وأمس وهذا الأسبوع وأقدم،
 * مع بحث يصفّي العنوان والمعاينة.
 * الحذف يطلب تأكيدًا، ويحذف رسائل الجلسة صراحةً ثم الجلسة نفسها (وإن كان
 * المفتاح الخارجي ON DELETE CASCADE يحذفها تلقائيًا أيضًا).
 *
 * الإرسال: insert واحد في ai_session_messages فقط (role=user، وموديل
 * الجلسة النشطة)، وتظهر الرسالة فورًا من نتيجة الـ insert. الرد يصل عبر
 * المسار السريع (الترحيل 132: trigger ينادي Edge Function ‏muse-chat-reply‏
 * فور الإدخال) أو عبر الجسر الدائم كاحتياطي؛ الصفحة تشترك في Realtime
 * على رسائل الجلسة النشطة فيستدعي كل إدخال جديد الاستطلاع فورًا،
 * والاستطلاع كل 5 ثوانٍ شبكة أمان فقط — يتوقف تمامًا أثناء اتصال
 * Realtime السليم، ويعود عند انقطاعه بمهلة تتضاعف مع كل فشل متتالٍ
 * حتى دقيقة (pollRetryDelay)، فلا تبقى قراءات مضاعفة دائمة.
 * لا حالة حضور — لا شيء منها حقيقي هنا. فقاعة الانتظار حقيقية: تظهر من طابع إرسال رسالة بلا رد،
 * وتختفي بوصول الرد — ومراحلها («يقرأ رسالتك…» ثم «يراجع…» ثم «يجهّز
 * الرد…») تسميات زمنية من الثواني المنصرمة، لا قياس لخطوات الجسر
 * الداخلية ولا ادعاء أن Muse يكتب حرفًا حرفًا.
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
 * الكوتة: بطاقة صغيرة في الترويسة — شريط تقدّم بالنسبة المتبقية ونص
 * المستخدَم والخطة وتاريخ التجديد بالعربية وآخر تحديث، من الجلسة
 * النشطة extensions.quota فقط (parseQuota يحلّل صيغتي اللقطة الحيّتين
 * إلى أرقام عربية). اللقطة مصدرها الجسر وحده — لا مصدر كوتة آخر
 * موثوق في القاعدة (ai_usage_events أحداث نداءات مزوّدين بلا حد
 * اشتراك) — فلا رقم من أي مصدر آخر ولا رقم مخترع. عند غياب اللقطة
 * تظهر رسالة صريحة بذلك (لا تلميح صامت)، وإن كانت اللقطة أقدم من
 * آخر رد مساعد تُعرض أرقامها الأخيرة مع تحذير صريح بقدمها
 * (quotaSnapshotState) — فتوقف الجسر عن تحديث الكوتة لا يختفي بصمت.
 */
import {
    supabase, bootOwnerPage, announce, esc, friendlyError, errorBlock, loadingBlock,
} from '/assets/js/owner/owner-page.js';
import {
    MUSE_MODEL_ID,
    POLL_MS, MESSAGES_LIMIT, mergeMessages, pollRetryDelay, isRealtimeLive,
    quotaSnapshotState, quotaMissingText, QUOTA_STALE_TEXT, QUOTA_STALE_RESET_TEXT,
    formatAdditionalTokens,
    formatWaitSeconds, formatReplyTook, secondsBetween, waitingSince,
    agentForModelId, agentModelIds, sortSessions, pickActiveSession,
    deriveSmartTitle, isRenamed, withRenamed, withoutRenamed, shouldAutoTitle,
    hasUserMessage, parseQuota, formatQuotaDate, RENAMED_SESSIONS_KEY, ACTIVE_SESSION_KEY,
    REACTION_EMOJIS, toggleReaction, reactionsOf, clampMenuPosition, quotePreview,
    formatRelativeTime, groupSessionsByDate, previewOfLastMessage,
    sessionStatus, SESSION_STATUS_LABEL, dateSeparatorLabel, shouldShowDateSeparator,
    replyTookFor, formatReplyDuration, formatMessageTime, formatMessageTimestamp,
    thinkingStage,
} from '/assets/js/owner/muse-chat-state.js';
import { createMuseAvatar, museAvatarSvg } from '/assets/js/owner/muse-avatar.js';

const $ = (id) => document.getElementById(id);
const MESSAGE_COLUMNS = 'id, role, content, created_at, reactions, reply_to';
const SESSION_COLUMNS = 'id, title, model_id, status, extensions, last_active_at, created_at';
const RENAME_MAX = 80;
const LONG_PRESS_MS = 600;

/** إعادة قراءة الكوتة دوريًا حتى بلا رسائل جديدة. */
const QUOTA_REFRESH_MS = 30000;

let ownerId = null;
let sessionId = null;
let activeModelId = MUSE_MODEL_ID;
let sessions = [];
let messages = [];
const renderedIds = new Set();
let sending = false;
let pollTimeout = null;
let pollFailures = 0;
/** هل اتصال Realtime حي؟ أثناء حياته يتوقف الاستطلاع تمامًا. */
let realtimeLive = false;
let realtimeChannel = null;
let lastQuotaRefreshAt = 0;
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

/* معاينات القائمة الجانبية: آخر رسالة لكل جلسة (دور ونص وطابع)، تُقرأ مرة
   عند التحميل وتُحدَّث محليًا من رسائل الجلسة النشطة — لا تُعاد قراءتها
   مع كل استطلاع حتى لا تتحول كل 5 ثوانٍ إلى استعلام لكل جلسة. */
let sessionPreviews = new Map();

/* نص البحث في القائمة الجانبية — يصفّي العنوان والمعاينة معًا. */
let searchQuery = '';

/* فقاعة الانتظار: عنصر واحد يُعاد استخدامه، لا عنصر جديد كل ثانية. */
let thinkingEl = null;

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

function messageNode(m, tookSeconds = null) {
    const el = document.createElement('article');
    el.className = `muse-msg muse-msg--${m.role === 'user' ? 'user' : 'assistant'}`;
    el.dataset.messageId = m.id;
    el.dataset.reactions = JSON.stringify(reactionsOf(m));
    el.dataset.replyTo = m.reply_to || '';
    // مدة الرد — من طابعي رسالة المستخدم السابقة والرد نفسه، لا رقم ثابت.
    const took = m.role === 'assistant' && tookSeconds !== null
        ? `<span class="muse-msg-took">${esc(formatReplyDuration(tookSeconds))}</span>` : '';
    const body = `
        <div class="muse-msg-body">
            ${quoteHtml(m)}
            <p class="muse-msg-text">${esc(m.content)}</p>
            ${reactionsHtml(m)}
            <time class="muse-msg-time" datetime="${esc(m.created_at || '')}" title="${esc(formatMessageTimestamp(m.created_at))}">${esc(formatMessageTime(m.created_at))}</time>
            ${took}
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

function dateSeparatorNode(label) {
    const el = document.createElement('div');
    el.className = 'muse-date-separator';
    el.innerHTML = `<span>${esc(label)}</span>`;
    return el;
}

function appendNew(box, incoming) {
    const stick = nearBottom(box);
    // فقاعة الانتظار تبقى آخر عنصر دائمًا: تُرفع مؤقتًا وتُعاد بعد الإلحاق.
    const thinking = thinkingEl;
    if (thinking && thinking.parentNode === box) box.removeChild(thinking);
    let added = 0;
    for (const m of incoming) {
        if (renderedIds.has(m.id)) {
            refreshMessageExtras(box, m);
            continue;
        }
        renderedIds.add(m.id);
        const idx = messages.findIndex((x) => x && x.id === m.id);
        const prev = idx > 0 ? messages[idx - 1] : null;
        if (shouldShowDateSeparator(prev, m)) {
            box.appendChild(dateSeparatorNode(dateSeparatorLabel(m.created_at)));
        }
        box.appendChild(messageNode(m, replyTookFor(messages, m)));
        added++;
    }
    if (thinking) box.appendChild(thinking);
    if (added && stick) box.scrollTop = box.scrollHeight;
    return added;
}

function renderMessages(box) {
    box.innerHTML = '';
    renderedIds.clear();
    thinkingEl = null;
    if (!messages.length) {
        box.innerHTML = `<div class="state-block state-block--compact">
            <p class="state-text">لا رسائل بعد — اكتب أول رسالة لـ ${esc(agentForModelId(activeModelId).shortLabel)} بالأسفل.</p></div>`;
        return;
    }
    appendNew(box, messages);
    box.scrollTop = box.scrollHeight;
    if (waitingSinceAt) showThinking(box);
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
    await loadSessionPreviews();
}

/**
 * آخر رسالة لكل جلسة — استعلام واحد لكل جلسة بالتوازي عند التحميل فقط،
 * لمعاينة البطاقة وحالتها (بانتظار رد أم تم الرد). فشل جلسة لا يوقف
 * الباقيات، وغياب الرسائل يعني جلسة بلا رسائل لا خطأ.
 */
async function loadSessionPreviews() {
    const results = await Promise.allSettled(sessions.map(async (session) => {
        const { data, error } = await supabase.from('ai_session_messages')
            .select('role, content, created_at')
            .eq('session_id', session.id)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (error) throw error;
        return [session.id, data || null];
    }));
    for (const result of results) {
        if (result.status === 'fulfilled' && result.value[1]) {
            sessionPreviews.set(result.value[0], result.value[1]);
        }
    }
    renderSessionList();
}

/** آخر رسالة لجلسة: من رسائل الجلسة النشطة المحملة، أو من المعاينة المخزنة. */
function lastMessageFor(session) {
    if (session.id === sessionId && messages.length) return messages[messages.length - 1];
    return sessionPreviews.get(session.id) || null;
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
    subscribeRealtime();
    updateSquareHeader();
    renderAgentPicker();
    renderSessionList();
    try {
        await loadMessages();
        if (token !== switchToken) return;
        // حداثة لقطة الكوتة تُحسب من رسائل هذه الجلسة — حدّث البطاقة بعد تحميلها.
        updateQuotaDisplay(target);
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

/**
 * عرض الكوتة من الجلسة النشطة: بطاقة بشريط تقدّم ونسبة وتجديد وآخر
 * تحديث — أو رسالة صريحة عند غياب اللقطة، وتحذير صريح بقدمها إن كانت
 * أقدم من آخر رد مساعد. حداثة اللقطة من طابع آخر رد مساعد في الرسائل
 * المحمّلة نفسها (قراءة مباشرة من ai_session_messages) — لا رقم
 * مخترع ولا إخفاء صامت لتوقف الجسر. كل نص ديناميكي يمر عبر esc،
 * والنسبة للشريط رقم محلَّل لا نص خام.
 */
function lastAssistantAt() {
    let last = null;
    for (const m of messages) {
        if (m?.role === 'assistant' && m.created_at) {
            if (!last || new Date(m.created_at) > new Date(last)) last = m.created_at;
        }
    }
    return last;
}

function updateQuotaDisplay(session) {
    const el = $('museQuota');
    if (!el) return;
    const quota = session?.extensions?.quota;
    const parsed = parseQuota(session?.extensions?.quota);
    const snapshotState = quotaSnapshotState(quota, lastAssistantAt());
    el.hidden = false;
    if (!parsed) {
        el.classList.remove('is-low');
        el.innerHTML = `<span class="muse-quota-empty">${esc(quotaMissingText(!!lastAssistantAt()))}</span>`;
        return;
    }
    const bar = parsed.pct !== null
        ? `<div class="muse-quota-bar" role="progressbar" aria-valuenow="${parsed.pct}" aria-valuemin="0" aria-valuemax="100" aria-label="المتبقي من الكوتة"><span class="muse-quota-bar-fill" style="width:${parsed.pct}%"></span></div>`
        : '';
    const meta = [
        parsed.usedPct !== null ? `المستخدَم ${parsed.usedPct}%` : '',
        parsed.planLabel ? `الخطة: ${esc(parsed.planLabel)}` : '',
        parsed.resetLabel ? `التجديد: ${esc(parsed.resetLabel)}` : '',
        parsed.updatedAt ? `آخر تحديث: ${esc(formatQuotaDate(parsed.updatedAt) || '')}` : '',
    ].filter(Boolean).join(' • ');
    const tokensText = formatAdditionalTokens(parsed.additionalTokens);
    const tokensBar = parsed.additionalTokens?.usedPct !== null && parsed.additionalTokens?.usedPct !== undefined
        ? `<div class="muse-quota-tokens-bar" role="progressbar" aria-valuenow="${parsed.additionalTokens.usedPct}" aria-valuemin="0" aria-valuemax="100" aria-label="التوكنز الإضافية المستخدَمة"><span class="muse-quota-tokens-fill" style="width:${parsed.additionalTokens.usedPct}%"></span></div>`
        : '';
    el.classList.toggle('is-low', parsed.low);
    el.innerHTML = `
        <div class="muse-quota-top">
            <span class="muse-quota-label">المتبقي من الكوتة</span>
            <strong class="muse-quota-value">${esc(parsed.remainingLabel)}</strong>
        </div>
        ${bar}
        ${meta ? `<div class="muse-quota-meta">${meta}</div>` : ''}
        ${tokensText ? `<div class="muse-quota-tokens"><span>توكنز إضافية: ${esc(tokensText)}</span>${tokensBar}</div>` : ''}
        ${parsed.low ? '<div class="muse-quota-low">الكوتة أوشكت على النفاد — أقل من 20% متبقٍ.</div>' : ''}
        ${snapshotState === 'stale' ? `<div class="muse-quota-stale">${esc(parsed.resetPast ? QUOTA_STALE_RESET_TEXT : QUOTA_STALE_TEXT)}</div>` : ''}`;
}

/** إعادة قراءة extensions للجلسة النشطة — الجسر يحدّث quota فيها. */
async function refreshQuota() {
    if (!sessionId) return;
    lastQuotaRefreshAt = Date.now();
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

    const last = lastMessageFor(session);
    const status = sessionStatus(last);
    const statusLabel = SESSION_STATUS_LABEL[status];
    const preview = previewOfLastMessage(last);
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'muse-session-open';
    openBtn.setAttribute('aria-current', session.id === sessionId ? 'true' : 'false');
    const badge = agent.specialty
        ? `<span class="muse-session-badge">${esc(agent.specialty)}</span>` : '';
    openBtn.innerHTML = `
        <span class="muse-session-title-row">
            <span class="muse-session-dot muse-session-dot--${status}" title="${esc(statusLabel)}" aria-label="${esc(statusLabel)}"></span>
            <span class="muse-session-title">${esc(session.title || 'جلسة جديدة')}</span>
        </span>
        ${preview ? `<span class="muse-session-preview">${esc(preview)}</span>` : ''}
        <span class="muse-session-foot">
            <span class="muse-session-time">${esc(formatRelativeTime(session.last_active_at || session.created_at))}</span>
            ${badge}
        </span>`;
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
    const query = searchQuery.trim().toLowerCase();
    const visible = !query ? sessions : sessions.filter((session) => {
        const haystack = `${session.title || ''} ${previewOfLastMessage(lastMessageFor(session))}`.toLowerCase();
        return haystack.includes(query);
    });
    for (const group of groupSessionsByDate(visible)) {
        const heading = document.createElement('li');
        heading.className = 'muse-session-group';
        heading.textContent = group.label;
        list.appendChild(heading);
        for (const session of group.sessions) list.appendChild(sessionItemNode(session));
    }
    const empty = $('museSessionsEmpty');
    empty.hidden = visible.length > 0;
    empty.textContent = query
        ? 'لا نتائج مطابقة للبحث.'
        : 'لا محادثات بعد — ابدأ محادثة جديدة.';
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
        sessionPreviews.delete(id);
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
            // حدّث معاينة الجلسة النشطة وحالتها من آخر رسالة فعلية.
            const last = messages[messages.length - 1];
            if (last) {
                sessionPreviews.set(sessionId, last);
                renderSessionList();
            }
        }
        // الكوتة قد تتحدّث بلا رسائل جديدة (لقطة الجسر) — حدّثها كل 30 ثانية.
        if (Date.now() - lastQuotaRefreshAt > QUOTA_REFRESH_MS) refreshQuota();
        checkReplyArrived();
    } catch (err) {
        pollFailures++;
        if (pollFailures === 2) {
            say('تعذّر تحديث الرسائل — ستُعاد المحاولة تلقائيًا.', 'error');
        }
        console.error('[MuseChat] poll failed:', err?.message || err);
    }
}

/* ── Realtime: إدخال جديد في الجلسة النشطة يستدعي الاستطلاع فورًا ──
 * الترحيل 132 يضيف ai_session_messages إلى publication ‏supabase_realtime‏،
 * فيصل الرد (أو الإقرار الفوري) لحظة إدخاله بدل انتظار دورة الاستطلاع.
 * الاستطلاع شبكة أمان فقط: يتوقف تمامًا أثناء اتصال Realtime السليم
 * (SUBSCRIBED)، ويعود عند انقطاعه بمهلة backoff — فلا تبقى قراءتان
 * متوازيتان دائمًا. عند تبديل الجلسة تُستبدل القناة بقناة الجلسة
 * الجديدة؛ وعند مغادرة الصفحة تُزال القناة مع المؤقت. */

/** إيقاف مؤقت الاستطلاع — يُستدعى عند حياة Realtime وعند مغادرة الصفحة. */
function stopPolling() {
    if (pollTimeout) clearTimeout(pollTimeout);
    pollTimeout = null;
}

/**
 * جدولة دورة الاستطلاع التالية — لا شيء يُجدول أثناء اتصال Realtime
 * سليم؛ النداء آمن التكرار (يلغي المؤقت السابق أولًا).
 */
function armPollTimer(delay = POLL_MS) {
    stopPolling();
    if (realtimeLive) return;
    pollTimeout = setTimeout(pollCycle, delay);
}

/** دورة استطلاع واحدة ثم إعادة الجدولة بمهلة backoff عند الفشل المتتالي. */
async function pollCycle() {
    await pollMessages();
    armPollTimer(pollRetryDelay(pollFailures));
}

function subscribeRealtime() {
    try {
        if (realtimeChannel) {
            supabase.removeChannel(realtimeChannel);
            realtimeChannel = null;
        }
        if (!sessionId) return;
        // حتى يكتمل الاشتراك يبقى الاستطلاع يعمل؛ SUBSCRIBED يوقفه.
        realtimeLive = false;
        armPollTimer(POLL_MS);
        realtimeChannel = supabase.channel(`muse-chat-${sessionId}`)
            .on('postgres_changes', {
                event: 'INSERT', schema: 'public', table: 'ai_session_messages',
                filter: `session_id=eq.${sessionId}`,
            }, () => { pollMessages(); })
            .subscribe((status) => {
                if (isRealtimeLive(status)) {
                    realtimeLive = true;
                    stopPolling();
                    return;
                }
                console.warn('[MuseChat] realtime not subscribed:', status);
                // انقطاع أو فشل اشتراك: عودة الاستطلاع كشبكة أمان بمهلة backoff.
                realtimeLive = false;
                armPollTimer(pollRetryDelay(pollFailures));
            });
    } catch (err) {
        console.error('[MuseChat] realtime subscribe failed:', err?.message || err);
        realtimeLive = false;
        armPollTimer(pollRetryDelay(pollFailures));
    }
}

function setReplyStatus(text, waiting) {
    const el = $('museReplyStatus');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('is-waiting', !!waiting);
}

/* ─────────────────── فقاعة الانتظار: نقاط ومرحلة وعدّاد ─────────────────── */

/**
 * فقاعة الانتظار — ثلاث نقاط نابضة + مرحلة زمنية + عدّاد ثوانٍ حي.
 * تظهر فقط من طابع إرسال حقيقي (رسالة مستخدم بلا رد)، وتُبنى مرة واحدة
 * وتُحدَّث نصًا كل ثانية — لا عنصر جديد مع كل نبضة.
 */
function showThinking(box) {
    if (thinkingEl) {
        if (thinkingEl.parentNode !== box) box.appendChild(thinkingEl);
        return;
    }
    const el = document.createElement('div');
    el.className = 'muse-thinking';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = `
        <span class="muse-msg-avatar" aria-hidden="true">${museAvatarSvg()}</span>
        <span class="muse-thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="muse-thinking-text">Muse يفكر…</span>
        <span class="muse-thinking-stage"></span>
        <span class="muse-thinking-timer">0 ث</span>`;
    thinkingEl = el;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
}

/** تحديث نص الفقاعة كل ثانية: المرحلة من الثواني المنصرمة والعدّاد. */
function updateThinking(seconds) {
    if (!thinkingEl) return;
    const stage = thinkingEl.querySelector('.muse-thinking-stage');
    const timer = thinkingEl.querySelector('.muse-thinking-timer');
    if (stage) stage.textContent = thinkingStage(seconds);
    if (timer) timer.textContent = `${Math.max(0, Math.floor(seconds))} ث`;
}

function hideThinking() {
    if (thinkingEl) thinkingEl.remove();
    thinkingEl = null;
}

/** من لحظة الإرسال: الأفاتار يفكّر، والعدّاد يحسب ثوانٍ حقيقية كل ثانية. */
function startWaiting(sentAt) {
    stopWaitTimer();
    waitingSinceAt = sentAt || new Date().toISOString();
    if (avatar) avatar.setState('thinking');
    setReplyStatus(formatWaitSeconds(0), true);
    showThinking($('museChatMessages'));
    updateThinking(0);
    waitTimer = setInterval(() => {
        if (!waitingSinceAt) return;
        const seconds = secondsBetween(waitingSinceAt, new Date().toISOString());
        setReplyStatus(formatWaitSeconds(seconds), true);
        updateThinking(seconds);
    }, 1000);
}

function stopWaitTimer() {
    if (waitTimer) clearInterval(waitTimer);
    waitTimer = null;
    hideThinking();
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
        // أول رسالة في الجلسة تسمّيها بعنوان ذكي من محتواها — إلا إن أعاد
        // المستخدم تسميتها يدويًا. تحديث آخر نشاط أيضًا حتى تبقى الجلسة
        // في أعلى القائمة، ومعاينتها من الرسالة المرسلة فعلًا.
        try {
            const patch = { last_active_at: new Date().toISOString() };
            const title = isFirstUserMessage && shouldAutoTitle(activeSession, renamedIds)
                ? deriveSmartTitle(text) : '';
            if (title) patch.title = title;
            const { error: patchError } = await supabase.from('ai_sessions')
                .update(patch)
                .eq('id', sessionId)
                .eq('owner_id', ownerId);
            if (patchError) throw patchError;
            sessions = sessions.map((s) => (s.id === sessionId
                ? { ...s, ...(title ? { title } : {}), last_active_at: patch.last_active_at } : s));
            sessionPreviews.set(sessionId, data);
            renderSessionList();
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
        armPollTimer(POLL_MS);
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
    $('museSessionSearch').addEventListener('input', (e) => {
        searchQuery = e.target.value;
        renderSessionList();
    });
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

// إيقاف الاستطلاع والقناة والعدّاد والأفاتار عند مغادرة الصفحة حتى لا يبقى مؤقت معلّق.
window.addEventListener('pagehide', () => {
    stopPolling();
    if (realtimeChannel) supabase.removeChannel(realtimeChannel);
    stopWaitTimer();
    if (avatar) avatar.destroy();
});
