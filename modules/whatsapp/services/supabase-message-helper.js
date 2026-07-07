import { SupabaseIntegration } from '../supabase-integration.js';

const TABLE = 'messages';
// ملاحظة: هذه القائمة يجب أن تطابق أعمدة جدول public.messages الفعلية في Supabase.
// لا يوجد عمود media_id أو media_url أو metadata في الجدول - الأعمدة الصحيحة هي
// file_url و attachment_type و raw_data (jsonb). أي اسم عمود غير موجود يتسبب في
// فشل عملية insert/update بالكامل (وليس فقط تجاهل الحقل)، فيسقط الكود لمحاولة
// أضعف تفقد معلومات المرفق كلها.
const FULL_INSERT_COLUMNS = [
  'user_id', 'from_number', 'to_number', 'message_text', 'message_type',
  'direction', 'status', 'delivery_status', 'timestamp', 'file_url',
  'attachment_type', 'mime_type', 'file_name', 'file_size', 'wa_message_id',
  'client_id', 'raw_data', 'read_at',
];
const REQUIRED_OUTBOUND_COLUMNS = [
  'user_id', 'from_number', 'to_number', 'message_text', 'message_type',
  'direction', 'status', 'delivery_status', 'timestamp', 'file_url',
  'attachment_type', 'mime_type', 'file_name', 'file_size', 'wa_message_id',
  'client_id',
];
const LEGACY_COLUMNS = ['user_id', 'from_number', 'to_number', 'message_text', 'timestamp'];

function pick(object, keys) {
  return keys.reduce((result, key) => {
    if (object[key] !== undefined) result[key] = object[key];
    return result;
  }, {});
}

// يحوّل الحقول القديمة/غير المطابقة (media_url, media_id, metadata, type) إلى
// أسماء الأعمدة الحقيقية في جدول messages قبل أي إدخال أو تحديث.
function normalizeRowForDb(message) {
  const row = { ...message };

  if (row.media_url && !row.file_url) row.file_url = row.media_url;
  if (row.media && row.media.url && !row.file_url) row.file_url = row.media.url;

  if (!row.attachment_type && row.type && row.type !== 'text') {
    row.attachment_type = row.type;
  }

  // لا يوجد عمود media_id في الجدول، فنحتفظ به داخل raw_data (jsonb) كمرجع فقط.
  const extraMeta = { ...(row.metadata || {}) };
  if (row.media_id) extraMeta.media_id = row.media_id;
  if (Object.keys(extraMeta).length) row.raw_data = { ...(row.raw_data || {}), ...extraMeta };

  delete row.media_url;
  delete row.media_id;
  delete row.metadata;
  delete row.media;
  delete row.type;

  return row;
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
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (error) throw new Error(error.message || 'تعذر جلب الرسائل من Supabase.');
    
    // Return messages sorted ascending for the UI
    return (data || []).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  }

  static async saveMessage(message) {
    // TODO: Save inbound/outbound messages in Supabase here after webhook receive or Graph API send succeeds.
    const supabase = await this.client();
    const userId = await this.currentUserId();
    if (!userId) return { ...message, id: message.client_id };

    const row = normalizeRowForDb({ user_id: userId, ...message });
    
    // Try to update existing message first (by client_id or wa_message_id)
    if (message.client_id || message.wa_message_id) {
      const { data: existing } = await supabase
        .from(TABLE)
        .select('id')
        .eq('user_id', userId)
        .or(`client_id.eq.${message.client_id || 'null'},wa_message_id.eq.${message.wa_message_id || 'null'}`)
        .maybeSingle();
      
      if (existing) {
        // Update existing message
        const payload = pick(row, FULL_INSERT_COLUMNS);
        const { data, error } = await supabase
          .from(TABLE)
          .update(payload)
          .eq('id', existing.id)
          .select()
          .single();
        
        if (!error) return data;
      }
    }

    // Insert new message if not found
    const attempts = [FULL_INSERT_COLUMNS, REQUIRED_OUTBOUND_COLUMNS, LEGACY_COLUMNS];
    let lastError = null;
    let savedData = null;

    for (const columns of attempts) {
      const payload = pick(row, columns);
      const { data, error } = await supabase.from(TABLE).insert(payload).select().single();
      if (!error) {
        savedData = data;
        break;
      }
      lastError = error;
    }

    if (savedData) {
      // إذا كانت الرسالة واردة، نحدث last_inbound_message_at في bot_user_states
      if (savedData.direction === 'inbound') {
        try {
          await supabase
            .from('bot_user_states')
            .upsert({
              user_id: userId,
              phone_number: savedData.from_number,
              last_inbound_message_at: savedData.timestamp,
              last_interaction: savedData.timestamp
            }, { onConflict: 'user_id, phone_number' });
        } catch (updateError) {
          console.error('[SupabaseMessageHelper] Failed to update last_inbound_message_at:', updateError);
        }
      }
      return savedData;
    }

    throw new Error(lastError?.message || 'تعذر حفظ الرسالة داخل Supabase.');
  }

  static async markConversationRead(phone) {
    const supabase = await this.client();
    const userId = await this.currentUserId();
    if (!userId || !phone) return;

    const { error } = await supabase
      .from(TABLE)
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('from_number', phone)
      .is('read_at', null);
      
    if (error) {
      console.error('[SupabaseMessageHelper] Error marking conversation as read:', error);
    }
  }

  static async uploadFilePlaceholder() {
    // TODO: If local file storage is required, upload files to Supabase Storage here before/after Graph API media upload.
    return null;
  }
}
