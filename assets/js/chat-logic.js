import { supabase } from '/api-config.js';
import { guardPage } from '/assets/js/page-guard.js';
import { getBotReply, MAIN_MENU_OPTIONS, getOptionsForFlow } from '/assets/js/chatbot-engine.js';
import { openChatbotModeDialog } from '/assets/js/chatbot-mode-selector.js';
import { CHATBOT_MODE_LABELS, CHATBOT_MODES, fetchChatbotModeState, getSieAccessInfo, saveChatbotModeState } from '/assets/js/chatbot-mode-service.js';
import { getSieReply } from '/assets/js/sie-client.js';
import { iconize } from '/assets/js/chat-icons.js';
import { signedUrl, signedUrls } from '/storage-urls.js';

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
    // اسم الـ Storage bucket المستخدم لحفظ صور المشاكل المرفقة من العميل.
    // لازم يكون موجود في Supabase مع policy تسمح للعميل يرفع في مجلده الخاص
    // (المسار بيبدأ بـ user.id) وتسمح بقراءة عامة للملفات عشان تُعرض في الشات ولوحة الأدمن.
    const CHAT_ATTACHMENTS_BUCKET = 'chat-attachments';

    // Input مخفي لاختيار صورة المشكلة (يُستخدم مع زرار "إرفاق صورة" في IMAGE_STEP_OPTIONS)
    let hiddenImageInput = null;

    // State
    let currentUser = null;
    let currentSessionId = null;
    let currentSession = null;
    let messageChannel = null;
    let botSettings = null;
    // كاش لوضع الشات بوت المختار من العميل (traditional/ai_model/auto/sie) -
    // بيتقرا مرة عند بداية الجلسة، وبيتحدّث فورًا لما العميل يغيّر اختياره
    // من نافذة الإعدادات (refreshChatModeButtonLabel)، عشان مفيش استعلام
    // إضافي لقاعدة البيانات مع كل رسالة بيبعتها العميل.
    let cachedChatbotMode = 'traditional';
    // هل الجلسة الحالية "دخول كعضو" (impersonation) من أدمن/super_user؟
    // بيتحدد بس على صفحة العميل (window.isCustomerChat)، زي ما هو موضّح فوق.
    let isImpersonated = false;

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

        await loadBotSettings(); // البوت المحلي محتاج إعدادات bot_settings (رسالة الترحيب وتأكيد التذكرة)
        await loadCustomerChat();
        setupCustomerChatEventListeners();
        renderImpersonationBanner();
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
            btn.innerHTML = iconize(escapeHtml(opt.label));
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

            // المستودع خاص الآن: نخزّن **المسار** في image_url، ويُوقَّع عند العرض.
            // حفظ رابط موقَّع في القاعدة كان سينتج صفوفًا بروابط ميتة بعد دقائق.
            let imageUrl = null;
            if (uploadError) {
                console.error('خطأ في رفع صورة المشكلة:', uploadError);
            } else {
                imageUrl = filePath;
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


    /**
     * يوقّع صور المحادثة بعد إدراجها في الصفحة.
     *
     * العرض متزامن والتوقيع غير متزامن، فالصورة تُدرج بلا src ثم تظهر عند وصول
     * رابطها. الفشل يُخفي الصورة ولا يكسر الرسالة: نص الرسالة أهم من مرفقها.
     */
    async function hydrateChatImages(root) {
        if (!root) return;
        const imgs = Array.from(root.querySelectorAll('img[data-storage-path]'));
        if (imgs.length === 0) return;
        const urls = await signedUrls(CHAT_ATTACHMENTS_BUCKET, imgs.map(el => el.dataset.storagePath));
        imgs.forEach((el, i) => {
            el.removeAttribute('data-storage-path');
            // الرابط الموقَّع يأتي من خدمة التخزين، لكن لا يُسند إلى src إلا بعد
            // التأكد أنه https فعلًا: قيمة لا تطابق ذلك ليست رابطًا نثق به.
            if (urls[i] && /^https:\/\//i.test(urls[i])) {
                el.src = urls[i];
                el.style.display = 'block';
            } else {
                el.remove();
            }
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

        // لو الرسالة فيها صورة مرفقة (image_url)، نعرضها فوق النص بأمان
        // لا src هنا: المسار يخرج كسمة بيانات ويُوقَّع بعد الإدراج (hydrateChatImages).
        const imgHtml = msg.image_url
            ? `<img data-storage-path="${escapeHtml(msg.image_url)}" alt="صورة مرفقة" style="max-width:220px;border-radius:10px;display:none;margin-bottom:0.4rem;">`
            : '';

        const messageEl = document.createElement('div');
        messageEl.className = `msg ${isOwn ? 'sent' : 'received'}`;
        messageEl.innerHTML = `
            ${imgHtml}
            <span>${iconize(escapeHtml(text))}</span>
            <div style="font-size: 0.75rem; margin-top: 0.25rem; opacity: 0.7;">${time}</div>
        `;

        chatMessages.appendChild(messageEl);
        chatMessages.scrollTop = chatMessages.scrollHeight;
        hydrateChatImages(messageEl);
    }

    // ===== SETUP CUSTOMER CHAT EVENT LISTENERS =====
    function setupCustomerChatEventListeners() {
        const chatInput = document.getElementById('chatInput');
        const sendBtn = document.getElementById('sendBtn');
        const endChatBtn = document.getElementById('endChatBtn');
        const chatModeBtn = document.getElementById('chatModeBtn');
        const chatModeInlineBtn = document.getElementById('chatModeInlineBtn');

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

        if (chatModeBtn) {
            chatModeBtn.onclick = openChatModeDialogForCustomer;
        }

        // زرار وضع الشات بوت المصغّر جنب مربع الكتابة نفسه - نفس النافذة
        // بالظبط اللي بيفتحها زرار الهيدر (chatModeBtn)، مجرد نقطة وصول
        // تانية أقرب للمكان اللي العميل عينه فيه فعلاً وهو بيكتب.
        if (chatModeInlineBtn) {
            chatModeInlineBtn.onclick = openChatModeDialogForCustomer;
        }

        // تحديث تسمية الوضع مرة واحدة يكفي الاتنين (الزرارين بيقرأوا نفس
        // الحالة المحفوظة في cachedChatbotMode/CHATBOT_MODE_LABELS)
        if (chatModeBtn || chatModeInlineBtn) {
            refreshChatModeButtonLabel();
        }
    }

    // ===== وضع الشات بوت (تقليدي / نموذج ذكاء اصطناعي / تلقائي / SIE) =====
    async function refreshChatModeButtonLabel() {
        if (!currentUser) return;
        try {
            const state = await fetchChatbotModeState(currentUser.id);
            cachedChatbotMode = state.chatbot_mode || 'traditional';
            const label = document.getElementById('chatModeBtnLabel');
            if (label) {
                label.textContent = CHATBOT_MODE_LABELS[cachedChatbotMode] || CHATBOT_MODE_LABELS.traditional;
            }
        } catch (err) {
            console.warn('تعذّر تحديث تسمية وضع الشات بوت:', err?.message || err);
        }
    }

    /* ==================== بانر "الدخول كعضو" (impersonation) ==================== */

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

    function openChatModeDialogForCustomer() {
        if (!currentUser) return;
        openChatbotModeDialog({
            userId: currentUser.id,
            onModeChanged: () => refreshChatModeButtonLabel()
        });
    }

    /**
     * العميل مختار SIE (chatbot_mode) لكن صلاحيته اتسحبت وهو *في نص محادثة*
     * فعلاً (اكتشفناها وقت إرسال رسالة، مش وقت فتح نافذة الإعدادات). لازم:
     *  1) نحفظ التحويل للتقليدي في قاعدة البيانات فعليًا (مش بس متغيّر محلي)
     *     عشان أي قراءة تانية للحالة (نافذة الإعدادات، تحميل الصفحة تاني)
     *     تطابق الواقع.
     *  2) نحدّث الحالة المحلية فورًا (cachedChatbotMode + نص الزرار).
     *  3) نكتب رسالة واضحة *داخل نص المحادثة نفسها* - مش toast ممكن يفوته -
     *     عشان يبقى مؤكد إن العميل شاف واستوعب إنه بقى بيكلم محرك مختلف.
     */
    async function handleSieRevokedMidConversation(sieAccess) {
        cachedChatbotMode = 'traditional';
        const label = document.getElementById('chatModeBtnLabel');
        if (label) label.textContent = CHATBOT_MODE_LABELS.traditional;

        try {
            await saveChatbotModeState(currentUser.id, { mode: 'traditional', integrationId: null, modelId: null });
        } catch (err) {
            console.warn('تعذّر حفظ التحويل التلقائي عن SIE:', err?.message || err);
        }

        const reason = sieAccess?.statusLabel;
        let why = 'صلاحية استخدامك لمحرك الدعم الذكي (SIE) لم تعد متاحة.';
        if (reason === 'انتهت الكوتة') why = 'استهلكت كل رسائل محرك الدعم الذكي (SIE) المتاحة لك.';
        else if (reason === 'انتهت الصلاحية') why = 'انتهت صلاحية استخدامك لمحرك الدعم الذكي (SIE).';
        else if (reason === 'غير مفعّل') why = 'تم إلغاء تفعيل محرك الدعم الذكي (SIE) لحسابك.';

        await supabase.from('chat_messages').insert({
            session_id: currentSessionId,
            sender_id: null,
            message_text: `${why} تم تحويلك تلقائيًا للوضع التقليدي. تقدر تختار وضعًا آخر من زر "وضع الشات بوت"، أو تتواصل مع الدعم لتفعيل SIE مرة أخرى.`,
            is_admin_reply: false,
            is_bot_reply: true
        });
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

            // SIE بقى ليه بوابتان لازم يعدّيهم الاتنين مع بعض (حسب القرار
            // النهائي: المفهومان يكملوا بعض مش بيتعارضوا):
            //   1) العميل نفسه لازم يكون *مختار* وضع "محرك الدعم الذكي" من
            //      قائمة اختيار وضع الشات بوت (profiles.chatbot_mode === 'sie')-
            //      تفضيل شخصي، بيتغيّر وقت ما العميل يحب.
            //   2) الإدارة لازم تكون *فعّلت* له الوصول فعليًا من جدول
            //      customer_sie_access - صلاحية إدارية منفصلة تمامًا.
            //
            // مهم: لو العميل مختار SIE (بوابة 1 مفتوحة) لكن الإدارة سحبت
            // صلاحيته (بوابة 2 اتقفلت) وهو *لسه في نص محادثة*، ممنوع نرجّعه
            // للمحرك التقليدي بصمت - هيفضل يكتب معتقد إنه لسه بيكلم SIE.
            // فبنعمل فحص قراءة (مش استهلاك كوتة) قبل استدعاء getSieReply
            // نفسها، وإذا لقيناه سحب، نوقف الرسالة دي، نبلّغه بوضوح، ونحفظ
            // تحويله للوضع التقليدي فورًا في قاعدة البيانات (مش محليًا بس).
            let reply;
            let options;

            if (cachedChatbotMode === CHATBOT_MODES.SIE) {
                const sieAccess = await getSieAccessInfo(currentUser.id);
                if (!sieAccess.available) {
                    await handleSieRevokedMidConversation(sieAccess);
                    if (typingIndicator) typingIndicator.style.display = 'none';
                    return;
                }
                const sieResult = await getSieReply({
                    text,
                    supabase,
                    sessionId: currentSessionId,
                    userId: currentUser.id,
                    botState: freshSession?.bot_state || {}
                });
                // لو الفحص قال متاح لكن getSieReply برضه رجّعت null (سباق نادر،
                // أو محرك SIE الخارجي مش متاح مؤقتًا/بطيء)، منرجعش صامت للتقليدي
                // كإجابة نهائية بردّ عادي - نبلّغ العميل إن في مشكلة مؤقتة، عشان
                // الفرق بين "بيرد عليك بوت تاني دلوقتي" و"حصل خطأ، جرّب تاني" يفضل واضح له.
                if (!sieResult) {
                    await supabase.from('chat_messages').insert({
                        session_id: currentSessionId,
                        sender_id: null,
                        message_text: 'محرك الدعم الذكي (SIE) واجه مشكلة مؤقتة في الرد على رسالتك. جرّب تبعتها تاني، أو اختار وضع تاني من زر "وضع الشات بوت".',
                        is_admin_reply: false,
                        is_bot_reply: true
                    });
                    if (typingIndicator) typingIndicator.style.display = 'none';
                    return;
                }
                // SIE بيكتب دور المحادثة بنفسه لما يقول alreadyPersisted:
                // رسالة البوت و bot_state والتذكرة لو اتفتحت، كلهم في
                // معاملة واحدة عنده - عشان أثر التشخيص والتذكرة ما
                // يفترقوش. لو كتبنا هنا كمان، العميل هيشوف نفس الرد
                // مرتين وكل دور هيتسجّل مكرر.
                //
                // مؤشر الكتابة بيتخفي في finally، فالـ return هنا آمن.
                if (sieResult.alreadyPersisted) {
                    renderQuickOptions(sieResult.options);
                    return;
                }

                // الشكل القديم: SIE بيرجّع بيانات بس والكتابة علينا.
                // متسيبش الفرع ده - أي رد من واجهة أقدم بيعدي من هنا.
                reply = sieResult.reply;
                options = sieResult.options;
                if (sieResult.botState !== undefined) {
                    await supabase.from('chat_sessions').update({ bot_state: sieResult.botState }).eq('id', currentSessionId);
                }
            } else {
                const botReply = await getBotReply({
                    text,
                    supabase,
                    sessionId: currentSessionId,
                    userId: currentUser.id,
                    botState: freshSession?.bot_state || {},
                    botSettings,
                    imageUrl
                });
                reply = botReply.reply;
                options = botReply.options;
            }

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

    // Start Init
    init();
});
