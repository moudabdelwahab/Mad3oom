/**
 * لوحة تحكم الدردشة - Admin Dashboard
 * تدير المحادثات والرد الفوري والإحصائيات
 */

class AdminChatDashboard {
  constructor() {
    this.currentConversation = null;
    this.activeTab = 'active';
    this.adminId = this.getAdminId();
    this.init();
  }

  /**
   * الحصول على معرف المسؤول
   */
  getAdminId() {
    let adminId = localStorage.getItem('admin_id');
    if (!adminId) {
      adminId = `admin_${Date.now()}`;
      localStorage.setItem('admin_id', adminId);
    }
    return adminId;
  }

  /**
   * تهيئة لوحة التحكم
   */
  init() {
    this.attachEventListeners();
    this.loadConversations();
    this.startAutoRefresh();
  }

  /**
   * ربط أحداث الواجهة
   */
  attachEventListeners() {
    // أزرار التبويب
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        this.activeTab = e.target.dataset.tab;
        this.loadConversations();
      });
    });
  }

  /**
   * تحميل المحادثات
   */
  loadConversations() {
    const list = document.getElementById('conversationsList');
    list.innerHTML = '';

    const conversations = this.activeTab === 'active' 
      ? chatService.getActiveConversations()
      : chatService.getClosedConversations();

    if (conversations.length === 0) {
      list.innerHTML = '<div style="text-align: center; padding: 2rem; color: #999;">لا توجد محادثات</div>';
      return;
    }

    conversations.forEach(conv => {
      const item = document.createElement('div');
      item.className = `conversation-item ${this.currentConversation?.id === conv.id ? 'active' : ''}`;
      item.innerHTML = `
        <div class="conversation-item-header">
          <div class="conversation-item-title">${this.escapeHtml(conv.subject)}</div>
          <div class="conversation-item-status">
            ${conv.isOutsideWorkHours ? 'خارج الأوقات' : 'نشطة'}
          </div>
        </div>
        <div class="conversation-item-preview">
          ${this.escapeHtml(conv.lastMessage || 'لا توجد رسائل')}
        </div>
        <div class="conversation-item-meta">
          ${conv.messageCount || 0} رسالة • ${this.formatDate(conv.createdAt)}
        </div>
      `;
      item.addEventListener('click', () => this.selectConversation(conv));
      list.appendChild(item);
    });
  }

  /**
   * اختيار محادثة
   */
  selectConversation(conversation) {
    this.currentConversation = conversation;
    this.loadConversation(conversation.id);
    this.loadConversations(); // لتحديث الحالة النشطة
  }

  /**
   * تحميل محادثة
   */
  loadConversation(conversationId) {
    const content = document.getElementById('chatContent');
    const conv = chatService.getConversation(conversationId);
    const messages = chatService.getConversationMessages(conversationId);

    if (!conv) {
      content.innerHTML = '<div class="empty-state"><p>المحادثة غير موجودة</p></div>';
      return;
    }

    content.innerHTML = `
      <div class="chat-header">
        <div class="chat-header-info">
          <h3>${this.escapeHtml(conv.subject)}</h3>
          <p>${conv.customerName || 'عميل'} • ${conv.customerEmail || ''}</p>
        </div>
        <div class="chat-actions">
          ${conv.status === 'active' ? `
            <button class="action-btn" onclick="dashboard.closeConversation()">إغلاق</button>
          ` : `
            <span class="action-btn" style="background: #4caf50; cursor: default;">مغلقة</span>
          `}
          <button class="action-btn" onclick="openWorkHoursModal()">أوقات العمل</button>
        </div>
      </div>
      <div class="messages-container" id="messagesContainer"></div>
      ${conv.status === 'active' ? `
        <div class="input-area">
          <textarea id="messageInput" placeholder="اكتب رسالتك..." rows="2"></textarea>
          <button class="send-btn" onclick="dashboard.sendMessage()">إرسال</button>
        </div>
      ` : ''}
    `;

    // عرض الرسائل
    const messagesContainer = document.getElementById('messagesContainer');
    messages.forEach(msg => {
      const msgDiv = document.createElement('div');
      msgDiv.className = `message ${msg.senderType === 'admin' ? 'admin' : 'customer'}`;
      msgDiv.innerHTML = `
        <div>
          <div class="message-bubble">${this.escapeHtml(msg.content)}</div>
          <div class="message-time">${this.formatTime(msg.createdAt)}</div>
        </div>
      `;
      messagesContainer.appendChild(msgDiv);
    });

    // التمرير إلى آخر رسالة
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    // ربط حدث الإرسال
    const input = document.getElementById('messageInput');
    if (input) {
      input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.sendMessage();
        }
      });
    }
  }

  /**
   * إرسال رسالة
   */
  sendMessage() {
    const input = document.getElementById('messageInput');
    if (!input || !input.value.trim() || !this.currentConversation) return;

    const message = chatService.addMessage(
      this.currentConversation.id,
      this.adminId,
      'admin',
      input.value
    );

    input.value = '';
    this.loadConversation(this.currentConversation.id);
  }

  /**
   * إغلاق محادثة
   */
  closeConversation() {
    if (!this.currentConversation) return;

    if (confirm('هل تريد إغلاق هذه المحادثة؟')) {
      chatService.closeConversation(this.currentConversation.id, this.adminId);
      this.currentConversation = null;
      document.getElementById('chatContent').innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">✓</div>
          <p>تم إغلاق المحادثة</p>
        </div>
      `;
      this.loadConversations();
    }
  }

  /**
   * تنسيق التاريخ
   */
  formatDate(date) {
    if (typeof date === 'string') date = new Date(date);
    return new Intl.DateTimeFormat('ar-SA', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    }).format(date);
  }

  /**
   * تنسيق الوقت
   */
  formatTime(date) {
    if (typeof date === 'string') date = new Date(date);
    return new Intl.DateTimeFormat('ar-SA', {
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
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

  /**
   * تحديث تلقائي للمحادثات
   */
  startAutoRefresh() {
    setInterval(() => {
      if (this.currentConversation) {
        this.loadConversation(this.currentConversation.id);
      }
      this.loadConversations();
    }, 3000);
  }
}

// إنشاء instance من لوحة التحكم
const dashboard = new AdminChatDashboard();

/**
 * فتح نموذج أوقات العمل
 */
function openWorkHoursModal() {
  const modal = document.getElementById('workHoursModal');
  const form = document.getElementById('workHoursForm');
  const workHours = chatService.getWorkHours();

  form.innerHTML = '';

  workHours.forEach(day => {
    const dayDiv = document.createElement('div');
    dayDiv.style.marginBottom = '1rem';
    dayDiv.style.padding = '1rem';
    dayDiv.style.background = '#f8f9fa';
    dayDiv.style.borderRadius = '8px';

    dayDiv.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
        <label style="font-weight: 600;">${day.dayName}</label>
        <input type="checkbox" ${day.isWorkDay ? 'checked' : ''} 
               onchange="updateWorkDay(${day.dayOfWeek}, this.checked)"
               style="width: 20px; height: 20px; cursor: pointer;">
      </div>
      ${day.isWorkDay ? `
        <div style="display: flex; gap: 0.5rem;">
          <input type="time" value="${day.startTime}" 
                 onchange="updateWorkHours(${day.dayOfWeek}, this.value, document.getElementById('endTime_${day.dayOfWeek}').value)"
                 style="flex: 1; padding: 0.5rem; border: 1px solid #ddd; border-radius: 6px;">
          <input type="time" id="endTime_${day.dayOfWeek}" value="${day.endTime}" 
                 onchange="updateWorkHours(${day.dayOfWeek}, document.getElementById('startTime_${day.dayOfWeek}').value, this.value)"
                 style="flex: 1; padding: 0.5rem; border: 1px solid #ddd; border-radius: 6px;">
        </div>
      ` : ''}
    `;

    if (day.isWorkDay) {
      const startInput = dayDiv.querySelector('input[type="time"]');
      startInput.id = `startTime_${day.dayOfWeek}`;
    }

    form.appendChild(dayDiv);
  });

  modal.style.display = 'flex';
}

/**
 * إغلاق نموذج أوقات العمل
 */
function closeWorkHoursModal() {
  document.getElementById('workHoursModal').style.display = 'none';
}

/**
 * تحديث يوم العمل
 */
function updateWorkDay(dayOfWeek, isWorkDay) {
  const currentDay = chatService.workHours[dayOfWeek];
  chatService.updateWorkHours(dayOfWeek, currentDay.startTime, currentDay.endTime, isWorkDay);
  openWorkHoursModal(); // إعادة تحميل النموذج
}

/**
 * تحديث أوقات العمل
 */
function updateWorkHours(dayOfWeek, startTime, endTime) {
  if (startTime && endTime) {
    chatService.updateWorkHours(dayOfWeek, startTime, endTime, true);
  }
}

// إغلاق النموذج عند الضغط خارجه
document.addEventListener('click', (e) => {
  const modal = document.getElementById('workHoursModal');
  if (e.target === modal) {
    closeWorkHoursModal();
  }
});
