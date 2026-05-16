/**
 * ويدجت الدردشة المباشرة - Client Side
 * يدير واجهة المستخدم والتفاعل مع الخدمة
 */

class ChatWidget {
  constructor() {
    this.currentConversation = null;
    this.currentStep = 'closed'; // closed, questions, chat, outside-hours-form, rating, confirmation
    this.isLoading = false;
    this.messages = [];
    this.userId = this.getUserId();
    this.init();
  }

  /**
   * الحصول على معرف المستخدم
   */
  getUserId() {
    let userId = localStorage.getItem('chat_user_id');
    if (!userId) {
      userId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem('chat_user_id', userId);
    }
    return userId;
  }

  /**
   * تهيئة الويدجت
   */
  init() {
    this.createWidgetHTML();
    this.attachEventListeners();
    this.loadSuggestedQuestions();
    this.checkWorkingHours();
  }

  /**
   * إنشاء HTML الويدجت
   */
  createWidgetHTML() {
    const widgetHTML = `
      <div class="floating-chat-widget">
        <button class="chat-bubble-btn" id="chatBubbleBtn" title="فتح الدردشة">
          <div class="chat-bubble-icon">
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H8l-2 2V4h14v12z"/>
            </svg>
          </div>
        </button>

        <div class="chat-widget-panel" id="chatWidgetPanel">
          <!-- Header -->
          <div class="chat-widget-header">
            <div class="chat-widget-header-title">
              <div class="chat-widget-header-icon">
                <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                  <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H8l-2 2V4h14v12z"/>
                </svg>
              </div>
              <div>
                <h3>الدردشة المباشرة</h3>
                <p id="headerStatus">كيف يمكننا مساعدتك؟</p>
              </div>
            </div>
            <button class="chat-widget-close" id="chatWidgetClose">×</button>
          </div>

          <!-- Body -->
          <div class="chat-widget-body" id="chatWidgetBody">
            <!-- سيتم ملؤه ديناميكياً -->
          </div>

          <!-- Footer -->
          <div class="chat-widget-footer" id="chatWidgetFooter">
            <!-- سيتم ملؤه ديناميكياً -->
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', widgetHTML);
  }

  /**
   * ربط أحداث الويدجت
   */
  attachEventListeners() {
    const bubbleBtn = document.getElementById('chatBubbleBtn');
    const closeBtn = document.getElementById('chatWidgetClose');

    bubbleBtn.addEventListener('click', () => this.openWidget());
    closeBtn.addEventListener('click', () => this.closeWidget());
  }

  /**
   * فتح الويدجت
   */
  openWidget() {
    const panel = document.getElementById('chatWidgetPanel');
    panel.classList.add('active');
    this.currentStep = 'questions';
    this.renderStep();
  }

  /**
   * إغلاق الويدجت
   */
  closeWidget() {
    const panel = document.getElementById('chatWidgetPanel');
    panel.classList.remove('active');
    this.currentStep = 'closed';
    this.currentConversation = null;
    this.messages = [];
  }

  /**
   * تحميل الأسئلة المقترحة
   */
  loadSuggestedQuestions() {
    // محاكاة تحميل الأسئلة من الخدمة
    this.suggestedQuestions = chatService.getSuggestedQuestions();
  }

  /**
   * التحقق من أوقات العمل
   */
  checkWorkingHours() {
    this.isWorkingHours = chatService.isCurrentlyWorkingHours();
  }

  /**
   * رسم خطوة محددة
   */
  renderStep() {
    const body = document.getElementById('chatWidgetBody');
    const footer = document.getElementById('chatWidgetFooter');
    const header = document.getElementById('headerStatus');

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

  /**
   * رسم خطوة الأسئلة المقترحة
   */
  renderQuestionsStep() {
    const body = document.getElementById('chatWidgetBody');
    const footer = document.getElementById('chatWidgetFooter');
    const header = document.getElementById('headerStatus');

    header.textContent = 'كيف يمكننا مساعدتك؟';

    // عرض الأسئلة
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

    // زر التواصل مع الدعم
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

  /**
   * اختيار سؤال
   */
  selectQuestion(question) {
    this.isLoading = true;

    // إنشاء محادثة جديدة
    this.currentConversation = chatService.createConversation(this.userId, {
      subject: question.question
    });

    // إضافة الإجابة كرسالة من الدعم
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

  /**
   * التواصل مع الدعم الفني
   */
  contactSupport() {
    if (this.isWorkingHours) {
      this.isLoading = true;
      this.currentConversation = chatService.createConversation(this.userId, {
        subject: 'استفسار عام'
      });
      this.messages = [];
      this.currentStep = 'chat';
      this.isLoading = false;
      this.renderStep();
    } else {
      this.currentStep = 'outside-hours-form';
      this.renderStep();
    }
  }

  /**
   * رسم خطوة المحادثة
   */
  renderChatStep() {
    const body = document.getElementById('chatWidgetBody');
    const footer = document.getElementById('chatWidgetFooter');
    const header = document.getElementById('headerStatus');

    header.textContent = 'المحادثة';

    // عرض الرسائل
    this.messages.forEach(msg => {
      const messageDiv = document.createElement('div');
      messageDiv.className = `chat-widget-message ${msg.senderType === 'admin' ? 'bot' : 'user'}`;
      messageDiv.innerHTML = `
        <div class="chat-widget-bubble">${this.escapeHtml(msg.content)}</div>
      `;
      body.appendChild(messageDiv);
    });

    // شريط الإدخال
    const inputContainer = document.createElement('div');
    inputContainer.style.display = 'flex';
    inputContainer.style.gap = '0.5rem';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'اكتب رسالتك...';
    input.style.flex = '1';
    input.style.padding = '0.75rem';
    input.style.border = '1px solid rgba(0, 51, 102, 0.2)';
    input.style.borderRadius = '8px';
    input.style.fontFamily = 'Cairo, sans-serif';
    input.style.textAlign = 'right';

    const sendBtn = document.createElement('button');
    sendBtn.textContent = 'إرسال';
    sendBtn.style.padding = '0.75rem 1rem';
    sendBtn.style.background = 'linear-gradient(135deg, #003366 0%, #0055AA 100%)';
    sendBtn.style.color = 'white';
    sendBtn.style.border = 'none';
    sendBtn.style.borderRadius = '8px';
    sendBtn.style.cursor = 'pointer';
    sendBtn.style.fontFamily = 'Cairo, sans-serif';
    sendBtn.style.fontWeight = '600';

    sendBtn.addEventListener('click', () => this.sendMessage(input.value));
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.sendMessage(input.value);
    });

    inputContainer.appendChild(input);
    inputContainer.appendChild(sendBtn);
    footer.appendChild(inputContainer);

    // زر إنهاء المحادثة
    const endBtn = document.createElement('button');
    endBtn.textContent = 'إنهاء المحادثة';
    endBtn.className = 'chat-widget-option';
    endBtn.style.marginTop = '0.5rem';
    endBtn.addEventListener('click', () => {
      this.currentStep = 'rating';
      this.renderStep();
    });
    footer.appendChild(endBtn);

    // التمرير إلى آخر رسالة
    body.scrollTop = body.scrollHeight;
  }

  /**
   * إرسال رسالة
   */
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

    // محاكاة رد من الدعم
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

  /**
   * رسم نموذج خارج أوقات العمل
   */
  renderOutsideHoursForm() {
    const body = document.getElementById('chatWidgetBody');
    const footer = document.getElementById('chatWidgetFooter');
    const header = document.getElementById('headerStatus');

    header.textContent = 'خارج أوقات العمل';

    const formHTML = `
      <div style="text-align: right; color: #666; margin-bottom: 1rem; font-size: 0.9rem;">
        نحن حالياً خارج أوقات العمل. يرجى ملء البيانات أدناه وسيتم التواصل معك خلال 24 ساعة.
      </div>
    `;

    body.innerHTML = formHTML;

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
      input.style.width = '100%';
      input.style.padding = '0.75rem';
      input.style.marginBottom = '0.75rem';
      input.style.border = '1px solid rgba(0, 51, 102, 0.2)';
      input.style.borderRadius = '8px';
      input.style.fontFamily = 'Cairo, sans-serif';
      input.style.textAlign = 'right';
      input.style.boxSizing = 'border-box';
      body.appendChild(input);
    });

    const textarea = document.createElement('textarea');
    textarea.id = 'form_message';
    textarea.placeholder = 'تفاصيل استفسارك';
    textarea.rows = 3;
    textarea.style.width = '100%';
    textarea.style.padding = '0.75rem';
    textarea.style.border = '1px solid rgba(0, 51, 102, 0.2)';
    textarea.style.borderRadius = '8px';
    textarea.style.fontFamily = 'Cairo, sans-serif';
    textarea.style.textAlign = 'right';
    textarea.style.boxSizing = 'border-box';
    body.appendChild(textarea);

    const submitBtn = document.createElement('button');
    submitBtn.textContent = 'إرسال';
    submitBtn.className = 'chat-widget-option';
    submitBtn.style.width = '100%';
    submitBtn.style.marginTop = '1rem';
    submitBtn.addEventListener('click', () => this.submitOutsideHoursForm());
    footer.appendChild(submitBtn);
  }

  /**
   * إرسال نموذج خارج أوقات العمل
   */
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

    // إنشاء محادثة خارج أوقات العمل
    this.currentConversation = chatService.createConversation(this.userId, {
      subject,
      customerName: name,
      customerPhone: phone,
      customerEmail: email
    });

    // إضافة الرسالة
    chatService.addMessage(
      this.currentConversation.id,
      this.userId,
      'customer',
      message
    );

    this.currentStep = 'confirmation';
    this.renderStep();
  }

  /**
   * رسم خطوة التقييم
   */
  renderRatingStep() {
    const body = document.getElementById('chatWidgetBody');
    const footer = document.getElementById('chatWidgetFooter');
    const header = document.getElementById('headerStatus');

    header.textContent = 'كيف كانت تجربتك؟';

    body.innerHTML = '<div style="text-align: center; padding: 2rem 0;">شكراً لاستخدامك خدمتنا</div>';

    const ratings = [
      { value: 'happy', emoji: '😊', label: 'سعيد' },
      { value: 'neutral', emoji: '😐', label: 'محايد' },
      { value: 'unhappy', emoji: '😢', label: 'غير راضي' }
    ];

    const ratingContainer = document.createElement('div');
    ratingContainer.style.display = 'flex';
    ratingContainer.style.justifyContent = 'center';
    ratingContainer.style.gap = '1rem';
    ratingContainer.style.padding = '1rem';

    ratings.forEach(rating => {
      const btn = document.createElement('button');
      btn.textContent = rating.emoji;
      btn.style.fontSize = '2rem';
      btn.style.background = 'none';
      btn.style.border = '2px solid rgba(0, 51, 102, 0.2)';
      btn.style.borderRadius = '50%';
      btn.style.width = '60px';
      btn.style.height = '60px';
      btn.style.cursor = 'pointer';
      btn.style.transition = 'all 0.2s';
      btn.addEventListener('click', () => this.submitRating(rating.value));
      btn.addEventListener('mouseover', () => {
        btn.style.borderColor = '#0055AA';
        btn.style.transform = 'scale(1.1)';
      });
      btn.addEventListener('mouseout', () => {
        btn.style.borderColor = 'rgba(0, 51, 102, 0.2)';
        btn.style.transform = 'scale(1)';
      });
      ratingContainer.appendChild(btn);
    });

    body.appendChild(ratingContainer);
  }

  /**
   * إرسال التقييم
   */
  submitRating(rating) {
    if (this.currentConversation) {
      chatService.addRating(this.currentConversation.id, rating, null);
    }

    setTimeout(() => {
      this.closeWidget();
    }, 1000);
  }

  /**
   * رسم خطوة التأكيد
   */
  renderConfirmationStep() {
    const body = document.getElementById('chatWidgetBody');
    const footer = document.getElementById('chatWidgetFooter');
    const header = document.getElementById('headerStatus');

    header.textContent = 'تم استقبال استفسارك';

    body.innerHTML = `
      <div style="text-align: center; padding: 2rem 0;">
        <div style="font-size: 2rem; margin-bottom: 1rem;">✓</div>
        <p style="color: #666; margin-bottom: 1rem;">شكراً لتواصلك معنا</p>
        <p style="color: #999; font-size: 0.9rem;">سيتم الرد على استفسارك خلال 24 ساعة عمل</p>
      </div>
    `;

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'إغلاق';
    closeBtn.className = 'chat-widget-option';
    closeBtn.style.width = '100%';
    closeBtn.addEventListener('click', () => this.closeWidget());
    footer.appendChild(closeBtn);
  }

  /**
   * تنظيف HTML
   */
  escapeHtml(text) {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
  }
}

// تهيئة الويدجت عند تحميل الصفحة
document.addEventListener('DOMContentLoaded', () => {
  window.chatWidget = new ChatWidget();
});
