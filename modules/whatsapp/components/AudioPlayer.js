import { escapeHtml } from '../utils/dom.js';

export function AudioPlayer({ src = '', title = 'رسالة صوتية' }) {
  if (!src) return '<div class="wa-audio-missing">الصوت غير متاح</div>';
  return `
    <div class="wa-audio-player">
      <span class="wa-audio-icon">🎙️</span>
      <audio controls preload="metadata" src="${escapeHtml(src)}" title="${escapeHtml(title)}"></audio>
    </div>
  `;
}
