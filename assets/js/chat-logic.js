import { supabase } from '/api-config.js';
import { getBotReply, MAIN_MENU_OPTIONS, getOptionsForFlow } from '/assets/js/chatbot-engine.js';

console.log("CHAT LOGIC VERSION 5.1 - LOCAL BOT ENGINE WITH QUICK-REPLY MENU + IMAGE ATTACH");

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

    // اسم الـ Storage bucket المستخدم لحفظ صور المشاكل المرفقة من العميل.
    // لازم يكون موجود في Supabase مع policy تسمح للعميل يرفع في مجلده الخاص
    // (المسار بيبدأ بـ user.id) وتسمح بقراءة عامة للملفات عشان تُعرض في الشات ولوحة الأدمن.
    const CHAT_ATTACHMENTS_BUCKET = 'chat-attachments';

    // Input مخفي لاختيار صورة المشكلة (يُستخدم مع زرار "إرفاق صورة" في IMAGE_STEP_OPTIONS)
    let hiddenImageInput = null;

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
            } else if (!currentSession?.is_manual_mode) {
                // جلسة قديمة عندها رسائل: نعرض تاني الأزرار المناسبة لآخر حالة فلو
                // محفوظة (مثلاً لو العميل قفل المتصفح وهو لسه في نص فتح تذكرة)
                renderQuickOptions(getOptionsForFlow(currentSession?.bot_state?.flow));
            }
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
            btn.textContent = opt.label;
            btn.onclick = () => {
                // تعطيل كل الأزرار فورًا عشان العميل مايضغطش مرتين
                wrap.querySelectorAll('button').forEach(b => b.disabled = true);

                // زرار "إرفاق صورة" خاص: لازم يفتح نافذة اختيار ملف حقيقية
                // ويرفعها، مش يبعت قيمته كنص عادي في الشات.
                if (opt.value === '__attach_image__') {
                    openImagePicker(wrap);
                    return;
                }

                sendCustomerMessage(opt.value);
            };
            wrap.appendChild(btn);
        });

        chatMessages.appendChild(wrap);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    // ===== إرفاق صورة المشكلة (تكميل الفيتشر) =====
    function ensureImageInput() {
        if (hiddenImageInput) return hiddenImageInput;
        hiddenImageInput = document.createElement('input');
        hiddenImageInput.type = 'file';
        hiddenImageInput.accept = 'image/png,image/jpeg,image/webp,image/gif';
        hiddenImageInput.style.display = 'none';
        document.body.appendChild(hiddenImageInput);
        return hiddenImageInput;
    }

    function openImagePicker(optionsWrapEl) {
        const input = ensureImageInput();
        input.value = ''; // يسمح باختيار نفس الملف تاني لو حصل إلغاء قبل كده

        input.onchange = async (e) => {
            const file = e.target.files && e.target.files[0];

            // العميل فتح نافذة اختيار الملف وقفلها من غير ما يختار صورة
            if (!file) {
                renderQuickOptions(getOptionsForFlow('awaiting_problem_image'));
                return;
            }

            await handleImageSelected(file);
        };

        input.click();
    }

    async function handleImageSelected(file) {
        const typingIndicator = document.getElementById('typingIndicator');
        const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

        if (file.size > MAX_SIZE_BYTES) {
            await appendBotOnlyMessage('الصورة كبيرة عن الحد المسموح (5 ميجا)، جرب صورة أصغر أو دوس "تخطي وإنشاء التذكرة".');
            renderQuickOptions(getOptionsForFlow('awaiting_problem_image'));
            return;
        }

        try {
            if (typingIndicator) typingIndicator.style.display = 'block';

            const safeExt = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
            const filePath = `${currentUser.id}/${currentSessionId}-${Date.now()}.${safeExt}`;

            const { error: uploadError } = await supabase.storage
                .from(CHAT_ATTACHMENTS_BUCKET)
                .upload(filePath, file, { cacheControl: '3600', upsert: false, contentType: file.type });

            let imageUrl = null;
            if (uploadError) {
                console.error('خطأ في رفع صورة المشكلة:', uploadError);
            } else {
                const { data: publicData } = supabase.storage
                    .from(CHAT_ATTACHMENTS_BUCKET)
                    .getPublicUrl(filePath);
                imageUrl = publicData?.publicUrl || null;
            }

            if (!imageUrl) {
                // فشل الرفع: نكمل إنشاء التذكرة من غير صورة زي ما بيحصل مع "تخطي"،
                // مع إعلام العميل بالسبب (الرسالة دي كانت جاهزة في المحرك ومش مستخدمة).
                await appendBotOnlyMessage('حصل خطأ في رفع الصورة، التذكرة هتتفتح من غيرها، تقدر تبعتها بعدين لفريق الدعم مباشرة.');
                await sendCustomerMessage('تخطي');
                return;
            }

            await sendCustomerMessage('تم إرفاق صورة المشكلة', { imageUrl });
        } finally {
            if (typingIndicator) typingIndicator.style.display = 'none';
        }
    }

    // رسالة بوت مباشرة في الشات من غير ما تعتبر رسالة عميل وتُبعت للمحرك
    async function appendBotOnlyMessage(text) {
        if (!currentSessionId) return;
        await supabase.from('chat_messages').insert({
            session_id: currentSessionId,
            sender_id: null,
            message_text: text,
            is_admin_reply: false,
            is_bot_reply: true
        });
    }

    // ===== INITIAL GREETING (أول ما العميل يفتح الشات) =====
    async function sendInitialGreeting() {
        if (!currentSessionId) return;
        const welcome = botSettings?.welcome_message || 'أهلاً بيك في منصة مدعوم! 👋';
        const greetingText = `${welcome}\nاختار من الاختيارات دي 👇 أو اكتبلي طلبك بحريتك:`;

        await supabase.from('chat_sessions').update({ bot_state: { greeted: true, flow: 'main_menu' } }).eq('id', currentSessionId);

        await supabase.from('chat_messages').insert({
            session_id: currentSessionId,
            sender_id: null,
            message_text: greetingText,
            is_admin_reply: false,
            is_bot_reply: true
        });

        renderQuickOptions(MAIN_MENU_OPTIONS);
    }

    // ===== APPEND CUSTOMER MESSAGE =====
    function appendCustomerMessage(msg) {
        const chatMessages = document.getElementById('chatMessages');
        if (!chatMessages) return;

        // التحقق من هوية المرسل
        const isOwn = currentUser && msg.sender_id === currentUser.id;
        const time = new Date(msg.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
        const text = msg.message_text || '';

        // لو الرسالة فيها صورة مرفقة (image_url)، نعرضها فوق النص بأمان
        const safeImageUrl = sanitizeUrl(msg.image_url);
        const imgHtml = safeImageUrl
            ? `<img src="${safeImageUrl}" alt="صورة مرفقة" style="max-width:220px;border-radius:10px;display:block;margin-bottom:0.4rem;">`
            : '';

        const messageEl = document.createElement('div');
        messageEl.className = `msg ${isOwn ? 'sent' : 'received'}`;
        messageEl.innerHTML = `
            ${imgHtml}
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
    }

    // ===== SEND CUSTOMER MESSAGE =====
    // presetText: لو موجودة (جاية من ضغطة على زرار اختيار)، بتتبعت بدل قراءة قيمة الإنبوت
    // extra.imageUrl: رابط صورة مرفقة حقيقي (بعد رفعها لـ Storage) بيتحفظ مع الرسالة
    //                 وبيتمرر لمحرك البوت عشان يربطه بالتذكرة.
    async function sendCustomerMessage(presetText, extra = {}) {
        const { imageUrl } = extra;
        const chatInput = document.getElementById('chatInput');
        const text = (presetText !== undefined ? presetText : chatInput?.value || '').trim();
        if (!text || !currentSessionId || !currentUser) return;

        if (presetText === undefined && chatInput) chatInput.value = '';
        clearQuickOptions();
        const typingIndicator = document.getElementById('typingIndicator');

        // 1. حفظ رسالة المستخدم في قاعدة البيانات (مع رابط الصورة لو موجود)
        const userMessagePayload = {
            session_id: currentSessionId,
            sender_id: currentUser.id,
            message_text: text,
            is_admin_reply: false
        };
        if (imageUrl) userMessagePayload.image_url = imageUrl;

        const { error: sendError } = await supabase.from('chat_messages').insert(userMessagePayload);

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

            const { reply, options } = await getBotReply({
                text,
                supabase,
                sessionId: currentSessionId,
                userId: currentUser.id,
                botState: freshSession?.bot_state || {},
                botSettings,
                imageUrl
            });

            await supabase.from('chat_messages').insert({
                session_id: currentSessionId,
                sender_id: null,
                message_text: reply,
                is_admin_reply: false,
                is_bot_reply: true
            });

            renderQuickOptions(options);

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
    // ملحوظة: شيلنا avatar_url من الكويري لأن جدول profiles مفيهوش العمود ده أصلاً،
    // وده كان سبب فشل الكويري بالكامل وضل شاشة "جاري تحميل المحادثات..." معلقة للأبد.
    // التصميم نفسه (شكل الواتساب) متغيرش، بس JS بقى مطابق لنفس الكلاسات الموجودة عندك في chat-admin.html
    async function loadAllChats() {
        const { data, error } = await supabase
            .from('chat_sessions')
            .select(`
                *,
                profiles:user_id (full_name),
                chat_messages (message_text, created_at)
            `)
            .order('updated_at', { ascending: false });

        if (error) {
            console.error('Error loading chats:', error);
            if (chatsList) {
                chatsList.innerHTML = '<div style="padding: 2rem 1rem; text-align: center; color: var(--text-light);">حصل خطأ في تحميل المحادثات، حاول تعمل تحديث للصفحة</div>';
            }
            return;
        }

        allSessions = data || [];
        renderChatsList(allSessions);
    }

    function getInitial(name) {
        const trimmed = (name || '').trim();
        return trimmed ? trimmed.charAt(0) : 'ع';
    }

    function renderChatsList(sessions) {
        if (!chatsList) return;
        chatsList.innerHTML = '';

        if (!sessions || sessions.length === 0) {
            chatsList.innerHTML = '<div style="padding: 2rem 1rem; text-align: center; color: var(--text-light);">لا توجد محادثات حتى الآن</div>';
            return;
        }

        sessions.forEach(session => {
            const messages = session.chat_messages || [];
            const lastMsg = messages.length ? messages[messages.length - 1] : null;
            const time = lastMsg ? new Date(lastMsg.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }) : '';
            const name = session.profiles?.full_name || 'عميل مجهول';
            const statusClass = session.status === 'closed' ? 'status-closed' : 'status-open';
            const statusLabel = session.status === 'closed' ? 'مغلقة' : 'نشطة';

            const item = document.createElement('div');
            item.className = `chat-item ${currentSessionId === session.id ? 'active' : ''}`;
            item.onclick = () => selectChat(session);

            item.innerHTML = `
                <div class="chat-avatar">${escapeHtml(getInitial(name))}</div>
                <div class="chat-info">
                    <div class="chat-header-text">
                        <span class="chat-name">
                            ${escapeHtml(name)}
                            <span class="status-badge ${statusClass}">${statusLabel}</span>
                        </span>
                        <span class="chat-time">${time}</span>
                    </div>
                    <div class="chat-preview">${escapeHtml(lastMsg?.message_text || 'لا توجد رسائل')}</div>
                </div>
            `;
            chatsList.appendChild(item);
        });
    }

    async function selectChat(session) {
        currentSessionId = session.id;
        currentSession = session;

        const emptyStateEl = document.getElementById('emptyState');
        const chatHeaderEl = document.getElementById('chatHeader');
        const inputAreaEl = document.getElementById('inputArea');
        const chatMainEl = document.getElementById('chatMain');

        if (emptyStateEl) emptyStateEl.style.display = 'none';
        if (chatHeaderEl) chatHeaderEl.style.display = 'flex';
        if (inputAreaEl) inputAreaEl.style.display = 'flex';
        if (chatMainEl) chatMainEl.classList.add('active'); // لتفعيل وضع الموبايل المعرّف أصلاً في الـ CSS بتاعك

        // Update Header
        const name = session.profiles?.full_name || 'عميل مجهول';
        const headerName = document.getElementById('headerName');
        const headerAvatar = document.getElementById('headerAvatar');
        const headerStatus = document.getElementById('headerStatus');
        if (headerName) headerName.textContent = name;
        if (headerAvatar) headerAvatar.textContent = getInitial(name);
        if (headerStatus) headerStatus.textContent = session.status === 'closed' ? 'محادثة مغلقة' : 'نشط الآن';

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

        // is_admin_reply = رد الأدمن (يظهر يمين زي رسائلك انت)، أي حاجة تانية (عميل أو بوت) تظهر شمال
        const isOwn = msg.is_admin_reply;
        const time = new Date(msg.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

        // لو رسالة العميل فيها صورة مرفقة، نعرضها للأدمن كمان في نفس الفقاعة
        const safeImageUrl = sanitizeUrl(msg.image_url);
        const imgHtml = safeImageUrl
            ? `<img src="${safeImageUrl}" alt="صورة مرفقة" style="max-width:220px;border-radius:10px;display:block;margin-bottom:0.4rem;">`
            : '';

        const group = document.createElement('div');
        group.className = `message-group ${isOwn ? 'sent' : 'received'}`;
        group.innerHTML = `
            <div class="message-bubble ${isOwn ? 'sent' : 'received'}">
                ${imgHtml}
                <div>${escapeHtml(msg.message_text)}</div>
                <div class="message-time">${time}</div>
            </div>
        `;

        messagesContainer.appendChild(group);
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
        if (closeChat) {
            closeChat.onclick = () => {
                const emptyStateEl = document.getElementById('emptyState');
                const chatHeaderEl = document.getElementById('chatHeader');
                const inputAreaEl = document.getElementById('inputArea');
                const chatMainEl = document.getElementById('chatMain');
                if (messageChannel) { supabase.removeChannel(messageChannel); messageChannel = null; }
                currentSessionId = null;
                currentSession = null;
                if (chatHeaderEl) chatHeaderEl.style.display = 'none';
                if (inputAreaEl) inputAreaEl.style.display = 'none';
                if (emptyStateEl) emptyStateEl.style.display = 'flex';
                if (chatMainEl) chatMainEl.classList.remove('active'); // رجوع لوضعية الموبايل (القائمة)
                renderChatsList(allSessions);
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
