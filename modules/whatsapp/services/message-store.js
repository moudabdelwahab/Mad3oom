import { SupabaseIntegration } from '../supabase-integration.js';

const FULL_INSERT_COLUMNS = ['user_id','from_number','to_number','message_text','message_type','direction','status','delivery_status','timestamp','media_id','media_url','mime_type','file_name','file_size','wa_message_id','client_id','metadata'];
const MINIMAL_INSERT_COLUMNS = ['user_id','from_number','to_number','message_text','timestamp'];

function pick(object, keys) {
  return keys.reduce((result, key) => {
    if (object[key] !== undefined) result[key] = object[key];
    return result;
  }, {});
}

export class MessageStore {
  static async getMessages() {
    const supabase = await SupabaseIntegration.initializeSupabase();
    const userId = await SupabaseIntegration.getCurrentUserId();
    if (!userId) return [];

    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('user_id', userId)
      .order('timestamp', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true, nullsFirst: false })
      .limit(1000);

    if (error) throw new Error(error.message || 'تعذر تحميل الرسائل.');
    return data || [];
  }

  static async saveOutgoing(message) {
    const supabase = await SupabaseIntegration.initializeSupabase();
    const userId = await SupabaseIntegration.getCurrentUserId();
    if (!userId) return { ...message, id: message.client_id };

    const row = { user_id: userId, ...message };
    const fullPayload = pick(row, FULL_INSERT_COLUMNS);
    let response = await supabase.from('messages').insert(fullPayload).select().single();

    if (response.error) {
      const fallback = pick(row, MINIMAL_INSERT_COLUMNS);
      response = await supabase.from('messages').insert(fallback).select().single();
    }

    if (response.error) throw new Error(response.error.message || 'تعذر حفظ الرسالة محلياً.');
    return response.data;
  }

  static async markConversationRead(phone) {
    const supabase = await SupabaseIntegration.initializeSupabase();
    const userId = await SupabaseIntegration.getCurrentUserId();
    if (!userId || !phone) return;
    await supabase
      .from('messages')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('from_number', phone)
      .is('read_at', null);
  }
}
