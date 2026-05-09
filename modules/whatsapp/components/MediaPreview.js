import { escapeHtml } from '../utils/dom.js';
import { AudioPlayer } from './AudioPlayer.js';

export function MediaPreview({ type, media = {}, text = '' }) {
  const url = media.url;
  const name = media.name || 'ملف';
  if (type === 'image' || type === 'sticker') {
    return `
      <button class="wa-media-preview wa-image-preview" type="button" data-lightbox-src="${escapeHtml(url || '')}" data-lightbox-alt="${escapeHtml(text || name)}">
        <img src="${escapeHtml(url || '')}" alt="${escapeHtml(text || name)}" loading="lazy" />
      </button>
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
