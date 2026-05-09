export function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ar-SA', { hour: '2-digit', minute: '2-digit' }).format(date);
}

export function formatConversationTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const today = new Date();
  const isToday = date.toDateString() === today.toDateString();
  if (isToday) return formatTime(date);
  return new Intl.DateTimeFormat('ar-SA', { month: 'short', day: 'numeric' }).format(date);
}

export function phoneInitial(phone = '') {
  const clean = String(phone).replace(/\D/g, '');
  return clean.slice(-2) || 'WA';
}

export function createEl(tag, className, html = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (html) element.innerHTML = html;
  return element;
}

export function debounce(fn, wait = 250) {
  let timer;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
}
