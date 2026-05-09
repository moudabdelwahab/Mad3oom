import { SupabaseMessageHelper } from './supabase-message-helper.js';

export class MessageStore {
  static async getMessages() {
    return SupabaseMessageHelper.fetchMessages({ limit: 1000 });
  }

  static async saveOutgoing(message) {
    return SupabaseMessageHelper.saveMessage({
      ...message,
      direction: 'outbound',
      status: message.status || 'sent',
      delivery_status: message.delivery_status || message.status || 'sent',
      timestamp: message.timestamp || new Date().toISOString(),
    });
  }

  static async markConversationRead(phone) {
    return SupabaseMessageHelper.markConversationRead(phone);
  }
}
