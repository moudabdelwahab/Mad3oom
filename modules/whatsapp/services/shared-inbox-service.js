import { SupabaseIntegration } from '../supabase-integration.js';

/**
 * Shared Inbox Service
 * يدير المحادثات المشتركة بين الوكلاء مع دعم:
 * - Assign Conversation
 * - Internal Notes
 * - Tags
 * - Conversation Status
 * - Read Receipts
 */

const TABLE_CONVERSATIONS = 'shared_inbox_conversations';
const TABLE_CONVERSATION_NOTES = 'shared_inbox_notes';
const TABLE_CONVERSATION_READERS = 'shared_inbox_readers';
const TABLE_CONVERSATION_TAGS = 'shared_inbox_tags';

export class SharedInboxService {
  static async client() {
    return SupabaseIntegration.initializeSupabase();
  }

  static async currentUserId() {
    return SupabaseIntegration.getCurrentUserId();
  }

  // ═══════════════════════════════════════
  // CONVERSATIONS
  // ═══════════════════════════════════════

  /**
   * جلب جميع المحادثات للمستخدم الحالي
   */
  static async getConversations({ limit = 100, offset = 0 } = {}) {
    const supabase = await this.client();
    const userId = await this.currentUserId();
    if (!userId) return [];

    const { data, error } = await supabase
      .from(TABLE_CONVERSATIONS)
      .select(`
        *,
        assigned_agent:assigned_to(id, name, email),
        tags:shared_inbox_tags(id, name),
        notes:shared_inbox_notes(id, content, created_by, created_at),
        readers:shared_inbox_readers(id, agent_id, read_at)
      `)
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw new Error(error.message || 'تعذر جلب المحادثات');
    return data || [];
  }

  /**
   * جلب محادثة واحدة بالتفاصيل الكاملة
   */
  static async getConversation(conversationId) {
    const supabase = await this.client();
    const userId = await this.currentUserId();
    if (!userId) return null;

    const { data, error } = await supabase
      .from(TABLE_CONVERSATIONS)
      .select(`
        *,
        assigned_agent:assigned_to(id, name, email),
        tags:shared_inbox_tags(id, name),
        notes:shared_inbox_notes(id, content, created_by, created_at),
        readers:shared_inbox_readers(id, agent_id, read_at)
      `)
      .eq('id', conversationId)
      .eq('user_id', userId)
      .single();

    if (error) throw new Error(error.message || 'تعذر جلب المحادثة');
    return data;
  }

  /**
   * إنشاء محادثة جديدة من رسالة واردة
   */
  static async createConversation(message) {
    const supabase = await this.client();
    const userId = await this.currentUserId();
    if (!userId) return null;

    const { data, error } = await supabase
      .from(TABLE_CONVERSATIONS)
      .insert({
        user_id: userId,
        phone_number: message.from_number,
        last_message: message.message_text,
        last_message_at: message.timestamp,
        status: 'open',
        unread_count: 1,
        assigned_to: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw new Error(error.message || 'تعذر إنشاء المحادثة');
    return data;
  }

  /**
   * تحديث حالة المحادثة
   */
  static async updateConversationStatus(conversationId, status) {
    const supabase = await this.client();
    const userId = await this.currentUserId();
    if (!userId) return null;

    const { data, error } = await supabase
      .from(TABLE_CONVERSATIONS)
      .update({
        status,
        updated_at: new Date().toISOString()
      })
      .eq('id', conversationId)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) throw new Error(error.message || 'تعذر تحديث الحالة');
    return data;
  }

  /**
   * تحديث عدد الرسائل غير المقروءة
   */
  static async updateUnreadCount(conversationId, count) {
    const supabase = await this.client();
    const userId = await this.currentUserId();
    if (!userId) return null;

    const { data, error } = await supabase
      .from(TABLE_CONVERSATIONS)
      .update({
        unread_count: count,
        updated_at: new Date().toISOString()
      })
      .eq('id', conversationId)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) throw new Error(error.message || 'تعذر تحديث العدد');
    return data;
  }

  // ═══════════════════════════════════════
  // ASSIGNMENT
  // ═══════════════════════════════════════

  /**
   * تعيين محادثة لوكيل
   */
  static async assignConversation(conversationId, agentId) {
    const supabase = await this.client();
    const userId = await this.currentUserId();
    if (!userId) return null;

    const { data, error } = await supabase
      .from(TABLE_CONVERSATIONS)
      .update({
        assigned_to: agentId,
        updated_at: new Date().toISOString()
      })
      .eq('id', conversationId)
      .eq('user_id', userId)
      .select('*, assigned_agent:assigned_to(id, name, email)')
      .single();

    if (error) throw new Error(error.message || 'تعذر التعيين');
    return data;
  }

  /**
   * إزالة التعيين من محادثة
   */
  static async unassignConversation(conversationId) {
    return this.assignConversation(conversationId, null);
  }

  // ═══════════════════════════════════════
  // INTERNAL NOTES
  // ═══════════════════════════════════════

  /**
   * إضافة ملاحظة داخلية
   */
  static async addNote(conversationId, content) {
    const supabase = await this.client();
    const userId = await this.currentUserId();
    if (!userId) return null;

    const { data, error } = await supabase
      .from(TABLE_CONVERSATION_NOTES)
      .insert({
        conversation_id: conversationId,
        content,
        created_by: userId,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw new Error(error.message || 'تعذر إضافة الملاحظة');
    return data;
  }

  /**
   * تحديث ملاحظة داخلية
   */
  static async updateNote(noteId, content) {
    const supabase = await this.client();

    const { data, error } = await supabase
      .from(TABLE_CONVERSATION_NOTES)
      .update({
        content,
        updated_at: new Date().toISOString()
      })
      .eq('id', noteId)
      .select()
      .single();

    if (error) throw new Error(error.message || 'تعذر تحديث الملاحظة');
    return data;
  }

  /**
   * حذف ملاحظة داخلية
   */
  static async deleteNote(noteId) {
    const supabase = await this.client();

    const { error } = await supabase
      .from(TABLE_CONVERSATION_NOTES)
      .delete()
      .eq('id', noteId);

    if (error) throw new Error(error.message || 'تعذر حذف الملاحظة');
  }

  /**
   * جلب جميع الملاحظات للمحادثة
   */
  static async getNotes(conversationId) {
    const supabase = await this.client();

    const { data, error } = await supabase
      .from(TABLE_CONVERSATION_NOTES)
      .select('*, created_by_agent:created_by(id, name, email)')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message || 'تعذر جلب الملاحظات');
    return data || [];
  }

  // ═══════════════════════════════════════
  // TAGS
  // ═══════════════════════════════════════

  /**
   * إضافة وسم للمحادثة
   */
  static async addTag(conversationId, tagName) {
    const supabase = await this.client();
    const userId = await this.currentUserId();
    if (!userId) return null;

    // Check if tag already exists
    const { data: existing } = await supabase
      .from(TABLE_CONVERSATION_TAGS)
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('name', tagName)
      .maybeSingle();

    if (existing) {
      throw new Error('الوسم موجود بالفعل');
    }

    const { data, error } = await supabase
      .from(TABLE_CONVERSATION_TAGS)
      .insert({
        conversation_id: conversationId,
        name: tagName,
        created_by: userId,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw new Error(error.message || 'تعذر إضافة الوسم');
    return data;
  }

  /**
   * حذف وسم من المحادثة
   */
  static async removeTag(tagId) {
    const supabase = await this.client();

    const { error } = await supabase
      .from(TABLE_CONVERSATION_TAGS)
      .delete()
      .eq('id', tagId);

    if (error) throw new Error(error.message || 'تعذر حذف الوسم');
  }

  /**
   * جلب جميع الوسوم للمحادثة
   */
  static async getTags(conversationId) {
    const supabase = await this.client();

    const { data, error } = await supabase
      .from(TABLE_CONVERSATION_TAGS)
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message || 'تعذر جلب الوسوم');
    return data || [];
  }

  // ═══════════════════════════════════════
  // READ RECEIPTS
  // ═══════════════════════════════════════

  /**
   * تسجيل قراءة المحادثة من قبل وكيل
   */
  static async markAsRead(conversationId, agentId) {
    const supabase = await this.client();

    const { data: existing } = await supabase
      .from(TABLE_CONVERSATION_READERS)
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('agent_id', agentId)
      .maybeSingle();

    if (existing) {
      // Update existing read record
      const { data, error } = await supabase
        .from(TABLE_CONVERSATION_READERS)
        .update({ read_at: new Date().toISOString() })
        .eq('id', existing.id)
        .select()
        .single();

      if (error) throw new Error(error.message);
      return data;
    }

    // Create new read record
    const { data, error } = await supabase
      .from(TABLE_CONVERSATION_READERS)
      .insert({
        conversation_id: conversationId,
        agent_id: agentId,
        read_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw new Error(error.message || 'تعذر تسجيل القراءة');
    return data;
  }

  /**
   * جلب قائمة من قرأ المحادثة
   */
  static async getReaders(conversationId) {
    const supabase = await this.client();

    const { data, error } = await supabase
      .from(TABLE_CONVERSATION_READERS)
      .select('*, agent:agent_id(id, name, email)')
      .eq('conversation_id', conversationId)
      .order('read_at', { ascending: false });

    if (error) throw new Error(error.message || 'تعذر جلب قائمة القراء');
    return data || [];
  }

  // ═══════════════════════════════════════
  // FILTERING & SEARCH
  // ═══════════════════════════════════════

  /**
   * البحث عن محادثات
   */
  static async searchConversations(query) {
    const supabase = await this.client();
    const userId = await this.currentUserId();
    if (!userId) return [];

    const { data, error } = await supabase
      .from(TABLE_CONVERSATIONS)
      .select('*')
      .eq('user_id', userId)
      .or(`phone_number.ilike.%${query}%,last_message.ilike.%${query}%`)
      .order('updated_at', { ascending: false });

    if (error) throw new Error(error.message || 'تعذر البحث');
    return data || [];
  }

  /**
   * تصفية المحادثات حسب الحالة
   */
  static async filterByStatus(status) {
    const supabase = await this.client();
    const userId = await this.currentUserId();
    if (!userId) return [];

    const { data, error } = await supabase
      .from(TABLE_CONVERSATIONS)
      .select('*')
      .eq('user_id', userId)
      .eq('status', status)
      .order('updated_at', { ascending: false });

    if (error) throw new Error(error.message || 'تعذر التصفية');
    return data || [];
  }

  /**
   * تصفية المحادثات حسب الوكيل المعين
   */
  static async filterByAgent(agentId) {
    const supabase = await this.client();
    const userId = await this.currentUserId();
    if (!userId) return [];

    const { data, error } = await supabase
      .from(TABLE_CONVERSATIONS)
      .select('*')
      .eq('user_id', userId)
      .eq('assigned_to', agentId)
      .order('updated_at', { ascending: false });

    if (error) throw new Error(error.message || 'تعذر التصفية');
    return data || [];
  }

  /**
   * جلب المحادثات غير المقروءة
   */
  static async getUnreadConversations() {
    const supabase = await this.client();
    const userId = await this.currentUserId();
    if (!userId) return [];

    const { data, error } = await supabase
      .from(TABLE_CONVERSATIONS)
      .select('*')
      .eq('user_id', userId)
      .gt('unread_count', 0)
      .order('updated_at', { ascending: false });

    if (error) throw new Error(error.message || 'تعذر جلب المحادثات');
    return data || [];
  }

  // ═══════════════════════════════════════
  // STATISTICS
  // ═══════════════════════════════════════

  /**
   * جلب إحصائيات صندوق الوارد
   */
  static async getStats() {
    const supabase = await this.client();
    const userId = await this.currentUserId();
    if (!userId) return {};

    const { data, error } = await supabase
      .from(TABLE_CONVERSATIONS)
      .select('status, unread_count')
      .eq('user_id', userId);

    if (error) throw new Error(error.message);

    const stats = {
      total: data?.length || 0,
      open: 0,
      pending: 0,
      closed: 0,
      unread: 0
    };

    data?.forEach(conv => {
      stats[conv.status] = (stats[conv.status] || 0) + 1;
      if (conv.unread_count > 0) stats.unread += conv.unread_count;
    });

    return stats;
  }
}
