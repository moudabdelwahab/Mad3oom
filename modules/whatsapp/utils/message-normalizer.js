const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);

export function normalizePhone(value = '') {
  return String(value || '').replace(/^whatsapp:/, '').replace(/[^\d+]/g, '');
}

export function getMessageTimestamp(message) {
  return message.timestamp || message.created_at || message.updated_at || message.received_at || new Date().toISOString();
}

export function getMessageType(message) {
  return message.message_type || message.type || message.media_type || (message.media_url ? 'document' : 'text');
}

export function getMessageDirection(message, businessPhone = '') {
  if (message.direction) return message.direction;
  if (message.is_outbound === true || message.status === 'sending') return 'outbound';
  if (message.is_outbound === false) return 'inbound';
  const from = normalizePhone(message.from_number || message.from || message.sender_phone);
  const business = normalizePhone(businessPhone);
  return business && from === business ? 'outbound' : 'inbound';
}

export function getConversationPhone(message, businessPhone = '') {
  const direction = getMessageDirection(message, businessPhone);
  const from = normalizePhone(message.from_number || message.from || message.sender_phone || message.phone_number);
  const to = normalizePhone(message.to_number || message.to || message.recipient_phone || message.phone_number);
  return direction === 'outbound' ? (to || from) : (from || to);
}

export function getMessageText(message) {
  return message.message_text || message.text || message.body || message.caption || message.content || '';
}

export function getMediaPayload(message) {
  const metadata = message.metadata || {};
  return {
    id: message.media_id || metadata.media_id || message.whatsapp_media_id || null,
    url: message.media_url || metadata.media_url || message.file_url || null,
    name: message.file_name || metadata.file_name || metadata.filename || 'ملف',
    mimeType: message.mime_type || metadata.mime_type || '',
    size: message.file_size || metadata.file_size || null,
  };
}

export function normalizeMessage(message, businessPhone = '') {
  const type = getMessageType(message);
  const timestamp = getMessageTimestamp(message);
  const direction = getMessageDirection(message, businessPhone);
  const conversationPhone = getConversationPhone(message, businessPhone);
  return {
    ...message,
    clientId: message.client_id || message.local_id || message.id || crypto.randomUUID(),
    direction,
    conversationPhone,
    timestamp,
    type: MEDIA_TYPES.has(type) ? type : 'text',
    text: getMessageText(message),
    media: getMediaPayload(message),
    deliveryStatus: message.delivery_status || message.status || (direction === 'outbound' ? 'sent' : 'received'),
  };
}

export function groupConversations(messages, businessPhone = '') {
  const map = new Map();
  messages.forEach((raw) => {
    const message = normalizeMessage(raw, businessPhone);
    if (!message.conversationPhone) return;
    const existing = map.get(message.conversationPhone) || {
      phone: message.conversationPhone,
      messages: [],
      unread: 0,
      lastMessage: null,
    };
    existing.messages.push(message);
    if (message.direction === 'inbound' && !message.read_at) existing.unread += 1;
    if (!existing.lastMessage || new Date(message.timestamp) > new Date(existing.lastMessage.timestamp)) {
      existing.lastMessage = message;
    }
    map.set(message.conversationPhone, existing);
  });

  return [...map.values()]
    .map((conversation) => ({
      ...conversation,
      messages: conversation.messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)),
    }))
    .sort((a, b) => new Date(b.lastMessage?.timestamp || 0) - new Date(a.lastMessage?.timestamp || 0));
}

export function mergeMessages(existingMessages, incomingMessages, businessPhone = '') {
  const map = new Map();
  [...existingMessages, ...incomingMessages].forEach((message) => {
    const normalized = normalizeMessage(message, businessPhone);
    const key = normalized.client_id || normalized.local_id || normalized.clientId || normalized.wa_message_id || normalized.message_id || normalized.id;
    map.set(key, { ...(map.get(key) || {}), ...normalized });
  });
  return [...map.values()].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}
