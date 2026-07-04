/**
 * ويدجت الدردشة المباشرة - Client Side (v2 - موحّد مع chat-customer)
 * ------------------------------------------------------------
 * التغييرات الأساسية في النسخة دي مقارنة بالنسخة القديمة:
 *
 * 1) اتشالت "الأسئلة المقترحة" (suggestedQuestions) بالكامل، وكذلك خطوة
 *    "questions" اللي كانت بتعرضها.
 * 2) اتشال الاعتماد الكامل على "chatService" الوهمي (محادثة/تقييم/انضمام
 *    موظف دعم كله كان simulation محلي من غير أي backend حقيقي).
 * 3) الويدجت بقى شغال بنفس الـ backend والمنطق بالظبط اللي شغالة بيه صفحة
 *    الدردشة في لوحة تحكم العميل (chat.html + chat-logic.js):
 *      - نفس جداول Supabase (chat_sessions / chat_messages)
 *      - نفس محرك الرد الآلي المحلي (chatbot-engine.js) بكل خطواته
 *        (القائمة الرئيسية، فتح تذكرة مشكلة بخطواتها الأربعة، فتح تذكرة
 *        استفسار، الأسئلة الشائعة عن الاشتراك/الأسعار...)
 *      - نفس آلية رفع صورة المشكلة الاختيارية (bucket "tickets")
 *      - نفس منطق "الوضع اليدوي" (is_manual_mode) لما موظف الدعم يرد بنفسه
 *
 * ⚠️ ملحوظة مهمة: الـ RLS على chat_sessions/chat_messages بيسمح بس للمستخدم
 * المسجل دخول (auth.uid()) يشوف وينشئ جلسة/رسائل خاصة بيه. يعني الويدجت ده
 * دلوقتي بيتطلب تسجيل دخول قبل ما يبدأ محادثة حقيقية (بالظبط زي صفحة لوحة
 * التحكم). فيه عمود "guest_id" موجود في جدول chat_sessions مش مستخدم حاليًا،
 * يظهر إنه كان معمول لدعم زوار مش مسجلين لاحقًا - لو حابب تفعّل ده، قولّي
 * عشان نضيف policy مخصوص للزوار ونربطه هنا.
 * ------------------------------------------------------------
 */

import { supabase } from '/api-config.js';
import { getBotReply, MAIN_MENU_OPTIONS, getOptionsForFlow } from '/assets/js/chatbot-engine.js';

class ChatWidget {
  constructor() {
    this.currentSessionId = null;
    this.currentUser = null;
    this.botSettings = null;
    this.messages = []; // يشمل الرسائل العادية وأحداث النظام (system events)
    this.quickOptions = null; // الأزرار المعروضة حاليًا تحت آخر رسالة بوت
    this.messageChannel = null; // اشتراك realtime في رسائل الجلسة
    this.sessionChannel = null; // اشتراك realtime في تغييرات الجلسة (انضمام أدمن)
    this.currentStep = 'closed'; // closed, loading, login-required, chat, rating
    this.isMinimized = false;
    this.isMaximized = false;
    this.notificationsEnabled = this.getNotificationsPref();
    this.isSettingsOpen = false;
    this.adminJoined = false;
    this.init();
  }

  /* ==================== تهيئة عامة ==================== */

  getNotificationsPref() {
    const stored = localStorage.getItem('chat_notifications_enabled');
    return stored === null ? true : stored === 'true';
  }

  setNotificationsPref(value) {
    this.notificationsEnabled = value;
    localStorage.setItem('chat_notifications_enabled', String(value));
  }

  init() {
    this.createWidgetHTML();
    this.attachEventListeners();
  }

  /* ==================== أدوات مساعدة ==================== */

  /**
   * ينشئ تدرج لوني (gradient) ثابت بناءً على نص (اسم/معرف) — نفس الجهة
   * تحصل دائماً على نفس الألوان.
   */
  getAvatarGradient(seed) {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = seed.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue1 = Math.abs(hash) % 360;
    const hue2 = (hue1 + 60) % 360;
    return `linear-gradient(135deg, hsl(${hue1}, 70%, 55%), hsl(${hue2}, 70%, 55%))`;
  }

  formatEventTimestamp(date) {
    const d = new Date(date);
    const datePart = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const timePart = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    return `${datePart}, ${timePart}`;
  }

  escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(text || '').replace(/[&<>"']/g, m => map[m]);
  }

  sanitizeUrl(url) {
    if (!url) return '';
    const trimmed = String(url).trim();
    if (/^(https?:)?\/\//i.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('./')) {
      return this.escapeHtml(trimmed);
    }
    return '';
  }

  /* ==================== بناء الواجهة ==================== */

  createWidgetHTML() {
    if (document.getElementById('chatBubbleBtn')) {
      console.log('[ChatWidget] Widget already exists, skipping creation');
      return;
    }

    const widgetHTML = `
      <div class="floating-chat-widget" id="floatingChatWidget">
        <button class="chat-bubble-btn" id="chatBubbleBtn" title="فتح الدردشة">
          <div class="chat-bubble-icon">
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
            </svg>
          </div>
        </button>

        <div class="chat-widget-panel" id="chatWidgetPanel">
          <!-- Header -->
          <div class="chat-widget-header">
            <div class="chat-widget-header-title">
              <div class="chat-widget-header-icon">
                <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                </svg>
              </div>
              <div>
                <h3>الدردشة المباشرة</h3>
                <p id="headerStatus">كيف يمكننا مساعدتك؟</p>
              </div>
            </div>
            <div class="chat-widget-header-actions">
              <button class="chat-header-icon-btn" id="chatSettingsBtn" title="الإعدادات">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"></path></svg>
              </button>
              <button class="chat-header-icon-btn" id="chatMinimizeBtn" title="تصغير">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"></line></svg>
              </button>
              <button class="chat-header-icon-btn chat-widget-close" id="chatWidgetClose" title="إغلاق">×</button>
            </div>
          </div>

          <!-- Settings dropdown -->
          <div class="chat-settings-panel" id="chatSettingsPanel">
            <div class="chat-settings-item" id="contactDetailsItem">
              <div class="chat-settings-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
              </div>
              <span class="chat-settings-label">حسابك</span>
              <a href="#" class="chat-settings-action" id="chatLoginLink">
                تسجيل الدخول
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
              </a>
            </div>
            <div class="chat-settings-item chat-settings-item-clickable" id="downloadTranscriptItem">
              <div class="chat-settings-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
              </div>
              <span class="chat-settings-label">تحميل نص المحادثة</span>
            </div>
            <div class="chat-settings-item chat-settings-item-clickable" id="maximizeItem">
              <div class="chat-settings-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"></path></svg>
              </div>
              <span class="chat-settings-label" id="maximizeLabel">تكبير النافذة</span>
            </div>
            <div class="chat-settings-item">
              <div class="chat-settings-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 01-3.46 0"></path></svg>
              </div>
              <span class="chat-settings-label">الإشعارات</span>
              <label class="chat-toggle-switch">
                <input type="checkbox" id="notificationsToggle" ${this.notificationsEnabled ? 'checked' : ''}>
                <span class="chat-toggle-slider"></span>
              </label>
            </div>
          </div>

          <!-- Body -->
          <div class="chat-widget-body" id="chatWidgetBody"></div>

          <!-- Footer -->
          <div class="chat-widget-footer" id="chatWidgetFooter"></div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', widgetHTML);
  }

  attachEventListeners() {
    const bubbleBtn = document.getElementById('chatBubbleBtn');
    const closeBtn = document.getElementById('chatWidgetClose');
    const minimizeBtn = document.getElementById('chatMinimizeBtn');
    const settingsBtn = document.getElementById('chatSettingsBtn');
    const downloadItem = document.getElementById('downloadTranscriptItem');
    const maximizeItem = document.getElementById('maximizeItem');
    const notifToggle = document.getElementById('notificationsToggle');
    const loginLink = document.getElementById('chatLoginLink');

    if (!bubbleBtn || !closeBtn) {
      console.error('[ChatWidget] Failed to find chat elements');
      return;
    }

    bubbleBtn.addEventListener('click', () => this.openWidget());
    closeBtn.addEventListener('click', () => this.closeWidget());
    minimizeBtn.addEventListener('click', () => this.toggleMinimize());
    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleSettingsPanel();
    });
    downloadItem.addEventListener('click', () => this.downloadTranscript());
    maximizeItem.addEventListener('click', () => this.toggleMaximize());
    notifToggle.addEventListener('change', (e) => this.setNotificationsPref(e.target.checked));
    loginLink.addEventListener('click', (e) => {
      e.preventDefault();
      window.location.href = '/login.html';
    });

    // إغلاق قائمة الإعدادات عند الضغط خارجها
    document.addEventListener('click', (e) => {
      const panel = document.getElementById('chatSettingsPanel');
      const settingsButton = document.getElementById('chatSettingsBtn');
      if (this.isSettingsOpen && panel && !panel.contains(e.target) && e.target !== settingsButton) {
        this.toggleSettingsPanel(false);
      }
    });
  }

  /* ==================== فتح / إغلاق / تصغير / تكبير ==================== */

  openWidget() {
    const panel = document.getElementById('chatWidgetPanel');
    if (!panel) return;
    panel.classList.add('active');
    this.isMinimized = false;
    panel.classList.remove('minimized');

    if (this.currentStep === 'closed') {
      this.startRealChat();
    } else {
      this.renderStep();
    }
  }

  closeWidget() {
    const panel = document.getElementById('chatWidgetPanel');
    if (!panel) return;

    panel.classList.remove('active');
    this.toggleSettingsPanel(false);

    if (this.messageChannel) { supabase.removeChannel(this.messageChannel); this.messageChannel = null; }
    if (this.sessionChannel) { supabase.removeChannel(this.sessionChannel); this.sessionChannel = null; }

    this.currentStep = 'closed';
    this.currentSessionId = null;
    this.messages = [];
    this.quickOptions = null;
    this.adminJoined = false;
  }

  toggleMinimize() {
    const panel = document.getElementById('chatWidgetPanel');
    if (!panel) return;
    this.isMinimized = !this.isMinimized;
    panel.classList.toggle('minimized', this.isMinimized);
    if (this.isMinimized) this.toggleSettingsPanel(false);
  }

  toggleMaximize() {
    const panel = document.getElementById('chatWidgetPanel');
    const label = document.getElementById('maximizeLabel');
    if (!panel) return;
    this.isMaximized = !this.isMaximized;
    panel.classList.toggle('maximized', this.isMaximized);
    if (label) label.textContent = this.isMaximized ? 'استعادة الحجم' : 'تكبير النافذة';
  }

  toggleSettingsPanel(force) {
    const panel = document.getElementById('chatSettingsPanel');
    if (!panel) return;
    this.isSettingsOpen = force !== undefined ? force : !this.isSettingsOpen;
    panel.classList.toggle('active', this.isSettingsOpen);
  }

  /* ==================== تحميل نص المحادثة ==================== */

  downloadTranscript() {
    const lines = this.messages.map(item => {
      const time = this.formatEventTimestamp(item.createdAt || new Date());
      if (item.isSystemEvent) {
        return `[${time}] * ${item.content}`;
      }
      const who = item.senderType === 'customer' ? 'أنت' : 'الدعم الفني';
      return `[${time}] ${who}: ${item.content}`;
    });

    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chat-transcript-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    this.toggleSettingsPanel(false);
  }

  /* ==================== رسم الخطوات ==================== */

  renderStep() {
    const body = document.getElementById('chatWidgetBody');
    const footer = document.getElementById('chatWidgetFooter');

    body.innerHTML = '';
    footer.innerHTML = '';

    switch (this.currentStep) {
      case 'loading':
        this.renderLoadingStep();
        break;
      case 'login-required':
        this.renderLoginRequiredStep();
        break;
      case 'chat':
        this.renderChatStep();
        break;
      case 'rating':
        this.renderRatingStep();
        break;
    }
  }

  renderLoadingStep() {
    const body = document.getElementById('chatWidgetBody');
    const header = document.getElementById('headerStatus');
    header.textContent = 'جاري التحميل...';
    body.innerHTML = '<div style="text-align:center; padding:2rem 0; color: var(--chat-text-secondary);">جاري تجهيز المحادثة...</div>';
  }

  renderLoginRequiredStep() {
    const body = document.getElementById('chatWidgetBody');
    const header = document.getElementById('headerStatus');
    header.textContent = 'محتاج تسجيل دخول';

    body.innerHTML = `
      <div style="text-align: center; padding: 2rem 1rem; color: var(--chat-text-secondary);">
        <p style="margin-bottom: 1rem;">لازم تسجل دخول الأول عشان تقدر تبدأ محادثة مع فريق الدعم.</p>
      </div>
    `;

    const loginBtn = document.createElement('button');
    loginBtn.textContent = 'تسجيل الدخول';
    loginBtn.className = 'chat-widget-option';
    loginBtn.style.width = '100%';
    loginBtn.addEventListener('click', () => { window.location.href = '/login.html'; });
    body.appendChild(loginBtn);
  }

  /* ==================== بدء محادثة حقيقية (Supabase + محرك البوت) ==================== */

  async startRealChat() {
    this.currentStep = 'loading';
    this.renderStep();

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      this.currentStep = 'login-required';
      this.renderStep();
      return;
    }
    this.currentUser = user;

    await this.loadBotSettings();
    await this.loadOrCreateSession();
    this.subscribeRealtime();

    this.currentStep = 'chat';
    this.renderStep();
  }

  async loadBotSettings() {
    const { data, error } = await supabase.from('bot_settings').select('*').single();
    if (error) {
      console.error('[ChatWidget] Error loading bot settings:', error);
      this.botSettings = {};
      return;
    }
    this.botSettings = data;
  }

  mapDbMessage(row) {
    return {
      id: row.id,
      senderType: this.currentUser && row.sender_id === this.currentUser.id ? 'customer' : 'admin',
      content: row.message_text || '',
      imageUrl: row.image_url || null,
      createdAt: row.created_at
    };
  }

  async loadOrCreateSession() {
    let { data: session, error } = await supabase
      .from('chat_sessions')
      .select('*')
      .eq('user_id', this.currentUser.id)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !session) {
      const { data: newSession, error: createError } = await supabase
        .from('chat_sessions')
        .insert({ user_id: this.currentUser.id, status: 'active' })
        .select()
        .single();

      if (createError) {
        console.error('[ChatWidget] Error creating session:', createError);
        return;
      }
      session = newSession;
    }

    this.currentSessionId = session.id;
    this.adminJoined = !!session.is_manual_mode;

    const { data: rows, error: msgError } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('session_id', session.id)
      .order('created_at', { ascending: true });

    if (msgError) {
      console.error('[ChatWidget] Error loading messages:', msgError);
      this.messages = [];
    } else {
      this.messages = (rows || []).map(r => this.mapDbMessage(r));
    }

    if (!rows || rows.length === 0) {
      await this.sendInitialGreeting();
    } else if (!session.is_manual_mode) {
      this.quickOptions = getOptionsForFlow(session.bot_state?.flow);
    }
  }

  /**
   * اشتراك realtime في: (1) رسائل الجلسة الجديدة، (2) تغييرات على الجلسة نفسها
   * (بالذات is_manual_mode) عشان نعرض حدث "انضم موظف الدعم" فعليًا لما حد من
   * لوحة التحكم يرد يدوي على المحادثة، مش simulation وهمي زي الأول.
   */
  subscribeRealtime() {
    if (this.messageChannel) supabase.removeChannel(this.messageChannel);
    if (this.sessionChannel) supabase.removeChannel(this.sessionChannel);

    this.messageChannel = supabase
      .channel(`widget-chat:${this.currentSessionId}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'chat_messages',
        filter: `session_id=eq.${this.currentSessionId}`
      }, payload => {
        this.messages.push(this.mapDbMessage(payload.new));
        if (this.currentStep === 'chat') this.renderStep();
      })
      .subscribe();

    this.sessionChannel = supabase
      .channel(`widget-session:${this.currentSessionId}`)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'chat_sessions',
        filter: `id=eq.${this.currentSessionId}`
      }, payload => {
        const wasManual = this.adminJoined;
        const isManual = !!payload.new.is_manual_mode;
        if (isManual && !wasManual) {
          this.adminJoined = true;
          this.addSystemEvent('فريق الدعم انضم إلى المحادثة', 'admin');
          const header = document.getElementById('headerStatus');
          if (header) header.textContent = 'فريق الدعم متصل الآن';
        } else if (!isManual && wasManual) {
          this.adminJoined = false;
          this.addSystemEvent('فريق الدعم غادر المحادثة', 'admin');
        }
      })
      .subscribe();
  }

  async sendInitialGreeting() {
    if (!this.currentSessionId) return;
    const welcome = this.botSettings?.welcome_message || 'أهلاً بيك في منصة مدعوم! 👋';
    const greetingText = `${welcome}\nاختار من الاختيارات دي 👇 أو اكتبلي طلبك بحريتك:`;

    await supabase.from('chat_sessions').update({ bot_state: { greeted: true, flow: 'main_menu' } }).eq('id', this.currentSessionId);
    await supabase.from('chat_messages').insert({
      session_id: this.currentSessionId,
      sender_id: null,
      message_text: greetingText,
      is_admin_reply: false,
      is_bot_reply: true
    });

    // بنعرضها يدويًا فورًا لأن اشتراك الـ realtime لسه مبيتفعّلش إلا بعد الرجوع
    // من startRealChat، فمكانش هيلقط أول رسالة ترحيب.
    this.messages.push({ id: `local_${Date.now()}`, senderType: 'admin', content: greetingText, createdAt: new Date().toISOString() });
    this.quickOptions = MAIN_MENU_OPTIONS;
  }

  addSystemEvent(text, avatarSeed) {
    this.messages.push({
      id: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      isSystemEvent: true,
      content: text,
      avatarSeed: avatarSeed || 'system',
      createdAt: new Date()
    });
    if (this.currentStep === 'chat') this.renderStep();
  }

  /* ==================== خطوة المحادثة ==================== */

  renderChatStep() {
    const body = document.getElementById('chatWidgetBody');
    const footer = document.getElementById('chatWidgetFooter');
    const header = document.getElementById('headerStatus');

    if (!this.adminJoined) header.textContent = 'المحادثة';

    this.messages.forEach(item => {
      if (item.isSystemEvent) {
        body.appendChild(this.buildSystemEventElement(item));
      } else {
        const messageDiv = document.createElement('div');
        messageDiv.className = `chat-widget-message ${item.senderType === 'admin' ? 'bot' : 'user'}`;
        const safeImageUrl = this.sanitizeUrl(item.imageUrl);
        const imageHtml = safeImageUrl
          ? `<a href="${safeImageUrl}" target="_blank" rel="noopener"><img src="${safeImageUrl}" alt="صورة مرفقة" style="max-width:180px;border-radius:0.5rem;display:block;margin-bottom:0.35rem;"></a>`
          : '';
        messageDiv.innerHTML = `<div class="chat-widget-bubble">${imageHtml}${this.escapeHtml(item.content)}</div>`;
        body.appendChild(messageDiv);
      }
    });

    // أزرار الاختيارات السريعة (لو موجودة) تحت آخر رسالة
    if (this.quickOptions && this.quickOptions.length > 0) {
      const optionsWrap = document.createElement('div');
      optionsWrap.className = 'chat-widget-quick-options';
      optionsWrap.style.display = 'flex';
      optionsWrap.style.flexWrap = 'wrap';
      optionsWrap.style.gap = '0.5rem';
      optionsWrap.style.margin = '0.5rem 0';

      this.quickOptions.forEach(opt => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chat-widget-option';
        btn.style.flex = '0 1 auto';
        btn.textContent = opt.label;
        btn.addEventListener('click', () => {
          if (opt.value === '__attach_image__') {
            this.triggerImageUpload();
            return;
          }
          optionsWrap.querySelectorAll('button').forEach(b => b.disabled = true);
          this.sendMessage(opt.value);
        });
        optionsWrap.appendChild(btn);
      });

      body.appendChild(optionsWrap);
    }

    // شريط الإدخال
    const inputContainer = document.createElement('div');
    inputContainer.className = 'chat-widget-input-row';

    const attachBtn = document.createElement('button');
    attachBtn.type = 'button';
    attachBtn.className = 'chat-widget-attach-btn';
    attachBtn.title = 'إرفاق صورة';
    attachBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"></path></svg>`;
    attachBtn.addEventListener('click', () => this.triggerImageUpload());

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'اكتب رسالتك هنا...';
    input.className = 'chat-widget-text-input';

    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        const text = input.value;
        input.value = '';
        this.sendMessage(text);
      }
    });

    inputContainer.appendChild(attachBtn);
    inputContainer.appendChild(input);
    footer.appendChild(inputContainer);

    const endBtn = document.createElement('button');
    endBtn.textContent = 'إنهاء المحادثة';
    endBtn.className = 'chat-widget-option chat-widget-end-btn';
    endBtn.addEventListener('click', () => this.endChat());
    footer.appendChild(endBtn);

    body.scrollTop = body.scrollHeight;
  }

  buildSystemEventElement(item) {
    const wrapper = document.createElement('div');
    wrapper.className = 'chat-widget-system-event';
    wrapper.innerHTML = `
      <div class="chat-widget-avatar" style="background:${this.getAvatarGradient(item.avatarSeed)}"></div>
      <div class="chat-widget-system-text">${this.escapeHtml(item.content)}</div>
      <div class="chat-widget-system-time">${this.formatEventTimestamp(item.createdAt)}</div>
    `;
    return wrapper;
  }

  /* ==================== إرسال الرسائل والرد الآلي ==================== */

  async sendMessage(text) {
    const content = (text || '').trim();
    if (!content || !this.currentSessionId || !this.currentUser) return;

    this.quickOptions = null;
    this.renderStep(); // نشيل الأزرار فورًا لحد ما يوصل الرد

    const { error: sendError } = await supabase.from('chat_messages').insert({
      session_id: this.currentSessionId,
      sender_id: this.currentUser.id,
      message_text: content,
      is_admin_reply: false
    });

    if (sendError) {
      console.error('[ChatWidget] Error sending message:', sendError);
      return;
    }

    await this.triggerBotReply({ text: content });
  }

  /**
   * بيحسب رد البوت (لو مفيش موظف دعم واخد الجلسة يدويًا حاليًا) وبيسجله،
   * وده نفس المنطق المستخدم في صفحة لوحة تحكم العميل بالظبط.
   */
  async triggerBotReply({ text = '', imageUrl = null } = {}) {
    try {
      const { data: freshSession } = await supabase
        .from('chat_sessions')
        .select('bot_state, is_manual_mode')
        .eq('id', this.currentSessionId)
        .single();

      if (freshSession?.is_manual_mode) return; // موظف الدعم واخد بال، البوت يسكت

      const { reply, options } = await getBotReply({
        text,
        supabase,
        sessionId: this.currentSessionId,
        userId: this.currentUser.id,
        botState: freshSession?.bot_state || {},
        botSettings: this.botSettings,
        imageUrl
      });

      await supabase.from('chat_messages').insert({
        session_id: this.currentSessionId,
        sender_id: null,
        message_text: reply,
        is_admin_reply: false,
        is_bot_reply: true
      });

      this.quickOptions = options;
      this.renderStep();
    } catch (err) {
      console.error('[ChatWidget] Bot reply error:', err);
    }
  }

  /* ==================== إرفاق صورة (خطوة اختيارية في فتح تذكرة مشكلة) ==================== */

  triggerImageUpload() {
    let input = document.getElementById('widgetImageFileInput');
    if (!input) {
      input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.id = 'widgetImageFileInput';
      input.style.display = 'none';
      document.body.appendChild(input);
    }
    input.onchange = (e) => {
      const file = e.target.files?.[0];
      input.value = '';
      if (file) this.handleImageFileSelected(file);
    };
    input.click();
  }

  async handleImageFileSelected(file) {
    if (!file || !this.currentUser || !this.currentSessionId) return;
    try {
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
      const path = `${this.currentUser.id}/${this.currentSessionId}-${Date.now()}.${ext}`;

      const { error: uploadError } = await supabase.storage.from('tickets').upload(path, file, { upsert: false });
      if (uploadError) throw uploadError;

      const { data: pub } = supabase.storage.from('tickets').getPublicUrl(path);

      await supabase.from('chat_messages').insert({
        session_id: this.currentSessionId,
        sender_id: this.currentUser.id,
        message_text: '📎 صورة مرفقة',
        image_url: pub.publicUrl,
        is_admin_reply: false
      });

      this.quickOptions = null;
      this.renderStep();
      await this.triggerBotReply({ text: '', imageUrl: pub.publicUrl });
    } catch (err) {
      console.error('[ChatWidget] Image upload error:', err);
      alert('حصل خطأ في رفع الصورة، تقدر تجرب تاني أو تكمل من غيرها');
    }
  }

  /* ==================== إنهاء المحادثة والتقييم ==================== */

  async endChat() {
    if (this.currentSessionId) {
      await supabase.from('chat_sessions').update({ status: 'closed' }).eq('id', this.currentSessionId);
    }
    if (this.messageChannel) { supabase.removeChannel(this.messageChannel); this.messageChannel = null; }
    if (this.sessionChannel) { supabase.removeChannel(this.sessionChannel); this.sessionChannel = null; }

    this.currentStep = 'rating';
    this.renderStep();
  }

  renderRatingStep() {
    const body = document.getElementById('chatWidgetBody');
    const header = document.getElementById('headerStatus');

    header.textContent = 'كيف كانت تجربتك؟';
    body.innerHTML = '<div style="text-align: center; padding: 2rem 0;">شكراً لاستخدامك خدمتنا</div>';

    const ratings = [
      { value: 'happy', emoji: '😊' },
      { value: 'neutral', emoji: '😐' },
      { value: 'unhappy', emoji: '😢' }
    ];

    const ratingContainer = document.createElement('div');
    ratingContainer.className = 'chat-widget-rating-row';

    ratings.forEach(rating => {
      const btn = document.createElement('button');
      btn.textContent = rating.emoji;
      btn.className = 'chat-widget-rating-btn';
      btn.addEventListener('click', () => this.submitRating(rating.value));
      ratingContainer.appendChild(btn);
    });

    body.appendChild(ratingContainer);
  }

  submitRating(rating) {
    // ⚠️ التقييم هنا شكلي فقط حاليًا ومش بيتخزن في قاعدة البيانات، بالظبط
    // زي حالة نافذة التقييم في صفحة لوحة تحكم العميل دلوقتي. لو حابب نفعّله
    // فعليًا (تخزينه في تذكرة أو جدول تقييمات) قولّي عشان نضيفه للاتنين مع بعض.
    console.log('[ChatWidget] Rating selected (not persisted yet):', rating);
    setTimeout(() => this.closeWidget(), 1000);
  }
}

// تهيئة الويدجت عند تحميل الصفحة
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.chatWidget = new ChatWidget();
  });
} else {
  window.chatWidget = new ChatWidget();
}
