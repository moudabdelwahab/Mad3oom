import { supabase } from '/api-config.js';
import { getBotReply } from '/assets/js/chatbot-engine.js';

console.log("CHAT LOGIC VERSION 4.0 - LOCAL BOT ENGINE (NO MODEL DEPENDENCY)");

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
    // DOM Elements
    const chatsList = document.getElementById('chatsList');
    const chatMain = document.getElementById('chatMain');
    const emptyState = document.getElementById('emptyState');
    const chatHeader = document.getElementById('chatHeader');
    const messagesContainer = document.getElementById('messagesContainer');
    const inputArea = document.getElementById('inputArea');
    const messageInput = document.getElementById('messageInput');
    const sendBtn = document.getElementById('sendBtn');
    const searchInput = document.getElementById('searchInput');
    const closeChat = document.getElementById('closeChat');

    // Modal Elements
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsModal = document.getElementById('settingsModal');
    const closeSettingsModal = document.getElementById('closeSettingsModal');
    const saveSettings = document.getElementById('saveSettings');
    const cancelSettings = document.getElementById('cancelSettings');

    const exportModal = document.getElementById('exportModal');
    const exportExcel = document.getElementById('exportExcel');
    const exportPDF = document.getElementById('exportPDF');
    const archiveChats = document.getElementById('archiveChats');
    const closeExportModal = document.getElementById('closeExportModal');
    const cancelExport = document.getElementById('cancelExport');

    const exportSingleModal = document.getElementById('exportSingleModal');
    const exportSingleExcel = document.getElementById('exportSingleExcel');
    const exportSinglePDF = document.getElementById('exportSinglePDF');
    const closeExportSingleModal = document.getElementById('closeExportSingleModal');
    const cancelExportSingle = document.getElementById('cancelExportSingle');
    const exportSingleChatBtn = document.getElementById('exportSingleChatBtn');

    const searchInChatBtn = document.getElementById('searchInChatBtn');
    const searchChatBar = document.getElementById('searchChatBar');
    const searchChatInput = document.getElementById('searchChatInput');
    const closeSearchChat = document.getElementById('closeSearchChat');

    const imageUploadBtn = document.getElementById('imageUploadBtn');
    const imageInput = document.getElementById('imageInput');
    const voiceRecordBtn = document.getElementById('voiceRecordBtn');

    let mediaRecorder = null;
    let audioChunks = [];

    // State
    let currentUser = null;
    let isAdmin = false;
    let currentSessionId = null;
    let currentSession = null;
    let messageChannel = null;
    let botSettings = null;
    let allSessions = [];

    // ===== INITIALIZATION =====
    async function init() {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
            window.location.href = '/sign-in.html';
            return;
        }

        currentUser = user;

        // التحقق من الدور من البروفايل لضمان الدقة
        const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle();
        const role = profile?.role || user.user_metadata?.role || 'customer';
        isAdmin = role === 'admin' || role === 'support' || role === 'super_user' || user.email.includes('admin');

        // إذا كان العميل (وليس أدمن)، قم بتحميل دردشة العميل بدلاً من دردشة الأدمن
        if (!isAdmin) {
            await loadBotSettings(); // البوت المحلي محتاج إعدادات bot_settings (رسالة الترحيب وتأكيد التذكرة)
            await loadCustomerChat();
            setupCustomerChatEventListeners();
            return;
        }

        // إذا كان أدمن، قم بتحميل دردشة الأدمن
        await loadBotSettings();
        await loadAllChats();
        setupEventListeners();
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
                return;
            }
            session = newSession;
        }

        currentSessionId = session.id;
        currentSession = session;

        // تحميل الرسائل
        await loadCustomerMessages(session.id);

        // الاشتراك في الرسائل الجديدة
        if (messageChannel) supabase.removeChannel(messageChannel);
        messageChannel = supabase.channel(`chat:${session.id}`)
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'chat_messages',
                filter: `session_id=eq.${session.id}`
            }, payload => {
                appendCustomerMessage(payload.new);
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

            // لو الجلسة جديدة وملهاش رسائل، نخلي البوت يبدأ بترحيب تلقائي
            if ((messages || []).length === 0) {
                await sendInitialGreeting();
            }
        }
    }

    // ===== INITIAL GREETING (أول ما العميل يفتح الشات) =====
    async function sendInitialGreeting() {
        if (!currentSessionId) return;
        const welcome = botSettings?.welcome_message || 'أهلاً بيك في منصة مدعوم! 👋';
        const greetingText = `${welcome} تحب أساعدك إزاي؟ تقدر تسألني عن الاشتراكات والأسعار 💳، أو لو عندك مشكلة تقنية قولّي وهافتحلك تذكرة فورًا 🛠️`;

        await supabase.from('chat_sessions').update({ bot_state: { greeted: true, flow: 'idle' } }).eq('id', currentSessionId);

        await supabase.from('chat_messages').insert({
            session_id: currentSessionId,
            sender_id: null,
            message_text: greetingText,
            is_admin_reply: false,
            is_bot_reply: true
        });
    }

    // ===== APPEND CUSTOMER MESSAGE =====
    function appendCustomerMessage(msg) {
        const chatMessages = document.getElementById('chatMessages');
        if (!chatMessages) return;

        // التحقق من هوية المرسل
        const isOwn = currentUser && msg.sender_id === currentUser.id;
        const time = new Date(msg.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
        const text = msg.message_text || '';

        const messageEl = document.createElement('div');
        messageEl.className = `msg ${isOwn ? 'sent' : 'received'}`;
        messageEl.innerHTML = `
            <span>${escapeHtml(text)}</span>
            <div style="font-size: 0.75rem; margin-top: 0.25rem; opacity: 0.7;">${time}</div>
        `;

        chatMessages.appendChild(messageEl);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    // ===== SETUP CUSTOMER CHAT EVENT LISTENERS =====
    function setupCustomerChatEventListeners() {
        const chatInput = document.getElementById('chatInput');
        const sendBtn = document.getElementById('sendBtn');
        const endChatBtn = document.getElementById('endChatBtn');

        if (sendBtn) {
            sendBtn.onclick = sendCustomerMessage;
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
    }

    // ===== SEND CUSTOMER MESSAGE =====
    async function sendCustomerMessage() {
        const chatInput = document.getElementById('chatInput');
        if (!chatInput) return;

        const text = chatInput.value.trim();
        if (!text || !currentSessionId || !currentUser) return;

        chatInput.value = '';
        const typingIndicator = document.getElementById('typingIndicator');

        // 1. حفظ رسالة المستخدم في قاعدة البيانات
        const { error: sendError } = await supabase.from('chat_messages').insert({
            session_id: currentSessionId,
            sender_id: currentUser.id,
            message_text: text,
            is_admin_reply: false
        });

        if (sendError) {
            console.error('خطأ في إرسال الرسالة:', sendError);
            alert('فشل في إرسال الرسالة');
            return;
        }

        // 2. الرد عن طريق المحرك المحلي (بدون أي اعتماد على موديل خارجي)
        try {
            if (typingIndicator) typingIndicator.style.display = 'block';

            // لو الجلسة في وضع "يدوي" (الأدمن بيرد بنفسه)، البوت يسكت
            if (currentSession?.is_manual_mode) {
                return;
            }

            // جلب أحدث bot_state للجلسة (تحسبًا لتعديل خارجي أو تبويب تاني)
            const { data: freshSession } = await supabase
                .from('chat_sessions')
                .select('bot_state, is_manual_mode')
                .eq('id', currentSessionId)
                .single();

            if (freshSession?.is_manual_mode) return;

            const { reply } = await getBotReply({
                text,
                supabase,
                sessionId: currentSessionId,
                userId: currentUser.id,
                botState: freshSession?.bot_state || {},
                botSettings
            });

            await supabase.from('chat_messages').insert({
                session_id: currentSessionId,
                sender_id: null,
                message_text: reply,
                is_admin_reply: false,
                is_bot_reply: true
            });

        } catch (err) {
            console.error("خطأ في البوت:", err);

            await supabase.from('chat_messages').insert({
                session_id: currentSessionId,
                sender_id: null,
                message_text: 'عذراً، حدث خطأ بسيط أثناء معالجة طلبك. تقدر تكتب "عندي مشكلة" وهافتحلك تذكرة دعم مباشرة.',
                is_admin_reply: false,
                is_bot_reply: true
            });
        } finally {
            if (typingIndicator) typingIndicator.style.display = 'none';
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

    // ===== LOAD ALL CHATS (ADMIN) =====
    async function loadAllChats() {
        const { data, error } = await supabase
            .from('chat_sessions')
            .select(`
                *,
                profiles:user_id (full_name, avatar_url),
                chat_messages (message_text, created_at)
            `)
            .order('updated_at', { ascending: false });

        if (error) {
            console.error('Error loading chats:', error);
            return;
        }

        allSessions = data;
        renderChatsList(data);
    }

    function renderChatsList(sessions) {
        if (!chatsList) return;
        chatsList.innerHTML = '';

        sessions.forEach(session => {
            const lastMsg = session.chat_messages?.[session.chat_messages.length - 1];
            const time = lastMsg ? new Date(lastMsg.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }) : '';

            const item = document.createElement('div');
            item.className = `chat-item ${currentSessionId === session.id ? 'active' : ''}`;
            item.onclick = () => selectChat(session);

            item.innerHTML = `
                <div class="chat-item-avatar">
                    <img src="${sanitizeUrl(session.profiles?.avatar_url) || '/assets/images/default-avatar.png'}" alt="User">
                </div>
                <div class="chat-item-info">
                    <div class="chat-item-header">
                        <span class="chat-item-name">${escapeHtml(session.profiles?.full_name || 'عميل مجهول')}</span>
                        <span class="chat-item-time">${time}</span>
                    </div>
                    <div class="chat-item-last-msg">${escapeHtml(lastMsg?.message_text || 'لا توجد رسائل')}</div>
                </div>
            `;
            chatsList.appendChild(item);
        });
    }

    async function selectChat(session) {
        currentSessionId = session.id;
        currentSession = session;

        if (emptyState) emptyState.style.display = 'none';
        if (chatMain) chatMain.style.display = 'flex';

        // Update Header
        const headerName = document.getElementById('chatHeaderName');
        const headerImg = document.getElementById('chatHeaderImg');
        if (headerName) headerName.textContent = session.profiles?.full_name || 'عميل مجهول';
        if (headerImg) headerImg.src = session.profiles?.avatar_url || '/assets/images/default-avatar.png';

        await loadMessages(session.id);

        // Subscribe to changes
        if (messageChannel) supabase.removeChannel(messageChannel);
        messageChannel = supabase.channel(`chat:${session.id}`)
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'chat_messages',
                filter: `session_id=eq.${session.id}`
            }, payload => {
                appendMessage(payload.new);
            })
            .subscribe();

        renderChatsList(allSessions);
    }

    async function loadMessages(sessionId) {
        const { data, error } = await supabase
            .from('chat_messages')
            .select('*')
            .eq('session_id', sessionId)
            .order('created_at', { ascending: true });

        if (error) return;

        if (messagesContainer) {
            messagesContainer.innerHTML = '';
            data.forEach(msg => appendMessage(msg));
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
    }

    function appendMessage(msg) {
        if (!messagesContainer) return;

        const isOwn = msg.is_admin_reply;
        const time = new Date(msg.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

        const div = document.createElement('div');
        div.className = `msg ${isOwn ? 'sent' : 'received'}`;
        div.innerHTML = `
            <span>${escapeHtml(msg.message_text)}</span>
            <div style="font-size: 0.7rem; opacity: 0.7; margin-top: 4px;">${time}</div>
        `;

        messagesContainer.appendChild(div);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    function setupEventListeners() {
        if (sendBtn) sendBtn.onclick = sendMessage;
        if (messageInput) {
            messageInput.onkeypress = (e) => {
                if (e.key === 'Enter') sendMessage();
            };
        }
        if (searchInput) {
            searchInput.oninput = (e) => {
                const term = e.target.value.toLowerCase();
                const filtered = allSessions.filter(s =>
                    (s.profiles?.full_name || '').toLowerCase().includes(term)
                );
                renderChatsList(filtered);
            };
        }
    }

    async function sendMessage() {
        const text = messageInput.value.trim();
        if (!text || !currentSessionId) return;

        messageInput.value = '';

        // لما الأدمن يرد يدوي، نوقف البوت في الجلسة دي عشان منردش مرتين
        await supabase.from('chat_sessions').update({ is_manual_mode: true }).eq('id', currentSessionId);

        await supabase.from('chat_messages').insert({
            session_id: currentSessionId,
            sender_id: currentUser.id,
            message_text: text,
            is_admin_reply: true
        });
    }

    // Start Init
    init();
});
