import { escapeHtml } from '../utils/dom.js';
import { AudioPlayer } from './AudioPlayer.js';

export function MediaPreview({ type, media = {}, text = '' }) {
  const url = media.url;
  const name = media.name || 'ملف';
  if (type === 'image' || type === 'sticker') {
    return `
      <a class="wa-media-preview wa-image-preview" href="${escapeHtml(url || '#')}" target="_blank" rel="noopener">
        <img src="${escapeHtml(url || '')}" alt="${escapeHtml(text || name)}" loading="lazy" />
      </a>
    `;
  }
  if (type === 'video') {
    return `
      <div class="wa-media-preview wa-video-preview">
        <video controls preload="metadata" src="${escapeHtml(url || '')}"></video>
      </div>
    `;
  }
  if (type === 'audio') return AudioPlayer({ src: url, title: name });
  return `
    <a class="wa-document-preview" href="${escapeHtml(url || '#')}" target="_blank" rel="noopener" download>
      <span class="wa-doc-icon">📎</span>
      <span class="wa-doc-name">${escapeHtml(name)}</span>
      <span class="wa-doc-download">تحميل</span>
    </a>
  `;
}
