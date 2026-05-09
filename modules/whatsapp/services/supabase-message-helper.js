import { SupabaseIntegration } from '../supabase-integration.js';

const TABLE = 'messages';
const FULL_INSERT_COLUMNS = [
  'user_id', 'from_number', 'to_number', 'message_text', 'message_type',
  'direction', 'status', 'delivery_status', 'timestamp', 'media_id',
  'media_url', 'mime_type', 'file_name', 'file_size', 'wa_message_id',
  'client_id', 'metadata', 'read_at',
];
const REQUIRED_OUTBOUND_COLUMNS = [
  'user_id', 'from_number', 'to_number', 'message_text', 'direction',
  'status', 'timestamp',
];
const LEGACY_COLUMNS = ['user_id', 'from_number', 'to_number', 'message_text', 'timestamp'];

function pick(object, keys) {
  return keys.reduce((result, key) => {
    if (object[key] !== undefined) result[key] = object[key];
    return result;
  }, {});
}

export class SupabaseMessageHelper {
  static async client() {
    // TODO: Supabase initialization lives in SupabaseIntegration.initializeSupabase(); keep keys/config centralized there.
    return SupabaseIntegration.initializeSupabase();
  }

  static async currentUserId() {
    return SupabaseIntegration.getCurrentUserId();
  }

  static async fetchMessages({ limit = 1000 } = {}) {
    // TODO: Fetch WhatsApp messages from Supabase here; keep filters/RLS-compatible and user-scoped.
    const supabase = await this.client();
    const userId = await this.currentUserId();
    if (!userId) return [];

    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('user_id', userId)
      .order('timestamp', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true, nullsFirst: false })
      .limit(limit);

    if (error) throw new Error(error.message || 'تعذر جلب الرسائل من Supabase.');
    return data || [];
  }

  static async saveMessage(message) {
    // TODO: Save inbound/outbound messages in Supabase here after webhook receive or Graph API send succeeds.
    const supabase = await this.client();
    const userId = await this.currentUserId();
    if (!userId) return { ...message, id: message.client_id };

    const row = { user_id: userId, ...message };
    const attempts = [FULL_INSERT_COLUMNS, REQUIRED_OUTBOUND_COLUMNS, LEGACY_COLUMNS];
    let lastError = null;

    for (const columns of attempts) {
      const payload = pick(row, columns);
      const { data, error } = await supabase.from(TABLE).insert(payload).select().single();
      if (!error) return data;
      lastError = error;
    }

    throw new Error(lastError?.message || 'تعذر حفظ الرسالة داخل Supabase.');
  }

  static async markConversationRead(phone) {
    const supabase = await this.client();
    const userId = await this.currentUserId();
    if (!userId || !phone) return;

    await supabase
      .from(TABLE)
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('from_number', phone)
      .is('read_at', null);
  }

  static async uploadFilePlaceholder() {
    // TODO: If local file storage is required, upload files to Supabase Storage here before/after Graph API media upload.
    return null;
  }
}
