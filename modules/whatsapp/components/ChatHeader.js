import { escapeHtml, phoneInitial } from '../utils/dom.js';

export class ChatHeader {
  constructor(root) { this.root = root; }
  render(conversation, { realtimeStatus = 'SUBSCRIBED', typing = false } = {}) {
    if (!conversation) {
      this.root.innerHTML = '<div class="wa-chat-placeholder-title">اختر محادثة للبدء</div>';
      return;
    }
    this.root.innerHTML = `
      <div class="wa-chat-avatar">${escapeHtml(phoneInitial(conversation.phone))}</div>
      <div class="wa-chat-title">
        <strong>${escapeHtml(conversation.phone)}</strong>
        <span>${typing ? 'يكتب الآن...' : realtimeStatus === 'SUBSCRIBED' ? 'متصل لحظياً' : 'جاري الاتصال...'}</span>
      </div>
      <div class="wa-chat-actions">
        <button class="wa-icon-action" data-refresh title="تحديث">↻</button>
      </div>
    `;
  }
}
