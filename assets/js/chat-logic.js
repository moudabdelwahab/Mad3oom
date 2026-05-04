import { supabase } from '/api-config.js';

console.log("CHAT LOGIC VERSION 3.0 - WHATSAPP STYLE");

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
            // تحميل دردشة العميل
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
        // جلب أو إنشاء جلسة دردشة للعميل الحالي
        let { data: session, error } = await supabase
            .from('chat_sessions')
            .select('*')
            .eq('user_id', currentUser.id)
            .eq('status', 'open')
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        // إذا لم توجد جلسة مفتوحة، قم بإنشاء واحدة جديدة
        if (error || !session) {
            const { data: newSession, error: createError } = await supabase
                .from('chat_sessions')
                .insert({
                    user_id: currentUser.id,
                    status: 'open'
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
        }
    }

    // ===== APPEND CUSTOMER MESSAGE =====
    function appendCustomerMessage(msg) {
        const chatMessages = document.getElementById('chatMessages');
        if (!chatMessages) return;

        const isOwn = msg.sender_id === currentUser.id;
        const time = new Date(msg.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
        const text = msg.message_text || '';

        const messageEl = document.createElement('div');
        messageEl.className = `msg ${isOwn ? 'sent' : 'received'}`;
        messageEl.innerHTML = `
            <span>${text}</span>
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
            sendBtn.addEventListener('click', sendCustomerMessage);
        }

        if (chatInput) {
            chatInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    sendCustomerMessage();
                }
            });
        }

        if (endChatBtn) {
            endChatBtn.addEventListener('click', endCustomerChat);
        }
    }

    // ===== SEND CUSTOMER MESSAGE =====
    async function sendCustomerMessage() {
        const chatInput = document.getElementById('chatInput');
        const text = chatInput.value.trim();

        if (!text || !currentSessionId) return;

        chatInput.value = '';

        const { error } = await supabase.from('chat_messages').insert({
            session_id: currentSessionId,
            sender_id: currentUser.id,
            message_text: text,
            is_admin_reply: false
        });

        if (error) {
            console.error('خطأ في إرسال الرسالة:', error);
            alert('فشل في إرسال الرسالة');
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
        if (!error && data) {
            botSettings = data;
        }
    }

    // ===== LOAD ALL CHATS =====
    async function loadAllChats() {
        // Try to load with profiles first
        let { data: sessions, error } = await supabase
            .from('chat_sessions')
            .select('*, profiles(full_name, email), chat_messages(message_text, created_at, sender_id)')
            .order('updated_at', { ascending: false });

        // Fallback if profiles join fails
        if (error) {
            console.warn('Profiles join failed, falling back to basic load:', error);
            const { data: basicSessions, error: basicError } = await supabase
                .from('chat_sessions')
                .select('*, chat_messages(message_text, created_at, sender_id)')
                .order('updated_at', { ascending: false });
            
            if (basicError) {
                console.error('Error loading chats:', basicError);
                return;
            }
            sessions = basicSessions;
        }

        allSessions = sessions || [];
        renderChatsList(allSessions);
    }

    // ===== RENDER CHATS LIST =====
    function renderChatsList(sessions) {
        if (!sessions || sessions.length === 0) {
            chatsList.innerHTML = '<div style="padding: 2rem 1rem; text-align: center; color: var(--text-light);">لا توجد محادثات</div>';
            return;
        }

        chatsList.innerHTML = sessions.map(session => {
            const lastMsg = session.chat_messages?.[session.chat_messages.length - 1];
            const lastMsgText = lastMsg?.message_text?.substring(0, 50) || 'لا توجد رسائل';
            const lastMsgTime = lastMsg ? formatTime(new Date(lastMsg.created_at)) : '';
            
            const customerName = session.profiles?.full_name || `عميل ${session.id.substring(0, 4)}`;
            const initials = customerName.substring(0, 1).toUpperCase();
            
            const statusClass = session.status === 'closed' ? 'status-closed' : 'status-open';
            const statusText = session.status === 'closed' ? 'مغلقة' : 'مفتوحة';
            const statusColor = session.status === 'closed' ? '#FF3B30' : '#25D366';

            return `
                <div class="chat-item" onclick="selectChat('${session.id}')" data-id="${session.id}">
                    <div class="chat-avatar" style="position: relative;">
                        ${initials}
                        <span style="position: absolute; bottom: 0; right: 0; width: 14px; height: 14px; background: ${statusColor}; border-radius: 50%; border: 2px solid white;"></span>
                    </div>
                    <div class="chat-info">
                        <div class="chat-header-text">
                            <span class="chat-name">
                                ${customerName}
                                <span class="status-badge ${statusClass}">${statusText}</span>
                            </span>
                            <span class="chat-time">${lastMsgTime}</span>
                        </div>
                        <div class="chat-preview">${lastMsgText}</div>
                    </div>
                </div>
            `;
        }).join('');
    }

    // ===== SELECT CHAT =====
    window.selectChat = async (sessionId) => {
        currentSessionId = sessionId;
        currentSession = allSessions.find(s => s.id === sessionId);

        if (!currentSession) return;

        // Update UI
        document.querySelectorAll('.chat-item').forEach(item => item.classList.remove('active'));
        event.currentTarget?.classList.add('active');

        emptyState.style.display = 'none';
        chatHeader.style.display = 'flex';
        inputArea.style.display = 'flex';

        // Update header
        const customerName = currentSession.profiles?.full_name || `عميل ${sessionId.substring(0, 4)}`;
        document.getElementById('headerName').textContent = customerName;
        document.getElementById('headerStatus').textContent = currentSession.status === 'closed' ? 'مغلقة' : 'نشطة';
        document.getElementById('headerAvatar').textContent = customerName.substring(0, 1).toUpperCase();

        // Load messages
        await loadMessages(sessionId);

        // Subscribe to new messages
        if (messageChannel) supabase.removeChannel(messageChannel);
        messageChannel = supabase.channel(`chat:${sessionId}`)
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'chat_messages',
                filter: `session_id=eq.${sessionId}`
            }, payload => {
                appendMessage(payload.new);
            })
            .subscribe();
    };

    // ===== LOAD MESSAGES =====
    async function loadMessages(sessionId) {
        const { data: messages, error } = await supabase
            .from('chat_messages')
            .select('*')
            .eq('session_id', sessionId)
            .order('created_at', { ascending: true });

        if (error) {
            console.error('Error loading messages:', error);
            return;
        }

        messagesContainer.innerHTML = '';
        (messages || []).forEach(msg => appendMessage(msg));
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    // ===== APPEND MESSAGE =====
    function appendMessage(msg) {
        const isOwn = msg.sender_id === currentUser.id || msg.is_admin_reply;
        const time = formatTime(new Date(msg.created_at));
        const text = msg.content || msg.message_text || '';
        const imageUrl = msg.image_url;
        const audioUrl = msg.audio_url;

        const messageGroup = document.createElement('div');
        messageGroup.className = `message-group ${isOwn ? 'sent' : 'received'}`;
        
        let contentHtml = '';
        if (imageUrl) {
            contentHtml = `<img src="${imageUrl}" style="max-width: 100%; border-radius: 8px; cursor: pointer;" onclick="window.open('${imageUrl}')">`;
        } else if (audioUrl) {
            contentHtml = `<audio controls src="${audioUrl}" style="max-width: 100%;"></audio>`;
        } else {
            contentHtml = escapeHtml(text);
        }

        messageGroup.innerHTML = `
            <div>
                <div class="message-bubble ${isOwn ? 'sent' : 'received'}">
                    ${contentHtml}
                </div>
                <div class="message-time">${time}</div>
            </div>
        `;

        messagesContainer.appendChild(messageGroup);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    // ===== SEND MESSAGE =====
    async function sendMessage() {
        const text = messageInput.value.trim();
        if (!text || !currentSessionId) return;

        messageInput.value = '';

        const { error } = await supabase.from('chat_messages').insert({
            session_id: currentSessionId,
            sender_id: currentUser.id,
            message_text: text,
            is_admin_reply: true
        });

        if (error) {
            console.error('Error sending message:', error);
            alert('خطأ في إرسال الرسالة');
        }
    }

    // ===== SETUP EVENT LISTENERS =====
    function setupEventListeners() {
        // Send message
        sendBtn.addEventListener('click', sendMessage);
        messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        // Close chat
        closeChat.addEventListener('click', () => {
            currentSessionId = null;
            emptyState.style.display = 'flex';
            chatHeader.style.display = 'none';
            inputArea.style.display = 'none';
            messagesContainer.innerHTML = '';
            document.querySelectorAll('.chat-item').forEach(item => item.classList.remove('active'));
        });

        // Search
        searchInput.addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase();
            const filtered = allSessions.filter(session => {
                const lastMsg = session.chat_messages?.[session.chat_messages.length - 1];
                return session.id.includes(query) || lastMsg?.message_text?.toLowerCase().includes(query);
            });
            renderChatsList(filtered);
        });

        // Settings modal
        settingsBtn.addEventListener('click', () => {
            document.getElementById('welcomeMsg').value = botSettings?.welcome_message || '';
            document.getElementById('responseDelay').value = botSettings?.response_delay_seconds || 1;
            settingsModal.style.display = 'flex';
        });

        closeSettingsModal.addEventListener('click', () => {
            settingsModal.style.display = 'none';
        });

        cancelSettings.addEventListener('click', () => {
            settingsModal.style.display = 'none';
        });

        saveSettings.addEventListener('click', async () => {
            const welcomeMsg = document.getElementById('welcomeMsg').value;
            const responseDelay = parseInt(document.getElementById('responseDelay').value);

            const { error } = await supabase.from('bot_settings').update({
                welcome_message: welcomeMsg,
                response_delay_seconds: responseDelay
            }).eq('id', botSettings.id);

            if (!error) {
                alert('تم حفظ الإعدادات بنجاح!');
                settingsModal.style.display = 'none';
                await loadBotSettings();
            }
        });

        // Export modal
        const newChatBtn = document.getElementById('newChatBtn');
        newChatBtn.addEventListener('click', () => {
            exportModal.style.display = 'flex';
        });

        closeExportModal.addEventListener('click', () => {
            exportModal.style.display = 'none';
        });

        cancelExport.addEventListener('click', () => {
            exportModal.style.display = 'none';
        });

        // Export Excel (All Chats)
        exportExcel.addEventListener('click', async () => {
            const { data: sessions } = await supabase
                .from('chat_sessions')
                .select('*, profiles(full_name), chat_messages(message_text, created_at)')
                .order('updated_at', { ascending: false });

            if (!sessions || sessions.length === 0) {
                alert('لا توجد محادثات للتصدير');
                return;
            }

            let csvContent = '\uFEFF'; // UTF-8 BOM for Excel Arabic support
            csvContent += 'اسم العميل,معرف الجلسة,الحالة,تاريخ الإنشاء,عدد الرسائل\n';
            
            sessions.forEach(session => {
                const customerName = session.profiles?.full_name || 'عميل غير معروف';
                const createdAt = new Date(session.created_at).toLocaleString('ar-SA');
                const messageCount = session.chat_messages?.length || 0;
                const status = session.status === 'closed' ? 'مغلقة' : 'مفتوحة';
                csvContent += `"${customerName}","${session.id}","${status}","${createdAt}",${messageCount}\n`;
            });

            downloadFile(csvContent, `محادثات_مدعوم_${new Date().toLocaleDateString('ar-SA')}.csv`, 'text/csv');
            exportModal.style.display = 'none';
        });

        // Export PDF (All Chats - Basic implementation using window.print or simple layout)
        exportPDF.addEventListener('click', () => {
            alert('سيتم فتح نافذة الطباعة لحفظ المحادثات كـ PDF');
            window.print();
            exportModal.style.display = 'none';
        });

        // Single Chat Export
        exportSingleChatBtn.addEventListener('click', () => {
            if (!currentSessionId) return;
            exportSingleModal.style.display = 'flex';
        });

        closeExportSingleModal.addEventListener('click', () => exportSingleModal.style.display = 'none');
        cancelExportSingle.addEventListener('click', () => exportSingleModal.style.display = 'none');

        exportSingleExcel.addEventListener('click', async () => {
            const { data: messages } = await supabase
                .from('chat_messages')
                .select('*')
                .eq('session_id', currentSessionId)
                .order('created_at', { ascending: true });

            if (!messages || messages.length === 0) {
                alert('لا توجد رسائل لتصديرها');
                return;
            }

            let csvContent = '\uFEFF'; // UTF-8 BOM
            csvContent += 'المرسل,الرسالة,التوقيت\n';
            
            messages.forEach(msg => {
                const sender = msg.is_admin_reply ? 'الأدمن' : 'العميل';
                const time = new Date(msg.created_at).toLocaleString('ar-SA');
                const text = (msg.message_text || '').replace(/"/g, '""');
                csvContent += `"${sender}","${text}","${time}"\n`;
            });

            const customerName = currentSession.profiles?.full_name || 'عميل';
            downloadFile(csvContent, `محادثة_${customerName}_${new Date().toLocaleDateString('ar-SA')}.csv`, 'text/csv');
            exportSingleModal.style.display = 'none';
        });

        exportSinglePDF.addEventListener('click', () => {
            const customerName = currentSession.profiles?.full_name || 'عميل';
            const printWindow = window.open('', '_blank');
            const messagesHtml = messagesContainer.innerHTML;
            
            printWindow.document.write(`
                <html dir="rtl">
                <head>
                    <title>محادثة ${customerName}</title>
                    <style>
                        body { font-family: 'Cairo', sans-serif; padding: 20px; }
                        .message-group { margin-bottom: 15px; display: flex; flex-direction: column; }
                        .sent { align-items: flex-start; }
                        .received { align-items: flex-end; }
                        .message-bubble { padding: 10px; border-radius: 8px; max-width: 80%; }
                        .sent .message-bubble { background: #e5e5ea; }
                        .received .message-bubble { background: #003366; color: white; }
                        .message-time { font-size: 0.8rem; color: #666; margin-top: 5px; }
                    </style>
                </head>
                <body>
                    <h1>محادثة العميل: ${customerName}</h1>
                    <hr>
                    ${messagesHtml}
                    <script>setTimeout(() => { window.print(); window.close(); }, 500);</script>
                </body>
                </html>
            `);
            printWindow.document.close();
            exportSingleModal.style.display = 'none';
        });

        // Image Upload
        imageUploadBtn.addEventListener('click', () => imageInput.click());
        
        imageInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file || !currentSessionId) {
                alert('اختر صورة أولاً');
                return;
            }

            // Validate file type
            if (!file.type.startsWith('image/')) {
                alert('يجب اختيار صورة فقط');
                return;
            }

            // Show loading state
            imageUploadBtn.disabled = true;
            imageUploadBtn.style.opacity = '0.5';

            try {
                const fileExt = file.name.split('.').pop();
                const fileName = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}.${fileExt}`;
                const filePath = `chat-media/${fileName}`;

                const { data, error } = await supabase.storage
                    .from('chat-attachments')
                    .upload(filePath, file, {
                        cacheControl: '3600',
                        upsert: false
                    });

                if (error) {
                    console.error('خطأ في رفع الصورة:', error);
                    alert('فشل في تحميل الصورة. تأكد من اتصال الإنترنت');
                    return;
                }

                const { data: { publicUrl } } = supabase.storage
                    .from('chat-attachments')
                    .getPublicUrl(filePath);

                const { error: insertError } = await supabase.from('chat_messages').insert({
                    session_id: currentSessionId,
                    sender_id: currentUser.id,
                    image_url: publicUrl,
                    message_text: null,
                    is_admin_reply: true
                });

                if (insertError) {
                    console.error('خطأ في حفظ الرسالة:', insertError);
                    alert('فشل في إرسال الصورة');
                }
            } catch (err) {
                console.error('خطأ غير متوقع:', err);
                alert('حدث خطأ غير متوقع');
            } finally {
                imageUploadBtn.disabled = false;
                imageUploadBtn.style.opacity = '1';
                imageInput.value = '';
            }
        });

        // Voice Recording with Timer
        let recordingStartTime = null;
        let recordingTimer = null;
        const voiceRecordBtnSvg = voiceRecordBtn.innerHTML;
        
        voiceRecordBtn.addEventListener('click', async () => {
            if (mediaRecorder && mediaRecorder.state === 'recording') {
                mediaRecorder.stop();
                voiceRecordBtn.style.color = 'var(--primary-color)';
                voiceRecordBtn.classList.remove('recording-pulse');
                voiceRecordBtn.innerHTML = voiceRecordBtnSvg;
                
                if (recordingTimer) clearInterval(recordingTimer);
                return;
            }

            if (!currentSessionId) {
                alert('اختر محادثة أولاً');
                return;
            }

            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                mediaRecorder = new MediaRecorder(stream);
                audioChunks = [];

                mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
                mediaRecorder.onstop = async () => {
                    voiceRecordBtn.disabled = true;
                    voiceRecordBtn.style.opacity = '0.5';
                    
                    try {
                        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                        const fileName = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}.webm`;
                        const filePath = `chat-media/${fileName}`;

                        const { data, error } = await supabase.storage
                            .from('chat-attachments')
                            .upload(filePath, audioBlob, {
                                cacheControl: '3600',
                                upsert: false
                            });

                        if (error) {
                            console.error('خطأ في رفع الصوت:', error);
                            alert('فشل في تحميل التسجيل الصوتي');
                            return;
                        }

                        const { data: { publicUrl } } = supabase.storage
                            .from('chat-attachments')
                            .getPublicUrl(filePath);

                        const { error: insertError } = await supabase.from('chat_messages').insert({
                            session_id: currentSessionId,
                            sender_id: currentUser.id,
                            audio_url: publicUrl,
                            message_text: null,
                            is_admin_reply: true
                        });

                        if (insertError) {
                            console.error('خطأ في حفظ الرسالة:', insertError);
                            alert('فشل في إرسال التسجيل الصوتي');
                        }
                    } finally {
                        voiceRecordBtn.disabled = false;
                        voiceRecordBtn.style.opacity = '1';
                    }
                };

                mediaRecorder.start();
                recordingStartTime = Date.now();
                voiceRecordBtn.style.color = '#FF3B30';
                voiceRecordBtn.classList.add('recording-pulse');
                
                // Start timer
                recordingTimer = setInterval(() => {
                    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
                    const minutes = Math.floor(elapsed / 60);
                    const seconds = elapsed % 60;
                    voiceRecordBtn.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
                    voiceRecordBtn.style.fontSize = '0.7rem';
                    voiceRecordBtn.style.fontWeight = 'bold';
                }, 100);
            } catch (err) {
                console.error('خطأ في الوصول للميكروفون:', err);
                alert('لا يمكن الوصول للميكروفون. تأكد من منح الصلاحيات');
            }
        });

        // Search in Chat
        searchInChatBtn.addEventListener('click', () => {
            searchChatBar.style.display = 'flex';
            searchChatInput.focus();
        });

        closeSearchChat.addEventListener('click', () => {
            searchChatBar.style.display = 'none';
            searchChatInput.value = '';
            // Reset highlight
            loadMessages(currentSessionId);
        });

        searchChatInput.addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase();
            const bubbles = messagesContainer.querySelectorAll('.message-bubble');
            
            bubbles.forEach(bubble => {
                const text = bubble.textContent.toLowerCase();
                if (query && text.includes(query)) {
                    bubble.style.backgroundColor = '#fff3cd';
                    bubble.style.border = '2px solid #ffc107';
                } else {
                    // Reset to original style
                    const isSent = bubble.classList.contains('sent');
                    bubble.style.backgroundColor = isSent ? 'var(--chat-bubble-user)' : 'var(--chat-bubble-other)';
                    bubble.style.border = 'none';
                }
            });
        });

        // Close modal on outside click
        document.addEventListener('click', (e) => {
            if (e.target === settingsModal) settingsModal.style.display = 'none';
            if (e.target === exportModal) exportModal.style.display = 'none';
            if (e.target === exportSingleModal) exportSingleModal.style.display = 'none';
        });
    }

    // ===== UTILITY FUNCTIONS =====
    function formatTime(date) {
        const now = new Date();
        const diff = now - date;
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);

        if (minutes < 1) return 'الآن';
        if (minutes < 60) return `${minutes}د`;
        if (hours < 24) return `${hours}س`;
        if (days < 7) return `${days}ي`;
        
        return date.toLocaleDateString('ar-SA');
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function downloadFile(content, filename, type) {
        const blob = new Blob([content], { type: `${type};charset=utf-8;` });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', filename);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    // Initialize
    await init();
});
