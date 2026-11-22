/**
 * owner/muse-chat.html — شات Muse الوكيل الداخلي في لوحة المالك.
 *
 * الجلسة: صف ai_sessions واحد بموديل muse يملكه المستخدم الحالي. الصفحة
 * تجد الجلسة النشطة الأقدم، وإن لم توجد أنشأتها بنفس إعداد الجلسة التجريبية
 * الحالية (عنوان/وضع/توجيه/ترحيب) — ولا تنشئ مكررًا ما دامت واحدة موجودة.
 *
 * الإرسال: insert واحد في ai_session_messages فقط (role=user, model_id=muse)،
 * وتظهر الرسالة فورًا من نتيجة الـ insert. الرد يصل عبر الجسر الذي يفحص
 * الجلسة كل دقيقة؛ الصفحة تستطلع الرسائل الجديدة كل 5 ثوانٍ فتظهر بلا تحديث
 * يدوي. لا Realtime، ولا مؤشر كتابة، ولا حالة حضور — لا شيء منها حقيقي هنا.
 *
 * لا تلمس هذه الصفحة أي جدول غير ai_sessions (إنشاء الجلسة عند غيابها فقط)
 * و ai_session_messages (قراءة وإرسال). لا SIE، ولا شات عملاء.
 */
import {
    supabase, bootOwnerPage, announce, esc, when, friendlyError, errorBlock, loadingBlock,
} from '/assets/js/owner/owner-page.js';
import {
    MUSE_MODEL_ID, MUSE_SESSION_TITLE, MUSE_SYSTEM_PROMPT, MUSE_GREETING,
    POLL_MS, MESSAGES_LIMIT, mergeMessages,
} from '/assets/js/owner/muse-chat-state.js';

const $ = (id) => document.getElementById(id);
const MESSAGE_COLUMNS = 'id, role, content, created_at';

let sessionId = null;
let messages = [];
const renderedIds = new Set();
let sending = false;
let pollTimer = null;
let pollFailures = 0;

const say = (text, tone = 'info') => announce($('pageStatus'), text, tone);

/** هل المستخدم قريب من أسفل القائمة؟ يُحفظ التمرير ولا يُقفز به أثناء القراءة. */
function nearBottom(box) {
    return box.scrollHeight - box.scrollTop - box.clientHeight < 140;
}

function messageNode(m) {
    const el = document.createElement('article');
    el.className = `muse-msg muse-msg--${m.role === 'user' ? 'user' : 'assistant'}`;
    el.dataset.messageId = m.id;
    el.innerHTML = `
        <p class="muse-msg-text">${esc(m.content)}</p>
        <time class="muse-msg-time" datetime="${esc(m.created_at || '')}">${esc(when(m.created_at))}</time>`;
    return el;
}

function appendNew(box, incoming) {
    const stick = nearBottom(box);
    let added = 0;
    for (const m of incoming) {
        if (renderedIds.has(m.id)) continue;
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
            <p class="state-text">لا رسائل بعد — اكتب أول رسالة لـ Muse بالأسفل.</p></div>`;
        return;
    }
    appendNew(box, messages);
    box.scrollTop = box.scrollHeight;
}

/** أقدم جلسة Muse نشطة يملكها المستخدم الحالي، أو null. */
async function findSession(ownerId) {
    const { data, error } = await supabase.from('ai_sessions')
        .select('id, title, status')
        .eq('owner_id', ownerId)
        .eq('model_id', MUSE_MODEL_ID)
        .eq('status', 'active')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
    if (error) throw error;
    return data || null;
}

/** إنشاء الجلسة عند غيابها فقط — مع إعادة فحص قبل الإدراج ضد نافذة سباق. */
async function createSession(ownerId) {
    const existing = await findSession(ownerId);
    if (existing) return existing;

    const { data, error } = await supabase.from('ai_sessions')
        .insert({
            owner_id: ownerId,
            title: MUSE_SESSION_TITLE,
            mode: 'chat',
            model_id: MUSE_MODEL_ID,
            status: 'active',
            system_prompt: MUSE_SYSTEM_PROMPT,
        })
        .select('id, title, status')
        .single();
    if (error) throw error;

    // الترحيب محاولة لطيفة لا توقف الصفحة لو فشلت؛ الحالة الفارغة تغطي غيابه.
    try {
        await supabase.from('ai_session_messages').insert({
            session_id: data.id, role: 'assistant', content: MUSE_GREETING, model_id: MUSE_MODEL_ID,
        });
    } catch (err) {
        console.error('[MuseChat] greeting insert failed:', err?.message || err);
    }
    return data;
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
        }
    } catch (err) {
        pollFailures++;
        if (pollFailures === 2) {
            say('تعذّر تحديث الرسائل — ستُعاد المحاولة تلقائيًا.', 'error');
        }
        console.error('[MuseChat] poll failed:', err?.message || err);
    }
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
    try {
        const { data, error } = await supabase.from('ai_session_messages')
            .insert({ session_id: sessionId, role: 'user', content: text, model_id: MUSE_MODEL_ID })
            .select(MESSAGE_COLUMNS)
            .single();
        if (error) throw error;
        messages = mergeMessages(messages, [data]);
        appendNew($('museChatMessages'), messages);
        input.value = '';
        input.focus();
    } catch (err) {
        showSendError(`تعذّر إرسال الرسالة: ${friendlyError(err)} — مسودتك محفوظة، جرّب إعادة المحاولة.`);
        input.focus();
    } finally {
        setSending(false);
    }
}

async function loadSession(userId) {
    const box = $('museChatMessages');
    try {
        const session = await findSession(userId) || await createSession(userId);
        sessionId = session.id;
        await loadMessages();
        $('museChatLoadRetry').hidden = true;
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(pollMessages, POLL_MS);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) pollMessages(); });
    } catch (err) {
        box.innerHTML = errorBlock(friendlyError(err));
        $('museChatLoadRetry').hidden = false;
    }
}

async function init() {
    const booted = await bootOwnerPage();
    if (!booted) return;
    $('museChatMessages').innerHTML = loadingBlock();

    $('museChatForm').addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
    $('museChatRetryBtn').addEventListener('click', () => { hideSendError(); sendMessage(); });
    $('museChatLoadRetry').addEventListener('click', () => {
        $('museChatLoadRetry').hidden = true;
        $('museChatMessages').innerHTML = loadingBlock();
        loadSession(booted.session.user.id);
    });

    await loadSession(booted.session.user.id);
}

init().catch((err) => {
    const box = $('museChatMessages');
    if (box) box.innerHTML = errorBlock(friendlyError(err));
    console.error('[MuseChat] init failed:', err?.message || err);
});

// إيقاف الاستطلاع عند مغادرة الصفحة حتى لا يبقى مؤقت معلّق.
window.addEventListener('pagehide', () => { if (pollTimer) clearInterval(pollTimer); });
