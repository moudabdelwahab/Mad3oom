import { escapeHtml, formatTime } from '../utils/dom.js';
import { MediaPreview } from './MediaPreview.js';
import Icons from '../icons.js';

const DELIVERY_ICONS = {
  sending: 'sending',
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed'
};

function renderInteractive(message) {
  const iv = message.interactive;
  if (!iv) return message.text ? `<div class="wa-bubble-text">${escapeHtml(message.text)}</div>` : '';

  // Button reply (inbound — user tapped a button)
  if (iv.kind === 'button_reply') {
    return `
      <div class="wa-bubble-text wa-interactive-reply">
        <span class="wa-interactive-reply-icon">↩️</span>
        ${escapeHtml(iv.text || 'رد على زر')}
      </div>
    `;
  }

  // Reaction
  if (iv.kind === 'reaction') {
    return `
      <div class="wa-bubble-text wa-reaction-bubble">
        <span class="wa-reaction-emoji">${escapeHtml(iv.emoji || '👍')}</span>
        <span class="wa-reaction-label">تفاعل على رسالة</span>
      </div>
    `;
  }

  // Location
  if (iv.kind === 'location') {
    const name = iv.name || iv.address || '';
    const lat = iv.latitude || '';
    const lng = iv.longitude || '';
    const mapsUrl = lat && lng ? `https://maps.google.com/?q=${lat},${lng}` : null;
    return `
      <div class="wa-bubble-text wa-location-bubble">
        <span class="wa-location-icon">📍</span>
        <span>${escapeHtml(name || 'موقع')}</span>
        ${mapsUrl ? `<a class="wa-location-link" href="${escapeHtml(mapsUrl)}" target="_blank" rel="noopener">فتح الخريطة</a>` : ''}
      </div>
    `;
  }

  // Contacts
  if (iv.kind === 'contacts') {
    const names = (iv.contacts || []).map(c => c.name?.formatted_name || '').filter(Boolean);
    return `
      <div class="wa-bubble-text wa-contacts-bubble">
        <span>👤</span>
        <span>${escapeHtml(names.join('، ') || 'جهة اتصال')}</span>
      </div>
    `;
  }

  // Template
  if (iv.kind === 'template') {
    const bodyComp = (iv.components || []).find(c => (c.type || '').toLowerCase() === 'body');
    const bodyText = bodyComp?.text || message.text || '';
    return `
      <div class="wa-interactive-card">
        <div class="wa-interactive-tag">📋 قالب</div>
        ${bodyText ? `<div class="wa-bubble-text">${escapeHtml(bodyText)}</div>` : ''}
        <div class="wa-interactive-template-name">${escapeHtml(iv.name || '')}</div>
      </div>
    `;
  }

  // Outbound interactive message (buttons / list)
  const parts = [];
  if (iv.header) {
    if (iv.header.type === 'text') {
      parts.push(`<div class="wa-interactive-header">${escapeHtml(iv.header.text || '')}</div>`);
    } else if (iv.header.type === 'image' && iv.header.image?.link) {
      parts.push(`<img class="wa-interactive-header-img" src="${escapeHtml(iv.header.image.link)}" alt="header" loading="lazy" />`);
    }
  }
  if (iv.body) parts.push(`<div class="wa-bubble-text">${escapeHtml(iv.body)}</div>`);
  if (iv.footer) parts.push(`<div class="wa-interactive-footer">${escapeHtml(iv.footer)}</div>`);

  // Render buttons (button type)
  if (iv.buttons && iv.buttons.length) {
    const btns = iv.buttons.map(btn => {
      const title = btn.reply?.title || btn.title || '';
      return `<div class="wa-interactive-btn">${escapeHtml(title)}</div>`;
    }).join('');
    parts.push(`<div class="wa-interactive-buttons">${btns}</div>`);
  }

  // Render list sections
  if (iv.sections && iv.sections.length) {
    const rows = iv.sections.flatMap(s => s.rows || []);
    const items = rows.slice(0, 3).map(r => `<div class="wa-interactive-btn">${escapeHtml(r.title || '')}</div>`).join('');
    const more = rows.length > 3 ? `<div class="wa-interactive-more">+${rows.length - 3} المزيد</div>` : '';
    parts.push(`<div class="wa-interactive-buttons">${items}${more}</div>`);
  }

  if (!parts.length && message.text) {
    parts.push(`<div class="wa-bubble-text">${escapeHtml(message.text)}</div>`);
  }

  return parts.length
    ? `<div class="wa-interactive-card">${parts.join('')}</div>`
    : `<div class="wa-bubble-text wa-unsupported">💬 رسالة تفاعلية</div>`;
}

export function MessageBubble(message) {
  const outbound = message.direction === 'outbound';
  const statusKey = message.deliveryStatus || message.status || 'sending';
  const iconName = DELIVERY_ICONS[statusKey] || 'sending';
  const statusClass = message.deliveryStatus === 'read' ? 'read' : '';
  const statusIcon = Icons.render(iconName, `wa-delivery-icon ${statusClass}`);

  let content = '';
  if (message.type === 'interactive' || message.interactive) {
    content = renderInteractive(message);
  } else if (message.type !== 'text') {
    content = MediaPreview(message);
    if (message.text) content += `<div class="wa-bubble-text">${escapeHtml(message.text)}</div>`;
  } else {
    content = message.text ? `<div class="wa-bubble-text">${escapeHtml(message.text)}</div>` : '';
  }

  return `
    <article class="wa-bubble ${outbound ? 'outbound' : 'inbound'}" data-message-id="${escapeHtml(message.clientId || message.client_id || message.id)}">
      ${content}
      <footer class="wa-bubble-meta">
        <span>${formatTime(message.timestamp)}</span>
        ${outbound ? `<span class="wa-delivery ${statusClass}">${statusIcon}</span>` : ''}
      </footer>
    </article>
  `;
}
