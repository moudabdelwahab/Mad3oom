/**
 * خدمة الدردشة المباشرة - Backend Service
 * تدير المحادثات والرسائل والتقييمات وأوقات العمل
 */

class ChatService {
  constructor() {
    this.conversations = new Map();
    this.messages = new Map();
    this.suggestedQuestions = [
      {
        id: 1,
        question: 'كيف أتحقق من رصيدي؟',
        answer: 'يمكنك التحقق من رصيدك بالذهاب إلى قسم المحفظة في حسابك الشخصي.',
        category: 'المحفظة'
      },
      {
        id: 2,
        question: 'كيف أحول النقاط إلى أموال؟',
        answer: 'يمكنك تحويل النقاط من خلال قسم السحب في إعدادات حسابك.',
        category: 'المحفظة'
      },
      {
        id: 3,
        question: 'كيف أتواصل مع الدعم الفني؟',
        answer: 'يمكنك التواصل مع فريق الدعم الفني من خلال هذه الواجهة مباشرة.',
        category: 'الدعم'
      },
      {
        id: 4,
        question: 'ما هي ساعات عمل الدعم؟',
        answer: 'يعمل فريق الدعم الفني من الساعة 9 صباحاً إلى الساعة 6 مساءً يومياً.',
        category: 'الدعم'
      },
      {
        id: 5,
        question: 'كيف أبلغ عن مشكلة؟',
        answer: 'يمكنك فتح تذكرة دعم من قسم المشاكل والاقتراحات في حسابك.',
        category: 'المشاكل'
      },
      {
        id: 6,
        question: 'هل هناك رسوم للتحويل؟',
        answer: 'لا توجد رسوم للتحويل بين المحافظ على المنصة.',
        category: 'المحفظة'
      }
    ];
    this.workHours = this.initializeWorkHours();
    this.ratings = new Map();
    this.activeAdmins = new Map();
  }

  /**
   * تهيئة أوقات العمل الافتراضية
   */
  initializeWorkHours() {
    const hours = {};
    const workDays = [0, 1, 2, 3, 4, 5]; // الأحد إلى الجمعة
    const offDay = 6; // السبت

    for (let day = 0; day < 7; day++) {
      hours[day] = {
        dayOfWeek: day,
        startTime: '09:00',
        endTime: '18:00',
        isWorkDay: workDays.includes(day),
        dayName: this.getDayName(day)
      };
    }
    return hours;
  }

  /**
   * الحصول على اسم اليوم
   */
  getDayName(dayOfWeek) {
    const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
    return days[dayOfWeek];
  }

  /**
   * التحقق من ما إذا كانت ساعات العمل الحالية
   */
  isCurrentlyWorkingHours() {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const todayHours = this.workHours[dayOfWeek];
    if (!todayHours || !todayHours.isWorkDay) {
      return false;
    }

    return currentTime >= todayHours.startTime && currentTime <= todayHours.endTime;
  }

  /**
   * إنشاء محادثة جديدة
   */
  createConversation(userId, data) {
    const conversationId = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const isOutsideWorkHours = !this.isCurrentlyWorkingHours();

    const conversation = {
      id: conversationId,
      userId,
      adminId: null,
      status: 'active',
      subject: data.subject || 'استفسار عام',
      isOutsideWorkHours,
      customerName: data.customerName,
      customerPhone: data.customerPhone,
      customerEmail: data.customerEmail,
      createdAt: new Date(),
      updatedAt: new Date(),
      closedAt: null,
      messages: []
    };

    this.conversations.set(conversationId, conversation);
    this.messages.set(conversationId, []);

    // إرسال إشعار للمسؤولين
    this.notifyAdmins('new_conversation', conversation);

    return conversation;
  }

  /**
   * الحصول على محادثة
   */
  getConversation(conversationId) {
    return this.conversations.get(conversationId);
  }

  /**
   * الحصول على محادثات المستخدم
   */
  getUserConversations(userId) {
    const userConversations = [];
    for (const [id, conv] of this.conversations) {
      if (conv.userId === userId) {
        userConversations.push({
          ...conv,
          messageCount: (this.messages.get(id) || []).length,
          lastMessage: this.getLastMessage(id)
        });
      }
    }
    return userConversations.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * الحصول على المحادثات النشطة
   */
  getActiveConversations() {
    const active = [];
    for (const [id, conv] of this.conversations) {
      if (conv.status === 'active') {
        active.push({
          ...conv,
          messageCount: (this.messages.get(id) || []).length,
          lastMessage: this.getLastMessage(id)
        });
      }
    }
    return active.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * الحصول على المحادثات المغلقة
   */
  getClosedConversations() {
    const closed = [];
    for (const [id, conv] of this.conversations) {
      if (conv.status === 'closed') {
        closed.push({
          ...conv,
          messageCount: (this.messages.get(id) || []).length,
          rating: this.ratings.get(id)
        });
      }
    }
    return closed.sort((a, b) => b.closedAt - a.closedAt);
  }

  /**
   * إضافة رسالة
   */
  addMessage(conversationId, senderId, senderType, content) {
    const message = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      conversationId,
      senderId,
      senderType, // 'customer' أو 'admin'
      content,
      createdAt: new Date()
    };

    if (!this.messages.has(conversationId)) {
      this.messages.set(conversationId, []);
    }

    this.messages.get(conversationId).push(message);

    // تحديث وقت آخر تحديث للمحادثة
    const conv = this.conversations.get(conversationId);
    if (conv) {
      conv.updatedAt = new Date();
      conv.messages = this.messages.get(conversationId);
    }

    // إرسال إشعار
    this.notifyUsers(conversationId, 'new_message', message);

    return message;
  }

  /**
   * الحصول على رسائل المحادثة
   */
  getConversationMessages(conversationId) {
    return this.messages.get(conversationId) || [];
  }

  /**
   * الحصول على آخر رسالة
   */
  getLastMessage(conversationId) {
    const msgs = this.messages.get(conversationId) || [];
    return msgs.length > 0 ? msgs[msgs.length - 1].content : null;
  }

  /**
   * إغلاق محادثة
   */
  closeConversation(conversationId, adminId) {
    const conv = this.conversations.get(conversationId);
    if (conv) {
      conv.status = 'closed';
      conv.adminId = adminId;
      conv.closedAt = new Date();
      this.notifyUsers(conversationId, 'conversation_closed', { closedAt: conv.closedAt });
    }
    return conv;
  }

  /**
   * تعيين محادثة لمسؤول
   */
  assignToAdmin(conversationId, adminId) {
    const conv = this.conversations.get(conversationId);
    if (conv) {
      conv.adminId = adminId;
      conv.updatedAt = new Date();
      this.notifyUsers(conversationId, 'admin_assigned', { adminId });
    }
    return conv;
  }

  /**
   * إضافة تقييم
   */
  addRating(conversationId, rating, feedback) {
    const ratingData = {
      id: `rating_${Date.now()}`,
      conversationId,
      rating, // 'happy', 'neutral', 'unhappy'
      feedback,
      createdAt: new Date()
    };

    this.ratings.set(conversationId, ratingData);
    this.notifyAdmins('rating_added', ratingData);

    return ratingData;
  }

  /**
   * الحصول على إحصائيات التقييمات
   */
  getRatingStats() {
    const stats = {
      happy: 0,
      neutral: 0,
      unhappy: 0,
      total: 0
    };

    for (const [, rating] of this.ratings) {
      if (rating.rating === 'happy') stats.happy++;
      else if (rating.rating === 'neutral') stats.neutral++;
      else if (rating.rating === 'unhappy') stats.unhappy++;
      stats.total++;
    }

    return stats;
  }

  /**
   * الحصول على الأسئلة المقترحة
   */
  getSuggestedQuestions() {
    return this.suggestedQuestions;
  }

  /**
   * الحصول على أوقات العمل
   */
  getWorkHours() {
    return Object.values(this.workHours);
  }

  /**
   * تحديث أوقات العمل
   */
  updateWorkHours(dayOfWeek, startTime, endTime, isWorkDay) {
    this.workHours[dayOfWeek] = {
      dayOfWeek,
      startTime,
      endTime,
      isWorkDay,
      dayName: this.getDayName(dayOfWeek)
    };
    this.notifyAdmins('work_hours_updated', this.workHours[dayOfWeek]);
    return this.workHours[dayOfWeek];
  }

  /**
   * تسجيل مسؤول نشط
   */
  registerAdmin(adminId, socketId) {
    this.activeAdmins.set(adminId, {
      id: adminId,
      socketId,
      connectedAt: new Date()
    });
  }

  /**
   * إلغاء تسجيل مسؤول
   */
  unregisterAdmin(adminId) {
    this.activeAdmins.delete(adminId);
  }

  /**
   * الحصول على المسؤولين النشطين
   */
  getActiveAdmins() {
    return Array.from(this.activeAdmins.values());
  }

  /**
   * إرسال إشعار للمسؤولين
   */
  notifyAdmins(eventType, data) {
    // سيتم تنفيذه من خلال WebSocket أو Server-Sent Events
    if (window.chatEventEmitter) {
      window.chatEventEmitter.emit(`admin:${eventType}`, data);
    }
  }

  /**
   * إرسال إشعار للمستخدمين
   */
  notifyUsers(conversationId, eventType, data) {
    // سيتم تنفيذه من خلال WebSocket أو Server-Sent Events
    if (window.chatEventEmitter) {
      window.chatEventEmitter.emit(`conversation:${conversationId}:${eventType}`, data);
    }
  }
}

// تصدير الخدمة
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ChatService;
}

// إنشاء instance عام
const chatService = new ChatService();
