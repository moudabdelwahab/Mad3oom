import { ConversationList } from '../components/ConversationList.js';
import { ChatHeader } from '../components/ChatHeader.js';
import { MessageInput } from '../components/MessageInput.js';
import { MessageBubble } from '../components/MessageBubble.js';
import { MessageStore } from '../services/message-store.js';
import { WhatsAppAPI } from '../services/whatsapp-api.js';
import { MessageRealtime } from '../realtime/message-realtime.js';
import { groupConversations, mergeMessages, normalizeMessage } from '../utils/message-normalizer.js';

function inferMediaType(file) {
  if (file.type === 'image/webp' && file.name.toLowerCase().endsWith('.webp')) return 'sticker';
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'document';
}

export class InboxPage {
  constructor(root, { getBusinessPhone } = {}) {
    this.root = root;
    this.getBusinessPhone = getBusinessPhone;
    this.messages = [];
    this.conversations = [];
    this.activePhone = null;
    this.loadingRequestId = 0;
    this.realtimeStatus = 'CLOSED';
    this.realtime = new MessageRealtime({
      onMessage: (message) => this.handleRealtimeMessage(message),
      onStatus: (status) => { this.realtimeStatus = status; this.renderHeader(); },
      onError: () => window.Toast?.show?.('تعذر تشغيل التحديث اللحظي للرسائل', 'error'),
    });
  }

  mount() {
    this.root.innerHTML = `
      <section class="wa-inbox-shell">
        <aside class="wa-inbox-sidebar">
          <div class="wa-inbox-sidebar-head">
            <div><h2>Inbox</h2><p>كل المحادثات حسب رقم الهاتف</p></div>
            <button class="wa-icon-action" data-refresh>↻</button>
          </div>
          <div class="wa-search"><input data-search placeholder="بحث بالرقم أو نص الرسالة" /></div>
          <div class="wa-conversations" data-conversations><div class="wa-skeleton"></div></div>
        </aside>
        <main class="wa-chat-window">
          <header class="wa-chat-header" data-header></header>
          <div class="wa-chat-state" data-state hidden></div>
          <div class="wa-messages" data-messages></div>
          <div class="wa-typing" data-typing hidden>يتم تجهيز الرسالة...</div>
          <footer class="wa-composer" data-composer></footer>
        </main>
      </section>
    `;
    this.list = new ConversationList(this.root.querySelector('[data-conversations]'), { onSelect: (phone) => this.selectConversation(phone) });
    this.header = new ChatHeader(this.root.querySelector('[data-header]'));
    this.input = new MessageInput(this.root.querySelector('[data-composer]'), {
      onSendText: (text) => this.sendText(text),
      onSendFiles: (files, caption) => this.sendFiles(files, caption),
    });
    this.root.querySelectorAll('[data-refresh]').forEach((button) => button.addEventListener('click', () => this.load()));
    this.root.querySelector('[data-search]').addEventListener('input', (event) => this.renderList(event.target.value));
    this.input.render({ disabled: true });
    this.renderHeader();
    this.load();
    this.realtime.subscribe();
  }

  destroy() { this.realtime.unsubscribe(); }

  async load() {
    const requestId = ++this.loadingRequestId;
    this.setState('جاري تحميل المحادثات...', false);
    try {
      const data = await MessageStore.getMessages();
      if (requestId !== this.loadingRequestId) return;
      this.messages = mergeMessages([], data, this.getBusinessPhone?.());
      this.rebuildConversations();
      if (!this.activePhone && this.conversations[0]) this.activePhone = this.conversations[0].phone;
      this.render();
      this.setState('', true);
    } catch (error) {
      this.setState(error.message || 'تعذر تحميل الرسائل', false, true);
    }
  }

  rebuildConversations() {
    this.conversations = groupConversations(this.messages, this.getBusinessPhone?.());
  }

  render() {
    this.renderList();
    this.renderHeader();
    this.renderMessages();
    this.input.render({ disabled: !this.activePhone });
  }

  renderList(filter = '') {
    const query = filter.trim().toLowerCase();
    const items = query ? this.conversations.filter((conversation) => {
      return conversation.phone.includes(query) || conversation.messages.some((message) => (message.text || '').toLowerCase().includes(query));
    }) : this.conversations;
    this.list.render(items, this.activePhone);
  }

  renderHeader() {
    this.header?.render(this.getActiveConversation(), { realtimeStatus: this.realtimeStatus });
    this.root?.querySelector('[data-header] [data-refresh]')?.addEventListener('click', () => this.load());
  }

  renderMessages() {
    const container = this.root.querySelector('[data-messages]');
    const conversation = this.getActiveConversation();
    if (!conversation) {
      container.innerHTML = '<div class="wa-empty-chat">اختر محادثة من القائمة لعرض الرسائل.</div>';
      return;
    }
    container.innerHTML = conversation.messages.map((message) => MessageBubble(message)).join('');
    requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
  }

  async selectConversation(phone) {
    this.activePhone = phone;
    await MessageStore.markConversationRead(phone).catch(() => {});
    this.messages = this.messages.map((message) => message.conversationPhone === phone ? { ...message, read_at: message.read_at || new Date().toISOString() } : message);
    this.rebuildConversations();
    this.render();
  }

  getActiveConversation() {
    return this.conversations.find((conversation) => conversation.phone === this.activePhone) || null;
  }

  handleRealtimeMessage(raw) {
    const message = normalizeMessage(raw, this.getBusinessPhone?.());
    this.messages = mergeMessages(this.messages, [message], this.getBusinessPhone?.());
    this.rebuildConversations();
    if (!this.activePhone) this.activePhone = message.conversationPhone;
    this.render();
  }

  async sendText(text) {
    if (!this.activePhone) return;
    const clientId = crypto.randomUUID();
    const optimistic = this.makeOutgoing({ clientId, text, type: 'text', status: 'sending' });
    this.handleRealtimeMessage(optimistic);
    this.setTyping(true);
    try {
      const response = await WhatsAppAPI.sendText({ to: this.activePhone, text });
      const waId = response.messages?.[0]?.id;
      await MessageStore.saveOutgoing({ ...optimistic, status: 'sent', delivery_status: 'sent', wa_message_id: waId });
      this.handleRealtimeMessage({ ...optimistic, status: 'sent', delivery_status: 'sent', wa_message_id: waId });
    } catch (error) {
      this.handleRealtimeMessage({ ...optimistic, status: 'failed', delivery_status: 'failed' });
      window.Toast?.show?.(error.message || 'تعذر إرسال الرسالة', 'error');
    } finally {
      this.setTyping(false);
    }
  }

  async sendFiles(files, caption = '') {
    for (const file of files) await this.sendFile(file, caption);
  }

  async sendFile(file, caption = '') {
    if (!this.activePhone) return;
    const type = inferMediaType(file);
    const clientId = crypto.randomUUID();
    const objectUrl = URL.createObjectURL(file);
    const optimistic = this.makeOutgoing({
      clientId,
      text: caption,
      type,
      status: 'sending',
      media: { url: objectUrl, name: file.name, mimeType: file.type, size: file.size },
      mime_type: file.type,
      file_name: file.name,
      file_size: file.size,
      media_url: objectUrl,
    });
    this.handleRealtimeMessage(optimistic);
    this.setTyping(true);
    try {
      const upload = await WhatsAppAPI.uploadMedia(file);
      const response = await WhatsAppAPI.sendMedia({ to: this.activePhone, type, mediaId: upload.id, caption, fileName: file.name });
      const waId = response.messages?.[0]?.id;
      await MessageStore.saveOutgoing({ ...optimistic, media_id: upload.id, wa_message_id: waId, status: 'sent', delivery_status: 'sent' });
      this.handleRealtimeMessage({ ...optimistic, media_id: upload.id, wa_message_id: waId, status: 'sent', delivery_status: 'sent' });
    } catch (error) {
      this.handleRealtimeMessage({ ...optimistic, status: 'failed', delivery_status: 'failed' });
      window.Toast?.show?.(error.message || 'تعذر إرسال الملف', 'error');
    } finally {
      this.setTyping(false);
    }
  }

  makeOutgoing({ clientId, text = '', type = 'text', status = 'sending', media = {}, ...rest }) {
    const timestamp = new Date().toISOString();
    return {
      id: clientId,
      client_id: clientId,
      clientId,
      from_number: this.getBusinessPhone?.() || '',
      to_number: this.activePhone,
      conversationPhone: this.activePhone,
      message_text: text,
      text,
      message_type: type,
      type,
      direction: 'outbound',
      status,
      deliveryStatus: status,
      timestamp,
      media,
      metadata: { media_url: media.url, file_name: media.name, mime_type: media.mimeType, file_size: media.size },
      ...rest,
    };
  }

  setTyping(active) {
    const typing = this.root.querySelector('[data-typing]');
    if (typing) typing.hidden = !active;
  }

  setState(message, hidden = false, error = false) {
    const state = this.root.querySelector('[data-state]');
    if (!state) return;
    state.hidden = hidden;
    state.textContent = message;
    state.classList.toggle('error', error);
  }
}
