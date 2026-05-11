import { escapeHtml } from '../utils/dom.js';
import Icons from '../icons.js';

const EMOJIS = ['😀','😂','😍','🙏','👍','🔥','🎉','❤️','✅','📌','🚀','💬','🤝','👏','😎','😭','🙌','💡'];

function recordingMimeType() {
  const preferred = 'audio/ogg;codecs=opus';
  if (window.MediaRecorder?.isTypeSupported?.(preferred)) return preferred;
  const fallback = 'audio/webm;codecs=opus';
  if (window.MediaRecorder?.isTypeSupported?.(fallback)) return fallback;
  return '';
}

function recordingExtension(type) {
  return type.includes('ogg') ? 'ogg' : 'webm';
}

function filePreview(file) {
  const url = URL.createObjectURL(file);
  if (file.type.startsWith('image/')) return `<img src="${url}" alt="${escapeHtml(file.name)}" />`;
  if (file.type.startsWith('video/')) return `<video src="${url}" muted></video>`;
  if (file.type.startsWith('audio/')) return `<audio src="${url}" controls preload="metadata"></audio>`;
  return '<span class="wa-file-preview-icon">📄</span>';
}

export class MessageInput {
  constructor(root, { onSendText, onSendFiles } = {}) {
    this.root = root;
    this.onSendText = onSendText;
    this.onSendFiles = onSendFiles;
    this.files = [];
    this.recorder = null;
    this.chunks = [];
    this.stream = null;
    this.handleOutsideClick = (event) => {
      if (!this.root.contains(event.target)) this.closeEmojiPicker();
    };
  }

  render({ disabled = false } = {}) {
    document.removeEventListener('click', this.handleOutsideClick);
    const emojiIcon = Icons.render('emoji', 'wa-composer-icon');
    const attachIcon = Icons.render('attach', 'wa-composer-icon');
    const micIcon = Icons.render('microphone', 'wa-composer-icon');
    const sendIcon = Icons.render('send', 'wa-composer-icon');
    
    this.root.innerHTML = `
      <div class="wa-composer-previews" data-previews hidden></div>
      <div class="wa-emoji-panel" data-emojis hidden role="dialog" aria-label="Emoji picker">
        ${EMOJIS.map((emoji) => `<button type="button" aria-label="${emoji}">${emoji}</button>`).join('')}
      </div>
      <form class="wa-composer-form">
        <button type="button" class="wa-composer-btn" data-emoji ${disabled ? 'disabled' : ''} aria-label="إيموجي" title="إيموجي">${emojiIcon}</button>
        <label class="wa-composer-btn ${disabled ? 'disabled' : ''}" title="إرفاق ملفات">
          ${attachIcon}<input type="file" data-file multiple accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt" hidden ${disabled ? 'disabled' : ''} />
        </label>
        <textarea data-text rows="1" placeholder="اكتب رسالة" ${disabled ? 'disabled' : ''}></textarea>
        <button type="button" class="wa-composer-btn" data-voice ${disabled ? 'disabled' : ''} aria-label="تسجيل صوت" title="تسجيل صوت">${micIcon}</button>
        <button type="submit" class="wa-send-btn" ${disabled ? 'disabled' : ''} title="إرسال الرسالة">${sendIcon}<span>إرسال</span></button>
      </form>
    `;
    this.bind();
    this.renderPreviews();
  }

  bind() {
    const form = this.root.querySelector('form');
    const textarea = this.root.querySelector('[data-text]');
    const fileInput = this.root.querySelector('[data-file]');
    const emojiPanel = this.root.querySelector('[data-emojis]');
    const emojiButton = this.root.querySelector('[data-emoji]');
    const voiceButton = this.root.querySelector('[data-voice]');

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = textarea.value.trim();
      const files = [...this.files];
      if (!text && !files.length) return;
      textarea.value = '';
      textarea.style.height = 'auto';
      this.files = [];
      this.renderPreviews();
      this.closeEmojiPicker();
      if (files.length) await this.onSendFiles?.(files, text);
      else await this.onSendText?.(text);
    });

    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 130)}px`;
    });

    fileInput.addEventListener('change', () => {
      this.files = [...this.files, ...fileInput.files];
      fileInput.value = '';
      this.renderPreviews();
    });

    emojiButton.addEventListener('click', (event) => {
      event.stopPropagation();
      emojiPanel.hidden = !emojiPanel.hidden;
      window.setTimeout(() => document.addEventListener('click', this.handleOutsideClick), 0);
    });

    emojiPanel.addEventListener('click', (event) => event.stopPropagation());
    emojiPanel.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', () => {
        textarea.setRangeText(button.textContent, textarea.selectionStart, textarea.selectionEnd, 'end');
        textarea.focus();
      });
    });

    voiceButton.addEventListener('click', () => this.toggleRecording(voiceButton));
  }

  closeEmojiPicker() {
    const emojiPanel = this.root.querySelector('[data-emojis]');
    if (emojiPanel) emojiPanel.hidden = true;
    document.removeEventListener('click', this.handleOutsideClick);
  }

  renderPreviews() {
    const previews = this.root.querySelector('[data-previews]');
    if (!previews) return;
    previews.hidden = !this.files.length;
    previews.innerHTML = this.files.map((file, index) => `
      <article class="wa-attachment-preview ${file.type.startsWith('audio/') ? 'audio' : ''}">
        <div class="wa-attachment-thumb">${filePreview(file)}</div>
        <div class="wa-attachment-meta">
          <strong>${escapeHtml(file.name)}</strong>
          <small>${Math.max(1, Math.round(file.size / 1024))} KB</small>
        </div>
        <button type="button" data-remove="${index}" aria-label="حذف الملف">×</button>
      </article>
    `).join('');
    previews.querySelectorAll('[data-remove]').forEach((button) => {
      button.addEventListener('click', () => {
        this.files.splice(Number(button.dataset.remove), 1);
        this.renderPreviews();
      });
    });
  }

  async toggleRecording(button) {
    if (this.recorder?.state === 'recording') {
      this.recorder.stop();
      button.classList.remove('recording');
      button.innerHTML = Icons.render('microphone', 'wa-composer-icon');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      window.Toast?.show?.('المتصفح لا يدعم تسجيل الصوت', 'error');
      return;
    }
    const mimeType = recordingMimeType();
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.recorder.ondataavailable = (event) => event.data.size && this.chunks.push(event.data);
    this.recorder.onstop = () => {
      this.stream?.getTracks().forEach((track) => track.stop());
      const type = this.recorder.mimeType || mimeType || 'audio/webm';
      const blob = new Blob(this.chunks, { type });
      const extension = recordingExtension(type);
      const file = new File([blob], `voice-note-${Date.now()}.${extension}`, { type });
      this.files = [...this.files, file];
      this.renderPreviews();
      window.Toast?.show?.('تم تجهيز التسجيل، راجعه ثم اضغط إرسال', 'success');
    };
    this.recorder.start();
    button.classList.add('recording');
    button.innerHTML = Icons.render('microphone', 'wa-composer-icon');
    window.Toast?.show?.('جاري التسجيل... اضغط إيقاف للمعاينة قبل الإرسال', 'info');
  }

  destroy() {
    this.closeEmojiPicker();
    if (this.recorder?.state === 'recording') this.recorder.stop();
    this.stream?.getTracks().forEach((track) => track.stop());
  }
}
