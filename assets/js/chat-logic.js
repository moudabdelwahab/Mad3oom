import { supabase } from '/api-config.js';
import { guardPage } from '/assets/js/page-guard.js';
import { openChatbotModeDialog } from '/assets/js/chatbot-mode-selector.js';
import { fetchEntitlement } from '/assets/js/sie-plan-service.js';
import { getSieReply } from '/assets/js/sie-client.js';
import { iconize } from '/assets/js/chat-icons.js';
import { signedUrls, SIGNED_URL_TTL, SIGNED_URL_TTL_DOWNLOAD } from '/storage-urls.js';
import { DELETED_MESSAGE_TEXT, EDITED_LABEL, isDeletedMessage, isEditedMessage } from '/assets/js/chat-message-state.js';
import { VoiceRecorder, isVoiceRecordingSupported } from '/assets/js/voice-recorder.js';
import {
    CHAT_ATTACHMENTS_BUCKET, FILE_PICKER_ACCEPT, validateFile, buildObjectPath, messageFieldsFor,
    attachmentFromMessage, renderAttachmentHtml, hydrateAttachments, downscaleImage, uploadAttachment,
    uploadErrorText, autoLabelFor, formatDuration
} from '/assets/js/chat-attachments.js';

// ردود البداية لمحادثة فاضية — نفس ويدجت الشات (chat-widget.js)، وSIE يفهمهما.
const STARTER_OPTIONS = Object.freeze([
    { label: '[[icon:inquiry]] عندي استفسار', value: 'عندي استفسار' },
    { label: '[[icon:problem]] عندي مشكلة', value: 'عندي مشكلة' }
]);

/**
 * تنقية أي نص قادم من المستخدم (رسائل الشات، الأسماء...) قبل حقنه داخل innerHTML
 * لمنع هجمات XSS (Cross-Site Scripting).
 */
function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * تنقية الروابط قبل استخدامها في خصائص مثل src لمنع بروتوكولات خطيرة مثل javascript:
 */
function sanitizeUrl(url) {
    if (!url) return '';
    const trimmed = String(url).trim();
    if (/^(https?:)?\/\//i.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('./')) {
        return escapeHtml(trimmed);
    }
    return '';
}

document.addEventListener('DOMContentLoaded', async () => {
    // State
    let currentUser = null;
    let currentSessionId = null;
    let currentSession = null;
    let messageChannel = null;
    let botSettings = null;
    // استحقاق SIE من الخادم (sie_my_entitlement) — للعرض فقط؛ الحدود نفسها
    // مفروضة على الخادم عند كل رسالة. null = لم يُحمَّل بعد.
    let entitlement = null;
    // هل الجلسة الحالية "دخول كعضو" (impersonation) من أدمن/super_user؟
    // بيتحدد بس على صفحة العميل (window.isCustomerChat)، زي ما هو موضّح فوق.
    let isImpersonated = false;
    // جلسات العميل لقائمة الشريط الجانبي + آخر رسالة في كل جلسة (للمعاينة).
    let customerSessions = [];
    let sessionPreviews = {};
    let sessionSearchQuery = '';
    // التسجيل الصوتي (voice-recorder.js — نفس وحدة الويدجت).
    let voiceRecorder = null;
    let voiceRecording = null; // {blob, mime, ext, durationMs, url} بعد الإيقاف وقبل الإرسال

    // ===== حالة الأفاتار — نفس نظام الويدجت حرفيا (chat-widget.js: setAvatarState
    // و speakBriefly)، مع إعادة توجيه الجذر إلى .chat-wrapper في هذه الصفحة. =====
    const MAD3OOM_AVATAR_SRC = '/assets/images/mad3oom-avatar-3d.webp';
    const AVATAR_FALLBACK_SVG = '<svg class="cc-avatar-fallback" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="14" y="20" width="36" height="30" rx="9"></rect><line x1="32" y1="20" x2="32" y2="10"></line><circle cx="32" cy="7" r="2.5" fill="currentColor" stroke="none"></circle><circle cx="24" cy="34" r="2" fill="currentColor" stroke="none"></circle><circle cx="40" cy="34" r="2" fill="currentColor" stroke="none"></circle><path d="M25 43h14"></path></svg>';
    let avatarState = 'idle';
    let avatarStateTimer = null;

    function avatarImgHtml() {
        return `<img class="cc-avatar-img" src="${MAD3OOM_AVATAR_SRC}" alt="" draggable="false" onerror="this.classList.add('is-broken')">`;
    }

    /** حالة الأفاتار المرئية (data-avatar-state على .chat-wrapper، والـ CSS يحرّكها):
     * idle = انتظار هادئ، thinking = أثناء انتظار رد SIE، speaking = نبضة قصيرة
     * عند وصول رد المساعد، listening = أثناء التسجيل الصوتي، attention = رسالة
     * جديدة والتبويب غير مرئي، error/offline = رمادي بلا حركة. */
    function setAvatarState(state) {
        const root = document.querySelector('.chat-wrapper');
        if (!root) return;
        clearTimeout(avatarStateTimer);
        avatarState = state;
        root.dataset.avatarState = state;
        syncHeaderStatus(state);
    }

    /** رد مساعد وصل للتو: الأفاتار «يتكلم» ثانيتين ثم يعود للانتظار. */
    function speakBriefly() {
        setAvatarState('speaking');
        avatarStateTimer = setTimeout(() => {
            if (avatarState === 'speaking') setAvatarState('idle');
        }, 2000);
    }

    /** نص الحالة في الرأس يتبع حالة الأفاتار (idle = متصل الآن). */
    function syncHeaderStatus(state) {
        const el = document.getElementById('chatHeaderStatus');
        if (!el) return;
        el.textContent = {
            idle: 'متصل الآن',
            thinking: 'يكتب الآن…',
            speaking: 'يرد عليك الآن',
            listening: 'يستمع إليك…',
            attention: 'رسالة جديدة',
            error: 'حدث خطأ — جرّب تاني',
            offline: 'غير متصل'
        }[state] || 'متصل الآن';
    }

    // ===== INITIALIZATION =====
    async function init() {
        // الملف ده بقى بيخدم صفحة شات العميل (chat-customer.html) بس. واجهة
        // الإدارة للشات هي admin/inbox.html (assets/js/admin/inbox.js) —
        // صفحة الأدمن القديمة (chat-admin) اتشالت، والمنطق بتاعها اللي
        // كان هنا اتشال معاها عشان مايبقاش فيه نسختين من شاشة الإدارة.
        if (!window.isCustomerChat) return;

        // الصفحة لازم تحترم "الدخول كعضو" (impersonation) عشان الأدمن/
        // super_user يقدر يشوف الشات بحساب أي عضو فتحه بـ ?impersonate=.
        // الحساب الموقوف كان بيتحوّل لصفحة الدخول، والجلسة سليمة فبيترجع
        // فورًا — نفس حلقة التحويل. الحارس دلوقتي بيعرض السبب في مكانه.
        const user = await guardPage('user');
        if (!user) return;
        isImpersonated = !!user.isImpersonated;
        currentUser = user;

        await loadBotSettings(); // رسالة الترحيب من bot_settings
        await loadCustomerChat();
        setupCustomerChatEventListeners();
        renderImpersonationBanner();
        renderSidebarProfile();
        setupSidebar();
        await loadCustomerSessions();
        // رسالة وصلت والتبويب مخفي (attention): رجوع التبويب للواجهة يلغي التنبيه.
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && avatarState === 'attention') setAvatarState('idle');
        });
    }

    // ===== LOAD CUSTOMER CHAT =====
    async function loadCustomerChat() {
        if (!currentUser) return;

        // جلب أو إنشاء جلسة دردشة للعميل الحالي
        let { data: session, error } = await supabase
            .from('chat_sessions')
            .select('*')
            .eq('user_id', currentUser.id)
            .eq('status', 'active')
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        // إذا لم توجد جلسة مفتوحة، قم بإنشاء واحدة جديدة
        if (error || !session) {
            const { data: newSession, error: createError } = await supabase
                .from('chat_sessions')
                .insert({
                    user_id: currentUser.id,
                    status: 'active'
                })
                .select()
                .single();

            if (createError) {
                console.error('خطأ في إنشاء جلسة دردشة:', createError);
                // لو الخطأ حصل وقت "الدخول كعضو"، السبب الأرجح معروف: جلسة
                // Supabase الحقيقية (auth.uid()) لسه بتاعة الأدمن، مش العضو
                // المستهدف، وRLS على chat_sessions على الأغلب من نوع
                // auth.uid() = user_id فبيرفض الـinsert. ده محتاج تعديل في
                // الباك إند (policy/RPC)، مش حاجة نقدر نصلّحها من هنا -
                // لكن أهم حاجة إننا منسيبش الصفحة فاضية بصمت زي ما كانت.
                const messagesContainer = document.getElementById('chatMessages');
                if (messagesContainer) {
                    const msg = isImpersonated
                        ? 'تعذّر فتح محادثة باسم هذا العضو أثناء "الدخول كعضو". هذه مشكلة معروفة في صلاحيات قاعدة البيانات (RLS) تحتاج تعديل من فريق التطوير الخلفي.'
                        : 'حصل خطأ أثناء تحميل المحادثة. جرب تحدّث الصفحة.';
                    messagesContainer.innerHTML = `<div style="padding:2rem; text-align:center; color:#888;">${escapeHtml(msg)}</div>`;
                }
                return;
            }
            session = newSession;
        }

        currentSessionId = session.id;
        currentSession = session;

        await openSession(session);
    }

    /** يفتح جلسة (حالية أو مختارة من الشريط الجانبي): يحمّل رسائلها ويشترك
     * في تحديثاتها الفورية، ويعلّمها نشطة في القائمة. */
    async function openSession(session) {
        currentSessionId = session.id;
        currentSession = session;
        setComposerEnabled(session.status === 'active');
        if (session.status !== 'active') {
            setComposerStatus('هذه المحادثة مغلقة — ابدأ محادثة جديدة للمتابعة.');
        } else {
            setComposerStatus('');
        }

        // تحميل الرسائل
        await loadCustomerMessages(session.id);

        // الاشتراك في الرسائل الجديدة
        subscribeToSession(session.id);
        markActiveSessionInList();
    }

    function subscribeToSession(sessionId) {
        if (messageChannel) supabase.removeChannel(messageChannel);
        messageChannel = supabase.channel(`chat:${sessionId}`)
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'chat_messages',
                filter: `session_id=eq.${sessionId}`
            }, payload => {
                appendCustomerMessage(payload.new, { live: true });
            })
            // فريق الدعم عدّل رده أو حذفه من صندوق الرسائل (056)
            .on('postgres_changes', {
                event: 'UPDATE',
                schema: 'public',
                table: 'chat_messages',
                filter: `session_id=eq.${sessionId}`
            }, payload => {
                updateCustomerMessage(payload.new);
            })
            .subscribe();
    }

    // ===== LOAD CUSTOMER MESSAGES =====
    async function loadCustomerMessages(sessionId) {
        const { data: messages, error } = await supabase
            .from('chat_messages')
            .select('*')
            .eq('session_id', sessionId)
            .order('created_at', { ascending: true });

        if (error) {
            console.error('خطأ في جلب الرسائل:', error);
            return;
        }

        const chatMessages = document.getElementById('chatMessages');
        if (chatMessages) {
            chatMessages.innerHTML = '';
            (messages || []).forEach(msg => appendCustomerMessage(msg));
            chatMessages.scrollTop = chatMessages.scrollHeight;

            // لو الجلسة جديدة وملهاش رسائل، نخلي البوت يبدأ بترحيب تلقائي.
            // خيارات SIE مرتبطة بالرد نفسه ولا تُحفظ، فلا تُعاد عند إعادة الفتح.
            if ((messages || []).length === 0) {
                await sendInitialGreeting();
            }
        }
    }

    // ===== قائمة جلسات العميل في الشريط الجانبي (بيانات حقيقية فقط) =====
    // العنوان مشتق من تاريخ إنشاء الجلسة (لا عمود عنوان في chat_sessions)،
    // والمعاينة هي نص أحدث رسالة في الجلسة.
    async function loadCustomerSessions() {
        if (!currentUser) return;
        const { data, error } = await supabase
            .from('chat_sessions')
            .select('id, status, created_at, updated_at')
            .eq('user_id', currentUser.id)
            .order('updated_at', { ascending: false })
            .limit(30);
        if (error) {
            console.error('خطأ في جلب جلسات العميل:', error);
            return;
        }
        customerSessions = data || [];
        sessionPreviews = {};
        const ids = customerSessions.map(s => s.id);
        if (ids.length) {
            const { data: msgs } = await supabase
                .from('chat_messages')
                .select('session_id, message_text, created_at')
                .in('session_id', ids)
                .order('created_at', { ascending: false })
                .limit(200);
            (msgs || []).forEach(m => {
                if (!sessionPreviews[m.session_id]) sessionPreviews[m.session_id] = m;
            });
        }
        renderSessionList();
    }

    function sessionTitle(session) {
        const d = new Date(session.created_at);
        const date = Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('ar-EG', { day: 'numeric', month: 'long' });
        return date ? `محادثة ${date}` : 'محادثة';
    }

    function renderSessionList() {
        const listEl = document.getElementById('sessionList');
        const emptyEl = document.getElementById('sessionListEmpty');
        if (!listEl) return;
        const q = sessionSearchQuery.trim();
        const visible = customerSessions.filter(s => {
            if (!q) return true;
            const hay = `${sessionTitle(s)} ${(sessionPreviews[s.id]?.message_text || '')}`;
            return hay.includes(q);
        });
        listEl.innerHTML = '';
        if (emptyEl) emptyEl.hidden = visible.length !== 0;
        visible.forEach(s => {
            const preview = sessionPreviews[s.id];
            const li = document.createElement('li');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'session-item';
            btn.dataset.sessionId = String(s.id);
            if (s.id === currentSessionId) btn.classList.add('active');
            const time = new Date(s.updated_at || s.created_at)
                .toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
            btn.innerHTML = `
                <span class="session-item-top">
                    <span class="session-item-title">${escapeHtml(sessionTitle(s))}</span>
                    <span class="session-item-time">${escapeHtml(time)}</span>
                </span>
                <span class="session-item-preview">
                    <span class="session-status-dot ${s.status === 'active' ? 'is-active' : ''}" aria-hidden="true"></span>
                    <span>${escapeHtml(preview?.message_text || (s.status === 'active' ? 'محادثة جديدة' : 'محادثة مغلقة'))}</span>
                </span>
            `;
            btn.onclick = () => switchCustomerSession(s.id);
            li.appendChild(btn);
            listEl.appendChild(li);
        });
    }

    function markActiveSessionInList() {
        document.querySelectorAll('#sessionList .session-item').forEach(el => {
            el.classList.toggle('active', el.dataset.sessionId === String(currentSessionId));
        });
    }

    async function switchCustomerSession(sessionId) {
        if (!currentUser) return;
        if (sessionId === currentSessionId) { closeSidebarMobile(); return; }
        const { data: session, error } = await supabase
            .from('chat_sessions')
            .select('*')
            .eq('id', sessionId)
            .eq('user_id', currentUser.id)
            .single();
        if (error || !session) {
            console.error('خطأ في فتح الجلسة:', error);
            setComposerStatus('تعذّر فتح هذه المحادثة.', 'error');
            return;
        }
        await openSession(session);
        closeSidebarMobile();
        document.getElementById('chatInput')?.focus({ preventScroll: true });
    }

    /** «محادثة جديدة»: تُغلق الجلسة النشطة الحالية (إن كان فيها رسائل) ثم
     * تُنشأ جلسة نشطة جديدة وتُفتح — بلا نافذة تقييم (التقييم يظهر فقط
     * من زر «إنهاء المحادثة»). الجلسة الفارغة الحالية تُعاد استخدامها. */
    async function startNewCustomerChat() {
        if (!currentUser) return;
        const hasMessages = !!document.querySelector('#chatMessages [data-msg-id]');
        if (currentSessionId && currentSession?.status === 'active' && !hasMessages) {
            closeSidebarMobile();
            document.getElementById('chatInput')?.focus({ preventScroll: true });
            return;
        }
        if (currentSessionId && currentSession?.status === 'active') {
            await supabase.from('chat_sessions')
                .update({ status: 'closed' })
                .eq('id', currentSessionId);
        }
        const { data: newSession, error } = await supabase
            .from('chat_sessions')
            .insert({ user_id: currentUser.id, status: 'active' })
            .select()
            .single();
        if (error || !newSession) {
            console.error('خطأ في إنشاء جلسة جديدة:', error);
            setComposerStatus('تعذّر بدء محادثة جديدة. جرّب تاني.', 'error');
            return;
        }
        await openSession(newSession);
        await loadCustomerSessions();
        closeSidebarMobile();
        document.getElementById('chatInput')?.focus({ preventScroll: true });
    }

    /** تفعيل/تعطيل مربع الكتابة (الجلسة المغلقة للقراءة فقط). */
    function setComposerEnabled(enabled) {
        ['chatInput', 'sendBtn', 'chatAttachBtn', 'chatMicBtn'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.disabled = !enabled;
        });
    }

    // ===== الشريط الجانبي: الملف والتنقل والطي =====
    function renderSidebarProfile() {
        const name = currentUser?.profile?.full_name || currentUser?.profile?.email || 'حسابي';
        const email = currentUser?.profile?.email || '';
        const nameEl = document.getElementById('sidebarUserName');
        const emailEl = document.getElementById('sidebarUserEmail');
        const avatarEl = document.getElementById('sidebarUserAvatar');
        if (nameEl) nameEl.textContent = name;
        if (emailEl) emailEl.textContent = email;
        if (avatarEl) avatarEl.textContent = String(name).trim().charAt(0) || 'م';
    }

    function openSidebarMobile() {
        const sidebar = document.getElementById('chatSidebar');
        const overlay = document.getElementById('sidebarOverlay');
        const toggle = document.getElementById('sidebarToggle');
        sidebar?.classList.add('open');
        if (overlay) overlay.hidden = false;
        toggle?.setAttribute('aria-expanded', 'true');
    }

    function closeSidebarMobile() {
        const sidebar = document.getElementById('chatSidebar');
        const overlay = document.getElementById('sidebarOverlay');
        const toggle = document.getElementById('sidebarToggle');
        sidebar?.classList.remove('open');
        if (overlay) overlay.hidden = true;
        toggle?.setAttribute('aria-expanded', 'false');
    }

    function setupSidebar() {
        const toggle = document.getElementById('sidebarToggle');
        const overlay = document.getElementById('sidebarOverlay');
        const newChatBtn = document.getElementById('newChatBtn');
        const searchInput = document.getElementById('sessionSearchInput');
        const signOutBtn = document.getElementById('sidebarSignOut');

        if (toggle) {
            toggle.onclick = () => {
                const sidebar = document.getElementById('chatSidebar');
                if (sidebar?.classList.contains('open')) closeSidebarMobile();
                else openSidebarMobile();
            };
        }
        if (overlay) overlay.onclick = closeSidebarMobile;
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeSidebarMobile();
        });
        if (newChatBtn) newChatBtn.onclick = startNewCustomerChat;
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                sessionSearchQuery = searchInput.value || '';
                renderSessionList();
            });
        }
        // تسجيل الخروج — نفس مسار القشرة المشتركة (auth-client.js).
        if (signOutBtn) {
            signOutBtn.onclick = async (e) => {
                e.preventDefault();
                try {
                    const { logout } = await import('/auth-client.js');
                    await logout();
                    window.location.replace('/login.html');
                } catch (err) {
                    console.error('Logout failed:', err);
                    localStorage.removeItem('mad3oom-guest-session');
                    window.location.replace('/login.html');
                }
            };
        }
    }

    // ===== QUICK-REPLY OPTIONS (قائمة الاختيارات تحت رسائل البوت) =====
    // بنحقن الـ CSS بتاعت الأزرار من هنا عشان منلمسش ملف chat.html خالص.
    function injectQuickOptionsStyles() {
        if (document.getElementById('botQuickOptionsStyles')) return;
        const style = document.createElement('style');
        style.id = 'botQuickOptionsStyles';
        style.textContent = `
            .bot-quick-options {
                display: flex;
                flex-wrap: wrap;
                gap: 0.5rem;
                margin: 0.25rem 0 0.75rem;
                align-self: flex-start;
                max-width: 85%;
            }
            .bot-quick-option-btn {
                background: #ffffff;
                border: 1.5px solid #003366;
                color: #003366;
                padding: 0.5rem 1rem;
                border-radius: 1.25rem;
                font-family: 'Cairo', sans-serif;
                font-size: 0.85rem;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.15s ease;
                white-space: nowrap;
            }
            .bot-quick-option-btn:hover {
                background: #003366;
                color: #ffffff;
            }
            .bot-quick-option-btn:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
        `;
        document.head.appendChild(style);
    }

    function clearQuickOptions() {
        const existing = document.getElementById('botQuickOptions');
        if (existing) existing.remove();
    }

    function renderQuickOptions(options) {
        clearQuickOptions();
        if (!options || options.length === 0) return;

        const chatMessages = document.getElementById('chatMessages');
        if (!chatMessages) return;

        injectQuickOptionsStyles();

        const wrap = document.createElement('div');
        wrap.className = 'bot-quick-options';
        wrap.id = 'botQuickOptions';

        options.forEach(opt => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'bot-quick-option-btn';
            btn.innerHTML = iconize(escapeHtml(opt.label));
            btn.onclick = () => {
                // تعطيل كل الأزرار فورًا عشان العميل مايضغطش مرتين
                wrap.querySelectorAll('button').forEach(b => b.disabled = true);
                sendCustomerMessage(opt.value);
            };
            wrap.appendChild(btn);
        });

        chatMessages.appendChild(wrap);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    // ===== المرفقات (صور وملفات) =====
    // نفس وحدة الويدجت (chat-attachments.js): تحقق النوع/الحجم، مسار داخل
    // مجلد العميل، رفع بتقدّم حقيقي. الخادم يفرض نفس القواعد (migration 054).
    function setComposerStatus(text, tone = 'info') {
        const el = document.getElementById('chatComposerStatus');
        if (!el) return;
        el.textContent = text || '';
        el.dataset.tone = tone;
        el.hidden = !text;
    }

    async function handleFilesSelected(files, opts = {}) {
        const file = files && files[0];
        if (!file || !currentUser || !currentSessionId) return;
        const first = validateFile(file);
        if (!first.ok) { setComposerStatus(first.error, 'error'); return; }

        const attachBtn = document.getElementById('chatAttachBtn');
        const micBtn = document.getElementById('chatMicBtn');
        if (attachBtn) attachBtn.disabled = true;
        if (micBtn) micBtn.disabled = true;
        let path = null;
        try {
            const body = first.kind === 'image' ? await downscaleImage(file) : file;
            const check = validateFile(body, first.kind);
            if (!check.ok) { setComposerStatus(check.error, 'error'); return; }
            path = buildObjectPath(currentUser.id, currentSessionId, check.ext);
            setComposerStatus('جاري رفع المرفق… 0%');
            await uploadAttachment({
                supabase, path, file: body, contentType: check.mime,
                onProgress: (p) => setComposerStatus(`جاري رفع المرفق… ${Math.round(p * 100)}%`)
            });
            const fields = messageFieldsFor({ kind: check.kind, path, name: body.name || file.name, mime: check.mime, size: body.size, durationMs: opts.durationMs });
            setComposerStatus('');
            const sent = await sendCustomerMessage(undefined, { fields });
            if (!sent) await cleanupUpload(path);
        } catch (err) {
            console.error('خطأ في رفع المرفق:', err);
            setComposerStatus(/[\u0600-\u06FF]/.test(err?.message || '') ? err.message : uploadErrorText(err), 'error');
            if (path) await cleanupUpload(path);
        } finally {
            if (attachBtn) attachBtn.disabled = false;
            if (micBtn) micBtn.disabled = false;
        }
    }

    // ملف رُفع ولم تُحفظ رسالته: يُحذف (سياسة الحذف تسمح فقط بغير المُشار إليه)
    async function cleanupUpload(path) {
        try { await supabase.storage.from(CHAT_ATTACHMENTS_BUCKET).remove([path]); }
        catch (err) { console.warn('تعذّر حذف مرفق لم يُرسل:', err?.message || err); }
    }

    // رسالة بوت ثابتة (ترحيب / SIE مش متاح / عطل / حد المعدل). المتصفح مابيكتبش
    // رسايل البوت بنفسه (062): بيطلب «النوع» والخادم يكتب النص (chat_post_notice
    // — 061). لو المحادثة مع فريق الدعم أو مقفولة الخادم مابيكتبش.
    async function postNotice(kind, seconds = null) {
        if (!currentSessionId) return null;
        const { data, error } = await supabase.rpc('chat_post_notice', {
            p_session: currentSessionId, p_kind: kind, p_seconds: seconds
        });
        if (error) console.error('chat_post_notice failed:', kind, error.message || error);
        return error ? null : data;
    }

    // ===== INITIAL GREETING (أول ما العميل يفتح الشات) =====
    // الخادم بيكتب الترحيب (من إعدادات شات الموقع) مرة واحدة بس ويعلّم greeted.
    async function sendInitialGreeting() {
        if (!currentSessionId) return;
        await postNotice('greeting');
        renderQuickOptions(STARTER_OPTIONS);
    }


    /**
     * يوقّع مرفقات المحادثة (صور، صوت، ملفات) بعد إدراجها في الصفحة.
     * العرض متزامن والتوقيع غير متزامن؛ مرفق فشل توقيعه يُعلَّم «غير متاح»
     * ولا يكسر الرسالة: نص الرسالة أهم من مرفقها.
     */
    function hydrateChatAttachments(root) {
        return hydrateAttachments(root, (paths, { download }) =>
            signedUrls(CHAT_ATTACHMENTS_BUCKET, paths, download ? SIGNED_URL_TTL_DOWNLOAD : SIGNED_URL_TTL));
    }

    /** HTML المرفق + النص المعروض (النص التلقائي يُخفى لأن المرفق نفسه ظاهر). */
    function messageParts(msg) {
        if (isDeletedMessage(msg)) return { attHtml: '', text: DELETED_MESSAGE_TEXT, deleted: true };
        const att = attachmentFromMessage(msg);
        const raw = msg.message_text || '';
        const text = att && raw === autoLabelFor(att) ? '' : raw;
        return { attHtml: att ? renderAttachmentHtml(att, escapeHtml) : '', text };
    }

    // صورة داخل الفقاعة: فتحها بحجمها الكامل في تبويب جديد (رابط موقَّع قصير العمر)
    function bindAttachmentClicks(container) {
        if (!container || container.dataset.attClicks) return;
        container.dataset.attClicks = '1';
        container.addEventListener('click', (e) => {
            const btn = e.target.closest?.('.cw-att-image');
            if (!btn || !container.contains(btn)) return;
            const img = btn.querySelector('img');
            if (img?.src && /^https:\/\//i.test(img.src)) window.open(img.src, '_blank', 'noopener');
        });
    }

    let attachmentStylesInjected = false;
    function injectAttachmentStyles() {
        if (attachmentStylesInjected || document.getElementById('chatAttachmentStyles')) return;
        attachmentStylesInjected = true;
        const style = document.createElement('style');
        style.id = 'chatAttachmentStyles';
        style.textContent = `
            .cw-att { display: block; max-width: 100%; margin-bottom: 0.4rem; }
            .cw-att-image { position: relative; display: block; width: fit-content; max-width: 100%; padding: 0; border: none; background: rgba(0,0,0,0.06); border-radius: 10px; overflow: hidden; cursor: zoom-in; min-width: 80px; min-height: 60px; }
            .cw-att-image.is-ready { background: transparent; min-width: 0; min-height: 0; }
            .cw-att-image img { display: block; max-width: 240px; max-height: 240px; object-fit: cover; }
            .cw-att-image.is-ready .cw-att-loading { display: none; }
            .cw-att-loading { position: absolute; inset: 0; background: rgba(0,0,0,0.05); }
            .cw-att.is-unavailable { opacity: .6; cursor: default; }
            .cw-att-image.is-unavailable::after { content: 'المرفق غير متاح'; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 0.75rem; }
            .cw-att-audio { display: flex; align-items: center; gap: 6px; }
            .cw-att-audio audio { width: 230px; max-width: 100%; height: 36px; }
            .cw-att-meta { font-size: 0.72rem; opacity: .75; white-space: nowrap; unicode-bidi: isolate; }
            .cw-att-file { display: flex; align-items: center; gap: 8px; padding: 0.45rem 0.6rem; border-radius: 10px; border: 1px solid rgba(0,51,102,0.15); background: rgba(255,255,255,0.6); color: inherit; max-width: 260px; }
            .cw-att-file, .cw-att-file * { text-decoration: none !important; }
            .cw-att-file-icon { width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
            .cw-att-file-icon svg { width: 16px; height: 16px; }
            .cw-att-file-text { display: flex; flex-direction: column; min-width: 0; }
            .cw-att-file-name { font-size: 0.8rem; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 190px; }
        `;
        document.head.appendChild(style);
    }

    // ===== APPEND CUSTOMER MESSAGE =====
    // live = وصلت للتو عبر Realtime (وليست من تحميل السجل): رد البوت يحرّك
    // الأفاتار (speaking ثانيتين)، ولو التبويب مخفي يتحول لـ attention.
    function appendCustomerMessage(msg, opts = {}) {
        const chatMessages = document.getElementById('chatMessages');
        if (!chatMessages) return;

        // التحقق من هوية المرسل
        const isOwn = currentUser && msg.sender_id === currentUser.id;
        const time = new Date(msg.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
        // المرفق (صورة/صوت/ملف) فوق النص. لا روابط هنا: المسار يخرج كسمة
        // بيانات ويُوقَّع بعد الإدراج (hydrateChatAttachments).
        injectAttachmentStyles();
        bindAttachmentClicks(chatMessages);
        // الاشتراك الفوري قد يعيد رسالة رُسمت للتو
        if (msg.id && chatMessages.querySelector(`[data-msg-id="${CSS.escape(String(msg.id))}"]`)) return;

        // صف الرسالة: رسائل المساعد بأفاتار مدعوم، ورسائل العميل بفقاعة فقط.
        const rowEl = document.createElement('div');
        rowEl.className = `msg-row ${isOwn ? 'own' : 'agent'}`;
        if (msg.id) rowEl.dataset.msgId = String(msg.id);
        rowEl.innerHTML = isOwn
            ? `<div class="msg sent">${customerMessageHtml(msg, time)}</div>`
            : `<span class="msg-avatar cc-avatar-wrap" aria-hidden="true">${AVATAR_FALLBACK_SVG}${avatarImgHtml()}</span><div class="msg received">${customerMessageHtml(msg, time)}</div>`;

        chatMessages.appendChild(rowEl);
        chatMessages.scrollTop = chatMessages.scrollHeight;
        hydrateChatAttachments(rowEl);

        if (opts.live && !isOwn) {
            if (document.hidden) setAvatarState('attention');
            else if (!msg.is_admin_reply) speakBriefly();
        }
    }

    function customerMessageHtml(msg, time) {
        const { attHtml, text, deleted } = messageParts(msg);
        const body = deleted
            ? `<span style="font-style: italic; opacity: 0.65;">${escapeHtml(text)}</span>`
            : (text ? `<span>${iconize(escapeHtml(text))}</span>` : '');
        const edited = isEditedMessage(msg) ? ` · ${escapeHtml(EDITED_LABEL)}` : '';
        return `
            ${attHtml}
            ${body}
            <div class="msg-time">${time}${edited}</div>
        `;
    }

    /** رد دعم اتعدّل أو اتحذف (056): الرسالة تتحدّث في مكانها. */
    function updateCustomerMessage(msg) {
        const chatMessages = document.getElementById('chatMessages');
        const el = msg?.id && chatMessages?.querySelector(`[data-msg-id="${CSS.escape(String(msg.id))}"]`);
        if (!el) return;
        const time = new Date(msg.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
        const bubble = el.querySelector('.msg');
        if (bubble) bubble.innerHTML = customerMessageHtml(msg, time);
        hydrateChatAttachments(el);
    }

    // ===== التسجيل الصوتي — نفس وحدة الويدجت (voice-recorder.js، حد 3 دقائق) =====
    // التسجيل يُرسل كمرفق صوتي عادي عبر نفس خط أنابيب المرفقات
    // (validateFile/uploadAttachment/messageFieldsFor)، بلا مسار منفصل.
    function setupVoiceRecording() {
        const micBtn = document.getElementById('chatMicBtn');
        if (!micBtn) return;
        if (!isVoiceRecordingSupported()) {
            micBtn.hidden = true;
            return;
        }
        micBtn.onclick = () => {
            if (!currentSessionId || !currentUser || micBtn.disabled) return;
            if (voiceRecorder && (voiceRecorder.state === 'recording' || voiceRecorder.state === 'requesting')) {
                voiceRecorder.stop();
            } else {
                startVoiceRecording();
            }
        };

        const cancelBtn = document.getElementById('recCancelBtn');
        const stopBtn = document.getElementById('recStopBtn');
        const discardBtn = document.getElementById('recDiscardBtn');
        const sendBtn = document.getElementById('recSendBtn');
        if (cancelBtn) cancelBtn.onclick = () => voiceRecorder?.cancel();
        if (stopBtn) stopBtn.onclick = () => voiceRecorder?.stop();
        if (discardBtn) discardBtn.onclick = discardVoiceRecording;
        if (sendBtn) sendBtn.onclick = sendVoiceRecording;
    }

    async function startVoiceRecording() {
        discardVoiceRecording();
        if (!voiceRecorder) {
            voiceRecorder = new VoiceRecorder({
                onState: onRecorderState,
                onTick: (ms) => {
                    const el = document.getElementById('recTimer');
                    if (el) el.textContent = formatDuration(ms);
                }
            });
        }
        setComposerStatus('');
        await voiceRecorder.start();
    }

    function onRecorderState(state, detail) {
        const micBtn = document.getElementById('chatMicBtn');
        if (state === 'error') {
            showRecorderBar(null);
            setComposerStatus(detail?.message || 'تعذّر التسجيل.', 'error');
            if (micBtn) micBtn.classList.remove('is-recording');
            setAvatarState('idle');
        } else if (state === 'recording') {
            showRecorderBar('recording');
            if (micBtn) micBtn.classList.add('is-recording');
            setAvatarState('listening');
        } else if (state === 'requesting') {
            setComposerStatus('بانتظار إذن الميكروفون…');
        } else if (state === 'stopped' && detail) {
            const check = validateFile({ name: '', type: detail.mime, size: detail.blob.size }, 'audio');
            if (!check.ok) {
                showRecorderBar(null);
                setComposerStatus(check.error, 'error');
                if (micBtn) micBtn.classList.remove('is-recording');
                setAvatarState('idle');
                return;
            }
            voiceRecording = { ...detail, mime: check.mime, ext: check.ext, url: URL.createObjectURL(detail.blob) };
            showRecorderBar('preview');
            if (micBtn) micBtn.classList.remove('is-recording');
            setAvatarState('idle');
        } else if (state === 'idle') {
            showRecorderBar(null);
            if (micBtn) micBtn.classList.remove('is-recording');
            if (avatarState === 'listening') setAvatarState('idle');
        }
    }

    /** شريط التسجيل: 'recording' (مؤقت + إيقاف) أو 'preview' (معاينة + إرسال) أو null (مخفي). */
    function showRecorderBar(mode) {
        const bar = document.getElementById('chatRecorderBar');
        if (!bar) return;
        const isPreview = mode === 'preview';
        bar.hidden = !mode;
        bar.classList.toggle('is-preview', isPreview);
        const setHidden = (id, hidden) => {
            const el = document.getElementById(id);
            if (el) el.hidden = hidden;
        };
        setHidden('recCancelBtn', isPreview);
        setHidden('recStatusWrap', isPreview);
        setHidden('recStopBtn', isPreview);
        setHidden('recPreviewAudio', !isPreview);
        setHidden('recDuration', !isPreview);
        setHidden('recDiscardBtn', !isPreview);
        setHidden('recSendBtn', !isPreview);
        if (isPreview && voiceRecording) {
            const audio = document.getElementById('recPreviewAudio');
            const duration = document.getElementById('recDuration');
            if (audio) audio.src = voiceRecording.url;
            if (duration) duration.textContent = formatDuration(voiceRecording.durationMs);
        }
        if (mode === 'recording') {
            const timer = document.getElementById('recTimer');
            if (timer) timer.textContent = '0:00';
        }
    }

    function discardVoiceRecording() {
        if (voiceRecording?.url) URL.revokeObjectURL(voiceRecording.url);
        voiceRecording = null;
        showRecorderBar(null);
    }

    async function sendVoiceRecording() {
        if (!voiceRecording) return;
        const { blob, mime, ext, durationMs } = voiceRecording;
        discardVoiceRecording();
        const file = new File([blob], `voice.${ext}`, { type: mime });
        await handleFilesSelected([file], { durationMs });
    }

    // ===== SETUP CUSTOMER CHAT EVENT LISTENERS =====
    function setupCustomerChatEventListeners() {
        const chatInput = document.getElementById('chatInput');
        const sendBtn = document.getElementById('sendBtn');
        const endChatBtn = document.getElementById('endChatBtn');
        const planBtn = document.getElementById('chatModeInlineBtn');
        const attachBtn = document.getElementById('chatAttachBtn');
        const fileInput = document.getElementById('chatFileInput');

        if (sendBtn) {
            sendBtn.onclick = () => sendCustomerMessage();
        }

        if (chatInput) {
            chatInput.onkeypress = (e) => {
                if (e.key === 'Enter') {
                    sendCustomerMessage();
                }
            };
        }

        if (endChatBtn) {
            endChatBtn.onclick = endCustomerChat;
        }

        // زر الخطة داخل مربع الكتابة: وضع الرد (SIE) + الخطة + الاستخدام
        if (planBtn) {
            planBtn.onclick = openPlanDialogForCustomer;
            refreshPlanChip();
        }

        if (attachBtn && fileInput) {
            fileInput.accept = FILE_PICKER_ACCEPT;
            attachBtn.onclick = () => { setComposerStatus(''); fileInput.value = ''; fileInput.click(); };
            fileInput.onchange = () => handleFilesSelected(fileInput.files);
        }

        setupVoiceRecording();

        // نجوم التقييم: اختيار بصري فقط (الكود الأصلي لا يحفظ التقييم في
        // أي مكان — لا يوجد حفظ في قاعدة البيانات ولا إرسال حقيقي).
        const starsContainer = document.getElementById('starsContainer');
        if (starsContainer) {
            starsContainer.addEventListener('click', (e) => {
                const star = e.target.closest('.star');
                if (!star) return;
                const value = Number(star.dataset.value) || 0;
                starsContainer.querySelectorAll('.star').forEach(s => {
                    s.classList.toggle('active', (Number(s.dataset.value) || 0) <= value);
                });
            });
        }
        const submitRatingBtn = document.getElementById('submitRatingBtn');
        if (submitRatingBtn) {
            submitRatingBtn.onclick = () => {
                const ratingModal = document.getElementById('ratingModal');
                if (ratingModal) ratingModal.style.display = 'none';
            };
        }
        const ratingCloseBtn = document.getElementById('ratingCloseBtn');
        if (ratingCloseBtn) {
            ratingCloseBtn.onclick = () => {
                const ratingModal = document.getElementById('ratingModal');
                if (ratingModal) ratingModal.style.display = 'none';
            };
        }

        // لصق صورة مباشرة في مربع الكتابة
        if (chatInput) {
            chatInput.addEventListener('paste', (e) => {
                const file = [...(e.clipboardData?.files || [])].find(f => /^image\//.test(f.type));
                if (file) { e.preventDefault(); handleFilesSelected([file]); }
            });
        }
    }

    // ===== خطة SIE (من الخادم) =====
    async function refreshPlanChip() {
        entitlement = await fetchEntitlement(supabase);
        const btn = document.getElementById('chatModeInlineBtn');
        const label = document.getElementById('chatPlanLabel');
        if (!btn) return entitlement;
        const ok = entitlement.status === 'ok';
        if (label) label.textContent = ok ? entitlement.planLabel : '';
        btn.dataset.tone = !ok ? 'unknown' : entitlement.hasAccess ? 'ok' : 'blocked';
        btn.title = ok ? `محرك الدعم الذكي (SIE) — الخطة: ${entitlement.planLabel}` : 'محرك الدعم الذكي (SIE)';
        btn.setAttribute('aria-label', `${btn.title}. عرض الخطة والاستخدام`);
        return entitlement;
    }

    /* ==================== بانر "الدخول كعضو" (impersonation) ==================== */    /* ==================== بانر "الدخول كعضو" (impersonation) ==================== */

    /**
     * يعرض بانر واضح فوق شات العميل لو الأدمن/super_user فاتح الصفحة دي
     * "كعضو" (impersonation)، فيه اسم العضو المستهدف وزرار "رجوع لحسابي".
     * ملحوظة: بيتفعّل بس على صفحة العميل (window.isCustomerChat) - أصلاً
     * isImpersonated مبتتحطش true غير في نفس السياق ده (راجع init()).
     */
    function renderImpersonationBanner() {
        const container = document.getElementById('chatImpersonationBanner');
        if (!container) return;

        if (!isImpersonated) {
            container.style.display = 'none';
            container.innerHTML = '';
            return;
        }

        const memberName = currentUser?.profile?.full_name || currentUser?.profile?.email || 'هذا العضو';
        container.style.display = 'block';
        container.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:space-between; gap:0.5rem; padding:0.6rem 1.25rem; background:#fff3cd; border-bottom:1px solid #ffe08a; font-size:0.85rem; color:#8a6300;">
                <span>بتشوف الشات كـ <strong>${escapeHtml(memberName)}</strong></span>
                <button type="button" id="chatExitImpersonationBtn" style="background:#8a6300; color:#fff; border:none; border-radius:8px; padding:0.4rem 0.9rem; font-size:0.8rem; font-weight:700; cursor:pointer; white-space:nowrap;">رجوع لحسابي</button>
            </div>
        `;

        const exitBtn = document.getElementById('chatExitImpersonationBtn');
        if (exitBtn) {
            exitBtn.addEventListener('click', exitImpersonation);
        }
    }

    /** يرجّع الأدمن لصفحته الأصلية بمسح ?impersonate= من العنوان - الجلسة الحقيقية (Supabase auth) أصلاً ما اتغيّرتش. */
    function exitImpersonation() {
        const url = new URL(window.location.href);
        url.searchParams.delete('impersonate');
        window.location.href = url.pathname + url.search;
    }

    function openPlanDialogForCustomer() {
        if (!currentUser) return;
        openChatbotModeDialog({
            userId: currentUser.id,
            returnFocus: document.getElementById('chatModeInlineBtn'),
            onPlanChanged: async (_ent, { label }) => {
                await refreshPlanChip();
                // إشعار على الشاشة بس، زي الويدجت — مش رسالة بوت محفوظة (062).
                setComposerStatus(`تم تغيير خطة SIE إلى ${label}.`);
            }
        });
    }

    /**
     * SIE غير متاح لهذا العميل الآن (موقوف / منتهي / استهلك حده). لا بوت
     * بديل: رسالة واضحة بالسبب داخل المحادثة نفسها، والرسالة تبقى لفريق الدعم.
     */
    async function notifySieUnavailable() {
        // السبب بيتحسب على الخادم (sie_my_entitlement) والنص هناك كمان.
        await postNotice('sie_unavailable');
    }

    // ===== SEND CUSTOMER MESSAGE =====
    // presetText: لو موجودة (جاية من ضغطة على زرار اختيار)، بتتبعت بدل قراءة قيمة الإنبوت.
    // extra.fields: حقول مرفق مرفوع (attachment + image_url/audio_url) من messageFieldsFor.
    // يرجع true لو اتحفظت رسالة العميل (عشان المرفق المرفوع ما يتحذفش).
    async function sendCustomerMessage(presetText, extra = {}) {
        const { fields } = extra;
        const chatInput = document.getElementById('chatInput');
        const text = (presetText !== undefined ? presetText : chatInput?.value || '').trim();
        if ((!text && !fields) || !currentSessionId || !currentUser) return false;

        // يُفرَّغ فورًا (Enter مرتين لا يرسل مرتين) ويُعاد لو فشل الحفظ
        if (presetText === undefined && chatInput) chatInput.value = '';
        clearQuickOptions();
        const typingIndicator = document.getElementById('typingIndicator');

        // 1. حفظ رسالة العميل (نص المرفق التلقائي لو مفيش تعليق)
        const userMessagePayload = {
            session_id: currentSessionId,
            sender_id: currentUser.id,
            message_text: text || autoLabelFor(fields.attachment),
            is_admin_reply: false,
            ...(fields || {})
        };

        const { error: sendError } = await supabase.from('chat_messages').insert(userMessagePayload);

        if (sendError) {
            console.error('خطأ في إرسال الرسالة:', sendError);
            setComposerStatus('فشل إرسال الرسالة. جرّب تاني.', 'error');
            setAvatarState('error');
            if (presetText === undefined && chatInput && text && !chatInput.value) chatInput.value = text;
            return false;
        }
        setComposerStatus('');

        // مرفق بلا نص: يصل لفريق الدعم ويظهر في المحادثة، ولا يُرسل لـ SIE
        // (لا نص يفهمه، ولا نستهلك من حد الرسائل بلا داعٍ).
        if (!text) {
            setComposerStatus('وصل المرفق. اكتب وصف المشكلة لو حابب المساعد يساعدك فيها.');
            return true;
        }

        // 2. الرد عن طريق SIE — المحرك الوحيد. لا بوت بديل مخفي.
        try {
            if (typingIndicator) typingIndicator.style.display = 'flex';
            setAvatarState('thinking');

            // لو الجلسة في وضع "يدوي" (الأدمن بيرد بنفسه)، البوت يسكت
            if (currentSession?.is_manual_mode) return true;

            // جلب أحدث bot_state للجلسة (تحسبًا لتعديل خارجي أو تبويب تاني)
            const { data: freshSession } = await supabase
                .from('chat_sessions')
                .select('bot_state, is_manual_mode')
                .eq('id', currentSessionId)
                .single();

            if (freshSession?.is_manual_mode) return true;

            // الاستحقاق معروف ومقفول (موقوف/منتهي/استهلك حده): نقول السبب بوضوح.
            // غير معروف (فشل التحميل): نحاول SIE — الخادم هو الحكم عند كل رسالة.
            if (entitlement?.status === 'ok' && !entitlement.hasAccess) {
                await notifySieUnavailable();
                return true;
            }

            const sieResult = await getSieReply({
                text,
                supabase,
                sessionId: currentSessionId,
                userId: currentUser.id,
                botState: freshSession?.bot_state || {}
            });

            // null = رفض (حد/صلاحية) أو عطل مؤقت. نسأل الخادم عن السبب الفعلي.
            if (!sieResult) {
                const ent = await refreshPlanChip();
                if (ent?.status === 'ok' && !ent.hasAccess) {
                    await notifySieUnavailable();
                } else {
                    await postNotice('sie_error');
                }
                return true;
            }

            // SIE بيكتب دور المحادثة بنفسه لما يقول alreadyPersisted:
            // رسالة البوت و bot_state والتذكرة لو اتفتحت، كلهم في معاملة
            // واحدة عنده. لو كتبنا هنا كمان، العميل هيشوف نفس الرد مرتين.
            if (sieResult.alreadyPersisted) {
                renderQuickOptions(sieResult.options);
                return true;
            }

            // مفيش رد محفوظ: حد المعدل (الخادم بيكتب رسالته)، أو خادم قديم
            // مابيحفظش — المتصفح مابيكتبش رد البوت ولا bot_state أبدًا (062).
            if (sieResult.rateLimited) {
                await postNotice('rate_limited', sieResult.retryAfterSeconds ?? null);
            } else {
                console.warn('SIE reply was not persisted by the server — not writing it from the browser');
                await postNotice('sie_error');
            }
            renderQuickOptions(sieResult.options);
            return true;
        } catch (err) {
            console.error('خطأ في الرد الآلي:', err);
            setAvatarState('error');
            await postNotice('error');
            return true;
        } finally {
            if (typingIndicator) typingIndicator.style.display = 'none';
            if (avatarState === 'thinking') setAvatarState('idle');
            refreshPlanChip();
        }
    }

    // ===== END CUSTOMER CHAT =====
    async function endCustomerChat() {
        if (!confirm('هل تريد إنهاء المحادثة؟')) return;

        const { error } = await supabase
            .from('chat_sessions')
            .update({ status: 'closed' })
            .eq('id', currentSessionId);

        if (error) {
            console.error('خطأ في إنهاء المحادثة:', error);
            return;
        }

        if (currentSession) currentSession.status = 'closed';
        setComposerEnabled(false);
        setAvatarState('idle');
        await loadCustomerSessions();

        // إظهار نافذة التقييم
        const ratingModal = document.getElementById('ratingModal');
        if (ratingModal) {
            ratingModal.style.display = 'flex';
        }
    }

    // ===== LOAD BOT SETTINGS =====
    async function loadBotSettings() {
        const { data, error } = await supabase.from('bot_settings').select('*').single();

        if (error) {
            console.error('Error loading bot settings:', error);
            botSettings = {};
            return;
        }

        botSettings = data;
    }

    // Start Init
    init();
});
