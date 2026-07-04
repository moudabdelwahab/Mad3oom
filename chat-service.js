/**
 * خدمة الدردشة المباشرة - Backend Service
 * تدير المحادثات والرسائل والتقييمات وأوقات العمل
 */

/**
 * ناقل أحداث بسيط (Event Emitter) قائم على EventTarget، يُستخدم لإخطار
 * الويدجت لدى العميل ولوحة الإدارة بأحداث مثل انضمام/مغادرة موظف الدعم
 * للمحادثة. في نسخة إنتاج حقيقية سيُستبدل هذا بـ WebSocket/Server-Sent Events.
 */
class ChatEventEmitter extends EventTarget {
  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
  on(type, callback) {
    this.addEventListener(type, (e) => callback(e.detail));
  }
}

if (typeof window !== 'undefined' && !window.chatEventEmitter) {
  window.chatEventEmitter = new ChatEventEmitter();
}

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
    // يتتبّع أي موظف دعم منضم حالياً لكل محادثة: conversationId -> { adminId, adminName }
    this.conversationAdminPresence = new Map();
  }

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

  getDayName(dayOfWeek) {
    const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
    return days[dayOfWeek];
  }

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

    this.notifyAdmins('new_conversation', conversation);

    return conversation;
  }

  getConversation(conversationId) {
    return this.conversations.get(conversationId);
  }

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

    const conv = this.conversations.get(conversationId);
    if (conv) {
      conv.updatedAt = new Date();
      conv.messages = this.messages.get(conversationId);
    }

    this.notifyUsers(conversationId, 'new_message', message);

    return message;
  }

  getConversationMessages(conversationId) {
    return this.messages.get(conversationId) || [];
  }

  getLastMessage(conversationId) {
    const msgs = this.messages.get(conversationId) || [];
    return msgs.length > 0 ? msgs[msgs.length - 1].content : null;
  }

  closeConversation(conversationId, adminId) {
    const conv = this.conversations.get(conversationId);
    if (conv) {
      // إن كان هناك موظف دعم منضم، سجل مغادرته أولاً قبل إغلاق المحادثة
      if (this.conversationAdminPresence.has(conversationId)) {
        this.adminLeftConversation(conversationId, adminId);
      }
      conv.status = 'closed';
      conv.adminId = adminId;
      conv.closedAt = new Date();
      this.notifyUsers(conversationId, 'conversation_closed', { closedAt: conv.closedAt });
    }
    return conv;
  }

  /**
   * تعيين محادثة لموظف دعم — يُستخدم أيضاً كإشارة "انضم موظف الدعم للمحادثة"،
   * وتُبَث كحدث admin_joined حتى تعرضه واجهة العميل كـ"فلان انضم إلى المحادثة".
   */
  assignToAdmin(conversationId, adminId, adminName) {
    const conv = this.conversations.get(conversationId);
    if (conv) {
      conv.adminId = adminId;
      conv.updatedAt = new Date();
      const displayName = adminName || 'موظف الدعم';
      this.conversationAdminPresence.set(conversationId, { adminId, adminName: displayName });
      this.notifyUsers(conversationId, 'admin_assigned', { adminId, adminName: displayName });
      this.notifyGlobal('admin_joined', { conversationId, adminId, adminName: displayName });
    }
    return conv;
  }

  /**
   * تسجيل خروج/مغادرة موظف الدعم للمحادثة (بدون إغلاقها بالضرورة) — تُبَث
   * كحدث admin_left حتى تعرضه واجهة العميل كـ"فلان غادر المحادثة".
   */
  adminLeftConversation(conversationId, adminId) {
    const conv = this.conversations.get(conversationId);
    const presence = this.conversationAdminPresence.get(conversationId);
    if (conv && presence) {
      this.conversationAdminPresence.delete(conversationId);
      this.notifyUsers(conversationId, 'admin_left', { adminId: adminId || presence.adminId, adminName: presence.adminName });
      this.notifyGlobal('admin_left', { conversationId, adminId: adminId || presence.adminId, adminName: presence.adminName });
    }
    return conv;
  }

  getAdminPresence(conversationId) {
    return this.conversationAdminPresence.get(conversationId) || null;
  }

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

  getRatingStats() {
    const stats = { happy: 0, neutral: 0, unhappy: 0, total: 0 };

    for (const [, rating] of this.ratings) {
      if (rating.rating === 'happy') stats.happy++;
      else if (rating.rating === 'neutral') stats.neutral++;
      else if (rating.rating === 'unhappy') stats.unhappy++;
      stats.total++;
    }

    return stats;
  }

  getSuggestedQuestions() {
    return this.suggestedQuestions;
  }

  getWorkHours() {
    return Object.values(this.workHours);
  }

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

  registerAdmin(adminId, socketId) {
    this.activeAdmins.set(adminId, {
      id: adminId,
      socketId,
      connectedAt: new Date()
    });
  }

  unregisterAdmin(adminId) {
    this.activeAdmins.delete(adminId);
  }

  getActiveAdmins() {
    return Array.from(this.activeAdmins.values());
  }

  notifyAdmins(eventType, data) {
    if (typeof window !== 'undefined' && window.chatEventEmitter) {
      window.chatEventEmitter.emit(`admin:${eventType}`, data);
    }
  }

  notifyUsers(conversationId, eventType, data) {
    if (typeof window !== 'undefined' && window.chatEventEmitter) {
      window.chatEventEmitter.emit(`conversation:${conversationId}:${eventType}`, data);
    }
  }

  /**
   * حدث عام غير مرتبط بمحادثة محددة سلفاً — يُستخدمه ChatWidget للاستماع
   * لأحداث انضمام/مغادرة الموظف دون معرفة معرّف المحادثة وقت الاشتراك.
   */
  notifyGlobal(eventType, data) {
    if (typeof window !== 'undefined' && window.chatEventEmitter) {
      window.chatEventEmitter.emit(`global:${eventType}`, data);
    }
  }
}

// تصدير الخدمة
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ChatService;
}

// إنشاء instance عام
const chatService = new ChatService();
