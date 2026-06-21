import { SupabaseMessageHelper } from './supabase-message-helper.js';
import { SharedInboxService } from './shared-inbox-service.js';

/**
 * Inbox Integration Service
 * يدمج نظام الرسائل الحالي مع نظام Shared Inbox
 */

export class InboxIntegration {
  /**
   * معالجة رسالة واردة جديدة وإضافتها إلى Shared Inbox
   */
  static async handleIncomingMessage(message) {
    try {
      // 1. حفظ الرسالة في جدول الرسائل
      const savedMessage = await SupabaseMessageHelper.saveMessage({
        ...message,
        direction: 'inbound',
        status: 'received',
        timestamp: message.timestamp || new Date().toISOString(),
      });

      // 2. البحث عن محادثة موجودة أو إنشاء واحدة جديدة
      const supabase = await SharedInboxService.client();
      const userId = await SharedInboxService.currentUserId();

      if (!userId) return savedMessage;

      const { data: existingConv } = await supabase
        .from('shared_inbox_conversations')
        .select('id')
        .eq('user_id', userId)
        .eq('phone_number', message.from_number)
        .maybeSingle();

      let conversation;
      if (existingConv) {
        // تحديث المحادثة الموجودة
        conversation = await supabase
          .from('shared_inbox_conversations')
          .update({
            last_message: message.message_text,
            last_message_at: message.timestamp || new Date().toISOString(),
            unread_count: (existingConv.unread_count || 0) + 1,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existingConv.id)
          .select()
          .single();
      } else {
        // إنشاء محادثة جديدة
        conversation = await SharedInboxService.createConversation(message);
      }

      // 3. تسجيل النشاط
      if (conversation.data?.id) {
        await this.logActivity(conversation.data.id, null, 'message_received', {
          message_id: savedMessage.id,
          text: message.message_text,
        });
      }

      return savedMessage;
    } catch (error) {
      console.error('[InboxIntegration] Error handling incoming message:', error);
      throw error;
    }
  }

  /**
   * معالجة رسالة صادرة جديدة من لوحة التحكم
   */
  static async handleOutgoingMessage(conversationId, messageText, agentId) {
    try {
      const supabase = await SharedInboxService.client();
      const userId = await SharedInboxService.currentUserId();

      if (!userId) throw new Error('User not authenticated');

      // 1. جلب تفاصيل المحادثة
      const { data: conversation, error: convError } = await supabase
        .from('shared_inbox_conversations')
        .select('*')
        .eq('id', conversationId)
        .eq('user_id', userId)
        .single();

      if (convError || !conversation) {
        throw new Error('Conversation not found');
      }

      // 2. حفظ الرسالة في جدول الرسائل
      const savedMessage = await SupabaseMessageHelper.saveMessage({
        user_id: userId,
        from_number: conversation.phone_number, // يجب أن يكون رقم الشركة
        to_number: conversation.phone_number,
        message_text: messageText,
        direction: 'outbound',
        status: 'sent',
        timestamp: new Date().toISOString(),
      });

      // 3. تحديث المحادثة
      await supabase
        .from('shared_inbox_conversations')
        .update({
          last_message: messageText,
          last_message_at: new Date().toISOString(),
          unread_count: 0,
          updated_at: new Date().toISOString(),
        })
        .eq('id', conversationId);

      // 4. تسجيل النشاط
      await this.logActivity(conversationId, agentId, 'message_sent', {
        message_id: savedMessage.id,
        text: messageText,
      });

      return savedMessage;
    } catch (error) {
      console.error('[InboxIntegration] Error handling outgoing message:', error);
      throw error;
    }
  }

  /**
   * تسجيل نشاط في سجل النشاط
   */
  static async logActivity(conversationId, agentId, action, details = null) {
    try {
      const supabase = await SharedInboxService.client();

      await supabase
        .from('shared_inbox_activity_log')
        .insert({
          conversation_id: conversationId,
          agent_id: agentId,
          action,
          details: details ? JSON.stringify(details) : null,
        });
    } catch (error) {
      console.error('[InboxIntegration] Error logging activity:', error);
      // Don't throw - activity logging shouldn't break the main flow
    }
  }

  /**
   * تحديث حالة المحادثة وتسجيل النشاط
   */
  static async updateConversationStatus(conversationId, status, agentId) {
    try {
      await SharedInboxService.updateConversationStatus(conversationId, status);
      await this.logActivity(conversationId, agentId, 'status_changed', { status });
    } catch (error) {
      console.error('[InboxIntegration] Error updating conversation status:', error);
      throw error;
    }
  }

  /**
   * تعيين محادثة لوكيل وتسجيل النشاط
   */
  static async assignConversationToAgent(conversationId, agentId, assignedBy) {
    try {
      await SharedInboxService.assignConversation(conversationId, agentId);
      await this.logActivity(conversationId, assignedBy, 'assigned', { agent_id: agentId });
    } catch (error) {
      console.error('[InboxIntegration] Error assigning conversation:', error);
      throw error;
    }
  }

  /**
   * إضافة ملاحظة وتسجيل النشاط
   */
  static async addNoteWithLog(conversationId, content, agentId) {
    try {
      const note = await SharedInboxService.addNote(conversationId, content);
      await this.logActivity(conversationId, agentId, 'note_added', { note_id: note.id });
      return note;
    } catch (error) {
      console.error('[InboxIntegration] Error adding note:', error);
      throw error;
    }
  }

  /**
   * إضافة وسم وتسجيل النشاط
   */
  static async addTagWithLog(conversationId, tagName, agentId) {
    try {
      const tag = await SharedInboxService.addTag(conversationId, tagName);
      await this.logActivity(conversationId, agentId, 'tag_added', { tag_name: tagName });
      return tag;
    } catch (error) {
      console.error('[InboxIntegration] Error adding tag:', error);
      throw error;
    }
  }

  /**
   * تسجيل قراءة المحادثة
   */
  static async markConversationAsRead(conversationId, agentId) {
    try {
      await SharedInboxService.markAsRead(conversationId, agentId);
      await SharedInboxService.updateUnreadCount(conversationId, 0);
      await this.logActivity(conversationId, agentId, 'conversation_read', {});
    } catch (error) {
      console.error('[InboxIntegration] Error marking as read:', error);
      throw error;
    }
  }

  /**
   * جلب إحصائيات الصندوق
   */
  static async getInboxStats() {
    try {
      return await SharedInboxService.getStats();
    } catch (error) {
      console.error('[InboxIntegration] Error getting stats:', error);
      return {
        total: 0,
        open: 0,
        pending: 0,
        closed: 0,
        unread: 0,
      };
    }
  }

  /**
   * جلب المحادثات مع تصفية متقدمة
   */
  static async getFilteredConversations(filters = {}) {
    try {
      const { status, agentId, search, limit = 50, offset = 0 } = filters;

      let conversations;

      if (search) {
        conversations = await SharedInboxService.searchConversations(search);
      } else if (status) {
        conversations = await SharedInboxService.filterByStatus(status);
      } else if (agentId) {
        conversations = await SharedInboxService.filterByAgent(agentId);
      } else {
        conversations = await SharedInboxService.getConversations({ limit, offset });
      }

      return conversations;
    } catch (error) {
      console.error('[InboxIntegration] Error getting filtered conversations:', error);
      return [];
    }
  }

  /**
   * جلب تفاصيل المحادثة الكاملة
   */
  static async getConversationDetails(conversationId) {
    try {
      const conversation = await SharedInboxService.getConversation(conversationId);
      const notes = await SharedInboxService.getNotes(conversationId);
      const tags = await SharedInboxService.getTags(conversationId);
      const readers = await SharedInboxService.getReaders(conversationId);

      return {
        conversation,
        notes,
        tags,
        readers,
      };
    } catch (error) {
      console.error('[InboxIntegration] Error getting conversation details:', error);
      return null;
    }
  }

  /**
   * الحصول على نشاط المحادثة
   */
  static async getConversationActivity(conversationId, limit = 50) {
    try {
      const supabase = await SharedInboxService.client();

      const { data, error } = await supabase
        .from('shared_inbox_activity_log')
        .select('*, agent:agent_id(id, name, email)')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw new Error(error.message);
      return data || [];
    } catch (error) {
      console.error('[InboxIntegration] Error getting activity:', error);
      return [];
    }
  }
}
