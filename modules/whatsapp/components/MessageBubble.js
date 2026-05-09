import { escapeHtml, formatTime } from '../utils/dom.js';
import { MediaPreview } from './MediaPreview.js';

const DELIVERY = { sending: '⏳', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '⚠️' };

export function MessageBubble(message) {
  const outbound = message.direction === 'outbound';
  const status = DELIVERY[message.deliveryStatus] || DELIVERY[message.status] || '';
  const statusClass = message.deliveryStatus === 'read' ? 'read' : '';
  return `
    <article class="wa-bubble ${outbound ? 'outbound' : 'inbound'}" data-message-id="${escapeHtml(message.id || message.clientId)}">
      ${message.type !== 'text' ? MediaPreview(message) : ''}
      ${message.text ? `<div class="wa-bubble-text">${escapeHtml(message.text)}</div>` : ''}
      <footer class="wa-bubble-meta">
        <span>${formatTime(message.timestamp)}</span>
        ${outbound ? `<span class="wa-delivery ${statusClass}">${status}</span>` : ''}
      </footer>
    </article>
  `;
}
