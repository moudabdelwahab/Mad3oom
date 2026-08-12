/**
 * بيئة التطوير (Coding Agent Shell)
 * --------------------------------------------------------
 * تجربة أقرب لبيئة تطوير منها لصندوق شات: اختيار موديل + وضع تشغيل +
 * جلسة محفوظة + ألواح Terminal/Changes/Logs/Usage.
 *
 * ⚠ حدود مقصودة في هذه المرحلة (أمان أولًا):
 *   لا يوجد نظام ملفات حقيقي ولا طرفية حقيقية ولا تنفيذ كود في المتصفح.
 *   الألواح تعرض ما يسجّله الخادم فعلًا، وتقول صراحةً "غير مفعّل" لما لا
 *   يوجد له مُنفِّذ بعد. البنية جاهزة لتفعيل هذه النقاط لاحقًا من الخادم
 *   وحده، دون تعديل هذا الملف:
 *      sandbox • repository • github • filesystem • terminal • code_execution
 */

import * as api from '../ai-service.js';
import { supportsDevEnvironment, meetsRequirements, activeCapabilities } from '../capability-registry.js';
import { escapeHtml, icon, toast, loadingBlock, emptyBlock, formatNumber, formatCost, formatDate, setBusy } from './shared.js';

let ctx = null;
let session = null;
let messages = [];
let currentMode = 'chat';
let bottomTab = 'logs';
let sending = false;

export function init(sharedContext) { ctx = sharedContext; }

/* ====================  الهيكل  ==================== */

export function render() {
    const root = document.getElementById('aiDevEnvironment');
    if (!root) return;

    root.innerHTML = `
        <div class="ai-dev-shell">
            <div class="ai-dev-header" id="aiDevHeader">${headerHtml()}</div>

            <div class="ai-dev-body">
                <aside class="ai-dev-sidebar">
                    <div class="ai-dev-panel-title">${icon('message', 13)} الجلسات
                        <button class="btn btn-secondary btn-sm" data-dev-action="new-session">جديدة</button>
                    </div>
                    <div class="ai-dev-sessions" id="aiDevSessions"></div>

                    <div class="ai-dev-panel-title">${icon('file', 13)} ملفات المشروع</div>
                    <div class="ai-dev-files" id="aiDevFiles"></div>
                </aside>

                <section class="ai-dev-main">
                    <div class="ai-dev-modes" id="aiDevModes"></div>
                    <div class="ai-dev-transcript" id="aiDevTranscript"></div>
                </section>
            </div>

            <div class="ai-dev-bottom">
                <div class="ai-dev-bottom-tabs" id="aiDevBottomTabs">
                    <button class="ai-dev-bottom-tab" data-dev-bottom="terminal">Terminal</button>
                    <button class="ai-dev-bottom-tab" data-dev-bottom="changes">Changes</button>
                    <button class="ai-dev-bottom-tab active" data-dev-bottom="logs">Logs</button>
                    <button class="ai-dev-bottom-tab" data-dev-bottom="usage">Usage</button>
                </div>
                <div class="ai-dev-bottom-body" id="aiDevBottomBody"></div>
            </div>

            <div class="ai-dev-composer">
                <textarea id="aiDevInput" rows="2" placeholder="اكتب مهمتك للوكيل... (Ctrl+Enter للإرسال)"></textarea>
                <button class="btn btn-primary" id="aiDevSendBtn" data-dev-action="send">${icon('send', 15)} إرسال</button>
            </div>
        </div>`;

    renderSessions();
    renderModes();
    renderTranscript();
    renderFiles();
    renderBottom();
}

function currentModel() {
    if (!session) return null;
    return ctx.models.find((m) => m.integration_id === session.integration_id && m.model_id === session.model_id) || null;
}

function headerHtml() {
    if (!session) {
        return `<div class="ai-dev-header-empty">${icon('code', 15)} لم تُفتح جلسة بعد — اختر موديلًا من تبويب "الموديلات" أو ابدأ جلسة جديدة.</div>`;
    }

    const integration = ctx.integrations.find((i) => i.id === session.integration_id);
    const model = currentModel();
    const connected = !!integration?.is_active;

    return `
        <div class="ai-dev-header-model">
            ${icon('cpu', 16)}
            <strong>${escapeHtml(model?.display_name || session.model_id || 'بدون موديل')}</strong>
            <span class="ai-dim">${escapeHtml(integration?.display_name || '')}</span>
            ${model ? `<span class="ai-cap-inline">${activeCapabilities(model).slice(0, 5).map((c) => `<span class="ai-cap-badge">${icon(c.icon, 10)} ${escapeHtml(c.label)}</span>`).join('')}</span>` : ''}
        </div>
        <div class="ai-dev-header-right">
            <span class="ai-dev-usage">${icon('cpu', 12)} ${formatNumber(session.total_tokens)} • ${formatCost(session.total_cost)}</span>
            <span class="status-chip ${connected ? 'st-connected' : 'st-error'}"><span class="dot"></span>${connected ? 'متصل' : 'المزوّد معطّل'}</span>
        </div>`;
}

/* ====================  الأوضاع  ==================== */

function renderModes() {
    const wrap = document.getElementById('aiDevModes');
    if (!wrap) return;

    const model = currentModel();

    wrap.innerHTML = ctx.modes.map((mode) => {
        // الوضع يُعطَّل لو الموديل الحالي لا يحقّق قدراته المطلوبة — مع شرح السبب
        const unmet = model ? !meetsRequirements(model, mode.required_capabilities) : false;
        const title = unmet
            ? `هذا الوضع يحتاج: ${(mode.required_capabilities || []).join(', ')} — الموديل الحالي لا يعلن دعمها`
            : (mode.description_ar || mode.label);

        return `<button class="ai-mode-chip ${currentMode === mode.id ? 'active' : ''} ${unmet ? 'is-unmet' : ''}"
                        data-dev-mode="${escapeHtml(mode.id)}" title="${escapeHtml(title)}">
            ${icon(mode.icon || 'message', 12)} ${escapeHtml(mode.label_ar || mode.label)}
        </button>`;
    }).join('');
}

export async function setMode(modeId) {
    currentMode = modeId;
    renderModes();
    if (session) {
        try { await api.updateSession(session.id, { mode: modeId }); session.mode = modeId; } catch { /* الوضع يُرسل مع كل رسالة على أي حال */ }
    }
}

/* ====================  الجلسات  ==================== */

async function renderSessions() {
    const wrap = document.getElementById('aiDevSessions');
    if (!wrap) return;
    wrap.innerHTML = '<div class="ai-dim" style="padding:0.5rem">جاري التحميل...</div>';

    try {
        const { sessions } = await api.listSessions();
        wrap.innerHTML = sessions.length
            ? sessions.map((s) => `
                <button class="ai-dev-session ${session?.id === s.id ? 'active' : ''}" data-dev-session="${s.id}">
                    <span class="ai-dev-session-title">${escapeHtml(s.title)}</span>
                    <span class="ai-dev-session-meta">${escapeHtml(s.mode)} • ${formatNumber(s.total_tokens)} توكن</span>
                </button>`).join('')
            : '<div class="ai-dim" style="padding:0.5rem">لا توجد جلسات بعد</div>';
    } catch (err) {
        wrap.innerHTML = `<div class="ai-note">${escapeHtml(err.message)}</div>`;
    }
}

/** يفتح جلسة موجودة أو ينشئ واحدة جديدة لموديل محدّد. */
export async function open({ integrationId, modelId, mode } = {}) {
    if (mode) currentMode = mode;

    const model = ctx.models.find((m) => m.integration_id === integrationId && m.model_id === modelId);
    const integration = ctx.integrations.find((i) => i.id === integrationId);

    // موديل بلا قدرات برمجة/تفكير/وكالة يبدأ في وضع محادثة عادية بدل وضع برمجي معطّل
    if (model && !supportsDevEnvironment(model) && ['code', 'build', 'debug', 'review', 'refactor'].includes(currentMode)) {
        currentMode = 'chat';
    }

    try {
        const { session: created } = await api.createSession({
            title: `${model?.display_name || modelId || 'جلسة'} — ${integration?.display_name || ''}`.trim(),
            mode: currentMode,
            integration_id: integrationId || null,
            model_id: modelId || null,
        });
        session = created;
        messages = [];
        render();
        toast('تم فتح جلسة جديدة', 'success');
    } catch (err) {
        toast(err.message || 'تعذّر فتح الجلسة', 'error');
    }
}

export async function loadSession(sessionId) {
    try {
        const result = await api.getSession(sessionId);
        session = result.session;
        messages = result.messages || [];
        currentMode = session.mode || 'chat';
        render();
    } catch (err) {
        toast(err.message || 'تعذّر تحميل الجلسة', 'error');
    }
}

export async function newSession() {
    const activeIntegration = ctx.integrations.find((i) => i.is_active);
    if (!activeIntegration) return toast('أضِف مزوّدًا فعّالًا أولًا', 'error');
    const defaultModel = ctx.models.find((m) => m.integration_id === activeIntegration.id && m.is_default)
        || ctx.models.find((m) => m.integration_id === activeIntegration.id && m.is_enabled);
    await open({ integrationId: activeIntegration.id, modelId: defaultModel?.model_id, mode: currentMode });
}

/* ====================  المحادثة  ==================== */

function messageHtml(msg) {
    if (msg.channel !== 'session') return '';
    const roleLabel = { user: 'أنت', assistant: 'الوكيل', system: 'النظام' }[msg.role] || msg.role;
    return `
        <div class="ai-msg ai-msg-${escapeHtml(msg.role)}">
            <div class="ai-msg-head">
                <strong>${escapeHtml(roleLabel)}</strong>
                ${msg.model_id ? `<span class="ai-dim" dir="ltr">${escapeHtml(msg.model_id)}</span>` : ''}
                ${msg.mode ? `<span class="ai-chip-soft">${escapeHtml(msg.mode)}</span>` : ''}
                <span class="ai-msg-time">${formatDate(msg.created_at)}</span>
            </div>
            <div class="ai-msg-body">${escapeHtml(msg.content)}</div>
        </div>`;
}

function renderTranscript() {
    const wrap = document.getElementById('aiDevTranscript');
    if (!wrap) return;

    const sessionMessages = messages.filter((m) => m.channel === 'session');

    if (!session) {
        wrap.innerHTML = emptyBlock({
            title: 'بيئة تطوير، وليست صندوق شات',
            body: 'اختر موديلًا يدعم البرمجة أو التفكير من تبويب "الموديلات" واضغط "افتح بيئة التطوير"، أو ابدأ جلسة جديدة من اليمين.',
        });
        return;
    }

    wrap.innerHTML = sessionMessages.length
        ? sessionMessages.map(messageHtml).join('') + (sending ? `<div class="ai-msg ai-msg-assistant"><div class="ai-msg-body ai-dim">${icon('clock', 13)} الوكيل يعمل...</div></div>` : '')
        : `<div class="ai-dev-hint">
             ${icon('code', 18)}
             <p>اكتب مهمتك بالأسفل. الوضع الحالي <strong>${escapeHtml(ctx.modes.find((m) => m.id === currentMode)?.label_ar || currentMode)}</strong>
             يحدّد كيف يفكّر الوكيل ويجيب.</p>
           </div>`;

    wrap.scrollTop = wrap.scrollHeight;
}

export async function send() {
    const input = document.getElementById('aiDevInput');
    const text = input?.value.trim();
    if (!text) return;
    if (!session) return toast('ابدأ جلسة أولًا', 'error');
    if (sending) return;

    sending = true;
    input.value = '';
    messages.push({ role: 'user', content: text, mode: currentMode, channel: 'session', created_at: new Date().toISOString() });
    renderTranscript();

    const btn = document.getElementById('aiDevSendBtn');
    setBusy(btn, true, 'جاري...');
    try {
        const result = await api.sendSessionMessage({
            session_id: session.id,
            message: text,
            mode: currentMode,
        });
        // نعيد تحميل الجلسة كاملة حتى تظهر أحداث اللوجات التي كتبها الخادم أيضًا
        const refreshed = await api.getSession(session.id);
        session = refreshed.session;
        messages = refreshed.messages || [];

        if (result.attempts?.some((a) => a.status === 'fallback')) {
            toast(`تم التحوّل للاحتياطي — الرد جاء من ${result.provider}/${result.model}`, 'info');
        }
    } catch (err) {
        // البوابة ترفق سبب الفشل الفعلي لكل مزوّد جُرِّب واقتراحًا مرتبطًا بالحالة.
        // عرض err.message وحده كان يُظهر "فشلت كل المحاولات" ويُخفي السبب الوحيد
        // القابل للتنفيذ — نفاد الرصيد مثلًا — فيبدو العطل مجهولًا بلا حلّ.
        const d = err.details || {};
        const attempts = Array.isArray(d.attempts) ? d.attempts.filter((a) => a.error) : [];

        // السبب الفعلي: ما ترسله البوابة صراحةً، وإلا خطأ آخر مزوّد جُرِّب.
        // الاشتقاق من attempts مقصود كي تعمل الرسالة حتى مع نسخة بوابة أقدم
        // لا ترسل reason — فالحالة الشائعة مزوّد واحد، وخطؤه هو كل القصة.
        const reason = d.reason || attempts[attempts.length - 1]?.error || err.message || 'خطأ غير معروف';
        const parts = [reason];

        if (attempts.length > 1) {
            parts.push('\n\nالمزوّدون الذين جُرِّبوا:');
            for (const a of attempts) parts.push(`• ${a.provider || '?'}/${a.model || '?'}: ${a.error}`);
        }
        if (d.suggestion) parts.push(`\n${d.suggestion}`);

        messages.push({
            role: 'assistant', channel: 'session', mode: currentMode,
            content: 'تعذّر الحصول على رد — ' + parts.join('\n'),
            created_at: new Date().toISOString(),
        });
        toast(reason, 'error');
    } finally {
        sending = false;
        setBusy(btn, false);
        renderTranscript();
        document.getElementById('aiDevHeader').innerHTML = headerHtml();
        renderBottom();
    }
}

/* ====================  الألواح السفلية  ==================== */

export function setBottomTab(tab) {
    bottomTab = tab;
    document.querySelectorAll('#aiDevBottomTabs .ai-dev-bottom-tab').forEach((b) => {
        b.classList.toggle('active', b.dataset.devBottom === tab);
    });
    renderBottom();
}

/** لوح غير مفعّل: نقول ذلك صراحةً بدل محاكاة شيء غير موجود. */
function notEnabledPanel(title, body) {
    return `<div class="ai-dev-disabled-panel">
        ${icon('lock', 16)}
        <div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(body)}</p></div>
    </div>`;
}

function renderBottom() {
    const wrap = document.getElementById('aiDevBottomBody');
    if (!wrap) return;

    if (bottomTab === 'terminal') {
        wrap.innerHTML = notEnabledPanel(
            'الطرفية غير مفعّلة',
            'لا يوجد تنفيذ أوامر حقيقي في المتصفح — وهذا مقصود. نقطة الامتداد "terminal" معرَّفة في الخادم وتُفعَّل عند ربط بيئة sandbox معزولة.',
        );
        return;
    }

    if (bottomTab === 'changes') {
        wrap.innerHTML = notEnabledPanel(
            'لا توجد تغييرات ملفات',
            'تتبّع التغييرات يحتاج ربط مستودع أو نظام ملفات. نقاط الامتداد "repository" و"filesystem" و"github" معرَّفة وجاهزة للتفعيل من الخادم.',
        );
        return;
    }

    if (bottomTab === 'usage') {
        if (!session) { wrap.innerHTML = '<div class="ai-dim" style="padding:1rem">لا توجد جلسة مفتوحة.</div>'; return; }
        wrap.innerHTML = `
            <div class="ai-usage-strip ai-usage-strip-lg" style="padding:0.75rem 1rem">
                <span>${icon('cpu')} ${formatNumber(session.total_tokens)} توكن</span>
                <span>${icon('dollar')} ${formatCost(session.total_cost)}</span>
                <span>${icon('message')} ${messages.filter((m) => m.channel === 'session').length} رسالة</span>
                <span>${icon('clock')} آخر نشاط: ${formatDate(session.last_active_at)}</span>
            </div>`;
        return;
    }

    // logs — أحداث حقيقية كتبها الخادم لهذه الجلسة
    const logs = messages.filter((m) => m.channel === 'logs');
    wrap.innerHTML = logs.length
        ? `<div class="ai-dev-logs">${logs.slice().reverse().map((l) => `
            <div class="ai-dev-log-line ${l.error ? 'is-error' : ''}">
                <span class="ai-dev-log-time">${formatDate(l.created_at)}</span>
                <span dir="ltr">${escapeHtml(l.content)}</span>
            </div>`).join('')}</div>`
        : '<div class="ai-dim" style="padding:1rem">لا توجد سجلات بعد — ستظهر هنا تفاصيل كل نداء (المزوّد، الموديل، التوكنات، التكلفة، زمن الاستجابة).</div>';
}

function renderFiles() {
    const wrap = document.getElementById('aiDevFiles');
    if (!wrap) return;

    const files = session?.workspace?.files || [];
    wrap.innerHTML = files.length
        ? files.map((f) => `<div class="ai-dev-file" dir="ltr">${icon('file', 12)} ${escapeHtml(f.path || f)}</div>`).join('')
        : `<div class="ai-dev-files-empty">
             ${icon('lock', 14)}
             <span>لا يوجد مصدر ملفات مربوط</span>
             <small>ربط مستودع أو sandbox يُفعَّل من الخادم لاحقًا — لا يوجد وصول لأي نظام ملفات من المتصفح.</small>
           </div>`;
}

/* ====================  توجيه الأحداث  ==================== */

export function handleAction(action, element) {
    if (action === 'send') return send();
    if (action === 'new-session') return newSession();
}
