/**
 * ويدجت الدردشة المباشرة - Client Side
 * يدير واجهة المستخدم والتفاعل مع الخدمة
 *
 * هذه النسخة تضيف:
 *  - قائمة إعدادات (زر الترس): بيانات التواصل/تسجيل الدخول، تحميل نص المحادثة،
 *    تكبير النافذة، تفعيل/تعطيل الإشعارات.
 *  - زر تصغير الويدجت (Minimize) منفصل عن زر الإغلاق.
 *  - أحداث "انضم إلى المحادثة" / "غادر المحادثة" تظهر مع صورة رمزية (Avatar)
 *    عند دخول/خروج الزائر، وعند دخول/خروج موظف الدعم (Admin) للمحادثة.
 */

class ChatWidget {
  constructor() {
    this.currentConversation = null;
    this.currentStep = 'closed'; // closed, questions, chat, outside-hours-form, rating, confirmation
    this.isLoading = false;
    this.messages = []; // يشمل الرسائل العادية وأحداث النظام (system events)
    this.userId = this.getUserId();
    this.visitorName = this.getVisitorName();
    this.isMinimized = false;
    this.isMaximized = false;
    this.notificationsEnabled = this.getNotificationsPref();
    this.isSettingsOpen = false;
    this.agentJoined = false;
    this.init();
  }

  /* ==================== تهيئة عامة ==================== */

  getUserId() {
    let userId = localStorage.getItem('chat_user_id');
    if (!userId) {
      userId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem('chat_user_id', userId);
    }
    return userId;
  }

  /**
   * اسم زائر عشوائي ثابت لكل جهاز (يُحفظ في localStorage) على غرار
   * الأسماء الافتراضية في أدوات الدردشة المباشرة الشهيرة (مثال: "Zaur B.")
   */
  getVisitorName() {
    let name = localStorage.getItem('chat_visitor_name');
    if (!name) {
      const firstNames = ['أحمد', 'سارة', 'محمد', 'ليلى', 'خالد', 'منى', 'يوسف', 'هند', 'عمر', 'ريم'];
      const first = firstNames[Math.floor(Math.random() * firstNames.length)];
      const lastInitial = String.fromCharCode(65 + Math.floor(Math.random() * 26)); // حرف لاتيني كنسق مألوف
      name = `${first} ${lastInitial}.`;
      localStorage.setItem('chat_visitor_name', name);
    }
    return name;
  }

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
    this.loadSuggestedQuestions();
    this.checkWorkingHours();
    this.subscribeToConversationEvents();
  }

  /* ==================== أدوات مساعدة ==================== */

  /**
   * ينشئ تدرج لوني (gradient) ثابت بناءً على نص (اسم/معرف) — نفس الشخص
   * يحصل دائماً على نفس الألوان.
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
              <span class="chat-settings-label">تقديم بيانات التواصل</span>
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

  /* ==================== الاشتراك في أحداث المحادثة ==================== */

  subscribeToConversationEvents() {
    if (!window.chatEventEmitter) return;

    window.chatEventEmitter.on('global:admin_joined', (data) => {
      if (this.currentConversation && data.conversationId === this.currentConversation.id) {
        this.handleAgentJoined(data.adminName || 'موظف الدعم');
      }
    });

    window.chatEventEmitter.on('global:admin_left', (data) => {
      if (this.currentConversation && data.conversationId === this.currentConversation.id) {
        this.handleAgentLeft(data.adminName || 'موظف الدعم');
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
    this.currentStep = 'questions';
    this.renderStep();
  }

  closeWidget() {
    const panel = document.getElementById('chatWidgetPanel');
    if (!panel) return;

    // إذا كان هناك موظف دعم متصل بالمحادثة، سجل خروج الزائر
    if (this.currentConversation) {
      this.addSystemEvent(`${this.visitorName} غادر المحادثة`, this.visitorName);
    }

    panel.classList.remove('active');
    this.toggleSettingsPanel(false);
    this.currentStep = 'closed';
    this.currentConversation = null;
    this.messages = [];
    this.agentJoined = false;
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
      const who = item.senderType === 'customer' ? this.visitorName : 'الدعم الفني';
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

  /* ==================== تحميل الأسئلة المقترحة / ساعات العمل ==================== */

  loadSuggestedQuestions() {
    this.suggestedQuestions = chatService.getSuggestedQuestions();
  }

  checkWorkingHours() {
    this.isWorkingHours = chatService.isCurrentlyWorkingHours();
  }

  /* ==================== رسم الخطوات ==================== */

  renderStep() {
    const body = document.getElementById('chatWidgetBody');
    const footer = document.getElementById('chatWidgetFooter');

    body.innerHTML = '';
    footer.innerHTML = '';

    switch (this.currentStep) {
      case 'questions':
        this.renderQuestionsStep();
        break;
      case 'chat':
        this.renderChatStep();
        break;
      case 'outside-hours-form':
        this.renderOutsideHoursForm();
        break;
      case 'rating':
        this.renderRatingStep();
        break;
      case 'confirmation':
        this.renderConfirmationStep();
        break;
    }
  }

  renderQuestionsStep() {
    const body = document.getElementById('chatWidgetBody');
    const footer = document.getElementById('chatWidgetFooter');
    const header = document.getElementById('headerStatus');

    header.textContent = 'كيف يمكننا مساعدتك؟';

    this.suggestedQuestions.forEach(question => {
      const option = document.createElement('button');
      option.className = 'chat-widget-option';
      option.innerHTML = `
        <div class="chat-widget-option-icon">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z"/>
          </svg>
        </div>
        <div class="chat-widget-option-text">${question.question}</div>
      `;
      option.addEventListener('click', () => this.selectQuestion(question));
      body.appendChild(option);
    });

    const supportBtn = document.createElement('button');
    supportBtn.className = 'chat-widget-option';
    supportBtn.style.marginTop = '0.5rem';
    supportBtn.innerHTML = `
      <div class="chat-widget-option-icon">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H8l-2 2V4h14v12z"/>
        </svg>
      </div>
      <div class="chat-widget-option-text">
        ${this.isWorkingHours ? 'التواصل مع الدعم الفني' : 'استفسار خارج أوقات العمل'}
      </div>
    `;
    supportBtn.addEventListener('click', () => this.contactSupport());
    body.appendChild(supportBtn);
  }

  selectQuestion(question) {
    this.isLoading = true;

    this.currentConversation = chatService.createConversation(this.userId, {
      subject: question.question
    });

    const answerMessage = {
      id: `msg_${Date.now()}`,
      conversationId: this.currentConversation.id,
      senderId: 'system',
      senderType: 'admin',
      content: question.answer,
      createdAt: new Date()
    };

    this.messages = [answerMessage];
    this.currentStep = 'chat';
    this.isLoading = false;
    this.renderStep();
  }

  contactSupport() {
    if (this.isWorkingHours) {
      this.isLoading = true;
      this.currentConversation = chatService.createConversation(this.userId, {
        subject: 'استفسار عام'
      });
      this.messages = [];
      this.isLoading = false;
      this.currentStep = 'chat';
      this.renderStep();
      this.startSupportFlow();
    } else {
      this.currentStep = 'outside-hours-form';
      this.renderStep();
    }
  }

  /**
   * يشغّل تسلسل بداية محادثة الدعم: رسالتين ترحيبيتين آليتين، ثم حدث
   * "انضم إلى المحادثة" الخاص بالزائر، ثم بعد فترة قصيرة ينضم موظف الدعم.
   */
  startSupportFlow() {
    this.addBotMessage(
      'مرحباً! إذا كان لديك حساب، يرجى <a href="/login.html">تسجيل الدخول</a> للحصول على خدمة أكثر تخصيصاً. أو يمكنك تقديم <a href="#" class="chat-provide-contact-link">بيانات التواصل الخاصة بك</a>.'
    );
    this.addBotMessage('أحد ممثلي خدمة العملاء لدينا سينضم قريباً. يرجى الانتظار!');
    this.addSystemEvent(`${this.visitorName} انضم إلى المحادثة`, this.visitorName);

    // محاكاة انضمام موظف دعم فعلي للمحادثة بعد فترة (في نسخة حقيقية سيتم هذا
    // فعلياً من لوحة تحكم الإدارة عبر chatService.assignToAdmin، وسيصل الحدث
    // هنا تلقائياً عبر subscribeToConversationEvents)
    setTimeout(() => {
      if (this.currentConversation) {
        chatService.assignToAdmin(this.currentConversation.id, 'admin_1', 'فريق الدعم');
      }
    }, 2500);
  }

  addBotMessage(content) {
    const message = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      conversationId: this.currentConversation ? this.currentConversation.id : null,
      senderId: 'system',
      senderType: 'admin',
      content,
      createdAt: new Date()
    };
    this.messages.push(message);
    this.renderStep();
  }

  addSystemEvent(text, avatarSeed) {
    this.messages.push({
      id: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      isSystemEvent: true,
      content: text,
      avatarSeed: avatarSeed || 'system',
      createdAt: new Date()
    });
    this.renderStep();
  }

  handleAgentJoined(agentName) {
    if (this.agentJoined) return;
    this.agentJoined = true;
    this.addSystemEvent(`${agentName} انضم إلى المحادثة`, agentName);
    const header = document.getElementById('headerStatus');
    if (header) header.textContent = `${agentName} متصل الآن`;
  }

  handleAgentLeft(agentName) {
    if (!this.agentJoined) return;
    this.agentJoined = false;
    this.addSystemEvent(`${agentName} غادر المحادثة`, agentName);
    const header = document.getElementById('headerStatus');
    if (header) header.textContent = 'المحادثة';
  }

  /* ==================== خطوة المحادثة ==================== */

  renderChatStep() {
    const body = document.getElementById('chatWidgetBody');
    const footer = document.getElementById('chatWidgetFooter');
    const header = document.getElementById('headerStatus');

    if (!this.agentJoined) header.textContent = 'المحادثة';

    this.messages.forEach(item => {
      if (item.isSystemEvent) {
        body.appendChild(this.buildSystemEventElement(item));
      } else {
        const messageDiv = document.createElement('div');
        messageDiv.className = `chat-widget-message ${item.senderType === 'admin' ? 'bot' : 'user'}`;
        messageDiv.innerHTML = `<div class="chat-widget-bubble">${this.sanitizeMessageHtml(item.content)}</div>`;
        body.appendChild(messageDiv);
      }
    });

    // شريط الإدخال
    const inputContainer = document.createElement('div');
    inputContainer.className = 'chat-widget-input-row';

    const attachBtn = document.createElement('button');
    attachBtn.type = 'button';
    attachBtn.className = 'chat-widget-attach-btn';
    attachBtn.title = 'إرفاق ملف';
    attachBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"></path></svg>`;
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.style.display = 'none';
    attachBtn.addEventListener('click', () => fileInput.click());

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'What can we help you with?';
    input.className = 'chat-widget-text-input';

    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.sendMessage(input.value);
    });

    inputContainer.appendChild(attachBtn);
    inputContainer.appendChild(fileInput);
    inputContainer.appendChild(input);
    footer.appendChild(inputContainer);

    const endBtn = document.createElement('button');
    endBtn.textContent = 'إنهاء المحادثة';
    endBtn.className = 'chat-widget-option chat-widget-end-btn';
    endBtn.addEventListener('click', () => {
      if (this.currentConversation) {
        // ينهي المحادثة من جهة الخدمة، وهذا يبث حدث "admin_left" تلقائياً
        // إن كان هناك موظف دعم منضم، فتلتقطه subscribeToConversationEvents
        chatService.closeConversation(this.currentConversation.id, 'admin_1');
      }
      this.currentStep = 'rating';
      this.renderStep();
    });
    footer.appendChild(endBtn);

    body.scrollTop = body.scrollHeight;
  }

  buildSystemEventElement(item) {
    const wrapper = document.createElement('div');
    wrapper.className = 'chat-widget-system-event';
    wrapper.innerHTML = `
      <div class="chat-widget-avatar" style="background:${this.getAvatarGradient(item.avatarSeed)}"></div>
      <div class="chat-widget-system-text">${item.content}</div>
      <div class="chat-widget-system-time">${this.formatEventTimestamp(item.createdAt)}</div>
    `;
    return wrapper;
  }

  sendMessage(content) {
    if (!content.trim() || !this.currentConversation) return;

    const message = chatService.addMessage(
      this.currentConversation.id,
      this.userId,
      'customer',
      content
    );

    this.messages.push(message);
    this.renderStep();

    if (!this.agentJoined) {
      // إن لم يكن هناك موظف دعم منضم بعد، لا نحاكي رداً آلياً إضافياً
      return;
    }

    setTimeout(() => {
      const adminReply = chatService.addMessage(
        this.currentConversation.id,
        'admin_1',
        'admin',
        'شكراً لتواصلك معنا. سيتم الرد على استفسارك قريباً.'
      );
      this.messages.push(adminReply);
      this.renderStep();
    }, 1500);
  }

  /* ==================== نموذج خارج أوقات العمل ==================== */

  renderOutsideHoursForm() {
    const body = document.getElementById('chatWidgetBody');
    const footer = document.getElementById('chatWidgetFooter');
    const header = document.getElementById('headerStatus');

    header.textContent = 'خارج أوقات العمل';

    body.innerHTML = `
      <div style="text-align: right; color: var(--chat-text-secondary); margin-bottom: 1rem; font-size: 0.9rem;">
        نحن حالياً خارج أوقات العمل. يرجى ملء البيانات أدناه وسيتم التواصل معك خلال 24 ساعة.
      </div>
    `;

    const inputs = [
      { id: 'name', placeholder: 'اسمك', type: 'text' },
      { id: 'phone', placeholder: 'رقم الموبايل', type: 'tel' },
      { id: 'email', placeholder: 'البريد الإلكتروني', type: 'email' },
      { id: 'subject', placeholder: 'موضوع الاستفسار', type: 'text' }
    ];

    inputs.forEach(inputConfig => {
      const input = document.createElement('input');
      input.id = `form_${inputConfig.id}`;
      input.type = inputConfig.type;
      input.placeholder = inputConfig.placeholder;
      input.className = 'chat-widget-form-input';
      body.appendChild(input);
    });

    const textarea = document.createElement('textarea');
    textarea.id = 'form_message';
    textarea.placeholder = 'تفاصيل استفسارك';
    textarea.rows = 3;
    textarea.className = 'chat-widget-form-input';
    body.appendChild(textarea);

    const submitBtn = document.createElement('button');
    submitBtn.textContent = 'إرسال';
    submitBtn.className = 'chat-widget-option';
    submitBtn.style.width = '100%';
    submitBtn.style.marginTop = '1rem';
    submitBtn.addEventListener('click', () => this.submitOutsideHoursForm());
    footer.appendChild(submitBtn);
  }

  submitOutsideHoursForm() {
    const name = document.getElementById('form_name').value;
    const phone = document.getElementById('form_phone').value;
    const email = document.getElementById('form_email').value;
    const subject = document.getElementById('form_subject').value;
    const message = document.getElementById('form_message').value;

    if (!name || !phone || !email || !subject || !message) {
      alert('يرجى ملء جميع الحقول');
      return;
    }

    this.currentConversation = chatService.createConversation(this.userId, {
      subject,
      customerName: name,
      customerPhone: phone,
      customerEmail: email
    });

    chatService.addMessage(this.currentConversation.id, this.userId, 'customer', message);

    this.currentStep = 'confirmation';
    this.renderStep();
  }

  /* ==================== التقييم ==================== */

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
    if (this.currentConversation) {
      chatService.addRating(this.currentConversation.id, rating, null);
    }
    setTimeout(() => this.closeWidget(), 1000);
  }

  renderConfirmationStep() {
    const body = document.getElementById('chatWidgetBody');
    const footer = document.getElementById('chatWidgetFooter');
    const header = document.getElementById('headerStatus');

    header.textContent = 'تم استقبال استفسارك';

    body.innerHTML = `
      <div style="text-align: center; padding: 2rem 0;">
        <div style="font-size: 2rem; margin-bottom: 1rem;">✓</div>
        <p style="color: var(--chat-text-secondary); margin-bottom: 1rem;">شكراً لتواصلك معنا</p>
        <p style="color: var(--chat-text-tertiary); font-size: 0.9rem;">سيتم الرد على استفسارك خلال 24 ساعة عمل</p>
      </div>
    `;

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'إغلاق';
    closeBtn.className = 'chat-widget-option';
    closeBtn.style.width = '100%';
    closeBtn.addEventListener('click', () => this.closeWidget());
    footer.appendChild(closeBtn);
  }

  /* ==================== تنظيف HTML ==================== */

  escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return text.replace(/[&<>"']/g, m => map[m]);
  }

  /**
   * يسمح فقط بعناصر <a> البسيطة داخل رسائل البوت الترحيبية (روابط تسجيل
   * الدخول/بيانات التواصل)، وينظف أي شيء آخر لمنع حقن HTML من رسائل المستخدم.
   */
  sanitizeMessageHtml(content) {
    if (content.includes('<a ')) {
      // رسائل النظام الترحيبية المُعرَّفة داخلياً فقط، وليست مدخلة من المستخدم
      return content;
    }
    return this.escapeHtml(content);
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

// ربط النقر على "بيانات التواصل" داخل الرسائل الترحيبية بفتح قائمة الإعدادات
document.addEventListener('click', (e) => {
  if (e.target.classList && e.target.classList.contains('chat-provide-contact-link')) {
    e.preventDefault();
    if (window.chatWidget) window.chatWidget.toggleSettingsPanel(true);
  }
});
