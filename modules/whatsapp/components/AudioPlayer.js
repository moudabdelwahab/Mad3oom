import { escapeHtml } from '../utils/dom.js';

export function AudioPlayer({ src = '', title = 'رسالة صوتية' }) {
  if (!src) return '<div class="wa-audio-missing">الصوت غير متاح</div>';
  return `
    <div class="wa-audio-player">
      <span class="wa-audio-wave" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
      <div class="wa-audio-body">
        <strong>${escapeHtml(title)}</strong>
        <audio controls preload="metadata" src="${escapeHtml(src)}" title="${escapeHtml(title)}"></audio>
      </div>
    </div>
  `;
}
