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

export function MessageBubble(message) {
  const outbound = message.direction === 'outbound';
  const statusKey = message.deliveryStatus || message.status || 'sending';
  const iconName = DELIVERY_ICONS[statusKey] || 'sending';
  const statusClass = message.deliveryStatus === 'read' ? 'read' : '';
  const statusIcon = Icons.render(iconName, `wa-delivery-icon ${statusClass}`);
  
  return `
    <article class="wa-bubble ${outbound ? 'outbound' : 'inbound'}" data-message-id="${escapeHtml(message.id || message.clientId)}">
      ${message.type !== 'text' ? MediaPreview(message) : ''}
      ${message.text ? `<div class="wa-bubble-text">${escapeHtml(message.text)}</div>` : ''}
      <footer class="wa-bubble-meta">
        <span>${formatTime(message.timestamp)}</span>
        ${outbound ? `<span class="wa-delivery ${statusClass}">${statusIcon}</span>` : ''}
      </footer>
    </article>
  `;
}
