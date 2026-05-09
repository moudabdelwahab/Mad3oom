import { escapeHtml } from '../utils/dom.js';

const EMOJIS = ['😀','😂','😍','🙏','👍','🔥','🎉','❤️','✅','📌','🚀','💬'];

export class MessageInput {
  constructor(root, { onSendText, onSendFiles } = {}) {
    this.root = root;
    this.onSendText = onSendText;
    this.onSendFiles = onSendFiles;
    this.files = [];
    this.recorder = null;
    this.chunks = [];
  }

  render({ disabled = false } = {}) {
    this.root.innerHTML = `
      <div class="wa-composer-previews" data-previews hidden></div>
      <div class="wa-emoji-panel" data-emojis hidden>${EMOJIS.map((emoji) => `<button type="button">${emoji}</button>`).join('')}</div>
      <form class="wa-composer-form">
        <button type="button" class="wa-composer-btn" data-emoji ${disabled ? 'disabled' : ''}>😊</button>
        <label class="wa-composer-btn ${disabled ? 'disabled' : ''}" title="إرفاق ملفات">
          📎<input type="file" data-file multiple accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt" hidden ${disabled ? 'disabled' : ''} />
        </label>
        <textarea data-text rows="1" placeholder="اكتب رسالة" ${disabled ? 'disabled' : ''}></textarea>
        <button type="button" class="wa-composer-btn" data-voice ${disabled ? 'disabled' : ''}>🎙️</button>
        <button type="submit" class="wa-send-btn" ${disabled ? 'disabled' : ''}>إرسال</button>
      </form>
    `;
    this.bind();
  }

  bind() {
    const form = this.root.querySelector('form');
    const textarea = this.root.querySelector('[data-text]');
    const fileInput = this.root.querySelector('[data-file]');
    const emojiPanel = this.root.querySelector('[data-emojis]');

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = textarea.value.trim();
      const files = [...this.files];
      textarea.value = '';
      this.files = [];
      this.renderPreviews();
      if (files.length) await this.onSendFiles?.(files, text);
      else if (text) await this.onSendText?.(text);
    });

    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 130)}px`;
    });

    fileInput.addEventListener('change', () => {
      this.files = [...fileInput.files];
      this.renderPreviews();
    });

    this.root.querySelector('[data-emoji]').addEventListener('click', () => {
      emojiPanel.hidden = !emojiPanel.hidden;
    });

    emojiPanel.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', () => {
        textarea.value += button.textContent;
        textarea.focus();
      });
    });

    this.root.querySelector('[data-voice]').addEventListener('click', () => this.toggleRecording());
  }

  renderPreviews() {
    const previews = this.root.querySelector('[data-previews]');
    if (!previews) return;
    previews.hidden = !this.files.length;
    previews.innerHTML = this.files.map((file, index) => `<span>${escapeHtml(file.name)} <button type="button" data-remove="${index}">×</button></span>`).join('');
    previews.querySelectorAll('[data-remove]').forEach((button) => {
      button.addEventListener('click', () => {
        this.files.splice(Number(button.dataset.remove), 1);
        this.renderPreviews();
      });
    });
  }

  async toggleRecording() {
    if (this.recorder?.state === 'recording') {
      this.recorder.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      window.Toast?.show?.('المتصفح لا يدعم تسجيل الصوت', 'error');
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    this.recorder = new MediaRecorder(stream);
    this.recorder.ondataavailable = (event) => event.data.size && this.chunks.push(event.data);
    this.recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(this.chunks, { type: 'audio/webm' });
      const file = new File([blob], `voice-note-${Date.now()}.webm`, { type: 'audio/webm' });
      await this.onSendFiles?.([file], '');
    };
    this.recorder.start();
    window.Toast?.show?.('بدأ تسجيل الرسالة الصوتية، اضغط مرة أخرى للإرسال', 'info');
  }
}
