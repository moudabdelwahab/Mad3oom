/**
 * muse-bubble.js — فقاعة Muse العائمة في لوحتي المالك والإدارة فقط.
 *
 * بوابة التفعيل (fail closed): لا يُنشأ أي DOM قبل التحقق من تفعيل Muse
 * للحساب الحالي — getSession ثم قراءة muse_account_activations
 * (owner_id = المستخدم، active = true). أي خطأ أو غياب جلسة أو غياب
 * صف فعّال يعني: لا فقاعة ولا أي أثر في الصفحة. لا كتابة أبدًا في
 * muse_account_activations ولا تفعيل لأي حساب. الخادم نفسه لديه
 * سدّ احتياطي (الترحيل 132: trigger الرد لا يعمل بلا صف تفعيل فعّال)،
 * لكن بوابة العميل هذه مطلوبة أيضًا.
 *
 * الخلفية: نفس نموذج owner/muse-chat.html تمامًا — بلا خلفية جديدة:
 * جلسات ai_sessions (model_id ‏muse / muse-assistant‏، status ‏active‏)،
 * الإرسال insert واحد في ai_session_messages (role=user)، والرد عبر
 * Realtime على الجلسة النشطة + استطلاع كل POLL_MS كشبكة أمان يتوقف
 * أثناء اتصال Realtime السليم ويعود بمهلة backoff عند انقطاعه
 * (pollRetryDelay) — نفس نمط muse-chat.js. لا إرسال تلقائي، ولا تفاعلات
 * ولا ردّ ولا إعادة تسمية ولا حذف داخل الفقاعة (الصفحة الكاملة لديها ذلك).
 *
 * التعايش مع فقاعة SIE (chat-widget.js): مشغّل Muse فوق مشغّل SIE على
 * الجهة نفسها (أسفل اليسار) — انظر ترويسة muse-bubble.css للمواضع الدقيقة.
 * كل المعرّفات ببادئة mb- حتى لا تتصادم مع muse-chat.html أبدًا.
 * لا top-level await؛ التسرب العام الوحيد window.museBubble بعد التركيب.
 */
import { supabase } from '/api-config.js';
import {
    MUSE_MODEL_ID,
    POLL_MS, MESSAGES_LIMIT, mergeMessages, pollRetryDelay, isRealtimeLive,
    parseQuota, quotaSnapshotState, quotaMissingText, QUOTA_STALE_TEXT,
    formatQuota,
    formatWaitSeconds, formatReplyTook, secondsBetween, waitingSince,
    agentForModelId, agentModelIds, sortSessions, pickActiveSession,
    deriveSmartTitle, hasUserMessage, ACTIVE_SESSION_KEY,
    shouldAutoTitle, RENAMED_SESSIONS_KEY,
    thinkingStage, formatMessageTime, formatReplyDuration, replyTookFor,
} from '/assets/js/owner/muse-chat-state.js';
import { createMuseAvatar, museAvatarSvg } from '/assets/js/owner/muse-avatar.js';

const MESSAGE_COLUMNS = 'id, role, content, created_at';
const SESSION_COLUMNS = 'id, title, model_id, status, extensions, last_active_at, created_at';
const QUOTA_REFRESH_MS = 30000;
/** صفحات الشات الكاملة — لا تُركَّب الفقاعة فيها حتى لو أُضيف المحمّل خطأً. */
const FULL_CHAT_PATHS = ['owner/muse-chat.html', 'owner/agent-chat.html', 'admin/inbox.html', 'admin/agent.html'];

let ownerId = null;
let sessionId = null;
let activeModelId = MUSE_MODEL_ID;
let sessions = [];
let messages = [];
let sending = false;
let pollTimeout = null;
let pollFailures = 0;
let realtimeLive = false;
let realtimeChannel = null;
let lastQuotaRefreshAt = 0;
/** آخر كوتة للجلسة النشطة (خام + محللة) — تحرّك حلقة الزر ونافذة التفاصيل معًا. */
let lastQuotaRaw = null;
let lastQuotaParsed = null;
let lastQuotaSnapshot = null;
let quotaPopOpen = false;
let switchToken = 0;
let avatar = null;
let waitTimer = null;
let waitingSinceAt = null;
let thinkingEl = null;
let isOpen = false;
let closeTimer = null;
let destroyed = false;
/** معرّفات الجلسات المُعاد تسميتها يدويًا في الصفحة الكاملة — لا تكتب
   التسمية التلقائية فوقها أبدًا (نفس مفتاح muse-chat.js). */
let renamedIds = new Set();

function loadRenamedIds() {
    try {
        const raw = localStorage.getItem(RENAMED_SESSIONS_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        renamedIds = new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []);
    } catch (err) {
        renamedIds = new Set();
    }
}

/** تنقية نص قبل حقنه في innerHTML — نفس نمط chat-widget.js. */
function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** رسالة خطأ عربية مقروءة من خطأ Supabase — بلا تفاصيل تقنية خام. */
function friendlyError(err) {
    const msg = err?.message || err?.error_description || '';
    if (!msg) return 'خطأ غير معروف';
    return msg;
}

const $ = (id) => document.getElementById(id);

/* ─────────────────── البوابة: تفعيل Muse للحساب الحالي ─────────────────── */

/**
 * هل لحساب المستخدم صف تفعيل فعّال؟ قراءة فقط — لا كتابة ولا تفعيل.
 * أي خطأ (شبكة، RLS، غياب صف) يرجع false فيغلق الباب بصمت.
 */
async function isActivated(userId) {
    try {
        const { data, error } = await supabase.from('muse_account_activations')
            .select('active')
            .eq('owner_id', userId)
            .eq('active', true)
            .maybeSingle();
        if (error) {
            console.warn('[MuseBubble] activation check failed:', error.message || error);
            return false;
        }
        return !!(data && data.active === true);
    } catch (err) {
        console.warn('[MuseBubble] activation check failed:', err?.message || err);
        return false;
    }
}

/* ─────────────────── بناء الواجهة (بعد البوابة فقط) ─────────────────── */

function buildDom() {
    if ($('mb-root')) return;
    const root = document.createElement('div');
    root.id = 'mb-root';
    root.className = 'muse-bubble';
    root.dir = 'rtl';
    root.innerHTML = `
        <button type="button" class="mb-launcher" id="mb-launcher"
            aria-label="فتح شات Muse" aria-controls="mb-panel" aria-expanded="false">
            <span class="mb-launcher-avatar" aria-hidden="true">${museAvatarSvg()}</span>
            <span class="mb-launcher-label">Muse</span>
        </button>
        <section class="mb-panel" id="mb-panel" role="dialog" aria-label="شات Muse" hidden>
            <header class="mb-head">
                <div class="muse-avatar" id="mb-avatar"></div>
                <div class="mb-head-titles">
                    <h2 class="mb-title" id="mb-title">Muse — الوكيل الداخلي</h2>
                    <p class="mb-status" id="mb-status" role="status">جاهز — اكتب رسالتك بالأسفل.</p>
                </div>
                <button type="button" class="mb-close" id="mb-close" aria-label="إغلاق">✕</button>
            </header>
            <div class="mb-agent-row" role="group" aria-label="اختيار الوكيل">
                <button type="button" class="mb-agent-chip is-active" data-model-id="muse" aria-pressed="true">Muse</button>
                <button type="button" class="mb-agent-chip" data-model-id="muse-assistant" aria-pressed="false">المساعد العام</button>
                <button type="button" class="mb-new-chat" id="mb-new-chat">+ محادثة جديدة</button>
            </div>
            <div class="mb-messages" id="mb-messages" role="log" aria-live="polite" aria-label="رسائل المحادثة">
                <div class="mb-empty">جارٍ تحميل المحادثة…</div>
            </div>
            <div class="mb-error" id="mb-error" hidden>
                <p id="mb-error-text" role="alert"></p>
                <button type="button" class="mb-retry" id="mb-retry">إعادة المحاولة</button>
            </div>
            <form class="mb-form" id="mb-form" novalidate>
                <label class="mb-visually-hidden" for="mb-input">اكتب رسالتك لـ Muse</label>
                <input type="text" class="mb-input" id="mb-input" placeholder="اكتب رسالتك لـ Muse…" autocomplete="off" maxlength="2000">
                <button type="button" class="mb-quota-btn" id="mb-quota-btn" aria-label="الكوتة غير متاحة بعد" aria-expanded="false" aria-controls="mb-quota-pop" title="الكوتة غير متاحة بعد">
                    <svg class="mb-quota-ring" viewBox="0 0 36 36" aria-hidden="true">
                        <circle class="mb-quota-ring-track" cx="18" cy="18" r="15.9155"></circle>
                        <circle class="mb-quota-ring-fill" cx="18" cy="18" r="15.9155"></circle>
                    </svg>
                    <span class="mb-quota-num" id="mb-quota-num" aria-hidden="true">؟</span>
                </button>
                <button type="submit" class="mb-send" id="mb-send">إرسال</button>
                <div class="mb-quota-pop" id="mb-quota-pop" role="status" hidden></div>
            </form>
            <div class="mb-foot">
                <a class="mb-full-link" href="/owner/muse-chat.html">فتح الصفحة الكاملة ↗</a>
            </div>
        </section>`;
    document.body.appendChild(root);
}

function wireEvents() {
    $('mb-launcher').addEventListener('click', () => {
        if (isOpen) closePanel();
        else openPanel();
    });
    $('mb-close').addEventListener('click', () => closePanel());
    $('mb-form').addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
    $('mb-quota-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleQuotaPop(); });
    // ضغطة خارج النافذة المنبثقة (لا الزر نفسه) تغلقها — فلا تغطي الرسائل دائمًا.
    document.addEventListener('click', (e) => {
        if (!quotaPopOpen) return;
        const pop = $('mb-quota-pop');
        const btn = $('mb-quota-btn');
        if (pop && pop.contains(e.target)) return;
        if (btn && btn.contains(e.target)) return;
        setQuotaPop(false);
    });
    $('mb-input').addEventListener('focus', () => { if (avatar) avatar.setState('attention'); });
    $('mb-retry').addEventListener('click', () => { hideSendError(); sendMessage(); });
    $('mb-new-chat').addEventListener('click', () => { newChat(); });
    document.querySelectorAll('#mb-root .mb-agent-chip').forEach((chip) => {
        chip.addEventListener('click', () => { openAgent(chip.dataset.modelId); });
    });
    // Escape يغلق نافذة الكوتة أولًا إن كانت مفتوحة (من أي تركيز)، ثم
    // يغلق اللوحة فقط عندما يكون التركيز داخل الفقاعة — ويعيد التركيز
    // لمشغّل الإطلاق.
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !isOpen) return;
        if (quotaPopOpen) { setQuotaPop(false); return; }
        const root = $('mb-root');
        if (root && root.contains(document.activeElement)) closePanel();
    });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) pollMessages();
    });
    window.addEventListener('pagehide', destroy);
}

/* ─────────────────── الفتح والإغلاق ─────────────────── */

function openPanel() {
    const panel = $('mb-panel');
    const launcher = $('mb-launcher');
    if (!panel || !launcher) return;
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    isOpen = true;
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    launcher.setAttribute('aria-label', 'إغلاق شات Muse');
    requestAnimationFrame(() => panel.classList.add('mb-open'));
    // لا نسرق التركيز على الشاشات اللمسية: لوحة المفاتيح ستغطي المحادثة.
    if (!window.matchMedia('(pointer: coarse)').matches) {
        $('mb-input')?.focus({ preventScroll: true });
    }
}

function closePanel() {
    const panel = $('mb-panel');
    const launcher = $('mb-launcher');
    if (!panel || !launcher || !isOpen) return;
    setQuotaPop(false);
    isOpen = false;
    panel.classList.remove('mb-open');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.setAttribute('aria-label', 'فتح شات Muse');
    closeTimer = setTimeout(() => {
        if (!isOpen) panel.hidden = true;
        closeTimer = null;
    }, 200);
    launcher.focus({ preventScroll: true });
}

/* ─────────────────── الجلسات: تحميل وإنشاء وتبديل ─────────────────── */

async function loadSessionsList() {
    const { data, error } = await supabase.from('ai_sessions')
        .select(SESSION_COLUMNS)
        .eq('owner_id', ownerId)
        .in('model_id', agentModelIds())
        .eq('status', 'active')
        .order('last_active_at', { ascending: false });
    if (error) throw error;
    sessions = sortSessions(data || []);
}

/** إنشاء جلسة جديدة للوكيل — بتوجيهه وترحيبه من MUSE_AGENTS (بلا إعادة كتابة). */
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
    // الترحيب محاولة لطيفة لا توقف الفقاعة لو فشلت.
    try {
        await supabase.from('ai_session_messages').insert({
            session_id: data.id, role: 'assistant', content: agent.greeting, model_id: agent.modelId,
        });
    } catch (err) {
        console.error('[MuseBubble] greeting insert failed:', err?.message || err);
    }
    sessions = sortSessions([data, ...sessions]);
    return data;
}

/** أحدث جلسة نشطة للوكيل، أو إنشاء واحدة بتوجيهه إن لم توجد. */
async function findOrCreateAgentSession(modelId) {
    const existing = sessions.find((s) => s.model_id === modelId);
    if (existing) return existing;
    return createSession(modelId);
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

async function loadMessages() {
    const { data, error } = await supabase.from('ai_session_messages')
        .select(MESSAGE_COLUMNS)
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true })
        .limit(MESSAGES_LIMIT);
    if (error) throw error;
    messages = mergeMessages([], data || []);
    renderMessages($('mb-messages'));
}

/** التبديل لجلسة: الرسائل والعدّاد والترويسة تتبع الجلسة الجديدة. */
async function switchSession(id) {
    const target = sessions.find((s) => s.id === id);
    if (!target) return;
    const token = ++switchToken;
    stopWaitTimer();
    waitingSinceAt = null;
    sessionId = target.id;
    activeModelId = target.model_id;
    storeActiveSession(sessionId);
    subscribeRealtime();
    updateHeader();
    renderAgentChips();
    try {
        await loadMessages();
        if (token !== switchToken) return;
        updateQuotaDisplay(target);
        // رسالة بلا رد في هذه الجلسة؟ استأنف العدّاد من طابع إرسالها الحقيقي.
        const pending = waitingSince(messages);
        if (pending) startWaiting(pending);
        else setStatusReady();
    } catch (err) {
        if (token !== switchToken) return;
        const box = $('mb-messages');
        if (box) box.innerHTML = `<div class="mb-empty">تعذّر تحميل الرسائل: ${esc(friendlyError(err))}</div>`;
    }
}

/** اختيار وكيل: يفتح أحدث جلساته أو ينشئ واحدة — والتبديل بين المحادثات القديمة يبقى في الصفحة الكاملة. */
async function openAgent(modelId) {
    if (!agentModelIds().includes(modelId)) return;
    activeModelId = modelId;
    renderAgentChips();
    try {
        const session = await findOrCreateAgentSession(modelId);
        await switchSession(session.id);
    } catch (err) {
        showSendError(`تعذّر فتح محادثة ${agentForModelId(modelId).label}: ${friendlyError(err)}`);
        console.error('[MuseBubble] open agent failed:', err?.message || err);
    }
}

async function newChat() {
    try {
        const session = await createSession(activeModelId);
        await switchSession(session.id);
        $('mb-input')?.focus();
    } catch (err) {
        showSendError(`تعذّر إنشاء محادثة جديدة: ${friendlyError(err)}`);
        console.error('[MuseBubble] new chat failed:', err?.message || err);
    }
}

/* ─────────────────── اختيار الوكيل والكوتة ─────────────────── */

function updateHeader() {
    const agent = agentForModelId(activeModelId);
    const title = $('mb-title');
    if (title) title.textContent = agent.label;
    const input = $('mb-input');
    if (input) input.placeholder = `اكتب رسالتك لـ ${agent.shortLabel}…`;
    updateQuotaDisplay(sessions.find((s) => s.id === sessionId) || null);
}

function lastAssistantAt() {
    let last = null;
    for (const m of messages) {
        if (m?.role === 'assistant' && m.created_at) {
            if (!last || new Date(m.created_at) > new Date(last)) last = m.created_at;
        }
    }
    return last;
}

/**
 * الكوتة الآن دائرة بجانب زر الإرسال لا قسم علوي: الحلقة تعرض المتبقي %
 * بنظرة واحدة، والتفاصيل الكاملة (المتبقي، الخطة، التجديد، تحذير النفاد،
 * تحذير القدم) تظهر في نافذة منبثقة فوق المؤلّف عند الضغط على الدائرة فقط.
 * البيانات والمنطق كما هي: parseQuota من الجلسة النشطة extensions.quota.
 */
function quotaSummaryLabel() {
    const text = formatQuota(lastQuotaRaw);
    if (text) return lastQuotaParsed?.low ? `${text} — الكوتة أوشكت على النفاد` : text;
    return quotaMissingText(!!lastAssistantAt());
}

function renderQuotaRing() {
    const btn = $('mb-quota-btn');
    const num = $('mb-quota-num');
    const fill = document.querySelector('#mb-quota-btn .mb-quota-ring-fill');
    if (!btn || !num || !fill) return;
    const label = quotaSummaryLabel();
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
    if (!lastQuotaParsed || lastQuotaParsed.pct === null) {
        btn.classList.remove('is-low');
        fill.style.strokeDasharray = '0 100';
        num.textContent = '؟';
        return;
    }
    btn.classList.toggle('is-low', !!lastQuotaParsed.low);
    fill.style.strokeDasharray = `${lastQuotaParsed.pct} 100`;
    num.textContent = lastQuotaParsed.remainingPct !== null
        ? String(lastQuotaParsed.remainingPct)
        : String(lastQuotaParsed.remainingLabel).slice(0, 4);
}

function renderQuotaPop() {
    const pop = $('mb-quota-pop');
    if (!pop) return;
    if (!lastQuotaParsed) {
        pop.classList.remove('is-low');
        pop.innerHTML = `<span>${esc(quotaMissingText(!!lastAssistantAt()))}</span>`;
        return;
    }
    const parsed = lastQuotaParsed;
    const bar = parsed.pct !== null
        ? `<div class="mb-qpop-bar" role="progressbar" aria-valuenow="${parsed.pct}" aria-valuemin="0" aria-valuemax="100" aria-label="المتبقي من الكوتة"><span class="mb-qpop-bar-fill" style="width:${parsed.pct}%"></span></div>`
        : '';
    const meta = [
        parsed.planLabel ? `الخطة: ${esc(parsed.planLabel)}` : '',
        parsed.resetLabel ? `التجديد: ${esc(parsed.resetLabel)}` : '',
    ].filter(Boolean).join(' • ');
    pop.classList.toggle('is-low', !!parsed.low);
    pop.innerHTML = `
        <span>المتبقي من الكوتة: <strong class="mb-qpop-value">${esc(parsed.remainingLabel)}</strong>${meta ? ` — ${meta}` : ''}</span>
        ${bar}
        ${parsed.low ? '<div class="mb-qpop-low">الكوتة أوشكت على النفاد — أقل من 20% متبقٍ.</div>' : ''}
        ${lastQuotaSnapshot === 'stale' ? `<div class="mb-qpop-stale">${esc(QUOTA_STALE_TEXT)}</div>` : ''}`;
}

function setQuotaPop(open) {
    const pop = $('mb-quota-pop');
    const btn = $('mb-quota-btn');
    if (!pop || !btn) return;
    quotaPopOpen = !!open;
    pop.hidden = !quotaPopOpen;
    btn.setAttribute('aria-expanded', quotaPopOpen ? 'true' : 'false');
    if (quotaPopOpen) renderQuotaPop();
}

function toggleQuotaPop() { setQuotaPop(!quotaPopOpen); }

/** تحديث حلقة الكوتة (وتفاصيلها إن كانت النافذة مفتوحة) من الجلسة النشطة. */
function updateQuotaDisplay(session) {
    const quota = session?.extensions?.quota;
    lastQuotaRaw = quota || null;
    lastQuotaParsed = parseQuota(quota);
    lastQuotaSnapshot = quotaSnapshotState(quota, lastAssistantAt());
    renderQuotaRing();
    if (quotaPopOpen) renderQuotaPop();
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
        console.error('[MuseBubble] quota refresh failed:', err?.message || err);
    }
}

function renderAgentChips() {
    document.querySelectorAll('#mb-root .mb-agent-chip').forEach((chip) => {
        const isActive = chip.dataset.modelId === activeModelId;
        chip.classList.toggle('is-active', isActive);
        chip.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
}

/* ─────────────────── الرسائل ─────────────────── */

function nearBottom(box) {
    return box.scrollHeight - box.scrollTop - box.clientHeight < 140;
}

function messageNode(m, tookSeconds = null) {
    const el = document.createElement('article');
    el.className = `mb-msg mb-msg--${m.role === 'user' ? 'user' : 'assistant'}`;
    el.dataset.messageId = m.id;
    const took = m.role === 'assistant' && tookSeconds !== null
        ? `<span class="mb-msg-took">${esc(formatReplyDuration(tookSeconds))}</span>` : '';
    const body = `
        <div class="mb-msg-body">
            <p class="mb-msg-text">${esc(m.content)}</p>
            <time class="mb-msg-time" datetime="${esc(m.created_at || '')}">${esc(formatMessageTime(m.created_at))}</time>
            ${took}
        </div>`;
    // رسائل المساعد تحمل علامة الأفاتار الصغيرة الثابتة — نفس الـ SVG بلا حركة.
    el.innerHTML = m.role === 'user'
        ? body
        : `<span class="mb-msg-avatar" aria-hidden="true">${museAvatarSvg()}</span>${body}`;
    return el;
}

function appendNew(box, incoming, renderedIds) {
    // حالة «لا رسائل» تُزال عند وصول أول رسالة فعلية.
    box.querySelector('.mb-empty')?.remove();
    const stick = nearBottom(box);
    // فقاعة الانتظار تبقى آخر عنصر دائمًا: تُرفع مؤقتًا وتُعاد بعد الإلحاق.
    const thinking = thinkingEl;
    if (thinking && thinking.parentNode === box) box.removeChild(thinking);
    let added = 0;
    for (const m of incoming) {
        if (renderedIds.has(m.id)) continue;
        renderedIds.add(m.id);
        box.appendChild(messageNode(m, replyTookFor(messages, m)));
        added++;
    }
    if (thinking) box.appendChild(thinking);
    if (added && stick) box.scrollTop = box.scrollHeight;
    return added;
}

function renderMessages(box) {
    if (!box) return;
    box.innerHTML = '';
    thinkingEl = null;
    if (!messages.length) {
        box.innerHTML = `<div class="mb-empty">لا رسائل بعد — اكتب أول رسالة لـ ${esc(agentForModelId(activeModelId).shortLabel)} بالأسفل.</div>`;
        renderMessages.renderedIds = new Set();
        return;
    }
    const renderedIds = new Set();
    for (const m of messages) {
        renderedIds.add(m.id);
        box.appendChild(messageNode(m, replyTookFor(messages, m)));
    }
    box.scrollTop = box.scrollHeight;
    if (waitingSinceAt) showThinking(box);
    // احتفظ بمجموعة المعرّفات المعروضة للدمج اللاحق عبر الاستطلاع.
    renderMessages.renderedIds = renderedIds;
}

/* ─────────────────── الاستطلاع وتوقيت الرد ─────────────────── */

/** آخر 50 رسالة تُدمج بالمعرّف — فلا تفوت رسالة تشارك أخرى نفس الطابع الزمني. */
async function pollMessages() {
    if (!sessionId || sending || document.hidden || destroyed) return;
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
            const renderedIds = renderMessages.renderedIds || new Set(messages.map((m) => m.id));
            appendNew($('mb-messages'), messages, renderedIds);
            renderMessages.renderedIds = renderedIds;
            refreshQuota();
        }
        // الكوتة قد تتحدّث بلا رسائل جديدة (لقطة الجسر) — حدّثها كل 30 ثانية.
        if (Date.now() - lastQuotaRefreshAt > QUOTA_REFRESH_MS) refreshQuota();
        checkReplyArrived();
    } catch (err) {
        pollFailures++;
        console.error('[MuseBubble] poll failed:', err?.message || err);
    }
}

/**
 * الاستطلاع شبكة أمان فقط: يتوقف تمامًا أثناء اتصال Realtime السليم
 * (SUBSCRIBED)، ويعود عند انقطاعه بمهلة backoff — فلا تبقى قراءتان
 * متوازيتان دائمًا. عند تبديل الجلسة تُستبدل القناة بقناة الجلسة
 * الجديدة؛ وعند مغادرة الصفحة تُزال القناة مع المؤقت.
 */
function stopPolling() {
    if (pollTimeout) clearTimeout(pollTimeout);
    pollTimeout = null;
}

function armPollTimer(delay = POLL_MS) {
    stopPolling();
    if (realtimeLive || destroyed) return;
    pollTimeout = setTimeout(pollCycle, delay);
}

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
        realtimeChannel = supabase.channel(`muse-bubble-${sessionId}`)
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
                console.warn('[MuseBubble] realtime not subscribed:', status);
                realtimeLive = false;
                armPollTimer(pollRetryDelay(pollFailures));
            });
    } catch (err) {
        console.error('[MuseBubble] realtime subscribe failed:', err?.message || err);
        realtimeLive = false;
        armPollTimer(pollRetryDelay(pollFailures));
    }
}

function setStatus(text, waiting) {
    const el = $('mb-status');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('is-waiting', !!waiting);
}

/* ─────────────────── فقاعة الانتظار: نقاط ومرحلة وعدّاد ─────────────────── */

function showThinking(box) {
    if (thinkingEl) {
        if (thinkingEl.parentNode !== box) box.appendChild(thinkingEl);
        return;
    }
    const el = document.createElement('div');
    el.className = 'mb-thinking';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = `
        <span class="mb-msg-avatar" aria-hidden="true">${museAvatarSvg()}</span>
        <span class="mb-thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="mb-thinking-text">Muse يفكر…</span>
        <span class="mb-thinking-stage"></span>
        <span class="mb-thinking-timer">0 ث</span>`;
    thinkingEl = el;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
}

/** تحديث نص الفقاعة كل ثانية: المرحلة من الثواني المنصرمة والعدّاد. */
function updateThinking(seconds) {
    if (!thinkingEl) return;
    const stage = thinkingEl.querySelector('.mb-thinking-stage');
    const timer = thinkingEl.querySelector('.mb-thinking-timer');
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
    setStatus(formatWaitSeconds(0), true);
    showThinking($('mb-messages'));
    updateThinking(0);
    waitTimer = setInterval(() => {
        if (!waitingSinceAt) return;
        const seconds = secondsBetween(waitingSinceAt, new Date().toISOString());
        setStatus(formatWaitSeconds(seconds), true);
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
    setStatus(formatReplyTook(took), false);
    if (avatar) {
        // مدة الكلام من طول الرد الحقيقي — 45 مللي ثانية لكل حرف تقريبًا.
        avatar.setState('speaking', 1500 + 45 * (reply.content || '').length);
    }
    refreshQuota();
}

function setStatusReady() {
    setStatus('جاهز — اكتب رسالتك بالأسفل.', false);
}

function showSendError(message) {
    const box = $('mb-error');
    const text = $('mb-error-text');
    if (!box || !text) return;
    text.textContent = message;
    box.hidden = false;
}

function hideSendError() {
    const box = $('mb-error');
    if (!box) return;
    box.hidden = true;
    const text = $('mb-error-text');
    if (text) text.textContent = '';
}

function setSending(on) {
    sending = on;
    const input = $('mb-input');
    const btn = $('mb-send');
    if (input) input.disabled = on;
    if (btn) {
        btn.disabled = on;
        btn.textContent = on ? 'جارٍ الإرسال…' : 'إرسال';
    }
}

async function sendMessage() {
    const input = $('mb-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text || sending || !sessionId) return;
    hideSendError();
    setQuotaPop(false);
    setSending(true);
    const isFirstUserMessage = !hasUserMessage(messages);
    const activeSession = sessions.find((s) => s.id === sessionId);
    try {
        const { data, error } = await supabase.from('ai_session_messages')
            .insert({
                session_id: sessionId, role: 'user', content: text,
                model_id: activeModelId,
            })
            .select(MESSAGE_COLUMNS)
            .single();
        if (error) throw error;
        messages = mergeMessages(messages, [data]);
        const renderedIds = renderMessages.renderedIds || new Set();
        appendNew($('mb-messages'), messages, renderedIds);
        renderMessages.renderedIds = renderedIds;
        input.value = '';
        // أول رسالة في الجلسة تسمّيها بعنوان ذكي من محتواها. تحديث آخر
        // نشاط أيضًا حتى يبقى ترتيب الجلسة محدثًا في الصفحة الكاملة.
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
        } catch (err) {
            console.error('[MuseBubble] auto-title failed:', err?.message || err);
        }
        startWaiting(data.created_at || new Date().toISOString());
    } catch (err) {
        // المسودة تبقى في الحقل كما هي؛ زر «إعادة المحاولة» يرسلها نفسها.
        showSendError(`تعذّر إرسال الرسالة: ${friendlyError(err)} — مسودتك محفوظة، جرّب إعادة المحاولة.`);
    } finally {
        setSending(false);
        // التركيز بعد إعادة التفعيل فقط: التركيز على حقل معطّل لا يعمل،
        // فيضيع التركيز من داخل الفقاعة ويتوقف Escape عن إغلاقها.
        input.focus();
    }
}

/* ─────────────────── التحميل والتنظيف ─────────────────── */

async function loadChat() {
    const box = $('mb-messages');
    try {
        await loadSessionsList();
        let session = pickActiveSession(sessions, readStoredActiveSession());
        if (!session) session = await createSession(MUSE_MODEL_ID);
        activeModelId = session.model_id;
        await switchSession(session.id);
        armPollTimer(POLL_MS);
    } catch (err) {
        if (box) box.innerHTML = `<div class="mb-empty">تعذّر تحميل المحادثة: ${esc(friendlyError(err))}</div>`;
        console.error('[MuseBubble] load failed:', err?.message || err);
    }
}

function destroy() {
    if (destroyed) return;
    destroyed = true;
    stopPolling();
    if (realtimeChannel) {
        try {
            supabase.removeChannel(realtimeChannel);
        } catch (err) {
            console.error('[MuseBubble] remove channel failed:', err?.message || err);
        }
        realtimeChannel = null;
    }
    stopWaitTimer();
    if (closeTimer) clearTimeout(closeTimer);
    if (avatar) avatar.destroy();
    $('mb-root')?.remove();
    if (window.museBubble) delete window.museBubble;
}

async function init() {
    if ($('mb-root')) return;
    // حارس إضافي: لا فقاعة على صفحات الشات الكاملة أبدًا.
    const path = window.location.pathname || '';
    if (FULL_CHAT_PATHS.some((p) => path.endsWith(p))) return;
    let session = null;
    try {
        ({ data: { session } } = await supabase.auth.getSession());
    } catch (err) {
        console.warn('[MuseBubble] getSession failed:', err?.message || err);
        return;
    }
    const user = session?.user;
    if (!user) return;
    // البوابة: بلا تفعيل فعّال لا يُنشأ أي DOM إطلاقًا.
    if (!(await isActivated(user.id))) return;
    ownerId = user.id;
    loadRenamedIds();
    buildDom();
    wireEvents();
    avatar = createMuseAvatar($('mb-avatar'));
    await loadChat();
    window.museBubble = {
        open: openPanel,
        close: closePanel,
        destroy,
        isOpen: () => isOpen,
    };
}

init().catch((err) => {
    console.error('[MuseBubble] init failed:', err?.message || err);
});
