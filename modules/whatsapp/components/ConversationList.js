import { escapeHtml, formatConversationTime, phoneInitial } from '../utils/dom.js';

function preview(message) {
  if (!message) return 'لا توجد رسائل';
  if (message.text) return message.text;
  if (message.type === 'interactive' || message.interactive) {
    const iv = message.interactive;
    if (!iv) return '💬 رسالة تفاعلية';
    if (iv.kind === 'button_reply') return `↩️ ${iv.text || 'رد على زر'}`;
    if (iv.kind === 'reaction') return `${iv.emoji} تفاعل`;
    if (iv.kind === 'location') return `📍 موقع`;
    if (iv.kind === 'contacts') return `👤 جهة اتصال`;
    if (iv.kind === 'template') return `📋 قالب: ${iv.name || ''}`;
    if (iv.body) return iv.body;
    return '💬 رسالة تفاعلية';
  }
  return { image: '📷 صورة', video: '🎬 فيديو', audio: '🎙️ رسالة صوتية', document: '📎 ملف', sticker: '💟 ملصق' }[message.type] || 'رسالة';
}

export class ConversationList {
  constructor(root, { onSelect } = {}) {
    this.root = root;
    this.onSelect = onSelect;
    this.conversations = [];
    this.activePhone = null;
  }

  render(conversations, activePhone) {
    this.conversations = conversations;
    this.activePhone = activePhone;
    if (!conversations.length) {
      this.root.innerHTML = '<div class="wa-empty-list">لا توجد محادثات بعد</div>';
      return;
    }

    this.root.innerHTML = conversations.map((item) => `
      <button class="wa-conversation ${item.phone === activePhone ? 'active' : ''}" data-phone="${escapeHtml(item.phone)}">
        <span class="wa-conversation-avatar">${escapeHtml(phoneInitial(item.phone))}</span>
        <span class="wa-conversation-body">
          <span class="wa-conversation-top">
            <strong>${escapeHtml(item.phone)}</strong>
            <time>${formatConversationTime(item.lastMessage?.timestamp)}</time>
          </span>
          <span class="wa-conversation-bottom">
            <span>${escapeHtml(preview(item.lastMessage))}</span>
            ${item.unread ? `<b class="wa-unread">${item.unread}</b>` : ''}
          </span>
        </span>
      </button>
    `).join('');

    this.root.querySelectorAll('[data-phone]').forEach((button) => {
      button.addEventListener('click', () => this.onSelect?.(button.dataset.phone));
    });
  }
}
