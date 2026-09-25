import { supabase } from '/api-config.js';
import { guardPage } from '/assets/js/page-guard.js';
import { openChatbotModeDialog } from '/assets/js/chatbot-mode-selector.js';
import { fetchEntitlement } from '/assets/js/sie-plan-service.js';
import { getSieReply } from '/assets/js/sie-client.js';
import { iconize } from '/assets/js/chat-icons.js';
import { signedUrls, SIGNED_URL_TTL, SIGNED_URL_TTL_DOWNLOAD } from '/storage-urls.js';
import {
    CHAT_ATTACHMENTS_BUCKET, FILE_PICKER_ACCEPT, validateFile, buildObjectPath, messageFieldsFor,
    attachmentFromMessage, renderAttachmentHtml, hydrateAttachments, downscaleImage, uploadAttachment,
    uploadErrorText, autoLabelFor
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
    // استحقاق SIE من الخادم (sie_my_entitlement) — للعرض فقط؛ الحدود نفسها
    // مفروضة على الخادم عند كل رسالة. null = لم يُحمَّل بعد.
    let entitlement = null;
    // هل الجلسة الحالية "دخول كعضو" (impersonation) من أدمن/super_user؟
    // بيتحدد بس على صفحة العميل (window.isCustomerChat)، زي ما هو موضّح فوق.
    let isImpersonated = false;

    // ===== INITIALIZATION =====
    async function init() {
        // صفحة شات العميل (chat-customer.html) لازم تحترم "الدخول كعضو"
        // (impersonation) عشان الأدمن/super_user يقدر يشوف الشات بحساب أي
        // عضو فتحه بـ ?impersonate=. صفحة الأدمن (chat-admin.html) لأ -
        // مفيش داعي ولا معنى لتبديل هوية الأدمن وهو بيدير شاتات العملاء.
        let user;
        if (window.isCustomerChat) {
            // الحساب الموقوف كان بيتحوّل لصفحة الدخول، والجلسة سليمة فبيترجع
            // فورًا — نفس حلقة التحويل. الحارس دلوقتي بيعرض السبب في مكانه.
            user = await guardPage('user');
            if (!user) return;
            isImpersonated = !!user.isImpersonated;
        } else {
            const { data: { user: authUser } } = await supabase.auth.getUser();
            if (!authUser) {
                window.location.href = '/login.html';
                return;
            }
            user = authUser;
        }

        currentUser = user;

        // لو الصفحة دي هي صفحة شات العميل المخصّصة (chat.html بتحدد الفلاج ده)،
        // نضمن إنها تتعامل كصفحة عميل دايمًا، حتى لو المستخدم دوره أدمن أو إيميله
        // فيه كلمة "admin" — عشان منستخدمش عناصر DOM بتاعة صفحة الأدمن
        // (زي messageInput) اللي مش موجودة في الصفحة دي أصلاً.
        if (window.isCustomerChat) {
            isAdmin = false;
        } else {
            // التحقق من الدور من البروفايل لضمان الدقة (لصفحة الأدمن فقط)
            const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle();
            const role = profile?.role || user.user_metadata?.role || 'customer';
            isAdmin = role === 'admin' || role === 'support' || user.email.includes('admin');
        }

        // إذا كان العميل (وليس أدمن)، قم بتحميل دردشة العميل بدلاً من دردشة الأدمن
        if (!isAdmin) {
            await loadBotSettings(); // رسالة الترحيب من bot_settings
            await loadCustomerChat();
            setupCustomerChatEventListeners();
            renderImpersonationBanner();
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

            // لو الجلسة جديدة وملهاش رسائل، نخلي البوت يبدأ بترحيب تلقائي.
            // خيارات SIE مرتبطة بالرد نفسه ولا تُحفظ، فلا تُعاد عند إعادة الفتح.
            if ((messages || []).length === 0) {
                await sendInitialGreeting();
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

    async function handleFilesSelected(files) {
        const file = files && files[0];
        if (!file || !currentUser || !currentSessionId) return;
        const first = validateFile(file);
        if (!first.ok) { setComposerStatus(first.error, 'error'); return; }

        const attachBtn = document.getElementById('chatAttachBtn');
        if (attachBtn) attachBtn.disabled = true;
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
            const fields = messageFieldsFor({ kind: check.kind, path, name: body.name || file.name, mime: check.mime, size: body.size });
            setComposerStatus('');
            const sent = await sendCustomerMessage(undefined, { fields });
            if (!sent) await cleanupUpload(path);
        } catch (err) {
            console.error('خطأ في رفع المرفق:', err);
            setComposerStatus(/[\u0600-\u06FF]/.test(err?.message || '') ? err.message : uploadErrorText(err), 'error');
            if (path) await cleanupUpload(path);
        } finally {
            if (attachBtn) attachBtn.disabled = false;
        }
    }

    // ملف رُفع ولم تُحفظ رسالته: يُحذف (سياسة الحذف تسمح فقط بغير المُشار إليه)
    async function cleanupUpload(path) {
        try { await supabase.storage.from(CHAT_ATTACHMENTS_BUCKET).remove([path]); }
        catch (err) { console.warn('تعذّر حذف مرفق لم يُرسل:', err?.message || err); }
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

        await supabase.from('chat_sessions').update({ bot_state: { greeted: true } }).eq('id', currentSessionId);

        await supabase.from('chat_messages').insert({
            session_id: currentSessionId,
            sender_id: null,
            message_text: greetingText,
            is_admin_reply: false,
            is_bot_reply: true
        });

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
    function appendCustomerMessage(msg) {
        const chatMessages = document.getElementById('chatMessages');
        if (!chatMessages) return;

        // التحقق من هوية المرسل
        const isOwn = currentUser && msg.sender_id === currentUser.id;
        const time = new Date(msg.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
        // المرفق (صورة/صوت/ملف) فوق النص. لا روابط هنا: المسار يخرج كسمة
        // بيانات ويُوقَّع بعد الإدراج (hydrateChatAttachments).
        injectAttachmentStyles();
        bindAttachmentClicks(chatMessages);
        const { attHtml, text } = messageParts(msg);

        const messageEl = document.createElement('div');
        messageEl.className = `msg ${isOwn ? 'sent' : 'received'}`;
        messageEl.innerHTML = `
            ${attHtml}
            ${text ? `<span>${iconize(escapeHtml(text))}</span>` : ''}
            <div style="font-size: 0.75rem; margin-top: 0.25rem; opacity: 0.7;">${time}</div>
        `;

        chatMessages.appendChild(messageEl);
        chatMessages.scrollTop = chatMessages.scrollHeight;
        hydrateChatAttachments(messageEl);
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
                await appendBotOnlyMessage(`تم تغيير خطة SIE إلى ${label}.`);
            }
        });
    }

    /**
     * SIE غير متاح لهذا العميل الآن (موقوف / منتهي / استهلك حده). لا بوت
     * بديل: رسالة واضحة بالسبب داخل المحادثة نفسها، والرسالة تبقى لفريق الدعم.
     */
    async function notifySieUnavailable(ent) {
        const why = ent?.reasonText || 'محرك الدعم الذكي (SIE) غير متاح لحسابك حاليًا.';
        await appendBotOnlyMessage(`${why} رسالتك وصلت لفريق الدعم وهيرد عليك هنا في أقرب وقت.`);
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
            if (typingIndicator) typingIndicator.style.display = 'block';

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
                await notifySieUnavailable(entitlement);
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
                    await notifySieUnavailable(ent);
                } else {
                    await appendBotOnlyMessage('محرك الدعم الذكي (SIE) واجه مشكلة مؤقتة في الرد على رسالتك. جرّب تبعتها تاني بعد شوية، ورسالتك وصلت لفريق الدعم.');
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

            // الشكل القديم: SIE بيرجّع بيانات بس والكتابة علينا.
            // متسيبش الفرع ده - أي رد من واجهة أقدم بيعدي من هنا.
            if (sieResult.botState !== undefined) {
                await supabase.from('chat_sessions').update({ bot_state: sieResult.botState }).eq('id', currentSessionId);
            }
            await supabase.from('chat_messages').insert({
                session_id: currentSessionId,
                sender_id: null,
                message_text: sieResult.reply,
                is_admin_reply: false,
                is_bot_reply: true
            });
            renderQuickOptions(sieResult.options);
            return true;
        } catch (err) {
            console.error('خطأ في الرد الآلي:', err);
            await appendBotOnlyMessage('عذراً، حدث خطأ أثناء معالجة رسالتك. رسالتك وصلت لفريق الدعم وهيرد عليك هنا.');
            return true;
        } finally {
            if (typingIndicator) typingIndicator.style.display = 'none';
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
                profiles:user_id (full_name, role),
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

    // الأدوار اللي لو بعتت من نفس حسابها كـ"عميل" بيبقى مهم يبان للفريق إنها
    // مش عميل عادي. الارتباط بشركة ليس منها: صاحب الشركة عميل دافع لا موظف.
    const STAFF_ROLES_AS_CUSTOMER = ['admin', 'support'];

    function isStaffOriginatedSession(session) {
        return STAFF_ROLES_AS_CUSTOMER.includes(session.profiles?.role);
    }

    function renderChatsList(sessions) {
        if (!chatsList) return;
        chatsList.innerHTML = '';

        if (!sessions || sessions.length === 0) {
            chatsList.innerHTML = '<div style="padding: 2rem 1rem; text-align: center; color: var(--text-light);">لا توجد محادثات حتى الآن</div>';
            return;
        }

        // نظهر محادثات الفريق (زي super_user بيستخدم حسابه كعميل) في الأعلى
        // دايمًا، عشان تلفت النظر فورًا ومتتوهش وسط باقي التذاكر العادية.
        // ملحوظة: ده ترتيب عرض في الواجهة فقط، ومش نظام توجيه/صلاحيات حقيقي -
        // أي موظف دعم لسه يقدر يفتح ويرد على أي محادثة، بما فيها دي، لأن
        // جدول chat_sessions معندوش عمود "المستلم المقصود" أصلاً في الباك إند.
        const sorted = [...sessions].sort((a, b) => {
            const aStaff = isStaffOriginatedSession(a) ? 1 : 0;
            const bStaff = isStaffOriginatedSession(b) ? 1 : 0;
            if (aStaff !== bStaff) return bStaff - aStaff;
            return new Date(b.updated_at) - new Date(a.updated_at);
        });

        sorted.forEach(session => {
            const messages = session.chat_messages || [];
            const lastMsg = messages.length ? messages[messages.length - 1] : null;
            const time = lastMsg ? new Date(lastMsg.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }) : '';
            const name = session.profiles?.full_name || 'عميل مجهول';
            const statusClass = session.status === 'closed' ? 'status-closed' : 'status-open';
            const statusLabel = session.status === 'closed' ? 'مغلقة' : 'نشطة';
            const staffBadge = isStaffOriginatedSession(session)
                ? `<span class="status-badge" style="background: rgba(224, 168, 0, 0.15); color: #9a6c00;" title="هذا الحساب دوره الأساسي إدارة/دعم، وبيستخدم الشات بوت هنا بصفته عميل">فريق العمل</span>`
                : '';

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
                            ${staffBadge}
                        </span>
                        <span class="chat-time">${time}</span>
                    </div>
                    <div class="chat-preview">${iconize(escapeHtml(lastMsg?.message_text || 'لا توجد رسائل'))}</div>
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

        // مرفق رسالة العميل (صورة/صوت/ملف) يظهر للأدمن في نفس الفقاعة.
        // لا روابط هنا: المسار يُوقَّع بعد الإدراج (hydrateChatAttachments) —
        // سياسة القراءة تسمح لفريق المنصة (is_platform_staff).
        injectAttachmentStyles();
        bindAttachmentClicks(messagesContainer);
        const { attHtml, text } = messageParts(msg);

        const group = document.createElement('div');
        group.className = `message-group ${isOwn ? 'sent' : 'received'}`;
        group.innerHTML = `
            <div class="message-bubble ${isOwn ? 'sent' : 'received'}">
                ${attHtml}
                ${text ? `<div>${iconize(escapeHtml(text))}</div>` : ''}
                <div class="message-time">${time}</div>
            </div>
        `;

        messagesContainer.appendChild(group);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
        hydrateChatAttachments(group);
    }

    function setupEventListeners() {
        // حماية إضافية: sendMessage (نسخة الأدمن) بتعتمد على messageInput.
        // لو العنصر ده مش موجود في الصفحة الحالية (زي صفحة شات العميل)، منربطش
        // الدالة دي أصلاً عشان منوصلش لخطأ "Cannot read properties of null".
        if (sendBtn && messageInput) sendBtn.onclick = sendMessage;
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
