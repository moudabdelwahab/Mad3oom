const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);
const INTERACTIVE_TYPES = new Set(['interactive', 'button', 'template', 'reaction', 'contacts', 'location', 'order', 'system']);

export function normalizePhone(value = '') {
  return String(value || '').replace(/^whatsapp:/, '').replace(/\D/g, '');
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
  // Direct text fields
  const direct = message.message_text || message.text || message.body || message.caption || message.content || '';
  if (direct) return direct;

  // Extract from metadata (webhook payload stored as JSON)
  const meta = message.metadata || {};

  // Interactive messages (buttons, lists, OTP)
  if (meta.interactive) {
    const interactive = meta.interactive;
    const bodyText = interactive.body?.text || '';
    const headerText = interactive.header?.text || '';
    const footerText = interactive.footer?.text || '';
    const type = interactive.type || '';

    if (type === 'button_reply') return interactive.button_reply?.title || bodyText || 'رد على زر';
    if (type === 'list_reply') return interactive.list_reply?.title || bodyText || 'رد على قائمة';

    // Outbound interactive (button/list message)
    const parts = [];
    if (headerText) parts.push(headerText);
    if (bodyText) parts.push(bodyText);
    if (footerText) parts.push(footerText);
    return parts.join('\n') || 'رسالة تفاعلية';
  }

  // Button messages (reply buttons)
  if (meta.button) {
    return meta.button.text || meta.button.payload || 'رد على زر';
  }

  // Template messages
  if (meta.template) {
    const name = meta.template.name || '';
    const components = meta.template.components || [];
    const bodyComp = components.find(c => c.type === 'body' || c.type === 'BODY');
    const bodyText = bodyComp?.text || bodyComp?.parameters?.map(p => p.text || p.payload || '').join(' ') || '';
    return bodyText || (name ? `قالب: ${name}` : 'رسالة قالب');
  }

  // Reaction messages
  if (meta.reaction) {
    return `${meta.reaction.emoji || '👍'} تفاعل على رسالة`;
  }

  // Location messages
  if (meta.location) {
    return `📍 موقع: ${meta.location.name || meta.location.address || ''}`.trim();
  }

  // Contacts messages
  if (meta.contacts && Array.isArray(meta.contacts)) {
    const names = meta.contacts.map(c => c.name?.formatted_name || '').filter(Boolean);
    return `👤 جهة اتصال: ${names.join(', ')}` || 'جهة اتصال';
  }

  // System messages
  if (meta.system) {
    return meta.system.body || 'رسالة نظام';
  }

  // Order messages
  if (meta.order) {
    return `🛒 طلب شراء`;
  }

  return '';
}

export function getInteractivePayload(message) {
  const meta = message.metadata || {};
  if (!meta.interactive && !meta.button && !meta.template && !meta.reaction && !meta.location && !meta.contacts) return null;

  if (meta.interactive) {
    const interactive = meta.interactive;
    const itype = interactive.type || '';
    return {
      kind: 'interactive',
      subtype: itype,
      header: interactive.header || null,
      body: interactive.body?.text || '',
      footer: interactive.footer?.text || '',
      buttons: interactive.action?.buttons || [],
      sections: interactive.action?.sections || [],
      buttonReply: interactive.button_reply || null,
      listReply: interactive.list_reply || null,
    };
  }

  if (meta.button) {
    return { kind: 'button_reply', text: meta.button.text || '', payload: meta.button.payload || '' };
  }

  if (meta.template) {
    return { kind: 'template', name: meta.template.name || '', components: meta.template.components || [] };
  }

  if (meta.reaction) {
    return { kind: 'reaction', emoji: meta.reaction.emoji || '👍', messageId: meta.reaction.message_id || '' };
  }

  if (meta.location) {
    return { kind: 'location', ...meta.location };
  }

  if (meta.contacts) {
    return { kind: 'contacts', contacts: meta.contacts };
  }

  return null;
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
  const text = getMessageText(message);
  const interactive = getInteractivePayload(message);

  // Determine normalized type
  let normalizedType;
  if (MEDIA_TYPES.has(type)) {
    normalizedType = type;
  } else if (INTERACTIVE_TYPES.has(type) || interactive) {
    normalizedType = 'interactive';
  } else {
    normalizedType = 'text';
  }

  return {
    ...message,
    clientId: message.client_id || message.local_id || message.id || crypto.randomUUID(),
    direction,
    conversationPhone,
    timestamp,
    type: normalizedType,
    text,
    interactive,
    media: getMediaPayload(message),
    deliveryStatus: message.delivery_status || message.status || (direction === 'outbound' ? 'sent' : 'received'),
  };
}

export function isBusinessConversation(message, businessPhone = '') {
  const business = normalizePhone(businessPhone);
  if (!business) return false;
  const from = normalizePhone(message.from_number || message.from || message.sender_phone);
  const conversationPhone = normalizePhone(message.conversationPhone || getConversationPhone(message, businessPhone));
  return conversationPhone === business || (from === business && !normalizePhone(message.to_number || message.to || message.recipient_phone));
}

export function groupConversations(messages, businessPhone = '') {
  const map = new Map();
  messages.forEach((raw) => {
    const message = normalizeMessage(raw, businessPhone);
    if (!message.conversationPhone || isBusinessConversation(message, businessPhone)) return;
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
  const waIdMap = new Map(); // To link wa_message_id to clientId

  // First pass: Build a map of all messages using clientId as the primary key
  [...existingMessages, ...incomingMessages].forEach((raw) => {
    const normalized = normalizeMessage(raw, businessPhone);
    if (isBusinessConversation(normalized, businessPhone)) return;

    const clientId = normalized.client_id || normalized.local_id || normalized.clientId;
    const waId = normalized.wa_message_id || normalized.message_id || (normalized.id && String(normalized.id).startsWith('wamid.') ? normalized.id : null);

    let key = clientId;

    // If we have a WhatsApp ID, try to find if we already have a clientId for it
    if (waId) {
      if (waIdMap.has(waId)) {
        key = waIdMap.get(waId);
      } else if (clientId) {
        waIdMap.set(waId, clientId);
      } else {
        key = waId; // Fallback to waId if no clientId is available
      }
    }

    const existing = map.get(key) || {};
    
    // Merge logic: prefer newer data or specific fields
    const merged = { ...existing, ...normalized };
    
    // Ensure we don't lose the original clientId if it was already set
    if (clientId) merged.clientId = clientId;
    if (waId) merged.wa_message_id = waId;

    map.set(key, merged);
  });

  return [...map.values()].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}
