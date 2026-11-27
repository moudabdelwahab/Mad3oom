/**
 * owner/agent-chat.html — شات الوكلاء في لوحة المالك.
 *
 * نفس قشرة owner/agents.html (bootOwnerPage + platformAuthority isAdmin +
 * رسالة «للأدمن فقط»)، لكن المحتوى محادثة لا إدارة: منتقي وكلاء + محادثة.
 *
 * النقل: chatWithAgent من /agent-service.js (agent-manager `chat`) — لا نداء
 * مباشر لـ Hermes من المتصفح أبدًا، فالمفتاح لا يغادر الخادم.
 *
 * البث: agent-manager مع stream:true لا تعيد دفق SSE حيًا للمتصفح أصلًا —
 * تقرأ SSE من Hermes على الخادم (hermesFetchSse، حتى timeout_ms) وتعيد JSON
 * واحدًا { ok, data: { streamed: true, raw } }. لذلك لا فائدة من fetch
 * مباشر لـ Edge Function من هنا (سيعيد الجسم نفسه). البث هنا يعني:
 * نرسل stream:true، ونفكّ نص SSE الخام إلى توكنات (extractStreamedTokens)
 * ونعرضها تدريجيًا في فقاعة المساعد. بث حي توكنًا بتوكن يتطلب تغيير
 * agent-manager نفسها لتعيد Response متدفقًا — خارج نطاق هذه الصفحة.
 * stream:false يرسل JSON عاديًا ويُفسَّر بصيغة OpenAI (extractReplyText).
 */
import { bootOwnerPage, announce } from '/assets/js/owner/owner-page.js';
import { platformAuthority } from '/assets/js/platform-authority.js';
import { fetchAgents, chatWithAgent } from '/agent-service.js';

const $ = (id) => document.getElementById(id);

/* ── منطق خالص: يُستخرَج ويُنفَّذ في Node (tests/agent-chat-page.test.mjs) ──
 * هذا القسم بلا أي اعتماد خارجي (لا DOM ولا استيرادات) حتى يبقى قابلًا
 * للاستخراج حرفيًا. أي تعديل في توقيع دالة هنا يُفشل التجريد بصوت عالٍ. */
export const DEFAULT_MODEL = 'hermes-agent';
export const MISSING_KEY_HINT = 'أضف المفتاح أولًا';

/** جاهز للمحادثة = مفعّل + endpoint + آخر 4 خانات من المفتاح موجودة. */
export function isAgentReady(agent) {
    if (!agent || typeof agent !== 'object') return false;
    return agent.enabled === true
        && String(agent.endpoint ?? '').trim() !== ''
        && String(agent.api_key_last4 ?? '').trim() !== '';
}

/** يقسّم القائمة إلى جاهزين وغير جاهزين مع الحفاظ على الترتيب. */
export function partitionAgents(agents) {
    const list = Array.isArray(agents) ? agents : [];
    return { ready: list.filter(isAgentReady), notReady: list.filter((a) => !isAgentReady(a)) };
}

/**
 * جسم المحادثة المُرسَل إلى الخادم: النموذج صريحًا افتراضيًا
 * ("hermes-agent" من حقل الصفحة)، وفارغ = يُحذف فيُطبَّق افتراضي الخادم.
 */
export function buildChatBody({ model = '', messages = [], stream = true } = {}) {
    const body = { messages, stream: !!stream };
    const trimmed = typeof model === 'string' ? model.trim() : '';
    if (trimmed) body.model = trimmed;
    return body;
}

/** يفكّ نص SSE الخام (data: {...}، يتخطى [DONE]) إلى توكنات المحتوى. */
export function extractStreamedTokens(raw) {
    const tokens = [];
    if (!raw) return tokens;
    for (const line of String(raw).split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
            const obj = JSON.parse(payload);
            const content = obj?.choices?.[0]?.delta?.content ?? obj?.choices?.[0]?.text ?? '';
            if (typeof content === 'string' && content) tokens.push(content);
        } catch {
            // حمولة ليست JSON — تُتخطّى، لا تكسر المحادثة.
        }
    }
    return tokens;
}

export function extractStreamedText(raw) {
    return extractStreamedTokens(raw).join('');
}

/** رد JSON غير متدفق بصيغة OpenAI، مع بدائل شكلية. */
export function extractReplyText(data) {
    if (typeof data === 'string') return data;
    if (!data || typeof data !== 'object') return '';
    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    const content = choice?.message?.content ?? choice?.text ?? data.content ?? data.text ?? '';
    return typeof content === 'string' ? content : '';
}

/** يوحّد الردين: متدفق (raw) أو JSON عادي. */
export function extractChatText(result, stream) {
    const data = result?.data;
    if (stream) {
        if (data && typeof data === 'object' && data.streamed === true) return extractStreamedText(data.raw);
        return extractReplyText(data);
    }
    return extractReplyText(data);
}

/** خطأ مفتاح مفقود/غير صالح (401/403 أو ذكر المفتاح) — لا يُعامل كعطل عام. */
export function isMissingKeyError(err) {
    const msg = String(err?.message || err || '');
    return /(401|403|unauthorized|غير مصرّح|api.?key|api_key|مفتاح)/i.test(msg);
}

/** سجل المحادثة في الذاكرة فقط (لا يُحفظ) — clear() يفرغه للمحادثة الجديدة. */
export function createChatState() {
    const messages = [];
    return {
        messages,
        add(role, content) { messages.push({ role, content }); },
        clear() { messages.length = 0; },
    };
}
/* ── نهاية المنطق الخالص ── */

const chatState = createChatState();
let agents = [];
let selectedAgent = null;
let sending = false;
let revealTimer = null;

function stopReveal() {
    if (revealTimer !== null) { clearInterval(revealTimer); revealTimer = null; }
}

function scrollChatToBottom() {
    const box = $('chatMessages');
    if (box) box.scrollTop = box.scrollHeight;
}

/** فقاعة رسالة؛ النص عبر textContent دائمًا (لا HTML من الوكيل أو المستخدم). */
function appendMessage(role, text, { typing = false } = {}) {
    const box = $('chatMessages');
    const empty = $('chatEmpty');
    if (empty) empty.remove();
    const el = document.createElement('div');
    el.className = `msg ${role === 'user' ? 'user' : role === 'error' ? 'error' : role === 'hint' ? 'hint' : 'assistant'}`;
    if (typing) el.classList.add('typing');
    el.textContent = text;
    box.appendChild(el);
    scrollChatToBottom();
    return el;
}

/** فقاعة تلميح المفتاح: نص + رابط داخل اللوحة نفسها إلى /owner/agents.html. */
function appendMissingKeyHint() {
    const box = $('chatMessages');
    const empty = $('chatEmpty');
    if (empty) empty.remove();
    const el = document.createElement('div');
    el.className = 'msg hint';
    el.append(document.createTextNode('هذا الوكيل بلا مفتاح صالح — '));
    const link = document.createElement('a');
    link.href = '/owner/agents.html';
    link.textContent = MISSING_KEY_HINT;
    el.append(link);
    box.appendChild(el);
    scrollChatToBottom();
    return el;
}

/** سبب عدم الجاهزية للعرض في المنتقي (بلا مفتاح / بلا endpoint / معطّل). */
function notReadyReason(agent) {
    if (!agent) return '';
    if (agent.enabled !== true) return 'معطّل';
    if (String(agent.endpoint ?? '').trim() === '') return 'بلا endpoint';
    if (String(agent.api_key_last4 ?? '').trim() === '') return 'بلا مفتاح';
    return '';
}

function showPickerHint(htmlText, linkText) {
    const hint = $('agentPickerHint');
    hint.replaceChildren();
    hint.append(document.createTextNode(htmlText + ' — '));
    const link = document.createElement('a');
    link.href = '/owner/agents.html';
    link.textContent = linkText;
    hint.append(link);
    hint.hidden = false;
}

function renderPicker() {
    const list = $('agentPickerList');
    list.replaceChildren();
    const { ready, notReady } = partitionAgents(agents);
    $('agentPickerEmpty').hidden = agents.length !== 0;
    $('agentPickerHint').hidden = true;

    if (agents.length === 0) return;

    for (const agent of agents) {
        const readyAgent = isAgentReady(agent);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'picker-item' + (readyAgent ? '' : ' not-ready');
        btn.setAttribute('role', 'option');
        btn.setAttribute('aria-selected', selectedAgent?.id === agent.id ? 'true' : 'false');
        if (selectedAgent?.id === agent.id) btn.classList.add('selected');
        const name = document.createElement('span');
        name.className = 'nm';
        name.textContent = agent.name || agent.slug || agent.id;
        const state = document.createElement('span');
        state.className = 'st' + (readyAgent ? '' : ' key');
        state.textContent = readyAgent ? 'جاهز للمحادثة' : notReadyReason(agent);
        btn.append(name, state);
        btn.addEventListener('click', () => selectAgent(agent));
        list.append(btn);
    }

    if (ready.length === 0) {
        showPickerHint('لا يوجد وكيل جاهز للمحادثة', MISSING_KEY_HINT);
    }
}

function selectAgent(agent) {
    if (!isAgentReady(agent)) {
        showPickerHint(`الوكيل «${agent.name || agent.slug || ''}» بلا مفتاح`, MISSING_KEY_HINT);
        return;
    }
    selectedAgent = agent;
    $('agentPickerHint').hidden = true;
    $('chatAgentName').textContent = agent.name || agent.slug || 'وكيل';
    $('chatAgentMeta').textContent = 'جاهز — اكتب رسالتك أدناه';
    setComposerEnabled(true);
    renderPicker();
    $('chatInput').focus();
}

function setComposerEnabled(enabled) {
    const hasAgent = !!selectedAgent;
    $('chatInput').disabled = !(enabled && hasAgent);
    $('btnSendChat').disabled = !(enabled && hasAgent);
}

async function loadAgents() {
    try {
        const result = await fetchAgents();
        agents = Array.isArray(result) ? result : (result?.agents || []);
    } catch (err) {
        agents = [];
        const hint = $('agentPickerHint');
        hint.textContent = 'تعذّر تحميل الوكلاء، حاول مجددًا';
        hint.hidden = false;
        announce($('pageStatus'), 'تعذّر تحميل الوكلاء', 'error');
        return;
    }
    renderPicker();
}

/** يعرض توكنات البث تدريجيًا في فقاعة المساعد (التوكنات وصلت فعلًا من الخادم دفعة واحدة). */
function revealStreamed(bubble, tokens, fullText) {
    let i = 0;
    bubble.textContent = '';
    stopReveal();
    revealTimer = setInterval(() => {
        if (i >= tokens.length) {
            stopReveal();
            bubble.textContent = fullText;
            scrollChatToBottom();
            return;
        }
        bubble.textContent += tokens[i];
        i += 1;
        scrollChatToBottom();
    }, 25);
}

async function sendMessage() {
    if (sending || !selectedAgent) return;
    const input = $('chatInput');
    const text = input.value.trim();
    if (!text) return;

    chatState.add('user', text);
    appendMessage('user', text);
    input.value = '';
    sending = true;
    setComposerEnabled(false);
    const typing = appendMessage('assistant', 'يكتب…', { typing: true });

    try {
        const stream = $('streamToggle').checked;
        const body = buildChatBody({
            model: $('modelInput').value,
            messages: chatState.messages.map((m) => ({ role: m.role, content: m.content })),
            stream,
        });
        const result = await chatWithAgent(selectedAgent.id, body);
        typing.remove();
        if (stream && result?.data && typeof result.data === 'object' && result.data.streamed === true) {
            const tokens = extractStreamedTokens(result.data.raw);
            const fullText = tokens.join('');
            if (!fullText.trim()) {
                appendMessage('error', 'وصل رد فارغ من الوكيل، حاول مجددًا');
            } else {
                chatState.add('assistant', fullText);
                revealStreamed(appendMessage('assistant', ''), tokens, fullText);
            }
        } else {
            const reply = extractChatText(result, stream);
            if (!reply.trim()) {
                appendMessage('error', 'وصل رد فارغ من الوكيل، حاول مجددًا');
            } else {
                chatState.add('assistant', reply);
                appendMessage('assistant', reply);
            }
        }
    } catch (err) {
        typing.remove();
        if (isMissingKeyError(err)) {
            appendMissingKeyHint();
            announce($('pageStatus'), 'هذا الوكيل بلا مفتاح صالح', 'error');
        } else {
            appendMessage('error', 'تعذّر إرسال الرسالة، حاول مجددًا');
            announce($('pageStatus'), 'تعذّر إرسال الرسالة', 'error');
        }
    } finally {
        sending = false;
        setComposerEnabled(true);
        $('chatInput').focus();
    }
}

function clearChat() {
    stopReveal();
    chatState.clear();
    const box = $('chatMessages');
    box.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'chat-empty';
    empty.id = 'chatEmpty';
    empty.textContent = selectedAgent
        ? 'محادثة جديدة — اكتب رسالتك.'
        : 'اختر وكيلًا جاهزًا من القائمة، ثم اكتب رسالتك.';
    box.append(empty);
    announce($('pageStatus'), 'بدأت محادثة جديدة', 'success');
}

(async function init() {
    if (!await bootOwnerPage()) return;
    const { isAdmin } = await platformAuthority();
    if (!isAdmin) {
        $('agentChatRoot').innerHTML = `
            <div class="not-authorized">
                <p style="font-size:1.05rem; font-weight:700; color:var(--color-text);">هذه الصفحة متاحة للأدمن فقط</p>
                <p style="font-size:.85rem; margin-top:.4rem;">المحادثة مع وكلاء الذكاء الاصطناعي تتطلب صلاحية أدمن.</p>
            </div>`;
        announce($('pageStatus'), 'هذه الصفحة متاحة للأدمن فقط', 'error');
        return;
    }
    $('chatForm').addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
    $('btnClearChat').addEventListener('click', clearChat);
    await loadAgents();
})();
